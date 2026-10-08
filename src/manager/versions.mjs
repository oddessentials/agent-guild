// Installed and latest versions of provider tools.

import { runSpec } from './command-resolver.mjs';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/** First semantic version in a tool's --version output, or null. */
export function parseVersion(text) {
  const match = String(text || '').match(/(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/);
  return match ? match[1] : null;
}

/** tmux uses two numbers and a patch letter; distributions add an epoch/revision. */
export function parseTmuxVersion(text) {
  return String(text || '').trim().match(/^(?:tmux\s+)?(?:\d+:)?(\d+\.\d+(?:_?[a-z])?)(?=$|[-+~\s])/i)?.[1]?.replace('_', '') ?? null;
}

export function compareTmuxVersions(a, b) {
  const parts = (v) => /^(\d+)\.(\d+)([a-z]?)$/i.exec(parseTmuxVersion(v) || '');
  const aa = parts(a), bb = parts(b);
  if (!aa || !bb) return null;
  return Number(aa[1]) - Number(bb[1]) || Number(aa[2]) - Number(bb[2]) || aa[3].localeCompare(bb[3]);
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

export function diagnosticLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(?:[A-Za-z]*error|fatal|panic)\b[^A-Za-z]/i.test(l))
    || lines.find((l) => /\berror\b/i.test(l) && !/^(?:at|throw)\s/.test(l))
    // The Docker CLI reports a missing plugin as `docker: unknown command: docker agent` or `'agent' is not a docker command`.
    || lines.find((l) => /\bunknown command\b|\bis not an? \S+ command\b/i.test(l))
    || lines.at(-1)
    || '';
  return line.slice(0, 240);
}

export async function probeVersion(spec, { env, timeoutMs = 15000, parse = parseVersion } = {}) {
  try {
    // Asking for a version changes nothing, so a tool that ignores SIGTERM is killed outright.
    const { stdout, stderr } = await runSpec(spec, { env, timeoutMs, killSignal: 'SIGKILL' });
    return { ok: true, version: parse(`${stdout}\n${stderr}`), stdout, exitCode: 0, error: null };
  } catch (err) {
    const error = err.killed
      ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
      : diagnosticLine(`${err.stderr || ''}\n${err.stdout || ''}`) || String(err.message || err).slice(0, 240);
    return { ok: false, version: null, stdout: err.stdout || '', exitCode: typeof err.code === 'number' ? err.code : null, error };
  }
}

export async function fetchManifest(pkg, version = 'latest', { registryUrl = DEFAULT_NPM_REGISTRY, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = `${registryUrl.replace(/\/+$/, '')}/${pkg.replace('/', '%2f')}/${encodeURIComponent(version)}`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { manifest: null, error: `the registry answered ${res.status ?? 'with an error'}` };
    const body = await res.json();
    if (typeof body?.version !== 'string') return { manifest: null, error: 'the registry sent no version' };
    return { manifest: body, error: null };
  } catch (err) {
    return { manifest: null, error: err?.name === 'TimeoutError' ? 'the registry did not answer in time' : String(err?.message || err) };
  }
}

export async function latestVersion(pkg, options) {
  return (await fetchManifest(pkg, 'latest', options)).manifest?.version ?? null;
}
