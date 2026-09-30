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
import { hookToReports, claudeStatuslineToReport, formatStatusLine } from '../src/report/hooks.mjs';
import { shimContents, writeReportShims, prependPath, fileUrl, SHIM_NAME, LOADER_NAME } from '../src/manager/report-shims.mjs';
import { execFileSync } from 'node:child_process';
import { parseVersion, compareVersions, installedVersion, latestVersion } from '../src/manager/versions.mjs';
import {
  UsageMonitor, readClaudeCredentials, readCodexCredentials, readGeminiCredentials, geminiOAuthClientFromInstall, geminiKeychainLookup,
  claudeKeychainService, claudeCredentialsFile, fetchClaudeUsage, fetchCodexUsage, fetchGeminiUsage, commandUsage, toIso, windowLabel,
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
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  assert.equal((await readClaudeCredentials({ file: claudeFile, keychain: false })).plan, 'max 20x');
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' } }));
  assert.equal((await readClaudeCredentials({ file: claudeFile, keychain: false })).plan, 'pro');
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', rateLimitTier: 'default_claude_max_5x' } }));
  assert.equal((await readClaudeCredentials({ file: claudeFile, keychain: false })).plan, null);
  fs.writeFileSync(claudeFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1 } }));
  await assert.rejects(readClaudeCredentials({ file: claudeFile, keychain: false }), /expired/);
  fs.writeFileSync(claudeFile, JSON.stringify({}));
  await assert.rejects(readClaudeCredentials({ file: claudeFile, keychain: false }), /API key/);

  const codexFile = path.join(dir, 'auth.json');
  await assert.rejects(readCodexCredentials({ file: codexFile }), /not signed in/);
  fs.writeFileSync(codexFile, JSON.stringify({ tokens: { access_token: 'ctok', account_id: 'acc-1' } }));
  assert.deepEqual(await readCodexCredentials({ file: codexFile }), { accessToken: 'ctok', accountId: 'acc-1' });
});

test('Gemini CLI credentials come from the keychain item or the legacy file, and usage from Code Assist', async () => {
  const dir = tempDir();
  const legacyFile = path.join(dir, 'oauth_creds.json');
  const none = async () => null;
  await assert.rejects(readGeminiCredentials({ file: legacyFile, platform: 'linux', readKeychain: none }), /not signed in/);
  const fakeClient = { id: '12345-abc.apps.googleusercontent.com', secret: 'GOCSPX-fake' };
  fs.writeFileSync(legacyFile, JSON.stringify({ access_token: 'legacy', refresh_token: 'r1', expiry_date: 1893456000000, client_id: fakeClient.id, client_secret: fakeClient.secret }));
  assert.deepEqual(await readGeminiCredentials({ file: legacyFile, platform: 'linux', readKeychain: none }),
    { accessToken: 'legacy', refreshToken: 'r1', expiresAt: 1893456000000, client: fakeClient });
  const item = JSON.stringify({ serverName: 'main-account', token: { accessToken: 'kc', refreshToken: 'r2', expiresAt: 1893456000000, tokenType: 'Bearer' } });
  assert.deepEqual(await readGeminiCredentials({ file: legacyFile, platform: 'darwin', readKeychain: async () => item }),
    { accessToken: 'kc', refreshToken: 'r2', expiresAt: 1893456000000, client: null }, 'the keychain item wins over the legacy file');
  await assert.rejects(readGeminiCredentials({ file: legacyFile, platform: 'darwin', readKeychain: async () => 'not json' }), /parsed/);
  // keytar, which Gemini CLI stores through, labels libsecret items with "service" and "account".
  assert.deepEqual(geminiKeychainLookup('linux'), { file: 'secret-tool', args: ['lookup', 'service', 'gemini-cli-oauth', 'account', 'main-account'] });
  assert.deepEqual(geminiKeychainLookup('darwin').args, ['find-generic-password', '-s', 'gemini-cli-oauth', '-a', 'main-account', '-w']);
  assert.equal(geminiKeychainLookup('win32'), null);

  // The OAuth client that refreshes the token is read from the installed Gemini CLI.
  const install = path.join(dir, 'node_modules', '@google', 'gemini-cli');
  fs.mkdirSync(path.join(install, 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'bundle/gemini.js' } }));
  fs.writeFileSync(path.join(install, 'bundle', 'gemini.js'), 'import "./chunk-abc.js";\n');
  fs.writeFileSync(path.join(install, 'bundle', 'chunk-abc.js'), `var OAUTH_CLIENT_ID = "${fakeClient.id}";\nvar OAUTH_CLIENT_SECRET = "${fakeClient.secret}";\n`);
  const shim = path.join(dir, 'gemini.cmd');
  fs.writeFileSync(shim, '@"%~dp0\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n');
  assert.deepEqual(geminiOAuthClientFromInstall(shim), fakeClient, 'a Windows npm shim leads to the package next to it');
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'gemini');
    fs.symlinkSync(path.join(install, 'bundle', 'gemini.js'), link);
    assert.deepEqual(geminiOAuthClientFromInstall(link), fakeClient, 'a symlinked bin leads to its package');
  }
  assert.equal(geminiOAuthClientFromInstall(path.join(dir, 'missing')), null);
  assert.equal(geminiOAuthClientFromInstall(process.execPath), null, 'other programs have no Gemini client');

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.Authorization });
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3599 }) };
    if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier', name: 'Free' } }) };
    if (url.endsWith(':retrieveUserQuota')) {
      return { ok: true, json: async () => ({ buckets: [
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2030-01-01T00:00:00Z', tokenType: 'REQUESTS' },
        { modelId: 'gemini-2.5-flash', remainingFraction: 1 },
        { remainingFraction: 0.5 },
      ] }) };
    }
    return { ok: false, status: 404 };
  };
  const expired = await fetchGeminiUsage({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000, client: fakeClient, fetchImpl });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0].body, /grant_type=refresh_token/);
  assert.match(calls[0].body, /client_id=12345-abc\.apps\.googleusercontent\.com/);
  assert.equal(calls[1].auth, 'Bearer fresh', 'the refreshed token is used');
  assert.match(calls[1].body, /"pluginType":"GEMINI"/);
  assert.deepEqual(JSON.parse(calls[2].body), { project: 'proj-1' });
  assert.equal(expired.plan, 'Free');
  assert.equal(expired.project, 'proj-1');
  assert.equal(expired.token.accessToken, 'fresh');
  assert.deepEqual(expired.windows, [
    { label: 'gemini-2.5-pro', usedPercent: 75, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: 'gemini-2.5-flash', usedPercent: 0, resetsAt: null },
  ]);

  calls.length = 0;
  const known = await fetchGeminiUsage({ accessToken: 'kc', expiresAt: Date.now() + 3600000, project: 'proj-1', fetchImpl });
  assert.deepEqual(calls.map((c) => c.url.split(':').pop()), ['retrieveUserQuota'], 'a known project skips the refresh and the project lookup');
  assert.equal(known.plan, null);

  // A paid tier is the subscription in force, as Gemini CLI reads it; an empty one is not.
  const tiered = (paidTier) => async (url) => (url.endsWith(':loadCodeAssist')
    ? { ok: true, json: async () => ({ cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier', name: 'Free' }, paidTier }) }
    : { ok: true, json: async () => ({ buckets: [] }) });
  assert.equal((await fetchGeminiUsage({ accessToken: 'kc', fetchImpl: tiered({ id: 'standard-tier', name: 'Google AI Pro' }) })).plan, 'Google AI Pro');
  assert.equal((await fetchGeminiUsage({ accessToken: 'kc', fetchImpl: tiered({ id: 'standard-tier' }) })).plan, 'standard-tier');
  assert.equal((await fetchGeminiUsage({ accessToken: 'kc', fetchImpl: tiered({}) })).plan, 'Free');

  await assert.rejects(fetchGeminiUsage({ accessToken: 'old', expiresAt: Date.now() - 1000, fetchImpl }), /expired/);
  await assert.rejects(fetchGeminiUsage({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000, fetchImpl }), /expired/, 'no client, no refresh');
  await assert.rejects(fetchGeminiUsage({ accessToken: 'x', fetchImpl: async (url) => (url.endsWith(':loadCodeAssist') ? { ok: true, json: async () => ({}) } : { ok: false, status: 404 }) }), /no Code Assist project/);
  await assert.rejects(fetchGeminiUsage({ accessToken: 'x', fetchImpl: async () => ({ ok: false, status: 401 }) }), /sign in again in Gemini CLI/);
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
    { id: 'xai', usage: 'gemini', env: { GOOGLE_CLOUD_PROJECT_ID: 'proj-env' } },
  ] }));
  const defaults = loadProviders({ platform: 'linux' }).providers;
  assert.equal(defaults.find((p) => p.id === 'anthropic').usage, 'claude');
  assert.equal(defaults.find((p) => p.id === 'openai').usage, 'codex');
  assert.equal(defaults.find((p) => p.id === 'google').usage, 'gemini');
  const xai = defaults.find((p) => p.id === 'xai');
  assert.equal(xai.package, '@xai-official/grok');
  assert.deepEqual(xai.resumeArgs, ['--resume', '{id}']);
  assert.deepEqual(xai.versionArgs, ['--version']);
  assert.match('using grok-build now', new RegExp(xai.modelPattern, 'i'));
  assert.match('grok-4-1-fast', new RegExp(xai.modelPattern, 'i'));
  const registry = new ProviderRegistry({ userFile, env, checkUpdates: false });
  let fetches = 0;
  const urls = [];
  const files = {};
  const monitor = new UsageMonitor({
    registry,
    env: { ...env, CODEX_HOME: path.join(dir, 'codex-home') },
    fetchImpl: async (url) => {
      fetches++;
      urls.push(url);
      if (url.endsWith(':retrieveUserQuota')) return { ok: true, json: async () => ({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.9 }] }) };
      return { ok: true, json: async () => ({ five_hour: { utilization: 5 } }) };
    },
    readers: {
      claude: async ({ file, service }) => { files.claude = file; files.claudeService = service; return { accessToken: 'tok', plan: 'pro' }; },
      codex: async ({ file }) => { files.codex = file; throw new Error('boom'); },
      gemini: async () => ({ accessToken: 'g', refreshToken: null, expiresAt: Date.now() + 3600000 }),
    },
  });
  const first = await monitor.all();
  const byId = Object.fromEntries(first.map((u) => [u.providerId, u]));
  assert.deepEqual(byId.anthropic.windows, [{ label: '5-hour', usedPercent: 5, resetsAt: null }]);
  assert.equal(byId.anthropic.plan, 'pro');
  assert.match(byId.openai.error, /usage check failed: boom/);
  assert.equal(byId.google.plan, 'test');
  assert.deepEqual(byId.xai.windows, [{ label: 'gemini-2.5-pro', usedPercent: 10, resetsAt: null }]);
  assert.ok(!urls.some((u) => u.endsWith(':loadCodeAssist')), "a project from the provider's env (either variable Gemini CLI reads) skips the project lookup");
  assert.equal(files.claude, path.join(dir, 'claude-work', '.credentials.json'), "the provider's own env picks its credentials");
  assert.equal(files.claudeService, claudeKeychainService({ CLAUDE_CONFIG_DIR: path.join(dir, 'claude-work') }), 'and its keychain item');
  assert.equal(files.codex, path.join(dir, 'codex-home', 'auth.json'), 'the manager env applies otherwise');
  await monitor.all();
  assert.equal(fetches, 2, 'fresh snapshots are served from the cache');
});

test('Gemini usage keeps its refreshed token and project only while the sign-in is the same', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{ id: 'anthropic', usage: null }, { id: 'openai', usage: null }] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: '' }, checkUpdates: false });
  const google = registry.providers.find((p) => p.id === 'google');
  const client = { id: '12345-abc.apps.googleusercontent.com', secret: 'GOCSPX-fake' };
  let creds = { accessToken: 'a-old', refreshToken: 'r-a', expiresAt: Date.now() - 1000, client };
  let refreshes = 0;
  const calls = [];
  const monitor = new UsageMonitor({
    registry,
    env: { PATH: '' },
    ttlMs: 0,
    readers: { gemini: async () => creds },
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split(/[:/]/).pop(), auth: init.headers.Authorization, body: init.body });
      if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: `a-fresh-${++refreshes}`, expires_in: 3600 }) };
      if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: init.headers.Authorization.includes('b-') ? 'proj-b' : 'proj-a', currentTier: { name: 'Free' } }) };
      return { ok: true, json: async () => ({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }] }) };
    },
  });

  assert.equal((await monitor.snapshot(google)).plan, 'Free');
  assert.deepEqual(calls.map((c) => c.method), ['token', 'loadCodeAssist', 'retrieveUserQuota']);
  calls.length = 0;
  assert.equal((await monitor.snapshot(google)).plan, 'Free');
  assert.deepEqual(calls.map((c) => [c.method, c.auth]), [['retrieveUserQuota', 'Bearer a-fresh-1']], 'the same sign-in reuses the refreshed token and project');

  calls.length = 0;
  creds = { accessToken: 'b-live', refreshToken: 'r-b', expiresAt: Date.now() + 3600000, client };
  const other = await monitor.snapshot(google);
  assert.deepEqual(calls.map((c) => [c.method, c.auth]), [['loadCodeAssist', 'Bearer b-live'], ['retrieveUserQuota', 'Bearer b-live']], 'another sign-in drops the old token and project');
  assert.deepEqual(JSON.parse(calls[1].body), { project: 'proj-b' });
  assert.equal(other.error, null);
});

test('console links are https URLs that users can override per platform or turn off', () => {
  const defaults = loadProviders({ platform: 'linux' });
  assert.deepEqual(defaults.warnings, []);
  for (const provider of defaults.providers.filter((p) => p.id !== 'shell')) {
    assert.match(provider.usageUrl, /^https:\/\//, `${provider.id} usageUrl`);
    assert.match(provider.billingUrl, /^https:\/\//, `${provider.id} billingUrl`);
  }
  const shell = defaults.providers.find((p) => p.id === 'shell');
  assert.equal(shell.usageUrl, null);
  assert.equal(shell.billingUrl, null);

  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({
    providers: [
      { id: 'anthropic', usageUrl: 'https://platform.claude.com/usage', billingUrl: null, darwin: { usageUrl: 'https://example.com/mac' } },
      { id: 'openai', usageUrl: 'javascript:alert(1)', billingUrl: 'http://example.com/billing' },
      { id: 'google', usageUrl: 'not a url', billingUrl: '' },
    ],
  }));
  const linux = loadProviders({ userFile, platform: 'linux' });
  const byId = Object.fromEntries(linux.providers.map((p) => [p.id, p]));
  assert.equal(byId.anthropic.usageUrl, 'https://platform.claude.com/usage');
  assert.equal(byId.anthropic.billingUrl, null);
  assert.equal(byId.openai.usageUrl, null);
  assert.equal(byId.openai.billingUrl, null);
  assert.equal(byId.google.usageUrl, null);
  assert.equal(byId.google.billingUrl, null);
  assert.equal(byId.xai.usageUrl, loadProviders({ platform: 'linux' }).providers.find((p) => p.id === 'xai').usageUrl);
  assert.equal(linux.warnings.length, 3);
  assert.ok(linux.warnings.every((w) => /must be an https:\/\/ URL/.test(w)));
  assert.equal(loadProviders({ userFile, platform: 'darwin' }).providers[0].usageUrl, 'https://example.com/mac');
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

test('hook events map to agent reports for every tool\'s spelling', () => {
  const [pre] = hookToReports({
    hook_event_name: 'PreToolUse', tool_name: 'Task',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  const [post] = hookToReports({
    hook_event_name: 'PostToolUse', tool_name: 'Task',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  assert.equal(pre.status, 'working');
  assert.equal(pre.name, 'Explore');
  assert.equal(pre.detail, 'Search the codebase');
  assert.equal(pre.foreground, false, 'Claude Code reports the main model itself, so no guard is needed');
  assert.equal(post.status, 'done');
  assert.equal(pre.agentId, post.agentId, 'pre and post events must refer to the same agent');

  const [withId] = hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: {} });
  assert.equal(withId.agentId, 'hook-task-toolu_1');
  // Esc during the call fires PostToolUseFailure instead of PostToolUse.
  const [failed] = hookToReports({ hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: {}, error: 'interrupted', is_interrupt: true });
  assert.deepEqual([failed.agentId, failed.status], ['hook-task-toolu_1', 'done']);

  // Claude Code
  assert.deepEqual(hookToReports({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Plan' }),
    [{ agentId: 'hook-a1', name: 'Plan', kind: 'subagent', status: 'working' }]);
  assert.equal(hookToReports({ hook_event_name: 'SubagentStop', agent_id: 'a1' })[0].status, 'done');
  // Codex CLI: same names, plus the model on every event, which sub-agent events must not report as the main model
  assert.deepEqual(hookToReports({ hook_event_name: 'SubagentStart', turn_id: 't', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex' }),
    [{ agentId: 'hook-c1', name: 'explorer', kind: 'subagent', status: 'working' }]);
  // Codex CLI ends every turn of a sub-agent with SubagentStop; the next prompt inside it starts a new turn.
  assert.equal(hookToReports({ hook_event_name: 'SubagentStop', turn_id: 't2', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex' })[0].status, 'done');
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', turn_id: 't3', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex', prompt: 'next task' }),
    [{ agentId: 'hook-c1', name: 'explorer', kind: 'subagent', status: 'working' }], 'a re-tasked Codex sub-agent works again, and its model stays its own');
  // With multi_agent_v2, a follow-up turn fires no prompt event; its tool calls carry the agent and Codex's turn_id.
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', turn_id: 't4', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex', tool_name: 'shell', tool_input: { command: ['ls'] } }),
    [{ agentId: 'hook-c1', name: 'explorer', kind: 'subagent', status: 'working' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', agent_id: 'internal-1', tool_name: 'Bash', tool_input: {} }), [], 'a Claude Code helper\'s tool call has no turn_id and is not an agent');
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', model: 'gpt-5-codex', prompt: 'main' }), [{ finishForeground: true }, { model: 'gpt-5-codex' }], 'a main-thread prompt is not an agent');
  // Grok Build: camelCase fields and a snake_case event name beside the PascalCase one
  assert.deepEqual(hookToReports({ hookEventName: 'subagent_stop', hook_event_name: 'SubagentStop', subagentId: 'g1', subagentType: 'reviewer', modelId: 'grok-build' }),
    [{ agentId: 'hook-g1', name: 'reviewer', kind: 'subagent', status: 'done' }]);
  assert.equal(hookToReports({ hookEventName: 'subagentStart', subagentId: 'g2' })[0].status, 'working', 'camelCase event names are accepted too');
  // Grok Build sends the task description with SubagentStart, as it really spells the event (both keys present).
  assert.deepEqual(hookToReports({ hookEventName: 'subagent_start', hook_event_name: 'SubagentStart', sessionId: 'parent', subagentId: 'g3', subagentType: 'explore', description: 'Read b.txt contents' }),
    [{ agentId: 'hook-g3', name: 'explore', kind: 'subagent', status: 'working', detail: 'Read b.txt contents' }]);
  // A cancelled Grok sub-agent never fires SubagentStop; the SessionEnd of its own session names it.
  assert.deepEqual(hookToReports({ hookEventName: 'session_end', hook_event_name: 'SessionEnd', sessionId: 'g3', session_id: 'g3', subagentType: 'explore', reason: 'shutdown' }),
    [{ agentId: 'hook-g3', name: 'explore', kind: 'subagent', status: 'done' }]);
  assert.deepEqual(hookToReports({ hookEventName: 'session_end', hook_event_name: 'SessionEnd', sessionId: 'parent', session_id: 'parent', reason: 'channel_closed' }), [], 'the main session ending is not an agent');
  assert.deepEqual(hookToReports({ hookEventName: 'stop_cancelled', hook_event_name: 'StopCancelled', sessionId: 'g4', session_id: 'g4', subagentType: 'plan', reason: 'max_turns', cancelledBy: 'runtime' }),
    [{ agentId: 'hook-g4', name: 'plan', kind: 'subagent', status: 'done' }], 'a sub-agent cut off at its turn limit is done');
  assert.deepEqual(hookToReports({ hookEventName: 'stop_cancelled', hook_event_name: 'StopCancelled', sessionId: 'parent', session_id: 'parent', reason: 'user_interrupt', cancelledBy: 'user' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'exit', agent_type: 'security-reviewer' }), [], 'a Claude Code --agent session ending is not an agent either');
  assert.deepEqual(hookToReports({ cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other', session_id: 's', transcript_path: null }), [], 'Codex SessionEnd is root-only');
  assert.deepEqual(hookToReports({ session_id: 's', cwd: '/w', hook_event_name: 'SessionEnd', timestamp: 't', reason: 'exit' }), [], 'Gemini SessionEnd names no agent');
  // Gemini CLI has no sub-agent events; the invoke_agent tool call brackets each sub-agent run.
  const gi = { agent_name: 'codebase_investigator', prompt: 'Map the auth flow' };
  const [gb] = hookToReports({ hook_event_name: 'BeforeTool', session_id: 'g', timestamp: '2026-09-30T00:00:00Z', tool_name: 'invoke_agent', tool_input: gi });
  const [ga] = hookToReports({ hook_event_name: 'AfterTool', session_id: 'g', timestamp: '2026-09-30T00:00:01Z', tool_name: 'invoke_agent', tool_input: gi, tool_response: { llmContent: 'ok', returnDisplay: 'ok' } });
  assert.equal(gb.status, 'working');
  assert.equal(gb.name, 'codebase_investigator');
  assert.equal(gb.detail, 'Map the auth flow');
  assert.equal(gb.foreground, true);
  assert.equal(gb.agentId, ga.agentId, 'BeforeTool and AfterTool carry the same tool_input, so they name the same agent');
  assert.equal(ga.status, 'done');
  assert.deepEqual(hookToReports({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { path: 'x' } }), []);
  // A cancelled or denied invoke_agent gets no AfterTool; the parent's turn boundaries close what is left.
  assert.deepEqual(hookToReports({ hook_event_name: 'BeforeAgent', session_id: 'g', prompt: 'next' }), [{ finishForeground: true }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'AfterAgent', session_id: 'g', prompt: 'p', prompt_response: 'r', stop_hook_active: false }), [{ finishForeground: true }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', session_id: 'c', stop_hook_active: false }), [{ finishForeground: true }], 'a main-thread Stop is a turn boundary too');
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'SubagentStop' }), []);
  assert.deepEqual(hookToReports(null), []);
  // Background launches return at once, so the tool-call style cannot tell when they end.
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { run_in_background: true } }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { run_in_background: true } }), []);
});

test('the agent-guild-report launchers run the reporter from any hook shell', () => {
  const script = '/opt/agent guild/bin/agent-guild-report.mjs';
  const posix = shimContents({ execPath: '/usr/local/n$v/node', script, platform: 'linux' });
  assert.deepEqual(Object.keys(posix), [SHIM_NAME]);
  assert.equal(posix[SHIM_NAME], '#!/bin/sh\nn="/usr/local/n\\$v/node"\n[ -x "$n" ] || n=node\nexec "$n" "/opt/agent guild/bin/agent-guild-report.mjs" "$@"\n');

  const winScript = 'C:\\Users\\José\\100%\\agent-guild\\bin\\agent-guild-report.mjs';
  const win = shimContents({ execPath: 'C:\\Program Files\\nodejs\\node.exe', script: winScript, platform: 'win32' });
  assert.deepEqual(Object.keys(win).sort(), [SHIM_NAME, LOADER_NAME, `${SHIM_NAME}.cmd`], 'no .ps1: PowerShell would prefer it and its default policy refuses it');
  assert.equal(win[SHIM_NAME], '#!/bin/sh\nn="C:/Program Files/nodejs/node.exe"\n[ -x "$n" ] || n=node\nexec "$n" "C:/Users/José/100%/agent-guild/bin/agent-guild-report.mjs" "$@"\n', 'Git Bash takes forward slashes');
  // cmd.exe reads the batch file in the OEM code page, so the paths stay out of it.
  assert.equal(win[`${SHIM_NAME}.cmd`], '@ECHO OFF\r\nIF EXIST "%AGENT_GUILD_NODE%" GOTO manager\r\nnode "%~dp0agent-guild-report-loader.mjs" %*\r\nEXIT /B %ERRORLEVEL%\r\n:manager\r\n"%AGENT_GUILD_NODE%" "%~dp0agent-guild-report-loader.mjs" %*\r\n');
  assert.equal(win[LOADER_NAME], 'import "file:///C:/Users/Jos%C3%A9/100%25/agent-guild/bin/agent-guild-report.mjs";\n');
  for (const name of [`${SHIM_NAME}.cmd`, LOADER_NAME]) assert.match(win[name], /^[\x20-\x7e\r\n]+$/, `${name} is ASCII`);
  assert.equal(fileUrl('/tmp/a b/#1/x.mjs', 'linux'), 'file:///tmp/a%20b/%231/x.mjs');

  assert.deepEqual(prependPath({ Path: 'C:\\a;C:\\b', HOME: 'x' }, 'C:\\shims', { platform: 'win32' }), { Path: 'C:\\shims;C:\\a;C:\\b', HOME: 'x' }, 'keeps the "Path" spelling');
  assert.deepEqual(prependPath({}, '/shims', { platform: 'linux' }), { PATH: '/shims' });
  assert.deepEqual(prependPath({ PATH: '/a:/shims:/b' }, '/shims', { platform: 'linux' }), { PATH: '/shims:/a:/b' }, 'no duplicate entry');
  assert.deepEqual(prependPath({ Path: 'x', PATH: '/a' }, '/shims', { platform: 'linux' }), { Path: 'x', PATH: '/shims:/a' }, 'names are case-sensitive outside Windows');
  assert.deepEqual(prependPath({ PATH: '/a' }, null), { PATH: '/a' });

  // Written for real, then run by name through the shells the tools use.
  const dir = path.join(tempDir(), 'bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${SHIM_NAME}.ps1`), 'stale');
  const reporter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/agent-guild-report.mjs');
  assert.equal(writeReportShims({ dir, script: reporter }), dir);
  assert.ok(!fs.existsSync(path.join(dir, `${SHIM_NAME}.ps1`)), 'a stale .ps1 is removed');
  const withNode = prependPath({ ...process.env, AGENT_GUILD_NODE: process.execPath }, dir);
  // The manager's Node.js is gone (a version manager removed it); `node` on PATH takes over.
  const nodeDir = path.join(tempDir(), 'node-on-path');
  fs.mkdirSync(nodeDir);
  const gone = path.join(tempDir(), 'removed', 'node');
  const run = (file, args, env) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (process.platform === 'win32') {
    const winArgs = [['cmd.exe', ['/d', '/s', '/c', `${SHIM_NAME} --help`], 'cmd.exe (Codex CLI) finds the .cmd through PATHEXT'],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `${SHIM_NAME} --help`], 'PowerShell (Gemini CLI, Grok Build) runs the .cmd under the Restricted policy']];
    for (const [file, args, why] of winArgs) assert.match(run(file, args, withNode), /^Usage: agent-guild-report/, why);
    fs.copyFileSync(process.execPath, path.join(nodeDir, 'node.exe'));
    const fallback = prependPath({ ...process.env, AGENT_GUILD_NODE: gone, Path: nodeDir }, dir);
    delete fallback.PATH;
    assert.match(run('cmd.exe', ['/d', '/s', '/c', `${SHIM_NAME} --help`], fallback), /^Usage: agent-guild-report/, 'falls back to node on PATH');
  } else {
    assert.ok((fs.statSync(path.join(dir, SHIM_NAME)).mode & 0o111) !== 0, 'the sh launcher is executable');
    assert.match(run('/bin/sh', ['-c', `${SHIM_NAME} --help`], withNode), /^Usage: agent-guild-report/, 'sh (Claude Code, Grok Build) runs the launcher');
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    writeReportShims({ dir, execPath: gone, script: reporter });
    assert.match(run('/bin/sh', ['-c', `${SHIM_NAME} --help`], { PATH: `${dir}:${nodeDir}` }), /^Usage: agent-guild-report/, 'falls back to node on PATH');
  }
});

test('hook events and the Claude Code status line report the model', () => {
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }), [{ model: 'claude-opus-5' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', source: 'startup' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'claude-sonnet-5' }), [{ model: 'claude-sonnet-5' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), [{ finishForeground: true }]);
  // Codex CLI names the model on every event; Gemini CLI inside BeforeModel's request; Grok Build as modelId.
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', model: 'gpt-5-codex', prompt: 'hi' }), [{ finishForeground: true }, { model: 'gpt-5-codex' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'BeforeModel', llm_request: { model: 'gemini-2.5-pro', messages: [] } }), [{ model: 'gemini-2.5-pro' }]);
  assert.deepEqual(hookToReports({ hookEventName: 'session_start', hook_event_name: 'SessionStart', modelId: 'grok-build' }), [{ model: 'grok-build' }]);
  // Turn events that fire inside a sub-agent name it, and its model is not the session's.
  assert.ok(!hookToReports({ hook_event_name: 'UserPromptSubmit', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex-mini', prompt: 'x' }).some((r) => r.model));
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', agent_id: 'a1', agent_type: 'Explore', model: 'claude-haiku-4-5' }), []);
  assert.deepEqual(hookToReports({ hookEventName: 'user_prompt_submit', hook_event_name: 'UserPromptSubmit', subagentType: 'reviewer', modelId: 'grok-build' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', agent_type: 'security-reviewer', model: 'claude-opus-5' }), [{ finishForeground: true }, { model: 'claude-opus-5' }], 'a session started with --agent is still the main session');
  // Grok Build's real SessionStart carries no model: the card uses the screen scan.
  assert.deepEqual(hookToReports({ hookEventName: 'session_start', hook_event_name: 'SessionStart', sessionId: 's', cwd: '/w', source: 'new' }), []);

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
