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
 console.log(JSON.stringify({errors:browser.errors,failed:await browser.evaluate("document.getElementById('yard-failure').hidden===false"),labels:await browser.evaluate("document.querySelectorAll('.yard-label').length")}));
}finally{await browser.close();await fixture.close();}
