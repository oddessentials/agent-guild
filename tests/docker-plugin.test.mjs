import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyChannel, dockerConfigDir, downloadDir, linkOnPath, readPlugin, pluginVersion, PLUGIN_INFO_ARGS, PLUGIN_METADATA_ARGS } from '../src/manager/docker-plugin.mjs';
import { latestReleaseTag } from '../src/manager/versions.mjs';
import { ProviderRegistry } from '../src/manager/providers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'fake-coding-tool.mjs');
// By real path: macOS's temp folder is under /var, a link to /private/var, and a Windows runner's is spelled by its
// short name; neither is what these tests are about.
const tempDir = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agent-guild-docker-plugin-'));
const noLinks = { realpath: (f) => f, isLink: () => false };

test('a plugin copy\'s channel says who put it there, on each platform', () => {
  const win = { USERPROFILE: 'C:\\Users\\me', ProgramFiles: 'C:\\Program Files' };
  assert.equal(copyChannel('C:\\Users\\me\\.docker\\cli-plugins\\docker-agent.exe', win, 'win32', noLinks), 'download');
  assert.equal(copyChannel('c:\\users\\ME\\.docker\\CLI-PLUGINS\\docker-agent.exe', win, 'win32', noLinks), 'download', 'Windows paths compare without case');
  assert.equal(copyChannel('C:\\Program Files\\Docker\\cli-plugins\\docker-agent.exe', win, 'win32', noLinks), 'desktop');
  assert.equal(copyChannel('D:\\tools\\cli-plugins\\docker-agent.exe', win, 'win32', noLinks), 'unknown', 'a cliPluginsExtraDirs folder');
  assert.equal(copyChannel('C:\\Users\\me\\.docker\\cli-plugins\\docker-agent.exe', { ...win, DOCKER_CONFIG: 'D:\\dockercfg' }, 'win32', noLinks), 'unknown', 'DOCKER_CONFIG moves the download folder');
  assert.equal(copyChannel('D:\\dockercfg\\cli-plugins\\docker-agent.exe', { ...win, DOCKER_CONFIG: 'D:\\dockercfg' }, 'win32', noLinks), 'download');
  // A folder spelled by its short name (a GitHub runner's RUNNER~1) is the same folder, and no link is on the way.
  const shortNamed = { realpath: (f) => f.replace('RUNNER~1', 'runneradmin'), isLink: () => false };
  const shortEnv = { USERPROFILE: 'C:\\Users\\RUNNER~1', ProgramFiles: 'C:\\Program Files' };
  assert.equal(copyChannel('C:\\Users\\RUNNER~1\\.docker\\cli-plugins\\docker-agent.exe', shortEnv, 'win32', shortNamed), 'download', 'a short name is a spelling, not a link');
  assert.equal(linkOnPath('C:\\Users\\RUNNER~1\\.docker\\cli-plugins\\docker-agent.exe', 'win32', shortNamed), null);

  const mac = { HOME: '/Users/me' };
  assert.equal(copyChannel('/Users/me/.docker/cli-plugins/docker-agent', mac, 'darwin', noLinks), 'download');
  // Docker Desktop on macOS links the download folder's file into the app.
  const linked = { realpath: () => '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-agent', isLink: () => true };
  assert.equal(copyChannel('/Users/me/.docker/cli-plugins/docker-agent', mac, 'darwin', linked), 'desktop');
  assert.equal(copyChannel('/Applications/Docker.app/Contents/Resources/cli-plugins/docker-agent', mac, 'darwin', noLinks), 'desktop');
  assert.equal(copyChannel('/usr/local/lib/docker/cli-plugins/docker-agent', mac, 'darwin', noLinks), 'system');
  const otherLink = { realpath: () => '/opt/tools/docker-agent', isLink: () => true };
  assert.equal(copyChannel('/Users/me/.docker/cli-plugins/docker-agent', mac, 'darwin', otherLink), 'unknown', 'a link to somewhere else is not Agent Guild\'s download');

  // A download under a linked parent (macOS's /var is /private/var) is still the download: the link only stops Remove.
  const viaVar = { realpath: (f) => f.replace(/^\/var\//, '/private/var/'), isLink: (p) => p === '/var' };
  assert.equal(copyChannel('/var/home/me/.docker/cli-plugins/docker-agent', { HOME: '/var/home/me' }, 'darwin', viaVar), 'download');
  assert.equal(linkOnPath('/var/home/me/.docker/cli-plugins/docker-agent', 'darwin', viaVar), '/var', 'the link the runner would refuse');
  assert.equal(linkOnPath('/Users/me/.docker/cli-plugins/docker-agent', 'darwin', noLinks), null);

  const linux = { HOME: '/home/me' };
  assert.equal(copyChannel('/home/me/.docker/cli-plugins/docker-agent', linux, 'linux', noLinks), 'download');
  for (const dir of ['/usr/local/lib/docker/cli-plugins', '/usr/local/libexec/docker/cli-plugins', '/usr/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins']) {
    assert.equal(copyChannel(`${dir}/docker-agent`, linux, 'linux', noLinks), 'system', dir);
  }
  assert.equal(copyChannel('/opt/plugins/docker-agent', linux, 'linux', noLinks), 'unknown');
  assert.equal(copyChannel('/home/me/.docker/cli-plugins-old/docker-agent', linux, 'linux', noLinks), 'unknown', 'a folder whose name merely starts the same');

  assert.equal(dockerConfigDir({ HOME: '/home/me' }, 'linux'), '/home/me/.docker');
  assert.equal(dockerConfigDir({ HOME: '/home/me', DOCKER_CONFIG: '/etc/docker-cfg' }, 'linux'), '/etc/docker-cfg');
  assert.equal(downloadDir({ USERPROFILE: 'C:\\Users\\me' }, 'win32'), 'C:\\Users\\me\\.docker\\cli-plugins');
});

test('docker info lists the plugin copy that runs and the ones it shadows; failures are reported, not mistaken for absence', async () => {
  const calls = [];
  const answering = (stdout) => async (spec, opts) => { calls.push([spec, opts]); return { stdout, stderr: '' }; };
  const listed = [
    { SchemaVersion: '0.1.0', Vendor: 'Docker Inc.', Version: 'v1.149.0', Name: 'agent', Path: '/home/me/.docker/cli-plugins/docker-agent', ShadowedPaths: ['/usr/local/lib/docker/cli-plugins/docker-agent', '/home/me/.docker/cli-plugins/docker-agent'] },
    { Name: 'compose', Path: '/usr/local/lib/docker/cli-plugins/docker-compose', Version: 'v2.40.3' },
    { Name: 'broken', Path: '/x/docker-broken', Err: 'failed to fetch metadata' },
  ];
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: answering(JSON.stringify(listed)) }), {
    copies: [{ path: '/home/me/.docker/cli-plugins/docker-agent', active: true }, { path: '/usr/local/lib/docker/cli-plugins/docker-agent', active: false }],
  });
  assert.deepEqual(calls[0][0], { file: '/usr/bin/docker', args: PLUGIN_INFO_ARGS });
  assert.equal(calls[0][1].killTree, true);
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: answering(JSON.stringify(listed.slice(1))) }), { copies: [] }, 'no agent plugin');
  const unloadable = [{ Name: 'agent', Path: '/home/me/.docker/cli-plugins/docker-agent', Err: 'failed to fetch metadata: fork/exec /home/me/.docker/cli-plugins/docker-agent: exec format error' }];
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: answering(JSON.stringify(unloadable)) }), {
    copies: [{ path: '/home/me/.docker/cli-plugins/docker-agent', active: true, error: 'failed to fetch metadata: fork/exec /home/me/.docker/cli-plugins/docker-agent: exec format error' }],
  }, 'a copy docker cannot load is listed with docker\'s reason');
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: answering('null') }), { copies: [] }, 'docker lists no plugins at all');
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: answering('not json') }), { error: 'docker info did not list its plugins as JSON' });
  const failing = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'Cannot connect to the Docker daemon\nerror during connect: open //./pipe/docker_engine' }); };
  assert.deepEqual(await readPlugin('/usr/bin/docker', 'agent', { env: {}, platform: 'linux', run: failing }), { error: 'docker info failed: error during connect: open //./pipe/docker_engine' });

  assert.equal(await pluginVersion('/x/docker-agent', { env: {}, platform: 'linux', run: answering('{"SchemaVersion":"0.1.0","Version":"v1.100.0"}') }), '1.100.0');
  assert.deepEqual(calls.at(-1)[0], { file: '/x/docker-agent', args: PLUGIN_METADATA_ARGS });
  assert.equal(await pluginVersion('/x/docker-agent', { env: {}, platform: 'linux', run: answering('garbage') }), null);
  assert.equal(await pluginVersion('/x/docker-agent', { env: {}, platform: 'linux', run: failing }), null);
});

test('the latest release comes from the redirect of the releases page, with no API call', async () => {
  const requests = [];
  const redirecting = (status, location) => async (url, opts) => { requests.push([url, opts.method, opts.redirect]); return { status, headers: new Headers(location ? { location } : {}) }; };
  assert.equal(await latestReleaseTag('https://github.com/docker/docker-agent/releases/latest', { fetchImpl: redirecting(302, 'https://github.com/docker/docker-agent/releases/tag/v1.149.0') }), '1.149.0');
  assert.deepEqual(requests[0], ['https://github.com/docker/docker-agent/releases/latest', 'HEAD', 'manual']);
  assert.equal(await latestReleaseTag('https://example.com/releases/latest', { fetchImpl: redirecting(200, null) }), null, 'no redirect, no version');
  assert.equal(await latestReleaseTag('https://example.com/releases/latest', { fetchImpl: redirecting(302, 'https://example.com/login') }), null, 'a redirect to no tag');
  assert.equal(await latestReleaseTag('https://example.com/releases/latest', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

// The docker fixture answers `info`, `agent version`, `agent run --help` and `docker-cli-plugin-metadata` as the real
// CLI and plugin do, for the plugin FAKE_DOCKER_PLUGIN_PATH names, once that file exists.
function registryWith(providerEnv, { checkUpdates = false, fetchImpl } = {}) {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  const script = path.join(dir, process.platform === 'win32' ? 'docker.cmd' : 'docker');
  fs.writeFileSync(script, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}" docker %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" docker "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{ id: 'docker', env: providerEnv }] }));
  const env = { ...process.env, PATH: dir, Path: dir, HOME: dir, USERPROFILE: dir };
  return { dir, registry: new ProviderRegistry({ userFile, env, checkUpdates, fetchImpl }) };
}

test('the Docker Agent card is about the plugin copy that runs: installable without one, removable when downloaded', async () => {
  const { dir, registry } = registryWith({});
  const plugin = path.join(dir, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  const provider = registry.get('docker');
  provider.env.FAKE_DOCKER_PLUGIN_PATH = plugin;
  provider.env.FAKE_DOCKER_VERSION = '1.149.0';
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  let card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.resolvedPath, card.installedVersion, card.installs, card.pluginError], [false, true, null, null, [], null], 'docker runs, the plugin is not there');
  assert.equal(card.installCommand, provider.install);
  assert.equal(registry.installed(provider), false);
  await assert.rejects(registry.updateSpec(provider), { code: 'not_updatable' });
  const installSpec = await registry.installSpec(provider);
  assert.ok(installSpec.args.includes(provider.install), 'the install command runs as given');

  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, 'plugin');
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.resolvedPath, card.installedVersion, card.versionStatus, card.installChannel], [true, false, plugin, '1.149.0', 'ok', 'download']);
  assert.equal(card.installs.length, 1);
  assert.deepEqual([card.installs[0].channel, card.installs[0].active, card.installs[0].version, card.installs[0].uninstall.remove], ['download', true, '1.149.0', [card.installs[0].displayPath]]);
  assert.equal(card.updateCommand, provider.install, 'a downloaded copy is updated by the install command');
  assert.equal(registry.installed(provider), true);
  const uninstall = registry.uninstallSpec(provider, plugin);
  assert.equal(uninstall.channel, 'download');
  const plan = JSON.parse(Buffer.from(uninstall.spec.args.at(-1), 'base64url').toString('utf8'));
  assert.deepEqual([plan.remove, plan.strict, plan.run], [[plugin], true, null], 'the runner deletes that one file, strictly');

  // The same copy, but Docker Desktop's: nothing to update or remove here.
  provider.env.FAKE_DOCKER_PLUGINS = JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: process.platform === 'win32' ? 'C:\\Program Files\\Docker\\cli-plugins\\docker-agent.exe' : '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-agent' }]);
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.installChannel, card.updateCommand], [true, false, process.platform === 'win32' ? 'desktop' : process.platform === 'darwin' ? 'desktop' : 'unknown', null]);
  assert.equal(card.installs[0].uninstall, null);
  assert.match(card.installs[0].uninstallGuidance, process.platform === 'linux' ? /not downloaded by Agent Guild|does not know/ : /Docker Desktop/);
  await assert.rejects(registry.updateSpec(provider), { code: 'not_updatable' });
  assert.throws(() => registry.uninstallSpec(provider, card.installs[0].path), { code: 'not_removable' });

  // A downloaded copy shadowing Desktop's: both listed, the download in use.
  const desktop = process.platform === 'win32' ? 'C:\\Program Files\\Docker\\cli-plugins\\docker-agent.exe' : '/usr/local/lib/docker/cli-plugins/docker-agent';
  provider.env.FAKE_DOCKER_PLUGINS = JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: plugin, ShadowedPaths: [desktop] }]);
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual(card.installs.map((i) => [i.channel, i.active, Boolean(i.uninstall)]), [['download', true, true], [process.platform === 'win32' ? 'desktop' : 'system', false, false]]);
  assert.equal(card.warnings.length, 1);
  assert.match(card.warnings[0], /2 copies of Docker Agent are installed\. The one in use is release download v1\.149\.0/);
  // Docker Desktop on macOS links two folders to one file: one copy.
  const link = path.join(dir, 'linked-docker-agent');
  try { fs.symlinkSync(plugin, link); } catch { return; }
  provider.env.FAKE_DOCKER_PLUGINS = JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: plugin, ShadowedPaths: [link] }]);
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  assert.equal(registry.describe(provider).installs.length, 1, 'a link to the running copy is not a second copy');
});

test('a listed copy that was already missing is not asked about on every refresh; one that goes missing is asked about once', async () => {
  const { dir, registry } = registryWith({});
  const plugin = path.join(dir, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  const log = path.join(dir, 'info.log');
  const infos = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const provider = registry.get('docker');
  // The fake docker lists a copy at `plugin` whether or not the file is there, as docker does until it looks again.
  Object.assign(provider.env, { FAKE_DOCKER_INFO_LOG: log, FAKE_DOCKER_PLUGINS: JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: plugin }]) });
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  assert.equal(infos(), 1);
  for (let i = 0; i < 4; i++) await registry.refreshVersions({ ids: ['docker'] });
  assert.equal(infos(), 1, 'a copy missing when docker listed it is not asked about again until the interval');
  // The file appears, then is removed by hand: docker is asked once, and not again while its answer stands.
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, 'plugin');
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  assert.equal(infos(), 2);
  await registry.refreshVersions({ ids: ['docker'] });
  assert.equal(infos(), 2, 'nothing changed: not asked');
  fs.rmSync(plugin);
  await registry.refreshVersions({ ids: ['docker'] });
  assert.equal(infos(), 3, 'the file went missing: asked once');
  for (let i = 0; i < 3; i++) await registry.refreshVersions({ ids: ['docker'] });
  assert.equal(infos(), 3, 'and not again');
});

test('a downloaded copy reached through a link is listed as the download it is, updatable, and not removable', async () => {
  const { dir, registry } = registryWith({});
  const realHome = path.join(dir, 'real-home');
  const linkedHome = path.join(dir, 'linked-home');
  fs.mkdirSync(path.join(realHome, '.docker', 'cli-plugins'), { recursive: true });
  try { fs.symlinkSync(realHome, linkedHome, 'junction'); } catch { return; }
  const plugin = path.join(linkedHome, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  fs.writeFileSync(plugin, 'plugin');
  const provider = registry.get('docker');
  Object.assign(provider.env, { HOME: linkedHome, USERPROFILE: linkedHome, FAKE_DOCKER_PLUGINS: JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: plugin }]) });
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  const card = registry.describe(provider);
  assert.deepEqual([card.available, card.installChannel, card.installs.length, card.installs[0].uninstall], [true, 'download', 1, null]);
  assert.match(card.installs[0].uninstallGuidance, /reached through a link at .*linked-home.*Remove the file yourself/);
  assert.equal(card.updateCommand, provider.install, 'the download command writes through the link without harm');
  assert.throws(() => registry.uninstallSpec(provider, plugin), { code: 'not_removable' });
});

test('a plugin copy docker cannot load fails its version check with docker\'s reason, offers Reinstall for a download, and does not start', async () => {
  const { dir, registry } = registryWith({});
  const plugin = path.join(dir, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, 'not a plugin');
  const provider = registry.get('docker');
  provider.env.FAKE_DOCKER_PLUGINS = JSON.stringify([{ Name: 'agent', Path: plugin, Err: 'failed to fetch metadata: exec format error' }]);
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  const card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.resolvedPath, card.installedVersion, card.versionStatus, card.installChannel], [true, false, plugin, null, 'failed', 'download']);
  assert.equal(card.versionError, `docker cannot load Docker Agent at ${plugin}: failed to fetch metadata: exec format error`);
  assert.equal(card.updateCommand, provider.install, 'the page shows Reinstall, which downloads over the broken copy');
  assert.throws(() => registry.spawnSpec(provider, [], null, [], null), { code: 'provider_unavailable', message: /cannot load .*exec format error.*Reinstall/ });
});

test('a copy removed by hand is noticed at the next look, and nothing is installable or startable until docker has answered once', async () => {
  const { dir, registry } = registryWith({});
  const provider = registry.get('docker');
  const plugin = path.join(dir, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  provider.env.FAKE_DOCKER_PLUGIN_PATH = plugin;
  let card = registry.describe(provider);
  assert.deepEqual([card.pluginPending, card.installable, card.available, card.pluginError], [true, false, false, null], 'before the first answer');
  await assert.rejects(registry.installSpec(provider), { code: 'plugins_unchecked' });
  assert.doesNotThrow(() => registry.spawnSpec(provider), 'docker gets to say whether the plugin is there');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, 'plugin');
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual([card.pluginPending, card.available], [false, true]);
  await assert.rejects(registry.installSpec(provider), { code: 'already_installed' }, 'a download over a running copy would only shadow it');
  fs.rmSync(plugin);
  await registry.refreshVersions({ ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.installs], [false, true, []], 'the next refresh asks docker again instead of trusting the hourly list');
  assert.throws(() => registry.spawnSpec(provider), { code: 'provider_unavailable' });
});

test('a standalone docker-agent configured as the docker command is a plain tool, not a plugin', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{ id: 'docker', command: 'docker-agent', args: ['run'], versionArgs: ['version'] }] }));
  const registry = new ProviderRegistry({ userFile, env: process.env, checkUpdates: false });
  const provider = registry.get('docker');
  assert.deepEqual([provider.plugin, provider.command, provider.args], [null, 'docker-agent', ['run']]);
  const card = registry.describe(provider);
  assert.deepEqual([card.installCommand, card.pluginPending, card.pluginError], [null, false, null]);
  const viaPath = new ProviderRegistry({ userFile: path.join(dir, 'none.json'), env: process.env, checkUpdates: false });
  assert.equal(viaPath.get('docker').plugin, 'agent', 'the default docker command keeps its plugin');
});

test('when docker cannot list its plugins the card says so rather than "not installed", and without docker it says docker is missing', async () => {
  const { registry } = registryWith({ FAKE_DOCKER_PLUGINS: 'not json' });
  const provider = registry.get('docker');
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  let card = registry.describe(provider);
  assert.deepEqual([card.available, card.installable, card.pluginError], [false, false, 'docker info did not list its plugins as JSON']);

  const gone = registryWith({});
  gone.registry.get('docker').command = 'definitely-not-installed-docker';
  await gone.registry.refreshVersions({ force: true, ids: ['docker'] });
  card = gone.registry.describe(gone.registry.get('docker'));
  assert.deepEqual([card.available, card.installable, card.pluginError, card.install, card.installs], [false, false, null, '', []], 'the page then says docker was not found on PATH');
  await assert.rejects(gone.registry.installSpec(gone.registry.get('docker')), { code: 'provider_unavailable' });
});

test('the latest Docker Agent release is looked up hourly from the releases page, and an update is offered for a downloaded copy only', async () => {
  const requests = [];
  const fetchImpl = async (url, opts) => { requests.push(url); return { status: 302, headers: new Headers({ location: 'https://github.com/docker/docker-agent/releases/tag/v1.150.0' }) }; };
  const { dir, registry } = registryWith({ FAKE_DOCKER_VERSION: '1.149.0' }, { checkUpdates: true, fetchImpl });
  const provider = registry.get('docker');
  const plugin = path.join(dir, '.docker', 'cli-plugins', process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, 'plugin');
  provider.env.FAKE_DOCKER_PLUGIN_PATH = plugin;
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  let card = registry.describe(provider);
  assert.deepEqual([card.latestVersion, card.updateAvailable, Boolean(card.updateCommand)], ['1.150.0', true, true]);
  assert.deepEqual(requests, ['https://github.com/docker/docker-agent/releases/latest']);
  await registry.refreshVersions({ ids: ['docker'] });
  assert.equal(requests.length, 1, 'within the hour the answer stands');
  const { spec } = await registry.updateSpec(provider);
  assert.ok(spec.args.includes(provider.install));
  provider.env.FAKE_DOCKER_PLUGINS = JSON.stringify([{ Name: 'agent', Version: 'v1.149.0', Path: process.platform === 'win32' ? 'C:\\Program Files\\Docker\\cli-plugins\\docker-agent.exe' : '/usr/lib/docker/cli-plugins/docker-agent' }]);
  await registry.refreshVersions({ force: true, ids: ['docker'] });
  card = registry.describe(provider);
  assert.deepEqual([card.updateAvailable, card.updateCommand], [true, null], 'a newer release, but not Agent Guild\'s copy to replace');
  assert.match(card.updateGuidance, /Docker Desktop|system package/);
});
