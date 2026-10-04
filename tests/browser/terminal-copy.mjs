// Real page + installed xterm + Chromium touch/clipboard integration.
// Run: node tests/browser/terminal-copy.mjs (CHROME_PATH may name Chrome/Edge).
// Touch emulation cannot verify Android's native selection handles or OS menus.
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testTerms=[];window.testMessages=[];
const RealTerminal=window.Terminal;
window.Terminal=class extends RealTerminal {
  constructor(...args){super(...args);testTerms.push(this);}
  write(data,callback){super.write(data,()=>{callback?.();this.testParsed=true;});}
};
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket { send(data){testMessages.push(JSON.parse(data));super.send(data);} };
</script>`;
let denyClipboard = false;

const checks = await withPage({
  name: 'copy',
  instrumentation,
  headers: () => (denyClipboard ? { 'Permissions-Policy': 'clipboard-write=()' } : {}),
}, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const tap = async (selector) => {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const sheet = 'document.querySelector("#terminal-copy")';
  const area = `${sheet}.querySelector("textarea")`;
  const status = `${sheet}.querySelector('[role="status"]')`;
  const current = 'testTerms.find(t=>t.element.isConnected)';
  const write = async (text, reset = false) => evaluate(`new Promise(resolve=>{const t=${current};${reset ? 't.reset();' : ''}t.write(${JSON.stringify(text)},resolve)})`);
  const select = async (text) => {
    await evaluate(`(()=>{const a=${area};const start=a.value.indexOf(${JSON.stringify(text)});if(start<0)throw Error('text not found');a.focus();a.setSelectionRange(start,start+${text.length})})()`);
    await until('Copy enabled', () => evaluate(`!${sheet}.querySelector('[data-copy]').disabled`));
  };
  const load = async () => {
    await send('Page.navigate', { url: origin });
    await until('session cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length >= 2'));
    await evaluate('document.querySelector("#sessions .session-card .open").click()');
    await until('terminal snapshot parsed', () => evaluate(`Boolean(window.testTerms?.find(t=>t.element?.isConnected)?.testParsed)`));
    await layoutReady();
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await load();
  assert.equal(await evaluate('document.querySelector("#panel-copy").hidden'), true);
  pass('desktop mouse-only UI does not acquire a new action');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until('touch action visible', () => evaluate('!document.querySelector("#panel-copy").hidden'));
  pass('touch capability exposes Copy without UA sniffing');
  await send('Browser.setPermission', { permission: { name: 'clipboard-read' }, setting: 'granted', origin });
  await write('FIRST\r\n  quoted\u00a0text 中🙂\r\n\x1b[31mRED\x1b[0m <literal>', true);
  await layoutReady();
  const geometry = await evaluate(`(()=>{const t=${current};const r=document.querySelector('.terminal-pane.focused .terminal-host').getBoundingClientRect();return [t.cols,t.rows,r.width,r.height]})()`);
  await evaluate('testMessages.length=0');
  await tap('#panel-copy');
  await until('copy sheet', () => evaluate(`${sheet}.open`));
  const frozen = await evaluate(`${area}.value`);
  assert.match(frozen, /FIRST\n  quoted\u00a0text 中🙂\nRED <literal>/);
  assert.equal(await evaluate(`${area}.readOnly`), true);
  assert.equal(await evaluate(`getComputedStyle(${area}).userSelect`), 'text');
  await select('quoted\u00a0text 中🙂');
  await tap('#terminal-copy [data-copy]');
  await until('copied status', () => evaluate(`${status}.textContent === 'Copied'`));
  assert.equal(await evaluate('navigator.clipboard.readText()'), 'quoted\u00a0text 中🙂');
  assert.deepEqual(await evaluate('testMessages'), []);
  assert.deepEqual(await evaluate(`(()=>{const t=${current};const r=document.querySelector('.terminal-pane.focused .terminal-host').getBoundingClientRect();return [t.cols,t.rows,r.width,r.height]})()`), geometry);
  pass('trusted touch Copy preserves Unicode and nonbreaking spaces without terminal input or resize');
  await select('FIRST');
  assert.notEqual(await evaluate(`${status}.textContent`), 'Copied', 'a different selection is not labelled copied');
  await write('\r\nNEW OUTPUT');
  assert.equal(await evaluate(`${area}.value`), frozen);
  pass('incoming output leaves native copy text and selection frozen');
  if (process.env.COPY_SCREENSHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.COPY_SCREENSHOT, Buffer.from(data, 'base64'));
  }
  await tap('#terminal-copy [data-done]');
  assert.equal(await evaluate(`${area}.value`), '');
  assert.equal(await evaluate(`document.activeElement === ${current}.textarea`), true);
  assert.deepEqual(await evaluate('testMessages'), []);
  pass('Done clears text and restores terminal focus without writing to the session');
  await tap('#panel-copy');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until('Escape closed sheet', () => evaluate(`!${sheet}.open && ${area}.value === ''`));
  pass('Escape dismisses and clears the sheet');

  // Real browser promise race: a previous copy must not update a newly opened sheet.
  await tap('#panel-copy');
  await select('FIRST');
  await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>new Promise(resolve=>{window.resolveCopy=resolve})}})');
  await tap('#terminal-copy [data-copy]');
  await until('pending copy', () => evaluate(`${status}.textContent === 'Copying…'`));
  await tap('#terminal-copy [data-done]');
  await tap('#panel-copy');
  await evaluate('resolveCopy()');
  assert.equal(await evaluate(`${status}.textContent`), 'Touch and hold to select text.');
  pass('late clipboard completion cannot report success in a later copy sheet');
  await select('FIRST');
  await tap('#terminal-copy [data-copy]');
  await until('second pending copy', () => evaluate(`${status}.textContent === 'Copying…'`));
  await evaluate(`(()=>{const a=${area};const start=a.value.indexOf('quoted');a.setSelectionRange(start,start+6)})()`);
  await evaluate('resolveCopy()');
  assert.notEqual(await evaluate(`${status}.textContent`), 'Copied');
  pass('changing selection during a pending copy does not label the new range copied');
  await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:undefined})');
  await select('FIRST');
  await tap('#terminal-copy [data-copy]');
  await until('missing-API fallback', () => evaluate(`${status}.textContent.startsWith('Use Copy')`));
  assert.equal(await evaluate(`${area}.value.slice(${area}.selectionStart,${area}.selectionEnd)`), 'FIRST');
  pass('missing Clipboard API retains the selected text and explains native Copy');
  await tap('#terminal-copy [data-done]');

  await tap('#panel-copy');
  await evaluate('document.querySelectorAll("#sessions .session-card .open")[1].click()');
  assert.equal(await evaluate(`${sheet}.open`), false);
  assert.equal(await evaluate(`${area}.value`), '');
  pass('switching sessions clears the old snapshot');
  await tap('#panel-copy');
  await evaluate('document.querySelector("#panel-close").click()');
  assert.equal(await evaluate(`${sheet}.open`), false);
  assert.equal(await evaluate(`${area}.value`), '');
  pass('Hide clears the snapshot');
  await evaluate('document.querySelector("#sessions .session-card .open").click()');
  await tap('#panel-copy');
  await evaluate('dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}))');
  assert.equal(await evaluate(`${sheet}.open`), false);
  assert.equal(await evaluate(`${area}.value`), '');
  pass('page departure clears the snapshot before BFCache restoration');

  denyClipboard = true;
  await load();
  await write('POLICY DENIED', true);
  await tap('#panel-copy');
  await select('POLICY DENIED');
  await tap('#terminal-copy [data-copy]');
  await until('policy fallback', () => evaluate(`${status}.textContent.startsWith('Use Copy')`));
  assert.equal(await evaluate(`${area}.value.slice(${area}.selectionStart,${area}.selectionEnd)`), 'POLICY DENIED');
  assert.equal(await evaluate(`document.activeElement === ${area}`), true);
  pass('browser-enforced clipboard denial retains selection and shows fallback');

  await tap('#terminal-copy [data-done]');
  for (const [width, height] of [[600, 960], [800, 600], [360, 740]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await layoutReady();
    const anchor = await evaluate(`new Promise(resolve=>{
      const t=${current};
      const chunk=${JSON.stringify(width === 800 ? '中🙂e\u0301\u00a0' : 'abcdefghijklmnopqrstuvwxyz')};
      const text=chunk.repeat(Math.ceil(t.cols*(t.rows+8)/chunk.length));
      t.reset();
      t.write(text,()=>{
        t.scrollLines(-2);
        const b=t.buffer.active;
        const prefix=Array.from({length:b.viewportY},(_,y)=>b.getLine(y).translateToString(true,0,t.cols)).join('');
        resolve({text,prefix});
      });
    })`);
    assert.ok(anchor.prefix.length > 0, 'the viewport starts within a wrapped line');
    const bounds = await evaluate(`(()=>{const r=document.querySelector('.terminal-pane.focused .terminal-host').getBoundingClientRect();return [r.width,r.height]})()`);
    await evaluate('testMessages.length=0');
    await tap('#panel-copy');
    await layoutReady();
    const position = await evaluate(`(()=>{
      const a=${area}, measure=document.createElement('span');
      measure.style.cssText='position:fixed;visibility:hidden;white-space:pre';
      measure.style.font=getComputedStyle(a).font;
      measure.textContent=${JSON.stringify(anchor.prefix)};
      document.body.append(measure);
      const expected=Math.min(measure.getBoundingClientRect().width,a.scrollWidth-a.clientWidth);
      measure.remove();
      return {actual:a.scrollLeft,expected,text:a.value,selected:a.selectionEnd-a.selectionStart};
    })()`);
    assert.equal(position.text, anchor.text);
    assert.equal(position.selected, 0, 'opening does not select or copy text');
    assert.ok(Math.abs(position.actual - position.expected) <= 2, JSON.stringify(position));
    const layout = await evaluate(`(()=>{const d=${sheet}.getBoundingClientRect();const a=${area}.getBoundingClientRect();const f=${sheet}.querySelector('.terminal-copy-footer').getBoundingClientRect();const h=document.querySelector('.terminal-pane.focused .terminal-host').getBoundingClientRect();return {inside:d.left>=0&&d.top>=0&&d.right<=innerWidth&&d.bottom<=innerHeight,textVisible:a.height>100,footerInside:f.bottom<=d.bottom,host:[h.width,h.height]}})()`);
    assert.equal(layout.inside && layout.textVisible && layout.footerInside, true, JSON.stringify(layout));
    assert.deepEqual(layout.host, bounds);
    assert.deepEqual(await evaluate('testMessages'), []);
    await tap('#terminal-copy [data-done]');
    await evaluate(`${current}.scrollToTop()`);
    await tap('#panel-copy');
    await layoutReady();
    assert.equal(await evaluate(`${area}.scrollLeft`), 0, 'reopening at the top does not keep the old horizontal offset');
    await tap('#terminal-copy [data-done]');
  }
  pass('portrait, landscape and narrow layouts keep controls visible without resizing the live terminal');
  pass('wrapped ASCII and Unicode output opens at the live viewport, including after reopening');

  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"maxTouchPoints",{get:()=>5})' });
  await load();
  assert.equal(await evaluate('matchMedia("(any-pointer:coarse)").matches'), false);
  assert.equal(await evaluate('navigator.maxTouchPoints'), 5);
  assert.equal(await evaluate('document.querySelector("#panel-copy").hidden'), false);
  pass('touch capability keeps Copy available even without a coarse-pointer media match');
  assert.deepEqual(errors, []);
  pass('the integrated page has no uncaught browser exceptions');
});
console.log(`${checks} browser checks passed (Chromium touch emulation; physical Android testing remains separate).`);
