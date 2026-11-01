import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'native', 'report');

export const REPORTER_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

function fail(message) {
  console.error(`build-reporter: ${message}`);
  process.exit(1);
}

function main(argv) {
  const host = `${process.platform}-${process.arch}`;
  const builds = argv.length ? argv : [host];
  for (const build of builds) {
    if (!REPORTER_TARGETS[build]) fail(`unknown build ${build}; use one of ${Object.keys(REPORTER_TARGETS).join(', ')}.`);
  }
  for (const build of builds) {
    const target = REPORTER_TARGETS[build];
    const exe = build.startsWith('win32-') ? 'agent-guild-report.exe' : 'agent-guild-report';
    try {
      execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: CRATE, stdio: 'inherit' });
    } catch (err) {
      fail(err.code === 'ENOENT'
        ? 'cargo was not found; install Rust from https://rustup.rs and run this again.'
        : `the ${build} build failed; it needs the ${target} target (rustup target add ${target}).`);
    }
    const out = path.join(ROOT, 'bin', 'native', build);
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, exe);
    fs.copyFileSync(path.join(CRATE, 'target', target, 'release', exe), file);
    fs.chmodSync(file, 0o755);
    console.log(file);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
