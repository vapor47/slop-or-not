export interface ImageStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export interface ImageDescriptor {
  model: string;
  describe(image: Buffer, model?: string): Promise<string>;
}
export interface ImageGenerator {
  model: string;
  generate(description: string, model?: string): Promise<Buffer>;
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class ProviderError extends Error {
  temporary: boolean;
  constructor(message: string, temporary: boolean) {
    super(message);
    this.temporary = temporary;
  }
}
export type Question = {
  id: string;
  game: string;
  original: string;
  generated: string;
  state: 'uploading' | 'describe' | 'generate' | 'ready' | 'failed';
  description: string | null;
  error: string | null;
  attempts: number;
  manualRetries: number;
  due: number;
  lease: number;
  reservationDay: string;
  descriptorModel?: string;
  generatorModel?: string;
  descriptorUnits?: number;
  generatorUnits?: number;
};
export type Game = {
  id: string;
  title: string;
  created: number;
  published: number | null;
  invite: string | null;
  deleted: boolean;
};
export type Play = {
  id: string;
  game: string;
  questions: { id: string; ai: number; chosen: number | null }[];
  current: number;
  created: number;
};
