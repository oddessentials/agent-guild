// Real page + installed xterm in headless Chrome: the top bar, the side dock and split terminals at several window sizes.
// Run: node tests/browser/layout.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testTerms=[];window.testSizes=[];
const RealTerminal=window.Terminal;
window.Terminal=class extends RealTerminal {
  constructor(...args){super(...args);testTerms.push(this);}
  write(data,callback){super.write(data,()=>{callback?.();this.testParsed=true;});}
};
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket {
  send(data){const m=JSON.parse(data);if(m.type==='resize')testSizes.push({url:this.url,cols:m.cols,rows:m.rows});super.send(data);}
};
</script>`;

const checks = await withPage({ name: 'layout', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 }).then(layoutReady);
  const box = (selector) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})()`);
  const visible = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const click = (selector, init = '{}') => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.dispatchEvent(new MouseEvent('click',Object.assign({bubbles:true,cancelable:true,detail:1},${init})))})()`);
  const key = async (keyName, code = keyName, keyCode = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
  };
  const noSideScroll = async (label) => {
    const [scroll, width] = await evaluate('[document.documentElement.scrollWidth, innerWidth]');
    assert.ok(scroll <= width, `${label}: the page scrolls sideways (${scroll} > ${width})`);
  };
  const panes = () => evaluate(`[...document.querySelectorAll('.terminal-pane')].filter(p=>p.checkVisibility()).map(p=>{const r=p.getBoundingClientRect();const t=testTerms.find(t=>t.element?.isConnected&&p.contains(t.element));return {pane:p.dataset.pane,focused:p.classList.contains('focused'),left:r.left,top:r.top,width:r.width,height:r.height,cols:t?.cols,rows:t?.rows}})`);
  const reloaded = (label, check) => until(label, () => evaluate('!window.testOldPage').then((fresh) => fresh && check(), () => false));
  const cards = () => evaluate('[...document.querySelectorAll("#sessions .session-card")].map(c=>c.dataset.id)');

  await size(1440, 900);
  await send('Page.navigate', { url: origin });
  await until('session cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length >= 3'));
  await evaluate('localStorage.clear(); window.testOldPage = true');
  await send('Page.reload');
  await reloaded('session cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length >= 3'));
  await layoutReady();

  assert.equal(await visible('#menu-toggle'), false);
  for (const id of ['#github-toggle', '#notes-open', '#settings']) assert.equal(await visible(id), true, id);
  assert.ok((await box('.topbar')).height < 80, 'one row');
  assert.equal(await evaluate('document.querySelector("#settings").textContent'), 'Settings');
  await noSideScroll('wide');
  pass('a wide window shows the top bar controls inline on one row');

  await click('#settings');
  await until('settings open', () => evaluate('document.querySelector("#settings-menu").matches(":popover-open")'));
  const menu = await box('#settings-menu');
  assert.ok(menu.left >= 0 && menu.right <= 1440 && menu.top >= (await box('#settings')).bottom, 'under its button, on screen');
  await key('Escape', 'Escape', 27);
  await until('settings closed', () => evaluate('!document.querySelector("#settings-menu").matches(":popover-open")'));
  await click('#manager');
  await until('manager open', () => evaluate('document.querySelector("#manager-menu").matches(":popover-open")'));
  assert.equal(await visible('#stop-manager'), true);
  await until('the first item takes the focus', async () => (await evaluate('document.activeElement?.id')) === 'stop-manager');
  await key('Escape', 'Escape', 27);
  await until('manager closed', () => evaluate('!document.querySelector("#manager-menu").matches(":popover-open")'));
  assert.equal(await evaluate('document.querySelectorAll("#stop-manager, #restart-manager").length'), 2);
  pass('Settings and the Manager menu open under their buttons and close with Escape');

  const [first, second, third] = await cards();
  await click(`#sessions .session-card[data-id="${first}"] .open`);
  await until('terminal', () => evaluate('testTerms.some(t=>t.element?.isConnected&&t.testParsed)'));
  await layoutReady();
  const wide = (await panes())[0];
  await click(`#sessions .session-card[data-id="${second}"] .open`, '{ctrlKey:true}');
  await until('two panes', async () => (await panes()).length === 2 && (await panes()).every((p) => p.cols));
  await layoutReady();
  let shown = await panes();
  assert.equal(await evaluate('document.querySelector("#terminal-panes").dataset.split'), 'columns');
  assert.ok(shown[0].left < shown[1].left && Math.abs(shown[0].top - shown[1].top) < 1, 'side by side');
  assert.ok(Math.abs(shown[0].width - shown[1].width) < 4, 'evenly');
  assert.ok(shown[0].cols < wide.cols && shown[1].cols < wide.cols, 'each terminal is narrower than one alone');
  assert.deepEqual(shown.map((p) => p.focused), [false, true], 'the terminal opened beside takes the focus');
  assert.equal(await evaluate('document.querySelector("#panel-title").textContent'), await evaluate(`document.querySelector('#sessions .session-card[data-id="${second}"] .name').textContent`));
  const sized = await evaluate('testSizes.map(s=>s.url.match(/sessions\\/([^/]+)/)[1]+":"+s.cols)');
  assert.ok(sized.includes(`${first}:${shown[0].cols}`) && sized.includes(`${second}:${shown[1].cols}`), 'each session hears its own size');
  pass('Ctrl+click on a card opens a second terminal beside the first, each sized for its own pane');

  await evaluate('document.querySelector(".terminal-pane[data-pane=\\"0\\"] .terminal-host").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
  assert.deepEqual((await panes()).map((p) => p.focused), [true, false]);
  await click('#panel-switch');
  await until('session menu', () => evaluate('document.querySelector("#panel-sessions").matches(":popover-open")'));
  assert.equal(await evaluate('document.querySelectorAll("#panel-sessions .menu-item").length'), (await cards()).length);
  await click(`#panel-sessions .menu-item:nth-child(${(await cards()).indexOf(second) + 1})`);
  shown = await panes();
  assert.equal(shown.length, 2);
  assert.deepEqual(shown.map((p) => p.focused), [false, true], 'a session already shown is focused, never shown twice');
  pass('clicking a pane focuses it, and choosing a session shown in the other pane focuses that pane');

  const before = shown[0].width;
  const sizesBefore = await evaluate('testSizes.length');
  await evaluate('document.querySelector("#pane-splitter").focus()');
  await key('ArrowRight', 'ArrowRight', 39);
  await key('ArrowRight', 'ArrowRight', 39);
  await layoutReady();
  shown = await panes();
  assert.ok(shown[0].width > before + 30, 'the left terminal grew');
  assert.ok(await evaluate('testSizes.length') > sizesBefore, 'the new sizes reach the sessions');
  assert.equal(await evaluate('document.querySelector("#pane-splitter").getAttribute("aria-valuenow")') > 50, true);
  pass('the divider moves with the keyboard and the sessions are told their new sizes');

  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  await layoutReady();
  const dock = await box('#dock');
  const stage = await box('#terminal-panel');
  assert.ok(stage.right <= dock.left + 1, 'the terminals make room for the dock');
  const content = await evaluate('(()=>{const m=document.querySelector("main");return m.getBoundingClientRect().right-parseFloat(getComputedStyle(m).paddingRight)})()');
  assert.ok(content <= dock.left, 'the cards make room for the dock');
  assert.equal(await evaluate('document.querySelector("#github-toggle").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('document.querySelector("#github-title").getAttribute("aria-selected")'), 'true');
  assert.equal((await panes()).length, 2, 'both terminals stay in view');
  pass('on a wide window the GitHub panel docks beside the terminals without covering them');

  await click('#notes-title');
  assert.equal(await visible('#notes-text'), true);
  assert.equal(await visible('#github-list'), false);
  assert.equal(await evaluate('document.querySelector("#notes-open").getAttribute("aria-pressed")'), 'true');
  await evaluate('document.querySelector("#notes-text").focus()');
  await key('Escape', 'Escape', 27);
  await until('dock closed', async () => !(await visible('#dock')));
  assert.equal(await evaluate('document.activeElement?.id'), 'github-toggle', 'focus goes back to what opened the dock');
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dock-space").trim()'), '0px');
  pass('the dock switches to Notes and Escape closes it, returning the focus');

  await evaluate('window.testOldPage = true');
  await send('Page.reload');
  await reloaded('restored panes', async () => (await panes()).length === 2);
  assert.deepEqual((await panes()).map((p) => p.focused), [false, true]);
  pass('a reload brings back both terminals and the focused one');

  const dockWidth = async () => (await box('#dock')).width;
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  const widthBefore = await dockWidth();
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await dockWidth(), widthBefore + 24, 'the dock widens toward the workspace');
  await key('End', 'End', 35);
  assert.equal(await dockWidth(), 720);
  await key('Home', 'Home', 36);
  assert.equal(await dockWidth(), 320);
  await click('#dock-close');
  pass('the dock resizes from its edge with the keyboard, within its limits');

  await size(1100, 800);
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dock-space").trim()'), '0px', 'the cards stay where they are');
  assert.ok((await box('#terminal-panel')).right <= (await box('#dock')).left + 1, 'the terminals and their controls stay in view');
  await noSideScroll('mid-size with the dock');
  await size(900, 800);
  assert.ok((await box('#terminal-panel')).right > (await box('#dock')).left, 'too narrow to share: the dock lies over the terminals');
  await click('#dock-close');
  pass('on a mid-size window the dock lies over the cards, beside the terminals while they keep a usable width');

  await size(820, 1180);
  assert.equal(await visible('#menu-toggle'), true);
  assert.equal(await visible('#github-toggle'), false);
  assert.equal(await evaluate('document.querySelector("#terminal-panes").dataset.split'), 'rows', 'a tall, narrow stage stacks them');
  shown = await panes();
  assert.ok(shown[0].top < shown[1].top && Math.abs(shown[0].left - shown[1].left) < 1);
  await click('#menu-toggle');
  await until('menu', () => evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'));
  const opened = await box('#topbar-menu');
  assert.ok(opened.right <= 820 && opened.left >= 0);
  assert.equal(await visible('#github-toggle'), true);
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  assert.equal(await evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'), false, 'the menu closes behind its choice');
  await noSideScroll('tablet');
  await click('#dock-close');
  pass('a narrow window gathers the top bar controls into a menu, and stacks two terminals');

  await size(390, 844);
  await noSideScroll('phone');
  assert.ok((await box('.topbar')).height < 80, 'the phone top bar stays on one row');
  shown = await panes();
  assert.equal(shown.length, 1, 'a phone shows one terminal at a time');
  assert.equal(await visible('#panel-swap'), true);
  const swapTo = await evaluate('document.querySelector("#panel-swap").textContent');
  await click('#panel-swap');
  assert.notEqual(await evaluate('document.querySelector("#panel-swap").textContent'), swapTo);
  assert.equal((await panes()).length, 1);
  await click('#menu-toggle');
  await until('menu', () => evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'));
  await click('#notes-open');
  await until('dock', () => visible('#dock'));
  const full = await box('#dock');
  assert.equal(Math.round(full.width), 390);
  await noSideScroll('phone with notes');
  await click('#dock-close');
  pass('a phone shows one terminal with a switch to the other, and the dock covers the window');

  await size(1440, 900);
  assert.equal((await panes()).length, 2, 'the parked terminal comes back when there is room');
  await click('.terminal-pane[data-pane="0"] .pane-close');
  assert.equal((await panes()).length, 1);
  assert.equal(await visible('#panel-split'), true);
  await click('#panel-split');
  await until('session menu', () => evaluate('document.querySelector("#panel-sessions").matches(":popover-open")'));
  const offered = await evaluate('[...document.querySelectorAll("#panel-sessions .menu-item")].length');
  assert.equal(offered, (await cards()).length - 1, 'Split offers only the sessions not shown');
  await click('#panel-sessions .menu-item');
  assert.equal((await panes()).length, 2);
  assert.ok(third);
  pass('closing one terminal keeps the other, and Split offers the sessions not already shown');

  assert.deepEqual(errors, []);
  pass('the page has no uncaught browser exceptions');
});
console.log(`${checks} layout checks passed.`);
