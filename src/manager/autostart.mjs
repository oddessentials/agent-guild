// Starting the session manager when the user signs in to the computer.
//
// Each platform gets one per-user entry that runs `agent-guild open
// --no-browser`, which starts a background manager unless one answers:
//
// * Windows: a value under HKCU's Run key. It runs a JScript wrapper in the
//   data folder through wscript.exe, which starts Node.js with no console
//   window; running node.exe directly would flash one at every sign-in.
// * macOS: a LaunchAgent with RunAtLoad. It runs a script named Agent Guild
//   in the data folder, which System Settings lists by that name; running
//   sh directly would list it as "sh". AbandonProcessGroup keeps launchd
//   from killing the manager once the launching command exits.
// * Linux: an XDG autostart entry, run when a desktop session starts. It
//   runs a script in the data folder, as on macOS: desktops read Exec lines
//   by different rules (systemd's autostart generator keeps a backslash that
//   GLib removes), so the line holds only paths that read the same in all.
//   Linux also offers a systemd user service that starts the manager when
//   the computer starts (systemd-service.mjs). One starter at a time: the
//   setting is a mode, off, sign-in or boot, and choosing one removes the
//   other, so a sign-in never races the service for the port.
//
// Each launcher touches a file in the data folder before it starts Node.js,
// and `open --sign-in` records whether a manager then answered, so the page
// can say whether the last sign-in started the manager.
//
// The entry and the OS's enabled state record whether autostart is on, so
// a user who turns it off outside the app sees it off here too.
// Its paths are absolute, so a running manager rewrites an entry that is on
// at every start: a Node.js version switch or a reinstall then takes effect
// at the next sign-in. npm runs no script when a package is uninstalled, so
// an entry whose package script is gone removes itself at sign-in instead
// of failing there at every sign-in after. A missing Node.js alone keeps
// the entry: the next manager to start points it at its own. Homebrew's
// and Snap's Node.js are named by the link an upgrade keeps (opt, current)
// rather than by the versioned folder the upgrade deletes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DEFAULT_PORT } from './config.mjs';
import { BOOT_NOTE, UNIT_UNSAFE, bootSupported, createBootService, journalCommand, lingerCommand, startupState, systemdRunner, unitPort } from './systemd-service.mjs';

export const ARGS = ['open', '--no-browser', '--sign-in'];
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const WINDOWS_VALUE = 'AgentGuild';
export const WINDOWS_WRAPPER = 'autostart.js';
export const LAUNCH_AGENT_LABEL = 'com.oddessentials.agent-guild';
export const MAC_LAUNCHER = 'Agent Guild';
export const LINUX_LAUNCHER = 'autostart.sh';
/** Touched by an entry each time it runs at sign-in. */
export const SIGN_IN_ATTEMPT = 'sign-in-attempt';
/** What `open --sign-in` found: `{ at, outcome }`. */
export const SIGN_IN_RESULT = 'sign-in.json';
/** How long after an entry runs a manager may take to answer before it counts as not started. */
export const SIGN_IN_WAIT_MS = 30000;
/** File times may be rounded, so a result this much older than its attempt still belongs to it. */
const CLOCK_SLACK_MS = 2000;
const OUTCOMES = new Set(['started', 'running']);
/**
 * macOS keeps its own switch for the item, which only an app signed to use
 * SMAppService can read, so the page says where it is instead.
 */
export const MAC_NOTE = 'Starts the session manager in the background when you sign in to this Mac. The page does not open. macOS also lists it as Agent Guild under System Settings › General › Login Items & Extensions; switched off there, it does not start even while this is checked.';
export const LINUX_NOTE = 'Starts the session manager in the background when you sign in to a desktop session on this computer. The page does not open. A computer with no desktop session, such as a server reached over SSH, does not start it. Desktop startup settings list it as Agent Guild.';
/** Added to LINUX_NOTE when the manager itself was not started from a desktop session. */
export const LINUX_NO_DESKTOP = 'This manager was not started from a desktop session, so this computer may not have one.';
/** Linux startup modes. */
export const MODES = ['off', 'sign-in', 'boot'];

const failure = (message) => Object.assign(new Error(message), { status: 500, code: 'autostart_failed' });

function portString(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('The manager must be listening before saving its startup port.');
  return String(port);
}

/** A JScript string literal: JSON's escapes, with everything outside ASCII as \u escapes so the file's code page cannot matter. */
function jsString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The JScript that wscript.exe runs at sign-in: the launcher with its
 * window hidden (0), not waited for; or, once the package is gone, the
 * removal of the Run value, its Task Manager setting and this file.
 * `runKey` and `approvedKey` are replaceable in tests.
 */
export function windowsWrapper({ execPath, script, attempt, port = DEFAULT_PORT, runKey = WINDOWS_RUN_KEY, approvedKey = WINDOWS_APPROVED_KEY }) {
  const command = [execPath, script].map((p) => `"${p}"`).concat(ARGS).join(' ');
  return [
    '// Agent Guild: starts the session manager at sign-in without a console window.',
    'var files = new ActiveXObject("Scripting.FileSystemObject");',
    'var shell = new ActiveXObject("WScript.Shell");',
    `if (files.FileExists(${jsString(script)})) {`,
    `  try { files.CreateTextFile(${jsString(attempt)}, true).Close(); } catch (e) {}`,
    `  shell.Environment("Process")("AGENT_GUILD_PORT") = ${jsString(portString(port))};`,
    `  shell.Run(${jsString(command)}, 0, false);`,
    '} else {',
    '  // Agent Guild is no longer installed here: remove this sign-in entry.',
    `  try { shell.RegDelete(${jsString(`${runKey}\\${WINDOWS_VALUE}`)}); } catch (e) {}`,
    `  try { shell.RegDelete(${jsString(`${approvedKey}\\${WINDOWS_VALUE}`)}); } catch (e) {}`,
    '  try { files.DeleteFile(WScript.ScriptFullName); } catch (e) {}',
    '}',
    '',
  ].join('\r\n');
}

/** The Run value's command line. */
export function windowsRunCommand({ env, wrapper }) {
  const wscript = path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  return `"${wscript}" //B //NoLogo "${wrapper}"`;
}

/**
 * The sh launcher a macOS or Linux entry runs from the data folder, with
 * Node.js, the package script, the entry's own file, the saved port, the
 * manager log and the sign-in attempt file as its arguments, so no path is
 * ever part of the script text. Its output, a missing Node.js included, is
 * appended to the log when the log can be opened; the subshell tries first
 * because a failed `exec` redirection would end sh before it starts
 * anything. Once the package is gone it removes the entry and itself.
 */
export const POSIX_LAUNCHER = [
  '#!/bin/sh',
  '# Agent Guild: starts the session manager at sign-in. Its sign-in entry runs it',
  '# with Node.js, the package script, the entry, the port, the log and a file it touches.',
  'node="$1"; shift',
  `if [ -f "$1" ]; then touch "$5" 2>/dev/null; if (exec >>"$4") 2>/dev/null; then exec >>"$4" 2>&1; echo "--- sign-in $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"; fi; AGENT_GUILD_PORT="$3" exec "$node" "$1" ${ARGS.join(' ')}; fi`,
  'rm -f "$2" "$0"',
  '',
].join('\n');

/** What a macOS or Linux entry passes its launcher: Node.js, then the paths and port it reads. */
function launchArgs({ execPath, script, file, port = DEFAULT_PORT, log, attempt }) {
  return [execPath, script, file, portString(port), log, attempt];
}

/** The Linux entry's command line: sh, the launcher, then the arguments it reads. */
export function posixCommand({ launcher, ...paths }) {
  return ['/bin/sh', launcher, ...launchArgs(paths)];
}

/**
 * Versioned Node.js folders that an upgrade deletes, each with the link that
 * follows the package across upgrades. Homebrew runs Node.js from
 * `<prefix>/Cellar/<formula>/<version>`, kept as `<prefix>/opt/<formula>`.
 * A snap runs it from `<snaps>/<snap>/<revision>`, where `<snaps>` is
 * `/snap` or `/var/lib/snapd/snap`, kept as `<snaps>/<snap>/current`; snapd
 * removes old revisions after a refresh.
 */
const VERSIONED_NODE = [
  [/^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/, (prefix, formula) => `${prefix}/opt/${formula}/bin/node`],
  [/^(.*\/snap)\/([^/]+)\/x?\d+\/bin\/node$/, (snaps, snap) => `${snaps}/${snap}/current/bin/node`],
];

/** Names Node.js by the link that survives upgrades, when that link leads to the same file. */
export function stableExecPath(execPath, realpath = fs.realpathSync) {
  for (const [pattern, link] of VERSIONED_NODE) {
    const match = execPath.match(pattern);
    if (!match) continue;
    const stable = link(...match.slice(1));
    try {
      return realpath(stable) === realpath(execPath) ? stable : execPath;
    } catch {
      return execPath;
    }
  }
  return execPath;
}

const xml = (value) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function launchAgentPlist({ launcher, execPath, script, file, port, log, attempt }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[launcher, ...launchArgs({ execPath, script, file, port, log, attempt })].map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>AbandonProcessGroup</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * One Exec argument, quoted by the Desktop Entry rules: `"`, `` ` ``, `$`
 * and `\` are escaped inside the quotes, and the string-value escape then
 * doubles every backslash again. `%` is the field-code prefix, so it is doubled.
 * Entries refuse paths with the escaped characters, which systemd's
 * autostart generator reads differently, so in practice only `%` changes.
 */
export function desktopArg(value) {
  const quoted = `"${value.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

export function desktopEntry(paths) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Guild',
    'Comment=Starts the Agent Guild session manager',
    `Exec=${posixCommand(paths).map(desktopArg).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Whether a desktop entry is on: present and not hidden or turned off by a desktop's startup settings. */
export function desktopEntryEnabled(text) {
  return !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
}

/** Windows keeps a Task Manager "Disabled" in StartupApproved: an odd first byte means off. */
export function approvedDisabled(stdout) {
  const hex = String(stdout).match(new RegExp(`^\\s*${WINDOWS_VALUE}\\s+REG_BINARY\\s+([0-9A-F]{2})`, 'mi'))?.[1];
  return hex !== undefined && (parseInt(hex, 16) & 1) === 1;
}

/** launchctl has used both booleans and enabled/disabled in its override list. */
export function launchAgentDisabled(stdout) {
  const body = String(stdout).match(/^\s*disabled services = \{([\s\S]*)\}\s*$/)?.[1];
  if (body === undefined) throw failure('Unrecognized launchd startup settings.');
  let disabled = false;
  for (const line of body.split('\n').filter((row) => row.trim())) {
    const row = line.match(/^\s*"([^"]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/);
    if (!row) throw failure('Unrecognized launchd startup settings.');
    if (row[1] === LAUNCH_AGENT_LABEL) disabled = row[2] === 'true' || row[2] === 'disabled';
  }
  return disabled;
}

function runCommand(command) {
  return (args) => new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || err?.message || '' });
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

/**
 * Writes `contents` unless the file already holds exactly that, with `mode`
 * whatever the umask. The default is writable only by its owner: launchd
 * skips an agent that others can write.
 */
async function writeIfChanged(file, contents, mode = 0o644) {
  if ((await readText(file)) === contents) {
    if (((await fs.promises.stat(file)).mode & 0o777) !== mode) await fs.promises.chmod(file, mode);
    return;
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.chmod(tmp, mode);
  await fs.promises.rename(tmp, file);
}

/**
 * What the entry did at the last sign-in it ran at, or null when it has not
 * run since it was turned on: `{ at, outcome }`, where `outcome` is
 * `started` or `running` (a manager already answered) as `open --sign-in`
 * recorded it, `starting` while a manager may still be coming up, and
 * `failed` once none answered in time.
 */
export async function lastSignIn(dataDir, now = Date.now()) {
  let attempt;
  try {
    attempt = (await fs.promises.stat(path.join(dataDir, SIGN_IN_ATTEMPT))).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let result = null;
  try {
    result = JSON.parse(await readText(path.join(dataDir, SIGN_IN_RESULT)));
  } catch { /* unreadable reads as none */ }
  if (Number.isFinite(result?.at) && OUTCOMES.has(result.outcome) && result.at >= attempt - CLOCK_SLACK_MS) {
    return { at: new Date(result.at).toISOString(), outcome: result.outcome };
  }
  return { at: new Date(attempt).toISOString(), outcome: now - attempt < SIGN_IN_WAIT_MS ? 'starting' : 'failed' };
}

/** Records what `open --sign-in` found; best effort, since the manager runs either way. */
export function recordSignIn(dataDir, outcome, now = Date.now()) {
  try {
    const file = path.join(dataDir, SIGN_IN_RESULT);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: now, outcome }));
    fs.renameSync(tmp, file);
  } catch { /* nothing to report it to */ }
}

async function clearSignIns(dataDir) {
  await fs.promises.rm(path.join(dataDir, SIGN_IN_ATTEMPT), { force: true });
  await fs.promises.rm(path.join(dataDir, SIGN_IN_RESULT), { force: true });
}

/**
 * @param {object} opts
 * @param {string} opts.script  bin/agent-guild.mjs of the package that is running
 * @param {string} opts.dataDir  where the Windows wrapper is kept
 * @param {string} [opts.log]  the manager log a macOS or Linux entry appends to
 * @param {() => number} [opts.getPort]  the bound port, read only when writing an entry
 * @param {string|null} [opts.unavailable]  a reason autostart cannot be offered, which turns it off here
 * @param {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} [opts.reg]  reg.exe, replaceable in tests
 * @param {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} [opts.launchctl]  launchctl, replaceable in tests
 * @param {(command: string, args: string[]) => Promise<object>} [opts.systemd]  systemctl and journalctl on Linux, replaceable in tests
 * @param {string} [opts.lingerDir]  where systemd records lingering users, replaceable in tests
 * @param {number} [opts.pid]  this manager, which the service state compares with systemd's
 */
export function createAutostart({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  release = os.release(),
  execPath = process.execPath,
  script,
  dataDir,
  log = path.join(dataDir, 'manager.log'),
  getPort = () => DEFAULT_PORT,
  unavailable = null,
  reg = runCommand(path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe')),
  uid = process.getuid?.(),
  launchctl = runCommand('/bin/launchctl'),
  user = os.userInfo().username,
  systemd = systemdRunner({ uid, env }),
  lingerDir,
  pid = process.pid,
}) {
  const entryExecPath = platform === 'win32' ? execPath : stableExecPath(execPath);
  const attempt = path.join(dataDir, SIGN_IN_ATTEMPT);
  const command = () => ({ execPath: entryExecPath, script, port: getPort(), log, attempt });
  let note = null;
  let unusable = null;
  let refreshError = null;
  /** The systemd user service, on a Linux that can offer it. */
  let boot = null;
  let bootRefreshError = null;
  let queue = Promise.resolve();
  /** One change or check at a time, so two clicks cannot interleave their writes. */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  let target = null;
  if (unavailable) {
    // Offered nowhere: `reason` says why.
  } else if (platform === 'win32') {
    const wrapper = path.join(dataDir, WINDOWS_WRAPPER);
    const approved = async () => {
      // Clears a Task Manager "Disabled", which would otherwise outrank the Run value.
      const r = await reg(['delete', WINDOWS_APPROVED_KEY, '/v', WINDOWS_VALUE, '/f']);
      if (r.status !== 0 && (await reg(['query', WINDOWS_APPROVED_KEY, '/v', WINDOWS_VALUE])).status === 0) {
        throw failure(`Could not clear the Task Manager startup setting: ${r.stderr.trim()}`);
      }
    };
    target = {
      async enabled() {
        if ((await reg(['query', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE])).status !== 0) return false;
        const state = await reg(['query', WINDOWS_APPROVED_KEY, '/v', WINDOWS_VALUE]);
        return !(state.status === 0 && approvedDisabled(state.stdout));
      },
      write: () => writeIfChanged(wrapper, windowsWrapper(command())),
      async enable() {
        await this.write();
        const r = await reg(['add', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE, '/t', 'REG_SZ', '/d', windowsRunCommand({ env, wrapper }), '/f']);
        if (r.status !== 0) throw failure(`Could not add the startup entry: ${r.stderr.trim()}`);
        await approved();
      },
      async disable() {
        const r = await reg(['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE, '/f']);
        if (r.status !== 0 && (await reg(['query', WINDOWS_RUN_KEY, '/v', WINDOWS_VALUE])).status === 0) {
          throw failure(`Could not remove the startup entry: ${r.stderr.trim()}`);
        }
        await reg(['delete', WINDOWS_APPROVED_KEY, '/v', WINDOWS_VALUE, '/f']);
        await fs.promises.rm(wrapper, { force: true });
      },
    };
  } else if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
    const launcher = path.join(dataDir, MAC_LAUNCHER);
    const domain = `gui/${uid}`;
    const disabled = async () => {
      if (!Number.isInteger(uid) || uid < 0) throw failure('Could not determine the macOS user.');
      const r = await launchctl(['print-disabled', domain]);
      if (r.status !== 0) throw failure(`Could not read launchd startup settings: ${r.stderr.trim()}`);
      return launchAgentDisabled(r.stdout);
    };
    target = {
      async enabled() {
        return (await readText(file)) !== null && !(await disabled());
      },
      async write() {
        await writeIfChanged(launcher, POSIX_LAUNCHER, 0o755);
        await writeIfChanged(file, launchAgentPlist({ ...command(), launcher, file }));
      },
      async enable() {
        const previous = await readText(file);
        // Check the domain before writing an entry we might be unable to enable.
        await disabled();
        await this.write();
        try {
          const r = await launchctl(['enable', `${domain}/${LAUNCH_AGENT_LABEL}`]);
          if (r.status !== 0) throw failure(`Could not enable the launchd startup setting: ${r.stderr.trim()}`);
          if (await disabled()) throw failure('launchd did not enable the startup setting.');
        } catch (err) {
          try {
            if (previous === null) await this.disable();
            else await writeIfChanged(file, previous);
          } catch (restoreError) {
            throw failure(`${err.message} Could not restore the previous startup entry: ${restoreError.message}`);
          }
          throw err;
        }
      },
      async disable() {
        await fs.promises.rm(file, { force: true });
        await fs.promises.rm(launcher, { force: true });
      },
    };
  } else if (bootSupported({ platform, env, release })) {
    const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'agent-guild.desktop');
    const launcher = path.join(dataDir, LINUX_LAUNCHER);
    const service = createBootService({ env, home, user, uid, dataDir, run: systemd, ...(lingerDir && { lingerDir }) });
    const unsafe = [entryExecPath, script, file, launcher, log, attempt, ...service.paths].find((p) => UNIT_UNSAFE.test(p));
    if (unsafe) {
      unusable = `Not available because this path holds a character (", \`, $, \\ or a line break) that desktops and systemd read differently in a startup entry: ${unsafe}`;
    } else {
      boot = service;
      const desktop = env.XDG_CURRENT_DESKTOP || env.WAYLAND_DISPLAY || env.DISPLAY;
      note = desktop ? LINUX_NOTE : `${LINUX_NOTE} ${LINUX_NO_DESKTOP}`;
      target = {
        async enabled() {
          const text = await readText(file);
          return text !== null && desktopEntryEnabled(text);
        },
        async write() {
          await writeIfChanged(launcher, POSIX_LAUNCHER, 0o755);
          await writeIfChanged(file, desktopEntry({ ...command(), launcher, file }));
        },
        enable() { return this.write(); },
        async disable() {
          await fs.promises.rm(file, { force: true });
          await fs.promises.rm(launcher, { force: true });
        },
      };
    }
  }
  if (platform === 'darwin') note = MAC_NOTE;
  const reason = target ? null
    : unavailable || unusable || (platform === 'linux' ? 'Not available in WSL. Start Agent Guild from Windows to launch it at sign-in.'
      : 'Not available on this operating system.');

  const FAILED = new Set(['failed', 'port-in-use']);
  /** The service's side of a Linux description: its state, and the commands that are the next step. */
  const describeBoot = async () => {
    const read = await boot.read();
    const base = { note: BOOT_NOTE, user, linger: read.linger };
    if (!read.reachable) return { ...base, available: false, enabled: false, reason: read.reason, state: null, commands: [] };
    const state = startupState(read.show, { pid, port: unitPort(await boot.text()) });
    const commands = [];
    if (read.enabled && FAILED.has(state.kind)) commands.push(journalCommand());
    if (read.enabled && !read.linger) commands.push(lingerCommand(user));
    return { ...base, available: true, enabled: read.enabled, reason: read.enabled ? bootRefreshError : null, state, commands };
  };
  const modeOf = (signIn, bootOn) => (signIn && bootOn ? 'both' : bootOn ? 'boot' : signIn ? 'sign-in' : 'off');

  const describe = async () => {
    if (!target) return { available: false, enabled: false, reason };
    try {
      const enabled = await target.enabled();
      const linux = boot ? await describeBoot() : null;
      return {
        available: true,
        enabled,
        reason: enabled ? refreshError : null,
        ...(note && { note }),
        // An unreadable record never keeps the setting from being turned off.
        lastRun: enabled ? await lastSignIn(dataDir).catch(() => null) : null,
        log,
        ...(linux && { mode: modeOf(enabled, linux.enabled), boot: linux }),
      };
    } catch (err) {
      return { available: false, enabled: false, reason: `Could not read the startup setting: ${err.message}` };
    }
  };

  /**
   * Makes `mode` the one starter. The new one is added and confirmed before
   * the old one goes, and nothing here starts or stops a manager: a service
   * takes over at the manager's next restart or the computer's next start.
   */
  const apply = async (mode) => {
    const signedIn = await target.enabled().catch(() => false);
    // A fresh start says it has not run yet rather than report an earlier time it was on.
    if (mode !== 'sign-in' || !signedIn) await clearSignIns(dataDir);
    if (mode === 'boot') {
      const read = await boot.read();
      if (!read.reachable) throw Object.assign(new Error(read.reason), { status: 409, code: 'autostart_unavailable' });
      try {
        await boot.write(command());
        await boot.reload();
        await boot.enable();
        if (!(await boot.read()).enabled) throw failure('systemd did not enable the unit.');
      } catch (err) {
        // Leave no half-made unit behind; the sign-in entry, if any, is still in place.
        if (!read.enabled) await boot.remove().catch(() => {});
        throw err;
      }
      await target.disable();
      return;
    }
    await (mode === 'sign-in' ? target.enable() : target.disable());
    if (boot) await boot.remove();
  };

  /** Applies the mode `pick` resolves to, inside the queue, and checks the result against what the OS reports. */
  const change = (pick) => serial(async () => {
    if (!target) throw Object.assign(new Error(reason), { status: 409, code: 'autostart_unavailable' });
    const mode = await pick();
    if (mode === 'boot' && !boot) throw Object.assign(new Error('Starting when the computer starts is offered only on Linux with systemd.'), { status: 409, code: 'autostart_unavailable' });
    try {
      await apply(mode);
      refreshError = null;
      bootRefreshError = null;
      const state = await describe();
      const done = boot ? state.mode === mode : state.enabled === (mode === 'sign-in');
      if (!state.available || !done) throw failure(state.reason || 'Could not verify the startup setting.');
      return state;
    } catch (err) {
      throw err.code === 'autostart_failed' || err.code === 'autostart_unavailable' ? err : failure(`Could not change the startup setting: ${err.message}`);
    }
  });

  return {
    describe: () => serial(describe),
    /**
     * Turns the sign-in entry on or off and resolves to the new description.
     * On Linux, on means the sign-in mode, and off keeps a service that is on.
     */
    set: (enabled) => change(async () => {
      if (enabled) return 'sign-in';
      return boot && ['boot', 'both'].includes((await describe()).mode) ? 'boot' : 'off';
    }),
    /** Linux: makes `mode` (off, sign-in or boot) the one way the manager starts. Elsewhere boot is unavailable. */
    setMode: (mode) => change(async () => mode),
    /** Points what is on at this manager's Node.js, package and port. */
    refresh: () => serial(async () => {
      let first = null;
      try {
        if (target && await target.enabled()) await target.write();
        refreshError = null;
      } catch (err) {
        refreshError = `Could not update the sign-in entry: ${err.message}`;
        first = err;
      }
      try {
        if (boot && (await boot.read()).enabled && await boot.write(command())) await boot.reload();
        bootRefreshError = null;
      } catch (err) {
        bootRefreshError = `Could not update the systemd unit: ${err.message}`;
        first ??= err;
      }
      if (first) throw first;
    }),
  };
}
