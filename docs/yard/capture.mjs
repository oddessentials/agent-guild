import fs from 'node:fs/promises';
import { startFixture } from './fixture.mjs';
import { openBrowser, pause } from './browser.mjs';
const fixture=await startFixture();const browser=await openBrowser();
try{
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('agentGuild.view','yard');localStorage.setItem('agentGuild.theme','dark');"});
 await browser.send('Page.navigate',{url:fixture.api.url+'/#token='+fixture.token});
 await browser.wait("document.getElementById('yard-stage')?.dataset.ready==='true'");
 await pause(1500);
 await browser.shot('.cache/yard-guild.png');
 await browser.click('.yard-row[data-key="provider:anthropic"]');
 await pause(300);
 await browser.shot('.cache/yard-inspector.png');
 if(process.argv.includes('--all')) {
  for(const skin of ['guild','orbital','grove','professional'])for(const theme of ['dark','light']) {
   await browser.evaluate(`document.documentElement.dataset.skin=${JSON.stringify(skin)};document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
   await browser.wait(`document.querySelector('#yard-stage').dataset.world===${JSON.stringify(skin)}`);
   await pause(700);
   await browser.shot('.cache/yard-'+skin+'-'+theme+'.png');
  }
  await browser.evaluate("document.documentElement.dataset.skin='guild';document.documentElement.dataset.theme='dark'");
  await browser.wait("document.querySelector('#yard-stage').dataset.world==='guild'");
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(300);await browser.shot('.cache/yard-mobile.png');
 }
 if(process.argv.includes('--all')||process.argv.includes('--wide')) {
  // Ultrawide stages at the default, closest and widest zoom.
  for(const [width,height] of [[2560,1080],[5120,1440]]) {
   await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   await browser.evaluate("document.documentElement.dataset.skin='guild'");
   await browser.wait("document.querySelector('#yard-stage').dataset.world==='guild'");
   await browser.click('#yard-fit');await pause(1200);
   await browser.shot(`.cache/yard-guild-${width}x${height}.png`);
   for(const [name,button] of [['min','#yard-zoom-out'],['max','#yard-zoom-in']]) {
    for(let i=0;i<14;i++)await browser.click(button);
    await pause(900);await browser.shot(`.cache/yard-guild-${width}x${height}-${name}.png`);
   }
  }
 }
 console.log(JSON.stringify({errors:browser.errors,failed:await browser.evaluate("document.getElementById('yard-failure').hidden===false"),labels:await browser.evaluate("document.querySelectorAll('.yard-label').length")}));
}finally{await browser.close();await fixture.close();}
