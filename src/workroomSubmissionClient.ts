import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import {normalizeSubmissionReceipt,submissionDigest,validateSubmissionText,type WorkroomSubmissionLaunch,type WorkroomSubmissionReceipt} from './workroomSubmissionProtocol';
import {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR} from './agentDialogueControl';
import {AI_TERMINAL_REQUEST_INVALID_CODE,AI_TERMINAL_UNKNOWN_REQUEST_ERROR} from './aiTerminalProtocol';
export const WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE='이 기기는 전체 요청 제출을 아직 받지 않습니다. 다시 보내면 기존 입력 방식으로 보냅니다.';
/**
 * The receiver advertised terminal-submission-v1 but refused the first `submission` request with the community
 * executor's terminal-only sentence (receivers up to v791). That refusal happens before the terminal service runs,
 * so nothing was prepared or written: the caller may drop its pending record and fall back to raw input — on the
 * user's next click, never automatically.
 */
export class WorkroomSubmissionUnsupportedError extends Error {constructor(){super(WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE);this.name='WorkroomSubmissionUnsupportedError';}}
/**
 * The same refusal for a launch (a new session's first request) by an `@` route: nothing ran, but only launches go back
 * to a plain `start` — an older forwarding Mac may still take submissions into a running session.
 */
export class WorkroomLaunchUnsupportedError extends Error {constructor(){super(WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE);this.name='WorkroomLaunchUnsupportedError';}}
/** After a status check: a written receipt settles the request (nothing to decide about re-sending), anything else stays pending. */
export function pendingAfterStatus(pending:PendingWorkroomSubmission,receipt:WorkroomSubmissionReceipt):PendingWorkroomSubmission|null{
 return receipt.state==='written'?null:{...pending,receipt};
}
/**
 * A status check found the request written. The composer is cleared by the same rule as the direct written path — only
 * while it still holds the submitted draft. When that draft is unknown (a reload kept only the pending record, never
 * its text), nothing is cleared and the message says plainly that the request was already sent.
 */
export function draftAfterWrittenStatus(submittedDraft:string|undefined,liveDraft:string):{clear:boolean;message:string}{
 if(submittedDraft!==undefined&&submittedDraft===liveDraft)return {clear:true,message:'요청 전체를 터미널에 전달했습니다. AI의 실제 응답을 확인하세요.'};
 if(submittedDraft===undefined&&liveDraft.trim())return {clear:false,message:'요청 전체를 터미널에 이미 전달했습니다. 입력칸의 글은 지우지 않았으니, 같은 요청이면 다시 보내지 마세요.'};
 return {clear:false,message:'요청 전체를 터미널에 전달했습니다. AI의 실제 응답을 확인하세요.'};
}
export interface PendingWorkroomSubmission {id:string;sessionId:string;receipt:WorkroomSubmissionReceipt|null}
export function pendingSubmissionKey(scope:string,sessionId:string){return 'agentstoz:pending-submission:v1:'+encodeURIComponent(scope)+':'+sessionId;}
export function readPendingSubmission(storage:Pick<Storage,'getItem'>,key:string):PendingWorkroomSubmission|null{
 const raw=storage.getItem(key);if(raw===null)return null;
 if(raw.length>1024)throw Error('이전 제출 기록을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
 const r=JSON.parse(raw) as PendingWorkroomSubmission;
 if(!r||typeof r!=='object'||Object.keys(r).length!==3||Object.keys(r).some(k=>!['id','sessionId','receipt'].includes(k))||typeof r.id!=='string'||typeof r.sessionId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(r.id)||!/^[A-Za-z0-9_-]{8,160}$/.test(r.sessionId)||r.receipt!==null&&normalizeSubmissionReceipt(r.receipt).id!==r.id)throw Error('이전 제출 기록을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
 return r;
}
export function writePendingSubmission(storage:Storage,key:string,value:PendingWorkroomSubmission|null){
 if(!value){storage.removeItem(key);return;}
 let count=0;for(let i=0;i<storage.length;i++)if(storage.key(i)?.startsWith('agentstoz:pending-submission:v1:'))count++;
 if(storage.getItem(key)===null&&count>=32)throw Error('미확정 제출 기록이 많습니다. 기존 결과를 확인한 뒤 보내세요.');
 storage.setItem(key,JSON.stringify(value));
}
/**
 * A new session's first request whose launch receipt is not yet settled (terminal-start-submission-v1). Metadata only —
 * the prompt text is never stored. While one exists the panel does not start another session for it: a retry could
 * open a second CLI with the same request.
 */
export interface PendingWorkroomLaunch {id:string;targetId:string|null;agent:WorkroomSubmissionLaunch['agent']|null;receipt:WorkroomSubmissionReceipt|null}
export function pendingLaunchKey(scope:string){return 'agentstoz:pending-launch:v1:'+encodeURIComponent(scope);}
const PENDING_LAUNCH_ERROR='이전 새 세션 시작 기록을 확인하지 못했습니다. 자동으로 다시 시작하지 않습니다.';
function pendingLaunchRecord(r:PendingWorkroomLaunch):PendingWorkroomLaunch{
 const ok=(x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(x);
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==4||Object.keys(r).some(k=>!['id','targetId','agent','receipt'].includes(k))||!ok(r.id)||r.targetId!==null&&!ok(r.targetId)||r.agent!==null&&!['codex','claude','hermes','agy'].includes(r.agent)||(r.targetId===null)!==(r.agent===null)||r.receipt!==null&&normalizeSubmissionReceipt(r.receipt).id!==r.id)throw Error(PENDING_LAUNCH_ERROR);
 return r;
}
/** The single-record shape (one unsettled launch). A list written by this release reads as unreadable here: fail-closed. */
export function readPendingLaunch(storage:Pick<Storage,'getItem'>,key:string):PendingWorkroomLaunch|null{
 const raw=storage.getItem(key);if(raw===null)return null;
 if(raw.length>1024)throw Error(PENDING_LAUNCH_ERROR);
 return pendingLaunchRecord(JSON.parse(raw) as PendingWorkroomLaunch);
}
export function writePendingLaunch(storage:Pick<Storage,'setItem'|'removeItem'>,key:string,value:PendingWorkroomLaunch|null){
 if(!value){storage.removeItem(key);return;}
 storage.setItem(key,JSON.stringify(value));
}
/**
 * Unsettled launches of one scope, one entry per launch id (review 2026-10-15). A scope used to hold a single record, so
 * a launch of another target overwrote — and on success deleted — an earlier launch whose outcome was unknown, and
 * nothing then refused re-sending that earlier request. A launch now writes and clears only its own entry.
 */
export const PENDING_LAUNCH_LIMIT=8;
export function readPendingLaunches(storage:Pick<Storage,'getItem'>,key:string):PendingWorkroomLaunch[]{
 const raw=storage.getItem(key);if(raw===null)return [];
 if(raw.length>8192)throw Error(PENDING_LAUNCH_ERROR);
 const value=JSON.parse(raw) as unknown;
 if(!Array.isArray(value))return [pendingLaunchRecord(value as PendingWorkroomLaunch)];
 if(value.length<2||value.length>PENDING_LAUNCH_LIMIT)throw Error(PENDING_LAUNCH_ERROR);
 const list=value.map(item=>pendingLaunchRecord(item as PendingWorkroomLaunch));
 if(new Set(list.map(item=>item.id)).size!==list.length)throw Error(PENDING_LAUNCH_ERROR);
 return list;
}
/** One entry is kept in the single-record shape, so a page of the previous release still reads it. */
export function writePendingLaunches(storage:Pick<Storage,'setItem'|'removeItem'>,key:string,list:readonly PendingWorkroomLaunch[]){
 if(!list.length){storage.removeItem(key);return;}
 storage.setItem(key,JSON.stringify(list.length===1?list[0]:list));
}
/** Replaces (in place), adds or with `null` removes the entry of `id`; every other entry stays as it was. */
export function withPendingLaunch(list:readonly PendingWorkroomLaunch[],id:string,value:PendingWorkroomLaunch|null):PendingWorkroomLaunch[]{
 const index=list.findIndex(item=>item.id===id);
 if(!value)return index<0?[...list]:list.filter(item=>item.id!==id);
 if(index>=0)return list.map(item=>item.id===id?value:item);
 if(list.length>=PENDING_LAUNCH_LIMIT)throw Error('새 세션 시작 결과가 확정되지 않은 기록이 많습니다. 「새 세션 시작 결과 확인」으로 정리한 뒤 다시 시작하세요.');
 return [...list,value];
}
/**
 * This browser's sessionStorage when it can keep records, else null. Blocked site data throws on the getter itself, and a
 * full or refusing store throws on write — either way nothing can be kept there. The probe key is removed again.
 */
export function usableSessionStorage(get:()=>Storage=()=>sessionStorage):Storage|null{
 try{const storage=get(),probe='agentstoz:route-launch-storage-probe';storage.setItem(probe,'1');storage.removeItem(probe);return storage;}catch{return null;}
}
/**
 * This browser's sessionStorage when its records can be read, else null (w4 review, finding 3). Reading and creating are
 * two questions: storage that is full refuses new records but still holds — and must still show — the ones it has, so
 * a real unsettled launch or submission keeps blocking. Blocked site data (the getter throws) or reads that throw hold
 * nothing this page can see.
 */
export function readableSessionStorage(get:()=>Storage=()=>sessionStorage):Storage|null{
 try{const storage=get();storage.getItem('agentstoz:route-launch-storage-probe');return storage;}catch{return null;}
}
/**
 * Pending launches when a panel mounts (w4 L2). Unreadable storage is no storage — not an unreadable record that blocks
 * every start until dismissed. `writable` false (no storage, or storage that refuses new records): the caller starts
 * plainly and says once that launch results cannot be kept here. A record that is present but unreadable still blocks
 * (`unreadable-launch`, it names no target): it may be a real unsettled launch.
 */
export function pendingLaunchesOnLoad(storage:Pick<Storage,'getItem'>|null,key:string,writable:boolean=storage!==null):{list:PendingWorkroomLaunch[];storageUnusable:boolean}{
 if(!storage)return {list:[],storageUnusable:true};
 try{return {list:readPendingLaunches(storage,key),storageUnusable:!writable};}
 catch{return {list:[{id:'unreadable-launch',targetId:null,agent:null,receipt:null}],storageUnusable:!writable};}
}
/** A Storage kept in this page's memory: advisory records (the older-Mac start guard) when the browser keeps no site data. */
export function pageMemoryStorage():Storage{
 const items=new Map<string,string>();
 return {get length(){return items.size;},key:(index:number)=>[...items.keys()][index]??null,getItem:(key:string)=>items.get(key)??null,
  setItem:(key:string,value:string)=>{items.set(key,String(value));},removeItem:(key:string)=>{items.delete(key);},clear:()=>{items.clear();}};
}
/** The entry that refuses another launch of this target and AI: the same target and AI, or a record that names none. */
export function blockingPendingLaunch(list:readonly PendingWorkroomLaunch[],targetId:string,agent:string):PendingWorkroomLaunch|null{
 return list.find(item=>item.targetId===null||item.targetId===targetId&&item.agent===agent)??null;
}
/** An `@` route draft whose new-session launch came back uncertain (this page's memory only, keyed by launch id). */
export interface UncertainRouteLaunch {draft:string;targetId:string;deviceId:string;agent:string}
/**
 * The uncertain `@` launch a send would repeat: the same draft into a session of the same target and AI on the same
 * device. Integration review 2026-10-15 (A1): choosing another session clears the route chip, and the protection keyed
 * on that chip stopped holding — the composer, or an `@` that resolves to the current session, typed the handoff into the
 * very session the launch may have opened. This keys on the session being written instead.
 */
export function uncertainRouteLaunchFor(entries:Iterable<[string,UncertainRouteLaunch]>,send:UncertainRouteLaunch):string|null{
 for(const [id,entry] of entries)if(entry.draft===send.draft&&entry.targetId===send.targetId&&entry.deviceId===send.deviceId&&entry.agent===send.agent)return id;
 return null;
}
/**
 * After an `@` launch settled as written: the composer loses that draft while it still holds it, unless the user re-aimed
 * the same text at another target (their new request). The chip goes only when it still names the launch target.
 */
export function routeDraftClearsOnSettle(routed:UncertainRouteLaunch,live:{draft:string;targetId:string;deviceId:string}):{clearDraft:boolean;clearChip:boolean}{
 if(live.draft!==routed.draft)return {clearDraft:false,clearChip:false};
 if(!live.targetId)return {clearDraft:true,clearChip:false};
 const same=live.targetId===routed.targetId&&live.deviceId===routed.deviceId;
 return {clearDraft:same,clearChip:same};
}
/**
 * After a status check of a launch: written with its session settles it (the caller selects that session); anything
 * else stays pending. Neither outcome re-sends anything.
 */
export function pendingLaunchAfterStatus(pending:PendingWorkroomLaunch,receipt:WorkroomSubmissionReceipt):PendingWorkroomLaunch|null{
 return receipt.state==='written'&&receipt.sessionId||launchNeverStarted(receipt)?null:{...pending,receipt};
}
/**
 * Definitive «nothing started»: `rejected` (the host refused before the spawn fence) or `held` (prepared before a host
 * restart, whose payload is gone). Settling one never re-sends anything; the user may start again by hand.
 */
export function launchNeverStarted(receipt:WorkroomSubmissionReceipt):boolean{return receipt.state==='rejected'||receipt.state==='held';}
/** Receipt states in the words a user reads (docs/ui-glossary.md); the raw names never reach the screen. */
export function submissionStateLabel(state:WorkroomSubmissionReceipt['state']):string{
 return {prepared:'준비됨 · 아직 실행 전',write_started:'실행 시작 · 결과 미확인',written:'전달됨',unknown:'전달 여부 확인 불가',rejected:'실행 안 됨',held:'재시작 전 준비됨 · 실행 안 됨'}[state];
}
/**
 * Receipts the user already settled by hand (「터미널 결과 확인했음」), kept per browser so a `recent` lookup after a
 * reload does not raise the same banner again. Ids only, bounded; unreadable storage reads as «none dismissed».
 */
const DISMISSED_KEY='agentstoz:dismissed-submissions:v1',DISMISSED_LIMIT=64;
export function readDismissedSubmissions(storage:Pick<Storage,'getItem'>):Set<string>{
 try{const value=JSON.parse(storage.getItem(DISMISSED_KEY)??'[]');return new Set(Array.isArray(value)?value.filter((x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(x)).slice(-DISMISSED_LIMIT):[]);}catch{return new Set();}
}
export function rememberDismissedSubmission(storage:Pick<Storage,'getItem'|'setItem'>,id:string){
 const ids=[...readDismissedSubmissions(storage)].filter(x=>x!==id);ids.push(id);
 try{storage.setItem(DISMISSED_KEY,JSON.stringify(ids.slice(-DISMISSED_LIMIT)));}catch{/* the banner simply may return after a reload */}
}
/**
 * Rebuilds the recovery banner from a `recent` answer when this browser lost its pending record (reload, closed tab,
 * killed app). Newest first from the host; dismissed ids are skipped. Read-only: nothing is re-sent.
 */
export function recoveredPendingSubmission(receipts:readonly WorkroomSubmissionReceipt[],dismissed:ReadonlySet<string>,sessionId:string):PendingWorkroomSubmission|null{
 const receipt=receipts.find(r=>r.sessionId===undefined&&!dismissed.has(r.id));
 return receipt?{id:receipt.id,sessionId,receipt}:null;
}
export function recoveredPendingLaunch(receipts:readonly WorkroomSubmissionReceipt[],dismissed:ReadonlySet<string>):PendingWorkroomLaunch|null{
 // The receipt names its target and AI, so the recovered banner blocks only that start — not every start in this scope
 // (another window or device sharing this receipt owner may have left it).
 const receipt=receipts.find(r=>r.sessionId!==undefined&&r.targetId!==undefined&&r.agent!==undefined&&!launchNeverStarted(r)&&!dismissed.has(r.id));
 return receipt?{id:receipt.id,targetId:receipt.targetId!,agent:receipt.agent!,receipt}:null;
}
/**
 * A path that could not parse a launch at all refused it before anything ran: an older Mac forwarding to a newer one
 * (phone → Mac1 → Mac2) normalizes the request with its own, older rules. Only these exact parse refusals count.
 */
export const SUBMISSION_UNPARSED_MESSAGES:readonly string[]=[AI_TERMINAL_UNKNOWN_REQUEST_ERROR,'터미널 요청 형식이 올바르지 않습니다.','터미널 세션 ID가 올바르지 않습니다.'];
export function submissionRequestUnparsed(error:unknown):boolean{
 const value=error as {code?:unknown;message?:unknown}|null;
 return !!value&&typeof value==='object'&&(value.code===AI_TERMINAL_REQUEST_INVALID_CODE||SUBMISSION_UNPARSED_MESSAGES.includes(value.message as string));
}
/**
 * No automatic retry, fallback-to-raw, or clearing of a caller's draft on an unknown receipt.
 * With `launch` (only to a host advertising terminal-start-submission-v1) the request opens a new session: no phase
 * carries a sessionId, and every receipt must name the same host-allocated session.
 * With `attachments` (phone attachment ids, workroom-attach-v1) the host appends their block; the text may be Enter alone.
 */
export async function submitWorkroomDraft(input:{id:string;text:string;references?:string[];attachments?:string[];request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>;prepared:(receipt:WorkroomSubmissionReceipt)=>void}&({sessionId:string;launch?:undefined}|{sessionId?:undefined;launch:WorkroomSubmissionLaunch})):Promise<WorkroomSubmissionReceipt>{
 const attachments=input.attachments?.length?{attachments:[...input.attachments]}:{};
 const bytes=validateSubmissionText(input.text,!!input.attachments?.length);
 let answered=false,launchedSession:string|undefined;
 const invoke=async(submission:AiTerminalRequest['submission'],references?:string[])=>{
  let result:AiTerminalResponse;
  try{result=await input.request({operation:'submission',...(input.launch?{}:{sessionId:input.sessionId}),submission,...(references?.length?{references}:{})});}
  catch(error){if(!answered&&(error instanceof Error&&error.message===COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR||input.launch&&submissionRequestUnparsed(error)))throw new WorkroomSubmissionUnsupportedError();throw error;}
  answered=true;
  const receipt=normalizeSubmissionReceipt(result.submission);
  if(receipt.id!==input.id)throw Error('다른 요청의 제출 영수증입니다. 자동으로 다시 보내지 않습니다.');
  if(input.launch){
   if(!receipt.sessionId||launchedSession!==undefined&&receipt.sessionId!==launchedSession)throw Error('새 세션 시작 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
   launchedSession=receipt.sessionId;
  }else if(receipt.sessionId!==undefined)throw Error('다른 요청의 제출 영수증입니다. 자동으로 다시 보내지 않습니다.');
  return receipt;
 };
 // begin/single only: the launch of a new session and the phone's attachment ids.
 const opening={...(input.launch?{launch:input.launch}:{}),...attachments};
 const base64=(part:Uint8Array)=>{let binary='';for(const byte of part)binary+=String.fromCharCode(byte);return btoa(binary);};
 if(bytes.length<=4000){const receipt=await invoke({phase:'single',id:input.id,bytes:bytes.length,digest:submissionDigest(bytes),data:base64(bytes),...opening},input.references);input.prepared(receipt);return receipt;}
 const first=await invoke({phase:'begin',id:input.id,bytes:bytes.length,digest:submissionDigest(bytes),chunks:Math.ceil(bytes.length/4000),firstData:base64(bytes.subarray(0,4000)),...opening},input.references);
 input.prepared(first);
 if(first.state!=='prepared')return first;
 const check=(receipt:WorkroomSubmissionReceipt)=>{if(receipt.storeId!==first.storeId||receipt.epoch!==first.epoch||receipt.revision!==first.revision)throw Error('호스트 또는 입력 상태가 변경되었습니다. 자동으로 다시 보내지 않습니다.');return receipt;};
 for(let index=1;index<Math.ceil(bytes.length/4000);index++){
  const final=index===Math.ceil(bytes.length/4000)-1;
  const receipt=check(await invoke({phase:'chunk',id:input.id,epoch:first.epoch,index,data:base64(bytes.subarray(index*4000,(index+1)*4000)),...(final?{commit:true as const}:{})}));
  if(receipt.state!=='prepared')return receipt;
 }
 throw Error('제출 최종 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
}
