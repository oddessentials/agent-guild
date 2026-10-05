// The boot service's acceptance steps, run inside the systemd container by
// acceptance.sh as the user `guild`, against the installed package and the
// real user manager. Each phase asserts and exits non-zero at the first
// difference; waits poll a condition against a deadline instead of sleeping.
//
//   node steps.mjs before-reboot   hand-started manager, choosing boot, handover,
//                                  restarts, a tmux card, stop, a port clash
//   node steps.mjs after-reboot    started at boot with nobody signed in; switching modes
//   node steps.mjs after-removal   the unit removed itself once the package was gone

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config');
const UNIT = path.join(CONFIG, 'systemd', 'user', 'agent-guild.service');
const WANTS = path.join(CONFIG, 'systemd', 'user', 'default.target.wants', 'agent-guild.service');
const DESKTOP = path.join(CONFIG, 'autostart', 'agent-guild.desktop');
const LAUNCHER = path.join(CONFIG, 'agent-guild', 'boot.sh');
const URL_BASE = 'http://127.0.0.1:47821';
const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };

const step = (name) => console.log(`--- ${name}`);
const run = (command, args, opts = {}) => spawnSync(command, args, { encoding: 'utf8', env, ...opts });
const guild = (...args) => run('agent-guild', args);
const token = () => fs.readFileSync(path.join(CONFIG, 'agent-guild', 'auth-token'), 'utf8').trim();

function show() {
  const r = run('systemctl', ['--user', 'show', 'agent-guild.service', '-p', 'LoadState', '-p', 'UnitFileState', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'MainPID', '-p', 'NRestarts']);
  return Object.fromEntries(r.stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
}

async function health() {
  try {
    const res = await fetch(`${URL_BASE}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function api(method, route, body) {
  const res = await fetch(`${URL_BASE}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Polls `check` until it returns a truthy value, or fails with `what` after `ms`. */
async function until(what, check, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const supervised = async () => {
  const h = await health();
  const s = show();
  return h && s.ActiveState === 'active' && Number(s.MainPID) === h.pid ? h : null;
};

const phases = {
  async 'before-reboot'() {
    step('a manager started by hand, with no startup set');
    const opened = guild('open', '--no-browser');
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(guild('status').stdout, /^Starts only when you start it\.$/m);

    step('choosing boot enables the unit, keeps this manager, and names lingering');
    const before = await health();
    const { autostart } = await api('PUT', '/autostart', { mode: 'boot' });
    assert.equal(autostart.mode, 'boot');
    assert.deepEqual(autostart.boot.state, { kind: 'pending' });
    assert.deepEqual(autostart.boot.commands, [`sudo loginctl enable-linger ${os.userInfo().username}`]);
    assert.equal(show().UnitFileState, 'enabled');
    assert.equal((await health()).pid, before.pid, 'choosing a mode never restarts the manager');
    assert.equal(run('systemd-analyze', ['verify', UNIT]).stderr, '');

    step('a restart hands the manager to systemd');
    assert.equal(guild('restart').status, 0);
    const handed = await until('systemd to run the manager that answers', supervised);
    assert.notEqual(handed.pid, before.pid);
    assert.match(guild('status').stdout, /running under systemd/);

    step('ten restarts in a row never reach the start limit');
    let pid = handed.pid;
    for (let i = 1; i <= 10; i++) {
      const r = guild('restart');
      assert.equal(r.status, 0, `restart ${i}: ${r.stdout}${r.stderr}`);
      const now = await until(`restart ${i} under systemd`, supervised);
      assert.notEqual(now.pid, pid, `restart ${i} started a new manager`);
      pid = now.pid;
    }

    step('a tmux card survives a restart and a stop');
    const { session } = await api('POST', '/sessions', { providerId: 'shell', shell: 'tmux', name: 'keep me' });
    const server = await until('the tmux server', () => Number(run('pgrep', ['-u', String(process.getuid()), '-o', 'tmux']).stdout.trim()) || null);
    assert.match(fs.readFileSync(`/proc/${server}/cgroup`, 'utf8'), /agent-guild\.service/, 'the tmux server runs in the service');
    assert.equal(guild('restart').status, 0);
    await until('the restarted manager', supervised);
    process.kill(server, 0);
    const listed = await until('the card to come back', async () => (await api('GET', '/sessions')).sessions.find((s) => s.id === session.id));
    assert.equal(listed.multiplexer?.label, 'tmux');

    step('stop leaves it stopped until something starts it; open starts it through systemd');
    assert.equal(guild('stop').status, 0);
    await until('the unit to stop', () => show().ActiveState === 'inactive');
    process.kill(server, 0);
    const stopped = guild('status');
    assert.equal(stopped.status, 3);
    assert.match(stopped.stdout, /stopped now\. `agent-guild open` starts it\./);
    assert.equal(guild('open', '--no-browser').status, 0);
    await until('open to start the manager under systemd', supervised);

    step('a port clash stops the unit without a retry loop, and open recovers');
    assert.equal(guild('stop').status, 0);
    await until('the unit to stop', () => show().ActiveState === 'inactive');
    const script = fs.realpathSync(execFileSync('sh', ['-c', 'command -v agent-guild'], { env, encoding: 'utf8' }).trim());
    const stray = spawn(process.execPath, [path.join(path.dirname(script), '..', 'src', 'manager', 'main.mjs')], { env: { ...env, AGENT_GUILD_PORT: '47821' }, stdio: 'ignore', detached: true });
    await until('the stray manager', health);
    run('systemctl', ['--user', 'start', 'agent-guild.service']);
    await until('the unit to fail with the port-in-use code', () => show().ActiveState === 'failed' && show().ExecMainStatus === '78');
    assert.equal(show().NRestarts, '0', 'no retries');
    assert.match(guild('status').stdout, /did not start .*held port 47821/);
    process.kill(-stray.pid, 'SIGTERM');
    await until('the stray manager to stop', async () => !(await health()));
    assert.equal(guild('open', '--no-browser').status, 0);
    await until('open to recover the failed unit', supervised);
  },

  async 'after-reboot'() {
    step('started at boot, with nobody signed in');
    const loginSessions = run('loginctl', ['list-sessions', '--no-legend']).stdout.trim();
    assert.equal(loginSessions, '', 'no login session');
    const booted = await until('the manager started at boot', supervised, 60000);
    const { autostart } = await api('GET', '/autostart');
    assert.equal(autostart.boot.linger, true);
    assert.deepEqual(autostart.boot.commands, []);
    assert.equal(autostart.boot.state.kind, 'running');

    step('switching to sign-in adds the entry, removes the unit, and keeps the manager');
    let switched = (await api('PUT', '/autostart', { mode: 'sign-in' })).autostart;
    assert.equal(switched.mode, 'sign-in');
    assert.equal(fs.existsSync(DESKTOP), true);
    for (const file of [UNIT, WANTS, LAUNCHER]) assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined, file);
    assert.equal((await health()).pid, booted.pid);

    step('and back to boot');
    switched = (await api('PUT', '/autostart', { mode: 'boot' })).autostart;
    assert.equal(switched.mode, 'boot');
    assert.equal(fs.existsSync(DESKTOP), false);
    assert.equal(show().UnitFileState, 'enabled');
    assert.equal((await health()).pid, booted.pid);
  },

  async 'after-removal'() {
    step('the unit removed itself once the package was gone');
    for (const file of [UNIT, WANTS, LAUNCHER]) assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined, file);
    assert.equal(show().LoadState, 'not-found');
    assert.match(run('journalctl', ['--user', '-o', 'cat']).stdout, /Agent Guild is no longer installed at .*removing its systemd unit\./);
    assert.equal(await health(), null);
  },
};

const phase = phases[process.argv[2]];
if (!phase) {
  console.error(`usage: node steps.mjs ${Object.keys(phases).join('|')}`);
  process.exit(2);
}
await phase();
console.log(`ok: ${process.argv[2]}`);
