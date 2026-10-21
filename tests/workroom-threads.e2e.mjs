// Real React UI + encrypted task store + task service, synthetic terminal. No installed app or external API.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomThreadStore} from '../src/workroomThreadStore.ts';
import {WorkroomThreadService} from '../src/workroomThreadService.ts';
import {normalizeMobileWorkspaceRequest} from '../src/mobileWorkspaceProtocol.ts';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'community-screen-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const shots=process.env.COMMUNITY_SCREEN_SHOTS||'';if(shots)await mkdir(shots,{recursive:true});
const TARGET='thread-screen-project',OTHER='thread-screen-other';
let vite,service,store;const starts=[],writes=[],calls=[],revisions=new Map(),memory=new Map();
const until=async(fn,message)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}assert.fail(message);};
try{
 store=new WorkroomThreadStore(scratch,{read:async()=>Buffer.alloc(32,8),create:async()=>Buffer.alloc(32,8)});
 service=new WorkroomThreadService({store,resolve:async target=>({fingerprint:target}),inspect:id=>({state:'running',inputRevision:revisions.get(id)??0}),
  start:async(id,targetId,agent)=>{const session={id:crypto.randomUUID(),targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};starts.push(session);revisions.set(session.id,0);return {written:true,session};},
  open:async(_id,r)=>{const session={id:crypto.randomUUID(),targetId:r.targetId,agent:r.agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};starts.push(session);revisions.set(session.id,0);return session;},
  reply:async(_id,sessionId,text,revision)=>{assert.equal(revision,revisions.get(sessionId));const written=await service.prepareInput(sessionId,text+'\r',revision+1);writes.push(text);revisions.set(sessionId,revision+1);await written?.();return {written:true};}});
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',
  plugins:[{name:'fixture-only',configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(req.url==='/__thread-api')try{
    let text='';for await(const part of req){text+=part;if(text.length>9000)throw Error('too large');}const r=normalizeMobileWorkspaceRequest(JSON.parse(text));calls.push(r);
    if(r.workspace.action==='workroom.status'||r.workspace.action==='workroom.save'){
     const saving=r.workspace.action==='workroom.save';if(saving)memory.set(r.workspace.sessionId,r.requestId);const receipt=memory.get(r.workspace.sessionId),saved=!!receipt;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({kind:'workspace',action:r.workspace.action,workroom:{sessionId:r.workspace.sessionId,initialized:true,lastSavedAt:saved?new Date().toISOString():null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:receipt??null,state:saved?'saved':'idle',localSaved:saved,backupSaved:false,message:saved?'저장 완료':''}}}));return;
    }
    const result=await service.perform(r.workspace.action,r.workspace.thread,r.targetId,r.requestId,{owner:'screen-user',active:()=>true,readAll:false});
    res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({kind:'workspace',action:r.workspace.action,threads:result}));
   }catch(e){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message}));}
   else if(req.url?.startsWith('/api/')){res.statusCode=503;res.end('Real API blocked');}else next();
  });}}],server:{host:'127.0.0.1',port:0,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]}}});
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const src=await fetch(origin+'/src/CommunityWorkspace.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=src.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
 const html=(prefix,old=false)=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
 import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 import '/src/index.css';import '/src/workspaceDesign.css';const {CommunityWorkspace}=await import('/src/CommunityWorkspace.tsx');
 const old=${JSON.stringify(old)};window.threadReads=0;const transport=async request=>{if(old){window.threadReads++;throw Error('모바일 작업 요청 형식이 올바르지 않습니다.');}const r=await fetch('/__thread-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const body=await r.json();if(!r.ok)throw Error(body.error);if(window.dropNextCreate&&request.workspace.action==='workroom.threads.create'){window.dropNextCreate=false;throw Error('fixture: response lost after host admission');}return body;};
 window.opened=[];window.render=()=>ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(CommunityWorkspace,{channels:[{id:'one',label:'아젠투지 1호',projects:async()=>[{targetId:${JSON.stringify(prefix+TARGET)},label:'모바일 앱'},{targetId:${JSON.stringify(prefix+OTHER)},label:'두번째 프로젝트'}],transport},{id:'two',label:'아젠투지 2호',projects:async()=>[{targetId:'peer-project-'+${JSON.stringify(prefix)},label:'회사 프로젝트'}],transport}],onOpenWorkroom:(channelId,targetId,thread)=>window.opened.push({channelId,targetId,thread})}));window.render();</script>`;
 for(const [engineName,engine] of Object.entries({webkit,chromium})){
  const browser=await engine.launch();try{
   const prefix=engineName+'-',context=await browser.newContext({viewport:{width:402,height:874},hasTouch:true,isMobile:true,serviceWorkers:'block'});
   try{
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/__community')return route.fulfill({contentType:'text/html; charset=utf-8',body:html(prefix,url.searchParams.has('old'))});return route.continue();});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__community');await page.getByLabel('프로젝트에 맡길 업무').waitFor();
    await page.getByLabel('프로젝트에 맡길 업무').fill('\\'.repeat(5900));await page.getByText('기호·줄바꿈이 많아 전송 한도를 넘었습니다.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'업무 맡기기',exact:true}).isEnabled(),false);assert.equal(await page.getByRole('button',{name:'전송 결과 확인',exact:true}).count(),0);
    await page.getByLabel('프로젝트에 맡길 업무').fill('모바일 로그인 문제를 수정해줘');await page.getByRole('button',{name:'업무 맡기기',exact:true}).click();
    await page.getByTestId('community-task-thread').waitFor();await service.idle();await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByRole('button',{name:'연결 워크룸 열기',exact:true}).waitFor();
    let session=starts.find(s=>s.targetId===prefix+TARGET);assert.ok(session);await service.publish(session.id,crypto.randomUUID(),'question','기존 로그인 방식은 유지할까요?');
    await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('기존 로그인 방식은 유지할까요?',{exact:true}).waitFor();
    await page.getByLabel('스레드 답변').fill('기존 방식 유지해');await page.getByRole('button',{name:'답변 보내기',exact:true}).click();await page.getByText('기존 방식 유지해',{exact:true}).waitFor();
    assert.equal(writes.filter(v=>v==='기존 방식 유지해').length,engineName==='webkit'?1:2,'one terminal write per answer');
    await service.questionScreen(session.id,['Trust this folder?','1. Yes','2. No'],1);await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('CLI 승인·선택은 연결 워크룸에서 현재 선택지를 확인하고 답하세요.',{exact:true}).waitFor();assert.equal(await page.getByLabel('스레드 답변').count(),0);
    await service.publish(session.id,crypto.randomUUID(),'progress','승인 화면은 워크룸에서 확인했습니다.');
    const written=await service.prepareInput(session.id,'워크룸에서 직접 답했어요\r',2);await written();revisions.set(session.id,2);await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('워크룸에서 직접 답했어요',{exact:true}).waitFor();
    await page.getByRole('button',{name:'연결 워크룸 열기',exact:true}).click();const opened=await page.evaluate(()=>window.opened);assert.equal(opened.at(-1).thread.sessionId,session.id);assert.equal(opened.at(-1).targetId,prefix+TARGET);
    // Stale answers are an explicit no-write refusal and keep the draft editable.
    await page.getByLabel('스레드 답변').fill('작성 중인 답변');await service.publish(session.id,crypto.randomUUID(),'progress','파일을 확인했습니다');await page.getByRole('button',{name:'답변 보내기',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'갱신'}).waitFor();assert.equal(await page.getByLabel('스레드 답변').inputValue(),'작성 중인 답변');assert.equal(await page.getByLabel('스레드 답변').isEnabled(),true);
    await service.questionScreen(session.id,['Trust this folder?','1. Yes','2. No'],2);await service.ended(session.id);await page.getByRole('button',{name:'새로고침',exact:true}).click();
    await page.getByLabel('스레드 답변').waitFor();await page.getByLabel('스레드 답변').fill('종료된 워크룸에서 이어줘');await page.getByRole('button',{name:'답변 보내기',exact:true}).click();await page.getByText('종료된 워크룸에서 이어줘',{exact:true}).waitFor();
    const previous=session;session=starts.findLast(s=>s.targetId===prefix+TARGET);assert.notEqual(session.id,previous.id);await assert.rejects(()=>service.publish(previous.id,crypto.randomUUID(),'result','이전 실행의 늦은 결과'));
    await service.publish(session.id,crypto.randomUUID(),'result','로그인 경로 수정과 격리 회귀 검사를 완료했습니다.');await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('로그인 경로 수정과 격리 회귀 검사를 완료했습니다.',{exact:true}).waitFor();
    const finalText='네, 수정과 검증을 마쳤습니다. 이 문장은 워크룸의 최종 답변입니다.';
    await service.completed(session.id,{key:'codex:screen-final-'+prefix,resultText:finalText},revisions.get(session.id),()=>true);
    await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText(finalText,{exact:true}).waitFor();assert.equal(await page.getByText(finalText,{exact:true}).count(),1);
    await page.locator('.community-memory-panel>summary').click();await page.getByRole('button',{name:'세션 기억하기',exact:true}).click();await page.getByTestId('community-thread-memory').getByText(/기억 저장 완료/).waitFor();
    if(shots)await page.screenshot({path:join(shots,engineName+'-task-thread.png'),fullPage:true});
    // A second task in the same checkout is rejected before launch, without trapping its draft.
    await page.getByRole('button',{name:'새 업무',exact:true}).click();await page.getByLabel('프로젝트에 맡길 업무').fill('보존할 새 업무 초안');await page.getByRole('button',{name:'# 아젠투지 2호',exact:true}).click();await page.getByLabel('프로젝트에 맡길 업무').waitFor();assert.equal(await page.getByLabel('프로젝트에 맡길 업무').inputValue(),'');
    await page.getByRole('button',{name:'# 아젠투지 1호',exact:true}).click();await page.getByLabel('프로젝트에 맡길 업무').waitFor();assert.equal(await page.getByLabel('프로젝트에 맡길 업무').inputValue(),'보존할 새 업무 초안');
    await page.getByLabel('프로젝트에 맡길 업무').fill('@두번째');await page.getByRole('group',{name:'프로젝트 호출·참고 후보'}).getByRole('button',{name:'@두번째 프로젝트',exact:true}).click();await page.getByLabel('프로젝트에 맡길 업무').waitFor();assert.equal(await page.getByLabel('기준 프로젝트',{exact:true}).inputValue(),prefix+TARGET);assert.equal(await page.locator('[data-project-call]').count(),2);assert.equal(await page.getByLabel('프로젝트에 맡길 업무').inputValue(),'@두번째 프로젝트 ');await page.getByLabel('프로젝트에 맡길 업무').fill('응답이 끊겨도 한 번만 실행');await page.evaluate(()=>{window.dropNextCreate=true;});
    await page.getByRole('button',{name:'업무 맡기기',exact:true}).click();await page.getByRole('button',{name:'전송 결과 확인',exact:true}).waitFor();await until(()=>starts.some(s=>s.targetId===prefix+OTHER),'create was not received');
    await page.getByRole('button',{name:'전송 결과 확인',exact:true}).click();await page.getByTestId('community-task-thread').waitFor();assert.equal(starts.filter(s=>s.targetId===prefix+OTHER).length,1);
    await service.idle();await page.getByRole('button',{name:'새로고침',exact:true}).click();
    const members=starts.filter(s=>[prefix+TARGET,prefix+OTHER].includes(s.targetId)).slice(-2);assert.equal(new Set(members.map(s=>s.targetId)).size,2);
    for(const member of members)await service.publish(member.id,crypto.randomUUID(),'result',member.targetId===prefix+OTHER?'두번째 프로젝트 결과':'첫 프로젝트 결과');
    await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('두번째 프로젝트 결과',{exact:true}).waitFor();await page.getByText('첫 프로젝트 결과',{exact:true}).waitFor();
    for(const member of members)await service.completed(member.id,{key:'codex:group-final-'+member.id,resultText:member.targetId===prefix+OTHER?'두번째 프로젝트 최종 답변':'첫 프로젝트 최종 답변'},revisions.get(member.id),()=>true);
    await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('두번째 프로젝트 최종 답변',{exact:true}).waitFor();await page.getByText('첫 프로젝트 최종 답변',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('연결된 프로젝트 워크룸').getByRole('button').count(),2);
    await page.getByLabel('답변할 프로젝트',{exact:true}).selectOption(prefix+OTHER);await page.getByLabel('스레드 답변').fill('두번째에게만 후속 질문');await page.getByRole('button',{name:'답변 보내기',exact:true}).click();await page.getByText('두번째에게만 후속 질문',{exact:true}).waitFor();
    assert.equal(writes.filter(v=>v==='두번째에게만 후속 질문').length,engineName==='webkit'?1:2);
    assert.equal(await page.locator('.community-thread-tools > div').first().locator('svg.lucide-at-sign').count(),1);
    const storage=await page.evaluate(()=>Object.values(sessionStorage).join(''));assert.ok(!storage.includes('응답이 끊겨도')&&!storage.includes('작성 중인 답변'),'no prompt text in pending-request storage');
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,small:[...document.querySelectorAll('.community-workspace button,.community-workspace select')].filter(e=>e.getClientRects().length).filter(e=>e.getBoundingClientRect().height<43.5).map(e=>e.textContent)}));assert.ok(geometry.width<=402);assert.deepEqual(geometry.small,[]);
    await page.goto(origin+'/__community?old=1');await page.getByRole('alert').filter({hasText:'앱을 업데이트'}).waitFor();const probes=await page.evaluate(()=>window.threadReads);await page.waitForTimeout(8500);assert.equal(await page.evaluate(()=>window.threadReads),probes,'an unsupported host is not polled repeatedly');await page.getByLabel('프로젝트에 맡길 업무').fill('아직 보내면 안 됨');assert.equal(await page.getByRole('button',{name:'업무 맡기기',exact:true}).isEnabled(),false);
    assert.deepEqual(errors,[]);console.log(`${engineName}: channel, task, question, both reply surfaces, stale answer, lost acknowledgement, drafts and phone layout passed`);
   }finally{await context.close();}
  }finally{await browser.close();}
 }
}finally{await service?.idle();await vite?.close();await rm(scratch,{recursive:true,force:true});}
