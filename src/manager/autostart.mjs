// Starting the session manager when the user signs in to the computer.
//
// Each platform gets one per-user entry that runs `agent-guild open
// --no-browser`, which starts a background manager unless one answers:
//
// * Windows: a value under HKCU's Run key. It runs a JScript wrapper in the
//   data folder through wscript.exe, which starts Node.js with no console
//   window; running node.exe directly would flash one at every sign-in.
// * macOS: a LaunchAgent with RunAtLoad. AbandonProcessGroup keeps launchd
//   from killing the manager once the launching command exits.
// * Linux: an XDG autostart entry, run when a desktop session starts.
//
// The entry and the OS's enabled state record whether autostart is on, so
// a user who turns it off outside the app sees it off here too.
// Its paths are absolute, so a running manager rewrites an entry that is on
// at every start: a Node.js version switch or a reinstall then takes effect
// at the next sign-in. npm runs no script when a package is uninstalled, so
// an entry whose package script is gone removes itself at sign-in instead
// of failing there at every sign-in after. A missing Node.js alone keeps
// the entry: the next manager to start points it at its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DEFAULT_PORT } from './config.mjs';

export const ARGS = ['open', '--no-browser'];
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const WINDOWS_VALUE = 'AgentGuild';
export const WINDOWS_WRAPPER = 'autostart.js';
export const LAUNCH_AGENT_LABEL = 'com.oddessentials.agent-guild';

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
export function windowsWrapper({ execPath, script, port = DEFAULT_PORT, runKey = WINDOWS_RUN_KEY, approvedKey = WINDOWS_APPROVED_KEY }) {
  const command = [execPath, script].map((p) => `"${p}"`).concat(ARGS).join(' ');
  return [
    '// Agent Guild: starts the session manager at sign-in without a console window.',
    'var files = new ActiveXObject("Scripting.FileSystemObject");',
    'var shell = new ActiveXObject("WScript.Shell");',
    `if (files.FileExists(${jsString(script)})) {`,
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
 * The sh script a macOS or Linux entry runs, with Node.js as $0, the
 * package script as $1, the entry's own file as $2, and the saved port as
 * $3, so no path is ever part of the script text.
 */
export const POSIX_LAUNCH = `if [ -f "$1" ]; then AGENT_GUILD_PORT="$3" exec "$0" "$1" ${ARGS.join(' ')}; fi; rm -f "$2"`;

/** The entry's command line: sh, its script, then the paths it reads. */
export function posixCommand({ execPath, script, file, port = DEFAULT_PORT }) {
  return ['/bin/sh', '-c', POSIX_LAUNCH, execPath, script, file, portString(port)];
}

const xml = (value) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function launchAgentPlist({ execPath, script, file, port }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...posixCommand({ execPath, script, file, port }).map((arg) => `    <string>${xml(arg)}</string>`),
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
 */
export function desktopArg(value) {
  const quoted = `"${value.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

export function desktopEntry({ execPath, script, file, port }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Guild',
    'Comment=Starts the Agent Guild session manager',
    `Exec=${posixCommand({ execPath, script, file, port }).map(desktopArg).join(' ')}`,
    'Terminal=false',
    'NoDisplay=true',
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

/** Writes `contents` unless the file already holds exactly that. */
async function writeIfChanged(file, contents) {
  if ((await readText(file)) === contents) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  await fs.promises.rename(tmp, file);
}

/**
 * @param {object} opts
 * @param {string} opts.script  bin/agent-guild.mjs of the package that is running
 * @param {string} opts.dataDir  where the Windows wrapper is kept
 * @param {() => number} [opts.getPort]  the bound port, read only when writing an entry
 * @param {string|null} [opts.unavailable]  a reason autostart cannot be offered, which turns it off here
 * @param {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} [opts.reg]  reg.exe, replaceable in tests
 * @param {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} [opts.launchctl]  launchctl, replaceable in tests
 */
export function createAutostart({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  release = os.release(),
  execPath = process.execPath,
  script,
  dataDir,
  getPort = () => DEFAULT_PORT,
  unavailable = null,
  reg = runCommand(path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe')),
  uid = process.getuid?.(),
  launchctl = runCommand('/bin/launchctl'),
}) {
  const command = () => ({ execPath, script, port: getPort() });
  let refreshError = null;
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
      write: () => writeIfChanged(file, launchAgentPlist({ ...command(), file })),
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
            if (previous === null) await fs.promises.rm(file, { force: true });
            else await writeIfChanged(file, previous);
          } catch (restoreError) {
            throw failure(`${err.message} Could not restore the previous startup entry: ${restoreError.message}`);
          }
          throw err;
        }
      },
      disable: () => fs.promises.rm(file, { force: true }),
    };
  } else if (platform === 'linux' && !(env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release))) {
    const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'agent-guild.desktop');
    target = {
      async enabled() {
        const text = await readText(file);
        return text !== null && desktopEntryEnabled(text);
      },
      write: () => writeIfChanged(file, desktopEntry({ ...command(), file })),
      enable() { return this.write(); },
      disable: () => fs.promises.rm(file, { force: true }),
    };
  }
  const reason = target ? null
    : unavailable || (platform === 'linux' ? 'Not available in WSL. Start Agent Guild from Windows to launch it at sign-in.'
      : 'Not available on this operating system.');

  const describe = async () => {
    if (!target) return { available: false, enabled: false, reason };
    try {
      const enabled = await target.enabled();
      return { available: true, enabled, reason: enabled ? refreshError : null };
    } catch (err) {
      return { available: false, enabled: false, reason: `Could not read the startup setting: ${err.message}` };
    }
  };

  return {
    describe: () => serial(describe),
    /** Turns autostart on or off and resolves to the new description. */
    set: (enabled) => serial(async () => {
      if (!target) throw Object.assign(new Error(reason), { status: 409, code: 'autostart_unavailable' });
      try {
        await (enabled ? target.enable() : target.disable());
        refreshError = null;
        const state = await describe();
        if (!state.available || state.enabled !== enabled) throw failure(state.reason || 'Could not verify the startup setting.');
        return state;
      } catch (err) {
        throw err.code === 'autostart_failed' ? err : failure(`Could not change the startup setting: ${err.message}`);
      }
    }),
    /** Points an entry that is on at this manager's Node.js, package and port. */
    refresh: () => serial(async () => {
      try {
        if (target && await target.enabled()) await target.write();
        refreshError = null;
      } catch (err) {
        refreshError = `Could not update the sign-in entry: ${err.message}`;
        throw err;
      }
    }),
  };
}
