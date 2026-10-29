import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PAGE_LIMITS, JSONL_READERS, readJsonlPage, readDockerConversation, checkedFile } from '../src/manager/history-transcripts.mjs';
import { SessionHistory, FileMemo, listClaudeSessions, listCodexSessions, listGrokSessions } from '../src/manager/session-history.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createCardNames } from '../src/manager/card-names.mjs';

// Synthetic records shaped like Claude Code 2.1.312, Codex CLI 0.165.0, Grok Build 1.0.70 and Docker Agent 1.154.0 write them.
const lines = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-readers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const read = (source, file, cursor = null, limits = PAGE_LIMITS) => readJsonlPage({ source, id: 'conversation', file, cursor, limits, ...JSONL_READERS[source] });

async function readAll(source, file, limits) {
  const pages = [];
  let cursor = null;
  do {
    const page = await read(source, file, cursor, limits);
    pages.unshift(page);
    cursor = page.nextCursor;
    assert.ok(pages.length < 200, 'the pages end');
  } while (cursor);
  return { pages, messages: pages.flatMap((p) => p.messages), omitted: pages.some((p) => p.omitted) };
}

const said = (messages) => messages.map((m) => `${m.role === 'user' ? 'You' : 'AI'}: ${m.text}`);

// ---- Claude Code ------------------------------------------------------------------

function claudeTranscript() {
  let last = null;
  const at = (record) => {
    const r = { parentUuid: last, sessionId: 's', ...record };
    last = r.uuid;
    return r;
  };
  const prompt = (uuid, content, extra = {}) => at({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
  const reply = (uuid, id, content) => at({ type: 'assistant', uuid, message: { id, role: 'assistant', content } });
  return [
    { type: 'file-history-snapshot', messageId: 'x' },
    prompt('c1', 'First prompt'),
    reply('c2', 'm1', [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Reply one' }]),
    reply('c3', 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    prompt('c4', [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }]),
    reply('c5', 'm2', [{ type: 'text', text: 'Reply two' }]),
    prompt('c6', 'Caveat inserted by the tool', { isMeta: true }),
    prompt('c7', '<command-name>/model</command-name>'),
    prompt('c8', [{ type: 'text', text: '[Request interrupted by user]' }]),
    // Rewound away: a branch from c5 that the live conversation does not continue.
    { type: 'user', uuid: 'b1', parentUuid: 'c5', message: { role: 'user', content: 'Discarded prompt' } },
    { type: 'assistant', uuid: 'b2', parentUuid: 'b1', message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Discarded reply' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'k1', parentUuid: null, logicalParentUuid: 'c8' },
    { type: 'user', uuid: 'k2', parentUuid: 'k1', isCompactSummary: true, message: { role: 'user', content: 'Summary of the earlier conversation' } },
    { type: 'user', uuid: 'd1', parentUuid: 'k2', message: { role: 'user', content: 'Second prompt' } },
    { type: 'assistant', uuid: 'd2', parentUuid: 'd1', message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'Second reply' }] } },
    { type: 'user', uuid: 's1', parentUuid: 'd2', isSidechain: true, message: { role: 'user', content: 'Sub-agent prompt' } },
    { type: 'assistant', uuid: 'd3', parentUuid: 'd2', message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'continued' }] } },
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: 's' },
    { type: 'last-prompt', lastPrompt: 'Second prompt', leafUuid: 'd3', sessionId: 's' },
  ];
}

const claudeConversation = ['You: First prompt', 'AI: Reply one', 'AI: Reply two', 'You: Second prompt', 'AI: Second reply\n\ncontinued'];

test('Claude Code previews follow the resumed chain: no thinking, tools, inserted text, sub-agents or rewound branches', async (t) => {
  const file = write(path.join(tempDir(t), 'c.jsonl'), lines(...claudeTranscript()));
  const page = await read('claude', file);
  assert.deepEqual(said(page.messages), claudeConversation);
  assert.deepEqual([page.nextCursor, page.incomplete, page.omitted], [null, false, false]);
});

test('every page holds whole messages, however small the pages and reads', async (t) => {
  const file = write(path.join(tempDir(t), 'c.jsonl'), lines(...claudeTranscript()));
  for (const limits of [{ ...PAGE_LIMITS, messages: 1, chunkBytes: 17 }, { ...PAGE_LIMITS, scanBytes: 1, chunkBytes: 64 }]) {
    const { pages, messages, omitted } = await readAll('claude', file, limits);
    assert.ok(pages.length > 2);
    assert.equal(omitted, false);
    assert.deepEqual(said(messages), claudeConversation, JSON.stringify(limits));
  }
});

test('a message longer than a page can read is left out whole, never cut', async (t) => {
  const records = claudeTranscript();
  const bulk = { type: 'user', uuid: 'r1', parentUuid: 'd2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(5000) }] } };
  const at = records.findIndex((r) => r.uuid === 'd3');
  records.splice(at, 1, bulk, { ...records[at], parentUuid: 'r1' });
  const file = write(path.join(tempDir(t), 'c.jsonl'), lines(...records));
  const { messages, omitted } = await readAll('claude', file, { ...PAGE_LIMITS, maxScanBytes: 2000, chunkBytes: 512 });
  assert.equal(omitted, true);
  assert.deepEqual(said(messages), claudeConversation.slice(0, 4), 'the reply that spans the bulk is gone, not split');
});

test('an oversized Claude record keeps the chain and leaves out only the message it belongs to', async (t) => {
  const records = claudeTranscript();
  const big = 'x'.repeat(3000);
  records.find((r) => r.uuid === 'c4').message.content[0].content = big;
  records.find((r) => r.uuid === 'd3').message.content[0].text = big;
  const file = write(path.join(tempDir(t), 'c.jsonl'), lines(...records));
  const limits = { ...PAGE_LIMITS, maxLineBytes: 2000, chunkBytes: 512 };
  const page = await read('claude', file, null, limits);
  assert.deepEqual(said(page.messages), ['You: First prompt', 'AI: Reply one', 'AI: Reply two', 'You: Second prompt'], 'the reply with an unreadable part is left out whole');
  assert.deepEqual([page.omitted, page.nextCursor], [true, null]);
});

test('a corrupt Claude chain record ends the conversation there, without the reply that depended on it', async (t) => {
  const records = claudeTranscript();
  const at = records.findIndex((r) => r.uuid === 'd2');
  const text = lines(...records).split('\n').map((line, i) => (i === at ? `${line.slice(0, 40)}` : line)).join('\n');
  const file = write(path.join(tempDir(t), 'c.jsonl'), text);
  const page = await read('claude', file);
  assert.deepEqual([said(page.messages), page.omitted, page.nextCursor], [[], true, null], 'nothing older is joined to the newest reply');
});

test('an oversized Grok Build chunk leaves out its whole reply, and a corrupt record ends the readable history', async (t) => {
  const dir = tempDir(t);
  const limits = { ...PAGE_LIMITS, maxLineBytes: 2000, chunkBytes: 512 };
  const oversized = write(path.join(dir, 'oversized.jsonl'), lines(grok.user('first', 0), grok.agent('First reply'), grok.user('second', 1), grok.agent('Sec'), grok.agent('y'.repeat(3000)), grok.agent('ond')));
  const page = await read('grok', oversized, null, limits);
  assert.deepEqual([said(page.messages), page.omitted], [['You: first', 'AI: First reply', 'You: second'], true]);
  const torn = '{"method":"_x.ai/session/upd\n';
  const adjacent = write(path.join(dir, 'adjacent.jsonl'), lines(grok.user('first', 0), grok.agent('First reply')) + torn + lines(grok.user('second', 1), grok.agent('Second reply')));
  const unsure = await read('grok', adjacent);
  assert.deepEqual([said(unsure.messages), unsure.omitted, unsure.nextCursor], [[], true, null], 'the record may have been part of the prompt after it');
  const separate = write(path.join(dir, 'separate.jsonl'), lines(grok.user('first', 0), grok.agent('First reply')) + torn + lines(grok.done(), grok.user('second', 1), grok.agent('Second reply')));
  const after = await read('grok', separate);
  assert.deepEqual([said(after.messages), after.omitted, after.nextCursor], [['You: second', 'AI: Second reply'], true, null], 'a record that may have been a rewind is never guessed past');
});

test('Read earlier moves past a compressed record larger than a page can read, and never returns the same page', { skip: typeof zlib.zstdCompressSync !== 'function' }, async (t) => {
  const dir = tempDir(t);
  const message = (n, text = `message ${n}`) => ({ type: 'event_msg', payload: { type: n % 2 ? 'agent_message' : 'user_message', message: text } });
  const text = lines(message(0), message(1), message(2, 'z'.repeat(2 * 1024 * 1024)), message(3), message(4));
  const file = path.join(dir, 'rollout.jsonl.zst');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text)));
  const decodedCopies = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('agent-guild-rollout-')).length;
  const copies = decodedCopies();
  const { messages, omitted } = await readAll('codex', file, { ...PAGE_LIMITS, messages: 1, maxLineBytes: 10000, maxScanBytes: 12000, chunkBytes: 1000 });
  assert.deepEqual([messages.map((m) => m.text), omitted], [['message 0', 'message 1', 'message 3', 'message 4'], true]);
  const broken = write(path.join(dir, 'broken.jsonl.zst'), 'not zstd');
  await assert.rejects(read('codex', broken), { code: 'history_unavailable', status: 404 });
  assert.equal(decodedCopies(), copies, 'no decoded copy is left behind after a read or a failure');
});

test('a Claude title set after the last listing replaces the cached one, in a short or a long transcript', async (t) => {
  for (const filler of [0, 300 * 1024]) {
    const dir = tempDir(t);
    const file = path.join(dir, 'projects', '-w', 'aaaa-1.jsonl');
    write(file, lines({ type: 'user', cwd: '/w', message: { role: 'user', content: 'Prompt' } }, { type: 'custom-title', customTitle: 'First name' },
      ...(filler ? [{ type: 'user', isMeta: true, message: { role: 'user', content: 'f'.repeat(filler) } }] : [])));
    const memo = new FileMemo();
    assert.equal((await listClaudeSessions(dir, memo))[0].title, 'First name');
    fs.appendFileSync(file, lines({ type: 'custom-title', customTitle: 'Second name' }));
    assert.equal((await listClaudeSessions(dir, memo))[0].title, 'Second name', `filler ${filler}`);
    fs.appendFileSync(file, lines({ type: 'user', isMeta: true, message: { role: 'user', content: 'g'.repeat(filler ? 400 * 1024 : 10) } }));
    assert.equal((await listClaudeSessions(dir, memo))[0].title, 'Second name', 'a title pushed out of the end window is kept');
  }
});

test('prompts are told apart by each tool\'s own markers, never by leading markup, in previews and titles', async (t) => {
  const dir = tempDir(t);
  const pasted = '<pasted_content id="p1">Fix the spacing</pasted_content>';
  const claudeHome = path.join(dir, 'claude');
  const claude = write(path.join(claudeHome, 'projects', '-w', 'aaaa-1.jsonl'), lines(
    { type: 'user', uuid: 'u1', parentUuid: null, cwd: '/w', origin: { kind: 'human' }, message: { role: 'user', content: pasted } },
    { type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Spaced' }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'u2', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'Background task finished' } },
    { type: 'user', uuid: 'u4', parentUuid: 'u3', message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', uuid: 'u5', parentUuid: 'u4', message: { role: 'user', content: 'Legacy prompt' } },
  ));
  assert.deepEqual(said((await read('claude', claude)).messages), [`You: ${pasted}`, 'AI: Spaced', 'You: Legacy prompt']);
  assert.equal((await listClaudeSessions(claudeHome))[0].title, pasted);

  const codex = write(path.join(dir, 'rollout.jsonl'), lines(
    { type: 'session_meta', payload: { id: 'c1', cwd: '/w', timestamp: '2026-10-29T00:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<task>Review the change</task>' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Reviewed' } },
  ));
  assert.deepEqual(said((await read('codex', codex)).messages), ['You: <task>Review the change</task>', 'AI: Reviewed']);
  const codexHome = path.join(dir, 'codex');
  write(path.join(codexHome, 'sessions', '2026', '10', '29', 'rollout-2026-10-29T00-00-00-c1.jsonl'), fs.readFileSync(codex, 'utf8'));
  assert.equal((await listCodexSessions(codexHome))[0].title, '<task>Review the change</task>');

  const reminder = grok.user('<system-reminder>Background task completed</system-reminder>', 1);
  reminder.params.update._meta.hideFromScrollback = true;
  const grokHome = path.join(dir, 'grok');
  const session = path.join(grokHome, 'sessions', encodeURIComponent('/w'), 'g1');
  const updates = write(path.join(session, 'updates.jsonl'), lines(grok.user('<div>Fix the spacing</div>', 0), grok.agent('Spaced'), grok.done(), reminder, grok.agent('Noted')));
  write(path.join(session, 'summary.json'), JSON.stringify({ info: { id: 'g1', cwd: '/w' }, created_at: '2026-10-29T00:00:00Z', num_messages: 4 }));
  assert.deepEqual(said((await read('grok', updates)).messages), ['You: <div>Fix the spacing</div>', 'AI: Spaced', 'AI: Noted']);
  assert.equal((await listGrokSessions(grokHome))[0].title, '<div>Fix the spacing</div>');
});

test('a Claude page that ends before the newest message is found still finds it on the next page', async (t) => {
  const records = claudeTranscript();
  for (let n = 0; n < 6; n++) records.push({ type: 'file-history-snapshot', messageId: `x${n}`, snapshot: 'f'.repeat(200) });
  const file = write(path.join(tempDir(t), 'c.jsonl'), lines(...records));
  const { pages, messages } = await readAll('claude', file, { ...PAGE_LIMITS, scanBytes: 300 });
  assert.equal(pages.at(-1).messages.length, 0, 'the first page only reaches the trailing records');
  assert.deepEqual(said(messages), claudeConversation);
});

test('a card name that could not be saved is saved on the next change once the names file can be read', async (t) => {
  const file = path.join(tempDir(t), 'card-names.json');
  fs.writeFileSync(file, 'not json');
  const cardNames = createCardNames(file, { warn: () => {} });
  const manager = new SessionManager({ registry: null, baseEnv: {}, getApiUrl: () => '', cardNames });
  const session = { task: null, toolSessionId: 'tool-1', resume: null, account: null, provider: { id: 'anthropic' }, named: true, name: 'Login fix' };
  manager._keepCardName(session);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
  fs.unlinkSync(file);
  manager._keepCardName(session);
  assert.equal(createCardNames(file).get('anthropic', 'default', 'tool-1'), 'Login fix');
});

test('appends keep a cursor; a rewrite, truncation or replacement under it refuses it', async (t) => {
  const records = Array.from({ length: 6 }, (_, n) => ({ type: 'event_msg', payload: { type: n % 2 ? 'agent_message' : 'user_message', message: `message ${n}` } }));
  const file = write(path.join(tempDir(t), 'rollout.jsonl'), lines(...records));
  const limits = { ...PAGE_LIMITS, messages: 2 };
  const first = await read('codex', file, null, limits);
  assert.deepEqual(first.messages.map((m) => m.text), ['message 4', 'message 5']);
  fs.appendFileSync(file, lines({ type: 'event_msg', payload: { type: 'user_message', message: 'message 6' } }) + '{"type":"event_msg","pay');
  const second = await read('codex', file, first.nextCursor, limits);
  assert.deepEqual(second.messages.map((m) => m.text), ['message 2', 'message 3']);
  const fresh = await read('codex', file, null, limits);
  assert.deepEqual([fresh.messages.map((m) => m.text), fresh.incomplete], [['message 5', 'message 6'], true], 'a partial record waits');
  const text = fs.readFileSync(file, 'utf8');
  for (const [label, next] of [
    ['rewritten', text.replace('message 2', 'message X')],
    ['truncated', text.slice(0, text.indexOf('message 3'))],
    ['replaced', lines({ type: 'session_meta', payload: { id: 'other' } }) + text],
  ]) {
    fs.writeFileSync(file, next);
    await assert.rejects(read('codex', file, second.nextCursor, limits), { code: 'history_changed', status: 409 }, label);
  }
  await assert.rejects(read('codex', file, 'not-a-cursor'), { code: 'bad_history_cursor' });
  await assert.rejects(read('grok', file, second.nextCursor), { code: 'bad_history_cursor' }, 'a cursor belongs to its own tool');
});

// ---- Codex CLI ----------------------------------------------------------------------

test('Codex previews read either message format once, leave out inserted context and rolled-back turns', async (t) => {
  const dir = tempDir(t);
  const item = (type, text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } } });
  const current = write(path.join(dir, 'new.jsonl'), lines(
    { type: 'session_meta', payload: { id: 'a' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] } },
    item('UserMessage', 'Fix it'),
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'private' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', input: 'ls' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed' }] } },
    item('AgentMessage', 'Fixed'),
    item('Reasoning', 'private'),
  ));
  assert.deepEqual(said((await read('codex', current)).messages), ['You: Fix it', 'AI: Fixed']);
  const legacy = write(path.join(dir, 'old.jsonl'), lines(
    { type: 'session_meta', payload: { id: 'b' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'One' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Reply one' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Two' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Reply two' } },
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Three' } },
  ));
  assert.deepEqual(said((await read('codex', legacy)).messages), ['You: One', 'AI: Reply one', 'You: Three']);
  const paged = await readAll('codex', legacy, { ...PAGE_LIMITS, messages: 1 });
  assert.deepEqual(said(paged.messages), ['You: One', 'AI: Reply one', 'You: Three'], 'a rollback carries across pages');
});

test('a corrupt Codex record is skipped as Codex skips it on resume, and older messages stay readable', async (t) => {
  const message = (n) => ({ type: 'event_msg', payload: { type: n % 2 ? 'agent_message' : 'user_message', message: `message ${n}` } });
  const file = write(path.join(tempDir(t), 'rollout.jsonl'), lines(message(0), message(1)) + '{"type":"event_msg","payl\n' + lines(message(2), message(3)));
  const { messages, omitted } = await readAll('codex', file, { ...PAGE_LIMITS, messages: 1 });
  assert.deepEqual([messages.map((m) => m.text), omitted], [['message 0', 'message 1', 'message 2', 'message 3'], true]);
});

test('a compressed Codex rollout reads the same, and a cursor survives the switch to and from compression', { skip: typeof zlib.zstdCompressSync !== 'function' }, async (t) => {
  const dir = tempDir(t);
  const text = lines(...Array.from({ length: 40 }, (_, n) => ({ type: 'event_msg', payload: { type: n % 2 ? 'agent_message' : 'user_message', message: `message ${n} ${'z'.repeat(300)}` } })));
  const plain = write(path.join(dir, 'rollout.jsonl'), text);
  const limits = { ...PAGE_LIMITS, messages: 5, chunkBytes: 1000 };
  const first = await read('codex', plain, null, limits);
  fs.writeFileSync(`${plain}.zst`, zlib.zstdCompressSync(Buffer.from(text)));
  fs.unlinkSync(plain);
  const second = await read('codex', plain, first.nextCursor, limits);
  assert.equal(second.messages[0].text.split(' ')[1], '30');
  const all = await readAll('codex', `${plain}.zst`, limits);
  assert.equal(all.messages.length, 40);
  fs.writeFileSync(plain, text);
  fs.unlinkSync(`${plain}.zst`);
  assert.deepEqual(await read('codex', `${plain}.zst`, second.nextCursor, limits), await read('codex', plain, second.nextCursor, limits));
});

// ---- Grok Build -----------------------------------------------------------------------

const grok = {
  user: (text, promptIndex, extra = {}) => ({ method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text, ...extra }, _meta: { modelId: 'grok-4.7', ...(promptIndex === undefined ? {} : { promptIndex }) } }, _meta: {} } }),
  agent: (text, promptId = 'p') => ({ method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, _meta: { promptId } } }),
  thought: (text) => ({ method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } } }),
  tool: () => ({ method: 'session/update', params: { sessionId: 'g', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'ls', rawInput: { secret: true } } } }),
  done: () => ({ method: '_x.ai/session/update', params: { sessionId: 'g', update: { sessionUpdate: 'turn_completed', prompt_id: 'p', stop_reason: 'end_turn' } } }),
  rewind: (target) => ({ method: '_x.ai/session/update', params: { sessionId: 'g', update: { sessionUpdate: 'rewind_marker', target_prompt_index: target, created_at: '2026-10-29T13:11:42Z' } } }),
};

test('Grok Build previews join chunks, split replies at tool calls and leave out turns a rewind discarded', async (t) => {
  // As Grok Build 1.0.70 wrote it: three prompts, a rewind to the second, then a new second prompt.
  const file = write(path.join(tempDir(t), 'updates.jsonl'), lines(
    grok.user('Reply with ', 0), grok.user('alpha', 0), grok.thought('thinking'), grok.agent('Al'), grok.agent('pha'), grok.tool(), grok.agent('After the tool'), grok.done(),
    grok.user('!ls', 1, { _meta: { bash_command: true } }), grok.done(),
    grok.user('bravo', 1), grok.agent('Bravo'), grok.done(),
    grok.user('charlie', 2), grok.agent('Charlie'), grok.done(),
    grok.rewind(1),
    grok.user('delta', 1), grok.agent('Delta'), grok.done(),
  ));
  const expected = ['You: Reply with alpha', 'AI: Alpha', 'AI: After the tool', 'You: delta', 'AI: Delta'];
  assert.deepEqual(said((await read('grok', file)).messages), expected);
  assert.deepEqual(said((await readAll('grok', file, { ...PAGE_LIMITS, messages: 1, chunkBytes: 50 })).messages), expected, 'the rewind carries across pages');
});

test('a Grok Build turn that a rewind may cover but has no prompt index cannot be shown', async (t) => {
  const file = write(path.join(tempDir(t), 'updates.jsonl'), lines(grok.user('old', undefined), grok.agent('Old reply'), grok.rewind(0), grok.user('new', 0), grok.agent('New reply')));
  await assert.rejects(read('grok', file), { code: 'history_unavailable', status: 404 });
});

// ---- Docker Agent ------------------------------------------------------------------------

async function dockerStore(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('SQLite is unavailable on this Node version'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-readers-'));
  const db = new DatabaseSync(path.join(dir, 'session.db'));
  // Windows keeps an open database's folder.
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Only the columns Docker Agent 1.154.0's session_items has that the preview reads.
  db.exec(`CREATE TABLE session_items (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, position INTEGER NOT NULL,
    item_type TEXT NOT NULL, message_json TEXT, implicit BOOLEAN DEFAULT 0, subsession_id TEXT)`);
  const insert = db.prepare('INSERT INTO session_items (session_id, position, item_type, message_json, implicit, subsession_id) VALUES (?, ?, ?, ?, ?, ?)');
  const add = (position, message, { type = 'message', implicit = 0, sub = null, session = 's1' } = {}) => insert.run(session, position, type, message && JSON.stringify(message), implicit, sub);
  return { dir, db, add };
}

test('Docker Agent previews show what Docker Agent shows the user, paged by position', async (t) => {
  const store = await dockerStore(t);
  if (!store) return;
  const { dir, db, add } = store;
  add(0, { role: 'user', content: 'List the files' });
  add(1, { role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name: 'list_directory' } }] });
  add(2, { role: 'tool', content: 'secret listing', tool_call_id: 't' });
  add(3, { role: 'assistant', content: 'Here they are' });
  add(4, { role: 'user', content: 'Injected reminder' }, { implicit: 1 });
  add(5, { message: 'model failed', code: 'model_error' }, { type: 'error' });
  add(6, { role: 'assistant', content: 'Sub-agent reply' }, { sub: 's2' });
  add(7, { role: 'user', content: 'Thanks' });
  add(8, { role: 'assistant', content: 'You are welcome' });
  add(0, { role: 'user', content: 'Another session' }, { session: 's2' });
  const loadSqlite = () => import('node:sqlite');
  const page = (cursor, limits = PAGE_LIMITS) => readDockerConversation({ dir, id: 's1', cursor, loadSqlite, limits });
  assert.deepEqual(said((await page()).messages), ['You: List the files', 'AI: Here they are', 'You: Thanks', 'AI: You are welcome']);
  const limits = { ...PAGE_LIMITS, messages: 2 };
  const first = await page(null, limits);
  assert.deepEqual(said(first.messages), ['You: Thanks', 'AI: You are welcome']);
  const second = await page(first.nextCursor, limits);
  assert.deepEqual([said(second.messages), second.nextCursor], [['You: List the files', 'AI: Here they are'], null]);
  db.exec("DELETE FROM session_items WHERE session_id = 's1' AND position <= 4");
  add(3, { role: 'user', content: 'Rewritten' });
  add(4, { role: 'assistant', content: 'Rewritten reply' });
  await assert.rejects(page(first.nextCursor, limits), { code: 'history_changed', status: 409 });
});

// ---- detail, names and search ---------------------------------------------------------------

test('a preview reads only the file its listing found, inside the tool\'s folder and not through a link', async (t) => {
  const home = tempDir(t);
  const project = path.join(home, 'projects', '-work');
  write(path.join(project, 'aaaa-1.jsonl'), lines({ type: 'user', uuid: 'u1', parentUuid: null, cwd: '/work', message: { role: 'user', content: 'Listed prompt' } }));
  const outside = write(path.join(home, 'outside.jsonl'), lines({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Outside' } }));
  const provider = { id: 'anthropic', history: 'claude', env: {} };
  const account = { id: 'default', env: { CLAUDE_CONFIG_DIR: home } };
  const history = new SessionHistory({ registry: {}, env: {} });
  assert.deepEqual(said((await history.detail(provider, account, 'aaaa-1')).messages), ['You: Listed prompt']);
  await assert.rejects(history.detail(provider, account, '../outside'), { code: 'history_unavailable', status: 404 }, 'an id never becomes a path');
  await assert.rejects(history.detail(provider, account, 'a\nb'), { code: 'bad_history_id', status: 400 });
  await assert.rejects(checkedFile(path.join(home, 'projects'), outside), { code: 'history_unavailable' });
  const linked = path.join(home, 'projects', 'linked');
  fs.symlinkSync(project, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkedFile(path.join(home, 'projects'), path.join(linked, 'aaaa-1.jsonl')), { code: 'history_unavailable' });
});

test('History lists the name given to a card ahead of the tool\'s title, and search matches it without reading transcripts', async (t) => {
  const names = createCardNames();
  names.set('custom', 'default', 'two', 'Login fix');
  let reads = 0;
  const history = new SessionHistory({ registry: {}, env: {}, ttlMs: Infinity, names, readers: {
    claude: async () => { reads++; return [{ id: 'one', title: 'Tool title one', cwd: '/w', file: '/never/read' }, { id: 'two', title: 'Tool title two', cwd: '/w', titles: {} }]; },
  } });
  const provider = { id: 'custom', history: 'claude', env: {} };
  const account = { id: 'default', env: {} };
  const all = await history.list(provider, account);
  assert.deepEqual(all.sessions, [{ id: 'one', title: 'Tool title one', cwd: '/w', name: null }, { id: 'two', title: 'Tool title two', cwd: '/w', name: 'Login fix' }]);
  assert.deepEqual((await history.list(provider, account, { query: 'login' })).sessions.map((s) => s.id), ['two']);
  names.set('custom', 'default', 'one', 'Parser work');
  assert.deepEqual((await history.list(provider, account, { query: 'parser' })).sessions.map((s) => s.id), ['one'], 'a new name is found at once');
  assert.equal(reads, 1, 'searching uses the cached listing');
});

test('card names keep the newest entries, and an unreadable file is never overwritten', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'card-names.json');
  const names = createCardNames(file, { limit: 2, warn: () => {} });
  names.set('p', 'default', 'a', 'A');
  names.set('p', 'default', 'b', 'B');
  names.set('p', 'default', 'a', 'A2');
  names.set('p', 'work', 'c', 'C');
  const again = createCardNames(file);
  assert.deepEqual([again.get('p', 'default', 'a'), again.get('p', 'default', 'b'), again.get('p', 'work', 'c')], ['A2', null, 'C']);
  again.delete('p', 'default', 'a');
  assert.equal(createCardNames(file).get('p', 'default', 'a'), null);
  fs.writeFileSync(file, 'not json');
  const warnings = [];
  const broken = createCardNames(file, { warn: (message) => warnings.push(message) });
  broken.set('p', 'default', 'd', 'D');
  assert.equal(broken.get('p', 'default', 'd'), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
  assert.equal(warnings.length, 1);
});
