import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Repository } from './db.ts';
import { Auth } from './auth.ts';
import { app } from './server.ts';
import { Pipeline } from './pipeline.ts';
import {
  CloudflareAPI,
  CloudflareDescriptor,
  CloudflareGenerator,
  CloudflareUsage,
} from './cloudflare.ts';
import { limitsFromEnv } from './quota.ts';
import { MeteredStore, ImageCache } from './metered.ts';
import type { ImageStore } from './types.ts';
import type { Normalizer, Analyzer } from './pipeline.ts';
const env = process.env,
  production = env.NODE_ENV === 'production';
const origin = env.APP_ORIGIN || 'http://localhost:3000';
if (production && (!env.OWNER_PASSWORD_HASH || !origin.startsWith('https://')))
  throw new Error('Production requires OWNER_PASSWORD_HASH and an HTTPS APP_ORIGIN.');
const directory = resolve(env.DATA_DIR || 'data');
mkdirSync(directory, { recursive: true });
const limits = limitsFromEnv(env);
const units = {
  descriptor: Number(env.DESCRIPTOR_NEURON_RESERVATION || 200),
  // flux-1-schnell: 4.80 neurons per 512×512 tile + 9.60 per step ≈ 57.6 at 1024² and 4 steps.
  generator: Number(env.GENERATOR_NEURON_RESERVATION || 80),
};
if (Object.values(units).some((v) => !Number.isSafeInteger(v) || v < 1))
  throw new Error('Model neuron reservations must be positive integers.');
const cacheBytes = Number(env.IMAGE_CACHE_MAX_BYTES || 64 * 1024 * 1024);
if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0)
  throw new Error('IMAGE_CACHE_MAX_BYTES must be a non-negative integer.');
const ipHeader = env.CLIENT_IP_HEADER || undefined;
const repo = new Repository(
  resolve(directory, 'game.sqlite'),
  limits.neurons,
  Date.now,
  units,
  limits,
);
const auth = new Auth(repo, env.OWNER_PASSWORD_HASH || '', origin.startsWith('https://'), ipHeader);
const usage =
  env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_TOKEN
    ? new CloudflareUsage(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ANALYTICS_TOKEN)
    : null;
repo.quota.reconcileConfigured = Boolean(usage);
let store: ImageStore | null = null,
  normalize: Normalizer | null = null,
  analyze: Analyzer | null = null,
  pipeline: Pipeline | null = null;
if (env.S3_BUCKET) {
  const { S3Store } = await import('./storage.ts');
  // Every R2 operation is metered and gated; repeat reads are served from a bounded cache.
  store = new MeteredStore(new S3Store(env), repo.quota, new ImageCache(cacheBytes));
  ({ normalize, analyze } = await import('./images.ts'));
}
if (
  store &&
  normalize &&
  env.CLOUDFLARE_ACCOUNT_ID &&
  env.CLOUDFLARE_API_TOKEN &&
  env.DESCRIPTOR_TERMS_ACCEPTED === 'true'
) {
  const api = new CloudflareAPI(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  pipeline = new Pipeline(
    repo,
    store,
    new CloudflareDescriptor(api, env.DESCRIPTOR_MODEL),
    new CloudflareGenerator(api, env.GENERATOR_MODEL),
    normalize,
    analyze,
  );
}
const server = app(repo, auth, store, pipeline, normalize, origin, { ipHeader });
server.requestTimeout = 120000;
server.headersTimeout = 10000;
const port = Number(env.PORT || 3000);
server.listen(port, env.HOST || '127.0.0.1', () =>
  console.log(`Slop or Not: ${origin}${!pipeline ? ' (generation not configured)' : ''}`),
);
let working = false,
  cleaning = false,
  reconciling = false;
// Reconcile account-wide neuron usage every five minutes (well inside GraphQL rate limits).
const reconcile = async () => {
  if (!usage || reconciling) return;
  reconciling = true;
  try {
    await repo.quota.reconcile(usage);
  } finally {
    reconciling = false;
  }
};
const reconciler = setInterval(reconcile, 5 * 60000);
void reconcile();
const work = setInterval(async () => {
  if (!pipeline || working) return;
  working = true;
  try {
    await pipeline.tick();
  } catch {
    console.error(JSON.stringify({ event: 'worker_failure' }));
  } finally {
    working = false;
  }
}, 1000);
const cleanup = setInterval(async () => {
  if (cleaning) return;
  cleaning = true;
  try {
    if (pipeline) await pipeline.cleanup();
    else repo.expire();
  } catch {
    console.error(JSON.stringify({ event: 'cleanup_failure' }));
  } finally {
    cleaning = false;
  }
}, 60000);
repo.expire();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(work);
    clearInterval(cleanup);
    clearInterval(reconciler);
    server.close(() => {
      if (!working && !cleaning && !reconciling) repo.db.close();
      process.exit(0);
    });
  });
