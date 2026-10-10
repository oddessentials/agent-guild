import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createManagerServer } from '../src/manager/server.mjs';
import { RUN_TIMEOUT_MS } from '../src/manager/command-resolver.mjs';
import { PROBE_TIMEOUT_MS } from '../src/manager/session-hooks.mjs';
import { signInLink } from '../web/remote-access.js';
import {
  DEFAULT_FONT_SIZE, FONT_SIZES, REQUEST_TIMEOUT_MS, START_TIMEOUT_MS, STATES, dictatedText, exitLine, folderName, orderSessions,
  relativeTime, sessionState, sessionSummary, stateLabel, stepFontSize, tokenFromHash, tokenFromInput,
} from '../web/mobile/model.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(repo, 'web');

const running = (extra = {}) => ({
  id: 'a', name: 'Claude Code', status: 'running', activity: 'quiet', agents: [], shells: [], task: null, multiplexer: null,
  exitCode: null, signal: null, createdAt: '2026-10-10T10:00:00.000Z', provider: { color: '#D97757', monogram: 'A' }, ...extra,
});

test('a session reads as what may be waiting for you first', () => {
  assert.equal(sessionState(running()), 'attention');
  assert.equal(sessionState(running({ activity: 'active' })), 'active');
  assert.equal(sessionState(running({ agents: [{ id: 'x' }] })), 'busy');
  assert.equal(sessionState(running({ shells: [{ id: 'shell-1', kind: 'shell' }] })), 'busy');
  assert.equal(sessionState(running({ task: 'install' })), 'task');
  assert.equal(sessionState(running({ status: 'exited' })), 'exited');
  assert.equal(sessionState(running({ status: 'exited', multiplexer: { label: 'tmux', attach: 'tmux attach -t guild-1', reattachable: true } })), 'detached');
  assert.equal(stateLabel(running()), 'Quiet');
  assert.equal(stateLabel(running({ activity: 'active' })), 'Active');
  assert.equal(stateLabel(running({ status: 'exited', exitCode: 1 })), 'Exited (1)');
  assert.equal(stateLabel(running({ status: 'exited', exitCode: 0 })), 'Exited');
  assert.equal(stateLabel(running({ status: 'exited', exitCode: 1, multiplexer: { label: 'tmux', attach: '', reattachable: false } })), 'Exited');
  assert.equal(sessionSummary(running({ agents: [{}, {}], shells: [{}], model: { name: 'claude-opus-4-5', displayName: 'Opus 4.5' } })), '2 agents · 1 command · Opus 4.5');
  assert.equal(sessionSummary(running({ model: { name: 'gpt-5-codex', displayName: null } })), 'gpt-5-codex');
  assert.equal(sessionSummary(running()), '');
  assert.equal(sessionSummary(running({ status: 'exited', signal: 'SIGHUP' })), 'Ended by SIGHUP');
  assert.equal(sessionSummary(running({ status: 'exited', exitCode: 2 })), 'Exited with code 2');
  assert.equal(sessionSummary(running({ status: 'exited', exitCode: 0 })), 'Exited');
  assert.equal(sessionSummary(running({ status: 'exited', multiplexer: { label: 'herdr', attach: '', reattachable: true } })), 'herdr still runs this session');
  assert.equal(sessionSummary(running({ status: 'exited', multiplexer: { label: 'tmux', attach: '', reattachable: false } })), 'tmux session ended');
});

test('the list puts quiet sessions first, then the rest newest first, in one fixed order', () => {
  const sessions = [
    running({ id: 'exited', status: 'exited', createdAt: '2026-10-10T12:00:00.000Z' }),
    running({ id: 'active-old', activity: 'active', createdAt: '2026-10-10T09:00:00.000Z' }),
    running({ id: 'quiet', createdAt: '2026-10-10T08:00:00.000Z' }),
    running({ id: 'active-new', activity: 'active', createdAt: '2026-10-10T11:00:00.000Z' }),
    running({ id: 'busy', agents: [{}], createdAt: '2026-10-10T11:30:00.000Z' }),
    running({ id: 'detached', status: 'exited', multiplexer: { label: 'tmux', attach: '', reattachable: true }, createdAt: '2026-10-10T13:00:00.000Z' }),
  ];
  const ordered = orderSessions(sessions).map((session) => session.id);
  assert.deepEqual(ordered, ['quiet', 'active-new', 'active-old', 'busy', 'detached', 'exited']);
  assert.deepEqual(orderSessions([...sessions].reverse()).map((session) => session.id), ordered);
  assert.deepEqual(orderSessions([running({ id: 'b' }), running({ id: 'a' })]).map((session) => session.id), ['a', 'b']);
  assert.deepEqual(STATES, ['attention', 'active', 'busy', 'task', 'detached', 'exited']);
});

test('folder names, relative times and exit lines read on a phone', () => {
  assert.equal(folderName('/Users/me/src/app'), 'app');
  assert.equal(folderName('C:\\Users\\me\\src\\app\\'), 'app');
  assert.equal(folderName('/'), '/');
  assert.equal(folderName(''), '');
  assert.equal(folderName(null), '');
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  assert.equal(relativeTime('2026-10-10T11:59:58.000Z', now), 'now');
  assert.equal(relativeTime('2026-10-10T11:59:18.000Z', now), '42s');
  assert.equal(relativeTime('2026-10-10T11:55:00.000Z', now), '5m');
  assert.equal(relativeTime('2026-10-10T09:00:00.000Z', now), '3h');
  assert.equal(relativeTime('2026-10-08T12:00:00.000Z', now), '2d');
  assert.equal(relativeTime('2026-10-10T12:00:30.000Z', now), 'now', 'a clock ahead of the phone is not the future');
  assert.equal(relativeTime(null, now), '');
  assert.equal(exitLine(running(), { exitCode: 0, signal: null }), '[process exited with code 0]');
  assert.equal(exitLine(running(), { exitCode: null, signal: 'SIGHUP' }), '[process exited with signal SIGHUP]');
  assert.equal(exitLine(running({ multiplexer: { label: 'tmux' } }), { exitCode: 1, signal: null }), '[closed]');
});

test('the sign-in form takes a token or the sign-in link, and dictation never submits', () => {
  assert.equal(tokenFromInput('  abc123  '), 'abc123');
  assert.equal(tokenFromInput('https://guild.example.ts.net/mobile/#token=abc123'), 'abc123');
  assert.equal(tokenFromInput('https://guild.example.ts.net/#token=abc123'), 'abc123');
  assert.equal(tokenFromInput('http://127.0.0.1:47821/#token=abc123&x=1'), 'abc123');
  assert.equal(tokenFromInput('https://guild.example.ts.net/'), null);
  assert.equal(tokenFromInput(''), null);
  assert.equal(tokenFromInput(null), null);
  assert.equal(tokenFromInput('two words'), null);
  assert.equal(tokenFromHash('#token=abc123'), 'abc123');
  assert.equal(tokenFromHash('token=abc123'), 'abc123');
  assert.equal(tokenFromHash('#other=1'), null);
  assert.equal(tokenFromHash(''), null);
  assert.equal(dictatedText('  run the\ttests\r\n', true), 'run the tests');
  assert.equal(dictatedText('and lint', false), ' and lint');
  assert.equal(dictatedText('\x03', true), '');
  assert.equal(dictatedText(undefined, true), '');
  assert.equal(stepFontSize(DEFAULT_FONT_SIZE, 1), 14);
  assert.equal(stepFontSize(DEFAULT_FONT_SIZE, -1), 12);
  assert.equal(stepFontSize(18, 1), 18);
  assert.equal(stepFontSize(11, -1), 11);
  assert.equal(stepFontSize(99, 1), FONT_SIZES[FONT_SIZES.indexOf(DEFAULT_FONT_SIZE) + 1]);
});

test('the desktop sign-in link opens the phone view at the remote address with the token in the fragment', () => {
  assert.equal(signInLink('https://guild.example.ts.net', 'abc'), 'https://guild.example.ts.net/mobile/#token=abc');
  assert.equal(signInLink('https://guild.example.ts.net:8443', 'a b'), 'https://guild.example.ts.net:8443/mobile/#token=a+b');
  assert.equal(signInLink('https://guild.example.ts.net/?x=1#y', 'abc'), 'https://guild.example.ts.net/mobile/#token=abc');
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.ok(html.includes('id="phone-view"') && html.includes('href="/mobile/"'), 'the full page links to the phone view');
  assert.match(fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8'), /node tests\/browser\/mobile\.mjs/, 'CI runs the browser check');
});

test('the phone view is a static page under CSP: no inline scripts, every asset served from this origin', () => {
  const html = fs.readFileSync(path.join(web, 'mobile', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  const vendor = { '/vendor/xterm/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/xterm/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js' };
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((url) => url !== '/');
  assert.ok(assets.length > 5);
  for (const url of assets) {
    assert.ok(url.startsWith('/'), `${url} is an absolute path, so /mobile without a slash works too`);
    const file = vendor[url] ? path.join(repo, 'node_modules', vendor[url]) : path.join(web, url);
    assert.ok(fs.existsSync(file), `${url} exists`);
  }
  const js = fs.readFileSync(path.join(web, 'mobile', 'mobile.js'), 'utf8');
  const imports = [...js.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['/terminal-controls.js', '/terminal-copy.js', '/folders.js', '/mobile/model.js'], 'shares only the touch modules and small pure helpers, never app.js');
  for (const imported of imports) assert.ok(fs.existsSync(path.join(web, imported)), imported);
  const manifest = JSON.parse(fs.readFileSync(path.join(web, 'mobile', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/mobile/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(web, icon.src)), icon.src);
  const css = fs.readFileSync(path.join(web, 'mobile', 'mobile.css'), 'utf8');
  assert.doesNotMatch(css, /url\(\s*["']?\/(?!\/)/, 'the Pages demo copies web/ below a project path');
});

test('the phone waits for a session start as long as the manager can take over one', () => {
  // A tool's first session answers after its hook probe, which Codex may run twice; a tmux or herdr session, and a
  // reattach, after the multiplexer answers. The manager finishes either whether or not the phone still waits, so a
  // shorter budget would report a session that then appears, and a retry would start a second one.
  assert.ok(START_TIMEOUT_MS >= 2 * PROBE_TIMEOUT_MS + RUN_TIMEOUT_MS, `${START_TIMEOUT_MS}ms covers two probes of ${PROBE_TIMEOUT_MS}ms and a command of ${RUN_TIMEOUT_MS}ms`);
  assert.ok(REQUEST_TIMEOUT_MS < START_TIMEOUT_MS, 'every other request is reported sooner, so no button waits long on a dead network');
  const js = fs.readFileSync(path.join(web, 'mobile', 'mobile.js'), 'utf8');
  assert.match(js, /api\('POST', '\/sessions', body, \{ timeoutMs: START_TIMEOUT_MS, noAnswer: START_NO_ANSWER \}\)/, 'a start has the start budget and says what a late answer means');
  assert.match(js, /api\('POST', `\/sessions\/\$\{view\.id\}\/reattach`, undefined, \{\s*timeoutMs: START_TIMEOUT_MS, noAnswer: '[^']+'/, 'a reattach has the start budget and says what a late answer means');
  assert.match(js, /signal: AbortSignal\.timeout\(timeoutMs\)/, 'and the budget is what the request is given');
});

test('the manager serves the phone view from its folder, with the manifest type and the same boundary', async (t) => {
  const api = await server(t);
  const root = await request(api, '/');
  for (const route of ['/mobile/', '/mobile']) {
    const page = await request(api, route);
    assert.equal(page.status, 200, route);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /\/mobile\/mobile\.js/);
    assert.equal(page.headers['content-security-policy'], root.headers['content-security-policy']);
    assert.equal(page.headers['cache-control'], 'no-cache');
  }
  const manifest = await request(api, '/mobile/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers['content-type'], 'application/manifest+json; charset=utf-8');
  assert.equal((await request(api, '/mobile/mobile.js')).status, 200);
  assert.equal((await request(api, '/skins/')).status, 404, 'a folder without a page stays a 404');
  assert.equal((await request(api, '/mobile/missing.js')).status, 404);
  for (const route of ['/mobile/..%2f..%2fpackage.json', '/mobile/../../package.json', '/..%2fpackage.json']) {
    assert.equal((await request(api, route)).status, 404, route);
  }
  assert.equal((await request(api, '/mobile/', { Host: 'guild.example.ts.net' })).status, 403, 'the same Host policy applies');
});

test('the events socket answers a ping, so a phone can tell a dead link from a quiet one', async (t) => {
  const api = await server(t);
  const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=test-manager-token`);
  t.after(() => ws.close());
  const types = [];
  const pong = new Promise((resolve) => {
    ws.onmessage = (event) => {
      const { type } = JSON.parse(event.data);
      types.push(type);
      if (type === 'hello') ws.send(JSON.stringify({ type: 'ping' }));
      if (type === 'pong') resolve();
    };
  });
  await pong;
  assert.deepEqual(types, ['hello', 'pong']);
});

async function server(t, options = {}) {
  const manager = Object.assign(new EventEmitter(), { list: () => [], get: () => { throw Object.assign(new Error('no session'), { status: 404 }); } });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, token: 'test-manager-token', webDir: web, ...options });
  await api.listen();
  t.after(() => api.close());
  return api;
}

function request(api, route = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${api.url}${route}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}
