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
});

test('launchFlags entries are flags, optionally marked as taking a value', () => {
  const warnings = [];
  assert.deepEqual(normalizeLaunchFlags(['--effort <value>', '--yolo', '-c', '--yolo', 'rm -rf', 7, '--x <other>'], 'p', warnings), [
    { flag: '--effort', value: true }, { flag: '--yolo', value: false }, { flag: '-c', value: false },
  ]);
  assert.equal(warnings.length, 3);
  assert.deepEqual(normalizeLaunchFlags(undefined, 'p', warnings), []);
  assert.deepEqual(normalizeLaunchFlags('--yolo', 'p', warnings), []);
  assert.match(warnings.at(-1), /must be a list/);
  assert.deepEqual(offeredFlags(help('agy'), [{ flag: '--effort', value: false }]).map((f) => f.value), ['none']);
});

function fakeTool(dir) {
  const script = path.join(dir, 'tool.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_RUNS, process.argv.slice(2).join(' ') + '\\n');
const mode = process.env.FAKE_MODE;
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'flood') process.stdout.write('x'.repeat(64 * 1024));
else if (mode === 'silent') process.exit(3);
else {
  const text = 'Usage:\\n  --effort <level>   Effort level\\n  --yolo             Approve everything\\n';
  if (mode === 'stderr') { process.stderr.write(text); process.exit(1); }
  process.stdout.write(text);
}
`);
  return script;
}

function registryFor(mode) {
  const dir = tempDir();
  const runs = path.join(dir, 'runs.txt');
  fs.writeFileSync(runs, '');
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [{
    id: 'fake', tool: 'Fake', command: process.execPath, args: [fakeTool(dir), 'run'], env: { FAKE_RUNS: runs, FAKE_MODE: mode },
    launchFlags: ['--effort', '--yolo', '--gone'],
  }] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  return { registry, provider: registry.get('fake'), runs: () => fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean) };
}

test('the help is read once from the copy that runs, after the provider\'s own args', async () => {
  const { registry, provider, runs } = registryFor('stdout');
  assert.equal(registry.describe(provider).launchFlags, true);
  const first = await registry.launchFlags(provider);
  assert.deepEqual(first, { flags: [{ flag: '--effort', value: 'required', about: 'Effort level' }, { flag: '--yolo', value: 'none', about: 'Approve everything' }], error: null });
  assert.deepEqual(await registry.launchFlags(provider), first);
  assert.deepEqual(runs(), ['run --help']);
});

test('help printed to stderr by a tool that exits with an error is still read', async () => {
  const { registry, provider } = registryFor('stderr');
  assert.deepEqual((await registry.launchFlags(provider)).flags.map((f) => f.flag), ['--effort', '--yolo']);
});

test('a help read that fails, hangs or floods says why and is tried again next time', async () => {
  const silent = registryFor('silent');
  const result = await silent.registry.launchFlags(silent.provider);
  assert.deepEqual(result.flags, []);
  assert.match(result.error, /^Could not read Fake's help: /);
  await silent.registry.launchFlags(silent.provider);
  assert.equal(silent.runs().length, 2);

  const hang = registryFor('hang');
  const slow = await new LaunchFlags(hang.registry, { timeoutMs: 300 }).list(hang.provider);
  assert.equal(slow.error, 'Could not read Fake\'s help: it took longer than 0.3 seconds');

  const flood = registryFor('flood');
  const big = await new LaunchFlags(flood.registry, { maxBytes: 1024 }).list(flood.provider);
  assert.equal(big.error, 'Could not read Fake\'s help: it printed more than 1 KB');
});

test('a provider without launchFlags, or not installed, reads no help', async () => {
  const dir = tempDir();
  const userFile = path.join(dir, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'bare', command: process.execPath },
    { id: 'missing', tool: 'Missing', command: path.join(dir, 'no-such-tool'), launchFlags: ['--yolo'] },
  ] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: path.dirname(process.execPath) }, checkUpdates: false });
  assert.deepEqual(await registry.launchFlags(registry.get('bare')), { flags: [], error: null });
  assert.equal(registry.describe(registry.get('bare')).launchFlags, false);
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
