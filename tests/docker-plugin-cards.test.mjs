import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginCards } from '../src/manager/docker-plugin-cards.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A Docker config folder, Agent Guild's ledger, and `docker info` answering whatever `state.plugins` holds.
function card(t, { extraDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-card-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'docker');
  fs.mkdirSync(path.join(config, 'cli-plugins'), { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: extraDirs }));
  const env = { DOCKER_CONFIG: config, ProgramFiles: path.join(root, 'Program Files') };
  const answers = [];
  const state = { plugins: [] };
  const run = () => (answers.length ? answers.shift() : Promise.resolve({ stdout: JSON.stringify(state.plugins), stderr: '' }));
  const registry = { env, platform: process.platform, checkUpdates: false, resolve: () => 'docker', emit() {} };
  const cards = new PluginCards(registry, { dir: path.join(root, 'ledger'), run });
  const provider = { id: 'docker', tool: 'Docker Agent', command: 'docker', dockerPlugin: 'agent', env: {} };
  const target = cards.target(provider);
  const plugin = (file, version = 'v1.149.0', shadowed = []) => ({ Name: 'agent', Path: file, Version: version, ShadowedPaths: shadowed });
  // An Agent Guild install of `text` at the target, as the runner leaves it.
  const own = (text, version = '1.149.0') => {
    fs.writeFileSync(target, text);
    cards.ledger(provider).writeReceipt({ managed: { path: target, sha256: sha(text), version }, applied: [], pending: [], conflict: null });
  };
  const describe = (installing = false) => cards.describe(provider, { id: 'docker' }, { installing });
  const desktop = process.platform === 'win32'
    ? path.join(root, 'Program Files', 'Docker', 'cli-plugins', 'docker-agent.exe')
    : '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-agent';
  return { root, config, cards, provider, target, state, answers, plugin, own, describe, desktop };
}

test('a check of Docker\'s plugins that started before an operation never overwrites what came after', async (t) => {
  const c = card(t);
  let answer;
  c.answers.push(new Promise((resolve) => { answer = resolve; }));
  const slow = c.cards.refresh(c.provider);
  // An install starts and ends meanwhile, and its own check sees the new copy.
  c.cards.began(c.provider);
  c.own('docker-agent v1.149.0');
  c.state.plugins = [c.plugin(c.target)];
  await c.cards.finished(c.provider, { exitCode: 0, kind: 'install' });
  assert.equal(c.describe().available, true);
  // The old answer, from before the install, arrives last.
  answer({ stdout: '[]', stderr: '' });
  await slow;
  assert.deepEqual([c.describe().available, c.describe().plugin.phase], [true, 'ready'], 'the stale answer was dropped');
});

test('an install is Ready only once Docker runs the copy Agent Guild recorded', async (t) => {
  const c = card(t);
  c.cards.began(c.provider);
  assert.equal(c.describe(true).plugin.phase, 'installing');
  // The runner ended, but nothing was recorded: not Ready, however it exited.
  assert.equal((await c.cards.finished(c.provider, { exitCode: 0, kind: 'install' })).outcome, 'failed');
  c.own('docker-agent v1.149.0');
  // Recorded, but Docker runs another copy first.
  const elsewhere = path.join(c.root, 'extra', path.basename(c.target));
  c.state.plugins = [c.plugin(elsewhere, 'v1.140.0', [c.target])];
  const shadowed = await c.cards.finished(c.provider, { exitCode: 0, kind: 'install' });
  assert.equal(shadowed.outcome, 'shadowed');
  assert.match(shadowed.message, /is installed at .* but Docker runs .* first/);
  // Docker runs it, at the version recorded.
  c.state.plugins = [c.plugin(c.target)];
  assert.equal((await c.cards.finished(c.provider, { exitCode: 0, kind: 'install' })).outcome, 'ready');
  const shown = c.describe();
  assert.deepEqual([shown.available, shown.installable, shown.installs[0].channel, Boolean(shown.installs[0].uninstall), shown.plugin.phase],
    [true, false, 'agent-guild', true, 'ready']);
});

test('Install never lands where Docker will not run it, and says what it changes when it will', async (t) => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-plugins-'));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const c = card(t, { extraDirs: [extra] });
  await c.cards.refresh(c.provider);
  assert.deepEqual(c.cards.installPlan(c.provider), { ok: true, reason: null, note: null }, 'no copy anywhere');
  // A copy in cliPluginsExtraDirs runs first: blocked, and the card says why beside that copy.
  c.state.plugins = [c.plugin(path.join(extra, path.basename(c.target)))];
  await c.cards.refresh(c.provider);
  const blocked = c.describe();
  assert.equal(blocked.installable, false);
  assert.match(blocked.plugin.message, /from cliPluginsExtraDirs, so a copy in .* would never run/);
  // Docker Desktop's copy in the system folder runs after the config folder: allowed, and the consequence is stated.
  c.state.plugins = [c.plugin(c.desktop)];
  await c.cards.refresh(c.provider);
  const beside = c.describe();
  assert.equal(beside.installable, true);
  assert.match(beside.plugin.message, /Agent Guild's copy will run instead of the Docker Desktop copy at/);
  assert.deepEqual([beside.installs[0].channel, beside.installs[0].uninstall, beside.updateCommand], ['docker-desktop', null, null], 'Desktop\'s copy gets no actions');
  // A file someone else put at the target is left alone.
  fs.writeFileSync(c.target, 'by hand');
  assert.match(c.cards.installPlan(c.provider).reason, /a copy Agent Guild did not install/);
});

test('Remove, then Install, works with another copy visible, and only Agent Guild\'s copy is offered for removal', async (t) => {
  const c = card(t);
  c.own('docker-agent v1.149.0');
  c.state.plugins = [c.plugin(c.target, 'v1.149.0', [c.desktop])];
  await c.cards.refresh(c.provider);
  const both = c.describe();
  assert.deepEqual(both.installs.map((i) => [i.channel, Boolean(i.uninstall)]), [['agent-guild', true], ['docker-desktop', false]]);
  assert.match(both.warnings[0], /2 copies .* Docker runs the Agent Guild copy/);
  await assert.rejects(c.cards.operation(c.provider, 'remove', c.desktop), /changes only the copy it installed/);
  // Removed: Docker now runs Desktop's copy, and Agent Guild's can be installed again.
  fs.rmSync(c.target);
  c.cards.ledger(c.provider).writeReceipt({ managed: null, applied: [], pending: [], conflict: null });
  c.state.plugins = [c.plugin(c.desktop)];
  await c.cards.refresh(c.provider);
  const after = c.describe();
  assert.deepEqual([after.available, after.installable, after.installChannel], [true, true, 'docker-desktop']);
  // A receipt whose copy was deleted by hand owns nothing, so it never blocks Install.
  c.cards.ledger(c.provider).writeReceipt({ managed: { path: c.target, sha256: sha('gone'), version: '1.0.0' }, applied: [], pending: [], conflict: null });
  assert.equal(c.cards.installPlan(c.provider).ok, true);
  assert.equal(c.cards.owned(c.provider), false);
});

test('without Docker, or with a plugin Docker cannot load, the card says so and offers nothing it cannot do', async (t) => {
  const c = card(t);
  c.cards.registry.resolve = () => null;
  await c.cards.refresh(c.provider);
  assert.deepEqual([c.describe().available, c.describe().installable], [false, false]);
  assert.match(c.describe().install, /Docker is not installed/);
  c.cards.registry.resolve = () => 'docker';
  c.state.plugins = [{ Name: 'agent', Path: c.target, Err: 'exec format error' }];
  await c.cards.refresh(c.provider);
  assert.equal(c.describe().available, false);
  assert.match(c.describe().plugin.message, /Docker cannot load .*exec format error/);
});
