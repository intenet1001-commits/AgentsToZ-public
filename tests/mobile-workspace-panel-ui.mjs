import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
const built=await Bun.build({entrypoints:['tests/fixtures/mobile-workspace/panel.tsx'],target:'browser',format:'esm',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw new Error(built.logs.join('\n'));
const js=await built.outputs[0].text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):new Response('<div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}})});
try{for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}`);await page.getByLabel('발언 프로젝트').selectOption('project_1234');await page.getByRole('button',{name:'검색·새로고침'}).click();
  assert.equal(await page.getByRole('button',{name:'이 말로 작업하기'}).isDisabled(),true);
  await page.getByRole('button',{name:'전체 발언 읽기'}).click();
  while(await page.getByRole('button',{name:'계속 읽기'}).count())await page.getByRole('button',{name:'계속 읽기'}).click();
  await page.getByRole('button',{name:'이 말로 작업하기'}).click();
  assert.equal(await page.evaluate(()=>window.draft),'이전에 요청했던 프로젝트 작업 내용입니다. '.repeat(100));
  await page.getByLabel('관리 프로젝트').selectOption('project_1234');await page.getByRole('button',{name:'지금 세션 기억하기'}).click();
  await page.getByText('로컬 저장 완료 · 백업 대기',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.workspace.action==='memory.save').length),1);
  await page.getByRole('button',{name:'대직 현황',exact:true}).click();await page.getByRole('button',{name:'켜기',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.workspace.action==='duty.enable').length),0);
  await page.getByRole('button',{name:'확인하고 켜기',exact:true}).click();
  const enable=await page.evaluate(()=>window.requests.find(r=>r.workspace.action==='duty.enable'));
  assert.equal(enable.workspace.revision,4);assert.equal(enable.workspace.knowledgeRevision,7);assert.equal(enable.workspace.consent,true);assert.deepEqual(errors,[]);
  console.log(`${name}: full record paging / draft only / one memory save / backup distinction / reviewed duty enable PASS`);
 }finally{await browser.close()}
}}finally{server.stop(true)}
