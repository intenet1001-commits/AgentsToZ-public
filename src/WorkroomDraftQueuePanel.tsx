import {confirmAction} from './confirmAction';
import React, {useCallback,useEffect,useMemo,useState} from 'react';
import {announceDraftVaultOptIn,createGatedDraftVault,draftVaultIfEnabled,readDraftVaultOptIn,subscribeDraftVaultOptIn,turnDraftVaultOff,workroomDraftVaultSupported,writeDraftVaultOptIn,WORKROOM_DRAFT_VAULT_LIMIT} from './workroomDraftVault';
import {keptDraftNote,restoreDraftQueueScope,takeBackKeptDraft,WORKROOM_DRAFT_STOPPED_LABEL,type EarlierWorkroomDraft,type KeptDraftCheck,type KeptDraftTakeBack,type QueuedDraftSendOutcome,type QueuedWorkroomDraft} from './workroomDraftQueue';
import {submissionStateLabel} from './workroomSubmissionClient';

/** Consent wording (S3-8). Separate from the project-memory and 「내가 한 말」 consents: this keeps raw request text. */
export const WORKROOM_DRAFT_VAULT_CONSENT=[
 '작성한 요청을 이 기기의 이 브라우저(앱) 안에만 암호화해 보관합니다. 기본은 꺼져 있고, 다른 기기·서버·장기기억으로는 보내지 않습니다.',
 `보관한 요청은 7일 뒤 지워지고, 최대 ${WORKROOM_DRAFT_VAULT_LIMIT}개·각 1MiB까지입니다. 언제든 하나씩 지우거나, 이 설정을 끄면 모두 지워집니다.`,
 '암호화 키는 이 브라우저 밖으로 꺼낼 수 없게 만들어 보관함(IndexedDB)에 둡니다. 화면을 닫거나 앱이 꺼진 뒤에도 남지만, 다시 열면 정지된 상태로 남고 직접 「보내기」를 눌러야 보냅니다.',
 '보내기 전에 같은 요청이 이미 전달됐는지 먼저 확인하고, 이미 기록이 있으면 다시 보내지 않습니다.',
 '같은 Wi‑Fi로 연 QR 페이지(http 주소)에서는 브라우저 암호화를 쓸 수 없어 이 기능이 없습니다.',
];

function flagStorage():Storage|null{try{return localStorage;}catch{return null;}}
const noFlags={getItem:()=>null};

export const WORKROOM_DRAFT_DUPLICATE_TAKE_BACK_CONFIRM='이 요청은 이미 한 번 보낸 적이 있고, 지금 연결로는 실행됐는지 확인할 수 없습니다. 터미널에서 실행되지 않은 것을 확인하셨나요? 꺼내서 보내면 새 요청으로 가며, 이미 실행됐다면 중복 실행됩니다.';
/** What one press of 「보내기」 leaves on the item. Written → nothing (the item goes). */
export function queuedSendNote(outcome:QueuedDraftSendOutcome):{text:string;takeBack:'never-ran'|'duplicate-risk'|null}|null{
 if(outcome.kind==='unproven')return {text:'이미 보낸 적이 있는 요청인데 지금 연결에서는 전송 기록을 찾을 수 없습니다(QR을 다시 스캔했거나 연결이 바뀌면 그렇습니다) · 다시 보내지 않았습니다 · 터미널을 확인하세요',takeBack:'duplicate-risk'};
 const receipt=outcome.receipt;if(receipt.state==='written')return null;
 const neverRan=receipt.state==='rejected'||receipt.state==='held';
 return {text:'제출 상태: '+submissionStateLabel(receipt.state)+(neverRan?' · 실행되지 않았습니다':' · 다시 보내지 않았습니다'),takeBack:neverRan?'never-ran':null};
}

/**
 * Per-device opt-in plus the vault it gates. Unsupported or off → no vault object at all, so nothing is opened.
 * Every panel of this origin follows a change made in any other (popout, session dialog, another tab), and the vault
 * itself re-reads the flag around each write, so a panel that has not heard yet still stores nothing.
 */
export function useWorkroomDraftVault(){
 const supported=useMemo(()=>{try{return workroomDraftVaultSupported();}catch{return false;}},[]);
 const [enabled,setEnabledState]=useState(()=>{const s=flagStorage();return supported&&!!s&&readDraftVaultOptIn(s);});
 // `enabled` only re-runs this; the gate itself re-reads the stored flag (the same one the tests pin down).
 const vault=useMemo(()=>{try{const flags=flagStorage()??noFlags;return draftVaultIfEnabled({flags,supported:supported&&enabled,create:()=>createGatedDraftVault({flags})});}catch{return null;}},[supported,enabled]);
 const [version,setVersion]=useState(0);
 const bump=useCallback(()=>setVersion(value=>value+1),[]);
 useEffect(()=>{
  if(!supported)return;
  return subscribeDraftVaultOptIn(()=>{const s=flagStorage();setEnabledState(!!s&&readDraftVaultOptIn(s));setVersion(value=>value+1);});
 },[supported]);
 const setEnabled=useCallback(async(on:boolean)=>{
  const s=flagStorage();if(!s)throw Error('이 브라우저에서는 설정을 저장할 수 없습니다.');
  try{if(on)writeDraftVaultOptIn(s,true);else await turnDraftVaultOff({flags:s,vault});}
  finally{setEnabledState(readDraftVaultOptIn(s));setVersion(value=>value+1);announceDraftVaultOptIn();}
 },[vault]);
 return {supported,enabled,vault,version,bump,setEnabled};
}
export type WorkroomDraftVaultState=ReturnType<typeof useWorkroomDraftVault>;

function preview(text:string){const line=text.replace(/\r$/,'').split('\n').find(part=>part.trim())??'';return line.length>80?line.slice(0,80)+'…':line||'(빈 줄)';}

/**
 * The opt-in setting and the stopped queue for one session. Restoring reads only; every send is one press on one item
 * and goes through the panel's `onSend`, which asks for that id's receipt before anything is written.
 *
 * Requests kept for any other session of this scope — one that ended, a Mac app restart that detached every CLI — are
 * listed too (audit 2026-10-16): with a status check of the original id under its own session (`onCheck`), a take-back
 * only when nothing ran (or after the duplicate warning), and delete. They are never sent from here. `sessionId` is null
 * when there is no running composer (the selected session ended): then every request of the scope is listed that way.
 */
export function WorkroomDraftQueue({state,scope,sessionId,blocked,canQueue,composerEmpty=true,onQueue,onSend,onTakeBack,onCheck}:{
 state:WorkroomDraftVaultState;scope:string;sessionId:string|null;blocked:boolean;canQueue:boolean;composerEmpty?:boolean;
 onQueue:()=>Promise<void>;onSend:(draft:QueuedWorkroomDraft)=>Promise<QueuedDraftSendOutcome|null>;onTakeBack:(draft:{text:string})=>boolean;
 onCheck?:(draft:EarlierWorkroomDraft)=>Promise<KeptDraftCheck>;
}){
 const {supported,enabled,vault,version,bump,setEnabled}=state;
 const [items,setItems]=useState<QueuedWorkroomDraft[]>([]);
 const [earlier,setEarlier]=useState<EarlierWorkroomDraft[]>([]);
 const [elsewhereIds,setElsewhereIds]=useState<string[]>([]);
 const elsewhere=elsewhereIds.length;
 const [notes,setNotes]=useState<Record<string,{text:string;takeBack:KeptDraftTakeBack|null}>>({});
 const [message,setMessage]=useState('');
 const [working,setWorking]=useState(false);
 useEffect(()=>{
  let alive=true;
  if(!vault){setItems([]);setEarlier([]);setElsewhereIds([]);return;}
  restoreDraftQueueScope(vault,scope,sessionId).then(queue=>{if(alive){setItems(queue.current);setEarlier(queue.earlier);setElsewhereIds(queue.elsewhereIds);}},()=>{if(alive)setMessage('보관한 요청을 읽지 못했습니다.');});
  return ()=>{alive=false;};
 },[vault,scope,sessionId,version]);
 if(!supported)return null;
 const toggle=async(on:boolean)=>{
  const kept=items.length+earlier.length+elsewhere;
  if(!on&&kept&&!(await confirmAction(`보관한 요청 ${kept}개를 이 기기에서 모두 지우고 보관을 끕니다. 계속할까요?`)))return;
  try{await setEnabled(on);setNotes({});setMessage(on?'이제 보관함에 넣은 요청과 보내는 요청을 이 기기에 암호화해 보관합니다.':'보관을 끄고 이 기기에 보관한 요청을 모두 지웠습니다.');}
  catch(error){setMessage(error instanceof Error?error.message:'설정을 바꾸지 못했습니다.');}
 };
 const run=async(task:()=>Promise<void>)=>{if(working)return;setWorking(true);try{await task();}finally{setWorking(false);bump();}};
 const send=(item:QueuedWorkroomDraft)=>run(async()=>{
  const outcome=await onSend(item);if(!outcome)return;
  const note=queuedSendNote(outcome);if(note)setNotes(old=>({...old,[item.submissionId]:note}));
 });
 const remove=(item:{submissionId:string})=>run(async()=>{
  if(!vault||!(await confirmAction('이 보관 요청을 지웁니다. 이미 보냈는지 확실하지 않다면 터미널을 먼저 확인하세요.')))return;
  await vault.delete(item.submissionId);setMessage('보관한 요청 하나를 지웠습니다.');
 });
 const takeBack=(item:{submissionId:string;sessionId:string;text:string},risk:KeptDraftTakeBack)=>run(async()=>{
  if(!vault)return;
  // Unproven: it was sent once and may have run. Only a person who checked the terminal takes it back as a new request.
  // Never sent: claimed first, so a 「보내기」 in another window and this take-back cannot both go.
  const outcome=await takeBackKeptDraft({vault,scope,draft:item,risk,composerEmpty,confirm:()=>confirmAction(WORKROOM_DRAFT_DUPLICATE_TAKE_BACK_CONFIRM),put:()=>onTakeBack(item)});
  if(outcome==='composer-busy')setMessage('입력칸을 비운 뒤 꺼내세요.');
  else if(outcome==='already-sent')setNotes(old=>({...old,[item.submissionId]:{text:'다른 창에서 이미 보냈거나 지웠을 수 있습니다 · 다시 보내지 않았습니다 · 「결과 확인」을 누르세요',takeBack:null}}));
  else if(outcome==='taken')setMessage(risk==='duplicate-risk'?'요청을 입력칸으로 꺼냈습니다. 보내면 새 요청으로 갑니다.':'실행되지 않은 요청을 입력칸으로 꺼냈습니다. 보내면 새 요청으로 갑니다.');
 });
 // Requests of other connections are never opened here; clearing them is the way out when that connection is gone.
 const clearElsewhere=()=>run(async()=>{
  const ids=elsewhereIds;
  if(!vault||!ids.length||!(await confirmAction(`다른 연결에 보관한 요청 ${ids.length}개를 이 기기에서 지웁니다. 여기서는 내용을 볼 수 없고, 그 연결에서 아직 보내지 않은 요청일 수 있습니다. 그 연결을 아직 쓴다면 그 워크룸에서 먼저 확인하세요. 계속할까요?`)))return;
  const deleted=await vault.deleteOutsideScope(scope,ids);
  setMessage(`다른 연결에 보관한 요청 ${deleted}개를 지웠습니다.`);
 });
 const check=(item:EarlierWorkroomDraft)=>run(async()=>{
  if(!onCheck)return;
  try{
   const note=keptDraftNote(await onCheck(item),item.attempted);
   if(note.remove){await vault?.delete(item.submissionId);setMessage(note.text);return;}
   setNotes(old=>({...old,[item.submissionId]:note}));
  }catch(error){setMessage(error instanceof Error&&error.message?error.message:'보관한 요청의 전송 기록을 확인하지 못했습니다. 보내지 않았습니다.');}
 });
 return <div className="ai-terminal-draft-queue" data-testid="workroom-draft-queue">
  <details data-testid="workroom-draft-vault-settings">
   <summary>작성 내용 보관 · {enabled?'켜짐':'꺼짐'}{enabled&&items.length?` · 정지된 요청 ${items.length}개`:''}{enabled&&earlier.length?` · 다른 세션 ${earlier.length}개`:''}</summary>
   {WORKROOM_DRAFT_VAULT_CONSENT.map(line=><p key={line} className="ai-terminal-hint">{line}</p>)}
   <label className="ai-terminal-hint"><input type="checkbox" data-testid="workroom-draft-vault-toggle" checked={enabled} disabled={working} onChange={event=>void toggle(event.target.checked)}/> 이 기기에서 작성 내용 보관하기</label>
  </details>
  {enabled&&<div role="group" aria-label="보관한 요청">
   {sessionId!==null&&<button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-add" disabled={working||!canQueue} onClick={()=>void run(async()=>{try{await onQueue();setMessage('요청을 보관함에 넣었습니다. 보낼 때 직접 「보내기」를 누르세요.');}catch(error){setMessage(error instanceof Error?error.message:'보관하지 못했습니다. 작성 내용은 그대로입니다.');}})}>보관함에 넣기</button>}
   {sessionId!==null&&items.map(item=>{const note=notes[item.submissionId];return <div key={item.submissionId} className="ai-terminal-hint" data-testid="workroom-draft-queue-item" data-state={item.state}>
    <span>{preview(item.text)}</span> <span>· {WORKROOM_DRAFT_STOPPED_LABEL}</span>{note&&<span data-testid="workroom-draft-queue-note"> · {note.text}</span>}
    <button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-send" disabled={working||blocked||!!note} onClick={()=>void send(item)}>보내기</button>
    {note?.takeBack&&<button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-take-back" data-risk={note.takeBack} disabled={working} onClick={()=>void takeBack({...item,sessionId},note.takeBack!)}>{note.takeBack==='duplicate-risk'?'터미널 확인 후 입력칸으로 꺼내기':'입력칸으로 꺼내기'}</button>}
    <button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-delete" disabled={working} onClick={()=>void remove(item)}>지우기</button>
   </div>;})}
   {!!earlier.length&&<div role="group" aria-label="다른 세션에 보관한 요청" data-testid="workroom-draft-queue-earlier">
    <p className="ai-terminal-hint">다른 세션(끝났거나 지금 고르지 않은 세션)에 보관한 요청 {earlier.length}개 · 그 세션으로 다시 보내지 않습니다. 결과를 확인하고, 실행되지 않은 요청만 입력칸으로 꺼내 새 요청으로 보낼 수 있습니다.{sessionId===null?' 입력칸으로 꺼내려면 실행 중인 세션을 여세요.':''}</p>
    {earlier.map(item=>{const note=notes[item.submissionId];const risk:KeptDraftTakeBack|null=note?note.takeBack:item.attempted?null:'never-sent';
     return <div key={item.submissionId} className="ai-terminal-hint" data-testid="workroom-draft-queue-earlier-item" data-state={item.state}>
      <span>{preview(item.text)}</span> <span>· 다른 세션에 보관됨</span>{note&&<span data-testid="workroom-draft-queue-note"> · {note.text}</span>}
      {item.attempted&&!note?.takeBack&&<button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-check" disabled={working||!onCheck} onClick={()=>void check(item)}>결과 확인</button>}
      {risk&&<button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-take-back" data-risk={risk} disabled={working||sessionId===null} onClick={()=>void takeBack(item,risk)}>{risk==='duplicate-risk'?'터미널 확인 후 입력칸으로 꺼내기':'입력칸으로 꺼내기'}</button>}
      <button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-delete" disabled={working} onClick={()=>void remove(item)}>지우기</button>
     </div>;})}
   </div>}
   {elsewhere>0&&<div className="ai-terminal-hint" data-testid="workroom-draft-queue-elsewhere"><span>다른 연결(다른 Mac·기기, 이전 연결)에 보관한 요청 {elsewhere}개도 이 기기의 보관 한도({WORKROOM_DRAFT_VAULT_LIMIT}개)에 들어갑니다. 그 연결을 아직 쓴다면 그 워크룸에서 확인하세요. 이 기기에서 사라진 연결의 요청은 여기서 지우거나 7일 뒤 저절로 지워집니다.</span>{' '}
    <button type="button" className="ai-terminal-btn" data-testid="workroom-draft-queue-elsewhere-delete" disabled={working} onClick={()=>void clearElsewhere()}>다른 연결의 보관 요청 {elsewhere}개 지우기</button></div>}
  </div>}
  {message&&<p className="ai-terminal-hint" role="status" data-testid="workroom-draft-queue-message">{message}</p>}
 </div>;
}
