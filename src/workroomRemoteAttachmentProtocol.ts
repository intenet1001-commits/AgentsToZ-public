/**
 * Phone Workroom attachments (w13) — the wire both halves share. No node or DOM imports: the phone portal bundles it.
 *
 * The phone encrypts each file with a fresh AES-256-GCM key (src/vocAttachments.ts), uploads only the ciphertext to the
 * private VOC transit bucket, and sends the keys inside the E2E relay with `attachments.receive`. The Mac admits the
 * request at once and downloads in the background — a Mac runs phone requests inside its relay poll, and a 50 MB
 * synchronous download stalled every phone of that Mac — so the phone polls `attachments.status` for the result.
 * A ready item comes back as an opaque id (`wa_…`) bound to the receipt owner and the project; a submission names those
 * ids and the Mac appends the attachment block itself. A Mac path never reaches the phone.
 *
 * The actions live outside `workroom.*` on purpose: those require a session id, and another AgentsToZ driving this Mac
 * runs every `workroom.*` action — attachments are not reachable that way.
 */
import {isTransitObjectPath,TRANSIT_GCM_OVERHEAD_BYTES,TRANSIT_OBJECT_MAX_BYTES} from './vocAttachments';

/** One extended capability; the legacy eight never carry it (src/remoteControlCore.ts). */
export const WORKROOM_ATTACH_FEATURE='workroom-attach-v1';
/**
 * `rebind` moves ready ids to another project of the same owner (the viewed session changed) with no new upload, download
 * or id; `release` frees ids the person took back out (their files are deleted, their live slot returns). Both name ids,
 * at most five per call (the same item cap as a receive), and both shipped under the same flag as receive/status.
 */
export const WORKROOM_ATTACH_ACTIONS=['attachments.receive','attachments.status','attachments.rebind','attachments.release'] as const;
export type WorkroomAttachAction=typeof WORKROOM_ATTACH_ACTIONS[number];
export function isWorkroomAttachAction(value:unknown):value is WorkroomAttachAction{return (WORKROOM_ATTACH_ACTIONS as readonly unknown[]).includes(value);}

/** The bucket limit counts the stored object (ciphertext): 10,485,760 − 28 = 10,485,732 bytes of plaintext. Copy: 「10MB까지」. */
export const WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES=TRANSIT_OBJECT_MAX_BYTES-TRANSIT_GCM_OVERHEAD_BYTES;
export const WORKROOM_ATTACH_RECEIVE_MAX_ITEMS=5;
/** `JSON.stringify(attachments)` inside the 11,000-byte relay plaintext (VOC uses 10,400 for its whole submission). */
export const WORKROOM_ATTACH_RECEIVE_MAX_JSON_BYTES=10_000;
export const WORKROOM_ATTACH_TOKEN_MAX=1_200;
export const WORKROOM_ATTACH_NAME_MAX=80;
/** Per request, as on the Mac: six images and ten files. */
export const WORKROOM_ATTACH_MAX_IMAGES=6;
export const WORKROOM_ATTACH_MAX_FILES=10;
export const WORKROOM_ATTACH_MAX_IDS=WORKROOM_ATTACH_MAX_IMAGES+WORKROOM_ATTACH_MAX_FILES;
export const WORKROOM_ATTACH_ID_RE=/^wa_[A-Za-z0-9_-]{32}$/;
/** An id lives this long from the moment its file was ready; an unconsumed one is then deleted. */
export const WORKROOM_ATTACH_TTL_MS=60*60*1000;
/** Bounds on what a phone can make a Mac download (critique 14). */
export const WORKROOM_ATTACH_RATE_PER_MINUTE=10;
export const WORKROOM_ATTACH_DAILY_BYTES=256*1024*1024;
export const WORKROOM_ATTACH_LIVE_IDS=32;
export const WORKROOM_ATTACH_HOST_BYTES=512*1024*1024;
export const WORKROOM_ATTACH_ACTIVE_JOBS=2;
export const WORKROOM_ATTACH_QUEUED_JOBS=8;
export const WORKROOM_ATTACH_ITEM_TIMEOUT_MS=120_000;
export const WORKROOM_ATTACH_COMMUNITY_REFUSAL='다른 아젠투지의 세션에는 아직 첨부할 수 없습니다 — 연결한 Mac의 세션에서 첨부하세요';

export interface WorkroomAttachmentReceiveItem {
  /** `<hostId>/<uploader uid>/<uuid>.bin` in the transit bucket. */
  path:string;
  /** The signed-URL token only; the Mac rebuilds the URL from its own Supabase URL. */
  token:string;
  key:string;
  /** Of the plaintext. */
  sha256:string;
  bytes:number;
  kind:'image'|'file';
  /** Files only; the Mac sanitises it again before writing (src/workroomAttachmentRules.ts). */
  name?:string;
}
export interface WorkroomAttachmentReceive {receiveId:string;items:WorkroomAttachmentReceiveItem[]}
export interface WorkroomAttachmentStatusRequest {receiveId:string}
/** `attachments.rebind` / `attachments.release`: up to five ids; `receiveId` only pairs the answer with the call. */
export interface WorkroomAttachmentIdsRequest {receiveId:string;ids:string[]}
export type WorkroomAttachmentRequest=WorkroomAttachmentReceive|WorkroomAttachmentStatusRequest|WorkroomAttachmentIdsRequest;
export type WorkroomAttachmentItemResult=
 | {state:'pending'}
 | {state:'ready';id:string;kind:'image'|'file';bytes:number;
    /** UTF-8 length of the path line the Mac will append — never the path; the phone budgets 24,000 bytes with it. */
    lineBytes:number;
    /** Relative, not a clock time: the phone and the Mac clocks differ. */
    expiresInMs:number;
    /** false: the Mac could not delete the transit object, so the phone deletes it. */
    removed:boolean}
 | {state:'failed';code:string;message:string;removed:boolean};
export interface WorkroomAttachmentResult {receiveId:string;items:WorkroomAttachmentItemResult[]}

const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE=/^WORKROOM_ATTACH_[A-Z_]{2,48}$/;
/** C0/C1 controls, DEL, line/paragraph separators, BOM and every bidi control (as src/workroomAttachmentRules.ts). */
const UNSAFE_NAME=/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const exact=(value:object,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
const plainObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const wellFormed=(text:string)=>new TextDecoder().decode(new TextEncoder().encode(text))===text;

function fail():never{throw new Error('첨부 전달 요청 형식이 올바르지 않습니다.');}

export function normalizeWorkroomAttachmentRequest(action:'attachments.receive',value:unknown):WorkroomAttachmentReceive;
export function normalizeWorkroomAttachmentRequest(action:'attachments.status',value:unknown):WorkroomAttachmentStatusRequest;
export function normalizeWorkroomAttachmentRequest(action:'attachments.rebind'|'attachments.release',value:unknown):WorkroomAttachmentIdsRequest;
export function normalizeWorkroomAttachmentRequest(action:WorkroomAttachAction,value:unknown):WorkroomAttachmentRequest;
export function normalizeWorkroomAttachmentRequest(action:WorkroomAttachAction,value:unknown):WorkroomAttachmentRequest{
  if(!plainObject(value)||typeof value.receiveId!=='string'||!UUID_V4.test(value.receiveId))return fail();
  if(action==='attachments.status'){if(!exact(value,['receiveId']))return fail();return {receiveId:value.receiveId};}
  if(action==='attachments.rebind'||action==='attachments.release'){
    const ids=value.ids;
    if(!exact(value,['receiveId','ids'])||!Array.isArray(ids)||ids.length<1||ids.length>WORKROOM_ATTACH_RECEIVE_MAX_ITEMS
      ||ids.some(id=>typeof id!=='string'||!WORKROOM_ATTACH_ID_RE.test(id))||new Set(ids).size!==ids.length)return fail();
    return {receiveId:value.receiveId,ids:[...ids] as string[]};
  }
  if(!exact(value,['receiveId','items'])||!Array.isArray(value.items)||value.items.length<1||value.items.length>WORKROOM_ATTACH_RECEIVE_MAX_ITEMS)return fail();
  const paths=new Set<string>();
  const items=value.items.map((raw):WorkroomAttachmentReceiveItem=>{
    if(!plainObject(raw)||!exact(raw,['path','token','key','sha256','bytes','kind','name']))return fail();
    if(!isTransitObjectPath(raw.path)||paths.has(raw.path))return fail();
    paths.add(raw.path);
    if(typeof raw.token!=='string'||!new RegExp(`^[A-Za-z0-9_.-]{20,${WORKROOM_ATTACH_TOKEN_MAX}}$`).test(raw.token))return fail();
    if(typeof raw.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw.key))return fail();
    if(typeof raw.sha256!=='string'||!/^[a-f0-9]{64}$/.test(raw.sha256))return fail();
    if(!Number.isSafeInteger(raw.bytes)||(raw.bytes as number)<1||(raw.bytes as number)>WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)return fail();
    if(raw.kind!=='image'&&raw.kind!=='file')return fail();
    let name:string|undefined;
    if(raw.name!==undefined){
      if(raw.kind!=='file'||typeof raw.name!=='string'||!raw.name.trim()||UNSAFE_NAME.test(raw.name)||!wellFormed(raw.name)||Array.from(raw.name).length>WORKROOM_ATTACH_NAME_MAX)return fail();
      name=raw.name;
    }
    return {path:raw.path,token:raw.token,key:raw.key,sha256:raw.sha256,bytes:raw.bytes as number,kind:raw.kind,...(name!==undefined?{name}:{})};
  });
  const request={receiveId:value.receiveId,items};
  if(new TextEncoder().encode(JSON.stringify(request)).length>WORKROOM_ATTACH_RECEIVE_MAX_JSON_BYTES)return fail();
  return request;
}

export function normalizeWorkroomAttachmentResult(value:unknown):WorkroomAttachmentResult{
  const bad=():never=>{throw new Error('첨부 전달 응답 형식이 올바르지 않습니다.');};
  if(!plainObject(value)||!exact(value,['receiveId','items'])||typeof value.receiveId!=='string'||!UUID_V4.test(value.receiveId)
    ||!Array.isArray(value.items)||value.items.length<1||value.items.length>WORKROOM_ATTACH_RECEIVE_MAX_ITEMS)return bad();
  const items=value.items.map((raw):WorkroomAttachmentItemResult=>{
    if(!plainObject(raw))return bad();
    if(raw.state==='pending'){if(!exact(raw,['state']))return bad();return {state:'pending'};}
    if(raw.state==='ready'){
      if(!exact(raw,['state','id','kind','bytes','lineBytes','expiresInMs','removed'])||typeof raw.id!=='string'||!WORKROOM_ATTACH_ID_RE.test(raw.id)
        ||(raw.kind!=='image'&&raw.kind!=='file')||!Number.isSafeInteger(raw.bytes)||(raw.bytes as number)<1||(raw.bytes as number)>WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES
        ||!Number.isSafeInteger(raw.lineBytes)||(raw.lineBytes as number)<1||(raw.lineBytes as number)>4096
        ||!Number.isSafeInteger(raw.expiresInMs)||(raw.expiresInMs as number)<0||(raw.expiresInMs as number)>WORKROOM_ATTACH_TTL_MS||typeof raw.removed!=='boolean')return bad();
      return {state:'ready',id:raw.id,kind:raw.kind,bytes:raw.bytes as number,lineBytes:raw.lineBytes as number,expiresInMs:raw.expiresInMs as number,removed:raw.removed};
    }
    if(raw.state==='failed'){
      if(!exact(raw,['state','code','message','removed'])||typeof raw.code!=='string'||!CODE.test(raw.code)||typeof raw.message!=='string'
        ||!raw.message||raw.message.length>300||typeof raw.removed!=='boolean')return bad();
      return {state:'failed',code:raw.code,message:raw.message,removed:raw.removed};
    }
    return bad();
  });
  return {receiveId:value.receiveId,items};
}

/** What one failed item says to the person (codes never reach the screen on their own). */
export function workroomAttachmentFailureMessage(code:string):string{
  switch(code){
    case 'WORKROOM_ATTACH_DOWNLOAD_NOT_FOUND':return '전달할 파일을 Mac이 찾지 못했습니다. 다시 넣어 주세요.';
    case 'WORKROOM_ATTACH_DOWNLOAD_FAILED':return 'Mac이 파일을 내려받지 못했습니다. 잠시 뒤 다시 시도하세요.';
    case 'WORKROOM_ATTACH_TOO_LARGE':return '파일 하나는 10MB까지 넣을 수 있습니다.';
    case 'WORKROOM_ATTACH_DECRYPT_FAILED':
    case 'WORKROOM_ATTACH_HASH_MISMATCH':return '파일이 전달 중에 손상되었습니다. 다시 넣어 주세요.';
    case 'WORKROOM_ATTACH_NOT_IMAGE':return '사진으로 넣은 파일이 이미지가 아닙니다. 「파일 첨부」로 넣어 주세요.';
    case 'WORKROOM_ATTACH_REVOKED':return '이 기기의 접근 허용이 바뀌어 Mac이 파일을 저장하지 않았습니다.';
    case 'WORKROOM_ATTACH_SAVE_FAILED':return 'Mac에 파일을 저장하지 못했습니다. 다시 시도하세요.';
    case 'WORKROOM_ATTACH_INTERRUPTED':return 'Mac 앱이 다시 시작되어 전달이 중단되었습니다. 다시 시도하세요.';
    case 'WORKROOM_ATTACH_EXPIRED':return '첨부를 넣은 지 오래되어 Mac이 지웠습니다. 다시 넣어 주세요.';
    case 'WORKROOM_ATTACH_NOT_FOUND':return 'Mac에서 이 첨부를 찾지 못했습니다. 다시 넣어 주세요.';
    case 'WORKROOM_ATTACH_CONSUMED':return '이미 보낸 요청에 쓰인 첨부입니다. 다시 넣어 주세요.';
    case 'WORKROOM_ATTACH_RELEASED':return '첨부를 뺐습니다.';
    default:return '첨부를 전달하지 못했습니다. 다시 시도하세요.';
  }
}

/** The partial-failure line above the composer; the text stays sendable with the rest. */
export function remoteAttachFailureSummary(total:number,failed:number):string{
  return `첨부 ${total}개 중 ${failed}개를 전달하지 못했습니다`;
}
