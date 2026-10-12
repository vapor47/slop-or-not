// SQLite snapshot + R2 (S3-compatible) helper for deploy/backup.sh and deploy/restore.sh.
// Lives in deploy/ so it resolves @aws-sdk/client-s3 from the app's node_modules.
// Run with: node --env-file=/etc/slop-or-not/app.env deploy/backup-tool.mjs <command> ...
//
//   snapshot <db> <out.sqlite.gz>  online backup (includes committed WAL pages), verify, gzip
//   verify <file[.gz]>             integrity_check + per-table row counts
//   upload <file>                  PutObject to <prefix>game-<UTC timestamp>.sqlite.gz
//   prune <keep>                   delete all but the newest <keep> backups
//   list                           newest first: key, bytes, last modified
//   fetch <key|latest> <out>       download a backup
//
// Credentials: BACKUP_S3_* overrides, falling back to the app's S3_* settings.
// Prefix: BACKUP_PREFIX (default "backups/"). It must stay outside "slop/", which
// the app's 15-day lifecycle rule and image cleanup own.
//
// TODO(phase-g-quota): route these R2 operations through the app's quota gate
// (Class A: put/list/delete, Class B: get, stored bytes) once the ledger lands.
// Until then usage is bounded by design: one daily run = 1 put + 1 list + at most
// a few deletes (~100 Class A ops/month) and BACKUP_KEEP compressed copies stored.
import { backup, DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rm, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const prefix = env.BACKUP_PREFIX || 'backups/';
if (!prefix.endsWith('/') || prefix.startsWith('slop/'))
  throw new Error('BACKUP_PREFIX must end with "/" and must not be under "slop/".');

async function s3() {
  const { S3Client, ...commands } = await import('@aws-sdk/client-s3');
  const get = (key) => env[`BACKUP_${key}`] || env[key];
  for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
    if (!get(key)) throw new Error(`Missing ${key} (or BACKUP_${key})`);
  const client = new S3Client({
    region: get('S3_REGION') || 'auto',
    endpoint: get('S3_ENDPOINT') || undefined,
    forcePathStyle: get('S3_FORCE_PATH_STYLE') === 'true',
    credentials: {
      accessKeyId: get('S3_ACCESS_KEY_ID'),
      secretAccessKey: get('S3_SECRET_ACCESS_KEY'),
    },
  });
  return { client, bucket: get('S3_BUCKET'), ...commands };
}

async function gunzipTo(file) {
  if (!file.endsWith('.gz')) return { path: file, cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'slop-verify-'));
  const path = join(dir, 'game.sqlite');
  await pipeline(createReadStream(file), createGunzip(), createWriteStream(path));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function check(path) {
  const db = new DatabaseSync(path);
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || Object.values(result[0])[0] !== 'ok')
      throw new Error(`integrity_check failed: ${JSON.stringify(result).slice(0, 500)}`);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    if (!tables.length) throw new Error('database has no tables');
    const counts = {};
    for (const t of tables)
      counts[t] = db.prepare(`SELECT count(*) AS n FROM "${t.replaceAll('"', '""')}"`).get().n;
    return counts;
  } finally {
    db.close();
  }
}

async function listBackups() {
  const { client, bucket, ListObjectsV2Command } = await s3();
  const items = [];
  let ContinuationToken;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}game-`, ContinuationToken }),
    );
    for (const o of page.Contents || []) items.push(o);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  // Keys embed a sortable UTC timestamp, so key order is age order.
  return items.sort((a, b) => (a.Key < b.Key ? 1 : -1));
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'snapshot': {
    const [db, out] = args;
    if (!db || !out) throw new Error('usage: snapshot <db> <out.sqlite.gz>');
    const dir = await mkdtemp(join(tmpdir(), 'slop-backup-'));
    try {
      const copy = join(dir, 'game.sqlite');
      const source = new DatabaseSync(db);
      try {
        // SQLite online backup API: a consistent copy, including WAL content,
        // taken while the app keeps running.
        await backup(source, copy);
      } finally {
        source.close();
      }
      const counts = check(copy);
      await pipeline(createReadStream(copy), createGzip({ level: 9 }), createWriteStream(out));
      console.log(
        JSON.stringify({ event: 'backup_snapshot', bytes: (await stat(out)).size, counts }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    break;
  }
  case 'verify': {
    const { path, cleanup } = await gunzipTo(args[0]);
    try {
      console.log(JSON.stringify({ event: 'backup_verified', counts: check(path) }));
    } finally {
      await cleanup();
    }
    break;
  }
  case 'upload': {
    const { client, bucket, PutObjectCommand } = await s3();
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const key = `${prefix}game-${stamp}.sqlite.gz`;
    // Small file: a single PutObject (1 Class A op) rather than a multipart upload.
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await readFile(args[0]),
        ContentType: 'application/gzip',
      }),
    );
    console.log(JSON.stringify({ event: 'backup_uploaded', key }));
    break;
  }
  case 'prune': {
    const keep = Number(args[0]);
    if (!Number.isSafeInteger(keep) || keep < 3) throw new Error('prune: keep must be >= 3');
    const { client, bucket, DeleteObjectCommand } = await s3();
    const old = (await listBackups()).slice(keep);
    for (const o of old) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
    console.log(JSON.stringify({ event: 'backup_pruned', deleted: old.map((o) => o.Key) }));
    break;
  }
  case 'list': {
    for (const o of await listBackups())
      console.log(`${o.Key}\t${o.Size}\t${o.LastModified?.toISOString()}`);
    break;
  }
  case 'fetch': {
    let [key, out] = args;
    if (!key || !out) throw new Error('usage: fetch <key|latest> <out>');
    if (key === 'latest') {
      key = (await listBackups())[0]?.Key;
      if (!key) throw new Error(`no backups under ${prefix}`);
    }
    const { client, bucket, GetObjectCommand } = await s3();
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await writeFile(out, await object.Body.transformToByteArray());
    console.error(`fetched ${key}`);
    break;
  }
  default:
    console.error('usage: backup-tool.mjs snapshot|verify|upload|prune|list|fetch ...');
    process.exitCode = 2;
}
