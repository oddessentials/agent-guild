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
