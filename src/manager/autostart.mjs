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
// The entry itself records whether autostart is on, so a user who turns it
// off in Task Manager or a desktop's startup settings sees it off here too.
// Its paths are absolute, so a running manager rewrites an entry that is on
// at every start: a Node.js version switch or a reinstall then takes effect
// at the next sign-in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const ARGS = ['open', '--no-browser'];
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const WINDOWS_VALUE = 'AgentGuild';
export const WINDOWS_WRAPPER = 'autostart.js';
export const LAUNCH_AGENT_LABEL = 'com.oddessentials.agent-guild';

const failure = (message) => Object.assign(new Error(message), { status: 500, code: 'autostart_failed' });

/** A JScript string literal: JSON's escapes, with everything outside ASCII as \u escapes so the file's code page cannot matter. */
function jsString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The JScript that wscript.exe runs at sign-in: the launcher with its window hidden (0), not waited for. */
export function windowsWrapper({ execPath, script }) {
  const command = [execPath, script].map((p) => `"${p}"`).concat(ARGS).join(' ');
  return [
    '// Agent Guild: starts the session manager at sign-in without a console window.',
    `new ActiveXObject("WScript.Shell").Run(${jsString(command)}, 0, false);`,
    '',
  ].join('\r\n');
}

/** The Run value's command line. */
export function windowsRunCommand({ env, wrapper }) {
  const wscript = path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  return `"${wscript}" //B //NoLogo "${wrapper}"`;
}

const xml = (value) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function launchAgentPlist({ execPath, script }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[execPath, script, ...ARGS].map((arg) => `    <string>${xml(arg)}</string>`),
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

export function desktopEntry({ execPath, script }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Guild',
    'Comment=Starts the Agent Guild session manager',
    `Exec=${[execPath, script].map(desktopArg).concat(ARGS).join(' ')}`,
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

function runReg(env) {
  const reg = path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
  return (args) => new Promise((resolve) => {
    execFile(reg, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
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
 * @param {string|null} [opts.unavailable]  a reason autostart cannot be offered, which turns it off here
 * @param {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} [opts.reg]  reg.exe, replaceable in tests
 */
export function createAutostart({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  release = os.release(),
  execPath = process.execPath,
  script,
  dataDir,
  unavailable = null,
  reg = runReg(env),
}) {
  const paths = { execPath, script };
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
      write: () => writeIfChanged(wrapper, windowsWrapper(paths)),
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
  } else if (platform === 'darwin' || (platform === 'linux' && !(env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release)))) {
    const file = platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'agent-guild.desktop');
    const contents = () => (platform === 'darwin' ? launchAgentPlist(paths) : desktopEntry(paths));
    target = {
      async enabled() {
        const text = await readText(file);
        return text !== null && (platform === 'darwin' || desktopEntryEnabled(text));
      },
      write: () => writeIfChanged(file, contents()),
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
      return { available: true, enabled: await target.enabled(), reason: null };
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
      } catch (err) {
        throw err.code === 'autostart_failed' ? err : failure(`Could not change the startup setting: ${err.message}`);
      }
      return describe();
    }),
    /** Points an entry that is on at this manager's Node.js and package. */
    refresh: () => serial(async () => {
      if (target && await target.enabled()) await target.write();
    }),
  };
}
