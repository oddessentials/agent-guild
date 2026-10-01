// Session manager entry point. Normally started in the background by
// `agent-guild open`; `agent-guild start` runs it in the foreground.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderRegistry } from './providers.mjs';
import { SessionManager } from './session-manager.mjs';
import { UsageMonitor } from './usage.mjs';
import { ModelStats } from './model-stats.mjs';
import { createManagerServer } from './server.mjs';
import { SelfUpdate } from './self-update.mjs';
import { resolveBaseEnv, pathReader } from './shell-env.mjs';
import { writeReportShims } from './report-shims.mjs';
import {
  DEFAULT_HOST,
  PACKAGE_FILE,
  PACKAGE_NAME,
  VERSION,
  ensureDataDir,
  loadOrCreateToken,
  paths,
  removeRuntimeFile,
  resolvePort,
  writeRuntimeFile,
} from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../..');

const VERSION_REFRESH_MS = 60 * 60 * 1000;

/** `version` and `packageFile` stand in for the real ones in tests. */
export async function startManager({ port = resolvePort(), host = DEFAULT_HOST, sessionDefaults, version = VERSION, packageFile = PACKAGE_FILE } = {}) {
  ensureDataDir();
  const token = loadOrCreateToken();
  const baseEnv = resolveBaseEnv();
  const webDir = path.join(rootDir, 'web');
  // The hooks in examples/ call `agent-guild-report` by name; these shims
  // make that name resolve inside every session. Regenerated at each start
  // because the Node.js path can change between runs.
  let shimDir = null;
  try {
    shimDir = writeReportShims({ dir: paths.shims, script: path.join(rootDir, 'bin', 'agent-guild-report.mjs') });
  } catch (err) {
    console.warn(`[manager] could not write the agent-guild-report launchers to ${paths.shims}: ${err.message}; hooks need the command on PATH`);
  }
  const registry = new ProviderRegistry({
    userFile: paths.providers,
    env: baseEnv,
    iconDir: path.join(webDir, 'icons'),
    registryUrl: process.env.AGENT_GUILD_NPM_REGISTRY || undefined,
    checkUpdates: process.env.AGENT_GUILD_NO_UPDATE_CHECK !== '1',
    pathReader: pathReader(process.platform, baseEnv),
  });

  let api;
  const selfUpdate = new SelfUpdate({ pkg: PACKAGE_NAME, version, packageFile, registry });
  const manager = new SessionManager({ registry, baseEnv, getApiUrl: () => api.url, sessionDefaults, shimDir, selfUpdate });
  const usage = new UsageMonitor({ registry, env: baseEnv });
  const modelStats = new ModelStats({ registry });
  let closing = null;

  const refreshVersions = () => {
    registry.refreshVersions().catch(() => {});
    selfUpdate.refresh().catch(() => {});
  };
  const versionTimer = setInterval(refreshVersions, VERSION_REFRESH_MS);
  versionTimer.unref();

  const shutdown = (reason = 'shutdown') => {
    if (closing) return closing;
    console.log(`[manager] stopping (${reason}); ending ${manager.sessions.size} session(s)`);
    clearInterval(versionTimer);
    removeRuntimeFile();
    // Sessions end before the API closes, and the last event says whether
    // every process confirmed its exit, so a client can tell a clean stop
    // from a timeout. The manager refuses new sessions meanwhile.
    closing = manager.shutdown().then(({ remaining }) => {
      if (remaining > 0) console.warn(`[manager] ${remaining} session process(es) did not confirm exiting in time`);
      return api.close({ notice: { type: 'manager.stopped', remaining } });
    });
    return closing;
  };

  const extraOrigins = (process.env.AGENT_GUILD_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  api = createManagerServer({
    manager,
    registry,
    usage,
    modelStats,
    token,
    host,
    port,
    webDir,
    version,
    selfUpdate,
    extraOrigins,
    onShutdownRequest: () => shutdown('requested via API').then(() => process.exit(0)),
  });

  try {
    await api.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      err.message = `port ${port} is already in use. Is another Agent Guild manager running? ` +
        'Set AGENT_GUILD_PORT to use a different port.';
    }
    throw err;
  }

  writeRuntimeFile({
    pid: process.pid,
    host,
    port: api.port,
    url: api.url,
    version,
    startedAt: new Date().toISOString(),
  });
  console.log(`[manager] Agent Guild ${version} listening on ${api.url} (pid ${process.pid})`);
  refreshVersions();
  return { api, manager, registry, token, shutdown };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  // The manager exists to keep sessions alive. An unexpected error in one
  // request or session must not take every other session down with it, so
  // log it and keep serving.
  process.on('uncaughtException', (err) => console.error('[manager] unexpected error:', err));
  process.on('unhandledRejection', (err) => console.error('[manager] unhandled rejection:', err));
  startManager().then(({ shutdown }) => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
    }
  }).catch((err) => {
    console.error(`[manager] failed to start: ${err.message}`);
    process.exit(1);
  });
}
