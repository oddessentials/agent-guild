// Captures the README screenshots and banner from the real page.
//
// It starts a separate session manager in this process, with its own data
// folder and port, so a manager you already run is never touched. The
// built-in providers are pointed at demo-tool.mjs, demo-usage.mjs and
// demo-history.mjs, so the shots need no coding tool, sign-in or account
// data; benchmarks, news and releases are fetched live, as the app does.
// The page is driven in headless Chrome through the DevTools protocol, so
// nothing beyond the project's own dependencies is installed.
//
//   node docs/capture/capture.mjs [--out docs/images] [--root <folder>]
//        [--port 47900] [--version <x.y.z>] [--chrome <path>] [--keep]
//
// --root     the folder the demo sessions work in; its subfolders are
//            created. It is shown on the cards, so pick a neutral path.
//            Defaults to a folder in the system temp folder.
// --version  the version the top bar shows. Defaults to the latest v* tag.
// --keep     leave the manager running after the shots, printing its URL,
//            for recording video. Stop it with Ctrl+C.
// CHROME_PATH or --chrome names the browser when it is not found.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const out = path.resolve(option('--out', path.join(repo, 'docs', 'images')));
const root = path.resolve(option('--root', path.join(os.tmpdir(), 'agent-guild-demo')));
const port = Number(option('--port', 47900));
const keep = argv.includes('--keep');
const version = option('--version', null) || latestTag();

const WIDTH = 1360;
const SCALE = 2;
const QUALITY = 90;

function latestTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: repo, encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch {
    return '1.0.0';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the demo manager -------------------------------------------------------

const FOLDERS = ['storefront', 'billing', 'api-gateway', 'docs-site', 'game-engine'];
for (const folder of FOLDERS) fs.mkdirSync(path.join(root, folder), { recursive: true });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-capture-'));
const node = process.execPath;
const script = (name) => path.join(here, name);

/** The current npm release of a tool, so its card shows a real version. */
async function npmVersion(pkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(10000) });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null;
  }
}

const PACKAGES = {
  anthropic: '@anthropic-ai/claude-code',
  openai: '@openai/codex',
  google: '@google/gemini-cli',
  xai: '@xai-official/grok',
};

const providers = [];
for (const id of [...Object.keys(PACKAGES), 'shell']) {
  const toolVersion = PACKAGES[id] ? await npmVersion(PACKAGES[id]) : null;
  providers.push({
    id,
    command: node,
    args: [script('demo-tool.mjs')],
    // No install channels: the demo tool is not the copy on this machine.
    channels: {},
    // What the real provider has: no version for the shell, no usage meter
    // for Grok Build.
    ...(id === 'shell' ? {} : {
      versionArgs: [script('demo-tool.mjs'), '--version'],
      env: { DEMO_VERSION: toolVersion || '1.0.0' },
      history: { command: node, args: [script('demo-history.mjs'), id, root] },
      accountEnv: { DEMO_ACCOUNT: '{dir}' },
    }),
    ...(id === 'shell' || id === 'xai' ? {} : { usage: { command: node, args: [script('demo-usage.mjs'), id] } }),
    ...(id === 'anthropic' ? { accounts: [{ id: 'default', label: 'Personal' }, { id: 'work', label: 'Work' }] } : {}),
  });
}
fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers }, null, 2));

Object.assign(process.env, {
  AGENT_GUILD_HOME: home,
  AGENT_GUILD_PORT: String(port),
  AGENT_GUILD_NO_UPDATE_CHECK: '1',
  AGENT_GUILD_SKIP_SHELL_ENV: '1',
});
const { startManager } = await import(pathToFileURL(path.join(repo, 'src', 'manager', 'main.mjs')));
const { api, token, shutdown } = await startManager({ version });
const base = api.url;
console.log(`[capture] demo manager ${version} at ${base} (data in ${home})`);

async function call(method, route, body) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function until(what, check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

await until('provider versions', async () => (await call('GET', '/providers')).providers.every((p) => p.available));
const stats = await until('benchmarks', async () => {
  const s = await call('GET', '/model-stats');
  return s.error && !s.models ? null : Object.keys(s.providers || {}).length ? s : null;
}, 60000);

/** A provider's featured model, or its newest other one, as the tool would report it. */
function model(providerId, { other = false } = {}) {
  const entry = stats.providers[providerId];
  if (!entry) return [];
  const id = other ? entry.models.find((m) => m !== entry.featured) || entry.featured : entry.featured;
  const card = stats.models[id];
  return ['--model', id.split('/').pop(), card.name.replace(/^[^:]+:\s*/, '')];
}

const SESSIONS = [
  { providerId: 'anthropic', name: 'Checkout: wallet payments', folder: 'storefront', script: 'checkout', agents: 'Explore:working,Test writer:working,Reviewer:waiting', model: model('anthropic') },
  { providerId: 'anthropic', account: 'work', name: 'Billing API migration', folder: 'billing', script: 'billing', agents: 'Explore:working', model: model('anthropic', { other: true }) },
  { providerId: 'openai', name: 'Gateway rate limits', folder: 'api-gateway', script: 'ratelimit', agents: 'Worker:working,Tests:working', model: model('openai') },
  { providerId: 'google', name: 'Docs site migration', folder: 'docs-site', script: 'docs', agents: 'Migrator:working', model: model('google') },
  { providerId: 'xai', name: 'Particle shader perf', folder: 'game-engine', script: 'shaders', agents: 'Profiler:working', model: model('xai') },
  { providerId: 'shell', name: 'Storefront dev server', folder: 'storefront', script: 'shell', quiet: true },
];

for (const s of SESSIONS) {
  const args = ['--script', s.script, ...(s.model || []), ...(s.agents ? ['--agents', s.agents] : []), ...(s.quiet ? ['--quiet'] : [])];
  await call('POST', '/sessions', { providerId: s.providerId, account: s.account, name: s.name, cwd: path.join(root, s.folder), cols: 120, rows: 32, args });
  await sleep(300);
}

// ---- headless Chrome --------------------------------------------------------

function findChrome() {
  const named = option('--chrome', process.env.CHROME_PATH);
  if (named) return named;
  const candidates = {
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  }[process.platform] || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error('Chrome was not found; set CHROME_PATH or pass --chrome <path>');
  return found;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-chrome-'));
const chrome = spawn(findChrome(), [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${WIDTH},1000`,
  'about:blank',
], { stdio: 'ignore' });

const devtoolsPort = await until('Chrome', () => {
  try {
    return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null;
  } catch {
    return null;
  }
});
const target = await until('a Chrome tab', async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  return tabs.find((t) => t.type === 'page');
});

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 1;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
  else waiter.resolve(msg.result);
};
function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
}

const viewport = (height, width = WIDTH) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false });

/** `fullPage` grows the viewport to the page; `until` stops above that element. */
async function shot(name, { height = 1000, width = WIDTH, fullPage = false, until: stop = null } = {}) {
  if (fullPage) {
    await viewport(height, width);
    const content = await evaluate(stop
      ? `Math.ceil(document.querySelector(${JSON.stringify(stop)}).getBoundingClientRect().top + scrollY)`
      : 'Math.ceil(document.documentElement.scrollHeight)');
    await viewport(content, width);
    await sleep(600);
  }
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: QUALITY });
  const file = path.join(out, `${name}.webp`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[capture] ${path.relative(repo, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  if (fullPage) await viewport(height, width);
}

const waitFor = (what, expression, timeoutMs) => until(what, () => evaluate(expression), timeoutMs);
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const press = (key) => send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 })
  .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 }));

// ---- the shots --------------------------------------------------------------

fs.mkdirSync(out, { recursive: true });
await send('Page.enable');
await send('Runtime.enable');
await viewport(1000);

// The page keeps its token and theme in localStorage; start from known values.
await send('Page.navigate', { url: `${base}/` });
await sleep(800);
await evaluate(`localStorage.clear(); localStorage.setItem('agentGuild.theme', 'dark'); true`);
// Only a fragment changes otherwise, which does not load the page again.
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: `${base}/#token=${token}` });

await waitFor('the provider cards', `document.querySelectorAll('#providers .provider').length >= 5`);
await waitFor('the session cards', `document.querySelectorAll('#sessions .session-card').length >= ${SESSIONS.length}`);
await waitFor('the benchmarks', `document.querySelectorAll('#providers .model-stats .stat').length >= 4`, 60000);
await waitFor('the usage meters', `document.querySelectorAll('#providers .meter').length >= 4`);
await waitFor('the news', `document.querySelectorAll('#news-latest > *').length >= 3`, 90000);
await waitFor('the agents', `document.querySelectorAll('#sessions .agents [data-agent]').length >= 6`);
await sleep(3000);

await shot('overview-dark', { fullPage: true, until: 'section.news' });

await click('#theme-toggle');
await sleep(2000);
await shot('overview-light', { fullPage: true, until: 'section.news' });
await click('#theme-toggle');
await sleep(2000);

await click('.provider[data-id="anthropic"] .model-stats > :first-child');
await waitFor('the models dialog', `document.querySelectorAll('#models-list .model').length > 0`);
await sleep(1500);
await shot('models');
await click('#models-close');
await sleep(600);

await click('#news-all');
await waitFor('the news panel', `document.querySelectorAll('#news-list > *').length > 3`);
await sleep(1500);
await shot('news');
await click('#news-close');
await sleep(600);

await click('.provider[data-id="anthropic"] .existing');
await waitFor('the session history', `document.querySelectorAll('#history-list .history-row').length > 3`);
await sleep(1200);
await shot('history');
await click('#history-close');
await sleep(600);

await click('#version');
await waitFor('the release notes', `document.querySelectorAll('#changelog-list > *').length > 0`, 60000);
await sleep(1500);
await shot('whats-new');
await click('#changelog-close');
await sleep(600);

// The panel fills the window; a shorter one leaves less empty terminal.
await viewport(720);
await click('#sessions .session-card .open');
await waitFor('the terminal', `document.querySelector('#terminal-host .xterm-rows')?.textContent.trim().length > 40`);
await sleep(2500);
await shot('terminal');
await click('#panel-close');
await sleep(600);
await viewport(1000);

// The banner is a small page of its own, drawn from the shipped art.
await viewport(560, 1600);
await send('Page.navigate', { url: pathToFileURL(path.join(here, 'banner.html')).href });
await waitFor('the banner', `document.fonts.status === 'loaded' && [...document.images].every((img) => img.complete)`);
await sleep(800);
await shot('banner', { height: 560 });

// ---- done -------------------------------------------------------------------

socket.close();
chrome.kill();
if (keep) {
  console.log(`[capture] the demo manager keeps running: ${base}/#token=${token}`);
  console.log('[capture] press Ctrl+C to stop it');
  process.on('SIGINT', () => shutdown('capture done').then(() => process.exit(0)));
} else {
  await shutdown('capture done');
  for (const dir of [home, profile]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
}
