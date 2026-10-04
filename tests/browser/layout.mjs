// Real page + installed xterm in headless Chrome: the top bar, the side dock, its GitHub views and split terminals at several window sizes.
// Run: node tests/browser/layout.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testTerms=[];window.testSizes=[];window.testActions=[];
const demoFetch=window.fetch;
window.fetch=function(input,init){if(String(input?.url??input).split('?')[0].endsWith('/actions'))testActions.push(Date.now());return demoFetch.call(this,input,init);};
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
  await layoutReady();
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


  const tap = async (selector) => {
    const b = await box(selector);
    assert.ok(b && b.width && b.height, `${selector} is on screen`);
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const isOpen = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).matches(":popover-open")`);
  const focused = () => evaluate('document.activeElement?.id || document.activeElement?.className || ""');

  await tap('#panel-switch');
  await until('switcher open', () => isOpen('#panel-sessions'));
  assert.equal(await evaluate('document.querySelectorAll("#panel-sessions .menu-item").length'), (await cards()).length);
  await tap('#panel-switch');
  await until('switcher closed', async () => !(await isOpen('#panel-sessions')));
  await click('.terminal-pane[data-pane="1"] .pane-close');
  await tap('#panel-split');
  await until('split menu open', () => isOpen('#panel-sessions'));
  assert.equal(await evaluate('document.querySelectorAll("#panel-sessions .menu-item").length'), (await cards()).length - 1, 'Split offers the others');
  await tap('#panel-split');
  await until('split menu closed', async () => !(await isOpen('#panel-sessions')));
  await tap('#panel-switch');
  await until('switcher open again', () => isOpen('#panel-sessions'));
  assert.equal(await evaluate('document.querySelectorAll("#panel-sessions .menu-item").length'), (await cards()).length, 'the switcher shows every session, not what Split showed');
  await tap('#panel-split');
  await until('closed by the other button', async () => !(await isOpen('#panel-sessions')));
  await tap('#panel-split');
  await until('split menu', () => isOpen('#panel-sessions'));
  assert.equal(await evaluate('document.querySelectorAll("#panel-sessions .menu-item").length'), (await cards()).length - 1);
  await key('Escape', 'Escape', 27);
  await until('closed', async () => !(await isOpen('#panel-sessions')));
  assert.equal(await focused(), 'panel-split', 'Escape returns the focus to the button that opened the menu');
  pass('the session menu closes when its button or the other one is pressed again, and opens showing what that button offers');

  await tap('#manager');
  await until('manager open', () => isOpen('#manager-menu'));
  await until('first item focused', async () => (await focused()) === 'stop-manager');
  await key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await focused(), 'stop-manager', 'the only shown item keeps the focus');
  await key('Tab', 'Tab', 9);
  await until('Tab closes it', async () => !(await isOpen('#manager-menu')));
  assert.equal(await evaluate('document.querySelector("#manager-menu").contains(document.activeElement)'), false);
  await tap('#manager');
  await until('manager open', () => isOpen('#manager-menu'));
  await key('Escape', 'Escape', 27);
  await until('Escape closes it', async () => !(await isOpen('#manager-menu')));
  assert.equal(await focused(), 'manager', 'the focus goes back to the Manager button');
  pass('Tab leaves the Manager menu and closes it; Escape closes it and returns the focus to its button');

  // GitHub: the panel follows the focused terminal's repository.
  const storefront = 'a11ce001', gateway = 'c0de0002';
  await click(`#sessions .session-card[data-id="${storefront}"] .open`);
  await click(`#sessions .session-card[data-id="${gateway}"] .open`, '{ctrlKey:true}');
  await until('two panes', async () => (await panes()).length === 2);
  await evaluate(`document.querySelector('.terminal-pane[data-pane="0"] .terminal-host').dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))`);
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  const picked = () => evaluate('document.querySelector("#github-repo").value');
  await until('the focused terminal\'s repository is picked', async () => (await picked()) === 'acme/storefront');
  await evaluate(`document.querySelector('.terminal-pane[data-pane="1"] .terminal-host').dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))`);
  await until('the other terminal\'s repository', async () => (await picked()) === 'acme/api-gateway');
  pass('the GitHub panel picks the repository of the focused terminal\'s folder, and follows the focus');

  await tap('#github-repo');
  await until('list open', () => evaluate('document.querySelector("#github-repo").getAttribute("aria-expanded") === "true"'));
  await send('Input.insertText', { text: 'dot' });
  await until('one match', () => evaluate('document.querySelectorAll("#github-repo-list [role=option]").length === 1'));
  assert.equal(await evaluate('document.querySelector("#github-repo-list mark").textContent'), 'dot');
  await key('Enter', 'Enter', 13);
  assert.equal(await picked(), 'demo-dev/dotfiles');
  assert.equal(await evaluate('document.querySelector("#github-repo").getAttribute("aria-expanded")'), 'false');
  await tap('#github-repo');
  await send('Input.insertText', { text: 'zzz' });
  await key('Escape', 'Escape', 27);
  assert.equal(await picked(), 'demo-dev/dotfiles', 'Escape puts the picked name back');
  assert.equal(await visible('#dock'), true, 'and does not close the dock');
  await tap('#github-repo');
  await send('Input.insertText', { text: 'store' });
  await key('ArrowDown', 'ArrowDown', 40);
  await key('Enter', 'Enter', 13);
  await until('storefront', async () => (await picked()) === 'acme/storefront');
  pass('the repository picker searches, highlights, picks with the keyboard and gives up with Escape');

  const tabs = ['repos', 'issues', 'actions', 'pulls'];
  const panelOf = { repos: '#github-repos', issues: '#github-issues', actions: '#github-runs', pulls: '#github-pulls' };
  const checkTabs = async (label) => {
    const dock = await box('#dock');
    for (const view of tabs) {
      const tab = await box(`#github-view-${view}`);
      assert.ok(tab.left >= dock.left - 1 && tab.right <= dock.right + 1 && tab.right <= (await evaluate('innerWidth')) + 1, `${label}: the ${view} tab is in view`);
      await tap(`#github-view-${view}`);
      await until(`${label}: ${view} shown`, () => visible(panelOf[view]));
      assert.equal(await evaluate(`document.querySelector("#github-view-${view}").getAttribute("aria-selected")`), 'true');
      if (view !== 'repos') await until(`${label}: ${view} loaded`, () => evaluate(`document.querySelector(${JSON.stringify(panelOf[view])}).querySelector(".history-row, .github-view-note:not(:empty)") !== null`));
      const overflow = await evaluate(`[document.querySelector("#dock"), document.querySelector(${JSON.stringify(panelOf[view])})].map(e=>e.scrollWidth-e.clientWidth)`);
      assert.deepEqual(overflow, [0, 0], `${label}: ${view} fits the dock's width`);
      await noSideScroll(`${label}: ${view}`);
    }
  };
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('Home', 'Home', 36);
  assert.equal(Math.round((await box('#dock')).width), 320);
  await checkTabs('1440 wide, narrowest dock');
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('End', 'End', 35);
  assert.equal(Math.round((await box('#dock')).width), 720);
  await checkTabs('1440 wide, widest dock');
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('Home', 'Home', 36);
  for (let i = 0; i < 4; i++) await key('ArrowLeft', 'ArrowLeft', 37);
  for (const [width, height] of [[1440, 900], [1100, 800], [820, 1180], [390, 844]]) {
    await size(width, height);
    assert.equal(await visible('#dock'), true);
    await checkTabs(`${width} wide`);
  }
  await evaluate('document.querySelector("#github-view-issues").focus()');
  await key('ArrowRight', 'ArrowRight', 39);
  assert.equal(await focused(), 'github-view-actions', 'arrow keys move between the tabs');
  assert.equal(await visible('#github-runs'), true);
  pass('the Repositories, Issues, Actions and Pull requests tabs are all reachable and fit the dock at every window and dock width');

  await size(1440, 900);
  await tap('#github-view-issues');
  await until('issues', () => evaluate('document.querySelectorAll("#github-issues .history-row").length > 0'));
  await tap('#github-issues [data-key="new"]');
  await until('editor', () => visible('#github-issues form'));
  await send('Input.insertText', { text: 'Made in the layout test' });
  await tap('#github-issues form .btn.primary');
  await until('back from the editor', () => evaluate('!document.querySelector("#github-issues form")'));
  await until('created', () => evaluate('[...document.querySelectorAll("#github-issues .history-title")].some(t=>t.textContent.includes("Made in the layout test"))'));
  const number = await evaluate('[...document.querySelectorAll("#github-issues .history-title")].find(t=>t.textContent.includes("Made in the layout test")).textContent.match(/#(\\d+)/)[1]');
  await tap(`#github-issues [data-key="edit:${number}"]`);
  await until('editing', () => visible('#github-issues form'));
  await tap('#github-issues form .btn.danger');
  await until('back on the list', () => evaluate('!document.querySelector("#github-issues form") && document.querySelector("#github-issues .github-segment") !== null'));
  await until('closed and gone', () => evaluate(`![...document.querySelectorAll("#github-issues .history-title")].some(t=>t.textContent.includes("#${number} "))`));
  await tap('#github-issues [data-key="state:closed"]');
  await until('listed as closed', () => evaluate(`[...document.querySelectorAll("#github-issues .history-title")].some(t=>t.textContent.includes("#${number} "))`));
  await tap('#github-issues [data-key="state:open"]');
  pass('an issue can be created, edited and closed from the Issues tab');

  const polls = () => evaluate('testActions.length');
  await tap('#github-view-actions');
  await until('runs', () => evaluate('document.querySelectorAll("#github-runs .history-row").length > 0'));
  assert.equal(await visible('#github-running'), true, 'the tab shows a workflow is running');
  const polled = await polls();
  await until('Actions polls while shown', async () => (await polls()) > polled);
  await tap('#github-view-pulls');
  const away = await polls();
  await new Promise((resolve) => setTimeout(resolve, 7500));
  assert.equal(await polls(), away, 'no polling while another tab shows');
  await tap('#github-view-actions');
  await until('polling again', async () => (await polls()) > away);
  await click('#dock-close');
  const closed = await polls();
  await new Promise((resolve) => setTimeout(resolve, 7500));
  assert.equal(await polls(), closed, 'no polling once the dock is closed');
  pass('Actions runs are polled only while their tab is showing');

  // A Notes panel left over the terminals on a narrow window comes back over them.
  await size(820, 1180);
  await click('#menu-toggle');
  await until('menu', () => isOpen('#topbar-menu'));
  await click('#notes-open');
  await until('notes', () => visible('#notes-text'));
  assert.equal(await visible('#terminal-panel'), true);
  await evaluate('window.testOldPage = true');
  await send('Page.reload');
  await reloaded('restored panes', async () => (await panes()).length >= 1);
  await layoutReady();
  assert.equal(await visible('#notes-text'), true, 'the restored Notes stay over the restored terminals');
  assert.notEqual(await evaluate('document.activeElement?.closest?.(".terminal-pane") ? "terminal" : ""'), 'terminal', 'a covered terminal does not take the typing');
  await click(`#sessions .session-card[data-id="${third}"] .open`);
  await until('a terminal opened by hand makes the dock give way', async () => !(await visible('#dock')));
  pass('a restored Notes panel stays open over restored terminals; opening a terminal afterwards still closes it');

  await size(1440, 900);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await until('coarse pointer', () => evaluate('matchMedia("(pointer: coarse)").matches'));
  await layoutReady();
  if ((await panes()).length < 2) {
    await click('#panel-split');
    await until('split menu', () => isOpen('#panel-sessions'));
    await click('#panel-sessions .menu-item');
  }
  await until('split', async () => (await panes()).length === 2);
  const splitter = await box('#pane-splitter');
  assert.equal(Math.round(splitter.width), 8, 'the divider is drawn as before');
  const reach = (x, y) => evaluate(`document.elementFromPoint(${x}, ${y})?.id`);
  const midY = splitter.top + splitter.height / 2;
  assert.equal(await reach(splitter.left - 8, midY), 'pane-splitter', 'a touch just left of the divider takes it');
  assert.equal(await reach(splitter.right + 8, midY), 'pane-splitter', 'a touch just right of it too');
  const ratio = () => evaluate('Number(document.querySelector("#pane-splitter").getAttribute("aria-valuenow"))');
  const ratioBefore = await ratio();
  const drag = async (x, y, dx) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * step) / 4, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await drag(splitter.left - 8, midY, -120);
  await until('the divider moved', async () => (await ratio()) < ratioBefore - 5);
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  const dockBox = await box('#dock');
  assert.equal(await reach(dockBox.left - 11, dockBox.top + 200), 'dock-splitter', 'the dock edge takes a touch beside it');
  await drag(dockBox.left - 11, dockBox.top + 200, -40);
  await until('the dock widened', async () => Math.round((await box('#dock')).width) >= Math.round(dockBox.width) + 30);
  await click('#dock-close');
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  pass('on a touch screen both dividers take a touch beside their thin line and drag with a finger');

  assert.deepEqual(errors, []);
  pass('the page has no uncaught browser exceptions');
});
console.log(`${checks} layout checks passed.`);
