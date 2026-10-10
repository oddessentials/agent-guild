// The phone view against a real manager and a real PTY: sign-in from the link,
// the attention-first list, a terminal that observes the manager's size, the
// touch keys, Fit, Stop, Remove, and a new or resumed session with the folder
// browser. Run: node tests/browser/mobile.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { until, withDialogClose, withPage } from './chrome.mjs';
import { START_TIMEOUT_MS } from '../../web/mobile/model.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-tool.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-mobile-test-'));
const savedEnv = { ...process.env }, nativeFetch = globalThis.fetch;
let ctx;

try {
  const work = path.join(home, 'work');
  for (const dir of ['alpha', 'beta/inner', '.hidden']) fs.mkdirSync(path.join(work, dir), { recursive: true });
  const beta = path.join(work, 'beta');
  // A history command of the test's own: one earlier session in beta, one with no folder.
  const history = path.join(home, 'history.mjs');
  fs.writeFileSync(history, `console.log(JSON.stringify({ sessions: [
    { id: 'earlier-1', title: 'Fix the login bug', cwd: ${JSON.stringify(beta)}, startedAt: '2026-10-01T13:26:53.713Z', updatedAt: '2026-10-01T13:49:28.000Z' },
    { id: 'earlier-2', title: 'Elsewhere', cwd: '', startedAt: '2026-10-02T13:26:53.713Z', updatedAt: '2026-10-02T13:49:28.000Z' },
  ] }));\n`);
  Object.assign(process.env, {
    AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: '0', AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1',
    AGENT_GUILD_ALLOWED_HOSTS: '', AGENT_GUILD_ALLOWED_ORIGINS: '',
  });
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [
    ...['anthropic', 'openai', 'google', 'xai', 'docker', 'shell'].map((id) => ({ id, enabled: false })),
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [fixture], versionArgs: [fixture, '--version'],
      resumeArgs: ['--resume', '{id}'], history: { command: process.execPath, args: [history] } },
  ] }));
  // The test needs no external feeds, provider accounts or network services.
  globalThis.fetch = (url, ...args) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('External fetch disabled in the phone view test');
    return nativeFetch(url, ...args);
  };
  const { startManager } = await import('../../src/manager/main.mjs');
  ctx = await startManager({ sessionDefaults: { killGraceMs: 500, activityIdleMs: 300 } });
  const sessionOf = (id) => ctx.manager.get(id).toJSON();

  const checks = await withPage({ name: 'mobile' }, async ({ send, evaluate, layoutReady, pass, errors }) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.cspViolations=[];
      document.addEventListener('securitypolicyviolation', e => cspViolations.push(e.effectiveDirective));
    ` });
    const point = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const tap = async (selector) => {
      const p = await point(selector);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const typeLine = async (text) => {
      await evaluate(`document.querySelector('#term-host .xterm-helper-textarea').focus()`);
      await send('Input.insertText', { text });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };
    const screen = () => evaluate(`document.querySelector('#term-host .xterm-screen')?.textContent || ''`);
    const openMenu = async () => { await tap('#menu-open'); await until('session menu', () => evaluate(`document.querySelector('#menu').open`)); };
    const confirmYes = async () => {
      await until('confirmation', () => evaluate(`document.querySelector('#confirm').open`));
      await withDialogClose(evaluate, '#confirm', () => tap('#confirm-yes'));
    };
    const capture = async (name) => {
      if (!process.env.MOBILE_SCREENSHOTS) return;
      fs.mkdirSync(process.env.MOBILE_SCREENSHOTS, { recursive: true });
      await layoutReady();
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.MOBILE_SCREENSHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    };
    /** A sheet and everything in it stays inside the phone's width; nothing scrolls sideways or is cut off. */
    const fits = async (selector) => {
      await layoutReady();
      const measured = await evaluate(`(() => { const d=document.querySelector(${JSON.stringify(selector)}); const r=d.getBoundingClientRect();
        const out=[...d.querySelectorAll('*')].filter(e=>e.offsetParent!==null||e===d).map(e=>e.getBoundingClientRect()).filter(b=>b.left<0||b.right>innerWidth+0.5).length;
        return { left:r.left, right:r.right, width:innerWidth, overflow:d.scrollWidth>d.clientWidth, outside:out }; })()`);
      assert.ok(measured.left >= 0 && measured.right <= measured.width && !measured.overflow && measured.outside === 0, `${selector} ${JSON.stringify(measured)}`);
    };

    // Without the manager: the list says so instead of "No sessions", and New waits for it.
    const { identifier: offline } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.fetch = () => Promise.reject(new TypeError('offline'));
      window.WebSocket = class extends WebSocket { constructor(url) { super(String(url).replace(location.host, '127.0.0.1:9')); } };
    ` });
    await send('Page.navigate', { url: `${ctx.api.url}/mobile/#token=${ctx.token}` });
    await until('not connected', () => evaluate(`Boolean(document.querySelector('#empty')?.textContent.startsWith('Not connected') && !document.querySelector('#empty').hidden)`));
    assert.equal(await evaluate(`document.querySelector('#new-open').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#auth').hidden`), true, 'an unreachable manager is not a rejected token');
    pass('without the manager the list says it is not connected, not that there are no sessions');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: offline });
    // A new document: navigating to the same page with only a new fragment would not load it again.
    await send('Page.navigate', { url: 'about:blank' });
    await until('blank', () => evaluate('location.href === "about:blank"'));

    await send('Page.navigate', { url: `${ctx.api.url}/mobile/#token=${ctx.token}` });
    await until('sessions list', () => evaluate(`document.querySelector('#list')?.hidden===false && document.querySelector('#auth')?.hidden===true`));
    assert.equal(await evaluate('location.hash'), '');
    assert.equal(await evaluate(`localStorage.getItem('agentGuild.token')`), ctx.token);
    await until('connected', () => evaluate(`document.querySelector('#connection').classList.contains('ok')`));
    assert.equal(await evaluate(`document.querySelector('#empty').hidden`), false);
    assert.equal(await evaluate(`document.querySelector('#full-page').getAttribute('href')`), '/');
    assert.equal(await evaluate(`fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.headers.get('content-type'))`), 'application/manifest+json; charset=utf-8');
    await capture('empty');
    pass('the sign-in link opens the phone view, keeps the token out of the address bar and connects');

    const session = await ctx.manager.create({ providerId: 'fake', cwd: work, name: 'Phone test' });
    const row = `#sessions .row[data-id="${session.id}"]`;
    await until('row from live events', () => evaluate(`document.querySelector('${row} .name')?.textContent==='Phone test'`));
    await until('quiet after the first output', () => evaluate(`document.querySelector('${row} .chip').textContent==='Quiet'`));
    assert.equal(await evaluate(`document.querySelector('${row} .meta').textContent`), 'work');
    assert.equal(await evaluate(`document.querySelector('${row}').classList.contains('attention')`), true);
    await capture('list');
    pass('a session arrives through live events and reads as quiet once its output pauses');

    await tap(`${row} .row-button`);
    await until('terminal shown', () => evaluate(`!document.querySelector('#terminal').hidden && document.querySelector('#list').hidden`));
    await until('terminal screen', async () => (await screen()).includes('FAKE-TOOL READY'));
    await until('keys ready', () => evaluate(`!document.querySelector('#terminal-controls [data-key=Enter]').disabled`));
    await layoutReady();
    assert.equal(await evaluate(`document.querySelector('#terminal-name').textContent`), 'Phone test');
    const before = sessionOf(session.id);
    assert.deepEqual([before.cols, before.rows, before.attachedClients], [120, 32, 1]);
    assert.equal(await evaluate(`document.querySelector('#term-host .xterm-rows').children.length`), 32);
    assert.ok(await evaluate(`document.querySelector('#term-host').scrollWidth > document.querySelector('#term-host').clientWidth`), 'a 120-column terminal pans sideways on a phone');
    assert.equal(await evaluate(`document.querySelector('#fit-badge').hidden`), true);
    await capture('terminal');
    pass('opening a session observes the manager\'s terminal size instead of resizing it for everyone');

    await typeLine('size');
    await until('size answered', async () => (await screen()).includes('SIZE:120x32'));
    await typeLine('echo phone-input');
    await until('echo', async () => (await screen()).includes('ECHO:phone-input'));
    pass('typed input reaches the real PTY and output comes back');

    await openMenu();
    assert.equal(await evaluate(`document.querySelector('#copy-open').hidden`), false);
    await withDialogClose(evaluate, '#menu', () => tap('#copy-open'));
    await until('copy sheet', () => evaluate(`document.querySelector('#terminal-copy').open && document.querySelector('#terminal-copy textarea').value.includes('ECHO:phone-input')`));
    assert.equal(await evaluate(`document.querySelector('#terminal-copy-status').textContent`), 'Touch and hold to select text.');
    assert.equal(await evaluate(`document.querySelector('#terminal-copy [data-session]').textContent`), 'Phone test');
    assert.equal(await evaluate(`document.querySelector('#terminal-controls [data-key=Enter]').disabled`), true, 'keys rest while the sheet is open');
    await fits('#terminal-copy');
    await capture('copy');
    await withDialogClose(evaluate, '#terminal-copy', () => tap('#terminal-copy [data-done]'));
    assert.equal(await evaluate(`document.querySelector('#terminal-copy textarea').value`), '');
    await until('keys back', () => evaluate(`!document.querySelector('#terminal-controls [data-key=Enter]').disabled`));
    pass('Copy text… shows the screen as selectable text, rests the keys, and clears when done');

    if (await evaluate('Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)')) {
      assert.equal(await evaluate(`document.querySelector('#dictate').hidden`), false);
      await tap('#dictate');
      await until('dictation note', () => evaluate(`document.querySelector('#confirm').open && document.querySelector('#confirm-title').textContent.startsWith('Dictate')`));
      assert.deepEqual(await evaluate(`[document.querySelector('#confirm-yes').classList.contains('primary'), document.querySelector('#confirm-yes').classList.contains('danger')]`), [true, false], 'dictating is not destructive');
      await fits('#confirm');
      await capture('dictate-note');
      await withDialogClose(evaluate, '#confirm', () => tap('#confirm-no'));
      assert.equal(await evaluate(`document.querySelector('#dictate').getAttribute('aria-pressed')`), 'false');
      assert.equal(await evaluate(`localStorage.getItem('agentGuild.mobile.voiceNote')`), null);
      assert.equal(await evaluate(`document.querySelector('#voice-preview').hidden`), true);
      pass('Dictate asks once before anything is heard, and declining starts nothing');
    } else {
      assert.equal(await evaluate(`document.querySelector('#dictate').hidden`), true);
      pass('without a speech API the Dictate button stays out of the way');
    }

    for (const mode of ['normal', 'application']) {
      await typeLine(`keys 14 ${mode}`);
      await until('PTY reading keys', async () => (await screen()).includes(`KEYS-READY:${mode}`));
      for (const name of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter', 'Escape']) await tap(`#terminal-controls [data-key="${name}"]`);
      const prefix = mode === 'application' ? 79 : 91;
      const received = `KEYS:${JSON.stringify([27, prefix, 68, 27, prefix, 65, 27, prefix, 66, 27, prefix, 67, 13, 27])}`;
      await until(`PTY received ${mode} keys`, async () => (await screen()).includes(received));
    }
    await typeLine('keys 1 normal');
    await until('PTY reading one key', async () => (await screen()).includes('KEYS-READY:normal') && !(await screen()).includes('KEYS:[9]'));
    await tap('#key-tab');
    await until('Tab received', async () => (await screen()).includes('KEYS:[9]'));
    pass('the six touch keys and Tab reach the PTY in both cursor modes');

    await openMenu();
    assert.match(await evaluate(`document.querySelector('#fit-help').textContent`), /120×32/);
    assert.equal(await evaluate(`document.querySelector('#fit-toggle').getAttribute('aria-pressed')`), 'false');
    await fits('#menu');
    await capture('menu');
    await withDialogClose(evaluate, '#menu', () => tap('#fit-toggle'));
    await until('fitted to the phone', () => sessionOf(session.id).cols < 120);
    await until('fitted badge', () => evaluate(`!document.querySelector('#fit-badge').hidden`));
    const fitted = sessionOf(session.id);
    assert.ok(fitted.cols >= 20 && fitted.rows >= 10, JSON.stringify(fitted));
    // A Node child inside ConPTY can keep reporting its old size (see manager.test.mjs); the manager's size is the check there.
    if (process.platform !== 'win32') {
      await typeLine('size');
      await until('PTY sees the phone size', async () => (await screen()).includes(`SIZE:${fitted.cols}x${fitted.rows}`));
    }
    await capture('fitted');
    pass('Fit resizes the PTY to the phone on purpose and says so');

    ctx.manager.get(session.id).resize(100, 30);
    await until('fit yields to another client', () => evaluate(`document.querySelector('#fit-badge').hidden && document.querySelector('#toast').textContent.includes('Another client')`));
    await until('the other size is shown', () => evaluate(`document.querySelector('#term-host .xterm-rows').children.length===30`));
    assert.deepEqual([sessionOf(session.id).cols, sessionOf(session.id).rows], [100, 30]);
    pass('a resize from another client ends fitting and the phone shows that size');

    await openMenu();
    await withDialogClose(evaluate, '#menu', () => tap('#fit-toggle'));
    await until('fitted again', () => sessionOf(session.id).cols < 100);
    await openMenu();
    assert.equal(await evaluate(`document.querySelector('#fit-toggle').getAttribute('aria-pressed')`), 'true');
    await withDialogClose(evaluate, '#menu', () => tap('#fit-toggle'));
    await until('size given back', () => { const s = sessionOf(session.id); return s.cols === 100 && s.rows === 30; });
    assert.equal(await evaluate(`document.querySelector('#fit-badge').hidden`), true);
    pass('stopping Fit gives the terminal back the size the manager had');

    await openMenu();
    await withDialogClose(evaluate, '#menu', () => tap('#fit-toggle'));
    await until('fitted once more', () => sessionOf(session.id).cols < 100);
    await tap('#back');
    await until('size given back on leaving', () => { const s = sessionOf(session.id); return s.cols === 100 && s.rows === 30; });
    await tap(`${row} .row-button`);
    await until('terminal again', () => evaluate(`!document.querySelector('#terminal').hidden`));
    await until('keys ready again', () => evaluate(`!document.querySelector('#terminal-controls [data-key=Enter]').disabled`));
    assert.equal(await evaluate(`document.querySelector('#fit-badge').hidden`), true);
    pass('leaving a fitted terminal gives the computer its size back');

    await openMenu();
    assert.equal(await evaluate(`document.querySelector('#remove').hidden`), true);
    await withDialogClose(evaluate, '#menu', () => tap('#stop'));
    await until('confirmation', () => evaluate(`document.querySelector('#confirm').open`));
    assert.deepEqual(await evaluate(`[document.querySelector('#confirm-yes').classList.contains('primary'), document.querySelector('#confirm-yes').classList.contains('danger')]`), [false, true], 'stopping is destructive');
    await fits('#confirm');
    await confirmYes();
    await until('exited', () => sessionOf(session.id).status === 'exited');
    await until('exit line', async () => (await screen()).includes('[process exited with'));
    await until('header says exited', () => evaluate(`document.querySelector('#terminal-state').textContent.startsWith('Exited')`));
    await until('keys disabled', () => evaluate(`document.querySelector('#terminal-controls [data-key=Enter]').disabled`));
    pass('Stop asks first, ends the tool and disables the keys');

    await openMenu();
    assert.equal(await evaluate(`document.querySelector('#remove').hidden`), false);
    assert.equal(await evaluate(`document.querySelector('#stop').hidden`), true);
    await withDialogClose(evaluate, '#menu', () => tap('#remove'));
    await confirmYes();
    await until('back on the list', () => evaluate(`!document.querySelector('#list').hidden && document.querySelector('#terminal').hidden`));
    await until('list empty', () => evaluate(`document.querySelectorAll('#sessions .row').length===0 && !document.querySelector('#empty').hidden`));
    assert.equal(ctx.manager.sessions.size, 0);
    pass('Remove asks first, removes the session on the manager and returns to the list');

    await tap('#new-open');
    await until('new sheet', () => evaluate(`document.querySelector('#new').open`));
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#new-providers .choice-btn')].map(b=>b.dataset.id)`), ['fake']);
    assert.equal(await evaluate(`document.querySelector('#new-cwd').value`), '');
    await tap('#new-existing');
    await until('earlier sessions listed', () => evaluate(`[...document.querySelectorAll('#new-history li button')].length===2`));
    await fits('#new');
    await capture('new');
    await evaluate(`{ const cwd=document.querySelector('#new-cwd'); cwd.value=${JSON.stringify(work)}; }`);
    await tap('#new-browse');
    await until('folder browser', () => evaluate(`document.querySelector('#folders').open && document.querySelector('#folder-current').textContent===${JSON.stringify(work)}`));
    await until('folders listed', () => evaluate(`[...document.querySelectorAll('#folder-list button')].map(b=>b.textContent).join()==='alpha,beta'`));
    await tap('#folder-hidden');
    await until('hidden folders shown', () => evaluate(`[...document.querySelectorAll('#folder-list button')].map(b=>b.textContent).join()==='.hidden,alpha,beta'`));
    await tap('#folder-hidden');
    await until('hidden folders hidden', () => evaluate(`[...document.querySelectorAll('#folder-list button')].map(b=>b.textContent).join()==='alpha,beta'`));
    await fits('#folders');
    await capture('folders');
    await tap('#folder-list li:nth-child(2) button');
    await until('inside beta', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(beta)} && [...document.querySelectorAll('#folder-list button')].map(b=>b.textContent).join()==='inner'`));
    await tap('#folder-up');
    await until('back up', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(work)}`));
    await tap('#folder-list li:nth-child(2) button');
    await until('inside beta again', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(beta)}`));
    await withDialogClose(evaluate, '#folders', () => tap('#folder-use'));
    assert.equal(await evaluate(`document.querySelector('#new-cwd').value`), beta);
    // The manager can take a while over a start (a tool's first session waits for its hook probe). The request is held
    // here until released: meanwhile the sheet says it is starting, takes no second start, and the request has the
    // longer budget, so a slow start is never reported as a failure to try again.
    await evaluate(`(() => {
      window.budgets = []; window.starts = 0; window.held = null;
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms) => { budgets.push(ms); return timeout(ms); };
      const fetch = window.fetch;
      window.fetch = (url, init) => {
        if (init?.method !== 'POST' || !String(url).endsWith('/api/v1/sessions')) return fetch(url, init);
        starts += 1;
        return new Promise((resolve) => { held = () => { window.fetch = fetch; resolve(fetch(url, init)); }; });
      };
    })()`);
    await tap('#new-start');
    await until('start held', () => evaluate(`typeof held === 'function'`));
    assert.deepEqual(await evaluate(`[document.querySelector('#new-start').textContent, document.querySelector('#new-start').disabled, budgets]`), ['Starting…', true, [START_TIMEOUT_MS]]);
    await evaluate(`{ const cwd = document.querySelector('#new-cwd'); cwd.focus(); cwd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }`);
    await tap('#new-start');
    assert.equal(await evaluate(`starts`), 1, 'Enter in the folder field and another tap start nothing more while a start is pending');
    assert.equal(await evaluate(`document.querySelector('#new').open`), true);
    await withDialogClose(evaluate, '#new', () => evaluate(`held()`));
    assert.deepEqual(await evaluate(`[document.querySelector('#new-start').textContent, document.querySelector('#new-start').disabled, document.querySelector('#new-error').hidden]`), ['Start', false, true]);
    await until('session started in the chosen folder', () => [...ctx.manager.sessions.values()].some((s) => s.toJSON().cwd === beta));
    await until('terminal opened', () => evaluate(`!document.querySelector('#terminal').hidden`));
    await until('ready in beta', async () => (await screen()).includes(`cwd=${beta}`));
    await until('started fitted', () => evaluate(`!document.querySelector('#fit-badge').hidden`));
    const started = [...ctx.manager.sessions.values()].find((s) => s.toJSON().cwd === beta).toJSON();
    assert.ok(started.cols < 80, `a session started on the phone is sized for it: ${started.cols}×${started.rows}`);
    assert.deepEqual(JSON.parse(await evaluate(`localStorage.getItem('agentGuild.recentCwds')`)), [beta]);
    assert.equal(await evaluate(`localStorage.getItem('agentGuild.mobile.cwd')`), beta);
    pass('New starts a session sized for the phone in a folder picked with the browser, and remembers the folder for the full page');

    await tap('#back');
    await until('list again', () => evaluate(`!document.querySelector('#list').hidden && document.querySelector('#terminal').hidden`));
    assert.equal(await evaluate(`document.querySelectorAll('#sessions .row').length`), 1);
    await tap('#new-open');
    await until('new sheet again', () => evaluate(`document.querySelector('#new').open`));
    assert.equal(await evaluate(`document.querySelector('#new-cwd').value`), beta);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#new-recent .btn')].map(b=>b.title)`), [beta]);
    await tap('#new-existing');
    await until('earlier session in this folder', () => evaluate(`[...document.querySelectorAll('#new-history li button')].length===1 && document.querySelector('#new-history li button').textContent.startsWith('Fix the login bug')`));
    await withDialogClose(evaluate, '#new', () => tap('#new-history li button'));
    await until('resumed session', () => [...ctx.manager.sessions.values()].some((s) => s.toJSON().resume === 'earlier-1'));
    await until('resumed terminal', async () => (await screen()).includes(`cwd=${beta}`));
    await typeLine('args');
    await until('resume arguments', async () => (await screen()).includes('"--resume","earlier-1"'));
    pass('Resume an earlier session starts the tool in its folder with its resume arguments');

    await tap('#back');
    await until('list once more', () => evaluate(`!document.querySelector('#list').hidden`));
    assert.equal(await evaluate(`document.querySelectorAll('#sessions .row').length`), 2);
    await evaluate(`document.querySelector('#more').click()`);
    await until('menu shown', () => evaluate(`document.querySelector('#more-menu').matches(':popover-open')`));
    await evaluate(`document.querySelector('#sign-out').click()`);
    await until('signed out', () => evaluate(`!document.querySelector('#auth').hidden && document.querySelector('#list').hidden`));
    assert.equal(await evaluate(`localStorage.getItem('agentGuild.token')`), null);
    const submit = (value) => evaluate(`{ document.querySelector('#auth-token').value=${JSON.stringify(value)}; document.querySelector('#auth-form').requestSubmit(); }`);
    await submit('not a token at all');
    await until('refused', () => evaluate(`document.querySelector('#auth-error').textContent.includes('Paste')`));
    await submit('https://guild.example.ts.net/mobile/#token=wrong');
    await until('rejected', () => evaluate(`document.querySelector('#auth-error').textContent.includes('rejected')`));
    await submit(`${ctx.api.url}/mobile/#token=${ctx.token}`);
    await until('signed in again', () => evaluate(`!document.querySelector('#list').hidden && document.querySelector('#connection').classList.contains('ok')`));
    await until('both sessions listed', () => evaluate(`document.querySelectorAll('#sessions .row').length===2`));
    pass('sign-out forgets the token; a pasted sign-in link signs in again');

    assert.deepEqual(await evaluate('cspViolations'), []);
    assert.deepEqual(errors, []);
    pass('no CSP violations or page errors');
  });
  console.log(`${checks} phone view checks passed`);
} finally {
  await ctx?.shutdown('phone view test finished');
  globalThis.fetch = nativeFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // As in manager.test.mjs, ConPTY can retain a handle after all PTYs exit.
  if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
}
