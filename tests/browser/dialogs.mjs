// Shared dialog layout in Chrome and, when PLAYWRIGHT_MODULE is set, WebKit.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { until, withPage } from './chrome.mjs';

const instrumentation = `<script>
const demoFetch=window.fetch;
window.fetch=(input,init)=>{
  if(new URL(typeof input==='string'?input:input.url,location.href).pathname.endsWith('/history'))
    return Promise.resolve(new Response(JSON.stringify({history:{total:334,sessions:Array.from({length:200},(_,i)=>({
      id:'saved-'+i,title:'Saved session '+i,cwd:'/work/storefront',updatedAt:'2026-10-04T10:00:00Z'
    }))}}),{headers:{'Content-Type':'application/json'}}));
  return demoFetch(input,init);
};
window.testInputs=[];
const DemoSocket=window.WebSocket;
window.WebSocket=class extends DemoSocket {
  send(raw){const m=JSON.parse(raw);if(m.type==='input')testInputs.push(m.data);super.send(raw);}
};
</script>`;

const checks = await withPage({ name: 'dialogs', instrumentation }, async ({ origin, send, evaluate, layoutReady, pass, errors }) => {
  const checkDialogs = async (evaluate, resize, settle, engine) => {
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
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await resize(width, height);
      await evaluate('document.querySelector(".provider[data-id=anthropic] .existing").click()');
      await until(`${engine} history rows`, () => evaluate('document.querySelectorAll("#history-list .history-row").length===200'));
      await settled();
      let g = await geometry('#history');
      assert.ok(g.body > 120 && g.scrollable && g.inside && g.footer, `${engine} ${width}: ${JSON.stringify(g)}`);
      const fullHeight = g.height;
      assert.ok(await evaluate('(()=>{const b=document.querySelector("#history .models-body");b.scrollTop=b.scrollHeight;return b.scrollTop})()') > 0);
      await evaluate('document.querySelector("#history-filter").value="Saved session 199";document.querySelector("#history-filter").dispatchEvent(new Event("input"))');
      await settled();
      assert.equal(await evaluate('document.querySelectorAll("#history-list .history-row").length'), 1);
      g = await geometry('#history');
      assert.ok(g.body > 30 && g.inside && g.footer, `${engine} filtered: ${JSON.stringify(g)}`);
      if (width > 640) assert.ok(g.height < fullHeight, 'a short list still sizes to its content');
      await evaluate('document.querySelector("#history-filter").value="no matching session";document.querySelector("#history-filter").dispatchEvent(new Event("input"))');
      await settled();
      assert.equal(await evaluate('document.querySelector("#history-note").checkVisibility()'), true);
      assert.ok((await geometry('#history')).body > 20, 'the empty state remains visible');
      await evaluate('document.querySelector("#history-close").click()');
    }
    pass(`${engine}: 200 history rows scroll, and filtered/empty history remains usable on desktop, tablet and phone`);

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
          await evaluate('document.querySelector("#environment-close").click()');
          await until(`${engine} environment focus restored`, () => evaluate('document.activeElement.matches(".provider[data-id=shell] .environment-open")'));
        }
      }
    }
    await evaluate('document.querySelector(".provider[data-id=shell] .environment-open").click();document.querySelector("#environment-refresh").click()');
    await until(`${engine} environment refresh complete`, () => evaluate('!document.querySelector("#environment-refresh").disabled'));
    assert.equal(await evaluate('document.querySelector("#environment").open'), true);
    // A provider refresh rebuilds cards while the dialog remains open.
    await evaluate('document.querySelector(".provider[data-id=shell] .multiplexer-refresh").click()');
    await settled();
    await evaluate('document.querySelector("#environment-close").click()');
    await until(`${engine} replacement opener`, () => evaluate('document.activeElement.matches(".provider[data-id=shell] .environment-open")'));
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
      await evaluate(`{const d=document.querySelector('${selector}');d.close();d.querySelector('.models-body').innerHTML=window.testDialogContent}`);
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
