import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginLedger, reconcile, sweepBackups, readPlugin, ownerOf, extraPluginDirs, pluginTarget, latestRelease, sha256File } from '../src/manager/docker-plugin.mjs';
import { runOperation, sideFiles } from '../src/manager/docker-plugin-runner.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const CRASH = new Error('crashed here');

// A plugin folder and Agent Guild's ledger folder, and a release whose download is `body`.
function rig(t, body = 'docker-agent v2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugins = path.join(root, 'cli-plugins');
  fs.mkdirSync(plugins);
  const target = path.join(plugins, process.platform === 'win32' ? 'docker-agent.exe' : 'docker-agent');
  const ledgerDir = path.join(root, 'ledger');
  const ledger = new PluginLedger(ledgerDir, 'agent');
  const release = { version: '2.0.0', url: 'https://example.test/docker-agent', sha256: sha(body) };
  const fetchImpl = async () => new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } });
  const validate = async () => {};
  const run = (op, options = {}) => runOperation({ op, name: 'agent', target, ledgerDir, release }, { fetchImpl, validate, ...options });
  // An earlier Agent Guild install of `text`.
  const owned = (text) => {
    fs.writeFileSync(target, text);
    ledger.writeReceipt({ managed: { path: target, sha256: sha(text), version: '1.0.0' }, applied: [], pending: [], conflict: null });
  };
  const leftovers = () => fs.readdirSync(plugins).filter((name) => name.startsWith('.'));
  const crashAt = (name) => ({ step: async (at) => { if (at === name) throw CRASH; } });
  return { root, plugins, target, ledger, release, run, owned, leftovers, crashAt };
}

test('an install is staged, checked against the release SHA-256, and recorded only once it is in place', async (t) => {
  const r = rig(t);
  assert.deepEqual(await r.run('install'), { outcome: 'committed', message: null });
  assert.equal(fs.readFileSync(r.target, 'utf8'), 'docker-agent v2');
  assert.deepEqual(r.ledger.receipt().managed, { path: r.target, sha256: r.release.sha256, version: '2.0.0' });
  assert.equal(r.ledger.journal(), null);
  assert.deepEqual(r.leftovers(), []);
});

test('a download that does not match its SHA-256, or does not run as a plugin, changes nothing', async (t) => {
  const r = rig(t);
  r.release.sha256 = sha('something else');
  await assert.rejects(r.run('install'), /SHA-256 is .* not the .* the release publishes/);
  assert.deepEqual([fs.existsSync(r.target), r.ledger.receipt().managed, r.ledger.journal(), r.leftovers()], [false, null, null, []]);

  const u = rig(t);
  u.owned('docker-agent v1');
  await assert.rejects(u.run('update', { validate: async () => { throw new Error('reports itself as v9'); } }), /v9/);
  assert.equal(fs.readFileSync(u.target, 'utf8'), 'docker-agent v1');
  assert.equal(u.ledger.receipt().managed.sha256, sha('docker-agent v1'));
  assert.deepEqual([u.ledger.journal(), u.leftovers()], [null, []]);
});

test('an install interrupted at any step ends as if it never started, or as installed, never in between', async (t) => {
  for (const at of ['journal', 'download', 'validate', 'swap']) {
    const r = rig(t);
    await assert.rejects(r.run('install', r.crashAt(at)), CRASH);
    assert.equal(reconcile(r.ledger).outcome, at === 'journal' ? 'none' : 'undone', at);
    assert.deepEqual([fs.existsSync(r.target), r.ledger.receipt().managed, r.ledger.journal(), r.leftovers()], [false, null, null, []], at);
  }
  // Replaced, then interrupted before the receipt took it: the copy is still Agent Guild's.
  const r = rig(t);
  await assert.rejects(r.run('install', r.crashAt('commit')), CRASH);
  assert.equal(r.ledger.receipt().managed, null);
  assert.equal(reconcile(r.ledger).outcome, 'committed');
  assert.deepEqual(r.ledger.receipt().managed, { path: r.target, sha256: r.release.sha256, version: '2.0.0' });
  assert.equal(ownerOf(r.target, { target: r.target, receipt: r.ledger.receipt() }), 'agent-guild');
});

test('an update interrupted at any step keeps a working copy, and the old one is deleted only while unchanged', async (t) => {
  for (const at of ['download', 'validate', 'backup', 'swap']) {
    const r = rig(t);
    r.owned('docker-agent v1');
    await assert.rejects(r.run('update', r.crashAt(at)), CRASH);
    if (at === 'swap') assert.equal(fs.existsSync(r.target), false, 'the old copy was moved aside');
    assert.equal(reconcile(r.ledger).outcome, 'undone', at);
    assert.equal(fs.readFileSync(r.target, 'utf8'), 'docker-agent v1', `${at}: the old copy is back`);
    assert.equal(r.ledger.receipt().managed.sha256, sha('docker-agent v1'));
    assert.deepEqual(r.leftovers(), [], at);
  }
  const r = rig(t);
  r.owned('docker-agent v1');
  await assert.rejects(r.run('update', r.crashAt('commit')), CRASH);
  assert.equal(reconcile(r.ledger).outcome, 'committed');
  assert.equal(r.ledger.receipt().managed.sha256, r.release.sha256);
  const [backup] = r.ledger.receipt().pending;
  assert.equal(backup.sha256, sha('docker-agent v1'), 'the replaced copy waits to be deleted');
  assert.deepEqual(r.leftovers(), [path.basename(backup.path)], 'beside the target, under a name Docker never loads');
  sweepBackups(r.ledger);
  assert.deepEqual([r.leftovers(), r.ledger.receipt().pending], [[], []]);
});

test('an interrupted removal is finished only on evidence, and unfamiliar files are reported and kept', async (t) => {
  // Before the rename: nothing happened, and the copy is still Agent Guild's.
  const before = rig(t);
  before.owned('docker-agent v1');
  await assert.rejects(before.run('remove', before.crashAt('backup')), CRASH);
  assert.equal(reconcile(before.ledger).outcome, 'undone');
  assert.equal(ownerOf(before.target, { target: before.target, receipt: before.ledger.receipt() }), 'agent-guild');
  // After the rename: the backup holds the copy's own hash, so the removal finishes.
  const after = rig(t);
  after.owned('docker-agent v1');
  await assert.rejects(after.run('remove', after.crashAt('commit')), CRASH);
  assert.deepEqual(reconcile(after.ledger), { outcome: 'committed', message: null });
  assert.deepEqual([fs.existsSync(after.target), after.ledger.receipt().managed], [false, null]);
  sweepBackups(after.ledger);
  assert.deepEqual(after.leftovers(), []);

  // Both files gone: not taken as removed, and said so.
  const gone = rig(t);
  gone.owned('docker-agent v1');
  await assert.rejects(gone.run('remove', gone.crashAt('commit')), CRASH);
  const { backup } = gone.ledger.journal();
  fs.rmSync(backup);
  const lost = reconcile(gone.ledger);
  assert.equal(lost.outcome, 'conflict');
  assert.match(lost.message, /both .* and Agent Guild's backup of it are gone/);
  assert.equal(gone.ledger.receipt().conflict, lost.message, 'the card can say what happened');

  // Someone else's file at the target, or at the backup, is left exactly as it is.
  const foreign = rig(t);
  foreign.owned('docker-agent v1');
  await assert.rejects(foreign.run('remove', foreign.crashAt('commit')), CRASH);
  fs.writeFileSync(foreign.target, 'not ours');
  assert.equal(reconcile(foreign.ledger).outcome, 'conflict');
  assert.equal(fs.readFileSync(foreign.target, 'utf8'), 'not ours');
  const swapped = rig(t);
  swapped.owned('docker-agent v1');
  await assert.rejects(swapped.run('remove', swapped.crashAt('commit')), CRASH);
  const moved = swapped.ledger.journal().backup;
  fs.writeFileSync(moved, 'also not ours');
  assert.match(reconcile(swapped.ledger).message, /is not the copy Agent Guild moved there/);
  sweepBackups(swapped.ledger);
  assert.equal(fs.readFileSync(moved, 'utf8'), 'also not ours', 'a backup that changed is not Agent Guild\'s to delete');
});

test('finishing a journal is idempotent across a crash between the receipt and the journal', async (t) => {
  const r = rig(t);
  await assert.rejects(r.run('install', r.crashAt('commit')), CRASH);
  const journal = r.ledger.journal();
  // The receipt took the operation; the crash came before the journal was cleared.
  r.ledger.writeReceipt({ managed: { path: r.target, sha256: r.release.sha256, version: '2.0.0' }, applied: [journal.id], pending: [], conflict: null });
  r.ledger.writeJournal(journal);
  assert.equal(reconcile(r.ledger).outcome, 'committed');
  assert.equal(reconcile(r.ledger).outcome, 'none');
  assert.deepEqual(r.ledger.receipt().applied, [journal.id]);
});

test('a backup still in use waits for the next sweep', async (t) => {
  const r = rig(t);
  const { backup } = sideFiles(r.target, 'held');
  // A folder at the path makes the delete fail the way a running .exe on Windows does (EPERM).
  fs.mkdirSync(backup);
  r.ledger.writeReceipt({ managed: null, applied: [], pending: [{ path: backup, sha256: 'held' }], conflict: null });
  const hash = (file) => (file === backup ? 'held' : sha256File(file));
  assert.equal(sweepBackups(r.ledger, { hash }).pending.length, 1);
  fs.rmdirSync(backup);
  fs.writeFileSync(backup, 'x');
  assert.equal(sweepBackups(r.ledger, { hash }).pending.length, 0);
  assert.equal(fs.existsSync(backup), false);
  // A queued backup that changed since is no longer Agent Guild's: it is dropped from the queue, not deleted.
  fs.writeFileSync(backup, 'queued');
  r.ledger.writeReceipt({ managed: null, applied: [], pending: [{ path: backup, sha256: sha('queued') }], conflict: null });
  fs.writeFileSync(backup, 'replaced since');
  assert.equal(sweepBackups(r.ledger).pending.length, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'replaced since');
});

test('Install never writes over a file Agent Guild did not write, and Update and Remove touch only the recorded copy', async (t) => {
  const r = rig(t);
  fs.writeFileSync(r.target, 'downloaded by hand');
  await assert.rejects(r.run('install'), /already exists, and Agent Guild did not write it/);
  assert.equal(fs.readFileSync(r.target, 'utf8'), 'downloaded by hand');
  r.owned('docker-agent v1');
  fs.writeFileSync(r.target, 'replaced by hand');
  await assert.rejects(r.run('update'), /not the copy Agent Guild installed, or it changed since/);
  await assert.rejects(r.run('remove'), /not the copy Agent Guild installed/);
  assert.equal(fs.readFileSync(r.target, 'utf8'), 'replaced by hand');
  assert.equal(ownerOf(r.target, { target: r.target, receipt: r.ledger.receipt() }), 'other');
});

test('Docker\'s own answer names the copy it runs and the ones it shadows; Desktop\'s copies are Desktop\'s', async () => {
  // `docker info --format '{{json .ClientInfo.Plugins}}'`, Docker CLI 29.1.3 with a copy in cliPluginsExtraDirs.
  const stdout = JSON.stringify([
    { SchemaVersion: '0.1.0', Vendor: 'Docker Inc.', Version: 'v1.149.0', ShortDescription: 'Docker AI Agent Runner', Name: 'agent', Path: 'C:\\extra\\docker-agent.exe', ShadowedPaths: ['C:\\Users\\me\\.docker\\cli-plugins\\docker-agent.exe'] },
    { Name: 'ai', Version: 'v1.17.1', Path: 'C:\\Program Files\\Docker\\cli-plugins\\docker-ai.exe' },
  ]);
  const run = async () => ({ stdout, stderr: '' });
  assert.deepEqual(await readPlugin({ docker: 'docker', name: 'agent', run }), {
    path: 'C:\\extra\\docker-agent.exe', version: '1.149.0', shadowed: ['C:\\Users\\me\\.docker\\cli-plugins\\docker-agent.exe'], error: null,
  });
  assert.deepEqual(await readPlugin({ docker: 'docker', name: 'none', run }), { path: null, version: null, shadowed: [], error: null });
  const broken = await readPlugin({ docker: 'docker', name: 'agent', run: async () => ({ stdout: JSON.stringify([{ Name: 'agent', Path: '/x/docker-agent', Err: 'not a plugin' }]) }) });
  assert.match(broken.error, /Docker cannot load \/x\/docker-agent: not a plugin/);
  const failed = await readPlugin({ docker: 'docker', name: 'agent', run: async () => { throw Object.assign(new Error('x'), { stderr: 'permission denied\nmore' }); } });
  assert.deepEqual([failed.path, failed.error], [null, 'docker info failed: permission denied']);

  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(ownerOf('C:\\Program Files\\Docker\\cli-plugins\\docker-agent.exe', { target: 'C:\\t', receipt: null, platform: 'win32', env }), 'docker-desktop');
  assert.equal(ownerOf('/Applications/Docker.app/Contents/Resources/cli-plugins/docker-agent', { target: '/t', receipt: null, platform: 'darwin' }), 'docker-desktop');
  assert.equal(ownerOf('/usr/libexec/docker/cli-plugins/docker-agent', { target: '/t', receipt: null, platform: 'linux' }), 'other');
  assert.equal(pluginTarget('agent', { DOCKER_CONFIG: '/cfg' }, 'linux'), '/cfg/cli-plugins/docker-agent');
  assert.equal(pluginTarget('agent', { USERPROFILE: 'C:\\Users\\me' }, 'win32'), 'C:\\Users\\me\\.docker\\cli-plugins\\docker-agent.exe');
});

test('cliPluginsExtraDirs comes from the Docker config folder, and a release without a published hash is refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: ['/opt/plugins', 7], currentContext: 'desktop-linux' }));
  assert.deepEqual(extraPluginDirs({ DOCKER_CONFIG: dir }), ['/opt/plugins']);
  assert.deepEqual(extraPluginDirs({ DOCKER_CONFIG: path.join(dir, 'none') }), []);

  const asset = (digest) => ({ tag_name: 'v1.149.0', assets: [{ name: 'docker-agent-windows-amd64.exe', browser_download_url: 'https://github.com/x', digest }] });
  const fetchWith = (body) => async () => new Response(JSON.stringify(body));
  const digest = `sha256:${'b'.repeat(64)}`;
  assert.deepEqual(await latestRelease({ fetchImpl: fetchWith(asset(digest)), platform: 'win32', arch: 'x64' }), {
    version: '1.149.0', url: 'https://github.com/x', sha256: 'b'.repeat(64), name: 'docker-agent-windows-amd64.exe',
  });
  await assert.rejects(latestRelease({ fetchImpl: fetchWith(asset(null)), platform: 'win32', arch: 'x64' }), /publishes no SHA-256/);
  // Rate-limited: the card says so and when to try again, not just a status code.
  const limited = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791492508' } });
  await assert.rejects(latestRelease({ fetchImpl: limited, platform: 'win32', arch: 'x64' }), /limit of 60 release lookups an hour from this network is used up; try again after/);
  await assert.rejects(latestRelease({ fetchImpl: fetchWith(asset(digest)), platform: 'linux', arch: 'x64' }), /has no docker-agent-linux-amd64/);
});
