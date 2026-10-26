import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Loader2,RefreshCw,Save} from 'lucide-react';
import {isTauri} from '../lib/env';
import {projectMemoryApi} from '../ProjectMemoryPanel';
import {visibleContextSessions} from '../contextSessionVisibility';
import {resolveContextSessionProjectBinding} from '../contextSessionProject';
import {buildWorktreeContextCandidates,type WorktreeContextProject} from '../worktreeContextCandidates';
import type {ContextProjectNavigationCandidate} from '../contextProjectNavigation';
import type {ProjectMemoryRemoteState} from '../projectMemorySyncState';
import {phoneDateTime} from '../phoneTime';
import {PROJECT_ROOT_MISSING,sessionMemoryAction,type SessionMemoryAction,type SessionMemoryStatusState} from './aiUsageMemoryState';
import {contextSessionMemoryPath,contextSessionProjectPath,voiceProjectMemoryIsBlocked,type ContextSession} from '../contextSessionMemoryPath';
import {pauseBackgroundCheck,publishUnsaved,saveTargets,useUnsavedSessionMemory,type SaveItem,type UnsavedProject} from '../unsavedSessionMemory';

/**
 * 「열린 AI 세션」 — the dock's expandable list of open project + agent sessions (VOC 2026-10-24).
 *
 * Automatic checkpoints already save at the context thresholds; this is the manual path next to them:
 * each row shows the session's context %, when its project memory was last saved locally and backed up,
 * and 「지금 저장」·「동기화」, and the header saves every project with unsaved work at once. It reuses the
 * AI usage panel's data (`/api/context-usage`) and its memory rules (`sessionMemoryAction`), so a row never
 * offers a save the usage panel would refuse.
 * Mounted only while expanded. While folded, src/unsavedSessionMemory.ts checks for unsaved work on its own
 * slower clock; while open this list publishes what it read there instead. Saves run in that store, so
 * folding the list mid-run does not drop the rest.
 */
const apiBase=()=>isTauri()?'http://127.0.0.1:3001':'';
const CONTEXT_POLL_MS=5_000;
const MEMORY_RECHECK_MS=30_000;
const ROW_LIMIT=12;
type RowResult={ok:boolean;message:string};

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
  conflict:'로컬·Supabase가 모두 바뀌었습니다 · 프로젝트 화면에서 검토',
};

export function DockSessionsPanel(){
  const [sessions,setSessions]=useState<ContextSession[]|null>(null),[loadError,setLoadError]=useState('');
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

  const loadSessions=useCallback(async()=>{
    try{const res=await fetch(`${apiBase()}/api/context-usage`,{signal:AbortSignal.timeout(10_000)});const json=await res.json();if(!res.ok)throw Error(json.error||`요청 실패 (${res.status})`);setSessions(Array.isArray(json.sessions)?json.sessions:[]);setLoadError('');}
    catch(e){setLoadError(e instanceof Error?e.message:'세션 목록을 불러오지 못했습니다.');}
  },[]);
  useEffect(()=>{
    let stopped=false;
    const read=()=>{if(!stopped&&!document.hidden)void loadSessions();};
    read();const timer=setInterval(read,CONTEXT_POLL_MS);document.addEventListener('visibilitychange',read);
    // Project names: the registered list, read once per expand (the main window's richer worktree lists live elsewhere).
    void fetch(`${apiBase()}/api/ports`,{signal:AbortSignal.timeout(10_000)}).then(r=>r.ok?r.json():[]).then((ports:unknown)=>{if(!stopped&&Array.isArray(ports))setCandidates(buildWorktreeContextCandidates(ports.filter((p):p is WorktreeContextProject=>!!p&&typeof p.id==='string'&&typeof p.name==='string'),{}));}).catch(()=>{});
    void fetch(`${apiBase()}/api/project-memory/auto-checkpoint/status`,{signal:AbortSignal.timeout(10_000)}).then(r=>r.ok?r.json():null).then(v=>{if(!stopped&&v?.settings&&typeof v.settings.enabled==='boolean')setAutoSave({enabled:v.settings.enabled,thresholds:Array.isArray(v.settings.thresholds)?v.settings.thresholds.filter((n:unknown)=>typeof n==='number'):[]});}).catch(()=>{});
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',read);};
  },[loadSessions]);

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

  const rows=[...visibleContextSessions(sessions??[])].sort((a,b)=>(b.usedPercent??-1)-(a.usedPercent??-1)).slice(0,ROW_LIMIT);
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
    if(busy||saving)return;setBusy({sessionId:s.sessionId});
    setResults(previous=>{const next={...previous};delete next[s.sessionId];return next;});
    try{const message=await work();setResults(previous=>({...previous,[s.sessionId]:{ok:true,message}}));}
    catch(e){setResults(previous=>({...previous,[s.sessionId]:{ok:false,message:e instanceof Error?e.message:String(e)}}));}
    finally{setBusy(null);}
  };
  // The row is one concrete session: the store saves with its own agent and re-checks right before it.
  const saveNow=(s:ContextSession)=>{const {folder,name,registered,action}=describe(s);if(!folder)return;
    void saveTargets([{folder,name,agent:s.sourceAgent,allowStart:action==='start'&&registered}]);};
  const syncNow=(s:ContextSession)=>{const {folder,name}=describe(s);if(!folder)return;void run(s,async()=>{
    const result=await projectMemoryApi.sync({folderPath:folder,projectName:name});
    await refreshMemory(folder);
    if(result.conflict)throw Error('로컬·Supabase가 모두 바뀌어 덮어쓰지 않았습니다. 프로젝트 화면에서 검토하세요.');
    return result.action==='push'?'Supabase에 백업했습니다.':result.action==='pull'?'Supabase 기억을 로컬에 받았습니다.':'로컬과 Supabase가 이미 같습니다.';
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

  const autoLine=autoSave?autoSave.enabled?`자동 저장 켜짐 · 컨텍스트 ${autoSave.thresholds.join('·')}%`:'자동 저장 꺼짐 · 필요할 때 지금 저장':null;
  return <section className="az-sessions" aria-label="열린 AI 세션" data-testid="voice-dock-sessions-panel">
    <header className="az-sessions__head">
      <div><strong>열린 AI 세션{sessions?` ${rows.length}`:''}</strong>{autoLine&&<small data-testid="voice-dock-sessions-auto">{autoLine}</small>}</div>
      <div className="az-sessions__tools">
      <button type="button" className="az-sessions__save-all" data-testid="voice-dock-sessions-save-all" disabled={saving||!!busy||!unsaved.length}
        title={saving?'기억을 하나씩 차례로 저장하고 있습니다':unsaved.length?'저장할 새 활동이 있는 프로젝트를 하나씩 차례로 저장합니다':'저장할 새 활동이 있는 프로젝트가 없습니다'} onClick={saveAll}>
        {saving?<Loader2 size={12} className="az-session__spin"/>:<Save size={12}/>}{saving&&saveRun?`저장 중 ${runDone}/${saveRun.items.length}`:`모두 저장${unsaved.length?` (${unsaved.length})`:''}`}</button>
      <button type="button" className="az-sessions__icon" aria-label="세션 목록 새로고침" title="세션 목록 새로고침" onClick={()=>{void loadSessions();for(const f of folders)if(!inFlight.current.has(f))void refreshMemory(f);}}><RefreshCw size={13}/></button>
      </div>
    </header>
    {loadError&&<p className="az-sessions__error" role="alert">{loadError}</p>}
    {sessions===null?(!loadError&&<p className="az-sessions__hint" role="status">불러오는 중…</p>)
    :rows.length===0?<p className="az-sessions__hint" data-testid="voice-dock-sessions-empty">열린 AI 세션이 없습니다. Claude는 상태 표시줄(statusLine)이, Codex는 세션 기록이 있어야 보입니다.</p>
    :<ul className="az-sessions__list">{described.map(({s,folder,name,worktree,state,action,registered})=>{
      const pct=typeof s.usedPercent==='number'?Math.max(0,Math.min(100,s.usedPercent)):null;
      const level=pct===null?'none':pct>=90?'danger':pct>=70?'warn':'ok';
      const ready=state?.kind==='ready'?state:null;
      const localAt=ready?(ready.status.modifiedAt||ready.status.config?.lastUpdatedAt||null):null;
      const backupAt=ready?(ready.remote.kind==='ready'?ready.remote.status.createdAt:ready.status.config?.lastBackedUpAt||null):null;
      const item=folder?saveRun?.items.find(i=>i.folder===folder):undefined;
      const rowSaving=item?.status==='saving',rowSyncing=busy?.sessionId===s.sessionId,result=results[s.sessionId];
      const saveResult=item&&ITEM_DONE.includes(item.status)&&item.message?{ok:item.status==='saved'||item.status==='skipped',message:item.message}:null;
      // The save button answers only its own question (resolveProjectMemorySaveButtonAction); sync verbs stay on 동기화.
      const canSave=action==='start'?registered:needsRemember(state)&&action!=='conflict'&&action!=='checking';
      const canSync=!!folder&&ready?.status.exists===true&&!['conflict','checking','missing','ephemeral','unavailable'].includes(action);
      const agent=s.clientLabel||(s.sourceAgent==='claude'?'Claude':'Codex');
      return <li key={s.sessionId} className="az-session" data-testid="voice-dock-session" data-action={action}>
        <div className="az-session__title">
          <span className="az-session__name" title={contextSessionProjectPath(s)??undefined}><strong>{name}</strong>{worktree?<em> · {worktree}</em>:null}</span>
          <span className="az-session__agent" data-agent={s.sourceAgent}>{agent}</span>
          <span className="az-session__pct" data-level={level} data-testid="voice-dock-session-percent">{pct===null?'—':`${Math.round(pct)}%`}</span>
        </div>
        <div className="az-session__bar" aria-hidden="true"><i data-level={level} style={{width:`${pct??0}%`}}/></div>
        {s.threadTitle&&<p className="az-session__thread">{s.threadTitle}</p>}
        <p className="az-session__state" data-action={action}>{action==='start'&&!registered?'등록되지 않은 폴더 · 장기기억 없음':statusLine[action]}{(action==='push'||action==='pull')&&needsRemember(state)?' · 저장할 새 활동도 있습니다':''}{ready&&(localAt||backupAt)?` · 로컬 ${localAt?phoneDateTime(localAt):'—'} · 백업 ${backupAt?phoneDateTime(backupAt):'—'}`:''}</p>
        <div className="az-session__actions">
          {action==='retry'&&folder
            ?<button type="button" disabled={!!busy} onClick={()=>void refreshMemory(folder)} title={state?.kind==='error'?state.message:undefined}>다시 확인</button>
            :<button type="button" className={canSave?'az-session__primary':undefined} data-testid="voice-dock-session-save" disabled={!!busy||saving||!canSave} title={canSave?'이 세션의 대화·작업을 프로젝트 장기기억에 지금 저장합니다':statusLine[action]} onClick={()=>saveNow(s)}>{rowSaving?<Loader2 size={12} className="az-session__spin"/>:<Save size={12}/>}{rowSaving?'저장 중…':item?.status==='pending'?'저장 대기':'지금 저장'}</button>}
          <button type="button" className={action==='push'||action==='pull'?'az-session__primary':undefined} data-testid="voice-dock-session-sync" disabled={!!busy||saving||!canSync} title={canSync?'로컬·Supabase를 비교해 안전한 방향으로만 동기화합니다':statusLine[action]} onClick={()=>syncNow(s)}>{rowSyncing?<Loader2 size={12} className="az-session__spin"/>:<RefreshCw size={12}/>}{rowSyncing?'동기화 중…':'동기화'}</button>
        </div>
        {saveResult&&<p className={saveResult.ok?'az-session__result':'az-session__result az-session__result--error'} role="status" data-testid="voice-dock-session-save-result">{saveResult.message}</p>}
        {result&&<p className={result.ok?'az-session__result':'az-session__result az-session__result--error'} role="status">{result.message}</p>}
      </li>;})}</ul>}
    <p className="az-sessions__hint">저장은 프로젝트 장기기억을 갱신할 뿐, 열린 대화의 컨텍스트 %를 줄이지 않습니다.</p>
  </section>;
}
