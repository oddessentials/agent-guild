import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, resolveAllCommands, buildSpawnSpec, quoteForCmd } from '../src/manager/command-resolver.mjs';
import { mergePathLists, parsePathFromEnvOutput, weavePaths, parseRegValue, expandWindowsVars, readWindowsPath, trimPathExt } from '../src/manager/shell-env.mjs';
import { mergeEnv, cleanResumeId, modelFromArgs, SessionManager } from '../src/manager/session-manager.mjs';
import { loadProviders, ProviderRegistry } from '../src/manager/providers.mjs';
import { detectShells, tmuxNewSession, tmuxSupported } from '../src/manager/shells.mjs';
import { herdrAgentReports, herdrSocket } from '../src/manager/herdr.mjs';
import { paths } from '../src/manager/config.mjs';
import { classifyInstall, expandHome, homeRelative, helpDescribes, platformDependency, listInstallations, knownLaunchers, updateHelpAccepted, uninstallPlan } from '../src/manager/install-channels.mjs';
import { runPlan, encodePlan, RUNNER } from '../src/manager/uninstall.mjs';
import { hookToReports, claudeStatuslineToReport, formatStatusLine } from '../src/report/hooks.mjs';
import { shimContents, writeReportShims, prependPath, fileUrl, SHIM_NAME, LOADER_NAME } from '../src/manager/report-shims.mjs';
import { bundleFiles, codexHookArgs, codexTrustArgs, codexHooksFrom, antigravityInstalled, antigravityPluginDir, antigravityConfigFile, antigravityPluginEnabled, helpLists, REPORT_COMMAND } from '../src/manager/session-hooks.mjs';
import { execFileSync } from 'node:child_process';
import { parseVersion, compareVersions, probeVersion, diagnosticLine, latestVersion } from '../src/manager/versions.mjs';
import { SelfUpdate, isDevelopmentBuild } from '../src/manager/self-update.mjs';
import { launcherPath, MANAGER_ENTRY, ROOT_DIR } from '../src/manager/launch.mjs';
import {
  UsageMonitor, readClaudeCredentials, readCodexCredentials,
  claudeKeychainService, claudeCredentialsFile, fetchClaudeUsage, fetchCodexUsage, commandUsage, toIso, windowLabel, clampPercent,
} from '../src/manager/usage.mjs';
import {
  ModelStats, parseCatalog, indexCatalog, standing, tierFor, providerModels, modelNames, resolveModel, describeCatalog,
} from '../src/manager/model-stats.mjs';
import {
  NewsFeed, parseFeed, parseHackerNews, parseGithubRelease, markdownText, releaseTitle, isPrerelease, canonicalUrl, cleanUrl, matchesTerms,
} from '../src/manager/news.mjs';
import { Changelog, parseNotes, parseReleases } from '../src/manager/changelog.mjs';
import { once } from 'node:events';
import {
  SessionHistory, FileMemo, listClaudeSessions, listCodexSessions, listAntigravitySessions, listGrokSessions, commandHistory, cleanEntry,
} from '../src/manager/session-history.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

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
  const ps = buildSpawnSpec('C:\\npm\\tool.ps1', [], { SystemRoot: 'D:\\Win' }, 'win32');
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
  const google = linux.providers.find((p) => p.id === 'google');
  assert.deepEqual(
    [google.tool, google.command, google.package, google.usage, google.history, google.reporting, google.homeVar, google.accounts.length],
    ['Antigravity CLI', 'agy', null, null, 'antigravity', 'antigravity', null, 1],
  );
  assert.deepEqual(google.resumeArgs, ['--conversation', '{id}']);
  assert.deepEqual(Object.keys(google.channels), ['native', 'brew']);
  assert.deepEqual(google.channels.brew, { names: ['antigravity-cli'], autoUpdates: true }, 'agy updates itself, so no Homebrew copy is updated over it');
  assert.deepEqual(google.channels.native.paths, ['~/.local/bin/agy']);

  const win = loadProviders({ userFile, platform: 'win32' });
  assert.equal(win.providers[0].command, 'claude-win');
  assert.equal(win.providers[0].win32, undefined);
  const googleWin = win.providers.find((p) => p.id === 'google');
  assert.deepEqual(Object.keys(googleWin.channels), ['native']);
  assert.deepEqual(googleWin.channels.native.paths, ['~/AppData/Local/agy/bin']);
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

  await assert.rejects(registry.installSpec(registry.get('shell')), (err) => err.code === 'not_installable');
  const npmDir = tempDir();
  if (process.platform === 'win32') fs.writeFileSync(path.join(npmDir, 'npm.cmd'), '@echo https://mirror.example/npm/\r\n');
  else fs.writeFileSync(path.join(npmDir, 'npm'), '#!/bin/sh\necho https://mirror.example/npm/\n', { mode: 0o755 });
  const npmEnv = { PATH: npmDir, PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '3.2.1' }) });
  const withNpm = new ProviderRegistry({ userFile, env: npmEnv, platform: process.platform, fetchImpl });
  const argsOf = (spec) => (typeof spec.args === 'string' ? spec.args : spec.args.join(' '));
  assert.ok(argsOf(await withNpm.installSpec(withNpm.get('anthropic'))).includes('install -g @anthropic-ai/claude-code@3.2.1'));
  assert.equal(await withNpm.npmRegistryUrl(), 'https://mirror.example/npm/', "installs and lookups share npm's own registry");
  const mirrored = new ProviderRegistry({ userFile, env: npmEnv, platform: process.platform, registryUrl: 'https://mirror.example/other', fetchImpl });
  assert.ok(argsOf(await mirrored.installSpec(mirrored.get('anthropic'))).includes('@3.2.1 --registry https://mirror.example/other'));
  const unchecked = new ProviderRegistry({ userFile, env: npmEnv, platform: process.platform, checkUpdates: false });
  assert.ok(argsOf(await unchecked.installSpec(unchecked.get('anthropic'))).includes('install -g @anthropic-ai/claude-code@latest'));
  assert.equal(await mirrored.npmRegistryUrl(), 'https://mirror.example/other');
  const onWindows = buildSpawnSpec('C:\\npm\\npm.cmd', ['install', '-g', 'x@latest', '--registry', 'http://127.0.0.1:1'], {}, 'win32');
  assert.ok(onWindows.args.endsWith(' --registry http://127.0.0.1:1"'), 'the registry URL needs no cmd.exe quoting');
  const withoutNpm = new ProviderRegistry({ userFile, env: { PATH: tempDir() }, platform: process.platform });
  await assert.rejects(withoutNpm.installSpec(withoutNpm.get('anthropic')), (err) => err.code === 'npm_unavailable');
  assert.equal(await withoutNpm.npmRegistryUrl(), 'https://registry.npmjs.org');

  assert.equal(cleanResumeId(undefined), null);
  assert.equal(cleanResumeId('  550e8400-e29b  '), '550e8400-e29b');
  assert.throws(() => cleanResumeId(''), (err) => err.status === 400);
  assert.throws(() => cleanResumeId('a\x1bb'), (err) => err.status === 400);
  assert.throws(() => cleanResumeId('x'.repeat(201)), (err) => err.status === 400);
});

test('an installed tool is classified by the installation that owns it', () => {
  const provider = {
    tool: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    channels: {
      native: { paths: ['~/.local/bin/claude', '~/.local/share/claude'], update: ['update'] },
      brew: { names: ['claude-code', 'claude-code@latest'] },
      winget: { id: 'Anthropic.ClaudeCode' },
      legacy: { paths: ['~/.claude/local'], guidance: 'old installer' },
    },
  };
  const fsx = ({ files = [], links = {}, texts = {} } = {}) => ({
    exists: (f) => files.includes(f),
    isFile: (f) => files.includes(f) || Object.hasOwn(links, f),
    isLink: (f) => Object.hasOwn(links, f),
    realpath: (f) => links[f] || f,
    readText: (f) => texts[f] || '',
  });
  const mac = { provider, platform: 'darwin', env: { HOME: '/Users/a' }, npmOnPath: '/opt/other/bin/npm' };
  const windows = { provider, platform: 'win32', env: { USERPROFILE: 'C:\\Users\\a' }, npmOnPath: 'C:\\other\\npm.cmd', wingetOnPath: 'C:\\WindowsApps\\winget.exe' };
  const npmUpdate = (file, prefix) => ({ file, args: ['install', '-g', '--prefix', prefix], package: '@anthropic-ai/claude-code' });

  assert.equal(expandHome('~/.local/bin/claude', mac.env, 'darwin'), '/Users/a/.local/bin/claude');
  assert.equal(expandHome('~/.local/bin/claude', windows.env, 'win32'), 'C:\\Users\\a\\.local\\bin\\claude');

  const nvm = '/Users/a/.nvm/versions/node/v22';
  const nvmPkg = `${nvm}/lib/node_modules/@anthropic-ai/claude-code`;
  const viaNvm = classifyInstall({ ...mac, resolvedPath: `${nvm}/bin/claude`, fsx: fsx({
    files: [`${nvmPkg}/package.json`, `${nvm}/bin/npm`],
    links: { [`${nvm}/bin/claude`]: `${nvmPkg}/bin/claude.exe` },
  }) });
  assert.equal(viaNvm.channel, 'npm');
  assert.deepEqual(viaNvm.update, npmUpdate(`${nvm}/bin/npm`, nvm), 'the npm beside the launcher, not the first npm on PATH');

  const custom = '/Users/a/.npm-global';
  const customPkg = `${custom}/lib/node_modules/@anthropic-ai/claude-code`;
  const viaPrefix = classifyInstall({ ...mac, resolvedPath: `${custom}/bin/claude`, fsx: fsx({
    files: [`${customPkg}/package.json`],
    links: { [`${custom}/bin/claude`]: `${customPkg}/bin/claude.exe` },
  }) });
  assert.deepEqual(viaPrefix.update, npmUpdate('/opt/other/bin/npm', custom), 'a prefix without its own npm is still the target');

  const stray = classifyInstall({ ...mac, resolvedPath: `${custom}/bin/claude`, fsx: fsx({
    files: [`${customPkg}/package.json`],
    texts: { [`${custom}/bin/claude`]: '#!/bin/sh\nexec /opt/tools/claude "$@"\n' },
  }) });
  assert.equal(stray.channel, 'unknown', 'a launcher that is not part of the npm package is not claimed by npm');
  assert.equal(stray.update, null);

  const prefix = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const shim = `${prefix}\\claude.cmd`;
  const shimText = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*';
  const pkgJson = `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\package.json`;
  const viaShim = classifyInstall({ ...windows, resolvedPath: shim, fsx: fsx({ files: [pkgJson], texts: { [shim]: shimText } }) });
  assert.equal(viaShim.channel, 'npm');
  assert.deepEqual(viaShim.update, npmUpdate('C:\\other\\npm.cmd', prefix));
  const ownNpm = classifyInstall({ ...windows, resolvedPath: shim, fsx: fsx({ files: [pkgJson, `${prefix}\\npm.cmd`], texts: { [shim]: shimText } }) });
  assert.equal(ownNpm.update.file, `${prefix}\\npm.cmd`);
  const noNpm = classifyInstall({ ...windows, npmOnPath: null, resolvedPath: shim, fsx: fsx({ files: [pkgJson], texts: { [shim]: shimText } }) });
  assert.equal(noNpm.channel, 'npm');
  assert.equal(noNpm.update, null);
  assert.match(noNpm.guidance, /npm was not found/);

  const nativeMac = classifyInstall({ ...mac, resolvedPath: '/Users/a/.local/bin/claude', fsx: fsx({
    links: { '/Users/a/.local/bin/claude': '/Users/a/.local/share/claude/versions/2.1.286' },
  }) });
  assert.equal(nativeMac.channel, 'native');
  assert.deepEqual(nativeMac.update, { file: '/Users/a/.local/bin/claude', args: ['update'] }, 'the detected launcher by its absolute path');
  assert.equal(nativeMac.probe, true);
  const nativeLinux = classifyInstall({ provider, platform: 'linux', env: { HOME: '/home/a' }, resolvedPath: '/home/a/.local/bin/claude', fsx: fsx({
    links: { '/home/a/.local/bin/claude': '/home/a/.local/share/claude/versions/2.1.286' },
  }) });
  assert.equal(nativeLinux.channel, 'native');
  const nativeWin = classifyInstall({ ...windows, resolvedPath: 'c:\\users\\A\\.local\\bin\\claude.exe', fsx: fsx({ files: ['C:\\Users\\a\\.local\\bin\\claude.exe'] }) });
  assert.equal(nativeWin.channel, 'native');
  assert.equal(nativeWin.update.file, 'c:\\users\\A\\.local\\bin\\claude.exe');
  const noUpdater = classifyInstall({ ...mac, provider: { ...provider, channels: { native: { paths: ['~/.local/bin/claude'], update: [] } } }, resolvedPath: '/Users/a/.local/bin/claude', fsx: fsx({ files: ['/Users/a/.local/bin/claude'] }) });
  assert.equal(noUpdater.update, null);
  assert.match(noUpdater.guidance, /no update command/);

  const arm = classifyInstall({ ...mac, resolvedPath: '/opt/homebrew/bin/claude', fsx: fsx({
    files: ['/opt/homebrew/bin/brew'],
    links: { '/opt/homebrew/bin/claude': '/opt/homebrew/Caskroom/claude-code@latest/2.1.286/claude' },
  }) });
  assert.equal(arm.channel, 'brew');
  assert.deepEqual(arm.update, { file: '/opt/homebrew/bin/brew', args: ['upgrade', '--cask', 'claude-code@latest'] });
  const formulaTool = { tool: 'Example CLI', package: '@example/cli', channels: { brew: { names: ['example-cli'] } } };
  const intel = classifyInstall({ ...mac, provider: formulaTool, resolvedPath: '/usr/local/bin/example', fsx: fsx({
    files: ['/usr/local/bin/brew', '/opt/homebrew/bin/brew', '/usr/local/Cellar/example-cli/0.46.0/libexec/lib/node_modules/@example/cli/package.json'],
    links: { '/usr/local/bin/example': '/usr/local/Cellar/example-cli/0.46.0/libexec/lib/node_modules/@example/cli/bundle/example.js' },
  }) });
  assert.equal(intel.channel, 'brew', 'a formula that bundles an npm package is still Homebrew-owned');
  assert.deepEqual(intel.update, { file: '/usr/local/bin/brew', args: ['upgrade', 'example-cli'] }, 'the Homebrew that owns the file');
  const linuxbrew = classifyInstall({ provider: formulaTool, platform: 'linux', env: { HOME: '/home/a' }, resolvedPath: '/home/linuxbrew/.linuxbrew/bin/example', fsx: fsx({
    files: ['/home/linuxbrew/.linuxbrew/bin/brew'],
    links: { '/home/linuxbrew/.linuxbrew/bin/example': '/home/linuxbrew/.linuxbrew/Cellar/example-cli/0.46.0/bin/example' },
  }) });
  assert.equal(linuxbrew.update.file, '/home/linuxbrew/.linuxbrew/bin/brew');
  const orphan = classifyInstall({ ...mac, resolvedPath: '/opt/homebrew/bin/claude', fsx: fsx({
    files: ['/usr/local/bin/brew'],
    links: { '/opt/homebrew/bin/claude': '/opt/homebrew/Caskroom/claude-code/2.1.285/claude' },
  }) });
  assert.equal(orphan.channel, 'brew');
  assert.equal(orphan.update, null, 'another Homebrew is not used in its place');
  assert.match(orphan.guidance, /brew was not found/);

  const packages = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  const wingetExe = `${packages}\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`;
  const viaWinget = classifyInstall({ ...windows, resolvedPath: wingetExe, fsx: fsx() });
  assert.equal(viaWinget.channel, 'winget');
  assert.deepEqual(viaWinget.update, { file: 'C:\\WindowsApps\\winget.exe', args: ['upgrade', '--id', 'Anthropic.ClaudeCode', '--exact'] });
  const link = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe';
  assert.equal(classifyInstall({ ...windows, resolvedPath: link, fsx: fsx({ links: { [link]: wingetExe } }) }).channel, 'winget');
  const noWinget = classifyInstall({ ...windows, wingetOnPath: null, resolvedPath: wingetExe, fsx: fsx() });
  assert.equal(noWinget.update, null);
  assert.match(noWinget.guidance, /winget was not found/);
  const otherPackage = classifyInstall({ ...windows, resolvedPath: `${packages}\\Some.Tool_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`, fsx: fsx() });
  assert.equal(otherPackage.channel, 'unknown', 'a WinGet folder of another package is not claimed');

  const legacy = classifyInstall({ ...mac, resolvedPath: '/Users/a/.claude/local/claude', fsx: fsx() });
  assert.equal(legacy.channel, 'legacy');
  assert.equal(legacy.update, null);
  assert.equal(legacy.guidance, 'old installer');

  const copied = classifyInstall({ ...mac, resolvedPath: '/usr/local/bin/claude', fsx: fsx() });
  assert.equal(copied.channel, 'unknown');
  assert.equal(copied.update, null, 'an unrecognised installation gets no guessed command');
  assert.match(copied.guidance, /does not recognise/);
});

test('updates are bound to the installation that owns the resolved tool', async () => {
  const win = process.platform === 'win32';
  const script = (dir, name, body) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, win ? `${name}.cmd` : name);
    fs.writeFileSync(file, win ? `@echo off\r\n${body.win}\r\n` : `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
    return file;
  };
  const succeed = { win: 'exit /b 0', sh: 'exit 0' };
  const root = tempDir();
  const nativeDir = path.join(root, 'native');
  const prefix = path.join(root, 'prefix');
  const prefixBin = win ? prefix : path.join(prefix, 'bin');
  const pkgDir = path.join(prefix, ...(win ? [] : ['lib']), 'node_modules', 'mytool-pkg');
  const otherNpmDir = path.join(root, 'other-npm');
  const launcher = script(nativeDir, 'mytool', { win: 'echo Usage: mytool update [options]', sh: 'echo "Usage: mytool update [options]"' });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');
  script(prefixBin, 'mytool', { win: 'REM node_modules\\mytool-pkg\\bin\\cli.js', sh: '# node_modules/mytool-pkg/bin/cli.js' });
  const ownNpm = script(prefixBin, 'npm', succeed);
  script(otherNpmDir, 'npm', succeed);
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'mytool', tool: 'My Tool', command: 'mytool', package: 'mytool-pkg', channels: { native: { paths: [path.join(nativeDir, 'mytool')], update: ['update'] } } },
  ] }));
  const base = { PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root };
  const lineOf = (spec) => (typeof spec.args === 'string' ? spec.args : [spec.file, ...spec.args].join(' '));

  const nativeFirst = new ProviderRegistry({ userFile, env: { ...base, PATH: [otherNpmDir, nativeDir, prefixBin].join(path.delimiter) }, checkUpdates: false });
  const tool = nativeFirst.get('mytool');
  assert.equal(nativeFirst.describe(tool).installChannel, 'native');
  assert.equal(nativeFirst.describe(tool).updateCommand, null, 'no command before the launcher has shown it accepts it');
  await assert.rejects(nativeFirst.updateSpec(tool), (err) => err.code === 'not_updatable');
  await nativeFirst.refreshVersions();
  const viaLauncher = await nativeFirst.updateSpec(tool);
  assert.equal(viaLauncher.channel, 'native');
  assert.ok(lineOf(viaLauncher.spec).includes(launcher), 'the detected launcher, by its absolute path');
  assert.ok(lineOf(viaLauncher.spec).includes(' update'));
  assert.ok(!lineOf(viaLauncher.spec).includes('npm'));
  assert.ok(nativeFirst.describe(tool).updateCommand.includes(launcher));

  const npmFirst = new ProviderRegistry({ userFile, env: { ...base, PATH: [otherNpmDir, prefixBin, nativeDir].join(path.delimiter) }, checkUpdates: false });
  const viaNpm = await npmFirst.updateSpec(npmFirst.get('mytool'));
  assert.equal(viaNpm.channel, 'npm');
  assert.ok(lineOf(viaNpm.spec).includes(ownNpm), 'the npm of the owning prefix, not the first npm on PATH');
  assert.ok(lineOf(viaNpm.spec).includes(`--prefix ${prefix} mytool-pkg@latest`));
  const mirrored = new ProviderRegistry({ userFile, env: { ...base, PATH: [prefixBin].join(path.delimiter) }, checkUpdates: false, registryUrl: 'https://mirror.example/npm' });
  assert.ok(lineOf((await mirrored.updateSpec(mirrored.get('mytool'))).spec).includes('mytool-pkg@latest --registry https://mirror.example/npm'));

  script(nativeDir, 'mytool', { win: 'echo Usage: mytool [OPTIONS] [PROMPT]', sh: 'echo "Usage: mytool [OPTIONS] [PROMPT]"' });
  await nativeFirst.refreshVersions({ force: true });
  assert.equal(nativeFirst.describe(tool).updateCommand, null, 'general help is not proof that the update command exists');
  assert.match(nativeFirst.describe(tool).updateGuidance, /does not accept/);
  await assert.rejects(nativeFirst.updateSpec(tool), (err) => err.code === 'not_updatable' && /does not accept/.test(err.message));

  script(nativeDir, 'mytool', { win: 'echo Usage of update:& exit /b 2', sh: 'echo "Usage of update:"; exit 2' });
  await nativeFirst.refreshVersions({ force: true });
  assert.ok(nativeFirst.describe(tool).updateCommand?.includes(' update'), 'Go help exits 2 and still describes the command');

  script(nativeDir, 'mytool', { win: 'echo error: unknown option --help& echo Usage: mytool update& exit /b 1', sh: 'echo "error: unknown option --help"; echo "Usage: mytool update"; exit 1' });
  await nativeFirst.refreshVersions({ force: true });
  assert.equal(nativeFirst.describe(tool).updateCommand, null, 'a failure that reports an error is no help');

  script(nativeDir, 'mytool', { win: 'exit /b 1', sh: 'exit 1' });
  await nativeFirst.refreshVersions({ force: true });
  assert.equal(nativeFirst.describe(tool).updateCommand, null);

  const realHelp = {
    'claude update --help': 'Usage: claude update|upgrade [options]\n\nCheck for updates and install if available\n\nOptions:\n  -h, --help  Display help for command\n',
    'codex update --help': 'Update Codex to the latest version\n\nUsage: codex update [OPTIONS]\n\nOptions:\n  -c, --config <key=value>\n',
    'grok update --help': 'Check for updates or install a specific version\n\nUsage: grok update [OPTIONS]\n\nOptions:\n      --check                 Check for updates without installing\n',
  };
  for (const [run, stdout] of Object.entries(realHelp)) {
    assert.equal(updateHelpAccepted({ stdout, stderr: '' }, ['update']), true, run);
    assert.equal(updateHelpAccepted({ stdout, stderr: '' }, ['update'], { failed: true }), true, `${run}, had it exited non-zero`);
  }
  assert.equal(updateHelpAccepted({ stdout: '', stderr: 'Usage of update:\n' }, ['update'], { failed: true }), true, 'agy update --help exits 2');
  const generalHelp = {
    claude: 'Usage: claude [options] [command] [prompt]\n\nClaude Code - starts an interactive session by default\n',
    codex: 'Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]\n',
    grok: 'Grok Build TUI\n\nUsage: grok [OPTIONS] [PROMPT] [COMMAND]\n',
    agy: 'Usage of agy.exe:\n  --add-dir   Add a directory to the workspace\n\nAvailable subcommands:\n  update          Update CLI\n',
  };
  for (const [tool, stdout] of Object.entries(generalHelp)) {
    assert.equal(updateHelpAccepted({ stdout, stderr: '' }, ['update']), false, `${tool}'s general help lists no update usage`);
    assert.equal(updateHelpAccepted({ stdout: '', stderr: stdout }, ['update'], { failed: true }), false, `${tool}'s general help on a failure`);
  }
  const refusals = [
    "error: unknown command 'update'\nUsage: tool update [options]",
    "error: unrecognized subcommand 'update'\n\nUsage: tool update [OPTIONS]",
    'Error: unknown command "update" for "tool"\nRun \'tool --help\' for usage of update.',
    'invalid choice: update\nusage: tool update',
  ];
  for (const stderr of refusals) assert.equal(updateHelpAccepted({ stdout: '', stderr }, ['update'], { failed: true }), false, stderr.split('\n')[0]);

  assert.equal(helpDescribes('Usage: claude update|upgrade [options]\n\nCheck for updates and install if available', ['update']), true);
  assert.equal(helpDescribes('Check for updates or install a specific version\n\nUsage: grok update [OPTIONS]', ['update']), true);
  assert.equal(helpDescribes('USAGE:\n    tool update [FLAGS]', ['update']), true);
  assert.equal(helpDescribes('Usage of update:', ['update']), true);
  assert.equal(helpDescribes('Usage of agy.exe:', ['update']), false);
  assert.equal(helpDescribes('Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]\n\nCommands:\n  exec  Run non-interactively', ['update']), false);
  assert.equal(helpDescribes('Usage: tool auto-update [options]', ['update']), false);
  assert.equal(helpDescribes('', ['update']), false);
});

test('an install or update ends with a fresh version check and a recorded outcome', async () => {
  const dir = tempDir();
  const versionFile = path.join(dir, 'version.txt');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'tool', tool: 'Tool', command: process.execPath, package: 'tool-pkg', versionArgs: [fixture, '--version'], env: { FAKE_TOOL_VERSION_FILE: versionFile } },
    { id: 'absent', tool: 'Absent', command: 'definitely-not-installed-agent-guild', package: 'absent-pkg' },
  ] }));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) });
  const registry = new ProviderRegistry({ userFile, env: { ...process.env, PATH: path.dirname(process.execPath) }, registryUrl: 'https://registry.example', fetchImpl });
  const tool = registry.get('tool');
  await registry.refreshVersions({ ids: ['tool', 'absent'] });
  assert.equal(registry.describe(tool).installedVersion, '1.2.3');
  assert.equal(registry.describe(tool).lastInstall, null);

  await registry.finishInstall('tool', { exitCode: 0, kind: 'update' });
  const unchanged = registry.describe(tool);
  assert.equal(unchanged.lastInstall.outcome, 'unchanged');
  assert.equal(unchanged.updateAvailable, true, 'the release stays on offer');
  assert.equal(unchanged.latestVersion, '9.9.9');

  await registry.finishInstall('tool', { exitCode: 3, kind: 'update' });
  assert.equal(registry.describe(tool).lastInstall.outcome, 'failed');
  assert.equal(registry.describe(tool).lastInstall.exitCode, 3);

  fs.writeFileSync(versionFile, '2.0.0');
  assert.equal(registry.describe(tool).installedVersion, '1.2.3', 'the hourly cache still holds the old version');
  await registry.finishInstall('tool', { exitCode: 0, kind: 'update' });
  const updated = registry.describe(tool);
  assert.equal(updated.installedVersion, '2.0.0', 'the version is read again, not taken from the cache');
  assert.equal(updated.lastInstall.outcome, 'updated');
  assert.equal(updated.lastInstall.before, '1.2.3');

  fs.writeFileSync(versionFile, '3.0.0');
  await registry.refreshVersions({ force: true, ids: ['tool'] });
  assert.equal(registry.describe(tool).lastInstall, null, 'the outcome is dropped once the version moves on');

  await registry.finishInstall('absent', { exitCode: 0, kind: 'install' });
  assert.equal(registry.describe(registry.get('absent')).lastInstall.outcome, 'missing');
  await registry.finishInstall('absent', { exitCode: 1, kind: 'install' });
  assert.equal(registry.describe(registry.get('absent')).lastInstall.outcome, 'failed');
});

test('a failed version command never yields a version', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  const dir = tempDir();
  const flag = path.join(dir, 'broken.flag');
  fs.writeFileSync(flag, '');
  const spec = buildSpawnSpec(process.execPath, [fixture, '--version']);

  const broken = await probeVersion(spec, { env: { ...process.env, FAKE_TOOL_BREAK_FILE: flag } });
  assert.equal(broken.ok, false);
  assert.equal(broken.exitCode, 1);
  assert.equal(broken.version, null, 'the Node.js version in the error path is not the tool version');
  assert.match(broken.error, /^Error: Missing optional dependency fake-tool-win32-x64/);
  assert.equal(parseVersion('file:///C:/nodejs/v-24.20.0/nodejs-24.20.0/fake.js:107'), '24.20.0', 'the error text alone does parse as a version');

  const odd = await probeVersion(spec, { env: { ...process.env, FAKE_TOOL_VERSION_TEXT: 'fake-tool nightly build' } });
  assert.deepEqual(odd, { ok: true, version: null, exitCode: 0, error: null });

  assert.equal(diagnosticLine('error: unrecognized subcommand\n\nUsage: tool'), 'error: unrecognized subcommand');
  assert.equal(diagnosticLine('  throw new Error(\n        ^\n\nTypeError: x is not a function\n    at main'), 'TypeError: x is not a function');
  assert.equal(diagnosticLine("'tool' is not recognized as an internal or external command,\r\noperable program or batch file."), 'operable program or batch file.');
  assert.equal(diagnosticLine(''), '');

  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'tool', tool: 'Tool', command: process.execPath, package: 'tool-pkg', versionArgs: [fixture, '--version'], env: { FAKE_TOOL_BREAK_FILE: flag } },
    { id: 'odd', tool: 'Odd', command: process.execPath, package: 'tool-pkg', versionArgs: [fixture, '--version'], env: { FAKE_TOOL_VERSION_TEXT: 'nightly' } },
  ] }));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) });
  const registry = new ProviderRegistry({ userFile, env: { ...process.env, PATH: path.dirname(process.execPath) }, registryUrl: 'https://registry.example', fetchImpl });
  await registry.refreshVersions({ ids: ['tool', 'odd'] });
  const failed = registry.describe(registry.get('tool'));
  assert.equal(failed.available, true);
  assert.equal(failed.installedVersion, null);
  assert.equal(failed.versionStatus, 'failed');
  assert.match(failed.versionError, /Missing optional dependency/);
  assert.equal(failed.updateAvailable, false);
  assert.equal(failed.installChannel, 'unknown', 'ownership is decided apart from whether the tool runs');
  const unreadable = registry.describe(registry.get('odd'));
  assert.equal(unreadable.versionStatus, 'unavailable', 'a tool that answers without a version is not declared broken');
  assert.equal(unreadable.versionError, null);

  fs.rmSync(flag);
  await registry.refreshVersions({ force: true, ids: ['tool'] });
  assert.equal(registry.describe(registry.get('tool')).versionStatus, 'ok');
  assert.equal(registry.describe(registry.get('tool')).installedVersion, '1.2.3');
});

test('an npm install checks the platform build of the release it then installs', async () => {
  const win = process.platform === 'win32';
  const script = (dir, name, body) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, win ? `${name}.cmd` : name);
    fs.writeFileSync(file, win ? `@echo off\r\n${body.win}\r\n` : `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
    return file;
  };
  const root = tempDir();
  const prefix = path.join(root, 'prefix');
  const prefixBin = win ? prefix : path.join(prefix, 'bin');
  const pkgDir = path.join(prefix, ...(win ? [] : ['lib']), 'node_modules', 'mytool-pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');
  script(prefixBin, 'mytool', { win: 'REM node_modules\\mytool-pkg\\bin\\cli.js', sh: '# node_modules/mytool-pkg/bin/cli.js' });
  script(prefixBin, 'npm', { win: 'exit /b 0', sh: 'exit 0' });
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'mytool', tool: 'My Tool', command: 'mytool', package: 'mytool-pkg' },
    { id: 'absent', tool: 'Absent Tool', command: 'definitely-not-installed-agent-guild', package: 'mytool-pkg' },
  ] }));
  const env = { PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, PATH: prefixBin };
  const lineOf = (spec) => (typeof spec.args === 'string' ? spec.args : [spec.file, ...spec.args].join(' '));
  const target = `${process.platform}-${process.arch}`;

  const requests = [];
  let latest = '1.9.0';
  let published = true;
  const fetchImpl = async (url) => {
    const route = url.replace('https://registry.example', '');
    requests.push(route);
    if (route === '/mytool-pkg/latest') {
      return { ok: true, status: 200, json: async () => ({ version: latest, optionalDependencies: { [`mytool-pkg-${target}`]: `npm:mytool-pkg@${latest}-${target}` } }) };
    }
    if (published && route === `/mytool-pkg/${latest}-${target}`) return { ok: true, status: 200, json: async () => ({ version: `${latest}-${target}` }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const registry = new ProviderRegistry({ userFile, env, registryUrl: 'https://registry.example', fetchImpl });
  const tool = registry.get('mytool');
  await registry.refreshVersions({ ids: ['mytool'] });
  assert.ok(registry.describe(tool).updateCommand.includes('mytool-pkg@1.9.0'));

  latest = '2.0.0';
  requests.length = 0;
  const { spec } = await registry.updateSpec(tool);
  assert.ok(lineOf(spec).includes('mytool-pkg@2.0.0 --registry https://registry.example'), 'the release resolved when the update starts, as an exact version');
  assert.ok(!lineOf(spec).includes('@latest'));
  assert.deepEqual(requests, ['/mytool-pkg/latest', `/mytool-pkg/2.0.0-${target}`], 'the build checked belongs to the release installed');
  assert.ok(lineOf(await registry.installSpec(registry.get('absent'))).includes('install -g mytool-pkg@2.0.0'));

  published = false;
  const incomplete = (err) => err.code === 'release_incomplete' && err.status === 409
    && err.message.includes(`mytool-pkg@2.0.0-${target}`) && /Nothing was changed/.test(err.message);
  await assert.rejects(registry.updateSpec(tool), incomplete);
  await assert.rejects(registry.installSpec(registry.get('absent')), incomplete);

  const offline = new ProviderRegistry({ userFile, env, registryUrl: 'https://registry.example', fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.updateSpec(offline.get('mytool')), (err) => err.code === 'release_unresolved' && /offline/.test(err.message) && /Nothing was changed/.test(err.message));

  const codex = { optionalDependencies: { '@openai/codex-win32-x64': 'npm:@openai/codex@0.159.3-win32-x64' } };
  assert.deepEqual(platformDependency(codex, '@openai/codex', 'win32', 'x64'), { name: '@openai/codex', version: '0.159.3-win32-x64' });
  assert.equal(platformDependency(codex, '@openai/codex', 'linux', 'x64'), null);
  assert.equal(platformDependency({ optionalDependencies: { 'pkg-win32-x64': '^1.2.0' } }, 'pkg', 'win32', 'x64'), null, 'only the exact aliased form is checked');
  assert.equal(platformDependency({}, 'pkg', 'win32', 'x64'), null);
});

test('a clean updater exit is reported apart from the verification that follows', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  const dir = tempDir();
  const flag = path.join(dir, 'broken.flag');
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'tool', tool: 'Tool', command: process.execPath, package: 'tool-pkg', versionArgs: [fixture, '--version'], env: { FAKE_TOOL_BREAK_FILE: flag } },
  ] }));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) });
  const registry = new ProviderRegistry({ userFile, env: { ...process.env, PATH: path.dirname(process.execPath) }, registryUrl: 'https://registry.example', fetchImpl });
  const tool = registry.get('tool');
  await registry.refreshVersions({ ids: ['tool'] });
  assert.equal(registry.describe(tool).versionStatus, 'ok');

  fs.writeFileSync(flag, '');
  await registry.finishInstall('tool', { exitCode: 0, kind: 'update' });
  const unverified = registry.describe(tool);
  assert.equal(unverified.lastInstall.exitCode, 0, "the updater's own exit code is kept");
  assert.equal(unverified.lastInstall.verification, 'failed');
  assert.equal(unverified.versionStatus, 'failed');
  assert.equal(unverified.installedVersion, null);
  assert.match(unverified.versionError, /Missing optional dependency/);

  fs.rmSync(flag);
  await registry.finishInstall('tool', { exitCode: 0, kind: 'update' });
  const repaired = registry.describe(tool);
  assert.equal(repaired.lastInstall.verification, 'ok');
  assert.equal(repaired.lastInstall.outcome, 'updated');
  assert.equal(repaired.installedVersion, '1.2.3');
});

test('every copy of a command on PATH is found, one per folder', () => {
  const winFiles = ['C:\\a\\claude.cmd', 'C:\\a\\claude.ps1', 'C:\\b\\claude.exe', 'C:\\b\\claude.cmd'];
  const winEnv = { Path: 'C:\\a;C:\\b;C:\\a;C:\\empty', PATHEXT: '.EXE;.CMD' };
  const onWindows = { isExecutable: (file) => winFiles.includes(file) };
  assert.deepEqual(resolveAllCommands('claude', winEnv, 'win32', onWindows), ['C:\\a\\claude.cmd', 'C:\\b\\claude.exe']);
  assert.equal(resolveCommand('claude', winEnv, 'win32', onWindows), 'C:\\a\\claude.cmd');

  const posixFiles = ['/a/claude', '/c/claude', '/x/claude'];
  const onPosix = { isExecutable: (file) => posixFiles.includes(file) };
  assert.deepEqual(resolveAllCommands('claude', { PATH: '/a:/b:/c:/a' }, 'linux', onPosix), ['/a/claude', '/c/claude']);
  assert.deepEqual(resolveAllCommands('/x/claude', { PATH: '/a' }, 'linux', onPosix), ['/x/claude']);
  assert.deepEqual(resolveAllCommands('missing', { PATH: '/a:/c' }, 'linux', onPosix), []);
});

const runOf = (install) => install.uninstall?.run && [install.uninstall.run.file, ...install.uninstall.run.args].join(' ');

test('installations are counted once however many entry points they have', () => {
  const claude = {
    tool: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    channels: {
      native: { paths: ['~/.local/bin/claude', '~/.local/share/claude'], update: ['update'], remove: ['~/.local/bin/claude', '~/.local/share/claude'], links: [], sharedWithNpm: false },
      brew: { names: ['claude-code', 'claude-code@latest'] },
      winget: { id: 'Anthropic.ClaudeCode' },
      legacy: { paths: ['~/.claude/local'], guidance: null, remove: ['~/.claude/local'] },
    },
  };
  const fsx = ({ files = [], links = {}, texts = {} } = {}) => ({
    exists: (f) => files.includes(f),
    isFile: (f) => files.includes(f) || Object.hasOwn(links, f),
    isLink: (f) => Object.hasOwn(links, f),
    realpath: (f) => links[f] || f,
    readText: (f) => texts[f] || '',
  });
  const mac = { provider: claude, platform: 'darwin', env: { HOME: '/Users/a' }, npmOnPath: '/opt/other/bin/npm' };
  const windows = { provider: claude, platform: 'win32', env: { USERPROFILE: 'C:\\Users\\a' }, npmOnPath: 'C:\\other\\npm.cmd', wingetOnPath: 'C:\\WindowsApps\\winget.exe' };
  const channelsOf = (list) => list.map((i) => i.channel);

  const current = 'C:\\node\\current';
  const real = 'C:\\node\\v24';
  const shimText = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*';
  const junction = listInstallations({ ...windows, onPath: [`${current}\\claude.cmd`, `${real}\\claude.cmd`], fsx: fsx({
    files: [`${current}\\node_modules\\@anthropic-ai\\claude-code\\package.json`, `${real}\\node_modules\\@anthropic-ai\\claude-code\\package.json`, `${real}\\npm.cmd`, `${current}\\npm.cmd`],
    links: { [current]: real },
    texts: { [`${current}\\claude.cmd`]: shimText, [`${real}\\claude.cmd`]: shimText },
  }) });
  assert.deepEqual(channelsOf(junction), ['npm'], 'one npm prefix reached through two PATH entries is one installation');
  assert.equal(junction[0].resolvedPath, `${current}\\claude.cmd`);
  assert.equal(runOf(junction[0]), `${current}\\npm.cmd uninstall -g --prefix ${current} @anthropic-ai/claude-code`);

  const versions = '/Users/a/.local/share/claude/versions/2.1.286';
  const linked = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', '/usr/local/bin/claude'], fsx: fsx({
    links: { '/Users/a/.local/bin/claude': versions, '/usr/local/bin/claude': versions },
  }) });
  assert.deepEqual(channelsOf(linked), ['native'], 'a second link to the native build is the same installation');
  assert.deepEqual(linked[0].uninstall, {
    run: null, remove: ['/Users/a/.local/bin/claude', '/Users/a/.local/share/claude'], links: [], launcher: '/Users/a/.local/bin/claude',
  }, 'the launcher found on PATH is removed last');

  const nvm = '/Users/a/.nvm/versions/node/v22';
  const nvmPkg = `${nvm}/lib/node_modules/@anthropic-ai/claude-code`;
  const npmFiles = { files: [`${nvmPkg}/package.json`, `${nvm}/bin/npm`], links: { [`${nvm}/bin/claude`]: `${nvmPkg}/bin/claude.exe`, '/usr/local/bin/claude': `${nvmPkg}/bin/claude.exe` } };
  const npmLinked = listInstallations({ ...mac, onPath: [`${nvm}/bin/claude`, '/usr/local/bin/claude'], fsx: fsx(npmFiles) });
  assert.deepEqual(channelsOf(npmLinked), ['npm'], 'a link elsewhere into the npm package is the same installation');
  const viaLink = listInstallations({ ...mac, onPath: ['/usr/local/bin/claude'], fsx: fsx(npmFiles) });
  assert.equal(viaLink[0].channel, 'npm');
  assert.equal(runOf(viaLink[0]), `${nvm}/bin/npm uninstall -g --prefix ${nvm} @anthropic-ai/claude-code`);
  assert.deepEqual(viaLink[0].uninstall.remove, [], 'npm removes its own copy of a tool that does not share the native folder');

  const both = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', `${nvm}/bin/claude`], fsx: fsx({
    files: npmFiles.files, links: { ...npmFiles.links, '/Users/a/.local/bin/claude': versions },
  }) });
  assert.deepEqual(channelsOf(both), ['native', 'npm'], 'a native build and an npm install are two installations');

  const grok = { tool: 'Grok Build', command: 'grok', package: '@xai-official/grok', channels: { native: { paths: ['~/.grok/bin'], update: ['update'], remove: ['~/.grok/bin', '~/.grok/downloads'], links: ['~/.local/bin/grok'], sharedWithNpm: true } } };
  const grokPkg = `${nvm}/lib/node_modules/@xai-official/grok`;
  const shared = listInstallations({ ...mac, provider: grok, onPath: [`${nvm}/bin/grok`, '/Users/a/.grok/bin/grok'], fsx: fsx({
    files: [`${grokPkg}/package.json`, `${nvm}/bin/npm`, '/Users/a/.grok/bin/grok'], links: { [`${nvm}/bin/grok`]: `${grokPkg}/bin/grok-native` },
  }) });
  assert.deepEqual(channelsOf(shared), ['npm'], 'an npm wrapper over the native location is one installation');
  assert.equal(runOf(shared[0]), `${nvm}/bin/npm uninstall -g --prefix ${nvm} @xai-official/grok`);
  assert.deepEqual(shared[0].uninstall.remove, ['/Users/a/.grok/bin', '/Users/a/.grok/downloads'], 'the native files npm placed go too');
  assert.deepEqual(shared[0].uninstall.links, ['/Users/a/.local/bin/grok']);
  assert.equal(shared[0].uninstall.launcher, '/Users/a/.grok/bin/grok', 'the native launcher is kept after npm removes its wrapper');

  const cask = '/opt/homebrew/Caskroom/claude-code/2.1.285/claude';
  const intel = '/usr/local/Caskroom/claude-code/2.1.285/claude';
  const brews = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude', cask, '/usr/local/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], links: { '/opt/homebrew/bin/claude': cask, '/usr/local/bin/claude': intel },
  }) });
  assert.deepEqual(channelsOf(brews), ['brew', 'brew'], 'a link and its Caskroom file are one installation; another Homebrew is another');
  assert.deepEqual(brews.map(runOf), ['/opt/homebrew/bin/brew uninstall --cask claude-code', '/usr/local/bin/brew uninstall --cask claude-code']);

  const packages = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe';
  const link = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe';
  const acceptance = listInstallations({ ...windows, onPath: ['C:\\Users\\a\\.local\\bin\\claude.exe', link, packages], fsx: fsx({
    files: ['C:\\Users\\a\\.local\\bin\\claude.exe'], links: { [link]: packages },
  }) });
  assert.deepEqual(channelsOf(acceptance), ['native', 'winget']);
  assert.equal(runOf(acceptance[1]), 'C:\\WindowsApps\\winget.exe uninstall --id Anthropic.ClaudeCode --exact');
  assert.deepEqual(acceptance[0].uninstall.remove, ['C:\\Users\\a\\.local\\bin\\claude', 'C:\\Users\\a\\.local\\share\\claude']);

  const unknown = listInstallations({ ...mac, onPath: ['/opt/a/claude', '/opt/b/claude', '/opt/c/claude'], fsx: fsx({ links: { '/opt/c/claude': '/opt/a/claude' } }) });
  assert.deepEqual(channelsOf(unknown), ['unknown', 'unknown'], 'two links to one unrecognised file count once');
  assert.deepEqual(unknown.map((i) => i.uninstall), [null, null], 'nothing is removed without confirmed ownership');

  const offPath = fsx({ files: ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude', '/Users/a/.local/share/claude/versions/2.1.286'] });
  assert.deepEqual(knownLaunchers({ provider: claude, command: 'claude', env: mac.env, platform: 'darwin', fsx: offPath }), ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude'], 'kept versions are not launchers');
  assert.deepEqual(knownLaunchers({ provider: claude, command: '/abs/claude', env: mac.env, platform: 'darwin', fsx: offPath }), []);
  assert.deepEqual(knownLaunchers({ provider: claude, command: 'claude', env: windows.env, platform: 'win32', fsx: fsx({ files: ['C:\\Users\\a\\.local\\bin\\claude.exe'] }) }), ['C:\\Users\\a\\.local\\bin\\claude.exe']);
  const found = listInstallations({ ...mac, onPath: [], known: ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude'], fsx: offPath });
  assert.deepEqual(found.map((i) => [i.channel, i.onPath, i.uninstall.remove]), [
    ['native', false, ['/Users/a/.local/bin/claude', '/Users/a/.local/share/claude']],
    ['legacy', false, ['/Users/a/.claude/local']],
  ]);
});

test('shared npm and native copies have the same uninstall plan in either PATH order', () => {
  const provider = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config/providers.default.json'), 'utf8')).providers.find((p) => p.id === 'xai');
  for (const platform of ['darwin', 'win32']) {
    const m = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? 'C:\\Users\\a' : '/Users/a';
    const env = { HOME: home, USERPROFILE: home };
    const prefix = m.join(home, 'npm');
    const wrapper = m.join(prefix, platform === 'win32' ? 'grok.cmd' : 'bin/grok');
    const native = m.join(home, '.grok/bin', platform === 'win32' ? 'grok.exe' : 'grok');
    const manifest = m.join(prefix, platform === 'win32' ? '' : 'lib', 'node_modules/@xai-official/grok/package.json');
    const npm = m.join(prefix, platform === 'win32' ? 'npm.cmd' : 'bin/npm');
    const files = new Set([wrapper, native, manifest, npm]);
    const fsx = { exists: (p) => files.has(p), isFile: (p) => files.has(p), isLink: () => false, realpath: (p) => p, readText: () => 'node_modules/@xai-official/grok' };
    const opts = { provider, env, platform, fsx };
    const [npmFirst] = listInstallations({ ...opts, onPath: [wrapper, native] });
    const [nativeFirst] = listInstallations({ ...opts, onPath: [native, wrapper] });
    assert.deepEqual(nativeFirst.uninstall, npmFirst.uninstall, platform);
    assert.deepEqual(nativeFirst.uninstall.run, { file: npm, args: ['uninstall', '-g', '--prefix', prefix, provider.package] });
    assert.equal(nativeFirst.uninstall.launcher, native);
    assert.equal(nativeFirst.channel, 'native');
    assert.equal(nativeFirst.resolvedPath, native);
    assert.equal(nativeFirst.onPath, true);
    assert.deepEqual(listInstallations({ ...opts, onPath: [wrapper], known: [native] })[0].uninstall, npmFirst.uninstall);
    files.delete(npm);
    for (const onPath of [[wrapper, native], [native, wrapper]]) {
      const [copy] = listInstallations({ ...opts, onPath });
      assert.equal(copy.uninstall, null, 'missing npm must not fall back to deleting only the native files');
      assert.equal(copy.guidance, `Installed by npm under ${prefix}, but npm was not found.`, 'the copy says why it cannot be removed');
    }
  }
});

test('ownership follows where a tool is really installed, and removal runs that installer', () => {
  const fsx = ({ files = [], links = {}, texts = {} } = {}) => ({
    exists: (f) => files.includes(f),
    isFile: (f) => files.includes(f) || Object.hasOwn(links, f),
    isLink: (f) => Object.hasOwn(links, f),
    realpath: (f) => links[f] || f,
    readText: (f) => texts[f] || '',
  });
  const claude = {
    tool: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    channels: {
      native: { paths: ['~/.local/bin/claude', '~/.local/share/claude'], update: ['update'], remove: ['~/.local/bin/claude', '~/.local/share/claude'], links: [], sharedWithNpm: false },
      brew: { names: ['claude-code', 'claude-code@latest'] },
    },
  };
  const mac = { provider: claude, platform: 'darwin', env: { HOME: '/Users/a' }, npmOnPath: '/opt/homebrew/bin/npm' };
  const commandOf = (install) => install.update && [install.update.file, ...install.update.args].join(' ');

  const formulaTool = { tool: 'Example CLI', package: '@example/cli', channels: { brew: { names: ['example-cli'] } } };
  const cellar = '/opt/homebrew/Cellar/example-cli/0.46.0';
  const formula = listInstallations({ ...mac, provider: formulaTool, onPath: ['/opt/homebrew/bin/example'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', '/opt/homebrew/bin/npm', `${cellar}/libexec/lib/node_modules/@example/cli/package.json`, `${cellar}/libexec/bin/npm`],
    links: { '/opt/homebrew/bin/example': `${cellar}/libexec/lib/node_modules/@example/cli/bundle/example.js` },
  }) });
  assert.equal(formula.length, 1);
  assert.equal(formula[0].channel, 'brew', 'the package tree inside a Cellar is not an npm prefix');
  assert.equal(commandOf(formula[0]), '/opt/homebrew/bin/brew upgrade example-cli');
  assert.equal(runOf(formula[0]), '/opt/homebrew/bin/brew uninstall example-cli');

  const agy = { tool: 'Antigravity CLI', channels: { native: { paths: ['~/.local/bin/agy'], update: ['update'], remove: ['~/.local/bin/agy'], links: [] }, brew: { names: ['antigravity-cli'], autoUpdates: true } } };
  const selfUpdating = listInstallations({ ...mac, provider: agy, onPath: ['/opt/homebrew/bin/agy'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew'], links: { '/opt/homebrew/bin/agy': '/opt/homebrew/Caskroom/antigravity-cli/1.2.16/antigravity' },
  }) });
  assert.equal(selfUpdating[0].channel, 'brew');
  assert.equal(selfUpdating[0].update, null, 'Homebrew does not upgrade a cask that updates itself');
  assert.equal(runOf(selfUpdating[0]), '/opt/homebrew/bin/brew uninstall --cask antigravity-cli', 'but it still removes it');

  const cask = '/opt/homebrew/Caskroom/claude-code/2.1.285/claude';
  const aliasToBrew = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude', '/Users/a/.local/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew'],
    links: { '/opt/homebrew/bin/claude': cask, '/Users/a/.local/bin/claude': cask },
  }) });
  assert.equal(aliasToBrew.length, 1, 'one Homebrew installation reached through two launchers');
  assert.equal(aliasToBrew[0].channel, 'brew');
  assert.equal(commandOf(aliasToBrew[0]), '/opt/homebrew/bin/brew upgrade --cask claude-code');
  assert.equal(runOf(aliasToBrew[0]), '/opt/homebrew/bin/brew uninstall --cask claude-code');

  const alsoNpm = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json'],
    links: { '/opt/homebrew/bin/claude': cask },
    texts: { '/opt/homebrew/bin/claude': 'node_modules/@anthropic-ai/claude-code' },
  }) });
  assert.equal(alsoNpm[0].channel, 'brew', 'a link into the Caskroom is not npm-owned because an npm copy shares the folder');

  const keg = '/opt/homebrew/opt/node@20';
  const kegReal = '/opt/homebrew/Cellar/node@20/20.19.0';
  const kegPkg = `${keg}/lib/node_modules/@anthropic-ai/claude-code`;
  const inKeg = listInstallations({ ...mac, onPath: [`${keg}/bin/claude`], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', `${kegPkg}/package.json`, `${keg}/bin/npm`],
    links: { [`${keg}/bin/claude`]: `${kegReal}/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, [kegPkg]: `${kegReal}/lib/node_modules/@anthropic-ai/claude-code` },
  }) });
  assert.equal(inKeg[0].channel, 'npm', 'an npm package under a Homebrew Node keg is still npm-owned');
  assert.equal(commandOf(inKeg[0]), `${keg}/bin/npm install -g --prefix ${keg}`);

  const kegPackage = `${kegReal}/lib/node_modules/@anthropic-ai/claude-code`;
  const kegLayout = {
    files: ['/opt/homebrew/bin/brew', `${kegPkg}/package.json`, `${kegPackage}/package.json`, `${keg}/bin/npm`, `${kegReal}/bin/npm`],
    links: {
      '/Users/a/.local/bin/claude': `${kegPackage}/bin/claude.exe`,
      [`${keg}/bin/claude`]: `${kegPackage}/bin/claude.exe`,
      [keg]: kegReal,
      [kegPkg]: kegPackage,
    },
  };
  const aliasIntoKeg = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude'], fsx: fsx(kegLayout) });
  assert.equal(aliasIntoKeg[0].channel, 'npm', 'a link into a package under a Homebrew Node keg is npm-owned, not the Node formula');
  assert.equal(commandOf(aliasIntoKeg[0]), `${kegReal}/bin/npm install -g --prefix ${kegReal}`);
  assert.equal(runOf(aliasIntoKeg[0]), `${kegReal}/bin/npm uninstall -g --prefix ${kegReal} @anthropic-ai/claude-code`);
  const aliasAndLauncher = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', `${keg}/bin/claude`], fsx: fsx(kegLayout) });
  assert.deepEqual(aliasAndLauncher.map((i) => i.channel), ['npm'], 'the alias and the npm launcher are one installation');

  const foreign = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew'], links: { '/opt/homebrew/bin/claude': '/opt/homebrew/Cellar/sometool/1.0/bin/claude' },
  }) });
  assert.equal(foreign[0].channel, 'unknown', "a file in another formula's keg is not attributed to that formula");
  assert.equal(foreign[0].update, null);
  assert.equal(foreign[0].uninstall, null);

  const elsewhere = '/opt/tools/claude/claude';
  const aliasFirst = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', '/opt/tools/bin/claude'], fsx: fsx({
    links: { '/Users/a/.local/bin/claude': elsewhere, '/opt/tools/bin/claude': elsewhere },
  }) });
  assert.equal(aliasFirst.length, 1);
  assert.equal(aliasFirst[0].channel, 'unknown', 'a link at the native launcher path does not make its target a native install');
  assert.equal(aliasFirst[0].update, null);
  assert.equal(aliasFirst[0].uninstall, null);
  const aliasSecond = listInstallations({ ...mac, onPath: ['/opt/tools/bin/claude'], known: ['/Users/a/.local/bin/claude'], fsx: fsx({
    links: { '/Users/a/.local/bin/claude': elsewhere, '/opt/tools/bin/claude': elsewhere },
  }) });
  assert.deepEqual(aliasSecond.map((i) => i.channel), ['unknown']);

  const versions = '/Users/a/.local/share/claude/versions/2.1.286';
  const real = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude'], fsx: fsx({ links: { '/Users/a/.local/bin/claude': versions } }) });
  assert.equal(real[0].channel, 'native', "a launcher that links into the installer's own folder is native");
  const pointedAt = listInstallations({ ...mac, onPath: ['/usr/local/bin/claude'], fsx: fsx({
    files: ['/Users/a/.local/bin/claude'], links: { '/usr/local/bin/claude': '/Users/a/.local/bin/claude' },
  }) });
  assert.equal(pointedAt[0].channel, 'native', 'a link that points at the native launcher belongs to it');
  assert.equal(commandOf(pointedAt[0]), '/usr/local/bin/claude update');

  const prefix = 'C:\\Users\\First Last\\AppData\\Roaming\\npm';
  const shim = `${prefix}\\claude.cmd`;
  const spaced = listInstallations({
    provider: claude, platform: 'win32', env: { USERPROFILE: 'C:\\Users\\First Last' }, npmOnPath: 'C:\\Program Files\\nodejs\\npm.cmd',
    onPath: [shim],
    fsx: fsx({
      files: [`${prefix}\\node_modules\\@anthropic-ai\\claude-code\\package.json`],
      texts: { [shim]: '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*' },
    }),
  });
  assert.deepEqual(spaced[0].uninstall.run, {
    file: 'C:\\Program Files\\nodejs\\npm.cmd', args: ['uninstall', '-g', '--prefix', 'C:\\Users\\First Last\\AppData\\Roaming\\npm', '@anthropic-ai/claude-code'],
  });

});

test('an uninstall only deletes paths inside the home folder, never a tool home itself', () => {
  const native = { channel: 'native', resolvedPath: '/Users/a/.local/bin/codex' };
  const env = { HOME: '/Users/a' };
  const planFor = (remove, links = []) => uninstallPlan(native, { channels: { native: { remove, links } } }, env, 'darwin');
  assert.equal(planFor(['~', '~/.codex', '/etc/codex/bin', 'relative/bin', '/Users/a/../b/bin', '/Users/ab/bin/x']), null);
  assert.deepEqual(planFor(['~/.codex', '~/.codex/packages/standalone', '~/.local/bin/../bin/codex'], ['~/.local/bin/codex', '/usr/local/bin/codex']), {
    run: null, remove: ['/Users/a/.codex/packages/standalone', '/Users/a/.local/bin/codex'], links: ['/Users/a/.local/bin/codex', '/usr/local/bin/codex'], launcher: '/Users/a/.local/bin/codex',
  });
  assert.equal(homeRelative('/Users/a/.local/bin/claude', env, 'darwin'), '~/.local/bin/claude');
  assert.equal(homeRelative('/Users/ab/bin/claude', env, 'darwin'), '/Users/ab/bin/claude');
  assert.equal(homeRelative('C:\\USERS\\A\\.grok\\bin\\grok.exe', { USERPROFILE: 'C:\\Users\\a' }, 'win32'), '~\\.grok\\bin\\grok.exe');
  const windows = uninstallPlan(native, { channels: { native: { remove: ['~/AppData/Local/agy', 'C:\\Users\\A\\.grok\\bin', 'D:\\Users\\a\\x\\y'] } } }, { USERPROFILE: 'C:\\Users\\a' }, 'win32');
  assert.deepEqual(windows.remove, ['C:\\Users\\a\\AppData\\Local\\agy', 'C:\\Users\\A\\.grok\\bin']);
  assert.equal(uninstallPlan({ channel: 'unknown' }, { channels: {} }, env, 'darwin'), null);
  assert.equal(uninstallPlan({ channel: 'brew', update: null }, { channels: {} }, env, 'darwin'), null, 'no brew, nothing to run');
});

test('an uninstall plan removes its own files and keeps links that lead elsewhere', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const home = tempDir();
  const share = path.join(home, '.local', 'share', 'tool');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(path.join(share, 'versions'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(share, 'versions', '1.0.0'), 'binary');
  fs.symlinkSync(path.join(share, 'versions', '1.0.0'), path.join(binDir, 'tool'));
  fs.symlinkSync('/usr/bin/env', path.join(binDir, 'foreign'));
  fs.writeFileSync(path.join(binDir, 'agent'), 'someone else');
  fs.symlinkSync(path.join(share, 'versions', '1.0.0'), path.join(binDir, 'helper'));
  const lines = [];
  const code = runPlan({
    remove: [path.join(binDir, 'tool'), path.join(binDir, 'foreign'), share, path.join(home, 'never-there')],
    links: [path.join(binDir, 'agent'), path.join(binDir, 'helper')],
  }, { log: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(fs.existsSync(share), false);
  assert.equal(fs.existsSync(path.join(binDir, 'tool')), false);
  assert.equal(fs.existsSync(path.join(binDir, 'helper')), false);
  assert.equal(fs.lstatSync(path.join(binDir, 'helper'), { throwIfNoEntry: false }), undefined, 'a link into the installation goes even after its target');
  assert.equal(fs.readlinkSync(path.join(binDir, 'foreign')), '/usr/bin/env');
  assert.equal(fs.readFileSync(path.join(binDir, 'agent'), 'utf8'), 'someone else', 'a file named in links is kept unless it is a link');
  assert.ok(lines.some((l) => l.startsWith(`Kept ${path.join(binDir, 'foreign')}`)));
  assert.ok(!lines.some((l) => l.includes('never-there')));
});

test('only links may lie outside home, and Grok\'s /usr/local/bin links are among them', () => {
  const provider = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config/providers.default.json'), 'utf8')).providers.find((p) => p.id === 'xai');
  const native = { channel: 'native', resolvedPath: '/Users/a/.grok/bin/grok' };
  const mac = uninstallPlan(native, provider, { HOME: '/Users/a' }, 'darwin');
  assert.deepEqual(mac.remove, ['/Users/a/.grok/bin', '/Users/a/.grok/downloads', '/Users/a/.grok/completions']);
  assert.deepEqual(mac.links, ['/Users/a/.local/bin/grok', '/Users/a/.local/bin/agent', '/usr/local/bin/grok', '/usr/local/bin/agent']);
  const win = uninstallPlan({ channel: 'native', resolvedPath: 'C:\\Users\\a\\.grok\\bin\\grok.exe' }, provider, { USERPROFILE: 'C:\\Users\\a' }, 'win32');
  assert.deepEqual(win.links, ['C:\\Users\\a\\.local\\bin\\grok', 'C:\\Users\\a\\.local\\bin\\agent'], 'a rootless path names no place on Windows');

  const outside = { channels: { native: { remove: ['/usr/local/bin/tool', '~/.tool/bin'], links: ['/usr/local/bin/tool', 'relative/tool'] } } };
  const plan = uninstallPlan({ channel: 'native', resolvedPath: '/Users/a/.tool/bin/tool' }, outside, { HOME: '/Users/a' }, 'darwin');
  assert.deepEqual(plan.remove, ['/Users/a/.tool/bin'], 'remove never leaves home');
  assert.deepEqual(plan.links, ['/usr/local/bin/tool']);
});

test('a launcher linked from outside home goes with its copy, and other links there stay', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const home = tempDir();
  const system = tempDir();
  const bin = path.join(home, '.grok', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'grok'), 'binary');
  fs.writeFileSync(path.join(home, '.grok', 'config.toml'), 'settings');
  fs.symlinkSync(path.join(bin, 'grok'), path.join(system, 'grok'));
  fs.symlinkSync('/usr/bin/env', path.join(system, 'agent'));
  const lines = [];
  const code = runPlan({
    remove: [bin], links: [path.join(system, 'grok'), path.join(system, 'agent')], launcher: path.join(system, 'grok'),
  }, { log: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(fs.lstatSync(path.join(system, 'grok'), { throwIfNoEntry: false }), undefined, 'no dangling link is left to block a reinstall');
  assert.equal(fs.existsSync(bin), false);
  assert.equal(fs.readlinkSync(path.join(system, 'agent')), '/usr/bin/env', 'a link to another program is kept');
  assert.equal(fs.readFileSync(path.join(home, '.grok', 'config.toml'), 'utf8'), 'settings');
});

test('an uninstall plan stops before deleting anything when its command fails', () => {
  const home = tempDir();
  const keep = path.join(home, 'keep', 'bin');
  fs.mkdirSync(keep, { recursive: true });
  const lines = [];
  const code = runPlan({ run: { file: process.execPath, args: ['-e', 'process.exit(3)'] }, remove: [keep] }, { log: (line) => lines.push(line) });
  assert.equal(code, 3);
  assert.ok(fs.existsSync(keep));
  assert.ok(lines[0].startsWith('> '));

  const out = execFileSync(process.execPath, [RUNNER, encodePlan({ remove: [keep] })], { encoding: 'utf8' });
  assert.equal(out.trim(), `Removed ${keep}`);
  assert.equal(fs.existsSync(keep), false);
});

test('an uninstall that fails at any step leaves the copy findable and launchable, and a retry finishes it', () => {
  const posix = process.platform !== 'win32';
  const file = (home, rel) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), rel);
  };
  const link = (home, rel, to) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.symlinkSync(path.join(home, to), path.join(home, rel));
  };
  const layouts = {
    'Claude Code on Windows': (h) => {
      file(h, '.local/bin/claude.exe');
      file(h, '.local/share/claude/versions/2.1.300');
      return { remove: ['.local/bin/claude.exe', '.local/share/claude'], launcher: '.local/bin/claude.exe' };
    },
    'Antigravity CLI on Windows': (h) => {
      for (const rel of ['agy/bin/agy.exe', 'agy/bin/helper.dll', 'agy/state.json']) file(h, rel);
      return { remove: ['agy'], launcher: 'agy/bin/agy.exe' };
    },
    'Grok Build': (h) => {
      for (const rel of ['.grok/bin/grok', '.grok/bin/agent', '.grok/downloads/grok-1.0.46', '.grok/completions/bash/grok.bash']) file(h, rel);
      return { remove: ['.grok/bin', '.grok/downloads', '.grok/completions'], launcher: '.grok/bin/grok' };
    },
    ...(posix && {
      'Claude Code on macOS and Linux': (h) => {
        file(h, '.local/share/claude/versions/2.1.299');
        file(h, '.local/share/claude/versions/2.1.300');
        link(h, '.local/bin/claude', '.local/share/claude/versions/2.1.300');
        return { remove: ['.local/bin/claude', '.local/share/claude'], launcher: '.local/bin/claude' };
      },
      'Codex CLI on macOS and Linux': (h) => {
        for (const rel of ['bin/codex', 'bin/host', 'bin/rg']) file(h, `.codex/packages/standalone/releases/0.160.0/${rel}`);
        file(h, '.codex/packages/standalone/releases/0.159.0/bin/codex');
        link(h, '.codex/packages/standalone/current', '.codex/packages/standalone/releases/0.160.0');
        link(h, '.local/bin/codex', '.codex/packages/standalone/current/bin/codex');
        link(h, '.local/bin/codex-code-mode-host', '.codex/packages/standalone/current/bin/host');
        return { remove: ['.local/bin/codex', '.local/bin/codex-code-mode-host', '.codex/packages/standalone'], launcher: '.local/bin/codex' };
      },
      'Codex CLI behind a folder link, as its Windows junction': (h) => {
        file(h, '.codex/packages/standalone/releases/0.160.0/bin/codex');
        file(h, '.codex/packages/standalone/releases/0.160.0/bin/host');
        link(h, '.codex/packages/standalone/current', '.codex/packages/standalone/releases/0.160.0');
        link(h, 'Programs/Codex/bin', '.codex/packages/standalone/current/bin');
        return { remove: ['Programs/Codex/bin', '.codex/packages/standalone'], launcher: 'Programs/Codex/bin/codex' };
      },
      'Grok Build found through its links': (h) => {
        for (const rel of ['.grok/bin/grok', '.grok/bin/agent', '.grok/downloads/grok-1.0.46']) file(h, rel);
        link(h, '.local/bin/grok', '.grok/bin/grok');
        link(h, '.local/bin/agent', '.grok/bin/agent');
        return { remove: ['.grok/bin', '.grok/downloads'], links: ['.local/bin/grok', '.local/bin/agent'], launcher: '.local/bin/grok' };
      },
    }),
  };
  const build = (layout) => {
    const home = tempDir();
    const spec = layout(home);
    const abs = (rel) => path.join(home, rel);
    return { remove: spec.remove.map(abs), links: (spec.links || []).map(abs), launcher: abs(spec.launcher) };
  };
  const gone = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined;
  const quiet = () => {};

  const holdsFiles = (p) => {
    const stat = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return false;
    return stat.isDirectory() ? fs.readdirSync(p).some((n) => holdsFiles(path.join(p, n))) : true;
  };

  for (const [name, layout] of Object.entries(layouts)) {
    const deletions = [];
    let launcherGoneAt = -1;
    const clean = build(layout);
    const rmClean = (p) => {
      if (launcherGoneAt !== -1) assert.ok(!holdsFiles(p), `${name}: after the launcher stops working, ${p} holds no files`);
      deletions.push(p);
      fs.rmSync(p, { recursive: true, force: true });
      if (launcherGoneAt === -1 && !fs.existsSync(clean.launcher)) launcherGoneAt = deletions.length - 1;
    };
    assert.equal(runPlan(clean, { log: quiet, rm: rmClean }), 0, name);
    assert.ok([...clean.remove, ...clean.links].every(gone), `${name}: a clean run removes everything`);
    assert.ok(launcherGoneAt > 0, `${name}: other files go before the launcher stops working`);

    for (let failAt = 0; failAt < deletions.length; failAt++) {
      const plan = build(layout);
      let calls = 0;
      const rm = (p) => {
        if (calls++ === failAt) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
        fs.rmSync(p, { recursive: true, force: true });
      };
      const lines = [];
      assert.equal(runPlan(plan, { log: (l) => lines.push(l), rm }), 1, `${name}, failing at deletion ${failAt}`);
      assert.equal(calls, failAt + 1, `${name}, failing at deletion ${failAt}: nothing is deleted after a failure`);
      assert.match(lines.at(-1), /^Could not remove .+: it is in use\. Stopped there\./, lines.join('\n'));
      if (failAt <= launcherGoneAt) assert.ok(fs.existsSync(plan.launcher), `${name}, failing at deletion ${failAt}: the launcher still works`);
      assert.equal(runPlan(plan, { log: quiet }), 0, `${name}, failing at deletion ${failAt}: a retry succeeds`);
      assert.ok([...plan.remove, ...plan.links].every(gone), `${name}, failing at deletion ${failAt}: a retry removes everything`);
    }
  }
});

test('shared npm cleanup remains discoverable and retryable after failure at each deletion', () => {
  const provider = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config/providers.default.json'), 'utf8')).providers.find((p) => p.id === 'xai');
  const win = process.platform === 'win32';
  const quiet = () => {};
  const prepare = () => {
    const home = tempDir();
    const env = { HOME: home, USERPROFILE: home };
    const prefix = path.join(home, 'npm');
    const wrapper = path.join(prefix, win ? 'grok.cmd' : 'bin/grok');
    const manifest = path.join(prefix, win ? '' : 'lib', 'node_modules/@xai-official/grok/package.json');
    const native = path.join(home, '.grok/bin', win ? 'grok.exe' : 'grok');
    const settings = path.join(home, '.grok/config.toml');
    for (const file of [wrapper, manifest, native, settings, path.join(home, '.grok/bin/agent'), path.join(home, '.grok/downloads/grok-1.0.46'), path.join(home, '.grok/completions/bash/grok.bash')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file === wrapper ? 'node_modules/@xai-official/grok' : 'fixture');
    }
    const discover = () => listInstallations({
      provider, env, npmOnPath: process.execPath,
      onPath: fs.existsSync(wrapper) ? [wrapper] : [],
      known: knownLaunchers({ provider, command: provider.command, env }),
    });
    const [copy] = discover();
    assert.equal(copy.channel, 'npm');
    assert.deepEqual(copy.uninstall.run, { file: process.execPath, args: ['uninstall', '-g', '--prefix', prefix, provider.package] });
    assert.equal(copy.uninstall.launcher, native);
    // Stand in for npm by removing its wrapper and package manifest in a child process.
    const plan = { ...copy.uninstall, run: {
      file: process.execPath,
      args: ['-e', 'const fs = require("node:fs"); for (const file of process.argv.slice(1)) fs.unlinkSync(file);', wrapper, manifest],
    } };
    return { plan, discover, wrapper, manifest, native, settings };
  };
  const gone = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined;
  const holdsFiles = (p) => {
    const stat = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!stat) return false;
    return stat.isDirectory() ? fs.readdirSync(p).some((n) => holdsFiles(path.join(p, n))) : true;
  };
  const clean = prepare();
  let deletions = 0;
  assert.equal(runPlan(clean.plan, { log: quiet, rm: (p) => {
    deletions++;
    fs.rmSync(p, { recursive: true, force: true });
  } }), 0);
  assert.ok(clean.plan.remove.every(gone));
  assert.deepEqual(clean.discover(), []);
  assert.equal(fs.readFileSync(clean.settings, 'utf8'), 'fixture');

  for (let failAt = 0; failAt < deletions; failAt++) {
    const { plan, discover, wrapper, manifest, native, settings } = prepare();
    let calls = 0;
    assert.equal(runPlan(plan, { log: quiet, rm: (p) => {
      assert.ok(gone(wrapper) && gone(manifest), 'npm cleanup completes before native deletion starts');
      if (calls++ === failAt) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      fs.rmSync(p, { recursive: true, force: true });
    } }), 1, `failure at deletion ${failAt}`);
    assert.equal(calls, failAt + 1);
    const copies = discover();
    if (plan.remove.some(holdsFiles)) {
      assert.equal(copies.length, 1, `deletion ${failAt}: files left behind must remain discoverable`);
      assert.equal(copies[0].resolvedPath, native);
      assert.equal(copies[0].channel, 'native');
      assert.equal(copies[0].onPath, false, 'the native launcher is found even when only the npm wrapper was on PATH');
      assert.equal(copies[0].uninstall.run, null, 'the retry no longer needs npm');
      assert.equal(runPlan(copies[0].uninstall, { log: quiet }), 0, `deletion ${failAt}: a freshly discovered plan completes cleanup`);
      assert.ok(plan.remove.every(gone));
    } else {
      assert.deepEqual(copies, [], 'only empty directories can remain once the launcher is gone');
    }
    assert.equal(fs.readFileSync(settings, 'utf8'), 'fixture');
  }
});

test('other copies of a tool are reported with their versions, and wrappers of one copy are not', async () => {
  const win = process.platform === 'win32';
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
  const root = tempDir();
  const launcher = (dir, version) => {
    fs.mkdirSync(dir, { recursive: true });
    const versionFile = path.join(dir, 'version.txt');
    fs.writeFileSync(versionFile, version);
    const file = path.join(dir, win ? 'dup.cmd' : 'dup');
    fs.writeFileSync(file, win
      ? `@echo off\r\nset "FAKE_TOOL_VERSION_FILE=${versionFile}"\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nFAKE_TOOL_VERSION_FILE="${versionFile}" exec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
    return file;
  };
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  const copyA = launcher(dirA, '1.0.0');
  const copyB = launcher(dirB, '2.0.0');
  const wrappers = path.join(root, 'wrappers');
  fs.mkdirSync(wrappers);
  if (win) {
    fs.writeFileSync(path.join(dirA, 'dup.ps1'), '& "$PSScriptRoot\\dup.cmd" @args\r\n');
    fs.writeFileSync(path.join(dirA, 'dup'), '#!/bin/sh\n');
  } else {
    fs.symlinkSync(copyA, path.join(wrappers, 'dup'));
  }
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'dup', tool: 'Dup Tool', command: 'dup', package: 'dup-pkg', versionArgs: ['--version'], channels: { native: { paths: [path.join(dirA, 'dup')], update: ['update'], remove: [path.join(dirA, 'dup')] } } },
  ] }));
  const base = { PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root };
  const registryFor = (dirs) => new ProviderRegistry({ userFile, env: { ...base, PATH: dirs.join(path.delimiter) }, checkUpdates: false });

  const single = registryFor([dirA, wrappers]);
  await single.refreshVersions();
  const one = single.describe(single.get('dup'));
  assert.equal(one.installs.length, 1, 'several wrappers of one installation are one installation');
  assert.deepEqual(one.warnings, []);

  const olderFirst = registryFor([dirA, wrappers, dirB]);
  await olderFirst.refreshVersions();
  const shadowed = olderFirst.describe(olderFirst.get('dup'));
  assert.deepEqual(shadowed.installs.map((i) => [i.path, i.channel, i.version, i.active, i.newer, i.uninstall]), [
    [copyA, 'native', '1.0.0', true, false, { command: null, remove: [path.join('~', 'a', 'dup')] }],
    [copyB, 'unknown', '2.0.0', false, true, null],
  ]);
  assert.equal(shadowed.installedVersion, '1.0.0');
  assert.equal(shadowed.warnings.length, 2);
  assert.match(shadowed.warnings[0], /^2 copies of Dup Tool are installed\. The one in use is native v1\.0\.0 at /);
  assert.match(shadowed.warnings[1], /^An older copy comes first on PATH: native v1\.0\.0 is in use while unknown install v2\.0\.0 is installed at /);

  const newerFirst = registryFor([dirB, dirA]);
  await newerFirst.refreshVersions();
  const fine = newerFirst.describe(newerFirst.get('dup'));
  assert.deepEqual(fine.installs.map((i) => [i.channel, i.version, i.active, i.newer]), [['unknown', '2.0.0', true, false], ['native', '1.0.0', false, false]]);
  assert.equal(fine.warnings.length, 1);

  const offPath = registryFor([path.join(root, 'empty')]);
  const hidden = offPath.describe(offPath.get('dup'));
  assert.equal(hidden.available, false);
  assert.deepEqual(hidden.installs.map((i) => [i.path, i.channel, i.active, i.onPath]), [[copyA, 'native', false, false]]);
  assert.match(hidden.warnings[0], /^A copy of Dup Tool exists at .* but its folder is not on PATH\.$/);
});

test('PATH is refreshed for detection and sessions alike, within limits', async () => {
  const win = process.platform === 'win32';
  const root = tempDir();
  const toolDir = path.join(root, 'tool');
  const emptyDir = path.join(root, 'empty');
  const otherDir = path.join(root, 'other');
  for (const dir of [toolDir, emptyDir, otherDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(toolDir, win ? 'latecomer.cmd' : 'latecomer'), win ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'late', tool: 'Latecomer', command: 'latecomer' },
    { id: 'pinned', tool: 'Pinned', command: 'latecomer', env: { PATH: otherDir } },
  ] }));
  const env = { PATHEXT: '.EXE;.CMD', ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, PATH: emptyDir };
  let discovered = emptyDir;
  let reads = 0;
  const registry = new ProviderRegistry({ userFile, env, checkUpdates: false, pathReader: async () => { reads++; return discovered; } });
  const late = registry.get('late');
  assert.equal(registry.describe(late).available, false);

  await registry.refreshVersions();
  assert.equal(reads, 1);
  discovered = [emptyDir, toolDir].join(path.delimiter);
  await registry.refreshVersions();
  assert.equal(reads, 1, 'the PATH is not read again within the minimum interval');
  assert.equal(registry.describe(late).available, false);

  await registry.refreshVersions({ force: true });
  assert.equal(reads, 2);
  assert.equal(registry.describe(late).available, true, 'a tool installed after startup is found without a restart');
  assert.equal(env.PATH, [emptyDir, toolDir].join(path.delimiter), 'the launch environment gains the new folder');
  assert.equal(mergeEnv([env, late.env]).PATH, env.PATH, 'new sessions start with the PATH detection used');

  const pinned = registry.get('pinned');
  assert.equal(registry.describe(pinned).available, false, "a provider's own PATH still decides for that provider");
  assert.equal(mergeEnv([env, pinned.env]).PATH, otherDir);

  discovered = null;
  await registry.refreshVersions({ force: true });
  assert.equal(registry.describe(late).available, true, 'a failed read keeps the last working PATH');
  const failing = new ProviderRegistry({ userFile, env: { ...env }, checkUpdates: false, pathReader: async () => { throw new Error('reader broke'); } });
  await failing.refreshVersions({ force: true });
  assert.equal(failing.describe(failing.get('late')).available, true);

  const semi = { delimiter: ';', caseInsensitive: true };
  assert.equal(weavePaths('A;B', 'A;NEW;B;LAST', semi), 'A;NEW;B;LAST');
  assert.equal(weavePaths('X;A;B', 'NEW;A;B', semi), 'X;NEW;A;B', 'entries only the launch environment has are kept');
  assert.equal(weavePaths('C:\\A;C:\\b\\', 'c:\\a;C:\\B;C:\\New', semi), 'C:\\A;C:\\b\\;C:\\New');
  assert.equal(weavePaths('', 'A;B', semi), 'A;B');
  assert.equal(weavePaths('A', '', semi), 'A');
  assert.equal(weavePaths('/a:/b', '/A:/b:/c', { delimiter: ':', caseInsensitive: false }), '/a:/A:/b:/c');

  const userOut = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;%Missing%\\y\r\n\r\n';
  const machineOut = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Windows\r\n';
  assert.equal(parseRegValue(userOut), '%USERPROFILE%\\bin;%Missing%\\y');
  assert.equal(parseRegValue('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(expandWindowsVars('%USERPROFILE%\\bin;%Missing%\\y', { UserProfile: 'C:\\Users\\a' }), 'C:\\Users\\a\\bin;%Missing%\\y');
  const query = (outputs) => async (key) => outputs[key.startsWith('HKLM') ? 'machine' : 'user'];
  const winEnv = { USERPROFILE: 'C:\\Users\\a' };
  assert.equal(await readWindowsPath({ env: winEnv, query: query({ machine: machineOut, user: userOut }) }), 'C:\\Windows;C:\\Users\\a\\bin;%Missing%\\y');
  assert.equal(await readWindowsPath({ env: winEnv, query: query({ machine: machineOut, user: null }) }), 'C:\\Windows');
  assert.equal(await readWindowsPath({ env: winEnv, query: query({ machine: null, user: userOut }) }), null, 'no machine PATH means the read failed');
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
  assert.deepEqual(await probeVersion(buildSpawnSpec(process.execPath, [fake, '--version'])), { ok: true, version: '1.2.3', exitCode: 0, error: null });
  const absent = await probeVersion({ file: path.join(tempDir(), 'missing'), args: [] });
  assert.equal(absent.ok, false);
  assert.equal(absent.version, null);

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
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath), HOME: dir, USERPROFILE: dir }, checkUpdates: false });
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
      return { ok: true, json: async () => ({
        five_hour: { utilization: 42.55, resets_at: '2030-01-01T05:00:00Z' },
        seven_day: { utilization: 12, resets_at: 1893456000 },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 30, resets_at: 1893456000 },
        // Per-model rows as the endpoint lists them: Fable only appears here,
        // and the Sonnet row repeats seven_day_sonnet.
        limits: [
          { kind: 'session', group: 'session', percent: 42.55, resets_at: '2030-01-01T05:00:00Z' },
          { kind: 'weekly_scoped', group: 'weekly', percent: 55.55, resets_at: '2030-01-01T00:00:00Z', scope: { model: { display_name: 'Fable 5.1' } } },
          { kind: 'weekly_scoped', group: 'weekly', percent: 30, resets_at: '2030-01-01T00:00:00Z', scope: { model: { display_name: 'Sonnet' } } },
          { kind: 'weekly_scoped', group: 'weekly', percent: 1, resets_at: null, scope: { surface: { display_name: 'no model' } } },
          { kind: 'spend', group: 'monthly', percent: 25, resets_at: '2030-02-01T00:00:00Z', is_active: false },
          { kind: 'spend', group: 'monthly', percent: 25, resets_at: '2030-03-01T00:00:00Z', is_active: true },
          null,
        ],
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD' },
      }) };
    }
    return { ok: true, json: async () => ({
      plan_type: 'plus',
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1893456000 }, secondaryWindow: { usedPercent: 80, limitWindowSeconds: 604800, resetAfterSeconds: 60 } },
      additional_rate_limits: [
        { limit_name: 'Spark', metered_feature: 'spark', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1893456000 }, secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1893456000 } } },
        { limit_name: '', metered_feature: 'review', rate_limit: { primary_window: { used_percent: 5 }, secondary_window: { used_percent: 95 } } },
        { metered_feature: '  ' },
        null,
      ],
      credits: { has_credits: true, unlimited: false, balance: 12.5 },
    }) };
  };
  const claude = await fetchClaudeUsage({ accessToken: 'tok', plan: 'max', version: '2.1.0', fetchImpl });
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen[0].headers['User-Agent'], 'claude-code/2.1.0');
  assert.deepEqual(claude, { plan: 'max', windows: [
    { label: '5-hour', usedPercent: 42.6, resetsAt: '2030-01-01T05:00:00.000Z' },
    { label: '7-day', usedPercent: 12, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: '7-day Sonnet', usedPercent: 30, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: '7-day Fable 5.1', usedPercent: 55.6, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: 'Extra usage', usedPercent: 25, resetsAt: '2030-03-01T00:00:00.000Z' },
  ] });
  const claudeAgain = async (body) => (await fetchClaudeUsage({ accessToken: 'tok', fetchImpl: async () => ({ ok: true, json: async () => body }) })).windows;
  assert.deepEqual(await claudeAgain({ five_hour: { utilization: 1 }, limits: 'nope', extra_usage: { is_enabled: false, monthly_limit: 100, used_credits: 100 } }),
    [{ label: '5-hour', usedPercent: 1, resetsAt: null }], 'extra usage that is not enabled has no meter');
  assert.deepEqual(await claudeAgain({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: null, utilization: 40 } }),
    [{ label: 'Extra usage', usedPercent: 40, resetsAt: null }], 'without amounts the share is the server utilization');
  assert.deepEqual(await claudeAgain({ extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 7, utilization: null } }), [], 'an unknown share has no meter');
  assert.deepEqual(await claudeAgain({ limits: [{ kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Opus 4.8' } } }] }),
    [{ label: '7-day Opus 4.8', usedPercent: 9, resetsAt: null }], 'a per-model row stands alone when its fixed key is absent');
  assert.deepEqual(await claudeAgain({ seven_day_opus: { utilization: 20 }, limits: [
    { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Opus 4.1' } } },
    { kind: 'weekly_scoped', percent: 20, scope: { model: { display_name: 'opus' } } },
    { kind: 'weekly_scoped', percent: 50, scope: { model: { id: 'claude-fable-5-1' } } },
    { kind: 'weekly_scoped', percent: ' ', scope: { model: { display_name: 'Blank' } } },
  ] }), [
    { label: '7-day Opus', usedPercent: 20, resetsAt: null },
    { label: '7-day Opus 4.1', usedPercent: 95, resetsAt: null },
    { label: '7-day claude-fable-5-1', usedPercent: 50, resetsAt: null },
  ], 'a versioned row is its own limit, the family row repeats the fixed window, and a model falls back to its id');
  assert.deepEqual(await claudeAgain({ extra_usage: { is_enabled: true, monthly_limit: '5000', used_credits: '500' } }),
    [{ label: 'Extra usage', usedPercent: 10, resetsAt: null }], 'amounts sent as strings are read');
  assert.deepEqual(await claudeAgain({ seven_day_sonnet: { utilization: 20 }, limits: [
    { kind: 'weekly_scoped', percent: 20, scope: { model: { display_name: 'Sonnet' } } },
    { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Sonnet' }, surface: { display_name: 'Cowork' } } },
    { kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'Twin' } } },
    { kind: 'weekly_scoped', percent: 2, scope: { model: { display_name: 'Twin' } } },
  ] }), [
    { label: '7-day Sonnet', usedPercent: 20, resetsAt: null },
    { label: '7-day Sonnet (Cowork)', usedPercent: 95, resetsAt: null },
    { label: '7-day Twin', usedPercent: 1, resetsAt: null },
    { label: '7-day Twin (2)', usedPercent: 2, resetsAt: null },
  ], 'only the plan-wide row repeats the fixed window; a surface-scoped row and a repeated name are both kept');

  const codex = await fetchCodexUsage({ accessToken: 'ctok', accountId: 'acc-1', fetchImpl });
  assert.equal(seen[1].headers['ChatGPT-Account-Id'], 'acc-1');
  assert.equal(codex.plan, 'plus');
  assert.equal(codex.credits, 12.5);
  assert.deepEqual(codex.windows[0], { label: '5-hour', usedPercent: 30, resetsAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(codex.windows[1].label, '7-day');
  assert.equal(codex.windows[1].usedPercent, 80);
  assert.ok(Date.parse(codex.windows[1].resetsAt) - Date.now() > 50000);
  assert.deepEqual(codex.windows.slice(2), [
    { label: 'Spark 5-hour', usedPercent: 10, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: 'Spark 7-day', usedPercent: 100, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: 'review primary', usedPercent: 5, resetsAt: null },
    { label: 'review secondary', usedPercent: 95, resetsAt: null },
  ], 'additional limits are named after the limit or its feature, and keep both windows');
  const codexAgain = async (body) => fetchCodexUsage({ accessToken: 'ctok', fetchImpl: async () => ({ ok: true, json: async () => body }) });
  assert.deepEqual(await codexAgain({ plan_type: 'pro', rate_limit: {}, credits: { has_credits: true, unlimited: true, balance: 0 } }), { plan: 'pro', windows: [], credits: null }, 'unlimited credits have no balance');
  assert.deepEqual(await codexAgain({ plan_type: 'plus', credits: { has_credits: false, unlimited: false, balance: null } }), { plan: 'plus', windows: [], credits: null }, 'no credits is not a zero balance');
  assert.equal((await codexAgain({ credits: { has_credits: true, unlimited: false, balance: '3.25' } })).credits, 3.25, 'a balance sent as a string is read');
  assert.equal((await codexAgain({ credits: { has_credits: true, unlimited: false, balance: ' ' } })).credits, null, 'a blank balance is unknown');
  const bare = await codexAgain({ additional_rate_limits: [{ limit_name: 'A model name that is far too long for a meter', primary_window: { used_percent: 1, limit_window_seconds: 18000 }, secondary_window: { used_percent: ' ', limit_window_seconds: 604800 } }] });
  assert.deepEqual(bare.windows, [{ label: 'A model name that is far too 5-hour', usedPercent: 1, resetsAt: null }], 'windows on the entry itself are read, the name is shortened, and a blank share is skipped');
  const blankReset = await codexAgain({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: '' } } });
  assert.deepEqual(blankReset.windows, [{ label: '5-hour', usedPercent: 30, resetsAt: null }], 'a blank reset delay is unknown, not now');

  for (const unknown of [null, undefined, '', ' ', false, true, [], {}, 'soon', NaN]) assert.equal(clampPercent(unknown), null, `clampPercent(${JSON.stringify(unknown)}) is unknown`);
  assert.equal(clampPercent('42.26'), 42.3);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(140), 100);

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
    { id: 'xai', usage: 'gemini', history: 'gemini', reporting: 'gemini' },
  ] }));
  const defaults = loadProviders({ platform: 'linux' }).providers;
  assert.equal(defaults.find((p) => p.id === 'anthropic').usage, 'claude');
  assert.equal(defaults.find((p) => p.id === 'openai').usage, 'codex');
  assert.equal(defaults.find((p) => p.id === 'google').usage, null);
  const xai = defaults.find((p) => p.id === 'xai');
  assert.equal(xai.package, '@xai-official/grok');
  assert.deepEqual(xai.resumeArgs, ['--resume', '{id}']);
  assert.deepEqual(xai.versionArgs, ['--version']);
  assert.match('using grok-build now', new RegExp(xai.modelPattern, 'i'));
  assert.match('grok-4-1-fast', new RegExp(xai.modelPattern, 'i'));
  const registry = new ProviderRegistry({ userFile, env, checkUpdates: false });
  assert.deepEqual([registry.get('xai').usage, registry.get('xai').history, registry.get('xai').reporting], [null, null, null], 'sources of a removed tool are dropped');
  let fetches = 0;
  const files = {};
  const monitor = new UsageMonitor({
    registry,
    env: { ...env, CODEX_HOME: path.join(dir, 'codex-home') },
    fetchImpl: async (url) => {
      fetches++;
      return { ok: true, json: async () => ({ five_hour: { utilization: 5 } }) };
    },
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
  assert.equal(byId.xai, undefined, 'a provider without a usage source is not checked');
  assert.equal(files.claude, path.join(dir, 'claude-work', '.credentials.json'), "the provider's own env picks its credentials");
  assert.equal(files.claudeService, claudeKeychainService({ CLAUDE_CONFIG_DIR: path.join(dir, 'claude-work') }), 'and its keychain item');
  assert.equal(files.codex, path.join(dir, 'codex-home', 'auth.json'), 'the manager env applies otherwise');
  await monitor.all();
  assert.equal(fetches, 1, 'fresh snapshots are served from the cache');
});

test('accounts get their own home folder and environment, the default keeps the tool\'s own', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', accounts: [{ id: 'work', label: ' Work ' }, { id: 'personal', dir: '~/.claude-personal' }, { id: 'default', label: 'Main', dir: '/ignored' }, { id: 'Bad Id' }, { id: 'work' }, 'shared', 7] },
    { id: 'openai', accounts: 'work' },
    { id: 'shell', accounts: [{ id: 'other' }] },
    { id: 'google', accounts: [{ id: 'work' }] },
    { id: 'xai', homeVar: 'not a name', accounts: [{ id: 'x' }], hooks: { path: '../settings.json', example: 'grok-hooks.json' } },
  ] }));
  const { providers, warnings } = loadProviders({ userFile, platform: 'linux' });
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  assert.deepEqual(byId.anthropic.accounts, [
    { id: 'default', label: 'Main', dir: null },
    { id: 'work', label: 'Work', dir: null },
    { id: 'personal', label: 'Personal', dir: '~/.claude-personal' },
    { id: 'shared', label: 'Shared', dir: null },
  ]);
  assert.deepEqual(byId.openai.accounts, [{ id: 'default', label: 'Default', dir: null }]);
  assert.deepEqual(byId.shell.accounts, [{ id: 'default', label: 'Default', dir: null }]);
  assert.deepEqual(byId.xai.accounts, [{ id: 'default', label: 'Default', dir: null }]);
  assert.equal(byId.xai.homeVar, null);
  assert.equal(byId.xai.hooks, null, 'a hooks path cannot leave the home folder');
  assert.deepEqual(byId.anthropic.hooks, { path: 'settings.json', example: 'claude-code-settings.json' });
  assert.equal(byId.google.homeVar, null);
  assert.deepEqual(byId.google.accounts, [{ id: 'default', label: 'Default', dir: null }], 'Antigravity CLI keeps one sign-in, in the OS keyring');
  const expected = ['ignored dir of the default account', 'invalid id "Bad Id"', 'duplicate account "work"', 'invalid id 7', 'openai": ignored accounts; it must be an array', 'shell": ignored accounts; the provider has no homeVar', 'google": ignored accounts; the provider has no homeVar', 'xai": ignored accounts; the provider has no homeVar'];
  for (const text of expected) assert.ok(warnings.some((w) => w.includes(text)), `${text} in ${JSON.stringify(warnings)}`);
  assert.equal(warnings.length, expected.length, JSON.stringify(warnings));

  const accountsDir = '/data/accounts';
  const registry = new ProviderRegistry({ userFile, env: { PATH: '', HOME: '/Users/a' }, platform: 'linux', checkUpdates: false, accountsDir });
  const anthropic = registry.get('anthropic');
  const claudeEnv = (home) => ({ CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home });
  assert.deepEqual(registry.accountsFor(anthropic), [
    { id: 'default', label: 'Main', dir: null, env: {} },
    { id: 'work', label: 'Work', dir: '/data/accounts/anthropic/work', env: claudeEnv('/data/accounts/anthropic/work') },
    { id: 'personal', label: 'Personal', dir: '/Users/a/.claude-personal', env: claudeEnv('/Users/a/.claude-personal') },
    { id: 'shared', label: 'Shared', dir: '/data/accounts/anthropic/shared', env: claudeEnv('/data/accounts/anthropic/shared') },
  ], 'the secure-storage folder follows the account, so an inherited one cannot point every account at one sign-in');
  assert.deepEqual(registry.account(registry.get('google'), 'default').env, {});
  assert.deepEqual(registry.account(anthropic), registry.accountsFor(anthropic)[0]);
  assert.deepEqual(registry.account(anthropic, 'work'), registry.accountsFor(anthropic)[1]);
  assert.throws(() => registry.account(anthropic, 'nope'), (err) => err.status === 404 && err.code === 'unknown_account');
  assert.deepEqual(registry.describe(anthropic).accounts, [{ id: 'default', label: 'Main' }, { id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }, { id: 'shared', label: 'Shared' }]);
  assert.deepEqual(registry.describe(registry.get('openai')).accounts, [{ id: 'default', label: 'Default' }]);

  const relativeFile = path.join(dir, 'relative.json');
  fs.writeFileSync(relativeFile, JSON.stringify({ providers: [{ id: 'anthropic', accounts: [{ id: 'two', dir: 'claude-two' }] }] }));
  const relative = loadProviders({ userFile: relativeFile, platform: 'linux' }).providers[0];
  assert.equal(registry.accountFor(relative, relative.accounts[1]).dir, '/data/accounts/anthropic/claude-two', 'a relative dir lives under the provider\'s accounts folder');
  const windows = new ProviderRegistry({ userFile, env: { PATH: '', USERPROFILE: 'C:\\Users\\a' }, platform: 'win32', checkUpdates: false, accountsDir: 'C:\\Data\\accounts' });
  assert.deepEqual(windows.account(windows.get('anthropic'), 'personal').env, claudeEnv('C:\\Users\\a\\.claude-personal'));
  assert.equal(windows.account(windows.get('anthropic'), 'work').env.CLAUDE_CONFIG_DIR, 'C:\\Data\\accounts\\anthropic\\work');

  const dataDirDefault = new ProviderRegistry({ userFile, env: { PATH: '' }, platform: 'linux', checkUpdates: false });
  assert.equal(dataDirDefault.accountsDir, paths.accounts, 'accounts live in the data folder by default');
  assert.equal(dataDirDefault.account(dataDirDefault.get('anthropic'), 'work').dir, path.posix.join(paths.accounts, 'anthropic', 'work'));
});

test('usage is read per account, from that account\'s home folder only', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', accounts: [{ id: 'work' }] },
    { id: 'openai', usage: null },
    { id: 'xai', usage: null },
  ] }));
  const accountsDir = path.join(dir, 'accounts');
  const registry = new ProviderRegistry({ userFile, env: { PATH: '' }, checkUpdates: false, accountsDir });
  const claudeHome = path.join(dir, 'claude-home');
  fs.mkdirSync(claudeHome);
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'pro' } }));
  let fetches = 0;
  const monitor = new UsageMonitor({
    registry,
    platform: 'linux',
    env: { PATH: '', CLAUDE_CONFIG_DIR: claudeHome },
    fetchImpl: async () => {
      fetches++;
      return { ok: true, json: async () => ({ five_hour: { utilization: 5 } }) };
    },
  });
  const all = await monitor.all();
  const byKey = Object.fromEntries(all.map((u) => [`${u.providerId}/${u.accountId}`, u]));
  assert.deepEqual(Object.keys(byKey), ['anthropic/default', 'anthropic/work']);
  assert.equal(byKey['anthropic/default'].signedIn, true);
  assert.equal(byKey['anthropic/default'].plan, 'pro');
  assert.deepEqual(byKey['anthropic/default'].windows, [{ label: '5-hour', usedPercent: 5, resetsAt: null }]);
  assert.equal(byKey['anthropic/work'].signedIn, false, 'an account without a credentials file is not signed in');
  assert.match(byKey['anthropic/work'].error, new RegExp(path.join('accounts', 'anthropic', 'work').replace(/\\/g, '\\\\')));
  assert.deepEqual(byKey['anthropic/work'].windows, []);
  await monitor.all();
  assert.equal(fetches, 1, 'each account has its own cache entry');
});

const jsonl = (...records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
function writeAt(file, contents, when) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  fs.utimesSync(file, new Date(when), new Date(when));
}

test('Claude Code sessions are read from the head of each project transcript', async () => {
  const dir = tempDir();
  const project = path.join(dir, 'projects', '-home-me-app');
  const user = (text, extra = {}) => ({ type: 'user', cwd: '/home/me/app', sessionId: 'x', timestamp: '2026-09-30T10:00:00.000Z', message: { role: 'user', content: text }, ...extra });
  writeAt(path.join(project, 'aaaaaaaa-1111.jsonl'), jsonl(
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-30T09:59:59.000Z', sessionId: 'aaaaaaaa-1111', content: 'Fix the login bug' },
    user('Fix the   login\nbug, please'),
    { type: 'assistant', cwd: '/home/me/app', timestamp: '2026-09-30T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] } },
  ), '2026-09-30T10:05:00.000Z');
  writeAt(path.join(project, 'bbbbbbbb-2222.jsonl'), jsonl(
    user('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }], { toolUseResult: {} }),
    user('ignored sidechain', { isSidechain: true }),
    '{"type":"user", not json',
    user([{ type: 'text', text: 'Add dark mode' }, { type: 'image', source: {} }]),
  ), '2026-10-01T08:00:00.000Z');
  writeAt(path.join(project, 'cccccccc-3333.jsonl'), jsonl(
    user('Original prompt'),
    { type: 'custom-title', customTitle: 'Renamed by /rename', sessionId: 'cccccccc-3333' },
  ), '2026-09-29T12:00:00.000Z');
  writeAt(path.join(project, 'dddddddd-4444.jsonl'), jsonl({ type: 'summary', summary: 'A summary of another session', leafUuid: 'u' }), '2026-10-01T09:00:00.000Z');
  writeAt(path.join(project, 'bbbbbbbb-2222', 'subagents', 'agent-x.jsonl'), jsonl(user('sub-agent prompt', { isSidechain: true, agentId: 'x' })), '2026-10-01T10:00:00.000Z');
  writeAt(path.join(project, 'notes.txt'), 'not a transcript', '2026-10-01T10:00:00.000Z');

  const memo = new FileMemo();
  const sessions = await listClaudeSessions(dir, memo);
  assert.deepEqual(sessions, [
    { id: 'bbbbbbbb-2222', title: 'Add dark mode', cwd: '/home/me/app', startedAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' },
    { id: 'aaaaaaaa-1111', title: 'Fix the login bug, please', cwd: '/home/me/app', startedAt: '2026-09-30T09:59:59.000Z', updatedAt: '2026-09-30T10:05:00.000Z' },
    { id: 'cccccccc-3333', title: 'Renamed by /rename', cwd: '/home/me/app', startedAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z' },
  ], 'newest first; sub-agent transcripts, summaries without a session and other files are left out');

  // Unchanged files are not read again; a changed one is.
  assert.equal(memo.entries.size, 4);
  const cached = memo.entries.get(path.join(project, 'aaaaaaaa-1111.jsonl'));
  await listClaudeSessions(dir, memo);
  assert.equal(memo.entries.get(path.join(project, 'aaaaaaaa-1111.jsonl')), cached);
  writeAt(path.join(project, 'aaaaaaaa-1111.jsonl'), jsonl(user('Fix the login bug, please'), { type: 'assistant', timestamp: 't' }, { type: 'assistant', timestamp: 't' }), '2026-10-02T00:00:00.000Z');
  fs.rmSync(path.join(project, 'cccccccc-3333.jsonl'));
  const again = await listClaudeSessions(dir, memo);
  assert.deepEqual(again.map((s) => [s.id, s.updatedAt]), [['aaaaaaaa-1111', '2026-10-02T00:00:00.000Z'], ['bbbbbbbb-2222', '2026-10-01T08:00:00.000Z']]);
  assert.ok(!memo.entries.has(path.join(project, 'cccccccc-3333.jsonl')), 'removed files leave the memo');

  assert.deepEqual(await listClaudeSessions(path.join(dir, 'nowhere')), [], 'a tool never run has no sessions');
});

test('Codex CLI sessions come from rollout files, in either history mode, without sub-agent threads', async () => {
  const dir = tempDir();
  const day = path.join(dir, 'sessions', '2026', '10', '01');
  const meta = (id, extra = {}) => ({ timestamp: '2026-10-01T13:28:46.535Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-01T13:28:46.480Z', cwd: '/work/proj', originator: 'codex_cli_rs', cli_version: '0.159.3', source: 'cli', thread_source: 'user', ...extra } });
  writeAt(path.join(day, 'rollout-2026-10-01T13-28-46-01a0f7a7-387f-7e11-b368-5335205ef1a6.jsonl'), jsonl(
    meta('01a0f7a7-387f-7e11-b368-5335205ef1a6'),
    { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills…' }] } },
    { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/proj</cwd>\n</environment_context>' }] } },
    { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hello' }] } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'say hello' }] } } },
  ), '2026-10-01T13:29:05.000Z');
  writeAt(path.join(dir, 'sessions', '2026', '09', '30', 'rollout-2026-09-30T08-00-00-11111111-2222-3333-4444-555555555555.jsonl'), jsonl(
    { timestamp: 't', type: 'session_meta', payload: { id: '11111111-2222-3333-4444-555555555555', timestamp: '2026-09-30T08:00:00.000Z', cwd: 'C:\\work\\legacy', source: 'exec' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'Refactor the parser', kind: 'plain' } },
  ), '2026-09-30T08:10:00.000Z');
  writeAt(path.join(day, 'rollout-2026-10-01T14-00-00-aaaaaaaa-0000-0000-0000-000000000001.jsonl'), jsonl(
    meta('aaaaaaaa-0000-0000-0000-000000000001', { source: { subagent: { thread_spawn: { parent_thread_id: '01a0f7a7-387f-7e11-b368-5335205ef1a6', depth: 1 } } }, parent_thread_id: '01a0f7a7-387f-7e11-b368-5335205ef1a6', thread_source: 'subagent' }),
    { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'explore the repo' } },
  ), '2026-10-01T14:00:00.000Z');
  writeAt(path.join(day, 'rollout-2026-10-01T14-30-00-aaaaaaaa-0000-0000-0000-000000000002.jsonl'), jsonl(meta('aaaaaaaa-0000-0000-0000-000000000002', { source: { subagent: 'review' } })), '2026-10-01T14:30:00.000Z');
  writeAt(path.join(day, 'rollout-2026-10-01T15-00-00-aaaaaaaa-0000-0000-0000-000000000003.jsonl'), jsonl({ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'no meta' } }), '2026-10-01T15:00:00.000Z');
  writeAt(path.join(day, 'notes.jsonl'), jsonl(meta('not-a-rollout')), '2026-10-01T15:00:00.000Z');
  // The same thread after a revert: thread id, then rollout id.
  writeAt(path.join(day, 'rollout-2026-10-01T16-00-00-01a0f7a7-387f-7e11-b368-5335205ef1a6_0199.jsonl'), jsonl(
    meta('01a0f7a7-387f-7e11-b368-5335205ef1a6'),
    { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'say hello' } },
  ), '2026-10-01T16:00:00.000Z');
  const zstd = typeof zlib.zstdCompressSync === 'function';
  if (zstd) {
    const archived = jsonl(
      { timestamp: 't', type: 'session_meta', payload: { id: 'cccccccc-0000-0000-0000-000000000003', timestamp: '2026-08-01T00:00:00.000Z', cwd: '/work/old', source: 'vscode' } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'Old compressed session' } },
      ...Array.from({ length: 4000 }, (_, i) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `line ${i} `.repeat(20) }] } })),
    );
    writeAt(path.join(dir, 'sessions', '2026', '08', '01', 'rollout-2026-08-01T00-00-00-cccccccc-0000-0000-0000-000000000003.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(archived)), '2026-08-01T00:30:00.000Z');
  }

  const sessions = await listCodexSessions(dir);
  assert.deepEqual(sessions, [
    { id: '01a0f7a7-387f-7e11-b368-5335205ef1a6', title: 'say hello', cwd: '/work/proj', startedAt: '2026-10-01T13:28:46.480Z', updatedAt: '2026-10-01T16:00:00.000Z' },
    { id: '11111111-2222-3333-4444-555555555555', title: 'Refactor the parser', cwd: 'C:\\work\\legacy', startedAt: '2026-09-30T08:00:00.000Z', updatedAt: '2026-09-30T08:10:00.000Z' },
    ...(zstd ? [{ id: 'cccccccc-0000-0000-0000-000000000003', title: 'Old compressed session', cwd: '/work/old', startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:30:00.000Z' }] : []),
  ], 'one entry per thread, newest first; sub-agent threads and files without session_meta are left out');
});

test('Antigravity CLI sessions come from each conversation\'s transcript, with a folder only for its latest one', async () => {
  const dir = tempDir();
  const ids = ['1b2c3d4e-0000-4000-8000-000000000001', '1b2c3d4e-0000-4000-8000-000000000002', '1b2c3d4e-0000-4000-8000-000000000003', '1b2c3d4e-0000-4000-8000-000000000004', '1b2c3d4e-0000-4000-8000-000000000005'];
  const transcript = (id, ...records) => writeAt(path.join(dir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), jsonl(...records), '2026-10-02T22:00:00.000Z');
  const request = (text, created = '2026-10-02T21:35:59Z') => ({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: created,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-02T17:35:59-04:00.\n</ADDITIONAL_METADATA>`,
  });
  transcript(ids[0], request('Fix the login bug'), { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'ok' });
  transcript(ids[1], request('Explain   the\nparser', '2026-10-01T08:00:00Z'));
  transcript(ids[2], { step_index: 0, source: 'SYSTEM', type: 'USER_INPUT', content: '<USER_REQUEST>\nnot typed\n</USER_REQUEST>' });
  transcript(ids[3], '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_IN');
  fs.mkdirSync(path.join(dir, 'brain', ids[4], 'scratch'), { recursive: true });
  transcript('not-a-conversation', request('Not one of the CLI\'s'));
  writeAt(path.join(dir, 'cache', 'last_conversations.json'), JSON.stringify({ '/home/me/app': ids[0], '/home/me/gone': 'f0000000-0000-4000-8000-000000000000' }), '2026-10-02T22:00:00.000Z');

  assert.deepEqual(await listAntigravitySessions(dir), [
    { id: ids[0], title: 'Fix the login bug', cwd: '/home/me/app', startedAt: '2026-10-02T21:35:59.000Z', updatedAt: '2026-10-02T22:00:00.000Z' },
    { id: ids[1], title: 'Explain the parser', cwd: null, startedAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T22:00:00.000Z' },
  ], 'only conversations the user started, with a folder where the CLI keeps one');
  fs.writeFileSync(path.join(dir, 'cache', 'last_conversations.json'), 'not json');
  assert.equal((await listAntigravitySessions(dir))[0].cwd, null);
  assert.deepEqual(await listAntigravitySessions(path.join(dir, 'missing')), []);
});

test('Grok Build sessions come from each folder bucket\'s summaries, hidden and sub-agent sessions left out', async () => {
  const dir = tempDir();
  const bucket = path.join(dir, 'sessions', encodeURIComponent('/home/me/app'));
  const summary = (id, extra = {}) => JSON.stringify({ info: { id, cwd: '/home/me/app' }, session_summary: '', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:30:00Z', num_messages: 4, num_chat_messages: 9, current_model_id: 'grok-4.6', ...extra });
  const uuid = (n) => `0199${n}000-0000-7000-8000-000000000000`;
  writeAt(path.join(bucket, uuid(1), 'summary.json'), summary(uuid(1), { generated_title: 'Fix Login Bug', title_is_manual: true, last_active_at: '2026-10-01T11:00:00Z' }), '2026-10-01T11:00:00Z');
  writeAt(path.join(bucket, uuid(2), 'summary.json'), summary(uuid(2), { session_summary: 'Explored the data layer' }), '2026-10-01T10:30:00Z');
  writeAt(path.join(bucket, uuid(3), 'summary.json'), summary(uuid(3), { session_kind: 'subagent', parent_session_id: uuid(1) }), '2026-10-01T10:45:00Z');
  writeAt(path.join(bucket, uuid(4), 'summary.json'), summary(uuid(4), { hidden: true }), '2026-10-01T10:45:00Z');
  writeAt(path.join(bucket, uuid(5), 'summary.json'), summary(uuid(5), { num_messages: 0 }), '2026-10-01T12:00:00Z');
  writeAt(path.join(bucket, uuid(6), 'summary.json'), summary(uuid(6), { info: { id: uuid(6) }, updated_at: '2026-09-30T09:00:00Z' }), '2026-09-30T09:00:00Z');
  writeAt(path.join(bucket, uuid(6), 'updates.jsonl'), jsonl(
    { timestamp: 1, method: 'session/update', params: { sessionId: uuid(6), update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '!ls', _meta: { bash_command: true } } } } },
    { timestamp: 2, method: 'session/update', params: { sessionId: uuid(6), update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Write the ' } }, _meta: { promptId: 'p1' } } },
    { timestamp: 3, method: 'session/update', params: { sessionId: uuid(6), update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'release notes' } }, _meta: { promptId: 'p1' } } },
    { timestamp: 4, method: 'session/update', params: { sessionId: uuid(6), update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'next prompt' } }, _meta: { promptId: 'p2' } } },
  ), '2026-09-30T09:00:00Z');
  const hashed = path.join(dir, 'sessions', 'very-long-name-0123456789abcdef');
  writeAt(path.join(hashed, '.cwd'), '/home/me/a very long project path\n', '2026-09-01T00:00:00Z');
  writeAt(path.join(hashed, uuid(7), 'summary.json'), summary(uuid(7), { info: { id: uuid(7) }, generated_title: 'Elsewhere', updated_at: '2026-09-01T00:00:00Z' }), '2026-09-01T00:00:00Z');
  writeAt(path.join(dir, 'sessions', 'session_search.sqlite'), '', '2026-10-01T12:00:00Z');

  assert.deepEqual(await listGrokSessions(dir), [
    { id: uuid(1), title: 'Fix Login Bug', cwd: '/home/me/app', startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T11:00:00.000Z' },
    { id: uuid(2), title: 'Explored the data layer', cwd: '/home/me/app', startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:30:00.000Z' },
    { id: uuid(6), title: 'Write the release notes', cwd: '/home/me/app', startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-09-30T09:00:00.000Z' },
    { id: uuid(7), title: 'Elsewhere', cwd: '/home/me/a very long project path', startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  ]);
});

test('a history command prints JSON, and the monitor reads each account\'s own folder and caches the list', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-history.mjs');
  const env = { PATH: path.dirname(process.execPath) };
  assert.deepEqual(await commandHistory({ command: process.execPath, args: [fixture] }, env), [
    { id: 'newer-2', title: null, cwd: null, startedAt: null, updatedAt: '2030-01-01T00:00:00.000Z' },
    { id: 'older-1', title: 'Fix the login bug', cwd: '/work/app', startedAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T01:00:00.000Z' },
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), 'entries without a usable id are dropped');
  await assert.rejects(commandHistory({ command: 'no-such-history-command', args: [] }, env), /not found on PATH/);
  await assert.rejects(commandHistory({ command: process.execPath, args: ['-e', 'console.log("nope")'] }, env), /did not print JSON/);
  await assert.rejects(commandHistory({ command: process.execPath, args: ['-e', 'console.log("{}")'] }, env), /no "sessions" array/);
  assert.equal(cleanEntry({ id: 'x'.repeat(201) }), null);
  assert.equal(cleanEntry({ id: 'a\x1bb' }), null);
  assert.deepEqual(cleanEntry({ id: ' s1 ', title: '  ', cwd: ' /w ', startedAt: 'not a date' }), { id: 's1', title: null, cwd: '/w', startedAt: null, updatedAt: null });

  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', accounts: [{ id: 'work' }] },
    { id: 'openai', history: null },
    { id: 'custom', command: 'x', history: { command: process.execPath, args: [fixture] } },
    { id: 'bad', command: 'x', history: { args: ['x'] } },
    { id: 'shell' },
  ] }));
  const accountsDir = path.join(dir, 'accounts');
  const registry = new ProviderRegistry({ userFile, env, checkUpdates: false, accountsDir });
  assert.equal(registry.get('anthropic').history, 'claude');
  assert.equal(registry.get('google').history, 'antigravity');
  assert.equal(registry.get('xai').history, 'grok');
  assert.equal(registry.get('openai').history, null);
  assert.deepEqual(registry.get('custom').history, { command: process.execPath, args: [fixture] });
  assert.equal(registry.get('bad').history, null);
  assert.equal(registry.get('shell').history, null);
  assert.deepEqual(registry.list().map((p) => [p.id, p.historySource]), [['anthropic', 'claude'], ['openai', null], ['google', 'antigravity'], ['xai', 'grok'], ['shell', null], ['custom', 'command'], ['bad', null]]);

  const defaultHome = path.join(dir, 'claude-home');
  const workHome = path.join(accountsDir, 'anthropic', 'work');
  const transcript = (id, prompt) => jsonl({ type: 'user', cwd: '/w', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: prompt } });
  writeAt(path.join(defaultHome, 'projects', '-w', 'd1.jsonl'), transcript('d1', 'default account'), '2026-10-01T01:00:00.000Z');
  writeAt(path.join(workHome, 'projects', '-w', 'w1.jsonl'), transcript('w1', 'work account'), '2026-10-01T01:00:00.000Z');
  let reads = 0;
  const history = new SessionHistory({ registry, env: { ...env, CLAUDE_CONFIG_DIR: defaultHome }, ttlMs: 60000, readers: {
    claude: (home, memo) => { reads++; return listClaudeSessions(home, memo); },
  } });
  const anthropic = registry.get('anthropic');
  const byDefault = await history.list(anthropic);
  assert.deepEqual(byDefault.sessions.map((s) => [s.id, s.title]), [['d1', 'default account']]);
  assert.deepEqual([byDefault.providerId, byDefault.accountId, byDefault.total, byDefault.error], ['anthropic', 'default', 1, null]);
  const byWork = await history.list(anthropic, registry.account(anthropic, 'work'));
  assert.deepEqual(byWork.sessions.map((s) => [s.id, s.title]), [['w1', 'work account']], 'the work account reads its own home folder');
  await Promise.all([history.list(anthropic), history.list(anthropic, undefined, { limit: 1 })]);
  assert.equal(reads, 2, 'a list within the TTL comes from the cache');
  const limited = await history.list(registry.get('custom'), undefined, { limit: 1 });
  assert.deepEqual([limited.sessions.length, limited.total], [1, 2]);
  assert.equal((await history.list(registry.get('custom'), undefined, { limit: 'lots' })).sessions.length, 2);
  const failing = new SessionHistory({ registry, env });
  const missing = { id: 'missing', env: {}, history: { command: 'no-such-history-command', args: [] } };
  assert.match((await failing.list(missing, { id: 'default', env: {} })).error, /not found on PATH/);
  const unreadable = new SessionHistory({ registry, env: { ...env, CLAUDE_CONFIG_DIR: path.join(dir, 'nothing-here') } });
  assert.deepEqual((await unreadable.list(anthropic)).sessions, [], 'a tool never run has no sessions and no error');
});

test('console and cloud links are https URLs that users can override per platform or turn off', () => {
  const defaults = loadProviders({ platform: 'linux' });
  assert.deepEqual(defaults.warnings, []);
  for (const provider of defaults.providers.filter((p) => p.id !== 'shell')) {
    if (provider.id !== 'google') assert.match(provider.usageUrl, /^https:\/\//, `${provider.id} usageUrl`);
    assert.match(provider.billingUrl, /^https:\/\//, `${provider.id} billingUrl`);
    assert.match(provider.cloudUrl, /^https:\/\//, `${provider.id} cloudUrl`);
  }
  const google = defaults.providers.find((p) => p.id === 'google');
  assert.equal(google.usageUrl, null, 'Antigravity CLI shows its quota only inside the tool');
  assert.equal(google.docs, 'https://antigravity.google/docs/cli/install');
  const shell = defaults.providers.find((p) => p.id === 'shell');
  assert.equal(shell.usageUrl, null);
  assert.equal(shell.billingUrl, null);
  assert.equal(shell.cloudUrl, null);

  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({
    providers: [
      { id: 'anthropic', usageUrl: 'https://platform.claude.com/usage', billingUrl: null, cloudUrl: null, darwin: { usageUrl: 'https://example.com/mac' } },
      { id: 'openai', usageUrl: 'javascript:alert(1)', billingUrl: 'http://example.com/billing', cloudUrl: 'javascript:alert(1)' },
      { id: 'google', usageUrl: 'not a url', billingUrl: '', cloudUrl: 'https://example.com/cloud' },
    ],
  }));
  const linux = loadProviders({ userFile, platform: 'linux' });
  const byId = Object.fromEntries(linux.providers.map((p) => [p.id, p]));
  assert.equal(byId.anthropic.usageUrl, 'https://platform.claude.com/usage');
  assert.equal(byId.anthropic.billingUrl, null);
  assert.equal(byId.anthropic.cloudUrl, null);
  assert.equal(byId.openai.usageUrl, null);
  assert.equal(byId.openai.billingUrl, null);
  assert.equal(byId.openai.cloudUrl, null);
  assert.equal(byId.google.usageUrl, null);
  assert.equal(byId.google.billingUrl, null);
  assert.equal(byId.google.cloudUrl, 'https://example.com/cloud');
  assert.equal(byId.xai.usageUrl, loadProviders({ platform: 'linux' }).providers.find((p) => p.id === 'xai').usageUrl);
  assert.equal(linux.warnings.length, 4);
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

function fakeShells(files, { env = {}, platform = 'linux', version = () => 'tmux 3.4\n' } = {}) {
  const has = (file) => files.includes(file);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = platform === 'win32' ? ['C:\\Windows\\System32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const resolve = (command) => {
    if (!command) return null;
    if (p.isAbsolute(command)) return has(command) ? command : null;
    const names = platform === 'win32' && !p.extname(command) ? [`${command}.exe`] : [command];
    for (const dir of [...(env.EXTRA_PATH || []), ...dirs]) for (const name of names) if (has(p.join(dir, name))) return p.join(dir, name);
    return null;
  };
  const found = detectShells(env, platform, { exists: has, resolve, version });
  return { ...found, summary: found.shells.map((s) => `${s.id}=${s.path}`) };
}

test('the Shell card offers the installed shells and the login shell as the default on macOS and Linux', () => {
  const linux = fakeShells(['/usr/local/bin/bash', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish'], { env: { SHELL: '/usr/local/bin/bash' } });
  assert.deepEqual(linux.summary, ['bash=/usr/local/bin/bash', 'zsh=/usr/bin/zsh', 'fish=/usr/bin/fish']);
  assert.equal(linux.defaultId, 'bash');
  assert.deepEqual(linux.shells[0].args, []);

  const mac = fakeShells(['/bin/zsh', '/bin/bash', '/usr/local/bin/pwsh'], { platform: 'darwin' });
  assert.deepEqual(mac.summary, ['bash=/bin/bash', 'zsh=/bin/zsh', 'pwsh=/usr/local/bin/pwsh']);
  assert.equal(mac.defaultId, 'zsh', 'zsh without $SHELL');
  assert.equal(mac.shells.find((s) => s.id === 'pwsh').label, 'PowerShell');

  const other = fakeShells(['/usr/bin/nu', '/usr/bin/bash'], { env: { SHELL: '/usr/bin/nu' } });
  assert.deepEqual(other.summary, ['nu=/usr/bin/nu', 'bash=/usr/bin/bash'], 'a login shell outside the list comes first');
  assert.equal(other.defaultId, 'nu');

  const broken = fakeShells(['/bin/bash', '/usr/bin/fish'], { env: { SHELL: '/opt/gone/zsh' } });
  assert.equal(broken.defaultId, 'bash', 'a missing $SHELL falls back to the platform shell');
  assert.equal(fakeShells(['/usr/bin/fish'], { env: { SHELL: '/opt/gone/zsh' } }).defaultId, 'fish', 'then to any installed shell');
  assert.deepEqual(fakeShells([], { env: { SHELL: '/opt/gone/zsh' } }), { shells: [], defaultId: null, summary: [] });
});

test('the Shell card offers tmux 3.2 or later and herdr after the shells, never as the default', () => {
  const linux = fakeShells(['/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/tmux', '/home/me/.local/bin/herdr'], { env: { SHELL: '/usr/bin/zsh', EXTRA_PATH: ['/home/me/.local/bin'] } });
  assert.deepEqual(linux.summary, ['bash=/usr/bin/bash', 'zsh=/usr/bin/zsh', 'tmux=/usr/bin/tmux', 'herdr=/home/me/.local/bin/herdr']);
  assert.equal(linux.defaultId, 'zsh');
  const [tmux, herdr] = linux.shells.slice(2);
  assert.deepEqual([tmux.args, tmux.multiplexer], [['-u', 'attach-session', '-t', '={name}'], { attach: 'tmux attach -t {name}' }]);
  assert.deepEqual([herdr.args, herdr.multiplexer], [[], { attach: 'herdr' }]);
  assert.ok(linux.shells.slice(0, 2).every((s) => !s.multiplexer));
  for (const [version, offered] of [['tmux 2.7\n', false], ['tmux 3.1c\n', false], ['tmux 3.2a\n', true], ['tmux 3.4\n', true], ['tmux next-3.6\n', true], ['tmux master\n', true], ['', false]]) {
    assert.equal(fakeShells(['/usr/bin/bash', '/usr/bin/tmux'], { version: () => version }).shells.some((s) => s.id === 'tmux'), offered, version.trim() || 'a tmux that does not run');
  }
  assert.equal(tmuxSupported('tmux 10.0\n'), true);

  const mac = fakeShells(['/bin/zsh', '/usr/local/bin/tmux'], { platform: 'darwin' });
  assert.deepEqual([mac.summary, mac.defaultId], [['zsh=/bin/zsh', 'tmux=/usr/local/bin/tmux'], 'zsh']);
  assert.equal(fakeShells(['/usr/bin/tmux'], { env: { SHELL: '/opt/gone/zsh' } }).defaultId, null, 'a multiplexer alone is no default');
  const loginTmux = fakeShells(['/usr/bin/tmux', '/usr/bin/bash'], { env: { SHELL: '/usr/bin/tmux' } });
  assert.deepEqual(loginTmux.summary, ['tmux=/usr/bin/tmux', 'bash=/usr/bin/bash'], 'a login shell that is tmux is listed once, as the login shell');
  assert.equal(loginTmux.shells[0].multiplexer, undefined);

  const sys = 'C:\\Windows\\System32';
  const win = fakeShells([`${sys}\\cmd.exe`, `${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`, `${sys}\\tmux.exe`, `${sys}\\herdr.exe`], { platform: 'win32' });
  assert.deepEqual([win.shells.map((s) => s.id), win.defaultId], [['powershell', 'cmd', 'herdr'], 'powershell'], 'herdr on Windows, never tmux');
  assert.deepEqual(win.shells[2].multiplexer, { attach: 'herdr' });
});

test('a tmux card\'s own session is made from commands on stdin, every value quoted', () => {
  const commands = tmuxNewSession({ name: 'guild-abc123', cwd: "/work/it's here", cols: 100, rows: 30, env: { AGENT_GUILD_REPORT_TOKEN: 'tok', PATH: '/a b:/c' }, args: ['htop', '-d', '5'] });
  assert.equal(commands, "new-session -d -s 'guild-abc123' -x 100 -y 30 -c '/work/it'\\''s here' -e 'AGENT_GUILD_REPORT_TOKEN=tok' -e 'PATH=/a b:/c' 'htop' '-d' '5'\n");
  assert.throws(() => tmuxNewSession({ name: 'guild-abc123', cwd: '/work/a\nb', cols: 1, rows: 1, env: {} }), { code: 'bad_cwd', status: 400 });
  assert.throws(() => tmuxNewSession({ name: 'guild-abc123', cwd: '/work', cols: 1, rows: 1, env: {}, args: ['a\rb'] }), { code: 'bad_args', status: 400 });
});

test('a herdr card shows herdr\'s agents, one per pane, from the herdr session its client attaches to', () => {
  assert.deepEqual(herdrAgentReports([
    { agent: 'claude', agent_status: 'working', pane_id: 'w1:p1', cwd: '/work/a' },
    { agent: 'codex', agent_status: 'blocked', pane_id: 'w1:p2' },
    { agent: 'pi', agent_status: 'done', pane_id: 'w2:p1' },
    { agent: 'grok', agent_status: 'unknown', pane_id: 'w2:p2' },
    { agent_status: 'working', pane_id: 'w3:p1' },
    null,
  ]), [
    { agentId: 'herdr:w1:p1', name: 'claude', kind: 'agent', status: 'working', detail: '/work/a' },
    { agentId: 'herdr:w1:p2', name: 'codex', kind: 'agent', status: 'waiting', detail: '' },
    { agentId: 'herdr:w2:p1', name: 'pi', kind: 'agent', status: 'idle', detail: '' },
    { agentId: 'herdr:w2:p2', name: 'grok', kind: 'agent', status: 'idle', detail: '' },
  ]);
  assert.deepEqual(herdrAgentReports(undefined), []);
  const listing = { sessions: [
    { default: true, name: 'default', running: true, socket_path: '/home/me/.config/herdr/herdr.sock' },
    { default: false, name: 'work', running: true, socket_path: '/home/me/.config/herdr/sessions/work/herdr.sock' },
    { default: false, name: 'later', running: false, socket_path: '/home/me/.config/herdr/sessions/later/herdr.sock' },
  ] };
  assert.equal(herdrSocket(listing, {}, 'linux'), '/home/me/.config/herdr/herdr.sock');
  assert.equal(herdrSocket(listing, { HERDR_SESSION: 'work' }, 'darwin'), '/home/me/.config/herdr/sessions/work/herdr.sock');
  assert.equal(herdrSocket(listing, { HERDR_SESSION: 'later' }, 'linux'), null, 'a server that is not running yet');
  const windows = { sessions: [{ default: true, name: 'default', running: true, socket_path: 'C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock' }] };
  assert.equal(herdrSocket(windows, {}, 'win32'), '\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock', 'herdr\'s pipe is named after its socket path');
});

test('the Shell card defaults to PowerShell 7 on Windows and finds Git Bash', () => {
  const sys = 'C:\\Windows\\System32';
  const base = [`${sys}\\cmd.exe`, `${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`];
  const plain = fakeShells(base, { platform: 'win32' });
  assert.deepEqual(plain.summary, [`powershell=${base[1]}`, `cmd=${base[0]}`]);
  assert.equal(plain.defaultId, 'powershell', 'Windows PowerShell when PowerShell 7 is missing');

  const pf = 'C:\\Program Files';
  assert.equal(fakeShells([...base, `${pf}\\PowerShell\\7\\pwsh.exe`], { platform: 'win32', env: { ProgramW6432: pf } }).defaultId, 'pwsh', 'PowerShell 7 off PATH');
  const full = fakeShells([...base, `${pf}\\PowerShell\\7\\pwsh.exe`, `${pf}\\Git\\bin\\bash.exe`, `${pf}\\Git\\cmd\\git.exe`], { platform: 'win32', env: { ProgramFiles: pf } });
  assert.deepEqual(full.summary.map((s) => s.split('=')[0]), ['pwsh', 'powershell', 'cmd', 'git-bash']);
  assert.equal(full.defaultId, 'pwsh');
  assert.deepEqual(full.shells.map((s) => s.label), ['PowerShell', 'Windows PowerShell', 'Command Prompt', 'Git Bash']);
  const gitBash = full.shells.find((s) => s.id === 'git-bash');
  assert.deepEqual([gitBash.args, gitBash.env], [['--login', '-i'], { CHERE_INVOKING: '1' }]);

  const fromGit = fakeShells([...base, 'D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe', `${sys}\\bash.exe`], { platform: 'win32', env: { EXTRA_PATH: ['D:\\Tools\\Git\\cmd'] } });
  assert.equal(fromGit.shells.find((s) => s.id === 'git-bash')?.path, 'D:\\Tools\\Git\\bin\\bash.exe', 'Git Bash next to git on PATH, never WSL\'s bash.exe');
  const msys = fakeShells([...base, 'C:\\msys64\\usr\\bin\\git.exe', 'C:\\msys64\\usr\\bin\\bash.exe'], { platform: 'win32', env: { EXTRA_PATH: ['C:\\msys64\\usr\\bin'] } });
  assert.equal(msys.shells.some((s) => s.id === 'git-bash'), false, 'another bash is not called Git Bash');
});

test('a Shell session runs the shell it is asked for, and other tools refuse one', () => {
  const dir = tempDir();
  const win = process.platform === 'win32';
  const defaultShell = win ? { id: 'pwsh', file: 'pwsh.exe' } : { id: 'zsh', file: 'zsh' };
  const alternateShell = win ? { id: 'cmd', file: 'cmd.exe' } : { id: 'bash', file: 'bash' };
  for (const { file } of [defaultShell, alternateShell]) fs.writeFileSync(path.join(dir, file), '', { mode: 0o755 });
  const env = { PATH: dir, PATHEXT: '.EXE', SHELL: win ? undefined : path.join(dir, defaultShell.file) };
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{ id: 'anthropic', command: process.execPath }, { id: 'shell', args: ['--own'] }] }));
  const registry = new ProviderRegistry({ userFile, env, platform: process.platform });
  const shell = registry.get('shell');
  const card = registry.describe(shell);
  assert.deepEqual(card.shells.map((s) => s.id), win ? ['pwsh', 'cmd'] : ['bash', 'zsh']);
  assert.equal(card.defaultShell, defaultShell.id);
  assert.equal(card.resolvedPath, path.join(dir, defaultShell.file));
  assert.equal(registry.shellFor(shell).id, card.defaultShell);
  const picked = registry.shellFor(shell, alternateShell.id);
  assert.notEqual(picked.id, card.defaultShell, 'the selected shell must differ from the default');
  assert.equal(registry.spawnSpec(shell, [], null, [], picked).file, path.join(dir, alternateShell.file));
  assert.deepEqual(registry.spawnSpec(shell, [], null, [], picked).args, [], 'the provider\'s args are for its default shell only');
  assert.deepEqual(registry.spawnSpec(shell, [], null, [], registry.shellFor(shell)), { file: path.join(dir, defaultShell.file), args: ['--own'] });
  assert.throws(() => registry.shellFor(shell, 'fish'), { code: 'shell_unavailable', status: 409 });
  const anthropic = registry.get('anthropic');
  assert.equal(registry.shellFor(anthropic), null);
  assert.throws(() => registry.shellFor(anthropic, alternateShell.id), { code: 'bad_shell', status: 400 });
  assert.equal(registry.describe(anthropic).shells, null);
});

test('hook events map to agent reports for every tool\'s spelling', () => {
  const [pre] = hookToReports({
    hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'toolu_0',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  const [post] = hookToReports({
    hook_event_name: 'PostToolUse', tool_name: 'Task', tool_use_id: 'toolu_0',
    tool_input: { description: 'Search the codebase', subagent_type: 'Explore', prompt: 'x' },
  });
  assert.equal(pre.status, 'working');
  assert.equal(pre.name, 'Explore');
  assert.equal(pre.detail, 'Search the codebase');
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
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', agent_id: 'internal-1', tool_name: 'Read', tool_input: {} }), [], 'a Claude Code helper\'s tool call has no turn_id and is not an agent');
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', turn_id: 't5', model: 'gpt-5-codex', prompt: 'main' }), [{ finishForeground: true }, { model: 'gpt-5-codex' }], 'a main-thread prompt is not an agent');
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
  assert.deepEqual(hookToReports({ hookEventName: 'session_end', hook_event_name: 'SessionEnd', sessionId: 'parent', session_id: 'parent', reason: 'channel_closed' }), [{ shell: 'reset' }], 'the main session ending is not an agent, and ends its commands');
  assert.deepEqual(hookToReports({ hookEventName: 'stop_cancelled', hook_event_name: 'StopCancelled', sessionId: 'g4', session_id: 'g4', subagentType: 'plan', reason: 'max_turns', cancelledBy: 'runtime' }),
    [{ agentId: 'hook-g4', name: 'plan', kind: 'subagent', status: 'done' }], 'a sub-agent cut off at its turn limit is done');
  assert.deepEqual(hookToReports({ hookEventName: 'stop_cancelled', hook_event_name: 'StopCancelled', sessionId: 'parent', session_id: 'parent', reason: 'user_interrupt', cancelledBy: 'user' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'exit', agent_type: 'security-reviewer' }), [{ shell: 'reset' }], 'a Claude Code --agent session ending is not an agent either');
  assert.deepEqual(hookToReports({ cwd: '/w', hook_event_name: 'SessionEnd', reason: 'other', session_id: 's', transcript_path: null }), [{ shell: 'reset' }], 'Codex SessionEnd is root-only');
  assert.deepEqual(hookToReports({ hook_event_name: 'PreInvocation', conversationId: 'c1', modelName: 'gemini-3.8-flash-high', invocationNum: 0, workspacePaths: ['/w'] }),
    [{ model: 'gemini-3.8-flash-high' }, { toolSessionId: 'c1' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), [], 'a shell call without an id cannot be paired with its end');
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }), [], 'nor an agent call');
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', session_id: 'c', stop_hook_active: false }), [{ finishForeground: true }], 'a main-thread Stop is a turn boundary too');
  assert.deepEqual(hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }), []);
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
  assert.equal(posix[SHIM_NAME], '#!/bin/sh\n[ "$1" = --hook ] && [ -z "$AGENT_GUILD_SESSION_ID" ] && exec cat >/dev/null\nn="/usr/local/n\\$v/node"\n[ -x "$n" ] || n=node\nexec "$n" "/opt/agent guild/bin/agent-guild-report.mjs" "$@"\n');

  const winScript = 'C:\\Users\\José\\100%\\agent-guild\\bin\\agent-guild-report.mjs';
  const win = shimContents({ execPath: 'C:\\Program Files\\nodejs\\node.exe', script: winScript, platform: 'win32' });
  assert.deepEqual(Object.keys(win).sort(), [SHIM_NAME, LOADER_NAME, `${SHIM_NAME}.cmd`], 'no .ps1: PowerShell would prefer it and its default policy refuses it');
  assert.equal(win[SHIM_NAME], '#!/bin/sh\n[ "$1" = --hook ] && [ -z "$AGENT_GUILD_SESSION_ID" ] && exec cat >/dev/null\nn="C:/Program Files/nodejs/node.exe"\n[ -x "$n" ] || n=node\nexec "$n" "C:/Users/José/100%/agent-guild/bin/agent-guild-report.mjs" "$@"\n', 'Git Bash takes forward slashes');
  // cmd.exe reads the batch file in the OEM code page, so the paths stay out of it.
  assert.equal(win[`${SHIM_NAME}.cmd`], '@ECHO OFF\r\nIF "%~1"=="--hook" IF NOT DEFINED AGENT_GUILD_SESSION_ID EXIT /B 0\r\nIF EXIST "%AGENT_GUILD_NODE%" GOTO manager\r\nnode "%~dp0agent-guild-report-loader.mjs" %*\r\nEXIT /B %ERRORLEVEL%\r\n:manager\r\n"%AGENT_GUILD_NODE%" "%~dp0agent-guild-report-loader.mjs" %*\r\n');
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
    // Absolute shell paths: the env under test need not carry System32.
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const cmd = path.join(system32, 'cmd.exe');
    const winArgs = [[cmd, ['/d', '/s', '/c', `${SHIM_NAME} --help`], 'cmd.exe (Codex CLI) finds the .cmd through PATHEXT'],
      [path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `${SHIM_NAME} --help`], 'PowerShell (Grok Build) runs the .cmd under the Restricted policy']];
    for (const [file, args, why] of winArgs) assert.match(run(file, args, withNode), /^Usage: agent-guild-report/, why);
    // The manager's Node.js is gone: `node` on the (real) PATH takes over.
    assert.match(run(cmd, ['/d', '/s', '/c', `${SHIM_NAME} --help`], { ...withNode, AGENT_GUILD_NODE: gone }), /^Usage: agent-guild-report/, 'falls back to node on PATH');
    const outside = { SystemRoot: process.env.SystemRoot, ComSpec: cmd, PATH: system32, AGENT_GUILD_NODE: gone };
    const hook = execFileSync(cmd, [`/d /s /c ""${path.join(dir, `${SHIM_NAME}.cmd`)}" --hook"`], { env: outside, encoding: 'utf8', timeout: 20000, windowsHide: true, windowsVerbatimArguments: true });
    assert.equal(hook, '');
  } else {
    assert.ok((fs.statSync(path.join(dir, SHIM_NAME)).mode & 0o111) !== 0, 'the sh launcher is executable');
    assert.match(run('/bin/sh', ['-c', `${SHIM_NAME} --help`], withNode), /^Usage: agent-guild-report/, 'sh (Claude Code, Grok Build) runs the launcher');
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    writeReportShims({ dir, execPath: gone, script: reporter });
    assert.match(run('/bin/sh', ['-c', `${SHIM_NAME} --help`], { PATH: `${dir}:${nodeDir}` }), /^Usage: agent-guild-report/, 'falls back to node on PATH');
    assert.equal(execFileSync('/bin/sh', ['-c', `${SHIM_NAME} --hook`], { env: { PATH: `${dir}:/usr/bin:/bin` }, input: '{"hook_event_name":"PreInvocation"}', encoding: 'utf8' }), '');
  }
});

test('hook events and the Claude Code status line report the model', () => {
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }), [{ model: 'claude-opus-5' }, { hello: true }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', source: 'startup' }), [{ hello: true }], 'the session start announces the hooks');
  assert.deepEqual(hookToReports({ hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'claude-sonnet-5' }), [{ model: 'claude-sonnet-5' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), [], 'Claude Code\'s prompt names no model');
  // Codex CLI names the model on every event; Antigravity CLI as modelName; Grok Build as modelId.
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', model: 'gpt-5-codex', prompt: 'hi' }), [{ finishForeground: true }, { model: 'gpt-5-codex' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PreInvocation', modelName: 'gemini-3.1-pro-high' }), [{ model: 'gemini-3.1-pro-high' }]);
  assert.deepEqual(hookToReports({ hookEventName: 'session_start', hook_event_name: 'SessionStart', modelId: 'grok-build' }), [{ model: 'grok-build' }, { hello: true }]);
  // Turn events that fire inside a sub-agent name it, and its model is not the session's.
  assert.ok(!hookToReports({ hook_event_name: 'UserPromptSubmit', agent_id: 'c1', agent_type: 'explorer', model: 'gpt-5-codex-mini', prompt: 'x' }).some((r) => r.model));
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', agent_id: 'a1', agent_type: 'Explore', model: 'claude-haiku-4-5' }), []);
  assert.deepEqual(hookToReports({ hookEventName: 'user_prompt_submit', hook_event_name: 'UserPromptSubmit', subagentType: 'reviewer', modelId: 'grok-build' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', agent_type: 'security-reviewer', model: 'claude-opus-5' }), [{ model: 'claude-opus-5' }, { hello: true }], 'a session started with --agent is still the main session');
  // Grok Build's real SessionStart carries no model: the card uses the screen scan.
  assert.deepEqual(hookToReports({ hookEventName: 'session_start', hook_event_name: 'SessionStart', sessionId: 's', cwd: '/w', source: 'new' }), [{ hello: true }, { toolSessionId: 's' }]);

  // The tool's own session id comes with the event that opens the session, and only for the main session.
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', session_id: '550e8400-e29b-41d4-a716-446655440000', source: 'resume', model: 'claude-opus-5' }),
    [{ model: 'claude-opus-5' }, { hello: true }, { toolSessionId: '550e8400-e29b-41d4-a716-446655440000' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionStart', session_id: 'child', agent_id: 'c1', agent_type: 'explorer' }), [], 'a sub-agent\'s session is not the tool session');
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', turn_id: 't1', session_id: 's', prompt: 'hi' }), [{ finishForeground: true }], 'later events do not repeat the id');

  const input = { model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' }, workspace: { current_dir: '/home/me/app' }, context_window: { used_percentage: 41.7 } };
  assert.deepEqual(claudeStatuslineToReport(input), { model: 'claude-opus-4-5', displayName: 'Opus 4.5' });
  assert.equal(claudeStatuslineToReport({ model: {} }), null);
  assert.equal(formatStatusLine(input), '[Opus 4.5] | app | 42% context');
  assert.equal(formatStatusLine({ model: { id: 'x' } }), '[x]');
  assert.equal(formatStatusLine(null), '');

  assert.equal(modelFromArgs(['--model', 'opus']), 'opus');
  assert.equal(modelFromArgs(['-p', '--model=gpt-5-codex']), 'gpt-5-codex');
  assert.equal(modelFromArgs(['-m', 'gemini-3.1-pro-high', 'x']), 'gemini-3.1-pro-high');
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

test('PATHEXT entries are trimmed on Windows, so a stray space cannot hide .cmd files from sessions', () => {
  assert.deepEqual(trimPathExt({ PATHEXT: '.COM;.EXE;.BAT;.CMD ' }, 'win32'), { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.deepEqual(trimPathExt({ PathExt: ' .EXE ;; .CMD' }, 'win32'), { PathExt: '.EXE;.CMD' });
  assert.deepEqual(trimPathExt({ Path: 'C:\\a' }, 'win32'), { Path: 'C:\\a' });
  assert.deepEqual(trimPathExt({ PATHEXT: '.CMD ' }, 'linux'), { PATHEXT: '.CMD ' });
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

for (const task of [null, 'install']) {
  test(`closing ${task === 'install' ? 'an installer' : 'a tool'} session keeps its provider guarded until the process exits`, async (t) => {
    const provider = { id: 'tool', tool: 'Tool' };
    const registry = {
      get: (id) => ({ ...provider, id }),
      resolve: () => null,
      installSpec: async () => ({}),
      uninstallSpec: () => ({ spec: {}, channel: 'native' }),
    };
    const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
    t.mock.method(manager, '_spawn', (options) => options);
    let exit;
    const session = {
      provider, task, status: 'running',
      exited: new Promise((resolve) => { exit = resolve; }),
      _broadcast() {}, dispose: t.mock.fn(),
    };
    manager.sessions.set('closing', session);
    const blocked = task === 'install' ? { code: 'install_in_progress' } : { code: 'provider_in_use', running: 1 };
    const assertBlocked = async (options) => {
      await assert.rejects(manager.install(provider.id, options), blocked);
      assert.throws(() => manager.uninstall(provider.id, 'copy', options), blocked);
    };
    await assertBlocked();
    manager.remove('closing');
    assert.equal(session.dispose.mock.callCount(), 1, 'closing requests process termination');
    assert.equal(manager.sessions.size, 0, 'the session is no longer visible');
    await assertBlocked();

    if (task === 'install') {
      await assertBlocked({ force: true });
    } else {
      assert.equal((await manager.install(provider.id, { force: true })).installKind, 'install');
      assert.equal(manager.uninstall(provider.id, 'copy', { force: true }).installKind, 'uninstall');
    }
    assert.equal((await manager.install('other')).installKind, 'install', 'another provider is unaffected');
    assert.equal(manager.uninstall('other', 'copy').installKind, 'uninstall');

    exit();
    await session.exited;
    assert.equal((await manager.install(provider.id)).installKind, 'install', 'exit releases the guard');
    assert.equal(manager.uninstall(provider.id, 'copy').installKind, 'uninstall');
  });
}

test('a tool session cannot start while that tool is installed, updated or removed', async (t) => {
  const provider = { id: 'tool', tool: 'Tool', args: [], accounts: [] };
  const registry = {
    get: (id) => ({ ...provider, id }),
    account: () => ({ id: 'default', label: 'Default' }),
    shellFor: () => null,
    spawnSpec: () => ({}),
    uninstallSpec: () => ({ spec: {}, channel: 'native' }),
  };
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
  t.mock.method(manager, '_spawn', (options) => {
    if (options.task === 'install') manager.sessions.set('removal', { provider: options.provider, task: 'install', status: 'running' });
    return { ...options, setModel() {} };
  });
  // The uninstall starts while the session waits for its launch hooks.
  manager.sessionHooks = { launch: async () => { manager.uninstall('tool', 'copy'); return { args: [], reporting: null }; } };
  await assert.rejects(manager.create({ providerId: 'tool', cwd: os.tmpdir() }), { code: 'install_in_progress', status: 409 });
  assert.equal(manager._spawn.mock.calls.filter((c) => !c.arguments[0].task).length, 0, 'no tool process was started');

  manager.sessionHooks = null;
  await assert.rejects(manager.create({ providerId: 'tool', cwd: os.tmpdir() }), { code: 'install_in_progress' });
  assert.equal((await manager.create({ providerId: 'other', cwd: os.tmpdir() })).provider.id, 'other', 'another tool is unaffected');
  manager.sessions.get('removal').status = 'exited';
  assert.equal((await manager.create({ providerId: 'tool', cwd: os.tmpdir() })).provider.id, 'tool', 'the tool starts once the removal ends');

  manager.installing.add('tool');
  await assert.rejects(manager.create({ providerId: 'tool', cwd: os.tmpdir() }), { code: 'install_in_progress' }, 'an install still resolving its release counts');
});

test('a Shell session is named after its shell and gets its environment', async (t) => {
  const bash = { id: 'git-bash', label: 'Git Bash', path: 'bash.exe', args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } };
  const cmd = { id: 'cmd', label: 'Command Prompt', path: 'cmd.exe', args: [], env: {} };
  let shells = [cmd, bash];
  const registry = {
    env: {}, platform: 'win32',
    get: (id) => ({ id, tool: 'Shell', args: ['--own'], accounts: [{ id: 'default' }] }),
    account: () => ({ id: 'default', label: 'Default' }),
    shellFor: (provider, id) => shells.find((s) => s.id === (id ?? 'cmd')),
    shellsFor: () => ({ shells, defaultId: 'cmd' }),
    spawnSpec: ProviderRegistry.prototype.spawnSpec,
  };
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
  t.mock.method(manager, '_spawn', (options) => ({ ...options, setModel() {} }));
  const session = await manager.create({ providerId: 'shell', shell: 'git-bash', cwd: os.tmpdir(), args: ['-c', 'pwd'] });
  assert.deepEqual([session.name, session.spawnSpec.file, session.extraEnv], ['Shell · Git Bash', 'bash.exe', { CHERE_INVOKING: '1' }]);
  assert.deepEqual(session.spawnSpec.args, ['--login', '-i', '-c', 'pwd']);
  const defaultSession = await manager.create({ providerId: 'shell', cwd: os.tmpdir() });
  assert.equal(defaultSession.name, 'Shell · Command Prompt');
  assert.deepEqual(defaultSession.spawnSpec, { file: 'cmd.exe', args: ['--own'] });
  assert.equal((await manager.create({ providerId: 'shell', cwd: os.tmpdir(), name: 'Mine' })).name, 'Mine');
  shells = [cmd];
  assert.equal((await manager.create({ providerId: 'shell', cwd: os.tmpdir() })).name, null, 'no name when there is no choice');
  await assert.rejects(manager.create({ providerId: 'shell', shell: 7, cwd: os.tmpdir() }), { code: 'bad_shell', status: 400 });
});

test('a tmux card gets a tmux session of its own with its identity, and a client without it', { skip: process.platform === 'win32' }, async (t) => {
  // A stand-in tmux that records how it was run and what it read.
  const dir = tempDir();
  const log = path.join(dir, 'tmux');
  const fakeTmux = path.join(dir, 'fake-tmux');
  fs.writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}.args"\ncat > "${log}.stdin"\nprintf '%s\\n' "\${AGENT_GUILD_REPORT_TOKEN:-none}" > "${log}.token"\n`, { mode: 0o755 });
  const bash = { id: 'bash', label: 'bash', path: '/bin/bash', args: [], env: {} };
  const tmux = { id: 'tmux', label: 'tmux', path: fakeTmux, args: ['-u', 'attach-session', '-t', '={name}'], env: {}, multiplexer: { attach: 'tmux attach -t {name}' } };
  const registry = {
    env: {}, platform: process.platform,
    get: (id) => ({ id, tool: 'Shell', args: ['--own'], resumeArgs: [], accounts: [{ id: 'default' }] }),
    account: () => ({ id: 'default', label: 'Default' }),
    shellFor: (provider, id) => [bash, tmux].find((s) => s.id === (id ?? 'bash')),
    shellsFor: () => ({ shells: [bash, tmux], defaultId: 'bash' }),
    spawnSpec: ProviderRegistry.prototype.spawnSpec,
  };
  const manager = new SessionManager({ registry, baseEnv: { PATH: process.env.PATH }, getApiUrl: () => 'http://127.0.0.1:1' });
  t.mock.method(manager, '_spawn', (options) => ({ ...options, setModel() {}, on() {}, once() {} }));
  const session = await manager.create({ providerId: 'shell', shell: 'tmux', cwd: dir, cols: 90, rows: 25, args: ['htop'] });
  const name = session.spawnSpec.args[3].slice(1);
  assert.match(name, /^guild-[0-9a-f]{6}$/);
  assert.deepEqual(session.spawnSpec, { file: fakeTmux, args: ['-u', 'attach-session', '-t', `=${name}`] }, 'the card\'s client attaches; the provider\'s own args are for its default shell');
  assert.deepEqual([session.name, session.multiplexer], ['Shell · tmux', { label: 'tmux', attach: `tmux attach -t ${name}`, reattachable: false }]);
  assert.equal(fs.readFileSync(`${log}.args`, 'utf8'), '-u start-server ; source-file -\n');
  const made = fs.readFileSync(`${log}.stdin`, 'utf8');
  assert.match(made, new RegExp(`^new-session -d -s '${name}' -x 90 -y 25 -c '${dir.replaceAll('\\', '\\\\')}' `));
  assert.ok(made.includes(` -e 'AGENT_GUILD_SESSION_ID=${session.id}' `) && made.includes(` -e 'AGENT_GUILD_REPORT_TOKEN=${session.reportToken}' `), 'the card\'s identity is the tmux session\'s own');
  assert.match(made, / -e 'PATH=[^']+' /, 'PATH reaches it too, so agent-guild-report is found as in a shell');
  assert.ok(made.endsWith(" 'htop'\n"), 'request args are the command it runs');
  assert.equal(fs.readFileSync(`${log}.token`, 'utf8'), 'none\n', 'the tmux server it may start never gets the token');
  assert.deepEqual(['AGENT_GUILD_REPORT_TOKEN', 'AGENT_GUILD_SESSION_ID', 'PATH'].map(session.dropEnv), [true, true, false]);
  const second = await manager.create({ providerId: 'shell', shell: 'tmux', cwd: dir });
  assert.notEqual(second.spawnSpec.args[3], session.spawnSpec.args[3], 'every card gets its own tmux session');
  assert.deepEqual(tmux.args, ['-u', 'attach-session', '-t', '={name}'], 'the detected recipe stays as it was');
  const plain = await manager.create({ providerId: 'shell', cwd: dir });
  assert.deepEqual([plain.spawnSpec, plain.multiplexer, plain.dropEnv], [{ file: '/bin/bash', args: ['--own'] }, undefined, undefined]);
  // A line break cannot reach tmux's command parser: the request is refused, and tmux never runs.
  fs.rmSync(`${log}.args`);
  const broken = path.join(dir, 'a\nb');
  fs.mkdirSync(broken);
  await assert.rejects(manager.create({ providerId: 'shell', shell: 'tmux', cwd: broken }), { status: 400, code: 'bad_cwd' });
  await assert.rejects(manager.create({ providerId: 'shell', shell: 'tmux', cwd: dir, args: ['two\nlines'] }), { status: 400, code: 'bad_args' });
  assert.equal(fs.existsSync(`${log}.args`), false, 'tmux never ran');
});

test('tmux cards are kept across restarts, and come back closed with their own identity while tmux has their session', { skip: process.platform === 'win32' }, async (t) => {
  // A stand-in tmux: has-session succeeds for the names listed in TMUX_ALIVE.
  const dir = tempDir();
  const alive = path.join(dir, 'alive');
  fs.writeFileSync(alive, '');
  const fakeTmux = path.join(dir, 'fake-tmux');
  fs.writeFileSync(fakeTmux, '#!/bin/sh\nif [ "$1" = has-session ]; then grep -qx -- "${3#=}" "$TMUX_ALIVE"; elif [ "$2" = attach-session ]; then pwd; exec cat > /dev/null; else cat > /dev/null; fi\n', { mode: 0o755 });
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const bash = { id: 'bash', label: 'bash', path: '/bin/bash', args: [], env: {} };
  const tmux = { id: 'tmux', label: 'tmux', path: fakeTmux, args: ['-u', 'attach-session', '-t', '={name}'], env: {}, multiplexer: { attach: 'tmux attach -t {name}' } };
  const provider = { id: 'shell', tool: 'Shell', args: [], resumeArgs: [], accounts: [{ id: 'default' }], env: {} };
  const registry = {
    env: {}, platform: process.platform,
    get: (id) => (id === 'shell' ? provider : null),
    describe: () => ({ id: 'shell', vendor: 'Local', tool: 'Shell' }),
    account: () => ({ id: 'default', label: 'Default', env: {} }),
    shellFor: (p, id) => [bash, tmux].find((s) => s.id === (id ?? 'bash')),
    shellsFor: () => ({ shells: [bash, tmux], defaultId: 'bash' }),
    spawnSpec: ProviderRegistry.prototype.spawnSpec,
  };
  let saved = [];
  const store = { load: () => structuredClone(saved), save: (cards) => { saved = structuredClone(cards); } };
  const baseEnv = { PATH: process.env.PATH, TMUX_ALIVE: alive };
  const first = new SessionManager({ registry, baseEnv, getApiUrl: () => 'http://127.0.0.1:1', store });
  t.mock.method(first, '_spawn', (options) => Object.assign(new EventEmitter(), options, { createdAt: '2026-10-03T09:00:00.000Z', setModel() {} }));
  const kept = await first.create({ providerId: 'shell', shell: 'tmux', cwd: project, name: 'Kept' });
  await first.create({ providerId: 'shell', shell: 'tmux', cwd: project, name: 'Gone' });
  assert.deepEqual(saved.map((card) => card.name), ['Kept', 'Gone']);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['account', 'createdAt', 'cwd', 'id', 'muxName', 'name', 'provider', 'reportToken', 'shell']);
  kept.name = 'Kept, renamed';
  kept.emit('changed');
  assert.equal(saved[0].name, 'Kept, renamed', 'a rename is kept');
  fs.writeFileSync(alive, `${saved[0].muxName}\n`); // tmux still has the first card's session, not the second's

  // A manager stopped while it asks tmux about the cards leaves them all for the next one.
  const stopping = new SessionManager({ registry, baseEnv, getApiUrl: () => 'http://127.0.0.1:1', store });
  const restoring = stopping.restore();
  await stopping.shutdown();
  await restoring;
  assert.deepEqual([stopping.list(), saved.map((card) => card.name)], [[], ['Kept, renamed', 'Gone']]);

  const next = new SessionManager({ registry, baseEnv, getApiUrl: () => 'http://127.0.0.1:1', store });
  t.after(() => next.shutdown());
  await next.restore();
  assert.deepEqual(next.list().map((s) => [s.id, s.name, s.status, s.createdAt, s.cwd, s.multiplexer]), [
    [kept.id, 'Kept, renamed', 'exited', '2026-10-03T09:00:00.000Z', project, { label: 'tmux', attach: `tmux attach -t ${saved[0].muxName}`, reattachable: true }],
  ]);
  assert.equal(next.get(kept.id).reportToken, kept.reportToken, 'with its own report token, which tools inside still hold');
  assert.deepEqual(saved.map((card) => card.id), [kept.id], 'a card whose session is gone is forgotten');
  // Reattach waits until the manager has found tmux still has the session, as the page does.
  const back = next.get(kept.id);
  back.multiplexer.reattachable = false; // as while it is still asking tmux after the client closed
  await assert.rejects(next.reattach(kept.id), { status: 409, code: 'multiplexer_session_gone' });
  back.multiplexer.reattachable = true;
  // The card's folder is gone by now: its client starts in the home folder, and the card still shows where it ran.
  fs.rmSync(project, { recursive: true });
  await next.reattach(kept.id);
  const home = fs.realpathSync(os.homedir());
  const shown = await new Promise((resolve) => {
    let text = '';
    back.attach((msg) => {
      if (msg.type === 'snapshot' || msg.type === 'data') text += msg.data;
      if (msg.type === 'exit' || text.includes(home)) resolve(text);
    });
  });
  assert.ok(shown.includes(home), shown);
  assert.deepEqual([back.status, back.cwd], ['running', project]);
  next.remove(kept.id);
  assert.deepEqual(saved, [], 'a removed card is forgotten');
});

test('stopping the manager asks first only for the sessions it ends, not the tmux and herdr ones it detaches', () => {
  const manager = new SessionManager({ registry: null, baseEnv: {}, getApiUrl: () => '' });
  manager.sessions.set('a', { status: 'running', multiplexer: null });
  manager.sessions.set('b', { status: 'running', multiplexer: { label: 'tmux', attach: 'tmux attach -t guild-3f9a2c', reattachable: false } });
  manager.sessions.set('c', { status: 'exited', multiplexer: null });
  assert.equal(manager.runningCount(), 1);
});

test('shutdown reports the processes that did not confirm exiting in time', async () => {
  const fakeSession = (exited) => ({ status: 'running', exited, dispose() {} });
  const manager = new SessionManager({ registry: null, baseEnv: {}, getApiUrl: () => '' });

  manager.sessions.set('a', fakeSession(Promise.resolve()));
  manager.sessions.set('b', fakeSession(new Promise((resolve) => setTimeout(resolve, 10))));
  assert.deepEqual(await manager.shutdown({ timeoutMs: 2000 }), { remaining: 0 });
  assert.equal(manager.closing, true);

  const stuck = new SessionManager({ registry: null, baseEnv: {}, getApiUrl: () => '' });
  stuck.sessions.set('a', fakeSession(Promise.resolve()));
  stuck.sessions.set('b', fakeSession(new Promise(() => {}))); // never exits
  assert.deepEqual(await stuck.shutdown({ timeoutMs: 50 }), { remaining: 1 });
});

test('the npm registry lookup waits for PATH discovery in flight', async () => {
  const root = tempDir();
  const toolDir = path.join(root, 'tools');
  fs.mkdirSync(toolDir);
  const env = { PATH: root, HOME: root, USERPROFILE: root };
  const discovered = [root, toolDir].join(path.delimiter);
  let release;
  const registry = new ProviderRegistry({
    userFile: path.join(root, 'none.json'), env, checkUpdates: false,
    pathReader: () => new Promise((resolve) => { release = () => resolve(discovered); }),
  });
  // As at startup: the provider check starts reading the PATH, and the
  // manager's own check asks for the registry straight after.
  const refresh = registry.refreshVersions();
  const pathSeen = [];
  const lookup = registry.npmRegistryUrl().then((url) => { pathSeen.push(env.PATH); return url; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pathSeen.length, 0, 'the lookup waits while the PATH is being read');
  release();
  await refresh;
  assert.equal(await lookup, 'https://registry.npmjs.org', 'no npm on that PATH, so the default registry');
  assert.equal(pathSeen[0], discovered, 'the lookup ran against the discovered PATH');
  assert.equal(await registry.refreshPath(), false, 'nothing in flight afterwards');
});

test('the manager checks its own release and knows when a restart is needed', async () => {
  const dir = tempDir();
  const packageFile = path.join(dir, 'package.json');
  const writeVersion = (version) => fs.writeFileSync(packageFile, JSON.stringify({ name: '@scope/app', version }));
  writeVersion('1.0.0');
  const calls = [];
  let latest = '1.1.0';
  const registry = {
    checkUpdates: true,
    registryUrl: null,
    env: {},
    platform: 'linux',
    fetchImpl: async (url) => { calls.push(url); if (!latest) throw new Error('offline'); return { ok: true, json: async () => ({ version: latest }) }; },
    npmRegistryUrl: async () => 'https://registry.example',
    resolveNpm: () => '/usr/bin/npm',
    npmArgs: ProviderRegistry.prototype.npmArgs,
  };
  const self = new SelfUpdate({ pkg: '@scope/app', version: '1.0.0', packageFile, registry });
  let updates = 0;
  self.on('updated', () => updates++);
  assert.equal(self.describe().available, false, 'nothing is on offer before the first check');

  await self.refresh();
  assert.deepEqual(calls, ['https://registry.example/@scope%2fapp/latest']);
  let info = self.describe();
  assert.equal(info.version, '1.0.0');
  assert.equal(info.latestVersion, '1.1.0');
  assert.equal(info.available, true);
  assert.equal(info.command, '/usr/bin/npm install -g @scope/app@1.1.0');
  assert.equal(info.pendingVersion, null);
  assert.equal(updates, 1);
  await self.refresh();
  assert.equal(calls.length, 1, 'the registry is asked about once an hour');
  await self.refresh({ force: true });
  assert.equal(calls.length, 2);
  assert.equal(updates, 1, 'no event when nothing changed');
  assert.deepEqual(await self.spec(), { spec: { file: '/usr/bin/npm', args: ['install', '-g', '@scope/app@1.1.0'] }, version: '1.1.0' });

  // A check that fails keeps the release already known.
  latest = null;
  await self.refresh({ force: true });
  assert.equal(calls.length, 3);
  info = self.describe();
  assert.equal(info.latestVersion, '1.1.0', 'the last known release survives a failed check');
  assert.equal(info.available, true);
  assert.equal(updates, 2, 'the error is reported');
  latest = '1.1.0';
  await self.refresh();
  assert.equal(calls.length, 3, 'not retried at once');
  self.checkedAt -= 6 * 60 * 1000;
  await self.refresh();
  assert.equal(calls.length, 4, 'a failed check is retried after a few minutes, not an hour');
  assert.equal(updates, 3, 'the error clears');

  // npm exited cleanly but did not replace these files (another prefix, say).
  self.finishInstall({ exitCode: 0 });
  assert.equal(self.describe().lastInstall.outcome, 'unchanged');
  assert.equal(self.describe().available, true, 'the upgrade stays on offer');
  self.finishInstall({ exitCode: 1 });
  assert.equal(self.describe().lastInstall.outcome, 'failed');
  assert.equal(self.describe().lastInstall.exitCode, 1);

  // A newer release supersedes the outcome of the old attempt.
  latest = '1.2.0';
  await self.refresh({ force: true });
  assert.equal(self.describe().latestVersion, '1.2.0');
  assert.equal(self.describe().lastInstall, null, 'the stale outcome is dropped');
  latest = '1.1.0';
  await self.refresh({ force: true });
  self.finishInstall({ exitCode: 1 });
  assert.equal(self.describe().lastInstall.outcome, 'failed');

  writeVersion('1.1.0');
  self.finishInstall({ exitCode: 0 });
  info = self.describe();
  assert.equal(info.lastInstall.outcome, 'installed');
  assert.equal(info.pendingVersion, '1.1.0', 'the new files are on disk while the running manager is still 1.0.0');
  assert.equal(info.available, false, 'nothing newer than the files on disk');
  assert.equal(info.command, null);
  await assert.rejects(self.spec(), { code: 'not_updatable', message: /restart the manager/ });

  // While npm runs, nothing is offered or announced, even once package.json
  // is already new: dependencies may still be being written.
  writeVersion('1.0.0');
  self.beginInstall();
  writeVersion('1.1.0');
  info = self.describe();
  assert.equal(info.installing, true);
  assert.equal(info.available, false);
  assert.equal(info.pendingVersion, null, 'no restart advice mid-install');
  assert.equal(info.lastInstall, null);
  await assert.rejects(self.spec(), { code: 'upgrade_in_progress' });
  self.finishInstall({ exitCode: 0 });
  info = self.describe();
  assert.equal(info.installing, false);
  assert.equal(info.pendingVersion, '1.1.0');
  assert.equal(info.lastInstall.outcome, 'installed');

  // An upgrade stopped after npm replaced package.json: the files are
  // suspect, so no restart advice, and the same release is offered again.
  self.beginInstall();
  self.finishInstall({ exitCode: null });
  info = self.describe();
  assert.equal(info.lastInstall.outcome, 'failed');
  assert.equal(info.pendingVersion, null, 'no restart advice after an interrupted install');
  assert.equal(info.available, true, 'the same release stays on offer');
  assert.equal(info.command, '/usr/bin/npm install -g @scope/app@1.1.0');
  assert.equal((await self.spec()).version, '1.1.0', 'the retry is accepted');
  // A newer release supersedes the failure record, not the suspicion.
  latest = '1.2.0';
  await self.refresh({ force: true });
  info = self.describe();
  assert.equal(info.lastInstall, null);
  assert.equal(info.pendingVersion, null, 'the unfinished files are still not advertised');
  assert.equal(info.available, true);
  assert.equal(info.command, '/usr/bin/npm install -g @scope/app@1.2.0');
  latest = '1.1.0';
  await self.refresh({ force: true });
  self.beginInstall();
  self.finishInstall({ exitCode: 0 });
  info = self.describe();
  assert.equal(info.lastInstall.outcome, 'installed');
  assert.equal(info.pendingVersion, '1.1.0', 'a completed retry restores the restart advice');
  assert.equal(info.available, false);

  // Without npm there is guidance instead of a command.
  writeVersion('1.0.0');
  registry.resolveNpm = () => null;
  info = self.describe();
  assert.equal(info.available, true);
  assert.equal(info.command, null);
  assert.match(info.guidance, /npm install -g @scope\/app@1\.1\.0/);
  await assert.rejects(self.spec(), { code: 'npm_unavailable' });

  // Development builds and disabled checks never ask the registry.
  assert.equal(isDevelopmentBuild('0.0.0-development'), true);
  assert.equal(isDevelopmentBuild('0.0.0'), true);
  assert.equal(isDevelopmentBuild('1.0.0'), false);
  const before = calls.length;
  const dev = new SelfUpdate({ pkg: '@scope/app', version: '0.0.0-development', packageFile, registry });
  await dev.refresh();
  assert.equal(calls.length, before);
  assert.equal(dev.describe().available, false);
  await assert.rejects(dev.spec(), { code: 'not_updatable', message: /development build/ });
  const off = new SelfUpdate({ pkg: '@scope/app', version: '1.0.0', packageFile, registry: { ...registry, checkUpdates: false } });
  await off.refresh();
  assert.equal(calls.length, before);
  assert.equal(off.describe().latestVersion, null);
  await assert.rejects(off.spec(), { code: 'not_updatable', message: /AGENT_GUILD_NO_UPDATE_CHECK/ });
});

function catalogEntry(id, { created = 1780000000, coding, intelligence, agentic, arena = [], tools = true, output = ['text'], canonical = '', name = `Test: ${id}`, context = 100000 } = {}) {
  return {
    id,
    canonical_slug: canonical,
    name,
    created,
    context_length: context,
    architecture: { input_modalities: ['text', 'image'], output_modalities: output },
    pricing: { prompt: '0.000003', completion: '0.000015' },
    top_provider: { max_completion_tokens: 64000 },
    supported_parameters: tools ? ['temperature', 'tools'] : ['temperature'],
    benchmarks: {
      artificial_analysis: { coding_index: coding ?? null, intelligence_index: intelligence ?? null, agentic_index: agentic ?? null },
      design_arena: arena,
    },
  };
}

const arenaRow = (category, elo, rank = null, arena = 'models') => ({ arena, category, elo, win_rate: 60, rank });
const catalogOf = (...entries) => indexCatalog(parseCatalog({ data: entries }));
const statsOf = (index, providers, sessions = []) =>
  describeCatalog({ index, retrievedAt: '2026-10-01T00:00:00.000Z', stale: false, error: null }, providers, sessions);

test('levels rank a result among the other results, and ties share the average place', () => {
  assert.deepEqual([100, 90, 89, 75, 74, 50, 49, 25, 24, 0].map(tierFor), ['S', 'S', 'A', 'A', 'B', 'B', 'C', 'C', 'D', 'D']);
  const values = Array.from({ length: 21 }, (_, i) => 100 - i);
  const others = (i) => values.filter((_, j) => j !== i);
  assert.deepEqual(standing(98, others(2)), { level: 90, tier: 'S', place: 3, tied: false, of: 21 });
  assert.equal(standing(100, others(0)).level, 100);
  assert.equal(standing(80, others(20)).level, 0);
  assert.deepEqual(standing(8, [10, 8, 8, 1]), { level: 50, tier: 'B', place: 2, tied: true, of: 5 });
  assert.equal(standing(5, [5, 3, 2, 1]).level, 88, 'half a level rounds up');
  assert.equal(standing(99, []), null, 'no level without another result to compare with');
});

test('the catalog keeps well-formed listings and only published numbers', () => {
  const entry = catalogEntry('anthropic/claude-x-1', {
    name: 'Anthropic: Claude X 1',
    coding: 70,
    arena: [arenaRow('website', 1300, 4), arenaRow('website', 1200, 9), arenaRow('svg', 1250, 2), { arena: 'models', category: 'gamedev', elo: 'high' }],
  });
  entry.benchmarks.artificial_analysis.intelligence_index = '55';
  entry.pricing = { prompt: '0.000004', completion: '-1' };
  const listings = parseCatalog({ data: [entry, catalogEntry('~anthropic/claude-x-latest'), catalogEntry('No Author'), null, { id: 42 }] });
  assert.deepEqual(listings.map((listing) => listing.id), ['anthropic/claude-x-1']);
  const [listing] = listings;
  assert.equal(listing.name, 'Claude X 1');
  assert.deepEqual(Object.keys(listing.values).sort(), ['coding', 'svg'], 'a string score and a category listed twice are not results');
  assert.deepEqual(listing.values.svg, { value: 1250, rank: 2 });
  assert.deepEqual(listing.price, { input: 4, output: null });
  assert.deepEqual([listing.context, listing.maxOutput, listing.tools, listing.text], [100000, 64000, true, true]);
  assert.deepEqual(parseCatalog({}), []);
});

test('confirmed duplicate listings merge, and listings that disagree stay apart or are dropped', () => {
  const index = catalogOf(
    catalogEntry('openai/gpt-9-luna', { canonical: 'openai/gpt-9-luna-20260922', coding: 70, arena: [arenaRow('website', 1500, 2)] }),
    catalogEntry('openai/gpt-9-luna:batch', { canonical: 'openai/gpt-9-luna-20260922', coding: 70, arena: [arenaRow('website', 1500, 2)], context: 999 }),
    catalogEntry('qwen/a', { canonical: 'qwen/same', coding: 10 }),
    catalogEntry('qwen/b', { canonical: 'qwen/same', coding: 90 }),
    catalogEntry('x/dup', { coding: 10 }),
    catalogEntry('x/dup', { coding: 90 }),
  );
  assert.deepEqual([...index.models.keys()].sort(), ['openai/gpt-9-luna', 'qwen/a', 'qwen/b']);
  assert.equal(index.aliasOf.get('openai/gpt-9-luna:batch'), 'openai/gpt-9-luna');
  assert.equal(index.bySlug.get('gpt-9-luna'), 'openai/gpt-9-luna');
  assert.equal(index.aliasOf.has('x/dup'), false, 'copies of one id that disagree are not scored');
});

test('levels compare the benchmarked models the configured tools run, and missing results stay missing', () => {
  const providers = [
    { id: 'one', tool: 'Tool One', modelPattern: 'one-[a-z0-9.]+' },
    { id: 'two', tool: 'Tool Two', modelPattern: 'two-[a-z0-9.]+' },
    { id: 'shell', tool: 'Shell', modelPattern: null },
  ];
  const entries = [
    catalogEntry('a/one-new', { created: 1790000000, intelligence: 60 }),
    catalogEntry('a/one-full', { created: 1780000000, coding: 80, intelligence: 50, agentic: 40 }),
    catalogEntry('a/one-old', { created: 1770000000, coding: 60 }),
    catalogEntry('a/one-unmeasured', { created: 1795000000 }),
    catalogEntry('a/one-notools', { coding: 99, tools: false }),
    catalogEntry('a/one-image', { coding: 99, output: ['image'] }),
    catalogEntry('b/two-1', { coding: 70, arena: [arenaRow('webapps', 1300, 1, 'agents')] }),
    catalogEntry('c/outside', { coding: 100 }),
  ];
  const stats = statsOf(catalogOf(...entries), providers, [
    { id: 's1', provider: { id: 'shell' }, model: { name: 'outside', displayName: null } },
    { id: 's2', provider: { id: 'one' }, model: null },
  ]);
  assert.deepEqual(stats.pool, { tools: ['Tool One', 'Tool Two'] });
  assert.deepEqual(stats.providers.one, { featured: 'a/one-full', models: ['a/one-new', 'a/one-full', 'a/one-old'] });
  assert.equal(stats.providers.shell, undefined);
  assert.ok(stats.stats.every((stat) => stat.about.includes('When building:')), 'every benchmark says what it means for building');
  const coding = (id) => stats.models[id].stats.coding;
  assert.deepEqual([coding('a/one-full').level, coding('b/two-1').level, coding('a/one-old').level], [100, 50, 0]);
  assert.equal(coding('a/one-full').of, 3);
  assert.equal(stats.models['a/one-old'].stats.intelligence, undefined, 'a missing result is not a zero');
  assert.equal(stats.models['a/one-new'].stats.intelligence.level, 100);
  assert.deepEqual([stats.models['a/one-new'].new, stats.models['a/one-full'].new], [true, false]);
  assert.equal(stats.sessions.s1, 'c/outside');
  assert.deepEqual(coding('c/outside'), { level: 100, tier: 'S', place: 1, tied: false, of: 4, value: 100, rank: null });
  assert.equal(coding('a/one-full').level, 100, 'a model outside the lists moves nobody else');
  assert.equal('s2' in stats.sessions, false);
  assert.deepEqual(stats.models['b/two-1'].stats.webapps, { level: null, tier: null, place: null, tied: false, of: null, value: 1300, rank: 1 });
  const shuffled = statsOf(catalogOf(...[...entries].reverse()), providers);
  for (const id of Object.keys(shuffled.models)) assert.deepEqual(shuffled.models[id], stats.models[id]);
});

test('a session model matches its catalog listing exactly, never a provider, prefix or sibling', () => {
  const index = catalogOf(...[
    'anthropic/claude-opus-5.5', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5',
    'openai/gpt-6-astra', 'openai/gpt-4o-2024-11-20', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'x-ai/grok-build-0.1',
  ].map((id) => catalogEntry(id, { intelligence: 50 })));
  const providers = loadProviders({ platform: 'linux' }).providers;
  const related = (id) => providerModels(index, providers.find((p) => p.id === id));
  assert.deepEqual(related('anthropic').map((m) => m.id).sort(),
    ['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5']);
  assert.deepEqual(related('xai').map((m) => m.slug).sort(), ['grok-4.7', 'grok-build-0.1']);
  assert.deepEqual(related('shell'), []);
  const match = (provider, name, displayName = null) => resolveModel(index, related(provider), { name, displayName });
  assert.equal(match('anthropic', 'claude-opus-5-5'), 'anthropic/claude-opus-5.5');
  assert.equal(match('anthropic', 'claude-opus-5-5[1m]'), 'anthropic/claude-opus-5.5');
  assert.equal(match('anthropic', 'Opus 5.5'), 'anthropic/claude-opus-5.5');
  assert.equal(match('anthropic', 'Opus 5'), 'anthropic/claude-opus-5');
  assert.equal(match('anthropic', 'claude-haiku-4-5-20251001'), 'anthropic/claude-haiku-4.5');
  assert.equal(match('anthropic', 'opus', 'Sonnet 5'), 'anthropic/claude-sonnet-5');
  assert.equal(match('anthropic', 'anthropic/claude-opus-5.5:nitro'), 'anthropic/claude-opus-5.5');
  assert.equal(match('openai', 'gpt-6-astra'), 'openai/gpt-6-astra');
  assert.equal(match('openai', 'gpt-4o-2024-11-20'), 'openai/gpt-4o-2024-11-20');
  assert.equal(match('google', 'gemini-3.8-flash'), 'google/gemini-3.8-flash');
  assert.equal(match('xai', 'grok-4.7'), 'x-ai/grok-4.7');
  assert.equal(match('shell', 'claude-opus-5-5'), 'anthropic/claude-opus-5.5');
  for (const name of ['anthropic', 'claude', 'anthropic/claude', 'anthropic/claude-opus', 'opus', 'Opus', 'claude-opus-5-6', 'gpt-6', '5.5', '']) {
    assert.equal(match('anthropic', name), null, name);
  }
  for (const name of ['grok-build', 'grok-4.7-build-fast']) assert.equal(match('xai', name), null, name);
  assert.deepEqual(modelNames(' Claude-Opus-4-5-20251101 '), ['claude-opus-4-5-20251101', 'claude-opus-4-5', 'claude-opus-4.5']);
});

test('a reported variant matches its own listing, and only a suffix the catalog lacks falls back to the base model', () => {
  const index = catalogOf(
    catalogEntry('cohere/north-mini-code:free', { coding: 36.5 }),
    catalogEntry('x/merged', { canonical: 'x/merged-1', coding: 50 }),
    catalogEntry('x/merged:batch', { canonical: 'x/merged-1', coding: 50 }),
    catalogEntry('x/split', { canonical: 'x/split-1', coding: 50 }),
    catalogEntry('x/split:batch', { canonical: 'x/split-1', coding: 70 }),
  );
  const match = (name) => resolveModel(index, [], { name, displayName: null });
  assert.equal(match('cohere/north-mini-code:free'), 'cohere/north-mini-code:free', 'a listing that only exists with its suffix');
  assert.equal(match('north-mini-code:free'), 'cohere/north-mini-code:free');
  assert.equal(match('cohere/north-mini-code'), null, 'a base id that is not listed borrows nothing');
  assert.equal(match('x/split:batch'), 'x/split:batch', 'a variant with its own results is not its base');
  assert.equal(match('split:batch'), 'x/split:batch');
  assert.equal(match('x/merged:batch'), 'x/merged', 'a merged variant is its base');
  assert.equal(match('x/split:nitro'), 'x/split', 'a routing suffix the catalog does not list');
  assert.deepEqual(modelNames('X/Split:Batch'), ['x/split:batch', 'x/split']);
});

test('the catalog is fetched once, shared while in flight, and kept when a refresh fails', async () => {
  const registry = { providers: [{ id: 'one', tool: 'Tool One', modelPattern: 'one-[a-z0-9]+' }] };
  const payload = { data: [catalogEntry('a/one-1', { coding: 10 }), catalogEntry('a/one-2', { coding: 20 })] };
  const seen = [];
  let answer = () => ({ ok: true, json: async () => payload });
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return answer();
  };
  const stats = new ModelStats({ registry, fetchImpl, ttlMs: 60000, retryMs: 60000 });
  const [first, second] = await Promise.all([stats.snapshot(), stats.snapshot()]);
  assert.equal(seen.length, 1);
  assert.deepEqual(first, second);
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(seen[0].init.headers.Accept, 'application/json');
  assert.equal(first.error, null);
  assert.deepEqual(first.providers.one.models, ['a/one-1', 'a/one-2']);
  await stats.snapshot();
  assert.equal(seen.length, 1, 'cached while fresh');

  stats.ttlMs = 0;
  answer = () => ({ ok: false, status: 503, json: async () => ({}) });
  const stale = await stats.snapshot();
  assert.equal(seen.length, 2);
  assert.deepEqual([stale.stale, stale.error, stale.retrievedAt], [true, 'OpenRouter answered HTTP 503', first.retrievedAt]);
  assert.deepEqual(stale.providers, first.providers);
  await stats.snapshot();
  assert.equal(seen.length, 2, 'a failed refresh is retried later, not on every request');

  const failing = (fail) => new ModelStats({ registry, fetchImpl: async () => fail() }).snapshot();
  const offline = await failing(() => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  assert.deepEqual([offline.error, offline.pool, offline.providers, offline.stats.length],
    ['OpenRouter could not be reached (ENOTFOUND)', null, {}, 13]);
  assert.equal((await failing(() => { throw new DOMException('timed out', 'TimeoutError'); })).error, 'OpenRouter did not answer within 20 seconds');
  assert.equal((await failing(() => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }))).error,
    'OpenRouter sent a model list that could not be read');
  assert.equal((await failing(() => ({ ok: true, json: async () => ({ data: [] }) }))).error, 'OpenRouter sent an empty model list');
});

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);
const rssOf = (...items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title>${items.join('')}</channel></rss>`;
const rssItem = ({ title, link, date = hoursAgo(1), description = '', extra = '' }) =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date.toUTCString()}</pubDate><description>${description}</description>${extra}</item>`;
const feedReply = (body, headers = {}) => new Response(body, { headers: { 'Content-Type': 'application/rss+xml', ...headers } });
const newsSource = (id, extra = {}) => ({ id, name: `Source ${id}`, category: 'news', url: `https://${id}.test/feed`, ...extra });

test('feeds are read from RSS 2.0, RSS 1.0 and Atom as plain text, with web links only', () => {
  const rss = parseFeed(`<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Feed</title>
<item><title>Fish &amp;amp; chips &#8217;26</title><link>/posts/fish?id=7&amp;utm_source=rss</link><pubDate>Wed, 30 Sep 2026 10:30:00 GMT</pubDate>
<description><![CDATA[<p>Hello <b>world</b> &amp; </item> friends</p><script>alert(1)</script>]]></description></item>
<!-- <item><title>Commented out</title></item> -->
<item><title>No link</title><pubDate>Wed, 30 Sep 2026 10:30:00 GMT</pubDate></item>
<item><title>Script link</title><link>javascript:alert(1)</link><pubDate>Wed, 30 Sep 2026 10:30:00 GMT</pubDate></item>
<item><title><![CDATA[Guid &amp; only]]></title><guid>https://feed.test/guid</guid><content:encoded>&lt;p&gt;Encoded &amp;lt;tag&amp;gt; text&lt;/p&gt;</content:encoded></item>
</channel></rss>`, 'https://feed.test/rss.xml');
  assert.deepEqual(rss.map((e) => [e.title, e.link, e.text]), [
    ['Fish & chips ’26', 'https://feed.test/posts/fish?id=7&utm_source=rss', 'Hello world & friends'],
    ['No link', null, ''],
    ['Script link', null, ''],
    ['Guid & only', 'https://feed.test/guid', 'Encoded <tag> text'],
  ]);
  assert.deepEqual([rss[0].date, rss[3].date], [Date.parse('2026-09-30T10:30:00Z'), null]);

  const rdf = parseFeed(`<?xml version="1.0" encoding="ISO-8859-1"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://slashdot.test/"><title>Slashdot</title><link>https://slashdot.test/</link></channel>
<item rdf:about="https://tech.slashdot.test/story/1"><title>Agents everywhere</title><link>https://tech.slashdot.test/story/1</link>
<description>Caf&#233; agents &lt;a href="https://x.test"&gt;read more&lt;/a&gt;</description><dc:date>2026-09-30T23:00:00+00:00</dc:date></item>
</rdf:RDF>`, 'https://slashdot.test/rss');
  assert.deepEqual(rdf, [{ title: 'Agents everywhere', link: 'https://tech.slashdot.test/story/1', text: 'Café agents read more', announce: null, date: Date.parse('2026-09-30T23:00:00Z') }]);

  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link rel="self" href="https://blog.test/feed"/>
<entry><title type="html">The &amp;lt;dialog&amp;gt; element</title>
<link rel="self" href="https://blog.test/self"/><link rel="alternate" type="text/html" href="https://blog.test/dialog?a=1&amp;b=2"/>
<published>2026-09-29T22:20:00Z</published><updated>2026-09-30T01:00:00Z</updated>
<summary type="html">&lt;p&gt;Escaped &amp;amp; clean&lt;/p&gt;</summary></entry>
<entry><title>The &lt;dialog&gt; element, as text</title><link href="posts/2"/><updated>2026-09-28T00:00:00Z</updated>
<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Inline <em>markup</em></p></div></content></entry>
</feed>`, 'https://blog.test/atom/feed.xml');
  assert.deepEqual(atom.map((e) => [e.title, e.link, e.text, e.date]), [
    ['The <dialog> element', 'https://blog.test/dialog?a=1&b=2', 'Escaped & clean', Date.parse('2026-09-29T22:20:00Z')],
    ['The <dialog> element, as text', 'https://blog.test/atom/posts/2', 'Inline markup', Date.parse('2026-09-28T00:00:00Z')],
  ]);

  assert.throws(() => parseFeed('<!doctype html><html><body>Sign in</body></html>', 'https://x.test/'), /did not send a feed/);
  assert.deepEqual(parseFeed('<rss version="2.0"><channel><title>Empty</title></channel></rss>', 'https://x.test/'), []);
});

test('filtered sources keep only the agentic and local-model terms the POC used', () => {
  for (const [title, text] of [
    ['Agents that use tools', ''], ['agentic workflow', ''], ['multi-agent systems', ''], ['', 'multi agent planning'], ['tool use for browsing', ''],
    ['tool-use demo', ''], ['an MCP server', ''], ['Ollama 0.5', ''], ['llama.cpp build', ''], ['ggml kernels', ''], ['GGUF file', ''],
    ['open-weight model', ''], ['open weight models', ''], ['a local model', ''], ['local-model runtime', ''], ['vLLM serving', ''],
    ['SGLang runtime', ''], ['quantization aware', ''], ['', 'quantized to 4-bit'],
  ]) assert.ok(matchesTerms(title, text), `${title}${text}`);
  for (const title of ['mcperson weekly', 'the weather today', 'travel agency', 'quantitative easing']) assert.ok(!matchesTerms(title, 'clear skies'), title);
});

test('copies of one story share a canonical URL, and links lose their tracking parameters', () => {
  assert.equal(canonicalUrl('http://WWW.Example.com/a/b/?utm_source=x&id=1#frag'), canonicalUrl('https://example.com/a/b?id=1'));
  assert.equal(canonicalUrl('https://arxiv.org/pdf/2401.01234v2'), canonicalUrl('http://www.arxiv.org/abs/2401.01234'));
  assert.notEqual(canonicalUrl('https://example.com/a?id=1'), canonicalUrl('https://example.com/a?id=2'));
  assert.equal(cleanUrl('https://tech.slashdot.test/story/1?utm_source=rss1.0&utm_medium=feed'), 'https://tech.slashdot.test/story/1');
  assert.equal(cleanUrl('https://x.test/p?fbclid=z&id=2'), 'https://x.test/p?id=2');
  assert.equal(cleanUrl('https://x.test/p?q=a%20b&id=2'), 'https://x.test/p?q=a%20b&id=2', 'a link without trackers is left exactly as sent');
});

test('Hacker News stories and the latest GitHub release are read from their JSON APIs', () => {
  const stories = parseHackerNews(JSON.stringify({ hits: [
    { objectID: '49906637', title: 'You said no MCP', url: 'https://earendil.test/posts/no-mcp/', points: 649, num_comments: 356, created_at: '2026-09-30T09:55:00Z' },
    { objectID: '49911995', title: 'Ask HN: Agents &amp; you', url: null, points: 1, num_comments: 0, created_at: '2026-09-30T08:00:00Z' },
    { objectID: '1', title: 'Bad link', url: 'javascript:alert(1)', points: 'many', created_at: 'soon' },
    null,
  ] }));
  assert.deepEqual(stories, [
    { title: 'You said no MCP', link: 'https://earendil.test/posts/no-mcp/', text: '649 points · 356 comments', discussion: 'https://news.ycombinator.com/item?id=49906637', date: Date.parse('2026-09-30T09:55:00Z') },
    { title: 'Ask HN: Agents & you', link: 'https://news.ycombinator.com/item?id=49911995', text: '1 point · 0 comments', discussion: null, date: Date.parse('2026-09-30T08:00:00Z') },
    { title: 'Bad link', link: 'https://news.ycombinator.com/item?id=1', text: '', discussion: null, date: NaN },
  ]);
  assert.throws(() => parseHackerNews('{}'), /sent no stories/);

  const release = (fields) => JSON.stringify({
    tag_name: 'rust-v0.159.3', name: '0.159.3', html_url: 'https://github.com/openai/codex/releases/tag/rust-v0.159.3', published_at: '2026-09-30T22:57:34Z',
    draft: false, prerelease: false,
    body: '## New Features\n- Optional reminders to finish account security setup. (#49744)\n\n## Changelog\n**Full Changelog**: https://github.com/openai/codex/compare/rust-v0.159.2...rust-v0.159.3\n* #49744 [0.159] Backport the reminder by @someone in https://github.com/openai/codex/pull/49744',
    ...fields,
  });
  assert.deepEqual(parseGithubRelease(release(), 'Codex CLI'), [{
    title: 'Codex CLI 0.159.3', link: 'https://github.com/openai/codex/releases/tag/rust-v0.159.3',
    text: 'Optional reminders to finish account security setup. · [0.159] Backport the reminder', date: Date.parse('2026-09-30T22:57:34Z'),
  }]);
  assert.equal(parseGithubRelease(release({ name: '1.2.15', tag_name: '1.2.15' }), 'Antigravity CLI')[0].title, 'Antigravity CLI 1.2.15');
  assert.equal(parseGithubRelease(release({ name: '' }), 'Codex CLI')[0].title, 'Codex CLI v0.159.3');
  assert.deepEqual(parseGithubRelease(release({ prerelease: true }), 'Codex CLI'), []);
  assert.throws(() => parseGithubRelease('{"message":"Not Found"}', 'Codex CLI'), /sent no release/);

  assert.deepEqual([
    releaseTitle('Transformers', 'Release 5.18.0'), releaseTitle('Transformers', 'Patch release: v5.15.1'), releaseTitle('llama.cpp', 'b11320'),
    releaseTitle('Ollama', 'v0.35.0'), releaseTitle('Ollama', 'Ollama v0.35.0'), releaseTitle('Claude Code', 'v2.1.286'),
  ], ['Transformers 5.18.0', 'Transformers v5.15.1', 'llama.cpp b11320', 'Ollama v0.35.0', 'Ollama v0.35.0', 'Claude Code v2.1.286']);
  for (const tag of ['v0.35.1-rc0', 'rust-v0.161.0-alpha.12', 'v0.64.0-nightly.20261001.gc6bccb7ec', 'v0.63.0-preview.0', 'v1.0.0-beta.2']) assert.ok(isPrerelease(tag), tag);
  for (const tag of ['v0.35.0', 'b11320', 'v2.1.286', 'rust-v0.159.3', 'v5.18.0']) assert.ok(!isPrerelease(tag), tag);
  assert.equal(markdownText('[Docs](https://x.test) and ![img](a.png) `code`\n```\nblock\n```\n> quoted'), 'Docs and code · quoted');
});

test('news is fetched only when a page asks, once per source while a refresh runs, and revalidated with its validators', async () => {
  const seen = [];
  let reply = () => feedReply(rssOf(rssItem({ title: 'One', link: 'https://a.test/1' })), { ETag: '"v1"', 'Last-Modified': 'Wed, 30 Sep 2026 10:00:00 GMT' });
  const news = new NewsFeed({ feeds: [newsSource('a')], fetchImpl: async (url, init) => { seen.push({ url, init }); return reply(); } });
  assert.equal(seen.length, 0, 'nothing is fetched before a page asks');
  const first = news.snapshot();
  assert.deepEqual([first.refreshing, first.refreshedAt, first.items], [true, null, []]);
  assert.deepEqual(first.sources, [{ id: 'a', name: 'Source a', category: 'news', error: null, okAt: null }]);
  news.snapshot();
  await once(news, 'updated');
  assert.equal(seen.length, 1, 'asking again during a refresh starts no second request');
  assert.equal(seen[0].url, 'https://a.test/feed');
  assert.match(seen[0].init.headers['User-Agent'], /^agent-guild\/\S+ \(\+https:\/\/github\.com\/oddessentials\/agent-guild\)$/);
  assert.equal(seen[0].init.headers['If-None-Match'], undefined);
  const second = news.snapshot();
  assert.equal(second.refreshing, false);
  assert.ok(Date.parse(second.refreshedAt) <= Date.now() && second.sources[0].okAt);
  assert.deepEqual(second.items.map((i) => [i.title, i.url, i.source, i.sourceId, i.category]), [['One', 'https://a.test/1', 'Source a', 'a', 'news']]);
  assert.match(second.items[0].id, /^[0-9a-f]{16}$/);
  assert.equal(seen.length, 1, 'a source checked in the last 30 minutes is not asked again');

  news.ttlMs = 0;
  reply = () => new Response(null, { status: 304 });
  news.snapshot();
  news.ttlMs = 3600000;
  await once(news, 'updated');
  assert.deepEqual([seen[1].init.headers['If-None-Match'], seen[1].init.headers['If-Modified-Since']], ['"v1"', 'Wed, 30 Sep 2026 10:00:00 GMT']);
  assert.deepEqual(news.snapshot().items.map((i) => i.title), ['One'], 'an unchanged source keeps its items');
  assert.equal(seen.length, 2);
});

test('future-dated news keeps its normalized time across refreshes unless the source date changes', async (t) => {
  const started = Date.parse('2026-10-01T12:00:00Z');
  let now = started;
  t.mock.method(Date, 'now', () => now);
  let date = new Date(started + 3600000);
  let description = 'Original summary';
  const news = new NewsFeed({
    feeds: [newsSource('future')],
    fetchImpl: async () => feedReply(rssOf(rssItem({ title: 'Soon', link: 'https://future.test/soon', date, description }))),
  });
  const refresh = async () => {
    news.ttlMs = 0;
    news.snapshot();
    news.ttlMs = 3600000;
    await once(news, 'updated');
    const snapshot = news.snapshot();
    assert.equal(snapshot.sources[0].error, null);
    assert.equal(snapshot.items.length, 1);
    return snapshot.items[0];
  };
  const first = await refresh();
  assert.equal(first.publishedAt, new Date(started).toISOString(), 'a future date is initially clamped to now');
  const seen = Date.parse(first.publishedAt);

  now += 30 * 60000;
  const unchanged = await refresh();
  assert.deepEqual(unchanged, first, 'an unchanged HTTP 200 response keeps the same public item');
  assert.equal(Date.parse(unchanged.publishedAt) > seen, false, 'the page does not mark the read item new again');

  now += 60 * 60000;
  description = 'Updated summary';
  const updated = await refresh();
  assert.equal(updated.publishedAt, first.publishedAt, 'the normalized time stays stable after the source date passes');
  assert.equal(updated.summary, description, 'other fields still refresh');

  date = new Date(now + 3600000);
  const redated = await refresh();
  assert.equal(redated.id, first.id);
  assert.equal(redated.publishedAt, new Date(now).toISOString(), 'a changed future date gets a new normalized time');
  now += 30 * 60000;
  assert.equal((await refresh()).publishedAt, redated.publishedAt, 'the changed date is then stable too');

  date = new Date(now - 60000);
  assert.equal((await refresh()).publishedAt, date.toISOString(), 'a corrected past date is used as stated');
});

test('a failed source keeps what it sent before, says why, and is asked again on its own retry interval', async () => {
  let reply = () => feedReply(rssOf(rssItem({ title: 'Kept', link: 'https://b.test/kept' })));
  let asked = 0;
  const news = new NewsFeed({ feeds: [newsSource('b')], fetchImpl: async () => { asked++; return reply(); }, ttlMs: 3600000, retryMs: 3600000 });
  const refresh = async () => {
    news.ttlMs = news.retryMs = 0;
    news.snapshot();
    news.ttlMs = news.retryMs = 3600000;
    await once(news, 'updated');
    return news.snapshot();
  };
  await refresh();
  reply = () => new Response('Bad gateway', { status: 502 });
  const failed = await refresh();
  assert.deepEqual([failed.sources[0].error, failed.items.map((i) => i.title)], ['HTTP 502', ['Kept']]);
  assert.ok(failed.sources[0].okAt, 'the last good read is still reported');
  news.snapshot();
  assert.equal(asked, 2, 'a failed source waits for its retry interval');
  news.retryMs = 0;
  news.snapshot();
  news.retryMs = 3600000;
  await once(news, 'updated');
  assert.equal(asked, 3, 'and is asked again once it has passed');

  const error = async (next) => {
    reply = next;
    return (await refresh()).sources[0].error;
  };
  assert.equal(await error(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }), 'could not be reached (ENOTFOUND)');
  assert.equal(await error(() => { throw new DOMException('timed out', 'TimeoutError'); }), 'did not answer within 20 seconds');
  assert.equal(await error(() => feedReply('<!doctype html><html><body>Sign in</body></html>', { 'Content-Type': 'text/html' })), 'did not send a feed');
  assert.deepEqual(news.snapshot().items.map((i) => i.title), ['Kept']);
});

test('the feed keeps 30 days, a limit per source and one copy of each story, credited to the earlier source, newest first', async () => {
  const primary = Array.from({ length: 24 }, (_, i) => rssItem({ title: `Primary ${i + 1}`, link: `https://primary.test/${i + 1}`, date: hoursAgo(i + 1) }));
  const replies = {
    'https://primary.test/feed': rssOf(...primary,
      rssItem({ title: 'Too old', link: 'https://primary.test/old', date: hoursAgo(31 * 24) }),
      rssItem({ title: 'Far future', link: 'https://primary.test/future', date: hoursAgo(-72) }),
      rssItem({ title: 'Soon', link: 'https://primary.test/soon', date: hoursAgo(-1) }),
      '<item><title>Undated</title><link>https://primary.test/undated</link></item>'),
    'https://arxiv.test/feed': rssOf(
      rssItem({ title: 'Agents that plan', link: 'https://arxiv.org/abs/2609.00001', date: hoursAgo(3), description: 'arXiv:2609.00001v1 Announce Type: new Abstract: We study agents.', extra: '<arxiv:announce_type>new</arxiv:announce_type>' }),
      rssItem({ title: 'Agents, revised', link: 'https://arxiv.org/abs/2601.00002', date: hoursAgo(3), extra: '<arxiv:announce_type>replace</arxiv:announce_type>' }),
      rssItem({ title: 'Weather models', link: 'https://arxiv.org/abs/2609.00003', date: hoursAgo(3), extra: '<arxiv:announce_type>cross</arxiv:announce_type>' })),
    'https://digest.test/feed': rssOf(
      rssItem({ title: 'Primary 1, again', link: 'http://www.primary.test/1/?utm_source=digest', date: hoursAgo(0.5) }),
      rssItem({ title: 'Digest only', link: 'https://digest.test/only', date: hoursAgo(2.5), description: 'Digest only The Publisher' })),
  };
  const news = new NewsFeed({
    feeds: [newsSource('primary'), newsSource('arxiv', { category: 'research', filter: true }), newsSource('digest')],
    fetchImpl: async (url) => feedReply(replies[url]),
  });
  news.snapshot();
  await once(news, 'updated');
  const { items } = news.snapshot();
  const from = (id) => items.filter((i) => i.sourceId === id).map((i) => i.title);
  assert.deepEqual(from('primary'), ['Soon', ...Array.from({ length: 19 }, (_, i) => `Primary ${i + 1}`)]);
  assert.deepEqual(from('arxiv'), ['Agents that plan']);
  assert.equal(items.find((i) => i.sourceId === 'arxiv').summary, 'We study agents.');
  assert.deepEqual(from('digest'), ['Digest only']);
  assert.equal(items.find((i) => i.title === 'Digest only').summary, 'The Publisher');
  assert.ok(Date.parse(items[0].publishedAt) <= Date.now(), 'a date slightly ahead is shown as now');
  const times = items.map((i) => Date.parse(i.publishedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('release notes come only for installed tools, and pre-releases are skipped in every source', async () => {
  const seen = [];
  const latest = JSON.stringify({
    tag_name: 'v2.1.286', name: 'v2.1.286', html_url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.286', published_at: hoursAgo(2).toISOString(),
    draft: false, prerelease: false, body: '- Added a count to stacked permission prompts',
  });
  const atomEntry = (title, tag, hours) => `<entry><title>${title}</title><link rel="alternate" type="text/html" href="https://github.com/ollama/ollama/releases/tag/${tag}"/><updated>${hoursAgo(hours).toISOString()}</updated><content type="html">&lt;p&gt;Notes for ${tag}&lt;/p&gt;</content></entry>`;
  const replies = {
    'https://api.github.com/repos/anthropics/claude-code/releases/latest': () => new Response(latest, { headers: { 'Content-Type': 'application/json' } }),
    'https://ollama.test/releases.atom': () => feedReply(`<feed xmlns="http://www.w3.org/2005/Atom">${atomEntry('v0.35.1', 'v0.35.1-rc0', 1)}${atomEntry('v0.35.0', 'v0.35.0', 3)}</feed>`),
    'https://digest.test/feed': () => feedReply(rssOf(rssItem({ title: 'codex 0.161.0-alpha.11', link: 'https://github.com/openai/codex/releases/tag/rust-v0.161.0-alpha.11' }))),
  };
  let installed = false;
  const news = new NewsFeed({
    registry: { providers: [{ id: 'anthropic', command: 'claude' }], resolve: () => (installed ? '/usr/local/bin/claude' : null) },
    feeds: [
      { id: 'claude-code', name: 'Claude Code', category: 'releases', provider: 'anthropic', format: 'github', url: 'https://api.github.com/repos/anthropics/claude-code/releases/latest' },
      { id: 'ollama', name: 'Ollama', category: 'releases', url: 'https://ollama.test/releases.atom' },
      newsSource('digest'),
    ],
    fetchImpl: async (url, init) => { seen.push({ url, init }); return replies[url](); },
  });
  const refresh = async () => {
    news.ttlMs = news.retryMs = 0;
    news.snapshot();
    news.ttlMs = news.retryMs = 3600000;
    await once(news, 'updated');
    return news.snapshot();
  };
  let snap = await refresh();
  assert.deepEqual(snap.sources.map((s) => s.id), ['ollama', 'digest'], 'a tool that is not installed has no release source');
  assert.ok(!seen.some((s) => s.url.startsWith('https://api.github.com/')));
  assert.deepEqual(snap.items.map((i) => [i.title, i.summary]), [['Ollama v0.35.0', 'Notes for v0.35.0']]);

  installed = true;
  snap = await refresh();
  assert.deepEqual(snap.sources.map((s) => s.id), ['claude-code', 'ollama', 'digest']);
  const github = seen.find((s) => s.url.startsWith('https://api.github.com/'));
  assert.deepEqual([github.init.headers.Accept, github.init.headers['X-GitHub-Api-Version']], ['application/vnd.github+json', '2022-11-28']);
  assert.deepEqual(snap.items.map((i) => [i.title, i.category, i.summary]), [
    ['Claude Code v2.1.286', 'releases', 'Added a count to stacked permission prompts'],
    ['Ollama v0.35.0', 'releases', 'Notes for v0.35.0'],
  ]);

  replies['https://api.github.com/repos/anthropics/claude-code/releases/latest'] = () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
  snap = await refresh();
  assert.equal(snap.sources[0].error, 'GitHub API rate limit exceeded');
  assert.equal(snap.items[0].title, 'Claude Code v2.1.286', 'the last release stays listed');
});

test('a response over the size limit is refused, and a declared character set is honoured', async () => {
  const latin = Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><item><title>Café agents</title><link>https://latin.test/1</link><pubDate>${hoursAgo(1).toUTCString()}</pubDate></item></channel></rss>`, 'latin1');
  const replies = {
    'https://big.test/feed': () => new Response('<rss/>', { headers: { 'Content-Length': String(6 * 1024 * 1024) } }),
    'https://stream.test/feed': () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } })),
    'https://latin.test/feed': () => feedReply(latin),
  };
  const news = new NewsFeed({ feeds: [newsSource('big'), newsSource('stream'), newsSource('latin')], fetchImpl: async (url) => replies[url]() });
  news.snapshot();
  await once(news, 'updated');
  const snap = news.snapshot();
  assert.deepEqual(snap.sources.map((s) => s.error), ['sent more than 5 MB', 'sent more than 5 MB', null]);
  assert.deepEqual(snap.items.map((i) => i.title), ['Café agents']);
});

const issue = (n) => `https://github.com/oddessentials/agent-guild/issues/${n}`;
const releaseNotes = (version, ...lines) => [
  `## [${version}](https://github.com/oddessentials/agent-guild/compare/v0.4.0...v${version}) (2026-10-01)`,
  '',
  ...lines,
  '',
  '### Install or update',
  '',
  'If Agent Guild is running, stop it first with `agent-guild stop`. That ends its sessions; a manager left running keeps the old version.',
  '',
  '```sh',
  `npm install -g @oddessentials/agent-guild@${version}`,
  'agent-guild',
  '```',
  '',
].join('\n');

test('release notes become sections of changes, without commit links or the install steps', () => {
  const notes = releaseNotes('0.5.0',
    '### ⚠ BREAKING CHANGES',
    '',
    '* **api:** the events socket needs the token',
    '',
    '### Features',
    '',
    `* list each tool's earlier sessions to resume, and restart the manager from the page ([#41](${issue(41)})) ([924e520](https://github.com/oddessentials/agent-guild/commit/924e5209b1ab457d94331f1c55a7162c1bfce31a))`,
    `* add \`--resume\` support, closes [#7](${issue(7)}) [#8](${issue(8)})`,
    '',
    '### Bug Fixes',
    '',
    `* **release:** enforce title-based release rules ([#32](${issue(32)})) ([2e2d667](https://github.com/oddessentials/agent-guild/commit/2e2d667))`);
  assert.deepEqual(parseNotes(notes), [
    { title: '⚠ BREAKING CHANGES', changes: [[{ text: 'api:', strong: true }, { text: ' the events socket needs the token' }]] },
    {
      title: 'Features',
      changes: [
        [{ text: 'list each tool\'s earlier sessions to resume, and restart the manager from the page (' }, { text: '#41', url: issue(41) }, { text: ')' }],
        [{ text: 'add ' }, { text: '--resume', code: true }, { text: ' support, closes ' }, { text: '#7', url: issue(7) }, { text: ' ' }, { text: '#8', url: issue(8) }],
      ],
    },
    { title: 'Bug Fixes', changes: [[{ text: 'release:', strong: true }, { text: ' enforce title-based release rules (' }, { text: '#32', url: issue(32) }, { text: ')' }]] },
  ]);
  assert.deepEqual(parseNotes(releaseNotes('0.6.0')), [], 'a release with only the install steps lists no changes');
});

test('release notes keep bold, code and web links, and leave out images, markup and other links', () => {
  const notes = [
    'Intro with <https://example.com/a?b=1> and a [bad link](javascript:alert).',
    '',
    '## Highlights',
    '',
    '- A <b>bold</b> &amp; ![logo](https://example.com/logo.png) claim that a < b',
    '  continues on the next line',
    '+ plus item',
    '1. numbered `a &amp; b` item',
    '',
    '> quoted line',
    '---',
    '<!-- hidden',
    'comment -->',
    '#### Notes',
    '```js',
    'console.log("left out")',
    '```',
    '* **bold [inside](https://example.com/in) link**',
    '## 1.2.3 (2026-10-01)',
    '* after a version heading',
  ].join('\n');
  assert.deepEqual(parseNotes(notes), [
    { title: null, changes: [[{ text: 'Intro with ' }, { text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' }, { text: ' and a bad link.' }]] },
    {
      title: 'Highlights',
      changes: [
        [{ text: 'A bold & claim that a < b continues on the next line' }],
        [{ text: 'plus item' }],
        [{ text: 'numbered ' }, { text: 'a &amp; b', code: true }, { text: ' item' }],
        [{ text: 'quoted line' }],
      ],
    },
    { title: 'Notes', changes: [[{ text: 'bold ', strong: true }, { text: 'inside', url: 'https://example.com/in', strong: true }, { text: ' link', strong: true }]] },
    { title: null, changes: [[{ text: 'after a version heading' }]] },
  ]);
});

test('release notes are read up to a limit of changes, characters and line length', () => {
  const many = Array.from({ length: 120 }, (_, i) => `* change ${i + 1}`).join('\n');
  assert.deepEqual(parseNotes(`### Features\n${many}\n### Bug Fixes\n* one more`).map((s) => [s.title, s.changes.length]), [['Features', 100]]);
  assert.equal(parseNotes(`* ${'['.repeat(200000)}`)[0].changes[0][0].text.length, 998);
  assert.equal(parseNotes(Array.from({ length: 50 }, () => `* ${'x'.repeat(999)}`).join('\n'))[0].changes.length, 20);
});

test('releases are listed newest version first, without drafts, pre-releases or other tags', () => {
  const release = (tag, extra = {}) => ({
    tag_name: tag, html_url: `https://github.com/oddessentials/agent-guild/releases/tag/${tag}`, published_at: '2026-10-01T15:42:18Z',
    draft: false, prerelease: false, body: '### Features\n\n* a change', ...extra,
  });
  assert.deepEqual(parseReleases(JSON.stringify([
    release('v0.9.0'),
    release('v0.10.0', { html_url: 'javascript:alert(1)', published_at: 'soon', body: null }),
    release('v0.11.0', { draft: true }),
    release('v0.12.0', { prerelease: true }),
    release('v0.13.0-rc.1'),
    release('nightly'),
    release('v0.9.0', { body: '### Features\n\n* a second copy' }),
    null,
    'v1.0.0',
  ])), [
    { version: '0.10.0', url: 'https://github.com/oddessentials/agent-guild/releases/tag/v0.10.0', publishedAt: null, sections: [] },
    {
      version: '0.9.0', url: 'https://github.com/oddessentials/agent-guild/releases/tag/v0.9.0', publishedAt: '2026-10-01T15:42:18.000Z',
      sections: [{ title: 'Features', changes: [[{ text: 'a change' }]] }],
    },
  ]);
  assert.throws(() => parseReleases('{"message":"Not Found"}'), /sent no releases/);
});

const releasesReply = (tags, headers = {}) => new Response(JSON.stringify(tags.map((tag) => ({
  tag_name: tag, html_url: `https://github.com/oddessentials/agent-guild/releases/tag/${tag}`, published_at: '2026-10-01T15:42:18Z', body: `### Features\n\n* ${tag}`,
}))), { headers: { 'Content-Type': 'application/json', ...headers } });

test('the changelog is fetched only when a page asks, revalidated with its ETag, and kept when a check fails', async () => {
  const seen = [];
  let reply = () => releasesReply(['v0.5.0'], { ETag: 'W/"one"' });
  const changelog = new Changelog({ fetchImpl: async (url, init) => { seen.push({ url, init }); return reply(); } });
  assert.equal(seen.length, 0, 'nothing is fetched before a page asks');
  assert.deepEqual(changelog.snapshot(), { refreshing: true, okAt: null, error: null, releases: [] });
  changelog.snapshot();
  await once(changelog, 'updated');
  assert.equal(seen.length, 1, 'asking again during a check starts no second request');
  assert.equal(seen[0].url, 'https://api.github.com/repos/oddessentials/agent-guild/releases?per_page=30');
  const { headers } = seen[0].init;
  assert.deepEqual([headers.Accept, headers['X-GitHub-Api-Version'], headers['If-None-Match']], ['application/vnd.github+json', '2022-11-28', undefined]);
  assert.match(headers['User-Agent'], /^agent-guild\/\S+ \(\+https:\/\/github\.com\/oddessentials\/agent-guild\)$/);
  const fetched = changelog.snapshot();
  assert.deepEqual([fetched.refreshing, fetched.error, fetched.releases.map((r) => r.version)], [false, null, ['0.5.0']]);
  assert.ok(Date.parse(fetched.okAt) <= Date.now());
  assert.equal(seen.length, 1, 'the list is checked at most hourly');

  const check = async () => {
    changelog.ttlMs = changelog.retryMs = 0;
    changelog.snapshot();
    changelog.ttlMs = changelog.retryMs = 3600000;
    await once(changelog, 'updated');
    return changelog.snapshot();
  };
  reply = () => new Response(null, { status: 304 });
  assert.deepEqual((await check()).releases.map((r) => r.version), ['0.5.0'], 'an unchanged list is kept');
  assert.equal(seen[1].init.headers['If-None-Match'], 'W/"one"');

  reply = () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
  const limited = await check();
  assert.deepEqual([limited.error, limited.releases.map((r) => r.version)], ['GitHub API rate limit exceeded', ['0.5.0']]);
  assert.ok(limited.okAt, 'the last good check is still reported');
  changelog.snapshot();
  assert.equal(seen.length, 3, 'a failed check waits for its retry interval');

  reply = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.equal((await check()).error, 'could not be reached (ENOTFOUND)');
  reply = () => releasesReply(['v0.5.0', 'v0.6.0']);
  const recovered = await check();
  assert.deepEqual([recovered.error, recovered.releases.map((r) => r.version)], [null, ['0.6.0', '0.5.0']]);
});

test('the changelog is checked again soon while npm names a release it does not list yet', async () => {
  let latest = '0.5.0';
  let tags = ['v0.5.0'];
  let asked = 0;
  const changelog = new Changelog({ latest: () => latest, fetchImpl: async () => { asked++; return releasesReply(tags); }, missingMs: 3600000 });
  changelog.snapshot();
  await once(changelog, 'updated');
  changelog.missingMs = 0;
  changelog.snapshot();
  assert.equal(asked, 1, 'a listed release waits for the hourly check');
  latest = '0.6.0';
  changelog.snapshot();
  await once(changelog, 'updated');
  assert.equal(asked, 2, 'a release npm names but the list lacks is looked for again');
  tags = ['v0.6.0', 'v0.5.0'];
  changelog.snapshot();
  await once(changelog, 'updated');
  assert.deepEqual(changelog.snapshot().releases.map((r) => r.version), ['0.6.0', '0.5.0']);
  assert.equal(asked, 3, 'once it is listed, the hourly check applies again');
});

test('the launcher path names the double-click file for the platform only when the package carries it', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, '..');
  assert.equal(ROOT_DIR, repo, 'the manager runs from the package root');
  assert.equal(MANAGER_ENTRY, path.join(repo, 'src', 'manager', 'main.mjs'));
  // The repository checkout has both launchers; the npm package has neither.
  assert.equal(launcherPath('win32', repo), path.join(repo, 'launchers', 'AgentGuild.cmd'));
  assert.equal(launcherPath('darwin', repo), path.join(repo, 'launchers', 'AgentGuild.command'));
  assert.equal(launcherPath('linux', repo), null, 'Linux has no double-click launcher');
  const bare = tempDir();
  assert.equal(launcherPath('win32', bare), null);
  assert.equal(launcherPath('darwin', bare), null);
  fs.rmSync(bare, { recursive: true, force: true });
});

test('every reporting bundle runs the reporter, Antigravity\'s through a script in its plugin folder', async () => {
  const unix = bundleFiles('1.2.3', { platform: 'linux' });
  const commands = (files) => [...JSON.stringify(JSON.parse(files['hooks/hooks.json'])).matchAll(/"command":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const claude = JSON.parse(unix.claude['hooks/hooks.json']).hooks;
  assert.deepEqual(Object.keys(claude), ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PostModelSwitch', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
  assert.equal(claude.PreToolUse[0].matcher, 'Bash|PowerShell', 'only shell commands pay for the tool hooks');
  assert.equal(claude.PermissionRequest[0].matcher, 'Bash|PowerShell');
  assert.equal(claude.PostToolUse[0].matcher, 'Bash|PowerShell|TaskStop', 'TaskStop ends a background command');
  assert.equal(claude.PostToolUseFailure[0].matcher, 'Bash|PowerShell', 'a TaskStop that failed stopped nothing');
  assert.deepEqual(Object.keys(claude).filter((event) => claude[event][0].hooks[0].async !== true), ['SubagentStart', 'PreToolUse'], 'only a start holds Claude Code up, so it reaches the manager before its end');
  assert.equal(claude.SessionStart[0].matcher, undefined);
  assert.equal(JSON.parse(unix.grok['hooks/hooks.json']).hooks.PreToolUse[0].matcher, 'run_terminal_command');
  assert.ok(commands(unix.claude).every((c) => c === REPORT_COMMAND));
  assert.ok(commands(unix.grok).every((c) => c === REPORT_COMMAND));
  assert.equal(JSON.parse(unix.claude['.claude-plugin/plugin.json']).name, 'agent-guild');
  assert.equal(JSON.parse(unix.grok['.grok-plugin/plugin.json']).name, 'agent-guild');
  for (const platform of ['win32', 'linux']) {
    const files = bundleFiles('1.2.3', { platform }).antigravity;
    const script = platform === 'win32' ? 'agent-guild-hook.cmd' : 'agent-guild-hook.sh';
    assert.deepEqual(Object.keys(files).sort(), ['hooks.json', 'plugin.json', script].sort());
    const manifest = JSON.parse(files['plugin.json']);
    assert.equal(manifest.name, 'agent-guild');
    assert.ok(!('version' in manifest), 'an upgrade of Agent Guild leaves the installed copy current');
    assert.deepEqual(bundleFiles('2.0.0', { platform }).antigravity, files);
    const hooks = JSON.parse(files['hooks.json']);
    assert.deepEqual(Object.keys(hooks), ['agent-guild']);
    assert.deepEqual(Object.keys(hooks['agent-guild']), ['PreInvocation'], 'no PreToolUse or Stop, so no hook ever answers a permission or stop decision');
    const [{ type, command, timeout }] = hooks['agent-guild'].PreInvocation;
    assert.deepEqual([type, timeout], ['command', 10]);
    assert.equal(command, platform === 'win32' ? '.\\agent-guild-hook.cmd PreInvocation' : 'sh agent-guild-hook.sh PreInvocation');
    assert.ok(!/["'/:]/.test(command), 'cmd /C gets a quoted path wrong, so the command names no path');
    const text = files[script];
    assert.ok(text.includes(`${REPORT_COMMAND} --event`));
    assert.ok(text.includes('AGENT_GUILD_REPORTING'), 'it reports only inside an Agent Guild Antigravity session');
    assert.equal((text.match(/\{\}/g) || []).length, 1);
    if (platform === 'win32') assert.ok(text.split('\n').slice(0, -1).every((line) => line.endsWith('\r')), 'a batch file has CRLF lines');
  }
  if (process.platform !== 'win32') {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'agent-guild-hook.sh'), unix.antigravity['agent-guild-hook.sh']);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AGENT_GUILD_')) delete env[key];
    const out = execFileSync('/bin/sh', ['-c', JSON.parse(unix.antigravity['hooks.json'])['agent-guild'].PreInvocation[0].command], { cwd: dir, env, input: '{"conversationId":"c"}', encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), {});
  }
});

test('Codex hook overrides avoid double quotes, and trust only the handlers Codex lists as ours', () => {
  const args = codexHookArgs();
  assert.deepEqual(args.filter((a, i) => i % 2 === 0), Array(10).fill('-c'));
  assert.deepEqual(args.filter((a, i) => i % 2 === 1).map((a) => a.split('=')[0]), ['hooks.SessionStart', 'hooks.UserPromptSubmit', 'hooks.SubagentStart', 'hooks.SubagentStop', 'hooks.PreToolUse', 'hooks.PermissionRequest', 'hooks.PostToolUse', 'hooks.Stop', 'hooks.Interrupt', 'hooks.SessionEnd']);
  assert.match(args[9], /^hooks\.PreToolUse=\[\{hooks=/, 'every tool call: a multi_agent_v2 follow-up starts with any tool');
  assert.match(args[11], /^hooks\.PermissionRequest=\[\{matcher='Bash',/);
  assert.match(args[13], /^hooks\.PostToolUse=\[\{matcher='Bash',/);
  assert.ok(args.every((a) => !a.includes('"')), 'nothing for cmd.exe or argv parsing to escape');
  for (const a of args.filter((x, i) => i % 2 === 1)) assert.equal(buildSpawnSpec('C:\\npm\\codex.cmd', [a], {}, 'win32').args.includes(`"${a}"`), true);

  const hook = (eventName, extra = {}) => ({
    key: `/<session-flags>/config.toml:${eventName}:0:0`, eventName, command: REPORT_COMMAND, source: 'sessionFlags', enabled: true,
    currentHash: `sha256:${eventName}`, trustStatus: 'untrusted', ...extra,
  });
  const all = [hook('sessionStart'), hook('userPromptSubmit'), hook('subagentStart'), hook('subagentStop'), hook('preToolUse'), hook('permissionRequest'), hook('postToolUse'), hook('stop'), hook('interrupt'), hook('sessionEnd')];
  const listed = codexHooksFrom({ data: [{ hooks: [...all, hook('subagentStart', { source: 'user', key: 'user-key', command: 'mine' })] }] });
  assert.deepEqual(listed.map((h) => h.key), all.map((h) => h.key), 'the user\'s own hooks are never trusted by us');
  assert.equal(codexHooksFrom({ data: [{ hooks: all.slice(1) }] }), null, 'a missing handler means Codex did not load ours');
  assert.equal(codexHooksFrom({ data: [{ hooks: [...all.slice(1), hook('sessionStart', { enabled: false })] }] }), null);
  const [, state] = codexTrustArgs(listed);
  assert.equal(state, `hooks.state={${all.map((h) => `'${h.key}'={trusted_hash='${h.currentHash}'}`).join(',')}}`);
  assert.equal(codexTrustArgs([{ key: "it's", hash: 'h' }]), null, 'a key that cannot be quoted is not trusted');
});

test('the plugin flag counts only when the command itself lists it', () => {
  assert.ok(helpLists('Options:\n  --plugin-dir <path>   Load a plugin\n', '--plugin-dir'));
  assert.ok(!helpLists('Commands:\n  agent   Run with --plugin-dir support\n', '--plugin-dir'));
  assert.ok(!helpLists("error: unexpected argument '--plugin-dir' found", '--plugin-dir'));
});

test('Antigravity reporting counts as on only with the current copy of our own plugin, turned on', () => {
  const dir = tempDir();
  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(bundle);
  for (const [name, text] of Object.entries(bundleFiles('1.0.0', { platform: 'linux' }).antigravity)) fs.writeFileSync(path.join(bundle, name), text);
  const installed = path.join(dir, 'installed');
  assert.equal(antigravityInstalled(installed, bundle), null);
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'plugin.json'), JSON.stringify({ name: 'agent-guild', description: 'Not ours' }));
  assert.equal(antigravityInstalled(installed, bundle), 'other');
  fs.cpSync(bundle, installed, { recursive: true });
  assert.equal(antigravityInstalled(installed, bundle), 'current');
  fs.writeFileSync(path.join(installed, 'hooks.json'), '{}');
  assert.equal(antigravityInstalled(installed, bundle), 'stale');
  fs.rmSync(path.join(installed, 'hooks.json'));
  assert.equal(antigravityInstalled(installed, bundle), 'stale', 'a missing file is not current');
  assert.equal(antigravityInstalled(installed, path.join(dir, 'gone')), 'stale', 'nor is anything once the bundle is gone');

  const config = path.join(dir, 'config.json');
  assert.equal(antigravityPluginEnabled(config), true, 'without settings every plugin is on');
  const settings = (value) => fs.writeFileSync(config, typeof value === 'string' ? value : JSON.stringify(value));
  settings({ userSettings: {} });
  assert.equal(antigravityPluginEnabled(config), true);
  settings({ plugins: { 'agent-guild': { enabled: true }, other: { enabled: false } } });
  assert.equal(antigravityPluginEnabled(config), true, 'another plugin turned off is not ours');
  settings({ plugins: { 'agent-guild': { enabled: false } } });
  assert.equal(antigravityPluginEnabled(config), false, 'agy plugin disable');
  settings('{"plugins": {');
  assert.equal(antigravityPluginEnabled(config), false, 'settings that cannot be read say nothing for sure');
  settings('null');
  assert.equal(antigravityPluginEnabled(config), false);
  assert.equal(antigravityPluginEnabled(dir), false, 'nor can a folder in its place');

  assert.equal(antigravityPluginDir({ USERPROFILE: 'C:\\Users\\a', HOME: '/ignored' }, 'win32'), path.join('C:\\Users\\a', '.gemini', 'config', 'plugins', 'agent-guild'));
  assert.equal(antigravityPluginDir({ HOME: '/home/a', USERPROFILE: 'C:\\ignored' }, 'linux'), path.join('/home/a', '.gemini', 'config', 'plugins', 'agent-guild'));
  assert.equal(antigravityPluginDir({}, 'linux'), path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agent-guild'));
  assert.equal(antigravityConfigFile({ USERPROFILE: 'C:\\Users\\a' }, 'win32'), path.join('C:\\Users\\a', '.gemini', 'config', 'config.json'));
  assert.equal(antigravityConfigFile({}, 'linux'), path.join(os.homedir(), '.gemini', 'config', 'config.json'));
});

test('shell commands map to shell reports that carry no command text', () => {
  const secret = 'curl -H "Authorization: Bearer s3cr3t" https://example.test';
  const [start] = hookToReports({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: secret } });
  assert.deepEqual(Object.keys(start), ['shell', 'key', 'match']);
  assert.deepEqual([start.shell, start.key], ['start', 'toolu_1']);
  assert.match(start.match, /^[a-f0-9]{32}$/);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: secret }, tool_response: { stdout: '' } }), [{ shell: 'end', key: 'toolu_1' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: secret } }), [{ shell: 'end', key: 'toolu_1' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', tool_name: 'PowerShell', tool_use_id: 'toolu_2', tool_input: { command: 'Start-Sleep 60', run_in_background: true }, tool_response: { stdout: '', backgroundTaskId: 'b1', backgroundedByUser: true } }),
    [{ shell: 'background', key: 'toolu_2', task: 'b1' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', agent_id: 's1', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'npm run dev' }, tool_response: { backgroundTaskId: 'b2', backgroundEndsWithFinalResponse: true } }),
    [{ shell: 'background', key: 'toolu_3', task: 'b2', endsWithAgent: true }], 'Claude Code ends it when its sub-agent gives its final response');

  const [waiting] = hookToReports({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: secret }, permission_suggestions: [] });
  assert.deepEqual(waiting, { shell: 'waiting', match: start.match }, 'no tool_use_id in Claude Code\'s PermissionRequest: the command hash finds the command');
  assert.equal(hookToReports({ hook_event_name: 'PermissionRequest', tool_name: 'PowerShell', tool_input: { command: 'Remove-Item x' } })[0].shell, 'waiting');
  assert.deepEqual(hookToReports({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: {} }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_use_id: 'toolu_4', tool_input: { task_id: 'b1' }, tool_response: {} }),
    [{ shell: 'end', task: 'b1' }, { agentId: 'hook-b1', status: 'done' }], 'a stopped task is a background command or a sub-agent');
  assert.deepEqual(hookToReports({ hook_event_name: 'PostToolUseFailure', tool_name: 'TaskStop', tool_use_id: 'toolu_5', tool_input: { task_id: 'b1' }, error: 'No task found with ID: b1' }), [], 'a TaskStop that failed stopped nothing');

  const tasks = [
    { id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: secret },
    { id: 'b3', type: 'shell', status: 'completed', command: 'make' },
    { id: 'm1', type: 'monitor', status: 'running', server: 's', tool: 't' },
    { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' },
  ];
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: tasks, session_crons: [] }), [{ shell: 'running', tasks: ['b1'] }, { finishForeground: true }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'Stop', stop_hook_active: false }), [{ finishForeground: true }], 'without the list, nothing to match it to');
  assert.deepEqual(hookToReports({ hook_event_name: 'SubagentStop', agent_id: 's1', agent_type: 'Explore', background_tasks: [] }),
    [{ agentId: 'hook-s1', name: 'Explore', kind: 'subagent', status: 'done' }, { shell: 'running', tasks: [] }]);

  const [codexStart] = hookToReports({ hook_event_name: 'PreToolUse', turn_id: 't1', model: 'gpt-5-codex', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: secret } });
  assert.deepEqual(codexStart, { shell: 'start', key: 'call_1', match: start.match, persist: true }, 'Codex CLI keeps a command running past its turn');
  assert.deepEqual(hookToReports({ hook_event_name: 'PermissionRequest', turn_id: 't1', tool_name: 'Bash', tool_input: { command: secret } }), [{ shell: 'asked', match: start.match }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'SessionEnd', turn_id: '', session_id: 'thread-1' }), [{ shell: 'reset' }], 'Codex CLI ends every command before SessionEnd');

  assert.deepEqual(hookToReports({ hookEventName: 'pre_tool_use', hook_event_name: 'PreToolUse', toolName: 'run_terminal_command', toolUseId: 'g1', toolInput: { command: secret } }), [{ shell: 'start', key: 'g1', match: start.match }]);
  const [grokStart] = hookToReports({ hookEventName: 'pre_tool_use', hook_event_name: 'PreToolUse', toolName: 'run_terminal_command', toolUseId: 'g1', toolInput: { command: secret } });
  for (const report of [start, waiting, codexStart, grokStart]) assert.ok(!JSON.stringify(report).includes('s3cr3t'));
});

test('a Claude Code task notification ends the sub-agent it names, and is no turn boundary', () => {
  const prompt = '<task-notification>\n<task-id>a7</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/t/a7.output</output-file>\n<status>killed</status>\n<summary>Agent "x" was stopped by Claude</summary>\n</task-notification>';
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }), [{ shell: 'end', task: 'a7', key: 'toolu_1' }, { agentId: 'hook-a7', status: 'done' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', prompt: `${prompt}\n${prompt.replaceAll('a7', 'b8').replace('toolu_1', 'toolu_2').replace('killed', 'completed')}` }),
    [{ shell: 'end', task: 'a7', key: 'toolu_1' }, { agentId: 'hook-a7', status: 'done' }, { shell: 'end', task: 'b8', key: 'toolu_2' }, { agentId: 'hook-b8', status: 'done' }]);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', prompt: prompt.replace('killed', 'running') }), []);
  // Claude Code fires it at once for a prompt typed while a turn still runs, so none is a turn boundary; Codex CLI's is.
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p2', permission_mode: 'default', prompt: 'fix the <task-notification> parser' }), []);
  assert.deepEqual(hookToReports({ hook_event_name: 'UserPromptSubmit', turn_id: 't2', prompt: 'next' }), [{ finishForeground: true }]);
});

