import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import headless from '@xterm/headless';
import { captureTerminalText } from '../web/terminal-copy.js';

async function terminal(t, output, options = {}) {
  const term = new headless.Terminal({ cols: 40, rows: 3, scrollback: 5, allowProposedApi: true, ...options });
  t.after(() => term.dispose());
  await new Promise((resolve) => term.write(output, resolve));
  return term;
}

test('copy text reflects the rendered buffer, including Unicode, indentation and literal markup', async (t) => {
  const term = await terminal(t, '\x1b[31mA中🙂 e\u0301\x1b[0m\r\n  <script>literal</script>\r\nold\rnew');
  assert.equal(captureTerminalText(term).text, 'A中🙂 e\u0301\n  <script>literal</script>\nnew');
});

test('soft wraps preserve spaces and do not add newlines or wide-character padding', async (t) => {
  for (const text of ['abcd  ef', 'abcd中!', '12345abc', 'a👩‍💻b']) {
    const term = await terminal(t, text, { cols: 5, rows: 6 });
    const copy = captureTerminalText(term).text;
    assert.equal(copy.replace(/\n+$/, ''), text);
  }
});

test('hard breaks, blank lines and explicit trailing spaces survive copying', async (t) => {
  const term = await terminal(t, 'a  \r\n\r\n  b\u00a0c');
  assert.equal(captureTerminalText(term).text, 'a  \n\n  b\u00a0c');
});

test('copy captures only the active alternate screen, then the normal screen on return', async (t) => {
  const term = await terminal(t, 'NORMAL\x1b[?1049h\x1b[H\x1b[2JALT');
  const frozen = captureTerminalText(term);
  assert.equal(frozen.text, 'ALT\n\n');
  await new Promise((resolve) => term.write('\x1b[?1049l\r\nLATER', resolve));
  assert.equal(frozen.text, 'ALT\n\n');
  assert.equal(captureTerminalText(term).text, 'NORMAL\nLATER\n');
});

test('capture respects retained scrollback and maps the visible row through soft wraps', async (t) => {
  const term = await terminal(t, '0123456789\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix', { cols: 5, scrollback: 2 });
  const copy = captureTerminalText(term);
  assert.equal(copy.text, 'two\nthree\nfour\nfive\nsix');
  assert.equal(copy.viewportLine, 2);
  const wrapped = await terminal(t, '0123456789\r\ntwo\r\nthree', { cols: 5 });
  assert.deepEqual(captureTerminalText(wrapped), { text: '0123456789\ntwo\nthree', viewportLine: 0, viewportPrefix: '01234' });
});

test('wrapped viewport positions retain the exact prefix, including Unicode and trimmed scrollback', async (t) => {
  for (const [output, options, text, prefix] of [
    ['abcdefghijklmnopqrstuvwxyz', {}, 'abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmno'],
    ['abcdefghijklmnopqrstuvwxyz', { scrollback: 1 }, 'klmnopqrstuvwxyz', 'klmno'],
    ['中🙂ae\u0301b\u00a0中klmnopqrstuvwxy', {}, '中🙂ae\u0301b\u00a0中klmnopqrstuvwxy', '中🙂ae\u0301b\u00a0中k'],
    ['abcd中!1234567890', {}, 'abcd中!1234567890', 'abcd'],
  ]) {
    const term = await terminal(t, output, { cols: 5, rows: 3, ...options });
    const snapshot = captureTerminalText(term);
    assert.deepEqual(snapshot, { text, viewportLine: 0, viewportPrefix: prefix });
    term.scrollToTop();
    assert.equal(captureTerminalText(term).viewportPrefix, '', 'scrolling back uses the beginning of retained text');
    term.resize(10, 3);
    assert.equal(snapshot.viewportPrefix, prefix, 'the original snapshot is unaffected by reflow');
  }
});

test('a captured value survives output and reflow without keeping mutable buffer lines', async (t) => {
  const term = await terminal(t, 'wrapped command with arguments', { cols: 12, rows: 4 });
  const copy = captureTerminalText(term);
  term.resize(8, 4);
  await new Promise((resolve) => term.write('\r\nNEW', resolve));
  assert.equal(copy.text, 'wrapped command with arguments\n');
  assert.match(captureTerminalText(term).text, /NEW/);
});

// Exercise the app's actual lifecycle entry points, including the BFCache path.
const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const functions = ['openPanel', 'focusPane', 'closePane', 'closePanel', 'dropSession'].map((name) => {
  const source = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, name);
  return source;
}).join('\n');
const pagehide = app.match(/addEventListener\('pagehide', \(\) => \{[^]*?\n\}\);/)?.[0];

test('switch, Hide, session removal and page departure dismiss sensitive copy text', () => {
  let closed = 0;
  const listeners = new Map();
  const noop = () => {};
  const view = { mount: noop, unmount: noop, dispose: noop, term: { focus: noop } };
  const context = {
    state: { panes: ['a'], focusedPane: 0, activeId: 'a', sessions: new Map([['a', {}], ['b', {}]]), views: new Map([['a', view], ['b', view]]) },
    terminalCopy: { close: () => closed++ }, activityFavicon: { setPaused: noop },
    terminalControls: { cancel: noop, refresh: noop },
    $: () => ({}), dictation: null, stopDictation: noop, updatePanel: noop, renderVoice: noop, renderSessions: noop,
    layoutPanes: noop, savePanes: noop, closeMenu: noop, dockMakesWayForTerminal: noop, followTerminal: noop, document: { activeElement: null },
    paneNodes: [0, 1].map(() => ({ contains: () => false })),
    managerLoss: { cancel: noop }, addEventListener: (name, fn) => listeners.set(name, fn),
  };
  vm.runInNewContext(functions + '\n' + pagehide, context);
  context.openPanel('a');
  assert.equal(closed, 0, 'reselecting the same card leaves its snapshot alone');
  context.openPanel('b');
  assert.equal(closed, 1);
  context.openPanel('a', { beside: true });
  assert.equal(closed, 2, 'a terminal opened beside takes the focus');
  context.openPanel('b');
  assert.equal(closed, 3, 'focusing the other pane switches the terminal the copy belongs to');
  context.closePanel();
  assert.equal(closed, 4);
  context.openPanel('b');
  closed = 0;
  context.dropSession('b');
  assert.equal(closed, 1);
  listeners.get('pagehide')();
  assert.equal(closed, 2);
});
