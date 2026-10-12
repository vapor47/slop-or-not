export interface ImageStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
// Adapters expose their provider ("AI application") name and the parameters sent with every
// request (excluding prompt and image) so the pipeline can record exactly what was called.
export type ProviderMetadata = {
  modelVersion?: string | null;
  usage?: Record<string, unknown> | null;
};
export interface ImageDescriptor {
  provider: string;
  model: string;
  params: Record<string, unknown>;
  describe(
    image: Buffer,
    prompt: string,
    model?: string,
  ): Promise<ProviderMetadata & { text: string }>;
}
export interface ImageGenerator {
  provider: string;
  model: string;
  params: Record<string, unknown>;
  // Receives the exact final prompt text only; never original bytes or an image URL.
  generate(prompt: string, model?: string): Promise<ProviderMetadata & { image: Buffer }>;
}
export type Step = 'describe' | 'generate';
export type PromptTemplate = {
  id: number;
  step: Step;
  name: string;
  version: number;
  text: string;
  created_at: number;
  active: number;
};
export type ImageMetrics = {
  width: number;
  height: number;
  dhash: string;
  brightness: number;
  contrast: number;
  sharpness: number;
  colorfulness: number;
};
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
  created?: number;
  descriptorTemplate?: number;
  generatorTemplate?: number;
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
