// The shells the Shell card can start: the ones installed on this computer,
// and which of them is the default.

import fs from 'node:fs';
import path from 'node:path';
import { resolveCommand } from './command-resolver.mjs';

const UNIX_SHELLS = [
  { id: 'bash', label: 'bash' },
  { id: 'zsh', label: 'zsh' },
  { id: 'fish', label: 'fish' },
  { id: 'pwsh', label: 'PowerShell' },
];

// Terminal multiplexers, offered after the shells on macOS and Linux. Each
// starts the way a new terminal window would start it, and a session only
// ever ends its client: the multiplexer's own session keeps running after
// the card stops, so it can be reattached. {name} is the session's own name.
// tmux gets -u because the page's terminal is always UTF-8, whatever locale
// the manager inherited; without it tmux draws other characters as "_".
const MULTIPLEXERS = [
  { id: 'tmux', label: 'tmux', args: ['-u', 'new-session', '-s', '{name}'], attach: 'tmux attach -t {name}' },
  { id: 'herdr', label: 'herdr', args: [], attach: 'herdr' },
];

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

// Git for Windows keeps bash.exe in <root>\bin, and git.exe in <root>\cmd,
// <root>\bin or <root>\mingw64\bin.
function findGitBash(env, resolve, exists) {
  const p = path.win32;
  const roots = [];
  const git = resolve('git');
  if (git) for (let dir = p.dirname(git), i = 0; i < 3; i++, dir = p.dirname(dir)) roots.push(dir);
  for (const [name, sub] of [['ProgramFiles', 'Git'], ['ProgramW6432', 'Git'], ['ProgramFiles(x86)', 'Git'], ['LOCALAPPDATA', 'Programs\\Git'], ['USERPROFILE', 'scoop\\apps\\git\\current']]) {
    const base = envValue(env, name);
    if (base) roots.push(p.join(base, sub));
  }
  for (const root of roots) {
    const bash = p.join(root, 'bin', 'bash.exe');
    if (exists(bash) && exists(p.join(root, 'cmd', 'git.exe'))) return bash;
  }
  return null;
}

/** The shell to name when none is installed. */
export function fallbackShell(env, platform) {
  if (platform === 'win32') return 'powershell.exe';
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

function windowsShells(env, resolve, exists) {
  const installed = ['ProgramFiles', 'ProgramW6432'].map((name) => envValue(env, name)).filter(Boolean).map((base) => path.win32.join(base, 'PowerShell', '7', 'pwsh.exe'));
  const pwsh = resolve('pwsh') || installed.find(exists) || null;
  const gitBash = findGitBash(env, resolve, exists);
  const shells = [
    pwsh && { id: 'pwsh', label: 'PowerShell', path: pwsh, args: [], env: {} },
    { id: 'powershell', label: 'Windows PowerShell', path: resolve('powershell.exe'), args: [], env: {} },
    { id: 'cmd', label: 'Command Prompt', path: resolve('cmd.exe'), args: [], env: {} },
    // CHERE_INVOKING keeps a login bash in the session's folder instead of moving to HOME.
    gitBash && { id: 'git-bash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } },
  ].filter((shell) => shell?.path);
  return { shells, defaultId: shells[0]?.id ?? null };
}

function unixShells(env, platform, resolve) {
  const name = (file) => path.posix.basename(file);
  const own = resolve(env.SHELL || '') || resolve(fallbackShell({}, platform));
  const shells = [];
  for (const { id, label } of UNIX_SHELLS) {
    const found = own && name(own) === id ? own : resolve(id);
    if (found) shells.push({ id, label, path: found, args: [], env: {} });
  }
  let defaultId = own ? name(own) : null;
  if (own && !shells.some((shell) => shell.id === defaultId)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(defaultId)) defaultId = 'login';
    shells.unshift({ id: defaultId, label: name(own), path: own, args: [], env: {} });
  }
  defaultId ??= shells[0]?.id ?? null;
  for (const { id, label, args, attach } of MULTIPLEXERS) {
    const found = !shells.some((shell) => shell.id === id) && resolve(id);
    if (found) shells.push({ id, label, path: found, args, env: {}, multiplexer: { attach } });
  }
  return { shells, defaultId };
}

/** The installed shells, as { id, label, path, args, env }, and the id of the default one. */
export function detectShells(env = process.env, platform = process.platform, { exists = isFile, resolve: resolveWith = resolveCommand } = {}) {
  const resolve = (command) => resolveWith(command, env, platform);
  return platform === 'win32' ? windowsShells(env, resolve, exists) : unixShells(env, platform, resolve);
}
