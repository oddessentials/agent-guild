import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser script. Exercise its actual ordering functions without
// booting the DOM or copying them into the test.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = (name) => {
  const found = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
};
const page = runInNewContext(
  `${source('parseOrder')}\n${source('orderSessions')}\n${source('moveId')}\n({ parseOrder, orderSessions, moveId })`,
);
// Arrays made inside the context are copied out, so they compare as plain arrays here.
const parseOrder = (raw) => [...page.parseOrder(raw)];
const orderSessions = (sessions, order) => [...page.orderSessions(sessions, order)];
const moveId = (order, id, index) => [...page.moveId(order, id, index)];

const session = (id, minute) => ({ id, createdAt: `2026-10-03T09:${String(minute).padStart(2, '0')}:00.000Z` });
const ids = (sessions) => sessions.map((s) => s.id);
const A = session('a', 1);
const B = session('b', 2);
const C = session('c', 3);
const D = session('d', 4);

test('with no saved order, cards stay oldest first', () => {
  assert.deepEqual(ids(orderSessions([C, A, B], [])), ['a', 'b', 'c']);
});

test('saved order wins, and sessions it does not name follow it oldest first', () => {
  assert.deepEqual(ids(orderSessions([A, B, C], ['c', 'a', 'b'])), ['c', 'a', 'b']);
  assert.deepEqual(ids(orderSessions([D, A, B, C], ['c', 'a'])), ['c', 'a', 'b', 'd']);
});

test('a session the order does not name goes after the arranged ones, even an older one', () => {
  assert.deepEqual(ids(orderSessions([A, B, C, D], ['d', 'b', 'a', 'c'])), ['d', 'b', 'a', 'c']);
  const E = session('e', 0);
  assert.deepEqual(ids(orderSessions([A, B, C, D, E], ['d', 'b', 'a', 'c'])), ['d', 'b', 'a', 'c', 'e']);
});

test('ids of removed sessions in the saved order are ignored', () => {
  assert.deepEqual(ids(orderSessions([A, C], ['gone', 'c', 'also-gone', 'a'])), ['c', 'a']);
});

test('ordering does not change the list it is given', () => {
  const list = [C, A, B];
  orderSessions(list, ['b']);
  assert.deepEqual(ids(list), ['c', 'a', 'b']);
});

test('a saved order that is missing or unreadable counts as none', () => {
  assert.deepEqual(parseOrder(null), []);
  assert.deepEqual(parseOrder(''), []);
  assert.deepEqual(parseOrder('{"a":1}'), []);
  assert.deepEqual(parseOrder('not json'), []);
  assert.deepEqual(parseOrder('["b",3,null,"a"]'), ['b', 'a']);
});

test('moveId moves one id forward, backward and to either end', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveId(order, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveId(order, 'd', 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveId(order, 'b', 0), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveId(order, 'b', 3), ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveId(order, 'c', 99), ['a', 'b', 'd', 'c']);
  assert.deepEqual(moveId(order, 'c', -5), ['c', 'a', 'b', 'd']);
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'the original is untouched');
});
