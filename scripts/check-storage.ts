import { randomBytes } from 'node:crypto';
import { S3Store } from '../src/storage.ts';
const store = new S3Store(process.env);
const key = `setup-check-${randomBytes(16).toString('hex')}`;
const bytes = Buffer.from('Slop or Not storage connection check');
let wrote = false;
try {
  await store.put(key, bytes); wrote = true;
  const fetched = await store.get(key);
  if (!fetched.equals(bytes)) throw new Error('Stored content did not match.');
  await store.delete(key); wrote = false;
  console.log('Storage check passed: uploaded, read, and deleted a temporary object.');
} catch {
  console.error('Storage check failed. Check S3 endpoint, bucket name, region, and Object Read & Write credentials. No credentials were printed.');
  process.exitCode = 1;
} finally {
  if (wrote) {
    try { await store.delete(key); }
    catch { console.error(`Temporary object may remain at slop/${key}; remove it in your bucket dashboard.`); }
  }
}
