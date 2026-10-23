// The glasses page in headless Chrome at Meta Ray-Ban Display's 600x600 with spatial navigation, driven by arrows and Enter.
// Run: node tests/browser/glasses.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const fake = `
window.testRequests = []; window.testSockets = 0; window.testSpoken = []; window.testCancels = 0;
window.fetch = async (input, init = {}) => {
  const url = String(input), api = JSON.parse(sessionStorage.getItem('testApi') || '{}');
  testRequests.push({ url, auth: init.headers?.Authorization ?? null });
  if (api.fail) throw new TypeError('Failed to fetch');
  if (api.status) return new Response('{}', { status: api.status });
  if (url === '/api/v1/sessions') return Response.json({ sessions: api.sessions || [] });
  const reply = url.match(/^\\/api\\/v1\\/sessions\\/([^/]+)\\/reply$/);
  if (reply) return Response.json({ reply: api.replies?.[decodeURIComponent(reply[1])] ?? null });
  return new Response('{}', { status: 404 });
};
const RealSocket = window.WebSocket;
window.WebSocket = class extends RealSocket { constructor(...args) { super(...args); testSockets++; } };
Object.defineProperty(window, 'speechSynthesis', { value: { speak: (u) => testSpoken.push(u), cancel: () => { testCancels++; } } });
`;

const session = (id, name, label, reply = null) => ({ id, name, label, status: 'running', startedAt: 'T0', reply: reply && { id: reply } });
const sessions = [
  session('s1', 'Fix tests', 'Working', 1), session('s2', 'Docs', 'Running'), session('s3', 'Build', 'Exited'),
  session('s4', 'Lint', 'Running'), session('s5', 'Deploy', 'Running'), session('s6', 'Review', 'Closed'),
];
const replies = { s1: { id: 1, text: 'First line.\n\n```sh\nnpm test\n```\n\nRun it.', spoken: 'First line.\nCode omitted.\nRun it.' } };

const checks = await withPage({ name: 'glasses', chromeArgs: ['--enable-spatial-navigation'] }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 600, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  const codes = { ArrowUp: 38, ArrowDown: 40, Enter: 13, Escape: 27 };
  const key = async (name) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: codes[name] });
    if (name === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', key: name, code: name, windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name] });
    await layoutReady();
  };
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const focused = () => evaluate('document.activeElement.id || document.activeElement.querySelector(".name")?.textContent || document.activeElement.tagName');
  const setApi = (api) => evaluate(`sessionStorage.setItem('testApi', ${JSON.stringify(JSON.stringify(api))})`);
  const open = async (hash = '') => {
    await send('Page.navigate', { url: 'about:blank' });
    await until('blank', () => evaluate(`location.href === 'about:blank'`));
    await send('Page.navigate', { url: `${origin}/glasses.html${hash}` });
    await until('glasses page', () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#list-note'))`));
  };

  await open();
  await until('sign-in note', () => evaluate(`document.querySelector('#list-note').textContent.startsWith('Scan the code')`));
  assert.equal(await evaluate('testRequests.length'), 0);
  pass('without a token the page asks for the install code and makes no request');

  await setApi({ sessions, replies });
  await open('#token=t0k3n');
  await until('rows', () => evaluate(`document.querySelector('#list .row .name').textContent === 'Fix tests'`));
  assert.equal(await evaluate('location.href'), `${origin}/glasses.html`);
  assert.equal(await evaluate(`localStorage.getItem('agentGuild.token')`), 't0k3n');
  assert.deepEqual(await evaluate('[...new Set(testRequests.map((r) => r.auth))]'), ['Bearer t0k3n']);
  pass('the token leaves the address, is kept, and goes only in the Authorization header');

  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#list .row')].map((r) => r.hidden ? null : r.textContent)`),
    ['Fix testsWorking', 'DocsRunning', 'BuildExited', 'LintRunning']);
  assert.equal(await text('#count'), '1 of 6');
  assert.equal(await focused(), 'Fix tests');
  const fits = () => evaluate(`(() => {
    const d = document.documentElement;
    const inside = [...document.querySelectorAll('button')].filter((b) => b.checkVisibility()).every((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= 600 && r.right <= 600; });
    return d.scrollWidth <= 600 && d.scrollHeight <= 600 && inside;
  })()`);
  assert.equal(await fits(), true);
  pass('the list shows four sessions with their card labels, focused, with nothing scrolled or clipped');

  for (let i = 0; i < 4; i++) await key('ArrowDown');
  assert.equal(await focused(), 'Deploy');
  assert.equal(await text('#count'), '5 of 6');
  await key('ArrowUp');
  assert.equal(await focused(), 'Lint');
  pass('the arrows move through every session a page of rows at a time');

  await setApi({ sessions: sessions.map((s) => (s.id === 's4' ? { ...s, label: 'Working' } : s)), replies });
  await until('refreshed label', () => evaluate(`[...document.querySelectorAll('#list .row')].some((r) => r.textContent === 'LintWorking')`), 8000);
  assert.equal(await focused(), 'Lint');
  pass('a status change shows on the next refresh and keeps the selection');

  for (let i = 0; i < 3; i++) await key('ArrowUp');
  await key('Enter');
  assert.equal(await evaluate(`document.querySelector('#detail').hidden`), false);
  assert.deepEqual([await text('#detail-name'), await text('#detail-label'), await focused()], ['Fix tests', 'Working', 'listen']);
  assert.equal(await evaluate('history.state.session'), 's1');
  assert.equal(await fits(), true);
  await until('reply loaded', () => evaluate(`testRequests.some((r) => r.url === '/api/v1/sessions/s1/reply')`));
  await layoutReady();
  await key('Enter');
  await until('speaking', () => evaluate('testSpoken.length === 1'));
  assert.equal(await text('#listen'), 'Stop');
  await evaluate('testSpoken[0].onend()');
  await evaluate('testSpoken[1].onend()');
  assert.deepEqual(await evaluate('testSpoken.map((u) => u.text)'), ['First line.', 'Code omitted.', 'Run it.']);
  await key('Enter');
  assert.equal(await text('#listen'), 'Listen');
  assert.ok(await evaluate('testCancels > 0'));
  pass('Enter opens a session once; Listen speaks its spoken reply chunk by chunk and Stop ends it');

  await key('ArrowDown');
  assert.equal(await focused(), 'back');
  await key('Enter');
  await until('list again', () => evaluate(`!document.querySelector('#list').hidden`));
  assert.equal(await focused(), 'Fix tests');
  await key('ArrowDown');
  await key('Enter');
  await key('Enter');
  assert.equal(await text('#detail-note'), 'No answer to play yet.');
  await key('Escape');
  await until('list after Escape', () => evaluate(`!document.querySelector('#list').hidden`));
  pass('Back and Escape return to the list; a session without an answer says so');

  const listShown = () => evaluate(`!document.querySelector('#list').hidden && document.querySelector('#detail').hidden`);
  const detailShown = (name) => evaluate(`document.querySelector('#list').hidden && !document.querySelector('#detail').hidden && document.querySelector('#detail-name').textContent === ${JSON.stringify(name)}`);
  await key('ArrowUp');
  await key('Enter');
  await evaluate('history.back()');
  await until('list after history back', listShown);
  await evaluate('history.forward()');
  await until('detail after history forward', () => detailShown('Fix tests'));
  assert.equal(await focused(), 'listen');
  const entries = await evaluate('history.length');
  await key('Escape');
  await until('list after Back', listShown);
  await key('ArrowDown');
  await key('Enter');
  assert.equal(await detailShown('Docs'), true);
  await key('Escape');
  await until('list after Back from another session', listShown);
  assert.deepEqual([await evaluate('history.state'), await evaluate('history.length')], [null, entries]);
  pass('Forward restores the session it left, and Back returns to the list after opening another session');

  await key('ArrowUp');
  await key('Enter');
  const replyLoads = () => evaluate(`testRequests.filter((r) => r.url === '/api/v1/sessions/s1/reply').length`);
  await until('reply loaded before the restart', async () => (await replyLoads()) > 0);
  const loads = await replyLoads();
  await setApi({ sessions: sessions.map((s) => (s.id === 's1' ? { ...s, startedAt: 'T1' } : s)), replies: { s1: { id: 1, text: 'After the restart.', spoken: 'After the restart.' } } });
  await until('reply loaded after the restart', async () => (await replyLoads()) > loads, 8000);
  await layoutReady();
  const spokenBefore = await evaluate('testSpoken.length');
  await key('Enter');
  assert.deepEqual(await evaluate(`testSpoken.slice(${spokenBefore}).map((u) => u.text)`), ['After the restart.']);
  await key('Escape');
  await until('list after the restart check', listShown);
  pass('a restarted session whose new answer reuses the old number plays the new answer');

  await setApi({ sessions: [] });
  await open();
  await until('empty', () => evaluate(`document.querySelector('#list-note').textContent === 'No active sessions'`));
  await setApi({ fail: true });
  await open();
  await until('unreachable', () => evaluate(`document.querySelector('#list-note').textContent.startsWith('Can’t reach Agent Guild')`));
  await setApi({ status: 401 });
  await open();
  await until('signed out', () => evaluate(`document.querySelector('#list-note').textContent.startsWith('Scan the code')`));
  assert.equal(await evaluate(`localStorage.getItem('agentGuild.token')`), null);
  pass('no sessions, an unreachable manager and a rejected token each show their message');

  assert.equal(await evaluate('testSockets'), 0);
  assert.deepEqual(await evaluate(`testRequests.filter((r) => !/^\\/api\\/v1\\/sessions(\\/[^/]+\\/reply)?$/.test(r.url))`), []);
  assert.deepEqual(await evaluate(`performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => /xterm|app\\.js|terminal/.test(p))`), []);
  assert.deepEqual(errors, []);
  pass('the page opens no socket, loads no terminal, and requests only sessions and replies');
});
console.log(`${checks} glasses checks passed.`);
