#!/usr/bin/env node
// Agent Guild launcher.
//
//   agent-guild [open]     start the session manager if needed, open the page
//   agent-guild start      run the session manager in the foreground
//   agent-guild stop       stop the manager (ends all sessions)
//   agent-guild status     show whether the manager is running
//   agent-guild url        print the page URL (includes the access token)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HOST,
  ensureDataDir,
  loadOrCreateToken,
  paths,
  readRuntimeFile,
  resolvePort,
} from '../src/manager/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const managerEntry = path.resolve(here, '../src/manager/main.mjs');

function usage() {
  console.log(`Usage: agent-guild [command] [--no-browser]

Commands:
  open      Start the session manager if needed and open the web page (default)
  start     Run the session manager in the foreground
  stop      Stop the session manager and every session it owns
  status    Show whether the session manager is running
  url       Print the web page URL, including the access token

Environment:
  AGENT_GUILD_PORT             Port for the local API (default 47821)
  AGENT_GUILD_HOME             Data directory (default: per-user app data folder)
  AGENT_GUILD_NPM_REGISTRY     npm registry for version checks and installs
  AGENT_GUILD_NO_UPDATE_CHECK  Set to 1 to skip version checks`);
}

function baseUrl() {
  const runtime = readRuntimeFile();
  if (runtime?.url) return runtime.url;
  return `http://${DEFAULT_HOST}:${resolvePort()}`;
}

async function health(url, timeoutMs = 1000) {
  try {
    const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.name === 'agent-guild' ? body : null;
  } catch {
    return null;
  }
}

function pageUrl(url, token) {
  return `${url}/#token=${token}`;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'darwin') child = spawn('open', [url], opts);
  else if (process.platform === 'win32') {
    // rundll32 avoids cmd.exe's special handling of characters like "&" in URLs.
    child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { ...opts, windowsHide: true });
  } else child = spawn('xdg-open', [url], opts);
  child.on('error', () => console.log(`Could not open a browser automatically. Open this URL:\n  ${url}`));
  child.unref();
}

function tailLog(lines = 15) {
  try {
    return fs.readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Keep one previous log so the file cannot grow without bound. */
function rotateLog() {
  try {
    if (fs.statSync(paths.log).size > MAX_LOG_BYTES) fs.renameSync(paths.log, `${paths.log}.1`);
  } catch { /* no log yet */ }
}

async function ensureManager() {
  const running = await health(baseUrl());
  if (running) return { url: baseUrl(), started: false };

  ensureDataDir();
  rotateLog();
  const log = fs.openSync(paths.log, 'a');
  fs.writeSync(log, `\n--- starting manager ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [managerEntry], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);

  let exited = false;
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + 20000;
  const expectedUrl = `http://${DEFAULT_HOST}:${resolvePort()}`;
  while (Date.now() < deadline && !exited) {
    await new Promise((r) => setTimeout(r, 250));
    const url = readRuntimeFile()?.pid === child.pid ? readRuntimeFile().url : expectedUrl;
    if (await health(url, 500)) return { url, started: true };
  }
  // Two launchers started together both try to start a manager; the one
  // that lost the race should use the winner rather than report a failure.
  if (await health(expectedUrl, 1000)) return { url: expectedUrl, started: false };
  const details = tailLog();
  throw new Error(`the session manager did not start.${details ? `\n\nRecent log (${paths.log}):\n${details}` : ''}`);
}

async function cmdOpen({ browser }) {
  const { url, started } = await ensureManager();
  const token = loadOrCreateToken();
  const target = pageUrl(url, token);
  console.log(started ? `Session manager started at ${url}` : `Session manager already running at ${url}`);
  if (browser) {
    openBrowser(target);
    console.log('Opening Agent Guild in your browser. You can close the page at any time; sessions keep running.');
  } else {
    console.log(`Open: ${target}`);
  }
}

async function cmdStop() {
  const url = baseUrl();
  if (!(await health(url))) {
    console.log('Session manager is not running.');
    return;
  }
  // `stop` is documented as ending every session, so it does not ask; the
  // web page's Stop manager button is the one that confirms first.
  const res = await fetch(`${url}/api/v1/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${loadOrCreateToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  if (!res.ok) throw new Error(`stop failed: HTTP ${res.status}`);
  const { running = 0 } = await res.json().catch(() => ({}));
  if (running > 0) console.log(`Ending ${running} running session(s).`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await health(url, 300))) {
      console.log('Session manager stopped.');
      return;
    }
  }
  console.log('Stop requested; the manager is still shutting down.');
}

async function cmdStatus() {
  const url = baseUrl();
  const h = await health(url);
  if (!h) {
    console.log('Session manager is not running.');
    process.exitCode = 3;
    return;
  }
  const res = await fetch(`${url}/api/v1/sessions`, { headers: { Authorization: `Bearer ${loadOrCreateToken()}` } });
  const { sessions = [] } = res.ok ? await res.json() : {};
  const running = sessions.filter((s) => s.status === 'running').length;
  console.log(`Session manager ${h.version} running at ${url} (pid ${h.pid}).`);
  console.log(`${sessions.length} session(s), ${running} running.`);
  for (const s of sessions) {
    const model = s.model ? ` [${s.model.displayName || s.model.name}]` : '';
    const agents = s.agents.length ? `, ${s.agents.length} agent(s)` : '';
    console.log(`  ${s.id}  ${s.provider.vendor.padEnd(10)} ${s.status.padEnd(8)} ${s.name}${model}${agents}`);
  }
}

const MIN_NODE_MAJOR = 22;

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR} or newer is required; this is ${process.versions.node}. Install a current LTS from https://nodejs.org.`);
  }
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const command = args.find((a) => !a.startsWith('-')) || 'open';
  if (flags.has('-h') || flags.has('--help') || command === 'help') return usage();

  switch (command) {
    case 'open': return cmdOpen({ browser: !flags.has('--no-browser') });
    case 'start': {
      await import('../src/manager/main.mjs').then(async (m) => {
        process.on('uncaughtException', (err) => console.error('[manager] unexpected error:', err));
        process.on('unhandledRejection', (err) => console.error('[manager] unhandled rejection:', err));
        const { shutdown } = await m.startManager();
        console.log(`Open: ${pageUrl(readRuntimeFile()?.url ?? baseUrl(), loadOrCreateToken())}`);
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
          process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
        }
      });
      return undefined;
    }
    case 'stop': return cmdStop();
    case 'status': return cmdStatus();
    case 'url': {
      console.log(pageUrl(baseUrl(), loadOrCreateToken()));
      return undefined;
    }
    default:
      usage();
      process.exitCode = 2;
      return undefined;
  }
}

main().catch((err) => {
  console.error(`agent-guild: ${err.message}`);
  process.exit(1);
});
