// Builds bin/windows/<arch>/agent-guild-start.exe, which starts the manager on Windows, with Visual Studio's C++
// build tools. Usage: node scripts/build-windows-launcher.mjs [x64] [arm64]   (default: this computer's architecture)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'native', 'windows', 'agent-guild-start.c');
const ARCHES = { x64: { x64: 'x64', arm64: 'x64_arm64' }, arm64: { x64: 'arm64_x64', arm64: 'arm64' } };

function fail(message) {
  console.error(`build-windows-launcher: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') fail('it builds on Windows only.');
const host = process.arch === 'arm64' ? 'arm64' : 'x64';
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [host];
for (const arch of targets) if (!ARCHES.x64[arch]) fail(`unknown architecture ${arch}; use x64 or arm64.`);

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const install = fs.existsSync(vswhere)
  && execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
const vcvars = install && path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
if (!vcvars || !fs.existsSync(vcvars)) fail('Visual Studio Build Tools with the "Desktop development with C++" workload are needed; install them and run this again.');

for (const arch of targets) {
  const out = path.join(ROOT, 'bin', 'windows', arch);
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, '..', `.build-${arch}-`));
  const exe = path.join(out, 'agent-guild-start.exe');
  const compile = [
    'cl', '/nologo', '/O1', '/W4', '/WX', '/GS', '/guard:cf', '/MT', '/Brepro', '/DUNICODE', '/D_UNICODE',
    `/Fe"${exe}"`, `"${SOURCE}"`,
    '/link', '/DYNAMICBASE', '/NXCOMPAT', '/guard:cf', '/Brepro', '/SUBSYSTEM:CONSOLE',
  ].join(' ');
  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" ${ARCHES[host][arch]} >nul && ${compile}"`], { cwd: work, stdio: 'inherit', windowsVerbatimArguments: true });
  } catch {
    fail(`the ${arch} build failed${arch !== host ? `; it needs Visual Studio's ${arch.toUpperCase()} build tools` : ''}.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(exe);
}
