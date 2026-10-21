/** Real journal UI and host on disposable roots. No app data, AI, or production API. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TesterAgentHost} from '../src/testerAgentHost';
import {acquireOwnedFileLock} from '../src/portalFileLock';
const temp=mkdtempSync(join(tmpdir(),'improvement-screen-'));
for(const id of ['a','b'])mkdirSync(join(temp,id));
const host=new TesterAgentHost({directory:join(temp,'host'),runner:'unused',python:()=>null,resolve:async req=>({root:join(temp,req.portId==='a'?'a':'b'),label:'격리 검증',targets:[]}),lease:async root=>{const release=await acquireOwnedFileLock(join(root,'lease'));return {release};}});
const built=await Bun.build({entrypoints:[join(import.meta.dir,'fixtures/tester-improvements.tsx')],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
assert.ok(built.success,JSON.stringify(built.logs));const js=await built.outputs.find(o=>o.path.endsWith('.js')).text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/app.js')return new Response(js,{headers:{'content-type':'text/javascript'}});
 if(url.pathname==='/tester'&&request.method==='POST'&&request.headers.get('origin')===url.origin){try{return Response.json(await host.perform(await request.json()));}catch(e){return Response.json({error:e.message},{status:400});}}
 return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px sans-serif;--line:#777;--text-primary:#111;--bg-input:white}button,select,input,textarea{max-width:100%}summary{min-height:44px;cursor:pointer}</style><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'content-type':'text/html'}});
}});
const origin=`http://127.0.0.1:${server.port}`;
try{
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();try{
   const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
   await context.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
   await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
   assert.equal(await page.evaluate(()=>improvementFixture.requests.length),0,'Viewing a closed panel calls no API');
   await page.getByTestId('tester-improvement-journal').locator('>summary').click();
   console.log(name+': opened');const situation=`${name} 첫 업무 무응답 관측`;
   await page.getByLabel('확인한 상황',{exact:true}).fill(situation);await page.getByLabel('기대했던 동작',{exact:true}).fill('버튼을 누르면 작성기가 보인다');await page.getByLabel('확인한 버전',{exact:true}).fill('isolated-source');await page.getByLabel('핵심 내용',{exact:true}).fill('첫 조회 중 버튼을 눌렀다');
   await page.evaluate(()=>{improvementFixture.loseAck=true;});await page.getByRole('button',{name:'관측 기록 저장',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'저장 응답'}).waitFor();assert.equal(await page.getByLabel('핵심 내용',{exact:true}).inputValue(),'첫 조회 중 버튼을 눌렀다');
   await page.getByRole('button',{name:'관측 기록 저장',exact:true}).click();await page.getByRole('status').filter({hasText:'저장했습니다'}).waitFor();
   console.log(name+': retry saved');const calls=await page.evaluate(()=>improvementFixture.requests.filter(r=>r.operation==='improvement-record'));assert.equal(calls.length,2);assert.equal(calls[0].improvement.requestId,calls[1].improvement.requestId,'Lost ACK retries same ID');
   const row=page.getByTestId('tester-improvement-item').filter({hasText:situation});await row.locator('>summary').click();assert.match(await row.innerText(),/관측 1 · 개선 0 · 재확인 0/);
   await row.getByRole('button',{name:'이어서 기록',exact:true}).click();await page.getByLabel('핵심 내용',{exact:true}).fill('작성기 전환과 안전한 UUID 생성을 적용했다');await page.evaluate(()=>{improvementFixture.loseAck=true;});await page.getByRole('button',{name:'관측 기록 저장',exact:true}).click();await page.getByRole('alert').waitFor();
   await page.getByRole('button',{name:'기록 새로 고침',exact:true}).click();await page.waitForFunction(()=>document.querySelector('fieldset')?.disabled===false);
   await page.getByRole('button',{name:'관측 기록 저장',exact:true}).click();await page.getByRole('status').filter({hasText:'저장했습니다'}).waitFor();
   const continued=await page.evaluate(()=>improvementFixture.requests.filter(r=>r.operation==='improvement-record').slice(-2));assert.equal(continued[0].improvement.requestId,continued[1].improvement.requestId);assert.equal(continued[0].improvement.expectedRevision,continued[1].improvement.expectedRevision,'Refresh after lost ACK retains the original revision');
   console.log(name+': changed saved');await page.getByLabel('기록 단계',{exact:true}).selectOption('rechecked');await page.getByLabel('재확인 관측',{exact:true}).selectOption('clear');await page.getByLabel('핵심 내용',{exact:true}).fill('첫 전송과 기록 재조회를 확인했다');await page.getByRole('button',{name:'관측 기록 저장',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid=tester-improvement-item]')].some(e=>e.textContent.includes('재확인 1')));
   console.log(name+': rechecked saved');await page.reload();await page.getByTestId('tester-improvement-journal').locator('>summary').click();const restored=page.getByTestId('tester-improvement-item').filter({hasText:situation});await restored.locator('>summary').click();assert.match(await restored.innerText(),/관측 1 · 개선 1 · 재확인 1/);
   // Old-project reads cannot contaminate an already-open panel after a project switch.
   await page.evaluate(()=>{improvementFixture.hold=true;});await page.getByRole('button',{name:'기록 새로 고침',exact:true}).click();await page.waitForFunction(()=>improvementFixture.waiting);
   console.log(name+': previous read held');await page.getByRole('button',{name:'프로젝트 바꾸기',exact:true}).click();await page.getByText('아직 개선 기록이 없습니다.',{exact:false}).waitFor();await page.evaluate(()=>improvementFixture.release());
   assert.equal(await page.getByTestId('tester-improvement-item').count(),0);assert.equal(await page.getByLabel('확인한 상황',{exact:true}).inputValue(),'');
   const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,font:parseFloat(getComputedStyle(document.querySelector('input')).fontSize)}));assert.ok(geometry.scrollWidth<=geometry.width&&geometry.font>=16,JSON.stringify(geometry));assert.deepEqual(errors,[]);
   const result=await host.perform({operation:'improvements',portId:'a'});assert.equal(result.improvements.verdict,null);assert.equal(result.improvements.items.find(i=>i.scenario===situation).revision,3);
   await context.close();console.log(`${name}: durable observation/change/recheck, same-ID retry, project switch and phone layout passed`);
  }finally{await browser.close();}
 }
}finally{server.stop(true);await host.shutdown();host.store.close();rmSync(temp,{recursive:true,force:true});}
