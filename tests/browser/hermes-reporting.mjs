// Headless Chrome: the Hermes Agent card's reporting switch, partial failure, and live activity kept apart from terminals.
// Run: node tests/browser/hermes-reporting.mjs (CHROME_PATH may name Chrome or Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
(() => {
  const demoFetch = window.fetch;
  const DemoSocket = window.WebSocket;
  const events = [];
  window.WebSocket = function (url) {
    const ws = new DemoSocket(url);
    if (/\\/events(?:\\?|$)/.test(String(url))) events.push(ws);
    return ws;
  };
  Object.assign(window.WebSocket, DemoSocket);
  window.WebSocket.prototype = DemoSocket.prototype;
  const hermes = { enabled: false, live: { default: null, work: null }, held: null };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const withHermes = async (res) => {
    const body = await res.json();
    const grok = body.providers.find((p) => p.id === 'xai');
    body.providers.push({
      ...grok, id: 'hermes', vendor: 'Nous Research', tool: 'Hermes Agent', command: 'hermes', monogram: 'H', iconUrl: null,
      reporting: 'hermes', reportingEnabled: hermes.enabled, reportingNote: hermes.note ?? null, mcp: null,
      memorySource: null, instructionsSource: null, historySource: null, usageSource: null, accountsEditable: false,
      accounts: [{ id: 'default', label: 'Default', live: hermes.live.default }, { id: 'work', label: 'work', live: hermes.live.work }],
    });
    return body;
  };
  window.__hermes = hermes;
  window.__push = (message) => { for (const ws of events) ws.emit({ data: JSON.stringify(message) }); };
  window.__pushProviders = async () => window.__push({ type: 'providers.updated', providers: (await withHermes(await demoFetch('/api/v1/providers'))).providers });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = ((init && init.method) || 'GET').toUpperCase();
    if (url.pathname === '/api/v1/providers' && method === 'GET') return json(await withHermes(await demoFetch(input, init)));
    if (url.pathname === '/api/v1/providers/hermes/reporting' && method === 'POST') {
      return new Promise((resolve) => { hermes.held = resolve; }).then(({ status, body }) => json(body, status));
    }
    return demoFetch(input, init);
  };
})();
</script>`;

const FAILED = 'The work profile failed: Hermes Agent could not install the Agent Guild plugin: it exited with code 1. Reporting is on for Default.';

const checks = await withPage({ name: 'hermes-reporting', instrumentation }, async ({ origin, evaluate, pass, errors, navigate }) => {
  const card = '.provider[data-id=hermes]';
  const read = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const shown = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el) && !el.hidden && el.getClientRects().length > 0; })()`);

  await navigate(origin);
  await until('the Hermes Agent card', () => shown(`${card} .reporting-row`));
  assert.equal(await read(`${card} .reporting-text`), 'Agent reporting off');
  assert.equal(await evaluate(`document.querySelector('${card} .reporting-open')`), null);
  assert.equal(await shown(`${card} .reporting-live`), false);
  assert.doesNotMatch(await evaluate(`document.querySelector('${card} .reporting-toggle').title`), /token/i);
  pass('reporting off: no Open action, no live list, no token wording');

  await evaluate(`document.querySelector('${card} .reporting-toggle').click()`);
  await until('the switch request held', () => evaluate('Boolean(window.__hermes.held)'));
  assert.equal(await read(`${card} .reporting-text`), 'Turning on…');
  assert.equal(await evaluate(`document.querySelector('${card} .reporting-toggle').disabled`), true);
  pass('turning on shows progress and locks the switch');

  await evaluate(`(async () => {
    window.__hermes.enabled = true;
    window.__hermes.note = 'Agent reporting is on for Default, not for work. Turn it off, then on, to try again.';
    window.__hermes.live.default = { working: 1, waiting: 0, agents: [{ id: 'hermes:s1', name: 'telegram', status: 'working', detail: '' }], shells: [] };
    await window.__pushProviders();
    const answer = window.__hermes.held; window.__hermes.held = null;
    answer({ status: 502, body: { error: { message: ${JSON.stringify(FAILED)}, code: 'reporting_setup_failed' } } });
  })()`);
  await until('the failure toast', async () => (await read('#toast')) === FAILED);
  await until('the switch released', () => evaluate(`!document.querySelector('${card} .reporting-toggle').disabled`));
  assert.equal(await read(`${card} .reporting-text`), 'Agent reporting is on for Default, not for work. Turn it off, then on, to try again.');
  assert.equal(await shown(`${card} .reporting-toggle`), true, 'the switch is shown');
  assert.equal(await read(`${card} .reporting-toggle`), 'Turn off', 'and offers Turn off');
  assert.equal(await shown(`${card} .reporting-live`), true);
  assert.equal(await read(`${card} .reporting-live-head`), 'Running in Hermes Agent, not in Agent Guild terminals. Shows sessions active since reporting started.');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${card} .reporting-live-profile')].map((el) => [el.querySelector('.reporting-live-label').textContent, [...el.querySelectorAll('.agent')].map((a) => a.title)])`),
    [['Default profile: 1 working, 0 waiting', ['telegram (working)']]]);
  pass('a failed profile names itself, the card offers Turn off, and the profile that reports keeps its live list');

  await evaluate(`(async () => {
    const { session: base } = await (await fetch('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ providerId: 'xai', cwd: 'demo' }) })).json();
    window.__push({ type: 'session.created', session: { ...base, id: 'he12e501', name: 'Hermes terminal', provider: { ...base.provider, id: 'hermes', tool: 'Hermes Agent' }, agents: [], shells: [], reporting: null, reply: null } });
  })()`);
  await until('the Hermes terminal card', () => shown('.session-card[data-id=he12e501]'));
  assert.equal(await evaluate(`document.querySelectorAll('.session-card[data-id=he12e501] .agents .agent').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('${card} .reporting-live .agent').length`), 1);
  pass('Hermes activity stays on the tool card, never on a Hermes terminal');

  await evaluate(`(async () => {
    window.__hermes.enabled = true;
    window.__hermes.note = null;
    window.__hermes.live.work = { working: 0, waiting: 1, agents: [{ id: 'hermes:c1', name: 'Map the code', status: 'waiting', detail: 'Map the code' }], shells: [] };
    await window.__pushProviders();
  })()`);
  await until('both profiles listed', () => evaluate(`document.querySelectorAll('${card} .reporting-live-profile').length === 2`));
  assert.equal(await read(`${card} .reporting-text`), 'Agent reporting on');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${card} .reporting-live-label:not(.reporting-live-head)')].map((el) => el.textContent)`),
    ['Default profile: 1 working, 0 waiting', 'work profile: 0 working, 1 waiting']);
  pass('with reporting on, every reporting profile is listed by name');

  assert.doesNotMatch(await evaluate(`document.querySelector('${card} .reporting-toggle').title`), /token/i);
  await evaluate(`document.querySelector('${card} .reporting-toggle').click()`);
  await until('the off request held', () => evaluate('Boolean(window.__hermes.held)'));
  assert.equal(await read(`${card} .reporting-text`), 'Turning off…');
  await evaluate(`(async () => {
    window.__hermes.enabled = false;
    window.__hermes.live = { default: null, work: null };
    await window.__pushProviders();
    const answer = window.__hermes.held; window.__hermes.held = null;
    answer({ status: 200, body: { provider: null } });
  })()`);
  await until('the off toast', async () => (await read('#toast')) === 'Agent reporting is off for Hermes Agent.');
  await until('the live list gone', async () => !(await shown(`${card} .reporting-live`)));
  assert.equal(await read(`${card} .reporting-text`), 'Agent reporting off');
  assert.deepEqual(errors, []);
  pass('turning off confirms it and clears the live list');
});

console.log(`ok ${checks} checks`);
