// Headless Chrome: the environment dialog's four scopes, keyboard order, and narrow wrap.
// Run: node tests/browser/environment-scopes.mjs (CHROME_PATH may name Chrome or Edge).
import assert from 'node:assert/strict';
import { until, withDialogClose, withPage } from './chrome.mjs';

const instrumentation = `<script>
const demoFetch = window.fetch;
window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = ((init && init.method) || 'GET').toUpperCase();
  let body = {};
  try { body = init && init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
  const cwd = method === 'POST' ? body.cwd : url.searchParams.get('cwd');
  if ((url.pathname.endsWith('/environment') || url.pathname.endsWith('/environment/refresh')) && cwd && String(cwd).endsWith('/no-pins')) {
    return Promise.resolve(new Response(JSON.stringify({
      scope: 'project', host: 'demo.local', platform: 'darwin', cwd: cwd,
      revision: 1, refreshing: false, checkedAt: new Date().toISOString(), error: null, stale: false, detail: null,
      pins: [],
    }), { status: method === 'POST' ? 202 : 200, headers: { 'Content-Type': 'application/json' } }));
  }
  return demoFetch(input, init);
};
</script>`;

const CARD = '24.0.0|3.14.0|1.25.0|1.90.0';

const checks = await withPage({ name: 'environment-scopes', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const tab = async () => {
    const down = { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await send('Input.dispatchKeyEvent', down);
    await send('Input.dispatchKeyEvent', { ...down, type: 'keyUp' });
  };
  const card = () => evaluate(`[...document.querySelectorAll('.provider[data-id=shell] .environment-values dd')].map((node) => node.textContent).join('|')`);
  const read = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const resize = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: origin });
  await until('shell card versions', async () => (await card()) === CARD);
  assert.equal(await read('.provider[data-id=shell] .environment-note'), 'Manager environment');

  await resize(1440, 900);
  await layoutReady();
  await evaluate(`document.querySelector('.provider[data-id=shell] .environment-open').click()`);
  await until('environment dialog', () => evaluate(`document.querySelector('#environment').open`));
  assert.equal(await read('#environment-title'), 'Manager environment');
  assert.equal(await read('#environment-host'), 'On demo.local');
  assert.equal(await evaluate(`document.querySelector('#environment-scopes').getAttribute('aria-label')`), 'Environment to check');
  assert.equal(await evaluate(`document.querySelectorAll('#environment-runtimes .environment-row').length`), 6);
  assert.equal(await evaluate(`document.querySelector('#environment-scope-manager').getAttribute('aria-pressed')`), 'true');
  assert.equal(await card(), CARD);

  await evaluate(`document.querySelector('#environment-scope-manager').focus()`);
  for (const id of ['environment-scope-project', 'environment-scope-session', 'environment-scope-launch', 'environment-refresh']) {
    await tab();
    assert.equal(await evaluate('document.activeElement.id'), id, `Tab lands on ${id}`);
  }
  pass('scope buttons and Refresh are in tab order');

  await evaluate(`document.querySelector('#environment-scope-project').click()`);
  assert.equal(await read('#environment-title'), 'Project pins');
  assert.match(await read('#environment-status'), /Choose a working folder/);
  assert.equal(await evaluate(`document.querySelector('#environment-pins').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#environment-refresh').disabled`), true);
  assert.equal(await card(), CARD);

  await evaluate(`{
    const cwd = document.querySelector('#cwd');
    cwd.value = '/work/storefront';
    cwd.dispatchEvent(new Event('input'));
    document.querySelector('#environment-refresh').click();
  }`);
  await until('configured pin', () => evaluate(`document.querySelector('#environment-pins code')?.textContent === '22'`));
  assert.match(await read('#environment-intro'), /A pin is not proof the runtime is installed/);
  assert.equal(await evaluate(`document.querySelector('#environment-pins .environment-row-head span').textContent`), 'Configured');
  assert.equal(await read('#environment-pins .environment-detail'), '.nvmrc');
  assert.equal(await card(), CARD);
  assert.equal(await read('.provider[data-id=shell] .environment-note'), 'Manager environment');

  await evaluate(`{
    const cwd = document.querySelector('#cwd');
    cwd.value = '/work/no-pins';
    cwd.dispatchEvent(new Event('input'));
  }`);
  assert.equal(await evaluate(`document.querySelector('#environment-pins').hidden`), true);
  assert.match(await read('#environment-status'), /Refresh to read this folder/);
  await evaluate(`document.querySelector('#environment-refresh').click()`);
  await until('empty pins', () => evaluate(`document.querySelector('#environment-pins').textContent.includes('No version pins')`));
  assert.equal(await card(), CARD);

  await evaluate(`document.querySelector('#environment-scope-session').click()`);
  await until('session list', () => evaluate(`document.querySelectorAll('#environment-session option').length >= 2`));
  await until('spawn folder', () => evaluate(`document.querySelector('#environment-manager-node').textContent.startsWith('Spawn folder:')`));
  assert.match(await read('#environment-manager-node'), /\/demo\/project/);
  assert.equal(await evaluate(`[...document.querySelectorAll('#environment-session option')].some((option) => option.value === '7e110005' && option.textContent.includes('tmux'))`), true);
  await evaluate(`{
    const select = document.querySelector('#environment-session');
    select.value = '7e110005';
    select.dispatchEvent(new Event('change'));
  }`);
  await until('multiplexer refusal', () => evaluate(`document.querySelector('#environment-status').textContent.includes('tmux or herdr')`));
  assert.equal(await evaluate(`document.querySelectorAll('#environment-runtimes .environment-row').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#environment-tools-heading').hidden`), true);
  assert.equal(await card(), CARD);

  await evaluate(`document.querySelector('#environment-scope-launch').click()`);
  await until('launch rows', () => evaluate(`document.querySelectorAll('#environment-runtimes .environment-row').length === 6`));
  assert.match(await read('#environment-intro'), /A new session receives this PATH/);
  assert.equal(await read('#environment-manager-node'), 'Launch PATH, profiles not applied. The selected shell is not consulted.');
  assert.equal(await evaluate(`document.querySelector('#environment-manager-node').textContent.includes('Agent Guild is running')`), false);
  await evaluate(`document.querySelector('#environment-refresh').click()`);
  await until('launch refresh finished', () => evaluate(`document.querySelector('#environment-refresh').textContent === 'Refresh' && !document.querySelector('#environment-refresh').disabled`));
  assert.equal(await read('#environment-title'), 'New shell launch PATH');
  assert.equal(await card(), CARD);
  assert.equal(await read('.provider[data-id=shell] .environment-note'), 'Manager environment');
  pass('project, session, and launch checks leave the shell card on the manager versions');

  await resize(390, 844);
  await layoutReady();
  const wrap = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.environment-scope')];
    const tops = buttons.map((button) => Math.round(button.getBoundingClientRect().top));
    const select = document.querySelector('#environment-session');
    return { rows: new Set(tops).size, minHeight: getComputedStyle(buttons[0]).minHeight,
      overflow: document.querySelector('#environment').scrollWidth <= document.querySelector('#environment').clientWidth };
  })()`);
  assert.ok(wrap.rows >= 2, `scope buttons wrap at phone width: ${JSON.stringify(wrap)}`);
  assert.equal(wrap.minHeight, '36px');
  assert.equal(wrap.overflow, true);
  await evaluate(`document.querySelector('#environment-scope-session').click()`);
  await until('session select', () => evaluate(`!document.querySelector('#environment-session').hidden`));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#environment-session')).minHeight`), '44px');
  assert.equal(await evaluate(`!/\\b(install|repair|update|switching)\\b/i.test(document.querySelector('#environment').innerText)`), true);
  pass('scope buttons wrap on a narrow screen and stay free of lifecycle wording');

  await withDialogClose(evaluate, '#environment', () => evaluate(`document.querySelector('#environment-close').click()`));
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.provider[data-id=shell] .environment-open')`), true);
  assert.deepEqual(errors, []);
  pass('closing the dialog returns focus to Environment details');
});

console.log(`ok ${checks} checks`);
