// Progressive branches against simulated manager responses, never live GitHub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withPage, until } from './chrome.mjs';

const instrumentation = `<script>
window.testBranches = { requests: [], held: [], hold: [2], fail: null, copied: [], denyCopy: false, metadataError: null,
  pages: [['trunk', ...Array.from({length:99}, (_,i)=>'z-'+String(i).padStart(3,'0'))],
    Array.from({length:100}, (_,i)=>'a-'+String(i).padStart(3,'0')), ['feat/name#%é']] };
Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async text=>{
  if(testBranches.denyCopy) throw new Error('Denied'); testBranches.copied.push(text);
}}});
const branchFetch = window.fetch;
window.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.endsWith('/branches')) return branchFetch.call(this, input, init);
  const page = Number(url.searchParams.get('page') || 1);
  testBranches.requests.push(url.pathname + url.search);
  const pages = url.pathname.includes('/storefront/') ? testBranches.pages : [['different-repository']];
  const names = pages[page-1] || [];
  const data = { branches:names.map((name,i)=>({name, sha:String(i%10).repeat(40),protected:name==='trunk',url:'https://github.com/acme/storefront/tree/'+encodeURIComponent(name)})),
    defaultBranch:page===1&&!testBranches.metadataError?'trunk':null,metadataError:testBranches.metadataError,nextPage:page<pages.length?page+1:null,
    fetchedAt:new Date().toISOString(),url:'https://github.com/acme/storefront/branches' };
  const failed = testBranches.fail === page;
  if(failed) testBranches.fail=null;
  if(testBranches.hold.includes(page)) {
    testBranches.hold.splice(testBranches.hold.indexOf(page),1);
    await new Promise(resolve=>testBranches.held.push(resolve));
  }
  return new Response(JSON.stringify(failed?{error:{code:'github_unreachable',message:'GitHub is temporarily unavailable.'}}:data),{status:failed?502:200});
};
</script>`;

const checks = await withPage({ name: 'github-branches', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const click = (selector) => evaluate(`{ const e=document.querySelector(${JSON.stringify(selector)}); e.focus(); e.click(); }`);
  const input = (selector, text) => evaluate(`{ const e=document.querySelector(${JSON.stringify(selector)}); e.focus(); e.value=${JSON.stringify(text)}; e.dispatchEvent(new Event('input',{bubbles:true})); }`);
  const rows = () => evaluate(`[...document.querySelectorAll('#github-branches-list > *')].map(e=>e.dataset.branch)`);
  const status = () => evaluate(`document.querySelector('#github-branches-status').textContent`);
  const done = () => until('branches finished', () => evaluate(`!document.querySelector('#github-branches-refresh').disabled`));
  const held = () => until('held branches', () => evaluate('testBranches.held.length > 0'));
  const release = () => evaluate('testBranches.held.shift()()');
  const choose = async (query) => {
    await input('#github-repo', query);
    await until('matching repository', () => evaluate(`Boolean(document.querySelector('#github-repo-list [role=option]'))`));
    await click('#github-repo-list [role=option]');
    await evaluate(`document.querySelector('#github-repo').blur()`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false });
  await send('Page.navigate', { url:origin });
  await until('app ready', () => evaluate(`document.querySelectorAll('#sessions .session-card').length >= 3`));
  await click('#github-toggle');
  await until('repository picker', () => evaluate(`!document.querySelector('#github-picker').hidden`));
  await choose('storefront');
  await click('#github-view-branches');
  await held();
  assert.equal((await rows()).length, 100);
  assert.match(await status(), /Loading more/);
  await evaluate(`{
    const panel=document.querySelector('#github-branches'), row=document.querySelector('[data-branch="z-020"]');
    panel.scrollTop += row.getBoundingClientRect().top-panel.getBoundingClientRect().top+4;
    row.querySelector('button').focus({preventScroll:true});
    window.anchorBefore=row.getBoundingClientRect().top-panel.getBoundingClientRect().top;
  }`);
  await release();
  await done();
  assert.equal((await rows()).length, 201);
  assert.equal((await rows())[0], 'trunk');
  assert.ok(Math.abs(await evaluate(`document.querySelector('[data-branch="z-020"]').getBoundingClientRect().top-document.querySelector('#github-branches').getBoundingClientRect().top-anchorBefore`)) < 1);
  assert.equal(await evaluate('document.activeElement.closest("[data-branch]")?.dataset.branch'), 'z-020');
  assert.equal(await evaluate('testBranches.requests.length'), 3);
  pass('201 branches load across all pages; alphabetical insertions preserve the visible row and focused control');

  await input('#github-branches-filter', 'feat/name');
  assert.deepEqual(await rows(), ['feat/name#%é']);
  assert.match(await evaluate(`document.querySelector('#github-branches-list a').href`), /feat%2Fname%23%25%C3%A9$/);
  await click('#github-branches-list button');
  assert.deepEqual(await evaluate('testBranches.copied'), ['feat/name#%é']);
  await evaluate('testBranches.denyCopy=true');
  await click('#github-branches-list button');
  assert.match(await evaluate(`document.querySelector('#toast').textContent`), /Could not copy/);
  await input('#github-branches-filter', 'no-such-branch');
  assert.match(await status(), /No branches match/);
  await click('#github-branches-clear');
  assert.equal(await evaluate('document.activeElement.id'), 'github-branches-filter');
  assert.equal((await rows()).length, 201);
  pass('filtering, clear, exact-name copy, safe links and clipboard failure work');

  await evaluate('testBranches.hold=[2]');
  await click('#github-branches-refresh');
  await held();
  await input('#github-branches-filter', 'z-0');
  await evaluate(`document.querySelector('#github-branches-filter').setSelectionRange(1,2)`);
  await release();
  await done();
  assert.deepEqual(await evaluate(`{const e=document.querySelector('#github-branches-filter');[document.activeElement.id,e.value,e.selectionStart,e.selectionEnd]}`), ['github-branches-filter','z-0',1,2]);
  await click('#github-branches-clear');
  await evaluate('testBranches.fail=1');
  await click('#github-branches-refresh');
  await done();
  assert.equal((await rows()).length, 201);
  assert.match(await status(), /Showing previous results/);
  await evaluate('testBranches.pages=[[],["new-branch"]]; testBranches.fail=2');
  await click('#github-branches-retry');
  await done();
  assert.equal((await rows()).length, 0);
  assert.match(await status(), /incomplete/);
  await click('#github-branches-retry');
  await done();
  assert.deepEqual(await rows(), ['new-branch']);
  pass('pagination preserves filter selection; failed refresh retains results; retry continues past an empty page and removes deleted branches');

  await evaluate('testBranches.pages=[["old-repository"]]; testBranches.hold=[1]');
  await click('#github-branches-refresh');
  await held();
  await choose('api-gateway');
  await done();
  assert.deepEqual(await rows(), ['different-repository']);
  await release();
  await layoutReady();
  assert.deepEqual(await rows(), ['different-repository']);
  pass('a delayed result cannot replace the newly selected repository');

  await evaluate(`testBranches.pages=[Array.from({length:100},(_,i)=>'z-'+String(i).padStart(3,'0')),Array.from({length:100},(_,i)=>'a-'+String(i).padStart(3,'0'))];testBranches.hold=[2]`);
  await choose('storefront');
  await held();
  await evaluate(`{const panel=document.querySelector('#github-branches');panel.scrollTop=0;window.topAnchor=document.querySelector('[data-branch="z-000"]').getBoundingClientRect().top-panel.getBoundingClientRect().top;}`);
  await release();
  await done();
  assert.ok(Math.abs(await evaluate(`document.querySelector('[data-branch="z-000"]').getBoundingClientRect().top-document.querySelector('#github-branches').getBoundingClientRect().top-topAnchor`)) < 1, 'the first visible branch remains anchored even before scrolling');
  pass('earlier pages preserve the reading position even at the top of the list');

  await evaluate('testBranches.pages=[[]]');
  await click('#github-branches-refresh');
  await done();
  assert.match(await status(), /No remote branches yet/);
  await evaluate('testBranches.pages=[["trunk","release/2026","feat/a-very-long-branch-name-with-no-spaces-"+"long".repeat(24)]]; testBranches.metadataError="Metadata unavailable"');
  await click('#github-branches-refresh');
  await done();
  assert.equal(await evaluate(`document.querySelector('#github-branches-metadata').hidden`), false);
  pass('empty repositories and metadata failure have distinct states');

  // Native tab key events exercise the established roving tabindex behavior.
  await evaluate(`document.querySelector('#github-view-branches').focus()`);
  for (const [key, code, vk, expected] of [['Home','Home',36,'repos'],['End','End',35,'branches'],['ArrowRight','ArrowRight',39,'repos'],['ArrowLeft','ArrowLeft',37,'branches']]) {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});
    assert.equal(await evaluate('document.activeElement.id'), 'github-view-'+expected);
  }
  await done();
  assert.equal(await evaluate(`document.querySelectorAll('#github-views [aria-selected="true"]').length`), 1);
  pass('all five tabs support arrows, Home and End with one selected tab');

  for (const skin of ['guild','professional','orbital','grove','gnomeland','goblinville']) for (const theme of ['light','dark']) for (const width of [1440,820,390,320]) {
    await evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)}; document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.setProperty('--dock-w','320px')`);
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});
    await layoutReady();
    assert.equal(await evaluate(`[...document.querySelectorAll('#github-views, #github-branches, .github-branch-filter, #github-branches-list > *')].every(e=>e.scrollWidth<=e.clientWidth+1)`), true, `${skin} ${theme} ${width}: no horizontal overflow`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#github-views button')].every(e=>e.getBoundingClientRect().width>=30)`), true);
    if (process.env.BRANCH_SCREENSHOTS && skin === 'guild' && theme === 'dark' && [1440,390].includes(width)) {
      fs.mkdirSync(process.env.BRANCH_SCREENSHOTS,{recursive:true});
      const shot=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(process.env.BRANCH_SCREENSHOTS,`branches-${width}.png`),Buffer.from(shot.data,'base64'));
    }
  }
  pass('long branch names and five tabs fit desktop, tablet and 320px phones in all six skins and both themes');
  assert.deepEqual(errors, []);
});
console.log(`Passed ${checks} branches browser checks.`);
