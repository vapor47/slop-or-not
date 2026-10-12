import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareAPI, CloudflareDescriptor, CloudflareGenerator } from '../src/cloudflare.ts';
import { ProviderError } from '../src/types.ts';
test('separate model adapters use independent version names and text-only generation', async () => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const api = new CloudflareAPI('account', 'secret');
  api.run = async (model, input) => {
    calls.push({ model, input: input as Record<string, unknown> });
    return model === 'descriptor-version'
      ? { response: 'A red apple on a table.' }
      : { image: Buffer.from('image').toString('base64') };
  };
  const descriptor = new CloudflareDescriptor(api, 'descriptor-version'),
    generator = new CloudflareGenerator(api, 'generator-version');
  const description = await descriptor.describe(Buffer.from('ORIGINAL_BYTES'));
  assert.equal((await generator.generate(description)).toString(), 'image');
  assert.equal(calls[0].model, 'descriptor-version');
  assert.equal(calls[1].model, 'generator-version');
  assert.equal('image' in calls[1].input, false);
  assert.equal(JSON.stringify(calls[1].input).includes('ORIGINAL_BYTES'), false);
  assert.match(String(calls[1].input.prompt), /red apple/);
});
test('Cloudflare retry classification distinguishes capacity from denied access', async () => {
  const original = globalThis.fetch;
  try {
    const api = new CloudflareAPI('account', 'secret');
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    await assert.rejects(
      () => api.run('model', {}),
      (e: unknown) => e instanceof ProviderError && e.temporary,
    );
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    await assert.rejects(
      () => api.run('model', {}),
      (e: unknown) => e instanceof ProviderError && !e.temporary,
    );
  } finally {
    globalThis.fetch = original;
  }
});
