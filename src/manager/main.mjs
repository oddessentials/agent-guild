// Session manager entry point. Normally started in the background by
// `agent-guild open`; `agent-guild start` runs it in the foreground.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderRegistry } from './providers.mjs';
import { SessionManager } from './session-manager.mjs';
import { createManagerServer } from './server.mjs';
import { resolveBaseEnv } from './shell-env.mjs';
import {
  DEFAULT_HOST,
  ensureDataDir,
  loadOrCreateToken,
  paths,
  removeRuntimeFile,
  resolvePort,
  writeRuntimeFile,
} from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

export async function startManager({ port = resolvePort(), host = DEFAULT_HOST, sessionDefaults } = {}) {
  ensureDataDir();
  const token = loadOrCreateToken();
  const baseEnv = resolveBaseEnv();
  const webDir = path.join(rootDir, 'web');
  const registry = new ProviderRegistry({ userFile: paths.providers, env: baseEnv, iconDir: path.join(webDir, 'icons') });

  let api;
  const manager = new SessionManager({ registry, baseEnv, getApiUrl: () => api.url, sessionDefaults });
  let closing = null;

  const shutdown = (reason = 'shutdown') => {
    if (closing) return closing;
    console.log(`[manager] stopping (${reason}); ending ${manager.sessions.size} session(s)`);
    removeRuntimeFile();
    closing = Promise.all([manager.shutdown(), api.close()]).then(() => undefined);
    return closing;
  };

  const extraOrigins = (process.env.AGENT_GUILD_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  api = createManagerServer({
    manager,
    registry,
    token,
    host,
    port,
    webDir,
    version: VERSION,
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
    version: VERSION,
    startedAt: new Date().toISOString(),
  });
  console.log(`[manager] Agent Guild ${VERSION} listening on ${api.url} (pid ${process.pid})`);
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
  startManager().then(({ shutdown }) => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
    }
  }).catch((err) => {
    console.error(`[manager] failed to start: ${err.message}`);
    process.exit(1);
  });
}
