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
import { ensureDataDir, paths } from './config.mjs';
import { EXIT_RESTART, unitPort } from './systemd-service.mjs';

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
