import {OPEN_OPS_VOICE_EVENT} from './VoiceSessionPanel';
import {TesterOverviewPanel} from './TesterOverviewPanel';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import type {ControlProfileStatus} from './controlProfileContract';
import type {ControlProfileConnection} from './controlProfileConnections';
import type {ControlMemoryProposal} from './controlProfileStore';
import type {AgentsToZUseWorkroomAgent} from './agentstozUseControl';
import {OpsFolderMigrationNotice, type OpsFolderMigrationRecord} from './opsFolderMigrationNotice';

export type ControlProfileOpenResult = {message: string; warnings: string[]; session?: {id: string; targetId: string; agent: AgentsToZUseWorkroomAgent}};

export async function requestControlProfile(path:string,body?:unknown,signal?:AbortSignal){
 const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/control-profile/${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal??AbortSignal.timeout(15_000)});
 const result=await response.json();if(!response.ok||result.success!==true)throw new Error(result.error??'아젠투지 설정 상태를 확인하지 못했습니다.');return result;
}
export function ControlProfilePanel({onClose,onOpenWork,onOpenProject,onOpened}: {onClose:()=>void;onOpenWork:()=>void;onOpenProject?:(id:string)=>void;onOpened?:(result:ControlProfileOpenResult)=>void}){
 const [profile,setProfile]=useState<ControlProfileStatus|null>(null),[pending,setPending]=useState<ControlMemoryProposal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [controls,setControls]=useState<Array<{projectId:string|null;memoryId:string}>>([]);
 const [migration,setMigration]=useState<OpsFolderMigrationRecord|null>(null);
 const [connections,setConnections]=useState<ControlProfileConnection[]>([]);
 const [launchAgent,setLaunchAgent]=useState<AgentsToZUseWorkroomAgent>('codex');
 const [launchSurface,setLaunchSurface]=useState<'app'|'workroom'|'orca-floating'|'orca-worktree'|'buzz'>('app');
 const [launchMode,setLaunchMode]=useState<'reopen'|'prepare'>('reopen'),[launchBypass,setLaunchBypass]=useState(false);
 const pendingLaunch=useRef(new Map<string,string>());
 const mounted=useRef(true),serial=useRef(0),launchTouched=useRef(false);
 // The AI and surface this device last opened OPS with (src/opsLaunchPreference.ts). OPS voice uses the
 // same AI when no OPS workroom is running, so the panel shows it instead of resetting to Codex.
 useEffect(()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void requestControlProfile('launch-preference',undefined,controller.signal).then(r=>{const saved=r.preference;if(controller.signal.aborted||launchTouched.current||!saved)return;setLaunchSurface(saved.surface);setLaunchAgent(saved.agent);}).catch(()=>{});return()=>{clearTimeout(timer);controller.abort();};},[]);
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  const run=++serial.current;
  const [status,proposals]=await Promise.all([requestControlProfile('status',undefined,signal),requestControlProfile('pending',undefined,signal)]);
  const candidates=await requestControlProfile('controls',undefined,signal).catch(()=>({controls:[]}));
  if(mounted.current&&run===serial.current){setControls(candidates.controls);setProfile(status.profile);setMigration(status.opsFolderMigration??null);setPending(proposals.proposals);setError('');}
 },[]);
 useEffect(()=>{mounted.current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void refresh(controller.signal).catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;clearTimeout(timer);controller.abort();};},[refresh]);
 useEffect(()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void requestControlProfile('connections',undefined,controller.signal).then(r=>{if(!controller.signal.aborted)setConnections(r.connections);}).catch(()=>{});return()=>{clearTimeout(timer);controller.abort();};},[]);
 const operate=async(action:()=>Promise<any>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{const result=await action();if(mounted.current&&result.backup)setNotice(result.backup.backedUp?'운영 기억 저장과 백업을 확인했습니다.':'운영 기억은 로컬에 저장했습니다. 원격 백업 상태는 별도 확인이 필요합니다.');await refresh();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'처리 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.');}finally{if(mounted.current)setBusy(false);}};
 const state=profile?.state==='ready'?'운영 기억 연결됨':profile?.state==='preparing'?'준비 중':profile?.state==='needs-attention'?'연결 확인 필요':'프로필 준비 필요';
 const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
 const launchReady=profile?.state==='ready'&&profile.backend==='control-folder'&&!!profile.projectId;
 const launchLabel=launchSurface==='workroom'?'워크룸으로':launchSurface==='buzz'?'Buzz 채널로':launchSurface==='app'?`${{codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'}[launchAgent]} 앱으로`:launchSurface==='orca-floating'?'Orca 플로팅으로':'Orca 워크트리로';
 const openSurface=()=>operate(async()=>{
  const launchKey=`${profile?.profileId}:${launchAgent}`;
  if(launchSurface==='workroom'&&!pendingLaunch.current.has(launchKey))pendingLaunch.current.set(launchKey,`ops_${crypto.randomUUID()}`);
  const result=await requestControlProfile('open',{
   action:launchSurface==='workroom'?'start-workroom-session':launchSurface==='buzz'?'open-buzz-dev':'open-code-app',expectedProfileId:profile?.profileId,
   ...(launchSurface==='buzz'?{}:{agent:launchAgent}),
   ...(launchSurface==='workroom'?{requestId:pendingLaunch.current.get(launchKey)}:launchSurface==='buzz'?{}:{surface:launchSurface,bypass:launchBypass,...(launchSurface==='app'&&launchAgent==='codex'?{mode:launchMode}:{})}),
  },AbortSignal.timeout(180_000));
  if(result.performed!==true)throw new Error('OPS 열기 결과가 확인되지 않았습니다. 상태를 확인한 뒤 다시 시도하세요.');
  if(launchSurface==='workroom')pendingLaunch.current.delete(launchKey);
  const warnings=[...(Array.isArray(result.warnings)?result.warnings.filter((v:unknown):v is string=>typeof v==='string'):[]),...(typeof result.navigationWarning==='string'?[result.navigationWarning]:[])];
  const message=typeof result.message==='string'?result.message:'아젠투지 워크룸 세션을 시작했습니다. 초기 화면을 확인한 뒤 지시하세요.';
  if(mounted.current){setNotice([message,...warnings].join('\n'));onOpened?.({message,warnings,...(result.session?{session:result.session}:{})});}
  return result;
 });
 return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
  <section role="dialog" aria-modal="true" aria-labelledby="control-profile-title" data-testid="control-profile-panel" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)]" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape')onClose();}}>
   <div className="flex items-start justify-between gap-3"><div><h2 id="control-profile-title" className="text-xl font-bold">아젠투지 설정</h2><p className="mt-2 text-sm">어느 프로젝트에서든 쓰는 나의 아젠투지(OPS) 운영 기억입니다.</p></div><button className={`${button} shrink-0 whitespace-nowrap`} onClick={onClose} aria-label="아젠투지 설정 닫기">닫기</button></div>
   <p role="status" className="mt-4 font-semibold">{state}</p>
   {profile?.problem&&<p className="mt-2 text-sm text-amber-600">{profile.problem}</p>}
   <OpsFolderMigrationNotice record={migration}/>
   {profile?.sync&&<p className="mt-2 text-xs">{profile.sync.state==='current'?'다른 Mac의 운영 기억과 동기화됨':profile.sync.state==='not-configured'?'이 사용자에 로컬 저장 · 다른 Mac 연결은 기존 OPS 운영 폴더(AgentsToZ-OPS, 예전 이름 AgentsToZ-Control) 복원으로 준비할 수 있습니다.':profile.sync.problem}</p>}
   <p className="mt-2 text-sm">호출: <strong>agentstoz · 아젠투지 · 에이전츠투지</strong></p>
   <p className="mt-2 text-sm">운영 방식과 프로젝트 관계는 아젠투지에, 구현 내용은 각 프로젝트 기억에 남깁니다. AI 연결과 실제 작업 성공은 각각 확인합니다.</p>
   <dl className="mt-4 space-y-2 text-xs"><div><dt>마지막 기억 갱신</dt><dd>{profile?.lastSavedAt?new Date(profile.lastSavedAt).toLocaleString('ko-KR'):'확인된 기록 없음'}</dd></div></dl>
   <details className="mt-2 text-xs"><summary className="cursor-pointer">고급 정보</summary><dl className="mt-1"><div><dt>기억 식별자</dt><dd className="break-all">{profile?.memoryId??'준비 후 표시'}</dd></div></dl></details>
   <div className="mt-4 flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>void operate(()=>requestControlProfile('prepare',{}))}>{busy?'확인 중…':'아젠투지 준비·연결 다시 확인'}</button><button className={button} disabled={busy} onClick={()=>void operate(()=>refresh())}>상태 다시 확인</button><button className={button} disabled={busy||profile?.state!=='ready'||!profile.projectId} title={!profile?.projectId?'OPS 운영 폴더(AgentsToZ-OPS)를 이 Mac에 연결하면 사용할 수 있습니다.':undefined} onClick={onOpenWork}>아젠투지 채팅·워크룸 열기</button></div>
   {profile?.state==='ready'&&!profile.projectId&&<p className="mt-2 text-xs text-[var(--ink-3)]">OPS 채팅·워크룸은 OPS 운영 폴더(AgentsToZ-OPS, 예전 이름 AgentsToZ-Control)를 이 Mac에 연결한 뒤 사용할 수 있습니다. 로컬 전용 운영 기억은 이 패널에서 계속 관리할 수 있습니다.</p>}
   <fieldset className="mt-5 rounded-xl border border-[var(--line)] p-3" disabled={busy}>
    <legend className="px-1 font-bold">아젠투지 열기</legend><p className="text-sm">음성은 화면 아래 「아젠투지 호출」을 누르세요.<button type="button" className={button+' ml-2'} data-testid="control-profile-voice-settings" disabled={profile?.state!=='ready'} onClick={()=>{onClose();window.dispatchEvent(new Event(OPEN_OPS_VOICE_EVENT));}}>음성 창 열기</button></p>
    <div className="flex flex-wrap gap-3">
     <label className="inline-flex items-center gap-2 text-sm">어디서 열까요?<select aria-label="OPS 실행 표면" className={button} value={launchSurface} onChange={e=>{launchTouched.current=true;const next=e.target.value as typeof launchSurface;setLaunchSurface(next);}}><option value="app">외부 AI 앱</option><option value="workroom">워크룸</option><option value="orca-floating">Orca 플로팅</option><option value="orca-worktree">Orca 워크트리</option><option value="buzz">Buzz 채널</option></select></label>
     {launchSurface!=='buzz'&&<label className="inline-flex items-center gap-2 text-sm">AI<select aria-label="OPS 실행 AI" className={button} value={launchAgent} onChange={e=>{launchTouched.current=true;setLaunchAgent(e.target.value as AgentsToZUseWorkroomAgent);}}><option value="codex">Codex</option><option value="claude">Claude</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select></label>}
    </div>
    {launchSurface==='app'&&launchAgent==='codex'&&<label className="mt-2 flex items-center gap-2 text-sm">Codex 앱 동작<select aria-label="OPS Codex 앱 동작" className={button} value={launchMode} onChange={e=>setLaunchMode(e.target.value as typeof launchMode)}><option value="reopen">기존 대화 열기</option><option value="prepare">첫 대화 연결 준비</option></select></label>}
    {launchSurface==='app'&&launchAgent==='codex'&&launchMode==='prepare'&&<p className="mt-2 text-xs">기존 대화가 없으면 첫 연결 확인용 고정 메시지를 보낼 수 있습니다.</p>}
    {launchSurface!=='workroom'&&launchSurface!=='buzz'&&<label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={launchBypass} onChange={e=>setLaunchBypass(e.target.checked)}/>승인 없이 실행 (권한 우회)</label>}
    {launchBypass&&launchSurface==='app'&&launchAgent!=='claude'&&<p className="mt-2 text-xs">Codex·Hermes·Antigravity 앱에는 권한 우회가 적용되지 않습니다. 앱의 승인 설정을 따릅니다.</p>}
    <p className="mt-2 text-xs">{launchSurface==='workroom'?'기존 워크룸 실행기를 사용합니다. 초기 출력·로그인·신뢰 확인 후 지시하세요.':launchSurface==='buzz'?'연결된 OPS 운영 채널 정보를 확인하고 Buzz를 엽니다. Buzz 공식 딥링크가 없어 채널은 앱에서 직접 선택합니다.':launchSurface.startsWith('orca-')?'기존 Orca 실행기를 사용하며 워크트리를 표시할 수 없으면 같은 폴더의 플로팅으로 전환 사실을 알립니다.':launchAgent==='agy'?'Antigravity 앱을 열기만 합니다 · 이 앱은 폴더를 받지 않으므로 OPS 운영 폴더는 앱에서 선택하세요.':'현재 연결된 OPS 운영 폴더를 엽니다. DEV 프로젝트를 대신 열지 않습니다.'}</p>
    {!launchReady&&<p className="mt-2 text-sm">{profile?.state==='ready'&&profile.backend==='app-data'?'로컬 전용 OPS는 패널·기억 호출을 지원합니다. 이 실행 표면에는 기존 등록 OPS 운영 폴더 연결이 필요하며, 자동 생성하지 않습니다.':'OPS 기억과 등록 운영 폴더 연결을 먼저 확인하세요.'}</p>}
    <button className={`${button} mt-3`} disabled={busy||!launchReady} onClick={()=>void openSurface()}>{launchSurface==='app'&&launchAgent==='agy'?'Antigravity 앱 열기 (OPS 폴더는 앱에서 선택)':`아젠투지를 ${launchLabel} 열기`}</button>
   </fieldset>
   {controls.filter(c=>c.projectId&&c.projectId!==profile?.projectId).map(c=><div key={c.projectId} className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm"><p>등록된 OPS 운영 폴더의 기억: {c.memoryId}</p><button className={button} disabled={busy} onClick={()=>void operate(()=>profile?.state==='ready'?requestControlProfile('attach',{projectId:c.projectId,expectedProfileId:profile.profileId}):requestControlProfile('prepare',{projectId:c.projectId}))}>이 운영 기억을 아젠투지에 연결</button></div>)}
   <h3 className="mt-5 font-bold">AI 연결</h3><p className="mt-1 text-xs">설정 연결 후 실행 중인 AI의 MCP 도구를 새로고침하세요. 실제 호출 성공은 해당 AI에서 확인합니다.</p>
   {connections.map(c=><div key={c.agent} className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] p-2"><div><strong>{({codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'} as Record<string,string>)[c.agent]??c.agent}</strong><p className="text-xs">{c.message}</p></div><button className={button} disabled={busy||c.state==='unavailable'} onClick={()=>void operate(async()=>{const result=await requestControlProfile('connections',{agent:c.agent});if(mounted.current)setConnections(current=>current.map(item=>item.agent===c.agent?result.connection:item));return result;})}>연결 확인·준비</button></div>)}
   {profile?.state==='ready'&&onOpenProject&&<TesterOverviewPanel transport={async request=>(await requestControlProfile('tester-results',request)).overview} onOpenProject={onOpenProject}/>}
   <h3 className="mt-5 font-bold">운영 기억 저장 후보 · {pending.length}</h3><p className="mt-1 text-xs">AI에게 “아젠투지, 이 운영 결정을 기억 후보로 남겨줘”라고 요청한 뒤 여기서 저장합니다. 후보 접수는 저장 완료와 다릅니다.</p>
   {pending.map(p=><article key={p.id} className="mt-3 rounded-xl border border-[var(--line)] p-3"><h4 className="font-semibold">{p.title}</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm">{p.body}</p><p className="mt-2 text-xs">근거: {p.evidence}</p><div className="mt-3 flex gap-2"><button className={button} disabled={busy||profile?.state!=='ready'} onClick={()=>void operate(()=>requestControlProfile('review',{id:p.id,accept:true,expectedRevision:profile?.revision}))}>운영 기억에 저장</button><button className={button} disabled={busy} onClick={()=>void operate(()=>requestControlProfile('review',{id:p.id,accept:false,expectedRevision:profile?.revision??''}))}>제외</button></div></article>)}
   {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}{error&&<p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
  </section>
 </div>;
}
