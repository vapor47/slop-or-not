import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './types.ts';
// Free allowances, verified 2026-10-12 against:
//   https://developers.cloudflare.com/workers-ai/platform/pricing/  (10,000 neurons/day)
//   https://developers.cloudflare.com/r2/pricing/  (10 GB-month, 1M Class A, 10M Class B per month)
// GB is treated as decimal (10^9 bytes), the smaller reading. DeleteObject is a free operation.
export const ALLOWANCES = {
  neurons: 10_000,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  storedBytes: 10_000_000_000,
};
export const CAP_RATIO = 0.8;
export type Limits = {
  neurons: number;
  r2ClassA: number;
  r2ClassB: number;
  storedBytes: number;
  liveGames: number;
  liveQuestions: number;
  // Day of month (1–28) the R2 allowance period starts; Cloudflare does not document whether it
  // follows the calendar month or the billing cycle, so set this to the account's billing day.
  billingDay: number;
};
export const DEFAULT_LIMITS: Limits = {
  neurons: ALLOWANCES.neurons * CAP_RATIO,
  r2ClassA: ALLOWANCES.r2ClassA * CAP_RATIO,
  r2ClassB: ALLOWANCES.r2ClassB * CAP_RATIO,
  storedBytes: ALLOWANCES.storedBytes * CAP_RATIO,
  liveGames: 50,
  liveQuestions: 500,
  billingDay: 1,
};
// Upper bound for one normalized 768×768 JPEG, used to check headroom before generating.
export const IMAGE_ESTIMATE = 2 * 1024 * 1024;
export const IMAGES_UNAVAILABLE = 'Images are temporarily unavailable. Please try again later.';
export const NEURONS_EXHAUSTED = 'Generation budget exhausted. Try again after midnight UTC.';
// Reconciled usage older than this is reported as stale.
const STALE = 15 * 60000;
// Analytics ingestion delay: local calls this long before a reconciliation started may be
// missing from Cloudflare's figure, so they are added on top (double counting is safe).
const ANALYTICS_LAG = 10 * 60000;
export type Metric = 'neurons' | 'r2_class_a' | 'r2_class_b' | 'r2_free';
export class QuotaError extends HttpError {}
export type Reconciliation = {
  day: string;
  neurons: number | null;
  checkedAt: number;
  succeededAt: number | null;
  // When the successful query started; local calls since (asOf − lag) are added on top.
  asOf: number | null;
  error: boolean;
};
export class Quota {
  db: DatabaseSync;
  now: () => number;
  limits: Limits;
  reconcileConfigured = false;
  constructor(db: DatabaseSync, now: () => number, limits: Limits) {
    this.db = db;
    this.now = now;
    this.limits = limits;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quota_usage(metric TEXT NOT NULL, period TEXT NOT NULL,
        used INTEGER NOT NULL, PRIMARY KEY(metric, period));
      CREATE TABLE IF NOT EXISTS stored_objects(key TEXT PRIMARY KEY, bytes INTEGER NOT NULL,
        stored_at INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS neuron_calls(at INTEGER NOT NULL, day TEXT NOT NULL,
        units INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS neuron_calls_day ON neuron_calls(day, at);`);
    // Only the app process writes objects; puts in flight before a restart are over. Their
    // (larger) reservations stay until a later confirmed put or delete.
    this.db.exec('UPDATE stored_objects SET pending=0 WHERE pending>0');
  }
  // Joins an enclosing transaction (acceptUpload, retry, claim) or opens its own.
  atomic<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
  // Start date of the current R2 allowance period, anchored on limits.billingDay (UTC).
  month() {
    const d = new Date(this.now());
    const year = d.getUTCFullYear();
    let month = d.getUTCMonth();
    if (d.getUTCDate() < this.limits.billingDay) month--;
    return new Date(Date.UTC(year, month, this.limits.billingDay)).toISOString().slice(0, 10);
  }
  period(metric: Metric) {
    return metric === 'neurons' ? this.day() : this.month();
  }
  cap(metric: Metric) {
    return metric === 'neurons'
      ? this.limits.neurons
      : metric === 'r2_class_a'
        ? this.limits.r2ClassA
        : metric === 'r2_class_b'
          ? this.limits.r2ClassB
          : Infinity;
  }
  used(metric: Metric, period = this.period(metric)) {
    const row = this.db
      .prepare('SELECT used FROM quota_usage WHERE metric=? AND period=?')
      .get(metric, period);
    return Number(row?.used || 0);
  }
  // A single guarded UPDATE, so concurrent connections can never exceed the cap together.
  reserve(metric: Metric, amount: number, message: string, status = 503) {
    const period = this.period(metric);
    if (metric === 'neurons') {
      // Account-wide usage plus every local reservation not yet spent must leave room.
      const account = this.accountNeurons();
      if (account !== null && account + this.outstanding() + amount > this.limits.neurons)
        throw new QuotaError(429, NEURONS_EXHAUSTED);
    }
    this.db.prepare('INSERT OR IGNORE INTO quota_usage VALUES(?,?,0)').run(metric, period);
    const cap = this.cap(metric);
    const result = Number.isFinite(cap)
      ? this.db
          .prepare('UPDATE quota_usage SET used=used+? WHERE metric=? AND period=? AND used+?<=?')
          .run(amount, metric, period, amount, cap)
      : this.db
          .prepare('UPDATE quota_usage SET used=used+? WHERE metric=? AND period=?')
          .run(amount, metric, period);
    if (!result.changes) throw new QuotaError(status, message);
    return period;
  }
  release(metric: Metric, period: string, amount: number) {
    this.db
      .prepare('UPDATE quota_usage SET used=MAX(0,used-?) WHERE metric=? AND period=?')
      .run(amount, metric, period);
  }
  storedBytes() {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM stored_objects').get();
    return Number(row?.total || 0);
  }
  // Reserves one Class A operation and max(existing, new) bytes before an upload: until the put is
  // confirmed, R2 may still hold the previous (possibly larger) object. Returns a ticket for
  // confirmPut/failPut. A failed put keeps the larger figure (over-counting is safe).
  reservePut(key: string, bytes: number) {
    return this.atomic(() => {
      if (this.setting('storage_read_only'))
        throw new QuotaError(503, 'Image storage is read-only right now. Try again later.');
      const row = this.db.prepare('SELECT bytes, pending FROM stored_objects WHERE key=?').get(key),
        existing = Number(row?.bytes || 0);
      const reserved = Math.max(existing, bytes);
      if (this.storedBytes() - existing + reserved > this.limits.storedBytes)
        throw new QuotaError(
          503,
          'Image storage is full. Remove games or wait for them to expire.',
        );
      this.reserve('r2_class_a', 1, 'Image uploads are paused until the storage allowance resets.');
      this.db
        .prepare(
          `INSERT INTO stored_objects(key,bytes,stored_at,pending,seq) VALUES(?,?,?,1,1)
          ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes, stored_at=excluded.stored_at,
          pending=pending+1, seq=seq+1`,
        )
        .run(key, reserved, this.now());
      return {
        seq: Number(this.db.prepare('SELECT seq FROM stored_objects WHERE key=?').get(key)!.seq),
        // Another put to this key was already in flight, so the final object is unknown.
        overlapped: Number(row?.pending || 0) > 0,
      };
    });
  }
  // Shrinks to the confirmed size only when no other put to the key overlapped this one, since the
  // final object is otherwise unknown. A missing row (deleted meanwhile) is re-recorded.
  confirmPut(key: string, bytes: number, ticket: { seq: number; overlapped: boolean }) {
    this.atomic(() => {
      const row = this.db.prepare('SELECT pending, seq FROM stored_objects WHERE key=?').get(key);
      if (!row) {
        this.db
          .prepare('INSERT INTO stored_objects(key,bytes,stored_at) VALUES(?,?,?)')
          .run(key, bytes, this.now());
        return;
      }
      const alone =
        !ticket.overlapped && Number(row.pending) === 1 && Number(row.seq) === ticket.seq;
      this.db
        .prepare(
          `UPDATE stored_objects SET pending=MAX(0,pending-1)${alone ? ', bytes=?' : ''} WHERE key=?`,
        )
        .run(...(alone ? [bytes, key] : [key]));
    });
  }
  failPut(key: string) {
    this.db.prepare('UPDATE stored_objects SET pending=MAX(0,pending-1) WHERE key=?').run(key);
  }
  // After a successful delete. A put still in flight may land afterwards, so its row is kept.
  forget(key: string) {
    this.db.prepare('DELETE FROM stored_objects WHERE key=? AND pending=0').run(key);
  }
  setting(key: 'generation_disabled' | 'storage_read_only') {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row?.value === '1';
  }
  setSwitch(key: 'generation_disabled' | 'storage_read_only', on: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, on ? '1' : '0');
  }
  reconciliation(): Reconciliation | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='neuron_reconciliation'")
      .get();
    return row ? JSON.parse(String(row.value)) : null;
  }
  // Account-wide neurons used today according to Cloudflare, if reconciled today.
  actualNeurons() {
    const r = this.reconciliation();
    return r && r.day === this.day() ? r.neurons : null;
  }
  // Conservative account-wide usage: Cloudflare's last figure plus local calls since it was taken.
  accountNeurons() {
    const r = this.reconciliation();
    if (!r || r.day !== this.day() || r.neurons === null) return null;
    const row = this.db
      .prepare('SELECT COALESCE(SUM(units),0) AS n FROM neuron_calls WHERE day=? AND at>=?')
      .get(r.day, (r.asOf ?? r.checkedAt) - ANALYTICS_LAG);
    return r.neurons + Number(row?.n || 0);
  }
  spentToday() {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(units),0) AS n FROM neuron_calls WHERE day=?')
      .get(this.day());
    return Number(row?.n || 0);
  }
  // Today's reservations not yet consumed by a model call.
  outstanding() {
    return Math.max(0, this.used('neurons') - this.spentToday());
  }
  // Checked and recorded immediately before every model call, including calls for questions
  // reserved earlier, so queued work cannot start without headroom for that call.
  spend(units: number) {
    this.atomic(() => {
      if (this.setting('generation_disabled'))
        throw new QuotaError(503, 'Generation is paused by the owner.');
      const account = this.accountNeurons();
      if (account !== null && account + units > this.limits.neurons)
        throw new QuotaError(429, NEURONS_EXHAUSTED);
      this.db.prepare('INSERT INTO neuron_calls VALUES(?,?,?)').run(this.now(), this.day(), units);
    });
  }
  recordReconciliation(day: string, neurons: number | null, asOf = this.now()) {
    const previous = this.reconciliation();
    const value: Reconciliation =
      neurons === null
        ? {
            day,
            // A failed check keeps today's last known figure so a hard stop is not lifted.
            neurons: previous?.day === day ? previous.neurons : null,
            checkedAt: this.now(),
            succeededAt: previous?.succeededAt ?? null,
            asOf: previous?.day === day ? (previous.asOf ?? null) : null,
            error: true,
          }
        : { day, neurons, checkedAt: this.now(), succeededAt: this.now(), asOf, error: false };
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES('neuron_reconciliation',?)")
      .run(JSON.stringify(value));
  }
  async reconcile(source: { neuronsUsed(start: Date, end: Date): Promise<number> }) {
    const day = this.day(),
      asOf = this.now(),
      start = new Date(`${day}T00:00:00Z`);
    try {
      const neurons = await source.neuronsUsed(start, new Date(start.getTime() + 86400000));
      this.recordReconciliation(day, Math.ceil(neurons), asOf);
      return true;
    } catch {
      this.recordReconciliation(day, null);
      console.error(JSON.stringify({ event: 'reconciliation_failure' }));
      return false;
    }
  }
  reconciliationStatus() {
    if (!this.reconcileConfigured) return 'not_configured';
    const r = this.reconciliation();
    if (r?.error) return 'failed';
    if (!r?.succeededAt || this.now() - r.succeededAt > STALE) return 'stale';
    return 'ok';
  }
  // Reason new AI calls must not start, or null.
  generationBlocked() {
    if (this.setting('generation_disabled')) return 'Generation is paused by the owner.';
    const account = this.accountNeurons();
    if (account !== null && account >= this.limits.neurons)
      return 'The daily AI allowance has been reached. Generation resumes after midnight UTC.';
    return null;
  }
  // Reason new objects (of the given total size) cannot be stored, or null.
  storageBlocked(bytes: number, puts = 1) {
    if (this.setting('storage_read_only')) return 'Image storage is read-only right now.';
    if (this.used('r2_class_a') + puts > this.limits.r2ClassA)
      return 'Image uploads are paused until the storage allowance resets.';
    if (this.storedBytes() + bytes > this.limits.storedBytes)
      return 'Image storage is full. Remove games or wait for them to expire.';
    return null;
  }
  liveGames() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM games WHERE json_extract(data,'$.deleted')=0")
      .get();
    return Number(row?.n || 0);
  }
  liveQuestions() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM questions').get()?.n || 0);
  }
  usage() {
    const day = this.day(),
      month = this.month(),
      monthResets = (() => {
        const d = new Date(`${month}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 1);
        return d.toISOString().slice(0, 10);
      })();
    const counters = [
      {
        id: 'neurons',
        label: 'Workers AI neurons reserved today',
        used: this.used('neurons', day),
        cap: this.limits.neurons,
        allowance: ALLOWANCES.neurons,
        resets: `${day} 24:00 UTC`,
      },
      {
        id: 'r2_class_a',
        label: 'R2 Class A operations (writes) this period',
        used: this.used('r2_class_a', month),
        cap: this.limits.r2ClassA,
        allowance: ALLOWANCES.r2ClassA,
        resets: monthResets,
      },
      {
        id: 'r2_class_b',
        label: 'R2 Class B operations (reads) this period',
        used: this.used('r2_class_b', month),
        cap: this.limits.r2ClassB,
        allowance: ALLOWANCES.r2ClassB,
        resets: monthResets,
      },
      {
        id: 'stored_bytes',
        label: 'R2 stored bytes',
        used: this.storedBytes(),
        cap: this.limits.storedBytes,
        allowance: ALLOWANCES.storedBytes,
        resets: null,
      },
      {
        id: 'live_games',
        label: 'Live games',
        used: this.liveGames(),
        cap: this.limits.liveGames,
        allowance: null,
        resets: null,
      },
      {
        id: 'live_questions',
        label: 'Live questions',
        used: this.liveQuestions(),
        cap: this.limits.liveQuestions,
        allowance: null,
        resets: null,
      },
    ];
    const r = this.reconciliation(),
      actual = this.accountNeurons();
    if (actual !== null)
      counters.splice(1, 0, {
        id: 'neurons_actual',
        label: 'Workers AI neurons used today (Cloudflare account-wide + recent local calls)',
        used: actual,
        cap: this.limits.neurons,
        allowance: ALLOWANCES.neurons,
        resets: `${day} 24:00 UTC`,
      });
    const status = this.reconciliationStatus(),
      warnings: string[] = [];
    if (status === 'not_configured')
      warnings.push(
        'Neuron usage is estimated locally; set CLOUDFLARE_ANALYTICS_TOKEN to reconcile with Cloudflare.',
      );
    else if (status !== 'ok')
      warnings.push('Neuron reconciliation with Cloudflare is failing; using local estimates.');
    return {
      counters,
      deletes: this.used('r2_free', month),
      switches: {
        generationDisabled: this.setting('generation_disabled'),
        storageReadOnly: this.setting('storage_read_only'),
      },
      reconciliation: { status, checkedAt: r?.checkedAt ?? null },
      generationBlocked: this.generationBlocked(),
      warnings,
    };
  }
  // Public summary for /health: names only, no figures or secrets.
  health() {
    const { counters, switches } = this.usage();
    return {
      nearLimit: counters.filter((c) => c.used >= c.cap * 0.9).map((c) => c.id),
      reconciliation: this.reconciliationStatus(),
      generationPaused: Boolean(this.generationBlocked()),
      storageReadOnly: switches.storageReadOnly,
    };
  }
}
// Caps come from the environment but may only be lowered: anything above 80% of a free allowance
// is rejected at startup.
export function limitsFromEnv(env: NodeJS.ProcessEnv): Limits {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] ? Number(env[name]) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const d = DEFAULT_LIMITS;
  return {
    neurons: read('DAILY_NEURON_BUDGET', d.neurons, 1, d.neurons),
    r2ClassA: read('R2_CLASS_A_MONTHLY_CAP', d.r2ClassA, 1, d.r2ClassA),
    r2ClassB: read('R2_CLASS_B_MONTHLY_CAP', d.r2ClassB, 1, d.r2ClassB),
    storedBytes: read('R2_STORED_BYTES_CAP', d.storedBytes, 1, d.storedBytes),
    liveGames: read('MAX_LIVE_GAMES', d.liveGames, 1, 10_000),
    liveQuestions: read('MAX_LIVE_QUESTIONS', d.liveQuestions, 1, 100_000),
    billingDay: read('R2_BILLING_DAY', d.billingDay, 1, 28),
  };
}
