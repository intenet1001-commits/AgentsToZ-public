import React,{useEffect,useMemo,useRef,useState} from 'react';
import {OwnedWorkroomBrowser,type OwnedBrowserControls} from './OwnedWorkroomBrowser';
import {PlatformGoogleClientSetup} from './PlatformGoogleClientSetup';
import {PlatformCliLoginPanel} from './PlatformCliLoginPanel';
import type {PlatformCliProvider} from './platformCliProtocol';
import type {BrowserWorkspace} from './workroomBrowserProtocol';
import {assistRecipe} from './helpdeskAssistRecipes';
import {assistBrowserRequester,nativeAssistTransport,type AssistTransport} from './helpdeskAssistClient';
import {ASSIST_CHECK_TEXT,ASSIST_TERMINAL,ASSIST_TITLE,GOOGLE_PROJECT_ID,GOOGLE_PROJECT_NAME,assistOutcomeText,assistScopeText,
 type AssistAi,type AssistBrowser,type AssistDecisions,type AssistIntent,type AssistRun,type AssistView} from './helpdeskAssistProtocol';
import './HelpdeskBrowserAssist.css';
const button='helpdesk-button';
/** The help's own built-in view: one native profile, no Workroom (helpdeskAssistOwnedBrowser). */
const ASSIST_SESSION='helpdesk-assist-browser';
const BROWSER_TEXT:Record<AssistBrowser,{name:string;note:string}>={
 ego:{name:'에고라이트',note:'에고라이트 앱 안에 이 도움 전용 작업 공간을 만들어 그 화면에서만 진행합니다.'},
 agentstoz:{name:'아젠투지브라우저',note:'이 창 안의 아젠투지브라우저에서 진행합니다. 평소 쓰는 브라우저 탭은 건드리지 않습니다.'},
};
const AI_TEXT:Record<AssistAi,{name:string;note:string}>={
 claude:{name:'Claude',note:'도구 없이 실행해, 화면에서 이미 찾은 후보 중 하나를 번호로만 고릅니다. 페이지 내용·주소·이메일은 보내지 않습니다.'},
 codex:{name:'Codex',note:''},
 none:{name:'AI 없이',note:'검토된 고정 단계만 진행하고, 애매한 화면에서는 직접 고르시도록 넘깁니다.'},
};
const PROVIDERS:Partial<Record<AssistIntent['service'],PlatformCliProvider>>={'google-workspace':'google-workspace',github:'github',supabase:'supabase',vercel:'vercel'};
const STEP_TEXT={pending:'대기',active:'진행 중',done:'완료',skipped:'이미 준비됨',human:'직접 진행',failed:'확인 필요'} as const;
const CHECK_STATE={unknown:'확인 전',pending:'기다리는 중',ok:'확인됨',failed:'확인 안 됨',skipped:'해당 없음'} as const;
const same=(a:AssistIntent,b:AssistIntent)=>a.service===b.service&&a.scope.kind===b.scope.kind&&a.scope.projectId===b.scope.projectId&&(a.email??'')===(b.email??'');
/** 헬프데스크 도움받기(with 에고라이트 또는 아젠투지브라우저). Nothing moves before the person confirms the scope; while it runs, the
 * person can pause, take the screen, continue or end it at any moment, and every sign-in, final approval or secret stays
 * theirs. The headline never turns a finished help into a working connection: only the real check says so. */
export function HelpdeskBrowserAssist({intent,onBack,onOpenStage,transport=nativeAssistTransport}:{intent:AssistIntent|null;onBack:()=>void;onOpenStage:(stage:'install'|'auth')=>void;transport?:AssistTransport}){
 const [view,setView]=useState<AssistView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [browser,setBrowser]=useState<AssistBrowser|null>(null),[ai,setAi]=useState<AssistAi>('none'),[confirmed,setConfirmed]=useState(false);
 const [projectMode,setProjectMode]=useState<'existing'|'new'>('existing'),[projectId,setProjectId]=useState(''),[projectName,setProjectName]=useState('AgentsToZ CLI');
 const [appName,setAppName]=useState('AgentsToZ'),[audience,setAudience]=useState<'external'|'internal'>('external');
 const [workspace,setWorkspace]=useState<BrowserWorkspace|null>(null);
 const [stepping,setStepping]=useState(false),applied=useRef<{runId:string;revision:number}|null>(null),advancing=useRef(false);
 const alive=useRef(true),lock=useRef(false),requestId=useRef(crypto.randomUUID()),controls=useRef<OwnedBrowserControls|null>(null),sentFor=useRef(-1);
 const run=view?.run??null,revision=view?.revision??0;
 /** Applies an answer only if it is not older than what is shown: a slow step's answer arriving after a pause or an end
  * never puts the earlier state back on screen. */
 function apply(v:AssistView){const shown=applied.current;if(shown&&v.run&&shown.runId===v.run.id&&v.revision<shown.revision)return;applied.current=v.run?{runId:v.run.id,revision:v.revision}:null;setView(v);}
 async function act(body:Record<string,unknown>,quiet=false){
  if(lock.current)return null;lock.current=true;setBusy(true);if(!quiet)setError('');
  try{const v=await transport(body);if(alive.current){apply(v);setError('');}return v;}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'결과를 확인하지 못했습니다. 상태를 다시 읽어 주세요. 자동으로 다시 보내지 않습니다.');return null;}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 /** One step of the help on its own path: it can take a minute (a browser call, a tool-free choice, a real CLI check), and
  * the person's pause, take or end never waits behind it. */
 async function advance(runId:string,expectedRevision:number){
  if(advancing.current)return;advancing.current=true;setStepping(true);
  try{const v=await transport({operation:'assist-advance',runId,expectedRevision});if(alive.current)apply(v);}
  catch(e){if(alive.current&&!lock.current)setError(e instanceof Error?e.message:'이 단계의 결과를 확인하지 못했습니다. 상태를 다시 읽어 주세요.');}
  finally{advancing.current=false;if(alive.current)setStepping(false);}
 }
 /** The person's control (pause, take, continue, end, …) against the latest revision, read fresh: a step in flight may
  * have moved it. A refusal for a changed revision applied nothing, so it is read again and sent once more. */
 async function control(operation:string,extra:Record<string,unknown>={}){
  if(!run||lock.current)return null;const id=run.id;lock.current=true;setBusy(true);setError('');
  try{
   for(let attempt=0;;attempt++){
    const fresh=await transport({operation:'assist-status',runId:id});if(!alive.current)return null;apply(fresh);if(!fresh.run||fresh.run.id!==id)return fresh;
    try{const v=await transport({operation,runId:id,expectedRevision:fresh.revision,...extra});if(alive.current){apply(v);setError('');}return v;}
    catch(e){if(attempt===0&&e instanceof Error&&/상태가 바뀌었습니다/.test(e.message))continue;throw e;}
   }
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'결과를 확인하지 못했습니다. 상태를 다시 읽어 주세요. 자동으로 다시 보내지 않습니다.');return null;}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }

 // Opening reads the latest help. A run for this same request continues; otherwise a new one is prepared (it does nothing
 // until started). Another help already moving is shown first: one help runs at a time.
 useEffect(()=>{alive.current=true;void (async()=>{
  const latest=await act({operation:'assist-status'});if(!latest||!intent)return;const r=latest.run;
  if(r&&!ASSIST_TERMINAL.includes(r.state)&&(same(r.intent,intent)||r.state!=='prepared'))return;
  await act({operation:'assist-prepare',requestId:requestId.current,intent});
 })();return()=>{alive.current=false;};},[transport,intent&&JSON.stringify(intent)]);
 useEffect(()=>{if(!view)return;const ego=view.capabilities.drivers.find(d=>d.browser==='ego'),own=view.capabilities.drivers.find(d=>d.browser==='agentstoz');
  setBrowser(b=>b&&view.capabilities.drivers.find(d=>d.browser===b)?.available?b:own?.available?'agentstoz':ego?.available?'ego':null);},[view?.capabilities]);
 // While the help is moving it takes one step at a time and waits for each answer; a hidden window or an error stops it.
 useEffect(()=>{if(run?.state!=='assisting'||busy||stepping||error)return;const t=setTimeout(()=>{if(!document.hidden)void advance(run.id,revision);},700);return()=>clearTimeout(t);},[run?.id,run?.state,revision,busy,stepping,error]);
 useEffect(()=>{if(!run||ASSIST_TERMINAL.includes(run.state)||run.state==='assisting')return;const t=setInterval(()=>{if(!document.hidden&&!lock.current)void act({operation:'assist-status',runId:run.id},true);},5000);return()=>clearInterval(t);},[run?.id,run?.state]);
 const recipe=useMemo(()=>run?assistRecipe(run.intent):null,[run?.intent.service]);
 const step=recipe&&run?.step?recipe.steps.find(s=>s.id===run.step):undefined;
 const send=(operation:string,extra:Record<string,unknown>={})=>control(operation,extra);
 async function humanDone(){if(!run||sentFor.current===revision)return;sentFor.current=revision;await control('assist-human-done');}
 /** A finished sign-in usually moves the help on by itself (its check runs on link); 마쳤어요 is sent only when the run is
  * still waiting on that same app step. */
 async function linkThenDone(link:{loginId?:string;accountId?:string}){
  const at=run?.step;const v=await control('assist-link',{...link,...(run?.intent.email?{email:run.intent.email}:{})});
  if(link.accountId&&v?.run&&v.run.state==='waiting-human'&&v.run.step===at)await act({operation:'assist-human-done',runId:v.run.id,expectedRevision:v.revision});
 }
 const gws=run?.intent.service==='google-workspace';
 const decisions:AssistDecisions|null=!gws?{}:(()=>{const project=projectMode==='existing'?(GOOGLE_PROJECT_ID.test(projectId.trim())?{mode:'existing' as const,id:projectId.trim()}:null):(GOOGLE_PROJECT_NAME.test(projectName.trim())?{mode:'new' as const,name:projectName.trim()}:null);
  return project&&appName.trim()?{project,appName:appName.trim(),audience}:null;})();
 const driver=view?.capabilities.drivers.find(d=>d.browser===browser),planner=view?.capabilities.planners.find(p=>p.ai===ai);
 const canStart=!!run&&run.state==='prepared'&&confirmed&&!!driver?.available&&!!planner?.supported&&!!decisions&&!busy;
 const start=()=>run&&browser&&decisions&&act({operation:'assist-start',runId:run.id,expectedRevision:revision,browser,ai,scopeConfirmed:true,...(gws?{decisions}:{})});
 const requester=useMemo(()=>run?assistBrowserRequester(transport,run.id):null,[run?.id,transport]);
 const startUrl=useMemo(()=>{if(!recipe||!run)return null;for(const s of recipe.steps){const u=s.url?.({projectId:run.links.projectId,decisions:run.decisions,email:run.intent.email});if(u)return u;}return null;},[recipe,run?.links.projectId,run?.decisions]);
 const unknown=run?.receipts.filter(r=>r.state==='unknown')??[];
 const header=<div className="helpdesk-bubble"><h3>{ASSIST_TITLE}</h3>{recipe&&<><p><strong>{recipe.title}</strong></p><p>함께 하는 것: {recipe.summary.together}</p><p>직접 하실 것: {recipe.summary.yours}</p><p className="assist-note">{recipe.notIncluded}</p></>}</div>;
 if(!view)return <section className="helpdesk-task" aria-label={ASSIST_TITLE}><p role="status">{error||'도움받기 상태를 확인하고 있어요…'}</p>{error&&<div className="helpdesk-actions"><button type="button" className={button} onClick={onBack}>직접 따라하기</button></div>}</section>;
 if(!run)return <section className="helpdesk-task" aria-label={ASSIST_TITLE}><div className="helpdesk-bubble"><h3>{ASSIST_TITLE}</h3><p>계정 연결·가입 화면의 「헬프데스크 도움받기」 버튼으로 시작해 주세요.</p></div><div className="helpdesk-actions"><button type="button" className={button} onClick={onBack}>돌아가기</button></div></section>;
 const other=intent&&!same(run.intent,intent)&&run.state!=='prepared';
 return <section className="helpdesk-task assist" aria-label={ASSIST_TITLE}>
  {header}
  {other&&<p role="status" className="assist-note">다른 도움이 아직 끝나지 않았습니다. 한 번에 하나만 진행합니다. 이 도움을 끝낸 뒤 새로 시작해 주세요.</p>}
  {run.state==='prepared'?<form className="assist-start" onSubmit={e=>{e.preventDefault();if(canStart)void start();}}>
   <fieldset><legend>진행할 브라우저</legend>{view.capabilities.drivers.map(d=><label key={d.browser} className="assist-choice"><input type="radio" name="assist-browser" checked={browser===d.browser} disabled={!d.available} onChange={()=>setBrowser(d.browser)}/><span><strong>{BROWSER_TEXT[d.browser].name}</strong>{d.available?BROWSER_TEXT[d.browser].note:d.reason??'지금은 쓸 수 없습니다.'}</span></label>)}</fieldset>
   <fieldset><legend>도움 AI (브라우저와 따로 고릅니다)</legend>{view.capabilities.planners.map(p=><label key={p.ai} className="assist-choice"><input type="radio" name="assist-ai" checked={ai===p.ai} disabled={!p.supported} onChange={()=>setAi(p.ai)}/><span><strong>{AI_TEXT[p.ai].name}</strong>{p.supported?AI_TEXT[p.ai].note:p.reason}</span></label>)}</fieldset>
   {gws&&<fieldset><legend>미리 정할 값 (비밀값은 없습니다)</legend>
    {run.intent.email&&<p>사용할 Google 계정: <strong>{run.intent.email}</strong> · 지원 이메일·연락처·테스트 사용자에 이 주소만 넣습니다.</p>}
    <div className="assist-row" role="radiogroup" aria-label="Google Cloud 프로젝트"><label><input type="radio" name="assist-project" checked={projectMode==='existing'} onChange={()=>setProjectMode('existing')}/> 기존 프로젝트</label><label><input type="radio" name="assist-project" checked={projectMode==='new'} onChange={()=>setProjectMode('new')}/> 새 프로젝트</label></div>
    {projectMode==='existing'?<label className="assist-field">프로젝트 ID<input value={projectId} onChange={e=>setProjectId(e.target.value)} placeholder="my-project-123456" autoComplete="off" spellCheck={false} aria-invalid={!!projectId&&!GOOGLE_PROJECT_ID.test(projectId.trim())}/></label>
     :<label className="assist-field">새 프로젝트 이름 (만들기 버튼은 직접 누릅니다)<input value={projectName} onChange={e=>setProjectName(e.target.value)} maxLength={30} autoComplete="off" aria-invalid={!GOOGLE_PROJECT_NAME.test(projectName.trim())}/></label>}
    <label className="assist-field">동의 화면 앱 이름<input value={appName} onChange={e=>setAppName(e.target.value)} maxLength={60} autoComplete="off"/></label>
    <div className="assist-row" role="radiogroup" aria-label="사용자 유형"><label><input type="radio" name="assist-audience" checked={audience==='external'} onChange={()=>setAudience('external')}/> 외부 (개인 Gmail)</label><label><input type="radio" name="assist-audience" checked={audience==='internal'} onChange={()=>setAudience('internal')}/> 내부 (회사 Workspace)</label></div>
   </fieldset>}
   <div className="helpdesk-bubble"><p><strong>적용 범위</strong> · {assistScopeText(run.intent.scope)}</p><p className="assist-note">비밀번호·인증 코드·최종 승인·클라이언트 JSON 생성과 다운로드는 직접 하십니다. 그 화면에서는 도움이 멈추고 화면을 읽지 않습니다.</p>
    <label className="assist-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 이 범위에서 허용된 화면 이동과 위 값 입력을 함께 진행합니다.</label></div>
   <div className="helpdesk-actions"><button type="submit" className={button+' helpdesk-primary'} disabled={!canStart}>이 범위로 함께 진행</button><button type="button" className={button} onClick={onBack}>직접 따라하기</button></div>
  </form>:<>
   <div className="helpdesk-bubble assist-status" role="status" aria-live="polite"><p className="assist-headline"><strong>{assistOutcomeText(run)}</strong>{run.browser&&<span> · {BROWSER_TEXT[run.browser].name}{run.ai&&run.ai!=='none'?` · ${AI_TEXT[run.ai].name}`:''}</span>}</p>
    {run.waiting&&<p>{run.waiting.note}</p>}{run.message&&<p>{run.message}</p>}{stepping&&run.state==='assisting'&&<p className="assist-note">화면 한 단계를 진행하고 있어요. 진행 중에도 멈추거나 직접 할 수 있어요.</p>}</div>
   <ol className="assist-steps" aria-label="도움 단계">{run.steps.map(s=><li key={s.id} aria-current={s.id===run.step?'step':undefined} data-state={s.state}><span>{s.title}</span><em>{STEP_TEXT[s.state]}</em></li>)}</ol>
   <ul className="assist-checks" aria-label="확인 결과">{run.checks.map(c=><li key={c.id} data-state={c.state}><span>{ASSIST_CHECK_TEXT[c.id]}</span><em>{CHECK_STATE[c.state]}</em>{c.detail&&<small>{c.detail}</small>}</li>)}</ul>
   {run.state==='waiting-human'&&step?.kind==='app'&&<AppStep run={run} app={step.app} busy={busy} onDone={()=>void humanDone()} onLink={link=>void linkThenDone(link)} onOpenStage={onOpenStage}/>}
   {unknown.length>0&&<div className="helpdesk-bubble"><p><strong>결과를 모르는 동작이 있습니다.</strong> 다시 보내지 않았습니다. 화면에서 직접 확인한 뒤 눌러 주세요.</p>{unknown.map(u=><button key={u.id} type="button" className={button} disabled={busy} onClick={()=>void send('assist-settle',{receiptId:u.id})}>{u.target?`「${u.target}」`:'이 동작'} 결과를 확인했어요</button>)}</div>}
   {run.browser==='agentstoz'&&!ASSIST_TERMINAL.includes(run.state)&&requester&&<div className="assist-browser"><OwnedWorkroomBrowser sessionId={ASSIST_SESSION} targetId={run.id} visible request={requester} workspace={workspace} recovery={null} lang="ko" onConnected={setWorkspace} onClosed={()=>setWorkspace(null)} onControls={c=>{controls.current=c;}}
    startCard={<div className="assist-browser-start"><p>도움은 이 아젠투지브라우저 화면에서만 진행합니다. 로그인·승인 화면이 나오면 멈추고 넘겨 드립니다.</p>{startUrl&&<button type="button" className={button+' helpdesk-primary'} onClick={()=>controls.current?.openAddress(startUrl)}>아젠투지브라우저 열기</button>}</div>}/></div>}
   {run.browser==='ego'&&!ASSIST_TERMINAL.includes(run.state)&&<p className="assist-note">에고라이트 앱의 「agentstoz-helpdesk-{run.id.slice(0,12)}」 작업 공간에서 진행합니다. 에고라이트에서 직접 조작하면 도움이 멈추고 기다립니다.</p>}
   <div className="helpdesk-actions">
    {run.state==='assisting'&&<><button type="button" className={button} disabled={busy} onClick={()=>void send('assist-pause')}>잠시 멈춤</button><button type="button" className={button} disabled={busy} onClick={()=>void send('assist-take')}>직접 하기</button></>}
    {run.state==='waiting-human'&&step?.kind!=='app'&&<button type="button" className={button+' helpdesk-primary'} disabled={busy} onClick={()=>void humanDone()}>직접 마쳤어요 · 이어서 진행</button>}
    {(run.state==='paused'||run.state==='interrupted')&&<button type="button" className={button+' helpdesk-primary'} disabled={busy} onClick={()=>void send('assist-resume')}>이어서 진행</button>}
    {run.state==='needs-review'&&<button type="button" className={button+' helpdesk-primary'} disabled={busy} onClick={()=>void send('assist-verify')}>실제 연결 다시 확인</button>}
    {!ASSIST_TERMINAL.includes(run.state)?<button type="button" className={button} disabled={busy} onClick={()=>void send('assist-cancel')}>도움 끝내기</button>:<button type="button" className={button+' helpdesk-primary'} onClick={onBack}>원래 화면으로</button>}
   </div>
  </>}
  {error&&<div className="helpdesk-bubble" role="alert"><p>{error}</p><button type="button" className={button} disabled={busy} onClick={()=>void act({operation:'assist-status',runId:run.id})}>상태 다시 읽기</button></div>}
 </section>;
}
/** The app's own screens for the steps that are the person's: saving a client, the official sign-in, installing. The
 * help only reads their results; it never saves, signs in or installs on its own. */
function AppStep({run,app,busy,onDone,onLink,onOpenStage}:{run:AssistRun;app:string|undefined;busy:boolean;onDone:()=>void;onLink:(link:{loginId?:string;accountId?:string})=>void;onOpenStage:(stage:'install'|'auth')=>void}){
 const provider=PROVIDERS[run.intent.service];
 if(app==='google-client')return <div className="assist-app"><PlatformGoogleClientSetup ko assist={false} disabled={busy} onReady={ready=>{if(ready)onDone();}}/></div>;
 if((app==='cli-login'||app==='google-login')&&provider)return <div className="assist-app"><PlatformCliLoginPanel provider={provider} email={run.intent.email??''} ko disabled={busy} onVerificationStarted={()=>{}} onLoginStarted={loginId=>onLink({loginId})} onConnected={account=>{if(account)onLink({accountId:account.id});}}/></div>;
 const stage=app==='install'?'install':'auth';
 return <div className="helpdesk-bubble assist-app"><p>{app==='install'?'프로그램 준비 화면에서 빠진 프로그램만 준비해 주세요.':'AI 연결 화면에서 공식 로그인을 마쳐 주세요.'} 마친 뒤 이 화면으로 돌아와 확인을 눌러 주세요.</p>
  <div className="helpdesk-actions"><button type="button" className="helpdesk-button" onClick={()=>onOpenStage(stage)}>{app==='install'?'프로그램 준비 열기':'AI 연결 열기'}</button><button type="button" className="helpdesk-button helpdesk-primary" disabled={busy} onClick={onDone}>마쳤어요 · 확인</button></div></div>;
}
