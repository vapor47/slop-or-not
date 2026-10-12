import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { CloudflareAPI, CloudflareDescriptor, CloudflareGenerator } from '../src/cloudflare.ts';
import { normalize } from '../src/images.ts';
if (
  !process.env.CLOUDFLARE_ACCOUNT_ID ||
  !process.env.CLOUDFLARE_API_TOKEN ||
  process.env.DESCRIPTOR_TERMS_ACCEPTED !== 'true'
)
  throw new Error('Configure Cloudflare credentials and accept descriptor terms first.');
const paths = process.argv.slice(2);
if (!paths.length || paths.length > 5)
  throw new Error('Supply 1–5 photo paths. This makes two provider calls per photo.');
const api = new CloudflareAPI(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN);
const descriptor = new CloudflareDescriptor(api, process.env.DESCRIPTOR_MODEL),
  generator = new CloudflareGenerator(api, process.env.GENERATOR_MODEL);
await mkdir('data/sample', { recursive: true });
for (const [i, path] of paths.entries()) {
  const original = await normalize(await readFile(path), true),
    start = Date.now();
  const description = await descriptor.describe(original),
    described = Date.now();
  const generated = await normalize(await generator.generate(description));
  await writeFile(`data/sample/${i}-original.jpg`, original);
  await writeFile(`data/sample/${i}-generated.jpg`, generated);
  await writeFile(
    `data/sample/${i}-report.json`,
    JSON.stringify(
      {
        source: basename(path),
        description,
        descriptorModel: descriptor.model,
        generatorModel: generator.model,
        descriptionMs: described - start,
        generationMs: Date.now() - described,
      },
      null,
      2,
    ),
  );
  console.log(
    `Sample ${i + 1}: described in ${described - start} ms, generated in ${Date.now() - described} ms. Compare data/sample images; verify actual neuron usage in Cloudflare.`,
  );
}
