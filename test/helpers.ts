import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/db.ts';
import type { ImageStore, ImageDescriptor, ImageGenerator } from '../src/types.ts';
export function fixture(budget = 10000) {
  let time = Date.UTC(2026, 9, 12, 12);
  const dir = mkdtempSync(join(tmpdir(), 'slop-test-'));
  const repo = new Repository(join(dir, 'test.sqlite'), budget, () => time);
  const close = () => {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const store: ImageStore & { files: Map<string, Buffer> } = {
    files: new Map(),
    async put(k, b) {
      this.files.set(k, b);
    },
    async get(k) {
      const b = this.files.get(k);
      if (!b) throw new Error('not found');
      return b;
    },
    async delete(k) {
      this.files.delete(k);
    },
  };
  return {
    repo,
    store,
    dir,
    close,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
export function fakeDescriptor(
  describe: (image: Buffer, prompt: string) => Promise<string>,
  model = 'd',
): ImageDescriptor {
  return {
    provider: 'test-ai',
    model,
    params: { temperature: 0 },
    async describe(image, prompt) {
      return { text: await describe(image, prompt) };
    },
  };
}
export function fakeGenerator(
  generate: (prompt: string) => Promise<Buffer>,
  model = 'g',
): ImageGenerator {
  return {
    provider: 'test-ai',
    model,
    params: { steps: 1 },
    async generate(prompt) {
      return { image: await generate(prompt) };
    },
  };
}
export function ready(repo: Repository, count = 2) {
  const game = repo.create('Test game');
  for (let i = 0; i < count; i++) {
    const q = repo.acceptUpload(game.id);
    q.state = 'ready';
    repo.save('questions', q);
  }
  return repo.publish(game.id);
}
