import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
function commit() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };
// Recorded on every generation run, e.g. "1.0.0+906a8e5c1f2b".
export const APP_VERSION =
  process.env.APP_VERSION || [pkg.version, commit()].filter(Boolean).join('+');
