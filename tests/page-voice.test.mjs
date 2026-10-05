import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = app.match(/function dictatedText\([^]*?\n\}/)?.[0];
const context = {};
runInNewContext(source, context);

test('dictated text is a single line that never submits', () => {
  assert.equal(context.dictatedText('  list the files\nand run tests\r', true), 'list the files and run tests');
  assert.equal(context.dictatedText(' then commit', false), ' then commit');
  assert.equal(context.dictatedText('\x1b[A\x03 ', false), ' [A');
  assert.equal(context.dictatedText('   ', false), '');
});

const voiceSource = app.slice(app.indexOf('const Recognition ='), app.indexOf('// ---- stopping the manager'));
const panelSource = ['openPanel', 'focusPane', 'closePane', 'closePanel', 'updatePanel', 'upsertSession', 'dropSession', 'showAuth', 'enterStopping'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');
const listenerSource = [
  /\$\('panel-voice'\)\.addEventListener\('click', \(\) => \{[^]*?\n\}\);/,
  /document\.addEventListener\('visibilitychange', \(\) => \{[^]*?\n\}\);/,
  /addEventListener\('pagehide', \(\) => \{[^]*?\n\}\);/,
  /addEventListener\('pageshow', \(event\) => \{[^]*?\n\}\);/,
  /addEventListener\('storage', \(e\) => \{[^]*?\n\}\);/,
].map((pattern) => {
  const found = app.match(pattern)?.[0];
  assert.ok(found, `${pattern} is present`);
  return found;
}).join('\n');
const terminalMessageSource = app.match(/  onMessage\(msg\) \{[^]*?\n  \}/)?.[0];
assert.ok(terminalMessageSource);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the real lifecycle functions and listeners. Only browser APIs, timers,
// terminal IO, and unrelated page rendering are stubbed; no microphone is used.
function page({ android = false, available, supported = true, enabled = true, prefixed = false, language = 'en-GB', constructorError = false, startError = false } = {}) {
  const nodes = new Map(), listeners = new Map(), timers = new Map();
  const instances = [], pasted = [], messages = [], availabilityCalls = [];
  const storage = new Map(enabled ? [['voice', 'on']] : []);
  const noop = () => {};
  let nextTimer = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, textContent: '', checked: false,
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
    });
    return nodes.get(id);
  };
  const session = (id) => ({ id, name: id, status: 'running', startedAt: '2026-10-03T10:00:00Z', provider: { tool: 'Shell' } });
  const view = (id) => ({
    mount: noop, unmount: noop, dispose: noop,
    term: { paste: (text) => pasted.push({ id, text }), focus: noop, write: noop },
  });
  class Recognition {
    constructor() {
      if (constructorError) throw new Error('constructor failed');
      this.starts = 0;
      this.aborts = 0;
      instances.push(this);
    }
    start() { this.starts++; if (startError) throw new Error('start failed'); }
    abort() {
      this.aborts++;
      // Even reentrant browser callbacks during abort must be ignored.
      this.onerror?.({ error: 'aborted' });
      this.onend?.();
    }
  }
  if (available !== undefined) Recognition.available = typeof available === 'function'
    ? (options) => { availabilityCalls.push(options); return available(options); } : available;
  const context = {
    window: supported ? { [prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition']: Recognition } : {},
    navigator: { language, userAgent: android ? 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' : 'Desktop' },
    document: { visibilityState: 'visible', addEventListener: (type, callback) => listeners.set(type, callback) },
    addEventListener: (type, callback) => listeners.set(type, callback),
    $: node, VOICE_KEY: 'voice', SOUND_KEY: 'sound', CHANGELOG_SEEN_KEY: 'changelog',
    load: (key) => storage.get(key),
    save: (key, value) => value === null ? storage.delete(key) : storage.set(key, value),
    state: { panes: ['a'], focusedPane: 0, activeId: 'a', sessions: new Map(['a', 'b'].map((id) => [id, session(id)])), views: new Map(['a', 'b'].map((id) => [id, view(id)])), connected: false },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    toast: (message) => messages.push(message),
    paintProviderIcon: noop, toolSessionId: noop, accountLabel: noop, modelText: noop, statusText: noop, modelTitle: noop, renderAgents: noop,
    renderSessions: () => context.updatePanel(), noticeClone: noop, exitLine: () => '[exited]',
    managerLoss: { cancel: noop }, closeModels: noop, closeNews: noop, closeChangelog: noop, closeHistory: noop, closeGitHub: noop,
    terminalCopy: { close: noop }, terminalControls: { cancel: noop, refresh: noop }, layoutPanes: noop, renderPaneLabels: noop, savePanes: noop, closeMenu: noop, dockMakesWayForTerminal: noop, followTerminal: noop,
    paneNodes: [0, 1].map(() => ({ contains: () => false })),
    activityFavicon: { setPaused: noop },
    setConnection: noop, showStopped: noop, restartTimer: null, newsLoadedAt: 0, loadNews: noop, connectEvents: noop, dockShows: () => false, githubShownView: () => 'repos', loadView: noop, scheduleRuns: noop, flushNotes: noop,
  };
  runInNewContext(`${voiceSource}\n${panelSource}\n${listenerSource}\nglobalThis.terminalMessage = ({${terminalMessageSource}}).onMessage;`, context);
  context.renderVoice();
  return {
    context, node, instances, pasted, messages, timers, storage, availabilityCalls,
    click: () => listeners.get('panel-voice:click')(),
    fire: (type, event = {}) => listeners.get(type)(event),
    latest: () => instances.at(-1),
    advance: () => {
      assert.equal(timers.size, 1, 'exactly one restart is pending');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

const result = (text, isFinal = true) => Object.assign([{ transcript: text }], { isFinal });
function say(rec, text) { rec.onresult({ resultIndex: 0, results: [result(text)] }); }
function assertOff(p) {
  assert.equal(p.node('panel-voice')['aria-pressed'], 'false');
  assert.equal(p.node('voice-preview').hidden, true);
  assert.equal(p.node('voice-preview').textContent, '');
  assert.equal(p.timers.size, 0);
}

test('without a callable availability API, start stays in the click handler, including prefixed browsers', () => {
  for (const available of [undefined, null, true]) {
    const p = page({ available, prefixed: true });
    p.click();
    assert.equal(p.latest().starts, 1, 'no microtask is needed to start');
    assert.equal(p.latest().continuous, true);
    assert.equal(p.latest().lang, 'en-GB');
    assert.equal(p.latest().interimResults, true);
    assert.equal(p.node('panel-voice')['aria-pressed'], 'true');
    p.click();
    assertOff(p);
  }
});

test('availability selects local recognition only when installed, and failures preserve fallback', async () => {
  for (const answer of ['available', 'unavailable', 'downloadable', 'downloading', 'reject', 'throw']) {
    const p = page({ available: () => {
      if (answer === 'throw') throw new Error('API unavailable');
      return answer === 'reject' ? Promise.reject(new Error('policy denied')) : Promise.resolve(answer);
    } });
    await p.context.startDictation();
    assert.equal(p.latest().starts, 1);
    assert.equal(p.latest().processLocally === true, answer === 'available');
    assert.deepEqual(JSON.parse(JSON.stringify(p.availabilityCalls)), [{ langs: ['en-GB'], processLocally: true }]);
    assert.deepEqual(p.messages, []);
  }
});

test('unsupported, disabled, hidden, missing and exited sessions cannot start', async () => {
  for (const setup of [
    (p) => p.context.changeVoice({ checked: false }),
    (p) => { p.context.state.sessions.get('a').status = 'exited'; p.context.updatePanel(); },
    (p) => { p.context.state.sessions.delete('a'); p.context.updatePanel(); },
    (p) => p.context.closePanel(),
    (p) => { p.context.document.visibilityState = 'hidden'; },
    (p) => { p.context.state.pageAway = true; },
    (p) => { p.node('app').hidden = true; },
    (p) => { p.context.state.stopping = true; },
  ]) {
    const p = page(); setup(p); await p.context.startDictation();
    assert.equal(p.instances.length, 0);
    assert.equal(p.node('panel-voice')['aria-pressed'], 'false');
  }
  for (const options of [{ supported: false }, { enabled: false }]) {
    const p = page(options); await p.context.startDictation();
    assert.equal(p.instances.length, 0);
    assert.equal(p.node('panel-voice').hidden, true);
    if (options.supported === false) assert.equal(p.node('voice-choice').hidden, true);
  }
});

test('Dictate follows the selected session status and a reattached process starts only on a new click', () => {
  const p = page();
  p.click();
  p.context.upsertSession({ ...p.context.state.sessions.get('a'), status: 'exited', exitedAt: '2026-10-03T10:01:00Z' });
  assertOff(p);
  assert.equal(p.node('panel-voice').hidden, true);
  p.context.upsertSession({ ...p.context.state.sessions.get('a'), status: 'running', startedAt: '2026-10-03T10:02:00Z' });
  assert.equal(p.node('panel-voice').hidden, false);
  assert.equal(p.instances.length, 1);
  p.click();
  assert.equal(p.instances.length, 2);
  say(p.latest(), 'new process');
  assert.deepEqual(p.pasted, [{ id: 'a', text: 'new process' }]);
});

test('ordinary updates, reopening the same running panel and other session exits keep dictation active', () => {
  const p = page(); p.click();
  const rec = p.latest();
  p.context.upsertSession({ ...p.context.state.sessions.get('a'), activity: 'active' });
  p.context.openPanel('a');
  p.context.upsertSession({ ...p.context.state.sessions.get('b'), status: 'exited' });
  p.context.terminalMessage.call({ id: 'b', term: p.context.state.views.get('b').term }, { type: 'exit' });
  assert.equal(p.node('panel-voice')['aria-pressed'], 'true');
  assert.equal(rec.aborts, 0);
  say(rec, 'still here');
  assert.deepEqual(p.pasted, [{ id: 'a', text: 'still here' }]);
});

test('every departure cancels pending startup, active listening and Android restart timers', async (t) => {
  const cancellations = {
    'second click': (p) => p.click(),
    'Voice disabled and reenabled': (p) => { p.context.changeVoice({ checked: false }); p.context.changeVoice({ checked: true }); },
    'Voice disabled in another tab': (p) => { p.storage.delete('voice'); p.fire('storage', { key: 'voice' }); p.storage.set('voice', 'on'); p.fire('storage', { key: 'voice' }); },
    'close and reopen A': (p) => { p.context.closePanel(); p.context.openPanel('a'); },
    'A to B to A': (p) => { p.context.openPanel('b'); p.context.openPanel('a'); },
    'session exit': (p) => p.context.upsertSession({ ...p.context.state.sessions.get('a'), status: 'exited', exitedAt: '2026-10-03T10:01:00Z' }),
    'session removal': (p) => p.context.dropSession('a'),
    'new startedAt on the same session': (p) => p.context.upsertSession({ ...p.context.state.sessions.get('a'), startedAt: '2026-10-03T10:02:00Z' }),
    'hidden then visible': (p) => { p.context.document.visibilityState = 'hidden'; p.fire('visibilitychange'); p.context.document.visibilityState = 'visible'; p.fire('visibilitychange'); },
    'pagehide then restored': (p) => { p.fire('pagehide'); p.fire('pageshow', { persisted: true }); },
    'authentication screen': (p) => p.context.showAuth(),
    'manager shutdown': (p) => p.context.enterStopping(),
    'terminal exit message': (p) => p.context.terminalMessage.call({ id: 'a', term: p.context.state.views.get('a').term }, { type: 'exit' }),
  };
  for (const phase of ['pending', 'listening', 'restarting']) {
    for (const [name, cancel] of Object.entries(cancellations)) {
      await t.test(`${phase}: ${name}`, async () => {
        const lookup = deferred();
        const p = page({ android: true, available: phase === 'pending' ? () => lookup.promise : undefined });
        const start = p.context.startDictation();
        if (phase !== 'pending') await start;
        if (phase === 'restarting') { say(p.latest(), 'first phrase'); p.latest().onend(); }
        const rec = p.latest();
        const queued = [...p.timers.values()].map((timer) => timer.callback);
        const before = [...p.pasted];
        assert.equal(p.node('panel-voice')['aria-pressed'], 'true', 'pending and restarting are cancellable too');
        cancel(p);
        assertOff(p);
        lookup.resolve('available');
        await start;
        // Simulate callbacks that were queued just before cancellation.
        for (const callback of queued) callback();
        if (rec) { say(rec, 'stale words'); rec.onerror({ error: 'network' }); rec.onend(); }
        assertOff(p);
        assert.equal(p.instances.length, phase === 'pending' ? 0 : 1);
        assert.deepEqual(p.pasted, before);
        assert.deepEqual(p.messages, []);
        if (phase === 'listening') assert.equal(rec.aborts, 1);
      });
    }
  }
});

test('a canceled lookup cannot disturb a newer operation, even if it resolves or rejects later', async () => {
  for (const reject of [false, true]) {
    const oldLookup = deferred(), newLookup = deferred();
    let calls = 0;
    const p = page({ available: () => (++calls === 1 ? oldLookup : newLookup).promise });
    const oldStart = p.context.startDictation();
    p.click();
    const newStart = p.context.startDictation();
    newLookup.resolve('available'); await newStart;
    if (reject) oldLookup.reject(new Error('late rejection')); else oldLookup.resolve('unavailable');
    await oldStart;
    assert.equal(p.instances.length, 1);
    assert.equal(p.latest().processLocally, true);
    assert.equal(p.node('panel-voice')['aria-pressed'], 'true');
    assert.equal(p.latest().aborts, 0);
    assert.deepEqual(p.messages, []);
  }
});

test('callbacks from an old recognizer cannot affect a new terminal or its preview', () => {
  const p = page(); p.click();
  const old = p.latest();
  p.context.openPanel('b'); p.click();
  p.latest().onresult({ resultIndex: 0, results: [result('new preview', false)] });
  say(old, 'old words'); old.onerror({ error: 'not-allowed' }); old.onend();
  assert.equal(p.node('voice-preview').textContent, 'new preview');
  assert.equal(p.node('panel-voice')['aria-pressed'], 'true');
  say(p.latest(), 'new words');
  assert.deepEqual(p.pasted, [{ id: 'b', text: 'new words' }]);
  assert.deepEqual(p.messages, []);
});

test('rechecks reject a changed process or hidden page even before a lifecycle refresh', async () => {
  for (const phase of ['pending', 'result', 'restart']) {
    for (const invalidate of [
      (p) => { p.context.state.sessions.get('a').startedAt = '2026-10-03T10:02:00Z'; },
      (p) => { p.context.document.visibilityState = 'hidden'; },
      (p) => { p.context.state.sessions.get('a').status = 'exited'; },
    ]) {
      const lookup = deferred();
      const p = page({ android: true, available: phase === 'pending' ? () => lookup.promise : undefined });
      const start = p.context.startDictation();
      if (phase !== 'pending') await start;
      if (phase === 'restart') p.latest().onend();
      invalidate(p);
      if (phase === 'pending') { lookup.resolve('available'); await start; }
      else if (phase === 'result') say(p.latest(), 'wrong process');
      else p.advance();
      assertOff(p);
      assert.deepEqual(p.pasted, []);
      assert.equal(p.instances.length, phase === 'pending' ? 0 : 1);
    }
  }
});

test('final results paste once, interim words only preview, and intentional repetition survives', () => {
  const p = page({ language: '' }); p.click();
  const rec = p.latest();
  assert.equal(rec.lang, 'en-US');
  rec.onresult({ resultIndex: 0, results: [result('  still thinking  ', false)] });
  assert.deepEqual(p.pasted, []);
  assert.equal(p.node('voice-preview').textContent, 'still thinking');
  say(rec, 'hello\nworld\r');
  say(rec, 'hello\nworld\r');
  rec.onresult({ resultIndex: 0, results: [result('hello\nworld\r'), result('hello world')] });
  assert.deepEqual(p.pasted.map(({ text }) => text), ['hello world', ' hello world']);
  assert.equal(p.node('voice-preview').hidden, true);
  rec.onend();
  assertOff(p);
  assert.equal(p.instances.length, 1, 'desktop end does not restart');
});

test('Android uses fresh single-phrase recognizers, preserves spacing and checks availability once', async () => {
  const p = page({ android: true, available: () => Promise.resolve('available') });
  await p.context.startDictation();
  const first = p.latest();
  say(first, 'go'); first.onend();
  assert.equal(p.node('panel-voice')['aria-pressed'], 'true');
  assert.equal(p.advance(), 250);
  const second = p.latest();
  assert.notEqual(first, second);
  assert.equal(second.continuous, false);
  assert.equal(second.processLocally, true);
  assert.equal(second.lang, 'en-GB');
  say(first, 'stale cumulative words'); first.onerror({ error: 'network' }); first.onend();
  say(second, 'go'); say(second, 'go'); second.onend();
  assert.equal(p.advance(), 250);
  assert.deepEqual(p.pasted.map(({ text }) => text), ['go', ' go']);
  assert.equal(p.availabilityCalls.length, 1);
  assert.deepEqual(p.messages, []);
});

test('Android allows three consecutive empty retries with backoff, then stops', () => {
  for (const noSpeech of [false, true]) {
    const p = page({ android: true }); p.click();
    for (const delay of [250, 500, 1000]) {
      if (noSpeech) p.latest().onerror({ error: 'no-speech' });
      p.latest().onend();
      assert.equal(p.advance(), delay);
    }
    p.latest().onend();
    assertOff(p);
    assert.equal(p.instances.length, 4);
    assert.equal(p.messages.length, 1);
    assert.match(p.messages[0], /repeated silence/);
  }
});

test('only nonempty final text resets the Android retry allowance', () => {
  const p = page({ android: true }); p.click();
  p.latest().onend(); assert.equal(p.advance(), 250);
  say(p.latest(), ' \n '); p.latest().onend(); assert.equal(p.advance(), 500);
  p.latest().onresult({ resultIndex: 0, results: [result('interim', false)] });
  p.latest().onend(); assert.equal(p.advance(), 1000);
  say(p.latest(), 'a phrase'); p.latest().onend(); assert.equal(p.advance(), 250);
  for (const delay of [250, 500, 1000]) { p.latest().onend(); assert.equal(p.advance(), delay); }
  p.latest().onend(); assertOff(p);
  assert.deepEqual(p.pasted.map(({ text }) => text), ['a phrase']);
});

test('fatal errors stop immediately and late end events never restart', () => {
  for (const android of [false, true]) {
    for (const error of ['not-allowed', 'service-not-allowed', 'network', 'audio-capture', 'language-not-supported', 'aborted', 'unexpected-error', ...(!android ? ['no-speech'] : [])]) {
      const p = page({ android }); p.click();
      const rec = p.latest();
      rec.onerror({ error }); rec.onend(); rec.onerror({ error });
      assertOff(p);
      assert.equal(rec.aborts, 1);
      assert.equal(p.instances.length, 1);
      assert.equal(p.messages.length, ['aborted', 'no-speech'].includes(error) ? 0 : 1);
    }
  }
});

test('constructor and start failures reset the operation and never schedule retries', () => {
  for (const options of [{ constructorError: true }, { startError: true }]) {
    const p = page({ android: true, ...options }); p.click();
    assertOff(p);
    assert.deepEqual(p.messages, ['Voice input could not start.']);
    p.latest()?.onend();
    assert.equal(p.timers.size, 0);
  }
});
