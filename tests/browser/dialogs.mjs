// Shared dialog layout in Chrome and, when PLAYWRIGHT_MODULE is set, WebKit.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { until, withDialogClose, withPage } from './chrome.mjs';

const instrumentation = `<script>
const demoFetch=window.fetch;
window.memoryGate=null;
window.openedFolders=[];
window.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.pathname.endsWith('/open-folder')){
    openedFolders.push(JSON.parse(init.body).cwd);
    return Promise.resolve(new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}}));
  }
  if(url.pathname.endsWith('/memory/file')&&url.searchParams.get('path')==='topics/checkout.md'&&window.memoryGate)
    return window.memoryGate.then(()=>demoFetch(input,init)).then(res=>{
      const read=res.json.bind(res);
      res.json=()=>read().then(data=>{window.memoryStaleDelivered=true;return data;});
      return res;
    });
  if(url.pathname.endsWith('/history')&&!url.pathname.includes('/google/'))
    return Promise.resolve(new Response(JSON.stringify({history:{total:334,sessions:Array.from({length:200},(_,i)=>({
      id:'saved-'+i,title:'Saved session '+i,cwd:'/work/storefront',updatedAt:'2026-10-04T10:00:00Z'
    }))}}),{headers:{'Content-Type':'application/json'}}));
  return demoFetch(input,init);
};
window.testInputs=[];
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket {
  send(raw){const m=JSON.parse(raw);if(m.type==='input')testInputs.push(m.data);super.send(raw);}
  // The demo manager has no file manager; this one offers Finder so Open folder shows.
  emit(event){
    const m=typeof event.data==='string'&&JSON.parse(event.data);
    if(m&&m.type==='hello')event={data:JSON.stringify({...m,folderOpener:{available:true,label:'Finder',reason:null}})};
    super.emit(event);
  }
};
</script>`;

const checks = await withPage({ name: 'dialogs', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const checkDialogs = async (evaluate, resize, settle, engine) => {
    const closeDialog = (selector, button) => withDialogClose(evaluate, selector, () => evaluate(
      button ? `document.querySelector(${JSON.stringify(button)}).click()` : `document.querySelector(${JSON.stringify(selector)}).close()`));
    // Frames and animations settle geometry only, never close or refresh completion.
    const settled = async () => {
      await settle();
      await evaluate('Promise.allSettled([...document.querySelectorAll("dialog[open]")].flatMap(d=>d.getAnimations({subtree:true})).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished))');
      await settle();
    };
    await until(`${engine} provider cards`, () => evaluate('Boolean(document.querySelector(".provider[data-id=anthropic] .existing"))'));
    const geometry = (selector) => evaluate(`(()=>{
      const d=document.querySelector(${JSON.stringify(selector)}),b=d.querySelector('.models-body');
      const r=d.getBoundingClientRect(),body=b.getBoundingClientRect(),footer=d.lastElementChild.getBoundingClientRect();
      return {height:r.height,body:body.height,scrollable:b.scrollHeight>b.clientHeight,inside:r.top>=-1&&r.bottom<=innerHeight+1,
        footer:footer.bottom<=r.bottom+1,bodyBottom:body.bottom<=r.bottom+1};
    })()`);
    const loadedHistoryNote = 'Loaded the newest 200 of 334 sessions. Filtering searches these loaded sessions.';
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await resize(width, height);
      await evaluate('document.querySelector(".provider[data-id=anthropic] .existing").click()');
      await until(`${engine} history rows`, () => evaluate('document.querySelectorAll("#history-list .history-row").length===200'));
      assert.equal(await evaluate('document.querySelector("#history-note").textContent'), loadedHistoryNote);
      await settled();
      let g = await geometry('#history');
      assert.ok(g.body > 120 && g.scrollable && g.inside && g.footer, `${engine} ${width}: ${JSON.stringify(g)}`);
      const fullHeight = g.height;
      assert.ok(await evaluate('(()=>{const b=document.querySelector("#history .models-body");b.scrollTop=b.scrollHeight;return b.scrollTop})()') > 0);
      await evaluate('document.querySelector("#history-filter").value="Saved session 199";document.querySelector("#history-filter").dispatchEvent(new Event("input"))');
      await settled();
      assert.equal(await evaluate('document.querySelectorAll("#history-list .history-row").length'), 1);
      assert.equal(await evaluate('document.querySelector("#history-note").textContent'), loadedHistoryNote);
      g = await geometry('#history');
      assert.ok(g.body > 30 && g.inside && g.footer, `${engine} filtered: ${JSON.stringify(g)}`);
      if (width > 640) assert.ok(g.height < fullHeight, 'a short list still sizes to its content');
      await evaluate('document.querySelector("#history-filter").value="Saved session 333";document.querySelector("#history-filter").dispatchEvent(new Event("input"))');
      await settled();
      assert.equal(await evaluate('document.querySelector("#history-note").checkVisibility()'), true);
      assert.equal(await evaluate('document.querySelector("#history-note").textContent'), `No session matches the filter. ${loadedHistoryNote}`);
      assert.ok((await geometry('#history')).body > 20, 'the empty state remains visible');
      await closeDialog('#history', '#history-close');
    }
    pass(`${engine}: 200 history rows scroll, and filtered/empty history remains usable on desktop, tablet and phone`);

    // Static demo data only. Completion is the visible response, never an elapsed delay.
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await resize(width, height);
      await evaluate('document.querySelector("#cwd").value="/work/storefront";document.querySelector(".provider[data-id=google] .memory-link").click()');
      await until(`${engine} Google history`, () => evaluate('document.querySelectorAll("#history-list .history-preview-open").length===1'));
      assert.equal(await evaluate('document.querySelector(".provider[data-id=google] .memory-link").textContent'), 'History');
      await evaluate('document.querySelector("#history-list .history-preview-open").click()');
      await until(`${engine} Google saved reply`, () => evaluate('document.querySelector("#history-messages").textContent.includes("The migration plan is ready")'));
      await settled();
      const g = await evaluate(`(() => {
        const d=document.querySelector('#history'),r=d.getBoundingClientRect(),p=document.querySelector('#history-preview').getBoundingClientRect(),m=document.querySelector('#history-messages').getBoundingClientRect();
        return {inside:r.top>=-1&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1,preview:p.height,messages:m.height,overflow:d.scrollWidth>d.clientWidth};
      })()`);
      assert.ok(g.inside && g.preview > 100 && g.messages > 60 && !g.overflow, `${engine} history preview ${width}: ${JSON.stringify(g)}`);
      assert.equal(await evaluate('document.querySelector("#history-list .history-preview-open").getAttribute("aria-current")'), 'true');
      await closeDialog('#history', '#history-close');
      assert.equal(await evaluate('document.activeElement===document.querySelector(".provider[data-id=google] .memory-link")'), true);
    }
    pass(`${engine}: Google History reads saved messages for the working folder on desktop, tablet and phone`);

    // The first file's reply is held back until a newer file has been chosen and shown. The page
    // handles the released reply in the same microtask run that sets the flag, so once the flag
    // reads true the page has already kept or replaced the text.
    await evaluate('window.memoryGate=new Promise(resolve=>{window.releaseMemory=resolve});window.memoryStaleDelivered=false;document.querySelector(".provider[data-id=anthropic] .memory-link").click()');
    await until(`${engine} memory files`, () => evaluate('document.querySelectorAll("#memory-list .memory-item").length===2'));
    await evaluate('document.querySelectorAll("#memory-list .memory-item")[1].click()');
    await until(`${engine} chosen memory file`, () => evaluate('document.querySelector("#memory-text").textContent.includes("## Commands")'));
    await evaluate('window.releaseMemory();window.memoryGate=null');
    await until(`${engine} earlier memory reply`, () => evaluate('window.memoryStaleDelivered'));
    assert.match(await evaluate('document.querySelector("#memory-text").textContent'), /## Commands/, 'an earlier, slower reply does not replace the chosen file');
    assert.equal(await evaluate('document.querySelector("#memory-list [aria-current=true]").dataset.path'), 'topics/testing.md');
    assert.equal(await evaluate('document.querySelector("#memory-file").textContent+"|"+document.querySelector("#memory-copy").hidden+"|"+document.querySelector("#memory-open").hidden'),
      '/demo/memory/storefront/topics/testing.md|false|false', 'the full path shows with Copy and Open folder');
    await evaluate('document.querySelector("#memory-open").click()');
    await until(`${engine} memory folder opened`, () => evaluate('openedFolders[0]==="/demo/memory/storefront/topics"'));
    await closeDialog('#memory', '#memory-close');
    // A path segment with no break opportunity must wrap inside the heading, never under its buttons.
    await evaluate('document.querySelector("#cwd").value="/Users/someone/Projects/AgentGuildWorkspaces/storefront/packages/checkout/src/payments"');
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await resize(width, height);
      await evaluate('document.querySelector(".provider[data-id=anthropic] .memory-link").click()');
      await until(`${engine} memory text at ${width}`, () => evaluate('document.querySelector("#memory-text").textContent.length>0'));
      await settled();
      const g = await evaluate(`(()=>{
        const d=document.querySelector('#memory'),r=d.getBoundingClientRect(),t=document.querySelector('#memory-text').getBoundingClientRect(),l=document.querySelector('#memory-list').getBoundingClientRect();
        const s=document.querySelector('#memory-sub'),h=document.querySelector('#memory .models-heading').getBoundingClientRect(),b=document.querySelector('#memory-refresh').getBoundingClientRect();
        return {inside:r.top>=-1&&r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1,text:t.height,list:l.height,textBottom:t.bottom<=r.bottom+1,overflow:d.scrollWidth>d.clientWidth,
          heading:s.scrollWidth<=s.clientWidth&&h.right<=b.left};
      })()`);
      assert.ok(g.inside && g.text > 80 && g.list > 60 && g.textBottom && !g.overflow && g.heading, `${engine} memory ${width}: ${JSON.stringify(g)}`);
      await closeDialog('#memory', '#memory-close');
      assert.equal(await evaluate('document.activeElement===document.querySelector(".provider[data-id=anthropic] .memory-link")'), true, `${engine} memory focus restored`);
    }
    await evaluate('document.querySelector("#cwd").value="/work/storefront"');
    // close() queues the dialog's close event, so another card can open it again before that event runs.
    await evaluate('document.querySelector(".provider[data-id=anthropic] .memory-link").click()');
    await until(`${engine} memory before reopening`, () => evaluate('document.querySelectorAll("#memory-list .memory-item").length===2'));
    await evaluate('document.querySelector("#memory-close").click();document.querySelector(".provider[data-id=xai] .memory-link").click()');
    await until(`${engine} memory reopened from another card`, () => evaluate('document.querySelector("#memory-title").textContent==="Grok Build memory"&&document.querySelectorAll("#memory-list .memory-item").length===2'));
    await closeDialog('#memory', '#memory-close');
    pass(`${engine}: memory lists files, keeps the newest choice over a slower reply, reopens from another card, and fits desktop, tablet and phone`);

    await until(`${engine} instruction count on the card`, () => evaluate('document.querySelector(".provider[data-id=google] .instructions-link .link-count")?.textContent==="2"'));
    await evaluate('document.querySelector(".provider[data-id=google] .instructions-link").click()');
    await until(`${engine} instruction files`, () => evaluate('document.querySelectorAll("#memory-list .memory-item").length===3'));
    assert.equal(await evaluate('document.querySelector("#memory-sub").textContent.split(" · ")[0]'), 'Reads 2 files when a session starts');
    assert.equal(await evaluate('document.querySelector(".instructions-skipped").open'), false, 'files that do not load start folded away');
    await evaluate('document.querySelector(".instructions-skipped > summary").click()');
    await evaluate('document.querySelector(".instructions-skipped .memory-item").click()');
    await until(`${engine} skipped instruction file`, () => evaluate('document.querySelector("#memory-text").textContent.includes("Shared notes for every coding tool")'));
    assert.equal(await evaluate('document.querySelector(".instructions-skipped .memory-reason").textContent'), 'Claude Code reads CLAUDE.md instead.');
    assert.equal(await evaluate('document.querySelector("#memory-file").textContent+"|"+document.querySelector("#memory-copy").hidden'), '/work/storefront/AGENTS.md|false');
    await closeDialog('#memory', '#memory-close');
    assert.equal(await evaluate('document.activeElement===document.querySelector(".provider[data-id=google] .instructions-link")'), true);
    pass(`${engine}: Instructions shows its count on the card, folds away files that do not load with the reason, and opens them`);

    await until(`${engine} environment summary`, () => evaluate('document.querySelectorAll(".provider[data-id=shell] .environment-values dd").length===4'));
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await resize(width, height);
      for (const skin of ['guild', 'professional', 'orbital', 'grove', 'gnomeland', 'goblinville']) {
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.skin='${skin}';document.documentElement.dataset.theme='${theme}';document.querySelector('.provider[data-id=shell] .environment-open').click()`);
          await settled();
          const g = await geometry('#environment');
          assert.ok(g.body > 120 && g.inside && g.bodyBottom, `${engine} environment ${skin} ${theme} ${width}: ${JSON.stringify(g)}`);
          assert.equal(await evaluate('document.querySelectorAll("#environment-runtimes .environment-row").length'), 6);
          assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'no horizontal page overflow');
          assert.ok(await evaluate('document.querySelector("#environment").scrollWidth<=document.querySelector("#environment").clientWidth'), 'no horizontal dialog overflow');
          await closeDialog('#environment', '#environment-close');
          assert.equal(await evaluate('document.activeElement===document.querySelector(".provider[data-id=shell] .environment-open")'), true, `${engine} environment focus restored`);
        }
      }
    }
    await evaluate(`new Promise(resolve => {
      document.querySelector('.provider[data-id=shell] .environment-open').click();
      const refresh = document.querySelector('#environment-refresh');
      const observer = new MutationObserver(() => {
        if (!refresh.disabled) { observer.disconnect(); resolve(); }
      });
      observer.observe(refresh, { attributes: true, attributeFilter: ['disabled'] });
      refresh.click();
    })`);
    assert.equal(await evaluate('document.querySelector("#environment").open'), true);
    // Observe the actual card replacement before closing; rendering frames do
    // not indicate that the asynchronous provider refresh has finished.
    await evaluate(`new Promise(resolve => {
      const selector = '.provider[data-id=shell] .environment-open';
      const original = document.querySelector(selector);
      const observer = new MutationObserver(() => {
        const replacement = document.querySelector(selector);
        if (!original.isConnected && replacement?.isConnected && replacement !== original) {
          observer.disconnect();
          window.testEnvironmentReplacement = replacement;
          resolve();
        }
      });
      observer.observe(document.querySelector('#providers'), { childList: true, subtree: true });
      document.querySelector('.provider[data-id=shell] .multiplexer-refresh').click();
    })`);
    assert.equal(await evaluate('document.querySelector("#environment").open'), true);
    await closeDialog('#environment', '#environment-close');
    assert.equal(await evaluate('testEnvironmentReplacement.isConnected && document.activeElement===testEnvironmentReplacement'), true, `${engine} replacement opener receives focus`);
    await evaluate('delete window.testEnvironmentReplacement');
    pass(`${engine}: manager environment, refresh and focus restoration work in all skins and themes at desktop, tablet and phone widths`);

    // The other dialogs use exactly the same sizing rule. Exercise overflow and
    // footer reachability without depending on provider accounts or Tailscale.
    for (const [selector, width, height] of [
      ['#models', 1024, 768], ['#remote-access', 1024, 768],
      ['#folder-browser', 1024, 768], ['#folder-browser', 768, 1024], ['#folder-browser', 390, 844],
    ]) {
      await resize(width, height);
      await evaluate(`{const d=document.querySelector('${selector}');const b=d.querySelector('.models-body');window.testDialogContent=b.innerHTML;b.replaceChildren(...Array.from({length:100},(_,i)=>{const p=document.createElement('p');p.textContent='Dialog item '+i;return p}));d.showModal()}`);
      await settled();
      const g = await geometry(selector);
      assert.ok(g.body > 120 && g.scrollable && g.inside && g.bodyBottom && g.footer, `${engine} ${selector} ${width}: ${JSON.stringify(g)}`);
      // Close handlers need the real controls, not the temporary overflow content.
      await evaluate(`document.querySelector('${selector} .models-body').innerHTML=window.testDialogContent`);
      await closeDialog(selector);
    }
    pass(`${engine}: model, remote-access and folder dialogs retain a visible, scrollable body and footer`);
  };

  await send('Page.navigate', { url: origin });
  await checkDialogs(evaluate, (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }), layoutReady, 'Chrome');
  assert.deepEqual(errors, []);

  if (process.env.PLAYWRIGHT_MODULE) {
    const { webkit } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
    const browser = await webkit.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
      const webkitErrors = [];
      page.on('pageerror', (error) => webkitErrors.push(error.message));
      page.on('dialog', (dialog) => dialog.accept());
      await page.goto(origin);
      const run = (expression) => page.evaluate(expression);
      const settle = () => run('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      await checkDialogs(run, (width, height) => page.setViewportSize({ width, height }), settle, `WebKit ${browser.version()}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await run('document.querySelector("#sessions .session-card .open").click()');
      await until('WebKit touch keys ready', () => run('!document.querySelector("#terminal-controls [data-key=Enter]").disabled'));
      await run('document.querySelector(".xterm-helper-textarea").focus();testInputs.length=0');
      for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter', 'Escape']) await page.tap(`#terminal-controls [data-key=${key}]`);
      assert.deepEqual(await run('testInputs'), ['\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C', '\r', '\x1b']);
      assert.equal(await run('document.activeElement===document.querySelector(".xterm-helper-textarea")'), true);
      await run('document.activeElement.blur();testInputs.length=0');
      await page.tap('#terminal-controls [data-key=ArrowUp]');
      assert.deepEqual(await run('testInputs'), ['\x1b[A']);
      assert.equal(await run('document.activeElement===document.querySelector(".xterm-helper-textarea")'), false);
      assert.deepEqual(webkitErrors, []);
      pass('WebKit trusted touch sends each terminal key once and preserves focused/unfocused input');
    } finally {
      await browser.close();
    }
  }
});
console.log(`${checks} dialog and WebKit checks passed.`);
