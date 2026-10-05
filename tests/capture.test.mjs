// The demo scripts behind docs/capture/capture.mjs must keep producing what
// the manager reads, or the README screenshots break the next time they are
// refreshed. CI never runs the capture itself, so check its parts here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHub } from '../src/manager/github.mjs';
import { createViews } from '../src/manager/github-views.mjs';
import { commandUsage } from '../src/manager/usage.mjs';
import { commandHistory } from '../src/manager/session-history.mjs';
import { parseVersion } from '../src/manager/versions.mjs';
import { OSC_AGENT_CODE, OSC_AGENT_PREFIX } from '../src/manager/session.mjs';

const capture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capture');
const demo = (name) => path.join(capture, name);
const node = process.execPath;

test('every element the capture clicks is still in the page', () => {
  const script = fs.readFileSync(demo('capture.mjs'), 'utf8');
  const page = fs.readFileSync(path.join(capture, '..', '..', 'web', 'index.html'), 'utf8');
  const selectors = [...script.matchAll(/\bclick\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(selectors.length > 5, 'the capture clicks through the page');
  for (const selector of selectors) {
    for (const [, id] of selector.matchAll(/#([\w-]+)/g)) assert.ok(page.includes(`id="${id}"`), `${selector}: #${id}`);
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) assert.match(page, new RegExp(`class="(?:[^"]* )?${name}(?: [^"]*)?"`), `${selector}: .${name}`);
    for (const [, attr, value] of selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
      if (!attr.startsWith('data-')) assert.ok(page.includes(`${attr}="${value}"`), `${selector}: [${attr}="${value}"]`);
    }
  }
});

test('demo usage reports a plan and windows per provider and account', async () => {
  const personal = await commandUsage({ command: node, args: [demo('demo-usage.mjs'), 'anthropic'] }, process.env);
  assert.equal(personal.plan, 'pro');
  assert.equal(personal.windows.length, 2);
  for (const w of personal.windows) {
    assert.ok(w.usedPercent > 0 && w.usedPercent < 100);
    assert.ok(Date.parse(w.resetsAt) > Date.now());
  }
  const work = await commandUsage(
    { command: node, args: [demo('demo-usage.mjs'), 'anthropic'] },
    { ...process.env, DEMO_ACCOUNT: path.join('accounts', 'anthropic', 'work') },
  );
  assert.equal(work.plan, 'max');
  assert.ok((await commandUsage({ command: node, args: [demo('demo-usage.mjs'), 'openai'] }, process.env)).windows.length > 0);
});

test('demo history lists sessions in the demo root', async () => {
  const root = path.resolve('demo-root');
  const sessions = await commandHistory({ command: node, args: [demo('demo-history.mjs'), 'anthropic', root] }, process.env);
  assert.ok(sessions.length >= 10);
  assert.equal(new Set(sessions.map((s) => s.id)).size, sessions.length, 'ids are unique');
  for (const s of sessions) {
    assert.ok(s.title);
    assert.ok(s.cwd.startsWith(root));
  }
});

test('the demo tool prints its version and reports its model and agents', () => {
  const version = execFileSync(node, [demo('demo-tool.mjs'), '--version'], { env: { ...process.env, DEMO_VERSION: '2.3.4' }, encoding: 'utf8' });
  assert.equal(parseVersion(version), '2.3.4');

  const output = execFileSync(node, [
    demo('demo-tool.mjs'), '--script', 'shell', '--quiet',
    '--model', 'demo-model-1', 'Demo Model 1', '--agents', 'Explore:working,Test writer:waiting',
  ], { input: '', encoding: 'utf8', timeout: 10000 });
  const pattern = new RegExp(`\\x1b\\]${OSC_AGENT_CODE};${OSC_AGENT_PREFIX}(.*?)\\x07`, 'g');
  const reports = [...output.matchAll(pattern)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(reports, [
    { model: 'demo-model-1', displayName: 'Demo Model 1' },
    { agentId: 'explore', name: 'Explore', status: 'working' },
    { agentId: 'test-writer', name: 'Test writer', status: 'waiting' },
  ]);
  assert.match(output, /npm run dev/);
});

test('the capture\'s GitHub signs in its account and fills every view of the panel', async (t) => {
  const { DEMO_ACCOUNT, DEMO_REPOS, startDemoGitHub } = await import(pathToFileURL(demo('demo-github.mjs')));
  const github = await startDemoGitHub();
  t.after(github.close);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-capture-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [DEMO_ACCOUNT] }));
  const hub = new GitHub({ dir, registry: { env: { PATH: '' }, platform: process.platform }, apiUrl: github.url });
  const all = await hub.allRepos();
  assert.deepEqual(all.errors, []);
  assert.deepEqual(all.repos.map((r) => r.fullName).sort(), [...DEMO_REPOS].sort());
  const views = createViews(hub);
  const [owner, name] = DEMO_REPOS[0].split('/');
  assert.ok((await views.issues(DEMO_ACCOUNT.id, owner, name)).issues.length >= 3);
  const branches = await views.branches(DEMO_ACCOUNT.id, owner, name);
  assert.equal(branches.defaultBranch, 'main');
  assert.ok(branches.branches.some((branch) => branch.protected));
  const actions = await views.actions(DEMO_ACCOUNT.id, owner, name);
  assert.ok(actions.runs.length >= 3 && actions.running);
  assert.ok((await views.pulls(DEMO_ACCOUNT.id, owner, name)).pulls.length >= 1);
});

test('every file the banner draws from exists', () => {
  const html = fs.readFileSync(demo('banner.html'), 'utf8');
  const files = [...html.matchAll(/(?:src="|url\(")(\.\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length > 5);
  for (const file of files) assert.ok(fs.existsSync(path.join(capture, file)), file);
});
