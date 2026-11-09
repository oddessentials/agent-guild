import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORLD_APP = '5462970';

export function parseVdf(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) ?? [];
  const root = {}, stack = [root];
  let key = null;
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    if (token === '{') {
      if (key === null) return root;
      stack.push(top[key.toLowerCase()] = {});
      key = null;
    } else if (token === '}') {
      if (stack.length > 1) stack.pop();
      key = null;
    } else {
      const value = token.slice(1, -1).replace(/\\(.)/g, '$1');
      if (key === null) key = value;
      else { top[key.toLowerCase()] = value; key = null; }
    }
  }
  return root;
}

function windowsSteam() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).match(/SteamPath\s+REG_\w+\s+(.+)/)?.[1]?.trim() || null);
    });
  });
}

export function steamRoots({ platform = process.platform, home = os.homedir(), registry = windowsSteam } = {}) {
  if (platform === 'win32') return registry().then((root) => (root ? [root] : []));
  if (platform === 'darwin') return Promise.resolve([path.join(home, 'Library', 'Application Support', 'Steam')]);
  return Promise.resolve([path.join(home, '.local', 'share', 'Steam'), path.join(home, '.steam', 'steam'), path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')]);
}

export async function worldLibrary({ roots = steamRoots(), fsp = fs.promises } = {}) {
  for (const root of await roots) {
    let folders;
    try { folders = parseVdf(await fsp.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')).libraryfolders; } catch { continue; }
    for (const entry of Object.values(folders ?? {})) {
      if (typeof entry === 'object' && typeof entry.path === 'string' && entry.apps && Object.hasOwn(entry.apps, WORLD_APP)) return path.normalize(entry.path);
    }
  }
  return null;
}

export function createWorkshopFinder({ library = () => worldLibrary(), fsp = fs.promises } = {}) {
  let found = null;
  return async () => {
    found ??= library().catch(() => null);
    const root = await found;
    if (!root) { found = null; return null; }
    const folder = path.join(root, 'steamapps', 'workshop', 'content', WORLD_APP);
    return (await fsp.stat(folder).then((stat) => stat.isDirectory(), () => false)) ? folder : null;
  };
}
