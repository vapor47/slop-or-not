import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Repository } from '../src/db.ts';
import type { Limits } from '../src/quota.ts';
import type { ImageStore, ImageDescriptor, ImageGenerator } from '../src/types.ts';
export function fixture(budget = 10000, limits: Partial<Limits> = {}) {
  let time = Date.UTC(2026, 9, 12, 12);
  const dir = mkdtempSync(join(tmpdir(), 'slop-test-'));
  const repo = new Repository(join(dir, 'test.sqlite'), budget, () => time, undefined, limits);
  const close = () => {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const store: ImageStore & { files: Map<string, Buffer> } = {
    files: new Map(),
    async put(k, b) {
      this.files.set(k, b);
    },
    async get(k) {
      const b = this.files.get(k);
      if (!b) throw new Error('not found');
      return b;
    },
    async delete(k) {
      this.files.delete(k);
    },
  };
  return {
    repo,
    store,
    dir,
    close,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
export function fakeDescriptor(
  describe: (image: Buffer, prompt: string) => Promise<string>,
  model = 'd',
): ImageDescriptor {
  return {
    provider: 'test-ai',
    model,
    params: { temperature: 0 },
    async describe(image, prompt) {
      return { text: await describe(image, prompt) };
    },
  };
}
export function fakeGenerator(
  generate: (prompt: string) => Promise<Buffer>,
  model = 'g',
): ImageGenerator {
  return {
    provider: 'test-ai',
    model,
    params: { steps: 1 },
    async generate(prompt) {
      return { image: await generate(prompt) };
    },
  };
}
export function ready(repo: Repository, count = 2) {
  const game = repo.create('Test game');
  for (let i = 0; i < count; i++) {
    const q = repo.acceptUpload(game.id);
    q.state = 'ready';
    repo.save('questions', q);
  }
  return repo.publish(game.id);
}
// Drives the real request handler with in-process streams, without opening a port.
export function client(server: Server, origin: string) {
  const handler = server.listeners('request')[0] as (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  const state = { cookie: '' };
  async function request(
    path: string,
    method = 'GET',
    value?: unknown,
    extra: Record<string, string> = {},
    ip = '127.0.0.1',
  ) {
    const payload =
      value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
      method,
      url: path,
      headers: {
        origin,
        'x-slop-request': '1',
        cookie: state.cookie,
        'content-type': 'application/json',
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
      },
      socket: { remoteAddress: ip },
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
  return { request, state };
}
