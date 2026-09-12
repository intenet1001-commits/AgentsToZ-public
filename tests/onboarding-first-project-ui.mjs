import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-first-project/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
assert.equal(build.success,true,build.logs.join('\n'));const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>new URL(req.url).pathname==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/panel.js"></script>`,{headers:{'Content-Type':'text/html'}})});
let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/api/onboarding/status')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture offline"}'});
  if(url.pathname.startsWith('/api/')||url.hostname!=='127.0.0.1'){
   if(req.method()!=='GET')writes.push(url.pathname);
   return route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture blocked"}'});
  }
  return route.continue();
 });
 const open=()=>page.goto(`http://127.0.0.1:${server.port}`);
 await open();await page.getByRole('button',{name:'새 프로젝트 만들기',exact:true}).waitFor();
 for(const theme of ['gray','dark']){
  await page.evaluate(t=>document.documentElement.dataset.appTheme=t,theme);
  if(css){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/onboarding-first-project-${theme}.png`,fullPage:true});}
 }
	 assert.deepEqual(writes,[]);
	 await page.getByRole('button',{name:'내 Control 자동 만들기',exact:true}).click();await page.getByRole('status').filter({hasText:'control:create'}).waitFor();
	 await open();await page.getByRole('button',{name:'다른 Mac의 Control 복원',exact:true}).click();await page.getByRole('status').filter({hasText:'control:restore'}).waitFor();
	 await open();
	 await page.getByRole('button',{name:'새 프로젝트 만들기',exact:true}).click();await page.getByRole('status').filter({hasText:'project:new'}).waitFor();
 await open();await page.getByRole('button',{name:'가지고 있는 폴더 열기',exact:true}).click();await page.getByRole('status').filter({hasText:'project:existing'}).waitFor();
 await open();await page.getByRole('button',{name:'등록한 프로젝트 이어서 열기',exact:true}).click();await page.getByRole('status').filter({hasText:'projects'}).waitFor();
 await open();await page.getByRole('button',{name:'AI 연결 준비하기',exact:true}).click();await page.getByRole('heading',{name:'필요한 도구부터, 하나씩'}).waitFor();
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
	 console.log('PASS: real SetupWizard offline → Control create/restore and project callbacks; AI preparation; no cloud write before user action');
}finally{await browser?.close();server.stop(true);}
