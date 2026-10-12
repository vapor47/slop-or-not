import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Repository, WEEK } from './db.ts';
import { Auth } from './auth.ts';
import { HttpError } from './types.ts';
import type { Game, Question, ImageStore } from './types.ts';
import type { Pipeline, Normalizer } from './pipeline.ts';
const MAX = 10 * 1024 * 1024;
async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Photo exceeds the 10 MB limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try { const value = JSON.parse((await body(req, 8192)).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid request.'); }
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function field(body: Record<string, unknown>, name: string) { if (typeof body[name] !== 'string') throw new HttpError(400, `Missing ${name}.`); return body[name] as string; }
export function app(repo: Repository, auth: Auth, store: ImageStore | null, pipeline: Pipeline | null, normalize: Normalizer | null, origin: string) {
  const publicDir = new URL('../public/', import.meta.url);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url || '/', origin), path = url.pathname, method = req.method || 'GET';
      if (!['GET', 'HEAD'].includes(method) && (req.headers.origin !== origin || req.headers['x-slop-request'] !== '1')) throw new HttpError(403, 'Request origin is not allowed.');
      if (path === '/health') return json(res, { status: 'ok', generationConfigured: Boolean(pipeline), storageConfigured: Boolean(store) });
      if (path === '/api/login' && method === 'POST') { const b = await jsonBody(req); auth.login(req, res, field(b, 'password')); return json(res, { ok: true }); }
      if (path === '/api/logout' && method === 'POST') { auth.logout(req, res); return json(res, { ok: true }); }
      if (path.startsWith('/api/owner')) {
        auth.owner(req);
        if (path === '/api/owner/games' && method === 'GET') return json(res, { games: repo.list<Game>('games').filter(g => !g.deleted && repo.now() < (g.published ?? g.created) + WEEK), budget: repo.budget(), generationConfigured: Boolean(pipeline), storageConfigured: Boolean(store) });
        if (path === '/api/owner/games' && method === 'POST') return json(res, repo.create(field(await jsonBody(req), 'title')), 201);
        const gm = path.match(/^\/api\/owner\/games\/([\w-]+)(?:\/(publish|questions))?$/);
        if (gm) {
          const game = repo.game(gm[1]);
          if (!gm[2] && method === 'GET') return json(res, { ...game, questions: repo.list<Question>('questions', game.id).map(q => ({ id: q.id, state: q.state, error: q.error, attempts: q.attempts, manualRetries: q.manualRetries, preview: `/api/owner/questions/${q.id}/image` })) });
          if (gm[2] === 'publish' && method === 'POST') return json(res, repo.publish(game.id));
          if (gm[2] === 'questions' && method === 'POST') {
            if (!pipeline || !store || !normalize) throw new HttpError(503, 'Generation is not configured yet.');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(req.headers['content-type']))) throw new HttpError(400, 'Upload a JPEG, PNG, or WebP photo.');
            if (Number(req.headers['content-length']) > MAX) throw new HttpError(413, 'Photo exceeds the 10 MB limit.');
            const q = repo.acceptUpload(game.id); // Durable reservation before reading the upload.
            q.descriptorModel = pipeline.descriptor.model; q.generatorModel = pipeline.generator.model; repo.save('questions', q);
            try {
              const bytes = await normalize(await body(req, MAX), true); await store.put(q.original, bytes);
              repo.transaction(() => {
                const current = repo.get<Question>('questions', q.id);
                if (!current) throw new HttpError(409, 'Question was removed.');
                repo.game(game.id, true); q.state = 'describe'; repo.save('questions', q);
              });
              return json(res, { id: q.id }, 201);
            } catch (e) {
              repo.cancelUpload(q.id); repo.garbage(q.original);
              throw e;
            }
          }
        }
        const qm = path.match(/^\/api\/owner\/questions\/([\w-]+)(?:\/(retry|image))?$/);
        if (qm) {
          const q = repo.get<Question>('questions', qm[1]); if (!q) throw new HttpError(404, 'Question unavailable.'); repo.game(q.game);
          if (method === 'DELETE' && !qm[2]) { repo.remove(q.id); return json(res, { ok: true }); }
          if (method === 'POST' && qm[2] === 'retry') { if (!pipeline) throw new HttpError(503, 'Generation is not configured.'); return json(res, repo.retry(q.id)); }
          if (method === 'GET' && qm[2] === 'image') { if (!store) throw new HttpError(503, 'Image storage is unavailable.'); res.setHeader('Content-Type', 'image/jpeg'); return res.end(await store.get(q.original)); }
        }
      }
      const invite = path.match(/^\/api\/invites\/([\w-]+)(?:\/(start))?$/);
      if (invite) {
        const game = repo.invite(invite[1]);
        if (method === 'GET' && !invite[2]) return json(res, { title: game.title, total: repo.list<Question>('questions', game.id).length, expires: game.published! + WEEK });
        if (method === 'POST' && invite[2] === 'start') return json(res, repo.start(invite[1]), 201);
      }
      const play = path.match(/^\/api\/plays\/([\w-]+)(?:\/(answer|next|images)(?:\/(\d+)\/([01]))?)?$/);
      if (play) {
        if (method === 'GET' && !play[2]) return json(res, repo.view(repo.play(play[1])));
        if (method === 'POST' && ['answer', 'next'].includes(play[2])) {
          const b = await jsonBody(req), id = field(b, 'questionId');
          if (play[2] === 'answer' && typeof b.side !== 'number') throw new HttpError(400, 'Choose an image.');
          return json(res, play[2] === 'answer' ? repo.answer(play[1], id, Number(b.side)) : repo.next(play[1], id));
        }
        if (method === 'GET' && play[2] === 'images') {
          const p = repo.play(play[1]), index = Number(play[3]), side = Number(play[4]);
          if (index > p.current || !p.questions[index]) throw new HttpError(404, 'Image unavailable.');
          const item = p.questions[index], q = repo.get<Question>('questions', item.id);
          if (!q || !store) throw new HttpError(503, 'Image unavailable. Retry images.');
          const bytes = await store.get(side === item.ai ? q.generated : q.original);
          // Recheck expiry after the storage request, too.
          repo.game(p.game); res.setHeader('Content-Type', 'image/jpeg'); return res.end(bytes);
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'Unavailable endpoint.');
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const file = path === '/app.js' ? 'app.js' : path === '/style.css' ? 'style.css' : path === '/' || path === '/create' || /^\/g\/[\w-]+$/.test(path) ? 'index.html' : null;
      if (!file) throw new HttpError(404, 'Page unavailable.');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(new URL(file, publicDir)));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: 'request_failure', path: (req.url || '').split('?')[0].replace(/[\w-]{32}/g, '[token]') }));
      json(res, { error: error instanceof HttpError ? error.message : 'The service is temporarily unavailable. Please try again.' }, error instanceof HttpError ? error.status : 503);
    }
  });
}
