import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Repository } from './db.ts';
import { Auth } from './auth.ts';
import { app } from './server.ts';
import { Pipeline } from './pipeline.ts';
import { CloudflareAPI, CloudflareDescriptor, CloudflareGenerator } from './cloudflare.ts';
import type { ImageStore } from './types.ts';
import type { Normalizer } from './pipeline.ts';
const env = process.env, production = env.NODE_ENV === 'production';
const origin = env.APP_ORIGIN || 'http://localhost:3000';
if (production && (!env.OWNER_PASSWORD_HASH || !origin.startsWith('https://'))) throw new Error('Production requires OWNER_PASSWORD_HASH and an HTTPS APP_ORIGIN.');
const directory = resolve(env.DATA_DIR || 'data'); mkdirSync(directory, { recursive: true });
const budget = Number(env.DAILY_NEURON_BUDGET || 9000);
if (!Number.isSafeInteger(budget) || budget < 1 || budget > 10000) throw new Error('DAILY_NEURON_BUDGET must be 1–10000.');
const units = { descriptor: Number(env.DESCRIPTOR_NEURON_RESERVATION || 200), generator: Number(env.GENERATOR_NEURON_RESERVATION || 60) };
if (Object.values(units).some(v => !Number.isSafeInteger(v) || v < 1)) throw new Error('Model neuron reservations must be positive integers.');
const repo = new Repository(resolve(directory, 'game.sqlite'), budget, Date.now, units);
const auth = new Auth(repo, env.OWNER_PASSWORD_HASH || '', origin.startsWith('https://'));
let store: ImageStore | null = null, normalize: Normalizer | null = null, pipeline: Pipeline | null = null;
if (env.S3_BUCKET) {
  const { S3Store } = await import('./storage.ts'); store = new S3Store(env);
  normalize = (await import('./images.ts')).normalize;
}
if (store && normalize && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && env.DESCRIPTOR_TERMS_ACCEPTED === 'true') {
  const api = new CloudflareAPI(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  pipeline = new Pipeline(repo, store, new CloudflareDescriptor(api, env.DESCRIPTOR_MODEL), new CloudflareGenerator(api, env.GENERATOR_MODEL), normalize);
}
const server = app(repo, auth, store, pipeline, normalize, origin);
server.requestTimeout = 120000; server.headersTimeout = 10000;
const port = Number(env.PORT || 3000);
server.listen(port, env.HOST || '127.0.0.1', () => console.log(`Slop or Not: ${origin}${!pipeline ? ' (generation not configured)' : ''}`));
let working = false, cleaning = false;
const work = setInterval(async () => {
  if (!pipeline || working) return; working = true;
  try { await pipeline.tick(); } catch { console.error(JSON.stringify({ event: 'worker_failure' })); } finally { working = false; }
}, 1000);
const cleanup = setInterval(async () => {
  if (cleaning) return; cleaning = true;
  try { if (pipeline) await pipeline.cleanup(); else repo.expire(); } catch { console.error(JSON.stringify({ event: 'cleanup_failure' })); } finally { cleaning = false; }
}, 60000);
repo.expire();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(work); clearInterval(cleanup); server.close(() => { if (!working && !cleaning) repo.db.close(); process.exit(0); }); });
