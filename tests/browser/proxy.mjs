// Real UI, API, event/terminal sockets and PTY through an HTTPS reverse proxy.
// Run: node tests/browser/proxy.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { until, withPage } from './chrome.mjs';
import { Tailscale, runTailscale } from '../../src/manager/tailscale.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-tool.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-proxy-test-'));
const savedEnv = { ...process.env }, nativeFetch = globalThis.fetch;
let ctx;
const sockets = new Set(), upgrades = [];
// A signed-in GitHub account with no repositories, so the Clone into field shows without contacting GitHub.
let fakeGitHub = false;
const fetchedAt = new Date().toISOString();
const githubAnswers = {
  '/api/v1/github': () => ({ github: { scopes: ['repo'], appUrl: '', keysUrl: '', newKeyUrl: '', tools: { git: true, ssh: true, sshKeygen: true }, signIn: null,
    accounts: [{ id: 1001, login: 'phone-dev', name: 'Phone Dev', avatar: null, scopes: ['repo'], needsSignIn: false, addedAt: fetchedAt,
      ssh: { status: 'ready', key: 'test-key', publicKey: 'ssh-ed25519 TEST', verifiedAt: fetchedAt, settingUp: false, error: null } }] } }),
  '/api/v1/github/repos': () => ({ repos: [], truncated: false, errors: [], fetchedAt }),
  '/api/v1/github/accounts/1001/repos': (url) => ({ repos: { accountId: 1001, fetchedAt, truncated: false, owners: [], parent: url.searchParams.get('parent'), repos: [] } }),
};
// These public test fixtures confer no trust. Only this disposable browser
// ignores their self-signed certificate; CSP and request validation stay on.
const proxy = https.createServer({
  key: fs.readFileSync(new URL('../fixtures/proxy-test-key.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('../fixtures/proxy-test-cert.pem', import.meta.url)),
}, (req, res) => {
  const simulated = req.method === 'GET' && githubAnswers[new URL(req.url, 'https://localhost').pathname];
  if (fakeGitHub && simulated) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(simulated(new URL(req.url, 'https://localhost'))));
  }
  const upstream = http.request(`${ctx.api.url}${req.url}`, { method: req.method, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
proxy.on('connection', track);
proxy.on('upgrade', (req, socket, head) => {
  upgrades.push({ path: new URL(req.url, 'https://localhost').pathname, host: req.headers.host, origin: req.headers.origin });
  const upstream = track(net.connect(ctx.api.port, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((lines, value, i) => lines + value + (i % 2 ? '\r\n' : ': '), '')}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  }));
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});

try {
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const authority = `guild.example.ts.net:${proxy.address().port}`, origin = `https://${authority}`;
  Object.assign(process.env, {
    AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: '0', AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1',
    AGENT_GUILD_ALLOWED_HOSTS: authority, AGENT_GUILD_ALLOWED_ORIGINS: origin,
  });
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [
    ...['anthropic', 'openai', 'google', 'xai', 'shell'].map((id) => ({ id, enabled: false })),
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [fixture], versionArgs: [fixture, '--version'] },
  ] }));
  // The test needs no external feeds, provider accounts or network services.
  globalThis.fetch = (url, ...args) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('External fetch disabled in proxy test');
    return nativeFetch(url, ...args);
  };
  const { startManager } = await import('../../src/manager/main.mjs');
  const tailFile = path.join(home, 'tailscale.json');
  const tailFixture = fileURLToPath(new URL('../fixtures/fake-tailscale.mjs', import.meta.url));
  fs.writeFileSync(tailFile, '{}');
  const tailscale = new Tailscale({ env: { ...process.env, FAKE_TAILSCALE_STATE: tailFile }, find: () => process.execPath,
    run: (exe, args, options) => runTailscale(exe, [tailFixture, ...args], options) });
  ctx = await startManager({ sessionDefaults: { killGraceMs: 500 }, remoteAccess: { tailscale, probe: async () => ({ ok: true, checkedAt: new Date().toISOString() }) } });
  fs.writeFileSync(tailFile, JSON.stringify({ config: {
    TCP: { [proxy.address().port]: { HTTPS: true } }, Web: { [authority]: { Handlers: { '/': { Proxy: ctx.api.url } } } },
  } }));
  assert.equal(ctx.api.server.address().address, '127.0.0.1');

  const checks = await withPage({ name: 'proxy', chromeArgs: [
    '--host-resolver-rules=MAP guild.example.ts.net 127.0.0.1', '--no-proxy-server',
  ] }, async ({ send, evaluate, layoutReady, pass, errors }) => {
    await send('Security.setIgnoreCertificateErrors', { ignore: true });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.cspViolations=[];
      document.addEventListener('securitypolicyviolation', e => cspViolations.push(e.effectiveDirective));
    ` });
    await send('Page.navigate', { url: origin });
    await until('remote sign-in', () => evaluate(`document.querySelector('#auth')?.checkVisibility()`));
    assert.equal(await evaluate('location.origin'), origin);
    pass('HTTPS proxy serves the real UI while the manager remains on loopback');

    const signIn = (token) => evaluate(`{
      document.querySelector('#auth-token').value=${JSON.stringify(token)};
      document.querySelector('#auth-form').requestSubmit();
    }`);
    await signIn('wrong-token');
    await until('invalid token feedback', () => evaluate(`document.querySelector('#auth-error').textContent.includes('rejected')`));
    assert.equal(await evaluate(`document.querySelector('#auth').checkVisibility()`), true);
    pass('proxy access still requires the manager token');
    await signIn(ctx.token);
    await until('live events', () => evaluate(`document.querySelector('#connection')?.classList.contains('ok')`));
    pass('authenticated event WebSocket connects over HTTPS');

    // Starting on the manager side proves the card arrives through live events.
    const session = await ctx.manager.create({ providerId: 'fake', cwd: home, name: 'Proxy test' });
    await until('session event renders', () => evaluate(`document.querySelector('#sessions .session-card .name')?.textContent==='Proxy test'`));
    await evaluate(`document.querySelector('#sessions .session-card .open').click()`);
    await until('terminal output', () => evaluate(`document.querySelector('.xterm-screen')?.textContent.includes('FAKE-TOOL READY')`));
    await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
    await send('Input.insertText', { text: 'echo proxy-input' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until('terminal round trip', () => evaluate(`document.querySelector('.xterm-screen')?.textContent.includes('ECHO:proxy-input')`));
    pass('terminal WebSocket carries keyboard input and real PTY output');

    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await until('touch keys enabled', () => evaluate('!document.querySelector("#terminal-controls [data-key=Enter]").disabled'));
    for (const mode of ['normal', 'application']) {
      await evaluate('document.querySelector(".xterm-helper-textarea").focus()');
      await send('Input.insertText', { text: `keys 14 ${mode}` });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until('PTY reading keys', () => evaluate(`document.querySelector('.xterm-screen').textContent.includes('KEYS-READY:${mode}')`));
      for (const name of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter', 'Escape']) {
        const point = await evaluate(`(()=>{const r=document.querySelector('#terminal-controls [data-key="${name}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      const prefix = mode === 'application' ? 79 : 91;
      const received = `KEYS:${JSON.stringify([27, prefix, 68, 27, prefix, 65, 27, prefix, 66, 27, prefix, 67, 13, 27])}`;
      await until(`PTY received ${mode} keys`, () => evaluate(`document.querySelector('.xterm-screen').textContent.includes(${JSON.stringify(received)})`));
    }
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    pass('all six trusted touch keys round trip through HTTPS and a real PTY in both cursor modes');

    const renamed = await evaluate(`fetch('/api/v1/sessions/${session.id}', {
      method:'PATCH', headers:{Authorization:${JSON.stringify(`Bearer ${ctx.token}`)},'Content-Type':'application/json'},
      body:JSON.stringify({name:'Proxy renamed'})
    }).then(r=>r.status)`);
    assert.equal(renamed, 200);
    await until('rename event', () => evaluate(`document.querySelector('#sessions .session-card .name')?.textContent==='Proxy renamed'`));
    pass('authenticated API writes and their live updates work through the proxy');
    assert.ok(upgrades.some((entry) => entry.path === '/api/v1/events'));
    assert.ok(upgrades.some((entry) => entry.path === `/api/v1/sessions/${session.id}/terminal`));
    assert.ok(upgrades.every((entry) => entry.host === authority && entry.origin === origin));
    assert.deepEqual(await evaluate('cspViolations'), []);
    assert.deepEqual(errors, []);
    pass('both socket paths preserve the configured Host and Origin without CSP violations');

    const tree = path.join(home, 'browse');
    for (const dir of ['alpha/inner', 'beta', '.hidden']) fs.mkdirSync(path.join(tree, dir), { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate(`document.querySelector('#cwd-open').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#cwd-open').title`), 'Only available on the computer running Agent Guild.');
    await evaluate(`{ const cwd=document.querySelector('#cwd'); cwd.value=${JSON.stringify(path.join(tree, 'beta', 'missing'))}; document.querySelector('#cwd-pick').click(); }`);
    await until('folder browser falls back to the nearest folder', () => evaluate(`document.querySelector('#folder-browser').open && document.querySelector('#folder-current').textContent===${JSON.stringify(path.join(tree, 'beta'))} && !document.querySelector('#folder-note').hidden`));
    await evaluate(`document.querySelector('#folder-up').click()`);
    await until('parent folder listed', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(tree)} && document.querySelectorAll('#folder-list .folder-row').length===2`));
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#folder-list .folder-row')].map(r=>r.textContent)`), ['alpha', 'beta']);
    const fit = await evaluate(`(() => { const d=document.querySelector('#folder-browser'),r=d.getBoundingClientRect(),rows=[...d.querySelectorAll('.folder-row')]; return {left:r.left,right:r.right,width:innerWidth,overflow:d.scrollWidth>d.clientWidth,rowHeight:Math.min(...rows.map(e=>e.offsetHeight))}; })()`);
    assert.ok(fit.left >= 0 && fit.right <= fit.width && !fit.overflow && fit.rowHeight >= 44, JSON.stringify(fit));
    await evaluate(`document.querySelector('#folder-hidden').click()`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#folder-list .folder-row')].map(r=>r.textContent)`), ['.hidden', 'alpha', 'beta']);
    await evaluate(`document.querySelector('#folder-hidden').click(); document.querySelector('#folder-list .folder-row').click()`);
    await until('child folder listed', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(path.join(tree, 'alpha'))}`));
    await evaluate(`document.querySelector('#folder-use').click()`);
    assert.equal(await evaluate(`document.querySelector('#folder-browser').open`), false);
    assert.equal(await evaluate(`document.querySelector('#cwd').value`), path.join(tree, 'alpha'));
    await evaluate(`{ document.querySelector('#github-parent').value=${JSON.stringify(tree)}; document.querySelector('#github-parent-pick').click(); }`);
    await until('clone folder browser', () => evaluate(`document.querySelector('#folder-title').textContent==='Choose clone folder' && document.querySelector('#folder-current').textContent===${JSON.stringify(tree)} && !document.querySelector('#folder-use').disabled`));
    await evaluate(`document.querySelector('#folder-new-open').click()`);
    assert.equal(await evaluate(`document.activeElement.id`), 'folder-new-name');
    const made = path.join(tree, 'clones & co');
    for (const skin of await evaluate(`window.agentGuildSkins.map(s=>s.id)`)) {
      for (const theme of ['light', 'dark']) {
        await evaluate(`{ const root=document.documentElement; root.dataset.skin=${JSON.stringify(skin)}; root.dataset.theme=${JSON.stringify(theme)}; }`);
        await layoutReady();
        await evaluate(`Promise.all(document.querySelector('#folder-browser').getAnimations({subtree:true}).filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
        const sized = await evaluate(`(() => { const d=document.querySelector('#folder-browser'),r=d.getBoundingClientRect();
          const controls=['#folder-up','#folder-home','#folder-roots .btn','#folder-new-open','#folder-new-name','#folder-new-create','#folder-new-cancel','#folder-use','#folder-cancel'].map(s=>[s,document.querySelector(s)]);
          return {left:r.left,right:r.right,width:innerWidth,overflow:d.scrollWidth>d.clientWidth,short:controls.filter(([,e])=>e.offsetHeight<44).map(([s])=>s),outside:controls.filter(([,e])=>{const b=e.getBoundingClientRect();return b.left<0||b.right>innerWidth;}).map(([s])=>s)}; })()`);
        assert.ok(sized.left >= 0 && sized.right <= sized.width && !sized.overflow && !sized.outside.length && !sized.short.length, `${skin} ${theme} ${JSON.stringify(sized)}`);
      }
    }
    await evaluate(`{ const root=document.documentElement; root.dataset.skin='guild'; root.dataset.theme='light'; }`);
    await send('Input.insertText', { text: 'clones & co' });
    await until('create enabled', () => evaluate(`!document.querySelector('#folder-new-create').disabled`));
    await evaluate(`document.querySelector('#folder-new-create').click()`);
    await until('new folder opened', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(made)} && document.querySelector('#folder-new').hidden && !document.querySelector('#folder-use').disabled`));
    assert.ok(fs.statSync(made).isDirectory());
    assert.equal(await evaluate(`document.querySelector('#folder-status').textContent`), 'No folders here.');
    await evaluate(`document.querySelector('#folder-up').click()`);
    await until('new folder listed in its parent', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(tree)} && [...document.querySelectorAll('#folder-list .folder-row')].some(r=>r.textContent==='clones & co')`));
    await evaluate(`{ document.querySelector('#folder-new-open').click(); const name=document.querySelector('#folder-new-name'); name.value='clones & co'; name.dispatchEvent(new Event('input')); document.querySelector('#folder-new-create').click(); }`);
    await until('duplicate refused', () => evaluate(`document.querySelector('#folder-status').classList.contains('error') && document.querySelector('#folder-status').textContent.includes('already exists') && !document.querySelector('#folder-new').hidden`));
    await evaluate(`document.querySelector('#folder-new-cancel').click()`);
    assert.equal(await evaluate(`document.querySelector('#folder-new').hidden`), true);
    await until('use enabled', () => evaluate(`!document.querySelector('#folder-use').disabled`));
    await evaluate(`document.querySelector('#folder-use').click()`);
    assert.equal(await evaluate(`localStorage.getItem('agentGuild.cloneParent')`), tree);
    await evaluate(`{ document.querySelector('#cwd').value=${JSON.stringify(path.join(tree, 'beta'))}; document.querySelector('.provider[data-id="fake"] .new').click(); }`);
    await until('session started in the typed folder', () => [...ctx.manager.sessions.values()].some((s) => s.toJSON().cwd === path.join(tree, 'beta')));
    await until('start recorded', () => evaluate(`JSON.parse(localStorage.getItem('agentGuild.recentCwds')||'[]').length===2`));
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('agentGuild.recentCwds'))`), [path.join(tree, 'beta'), path.join(tree, 'alpha')]);
    await evaluate(`{ const cwd=document.querySelector('#cwd'); cwd.blur(); cwd.focus(); }`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#cwd-recent [role=option]')].map(o=>o.textContent)`), [path.join(tree, 'beta'), path.join(tree, 'alpha')]);
    assert.equal(await evaluate(`document.querySelector('#cwd').getAttribute('aria-expanded')`), 'true');
    for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: { ArrowDown: 40, Enter: 13 }[key] });
    assert.equal(await evaluate(`document.querySelector('#cwd').value`), path.join(tree, 'alpha'));
    assert.equal(await evaluate(`document.querySelector('#cwd-recent').hidden`), true);
    await evaluate(`{ const cwd=document.querySelector('#cwd'); cwd.value='zzz'; cwd.dispatchEvent(new Event('input')); }`);
    assert.equal(await evaluate(`document.querySelector('#cwd-recent').hidden`), true);
    await evaluate(`document.querySelector('#cwd').blur()`);

    fakeGitHub = true;
    await evaluate(`document.querySelector('#github-open').click()`);
    await until('Clone into shown', () => evaluate(`document.querySelector('#github-parent').checkVisibility() && document.querySelector('#github-parent').value===${JSON.stringify(tree)}`));
    await evaluate(`document.querySelector('#github-parent-pick').click()`);
    await until('clone folder browser lists the new folder', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(tree)} && [...document.querySelectorAll('#folder-list .folder-row')].some(r=>r.textContent==='clones & co')`));
    await evaluate(`[...document.querySelectorAll('#folder-list .folder-row')].find(r=>r.textContent==='clones & co').click()`);
    await until('new folder opened for cloning', () => evaluate(`document.querySelector('#folder-current').textContent===${JSON.stringify(made)} && !document.querySelector('#folder-use').disabled`));
    await evaluate(`document.querySelector('#folder-use').click()`);
    assert.equal(await evaluate(`document.querySelector('#github-parent').value`), made);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('agentGuild.recentCloneParents'))`), [made, tree]);
    await evaluate(`document.querySelector('#github-parent').focus()`);
    await until('recent clone folders offered', () => evaluate(`!document.querySelector('#github-parent-recent').hidden`));
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#github-parent-recent [role=option]')].map(o=>o.textContent)`), [made, tree]);
    assert.equal(await evaluate(`document.querySelector('#github-parent').getAttribute('aria-expanded')`), 'true');
    await until('earlier toast gone', () => evaluate(`document.querySelector('#toast').hidden`));
    for (const skin of await evaluate(`window.agentGuildSkins.map(s=>s.id)`)) {
      for (const theme of ['light', 'dark']) {
        await evaluate(`{ const root=document.documentElement; root.dataset.skin=${JSON.stringify(skin)}; root.dataset.theme=${JSON.stringify(theme)}; }`);
        await layoutReady();
        const placed = await evaluate(`(() => { const options=[...document.querySelectorAll('#github-parent-recent [role=option]')];
          return options.map(o=>{ const b=o.getBoundingClientRect(); return {height:o.offsetHeight,inside:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight,
            onTop:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)===o,hit:(e=>e&&(e.id||e.className))(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}; }); })()`);
        assert.ok(placed.length === 2 && placed.every((o) => o.height >= 44 && o.inside && o.onTop), `${skin} ${theme} ${JSON.stringify(placed)}`);
      }
    }
    await evaluate(`{ const root=document.documentElement; root.dataset.skin='guild'; root.dataset.theme='light'; }`);
    await layoutReady();
    const second = await evaluate(`(() => { const b=document.querySelectorAll('#github-parent-recent [role=option]')[1].getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: second.x, y: second.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: second.x, y: second.y, button: 'left', clickCount: 1 });
    await until('recent clone folder picked', () => evaluate(`document.querySelector('#github-parent').value===${JSON.stringify(tree)} && document.querySelector('#github-parent-recent').hidden`));
    assert.equal(await evaluate(`localStorage.getItem('agentGuild.cloneParent')`), tree);
    assert.equal(await evaluate(`document.activeElement.id`), 'github-parent');
    await evaluate(`{ const parent=document.querySelector('#github-parent'); parent.value='typed-only'; parent.dispatchEvent(new Event('input')); parent.dispatchEvent(new Event('change')); parent.blur(); }`);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('agentGuild.recentCloneParents'))`), [made, tree]);
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('agentGuild.recentCwds'))`), [path.join(tree, 'beta'), path.join(tree, 'alpha')]);
    await evaluate(`document.querySelector('#dock-close').click()`);
    fakeGitHub = false;
    assert.deepEqual(await evaluate('cspViolations'), []);
    assert.deepEqual(errors, []);
    await send('Emulation.clearDeviceMetricsOverride');
    pass('a remote phone browses and creates real host folders in every skin and theme, gets recent working and clone folders, and cannot open folders on the host');

    const pid = session.toJSON().pid;
    await evaluate(`{ const menu=document.querySelector('#menu-toggle'); if (menu.checkVisibility()) menu.click(); document.querySelector('#settings').click(); }`);
    await until('remote access available in Settings', () => evaluate(`document.querySelector('#remote-access-open').checkVisibility()`));
    await evaluate(`document.querySelector('#remote-access-open').click()`);
    await until('existing Tailscale route', () => evaluate(`document.querySelector('#remote-primary').textContent==='Use existing route' && !document.querySelector('#remote-primary').disabled`));
    await evaluate(`document.querySelector('#remote-primary').click()`);
    await until('adopted connection', () => evaluate(`document.querySelector('#remote-status-title').textContent==='Remote access enabled' && !document.querySelector('#remote-check').disabled`));
    assert.equal(ctx.remoteAccess.snapshot().source, 'saved');
    assert.equal(await evaluate(`document.querySelector('#remote-address').value`), origin);
    assert.equal(session.toJSON().pid, pid);
    pass('the settings panel adopts a matching route and saves it without restarting the PTY');

    await evaluate(`document.querySelector('#remote-connect').click()`);
    await until('share QR', () => evaluate(`!document.querySelector('#remote-qr').hidden && document.querySelector('#remote-qr-note').textContent===''`));
    const link = await evaluate(`document.querySelector('#remote-signin').value`);
    assert.equal(new URL(link).hash, `#token=${ctx.token}`);
    assert.equal(new URL(link).origin, origin);
    assert.ok(await evaluate(`document.querySelector('#remote-qr').width > 200`));
    assert.deepEqual(await evaluate('cspViolations'), []);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const bounds = await evaluate(`(() => { const d=document.querySelector('#remote-access'),r=d.getBoundingClientRect(); return {left:r.left,right:r.right, width:innerWidth, overflow:d.scrollWidth>d.clientWidth}; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && !bounds.overflow, JSON.stringify(bounds));
    if (process.env.REMOTE_ACCESS_SCREENSHOT) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.REMOTE_ACCESS_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
    for (const skin of await evaluate('agentGuildSkins.map(s=>s.id)')) for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)}; document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await layoutReady();
      assert.equal(await evaluate(`(() => { const e=document.querySelector('.remote-body'); return e.scrollWidth<=e.clientWidth; })()`), true, `${skin} ${theme}`);
    }
    await evaluate(`document.querySelector('#remote-close').click()`);
    assert.equal(await evaluate(`document.querySelector('#remote-signin').value`), '');
    assert.equal(await evaluate(`document.querySelector('#remote-qr').hidden`), true);
    await until('focus returns to Settings', () => evaluate(`['settings', 'menu-toggle'].includes(document.activeElement.id)`));
    pass('private QR and sign-in link render under CSP, fit a phone screen, and clear when closed');

    ctx.remoteAccess.change({ action: 'disable', revision: ctx.remoteAccess.snapshot().revision });
    await ctx.remoteAccess.task;
    await until('remote browser revoked', () => evaluate(`document.querySelector('#connection').title.includes('Remote access changed')`));
    assert.equal(session.toJSON().pid, pid);
    assert.equal(session.toJSON().status, 'running');
    pass('disabling revokes the connected remote page while its terminal keeps running');

    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.navigate', { url: `${ctx.api.url}/#token=${ctx.token}` });
    await until('local manager connected', () => evaluate(`document.querySelector('#connection')?.classList.contains('ok')`));
    await evaluate(`document.querySelector('#remote-access-open').click()`);
    await until('fresh enable action', () => evaluate(`document.querySelector('#remote-primary').textContent==='Enable remote access' && !document.querySelector('#remote-primary').disabled`));
    await evaluate(`document.querySelector('#remote-primary').click()`);
    await until('new route enabled', () => evaluate(`document.querySelector('#remote-status-title').textContent==='Remote access enabled' && !document.querySelector('#remote-check').disabled`));
    assert.equal(ctx.remoteAccess.snapshot().url, 'https://guild.example.ts.net');
    assert.equal(session.toJSON().pid, pid);
    pass('a new connection chooses its address and enables from the local UI with no reload');

    await evaluate(`document.querySelector('#remote-disable').click(); document.querySelector('#remote-disable-yes').click()`);
    await until('local disable finishes', () => evaluate(`!document.querySelector('#remote-check').disabled && document.querySelector('#remote-address-row').hidden`));
    const fakeState = JSON.parse(fs.readFileSync(tailFile));
    fakeState.behavior = 'approval'; fakeState.https = false;
    fs.writeFileSync(tailFile, JSON.stringify(fakeState));
    await evaluate(`document.querySelector('#remote-primary').click()`);
    await until('approval action', () => evaluate(`document.querySelector('#remote-help').textContent==='Open Tailscale approval' && !document.querySelector('#remote-check').disabled`));
    assert.equal(ctx.remoteAccess.snapshot().mode, 'off');
    fakeState.behavior = ''; fakeState.https = true;
    fs.writeFileSync(tailFile, JSON.stringify(fakeState));
    await evaluate(`window.dispatchEvent(new Event('focus'))`);
    await until('approval completes automatically on return', () => evaluate(`document.querySelector('#remote-status-title').textContent==='Remote access enabled' && !document.querySelector('#remote-check').disabled`));
    assert.equal(session.toJSON().pid, pid);
    assert.deepEqual(await evaluate('cspViolations'), []);
    assert.deepEqual(errors, []);
    pass('HTTPS approval stays pending until verified and setup resumes when the user returns');

    const permissionState = JSON.parse(fs.readFileSync(tailFile));
    permissionState.behavior = 'permission';
    fs.writeFileSync(tailFile, JSON.stringify(permissionState));
    await evaluate(`document.querySelector('#remote-disable').click(); document.querySelector('#remote-disable-yes').click()`);
    await until('cleanup action', () => evaluate(`document.querySelector('#remote-primary').textContent==='Retry cleanup' && !document.querySelector('#remote-primary').disabled`));
    assert.equal(ctx.remoteAccess.snapshot().mode, 'off');
    assert.equal(ctx.remoteAccess.snapshot().pending, 'disable');
    permissionState.behavior = '';
    fs.writeFileSync(tailFile, JSON.stringify(permissionState));
    await evaluate(`document.querySelector('#remote-primary').click()`);
    await until('cleanup finishes', () => evaluate(`document.querySelector('#remote-primary').textContent==='Enable remote access' && !document.querySelector('#remote-primary').disabled`));
    assert.equal(ctx.remoteAccess.snapshot().pending, null);
    pass('a failed cleanup keeps access blocked and Retry cleanup completes the correct action');

    const find = tailscale.find;
    tailscale.find = () => null;
    await evaluate(`document.querySelector('#remote-check').click()`);
    await until('install guidance', () => evaluate(`document.querySelector('#remote-help').textContent==='Install Tailscale' && !document.querySelector('#remote-check').disabled`));
    assert.equal(await evaluate(`document.querySelector('#remote-help').href`), 'https://tailscale.com/download');
    tailscale.find = find;
    await evaluate(`document.querySelector('#remote-check').click()`);
    await until('installed Tailscale detected', () => evaluate(`document.querySelector('#remote-primary').textContent==='Enable remote access' && !document.querySelector('#remote-primary').disabled`));
    pass('installation guidance recovers when Tailscale becomes available without restarting the manager');

    await evaluate(`document.querySelector('#remote-advanced').open=true; document.querySelector('#remote-hosts').value='draft.example.com'; document.querySelector('#remote-hosts').dispatchEvent(new Event('input'));`);
    ctx.remoteAccess.change({ action: 'custom', revision: ctx.remoteAccess.snapshot().revision, hosts: ['saved.example.com'], origins: ['https://saved.example.com'] });
    await ctx.remoteAccess.task;
    await until('custom form ready', () => evaluate(`!document.querySelector('#remote-custom-save').disabled`));
    await evaluate(`document.querySelector('#remote-custom-form').requestSubmit()`);
    await until('stale settings explained', () => evaluate(`!document.querySelector('#remote-error').hidden && document.querySelector('#remote-error').textContent.includes('another tab') && !document.querySelector('#remote-custom-save').disabled`));
    assert.equal(await evaluate(`document.querySelector('#remote-hosts').value`), 'saved.example.com');
    assert.deepEqual(ctx.remoteAccess.snapshot().hosts, ['saved.example.com']);
    assert.deepEqual(errors, []);
    pass('a stale custom-proxy draft cannot overwrite settings saved by another tab');
  });
  console.log(`${checks} HTTPS proxy checks passed`);
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
  await ctx?.shutdown('proxy test finished');
  globalThis.fetch = nativeFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // As in manager.test.mjs, ConPTY can retain a handle after all PTYs exit.
  if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
}
