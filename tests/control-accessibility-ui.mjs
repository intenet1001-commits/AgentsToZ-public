/** Rendered low-vision controls with local, in-memory APIs only. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';

const built=await Bun.build({entrypoints:['tests/fixtures/control-accessibility/panels.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(output=>output.path.endsWith('.js'));
const css=built.outputs.find(output=>output.path.endsWith('.css'));
assert.ok(js);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
  const path=new URL(request.url).pathname;
  if(path==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
  if(path==='/panel.css')return new Response(css??'',{headers:{'Content-Type':'text/css'}});
  return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
const origin=`http://127.0.0.1:${server.port}`;
try{
  for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
    const browser=await engine.launch();
    try{
      for(const panel of ['dialogue','lan','internet']){
        const page=await browser.newPage({viewport:{width:390,height:844}});
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
        await page.goto(`${origin}/?panel=${panel}`);
        if(panel==='dialogue'){
          const approvals=page.getByTestId('agent-dialogue-pending-item');await approvals.nth(1).waitFor({timeout:5000}).catch(async error=>{console.error('fixture errors',errors,'body',await page.locator('body').innerText());throw error;});
          assert.equal(await page.getByRole('button',{name:/알파 기기 요청.*허용/}).count(),1);
          assert.equal(await page.getByRole('button',{name:/베타 기기 요청.*허용/}).count(),1);
          assert.equal(await page.getByRole('button',{name:/알파 기기 요청.*초대 거절/}).count(),1);
          assert.equal(await page.getByRole('button',{name:/베타 기기 요청.*초대 거절/}).count(),1);
          await page.getByRole('button',{name:/상대 알파.*해지/}).waitFor();
          assert.equal(await page.getByRole('button',{name:/상대 베타.*해지/}).count(),1);
          assert.equal(await page.getByRole('button',{name:'승인 대기 새로고침'}).count(),1);
          assert.equal(await page.getByRole('button',{name:'1:1 연결 새로고침'}).count(),1);
          await page.evaluate(()=>{window.holdEnable=true;});
          await page.getByTestId('agent-dialogue-publish-all').click();
          await page.getByTestId('agent-dialogue-publish-progress').getByText(/공개 1\/2/).waitFor();
          const close=page.getByRole('button',{name:'닫기',exact:true});
          assert.equal(await close.isDisabled(),true,'bulk publish keeps its progress visible');
          await page.locator('[role="dialog"]').click({position:{x:2,y:2}});
          assert.equal(await page.evaluate(()=>window.closeCount),0,'backdrop cannot hide an in-flight bulk publish');
          await page.getByTestId('agent-dialogue-publish-stop').click();
          await page.getByTestId('agent-dialogue-publish-stop').getByText('중지 요청됨 · 현재 항목 완료 대기').waitFor();
          await page.evaluate(()=>window.releaseEnable());
          await page.getByTestId('agent-dialogue-bulk-notice').getByText(/1\/2개 처리 후 중지/).waitFor();
          assert.equal(await page.evaluate(()=>window.requests.filter(request=>request.operation==='enable').length),1,'stop prevents the next target mutation');
          assert.equal(await close.isEnabled(),true);
          await close.click();assert.equal(await page.evaluate(()=>window.closeCount),1);
        }else if(panel==='lan'){
          await page.getByRole('button',{name:'아이폰 알파 · 연결 11111111 해제'}).waitFor();
          assert.equal(await page.getByRole('button',{name:'아이폰 베타 · 연결 22222222 해제'}).count(),1);
          assert.equal(await page.getByRole('button',{name:'연결 해제',exact:true}).count(),0);
        }else{
          await page.getByRole('button',{name:'인터넷 알파 · 연결 11111111 정확히 일치 — 승인'}).waitFor({timeout:5000}).catch(async error=>{console.error('internet fixture errors',errors,'body',(await page.locator('body').innerText()).slice(0,4000));throw error;});
          assert.equal(await page.getByRole('button',{name:'인터넷 베타 · 연결 22222222 정확히 일치 — 승인'}).count(),1);
          assert.equal(await page.getByRole('button',{name:'연결 감마 · 연결 33333333 해제'}).count(),1);
          assert.equal(await page.getByRole('button',{name:'연결 델타 · 연결 44444444 해제'}).count(),1);
          assert.equal(await page.getByRole('button',{name:'연결 해제',exact:true}).count(),0);
          assert.equal(await page.getByRole('button',{name:'전체 워크룸 열기'}).count(),1,'the global navigation action appears once for all approved devices');
          await page.getByRole('button',{name:'전체 워크룸 열기'}).click();
          assert.equal(await page.evaluate(()=>window.openWorkroomCount),1);
          assert.equal(await page.locator('summary[aria-label*="연결 감마"]').count(),1);
          assert.equal(await page.locator('summary[aria-label*="연결 델타"]').count(),1);
        }
        assert.deepEqual(errors,[],`${engineName} ${panel} page errors`);
        await page.close();
        console.log(`${engineName} ${panel} accessible controls PASS`);
      }
    }finally{await browser.close();}
  }
}finally{server.stop(true);}
