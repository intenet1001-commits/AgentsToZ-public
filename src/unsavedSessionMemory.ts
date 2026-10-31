import {useEffect,useSyncExternalStore} from 'react';
import {isTauri} from './lib/env';
import {visibleContextSessions} from './contextSessionVisibility';
import {readContextDismissals,useContextDismissals,withoutDismissedContextSessions} from './contextSessionCleanup';
import {resolveContextSessionProjectBinding} from './contextSessionProject';
import {buildWorktreeContextCandidates,type WorktreeContextProject} from './worktreeContextCandidates';
import type {ContextProjectNavigationCandidate} from './contextProjectNavigation';
import {isCodexThreadWorkspace} from './agentWorkspacePath';
import {contextSessionMemoryPath,contextSessionProjectPath,type ContextSession} from './contextSessionMemoryPath';
import {memorySaveProblem,MEMORY_SAVE_PROBLEM_TEXT,type MemorySaveProblem} from './memorySaveProblem';

/**
 * Open sessions whose project memory has unsaved work, and 「모두 저장」 for them (VOC 2026-10-24).
 *
 * Automatic checkpoints only save at the context thresholds, so work below them waited for someone to open
 * 「열린 AI 세션」 and look. This store finds those projects for the dock (a notice card and a count on the
 * session button) and saves them one at a time.
 *
 * - It stays out of the lazy project-memory client (plain fetch), so the always-loaded dock can hold it.
 * - The runner lives here, not in the panel: folding the list mid-run must not drop the remaining saves.
 * - Saves go one after another because the host runs one memory save at a time (src/memorySaveDispatcher.ts):
 *   a second request would wait in its queue and then fail as busy.
 * - A save whose outcome is unknown (timeout, dropped connection) stops the run instead of being resent.
 */
const apiBase=()=>isTauri()?'http://127.0.0.1:3001':'';
const CHECK_MS=60_000;
const MIN_CHECK_GAP_MS=20_000;
const PORTS_TTL_MS=10*60_000;
const FOLDER_LIMIT=12;
const READ_TIMEOUT_MS=10_000;
/** The host's memory agent may run five minutes, plus the pull/push around it and up to 30s in its queue. */
const SAVE_TIMEOUT_MS=8*60_000;

export type MemoryAgent='claude'|'codex';
export interface UnsavedProject {folder:string;name:string;agent:MemoryAgent;lastRememberedAt:string|null}
export interface SaveTarget {folder:string;name:string;agent:MemoryAgent;
  /** Start a first memory when none exists — only for a registered project, and only from its own row. */
  allowStart?:boolean}
export type SaveItemStatus='pending'|'saving'|'saved'|'skipped'|'failed'|'unknown'|'stopped';
export interface SaveItem extends SaveTarget {status:SaveItemStatus;message?:string;problem?:MemorySaveProblem}
export interface SaveRun {id:string;items:SaveItem[];running:boolean;finishedAt:number|null}
export interface UnsavedSnapshot {unsaved:UnsavedProject[];checkedAt:number|null;run:SaveRun|null}

let snapshot:UnsavedSnapshot={unsaved:[],checkedAt:null,run:null};
const listeners=new Set<()=>void>();
const emit=(next:Partial<UnsavedSnapshot>)=>{snapshot={...snapshot,...next};for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const getSnapshot=()=>snapshot;

const pathLeaf=(folderPath:string|null|undefined)=>folderPath?.replace(/[/\\]+$/,'').split(/[/\\]/).filter(Boolean).pop()||'';

async function postJson(path:string,body:Record<string,unknown>,timeoutMs:number){
  // The local API can fail to read a body under a burst; nothing ran, so one more attempt is honest.
  for(let attempt=0;;attempt+=1){
    const response=await fetch(`${apiBase()}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    const data=await response.json().catch(()=>({})) as Record<string,any>;
    if(data.code==='REQUEST_BODY_UNREADABLE'&&attempt===0)continue;
    return {ok:response.ok,status:response.status,data};
  }
}

interface FolderMemory {exists:boolean;needsRemember:boolean;lastRememberedAt:string|null;autoBackup:boolean}
async function readFolderMemory(folder:string):Promise<FolderMemory>{
  const {ok,data}=await postJson('/api/project-memory/detect',{folderPath:folder},READ_TIMEOUT_MS);
  if(!ok)throw Object.assign(new Error(typeof data.error==='string'?data.error:'기억 상태를 확인하지 못했습니다.'),{code:data.code});
  return {exists:data.exists===true,needsRemember:data.exists===true&&data.activity?.needsRemember===true,
    lastRememberedAt:typeof data.activity?.lastRememberedAt==='string'?data.activity.lastRememberedAt:null,autoBackup:data.config?.autoBackup!==false};
}

let ports:{at:number;candidates:ContextProjectNavigationCandidate[]}|null=null;
async function projectCandidates(){
  if(ports&&Date.now()-ports.at<PORTS_TTL_MS)return ports.candidates;
  try{
    const response=await fetch(`${apiBase()}/api/ports`,{signal:AbortSignal.timeout(READ_TIMEOUT_MS)});
    const rows:unknown=response.ok?await response.json():[];
    const candidates=Array.isArray(rows)?buildWorktreeContextCandidates(rows.filter((p):p is WorktreeContextProject=>!!p&&typeof p.id==='string'&&typeof p.name==='string'),{}):[];
    ports={at:Date.now(),candidates};return candidates;
  }catch{return ports?.candidates??[];}
}

/** The memory folder each open session may save to, newest session first, one row per folder. */
export function unsavedCandidates(sessions:readonly ContextSession[],candidates:readonly ContextProjectNavigationCandidate[]){
  const byFolder=new Map<string,{folder:string;name:string;agent:MemoryAgent;ageMs:number}>();
  for(const s of withoutDismissedContextSessions(visibleContextSessions(sessions),readContextDismissals())){
    const folder=contextSessionMemoryPath(s);
    if(!folder||isCodexThreadWorkspace(folder))continue;
    const binding=resolveContextSessionProjectBinding(candidates,contextSessionProjectPath(s));
    const name=s.projectHint?.name??binding.projectName??(pathLeaf(folder)||'등록되지 않은 프로젝트');
    const known=byFolder.get(folder);
    if(!known||s.ageMs<known.ageMs)byFolder.set(folder,{folder,name,agent:s.sourceAgent,ageMs:s.ageMs});
  }
  return [...byFolder.values()].sort((a,b)=>a.ageMs-b.ageMs).slice(0,FOLDER_LIMIT);
}

let checking=false,lastCheckAt=0,paused=0;
/** One pass: open sessions → their folders → which have unsaved work. Folders are probed one at a time. */
export async function checkUnsavedNow(force=false){
  if(checking||paused>0||snapshot.run?.running)return;
  if(!force&&Date.now()-lastCheckAt<MIN_CHECK_GAP_MS)return;
  checking=true;lastCheckAt=Date.now();
  try{
    const response=await fetch(`${apiBase()}/api/context-usage`,{signal:AbortSignal.timeout(READ_TIMEOUT_MS)});
    if(!response.ok)return;
    const json=await response.json() as {sessions?:unknown};
    const sessions=Array.isArray(json.sessions)?json.sessions as ContextSession[]:[];
    const folders=unsavedCandidates(sessions,await projectCandidates());
    const unsaved:UnsavedProject[]=[];
    for(const f of folders){
      if(paused>0)return;
      try{const memory=await readFolderMemory(f.folder);if(memory.needsRemember)unsaved.push({folder:f.folder,name:f.name,agent:f.agent,lastRememberedAt:memory.lastRememberedAt});}
      catch{/* A folder that cannot be read is not reported as unsaved; the session list shows why. */}
    }
    if(paused===0&&!snapshot.run?.running)emit({unsaved,checkedAt:Date.now()});
  }catch{/* Keep the last answer: a missed poll is not evidence that the work was saved. */}
  finally{checking=false;}
}

let pollers=0,timer:ReturnType<typeof setInterval>|null=null;
const onVisible=()=>{if(!document.hidden)void checkUnsavedNow();};
function startBackgroundCheck(){
  pollers+=1;
  if(pollers===1){
    void checkUnsavedNow(true);
    timer=setInterval(()=>{if(!document.hidden)void checkUnsavedNow();},CHECK_MS);
    document.addEventListener('visibilitychange',onVisible);
  }
  return()=>{pollers-=1;if(pollers===0){if(timer)clearInterval(timer);timer=null;document.removeEventListener('visibilitychange',onVisible);}};
}

/**
 * The open session list reads the same facts more often; while it is open it publishes them here instead of
 * this store probing the same folders a second time.
 */
export function pauseBackgroundCheck(){
  paused+=1;
  return()=>{paused-=1;if(paused===0)void checkUnsavedNow(true);};
}
export function publishUnsaved(unsaved:UnsavedProject[]){
  if(snapshot.run?.running)return;
  const same=unsaved.length===snapshot.unsaved.length&&unsaved.every((u,i)=>{const v=snapshot.unsaved[i];return !!v&&v.folder===u.folder&&v.name===u.name&&v.agent===u.agent&&v.lastRememberedAt===u.lastRememberedAt;});
  if(!same)emit({unsaved,checkedAt:Date.now()});
}

/** Dismissing the card holds until the set of unsaved projects or one of their last saves changes. */
export function unsavedNoticeId(unsaved:readonly UnsavedProject[]){
  const key=unsaved.map(u=>`${u.folder}@${u.lastRememberedAt??''}`).sort().join('|');
  let hash=5381;for(let i=0;i<key.length;i+=1)hash=(hash*33+key.charCodeAt(i))>>>0;
  return `unsaved:${unsaved.length}:${hash.toString(36)}`;
}

const savedMessage=(data:Record<string,any>)=>data.remoteBackedUp?'저장 완료 · 로컬 기억과 Supabase 백업을 갱신했습니다.'
  :data.backupSkipped?'저장 완료 · 자동 백업이 꺼져 있어 로컬에만 저장했습니다.'
  :data.backupPending?'저장 완료 · Supabase 백업은 이어서 올립니다.'
  :data.backupError?MEMORY_SAVE_PROBLEM_TEXT.backup
  :'저장 완료 · 로컬 기억을 갱신했습니다.';

/** `current`: the project's memory is up to date afterwards, so it leaves the unsaved list. */
async function saveOne(item:SaveItem):Promise<Pick<SaveItem,'status'|'message'|'problem'>&{current?:boolean}>{
  let memory:FolderMemory;
  try{memory=await readFolderMemory(item.folder);}
  catch{return {status:'failed',problem:'state',message:MEMORY_SAVE_PROBLEM_TEXT.state};}
  // Re-checked right before saving: an automatic checkpoint or another window may have saved it already.
  if(!memory.exists&&!item.allowStart)return {status:'skipped',message:'장기기억이 없어 건너뛰었습니다 · 프로젝트 화면에서 시작하세요.'};
  if(memory.exists&&!memory.needsRemember)return {status:'skipped',current:true,message:'새로 저장할 활동이 없습니다 · 이미 최신 장기기억입니다.'};
  let result:Awaited<ReturnType<typeof postJson>>;
  try{
    // The row is one concrete session: save with its own agent, without changing the project's preferred agent.
    result=await postJson('/api/project-memory/session-end',{folderPath:item.folder,projectName:item.name,agent:item.agent,autoBackup:memory.autoBackup,preservePreferredAgent:true},SAVE_TIMEOUT_MS);
  }catch{
    return {status:'unknown',problem:'unknown',message:MEMORY_SAVE_PROBLEM_TEXT.unknown};
  }
  const {ok,data}=result;
  if(!ok){
    if(data.code==='MEMORY_SAVE_BUSY')return {status:'skipped',message:'다른 기억 저장이 진행 중이라 시작하지 않았습니다 · 잠시 후 다시 저장하세요.'};
    const problem=memorySaveProblem(data);
    return {status:'failed',problem,message:MEMORY_SAVE_PROBLEM_TEXT[problem]};
  }
  // Older hosts answered success without localSaved; only an explicit false (or success:false) is a failed local save.
  if(data.localSaved===false||data.localSaved!==true&&data.success===false){const problem=memorySaveProblem(data);return {status:'failed',problem,message:MEMORY_SAVE_PROBLEM_TEXT[problem]};}
  return {status:'saved',current:true,message:savedMessage(data),...(data.backupError?{problem:'backup' as const}:{})};
}

/** Saves the targets one after another. Returns false while another run in this window is still going. */
export async function saveTargets(targets:readonly SaveTarget[]){
  if(snapshot.run?.running||!targets.length)return false;
  const seen=new Set<string>();
  const run:SaveRun={id:`${Date.now()}`,running:true,finishedAt:null,
    items:targets.filter(t=>!seen.has(t.folder)&&!!seen.add(t.folder)).map(t=>({...t,status:'pending' as const}))};
  const update=(index:number,patch:Partial<SaveItem>)=>{run.items=run.items.map((item,i)=>i===index?{...item,...patch}:item);emit({run:{...run}});};
  emit({run:{...run}});
  for(let i=0;i<run.items.length;i+=1){
    update(i,{status:'saving'});
    const {current,...outcome}=await saveOne(run.items[i]!);
    update(i,outcome);
    if(current)emit({unsaved:snapshot.unsaved.filter(u=>u.folder!==run.items[i]!.folder)});
    if(outcome.status==='unknown'){
      // The host may still be running it; the next save would only queue behind it. Stop here.
      run.items=run.items.map((item,j)=>j>i?{...item,status:'stopped',message:'앞 저장의 결과를 확인하지 못해 시작하지 않았습니다.'}:item);
      break;
    }
  }
  run.running=false;run.finishedAt=Date.now();emit({run:{...run}});
  void checkUnsavedNow(true);
  return true;
}
export const clearSaveRun=()=>{if(!snapshot.run?.running)emit({run:null});};

/** `check`: this mount keeps the background check running (the notice stack); readers pass false. */
export function useUnsavedSessionMemory({check}:{check:boolean}){
  const value=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const dismissalKey=JSON.stringify(useContextDismissals());
  useEffect(()=>check?startBackgroundCheck():undefined,[check]);
  useEffect(()=>{if(check)void checkUnsavedNow(true);},[check,dismissalKey]);
  return value;
}

/** Test seams: the store is a module singleton per webview. */
export const peekUnsavedSessionMemoryForTest=()=>snapshot;
export function resetUnsavedSessionMemoryForTest(){snapshot={unsaved:[],checkedAt:null,run:null};checking=false;lastCheckAt=0;paused=0;ports=null;}
