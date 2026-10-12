import type { ImageStore, ImageDescriptor, ImageGenerator, Question } from './types.ts';
import { ProviderError } from './types.ts';
import { Repository } from './db.ts';
export type Normalizer = (bytes: Buffer, upload?: boolean) => Promise<Buffer>;
export class Pipeline {
  repo: Repository; store: ImageStore; descriptor: ImageDescriptor; generator: ImageGenerator; normalize: Normalizer;
  constructor(repo: Repository, store: ImageStore, descriptor: ImageDescriptor, generator: ImageGenerator, normalize: Normalizer) { this.repo = repo; this.store = store; this.descriptor = descriptor; this.generator = generator; this.normalize = normalize; }
  claim(): Question | undefined {
    return this.repo.transaction(() => {
      for (const q of this.repo.list<Question>('questions')) {
        if (!['describe', 'generate'].includes(q.state) || q.due > this.repo.now() || q.lease > this.repo.now()) continue;
        try { this.repo.game(q.game, true); } catch { continue; }
        if (q.attempts >= 4) { q.state = 'failed'; q.error = 'Processing was interrupted. Retry to resume.'; q.lease = 0; this.repo.save('questions', q); continue; }
        if (q.reservationDay !== this.repo.day()) {
          try { q.reservationDay = this.repo.reserve(this.repo.cost(q, Boolean(q.description))); }
          catch { continue; }
        }
        q.descriptorModel ??= this.descriptor.model; q.generatorModel ??= this.generator.model;
        q.attempts++; q.lease = this.repo.now() + 5 * 60000; this.repo.save('questions', q); return q;
      }
    });
  }
  async tick() {
    const q = this.claim(); if (!q) return false;
    try {
      if (q.state === 'describe') {
        q.descriptorModel ??= this.descriptor.model;
        q.description = await this.descriptor.describe(await this.store.get(q.original), q.descriptorModel);
        if (!q.description.trim()) throw new ProviderError('The model returned an empty description.', true);
        q.description = q.description.slice(0, 1900); q.state = 'generate'; q.attempts = 0;
      } else {
        // The generator receives only saved text; never original bytes or an image URL.
        q.generatorModel ??= this.generator.model;
        const image = await this.normalize(await this.generator.generate(q.description!, q.generatorModel));
        await this.store.put(q.generated, image); q.state = 'ready'; q.attempts = 0;
      }
      q.error = null; q.due = this.repo.now();
    } catch (error) {
      const temporary = error instanceof ProviderError ? error.temporary : error instanceof TypeError;
      q.error = error instanceof ProviderError ? error.message : 'Image processing or storage failed. Retry this question.';
      if (temporary && q.attempts < 4) q.due = this.repo.now() + 1000 * 2 ** q.attempts;
      else q.state = 'failed';
      console.error(JSON.stringify({ event: 'processing_failure', question: q.id, step: q.description ? 'generate' : 'describe', attempt: q.attempts, temporary }));
    }
    q.lease = 0;
    this.repo.transaction(() => {
      const existing = this.repo.get<Question>('questions', q.id);
      if (existing && existing.lease > 0) this.repo.save('questions', q);
      else for (const key of [q.original, q.generated]) this.repo.garbage(key);
    });
    return true;
  }
  async cleanup() {
    this.repo.expire();
    for (const q of this.repo.list<Question>('questions')) {
      if (q.state === 'uploading' && q.due < this.repo.now() - 10 * 60000) this.repo.cancelUpload(q.id);
    }
    for (const row of this.repo.db.prepare('SELECT key, delete_after FROM garbage').all()) {
      // A removed question may still have an in-flight writer. Keep the tombstone for
      // the duration of the provider timeout so a late write is deleted on a later pass.
      try {
        await this.store.delete(String(row.key));
        if (Number(row.delete_after) <= this.repo.now()) this.repo.db.prepare('DELETE FROM garbage WHERE key=?').run(String(row.key));
      }
      catch { console.error(JSON.stringify({ event: 'cleanup_failure' })); }
    }
  }
}
