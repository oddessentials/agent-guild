import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { MACOS_TEAM, WINDOWS_PUBLISHER, installCompanion } from '../src/manager/companion.mjs';
import { loadProviders } from '../src/manager/providers.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const RELEASES = 'https://github.com/oddessentials/agent-guild-companions/releases';
const WINDOWS = 'Grove-Companion-windows-setup.exe';
const MAC = 'Grove-Companion-macos.dmg';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const unlocked = folder => fs.openSync(path.join(folder, '.grove-companion-install.lock'), 'a');

function release({ name, body = Buffer.from(`${name} bytes`), listed = sha256(body), tagUrl = `${RELEASES}/tag/v0.4.0` } = {}) {
  const files = { [name]: body, SHA256SUMS: Buffer.from(`${listed}  ${name}\n`) };
  const fetches = [];
  const fetch = async (url) => {
    fetches.push(url);
    if (url === `${RELEASES}/latest`) return { ok: true, status: 200, url: tagUrl };
    const file = url.startsWith(`${RELEASES}/download/v0.4.0/`) && files[url.slice(`${RELEASES}/download/v0.4.0/`.length)];
    return file ? { ok: true, status: 200, arrayBuffer: async () => file } : { ok: false, status: 404 };
  };
  return { fetch, fetches };
}

function commands(reply) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push([path.win32.basename(file), ...args]);
    return { status: 0, stdout: '', stderr: '', ...reply(path.win32.basename(file), args, options) };
  };
  return { run, calls };
}

function folders(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tmp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-home-'));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  return { tmp, home };
}

const windowsSignature = (signature) => (file) => file === 'powershell.exe' ? { stdout: JSON.stringify(signature) } : {};

test('on Windows a verified installer runs silently and starts the app', async (t) => {
  const { tmp } = folders(t);
  const { fetch, fetches } = release({ name: WINDOWS });
  const { run, calls } = commands(windowsSignature({ status: 'Valid', subject: WINDOWS_PUBLISHER, timestamped: true }));
  const lines = [];
  assert.equal(await installCompanion({ platform: 'win32', env: {}, fetch, run, log: (line) => lines.push(line), tmp }), 0, lines.join('\n'));
  assert.deepEqual(fetches.slice(1).sort(), [`${RELEASES}/download/v0.4.0/${WINDOWS}`, `${RELEASES}/download/v0.4.0/SHA256SUMS`].sort());
  assert.deepEqual(calls.map((call) => call[0]), ['powershell.exe', WINDOWS]);
  assert.deepEqual(calls[1].slice(1), ['/S', '/R']);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('on Windows an installer that is not signed and timestamped by the publisher never runs', async (t) => {
  for (const signature of [
    { status: 'NotSigned', subject: '', timestamped: false },
    { status: 'Valid', subject: 'CN=Someone Else', timestamped: true },
    { status: 'Valid', subject: WINDOWS_PUBLISHER, timestamped: false },
  ]) {
    const { tmp } = folders(t);
    const { run, calls } = commands(windowsSignature(signature));
    const lines = [];
    assert.equal(await installCompanion({ platform: 'win32', env: {}, fetch: release({ name: WINDOWS }).fetch, run, log: (line) => lines.push(line), tmp }), 1);
    assert.deepEqual(calls.map((call) => call[0]), ['powershell.exe']);
    assert.match(lines.at(-1), /not run/);
  }
});

test('an installer that does not match SHA256SUMS is never run', async (t) => {
  for (const [platform, name] of [['win32', WINDOWS], ['darwin', MAC]]) {
    const { tmp, home } = folders(t);
    const { run, calls } = commands(() => ({}));
    const lines = [];
    const applications = path.join(home, 'SystemApplications');
    assert.equal(await installCompanion({ platform, env: {}, fetch: release({ name, listed: sha256('other') }).fetch, run, log: (line) => lines.push(line), tmp, home, applications, writable: () => false, acquireLock: unlocked }), 1);
    assert.deepEqual(calls, []);
    assert.match(lines.at(-1), /does not match the release’s SHA256SUMS/);
  }
});

test('a release page without a version tag stops before downloading', async (t) => {
  const { tmp } = folders(t);
  const { fetch, fetches } = release({ name: WINDOWS, tagUrl: `${RELEASES}` });
  const lines = [];
  assert.equal(await installCompanion({ platform: 'win32', env: {}, fetch, run: () => assert.fail('nothing runs'), log: (line) => lines.push(line), tmp }), 1);
  assert.deepEqual(fetches, [`${RELEASES}/latest`]);
  assert.match(lines.at(-1), /Could not find the latest Grove Companion release/);
});

const APP = 'Grove Companion.app';
const BUNDLE_ID = 'com.oddessentials.agentguild.companion';

function bundle(dir, version, id = BUNDLE_ID) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version'), version);
  fs.writeFileSync(path.join(dir, 'id'), id);
}

const macReply = ({ team = MACOS_TEAM, id = BUNDLE_ID, notarized = true, running = 0 } = {}) => {
  let checks = running;
  return (file, args) => {
    if (file === 'hdiutil' && args[0] === 'attach') bundle(path.join(args[args.indexOf('-mountpoint') + 1], APP), 'new');
    if (file === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
    if (file === 'codesign' && args[0] === '--verify') return { status: fs.existsSync(path.join(args.at(-1), 'version')) ? 0 : 1 };
    if (file === 'codesign' && args[0] === '-dv') {
      const own = path.join(args.at(-1), 'id');
      return { stderr: `Executable=x\nTeamIdentifier=${team}\nIdentifier=${id === BUNDLE_ID && fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : id}\n` };
    }
    if (file === 'plutil') {
      const id = path.join(path.dirname(path.dirname(args.at(-1))), 'id');
      return fs.existsSync(id) ? { stdout: `${fs.readFileSync(id, 'utf8')}\n` } : { status: 1 };
    }
    if (file === 'spctl') return notarized ? { stderr: 'accepted\nsource=Notarized Developer ID\n' } : { status: 3, stderr: 'rejected\n' };
    if (file === 'pkill') return { status: running ? 0 : 1 };
    if (file === 'pgrep') return { status: checks-- > 0 ? 0 : 1 };
    return {};
  };
};

function macInstaller(t, { existing = false, reply, ...verification } = {}) {
  const { tmp, home } = folders(t);
  const applications = path.join(home, 'SystemApplications');
  fs.mkdirSync(applications);
  const folder = path.join(home, 'Applications');
  const target = path.join(folder, APP);
  const work = path.join(folder, '.grove-companion-install');
  const previous = path.join(work, 'previous.app');
  const staged = path.join(work, 'staged.app');
  if (existing) bundle(target, 'old');
  const base = macReply(verification);
  const { run, calls } = commands((...args) => reply?.(...args) ?? base(...args));
  const lines = [], waits = [];
  let time = 0;
  const install = (overrides = {}) => installCompanion({
    platform: 'darwin', env: {}, fetch: release({ name: MAC }).fetch, run, log: line => lines.push(line), tmp, home, applications,
    writable: dir => dir !== applications, now: () => time, wait: ms => { waits.push(ms); time += ms; }, acquireLock: unlocked, ...overrides,
  });
  const version = (dir = target) => fs.readFileSync(path.join(dir, 'version'), 'utf8');
  return { install, run, tmp, home, applications, folder, target, work, staged, previous, calls, lines, waits, version };
}

test('on macOS a verified app is staged on the destination filesystem, verified again, installed and opened', async (t) => {
  const f = macInstaller(t);
  assert.equal(await f.install(), 0, f.lines.join('\n'));
  assert.equal(f.version(), 'new');
  const copy = f.calls.find(call => call[0] === 'ditto');
  assert.equal(copy[2], f.staged);
  assert.ok(f.calls.some(call => call[0] === 'codesign' && call.at(-1) === f.staged));
  assert.ok(f.calls.some(call => call[0] === 'open' && call[1] === f.target));
  assert.equal(fs.existsSync(f.work), false);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
});

test('on macOS a running companion is quit and waited for before it is replaced', async (t) => {
  const f = macInstaller(t, { existing: true, running: 2, reply: (file) => {
    if (file === 'ditto' || file === 'pkill' || file === 'pgrep') assert.equal(f.version(), 'old');
  } });
  assert.equal(await f.install(), 0);
  assert.equal(f.version(), 'new');
  assert.deepEqual(f.waits, [100, 100]);
  assert.ok(f.calls.findIndex(c => c[0] === 'ditto') < f.calls.findIndex(c => c[0] === 'pkill'));
  const pattern = f.calls.find(c => c[0] === 'pkill')[2];
  assert.ok(pattern.startsWith('^'));
  assert.ok(pattern.includes('Grove Companion\\.app/Contents/MacOS/'));
  assert.equal(new RegExp(pattern).test(f.target + '/Contents/MacOS/agent-guild-companions'), true);
  assert.equal(new RegExp(pattern).test('/elsewhere/' + APP + '/Contents/MacOS/agent-guild-companions'), false);
  assert.equal(new RegExp(pattern).test('other-command ' + f.target + '/Contents/MacOS/agent-guild-companions'), false);
});

test('on macOS the wrong team or a missing notarization installs nothing and still detaches the image', async (t) => {
  for (const [verification, message] of [[{ team: 'ABCDE12345' }, /signed by team ABCDE12345/], [{ notarized: false }, /not accept the app as notarized/], [{ id: 'another.app' }, /not the Grove Companion/]]) {
    const f = macInstaller(t, verification);
    assert.equal(await f.install(), 1);
    assert.equal(f.calls.some(call => ['ditto', 'open', 'pkill'].includes(call[0])), false);
    assert.deepEqual(f.calls.at(-1).slice(0, 2), ['hdiutil', 'detach']);
    assert.match(f.lines.at(-1), message);
  }
});

test('copy or staged-verification failures leave the old app intact without stopping it', async (t) => {
  for (const failCopy of [true, false]) {
    const f = macInstaller(t, { existing: true, reply: (file, args) => {
      if (file === 'ditto') {
        fs.mkdirSync(args[1]);
        fs.writeFileSync(path.join(args[1], 'partial'), 'incomplete');
        return { status: failCopy ? 1 : 0 };
      }
    } });
    assert.equal(await f.install(), 1);
    assert.equal(f.version(), 'old');
    assert.equal(f.calls.some(c => ['pkill', 'open'].includes(c[0])), false);
    assert.equal(fs.existsSync(f.work), false);
  }
});

test('a process still running after a forced quit prevents replacement, with a final probe after each wait', async (t) => {
  const f = macInstaller(t, { existing: true, running: Infinity });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.equal(f.waits.reduce((a, b) => a + b, 0), 10000);
  assert.equal(f.calls.filter(c => c[0] === 'pgrep').length, 102);
  assert.deepEqual(f.calls.filter(c => c[0] === 'pkill').map(c => c[1]), ['-f', '-KILL']);
  assert.equal(f.calls.some(c => c[0] === 'open'), false);
  assert.match(f.lines.at(-1), /still running/);
});

test('a companion that does not quit within 5 s is forced to, then replaced and opened', async (t) => {
  const f = macInstaller(t, { existing: true, running: 60 });
  assert.equal(await f.install(), 0, f.lines.join('\n'));
  assert.equal(f.version(), 'new');
  assert.deepEqual(f.calls.filter(c => c[0] === 'pkill').map(c => c[1]), ['-f', '-KILL']);
  assert.ok(f.calls.some(c => c[0] === 'open' && c[1] === f.target));
});

test('a replacement that fails after the companion was quit opens the old app again', async (t) => {
  const f = macInstaller(t, { existing: true, running: 1 });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === f.staged) throw new Error('injected rename failure');
    return rename(from, to);
  });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.deepEqual(f.calls.filter(c => c[0] === 'open').map(c => c[1]), [f.target]);
});

function killedInstall(f, at) {
  const companion = new URL('../src/manager/companion.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import crypto from 'node:crypto';
    import { installCompanion, MACOS_TEAM } from ${JSON.stringify(companion)};
    const at = ${JSON.stringify(at)}, target = ${JSON.stringify(f.target)}, staged = ${JSON.stringify(f.staged)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if ((at === 'aside' && from === target) || (at === 'commit' && from === staged)) process.kill(process.pid, 'SIGKILL');
    };
    const body = Buffer.from('dmg'), releases = ${JSON.stringify(RELEASES)};
    const fetch = async (url) => url.endsWith('/latest') ? { ok: true, url: releases + '/tag/v0.4.0' } : { ok: true, arrayBuffer: async () => url.endsWith('SHA256SUMS')
      ? Buffer.from(crypto.createHash('sha256').update(body).digest('hex') + '  ${MAC}\\n') : body };
    const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const run = (file, args) => {
      const name = path.basename(file), app = args.at(-1);
      if (name === 'hdiutil' && args[0] === 'attach') {
        const mounted = path.join(args[args.indexOf('-mountpoint') + 1], ${JSON.stringify(APP)});
        fs.mkdirSync(mounted, { recursive: true });
        fs.writeFileSync(path.join(mounted, 'version'), 'new');
        fs.writeFileSync(path.join(mounted, 'id'), ${JSON.stringify(BUNDLE_ID)});
      }
      if (name === 'ditto') {
        if (at === 'copy') {
          fs.mkdirSync(args[1], { recursive: true });
          fs.writeFileSync(path.join(args[1], 'partial'), 'incomplete');
          process.kill(process.pid, 'SIGKILL');
        }
        fs.cpSync(args[0], args[1], { recursive: true });
      }
      if (name === 'codesign' && args[0] === '--verify') return { status: fs.existsSync(path.join(app, 'version')) ? 0 : 1 };
      if (name === 'codesign') return { status: 0, stderr: 'TeamIdentifier=' + MACOS_TEAM + '\\nIdentifier=' + read(path.join(app, 'id')) + '\\n' };
      if (name === 'plutil') {
        const id = read(path.join(path.dirname(path.dirname(app)), 'id'));
        return id === null ? { status: 1 } : { status: 0, stdout: id };
      }
      if (name === 'spctl') return { status: 0, stderr: 'source=Notarized Developer ID' };
      return { status: name === 'pkill' || name === 'pgrep' ? 1 : 0, stdout: '', stderr: '' };
    };
    await installCompanion({ platform: 'darwin', fetch, run, log: () => {}, tmp: ${JSON.stringify(f.tmp)}, home: ${JSON.stringify(f.home)},
      applications: ${JSON.stringify(f.applications)}, writable: (dir) => dir !== ${JSON.stringify(f.applications)}, wait: () => {},
      acquireLock: (folder) => fs.openSync(path.join(folder, '.grove-companion-install.lock'), 'a') });
  `]);
}

test('an installer killed after any step leaves a usable app, and the next install completes', async (t) => {
  const offline = { fetch: async () => { throw new Error('offline'); } };
  for (const scenario of ['update', 'repair']) {
    for (const [at, survivor] of [['copy', scenario === 'update' ? 'old' : 'damaged'], ['aside', 'old'], ['commit', 'new']]) {
      const f = macInstaller(t, { existing: true });
      if (scenario === 'repair') {
        fs.mkdirSync(f.work);
        fs.renameSync(f.target, f.previous);
        bundle(f.target, 'damaged');
        fs.unlinkSync(path.join(f.target, 'version'));
      }
      const killed = killedInstall(f, at);
      const label = `${scenario}, killed at ${at}`;
      assert.ok(killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.status !== 0), `${label}: ${killed.status} ${killed.signal} ${killed.stderr}`);
      assert.equal(await f.install(offline), 1, label);
      assert.match(f.lines.at(-1), /offline/, label);
      if (survivor === 'damaged') {
        assert.equal(fs.readFileSync(path.join(f.target, 'id'), 'utf8'), BUNDLE_ID, label);
        assert.equal(f.version(f.previous), 'old', label);
        assert.deepEqual(fs.readdirSync(f.work), ['previous.app'], label);
      } else {
        assert.equal(f.version(), survivor, label);
        assert.equal(fs.existsSync(f.work), false, label);
      }
      assert.equal(await f.install(), 0, `${label}: ${f.lines.join('\n')}`);
      assert.equal(f.version(), 'new', label);
      assert.equal(fs.existsSync(f.work), false, label);
    }
  }
});

test('a backup does not let another app at the destination be replaced', async (t) => {
  const f = macInstaller(t, { existing: true });
  fs.mkdirSync(f.work);
  fs.renameSync(f.target, f.previous);
  bundle(f.target, 'other', 'com.example.other');
  assert.equal(await f.install(), 1);
  assert.match(f.lines.at(-1), /is not the Grove Companion/);
  assert.equal(f.version(), 'other');
  assert.equal(f.version(f.previous), 'old');
  assert.equal(f.calls.some(c => ['ditto', 'pkill', 'open'].includes(c[0])), false);
});

test('beside a backup, an app whose identity cannot be read is repaired', async (t) => {
  const f = macInstaller(t, { existing: true });
  fs.mkdirSync(f.work);
  fs.renameSync(f.target, f.previous);
  fs.mkdirSync(f.target);
  assert.equal(await f.install(), 0, f.lines.join('\n'));
  assert.equal(f.version(), 'new');
  assert.equal(fs.existsSync(f.work), false);
});

test('a damaged Grove Companion is replaced rather than blocking the reinstall that repairs it', async (t) => {
  const f = macInstaller(t, { existing: true });
  fs.unlinkSync(path.join(f.target, 'version'));
  assert.equal(await f.install(), 0, f.lines.join('\n'));
  assert.equal(f.version(), 'new');
});

test('hidden files such as .DS_Store in the installation folder do not block recovery', async (t) => {
  const f = macInstaller(t, { existing: true });
  fs.mkdirSync(f.work);
  fs.writeFileSync(path.join(f.work, '.DS_Store'), '');
  assert.equal(await f.install(), 0, f.lines.join('\n'));
  assert.equal(f.version(), 'new');
  assert.equal(fs.existsSync(f.work), false);
});

test('a disk image that cannot be attached is not detached, and its download is removed', async (t) => {
  const f = macInstaller(t, { existing: true, reply: (file, args) => file === 'hdiutil' && args[0] === 'attach' ? { status: 1 } : undefined });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.equal(f.calls.some(c => c[0] === 'hdiutil' && c[1] === 'detach'), false);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
  assert.equal(f.lines.some(line => /Could not detach/.test(line)), false);
  assert.match(f.lines.at(-1), /Could not open the disk image/);
});

test('a process exiting on the final deadline probe permits replacement', async (t) => {
  const f = macInstaller(t, { existing: true, running: 50 });
  assert.equal(await f.install(), 0);
  assert.equal(f.version(), 'new');
  assert.equal(f.waits.length, 50);
});

test('process command errors stop replacement, including spawn failure and signal termination', async (t) => {
  for (const command of ['pkill', 'pgrep']) {
    for (const result of [{ status: 2 }, { status: 3 }, { status: null, error: new Error('unavailable') }, { status: null, signal: 'SIGTERM' }]) {
      const f = macInstaller(t, { existing: true, reply: file => file === command ? result : undefined });
      assert.equal(await f.install(), 1);
      assert.equal(f.version(), 'old');
      assert.equal(f.calls.some(c => c[0] === 'open'), false);
      assert.match(f.lines.at(-1), /Could not confirm/);
    }
  }
});

test('pkill reporting no matches still requires a process-exit check', async (t) => {
  const f = macInstaller(t, { existing: true, running: Infinity, reply: file => file === 'pkill' ? { status: 1 } : undefined });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.equal(f.calls.some(c => c[0] === 'open'), false);
});

test('promotion failure restores the old app and rollback failure preserves it for the next attempt', async (t) => {
  for (const failRollback of [false, true]) {
    const f = macInstaller(t, { existing: true });
    const rename = fs.renameSync;
    const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === f.staged || (failRollback && from === f.previous)) throw new Error('injected rename failure');
      return rename(from, to);
    });
    assert.equal(await f.install(), 1);
    assert.deepEqual(f.calls.filter(c => c[0] === 'open').map(c => c[1]), failRollback ? [] : [f.target]);
    assert.equal(f.version(failRollback ? f.previous : f.target), 'old');
    if (failRollback) assert.ok(f.lines.at(-1).includes(f.previous));
    mocked.mock.restore();
    assert.equal(await f.install(), 0, f.lines.join('\n'));
    assert.equal(f.version(), 'new');
    assert.equal(fs.existsSync(f.work), false);
  }
});

test('failure to move the old bundle into backup leaves it intact', async (t) => {
  const f = macInstaller(t, { existing: true });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === f.target) throw new Error('permission denied');
    return rename(from, to);
  });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.equal(fs.existsSync(f.work), false);
  assert.deepEqual(f.calls.filter(c => c[0] === 'open').map(c => c[1]), [f.target]);
});

test('interrupted copies and swaps are recovered before another copy starts', async (t) => {
  for (const phase of ['copy', 'backup', 'promoted', 'backup-cleanup']) {
    const f = macInstaller(t, { existing: true, reply: file => {
      if (file === 'ditto') assert.equal(f.version(), ['promoted', 'backup-cleanup'].includes(phase) ? 'committed' : 'old');
    } });
    fs.mkdirSync(f.work);
    if (phase === 'copy') fs.mkdirSync(f.staged);
    else {
      fs.renameSync(f.target, f.previous);
      if (phase === 'backup') bundle(f.staged, 'staged');
      else bundle(f.target, 'committed');
      if (phase === 'backup-cleanup') fs.unlinkSync(path.join(f.previous, 'version'));
    }
    assert.equal(await f.install(), 0, f.lines.join('\n'));
    assert.equal(f.version(), 'new');
    assert.equal(fs.existsSync(f.work), false);
  }
});

test('a verified app beside a backup and a staged copy is kept, and the leftovers removed', async (t) => {
  const f = macInstaller(t, { existing: true });
  bundle(f.previous, 'backup');
  bundle(f.staged, 'staged');
  assert.equal(await f.install({ fetch: async () => { throw new Error('offline'); } }), 1);
  assert.match(f.lines.at(-1), /offline/);
  assert.equal(f.version(), 'old');
  assert.equal(fs.existsSync(f.work), false);
});
test('an interrupted swap is rolled back even when the next release download fails', async (t) => {
  const f = macInstaller(t, { existing: true });
  fs.mkdirSync(f.work);
  fs.renameSync(f.target, f.previous);
  bundle(f.staged, 'staged');
  assert.equal(await f.install({ fetch: async () => { throw new Error('offline'); } }), 1);
  assert.equal(f.version(), 'old');
  assert.equal(fs.existsSync(f.work), false);
  assert.equal(f.calls.some(c => ['hdiutil', 'ditto', 'pkill', 'open'].includes(c[0])), false);
});

test('an existing user installation is updated even when system Applications is writable', async (t) => {
  const f = macInstaller(t, { existing: true });
  assert.equal(await f.install({ writable: () => true }), 0);
  assert.equal(f.version(), 'new');
  assert.equal(fs.existsSync(path.join(f.applications, APP)), false);
});

test('fresh and existing system installations use system Applications', async (t) => {
  for (const existing of [false, true]) {
    const f = macInstaller(t);
    const target = path.join(f.applications, APP);
    if (existing) bundle(target, 'old');
    assert.equal(await f.install({ writable: () => true }), 0);
    assert.equal(f.version(target), 'new');
    assert.equal(fs.existsSync(f.target), false);
  }
});

test('protected, duplicate or unrecognized installations are refused before copying or quitting', async (t) => {
  for (const kind of ['protected', 'duplicate', 'unrecognized']) {
    const f = macInstaller(t, { existing: kind !== 'protected' });
    if (kind !== 'unrecognized') bundle(path.join(f.applications, APP), 'system');
    else fs.writeFileSync(path.join(f.target, 'id'), 'com.example.other');
    assert.equal(await f.install(), 1);
    assert.equal(f.calls.some(c => ['ditto', 'pkill', 'open'].includes(c[0])), false);
    assert.equal(fs.existsSync(path.join(kind === 'unrecognized' ? f.folder : f.applications, APP)), true);
  }
});

test('lock refusal leaves the app unchanged', async (t) => {
  const f = macInstaller(t, { existing: true });
  assert.equal(await f.install({ acquireLock: () => { throw new Error('locked'); } }), 1);
  assert.equal(f.version(), 'old');
  assert.equal(f.calls.some(c => ['ditto', 'pkill', 'open'].includes(c[0])), false);
});

test('the native macOS lock excludes other runners and releases on exit without removing its inode', { skip: process.platform !== 'darwin' }, async (t) => {
  let competing;
  const f = macInstaller(t, { existing: true, reply: (file, args, options) => {
    if (file === 'ditto') {
      competing = f.install({ acquireLock: undefined });
      assert.equal(spawnSync('/usr/bin/lockf', ['-s', '-t', '0', lock, '/usr/bin/true']).status, 75);
      assert.ok(Number.isInteger(options.stdio[3]));
    }
  } });
  const lock = path.join(f.folder, '.grove-companion-install.lock');
  assert.equal(await f.install({ acquireLock: undefined }), 0);
  assert.equal(await competing, 1);
  assert.ok(f.lines.some(line => /already being installed/.test(line)));
  const inode = fs.statSync(lock).ino;
  assert.equal(spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', lock, '/usr/bin/true']).status, 0);
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0x20);
    process.kill(process.pid, 'SIGKILL');
  `]);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(await f.install({ acquireLock: undefined }), 0);
  assert.equal(await competing, 1);
  assert.equal(fs.statSync(lock).ino, inode);
});

test('launch failure leaves the newly installed bundle intact', async (t) => {
  const f = macInstaller(t, { existing: true, reply: file => file === 'open' ? { status: 1 } : undefined });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'new');
  assert.match(f.lines.at(-1), /installed but could not be started/);
});

test('failed image detach preserves the mounted workspace without masking a copy failure', async (t) => {
  const f = macInstaller(t, { existing: true, reply: (file, args) => {
    if (file === 'hdiutil' && args[0] === 'detach') return { status: 1 };
    if (file === 'ditto') return { status: 1 };
  } });
  assert.equal(await f.install(), 1);
  assert.equal(f.version(), 'old');
  assert.equal(fs.readdirSync(f.tmp).length, 1);
  assert.match(f.lines.at(-1), /Could not copy/);
  assert.ok(f.lines.some(line => /Could not detach/.test(line)));
});

test('cleanup failure does not turn a committed installation into a failure and is recoverable', async (t) => {
  const f = macInstaller(t, { existing: true });
  const remove = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === f.work) throw new Error('cleanup denied');
    return remove(file, options);
  });
  assert.equal(await f.install(), 0);
  assert.equal(f.version(), 'new');
  assert.equal(f.version(f.previous), 'old');
  assert.ok(f.lines.some(line => /Could not clean up/.test(line)));
  assert.ok(f.calls.some(c => c[0] === 'open' && c[1] === f.target));
  mocked.mock.restore();
  assert.equal(await f.install(), 0);
  assert.equal(f.version(), 'new');
  assert.equal(fs.existsSync(f.work), false);
});

test('on Linux there is nothing to install', async () => {
  const lines = [];
  assert.equal(await installCompanion({ platform: 'linux', fetch: () => assert.fail('nothing is downloaded'), log: (line) => lines.push(line) }), 1);
  assert.deepEqual(lines, ['The Grove Companion is for Windows and macOS.']);
});

function companionManager(t, platform) {
  const provider = loadProviders({ platform: process.platform }).providers.find((p) => p.id === 'shell');
  const finished = [];
  const registry = Object.assign(new EventEmitter(), {
    env: process.env, platform,
    get: (id) => id === 'shell' ? provider : null,
    describe: () => ({ id: 'shell', tool: 'Shell', vendor: 'Local', command: '@shell' }),
    list: () => [{ id: 'shell', tool: 'Shell', vendor: 'Local', command: '@shell' }],
    finishInstall: async (...args) => { finished.push(args); },
  });
  const manager = new SessionManager({ registry, baseEnv: process.env, getApiUrl: () => api.url });
  t.mock.method(manager, '_companionSpec', () => ({ file: process.execPath, args: ['-e', "process.stdin.setRawMode(true); process.stdin.on('data', () => process.exit(0)); process.stdin.resume(); console.log('COMPANION INSTALL');"] }));
  const api = createManagerServer({ manager, registry, token: 'test-token', webDir: path.resolve('web') });
  t.after(async () => {
    await manager.shutdown(); await api.close();
    if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
  });
  const call = async (token = 'test-token') => {
    const response = await fetch(api.url + '/api/v1/companion/install', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    return { status: response.status, body: await response.json() };
  };
  return { manager, api, call, finished };
}

test('the companion install API starts one install terminal at a time, on Windows and macOS only', { timeout: 10000 }, async (t) => {
  const { manager, api, call, finished } = companionManager(t, 'darwin');
  await api.listen();
  assert.equal((await call('wrong')).status, 401);
  const made = await call();
  assert.equal(made.status, 201);
  assert.equal(made.body.session.task, 'install');
  assert.equal(made.body.session.name, 'Install Grove Companion');
  const again = await call();
  assert.deepEqual([again.status, again.body.error.code], [409, 'install_in_progress']);
  const session = manager.get(made.body.session.id);
  const messages = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const detach = session.attach((message) => {
    messages.push(message);
    if (/COMPANION INSTALL/.test(message.data || '')) ready();
  });
  await started;
  session.write('x');
  await session.exited;
  detach();
  assert.equal(session.exitCode, 0);
  assert.ok(messages.some((m) => /COMPANION INSTALL/.test(m.data || '')), 'the install reaches the terminal');
  await new Promise(setImmediate);
  assert.equal(manager.companionInstall, null);
  assert.deepEqual(finished, []);
  assert.equal((await call()).status, 201);
});

test('the companion install API refuses on Linux', async (t) => {
  const { api, call } = companionManager(t, 'linux');
  await api.listen();
  const refused = await call();
  assert.deepEqual([refused.status, refused.body.error.code], [400, 'companion_unsupported']);
});
