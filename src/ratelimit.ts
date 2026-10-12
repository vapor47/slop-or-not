import type { IncomingMessage } from 'node:http';
import type { Repository } from './db.ts';
import { HttpError } from './types.ts';
// Requests per minute. Each guest question loads two images; retries and replays add a few more.
export const RATE_LIMITS = {
  image: { ip: 240, play: 80 },
  start: { ip: 20, invite: 60 },
  play: { ip: 120, play: 60 },
  invite: { ip: 60 },
};
export type RateLimits = typeof RATE_LIMITS;
// Behind a proxy or Cloudflare Tunnel every request shares the proxy's address, so the trusted
// client-IP header must be named explicitly. It is spoofable when the app is exposed directly.
export function clientIp(req: IncomingMessage, header?: string) {
  const value = header ? req.headers[header.toLowerCase()] : undefined;
  if (typeof value === 'string' && value.trim()) return value.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
// Fixed one-minute windows in SQLite, like login_limits; expired rows are pruned by expire().
export function limit(repo: Repository, bucket: string, max: number, windowMs = 60000) {
  const now = repo.now(),
    row = repo.db.prepare('SELECT count, expires FROM rate_limits WHERE bucket=?').get(bucket);
  const active = row && Number(row.expires) > now;
  if (active && Number(row.count) >= max)
    throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
  repo.db
    .prepare('INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)')
    .run(bucket, active ? Number(row.count) + 1 : 1, active ? Number(row.expires) : now + windowMs);
}
