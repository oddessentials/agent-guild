import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

export function folderOpenTarget({ platform = process.platform, env = process.env, release = os.release(), fileExists = isFile } = {}) {
  const onPath = (name) => (env.PATH || '').split(':').filter((dir) => path.posix.isAbsolute(dir))
    .map((dir) => path.posix.join(dir, name)).find(fileExists);
  let command, kind, label, reason;
  if (platform === 'win32') {
    kind = 'explorer';
    label = 'File Explorer';
    command = path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'explorer.exe');
  } else if (platform === 'darwin') {
    kind = 'finder';
    label = 'Finder';
    command = '/usr/bin/open';
  } else if (platform === 'linux' && (env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release))) {
    kind = 'explorer';
    label = 'File Explorer';
    command = onPath('explorer.exe');
    reason = 'Windows Explorer is unavailable. Enable Windows interoperability in WSL to open folders.';
  } else if (platform === 'linux') {
    kind = 'desktop';
    label = 'file manager';
    if (env.DISPLAY || env.WAYLAND_DISPLAY) {
      command = onPath('xdg-open');
      reason = 'Install xdg-utils and configure a default file manager to open folders.';
    } else reason = 'Opening folders requires a desktop session on the computer running Agent Guild.';
  } else reason = 'Opening folders is unavailable on this operating system.';
  const available = Boolean(command && fileExists(command));
  return { command, kind, label: label || 'file manager', available, reason: available ? null : reason || `${label} is unavailable on the computer running Agent Guild.` };
}

export function createFolderOpener({ resolveCwd, spawnImpl = spawn, cooldownMs = 1000, handoffMs = 1500, ...targetOptions }) {
  let pending = false, nextOpen = 0;
  return {
    describe() {
      const { available, label, reason } = folderOpenTarget(targetOptions);
      return { available, label, reason };
    },
    async open(cwd) {
      if (cwd !== undefined && (typeof cwd !== 'string' || /[\0\r\n]/.test(cwd))) {
        throw failure(400, 'bad_cwd', 'The working folder must be a directory path.');
      }
      if (typeof cwd === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(cwd.trim()) && !/^[a-z]:[/\\]/i.test(cwd.trim())) {
        throw failure(400, 'bad_cwd', 'Enter a folder path, not a URL.');
      }
      if (pending || Date.now() < nextOpen) throw failure(429, 'folder_open_busy', 'Please wait before opening another folder.');
      const target = folderOpenTarget(targetOptions);
      if (!target.available) throw failure(409, 'folder_open_unavailable', target.reason);
      pending = true;
      try {
        const resolved = resolveCwd(cwd);
        let dir;
        try {
          dir = await fs.promises.realpath(resolved);
          if (!(await fs.promises.stat(dir)).isDirectory()) throw new Error();
        } catch {
          throw failure(400, 'bad_cwd', 'The working folder does not exist or cannot be accessed.');
        }
        let args;
        if (target.kind === 'explorer') args = ['.'];
        else if (target.kind === 'finder') {
          // Reveal packages instead of asking Finder to open (and potentially execute) them.
          args = /\.(app|bundle|framework|plugin|kext|prefpane|workflow)$/i.test(dir)
            ? ['-R', dir] : ['-a', '/System/Library/CoreServices/Finder.app', dir];
        } else args = [dir];
        nextOpen = Date.now() + cooldownMs;
        await new Promise((resolve, reject) => {
          let child, timer, settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child?.unref();
            if (error) reject(failure(409, 'folder_open_failed', `Could not open ${target.label}. Check that a desktop session and file manager are available on the computer running Agent Guild.`));
            else resolve();
          };
          try {
            child = spawnImpl(target.command, args, {
              cwd: target.kind === 'explorer' ? dir : undefined,
              shell: false, windowsHide: true, detached: true, stdio: 'ignore',
            });
            child.once('error', finish);
            child.once('spawn', () => { timer = setTimeout(() => finish(), handoffMs); });
            child.once('exit', (code) => finish(code !== 0 && !(target.kind === 'explorer' && code === 1)));
          } catch (error) { finish(error); }
        });
      } finally { pending = false; }
    },
  };
}
