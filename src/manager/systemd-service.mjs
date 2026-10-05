// Starting the session manager when a Linux computer starts, as a systemd
// user service.
//
// The unit runs a launcher in the data folder, which execs `agent-guild
// start --service` in the foreground, so systemd's MainPID is the manager
// and systemd supervises it:
//
// * Restart=on-failure restarts a manager that crashed; StartLimitBurst
//   stops a crash loop instead of repeating it every few seconds.
// * A restart the user asks for exits with EXIT_RESTART after resetting the
//   start count, so any number of restarts never trips that limit.
// * A manager that finds its port in use exits with EXIT_PORT_IN_USE, which
//   RestartPreventExitStatus turns into a stopped unit, not a restart loop.
// * KillMode=process stops only the manager. It ends its own sessions, and
//   tmux servers outlive it as they do when no service runs it.
//
// The service starts at boot only for a user with lingering on, which only
// an administrator can always turn on; the state says so instead of failing
// silently. Once the package script is gone the launcher disables the unit
// and removes it and itself, as the sign-in entries do.
//
// Every systemctl call runs with XDG_RUNTIME_DIR set to the user's runtime
// folder, which reaches the user manager without a desktop bus, and with TZ
// and LC_ALL fixed, so its timestamps read the same on every system.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SERVICE = 'agent-guild.service';
export const BOOT_LAUNCHER = 'boot.sh';
/** A manager under the service exits with this to be started again from the package on disk. */
export const EXIT_RESTART = 75;
/** A manager under the service exits with this when its port is taken; systemd then leaves it stopped. */
export const EXIT_PORT_IN_USE = 78;
export const LINGER_DIR = '/var/lib/systemd/linger';
export const SHOW_PROPERTIES = ['LoadState', 'UnitFileState', 'ActiveState', 'Result', 'ExecMainStatus', 'MainPID', 'ExecMainStartTimestamp', 'InactiveEnterTimestamp'];
export const BOOT_NOTE = 'Starts the session manager as a systemd user service when this computer starts, before anyone signs in, and starts it again if it fails. The page does not open.';
/** Characters a unit's ExecStart line would read as escapes, variables or a line break. */
export const UNIT_UNSAFE = /["`$\\\u0000-\u001f]/;

const failure = (message) => Object.assign(new Error(message), { status: 500, code: 'autostart_failed' });

/** Whether this is a Linux the service can be offered on: WSL starts with Windows, not on its own. */
export function bootSupported({ platform = process.platform, env = process.env, release = os.release() } = {}) {
  return platform === 'linux' && !(env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release));
}

function portString(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('The manager must be listening before saving its startup port.');
  return String(port);
}

/**
 * The sh launcher the unit runs, with Node.js, the package script, the unit
 * file and the port as its arguments. Once the package is gone it disables
 * the unit and removes it and itself, and exits 0 so systemd does not retry.
 */
export const BOOT_LAUNCHER_SCRIPT = [
  '#!/bin/sh',
  '# Agent Guild: runs the session manager under systemd. Its unit runs it with',
  '# Node.js, the package script, the unit file and the port.',
  'if [ -f "$2" ]; then AGENT_GUILD_PORT="$4" exec "$1" "$2" start --service; fi',
  'echo "Agent Guild is no longer installed at $2; removing its systemd unit."',
  `systemctl --user disable ${SERVICE} >/dev/null 2>&1`,
  'rm -f "$3" "$0"',
  'systemctl --user daemon-reload >/dev/null 2>&1',
  'exit 0',
  '',
].join('\n');

/** One ExecStart argument: quoted, with `%` doubled so systemd reads no specifier. Paths with UNIT_UNSAFE characters are refused before this. */
export function unitArg(value) {
  return `"${value.replace(/%/g, '%%')}"`;
}

export function serviceUnit({ launcher, execPath, script, file, port }) {
  return [
    '[Unit]',
    'Description=Agent Guild session manager',
    'Documentation=https://github.com/oddessentials/agent-guild#readme',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${['/bin/sh', launcher, execPath, script, file, portString(port)].map(unitArg).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2',
    `RestartPreventExitStatus=${EXIT_PORT_IN_USE}`,
    'KillMode=process',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The ExecStart arguments of a unit this module wrote, or null. */
export function unitArgs(text) {
  const line = String(text ?? '').match(/^ExecStart=(.*)$/m)?.[1];
  if (!line) return null;
  return [...line.matchAll(/"((?:[^"])*)"/g)].map((m) => m[1].replace(/%%/g, '%'));
}

/** The port a unit this module wrote starts the manager on, or null. */
export function unitPort(text) {
  const port = Number(unitArgs(text)?.[5]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** `systemctl show` output as an object. */
export function parseShow(stdout) {
  const out = {};
  for (const line of String(stdout).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/** A timestamp systemctl printed with TZ=UTC, such as `Mon 2026-10-05 18:40:29 UTC`, as ISO; null when empty or unrecognized. */
export function parseTimestamp(value) {
  const m = String(value ?? '').match(/(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/);
  return m ? new Date(`${m[1]}T${m[2]}Z`).toISOString() : null;
}

/**
 * What the service is doing, read from `systemctl show`, or null when it is
 * not enabled. `pid` is the manager that answers, or null when none does.
 *
 * - `running`: systemd runs the manager that answers (or, with no pid, one)
 * - `other`: systemd runs a manager, but not the one that answers
 * - `starting`: systemd is starting it, or waiting to start it again
 * - `pending`: enabled, but the manager that answers was started without systemd
 * - `stopped`: enabled and stopped, and no manager answers
 * - `port-in-use`: it last stopped because another manager held its port
 * - `failed`: it stopped after failing, the start limit included
 */
export function startupState(show, { pid = null, port = null } = {}) {
  if (!show || show.UnitFileState !== 'enabled') return null;
  const mainPid = Number(show.MainPID) || null;
  const since = parseTimestamp(show.ExecMainStartTimestamp);
  const at = parseTimestamp(show.InactiveEnterTimestamp);
  if (show.ActiveState === 'failed') {
    if (Number(show.ExecMainStatus) === EXIT_PORT_IN_USE) return { kind: 'port-in-use', at, port };
    return { kind: 'failed', at, result: show.Result || null, status: Number(show.ExecMainStatus) || 0 };
  }
  if (show.ActiveState === 'active' || show.ActiveState === 'reloading') {
    if (pid === null || mainPid === pid) return { kind: 'running', since, pid: mainPid };
    return { kind: 'other', since, pid: mainPid, port };
  }
  if (show.ActiveState === 'activating') return { kind: 'starting' };
  return pid === null ? { kind: 'stopped', at } : { kind: 'pending' };
}

export const journalCommand = (lines = 50) => `journalctl --user -u ${SERVICE} -n ${lines} --no-pager`;
export const lingerCommand = (user) => `sudo loginctl enable-linger ${user}`;

/** The state in a sentence or two, for the CLI. The page words the same states itself. */
export function describeStartup(state, { linger = true, user = 'USER' } = {}) {
  if (!state) return null;
  const when = (iso) => (iso ? ` (${iso})` : '');
  const text = {
    running: `Starts when the computer starts; running under systemd${when(state.since)}.`,
    other: `Starts when the computer starts; systemd runs a different session manager (pid ${state.pid}).`,
    starting: 'Starts when the computer starts; systemd is starting it.',
    pending: 'Starts when the computer starts; this manager was started without systemd and hands over at its next restart.',
    stopped: 'Starts when the computer starts; stopped now. `agent-guild open` starts it.',
    'port-in-use': `Starts when the computer starts; did not start${when(state.at)} because another session manager held port ${state.port ?? 'its port'}.`,
    failed: `Starts when the computer starts; stopped after failing${when(state.at)}. See: ${journalCommand()}`,
  }[state.kind];
  return linger ? text : `${text} Without lingering it waits for you to sign in; to start before anyone signs in, run: ${lingerCommand(user)}`;
}

/** A GET /autostart description in one line, for `agent-guild status`; null when the manager offers none. */
export function startupSummary(autostart) {
  if (!autostart) return null;
  if (!autostart.available) return autostart.reason ? `Startup: ${autostart.reason}` : null;
  if (autostart.boot?.enabled) {
    const line = describeStartup(autostart.boot.state, { linger: autostart.boot.linger, user: autostart.boot.user });
    return autostart.mode === 'both' ? `${line} A sign-in entry is on as well; choose one under Settings › Startup.` : line;
  }
  return autostart.enabled ? 'Starts when you sign in.' : 'Starts only when you start it.';
}

/** Runs systemctl or journalctl for the user manager, with a fixed environment. Resolves `{ status, stdout, stderr, missing }`. */
export function systemdRunner({ uid = process.getuid?.(), env = process.env } = {}) {
  const fixed = { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}`, TZ: 'UTC', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' };
  return (command, args) => new Promise((resolve) => {
    execFile(command, args, { env: fixed, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        status: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '') || ''),
        missing: err?.code === 'ENOENT',
      });
    });
  });
}

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes `contents` unless the file already holds exactly that; resolves to whether it changed. */
async function writeIfChanged(file, contents, mode = 0o644) {
  if ((await readText(file)) === contents) {
    if (((await fs.promises.stat(file)).mode & 0o777) !== mode) await fs.promises.chmod(file, mode);
    return false;
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.chmod(tmp, mode);
  await fs.promises.rename(tmp, file);
  return true;
}

/**
 * The user's agent-guild.service.
 *
 * @param {object} opts
 * @param {string} opts.dataDir  where the launcher is kept
 * @param {(command: string, args: string[]) => Promise<{ status: number, stdout: string, stderr: string, missing?: boolean }>} [opts.run]  systemctl and journalctl, replaceable in tests
 */
export function createBootService({
  env = process.env,
  home = os.homedir(),
  user = os.userInfo().username,
  uid = process.getuid?.(),
  dataDir,
  lingerDir = LINGER_DIR,
  run = systemdRunner({ uid, env }),
}) {
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', SERVICE);
  const wants = path.join(path.dirname(file), 'default.target.wants', SERVICE);
  const launcher = path.join(dataDir, BOOT_LAUNCHER);
  const systemctl = (...args) => run('systemctl', ['--user', ...args]);
  const must = async (what, ...args) => {
    const r = await systemctl(...args);
    if (r.status !== 0) throw failure(`Could not ${what}: ${(r.stderr || r.stdout).trim() || `systemctl exited with ${r.status}`}`);
    return r;
  };

  return {
    file,
    launcher,
    user,
    /** The paths the unit and launcher hold, for the caller's unsafe-path check. */
    paths: [file, launcher],
    /**
     * `{ reachable, reason, show, enabled, linger }`. Unreachable means no
     * systemctl, or a user manager that did not answer; `reason` says which.
     */
    async read() {
      const r = await systemctl('show', SERVICE, ...SHOW_PROPERTIES.map((p) => `--property=${p}`));
      const linger = fs.existsSync(path.join(lingerDir, user));
      if (r.missing) return { reachable: false, reason: 'Not available because this computer does not use systemd.', show: null, enabled: false, linger };
      if (r.status !== 0) {
        return { reachable: false, reason: `Not available because systemd's user manager did not answer: ${(r.stderr || r.stdout).trim() || `systemctl exited with ${r.status}`}`, show: null, enabled: false, linger };
      }
      const show = parseShow(r.stdout);
      return { reachable: true, reason: null, show, enabled: show.UnitFileState === 'enabled', linger };
    },
    /** The unit's text, or null. */
    text: () => readText(file),
    /** Writes the launcher and unit; resolves to whether the unit changed. */
    async write({ execPath, script, port }) {
      await writeIfChanged(launcher, BOOT_LAUNCHER_SCRIPT, 0o755);
      return writeIfChanged(file, serviceUnit({ launcher, execPath, script, file, port }));
    },
    reload: () => must('reload systemd units', 'daemon-reload'),
    enable: () => must('enable the systemd unit', 'enable', SERVICE),
    /** Disables and removes the unit and launcher whether or not systemd answers; never stops a running manager. */
    async remove() {
      const r = await systemctl('disable', SERVICE);
      await fs.promises.rm(wants, { force: true });
      await fs.promises.rm(file, { force: true });
      await fs.promises.rm(launcher, { force: true });
      if (!r.missing) await systemctl('daemon-reload');
    },
    /** Clears a failed state and the start count, so the next start is not refused. */
    resetFailed: () => systemctl('reset-failed', SERVICE),
    start: ({ block = true } = {}) => must('start the systemd unit', 'start', ...(block ? [] : ['--no-block']), SERVICE),
    /** The last lines the service logged, or '' when the journal cannot be read. */
    async journal(lines = 20) {
      const r = await run('journalctl', ['--user', '-u', SERVICE, '-n', String(lines), '--no-pager', '-o', 'cat']);
      return r.status === 0 ? r.stdout.trim() : '';
    },
  };
}
