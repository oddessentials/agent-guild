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
  assert.equal(captureTerminalText(term).text, 'a  \n\n  b c');
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
  assert.deepEqual(captureTerminalText(wrapped), { text: '0123456789\ntwo\nthree', viewportLine: 0 });
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
const functions = ['openPanel', 'closePanel', 'dropSession'].map((name) => {
  const source = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, name);
  return source;
}).join('\n');
const pagehide = app.match(/addEventListener\('pagehide', \(\) => \{[^]*?\n\}\);/)?.[0];

test('switch, Hide, session removal and page departure dismiss sensitive copy text', () => {
  let closed = 0;
  const listeners = new Map();
  const noop = () => {};
  const view = { mount: noop, unmount: noop, dispose: noop };
  const context = {
    state: { activeId: 'a', sessions: new Map([['a', {}], ['b', {}]]), views: new Map([['a', view], ['b', view]]) },
    terminalCopy: { close: () => closed++ },
    $: () => ({}), dictation: null, stopDictation: noop, updatePanel: noop, renderVoice: noop, renderSessions: noop,
    managerLoss: { cancel: noop }, addEventListener: (name, fn) => listeners.set(name, fn),
  };
  vm.runInNewContext(functions + '\n' + pagehide, context);
  context.openPanel('a');
  assert.equal(closed, 0, 'reselecting the same card leaves its snapshot alone');
  context.openPanel('b');
  assert.equal(closed, 1);
  context.closePanel();
  assert.equal(closed, 2);
  context.state.activeId = 'b';
  context.dropSession('b');
  assert.equal(closed, 3);
  listeners.get('pagehide')();
  assert.equal(closed, 4);
});
