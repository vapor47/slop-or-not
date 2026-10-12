import { scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Repository, token } from './db.ts';
import { HttpError } from './types.ts';
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function cookies(req: IncomingMessage) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
}
export class Auth {
  repo: Repository; passwordHash: string; secure: boolean;
  constructor(repo: Repository, passwordHash: string, secure: boolean) { this.repo = repo; this.passwordHash = passwordHash; this.secure = secure; }
  owner(req: IncomingMessage) {
    const cookie = cookies(req).owner;
    const row = cookie ? this.repo.db.prepare('SELECT expires FROM sessions WHERE id=?').get(hashToken(cookie)) : undefined;
    if (!row || Number(row.expires) <= this.repo.now()) throw new HttpError(401, 'Sign in to create games.');
  }
  login(req: IncomingMessage, res: ServerResponse, password: string) {
    const ip = req.socket.remoteAddress || 'unknown';
    const row = this.repo.db.prepare('SELECT count, expires FROM login_limits WHERE ip=?').get(ip);
    if (row && Number(row.expires) > this.repo.now() && Number(row.count) >= 10) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
    this.repo.db.prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?)').run(ip, row && Number(row.expires) > this.repo.now() ? Number(row.count) + 1 : 1, this.repo.now() + 15 * 60000);
    const [salt, encoded] = this.passwordHash.split(':');
    const expected = Buffer.from(encoded || '', 'hex'), actual = scryptSync(password, salt, 64);
    if (expected.length !== 64 || !timingSafeEqual(expected, actual)) throw new HttpError(401, 'Incorrect password.');
    const id = token(); this.repo.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hashToken(id), this.repo.now() + 86400000);
    res.setHeader('Set-Cookie', `owner=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${this.secure ? '; Secure' : ''}`);
  }
  logout(req: IncomingMessage, res: ServerResponse) {
    if (cookies(req).owner) this.repo.db.prepare('DELETE FROM sessions WHERE id=?').run(hashToken(cookies(req).owner));
    res.setHeader('Set-Cookie', `owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? '; Secure' : ''}`);
  }
}
