import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_COMMANDS = new Set(['node', 'npm', 'npx', 'corepack']);
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
const cmdLauncher = (entry) => `@"%~dp0..\\${entry}" %*\r\n`;
const shLauncher = (target, node = null) => `#!/bin/sh\nexec ${node ? `${quote(node)} ` : ''}${quote(target)} "$@"\n`;
const gitBashLauncher = (name) => `#!/bin/sh\nexec "$(dirname "$0")/../${name}" "$@"\n`;

/**
 * The installers put only <prefix>/launcher on PATH, never the Node.js they
 * bring. This writes a command there for each one npm installed in that
 * prefix, run on that Node.js, and removes those npm no longer has. Without
 * that folder the running Node.js is not an installer's, and nothing changes.
 */
export function refreshLaunchers({ execPath = process.execPath, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const prefix = fs.realpathSync(win ? path.dirname(execPath) : path.dirname(path.dirname(execPath)));
  const bin = win ? prefix : path.join(prefix, 'bin');
  const dir = path.join(prefix, 'launcher');
  if (!fs.existsSync(dir)) return;
  const wanted = new Map();
  for (const entry of fs.readdirSync(bin)) {
    const name = win ? entry.match(/^(.+)\.cmd$/i)?.[1] : entry;
    if (!name || NODE_COMMANDS.has(name.toLowerCase())) continue;
    if (win) {
      wanted.set(entry, cmdLauncher(entry));
      if (fs.existsSync(path.join(bin, name))) wanted.set(name, gitBashLauncher(name));
      continue;
    }
    const target = path.join(bin, entry);
    const start = Buffer.alloc(200);
    let head = '';
    try {
      const fd = fs.openSync(target, 'r');
      try { head = start.toString('utf8', 0, fs.readSync(fd, start, 0, start.length, 0)).split('\n')[0]; } finally { fs.closeSync(fd); }
    } catch { continue; }
    wanted.set(entry, shLauncher(target, /^#!.*\bnode\b/.test(head) ? path.join(bin, 'node') : null));
  }
  for (const entry of fs.readdirSync(dir)) if (!wanted.has(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  for (const [entry, text] of wanted) {
    const file = path.join(dir, entry);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch {}
    if (current !== text) fs.writeFileSync(file, text, { mode: 0o755 });
  }
}

/** The command one of those launchers runs, or `file` itself when it is not exactly one of them. */
export function launcherTarget(file, platform, fsx) {
  const m = platform === 'win32' ? path.win32 : path.posix;
  const dir = m.dirname(file);
  if (m.basename(dir) !== 'launcher') return file;
  const entry = m.basename(file);
  const text = fsx.readText(file);
  if (platform === 'win32') {
    const target = m.join(m.dirname(dir), entry);
    return text === cmdLauncher(entry) && fsx.isFile(target) ? target : file;
  }
  const bin = m.join(fsx.realpath(m.dirname(dir)), 'bin');
  const target = m.join(bin, entry);
  return (text === shLauncher(target) || text === shLauncher(target, m.join(bin, 'node'))) && fsx.isFile(target) ? target : file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) refreshLaunchers();
