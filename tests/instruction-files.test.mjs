import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstructionFiles, globPattern, grokInspect, shortLocation } from '../src/manager/instruction-files.mjs';

const account = { id: 'default', env: {} };
const provider = (instructions) => ({ id: instructions, tool: instructions, command: instructions, instructions, env: {} });

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-instructions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text = `${rel}\n`) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const dir = (rel) => fs.mkdirSync(path.join(root, rel), { recursive: true });
  return { root, write, dir, at: (rel) => path.join(root, rel) };
}

/** Each listed file as [path relative to the fixture, scope, skipped reason or null]. */
function rows(listed, root) {
  return listed.scopes.flatMap((s) => s.files.map((f) => [path.relative(root, f.path).replaceAll('\\', '/'), s.id, f.skipped]));
}

test('Claude Code: global files, every folder up the walk, and AGENTS.md only where no CLAUDE.md is found', async (t) => {
  const { root, write, dir, at } = fixture(t);
  write('home/.claude/CLAUDE.md');
  write('home/.claude/rules/style.md');
  write('home/.claude/rules/team/nested.md');
  write('home/.claude/rules/scoped.md', '---\npaths:\n  - "src/**/*.ts"\n---\nonly with a .ts file\n');
  write('home/.claude/settings.json', JSON.stringify({ claudeMdExcludes: ['**/.claude/rules/skip.md', '**/excl/CLAUDE.md'] }));
  write('home/excl/CLAUDE.md');
  write('home/excl/AGENTS.md');
  write('home/proj/AGENTS.md');
  write('home/proj/.claude/AGENTS.md');
  write('outer/CLAUDE.md');
  write('outer/AGENTS.md');
  dir('outer/repo/.git');
  write('outer/repo/CLAUDE.md');
  write('outer/repo/.claude/CLAUDE.md');
  write('outer/repo/CLAUDE.local.md');
  write('outer/repo/.claude/rules/a.md');
  write('outer/repo/.claude/rules/skip.md');
  write('outer/repo/.claude/rules/sub/b.md');
  write('outer/repo/.claude/rules/scoped.md', '---\npaths: src/**/*.ts\n---\n');
  dir('outer/repo/sub');
  const reader = new InstructionFiles({ env: { CLAUDE_CONFIG_DIR: at('home/.claude') }, resolveCwd: (cwd) => cwd, ceiling: root });

  const found = 'Claude Code reads CLAUDE.md instead.';
  const listed = await reader.list(provider('claude'), account, at('outer/repo/sub'));
  assert.deepEqual(rows(listed, root), [
    ['home/.claude/CLAUDE.md', 'global', null],
    ['home/.claude/rules/style.md', 'global', null],
    ['home/.claude/rules/team/nested.md', 'global', null],
    ['outer/CLAUDE.md', 'project', null],
    ['outer/AGENTS.md', 'project', found],
    ['outer/repo/CLAUDE.md', 'project', null],
    ['outer/repo/.claude/CLAUDE.md', 'project', null],
    ['outer/repo/CLAUDE.local.md', 'project', null],
    ['outer/repo/.claude/rules/a.md', 'project', null],
    ['outer/repo/.claude/rules/skip.md', 'project', 'Excluded in Claude Code settings.'],
    ['outer/repo/.claude/rules/sub/b.md', 'project', null],
  ], 'the walk passes the repo root; a CLAUDE.md anywhere skips every AGENTS.md; claudeMdExcludes matches dot folders; rules folders are read recursively; a paths: rule waits for a matching file');
  assert.equal(listed.count, 9);

  const plain = await reader.list(provider('claude'), account, at('home/proj'));
  assert.deepEqual(rows(plain, root), [
    ['home/.claude/CLAUDE.md', 'global', null],
    ['home/.claude/rules/style.md', 'global', null],
    ['home/.claude/rules/team/nested.md', 'global', null],
    ['home/proj/AGENTS.md', 'project', null],
    ['home/proj/.claude/AGENTS.md', 'project', null],
  ], 'a global CLAUDE.md, met again on the walk through home, does not skip AGENTS.md');

  const excluded = await reader.list(provider('claude'), account, at('home/excl'));
  assert.deepEqual(rows(excluded, root).slice(3), [
    ['home/excl/CLAUDE.md', 'project', 'Excluded in Claude Code settings.'],
    ['home/excl/AGENTS.md', 'project', null],
  ], 'an excluded CLAUDE.md does not skip AGENTS.md');
});

test('a row\'s location starts from a folder name near the working folder, else from home', () => {
  const at = (file, folder = 'C:\\Users\\me\\src\\app\\web') => shortLocation(file, folder, 'C:\\Users\\me', path.win32);
  assert.equal(at('C:\\Users\\me\\src\\app\\web\\CLAUDE.md'), 'web');
  assert.equal(at('C:\\Users\\me\\src\\app\\web\\.claude\\rules\\a.md'), 'web\\.claude\\rules');
  assert.equal(at('C:\\Users\\me\\src\\app\\.claude\\rules\\b.md'), 'app\\.claude\\rules');
  assert.equal(at('C:\\Users\\me\\.claude\\CLAUDE.md'), '~\\.claude');
  assert.equal(at('D:\\shared\\CLAUDE.md'), 'D:\\shared');
});

test('claudeMdExcludes globs match as picomatch does with dot: true', () => {
  const match = (glob, file) => globPattern(glob).test(file);
  assert.ok(match('**/CLAUDE.md', 'CLAUDE.md') && match('**/CLAUDE.md', 'E:/a/b/CLAUDE.md'));
  assert.ok(match('/a/*/CLAUDE.md', '/a/.hidden/CLAUDE.md'), 'dot: true');
  assert.ok(!match('/a/*/CLAUDE.md', '/a/b/c/CLAUDE.md'), '* stays in one folder');
  assert.ok(match('/a/{x,y}/CLAUDE.local.md', '/a/y/CLAUDE.local.md') && !match('/a/{x,y}/CLAUDE.md', '/a/z/CLAUDE.md'));
});

test('Codex: one global file, one file per folder from the marker root down, within project_doc_max_bytes', async (t) => {
  const { root, write, dir, at } = fixture(t);
  write('codex/AGENTS.override.md', '  \n');
  write('codex/AGENTS.md');
  write('codex/config.toml', [
    'project_root_markers = [".hg"]',
    'project_doc_fallback_filenames = [',
    '  "TEAM.txt",',
    ']',
    'project_doc_max_bytes = 10',
    '[features]',
    'project_doc_max_bytes = 1',
  ].join('\n'));
  write('above/AGENTS.md');
  dir('above/repo/.hg');
  write('above/repo/AGENTS.override.md', '12345678\n');
  write('above/repo/AGENTS.md');
  dir('above/repo/sub/.git');
  write('above/repo/sub/TEAM.txt', 'abcdef\n');
  write('above/repo/sub/leaf/AGENTS.md');
  const reader = new InstructionFiles({ env: { CODEX_HOME: at('codex') }, resolveCwd: (cwd) => cwd });

  const listed = await reader.list(provider('codex'), account, at('above/repo/sub/leaf'));
  assert.deepEqual(rows(listed, root), [
    ['codex/AGENTS.override.md', 'global', 'Empty, so Codex reads AGENTS.md instead.'],
    ['codex/AGENTS.md', 'global', null],
    ['above/repo/AGENTS.override.md', 'project', null],
    ['above/repo/AGENTS.md', 'project', 'Codex reads AGENTS.override.md instead.'],
    ['above/repo/sub/TEAM.txt', 'project', null],
    ['above/repo/sub/leaf/AGENTS.md', 'project', 'Past Codex’s limit for project files (10 bytes).'],
  ], 'nothing above the .hg marker; .git is no marker once markers are set; a fallback name loads; the budget runs out');
  assert.equal(listed.scopes[1].files[2].note, 'Codex reads only the first 1 byte, its limit for project files.');

  write('untrusted/config.toml', `[projects.'${at('above/repo')}']\ntrust_level = "untrusted"\n`);
  write('untrusted/AGENTS.md');
  const work = { id: 'work', env: { CODEX_HOME: at('untrusted') } };
  const untrusted = await reader.list(provider('codex'), work, at('above/repo'));
  assert.deepEqual(rows(untrusted, root), [['untrusted/AGENTS.md', 'global', null]], 'each account reads its own CODEX_HOME');
  assert.match(untrusted.scopes[1].note, /marks the folder untrusted/);
});

test('Grok Build: grok inspect decides, with the account\'s GROK_HOME, real file names and a trust note', async (t) => {
  const { root, write, at } = fixture(t);
  write('grok/AGENTS.md');
  write('proj/AGENTS.md');
  const calls = [];
  let report = null;
  const inspect = async (command, cwd, env) => {
    calls.push([command, cwd, env.GROK_HOME]);
    if (report instanceof Error) throw report;
    return report;
  };
  const reader = new InstructionFiles({ env: {}, resolveCwd: (cwd) => cwd, inspect });
  const work = { id: 'work', env: { GROK_HOME: at('grok') } };
  const caseless = fs.existsSync(at('proj/agents.md'));
  report = { projectTrusted: true, projectInstructions: [
    { path: at(caseless ? 'proj/Agents.md' : 'proj/AGENTS.md'), scope: 'project' },
    { path: at('grok/AGENTS.md'), scope: 'global' },
  ] };
  const listed = await reader.list(provider('grok'), work, at('proj'));
  assert.deepEqual(calls, [['grok', at('proj'), at('grok')]]);
  assert.deepEqual(rows(listed, root), [['grok/AGENTS.md', 'global', null], ['proj/AGENTS.md', 'project', null]],
    'global first, and the name as it is on disk, not as Grok Build looked for it');

  report = { projectTrusted: false, projectInstructions: [{ path: at('grok/AGENTS.md'), scope: 'global' }] };
  const untrusted = await reader.list(provider('grok'), work, at('proj'));
  assert.equal(untrusted.count, 1);
  assert.match(untrusted.scopes[1].note, /until you trust the folder/);

  report = new Error('grok inspect did not answer within 3 seconds.');
  const failed = await reader.list(provider('grok'), work, at('proj'));
  assert.deepEqual([failed.count, failed.note, failed.scopes], [null, 'grok inspect did not answer within 3 seconds.', []]);
  await assert.rejects(grokInspect('grok', root, { PATH: '' }), /couldn’t be found/);
});

test('Antigravity CLI: all global names, both names per folder up to the repo root, always_on rules, links once', async (t) => {
  const { root, write, dir, at } = fixture(t);
  for (const rel of ['GEMINI.md', 'AGENTS.md', 'config/GEMINI.md', 'config/AGENTS.md']) write(`home/.gemini/${rel}`);
  write('home/.gemini/config/rules/on.md', '---\ntrigger: always_on\n---\nalways\n');
  write('home/.gemini/config/rules/model.md', '---\ntrigger: model_decision\n---\nsometimes\n');
  write('above/GEMINI.md');
  dir('above/repo/.git');
  write('above/repo/GEMINI.md');
  write('above/repo/AGENTS.md');
  write('above/repo/.agents/rules/on.md', '---\ntrigger: "always_on"\n---\n');
  write('above/repo/_agent/rules/plain.md', 'no frontmatter\n');
  write('above/repo/sub/AGENTS.md');
  fs.symlinkSync(at('above/repo/.agents'), at('above/repo/sub/.agent'), 'junction');
  const home = at('home');
  const reader = new InstructionFiles({ env: { USERPROFILE: home, HOME: home }, resolveCwd: (cwd) => cwd });

  const listed = await reader.list(provider('google'), account, at('above/repo/sub'));
  assert.deepEqual(rows(listed, root), [
    ['home/.gemini/GEMINI.md', 'global', null],
    ['home/.gemini/AGENTS.md', 'global', null],
    ['home/.gemini/config/GEMINI.md', 'global', null],
    ['home/.gemini/config/AGENTS.md', 'global', null],
    ['home/.gemini/config/rules/on.md', 'global', null],
    ['above/repo/GEMINI.md', 'project', null],
    ['above/repo/AGENTS.md', 'project', null],
    ['above/repo/.agents/rules/on.md', 'project', null],
    ['above/repo/sub/AGENTS.md', 'project', null],
  ], 'nothing above the repo root, no rule without trigger: always_on, and a linked rule once');

  write('nogit/GEMINI.md');
  write('nogit/child/GEMINI.md');
  const outside = await reader.list(provider('google'), account, at('nogit/child'));
  assert.deepEqual(rows(outside, root).filter(([, scope]) => scope === 'project'), [['nogit/child/GEMINI.md', 'project', null]],
    'outside a repository only the working folder is read');
});

test('a file opens by its index in a fresh list, only while that entry is still the same markdown file', async (t) => {
  const { write, dir, at } = fixture(t);
  dir('repo/.git');
  write('repo/AGENTS.md', 'agents\n');
  write('repo/TEAM.txt', 'team\n');
  write('codex/config.toml', 'project_doc_fallback_filenames = ["TEAM.txt"]\n');
  write('codex/AGENTS.md', 'global\n');
  const reader = new InstructionFiles({ env: { CODEX_HOME: at('codex') }, resolveCwd: (cwd) => cwd });
  const codex = provider('codex');
  const read = await reader.read(codex, account, at('repo'), '1', at('repo/AGENTS.md'));
  assert.deepEqual([read.path, read.text], [at('repo/AGENTS.md'), 'agents\n']);
  await assert.rejects(reader.read(codex, account, at('repo'), '0', at('repo/AGENTS.md')), { code: 'instruction_file_gone' }, 'a path that is not the entry at that index');
  await assert.rejects(reader.read(codex, account, at('repo'), '1', at('codex/config.toml')), { code: 'instruction_file_gone' });
  fs.rmSync(at('repo/AGENTS.md'));
  await assert.rejects(reader.read(codex, account, at('repo'), '1', at('repo/AGENTS.md')), { code: 'instruction_file_gone' });
  await assert.rejects(reader.read(codex, account, at('repo'), '1', at('repo/TEAM.txt')), { code: 'bad_instruction_path' }, 'only markdown opens');
});
