import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  systemInfo, wslDistributions, dockerEndpoint, localSocket, dockerInfo, requestVersion, isWsl,
} from '../src/manager/environment-system.mjs';

const files = (map) => (file) => {
  if (Object.hasOwn(map, file)) return map[file];
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};
const machine = { arch: 'x64', machine: 'x86_64', cpus: [{ model: ' Intel(R) Core(TM) Ultra 9 285K ' }], threads: 24, memory: 64 * 1024 ** 3 };

const LXSS_OUTPUT = [
  '', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
  '    DefaultDistribution    REG_SZ    {B9837666-6bc3-469d-9880-d267c5ac2080}',
  '    DefaultVersion    REG_DWORD    0x2', '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{369f80f1-5be2-455b-ac9d-1688f301520f}',
  '    DistributionName    REG_SZ    docker-desktop', '    Version    REG_DWORD    0x2', '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{b9837666-6bc3-469d-9880-d267c5ac2080}',
  '    DistributionName    REG_SZ    Ubuntu-24.04', '    Version    REG_DWORD    0x2', '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-2222-3333-4444-555555555555}',
  '    DistributionName    REG_SZ    Legacy', '    Version    REG_DWORD    0x1', '',
].join('\r\n');

test('Windows reports its edition, build and WSL distributions from one registry read', async () => {
  const calls = [];
  const run = async (file, args, opts) => { calls.push({ file, args, opts }); return { code: 0, output: LXSS_OUTPUT }; };
  const info = await systemInfo({ ...machine, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, cwd: 'C:\\tmp\\scan', run, version: 'Windows 11 Pro', release: '10.0.26300' });
  assert.equal(info.os, 'Windows 11 Pro');
  assert.equal(info.osDetail, 'Version 10.0.26300');
  assert.equal(info.arch, 'x64');
  assert.equal(info.hostArch, null);
  assert.deepEqual(info.cpu, { model: 'Intel(R) Core(TM) Ultra 9 285K', threads: 24 });
  assert.equal(info.wsl, null);
  assert.deepEqual(info.wslDistributions, [
    { name: 'Ubuntu-24.04', version: 2, default: true },
    { name: 'docker-desktop', version: 2, default: false },
    { name: 'Legacy', version: 1, default: false },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\reg.exe');
  assert.deepEqual(calls[0].args, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s']);
  assert.equal(calls[0].opts.cwd, 'C:\\tmp\\scan');
});

test('no WSL key is no distributions; a failed registry read leaves the row out', async () => {
  const missing = async () => ({ code: 1, output: 'ERROR: The system was unable to find the specified registry key or value.' });
  assert.deepEqual(await wslDistributions({ env: {}, run: missing }), []);
  assert.equal(await wslDistributions({ env: {}, run: async () => ({ output: '', error: 'Version check timed out.' }) }), null);
  assert.equal(await wslDistributions({ env: {}, run: async () => ({ code: 5, output: 'Access is denied.' }) }), null);
  const broken = await systemInfo({ ...machine, platform: 'win32', env: {}, run: async () => { throw new Error('spawn'); }, version: 'Windows 11 Pro', release: '10.0.1' });
  assert.equal(broken.wslDistributions, null);
});

test('WSL names its distribution, WSL version and interop; plain Linux has no WSL row', async () => {
  const read = files({
    '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\nID=ubuntu\n',
    '/proc/sys/fs/binfmt_misc/WSLInterop-late': 'enabled\ninterpreter /init\n',
  });
  const wsl = await systemInfo({ ...machine, platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, read, release: '6.6.87.2-microsoft-standard-WSL2' });
  assert.equal(wsl.os, 'Ubuntu 24.04.4 LTS');
  assert.equal(wsl.osDetail, 'Kernel 6.6.87.2-microsoft-standard-WSL2');
  assert.deepEqual(wsl.wsl, { version: 2, distro: 'Ubuntu-24.04', interop: true });
  assert.equal(wsl.wslDistributions, null);
  const off = await systemInfo({ ...machine, platform: 'linux', env: {}, read: files({ '/proc/sys/fs/binfmt_misc/WSLInterop': 'disabled\n' }), release: '4.4.0-19041-Microsoft' });
  assert.equal(off.os, 'Linux');
  assert.deepEqual(off.wsl, { version: 1, distro: null, interop: false });
  const plain = await systemInfo({ ...machine, platform: 'linux', env: {}, read: files({ '/usr/lib/os-release': "PRETTY_NAME='Debian GNU/Linux 13'\n" }), release: '6.12.0-amd64' });
  assert.equal(plain.os, 'Debian GNU/Linux 13');
  assert.equal(plain.wsl, null);
  assert.equal(isWsl({ env: {}, release: '6.12.0-amd64' }), false);
});

test('macOS reads its version from the system plist, and emulation names the host architecture', async () => {
  const plist = '<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.3</string>\n</dict>';
  const mac = await systemInfo({ ...machine, platform: 'darwin', env: {}, read: files({ '/System/Library/CoreServices/SystemVersion.plist': plist }), release: '24.3.0', arch: 'arm64', machine: 'arm64' });
  assert.equal(mac.os, 'macOS 15.3');
  assert.equal(mac.osDetail, 'Darwin 24.3.0');
  assert.equal(mac.hostArch, null);
  const emulated = await systemInfo({ ...machine, platform: 'win32', env: {}, run: async () => ({ code: 0, output: '' }), version: 'Windows 11 Pro', release: '10.0.1', arch: 'x64', machine: 'arm64' });
  assert.equal(emulated.arch, 'x64');
  assert.equal(emulated.hostArch, 'arm64');
});

test('Linux names no host architecture, and a CPU Node cannot name has no model', async () => {
  const linux = { ...machine, platform: 'linux', env: {}, read: files({}), release: '6.12.0' };
  assert.equal((await systemInfo({ ...linux, arch: 'arm', machine: 'aarch64' })).hostArch, null);
  assert.equal((await systemInfo({ ...linux, arch: 'arm', machine: 'armv7l' })).hostArch, null);
  assert.equal((await systemInfo({ ...linux, arch: 'arm64', machine: 'aarch64', cpus: [{ model: 'unknown' }] })).cpu.model, null);
});

test('the Docker engine follows DOCKER_HOST, then DOCKER_CONTEXT, then the current context, then the default', () => {
  const meta = (name, host) => [path.win32.join('C:\\Users\\me\\.docker', 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json'),
    JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } })];
  const read = files(Object.fromEntries([
    ['C:\\Users\\me\\.docker\\config.json', JSON.stringify({ currentContext: 'desktop-linux' })],
    meta('desktop-linux', 'npipe:////./pipe/dockerDesktopLinuxEngine'),
    meta('remote', 'ssh://builder@example.test'),
  ]));
  const env = { USERPROFILE: 'C:\\Users\\me' };
  assert.deepEqual(dockerEndpoint({ env, platform: 'win32', read }), { endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', context: 'desktop-linux', source: 'config' });
  assert.deepEqual(dockerEndpoint({ env: { ...env, DOCKER_CONTEXT: 'remote' }, platform: 'win32', read }), { endpoint: 'ssh://builder@example.test', context: 'remote', source: 'DOCKER_CONTEXT' });
  assert.deepEqual(dockerEndpoint({ env: { ...env, DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'npipe:////./pipe/custom' }, platform: 'win32', read }), { endpoint: 'npipe:////./pipe/custom', context: null, source: 'DOCKER_HOST' });
  assert.deepEqual(dockerEndpoint({ env: { ...env, DOCKER_CONTEXT: 'gone' }, platform: 'win32', read }).error, 'Docker context gone was not found.');
  assert.deepEqual(dockerEndpoint({ env: { HOME: '/home/me' }, platform: 'linux', read: files({}) }), { endpoint: 'unix:///var/run/docker.sock', context: 'default', source: 'default' });
  assert.equal(dockerEndpoint({ env: { USERPROFILE: 'C:\\Users\\me' }, platform: 'win32', read: files({}) }).endpoint, 'npipe:////./pipe/docker_engine');
  const custom = files({ '/cfg/config.json': JSON.stringify({ currentContext: 'default' }) });
  assert.equal(dockerEndpoint({ env: { HOME: '/home/me', DOCKER_CONFIG: '/cfg' }, platform: 'linux', read: custom }).context, 'default');
});

test('only a local socket or named pipe is contacted', () => {
  assert.equal(localSocket('unix:///var/run/docker.sock'), '/var/run/docker.sock');
  assert.equal(localSocket('npipe:////./pipe/dockerDesktopLinuxEngine'), '\\\\.\\pipe\\dockerDesktopLinuxEngine');
  assert.equal(localSocket('npipe://./pipe/docker_engine'), '\\\\.\\pipe\\docker_engine');
  assert.equal(localSocket('tcp://127.0.0.1:2375'), null);
  assert.equal(localSocket('ssh://builder@example.test'), null);
  assert.equal(localSocket('npipe:////./pipe/../evil/x'), null);
});

const VERSION = JSON.stringify({
  Platform: { Name: 'Docker Desktop 4.55.0 (213807)' }, Version: '29.1.3', Os: 'linux', Arch: 'amd64',
  KernelVersion: '6.6.87.2-microsoft-standard-WSL2',
});

test('a running engine reports its version and platform; each failure says what to do', async () => {
  const env = { HOME: '/home/me' };
  const base = { env, platform: 'linux', read: files({}) };
  const withCli = () => '/usr/bin/docker';
  const noCli = () => null;
  const running = await dockerInfo({ ...base, resolve: withCli, query: async (socket) => { assert.equal(socket, '/var/run/docker.sock'); return { status: 200, body: VERSION }; } });
  assert.deepEqual(running, {
    status: 'running', version: '29.1.3', platform: 'Docker Desktop 4.55.0 (213807)', os: 'linux', arch: 'amd64', wsl2: true,
    context: 'default', endpoint: 'unix:///var/run/docker.sock', cli: '/usr/bin/docker', detail: null,
  });
  const cases = [
    [withCli, { error: 'ENOENT' }, 'stopped', 'The Docker engine is not running.'],
    [withCli, { error: 'ECONNREFUSED' }, 'stopped', 'The Docker engine is not running.'],
    [noCli, { error: 'ENOENT' }, 'not_found', 'No docker command on PATH and no engine answered.'],
    [withCli, { error: 'EACCES' }, 'denied', 'The engine socket exists, but this user cannot open it. Adding the user to the docker group allows it.'],
    [withCli, { error: 'timeout' }, 'failed', 'The engine did not answer in time.'],
    [withCli, { status: 500, body: '{}' }, 'failed', 'The engine did not give a usable answer.'],
    [withCli, { status: 200, body: 'not json' }, 'failed', 'The engine did not give a usable answer.'],
    [withCli, { status: 200, body: '{"Version":5}' }, 'failed', 'The engine did not give a usable answer.'],
  ];
  for (const [resolve, result, status, detail] of cases) {
    const row = await dockerInfo({ ...base, resolve, query: async () => result });
    assert.equal(row.status, status, JSON.stringify(result));
    assert.equal(row.detail, detail);
    assert.equal(row.version, null);
  }
  // Only Linux's system socket belongs to the docker group.
  const rootless = await dockerInfo({ ...base, env: { ...env, DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, resolve: withCli, query: async () => ({ error: 'EACCES' }) });
  assert.equal(rootless.detail, 'The engine socket exists, but this user cannot open it.');
  const mac = await dockerInfo({ ...base, platform: 'darwin', resolve: withCli, query: async () => ({ error: 'EACCES' }) });
  assert.equal(mac.detail, 'The engine socket exists, but this user cannot open it.');
  const remote = await dockerInfo({ ...base, env: { ...env, DOCKER_HOST: 'tcp://10.0.0.5:2376' }, resolve: withCli, query: async () => assert.fail('a remote engine is not contacted') });
  assert.equal(remote.status, 'remote');
  assert.equal(remote.endpoint, 'tcp://10.0.0.5:2376');
  const lost = await dockerInfo({ ...base, env: { ...env, DOCKER_CONTEXT: 'gone' }, resolve: withCli, query: async () => assert.fail('no endpoint') });
  assert.equal(lost.status, 'failed');
  assert.equal(lost.detail, 'Docker context gone was not found.');
  const pipe = await dockerInfo({ env: { USERPROFILE: 'C:\\me' }, platform: 'win32', read: files({}), resolve: withCli, query: async () => ({ error: 'EPERM' }) });
  assert.equal(pipe.detail, 'The engine is running, but this user cannot open its pipe.');
});

function socketPath(t) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-guild-docker-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'docker.sock');
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  const socket = socketPath(t);
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return socket;
}

test('the version request reads a real local socket and is bounded in time and size', async (t) => {
  const seen = [];
  const ok = await serve(t, (req, res) => { seen.push([req.method, req.url]); res.end(VERSION); });
  const answer = await requestVersion(ok);
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).Version, '29.1.3');
  assert.deepEqual(seen, [['GET', '/version']]);
  const silent = await serve(t, () => {});
  assert.deepEqual(await requestVersion(silent, { timeoutMs: 100 }), { error: 'timeout' });
  const huge = await serve(t, (req, res) => { res.write('x'.repeat(300 * 1024)); res.end(); });
  assert.deepEqual(await requestVersion(huge), { error: 'too_large' });
  const missing = await requestVersion(socketPath(t));
  assert.equal(missing.error, 'ENOENT');
});
