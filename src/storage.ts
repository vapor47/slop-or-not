import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { ImageStore } from './types.ts';
import { ProviderError } from './types.ts';
export class S3Store implements ImageStore {
  client: S3Client;
  bucket: string;
  constructor(env: NodeJS.ProcessEnv) {
    for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
      if (!env[key]) throw new Error(`Missing ${key}`);
    this.bucket = env.S3_BUCKET!;
    this.client = new S3Client({
      region: env.S3_REGION || 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
      maxAttempts: 1,
    });
  }
  async request<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      throw new ProviderError(
        'Image storage is unavailable. Retry this question.',
        !status || status === 429 || status >= 500,
      );
    }
  }
  async put(key: string, bytes: Buffer) {
    await this.request(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `slop/${key}`,
          Body: bytes,
          ContentType: 'image/jpeg',
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      ),
    );
  }
  async get(key: string) {
    const object = await this.request(() =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `slop/${key}` }), {
        abortSignal: AbortSignal.timeout(120000),
      }),
    );
    if (!object.Body) throw new Error('Empty object');
    return Buffer.from(await object.Body.transformToByteArray());
  }
  async delete(key: string) {
    await this.request(() =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `slop/${key}` }), {
        abortSignal: AbortSignal.timeout(120000),
      }),
    );
  }
}
