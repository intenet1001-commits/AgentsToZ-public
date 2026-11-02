import {
  COMPUTER_USE_REMOTE_LIMITS,
  COMPUTER_USE_REMOTE_PLATFORMS,
  COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES,
  COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS,
  COMPUTER_USE_REMOTE_SEALED_OPS,
  COMPUTER_USE_REMOTE_VERSION,
  computerUseRemoteBoxChars,
  isComputerUseRemoteBox,
  newComputerUseRemoteId,
  type ComputerUseRemoteCallReply,
  type ComputerUseRemotePlatform,
  type ComputerUseRemoteSealedOp,
} from './computerUseRemoteProtocol';
import {
  exportRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from './remoteControlRelayCrypto';

/**
 * End-to-end sealing for computer use between community Macs (DESIGN §8.2–8.3). Screens, input text, grant secrets and
 * every error after decryption travel only inside these boxes; the mailbox row keeps kind, session, seq, sentAt,
 * connection tag, platform and size (RC-5).
 *
 * - Key agreement: ephemeral P-256 ECDH (memory only, generated and imported with the relay's helpers), then HKDF-SHA256
 *   under its own domain — the relay's derivation has fixed labels and an 11,000-byte envelope, so it is not reused.
 *   salt `agentstoz.computer-use.remote/v1\0<session>`, info `…\0<A deviceId>\0<B deviceId>\0<connection tag>\0a2b|b2a`:
 *   one AES-256-GCM key per direction.
 * - Nonce: a 4-byte direction tag ‖ the 8-byte request seq. A request is sealed once per seq (strictly increasing) and its
 *   reply once per seq, so no (key, nonce) pair repeats within a channel. Across channels it holds because a private key
 *   establishes at most one channel: two channels from the same key pair, peer key and binding would derive the same keys
 *   and both start at seq 1. So **every hello uses a fresh key pair** from `generateComputerUseRemoteKeyPair` — a retried
 *   hello, a second channel built from a late hello answer and the receiver's answer to each hello included —
 *   and `establish` refuses a key it did not generate or has seen before (KEY_NOT_FRESH), whether or not that attempt
 *   succeeded.
 * - AAD: `v1|session|seq|sentAt|fromDeviceId|toDeviceId|instance|platform|op`, where from/to are always the session's
 *   sender (A) and receiver (B). The receiver puts the fromDeviceId the database handed it with the row, so a box moved to
 *   another device's row does not open. The endpoint is not in it (RC-15).
 *
 * Limit (§8.2): this is an unauthenticated ephemeral agreement. It stops passive readers of the database (dashboard,
 * backups, logs, read SQL) but not an active man-in-the-middle holding service_role; that needs device identity keys (D3).
 */

export const COMPUTER_USE_REMOTE_HKDF_DOMAIN='agentstoz.computer-use.remote/v1' as const;
const AES_KEY_BITS=256;
const GCM_TAG_BITS=128;
const NONCE_BYTES=12;
/**
 * Sender: a sealed request's reply can still be opened for at least this long after sealing, however many requests are
 * sealed after it — the session keeps a timed-out call's late answer this long (§7.8-6). A reply opened is forgotten at once.
 */
export const COMPUTER_USE_REMOTE_REPLY_MEMORY_MS=COMPUTER_USE_REMOTE_LIMITS.lateAnswerMemoryMs;
/**
 * A memory bound on the sender's unopened requests, not a retention rule: reaching it within the reply memory takes more
 * than 13 unopened seals a second for ten minutes, while A serializes a session's calls and keeps at most 24 unanswered
 * rows per device in ten minutes (§8.7). Evicting past it fails safe: REPLAY — the input stays unknown and its receipt settles it.
 */
const SENDER_AWAITING_MAX=8192;
/** Receiver: requests opened but not yet answered. B answers each within 15 s from a lane of depth 8, so this is never near. */
const RECEIVER_UNREPLIED_MAX=256;
export type ComputerUseRemoteDirection='a2b'|'b2a';
export type ComputerUseRemoteSide='sender'|'receiver';
const DIRECTION_TAGS:Record<ComputerUseRemoteDirection,Uint8Array>={a2b:Uint8Array.of(0x61,0x32,0x62,0x00),b2a:Uint8Array.of(0x62,0x32,0x61,0x00)};

export type ComputerUseRemoteCryptoErrorCode='INVALID_BINDING'|'INVALID_HEADER'|'INVALID_PUBLIC_KEY'|'KEY_NOT_FRESH'|'KEY_AGREEMENT_FAILED'
  |'WRONG_SIDE'|'NONCE_REUSE'|'REPLAY'|'INVALID_BOX'|'DECRYPTION_FAILED'|'ENCRYPTION_FAILED'|'FRAME_INVALID'|'FRAME_TOO_LARGE'|'PARTS_INVALID';
const MESSAGES:Record<ComputerUseRemoteCryptoErrorCode,string>={
  INVALID_BINDING:'원격 컴퓨터 유즈 연결 정보를 확인하지 못했습니다.',
  INVALID_HEADER:'원격 컴퓨터 유즈 요청 번호를 확인하지 못했습니다.',
  INVALID_PUBLIC_KEY:'상대 기기의 연결 키를 확인하지 못했습니다.',
  KEY_NOT_FRESH:'연결 키는 한 번만 씁니다. 새 키로 다시 연결하세요.',
  KEY_AGREEMENT_FAILED:'상대 기기와 암호 키를 맞추지 못했습니다.',
  WRONG_SIDE:'이 연결에서 할 수 없는 암호 처리입니다.',
  NONCE_REUSE:'같은 요청 번호로 두 번 봉인하지 않습니다.',
  REPLAY:'이미 처리했거나 순서가 맞지 않는 요청입니다.',
  INVALID_BOX:'암호 상자 형식을 확인하지 못했습니다.',
  DECRYPTION_FAILED:'암호 상자를 열지 못했습니다.',
  ENCRYPTION_FAILED:'암호 상자를 만들지 못했습니다.',
  FRAME_INVALID:'암호 상자 안의 내용 형식을 확인하지 못했습니다.',
  FRAME_TOO_LARGE:'암호 상자에 넣을 내용이 너무 큽니다.',
  PARTS_INVALID:'나눠 받은 응답 조각을 확인하지 못했습니다.',
};
/** Messages carry no content and no field names; they may reach the plaintext mailbox. */
export class ComputerUseRemoteCryptoError extends Error {
  constructor(readonly code:ComputerUseRemoteCryptoErrorCode){super(MESSAGES[code]);this.name='ComputerUseRemoteCryptoError';}
}
const fail=(code:ComputerUseRemoteCryptoErrorCode):never=>{throw new ComputerUseRemoteCryptoError(code);};
const subtle=()=>globalThis.crypto.subtle;
const buffer=(bytes:Uint8Array):ArrayBuffer=>new Uint8Array(bytes).buffer;
const utf8=new TextEncoder();
const hex32=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Private keys this module generated and no `establish` has taken yet. Membership is by object, so a key imported or
 * cloned (structuredClone makes a new CryptoKey of the same key) is never in it.
 */
const freshPrivateKeys=new WeakSet<CryptoKey>();
/**
 * An ephemeral key pair for exactly one channel, and its raw public point as base64url (the `pub` of hello). Memory only,
 * not extractable. Make a new one for every hello — `establish` takes the private key once.
 */
export async function generateComputerUseRemoteKeyPair():Promise<{keyPair:CryptoKeyPair;publicKey:string}>{
  const keyPair=await generateRemoteControlRelayKeyPair();
  const publicKey=await exportRemoteControlRelayPublicKey(keyPair.publicKey);
  freshPrivateKeys.add(keyPair.privateKey);
  return {keyPair,publicKey};
}

/** Who a session is between. The receiver fills senderDeviceId from the database's record of the row, never from the body. */
export interface ComputerUseRemoteBinding {
  session:string;senderDeviceId:string;receiverDeviceId:string;instance:string;platform:ComputerUseRemotePlatform;
  /** Present only after credential-backed mutual authentication and both key confirmations. */
  authenticationHash?:string;
}
export function normalizeComputerUseRemoteBinding(value:ComputerUseRemoteBinding):ComputerUseRemoteBinding{
  if(!value||!hex32(value.session)||!hex32(value.instance)||!uuid(value.senderDeviceId)||!uuid(value.receiverDeviceId)
    ||!(COMPUTER_USE_REMOTE_PLATFORMS as readonly unknown[]).includes(value.platform)
    ||value.authenticationHash!==undefined&&!/^[0-9a-f]{64}$/.test(value.authenticationHash))return fail('INVALID_BINDING');
  const senderDeviceId=value.senderDeviceId.toLowerCase(),receiverDeviceId=value.receiverDeviceId.toLowerCase();
  if(senderDeviceId===receiverDeviceId)return fail('INVALID_BINDING');
  return {session:value.session,senderDeviceId,receiverDeviceId,instance:value.instance,platform:value.platform,...(value.authenticationHash?{authenticationHash:value.authenticationHash}:{})};
}
export interface ComputerUseRemoteSealHeader {op:ComputerUseRemoteSealedOp;seq:number;sentAt:number}
function header(value:ComputerUseRemoteSealHeader):ComputerUseRemoteSealHeader{
  if(!value||!(COMPUTER_USE_REMOTE_SEALED_OPS as readonly unknown[]).includes(value.op)||!Number.isSafeInteger(value.seq)||value.seq<1
    ||!Number.isSafeInteger(value.sentAt)||value.sentAt<=0)return fail('INVALID_HEADER');
  return {op:value.op,seq:value.seq,sentAt:value.sentAt};
}
/** The additional data both directions of one request authenticate. */
export function computerUseRemoteAad(binding:ComputerUseRemoteBinding,value:ComputerUseRemoteSealHeader):string{
  const b=normalizeComputerUseRemoteBinding(binding),h=header(value);
  return [`v${COMPUTER_USE_REMOTE_VERSION}`,b.session,h.seq,h.sentAt,b.senderDeviceId,b.receiverDeviceId,b.instance,b.platform,h.op,...(b.authenticationHash?[b.authenticationHash]:[])].join('|');
}
export function computerUseRemoteNonce(direction:ComputerUseRemoteDirection,seq:number):Uint8Array{
  if(!Number.isSafeInteger(seq)||seq<1)return fail('INVALID_HEADER');
  const nonce=new Uint8Array(NONCE_BYTES);nonce.set(DIRECTION_TAGS[direction],0);
  const view=new DataView(nonce.buffer);
  view.setUint32(4,Math.floor(seq/0x1_0000_0000));view.setUint32(8,seq%0x1_0000_0000);
  return nonce;
}

async function deriveDirectionKeys(privateKey:CryptoKey,peerPublicKey:CryptoKey,binding:ComputerUseRemoteBinding,side:ComputerUseRemoteSide)
  :Promise<{seal:CryptoKey;open:CryptoKey}>{
  let shared:Uint8Array;
  try{shared=new Uint8Array(await subtle().deriveBits({name:'ECDH',public:peerPublicKey},privateKey,AES_KEY_BITS));}
  catch{return fail('KEY_AGREEMENT_FAILED');}
  try{
    const base=await subtle().importKey('raw',buffer(shared),'HKDF',false,['deriveKey']);
    const salt=utf8.encode(`${COMPUTER_USE_REMOTE_HKDF_DOMAIN}\0${binding.session}${binding.authenticationHash?'\0authenticated-v2\0'+binding.authenticationHash:''}`);
    const key=(direction:ComputerUseRemoteDirection,usage:'encrypt'|'decrypt')=>subtle().deriveKey(
      {name:'HKDF',hash:'SHA-256',salt:buffer(salt),info:buffer(utf8.encode(
        `${COMPUTER_USE_REMOTE_HKDF_DOMAIN}\0${binding.senderDeviceId}\0${binding.receiverDeviceId}\0${binding.instance}\0${direction}`))},
      base,{name:'AES-GCM',length:AES_KEY_BITS},false,[usage]);
    // The sender seals a2b and opens b2a; the receiver the reverse. Neither ever holds the other use of a key.
    return side==='sender'
      ?{seal:await key('a2b','encrypt'),open:await key('b2a','decrypt')}
      :{seal:await key('b2a','encrypt'),open:await key('a2b','decrypt')};
  }catch{return fail('KEY_AGREEMENT_FAILED');}
  finally{shared.fill(0);}
}

// ── The plaintext frame: u32be metaLen ‖ meta JSON ‖ optional binary attachment ─────────────────────────────────────
/** A JPEG goes in as its own bytes: base64 is applied once, to the whole sealed box, never twice. */
export function encodeComputerUseRemoteFrame(meta:Record<string,unknown>,attachment:Uint8Array|null=null,
  maxBytes:number=COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES):Uint8Array{
  if(!plain(meta))return fail('FRAME_INVALID');
  let json:Uint8Array;
  try{json=utf8.encode(JSON.stringify(meta));}catch{return fail('FRAME_INVALID');}
  if(attachment!==null&&!(attachment instanceof Uint8Array))return fail('FRAME_INVALID');
  const extra=attachment?.byteLength??0;
  if(json.byteLength>COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes||extra>COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes||4+json.byteLength+extra>maxBytes)
    return fail('FRAME_TOO_LARGE');
  const frame=new Uint8Array(4+json.byteLength+extra);
  new DataView(frame.buffer).setUint32(0,json.byteLength);
  frame.set(json,4);if(attachment)frame.set(attachment,4+json.byteLength);
  return frame;
}
export function decodeComputerUseRemoteFrame(bytes:Uint8Array,options:{maxBytes:number;allowAttachment:boolean})
  :{meta:Record<string,unknown>;attachment:Uint8Array|null}{
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<4||bytes.byteLength>options.maxBytes)return fail('FRAME_INVALID');
  const metaLength=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  if(metaLength<2||metaLength>COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes||4+metaLength>bytes.byteLength)return fail('FRAME_INVALID');
  const rest=bytes.byteLength-4-metaLength;
  if(rest>COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes||rest>0&&!options.allowAttachment)return fail('FRAME_INVALID');
  let meta:unknown;
  try{meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(4,4+metaLength)));}catch{return fail('FRAME_INVALID');}
  if(!plain(meta))return fail('FRAME_INVALID');
  return {meta,attachment:rest>0?bytes.slice(4+metaLength):null};
}

// ── Boxes and parts ─────────────────────────────────────────────────────────────────────────────────────────────────
const BOX_MAX_CHARS=COMPUTER_USE_REMOTE_LIMITS.partMaxChars*COMPUTER_USE_REMOTE_LIMITS.partsMax;
/** ciphertext ‖ tag as standard padded base64 (the worst reply is 400,028 characters). */
export function encodeComputerUseRemoteBox(bytes:Uint8Array):string{
  let binary='';
  for(let offset=0;offset<bytes.byteLength;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(binary);
}
export function decodeComputerUseRemoteBox(box:unknown,maxChars:number=BOX_MAX_CHARS):Uint8Array{
  if(!isComputerUseRemoteBox(box,maxChars))return fail('INVALID_BOX');
  let binary:string;
  try{binary=atob(box);}catch{return fail('INVALID_BOX');}
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);
  // Canonical only: a box with non-zero padding bits is a different string for the same bytes.
  if(encodeComputerUseRemoteBox(bytes)!==box)return fail('INVALID_BOX');
  return bytes;
}
/** One or two parts of at most 210,000 characters; the cut falls on a 4-character boundary. */
export function splitComputerUseRemoteBox(box:string):[string]|[string,string]{
  if(!isComputerUseRemoteBox(box,BOX_MAX_CHARS))return fail('PARTS_INVALID');
  const max=COMPUTER_USE_REMOTE_LIMITS.partMaxChars;
  return box.length<=max?[box]:[box.slice(0,max),box.slice(max)];
}
/** Integrity of the joined box is the one GCM tag checked when it is opened. */
export function joinComputerUseRemoteBox(parts:readonly string[]):string{
  const max=COMPUTER_USE_REMOTE_LIMITS.partMaxChars;
  if(!Array.isArray(parts)||parts.length<1||parts.length>COMPUTER_USE_REMOTE_LIMITS.partsMax
    ||parts.some(part=>typeof part!=='string'||!part.length||part.length>max))return fail('PARTS_INVALID');
  if(parts.length===2&&parts[0]!.length!==max)return fail('PARTS_INVALID');
  const box=parts.join('');
  if(!isComputerUseRemoteBox(box,BOX_MAX_CHARS)||parts.length===2&&box.length<=max)return fail('PARTS_INVALID');
  return box;
}
/**
 * The receiver's answer body for a call: the whole box when it fits one part, else the first part with `{parts:2, ref}`;
 * `rest` is what the receiver caches for the `part` request (15 s).
 */
export function computerUseRemoteCallReplyBody(box:string,ref:string=newComputerUseRemoteId()):{body:ComputerUseRemoteCallReply;rest:string|null}{
  if(!hex32(ref))return fail('PARTS_INVALID');
  const parts=splitComputerUseRemoteBox(box);
  return parts.length===1
    ?{body:{v:COMPUTER_USE_REMOTE_VERSION,box:parts[0],parts:1},rest:null}
    :{body:{v:COMPUTER_USE_REMOTE_VERSION,box:parts[0],parts:2,ref},rest:parts[1]};
}

// ── A session's channel ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One end of one remote session. The sender (A) seals requests and opens their replies; the receiver (B) opens requests
 * and seals their replies. Sequence rules:
 * - the sender seals each seq once, strictly increasing (a repeat is NONCE_REUSE);
 * - the receiver opens strictly increasing seqs only: a replay or reordering is REPLAY, and a box that fails to open does
 *   not advance the counter (a forged row cannot burn the session);
 * - each request gets at most one sealed reply, and only a reply to a request this channel sealed or opened is accepted;
 *   the sender keeps an unopened request's reply openable for COMPUTER_USE_REMOTE_REPLY_MEMORY_MS (late answers, §7.8-6);
 * - a `part` request is not sealed and uses its call's seq (`computerUseRemotePartRequest`): it never touches a channel.
 * A channel is established once per key pair (KEY_NOT_FRESH otherwise) — see the module comment.
 */
export class ComputerUseRemoteChannel {
  private lastSealed=0;
  private lastOpened=0;
  /** Sender: seq → when it was sealed (the channel's clock). Insertion order is seq order. */
  private readonly awaitingReply=new Map<number,number>();
  /** Receiver: seqs opened and not yet answered. Insertion order is seq order, so the first is the oldest. */
  private readonly unreplied=new Set<number>();
  private constructor(readonly side:ComputerUseRemoteSide,readonly binding:ComputerUseRemoteBinding,
    private readonly sealKey:CryptoKey,private readonly openKey:CryptoKey,private readonly clock:()=>number){}

  /**
   * `privateKey` must come from `generateComputerUseRemoteKeyPair` and is taken here once, before any await and whatever the
   * result: a failed attempt (a bad peer key, say) also uses it up. `clock` (ms, default Date.now) only ages the sender's
   * unopened requests.
   */
  static async establish(input:{side:ComputerUseRemoteSide;privateKey:CryptoKey;peerPublicKey:string;binding:ComputerUseRemoteBinding;
    clock?:()=>number}):Promise<ComputerUseRemoteChannel>{
    if(input.side!=='sender'&&input.side!=='receiver')return fail('WRONG_SIDE');
    // Taken synchronously: two concurrent establish calls with one key cannot both pass.
    if(!input.privateKey||typeof input.privateKey!=='object'||!freshPrivateKeys.delete(input.privateKey))return fail('KEY_NOT_FRESH');
    const binding=normalizeComputerUseRemoteBinding(input.binding);
    let peer:CryptoKey;
    try{peer=await importRemoteControlRelayPublicKey(input.peerPublicKey);}catch{return fail('INVALID_PUBLIC_KEY');}
    const keys=await deriveDirectionKeys(input.privateKey,peer,binding,input.side);
    return new ComputerUseRemoteChannel(input.side,binding,keys.seal,keys.open,input.clock??Date.now);
  }
  /** The newest request seq the receiver authenticated (0 before the first call). */
  get lastRequestSeq(){return this.side==='receiver'?this.lastOpened:this.lastSealed;}

  private aad(h:ComputerUseRemoteSealHeader){return utf8.encode(computerUseRemoteAad(this.binding,h));}
  private async encrypt(direction:ComputerUseRemoteDirection,h:ComputerUseRemoteSealHeader,frame:Uint8Array):Promise<string>{
    try{
      return encodeComputerUseRemoteBox(new Uint8Array(await subtle().encrypt({name:'AES-GCM',iv:buffer(computerUseRemoteNonce(direction,h.seq)),
        additionalData:buffer(this.aad(h)),tagLength:GCM_TAG_BITS},this.sealKey,buffer(frame))));
    }catch{return fail('ENCRYPTION_FAILED');}
  }
  private async decrypt(direction:ComputerUseRemoteDirection,h:ComputerUseRemoteSealHeader,box:string,maxChars:number):Promise<Uint8Array>{
    const bytes=decodeComputerUseRemoteBox(box,maxChars);
    try{
      return new Uint8Array(await subtle().decrypt({name:'AES-GCM',iv:buffer(computerUseRemoteNonce(direction,h.seq)),
        additionalData:buffer(this.aad(h)),tagLength:GCM_TAG_BITS},this.openKey,buffer(bytes)));
    }catch{return fail('DECRYPTION_FAILED');}
  }

  /** Sender: seal a call, heartbeat or disconnect. The frame is at most 16,000 bytes and has no attachment. */
  async sealRequest(value:ComputerUseRemoteSealHeader,meta:Record<string,unknown>):Promise<string>{
    if(this.side!=='sender')return fail('WRONG_SIDE');
    const h=header(value);
    const frame=encodeComputerUseRemoteFrame(meta,null,COMPUTER_USE_REMOTE_LIMITS.requestFrameMaxBytes);
    if(h.seq<=this.lastSealed)return fail('NONCE_REUSE');
    // Claimed before the await: two concurrent seals of one seq cannot both pass.
    this.lastSealed=h.seq;this.awaitReply(h.seq);
    return this.encrypt('a2b',h,frame);
  }
  /** Kept by age, not by count: the late answer of a timed-out call must still open while the session remembers it. */
  private awaitReply(seq:number){
    const now=this.clock();
    for(const [old,sealedAt] of this.awaitingReply)if(now-sealedAt>COMPUTER_USE_REMOTE_REPLY_MEMORY_MS)this.awaitingReply.delete(old);
    this.awaitingReply.set(seq,now);
    while(this.awaitingReply.size>SENDER_AWAITING_MAX)this.awaitingReply.delete(this.awaitingReply.keys().next().value as number);
  }
  /** Sender: open the reply (joined from its parts) to a request this channel sealed, once. */
  async openReply(value:ComputerUseRemoteSealHeader,box:string):Promise<{meta:Record<string,unknown>;attachment:Uint8Array|null}>{
    if(this.side!=='sender')return fail('WRONG_SIDE');
    const h=header(value);
    if(!this.awaitingReply.has(h.seq))return fail('REPLAY');
    const plaintext=await this.decrypt('b2a',h,box,BOX_MAX_CHARS);
    // Settled only once it opened: a damaged part can be fetched again and the same reply opened.
    if(!this.awaitingReply.delete(h.seq))return fail('REPLAY');
    return decodeComputerUseRemoteFrame(plaintext,{maxBytes:COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES,allowAttachment:true});
  }
  /** Receiver: open a request box. Its seq must exceed every seq opened before. */
  async openRequest(value:ComputerUseRemoteSealHeader,box:string):Promise<{meta:Record<string,unknown>}>{
    if(this.side!=='receiver')return fail('WRONG_SIDE');
    const h=header(value);
    if(h.seq<=this.lastOpened)return fail('REPLAY');
    const plaintext=await this.decrypt('a2b',h,box,COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS);
    if(h.seq<=this.lastOpened)return fail('REPLAY');
    this.lastOpened=h.seq;this.unreplied.add(h.seq);
    while(this.unreplied.size>RECEIVER_UNREPLIED_MAX)this.unreplied.delete(this.unreplied.values().next().value as number);
    // Authenticated from here: a malformed frame is still a request of this seq, answered (sealed) as an error.
    const {meta}=decodeComputerUseRemoteFrame(plaintext,{maxBytes:COMPUTER_USE_REMOTE_LIMITS.requestFrameMaxBytes,allowAttachment:false});
    return {meta};
  }
  /** Receiver: seal the one reply to a request this channel opened. */
  async sealReply(value:ComputerUseRemoteSealHeader,meta:Record<string,unknown>,attachment:Uint8Array|null=null):Promise<string>{
    if(this.side!=='receiver')return fail('WRONG_SIDE');
    const h=header(value);
    if(!this.unreplied.has(h.seq))return fail('NONCE_REUSE');
    const frame=encodeComputerUseRemoteFrame(meta,attachment,COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES);
    if(!this.unreplied.delete(h.seq))return fail('NONCE_REUSE');
    return this.encrypt('b2a',h,frame);
  }
}

/** The largest sealed reply (meta 60,000 + JPEG 240,000 bytes): 400,028 characters, two parts. */
export const COMPUTER_USE_REMOTE_REPLY_BOX_MAX_CHARS=computerUseRemoteBoxChars(COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES);
