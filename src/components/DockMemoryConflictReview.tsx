import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Loader2} from 'lucide-react';
import {isTauri} from '../lib/env';
import {projectMemoryApi,type ProjectMemoryConflictPreview} from '../ProjectMemoryPanel';
import {compareProjectMemoryEntries,projectMemoryChoiceLosses,MEMORY_ENTRY_CHANGE_LABEL,type ProjectMemoryEntryComparison} from '../projectMemoryConflictEntries';
import {phoneDateTime} from '../phoneTime';

/**
 * 「비교·해결」 for one dock row whose project memory differs on this Mac and in Supabase (VOC 2026-11-01: the card said
 * 「두 기억을 비교해 해결하세요」 and offered no way to do it).
 *
 * - Comparing is read-only (`/api/project-memory/conflict-preview`): no claim, Pull, schema repair or write.
 * - Nothing changes until the person picks one choice and confirms it. Every choice goes through the host's existing
 *   resolve-conflict path with the hashes and revision shown here, so a memory that changed meanwhile is refused (stale),
 *   and the host keeps the previous version (Supabase revision history / local backup).
 * - 「항목 합치기」 is offered only when each side only added entries the other lacks (src/projectMemoryConflictEntries.ts);
 *   otherwise it says why. The project screen keeps the full editor for anything that needs judgement.
 * - A choice whose answer was lost is never sent again: the review says so and offers only 「다시 비교」.
 */
type Strategy='keep-local'|'use-remote'|'merged';
type View={kind:'loading'}|{kind:'error';message:string}|{kind:'ready';preview:ProjectMemoryConflictPreview;comparison:ProjectMemoryEntryComparison};
const apiBase=()=>isTauri()?'http://127.0.0.1:3001':'';
const RESOLVE_TIMEOUT_MS=60_000;
const LIST_LIMIT=8;

/** One attempt only: the host may have applied it even when the answer is lost, so a resend is never automatic. */
async function resolveOnce(body:Record<string,unknown>):Promise<{state:'done'|'stale'|'failed'|'unknown';message?:string}>{
  let response:Response;
  try{response=await fetch(`${apiBase()}/api/project-memory/resolve-conflict`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(RESOLVE_TIMEOUT_MS)});}
  catch{return {state:'unknown'};}
  const data=await response.json().catch(()=>null) as Record<string,any>|null;
  if(!data)return {state:'unknown'};
  if(data.success===true)return {state:'done'};
  if(data.stale===true||data.conflict===true)return {state:'stale'};
  return {state:'failed',message:typeof data.error==='string'?data.error:undefined};
}

const DONE_MESSAGE:Record<Strategy,string>={
  'keep-local':'로컬 기억을 Supabase에 새 리비전으로 올렸습니다. 이전 Supabase 리비전은 이력에 남아 있습니다.',
  'use-remote':'Supabase 기억을 로컬에 받았습니다. 이전 로컬 기억은 .agent-memory/backups에 백업했습니다.',
  merged:'두 기억의 항목을 합쳐 로컬에 저장하고 Supabase에 올렸습니다. 이전 로컬 기억은 백업했습니다.',
};
const AFTER=' 세션 기억은 자동으로 다시 저장하지 않습니다. 필요하면 「지금 저장」을 누르세요.';

export function DockMemoryConflictReview({folder,name,locked,onLock,onDone,onClose}:{folder:string;name:string;
  /** Another save, sync or command of the dock is running. */
  locked:boolean;
  /** Take or release the dock's one-at-a-time lock; false when another action already holds it. */
  onLock:(on:boolean)=>boolean;
  onDone:(message:string)=>void;onClose:()=>void}){
  const [view,setView]=useState<View>({kind:'loading'});
  const [pending,setPending]=useState<Strategy|null>(null);
  const [running,setRunning]=useState(false);
  const [notice,setNotice]=useState<{tone:'error'|'info';text:string}|null>(null);
  // After a lost answer only a fresh comparison may follow — never the same choice again.
  const [unknown,setUnknown]=useState(false);
  const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
  // The list scrolls above the dock: keep the comparison and the confirm step in sight on a short window.
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{root.current?.scrollIntoView?.({block:'nearest'});},[view.kind,pending]);

  const compare=useCallback(async()=>{
    setView({kind:'loading'});setPending(null);
    try{
      const preview=await projectMemoryApi.conflictPreview({folderPath:folder});
      if(!alive.current)return;
      if(typeof preview?.localContent!=='string'||typeof preview.remoteContent!=='string'||typeof preview.localContentHash!=='string'||typeof preview.remoteRevisionId!=='string')throw Error('비교할 두 기억을 받지 못했습니다.');
      setView({kind:'ready',preview,comparison:compareProjectMemoryEntries({localContent:preview.localContent,remoteContent:preview.remoteContent,baseContent:preview.baseContent??null})});
      setUnknown(false);
    }catch(e){if(alive.current)setView({kind:'error',message:e instanceof Error?e.message:String(e)});}
  },[folder]);
  useEffect(()=>{void compare();},[compare]);

  const apply=async(strategy:Strategy)=>{
    if(view.kind!=='ready'||running||unknown)return;
    const {preview,comparison}=view;
    if(strategy==='merged'&&!comparison.merge.ok)return;
    if(!onLock(true))return;
    setRunning(true);setNotice(null);
    let outcome:Awaited<ReturnType<typeof resolveOnce>>;
    try{
      outcome=await resolveOnce({folderPath:folder,projectName:name,strategy,
        ...(strategy==='merged'&&comparison.merge.ok?{mergedContent:comparison.merge.content}:{}),
        expectedLocalHash:preview.localContentHash,expectedRemoteRevisionId:preview.remoteRevisionId,expectedRemoteContentHash:preview.remoteContentHash});
    }finally{onLock(false);if(alive.current){setRunning(false);setPending(null);}}
    if(!alive.current)return;
    if(outcome.state==='done'){onDone(DONE_MESSAGE[strategy]+AFTER);return;}
    if(outcome.state==='stale'){setNotice({tone:'info',text:'비교한 뒤 로컬이나 Supabase 기억이 또 바뀌어 아무것도 바꾸지 않았습니다. 새로 비교했습니다.'});void compare();return;}
    if(outcome.state==='unknown'){setUnknown(true);setNotice({tone:'error',text:'결과를 확인하지 못했습니다. 다시 보내지 않았습니다. 「다시 비교」로 지금 상태를 확인하세요.'});return;}
    setNotice({tone:'error',text:outcome.message||'선택을 적용하지 못했습니다. 기존 기억은 그대로입니다.'});
  };

  const losses=useMemo(()=>view.kind==='ready'?projectMemoryChoiceLosses(view.comparison):{keepLocal:0,useRemote:0},[view]);
  const disabled=locked||running;
  const close=<button type="button" data-testid="voice-dock-conflict-close" disabled={running} onClick={onClose}>닫기</button>;
  const recompare=<button type="button" data-testid="voice-dock-conflict-recompare" disabled={disabled} onClick={()=>{setNotice(null);void compare();}}>다시 비교</button>;
  const noticeLine=notice&&<p className={notice.tone==='error'?'az-session__result az-session__result--error':'az-conflict__note'} role="status" data-testid="voice-dock-conflict-notice">{notice.text}</p>;

  if(view.kind==='loading')return <div ref={root} className="az-conflict" data-testid="voice-dock-conflict-review" aria-busy="true"><p className="az-conflict__note" role="status"><Loader2 size={12} className="az-session__spin"/> 로컬·Supabase 기억을 비교하는 중… (아무것도 바꾸지 않습니다)</p>{noticeLine}</div>;
  if(view.kind==='error')return <div ref={root} className="az-conflict" data-testid="voice-dock-conflict-review">
    <p className="az-session__result az-session__result--error" role="alert">비교하지 못했습니다: {view.message} 기존 기억은 그대로입니다.</p>
    <div className="az-session__actions">{recompare}{close}</div></div>;

  const {preview,comparison}=view;
  if(!preview.conflict)return <div ref={root} className="az-conflict" data-testid="voice-dock-conflict-review">
    <p className="az-conflict__note" role="status" data-testid="voice-dock-conflict-same">이제 로컬과 Supabase 기억이 같습니다. 해결할 것이 없습니다.</p>{noticeLine}
    <div className="az-session__actions"><button type="button" className="az-session__primary" data-testid="voice-dock-conflict-done" onClick={()=>onDone('로컬과 Supabase 기억이 같습니다.')}>확인</button></div></div>;

  const groups=new Map<string,string[]>();
  for(const d of comparison.differences){const label=MEMORY_ENTRY_CHANGE_LABEL[d.change];groups.set(label,[...(groups.get(label)??[]),d.title||'(제목 없음)']);}
  const remoteAt=preview.remoteCreatedAt?phoneDateTime(preview.remoteCreatedAt):null;
  const confirmText:Record<Strategy,string>={
    'keep-local':`로컬 기억을 Supabase에 새 리비전으로 올립니다.${losses.keepLocal?` Supabase에만 있거나 Supabase에서 고친 항목 ${losses.keepLocal}개는 새 버전에서 빠집니다.`:''} 지금 Supabase 리비전은 이력에 남습니다.`,
    'use-remote':`로컬 기억을 백업한 뒤 Supabase 기억으로 바꿉니다.${losses.useRemote?` 로컬에만 있거나 로컬에서 고친 항목 ${losses.useRemote}개는 빠집니다.`:''} 이전 로컬 기억은 .agent-memory/backups에 남습니다.`,
    merged:comparison.merge.ok?`로컬 기억에 Supabase에서 추가된 항목 ${comparison.merge.addedFromRemote}개를 같은 섹션 끝에 넣어 저장하고(이전 로컬은 백업), 그 결과를 Supabase에 올립니다. 기존 항목은 바꾸지 않습니다.`:'',
  };
  return <div ref={root} className="az-conflict" data-testid="voice-dock-conflict-review">
    <p className="az-conflict__title"><strong>로컬 · Supabase 기억 비교</strong>{remoteAt||preview.remoteDeviceName?<small> · Supabase {[remoteAt,preview.remoteDeviceName].filter(Boolean).join(' · ')}</small>:null}</p>
    {preview.remoteChangedSinceSync===false
      ?<p className="az-conflict__note" data-testid="voice-dock-conflict-local-ahead">Supabase는 마지막 동기화 이후 바뀌지 않았습니다. 로컬에만 아직 올리지 않은 변경이 있어 「로컬 유지」로 그대로 올리면 됩니다.</p>
      :<p className="az-conflict__note">마지막 동기화 이후 로컬과 Supabase가 각각 바뀌었습니다. 아직 어느 쪽도 덮어쓰지 않았습니다.</p>}
    <p className="az-conflict__note" data-testid="voice-dock-conflict-summary">같은 항목 {comparison.same}개 · 다른 항목 {comparison.differences.length}개{comparison.contextChanged?' · 항목 밖 머리말·섹션 설명도 다름':''}</p>
    {groups.size>0&&<ul className="az-conflict__list" data-testid="voice-dock-conflict-differences">{[...groups].map(([label,titles])=><li key={label}><span>{label} {titles.length}개</span>
      <small>{titles.slice(0,LIST_LIMIT).join(' · ')}{titles.length>LIST_LIMIT?` 외 ${titles.length-LIST_LIMIT}개`:''}</small></li>)}</ul>}
    {!comparison.baseKnown&&<p className="az-conflict__note">마지막으로 맞춘 기준 리비전을 확인하지 못해 어느 쪽에서 바뀌었는지는 구분하지 못했습니다.</p>}
    {noticeLine}
    {unknown?<div className="az-session__actions">{recompare}{close}</div>
    :pending?<div className="az-conflict__confirm" data-testid="voice-dock-conflict-confirm-step">
      <p className="az-conflict__note">{confirmText[pending]}</p>
      <div className="az-session__actions">
        <button type="button" className="az-session__primary" data-testid="voice-dock-conflict-confirm" disabled={disabled} onClick={()=>void apply(pending)}>{running?<Loader2 size={12} className="az-session__spin"/>:null}{running?'적용 중…':'이대로 적용'}</button>
        <button type="button" data-testid="voice-dock-conflict-cancel" disabled={running} onClick={()=>setPending(null)}>취소</button>
      </div></div>
    :<>
      <div className="az-session__actions">
        <button type="button" data-testid="voice-dock-conflict-keep-local" disabled={disabled} className={preview.remoteChangedSinceSync===false?'az-session__primary':undefined} onClick={()=>setPending('keep-local')}>로컬 유지</button>
        <button type="button" data-testid="voice-dock-conflict-use-remote" disabled={disabled} onClick={()=>setPending('use-remote')}>Supabase 받기</button>
        <button type="button" data-testid="voice-dock-conflict-merge" disabled={disabled||!comparison.merge.ok} className={comparison.merge.ok&&preview.remoteChangedSinceSync!==false?'az-session__primary':undefined} title={comparison.merge.ok?'양쪽에서 새로 더한 항목을 모두 남깁니다':comparison.merge.reason} onClick={()=>setPending('merged')}>항목 합치기</button>
      </div>
      {!comparison.merge.ok&&<p className="az-conflict__note" data-testid="voice-dock-conflict-merge-reason">항목 합치기: {comparison.merge.reason} 직접 병합하려면 프로젝트 화면의 장기기억 「동기화 충돌 검토」를 쓰세요.</p>}
      <div className="az-session__actions">{recompare}{close}</div>
    </>}
  </div>;
}
