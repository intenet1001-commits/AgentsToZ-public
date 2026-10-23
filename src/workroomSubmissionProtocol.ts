import {sha256} from '@noble/hashes/sha2.js';

export const WORKROOM_SUBMISSION_FEATURE='terminal-submission-v1';
/** A new session's first request rides a submission: `launch` on begin/single, no sessionId on any phase. The receipt
 *  then carries the host-allocated `sessionId`, so a lost response or a replay returns that session and never a second CLI. */
export const WORKROOM_LAUNCH_SUBMISSION_FEATURE='terminal-start-submission-v1';
/** `{phase:'recent'}`: this owner's unsettled receipts for one session (or, without a sessionId, its launches). Read-only. */
export const WORKROOM_SUBMISSION_RECENT_FEATURE='terminal-submission-recent-v1';
export const WORKROOM_SUBMISSION_RECENT_LIMIT=8;
/** Host-only key scope of launch receipts; never a session id (those are UUIDs) and never on the wire. */
export const WORKROOM_LAUNCH_SCOPE=':launch';
export interface WorkroomSubmissionLaunch {targetId:string;agent:'codex'|'claude'|'hermes'|'agy';cols:number;rows:number;bypassPermissions?:boolean}
/** The host's answer to a status/later phase for an id it has never stored. Its first sentence is the stable part: a
 *  queued draft (src/workroomDraftQueue.ts) sends with its pre-assigned id only after a status check said exactly this. */
export const WORKROOM_SUBMISSION_NOT_FOUND_PREFIX='같은 호스트 저장소의 제출 기록을 확인하지 못했습니다.';
export const WORKROOM_SUBMISSION_NOT_FOUND_ERROR=WORKROOM_SUBMISSION_NOT_FOUND_PREFIX+' 자동 재전송하지 않습니다.';
export const WORKROOM_SUBMISSION_MAX_BYTES=24_000;
export const WORKROOM_SUBMISSION_CHUNK_BYTES=4_000;
/**
 * Phone attachment ids (w13, workroom-attach-v1): opaque `wa_…` ids the Mac admitted for this owner and project. The Mac
 * appends their block itself; a request with attachments may be Enter alone (`bytes` 1). Six images and ten files.
 */
export const WORKROOM_SUBMISSION_MAX_ATTACHMENTS=16;
const ATTACHMENT_ID=/^wa_[A-Za-z0-9_-]{32}$/;
export type WorkroomSubmissionCommand=
 | {phase:'begin';id:string;bytes:number;digest:string;chunks:number;firstData?:string;launch?:WorkroomSubmissionLaunch;attachments?:string[]}
 | {phase:'single';id:string;bytes:number;digest:string;data:string;launch?:WorkroomSubmissionLaunch;attachments?:string[]}
 | {phase:'chunk';id:string;epoch:string;index:number;data:string;commit?:true}
 | {phase:'commit';id:string;epoch:string}
 | {phase:'status';id:string}
 | {phase:'recent'};
export interface WorkroomSubmissionReceipt {
 id:string;storeId:string;epoch:string;revision:number;
 state:'prepared'|'write_started'|'written'|'unknown'|'rejected'|'held';
 /** Only on a launch receipt (a client that sent `launch`, or asked `recent` — both terminal-start-submission-v1 or
  *  later): the session the host allocated for it, and the target and AI it opens. All three or none. */
 sessionId?:string;targetId?:string;agent?:WorkroomSubmissionLaunch['agent'];
}
const id=(x:unknown)=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(x);
const integer=(x:unknown,min:number,max:number)=>Number.isSafeInteger(x)&&Number(x)>=min&&Number(x)<=max;
export const submissionDigest=(bytes:Uint8Array)=>Array.from(sha256(bytes),x=>x.toString(16).padStart(2,'0')).join('');
/** Attachment ids join the manifest only when present, so every receipt hash made before w13 stays the same. */
export const submissionManifestHash=(bytes:number,digest:string,references:readonly string[],attachments?:readonly string[])=>submissionDigest(new TextEncoder().encode(JSON.stringify(attachments?.length?[bytes,digest,references,attachments]:[bytes,digest,references])));
/** `withAttachments`: the request carries attachment ids, so Enter alone (attachments without words) is a request. */
export function validateSubmissionText(text:string,withAttachments=false){
 const bytes=new TextEncoder().encode(text);
 if(bytes.length<(withAttachments?1:2)||bytes.length>WORKROOM_SUBMISSION_MAX_BYTES||!text.endsWith('\r')||text.slice(0,-1).includes('\r')||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==text)throw Error('요청은 24,000바이트 안의 완전한 텍스트와 마지막 Enter 하나로 작성하세요. 작성 내용은 유지했습니다.');
 return bytes;
}
function normalizeAttachments(value:unknown):string[]|null{
 if(!Array.isArray(value)||value.length<1||value.length>WORKROOM_SUBMISSION_MAX_ATTACHMENTS||value.some(x=>typeof x!=='string'||!ATTACHMENT_ID.test(x))||new Set(value).size!==value.length)return null;
 return [...value] as string[];
}
function normalizeLaunch(value:unknown):WorkroomSubmissionLaunch|null{
 const l=value as WorkroomSubmissionLaunch;
 if(!l||typeof l!=='object'||Array.isArray(l)||Object.keys(l).some(k=>!['targetId','agent','cols','rows','bypassPermissions'].includes(k)))return null;
 if(!id(l.targetId)||!['codex','claude','hermes','agy'].includes(l.agent)||!integer(l.cols,20,300)||!integer(l.rows,5,150)||l.bypassPermissions!==undefined&&typeof l.bypassPermissions!=='boolean')return null;
 return {targetId:l.targetId,agent:l.agent,cols:l.cols,rows:l.rows,...(l.bypassPermissions!==undefined?{bypassPermissions:l.bypassPermissions}:{})};
}
export function normalizeWorkroomSubmission(value:unknown):WorkroomSubmissionCommand {
 const fail=()=>{throw Error('제출 내용을 확인하지 못했습니다. 작성 내용을 유지하고 다시 확인하세요.');};
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const r=value as WorkroomSubmissionCommand;
 if(r.phase==='recent'){if(Object.keys(r).length!==1)return fail();return {phase:'recent'};}
 const keys={begin:['phase','id','bytes','digest','chunks'],single:['phase','id','bytes','digest','data'],chunk:['phase','id','epoch','index','data'],commit:['phase','id','epoch'],status:['phase','id']}[r.phase];
 const optional=r.phase==='begin'?['firstData','launch','attachments']:r.phase==='single'?['launch','attachments']:r.phase==='chunk'?['commit']:[];
 if(!Array.isArray(keys)||!id(r.id)||keys.some(k=>!Object.hasOwn(r,k))||Object.keys(r).some(k=>![...keys,...optional].includes(k)))return fail();
 const launch=(r.phase==='begin'||r.phase==='single')&&r.launch!==undefined?normalizeLaunch(r.launch):undefined;
 if(launch===null)return fail();
 const attachments=(r.phase==='begin'||r.phase==='single')&&r.attachments!==undefined?normalizeAttachments(r.attachments):undefined;
 if(attachments===null)return fail();
 if('epoch' in r&&!id(r.epoch))return fail();
 if((r.phase==='begin'||r.phase==='single')&&(!integer(r.bytes,attachments?1:2,r.phase==='single'?WORKROOM_SUBMISSION_CHUNK_BYTES:WORKROOM_SUBMISSION_MAX_BYTES)||typeof r.digest!=='string'||!/^[a-f0-9]{64}$/.test(r.digest)))return fail();
 if(r.phase==='begin'&&(!integer(r.chunks,1,6)||r.chunks!==Math.ceil(r.bytes/WORKROOM_SUBMISSION_CHUNK_BYTES)))return fail();
 const base64=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=5336&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x);
 if(r.phase==='chunk'&&(!integer(r.index,0,5)||r.commit!==undefined&&r.commit!==true||!base64(r.data)))return fail();
 if(r.phase==='single'&&!base64(r.data)||r.phase==='begin'&&r.firstData!==undefined&&!base64(r.firstData))return fail();
 return {...r,...(launch?{launch}:{}),...(attachments?{attachments}:{})};
}
export function normalizeSubmissionReceipt(value:unknown):WorkroomSubmissionReceipt {
 const r=value as WorkroomSubmissionReceipt;
 const keys=r&&typeof r==='object'&&!Array.isArray(r)?Object.keys(r):[];
 if(!r||typeof r!=='object'||Array.isArray(r)||keys.length!==(r.sessionId===undefined?5:8)||keys.some(k=>!['id','storeId','epoch','revision','state','sessionId','targetId','agent'].includes(k)))throw Error('제출 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
 if(!id(r.id)||!id(r.storeId)||!id(r.epoch)||!integer(r.revision,0,Number.MAX_SAFE_INTEGER)||!['prepared','write_started','written','unknown','rejected','held'].includes(r.state)
  ||r.sessionId!==undefined&&(!id(r.sessionId)||!id(r.targetId)||!['codex','claude','hermes','agy'].includes(r.agent!)))throw Error('제출 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
 return {...r};
}
