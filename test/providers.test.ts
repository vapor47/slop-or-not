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
      ? { response: 'A red apple on a table.', usage: { completion_tokens: 7 } }
      : { image: Buffer.from('image').toString('base64') };
  };
  const descriptor = new CloudflareDescriptor(api, 'descriptor-version'),
    generator = new CloudflareGenerator(api, 'generator-version');
  const described = await descriptor.describe(Buffer.from('ORIGINAL_BYTES'), 'Describe it.');
  assert.deepEqual(described, {
    text: 'A red apple on a table.',
    modelVersion: null,
    usage: { completion_tokens: 7 },
  });
  const prompt = 'Prefix. ' + described.text;
  assert.equal((await generator.generate(prompt)).image.toString(), 'image');
  assert.equal(calls[0].model, 'descriptor-version');
  assert.equal(calls[1].model, 'generator-version');
  assert.equal('image' in calls[1].input, false);
  assert.equal(JSON.stringify(calls[1].input).includes('ORIGINAL_BYTES'), false);
  // The prompt sent is exactly the text the pipeline records, and the exposed params are
  // exactly the rest of each request body (apart from the image bytes).
  assert.equal(calls[0].input.prompt, 'Describe it.');
  assert.equal(calls[1].input.prompt, prompt);
  const { prompt: _p0, image: _image, ...describeParams } = calls[0].input;
  const { prompt: _p1, ...generateParams } = calls[1].input;
  assert.deepEqual(describeParams, descriptor.params);
  assert.deepEqual(generateParams, generator.params);
  assert.equal(descriptor.provider, 'cloudflare-workers-ai');
  assert.equal(generator.provider, 'cloudflare-workers-ai');
  await assert.rejects(
    () => generator.generate('x'.repeat(2049)),
    (e: unknown) => e instanceof ProviderError && !e.temporary,
  );
  assert.equal(calls.length, 2);
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
