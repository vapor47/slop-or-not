// Test-only entry point for browser end-to-end tests. Composes the real app() with an in-memory
// image store and fake descriptor/generator models, mirroring test/http.test.ts. It never talks to
// Cloudflare or S3. Never deploy this file: /__e2e/* routes are unauthenticated test controls.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Repository, WEEK } from '../../src/db.ts';
import { Auth } from '../../src/auth.ts';
import { app } from '../../src/server.ts';
import { Pipeline } from '../../src/pipeline.ts';
import { normalize, analyze } from '../../src/images.ts';
import type { Game, ImageStore, Play, Question } from '../../src/types.ts';

const env = process.env;
const port = Number(env.E2E_PORT || 3199);
const origin = `http://127.0.0.1:${port}`;
const E2E_PASSWORD = env.E2E_OWNER_PASSWORD || 'e2e-owner-password';

const dir = mkdtempSync(join(tmpdir(), 'slop-e2e-'));
// Tiny per-call reservations so seeding many games never exhausts the daily budget.
const repo = new Repository(join(dir, 'game.sqlite'), 10000, Date.now, {
  descriptor: 1,
  generator: 1,
});
const files = new Map<string, Buffer>();
const store: ImageStore = {
  async put(k, b) {
    files.set(k, b);
  },
  async get(k) {
    const b = files.get(k);
    if (!b) throw new Error('not found');
    return b;
  },
  async delete(k) {
    files.delete(k);
  },
};
const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
const pipeline = new Pipeline(
  repo,
  store,
  {
    provider: 'e2e-fake',
    model: 'e2e-descriptor',
    params: {},
    async describe() {
      return { text: 'A plain test photograph' };
    },
  },
  {
    provider: 'e2e-fake',
    model: 'e2e-generator',
    params: {},
    async generate() {
      return { image: await solid(200, 40, 160) };
    },
  },
  normalize,
  analyze,
);
const hash = 'e2e:' + scryptSync(E2E_PASSWORD, 'e2e', 64).toString('hex');
const inner = app(repo, new Auth(repo, hash, false), store, pipeline, normalize, origin);
const handle = inner.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;

function send(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}
// Creates a published game whose questions are already ready, skipping the UI and pipeline.
async function seed(title: string, count: number) {
  const game = repo.create(title);
  for (let i = 0; i < count; i++) {
    const q = repo.acceptUpload(game.id);
    await store.put(q.original, await normalize(await solid(40, 120 + i * 10, 200)));
    await store.put(q.generated, await normalize(await solid(220, 90, 30 + i * 10)));
    q.state = 'ready';
    repo.save('questions', q);
  }
  return repo.publish(game.id);
}
async function control(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/__e2e/seed' && req.method === 'POST') {
    const b = await readJson(req);
    const game = await seed(String(b.title || 'E2E game'), Number(b.questions || 2));
    return send(res, { id: game.id, invite: game.invite }, 201);
  }
  if (path === '/__e2e/expire' && req.method === 'POST') {
    const b = await readJson(req);
    const game = repo.list<Game>('games').find((g) => g.invite === b.invite);
    if (!game) return send(res, { error: 'unknown invite' }, 404);
    game.published = (game.published ?? game.created) - WEEK;
    repo.save('games', game);
    if (b.purge) repo.expire();
    return send(res, { ok: true });
  }
  // Login attempts are rate limited per IP; every browser test shares 127.0.0.1.
  if (path === '/__e2e/reset-login-limits' && req.method === 'POST') {
    repo.db.exec('DELETE FROM login_limits');
    return send(res, { ok: true });
  }
  const play = path.match(/^\/__e2e\/plays\/([\w-]+)$/);
  if (play && req.method === 'GET') {
    const p = repo.get<Play>('plays', play[1]);
    if (!p) return send(res, { error: 'unknown play' }, 404);
    return send(res, { current: p.current, questions: p.questions });
  }
  const game = path.match(/^\/__e2e\/games\/([\w-]+)$/);
  if (game && req.method === 'GET')
    return send(res, { questions: repo.list<Question>('questions', game[1]) });
  send(res, { error: 'unknown control' }, 404);
}

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (!path.startsWith('/__e2e/')) return handle(req, res);
  control(req, res, path).catch((e) => send(res, { error: String(e) }, 500));
});
let working = false;
const work = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    await pipeline.tick();
  } catch {
    console.error(JSON.stringify({ event: 'worker_failure' }));
  } finally {
    working = false;
  }
}, 100);
server.listen(port, '127.0.0.1', () => console.log(`Slop or Not e2e server: ${origin}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(work);
    server.close();
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
