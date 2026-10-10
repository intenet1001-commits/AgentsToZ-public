import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
const built=await Bun.build({entrypoints:['tests/fixtures/tester-mobile-ui.tsx'],target:'browser',format:'esm',minify:false,define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=await built.outputs[0].text(),css=await Bun.file('src/remote-control-portal.css').text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/fixture.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main id="root"></main><section id="lan" class="mobile-workspace-panel"></section><script type="module" src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}})});
try{for(const [name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();try{
 const page=await browser.newPage({viewport:{width:393,height:852},hasTouch:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);
 const panel=page.getByTestId('mobile-tester'),overview=page.getByTestId('tester-overview'),lan=page.locator('#lan');
 await page.getByLabel('관리 프로젝트').selectOption('project_1234');await panel.getByText('조회만 허용됐습니다.',{exact:false}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'테스트 실행',exact:true}).isDisabled(),true);
 await page.evaluate(()=>{window.fixture.canRun=true;window.fixture.fail=true;});
 await panel.getByRole('button',{name:'테스트 상태 새로고침'}).tap();
 await panel.getByRole('button',{name:'테스트 실행',exact:true}).tap();await panel.getByRole('button',{name:'같은 검사 요청 확인'}).waitFor();
 await page.evaluate(()=>window.fixture.setOnline(false));await panel.getByText('Mac에 다시 연결하면',{exact:false}).waitFor();
 await page.evaluate(()=>{window.fixture.fail=false;window.fixture.setOnline(true);});
 await panel.getByRole('button',{name:'같은 검사 요청 확인'}).tap();await panel.getByRole('button',{name:'이 검사 취소'}).waitFor();
 const requests=await page.evaluate(()=>window.fixture.requests.filter(r=>r.workspace.action==='tester.start'));
 assert.equal(requests.length,2);assert.equal(requests[0].workspace.testRequestId,requests[1].workspace.testRequestId);
 assert.ok((await panel.getByRole('button',{name:'이 검사 취소'}).boundingBox()).height>=44);
 await panel.getByRole('button',{name:'이 검사 취소'}).tap();await panel.getByText('검사 중단',{exact:true}).waitFor();
 await page.evaluate(()=>{window.fixture.run=null;window.fixture.hold=true;});await panel.getByRole('button',{name:'테스트 상태 새로고침'}).tap();
 await page.evaluate(()=>{window.fixture.hold=false;window.fixture.setOwner('phone-b');});await page.waitForFunction(()=>document.querySelector('[aria-label="관리 프로젝트"]').value==='');await page.getByLabel('관리 프로젝트').selectOption('project_5678');
 await page.evaluate(()=>window.fixture.held.splice(0).forEach(f=>f()));await panel.getByRole('button',{name:'테스트 실행',exact:true}).waitFor();
 assert.equal(await panel.getByText('20260914T060000Z-deadbeef',{exact:false}).count(),0);
 await overview.getByRole('button',{name:'다음 프로젝트',exact:true}).tap();await overview.getByText('다음 프로젝트 결과',{exact:true}).waitFor();
 await overview.getByRole('button',{name:'프로젝트 테스터 열기'}).tap();assert.equal(await page.evaluate(()=>window.fixture.opened),'p21');
 assert.deepEqual(await page.evaluate(()=>window.fixture.overview),[{}, {offset:20,revision:'a'.repeat(64)}]);
 // LAN HTTP does not expose randomUUID; the serialized adapter must still work.
 await page.evaluate(()=>{Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});window.fixture.run=null;});
 await lan.getByLabel('테스터 프로젝트').selectOption('project_1234');await lan.getByRole('button',{name:'테스트 실행',exact:true}).tap();await lan.getByRole('button',{name:'이 검사 취소'}).waitFor();
 await lan.getByRole('button',{name:'이 검사 취소'}).tap();await lan.getByText('검사 중단',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log(name+': touch / permissions / same request reconnect / cancel / connection isolation / Control paging / serialized LAN HTTP PASS');
 }finally{await browser.close()}
}}finally{server.stop(true)}
