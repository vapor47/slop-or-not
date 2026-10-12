import type { ImageStore } from './types.ts';
import { Quota, IMAGES_UNAVAILABLE } from './quota.ts';
// Least-recently-used image bytes, bounded by total size. Hits never reach R2.
export class ImageCache {
  max: number;
  size = 0;
  items = new Map<string, Buffer>();
  constructor(max: number) {
    this.max = max;
  }
  get(key: string) {
    const value = this.items.get(key);
    if (value) {
      this.items.delete(key);
      this.items.set(key, value);
    }
    return value;
  }
  set(key: string, value: Buffer) {
    this.delete(key);
    if (value.length > this.max) return;
    this.items.set(key, value);
    this.size += value.length;
    for (const [oldest, bytes] of this.items) {
      if (this.size <= this.max) break;
      this.items.delete(oldest);
      this.size -= bytes.length;
    }
  }
  delete(key: string) {
    const value = this.items.get(key);
    if (value) {
      this.items.delete(key);
      this.size -= value.length;
    }
  }
}
// Every object operation passes the quota gate before reaching the provider. Deletes are free in
// R2 and the only way stored bytes shrink, so they are counted but never refused.
export class MeteredStore implements ImageStore {
  inner: ImageStore;
  quota: Quota;
  cache: ImageCache;
  // Concurrent misses for the same key (both images of a pair are requested at once) share one read.
  pending = new Map<string, Promise<Buffer>>();
  constructor(inner: ImageStore, quota: Quota, cache: ImageCache) {
    this.inner = inner;
    this.quota = quota;
    this.cache = cache;
  }
  async put(key: string, bytes: Buffer) {
    this.quota.reservePut(key, bytes.length);
    await this.inner.put(key, bytes);
    this.cache.set(key, bytes);
  }
  async get(key: string) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.pending.get(key);
    if (pending) return pending;
    this.quota.reserve('r2_class_b', 1, IMAGES_UNAVAILABLE);
    const read = this.inner
      .get(key)
      .then((bytes) => {
        this.cache.set(key, bytes);
        return bytes;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, read);
    return read;
  }
  async delete(key: string) {
    this.cache.delete(key);
    this.quota.reserve('r2_free', 1, '');
    await this.inner.delete(key);
    this.quota.forget(key);
  }
}
