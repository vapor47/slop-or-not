import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Repository } from '../src/db.ts';
import { Auth } from '../src/auth.ts';
import { app } from '../src/server.ts';
import { Pipeline } from '../src/pipeline.ts';
import type { ImageStore, Question } from '../src/types.ts';
test('HTTP creator login → upload → processing → invite → play → score and replay', async () => {
  const repo = new Repository(':memory:', 10000);
  const files = new Map<string, Buffer>();
  const store: ImageStore = {
    async put(k, b) {
      files.set(k, b);
    },
    async get(k) {
      const b = files.get(k);
      if (!b) throw new Error();
      return b;
    },
    async delete(k) {
      files.delete(k);
    },
  };
  const normalize = async (b: Buffer) => b;
  const pipe = new Pipeline(
    repo,
    store,
    {
      model: 'descriptor-test',
      async describe() {
        return 'A realistic cat photo';
      },
    },
    {
      model: 'generator-test',
      async generate(text) {
        assert.equal(text, 'A realistic cat photo');
        return Buffer.from('fake');
      },
    },
    normalize,
  );
  const hash = 'test:' + scryptSync('test-password', 'test', 64).toString('hex');
  const server = app(
    repo,
    new Auth(repo, hash, false),
    store,
    pipe,
    normalize,
    'http://localhost:3109',
  );
  const handler = server.listeners('request')[0] as (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  const origin = 'http://localhost:3109';
  let cookie = '';
  async function request(
    path: string,
    method = 'GET',
    value?: unknown,
    extra: Record<string, string> = {},
    trusted = true,
  ) {
    const payload =
      value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
      method,
      url: path,
      headers: {
        ...(trusted ? { origin, 'x-slop-request': '1' } : {}),
        cookie,
        'content-type': 'application/json',
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
      },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    const headers = new Headers();
    let status = 200,
      bytes: Buffer = Buffer.alloc(0);
    const res = {
      headersSent: false,
      setHeader(k: string, v: string) {
        headers.set(k, v);
      },
      writeHead(code: number, h: Record<string, string>) {
        status = code;
        for (const [k, v] of Object.entries(h)) headers.set(k, v);
        this.headersSent = true;
      },
      end(data?: string | Buffer) {
        bytes = Buffer.from(data || '');
      },
      destroy() {
        throw new Error('Response destroyed');
      },
    };
    await handler(req, res as unknown as ServerResponse);
    return new Response(new Uint8Array(bytes), { status, headers });
  }
  try {
    assert.equal((await request('/api/owner/games')).status, 401);
    assert.equal((await request('/api/login', 'POST', {}, {}, false)).status, 403);
    assert.equal((await request('/api/login', 'POST', { password: 'wrong' })).status, 401);
    const login = await request('/api/login', 'POST', { password: 'test-password' });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
    const g = await (await request('/api/owner/games', 'POST', { title: 'HTTP Game' })).json();
    assert.equal((await request(`/api/owner/games/${g.id}/publish`, 'POST', {})).status, 409);
    assert.equal(
      (
        await request(`/api/owner/games/${g.id}/questions`, 'POST', 'real', {
          'Content-Type': 'image/jpeg',
        })
      ).status,
      201,
    );
    await pipe.tick();
    await pipe.tick();
    const published = await (await request(`/api/owner/games/${g.id}/publish`, 'POST', {})).json();
    cookie = '';
    const start = await (
      await request(`/api/invites/${published.invite}/start`, 'POST', {})
    ).json();
    const position = repo.play(start.id).questions[0].ai;
    const image = await request(start.question.images[position]);
    assert.equal(await image.text(), 'fake');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(start).includes('generator-test'), false);
    assert.equal('ai' in start.question, false);
    const answered = await (
      await request(`/api/plays/${start.id}/answer`, 'POST', {
        questionId: start.question.id,
        side: position,
      })
    ).json();
    assert.equal(answered.score, 1);
    const restored = await (await request(`/api/plays/${start.id}`)).json();
    assert.deepEqual(restored, answered);
    const finished = await (
      await request(`/api/plays/${start.id}/next`, 'POST', { questionId: start.question.id })
    ).json();
    assert.equal(finished.question, null);
    assert.equal(finished.score, 1);
    const replay = await (
      await request(`/api/invites/${published.invite}/start`, 'POST', {})
    ).json();
    assert.notEqual(replay.id, start.id);
    assert.equal(replay.score, 0);
    const q = repo.list<Question>('questions', g.id)[0];
    assert.equal((await request(`/api/owner/questions/${q.id}/image`)).status, 401);
    assert.equal((await request('/')).status, 200);
  } finally {
    server.close();
    repo.db.close();
  }
});
