import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { endpoints, READS, SOCKETS } from '../web/api-doc.js';

// docs/api.md is read by people building other front ends. These checks fail when a fixed-path route
// is missing from the doc, or when the doc names a code that no source file uses.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const doc = read('docs/api.md');
const server = read('src/manager/server.mjs');
const sources = ['src/manager', 'src/report'].flatMap((dir) =>
  readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => read(`${dir}/${f}`))).join('\n');

/** `METHOD /path` for every row of the HTTP endpoint table, without its query string. */
function documentedRoutes() {
  const rows = doc.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`?]+)[^`]*` \|/gm);
  return new Set([...rows].map(([, method, path]) => `${method} ${path}`));
}

test('every fixed route the server answers is in the API doc', () => {
  const documented = documentedRoutes();
  const served = [...server.matchAll(/route === '(\/[^']*)' && method === '(GET|POST|PUT|PATCH|DELETE)'/g)]
    .map(([, path, method]) => `${method} ${path}`);
  assert.ok(served.length > 0, 'no routes found in server.mjs');
  assert.deepEqual(served.filter((route) => !documented.has(route)), []);
});

test('the API explorer reads every row of the endpoint table, so a change to its format fails here', () => {
  const rows = doc.split(/\r?\n/).filter((line) => /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(line));
  const read = endpoints(doc);
  assert.equal(read.length, rows.length, 'a row the explorer cannot read');
  assert.deepEqual(new Set(read.map((e) => `${e.method} ${e.path}`)), documentedRoutes());
  for (const e of read) assert.ok(e.path.startsWith('/') && e.result, `${e.method} ${e.path}`);
  assert.deepEqual(read.find((e) => e.path === '/providers/:id/history'),
    { method: 'GET', path: '/providers/:id/history', params: ['id'], query: ['account', 'limit', 'cwd', 'q'], body: '', result: '`{ history }`: a History object for one account (default `default`).' });
  assert.match(read.find((e) => e.path === '/sessions/:id/shells').body, /^`\{ shell, key \| task, /, 'an escaped | stays in its cell');
});

test('the explorer sends only documented GET routes, and listens only to documented sockets', () => {
  const gets = new Set(endpoints(doc).filter((e) => e.method === 'GET').map((e) => e.path));
  assert.deepEqual([...READS].filter((path) => !gets.has(path)), []);
  const sockets = new Set([...doc.matchAll(/^### `GET \/api\/v1(\/\S+)`\r?$/gm)].map(([, path]) => path));
  assert.deepEqual([...SOCKETS].filter((path) => !sockets.has(path)), []);
});

test('every error code and value the API doc names is one the code uses', () => {
  const named = new Set([...doc.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(([, code]) => code));
  assert.ok(named.size > 0, 'no codes found in docs/api.md');
  assert.deepEqual([...named].filter((code) => !new RegExp(`['"\`]${code}['"\`]`).test(sources)), []);
});
