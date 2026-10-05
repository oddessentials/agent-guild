// Starting a session manager as a detached background process. Shared by
// the `agent-guild` CLI, which starts one when none is running, and by a
// manager that restarts itself: both run the package on disk, so a restart
// after an upgrade comes up on the new version.
//
// While the Linux boot service is on, systemd is the one that starts a
// manager: a supervised manager exits for systemd to start the next one,
// and one started without systemd hands its restart over to it.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, ensureDataDir, paths } from './config.mjs';
import { stableExecPath } from './autostart.mjs';
import { EXIT_RESTART, UNIT_UNSAFE, bootSupported, createBootService, journalCommand, startupState, unitPort } from './systemd-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The manager entry point, from the package files on disk. */
export const MANAGER_ENTRY = path.join(here, 'main.mjs');
/** The package root the manager runs from. */
export const ROOT_DIR = path.resolve(here, '../..');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Keep one previous log so the file cannot grow without bound. */
function rotateLog() {
  try {
    if (fs.statSync(paths.log).size > MAX_LOG_BYTES) fs.renameSync(paths.log, `${paths.log}.1`);
  } catch { /* no log yet */ }
}

/**
 * Start a manager that outlives this process, with its output appended to
 * `manager.log`. Returns the child; the caller watches `/health` or the
 * runtime file to learn when it is serving.
 *
 * @param {{ env?: NodeJS.ProcessEnv, note?: string }} [opts]
 */
export function spawnManager({ env = process.env, note = 'starting manager' } = {}) {
  ensureDataDir();
  rotateLog();
  const log = fs.openSync(paths.log, 'a');
  fs.writeSync(log, `\n--- ${note} ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env,
  });
  child.unref();
  fs.closeSync(log);
  return child;
}

/**
 * The double-click launcher for this platform, when the package carries one
 * (a checkout of the repository; the npm package does not include them).
 * Null otherwise, so a page never names a file that is not there.
 */
export function launcherPath(platform = process.platform, rootDir = ROOT_DIR) {
  const name = platform === 'win32' ? 'AgentGuild.cmd' : platform === 'darwin' ? 'AgentGuild.command' : null;
  if (!name) return null;
  const file = path.join(rootDir, 'launchers', name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Starts the manager that follows one restarting on `port`, once that one
 * has released the port, and resolves to the exit code it should leave with.
 *
 * - Under the boot service (`supervised`): EXIT_RESTART, so systemd starts
 *   the next one, after resetting its start count so that restarts never
 *   use up the limit kept for crash loops.
 * - With the boot service on for this port: systemd starts it, so the next
 *   manager is supervised.
 * - Otherwise, or if systemd refuses: a detached manager, as before.
 *
 * @param {{ supervised?: boolean, boot?: object|null, port: number, spawn?: typeof spawnManager, log?: (line: string) => void }} opts
 */
export async function nextManager({ supervised = false, boot = null, port, spawn = spawnManager, log = console.log }) {
  if (supervised) {
    await boot?.resetFailed().catch(() => {});
    log('[manager] exiting for systemd to start the next manager');
    return EXIT_RESTART;
  }
  if (boot) {
    try {
      const read = await boot.read();
      if (read.enabled && unitPort(await boot.text()) === port) {
        await boot.resetFailed();
        await boot.start({ block: false });
        log('[manager] systemd is starting the next manager');
        return 0;
      }
    } catch (err) {
      log(`[manager] systemd could not start the next manager (${err.message}); starting it directly`);
    }
  }
  const child = spawn({ note: 'restarting manager', env: { ...process.env, AGENT_GUILD_PORT: String(port) } });
  log(`[manager] started the next manager (pid ${child.pid})`);
  return 0;
}

/** The package script a unit runs: this package's, as the manager names it. */
export const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'bin', 'agent-guild.mjs');

/** The boot service on a Linux that can offer it with the default data folder, or null. */
export function defaultBoot() {
  return bootSupported() && !process.env.AGENT_GUILD_HOME ? createBootService({ dataDir: dataDir() }) : null;
}

/**
 * The boot service when it should start the manager on `port`: on, and for
 * that port. `note` says why an existing unit was passed over, so the
 * caller can say so rather than start an unsupervised manager silently.
 */
export async function serviceFor(port, boot = defaultBoot()) {
  if (!boot) return { boot: null, note: null };
  const read = await boot.read().catch((err) => ({ reachable: false, reason: err.message, enabled: false }));
  if (!read.reachable) {
    const text = await boot.text().catch(() => null);
    return { boot: null, note: text ? `The boot service could not be used (${read.reason}), so the session manager runs without systemd.` : null };
  }
  if (!read.enabled || unitPort(await boot.text()) !== port) return { boot: null, note: null };
  return { boot, note: null };
}

/**
 * Starts the manager through systemd and resolves once `health` answers at
 * `url`. The unit is first pointed at this Node.js and package, as a manager
 * does at each start, so a Node.js removed since cannot keep it failing; a
 * failed state is cleared so systemd does not refuse the start. Throws with
 * the service's last journal lines when it does not come up.
 */
export async function startService({ boot, port, url, health, execPath = stableExecPath(process.execPath), script = PACKAGE_SCRIPT, timeoutMs = 20000, pollMs = 250 }) {
  if (![execPath, script].some((p) => UNIT_UNSAFE.test(p)) && await boot.write({ execPath, script, port })) await boot.reload();
  await boot.resetFailed();
  await boot.start({ block: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await health(url, 500);
    if (up) return { url, started: true, version: up.version };
    const read = await boot.read().catch(() => null);
    const state = read && startupState(read.show, { pid: null, port });
    if (state && ['failed', 'port-in-use', 'stopped'].includes(state.kind)) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const journal = await boot.journal(20);
  throw new Error(`the session manager did not start under systemd.${journal ? `\n\nRecent log (${journalCommand(20)}):\n${journal}` : ''}`);
}
