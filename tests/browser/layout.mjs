// Real page + installed xterm in headless Chrome: the top bar, the side dock, its GitHub views and split terminals at several window sizes.
// Run: node tests/browser/layout.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testTerms=[];window.testSizes=[];window.testActions=[];window.testSockets=[];
const demoFetch=window.fetch;
window.fetch=function(input,init){const route=String(input?.url??input).split('?')[0];if(route.endsWith('/actions'))testActions.push(Date.now());const answer=demoFetch.call(this,input,init);if(!route.endsWith('/providers')||!localStorage.getItem('testBreakCard'))return answer;return answer.then((r)=>r.json()).then((body)=>{const shell=body.providers.find((p)=>p.id==='shell');body.providers.push({...shell,id:'terminal-ai-chat',tool:'Terminal AI Chat',vendor:'Odd Essentials'});return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});});};
const RealTerminal=window.Terminal;
window.Terminal=class extends RealTerminal {
  constructor(...args){super(...args);testTerms.push(this);}
  write(data,callback){super.write(data,()=>{callback?.();this.testParsed=true;});}
};
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket {
  constructor(...args){super(...args);testSockets.push(this);}
  send(data){const m=JSON.parse(data);if(m.type==='resize'||m.type==='claim')testSizes.push({url:this.url,type:m.type,cols:m.cols,rows:m.rows});super.send(data);}
};
</script>`;

const checks = await withPage({ name: 'layout', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors, navigate, reload }) => {
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
  const cards = () => evaluate('[...document.querySelectorAll("#sessions .session-card")].map(c=>c.dataset.id)');
  const fitted = (terms = 'testTerms.filter(t=>t.element?.isConnected)') => until('terminals fit their panes', () => evaluate(`${terms}.every(t=>{t.testFit??=(()=>{const f=new FitAddon.FitAddon();t.loadAddon(f);return f;})();const p=t.testFit.proposeDimensions();return t.testParsed&&p.cols===t.cols&&p.rows===t.rows})`));
  const sizesFor = (id) => evaluate(`testSizes.filter(s=>s.url.includes('/sessions/${id}/')).map(s=>s.type+' '+s.cols+'x'+s.rows)`);
  // Layout boxes, which the cards' entrance animation does not move.
  const providerGrid = () => evaluate('(()=>{const c=[...document.querySelectorAll("#providers .provider")];return {count:c.length,rows:new Set(c.map(p=>p.offsetTop)).size,narrowest:Math.min(...c.map(p=>p.offsetWidth))}})()');

  await size(1440, 900);
  await navigate(origin);
  await until('session cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length >= 3'));
  await evaluate('localStorage.clear()');
  await reload();
  await until('session cards', () => evaluate('document.querySelectorAll("#sessions .session-card").length >= 3'));
  await layoutReady();

  // Each card shows, and announces, the label the (demo) manager sent with its session.
  const labels = await evaluate('[...document.querySelectorAll("#sessions .session-card")].map(c=>({pill:c.querySelector(".status-pill").textContent,aria:c.getAttribute("aria-label")}))');
  for (const { pill, aria } of labels) {
    assert.match(pill, /^(?:Running|Working|Closed|Exited(?: \(.+\))?)$/, `status pill "${pill}"`);
    assert.ok(aria.includes(`, ${pill}, `), `the card's accessible name says ${pill}: ${aria}`);
    assert.doesNotMatch(aria, /undefined|null/, aria);
  }
  pass('every card shows and announces its session label');

  assert.equal(await visible('#menu-toggle'), false);
  for (const id of ['#github-toggle', '#notes-open', '#settings']) assert.equal(await visible(id), true, id);
  assert.ok((await box('.topbar')).height < 80, 'one row');
  assert.equal(await evaluate('document.querySelector("#settings").textContent'), 'Settings');
  await noSideScroll('wide');
  pass('a wide window shows the top bar controls inline on one row');

  const fit = () => evaluate('document.querySelector(".topbar").dataset.fit');
  const oneRow = async (label) => {
    await until(`${label}: the top bar holds one row`, async () => {
      const [bar, end] = await Promise.all([box('.topbar'), box('.topbar-end')]);
      return bar.height < 80 && end.height < 60;
    });
    await noSideScroll(label);
  };
  await evaluate('Object.assign(document.querySelector("#upgrade"), { hidden: false, textContent: "Upgrade to 10.10.10" })');
  await size(1024, 768);
  await until('the menu gathers the controls', async () => await fit() === 'menu');
  await oneRow('1024 with Upgrade');
  assert.equal(await visible('#menu-toggle'), true);
  await click('#menu-toggle');
  await until('menu', () => evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'));
  await layoutReady();
  assert.equal(await evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'), true, 'an open menu stays open');
  assert.equal(await fit(), 'menu');
  await size(1440, 900);
  await until('inline again', async () => await fit() === 'inline');
  assert.equal(await evaluate('document.querySelector("#topbar-menu").matches(":popover-open")'), false, 'the menu closes when the window resizes');
  for (const skin of ['guild', 'professional', 'orbital', 'grove', 'gnomeland', 'goblinville']) {
    for (const theme of ['light', 'dark']) {
      await evaluate(`Object.assign(document.documentElement.dataset, { skin: ${JSON.stringify(skin)}, theme: ${JSON.stringify(theme)} })`);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await size(width, 800);
        await oneRow(`${skin} ${theme} at ${width} with Upgrade`);
      }
    }
  }
  await size(1100, 800);
  const label = await evaluate('document.querySelector("#connection .label").textContent');
  await evaluate('document.querySelector("#connection .label").textContent = "Remote access changed. Your terminals are still running. Reopen an enabled address to reconnect."');
  await until('a long status leaves the inline arrangement', async () => await fit() !== 'inline');
  await oneRow('1100 with a long status');
  await evaluate(`document.querySelector("#connection .label").textContent = ${JSON.stringify(label)}; document.querySelector("#upgrade").hidden = true`);
  await size(1440, 900);
  await until('inline once the status and Upgrade fit', async () => await fit() === 'inline');
  pass('the top bar steps down to the menu, then a shorter header, so it holds one row in every skin and with a long status or Upgrade');

  const wideGrid = await providerGrid();
  assert.deepEqual([wideGrid.count, wideGrid.rows], [6, 1], 'six cards share one row');
  assert.ok(wideGrid.narrowest >= 220, `each card keeps its full width (${wideGrid.narrowest}px)`);
  const launcher = await box('.launcher');
  const column = await evaluate('(()=>{const m=getComputedStyle(document.querySelector("main"));return document.querySelector("main").clientWidth-parseFloat(m.paddingLeft)-parseFloat(m.paddingRight)})()');
  assert.ok(launcher.width > column, `the card row spreads past the page column (${launcher.width} > ${column})`);
  assert.ok(Math.abs(launcher.left - (await evaluate('document.documentElement.clientWidth')) + launcher.right) < 1, 'centred');
  pass('a wide window gives six full-width provider cards one row, centred past the page column');

  // Containment on body keeps its background from passing to the window, so body paints it over the skin art behind.
  assert.deepEqual(await evaluate('(()=>{const s=getComputedStyle(document.body);return [s.containerType,s.contain]})()'), ['normal', 'none'], 'body is not contained');
  pass('the skin art behind the page is not painted over by the body');

  assert.deepEqual(await evaluate('[document.documentElement.dataset.art, document.querySelector("#art").checked]'), ['off', false]);
  const artFiles = (before) => evaluate(`performance.getEntriesByType('resource').filter(e=>e.startTime<${before}&&e.name.includes('/skins/')&&!/\\/skin\\.css$|\\/fonts\\/|\\/professional\\/icons\\/[a-z]+\\.svg$/.test(e.name)).map(e=>e.name.split('/skins/')[1])`);
  const slimLayout = () => evaluate(`(()=>{const hit=(a,b)=>a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5;const bad=[];
    for(const card of document.querySelectorAll('#sessions .session-card')){const c=card.getBoundingClientRect();const badge=card.querySelector('.level-badge').getBoundingClientRect();
      if(!card.querySelector('.card-top > .provider-icon').checkVisibility())bad.push(card.dataset.id+' icon hidden');
      for(const el of card.querySelectorAll('button, .status-pill, .agent, .provider-icon, .name')){if(!el.checkVisibility())continue;const r=el.getBoundingClientRect();
        if(hit(badge,r))bad.push(card.dataset.id+' badge over '+el.className);if(r.left<c.left-0.5||r.right>c.right+0.5)bad.push(card.dataset.id+' '+el.className+' outside');}}
    for(const p of document.querySelectorAll('#providers .provider'))if(parseFloat(getComputedStyle(p).paddingTop)>24)bad.push(p.dataset.id+' keeps room for art');
    return bad})()`);
  const startSkin = await evaluate('[document.documentElement.dataset.skin, document.documentElement.dataset.theme]');
  for (const skin of await evaluate('agentGuildSkins.map(s=>s.id)')) for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)};document.documentElement.dataset.theme=${JSON.stringify(theme)};scrollTo(0,0)`);
    await layoutReady();
    await evaluate('scrollTo(0,document.documentElement.scrollHeight)');
    await layoutReady();
    assert.deepEqual(await slimLayout(), [], `${skin} ${theme}`);
    await noSideScroll(`${skin} ${theme} without art`);
  }
  const artOn = await evaluate('performance.now()');
  await evaluate('document.documentElement.dataset.skin="guild";document.documentElement.dataset.theme="dark";document.querySelector("#art").click()');
  await until('card art on', () => evaluate('document.documentElement.dataset.art==="on"&&localStorage.getItem("agentGuild.art")==="on"'));
  await until('guild art loads', () => evaluate('performance.getEntriesByType("resource").some(e=>e.name.includes("/skins/guild/characters/"))'));
  assert.deepEqual(await artFiles(artOn), [], 'no skin art loaded while card art was off');
  assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector("#providers .provider")).paddingTop)>100'), 'the art has its room again');
  await evaluate('document.querySelector("#art").click()');
  await until('card art off', () => evaluate('document.documentElement.dataset.art==="off"'));
  await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(startSkin[0])};document.documentElement.dataset.theme=${JSON.stringify(startSkin[1])};scrollTo(0,0)`);
  await layoutReady();
  pass('a new page starts without card art: every skin, light and dark, loads none and lays its cards out without overlap, and the switch brings the art back');

  const cardIds = () => evaluate('[...document.querySelectorAll("#providers .provider")].map(c=>c.dataset.id)');
  const allCards = await cardIds();
  const claude = '#providers [data-id="anthropic"]';
  await click(`${claude} .card-toggle`);
  assert.deepEqual(await evaluate(`(()=>{const c=document.querySelector('${claude}'),t=c.querySelector('.card-toggle'),shown=(s)=>Boolean(c.querySelector(s)?.checkVisibility());
    return [c.classList.contains('collapsed'),t.getAttribute('aria-expanded'),document.activeElement===t,...['.new','.existing','.accounts','.usage','.provider-links','.copies'].map(shown)]})()`),
  [true, 'false', true, true, true, true, false, false, false]);
  await click('#cards-open');
  await until('the cards menu opens', () => evaluate('document.querySelector("#cards-menu").matches(":popover-open")'));
  await click('#cards-shown input[value="xai"]');
  assert.deepEqual(await cardIds(), allCards.filter((id) => id !== 'xai'));
  assert.equal(await evaluate('document.querySelector("#cards-open").textContent'), 'Cards · 1 hidden');
  await evaluate('document.querySelector("#cards-menu").hidePopover()');
  await reload();
  await until('cards dealt after reload', () => evaluate('document.querySelectorAll("#providers .provider").length > 0 && !document.querySelector("#providers").classList.contains("deal")'));
  assert.deepEqual(await cardIds(), allCards.filter((id) => id !== 'xai'), 'the hidden card stays hidden');
  assert.equal(await evaluate(`document.querySelector('${claude}').classList.contains('collapsed')`), true, 'the collapsed card stays collapsed');
  await click('#cards-open');
  await until('the cards menu opens', () => evaluate('document.querySelector("#cards-menu").matches(":popover-open")'));
  await click('#cards-shown input[value="xai"]');
  assert.deepEqual(await cardIds(), allCards, 'a restored card returns to its place');
  await click('#cards-collapse');
  assert.equal(await evaluate('[...document.querySelectorAll("#providers .provider")].every(c=>c.classList.contains("collapsed"))'), true);
  await evaluate('document.querySelector("#cards-menu").hidePopover()');
  await click(`${claude} .card-toggle`);
  pass('a card collapses to what starts a session, the menu hides and restores cards, and both survive a reload');

  const cardLayout = () => evaluate(`(()=>{const hit=(a,b)=>a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5;const bad=[];
    for(const c of document.querySelectorAll('#providers .provider')){const cb=c.getBoundingClientRect(),t=c.querySelector('.card-toggle');
      if(!t.checkVisibility())bad.push(c.dataset.id+' toggle hidden');
      for(const e of c.querySelectorAll('button, a, .provider-text, .provider-icon')){if(!e.checkVisibility()||e===t)continue;const r=e.getBoundingClientRect();
        if(r.left<cb.left-0.5||r.right>cb.right+0.5||r.top<cb.top-0.5||r.bottom>cb.bottom+0.5)bad.push(c.dataset.id+' '+e.className+' outside');
        if(hit(t.getBoundingClientRect(),r))bad.push(c.dataset.id+' toggle over '+e.className);}
      if(c.classList.contains('collapsed')&&parseFloat(getComputedStyle(c).paddingTop)>24)bad.push(c.dataset.id+' keeps room for art');}
    return bad})()`);
  for (const skin of await evaluate('agentGuildSkins.map(s=>s.id)')) for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)};document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const [width, height] of [[375, 812], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
      await size(width, height);
      assert.deepEqual(await cardLayout(), [], `${skin} ${theme} ${width}`);
      await noSideScroll(`${skin} ${theme} ${width} with collapsed cards`);
    }
  }
  await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(startSkin[0])};document.documentElement.dataset.theme=${JSON.stringify(startSkin[1])}`);
  await size(1440, 900);
  pass('collapsed and expanded cards side by side keep their controls inside the card in every skin, light and dark, from phone to wide');

  await click('#cards-open');
  await until('the cards menu opens', () => evaluate('document.querySelector("#cards-menu").matches(":popover-open")'));
  for (const id of allCards) await click(`#cards-shown input[value="${id}"]`);
  await evaluate('document.querySelector("#cards-menu").hidePopover()');
  assert.deepEqual([await cardIds(), await visible('#cards-none')], [[], true]);
  await click('#view-yard');
  await until('the Yard', () => evaluate('document.documentElement.dataset.view==="yard"'));
  assert.equal(await visible('#cards-none'), false, 'the Yard does not show the Cards empty state');
  // The overlay is measured with no WebGL, so the Yard's scene never renders here: CI has no GPU.
  await evaluate('window.testGetContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...rest){return /webgl/.test(type)?null:testGetContext.call(this,type,...rest)}');
  await evaluate('document.documentElement.dataset.skin="orbital"');
  await until('Orbital shows Play now', () => visible('#yard-play'));
  assert.deepEqual(await evaluate('(()=>{const a=document.querySelector("#yard-play");return [a.href,a.target,a.rel]})()'), ['https://survive.oddessentials.ai/', '_blank', 'noopener noreferrer']);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#yard-play-menu a")].map(a=>[a.href,a.target,a.rel,a.getAttribute("role"),a.querySelector(".yard-play-title").textContent])'), [
    ['https://survive.oddessentials.ai/', '_blank', 'noopener noreferrer', 'menuitem', 'Survive the swarm'],
    ['https://towers.oddessentials.ai/', '_blank', 'noopener noreferrer', 'menuitem', 'Defend the towers'],
  ]);
  const playMenuOpen = () => visible('#yard-play-menu');
  const openPlayMenu = async () => {
    await click('#yard-play-more');
    await until('the games menu opens', playMenuOpen);
    await layoutReady();
  };
  const closePlayMenu = async () => {
    await click('#yard-play-more');
    await until('the games menu closes', async () => !(await playMenuOpen()));
  };
  // The chip's form follows the stage's width: full, then without its chevrons and tagline, then "Play", then the orb, each with the caret; narrowest, the caret alone wears the orb.
  const forms = new Set();
  const playPlaced = async (label, width) => {
    await layoutReady();
    assert.equal(await evaluate('innerWidth'), width, `${label}: the viewport keeps its width`);
    const [chip, more, stage, title] = await Promise.all([box('.yard-play-chip'), box('#yard-play-more'), box('#yard-stage'), box('.yard-heading > div:first-child')]);
    const form = stage.width > 660 ? 4 : stage.width > 480 ? 3 : stage.width > 440 ? 1 : 0;
    const split = stage.width > 380;
    forms.add(split ? form : -1);
    assert.ok(chip.height >= 44 && more.height >= 44, `${label}: Play now is ${chip.height}px tall`);
    assert.ok(more.width >= 36, `${label}: the caret is ${more.width}px wide`);
    assert.ok(chip.left >= stage.left && chip.right <= stage.right && chip.top >= stage.top && chip.bottom <= stage.bottom, `${label}: Play now is on the stage`);
    assert.equal(await visible('#yard-play'), split, `${label}: the split shows while it fits`);
    if (stage.width < 340) {
      assert.ok(title.right <= chip.left, `${label}: the title stays clear of the chip`);
      assert.equal(await visible('#yard-subtitle'), false, `${label}: only the title remains`);
    } else {
      // The room the chip leaves holds the widest title line unwrapped, in whatever font this machine has.
      const [room, needed] = await evaluate('(()=>{const heading=document.querySelector(".yard-heading"),title=heading.firstElementChild,chip=document.querySelector(".yard-play-chip");const room=chip.getBoundingClientRect().left-parseFloat(getComputedStyle(heading).columnGap)-title.getBoundingClientRect().left;const needed=Math.max(...[".yard-eyebrow","#yard-title","#yard-subtitle"].map(s=>{const e=document.querySelector(s);e.style.whiteSpace="nowrap";const w=e.scrollWidth;e.style.whiteSpace="";return w}));return [room,needed]})()');
      assert.ok(room >= needed, `${label}: the title block has ${room}px for a ${needed}px line`);
    }
    assert.equal(await evaluate('[".yard-play-chev",".yard-play-sub",".yard-play-now",".yard-play-text"].filter(s=>document.querySelector(s).checkVisibility()).length'), form, `${label}: the chip shows its ${form}-part form`);
    await noSideScroll(`${label} with Play now`);
    await openPlayMenu();
    const [menu, rows, clipped, height] = await evaluate('(()=>{const m=document.querySelector("#yard-play-menu"),b=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}},items=[...m.querySelectorAll("a")];return [b(m),items.map(b),items.filter(a=>a.scrollWidth>a.clientWidth).length,innerHeight]})()');
    assert.ok(menu.left >= 8 && menu.right <= width - 8, `${label}: the games menu is on screen sideways`);
    assert.ok(menu.top >= more.bottom && menu.bottom <= height, `${label}: the games menu opens under the caret and on screen`);
    assert.deepEqual(await evaluate('(()=>{const s=getComputedStyle(document.querySelector("#yard-play-menu"));return [s.backgroundColor,s.backdropFilter]})()'), ['rgba(0, 0, 0, 0)', 'none'], `${label}: only the cut frame paints the games menu`);
    assert.ok(rows.every((row) => row.height >= 44), `${label}: each game is tall enough to tap`);
    assert.equal(clipped, 0, `${label}: no game name is cut off`);
    await noSideScroll(`${label} with the games menu`);
    await closePlayMenu();
  };
  await playPlaced('1440', 1440);
  for (const [width, height] of [[980, 800], [972, 800], [936, 800], [844, 390], [484, 800], [476, 800], [444, 800], [436, 800], [390, 844], [384, 800], [376, 800], [360, 640], [344, 640], [336, 640], [320, 568]]) {
    await size(width, height);
    await playPlaced(String(width), width);
  }
  await size(844, 390);
  await openPlayMenu();
  await evaluate('scrollTo(0,60)');
  await until('the games menu follows the caret', () => evaluate('(()=>{const m=document.querySelector("#yard-play-menu").getBoundingClientRect(),b=document.querySelector("#yard-play-more").getBoundingClientRect();return scrollY>0&&m.top===Math.round(b.bottom+6)})()'));
  await evaluate('scrollTo(0,0)');
  await closePlayMenu();
  await size(1440, 900);
  const tab = async (modifiers) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
  };
  const lit = (selector) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor!=="rgba(0, 0, 0, 0)"`);
  await evaluate('document.querySelector("#yard-stage").focus()');
  await tab(8);
  assert.equal(await evaluate('document.activeElement.id==="yard-play-more"&&document.activeElement.matches(":focus-visible")'), true, 'Shift+Tab from the stage reaches the caret with a visible focus');
  await until('the focused part of the split is the lit one', async () => await lit('#yard-play-more') && !(await lit('#yard-play')));
  await tab(8);
  assert.equal(await evaluate('document.activeElement.id==="yard-play"&&document.activeElement.matches(":focus-visible")'), true, 'Shift+Tab again reaches Play now with a visible focus');
  await until('the focus light moves with the focus', async () => !(await lit('#yard-play-more')) && await lit('#yard-play'));
  const [ring, heading] = await Promise.all([box('.yard-play-chip'), box('.yard-heading')]);
  assert.ok(ring.left - 5 >= heading.left && ring.right + 5 <= heading.right && ring.top - 5 >= heading.top && ring.bottom + 5 <= heading.bottom, 'the focus ring is inside the heading, which clips');
  await tab(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const focusedGame = () => evaluate('document.activeElement.closest("#yard-play-menu")?document.activeElement.href:null');
  await until('Enter on the caret focuses the first game', async () => await focusedGame() === 'https://survive.oddessentials.ai/');
  await key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await focusedGame(), 'https://towers.oddessentials.ai/', 'an arrow moves to the other game');
  await key('Home', 'Home', 36);
  assert.equal(await focusedGame(), 'https://survive.oddessentials.ai/', 'Home moves to the first game');
  await key('Escape', 'Escape', 27);
  await until('Escape closes the games menu and returns to the caret', () => evaluate('!document.querySelector("#yard-play-menu").checkVisibility()&&document.activeElement.id==="yard-play-more"'));
  await openPlayMenu();
  await evaluate('window.testNoLeave=(e)=>e.preventDefault();document.addEventListener("click",testNoLeave)');
  await click('#yard-play-menu a:last-of-type');
  await until('picking a game closes the menu and returns to the caret', () => evaluate('!document.querySelector("#yard-play-menu").checkVisibility()&&document.activeElement.id==="yard-play-more"'));
  await evaluate('document.removeEventListener("click",testNoLeave)');
  await openPlayMenu();
  await click('#view-cards');
  await until('Cards closes the games menu', () => evaluate('!document.querySelector("#yard-play-menu").matches(":popover-open")'));
  await click('#view-yard');
  await until('back in the Yard', () => visible('#yard-play'));
  assert.equal(await playMenuOpen(), false, 'the games menu does not come back with the Yard');
  await openPlayMenu();
  await evaluate('document.documentElement.dataset.skin="guild"');
  await until('leaving Orbital closes the games menu', () => evaluate('!document.querySelector("#yard-play-menu").matches(":popover-open")'));
  await evaluate('document.documentElement.dataset.skin="orbital"');
  await click('#notes-open');
  await until('the dock opens', () => visible('#dock'));
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('End', 'End', 35);
  await until('the dock is at its widest', () => evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dock-space")==="720px"'));
  await playPlaced('dock', 1440);
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('Home', 'Home', 36);
  for (let dock = 320; dock <= 720; dock += 24) {
    await evaluate('document.querySelector("#dock-splitter").focus()');
    await until(`the dock is ${dock}px wide`, () => evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--dock-space")==="${dock}px"`));
    await playPlaced(`dock ${dock}`, 1440);
    await evaluate('document.querySelector("#dock-splitter").focus()');
    await key('ArrowLeft', 'ArrowLeft', 37);
  }
  await size(1280, 800);
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('End', 'End', 35);
  await playPlaced('the narrowest stage beside a dock', 1280);
  await size(1440, 900);
  await evaluate('document.documentElement.dataset.skin="orbital"');
  assert.deepEqual([...forms].sort((a, b) => a - b), [-1, 0, 1, 3, 4], 'the sizes covered every form of the chip');
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await key('Home', 'Home', 36);
  await click('#dock-close');
  await until('the dock closes', async () => !(await visible('#dock')));
  await layoutReady();
  assert.equal(await visible('#yard-play-solo'), false, 'Orbital shows only its split');
  assert.deepEqual([await visible('#yard-play-arena'), await visible('#yard-play-builders')], [false, false], 'Orbital has neither Arena nor Builders');
  const soloPlaced = async (label, width, link = '#yard-play-solo', root = '.yard-play-solo') => {
    await layoutReady();
    const [button, chip, stage, title] = await Promise.all([box(link), box(`${root} .yard-play-chip`), box('#yard-stage'), box('.yard-heading > div:first-child')]);
    assert.equal(await evaluate('innerWidth'), width, `${label}: the viewport keeps its width`);
    assert.equal(await visible(link), true, `${label}: the button shows`);
    assert.ok(button.width >= 44 && button.height >= 44, `${label}: the button is ${button.width}x${button.height}px`);
    assert.ok(chip.left >= stage.left && chip.right <= stage.right && chip.top >= stage.top && chip.bottom <= stage.bottom, `${label}: the button is on the stage`);
    assert.equal(await evaluate(`(()=>{const a=document.querySelector('${link}'),r=a.getBoundingClientRect();return a.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`), true, `${label}: nothing covers the button`);
    if (stage.width < 340) {
      assert.ok(title.right <= chip.left, `${label}: the title stays clear of the button`);
      assert.equal(await visible('#yard-subtitle'), false, `${label}: only the title remains`);
    } else {
      const [room, needed] = await evaluate(`(()=>{const heading=document.querySelector('.yard-heading'),title=heading.firstElementChild,chip=document.querySelector('${root} .yard-play-chip');`+'const room=chip.getBoundingClientRect().left-parseFloat(getComputedStyle(heading).columnGap)-title.getBoundingClientRect().left;const needed=Math.max(...[".yard-eyebrow","#yard-title","#yard-subtitle"].map(s=>{const e=document.querySelector(s);e.style.whiteSpace="nowrap";const w=e.scrollWidth;e.style.whiteSpace="";return w}));return [room,needed]})()');
      assert.ok(room >= needed, `${label}: the title block has ${room}px for a ${needed}px line`);
    }
    await noSideScroll(`${label} with the button`);
  };
  await evaluate('Promise.all([document.fonts.load("700 20px Almendra"),document.fonts.load("400 20px \\"Germania One\\"")])');
  for (const skin of ['gnomeland', 'goblinville']) {
    await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)}`);
    await until(`${skin} shows its title`, () => evaluate(`import("/yard/model.mjs").then(({WORLDS})=>document.querySelector("#yard-title").textContent===WORLDS[${JSON.stringify(skin)}].title)`));
    await layoutReady();
    assert.deepEqual(await evaluate('(()=>{const a=document.querySelector("#yard-play-solo");return [a.href,a.target,a.rel,a.querySelector(".yard-play-sub").textContent]})()'), ['https://agforever.oddessentials.ai/', '_blank', 'noopener noreferrer', 'Wizard Duels · free in your browser']);
    assert.equal(await visible('#yard-play'), false, `${skin} has no split`);
    assert.deepEqual([await visible('#yard-play-arena'), await visible('#yard-play-builders')], [false, false], `${skin} has neither Arena nor Builders`);
    assert.deepEqual(await evaluate('(()=>{const orb=document.querySelector("#yard-play-solo .yard-play-orb");return [orb.querySelectorAll("use").length,[...orb.querySelectorAll("*")].flatMap(e=>["fill","stroke","filter"].map(a=>e.getAttribute(a)?.match(/url\\(#(.+)\\)/)?.[1])).filter(id=>id&&!document.querySelector("body > .yard-play-defs #"+id))]})()'), [0, []], `${skin}: the orb paints from definitions outside the Yard, which the Cards hide`);
    await soloPlaced(`${skin} 1440`, 1440);
    for (const [width, height] of [[980, 800], [936, 800], [484, 800], [476, 800], [444, 800], [436, 800], [384, 800], [376, 800], [344, 640], [336, 640], [320, 568]]) {
      await size(width, height);
      await soloPlaced(`${skin} ${width}`, width);
    }
    await size(1440, 900);
    await click('#notes-open');
    await until('the dock opens', () => visible('#dock'));
    await evaluate('document.querySelector("#dock-splitter").focus()');
    await key('Home', 'Home', 36);
    for (let dock = 320; dock <= 720; dock += 24) {
      await evaluate('document.querySelector("#dock-splitter").focus()');
      await until(`the dock is ${dock}px wide`, () => evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--dock-space")==="${dock}px"`));
      await soloPlaced(`${skin} dock ${dock}`, 1440);
      await evaluate('document.querySelector("#dock-splitter").focus()');
      await key('ArrowLeft', 'ArrowLeft', 37);
    }
    await size(1280, 800);
    await evaluate('document.querySelector("#dock-splitter").focus()');
    await key('End', 'End', 35);
    await until('the dock is at its widest', () => evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dock-space")==="720px"'));
    await soloPlaced(`${skin} beside the widest dock`, 1280);
    await size(1440, 900);
    await evaluate('document.querySelector("#dock-splitter").focus()');
    await key('Home', 'Home', 36);
    await click('#dock-close');
    await until('the dock closes', async () => !(await visible('#dock')));
    await layoutReady();
  }
  await evaluate('document.documentElement.dataset.skin="orbital"');
  await layoutReady();
  await evaluate('HTMLCanvasElement.prototype.getContext=testGetContext');
  await evaluate('document.documentElement.dataset.layout="compact"');
  await layoutReady();
  assert.equal(await visible('#yard-play'), false, 'a compact host hides Play now');
  await evaluate('delete document.documentElement.dataset.layout;document.documentElement.dataset.skin="guild"');
  await layoutReady();
  assert.equal(await visible('#yard-play'), false, 'the Guild has no Play now');
  assert.equal(await visible('#yard-play-solo'), false, 'the Guild has no Wizard Duels button');
  assert.equal(await visible('#yard-play-builders'), false, 'the Guild has no Builders button');
  assert.deepEqual(await evaluate('(()=>{const a=document.querySelector("#yard-play-arena");return [a.href,a.target,a.rel,a.querySelector(".yard-play-sub").textContent]})()'), ['https://arena.oddessentials.ai/', '_blank', 'noopener noreferrer', 'Arena · free in your browser']);
  for (const [width, height] of [[1440, 900], [980, 800], [484, 800], [444, 800], [376, 800], [336, 640]]) {
    await size(width, height);
    await soloPlaced(`guild ${width}`, width, '#yard-play-arena', '.yard-play-arena');
  }
  await size(1440, 900);
  await evaluate('document.documentElement.dataset.skin="professional"');
  await layoutReady();
  assert.deepEqual([await visible('#yard-play'), await visible('#yard-play-solo'), await visible('#yard-play-arena')], [false, false, false], 'Professional shows only Builders');
  assert.deepEqual(await evaluate('(()=>{const a=document.querySelector("#yard-play-builders");return [a.href,a.target,a.rel,a.querySelector(".yard-play-sub").textContent]})()'), ['https://github.com/oddessentials/agent-guild-builders/releases/latest', '_blank', 'noopener noreferrer', 'Builders · for Windows']);
  for (const [width, height] of [[1440, 900], [980, 800], [524, 800], [484, 800], [444, 800], [356, 800], [336, 640]]) {
    await size(width, height);
    await soloPlaced(`professional ${width}`, width, '#yard-play-builders', '.yard-play-builders');
    assert.equal(await evaluate(`(()=>{const s=document.querySelector('.yard-play-stamp');if(!s.checkVisibility())return false;const a=s.getBoundingClientRect(),words=document.createTreeWalker(document.querySelector('.yard-play-builders .yard-play-text'),NodeFilter.SHOW_TEXT);let hit=false;while(words.nextNode()){const range=document.createRange();range.selectNodeContents(words.currentNode);for(const b of range.getClientRects())hit||=b.width>0&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;}return hit;})()`), false, `professional ${width}: the beta stamp clears the words`);
  }
  await size(1440, 900);
  assert.equal(await visible('.yard-play-stamp'), true, 'the Builders button is stamped as a beta');
  await size(1440, 900);
  assert.equal(await visible('#yard-customize-open'), false, 'the demo has no manager to customize a Yard');
  const spotClear = (label) => evaluate(`(()=>{for(const id of ['#yard-world-get','#yard-customize-open'])document.querySelector(id).hidden=false;const box=(e)=>e.getBoundingClientRect(),stage=box(document.querySelector('#yard-stage'));
    const parts=[...document.querySelectorAll('#yard-world .btn:not([hidden])')],camera=[...document.querySelectorAll('.yard-camera .btn:not([hidden])')];
    const inside=parts.every((e)=>{const r=box(e);return r.width>=44&&r.left>=stage.left&&r.right<=stage.right&&r.top>=stage.top&&r.bottom<=stage.bottom;});
    const apart=parts.every((e)=>camera.every((c)=>{const a=box(e),b=box(c);return a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top;}));
    return {label:${JSON.stringify(label)},count:parts.length,inside,apart,left:Math.round(box(document.querySelector('#yard-world')).left-stage.left)};})()`);
  const lefts = new Set();
  for (const skin of ['guild', 'orbital', 'grove', 'professional', 'goblinville', 'gnomeland']) {
    await evaluate(`document.documentElement.dataset.skin="${skin}"`);
    for (const [width, height] of [[1440, 900], [336, 640]]) {
      await size(width, height);
      const at = await spotClear(`${skin} ${width}`);
      assert.deepEqual([at.count, at.inside, at.apart], [2, true, true], JSON.stringify(at));
      if (width === 1440) lefts.add(at.left);
    }
    await size(1440, 900);
  }
  assert.equal(lefts.size, 1, `the spot sits in one place in every Yard: ${[...lefts]}`);
  await evaluate('document.documentElement.dataset.layout="compact"');
  await layoutReady();
  for (const [width, height] of [[280, 500]]) {
    await size(width, height);
    const compactSpot = await spotClear(`compact ${width}`);
    assert.deepEqual([compactSpot.count, compactSpot.inside, compactSpot.apart], [2, true, true], JSON.stringify(compactSpot));
  }
  await size(280, 500);
  await evaluate('document.querySelector("#yard-customize-open").click()');
  await until('the Customize dialog opens', () => evaluate('document.querySelector("#yard-customize").open&&document.querySelectorAll("#yard-customize-list [data-slot]").length===8'));
  assert.deepEqual(await evaluate(`(()=>{const d=document.querySelector('#yard-customize'),r=d.getBoundingClientRect(),body=d.querySelector('.models-body'),wide=[...d.querySelectorAll('button')].filter((b)=>b.getBoundingClientRect().right>innerWidth);
    return [r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,body.scrollHeight>body.clientHeight,getComputedStyle(body).overflowY,wide.length];})()`), [true, true, 'auto', 0], 'the dialog fits a compact screen and scrolls');
  const stacked = () => evaluate(`[...document.querySelectorAll('#yard-customize-list [data-slot]')].map((row)=>row.querySelector('.yard-customize-actions').getBoundingClientRect().top>=row.querySelector('.yard-customize-copy').getBoundingClientRect().bottom-1)`);
  for (const [width, height] of [[280, 500], [390, 844], [479, 844]]) {
    await size(width, height);
    assert.deepEqual(await stacked(), Array(8).fill(true), `Customize stacks its buttons under each row at ${width}px`);
  }
  await size(560, 844);
  assert.deepEqual(await stacked(), Array(8).fill(false), 'Customize keeps its buttons beside each row from 481px');
  await size(280, 500);
  await evaluate('(b=>{b.focus();b.click();})(document.querySelector("#yard-customize-list [data-slot=anthropic] button"))');
  await until('the piece dialog opens over it', () => evaluate('document.querySelector("#folder-browser").open&&document.querySelector("#folder-title").textContent==="Choose a character"&&document.querySelector("#yard-customize").open'));
  assert.deepEqual(await evaluate('[document.querySelector("#folder-use").hidden,document.querySelector("#folder-new-open").hidden]'), [true, true]);
  await evaluate('document.querySelector("#folder-browser").close()');
  await until('focus returns to Replace', () => evaluate('document.activeElement===document.querySelector("#yard-customize-list [data-slot=anthropic] button")'));
  await evaluate('document.querySelector("#yard-customize-list [data-slot=world] button").click()');
  await until('the world file dialog opens', () => evaluate('document.querySelector("#folder-browser").open&&document.querySelector("#folder-title").textContent==="Choose a world file"'));
  await evaluate('document.querySelector("#folder-browser").close();document.querySelector("#yard-customize").close()');
  await size(1440, 900);
  await evaluate('delete document.documentElement.dataset.layout;document.querySelector("#yard-world-get").hidden=true;document.querySelector("#yard-customize-open").hidden=true');
  await layoutReady();
  for (const skin of ['professional', 'gnomeland']) {
    await evaluate(`document.documentElement.dataset.skin="${skin}"`);
    for (const [width, height] of [[444, 800]]) {
      await size(width, height);
      const long = await evaluate(`(()=>{const title=document.querySelector('#yard-title'),text=title.textContent;title.textContent='A very long world name '.repeat(6).slice(0,128);title.classList.add('yard-title-custom');const box=(e)=>e.getBoundingClientRect(),t=box(title),line=parseFloat(getComputedStyle(title).lineHeight)||t.height,chip=[...document.querySelectorAll('.yard-play-chip')].find((e)=>e.checkVisibility()),c=chip&&box(chip),clear=!c||t.right<=c.left||c.right<=t.left||t.bottom<=c.top||c.bottom<=t.top,result={height:t.height,line,clear,right:t.right<=box(document.querySelector('#yard-stage')).right};title.textContent=text;title.classList.remove('yard-title-custom');return result;})()`);
      assert.ok(long.clear && long.right && long.height <= long.line * 2 + 1, `${skin} ${width}: ${JSON.stringify(long)}`);
    }
  }
  await size(1440, 900);
  pass('the world spot sits in one place in all six Yards at every width, and Customize fits a compact screen and opens each picker over itself');
  await evaluate('document.documentElement.dataset.skin="professional"');
  await layoutReady();
  await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(startSkin[0])}`);
  await click('#view-cards');
  await until('Cards', () => evaluate('document.documentElement.dataset.view==="cards"'));
  assert.equal(await visible('#cards-none'), true, 'back in Cards the empty state returns');
  await click('#cards-show-all');
  assert.deepEqual([await cardIds(), await visible('#cards-none')], [allCards, false]);
  assert.equal(await evaluate('document.activeElement.matches("#providers .card-toggle")'), true, 'focus moves to the restored cards');
  await click('#cards-expand');
  assert.equal(await evaluate('document.querySelectorAll("#providers .provider.collapsed").length'), 0);
  await evaluate('scrollTo(0,0)');
  pass('with every card hidden, Show all brings them back');

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

  await fitted();
  const beforeDock = await evaluate('testSizes.length');
  await click('#github-toggle');
  await until('dock', () => visible('#dock'));
  await layoutReady();
  await fitted();
  assert.deepEqual(await evaluate(`testSizes.slice(${beforeDock}).map(s=>s.type)`), ['resize', 'resize'], 'opening the dock refits each terminal once');
  const dock = await box('#dock');
  const stage = await box('#terminal-panel');
  assert.ok(stage.right <= dock.left + 1, 'the terminals make room for the dock');
  const content = await evaluate('(()=>{const m=document.querySelector("main");return m.getBoundingClientRect().right-parseFloat(getComputedStyle(m).paddingRight)})()');
  assert.ok(content <= dock.left, 'the cards make room for the dock');
  assert.ok((await box('.launcher')).right <= dock.left, 'the card row stays clear of the dock');
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

  await reload();
  await until('restored panes', async () => (await panes()).length === 2);
  assert.deepEqual((await panes()).map((p) => p.focused), [false, true]);
  await until('restored output', () => evaluate('testTerms.filter(t=>t.element?.isConnected).every(t=>t.testParsed)'));
  await layoutReady();
  assert.deepEqual(await evaluate('testSizes'), [], 'restored terminals do not take the size');
  pass('a reload brings back both terminals and the focused one, without resizing them');

  const focusedTerm = 'testTerms.find(t=>t.element?.isConnected&&t.element.closest(".terminal-pane.focused"))';
  await evaluate(`testSockets.filter(s=>s.url.includes('/sessions/${second}/')&&s.readyState===1).at(-1).emit({data:JSON.stringify({type:'resize',cols:300,rows:90,generation:99,owner:false})})`);
  await until("another page's size", () => evaluate(`${focusedTerm}.cols===300`));
  await layoutReady();
  const watched = await evaluate(`(()=>{const t=${focusedTerm},h=t.element.closest('.terminal-host');return {font:t.options.fontSize,note:!document.querySelector('#panel-size').hidden,overflow:h.scrollWidth>h.clientWidth}})()`);
  assert.deepEqual(watched, { font: 10, note: true, overflow: true }, 'a terminal sized elsewhere shrinks its text to the readable limit, then scrolls');
  await size(1300, 820);
  assert.deepEqual(await evaluate('testSizes'), [], 'a page that does not own the size never resizes it');
  await evaluate(`document.querySelector('#sessions .session-card[data-id="${second}"] .open').click()`);
  await fitted(`[${focusedTerm}]`);
  assert.equal((await sizesFor(second)).length, 1);
  assert.match((await sizesFor(second))[0], /^claim /, 'opening it here claims the size');
  assert.deepEqual(await evaluate(`[${focusedTerm}.options.fontSize,document.querySelector('#panel-size').hidden]`), [13, true]);
  await size(1440, 900);
  await fitted(`[${focusedTerm}]`);
  assert.match((await sizesFor(second)).at(-1), /^resize /, 'the owner follows its window');
  assert.deepEqual(await sizesFor(first), [], 'the terminal it does not own stays as it is');
  pass('a terminal sized by another page stays readable until opened here, and then follows this window');

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
  const midGrid = await providerGrid();
  assert.deepEqual([midGrid.count, midGrid.rows], [6, 2], 'too narrow for six: three by two, never a lone card');
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
  await reload();
  await until('restored panes', async () => (await panes()).length >= 1);
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

  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.testApp=[];window.webkit={messageHandlers:{agentGuild:{postMessage:m=>testApp.push(m)}}};',
  });
  await size(393, 852);
  await navigate(`${origin}/?app#token=t&view=yard`);
  await until('the app opens the Yard', () => evaluate('document.documentElement.dataset.view==="yard"&&testApp.some(m=>m.type==="ready")'));
  await evaluate('document.documentElement.dataset.skin="orbital"');
  await openPlayMenu();
  await click('#yard-play-menu a:last-of-type');
  await until('a game opens through the app', () => evaluate('testApp.some(m=>m.type==="open"&&m.url==="https://towers.oddessentials.ai/")'));
  await until('and its menu closes', async () => !(await playMenuOpen()));
  const folderRow = async (width) => {
    await size(width, 852);
    const [label, input, tools] = await Promise.all([box('.cwd > label'), box('#cwd'), box('.cwd-tools')]);
    assert.ok(tools.left > label.right && tools.left - input.left >= 100 && input.right <= width,
      `Yard at ${width}: the folder tools cover neither the label nor the path (${JSON.stringify({ label, input, tools })})`);
  };
  for (const width of [393, 640]) await folderRow(width);
  pass('on a phone the Yard\'s working folder field shows the path beside its tools');

  await evaluate('window.testViews=[];new MutationObserver(()=>testViews.push(document.documentElement.dataset.view)).observe(document.documentElement,{attributeFilter:["data-view"]})');
  const ask = (view) => evaluate(`window.postMessage({source:'agent-guild-app',type:'view',view:'${view}'},location.origin)`);
  await ask('cards');
  await until('Cards', () => evaluate('document.documentElement.dataset.view==="cards"'));
  await click('#sessions .session-card .open');
  await until('terminal', () => visible('#terminal-panel'));
  await ask('yard');
  await until('the Yard again', () => evaluate('document.documentElement.dataset.view==="yard"'));
  await layoutReady();
  assert.equal(await visible('#terminal-panel'), false, 'the terminal closes first');
  assert.deepEqual(await evaluate('[testViews, localStorage.getItem("agentGuild.view"), testApp.filter(m=>m.type==="ready").length]'), [['cards', 'yard'], 'yard', 1]);
  pass('the app opens the page in the Yard and switches views once per request, closing a terminal first');

  assert.equal(await visible('.yard-help-pointer'), true);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until('coarse pointer', () => evaluate('matchMedia("(pointer: coarse)").matches'));
  assert.deepEqual([await visible('.yard-help-pointer'), await visible('.yard-help-touch')], [false, true]);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  pass('on a touch screen the Yard\'s hint names touch gestures');

  // Like Android's WebMessageListener object, which refuses anything but a string.
  const android = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.testApp=[];window.agentGuild={postMessage:m=>{if(typeof m!=="string")throw new TypeError("not a string");testApp.push(JSON.parse(m))}};',
  });
  await navigate(`${origin}/?android#token=t&view=yard`);
  await until('the Android app opens the Yard', () => evaluate('document.documentElement.dataset.view==="yard"&&testApp.some(m=>m.source==="agent-guild"&&m.type==="ready")'));
  await layoutReady();
  await ask('cards');
  await until('Cards for the Android app', () => evaluate('document.documentElement.dataset.view==="cards"'));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: android.identifier });
  pass('the Android app opens the page in the Yard, gets its readiness as JSON text and switches views');

  const tv = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.testApp=[];window.agentGuild={postMessage:m=>testApp.push(JSON.parse(m))};localStorage.setItem("agentGuild.view","yard");',
  });
  await evaluate('document.documentElement.dataset.skin="guild"');
  await evaluate('localStorage.setItem("testBreakCard","1");');
  await reload();
  await click('#view-cards');
  await until('the break buttons', () => evaluate('document.querySelector(".provider[data-id=\\"terminal-ai-chat\\"] .break-row .yard-play")?.checkVisibility()&&document.querySelector("#providers").getAnimations({subtree:true}).every((a)=>!Number.isFinite(a.effect.getComputedTiming().endTime))'));
  const breakFit = () => evaluate(`(()=>{const card=document.querySelector('.provider[data-id="terminal-ai-chat"]'),c=card.getBoundingClientRect(),box=(e)=>e.getBoundingClientRect();
    const chips=[...card.querySelectorAll('.break-row .yard-play-chip')],parts=[...card.querySelectorAll('.break-row .yard-play-link,.break-row .yard-play-more')];
    return {count:chips.length,small:parts.filter((e)=>box(e).width<44||box(e).height<44).length,
      outside:chips.filter((e)=>{const r=box(e);return r.left<c.left||r.right>c.right||r.top<c.top||r.bottom>c.bottom;}).length,
      overlap:chips.some((a,i)=>chips.slice(i+1).some((b)=>{const x=box(a),y=box(b);return x.left<y.right&&y.left<x.right&&x.top<y.bottom&&y.top<x.bottom;})),
      words:card.querySelectorAll('.break-row .yard-play-text,.break-row .yard-play-chev').length,ids:new Set([...document.querySelectorAll('[id]')].map((e)=>e.id)).size===document.querySelectorAll('[id]').length};})()`);
  for (const skin of ['guild', 'orbital', 'grove', 'professional', 'goblinville', 'gnomeland']) {
    await evaluate(`document.documentElement.dataset.skin="${skin}"`);
    for (const [width, height] of [[390, 844]]) {
      await size(width, height);
      const fit = await breakFit();
      assert.deepEqual([fit.count, fit.small, fit.outside, fit.overlap, fit.words, fit.ids], [5, 0, 0, false, 0, true], `${skin} ${width}: ${JSON.stringify(fit)}`);
    }
  }
  await size(1440, 900);
  const breakLabel = () => evaluate('document.querySelector(".break-buttons:not([hidden]) .break-label").textContent');
  assert.equal(await breakLabel(), 'Need a break?');
  const breakTap = (selector, pointerType) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const before=testApp.filter((m)=>m.type==='open').length;e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:${JSON.stringify(pointerType)}}));e.click();return testApp.filter((m)=>m.type==='open').length-before;})()`);
  const arena = '.break-row .yard-play-arena .yard-play-link';
  assert.equal(await breakTap(arena, 'touch'), 0, 'the first tap only selects');
  assert.match(await breakLabel(), /Arena.*Tap again to open/);
  assert.equal(await breakTap(arena, 'touch'), 1, 'the second tap opens');
  assert.equal(await breakLabel(), 'Need a break?');
  assert.equal(await breakTap(arena, 'mouse'), 1, 'a mouse opens at once');
  await breakTap(arena, 'touch');
  await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerType:"touch"}))');
  assert.equal(await breakLabel(), 'Need a break?', 'tapping elsewhere cancels');
  await evaluate('document.querySelector(".break-row .yard-play-more").click()');
  await until('the card menu', () => evaluate('Boolean(document.querySelector(".break-row .yard-play-menu:popover-open"))'));
  assert.deepEqual(await evaluate('[...document.querySelector(".break-row .yard-play-menu").querySelectorAll("a")].map((a)=>[a.href,a.target])'), [['https://survive.oddessentials.ai/', '_blank'], ['https://towers.oddessentials.ai/', '_blank']]);
  await size(1440, await evaluate('Math.ceil(document.querySelector(".break-row .yard-play-more").getBoundingClientRect().bottom)+6'));
  await until('the card menu above its button', () => evaluate('(()=>{const m=document.querySelector(".break-row .yard-play-menu:popover-open");if(!m)return false;const r=m.getBoundingClientRect(),b=document.querySelector(".break-row .yard-play-more").getBoundingClientRect();return r.top>=0&&r.bottom<=b.top&&m.scrollHeight<=m.clientHeight;})()'));
  assert.equal(await evaluate('(()=>{const m=document.querySelector(".break-row .yard-play-menu");m.style.top="5000px";window.dispatchEvent(new Event("resize"));return m.getBoundingClientRect().bottom<=innerHeight;})()'), true, 'a resize moves an open card menu back into view');
  await evaluate('document.querySelector(".break-row .yard-play-menu").hidePopover()');
  await size(1440, 900);
  await evaluate('localStorage.removeItem("testBreakCard")');
  pass('the Terminal AI Chat card offers the five Yard buttons at their smallest in every skin, and a touch needs a second tap');

  await navigate(`${origin}/?tv#token=t&layout=compact&expand=none&view=yard&yard=none`);
  await until('the TV app opens the Cards', () => evaluate('document.documentElement.dataset.view==="cards"&&testApp.some(m=>m.type==="ready")'));
  await layoutReady();
  assert.deepEqual(await evaluate('["layout" in document.documentElement.dataset, document.querySelector("#yard").hidden, document.querySelector("#view-yard").closest("fieldset").checkVisibility({visibilityProperty:true})]'), [false, true, false]);
  await ask('yard');
  await click('#skin-choices input[value="grove"]');
  await until('the grove skin', () => evaluate('document.documentElement.dataset.skin==="grove"'));
  await ask('cards');
  await layoutReady();
  assert.equal(await evaluate('document.documentElement.dataset.view'), 'cards');
  assert.deepEqual(await evaluate('performance.getEntriesByType("resource").map(e=>e.name).filter(n=>/\\/yard\\/(?:renderer|assets\\/)|yard-art/.test(n))'), []);
  assert.equal(await evaluate('localStorage.getItem("agentGuild.view")'), 'cards', 'the Cards the TV asked for are kept');
  assert.equal(await evaluate('location.hash'), '#yard=none');
  await reload();
  await until('the reloaded TV page opens the Cards', () => evaluate('document.documentElement.dataset.view==="cards"&&testApp.some(m=>m.type==="ready")'));
  await layoutReady();
  assert.deepEqual(await evaluate('[location.hash, localStorage.getItem("agentGuild.view"), document.querySelector("#view-yard").closest("fieldset").checkVisibility({visibilityProperty:true})]'), ['#yard=none', 'yard', false]);
  assert.deepEqual(await evaluate('performance.getEntriesByType("resource").map(e=>e.name).filter(n=>/\\/yard\\/(?:renderer|assets\\/)|yard-art/.test(n))'), []);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tv.identifier });
  pass('with &yard=none the page shows the Cards, offers no Yard, ignores requests for it and never loads its scene or art, after a reload too');

  const ORNAMENT_SHARE = 79 / 232;
  await evaluate('document.documentElement.dataset.skin="guild"');
  const crowded = () => evaluate(`(()=>{const out=[];
    for(const d of document.querySelectorAll('dialog.models')){
      if(d.open)d.close();d.showModal();
      const r=d.getBoundingClientRect(),ornament=parseFloat(getComputedStyle(d,'::after').borderTopWidth)*${ORNAMENT_SHARE};let gap=Infinity;
      const near=(e,el)=>{let x0=e.left,y0=e.top,x1=e.right,y1=e.bottom;
        for(let a=el;a&&a!==d;a=a.parentElement){const s=getComputedStyle(a);if(a!==el&&(s.overflowX!=='visible'||s.overflowY!=='visible')){const c=a.getBoundingClientRect();x0=Math.max(x0,c.left);y0=Math.max(y0,c.top);x1=Math.min(x1,c.right);y1=Math.min(y1,c.bottom);}}
        if(x1-x0>1&&y1-y0>1)gap=Math.min(gap,x0-r.left,r.right-x1,y0-r.top,r.bottom-y1);};
      for(const el of d.querySelectorAll('button,input,select,textarea,.btn'))if(el.checkVisibility())near(el.getBoundingClientRect(),el);
      const walk=document.createTreeWalker(d,NodeFilter.SHOW_TEXT);
      while(walk.nextNode()){const t=walk.currentNode;if(!t.textContent.trim()||!t.parentElement.checkVisibility())continue;const range=document.createRange();range.selectNodeContents(t);for(const e of range.getClientRects())near(e,t.parentElement);}
      d.close();
      if(!(gap-ornament>=12))out.push(d.id+' '+Math.round(gap)+'px from the edge, ornament '+Math.round(ornament)+'px');
    }return out;})()`);
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await size(width, height);
    assert.deepEqual(await crowded(), [], `guild ${width}`);
  }
  await size(1440, 900);
  pass('every framed Guild dialog keeps its controls and text at least 12px clear of the ornament, on desktop and phone');

  assert.deepEqual(errors, []);
  pass('the page has no uncaught browser exceptions');
});
console.log(`${checks} layout checks passed.`);
