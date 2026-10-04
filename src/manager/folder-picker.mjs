import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TITLE = 'Choose a working folder';
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isFolder = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

const APPLESCRIPT = [
  'on run argv',
  'activate',
  'try',
  `return POSIX path of (choose folder with prompt "${TITLE}" default location (POSIX file (item 1 of argv)))`,
  'on error number -128',
  'return ""',
  'end try',
  'end run',
];

let windowsScript;
function encodedWindowsScript() {
  windowsScript ??= Buffer.from(fs.readFileSync(new URL('./folder-picker.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64');
  return windowsScript;
}

export function folderPickTarget({ platform = process.platform, env = process.env, release = os.release(), fileExists = isFile } = {}) {
  const onPath = (name) => (env.PATH || '').split(':').filter((dir) => path.posix.isAbsolute(dir))
    .map((dir) => path.posix.join(dir, name)).find(fileExists);
  let command, kind, translate, reason;
  if (platform === 'win32') {
    kind = 'windows';
    command = path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  } else if (platform === 'darwin') {
    kind = 'mac';
    command = '/usr/bin/osascript';
  } else if (platform === 'linux' && (env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release))) {
    kind = 'windows';
    translate = onPath('wslpath');
    command = translate && onPath('powershell.exe');
    reason = 'Windows PowerShell is unavailable. Enable Windows interoperability in WSL to choose folders.';
  } else if (platform === 'linux') {
    if (env.DISPLAY || env.WAYLAND_DISPLAY) {
      command = onPath('zenity');
      kind = command ? 'zenity' : 'kdialog';
      command ||= onPath('kdialog');
      reason = 'Install zenity or kdialog to choose folders.';
    } else reason = 'Choosing folders requires a desktop session on the computer running Agent Guild.';
  } else reason = 'Choosing folders is unavailable on this operating system.';
  const available = Boolean(command && fileExists(command));
  return { command, kind, translate, available, reason: available ? null : reason || 'The folder dialog is unavailable on the computer running Agent Guild.' };
}

export function createFolderPicker({ resolveCwd, spawnImpl = spawn, env = process.env, ...targetOptions }) {
  let pending = false;

  const run = (command, args, { signal, env: childEnv = env } = {}) => new Promise((resolve, reject) => {
    let child, out = '';
    try {
      child = spawnImpl(command, args, { env: childEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) { return reject(error); }
    const stop = () => child.kill();
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', stop);
      resolve({ code, out: out.replace(/[\r\n]+$/, '') });
    });
  });

  function dialog(target, start, signal) {
    if (target.kind === 'windows') {
      const vars = { AGENT_GUILD_PICK_START: start, AGENT_GUILD_PICK_TITLE: TITLE };
      if (target.translate) vars.WSLENV = [env.WSLENV, 'AGENT_GUILD_PICK_START/p', 'AGENT_GUILD_PICK_TITLE'].filter(Boolean).join(':');
      return run(target.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedWindowsScript()], { signal, env: { ...env, ...vars } });
    }
    if (target.kind === 'mac') return run(target.command, [...APPLESCRIPT.flatMap((line) => ['-e', line]), start], { signal });
    if (target.kind === 'zenity') return run(target.command, ['--file-selection', '--directory', `--title=${TITLE}`, `--filename=${path.join(start, path.sep)}`], { signal });
    return run(target.command, ['--title', TITLE, '--getexistingdirectory', start], { signal });
  }

  return {
    describe() {
      const { available, reason } = folderPickTarget({ env, ...targetOptions });
      return { available, reason };
    },
    async pick(cwd, { signal } = {}) {
      if (cwd !== undefined && (typeof cwd !== 'string' || /[\0\r\n]/.test(cwd))) {
        throw failure(400, 'bad_cwd', 'The working folder must be a directory path.');
      }
      if (pending) throw failure(409, 'folder_pick_busy', 'A folder dialog is already open on the computer running Agent Guild.');
      const target = folderPickTarget({ env, ...targetOptions });
      if (!target.available) throw failure(409, 'folder_pick_unavailable', target.reason);
      let start;
      try { start = resolveCwd(cwd); } catch { start = os.homedir(); }
      pending = true;
      try {
        const broken = () => failure(409, 'folder_pick_failed', 'Could not show the folder dialog. Check that a desktop session is available on the computer running Agent Guild.');
        let result = await dialog(target, start, signal).catch(() => { throw broken(); });
        const cancelled = result.code === 0 || (result.code === 1 && target.kind !== 'windows' && target.kind !== 'mac');
        if (signal?.aborted || (!result.out && cancelled)) return null;
        if (result.code !== 0) throw broken();
        if (target.translate) {
          result = await run(target.translate, ['-u', result.out], { signal }).catch(() => ({ code: 1 }));
          if (result.code !== 0) throw failure(409, 'folder_pick_failed', 'The chosen folder cannot be reached from WSL.');
        }
        const dir = path.resolve(result.out);
        if (!isFolder(dir)) throw failure(409, 'folder_pick_failed', 'The chosen folder cannot be used as a working folder.');
        return dir;
      } finally { pending = false; }
    },
  };
}
