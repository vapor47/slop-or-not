import { createHash } from 'node:crypto';
import type {
  ImageStore,
  ImageDescriptor,
  ImageGenerator,
  ImageMetrics,
  Question,
} from './types.ts';
import { ProviderError } from './types.ts';
import { Repository } from './db.ts';
import { APP_VERSION } from './version.ts';
export type Normalizer = (bytes: Buffer, upload?: boolean) => Promise<Buffer>;
export type Analyzer = (bytes: Buffer) => Promise<ImageMetrics>;
export function hamming(a: string, b: string) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b),
    count = 0;
  for (; x; x >>= 1n) count += Number(x & 1n);
  return count;
}
export class Pipeline {
  repo: Repository;
  store: ImageStore;
  descriptor: ImageDescriptor;
  generator: ImageGenerator;
  normalize: Normalizer;
  analyze: Analyzer | null;
  constructor(
    repo: Repository,
    store: ImageStore,
    descriptor: ImageDescriptor,
    generator: ImageGenerator,
    normalize: Normalizer,
    analyze: Analyzer | null = null,
  ) {
    this.repo = repo;
    this.store = store;
    this.descriptor = descriptor;
    this.generator = generator;
    this.normalize = normalize;
    this.analyze = analyze;
  }
  // Images are deleted at expiry, so pixel metrics must be captured now. Never fails the question.
  async measure(q: Question, role: 'original' | 'generated', bytes: Buffer, run: number | null) {
    let metrics: ImageMetrics | null = null;
    try {
      if (this.analyze) metrics = await this.analyze(bytes);
    } catch {
      console.error(JSON.stringify({ event: 'metrics_failure', question: q.id, role }));
    }
    const hash = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    this.repo.saveMetrics(q, role, run, hash, metrics);
    const original = this.repo.metrics(q.id, 'original');
    if (role === 'generated' && metrics && original?.dhash)
      this.repo.track(q, { dhash_distance: hamming(String(original.dhash), metrics.dhash) });
  }
  claim(): Question | undefined {
    return this.repo.transaction(() => {
      for (const q of this.repo.list<Question>('questions')) {
        if (
          !['describe', 'generate'].includes(q.state) ||
          q.due > this.repo.now() ||
          q.lease > this.repo.now()
        )
          continue;
        try {
          this.repo.game(q.game, true);
        } catch {
          continue;
        }
        if (q.attempts >= 4) {
          q.state = 'failed';
          q.error = 'Processing was interrupted. Retry to resume.';
          q.lease = 0;
          this.repo.save('questions', q);
          this.repo.track(q, { failed_at: this.repo.now() });
          continue;
        }
        if (q.reservationDay !== this.repo.day()) {
          try {
            q.reservationDay = this.repo.reserve(this.repo.cost(q, Boolean(q.description)));
          } catch {
            continue;
          }
        }
        q.descriptorModel ??= this.descriptor.model;
        q.generatorModel ??= this.generator.model;
        if (q.descriptorTemplate === undefined || q.generatorTemplate === undefined) {
          // Questions queued before prompt templates existed use the active versions.
          q.descriptorTemplate ??= this.repo.activeTemplate('describe').id;
          q.generatorTemplate ??= this.repo.activeTemplate('generate').id;
          this.repo.track(q, {
            describe_template_id: q.descriptorTemplate,
            generate_template_id: q.generatorTemplate,
          });
        }
        q.attempts++;
        q.lease = this.repo.now() + 5 * 60000;
        this.repo.save('questions', q);
        return q;
      }
    });
  }
  async tick() {
    const q = this.claim();
    if (!q) return false;
    let run: number | null = null,
      finished: number | null = null,
      output: string | null = null,
      meta: { modelVersion?: string | null; usage?: Record<string, unknown> | null } = {};
    const step = q.state as 'describe' | 'generate';
    try {
      if (step === 'describe') {
        q.descriptorModel ??= this.descriptor.model;
        const original = await this.store.get(q.original),
          template = this.repo.template(q.descriptorTemplate!);
        if (!this.repo.metrics(q.id, 'original')) await this.measure(q, 'original', original, null);
        run = this.repo.startRun(q, {
          step,
          provider: this.descriptor.provider,
          model: q.descriptorModel,
          template: template.id,
          prompt: template.text,
          params: this.descriptor.params,
          reservedUnits: q.descriptorUnits ?? 200,
          appVersion: APP_VERSION,
        });
        const result = await this.descriptor.describe(original, template.text, q.descriptorModel);
        finished = this.repo.now();
        output = result.text;
        meta = { modelVersion: result.modelVersion, usage: result.usage };
        if (!result.text.trim())
          throw new ProviderError('The model returned an empty description.', true);
        q.description = result.text.slice(0, 1900);
        q.state = 'generate';
        q.attempts = 0;
        this.repo.track(q, { described_at: finished, describe_run_id: run });
      } else {
        // The generator receives only saved text; never original bytes or an image URL.
        q.generatorModel ??= this.generator.model;
        const template = this.repo.template(q.generatorTemplate!),
          prompt = template.text + q.description!;
        run = this.repo.startRun(q, {
          step,
          provider: this.generator.provider,
          model: q.generatorModel,
          template: template.id,
          prompt,
          params: this.generator.params,
          reservedUnits: q.generatorUnits ?? 60,
          appVersion: APP_VERSION,
        });
        const result = await this.generator.generate(prompt, q.generatorModel);
        finished = this.repo.now();
        meta = { modelVersion: result.modelVersion, usage: result.usage };
        const image = await this.normalize(result.image);
        await this.store.put(q.generated, image);
        await this.measure(q, 'generated', image, run);
        q.state = 'ready';
        q.attempts = 0;
        this.repo.track(q, { ready_at: this.repo.now(), generate_run_id: run });
      }
      q.error = null;
      q.due = this.repo.now();
      if (run !== null)
        this.repo.finishRun(run, { finished, status: 'succeeded', output, ...meta });
    } catch (error) {
      const temporary =
        error instanceof ProviderError ? error.temporary : error instanceof TypeError;
      q.error =
        error instanceof ProviderError
          ? error.message
          : 'Image processing or storage failed. Retry this question.';
      if (temporary && q.attempts < 4) q.due = this.repo.now() + 1000 * 2 ** q.attempts;
      else {
        q.state = 'failed';
        this.repo.track(q, { failed_at: this.repo.now() });
      }
      if (run !== null)
        this.repo.finishRun(run, {
          finished: finished ?? this.repo.now(),
          status: 'failed',
          errorKind: temporary ? 'temporary' : 'permanent',
          error: q.error,
          output,
          ...meta,
        });
      console.error(
        JSON.stringify({
          event: 'processing_failure',
          question: q.id,
          step,
          attempt: q.attempts,
          temporary,
        }),
      );
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
      if (q.state === 'uploading' && q.due < this.repo.now() - 10 * 60000)
        this.repo.cancelUpload(q.id);
    }
    for (const row of this.repo.db.prepare('SELECT key, delete_after FROM garbage').all()) {
      // A removed question may still have an in-flight writer. Keep the tombstone for
      // the duration of the provider timeout so a late write is deleted on a later pass.
      try {
        await this.store.delete(String(row.key));
        if (Number(row.delete_after) <= this.repo.now())
          this.repo.db.prepare('DELETE FROM garbage WHERE key=?').run(String(row.key));
      } catch {
        console.error(JSON.stringify({ event: 'cleanup_failure' }));
      }
    }
  }
}
