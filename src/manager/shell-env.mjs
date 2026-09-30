// Recover the user's real PATH on macOS and Linux.
//
// An app started from Finder, the Dock, or a login item does not inherit the
// PATH that the user's shell profile builds (Homebrew, nvm, ~/.local/bin, ...),
// which is exactly where CLI coding tools usually live. Like VS Code, we ask
// the user's login shell for its PATH once at startup and merge it in.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const START = '__AGENT_GUILD_PATH_START__';
const END = '__AGENT_GUILD_PATH_END__';

export function mergePathLists(primary, secondary, delimiter = path.delimiter) {
  const seen = new Set();
  const out = [];
  for (const list of [primary, secondary]) {
    for (const entry of (list || '').split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

export function loginShellPath({ shell = process.env.SHELL, timeoutMs = 8000 } = {}) {
  if (process.platform === 'win32' || !shell) return null;
  const result = spawnSync(shell, ['-l', '-i', '-c', `printf '%s' "${START}$PATH${END}"`], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AGENT_GUILD_RESOLVING_ENV: '1' },
  });
  if (result.error || typeof result.stdout !== 'string') return null;
  const start = result.stdout.indexOf(START);
  const end = result.stdout.indexOf(END, start);
  if (start === -1 || end === -1) return null;
  return result.stdout.slice(start + START.length, end);
}

/**
 * Returns a copy of process.env whose PATH also contains the login shell's
 * PATH entries. Set AGENT_GUILD_SKIP_SHELL_ENV=1 to disable the lookup.
 */
export function resolveBaseEnv() {
  const env = { ...process.env };
  if (process.env.AGENT_GUILD_SKIP_SHELL_ENV === '1') return env;
  const shellPath = loginShellPath();
  if (shellPath) env.PATH = mergePathLists(shellPath, env.PATH);
  return env;
}
