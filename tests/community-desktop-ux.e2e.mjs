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
   for(const [width,theme,zoom] of [[940,'gray',1],[1440,'dark',1],[1280,'gray',1.25],[390,'gray',1]]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    try{
     await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
     const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
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
