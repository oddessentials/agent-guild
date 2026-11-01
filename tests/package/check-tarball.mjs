import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// npm's registry refused a 316 MB package. The Yard's art ships as a release pack instead; the skins stay.
const MAX_PACKED_BYTES = 100 * 1024 * 1024;
const TOP_LEVEL = new Set(['package.json', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'LICENSE', 'bin', 'src', 'web', 'config', 'examples', 'docs', 'node_modules']);
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'src/manager/main.mjs', 'web/index.html', 'web/yard/art.json', 'config/providers.default.json', 'docs/api.md'];
const PACKAGE_ROOT = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+)package\.json$/;
// node-pty ships these unsigned, the launcher is built unsigned, and Smart App Control blocks unsigned modules, so the release signs them.
export const WINDOWS_MODULES = ['x64', 'arm64'].flatMap((arch) => [
  ...['conpty.node', 'conpty_console_list.node'].map((name) => `node_modules/node-pty/prebuilds/win32-${arch}/${name}`),
  `bin/windows/${arch}/agent-guild-start.exe`,
]);

export function peLayout(buffer) {
  if (!buffer || buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 + 2 > buffer.length || buffer.readUInt32LE(pe) !== 0x4550) return null;
  const optional = pe + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const security = directories + 4 * 8;
  if (security + 8 > buffer.length || buffer.readUInt32LE(directories - 4) < 5) return null;
  return { checksum: optional + 64, security, certOffset: buffer.readUInt32LE(security), certSize: buffer.readUInt32LE(security + 4) };
}

// True when signed is upstream with only an Authenticode signature added: the PE checksum, the
// security directory entry, up to 7 zero bytes of alignment and the certificate table that ends the file.
export function signedFrom(signed, upstream) {
  const after = peLayout(signed);
  const before = peLayout(upstream);
  if (!after || !before || before.certSize !== 0 || after.certSize === 0) return false;
  if (after.certOffset + after.certSize !== signed.length) return false;
  if (after.certOffset < upstream.length || after.certOffset - upstream.length > 7) return false;
  if (signed.subarray(upstream.length, after.certOffset).some((byte) => byte !== 0)) return false;
  const masked = (buffer, at) => {
    const copy = Buffer.from(buffer.subarray(0, upstream.length));
    copy.fill(0, at.checksum, at.checksum + 4);
    copy.fill(0, at.security, at.security + 8);
    return copy;
  };
  return masked(signed, after).equals(masked(upstream, before));
}

function paxPath(body) {
  let found = null;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(body.toString('utf8', at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = body.toString('utf8', space + 1, at + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') found = record.slice(eq + 1);
    at += length;
  }
  return found;
}

export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let longPath = null;
  const text = (start, length) => {
    const field = buffer.subarray(offset + start, offset + start + length);
    const end = field.indexOf(0);
    return field.toString('utf8', 0, end === -1 ? length : end);
  };
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      longPath = paxPath(body) ?? longPath;
    } else if (type === 'L') {
      longPath = body.toString('utf8').replace(/\0+$/, '');
    } else if (type !== 'g') {
      const prefix = text(345, 155);
      const name = text(0, 100);
      entries.push({ path: longPath ?? (prefix ? `${prefix}/${name}` : name), mode: parseInt(text(100, 8).trim() || '0', 8), size, type, body });
      longPath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function packageFiles(entries) {
  const files = new Map();
  for (const entry of entries) {
    if (entry.type === '0' && entry.path.startsWith('package/')) files.set(entry.path.slice('package/'.length), entry);
  }
  return files;
}

export function bundledPackages(files) {
  const bundled = new Map();
  for (const [rel, entry] of files) {
    const match = rel.match(PACKAGE_ROOT);
    if (match) bundled.set(match[1].slice(0, -1), JSON.parse(entry.body.toString('utf8')).version);
  }
  return bundled;
}

export function checkPackage({ entries, lock, version = null, upstream = null }) {
  const problems = [];
  for (const entry of entries) {
    if (!entry.path.startsWith('package/')) problems.push(`${entry.path} is outside package/`);
  }
  const files = packageFiles(entries);

  const unexpected = new Set([...files.keys()].map((rel) => rel.split('/')[0]).filter((top) => !TOP_LEVEL.has(top)));
  for (const top of unexpected) problems.push(`${top} is not on the list of shipped files`);

  const manifestEntry = files.get('package.json');
  const manifest = manifestEntry ? JSON.parse(manifestEntry.body.toString('utf8')) : {};
  for (const rel of [...REQUIRED, ...Object.values(manifest.bin || {})]) {
    if (!files.has(rel)) problems.push(`${rel} is missing`);
  }
  if ([...files.keys()].some((rel) => rel.startsWith('web/yard/assets/'))) problems.push('web/yard/assets is in the package; the Yard art ships as the release pack');
  const art = files.get('web/yard/art.json');
  if (art) {
    let url = null;
    try { url = JSON.parse(art.body.toString('utf8')).archive?.url ?? null; } catch {}
    if (typeof url !== 'string') problems.push('web/yard/art.json names no art pack');
    else if (version !== null && !url.includes(`/releases/download/v${version}/yard-art-`)) problems.push(`web/yard/art.json names ${url}, not a pack on the v${version} release`);
  }
  if (manifestEntry) {
    const name = lock.packages[''].name;
    if (manifest.name !== name) problems.push(`the package is named ${manifest.name}, not ${name}`);
    if (manifest.private) problems.push('the package is marked private');
    if (version !== null && manifest.version !== version) problems.push(`the package is version ${manifest.version}, not ${version}`);
  }

  const expected = new Map(Object.entries(lock.packages).filter(([key, pkg]) => key && !pkg.dev).map(([key, pkg]) => [key, pkg.version]));
  const bundled = bundledPackages(files);
  for (const [key, want] of expected) {
    const got = bundled.get(key);
    if (got === undefined) problems.push(`${key} is in the lockfile but not in the package`);
    else if (got !== want) problems.push(`${key} is ${got} in the package but ${want} in the lockfile`);
  }
  for (const key of bundled.keys()) {
    if (!expected.has(key)) problems.push(`${key} is in the package but is not a locked runtime dependency`);
  }

  const helpers = [...files].filter(([rel]) => path.posix.basename(rel) === 'spawn-helper');
  if (helpers.length === 0) problems.push('no spawn-helper was found; node-pty needs it to start terminals on macOS');
  for (const [rel, entry] of helpers) {
    if ((entry.mode & 0o111) === 0) problems.push(`${rel} is not executable (mode ${entry.mode.toString(8)}); pack on Linux or macOS`);
  }

  for (const rel of WINDOWS_MODULES) {
    if (!files.has(rel)) problems.push(`${rel} is missing; it is one of the Windows modules the release signs`);
  }
  for (const [rel, entry] of files) {
    const layout = peLayout(entry.body);
    if (!layout) continue;
    if (!WINDOWS_MODULES.includes(rel)) {
      if (layout.certSize === 0) problems.push(`${rel} is an unsigned Windows binary that the release does not sign`);
    } else if (upstream) {
      if (!upstream.has(rel)) problems.push(`${rel} has no upstream copy to compare with`);
      else if (!signedFrom(entry.body, upstream.get(rel))) problems.push(`${rel} is not the unsigned file with only a signature added`);
    }
  }
  return problems;
}

function main(argv) {
  let tarball = null;
  let version = null;
  let upstreamDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') version = argv[++i] ?? null;
    else if (argv[i] === '--upstream') upstreamDir = argv[++i] ?? null;
    else if (argv[i] === '--windows-modules') {
      console.log(WINDOWS_MODULES.join('\n'));
      return 0;
    } else tarball = argv[i];
  }
  if (!tarball) {
    console.error('Usage: node tests/package/check-tarball.mjs <tarball> [--version X.Y.Z] [--upstream <dir with node-pty\'s unsigned modules>] | --windows-modules');
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lock = JSON.parse(fs.readFileSync(path.resolve(here, '../../package-lock.json'), 'utf8'));
  const packed = fs.statSync(tarball).size;
  const entries = readTar(zlib.gunzipSync(fs.readFileSync(tarball)));
  const upstream = upstreamDir && new Map(WINDOWS_MODULES
    .filter((rel) => fs.existsSync(path.join(upstreamDir, rel)))
    .map((rel) => [rel, fs.readFileSync(path.join(upstreamDir, rel))]));
  const problems = checkPackage({ entries, lock, version, upstream });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  if (packed > MAX_PACKED_BYTES) problems.push(`the package is ${mb(packed)} MB packed; the limit is ${mb(MAX_PACKED_BYTES)} MB`);
  for (const problem of problems) console.error(`not ok  ${problem}`);
  if (problems.length > 0) return 1;
  const files = packageFiles(entries);
  const manifest = JSON.parse(files.get('package.json').body.toString('utf8'));
  const unpacked = [...files.values()].reduce((sum, entry) => sum + entry.size, 0);
  console.log(`ok  ${manifest.name}@${manifest.version}: ${files.size} files, ${mb(packed)} MB packed, ${mb(unpacked)} MB unpacked, ${bundledPackages(files).size} bundled packages`);
  return 0;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
