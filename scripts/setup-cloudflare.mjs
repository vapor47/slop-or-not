import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
const flag = process.argv[2];
if (!['--check-token', '--accept-llama-terms'].includes(flag)) {
  console.log('Usage: node --env-file=.env scripts/setup-cloudflare.mjs --check-token');
  console.log(
    'After reviewing Meta terms: node --env-file=.env scripts/setup-cloudflare.mjs --accept-llama-terms',
  );
  process.exit(0);
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error('Save CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env first.');
  process.exit(1);
}
const model = process.env.DESCRIPTOR_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
if (flag === '--accept-llama-terms' && model !== '@cf/meta/llama-3.2-11b-vision-instruct') {
  console.error(
    'This setup command accepts terms only for the selected Llama 3.2 11B Vision model.',
  );
  process.exit(1);
}
try {
  const response = await fetch(
    flag === '--check-token'
      ? 'https://api.cloudflare.com/client/v4/user/tokens/verify'
      : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`,
    {
      method: flag === '--check-token' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(flag === '--accept-llama-terms' ? { body: JSON.stringify({ prompt: 'agree' }) } : {}),
      signal: AbortSignal.timeout(60000),
    },
  );
  const result = await response.json();
  if (!response.ok || !result.success) {
    console.error(
      `Cloudflare request failed (HTTP ${response.status}; error codes: ${(result.errors || []).map((e) => e.code).join(', ') || 'unknown'}).`,
    );
    console.error(
      'Check the account ID and Workers AI Read/Edit permissions. Configuration was not changed.',
    );
    process.exit(1);
  }
  if (flag === '--check-token') {
    console.log(
      `Token status: ${result.result?.status || 'verified'}. Account/model access still needs a model request.`,
    );
  } else {
    const path = new URL('../.env', import.meta.url);
    const text = await readFile(path, 'utf8');
    const updated = /^DESCRIPTOR_TERMS_ACCEPTED=.*$/m.test(text)
      ? text.replace(/^DESCRIPTOR_TERMS_ACCEPTED=.*$/m, 'DESCRIPTOR_TERMS_ACCEPTED=true')
      : text + '\nDESCRIPTOR_TERMS_ACCEPTED=true\n';
    const temporary = new URL('../.env.setup-tmp', import.meta.url);
    await writeFile(temporary, updated, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    console.log(
      'Cloudflare accepted the Llama terms request. Updated DESCRIPTOR_TERMS_ACCEPTED=true in .env.',
    );
  }
} catch {
  console.error(
    'Setup could not complete. Check internet access and that .env is writable. If Cloudflare succeeded but the file update failed, check model access before retrying.',
  );
  process.exit(1);
}
