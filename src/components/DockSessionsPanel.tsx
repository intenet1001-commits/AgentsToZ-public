import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Loader2,RefreshCw,Save,X} from 'lucide-react';
import {DockWeeklyUsage} from './DockWeeklyUsage';
import {DockMemoryConflictReview} from './DockMemoryConflictReview';
import {isTauri} from '../lib/env';
import {useAppLanguage} from '../useAppLanguage';
import {dockSessionsCopy} from '../i18n';
import {projectMemoryApi} from '../ProjectMemoryPanel';
import {visibleContextSessions} from '../contextSessionVisibility';
import {canBulkDismissContextSession,contextSnapshotKey,dismissContextSessions,restoreContextSessions,useContextDismissals,withoutDismissedContextSessions} from '../contextSessionCleanup';
import {acknowledgeContextCommand,checkContextCommand,contextCommandAttempts,contextCommandBindings,syncAndRunContextCommand,syncAndRunOrcaContextCommand} from '../contextSessionCommandClient';
import type {ContextCommand,ContextCommandBinding} from '../contextSessionCommand';
import {contextCommandAvailability,contextCommandButtonState,contextCommandManualGuide} from '../contextSessionCommandAvailability';
import {resolveContextSessionProjectBinding} from '../contextSessionProject';
import {buildWorktreeContextCandidates,type WorktreeContextProject} from '../worktreeContextCandidates';
import type {ContextProjectNavigationCandidate} from '../contextProjectNavigation';
import type {ProjectMemoryRemoteState} from '../projectMemorySyncState';
import {phoneDateTime} from '../phoneTime';
import {PROJECT_ROOT_MISSING,dockSyncButtonState,sessionMemoryAction,type SessionMemoryAction,type SessionMemoryStatusState} from './aiUsageMemoryState';
import {contextSessionMemoryPath,contextSessionProjectPath,voiceProjectMemoryIsBlocked,type ContextSession} from '../contextSessionMemoryPath';
import {pauseBackgroundCheck,publishUnsaved,saveTargets,useUnsavedSessionMemory,type SaveItem,type UnsavedProject} from '../unsavedSessionMemory';
import {measuredContextPercent} from '../contextUsageReading';
import {advanceContextCommandTrack,contextCommandOutcomeView,contextCommandTrackHome,pruneContextCommandTracks,readContextCommandTracks,startContextCommandTrack,writeContextCommandTracks,type ContextCommandTrack} from '../contextCommandOutcome';

/**
 * 「열린 AI 세션」 — the dock's expandable list of open project + agent sessions (VOC 2026-10-24).
 *
 * Automatic checkpoints already save at the context thresholds; this is the manual path next to them:
 * each row shows the session's context %, when its project memory was last saved locally and backed up (folded),
 * and 「지금 저장」·「동기화」, and the header saves every project with unsaved work at once. It reuses the
 * AI usage panel's data (`/api/context-usage`) and its memory rules (`sessionMemoryAction`), so a row never
 * offers a save the usage panel would refuse.
 * Mounted only while expanded. While folded, src/unsavedSessionMemory.ts checks for unsaved work on its own
 * slower clock; while open this list publishes what it read there instead. Saves run in that store, so
 * folding the list mid-run does not drop the rest.
 * After a /compact·/clear is sent, the row follows its outcome on the same 5s read (src/contextCommandOutcome.ts):
 * 「요약 처리 중」 → 「요약 완료 · 컨텍스트 62% → 18%」, 「새 대화로 비움」 or 「결과 확인 안 됨」 with the reason. Nothing is resent.
 */
const apiBase=()=>isTauri()?'http://127.0.0.1:3001':'';
const CONTEXT_POLL_MS=5_000;
const MEMORY_RECHECK_MS=30_000;
const ROW_LIMIT=12;
/** `conflict`: the row's own sync was refused because both sides changed; its 「비교·해결」 stays offered. */
type RowResult={ok:boolean;message:string;conflict?:boolean};

const pathLeaf=(folderPath:string|null|undefined)=>folderPath?.replace(/[/\\]+$/,'').split(/[/\\]/).filter(Boolean).pop()||'';
const ITEM_DONE:readonly SaveItem['status'][]=['saved','skipped','failed','unknown','stopped'];
const needsRemember=(state:SessionMemoryStatusState|undefined)=>state?.kind==='ready'&&state.status.exists===true&&state.status.activity?.needsRemember===true;
const statusLine:Record<SessionMemoryAction,string>={
  unavailable:'연결된 프로젝트 폴더가 없어 저장하지 않습니다',
  checking:'기억 상태 확인 중…',
  missing:'세션 폴더가 더 이상 없습니다',
  retry:'기억 상태를 확인하지 못했습니다',
  ephemeral:'임시 작업 폴더 · 장기기억 대상이 아닙니다',
  start:'장기기억 없음 · 지금 저장하면 시작합니다',
  remember:'저장할 새 활동이 있습니다',
  saved:'장기기억 최신',
  push:'Supabase 백업이 필요합니다',
  pull:'Supabase 쪽이 더 최신입니다',
  conflict:'로컬·Supabase가 모두 바뀌었습니다 · 「비교·해결」에서 고르세요',
};

export function DockSessionsPanel(){
  const [lang]=useAppLanguage(),copy=dockSessionsCopy(lang);
  const [sessions,setSessions]=useState<ContextSession[]|null>(null),[loadError,setLoadError]=useState('');
  // false only when the host says no Claude statusline capture exists yet; an older host without the field says nothing.
  const [captureInstalled,setCaptureInstalled]=useState(true);
  const sessionsRef=useRef(sessions);sessionsRef.current=sessions;
  const [candidates,setCandidates]=useState<ContextProjectNavigationCandidate[]>([]);
  const [autoSave,setAutoSave]=useState<{enabled:boolean;thresholds:number[]}|null>(null);
  const [memory,setMemory]=useState<Record<string,SessionMemoryStatusState>>({});
  const memoryRef=useRef(memory);memoryRef.current=memory;
  const inFlight=useRef<Set<string>>(new Set());
  const [busy,setBusy]=useState<{sessionId:string}|null>(null);
  const {run:saveRun}=useUnsavedSessionMemory({check:false});
  const saving=!!saveRun?.running;
  useEffect(()=>pauseBackgroundCheck(),[]);
  const [results,setResults]=useState<Record<string,RowResult>>({});
  // 「비교·해결」: the one row whose comparison is open, and save conflicts already resolved there (`${run id}:${folder}`),
  // whose refusal no longer stands and so is not shown again.
  const [review,setReview]=useState<string|null>(null);
  const [resolvedSaves,setResolvedSaves]=useState<ReadonlySet<string>>(new Set());
  const dismissed=useContextDismissals();
  const [cleanup,setCleanup]=useState<{keys:string[];error?:string}|null>(null);
  const [commandBindings,setCommandBindings]=useState<ContextCommandBinding[]>([]);
  const [pendingCommands,setPendingCommands]=useState(contextCommandAttempts);
  useEffect(()=>{const refresh=()=>setPendingCommands(contextCommandAttempts());window.addEventListener('storage',refresh);return()=>window.removeEventListener('storage',refresh);},[]);
  // Sent /compact·/clear whose outcome the rows show. Kept in localStorage so folding the list or the other dock window
  // does not lose them; advanced only on a successful session read (no timer of its own).
  const [tracks,setTracks]=useState<ContextCommandTrack[]>(readContextCommandTracks);
  const saveTracks=(next:ContextCommandTrack[])=>{writeContextCommandTracks(next);setTracks(next);};
  useEffect(()=>{const refresh=()=>setTracks(readContextCommandTracks());window.addEventListener('storage',refresh);return()=>window.removeEventListener('storage',refresh);},[]);
  const runFlight=useRef(false);
  const clearRows=(targets:ContextSession[])=>{
    try{setCleanup({keys:dismissContextSessions(targets)});}catch{setCleanup({keys:[],error:'목록 정리를 저장하지 못했습니다. 다시 시도하세요.'});}
  };

  // One read at a time: a slow Orca/cmux probe must not stack 5-second polls whose late answers overwrite newer rows.
  // A failed read keeps the last good rows on screen and says so.
  const sessionsFlight=useRef(false),bindingsFlight=useRef(false);
  const loadSessions=useCallback(async()=>{
    if(sessionsFlight.current)return;sessionsFlight.current=true;
    try{const res=await fetch(`${apiBase()}/api/context-usage`,{signal:AbortSignal.timeout(10_000)});const json=await res.json();if(!res.ok)throw Error(json.error||`요청 실패 (${res.status})`);setSessions(Array.isArray(json.sessions)?json.sessions:[]);setCaptureInstalled(json.captureInstalled!==false);setLoadError('');}
    catch(e){const message=e instanceof Error&&e.name!=='TimeoutError'?e.message:'세션 목록 응답이 늦어 새로 읽지 못했습니다.';setLoadError(sessionsRef.current?`${message} 마지막으로 읽은 목록을 표시합니다.`:message);}
    finally{sessionsFlight.current=false;}
  },[]);
  // Workroom bindings are their own read: a slow context list must not hold them back, and a failure removes them.
  const loadBindings=useCallback(async()=>{
    if(bindingsFlight.current)return;bindingsFlight.current=true;
    try{setCommandBindings(await contextCommandBindings());}catch{setCommandBindings([]);}finally{bindingsFlight.current=false;}
  },[]);
  useEffect(()=>{
    let stopped=false;
    const read=()=>{if(!stopped&&!document.hidden){void loadSessions();void loadBindings();}};
    read();const timer=setInterval(read,CONTEXT_POLL_MS);document.addEventListener('visibilitychange',read);
    // Project names: the registered list, read once per expand (the main window's richer worktree lists live elsewhere).
    void fetch(`${apiBase()}/api/ports`,{signal:AbortSignal.timeout(10_000)}).then(r=>r.ok?r.json():[]).then((ports:unknown)=>{if(!stopped&&Array.isArray(ports))setCandidates(buildWorktreeContextCandidates(ports.filter((p):p is WorktreeContextProject=>!!p&&typeof p.id==='string'&&typeof p.name==='string'),{}));}).catch(()=>{});
    void fetch(`${apiBase()}/api/project-memory/auto-checkpoint/status`,{signal:AbortSignal.timeout(10_000)}).then(r=>r.ok?r.json():null).then(v=>{if(!stopped&&v?.settings&&typeof v.settings.enabled==='boolean')setAutoSave({enabled:v.settings.enabled,thresholds:Array.isArray(v.settings.thresholds)?v.settings.thresholds.filter((n:unknown)=>typeof n==='number'):[]});}).catch(()=>{});
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',read);};
  },[loadSessions,loadBindings]);
  useEffect(()=>{
    if(!sessions)return;
    const now=Date.now(),previous=readContextCommandTracks(),advanced=previous.map(t=>advanceContextCommandTrack(t,sessions,now));
    // A confirmed /clear retires the old conversation's row, as sending it used to; that row stays while the result
    // is shown there (pinned below) and the result moves to the new conversation's row once that one is listed.
    const cleared=new Set(advanced.filter((t,i)=>t.outcome?.kind==='cleared'&&previous[i]?.outcome?.kind!=='cleared').map(t=>t.sessionId));
    if(cleared.size)try{dismissContextSessions(sessions.filter(s=>cleared.has(s.sessionId)));}catch{/* display only */}
    const next=pruneContextCommandTracks(advanced,now);
    if(JSON.stringify(next)!==JSON.stringify(previous))writeContextCommandTracks(next);
    setTracks(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);
  },[sessions]);

  const refreshMemory=useCallback(async(folderPath:string):Promise<SessionMemoryStatusState>=>{
    setMemory(previous=>({...previous,[folderPath]:{kind:'checking'}}));
    let next:SessionMemoryStatusState;
    try{
      const status=await projectMemoryApi.detect(folderPath);
      let remote:ProjectMemoryRemoteState={kind:'not-required'};
      if(status.exists&&status.config?.autoBackup!==false){
        try{const r=await projectMemoryApi.remoteStatus({folderPath});remote={kind:'ready',status:{exists:r.exists===true,createdAt:typeof r.createdAt==='string'?r.createdAt:null,contentHash:typeof r.contentHash==='string'?r.contentHash:null,inSync:r.inSync===true}};}
        catch(e){remote={kind:'error',message:e instanceof Error?e.message:String(e)};}
      }
      next={kind:'ready',status,remote,checkedAt:Date.now()};
    }catch(e){next={kind:'error',message:e instanceof Error?e.message:String(e),code:typeof (e as {code?:unknown})?.code==='string'?(e as {code:string}).code:undefined,checkedAt:Date.now()};}
    setMemory(previous=>({...previous,[folderPath]:next}));
    return next;
  },[]);

  // A row with an unconfirmed /compact·/clear stays, even after its window closed or it was hidden: its check and release
  // buttons live on the row, and a fence nobody can see would block that conversation silently.
  const fencedIds=new Set(pendingCommands.map(a=>a.providerSessionId));
  const listed=visibleContextSessions(sessions??[]);
  // So does a row showing a sent command's outcome (waiting, or the result for a while) — on the row it is shown on.
  const listedIds=new Set(withoutDismissedContextSessions(listed,dismissed).map(s=>s.sessionId));
  const trackHome=(t:ContextCommandTrack)=>contextCommandTrackHome(t,listedIds);
  const pinnedIds=new Set([...fencedIds,...tracks.map(trackHome)]);
  const fenced=(sessions??[]).filter(s=>pinnedIds.has(s.sessionId)).map(s=>listed.includes(s)?s:{...s,surfacePresence:'gone' as const});
  const current=[...withoutDismissedContextSessions(listed.filter(s=>!pinnedIds.has(s.sessionId)),dismissed),...fenced];
  const clearable=current.filter(s=>!pinnedIds.has(s.sessionId)&&canBulkDismissContextSession(s));
  // Pinned rows first, so the row limit never cuts away the one place its fence can be checked or its result read.
  const reading=(s:ContextSession)=>measuredContextPercent(s)??-1;
  const rows=[...current].sort((a,b)=>Number(pinnedIds.has(b.sessionId))-Number(pinnedIds.has(a.sessionId))||reading(b)-reading(a)).slice(0,ROW_LIMIT);
  const folders=[...new Set(rows.flatMap(s=>{const f=voiceProjectMemoryIsBlocked(s)?null:contextSessionMemoryPath(s);return f?[f]:[];}))];
  const folderKey=folders.join('\n');
  // One probe at a time (each is blocking filesystem/git work in the local API), cached for 30s.
  useEffect(()=>{
    const due=folderKey.split('\n').filter(Boolean).filter(f=>{
      const cached=memoryRef.current[f];
      if(inFlight.current.has(f)||cached?.kind==='checking')return false;
      if(cached?.kind==='error'&&cached.code===PROJECT_ROOT_MISSING)return false;
      return !cached||Date.now()-cached.checkedAt>=MEMORY_RECHECK_MS;
    });
    if(!due.length)return;
    let cancelled=false;
    void(async()=>{for(const f of due){if(cancelled)return;inFlight.current.add(f);try{await refreshMemory(f);}finally{inFlight.current.delete(f);}}})();
    return()=>{cancelled=true;};
    // memory is read through memoryRef: depending on it re-entered on every probe. The 5s session poll re-runs this.
  },[folderKey,sessions,refreshMemory]);

  const describe=(s:ContextSession)=>{
    const projectPath=contextSessionProjectPath(s),blocked=voiceProjectMemoryIsBlocked(s);
    const folder=blocked?null:contextSessionMemoryPath(s);
    const binding=resolveContextSessionProjectBinding(candidates,projectPath);
    const name=s.projectHint?.name??binding.projectName??(binding.relation==='ephemeral'?'임시 작업 폴더':pathLeaf(projectPath)||'등록되지 않은 프로젝트');
    const state=folder?memory[folder]:undefined;
    const action:SessionMemoryAction=blocked?'unavailable':sessionMemoryAction(folder,state);
    // Starting a new memory from this quick list only for a registered project or its worktree — never a stray folder.
    const registered=binding.relation==='project'||binding.relation==='worktree';
    return {folder,name,worktree:binding.worktreeName,state,action,blocked,registered};
  };

  const run=async(s:ContextSession,work:()=>Promise<string>)=>{
    if(runFlight.current||saving)return;runFlight.current=true;setBusy({sessionId:s.sessionId});
    setResults(previous=>{const next={...previous};delete next[s.sessionId];return next;});
    try{const message=await work();setResults(previous=>({...previous,[s.sessionId]:{ok:true,message}}));}
    catch(e){setResults(previous=>({...previous,[s.sessionId]:{ok:false,message:e instanceof Error?e.message:String(e),conflict:(e as {conflict?:unknown})?.conflict===true}}));}
    finally{runFlight.current=false;setBusy(null);setPendingCommands(contextCommandAttempts());}
  };
  // The row is one concrete session: the store saves with its own agent and re-checks right before it.
  const saveNow=(s:ContextSession)=>{const {folder,name,registered,action}=describe(s);if(!folder)return;
    void saveTargets([{folder,name,agent:s.sourceAgent,allowStart:action==='start'&&registered}]);};
  const syncNow=(s:ContextSession)=>{const {folder,name}=describe(s);if(!folder)return;void run(s,async()=>{
    const result=await projectMemoryApi.sync({folderPath:folder,projectName:name});
    await refreshMemory(folder);
    if(result.conflict){setReview(s.sessionId);throw Object.assign(Error('로컬·Supabase가 모두 바뀌어 덮어쓰지 않았습니다. 아래 비교에서 직접 고르세요.'),{conflict:true});}
    if(result.ok!==true)throw Error('동기화 완료를 확인하지 못했습니다.');
    void loadBindings(); // A Workroom command may follow at once; do not wait for the next poll.
    const message=result.action==='push'?'Supabase에 백업했습니다.':result.action==='pull'?'Supabase 기억을 로컬에 받았습니다.':'로컬과 Supabase가 이미 같습니다.';
    return message;
  });};
  const contextNow=(s:ContextSession,command:ContextCommand)=>{const {folder,name}=describe(s),binding=commandBindings.find(b=>b.providerSessionId===s.sessionId),support=contextCommandAvailability(s,binding,copy.command);
    if(!folder||!support.available)return;const startedAt=Date.now();void run(s,async()=>{
    const sync=()=>projectMemoryApi.sync({folderPath:folder,projectName:name}),progress=(message:string)=>setResults(previous=>({...previous,[s.sessionId]:{ok:true,message}}));
    const message=support.mode==='orca'?await syncAndRunOrcaContextCommand(s.sessionId,command,sync,progress)
      :binding?await syncAndRunContextCommand(binding,command,sync,progress):'';
    if(!message)throw Error('현재 대화와 워크룸의 연결을 확인하지 못했습니다. 명령을 보내지 않았습니다.');
    // Written, not yet processed: follow it on this row. The reading the person saw is the 「before」.
    saveTracks([...readContextCommandTracks().filter(t=>t.sessionId!==s.sessionId),startContextCommandTrack({session:s,sessionId:s.sessionId,command,
      surface:support.mode==='orca'?'orca':'workroom',startedAt,sentAt:Date.now(),workroomSessionId:s.workroomSessionId??binding?.sessionId??null})]);
    await refreshMemory(folder);void loadSessions();void loadBindings();
    return message;
  });};

  // 「비교·해결」 applies its choice under the same one-at-a-time lock as the row's other actions.
  const lockFor=(s:ContextSession)=>(on:boolean)=>{
    if(!on){runFlight.current=false;setBusy(null);return true;}
    if(runFlight.current||saving)return false;
    runFlight.current=true;setBusy({sessionId:s.sessionId});return true;
  };
  const resolvedFor=(s:ContextSession,folder:string)=>(message:string)=>{
    setReview(null);setResults(previous=>({...previous,[s.sessionId]:{ok:true,message}}));
    if(saveRun)setResolvedSaves(previous=>new Set(previous).add(`${saveRun.id}:${folder}`));
    void refreshMemory(folder);void loadBindings();
  };

  const openSession=(s:ContextSession)=>{if(!s.navigation?.available||!s.navigation.exact)return;void run(s,async()=>{
    const response=await fetch(`${apiBase()}/api/context-sessions/navigate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s.sessionId,sourceAgent:s.sourceAgent}),signal:AbortSignal.timeout(15_000)});
    const result=await response.json();
    if(!response.ok||result.success!==true||result.exact!==true)throw Error(result.error||'같은 대화로 이동했는지 확인하지 못했습니다.');
    return `${result.message||'해당 대화를 열었습니다.'} ${contextCommandManualGuide(s)}`;
  });};

  // Unsaved projects among these rows, one per folder, newest session first: the dock card and badge read this.
  const described=rows.map(s=>({s,...describe(s)}));
  const settled=sessions!==null&&described.every(d=>!d.folder||(!!d.state&&d.state.kind!=='checking'));
  const unsaved:UnsavedProject[]=[];
  {const seen=new Set<string>();for(const d of [...described].sort((a,b)=>a.s.ageMs-b.s.ageMs)){
    if(!d.folder||seen.has(d.folder)||d.action==='conflict'||!needsRemember(d.state))continue;seen.add(d.folder);
    unsaved.push({folder:d.folder,name:d.name,agent:d.s.sourceAgent,lastRememberedAt:d.state?.kind==='ready'?d.state.status.activity?.lastRememberedAt??null:null});}}
  const unsavedKey=JSON.stringify(unsaved);
  useEffect(()=>{if(settled)publishUnsaved(JSON.parse(unsavedKey) as UnsavedProject[]);},[settled,unsavedKey]);
  // A finished item changed that folder's memory: read it again rather than wait for the 30s recheck.
  const refreshed=useRef<Set<string>>(new Set());
  useEffect(()=>{if(!saveRun)return;for(const item of saveRun.items){const key=`${saveRun.id}:${item.folder}`;
    if(ITEM_DONE.includes(item.status)&&item.status!=='stopped'&&!refreshed.current.has(key)){refreshed.current.add(key);void refreshMemory(item.folder);}}},[saveRun,refreshMemory]);
  const saveAll=()=>void saveTargets(unsaved.map(({folder,name,agent})=>({folder,name,agent})));
  const runDone=saveRun?saveRun.items.filter(i=>ITEM_DONE.includes(i.status)).length:0;

  // One coordinator checkpoints Claude and Codex sessions alike (as the AI usage panel says), so the line names both.
  const autoLine=autoSave?autoSave.enabled?copy.autoOn.replace('{thresholds}',autoSave.thresholds.join('·')):copy.autoOff:null;
  return <section className="az-sessions" aria-label="열린 AI 세션" data-testid="voice-dock-sessions-panel">
    <header className="az-sessions__head">
      <div><strong>최근 AI 세션{sessions?` ${current.length}`:''}</strong>{autoLine&&<small data-testid="voice-dock-sessions-auto">{autoLine}</small>}</div>
      <div className="az-sessions__tools">
      <button type="button" className="az-sessions__save-all" data-testid="voice-dock-sessions-save-all" disabled={saving||!!busy||!unsaved.length}
        title={saving?'기억을 하나씩 차례로 저장하고 있습니다':unsaved.length?'저장할 새 활동이 있는 프로젝트를 하나씩 차례로 저장합니다':'저장할 새 활동이 있는 프로젝트가 없습니다'} onClick={saveAll}>
        {saving?<Loader2 size={12} className="az-session__spin"/>:<Save size={12}/>}{saving&&saveRun?`저장 중 ${runDone}/${saveRun.items.length}`:`모두 저장${unsaved.length?` (${unsaved.length})`:''}`}</button>
      <button type="button" className="az-sessions__icon" aria-label="세션 목록 새로고침" title="세션 목록 새로고침" onClick={()=>{void loadSessions();for(const f of folders)if(!inFlight.current.has(f))void refreshMemory(f);}}><RefreshCw size={13}/></button>
      </div>
    </header>
    <DockWeeklyUsage/>
    <div className="az-sessions__cleanup">
      <button type="button" disabled={saving||!!busy||!clearable.length} data-testid="voice-dock-sessions-clear" title="활동 중이거나 실행 중임이 확인된 세션을 제외하고 최근 목록에서 숨깁니다. 대화와 장기기억은 보존합니다." onClick={()=>clearRows(clearable)}>지난 목록 정리{clearable.length?` (${clearable.length})`:''}</button>
      {cleanup?.keys.length? <span role="status">{cleanup.keys.length}개 정리 <button type="button" data-testid="voice-dock-sessions-undo" onClick={()=>{try{restoreContextSessions(cleanup.keys);setCleanup(null);}catch{setCleanup({...cleanup,error:'목록 복원을 저장하지 못했습니다. 다시 시도하세요.'});}}}>실행 취소</button></span>:null}
    </div>
    {cleanup?.error&&<p className="az-sessions__error" role="alert">{cleanup.error}</p>}
    {loadError&&<p className="az-sessions__error" role="alert">{loadError}</p>}
    {!captureInstalled&&<p className="az-sessions__hint" data-testid="voice-dock-sessions-capture">{copy.captureMissing}</p>}
    {sessions===null?(!loadError&&<p className="az-sessions__hint" role="status">불러오는 중…</p>)
    :rows.length===0?<p className="az-sessions__hint" data-testid="voice-dock-sessions-empty">표시할 최근 AI 세션이 없습니다. 정리한 세션도 새 활동이 생기면 다시 표시합니다.</p>
    :<ul className="az-sessions__list">{described.map(({s,folder,name,worktree,state,action,registered})=>{
      // A zero reading is 「not measured yet」 (src/contextUsageReading.ts), shown like any unknown reading.
      const pct=measuredContextPercent(s),zeroReading=pct===null&&typeof s.usedPercent==='number';
      const level=pct===null?'none':pct>=90?'danger':pct>=70?'warn':'ok';
      const shown=tracks.filter(t=>trackHome(t)===s.sessionId);
      const ready=state?.kind==='ready'?state:null;
      const localAt=ready?(ready.status.modifiedAt||ready.status.config?.lastUpdatedAt||null):null;
      const backupAt=ready?(ready.remote.kind==='ready'?ready.remote.status.createdAt:ready.status.config?.lastBackedUpAt||null):null;
      const item=folder?saveRun?.items.find(i=>i.folder===folder):undefined;
      const rowSaving=item?.status==='saving',rowSyncing=busy?.sessionId===s.sessionId,result=results[s.sessionId];
      const saveConflictResolved=!!saveRun&&!!folder&&resolvedSaves.has(`${saveRun.id}:${folder}`);
      const saveResult=item&&ITEM_DONE.includes(item.status)&&item.message&&!(item.problem==='conflict'&&saveConflictResolved)?{ok:item.status==='saved'||item.status==='skipped',message:item.message}:null;
      // A refused save or sync says the two memories must be compared; this is where that happens (VOC 2026-11-01).
      const canReview=!!folder&&(action==='conflict'||item?.problem==='conflict'&&!saveConflictResolved||result?.conflict===true);
      // The save button answers only its own question (resolveProjectMemorySaveButtonAction); sync verbs stay on 동기화.
      const canSave=action==='start'?registered:needsRemember(state)&&action!=='conflict'&&action!=='checking';
      const canSync=!!folder&&ready?.status.exists===true&&!['conflict','checking','missing','ephemeral','unavailable'].includes(action);
      const syncButton=dockSyncButtonState(canSync,state),closed=s.surfacePresence==='gone';
      const agent=s.clientLabel||(s.sourceAgent==='claude'?'Claude':'Codex');
      const binding=commandBindings.find(b=>b.providerSessionId===s.sessionId),pending=pendingCommands.find(a=>a.providerSessionId===s.sessionId);
      const commandSupport=contextCommandAvailability(s,binding,copy.command);
      const commandButton=contextCommandButtonState({busy:!!busy,saving,canSync,pending:!!pending,support:commandSupport,memorySaved:action==='saved',memoryReason:statusLine[action]},copy.command);
      return <li key={s.sessionId} className="az-session" data-testid="voice-dock-session" data-action={action}>
        <div className="az-session__title">
          <span className="az-session__name" title={contextSessionProjectPath(s)??undefined}><strong>{name}</strong>{worktree?<em> · {worktree}</em>:null}</span>
          <span className="az-session__agent" data-agent={s.sourceAgent}>{agent}</span>
          {/* No aria-label: ARIA 1.2 forbids naming a generic <span>, so screen readers read its text — 「컨텍스트 72%」,
              or 「컨텍스트 확인 안 됨」 behind the visible dash. */}
          <span className="az-session__pct" data-level={level} data-testid="voice-dock-session-percent" title={zeroReading?'Claude는 시작·재개·요약 직후 다음 응답 전까지 사용량을 0으로 보고합니다. 다음 응답 뒤에 표시됩니다.':undefined}><small>{copy.context} </small>{pct===null?<><span aria-hidden="true">—</span><span className="az-voice-dock__sr-only">{copy.contextUnknown}</span></>:`${Math.round(pct)}%`}</span>
          <button type="button" className="az-session__dismiss" disabled={!!busy||saving||!contextSnapshotKey(s)||!!pending} aria-label={`${name} ${s.threadTitle||agent} 목록에서 숨기기`} title={pending?'결과를 확인할 명령이 있어 숨기지 않습니다.':'목록에서만 숨깁니다. 대화·장기기억은 보존하고 새 활동이 생기면 다시 표시합니다.'} onClick={()=>{if(shown.length)saveTracks(readContextCommandTracks().filter(t=>!shown.some(x=>x.id===t.id)));clearRows([s]);}}><X size={12}/></button>
        </div>
        <div className="az-session__bar" aria-hidden="true"><i data-level={level} style={{width:`${pct??0}%`}}/></div>
        {s.threadTitle&&<p className="az-session__thread">{s.threadTitle}</p>}
        <p className="az-session__state" data-action={action}>{action==='start'&&!registered?'등록되지 않은 폴더 · 장기기억 없음':statusLine[action]}{(action==='push'||action==='pull')&&needsRemember(state)?' · 저장할 새 활동도 있습니다':''}</p>
        {closed&&<p className="az-session__state" data-testid="voice-dock-session-closed">{pending?'세션 창이 닫혔습니다 · 결과를 확인할 명령이 있어 목록에 남겨 둡니다':'현재 열린 대화가 아닙니다 · 보낸 명령의 결과를 보여 주려고 잠시 남겨 둡니다'}</p>}
        {ready&&(localAt||backupAt)&&<details className="az-sessions__hint" data-testid="voice-dock-session-times"><summary>저장·백업 시각</summary><p>{`로컬 ${localAt?phoneDateTime(localAt):'—'} · 백업 ${backupAt?phoneDateTime(backupAt):'—'}`}</p></details>}
        <div className="az-session__actions">
          {action==='retry'&&folder
            ?<button type="button" disabled={!!busy} onClick={()=>void refreshMemory(folder)} title={state?.kind==='error'?state.message:undefined}>다시 확인</button>
            :<button type="button" className={canSave?'az-session__primary':undefined} data-testid="voice-dock-session-save" disabled={!!busy||saving||!canSave} title={canSave?'이 세션의 대화·작업을 프로젝트 장기기억에 지금 저장합니다':statusLine[action]} onClick={()=>saveNow(s)}>{rowSaving?<Loader2 size={12} className="az-session__spin"/>:<Save size={12}/>}{rowSaving?'저장 중…':item?.status==='pending'?'저장 대기':'지금 저장'}</button>}
          <button type="button" className={action==='push'||action==='pull'?'az-session__primary':undefined} data-testid="voice-dock-session-sync" data-synced={syncButton.synced||undefined} disabled={!!busy||saving||!syncButton.enabled} title={syncButton.synced?'로컬·Supabase가 이미 같습니다. 어느 한쪽이 바뀌면 다시 켜집니다':canSync?'로컬·Supabase를 비교해 안전한 방향으로만 동기화합니다':statusLine[action]} onClick={()=>syncNow(s)}>{rowSyncing?<Loader2 size={12} className="az-session__spin"/>:<RefreshCw size={12}/>}{rowSyncing?'동기화 중…':syncButton.synced?'동기화됨':'동기화'}</button>
          {canReview&&<button type="button" className="az-session__primary" data-testid="voice-dock-session-conflict-review" aria-expanded={review===s.sessionId} disabled={!!busy||saving} title="로컬·Supabase 기억을 항목별로 비교하고, 직접 고른 방법으로만 해결합니다" onClick={()=>setReview(review===s.sessionId?null:s.sessionId)}>비교·해결</button>}
        </div>
        {review===s.sessionId&&folder&&<DockMemoryConflictReview folder={folder} name={name} locked={saving||!!busy&&busy.sessionId!==s.sessionId} onLock={lockFor(s)} onDone={resolvedFor(s,folder)} onClose={()=>setReview(null)}/>}
        <div className="az-sessions__hint" data-testid="voice-dock-session-commands">
          <div className="az-session__actions">{(['compact','clear'] as const).map(command=><button type="button" key={command} data-testid={`voice-dock-session-${command}`} disabled={!commandButton.enabled} title={commandButton.enabled?`현재 세션의 기억 저장·Supabase 동기화를 확인한 뒤 /${command}를 전송합니다.`:commandButton.reason} onClick={()=>contextNow(s,command)}>{command==='compact'?'Compact · 대화 요약':'Clear · 새 대화'}</button>)}</div>
          <p data-testid="voice-dock-session-command-support">{commandButton.reason}</p>
          {!commandSupport.available&&<>
            <p>{contextCommandManualGuide(s)}</p>
            {s.navigation?.available&&s.navigation.exact&&<button type="button" disabled={!!busy||saving} data-testid="voice-dock-session-open" onClick={()=>openSession(s)}>원본 대화 열기</button>}
          </>}
        </div>
        {pending&&<div className="az-session__actions"><button type="button" disabled={!!busy||saving} data-testid="voice-dock-session-command-check" onClick={()=>void run(s,async()=>{const state=await checkContextCommand(pending);const orca=pending.surface==='orca';if(state==='rejected')return '명령을 보내기 전에 중단됐습니다. 입력칸과 저장 상태를 확인한 뒤 다시 실행할 수 있습니다.';if(state!=='written')throw Error(`명령 결과가 아직 미확정입니다. 자동으로 다시 보내지 않습니다. ${orca?'Orca를':'워크룸을'} 확인하세요.`);void loadSessions();
            // Confirmed late: follow it from the request time. The reading before it is not known any more.
            if(typeof pending.startedAt!=='number')return `/${pending.command} 전송을 확인했습니다. ${orca?'Orca':'워크룸'}에서 처리 결과를 확인하세요.`;
            saveTracks([...readContextCommandTracks().filter(t=>t.sessionId!==s.sessionId),startContextCommandTrack({session:null,sessionId:s.sessionId,command:pending.command,surface:orca?'orca':'workroom',startedAt:pending.startedAt,sentAt:Date.now(),workroomSessionId:s.workroomSessionId??(orca?null:pending.sessionId)})]);
            return `/${pending.command} 전송을 확인했습니다.`;})}>컨텍스트 명령 전송 확인</button>
          {/* A person releases this one receipt: in Orca after looking at the terminal, for a Workroom only once the host says
              that Workroom is closed (nothing more can reach it). Nothing releases it automatically, and nothing is resent. */}
          <button type="button" disabled={!!busy||saving} data-testid="voice-dock-session-command-acknowledge" title={pending.surface==='orca'?`Orca 화면에서 /${pending.command} 결과를 직접 확인한 뒤에만 누르세요. 이 요청 하나의 미확정 표시만 해제하며 명령을 다시 보내지 않습니다.`:`워크룸 세션이 닫힌 뒤에만 해제됩니다. 닫힌 세션에는 더 이상 전달되지 않으며 명령을 다시 보내지 않습니다.`} onClick={()=>void run(s,async()=>{const state=await acknowledgeContextCommand(pending);void loadSessions();if(state==='written')return `/${pending.command} 전송이 이미 확인돼 있습니다. ${pending.surface==='orca'?'Orca':'워크룸'}에서 처리 결과를 확인하세요.`;if(state==='rejected')return '명령을 보내기 전에 중단된 요청이었습니다. 필요하면 다시 실행할 수 있습니다.';if(state==='closed')return `워크룸 세션이 닫혀 이 /${pending.command} 요청은 더 전달될 수 없습니다. 미확정 표시를 해제했고 다시 보내지 않았습니다.`;return '미확정 표시를 해제했습니다. 필요하면 다시 실행할 수 있습니다.';})}>{pending.surface==='orca'?'직접 확인함 · 미확정 해제':'창 닫힘 확인 · 미확정 해제'}</button></div>}
        {saveResult&&<p className={saveResult.ok?'az-session__result':'az-session__result az-session__result--error'} role="status" data-testid="voice-dock-session-save-result">{saveResult.message}</p>}
        {result&&<p className={result.ok?'az-session__result':'az-session__result az-session__result--error'} role="status">{result.message}</p>}
        {shown.map(t=>{const view=contextCommandOutcomeView(t,Date.now(),sessions??[]);return <p key={t.id} className={`az-session__result az-session__result--${view.tone}`} role="status" data-testid="voice-dock-session-command-outcome" data-outcome={view.tone} data-command={t.command}>{view.text}</p>;})}
      </li>;})}</ul>}
    {current.length>ROW_LIMIT&&<p className="az-sessions__hint">컨텍스트 사용량이 높은 {ROW_LIMIT}개를 표시합니다.</p>}
    <p className="az-sessions__hint">최근 기록이며 실제 열린 창과 다를 수 있습니다.</p>
    <details className="az-sessions__hint"><summary>세션 목록 안내</summary><p>주간 잔여량은 최근 CLI 계정 기준이며 각 세션의 컨텍스트 사용량과 다릅니다. 기억 저장만으로 컨텍스트가 줄지는 않습니다. 목록 정리는 대화나 기억을 지우지 않습니다. 대화 정리(Compact·Clear)는 정확히 연결된 Claude Code 워크룸과, Orca에서 하나의 터미널로 확인된 Claude에서 지원합니다. 보낸 뒤에는 요약 기록·컨텍스트 변화·새 대화로 처리 결과를 이 목록에 표시하며, 확인되지 않아도 다시 보내지 않습니다. 다른 터미널과 Codex 앱에서는 원본 창에서 직접 실행하세요.</p></details>
  </section>;
}
