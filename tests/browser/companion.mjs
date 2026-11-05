import assert from 'node:assert/strict';
import { withPage, until } from './chrome.mjs';

const instrumentation = `<script>
window.installRequests = [];
const demoFetch = window.fetch;
window.fetch = (input, init) => {
  if (String(input).endsWith('/companion/install') && init?.method === 'POST') {
    installRequests.push({ input, init });
    return new Promise(resolve => {
      window.finishInstallRequest = async () => {
        const response = await demoFetch(input, init);
        resolve(response);
      };
    });
  }
  return demoFetch(input, init);
};
const DemoSocket = window.WebSocket;
window.testPlatform = 'darwin';
window.WebSocket = class extends DemoSocket {
  emit(event) {
    if (this.url.includes('/events')) {
      window.eventSocket = this;
      if (window.pauseEvents) return;
      if (event.data) {
        const message = JSON.parse(event.data);
        if (message.type === 'hello') {
          window.lastHello = { ...message, platform: window.testPlatform };
          event = { ...event, data: JSON.stringify(window.lastHello) };
        }
      }
    }
    super.emit(event);
  }
};
window.changePlatform = platform => {
  window.testPlatform = platform;
  window.eventSocket.emit({ data: JSON.stringify(window.lastHello) });
};
window.disconnectManager = () => {
  window.pauseEvents = true;
  DemoSocket.prototype.emit.call(window.eventSocket, { type: 'close' });
};
</script>`;

await withPage({ name: 'companion', instrumentation }, async ({ origin, navigate, evaluate, send, layoutReady, pass, errors }) => {
  const stage = (label) => console.log(`# ${label}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('agentGuild.skin', 'grove'); localStorage.setItem('agentGuild.view', 'yard');" });
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*/yard/assets/*'] });
  stage('opening the Grove yard');
  await navigate(origin);
  await until('connected install button', () => evaluate('document.querySelector("#yard-install").checkVisibility() && !document.querySelector("#yard-install").disabled'));
  await evaluate('Promise.all([...document.querySelectorAll("#yard-install img")].map(img => { img.loading="eager"; return img.decode(); }))');
  await layoutReady();

  const point = () => evaluate(`(() => {
    const button = document.querySelector('#yard-install'), r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, hit: button.contains(document.elementFromPoint(x, y)) };
  })()`);
  const click = async () => {
    const { x, y } = await point();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  stage('checking the button is under the pointer in both themes');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await layoutReady();
    assert.equal((await point()).hit, true, theme);
  }

  stage('clicking Install');
  await click();
  assert.equal(await evaluate('installRequests.length'), 1);
  assert.equal(await evaluate('document.querySelector("#yard-install").disabled'), true);
  await click();
  assert.equal(await evaluate('installRequests.length'), 1);
  await evaluate('finishInstallRequest()');
  await until('the companion install terminal opens', () => evaluate('!document.querySelector("#terminal-panel").hidden && document.querySelector("#panel-title").textContent.includes("Install Grove Companion")'));
  await evaluate('document.querySelector("#panel-close").click()');
  await until('terminal closed and button enabled', () => evaluate('document.querySelector("#terminal-panel").hidden && !document.querySelector("#yard-install").disabled'));
  pass('a click opens an install terminal, and a second click is blocked while the request is pending');

  stage('checking platform, skin and connection');
  for (const [platform, visible] of [['linux', false], ['win32', true], ['darwin', true]]) {
    await evaluate(`changePlatform(${JSON.stringify(platform)})`);
    assert.equal(await evaluate('document.querySelector("#yard-install").checkVisibility()'), visible);
  }
  await evaluate('document.documentElement.dataset.skin="guild"');
  assert.equal(await evaluate('document.querySelector("#yard-install").checkVisibility()'), false);
  await evaluate('document.documentElement.dataset.skin="grove"; disconnectManager()');
  assert.equal(await evaluate('document.querySelector("#yard-install").disabled'), true);
  await click();
  assert.equal(await evaluate('installRequests.length'), 1);
  assert.deepEqual(errors, []);
  pass('the install control follows platform, skin and connection availability');
});
