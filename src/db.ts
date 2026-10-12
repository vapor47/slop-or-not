import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './types.ts';
import type { Game, Question, Play, PromptTemplate, Step, ImageMetrics } from './types.ts';
import { DEFAULT_TEMPLATES } from './prompts.ts';
export const WEEK = 7 * 86400000;
export const token = () => randomBytes(24).toString('base64url');
type Value = string | number | null;
export type QuestionAnalytics = Partial<
  Record<
    | 'created_at'
    | 'uploaded_at'
    | 'described_at'
    | 'ready_at'
    | 'failed_at'
    | 'removed_at'
    | 'describe_template_id'
    | 'generate_template_id'
    | 'describe_run_id'
    | 'generate_run_id'
    | 'dhash_distance',
    number | null
  >
>;
export type RunStart = {
  step: Step;
  provider: string;
  model: string;
  template: number;
  prompt: string;
  params: Record<string, unknown>;
  reservedUnits: number;
  appVersion: string;
};
export type RunFinish = {
  finished: number | null;
  status: 'succeeded' | 'failed';
  errorKind?: 'temporary' | 'permanent' | null;
  error?: string | null;
  modelVersion?: string | null;
  usage?: Record<string, unknown> | null;
  output?: string | null;
};
export class Repository {
  db: DatabaseSync;
  dailyBudget: number;
  now: () => number;
  descriptorUnits: number;
  generatorUnits: number;
  constructor(
    path: string,
    dailyBudget = 9000,
    now = Date.now,
    units = { descriptor: 200, generator: 60 },
  ) {
    this.db = new DatabaseSync(path);
    this.dailyBudget = dailyBudget;
    this.now = now;
    this.descriptorUnits = units.descriptor;
    this.generatorUnits = units.generator;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, game TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plays(id TEXT PRIMARY KEY, game TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS questions_game ON questions(game);
      CREATE INDEX IF NOT EXISTS plays_game ON plays(game);
      CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, reserved INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS garbage(key TEXT PRIMARY KEY, delete_after INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_limits(ip TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
    // Analytics tables are append-only and are never touched by expiry; see README "Analytics and retention".
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates(id INTEGER PRIMARY KEY AUTOINCREMENT,
        step TEXT NOT NULL CHECK(step IN ('describe','generate')), name TEXT NOT NULL, version INTEGER NOT NULL,
        text TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(step, name, version));
      CREATE TRIGGER IF NOT EXISTS prompt_templates_immutable BEFORE UPDATE OF step, name, version, text ON prompt_templates
        BEGIN SELECT RAISE(ABORT, 'Prompt templates are immutable; add a new version.'); END;
      CREATE TRIGGER IF NOT EXISTS prompt_templates_kept BEFORE DELETE ON prompt_templates
        BEGIN SELECT RAISE(ABORT, 'Prompt templates are kept for attribution; deactivate instead.'); END;
      CREATE TABLE IF NOT EXISTS generation_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id TEXT NOT NULL, game_id TEXT NOT NULL, step TEXT NOT NULL, provider TEXT NOT NULL,
        model_id TEXT NOT NULL, model_version TEXT, prompt_template_id INTEGER REFERENCES prompt_templates(id),
        prompt_text TEXT NOT NULL, params_json TEXT NOT NULL, output_text TEXT, usage_json TEXT,
        started_at INTEGER NOT NULL, finished_at INTEGER, latency_ms INTEGER, attempt INTEGER NOT NULL,
        retry_cycle INTEGER NOT NULL, status TEXT NOT NULL, error_kind TEXT, error TEXT,
        reserved_units INTEGER NOT NULL, app_version TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS generation_runs_question ON generation_runs(question_id);
      CREATE TABLE IF NOT EXISTS question_analytics(question_id TEXT PRIMARY KEY, game_id TEXT NOT NULL,
        created_at INTEGER, uploaded_at INTEGER, described_at INTEGER, ready_at INTEGER, failed_at INTEGER,
        removed_at INTEGER, describe_template_id INTEGER REFERENCES prompt_templates(id),
        generate_template_id INTEGER REFERENCES prompt_templates(id), describe_run_id INTEGER,
        generate_run_id INTEGER, dhash_distance INTEGER);
      CREATE INDEX IF NOT EXISTS question_analytics_game ON question_analytics(game_id);
      CREATE TABLE IF NOT EXISTS image_metrics(question_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('original','generated')), run_id INTEGER, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, width INTEGER, height INTEGER, dhash TEXT, brightness REAL, contrast REAL,
        sharpness REAL, colorfulness REAL, measured_at INTEGER NOT NULL, PRIMARY KEY(question_id, role));`);
    this.transaction(() => {
      for (const step of ['describe', 'generate'] as const) {
        const latest = this.db
          .prepare(
            'SELECT text FROM prompt_templates WHERE step=? AND name=? ORDER BY version DESC LIMIT 1',
          )
          .get(step, DEFAULT_TEMPLATES[step].name);
        if (latest?.text !== DEFAULT_TEMPLATES[step].text)
          this.addTemplate(step, DEFAULT_TEMPLATES[step].name, DEFAULT_TEMPLATES[step].text);
      }
    });
  }
  // Editing a prompt adds a new active version and deactivates older versions of the same name.
  addTemplate(step: Step, name: string, text: string): PromptTemplate {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM prompt_templates WHERE step=? AND name=?')
      .get(step, name);
    this.db.prepare('UPDATE prompt_templates SET active=0 WHERE step=? AND name=?').run(step, name);
    const id = this.db
      .prepare(
        'INSERT INTO prompt_templates(step,name,version,text,created_at,active) VALUES(?,?,?,?,?,1)',
      )
      .run(step, name, Number(row?.version ?? 0) + 1, text, this.now()).lastInsertRowid;
    return this.template(Number(id));
  }
  template(id: number): PromptTemplate {
    const row = this.db.prepare('SELECT * FROM prompt_templates WHERE id=?').get(id);
    if (!row) throw new Error(`Prompt template ${id} not found.`);
    return { ...row } as PromptTemplate;
  }
  // Newest active template for new questions; falls back to the newest version if none is active.
  activeTemplate(step: Step): PromptTemplate {
    const row = this.db
      .prepare('SELECT * FROM prompt_templates WHERE step=? ORDER BY active DESC, id DESC LIMIT 1')
      .get(step);
    return { ...row } as PromptTemplate;
  }
  track(q: Question, fields: QuestionAnalytics) {
    this.db
      .prepare('INSERT OR IGNORE INTO question_analytics(question_id, game_id) VALUES(?,?)')
      .run(q.id, q.game);
    const keys = Object.keys(fields) as (keyof QuestionAnalytics)[];
    if (keys.length)
      this.db
        .prepare(
          `UPDATE question_analytics SET ${keys.map((k) => `${k}=?`).join(',')} WHERE question_id=?`,
        )
        .run(...keys.map((k) => fields[k] ?? null), q.id);
  }
  startRun(q: Question, run: RunStart) {
    return Number(
      this.db
        .prepare(
          `INSERT INTO generation_runs(question_id,game_id,step,provider,model_id,prompt_template_id,prompt_text,
          params_json,started_at,attempt,retry_cycle,status,reserved_units,app_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`,
        )
        .run(
          q.id,
          q.game,
          run.step,
          run.provider,
          run.model,
          run.template,
          run.prompt,
          JSON.stringify(run.params),
          this.now(),
          q.attempts,
          q.manualRetries,
          run.reservedUnits,
          run.appVersion,
        ).lastInsertRowid,
    );
  }
  finishRun(id: number, run: RunFinish) {
    this.db
      .prepare(
        `UPDATE generation_runs SET finished_at=?, latency_ms=?-started_at, status=?, error_kind=?, error=?,
        model_version=?, usage_json=?, output_text=? WHERE id=?`,
      )
      .run(
        run.finished,
        run.finished,
        run.status,
        run.errorKind ?? null,
        run.error ?? null,
        run.modelVersion ?? null,
        run.usage ? JSON.stringify(run.usage) : null,
        run.output ?? null,
        id,
      );
  }
  interruptRuns(questionId: string) {
    this.db
      .prepare(
        `UPDATE generation_runs SET status='failed', error_kind='temporary', error='interrupted',
        finished_at=? WHERE question_id=? AND status='running'`,
      )
      .run(this.now(), questionId);
  }
  saveMetrics(
    q: Question,
    role: 'original' | 'generated',
    run: number | null,
    hash: { sha256: string; bytes: number },
    metrics: ImageMetrics | null,
  ) {
    const keys = [
      'width',
      'height',
      'dhash',
      'brightness',
      'contrast',
      'sharpness',
      'colorfulness',
    ] as const;
    const values: Value[] = [
      q.id,
      role,
      run,
      hash.sha256,
      hash.bytes,
      ...keys.map((k) => metrics?.[k] ?? null),
      this.now(),
    ];
    this.db
      .prepare(
        `INSERT OR REPLACE INTO image_metrics(question_id,role,run_id,sha256,bytes,${keys.join(',')},measured_at)
        VALUES(${values.map(() => '?').join(',')})`,
      )
      .run(...values);
  }
  metrics(id: string, role: 'original' | 'generated') {
    return this.db
      .prepare('SELECT * FROM image_metrics WHERE question_id=? AND role=?')
      .get(id, role);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  save(table: 'games' | 'questions' | 'plays', item: Game | Question | Play) {
    if (table === 'games')
      this.db
        .prepare('INSERT OR REPLACE INTO games VALUES(?,?)')
        .run(item.id, JSON.stringify(item));
    else
      this.db
        .prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?)`)
        .run(item.id, (item as Question | Play).game, JSON.stringify(item));
  }
  get<T>(table: 'games' | 'questions' | 'plays', id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  list<T>(table: 'games' | 'questions' | 'plays', game?: string): T[] {
    const rows = game
      ? this.db.prepare(`SELECT data FROM ${table} WHERE game=?`).all(game)
      : this.db.prepare(`SELECT data FROM ${table}`).all();
    return rows.map((row) => JSON.parse(row.data as string));
  }
  day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
  reserve(units: number) {
    const day = this.day();
    this.db.prepare('INSERT OR IGNORE INTO budget VALUES(?,0)').run(day);
    const result = this.db
      .prepare('UPDATE budget SET reserved=reserved+? WHERE day=? AND reserved+?<=?')
      .run(units, day, units, this.dailyBudget);
    if (!result.changes)
      throw new HttpError(429, 'Generation budget exhausted. Try again after midnight UTC.');
    return day;
  }
  budget() {
    const row = this.db.prepare('SELECT reserved FROM budget WHERE day=?').get(this.day());
    return { limit: this.dailyBudget, reserved: Number(row?.reserved || 0), resets: '00:00 UTC' };
  }
  garbage(key: string) {
    this.db.prepare('INSERT OR REPLACE INTO garbage VALUES(?,?)').run(key, this.now() + 10 * 60000);
  }
  cancelUpload(id: string) {
    this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q || q.state !== 'uploading') return;
      this.db
        .prepare('UPDATE budget SET reserved=MAX(0,reserved-?) WHERE day=?')
        .run(this.cost(q), q.reservationDay);
      this.garbage(q.original);
      this.garbage(q.generated);
      this.db.prepare('DELETE FROM questions WHERE id=?').run(id);
      // The upload never completed and no provider was called, so it is not an analysable question.
      this.db.prepare('DELETE FROM question_analytics WHERE question_id=?').run(id);
    });
  }
  cost(q: Question, generationOnly = false) {
    return 4 * ((generationOnly ? 0 : (q.descriptorUnits ?? 200)) + (q.generatorUnits ?? 60));
  }
  game(id: string, draft = false) {
    const game = this.get<Game>('games', id);
    if (!game) throw new HttpError(404, 'This game is unavailable.');
    if (game.deleted || this.now() >= (game.published ?? game.created) + WEEK)
      throw new HttpError(410, 'This game has expired.');
    if (draft && game.published !== null)
      throw new HttpError(409, 'Published games cannot be edited.');
    return game;
  }
  invite(invite: string) {
    const game = this.list<Game>('games').find((g) => g.invite === invite);
    if (!game) throw new HttpError(404, 'This game is unavailable.');
    return this.game(game.id);
  }
  create(title: string) {
    const game: Game = {
      id: token(),
      title: title.trim().slice(0, 80) || 'Slop or Not',
      created: this.now(),
      published: null,
      invite: null,
      deleted: false,
    };
    this.save('games', game);
    return game;
  }
  acceptUpload(gameId: string) {
    return this.transaction(() => {
      this.game(gameId, true);
      if (this.list<Question>('questions', gameId).length >= 10)
        throw new HttpError(400, 'A game can contain up to 10 questions.');
      // Reserve four attempts at both steps: 200 description + 60 generation neurons per attempt.
      const reservationDay = this.reserve(4 * (this.descriptorUnits + this.generatorUnits)),
        id = token();
      const q: Question = {
        id,
        game: gameId,
        original: token(),
        generated: token(),
        state: 'uploading',
        description: null,
        error: null,
        attempts: 0,
        manualRetries: 0,
        due: this.now(),
        lease: 0,
        reservationDay,
        descriptorUnits: this.descriptorUnits,
        generatorUnits: this.generatorUnits,
        created: this.now(),
        // Snapshot prompt versions like model ids so later prompt edits do not affect this question.
        descriptorTemplate: this.activeTemplate('describe').id,
        generatorTemplate: this.activeTemplate('generate').id,
      };
      this.save('questions', q);
      this.track(q, {
        created_at: q.created,
        describe_template_id: q.descriptorTemplate,
        generate_template_id: q.generatorTemplate,
      });
      return q;
    });
  }
  retry(id: string) {
    return this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q) throw new HttpError(404, 'Question not found.');
      this.game(q.game, true);
      if (q.state !== 'failed') throw new HttpError(409, 'Only failed questions can be retried.');
      if (q.manualRetries >= 2)
        throw new HttpError(400, 'Retry limit reached. Remove this question and upload again.');
      q.reservationDay = this.reserve(this.cost(q, Boolean(q.description)));
      q.state = q.description ? 'generate' : 'describe';
      q.attempts = 0;
      q.manualRetries++;
      q.error = null;
      q.due = this.now();
      q.lease = 0;
      this.save('questions', q);
      return q;
    });
  }
  remove(id: string) {
    this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q) throw new HttpError(404, 'Question not found.');
      this.game(q.game, true);
      for (const key of [q.original, q.generated]) this.garbage(key);
      this.db.prepare('DELETE FROM questions WHERE id=?').run(id);
      this.track(q, { removed_at: this.now() });
    });
  }
  publish(id: string) {
    return this.transaction(() => {
      const game = this.game(id);
      if (game.published !== null) return game;
      const questions = this.list<Question>('questions', id);
      if (!questions.length || questions.some((q) => q.state !== 'ready'))
        throw new HttpError(409, 'Every included question must be ready before publishing.');
      game.published = this.now();
      game.invite = token();
      this.save('games', game);
      return game;
    });
  }
  start(invite: string) {
    return this.transaction(() => {
      const game = this.invite(invite);
      const play: Play = {
        id: token(),
        game: game.id,
        current: 0,
        created: this.now(),
        questions: this.list<Question>('questions', game.id).map((q) => ({
          id: q.id,
          ai: randomInt(2),
          chosen: null,
        })),
      };
      this.save('plays', play);
      return this.view(play);
    });
  }
  play(id: string) {
    const play = this.get<Play>('plays', id);
    if (!play) throw new HttpError(404, 'Playthrough unavailable.');
    this.game(play.game);
    return play;
  }
  view(play: Play) {
    const game = this.game(play.game),
      q = play.questions[play.current];
    return {
      id: play.id,
      title: game.title,
      invite: game.invite,
      current: play.current,
      total: play.questions.length,
      score: play.questions.filter((q) => q.chosen !== null && q.chosen === q.ai).length,
      question: q
        ? {
            id: q.id,
            images: [0, 1].map((side) => `/api/plays/${play.id}/images/${play.current}/${side}`),
            chosen: q.chosen,
            correct: q.chosen === null ? null : q.chosen === q.ai,
          }
        : null,
    };
  }
  answer(id: string, questionId: string, side: number) {
    return this.transaction(() => {
      const play = this.play(id),
        q = play.questions[play.current];
      if (!q || q.id !== questionId || ![0, 1].includes(side))
        throw new HttpError(409, 'This question is no longer current.');
      if (q.chosen === null) {
        q.chosen = side;
        this.save('plays', play);
      }
      return this.view(play);
    });
  }
  next(id: string, questionId: string) {
    return this.transaction(() => {
      const play = this.play(id),
        q = play.questions[play.current];
      if (q?.id === questionId && q.chosen !== null) {
        play.current++;
        this.save('plays', play);
      }
      return this.view(play);
    });
  }
  // Live game state and images are removed; prompt_templates, generation_runs, question_analytics
  // and image_metrics are deliberately retained.
  expire() {
    this.transaction(() => {
      for (const game of this.list<Game>('games')) {
        if (!game.deleted && this.now() >= (game.published ?? game.created) + WEEK) {
          for (const q of this.list<Question>('questions', game.id))
            for (const key of [q.original, q.generated]) this.garbage(key);
          this.db.prepare('DELETE FROM questions WHERE game=?').run(game.id);
          this.db.prepare('DELETE FROM plays WHERE game=?').run(game.id);
          game.deleted = true;
          this.save('games', game);
        }
      }
      this.db.prepare('DELETE FROM sessions WHERE expires<?').run(this.now());
      this.db.prepare('DELETE FROM login_limits WHERE expires<?').run(this.now());
    });
  }
}
