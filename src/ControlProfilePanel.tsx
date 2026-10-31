import {restoreDialogFocus} from './dialogFocus';
import {DeviceOperatingMemoryPanel} from './DeviceOperatingMemoryPanel';
import {OPEN_OPS_VOICE_EVENT} from './VoiceSessionPanel';
import {TesterOverviewPanel} from './TesterOverviewPanel';
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {invoke} from '@tauri-apps/api/core';
import type {ControlProfileStatus} from './controlProfileContract';
import type {ControlProfileConnection} from './controlProfileConnections';
import type {ControlMemoryProposal} from './controlProfileStore';
import type {AgentsToZUseWorkroomAgent} from './agentstozUseControl';
import {OpsFolderMigrationNotice, type OpsFolderMigrationRecord} from './opsFolderMigrationNotice';
import {opsLaunchBypassSupported} from './opsLaunchOptions';
import {isDialogDismissKey} from './dialogEscape';
import {CandidateCard,FoldSection} from './ControlProfileSections';
import {ControlMemoryConflictPanel} from './ControlMemoryConflictPanel';

export type ControlProfileOpenResult = {message: string; warnings: string[]; session?: {id: string; targetId: string; agent: AgentsToZUseWorkroomAgent}};

export async function requestControlProfile(path:string,body?:unknown,signal?:AbortSignal){
 if(path==='memory-conflict'&&isTauri()&&String(import.meta.env.DEV)!=='true'){
  const response=await invoke<{status:number;body:any}>('control_memory_conflict_request',{body});
  if(!response||response.status<200||response.status>=300||response.body?.success!==true)throw Error(response?.body?.error??'운영 기억 비교 결과를 확인하지 못했습니다.');
  return response.body;
 }
 const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/control-profile/${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal??AbortSignal.timeout(15_000)});
 const result=await response.json();if(!response.ok||result.success!==true)throw new Error(result.error??'아젠투지 설정 상태를 확인하지 못했습니다.');return result;
}
const deviceMemoryRequest=(body:Record<string,unknown>,signal?:AbortSignal)=>requestControlProfile('device-memory',body,signal);
/** A server message is Korean; a fetch, timeout or JSON failure is not, so the panel says what it means instead. */
const readableError=(error:unknown,fallback:string)=>{const message=error instanceof Error?error.message:'';return /[가-힣]/.test(message)?message:fallback;};
const STATUS_UNREADABLE='아젠투지 상태를 읽지 못했습니다. 잠시 뒤 「상태 다시 확인」을 누르세요.',SAVED_UNREADABLE='저장된 운영 기억을 읽지 못했습니다. 「상태 다시 확인」을 누르세요.';
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
const AGENT_NAMES:Record<string,string>={codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'};
const SURFACE_NAMES:Record<string,string>={app:'외부 AI 앱',workroom:'워크룸','orca-floating':'Orca 플로팅','orca-worktree':'Orca 워크트리',buzz:'Buzz 채널'};
/** The folded line of AI별 MCP 사용 설정. An outdated entry still works, so it is 「다시 등록 권장」, never 「설치 안 됨」. */
const CONNECTION_GROUPS:Array<[string,(connection:ControlProfileConnection)=>boolean]>=[
 ['확인 필요',c=>c.state==='needs-attention'],['다시 등록 권장',c=>c.state==='configured'&&c.upgradable===true],
 ['연결됨',c=>c.state==='configured'&&c.upgradable!==true],['미등록',c=>c.state==='not-configured'],['사용 불가',c=>c.state==='unavailable']];
/** Candidates rendered before 「후보 N개 더 보기」; the rest are not in the page until asked for. */
const CANDIDATE_PAGE=5;
/** Purpose sections, folded until opened; each is `control-profile-<name>` in the page. */
type Detail='launch'|'saved-memory'|'device-memory'|'connections'|'tester'|'guide';
/** Where an action's result is said: next to the control that started it (the status card when that section is folded). */
type ResultArea='status'|'pending'|'launch'|'connections';
type SavedMemory={ready:boolean;total:number;entries:Array<{entryId:string;section:string;title:string}>;problem?:string};
/**
 * What 아젠투지 already remembers, read-only: titles first, one body when opened (GET entries — Mac only, never a phone DTO).
 * The titles fold under the heading with the count; a failed read, a memory that is not ready and an empty list stay visible.
 */
function SavedOperatingMemory({revision,reload,localOnly,expanded,onToggle}:{revision:string|null;reload:number;localOnly:boolean;expanded:boolean;onToggle:()=>void}){
 const [list,setList]=useState<SavedMemory|null>(null),[error,setError]=useState(''),[open,setOpen]=useState<{entryId:string;body?:string;truncated?:boolean;error?:string}|null>(null);
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 // A changed memory closes the open body; every status read (「상태 다시 확인」, a save) reloads the list, so the
 // retry the error line names really retries — the revision alone does not change after a failed read.
 useEffect(()=>{setOpen(null);},[revision]);
 useEffect(()=>{let current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void requestControlProfile('entries',undefined,controller.signal).then(r=>{if(!current)return;if(!r.memory||!Array.isArray(r.memory.entries))throw new Error(SAVED_UNREADABLE);setList(r.memory);setError('');}).catch(e=>{if(current)setError(readableError(e,SAVED_UNREADABLE));});return()=>{current=false;clearTimeout(timer);controller.abort();};},[revision,reload]);
 // A body that failed to load is read again on the next press (its message says so) instead of folding away.
 const toggle=(entryId:string)=>{if(open?.entryId===entryId&&!open.error){setOpen(null);return;}setOpen({entryId});void requestControlProfile(`entries?entryId=${entryId}`).then(r=>{if(alive.current)setOpen(c=>c?.entryId===entryId&&c.body===undefined?{entryId,body:typeof r.entry?.body==='string'?r.entry.body:'',truncated:r.entry?.truncated===true}:c);}).catch(e=>{if(alive.current)setOpen(c=>c?.entryId===entryId?{entryId,error:readableError(e,'내용을 읽지 못했습니다. 다시 눌러 보세요.')}:c);});};
 const entries=!error&&list?.ready&&list.entries.length>0?list:null;
 return <FoldSection id="control-profile-saved-memory" testId="control-profile-saved-memory" title={`저장된 운영 기억 · ${list?.ready?list.total:'…'}`} open={expanded} onToggle={onToggle} foldable={!!entries}
  summary={error?<p role="alert" className="mt-1 text-sm text-red-500">{error}</p>:!list?<p className="mt-1 text-sm">불러오는 중…</p>:!list.ready?<p className="mt-1 text-sm text-amber-600">{list.problem}</p>:list.entries.length===0?<p className="mt-1 text-sm">아직 저장된 운영 기억이 없습니다. {localOnly?'AI에게 “아젠투지, 이 운영 결정을 기억해”라고 요청하면 여기에 보입니다.':'저장 후보를 저장하면 여기에 보입니다.'}</p>:null}>
  {entries&&<><p className="mt-1 text-xs">아젠투지가 회상하는 내용입니다. 제목을 누르면 본문을 봅니다. 이 목록은 읽기 전용입니다.</p>
   <ul className="mt-2 space-y-2">{entries.entries.map((entry,index)=>{const expandedEntry=open?.entryId===entry.entryId;return <li key={`${entry.entryId}:${index}`} className="rounded-lg border border-[var(--line)]"><button type="button" aria-expanded={expandedEntry} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm" onClick={()=>toggle(entry.entryId)}><span className="min-w-0 break-words font-semibold">{entry.title}</span><span className="shrink-0 text-xs text-[var(--ink-3)]">{entry.section}</span></button>{expandedEntry&&<div className="border-t border-[var(--line)] px-3 py-2 text-sm">{open.error?<p role="alert" className="text-red-500">{open.error}</p>:open.body===undefined?<p>불러오는 중…</p>:<><p className="whitespace-pre-wrap break-words">{open.body||'(본문 없음)'}</p>{open.truncated&&<p className="mt-1 text-xs">앞부분만 보여 줍니다.</p>}</>}</div>}</li>;})}</ul>
   {entries.entries.length<entries.total&&<p className="mt-2 text-xs">최근 {entries.entries.length}개만 보여 줍니다.</p>}</>}
 </FoldSection>;
}

/**
 * The OPS review is independent of the DEV editor. Reading and applying remain separate human actions.
 */
export const CONTROL_SYNC_ATTENTION_TEXT='로컬과 원격 운영 기억 중 어느 쪽도 자동으로 덮어쓰지 않았습니다. 운영 기억 비교에서 두 내용을 읽고 적용할 수 있습니다. 장기기억 현황에서는 기기별 상태를 볼 수 있고, 다시 확인은 「아젠투지 준비·연결 다시 확인」입니다.';

/**
 * What waits for a person in 지금 할 일. An OPS memory sync that needs attention (a local/remote conflict, or a remote that
 * could not be read) is one of them: before, the card said nothing was waiting right under the sync problem line.
 */
export function controlProfileWaiting(input:{pending:number;attention:number;restoreOffer:boolean;otherControls:number;sync?:ControlProfileStatus['sync']}){
 const sync=input.sync?.state==='needs-attention';
 return {sync,waiting:input.pending>0||input.attention>0||input.restoreOffer||input.otherControls>0||sync};
}

/**
 * 아젠투지 설정 (docs/design/agentstoz-settings-2026-10-26.md). The status card comes first with what waits for a person
 * and the main open action; the memory candidates follow; everything else folds by purpose and keeps its count, error,
 * sync state, permission bypass or local-only state in sight while folded. Requests, the reviewed expectedRevision,
 * focus/Escape and the StrictMode opener contract are those of the earlier single-column panel.
 */
export function ControlProfilePanel({onClose,onOpenWork,onOpenProject,onOpenUserMemory,onOpenUserProfile,onOpenMemoryStatus,onOpened,onRestoreOps,restoreFrom}: {onClose:()=>void;onOpenWork:()=>void;onOpenProject?:(id:string)=>void;onOpenUserMemory?:()=>void;onOpenUserProfile?:()=>void;
 /**
  * Navigation only, offered while the OPS memory sync needs attention: the 장기기억 tab's directory shows each Mac's state
  * of the same memory. Nothing here resolves, pulls or pushes; the OPS role does not mount the project memory editor.
  */
 onOpenMemoryStatus?:()=>void;onOpened?:(result:ControlProfileOpenResult)=>void;
 /** Only when this Mac has no OPS folder: the same restore the header and onboarding start. `restoreFrom` names a Mac already using one. */
 onRestoreOps?:()=>void;restoreFrom?:string}){
 const [profile,setProfile]=useState<ControlProfileStatus|null>(null),[pending,setPending]=useState<ControlMemoryProposal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[statusProblem,setStatusProblem]=useState(''),[statusReads,setStatusReads]=useState(0);
 const [controls,setControls]=useState<Array<{projectId:string|null;memoryId:string}>>([]);
 const [migration,setMigration]=useState<OpsFolderMigrationRecord|null>(null);
 const [connections,setConnections]=useState<ControlProfileConnection[]>([]),[connectionsRead,setConnectionsRead]=useState<'reading'|'read'|'failed'>('reading');
 const [launchAgent,setLaunchAgent]=useState<AgentsToZUseWorkroomAgent>('codex');
 const [launchSurface,setLaunchSurface]=useState<'app'|'workroom'|'orca-floating'|'orca-worktree'|'buzz'>('app');
 const [launchMode,setLaunchMode]=useState<'reopen'|'prepare'>('reopen'),[launchBypass,setLaunchBypass]=useState(false);
 const [resultArea,setResultArea]=useState<ResultArea>('status');
 const [details,setDetails]=useState<Record<Detail,boolean>>({launch:false,'saved-memory':false,'device-memory':false,connections:false,tester:false,guide:false});
 // The tester overview reads on mount, so it mounts on first opening and stays mounted (and keeps its page) after that.
 const [testerSeen,setTesterSeen]=useState(false),[allCandidates,setAllCandidates]=useState(false);
 const [showConflict,setShowConflict]=useState(false);
 const toggleDetail=(detail:Detail)=>{if(detail==='tester')setTesterSeen(true);setDetails(current=>({...current,[detail]:!current[detail]}));};
 /** Opens a purpose section and moves focus to its heading button, so the to-do and 「열기 방식 바꾸기」 land on it. */
 const reveal=(detail:Detail)=>{if(detail==='tester')setTesterSeen(true);setDetails(current=>({...current,[detail]:true}));document.getElementById(`control-profile-${detail}-toggle`)?.focus();};
 const pendingLaunch=useRef(new Map<string,string>());
 const mounted=useRef(true),serial=useRef(0),launchTouched=useRef(false);
 const launchDraft=useRef({agent:launchAgent,surface:launchSurface,mode:launchMode,bypass:launchBypass});
 const preferenceQueue=useRef<Promise<unknown>>(Promise.resolve());
 const updateLaunch=(patch:Partial<typeof launchDraft.current>)=>{
  launchTouched.current=true;
  const next={...launchDraft.current,...patch};next.bypass=opsLaunchBypassSupported(next.agent,next.surface)&&next.bypass;
  launchDraft.current=next;setLaunchAgent(next.agent);setLaunchSurface(next.surface);setLaunchMode(next.mode);setLaunchBypass(next.bypass);
  if(next.surface==='buzz'||!profile?.profileId)return;
  const expectedProfileId=profile.profileId;
  preferenceQueue.current=preferenceQueue.current.catch(()=>{}).then(()=>requestControlProfile('launch-preference',{...next,expectedProfileId})).then(()=>{if(mounted.current){setResultArea('launch');setError('');setNotice('열기 설정을 이 기기에 저장했습니다.');}}).catch(e=>{if(mounted.current){setResultArea('launch');setNotice('');setError(e.message);}});
 };
 // The AI and surface this device last opened OPS with (src/opsLaunchPreference.ts). OPS voice uses the
 // same AI when no OPS workroom is running, so the panel shows it instead of resetting to Codex.
 useEffect(()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void requestControlProfile('launch-preference',undefined,controller.signal).then(r=>{const saved=r.preference;if(controller.signal.aborted||launchTouched.current||!saved)return;const next={agent:saved.agent,surface:saved.surface,mode:saved.mode??'reopen',bypass:saved.bypass??false};launchDraft.current=next;setLaunchSurface(next.surface);setLaunchAgent(next.agent);setLaunchMode(next.mode);setLaunchBypass(next.bypass);}).catch(()=>{});return()=>{clearTimeout(timer);controller.abort();};},[]);
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  const run=++serial.current;
  let status,proposals;
  try{[status,proposals]=await Promise.all([requestControlProfile('status',undefined,signal),requestControlProfile('pending',undefined,signal)]);}
  catch(e){if(mounted.current&&run===serial.current)setStatusProblem(readableError(e,STATUS_UNREADABLE));throw e;}
  const candidates=await requestControlProfile('controls',undefined,signal).catch(()=>({controls:[]}));
  if(mounted.current&&run===serial.current){setControls(candidates.controls);setProfile(status.profile);setMigration(status.opsFolderMigration??null);setPending(proposals.proposals);setStatusProblem('');setError('');setStatusReads(n=>n+1);}
 },[]);
 useEffect(()=>{mounted.current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void refresh(controller.signal).catch(()=>{});return()=>{mounted.current=false;clearTimeout(timer);controller.abort();};},[refresh]);
 // A connection read that fails or times out is said in the folded line instead of leaving an empty list.
 useEffect(()=>{let current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);void requestControlProfile('connections',undefined,controller.signal).then(r=>{if(!current)return;setConnections(Array.isArray(r.connections)?r.connections:[]);setConnectionsRead('read');}).catch(()=>{if(current)setConnectionsRead('failed');});return()=>{current=false;clearTimeout(timer);controller.abort();};},[]);
 // Focus starts inside so Escape reaches this dialog (App's own Escape handler stands aside while it is open), and
 // goes back to the button that opened it when it is dismissed — not when it hands over to a workroom or voice.
 // The opener is kept in a ref and never taken from inside the panel: StrictMode runs this effect twice in
 // development, and the second run would otherwise record the panel itself (gone by the time it closes).
 const panelRef=useRef<HTMLElement>(null),opener=useRef<HTMLElement|null>(null),returnFocus=useRef(false);
 useLayoutEffect(()=>{const active=document.activeElement;if(!opener.current&&active instanceof HTMLElement&&active!==document.body&&!panelRef.current?.contains(active))opener.current=active;panelRef.current?.focus({preventScroll:true});return()=>{if(returnFocus.current)restoreDialogFocus(opener.current);};},[]);
 const dismiss=()=>{returnFocus.current=true;onClose();};
 // Saving or excluding a candidate (or attaching a folder) removes the button that had focus, which left focus on the
 // page body where this dialog's Escape never fires. Keep it in the dialog, where the person was working.
 useEffect(()=>{
  const active=document.activeElement,panel=panelRef.current;
  if(!panel||active&&active!==document.body)return;
  const place=resultArea==='pending'?document.getElementById('control-profile-pending-title'):resultArea==='status'?null:document.getElementById(`control-profile-${resultArea}-toggle`);
  (place??panel).focus({preventScroll:true});
 });
 const operate=async(action:()=>Promise<any>,area:ResultArea='status')=>{if(busy)return;setBusy(true);setResultArea(area);setError('');setNotice('');try{const result=await action();if(mounted.current&&result?.backup)setNotice(result.backup.backedUp?'운영 기억 저장과 백업을 확인했습니다.':'운영 기억은 로컬에 저장했습니다. 원격 백업 상태는 별도 확인이 필요합니다.');await refresh();}catch(e){if(mounted.current)setError(readableError(e,'처리 결과를 확인하지 못했습니다. 상태를 다시 확인하세요.'));}finally{if(mounted.current)setBusy(false);}};
 // Nothing read yet is not "unprepared": say it is being checked, or why the read failed. A local-only profile is not shared.
 const state=!profile?statusProblem||'상태 확인 중…':profile.state==='ready'?profile.backend==='app-data'?'운영 기억 준비됨 · 이 Mac 전용':'운영 기억 연결됨':profile.state==='preparing'?'준비 중':profile.state==='needs-attention'?'연결 확인 필요':'아젠투지 준비 필요';
 const launchReady=profile?.state==='ready'&&profile.backend==='control-folder'&&!!profile.projectId;
 // A local-only (app-data) memory saves an AI's memory request at once (controlProfileStore.propose): there is no
 // candidate to review, so the copy right under the status must not tell the user to save one here.
 const localOnly=profile?.state==='ready'&&profile.backend==='app-data';
 const launchLabel=launchSurface==='workroom'?'워크룸으로':launchSurface==='buzz'?'Buzz 채널로':launchSurface==='app'?`${AGENT_NAMES[launchAgent]} 앱으로`:launchSurface==='orca-floating'?'Orca 플로팅으로':'Orca 워크트리로';
 const bypassOn=launchBypass&&opsLaunchBypassSupported(launchAgent,launchSurface);
 const launchSummary=[SURFACE_NAMES[launchSurface],...(launchSurface==='buzz'?[]:[AGENT_NAMES[launchAgent]]),...(launchSurface==='app'&&launchAgent==='codex'?[launchMode==='prepare'?'첫 대화 연결 준비':'기존 대화 열기']:[]),...(bypassOn?['권한 우회 켜짐']:[])].join(' · ');
 const openSurface=()=>operate(async()=>{
  await preferenceQueue.current;
  // A preference save that finished just now said its result in the options; this open's result belongs with its button.
  if(mounted.current)setResultArea('status');
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
 // A result is said next to the control that started it; when that section has been folded since, in the status card.
 const shownArea:ResultArea=(resultArea==='launch'&&!details.launch)||(resultArea==='connections'&&!details.connections)?'status':resultArea;
 const results=(area:ResultArea)=>shownArea===area&&(notice||error)?<div className="mt-3 space-y-1">{notice&&<p role="status" className="whitespace-pre-line text-sm">{notice}</p>}{error&&<p role="alert" className="text-sm text-red-500">{error}</p>}</div>:null;
 const attention=connections.filter(c=>c.state==='needs-attention');
 const otherControls=controls.filter(c=>c.projectId&&c.projectId!==profile?.projectId);
 // A second Mac (2호) otherwise only learned in prose that restoring is how to share; the button is its to-do.
 const restoreOffer=!!onRestoreOps&&(!!restoreFrom||profile?.sync?.state==='not-configured');
 const {sync:syncAttention,waiting}=controlProfileWaiting({pending:pending.length,attention:attention.length,restoreOffer,otherControls:otherControls.length,sync:profile?.sync});
 const connectionLine=connectionsRead==='reading'?'확인 중…':connectionsRead==='failed'?'':connections.length===0?'표시할 AI가 없습니다.':CONNECTION_GROUPS.map(([label,match])=>{const names=connections.filter(match).map(c=>AGENT_NAMES[c.agent]??c.agent);return names.length?`${label}: ${names.join(', ')}`:'';}).filter(Boolean).join(' · ');
 const shownCandidates=allCandidates?pending:pending.slice(0,CANDIDATE_PAGE);
 return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" onClick={dismiss}>
  <section ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="control-profile-title" data-testid="control-profile-panel" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] outline-none" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(!isDialogDismissKey(e.nativeEvent))return;e.preventDefault();e.stopPropagation();dismiss();}}>
   <div className="flex items-start justify-between gap-3"><div><h2 id="control-profile-title" className="text-xl font-bold">아젠투지 설정</h2><p className="mt-1 text-sm text-[var(--ink-3)]">어느 프로젝트에서든 쓰는 아젠투지(OPS)의 운영 기억과 연결 상태입니다.</p></div><button type="button" className={`${button} shrink-0 whitespace-nowrap`} onClick={dismiss} aria-label="아젠투지 설정 닫기">닫기</button></div>
   {/* The status card: what is true now, what waits for a person, and the main action — always open. */}
   <div className="mt-4 rounded-xl border border-[var(--line)] p-3" data-testid="control-profile-status">
    <p role="status" className="font-semibold">{state}</p>
    {profile?.problem&&<p className="mt-1 text-sm text-amber-600">{profile.problem}</p>}
    <OpsFolderMigrationNotice record={migration}/>
    {profile?.sync&&<p role="status" className={`mt-1 text-sm${syncAttention?' text-amber-600':''}`}>{profile.sync.state==='current'?'다른 Mac의 운영 기억과 동기화됨':profile.sync.state==='not-configured'?'이 Mac 사용자에게만 저장 · 다른 Mac과 이으려면 기존 OPS 운영 폴더(AgentsToZ-OPS, 예전 이름 AgentsToZ-Control)를 복원하세요.':profile.sync.problem}</p>}
    {(waiting||profile?.state==='ready')&&<div className="mt-3" data-testid="control-profile-todo">{waiting?<>
     <h3 className="text-sm font-bold">지금 할 일</h3>
     {(pending.length>0||attention.length>0)&&<div className="mt-2 flex flex-wrap gap-2">
      {pending.length>0&&<button type="button" className={button} onClick={()=>document.getElementById('control-profile-pending-title')?.focus()}>{`저장 후보 ${pending.length}개 검토`}</button>}
      {attention.length>0&&<button type="button" className={button} onClick={()=>reveal('connections')}>{`AI 연결 확인 필요 · ${attention.map(c=>AGENT_NAMES[c.agent]??c.agent).join(', ')}`}</button>}
     </div>}
     {syncAttention&&<div className="mt-2 rounded-lg border border-[var(--line)] p-3 text-sm" data-testid="control-profile-sync-attention"><p className="font-semibold">운영 기억 동기화 확인</p><p className="mt-1">{CONTROL_SYNC_ATTENTION_TEXT}</p>{profile?.state==='ready'&&profile.backend==='control-folder'&&profile.profileId&&profile.memoryId&&<><button type="button" className={`${button} mt-2`} aria-expanded={showConflict} onClick={()=>setShowConflict(v=>!v)}>운영 기억 비교</button>{showConflict&&<ControlMemoryConflictPanel key={`${profile.profileId}:${profile.memoryId}`} profileId={profile.profileId} memoryId={profile.memoryId} request={body=>requestControlProfile('memory-conflict',body)} onResolved={()=>void refresh()}/>}</>}{onOpenMemoryStatus&&<button type="button" className={`${button} mt-2`} onClick={onOpenMemoryStatus}>장기기억 현황 보기</button>}</div>}
     {restoreOffer&&<div className="mt-2 rounded-lg border border-[var(--line)] p-3 text-sm" data-testid="control-profile-restore"><p>{restoreFrom?`${restoreFrom}에서 쓰는 아젠투지(OPS)가 있습니다. 새로 만들면 운영 기억이 갈라지니 복원해서 이어가세요.`:'다른 Mac에서 아젠투지(OPS)를 쓰고 있다면 복원해서 같은 운영 기억을 이어가세요.'}</p><button type="button" className={`${button} mt-2`} onClick={onRestoreOps}>다른 Mac의 아젠투지 복원</button></div>}
     {otherControls.map(c=><div key={c.projectId} className="mt-2 rounded-lg border border-[var(--line)] p-3 text-sm"><p className="break-all">등록된 OPS 운영 폴더의 기억: {c.memoryId}</p><button type="button" className={`${button} mt-2`} disabled={busy} onClick={()=>void operate(()=>profile?.state==='ready'?requestControlProfile('attach',{projectId:c.projectId,expectedProfileId:profile.profileId}):requestControlProfile('prepare',{projectId:c.projectId}))}>이 운영 기억을 아젠투지에 연결</button></div>)}
    </>:<p className="text-sm text-[var(--ink-3)]">기다리는 후보나 연결 확인이 없습니다.</p>}</div>}
    {bypassOn&&<p className="mt-3 text-sm font-semibold text-amber-600" data-testid="control-profile-bypass-on">{`권한 우회 켜짐 · ${AGENT_NAMES[launchAgent]}를 승인 없이 실행합니다.`}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
     <button type="button" className={`${button} bg-[var(--accent)] font-semibold text-[var(--on-accent)]`} disabled={busy||!launchReady} onClick={()=>void openSurface()}>{launchSurface==='app'&&launchAgent==='agy'?'Antigravity 앱 열기 (OPS 폴더는 앱에서 선택)':`아젠투지를 ${launchLabel} 열기`}</button>
     <button type="button" className={button} onClick={()=>reveal('launch')}>열기 방식 바꾸기</button>
     <button type="button" className={button} disabled={busy||profile?.state!=='ready'||!profile.projectId} title={!profile?.projectId?'OPS 운영 폴더(AgentsToZ-OPS)를 이 Mac에 연결하면 사용할 수 있습니다.':undefined} onClick={onOpenWork}>아젠투지 채팅·워크룸 열기</button>
    </div>
    {profile&&!launchReady&&<p className="mt-2 text-xs text-[var(--ink-3)]">{localOnly?'로컬 전용 OPS는 패널·기억 호출을 지원합니다. 열기와 채팅·워크룸에는 기존 OPS 운영 폴더(AgentsToZ-OPS, 예전 이름 AgentsToZ-Control) 연결이 필요하며 자동으로 만들지 않습니다.':'OPS 기억과 등록 운영 폴더 연결을 먼저 확인하세요.'}</p>}
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void operate(()=>requestControlProfile('prepare',{}))}>{busy?'확인 중…':'아젠투지 준비·연결 다시 확인'}</button><button type="button" className={button} disabled={busy} onClick={()=>void operate(()=>refresh())}>상태 다시 확인</button></div>
    {results('status')}
   </div>
   {/* The one thing here that waits for the user, so it sits right under the status (UX audit 2026-10-25). */}
   <section className="mt-4" data-testid="control-profile-pending" aria-labelledby="control-profile-pending-title"><h3 id="control-profile-pending-title" tabIndex={-1} className="font-bold">운영 기억 저장 후보 · {pending.length}</h3><p className="mt-1 text-xs">{localOnly&&pending.length===0?'이 Mac 전용 운영 기억은 AI가 남긴 기억을 후보 없이 바로 저장합니다. 저장된 내용은 아래 「저장된 운영 기억」에서 봅니다.':'AI에게 “아젠투지, 이 운영 결정을 기억 후보로 남겨줘”라고 요청한 뒤 여기서 저장합니다. 후보 접수는 저장 완료와 다릅니다.'}</p>
    <div id="control-profile-pending-list">{shownCandidates.map(p=><CandidateCard key={p.id} candidate={p} busy={busy} saveDisabled={profile?.state!=='ready'} onSave={()=>void operate(()=>requestControlProfile('review',{id:p.id,accept:true,expectedRevision:profile?.revision}),'pending')} onReject={()=>void operate(()=>requestControlProfile('review',{id:p.id,accept:false,expectedRevision:profile?.revision??''}),'pending')}/>)}</div>
    {pending.length>CANDIDATE_PAGE&&<button type="button" className={`${button} mt-3`} aria-expanded={allCandidates} aria-controls="control-profile-pending-list" onClick={()=>setAllCandidates(all=>!all)}>{allCandidates?'후보 접기':`후보 ${pending.length-CANDIDATE_PAGE}개 더 보기`}</button>}
    {results('pending')}
   </section>
   <FoldSection id="control-profile-launch" testId="control-profile-launch" title="아젠투지 열기 방식" open={details.launch} onToggle={()=>toggleDetail('launch')} summary={<p className="mt-1 text-sm" data-testid="control-profile-launch-summary">{launchSummary}</p>}>
    <fieldset className="mt-2 rounded-xl border border-[var(--line)] p-3" disabled={busy}>
     <legend className="sr-only">아젠투지 열기</legend>
     <div className="flex flex-wrap gap-3">
      <label className="inline-flex items-center gap-2 text-sm">어디서 열까요?<select aria-label="OPS 실행 표면" className={button} value={launchSurface} onChange={e=>updateLaunch({surface:e.target.value as typeof launchSurface})}><option value="app">외부 AI 앱</option><option value="workroom">워크룸</option><option value="orca-floating">Orca 플로팅</option><option value="orca-worktree">Orca 워크트리</option><option value="buzz">Buzz 채널</option></select></label>
      {launchSurface!=='buzz'&&<label className="inline-flex items-center gap-2 text-sm">AI<select aria-label="OPS 실행 AI" className={button} value={launchAgent} onChange={e=>updateLaunch({agent:e.target.value as AgentsToZUseWorkroomAgent})}><option value="codex">Codex</option><option value="claude">Claude</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select></label>}
     </div>
     {launchSurface==='app'&&launchAgent==='codex'&&<label className="mt-2 flex items-center gap-2 text-sm">Codex 앱 동작<select aria-label="OPS Codex 앱 동작" className={button} value={launchMode} onChange={e=>updateLaunch({mode:e.target.value as typeof launchMode})}><option value="reopen">기존 대화 열기</option><option value="prepare">첫 대화 연결 준비</option></select></label>}
     {launchSurface==='app'&&launchAgent==='codex'&&launchMode==='prepare'&&<p className="mt-2 text-xs">기존 대화가 없으면 첫 연결 확인용 고정 메시지를 보낼 수 있습니다.</p>}
     {opsLaunchBypassSupported(launchAgent,launchSurface)&&<label className="mt-2 flex items-center gap-2 text-sm"><input aria-label="OPS 승인 없이 실행" type="checkbox" checked={launchBypass} onChange={e=>updateLaunch({bypass:e.target.checked})}/>승인 없이 실행 (권한 우회)</label>}
     {launchSurface==='app'&&launchAgent!=='claude'&&<p className="mt-2 text-xs">이 앱의 실행 권한은 해당 AI 앱에서 설정합니다. AgentsToZ의 열기 옵션으로 변경할 수 없습니다.</p>}
     <p className="mt-2 text-xs">{launchSurface==='workroom'?'기존 워크룸 실행기를 사용합니다. 초기 출력·로그인·신뢰 확인 후 지시하세요.':launchSurface==='buzz'?'연결된 OPS 운영 채널 정보를 확인하고 Buzz를 엽니다. Buzz 공식 딥링크가 없어 채널은 앱에서 직접 선택합니다.':launchSurface.startsWith('orca-')?'기존 Orca 실행기를 사용하며 워크트리를 표시할 수 없으면 같은 폴더의 플로팅으로 전환 사실을 알립니다.':launchAgent==='agy'?'Antigravity 앱을 열기만 합니다 · 이 앱은 폴더를 받지 않으므로 OPS 운영 폴더는 앱에서 선택하세요.':'현재 연결된 OPS 운영 폴더를 엽니다. DEV 프로젝트를 대신 열지 않습니다.'}</p>
     <p className="mt-3 text-sm">음성은 화면 아래 「아젠투지 호출」을 누르세요.<button type="button" className={button+' ml-2'} data-testid="control-profile-voice-settings" disabled={profile?.state!=='ready'} onClick={()=>{onClose();window.dispatchEvent(new Event(OPEN_OPS_VOICE_EVENT));}}>음성 창 열기</button></p>
    </fieldset>
    {results('launch')}
   </FoldSection>
   {profile?.state==='ready'&&<SavedOperatingMemory revision={profile.revision} reload={statusReads} localOnly={localOnly} expanded={details['saved-memory']} onToggle={()=>toggleDetail('saved-memory')}/>}
   {/* The device panel reads only while visible (its own `visible`), so folded it stays in the page without a request. */}
   {profile?.state==='ready'&&<FoldSection id="control-profile-device-memory" testId="control-profile-device-memory" title="아젠투지별 기억" open={details['device-memory']} onToggle={()=>toggleDetail('device-memory')} summary={<p className="mt-1 text-xs text-[var(--ink-3)]">이 Mac의 운영 환경과 사용 습관입니다. 펼치면 불러옵니다.</p>}>
    <DeviceOperatingMemoryPanel request={deviceMemoryRequest} visible={details['device-memory']}/>
   </FoldSection>}
   <FoldSection id="control-profile-connections" testId="control-profile-connections" title="AI별 MCP 사용 설정" open={details.connections} onToggle={()=>toggleDetail('connections')} foldable={connections.length>0}
    summary={connectionsRead==='failed'?<p role="alert" className="mt-1 text-sm text-red-500">AI별 연결 상태를 읽지 못했습니다. 아젠투지 설정을 다시 열면 다시 확인합니다.</p>:<p className="mt-1 text-sm" data-testid="control-profile-connections-summary">{connectionLine}</p>}>
    <p className="mt-1 text-xs">이 목록은 설정 등록 상태입니다. 실제 도구 응답은 각 AI 대화에서 “아젠투지 상태 확인”을 요청해 확인합니다.</p>
    {connections.map(c=><div key={c.agent} className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] p-2"><div><strong>{AGENT_NAMES[c.agent]??c.agent}</strong><p className="text-xs">{c.message}</p></div><button type="button" className={button} disabled={busy||c.state==='unavailable'} onClick={()=>void operate(async()=>{const result=await requestControlProfile('connections',{agent:c.agent});if(mounted.current)setConnections(current=>current.map(item=>item.agent===c.agent?result.connection:item));return result;},'connections')}>설정 점검·갱신</button></div>)}
    {results('connections')}
   </FoldSection>
   {profile?.state==='ready'&&onOpenProject&&<FoldSection id="control-profile-tester" testId="control-profile-tester" title="프로젝트 테스트 현황" open={details.tester} onToggle={()=>toggleDetail('tester')} summary={<p className="mt-1 text-xs text-[var(--ink-3)]">등록 프로젝트의 검사 결과입니다. 운영 기억의 연결 상태나 AI 응답 성공과는 별개입니다.</p>}>
    {testerSeen&&<TesterOverviewPanel transport={async request=>(await requestControlProfile('tester-results',request)).overview} onOpenProject={onOpenProject}/>}
   </FoldSection>}
   <FoldSection id="control-profile-guide" testId="control-profile-guide" title="기억 종류·호출 안내" open={details.guide} onToggle={()=>toggleDetail('guide')} summary={<>
    <p className="mt-1 text-sm">내 지시는 「내가 한 말」에서, 구현·검증 결과는 각 프로젝트 기억에서 확인합니다.</p>
    {(onOpenUserProfile||onOpenUserMemory)&&<div className="mt-2 flex flex-wrap gap-2">{onOpenUserProfile&&<button type="button" className={button} onClick={onOpenUserProfile}>내 프로필 보기</button>}{onOpenUserMemory&&<button type="button" className={button} onClick={onOpenUserMemory}>내 지시·결과 기록 보기</button>}</div>}
   </>}>
    <div className="mt-3 rounded-xl border border-[var(--line)] p-3 text-sm" data-testid="control-profile-memory-map">
     <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-bold">내 프로필</dt><dd>장기기억에서 직접 확인한 나의 선호와 적용 범위를 관리합니다.</dd></div><div><dt className="font-bold">내 지시</dt><dd>「내가 한 말」에서 지시 원문과 연결된 세션 기록을 봅니다. 과거 지시를 선호로 자동 확정하지 않습니다.</dd></div><div><dt className="font-bold">아젠투지 운영 기억</dt><dd>프로젝트 별칭·관계·일하는 방식. 저장된 내용과 저장 후보를 이 화면에서 봅니다.</dd></div><div><dt className="font-bold">프로젝트 기억</dt><dd>각 프로젝트에서 설계·수정·검증 경험을 이어갑니다.</dd></div></dl>
    </div>
    <p className="mt-2 text-sm">호출: <strong>agentstoz · 아젠투지 · 에이전츠투지</strong></p>
   </FoldSection>
   <details className="mt-4 text-xs"><summary className="cursor-pointer">고급 정보</summary><dl className="mt-1 space-y-2"><div><dt>기억 식별자</dt><dd className="break-all">{profile?.memoryId??'준비 후 표시'}</dd></div><div><dt>마지막 기억 갱신</dt><dd>{profile?.lastSavedAt?new Date(profile.lastSavedAt).toLocaleString('ko-KR'):'확인된 기록 없음'}</dd></div></dl></details>
  </section>
 </div>;
}
