import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { PINS, archiveName, archiveUrl } from './node-pins.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@oddessentials/agent-guild';
const ARCHES = ['x64', 'arm64'];
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(version, target, sha, cache) {
  const file = path.join(cache, archiveName(version, target));
  if (!fs.existsSync(file) || sha256(file) !== sha) {
    fs.mkdirSync(cache, { recursive: true });
    const res = await fetch(archiveUrl(version, target));
    if (!res.ok) throw new Error(`nodejs.org answered ${res.status} for ${archiveName(version, target)}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
    fs.renameSync(`${file}.part`, file);
  }
  const got = sha256(file);
  if (got !== sha) throw new Error(`${archiveName(version, target)} has SHA-256 ${got}, not the pinned ${sha}`);
  return file;
}

function packageVersion(tgz) {
  return JSON.parse(execFileSync(TAR, ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' })).version;
}

async function runtime({ target, cache, dir }) {
  const pins = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const archive = await download(pins.version, target, pins.archives[target], cache);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(TAR, ['-xf', archive, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
}

function install({ win, tgz, dir }) {
  const npm = path.join(dir, ...(win ? [] : ['lib']), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  execFileSync(process.execPath, [npm, 'install', '--global', '--prefix', dir, '--no-fund', '--no-audit', '--no-update-notifier', path.resolve(tgz)], { stdio: 'inherit' });
  const installed = JSON.parse(fs.readFileSync(path.join(dir, ...(win ? [] : ['lib']), 'node_modules', ...PACKAGE.split('/'), 'package.json'), 'utf8'));
  if (installed.version !== packageVersion(tgz)) throw new Error(`${dir} holds ${installed.version}, not ${packageVersion(tgz)}`);
}

function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name;
    return entry.isDirectory() ? files(path.join(dir, entry.name), `${rel}/`) : [rel];
  });
}

function sameExceptNode(a, b) {
  const listA = files(a).sort();
  const listB = files(b).sort();
  if (listA.join('\n') !== listB.join('\n')) throw new Error(`${a} and ${b} hold different files`);
  const differ = listA.filter((rel) => sha256(path.join(a, rel)) !== sha256(path.join(b, rel)));
  if (differ.join() !== 'node.exe') throw new Error(`The x64 and arm64 Node.js builds differ in more than node.exe: ${differ.join(', ')}`);
}

function icon(out) {
  const png = fs.readFileSync(path.join(ROOT, 'web', 'brand', 'favicon.png'));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(64, 6);
  header.writeUInt8(64, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(out, Buffer.concat([header, png]));
}

export async function windows({ tgz, out, cache }) {
  const dir = path.join(out, 'windows');
  for (const arch of ARCHES) await runtime({ target: `win-${arch}`, cache, dir: path.join(dir, `node-${arch}`) });
  sameExceptNode(path.join(dir, 'node-x64'), path.join(dir, 'node-arm64'));
  fs.rmSync(path.join(dir, 'app'), { recursive: true, force: true });
  fs.cpSync(path.join(dir, 'node-x64'), path.join(dir, 'app'), { recursive: true });
  install({ win: true, tgz, dir: path.join(dir, 'app') });
  icon(path.join(dir, 'agent-guild.ico'));
  return { version: packageVersion(tgz), dir };
}

async function posix({ tgz, out, cache, os, node }) {
  const version = packageVersion(tgz);
  const dirs = [];
  for (const arch of ARCHES) {
    const top = path.join(out, os, `agent-guild-${version}-${os}-${arch}`);
    fs.rmSync(top, { recursive: true, force: true });
    await runtime({ target: `${node}-${arch}`, cache, dir: path.join(top, 'agent-guild') });
    install({ win: false, tgz, dir: path.join(top, 'agent-guild') });
    fs.copyFileSync(path.join(ROOT, 'installers', 'linux', 'install.sh'), path.join(top, 'install.sh'));
    fs.chmodSync(path.join(top, 'install.sh'), 0o755);
    dirs.push(top);
  }
  return { version, dirs };
}

export async function linux({ tgz, out, cache }) {
  const { version, dirs } = await posix({ tgz, out, cache, os: 'linux', node: 'linux' });
  const tarballs = [];
  for (const top of dirs) {
    const tarball = path.join(out, `${path.basename(top)}.tar.gz`);
    execFileSync(TAR, ['-czf', tarball, '-C', path.dirname(top), path.basename(top)], { stdio: 'inherit' });
    tarballs.push(tarball);
  }
  return { version, tarballs };
}

export function macos({ tgz, out, cache }) {
  return posix({ tgz, out, cache, os: 'macos', node: 'darwin' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, tgz, out] = process.argv.slice(2);
  const builds = { windows, linux, macos };
  if (!Object.hasOwn(builds, kind) || !tgz || !out) {
    console.error('Usage: node scripts/installers.mjs <windows|linux|macos> <package .tgz> <output folder>');
    process.exit(2);
  }
  const result = await builds[kind]({ tgz, out: path.resolve(out), cache: path.resolve(out, 'downloads') });
  console.log(JSON.stringify(result));
}
