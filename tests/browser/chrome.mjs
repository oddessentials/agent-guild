import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(repo, 'web');
const vendor = {
  '/vendor/xterm/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/xterm/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/xterm/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(label, check) {
  const end = Date.now() + 15000;
  do { const value = await check(); if (value) return value; await pause(40); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}

export async function withPage({ name, instrumentation = '', headers = () => ({}), chromeArgs = [] }, run) {
  const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((file) => file && fs.existsSync(file));
  assert.ok(chromePath, 'Chrome is required; set CHROME_PATH to its executable');
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const file = vendor[route] ? path.join(repo, 'node_modules', vendor[route])
      : route === '/demo-runtime.js' ? path.join(repo, 'docs/demo/demo-runtime.js')
        : path.resolve(web, `.${route === '/' ? '/index.html' : route}`);
    if (!file.startsWith(repo) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    for (const [header, value] of Object.entries(headers())) res.setHeader(header, value);
    if (route === '/') {
      const html = fs.readFileSync(file, 'utf8').replace('<script type="module" src="/app.js"></script>',
        '<script src="/demo-runtime.js"></script>' + instrumentation + '<script type="module" src="/app.js"></script>');
      res.end(html);
    } else fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `guild-${name}-browser-`));
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), ...chromeArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '', socket;
  chrome.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-3000); });
  let startupError;
  chrome.on('error', (error) => { startupError = error; });
  let checks = 0;
  const pass = (label) => { checks++; console.log(`ok ${checks} - ${label}`); };
  try {
    const port = await until('Chrome DevTools', () => {
      if (startupError) throw startupError;
      if (chrome.exitCode !== null) throw new Error(diagnostics);
      try { return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; }
    }).catch((error) => { throw new Error(`${error.message}\n${diagnostics}`); });
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0;
    const pending = new Map(), errors = [];
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Page.javascriptDialogOpening') {
        // The demo deliberately guards navigation while its simulated sessions run.
        if (message.params.type !== 'beforeunload') errors.push(`Unexpected ${message.params.type} dialog`);
        send('Page.handleJavaScriptDialog', { accept: true }).catch((error) => errors.push(error.message));
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    };
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    // Fonts can change header height. Two frames let ResizeObserver and the app's
    // scheduled fit finish, without assuming a particular machine's speed.
    const layoutReady = () => evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await send('Page.enable');
    await send('Runtime.enable');
    await run({ origin, send, evaluate, layoutReady, pass, errors });
    return checks;
  } finally {
    socket?.close();
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const stopped = new Promise((resolve) => chrome.once('exit', resolve));
      const force = setTimeout(() => chrome.kill('SIGKILL'), 2000);
      chrome.kill();
      await stopped;
      clearTimeout(force);
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
