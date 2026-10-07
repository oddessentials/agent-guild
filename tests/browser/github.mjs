// Real GitHub controls, simulated accounts and deliberately delayed responses.
// Run: node tests/browser/github.mjs (CHROME_PATH may name Chrome/Edge).
import assert from 'node:assert/strict';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
window.testGithub = { requests: [], writes: [], completed: 0, held: [], bulk: 201, unavailable: false, removed: false,
  bodies: { 42: 'x'.repeat(50000), 39: 'first\\r\\nlast' } };
const DemoSocket = window.WebSocket;
window.WebSocket = class extends DemoSocket {
  constructor(...args) { super(...args); if (this.url.includes('/events')) testGithub.events = this; }
};
const demoFetch = window.fetch;
window.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = init?.method || 'GET', path = url.pathname;
  const body = init?.body ? JSON.parse(init.body) : undefined;
  const write = /\\/issues(?:\\/\\d+)?$/.test(path) && ['POST', 'PATCH'].includes(method);
  testGithub.requests.push({ method, path });
  const failed = write && testGithub.failNextWrite;
  if (write) { testGithub.writes.push({ method, path, body }); testGithub.failNextWrite = false; }
  if (write && testGithub.holdNextWrite || method === 'GET' && /\\/issues$/.test(path) && testGithub.holdNextRead) {
    if (write) testGithub.holdNextWrite = false; else testGithub.holdNextRead = false;
    await new Promise(resolve => testGithub.held.push(resolve));
  }
  if (failed) { testGithub.completed++; return new Response(JSON.stringify({error:{message:'GitHub did not allow this edit.',code:'forbidden'}}),{status:403}); }
  const response = await demoFetch.call(this, url.href.replace('/accounts/2002/', '/accounts/1001/'), init);
  if (write) { testGithub.completed++; return response; }
  const answer = data => new Response(JSON.stringify(data), {status:response.status});
  if (path === '/api/v1/github') {
    const data = await response.json(), account = data.github.accounts[0];
    account.needsSignIn = testGithub.unavailable;
    data.github.accounts = testGithub.removed ? [] : [account];
    data.github.accounts.push({...account, id:2002, login:'work-dev', name:'Work Developer', needsSignIn:false});
    return answer(data);
  }
  if (path === '/api/v1/github/repos') {
    const data = await response.json(), sample = data.repos[0];
    if (testGithub.unavailable || testGithub.removed) data.repos = [];
    data.repos.push({...sample, accountId:2002, login:'work-dev'});
    for (let i=0; i<testGithub.bulk; i++) data.repos.push({...sample, name:'bulk-'+String(i).padStart(3,'0'), fullName:'acme/bulk-'+String(i).padStart(3,'0')});
    if(testGithub.unavailable) data.errors.push({accountId:1001,login:'demo-dev',message:'Sign in again.'});
    return answer(data);
  }
  if (method === 'GET' && /\\/acme\\/storefront\\/issues$/.test(path)) {
    const data = await response.json();
    for (const issue of data.issues) if (testGithub.bodies[issue.number] !== undefined) issue.body = testGithub.bodies[issue.number];
    return answer(data);
  }
  return response;
};
</script>`;

const checks = await withPage({ name: 'github', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const click = (selector) => evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click();}`);
  const visible = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const value = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`);
  const input = (selector, text) => evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));}`);
  const search = (query) => input('#github-repo', query);
  const key = (name) => evaluate(`document.querySelector('#github-repo').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true}))`);
  const choose = async (query) => {
    await search(query);
    await click('#github-repo-list [role=option]');
    await evaluate(`document.querySelector('#github-repo').blur()`);
  };
  const title = '#github-issues form input', body = '#github-issues form textarea';
  const submit = '#github-issues form .btn.primary';
  const issueList = () => until('issue list', () => evaluate(`!document.querySelector('#github-issues form') && !document.querySelector('#github-issues [data-key="refresh"]')?.disabled`));
  const lastWrite = () => evaluate('testGithub.writes.at(-1)');
  const newIssue = async (text) => { await click('#github-issues [data-key="new"]'); await input(title, text); };
  const release = () => evaluate('testGithub.held.shift()()');
  const held = () => until('held request', () => evaluate('testGithub.held.length > 0'));
  const cancel = () => evaluate(`[...document.querySelectorAll('#github-issues form button')].find(b=>b.textContent==='Cancel').click()`);

  await send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false });
  await send('Page.navigate', { url:origin });
  await until('app loaded', () => evaluate(`document.querySelectorAll('#sessions .session-card').length >= 3`));
  await click('#github-toggle');
  await until('accounts loaded', () => evaluate(`document.querySelectorAll('#github-chips .account-chip').length === 2`));
  await choose('storefront demo-dev');
  await click('#github-view-issues');
  await issueList();
  await click('#github-issues [data-key="edit:42"]');
  assert.equal((await value(body)).length, 50000);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(body)}).readOnly`), true);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true);
  const unchanged = await evaluate('testGithub.writes.length');
  await evaluate(`document.querySelector('#github-issues form').requestSubmit()`);
  assert.equal(await evaluate('testGithub.writes.length'), unchanged);
  await input(title, 'Only the title changed');
  await click(submit);
  await issueList();
  assert.deepEqual((await lastWrite()).body, { title:'Only the title changed' });
  assert.equal(await evaluate('document.activeElement.dataset.key'), 'new', 'the current editor returns focus to New issue');
  pass('a title-only edit preserves a 50,000-character description and an unchanged form sends nothing');

  await click('#github-issues [data-key="edit:39"]');
  assert.equal(await value(body), 'first\nlast');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true);
  await input(title, 'Line endings stay unchanged');
  await click(submit);
  await issueList();
  assert.deepEqual((await lastWrite()).body, { title:'Line endings stay unchanged' });
  await click('#github-issues [data-key="edit:39"]');
  await input(body, '');
  await click(submit);
  await issueList();
  assert.deepEqual((await lastWrite()).body, { body:'' });
  pass('textarea normalization does not resend untouched content; intentional clearing sends an empty body');

  await newIssue('A draft kept through validation');
  const beforeInvalid = await evaluate('testGithub.writes.length');
  for (const text of ['x'.repeat(48001), '漢'.repeat(24000), '\\'.repeat(40000)]) {
    await input(body, text);
    await click(submit);
    assert.equal(await evaluate('testGithub.writes.length'), beforeInvalid);
    assert.equal(await value(body), text);
    assert.equal(await visible('#github-issues form .github-error:not([hidden])'), true);
  }
  await input(body, 'A short description');
  await input(title, 'x'.repeat(257));
  await click(submit);
  assert.equal(await evaluate('testGithub.writes.length'), beforeInvalid);
  await cancel();
  pass('oversized titles, descriptions, Unicode and escaped payloads report inline errors without losing text');

  await newIssue('Retry this draft');
  await input(body, 'Retain the description');
  await evaluate('testGithub.failNextWrite=true');
  await click(submit);
  await until('inline refusal', () => visible('#github-issues form .github-error:not([hidden])'));
  assert.equal(await value(title), 'Retry this draft');
  assert.equal(await value(body), 'Retain the description');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), false);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(submit)})`), true);
  await click(submit);
  await issueList();
  pass('a refused write preserves the draft and returns focus to the enabled retry action');

  await click('#github-view-repos');
  await click('#github-chips [data-account="2002"]');
  await click('#github-view-issues');
  assert.equal(await visible('#github-accounts'), false);
  assert.match(await evaluate(`document.querySelector('#github-sub').textContent`), /Acting as @demo-dev/);
  await newIssue('Through the picked account');
  assert.match(await evaluate(`document.querySelector('#github-issues form .github-small').textContent`), /@demo-dev/);
  await click(submit);
  await issueList();
  assert.match((await lastWrite()).path, /accounts\/1001\//);
  await choose('storefront work-dev');
  await issueList();
  assert.match(await evaluate(`document.querySelector('#github-sub').textContent`), /Acting as @work-dev/);
  await newIssue('Through the work account');
  await click(submit);
  await issueList();
  assert.match((await lastWrite()).path, /accounts\/2002\//);
  await click('#github-issues [data-key="edit:39"]');
  await input(title, 'Saved along with closing');
  assert.equal(await evaluate(`document.querySelector('#github-issues .btn.danger').textContent`), 'Save and close');
  await click('#github-issues .btn.danger');
  await issueList();
  assert.deepEqual((await lastWrite()).body, { title:'Saved along with closing', state:'closed' });
  assert.match((await lastWrite()).path, /accounts\/2002\//);
  await click('#github-issues [data-key="state:closed"]');
  await issueList();
  await click('#github-issues [data-key="edit:39"]');
  await evaluate(`[...document.querySelectorAll('#github-issues form button')].find(b=>b.textContent==='Reopen issue').click()`);
  await issueList();
  assert.deepEqual((await lastWrite()).body, { state:'open' });
  assert.match((await lastWrite()).path, /accounts\/2002\//);
  await click('#github-issues [data-key="state:open"]');
  pass('account-management tabs cannot override issue identity, and create, save/close and reopen use the displayed account');

  // Both successful and failed old writes must leave another repository's draft alone.
  for (const failed of [false, true]) {
    await choose('storefront demo-dev');
    await issueList();
    await newIssue('Earlier request');
    await evaluate(`testGithub.holdNextWrite=true;testGithub.failNextWrite=${failed}`);
    const count = await evaluate('testGithub.writes.length');
    await click(submit);
    await held();
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(title)}).readOnly && document.querySelector(${JSON.stringify(body)}).readOnly`), true);
    await evaluate(`document.querySelector('#github-issues form').requestSubmit()`);
    assert.equal(await evaluate('testGithub.writes.length'), count + 1);
    await choose('api-gateway');
    await newIssue('Newer unsaved draft');
    await input(body, 'Keep this text and focus');
    const completed = await evaluate('testGithub.completed');
    const reads = await evaluate(`testGithub.requests.filter(r=>r.method==='GET'&&r.path.endsWith('/issues')).length`);
    await release();
    await until('write completed', () => evaluate(`testGithub.completed>${completed}`));
    await layoutReady();
    assert.equal(await value(title), 'Newer unsaved draft');
    assert.equal(await value(body), 'Keep this text and focus');
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(body)})`), true);
    assert.equal(await evaluate(`testGithub.requests.filter(r=>r.method==='GET'&&r.path.endsWith('/issues')).length`), reads);
    assert.equal(await visible('#github-issues form .github-error:not([hidden])'), false);
    await cancel();
  }
  pass('delayed success and failure cannot clear, refresh or focus a newer draft, and pending forms cannot submit twice');

  // Returning to precisely the same repository and issue still creates a new editor.
  await choose('storefront demo-dev');
  await issueList();
  await click('#github-issues [data-key="edit:42"]');
  await input(title, 'An earlier edit');
  await evaluate('testGithub.holdNextWrite=true');
  await click(submit);
  await held();
  await choose('api-gateway');
  await choose('storefront demo-dev');
  await issueList();
  await click('#github-issues [data-key="edit:42"]');
  await input(title, 'A newer edit to the same issue');
  await release();
  await layoutReady();
  assert.equal(await value(title), 'A newer edit to the same issue');
  await cancel();
  pass('returning to the same repository and issue does not revive an old editor completion');

  await newIssue('Refresh race');
  await evaluate('testGithub.holdNextRead=true');
  await click(submit);
  await held();
  await newIssue('Draft opened while refresh was pending');
  await input(body, 'Still typing');
  await release();
  await layoutReady();
  assert.equal(await value(title), 'Draft opened while refresh was pending');
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(body)})`), true);
  await cancel();
  pass('the post-save refresh cannot overwrite or steal focus from a newly opened editor');

  for (const away of ['#github-view-actions', '#dock-close']) {
    if (!(await visible('#github'))) await click('#github-toggle');
    await click('#github-view-issues');
    await newIssue('Complete while away');
    await evaluate('testGithub.holdNextWrite=true');
    await click(submit);
    await held();
    await click(away);
    const focused = await evaluate('document.activeElement.id');
    await release();
    await layoutReady();
    assert.equal(await evaluate('document.activeElement.id'), focused);
  }
  await click('#github-toggle');
  await click('#github-view-issues');
  await issueList();
  pass('completion while another view is active or the dock is closed leaves focus alone');

  await newIssue('Keep through sign-in expiry');
  await evaluate(`testGithub.unavailable=true;testGithub.events.emit({data:JSON.stringify({type:'github.updated'})})`);
  await until('writes disabled', () => evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`));
  assert.equal(await value(title), 'Keep through sign-in expiry');
  assert.match(await evaluate(`document.querySelector('#github-issues form .github-error:not([hidden])').textContent`), /@demo-dev/);
  const beforeExpired = await evaluate('testGithub.writes.length');
  await evaluate(`document.querySelector('#github-issues form').requestSubmit()`);
  assert.equal(await evaluate('testGithub.writes.length'), beforeExpired);
  await search('storefront');
  assert.equal(await evaluate(`document.querySelectorAll('#github-repo-list [role=option]').length`), 1);
  assert.match(await evaluate(`document.querySelector('#github-repo-list [role=option]').textContent`), /@work-dev/);
  await key('Escape');
  await evaluate(`testGithub.removed=true;testGithub.events.emit({data:JSON.stringify({type:'github.updated'})})`);
  await until('removed account', () => evaluate(`document.querySelectorAll('#github-chips .account-chip').length===1`));
  assert.equal(await value(title), 'Keep through sign-in expiry');
  await evaluate(`testGithub.removed=false;testGithub.unavailable=false;testGithub.events.emit({data:JSON.stringify({type:'github.updated'})})`);
  await until('sign-in renewed', () => evaluate(`!document.querySelector(${JSON.stringify(submit)}).disabled`));
  await cancel();
  pass('expired or removed accounts cannot write or erase a draft; other accounts remain searchable');

  await search('bulk-');
  assert.equal(await evaluate(`document.querySelectorAll('#github-repo-list [role=option]').length`), 200);
  assert.match(await evaluate(`document.querySelector('#github-repo-list').textContent`), /Showing 200 matches/);
  await key('ArrowUp');
  assert.equal(await evaluate(`document.querySelector('#github-repo').getAttribute('aria-activedescendant')`), 'github-repo-option-199');
  await key('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('#github-repo').getAttribute('aria-activedescendant')`), 'github-repo-option-0');
  await key('ArrowUp');
  await key('Enter');
  assert.equal(await value('#github-repo'), 'acme/bulk-199');
  await search('bulk-200');
  assert.equal(await evaluate(`document.querySelectorAll('#github-repo-list [role=option]').length`), 1);
  await key('ArrowUp');
  await key('Enter');
  assert.equal(await value('#github-repo'), 'acme/bulk-200');
  await search('no-such-repo');
  await key('ArrowDown');
  await key('Enter');
  assert.equal(await evaluate(`document.querySelector('#github-repo').hasAttribute('aria-activedescendant')`), false);
  await key('Escape');
  assert.equal(await value('#github-repo'), 'acme/bulk-200');
  await evaluate('testGithub.bulk=200');
  await click('#github-repo-reload');
  await until('repos reloaded', () => evaluate(`!document.querySelector('#github-repo-reload').disabled`));
  await search('bulk-');
  assert.doesNotMatch(await evaluate(`document.querySelector('#github-repo-list').textContent`), /Showing 200 matches/);
  await key('ArrowUp');
  await key('Enter');
  assert.equal(await value('#github-repo'), 'acme/bulk-199');
  pass('zero, one, 200 and 201 matches keep arrows, Enter and accessibility within rendered options');

  // iOS Safari moves focus after a tap's pointerup and before its click, and the blur closes the list.
  await search('bulk-01');
  const tapped = await evaluate(`document.querySelectorAll('#github-repo-list .github-option-name')[1].textContent`);
  await evaluate(`{const o=document.querySelectorAll('#github-repo-list [role=option]')[1];for(const type of ['pointerdown','pointerup'])o.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'touch'}));document.querySelector('#github-repo').blur();}`);
  assert.equal(await value('#github-repo'), tapped);
  pass('a tap picks a repository even when focus leaves before its click');

  await choose('storefront work-dev');
  await issueList();
  await newIssue('Account context at every dock size');
  await evaluate('document.querySelector("#dock-splitter").focus()');
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
  for (const [width, height] of [[1440,900],[820,1180],[390,844]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
    await layoutReady();
    assert.equal(await visible('#github-issues form .github-small'), true);
    assert.equal(await visible('#github-accounts'), false);
    assert.deepEqual(await evaluate(`[document.querySelector('#dock'),document.querySelector('#github-issues')].map(e=>e.scrollWidth-e.clientWidth)`), [0,0]);
  }
  assert.deepEqual(errors, []);
  pass('account context and editor controls fit desktop, tablet and phone widths without browser exceptions');
});
console.log(`${checks} GitHub checks passed.`);
