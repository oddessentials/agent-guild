import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BOOT_LAUNCHER,
  BOOT_LAUNCHER_SCRIPT,
  EXIT_PORT_IN_USE,
  SERVICE,
  SHOW_PROPERTIES,
  UNIT_UNSAFE,
  bootSupported,
  createBootService,
  describeStartup,
  journalCommand,
  lingerCommand,
  parseShow,
  parseTimestamp,
  serviceUnit,
  startupState,
  systemdRunner,
  unitArgs,
  unitPort,
} from '../src/manager/systemd-service.mjs';
import { fakeSystemd } from './fixtures/fake-systemd.mjs';

const posix = { skip: process.platform === 'win32' && 'systemd units run on Linux' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-systemd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the unit runs the launcher under systemd supervision, keeps tmux alive and stops a port clash from looping', () => {
  const unit = serviceUnit({ launcher: '/d/boot.sh', execPath: '/n/node', script: '/p/agent-guild.mjs', file: '/c/agent-guild.service', port: 47821 });
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, new RegExp(`^RestartPreventExitStatus=${EXIT_PORT_IN_USE}$`, 'm'));
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^StartLimitBurst=5$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  assert.equal(unit.match(/^ExecStart=(.*)$/m)[1], '"/bin/sh" "/d/boot.sh" "/n/node" "/p/agent-guild.mjs" "/c/agent-guild.service" "47821"');
  assert.throws(() => serviceUnit({ launcher: '/d', execPath: '/n', script: '/p', file: '/c', port: 0 }), /listening/);
});

test('unit arguments keep spaces and percent signs, and read back as written', () => {
  const paths = { launcher: '/home/a b/boot.sh', execPath: '/opt/100%/node', script: '/p/agent guild.mjs', file: '/c/agent-guild.service', port: 51234 };
  const unit = serviceUnit(paths);
  assert.match(unit, /"\/opt\/100%%\/node"/);
  assert.deepEqual(unitArgs(unit), ['/bin/sh', paths.launcher, paths.execPath, paths.script, paths.file, '51234']);
  assert.equal(unitPort(unit), 51234);
  assert.equal(unitPort(null), null);
  assert.equal(unitPort('[Service]\n'), null);
  for (const bad of ['a"b', 'a`b', 'a$b', 'a\\b', 'a\nb']) assert.equal(UNIT_UNSAFE.test(bad), true, JSON.stringify(bad));
  assert.equal(UNIT_UNSAFE.test("/home/o'neil/a b/100%"), false);
});

test('only Linux outside WSL is supported', () => {
  assert.equal(bootSupported({ platform: 'linux', env: {}, release: '6.8.0-45-generic' }), true);
  assert.equal(bootSupported({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, release: '6.8.0' }), false);
  assert.equal(bootSupported({ platform: 'linux', env: {}, release: '5.15.153.1-microsoft-standard-WSL2' }), false);
  assert.equal(bootSupported({ platform: 'darwin', env: {}, release: '25.0.0' }), false);
  assert.equal(bootSupported({ platform: 'win32', env: {}, release: '10.0' }), false);
});

test('show output and UTC timestamps are parsed, and anything else reads as none', () => {
  assert.deepEqual(parseShow('ActiveState=active\nMainPID=42\nExecMainStartTimestamp=Mon 2026-10-05 18:40:29 UTC\nempty=\n'), {
    ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: 'Mon 2026-10-05 18:40:29 UTC', empty: '',
  });
  assert.equal(parseTimestamp('Mon 2026-10-05 18:40:29 UTC'), '2026-10-05T18:40:29.000Z');
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('n/a'), null);
  assert.equal(parseTimestamp('Mon 2026-10-05 18:40:29 CEST'), null);
});

test('the state follows systemd: off, running, another manager, starting, pending, stopped, port in use and failed', () => {
  const show = (over) => ({ UnitFileState: 'enabled', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', MainPID: '0', ExecMainStartTimestamp: '', InactiveEnterTimestamp: '', ...over });
  const since = 'Mon 2026-10-05 18:40:29 UTC';
  const iso = '2026-10-05T18:40:29.000Z';
  assert.equal(startupState(null), null);
  assert.equal(startupState(show({ UnitFileState: 'disabled', ActiveState: 'active' })), null, 'a unit that is not enabled is off');
  assert.equal(startupState(show({ UnitFileState: '' })), null);
  assert.equal(startupState(show({ UnitFileState: 'enabled-runtime' })), null, 'only a persistent enable counts');
  assert.deepEqual(startupState(show({ ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: since }), { pid: 42 }), { kind: 'running', since: iso, pid: 42 });
  assert.deepEqual(startupState(show({ ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: since })), { kind: 'running', since: iso, pid: 42 }, 'with no manager to compare, systemd runs one');
  assert.deepEqual(startupState(show({ ActiveState: 'active', MainPID: '42' }), { pid: 7, port: 47821 }), { kind: 'other', since: null, pid: 42, port: 47821 });
  assert.deepEqual(startupState(show({ ActiveState: 'activating' }), { pid: 7 }), { kind: 'starting' });
  assert.deepEqual(startupState(show({}), { pid: 7 }), { kind: 'pending' });
  assert.deepEqual(startupState(show({ ActiveState: 'deactivating' }), { pid: 7 }), { kind: 'pending' });
  assert.deepEqual(startupState(show({ InactiveEnterTimestamp: since })), { kind: 'stopped', at: iso });
  assert.deepEqual(startupState(show({ ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: String(EXIT_PORT_IN_USE), InactiveEnterTimestamp: since }), { pid: 7, port: 47821 }), { kind: 'port-in-use', at: iso, port: 47821 });
  assert.deepEqual(startupState(show({ ActiveState: 'failed', Result: 'start-limit-hit', ExecMainStatus: '1', InactiveEnterTimestamp: since }), { pid: 7 }), { kind: 'failed', at: iso, result: 'start-limit-hit', status: 1 });
});

test('the CLI wording names the next step, including lingering', () => {
  assert.equal(describeStartup(null), null);
  assert.match(describeStartup({ kind: 'running', since: '2026-10-05T18:40:29.000Z', pid: 4 }), /running under systemd \(2026-10-05T18:40:29\.000Z\)\.$/);
  assert.match(describeStartup({ kind: 'stopped', at: null }), /`agent-guild open` starts it\.$/);
  assert.ok(describeStartup({ kind: 'failed', at: null, result: 'exit-code', status: 1 }).endsWith(journalCommand()));
  assert.match(describeStartup({ kind: 'port-in-use', at: null, port: 47821 }), /held port 47821\.$/);
  assert.ok(describeStartup({ kind: 'running', since: null, pid: 4 }, { linger: false, user: 'ana' }).endsWith(lingerCommand('ana')));
});

test('the runner reaches the user manager through its runtime folder with fixed time and language', posix, async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'systemctl'), '#!/bin/sh\necho "$XDG_RUNTIME_DIR|$TZ|$LC_ALL|$*"\n', { mode: 0o755 });
  const run = systemdRunner({ uid: 1234, env: { PATH: `${dir}:/usr/bin:/bin`, XDG_RUNTIME_DIR: '/stale', TZ: 'Europe/Paris', LC_ALL: 'de_DE.UTF-8' } });
  assert.deepEqual(await run('systemctl', ['--user', 'show']), { status: 0, stdout: '/run/user/1234|UTC|C|--user show\n', stderr: '', missing: false });
  const gone = await systemdRunner({ uid: 1, env: { PATH: dir } })('no-such-systemctl', []);
  assert.equal(gone.missing, true);
});

test('read reports an unreachable or missing systemd with a reason, and lingering from its file', async (t) => {
  const dir = tempDir(t);
  const lingerDir = path.join(dir, 'linger');
  fs.mkdirSync(lingerDir);
  const make = (systemd) => createBootService({ env: {}, home: dir, user: 'ana', uid: 1000, dataDir: path.join(dir, 'data'), lingerDir, run: systemd.run });

  const missing = await make(fakeSystemd({ missing: true })).read();
  assert.deepEqual([missing.reachable, missing.enabled], [false, false]);
  assert.match(missing.reason, /does not use systemd/);

  const unreachable = await make(fakeSystemd({ reachable: false })).read();
  assert.equal(unreachable.reachable, false);
  assert.match(unreachable.reason, /user manager did not answer: Failed to connect to bus/);

  const systemd = fakeSystemd();
  const boot = make(systemd);
  assert.deepEqual(await boot.read().then(({ reachable, enabled, linger }) => ({ reachable, enabled, linger })), { reachable: true, enabled: false, linger: false });
  fs.writeFileSync(path.join(lingerDir, 'ana'), '');
  systemd.state.enabled = true;
  assert.deepEqual(await boot.read().then(({ reachable, enabled, linger }) => ({ reachable, enabled, linger })), { reachable: true, enabled: true, linger: true });
  assert.deepEqual(systemd.calls.at(-1), ['systemctl', '--user', 'show', SERVICE, ...SHOW_PROPERTIES.map((p) => `--property=${p}`)]);
});

test('write puts the unit under the user config and the launcher in the data folder, and says whether the unit changed', posix, async (t) => {
  const dir = tempDir(t);
  const boot = createBootService({ env: { XDG_CONFIG_HOME: path.join(dir, 'xdg') }, home: dir, user: 'ana', uid: 1000, dataDir: path.join(dir, 'data'), run: fakeSystemd().run });
  assert.equal(boot.file, path.join(dir, 'xdg', 'systemd', 'user', SERVICE));
  assert.equal(boot.launcher, path.join(dir, 'data', BOOT_LAUNCHER));
  const paths = { execPath: '/n/node', script: '/p/agent-guild.mjs', port: 47821 };
  assert.equal(await boot.write(paths), true);
  assert.equal(await boot.write(paths), false, 'an unchanged unit needs no reload');
  assert.equal(fs.readFileSync(boot.launcher, 'utf8'), BOOT_LAUNCHER_SCRIPT);
  assert.equal(fs.statSync(boot.launcher).mode & 0o777, 0o755);
  assert.equal(fs.statSync(boot.file).mode & 0o777, 0o644);
  assert.equal(unitPort(await boot.text()), 47821);
  assert.equal(await boot.write({ ...paths, port: 51234 }), true);
  assert.equal(unitPort(await boot.text()), 51234);
});

test('remove disables and deletes the unit, its wants link and launcher, never stops it, and still deletes them when systemd does not answer', posix, async (t) => {
  for (const reachable of [true, false]) {
    const dir = tempDir(t);
    const systemd = fakeSystemd({ reachable });
    const boot = createBootService({ env: {}, home: dir, user: 'ana', uid: 1000, dataDir: path.join(dir, 'data'), run: systemd.run });
    await boot.write({ execPath: '/n', script: '/p', port: 47821 });
    const wants = path.join(path.dirname(boot.file), 'default.target.wants', SERVICE);
    fs.mkdirSync(path.dirname(wants));
    fs.symlinkSync(boot.file, wants);
    await boot.remove();
    for (const file of [boot.file, boot.launcher]) assert.equal(fs.existsSync(file), false, file);
    assert.equal(fs.lstatSync(wants, { throwIfNoEntry: false }), undefined);
    assert.deepEqual(systemd.verbs(), ['disable', 'daemon-reload']);
  }
});

test('commands that fail say what failed', async (t) => {
  const dir = tempDir(t);
  const systemd = fakeSystemd();
  const boot = createBootService({ env: {}, home: dir, user: 'ana', uid: 1000, dataDir: dir, run: systemd.run });
  systemd.state.fail.add('enable');
  await assert.rejects(boot.enable(), (err) => err.code === 'autostart_failed' && /Could not enable the systemd unit: enable refused/.test(err.message));
  systemd.state.fail.add('start');
  await assert.rejects(boot.start(), /Could not start the systemd unit/);
  assert.equal(await boot.journal(5), 'line one\nline two');
  await boot.start({ block: false }).catch(() => {});
  assert.deepEqual(systemd.calls.at(-1), ['systemctl', '--user', 'start', '--no-block', SERVICE]);
});

test('the launcher runs the manager in the foreground while the package is there, and removes the unit and itself once it is gone', posix, (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  const data = path.join(dir, 'data dir%x');
  const launcher = path.join(data, BOOT_LAUNCHER);
  const script = path.join(dir, 'pkg', "agent guild 'x'.mjs");
  const unit = path.join(dir, SERVICE);
  const ran = path.join(dir, 'ran.json');
  const calls = path.join(dir, 'systemctl.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(data);
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
  fs.writeFileSync(launcher, BOOT_LAUNCHER_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ args: process.argv.slice(2), port: process.env.AGENT_GUILD_PORT, pid: process.pid }));\n`);
  fs.writeFileSync(unit, 'unit');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_GUILD_PORT: '1' };
  const run = (execPath) => spawnSync('/bin/sh', [launcher, execPath, script, unit, '51234'], { encoding: 'utf8', env });

  assert.equal(run(process.execPath).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')).args, ['start', '--service']);
  assert.equal(JSON.parse(fs.readFileSync(ran, 'utf8')).port, '51234', 'the unit\'s port, whatever was inherited');
  // exec: the manager is the process systemd started, so MainPID names it.
  const direct = spawnSync(launcher, [process.execPath, script, unit, '51234'], { encoding: 'utf8', env });
  assert.equal(direct.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ran, 'utf8')).pid, direct.pid);
  assert.equal(fs.existsSync(calls), false, 'systemd is not touched while the package is there');

  // A missing Node.js fails, so systemd retries and then reports it; the unit stays for the next manager to repair.
  assert.notEqual(run(path.join(dir, 'gone', 'node')).status, 0);
  assert.equal(fs.existsSync(unit), true);
  assert.equal(fs.existsSync(launcher), true);

  fs.rmSync(path.dirname(script), { recursive: true });
  fs.rmSync(ran);
  const gone = run(process.execPath);
  assert.equal(gone.status, 0, 'a clean exit, so systemd does not start it again');
  assert.match(gone.stdout, /no longer installed/);
  assert.equal(fs.existsSync(ran), false);
  assert.equal(fs.existsSync(unit), false);
  assert.equal(fs.existsSync(launcher), false);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [`--user disable ${SERVICE}`, '--user daemon-reload']);
});

test('systemd reads the unit as written', { skip: !hasAnalyze() && 'systemd-analyze is not installed' }, (t) => {
  const dir = tempDir(t);
  const launcher = path.join(dir, 'data 100%', BOOT_LAUNCHER);
  fs.mkdirSync(path.dirname(launcher));
  fs.writeFileSync(launcher, BOOT_LAUNCHER_SCRIPT, { mode: 0o755 });
  const file = path.join(dir, SERVICE);
  fs.writeFileSync(file, serviceUnit({ launcher, execPath: process.execPath, script: launcher, file, port: 47821 }));
  // Unknown keys and unusable commands are warnings on stderr, so an empty stderr is the check. The
  // system manager's rules read a unit's syntax as the user manager's do, and need no user runtime folder.
  const r = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' });
});

function hasAnalyze() {
  if (process.platform !== 'linux') return false;
  return spawnSync('systemd-analyze', ['--version']).status === 0;
}
