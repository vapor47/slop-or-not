import { ProviderError } from './types.ts';
export class CloudflareAPI {
  account: string;
  secret: string;
  constructor(account: string, secret: string) {
    this.account = account;
    this.secret = secret;
  }
  async run(model: string, input: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.account)}/ai/run/${model}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(120000),
        },
      );
    } catch {
      throw new ProviderError('The model request timed out or could not connect.', true);
    }
    if (!response.ok)
      throw new ProviderError(
        response.status === 429
          ? 'Cloudflare capacity is exhausted. Retry later.'
          : 'Cloudflare rejected the request. Check model access and credentials.',
        response.status === 429 || response.status >= 500 || response.status === 408,
      );
    const json = (await response.json()) as { success: boolean; result: Record<string, unknown> };
    if (!json.success || !json.result)
      throw new ProviderError('Cloudflare returned an unsuccessful response.', true);
    return json.result;
  }
}
// Workers AI does not report a model version; model ids are recorded exactly as sent.
export class CloudflareGenerator {
  provider = 'cloudflare-workers-ai';
  api: CloudflareAPI;
  model: string;
  params = { steps: 4 };
  constructor(api: CloudflareAPI, model = '@cf/black-forest-labs/flux-1-schnell') {
    this.api = api;
    this.model = model;
  }
  async generate(prompt: string, model = this.model) {
    // Fail loudly rather than truncating, so the recorded prompt is always the text sent.
    if (prompt.length > 2048)
      throw new ProviderError('The generator prompt exceeds 2048 characters.', false);
    const result = await this.api.run(model, { prompt, ...this.params });
    if (typeof result.image !== 'string' || !result.image)
      throw new ProviderError('The model returned no image.', true);
    return { image: Buffer.from(result.image, 'base64'), modelVersion: null };
  }
}
export class CloudflareDescriptor {
  provider = 'cloudflare-workers-ai';
  api: CloudflareAPI;
  model: string;
  params = { max_tokens: 350, temperature: 0.2 };
  constructor(api: CloudflareAPI, model = '@cf/meta/llama-3.2-11b-vision-instruct') {
    this.api = api;
    this.model = model;
  }
  async describe(image: Buffer, prompt: string, model = this.model) {
    const result = await this.api.run(model, { prompt, image: [...image], ...this.params });
    if (typeof result.response !== 'string' || !result.response.trim())
      throw new ProviderError('The descriptor returned no description.', true);
    return {
      text: result.response.trim(),
      modelVersion: null,
      usage:
        result.usage && typeof result.usage === 'object'
          ? (result.usage as Record<string, unknown>)
          : null,
    };
  }
}
// Account-wide Workers AI usage from the GraphQL Analytics API (dataset aiInferenceAdaptiveGroups,
// sum.totalNeurons). Needs a separate read-only token with "Account Analytics: Read".
export const NEURONS_QUERY = `query Neurons($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    aiInferenceAdaptiveGroups(limit: 10, filter: { datetime_geq: $start, datetime_lt: $end }) {
      sum { totalNeurons }
    }
  } }
}`;
export class CloudflareUsage {
  account: string;
  secret: string;
  fetch: typeof fetch;
  constructor(account: string, secret: string, fetcher: typeof fetch = fetch) {
    this.account = account;
    this.secret = secret;
    this.fetch = fetcher;
  }
  async neuronsUsed(start: Date, end: Date) {
    const response = await this.fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: NEURONS_QUERY,
        variables: { account: this.account, start: start.toISOString(), end: end.toISOString() },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Analytics request failed (${response.status}).`);
    // GraphQL reports errors with HTTP 200.
    const json = (await response.json()) as {
      data?: {
        viewer?: {
          accounts?: { aiInferenceAdaptiveGroups?: { sum?: { totalNeurons?: number } }[] }[];
        };
      };
      errors?: unknown[] | null;
    };
    const accounts = json.data?.viewer?.accounts;
    if (json.errors?.length || !Array.isArray(accounts) || accounts.length !== 1)
      throw new Error('Analytics query returned errors.');
    // No inference today yields an empty list.
    return (accounts[0].aiInferenceAdaptiveGroups ?? []).reduce(
      (total, row) => total + Number(row.sum?.totalNeurons ?? 0),
      0,
    );
  }
}
