// The API explorer in headless Chrome: the real docs/api.md, with simulated API answers and sockets.
// Run: node tests/browser/api-explorer.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';
import { readFileSync } from 'node:fs';
import { endpoints, READS } from '../../web/api-doc.js';

const doc = readFileSync(new URL('../../docs/api.md', import.meta.url), 'utf8');
const reads = endpoints(doc).filter((e) => e.method === 'GET' && READS.has(e.path)).length;

const fake = `
window.testRequests = []; window.testSockets = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('/api/v1')) return realFetch(input, init);
  testRequests.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization ?? null });
  if (url === '/api/v1/sessions') return Response.json({ sessions: [{ id: 's1', name: 'Fix tests', status: 'running' }] });
  if (url === '/api/v1/sessions/s1/reply') return Response.json({ reply: { id: 1, text: '<img src=x onerror="window.testInjected = true">' } });
  return Response.json({ error: { code: 'not_found' } }, { status: 404 });
};
window.WebSocket = class {
  constructor(url) { this.url = url; this.sent = []; testSockets.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(data) { this.sent.push(data); }
  close() { setTimeout(() => this.onclose?.({ code: 1000 }), 0); }
};
`;

const checks = await withPage({ name: 'api-explorer' }, async ({ origin, send, evaluate, pass, errors, navigate }) => {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  const open = async (hash = '') => {
    await navigate('about:blank');
    await navigate(`${origin}/api.html${hash}`);
    await until('doc rendered', () => evaluate(`document.querySelector('#doc h1')?.textContent === 'Session manager API (v1)'`));
  };
  const panelFor = (path) => `[...document.querySelectorAll('#doc tbody tr')].find((r) => r.cells[1]?.textContent === ${JSON.stringify(path)}).nextElementSibling`;

  await open();
  assert.match(await evaluate(`document.querySelector('#note').textContent`), /^Open Agent Guild in this browser once/);
  assert.deepEqual(await evaluate('[testRequests.length, testSockets.length, document.querySelectorAll(".try").length]'), [0, 0, 0]);
  pass('without a sign-in the doc still reads, with nothing sent and nothing to try');

  await open('#token=t0k3n');
  assert.equal(await evaluate('location.href'), `${origin}/api.html`);
  assert.equal(await evaluate(`localStorage.getItem('agentGuild.token')`), 't0k3n');
  await until('session ids', () => evaluate(`document.querySelector('#session-ids option')?.value === 's1'`));
  assert.equal(await evaluate('document.querySelectorAll("#doc tr .try").length'), reads);
  assert.equal(await evaluate('document.querySelectorAll("#doc h3 + .try").length'), 2);
  assert.deepEqual(await evaluate(`[...new Set([...document.querySelectorAll('.try button')].map((b) => b.textContent))]`), ['Send GET', 'Connect']);
  assert.match(await evaluate(`[...document.querySelectorAll('#doc tbody tr')].find((r) => r.cells[1]?.textContent === '/providers/:id/flags').textContent`), /Not sent from here/);
  assert.equal(await evaluate(`${panelFor('/sessions/:id/stop')}?.querySelector('.try') ?? null`), null);
  pass('only the read-only GET routes and the two sockets can be tried; nothing that changes or does more than read');

  await evaluate(`(() => { const p = ${panelFor('/sessions/:id/reply')}; p.querySelector('input[name=id]').value = 's1'; p.querySelector('button').click(); })()`);
  await until('reply shown', () => evaluate(`${panelFor('/sessions/:id/reply')}.querySelector('pre').textContent.includes('onerror')`));
  assert.deepEqual(await evaluate('testRequests.at(-1)'), { url: '/api/v1/sessions/s1/reply', method: 'GET', auth: 'Bearer t0k3n' });
  assert.match(await evaluate(`${panelFor('/sessions/:id/reply')}.querySelector('.status').textContent`), /^200 /);
  assert.deepEqual(await evaluate('[document.querySelectorAll("#doc img").length, window.testInjected ?? false]'), [0, false]);
  pass('a GET goes with the token in its header, and its answer is shown as text, never HTML');

  const socketPanel = (n) => `document.querySelectorAll('#doc h3 + .try')[${n}]`;
  await evaluate(`${socketPanel(0)}.querySelector('button').click()`);
  await until('events listening', () => evaluate(`${socketPanel(0)}.querySelector('.status').textContent === 'Listening to /api/v1/events'`));
  await evaluate(`(() => {
    const s = testSockets[0];
    s.onmessage({ data: '{"type":"hello","name":"<b>bold</b>"}' });
    s.onmessage({ data: 'x'.repeat(5000) });
    for (let i = 0; i < 250; i++) s.onmessage({ data: '{"type":"session.updated","n":' + i + '}' });
  })()`);
  const log = await evaluate(`${socketPanel(0)}.querySelector('pre').textContent.split('\\n')`);
  assert.equal(log.length, 200);
  assert.equal(log.at(-1), '{"type":"session.updated","n":249}');
  await evaluate(`testSockets[0].onmessage({ data: '{"name":"<b>bold</b>"}' }); testSockets[0].onmessage({ data: 'y'.repeat(5000) })`);
  assert.equal(await evaluate(`${socketPanel(0)}.querySelectorAll('b').length`), 0);
  assert.match(await evaluate(`${socketPanel(0)}.querySelector('pre').textContent`), /\{"name":"<b>bold<\/b>"\}\ny{2048} … \(5000 characters\)$/);
  pass('the events socket shows its last 200 messages as text, each cut to 2 KB');

  await evaluate(`(() => { const p = ${socketPanel(1)}; p.querySelector('input[name=id]').value = 's1'; p.querySelector('button').click(); })()`);
  await until('terminal listening', () => evaluate(`${socketPanel(1)}.querySelector('.status').textContent === 'Listening to /api/v1/sessions/s1/terminal'`));
  const terminal = new URL(await evaluate('testSockets[1].url'));
  assert.deepEqual([terminal.protocol, terminal.pathname, [...terminal.searchParams.keys()]], ['ws:', '/api/v1/sessions/s1/terminal', ['token']]);
  await evaluate(`${socketPanel(1)}.querySelector('button').click()`);
  await until('terminal closed', () => evaluate(`${socketPanel(1)}.querySelector('.status').textContent === 'Closed (1000)'`));
  assert.deepEqual(await evaluate('testSockets.map((s) => s.sent.length)'), [0, 0]);
  pass('a terminal is opened without page, so it cannot claim or resize, and no socket is ever sent anything');

  assert.equal(await evaluate(`document.documentElement.outerHTML.includes('t0k3n') || document.body.innerText.includes('t0k3n')`), false);
  assert.deepEqual(await evaluate(`[...new Set(testRequests.map((r) => r.method + ' ' + r.auth))]`), ['GET Bearer t0k3n']);
  assert.deepEqual(errors, []);
  pass('the token is never on the page, and every request is a GET');
});
console.log(`${checks} API explorer checks passed.`);
