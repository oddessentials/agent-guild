import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, buildSpawnSpec, quoteForCmd } from '../src/manager/command-resolver.mjs';
import { mergePathLists, parsePathFromEnvOutput } from '../src/manager/shell-env.mjs';
import { mergeEnv, cleanResumeId, modelFromArgs } from '../src/manager/session-manager.mjs';
import { loadProviders, defaultShell, ProviderRegistry } from '../src/manager/providers.mjs';
import { claudeHookToReport, claudeStatuslineToReport, formatStatusLine } from '../src/report/claude-hook.mjs';
import { ensurePtyReady, spawnHelperCandidates } from '../src/manager/pty-setup.mjs';
import { parseVersion, compareVersions, installedVersion, latestVersion } from '../src/manager/versions.mjs';
import {
  UsageMonitor, readClaudeCredentials, readCodexCredentials, claudeKeychainService, claudeCredentialsFile, fetchClaudeUsage, fetchCodexUsage,
  commandUsage, toIso, windowLabel,
} from '../src/manager/usage.mjs';
import crypto from 'node:crypto';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-unit-'));
}

test('resolveCommand finds executables on a POSIX PATH', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  const tool = path.join(dir, 'mytool');
  fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'notexec'), '', { mode: 0o644 });
  const env = { PATH: `/nonexistent:${dir}` };
  assert.equal(resolveCommand('mytool', env, 'linux'), tool);
  assert.equal(resolveCommand('notexec', env, 'linux'), null);
  assert.equal(resolveCommand('missing', env, 'linux'), null);
  assert.equal(resolveCommand(tool, {}, 'linux'), tool);
});

test('resolveCommand honours PATHEXT order on Windows (simulated)', () => {
  const files = new Set([
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\tools\\grok.exe',
  ]);
  const opts = { isExecutable: (f) => files.has(f) };
  const env = { Path: 'C:\\Windows;"C:\\Users\\dev\\AppData\\Roaming\\npm";C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveCommand('claude', env, 'win32', opts), 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(resolveCommand('grok', env, 'win32', opts), 'C:\\tools\\grok.exe');
  assert.equal(resolveCommand('grok.exe', env, 'win32', opts), 'C:\\tools\\grok.exe');
  assert.equal(resolveCommand('codex', env, 'win32', opts), null);
  // Only a PowerShell shim present: accepted as a last resort.
  files.delete('C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(resolveCommand('claude', env, 'win32', opts), 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1');
});

test('resolveCommand finds .cmd shims on a real Windows PATH', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  fs.writeFileSync(path.join(dir, 'claude'), '');
  const resolved = resolveCommand('claude', { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32');
  assert.equal(resolved.toLowerCase(), path.join(dir, 'claude.cmd').toLowerCase());
});

test('buildSpawnSpec wraps Windows batch shims in cmd.exe', () => {
  const spec = buildSpawnSpec('C:\\Users\\a b\\npm\\codex.cmd', ['--model', 'x y'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32');
  assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(spec.args, '/d /s /c ""C:\\Users\\a b\\npm\\codex.cmd" --model "x y""');
  const ps = buildSpawnSpec('C:\\npm\\gemini.ps1', [], { SystemRoot: 'D:\\Win' }, 'win32');
  assert.equal(ps.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(ps.args.includes('-File'));
  assert.equal(buildSpawnSpec('C:\\npm\\codex.cmd', [], {}, 'win32').file, 'C:\\Windows\\System32\\cmd.exe');
  const exe = buildSpawnSpec('C:\\bin\\grok.exe', ['a'], {}, 'win32');
  assert.deepEqual(exe, { file: 'C:\\bin\\grok.exe', args: ['a'] });
  assert.deepEqual(buildSpawnSpec('/usr/bin/claude', ['x'], {}, 'darwin'), { file: '/usr/bin/claude', args: ['x'] });
});

test('quoteForCmd escapes quotes and metacharacters', () => {
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
  assert.equal(quoteForCmd(''), '""');
});

test('mergePathLists keeps order and removes duplicates', () => {
  assert.equal(mergePathLists('/a:/b', '/b:/c', ':'), '/a:/b:/c');
  assert.equal(mergePathLists('', '/x', ':'), '/x');
});

test('loadProviders merges user overrides, platform keys and disabled entries', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({
    providers: [
      { id: 'anthropic', args: ['--verbose'], win32: { command: 'claude-win' } },
      { id: 'xai', enabled: false },
      { id: 'local-llm', vendor: 'Local', tool: 'Aider', command: 'aider' },
      { id: 'Bad Id!', command: 'x' },
    ],
  }));
  const linux = loadProviders({ userFile, platform: 'linux' });
  const ids = linux.providers.map((p) => p.id);
  assert.deepEqual(ids, ['anthropic', 'openai', 'google', 'shell', 'local-llm']);
  const anthropic = linux.providers[0];
  assert.deepEqual(anthropic.args, ['--verbose']);
  assert.equal(anthropic.command, 'claude');
  assert.equal(anthropic.tool, 'Claude Code');
  assert.equal(linux.warnings.length, 1);

  const win = loadProviders({ userFile, platform: 'win32' });
  assert.equal(win.providers[0].command, 'claude-win');
  assert.equal(win.providers[0].win32, undefined);
});

test('resume and install specs come from the provider configuration', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', command: process.execPath },
    { id: 'shell', command: process.execPath },
  ] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, platform: process.platform });
  const anthropic = registry.get('anthropic');
  assert.deepEqual(registry.spawnSpec(anthropic, ['-p'], 'sess-1').args, ['--resume', 'sess-1', '-p']);
  assert.deepEqual(registry.spawnSpec(anthropic, [], null).args, []);
  assert.throws(() => registry.spawnSpec(registry.get('shell'), [], 'x'), (err) => err.code === 'resume_unsupported');

  assert.throws(() => registry.installSpec(registry.get('shell')), (err) => err.code === 'not_installable');
  const npmDir = tempDir();
  if (process.platform === 'win32') fs.writeFileSync(path.join(npmDir, 'npm.cmd'), '@echo https://mirror.example/npm/\r\n');
  else fs.writeFileSync(path.join(npmDir, 'npm'), '#!/bin/sh\necho https://mirror.example/npm/\n', { mode: 0o755 });
  const npmEnv = { PATH: npmDir, PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot };
  const withNpm = new ProviderRegistry({ userFile, env: npmEnv, platform: process.platform });
  const argsOf = (spec) => (typeof spec.args === 'string' ? spec.args : spec.args.join(' '));
  assert.ok(argsOf(withNpm.installSpec(withNpm.get('anthropic'))).includes('install -g @anthropic-ai/claude-code@latest'));
  assert.equal(await withNpm.npmRegistryUrl(), 'https://mirror.example/npm/', "installs and lookups share npm's own registry");
  const mirrored = new ProviderRegistry({ userFile, env: npmEnv, platform: process.platform, registryUrl: 'https://mirror.example/other' });
  assert.ok(argsOf(mirrored.installSpec(mirrored.get('anthropic'))).includes('@latest --registry https://mirror.example/other'));
  assert.equal(await mirrored.npmRegistryUrl(), 'https://mirror.example/other');
  const onWindows = buildSpawnSpec('C:\\npm\\npm.cmd', ['install', '-g', 'x@latest', '--registry', 'http://127.0.0.1:1'], {}, 'win32');
  assert.ok(onWindows.args.endsWith(' --registry http://127.0.0.1:1"'), 'the registry URL needs no cmd.exe quoting');
  const withoutNpm = new ProviderRegistry({ userFile, env: { PATH: tempDir() }, platform: process.platform });
  assert.throws(() => withoutNpm.installSpec(withoutNpm.get('anthropic')), (err) => err.code === 'npm_unavailable');
  assert.equal(await withoutNpm.npmRegistryUrl(), 'https://registry.npmjs.org');

  assert.equal(cleanResumeId(undefined), null);
  assert.equal(cleanResumeId('  550e8400-e29b  '), '550e8400-e29b');
  assert.throws(() => cleanResumeId(''), (err) => err.status === 400);
  assert.throws(() => cleanResumeId('a\x1bb'), (err) => err.status === 400);
  assert.throws(() => cleanResumeId('x'.repeat(201)), (err) => err.status === 400);
});

test('versions are parsed, compared and looked up', async () => {
  assert.equal(parseVersion('2.1.285 (Claude Code)'), '2.1.285');
  assert.equal(parseVersion('codex-cli 0.45.0\n'), '0.45.0');
  assert.equal(parseVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(parseVersion('no version here'), null);
  assert.ok(compareVersions('1.2.10', '1.2.9') > 0);
  assert.ok(compareVersions('1.2.3', '1.10.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.3-beta', '1.2.3') < 0);

  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  assert.equal(await installedVersion(buildSpawnSpec(process.execPath, [fake, '--version'])), '1.2.3');
  assert.equal(await installedVersion({ file: path.join(tempDir(), 'missing'), args: [] }), null);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/@openai%2fcodex/latest')) return { ok: true, json: async () => ({ version: '0.50.1' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await latestVersion('@openai/codex', { registryUrl: 'https://registry.example/', fetchImpl }), '0.50.1');
  assert.equal(calls[0], 'https://registry.example/@openai%2fcodex/latest');
  assert.equal(await latestVersion('nothing', { fetchImpl }), null);
  assert.equal(await latestVersion('boom', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('the registry lookup matches npm install -g, not a project .npmrc', { skip: !resolveCommand('npm') && 'npm is not installed' }, async () => {
  const dir = tempDir();
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.npmrc'), 'registry=https://project.example/\n');
  const userConfig = path.join(dir, 'user.npmrc');
  fs.writeFileSync(userConfig, 'registry=https://user.example/\n');
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [] }));
  // Inherited npm_config_* variables (from the shell, or from npm running the
  // tests) would override the fixture files.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const registry = new ProviderRegistry({ userFile, env: { ...env, NPM_CONFIG_USERCONFIG: userConfig }, checkUpdates: false });
  const cwd = process.cwd();
  process.chdir(project);
  try {
    assert.equal(await registry.npmRegistryUrl(), 'https://user.example/');
  } finally {
    process.chdir(cwd);
  }
});

test('installed versions are re-read when the tool changes, hourly, and after a failed probe', async () => {
  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  const dir = tempDir();
  const tool = path.join(dir, 'tool.mjs');
  fs.copyFileSync(fake, tool);
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', command: process.execPath, versionArgs: [tool, '--version'], package: null },
    { id: 'openai', command: process.execPath, versionArgs: ['-e', 'process.exit(1)'], package: null },
  ] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  await registry.refreshVersions();
  const entry = registry.versions.get('anthropic');
  assert.equal(entry.installed, '1.2.3');
  const probedAt = entry.installedAt;

  await registry.refreshVersions();
  assert.equal(registry.versions.get('anthropic').installedAt, probedAt, 'a fresh probe is not repeated');

  entry.installedAt -= 2 * 60 * 60 * 1000;
  await registry.refreshVersions();
  assert.ok(registry.versions.get('anthropic').installedAt > probedAt, 'an hour-old probe is repeated');

  const later = registry.versions.get('anthropic').installedAt;
  registry.versions.get('anthropic').installedMtime = 0;
  await registry.refreshVersions();
  assert.ok(registry.versions.get('anthropic').installedAt > later, 'a changed file is probed again');

  const failed = registry.versions.get('openai');
  assert.equal(failed.installed, null);
  failed.installedAt -= 6 * 60 * 1000;
  const failedAt = failed.installedAt;
  await registry.refreshVersions();
  assert.ok(registry.versions.get('openai').installedAt > failedAt, 'a failed probe is retried after a few minutes');
});

test('usage credentials are read from the tools\' own sign-in files', async () => {
  const dir = tempDir();
  const claudeFile = path.join(dir, '.credentials.json');
  await assert.rejects(readClaudeCredentials({ file: claudeFile, keychain: false }), /not signed in/);
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60000, subscriptionType: 'max' } }));
  assert.deepEqual(await readClaudeCredentials({ file: claudeFile, keychain: false }), { accessToken: 'tok', plan: 'max' });
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1 } }));
  await assert.rejects(readClaudeCredentials({ file: claudeFile, keychain: false }), /expired/);
  fs.writeFileSync(claudeFile, JSON.stringify({}));
  await assert.rejects(readClaudeCredentials({ file: claudeFile, keychain: false }), /API key/);

  const codexFile = path.join(dir, 'auth.json');
  await assert.rejects(readCodexCredentials({ file: codexFile }), /not signed in/);
  fs.writeFileSync(codexFile, JSON.stringify({ tokens: { access_token: 'ctok', account_id: 'acc-1' } }));
  assert.deepEqual(await readCodexCredentials({ file: codexFile }), { accessToken: 'ctok', accountId: 'acc-1' });
});

test('the macOS keychain item follows CLAUDE_CONFIG_DIR, so accounts stay apart', async () => {
  const workDir = '/Users/me/.claude-work';
  const workHash = crypto.createHash('sha256').update(workDir).digest('hex').slice(0, 8);
  assert.equal(claudeKeychainService({}), 'Claude Code-credentials');
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: '' }), 'Claude Code-credentials');
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: workDir }), `Claude Code-credentials-${workHash}`);

  // CLAUDE_SECURESTORAGE_CONFIG_DIR wins when defined; empty means the default account.
  const otherDir = '/Users/me/.claude-other';
  const otherHash = crypto.createHash('sha256').update(otherDir).digest('hex').slice(0, 8);
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: workDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), 'Claude Code-credentials');
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: workDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: otherDir }), `Claude Code-credentials-${otherHash}`);
  assert.equal(claudeKeychainService({ CLAUDE_SECURESTORAGE_CONFIG_DIR: otherDir }), `Claude Code-credentials-${otherHash}`);
  const home = path.join(os.homedir(), '.claude', '.credentials.json');
  assert.equal(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: workDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), home);
  assert.equal(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: workDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: otherDir }), path.join(otherDir, '.credentials.json'));
  assert.equal(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: workDir }), path.join(workDir, '.credentials.json'));

  // Decomposed and composed spellings of one path name the same item.
  const composed = '/Users/me/.claude-résumé';
  const decomposed = '/Users/me/.claude-résumé';
  assert.notEqual(composed, decomposed);
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: decomposed }), claudeKeychainService({ CLAUDE_CONFIG_DIR: composed }));
  assert.equal(claudeKeychainService({ CLAUDE_SECURESTORAGE_CONFIG_DIR: decomposed }), claudeKeychainService({ CLAUDE_CONFIG_DIR: composed }));
  assert.equal(claudeCredentialsFile({ CLAUDE_CONFIG_DIR: decomposed }), path.join(composed, '.credentials.json'));

  const items = {
    'Claude Code-credentials': JSON.stringify({ claudeAiOauth: { accessToken: 'personal', subscriptionType: 'pro' } }),
    [`Claude Code-credentials-${workHash}`]: JSON.stringify({ claudeAiOauth: { accessToken: 'work', subscriptionType: 'max' } }),
  };
  const readKeychain = async (service) => items[service] ?? null;
  const missing = path.join(tempDir(), '.credentials.json');
  const personal = await readClaudeCredentials({ file: missing, keychain: true, readKeychain });
  assert.deepEqual(personal, { accessToken: 'personal', plan: 'pro' });
  const work = await readClaudeCredentials({ file: missing, keychain: true, service: claudeKeychainService({ CLAUDE_CONFIG_DIR: workDir }), readKeychain });
  assert.deepEqual(work, { accessToken: 'work', plan: 'max' });
  await assert.rejects(readClaudeCredentials({ file: missing, keychain: true, service: 'Claude Code-credentials-00000000', readKeychain }), /not signed in/);
});

test('usage endpoints are called with the right headers and parsed into windows', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (url.includes('anthropic')) {
      return { ok: true, json: async () => ({ five_hour: { utilization: 42.55, resets_at: '2030-01-01T05:00:00Z' }, seven_day: { utilization: 12, resets_at: 1893456000 }, seven_day_opus: null }) };
    }
    return { ok: true, json: async () => ({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1893456000 }, secondaryWindow: { usedPercent: 80, limitWindowSeconds: 604800, resetAfterSeconds: 60 } } }) };
  };
  const claude = await fetchClaudeUsage({ accessToken: 'tok', plan: 'max', version: '2.1.0', fetchImpl });
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen[0].headers['User-Agent'], 'claude-code/2.1.0');
  assert.deepEqual(claude, { plan: 'max', windows: [
    { label: '5-hour', usedPercent: 42.6, resetsAt: '2030-01-01T05:00:00.000Z' },
    { label: '7-day', usedPercent: 12, resetsAt: '2030-01-01T00:00:00.000Z' },
  ] });

  const codex = await fetchCodexUsage({ accessToken: 'ctok', accountId: 'acc-1', fetchImpl });
  assert.equal(seen[1].headers['ChatGPT-Account-Id'], 'acc-1');
  assert.equal(codex.plan, 'plus');
  assert.equal(codex.windows.length, 2);
  assert.deepEqual(codex.windows[0], { label: '5-hour', usedPercent: 30, resetsAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(codex.windows[1].label, '7-day');
  assert.equal(codex.windows[1].usedPercent, 80);
  assert.ok(Date.parse(codex.windows[1].resetsAt) - Date.now() > 50000);

  await assert.rejects(fetchClaudeUsage({ accessToken: 'x', fetchImpl: async () => ({ ok: false, status: 401 }) }), /sign in again/);
  await assert.rejects(fetchCodexUsage({ accessToken: 'x', fetchImpl: async () => ({ ok: false, status: 429 }) }), (err) => err.rateLimited === true);

  assert.equal(toIso(1893456000), '2030-01-01T00:00:00.000Z');
  assert.equal(toIso('1893456000000'), '2030-01-01T00:00:00.000Z');
  assert.equal(toIso('nonsense'), null);
  assert.equal(windowLabel(18000), '5-hour');
  assert.equal(windowLabel(604800), '7-day');
});

test('a usage command prints JSON, and the monitor caches snapshots', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-usage.mjs');
  const env = { PATH: path.dirname(process.execPath) };
  const report = await commandUsage({ command: process.execPath, args: [fixture] }, env);
  assert.equal(report.plan, 'test');
  assert.equal(report.windows.length, 2);
  await assert.rejects(commandUsage({ command: 'no-such-usage-tool', args: [] }, env), /not found/);

  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', env: { CLAUDE_CONFIG_DIR: path.join(dir, 'claude-work') } },
    { id: 'openai' },
    { id: 'google', usage: { command: process.execPath, args: [fixture] } },
  ] }));
  const defaults = loadProviders({ platform: 'linux' }).providers;
  assert.equal(defaults.find((p) => p.id === 'anthropic').usage, 'claude');
  assert.equal(defaults.find((p) => p.id === 'openai').usage, 'codex');
  const registry = new ProviderRegistry({ userFile, env, checkUpdates: false });
  let fetches = 0;
  const files = {};
  const monitor = new UsageMonitor({
    registry,
    env: { ...env, CODEX_HOME: path.join(dir, 'codex-home') },
    fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ five_hour: { utilization: 5 } }) }; },
    readers: {
      claude: async ({ file, service }) => { files.claude = file; files.claudeService = service; return { accessToken: 'tok', plan: 'pro' }; },
      codex: async ({ file }) => { files.codex = file; throw new Error('boom'); },
    },
  });
  const first = await monitor.all();
  const byId = Object.fromEntries(first.map((u) => [u.providerId, u]));
  assert.deepEqual(byId.anthropic.windows, [{ label: '5-hour', usedPercent: 5, resetsAt: null }]);
  assert.equal(byId.anthropic.plan, 'pro');
  assert.match(byId.openai.error, /usage check failed: boom/);
  assert.equal(byId.google.plan, 'test');
  assert.equal(files.claude, path.join(dir, 'claude-work', '.credentials.json'), "the provider's own env picks its credentials");
  assert.equal(files.claudeService, claudeKeychainService({ CLAUDE_CONFIG_DIR: path.join(dir, 'claude-work') }), 'and its keychain item');
  assert.equal(files.codex, path.join(dir, 'codex-home', 'auth.json'), 'the manager env applies otherwise');
  await monitor.all();
  assert.equal(fetches, 1, 'a fresh snapshot is served from the cache');
});

test('loadProviders survives a broken user file', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, '{ not json');
  const { providers, warnings } = loadProviders({ userFile });
  assert.ok(providers.some((p) => p.id === 'anthropic'));
  assert.equal(warnings.length, 1);
});

test('defaultShell picks a platform shell', () => {
  assert.equal(defaultShell({}, 'win32'), 'powershell.exe');
  assert.equal(defaultShell({}, 'darwin'), '/bin/zsh');
  assert.equal(defaultShell({ SHELL: '/usr/bin/fish' }, 'linux'), '/usr/bin/fish');
});

test('claudeHookToReport maps sub-agent tool calls and subagent events', () => {
  const pre = claudeHookToReport({
    hook_event_name: 'PreToolUse', tool_name: 'Task',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  const post = claudeHookToReport({
    hook_event_name: 'PostToolUse', tool_name: 'Task',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  assert.equal(pre.status, 'working');
  assert.equal(pre.name, 'Explore');
  assert.equal(pre.detail, 'Search the codebase');
  assert.equal(post.status, 'done');
  assert.equal(pre.agentId, post.agentId, 'pre and post events must refer to the same agent');

  const withId = claudeHookToReport({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: {} });
  assert.equal(withId.agentId, 'claude-task-toolu_1');

  assert.deepEqual(claudeHookToReport({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Plan' }),
    { agentId: 'claude-a1', name: 'Plan', kind: 'subagent', status: 'working' });
  assert.equal(claudeHookToReport({ hook_event_name: 'SubagentStop', agent_id: 'a1' }).status, 'done');
  assert.equal(claudeHookToReport({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), null);
  assert.equal(claudeHookToReport({ hook_event_name: 'SubagentStop' }), null);
  // Background launches return at once, so the tool-call style cannot tell when they end.
  assert.equal(claudeHookToReport({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { run_in_background: true } }), null);
  assert.equal(claudeHookToReport({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { run_in_background: true } }), null);
});

test('Claude Code hooks and the status line report the model', () => {
  assert.deepEqual(claudeHookToReport({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }), { model: 'claude-opus-5' });
  assert.equal(claudeHookToReport({ hook_event_name: 'SessionStart', source: 'startup' }), null);
  assert.deepEqual(claudeHookToReport({ hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'claude-sonnet-5' }), { model: 'claude-sonnet-5' });
  assert.equal(claudeHookToReport({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), null);

  const input = { model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' }, workspace: { current_dir: '/home/me/app' }, context_window: { used_percentage: 41.7 } };
  assert.deepEqual(claudeStatuslineToReport(input), { model: 'claude-opus-4-5', displayName: 'Opus 4.5' });
  assert.equal(claudeStatuslineToReport({ model: {} }), null);
  assert.equal(formatStatusLine(input), '[Opus 4.5] | app | 42% context');
  assert.equal(formatStatusLine({ model: { id: 'x' } }), '[x]');
  assert.equal(formatStatusLine(null), '');

  assert.equal(modelFromArgs(['--model', 'opus']), 'opus');
  assert.equal(modelFromArgs(['-p', '--model=gpt-5-codex']), 'gpt-5-codex');
  assert.equal(modelFromArgs(['-m', 'gemini-2.5-pro', 'x']), 'gemini-2.5-pro');
  assert.equal(modelFromArgs(['--model']), null);
  assert.equal(modelFromArgs([]), null);
});

test('ensurePtyReady restores the macOS spawn-helper executable bit', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  const helper = spawnHelperCandidates(dir, 'arm64')[0];
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '', { mode: 0o644 });
  const original = process.arch;
  Object.defineProperty(process, 'arch', { value: 'arm64' });
  try {
    ensurePtyReady({ platform: 'darwin', ptyDir: dir });
  } finally {
    Object.defineProperty(process, 'arch', { value: original });
  }
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
});

test('parsePathFromEnvOutput reads PATH from env output of any shell', () => {
  const START = '__AGENT_GUILD_PATH_START__';
  const END = '__AGENT_GUILD_PATH_END__';
  // Interactive shells may print banners before the markers.
  const out = `Welcome to fish\n${START}HOME=/Users/a\nPATH=/opt/homebrew/bin:/usr/bin\nSHELL=/opt/homebrew/bin/fish\n${END}`;
  assert.equal(parsePathFromEnvOutput(out), '/opt/homebrew/bin:/usr/bin');
  assert.equal(parsePathFromEnvOutput(`${START}PATH=/a:/b${END}`), '/a:/b');
  assert.equal(parsePathFromEnvOutput('no markers'), null);
  assert.equal(parsePathFromEnvOutput(`${START}HOME=/x\n${END}`), null);
});

test('mergeEnv replaces variables case-insensitively on Windows', () => {
  const win = mergeEnv([{ Path: 'C:\\a', HOME: 'x' }, { PATH: 'C:\\b', N: 1, B: true, U: undefined }], 'win32');
  assert.deepEqual(win, { HOME: 'x', PATH: 'C:\\b', N: '1', B: 'true' });
  const posix = mergeEnv([{ Path: '/a' }, { PATH: '/b' }], 'linux');
  assert.deepEqual(posix, { Path: '/a', PATH: '/b' });
});

test('provider env values are normalised to strings', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{ id: 'anthropic', env: { A: 1, B: true, C: { x: 1 }, D: 'd' } }] }));
  const { providers } = loadProviders({ userFile, platform: 'linux' });
  assert.deepEqual(providers[0].env, { A: '1', B: 'true', D: 'd' });
});
