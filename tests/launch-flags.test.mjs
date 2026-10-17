import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchFlags, helpEntry, normalizeLaunchFlags, offeredFlags } from '../src/manager/launch-flags.mjs';
import { ProviderRegistry, loadProviders } from '../src/manager/providers.mjs';
import { codexHookArgs, dockerHookArgs } from '../src/manager/session-hooks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const help = (name) => fs.readFileSync(path.join(here, 'fixtures', 'help', `${name}.txt`), 'utf8');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-flags-'));
const defaults = loadProviders({ userFile: path.join(tempDir(), 'none.json'), platform: process.platform }).providers;
const byCommand = (command) => defaults.find((p) => p.command === command);

const EXPECTED = {
  claude: {
    '--model': 'required', '--effort': 'required', '--permission-mode': 'required', '--dangerously-skip-permissions': 'none',
    '--add-dir': 'required', '--allowedTools': 'required', '--disallowedTools': 'required', '--append-system-prompt': 'required',
    '--agent': 'required', '--mcp-config': 'required', '--strict-mcp-config': 'none',
  },
  codex: {
    '--model': 'required', '--config': 'required', '--sandbox': 'required', '--ask-for-approval': 'required',
    '--dangerously-bypass-approvals-and-sandbox': 'none', '--search': 'none', '--add-dir': 'required', '--profile': 'required',
  },
  agy: {
    '--model': 'required', '--effort': 'required', '--mode': 'required', '--dangerously-skip-permissions': 'none',
    '--sandbox': 'none', '--add-dir': 'required', '--agent': 'required',
  },
  grok: {
    '--model': 'required', '--reasoning-effort': 'required', '--permission-mode': 'required', '--always-approve': 'none',
    '--sandbox': 'required', '--allow': 'required', '--deny': 'required', '--disable-web-search': 'none', '--rules': 'required',
    '--agent': 'required',
  },
  docker: { '--agent': 'required', '--model': 'required', '--yolo': 'none', '--safety': 'required', '--sandbox': 'none' },
};

test('every built-in launch flag is found in its tool\'s real help, with its value and only its own description', () => {
  for (const [command, expected] of Object.entries(EXPECTED)) {
    const provider = byCommand(command);
    const flags = offeredFlags(help(command), provider.launchFlags);
    assert.deepEqual(Object.fromEntries(flags.map((f) => [f.flag, f.value])), expected, command);
    for (const flag of flags) {
      assert.ok(flag.about.length > 10, `${command} ${flag.flag} has a description`);
      assert.doesNotMatch(flag.about, /(^|\n)\s*-{1,2}[a-z]/i, `${command} ${flag.flag} stops before the next flag`);
    }
  }
  assert.equal(helpEntry(help('codex'), '--sandbox').about, 'Select the sandbox policy to use when executing model-generated shell commands\n[possible values: read-only, workspace-write, danger-full-access]');
  assert.equal(helpEntry(help('claude'), '--append-system-prompt').about, 'Append a system prompt to the default system prompt', 'a wrapped description that starts with the flag is not its entry');
  assert.equal(helpEntry(help('docker'), '--agent').about, 'Name of the agent to run (defaults to the team\'s first agent)');
  assert.equal(helpEntry(help('claude'), '--resume').value, 'optional');
  assert.equal(helpEntry(help('docker'), '--worktree').value, 'optional');
  assert.equal(helpEntry(help('claude'), '--no-such-flag'), null);
  assert.ok(defaults.every((p) => p.command !== '@shell' || p.launchFlags.length === 0));
  assert.deepEqual(defaults.flatMap((p) => p.launchFlags.filter((f) => f.risky).map((f) => `${p.command} ${f.flag}`)), [
    'claude --dangerously-skip-permissions', 'codex --dangerously-bypass-approvals-and-sandbox', 'agy --dangerously-skip-permissions',
    'grok --always-approve', 'docker --yolo',
  ]);
  assert.ok(defaults.filter((p) => p.launchFlags.length).every((p) => p.launchFlagsEquals), 'every built-in tool with flags reads --flag=value');
  assert.equal(defaults.find((p) => p.command === '@shell').launchFlagsEquals, false);
  assert.equal(offeredFlags(help('codex'), byCommand('codex').launchFlags).find((f) => f.flag === '--config').example, 'model_reasoning_effort=high');
  assert.deepEqual(['--effort', '--allowedTools', '--strict-mcp-config'].map((flag) => helpEntry(help('claude'), flag).placeholder), ['<level>', '<tools...>', '']);
  assert.deepEqual([helpEntry(help('codex'), '--sandbox').placeholder, helpEntry(help('docker'), '--safety').placeholder, helpEntry(help('agy'), '--effort').placeholder], ['<SANDBOX_MODE>', 'string', '']);
});

test('launchFlags entries are flags, optionally marked as taking a value', () => {
  const warnings = [];
  assert.deepEqual(normalizeLaunchFlags(['--effort <value>', '--yolo !', '-c', '--yolo', 'rm -rf', 7, '--x <other>', '--y <value> !', '--z!'], 'p', warnings), [
    { flag: '--effort', value: true, risky: false }, { flag: '--yolo', value: false, risky: true }, { flag: '-c', value: false, risky: false },
    { flag: '--y', value: true, risky: true },
  ]);
  assert.equal(warnings.length, 4);
  assert.deepEqual(normalizeLaunchFlags(undefined, 'p', warnings), []);
  assert.deepEqual(normalizeLaunchFlags('--yolo', 'p', warnings), []);
  assert.match(warnings.at(-1), /must be a list/);
  const noted = [];
  assert.deepEqual(normalizeLaunchFlags(['--config', '--yolo'], 'p', noted, { '--config': ' key=1 ', '--missing': 'x', '--yolo': 3 }), [
    { flag: '--config', value: false, risky: false, example: 'key=1' }, { flag: '--yolo', value: false, risky: false },
  ]);
  assert.equal(noted.length, 2);
  assert.deepEqual(normalizeLaunchFlags(['--config'], 'p', noted, ['--config']), [{ flag: '--config', value: false, risky: false }]);
  assert.match(noted.at(-1), /launchFlagExamples; it must map flags/);
  assert.deepEqual(offeredFlags(help('agy'), [{ flag: '--effort', value: false }]).map((f) => f.value), ['none']);
});

function fakeTool(dir) {
  const script = path.join(dir, 'tool.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.appendFileSync(process.env.FAKE_RUNS, process.argv.slice(2).join(' ') + '\\n');
const mode = fs.readFileSync(process.env.FAKE_MODE_FILE, 'utf8');
const help = 'Usage:\\n  --effort <level>   Effort level\\n  --yolo             Approve everything\\n';
if (mode === 'hang' || mode === 'flood') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_CHILD, String(child.pid));
  setInterval(() => {}, 1000);
  process.stdout.write(help);
  if (mode === 'flood') process.stdout.write('x'.repeat(64 * 1024));
}
else if (mode === 'silent') process.exit(3);
else if (mode === 'diagnostic') {
  process.stderr.write("error: unexpected argument '--effort' found\\n\\n  --effort is not allowed here\\n\\nUsage: tool [OPTIONS]\\n");
  process.exit(2);
}
else if (mode === 'usage') process.stdout.write('Usage: tool [OPTIONS]\\n');
else if (mode === 'changed') process.stdout.write('Usage:\\n  --gone             Now offered\\n  --yolo             Approve everything\\n');
else if (mode === 'stderr') { process.stderr.write(help); process.exit(1); }
else process.stdout.write(help);
`);
  return script;
}

function registryFor(mode) {
  const dir = tempDir();
  const runs = path.join(dir, 'runs.txt');
  const child = path.join(dir, 'child.pid');
  const modeFile = path.join(dir, 'mode.txt');
  fs.writeFileSync(runs, '');
  fs.writeFileSync(modeFile, mode);
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{
    id: 'fake', tool: 'Fake', command: process.execPath, args: [fakeTool(dir), 'run'], env: { FAKE_RUNS: runs, FAKE_MODE_FILE: modeFile, FAKE_CHILD: child },
    launchFlags: ['--effort', '--yolo !', '--gone'], launchFlagExamples: { '--effort': 'max' },
  }] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  return {
    registry, provider: registry.get('fake'),
    runs: () => fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean),
    child: () => Number(fs.readFileSync(child, 'utf8')),
    setMode: (next) => fs.writeFileSync(modeFile, next),
  };
}

const names = (result) => result.flags.map((f) => f.flag);

test('the help is read once from the copy that runs, after the provider\'s own args', async () => {
  const { registry, provider, runs } = registryFor('stdout');
  assert.deepEqual(registry.describe(provider).launchFlags, [{ flag: '--effort', risky: false }, { flag: '--yolo', risky: true }, { flag: '--gone', risky: false }]);
  const first = await registry.launchFlags(provider);
  assert.deepEqual(first, { flags: [
    { flag: '--effort', value: 'required', placeholder: '<level>', about: 'Effort level', risky: false, example: 'max' },
    { flag: '--yolo', value: 'none', placeholder: '', about: 'Approve everything', risky: true, example: null },
  ], error: null });
  assert.deepEqual(await registry.launchFlags(provider), first);
  assert.deepEqual(runs(), ['run --help']);
});

test('help printed to stderr by a tool that exits with an error is still read', async () => {
  const { registry, provider } = registryFor('stderr');
  assert.deepEqual(names(await registry.launchFlags(provider)), ['--effort', '--yolo']);
});

test('a failed run that only mentions a flag is an error, tried again until the tool recovers', async () => {
  const tool = registryFor('diagnostic');
  assert.deepEqual(await tool.registry.launchFlags(tool.provider), { flags: [], error: 'Could not read Fake\'s help: error: unexpected argument \'--effort\' found' });
  await tool.registry.launchFlags(tool.provider);
  assert.equal(tool.runs().length, 2, 'the error is not kept');
  tool.setMode('stdout');
  assert.deepEqual(names(await tool.registry.launchFlags(tool.provider)), ['--effort', '--yolo']);
  await tool.registry.launchFlags(tool.provider);
  assert.equal(tool.runs().length, 3, 'the recovered help is kept');
});

test('help that lists none of the offered flags is not kept', async () => {
  const tool = registryFor('usage');
  assert.deepEqual(await tool.registry.launchFlags(tool.provider), { flags: [], error: null });
  await tool.registry.launchFlags(tool.provider);
  assert.equal(tool.runs().length, 2);
});

test('a Docker CLI plugin\'s help is read again each time, one read shared while it runs', async () => {
  const tool = registryFor('stdout');
  const plugin = { ...tool.provider, plugin: 'agent' };
  const [one, two] = await Promise.all([tool.registry.launchFlags(plugin), tool.registry.launchFlags(plugin)]);
  assert.deepEqual([names(one), names(two)], [['--effort', '--yolo'], ['--effort', '--yolo']]);
  assert.equal(tool.runs().length, 1);
  tool.setMode('changed');
  assert.deepEqual(names(await tool.registry.launchFlags(plugin)), ['--yolo', '--gone'], 'a flag the plugin dropped goes, a new one appears');
  assert.equal(tool.runs().length, 2);
  assert.deepEqual(names(await tool.registry.launchFlags(tool.provider)), ['--yolo', '--gone']);
  tool.setMode('stdout');
  assert.deepEqual(names(await tool.registry.launchFlags(tool.provider)), ['--yolo', '--gone'], 'a plain tool keeps its help while its copy is unchanged');
});

test('a help read that fails, hangs or floods says why and is tried again next time, even after printing help', async () => {
  const silent = registryFor('silent');
  const result = await silent.registry.launchFlags(silent.provider);
  assert.deepEqual(result.flags, []);
  assert.match(result.error, /^Could not read Fake's help: /);
  await silent.registry.launchFlags(silent.provider);
  assert.equal(silent.runs().length, 2);

  const hang = registryFor('hang');
  const slow = await new LaunchFlags(hang.registry, { timeoutMs: 1000 }).list(hang.provider);
  assert.deepEqual(slow, { flags: [], error: 'Could not read Fake\'s help: it took longer than 1 second' });
  await gone(hang.child(), 'a help read that timed out');

  const flood = registryFor('flood');
  const big = await new LaunchFlags(flood.registry, { maxBytes: 1024, timeoutMs: 20000 }).list(flood.provider);
  assert.deepEqual(big, { flags: [], error: 'Could not read Fake\'s help: it printed more than 1 KB' });
  await gone(flood.child(), 'a help read that printed too much');
});

async function gone(pid, label) {
  assert.ok(pid > 0, `${label} started a child`);
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  };
  const deadline = Date.now() + 10000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, `${label} leaves no process behind`);
}

test('a provider without launchFlags, or not installed, reads no help', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'bare', command: process.execPath },
    { id: 'missing', tool: 'Missing', command: path.join(dir, 'no-such-tool'), launchFlags: ['--yolo'] },
  ] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  assert.deepEqual(await registry.launchFlags(registry.get('bare')), { flags: [], error: null });
  assert.deepEqual(registry.describe(registry.get('bare')).launchFlags, []);
  assert.deepEqual(await registry.launchFlags(registry.get('missing')), { flags: [], error: 'Missing is not installed.' });
});

test('launch flags follow the reporting hooks and the resume args of every built-in tool', () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: defaults.filter((p) => p.command !== '@shell').map((p) => ({ id: p.id, command: process.execPath })) }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  const flags = ['--model', 'm1', '--yolo'];
  const hooks = { anthropic: ['--plugin-dir', '/bundle'], openai: codexHookArgs(), google: [], xai: [], docker: dockerHookArgs() };
  const resume = { anthropic: ['--resume', 'abc'], openai: ['resume', 'abc'], google: ['--conversation', 'abc'], xai: ['--resume', 'abc'], docker: ['--session', 'abc'] };
  for (const [id, hookArgs] of Object.entries(hooks)) {
    const provider = registry.get(id);
    assert.deepEqual(registry.spawnSpec(provider, flags, null, hookArgs).args, [...provider.args, ...hookArgs, ...flags], `${id} new`);
    assert.deepEqual(registry.spawnSpec(provider, flags, 'abc', hookArgs).args, [...provider.args, ...hookArgs, ...resume[id], ...flags], `${id} resumed`);
  }
});
