import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// docs/api.md is read by people building other front ends. These checks keep its routes and codes
// in step with the server, so a route or error code cannot be renamed or removed behind the doc's back.

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

test('every error code and value the API doc names is one the code uses', () => {
  const named = new Set([...doc.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(([, code]) => code));
  assert.ok(named.size > 0, 'no codes found in docs/api.md');
  assert.deepEqual([...named].filter((code) => !new RegExp(`['"\`]${code}['"\`]`).test(sources)), []);
});
