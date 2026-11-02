import {createHash} from 'node:crypto';
import {communityObject,communityBase64,communityBytes} from './communityAccessClient';
import {verifyCommunityComponentPeerProof,type CommunityComponentAuthorization,type CommunityComponentHandshake} from './communityComponentIdentity';
import {ComputerUsePeerConfirmation,computerUseAuthNonce,computerUseAuthenticatedTranscript,type ComputerUseCommunityIdentity,type AuthenticatedComputerUseHello} from './computerUseAuthenticatedHandshake';
import {AGENT_DIALOGUE_CONTROL_DETACHED} from './agentDialogueHost';
import {computerUseRemoteErrorFrame,computerUseRemoteReplyFrame} from './computerUseRemoteClient';
import {
  ComputerUseRemoteChannel,
  ComputerUseRemoteCryptoError,
  computerUseRemoteCallReplyBody,
  generateComputerUseRemoteKeyPair,
} from './computerUseRemoteCrypto';
import {
  COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES,
  COMPUTER_USE_REMOTE_ERRORS,
  COMPUTER_USE_REMOTE_LIMITS,
  ComputerUseRemoteError,
  computerUseRemoteCleanText,
  computerUseRemoteEffect,
  computerUseRemoteError,
  computerUseRemoteErrorMessage,
  computerUseRemoteNotRunMessage,
  computerUseRemoteReceiptAnswer,
  computerUseRemoteSentAtCheck,
  isComputerUseRemoteEmptyMeta,
  isComputerUseRemoteInput,
  isComputerUseRemoteStateChange,
  newComputerUseRemoteId,
  parseComputerUseRemoteCallMeta,
  parseComputerUseRemoteEnvelope,
  parseComputerUseRemoteReceipt,
  type ComputerUseRemoteEnvelope,
  type ComputerUseRemoteEnvelopeRefusal,
  type ComputerUseRemoteHello,
  type ComputerUseRemoteNotRunReason,
  type ComputerUseRemoteOutcome,
  type ComputerUseRemotePart,
  type ComputerUseRemoteReceipt,
  type ComputerUseRemoteSealedOp,
} from './computerUseRemoteProtocol';
import {remoteDeviceName,type ComputerUseRemotePeer} from './computerUseRuntime';
import type {ComputerUseRemoteRefusalCode} from './computerUseScopeProtocol';
import {COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE} from './opsRequestProtocol';

/**
 * The receiving Mac of computer use between community Macs (WP3; docs/design/remote-computer-use-2026-11-01/DESIGN.md §6,
 * §7.2-§7.9, §8.1-§8.7). Every mailbox row of kind `computer-use` that another Mac addressed to this one comes here from
 * the community executor (src/agentDialogueControl.ts), with the sending device the database recorded.
 *
 * - Receiving at all (RC-12): the caller supplies a live installed, signed Main proof and the macOS sidecar facts.
 *   This module does not read environment variables; the production wiring must verify peer identity.
 * - hello: admission (RC-2 ②③ through the runtime), the sender's platform (RC-19), four hellos a minute per device and the
 *   session table (4 per device, 16 in all). It makes this side's ephemeral key and the per-direction keys and answers
 *   `{v:1, pub, bootId}`. It does not create the runtime connection: the first scope call does (§7.2-4).
 * - call: admission again, then the box is opened (seq strictly increasing, AAD bound to the database's fromDeviceId and
 *   the connection tag). From the moment a box opened, every failure is answered inside a sealed box (RC-5) — the poll's
 *   plaintext error path only ever carries a fixed sentence written before decryption, or a content-free one.
 * - receipt, part, heartbeat and disconnect are answered at once in the poll loop. Every other call is admitted there —
 *   its input is written to the ledger as `queued` — and handed to the one execution lane of this Mac (depth 8, 4 per
 *   sending device), answered later with `respond` (the mailbox's controlRespond). The poll moves on, so a slow Control
 *   never holds up the terminal, OPS or phone rows behind it (§7.6).
 * - The lane applies RC-6 when an item starts, not when it was taken, and answers within 15 s of taking the row: an item
 *   still waiting then is not run (busy); one already running gets the execution deadline sentence (an open outcome for
 *   the sender), keeps running, and its ledger entry is settled when it ends.
 * - The ledger (RC-8, RC-16, §8.4) is keyed by (fromDeviceId, connection tag, requestId) and outlives sessions. A receipt
 *   answer always carries this boot's bootId and the connection's `evictedThroughSentAt`; an ID never seen leaves a
 *   tombstone, so the original row arriving later is never run.
 * - Content-free notices in the community room when a remote grant opens and when it has stayed closed for five minutes,
 *   one pair per sending device (RC-10, §7.9).
 *
 * Wiring (api-server, WP6): `bundled` is a live installed-main admission check; `selfDeviceId` is the community identity deviceId (the
 * inbox's to_device_id, never an endpointId); `respond`/`notice` are the mailbox's controlRespond/communityNotice; on
 * shutdown `await host.dispose()` before the mailbox stops, so waiting inputs are answered as not run. RC-14 is not
 * this module's: the general `call` path and the phone forwarding must refuse the `computer-use` kind themselves.
 */

/** What this host needs of ComputerUseRuntime (src/computerUseRuntime.ts). */
export interface ComputerUseRemoteHostRuntime {
  remote(sessionKey:string,peer:ComputerUseRemotePeer,body:Record<string,unknown>):Promise<Record<string,any>>;
  remoteAdmission(peer:{deviceId:string;instance:string}):ComputerUseRemoteRefusalCode|null|Promise<ComputerUseRemoteRefusalCode|null>;
  remoteGrants():readonly {deviceId:string;deviceName:string}[];
}
export interface ComputerUseRemoteHostTimers {
  setTimeout(callback:()=>void,ms:number):unknown;clearTimeout(handle:unknown):void;
  setInterval(callback:()=>void,ms:number):unknown;clearInterval(handle:unknown):void;
}
export interface ComputerUseRemoteHostLimits {
  sessionsPerDevice:number;sessionsTotal:number;helloPerDevicePerMinute:number;
  laneDepth:number;lanePerDevice:number;receiverAnswerMs:number;
  ledgerRetentionMs:number;ledgerPerConnection:number;
  partCacheMs:number;partCacheBytes:number;captureBytesPerMinute:number;
  noticeGroupMs:number;metaMaxBytes:number;remoteAppNameMaxChars:number;
  /** A session nothing authenticated came through for this long is forgotten (A replaces its own after 75 s of silence). */
  sessionIdleMs:number;
  tickMs:number;
}
export interface ComputerUseRemoteHostDependencies {
  runtime:ComputerUseRemoteHostRuntime;
  identity?:ComputerUseCommunityIdentity;
  /** The mailbox's controlRespond: the one answer of a row this host detached from the poll. */
  respond(controlId:string,response:Record<string,unknown>):Promise<unknown>;
  /** The mailbox's communityNotice: a content-free observation in the community room, once per requestId. */
  notice?(text:string,requestId:string):Promise<unknown>;
  /**
   * This Mac's community identity deviceId: the `to_device_id` its control inbox reads rows by, and the `receiverDeviceId`
   * the sender binds into every box's AAD. Any other value (an endpointId, another profile's device) makes every box fail
   * to open, so every call would be refused as REMOTE_BAD_REQUEST.
   */
  selfDeviceId():string|null|undefined;
  /** This Mac's name for the notices. */
  deviceName?():string|null|undefined;
  /**
   * RC-12 installed-sidecar admission. Production supplies a live verified peer check; tests inject a fact.
   */
  bundled:boolean|(()=>boolean);
  /** This Mac's platform (process.platform, passed by the caller) — RC-12. */
  platform:string;
  now?():number;
  /** Tests only: the lane deadline and the tick's timers (default the global ones, unref'd). */
  timers?:ComputerUseRemoteHostTimers;
  /** Tests only: other bounds. Production uses COMPUTER_USE_REMOTE_LIMITS. */
  limits?:Partial<ComputerUseRemoteHostLimits>;
}
export interface ComputerUseRemoteHostFrom {deviceId:string;name:string;endpointId?:string}

/** Sessions silent longer than this are forgotten: A's own session goes stale at 75 s; this adds a margin. */
export const COMPUTER_USE_REMOTE_HOST_SESSION_IDLE_MS=90_000;
export const COMPUTER_USE_REMOTE_HOST_TICK_MS=5_000;
const HELLO_WINDOW_MS=60_000;
const CAPTURE_WINDOW_MS=60_000;
/** A notice that failed is tried again after one tick, then twice as long each time, at most this long apart. */
const NOTICE_RETRY_MAX_MS=60_000;
/** An end notice stops being tried this long after it became due (a start notice is tried while its episode lasts). */
const NOTICE_END_TRY_MS=30*60_000;
/** Content-free: what the poll writes when even a sealed error could not be sealed. A sender reads it as an open outcome. */
export const COMPUTER_USE_REMOTE_HOST_SEAL_FAILED='그 Mac이 답을 봉인하지 못했습니다. 상태를 다시 읽은 뒤 정하세요.';
/** RC-8: the same connection's requestId with other content. */
export const COMPUTER_USE_REMOTE_HOST_ID_CHANGED='같은 요청 ID의 내용이 달라졌습니다. 실행하지 않았습니다. observe로 화면을 본 뒤 새 requestId로 보내세요.';
/** RC-17 (D11): the price of remote pointer input, said where remote use starts. */
const NOTICE_POINTER_RISK='다른 Mac의 AI의 포인터 동작이 결과 불명이나 사람 개입으로 끝나면, 사람이 이 Mac에서 검토할 때까지 이 Mac의 AI 컴퓨터 유즈 전체가 멈춥니다.';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID=/^[A-Za-z0-9_-]{8,128}$/;
const ACTUAL=COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES as readonly string[];
const utf8=new TextEncoder();
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const refusal=(code:ComputerUseRemoteEnvelopeRefusal)=>new ComputerUseRemoteError(code);
const errorCode=(error:unknown)=>error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:'';
/** What an open outcome means for this operation (§7.8-1): never better than its effect allows. */
const openOutcome=(operation:unknown):ComputerUseRemoteOutcome=>{
  const effect=computerUseRemoteEffect(operation);
  return effect==='read'?'read':effect==='state-change'?'state-unknown':'unknown';
};
const notRunFrame=(reason:ComputerUseRemoteNotRunReason)=>computerUseRemoteErrorFrame(computerUseRemoteNotRunMessage(reason),'not-run','REMOTE_NOT_RUN');
/** One canonical text of a request (keys sorted at every level), hashed: the ledger's fingerprint. */
function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(plain(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const fingerprintOf=(request:Record<string,unknown>)=>createHash('sha256').update(canonical(request)).digest('hex');
/** A receipt reason is `[a-z-]{1,60}` (the sender's closed parser): a refusal code becomes its kebab form. */
function refusedReason(error:unknown){
  const reason=errorCode(error).toLowerCase().replace(/_/g,'-');
  return /^[a-z-]{1,60}$/.test(reason)?reason:'not-dispatched';
}

interface Session {
  key:string;id:string;deviceId:string;deviceName:string;tag:string;channel:ComputerUseRemoteChannel;
  helloSentAt:number;openedAt:number;lastSeenAt:number;client?:string;host?:string;ended:boolean;
  authentication?:{ownHash:string;peerHash:string;expiresAt:number};
}
interface PendingAuthenticatedHello {hello:AuthenticatedComputerUseHello;own:CommunityComponentAuthorization;peer:CommunityComponentAuthorization;
 keyPair:CryptoKeyPair;transcript:CommunityComponentHandshake;confirmation:ComputerUsePeerConfirmation;expiresAt:number;deviceId:string;name:string}
type LedgerState='queued'|'running'|'settled'|'tombstone';
interface LedgerEntry {
  fingerprint:string|null;sentAt:number;receivedAt:number;settledAt?:number;state:LedgerState;
  receipt?:ComputerUseRemoteReceipt;owner?:'human'|'person'|'agent';guidance?:string;
}
interface Ledger {entries:Map<string,LedgerEntry>;evictedThroughSentAt:number|null;touchedAt:number}
interface LaneItem {
  session:Session;header:{op:'call';seq:number;sentAt:number};request:Record<string,unknown>;operation:string;
  requestId?:string;ledger?:Ledger;controlId:string;takenAt:number;deviceId:string;
  state:'queued'|'running'|'done';answered:boolean;dispatched:boolean;timer?:unknown;
}
interface PartEntry {tag:string;ref:string;rest:string;expiresAt:number;at:number}
interface Episode {
  id:string;deviceId:string;deviceName:string;startedAt:number;closedAt:number|null;actions:number;
  startPosted:boolean;startTries:number;startNextAt:number;posting:boolean;
}
interface Ending {episode:Episode;endedAt:number;tries:number;nextAt:number;giveUpAt:number;posting:boolean}

const defaultTimers:ComputerUseRemoteHostTimers={
  setTimeout:(callback,ms)=>{const handle=setTimeout(callback,ms);(handle as {unref?:()=>void}).unref?.();return handle;},
  clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval:(callback,ms)=>{const handle=setInterval(callback,ms);(handle as {unref?:()=>void}).unref?.();return handle;},
  clearInterval:handle=>clearInterval(handle as ReturnType<typeof setInterval>),
};

export class ComputerUseRemoteHost {
  /** This sidecar's boot: 128 bits, new on every start (§8.4). Every hello and receipt answer carries it. */
  readonly bootId=newComputerUseRemoteId();
  private readonly limits:ComputerUseRemoteHostLimits;
  private readonly timers:ComputerUseRemoteHostTimers;
  private readonly now:()=>number;
  private readonly sessions=new Map<string,Session>();
  private readonly authenticatedPending=new Map<string,PendingAuthenticatedHello>();
  private readonly ledgers=new Map<string,Ledger>();
  private readonly hellos=new Map<string,number[]>();
  private readonly parts=new Map<string,PartEntry>();
  private partBytes=0;
  private captures:{at:number;chars:number}[]=[];
  private readonly lane:LaneItem[]=[];
  private pumping=false;
  private readonly episodes=new Map<string,Episode>();
  private endings:Ending[]=[];
  private interval:unknown=null;
  private disposed=false;

  constructor(private readonly deps:ComputerUseRemoteHostDependencies){
    const L=COMPUTER_USE_REMOTE_LIMITS;
    this.limits={sessionsPerDevice:L.sessionsPerDevice,sessionsTotal:L.sessionsTotal,helloPerDevicePerMinute:L.helloPerDevicePerMinute,
      laneDepth:L.laneDepth,lanePerDevice:L.lanePerDevice,receiverAnswerMs:L.receiverAnswerMs,ledgerRetentionMs:L.ledgerRetentionMs,
      ledgerPerConnection:L.ledgerPerConnection,partCacheMs:L.partCacheMs,partCacheBytes:L.partCacheBytes,captureBytesPerMinute:L.captureBytesPerMinute,
      noticeGroupMs:L.noticeGroupMs,metaMaxBytes:L.metaMaxBytes,remoteAppNameMaxChars:L.remoteAppNameMaxChars,
      sessionIdleMs:COMPUTER_USE_REMOTE_HOST_SESSION_IDLE_MS,tickMs:COMPUTER_USE_REMOTE_HOST_TICK_MS,...deps.limits};
    this.timers=deps.timers??defaultTimers;
    this.now=deps.now??Date.now;
  }

  /** RC-12: the bundled sidecar on macOS, and nothing else. */
  get receiving(){
    if(this.disposed||this.deps.platform!=='darwin')return false;
    try{return (typeof this.deps.bundled==='function'?this.deps.bundled():this.deps.bundled)===true;}catch{return false;}
  }

  /**
   * One mailbox row of kind `computer-use`. Returns the answer body, or AGENT_DIALOGUE_CONTROL_DETACHED for a call handed
   * to the lane (answered later through `respond`). A refusal before decryption is thrown as its fixed sentence.
   */
  async execute(request:Record<string,unknown>,from:ComputerUseRemoteHostFrom,controlId:string):Promise<Record<string,unknown>|typeof AGENT_DIALOGUE_CONTROL_DETACHED>{
    const takenAt=this.now();
    if(!this.receiving)throw refusal('REMOTE_UNSUPPORTED');
    const self=this.selfDeviceId();
    if(!self)throw refusal('REMOTE_UNSUPPORTED');
    const sender=typeof from?.deviceId==='string'&&UUID.test(from.deviceId)?from.deviceId.toLowerCase():'';
    if(!sender||sender===self||typeof controlId!=='string'||!UUID.test(controlId))throw refusal('REMOTE_BAD_REQUEST');
    if(request.v===2){
      if(!this.deps.identity)throw refusal('REMOTE_UNSUPPORTED');
      if(request.op==='hello')return this.authenticatedHello(request,from,sender,self);
      if(request.op==='confirm')return this.authenticatedConfirm(request,sender);
      throw refusal('REMOTE_BAD_REQUEST');
    }
    if(this.deps.identity&&request.op==='hello')throw refusal('REMOTE_UNSUPPORTED');
    let envelope:ComputerUseRemoteEnvelope;
    try{envelope=parseComputerUseRemoteEnvelope(request);}catch{throw refusal('REMOTE_BAD_REQUEST');}
    const deviceId=typeof from?.deviceId==='string'&&UUID.test(from.deviceId)?from.deviceId.toLowerCase():'';
    if(!deviceId||deviceId===self||typeof controlId!=='string'||!UUID.test(controlId))throw refusal('REMOTE_BAD_REQUEST');
    this.ensureTick();
    if(envelope.op==='hello')return this.hello(envelope,from,deviceId,self);
    if(envelope.op==='part')return this.part(envelope,deviceId);
    const session=this.sessions.get(sessionKey(deviceId,envelope.session));
    if(!session)throw refusal('REMOTE_SESSION_MISSING');
    if(this.deps.identity&&envelope.op!=='disconnect'){
      const authenticated=session.authentication;if(!authenticated)throw refusal('REMOTE_BAD_REQUEST');
      if(authenticated.expiresAt<=this.now()+30_000){
        try{
          const own=await this.deps.identity.currentAuthorization('agent'),peers=await this.deps.identity.directory('agent'),peer=peers.find(p=>p.body.agentDeviceId===session.deviceId);
          if(!peer||own.body.agentDeviceId!==self||own.policyDigest!==authenticated.ownHash||peer.policyDigest!==authenticated.peerHash)throw Error('identity changed');
          authenticated.expiresAt=Math.min(own.body.expiresAt,peer.body.expiresAt);
        }catch{this.endSession(session,true);throw refusal('REMOTE_BAD_REQUEST');}
      }
    }
    // Ending is always allowed; everything else is admitted again on every row (RC-2), before anything is opened.
    if(envelope.op!=='disconnect'){
      const code=await this.admission(deviceId,session.tag);
      if(code){this.endSession(session,true);throw refusal(code);}
    }
    const header={op:envelope.op,seq:envelope.seq,sentAt:envelope.sentAt} as {op:ComputerUseRemoteSealedOp;seq:number;sentAt:number};
    let meta:Record<string,unknown>;
    try{meta=(await session.channel.openRequest(header,envelope.box)).meta;}
    catch(error){
      // A box that opened but whose frame is malformed was authenticated (its seq is spent): answered inside a box.
      if(error instanceof ComputerUseRemoteCryptoError&&error.code==='FRAME_INVALID'&&session.channel.lastRequestSeq===envelope.seq){
        session.lastSeenAt=this.now();
        return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'not-run','REMOTE_BAD_REQUEST'));
      }
      throw refusal('REMOTE_BAD_REQUEST');
    }
    session.lastSeenAt=this.now();
    // From here every failure stays inside the box (RC-5).
    try{
      if(header.op==='heartbeat')return await this.heartbeat(session,header,meta);
      if(header.op==='disconnect')return await this.disconnect(session,header,meta);
      return await this.call(session,header as LaneItem['header'],meta,controlId,takenAt);
    }catch(error){
      const operation=header.op==='call'&&plain(meta)&&typeof meta.operation==='string'?meta.operation:header.op;
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message,
        header.op==='call'?openOutcome(operation):'read'));
    }
  }

  /** Housekeeping (the host's own timer runs it every 5 s while anything is held): expiry, pruning and notices. */
  async tick():Promise<void>{
    if(this.disposed)return;
    const now=this.now();
    for(const session of [...this.sessions.values()])if(now-session.lastSeenAt>=this.limits.sessionIdleMs)this.endSession(session,true);
    for(const [key,pending] of this.authenticatedPending)if(pending.expiresAt<=now)this.authenticatedPending.delete(key);
    this.expireParts(now);
    for(const [key,ledger] of this.ledgers){
      this.prune(ledger);
      const [deviceId,tag]=key.split('\0');
      const inUse=[...this.sessions.values()].some(session=>session.deviceId===deviceId&&session.tag===tag);
      if(!ledger.entries.size&&!inUse&&now-ledger.touchedAt>=this.limits.ledgerRetentionMs)this.ledgers.delete(key);
    }
    for(const [deviceId,times] of this.hellos){
      const recent=times.filter(at=>now-at<HELLO_WINDOW_MS);
      if(recent.length)this.hellos.set(deviceId,recent);else this.hellos.delete(deviceId);
    }
    this.captures=this.captures.filter(item=>now-item.at<CAPTURE_WINDOW_MS);
    await this.notices();
    if(!this.sessions.size&&!this.ledgers.size&&!this.lane.length&&!this.parts.size&&!this.episodes.size&&!this.endings.length&&!this.hellos.size)this.stopTick();
  }

  /**
   * Stops receiving (the sidecar is shutting down). Nothing more starts: every input still waiting in the lane is settled
   * as not run (receiver-off) and its row answered so, inside its box — the sender learns at once that it never ran,
   * instead of reading the mailbox's execution-deadline sentence as an open outcome. One already running keeps its own
   * deadline and is answered when it ends. Resolves when those not-run answers were handed to the mailbox.
   */
  dispose():Promise<void>{
    this.disposed=true;
    this.authenticatedPending.clear();
    this.stopTick();
    const waiting=this.lane.filter(item=>item.state==='queued');
    for(const item of waiting){item.state='done';this.removeItem(item);}
    return Promise.all(waiting.map(item=>this.notRun(item,'receiver-off'))).then(()=>undefined);
  }

  // ── hello and part ──────────────────────────────────────────────────────────────────────────────────────────────
  private async authenticatedHello(value:Record<string,unknown>,from:ComputerUseRemoteHostFrom,deviceId:string,self:string):Promise<Record<string,unknown>>{
    const input=communityObject(value,['kind','v','op','session','seq','sentAt','pub','instance','platform','nonce','authorization','expectedReceiver']);
    if(input.kind!=='computer-use'||input.v!==2||input.op!=='hello'||input.seq!==0||input.platform!=='darwin'
      ||typeof input.session!=='string'||!/^[0-9a-f]{32}$/.test(input.session)||typeof input.instance!=='string'||!/^[0-9a-f]{32}$/.test(input.instance)
      ||!Number.isSafeInteger(input.sentAt)||Math.abs(this.now()-Number(input.sentAt))>60_000||communityBytes(input.nonce,32).length!==32)throw refusal('REMOTE_BAD_REQUEST');
    const key=sessionKey(deviceId,input.session),recent=(this.hellos.get(deviceId)??[]).filter(at=>this.now()-at<HELLO_WINDOW_MS);
    if(recent.length>=this.limits.helloPerDevicePerMinute||this.authenticatedPending.size>=32||this.authenticatedPending.has(key))throw refusal('REMOTE_RATE_LIMITED');
    recent.push(this.now());this.hellos.set(deviceId,recent);this.ensureTick();
    const identity=this.deps.identity!,own=await identity.currentAuthorization('agent'),peer=await identity.verifyAuthorization(input.authorization as any);
    if(own.body.agentDeviceId!==self||peer.body.agentDeviceId!==deviceId||input.expectedReceiver!==own.body.deviceId||!peer.permits('agent',this.now()))throw refusal('REMOTE_BAD_REQUEST');
    const peers=await identity.directory('agent'),pinned=peers.find(p=>p.body.deviceId===peer.body.deviceId);
    if(!pinned||pinned.policyDigest!==peer.policyDigest)throw refusal('REMOTE_BAD_REQUEST');
    const pair=await generateComputerUseRemoteKeyPair(),nonce=computerUseAuthNonce(),hello=input as unknown as AuthenticatedComputerUseHello;
    const transcript=computerUseAuthenticatedTranscript({sender:peer,receiver:own,hello,reply:{pub:pair.publicKey,bootId:this.bootId,nonce}});
    const proof=await identity.signHandshake('agent','receiver',transcript,own,peer),confirmation=await ComputerUsePeerConfirmation.create(transcript,'receiver',pair.keyPair.privateKey);
    if(this.disposed||!this.receiving||!own.permits('agent',this.now())||!peer.permits('agent',this.now())||this.authenticatedPending.has(key))throw refusal('REMOTE_BAD_REQUEST');
    this.authenticatedPending.set(key,{hello,own,peer,keyPair:pair.keyPair,transcript,confirmation,expiresAt:Math.min(this.now()+30_000,own.body.expiresAt,peer.body.expiresAt),deviceId,name:computerUseRemoteCleanText(from.name,200)});
    return {v:2,pub:pair.publicKey,bootId:this.bootId,nonce,authorization:own.envelope,proof:communityBase64(proof),confirmation:await confirmation.proof()};
  }
  private async authenticatedConfirm(value:Record<string,unknown>,deviceId:string):Promise<Record<string,unknown>>{
    const input=communityObject(value,['kind','v','op','session','seq','sentAt','proof','confirmation']);
    if(input.kind!=='computer-use'||input.v!==2||input.op!=='confirm'||input.seq!==0||typeof input.session!=='string'
      ||!Number.isSafeInteger(input.sentAt)||Math.abs(this.now()-Number(input.sentAt))>60_000||typeof input.proof!=='string')throw refusal('REMOTE_BAD_REQUEST');
    const key=sessionKey(deviceId,input.session),pending=this.authenticatedPending.get(key);this.authenticatedPending.delete(key);
    if(!pending||pending.expiresAt<=this.now()||!pending.own.permits('agent',this.now())||!pending.peer.permits('agent',this.now()))throw refusal('REMOTE_BAD_REQUEST');
    if(!await verifyCommunityComponentPeerProof(pending.transcript,'sender',pending.peer,input.proof,this.now()))throw refusal('REMOTE_BAD_REQUEST');
    await pending.confirmation.verify(input.confirmation);
    const code=await this.admission(deviceId,pending.hello.instance);if(code)throw refusal(code);
    const channel=await ComputerUseRemoteChannel.establish({side:'receiver',privateKey:pending.keyPair.privateKey,peerPublicKey:pending.hello.pub,clock:this.now,
      binding:{session:pending.hello.session,senderDeviceId:deviceId,receiverDeviceId:pending.own.body.agentDeviceId,instance:pending.hello.instance,platform:'darwin',authenticationHash:pending.confirmation.transcriptHash}});
    if(this.disposed||!this.receiving||pending.expiresAt<=this.now()||this.sessions.has(key))throw refusal('REMOTE_BAD_REQUEST');
    for(const old of [...this.sessions.values()])if(old.deviceId===deviceId&&old.tag===pending.hello.instance&&old.helloSentAt<=pending.hello.sentAt)this.endSession(old,true);
    if([...this.sessions.values()].filter(s=>s.deviceId===deviceId).length>=this.limits.sessionsPerDevice||this.sessions.size>=this.limits.sessionsTotal)throw refusal('REMOTE_RATE_LIMITED');
    const now=this.now();this.sessions.set(key,{key,id:pending.hello.session,deviceId,deviceName:pending.name,tag:pending.hello.instance,channel,helloSentAt:pending.hello.sentAt,openedAt:now,lastSeenAt:now,ended:false,
      authentication:{ownHash:pending.own.policyDigest,peerHash:pending.peer.policyDigest,expiresAt:Math.min(pending.own.body.expiresAt,pending.peer.body.expiresAt)}});
    return {v:2,session:pending.hello.session,bootId:this.bootId,confirmation:await pending.confirmation.proof(true)};
  }
  private async hello(envelope:ComputerUseRemoteHello,from:ComputerUseRemoteHostFrom,deviceId:string,self:string):Promise<Record<string,unknown>>{
    if(envelope.platform!=='darwin')throw refusal('REMOTE_SENDER_UNSUPPORTED');
    const code=await this.admission(deviceId,envelope.instance);
    if(code)throw refusal(code);
    const now=this.now();
    const recent=(this.hellos.get(deviceId)??[]).filter(at=>now-at<HELLO_WINDOW_MS);
    if(recent.length>=this.limits.helloPerDevicePerMinute){this.hellos.set(deviceId,recent);throw refusal('REMOTE_RATE_LIMITED');}
    recent.push(now);this.hellos.set(deviceId,recent);
    const key=sessionKey(deviceId,envelope.session);
    if(this.sessions.has(key))throw refusal('REMOTE_BAD_REQUEST');
    let channel:ComputerUseRemoteChannel,publicKey:string;
    try{
      const pair=await generateComputerUseRemoteKeyPair();
      publicKey=pair.publicKey;
      channel=await ComputerUseRemoteChannel.establish({side:'receiver',privateKey:pair.keyPair.privateKey,peerPublicKey:envelope.pub,clock:this.now,
        binding:{session:envelope.session,senderDeviceId:deviceId,receiverDeviceId:self,instance:envelope.instance,platform:envelope.platform}});
    }catch{throw refusal('REMOTE_BAD_REQUEST');}
    if(this.sessions.has(key))throw refusal('REMOTE_BAD_REQUEST');
    // A new hello of the same connection replaces its older sessions (A gave them up), so the new session can be granted at
    // once instead of waiting for the old grant's idle hand-over. A hello older than a session it would replace is not
    // allowed to end it.
    for(const old of [...this.sessions.values()])
      if(old.deviceId===deviceId&&old.tag===envelope.instance&&old.helloSentAt<=envelope.sentAt)this.endSession(old,true);
    const mine=[...this.sessions.values()].filter(session=>session.deviceId===deviceId).length;
    if(mine>=this.limits.sessionsPerDevice||this.sessions.size>=this.limits.sessionsTotal)throw refusal('REMOTE_RATE_LIMITED');
    const name=computerUseRemoteCleanText(typeof from.name==='string'?from.name:'',200);
    this.sessions.set(key,{key,id:envelope.session,deviceId,deviceName:name,tag:envelope.instance,channel,helloSentAt:envelope.sentAt,
      openedAt:now,lastSeenAt:now,ended:false});
    return {v:1,pub:publicKey,bootId:this.bootId};
  }
  /** The rest of a call's split reply (§7.4): served while cached (15 s), only for the exact session, seq and ref. */
  private async part(envelope:ComputerUseRemotePart,deviceId:string):Promise<Record<string,unknown>>{
    this.expireParts(this.now());
    const cached=this.parts.get(partKey(deviceId,envelope.session,envelope.seq));
    if(!cached||cached.ref!==envelope.ref)throw refusal('REMOTE_PART_LOST');
    const code=await this.admission(deviceId,cached.tag);
    if(code)throw refusal(code);
    return {v:1,box:cached.rest};
  }

  // ── Sealed rows answered in the poll ────────────────────────────────────────────────────────────────────────────
  private async heartbeat(session:Session,header:{op:ComputerUseRemoteSealedOp;seq:number;sentAt:number},meta:Record<string,unknown>){
    if(!isComputerUseRemoteEmptyMeta(meta))
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'read','REMOTE_BAD_REQUEST'));
    let result:Record<string,any>;
    try{result=await this.deps.runtime.remote(session.id,this.peer(session),{operation:'heartbeat'});}
    catch(error){
      if(this.endsSession(error))this.endSession(session,false);
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(error,'read'));
    }
    return this.sealedBody(session,header,{success:true,active:result?.active===true});
  }
  private async disconnect(session:Session,header:{op:ComputerUseRemoteSealedOp;seq:number;sentAt:number},meta:Record<string,unknown>){
    if(!isComputerUseRemoteEmptyMeta(meta))
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'not-run','REMOTE_BAD_REQUEST'));
    // This can have taken effect even when the runtime fails to answer. Close the transport and report the state as
    // unknown, without an automatic retry. The runtime's own lease is still responsible for any remaining cleanup.
    let accepted=false;
    try{accepted=(await this.deps.runtime.remote(session.id,this.peer(session),{operation:'disconnect'}))?.success===true;}catch{}
    this.endSession(session,false);
    if(!accepted)return this.sealedBody(session,header,computerUseRemoteErrorFrame(
      '그 Mac의 연결 정리 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않았습니다.','state-unknown','REMOTE_DISCONNECT_UNKNOWN'));
    // This acknowledges only that the runtime accepted the request, not completion of the native grant retirement.
    return this.sealedBody(session,header,{success:true});
  }

  // ── Calls ───────────────────────────────────────────────────────────────────────────────────────────────────────
  private async call(session:Session,header:LaneItem['header'],meta:Record<string,unknown>,controlId:string,takenAt:number)
    :Promise<Record<string,unknown>|typeof AGENT_DIALOGUE_CONTROL_DETACHED>{
    let request:Record<string,unknown>&{operation:string};
    try{
      const parsed=parseComputerUseRemoteCallMeta(meta);
      request=parsed.request;
      if(parsed.client)session.client=parsed.client;
      if(parsed.host)session.host=parsed.host;
    }catch{
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'not-run','REMOTE_BAD_REQUEST'));
    }
    const operation=request.operation;
    if(operation==='scope-receipt')return this.receipt(session,header,request);
    let requestId:string|undefined,ledger:Ledger|undefined,fingerprint:string|undefined;
    if(isComputerUseRemoteInput(operation)){
      if(typeof request.requestId!=='string'||!REQUEST_ID.test(request.requestId))
        return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'not-run','REMOTE_BAD_REQUEST'));
      requestId=request.requestId;
      ledger=this.ledgerOf(session.deviceId,session.tag);
      this.prune(ledger);
      fingerprint=fingerprintOf(request);
      const prior=ledger.entries.get(requestId);
      if(prior)return this.duplicate(session,header,requestId,prior,fingerprint);
    }
    // The lane: one for this Mac (Control serves one request at a time), depth 8, four per sending device.
    if(this.lane.length>=this.limits.laneDepth||this.lane.filter(item=>item.deviceId===session.deviceId).length>=this.limits.lanePerDevice){
      if(ledger&&requestId)this.record(ledger,requestId,{fingerprint:fingerprint!,sentAt:header.sentAt,receivedAt:this.now(),settledAt:this.now(),state:'settled',
        receipt:{requestId,state:'not-run',reason:'busy'}});
      return this.sealedBody(session,header,notRunFrame('busy'));
    }
    // Written as the row is admitted, in the poll's order: a receipt asked later finds it (§7.8-3).
    if(ledger&&requestId)this.record(ledger,requestId,{fingerprint:fingerprint!,sentAt:header.sentAt,receivedAt:this.now(),state:'queued'});
    const item:LaneItem={session,header,request,operation,...(requestId?{requestId}:{}),...(ledger?{ledger}:{}),controlId,takenAt,
      deviceId:session.deviceId,state:'queued',answered:false,dispatched:false};
    this.lane.push(item);
    item.timer=this.timers.setTimeout(()=>this.deadline(item),Math.max(0,takenAt+this.limits.receiverAnswerMs-this.now()));
    void this.pump();
    return AGENT_DIALOGUE_CONTROL_DETACHED;
  }
  /** The same connection's requestId again (RC-8): never run twice; another connection's ID is another ledger. */
  private duplicate(session:Session,header:LaneItem['header'],requestId:string,prior:LedgerEntry,fingerprint:string){
    // An ID a receipt already answered as unseen: the original row arrived late and is never run (RC-16).
    if(prior.state==='tombstone')return this.sealedBody(session,header,notRunFrame('stale'));
    // Still waiting or running: its outcome is not known yet, so this row cannot say it did not run.
    if(prior.state==='queued'||prior.state==='running')
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId}),'unknown','REMOTE_UNKNOWN_OUTCOME'));
    if(prior.fingerprint!==fingerprint)return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_HOST_ID_CHANGED,'not-run','REMOTE_BAD_REQUEST'));
    const receipt=prior.receipt!;
    if(receipt.state==='not-run')return this.sealedBody(session,header,notRunFrame(receipt.reason as ComputerUseRemoteNotRunReason));
    return this.sealedBody(session,header,{success:true,receipt:{...receipt},...(prior.owner?{owner:prior.owner}:{}),...(prior.guidance?{guidance:prior.guidance}:{})});
  }
  /**
   * §7.8-4, answered in the poll: ledger → ScopeHost's receipt for this session's grant (when the request names it) →
   * unseen, which leaves a tombstone. Always with this boot's bootId and the connection's evictedThroughSentAt.
   */
  private async receipt(session:Session,header:LaneItem['header'],request:Record<string,unknown>){
    const requestId=request.requestId;
    if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))
      return this.sealedBody(session,header,computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message,'read','REMOTE_BAD_REQUEST'));
    const ledger=this.ledgerOf(session.deviceId,session.tag);
    this.prune(ledger);
    const entry=ledger.entries.get(requestId);
    let receipt:ComputerUseRemoteReceipt|null=null,owner:LedgerEntry['owner'],guidance:string|undefined;
    if(entry){
      if(entry.state==='queued'||entry.state==='running')receipt={requestId,state:'in-progress'};
      else if(entry.state==='tombstone')receipt={requestId,state:'unseen'};
      else{receipt={...entry.receipt!};owner=entry.owner;guidance=entry.guidance;}
    }else if(typeof request.grant==='string'&&Number.isSafeInteger(request.epoch)){
      try{
        const found=await this.deps.runtime.remote(session.id,this.peer(session),{operation:'scope-receipt',grant:request.grant,epoch:request.epoch,requestId});
        const parsed=parseComputerUseRemoteReceipt(found?.receipt);
        if(parsed&&parsed.requestId===requestId&&(ACTUAL.includes(parsed.state)||parsed.state==='evicted')){
          receipt=parsed;
          if(['human','person','agent'].includes(found.owner))owner=found.owner;
          if(typeof found.guidance==='string')guidance=computerUseRemoteCleanText(found.guidance,1000)||undefined;
        }
      }catch{}
    }
    if(!receipt){
      receipt={requestId,state:'unseen'};
      this.record(ledger,requestId,{fingerprint:null,sentAt:header.sentAt,receivedAt:this.now(),state:'tombstone'});
    }
    const answer=computerUseRemoteReceiptAnswer({success:true,bootId:this.bootId,evictedThroughSentAt:ledger.evictedThroughSentAt,receipt,
      ...(owner?{owner}:{}),...(guidance?{guidance}:{})});
    return this.sealedBody(session,header,answer as unknown as Record<string,unknown>);
  }

  // ── The lane ────────────────────────────────────────────────────────────────────────────────────────────────────
  private async pump(){
    if(this.pumping)return;
    this.pumping=true;
    try{
      for(let item=this.lane.find(entry=>entry.state==='queued');item;item=this.lane.find(entry=>entry.state==='queued')){
        await this.run(item);
        this.removeItem(item);
      }
    }finally{this.pumping=false;}
  }
  private removeItem(item:LaneItem){
    const index=this.lane.indexOf(item);
    if(index>=0)this.lane.splice(index,1);
    if(item.timer!==undefined){this.timers.clearTimeout(item.timer);item.timer=undefined;}
  }
  /** 15 s after the row was taken: not started is not run (busy); running gets the deadline sentence and keeps going. */
  private deadline(item:LaneItem){
    item.timer=undefined;
    if(item.answered)return;
    if(item.state==='queued'){
      item.state='done';
      this.removeItem(item);
      void this.notRun(item,'busy');
      return;
    }
    if(item.state==='running'){item.answered=true;void this.deliver(item.controlId,{ok:false,error:COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE});}
  }
  private async run(item:LaneItem){
    if(item.state!=='queued')return;
    item.state='running';
    try{
      const {session}=item;
      // Receiving stopped (dispose) while this item waited: it never starts.
      if(this.disposed)return await this.notRun(item,'receiver-off');
      // The answer is due 15 s after the row was taken, on this Mac's clock too.
      if(this.now()-item.takenAt>=this.limits.receiverAnswerMs)return await this.notRun(item,'busy');
      if(session.ended||this.sessions.get(session.key)!==session)return await this.notRun(item,'session-ended');
      // RC-6 at the moment execution starts.
      if(isComputerUseRemoteStateChange(item.operation)){
        const check=computerUseRemoteSentAtCheck(item.header.sentAt,this.now());
        if(check!=='ok')return await this.notRun(item,check);
      }
      const code=await this.admission(session.deviceId,session.tag);
      if(code){
        this.endSession(session,true);
        return await this.notRun(item,code==='REMOTE_DEVICE_BLOCKED'?'blocked':'receiver-off',computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS[code].message,'not-run',code));
      }
      const capture=item.operation==='scope-capture'||item.operation==='scope-observe'&&item.request.capture===true;
      if(capture&&this.captureUsed()>=this.limits.captureBytesPerMinute)
        return await this.finish(item,computerUseRemoteErrorFrame(computerUseRemoteError('REMOTE_RATE_LIMITED'),'not-run','REMOTE_RATE_LIMITED'));
      const entry=item.requestId?item.ledger?.entries.get(item.requestId):undefined;
      if(entry)entry.state='running';
      let result:Record<string,any>;
      item.dispatched=true;
      try{result=await this.deps.runtime.remote(session.id,this.peer(session),item.request);}
      catch(error){
        // Every runtime and ScopeHost refusal is raised before anything reached Control: not run.
        const code=errorCode(error);
        if(this.endsSession(error))this.endSession(session,true);
        if(entry){
          if(code==='REMOTE_BLOCKED_BY_PERSON'||code==='REMOTE_UNSUPPORTED')this.settle(item,{requestId:item.requestId!,state:'not-run',reason:'receiver-off'});
          else if(code==='REMOTE_DEVICE_BLOCKED')this.settle(item,{requestId:item.requestId!,state:'not-run',reason:'blocked'});
          else this.settle(item,{requestId:item.requestId!,state:'refused',reason:refusedReason(error)});
        }
        return await this.finish(item,computerUseRemoteErrorFrame(error,'not-run'));
      }
      if(!plain(result)||result.success===false){
        if(item.requestId)this.settle(item,{requestId:item.requestId,state:'unknown'});
        return await this.finish(item,computerUseRemoteErrorFrame(plain(result)&&typeof result.error==='string'?result.error:COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message,openOutcome(item.operation)));
      }
      let minimal:Record<string,unknown>|null=null;
      if(item.requestId){
        const parsed=parseComputerUseRemoteReceipt(result.receipt);
        // `evicted`: ScopeHost already spent this ID for the grant and dropped its receipt, so it did not run it again. The
        // ledger keeps exactly that (as the receipt answer allows), never a vaguer `unknown` that contradicts this reply.
        const receipt:ComputerUseRemoteReceipt=parsed&&parsed.requestId===item.requestId&&(ACTUAL.includes(parsed.state)||parsed.state==='evicted')
          ?parsed:{requestId:item.requestId,state:'unknown'};
        const owner=typeof result.owner==='string'&&['human','person','agent'].includes(result.owner)?result.owner as LedgerEntry['owner']:undefined;
        const guidance=typeof result.guidance==='string'?computerUseRemoteCleanText(result.guidance,1000)||undefined:undefined;
        this.settle(item,receipt,owner,guidance);
        if(receipt.state!=='evicted')this.countAction(session.deviceId);
        minimal={success:true,receipt:{...receipt},...(owner?{owner}:{}),...(guidance?{guidance}:{})};
      }
      let frame:{meta:Record<string,unknown>;attachment:Uint8Array|null};
      try{
        // §7.4: a remote reply's meta stays under 60 KB. App names are cut to 80 characters; if it is still over, the names
        // of apps other than the foreground one are left out (this Mac keeps the whole set, so focus-app is judged the same).
        const cut=cutAppNames(result,this.limits.remoteAppNameMaxChars);
        frame=computerUseRemoteReplyFrame(cut);
        if(utf8.encode(JSON.stringify(frame.meta)).byteLength>this.limits.metaMaxBytes)frame=computerUseRemoteReplyFrame(withoutBackgroundAppNames(cut));
      }catch{frame={meta:minimal??computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message,openOutcome(item.operation)),attachment:null};}
      await this.finish(item,frame.meta,frame.attachment,
        minimal??computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message,openOutcome(item.operation)),capture);
    }catch{
      // Only a bug of this host gets here. Nothing is left running in the ledger, and the row gets an answer.
      const entry=item.requestId?item.ledger?.entries.get(item.requestId):undefined;
      if(entry&&(entry.state==='queued'||entry.state==='running'))
        this.settle(item,item.dispatched?{requestId:item.requestId!,state:'unknown'}:{requestId:item.requestId!,state:'not-run',reason:'busy'});
      if(!item.answered){item.answered=true;await this.deliver(item.controlId,{ok:false,error:COMPUTER_USE_REMOTE_HOST_SEAL_FAILED});}
    }finally{
      item.state='done';
      void this.notices();
    }
  }
  /** Not run, certainly: the ledger says why and the sender hears it inside the box. */
  private async notRun(item:LaneItem,reason:ComputerUseRemoteNotRunReason,frame?:Record<string,unknown>){
    if(item.requestId)this.settle(item,{requestId:item.requestId,state:'not-run',reason});
    await this.finish(item,frame??notRunFrame(reason));
  }
  private settle(item:LaneItem,receipt:ComputerUseRemoteReceipt,owner?:LedgerEntry['owner'],guidance?:string){
    const entry=item.requestId?item.ledger?.entries.get(item.requestId):undefined;
    if(!entry)return;
    entry.state='settled';entry.settledAt=this.now();entry.receipt=receipt;
    if(owner)entry.owner=owner;else delete entry.owner;
    if(guidance)entry.guidance=guidance;else delete entry.guidance;
  }
  /** Seal the item's reply and answer its row, once. `fallback` replaces a reply too large to seal. */
  private async finish(item:LaneItem,meta:Record<string,unknown>,attachment:Uint8Array|null=null,fallback?:Record<string,unknown>,capture=false){
    if(item.answered)return;
    const body=await this.sealCall(item.session,item.header,meta,attachment,fallback,capture);
    if(item.answered)return;
    item.answered=true;
    if(item.timer!==undefined){this.timers.clearTimeout(item.timer);item.timer=undefined;}
    await this.deliver(item.controlId,body?{ok:true,body}:{ok:false,error:COMPUTER_USE_REMOTE_HOST_SEAL_FAILED});
  }
  private async deliver(controlId:string,response:Record<string,unknown>){
    try{await this.deps.respond(controlId,response);}catch{} // the mailbox keeps its own safety net for the row
  }

  // ── Sealing ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** A call's reply as its mailbox body (split in two when it is long; the rest cached for `part`), or null. */
  private async sealCall(session:Session,header:LaneItem['header'],meta:Record<string,unknown>,attachment:Uint8Array|null,fallback?:Record<string,unknown>,capture=false)
    :Promise<Record<string,unknown>|null>{
    let box:string;
    try{box=await session.channel.sealReply(header,meta,attachment);}
    catch(error){
      // Too large is refused before the seq is spent: the small fallback still goes in a box.
      if(!(error instanceof ComputerUseRemoteCryptoError&&error.code==='FRAME_TOO_LARGE'))return null;
      try{box=await session.channel.sealReply(header,fallback??computerUseRemoteErrorFrame(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message,'read'));}
      catch{return null;}
    }
    if(capture)this.captures.push({at:this.now(),chars:box.length});
    const {body,rest}=computerUseRemoteCallReplyBody(box);
    if(rest&&body.parts===2)this.cachePart(session,header.seq,body.ref,rest);
    return body as unknown as Record<string,unknown>;
  }
  /** A reply answered in the poll. If even that cannot be sealed, a content-free sentence. */
  private async sealedBody(session:Session,header:{op:ComputerUseRemoteSealedOp;seq:number;sentAt:number},meta:Record<string,unknown>):Promise<Record<string,unknown>>{
    if(header.op==='call'){
      const body=await this.sealCall(session,header as LaneItem['header'],meta,null);
      if(!body)throw new Error(COMPUTER_USE_REMOTE_HOST_SEAL_FAILED);
      return body;
    }
    try{return {v:1,box:await session.channel.sealReply(header,meta)};}
    catch{throw new Error(COMPUTER_USE_REMOTE_HOST_SEAL_FAILED);}
  }
  // ── Parts and the capture budget ────────────────────────────────────────────────────────────────────────────────
  private cachePart(session:Session,seq:number,ref:string,rest:string){
    const now=this.now();
    this.expireParts(now);
    const key=partKey(session.deviceId,session.id,seq);
    const prior=this.parts.get(key);
    if(prior){this.parts.delete(key);this.partBytes-=prior.rest.length;}
    // Over 8 MB the oldest go first.
    for(const [oldKey,old] of this.parts){
      if(this.partBytes+rest.length<=this.limits.partCacheBytes)break;
      this.parts.delete(oldKey);this.partBytes-=old.rest.length;
    }
    if(rest.length>this.limits.partCacheBytes)return;
    this.parts.set(key,{tag:session.tag,ref,rest,expiresAt:now+this.limits.partCacheMs,at:now});
    this.partBytes+=rest.length;
  }
  private expireParts(now:number){
    for(const [key,part] of this.parts)if(part.expiresAt<=now){this.parts.delete(key);this.partBytes-=part.rest.length;}
  }
  /** Sealed capture replies of this receiving Mac in the last minute, in base64 characters (§8.7). */
  private captureUsed(){
    const now=this.now();
    this.captures=this.captures.filter(item=>now-item.at<CAPTURE_WINDOW_MS);
    return this.captures.reduce((sum,item)=>sum+item.chars,0);
  }

  // ── The ledger ──────────────────────────────────────────────────────────────────────────────────────────────────
  private ledgerOf(deviceId:string,tag:string):Ledger{
    const key=`${deviceId}\0${tag}`;
    let ledger=this.ledgers.get(key);
    if(!ledger){ledger={entries:new Map(),evictedThroughSentAt:null,touchedAt:this.now()};this.ledgers.set(key,ledger);}
    return ledger;
  }
  private record(ledger:Ledger,requestId:string,entry:LedgerEntry){
    ledger.entries.delete(requestId);
    ledger.entries.set(requestId,entry);
    ledger.touchedAt=this.now();
    this.prune(ledger);
  }
  /**
   * RC-16: settled entries and tombstones are kept at least 15 minutes after they settled; queued and running ones are
   * never dropped. Past 1,024 entries the oldest settled go first. Whatever is dropped raises evictedThroughSentAt, so an
   * `unseen` is never read as "not run" for an ID this ledger may have forgotten.
   */
  private prune(ledger:Ledger){
    const now=this.now();
    const drop=(requestId:string,entry:LedgerEntry)=>{
      ledger.entries.delete(requestId);
      ledger.evictedThroughSentAt=Math.max(ledger.evictedThroughSentAt??0,entry.sentAt);
      ledger.touchedAt=now;
    };
    for(const [requestId,entry] of ledger.entries)
      if((entry.state==='settled'||entry.state==='tombstone')&&now-(entry.settledAt??entry.receivedAt)>=this.limits.ledgerRetentionMs)drop(requestId,entry);
    if(ledger.entries.size<=this.limits.ledgerPerConnection)return;
    for(const [requestId,entry] of ledger.entries){
      if(ledger.entries.size<=this.limits.ledgerPerConnection)break;
      if(entry.state==='settled'||entry.state==='tombstone')drop(requestId,entry);
    }
  }

  // ── Notices (RC-10, §7.9) ───────────────────────────────────────────────────────────────────────────────────────
  private countAction(deviceId:string){const episode=this.episodes.get(deviceId);if(episode)episode.actions+=1;}
  /**
   * One episode per sending device: it starts when one of its grants opens (the start notice), stays open while any is
   * open or reopens within five minutes, and ends five minutes after the last closed (the end notice). Content-free:
   * the two device names, the minutes and the number of inputs.
   */
  private async notices(){
    if(!this.deps.notice||this.disposed)return;
    let grants:readonly {deviceId:string;deviceName:string}[];
    try{grants=this.deps.runtime.remoteGrants();}catch{return;}
    const now=this.now(),open=new Map<string,string>();
    for(const grant of grants)if(typeof grant?.deviceId==='string'&&!open.has(grant.deviceId))open.set(grant.deviceId,remoteDeviceName(grant.deviceName));
    for(const [deviceId,deviceName] of open){
      const episode=this.episodes.get(deviceId);
      if(episode){episode.closedAt=null;continue;}
      this.episodes.set(deviceId,{id:newComputerUseRemoteId(),deviceId,deviceName,startedAt:now,closedAt:null,actions:0,startPosted:false,startTries:0,startNextAt:now,posting:false});
      this.ensureTick();
    }
    for(const episode of [...this.episodes.values()]){
      if(open.has(episode.deviceId))continue;
      if(episode.closedAt===null){episode.closedAt=now;continue;}
      if(now-episode.closedAt<this.limits.noticeGroupMs)continue;
      this.episodes.delete(episode.deviceId);
      this.endings.push({episode,endedAt:episode.closedAt,tries:0,nextAt:now,giveUpAt:now+NOTICE_END_TRY_MS,posting:false});
    }
    // Tries are spaced in time, not counted per call: this runs after every lane item too, so a burst of calls during a
    // short posting outage must not use the notice up. The post carries the same ID every time (the mailbox posts it once),
    // so trying again is safe. A start notice is tried for as long as its episode lasts; an end notice for 30 minutes.
    const posts:Promise<void>[]=[];
    for(const episode of this.episodes.values()){
      if(episode.startPosted||episode.posting||now<episode.startNextAt)continue;
      episode.posting=true;episode.startTries+=1;
      posts.push(this.post(this.startText(episode),`cu-start-${episode.id}`).then(ok=>{
        episode.posting=false;
        if(ok)episode.startPosted=true;else episode.startNextAt=this.now()+this.noticeBackoff(episode.startTries);
      }));
    }
    for(const ending of this.endings){
      if(ending.posting||now<ending.nextAt)continue;
      ending.posting=true;ending.tries+=1;
      posts.push(this.post(this.endText(ending),`cu-end-${ending.episode.id}`).then(ok=>{
        ending.posting=false;
        const next=this.now()+this.noticeBackoff(ending.tries);
        if(ok||next>ending.giveUpAt)this.endings=this.endings.filter(item=>item!==ending);
        else ending.nextAt=next;
      }));
    }
    await Promise.all(posts);
  }
  /** The wait before the next try of a notice that failed `tries` times: one tick, doubling, at most a minute. */
  private noticeBackoff(tries:number){
    return Math.min(NOTICE_RETRY_MAX_MS,this.limits.tickMs*2**Math.max(0,Math.min(tries-1,16)));
  }
  private async post(text:string,requestId:string){
    try{await this.deps.notice!(text,requestId);return true;}catch{return false;}
  }
  private selfName(){
    let name:unknown=null;
    try{name=this.deps.deviceName?.();}catch{name=null;}
    return typeof name==='string'&&name.trim()?remoteDeviceName(name):null;
  }
  private startText(episode:Episode){
    const self=this.selfName();
    return `${episode.deviceName}의 AI가 ${self?`이 Mac(${self})`:'이 Mac'}의 컴퓨터 유즈를 시작했습니다 · 전체 Mac. `
      +`멈추려면 ${self??'이 Mac'}의 Control 막대 「중단」 또는 AgentsToZ 컴퓨터 유즈 패널을 쓰세요. ${NOTICE_POINTER_RISK}`;
  }
  private endText(ending:Ending){
    const self=this.selfName(),{episode}=ending;
    const minutes=Math.max(1,Math.round((ending.endedAt-episode.startedAt)/60_000));
    return `${episode.deviceName}의 AI가 ${self?`이 Mac(${self})`:'이 Mac'}에서 쓰던 컴퓨터 유즈가 끝났습니다(${minutes}분, 동작 ${episode.actions}개).`;
  }

  // ── Small parts ─────────────────────────────────────────────────────────────────────────────────────────────────
  private selfDeviceId(){
    let id:unknown=null;
    try{id=this.deps.selfDeviceId();}catch{id=null;}
    return typeof id==='string'&&UUID.test(id)?id.toLowerCase():null;
  }
  /** RC-2 ②③ and RC-12 from the runtime: the person's switch, blocked devices and connections. */
  private async admission(deviceId:string,tag:string):Promise<ComputerUseRemoteEnvelopeRefusal|null>{
    let code:ComputerUseRemoteRefusalCode|null;
    try{code=await this.deps.runtime.remoteAdmission({deviceId,instance:tag});}catch{return 'REMOTE_BAD_REQUEST';}
    if(code===null)return null;
    return code==='REMOTE_BLOCKED_BY_PERSON'||code==='REMOTE_DEVICE_BLOCKED'||code==='REMOTE_UNSUPPORTED'||code==='REMOTE_RATE_LIMITED'?code:'REMOTE_UNSUPPORTED';
  }
  private endsSession(error:unknown){
    const code=errorCode(error);
    return code==='REMOTE_BLOCKED_BY_PERSON'||code==='REMOTE_DEVICE_BLOCKED'||code==='REMOTE_UNSUPPORTED';
  }
  private peer(session:Session):ComputerUseRemotePeer{
    return {deviceId:session.deviceId,deviceName:session.deviceName,instance:session.tag,...(session.client?{client:session.client}:{}),...(session.host?{host:session.host}:{})};
  }
  /** Forgets a session; with `runtime`, its runtime connection (and grant) ends too (best effort). */
  private endSession(session:Session,runtime:boolean){
    if(this.sessions.get(session.key)===session)this.sessions.delete(session.key);
    if(session.ended)return;
    session.ended=true;
    if(runtime)void this.deps.runtime.remote(session.id,this.peer(session),{operation:'disconnect'}).catch(()=>undefined);
  }
  private ensureTick(){
    if(this.interval!==null||this.disposed)return;
    this.interval=this.timers.setInterval(()=>{void this.tick().catch(()=>undefined);},this.limits.tickMs);
  }
  private stopTick(){
    if(this.interval===null)return;
    this.timers.clearInterval(this.interval);
    this.interval=null;
  }
}

/** An observation's app names, each cut to `max` code points (remote replies only). */
export function cutAppNames(result:Record<string,any>,max:number=COMPUTER_USE_REMOTE_LIMITS.remoteAppNameMaxChars):Record<string,any>{
  const observation=result.observation;
  if(!plain(observation)||!Array.isArray(observation.applications))return result;
  return {...result,observation:{...observation,applications:observation.applications.map((app:unknown)=>
    plain(app)&&typeof app.name==='string'?{...app,name:Array.from(app.name).slice(0,max).join('')}:app)}};
}
/** The same observation without the names of apps other than the foreground one. */
export function withoutBackgroundAppNames(result:Record<string,any>):Record<string,any>{
  const observation=result.observation;
  if(!plain(observation)||!Array.isArray(observation.applications))return result;
  const foreground=plain(observation.foreground)?observation.foreground.applicationId:null;
  return {...result,observation:{...observation,applications:observation.applications.map((app:unknown)=>{
    if(!plain(app)||app.id===foreground)return app;
    const {name:_name,...rest}=app;return rest;
  })}};
}

const sessionKey=(deviceId:string,session:string)=>`${deviceId}\0${session}`;
const partKey=(deviceId:string,session:string,seq:number)=>`${deviceId}\0${session}\0${seq}`;
