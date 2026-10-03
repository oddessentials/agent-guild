// The shells the Shell card can start: the ones installed on this computer,
// and which of them is the default.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCommand } from './command-resolver.mjs';

const UNIX_SHELLS = [
  { id: 'bash', label: 'bash' },
  { id: 'zsh', label: 'zsh' },
  { id: 'fish', label: 'fish' },
  { id: 'pwsh', label: 'PowerShell' },
];

// Terminal multiplexers, offered after the shells. A session only ever ends
// its client: the multiplexer's own session keeps running after the card
// stops, so the card can attach to it again. {name} is that session's name.
// A tmux card attaches to a tmux session made for it first (tmuxNewSession),
// so the card's identity reaches that session only; that needs tmux 3.2.
// tmux gets -u because the page's terminal is always UTF-8, whatever locale
// the manager inherited; without it tmux draws other characters as "_".
// A herdr card attaches to herdr's own persistent session; herdr runs on
// Windows too, tmux does not.
const TMUX = { id: 'tmux', label: 'tmux', args: ['-u', 'attach-session', '-t', '={name}'], multiplexer: { attach: 'tmux attach -t {name}' } };
const HERDR = { id: 'herdr', label: 'herdr', args: [], multiplexer: { attach: 'herdr' } };

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** The output of `<file> -V`, or '' when it cannot run. */
function readVersion(file) {
  try { return execFileSync(file, ['-V'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); } catch { return ''; }
}

/** Whether `tmux -V` names 3.2 or later. A build without a number (master, a BSD's own) counts as recent. */
export function tmuxSupported(versionText) {
  if (!/^tmux /.test(versionText)) return false;
  const [, major, minor] = versionText.match(/(\d+)\.(\d+)/) ?? [];
  return major === undefined || Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 2);
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

/** Add the installed multiplexers after the shells, unless a shell already has their id. */
function withMultiplexers(shells, candidates, resolve, version) {
  for (const { id, label, args, multiplexer } of candidates) {
    const found = !shells.some((shell) => shell.id === id) && resolve(id);
    if (found && (id !== 'tmux' || tmuxSupported(version(found)))) shells.push({ id, label, path: found, args, env: {}, multiplexer });
  }
  return shells;
}

function windowsShells(env, resolve, exists, version) {
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
  const defaultId = shells[0]?.id ?? null;
  return { shells: withMultiplexers(shells, [HERDR], resolve, version), defaultId };
}

function unixShells(env, platform, resolve, version) {
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
  return { shells: withMultiplexers(shells, [TMUX, HERDR], resolve, version), defaultId };
}

/** The installed shells, as { id, label, path, args, env, multiplexer? }, and the id of the default one. */
export function detectShells(env = process.env, platform = process.platform, { exists = isFile, resolve: resolveWith = resolveCommand, version = readVersion } = {}) {
  const resolve = (command) => resolveWith(command, env, platform);
  return platform === 'win32' ? windowsShells(env, resolve, exists, version) : unixShells(env, platform, resolve, version);
}

/** Quote one word for tmux's command parser: nothing inside single quotes is expanded. `code` names the field a line break came from. */
function tmuxQuote(value, code = 'bad_request') {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw Object.assign(new Error('tmux cannot take a value with a line break'), { status: 400, code });
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The tmux commands, read from stdin, that make a card's own tmux session:
 * detached, `cols` by `rows`, in `cwd`, with `env` as that session's own
 * environment and `args`, if any, as its command. Stdin keeps the card's
 * report token off the command line, where other users could read it.
 */
export function tmuxNewSession({ name, cwd, cols, rows, env, args = [] }) {
  const words = ['new-session', '-d', '-s', tmuxQuote(name), '-x', String(cols), '-y', String(rows), '-c', tmuxQuote(cwd, 'bad_cwd')];
  for (const [key, value] of Object.entries(env)) words.push('-e', tmuxQuote(`${key}=${value}`));
  for (const arg of args) words.push(tmuxQuote(arg, 'bad_args'));
  return `${words.join(' ')}\n`;
}
