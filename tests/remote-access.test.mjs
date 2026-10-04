import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { normalizeAccess, parseAllowedOrigins } from '../src/manager/access-policy.mjs';
import { Tailscale, runTailscale, chooseRoute, routeMatches, routeUrl, approvalLink, remoteError, findTailscale } from '../src/manager/tailscale.mjs';
import { RemoteAccess, loadRemoteAccess, saveRemoteAccess, checkRemoteUrl } from '../src/manager/remote-access.mjs';
import { remotePresentation } from '../web/remote-access.js';

const host = 'guild.example.ts.net';
const target = 'http://127.0.0.1:47821';
const route = { host, nodeId: 'test-node', port: 443, target };
const clone = (value) => structuredClone(value);
const configFor = (r = route) => ({ TCP: { [r.port]: { HTTPS: true } }, Web: { [`${r.host}:${r.port}`]: { Handlers: { '/': { Proxy: r.target } } } } });

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const info = { host, nodeId: route.nodeId, version: '1.102.2', httpsReady: true, config: {} };
  const calls = [], applied = [];
  const fake = {
    info,
    inspect: async () => clone(info),
    enable: async (r) => { calls.push(['enable', clone(r)]); Object.assign(info.config, configFor(r)); },
    remove: async (r) => {
      calls.push(['remove', clone(r)]);
      if (!routeMatches(info.config, r)) throw remoteError('route_changed', 'Route was changed');
      info.config = {};
      return clone(info);
    },
  };
  const file = path.join(dir, 'remote-access.json');
  const controller = new RemoteAccess({ file, env: {}, tailscale: fake, probe: async () => ({ ok: true, checkedAt: '2026-10-04T00:00:00.000Z' }), ...options });
  controller.attach({ apply: (access) => applied.push(clone(access)), getTarget: () => target });
  t.after(() => controller.close());
  const change = async (action, extra = {}) => {
    controller.change({ action, revision: controller.snapshot().revision, ...extra });
    await controller.task;
    return controller.snapshot();
  };
  return { dir, file, controller, fake, calls, applied, change };
}

test('origin validation rejects paths, credentials, opaque origins and invalid schemes', () => {
  assert.deepEqual(parseAllowedOrigins(`https://${host}, http://localhost:3000`), [`https://${host}`, 'http://localhost:3000']);
  for (const value of ['null', '*', `https://${host}/`, `https://${host}/path`, `https://${host}#token=x`, `https://user@${host}`, `wss://${host}`, 'https://host:0', 'https://HOST']) {
    assert.throws(() => parseAllowedOrigins(value), undefined, value);
  }
  assert.throws(() => normalizeAccess({ hosts: 'host' }));
  assert.throws(() => normalizeAccess({ origins: [null] }));
});

test('environment settings are a fallback until saved settings, including off, become authoritative', async (t) => {
  const { file, controller, change } = setup(t);
  const env = { AGENT_GUILD_ALLOWED_HOSTS: host, AGENT_GUILD_ALLOWED_ORIGINS: `https://${host}` };
  assert.equal(loadRemoteAccess(file, env).source, 'environment');
  assert.equal((await change('enable')).mode, 'tailscale');
  assert.equal(loadRemoteAccess(file, { AGENT_GUILD_ALLOWED_HOSTS: 'https://bad' }).config.mode, 'tailscale');
  const reloaded = new RemoteAccess({ file, env });
  assert.deepEqual(reloaded.config.access, controller.config.access);
  assert.equal((await change('disable')).mode, 'off');
  assert.deepEqual(loadRemoteAccess(file, env).config.access, { hosts: [], origins: [] });
});

test('invalid saved files preserve local access and never fall back to environment permissions', (t) => {
  const { file } = setup(t);
  for (const body of ['{', '{}', JSON.stringify({ version: 500 }), 'x'.repeat(65537)]) {
    fs.writeFileSync(file, body);
    const loaded = loadRemoteAccess(file, { AGENT_GUILD_ALLOWED_HOSTS: host });
    assert.equal(loaded.config.mode, 'off');
    assert.deepEqual(loaded.config.access.hosts, []);
    assert.match(loaded.error, /invalid/);
  }
});

test('atomic save validates before replacing the active file and leaves no temporary files', (t) => {
  const { file, dir, controller } = setup(t);
  saveRemoteAccess(file, controller.config);
  const saved = fs.readFileSync(file, 'utf8');
  assert.throws(() => saveRemoteAccess(file, { ...controller.config, mode: 'tailscale', route: { ...route, target: 'https://evil.example' } }));
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(dir), ['remote-access.json']);
});

test('enable applies only after the route succeeds and settings persist; disable blocks access before cleanup', async (t) => {
  const { controller, fake, applied, change } = setup(t);
  const enable = fake.enable;
  fake.enable = async (r) => {
    assert.deepEqual(applied.at(-1), { hosts: [], origins: [] });
    assert.equal(controller.config.pending.type, 'enable');
    await enable(r);
  };
  const enabled = await change('enable');
  assert.equal(enabled.problem, null);
  assert.equal(enabled.url, `https://${host}`);
  assert.equal(enabled.connection.ok, true);
  const remove = fake.remove;
  fake.remove = async (r) => {
    assert.deepEqual(applied.at(-1), { hosts: [], origins: [] });
    assert.equal(controller.config.mode, 'off');
    return remove(r);
  };
  assert.equal((await change('disable')).pending, null);
  assert.equal(controller.snapshot().candidate.existing, false);
});

test('failed persistence prevents changes to Tailscale', async (t) => {
  const { change, calls, applied } = setup(t, { save: () => { throw new Error('disk full'); } });
  const result = await change('enable');
  assert.equal(result.problem.message, 'disk full');
  assert.equal(result.mode, 'off');
  assert.deepEqual(calls, []);
  assert.deepEqual(applied, []);
});

test('a failure after creating a route remains recoverable after a new manager starts', async (t) => {
  let saves = 0;
  const { file, controller, fake, change } = setup(t, { save: (file, value) => {
    if (++saves === 2) throw new Error('disk full');
    saveRemoteAccess(file, value);
  } });
  const failed = await change('enable');
  assert.equal(failed.mode, 'off');
  assert.equal(failed.pending, 'enable');
  const resumed = new RemoteAccess({ file, env: {}, tailscale: fake, probe: async () => ({ ok: true }) });
  resumed.attach({ apply() {}, getTarget: () => target });
  t.after(() => resumed.close());
  resumed.change({ action: 'enable', revision: resumed.snapshot().revision });
  await resumed.task;
  assert.equal(resumed.snapshot().mode, 'tailscale');
  assert.equal(resumed.snapshot().pending, null);
  assert.equal(controller.snapshot().mode, 'off');
});

test('existing routes require explicit adoption and changed routes are preserved', async (t) => {
  const { fake, controller, change, calls } = setup(t);
  fake.info.config = configFor();
  assert.equal((await change('enable')).problem.code, 'adoption_required');
  assert.deepEqual(calls, []);
  assert.equal((await change('enable', { adopt: true })).mode, 'tailscale');
  fake.info.config.Web[`${host}:443`].Handlers['/'].Proxy = 'http://127.0.0.1:9000';
  const result = await change('disable');
  assert.equal(result.mode, 'off');
  assert.equal(result.pending, 'disable');
  assert.equal(result.problem.code, 'route_changed');
  assert.equal((await controller.check()).problem.code, 'route_changed');
  assert.equal(fake.info.config.Web[`${host}:443`].Handlers['/'].Proxy, 'http://127.0.0.1:9000');
  assert.equal((await change('forget')).pending, null);
});

test('cleanup failures persist the disabled policy across launches and can be retried', async (t) => {
  const { file, fake, change } = setup(t);
  await change('enable');
  const remove = fake.remove;
  fake.remove = async () => { throw remoteError('permission_required', 'Permission required'); };
  assert.equal((await change('disable')).pending, 'disable');
  assert.equal(loadRemoteAccess(file, { AGENT_GUILD_ALLOWED_HOSTS: host }).config.mode, 'off');
  assert.equal((await change('enable')).problem.code, 'cleanup_required');
  fake.remove = remove;
  assert.equal((await change('disable')).pending, null);
});

test('stale submissions and concurrent operations cannot override active settings', async (t) => {
  const { controller, fake, change } = setup(t);
  const stale = controller.snapshot().revision;
  await change('custom', { hosts: [host], origins: [`https://${host}`] });
  assert.throws(() => controller.change({ action: 'disable', revision: stale }), { code: 'stale_settings' });
  let release;
  fake.inspect = () => new Promise((resolve) => { release = () => resolve(clone(fake.info)); });
  controller.change({ action: 'enable', revision: controller.snapshot().revision });
  assert.throws(() => controller.change({ action: 'disable', revision: controller.snapshot().revision }), { code: 'remote_busy' });
  await Promise.resolve();
  release();
  fake.inspect = async () => clone(fake.info);
  await controller.task;
});

test('custom proxy settings persist and invalid submissions leave access unchanged', async (t) => {
  const { controller, file, change } = setup(t);
  const before = controller.snapshot().revision;
  assert.throws(() => controller.change({ action: 'custom', revision: before, hosts: ['*'], origins: [] }));
  assert.equal(controller.snapshot().revision, before);
  assert.equal((await change('custom', { hosts: [host], origins: [`https://${host}`] })).source, 'saved');
  assert.deepEqual(loadRemoteAccess(file, {}).config.access.hosts, [host]);
  assert.equal((await change('custom', { hosts: [], origins: [] })).mode, 'off');
});

test('port selection preserves occupied HTTPS, TCP, foreground and Funnel routes', () => {
  const info = { host, nodeId: 'test-node', config: configFor({ ...route, target: 'http://127.0.0.1:9000' }) };
  info.config.Foreground = { owner: { TCP: { 8443: { HTTPS: true } } } };
  info.config.AllowFunnel = { [`${host}:8444`]: true };
  info.config.TCP[8445] = { TCPForward: 'localhost:22' };
  const before = clone(info.config);
  assert.equal(chooseRoute(info, target).port, 8446);
  assert.deepEqual(info.config, before);
  info.config = configFor();
  assert.equal(chooseRoute(info, target).port, 443);
  info.config.Web[`${host}:443`].Handlers['/other'] = { Text: 'other' };
  assert.equal(chooseRoute(info, target).port, 8443);
});

test('saved routes cannot be reassigned to another Tailscale identity or overwrite another service', () => {
  assert.throws(() => chooseRoute({ host, nodeId: 'different', config: {} }, target, route), { code: 'network_changed' });
  assert.throws(() => chooseRoute({ host, nodeId: route.nodeId, config: configFor({ ...route, target: 'http://127.0.0.1:1234' }) }, target, route), { code: 'route_changed' });
  assert.equal(routeUrl({ ...route, port: 8443 }), `https://${host}:8443`);
});

function cli(t, initial = {}) {
  const { dir } = setup(t);
  const file = path.join(dir, 'tailscale.json'), log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ...initial, log }));
  const fixture = fileURLToPath(new URL('./fixtures/fake-tailscale.mjs', import.meta.url));
  const adapter = new Tailscale({
    env: { ...process.env, FAKE_TAILSCALE_STATE: file }, find: () => process.execPath,
    run: (exe, args, options) => runTailscale(exe, [fixture, ...args], options),
  });
  return { adapter, file, log, fixture };
}

test('the real CLI adapter enables and removes only the explicit root route, preserving other ports', async (t) => {
  const other = { ...route, port: 8443, target: 'http://127.0.0.1:9000' };
  const { adapter, file, log } = cli(t, { config: configFor(other) });
  await adapter.enable(route, null);
  assert.equal(routeMatches((await adapter.inspect()).config, route), true);
  await adapter.remove(route);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).config, configFor(other));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => call.cli === '1'));
  assert.deepEqual(calls.filter((call) => call.args[1] === '--bg').map((call) => call.args), [
    ['serve', '--bg', '--https=443', '--set-path=/', target],
    ['serve', '--bg', '--https=443', '--set-path=/', 'off'],
  ]);
});

test('a successful CLI exit with approval still outstanding is not reported as enabled', async (t) => {
  const { adapter } = cli(t, { behavior: 'approval', https: false });
  let approval;
  await assert.rejects(adapter.enable(route, null, { onApproval: (url) => { approval = url; } }), { code: 'setup_incomplete' });
  assert.equal(approval, 'https://login.tailscale.com/f/serve-test');
});

test('CLI errors distinguish permission, malformed responses, offline state and old versions', async (t) => {
  for (const [initial, code] of [[{ behavior: 'malformed' }, 'tailscale_response'], [{ backend: 'NeedsLogin' }, 'not_connected'], [{ version: '1.40.0' }, 'update_required']]) {
    const { adapter } = cli(t, initial);
    await assert.rejects(adapter.inspect(), { code });
  }
  const { adapter } = cli(t, { behavior: 'permission' });
  await assert.rejects(adapter.enable(route, null), { code: 'permission_required' });
});

test('CLI cancellation is bounded and approval links are restricted to Tailscale', async (t) => {
  const { fixture, file } = cli(t, { behavior: 'hang' });
  await assert.rejects(runTailscale(process.execPath, [fixture, 'status'], { env: { ...process.env, FAKE_TAILSCALE_STATE: file }, timeout: 200 }), { code: 'tailscale_timeout' });
  assert.equal(approvalLink('https://login.tailscale.com.evil.example/path'), null);
  assert.equal(approvalLink('https://login.tailscale.com@evil.example/path'), null);
  assert.equal(approvalLink('https://login.tailscale.com/path'), 'https://login.tailscale.com/path');
});

test('repair after a manager port change recovers whether interrupted before or after changing Serve', async (t) => {
  for (const applied of [false, true]) {
    const { controller, file, fake, change, calls } = setup(t);
    await change('enable');
    const nextRoute = { ...route, target: 'http://127.0.0.1:47822' };
    saveRemoteAccess(file, { ...controller.config, pending: { type: 'enable', route: nextRoute, previous: route } });
    if (applied) fake.info.config = configFor(nextRoute);
    const resumed = new RemoteAccess({ file, env: {}, tailscale: fake });
    resumed.attach({ apply() {}, getTarget: () => nextRoute.target });
    t.after(() => resumed.close());
    resumed.change({ action: 'disable', revision: resumed.snapshot().revision });
    await resumed.task;
    assert.equal(resumed.snapshot().mode, 'off');
    assert.equal(resumed.snapshot().pending, null);
    assert.equal(calls.at(-1)[1].target, applied ? nextRoute.target : route.target);
  }
});

test('a changed manager port is repaired without changing the saved HTTPS address', async (t) => {
  const { adapter, file } = cli(t, { config: configFor() });
  const nextRoute = { ...route, target: 'http://127.0.0.1:47822' };
  await adapter.enable(nextRoute, route);
  assert.equal(routeMatches(JSON.parse(fs.readFileSync(file)).config, nextRoute), true);
  await adapter.remove(nextRoute);
});

test('repeated interruptions preserve the original route even before the first successful setup', async (t) => {
  const { controller, file, fake, change } = setup(t);
  fake.info.config = configFor();
  saveRemoteAccess(file, { ...controller.config, pending: { type: 'enable', route } });
  controller.config = loadRemoteAccess(file, {}).config;
  controller.getTarget = () => 'http://127.0.0.1:47822';
  const enable = fake.enable;
  fake.enable = async () => { throw new Error('Interrupted'); };
  assert.equal((await change('enable')).pending, 'enable');
  assert.equal(loadRemoteAccess(file, {}).config.pending.previous.target, target);
  fake.enable = enable;
  const resumed = new RemoteAccess({ file, env: {}, tailscale: fake, probe: async () => ({ ok: true }) });
  resumed.attach({ apply() {}, getTarget: () => 'http://127.0.0.1:47823' });
  t.after(() => resumed.close());
  resumed.change({ action: 'enable', revision: resumed.snapshot().revision });
  await resumed.task;
  assert.equal(resumed.snapshot().pending, null);
  assert.equal(resumed.snapshot().problem, null);
  assert.equal(resumed.config.route.target, 'http://127.0.0.1:47823');
});

test('malformed Serve maps and public routes cannot be adopted or overwritten', async (t) => {
  for (const config of [{ TCP: { 443: null } }, { Web: { [`${host}:443`]: { Handlers: null } } }, { AllowFunnel: { [`${host}:443`]: 'false' } }]) {
    const { adapter } = cli(t, { config });
    await assert.rejects(adapter.inspect(), { code: 'tailscale_response' });
  }
  const config = configFor();
  config.AllowFunnel = { [`other.example.ts.net:443`]: true };
  assert.equal(routeMatches(config, route), false);
  assert.equal(chooseRoute({ host, nodeId: route.nodeId, config }, target).port, 8443);
});

test('platform installation fallbacks work without shell aliases', () => {
  for (const [platform, env, executable] of [
    ['win32', { PATH: '', ProgramFiles: 'D:\\Programs' }, 'D:\\Programs\\Tailscale\\tailscale.exe'],
    ['darwin', { PATH: '' }, '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
    ['linux', { PATH: '' }, '/usr/bin/tailscale'],
  ]) assert.equal(findTailscale(env, platform, (file) => file === executable), executable);
  assert.equal(findTailscale({ PATH: '' }, 'linux', () => false), null);
});

test('recovery UI keeps cleanup separate from setup and makes route adoption explicit', () => {
  for (const code of ['permission_required', 'not_installed', 'not_connected', 'route_changed', 'network_changed']) {
    const presentation = remotePresentation({ mode: 'off', pending: 'disable', problem: { code, message: 'Needs attention' } });
    assert.equal(presentation.action, 'disable');
    assert.equal(presentation.label, 'Retry cleanup');
  }
  assert.equal(remotePresentation({ mode: 'custom', source: 'environment', candidate: { existing: true } }).label, 'Use existing route');
  assert.equal(remotePresentation({ mode: 'off', problem: { approvalUrl: 'https://login.tailscale.com/f/serve-test' } }).helpLabel, 'Open Tailscale approval');
});

test('the secure connection check identifies this manager without sending credentials or following redirects', async (t) => {
  for (const [status, body, expected] of [
    [200, JSON.stringify({ name: 'agent-guild', pid: process.pid }), true],
    [200, JSON.stringify({ name: 'agent-guild', pid: process.pid + 1 }), false],
    [200, JSON.stringify({ name: 'another-service', pid: process.pid }), false],
    [302, JSON.stringify({ name: 'agent-guild', pid: process.pid }), false],
    [200, 'x'.repeat(16385), false],
  ]) {
    const mock = t.mock.method(https, 'get', (url, options, onResponse) => {
      assert.equal(url, `https://${host}/api/v1/health`);
      assert.deepEqual(options.headers, { 'Cache-Control': 'no-store' });
      assert.notEqual(options.rejectUnauthorized, false);
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.setEncoding = () => {};
        onResponse(response);
        response.emit('data', body);
        response.emit('end');
      });
      return request;
    });
    assert.equal((await checkRemoteUrl(`https://${host}`)).ok, expected);
    mock.mock.restore();
  }
});
