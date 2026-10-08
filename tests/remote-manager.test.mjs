import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Tailscale, runTailscale } from '../src/manager/tailscale.mjs';

test('remote access API preserves a live PTY, enforces authentication, and survives manager relaunch', { timeout: 25000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-remote-manager-'));
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  let ctx, next, local, remote;
  try {
    Object.assign(process.env, { AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: '0', AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1', AGENT_GUILD_ALLOWED_HOSTS: '', AGENT_GUILD_ALLOWED_ORIGINS: '' });
    globalThis.fetch = (url, ...args) => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('External fetch disabled');
      return originalFetch(url, ...args);
    };
    const fixture = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [
      ...['anthropic', 'openai', 'google', 'xai', 'docker', 'shell'].map((id) => ({ id, enabled: false })),
      { id: 'fake', command: process.execPath, args: [fixture], versionArgs: [fixture, '--version'] },
    ] }));
    const tailFile = path.join(home, 'tailscale.json');
    fs.writeFileSync(tailFile, '{}');
    const tailFixture = fileURLToPath(new URL('./fixtures/fake-tailscale.mjs', import.meta.url));
    const tailscale = new Tailscale({ env: { ...process.env, FAKE_TAILSCALE_STATE: tailFile }, find: () => process.execPath,
      run: (exe, args, opts) => runTailscale(exe, [tailFixture, ...args], opts) });
    const options = { sessionDefaults: { killGraceMs: 100 }, remoteAccess: { tailscale, probe: async () => ({ ok: true }) } };
    const { startManager } = await import('../src/manager/main.mjs');
    ctx = await startManager(options);
    const request = (route, { token = ctx.token, body, host, report } = {}) => new Promise((resolve, reject) => {
      const req = http.request(`${ctx.api.url}/api/v1${route}`, { method: body ? 'PUT' : 'GET', headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(host ? { Host: host, Origin: `https://${host}` } : {}),
        ...(report ? { 'X-Agent-Guild-Report-Token': report } : {}), 'Content-Type': 'application/json',
      } }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    assert.equal((await request('/remote-access', { token: null })).status, 401);
    assert.equal((await request('/remote-access', { token: null, report: ctx.token })).status, 401);
    const session = await ctx.manager.create({ providerId: 'fake', cwd: home });
    local = new WebSocket(`${ctx.api.url.replace('http:', 'ws:')}/api/v1/sessions/${session.id}/terminal?token=${ctx.token}`);
    await once(local, 'message');
    const readyBy = Date.now() + 5000;
    while (!session.toJSON().pid && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 20));
    const before = session.toJSON();
    assert.ok(before.pid, 'the terminal process must be running before changing remote access');
    const initial = (await request('/remote-access')).body.remoteAccess;
    assert.equal((await request('/remote-access', { body: { action: 'enable', revision: 'old' } })).status, 409);
    assert.equal((await request('/remote-access', { body: { action: 'enable', revision: initial.revision } })).status, 202);
    await ctx.remoteAccess.task;
    assert.equal(ctx.remoteAccess.snapshot().mode, 'tailscale');
    assert.equal(session.toJSON().pid, before.pid);
    assert.equal(session.toJSON().status, 'running');
    const host = 'guild.example.ts.net';
    remote = new WebSocket(`${ctx.api.url.replace('http:', 'ws:')}/api/v1/sessions/${session.id}/terminal?token=${ctx.token}`, { headers: { Host: host, Origin: `https://${host}` } });
    await once(remote, 'message');
    const closed = once(remote, 'close');
    const enabled = ctx.remoteAccess.snapshot();
    await request('/remote-access', { body: { action: 'disable', revision: enabled.revision } });
    await ctx.remoteAccess.task;
    assert.equal((await closed)[0], 4403);
    assert.equal(local.readyState, WebSocket.OPEN);
    assert.equal(session.toJSON().status, 'running');
    assert.equal((await request('/health', { host })).status, 403);
    await ctx.shutdown('test relaunch');
    process.env.AGENT_GUILD_ALLOWED_HOSTS = host;
    process.env.AGENT_GUILD_ALLOWED_ORIGINS = `https://${host}`;
    next = await startManager(options);
    assert.equal(next.remoteAccess.snapshot().mode, 'off');
    assert.deepEqual(next.remoteAccess.snapshot().hosts, []);
  } finally {
    local?.terminate(); remote?.terminate();
    await next?.shutdown('test cleanup');
    await ctx?.shutdown('test cleanup');
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
  }
});
