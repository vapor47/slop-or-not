import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './types.ts';
import type { Game, Question, Play } from './types.ts';
export const WEEK = 7 * 86400000;
export const token = () => randomBytes(24).toString('base64url');
export class Repository {
  db: DatabaseSync; dailyBudget: number; now: () => number; descriptorUnits: number; generatorUnits: number;
  constructor(path: string, dailyBudget = 9000, now = Date.now, units = { descriptor: 200, generator: 60 }) {
    this.db = new DatabaseSync(path); this.dailyBudget = dailyBudget; this.now = now;
    this.descriptorUnits = units.descriptor; this.generatorUnits = units.generator;
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
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  save(table: 'games' | 'questions' | 'plays', item: Game | Question | Play) {
    if (table === 'games') this.db.prepare('INSERT OR REPLACE INTO games VALUES(?,?)').run(item.id, JSON.stringify(item));
    else this.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?)`).run(item.id, (item as Question | Play).game, JSON.stringify(item));
  }
  get<T>(table: 'games' | 'questions' | 'plays', id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  list<T>(table: 'games' | 'questions' | 'plays', game?: string): T[] {
    const rows = game ? this.db.prepare(`SELECT data FROM ${table} WHERE game=?`).all(game) : this.db.prepare(`SELECT data FROM ${table}`).all();
    return rows.map(row => JSON.parse(row.data as string));
  }
  day() { return new Date(this.now()).toISOString().slice(0, 10); }
  reserve(units: number) {
    const day = this.day(); this.db.prepare('INSERT OR IGNORE INTO budget VALUES(?,0)').run(day);
    const result = this.db.prepare('UPDATE budget SET reserved=reserved+? WHERE day=? AND reserved+?<=?').run(units, day, units, this.dailyBudget);
    if (!result.changes) throw new HttpError(429, 'Generation budget exhausted. Try again after midnight UTC.');
    return day;
  }
  budget() { const row = this.db.prepare('SELECT reserved FROM budget WHERE day=?').get(this.day()); return { limit: this.dailyBudget, reserved: Number(row?.reserved || 0), resets: '00:00 UTC' }; }
  garbage(key: string) { this.db.prepare('INSERT OR REPLACE INTO garbage VALUES(?,?)').run(key, this.now() + 10 * 60000); }
  cancelUpload(id: string) {
    this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q || q.state !== 'uploading') return;
      this.db.prepare('UPDATE budget SET reserved=MAX(0,reserved-?) WHERE day=?').run(this.cost(q), q.reservationDay);
      this.garbage(q.original); this.garbage(q.generated);
      this.db.prepare('DELETE FROM questions WHERE id=?').run(id);
    });
  }
  cost(q: Question, generationOnly = false) { return 4 * ((generationOnly ? 0 : q.descriptorUnits ?? 200) + (q.generatorUnits ?? 60)); }
  game(id: string, draft = false) {
    const game = this.get<Game>('games', id);
    if (!game) throw new HttpError(404, 'This game is unavailable.');
    if (game.deleted || this.now() >= (game.published ?? game.created) + WEEK) throw new HttpError(410, 'This game has expired.');
    if (draft && game.published !== null) throw new HttpError(409, 'Published games cannot be edited.');
    return game;
  }
  invite(invite: string) {
    const game = this.list<Game>('games').find(g => g.invite === invite);
    if (!game) throw new HttpError(404, 'This game is unavailable.'); return this.game(game.id);
  }
  create(title: string) {
    const game: Game = { id: token(), title: title.trim().slice(0, 80) || 'Slop or Not', created: this.now(), published: null, invite: null, deleted: false };
    this.save('games', game); return game;
  }
  acceptUpload(gameId: string) {
    return this.transaction(() => {
      this.game(gameId, true);
      if (this.list<Question>('questions', gameId).length >= 10) throw new HttpError(400, 'A game can contain up to 10 questions.');
      // Reserve four attempts at both steps: 200 description + 60 generation neurons per attempt.
      const reservationDay = this.reserve(4 * (this.descriptorUnits + this.generatorUnits)), id = token();
      const q: Question = { id, game: gameId, original: token(), generated: token(), state: 'uploading', description: null, error: null, attempts: 0, manualRetries: 0, due: this.now(), lease: 0, reservationDay, descriptorUnits: this.descriptorUnits, generatorUnits: this.generatorUnits };
      this.save('questions', q); return q;
    });
  }
  retry(id: string) {
    return this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q) throw new HttpError(404, 'Question not found.'); this.game(q.game, true);
      if (q.state !== 'failed') throw new HttpError(409, 'Only failed questions can be retried.');
      if (q.manualRetries >= 2) throw new HttpError(400, 'Retry limit reached. Remove this question and upload again.');
      q.reservationDay = this.reserve(this.cost(q, Boolean(q.description)));
      q.state = q.description ? 'generate' : 'describe'; q.attempts = 0; q.manualRetries++; q.error = null; q.due = this.now(); q.lease = 0;
      this.save('questions', q); return q;
    });
  }
  remove(id: string) {
    this.transaction(() => {
      const q = this.get<Question>('questions', id);
      if (!q) throw new HttpError(404, 'Question not found.'); this.game(q.game, true);
      for (const key of [q.original, q.generated]) this.garbage(key);
      this.db.prepare('DELETE FROM questions WHERE id=?').run(id);
    });
  }
  publish(id: string) {
    return this.transaction(() => {
      const game = this.game(id); if (game.published !== null) return game;
      const questions = this.list<Question>('questions', id);
      if (!questions.length || questions.some(q => q.state !== 'ready')) throw new HttpError(409, 'Every included question must be ready before publishing.');
      game.published = this.now(); game.invite = token(); this.save('games', game); return game;
    });
  }
  start(invite: string) {
    return this.transaction(() => {
      const game = this.invite(invite);
      const play: Play = { id: token(), game: game.id, current: 0, created: this.now(), questions: this.list<Question>('questions', game.id).map(q => ({ id: q.id, ai: randomInt(2), chosen: null })), };
      this.save('plays', play); return this.view(play);
    });
  }
  play(id: string) { const play = this.get<Play>('plays', id); if (!play) throw new HttpError(404, 'Playthrough unavailable.'); this.game(play.game); return play; }
  view(play: Play) {
    const game = this.game(play.game), q = play.questions[play.current];
    return { id: play.id, title: game.title, invite: game.invite, current: play.current, total: play.questions.length,
      score: play.questions.filter(q => q.chosen !== null && q.chosen === q.ai).length,
      question: q ? { id: q.id, images: [0, 1].map(side => `/api/plays/${play.id}/images/${play.current}/${side}`), chosen: q.chosen, correct: q.chosen === null ? null : q.chosen === q.ai } : null };
  }
  answer(id: string, questionId: string, side: number) {
    return this.transaction(() => {
      const play = this.play(id), q = play.questions[play.current];
      if (!q || q.id !== questionId || ![0, 1].includes(side)) throw new HttpError(409, 'This question is no longer current.');
      if (q.chosen === null) { q.chosen = side; this.save('plays', play); } return this.view(play);
    });
  }
  next(id: string, questionId: string) {
    return this.transaction(() => {
      const play = this.play(id), q = play.questions[play.current];
      if (q?.id === questionId && q.chosen !== null) { play.current++; this.save('plays', play); } return this.view(play);
    });
  }
  expire() {
    this.transaction(() => {
      for (const game of this.list<Game>('games')) {
        if (!game.deleted && this.now() >= (game.published ?? game.created) + WEEK) {
          for (const q of this.list<Question>('questions', game.id)) for (const key of [q.original, q.generated]) this.garbage(key);
          this.db.prepare('DELETE FROM questions WHERE game=?').run(game.id); this.db.prepare('DELETE FROM plays WHERE game=?').run(game.id);
          game.deleted = true; this.save('games', game);
        }
      }
      this.db.prepare('DELETE FROM sessions WHERE expires<?').run(this.now()); this.db.prepare('DELETE FROM login_limits WHERE expires<?').run(this.now());
    });
  }
}
