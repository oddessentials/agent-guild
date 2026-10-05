import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createManagerServer } from '../src/manager/server.mjs';
import { parseAllowedHosts } from '../src/manager/access-policy.mjs';
import { Environment } from '../src/manager/environment.mjs';

const proxyHost = 'guild.example.ts.net';
const proxyOrigin = `https://${proxyHost}`;
const token = 'test-manager-token';
const auth = { Authorization: `Bearer ${token}` };

test('environment reads and refresh return immediately while discovery hangs, with normal API authentication', async (t) => {
  let starts = 0;
  const environment = new Environment({ forkWorker: () => { starts++; return new EventEmitter(); } });
  t.after(() => environment.close());
  const api = await server(t, { environment });
  assert.equal((await request(api, '/api/v1/environment')).status, 401);
  assert.equal(starts, 0);
  const first = await request(api, '/api/v1/environment', auth);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).refreshing, true);
  const refreshed = await fetch(`${api.url}/api/v1/environment/refresh`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(refreshed.status, 202);
  assert.equal((await refreshed.json()).scope, 'manager');
  assert.equal(starts, 1);
  assert.equal((await request(api, '/api/v1/info', auth)).status, 200);
});

test('environment scopes reject commands and missing targets', async (t) => {
  const environment = new Environment({ forkWorker: () => new EventEmitter() });
  t.after(() => environment.close());
  const api = await server(t, { environment });
  const post = (body) => fetch(`${api.url}/api/v1/environment/refresh`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const command = await post({ command: 'node' });
  assert.equal(command.status, 400);
  assert.equal((await command.json()).error.code, 'bad_request');
  const project = await post({ scope: 'project' });
  assert.equal(project.status, 400);
  assert.equal((await project.json()).error.code, 'cwd_required');
  const session = await post({ scope: 'session', id: 'abc' });
  assert.equal(session.status, 404);
  assert.equal((await session.json()).error.code, 'not_found');
  const badId = await (await post({ scope: 'session', id: '../x' })).json();
  assert.equal(badId.error.code, 'bad_request');
});

async function server(t, options = {}) {
  const session = new EventEmitter();
  Object.assign(session, {
    attach(send) {
      send({ type: 'snapshot', data: 'terminal ready' });
      session.on('data', send);
      return () => session.off('data', send);
    },
    input(data) { session.emit('data', { type: 'data', data }); },
  });
  const manager = Object.assign(new EventEmitter(), { list: () => [], get: () => session });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, token, webDir: fileURLToPath(new URL('../web', import.meta.url)), ...options });
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

function rejectedSocket(api, route, headers) {
  return new Promise((resolve, reject) => {
    let refused = false;
    const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}${route}`, { headers });
    ws.once('unexpected-response', (req, res) => {
      refused = true;
      res.resume();
      req.destroy();
      resolve(res.statusCode);
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('unexpectedly accepted the WebSocket')); });
    ws.once('error', (error) => { if (!refused) reject(error); });
  });
}

test('allowed hosts accept exact authorities and reject URLs, wildcards and header/CSP injection', () => {
  assert.deepEqual(parseAllowedHosts(), []);
  assert.deepEqual(parseAllowedHosts(' , , '), []);
  assert.deepEqual(parseAllowedHosts(` ${proxyHost.toUpperCase()}, ${proxyHost},localhost:8443,[::1]:8443 `), [proxyHost, 'localhost:8443', '[::1]:8443']);
  for (const value of ['*', '*.example.ts.net', 'https://example.ts.net', 'example.ts.net/', 'user@example.ts.net',
    'example.ts.net?x', 'example.ts.net#x', 'example.ts.net:0', 'example.ts.net:65536', 'example.ts.net:443:80',
    'example.ts.net:*', 'example.ts.net:0443', 'a..b', '-bad.example', 'bad-.example', '[::invalid]', '::1',
    'example.ts.net; script-src *', 'example.ts.net\r\nX-Injected: yes', 'example .ts.net', `${'a'.repeat(64)}.net`]) {
    assert.throws(() => parseAllowedHosts(value), /Invalid allowed host/, value);
  }
});

test('an invalid host setting fails startup before creating manager state', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-invalid-host-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'manager');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/manager/main.mjs', import.meta.url))], {
    env: { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_ALLOWED_HOSTS: 'https://bad.example', AGENT_GUILD_PORT: '0' },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid allowed host/);
  assert.equal(fs.existsSync(home), false);
});

test('default Host, Origin, authentication and CSP behavior stays loopback-only', async (t) => {
  const api = await server(t);
  const page = await request(api);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  for (const host of [`localhost:${api.port}`, `[::1]:${api.port}`, `127.0.0.1:${api.port}`]) {
    assert.equal((await request(api, '/', { Host: host })).status, 200);
  }
  assert.equal((await request(api, '/', { Host: proxyHost })).status, 403);
  assert.equal((await request(api, '/api/v1/health', { Host: proxyHost })).status, 403);
  assert.equal((await request(api, '/api/v1/info', { Origin: proxyOrigin, ...auth })).status, 403);
  assert.equal((await request(api, '/api/v1/info')).status, 401);
  assert.equal((await request(api, '/api/v1/info', auth)).status, 200);
});

test('configured hosts match exactly, keep ports scoped and never trust forwarded or identity headers', async (t) => {
  const api = await server(t, { extraHosts: [proxyHost.toUpperCase(), 'other.example.ts.net:8443'], extraOrigins: [proxyOrigin] });
  for (const host of [proxyHost, proxyHost.toUpperCase(), 'other.example.ts.net:8443']) {
    assert.equal((await request(api, '/', { Host: host })).status, 200);
    assert.equal((await request(api, '/app.js', { Host: host })).status, 200);
  }
  for (const host of ['attacker.example', `${proxyHost}.attacker.example`, `sub.${proxyHost}`, `${proxyHost}:8443`, `${proxyHost}:443`, 'other.example.ts.net']) {
    const res = await request(api, '/api/v1/health', {
      Host: host, 'X-Forwarded-Host': proxyHost, Forwarded: `host=${proxyHost};proto=https`, ...auth,
    });
    assert.equal(res.status, 403, host);
    assert.equal(JSON.parse(res.body).error.code, 'forbidden_host');
  }
  const headers = { Host: proxyHost, Origin: proxyOrigin, 'Tailscale-User-Login': 'operator@example.test' };
  assert.equal((await request(api, '/api/v1/health', headers)).status, 200);
  for (const credentials of [{}, { Authorization: 'Bearer wrong' }, { 'X-Agent-Guild-Report-Token': token }]) {
    assert.equal((await request(api, '/api/v1/info', { ...headers, ...credentials })).status, 401);
  }
  assert.equal((await request(api, '/api/v1/info', { ...headers, ...auth })).status, 200);
  for (const origin of ['null', 'https://attacker.example', `http://${proxyHost}`]) {
    const res = await request(api, '/api/v1/info', { ...headers, ...auth, Origin: origin });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, 'forbidden_origin');
  }
  const csp = (await request(api, '/', headers)).headers['content-security-policy'];
  assert.ok(csp.includes(`wss://${proxyHost}`));
  assert.ok(csp.includes('wss://other.example.ts.net:8443'));
  assert.doesNotMatch(csp, /(?:^|\s)wss?:[\s;]/, 'no scheme-wide WebSocket permission');
  const defaultApi = await server(t);
  assert.ok(!(await request(defaultApi)).headers['content-security-policy'].includes(proxyHost), 'CSP is isolated per server');
});

test('Host and Origin opt-ins remain independent for HTTP and WebSocket upgrades', async (t) => {
  const hostOnly = await server(t, { extraHosts: [proxyHost] });
  assert.equal((await request(hostOnly, '/', { Host: proxyHost })).status, 200);
  assert.equal((await request(hostOnly, '/api/v1/info', { Host: proxyHost, Origin: proxyOrigin, ...auth })).status, 403);
  assert.equal(await rejectedSocket(hostOnly, `/api/v1/events?token=${token}`, { Host: proxyHost, Origin: proxyOrigin }), 403);
  const originOnly = await server(t, { extraOrigins: [proxyOrigin] });
  assert.equal((await request(originOnly, '/', { Host: proxyHost })).status, 403);
  assert.equal((await request(originOnly, '/api/v1/info', { Origin: proxyOrigin, ...auth })).status, 200);
});

test('both WebSocket endpoints enforce configured hosts, origins and the existing token', async (t) => {
  const api = await server(t, { extraHosts: [proxyHost], extraOrigins: [proxyOrigin] });
  const headers = { Host: proxyHost, Origin: proxyOrigin };
  for (const route of ['/api/v1/events', '/api/v1/sessions/abc123/terminal']) {
    assert.equal(await rejectedSocket(api, route, headers), 401);
    assert.equal(await rejectedSocket(api, `${route}?token=wrong`, headers), 401);
    assert.equal(await rejectedSocket(api, `${route}?token=${token}`, { ...headers, Host: 'attacker.example', 'X-Forwarded-Host': proxyHost }), 403);
    assert.equal(await rejectedSocket(api, `${route}?token=${token}`, { ...headers, Origin: 'https://attacker.example' }), 403);
    const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}${route}?token=${token}`, { headers });
    t.after(() => ws.terminate());
    const [raw] = await once(ws, 'message');
    assert.equal(JSON.parse(raw).type, route.endsWith('/events') ? 'hello' : 'snapshot');
    if (route.endsWith('/terminal')) {
      const echoed = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'input', data: 'hello through the proxy' }));
      assert.equal(JSON.parse((await echoed)[0]).data, 'hello through the proxy');
    }
    ws.close();
    await once(ws, 'close');
  }
});

test('live policy changes revoke both remote sockets, preserve local sockets, and refresh CSP', async (t) => {
  const api = await server(t);
  const before = await request(api);
  const local = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=${token}`);
  t.after(() => local.terminate());
  await once(local, 'message');
  api.setAccessPolicy({ hosts: [proxyHost], origins: [proxyOrigin] });
  const page = await request(api, '/', { Host: proxyHost });
  assert.equal(page.status, 200);
  assert.notEqual(page.headers.etag, before.headers.etag);
  assert.ok(page.headers['content-security-policy'].includes(`wss://${proxyHost}`));
  const remote = [];
  for (const route of ['/events', '/sessions/abc123/terminal']) {
    const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1${route}?token=${token}`, { headers: { Host: proxyHost, Origin: proxyOrigin } });
    t.after(() => ws.terminate());
    await once(ws, 'message');
    remote.push(ws);
  }
  const closed = remote.map((ws) => once(ws, 'close'));
  api.setAccessPolicy({ hosts: [], origins: [] });
  for (const [code] of await Promise.all(closed)) assert.equal(code, 4403);
  assert.equal(local.readyState, WebSocket.OPEN);
  assert.equal((await request(api, '/api/v1/health', { Host: proxyHost })).status, 403);
  assert.ok(!(await request(api)).headers['content-security-policy'].includes(proxyHost));
  assert.throws(() => api.setAccessPolicy({ hosts: ['*'] }));
  assert.equal(local.readyState, WebSocket.OPEN);
});

test('revocation detaches terminal output immediately and cannot accept more input during closing', async (t) => {
  let inputs = 0, attachments = 0;
  const session = {
    attach(send) {
      attachments++;
      send({ type: 'snapshot', data: 'ready' });
      let attached = true;
      return () => { if (attached) { attached = false; attachments--; } };
    },
    input() { inputs++; }, resize() {},
  };
  const manager = Object.assign(new EventEmitter(), { list: () => [], get: () => session });
  const api = await server(t, { manager, extraHosts: [proxyHost], extraOrigins: [proxyOrigin] });
  const remote = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/sessions/abc123/terminal?token=${token}`, { headers: { Host: proxyHost, Origin: proxyOrigin } });
  t.after(() => remote.terminate());
  await once(remote, 'message');
  const closed = once(remote, 'close');
  api.setAccessPolicy({ hosts: [], origins: [] });
  assert.equal(attachments, 0);
  remote.send(JSON.stringify({ type: 'input', data: 'should not run' }));
  await closed;
  assert.equal(inputs, 0);
});
