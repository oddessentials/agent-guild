// Real page and xterm; trusted touch/keyboard input, simulated transport failures.
// Run: node tests/browser/terminal-controls.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { until, withDialogClose, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testTerms=[];window.testSockets=[];window.testInputs=[];window.testSnapshots=[];
const RealTerminal=window.Terminal;
window.Terminal=class extends RealTerminal {
  constructor(...args){super(...args);testTerms.push(this);}
  write(data,callback){super.write(data,()=>{
    if(callback && window.testHoldParsed) testSnapshots.push(callback); else callback?.();
  });}
};
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket {
  constructor(...args){super(...args);testSockets.push(this);}
  emit(event){
    const m=event.data && JSON.parse(event.data);
    if(m?.type==='snapshot'){
      this.testSnapshot=m;
      if(window.testHoldSnapshot){this.testPending=event;return;}
    }
    super.emit(event);
  }
  send(raw){const m=JSON.parse(raw);if(m.type==='input')testInputs.push({url:this.url,data:m.data});super.send(raw);}
};
</script>`;

const checks = await withPage({ name: 'terminal-controls', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const strip = '#terminal-controls';
  const key = (name) => `${strip} [data-key="${name}"]`;
  const currentTerm = 'testTerms.find(t=>t.element?.isConnected && t.element.closest(".focused"))';
  const point = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const down = async (selector) => {
    const p = await point(selector);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    return p;
  };
  const up = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const tap = async (selector) => { await down(selector); await up(); };
  const clear = () => evaluate('testInputs.length=0');
  const inputs = () => evaluate('testInputs.map(m=>m.data)');
  const enabled = () => evaluate(`!document.querySelector('${key('ArrowUp')}').disabled`);
  const ready = () => until('terminal keys ready', enabled);
  const size = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await layoutReady();
  };
  const write = (data) => evaluate(`new Promise(resolve=>${currentTerm}.write(${JSON.stringify(data)},resolve))`);
  const activeSocket = () => evaluate(`testSockets.findLastIndex(s=>s.readyState===1 && s.url.includes('/sessions/'+document.querySelector('.session-card:has(.open)').dataset.id+'/terminal'))`);
  const capture = async (name) => {
    if (!process.env.CONTROLS_SCREENSHOTS) return;
    fs.mkdirSync(process.env.CONTROLS_SCREENSHOTS, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.CONTROLS_SCREENSHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  await size(1200, 850);
  await send('Page.navigate', { url: origin });
  await until('cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length>=3'));
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await until('terminal', () => evaluate('testTerms.some(t=>t.element?.isConnected)'));
  assert.equal(await evaluate(`document.querySelector('${strip}').hidden`), true);
  pass('mouse-only desktop keeps the existing terminal layout');

  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await ready();
  await size(390, 844);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${strip} button')].map(b=>b.dataset.key)`), ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter', 'Escape', 'Paste']);
  await write('\x1b[?1l');
  await evaluate(`${currentTerm}.focus()`);
  const focusedBefore = await evaluate(`document.activeElement===${currentTerm}.textarea`);
  assert.equal(focusedBefore, true);
  await clear();
  for (const name of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter', 'Escape']) await tap(key(name));
  assert.deepEqual(await inputs(), ['\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C', '\r', '\x1b']);
  assert.equal(await evaluate(`document.activeElement===${currentTerm}.textarea`), true);
  pass('all six trusted taps send exactly one key and retain typing focus');

  const toastText = () => evaluate('document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent');
  await evaluate(`window.testClipboard='git status\\n';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
    readText:()=>testClipboard===null?Promise.reject(new DOMException('denied','NotAllowedError')):Promise.resolve(testClipboard)}})`);
  await clear();
  await tap(key('Paste'));
  await until('pasted text sent', async () => (await inputs()).length > 0);
  assert.deepEqual(await inputs(), ['git status'], 'the trailing line break is not sent, so Paste never presses Enter');
  await evaluate('testClipboard=null');
  await tap(key('Paste'));
  await until('refusal reported', async () => (await toastText()).includes('did not allow reading the clipboard'));
  assert.deepEqual(await inputs(), ['git status']);
  pass('Paste sends the clipboard as typed text without Enter, and says why when it cannot');

  await write('\x1b[?1h');
  await evaluate(`${currentTerm}.blur()`);
  await clear();
  for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) await tap(key(name));
  assert.deepEqual(await inputs(), ['\x1bOA', '\x1bOB', '\x1bOD', '\x1bOC']);
  assert.equal(await evaluate(`document.activeElement===${currentTerm}.textarea`), false);
  await write('\x1b[?1l');
  pass('application cursor keys work without focusing the keyboard');

  await clear();
  await down(key('Enter'));
  assert.deepEqual(await inputs(), [], 'nothing sent on pointer down');
  await evaluate('new Promise(resolve=>setTimeout(resolve,550))');
  assert.deepEqual(await inputs(), [], 'holding does not repeat');
  await up();
  assert.deepEqual(await inputs(), ['\r']);
  await clear();
  const p = await down(key('Enter'));
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y - 70 }] });
  await up();
  await down(key('ArrowUp'));
  await send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.deepEqual(await inputs(), []);
  pass('hold, slide away and pointer cancellation never submit an unintended key');

  await clear();
  await evaluate(`document.querySelector('${key('ArrowDown')}').focus()`);
  for (const keyName of ['Enter', ' ']) {
    const code = keyName === ' ' ? 'Space' : 'Enter';
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, autoRepeat: true });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  }
  await evaluate(`document.querySelector('${key('ArrowDown')}').click()`);
  assert.deepEqual(await inputs(), ['\x1b[B', '\x1b[B', '\x1b[B']);
  pass('keyboard and assistive activation work once, including held hardware keys');

  await clear();
  await down(key('Enter'));
  await evaluate('document.querySelector("#panel-copy").click()');
  await layoutReady();
  assert.equal(await enabled(), false);
  await up();
  await withDialogClose(evaluate, '#terminal-copy', () => evaluate('document.querySelector("#terminal-copy [data-done]").click()'));
  await ready();
  assert.deepEqual(await inputs(), []);
  pass('Copy cancels a pending gesture and never leaks it into terminal input');

  // Keep the socket that belongs to the first card for later reconnect tests.
  const socketIndex = await activeSocket();
  assert.ok(socketIndex >= 0);
  await size(1200, 850);
  await evaluate('document.querySelectorAll("#sessions .session-card .open")[1].dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}))');
  await ready();
  await layoutReady();
  await clear();
  await tap(key('ArrowDown'));
  const secondUrl = await evaluate('testInputs.at(-1).url');
  const firstUrl = await evaluate(`testSockets[${socketIndex}].url`);
  assert.notEqual(secondUrl, firstUrl);
  await down(key('Enter'));
  await evaluate('document.querySelectorAll(".terminal-pane")[0].dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
  await up();
  assert.equal((await inputs()).length, 1, 'release cannot move to the other pane');
  await tap(key('ArrowUp'));
  assert.equal(await evaluate('testInputs.at(-1).url'), firstUrl);
  pass('split controls target the focused pane and cancel gestures across a switch');

  await clear();
  await evaluate(`window.testHoldSnapshot=true;testSockets[${socketIndex}].close()`);
  assert.equal(await enabled(), false);
  const link = `${currentTerm}.element.parentElement.querySelector('.terminal-link')`;
  assert.equal(await evaluate(`${link}.hidden ? '' : ${link}.textContent`), 'Reconnecting…');
  await evaluate(`${currentTerm}.input('x')`);
  assert.equal(await toastText(), 'Not sent: the terminal is reconnecting.');
  await tap(key('Enter'));
  await until('reconnected socket awaiting snapshot', () => evaluate('testSockets.some(s=>s.testPending)'));
  assert.equal(await enabled(), false);
  await evaluate('{window.testHoldSnapshot=false;const s=testSockets.find(s=>s.testPending);const event=s.testPending;s.testPending=null;s.emit(event)}');
  await ready();
  assert.deepEqual(await inputs(), [], 'nothing queued for reconnection');
  assert.equal(await evaluate(`${link}.hidden`), true);
  await tap(key('ArrowDown'));
  assert.deepEqual(await inputs(), ['\x1b[B']);
  pass('a dropped terminal says it is reconnecting, reports typing it cannot send, and waits for its snapshot');

  await clear();
  await evaluate(`{window.testHoldParsed=true;const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});s.emit({data:JSON.stringify(s.testSnapshot)})}`);
  await until('snapshot parsed but completion held', () => evaluate('testSnapshots.length>0'));
  assert.equal(await enabled(), false);
  await evaluate(`{const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});s.emit({data:JSON.stringify({type:'exit',exitCode:0})});window.testHoldParsed=false;testSnapshots.splice(0).forEach(fn=>fn())}`);
  assert.equal(await enabled(), false);
  await tap(key('Enter'));
  assert.deepEqual(await inputs(), []);
  // Restore the simulated session so layout checks can continue.
  await evaluate(`{const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});s.emit({data:JSON.stringify(s.testSnapshot)})}`);
  await ready();
  pass('a late snapshot completion cannot reenable an exited terminal');

  await clear();
  await down(key('Enter'));
  await evaluate(`{const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});
    const session={...s.testSnapshot.session,startedAt:'2099-01-01T00:00:00Z'};
    testSockets.findLast(s=>s.readyState===1 && s.url.includes('/events')).emit({data:JSON.stringify({type:'session.updated',session})});}`);
  assert.equal(await enabled(), false);
  await up();
  assert.deepEqual(await inputs(), []);
  await evaluate(`{const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});
    testSockets.findLast(s=>s.readyState===1 && s.url.includes('/events')).emit({data:JSON.stringify({type:'session.updated',session:s.testSnapshot.session})});}`);
  await ready();
  await down(key('Enter'));
  await evaluate('testSockets.findLast(s=>s.readyState===1 && s.url.includes("/events")).close()');
  assert.equal(await enabled(), false);
  await up();
  await ready();
  assert.deepEqual(await inputs(), []);
  pass('a changed session run or lost event connection cancels a gesture without replay');

  await size(390, 844);
  await capture('phone');
  const geometry = () => evaluate(`(()=>{
    const panel=document.querySelector('#terminal-panel').getBoundingClientRect();
    const controls=document.querySelector('${strip}').getBoundingClientRect();
    const host=document.querySelector('.terminal-pane:not([hidden]) .terminal-host').getBoundingClientRect();
    return {panelTop:panel.top,panelBottom:panel.bottom,controlsTop:controls.top,controlsBottom:controls.bottom,hostBottom:host.bottom,hostHeight:host.height,
      buttons:[...document.querySelectorAll('${strip} button')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right}}),
      overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 768]]) {
    await size(width, height);
    const g = await geometry();
    assert.equal(g.overflow, false, `${width} no page overflow`);
    assert.ok(g.hostBottom <= g.controlsTop + 1, 'controls reserve space below output');
    assert.ok(g.hostHeight >= 60, `${width}x${height} terminal remains readable`);
    assert.ok(g.controlsBottom <= height + 1);
    for (const b of g.buttons) assert.ok(b.width >= 44 && b.height >= 48 && b.left >= 0 && b.right <= width, JSON.stringify(b));
  }
  await capture('tablet');
  pass('phone, landscape and tablet layouts retain touch targets and terminal space');

  // Synthetic geometry tests verify our calculations, not an OS keyboard implementation.
  await size(390, 844);
  await evaluate(`window.testViewport={height:360,offsetTop:0,scale:1};for(const name of ['height','offsetTop','scale'])Object.defineProperty(visualViewport,name,{configurable:true,get:()=>testViewport[name]});visualViewport.dispatchEvent(new Event('resize'))`);
  await layoutReady();
  let g = await geometry();
  assert.ok(g.controlsBottom <= 361 && g.hostHeight >= 120, JSON.stringify(g));
  const hidePoint = await point('#panel-close');
  assert.equal(await evaluate(`document.elementFromPoint(${hidePoint.x},${hidePoint.y})?.id`), 'panel-close', 'Hide stays reachable beside a long session-switch action');
  await capture('phone-keyboard-geometry');
  await evaluate('testViewport.offsetTop=40;visualViewport.dispatchEvent(new Event("scroll"))');
  await layoutReady();
  g = await geometry();
  assert.ok(g.panelTop >= 40 && g.controlsBottom <= 401);
  const sizes = await evaluate('testTerms.map(t=>[t.cols,t.rows])');
  await evaluate('testViewport.scale=2;testViewport.height=180;visualViewport.dispatchEvent(new Event("resize"))');
  await layoutReady();
  assert.deepEqual(await evaluate('testTerms.map(t=>[t.cols,t.rows])'), sizes, 'pinch magnification does not resize the PTY');
  await evaluate('for(const name of ["height","offsetTop","scale"])delete visualViewport[name];visualViewport.dispatchEvent(new Event("resize"))');
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#terminal-panel").hasAttribute("data-compact")'), false);
  pass('keyboard geometry, visual viewport panning and pinch zoom keep distinct behavior');

  for (const skin of ['guild', 'professional', 'orbital', 'grove', 'gnomeland', 'goblinville']) {
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)};document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await layoutReady();
      g = await geometry();
      assert.equal(g.overflow, false, `${skin} ${theme}`);
      assert.ok(g.buttons.every(b=>b.width>=44 && b.height>=48), `${skin} ${theme}`);
    }
  }
  await clear();
  await down(key('Enter'));
  await evaluate('document.querySelector("#panel-close").click()');
  await up();
  assert.deepEqual(await inputs(), []);
  assert.equal(await evaluate('document.querySelector("#terminal-panel").hidden'), true);
  assert.deepEqual(errors, []);
  pass('all skins retain geometry; hiding terminals cancels input; no browser exceptions');

  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"maxTouchPoints",{get:()=>5})' });
  await send('Page.navigate', { url: origin });
  await until('restored page', () => evaluate('Boolean(document.querySelector("#sessions .session-card .open"))'));
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await ready();
  assert.equal(await evaluate('matchMedia("(any-pointer: coarse)").matches'), false);
  assert.equal(await evaluate('document.querySelector("#terminal-controls").hidden'), false);
  assert.deepEqual(errors, []);
  pass('a touch-capable tablet keeps its controls with a fine primary pointer');

  const font = () => evaluate('testTerms.find(t=>t.element?.isConnected).options.fontSize');
  const before = await font();
  await evaluate('document.querySelector("#panel-text-larger").click()');
  assert.equal(await font(), before + 1);
  await send('Page.navigate', { url: origin });
  await until('reloaded page', () => evaluate('Boolean(document.querySelector("#sessions .session-card .open"))'));
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await ready();
  assert.equal(await font(), before + 1);
  pass('the terminal text size changes on request and this device remembers it');
});
console.log(`${checks} terminal control checks passed.`);
