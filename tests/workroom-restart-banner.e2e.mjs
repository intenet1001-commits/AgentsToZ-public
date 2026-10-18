/**
 * 「업데이트 전 실행 중이던 작업 세션 N개 이어 열기」 (w14) on the Mac: the session directory of the main window and the
 * pop-out workroom. Real React on an owned Vite server with a synthetic host. No CLI, AI, port 3001 or installed app.
 *
 *   bun tests/workroom-restart-banner.e2e.mjs
 *   RESTART_EVIDENCE_DIR=<dir> keeps the screenshots.
 *
 * Checks: the banner names the update and counts what one press opens; a double click inside 500 ms sends nothing; the
 * confirmation sends review → execute once per openable row, in order, and never for the others; no window opens by
 * itself; 닫기 dismisses once and focus does not bring it back; a pending row offers 「확인했음」 behind a warning; a
 * sidecar that does not know restart.list (400) shows no banner and no error; the pop-out places the banner before
 * the terminal, on the first screen, with or without running sessions.
 * Review (w14): the title counts every session and the button what opens; a row's 「이어 열기」 confirms like the batch;
 * the confirmation takes focus and 「취소」 gives it back to the button that armed it, so Enter, Enter never closes the offer;
 * two rows of one project and AI are told apart by their start time; the saved list says why a row cannot be opened
 * (an older sidecar that refuses `detail` is asked once, then plainly); 닫기 shows what is current afterwards.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {WORKROOM_RESUME_UNSETTLED_REASON} from '../src/workroomConversationProtocol.ts';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-restart-banner-'));
const shots=process.env.RESTART_EVIDENCE_DIR||join(scratch,'evidence');await mkdir(shots,{recursive:true});
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const projects=[['proj-alpha-001','알파 서비스'],['proj-bravo-001','브라보 앱']].map(([targetId,label])=>({targetId,projectTargetId:targetId,label,scope:'main'}));
const at='2026-10-16T01:00:00.000Z',store='local-history-store-001',bootId='00000000-0000-4000-8000-0000000000b1';
const row=(id,targetId,agent,availability,bypass=null,revision=3,createdAt=at)=>({id,targetId,agent,title:'',accountLabel:'현재 CLI 계정',createdAt,updatedAt:at,revision,availability,bypass});
const offer=(rows,update=true)=>({offerId:'restart-offer-0001',revision:1,createdAt:at,update,more:false,rows});
const runningSession={id:'session-running-01',targetId:'proj-alpha-001',agent:'codex',state:'running',createdAt:at,exitCode:null,cols:100,rows:28};
let vite,browser;const results=[];
const until=async(page,predicate,message,timeout=10_000)=>page.waitForFunction(predicate,undefined,{timeout}).catch(async error=>{throw new Error(`${message}: ${error.message}\n${(await page.locator('body').innerText()).slice(0,1200)}`);});
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/api/'))return next();response.statusCode=503;response.end('Unmocked fixture API rejected');});}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/AiTerminalPanel.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(response=>{assert.equal(response.status,200);return response.text();})));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
  const directoryHtml=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui}#root{min-height:100vh}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {WorkroomDeviceSwitch}=await import('/src/WorkroomDeviceSwitch.tsx');const {useWorkroomActivity}=await import('/src/useWorkroomActivity.ts');
function Shell(){useWorkroomActivity();return React.createElement(WorkroomDeviceSwitch,{sessionDirectory:true,visible:true,projects:${JSON.stringify(projects)},deviceName:'아젠투지1호'});}
window.opened=[];window.open=(...args)=>{window.opened.push(args);return null;};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Shell));
</script></html>`;
  browser=await chromium.launch({headless:true});
  /** One isolated context with a synthetic host. `host` holds what this test changes between steps. */
  const open=async(path,host,viewport={width:1200,height:900})=>{
    const context=await browser.newContext({viewport,serviceWorkers:'block'}),errors=[],external=[],history=[],unexpected=[];
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/__restart-fixture')return route.fulfill({contentType:'text/html',body:directoryHtml});
      if(!url.pathname.startsWith('/api/'))return route.continue();
      const body=route.request().postDataJSON()??{};
      if(url.pathname==='/api/agent-runtime/terminals/history'){
        history.push(body);
        const base={protocolVersion:'workroom-history-v1',storeInstanceId:store};
        if(body.operation==='restart.list'){if(host.restartStatus)return route.fulfill({status:host.restartStatus,json:{error:'대화 기록 요청 형식을 확인하세요.'}});return route.fulfill({json:{...base,restart:host.offer}});}
        if(body.operation==='restart.dismiss'){host.offer=host.afterDismiss??null;return route.fulfill({json:{...base,restart:host.offer}});}
        if(body.operation==='resume.review'&&host.unsettled?.includes(body.conversationId))return route.fulfill({json:{...base,review:{id:'review-unsettled-0001',expiresAt:Date.now()+60000,available:false,reason:WORKROOM_RESUME_UNSETTLED_REASON,revision:body.expectedRevision}}});
        if(body.operation==='resume.review'){const r=host.offer?.rows.find(item=>item.id===body.conversationId);return route.fulfill({json:{...base,review:{id:'review-'+body.conversationId.slice(-12),expiresAt:Date.now()+60000,available:!!r&&(r.availability==='ready'||r.availability==='check'),reason:r?.availability==='ready'||r?.availability==='check'?'':'첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다.',revision:body.expectedRevision}}});}
        if(body.operation==='resume.execute'){
          const session={...runningSession,id:'resumed-'+body.conversationId.slice(-10),targetId:host.offer?.rows.find(item=>item.id===body.conversationId)?.targetId??'proj-alpha-001'};
          if(host.offer)host.offer={...host.offer,rows:host.offer.rows.map(item=>item.id===body.conversationId?{...item,availability:'running'}:item)};
          if(host.offer&&!host.offer.rows.some(item=>['ready','check','in-flight','pending'].includes(item.availability)))host.offer=null;
          return route.fulfill({json:{...base,resume:{state:'completed',session}}});
        }
        if(body.operation==='resume.settle'){if(host.offer)host.offer={...host.offer,rows:host.offer.rows.map(item=>item.id===body.conversationId?{...item,availability:'ready',revision:item.revision+1}:item)};return route.fulfill({json:{...base,record:{id:body.conversationId,targetId:'proj-alpha-001',agent:'claude',accountId:'host-default',accountLabel:'현재 CLI 계정',title:'',createdAt:at,updatedAt:at,revision:body.expectedRevision+1,archived:false,state:'detached',sessionId:'old-session-0001',binding:'verified'}}});}
        if(body.operation==='list'){
          if(body.detail&&host.refuseDetail)return route.fulfill({status:400,json:{error:'대화 기록 페이지를 확인하세요.'}});
          return route.fulfill({json:{...base,records:body.archived?[]:host.saved??[],nextBefore:null,...(body.detail&&host.availability?{availability:host.availability}:{})}});
        }
        if(body.operation==='resume.status')return route.fulfill({json:{...base,resume:{state:'unknown'}}});
        unexpected.push('history '+body.operation);return route.fulfill({status:400,json:{error:'unexpected'}});
      }
      if(url.pathname==='/api/ports')return route.fulfill({json:projects.map((project,index)=>({id:project.targetId,name:project.label,folderPath:'/Users/fixture/project-'+index}))});
      if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',complete:true,targets:projects.map(project=>({...project,branch:null,locked:false,worktreeCapable:false}))}});
      if(url.pathname==='/api/agent-dialogue/control')return route.fulfill({json:{success:true,inside:false,deviceId:'local-device-one',devices:[],unread:0,lastMessageAt:null}});
      if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[],workspaceRoots:[]}});
      if(url.pathname==='/api/agent-runtime/terminals/memory')return route.fulfill({json:{jobs:[]}});
      if(url.pathname==='/api/ai-usage/codex')return route.fulfill({json:{rateLimits:null}});
      if(url.pathname==='/api/agent-runtime/terminals'){
        if(body.operation==='activity'){if(body.after)await new Promise(done=>setTimeout(done,600));return route.fulfill({json:{activity:{bootId,cursor:1,reset:!body.after,sessions:[],events:[]}}});}
        if(body.operation==='seen')return route.fulfill({json:{seen:true}});
        if(body.operation==='list')return route.fulfill({json:{sessions:host.sessions}});
        const selected=host.sessions.find(item=>item.id===body.sessionId);
        if(body.operation==='read'&&selected)return route.fulfill({json:{session:selected,chunks:body.after?[]:[{seq:1,text:'Fixture terminal\r\n› '}],nextCursor:1,truncated:false,hasMore:false}});
        if(body.operation==='workspace')return route.fulfill({status:503,json:{error:'Fixture 저장 상태 조회 없음'}});
        if(selected)return route.fulfill({json:{session:selected}});
        if(body.operation==='accounts')return route.fulfill({json:{accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
      }
      // Footer, VOC and voice reads are not under test here.
      return route.fulfill({status:503,json:{error:'Fixture API blocked'}});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+path);
    return {context,page,errors,external,history,unexpected};
  };
  const banner=page=>page.getByTestId('workroom-restart-banner');

  // 1. The directory: title, count, double click guard, one review → execute per openable row, no window.
  {
    const host={offer:offer([row('conversation-ready-0001','proj-alpha-001','claude','ready',true),row('conversation-ready-0002','proj-bravo-001','codex','check'),row('conversation-unsaved-03','proj-alpha-001','codex','unsaved')]),sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-banner"]'),'banner shown');
    // The title counts every session that was running; the button what one press opens (review: it said 2 beside 3 rows).
    assert.equal(await f.page.getByTestId('workroom-restart-title').textContent(),'업데이트 전 실행 중이던 작업 세션 3개');
    assert.equal(await f.page.getByTestId('workroom-restart-open-all').textContent(),'2개 이어 열기');
    assert.match(await banner(f.page).innerText(),/우회 없이 열립니다/);
    const helpKey=await banner(f.page).getAttribute('data-help-key');assert.equal(helpKey,'workroom-restart');
    // The banner sits in this Mac's section, above the live list.
    assert.equal(await banner(f.page).evaluate(element=>!!element.closest('[data-device-key="local"]')),true);
    // A double click: the first arms, the second lands on the confirmation inside 500 ms and is ignored.
    await f.page.getByTestId('workroom-restart-open-all').evaluate(element=>{element.click();queueMicrotask(()=>document.querySelector('[data-testid="workroom-restart-confirm-open"]')?.click());});
    await f.page.waitForTimeout(150);
    await f.page.getByTestId('workroom-restart-confirm-open').click();
    await f.page.waitForTimeout(200);
    assert.equal(f.history.filter(r=>r.operation==='resume.review'||r.operation==='resume.execute').length,0,'nothing is sent inside the 500 ms guard');
    assert.match(await f.page.getByTestId('workroom-restart-confirm').innerText(),/권한 우회 없음/);
    await f.page.waitForTimeout(400);
    await f.page.getByTestId('workroom-restart-confirm-open').click();
    await until(f.page,()=>/다시 열었습니다/.test(document.querySelector('[data-testid="workroom-restart-summary"]')?.textContent??''),'batch summary');
    const sent=f.history.filter(r=>r.operation==='resume.review'||r.operation==='resume.execute').map(r=>`${r.operation}:${r.conversationId}`);
    assert.deepEqual(sent,['resume.review:conversation-ready-0001','resume.execute:conversation-ready-0001','resume.review:conversation-ready-0002','resume.execute:conversation-ready-0002']);
    assert.ok(f.history.filter(r=>r.operation==='resume.execute').every(r=>r.expectedRevision===3&&!('bypassPermissions' in r)));
    assert.equal(await f.page.evaluate(()=>window.opened.length),0,'no window opens by itself');
    assert.match(await f.page.getByTestId('workroom-restart-summary').textContent(),/^2개를 다시 열었습니다 — 작업 세션 목록에서 여세요\./);
    assert.equal(await f.page.getByTestId('workroom-restart-open-all').count(),0,'the finished offer is gone');
    await f.page.screenshot({path:join(shots,'restart-directory-after.png')});
    await f.page.getByTestId('workroom-restart-summary-close').click();
    assert.equal(await banner(f.page).count(),0,'the summary closes');
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);assert.deepEqual(f.unexpected,[]);
    results.push({name:'directory-batch',passed:true});await f.context.close();
  }
  // 2. Dismiss once; focus does not resurrect it.
  {
    const host={offer:offer([row('conversation-ready-0001','proj-alpha-001','claude','ready')],false),sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-banner"]'),'banner shown');
    assert.equal(await f.page.getByTestId('workroom-restart-title').textContent(),'앱을 다시 열기 전 실행 중이던 작업 세션 1개');
    for(const theme of ['gray','dark']){await f.page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await banner(f.page).screenshot({path:join(shots,`restart-banner-${theme}.png`)});}
    await f.page.getByTestId('workroom-restart-dismiss').click();
    await until(f.page,()=>!document.querySelector('[data-testid="workroom-restart-banner"]'),'banner hidden after dismiss');
    await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await f.page.waitForTimeout(400);
    assert.equal(await banner(f.page).count(),0);
    assert.equal(f.history.filter(r=>r.operation==='restart.dismiss').length,1);
    assert.equal(f.history.filter(r=>r.operation==='restart.dismiss')[0].offerId,'restart-offer-0001');
    assert.deepEqual(f.errors,[]);results.push({name:'dismiss-once',passed:true});await f.context.close();
  }
  // 3. A pending row: 결과 확인 needs a kept receipt; 확인했음 sits behind the warning and the guard, and is sent once.
  {
    const host={offer:offer([row('conversation-pending-01','proj-alpha-001','claude','pending')]),sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-rows"]'),'rows open by themselves when nothing can be opened at once');
    assert.equal(await f.page.getByTestId('workroom-restart-open-all').count(),0);
    assert.match(await f.page.getByTestId('workroom-restart-row').innerText(),/이어 열기 결과 확인 필요/);
    await f.page.getByTestId('workroom-restart-row-settle').click();
    assert.match(await f.page.getByTestId('workroom-restart-settle-confirm').innerText(),/두 번 열릴 수 있습니다/);
    await f.page.getByTestId('workroom-restart-settle-yes').click(); // inside the guard: ignored
    await f.page.waitForTimeout(150);
    assert.equal(f.history.filter(r=>r.operation==='resume.settle').length,0);
    await f.page.waitForTimeout(450);await f.page.getByTestId('workroom-restart-settle-yes').click();
    await until(f.page,()=>/다시 이어 열 수 있습니다/.test(document.querySelector('[data-testid="workroom-restart-notice"]')?.textContent??''),'settle notice');
    assert.equal(f.history.filter(r=>r.operation==='resume.settle').length,1);
    assert.equal(f.history.find(r=>r.operation==='resume.settle').expectedRevision,3);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-open-all"]'),'the settled row can be opened now');
    assert.deepEqual(f.errors,[]);results.push({name:'pending-settle',passed:true});await f.context.close();
  }
  // 3b. The saved list: 「앱 재시작으로 끊김」, and a resume whose outcome is unknown offers 「확인했음」 behind the warning.
  {
    const saved={id:'conversation-unsettled-1',targetId:'proj-alpha-001',agent:'claude',accountId:'host-default',accountLabel:'현재 CLI 계정',title:'끊긴 대화',createdAt:at,updatedAt:at,revision:7,archived:false,state:'detached',sessionId:'old-session-0007',binding:'verified'};
    const host={offer:null,sessions:[],saved:[saved],unsettled:[saved.id]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>/저장된 대화 1개/.test(document.querySelector('[data-testid="session-directory-saved"] summary')?.textContent??''),'saved list counted');
    await f.page.locator('[data-testid="session-directory-saved"] summary').click();
    const savedRow=f.page.getByTestId('history-row');await savedRow.waitFor();
    assert.match(await savedRow.innerText(),/앱 재시작으로 끊김/);
    await savedRow.getByRole('button',{name:'이어 열기',exact:true}).click();
    await f.page.getByTestId('history-settle').waitFor();
    assert.match(await f.page.getByTestId('history-review').innerText(),/확인하지 못했습니다/);
    await f.page.getByTestId('history-settle').click();
    assert.match(await f.page.getByTestId('history-review').innerText(),/두 번 열릴 수 있습니다/);
    await f.page.getByTestId('history-settle-yes').click(); // inside the guard: ignored
    await f.page.waitForTimeout(150);
    assert.equal(f.history.filter(r=>r.operation==='resume.settle').length,0);
    await f.page.waitForTimeout(450);await f.page.getByTestId('history-settle-yes').click();
    await until(f.page,()=>/다시 이어 열 수 있습니다/.test(document.querySelector('[data-testid="history-notice"]')?.textContent??''),'settled');
    const settled=f.history.filter(r=>r.operation==='resume.settle');
    assert.equal(settled.length,1);assert.equal(settled[0].conversationId,saved.id);assert.equal(settled[0].expectedRevision,7);
    assert.equal(f.history.filter(r=>r.operation==='resume.execute').length,0,'settling never resumes');
    assert.deepEqual(f.errors,[]);results.push({name:'saved-list-settle',passed:true});await f.context.close();
  }
  // 4. An older sidecar refuses restart.list: no banner, no error line.
  {
    const host={offer:null,restartStatus:400,sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="session-directory-device"]'),'directory shown');
    await f.page.waitForTimeout(600);
    assert.ok(f.history.some(r=>r.operation==='restart.list'));
    assert.equal(await banner(f.page).count(),0);
    assert.doesNotMatch(await f.page.locator('body').innerText(),/대화 기록 요청 형식을 확인하세요/);
    assert.deepEqual(f.errors,[]);results.push({name:'old-sidecar-silent',passed:true});await f.context.close();
  }
  // 5. The pop-out: before the session list while nothing runs, after it once a session runs. Narrow window too.
  for(const [running,viewport] of [[false,{width:1000,height:760}],[true,{width:1000,height:760}],[true,{width:800,height:700}]]){
    const host={offer:offer([row('conversation-ready-0001','proj-alpha-001','claude','ready')]),sessions:running?[runningSession]:[]};
    const f=await open('/?workroom-popout=1&session=session-running-01&target=proj-alpha-001&agent=codex&bypass=0',host,viewport);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-banner"]'),'pop-out banner shown',20_000);
    assert.equal(await banner(f.page).evaluate(element=>!!element.closest('[data-testid="ai-terminal-panel"]')),true,'inside the panel slot');
    if(running){
      // On the Mac the banner sits above the session list and the terminal, inside the first screen (the phone's list
      // keeps it after its rows — Build B). It goes away once handled, so the terminal moves down only meanwhile.
      await until(f.page,()=>!!document.querySelector('.ai-terminal-workspace'),'session list shown');
      assert.equal(await banner(f.page).evaluate(element=>!!(document.querySelector('.ai-terminal-workspace').compareDocumentPosition(element)&Node.DOCUMENT_POSITION_PRECEDING)),true,'before the session list');
      const box=await banner(f.page).boundingBox();assert.ok(box&&box.y+box.height<=viewport.height,'the banner is on the first screen');
    }else assert.equal(await f.page.locator('.ai-terminal-workspace').count(),0);
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
    await f.page.screenshot({path:join(shots,`restart-popout-${running?'running':'idle'}-${viewport.width}.png`)});
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.external,[]);
    results.push({name:`popout-${running?'running':'idle'}-${viewport.width}`,passed:true});await f.context.close();
  }
  // 6. Review: keyboard, one row's confirmation, two sessions of one project and AI.
  {
    const host={offer:offer([row('conversation-twin-00001','proj-alpha-001','claude','ready',null,3,'2026-10-16T01:00:00.000Z'),row('conversation-twin-00002','proj-alpha-001','claude','ready',null,3,'2026-10-16T03:30:00.000Z')]),sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-open-all"]'),'banner shown');
    await f.page.getByTestId('workroom-restart-toggle').click();
    // Each row says when it started on the line under its name (the name itself is not repeated with it).
    const lines=await f.page.getByTestId('workroom-restart-row').locator('small').allTextContents();
    assert.equal(new Set(lines).size,2,'two sessions of one project and AI are told apart: '+lines.join(' | '));
    assert.ok(lines.every(line=>/^10월 16일 \d\d:\d\d 시작 · 이어 열 수 있음$/.test(line)),lines.join(' | '));
    assert.deepEqual(await f.page.getByTestId('workroom-restart-row').locator('strong').allTextContents(),['알파 서비스 · Claude Code','알파 서비스 · Claude Code']);
    // Enter arms; focus moves into the confirmation sentence.
    await f.page.getByTestId('workroom-restart-open-all').focus();await f.page.keyboard.press('Enter');
    await f.page.getByTestId('workroom-restart-confirm').waitFor();
    assert.equal(await f.page.evaluate(()=>document.activeElement?.tagName==='P'&&!!document.activeElement.closest('[data-testid="workroom-restart-confirm"]')),true,'focus is on the confirmation');
    // Enter on 취소, then Enter again: focus went back to 「N개 이어 열기」 (not to the 「닫기」 that now sits where 취소 was).
    await f.page.getByTestId('workroom-restart-confirm-cancel').focus();await f.page.keyboard.press('Enter');
    await until(f.page,()=>!document.querySelector('[data-testid="workroom-restart-confirm"]'),'confirmation closed');
    assert.equal(await f.page.evaluate(()=>document.activeElement?.getAttribute('data-testid')),'workroom-restart-open-all');
    await f.page.keyboard.press('Enter');
    await f.page.getByTestId('workroom-restart-confirm').waitFor();
    assert.equal(f.history.filter(r=>r.operation==='restart.dismiss').length,0,'Enter, Enter never closes the offer');
    await f.page.getByTestId('workroom-restart-confirm-cancel').click();
    // One row's 「이어 열기」 arms its own confirmation (500 ms guard), then opens that row only.
    await f.page.getByTestId('workroom-restart-row-open').nth(1).click();
    await f.page.getByTestId('workroom-restart-confirm').waitFor();
    assert.match(await f.page.getByTestId('workroom-restart-confirm').innerText(),/「알파 서비스 · Claude Code \(10월 16일 \d\d:\d\d 시작\)」 대화를 다시 엽니다 · 권한 우회 없음/);
    assert.equal(f.history.filter(r=>r.operation==='resume.review').length,0,'arming sends nothing');
    await f.page.getByTestId('workroom-restart-confirm-open').click(); // inside the guard: ignored
    await f.page.waitForTimeout(150);assert.equal(f.history.filter(r=>r.operation==='resume.review').length,0);
    await f.page.waitForTimeout(450);await f.page.getByTestId('workroom-restart-confirm-open').click();
    await until(f.page,()=>/1개를 다시 열었습니다/.test(document.querySelector('[data-testid="workroom-restart-summary"]')?.textContent??''),'one row opened');
    assert.deepEqual(f.history.filter(r=>r.operation==='resume.review'||r.operation==='resume.execute').map(r=>`${r.operation}:${r.conversationId}`),
      ['resume.review:conversation-twin-00002','resume.execute:conversation-twin-00002']);
    await banner(f.page).screenshot({path:join(shots,'restart-review-twins.png')});
    assert.deepEqual(f.errors,[]);results.push({name:'review-keyboard-row-confirm-twins',passed:true});await f.context.close();
  }
  // 7. Review: the saved list says why a row cannot be opened; an older sidecar refusing `detail` is asked once, then plainly.
  for(const refuseDetail of [false,true]){
    const saved=(id,agent,title)=>({id,targetId:'proj-alpha-001',agent,accountId:'host-default',accountLabel:'현재 CLI 계정',title,createdAt:at,updatedAt:at,revision:2,archived:false,state:'detached',sessionId:'old-'+id,binding:'unverified'});
    const host={offer:null,sessions:[],saved:[saved('conversation-hermes-001','hermes','헤르메스 대화'),saved('conversation-claude-001','claude','클로드 대화')],
      availability:{'conversation-hermes-001':'unsupported','conversation-claude-001':'check'},refuseDetail};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>/저장된 대화 2개/.test(document.querySelector('[data-testid="session-directory-saved"] summary')?.textContent??''),'saved list counted');
    await f.page.locator('[data-testid="session-directory-saved"] summary').click();
    const hermes=f.page.locator('[data-testid="history-row"][data-conversation-id="conversation-hermes-001"]'),claude=f.page.locator('[data-testid="history-row"][data-conversation-id="conversation-claude-001"]');
    await hermes.waitFor();
    if(refuseDetail){
      assert.equal(await hermes.getByTestId('history-resume').count(),1,'an older sidecar: the old row, unchanged');
      const lists=f.history.filter(r=>r.operation==='list'&&!r.archived);
      assert.equal(lists.filter(r=>r.detail).length,1,'detail asked once');assert.ok(lists.some(r=>!r.detail));
    }else{
      assert.match(await hermes.innerText(),/이 AI는 이어 열기를 지원하지 않음/);
      assert.equal(await hermes.getByTestId('history-resume').count(),0,'no 이어 열기 that can only fail');
      assert.equal(await claude.getByTestId('history-resume').count(),1);
    }
    assert.deepEqual(f.errors,[]);results.push({name:`saved-list-why${refuseDetail?'-old-sidecar':''}`,passed:true});await f.context.close();
  }
  // 8. Review: 닫기 answers what is current — rows nobody closed (a newer restart) stay listed.
  {
    const host={offer:offer([row('conversation-closed-0001','proj-alpha-001','claude','ready')]),afterDismiss:{...offer([row('conversation-newer-00001','proj-bravo-001','codex','ready')]),offerId:'restart-offer-0002'},sessions:[]};
    const f=await open('/__restart-fixture',host);
    await until(f.page,()=>!!document.querySelector('[data-testid="workroom-restart-open-all"]'),'banner shown');
    await f.page.getByTestId('workroom-restart-dismiss').click();
    await until(f.page,()=>/작업 세션 1개/.test(document.querySelector('[data-testid="workroom-restart-title"]')?.textContent??'')&&!!document.querySelector('[data-testid="workroom-restart-open-all"]'),'the current offer is shown');
    await f.page.getByTestId('workroom-restart-toggle').click();
    assert.deepEqual(await f.page.getByTestId('workroom-restart-row').evaluateAll(rows=>rows.map(row=>row.dataset.conversationId)),['conversation-newer-00001']);
    assert.deepEqual(f.errors,[]);results.push({name:'dismiss-shows-current',passed:true});await f.context.close();
  }
  await writeFile(join(shots,'restart-banner-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:results.length,failed:0,results,evidence:shots},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{await browser?.close();await vite?.close();if(!process.env.RESTART_EVIDENCE_DIR)await rm(scratch,{recursive:true,force:true});}
