import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const origin=process.argv[2]||'http://127.0.0.1:19111';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Loopback fixture required');
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin||url.pathname.startsWith('/api/'))return route.abort();
    return route.continue();
  });
  await context.routeWebSocket('**/*',socket=>socket.close());
  const page=await context.newPage();
  await page.goto(origin+'/portal.html');
  for(const [label,tab] of [['프로젝트','projects'],['북마크','bookmarks']]) {
    await page.getByRole('button',{name:label,exact:true}).click();
    await page.locator('.workspace-catalog:not([hidden])').waitFor();
    await page.reload();
    await page.locator('.workspace-catalog:not([hidden])').waitFor();
    assert.equal(await page.locator('main.remote-shell').getAttribute('data-workspace-tab'),tab);
    await page.getByRole('note').waitFor();
  }
  console.log('PASS history-state project/bookmark tabs restore their catalog and build badge after reload');
}finally{await browser.close();}
