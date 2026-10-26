/** Real Workroom React+xterm in a 264px-sidebar shell at the saved 125% zoom.
 * Start Vite on 127.0.0.1:9000, then: node tests/workroom-usability.e2e.mjs
 * Every API is mocked; no actual PTY, project, saved memory, or external service
 * is accessed. These Chromium checks do not claim native macOS verification.
 */
import assert from 'node:assert/strict';
import {workroomBackgroundResponse} from './fixtures/workroom-runtime-background-mocks.mjs';
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
function Harness(){const [visible,setVisible]=React.useState(true);window.__setWorkroomVisible=setVisible;
 // The phone portal: \`onScreen\` — the Workroom is the pane on screen; \`visible\` also drops while its projects load (w7 review).
 const [onScreen,setOnScreen]=React.useState(true);window.__setWorkroomOnScreen=setOnScreen;
 // The phone portal re-renders on every status poll with a freshly mapped projects array.
 const [,setTick]=React.useState(0);React.useEffect(()=>{if(!${options.rerenderMs??0})return;const t=setInterval(()=>setTick(x=>x+1),${options.rerenderMs??0});return()=>clearInterval(t);},[]);const [entry,setEntry]=React.useState(${JSON.stringify(options.entry??null)});window.__setWorkroomEntry=setEntry;
 const workroom=React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},visible,remote:${!!options.remote},sessionFullscreen:${!!options.sessionFullscreen},...(${!!options.sessionFullscreen}?{onScreen}:{}),workspaceTransport:request=>fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json()),entry,sessionScope:'workroom-usability-fixture',onManageProject:id=>window.__workroomActions.push({action:'manage',id}),onWhatISaid:()=>window.__workroomActions.push({action:'what-i-said'})});
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
  // Site data blocked: the sessionStorage getter itself throws, as Safari does (w4 L2).
  if(options.blockSessionStorage)await context.addInitScript(()=>{Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new DOMException('The operation is insecure.','SecurityError');}});});
  if(options.localStorageSeed)await context.addInitScript(seed=>{for(const [key,value] of Object.entries(seed))localStorage.setItem(key,value);},options.localStorageSeed);
  if(options.sessionStorageSeed)await context.addInitScript(seed=>{for(const [key,value] of Object.entries(seed))sessionStorage.setItem(key,value);},options.sessionStorageSeed);
  // Storage that still reads but refuses every write (quota full): registered after the seed, so the seed is there (w4 review, finding 3).
  if(options.fullSessionStorage)await context.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===window.sessionStorage)throw new DOMException('The quota has been exceeded.','QuotaExceededError');return original.call(this,key,value);};});
  const state={sessions:structuredClone(options.sessions??[]),jobs:structuredClone(options.jobs??completed),requests:[],errors:[],blocked:[],shell:null,shellWrites:[],memoryError:false,startError:false,completion:options.completion??null,keyStatus:options.keyStatus??null,keyError:null,automaticStatusFailures:options.automaticStatusFailures??0,automaticProviderError:false,automatic:options.automatic?{version:1,targetId:A,supported:true,revision:0,enabled:false,excluded:false,scope:'project',inScope:true,provider:options.automaticProvider??null,last:null,backup:{pending:0,blocked:0,hasMore:false}}:null};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__workroom-usability')return route.fulfill({contentType:'text/html',body:html(options)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON();state.requests.push({path:url.pathname,...body});
    const respond=async(json,status=200)=>{try{return await route.fulfill({json,status});}catch(error){if(String(error).includes('object has been collected'))return;throw error;}};
    const background=workroomBackgroundResponse(url.pathname,request.method(),body);
    if(background)return respond(background);
    if(url.pathname==='/api/agent-runtime/targets')return respond({protocolVersion:'agentstoz-tasks-v2',targets:projects,complete:true});
    // The Codex footer reads the weekly allowance from the Mac's account endpoint.
    if(url.pathname==='/api/ai-usage/codex')return respond({rateLimits:{primary:{used_percent:40,window_minutes:10080,resets_at:1790813143},secondary:null},source:'live-app-server'});
    if(url.pathname==='/api/agent-runtime/terminals/access')return respond({connections:[]});
    if(url.pathname==='/api/agent-runtime/voice-settings'&&request.method()==='POST'&&JSON.stringify(body)===JSON.stringify({operation:'status'}))return respond({supported:true,configured:false,model:'gemini-3.8-live',checkedAt:null,checkedModel:null});
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
      if(body.operation?.startsWith('shell.')){
        if(body.operation==='shell.start')state.shell={id:'fixture-shell-1234',workroomSessionId:body.sessionId,targetId:body.targetId,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:body.cols,rows:body.rows,aiAllowed:false};
        if(body.operation==='shell.allow-ai')state.shell.aiAllowed=body.enabled;
        if(body.operation==='shell.input')state.shellWrites.push(body.data);
        if(body.operation==='shell.close')state.shell=null;
        if(body.operation==='shell.read')return respond({shell:state.shell,chunks:state.shellWrites.length&&body.after===0?[{seq:1,text:state.shellWrites.join('')}]:[],nextCursor:state.shellWrites.length?1:0,hasMore:false,truncated:false});
        return respond({shell:state.shell});
      }
      if(body.operation==='workspace'){
        // 「에포트 자동」 (w16): this fixture answers like a sidecar that predates it; tests/workroom-effort-auto.e2e.mjs covers it.
        if(body.workspace.action==='workroom.effort')return respond({error:'모바일 작업 요청 형식이 올바르지 않습니다.'},400);
        assert.equal(body.workspace.action,'workroom.status');
        const selected=state.sessions.find(current=>current.id===body.workspace.sessionId);assert.ok(selected,'Status belongs to a fixture session');
        assert.equal(body.targetId,selected.targetId);
        return respond({kind:'workspace',action:'workroom.status',workroom:{sessionId:selected.id,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}});
      }
      if(body.operation==='list'){if(options.listDelayMs)await sleep(options.listDelayMs);return respond({sessions:state.sessions,...(options.launchHost&&body.capabilities?{features:['terminal-submission-v1','terminal-start-submission-v1',...(options.noRecent?[]:['terminal-submission-recent-v1'])]}:{})});}
      // terminal-start-submission-v1: a new session's first request as a receipt-fenced submission (no sessionId).
      if(options.launchHost&&body.operation==='submission'){
        const sub=body.submission;state.launches??=new Map(Object.entries(structuredClone(options.launches??{})));
        const receipt=(id,entry)=>({id,storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:entry.state,sessionId:entry.sessionId,targetId:entry.targetId,agent:entry.agent});
        if(body.sessionId!==undefined){if(sub.phase==='recent')return respond({submissions:[]});
          // `keptReceipts`: a session-level receipt the host still keeps (by id, under the session it named).
          const kept=options.keptReceipts?.[sub.id];
          if(sub.phase==='status'&&kept&&kept.sessionId===body.sessionId)return respond({submission:{id:sub.id,storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:kept.state}});
          // `holdSessionSubmission`: a whole-request submission into a running session that is still on its way (w11 review).
          if(options.holdSessionSubmission&&sub.phase==='single'){state.sessionSubmitWaiting=true;await (state.sessionSubmitBarrier??Promise.resolve());state.sessionSubmitWaiting=false;
            return respond({submission:{id:sub.id,storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:'written'}});}
          return respond({error:'같은 호스트 저장소의 제출 기록을 확인하지 못했습니다.'},404);}
        // An older Mac forwarding to this one cannot parse a launch or `recent` at all (its own normalizer runs first).
        if(options.oldForwarder&&(sub.phase==='recent'||sub.launch))return respond({error:'터미널 세션 ID가 올바르지 않습니다.'},400);
        if(sub.phase==='recent')return respond({submissions:[...state.launches].filter(([,e])=>!['written','rejected'].includes(e.state)).map(([id,e])=>receipt(id,e)).reverse()});
        if(sub.phase==='status'){
          // The network is still down for the first status after a lost launch answer.
          if(options.loseFirstStatus&&!state.lostStatusOnce){state.lostStatusOnce=true;return respond({error:'Fixture: status lost'},503);}
          const entry=state.launches.get(sub.id);if(!entry)return respond({error:'같은 호스트 저장소의 제출 기록을 확인하지 못했습니다.'},404);
          return respond({submission:receipt(sub.id,entry),...(entry.state==='written'?{session:state.sessions.find(x=>x.id===entry.sessionId)}:{})});}
        assert.equal(sub.phase,'single');assert.ok(sub.launch&&projects.some(p=>p.targetId===sub.launch.targetId),'A launch names a registered target');
        const existing=state.launches.get(sub.id);if(existing)return respond({submission:receipt(sub.id,existing),session:state.sessions.find(x=>x.id===existing.sessionId)});
        // A definitive refusal before the spawn fence: the host records it as rejected and answers with the reason.
        if(options.refuseLaunch){state.launches.set(sub.id,{state:'rejected',sessionId:'fixture-never-started',targetId:sub.launch.targetId,agent:sub.launch.agent});return respond({error:options.refuseLaunch},500);}
        // The outcome stays unknown for this target (the host could not tell whether the CLI took the request).
        if(options.unknownLaunchTarget===sub.launch.targetId){state.launches.set(sub.id,{state:'unknown',sessionId:'fixture-launched-unknown',targetId:sub.launch.targetId,agent:sub.launch.agent});return respond({submission:receipt(sub.id,state.launches.get(sub.id))});}
        const created=session(`fixture-launched-${state.sessions.length}`,sub.launch.targetId,'running',sub.launch.agent);state.sessions.push(created);
        state.launches.set(sub.id,{state:'written',sessionId:created.id,targetId:sub.launch.targetId,agent:sub.launch.agent});
        // The CLI started; its answer is still on the way (a relay round trip) — the panel is mid-start.
        if(state.launchBarrier){const wait=state.launchBarrier;state.launchBarrier=null;state.launchWaiting=true;await wait;state.launchWaiting=false;}
        // The answer is lost on the way back (relay result unreachable): the CLI started, the panel did not hear it.
        if(options.loseLaunchAnswer&&!state.lostOnce){state.lostOnce=true;return respond({error:'Fixture: launch answer lost'},503);}
        return respond({submission:receipt(sub.id,state.launches.get(sub.id)),session:created});
      }
      if(body.operation==='accounts'){
        assert.equal(body.accountAction,'list');assert.ok(['codex','claude'].includes(body.agent));
        if(!projects.some(project=>project.targetId===body.targetId))return respond({error:'Fixture project is not registered'},404);
        return respond({accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}});
      }
      if(body.operation==='start'){
        if(state.startError)return respond({error:'Fixture CLI start refused'},503);
        // A Mac that predates references on start refuses the unknown key before starting anything.
        if(options.startRejectsReferences&&body.references)return respond({error:'허용되지 않은 터미널 요청입니다.'},400);
        // A Mac built before 2026-09-22 took a first request only for Codex and Claude.
        if(options.startRejectsPrompt&&body.prompt!==undefined)return respond({error:'이 AI에 전달할 수 없는 작업 요청입니다.'},400);
        assert.ok(projects.some(project=>project.targetId===body.targetId),'Only invented runtime target IDs are allowed');
        const created=session(`fixture-started-${state.sessions.length}`,body.targetId,'running',body.agent);state.sessions.push(created);
        // The CLI started but the answer was lost on the way back (an older host without launch receipts).
        if(options.loseStartAnswer&&!state.lostStartOnce){state.lostStartOnce=true;return respond({error:'Fixture: start answer lost'},503);}
        if(state.startBarrier){const wait=state.startBarrier;state.startBarrier=null;state.startWaiting=true;await wait;state.startWaiting=false;}
        return respond({session:created});
      }
      const selected=state.sessions.find(current=>current.id===body.sessionId);assert.ok(selected,'Unknown fixture terminal');
      // `screens`: what a session's CLI shows (e.g. a trust prompt); the rest show one fixture line.
      if(body.operation==='read')return respond({session:selected,chunks:body.after<1?[{seq:1,text:options.screens?.[selected.id]??'FIXTURE_ONLY_TERMINAL_OUTPUT\r\n'}]:[],nextCursor:Math.max(1,body.after),truncated:false,hasMore:false});
      if(body.operation==='close'){selected.state='exited';selected.exitCode=143;return respond({session:selected});}
      if(['input','resize'].includes(body.operation)){
        if(body.operation==='input'&&state.inputBarrier){const wait=state.inputBarrier;state.inputBarrier=null;state.inputWaiting=true;await wait;state.inputWaiting=false;}
        return respond({session:selected});
      }
    }
    // Workroom @ → desktop app (src/workroomAppRoute.ts). Only the local Mac panel may call it.
    if(url.pathname==='/api/agent-runtime/app-dispatch'){
      assert.ok(!options.remote,'A phone panel never reaches the app dispatch');
      const reply=options.appDispatch?.[body.agent]??{json:{success:true,agent:body.agent,targetId:body.targetId}};
      return respond(reply.json,reply.status??200);
    }
    state.blocked.push(`${request.method()} ${url.pathname}`);return respond({error:'Unmocked API is forbidden'},503);
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  await page.goto(`${origin}/__workroom-usability`);const panel=page.getByTestId('ai-terminal-panel');await panel.waitFor({timeout:10000});
  await until(()=>options.automaticSettingsOnly?state.requests.some(r=>r.automaticOperation==='status'):state.requests.some(r=>r.operation==='list')&&(options.remote||state.requests.some(r=>r.path.endsWith('/memory'))),'Initial fixture reads must occur');
  // A phone panel keeps the project picker in its 「새 작업」 sheet (w11): it renders when the sheet opens.
  if(!options.sessionFullscreen)await until(async()=>await panel.getByLabel('터미널 프로젝트').locator('option').count()>=3,'The two selectable runtime targets must render');
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
  assert.deepEqual(f.state.blocked,[],'Every API must be a fixture; external traffic is forbidden: '+JSON.stringify(f.state.blocked.slice(0,3)));assert.deepEqual(f.state.errors,[],'The actual component must not throw');
  results.push({name,status:'passed',...details});console.log(`PASS ${name}`);
}catch(error){results.push({name,status:'failed',error:error.message});console.error(`FAIL ${name}: ${error.message}`);await f?.page.screenshot({path:new URL(`workroom-usability-${name}-failed.png`,output).pathname,fullPage:true}).catch(()=>{});
}finally{await f?.context.close();}}

try{
  await run('bottom-shared-shell-user-and-ai-toggle',async({page,panel,state})=>{
    const section=panel.getByTestId('workroom-shared-shell');
    await section.getByRole('button',{name:'하단 터미널 펼치기'}).click();
    await section.getByRole('button',{name:'터미널 시작'}).click();
    await until(()=>state.shell?.state==='running','Local shell starts for the selected AI session');
    await section.getByRole('button',{name:'여기에 입력'}).click();
    await page.keyboard.type('pwd');await page.keyboard.press('Enter');
    await until(()=>state.shellWrites.join('').includes('pwd'),'User input reaches the shell PTY');
    await section.getByRole('checkbox',{name:'이 워크룸 AI도 사용 허용'}).click();
    await until(()=>state.shell?.aiAllowed===true,'AI grant is explicit');
    await section.getByRole('button',{name:'하단 터미널 접기'}).click();
    assert.equal(state.shell?.state,'running','Collapsing must retain the shell');
    await section.getByRole('button',{name:'하단 터미널 펼치기'}).click();
    assert.equal(await section.getByRole('checkbox',{name:'이 워크룸 AI도 사용 허용'}).isChecked(),true);
    await section.getByRole('button',{name:'셸 종료'}).click();
    await until(()=>state.shell===null,'Explicit close ends the shell');
  },{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA}});
  await run('bottom-shared-shell-pauses-hidden-and-after-exit',async({page,panel,state})=>{
    const section=panel.getByTestId('workroom-shared-shell');
    await section.getByRole('button',{name:'하단 터미널 펼치기'}).click();
    await section.getByRole('button',{name:'터미널 시작'}).click();
    await until(()=>state.requests.some(r=>r.operation==='shell.read'),'Running shell begins reading');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
    await sleep(50);
    const hiddenReads=state.requests.filter(r=>r.operation==='shell.read').length;
    await sleep(900);
    assert.equal(state.requests.filter(r=>r.operation==='shell.read').length,hiddenReads,'Background page must not poll the shell');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))});
    await until(()=>state.requests.filter(r=>r.operation==='shell.read').length>hiddenReads,'Foregrounding catches up on output');
    state.shell.state='exited';state.shell.exitCode=0;
    await section.getByText('셸 종료 · 코드 0').waitFor();
    const exitedReads=state.requests.filter(r=>r.operation==='shell.read').length;
    await sleep(900);
    assert.equal(state.requests.filter(r=>r.operation==='shell.read').length,exitedReads,'Exited shell must not keep polling');
  },{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA}});
  await run('command-palette-add-and-cli-focus',async({page,panel,state})=>{
    await panel.getByTestId('workroom-slash-pad-toggle').click();
    assert.match(await panel.getByTestId('workroom-slash-pad').innerText(),/CLI 명령은 \/, 설치된 스킬 호출은 \$/);
    await panel.getByRole('button',{name:'+ 직접 추가'}).click();
    await panel.getByLabel('추가할 CLI 명령 또는 스킬').fill('/cs-ceo:goal');
    await panel.getByRole('button',{name:'추가',exact:true}).click();
    await panel.getByTestId('workroom-slash-pad').getByRole('button',{name:/\/cs-ceo:goal/}).first().click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.data==='/cs-ceo:goal\r'),'Custom command is submitted');
    // Focus moves on a frame after the input is queued: wait for it as the model-button check below does (w11, flaky).
    await until(()=>panel.locator('.xterm-helper-textarea').evaluate(node=>document.activeElement===node),'Command click hands keyboard to the CLI');
    await panel.getByRole('button',{name:'모델·에포트 변경'}).click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.data==='/model\r'),'Model picker command is submitted');
    await until(()=>panel.locator('.xterm-helper-textarea').evaluate(node=>document.activeElement===node),'Model button hands keyboard to the CLI');
    await page.keyboard.press('ArrowDown');
    await until(()=>state.requests.some(r=>r.operation==='input'&&/\x1b\[B|\x1bOB/.test(r.data)),'Arrow key reaches the active picker');
    await panel.getByTestId('workroom-font-increase').click();
    await until(()=>panel.locator('.xterm-helper-textarea').evaluate(node=>document.activeElement===node),'Font button retains CLI keyboard mode');
    await panel.getByTestId('workroom-wide-toggle').click();
    await until(()=>panel.locator('.xterm-helper-textarea').evaluate(node=>document.activeElement===node),'Wide button retains CLI keyboard mode');
    await panel.getByRole('button',{name:'Enter',exact:true}).click();
    await until(()=>panel.locator('.xterm-helper-textarea').evaluate(node=>document.activeElement===node),'Keypad button returns focus to the CLI');
    await panel.getByRole('button',{name:'직접 입력 끄기'}).click();
    await panel.getByRole('textbox',{name:'워크룸 입력'}).fill('작성 중인 요청');
    await panel.getByTestId('workroom-font-decrease').click();
    await until(()=>panel.getByRole('textbox',{name:'워크룸 입력'}).evaluate(node=>document.activeElement===node),'View button returns to a composer draft');
    assert.equal(await panel.getByRole('textbox',{name:'워크룸 입력'}).inputValue(),'작성 중인 요청');
    await panel.getByTestId('workroom-slash-pad-toggle').click();
    await until(()=>panel.getByRole('textbox',{name:'워크룸 입력'}).evaluate(node=>document.activeElement===node),'Palette toggle preserves composer focus');
    await panel.getByTestId('workroom-context-usage').click();
    await until(()=>panel.getByRole('textbox',{name:'워크룸 입력'}).evaluate(node=>document.activeElement===node),'Context button preserves composer focus');
    await panel.getByRole('button',{name:'저장 상태 확인'}).click();
    await until(()=>panel.getByRole('textbox',{name:'워크룸 입력'}).evaluate(node=>document.activeElement===node),'Save status button preserves composer focus');
    await panel.getByTestId('workroom-slash-pad').locator('.ai-terminal-slash-tile').filter({hasText:'$remember-session'}).locator('button').first().click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.data==='$remember-session\r'),'Codex skill uses its $ invocation');
  },{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA}});
  await run('mobile-bypass-default-selection-and-viewport',async({page,panel,state})=>{
    await panel.getByTestId('workroom-launch-options').click();
    const toggle=panel.getByRole('checkbox',{name:'승인 없이 실행 (권한 우회)'});
    assert.equal(await toggle.isChecked(),true);
    await panel.getByRole('button',{name:'작업 시작',exact:true}).click();
    await until(()=>starts(state).length===1,'Default launch must reach transport');
    assert.equal(starts(state)[0].bypassPermissions,true);
    await toggle.uncheck();
    await panel.getByRole('button',{name:'작업 시작',exact:true}).click();
    await until(()=>starts(state).length===2,'Explicit OFF must reach transport');
    assert.equal(starts(state)[1].bypassPermissions,false);
    await page.reload();await panel.waitFor();
    assert.ok((await panel.getByTestId('workroom-launch-options').textContent()).includes('꺼짐'));
    await panel.getByTestId('workroom-launch-options').click();
    assert.equal(await panel.getByRole('checkbox',{name:'승인 없이 실행 (권한 우회)'}).isChecked(),false);
    await panel.getByRole('button',{name:'작업 시작',exact:true}).click();
    await panel.locator('.xterm').waitFor();
    const geometry=[];
    for(const width of [320,390,402,440]){
      await page.setViewportSize({width,height:844});
      const measured=await panel.evaluate(node=>{
        const b=node.getBoundingClientRect();
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,
          targets:[...node.querySelectorAll('.ai-terminal-toolbar button,.ai-terminal-select,[data-testid="workroom-launch-options"]')].map(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,fits:r.left>=b.left-1&&r.right<=b.right+1};})};
      });
      assert.equal(measured.overflow,false);assert.ok(measured.targets.every(t=>t.height>=44&&t.fits),JSON.stringify(measured));geometry.push(measured);
    }
    await page.setViewportSize({width:402,height:844});
    await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>360});window.visualViewport.dispatchEvent(new Event('resize'));});
    await until(async()=>(await panel.locator('.ai-terminal-surface').boundingBox()).height<240,'Keyboard-sized visible area must shrink the surface');
    const surface=await panel.locator('.ai-terminal-surface').boundingBox();
    assert.ok(surface.height>=160&&surface.height<=220);
    return {geometry,keyboardGeometry:surface,physicalKeyboardVerified:false};
  },{remote:true,jobs:[]});
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

  // The desktop Workroom once refetched its target list ~36 times a second: a target reload made
  // new project arrays, which made a new `refresh`, which re-ran the effect that reloads targets.
  // With one window open the sidecar sat at 87–103% CPU. Opening the Workroom loads targets once.
  await run('desktop-workroom-does-not-loop-target-reloads',async({panel,state})=>{
    await until(async()=>await panel.getByRole('tab').count()===1,'The session must be listed');
    const before=state.requests.filter(r=>r.path==='/api/agent-runtime/targets').length;
    await sleep(3000);
    const targets=state.requests.filter(r=>r.path==='/api/agent-runtime/targets').length-before;
    const lists=state.requests.filter(r=>r.operation==='list').length;
    assert.ok(targets<=1,`targets refetched ${targets} times in 3s`);
    assert.ok(lists<=6,`session list requested ${lists} times; the 2s poll allows a few`);
    return {targets,lists};
  },{sessions:[session(SA,A)],jobs:[]});

  // A phone loads the Mac's projects 20 per page. The host already scopes sessions to what this
  // device may see; the phone used to drop every session whose project was not on a loaded page,
  // so a running Mac session of a project on page 4 never appeared in the remote Workroom.
  await run('remote-lists-mac-sessions-of-projects-not-yet-loaded',async({panel})=>{
    await until(async()=>await panel.getByRole('tab').count()===2,'Both Mac sessions must be listed, including the unloaded project');
    assert.ok((await panel.locator('.ai-terminal-session-list h3').textContent()).includes('2'));
    assert.equal(await panel.getByTestId('workroom-remote-no-sessions').count(),0);
  },{remote:true,sessions:[session(SA,A),session('fixture-session-unloaded','fixture-project-unloaded')],jobs:[]});
  // Phone, sessions running, none selected: resuming is the usual step, so the new-task form folds (2026-10-02).
  await run('remote-folds-the-new-task-form-while-sessions-run',async({panel})=>{
    await panel.getByRole('tab').first().waitFor();
    assert.equal(await panel.getByTestId('workroom-composer').count(),0,'the empty form does not push the session list down');
    await panel.getByTestId('workroom-composer-toggle').click();
    await panel.getByTestId('workroom-composer').waitFor();
    await panel.getByTestId('workroom-composer-toggle').click();
    assert.equal(await panel.getByTestId('workroom-composer').count(),0,'and folds again');
  },{remote:true,sessions:[session(SA,A)],jobs:[]});
  // 2026-10-02 iPhone 17: a new projects array per status poll re-sent `list` each time; on the phone's
  // one-at-a-time relay that left no turn for terminal reads and the workroom stayed blank.
  await run('remote-rerenders-with-equal-projects-do-not-flood-list',async({state})=>{
    await sleep(3000);
    const lists=state.requests.filter(r=>r.operation==='list').length;
    assert.ok(lists<=3,`equal projects re-rendered every 300ms must not re-list (saw ${lists} lists in 3s)`);
  },{remote:true,sessions:[session(SA,A)],jobs:[],rerenderMs:300});
  await run('remote-explains-an-empty-session-list',async({panel})=>{
    await panel.getByTestId('workroom-remote-no-sessions').waitFor();
    assert.ok((await panel.getByTestId('workroom-remote-no-sessions').textContent()).includes('허용한 프로젝트'));
  },{remote:true,sessions:[],jobs:[]});
  // 2026-10-16 audit: before the first list answered, the phone already said 「…실행 중인 작업 세션이 없습니다」 beside
  // 「새 작업」 — for seconds behind an idle Mac — inviting a second CLI where one was running.
  await run('remote-says-it-is-checking-before-the-first-list-answers',async({panel})=>{
    await panel.getByTestId('workroom-remote-sessions-loading').waitFor();
    assert.equal(await panel.getByTestId('workroom-remote-no-sessions').count(),0,'no 「none running」 before the Mac answered');
    await panel.getByRole('tab').first().waitFor({timeout:8000});
    assert.equal(await panel.getByTestId('workroom-remote-sessions-loading').count(),0,'the loading line goes once the list answered');
    assert.equal(await panel.getByTestId('workroom-remote-no-sessions').count(),0);
  },{remote:true,sessions:[session(SA,A)],jobs:[],listDelayMs:2500});

  // w7: on a phone a session opens full screen (the panel's `sessionFullscreen`, set by the portal on ≤640px or a coarse
  // pointer). These drive the panel itself (Chromium, 390px); tests/remote-phone-layout.e2e.mjs checks the portal in
  // WebKit and Chromium at phone sizes, the history entry and the keyboard. The view is a body-level layer, so it is
  // looked up from the page, not inside the panel.
  const sessionView=page=>page.getByTestId('workroom-session-view');
  const reads=state=>state.requests.filter(r=>r.operation==='read').length;
  await run('remote-fullscreen-entry-naming-a-session-opens-it-full-screen',async({page,panel,state})=>{
    await sessionView(page).waitFor();
    assert.equal(await sessionView(page).getAttribute('data-session-id'),SA);
    assert.equal(await sessionView(page).getAttribute('role'),'dialog');
    await sessionView(page).getByLabel('워크룸 입력').waitFor();
    assert.equal(await panel.locator('.ai-terminal-surface').count(),0,'the list itself shows no terminal');
    await until(()=>reads(state)>0,'the open session is read');
    await page.getByTestId('workroom-session-view-back').click();
    await sessionView(page).waitFor({state:'detached'});
    assert.equal(await page.getByLabel('워크룸 입력').count(),0,'no session composer in the list');
    assert.ok((await panel.locator('[data-session-id]').first().innerText()).includes('실행 중'));
    // The list reads nothing while no session is open (only the session list, every 5s).
    const before=reads(state);await sleep(2500);
    assert.equal(reads(state),before,'no terminal reads while the list shows');
    // An entry naming the session that is still the selected one (voice, 「작업하기」, a resumed conversation) opens it again.
    await page.evaluate(([targetId,id])=>window.__setWorkroomEntry({nonce:2,targetId,sessionId:id}),[A,SA]);
    await sessionView(page).waitFor();
    assert.equal(await sessionView(page).getAttribute('data-session-id'),SA);
    return {readsWhileClosed:reads(state)-before};
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  await run('remote-fullscreen-resumed-conversation-opens-full-screen-and-keeps-the-draft',async({page,panel})=>{
    await panel.locator('[data-session-id]').first().waitFor();
    assert.equal(await sessionView(page).count(),0,'nothing opens by itself');
    // The new-task request is written in the 「새 작업」 sheet (w11) and stays there when the sheet closes.
    const newTask=async()=>{if(await panel.getByTestId('workroom-new-task').count()){await panel.getByTestId('workroom-new-task').click();const sheet=page.getByTestId('workroom-new-task-sheet');await sheet.waitFor();return sheet;}await panel.getByTestId('workroom-composer-toggle').click();return panel;};
    let sheet=await newTask();
    await sheet.getByLabel('터미널에 전달할 작업').fill('작성 중인 새 작업');
    if(await page.getByTestId('workroom-new-task-close').count())await page.getByTestId('workroom-new-task-close').click();
    // The phone's 「대화 기록」 selects the resumed session with keepDraft (src/remoteWorkroomHistoryClient.ts).
    await page.evaluate(([targetId,id])=>window.__setWorkroomEntry({nonce:2,targetId,sessionId:id,agent:'claude',keepDraft:true}),[B,SB]);
    await sessionView(page).waitFor();
    assert.equal(await sessionView(page).getAttribute('data-session-id'),SB);
    await page.getByTestId('workroom-session-view-back').click();
    await sessionView(page).waitFor({state:'detached'});
    sheet=await page.getByTestId('workroom-new-task').count()?await newTask():panel;
    assert.equal(await sheet.getByLabel('터미널에 전달할 작업').inputValue(),'작성 중인 새 작업');
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],jobs:[]});
  await run('remote-fullscreen-project-entry-opens-its-latest-session',async({page})=>{
    await sessionView(page).waitFor();
    assert.equal(await sessionView(page).getAttribute('data-session-id'),SB);
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:B,resumeLatest:true},jobs:[],listDelayMs:150});
  await run('remote-fullscreen-start-opens-the-new-session',async({page,panel,state})=>{
    await panel.locator('[data-session-id]').first().waitFor();
    // The phone's only start button is in the 「새 작업」 sheet (w11).
    await panel.getByTestId('workroom-new-task').click();
    const sheet=page.getByTestId('workroom-new-task-sheet');await sheet.waitFor();
    assert.equal(await sheet.locator('.ai-terminal-start').count(),1,'one start button');
    await sheet.locator('.ai-terminal-start').click();
    await sessionView(page).waitFor();
    await sheet.waitFor({state:'detached'});
    assert.equal(starts(state).length,1);
    assert.equal(await sessionView(page).getAttribute('data-session-id'),state.sessions.at(-1).id);
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A)],jobs:[]});
  await run('remote-fullscreen-route-receipt-switches-the-open-session',async({page,state})=>{
    const view=sessionView(page);await view.waitFor();
    const composer=view.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await view.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill('첫 줄 요청');
    page.once('dialog',dialog=>void dialog.accept());
    await view.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await view.getByTestId('workroom-route-receipt').waitFor();
    assert.ok(state.requests.some(r=>r.operation==='input'&&r.sessionId===SB),'the handoff reached the receiving session');
    assert.equal(await view.getAttribute('data-session-id'),SA,'the sender stays in its own session');
    await view.getByTestId('workroom-route-jump').click();
    await until(async()=>await view.getAttribute('data-session-id')===SB,'「그 세션으로 이동」 shows the receiving session in the same view');
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A,'running','agy'),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  await run('remote-fullscreen-ending-the-session-returns-to-the-list',async({page,panel,state})=>{
    const view=sessionView(page);await view.waitFor();
    await view.getByRole('button',{name:'세션 종료',exact:true}).click();
    await page.getByRole('button',{name:'저장 없이 종료',exact:true}).click();
    await view.waitFor({state:'detached'});
    assert.equal(state.requests.filter(r=>r.operation==='close').length,1);
    // The other running session does not open full screen in its place.
    await sleep(500);assert.equal(await sessionView(page).count(),0);
    assert.ok(await panel.locator(`[data-session-id="${SB}"]`).count());
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  // w7 review (2026-10-16).
  // The portal hides the panel while it loads more of the Mac's projects (`visible` false, an automatic sweep retry); the
  // Workroom is still on screen (`onScreen`), so an open session stays open with its entry. Leaving the pane closes it.
  await run('remote-fullscreen-loading-keeps-the-open-view',async({page})=>{
    const view=sessionView(page);await view.waitFor();await view.locator('.xterm').waitFor();
    const opened=await page.evaluate(()=>({length:history.length,state:history.state}));
    await page.evaluate(()=>window.__setWorkroomVisible(false));await sleep(600);
    await page.evaluate(()=>window.__setWorkroomVisible(true));await sleep(300);
    assert.equal(await view.count(),1,'loading the project list closed the open session');
    assert.equal(await view.getAttribute('data-session-id'),SA);
    assert.deepEqual(await page.evaluate(()=>({length:history.length,state:history.state})),opened,'loading moved history');
    await view.locator('.xterm').waitFor();
    await page.evaluate(()=>{window.__setWorkroomOnScreen(false);window.__setWorkroomVisible(false);});
    await view.waitFor({state:'detached'});
    await until(async()=>!(await page.evaluate(()=>!!history.state?.workroomSessionView)),'leaving the Workroom pops the view entry');
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  // A hardware keyboard's Escape in the 「세션 종료」 dialog closes the dialog, not the whole view.
  await run('remote-fullscreen-escape-in-the-exit-dialog-keeps-the-view',async({page,state})=>{
    const view=sessionView(page);await view.waitFor();
    await view.getByRole('button',{name:'세션 종료',exact:true}).click();
    const dialog=page.locator('dialog.workroom-exit-dialog[open]');await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});await sleep(300);
    assert.equal(await view.count(),1,'Escape in the dialog closed the session view');
    assert.equal(state.requests.filter(r=>r.operation==='close').length,0);
    await view.focus();await page.keyboard.press('Escape');
    await view.waitFor({state:'detached'});
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  // A voice call that switches to a project's AI opens its session over the voice dock: the view says the call goes on and
  // can end it or show the dock.
  await run('remote-fullscreen-shows-a-live-voice-call',async({page})=>{
    const view=sessionView(page);await view.waitFor();
    assert.equal(await view.getByTestId('workroom-session-view-voice').count(),0,'no voice line without a call');
    await page.evaluate(async()=>{const {voiceMediaClient}=await import('/src/voiceMediaClient.ts');window.__voiceStops=0;
      voiceMediaClient.stop=async()=>{window.__voiceStops++;};
      voiceMediaClient.update({phase:'listening',owner:'voice-ops',session:{id:'voice_fixture',state:'active',mode:'voice',provider:'openai',label:'AgentsToZ OPS',activeTarget:{kind:'workroom',label:'기억 A',targetId:'fixture-project-alpha',sessionId:'fixture-session-alpha',agent:'codex'},draft:null,notice:'',expiresAt:Date.now()+900000}});});
    const line=view.getByTestId('workroom-session-view-voice');await line.waitFor();
    assert.match(await line.innerText(),/음성 대화.*기억 A/s);
    await line.getByRole('button',{name:'음성 종료',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__voiceStops),1);
    await line.getByRole('button',{name:'음성 창 보기',exact:true}).click();
    await view.waitFor({state:'detached'});
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  // A reload (or iOS reloading a reclaimed page) with the view open: back where you were (w11, S4.2). The session reopens full
  // screen on one entry of its own (the entry the earlier load left is stepped over, not stacked on), and back leaves it
  // for the list it was opened from — no dead step. An exited session stays a row.
  // w11 review (finding 7): opening 「새 작업」 after a reload is the user's choice — the restore that waits on the first list
  // must not close the sheet, pull the keyboard and open a session over it.
  await run('remote-fullscreen-reload-restore-yields-to-an-open-new-task-sheet',async({page,panel})=>{
    await panel.locator(`[data-session-id="${SA}"]`).waitFor({timeout:10000});
    await panel.locator(`[data-session-id="${SA}"]`).click();await sessionView(page).waitFor();
    await page.reload();
    await page.getByTestId('workroom-new-task').click();
    const sheet=page.getByTestId('workroom-new-task-sheet');await sheet.waitFor();
    const field=sheet.getByLabel('터미널에 전달할 작업');await field.click();await field.pressSequentially('새 요청을 쓰는 중');
    await panel.locator(`[data-session-id="${SA}"]`).waitFor({timeout:10000});await sleep(1500);
    assert.equal(await sheet.count(),1,'the sheet stays open');
    assert.equal(await sessionView(page).count(),0,'no session view opens over it');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'터미널에 전달할 작업','the request box keeps focus');
    assert.equal(await field.inputValue(),'새 요청을 쓰는 중');
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],jobs:[],listDelayMs:2500});
  // w11 review (finding 5): the remembered open session is refreshed while it is watched — a reload after more than 30
  // minutes in the foreground (no hide in between) still reopens it. Here the record is aged 29 minutes by hand; the next
  // reads refresh it.
  await run('remote-fullscreen-open-session-record-stays-fresh-while-watched',async({page,panel})=>{
    await panel.locator(`[data-session-id="${SA}"]`).waitFor({timeout:10000});
    await panel.locator(`[data-session-id="${SA}"]`).click();await sessionView(page).waitFor();
    const key=await page.evaluate(()=>Object.keys(localStorage).find(k=>k.startsWith('agentstoz:workroom-open-session:v1:')));
    assert.ok(key,'the open session is remembered');
    await page.evaluate(k=>{const r=JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify({...r,at:Date.now()-29*60_000}));},key);
    await until(async()=>await page.evaluate(k=>Date.now()-JSON.parse(localStorage.getItem(k)).at<60_000,key),'a read of the open session refreshes its record',12000);
    assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).id,key),SA);
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],jobs:[]});
  // w11 review (finding 8): with no session yet the phone overview still has its manual refresh (the header row's ⟳) — the
  // loading caption and the target error tell the user to refresh, and only a manual refresh clears a stale error.
  await run('remote-fullscreen-empty-list-keeps-the-refresh',async({page,panel,state})=>{
    const refresh=panel.getByRole('button',{name:'작업 세션 새로고침',exact:true});
    await refresh.waitFor({timeout:5000});
    await panel.getByTestId('workroom-remote-no-sessions').waitFor({timeout:8000});
    const lists=state.requests.filter(r=>r.operation==='list').length;
    await refresh.click();
    await until(()=>state.requests.filter(r=>r.operation==='list').length>lists,'refresh reads the list again');
    assert.equal(await page.getByTestId('workroom-new-task').count(),1,'「새 작업」 is there with no session too');
  },{remote:true,sessionFullscreen:true,sessions:[],jobs:[]});
  await run('remote-fullscreen-reload-reopens-the-open-session',async({page,panel,state})=>{
    await panel.locator(`[data-session-id="${SA}"]`).waitFor();
    await page.evaluate(()=>history.pushState({mark:'list'},''));
    const index=await page.evaluate(()=>navigation.currentEntry.index);
    await panel.locator(`[data-session-id="${SA}"]`).click();await sessionView(page).waitFor();
    assert.equal(await page.evaluate(()=>navigation.currentEntry.index),index+1);
    const length=await page.evaluate(()=>history.length);
    await page.reload();
    await sessionView(page).waitFor({timeout:8000});
    assert.equal(await sessionView(page).getAttribute('data-session-id'),SA,'the reload reopened the session that was open');
    await sleep(800);
    assert.equal(await page.evaluate(()=>navigation.currentEntry.index),index+1,'the reopened view stands where the old one stood');
    assert.equal(await page.evaluate(()=>history.length),length,'no history entry was added');
    assert.ok(await page.evaluate(()=>!!history.state?.workroomSessionView));
    await page.goBack({waitUntil:'commit'});
    await sessionView(page).waitFor({state:'detached'});
    await until(async()=>await page.evaluate(()=>history.state?.mark)==='list','back lands on the list it was opened from',4000);
    // Opened again, then the session ends: the next reload shows the list.
    await panel.locator(`[data-session-id="${SA}"]`).click();await sessionView(page).waitFor();
    state.sessions[0].state='exited';state.sessions[0].exitCode=0;
    await page.reload();
    await panel.locator('[data-session-id]').first().waitFor();
    await sleep(1500);
    assert.equal(await sessionView(page).count(),0,'a reload does not reopen a session that has exited');
  },{remote:true,sessionFullscreen:true,sessions:[session(SA,A),session(SB,B,'running','claude')],jobs:[]});
  // The same panel without the prop (a desktop browser, a Mac driving another device) keeps the terminal inline.
  await run('remote-without-fullscreen-keeps-the-terminal-inline',async({page,panel})=>{
    await panel.locator('.xterm').waitFor();
    assert.equal(await sessionView(page).count(),0);
    assert.ok(await panel.getByLabel('워크룸 입력').isVisible());
  },{remote:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});

  await run('startup-exit-keeps-final-error-visible',async({panel,state})=>{
    await panel.locator('.xterm').waitFor();
    state.sessions[0].state='exited';state.sessions[0].exitCode=1;
    await panel.getByRole('button',{name:'작업 세션 새로고침',exact:true}).click();
    await panel.getByText(/터미널이 종료되었습니다 \(종료 코드 1\)/).waitFor();
    assert.ok(await panel.locator('.xterm').isVisible());
    assert.equal(await panel.getByRole('tab',{selected:true}).count(),1);
    assert.ok(await panel.getByRole('button',{name:'Enter',exact:true}).isDisabled());
    assert.equal(starts(state).length,0);
  },{remote:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});

  // Updated 2026-09-29: an @ route used to start a session with the sender's AI, type the handoff into it
  // and switch to it. Now the receiving AI is chosen, a new session gets the handoff as its first request
  // (no typing into a CLI that is still starting), and the sender stays put with a receipt to jump from.
  await run('project-mention-starts-the-chosen-ai-with-the-handoff-as-its-first-request',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@codex');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    const routeAgent=panel.getByLabel('받는 곳');
    // Nothing runs in B, so the sender's AI is suggested; a different AI can take the work.
    assert.equal(await routeAgent.inputValue(),'claude');
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/새 Claude Code 세션을 열고/);
    await routeAgent.selectOption('agy');
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/새 Antigravity 세션을 열고/);
    await composer.fill('대상 프로젝트의 테스트를 실행해 주세요.');
    let confirmation='';
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await until(()=>starts(state).length===1,'Project delivery must start one target Workroom');
    const startRequest=starts(state)[0];
    assert.equal(startRequest.targetId,B);assert.equal(startRequest.agent,'agy');assert.equal(startRequest.bypassPermissions,true);
    assert.match(startRequest.prompt,/AgentsToZ 프로젝트 전달/);assert.match(startRequest.prompt,/보낸 프로젝트: .*기억 A/);assert.match(startRequest.prompt,/보낸 AI: Claude Code/);
    assert.match(startRequest.prompt,/받는 프로젝트: .*기억 B/);assert.match(startRequest.prompt,/테스트를 실행/);
    assert.match(confirmation,/기억 B.*Antigravity 워크룸 세션을 새로 열고/s);
    const receipt=panel.getByTestId('workroom-route-receipt');await receipt.waitFor();
    assert.match(await receipt.innerText(),/기억 B.*새 Antigravity 세션을 열고 첫 요청으로 전달했습니다/s);
    await sleep(300);
    assert.equal(state.requests.filter(request=>request.operation==='input'&&request.sessionId.startsWith('fixture-started-')).length,0,'A new session is never typed into right after start');
    assert.match(await panel.getByRole('tab',{selected:true}).innerText(),/기억 A/,'The sender keeps its own session');
    assert.equal(await composer.inputValue(),'');
    await panel.getByTestId('workroom-route-jump').click();
    await until(async()=>/기억 B/.test(await panel.getByRole('tab',{selected:true}).innerText()),'The receipt jumps to the receiving session');
    // The receipt clears in the render after the jump; read it once and a loaded machine sees the old frame.
    await until(async()=>await panel.getByTestId('workroom-route-receipt').count()===0,'The receipt clears after the jump');
  },{sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});

  // 2026-10-08: the receiving choice has two surfaces — the target's Workroom CLI or this Mac's desktop app.
  // Codex app prefills (not sent); Antigravity app only launches, so the task goes to the clipboard.
  const chooseRouteTarget=async panel=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    return composer;
  };
  const appDispatches=state=>state.requests.filter(r=>r.path==='/api/agent-runtime/app-dispatch');
  await run('project-mention-app-destinations-codex-prefills-agy-copies',async({context,page,panel,state})=>{
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
    const composer=await chooseRouteTarget(panel);
    const choice=panel.getByLabel('받는 곳');
    assert.deepEqual(await choice.locator('optgroup').evaluateAll(groups=>groups.map(g=>g.label)),['워크룸 CLI','앱']);
    assert.deepEqual(await choice.locator('optgroup[label="앱"] option').evaluateAll(options=>options.map(o=>o.value)),['app:codex','app:claude','app:hermes','app:agy']);
    await choice.selectOption('app:codex');
    await composer.fill('대상 프로젝트의 테스트를 실행해 주세요.');
    assert.equal(await panel.getByTestId('workroom-route-plan').getAttribute('data-route-plan'),'app');
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/새 Codex 앱 대화를 열고 작업을 입력칸에 채우도록 요청합니다/);
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/권한 우회는 Claude 앱에만/);
    let confirmation='';
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'Codex 앱 입력칸에 채우기',exact:true}).click();
    const receipt=panel.getByTestId('workroom-app-route-receipt');await receipt.waitFor();
    assert.match(confirmation,/^‘.*기억 B.*’ 작업으로 새 Codex 앱 대화를 엽니다\./);
    assert.match(confirmation,/앱에서 확인한 뒤 보내기를 누르세요/);
    const [codex]=appDispatches(state);
    assert.equal(codex.agent,'codex');assert.equal(codex.targetId,B);assert.equal(codex.bypass,undefined,'Bypass only rides to the Claude app');
    assert.equal(codex.folderPath,undefined,'The panel sends a target id, never a path');
    assert.match(codex.task,/^AgentsToZ 프로젝트 전달\n보낸 프로젝트: .*기억 A.*\n보낸 AI: Claude Code\n받는 프로젝트: .*기억 B.*\n\n대상 프로젝트의 테스트를 실행해 주세요\.$/s);
    // The prefill is only requested (Codex never confirms it), so the clipboard holds a backup.
    assert.match(await receipt.innerText(),/입력칸에 채우도록 요청했습니다/);assert.match(await receipt.innerText(),/클립보드에도 복사해 두었습니다/);
    assert.match(await receipt.innerText(),/권한 우회는 Claude 앱에만/);
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),codex.task);
    assert.equal(starts(state).length,0,'An app destination starts no Workroom session');
    assert.equal(await composer.inputValue(),'');

    await chooseRouteTarget(panel);
    await panel.getByLabel('받는 곳').selectOption('app:agy');
    await composer.fill('Antigravity로 넘길 작업');
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/프로젝트는 앱에서 선택/);
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'Antigravity 앱 열고 작업 복사',exact:true}).click();
    await until(async()=>/프로젝트는 앱에서 선택하세요/.test(await receipt.innerText()),'Antigravity receipt says the project was not applied');
    assert.match(confirmation,/^Antigravity 앱을 열고 ‘.*기억 B.*’ 작업을 클립보드에 복사합니다\./);
    assert.match(confirmation,/프로젝트는 앱에서 선택하고, 작업은 클립보드에서 붙여 넣으세요/);
    assert.match(await receipt.innerText(),/클립보드에 복사했습니다/);
    const agy=appDispatches(state)[1];
    assert.equal(agy.agent,'agy');
    // An app that cannot take the task is not sent it (no size check on a text it never receives).
    assert.equal(agy.task,undefined);
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Antigravity로 넘길 작업$/);
    assert.equal(await composer.inputValue(),'');
  },{sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],
    appDispatch:{codex:{json:{success:true,agent:'codex',targetId:B,taskApplied:'prefilled',projectApplied:'requested',selectionVerified:false}},
      agy:{json:{success:true,agent:'agy',targetId:B,launchVerified:true,projectApplied:false,taskApplied:false,taskReason:'unsupported-app'}}}});

  await run('project-mention-app-destination-failure-keeps-the-draft',async({page,panel,state})=>{
    const composer=await chooseRouteTarget(panel);
    await panel.getByLabel('받는 곳').selectOption('app:agy');
    await composer.fill('지워지면 안 되는 작업');
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'Antigravity 앱 열고 작업 복사',exact:true}).click();
    await panel.getByRole('alert').filter({hasText:'Antigravity 앱을 찾지 못했습니다'}).waitFor();
    assert.equal(appDispatches(state).length,1);
    assert.equal(await composer.inputValue(),'지워지면 안 되는 작업');
    assert.equal(await panel.getByTestId('workroom-app-route-receipt').count(),0);
  },{sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],
    appDispatch:{agy:{status:409,json:{success:false,code:'ANTIGRAVITY_APP_NOT_FOUND',error:'이 Mac에서 Antigravity 앱을 찾지 못했습니다.'}}}});

  await run('remote-project-mention-offers-no-app-destination',async({panel})=>{
    await chooseRouteTarget(panel);
    assert.equal(await panel.getByLabel('받는 곳').count(),0,'Only AIs can be chosen here, so the label stays 「받는 AI」');
    const choice=panel.getByLabel('받는 AI');
    assert.equal(await choice.locator('optgroup').count(),0);
    assert.equal(await choice.locator('option[value^="app:"]').count(),0);
  },{sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],remote:true});

  await run('project-mention-new-session-carries-references-or-says-names-only',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill('#기억');
    await panel.getByRole('listbox',{name:'언급할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 A'}).click();
    await composer.fill((await composer.inputValue())+'참고해서 테스트를 실행해 주세요.');
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    const receipt=panel.getByTestId('workroom-route-receipt');await receipt.waitFor();
    // The first attempt carries the # reference on the start; an older Mac refuses it, so the retry names it only.
    assert.deepEqual(starts(state).map(request=>request.references??null),[[A],null]);
    assert.ok(starts(state).every(request=>request.targetId===B&&request.agent==='claude'&&/참고해서 테스트/.test(request.prompt)));
    assert.match(await receipt.innerText(),/프로젝트 이름만 전달했습니다/);
    assert.equal(state.sessions.filter(item=>item.id.startsWith('fixture-started-')).length,1,'The refused attempt started nothing');
  },{sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],startRejectsReferences:true});

  // The phone portal drives the same panel over the relay transport; routing must behave the same there.
  const deliverToRunningSession=async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    // The AI already running in B is suggested.
    // 「받는 곳」 on this Mac (apps too), 「받는 AI」 on the phone (CLIs only) — the same label as the LAN QR page.
    assert.equal(await panel.getByLabel(/^받는 (곳|AI)$/).inputValue(),'claude');
    assert.equal(await panel.getByTestId('workroom-route-plan').getAttribute('data-route-plan'),'deliver');
    // Review L4: the preview names the receiving session by its tab label.
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/받는 세션: 기억 B/);
    await composer.fill('첫 줄 요청\n둘째 줄 조건');
    let confirmation='';
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-route-receipt').waitFor();
    assert.match(confirmation,/기억 B.*실행 중인 Claude Code 워크룸 세션으로/s);
    // Review M2: the dialog says Enter is pressed in that live session and shows its screen, read before asking.
    assert.match(confirmation,/실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다/);
    assert.match(confirmation,/│ FIXTURE_ONLY_TERMINAL_OUTPUT/);
    assert.equal(starts(state).length,0,'A running session of the chosen AI receives the handoff; no new session');
    const delivered=state.requests.filter(request=>request.operation==='input'&&request.sessionId===SB).map(request=>request.data).join('');
    assert.match(delivered,/^AgentsToZ 프로젝트 전달\n보낸 프로젝트: .*기억 A.*\n보낸 AI: Antigravity\n받는 프로젝트: .*기억 B.*\n\n첫 줄 요청\n둘째 줄 조건\r$/s);
    assert.match(await panel.getByTestId('workroom-route-receipt').innerText(),/기억 B.*의 Claude Code 세션에 전달했습니다/s);
    assert.match(await panel.getByRole('tab',{selected:true}).innerText(),/기억 A/);
    await panel.getByTestId('workroom-route-jump').click();
    await until(async()=>/기억 B/.test(await panel.getByRole('tab',{selected:true}).innerText()),'The receipt jumps to the receiving session');
  };
  const deliverySessions=[session(SA,A,'running','agy'),session(SB,B,'running','claude')];
  await run('project-mention-delivers-to-the-running-session-of-the-chosen-ai',deliverToRunningSession,{sessions:deliverySessions,entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});
  await run('remote-project-mention-delivers-to-the-running-session-of-the-chosen-ai',deliverToRunningSession,{sessions:deliverySessions,entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],remote:true});

  // Review M2 in the real browser: the receiver's screen is rendered by an xterm that is never opened.
  // A session waiting on a question is not typed into; its last lines are shown and a new session gets the message.
  const TRUST_SCREEN=['╭────────────────────────────────────────╮','│ Do you trust the files in this folder? │','│ /Users/fixture/bravo                   │',
    '│ ❯ 1. Yes, proceed                       │','│   2. No, exit                           │','╰────────────────────────────────────────╯','  Enter to confirm · Esc to exit',''].join('\r\n');
  await run('project-mention-never-types-into-a-receiver-waiting-for-an-answer',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    assert.equal(await panel.getByTestId('workroom-route-plan').getAttribute('data-route-plan'),'deliver');
    await composer.fill('테스트를 실행해 주세요.');
    let confirmation='';
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-route-receipt').waitFor();
    assert.match(confirmation,/질문이나 승인에 대한 답을 기다리는 화면입니다/);
    assert.match(confirmation,/│ Do you trust the files in this folder\?/);
    assert.match(confirmation,/│ ❯ 1\. Yes, proceed/);
    assert.match(confirmation,/대신 ‘기억 B.*Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요\?/s);
    assert.equal(state.requests.filter(request=>request.operation==='input'&&request.sessionId===SB).length,0,'The waiting session is never typed into');
    assert.equal(starts(state).length,1);
    assert.equal(starts(state)[0].targetId,B);assert.equal(starts(state)[0].agent,'claude');assert.match(starts(state)[0].prompt,/테스트를 실행해 주세요/);
    assert.equal(await composer.inputValue(),'');
  },{sessions:deliverySessions,entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],screens:{[SB]:TRUST_SCREEN}});

  // Review M1: the phone portal's relay carries 11,000 bytes per request, so a longer handoff opens the
  // session plainly and is typed in pieces once its screen is ready (it used to fail outright).
  await run('remote-project-mention-long-handoff-opens-the-session-then-types-it',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    const task='가'.repeat(3700);
    await composer.fill(task);
    assert.match(await panel.getByTestId('workroom-route-plan').innerText(),/준비되면 메시지를 입력합니다/);
    let confirmation='';
    page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-route-receipt').filter({hasText:'화면이 준비된 뒤 메시지를 입력했습니다'}).waitFor({timeout:20000});
    assert.match(confirmation,/준비되면 이 메시지를 입력할까요\?/);
    assert.equal(starts(state).length,1);assert.equal(starts(state)[0].prompt,undefined,'The relay cannot carry this first request');
    const started=state.sessions.find(item=>item.id.startsWith('fixture-started-'));
    const inputs=state.requests.filter(request=>request.operation==='input'&&request.sessionId===started.id);
    assert.ok(inputs.length>1,'A long handoff is typed in pieces');
    assert.ok(inputs.every(request=>new TextEncoder().encode(request.data).length<=4096));
    const delivered=inputs.map(request=>request.data).join('');
    assert.match(delivered,/^AgentsToZ 프로젝트 전달\n/);assert.ok(delivered.endsWith(task+'\r'));
    assert.equal(await composer.inputValue(),'');
  },{remote:true,sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]});

  // Review L6: a Mac built before 2026-09-22 refuses a first request for Hermes; the session opens plainly and gets it typed.
  await run('remote-project-mention-older-mac-opens-then-types',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await panel.getByLabel('받는 AI').selectOption('hermes');
    await composer.fill('Hermes로 검토해 주세요.');
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-route-receipt').filter({hasText:'이 Mac 버전은 새 세션의 첫 요청으로 받지 못했습니다'}).waitFor({timeout:20000});
    assert.deepEqual(starts(state).map(request=>request.prompt===undefined),[false,true]);
    assert.equal(state.sessions.filter(item=>item.id.startsWith('fixture-started-')).length,1,'The refused attempt started nothing');
    const started=state.sessions.find(item=>item.id.startsWith('fixture-started-'));
    assert.match(state.requests.filter(request=>request.operation==='input'&&request.sessionId===started.id).map(request=>request.data).join(''),/보낸 AI: Claude Code\n받는 프로젝트: .*\n\nHermes로 검토해 주세요\.\r$/s);
  },{remote:true,sessions:[session(SA,A,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],startRejectsPrompt:true});

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

  await run('one-old-failure-group-can-be-hidden-without-losing-other-save-status',async({page,panel,state})=>{
    const original=structuredClone(state.jobs);
    const song=panel.getByTestId('workroom-memory-attention').locator('li').filter({hasText:'3건'});
    await song.getByRole('button',{name:'새 AI로 원인 조사 요청'}).click();
    assert.match(await panel.getByLabel('터미널에 전달할 작업').inputValue(),/세션 기억 저장 실패.*3건.*새 AI 세션/s);
    assert.equal(starts(state).length,0);
    await song.getByRole('button',{name:'이 항목 이전 기록으로 정리'}).click();
    assert.equal(await panel.getByTestId('workroom-memory-attention').locator('li').filter({hasText:'3건'}).count(),0);
    assert.ok((await panel.getByTestId('workroom-memory-attention').innerText()).includes('기억 B'));
    assert.ok((await panel.getByTestId('workroom-memory-attention').innerText()).includes('종료 후 저장 대기'));
    assert.ok((await panel.getByTestId('workroom-memory-previous').innerText()).includes('이전 기록 3건 · 확인 필요 3건'));
    assert.deepEqual(state.jobs,original);
    await page.reload();
    assert.ok((await panel.getByTestId('workroom-memory-previous').innerText()).includes('이전 기록 3건 · 확인 필요 3건'));
    assert.deepEqual(state.jobs,original);
  },{jobs:[
    ...Array.from({length:3},(_,i)=>({sessionId:`old-song-${i}`,targetId:A,state:'failed'})),
    {sessionId:'other-failure',targetId:B,state:'failed'},
    {sessionId:'active-save',targetId:A,state:'pending'},
  ]});

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
      await panel.getByRole('button',{name:'터미널 직접 입력',exact:true}).click();
      await panel.locator('.xterm-helper-textarea').focus();await page.keyboard.type('B-before');
      await until(()=>state.inputWaiting,'Input on B must be in flight while A starts');
      await page.keyboard.type('B-queued');await sleep(25);
      releaseStart();await until(()=>!state.startWaiting&&state.sessions.length===3,'A start response must finish');
      await until(async()=>await panel.getByRole('tab').count()===3,'Created A session remains in the list');
      await until(async()=>await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled(),'The late start receipt must settle in React');
      assert.equal(await tabB.getAttribute('aria-selected'),'true','Late A must not select itself over B');
      assert.equal(await panel.locator('.xterm').getAttribute('data-fixture-identity'),'selected-B','B terminal must not be disposed or reset');
      releaseInput();await until(()=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('')==='B-beforeB-queued','Queued B text is retained');
      await panel.locator('.xterm-helper-textarea').focus();await page.keyboard.type('B-after');
      await until(()=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('')==='B-beforeB-queuedB-after','Subsequent input still reaches B');
      assert.ok(state.requests.filter(r=>r.operation==='input').every(r=>r.sessionId===SB));
      assert.equal(state.requests.filter(r=>r.operation==='close').length,0);assert.equal(starts(state).length,1);
      // The composer folds after a successful start; with a running session the toggle sits in the new-window row.
      const composerToggle=panel.getByTestId('workroom-composer-toggle');assert.equal(await composerToggle.getAttribute('aria-expanded'),'false','The composer must be folded after the start succeeds');
      assert.equal(await composerToggle.innerText(),'프로젝트·요청 고르기');await composerToggle.click();
      const draft=panel.getByLabel('터미널에 전달할 작업');assert.equal(await draft.inputValue(),'','The unchanged A request may be cleared after success');
      await draft.fill('두 번째 A 요청');state.startBarrier=new Promise(resolve=>{releaseStart=resolve;});
      await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();await until(()=>state.startWaiting,'Second A remains pending');
      await page.evaluate(value=>window.__setWorkroomEntry(value),{nonce:2,targetId:B,sessionId:SB,agent:'claude',prompt:'새 entry B 초안'});
      await until(async()=>await draft.inputValue()==='새 entry B 초안','The new entry draft is installed');
      releaseStart();await until(async()=>await panel.getByRole('tab').count()===4,'Second created session remains available');
      await until(async()=>await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled(),'The second start receipt must settle in React');
      assert.equal(await draft.inputValue(),'새 entry B 초안');assert.equal(await tabB.getAttribute('aria-selected'),'true');
      assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');
      assert.equal(starts(state).length,2);assert.equal(new Set(starts(state).map(r=>r.requestId)).size,2);
      assert.equal(state.requests.filter(r=>r.operation==='close').length,0);
    }finally{releaseStart?.();releaseInput?.();await until(()=>!state.startWaiting&&!state.inputWaiting,'Fixture barriers did not settle',2000).catch(()=>{});}
  },{sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,sessionId:SA,prompt:'첫 A 요청'},jobs:[]});

  // Integration review w4 (finding 1): the phone's history panel selects a resumed session with a keepDraft entry, which
  // may land while a prompted start is still in flight. The started request must still leave the composer: if it stayed,
  // the start button stayed enabled under it and a second press opened a second CLI with the same first request.
  for(const launchHost of [false,true])await run(`keep-draft-entry-during-a-${launchHost?'launch':'plain-start'}-still-clears-the-started-request`,async({page,panel,state})=>{
    let release;
    try{
      if(launchHost)await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
      const draft=panel.getByLabel('터미널에 전달할 작업');assert.equal(await draft.inputValue(),'한 번만 시작할 요청');
      const barrier=new Promise(resolve=>{release=resolve;});if(launchHost)state.launchBarrier=barrier;else state.startBarrier=barrier;
      const waiting=()=>launchHost?state.launchWaiting:state.startWaiting;
      const startButton=panel.getByRole('button',{name:'선택한 AI로 시작',exact:true});
      await until(async()=>await startButton.isEnabled(),'The prompted start can begin');await startButton.click();
      await until(waiting,'The start remains pending');
      // The resumed conversation's session is selected meanwhile; the composer keeps its draft (keepDraft).
      await page.evaluate(value=>window.__setWorkroomEntry(value),{nonce:2,targetId:B,sessionId:SB,agent:'claude',keepDraft:true});
      const tabB=panel.getByRole('tab').filter({hasText:projects[1].label});
      await until(async()=>await tabB.getAttribute('aria-selected')==='true','The resumed session is selected');
      release();await until(()=>!waiting(),'The start answers');
      await until(async()=>await panel.getByRole('tab').count()===3,'The started session is listed');
      await until(async()=>await startButton.count()===0,'The started request leaves the composer, so no second press can start it again');
      assert.equal(await panel.getByTestId('workroom-composer-toggle').getAttribute('aria-expanded'),'false','The composer folds as after any successful start');
      assert.equal(await tabB.getAttribute('aria-selected'),'true','The resumed session stays selected');
      const started=launchHost?state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch):starts(state);
      assert.equal(started.length,1,'Started exactly once');
    }finally{release?.();}
  },{remote:true,sessions:[session(SA,A),session(SB,B,'running','claude')],entry:{nonce:1,targetId:A,prompt:'한 번만 시작할 요청'},jobs:[],launchHost});

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
    await until(()=>state.requests.some(r=>r.observationTargetId===B),'Changed scope must be requested');
    await until(async()=>/이 앱에서는 완료 대화 상태를 확인할 수 없습니다/.test(await completion.innerText()),'Invalid completion status must settle as unsupported in the changed scope');
    assert.match(await completion.innerText(),/이 앱에서는 완료 대화 상태를 확인할 수 없습니다/);
    assert.doesNotMatch(await completion.innerText(),/999/);
  },{jobs:[]});

  await run('empty-session-starts-with-compact-composer',async({page,panel,state})=>{
    await panel.getByTestId('workroom-memory-history').waitFor();
    assert.equal(await panel.locator('.xterm,.ai-terminal-surface,.ai-terminal-keys').count(),0,'Empty workrooms must not allocate or display an inert terminal');
    assert.ok(await panel.getByText('프로젝트·워크트리',{exact:true}).isVisible());assert.ok(await panel.getByText('AI',{exact:true}).isVisible());
    // The empty request box is folded by default (2026-10-05); 「작업 시작」 opens a terminal without a request.
    assert.equal(await panel.getByTestId('workroom-composer').count(),0,'The empty request box starts folded');assert.ok(await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled());
    const composerToggle=panel.getByTestId('workroom-composer-toggle');assert.equal(await composerToggle.getAttribute('aria-expanded'),'false');assert.equal(await composerToggle.innerText(),'요청 적고 시작하기');
    await composerToggle.click();assert.ok(await panel.getByLabel('터미널에 전달할 작업').isVisible());assert.ok(await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled());
    assert.equal(await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).count(),0);assert.equal(await panel.locator('.xterm,.ai-terminal-surface,.ai-terminal-keys').count(),0,'Opening the request box must not allocate a terminal');
    assert.equal(await panel.getByTestId('workroom-memory-history').getAttribute('open'),null);assert.equal(await panel.locator('.ai-terminal-memory-row').count(),0);
    assert.match(await panel.getByTestId('workroom-memory-purpose').innerText(),/작업 내용이 저장됐는지 확인하는 곳.*로컬 장기기억 저장과 Supabase 백업/s);
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
    assert.match(await live.innerText(),/세션 기억 저장 실패 · 로컬 저장 원인 확인 3건/);assert.doesNotMatch(await live.innerText(),/세션 기억 저장 중/);
  },{jobs:[...attention,...completed]});

  await run('current-context-and-new-target-keep-cli-and-draft-on-failure',async({page,panel,state})=>{
    await panel.locator('.xterm').waitFor();await panel.getByLabel('터미널 프로젝트').selectOption(B);await panel.getByLabel('터미널 AI').selectOption('claude');
    const draft='선택한 워크트리에서 한글 작업을 검토해 주세요. 기존 변경은 보존합니다.';await panel.getByLabel('터미널에 전달할 작업').fill(draft);
    await panel.getByRole('button',{name:'요청 칸 접기',exact:true}).click();
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').count(),0);assert.ok(await panel.getByRole('button',{name:'작성 중인 요청 다시 보기',exact:true}).isVisible());
    await panel.getByLabel('터미널 AI').selectOption('hermes');assert.equal(await panel.getByTestId('workroom-prompt-support').count(),0);assert.ok(await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled());
    await panel.getByLabel('터미널 AI').selectOption('claude');await panel.getByRole('button',{name:'작성 중인 요청 다시 보기',exact:true}).click();assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),draft);
    const context=await panel.getByTestId('workroom-target-context').innerText();assert.ok(context.includes(`현재 세션: ${projects[0].label}`)&&context.includes(`시작할 작업: ${projects[1].label}`));
    await panel.getByRole('button',{name:'프로젝트·장기기억',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__workroomActions),[{action:'manage',id:A}]);
    state.startError=true;await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();await panel.getByRole('alert').filter({hasText:'Fixture CLI start refused'}).waitFor();
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),draft);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'claude');assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);
    assert.equal(starts(state).length,1);assert.deepEqual([starts(state)[0].targetId,starts(state)[0].agent,starts(state)[0].prompt],[B,'claude',draft]);
    state.startError=false;await panel.getByRole('button',{name:'선택한 AI로 시작',exact:true}).click();
    await until(async()=>/기억 B/.test(await panel.getByRole('tab',{selected:true}).innerText()),'Retry should select the new session on B');assert.equal(starts(state).length,2);
    assert.deepEqual([starts(state)[1].targetId,starts(state)[1].agent,starts(state)[1].prompt],[B,'claude',draft]);
  },{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA,prompt:'전달받은 초안',agent:'codex'},listDelayMs:150,jobs:[]});

  await run('unknown-target-never-launches-and-every-agent-carries-a-prompt',async({page,panel,state})=>{
    const draft=panel.getByLabel('터미널에 전달할 작업'),start=panel.getByRole('button',{name:'작업 시작',exact:true});
    assert.equal(await draft.inputValue(),'보존해야 할 전달 작업');assert.ok(await start.isDisabled());assert.ok((await panel.getByLabel('터미널 프로젝트').innerText()).includes('프로젝트 연결 확인 필요'));
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    // Every workroom agent now carries an initial prompt; the server picks the CLI-specific
    // argv form (hermes `chat -q`, agy `-i`, codex/claude positional `--`). The caption that
    // used to explain the codex/claude-only limit is gone, so its removal must not leave the
    // header collapsed or push the launch controls out of the panel at any agent.
    for(const agent of ['hermes','agy','codex','claude']){
      await panel.getByLabel('터미널 AI').selectOption(agent);
      assert.ok(await start.isEnabled(),`${agent} should accept a prompt`);
      assert.equal(await panel.getByTestId('workroom-prompt-support').count(),0);
      assert.equal(await draft.inputValue(),'보존해야 할 전달 작업');
      const geometry=await layout(page,panel);
      const box=await start.boundingBox();
      assert.ok(box&&box.width>0&&box.height>=28,`${agent}: launch control not usable ${JSON.stringify(box)}`);
      assert.ok(box.x>=0&&box.x+box.width<=geometry.viewport+2,`${agent}: launch control outside viewport ${JSON.stringify({box,viewport:geometry.viewport})}`);
      assert.equal(await start.evaluate(n=>n.scrollWidth>n.clientWidth+1),false,`${agent}: launch label clipped`);
      await page.screenshot({path:new URL(`workroom-agent-${agent}.png`,output).pathname});
    }
    await panel.getByLabel('터미널 AI').selectOption('hermes');await start.click();
    await until(()=>starts(state).length===1,'A Hermes launch should carry the drafted prompt');assert.equal(starts(state)[0].agent,'hermes');assert.equal(starts(state)[0].targetId,B);assert.equal(starts(state)[0].prompt,'보존해야 할 전달 작업');
  },{entry:{nonce:1,targetId:'fixture-missing-project',prompt:'보존해야 할 전달 작업'},jobs:[]});

  // w2-followups #15: an older host without launch receipts. The first start opened the CLI but its answer was lost;
  // retrying the same request asks first instead of opening a second CLI that runs it again.
  await run('legacy-start-retry-asks-before-a-second-cli',async({page,panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'The start is available');await start.click();
    await panel.getByRole('alert').filter({hasText:'Fixture: start answer lost'}).waitFor();
    assert.equal(starts(state).length,1);assert.equal(state.sessions.filter(s=>s.id.startsWith('fixture-started-')).length,1,'The lost start did open one CLI');
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),'같은 요청');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.dismiss();});
    await until(async()=>await start.isEnabled(),'The start is available again');await start.click();
    await until(()=>asked!=='','The retry did not ask before starting again');
    assert.match(asked,/새 세션을 하나 더/);
    await until(async()=>/기억 A/.test(await panel.getByRole('tab',{selected:true}).innerText().catch(()=>'')),'Declining selects the session that opened');
    // Choosing the session that opened is an outcome, not a failure (2026-10-16 audit): a status line, not the red alert with 「VOC 보내기」.
    await panel.getByTestId('workroom-notice').filter({hasText:'앞서 열린 세션을 선택했습니다'}).waitFor();
    assert.equal(await panel.locator('.ai-terminal-error').filter({hasText:'앞서 열린 세션을 선택했습니다'}).count(),0);
    assert.equal(starts(state).length,1,'Declining never starts a second CLI');
    assert.equal(await panel.getByLabel('터미널에 전달할 작업').inputValue(),'같은 요청','The draft stays');
    // Asked again until the user decides; accepting starts the second CLI on purpose.
    asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.accept();});
    await until(async()=>await start.isEnabled(),'The start is available again');await start.click();
    await until(()=>asked!==''&&starts(state).length===2,'Accepting starts the second CLI');
    // The notice described the declined retry; a new action ends it, as it used to end the same line in the alert box
    // (review 2026-10-16: 「같은 요청은 다시 보내지 않았고」 stayed up beside the second CLI started with that request).
    await until(async()=>await panel.getByTestId('workroom-notice').count()===0,'The earlier notice is gone once a new start begins');
  },{entry:{nonce:1,targetId:A,prompt:'같은 요청'},jobs:[],loseStartAnswer:true});

  // w4 L2: with site data blocked the mount used to read the throwing getter as an unreadable launch record that blocked
  // every start until dismissed. Unusable storage is no storage: the start goes plainly, the panel says so once, and the
  // older-Mac guard keeps the failed start in this page's memory so the retry still asks.
  await run('blocked-storage-starts-plainly-says-so-once-and-still-asks-on-retry',async({page,panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    const notice=panel.getByTestId('workroom-launch-storage-notice');await notice.waitFor();
    assert.equal(await notice.count(),1,'Said once');
    assert.equal(await panel.getByTestId('workroom-launch-recovery').count(),0,'No blocking record for storage that does not exist');
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'Starting is not blocked');await start.click();
    await panel.getByRole('alert').filter({hasText:'Fixture: start answer lost'}).waitFor();
    assert.equal(starts(state).length,1);assert.equal(starts(state)[0].prompt,'같은 요청');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch).length,0,'No launch without a place for its record');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.dismiss();});
    await until(async()=>await start.isEnabled(),'The start is available again');await start.click();
    await until(()=>asked!=='','The retry asks first, from this page\'s memory');
    assert.match(asked,/새 세션을 하나 더/);
    assert.equal(starts(state).length,1,'Declining never starts a second CLI');
    await notice.getByRole('button',{name:'확인',exact:true}).click();
    await until(async()=>await notice.count()===0,'The notice can be put away');
  },{entry:{nonce:1,targetId:A,prompt:'같은 요청'},jobs:[],launchHost:true,blockSessionStorage:true,loseStartAnswer:true});

  // ...while a launch record that is there but unreadable still blocks: it may be a real unsettled launch.
  await run('an-unreadable-launch-record-in-working-storage-still-blocks',async({panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByTestId('workroom-launch-recovery').waitFor();
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await sleep(200);
    assert.ok(await start.isDisabled(),'A corrupt record blocks the start');
    assert.equal(await panel.getByTestId('workroom-launch-storage-notice').count(),0,'Working storage is not reported as missing');
    assert.equal(starts(state).length,0);
  },{entry:{nonce:1,targetId:A,prompt:'같은 요청'},jobs:[],launchHost:true,sessionStorageSeed:{'agentstoz:pending-launch:v1:workroom-usability-fixture':'not json'}});

  // w4 review, finding 3: storage that is full still reads. A real launch record there must keep blocking the start of the
  // same target and AI (it may have opened a CLI with this request); only new records cannot be kept.
  await run('full-storage-still-blocks-on-a-readable-launch-record',async({panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    await panel.getByTestId('workroom-launch-recovery').waitFor();
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await sleep(200);
    assert.ok(await start.isDisabled(),'A readable unsettled launch of this target and AI blocks the start');
    assert.equal(starts(state).length,0);
  },{entry:{nonce:1,targetId:A,prompt:'같은 요청'},jobs:[],launchHost:true,fullSessionStorage:true,
    sessionStorageSeed:{'agentstoz:pending-launch:v1:workroom-usability-fixture':JSON.stringify({id:'fixture-launch-0001',targetId:A,agent:'codex',receipt:null})}});

  // ...and a readable unsettled submission keeps its banner and refuses the send instead of typing past it as raw input.
  await run('full-storage-still-blocks-on-a-readable-submission-record',async({panel,state})=>{
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    await panel.getByTestId('workroom-submission-recovery').waitFor();
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('두 번 실행되면 안 되는 요청');
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click().catch(()=>{});
    await sleep(400);
    assert.ok(state.requests.every(r=>!(r.operation==='input'&&String(r.data).includes('두 번 실행되면 안 되는 요청'))),'Nothing is typed past the record');
    assert.ok(state.requests.every(r=>!(r.operation==='submission'&&r.sessionId===SA&&['single','begin'].includes(r.submission?.phase))),'No second submission');
    assert.equal(await composer.inputValue(),'두 번 실행되면 안 되는 요청','The draft stays');
  },{sessions:[session(SA,A,'running','codex')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,fullSessionStorage:true,
    sessionStorageSeed:{['agentstoz:pending-submission:v1:workroom-usability-fixture:'+SA]:JSON.stringify({id:'fixture-submission-0001',sessionId:SA,receipt:null})}});

  // The same convention for running sessions: without a place for the pending record a request goes as raw input, as the
  // LAN page already does — never a record-less submission, and never an «unreadable record» on every session selected.
  await run('blocked-storage-sends-raw-input-instead-of-a-record-less-submission',async({panel,state})=>{
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('그대로 보낼 요청');
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.sessionId===SA&&String(r.data).includes('그대로 보낼 요청')),'The request goes as raw input');
    assert.ok(state.requests.every(r=>!(r.operation==='submission'&&r.sessionId!==undefined&&['single','begin'].includes(r.submission?.phase))),'No record-less submission');
    assert.equal(await panel.getByText('이전 제출 기록을 확인하지 못했습니다').count(),0,'No unreadable record for storage that does not exist');
    await until(async()=>await composer.inputValue()==='','The draft clears once admitted');
  },{sessions:[session(SA,A,'running','codex')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,blockSessionStorage:true});

  // w11 review (finding 9): 「보내는 중…」 is the phone's. On the Mac (and a pop-out, a desktop browser) a submission in flight
  // keeps the recovery banner it always had, with its plain buttons, and the button still reads 「요청 전송 확인 중」.
  await run('mac-submission-in-flight-keeps-the-recovery-banner',async({panel,state})=>{
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    let release;state.sessionSubmitBarrier=new Promise(resolve=>{release=resolve;});
    await panel.getByLabel('워크룸 입력').fill('맥에서 보내는 요청');
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(()=>state.sessionSubmitWaiting,'The submission is in flight');
    await panel.getByTestId('workroom-submission-recovery').waitFor({timeout:3000});
    assert.equal(await panel.getByTestId('workroom-submission-sending').count(),0,'No 「보내는 중…」 on the Mac');
    assert.equal(await panel.getByRole('button',{name:'요청 전송 확인 중',exact:true}).count(),1,'The send button keeps its Mac label');
    for(const name of ['제출 결과 확인','터미널 결과 확인했음'])assert.equal(await panel.getByRole('button',{name,exact:true}).getAttribute('class'),null,`「${name}」 keeps its Mac style`);
    release();
    await panel.getByTestId('workroom-submission-recovery').waitFor({state:'detached',timeout:5000});
  },{sessions:[session(SA,A,'running','codex')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,holdSessionSubmission:true});

  // Integration review w4 (4a): with 「작성 내용 보관」 on, a direct send that goes as raw input (here: session storage refuses
  // the submission record) is not kept in the vault — the composer says so, as it does when a seal fails, and never silently.
  for(const vaultOn of [true,false])await run(`raw-send-with-the-vault-${vaultOn?'on-says-it-was-not-kept':'off-says-nothing-about-keeping'}`,async({panel,state})=>{
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('보관함을 거치지 않는 요청');
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.sessionId===SA&&String(r.data).includes('보관함을 거치지 않는 요청')),'The request goes as raw input');
    assert.ok(state.requests.every(r=>!(r.operation==='submission'&&r.sessionId!==undefined&&['single','begin'].includes(r.submission?.phase))),'No record-less submission');
    const notice=panel.getByText('작성 내용 보관함에 넣지 않았습니다');
    if(vaultOn)await notice.first().waitFor({timeout:3000});
    else{await sleep(300);assert.equal(await notice.count(),0,'Nothing to say with the vault off');}
  },{sessions:[session(SA,A,'running','codex')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,fullSessionStorage:true,
    ...(vaultOn?{localStorageSeed:{'agentstoz:workroom-draft-vault:v1':'on'}}:{})});

  // Audit 2026-10-16 (S3-8): requests kept for a session that ended were listed only under that session, so they could
  // not be checked, taken back or deleted, yet filled the device-wide limit. They are now listed under the running
  // session's queue with only a status check of the original id under its own session, a take-back when nothing ran,
  // and delete — never a send. Seeded through the page's own vault (real IndexedDB + WebCrypto in this origin).
  const seedKeptDrafts=page=>page.evaluate(async({SA,SE})=>{
    const m=await import('/src/workroomDraftVault.ts');const vault=m.createGatedDraftVault({flags:localStorage});const scope='workroom-usability-fixture';
    await vault.save({scope,sessionId:SE,submissionId:'kept-ended-queued1',text:'앞 세션에 보관만 한 요청\r',references:[]});
    await vault.save({scope,sessionId:SE,submissionId:'kept-ended-refused',text:'거절된 요청\r',references:[],attempted:true});
    await vault.save({scope,sessionId:SE,submissionId:'kept-ended-written',text:'전달된 요청\r',references:[],attempted:true});
    await vault.save({scope:'another-mac-scope',sessionId:SE,submissionId:'kept-elsewhere-01',text:'다른 Mac 요청\r',references:[]});
    await vault.save({scope,sessionId:SA,submissionId:'kept-current-sa01',text:'지금 세션 요청\r',references:[]});
    m.announceDraftVaultOptIn();
  },{SA,SE});
  const keptOptions={sessions:[session(SA,A,'running','codex'),session(SE,A,'exited','codex')],jobs:[],launchHost:true,
    localStorageSeed:{'agentstoz:workroom-draft-vault:v1':'on'},
    keptReceipts:{'kept-ended-refused':{sessionId:SE,state:'rejected'},'kept-ended-written':{sessionId:SE,state:'written'}}};
  const sentNothing=state=>{
    assert.ok(state.requests.every(r=>r.operation!=='input'),'Nothing is typed into any session');
    assert.ok(state.requests.every(r=>!(r.operation==='submission'&&['single','begin','chunk','commit'].includes(r.submission?.phase))),'Nothing is submitted');
    for(const r of state.requests.filter(r=>r.operation==='submission'&&String(r.submission?.id).startsWith('kept-ended-')))
      assert.equal(r.sessionId,SE,'A kept request is asked about only under the session it was kept for');
  };
  await run('kept-requests-of-an-ended-session-stay-reachable-from-the-running-session',async({page,panel,state})=>{
    const queue=panel.getByTestId('workroom-draft-queue');await queue.waitFor();
    await seedKeptDrafts(page);
    const earlier=queue.getByTestId('workroom-draft-queue-earlier');
    await until(async()=>await earlier.getByTestId('workroom-draft-queue-earlier-item').count()===3,'The ended session\'s three requests are listed');
    assert.equal(await earlier.getByTestId('workroom-draft-queue-send').count(),0,'An earlier session\'s request is never sent from here');
    assert.equal(await queue.getByTestId('workroom-draft-queue-item').count(),1,'The running session keeps its own stopped queue');
    const summary=await queue.getByTestId('workroom-draft-vault-settings').locator('summary').innerText();
    assert.match(summary,/정지된 요청 1개/);assert.match(summary,/다른 세션 3개/);
    assert.match(await queue.getByTestId('workroom-draft-queue-elsewhere').innerText(),/1개/);
    const item=id=>earlier.getByTestId('workroom-draft-queue-earlier-item').filter({hasText:id});
    const composer=panel.getByLabel('워크룸 입력');
    // Refused: the receipt proves nothing ran, so it may go back to an empty composer.
    await item('거절된 요청').getByTestId('workroom-draft-queue-check').click();
    await item('거절된 요청').getByTestId('workroom-draft-queue-note').filter({hasText:'실행되지 않았습니다'}).waitFor();
    await composer.fill('작성 중인 글');
    await item('거절된 요청').getByTestId('workroom-draft-queue-take-back').click();
    await queue.getByTestId('workroom-draft-queue-message').filter({hasText:'입력칸을 비운 뒤'}).waitFor();
    assert.equal(await composer.inputValue(),'작성 중인 글','A composer that holds text is never replaced');
    await composer.fill('');
    await item('거절된 요청').getByTestId('workroom-draft-queue-take-back').click();
    await until(async()=>await composer.inputValue()==='거절된 요청','The refused request is back in the composer');
    await until(async()=>await item('거절된 요청').count()===0,'Taken back, the kept copy goes');
    // Written: delivered already, so the copy goes and nothing else happens.
    await item('전달된 요청').getByTestId('workroom-draft-queue-check').click();
    await until(async()=>await item('전달된 요청').count()===0,'A delivered request leaves the queue');
    await queue.getByTestId('workroom-draft-queue-message').filter({hasText:'전달됐습니다'}).waitFor();
    // Never sent anywhere: it may go back without a status check (it is claimed first).
    await composer.fill('');
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-take-back').click();
    await until(async()=>await composer.inputValue()==='앞 세션에 보관만 한 요청','The never-sent request is back in the composer');
    await until(async()=>await earlier.getByTestId('workroom-draft-queue-earlier-item').count()===0,'Every earlier request is settled');
    assert.deepEqual(state.requests.filter(r=>r.operation==='submission'&&String(r.submission?.id).startsWith('kept-ended-')).map(r=>r.submission.id).sort(),
      ['kept-ended-refused','kept-ended-written'],'Only the attempted ones were asked about, once each');
    sentNothing(state);
  },{...keptOptions,entry:{nonce:1,targetId:A,sessionId:SA}});
  await run('kept-requests-stay-listed-while-the-selected-session-has-ended',async({page,panel,state})=>{
    await panel.getByTestId('workroom-exited-hint').waitFor();
    const queue=panel.getByTestId('workroom-draft-queue');await queue.waitFor();
    await seedKeptDrafts(page);
    const earlier=queue.getByTestId('workroom-draft-queue-earlier');
    // No composer here: every request of the scope is an earlier one, including the running session's.
    await until(async()=>await earlier.getByTestId('workroom-draft-queue-earlier-item').count()===4,'All four requests of this scope are listed');
    assert.equal(await queue.getByTestId('workroom-draft-queue-add').count(),0,'Nothing to keep without a composer');
    assert.equal(await queue.getByTestId('workroom-draft-queue-send').count(),0);
    const queued=earlier.getByTestId('workroom-draft-queue-earlier-item').filter({hasText:'앞 세션에 보관만 한 요청'});
    assert.ok(await queued.getByTestId('workroom-draft-queue-take-back').isDisabled(),'No composer to take it back into');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.accept();});
    await queued.getByTestId('workroom-draft-queue-delete').click();
    await until(()=>asked!=='','Deleting warns first');assert.match(asked,/터미널을 먼저 확인/);
    await until(async()=>await earlier.getByTestId('workroom-draft-queue-earlier-item').count()===3,'The deleted request goes');
    sentNothing(state);
  },{...keptOptions,entry:{nonce:1,targetId:A,sessionId:SE}});
  // w5 review: a note that says 「결과 확인」을 누르세요 must come with that button, and an answer that settles nothing
  // (a take-back that lost the claim to another window, a receipt still in flight) leaves the check available.
  const reCheckOptions={...keptOptions,keptReceipts:{...keptOptions.keptReceipts,'kept-ended-pending':{sessionId:SE,state:'write_started'}}};
  await run('kept-request-check-stays-available-after-a-lost-claim-or-an-unsettled-receipt',async({page,panel,state})=>{
    const queue=panel.getByTestId('workroom-draft-queue');await queue.waitFor();
    await seedKeptDrafts(page);
    await page.evaluate(async({SE})=>{const m=await import('/src/workroomDraftVault.ts');const vault=m.createGatedDraftVault({flags:localStorage});
      await vault.save({scope:'workroom-usability-fixture',sessionId:SE,submissionId:'kept-ended-pending',text:'실행 중이던 요청\r',references:[],attempted:true});m.announceDraftVaultOptIn();},{SE});
    const earlier=queue.getByTestId('workroom-draft-queue-earlier');
    const item=text=>earlier.getByTestId('workroom-draft-queue-earlier-item').filter({hasText:text});
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-take-back').waitFor();
    // Another window pressed 「보내기」 on it meanwhile: its claim marks it as handed to a transport.
    assert.equal(await page.evaluate(async({SE})=>{const m=await import('/src/workroomDraftVault.ts');
      return m.createGatedDraftVault({flags:localStorage}).claimForSend('workroom-usability-fixture',SE,'kept-ended-queued1');},{SE}),'fresh');
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-take-back').click();
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-note').filter({hasText:'다른 창에서 이미 보냈거나'}).waitFor();
    assert.equal(await panel.getByLabel('워크룸 입력').inputValue(),'','Nothing was taken back');
    await until(async()=>await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-check').count()===1,'The note asks for 「결과 확인」, so the button is there');
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-check').click();
    await item('앞 세션에 보관만 한 요청').getByTestId('workroom-draft-queue-take-back').filter({hasText:'터미널 확인 후'}).waitFor();
    // A receipt still in flight settles nothing: the check stays, and a later answer settles it.
    await item('실행 중이던 요청').getByTestId('workroom-draft-queue-check').click();
    await item('실행 중이던 요청').getByTestId('workroom-draft-queue-note').filter({hasText:'결과 미확인'}).waitFor();
    assert.equal(await item('실행 중이던 요청').getByTestId('workroom-draft-queue-take-back').count(),0,'An unsettled request is never taken back');
    await until(async()=>await item('실행 중이던 요청').getByTestId('workroom-draft-queue-check').count()===1,'It can be checked again');
    reCheckOptions.keptReceipts['kept-ended-pending']={sessionId:SE,state:'written'};
    await item('실행 중이던 요청').getByTestId('workroom-draft-queue-check').click();
    await until(async()=>await item('실행 중이던 요청').count()===0,'Delivered after all, the copy goes');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.id==='kept-ended-pending').length,2,'Two status reads, nothing else');
    sentNothing(state);
  },{...reCheckOptions,entry:{nonce:1,targetId:A,sessionId:SA}});
  // w5 review: requests kept for another connection (a device that left, a Mac removed from the phone) can be cleared
  // from here after a warning — no panel may ever open their scope again, and they fill the device-wide limit.
  await run('kept-requests-of-another-connection-can-be-cleared-here',async({page,panel,state})=>{
    const queue=panel.getByTestId('workroom-draft-queue');await queue.waitFor();
    await seedKeptDrafts(page);
    const elsewhere=queue.getByTestId('workroom-draft-queue-elsewhere');
    await until(async()=>/1개/.test(await elsewhere.innerText().catch(()=>'')),'The other connection\'s request is counted');
    const hint=await elsewhere.innerText();
    assert.doesNotMatch(hint,/그 연결의 워크룸에서 확인하거나 지울 수 있고/,'The hint does not promise a workroom that may be gone');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.dismiss();});
    await elsewhere.getByTestId('workroom-draft-queue-elsewhere-delete').click();
    await until(()=>asked!=='','Clearing warns first');assert.match(asked,/1개/);assert.match(asked,/내용을 볼 수 없/);
    await sleep(300);
    assert.equal(await page.evaluate(async()=>{const m=await import('/src/workroomDraftVault.ts');return (await m.createGatedDraftVault({flags:localStorage}).listScope('another-mac-scope')).drafts.length;}),1,'Declined, nothing goes');
    page.once('dialog',dialog=>dialog.accept());
    await elsewhere.getByTestId('workroom-draft-queue-elsewhere-delete').click();
    await queue.getByTestId('workroom-draft-queue-message').filter({hasText:'다른 연결에 보관한 요청 1개를 지웠습니다'}).waitFor();
    await until(async()=>await elsewhere.count()===0,'Nothing is left elsewhere');
    assert.equal(await page.evaluate(async()=>{const m=await import('/src/workroomDraftVault.ts');return (await m.createGatedDraftVault({flags:localStorage}).listScope('another-mac-scope')).drafts.length;}),0);
    assert.equal(await queue.getByTestId('workroom-draft-queue-earlier-item').count(),3,'This scope\'s kept requests stay');
    assert.equal(await queue.getByTestId('workroom-draft-queue-item').count(),1);
    sentNothing(state);
  },{...keptOptions,entry:{nonce:1,targetId:A,sessionId:SA}});
  // w5 review: with the vault off (the default) an ended session shows no vault block at all — there is no composer.
  await run('ended-session-shows-no-vault-block-while-the-vault-is-off',async({panel})=>{
    await panel.getByTestId('workroom-exited-hint').waitFor();await sleep(400);
    assert.equal(await panel.getByTestId('workroom-draft-queue').count(),0,'No vault UI on an ended session while keeping is off');
    assert.equal(await panel.getByTestId('workroom-draft-vault-settings').count(),0);
  },{sessions:[session(SA,A,'running','codex'),session(SE,A,'exited','codex')],jobs:[],launchHost:true,entry:{nonce:1,targetId:A,sessionId:SE}});

  // w4 L1: an @ route to a Mac without launch receipts opens its new session plainly. That answer was lost, but the CLI
  // opened with the handoff; sending the same draft again asks first and, declined, sends nothing.
  await run('legacy-route-retry-asks-before-a-second-cli',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill((await composer.inputValue())+'한 번만 실행할 요청');
    const draft=await composer.inputValue();
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByRole('alert').filter({hasText:'Fixture: start answer lost'}).waitFor();
    assert.equal(starts(state).length,1);assert.match(starts(state)[0].prompt,/한 번만 실행할 요청/);
    assert.equal(await composer.inputValue(),draft,'A lost start keeps the draft');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.dismiss();});
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await until(()=>asked!=='','The retry asks before anything');
    assert.match(asked,/앞서 보낸 전달은 실패로 보였지만/);
    await panel.getByTestId('workroom-route-receipt').filter({hasText:'보내지 않았습니다'}).waitFor();
    assert.equal(starts(state).length,1,'Declining never starts a second CLI');
    assert.ok(state.requests.every(r=>r.operation!=='input'),'Nothing is typed into the session that opened');
    assert.equal(await composer.inputValue(),draft,'The draft stays');
  },{sessions:[session(SA,A,'running','agy')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],loseStartAnswer:true});

  // w4 review, finding 1: declining that question keeps the draft, and 「그 세션으로 이동」 clears the @ chip. The protection
  // must not ride on the chip: sending the same draft into the session that may already run it asks first.
  await run('legacy-route-held-session-asks-before-the-composer-sends-the-same-draft',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill((await composer.inputValue())+'한 번만 실행할 요청');
    const draft=await composer.inputValue();
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByRole('alert').filter({hasText:'Fixture: start answer lost'}).waitFor();
    page.once('dialog',dialog=>dialog.dismiss());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-route-receipt').filter({hasText:'보내지 않았습니다'}).waitFor();
    const opened=starts(state).length&&state.sessions.find(s=>s.targetId===B&&s.agent===starts(state)[0].agent);
    assert.ok(opened,'The lost start opened a session');
    await panel.getByTestId('workroom-route-jump').click();
    await until(async()=>await panel.getByTestId('workroom-route-receipt').count()===0,'Moving to that session clears the receipt and the chip');
    assert.equal(await composer.inputValue(),draft,'The draft stays');
    let asked='';page.once('dialog',async dialog=>{asked=dialog.message();await dialog.dismiss();});
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(()=>asked!=='','Sending the same draft into that session asks first');
    assert.match(asked,/이미 받았을 수 있습니다/);
    await sleep(300);
    assert.ok(state.requests.every(r=>!(r.operation==='input'&&r.sessionId===opened.id)),'Declined: nothing is typed into it');
    assert.ok(state.requests.every(r=>!(r.operation==='submission'&&r.sessionId===opened.id)),'Declined: nothing is submitted to it');
    assert.equal(await composer.inputValue(),draft,'The draft stays');
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(()=>state.requests.some(r=>r.operation==='input'&&r.sessionId===opened.id&&String(r.data).includes('한 번만 실행할 요청')),'Accepted: it goes once, as the user chose');
  },{sessions:[session(SA,A,'running','agy')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],loseStartAnswer:true});

  await run('launch-receipt-recovers-a-lost-start-without-a-second-cli',async({page,panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'The launch can start');await start.click();
    const banner=panel.getByTestId('workroom-launch-recovery');await banner.waitFor();
    const launchedOnce=()=>state.requests.filter(r=>r.operation==='submission'&&r.submission?.phase==='single');
    assert.equal(launchedOnce().length,1);assert.equal(launchedOnce()[0].sessionId,undefined);assert.equal(launchedOnce()[0].submission.launch.targetId,A);
    assert.equal(starts(state).length,0,'A launch host never receives a plain start');
    // While unsettled, the same target and AI cannot start again — a retry could open a second CLI.
    assert.ok(await start.isDisabled());
    await panel.getByTestId('workroom-launch-check').click();
    await until(async()=>await banner.count()===0,'Status settles the launch');
    assert.equal(state.sessions.filter(s=>s.id.startsWith('fixture-launched-')).length,1,'Exactly one CLI started');
    assert.equal(launchedOnce().length,1,'Checking never re-sends the request');
    assert.ok(state.requests.every(r=>r.operation!=='input'),'Recovery never types into a terminal');
  },{entry:{nonce:1,targetId:A,prompt:'새 세션 첫 요청'},jobs:[],launchHost:true,loseLaunchAnswer:true,loseFirstStatus:true});

  await run('lost-launch-answer-settles-from-one-read-only-status',async({panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'The launch can start');await start.click();
    await until(()=>state.requests.some(r=>r.operation==='submission'&&r.submission?.phase==='status'),'One status follows the lost answer');
    await until(async()=>await panel.getByTestId('workroom-launch-recovery').count()===0&&state.requests.filter(r=>r.operation==='submission'&&r.submission?.phase==='status').length===1,'The written status settles it without a banner');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.phase==='single').length,1,'Never re-sent');
    assert.equal(state.sessions.filter(s=>s.id.startsWith('fixture-launched-')).length,1,'Exactly one CLI started');
    assert.equal(starts(state).length,0);
  },{entry:{nonce:1,targetId:A,prompt:'새 세션 첫 요청'},jobs:[],launchHost:true,loseLaunchAnswer:true});

  await run('launch-refused-before-the-fence-does-not-leave-a-blocking-banner',async({panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('hermes');
    await until(async()=>await start.isEnabled(),'The launch can start');await start.click();
    await panel.getByRole('alert').filter({hasText:'hermes CLI가 설치되어 있지 않습니다.'}).waitFor();
    await until(async()=>await panel.getByTestId('workroom-launch-recovery').count()===0,'A definitive refusal leaves no recovery banner');
    await until(async()=>await start.isEnabled(),'The same target and AI can start again by hand');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.phase==='single').length,1,'Nothing is re-sent automatically');
    assert.equal(starts(state).length,0);assert.ok(state.requests.every(r=>r.operation!=='input'));
  },{entry:{nonce:1,targetId:A,prompt:'헤르메스 첫 요청'},jobs:[],launchHost:true,refuseLaunch:'hermes CLI가 설치되어 있지 않습니다.'});

  await run('older-forwarding-mac-falls-back-to-a-plain-start',async({panel,state})=>{
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    // The mount-time `recent` already meets the older forwarder; if the click wins that race, the launch itself is
    // refused unparsed. Either way nothing runs twice and the start goes out as a plain `start`.
    await until(()=>state.requests.some(r=>r.operation==='submission'&&r.submission?.phase==='recent'),'Recovery asks `recent` first');
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'The start is available');await start.click();
    const launches=()=>state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch).length;
    await until(async()=>starts(state).length===1||launches()===1&&await panel.getByRole('alert').filter({hasText:'전체 요청 제출을 아직 받지 않습니다'}).count()===1,'Either a plain start or an unsupported notice');
    if(starts(state).length===0){await until(async()=>await start.isEnabled(),'Start is available again');await start.click();}
    await until(()=>starts(state).length===1,'A plain start carries the request');
    assert.equal(starts(state)[0].prompt,'새 세션 첫 요청');
    assert.ok(launches()<=1,'A refused launch is never retried');
    assert.equal(await panel.getByTestId('workroom-launch-recovery').count(),0,'A parse refusal ran nothing: no banner');
  },{entry:{nonce:1,targetId:A,prompt:'새 세션 첫 요청'},jobs:[],launchHost:true,oldForwarder:true});

  await run('lost-client-memory-rebuilds-the-launch-banner-read-only',async({panel,state})=>{
    // A reload or a killed app lost the pending record; the host still has an unsettled launch receipt for this owner.
    const banner=panel.getByTestId('workroom-launch-recovery');await banner.waitFor();
    assert.match(await banner.innerText(),/전달 여부 확인 불가/);assert.doesNotMatch(await banner.innerText(),/unknown/);
    assert.ok(state.requests.some(r=>r.operation==='submission'&&r.submission?.phase==='recent'&&r.sessionId===undefined),'Recovery asks `recent`');
    assert.ok(state.requests.every(r=>r.operation!=='input'&&r.operation!=='start'&&!(r.operation==='submission'&&['single','begin','chunk','commit'].includes(r.submission?.phase))),'Recovery is read-only');
    // A recovered launch blocks its own target and AI until the user settles it — not every start in this scope.
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isDisabled(),'The recovered target and AI cannot start again');
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    await until(async()=>await start.isEnabled(),'Another target is not blocked');
  },{jobs:[],launchHost:true,launches:{'fixture-launch-unknown-1':{state:'unknown',sessionId:'fixture-launched-gone',targetId:A,agent:'codex'}}});

  // w11 review (finding 6): on the phone the only start button is in the 「새 작업」 sheet, which covers the overview. A launch
  // whose outcome is unknown blocks that target and AI: the sheet itself says why and offers the check.
  await run('remote-fullscreen-sheet-shows-the-unsettled-launch-that-blocks-its-start',async({page,panel,state})=>{
    await panel.getByTestId('workroom-launch-recovery').waitFor();
    await page.getByTestId('workroom-new-task').click();
    const sheet=page.getByTestId('workroom-new-task-sheet');await sheet.waitFor();
    await sheet.getByLabel('터미널 프로젝트').selectOption(A);await sheet.getByLabel('터미널 AI').selectOption('codex');
    const start=sheet.getByTestId('workroom-new-task-start');
    await until(async()=>await start.isDisabled(),'The unsettled target and AI cannot start again');
    await sheet.getByTestId('workroom-new-task-blocked').waitFor({timeout:3000});
    const check=sheet.getByTestId('workroom-launch-check');await check.waitFor({timeout:3000});
    assert.ok(await check.evaluate(el=>{const r=el.getBoundingClientRect();el.scrollIntoView({block:'center'});const q=el.getBoundingClientRect();const hit=document.elementFromPoint(q.left+q.width/2,q.top+q.height/2);return !!hit&&(hit===el||el.contains(hit));}),'「새 세션 시작 결과 확인」 can be tapped in the sheet');
    assert.equal(await page.getByTestId('workroom-launch-check').count(),1,'one check button on the page');
    await check.click();
    await until(()=>state.requests.some(r=>r.operation==='submission'&&r.submission?.phase==='status'),'The check reads the launch status');
    await sheet.getByLabel('터미널 프로젝트').selectOption(B);
    await until(async()=>await sheet.getByTestId('workroom-new-task-blocked').count()===0,'Another target says nothing about the block');
  },{remote:true,sessionFullscreen:true,jobs:[],launchHost:true,launches:{'fixture-launch-unknown-1':{state:'unknown',sessionId:'fixture-launched-gone',targetId:A,agent:'codex'}}});

  // Review 2026-10-15 (finding 1): one launch record per scope let a launch of another target erase a launch whose
  // outcome was unknown. Records are kept per launch: the other target starts, and the earlier banner stays.
  await run('a-launch-of-another-target-keeps-the-unsettled-launch-banner',async({page,panel,state})=>{
    // A host without `recent`: a record erased here could not be found again from the host.
    const start=panel.getByRole('button',{name:'작업 시작',exact:true});
    await panel.getByLabel('터미널 프로젝트').selectOption(A);await panel.getByLabel('터미널 AI').selectOption('codex');
    await until(async()=>await start.isEnabled(),'The first launch can start');await start.click();
    const banner=panel.getByTestId('workroom-launch-recovery');await banner.waitFor();
    const firstId=[...state.launches.keys()][0];
    await panel.getByLabel('터미널 프로젝트').selectOption(B);
    await panel.getByLabel('터미널에 전달할 작업').fill('B 프로젝트 첫 요청');
    await until(async()=>await start.isEnabled(),'Another target is not blocked');await start.click();
    await until(()=>state.sessions.some(s=>s.id.startsWith('fixture-launched-')&&s.targetId===B),'The other target launched');
    await sleep(300);
    assert.equal(await banner.count(),1,'The earlier unsettled launch keeps its banner');
    assert.match(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('agentstoz:pending-launch:')).map(key=>sessionStorage.getItem(key)).join('')),new RegExp(firstId));
    await panel.getByLabel('터미널 프로젝트').selectOption(A);
    await until(async()=>await start.isDisabled(),'The earlier target and AI still cannot start again');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch&&r.submission.launch.targetId===A).length,1,'Never re-sent');
  },{entry:{nonce:1,targetId:A,prompt:'A 프로젝트 첫 요청'},jobs:[],launchHost:true,noRecent:true,unknownLaunchTarget:A});

  // Review 2026-10-15 (finding 2): an @ route's launch came back uncertain, so its draft stayed. When the status check
  // finds it written, the draft and route chip go too — sending again would type the same handoff into that session.
  await run('route-launch-settled-as-written-clears-its-draft',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill((await composer.inputValue())+'한 번만 실행할 요청');
    const draft=await composer.inputValue();
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    const banner=panel.getByTestId('workroom-launch-recovery');await banner.waitFor();
    assert.equal(await composer.inputValue(),draft,'An uncertain launch keeps the draft');
    await panel.getByTestId('workroom-launch-check').click();
    await until(async()=>await banner.count()===0,'The status settles the launch');
    await until(async()=>await composer.inputValue()==='','The draft of the launch that ran is cleared');
    assert.equal(await panel.getByTestId('workroom-route-plan').count(),0,'The route chip is cleared');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch).length,1,'Never re-sent');
    assert.ok(state.requests.every(r=>r.operation!=='input'&&r.operation!=='start'),'Nothing typed or started');
  },{sessions:[session(SA,A,'running','agy')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,loseLaunchAnswer:true,loseFirstStatus:true});

  // Integration review 2026-10-15 (A1): choosing another session clears the @ chip, and the protection of an uncertain
  // launch used to hang on that chip. The same draft sent from the composer into a session of that launch's target and
  // AI — possibly the very session it opened — is refused before anything is typed.
  await run('uncertain-route-launch-refuses-the-same-draft-after-a-session-switch',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');
    await until(()=>state.requests.some(r=>r.operation==='list'&&r.capabilities),'Capabilities are probed');
    await composer.fill('@기억');
    await panel.getByRole('listbox',{name:'호출할 프로젝트 선택'}).getByRole('option').filter({hasText:'기억 B'}).click();
    await composer.fill((await composer.inputValue())+'한 번만 실행할 요청');
    const draft=await composer.inputValue();
    page.once('dialog',dialog=>dialog.accept());
    await panel.getByRole('button',{name:'프로젝트에 전달',exact:true}).click();
    await panel.getByTestId('workroom-launch-recovery').waitFor();
    // The host could not tell whether the CLI took the request; the CLI did open.
    state.sessions.push(session('fixture-launched-late',B,'running','agy'));
    const launched=panel.getByRole('tab').filter({hasText:'기억 B'});
    await until(async()=>await launched.count()===1,'The session the launch opened is listed');
    await launched.click();
    await until(async()=>/기억 B/.test(await panel.getByRole('tab',{selected:true}).innerText()),'That session is selected');
    assert.equal(await panel.getByTestId('workroom-route-plan').count(),0,'The session switch cleared the route chip');
    assert.equal(await composer.inputValue(),draft,'The uncertain launch keeps its draft');
    const before=state.requests.length;
    await panel.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await until(async()=>/앞서 연 새 세션의 시작 결과가 아직 확정되지 않았습니다/.test(await panel.innerText()),'The send is refused with its reason');
    await sleep(300);
    assert.ok(state.requests.slice(before).every(r=>r.operation!=='input'&&!(r.operation==='submission'&&['single','begin','chunk','commit'].includes(r.submission?.phase))),'Nothing is typed into that session');
    assert.equal(await composer.inputValue(),draft,'The draft stays for the user to check');
    assert.equal(state.requests.filter(r=>r.operation==='submission'&&r.submission?.launch).length,1,'The launch is never re-sent');
  },{sessions:[session(SA,A,'running','agy')],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[],launchHost:true,unknownLaunchTarget:B});

  await run('save-recovery-prepares-the-correct-project-without-executing',async({page,panel,state})=>{
    const urgent=panel.getByTestId('workroom-memory-attention');await urgent.waitFor();
    await urgent.getByRole('button',{name:'새 AI로 원인 조사 요청',exact:true}).click();
    assert.equal(await panel.getByLabel('터미널 프로젝트').inputValue(),B);assert.equal(await panel.getByLabel('터미널 AI').inputValue(),'codex');
    assert.match(await panel.getByLabel('터미널에 전달할 작업').inputValue(),/세션 기억 저장 실패.*1건.*새 AI 세션/s);
    assert.equal(starts(state).length,0);
    await panel.getByRole('button',{name:'프로젝트·장기기억',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.__workroomActions),[{action:'manage',id:'fixture-project-bravo'}]);
  },{jobs:[{sessionId:'fixture-recovery-old',targetId:B,state:'failed'},...completed]});

  for(const active of [false,true])await run(`${active?'active':'empty'}-fits-default-and-minimum-window-at-125-percent`,async({page,panel})=>{
    if(active)await panel.locator('.xterm').waitFor();else await panel.getByTestId('workroom-memory-history').waitFor();
    for(const width of [1000,800]){await page.setViewportSize({width,height:1050});await sleep(80);await layout(page,panel);await panel.scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`workroom-usability-${active?'active':'empty'}-${width}-125.png`,output).pathname});}
    return{viewports:['1000×1050','800×1050'],zoom:'125%',sidebarLogicalWidth:264};
  },active?{sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:[]}:{jobs:completed});

  await run('mobile-390-pixel-controls-fit-without-tall-selects',async({page,panel,state})=>{
    const boxes=await panel.locator('select').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{name:node.getAttribute('aria-label'),height:r.height,left:r.left,right:r.right};}));
    assert.deepEqual(boxes.map(box=>box.name).sort(),['새 작업의 CLI 계정','터미널 프로젝트','터미널 AI'].sort());assert.ok(boxes.every(box=>box.height>=44&&box.height<=56&&box.left>=0&&box.right<=390),JSON.stringify(boxes));
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
    await panel.getByRole('button',{name:'요청 적고 시작하기',exact:true}).click();
    const draft=panel.getByLabel('터미널에 전달할 작업');
    await draft.fill('가'.repeat(8001));
    assert.ok(await panel.getByRole('button',{name:'작업 시작',exact:true}).isDisabled());
    assert.equal((await draft.inputValue()).length,8001);assert.equal(starts(state).length,0);
    await draft.fill('가'.repeat(8000));
    assert.ok(await panel.getByRole('button',{name:'작업 시작',exact:true}).isEnabled());
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
      await panel.getByRole('button',{name:'프로젝트·요청 고르기',exact:true}).click();await panel.getByLabel('터미널에 전달할 작업').waitFor();
      const expandedComposer=await verticalGeometry(panel);assertVerticalGeometry(expandedComposer);measurements.push({width,height,stage:'composer-expanded',...expandedComposer});
      await panel.getByRole('button',{name:'세션 종료',exact:true}).click({trial:true,timeout:2000});
      await page.screenshot({path:new URL(`workroom-usability-app-shell-bottom-${width}x${height}-125.png`,output).pathname});
      await panel.getByRole('button',{name:'요청 칸 접기',exact:true}).click();
    }
    await writeFile(new URL('workroom-usability-app-shell-geometry.json',output),JSON.stringify(measurements,null,2)+'\n');
    assert.equal(state.requests.filter(request=>request.operation==='close').length,0,'Close hit testing must not terminate even a fixture session');return{measurements};
  },{appShell:true,sessions:[session(SA,A)],entry:{nonce:1,targetId:A,sessionId:SA},jobs:completed});
}finally{await browser.close();await writeFile(new URL(focusedCase?'workroom-usability-focused-results.json':'workroom-usability-results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+'\n');}
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} Workroom usability groups passed`);
if(results.some(result=>result.status==='failed'))process.exitCode=1;
