import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinsFrom } from '../scripts/node-pins.mjs';

const INSTALL_SH = path.resolve('installers/linux/install.sh');
const ZSH = process.platform === 'win32' ? '' : execFileSync('/bin/sh', ['-c', 'command -v zsh || true'], { encoding: 'utf8' }).trim();
const TOOLS = ['awk', 'basename', 'cp', 'dirname', 'grep', 'mkdir', 'mv', 'readlink', 'rm', 'sed', 'uname'];

test('the Node.js pins take each target archive\'s SHA-256, and a missing target is refused', () => {
  const sums = ['win-x64.zip', 'win-arm64.zip', 'linux-x64.tar.gz', 'linux-arm64.tar.gz', 'darwin-x64.tar.gz', 'darwin-arm64.tar.gz', 'x64.msi']
    .map((tail, i) => `${String(i).repeat(64)}  node-v24.1.0-${tail}`).join('\n');
  const pins = pinsFrom('24.1.0', sums);
  assert.equal(pins.version, '24.1.0');
  assert.equal(pins.archives['win-arm64'], '1'.repeat(64));
  assert.equal(pins.archives['darwin-arm64'], '5'.repeat(64));
  assert.throws(() => pinsFrom('24.1.0', sums.replace(/.*linux-arm64.*\n/, '')), /node-v24\.1\.0-linux-arm64\.tar\.gz/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'path');
  fs.mkdirSync(bin);
  for (const tool of TOOLS) fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home, env: { HOME: home, SHELL: '/bin/bash', PATH: bin } };
}

function download(root, version) {
  const top = path.join(root, `agent-guild-${version}-linux-x64`);
  const pkg = path.join(top, 'agent-guild', 'lib', 'node_modules', '@oddessentials', 'agent-guild');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'agent-guild', 'bin'));
  fs.symlinkSync(process.execPath, path.join(top, 'agent-guild', 'bin', 'node'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@oddessentials/agent-guild', version }));
  const calls = JSON.stringify(path.join(root, 'calls'));
  fs.writeFileSync(path.join(pkg, 'bin', 'agent-guild.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${calls}, '${version} ' + process.argv.slice(2).join(' ') + '\\n');\n`);
  fs.mkdirSync(path.join(pkg, 'src', 'manager'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'src', 'manager', 'launchers.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${calls}, '${version} launchers ' + process.argv[1] + '\\n');\n`);
  fs.copyFileSync(INSTALL_SH, path.join(top, 'install.sh'));
  return path.join(top, 'install.sh');
}

const run = (file, args, env) => execFileSync('/bin/sh', [file, ...args], { env, encoding: 'utf8' });
const block = (app) => `# >>> Agent Guild >>>\ncase ":$PATH:" in *":${app}/launcher:"*) ;; *) export PATH="$PATH":"${app}/launcher" ;; esac\n# <<< Agent Guild <<<\n`;
const app = (home) => path.join(home, '.local', 'share', 'agent-guild');
const refreshed = (home, version) => `${version} launchers ${path.join(app(home), 'lib', 'node_modules', '@oddessentials', 'agent-guild', 'src', 'manager', 'launchers.mjs')}\n`;
function userData(home) {
  const dir = path.join(home, '.config', 'agent-guild');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{"mine":true}');
  return () => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
}

test('install.sh installs for the user, with only its launcher folder on PATH, and keeps user data', { skip: process.platform === 'win32' }, (t) => {
  const { root, home, env } = fixture(t);
  const data = userData(home);
  fs.writeFileSync(path.join(home, '.profile'), 'echo mine\n');
  const out = run(download(root, '1.0.0'), [], env);
  assert.match(out, /Agent Guild 1\.0\.0 is installed/);
  assert.match(out, /launcher\/agent-guild"/);
  assert.ok(fs.existsSync(path.join(app(home), 'install.sh')));
  assert.ok(fs.statSync(path.join(app(home), 'launcher')).isDirectory());
  assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), `echo mine\n\n${block(app(home))}`);
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), refreshed(home, '1.0.0'));
  assert.equal(data(), '{"mine":true}');
});

test('install.sh over an install stops its manager, keeps the tools npm added and writes PATH once', { skip: process.platform === 'win32' }, (t) => {
  const { root, home, env } = fixture(t);
  const data = userData(home);
  run(download(root, '1.0.0'), [], env);
  const app = path.join(home, '.local', 'share', 'agent-guild');
  fs.mkdirSync(path.join(app, 'lib', 'node_modules', '@openai', 'codex'), { recursive: true });
  fs.mkdirSync(path.join(app, 'lib', 'node_modules', '@oddessentials', 'other'), { recursive: true });
  fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(app, 'bin', 'codex'));
  fs.writeFileSync(path.join(app, 'lib', 'node_modules', '@oddessentials', 'agent-guild', 'left-over.js'), '');
  run(download(root, '1.1.0'), [], env);
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), `${refreshed(home, '1.0.0')}1.0.0 stop\n${refreshed(home, '1.1.0')}`);
  assert.equal(data(), '{"mine":true}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'lib', 'node_modules', '@oddessentials', 'agent-guild', 'package.json'), 'utf8')).version, '1.1.0');
  assert.equal(fs.existsSync(path.join(app, 'lib', 'node_modules', '@oddessentials', 'agent-guild', 'left-over.js')), false);
  assert.ok(fs.existsSync(path.join(app, 'lib', 'node_modules', '@openai', 'codex')));
  assert.ok(fs.existsSync(path.join(app, 'lib', 'node_modules', '@oddessentials', 'other')));
  assert.equal(fs.readlinkSync(path.join(app, 'bin', 'codex')), '../lib/node_modules/@openai/codex/bin/codex.js');
  assert.deepEqual(fs.readdirSync(path.dirname(app)), ['agent-guild']);
  assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), block(app));
});

test('install.sh --uninstall stops the manager, removes the install and its PATH block only, and names the commands it removed', { skip: process.platform === 'win32' }, (t) => {
  const { root, home, env } = fixture(t);
  const data = userData(home);
  fs.writeFileSync(path.join(home, '.bash_profile'), 'echo before\n');
  run(download(root, '1.0.0'), [], env);
  fs.appendFileSync(path.join(home, '.bash_profile'), 'echo after\n');
  const app = path.join(home, '.local', 'share', 'agent-guild');
  for (const name of ['agent-guild', 'agent-guild-report', 'codex']) fs.writeFileSync(path.join(app, 'launcher', name), '');
  const out = run(path.join(app, 'install.sh'), ['--uninstall'], env);
  assert.match(out, /Your Agent Guild data and settings are kept\.\nThese commands installed into its folder were removed with it: codex\n$/);
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), `${refreshed(home, '1.0.0')}1.0.0 stop\n`);
  assert.equal(fs.existsSync(app), false);
  assert.equal(data(), '{"mine":true}');
  assert.equal(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8'), 'echo before\n\necho after\n');
});

function zshInstall(t, setup) {
  const { root, home, env } = fixture(t);
  const zdotdir = path.join(home, '.config', 'zsh');
  fs.mkdirSync(zdotdir, { recursive: true });
  const zsh = { ...env, SHELL: ZSH, ...setup(home, zdotdir) };
  const rc = path.join(fs.existsSync(path.join(home, '.zshenv')) || zsh.ZDOTDIR ? zdotdir : home, '.zshrc');
  fs.writeFileSync(rc, 'alias mine=true\n');
  run(download(root, '1.0.0'), [], zsh);
  const app = path.join(home, '.local', 'share', 'agent-guild');
  fs.writeFileSync(path.join(app, 'launcher', 'agent-guild'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(fs.readFileSync(rc, 'utf8'), `alias mine=true\n\n${block(app)}`);
  const interactive = (command) => execFileSync(ZSH, ['-ic', command], { env: zsh, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(interactive('command -v agent-guild'), path.join(app, 'launcher', 'agent-guild'));
  assert.deepEqual(interactive(`${ZSH} -ic 'print -r -- $PATH'`).split(':').filter((dir) => dir === path.join(app, 'launcher')), [path.join(app, 'launcher')]);
  run(path.join(app, 'install.sh'), ['--uninstall'], zsh);
  assert.equal(fs.readFileSync(rc, 'utf8'), 'alias mine=true\n');
  return home;
}

test('install.sh writes zsh\'s ~/.zshrc when ZDOTDIR is unset, and --uninstall removes only its block', { skip: !ZSH }, (t) => {
  const home = zshInstall(t, () => ({}));
  assert.equal(fs.existsSync(path.join(home, '.config', 'zsh', '.zshrc')), false);
});

test('install.sh writes zsh\'s .zshrc in an exported ZDOTDIR, and --uninstall removes only its block', { skip: !ZSH }, (t) => {
  const home = zshInstall(t, (_, zdotdir) => ({ ZDOTDIR: zdotdir }));
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
});

test('install.sh writes zsh\'s .zshrc in a ZDOTDIR that ~/.zshenv sets without exporting, and --uninstall removes only its block', { skip: !ZSH }, (t) => {
  const home = zshInstall(t, (home, zdotdir) => {
    fs.writeFileSync(path.join(home, '.zshenv'), `ZDOTDIR=${zdotdir}\n`);
    return {};
  });
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
  assert.equal(fs.readFileSync(path.join(home, '.zshenv'), 'utf8'), `ZDOTDIR=${path.join(home, '.config', 'zsh')}\n`);
});

test('install.sh installs nothing when zsh cannot say where its .zshrc is', { skip: !ZSH }, (t) => {
  const { root, home, env } = fixture(t);
  fs.writeFileSync(path.join(home, '.zshenv'), 'exit 3\n');
  assert.throws(() => execFileSync('/bin/sh', [download(root, '1.0.0')], { env: { ...env, SHELL: ZSH }, encoding: 'utf8', stdio: 'pipe' }), /did not say which folder its \.zshrc is in\. Nothing was installed\./);
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
});
