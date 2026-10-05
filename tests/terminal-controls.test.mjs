import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
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
  }
  assert.equal(terminalKey('Tab', term.modes), null);
  assert.equal(terminalKey('toString', term.modes), null);
});
