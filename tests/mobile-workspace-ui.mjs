import {chromium,webkit} from 'playwright';
import {resolve,sep} from 'node:path';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=resolve('dist-portal');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const pathname=new URL(request.url).pathname;
 const path=resolve(root,'.'+(pathname==='/'?'/portal.html':pathname==='/remote/'?'/remote/index.html':pathname));
 if(!path.startsWith(root+sep))return new Response('',{status:404});
 const file=Bun.file(path);return await file.exists()?new Response(file):new Response('',{status:404});
}});
const output='/tmp/agentstoz-mobile-workspace-ui';await mkdir(output,{recursive:true});
try{
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch();
  try{
   const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light',hasTouch:true});
   await context.route('https://**',route=>route.abort());
   const page=await context.newPage();let navigations=0;const errors=[];
   page.on('request',request=>{if(request.isNavigationRequest()&&request.resourceType()==='document')navigations++});page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${server.port}/remote/`);
   await page.getByRole('navigation',{name:'작업 메뉴'}).waitFor();
   await page.screenshot({path:`${output}/${name}-home-light.png`,fullPage:true});
   for(let i=0;i<20;i++)await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:['프로젝트','원격 작업','북마크','기록','홈'][i%5],exact:true}).click();
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'북마크',exact:true}).click();
   assert.equal(await page.locator('.remote-portal-scan').count(),0,'bookmarks have no QR action');
   assert.equal(await page.locator('.remote-state').count(),0,'bookmarks have no host connection state');
   assert.equal(await page.locator('.remote-host-tabs').count(),0,'bookmarks have no work host picker');
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'프로젝트',exact:true}).click();
   assert.equal(await page.locator('.remote-header h1').textContent(),'프로젝트 현황');
   assert.equal(await page.locator('.remote-portal-scan').count(),0,'inventory needs no QR');
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'원격 작업',exact:true}).click();
   assert.equal(await page.locator('.remote-portal-scan').count(),1);
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'홈',exact:true}).click();
   assert.equal(navigations,1,'tab switching must not navigate the document');
   assert.equal(await page.locator('.workspace-navigation').count(),1,'one shell navigation');
   const theme=page.locator('.workspace-theme');
   const trigger=theme.locator('summary');
   const isOpen=()=>theme.evaluate(element=>element.open);
   await trigger.tap();assert.equal(await isOpen(),true);
   await page.locator('.remote-heading').tap();assert.equal(await isOpen(),false,'outside touch dismisses');
   await trigger.click();await page.keyboard.press('Escape');
   assert.equal(await isOpen(),false,'Escape dismisses');
   assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,'Escape restores trigger focus');
   await trigger.click();
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'북마크',exact:true}).tap();
   assert.equal(await isOpen(),false,'outside control dismisses');
   assert.equal(await page.locator('.remote-shell').getAttribute('data-workspace-tab'),'bookmarks','first outside tap still activates the target');
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'홈',exact:true}).click();
   await trigger.click();await page.getByRole('button',{name:'밝게',exact:true}).focus();
   await page.getByRole('button',{name:'어둡게',exact:true}).focus();
   assert.equal(await isOpen(),true,'focus movement inside keeps the menu open');
   await page.getByRole('navigation',{name:'작업 메뉴'}).getByRole('button',{name:'홈',exact:true}).focus();
   assert.equal(await isOpen(),false,'focus leaving dismisses');
   await page.locator('.workspace-theme summary').click();await page.getByRole('button',{name:'어둡게',exact:true}).click();
   assert.equal(await isOpen(),false,'choosing a theme dismisses');
   await page.waitForFunction(()=>document.documentElement.dataset.appTheme==='dark');
   await page.screenshot({path:`${output}/${name}-home-dark.png`,fullPage:true});
   await trigger.click();await page.getByRole('button',{name:'기기 설정 따름',exact:true}).click();await page.emulateMedia({colorScheme:'light'});
   await page.waitForFunction(()=>document.documentElement.dataset.appTheme==='gray');
   await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.appTheme==='dark');
   const overflowing=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflowing,false,'no horizontal overflow on phone');
   await page.goto(`http://127.0.0.1:${server.port}/?tab=memories`);
   await page.waitForSelector('[data-workspace-tab="records"]');
   assert.equal(await page.getByRole('button',{name:'장기기억',exact:true}).getAttribute('aria-pressed'),'true');
   assert.deepEqual(errors,[]);
   console.log(`${name}: tabs 20 / one document / theme system+dark+light / legacy route / mobile width PASS`);
   await context.close();
  }finally{await browser.close()}
 }
}finally{server.stop(true)}
