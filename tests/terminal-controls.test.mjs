import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { terminalKey } from '../web/terminal-controls.js';

test('touch keys follow the terminal cursor mode as applications enter and leave it', async (t) => {
  const term = new headless.Terminal({ allowProposedApi: true });
  t.after(() => term.dispose());
  for (const [output, prefix] of [['', '\x1b['], ['\x1b[?1h', '\x1bO'], ['\x1b[?1l', '\x1b[']]) {
    await new Promise((resolve) => term.write(output, resolve));
    for (const [key, final] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D']]) {
      assert.equal(terminalKey(key, term.modes), prefix + final);
    }
    assert.equal(terminalKey('Enter', term.modes), '\r');
    assert.equal(terminalKey('Escape', term.modes), '\x1b');
    assert.equal(terminalKey('Tab', term.modes), '\t');
    assert.equal(terminalKey('Interrupt', term.modes), '\x03');
  }
  assert.equal(terminalKey('Backspace', term.modes), null);
  assert.equal(terminalKey('toString', term.modes), null);
});

test('Clear discards a whole input line from any cursor position without submitting or interrupting', (t) => {
  // The test runner may use TERM=dumb; exercise a real terminal's editing keys.
  const previousTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
  const input = new PassThrough(), output = new PassThrough();
  output.columns = 40;
  output.resume();
  const prompt = createInterface({ input, output, terminal: true });
  t.after(() => { prompt.close(); input.destroy(); output.destroy(); });
  const submitted = [];
  let interrupts = 0;
  prompt.on('line', line => submitted.push(line));
  prompt.on('SIGINT', () => interrupts++);
  const text = 'Please review the café checkout flow and explain the changes. '.repeat(4);
  for (const movement of ['', '\x01', '\x01\x1b[C\x1b[C\x1b[C']) {
    input.write(text + movement);
    assert.equal(prompt.line, text);
    input.write(terminalKey('Clear', {}));
    assert.equal(prompt.line, '');
    assert.equal(prompt.cursor, 0);
  }
  input.write(terminalKey('Clear', {}));
  assert.equal(prompt.line, '', 'clearing an empty prompt is harmless');
  assert.deepEqual(submitted, []);
  assert.equal(interrupts, 0);
  input.write('replacement\r');
  assert.deepEqual(submitted, ['replacement'], 'the next input contains none of the discarded draft');
});
