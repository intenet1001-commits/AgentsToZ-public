import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'community-desktop-ux-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const shots=process.env.COMMUNITY_DESKTOP_SHOTS;if(shots)await mkdir(shots,{recursive:true});
const vite=await createServer({root,envDir:scratch,cacheDir:join(scratch,'vite'),mode:'maintainer-test',logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules'))]}}});
try{
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 for(const [engineName,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();try{
   // A real iPhone keyboard reduces the web view to about 440px. Keep the actual idle OPS dock mounted,
   // including its separate draft, while a task composer owns this short viewport.
   const phone=await browser.newContext({viewport:{width:428,height:440},serviceWorkers:'block'});
   try{
    await phone.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await phone.newPage();await page.goto(`${origin}/tests/fixtures/community-desktop/index.html?portal=1&empty=1`);
    const dock=page.getByTestId('voice-dock');await dock.waitFor();
    const ops=page.getByRole('textbox',{name:'아젠투지에게 입력',exact:true});await ops.fill('보관할 총괄 초안');
    await page.getByRole('button',{name:'새 업무',exact:true}).click();
    const draft=page.getByRole('textbox',{name:'프로젝트에 맡길 업무',exact:true});await draft.fill('실기 키보드 회귀 초안');
    assert.equal(await dock.isVisible(),false,`${engineName}: idle OPS dock must leave the task composer usable with the phone keyboard`);
    const send=page.getByRole('button',{name:'업무 맡기기',exact:true});
    await send.scrollIntoViewIfNeeded();
    assert.equal(await send.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'The task submit button receives the touch');
    await page.getByRole('button',{name:'홈',exact:true}).click();assert.equal(await dock.isVisible(),true);assert.equal(await ops.inputValue(),'보관할 총괄 초안','Hiding the dock preserves its mounted draft');
    await page.getByRole('button',{name:'커뮤니티',exact:true}).click();assert.equal(await draft.inputValue(),'실기 키보드 회귀 초안');assert.equal(await dock.isVisible(),false);
    await dock.evaluate(el=>el.setAttribute('data-active','true'));assert.equal(await dock.isVisible(),true,'An active conversation keeps its controls');
    await dock.evaluate(el=>el.setAttribute('data-active','false'));
    await page.setViewportSize({width:428,height:926}); // Dismiss the simulated keyboard before returning to the list.
    await page.getByRole('button',{name:'업무 목록',exact:true}).click();assert.equal(await dock.isVisible(),true,'Returning to the task list restores the idle dock');
    assert.equal(await page.evaluate(()=>communityFixture.requests.some(r=>r.workspace.action==='workroom.threads.create')),false);
   }finally{await phone.close();}
   for(const [width,theme,zoom] of [[940,'gray',1],[1440,'dark',1],[1280,'gray',1.25],[390,'gray',1]]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    // LAN WKWebView on a physical iPhone has getRandomValues, but no randomUUID.
    await context.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
    try{
     await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
     const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
     if(width<600){
      await page.goto(`${origin}/tests/fixtures/community-desktop/index.html?theme=${theme}&empty=1&holdList=1`);
      await page.getByRole('button',{name:'커뮤니티 · 업무 스레드',exact:true}).click();
      await page.waitForFunction(()=>communityFixture.listWaiting);
      const rail=page.getByRole('navigation',{name:'업무 스레드 목록',exact:true});
      await page.getByRole('button',{name:'새 업무',exact:true}).click();
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('.community-thread-rail')).display==='none');
      assert.equal(await rail.isVisible(),false,'The first 새 업무 opens the phone composer, including with no prior tasks');
      const firstDraft=page.getByRole('textbox',{name:'프로젝트에 맡길 업무',exact:true});
      await firstDraft.fill('처음 작성하는 업무 초안');
      await page.evaluate(()=>communityFixture.releaseList());
      await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='업무 맡기기'&&!b.disabled),null,{timeout:5000});
      await page.getByRole('button',{name:'업무 목록',exact:true}).click();
      assert.equal(await rail.isVisible(),true,'The person can return to the empty task list');
      await page.waitForFunction(()=>{const box=document.querySelector('.community-thread-rail').getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;});
      await page.getByText('아직 업무 스레드가 없습니다.',{exact:true}).waitFor();
      await page.getByRole('button',{name:'새 업무',exact:true}).click();
      assert.equal(await firstDraft.inputValue(),'처음 작성하는 업무 초안','Reopening the composer keeps the first draft');
      assert.equal(await page.evaluate(()=>communityFixture.requests.filter(r=>r.workspace.action==='workroom.threads.create').length),0,'Opening a composer starts no CLI');
      if(shots)await page.screenshot({path:join(shots,`${engineName}-${width}-first-task.png`),fullPage:true});
     }
     await page.goto(`${origin}/tests/fixtures/community-desktop/index.html?theme=${theme}&zoom=${zoom}`);
     await page.getByRole('button',{name:'커뮤니티 · 업무 스레드',exact:true}).click();
     const task=page.locator('.community-thread-list button').filter({hasText:'iPhone 워크룸 연결 흐름 개선'});await task.waitFor();
     await page.evaluate(()=>{communityFixture.holdRead=true;});await task.click();
     await page.waitForFunction(()=>communityFixture.readWaiting);
     assert.equal(await page.getByRole('button',{name:'업무 맡기기',exact:true}).count(),0,'A loading existing thread must never expose new-task submission');
     await page.evaluate(()=>{communityFixture.failRead=true;communityFixture.releaseRead();});
     await page.getByRole('alert').filter({hasText:'스레드를 불러오지 못했습니다'}).waitFor();
     assert.equal(await page.getByRole('button',{name:'업무 맡기기',exact:true}).count(),0,'Read failure must not become a new paid task');
     assert.equal(await page.evaluate(()=>communityFixture.requests.filter(r=>r.workspace.action==='workroom.threads.create').length),0);
     if(process.env.COMMUNITY_UX_CASE==='loading'){console.log(`${engineName} ${width}: loading/failure fenced`);continue;}
     await page.evaluate(()=>{communityFixture.failRead=false;});await page.getByRole('button',{name:'새로고침',exact:true}).click();
     await page.getByRole('textbox',{name:'스레드 답변',exact:true}).waitFor();
     if(width>600){assert.equal(await task.isVisible(),true,'Desktop keeps the thread list beside the conversation');assert.equal(await task.getAttribute('aria-current'),'true');}
     await page.evaluate(()=>communityFixture.completeOther());
     await page.getByRole('button',{name:'새로고침',exact:true}).click();
     const other=page.locator('.community-thread-list button').filter({hasText:'채널별 프로젝트 목록 정리'});
     await page.waitForFunction(()=>document.querySelector('[data-thread-id="desktop-thread-002"] [data-state]')?.getAttribute('data-state')==='completed');
     assert.equal(await other.locator('[data-state]').getAttribute('data-state'),'completed','Refreshing an open conversation updates other visible task states');
     assert.equal(await task.getAttribute('aria-current'),'true','Refreshing other states keeps the current conversation selected');
     if(shots)await page.screenshot({path:join(shots,`${engineName}-${width}-${theme}-thread.png`),fullPage:true});
     const newTask=async()=>{if(width<600)await page.getByRole('button',{name:'업무 목록',exact:true}).click();await page.getByRole('button',{name:'새 업무',exact:true}).click();};
     const response=page.getByRole('textbox',{name:'스레드 답변',exact:true});await response.fill('기존 대화를 이어 열어 주세요.');
     await newTask();
     const draft=page.getByRole('textbox',{name:'프로젝트에 맡길 업무',exact:true});await draft.fill('새 업무에 남겨 둔 초안');
     if(width<600)await page.getByRole('button',{name:'업무 목록',exact:true}).click();
     await task.click();assert.equal(await response.inputValue(),'기존 대화를 이어 열어 주세요.','Switching retains the original thread draft');
     await page.evaluate(()=>{communityFixture.loseReply=true;});await page.getByRole('button',{name:'답변 보내기',exact:true}).click();
     await page.getByRole('button',{name:'전송 결과 확인',exact:true}).waitFor();
     await page.getByRole('button',{name:'# 아젠투지 2호',exact:true}).click();await page.getByRole('button',{name:'# 아젠투지 1호',exact:true}).click();
     await page.getByRole('button',{name:'전송 결과 확인',exact:true}).click();
     await page.waitForFunction(()=>!sessionStorage.getItem('agentstoz:community-pending:local:desktop-project-001'));
     await newTask();assert.equal(await draft.inputValue(),'새 업무에 남겨 둔 초안','A reply receipt must not erase the new-task draft');
     assert.equal(await page.evaluate(()=>communityFixture.requests.filter(r=>r.workspace.action==='workroom.threads.reply').length),1,'Lost answer is never re-sent');
     const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,body:document.querySelector('.community-workspace').getBoundingClientRect().toJSON()}));
     assert.ok(geometry.width<=geometry.viewport+1&&geometry.body.right<=geometry.viewport+1,JSON.stringify(geometry));
     assert.deepEqual(errors,[]);
     if(shots)await page.screenshot({path:join(shots,`${engineName}-${width}-${theme}.png`),fullPage:true});
     await page.getByRole('button',{name:'작업 세션',exact:true}).click();await page.getByTestId('session-directory-row').first().waitFor();
     if(shots)await page.screenshot({path:join(shots,`${engineName}-${width}-${theme}-sessions.png`),fullPage:true});
     console.log(`${engineName} ${width} ${theme} ${zoom*100}%: hierarchy, drafts, pending receipt and viewport passed`);
    }finally{await context.close();}
   }
  }finally{await browser.close();}
 }
}finally{await vite.close();await rm(scratch,{recursive:true,force:true});}
