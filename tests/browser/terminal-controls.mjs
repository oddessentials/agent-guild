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
  const click = async (selector) => {
    const p = await point(selector);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await layoutReady();
  };
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
  assert.equal(await evaluate(`document.activeElement===${currentTerm}.textarea`), true, 'a keyboard-and-mouse page types straight away');
  assert.equal(await evaluate(`document.querySelector('${strip}').hidden`), true);
  assert.equal(await evaluate('document.querySelector("#panel-text-toggle").checkVisibility()'), true);
  await click('#panel-text-toggle');
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), true);
  assert.equal(await evaluate('document.querySelector("#panel-text-larger").checkVisibility()'), true);
  await escape();
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), false);
  assert.equal(await evaluate('document.activeElement.id'), 'panel-text-toggle');
  pass('mouse-only desktop keeps text size accessible in one popover with Escape and focus return');

  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await ready();
  await size(390, 844);
  await evaluate('document.querySelector("#panel-close").click()');
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await ready();
  assert.equal(await evaluate(`document.activeElement===${currentTerm}.textarea`), false, 'a touch screen opens a terminal without raising its keyboard');
  assert.equal(await evaluate('document.querySelectorAll(".panel-actions .text-size").length'), 1, 'only one text-size button takes header space');
  await tap('#panel-text-toggle');
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), true);
  const touchFont = await evaluate(`${currentTerm}.options.fontSize`);
  await tap('#panel-text-larger');
  assert.equal(await evaluate(`${currentTerm}.options.fontSize`), touchFont + 1);
  assert.equal(await evaluate('document.querySelector("#panel-text-size-value").textContent'), `${touchFont + 1} px`);
  await tap('#panel-text-smaller');
  assert.equal(await evaluate(`${currentTerm}.options.fontSize`), touchFont);
  await escape();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${strip} button')].map(b=>b.dataset.key)`), ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Tab', 'Enter', 'Escape', 'Interrupt', 'Paste']);
  await write('\x1b[?1l');
  await evaluate(`${currentTerm}.focus()`);
  const focusedBefore = await evaluate(`document.activeElement===${currentTerm}.textarea`);
  assert.equal(focusedBefore, true);
  await clear();
  for (const name of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Tab', 'Enter', 'Escape', 'Interrupt']) await tap(key(name));
  assert.deepEqual(await inputs(), ['\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C', '\t', '\r', '\x1b', '\x03']);
  assert.equal(await evaluate(`document.activeElement===${currentTerm}.textarea`), true);
  pass('all eight trusted taps send exactly one key and retain typing focus');

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
  await evaluate("testClipboard='echo first\\necho second\\n'");
  await tap(key('Paste'));
  await until('several lines refused', async () => (await toastText()).includes('more than one line'));
  assert.deepEqual(await inputs(), ['git status']);
  await write('\x1b[?2004h');
  await tap(key('Paste'));
  await until('bracketed paste sent', async () => (await inputs()).length > 1);
  assert.deepEqual(await inputs(), ['git status', '\x1b[200~echo first\recho second\x1b[201~']);
  await write('\x1b[?2004l');
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
  const link = `${currentTerm}.element.parentElement.querySelector('.terminal-link')`;
  // Seek the actual CSS animation: testing a 400ms delay does not need to wait 400ms.
  assert.deepEqual(await evaluate(`(() => {
    window.testHoldSnapshot=true;testSockets[${socketIndex}].close();
    const link=${link};
    const initial=getComputedStyle(link).opacity;
    const animation=link.getAnimations().find(a=>a.animationName==='terminal-link-in');
    if (!animation) return [initial, 'missing animation'];
    animation.pause(); animation.currentTime=399;
    const before=getComputedStyle(link).opacity;
    const beforePointer=getComputedStyle(link.querySelector('button')).pointerEvents;
    animation.currentTime=400;
    return [initial, before, beforePointer, getComputedStyle(link).opacity, getComputedStyle(link.querySelector('button')).pointerEvents];
  })()`), ['0', '0', 'none', '1', 'auto']);
  assert.equal(await enabled(), false);
  assert.equal(await evaluate(`${link}.querySelector('.terminal-link-label').textContent`), 'Reconnecting…');
  await evaluate(`${currentTerm}.input('x')`);
  assert.equal(await toastText(), 'Not sent: the terminal is reconnecting.');
  await tap(key('Enter'));
  await until('reconnected socket awaiting snapshot', () => evaluate('testSockets.some(s=>s.testPending)'));
  assert.equal(await enabled(), false);
  const loadingSocket = await evaluate('testSockets.findLastIndex(s=>s.readyState===1 && s.testPending)');
  await click('.focused .terminal-retry');
  assert.equal(await evaluate(`testSockets[${loadingSocket}].readyState`), 3, 'Retry replaces a terminal-only stalled connection');
  await until('retried socket awaiting snapshot', () => evaluate(`testSockets.some((s,i)=>i>${loadingSocket} && s.readyState===1 && s.testPending)`));
  await evaluate('{window.testHoldSnapshot=false;const s=testSockets.findLast(s=>s.readyState===1 && s.testPending);const event=s.testPending;s.testPending=null;s.emit(event)}');
  await ready();
  assert.deepEqual(await inputs(), [], 'nothing queued for reconnection');
  assert.equal(await evaluate(`${link}.hidden`), true);
  await tap(key('ArrowDown'));
  assert.deepEqual(await inputs(), ['\x1b[B']);
  pass('the badge waits 400ms, Retry replaces a stalled terminal, and input waits for its snapshot');

  await clear();
  await evaluate(`{window.testHoldParsed=true;const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});s.emit({data:JSON.stringify(s.testSnapshot)})}`);
  await until('snapshot parsed but completion held', () => evaluate('testSnapshots.length>0'));
  assert.equal(await enabled(), false);
  await evaluate(`{const s=testSockets.findLast(s=>s.readyState===1 && s.url===${JSON.stringify(firstUrl)});s.emit({data:JSON.stringify({type:'exit',exitCode:0})});window.testHoldParsed=false;testSnapshots.splice(0).forEach(fn=>fn())}`);
  assert.equal(await enabled(), false);
  assert.equal(await evaluate(`${link}.hidden`), true, 'exit and the late snapshot leave no connection badge');
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
  const header = () => evaluate(`(()=>{const brief=document.querySelector('#connection .brief');return {height:document.querySelector('.topbar').getBoundingClientRect().height,
    brand:document.querySelector('.brand h1').checkVisibility(),brief:brief.checkVisibility(),text:brief.textContent,fits:brief.scrollWidth<=brief.clientWidth}})()`);
  const connected = await header();
  assert.deepEqual([connected.brand, connected.brief], [true, false]);
  const sectionOrder = () => evaluate('document.querySelector(".sessions").getBoundingClientRect().top < document.querySelector(".launcher").getBoundingClientRect().top');
  assert.equal(await sectionOrder(), true, 'a phone shows the sessions before the provider cards');
  await size(1200, 850);
  assert.equal(await sectionOrder(), false, 'a desk keeps the provider cards first');
  await size(390, 844);
  await evaluate('testSockets.findLast(s=>s.readyState===1 && s.url.includes("/events")).close()');
  await until('link reported lost', () => evaluate('document.querySelector("#connection").classList.contains("down")'));
  assert.deepEqual(await header(), { height: connected.height, brand: false, brief: true, text: 'Reconnecting…', fits: true });
  await ready();
  assert.deepEqual(await header(), connected);
  pass('a phone header says when the link is lost, at its usual height, and comes back');
  const geometry = () => evaluate(`(()=>{
    const panel=document.querySelector('#terminal-panel').getBoundingClientRect();
    const controls=document.querySelector('${strip}').getBoundingClientRect();
    const host=document.querySelector('.terminal-pane:not([hidden]) .terminal-host').getBoundingClientRect();
    const preview=document.querySelector('#voice-preview').getBoundingClientRect();
    return {panelTop:panel.top,panelBottom:panel.bottom,controlsTop:controls.top,controlsBottom:controls.bottom,hostBottom:host.bottom,hostHeight:host.height,
      previewBottom:preview.bottom,previewHeight:preview.height,
      buttons:[...document.querySelectorAll('${strip} button')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right}}),
      overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  await evaluate('Object.assign(document.querySelector("#voice-preview"),{hidden:false,textContent:"add apple pay and google pay to the checkout flow"})');
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 768]]) {
    await size(width, height);
    const g = await geometry();
    assert.equal(g.overflow, false, `${width} no page overflow`);
    assert.ok(g.hostBottom <= g.controlsTop + 1, 'controls reserve space below output');
    assert.ok(g.previewHeight > 0 && g.previewBottom <= g.controlsTop + 1, `${width} the dictation preview stays above the keys`);
    assert.ok(g.hostHeight >= 60, `${width}x${height} terminal remains readable`);
    assert.ok(g.controlsBottom <= height + 1);
    for (const b of g.buttons) assert.ok(b.width >= 44 && b.height >= 48 && b.left >= 0 && b.right <= width, JSON.stringify(b));
  }
  await capture('tablet');
  await evaluate('Object.assign(document.querySelector("#voice-preview"),{hidden:true,textContent:""})');
  pass('phone, landscape and tablet layouts retain touch targets and terminal space');

  // Synthetic geometry tests verify our calculations, not an OS keyboard implementation.
  await size(390, 844);
  await evaluate('Object.assign(document.querySelector("#voice-preview"),{hidden:false,textContent:"add apple pay and google pay to the checkout flow"})');
  await evaluate(`window.testViewport={height:360,offsetTop:0,scale:1};for(const name of ['height','offsetTop','scale'])Object.defineProperty(visualViewport,name,{configurable:true,get:()=>testViewport[name]});visualViewport.dispatchEvent(new Event('resize'))`);
  await layoutReady();
  let g = await geometry();
  assert.ok(g.controlsBottom <= 361 && g.hostHeight >= 120, JSON.stringify(g));
  assert.ok(g.previewHeight > 0 && g.previewBottom <= g.controlsTop + 1 && g.previewBottom <= 361, 'the dictation preview stays above the keys with the keyboard open');
  await evaluate('Object.assign(document.querySelector("#voice-preview"),{hidden:true,textContent:""})');
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
  await tap('#panel-text-toggle');
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), true);
  await escape();
  await down(key('Enter'));
  await evaluate('document.querySelector("#panel-text-toggle").click()');
  await evaluate('document.querySelector("#panel-close").click()');
  await up();
  assert.deepEqual(await inputs(), []);
  assert.equal(await evaluate('document.querySelector("#terminal-panel").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), false);
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
  assert.equal(await evaluate('document.querySelector("#panel-text-toggle").checkVisibility()'), true);
  assert.deepEqual(errors, []);
  pass('a touch-capable tablet keeps its controls with a fine primary pointer');

  const font = () => evaluate('testTerms.find(t=>t.element?.isConnected).options.fontSize');
  const before = await font();
  await click('#panel-text-toggle');
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#panel-text-size").matches(":popover-open")'), true);
  await click('#panel-text-larger');
  assert.equal(await font(), before + 1);
  assert.equal(await evaluate('document.querySelector("#panel-text-size-value").textContent'), `${before + 1} px`);
  await send('Page.navigate', { url: origin });
  await until('reloaded page', () => evaluate('Boolean(document.querySelector("#sessions .session-card .open"))'));
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await ready();
  assert.equal(await font(), before + 1);
  pass('the terminal text size changes on request and this device remembers it');

  await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const real=matchMedia.bind(window);const faked={'(pointer: coarse)':false,'(any-pointer: coarse)':true};
    window.matchMedia=(query)=>query in faked?{matches:faked[query],media:query,addEventListener(){},removeEventListener(){}}:real(query)}` });
  await send('Page.navigate', { url: origin });
  await until('laptop page', () => evaluate('Boolean(document.querySelector("#sessions .session-card .open"))'));
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await until('terminal', () => evaluate('testTerms.some(t=>t.element?.isConnected)'));
  assert.deepEqual(await evaluate(`[matchMedia("(any-pointer: coarse)").matches, navigator.maxTouchPoints, document.querySelector("#terminal-controls").hidden,
    document.querySelector("#panel-copy").hidden, document.activeElement===${currentTerm}.textarea]`), [true, 5, true, true, true]);
  assert.deepEqual(errors, []);
  pass('a touch-screen laptop with a mouse keeps its terminal height and types straight away');
});
console.log(`${checks} terminal control checks passed.`);
