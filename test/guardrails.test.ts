import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { Repository } from '../src/db.ts';
import { Auth } from '../src/auth.ts';
import { app } from '../src/server.ts';
import { Pipeline } from '../src/pipeline.ts';
import { CloudflareUsage } from '../src/cloudflare.ts';
import { MeteredStore, ImageCache } from '../src/metered.ts';
import { DEFAULT_LIMITS, IMAGES_UNAVAILABLE, limitsFromEnv } from '../src/quota.ts';
import { RATE_LIMITS } from '../src/ratelimit.ts';
import type { Question } from '../src/types.ts';
import { fixture, ready, fakeDescriptor, fakeGenerator, client } from './helpers.ts';
// A fake store that counts every call reaching "R2".
function metered(f: ReturnType<typeof fixture>, cacheBytes = 0) {
  const calls = { put: 0, get: 0, delete: 0 };
  const inner = {
    put: async (k: string, b: Buffer) => {
      calls.put++;
      await f.store.put(k, b);
    },
    get: async (k: string) => {
      calls.get++;
      return f.store.get(k);
    },
    delete: async (k: string) => {
      calls.delete++;
      await f.store.delete(k);
    },
  };
  return { calls, store: new MeteredStore(inner, f.repo.quota, new ImageCache(cacheBytes)) };
}
const usage = (neurons: number) => ({ neuronsUsed: async () => neurons });
test('defaults are 80% of the verified free allowances and env may only lower them', () => {
  assert.deepEqual(
    [
      DEFAULT_LIMITS.neurons,
      DEFAULT_LIMITS.r2ClassA,
      DEFAULT_LIMITS.r2ClassB,
      DEFAULT_LIMITS.storedBytes,
    ],
    [8000, 800_000, 8_000_000, 8_000_000_000],
  );
  assert.deepEqual(limitsFromEnv({}), DEFAULT_LIMITS);
  assert.equal(limitsFromEnv({ R2_CLASS_B_MONTHLY_CAP: '1000' }).r2ClassB, 1000);
  for (const name of [
    'DAILY_NEURON_BUDGET',
    'R2_CLASS_A_MONTHLY_CAP',
    'R2_CLASS_B_MONTHLY_CAP',
    'R2_STORED_BYTES_CAP',
  ])
    assert.throws(() => limitsFromEnv({ [name]: '10000000001' }), new RegExp(name));
  assert.throws(() => limitsFromEnv({ DAILY_NEURON_BUDGET: '9000' }), /DAILY_NEURON_BUDGET/);
  assert.throws(() => limitsFromEnv({ R2_BILLING_DAY: '29' }), /R2_BILLING_DAY/);
});
test('R2 Class A, Class B and stored-byte caps fail closed before calling storage', async () => {
  const f = fixture(10000, { r2ClassA: 2, r2ClassB: 2, storedBytes: 10 });
  try {
    const { calls, store } = metered(f);
    await store.put('a', Buffer.from('12345'));
    await assert.rejects(store.put('b', Buffer.from('123456')), /storage is full/);
    assert.equal(calls.put, 1);
    await store.put('b', Buffer.from('12345'));
    assert.equal(f.repo.quota.storedBytes(), 10);
    await store.delete('b');
    assert.equal(f.repo.quota.storedBytes(), 5);
    // Class A is exhausted (two puts), even though bytes are free again.
    await assert.rejects(store.put('c', Buffer.from('1')), /paused until the storage allowance/);
    assert.equal(calls.put, 2);
    await store.get('a');
    await store.get('a');
    await assert.rejects(store.get('a'), (e: Error) => e.message === IMAGES_UNAVAILABLE);
    assert.equal(calls.get, 2);
    // Deletes are free and shrink storage, so they are never refused.
    await store.delete('a');
    assert.equal(calls.delete, 2);
    assert.equal(f.repo.quota.storedBytes(), 0);
    assert.equal(f.repo.quota.usage().deletes, 2);
  } finally {
    f.close();
  }
});
test('a failed put keeps its byte reservation; overwriting a key is not double counted', async () => {
  const f = fixture();
  try {
    const store = new MeteredStore(
      {
        put: async () => {
          throw new Error('network');
        },
        get: async () => Buffer.alloc(0),
        delete: async () => {},
      },
      f.repo.quota,
      new ImageCache(0),
    );
    await assert.rejects(store.put('k', Buffer.alloc(100)));
    assert.equal(f.repo.quota.storedBytes(), 100);
    assert.equal(f.repo.quota.used('r2_class_a'), 1);
    await assert.rejects(store.put('k', Buffer.alloc(40)));
    assert.equal(f.repo.quota.storedBytes(), 40);
    await store.delete('k');
    assert.equal(f.repo.quota.storedBytes(), 0);
  } finally {
    f.close();
  }
});
test('cache hits avoid R2 calls and op counts; the cache is bounded by bytes', async () => {
  const f = fixture();
  try {
    await f.store.put('a', Buffer.alloc(6));
    await f.store.put('b', Buffer.alloc(6));
    const { calls, store } = metered(f, 10);
    await store.get('a');
    await store.get('a');
    assert.equal(calls.get, 1);
    assert.equal(f.repo.quota.used('r2_class_b'), 1);
    await store.get('b'); // Evicts "a": 12 bytes would exceed the 10-byte bound.
    assert.equal(store.cache.size, 6);
    await store.get('a');
    assert.equal(calls.get, 3);
    // A put populates the cache, so the freshly stored image is served without a read.
    await store.put('c', Buffer.alloc(4));
    await store.get('c');
    assert.equal(calls.get, 3);
    await store.delete('c');
    await assert.rejects(store.get('c'), /not found/);
  } finally {
    f.close();
  }
});
test('counters, stored bytes and kill switches survive reopening SQLite', async () => {
  const f = fixture();
  try {
    const { store } = metered(f);
    await store.put('a', Buffer.alloc(7));
    await store.get('a');
    f.repo.reserve(500);
    f.repo.quota.setSwitch('storage_read_only', true);
    f.repo.quota.recordReconciliation(f.repo.day(), 1234);
    const reopened = new Repository(join(f.dir, 'test.sqlite'), 10000, f.repo.now);
    try {
      const q = reopened.quota;
      assert.equal(q.used('r2_class_a'), 1);
      assert.equal(q.used('r2_class_b'), 1);
      assert.equal(q.storedBytes(), 7);
      assert.equal(reopened.budget().reserved, 500);
      assert.equal(q.setting('storage_read_only'), true);
      assert.equal(q.actualNeurons(), 1234);
    } finally {
      reopened.db.close();
    }
  } finally {
    f.close();
  }
});
test('daily neuron and monthly R2 counters roll over at UTC boundaries and billing day', async () => {
  const f = fixture(1000, { r2ClassB: 1, billingDay: 15 });
  try {
    await f.store.put('a', Buffer.from('x'));
    const { store } = metered(f);
    f.repo.reserve(1000);
    assert.throws(() => f.repo.reserve(1), /budget exhausted/);
    await store.get('a');
    await assert.rejects(store.get('a'), /temporarily unavailable/);
    assert.equal(f.repo.quota.month(), '2026-09-15');
    // 2026-10-12 12:00 → 2026-10-13 00:00 UTC: new day, same R2 period.
    f.advance(12 * 3600000);
    assert.equal(f.repo.budget().reserved, 0);
    f.repo.reserve(1);
    await assert.rejects(store.get('a'), /temporarily unavailable/);
    // 2026-10-15 00:00 UTC starts the next R2 period.
    f.advance(2 * 86400000 - 1);
    assert.equal(f.repo.quota.month(), '2026-09-15');
    f.advance(1);
    assert.equal(f.repo.quota.month(), '2026-10-15');
    await store.get('a');
    const calendar = fixture(1000);
    try {
      calendar.advance(20 * 86400000); // 2026-11-01 12:00
      assert.equal(calendar.repo.quota.month(), '2026-11-01');
    } finally {
      calendar.close();
    }
  } finally {
    f.close();
  }
});
test('live game and question backstop caps', () => {
  const f = fixture(100000, { liveGames: 2, liveQuestions: 3 });
  try {
    const a = f.repo.create('A');
    f.repo.create('B');
    assert.throws(() => f.repo.create('C'), /live game limit/);
    for (let i = 0; i < 3; i++) f.repo.acceptUpload(a.id);
    assert.throws(() => f.repo.acceptUpload(a.id), /live question limit/);
  } finally {
    f.close();
  }
});
test('reconciliation stops generation for the day when Cloudflare usage reaches the cap', async () => {
  const f = fixture(2000);
  try {
    const g = f.repo.create('Recon'),
      q = f.repo.acceptUpload(g.id);
    q.state = 'describe';
    f.repo.save('questions', q);
    await f.store.put(q.original, Buffer.from('x'));
    let calls = 0;
    const pipe = new Pipeline(
      f.repo,
      f.store,
      fakeDescriptor(async () => {
        calls++;
        return 'x';
      }),
      fakeGenerator(async () => Buffer.from('y')),
      async (b) => b,
    );
    f.repo.quota.reconcileConfigured = true;
    assert.equal(await f.repo.quota.reconcile(usage(1999.2)), true);
    assert.equal(f.repo.quota.actualNeurons(), 2000);
    assert.match(String(f.repo.quota.generationBlocked()), /daily AI allowance/);
    assert.equal(await pipe.tick(), false);
    assert.equal(calls, 0);
    assert.equal(f.repo.get<Question>('questions', q.id)!.attempts, 0);
    // Local reservations alone would allow this; Cloudflare's figure does not.
    assert.throws(() => f.repo.reserve(1), /budget exhausted/);
    // A failed check keeps today's last figure, so the stop is not lifted.
    await f.repo.quota.reconcile({
      neuronsUsed: async () => {
        throw new Error('down');
      },
    });
    assert.equal(f.repo.quota.reconciliationStatus(), 'failed');
    assert.ok(f.repo.quota.generationBlocked());
    // The stop belongs to the UTC day.
    f.advance(12 * 3600000);
    assert.equal(f.repo.quota.generationBlocked(), null);
    assert.equal(await pipe.tick(), true);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test('reconciliation status: not configured warns, fresh is ok, old is stale', async () => {
  const f = fixture();
  try {
    const q = f.repo.quota;
    assert.equal(q.reconciliationStatus(), 'not_configured');
    assert.match(q.usage().warnings.join(), /estimated locally/);
    q.reconcileConfigured = true;
    assert.equal(q.reconciliationStatus(), 'stale');
    await q.reconcile(usage(10));
    assert.equal(q.reconciliationStatus(), 'ok');
    assert.equal(q.usage().counters.find((c) => c.id === 'neurons_actual')!.used, 10);
    f.advance(16 * 60000);
    assert.equal(q.reconciliationStatus(), 'stale');
  } finally {
    f.close();
  }
});
test('GraphQL usage sums totalNeurons and treats GraphQL errors as failures', async () => {
  let body: { query: string; variables: Record<string, string> } | null = null,
    auth = '';
  const respond = (value: unknown, status = 200) =>
    (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      auth = new Headers(init!.headers).get('authorization')!;
      return new Response(JSON.stringify(value), { status });
    }) as typeof fetch;
  const start = new Date('2026-10-12T00:00:00Z'),
    end = new Date('2026-10-13T00:00:00Z');
  const rows = (...n: number[]) => ({
    data: {
      viewer: {
        accounts: [{ aiInferenceAdaptiveGroups: n.map((v) => ({ sum: { totalNeurons: v } })) }],
      },
    },
  });
  assert.equal(
    await new CloudflareUsage('acct', 'tok', respond(rows(10.5, 20))).neuronsUsed(start, end),
    30.5,
  );
  assert.match(body!.query, /aiInferenceAdaptiveGroups/);
  assert.deepEqual(body!.variables, {
    account: 'acct',
    start: '2026-10-12T00:00:00.000Z',
    end: '2026-10-13T00:00:00.000Z',
  });
  assert.equal(auth, 'Bearer tok');
  assert.equal(await new CloudflareUsage('a', 't', respond(rows())).neuronsUsed(start, end), 0);
  for (const fetcher of [
    respond({ data: null, errors: [{ message: 'not authorized' }] }),
    respond({}, 403),
  ])
    await assert.rejects(
      new CloudflareUsage('a', 'secret-token', fetcher).neuronsUsed(start, end),
      (e: Error) => !e.message.includes('secret-token'),
    );
});
test('storage headroom and quota refusals never waste neurons or attempts', async () => {
  const f = fixture(10000, { storedBytes: 3 * 1024 * 1024 });
  try {
    const { store } = metered(f);
    const g = f.repo.create('Storage'),
      q = f.repo.acceptUpload(g.id);
    q.state = 'generate';
    q.description = 'A photo';
    f.repo.save('questions', q);
    await store.put(q.original, Buffer.alloc(2 * 1024 * 1024));
    let generated = 0;
    const pipe = new Pipeline(
      f.repo,
      store,
      fakeDescriptor(async () => 'x'),
      fakeGenerator(async () => {
        generated++;
        return Buffer.from('y');
      }),
      async (b) => b,
    );
    // Less than one image estimate of headroom left: nothing is claimed.
    assert.equal(await pipe.tick(), false);
    assert.equal(generated, 0);
    await store.delete(q.original);
    // Read-only storage blocks claims as well.
    f.repo.quota.setSwitch('storage_read_only', true);
    assert.equal(await pipe.tick(), false);
    f.repo.quota.setSwitch('storage_read_only', false);
    // A refusal before any model call keeps the attempt and reschedules.
    const d = f.repo.acceptUpload(g.id);
    d.state = 'describe';
    f.repo.save('questions', d);
    f.repo.quota.limits.r2ClassB = 0;
    q.due = f.repo.now() + 3600000;
    f.repo.save('questions', { ...f.repo.get<Question>('questions', q.id)!, due: q.due });
    assert.equal(await pipe.tick(), true);
    const after = f.repo.get<Question>('questions', d.id)!;
    assert.equal(after.state, 'describe');
    assert.equal(after.attempts, 0);
    assert.equal(after.error, IMAGES_UNAVAILABLE);
    assert.ok(after.due > f.repo.now());
  } finally {
    f.close();
  }
});
test('HTTP guardrails: kill switches, usage meter, health, graceful images, rate limits', async () => {
  const f = fixture(10000, { r2ClassB: 4 });
  const { calls, store } = metered(f, 1024);
  const normalize = async (b: Buffer) => b;
  const pipe = new Pipeline(
    f.repo,
    store,
    fakeDescriptor(async () => 'A cat'),
    fakeGenerator(async () => Buffer.from('fake')),
    normalize,
  );
  const origin = 'http://localhost:3109',
    hash = 'test:' + scryptSync('pw', 'test', 64).toString('hex');
  const limits = structuredClone(RATE_LIMITS);
  limits.start.ip = 3;
  limits.image.play = 6;
  limits.play.play = 3;
  limits.invite.ip = 2;
  const server = app(
    f.repo,
    new Auth(f.repo, hash, false, 'cf-connecting-ip'),
    store,
    pipe,
    normalize,
    origin,
    { ipHeader: 'cf-connecting-ip', rateLimits: limits },
  );
  const { request, state } = client(server, origin);
  const upload = (id: string) =>
    request(`/api/owner/games/${id}/questions`, 'POST', 'real', { 'Content-Type': 'image/jpeg' });
  try {
    const health = await (await request('/health')).json();
    assert.deepEqual(health.quota, {
      nearLimit: [],
      reconciliation: 'not_configured',
      generationPaused: false,
      storageReadOnly: false,
    });
    const login = await request('/api/login', 'POST', { password: 'pw' });
    state.cookie = login.headers.get('set-cookie')!.split(';')[0];
    const g = await (await request('/api/owner/games', 'POST', { title: 'G' })).json();
    // Generation kill switch: uploads, retries and the worker all stop without a restart.
    let usage = await (
      await request('/api/owner/switches', 'POST', { generationDisabled: true })
    ).json();
    assert.equal(usage.switches.generationDisabled, true);
    const refused = await upload(g.id);
    assert.equal(refused.status, 503);
    assert.match((await refused.json()).error, /paused by the owner/);
    assert.equal(f.repo.list('questions', g.id).length, 0);
    assert.equal((await request('/health').then((r) => r.json())).quota.generationPaused, true);
    await request('/api/owner/switches', 'POST', { generationDisabled: false });
    // Storage read-only switch.
    await request('/api/owner/switches', 'POST', { storageReadOnly: true });
    assert.match((await (await upload(g.id)).json()).error, /read-only/);
    await request('/api/owner/switches', 'POST', { storageReadOnly: false });
    assert.equal((await upload(g.id)).status, 201);
    await request('/api/owner/switches', 'POST', { generationDisabled: true });
    assert.equal(await pipe.tick(), false);
    await request('/api/owner/switches', 'POST', { generationDisabled: false });
    await pipe.tick();
    await pipe.tick();
    usage = await (await request('/api/owner/usage')).json();
    const counter = (id: string) => usage.counters.find((c: { id: string }) => c.id === id);
    assert.equal(counter('r2_class_a').used, 2);
    assert.equal(counter('r2_class_a').cap, 800_000);
    assert.equal(counter('r2_class_b').used, 0); // Original was cached on upload.
    assert.equal(counter('stored_bytes').used, 8);
    assert.equal(counter('live_questions').used, 1);
    const games = await (await request('/api/owner/games')).json();
    assert.equal(games.usage.counters.length, usage.counters.length);
    const published = await (await request(`/api/owner/games/${g.id}/publish`, 'POST')).json();
    state.cookie = '';
    // Guest requests: rate limits per IP (via the trusted header) and per play.
    const guest = (path: string, method = 'GET', value?: unknown, ip = '203.0.113.1') =>
      request(path, method, value, { 'cf-connecting-ip': ip });
    assert.equal((await guest(`/api/invites/${published.invite}`)).status, 200);
    assert.equal((await guest(`/api/invites/${published.invite}`)).status, 200);
    assert.equal((await guest(`/api/invites/${published.invite}`)).status, 429);
    assert.equal(
      (await guest(`/api/invites/${published.invite}`, 'GET', undefined, '203.0.113.2')).status,
      200,
    );
    const start = await (await guest(`/api/invites/${published.invite}/start`, 'POST', {})).json();
    await guest(`/api/invites/${published.invite}/start`, 'POST', {});
    await guest(`/api/invites/${published.invite}/start`, 'POST', {});
    assert.equal((await guest(`/api/invites/${published.invite}/start`, 'POST', {})).status, 429);
    // Images are served from the cache: no R2 reads, privately cacheable, no validators.
    const gets = calls.get;
    for (const side of [0, 1]) {
      const image = await guest(start.question.images[side]);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('cache-control'), 'private, max-age=86400');
      assert.equal(image.headers.get('etag'), null);
    }
    assert.equal(calls.get, gets);
    // Cache miss on both sides: one read each, then R2 Class B cap → graceful 503, no R2 call.
    store.cache.items.clear();
    store.cache.size = 0;
    f.repo.quota.limits.r2ClassB = 1;
    const unavailable = await guest(start.question.images[0]);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, IMAGES_UNAVAILABLE);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert.equal(calls.get, gets + 1);
    f.repo.quota.limits.r2ClassB = 4;
    for (let i = 0; i < 3; i++) await guest(start.question.images[0]);
    assert.equal((await guest(start.question.images[0])).status, 429);
    // Answer/next/view share a per-play limit.
    const answer = { questionId: start.question.id, side: 0 };
    for (let i = 0; i < 3; i++)
      assert.equal((await guest(`/api/plays/${start.id}/answer`, 'POST', answer)).status, 200);
    assert.equal((await guest(`/api/plays/${start.id}/answer`, 'POST', answer)).status, 429);
    assert.equal((await guest(`/api/plays/${start.id}`)).status, 429);
    // Limits reset after the window.
    f.advance(60000);
    assert.equal((await guest(`/api/plays/${start.id}`)).status, 200);
    const text = JSON.stringify(await (await request('/health')).json());
    assert.equal(/token|secret|tok/i.test(text), false);
  } finally {
    server.close();
    f.close();
  }
});
test('expiry prunes rate-limit rows; deleting expired images decrements stored bytes', async () => {
  const f = fixture();
  try {
    const { store } = metered(f);
    const game = ready(f.repo, 1),
      q = f.repo.list<Question>('questions', game.id)[0];
    await store.put(q.original, Buffer.alloc(3));
    await store.put(q.generated, Buffer.alloc(4));
    f.repo.db.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run('x', 1, f.repo.now() - 1);
    const pipe = new Pipeline(
      f.repo,
      store,
      fakeDescriptor(async () => 'x'),
      fakeGenerator(async () => Buffer.from('y')),
      async (b) => b,
    );
    f.advance(8 * 86400000);
    await pipe.cleanup();
    assert.equal(f.repo.quota.storedBytes(), 0);
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()!.n, 0);
  } finally {
    f.close();
  }
});
test('legacy objects are backfilled into the stored-bytes ledger on open', () => {
  const f = fixture();
  try {
    const game = ready(f.repo, 2);
    const [a, b] = f.repo.list<Question>('questions', game.id);
    f.repo.saveMetrics(a, 'original', null, { sha256: 'x', bytes: 1000 }, null);
    f.repo.db.exec('DELETE FROM stored_objects');
    const reopened = new Repository(join(f.dir, 'test.sqlite'), 10000, f.repo.now);
    try {
      // a.original measured; a.generated, b.original and b.generated use the 2 MiB estimate.
      assert.equal(reopened.quota.storedBytes(), 1000 + 3 * 2 * 1024 * 1024);
      assert.ok(b);
    } finally {
      reopened.db.close();
    }
  } finally {
    f.close();
  }
});
