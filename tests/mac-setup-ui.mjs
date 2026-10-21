/** Real queue + real components; only external installers/processes are replaced. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MacSetupHost} from '../src/macSetupHost.ts';
const root=mkdtempSync(join(tmpdir(),'atz-mac-journey-')),output=join(import.meta.dir,'../output/playwright/mac-setup');mkdirSync(output,{recursive:true});
const build=await Bun.build({entrypoints:['tests/fixtures/mac-setup/panel.tsx'],target:'browser',format:'esm'});assert.equal(build.success,true,build.logs.join('\n'));const js=await build.outputs[0].text();
const cssFile=join(root,'app.css'),cssBuild=Bun.spawn(['./node_modules/.bin/tailwindcss','-i','src/index.css','-o',cssFile],{stdout:'ignore',stderr:'pipe'});assert.equal(await cssBuild.exited,0,await new Response(cssBuild.stderr).text());const css=readFileSync(cssFile,'utf8');
const results=[];let browser;
try{
for(const [engineName,engine]of [['chromium',chromium],['webkit',webkit]])for(const width of [390,1120]){
 const dir=join(root,engineName+'-'+width),states=new Map(),calls=[],errors=[];let hold=false,release;
 const effects={probe:async id=>({id,state:states.get(id)??'missing',message:'격리된 실행 확인'}),install:async(id,signal)=>{calls.push(id);if(hold){await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});}if(id==='vercel'&&hold)throw Error('synthetic installation failure');states.set(id,'installed');},launch:async id=>{states.set(id,'running');}};
 const host=new MacSetupHost(dir,effects,true),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
   const path=new URL(req.url).pathname;
   if(path==='/setup'){const body=await req.json();try{return Response.json({success:true,...(body.operation==='status'?host.status():await host.act(body))});}catch{return Response.json({error:'다시 검사한 뒤 이어가세요.'},{status:409});}}
   if(path==='/app.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
   return new Response(`<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body class="bg-[var(--bg)] text-[var(--ink)]"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,{headers:{'Content-Type':'text/html'}});
 }});
 try{
   browser=await engine.launch();const page=await browser.newPage({viewport:{width,height:950}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.href);
   const panel=page.getByTestId('mac-setup-panel'),start=panel.getByRole('button',{name:'선택한 프로그램 준비 · 이어하기',exact:true});await start.waitFor();assert.equal(calls.length,0);
   await start.click();await panel.getByText('프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.',{exact:true}).waitFor();assert.equal(calls.length,14);assert.equal(new Set(calls).size,14);
   // Reopen/reload: completed installers do not run again, and no account is silently authenticated.
   await page.reload();await start.click();await page.waitForFunction(()=>document.querySelector('[data-testid=mac-setup-panel]')?.textContent.includes('프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.'));assert.equal(calls.length,14);
   const data=page.getByTestId('app-data-connection');assert.equal(await panel.locator('[data-testid=app-data-connection]').count(),0);await data.getByRole('button',{name:'앱 데이터 저장소·기기 동기화 설정',exact:true}).click();await page.getByText('앱 데이터 연결 화면 열림',{exact:true}).waitFor();
   // Interrupted network/installer: the UI keeps one queue, disables another start, survives reload and cancels it.
   states.delete('vercel');hold=true;await start.click();await page.waitForFunction(()=>document.querySelector('[data-testid=mac-setup-panel]')?.textContent.includes('공식 설치 진행 중'));assert.equal(await start.isDisabled(),true);await page.reload();await panel.getByRole('button',{name:'중지 요청',exact:true}).click();release?.();await panel.getByText(/중지했습니다\. 설치된 것은 보존합니다/).waitFor();
   // Retry only the remaining executable; already installed applications keep their running state.
   hold=false;await panel.getByRole('button',{name:'설치·실행 다시 검사',exact:true}).click();await start.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-testid=mac-setup-panel] button:nth-of-type(2)')?.disabled);await start.click();await panel.getByText('프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.',{exact:true}).waitFor();assert.equal(calls.filter(x=>x==='vercel').length,3);assert.equal(calls.filter(x=>x==='codex-app').length,1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);await page.screenshot({path:join(output,engineName+'-'+width+'.png'),fullPage:true});results.push({engine:engineName,width,passed:true,journeys:['fresh-mac-no-ai','partial-preserves-tools','installed-versus-running','reload-no-replay','cancel-in-flight','retry-remaining-only','separate-app-data']});
   console.log(engineName+'-'+width+': Mac preparation journeys passed');
 }finally{await browser?.close();browser=null;server.stop(true);}
}
}finally{await browser?.close();writeFileSync(join(output,'results.json'),JSON.stringify({source:'real-queue-real-ui-synthetic-installers',results},null,2));rmSync(root,{recursive:true,force:true});}
