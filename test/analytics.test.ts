import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import sharp from 'sharp';
import { Repository, WEEK } from '../src/db.ts';
import { Pipeline, hamming } from '../src/pipeline.ts';
import { DEFAULT_TEMPLATES } from '../src/prompts.ts';
import { normalize, analyze } from '../src/images.ts';
import { ProviderError } from '../src/types.ts';
import type { Question } from '../src/types.ts';
import { fixture, fakeDescriptor, fakeGenerator } from './helpers.ts';
type Row = Record<string, unknown>;
const runs = (repo: Repository, id: string) =>
  repo.db.prepare('SELECT * FROM generation_runs WHERE question_id=? ORDER BY id').all(id) as Row[];
const analytics = (repo: Repository, id: string) =>
  repo.db.prepare('SELECT * FROM question_analytics WHERE question_id=?').get(id) as Row;
async function photo(background: string, size = 900) {
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([
      {
        input: await sharp({
          create: { width: size / 3, height: size / 2, channels: 3, background: '#203040' },
        })
          .png()
          .toBuffer(),
        left: size / 6,
        top: size / 4,
      },
    ])
    .png()
    .toBuffer();
}
async function checkerboard(size = 768, cell = 2) {
  const data = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      data[y * size + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 255 : 0;
  return sharp(data, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}
function queued(f: ReturnType<typeof fixture>) {
  const game = f.repo.create('Analytics'),
    q = f.repo.acceptUpload(game.id);
  q.state = 'describe';
  f.repo.save('questions', q);
  return q;
}
test('default prompt templates are seeded once and versioned immutably', () => {
  const f = fixture();
  try {
    const describe = f.repo.activeTemplate('describe'),
      generate = f.repo.activeTemplate('generate');
    assert.equal(describe.text, DEFAULT_TEMPLATES.describe.text);
    assert.equal(generate.text, 'A natural, realistic photograph. ');
    assert.deepEqual([describe.version, generate.version], [1, 1]);
    // Reopening (and a second connection) does not duplicate unchanged templates.
    const again = new Repository(join(f.dir, 'test.sqlite'), 10000, f.repo.now);
    again.db.close();
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM prompt_templates').get()!.n, 2);
    // Editing a prompt creates a new active version and keeps the old one.
    const edited = f.repo.addTemplate('describe', 'default', 'Describe briefly.');
    assert.equal(edited.version, 2);
    assert.equal(f.repo.activeTemplate('describe').id, edited.id);
    assert.equal(f.repo.template(describe.id).active, 0);
    assert.equal(f.repo.template(describe.id).text, DEFAULT_TEMPLATES.describe.text);
    assert.throws(
      () => f.repo.db.prepare('UPDATE prompt_templates SET text=? WHERE id=?').run('x', edited.id),
      /immutable/,
    );
    assert.throws(
      () => f.repo.db.prepare('DELETE FROM prompt_templates WHERE id=?').run(describe.id),
      /kept/,
    );
    f.repo.db.prepare('UPDATE prompt_templates SET active=1 WHERE id=?').run(describe.id);
    // Changing the seeded default text in code adds a new version on the next start.
    const original = DEFAULT_TEMPLATES.generate.text;
    DEFAULT_TEMPLATES.generate.text = 'A candid photograph. ';
    try {
      const reopened = new Repository(join(f.dir, 'test.sqlite'), 10000, f.repo.now);
      reopened.db.close();
    } finally {
      DEFAULT_TEMPLATES.generate.text = original;
    }
    const latest = f.repo.activeTemplate('generate');
    assert.deepEqual([latest.version, latest.text], [2, 'A candid photograph. ']);
    assert.equal(f.repo.template(generate.id).active, 0);
  } finally {
    f.close();
  }
});
test('successful runs record provider, model, exact prompt, params, output and timings', async () => {
  const f = fixture();
  try {
    const q = queued(f),
      long = 'A cat on a sofa. '.repeat(150);
    await f.store.put(q.original, Buffer.from('original'));
    // A prompt edit after upload must not change the question's snapshotted template.
    const v1 = f.repo.activeTemplate('generate');
    f.repo.addTemplate('generate', 'default', 'Edited prefix. ');
    const prompts: string[] = [];
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(async (_b, prompt) => {
        prompts.push(prompt);
        f.advance(1500);
        return long;
      }, 'descriptor-v1'),
      fakeGenerator(async (prompt) => {
        prompts.push(prompt);
        f.advance(800);
        return Buffer.from('generated');
      }, 'generator-v1'),
      async (b) => b,
    );
    await pipe.tick();
    await pipe.tick();
    const done = f.repo.get<Question>('questions', q.id)!;
    assert.equal(done.state, 'ready');
    assert.equal(done.description!.length, 1900);
    assert.equal(done.generatorTemplate, v1.id);
    const [describe, generate] = runs(f.repo, q.id);
    assert.equal(runs(f.repo, q.id).length, 2);
    assert.equal(describe.step, 'describe');
    assert.equal(describe.provider, 'test-ai');
    assert.equal(describe.model_id, 'descriptor-v1');
    assert.equal(describe.model_version, null);
    assert.equal(describe.prompt_template_id, q.descriptorTemplate);
    assert.equal(describe.prompt_text, DEFAULT_TEMPLATES.describe.text);
    assert.equal(describe.prompt_text, prompts[0]);
    assert.deepEqual(JSON.parse(String(describe.params_json)), { temperature: 0 });
    // Full descriptor output is kept even though the question stores a truncated copy.
    assert.equal(describe.output_text, long);
    assert.equal(describe.latency_ms, 1500);
    assert.equal(describe.status, 'succeeded');
    assert.equal(describe.error_kind, null);
    assert.equal(describe.attempt, 1);
    assert.equal(describe.retry_cycle, 0);
    assert.equal(describe.reserved_units, 200);
    assert.match(String(describe.app_version), /^1\.0\.0/);
    assert.equal(generate.step, 'generate');
    assert.equal(generate.model_id, 'generator-v1');
    assert.equal(generate.prompt_template_id, v1.id);
    assert.equal(generate.prompt_text, 'A natural, realistic photograph. ' + long.slice(0, 1900));
    assert.equal(generate.prompt_text, prompts[1]);
    assert.deepEqual(JSON.parse(String(generate.params_json)), { steps: 1 });
    assert.equal(generate.latency_ms, 800);
    assert.equal(generate.reserved_units, 60);
    const row = analytics(f.repo, q.id);
    assert.equal(row.created_at, done.created);
    assert.equal(row.described_at, Number(describe.finished_at));
    assert.equal(row.ready_at, Number(generate.finished_at));
    assert.deepEqual(
      [row.describe_run_id, row.generate_run_id],
      [Number(describe.id), Number(generate.id)],
    );
    assert.deepEqual(
      [row.describe_template_id, row.generate_template_id],
      [q.descriptorTemplate, v1.id],
    );
    // Without an analyzer (fake bytes), hashes and sizes are still captured.
    const generated = f.repo.metrics(q.id, 'generated')!;
    assert.equal(
      generated.sha256,
      createHash('sha256').update(Buffer.from('generated')).digest('hex'),
    );
    assert.equal(generated.bytes, 9);
    assert.equal(generated.run_id, Number(generate.id));
    assert.equal(generated.dhash, null);
    assert.equal(f.repo.metrics(q.id, 'original')!.bytes, 8);
  } finally {
    f.close();
  }
});
test('temporary and permanent failures are recorded per attempt', async () => {
  const f = fixture();
  try {
    const q = queued(f);
    await f.store.put(q.original, Buffer.from('original'));
    let fail = true;
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(async () => {
        if (fail) throw new ProviderError('Busy', true);
        return 'A dog.';
      }),
      fakeGenerator(async () => {
        throw new ProviderError('Access denied', false);
      }),
      async (b) => b,
    );
    await pipe.tick();
    f.advance(20000);
    fail = false;
    await pipe.tick();
    await pipe.tick();
    assert.equal(f.repo.get<Question>('questions', q.id)!.state, 'failed');
    const rows = runs(f.repo, q.id);
    assert.deepEqual(
      rows.map((r) => [r.step, r.attempt, r.status, r.error_kind]),
      [
        ['describe', 1, 'failed', 'temporary'],
        ['describe', 2, 'succeeded', null],
        ['generate', 1, 'failed', 'permanent'],
      ],
    );
    assert.equal(rows[0].error, 'Busy');
    assert.equal(rows[2].error, 'Access denied');
    assert.ok(rows.every((r) => r.finished_at !== null && r.latency_ms !== null));
    assert.ok(analytics(f.repo, q.id).failed_at);
    // A manual retry records another run in the next retry cycle.
    f.repo.retry(q.id);
    await pipe.tick();
    assert.deepEqual(
      runs(f.repo, q.id)
        .slice(3)
        .map((r) => [r.step, r.attempt, r.retry_cycle]),
      [['generate', 1, 1]],
    );
  } finally {
    f.close();
  }
});
test('image metrics: hashes, distances, brightness, contrast and sharpness', async () => {
  const light = await normalize(await photo('#e0e0e0'), true),
    same = await analyze(light),
    again = await analyze(await normalize(await photo('#e0e0e0'), true)),
    flat = await analyze(
      await normalize(
        await sharp({ create: { width: 800, height: 800, channels: 3, background: '#808080' } })
          .png()
          .toBuffer(),
      ),
    ),
    checks = await analyze(await normalize(await checkerboard()));
  assert.deepEqual([same.width, same.height], [768, 768]);
  assert.match(same.dhash, /^[0-9a-f]{16}$/);
  assert.equal(hamming(same.dhash, again.dhash), 0);
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hamming('00000000000000f0', '0000000000000010'), 3);
  assert.ok(Math.abs(flat.brightness - 128) < 3);
  assert.ok(flat.contrast < 2 && flat.sharpness < 2 && flat.colorfulness < 2);
  assert.ok(same.brightness > flat.brightness && same.contrast > 10);
  assert.ok(checks.sharpness > 1000 && checks.sharpness > same.sharpness * 10);
  const red = await analyze(
    await normalize(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d02020' } })
        .png()
        .toBuffer(),
    ),
  );
  assert.ok(red.colorfulness > 50);
});
test('pipeline stores image metrics and dHash distance for both images', async () => {
  const f = fixture();
  try {
    const q = queued(f),
      original = await normalize(await photo('#e0e0e0'), true);
    await f.store.put(q.original, original);
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(async () => 'A grey square.'),
      fakeGenerator(async () => checkerboard()),
      normalize,
      analyze,
    );
    await pipe.tick();
    await pipe.tick();
    assert.equal(f.repo.get<Question>('questions', q.id)!.state, 'ready');
    const a = f.repo.metrics(q.id, 'original')!,
      b = f.repo.metrics(q.id, 'generated')!;
    assert.equal(a.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(a.run_id, null);
    for (const m of [a, b]) {
      assert.deepEqual([m.width, m.height], [768, 768]);
      for (const k of ['brightness', 'contrast', 'sharpness', 'colorfulness'])
        assert.equal(typeof m[k], 'number');
    }
    assert.equal(analytics(f.repo, q.id).dhash_distance, hamming(String(a.dhash), String(b.dhash)));
    assert.ok(Number(analytics(f.repo, q.id).dhash_distance) > 0);
  } finally {
    f.close();
  }
});
test('analytics rows survive game expiry while images and live state are deleted', async () => {
  const f = fixture();
  try {
    const q = queued(f);
    await f.store.put(q.original, Buffer.from('original'));
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(async () => 'A tree.'),
      fakeGenerator(async () => Buffer.from('generated')),
      async (b) => b,
    );
    await pipe.tick();
    await pipe.tick();
    const game = f.repo.publish(q.game);
    f.repo.start(game.invite!);
    f.advance(WEEK);
    await pipe.cleanup();
    assert.equal(f.store.files.size, 0);
    assert.equal(f.repo.get('questions', q.id), undefined);
    assert.equal(f.repo.list('plays', q.game).length, 0);
    assert.equal(f.repo.get<{ deleted: boolean }>('games', q.game)!.deleted, true);
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM prompt_templates').get()!.n, 2);
    assert.deepEqual(
      runs(f.repo, q.id).map((r) => [r.step, r.status, r.output_text]),
      [
        ['describe', 'succeeded', 'A tree.'],
        ['generate', 'succeeded', null],
      ],
    );
    assert.ok(analytics(f.repo, q.id).ready_at);
    assert.ok(f.repo.metrics(q.id, 'original') && f.repo.metrics(q.id, 'generated'));
  } finally {
    f.close();
  }
});
test('removed and cancelled questions keep or drop analytics appropriately', async () => {
  const f = fixture();
  try {
    const q = queued(f);
    await f.store.put(q.original, Buffer.from('original'));
    let finish!: (text: string) => void;
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(
        () =>
          new Promise<string>((r) => {
            finish = r;
          }),
      ),
      fakeGenerator(async () => Buffer.from('x')),
      async (b) => b,
    );
    const pending = pipe.tick();
    await new Promise((r) => setImmediate(r));
    f.repo.remove(q.id);
    finish('Late description');
    await pending;
    assert.equal(f.repo.get('questions', q.id), undefined);
    assert.deepEqual(
      runs(f.repo, q.id).map((r) => [r.status, r.output_text]),
      [['succeeded', 'Late description']],
    );
    assert.ok(analytics(f.repo, q.id).removed_at);
    const cancelled = f.repo.acceptUpload(q.game);
    f.repo.cancelUpload(cancelled.id);
    assert.equal(analytics(f.repo, cancelled.id), undefined);
  } finally {
    f.close();
  }
});
test('existing databases migrate additively and resume queued questions', async () => {
  const f = fixture();
  const path = join(f.dir, 'legacy.sqlite'),
    legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE games(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE questions(id TEXT PRIMARY KEY, game TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE plays(id TEXT PRIMARY KEY, game TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE budget(day TEXT PRIMARY KEY, reserved INTEGER NOT NULL);
    CREATE TABLE garbage(key TEXT PRIMARY KEY, delete_after INTEGER NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE login_limits(ip TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const now = Date.UTC(2026, 9, 12, 12),
    game = { id: 'g1', title: 'Old', created: now, published: null, invite: null, deleted: false },
    question = {
      id: 'q1',
      game: 'g1',
      original: 'orig',
      generated: 'gen',
      state: 'describe',
      description: null,
      error: null,
      attempts: 0,
      manualRetries: 0,
      due: now,
      lease: 0,
      reservationDay: '2026-10-12',
      descriptorModel: 'old-descriptor',
      generatorModel: 'old-generator',
      descriptorUnits: 200,
      generatorUnits: 60,
    };
  legacy.prepare('INSERT INTO games VALUES(?,?)').run('g1', JSON.stringify(game));
  legacy.prepare('INSERT INTO questions VALUES(?,?,?)').run('q1', 'g1', JSON.stringify(question));
  legacy.prepare('INSERT INTO budget VALUES(?,?)').run('2026-10-12', 1040);
  legacy.close();
  const repo = new Repository(path, 10000, () => now);
  try {
    assert.equal(repo.budget().reserved, 1040);
    await f.store.put('orig', Buffer.from('original'));
    const pipe = new Pipeline(
      repo,
      f.store,
      fakeDescriptor(async () => 'Old question.', 'new-descriptor'),
      fakeGenerator(async () => Buffer.from('generated'), 'new-generator'),
      async (b) => b,
    );
    await pipe.tick();
    await pipe.tick();
    const done = repo.get<Question>('questions', 'q1')!;
    assert.equal(done.state, 'ready');
    assert.equal(done.descriptorTemplate, repo.activeTemplate('describe').id);
    assert.deepEqual(
      runs(repo, 'q1').map((r) => r.model_id),
      ['old-descriptor', 'old-generator'],
    );
    assert.equal(analytics(repo, 'q1').generate_template_id, repo.activeTemplate('generate').id);
    assert.equal(repo.budget().reserved, 1040);
  } finally {
    repo.db.close();
    f.close();
  }
});
