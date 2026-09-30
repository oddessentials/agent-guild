// Installed and latest versions of provider tools.

import { runSpec } from './command-resolver.mjs';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/** First semantic version in a tool's --version output, or null. */
export function parseVersion(text) {
  const match = String(text || '').match(/(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/);
  return match ? match[1] : null;
}

/** Semantic-version order: negative when a < b, positive when a > b. */
export function compareVersions(a, b) {
  const [aMain, aPre] = String(a).split('-');
  const [bMain, bPre] = String(b).split('-');
  const an = aMain.split('.').map(Number);
  const bn = bMain.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((an[i] || 0) !== (bn[i] || 0)) return (an[i] || 0) - (bn[i] || 0);
  }
  if (Boolean(aPre) !== Boolean(bPre)) return aPre ? -1 : 1;
  return aPre === bPre ? 0 : aPre < bPre ? -1 : 1;
}

/** Run a spawn spec (as built by buildSpawnSpec) and parse its version output. */
export async function installedVersion(spec, { env, timeoutMs = 15000 } = {}) {
  try {
    const { stdout, stderr } = await runSpec(spec, { env, timeoutMs });
    return parseVersion(`${stdout}\n${stderr}`);
  } catch (err) {
    return parseVersion(`${err.stdout || ''}\n${err.stderr || ''}`);
  }
}

export async function latestVersion(pkg, { registryUrl = DEFAULT_NPM_REGISTRY, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = `${registryUrl.replace(/\/+$/, '')}/${pkg.replace('/', '%2f')}/latest`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
