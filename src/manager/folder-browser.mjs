import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.name < b.name ? -1 : 1);

export function folderSegments(dir, paths = path) {
  const root = paths.parse(dir).root;
  const segments = [{ name: root, path: root }];
  let current = root;
  for (const part of dir.slice(root.length).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, part);
    segments.push({ name: part, path: current });
  }
  return segments;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

export function folderNameProblem(name, platform = process.platform) {
  if (!name) return 'Enter a folder name.';
  if (name === '.' || name === '..') return 'Choose a different folder name.';
  if (/[/\\]/.test(name)) return 'A folder name cannot contain / or \\.';
  if (/[\u0000-\u001f]/.test(name)) return 'A folder name cannot contain control characters.';
  if (platform !== 'win32') return null;
  if (/[<>:"|?*]/.test(name)) return 'A folder name cannot contain < > : " | ? or *.';
  if (/[. ]$/.test(name)) return 'A folder name cannot end with a dot or a space.';
  if (WINDOWS_RESERVED.test(name)) return `Windows reserves the name ${name}.`;
  return null;
}

export function createFolderBrowser({ platform = process.platform, home = os.homedir(), limit = 2000, driveTimeoutMs = 500, fsp = fs.promises } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;

  async function roots() {
    if (platform !== 'win32') return [{ name: '/', path: '/' }];
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const found = await Promise.all(letters.map((letter) => {
      let timer;
      const probe = fsp.stat(`${letter}:\\`).then((stat) => stat.isDirectory(), () => false);
      const late = new Promise((resolve) => { timer = setTimeout(resolve, driveTimeoutMs, false); });
      return Promise.race([probe, late]).finally(() => clearTimeout(timer));
    }));
    return letters.filter((_, i) => found[i]).map((letter) => ({ name: `${letter}:`, path: `${letter}:\\` }));
  }

  async function nearestFolder(dir) {
    for (;;) {
      try {
        if ((await fsp.stat(dir)).isDirectory()) return dir;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw failure(409, 'folder_unreadable', `Agent Guild cannot read ${dir}.`);
      }
      const parent = paths.dirname(dir);
      if (parent === dir) return home;
      dir = parent;
    }
  }

  async function entries(dir) {
    let listed;
    try {
      listed = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      throw failure(409, 'folder_unreadable', `Agent Guild cannot read ${dir}.`);
    }
    const folders = await Promise.all(listed.map(async (entry) => {
      let folder = entry.isDirectory();
      if (!folder && entry.isSymbolicLink()) folder = await fsp.stat(paths.join(dir, entry.name)).then((stat) => stat.isDirectory(), () => false);
      return folder ? { name: entry.name, path: paths.join(dir, entry.name), hidden: entry.name.startsWith('.') } : null;
    }));
    return folders.filter(Boolean).sort(byName);
  }

  const browser = {
    async create(rawParent, rawName) {
      if (typeof rawParent !== 'string' || !rawParent.trim() || rawParent.includes('\0')) throw failure(400, 'bad_path', 'The folder must be a path.');
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      const problem = folderNameProblem(name, platform);
      if (problem) throw failure(400, 'bad_name', problem);
      const parent = paths.resolve(rawParent.trim());
      const missing = () => failure(409, 'folder_missing', `${parent} no longer exists.`);
      try {
        if (!(await fsp.stat(parent)).isDirectory()) throw missing();
      } catch (error) {
        if (error.status) throw error;
        throw error.code === 'ENOENT' || error.code === 'ENOTDIR' ? missing() : failure(409, 'folder_unreadable', `Agent Guild cannot read ${parent}.`);
      }
      const dir = paths.join(parent, name);
      try {
        await fsp.mkdir(dir);
      } catch (error) {
        if (error.code === 'EEXIST') throw failure(409, 'folder_exists', `${name} already exists in ${parent}.`);
        if (error.code === 'ENOENT') throw missing();
        throw failure(409, 'folder_unwritable', `Agent Guild cannot create ${dir}.`);
      }
      return browser.list(dir);
    },
    async list(raw) {
      if (raw !== undefined && raw !== null && (typeof raw !== 'string' || raw.includes('\0'))) {
        throw failure(400, 'bad_path', 'The folder must be a path.');
      }
      let asked = String(raw ?? '').trim();
      if (asked === '~' || asked.startsWith('~/') || asked.startsWith('~\\')) asked = paths.join(home, asked.slice(1));
      const wanted = asked ? paths.resolve(asked) : home;
      const dir = await nearestFolder(wanted);
      const [folders, drives] = await Promise.all([entries(dir), roots()]);
      const parent = paths.dirname(dir);
      return {
        path: dir,
        parent: parent === dir ? null : parent,
        home,
        segments: folderSegments(dir, paths),
        roots: drives,
        entries: folders.slice(0, limit),
        truncated: folders.length > limit,
        note: dir === wanted ? null : wanted,
      };
    },
  };
  return browser;
}
