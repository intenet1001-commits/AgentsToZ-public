import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import {normalizeSubmissionReceipt,WORKROOM_SUBMISSION_NOT_FOUND_PREFIX,type WorkroomSubmissionReceipt} from './workroomSubmissionProtocol';
import {submissionStateLabel,submitWorkroomDraft} from './workroomSubmissionClient';
import {WorkroomDraftVaultError,type WorkroomDraftClaim,type WorkroomDraftVault,type WorkroomScopedDraft,type WorkroomStoredDraft} from './workroomDraftVault';

/**
 * The stopped-after-restart queue (S3-8). Every queued draft already owns the submission id it will be sent with, so a
 * draft that was in flight when the page died is the same request the host may have written. Restoring reads only —
 * it is not even handed a transport — and nothing leaves the page until the user presses send on that one item.
 */
export const WORKROOM_DRAFT_STOPPED_LABEL='정지됨 · 직접 「보내기」를 누르기 전에는 보내지 않습니다';
export interface QueuedWorkroomDraft extends WorkroomStoredDraft {state:'stopped'}
export async function restoreDraftQueue(vault:WorkroomDraftVault,scope:string,sessionId:string):Promise<QueuedWorkroomDraft[]>{
 return (await vault.list(scope,sessionId)).drafts.map(draft=>({...draft,state:'stopped' as const}));
}
/**
 * The whole scope at once (audit 2026-10-16): `current` is the running session's stopped queue, `earlier` holds the
 * requests kept for any other session of this scope — one that ended, or one not selected — and `elsewhere` counts the
 * requests of other scopes that share the device-wide limit. Like restoreDraftQueue it reads only. With no running
 * composer (`sessionId` null) every request of the scope is an earlier one.
 */
export interface EarlierWorkroomDraft extends WorkroomScopedDraft {state:'stopped'}
export async function restoreDraftQueueScope(vault:WorkroomDraftVault,scope:string,sessionId:string|null):Promise<{current:QueuedWorkroomDraft[];earlier:EarlierWorkroomDraft[];elsewhere:number;elsewhereIds:string[]}>{
 const {drafts,elsewhere,elsewhereIds}=await vault.listScope(scope);
 const current:QueuedWorkroomDraft[]=[],earlier:EarlierWorkroomDraft[]=[];
 for(const {sessionId:kept,...draft} of drafts){
  if(sessionId!==null&&kept===sessionId)current.push({...draft,state:'stopped'});
  else earlier.push({...draft,sessionId:kept,state:'stopped'});
 }
 return {current,earlier,elsewhere,elsewhereIds};
}
/** Only the host's own «no such submission» answer proves the id was never stored; any other failure proves nothing. */
export function submissionNotFound(error:unknown):boolean{
 const message=(error as {message?:unknown}|null)?.message;
 return typeof message==='string'&&message.startsWith(WORKROOM_SUBMISSION_NOT_FOUND_PREFIX);
}
/**
 * One explicit press of 「보내기」 on one queued draft. The status check comes first: an existing receipt (in any state)
 * is returned as it is and nothing is written — a written request is never typed a second time, and an unsettled one
 * stays the user's to inspect. A failed status check sends nothing.
 *
 * ⚠️ «Not found» is not proof on its own. The host keys receipts by receipt owner + session + id, and the owner can
 * change after a send while the vault scope stays the same (a new QR = a new relay session, a durable consent granted,
 * a re-published community endpoint). So a not-found sends only a draft that was never handed to any transport, and
 * only after `claim` atomically marks it as handed over (`fresh`). A draft already attempted — by the send path, an
 * earlier press, or another window — comes back `unproven`: nothing is sent and the user checks the terminal.
 */
export type QueuedDraftSendOutcome={kind:'existing'|'sent';receipt:WorkroomSubmissionReceipt}|{kind:'unproven';receipt?:undefined};
/** The receipt of one kept request under the session it names; null only on the host's own «no such submission». */
async function readKeptReceipt(id:string,sessionId:string,request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>):Promise<WorkroomSubmissionReceipt|null>{
 try{
  const result=await request({operation:'submission',sessionId,submission:{phase:'status',id}});
  if(!result.submission)throw Error('보관한 요청의 전송 기록을 확인하지 못했습니다. 보내지 않았습니다.');
  const found=normalizeSubmissionReceipt(result.submission);
  if(found.id!==id||found.sessionId!==undefined)throw Error('다른 요청의 제출 영수증입니다. 보내지 않았습니다.');
  return found;
 }catch(error){if(!submissionNotFound(error))throw error;return null;}
}
export async function sendQueuedDraft(input:{draft:Pick<WorkroomStoredDraft,'submissionId'|'text'|'references'>&{attempted?:boolean};sessionId:string;
 request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>;claim:()=>Promise<WorkroomDraftClaim>;
 prepared:(receipt:WorkroomSubmissionReceipt)=>void}):Promise<QueuedDraftSendOutcome>{
 const id=input.draft.submissionId;
 const found=await readKeptReceipt(id,input.sessionId,input.request);
 if(found)return {kind:'existing',receipt:found};
 // Fail closed: an item that does not say «never attempted» is treated as attempted, and the store has the last word.
 if(input.draft.attempted!==false||await input.claim()!=='fresh')return {kind:'unproven'};
 const receipt=await submitWorkroomDraft({id,sessionId:input.sessionId,text:input.draft.text,references:input.draft.references,request:input.request,prepared:input.prepared});
 return {kind:'sent',receipt};
}

/**
 * A kept request of another session (audit 2026-10-16): only a status read of its original id under the session it was
 * kept for. Never a send — an old id is never sent to a different session, and the session it names may have ended.
 */
export type KeptDraftCheck={kind:'existing';receipt:WorkroomSubmissionReceipt}|{kind:'not-found';receipt?:undefined};
export async function checkKeptDraft(input:{draft:{submissionId:string;sessionId:string};
 request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>}):Promise<KeptDraftCheck>{
 const found=await readKeptReceipt(input.draft.submissionId,input.draft.sessionId,input.request);
 return found?{kind:'existing',receipt:found}:{kind:'not-found'};
}
/**
 * What a checked kept request offers. `remove`: it was delivered, so the copy goes. A take-back is offered only when
 * nothing ran (`never-ran`: refused/held; `never-sent`: never handed to any transport — taking it back claims it first)
 * or, as for the current session, after the duplicate warning (`duplicate-risk`: sent once, no receipt reachable now).
 */
export type KeptDraftTakeBack='never-ran'|'never-sent'|'duplicate-risk';
export function keptDraftNote(check:KeptDraftCheck,attempted:boolean):{text:string;takeBack:KeptDraftTakeBack|null;remove?:true}{
 if(check.kind==='not-found')return attempted
  ?{text:'이미 보낸 적이 있는 요청인데 그 세션의 전송 기록을 찾을 수 없습니다(QR을 다시 스캔했거나 연결이 바뀌면 그렇습니다) · 다시 보내지 않았습니다 · 터미널을 확인하세요',takeBack:'duplicate-risk'}
  :{text:'보낸 적이 없는 요청입니다 · 입력칸으로 꺼내면 지금 세션에 새 요청으로 보낼 수 있습니다',takeBack:'never-sent'};
 const state=check.receipt.state;
 if(state==='written')return {text:'이 요청은 이미 터미널에 전달됐습니다 · 보관함에서 지웠습니다',takeBack:null,remove:true};
 if(state==='rejected'||state==='held')return {text:'제출 상태: '+submissionStateLabel(state)+' · 실행되지 않았습니다',takeBack:'never-ran'};
 return {text:'제출 상태: '+submissionStateLabel(state)+' · 다시 보내지 않았습니다 · 터미널을 확인하세요',takeBack:null};
}
/**
 * One press of 「입력칸으로 꺼내기」. The composer must be empty; an unproven request asks the duplicate warning first; a
 * never-sent one is claimed (the same atomic mark a send takes) so a press of 「보내기」 in another window and this
 * take-back cannot both go — whoever loses sends nothing. Taken back, the kept copy goes: sending it makes a new request.
 */
export type TakeBackOutcome='taken'|'composer-busy'|'declined'|'already-sent';
export async function takeBackKeptDraft(input:{vault:Pick<WorkroomDraftVault,'claimForSend'|'delete'>;scope:string;
 draft:{submissionId:string;sessionId:string;text:string};risk:KeptDraftTakeBack;composerEmpty:boolean;
 confirm:()=>boolean|Promise<boolean>;put:()=>boolean}):Promise<TakeBackOutcome>{
 if(!input.composerEmpty)return 'composer-busy';
 if(input.risk==='duplicate-risk'&&(await input.confirm())!==true)return 'declined';
 if(input.risk==='never-sent'&&await input.vault.claimForSend(input.scope,input.draft.sessionId,input.draft.submissionId)!=='fresh')return 'already-sent';
 if(!input.put())return 'composer-busy';
 await input.vault.delete(input.draft.submissionId);
 return 'taken';
}

/**
 * How long 「현재 세션에 전송」 waits for its seal before the request leaves anyway (review S3-8, 2026-10-16). A sealing
 * IndexedDB write takes milliseconds; this only bounds a stuck one.
 */
export const WORKROOM_DRAFT_SEAL_WAIT_MS=1500;
export type WorkroomDraftSealOutcome={state:'off'}|{state:'kept'}|{state:'failed';reason:string}|{state:'timeout'};
/**
 * 「현재 세션에 전송」 with the vault on: the request is sealed as attempted under its pre-assigned submission id first.
 * When the seal is stored within `waitMs`, the submission leaves only after it — so a tab that dies right after the send
 * still has the text (stopped, never re-sent on its own: an attempted draft is never sent on a bare «not found»).
 *
 * Decided 2026-10-16: the vault is a safety net and must never block the user's send. If the seal fails or is not stored
 * within `waitMs`, the request still goes — once, under the same id — before the seal, so a tab that dies then may keep
 * nothing; `onSealed` gets the outcome so the screen says the request was not (or may not be) kept. A seal that lands
 * after the wait is still attempted, and `stored` settles true only once the record really is in the vault, so a written
 * receipt can still remove it. `onSealed` runs right before the submit.
 */
export function sendWithDraftSeal(input:{vault:Pick<WorkroomDraftVault,'save'>|null;scope:string;sessionId:string;id:string;text:string;references:string[];
 /** Phone attachment ids (w13): the caller passes no vault with them — a kept copy could not carry ids that expire in an hour. */
 attachments?:string[];
 request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>;prepared:(receipt:WorkroomSubmissionReceipt)=>void;
 waitMs?:number;onSealed?:(sealed:WorkroomDraftSealOutcome)=>void}):{stored:Promise<boolean>;receipt:Promise<WorkroomSubmissionReceipt>}{
 const vault=input.vault;let reason='';
 const stored=vault
  ?vault.save({scope:input.scope,sessionId:input.sessionId,submissionId:input.id,text:input.text,references:input.references,attempted:true})
   .then(()=>true,(error:unknown)=>{reason=error instanceof WorkroomDraftVaultError?error.message:'';return false;})
  :Promise.resolve(false);
 const sealed:Promise<WorkroomDraftSealOutcome>=!vault?Promise.resolve({state:'off'}):new Promise(resolve=>{
  const timer=setTimeout(()=>resolve({state:'timeout'}),Math.max(0,input.waitMs??WORKROOM_DRAFT_SEAL_WAIT_MS));
  void stored.then(saved=>{clearTimeout(timer);resolve(saved?{state:'kept'}:{state:'failed',reason});});
 });
 const receipt=sealed.then(outcome=>{
  try{input.onSealed?.(outcome);}catch{/* a screen callback never stops the send */}
  return submitWorkroomDraft({id:input.id,sessionId:input.sessionId,text:input.text,references:input.references,...(input.attachments?.length?{attachments:input.attachments}:{}),request:input.request,prepared:input.prepared});
 });
 return {stored,receipt};
}
/**
 * What the composer says about the seal of a direct send. Empty when there is nothing to say (off, or kept).
 * It speaks about keeping only, never about sending (review S3-8, 2026-10-16): it is shown from onSealed, before the
 * submit, and the composer appends it to a submission failure that may say nothing was sent — a phone that went offline
 * during the wait. 「…보관하지 않고 보냈습니다」 put «not sent» and «sent» on two lines of one message.
 */
export function draftSealNotice(sealed:WorkroomDraftSealOutcome):string{
 if(sealed.state==='failed')return '이 요청은 작성 내용 보관함에 넣지 못했습니다'+(sealed.reason?' — '+sealed.reason:'.');
 if(sealed.state==='timeout')return '작성 내용 보관함 저장이 끝나지 않았습니다 — 이 요청은 보관되지 않았을 수 있습니다.';
 return '';
}
/**
 * A direct send with the vault on that goes as raw input — a Mac without whole-request submissions, session storage that
 * cannot keep the submission record, images from a phone (integration review w4, 4a). There is no submission id to seal it
 * under, so it is not kept; the composer says so instead of keeping silent. About keeping only, like `draftSealNotice`.
 */
export const DRAFT_RAW_SEND_NOTICE='이 요청은 작성 내용 보관함에 넣지 않았습니다 — 제출 기록 없이 일반 입력으로 가는 전송은 보관할 수 없습니다.';

/**
 * The vault scope of a panel. One queue per receipt owner (integration review 2026-10-15, A2): the main window's composer
 * lives in the session directory (`directory:local`) and the popout in `popout`, and both write as this Mac; another Mac
 * reached from either surface (`directory:<deviceId>` / `community:<deviceId>`) is one owner too. Other scopes (a phone
 * portal's host) are their own.
 */
export function draftVaultScopeFor(sessionScope:string):string{
 if(sessionScope==='popout'||sessionScope==='local'||sessionScope==='directory:local')return 'local';
 if(sessionScope.startsWith('directory:'))return 'community:'+sessionScope.slice('directory:'.length);
 return sessionScope;
}
