/** Real Workroom React+xterm in a 264px-sidebar shell at the saved 125% zoom.
 * Start Vite on 127.0.0.1:9000, then: node tests/workroom-usability.e2e.mjs
 * Every API is mocked; no actual PTY, project, saved memory, or external service
 * is accessed. These Chromium checks do not claim native macOS verification.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_USABILITY_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const output=new URL('../output/playwright/',import.meta.url);await mkdir(output,{recursive:true});
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const A='fixture-project-alpha',B='fixture-worktree-bravo',SA='fixture-session-alpha',SB='fixture-session-bravo',SE='fixture-session-ended';
const projects=[{targetId:A,projectTargetId:A,label:'기억 A · 프로젝트와 장기기억을 함께 관리하는 긴 이름',scope:'main',branch:'main',locked:false,worktreeCapable:true},
  {targetId:B,projectTargetId:'fixture-project-bravo',label:'기억 B · codex/usability-worktree',scope:'worktree',branch:'codex/usability-worktree',locked:false,worktreeCapable:true}];
const session=(id,targetId,state='running',agent='codex')=>({id,targetId,agent,state,createdAt:'2026-09-07T00:00:00Z',exitCode:state==='running'?null:0,cols:100,rows:28});
const completed=Array.from({length:45},(_,i)=>({sessionId:`fixture-completed-${i}`,targetId:i%2?B:A,state:i%2?'saved':'unchanged'}));
const attention=['failed','pending','saving','backup-pending','unavailable','failed','pending','unavailable'].map((state,i)=>({sessionId:`fixture-attention-${i}`,targetId:i===7?A:i%2?B:A,state}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(10);}assert.fail(message);}
const html=options=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';applyZoomToDocument(document,${options.remote?1:1.25});
window.__workroomActions=[];const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');const {MemoryAutomaticSettings}=await import('/src/MemoryAutomaticSettings.tsx');
function AutomaticHarness(){const [target,setTarget]=React.useState(${JSON.stringify(A)});
 return React.createElement('div',{'data-testid':'ai-terminal-panel'},
  React.createElement('select',{'aria-label':'터미널 프로젝트',value:target,onChange:e=>setTarget(e.target.value)},
   React.createElement('option',{value:''},'프로젝트 선택'),${JSON.stringify(projects)}.map(p=>React.createElement('option',{key:p.targetId,value:p.targetId},p.label))),
  React.createElement(MemoryAutomaticSettings,{targetId:target}));}
function Harness(){const [visible,setVisible]=React.useState(true);window.__setWorkroomVisible=setVisible;const [entry,setEntry]=React.useState(${JSON.stringify(options.entry??null)});window.__setWorkroomEntry=setEntry;
 const workroom=React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},visible,remote:${!!options.remote},entry,sessionScope:'workroom-usability-fixture',onManageProject:id=>window.__workroomActions.push({action:'manage',id}),onWhatISaid:()=>window.__workroomActions.push({action:'what-i-said'})});
 // App.tsx's actual bounded flex ancestry; an unconstrained grid cannot reproduce
 // flex-shrink collisions between the terminal keys and the following memory card.
 if(${!!options.appShell})return React.createElement('div',{className:'h-screen flex flex-col overflow-hidden'},
  React.createElement('div',{className:'workspace-shell flex-1 min-h-0','data-mobile':'false'},
   React.createElement('aside',{'data-testid':'top-toolbar',className:'shrink-0'},React.createElement('div',{className:'workspace-brand'},'AgentsToZ · Fixture')),
   React.createElement('div',{className:'workspace-content'},React.createElement('div',{id:'top-level-terminal-panel',role:'tabpanel',className:'flex-1 min-h-0 overflow-auto flex flex-col'},workroom))));
 return React.createElement('div',{style:{display:'grid',gridTemplateColumns:${JSON.stringify(options.remote?'minmax(0,1fr)':'264px minmax(0,1fr)')},minHeight:'var(--ui-viewport-height)'}},
  ${options.remote?'null':"React.createElement('aside',{'data-testid':'fixture-app-sidebar',style:{padding:'24px',borderRight:'1px solid var(--line)',fontSize:'14px'}},'AgentsToZ · Fixture',React.createElement('p',null,'프로젝트와 워크룸'))"},
  React.createElement('main',{className:${JSON.stringify(options.remote?'remote-panel':'')},style:{padding:'16px',minWidth:0}},workroom));
}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(${options.automaticSettingsOnly?'AutomaticHarness':'Harness'}));
</script>`;
const browser=await chromium.launch({headless:true}),results=[];
async function fixture(options={}){
  const context=await browser.newContext({viewport:{width:options.remote?390:1000,height:1050},serviceWorkers:'block'});
  const state={sessions:structuredClone(options.sessions??[]),jobs:structuredClone(options.jobs??completed),requests:[],errors:[],blocked:[],memoryError:false,startError:false,completion:options.completion??null,keyStatus:options.keyStatus??null,keyError:null,automaticStatusFailures:options.automaticStatusFailures??0,automaticProviderError:false,automatic:options.automatic?{version:1,targetId:A,supported:true,revision:0,enabled:false,excluded:false,scope:'project',inScope:true,provider:options.automaticProvider??null,last:null,backup:{pending:0,blocked:0,hasMore:false}}:null};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__workroom-usability')return route.fulfill({contentType:'text/html',body:html(options)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON();state.requests.push({path:url.pathname,...body});
    const respond=(json,status=200)=>route.fulfill({json,status});
    if(url.pathname==='/api/agent-runtime/targets')return respond({protocolVersion:'agentstoz-tasks-v2',targets:projects,complete:true});
    if(url.pathname==='/api/agent-runtime/terminals/access')return respond({connections:[]});
    if(url.pathname==='/api/agent-runtime/terminals/memory') {
      if(body.automaticOperation){
        assert.ok(state.automatic,'Automatic operations require negotiated support');
        const a=state.automatic;
        if(body.automaticOperation==='status'&&state.automaticStatusBarrier){
          const snapshot=structuredClone({...a,targetId:body.observationTargetId}),wait=state.automaticStatusBarrier;
          state.automaticStatusBarrier=null;state.automaticStatusWaiting=true;await wait;state.automaticStatusWaiting=false;return respond(snapshot);
        }
        if(body.automaticOperation==='status'&&state.automaticStatusFailures>0){state.automaticStatusFailures--;return respond({error:'Fixture status unavailable'},503);}
        if(body.automaticOperation==='review-recovery-provider'){
          assert.deepEqual(Object.keys(body).sort(),['automaticOperation','observationTargetId'].sort());
          const review={version:1,targetId:body.observationTargetId,approvalId:'provider-review-'+body.observationTargetId,reviewDigest:'b'.repeat(64),expiresAt:Date.now()+300000,
            parentSaveId:'fixture-parent',parentAttemptId:'fixture-original-attempt',additionalCalls:1,model:'claude-fixture-prepared',effort:'low',binaryChanged:true,...state.providerReviewPatch};
          state.lastProviderReview=review;
          const snapshot=structuredClone({...a,targetId:body.observationTargetId,providerRecoveryReview:review});
          if(state.providerReviewBarrier){const wait=state.providerReviewBarrier;state.providerReviewBarrier=null;state.providerReviewWaiting=true;await wait;state.providerReviewWaiting=false;}
          return respond(snapshot);
        }
        if(body.automaticOperation==='verify-recovery-provider'){
          assert.deepEqual(Object.keys(body).sort(),['automaticOperation','observationTargetId','approvalId','reviewDigest','explicitConsent'].sort());
          assert.equal(body.explicitConsent,true);assert.equal(body.observationTargetId,state.lastProviderReview.targetId);
          assert.equal(body.approvalId,state.lastProviderReview.approvalId);assert.equal(body.reviewDigest,state.lastProviderReview.reviewDigest);
          if(state.providerVerifyBarrier){const wait=state.providerVerifyBarrier;state.providerVerifyBarrier=null;state.providerVerifyWaiting=true;await wait;state.providerVerifyWaiting=false;}
          if(state.providerVerifyError){a.recoveryProvider={state:'unknown',completedAt:null};return respond({error:'Fixture provider probe response unavailable'},503);}
          a.recoveryProvider={state:'ready',completedAt:Date.now()};return respond({...a,targetId:body.observationTargetId});
        }
        if(body.automaticOperation==='review-recovery'){
          assert.deepEqual(Object.keys(body).sort(),['automaticOperation','observationTargetId'].sort());
          if(state.recoveryReviewError)return respond({error:'Fixture recovery conditions changed'},409);
          const review={version:1,targetId:body.observationTargetId,approvalId:'review-'+body.observationTargetId,reviewDigest:'a'.repeat(64),expiresAt:Date.now()+300000,
            parentSaveId:'fixture-parent',parentAttemptId:'fixture-original-attempt',sourceCount:2,inputBytes:1024,additionalCalls:1,model:'claude-fixture-prepared',effort:'low',...state.recoveryReviewPatch};
          state.lastRecoveryReview=review;
          const snapshot=structuredClone({...a,targetId:body.observationTargetId,recoveryReview:review});
          if(state.recoveryReviewBarrier){const wait=state.recoveryReviewBarrier;state.recoveryReviewBarrier=null;state.recoveryReviewWaiting=true;await wait;state.recoveryReviewWaiting=false;}
          return respond(snapshot);
        }
        if(body.automaticOperation==='execute-recovery'){
          assert.deepEqual(Object.keys(body).sort(),['automaticOperation','observationTargetId','approvalId','reviewDigest','explicitConsent'].sort());
          assert.equal(body.explicitConsent,true);assert.equal(body.observationTargetId,state.lastRecoveryReview.targetId);
          assert.equal(body.approvalId,state.lastRecoveryReview.approvalId);assert.equal(body.reviewDigest,state.lastRecoveryReview.reviewDigest);
          if(state.recoveryExecuteBarrier){const wait=state.recoveryExecuteBarrier;state.recoveryExecuteBarrier=null;state.recoveryExecuteWaiting=true;await wait;state.recoveryExecuteWaiting=false;}
          if(state.recoveryExecuteError)return respond({error:'Fixture recovery response unavailable'},503);
          a.last={state:'saved',localSaved:true};return respond({...a,targetId:body.observationTargetId});
        }
        if(body.automaticOperation==='prepare-provider'&&state.automaticProviderError)return respond({error:'Fixture model connection refused'},503);
        if(body.automaticOperation==='prepare-provider')a.provider={model:body.model,effort:body.effort,configurationId:'fixture-config',preparedAt:1};
        if(body.automaticOperation==='revalidate-provider'){
          if(state.revalidateBarrier){const wait=state.revalidateBarrier;state.revalidateBarrier=null;state.revalidateWaiting=true;await wait;state.revalidateWaiting=false;}
          assert.equal(a.enabled,true);assert.equal(body.expectedRevision,a.revision);assert.equal(body.configurationId,a.provider.configurationId);
          assert.deepEqual(Object.keys(body).sort(),['automaticOperation','configurationId','expectedRevision','observationTargetId'].sort());
          if(state.automaticProviderError)return respond({error:'Fixture same-model revalidation refused'},409);
          a.revision++;a.provider={...a.provider,configurationId:'fixture-revalidated',preparedAt:2};
        }
        if(['enable','disable','exclude'].includes(body.automaticOperation)){
          assert.equal(body.expectedRevision,a.revision);a.revision++;
          if(body.automaticOperation==='enable'){assert.equal(body.consentVersion,1);assert.equal(body.configurationId,a.provider.configurationId);assert.ok(['project','all'].includes(body.scope));a.scope=body.scope;a.enabled=true;}
          if(body.automaticOperation==='disable')a.enabled=false;
          if(body.automaticOperation==='exclude')a.excluded=body.excluded;
        }
        return respond({...a,targetId:body.observationTargetId});
      }
      if(body.keyOperation){
        assert.ok(state.keyStatus,'Key operations require negotiated support');
        if(body.keyOperation!=='status'){if(state.keyError)return respond({error:state.keyError},400);state.keyStatus='registered';}
        return respond({version:1,targetId:body.observationTargetId,keyStatus:state.keyStatus,automaticSavingChanged:false});
      }
      if(state.memoryBarrier){const wait=state.memoryBarrier;state.memoryBarrier=null;state.memoryWaiting=true;await wait;state.memoryWaiting=false;}
      if(state.memoryError)return respond({error:'Fixture memory status unavailable'},503);
      if(!state.completion&&body.observationTargetId)return respond({error:'Legacy host rejects unknown request fields'},400);
      const offset=body.offset??0, jobs=options.paginated?state.jobs.slice(offset,offset+128):state.jobs;
      const observation=body.observationTargetId&&state.completion?{version:1,targetId:body.observationTargetId,state:'available',completedTurns:body.observationTargetId===A?2:0,hasMore:false,conversationMemory:'not-connected',...state.completion}:undefined;
      return respond({jobs,...(state.automatic?{automaticMemorySupported:true}:{}),...(state.completion?{observationSupported:true}:{}),...(state.keyStatus?{keyManagementSupported:true}:{}),...(observation?{observation}:{}),...(options.paginated?{total:state.jobs.length,unresolved:state.jobs.length,offset,nextOffset:offset+jobs.length<state.jobs.length?offset+jobs.length:null}:{})});
    }
    if(url.pathname==='/api/agent-runtime/terminals'){
      if(body.operation==='list'){if(options.listDelayMs)await sleep(options.listDelayMs);return respond({sessions:state.sessions});}
      if(body.operation==='start'){
        if(state.startError)return respond({error:'Fixture CLI start refused'},503);
        assert.ok(projects.some(project=>project.targetId===body.targetId),'Only invented runtime target IDs are allowed');
        const created=session(`fixture-started-${state.sessions.length}`,body.targetId,'running',body.agent);state.sessions.push(created);
        if(state.startBarrier){const wait=state.startBarrier;state.startBarrier=null;state.startWaiting=true;await wait;state.startWaiting=false;}
        return respond({session:created});
      }
      const selected=state.sessions.find(current=>current.id===body.sessionId);assert.ok(selected,'Unknown fixture terminal');
      if(body.operation==='read')return respond({session:selected,chunks:body.after<1?[{seq:1,text:'FIXTURE_ONLY_TERMINAL_OUTPUT\r\n'}]:[],nextCursor:Math.max(1,body.after),truncated:false,hasMore:false});
      if(body.operation==='close'){selected.state='exited';selected.exitCode=143;return respond({session:selected});}
      if(['input','resize'].includes(body.operation)){
        if(body.operation==='input'&&state.inputBarrier){const wait=state.inputBarrier;state.inputBarrier=null;state.inputWaiting=true;await wait;state.inputWaiting=false;}
        return respond({session:selected});
      }
    }
    state.blocked.push(`${request.method()} ${url.pathname}`);return respond({error:'Unmocked API is forbidden'},503);
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  await page.goto(`${origin}/__workroom-usability`);const panel=page.getByTestId('ai-terminal-panel');await panel.waitFor({timeout:10000});
  await until(()=>options.automaticSettingsOnly?state.requests.some(r=>r.automaticOperation==='status'):state.requests.some(r=>r.operation==='list')&&(options.remote||state.requests.some(r=>r.path.endsWith('/memory'))),'Initial fixture reads must occur');
  await until(async()=>await panel.getByLabel('터미널 프로젝트').locator('option').count()>=3,'The two selectable runtime targets must render');
  return{context,page,panel,state};
}
const starts=state=>state.requests.filter(r=>r.operation==='start');
async function layout(page,panel){
  const geometry=await panel.evaluate(node=>{
    const box=element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,width:rect.width};};
    return{viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,zoom:document.getElementById('root').style.transform,panel:box(node),sidebar:box(document.querySelector('[data-testid="fixture-app-sidebar"]')),
      controls:[...node.querySelectorAll('button,select,textarea,.ai-terminal-tab')].filter(element=>element.getClientRects().length).map(box)};
  });
  assert.equal(geometry.zoom,'scale(1.25)');assert.ok(Math.abs(geometry.sidebar.width-330)<=2,'The actual 264px sidebar must also receive 125% zoom');
  assert.ok(geometry.documentWidth<=geometry.viewport+2&&geometry.panel.left>=geometry.sidebar.right&&geometry.panel.right<=geometry.viewport+2,JSON.stringify(geometry));
  assert.ok(geometry.controls.every(control=>control.left>=geometry.panel.left-2&&control.right<=geometry.panel.right+2),'Every control must fit within the panel: '+JSON.stringify(geometry));
  return geometry;
}
async function verticalGeometry(panel){return panel.evaluate(node=>{
  const box=selector=>{const r=node.querySelector(selector).getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
  const scroller=node.parentElement,keys=box('.ai-terminal-keys'),memory=box('.ai-terminal-memory'),workspace=box('.ai-terminal-workspace');
  const blockedVisibleKeys=[...node.querySelectorAll('.ai-terminal-keys button')].flatMap(button=>{
    const r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(y<0||y>=innerHeight)return[];
    const hit=document.elementFromPoint(x,y);return button.contains(hit)?[]:[{key:button.textContent,hit:hit?.className??'none'}];
  });
  return{keys,memory,workspace,blockedVisibleKeys,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,scrollTop:scroller.scrollTop};
});}
function assertVerticalGeometry(geometry){
  assert.ok(geometry.keys.bottom<=geometry.memory.top+1,'Memory must follow the complete key row, without vertical overlap: '+JSON.stringify(geometry));
  assert.ok(geometry.workspace.bottom>=geometry.keys.bottom-1,'The workspace must contain its key row: '+JSON.stringify(geometry));
  assert.deepEqual(geometry.blockedVisibleKeys,[],'The memory section must not intercept visible terminal key centers');
}
const focusedCase=process.env.WORKROOM_USABILITY_CASE;
async function run(name,execute,options){if(focusedCase&&name!==focusedCase)return;let f;try{f=await fixture(options);const details=await execute(f);
  assert.deepEqual(f.state.blocked,[],'Every API must be a fixture; external traffic is forbidden');assert.deepEqual(f.state.errors,[],'The actual component must not throw');
  results.push({name,status:'passed',...details});console.log(`PASS ${name}`);
}catch(error){results.push({name,status:'failed',error:error.message});console.error(`FAIL ${name}: ${error.message}`);await f?.page.screenshot({path:new URL(`workroom-usability-${name}-failed.png`,output).pathname,fullPage:true}).catch(()=>{});
}finally{await f?.context.close();}}

try{
  await run('project-and-agent-selection-survive-panel-remount',async({page,panel,state})=>{
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    await panel.getByLabel('터미널 AI').selectOption('claude');
    await page.reload();await panel.waitFor();
    await until(async()=>await panel.getByLabel('터미널 프로젝트').inputValue()===B,'The selected project must survive a Workroom remount');
    assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');
    assert.equal(starts(state).length,0,'Restoring selectors must not start a CLI');
    await page.evaluate(id=>window.__setWorkroomEntry({nonce:2,targetId:id,agent:'codex'}),A);
    await until(async()=>await panel.getByLabel('터미널 프로젝트').inputValue()===A,'An explicit project entry overrides the remembered selector');
    assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'codex');
  },{jobs:[]});
  await run('remote-project-entry-resumes-only-the-selected-project',async({page,panel,state})=>{
    await until(async()=>await panel.getByRole('tab',{selected:true}).count()===1,'Matching running session must be selected');
    assert.ok((await panel.getByRole('tab',{selected:true}).textContent()).includes('기억 B'));
    assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');
    assert.equal(starts(state).length,0,'Opening the Workroom must not create a duplicate terminal');
    await page.evaluate(value=>window.__setWorkroomEntry(value),{nonce:2,targetId:A,resumeLatest:true});
    await until(async()=>(await panel.getByRole('tab',{selected:true}).textContent()).includes('기억 A'),'New entry must resolve its own project');
  },{remote:true,sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:B,resumeLatest:true},jobs:[],listDelayMs:150});

  await run('startup-exit-keeps-final-error-visible',async({panel,state})=>{
    await panel.locator('.xterm').waitFor();
    state.sessions[0].state='exited';state.sessions[0].exitCode=1;
    await panel.getByRole('button',{name:'터미널 새로고침',exact:true}).click();
    await panel.getByText(/터미널이 종료되었습니다 \(종료 코드 1\)/).waitFor();
    assert.ok(await panel.locator('.xterm').isVisible());
    assert.equal(await panel.getByRole('tab',{selected:true}).count(),1);
    assert.ok(await panel.getByRole('button',{name:'Enter',exact:true}).isDisabled());
    assert.equal(starts(state).length,0);
  },{remote:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});

  await run('history-reset-persists-without-changing-save-jobs',async({page,panel,state})=>{
    const original=structuredClone(state.jobs);
    await panel.getByTestId('workroom-reset-history').click();
    const older=panel.getByTestId('workroom-memory-previous');await older.waitFor();
    assert.equal(await older.getAttribute('open'),null);
    assert.ok((await panel.getByTestId('workroom-memory-attention').textContent()).includes('저장 대기'));
    assert.deepEqual(state.jobs,original);
    await page.reload();await panel.getByTestId('workroom-memory-previous').waitFor();
    await panel.getByTestId('workroom-memory-previous').locator('summary').click();
    await panel.getByRole('button',{name:'이 페이지의 이전 기록을 현재 목록으로 복원',exact:true}).click();
    assert.equal(await panel.getByTestId('workroom-memory-previous').count(),0);
    assert.deepEqual(state.jobs,original);
  },{jobs:[...attention,...completed]});

  await run('late-start-preserves-selected-session-input-and-new-entry-draft',async({page,panel,state})=>{
    let releaseStart,releaseInput;
    try{
      state.startBarrier=new Promise(resolve=>{releaseStart=resolve;});
      const start=panel.getByRole('button',{name:'선택한 AI로 시작',exact:true});
      await start.evaluate(button=>{button.click();button.click();});
      await until(()=>state.startWaiting,'Start A must remain pending');assert.equal(starts(state).length,1);
      const tabB=panel.getByRole('tab').filter({hasText:projects[1].label});await tabB.click();
      await panel.locator('.xterm').waitFor();await panel.locator('.xterm').evaluate(node=>{node.dataset.fixtureIdentity='selected-B';});
      state.inputBarrier=new Promise(resolve=>{releaseInput=resolve;});
      await panel.locator('.xterm-helper-textarea').focus();await page.keyboard.type('B-before');
      await until(()=>state.inputWaiting,'Input on B must be in flight while A starts');
      await page.keyboard.type('B-queued');await sleep(25);
      releaseStart();await until(()=>!state.startWaiting&&state.sessions.length===3,'A start response must finish');
      await until(async()=>await panel.getByRole('tab').count()===3,'Created A session remains in the list');
      await until(async()=>await panel.getByRole('button',{name:'새 터미널',exact:true}).isEnabled(),'The late start receipt must settle in React');
      assert.equal(await tabB.getAttribute('aria-selected'),'true','Late A must not select itself over B');
      assert.equal(await panel.locator('.xterm').getAttribute('data-fixture-identity'),'selected-B','B terminal must not be disposed or reset');
      releaseInput();await until(()=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('')==='B-beforeB-queued','Queued B text is retained');
      await panel.locator('.xterm-helper-textarea').focus();await page.keyboard.type('B-after');
      await until(()=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('')==='B-beforeB-queuedB-after','Subsequent input still reaches B');
      assert.ok(state.requests.filter(r=>r.operation==='input').every(r=>r.sessionId===SB));
      assert.equal(state.requests.filter(r=>r.operation==='close').length,0);assert.equal(starts(state).length,1);
      await panel.getByRole('button',{name:'새 작업 요청 작성',exact:true}).click();
      const draft=panel.getByLabel('터미널에 전달할 작업');assert.equal(await draft.inputValue(),'','The unchanged A request may be cleared after success');
      await draft.fill('두 번째 A 요청');state.startBarrier=new Promise(resolve=>{releaseStart=resolve;});
      await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();await until(()=>state.startWaiting,'Second A remains pending');
      await page.evaluate(value=>window.__setWorkroomEntry(value),{nonce:2,targetId:B,sessionId:SB,agent:'claude',prompt:'새 entry B 초안'});
      await until(async()=>await draft.inputValue()==='새 entry B 초안','The new entry draft is installed');
      releaseStart();await until(async()=>await panel.getByRole('tab').count()===4,'Second created session remains available');
      await until(async()=>await panel.getByRole('button',{name:'새 터미널',exact:true}).isEnabled(),'The second start receipt must settle in React');
      assert.equal(await draft.inputValue(),'새 entry B 초안');assert.equal(await tabB.getAttribute('aria-selected'),'true');
      assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');
      assert.equal(starts(state).length,2);assert.equal(new Set(starts(state).map(r=>r.requestId)).size,2);
      assert.equal(state.requests.filter(r=>r.operation==='close').length,0);
    }finally{releaseStart?.();releaseInput?.();}
  },{sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA,prompt:'첫 A 요청'},jobs:[]});

  await run('automatic-memory-requires-model-check-and-specific-consent',async({page,panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    await until(()=>state.requests.some(r=>r.automaticOperation==='status'),'Read-only automatic status');
    const enable=setup.getByRole('button',{name:'V2 자동 기억 정리 켜기',exact:true});
    assert.equal(await enable.isDisabled(),true);
    assert.equal(state.requests.filter(r=>r.automaticOperation==='prepare-provider').length,0);
    await setup.getByLabel('자동 기억 정리 모델 ID').fill('claude-fixture-1');
    await setup.getByRole('button',{name:'모델 연결 검사 · AI 1회',exact:true}).click();
    await until(async()=>/등록 모델: claude-fixture-1/.test(await setup.innerText()),'Prepared exact model is shown');
    assert.equal(await enable.isDisabled(),true);
    await setup.getByRole('checkbox').check();assert.equal(await enable.isEnabled(),true);
    await setup.getByLabel('자동 기억 정리 모델 ID').fill('claude-fixture-2');
    assert.equal(await setup.getByRole('checkbox').isChecked(),false);assert.equal(await enable.isDisabled(),true);
    await setup.getByRole('checkbox').check();assert.equal(await enable.isDisabled(),true,'Consent cannot enable a different unprepared draft');
    await setup.getByLabel('자동 기억 정리 모델 ID').fill('claude-fixture-1');await setup.getByRole('checkbox').check();
    const geometry=await layout(page,panel);await setup.screenshot({path:new URL('workroom-memory-v2-consent.png',output).pathname});
    assert.equal(await setup.getByLabel('자동 기억 정리 범위').inputValue(),'project');
    await setup.getByLabel('자동 기억 정리 범위').selectOption('all');assert.equal(await setup.getByRole('checkbox').isChecked(),false);
    await setup.getByLabel('자동 기억 정리 범위').selectOption('project');await setup.getByRole('checkbox').check();
    await enable.click();assert.equal(state.requests.find(r=>r.automaticOperation==='enable').scope,'project');await setup.getByRole('button',{name:'V2 자동 기억 정리 끄기',exact:true}).waitFor();
    assert.equal(state.requests.filter(r=>r.automaticOperation==='enable').length,1);assert.equal(starts(state).length,0);
    const revalidate=setup.getByRole('button',{name:'같은 모델 연결 다시 확인 · AI 1회',exact:true});
    assert.equal(state.requests.filter(r=>r.automaticOperation==='revalidate-provider').length,0,'Reading enabled settings never probes the model');
    state.automaticProviderError=true;await revalidate.click();
    await until(async()=>/Fixture same-model revalidation refused/.test(await setup.innerText()),'Failed revalidation remains visible');
    assert.equal(state.automatic.enabled,true);assert.equal(state.automatic.revision,1);
    state.automaticProviderError=false;await revalidate.click();
    await until(()=>state.automatic.provider.configurationId==='fixture-revalidated','Successful revalidation keeps automatic saving enabled');
    assert.equal(state.automatic.enabled,true);assert.equal(state.automatic.scope,'project');
    assert.equal(state.automatic.provider.model,'claude-fixture-1');assert.equal(state.automatic.provider.effort,'low');
    assert.equal(state.requests.filter(r=>r.automaticOperation==='disable'||r.automaticOperation==='enable').length,1,'Revalidation must never toggle consent');
    assert.equal(await setup.getByRole('alert').count(),0);
    await setup.getByRole('button',{name:'이 프로젝트 자동 정리 제외',exact:true}).click();
    await until(async()=>/V2 켜짐 · 이 프로젝트 제외/.test(await setup.innerText()),'Exclusion shown');
    await setup.getByRole('button',{name:'V2 자동 기억 정리 끄기',exact:true}).click();await enable.waitFor();
    assert.equal(await enable.isDisabled(),true);
    await page.evaluate(()=>window.__setWorkroomVisible(false));await sleep(100);
    const count=state.requests.filter(r=>r.automaticOperation).length;await sleep(500);
    assert.equal(state.requests.filter(r=>r.automaticOperation).length,count);
    return {geometry,operations:state.requests.filter(r=>r.automaticOperation).map(r=>r.automaticOperation)};
  },{automatic:true,completion:{},keyStatus:'registered',jobs:[]});
  await run('automatic-failure-diagnostics-preserve-unknown-history-and-display-only-fixed-metadata',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    const refresh=setup.getByRole('button',{name:'상태 다시 확인',exact:true});
    state.automatic.last={state:'recovery-required',localSaved:false};await refresh.click();
    const diagnostic=setup.getByTestId('memory-automatic-failure');
    await until(async()=>/AI 호출 여부를 확인할 수 없습니다/.test(await diagnostic.innerText()),'Old uncertain attempts remain unknown');
    state.automatic.last.failure={version:1,stage:'provider-call',code:'UNKNOWN',recordedAt:Date.parse('2026-09-09T01:02:03Z'),providerCallPossible:true};
    await refresh.click();await until(async()=>/모델 응답 확인 단계에서 중단/.test(await diagnostic.innerText()),'Durable failure stage is visible');
    assert.match(await diagnostic.innerText(),/AI가 호출되었을 수 있어/);assert.match(await diagnostic.innerText(),/2026-09-09T01:02:03/);
    state.automatic.last.failure={...state.automatic.last.failure,stage:'provider-readiness',code:'POLICY_CHANGED',providerCallPossible:false};
    await refresh.click();await until(async()=>/AI 요청 전 중단/.test(await diagnostic.innerText()),'A verified pre-call failure is distinct');
    state.automatic.last.failure={...state.automatic.last.failure,message:'PRIVATE_FIXTURE_RAW_RESPONSE'};
    await refresh.click();await until(async()=>/원인 기록이 없는/.test(await diagnostic.innerText()),'Unexpected diagnostic payload fails closed');
    assert.doesNotMatch(await setup.innerText(),/PRIVATE_FIXTURE_RAW_RESPONSE/);
    const priorFailure={version:1,stage:'host-commit',code:'RECOVERY_REQUIRED',recordedAt:Date.parse('2026-09-09T01:02:03Z'),providerCallPossible:true};
    state.automatic.last={state:'saved',localSaved:true,backupPending:true,failure:priorFailure};
    await refresh.click();await until(async()=>/선택한 완료 대화의 로컬 정리 완료/.test(await setup.innerText()),'Recovered receipt renders as success');
    assert.equal(await diagnostic.count(),0,'Historical diagnostics cannot describe a successful receipt as currently interrupted');
    assert.match(await setup.innerText(),/백업 대기/,'Pending backup remains separate from local success');
    state.automatic.last={state:'recovery-required',localSaved:true,backupPending:true,failure:priorFailure};
    await refresh.click();await until(async()=>/세션 후처리 확인이 필요/.test(await diagnostic.innerText()),'A committed receipt with unfinished cleanup still needs attention');
    assert.doesNotMatch(await diagnostic.innerText(),/AI가 호출되었을 수|단계에서 중단|원인 기록이 없는/,'Confirmed local success uses cleanup guidance, not ambiguous model failure guidance');
    state.automatic.last={state:'recovery-required',localSaved:false,historicalReceipt:true,recovery:'plan-needs-review',failure:null};
    await refresh.click();await until(async()=>/이전 저장의 완료 영수증은 있지만/.test(await diagnostic.innerText()),'A historical receipt does not prove completion in a changed root');
    assert.match(await diagnostic.innerText(),/현재 저장 완료로 판단하지 않고/);
    assert.doesNotMatch(await diagnostic.innerText(),/선택한 대화의 로컬 저장은 완료|원인 기록이 없는/);
    state.automatic.last={state:'saved',localSaved:true,failure:null};await refresh.click();
    await until(async()=>await diagnostic.count()===0,'Finishing the exact pending plan clears cleanup guidance');
    assert.equal(state.requests.filter(request=>request.automaticOperation&&request.automaticOperation!=='status').length,0,'Viewing a cause cannot retry AI, clear coverage, or change consent');
  },{automatic:true,completion:{},jobs:[]});
  await run('automatic-recovery-evidence-stays-with-target-and-grants-no-action',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    const refresh=setup.getByRole('button',{name:'상태 다시 확인',exact:true}),evidence=setup.getByTestId('memory-automatic-recovery-evidence');
    for(const [recovery,text] of [['no-retained-plan','재개할 근거가 없습니다'],['bound-plan','연결된 복구 계획이 있습니다'],['plan-needs-review','일부 기록이 없거나'],['unavailable','계획이 없다고 판단할 수 없으므로']]){
      state.automatic.last={state:'recovery-required',localSaved:false,failure:null,recovery};await refresh.click();
      await until(async()=>(await evidence.innerText()).includes(text),'The actual component must explain '+recovery);
      assert.match(await evidence.innerText(),/아직 검증하지 않았으며/);
    }
    state.automatic.last.recovery='bound-plan';await refresh.click();
    await until(async()=>(await evidence.innerText()).includes('연결된 복구 계획이 있습니다'),'Last known matching plan renders');
    state.automaticStatusFailures=1;await refresh.click();
    await until(async()=>(await evidence.innerText()).includes('계획이 없다고 판단할 수 없으므로'),'A failed fresh status must not present prior evidence as current');
    await refresh.click();await until(async()=>(await evidence.innerText()).includes('연결된 복구 계획이 있습니다'),'Fresh successful status restores checked evidence');
    state.automatic.last.recovery={message:'PRIVATE_RECOVERY_PAYLOAD'};await refresh.click();
    await until(async()=>await evidence.count()===0,'Unknown recovery fields must not render arbitrary content');
    assert.doesNotMatch(await setup.innerText(),/PRIVATE_RECOVERY_PAYLOAD/);
    let release;
    try{
      state.automatic.last={state:'recovery-required',localSaved:false,recovery:'bound-plan'};
      state.automaticStatusBarrier=new Promise(resolve=>{release=resolve;});await refresh.click();
      await until(()=>state.automaticStatusWaiting,'A status response must remain pending');
      state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
      await panel.getByLabel('터미널 프로젝트').selectOption(B);
      await until(()=>state.requests.some(r=>r.automaticOperation==='status'&&r.observationTargetId===B),'The new target gets its own status');
      if(!await setup.evaluate(node=>node.open))await setup.locator('summary').click();
      await until(async()=>(await evidence.innerText()).includes('재개할 근거가 없습니다'),'B evidence renders before old A resolves');
      release();await until(()=>!state.automaticStatusWaiting,'Old response settles');await sleep(50);
      assert.match(await evidence.innerText(),/재개할 근거가 없습니다/);assert.doesNotMatch(await evidence.innerText(),/연결된 복구 계획이 있습니다/);
    }finally{release?.();}
    assert.equal(state.requests.filter(r=>r.automaticOperation&&r.automaticOperation!=='status').length,0,'Evidence never enables saving, revalidates a provider, or replays the job');
    assert.equal(starts(state).length,0);
  },{automatic:true,completion:{},jobs:[]});
  await run('automatic-provider-transition-separates-probe-and-memory-consent',async({page,panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.provider={model:'claude-fixture-prepared',effort:'low',configurationId:'old-binding',preparedAt:1};
    state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    assert.equal(await setup.getByRole('button',{name:'같은 모델 연결 다시 확인 · AI 1회',exact:true}).isDisabled(),true);
    const start=setup.getByRole('button',{name:'CLI 연결 변경 검토 · AI 호출 없음',exact:true});await start.waitFor();
    assert.equal(state.requests.filter(r=>r.automaticOperation!=='status').length,0);
    let releaseReview,releaseVerify;
    try{
      state.providerReviewBarrier=new Promise(resolve=>{releaseReview=resolve;});await start.evaluate(button=>{button.click();button.click();});
      await until(()=>state.providerReviewWaiting,'A provider review is pending');
      assert.equal(state.requests.filter(r=>r.automaticOperation==='review-recovery-provider').length,1);
      releaseReview();const review=setup.getByTestId('memory-recovery-provider-review');await review.waitFor();
      assert.match(await review.innerText(),/연결 검사 AI 1회/);assert.match(await review.innerText(),/기억을 정리하지 않습니다/);
      const consent=review.getByRole('checkbox'),verify=review.getByRole('button',{name:'복구용 모델 연결 검사 · AI 1회',exact:true});
      assert.equal(await consent.isChecked(),false);assert.equal(await verify.isDisabled(),true);
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();assert.equal(await consent.isChecked(),false);
      await consent.check();state.providerVerifyBarrier=new Promise(resolve=>{releaseVerify=resolve;});await verify.evaluate(button=>{button.click();button.click();});
      await until(()=>state.providerVerifyWaiting,'Only the explicitly consented probe is waiting');
      assert.equal(state.requests.filter(r=>r.automaticOperation==='verify-recovery-provider').length,1);assert.equal(await review.count(),0);
      releaseVerify();await until(async()=>/복구용 모델 연결 검사 완료/.test(await setup.innerText()),'Ready proof is shown separately');
      assert.equal(state.automatic.provider.configurationId,'old-binding');assert.equal(state.automatic.revision,0);assert.equal(state.automatic.last.localSaved,false);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,0);
      await setup.getByRole('button',{name:'복구 조건 검사 · AI 호출 없음',exact:true}).click();
      const summary=setup.getByTestId('memory-automatic-recovery-review');await summary.waitFor();
      assert.equal(await summary.getByRole('checkbox').isChecked(),false,'Probe consent must not authorize memory summarization');
      assert.equal(await summary.getByRole('button',{name:'검증한 대화 다시 정리 · AI 1회',exact:true}).isDisabled(),true);
      await summary.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('workroom-provider-transition-125.png',output).pathname});
      const geometry=await setup.evaluate(node=>({right:node.getBoundingClientRect().right,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
      assert.ok(geometry.right<=geometry.width+1);assert.ok(geometry.scrollWidth<=geometry.width+1);
      assert.equal(state.requests.filter(r=>['prepare-provider','revalidate-provider','enable','disable','execute-recovery'].includes(r.automaticOperation)).length,0);
    }finally{releaseReview?.();releaseVerify?.();}
  },{automatic:true,automaticSettingsOnly:true,jobs:[]});
  await run('automatic-provider-transition-discards-stale-target-and-uncertain-approval',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    const start=setup.getByRole('button',{name:'CLI 연결 변경 검토 · AI 호출 없음',exact:true}),review=setup.getByTestId('memory-recovery-provider-review');
    let release;
    try{
      state.providerReviewBarrier=new Promise(resolve=>{release=resolve;});await start.click();await until(()=>state.providerReviewWaiting,'Old target review waits');
      await panel.getByLabel('터미널 프로젝트').selectOption(B);assert.equal(await review.count(),0);
      if(!await setup.evaluate(node=>node.open))await setup.locator('summary').click();
      release();await until(()=>!state.providerReviewWaiting,'Old review returns');
      await until(async()=>await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).isEnabled(),'The pending action slot is released');
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
      await until(()=>state.requests.some(r=>r.automaticOperation==='status'&&r.observationTargetId===B),'New target gets its own status');
      await sleep(40);assert.equal(await review.count(),0);
      await start.click();await review.waitFor();await review.getByRole('checkbox').check();
      state.providerVerifyError=true;await review.getByRole('button',{name:'복구용 모델 연결 검사 · AI 1회',exact:true}).click();
      await until(async()=>/Fixture provider probe response unavailable/.test(await setup.innerText()),'An uncertain result is visible');assert.equal(await review.count(),0);
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await sleep(40);
      assert.equal(await review.count(),0);assert.equal(state.requests.filter(r=>r.automaticOperation==='verify-recovery-provider').length,1);
      assert.match(await setup.getByTestId('memory-recovery-provider-status').innerText(),/미확정/);
      await start.click();await review.waitFor();assert.equal(await review.getByRole('checkbox').isChecked(),false);
      await panel.getByLabel('터미널 프로젝트').selectOption(A);await sleep(40);assert.equal(await review.count(),0);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='verify-recovery-provider').length,1);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,0);
    }finally{release?.();}
  },{automatic:true,automaticSettingsOnly:true,jobs:[]});
  await run('automatic-provider-transition-expiry-and-malformed-review-never-probe',async({page,panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    const start=setup.getByRole('button',{name:'CLI 연결 변경 검토 · AI 호출 없음',exact:true}),review=setup.getByTestId('memory-recovery-provider-review');
    for(const patch of [{additionalCalls:2},{binaryChanged:null},{targetId:'foreign-target'},{model:{raw:'PRIVATE_PROVIDER_TEXT'}},{expiresAt:-1},{reviewDigest:'bad'}]){
      state.providerReviewPatch=patch;await start.click();await until(async()=>/CLI 연결 변경 검토 결과를 확인하지 못했습니다/.test(await setup.innerText()),'Malformed approval cannot render');
      assert.equal(await review.count(),0);assert.doesNotMatch(await setup.innerText(),/PRIVATE_PROVIDER_TEXT/);
    }
    state.providerReviewPatch={};await start.click();await review.waitFor();await review.getByRole('checkbox').check();
    const verify=review.getByRole('button',{name:'복구용 모델 연결 검사 · AI 1회',exact:true});assert.equal(await verify.isEnabled(),true);
    await page.evaluate(deadline=>{window.__originalDateNow=Date.now;Date.now=()=>deadline;},state.lastProviderReview.expiresAt);
    try{await verify.evaluate(button=>button.click());await sleep(40);assert.equal(await review.count(),0);assert.equal(state.requests.filter(r=>r.automaticOperation==='verify-recovery-provider').length,0);}
    finally{await page.evaluate(()=>{Date.now=window.__originalDateNow;delete window.__originalDateNow;});}
  },{automatic:true,automaticSettingsOnly:true,jobs:[]});
  await run('automatic-successor-review-requires-exact-consent-and-one-explicit-execution',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    const reviewButton=setup.getByRole('button',{name:'복구 조건 검사 · AI 호출 없음',exact:true});await reviewButton.waitFor();
    assert.equal(state.requests.filter(r=>r.automaticOperation==='review-recovery'||r.automaticOperation==='execute-recovery').length,0);
    let releaseReview,releaseExecute;
    try{
      state.recoveryReviewBarrier=new Promise(resolve=>{releaseReview=resolve;});
      await reviewButton.evaluate(button=>{button.click();button.click();});await until(()=>state.recoveryReviewWaiting,'Review preflight is held');
      assert.equal(state.requests.filter(r=>r.automaticOperation==='review-recovery').length,1);assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,0);
      releaseReview();await until(()=>!state.recoveryReviewWaiting,'Review returns without executing AI');
      const review=setup.getByTestId('memory-automatic-recovery-review');await review.waitFor();assert.match(await review.innerText(),/완료 대화 2개/);assert.match(await review.innerText(),/미확정으로 보존/);assert.match(await review.innerText(),/1회가 추가/);
      const consent=review.getByRole('checkbox'),execute=review.getByRole('button',{name:'검증한 대화 다시 정리 · AI 1회',exact:true});
      assert.equal(await consent.isChecked(),false);assert.equal(await execute.isEnabled(),false);
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();assert.equal(await consent.isChecked(),false,'Status reads never grant approval');
      await consent.check();assert.equal(await execute.isEnabled(),true);
      state.recoveryExecuteBarrier=new Promise(resolve=>{releaseExecute=resolve;});await execute.evaluate(button=>{button.click();button.click();});
      await until(()=>state.recoveryExecuteWaiting,'The one explicitly approved request is pending');
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,1);assert.equal(await review.count(),0,'Approval disappears before awaiting an execution response');
      releaseExecute();await until(()=>!state.recoveryExecuteWaiting,'Execution response settles');
      await until(async()=>/선택한 완료 대화의 로컬 정리 완료/.test(await setup.innerText()),'New receipt renders as saved');
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await sleep(50);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,1);assert.equal(starts(state).length,0);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='prepare-provider'||r.automaticOperation==='revalidate-provider'||r.automaticOperation==='enable').length,0);
    }finally{releaseReview?.();releaseExecute?.();}
  },{automatic:true,completion:{},jobs:[]});
  await run('automatic-successor-stale-target-and-uncertain-response-never-reuse-approval',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    const reviewButton=setup.getByRole('button',{name:'복구 조건 검사 · AI 호출 없음',exact:true}),review=setup.getByTestId('memory-automatic-recovery-review');
    let release;
    try{
      state.recoveryReviewBarrier=new Promise(resolve=>{release=resolve;});await reviewButton.click();await until(()=>state.recoveryReviewWaiting,'Old target review remains pending');
      await panel.getByLabel('터미널 프로젝트').selectOption(B);await until(()=>state.requests.some(r=>r.automaticOperation==='status'&&r.observationTargetId===B),'B receives separate status');
      if(!await setup.evaluate(node=>node.open))await setup.locator('summary').click();
      release();await until(()=>!state.recoveryReviewWaiting,'Old A review returns');await sleep(50);assert.equal(await review.count(),0,'A approval must not appear on B');
      state.recoveryReviewError=true;await reviewButton.click();await until(async()=>/Fixture recovery conditions changed/.test(await setup.innerText()),'Failed preflight is shown');
      assert.equal(await review.count(),0);state.recoveryReviewError=false;
      await reviewButton.click();await review.waitFor();await review.getByRole('checkbox').check();
      state.recoveryExecuteError=true;await review.getByRole('button',{name:'검증한 대화 다시 정리 · AI 1회',exact:true}).click();
      await until(async()=>/Fixture recovery response unavailable/.test(await setup.innerText()),'Unknown execution response is shown');assert.equal(await review.count(),0);
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await sleep(50);
      assert.equal(await review.count(),0,'Status cannot restore consumed or possibly consumed approval');
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,1);assert.equal(state.requests.find(r=>r.automaticOperation==='execute-recovery').observationTargetId,B);
      await reviewButton.click();await review.waitFor();assert.equal(await review.getByRole('checkbox').isChecked(),false,'A fresh review still requires fresh consent');
      await panel.getByLabel('터미널 프로젝트').selectOption(A);await sleep(50);assert.equal(await review.count(),0);assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,1);
    }finally{release?.();}
  },{automatic:true,completion:{},jobs:[]});
  await run('automatic-successor-expiry-and-malformed-review-fail-before-execution',async({page,panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    state.automatic.enabled=true;state.automatic.last={state:'recovery-required',localSaved:false,recovery:'no-retained-plan'};
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    const reviewButton=setup.getByRole('button',{name:'복구 조건 검사 · AI 호출 없음',exact:true}),review=setup.getByTestId('memory-automatic-recovery-review');
    for(const patch of [{inputBytes:null},{parentAttemptId:null},{model:{raw:'PRIVATE_REVIEW_TEXT'}},{effort:'unknown'},{expiresAt:-1},{reviewDigest:'bad'}]){
      state.recoveryReviewPatch=patch;await reviewButton.click();await until(async()=>/복구 검토 결과를 확인하지 못했습니다/.test(await setup.innerText()),'Malformed review must fail closed');
      assert.equal(await review.count(),0);assert.equal(state.errors.length,0);assert.doesNotMatch(await setup.innerText(),/PRIVATE_REVIEW_TEXT/);
    }
    state.recoveryReviewPatch={};await reviewButton.click();await review.waitFor();const consent=review.getByRole('checkbox'),execute=review.getByRole('button',{name:'검증한 대화 다시 정리 · AI 1회',exact:true});
    await consent.check();assert.equal(await execute.isEnabled(),true);
    await page.evaluate(deadline=>{window.__originalDateNow=Date.now;Date.now=()=>deadline;},state.lastRecoveryReview.expiresAt);
    try{
      // Expire after render/consent, before the next 15-second poll. A stale DOM
      // button must still check expiry at the click boundary.
      await execute.evaluate(button=>button.click());await sleep(50);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,0,'Expiry must block even a previously enabled button');
      await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();await sleep(50);
      assert.equal(state.requests.filter(r=>r.automaticOperation==='execute-recovery').length,0);assert.equal(starts(state).length,0);
    }finally{await page.evaluate(()=>{Date.now=window.__originalDateNow;delete window.__originalDateNow;});}
  },{automatic:true,completion:{},jobs:[]});
  await run('automatic-status-recovery-restores-model-and-clears-only-connection-error',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    await until(async()=>/상태 확인에 실패/.test(await setup.innerText()),'Initial connection failure is visible');
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    await until(async()=>/Fixture status unavailable/.test(await setup.innerText()),'A manual status retry also reports a connection failure');
    await until(async()=>/등록 모델: claude-fixture-prepared/.test(await setup.innerText()),'Background polling recovers the registered model',20000);
    assert.equal(await setup.getByLabel('자동 기억 정리 모델 ID').inputValue(),'claude-fixture-prepared');
    assert.equal(await setup.getByLabel('자동 기억 정리 추론 수준').inputValue(),'medium');
    assert.equal(await setup.getByRole('alert').count(),0,'A recovered connection must clear its old error');
    await setup.getByRole('checkbox').check();assert.equal(await setup.getByRole('button',{name:'V2 자동 기억 정리 켜기',exact:true}).isEnabled(),true);
    assert.equal(state.requests.filter(r=>r.automaticOperation==='prepare-provider'||r.automaticOperation==='enable').length,0);
    state.automaticProviderError=true;await setup.getByRole('button',{name:'모델 연결 검사 · AI 1회',exact:true}).click();
    await until(async()=>/Fixture model connection refused/.test(await setup.innerText()),'Action failure is visible');
    const statusCount=state.requests.filter(r=>r.automaticOperation==='status').length;
    state.automatic.last={state:'waiting-idle',localSaved:false};
    await until(()=>state.requests.filter(r=>r.automaticOperation==='status').length>statusCount,'Background status follows the failed action',20000);
    await until(async()=>/최근 결과: 새 활동이 멈춘 뒤 정리 대기/.test(await setup.innerText()),'Recovered status has rendered before checking the action error');
    assert.match(await setup.innerText(),/Fixture model connection refused/,'Successful polling must preserve an unresolved user action error');
    return {automaticOperations:state.requests.filter(r=>r.automaticOperation).map(r=>r.automaticOperation)};
  },{automatic:true,automaticStatusFailures:2,automaticProvider:{model:'claude-fixture-prepared',effort:'medium',configurationId:'fixture-config',preparedAt:1},completion:{},keyStatus:'registered',jobs:[]});
  await run('automatic-revalidation-releases-its-slot-after-project-switch',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    await setup.getByRole('checkbox').check();await setup.getByRole('button',{name:'V2 자동 기억 정리 켜기',exact:true}).click();
    const revalidate=setup.getByRole('button',{name:'같은 모델 연결 다시 확인 · AI 1회',exact:true});await revalidate.waitFor();
    let release;state.revalidateBarrier=new Promise(resolve=>{release=resolve;});
    await revalidate.click();await until(()=>state.revalidateWaiting,'Explicit canary request is pending');
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    assert.equal(state.requests.filter(r=>r.automaticOperation==='revalidate-provider').length,1);
    release();await until(()=>!state.revalidateWaiting,'Old project canary has settled');
    const refresh=setup.getByRole('button',{name:'상태 다시 확인',exact:true});
    await until(()=>refresh.isEnabled(),'New project controls recover after the old request settles');
    await refresh.click();await until(()=>state.requests.some(r=>r.automaticOperation==='status'&&r.observationTargetId===B),'New project reads its own status');
    assert.equal(state.requests.filter(r=>r.automaticOperation==='revalidate-provider').length,1,'Target changes never repeat the AI call');
    assert.equal(await setup.getByRole('alert').count(),0);
  },{automatic:true,automaticSettingsOnly:true,automaticProvider:{model:'claude-fixture-prepared',effort:'medium',configurationId:'fixture-config',preparedAt:1},completion:{},keyStatus:'registered',jobs:[]});
  await run('automatic-recovery-preserves-a-model-draft-and-requires-fresh-consent',async({panel,state})=>{
    const setup=panel.getByTestId('memory-automatic-settings');await setup.locator('summary').click();
    await until(async()=>/상태 확인에 실패/.test(await setup.innerText()),'Initial connection failure');
    await setup.getByLabel('자동 기억 정리 모델 ID').fill('claude-fixture-user-draft');
    await setup.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    await until(async()=>/등록 모델: claude-fixture-prepared/.test(await setup.innerText()),'Status recovers without invoking a model');
    assert.equal(await setup.getByLabel('자동 기억 정리 모델 ID').inputValue(),'claude-fixture-user-draft');
    assert.equal(await setup.getByRole('checkbox').isChecked(),false);
    assert.equal(await setup.getByRole('button',{name:'V2 자동 기억 정리 켜기',exact:true}).isDisabled(),true);
    assert.equal(state.requests.filter(r=>r.automaticOperation==='prepare-provider'||r.automaticOperation==='enable').length,0);
  },{automatic:true,automaticStatusFailures:1,automaticProvider:{model:'claude-fixture-prepared',effort:'medium',configurationId:'fixture-config',preparedAt:1},completion:{},keyStatus:'registered',jobs:[]});
  await run('key-preparation-is-explicit-and-never-enables-ai-or-rotates-a-lost-key',async({page,panel,state})=>{
    const setup=panel.getByTestId('memory-key-setup');await setup.locator('summary').click();
    await until(async()=>/아직 준비하지/.test(await setup.innerText()),'Read-only key status must render');
    assert.equal(state.requests.filter(r=>r.keyOperation==='prepare').length,0);
    await setup.getByRole('button',{name:'암호화 키 준비',exact:true}).click();
    await setup.getByRole('button',{name:'Keychain 접근 확인',exact:true}).waitFor();
    assert.match(await setup.innerText(),/자동 저장이나 AI 호출이 켜지지 않습니다/);
    state.keyError='등록된 암호화 키가 없습니다. 기존 키를 Keychain에서 복원해야 합니다.';
    await setup.getByRole('button',{name:'Keychain 접근 확인',exact:true}).click();
    await until(async()=>/기존 키를 Keychain에서 복원/.test(await setup.innerText()),'A lost key must not be presented as new-key setup');
    assert.equal(state.requests.filter(r=>r.keyOperation==='recover-initial').length,0);
    assert.equal(state.requests.filter(r=>r.operation==='start').length,0);
    await setup.screenshot({path:new URL('workroom-memory-key-setup.png',output).pathname});
    return {keyOperations:state.requests.filter(r=>r.keyOperation).map(r=>r.keyOperation)};
  },{completion:{},keyStatus:'not-configured',jobs:[]});
  await run('completed-conversations-are-distinct-from-memory-save-and-backup',async({page,panel,state})=>{
    const completion=panel.getByTestId('workroom-completion-status');
    await until(async()=>/완료 대화 2건 확인/.test(await completion.innerText()),'Verified conversations must be visible without a save job');
    assert.match(await completion.innerText(),/장기기억 저장·백업 완료를 뜻하지 않습니다/);
    assert.match(await completion.innerText(),/자동 기억 정리는 아직 연결되지 않았습니다/);
    assert.equal(await panel.getByTestId('workroom-memory-history').count(),0);
    let release;state.memoryBarrier=new Promise(resolve=>{release=resolve;});
    await until(()=>state.memoryWaiting,'Hold the previous project response');
    const beforeSwitch=state.requests.filter(r=>r.path.endsWith('/memory')).length;
    await panel.getByLabel('터미널 프로젝트').selectOption(B);await sleep(100);
    assert.doesNotMatch(await completion.innerText(),/2건 확인/);
    assert.equal(state.requests.filter(r=>r.path.endsWith('/memory')).length,beforeSwitch,'Target switching must share the outstanding request slot');
    release();
    await until(async()=>/아직 완료 대화를 확인하지 못했습니다/.test(await completion.innerText()),'Project switch must not keep another project count');
    assert.doesNotMatch(await completion.innerText(),/2건 확인/);
    state.memoryError=true;
    await until(async()=>/갱신하지 못했습니다/.test(await completion.innerText()),'Read failure must not turn into a zero count');
    state.memoryError=false;state.completion={state:'unavailable'};
    await panel.getByRole('button',{name:'저장 상태 다시 확인'}).click();
    await until(async()=>/기록이 없다는 뜻은 아닙니다/.test(await completion.innerText()),'Unavailable observation must be distinguished from empty');
    await page.evaluate(()=>window.__setWorkroomVisible(false));await sleep(100);
    const requests=state.requests.filter(r=>r.path.endsWith('/memory')).length;await sleep(3200);
    assert.equal(state.requests.filter(r=>r.path.endsWith('/memory')).length,requests,'Hidden status has no polling');
    assert.equal(starts(state).length,0);
  },{jobs:[],completion:{}});

  await run('old-host-and-invalid-completion-status-do-not-claim-empty-or-saved',async({panel,state})=>{
    const completion=panel.getByTestId('workroom-completion-status');
    await until(async()=>/이 앱에서는 완료 대화 상태를 확인할 수 없습니다/.test(await completion.innerText()),'Older host must be identified as unsupported');
    state.completion={targetId:'foreign-target',completedTurns:999};
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    await until(()=>state.requests.some(r=>r.observationTargetId===B),'Changed scope must be requested');await sleep(150);
    assert.match(await completion.innerText(),/이 앱에서는 완료 대화 상태를 확인할 수 없습니다/);
    assert.doesNotMatch(await completion.innerText(),/999/);
  },{jobs:[]});

  await run('empty-session-starts-with-compact-composer',async({page,panel,state})=>{
    await panel.getByTestId('workroom-memory-history').waitFor();
    assert.equal(await panel.locator('.xterm,.ai-terminal-surface,.ai-terminal-keys').count(),0,'Empty workrooms must not allocate or display an inert terminal');
    assert.ok(await panel.getByText('프로젝트·워크트리',{exact:true}).isVisible());assert.ok(await panel.getByText('AI',{exact:true}).isVisible());
    assert.ok(await panel.getByLabel('터미널에 전달할 작업').isVisible());assert.ok(await panel.getByRole('button',{name:'새 터미널',exact:true}).isEnabled());
    assert.equal(await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).count(),0);
    assert.equal(await panel.getByTestId('workroom-memory-history').getAttribute('open'),null);assert.equal(await panel.locator('.ai-terminal-memory-row').count(),0);
    const help=panel.locator('.ai-terminal-memory-help');assert.equal(await help.getAttribute('open'),null);assert.equal(starts(state).length,0);
    await layout(page,panel);await page.screenshot({path:new URL('workroom-usability-empty-1000-125.png',output).pathname});
  });

  await run('unselected-and-ended-sessions-remain-compact-and-read-only',async({panel,state})=>{
    await until(async()=>await panel.getByRole('tab').count()===1,'Running session should be selectable without opening a terminal');
    assert.equal(await panel.locator('.xterm,.ai-terminal-surface,.ai-terminal-keys').count(),0);
    await panel.getByRole('button',{name:/종료된 세션 보기/}).click();
    await panel.getByRole('tab').filter({hasText:/종료 0/}).click();await panel.locator('.xterm').waitFor();
    const endedNotice=panel.getByText(/터미널이 종료되었습니다 \(종료 코드 0\)/);
    await endedNotice.waitFor();assert.ok(await endedNotice.isVisible());
    for(const label of ['Enter','Ctrl+C','세션 종료'])assert.ok(await panel.getByRole('button',{name:label,exact:true}).isDisabled());
    assert.equal(state.requests.filter(r=>['start','input','resize','close'].includes(r.operation)).length,0);
  },{sessions:[session(SA,A),session(SE,B,'exited')],jobs:[]});

  await run('attention-is-visible-and-history-is-progressively-revealed',async({page,panel})=>{
    const urgent=panel.getByTestId('workroom-memory-attention'),history=panel.getByTestId('workroom-memory-history');
    await until(async()=>await urgent.getByRole('listitem').count()===5,'Attention must begin with five grouped rows');
    assert.ok(await urgent.getByRole('listitem').filter({hasText:'기억 A'}).filter({hasText:'세션 기억 저장 실패'}).isVisible(),'A failed job before the last 45 successful jobs must not disappear');
    await layout(page,panel);await urgent.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('workroom-usability-attention-1000-125.png',output).pathname});
    assert.match(await history.locator('summary').innerText(),/완료된 저장 기록 45건 · 2개 상태/);assert.equal(await history.getByRole('listitem').count(),0);
    await urgent.getByRole('button',{name:/확인할 상태 더 보기/}).click();assert.equal(await urgent.getByRole('listitem').count(),7);
    for(const label of ['종료 후 저장 대기','세션 기억 저장 중','장기기억 초기화 필요','백업 확인 필요'])assert.ok((await urgent.innerText()).includes(label));
    await history.locator('summary').click();await until(async()=>await history.getByRole('listitem').count()===2,'Opening history should render two grouped states');
    await history.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('workroom-usability-history-open-1000-125.png',output).pathname});
    await history.locator('summary').click();await until(async()=>await history.getByRole('listitem').count()===0,'Collapsing history must remove the completed rows from the UI');
  },{jobs:[...attention,...completed]});

  await run('memory-pages-keep-recovery-visible-with-bounded-requests',async({panel,state})=>{
    const pages=panel.getByRole('navigation',{name:'세션 저장 기록 페이지'});
    await pages.waitFor();
    assert.ok((await panel.innerText()).includes('이전 작업·저장 결과 확인 후 복구 필요'));
    assert.match(await pages.innerText(),/전체 300건.*미해결 300건.*현재 페이지 128건/s);
    await pages.getByRole('button',{name:'다음 기록'}).click();
    await until(()=>state.requests.some(r=>r.path.endsWith('/memory')&&r.offset===128),'Second page must be fetched');
    await pages.getByRole('button',{name:'다음 기록'}).click();
    await until(async()=>/현재 페이지 44건/.test(await pages.innerText()),'Final page must stay bounded');
    assert.ok(await pages.getByRole('button',{name:'다음 기록'}).isDisabled());
    await pages.getByRole('button',{name:'이전 기록'}).click();
    await until(async()=>/현재 페이지 128건/.test(await pages.innerText()),'Previous page must reload');
    assert.equal(state.requests.filter(r=>['start','input','close'].includes(r.operation)).length,0);
  },{paginated:true,jobs:Array.from({length:300},(_,i)=>({sessionId:`fixture-page-${i}`,targetId:A,state:i===0?'recovery-required':'failed'}))});

  await run('memory-status-failure-preserves-existing-jobs-and-recovers',async({page,panel,state})=>{
    const urgent=panel.getByTestId('workroom-memory-attention'),history=panel.getByTestId('workroom-memory-history');await urgent.waitFor();
    const before=await urgent.innerText();state.memoryError=true;
    await page.evaluate(()=>window.__setWorkroomVisible(false));await sleep(30);await page.evaluate(()=>window.__setWorkroomVisible(true));
    await panel.getByRole('alert').filter({hasText:'세션 저장 상태를 확인하지 못했습니다'}).waitFor();
    assert.equal(await urgent.innerText(),before);assert.match(await history.locator('summary').innerText(),/45건/);
    await page.setViewportSize({width:800,height:1050});await layout(page,panel);await panel.getByRole('alert').scrollIntoViewIfNeeded();await page.screenshot({path:new URL('workroom-usability-memory-error-800-125.png',output).pathname});
    state.memoryError=false;await panel.getByRole('button',{name:'저장 상태 다시 확인',exact:true}).click();
    await until(async()=>await panel.getByRole('alert').count()===0,'Retry should clear the status warning');assert.equal(await urgent.innerText(),before);
    const live=panel.getByRole('region',{name:'세션 저장'}).getByRole('status',{name:'종료 후 저장 요약'});const previousAnnouncement=await live.innerText();
    state.jobs.find(job=>job.state==='saving').state='failed';
    await page.evaluate(()=>window.__setWorkroomVisible(false));await sleep(30);await page.evaluate(()=>window.__setWorkroomVisible(true));
    await until(async()=>await live.innerText()!==previousAnnouncement,'A saving → failed transition must announce even when the total job count is unchanged');
    assert.match(await live.innerText(),/세션 기억 저장 실패 · 확인 필요 3건/);assert.doesNotMatch(await live.innerText(),/세션 기억 저장 중/);
  },{jobs:[...attention,...completed]});

  await run('current-context-and-new-target-keep-cli-and-draft-on-failure',async({page,panel,state})=>{
    await panel.locator('.xterm').waitFor();await panel.getByLabel('터미널 프로젝트').selectOption(B);await panel.getByLabel('터미널 AI').selectOption('claude');
    const draft='선택한 워크트리에서 한글 작업을 검토해 주세요. 기존 변경은 보존합니다.';await panel.getByLabel('터미널에 전달할 작업').fill(draft);
    await panel.getByRole('button',{name:'작업 요청 접기',exact:true}).click();
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').count(),0);assert.ok(await panel.getByRole('button',{name:'작성 중인 요청 다시 보기',exact:true}).isVisible());
    await panel.getByLabel('터미널 AI').selectOption('hermes');assert.ok(await panel.getByTestId('workroom-prompt-support').isVisible());assert.ok(await panel.getByRole('button',{name:'새 터미널',exact:true}).isDisabled());
    await panel.getByLabel('터미널 AI').selectOption('claude');await panel.getByRole('button',{name:'작성 중인 요청 다시 보기',exact:true}).click();assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),draft);
    const context=await panel.getByTestId('workroom-target-context').innerText();assert.ok(context.includes(`현재 세션: ${projects[0].label}`)&&context.includes(`새 터미널: ${projects[1].label}`));
    await panel.getByRole('button',{name:'프로젝트·장기기억',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__workroomActions),[{action:'manage',id:A}]);
    state.startError=true;await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();await panel.getByRole('alert').filter({hasText:'Fixture CLI start refused'}).waitFor();
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),draft);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);
    assert.equal(starts(state).length,1);assert.deepEqual([starts(state)[0].targetId,starts(state)[0].agent,starts(state)[0].prompt],[B,'claude',draft]);
    state.startError=false;await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();
    await until(async()=>/기억 B/.test(await panel.getByRole('tab',{selected:true}).innerText()),'Retry should select the new session on B');assert.equal(starts(state).length,2);
    assert.deepEqual([starts(state)[1].targetId,starts(state)[1].agent,starts(state)[1].prompt],[B,'claude',draft]);
  },{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA,prompt:'전달받은 초안',agent:'codex'},listDelayMs:150,jobs:[]});

  await run('unknown-target-and-unsupported-prompt-never-launch',async({panel,state})=>{
    const draft=panel.getByLabel('터미널에 전달할 작업'),start=panel.getByRole('button',{name:'새 터미널',exact:true});
    assert.equal(await draft.inputValue(),'보존해야 할 전달 작업');assert.ok(await start.isDisabled());assert.ok((await panel.getByLabel('터미널 프로젝트').innerText()).includes('프로젝트 연결 확인 필요'));
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    for(const agent of ['hermes','agy']){await panel.getByLabel('터미널 AI').selectOption(agent);assert.ok(await start.isDisabled());assert.ok(await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).isDisabled());assert.equal(await draft.inputValue(),'보존해야 할 전달 작업');assert.ok((await panel.getByTestId('workroom-prompt-support').innerText()).includes('입력한 내용은 유지됩니다'));}
    assert.equal(starts(state).length,0);await panel.getByLabel('터미널 AI').selectOption('claude');assert.ok(await start.isEnabled());
    await draft.fill('');await panel.getByLabel('터미널 AI').selectOption('hermes');assert.ok(await start.isEnabled());await start.click();
    await until(()=>starts(state).length===1,'An empty interactive Hermes launch should be allowed');assert.equal(starts(state)[0].agent,'hermes');assert.equal(starts(state)[0].targetId,B);assert.equal(starts(state)[0].prompt,undefined);
  },{entry:{nonce:1,targetId:'fixture-missing-project',prompt:'보존해야 할 전달 작업'},jobs:[]});

  await run('save-recovery-prepares-the-correct-project-without-executing',async({page,panel,state})=>{
    const urgent=panel.getByTestId('workroom-memory-attention');await urgent.waitFor();
    await urgent.getByRole('button',{name:'워크룸에서 이어서 확인',exact:true}).click();
    assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'codex');
    assert.match(await panel.getByLabel('터미널에 전달할 작업').inputValue(),/세션 기억 저장/);assert.equal(starts(state).length,0);
    await panel.getByRole('button',{name:'프로젝트·장기기억',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__workroomActions),[{action:'manage',id:'fixture-project-bravo'}]);
  },{jobs:[{sessionId:'fixture-recovery-old',targetId:B,state:'failed'},...completed]});

  for(const active of [false,true])await run(`${active?'active':'empty'}-fits-default-and-minimum-window-at-125-percent`,async({page,panel})=>{
    if(active)await panel.locator('.xterm').waitFor();else await panel.getByTestId('workroom-memory-history').waitFor();
    for(const width of [1000,800]){await page.setViewportSize({width,height:1050});await sleep(80);await layout(page,panel);await panel.scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`workroom-usability-${active?'active':'empty'}-${width}-125.png`,output).pathname});}
    return{viewports:['1000×1050','800×1050'],zoom:'125%',sidebarLogicalWidth:264};
  },active?{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]}:{jobs:completed});

  await run('mobile-390-pixel-controls-fit-without-tall-selects',async({page,panel,state})=>{
    const boxes=await panel.locator('select').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{height:r.height,left:r.left,right:r.right};}));
    assert.equal(boxes.length,2);assert.ok(boxes.every(box=>box.height>=44&&box.height<=56&&box.left>=0&&box.right<=390),JSON.stringify(boxes));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Mobile controls must not cause horizontal page overflow');
    assert.equal(state.requests.filter(r=>r.path!=='/api/agent-runtime/terminals').length,0,'Remote view must use only the mocked terminal transport');
    await page.screenshot({path:new URL('workroom-usability-mobile-390.png',output).pathname});return{width:390,selectHeights:boxes.map(box=>box.height)};
  },{remote:true,jobs:[]});

  await run('remote-memory-button-prepares-reviewed-draft-and-preserves-existing-text',async({panel,state})=>{
    await panel.getByTestId('workroom-remote-remember-session').click();
    const draft=panel.getByLabel('터미널에 전달할 작업');
    assert.match(await draft.inputValue(),/remember-session/);
    assert.ok(await panel.getByTestId('workroom-remote-memory-guide').isVisible());
    assert.equal(starts(state).length,0,'Opening a memory request never starts AI');
    await draft.fill('먼저 작성한 요청을 그대로 유지해 주세요.');
    await panel.getByTestId('workroom-remote-remember-session').click();
    assert.equal(await draft.inputValue(),'먼저 작성한 요청을 그대로 유지해 주세요.');
    assert.equal(starts(state).length,0);
    await draft.fill('');await panel.getByTestId('workroom-remote-remember-session').click();
    const expected=await draft.inputValue();
    await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();
    await until(()=>starts(state).length===1,'Explicit reviewed start sends one request');
    assert.equal(starts(state)[0].targetId,A);assert.equal(starts(state)[0].prompt,expected);
    assert.equal(state.requests.filter(r=>r.path!=='/api/agent-runtime/terminals').length,0,'Memory draft must not introduce remote memory APIs');
  },{remote:true,jobs:[]});

  await run('initial-request-byte-limit-preserves-multibyte-input',async({panel,state})=>{
    const draft=panel.getByLabel('터미널에 전달할 작업');
    await draft.fill('가'.repeat(8001));
    assert.ok(await panel.getByRole('button',{name:'새 터미널',exact:true}).isDisabled());
    assert.equal((await draft.inputValue()).length,8001);assert.equal(starts(state).length,0);
    await draft.fill('가'.repeat(8000));
    assert.ok(await panel.getByRole('button',{name:'새 터미널',exact:true}).isEnabled());
  },{jobs:[]});

  await run('bounded-app-shell-keeps-keys-and-memory-separate-and-reachable',async({page,panel,state})=>{
    await panel.locator('.xterm').waitFor();await panel.getByTestId('workroom-memory-history').waitFor();
    const measurements=[];
    for(const [width,height] of [[1440,1050],[1000,1050],[800,1050],[1000,700]]){
      await page.setViewportSize({width,height});await sleep(100);
      const scroller=page.locator('#top-level-terminal-panel');await scroller.evaluate(node=>node.scrollTop=0);
      const before=await verticalGeometry(panel);
      await page.screenshot({path:new URL(`workroom-usability-app-shell-${width}x${height}-125.png`,output).pathname});
      const gutter=await scroller.boundingBox();await page.mouse.move(gutter.x+gutter.width-3,gutter.y+gutter.height/2);await page.mouse.wheel(0,1600);await sleep(160);
      const scrollTop=await scroller.evaluate(node=>node.scrollTop);measurements.push({width,height,stage:'collapsed',...before,afterWheelScrollTop:scrollTop});
      await writeFile(new URL('workroom-usability-app-shell-geometry.json',output),JSON.stringify(measurements,null,2)+'\n');
      assertVerticalGeometry(before);
      if(before.scrollHeight>before.clientHeight+2)assert.ok(scrollTop>0,'A wheel over the app gutter must scroll the bounded tab panel');
      await panel.getByRole('button',{name:'세션 종료',exact:true}).click({trial:true,timeout:2000});
      const inputCount=state.requests.filter(request=>request.operation==='input').length;
      await panel.getByRole('button',{name:'Enter',exact:true}).click({timeout:2000});
      await until(()=>state.requests.filter(request=>request.operation==='input').length===inputCount+1,'The visible Enter key must reach only the fixture terminal');
      assert.equal(state.requests.filter(request=>request.operation==='input').at(-1).data,'\r');
      const history=panel.getByTestId('workroom-memory-history');await history.locator('summary').click({timeout:2000});
      await until(async()=>await history.getByRole('listitem').count()===2,'Grouped memory history must remain clickable below the keys');
      const expandedHistory=await verticalGeometry(panel);assertVerticalGeometry(expandedHistory);measurements.push({width,height,stage:'history-expanded',...expandedHistory});
      await history.locator('summary').click();await until(async()=>await history.getByRole('listitem').count()===0,'History must collapse after the click');
      await panel.getByRole('button',{name:'새 작업 요청 작성',exact:true}).click();await panel.getByLabel('터미널에 전달할 작업').waitFor();
      const expandedComposer=await verticalGeometry(panel);assertVerticalGeometry(expandedComposer);measurements.push({width,height,stage:'composer-expanded',...expandedComposer});
      await panel.getByRole('button',{name:'세션 종료',exact:true}).click({trial:true,timeout:2000});
      await page.screenshot({path:new URL(`workroom-usability-app-shell-bottom-${width}x${height}-125.png`,output).pathname});
      await panel.getByRole('button',{name:'작업 요청 접기',exact:true}).click();
    }
    await writeFile(new URL('workroom-usability-app-shell-geometry.json',output),JSON.stringify(measurements,null,2)+'\n');
    assert.equal(state.requests.filter(request=>request.operation==='close').length,0,'Close hit testing must not terminate even a fixture session');return{measurements};
  },{appShell:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:completed});
}finally{await browser.close();await writeFile(new URL(focusedCase?'workroom-usability-focused-results.json':'workroom-usability-results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+'\n');}
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} Workroom usability groups passed`);
if(results.some(result=>result.status==='failed'))process.exitCode=1;
