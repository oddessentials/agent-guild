import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, resolveAllCommands, buildSpawnSpec, quoteForCmd } from '../src/manager/command-resolver.mjs';
import { mergePathLists, parsePathFromEnvOutput, weavePaths, parseRegValue, expandWindowsVars, readWindowsPath, trimPathExt } from '../src/manager/shell-env.mjs';
import { mergeEnv, cleanResumeId, modelFromArgs, SessionManager } from '../src/manager/session-manager.mjs';
import { loadProviders, defaultShell, ProviderRegistry } from '../src/manager/providers.mjs';
import { paths } from '../src/manager/config.mjs';
import { classifyInstall, expandHome, helpDescribes, platformDependency, listInstallations, knownLaunchers, shellCommand } from '../src/manager/install-channels.mjs';
import { hookToReports, claudeStatuslineToReport, formatStatusLine } from '../src/report/hooks.mjs';
import { shimContents, writeReportShims, prependPath, fileUrl, SHIM_NAME, LOADER_NAME } from '../src/manager/report-shims.mjs';
import { execFileSync } from 'node:child_process';
import { parseVersion, compareVersions, probeVersion, diagnosticLine, latestVersion } from '../src/manager/versions.mjs';
import {
  UsageMonitor, UsageError, readClaudeCredentials, readCodexCredentials, readGeminiCredentials, readGeminiFileKeychain, geminiFileKey, geminiStorageMode, geminiOAuthClientFromInstall, geminiKeychainLookup,
  claudeKeychainService, claudeCredentialsFile, fetchClaudeUsage, fetchCodexUsage, fetchGeminiUsage, commandUsage, toIso, windowLabel, clampPercent,
} from '../src/manager/usage.mjs';
import {
  ModelStats, parseCatalog, indexCatalog, standing, tierFor, providerModels, modelNames, resolveModel, describeCatalog,
} from '../src/manager/model-stats.mjs';
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
  const gemini = { tool: 'Gemini CLI', package: '@google/gemini-cli', channels: { brew: { names: ['gemini-cli'] } } };
  const intel = classifyInstall({ ...mac, provider: gemini, resolvedPath: '/usr/local/bin/gemini', fsx: fsx({
    files: ['/usr/local/bin/brew', '/opt/homebrew/bin/brew', '/usr/local/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/package.json'],
    links: { '/usr/local/bin/gemini': '/usr/local/Cellar/gemini-cli/0.46.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js' },
  }) });
  assert.equal(intel.channel, 'brew', 'a formula that bundles an npm package is still Homebrew-owned');
  assert.deepEqual(intel.update, { file: '/usr/local/bin/brew', args: ['upgrade', 'gemini-cli'] }, 'the Homebrew that owns the file');
  const linuxbrew = classifyInstall({ provider: gemini, platform: 'linux', env: { HOME: '/home/a' }, resolvedPath: '/home/linuxbrew/.linuxbrew/bin/gemini', fsx: fsx({
    files: ['/home/linuxbrew/.linuxbrew/bin/brew'],
    links: { '/home/linuxbrew/.linuxbrew/bin/gemini': '/home/linuxbrew/.linuxbrew/Cellar/gemini-cli/0.46.0/bin/gemini' },
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

  script(nativeDir, 'mytool', { win: 'exit /b 1', sh: 'exit 1' });
  await nativeFirst.refreshVersions({ force: true });
  assert.equal(nativeFirst.describe(tool).updateCommand, null);

  assert.equal(helpDescribes('Usage: claude update|upgrade [options]\n\nCheck for updates and install if available', ['update']), true);
  assert.equal(helpDescribes('Check for updates or install a specific version\n\nUsage: grok update [OPTIONS]', ['update']), true);
  assert.equal(helpDescribes('USAGE:\n    tool update [FLAGS]', ['update']), true);
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

test('installations are counted once however many entry points they have', () => {
  const claude = {
    tool: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    channels: {
      native: { paths: ['~/.local/bin/claude', '~/.local/share/claude'], update: ['update'], uninstall: 'remove-native', sharedWithNpm: false },
      brew: { names: ['claude-code', 'claude-code@latest'] },
      winget: { id: 'Anthropic.ClaudeCode' },
      legacy: { paths: ['~/.claude/local'], guidance: null, uninstall: 'remove-legacy' },
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
  assert.equal(junction[0].removeCommand, `${current}\\npm.cmd uninstall -g --prefix ${current} '@anthropic-ai/claude-code'`);

  const versions = '/Users/a/.local/share/claude/versions/2.1.286';
  const linked = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', '/usr/local/bin/claude'], fsx: fsx({
    links: { '/Users/a/.local/bin/claude': versions, '/usr/local/bin/claude': versions },
  }) });
  assert.deepEqual(channelsOf(linked), ['native'], 'a second link to the native build is the same installation');
  assert.equal(linked[0].removeCommand, 'remove-native');

  const nvm = '/Users/a/.nvm/versions/node/v22';
  const nvmPkg = `${nvm}/lib/node_modules/@anthropic-ai/claude-code`;
  const npmFiles = { files: [`${nvmPkg}/package.json`, `${nvm}/bin/npm`], links: { [`${nvm}/bin/claude`]: `${nvmPkg}/bin/claude.exe`, '/usr/local/bin/claude': `${nvmPkg}/bin/claude.exe` } };
  const npmLinked = listInstallations({ ...mac, onPath: [`${nvm}/bin/claude`, '/usr/local/bin/claude'], fsx: fsx(npmFiles) });
  assert.deepEqual(channelsOf(npmLinked), ['npm'], 'a link elsewhere into the npm package is the same installation');
  const viaLink = listInstallations({ ...mac, onPath: ['/usr/local/bin/claude'], fsx: fsx(npmFiles) });
  assert.equal(viaLink[0].channel, 'npm');
  assert.equal(viaLink[0].removeCommand, `${nvm}/bin/npm uninstall -g --prefix ${nvm} @anthropic-ai/claude-code`);

  const both = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', `${nvm}/bin/claude`], fsx: fsx({
    files: npmFiles.files, links: { ...npmFiles.links, '/Users/a/.local/bin/claude': versions },
  }) });
  assert.deepEqual(channelsOf(both), ['native', 'npm'], 'a native build and an npm install are two installations');

  const grok = { tool: 'Grok Build', package: '@xai-official/grok', channels: { native: { paths: ['~/.grok/bin'], update: ['update'], uninstall: null, sharedWithNpm: true } } };
  const grokPkg = `${nvm}/lib/node_modules/@xai-official/grok`;
  const shared = listInstallations({ ...mac, provider: grok, onPath: [`${nvm}/bin/grok`, '/Users/a/.grok/bin/grok'], fsx: fsx({
    files: [`${grokPkg}/package.json`, `${nvm}/bin/npm`], links: { [`${nvm}/bin/grok`]: `${grokPkg}/bin/grok-native` },
  }) });
  assert.deepEqual(channelsOf(shared), ['npm'], 'an npm wrapper over the native location is one installation');

  const cask = '/opt/homebrew/Caskroom/claude-code/2.1.285/claude';
  const intel = '/usr/local/Caskroom/claude-code/2.1.285/claude';
  const brews = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude', cask, '/usr/local/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], links: { '/opt/homebrew/bin/claude': cask, '/usr/local/bin/claude': intel },
  }) });
  assert.deepEqual(channelsOf(brews), ['brew', 'brew'], 'a link and its Caskroom file are one installation; another Homebrew is another');
  assert.deepEqual(brews.map((i) => i.removeCommand), ['/opt/homebrew/bin/brew uninstall --cask claude-code', '/usr/local/bin/brew uninstall --cask claude-code']);

  const packages = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe';
  const link = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe';
  const acceptance = listInstallations({ ...windows, onPath: ['C:\\Users\\a\\.local\\bin\\claude.exe', link, packages], fsx: fsx({
    files: ['C:\\Users\\a\\.local\\bin\\claude.exe'], links: { [link]: packages },
  }) });
  assert.deepEqual(channelsOf(acceptance), ['native', 'winget']);
  assert.equal(acceptance[1].removeCommand, 'winget uninstall --id Anthropic.ClaudeCode --exact');

  const unknown = listInstallations({ ...mac, onPath: ['/opt/a/claude', '/opt/b/claude', '/opt/c/claude'], fsx: fsx({ links: { '/opt/c/claude': '/opt/a/claude' } }) });
  assert.deepEqual(channelsOf(unknown), ['unknown', 'unknown'], 'two links to one unrecognised file count once');
  assert.deepEqual(unknown.map((i) => i.removeCommand), [null, null], 'no removal command without confirmed ownership');

  const offPath = fsx({ files: ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude', '/Users/a/.local/share/claude/versions/2.1.286'] });
  assert.deepEqual(knownLaunchers({ provider: claude, command: 'claude', env: mac.env, platform: 'darwin', fsx: offPath }), ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude'], 'kept versions are not launchers');
  assert.deepEqual(knownLaunchers({ provider: claude, command: '/abs/claude', env: mac.env, platform: 'darwin', fsx: offPath }), []);
  assert.deepEqual(knownLaunchers({ provider: claude, command: 'claude', env: windows.env, platform: 'win32', fsx: fsx({ files: ['C:\\Users\\a\\.local\\bin\\claude.exe'] }) }), ['C:\\Users\\a\\.local\\bin\\claude.exe']);
  const found = listInstallations({ ...mac, onPath: [], known: ['/Users/a/.local/bin/claude', '/Users/a/.claude/local/claude'], fsx: offPath });
  assert.deepEqual(found.map((i) => [i.channel, i.onPath, i.removeCommand]), [['native', false, 'remove-native'], ['legacy', false, 'remove-legacy']]);
});

test('ownership follows where a tool is really installed, and removal commands suit the shell', () => {
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
      native: { paths: ['~/.local/bin/claude', '~/.local/share/claude'], update: ['update'], uninstall: 'remove-native', sharedWithNpm: false },
      brew: { names: ['claude-code', 'claude-code@latest'] },
    },
  };
  const mac = { provider: claude, platform: 'darwin', env: { HOME: '/Users/a' }, npmOnPath: '/opt/homebrew/bin/npm' };
  const commandOf = (install) => install.update && [install.update.file, ...install.update.args].join(' ');

  const gemini = { tool: 'Gemini CLI', package: '@google/gemini-cli', channels: { brew: { names: ['gemini-cli'] } } };
  const cellar = '/opt/homebrew/Cellar/gemini-cli/0.46.0';
  const formula = listInstallations({ ...mac, provider: gemini, onPath: ['/opt/homebrew/bin/gemini'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew', '/opt/homebrew/bin/npm', `${cellar}/libexec/lib/node_modules/@google/gemini-cli/package.json`, `${cellar}/libexec/bin/npm`],
    links: { '/opt/homebrew/bin/gemini': `${cellar}/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js` },
  }) });
  assert.equal(formula.length, 1);
  assert.equal(formula[0].channel, 'brew', 'the package tree inside a Cellar is not an npm prefix');
  assert.equal(commandOf(formula[0]), '/opt/homebrew/bin/brew upgrade gemini-cli');
  assert.equal(formula[0].removeCommand, '/opt/homebrew/bin/brew uninstall gemini-cli');

  const cask = '/opt/homebrew/Caskroom/claude-code/2.1.285/claude';
  const aliasToBrew = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude', '/Users/a/.local/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew'],
    links: { '/opt/homebrew/bin/claude': cask, '/Users/a/.local/bin/claude': cask },
  }) });
  assert.equal(aliasToBrew.length, 1, 'one Homebrew installation reached through two launchers');
  assert.equal(aliasToBrew[0].channel, 'brew');
  assert.equal(commandOf(aliasToBrew[0]), '/opt/homebrew/bin/brew upgrade --cask claude-code');
  assert.equal(aliasToBrew[0].removeCommand, '/opt/homebrew/bin/brew uninstall --cask claude-code');

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
  assert.equal(aliasIntoKeg[0].removeCommand, `${kegReal}/bin/npm uninstall -g --prefix ${kegReal} @anthropic-ai/claude-code`);
  const aliasAndLauncher = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', `${keg}/bin/claude`], fsx: fsx(kegLayout) });
  assert.deepEqual(aliasAndLauncher.map((i) => i.channel), ['npm'], 'the alias and the npm launcher are one installation');

  const foreign = listInstallations({ ...mac, onPath: ['/opt/homebrew/bin/claude'], fsx: fsx({
    files: ['/opt/homebrew/bin/brew'], links: { '/opt/homebrew/bin/claude': '/opt/homebrew/Cellar/sometool/1.0/bin/claude' },
  }) });
  assert.equal(foreign[0].channel, 'unknown', "a file in another formula's keg is not attributed to that formula");
  assert.equal(foreign[0].update, null);
  assert.equal(foreign[0].removeCommand, null);

  const elsewhere = '/opt/tools/claude/claude';
  const aliasFirst = listInstallations({ ...mac, onPath: ['/Users/a/.local/bin/claude', '/opt/tools/bin/claude'], fsx: fsx({
    links: { '/Users/a/.local/bin/claude': elsewhere, '/opt/tools/bin/claude': elsewhere },
  }) });
  assert.equal(aliasFirst.length, 1);
  assert.equal(aliasFirst[0].channel, 'unknown', 'a link at the native launcher path does not make its target a native install');
  assert.equal(aliasFirst[0].update, null);
  assert.equal(aliasFirst[0].removeCommand, null);
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
  assert.equal(spaced[0].removeCommand, "& 'C:\\Program Files\\nodejs\\npm.cmd' uninstall -g --prefix 'C:\\Users\\First Last\\AppData\\Roaming\\npm' '@anthropic-ai/claude-code'");

  assert.equal(shellCommand('C:\\nodejs\\npm.cmd', ['uninstall', '-g', '--prefix', 'C:\\nodejs', 'pkg'], 'win32'), 'C:\\nodejs\\npm.cmd uninstall -g --prefix C:\\nodejs pkg');
  assert.equal(shellCommand("C:\\Users\\O'Brien\\npm.cmd", ['uninstall'], 'win32'), "& 'C:\\Users\\O''Brien\\npm.cmd' uninstall");
  assert.equal(shellCommand('winget', ['uninstall', '--id', 'Anthropic.ClaudeCode', '--exact'], 'win32'), 'winget uninstall --id Anthropic.ClaudeCode --exact');
  assert.equal(
    shellCommand('/Users/First Last/.nvm/bin/npm', ['uninstall', '-g', '--prefix', '/Users/First Last/.nvm', '@anthropic-ai/claude-code'], 'darwin'),
    "'/Users/First Last/.nvm/bin/npm' uninstall -g --prefix '/Users/First Last/.nvm' @anthropic-ai/claude-code",
  );
  assert.equal(shellCommand("/Users/o'brien/bin/brew", ['uninstall', '--cask', 'claude-code@latest'], 'darwin'), "'/Users/o'\\''brien/bin/brew' uninstall --cask claude-code@latest");
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
    { id: 'dup', tool: 'Dup Tool', command: 'dup', package: 'dup-pkg', versionArgs: ['--version'], channels: { native: { paths: [path.join(dirA, 'dup')], update: ['update'], uninstall: 'remove-native' } } },
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
  assert.deepEqual(shadowed.installs.map((i) => [i.path, i.channel, i.version, i.active, i.newer, i.removeCommand]), [
    [copyA, 'native', '1.0.0', true, false, 'remove-native'],
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

test('Gemini CLI credentials come from the keychain item or the legacy file, and usage from Code Assist', async () => {
  const dir = tempDir();
  const legacyFile = path.join(dir, 'oauth_creds.json');
  const keychainFile = path.join(dir, 'gemini-credentials.json');
  const none = async () => null;
  const read = (overrides) => readGeminiCredentials({ file: legacyFile, keychainFile, platform: 'linux', readKeychain: none, ...overrides });
  await assert.rejects(read(), /not signed in/);
  const fakeClient = { id: '12345-abc.apps.googleusercontent.com', secret: 'GOCSPX-fake' };
  fs.writeFileSync(legacyFile, JSON.stringify({ access_token: 'legacy', refresh_token: 'r1', expiry_date: 1893456000000, client_id: fakeClient.id, client_secret: fakeClient.secret }));
  assert.deepEqual(await read(), { accessToken: 'legacy', refreshToken: 'r1', expiresAt: 1893456000000, client: fakeClient });
  const item = JSON.stringify({ serverName: 'main-account', token: { accessToken: 'kc', refreshToken: 'r2', expiresAt: 1893456000000, tokenType: 'Bearer' } });
  const keychain = async () => item;
  assert.deepEqual(await read({ platform: 'darwin', readKeychain: keychain, encrypted: true }),
    { accessToken: 'kc', refreshToken: 'r2', expiresAt: 1893456000000, client: null }, 'with encrypted storage the keychain item wins over the legacy file');
  assert.equal((await read({ platform: 'darwin', readKeychain: keychain })).accessToken, 'legacy', 'without it the keychain is not consulted, as in Gemini CLI');
  assert.equal((await read({ platform: 'darwin', readKeychain: keychain, encrypted: true, fileStorage: true })).accessToken, 'legacy', 'forced file storage skips the keychain too');
  assert.deepEqual(geminiStorageMode({ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true', GEMINI_FORCE_FILE_STORAGE: 'true' }), { encrypted: true, fileStorage: true });
  assert.deepEqual(geminiStorageMode({ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' }), { encrypted: false, fileStorage: false });
  await assert.rejects(read({ platform: 'darwin', readKeychain: async () => 'not json', encrypted: true }), /parsed/);
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

test('Gemini CLI\'s encrypted credentials file is read like its keychain item', async () => {
  const dir = tempDir();
  const keychainFile = path.join(dir, 'gemini-credentials.json');
  const legacyFile = path.join(dir, 'oauth_creds.json');
  const key = geminiFileKey({ hostname: 'box', username: 'me' });
  assert.deepEqual(geminiFileKey({ hostname: 'box', username: 'me' }), key, 'the key is derived from the machine and user alone');
  assert.notDeepEqual(geminiFileKey({ hostname: 'other', username: 'me' }), key);
  const seal = (data, k = key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
  };
  const item = { serverName: 'main-account', token: { accessToken: 'enc', refreshToken: 'r9', expiresAt: 1893456000000, tokenType: 'Bearer' } };
  assert.equal(await readGeminiFileKeychain(keychainFile, { key }), null, 'no file is no item');
  fs.writeFileSync(keychainFile, seal({ 'gemini-cli-oauth': { 'main-account': JSON.stringify(item) } }));
  assert.equal(await readGeminiFileKeychain(keychainFile, { key }), JSON.stringify(item));
  fs.writeFileSync(legacyFile, JSON.stringify({ access_token: 'legacy', refresh_token: 'r1' }));
  const none = async () => null;
  const read = (overrides) => readGeminiCredentials({ file: legacyFile, keychainFile, platform: 'linux', encrypted: true, readKeychain: none, readFileKeychain: (file) => readGeminiFileKeychain(file, { key }), ...overrides });
  assert.deepEqual(await read(), { accessToken: 'enc', refreshToken: 'r9', expiresAt: 1893456000000, client: null }, 'the file item wins over oauth_creds.json');
  assert.equal((await read({ encrypted: false })).accessToken, 'legacy', 'without encrypted storage only oauth_creds.json counts, as in Gemini CLI');
  const os = async () => JSON.stringify({ token: { accessToken: 'os' } });
  assert.equal((await read({ readKeychain: os })).accessToken, 'os', 'the OS keychain wins over the file');
  assert.equal((await read({ readKeychain: os, fileStorage: true })).accessToken, 'enc', 'unless file storage is forced');
  fs.writeFileSync(keychainFile, seal({ 'gemini-cli-oauth': { other: '{}' } }));
  assert.equal((await read()).accessToken, 'legacy', 'a file without the main account falls through');
  fs.writeFileSync(keychainFile, seal({ 'gemini-cli-oauth': { 'main-account': JSON.stringify(item) } }, geminiFileKey({ hostname: 'other', username: 'me' })));
  await assert.rejects(read(), /could not be decrypted/, 'another machine\'s file is reported, not mistaken for no sign-in');
  fs.writeFileSync(keychainFile, 'not:encrypted');
  await assert.rejects(read(), /could not be decrypted/);
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

test('accounts get their own home folder and environment, the default keeps the tool\'s own', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', accounts: [{ id: 'work', label: ' Work ' }, { id: 'personal', dir: '~/.claude-personal' }, { id: 'default', label: 'Main', dir: '/ignored' }, { id: 'Bad Id' }, { id: 'work' }, 'shared', 7] },
    { id: 'openai', accounts: 'work' },
    { id: 'shell', accounts: [{ id: 'other' }] },
    { id: 'google', hooks: { path: '../settings.json', example: 'gemini-settings.json' } },
    { id: 'xai', homeVar: 'not a name', accounts: [{ id: 'x' }] },
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
  assert.equal(byId.google.hooks, null, 'a hooks path cannot leave the home folder');
  assert.deepEqual(byId.anthropic.hooks, { path: 'settings.json', example: 'claude-code-settings.json' });
  assert.equal(byId.google.homeVar, 'GEMINI_CLI_HOME');
  const expected = ['ignored dir of the default account', 'invalid id "Bad Id"', 'duplicate account "work"', 'invalid id 7', 'openai": ignored accounts; it must be an array', 'shell": ignored accounts; the provider has no homeVar', 'xai": ignored accounts; the provider has no homeVar'];
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

  const gemini = loadProviders({ userFile: relativeFile, platform: 'linux' }).providers.find((p) => p.id === 'google');
  assert.deepEqual(registry.accountFor(gemini, { id: 'work', label: 'Work', dir: null }).env, { GEMINI_CLI_HOME: '/data/accounts/google/work', GEMINI_FORCE_FILE_STORAGE: 'true' }, 'Gemini keeps an account\'s sign-in in that account\'s folder, never the shared keychain item');

  const dataDirDefault = new ProviderRegistry({ userFile, env: { PATH: '' }, platform: 'linux', checkUpdates: false });
  assert.equal(dataDirDefault.accountsDir, paths.accounts, 'accounts live in the data folder by default');
  assert.equal(dataDirDefault.account(dataDirDefault.get('anthropic'), 'work').dir, path.posix.join(paths.accounts, 'anthropic', 'work'));
});

test('usage is read per account, from that account\'s home folder only', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'anthropic', accounts: [{ id: 'work' }] },
    { id: 'google', accounts: [{ id: 'work' }] },
    { id: 'openai', usage: null },
    { id: 'xai', usage: null },
  ] }));
  const accountsDir = path.join(dir, 'accounts');
  const registry = new ProviderRegistry({ userFile, env: { PATH: '' }, checkUpdates: false, accountsDir });
  const claudeHome = path.join(dir, 'claude-home');
  fs.mkdirSync(claudeHome);
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'pro' } }));
  const geminiCalls = [];
  const monitor = new UsageMonitor({
    registry,
    platform: 'linux',
    env: { PATH: '', CLAUDE_CONFIG_DIR: claudeHome, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' },
    fetchImpl: async (url) => {
      if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({ cloudaicompanionProject: 'proj-1', currentTier: { name: 'Free' } }) };
      if (url.endsWith(':retrieveUserQuota')) return { ok: true, json: async () => ({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }] }) };
      return { ok: true, json: async () => ({ five_hour: { utilization: 5 } }) };
    },
    readers: {
      gemini: async ({ file, keychainFile, encrypted, fileStorage, readKeychain }) => {
        geminiCalls.push({ file, keychainFile, encrypted, fileStorage, readKeychain });
        if (file.includes('accounts')) throw Object.assign(new UsageError('Gemini CLI is not signed in on this machine'), { notSignedIn: true });
        return { accessToken: 'g', refreshToken: null, expiresAt: Date.now() + 3600000 };
      },
    },
  });
  const all = await monitor.all();
  const byKey = Object.fromEntries(all.map((u) => [`${u.providerId}/${u.accountId}`, u]));
  assert.deepEqual(Object.keys(byKey), ['anthropic/default', 'anthropic/work', 'google/default', 'google/work']);
  assert.equal(byKey['anthropic/default'].signedIn, true);
  assert.equal(byKey['anthropic/default'].plan, 'pro');
  assert.deepEqual(byKey['anthropic/default'].windows, [{ label: '5-hour', usedPercent: 5, resetsAt: null }]);
  assert.equal(byKey['anthropic/work'].signedIn, false, 'an account without a credentials file is not signed in');
  assert.match(byKey['anthropic/work'].error, new RegExp(path.join('accounts', 'anthropic', 'work').replace(/\\/g, '\\\\')));
  assert.deepEqual(byKey['anthropic/work'].windows, []);
  assert.equal(byKey['google/default'].signedIn, true);
  assert.equal(byKey['google/work'].signedIn, false);
  assert.deepEqual(geminiCalls.map((c) => [c.encrypted, c.fileStorage]), [[false, false], [false, true]], 'an account with its own folder never reads the shared keychain item');
  assert.ok(geminiCalls.every((c) => c.readKeychain === undefined), 'the storage choice comes from the environment, as in Gemini CLI');
  assert.equal(geminiCalls[0].file, path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  assert.equal(geminiCalls[1].file, path.join(accountsDir, 'google', 'work', '.gemini', 'oauth_creds.json'));
  assert.equal(geminiCalls[1].keychainFile, path.join(accountsDir, 'google', 'work', '.gemini', 'gemini-credentials.json'));
  assert.equal(geminiCalls[0].keychainFile, path.join(os.homedir(), '.gemini', 'gemini-credentials.json'));
  assert.equal(byKey['google/default'].windows[0].usedPercent, 50);
  await monitor.all();
  assert.equal(geminiCalls.length, 2, 'each account has its own cache entry');
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
    // Absolute shell paths: the env under test need not carry System32.
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const cmd = path.join(system32, 'cmd.exe');
    const winArgs = [[cmd, ['/d', '/s', '/c', `${SHIM_NAME} --help`], 'cmd.exe (Codex CLI) finds the .cmd through PATHEXT'],
      [path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `${SHIM_NAME} --help`], 'PowerShell (Gemini CLI, Grok Build) runs the .cmd under the Restricted policy']];
    for (const [file, args, why] of winArgs) assert.match(run(file, args, withNode), /^Usage: agent-guild-report/, why);
    // The manager's Node.js is gone: `node` on the (real) PATH takes over.
    assert.match(run(cmd, ['/d', '/s', '/c', `${SHIM_NAME} --help`], { ...withNode, AGENT_GUILD_NODE: gone }), /^Usage: agent-guild-report/, 'falls back to node on PATH');
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
