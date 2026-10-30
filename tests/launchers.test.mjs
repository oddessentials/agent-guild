import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultFsx } from '../src/manager/install-channels.mjs';
import { launcherTarget, refreshLaunchers } from '../src/manager/launchers.mjs';

function prefix(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-guild-it's-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
};

test('each command npm installed beside an installer\'s Node.js gets a launcher on that Node.js, and Node.js and npm get none', { skip: process.platform === 'win32' }, (t) => {
  const root = prefix(t);
  const bin = path.join(root, 'bin');
  write(path.join(bin, 'node'), '#!/bin/sh\necho "bundled $*"\n');
  for (const name of ['npm', 'npx', 'corepack']) write(path.join(bin, name), '#!/usr/bin/env node\n');
  write(path.join(root, 'lib', 'node_modules', 'tool', 'cli.js'), '#!/usr/bin/env node\n');
  fs.symlinkSync('../lib/node_modules/tool/cli.js', path.join(bin, 'codex'));
  write(path.join(bin, 'native'), '#!/bin/sh\necho "native $*"\n');
  write(path.join(root, 'launcher', 'removed'), '');

  refreshLaunchers({ execPath: path.join(bin, 'node'), platform: 'linux' });

  assert.deepEqual(fs.readdirSync(path.join(root, 'launcher')).sort(), ['codex', 'native']);
  const decoy = path.join(root, 'decoy');
  write(path.join(decoy, 'node'), '#!/bin/sh\necho decoy\n');
  const env = { PATH: `${decoy}:/usr/bin:/bin` };
  assert.equal(execFileSync(path.join(root, 'launcher', 'codex'), ['a b'], { env, encoding: 'utf8' }), `bundled ${path.join(bin, 'codex')} a b\n`);
  assert.equal(execFileSync(path.join(root, 'launcher', 'native'), ['c'], { env, encoding: 'utf8' }), 'native c\n');

  fs.rmSync(path.join(bin, 'codex'));
  refreshLaunchers({ execPath: path.join(bin, 'node'), platform: 'linux' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'launcher')), ['native']);
});

test('on Windows each npm command but Node.js\'s own gets a launcher for Command Prompt and PowerShell, and one for Git Bash where npm wrote one', (t) => {
  const root = prefix(t);
  for (const name of ['node.exe', 'npm.cmd', 'npm', 'npx.cmd', 'corepack.cmd', 'agent-guild.cmd', 'agent-guild', 'agent-guild.ps1', 'codex.cmd', 'codex.ps1', 'codex', 'cmd-only.cmd']) write(path.join(root, name), '');
  write(path.join(root, 'launcher', 'removed'), '');

  refreshLaunchers({ execPath: path.join(root, 'node.exe'), platform: 'win32' });

  assert.deepEqual(fs.readdirSync(path.join(root, 'launcher')).sort(), ['agent-guild', 'agent-guild.cmd', 'cmd-only.cmd', 'codex', 'codex.cmd']);
  assert.equal(fs.readFileSync(path.join(root, 'launcher', 'codex.cmd'), 'utf8'), '@"%~dp0..\\codex.cmd" %*\r\n');
  assert.equal(fs.readFileSync(path.join(root, 'launcher', 'codex'), 'utf8'), '#!/bin/sh\nexec "$(dirname "$0")/../codex" "$@"\n');

  fs.rmSync(path.join(root, 'codex.cmd'));
  fs.rmSync(path.join(root, 'codex'));
  refreshLaunchers({ execPath: path.join(root, 'node.exe'), platform: 'win32' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'launcher')).sort(), ['agent-guild', 'agent-guild.cmd', 'cmd-only.cmd']);
});

test('the Git Bash launcher runs the command npm wrote beside it, by bare name, with its arguments', { skip: process.platform === 'win32' }, (t) => {
  const root = prefix(t);
  write(path.join(root, 'node.exe'), '');
  write(path.join(root, 'codex.cmd'), '');
  write(path.join(root, 'codex'), '#!/bin/sh\nprintf "%s|" "$@"\n');
  fs.mkdirSync(path.join(root, 'launcher'));
  refreshLaunchers({ execPath: path.join(root, 'node.exe'), platform: 'win32' });
  assert.equal(execFileSync('/bin/sh', ['-c', 'codex "a b" c'], { env: { PATH: `${path.join(root, 'launcher')}:/usr/bin:/bin` }, encoding: 'utf8' }), 'a b|c|');
});

test('launcherTarget names the command behind exactly the launchers written here, also through a linked folder, and nothing else', { skip: process.platform === 'win32' }, (t) => {
  const root = prefix(t);
  const bin = path.join(root, 'bin');
  write(path.join(bin, 'node'), '');
  write(path.join(root, 'lib', 'node_modules', 'tool', 'cli.js'), '#!/usr/bin/env node\n');
  fs.symlinkSync('../lib/node_modules/tool/cli.js', path.join(bin, 'codex'));
  write(path.join(bin, 'native'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(root, 'launcher'));
  const linked = `${root}-link`;
  fs.symlinkSync(root, linked);
  t.after(() => fs.rmSync(linked, { force: true }));
  refreshLaunchers({ execPath: path.join(linked, 'bin', 'node'), platform: 'linux' });

  for (const dir of [root, linked]) {
    assert.equal(launcherTarget(path.join(dir, 'launcher', 'codex'), 'linux', defaultFsx), path.join(bin, 'codex'));
    assert.equal(launcherTarget(path.join(dir, 'launcher', 'native'), 'linux', defaultFsx), path.join(bin, 'native'));
  }
  fs.appendFileSync(path.join(root, 'launcher', 'codex'), '# mine\n');
  assert.equal(launcherTarget(path.join(root, 'launcher', 'codex'), 'linux', defaultFsx), path.join(root, 'launcher', 'codex'));
  assert.equal(launcherTarget(path.join(bin, 'codex'), 'linux', defaultFsx), path.join(bin, 'codex'));
});

const gitBash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : null;

function windowsTool(t) {
  const root = prefix(t);
  write(path.join(root, 'node.exe'), '');
  write(path.join(root, 'guild-tool.cmd'), '@echo cmd %*\r\n');
  write(path.join(root, 'guild-tool'), '#!/bin/sh\necho "sh $*"\n');
  fs.mkdirSync(path.join(root, 'launcher'));
  refreshLaunchers({ execPath: path.join(root, 'node.exe'), platform: 'win32' });
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const system = path.join(process.env.SystemRoot, 'System32');
  return { ...process.env, [key]: [path.join(root, 'launcher'), system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';') };
}

test('on Windows a bare launcher name runs from Command Prompt and PowerShell', { skip: process.platform !== 'win32' }, (t) => {
  const env = windowsTool(t);
  assert.equal(execFileSync('cmd.exe', ['/d', '/c', 'guild-tool a'], { env, encoding: 'utf8' }).trim(), 'cmd a');
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'guild-tool a'], { env, encoding: 'utf8' }).trim(), 'cmd a');
});

test('on Windows a bare launcher name runs from Git Bash', { skip: !gitBash || !fs.existsSync(gitBash) }, (t) => {
  const env = windowsTool(t);
  assert.equal(execFileSync(gitBash, ['-lc', 'guild-tool a'], { env, encoding: 'utf8' }).trim(), 'sh a');
});

test('a Node.js without a launcher folder beside it is left alone', (t) => {
  const root = prefix(t);
  write(path.join(root, 'bin', 'codex'), '#!/usr/bin/env node\n');
  refreshLaunchers({ execPath: path.join(root, 'bin', 'node'), platform: 'linux' });
  assert.deepEqual(fs.readdirSync(root), ['bin']);
});
