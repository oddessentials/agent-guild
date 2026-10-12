import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';

// The page loads markdown-it's browser build from the manager's /vendor path; Node loads the same file.
registerHooks({
  resolve: (specifier, context, next) => next(specifier === './vendor/markdown-it.mjs' ? 'markdown-it/browser' : specifier, context),
});
const { spokenText, speechChunks, createReader, CODE_OMITTED, MAX_CHUNK } = await import('../web/read-aloud.js');

test('fenced code inside lists and quotes is skipped, and the prose after it is read', () => {
  assert.deepEqual(spokenText('- > ```\n  > code\n  > ```\n  > After the quote.\n- - ```\n    code\n    ```\n    Nested prose.').split('\n'),
    [CODE_OMITTED, 'After the quote.', CODE_OMITTED, 'Nested prose.']);
});

test('a fence closes only on its own closing fence', () => {
  assert.deepEqual(spokenText('```md\n> ```\n> inner\n> ```\n```\nAfter the example.\n~~~\n```\n~~~\nAfter tildes.\n```\nunclosed runs to the end').split('\n'),
    [CODE_OMITTED, 'After the example.', CODE_OMITTED, 'After tildes.', CODE_OMITTED]);
});

test('links, inline code and emphasis are read as their words', () => {
  assert.equal(spokenText('Use `snake_case_name` and **bold** _words_ in [the docs](https://example.com) and <https://example.com/a>. ![Diagram](d.png)'),
    'Use snake_case_name and bold words in the docs and https://example.com/a. Diagram');
});

test('headings, prose after code, indented code, list numbers and table rows each read as a line', () => {
  assert.deepEqual(spokenText('## Result\nRun this:\n```sh\nnpm test\n```\nThen check the output.\n\n    indented code is read\n\n1. First step\n2. Second step\n\n| Name | Size |\n| --- | ---: |\n| a.txt | 2 KB |\n\n---\n> quoted').split('\n'),
    ['Result', 'Run this:', CODE_OMITTED, 'Then check the output.', 'indented code is read', '1. First step', '2. Second step', 'Name, Size', 'a.txt, 2 KB', 'quoted']);
});

test('chunks follow lines and sentences and never pass the limit', () => {
  assert.deepEqual(speechChunks('One. Two? Three!\nFour'), ['One.', 'Two?', 'Three!', 'Four']);
  const long = `${'word '.repeat(30)}then, ${'more '.repeat(40)}${'x'.repeat(450)}`;
  const chunks = speechChunks(long);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= MAX_CHUNK));
  assert.ok(chunks[0].endsWith('then,'), 'a long sentence breaks at its last pause');
  assert.equal(chunks.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''), 'no character is lost');
});

function fakeSpeech() {
  const spoken = [];
  return {
    spoken,
    synth: { speak: (u) => spoken.push(u), cancel: () => { const current = spoken.at(-1); current?.onerror?.({ error: 'interrupted' }); } },
    Utterance: class { constructor(text) { this.text = text; } },
  };
}

test('each chunk starts when the one before ends, and a stopped read speaks no more', () => {
  const speech = fakeSpeech();
  const reader = createReader({ synth: speech.synth, Utterance: speech.Utterance });
  reader.read('a', 'One. Two. Three.');
  assert.deepEqual(speech.spoken.map((u) => u.text), ['One.'], 'one chunk at a time');
  speech.spoken[0].onend();
  assert.deepEqual(speech.spoken.map((u) => u.text), ['One.', 'Two.']);
  reader.stop();
  assert.equal(reader.session, null);
  speech.spoken[1].onend();
  assert.equal(speech.spoken.length, 2, 'a late end of a stopped read starts nothing');

  reader.read('a', 'First read.');
  const old = speech.spoken.at(-1);
  reader.read('b', 'Second read. More.');
  old.onend();
  assert.deepEqual(speech.spoken.slice(-1).map((u) => u.text), ['Second read.'], 'a new read leaves the old one nothing to do');
  assert.equal(reader.session, 'b');
  speech.spoken.at(-1).onend();
  speech.spoken.at(-1).onend();
  assert.equal(reader.session, null, 'the last end finishes the read');
});

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const readSource = app.slice(app.indexOf('// ---- reading answers aloud'), app.indexOf('// ---- voice input'));
const clickSource = app.match(/\$\('panel-read'\)\.addEventListener\('click', toggleReading\);/)?.[0];
assert.ok(readSource.includes('function toggleReading') && clickSource);

function page() {
  const nodes = new Map(), listeners = new Map(), requests = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, checked: false, setAttribute(key, value) { this[key] = value; }, addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); } });
    return nodes.get(id);
  };
  const speech = fakeSpeech();
  const storage = new Map();
  const context = {
    window: { speechSynthesis: speech.synth, SpeechSynthesisUtterance: speech.Utterance },
    createReader, $: node, READ_KEY: 'read',
    load: (key) => storage.get(key), save: (key, value) => (value === null ? storage.delete(key) : storage.set(key, value)),
    state: { panes: ['a'], activeId: 'a', sessions: new Map([['a', { id: 'a', reply: { id: 1 } }]]) },
    api: (method, path) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    stopDictation: () => { context.dictationStopped = true; },
  };
  runInNewContext(`${readSource}\n${clickSource}\nglobalThis.reader = reader;\nglobalThis.replies = replies;`, context);
  return { context, node, speech, requests, storage, click: () => listeners.get('panel-read:click')() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Read waits for its answer to load, then speaks straight from the click', async () => {
  const p = page();
  p.context.renderRead();
  const button = p.node('panel-read');
  assert.deepEqual([button.hidden, button.disabled], [false, true], 'shown but off while the answer loads');
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].path, '/sessions/a/reply');
  p.click();
  assert.equal(p.speech.spoken.length, 0);

  p.context.renderRead();
  assert.equal(p.requests.length, 1, 'one load per answer');
  p.requests[0].resolve({ reply: { id: 1, text: 'First answer. Done.' } });
  await settle();
  assert.equal(button.disabled, false);
  p.click();
  assert.deepEqual(p.speech.spoken.map((u) => u.text), ['First answer.'], 'the click speaks without waiting');
  assert.equal(p.context.dictationStopped, true, 'the microphone stops first');
  assert.equal(button['aria-pressed'], 'true');

  // A newer answer arrives while the old one is read: reading goes on, Read waits for the new text.
  p.context.state.sessions.set('a', { id: 'a', reply: { id: 2 } });
  p.context.renderRead();
  assert.equal(p.requests.length, 2);
  p.click();
  assert.equal(button['aria-pressed'], 'false', 'a press while reading stops it');
  assert.equal(button.disabled, true, 'the old text is never read for the new answer');
  p.click();
  assert.equal(p.speech.spoken.length, 1);
  p.requests[1].reject(new Error('offline'));
  await settle();
  p.context.renderRead();
  assert.deepEqual([button.disabled, p.requests.length], [true, 2], 'a failed load waits for the next answer or a reconnect');

  p.context.replies.clear();
  p.context.renderRead();
  p.requests[2].resolve({ reply: { id: 2, text: 'Second answer.' } });
  await settle();
  assert.equal(button.disabled, false);
  p.click();
  p.context.state.panes = [];
  p.context.renderRead();
  assert.equal(p.context.reader.session, null, 'reading stops when its terminal leaves the screen');
});

test('a load that sees a newer answer than the session update waits for that update', async () => {
  const p = page();
  p.context.renderRead();
  p.requests[0].resolve({ reply: { id: 2, text: 'Newer answer.' } });
  await settle();
  p.context.renderRead();
  assert.equal(p.requests.length, 1, 'no new load until the session update moves on');
  assert.equal(p.node('panel-read').disabled, true);
  p.context.state.sessions.set('a', { id: 'a', reply: { id: 2 } });
  p.context.renderRead();
  assert.equal(p.requests.length, 2);
});

test('playback keeps its button when the answer clears, and stops when any tab turns reading off', async () => {
  const p = page();
  p.context.renderRead();
  p.requests[0].resolve({ reply: { id: 1, text: 'One. Two.' } });
  await settle();
  p.click();
  p.context.state.sessions.set('a', { id: 'a', reply: null });
  p.context.renderRead();
  const button = p.node('panel-read');
  assert.deepEqual([button.hidden, button.disabled, button['aria-pressed']], [false, false, 'true'], 'a turn without an answer leaves the way to stop');
  p.click();
  assert.equal(p.context.reader.session, null);
  assert.equal(button.hidden, true);

  p.context.state.sessions.set('a', { id: 'a', reply: { id: 2 } });
  p.context.renderRead();
  p.requests[1].resolve({ reply: { id: 2, text: 'Three.' } });
  await settle();
  p.click();
  p.storage.set('read', 'off');
  p.context.renderRead();
  assert.equal(p.context.reader.session, null, 'turned off in another tab, the storage event\'s render stops it');
});
