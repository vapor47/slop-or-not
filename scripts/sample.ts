import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Repository } from '../src/db.ts';
import { limitsFromEnv } from '../src/quota.ts';
import { CloudflareAPI, CloudflareDescriptor, CloudflareGenerator } from '../src/cloudflare.ts';
import { normalize } from '../src/images.ts';
import { DEFAULT_TEMPLATES } from '../src/prompts.ts';
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
// Samples spend the same daily neuron allowance as the app, so they pass the same gate.
const directory = resolve(process.env.DATA_DIR || 'data');
mkdirSync(directory, { recursive: true });
const limits = limitsFromEnv(process.env),
  repo = new Repository(
    resolve(directory, 'game.sqlite'),
    limits.neurons,
    Date.now,
    undefined,
    limits,
  ),
  descriptorUnits = Number(process.env.DESCRIPTOR_NEURON_RESERVATION || 200),
  generatorUnits = Number(process.env.GENERATOR_NEURON_RESERVATION || 80);
await mkdir('data/sample', { recursive: true });
for (const [i, path] of paths.entries()) {
  const blocked = repo.quota.generationBlocked();
  if (blocked) throw new Error(blocked);
  repo.reserve(descriptorUnits + generatorUnits);
  const original = await normalize(await readFile(path), true),
    start = Date.now();
  repo.quota.spend(descriptorUnits);
  const description = (await descriptor.describe(original, DEFAULT_TEMPLATES.describe.text)).text,
    described = Date.now();
  repo.quota.spend(generatorUnits);
  const generated = await normalize(
    (await generator.generate(DEFAULT_TEMPLATES.generate.text + description.slice(0, 1900))).image,
  );
  await writeFile(`data/sample/${i}-original.jpg`, original);
  await writeFile(`data/sample/${i}-generated.jpg`, generated);
  await writeFile(
    `data/sample/${i}-report.json`,
    JSON.stringify(
      {
        source: basename(path),
        description,
        descriptorModel: descriptor.model,
        descriptorParams: descriptor.params,
        generatorModel: generator.model,
        generatorParams: generator.params,
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
repo.db.close();
