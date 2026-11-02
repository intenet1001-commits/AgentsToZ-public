import type {AgentDialogueControlCallOptions,AgentDialogueControlDevice,AgentDialogueControlResults} from './agentDialogueHost';
import {communityDeviceStale} from './communityDeviceLiveness';
import {communityObject,communityBase64} from './communityAccessClient';
import {verifyCommunityComponentPeerProof} from './communityComponentIdentity';
import {ComputerUsePeerConfirmation,computerUseAuthNonce,computerUseAuthenticatedTranscript,type ComputerUseCommunityIdentity,type AuthenticatedComputerUseHello} from './computerUseAuthenticatedHandshake';
import {COMPUTER_USE_CLIENT_HEADER,COMPUTER_USE_INSTANCE_HEADER} from './computerUseConnectionProtocol';
import {
  COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES,
  COMPUTER_USE_REMOTE_CALL_OPERATIONS,
  COMPUTER_USE_REMOTE_ERRORS,
  COMPUTER_USE_REMOTE_KIND,
  COMPUTER_USE_REMOTE_LIMITS,
  COMPUTER_USE_REMOTE_VERSION,
  ComputerUseRemoteError,
  classifyComputerUseRemoteBadAnswer,
  classifyComputerUseRemoteRefusal,
  classifyComputerUseRemoteTransportFailure,
  computerUseRemoteCleanText,
  computerUseRemoteConnectionTag,
  computerUseRemoteEffect,
  computerUseRemoteError,
  computerUseRemoteLedgerOpen,
  computerUseRemotePartRequest,
  computerUseRemotePlatform,
  isComputerUseRemoteInput,
  newComputerUseRemoteId,
  parseComputerUseRemoteReceipt,
  parseComputerUseRemoteReceiptAnswer,
  parseComputerUseRemoteReply,
  remoteReceiptVerdict,
  type ComputerUseRemoteCallReply,
  type ComputerUseRemoteClassified,
  type ComputerUseRemoteClassifyOptions,
  type ComputerUseRemoteEnvelope,
  type ComputerUseRemoteErrorCode,
  type ComputerUseRemoteOutcome,
  type ComputerUseRemotePlatform,
  type ComputerUseRemoteReceipt,
  type ComputerUseRemoteReceiptAnswer,
} from './computerUseRemoteProtocol';
import {
  ComputerUseRemoteChannel,
  encodeComputerUseRemoteBox,
  decodeComputerUseRemoteBox,
  generateComputerUseRemoteKeyPair,
  joinComputerUseRemoteBox,
} from './computerUseRemoteCrypto';

/**
 * The sending side of computer use between community Macs (DESIGN remote-computer-use-2026-11-01 §6 「A」, §7, §8.7).
 * An AI on this Mac (A) names another community Mac (B) with `device`; this module, in A's sidecar, carries the request
 * through the community control mailbox under the kind `computer-use`, sealed end to end (computerUseRemoteCrypto.ts),
 * and B runs it with its own runtime and Control. Nothing here runs anything on this Mac.
 *
 * - A session is one MCP connection (its connection tag) and one B device. It holds the channel keys, the next seq, B's
 *   bootId and the local endpoint it was opened from (pinned). Every request of a session is serialized, so seqs reach B
 *   in order. When this Mac's community endpoint changes, the session is closed (best-effort disconnect) and the next
 *   request says hello again; B keys its ledger by device and connection tag, so receipts stay exact (RC-15).
 * - Budgets: hello 15 s, call 20 s, part 8 s, the whole route 40 s. Short of 20 s before a call, nothing is sent:
 *   REMOTE_SESSION_PENDING (not run).
 * - Unknown outcome (RC-7, §7.8): an input whose answer is lost is never resent. The MCP process keeps the authoritative
 *   ledger and judges receipts (`remoteReceiptVerdict`, §6). This route keeps its own gate per connection as well: an
 *   input with an open outcome blocks further input to that device here too, until its receipt settles it by the same
 *   verdict, until a late answer is collected through the endpoint that sent it (§7.8-6), until the device's boot changes,
 *   or until the sender's window (sentAt + 10 min) passes. The ID is reserved for its device before anything is sent, so
 *   an ID in flight to one device is refused for any other. Only hello and part are ever retried automatically.
 * - Mailbox load per target device (§8.7): 8 rows awaiting an answer (a slot frees on its answer or after 130 s), 24 rows
 *   without an answer in ten minutes, one capture per 2 s, four hellos a minute.
 * - Heartbeats (RC-9, §7.7): a 5 s tick of this module forwards a sealed heartbeat per session every 25 s while its MCP
 *   connection still beats; it also forgets MCP connections that stopped beating (closing their sessions).
 * - RC-13 (advisory): an OPS worker's AI may not use another Mac, and no AI here may while an AI of another Mac holds a
 *   grant on this one. Receipts stay allowed: they only settle what was already sent.
 *
 * The wire format between the MCP process and this route (WP5 ↔ WP4, `COMPUTER_USE_REMOTE_AGENT_PATH`):
 * - request body: an agent request in the scope namespace (`{operation:'scope-…', …}`, as `computerUseScopeMcpRequest`
 *   makes it) plus `device` (B's deviceId, or its endpointId from list_ops_devices); or `{operation:'devices'}`,
 *   `{operation:'heartbeat'}`, `{operation:'disconnect'}` without device. Headers as the local agent route: the profile
 *   token, the MCP instance and client headers, no Origin, at most 16,000 bytes.
 * - every answer to a request naming a device — refusals included — echoes `device` exactly as it was asked (the MCP
 *   believes "not run" only with that echo), and carries `bootId`, the device's boot as this Mac last saw it, once known.
 * - answer: `{success:true, device, deviceId, bootId, …B's result}`; or `{success:false, device, deviceId?, bootId?, code,
 *   outcome, error, requestId?, state?}` where `outcome` is not-run | unknown | state-unknown | read
 *   (`computerUseRemoteProtocol.ts`). An input's unknown outcome is `code:'REMOTE_UNKNOWN_OUTCOME', state:'unknown'`.
 * - a receipt answer is the other Mac's own receipt answer, `{success:true, bootId, evictedThroughSentAt, receipt, owner?,
 *   guidance?}` with the echo — its `bootId` is the boot that answered (or ran the input). It is no verdict: the MCP judges
 *   it against its own record. A receipt this route already holds (the input's own answer, or its late answer) is
 *   answered from memory in the same shape, with the boot that produced it.
 * - `devices`: `{success:true, inside, deviceId, self, devices:[{device, endpointId, name, kind, lastSeenAt, stale, remote}]}`
 *   where `deviceId` (= `self`) is this Mac.
 */

export const COMPUTER_USE_REMOTE_AGENT_PATH='/api/computer-use-agent/remote';
/**
 * A session without any answer from B this long may be gone there (B's connection lease is 75 s, src/computerUseRuntime.ts);
 * the next request says hello again instead of being refused for a missing session.
 */
export const COMPUTER_USE_REMOTE_SESSION_STALE_MS=75_000;
/**
 * The MCP process's heartbeat is every 20 s once it used another Mac; when neither a heartbeat nor a request came for this
 * long the connection is taken as gone: nothing is forwarded for it, and the tick forgets it.
 */
export const COMPUTER_USE_REMOTE_MCP_ALIVE_MS=45_000;
/**
 * The client's own tick while a session is open. Heartbeats are due 25 s after the last exchange (§8.7), so they go out
 * every 25-30 s — three chances inside B's 75 s lease — whatever the MCP's own 20 s rhythm is.
 */
export const COMPUTER_USE_REMOTE_TICK_MS=5_000;
/** Background rows (heartbeat, disconnect) wait less than a call: they are best effort. */
const HEARTBEAT_TIMEOUT_MS=8_000;
const DISCONNECT_TIMEOUT_MS=5_000;
/** MCP connections remembered at once (the runtime allows 64 connections too). */
const CONNECTIONS_MAX=64;
/** Input IDs remembered per connection (the receiver keeps 1,024 per connection too, §7.8-8). */
const BINDINGS_MAX=1024;
const HELLO_WINDOW_MS=60_000;

export type ComputerUseRemoteClientLimits={-readonly [K in keyof typeof COMPUTER_USE_REMOTE_LIMITS]:number};
/** What a device was last seen able to do, for `devices` (§7.1). */
export type ComputerUseRemoteDeviceState='ready'|'needs-standing'|'blocked-by-person'|'outdated'|'unsupported'|'not-ready'|'unchecked';

/** The community mailbox as this module uses it (AgentDialogueHost implements it). */
export interface ComputerUseRemoteDialogue {
  controlDevices():Promise<{inside:boolean;deviceId:string;devices:AgentDialogueControlDevice[]}>;
  controlSource():Promise<{deviceId:string;endpointId:string}|null>;
  controlCall(targetEndpointId:string,request:Record<string,unknown>,timeoutMs:number,options:AgentDialogueControlCallOptions):Promise<Record<string,unknown>>;
  controlResult(controlIds:readonly string[],sourceEndpointId:string):Promise<AgentDialogueControlResults>;
}
export interface ComputerUseRemoteClientDependencies {
  dialogue:ComputerUseRemoteDialogue;
  /** Installed production uses the native component identity; absence is legacy-only compatibility/test wiring. */
  identity?:ComputerUseCommunityIdentity;
  /** RC-13 chain guard: an AI of another Mac holds a grant on this one right now (the runtime's `hasIncomingRemoteGrant`). */
  incomingRemoteGrant?():boolean;
  /** This Mac's platform (default `process.platform`). Only macOS sends (D10, RC-19). */
  platform?:string;
  now?():number;
  /** Tests only: shorter waits. Production uses COMPUTER_USE_REMOTE_LIMITS. */
  limits?:Partial<ComputerUseRemoteClientLimits>;
  /** Tests only: the tick's timer (default the global setInterval, unref'd). */
  timers?:{setInterval(callback:()=>void,ms:number):unknown;clearInterval(handle:unknown):void};
}
/** Who asks: one MCP connection of this Mac. Only `instance` identifies; the rest is display or an advisory hint. */
export interface ComputerUseRemoteCaller {
  /** The MCP process's 64-hex instance header. Its connection tag keys B's ledger. */
  instance:unknown;
  /** The MCP client's self-reported name, for B's grant label. */
  client?:string|null;
  /** The app the AI runs in on this Mac, for B's grant label. */
  host?:string|null;
  /** The AI runs in a Workroom that works on another device's OPS task (RC-13). Resolved only when needed. */
  opsWorker?:()=>Promise<boolean>;
}

// ── The reply frame inside a call's box (B builds it, A reads it) ───────────────────────────────────────────────────
/**
 * A call's reply meta (inside the sealed box) is one of:
 * - `{success:true, …result}`: the runtime's answer. A screen image travels as the frame's binary attachment (the JPEG's
 *   own bytes): `result.image` keeps every other field and has no `data`.
 * - `{success:false, error, code?, outcome}`: a refusal after decryption (RC-5: it never reaches the plaintext mailbox).
 *   `outcome` says what the receiver knows — `not-run` when nothing reached Control (every ScopeHost and runtime refusal
 *   is raised before dispatch). Without a valid `outcome`, the sender assumes the worst for the request's effect: an
 *   input is unknown, a request-access or request-human is state-unknown.
 */
export type ComputerUseRemoteReplyContent=
  |{kind:'result';result:Record<string,unknown>}
  |{kind:'error';error:string;code?:string;outcome?:ComputerUseRemoteOutcome};
const OUTCOMES:readonly ComputerUseRemoteOutcome[]=['not-run','unknown','state-unknown','read'];
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdPattern=/^[A-Za-z0-9_-]{8,128}$/;
const grantPattern=/^[a-f0-9]{64}$/;
const codePattern=/^[A-Z][A-Z0-9_]{1,63}$/;
const JPEG_BASE64_MAX=320_000;

/** For the receiver (WP3): a runtime result as reply meta and its image's bytes as the attachment. */
export function computerUseRemoteReplyFrame(result:Record<string,unknown>):{meta:Record<string,unknown>;attachment:Uint8Array|null}{
  const image=result.image;
  if(!plain(image))return {meta:{...result,success:result.success===false?false:true},attachment:null};
  const {data,...rest}=image;
  if(image.mediaType!=='image/jpeg'||typeof data!=='string'||!data.length||data.length>JPEG_BASE64_MAX)throw new ComputerUseRemoteError('REMOTE_BAD_ANSWER');
  return {meta:{...result,success:true,image:rest},attachment:decodeComputerUseRemoteBox(data,JPEG_BASE64_MAX)};
}
/** For the receiver (WP3): a refusal after decryption, as reply meta. The text is cut and cleaned; it stays in the box. */
export function computerUseRemoteErrorFrame(error:unknown,outcome:ComputerUseRemoteOutcome,code?:string):Record<string,unknown>{
  const text=error instanceof Error?error.message:typeof error==='string'?error:'';
  const message=computerUseRemoteCleanText(text,500)||'그 Mac에서 요청을 처리하지 못했습니다.';
  const fromError=error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:undefined;
  const finalCode=code??fromError;
  return {success:false,error:message,outcome,...(finalCode&&codePattern.test(finalCode)?{code:finalCode}:{})};
}
/** The sender's closed reading of an opened reply. Anything else is a bad answer (an input's outcome is then unknown). */
export function parseComputerUseRemoteReplyContent(meta:unknown,attachment:Uint8Array|null):ComputerUseRemoteReplyContent{
  const bad=():never=>{throw new ComputerUseRemoteError('REMOTE_BAD_ANSWER');};
  if(!plain(meta))return bad();
  if(meta.success===false){
    if(attachment)return bad();
    if(typeof meta.error!=='string'||!meta.error.trim()||meta.error.length>1000)return bad();
    const keys=Object.keys(meta);
    if(keys.some(key=>!['success','error','code','outcome'].includes(key)))return bad();
    if('code' in meta&&(typeof meta.code!=='string'||!codePattern.test(meta.code)))return bad();
    if('outcome' in meta&&!OUTCOMES.includes(meta.outcome as ComputerUseRemoteOutcome))return bad();
    return {kind:'error',error:computerUseRemoteCleanText(meta.error,500),...(typeof meta.code==='string'?{code:meta.code}:{}),
      ...(typeof meta.outcome==='string'?{outcome:meta.outcome as ComputerUseRemoteOutcome}:{})};
  }
  if(meta.success!==true)return bad();
  const image=meta.image;
  if(image===undefined){if(attachment)return bad();return {kind:'result',result:{...meta}};}
  if(!plain(image)||'data' in image||image.mediaType!=='image/jpeg'||!attachment||!attachment.byteLength
    ||attachment.byteLength>COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes)return bad();
  return {kind:'result',result:{...meta,image:{...image,data:encodeComputerUseRemoteBox(attachment)}}};
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Target {deviceId:string;endpointId:string;name:string;lastSeenAt:string|null;self:string}
interface Session {
  id:string;channel:ComputerUseRemoteChannel;bootId:string;source:string;seq:number;labelsSent:boolean;
  openedAt:number;lastExchangeAt:number;lastHeartbeatAt:number;
  authentication?:{ownHash:string;peerHash:string;expiresAt:number};
}
/** A row this Mac sent to a device. Rate limits count those without an answer (§8.7). */
interface Row {sentAt:number;answered:boolean;inserted:'unknown'|'yes'|'no';controlId?:string}
/** A timed-out call whose answer may still arrive, collected only through the endpoint that sent it (§7.8-6). */
interface LateAnswer {
  controlId:string;source:string;channel:ComputerUseRemoteChannel;header:{op:'call';seq:number;sentAt:number};
  operation:string;requestId?:string;rememberedAt:number;row:Row;
  /** The boot of the session the call went out on: a receipt in its answer is that boot's. */
  bootId:string;
}
interface Link {
  deviceId:string;targetEndpointId:string;deviceName:string;client:string|null;
  queue:Promise<unknown>;busy:number;session:Session|null;bootId:string|null;late:LateAnswer[];lastCallAt:number;
}
/**
 * An input ID of this connection and the device it went to. `sending` reserves it while its call is under way, `open` is
 * this route's unknown-outcome gate (§7.8-1), `settled` ends it. `stored` is a receipt the other Mac itself answered (in the
 * input's own answer or its late answer), kept in the shape of its receipt answer so a receipt can be answered from it.
 */
interface Binding {
  deviceId:string;deviceName:string;sentAt:number;bootId:string|null;state:'sending'|'open'|'settled';stored?:ComputerUseRemoteReceiptAnswer;
}
interface Connection {
  instance:string;tag:string;links:Map<string,Link>;bindings:Map<string,Binding>;grants:Map<string,{deviceId:string;deviceName:string;at:number}>;
  mcpHeartbeatAt:number;seenAt:number;
}
interface DeviceState {rows:Row[];hellos:number[];lastCaptureAt:number|null;remote:{state:ComputerUseRemoteDeviceState;at:number}|null}
type Exchange={response:Record<string,unknown>;sent:true}|{failure:ComputerUseRemoteClassified;sent:boolean};

const failureOf=(code:ComputerUseRemoteErrorCode,message?:string):ComputerUseRemoteClassified=>{
  const outcome=COMPUTER_USE_REMOTE_ERRORS[code].outcome;
  const text=message??COMPUTER_USE_REMOTE_ERRORS[code].message;
  if(outcome==='unknown')return {outcome,code:'REMOTE_UNKNOWN_OUTCOME',message:text};
  if(outcome==='state-unknown')return {outcome,code:'REMOTE_STATE_UNKNOWN',message:text};
  return {outcome,code,message:text} as ComputerUseRemoteClassified;
};
const asFailure=(error:unknown):ComputerUseRemoteClassified|null=>error instanceof ClassifiedFailure?error.failure
  :error instanceof ComputerUseRemoteError?failureOf(error.code,error.message):null;
/** The local dialogue's own refusals that mean this Mac has no shared profile or device identity (§2, §7.1). */
const PROFILE_CODES=/(?:PROFILE_REQUIRED|DEVICE_REQUIRED|KEY_MISSING|STORE_UNAVAILABLE|SOURCE_UNAVAILABLE|DEVICE_UNAUTHORIZED|DEVICE_KEY_MISMATCH)/;
const profileError=(error:unknown)=>{
  const fields=error&&typeof error==='object'?error as {code?:unknown;message?:unknown}:{};
  return [fields.code,fields.message].some(value=>typeof value==='string'&&PROFILE_CODES.test(value));
};
const errorCode=(error:unknown)=>error&&typeof error==='object'&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:'';
const ACTUAL=COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES as readonly string[];
const WORKER_DENIED='다른 기기에서 맡긴 OPS 작업 안에서는 다른 Mac의 컴퓨터 유즈를 쓸 수 없습니다. 결과를 제출해 맡긴 기기가 정하게 하세요.';
const DEVICES_UNREADABLE='커뮤니티 기기 목록을 읽지 못해 보내지 않았습니다. 잠시 뒤 devices로 다시 확인하세요.';

export class ComputerUseRemoteClient {
  private readonly now:()=>number;
  private readonly limits:ComputerUseRemoteClientLimits;
  private readonly platform:ComputerUseRemotePlatform;
  private readonly connections=new Map<string,Connection>();
  private readonly devicesState=new Map<string,DeviceState>();
  private tickHandle:unknown=null;
  constructor(private readonly deps:ComputerUseRemoteClientDependencies){
    this.now=deps.now??Date.now;
    this.limits={...COMPUTER_USE_REMOTE_LIMITS,...deps.limits};
    this.platform=computerUseRemotePlatform(deps.platform??process.platform);
  }

  /**
   * One request from an MCP connection of this Mac. Answers every classified outcome as an object — every refusal of a
   * request naming a device echoes that `device` (the MCP believes "not run" only with the echo). Throws only for a body
   * that names no device and cannot be read (the route answers that with 400).
   */
  async agent(caller:ComputerUseRemoteCaller,value:unknown):Promise<Record<string,unknown>>{
    const started=this.now();
    if(!plain(value))throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const {device,operation,...rest}=value;
    if(device===undefined){
      if(Object.keys(rest).length)throw computerUseRemoteError('REMOTE_BAD_REQUEST');
      if(operation==='devices')return this.devices();
      if(operation==='heartbeat'||operation==='disconnect'){
        const connection=await this.connection(caller.instance);
        if(operation==='heartbeat'){connection.mcpHeartbeatAt=this.now();return {success:true,forwarded:this.forwardHeartbeats(connection)};}
        return {success:true,closed:this.closeConnection(connection)};
      }
      throw computerUseRemoteError((COMPUTER_USE_REMOTE_CALL_OPERATIONS as readonly unknown[]).includes(operation)?'REMOTE_DEVICE_UNKNOWN':'REMOTE_BAD_REQUEST');
    }
    const echo:Record<string,unknown>={device};
    try{
      if(typeof operation!=='string'||!(COMPUTER_USE_REMOTE_CALL_OPERATIONS as readonly unknown[]).includes(operation))throw computerUseRemoteError('REMOTE_BAD_REQUEST');
      if(typeof device!=='string'||!uuidPattern.test(device))throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');
      const connection=await this.connection(caller.instance);
      return await this.deviceRequest(connection,caller,device,{operation,...rest},started);
    }catch(error){return this.failureAnswer(echo,asFailure(error)??failureOf('REMOTE_BAD_REQUEST'));}
  }

  /** `devices` (§7.1): the community's other Macs, whether each still answers, and what this Mac last saw of it. */
  async devices():Promise<Record<string,unknown>>{
    let listed:Awaited<ReturnType<ComputerUseRemoteDialogue['controlDevices']>>;
    try{listed=await this.deps.dialogue.controlDevices();}
    catch(error){return this.failureAnswer({},profileError(error)?failureOf('REMOTE_PROFILE_REQUIRED'):failureOf('REMOTE_DEVICE_UNKNOWN',DEVICES_UNREADABLE));}
    // `deviceId` names this Mac (the MCP reads it to answer REMOTE_SELF); `self` is the same value.
    if(!listed.inside)return {success:true,inside:false,deviceId:listed.deviceId,self:listed.deviceId,devices:[],
      guidance:'이 Mac이 커뮤니티에 들어가 있지 않습니다. 앱의 「기기 간 대화」에서 입장해야 다른 Mac을 씁니다.'};
    const now=this.now();
    return {success:true,inside:true,deviceId:listed.deviceId,self:listed.deviceId,devices:listed.devices.map(row=>{
      const remote=this.devicesState.get(row.deviceId.toLowerCase())?.remote;
      return {device:row.deviceId,endpointId:row.endpointId,name:row.displayName,kind:row.kind,lastSeenAt:row.lastSeenAt,
        stale:communityDeviceStale(row.lastSeenAt,now),remote:remote?.state??'unchecked',
        ...(remote?{remoteCheckedAt:new Date(remote.at).toISOString()}:{})};
    }),guidance:listed.devices.length
      ?'다른 Mac을 쓰려면 device에 그 Mac의 device 값을 계속 넣으세요. 이 Mac은 device 없이 씁니다.'
      :'다른 기기가 아직 목록에 없습니다. 대상 Mac이 같은 커뮤니티에 들어가 있는지 확인한 뒤 devices로 다시 확인하세요. 이 Mac은 device 없이 씁니다.'};
  }

  /** 「이 Mac의 AI가 다른 Mac을 사용 중」 for this Mac's panel: open sessions of MCP connections still alive, nothing secret. */
  usage(){
    const now=this.now();
    return {sessions:[...this.connections.values()].filter(connection=>!this.silent(connection,now)).flatMap(connection=>[...connection.links.values()].flatMap(link=>link.session?[{
      deviceId:link.deviceId,deviceName:link.deviceName,connection:connection.tag.slice(0,8),client:link.client,
      since:link.session.openedAt,lastCallAt:link.lastCallAt,active:now-link.lastCallAt<this.limits.heartbeatIdleStopMs,
    }]:[]))};
  }
  /** The panel's 「끊기」 on this Mac: end every session to that device (best-effort disconnect). The next call says hello again. */
  closeDevice(deviceId:string):number{
    let closed=0;
    for(const connection of this.connections.values()){
      const link=connection.links.get(deviceId.toLowerCase());
      if(link?.session){this.closeSession(link,link.session);closed+=1;}
    }
    return closed;
  }
  /**
   * Forward heartbeats (RC-9, §7.7): a sealed `bg:1` heartbeat per session once 25 s passed since its last exchange or
   * heartbeat, only while its MCP connection still beats, its link is idle, and it had a real call in the last ten
   * minutes. The client's own 5 s tick calls this for every connection, so forwarding does not depend on the MCP's
   * rhythm; an MCP heartbeat calls it for its connection at once.
   */
  forwardHeartbeats(only?:Connection):number{
    const now=this.now();let forwarded=0;
    for(const connection of only?[only]:[...this.connections.values()]){
      if(now-connection.mcpHeartbeatAt>=COMPUTER_USE_REMOTE_MCP_ALIVE_MS)continue;
      for(const link of connection.links.values()){
        const session=link.session;
        if(!session||link.busy>0||now-link.lastCallAt>=this.limits.heartbeatIdleStopMs)continue;
        if(now-Math.max(session.lastHeartbeatAt,session.lastExchangeAt)<this.limits.heartbeatForwardMs)continue;
        session.lastHeartbeatAt=now;forwarded+=1;
        void this.serial(link,()=>this.background(link,session,'heartbeat')).catch(()=>undefined);
      }
    }
    return forwarded;
  }
  /**
   * The 5 s tick while any session is open: forget MCP connections that are gone (closing their sessions), then forward
   * due heartbeats. It stops itself when no session is left; the next hello starts it again.
   */
  tick(){
    this.prune(this.now());
    this.forwardHeartbeats();
    if(![...this.connections.values()].some(connection=>[...connection.links.values()].some(link=>link.session)))this.stopTicking();
  }
  /** Stops the tick (the host's shutdown). Sessions are left to B's lease. */
  dispose(){this.stopTicking();}
  private startTicking(){
    if(this.tickHandle!==null)return;
    const timers=this.deps.timers;
    const handle=timers?timers.setInterval(()=>this.tick(),COMPUTER_USE_REMOTE_TICK_MS):setInterval(()=>this.tick(),COMPUTER_USE_REMOTE_TICK_MS);
    (handle as {unref?:()=>void}|null)?.unref?.();
    this.tickHandle=handle;
  }
  private stopTicking(){
    if(this.tickHandle===null)return;
    if(this.deps.timers)this.deps.timers.clearInterval(this.tickHandle);else clearInterval(this.tickHandle as ReturnType<typeof setInterval>);
    this.tickHandle=null;
  }

  // ── Requests to one device ────────────────────────────────────────────────────────────────────────────────────────
  private async deviceRequest(connection:Connection,caller:ComputerUseRemoteCaller,device:string,request:Record<string,unknown>&{operation:string},started:number){
    const echo:Record<string,unknown>={device};
    const operation=request.operation,receipt=operation==='scope-receipt',input=isComputerUseRemoteInput(operation);
    const requestId=typeof request.requestId==='string'?request.requestId:undefined;
    let link:Link|null=null;
    // The device's boot as this Mac last saw it: the MCP keeps it with an input whose outcome is open (§7.8-1).
    const boot=():Record<string,unknown>=>link?.bootId?{bootId:link.bootId}:{};
    try{
      if(this.platform!=='darwin')throw computerUseRemoteError('REMOTE_SENDER_UNSUPPORTED');
      if((input||receipt)&&(!requestId||!requestIdPattern.test(requestId)))throw computerUseRemoteError('REMOTE_BAD_REQUEST');
      if(!receipt){
        let worker=false;
        // Advisory (RC-13): a hint that cannot be read does not block ordinary use.
        try{worker=await caller.opsWorker?.()===true;}catch{worker=false;}
        if(worker)throw new ComputerUseRemoteError('REMOTE_CHAIN_DENIED',WORKER_DENIED);
        if(this.deps.incomingRemoteGrant?.()===true)throw computerUseRemoteError('REMOTE_CHAIN_DENIED');
      }
      const target=await this.target(device);
      echo.deviceId=target.deviceId;
      this.expire(connection);
      // A fast refusal; `call` checks again, and reserves the ID, inside the device's queue.
      if(requestId){
        const bound=connection.bindings.get(requestId);
        if(bound&&bound.deviceId!==target.deviceId)throw computerUseRemoteError('REMOTE_ID_BOUND_ELSEWHERE',{boundTo:bound.deviceName});
      }
      if(typeof request.grant==='string'){
        const bound=connection.grants.get(request.grant);
        if(bound&&bound.deviceId!==target.deviceId)throw computerUseRemoteError('REMOTE_ID_BOUND_ELSEWHERE',{boundTo:bound.deviceName});
      }
      const current:Link=this.link(connection,target,caller);
      link=current;
      const answer=await this.serial(current,()=>receipt
        ?this.receipt(connection,current,target,request,requestId!,caller,started)
        :this.call(connection,current,target,request,caller,started));
      // A receipt answer keeps the boot that answered it (or ran the input); anything else carries the session's boot.
      return receipt?{...boot(),...answer,...echo}:{...answer,...echo,...boot()};
    }catch(error){
      return {...this.failureAnswer(echo,asFailure(error)??classifyComputerUseRemoteBadAnswer({operation:operation as ComputerUseRemoteClassifyOptions['operation'],requestId}),requestId),...boot()};
    }
  }
  private failureAnswer(echo:Record<string,unknown>,failure:ComputerUseRemoteClassified,requestId?:string):Record<string,unknown>{
    return {success:false,code:failure.code,outcome:failure.outcome,error:failure.message,
      ...(failure.outcome==='unknown'&&requestId?{requestId,state:'unknown'}:{}),...echo};
  }

  /**
   * A call (anything but receipt). An input's ID is reserved for its device before anything is sent — checked and taken in
   * one step inside the device's queue, so the same ID in flight to another device is refused — and settled from its answer.
   */
  private async call(connection:Connection,link:Link,target:Target,request:Record<string,unknown>&{operation:string},caller:ComputerUseRemoteCaller,started:number){
    const operation=request.operation,input=isComputerUseRemoteInput(operation);
    const requestId=input?request.requestId as string:undefined;
    link.lastCallAt=this.now();
    await this.collectLate(connection,link);
    this.expire(connection);
    const capture=operation==='scope-capture'||operation==='scope-observe'&&request.capture===true;
    const device=this.device(link.deviceId);
    if(capture&&device.lastCaptureAt!==null&&this.now()-device.lastCaptureAt<this.limits.captureIntervalMs)throw computerUseRemoteError('REMOTE_RATE_LIMITED');
    // From here to the reservation nothing awaits: the check and the reservation are one step (RC-7, RC-15).
    let binding:Binding|undefined,previous:Binding|undefined;
    if(requestId){
      const open=[...connection.bindings.entries()].find(([,item])=>item.deviceId===link.deviceId&&item.state!=='settled');
      if(open)throw computerUseRemoteError('REMOTE_BLOCKED_BY_UNKNOWN',{requestId:open[0]});
      previous=connection.bindings.get(requestId);
      if(previous&&previous.deviceId!==link.deviceId)throw computerUseRemoteError('REMOTE_ID_BOUND_ELSEWHERE',{boundTo:previous.deviceName});
      binding={deviceId:link.deviceId,deviceName:link.deviceName,sentAt:this.now(),bootId:link.bootId,state:'sending'};
      connection.bindings.set(requestId,binding);
    }
    let reachedSend=false;
    /** Nothing went out: the reservation is given back (an earlier settled use of the ID, if any, stays as it was). */
    const release=()=>{
      if(!binding||!requestId||connection.bindings.get(requestId)!==binding)return;
      if(previous)connection.bindings.set(requestId,previous);else connection.bindings.delete(requestId);
    };
    let result:Awaited<ReturnType<ComputerUseRemoteClient['transact']>>;
    try{result=await this.transact(connection,link,target,request,caller,started,{
      beforeSend:(session,sentAt)=>{
        reachedSend=true;
        if(capture)device.lastCaptureAt=this.now();
        if(binding){binding.sentAt=sentAt;binding.bootId=session.bootId;}
      },
      requestId,
    });}catch(error){
      // Once the row may have been written the input stays open (never resent); before that nothing was sent.
      if(binding&&binding.state==='sending'){if(reachedSend)binding.state='open';else release();}
      throw error;
    }
    if(!result.ok){
      // An input is open unless the request certainly did not run.
      if(binding&&binding.state==='sending'){
        if(!reachedSend)release();
        else if(result.failure.outcome==='not-run')this.settle(binding);
        else binding.state='open';
      }
      throw new ClassifiedFailure(result.failure);
    }
    const content=result.content;
    if(content.kind==='error'){
      // Only `not-run` is taken from the other Mac as it is; anything else is the worst its effect allows.
      const outcome:ComputerUseRemoteOutcome=content.outcome==='not-run'?'not-run':this.worstOutcome(operation);
      this.noteRemote(link.deviceId,content.code);
      if(binding){if(outcome==='not-run')this.settle(binding);else binding.state='open';}
      const code=outcome==='unknown'?'REMOTE_UNKNOWN_OUTCOME':outcome==='state-unknown'?'REMOTE_STATE_UNKNOWN':content.code??'REMOTE_NOT_RUN';
      return {success:false,code,outcome,error:outcome==='unknown'?`${content.error} ${COMPUTER_USE_REMOTE_ERRORS.REMOTE_UNKNOWN_OUTCOME.message}`:content.error,
        ...(outcome==='unknown'&&requestId?{requestId,state:'unknown'}:{})};
    }
    const answer=content.result;
    if(binding){
      const receipt=parseComputerUseRemoteReceipt(answer.receipt);
      if(!receipt||receipt.requestId!==requestId||!ACTUAL.includes(receipt.state)){
        binding.state='open';
        throw new ClassifiedFailure(classifyComputerUseRemoteBadAnswer({operation:operation as ComputerUseRemoteClassifyOptions['operation'],requestId}));
      }
      this.settle(binding,this.storedReceipt(binding.bootId,receipt,answer));
    }
    if(operation==='scope-status')this.noteStatus(connection,link,answer);
    return answer;
  }

  /**
   * §7.8-3..6: the other Mac's receipt answer for an ID, unjudged. The MCP process owns the unknown-outcome ledger and
   * judges the answer against its own record (`remoteReceiptVerdict`, §6) — so the answer keeps B's shape and bootId.
   * - A receipt this Mac already holds (the input's own answer, or its late answer collected first) is answered from it,
   *   with the boot that ran the input; nothing is sent.
   * - Anything else is asked of the other Mac, whose ledger is kept per device and connection tag (RC-15) — whether or
   *   not this route still remembers the ID (it forgets when restarted; the MCP asks only about IDs it sent).
   * The same verdict settles this route's own gate for that device.
   */
  private async receipt(connection:Connection,link:Link,target:Target,request:Record<string,unknown>&{operation:string},requestId:string,caller:ComputerUseRemoteCaller,started:number):Promise<Record<string,unknown>>{
    link.lastCallAt=this.now();
    await this.collectLate(connection,link);
    this.expire(connection);
    const binding=connection.bindings.get(requestId);
    if(binding?.state==='settled'&&binding.stored)return {...binding.stored};
    const result=await this.transact(connection,link,target,request,caller,started,{});
    if(!result.ok)throw new ClassifiedFailure(result.failure);
    const content=result.content;
    if(content.kind==='error'){
      this.noteRemote(link.deviceId,content.code);
      const outcome:ComputerUseRemoteOutcome=content.outcome==='not-run'?'not-run':'read';
      return {success:false,code:content.code??'REMOTE_BAD_ANSWER',outcome,error:content.error};
    }
    const parsed=parseComputerUseRemoteReceiptAnswer(content.result);
    if(!parsed||parsed.receipt.requestId!==requestId)throw new ClassifiedFailure(classifyComputerUseRemoteBadAnswer({operation:'scope-receipt',requestId}));
    const answer:ComputerUseRemoteReceiptAnswer={...parsed,success:true};
    if(binding&&binding.state!=='settled'){
      const verdict=remoteReceiptVerdict({requestId,deviceId:binding.deviceId,sentAt:binding.sentAt,bootId:binding.bootId??''},answer,this.now());
      // A positive record (an actual receipt, or B's own not-run) does not change: it is kept and answered again as it is.
      const positive=verdict.verdict==='receipt'||verdict.verdict==='not-run'&&answer.receipt.state==='not-run';
      if(verdict.settled)this.settle(binding,positive?answer:undefined);
    }
    return {...answer};
  }

  /**
   * One sealed call on the link's session, saying hello first when needed: within the route budget, with the per-device
   * row limits, and with a two-part reply joined. `beforeSend` runs once the request is sealed and before the row is
   * written (the input's ledger entry). Returns the opened reply, or how it failed.
   */
  private async transact(connection:Connection,link:Link,target:Target,request:Record<string,unknown>&{operation:string},caller:ComputerUseRemoteCaller,started:number,
    hooks:{beforeSend?(session:Session,sentAt:number):void;requestId?:string}):Promise<{ok:true;content:ComputerUseRemoteReplyContent}|{ok:false;failure:ComputerUseRemoteClassified}>{
    const operation=request.operation as ComputerUseRemoteClassifyOptions['operation'];
    const options:ComputerUseRemoteClassifyOptions={operation,...(hooks.requestId?{requestId:hooks.requestId}:{})};
    const deadline=started+this.limits.routeBudgetMs;
    const session=await this.session(connection,link,target,deadline);
    // Short of a whole call's wait, nothing is sent: certainly not run (§8.7).
    if(deadline-this.now()<this.limits.callTimeoutMs)return {ok:false,failure:failureOf('REMOTE_SESSION_PENDING')};
    const {device:_device,...wire}=request as Record<string,unknown>;
    const meta:Record<string,unknown>={...wire};
    // The MCP client and host app ride in the session's first call box for the other Mac's grant label. They count as
    // delivered only once a row carrying them was written; until then every call carries them.
    const labels=!session.labelsSent;
    if(labels){
      const client=computerUseRemoteCleanText(caller.client??'',64),host=computerUseRemoteCleanText(caller.host??'',64);
      if(client)meta.client=client;if(host)meta.host=host;
    }
    const seq=session.seq+1,sentAt=this.now();
    session.seq=seq;
    let box:string;
    try{box=await session.channel.sealRequest({op:'call',seq,sentAt},meta);}
    catch{return {ok:false,failure:failureOf('REMOTE_BAD_REQUEST')};}
    hooks.beforeSend?.(session,sentAt);
    const envelope:ComputerUseRemoteEnvelope={kind:COMPUTER_USE_REMOTE_KIND,v:COMPUTER_USE_REMOTE_VERSION,op:'call',session:session.id,seq,sentAt,box};
    const header={op:'call' as const,seq,sentAt};
    const exchange=await this.exchange(link,target,envelope,Math.min(this.limits.callTimeoutMs,deadline-this.now()),options,
      {source:session.source,onSent:()=>{if(labels)session.labelsSent=true;},
        late:{channel:session.channel,header,operation:request.operation,requestId:hooks.requestId,bootId:session.bootId}});
    if('failure' in exchange)return {ok:false,failure:this.sessionFailure(link,session,exchange.failure)};
    const response=exchange.response;
    if(response.ok===false)return {ok:false,failure:this.sessionFailure(link,session,classifyComputerUseRemoteRefusal(response.error,options))};
    let reply:ComputerUseRemoteCallReply;
    try{if(response.ok!==true)throw Error();reply=parseComputerUseRemoteReply('call',response.body);}
    catch{return {ok:false,failure:classifyComputerUseRemoteBadAnswer(options)};}
    let box2=reply.box;
    if(reply.parts===2){
      const joined=await this.part(link,target,session,{seq,ref:reply.ref,first:reply.box},deadline,options);
      if(!joined)return {ok:false,failure:classifyComputerUseRemoteRefusal(undefined,{...options,part:true})};
      box2=joined;
    }
    try{
      const opened=await session.channel.openReply(header,box2);
      session.lastExchangeAt=this.now();
      return {ok:true,content:parseComputerUseRemoteReplyContent(opened.meta,opened.attachment)};
    }catch{return {ok:false,failure:classifyComputerUseRemoteBadAnswer(options)};}
  }
  /** The rest of a split reply (a read). One automatic retry (§7.8-10). */
  private async part(link:Link,target:Target,session:Session,call:{seq:number;ref:string;first:string},deadline:number,options:ComputerUseRemoteClassifyOptions):Promise<string|null>{
    for(let attempt=0;attempt<2;attempt++){
      const remaining=deadline-this.now();
      if(remaining<=0)return null;
      const part=computerUseRemotePartRequest({session:session.id,seq:call.seq},call.ref,this.now());
      const exchange=await this.exchange(link,target,part,Math.min(this.limits.partTimeoutMs,remaining),{...options,part:true},{});
      if('failure' in exchange||exchange.response.ok!==true)continue;
      try{return joinComputerUseRemoteBox([call.first,parseComputerUseRemoteReply('part',exchange.response.body).box]);}catch{continue;}
    }
    return null;
  }
  /** A refusal that says B has no such session drops ours: the next request says hello again (§7.7). */
  private sessionFailure(link:Link,session:Session,failure:ComputerUseRemoteClassified):ComputerUseRemoteClassified{
    if(failure.code==='REMOTE_SESSION_MISSING'){
      if(link.session===session)link.session=null;
      return failureOf('REMOTE_SESSION_RESTARTED');
    }
    this.noteRemote(link.deviceId,failure.code);
    return failure;
  }

  /**
   * One mailbox row and its answer. Counts the row against the device's limits before it is written, records the
   * endpoint that wrote it, and remembers a call that timed out after it was written, to collect its late answer.
   */
  private async exchange(link:Link,target:Target,request:ComputerUseRemoteEnvelope|Record<string,unknown>,timeoutMs:number,options:ComputerUseRemoteClassifyOptions,
    extra:{source?:string;onSent?(sourceEndpointId:string,targetDeviceId:string|null):void;
      late?:{channel:ComputerUseRemoteChannel;header:{op:'call';seq:number;sentAt:number};operation:string;requestId?:string;bootId:string}}):Promise<Exchange>{
    if(timeoutMs<=0)return {failure:failureOf('REMOTE_SESSION_PENDING'),sent:false};
    let row:Row;
    try{row=this.reserveRow(link.deviceId);}catch(error){return {failure:asFailure(error)??failureOf('REMOTE_RATE_LIMITED'),sent:false};}
    let sent:{controlId:string;sourceEndpointId:string}|null=null;
    try{
      const response=await this.deps.dialogue.controlCall(target.endpointId,request as unknown as Record<string,unknown>,timeoutMs,{
        ...(extra.source?{sourceEndpointId:extra.source}:{}),
        onSent:value=>{sent=value;row.inserted='yes';row.controlId=value.controlId;extra.onSent?.(value.sourceEndpointId,value.targetDeviceId);},
      });
      row.answered=true;
      return {response,sent:true};
    }catch(error){
      const wasSent=sent as {controlId:string;sourceEndpointId:string}|null;
      if(!wasSent&&errorCode(error)==='AGENT_DIALOGUE_CONTROL_SOURCE_CHANGED'){row.inserted='no';return {failure:failureOf('REMOTE_SESSION_PENDING'),sent:false};}
      const failure=classifyComputerUseRemoteTransportFailure(error,{...options,sent:!!wasSent});
      if(!wasSent&&failure.outcome==='not-run')row.inserted='no';
      // The row was written: its answer may still come, after the deadline or after a failed read (§7.8-6).
      if(wasSent&&extra.late)this.rememberLate(link,{controlId:wasSent.controlId,source:wasSent.sourceEndpointId,
        channel:extra.late.channel,header:extra.late.header,operation:extra.late.operation,bootId:extra.late.bootId,
        ...(extra.late.requestId?{requestId:extra.late.requestId}:{}),rememberedAt:this.now(),row});
      return {failure,sent:!!wasSent};
    }
  }

  /** The link's session, or a new one (hello). A session pinned to another endpoint, or silent too long, is replaced. */
  private async session(connection:Connection,link:Link,target:Target,deadline:number):Promise<Session>{
    let source:{deviceId:string;endpointId:string}|null;
    try{source=await this.deps.dialogue.controlSource();}
    catch(error){throw profileError(error)?computerUseRemoteError('REMOTE_PROFILE_REQUIRED'):new ComputerUseRemoteError('REMOTE_DEVICE_UNKNOWN',DEVICES_UNREADABLE);}
    if(!source)throw computerUseRemoteError('REMOTE_NOT_IN_COMMUNITY');
    const current=link.session;
    if(current&&current.source===source.endpointId&&this.now()-current.lastExchangeAt<COMPUTER_USE_REMOTE_SESSION_STALE_MS){
      if(this.deps.identity){
        if(!current.authentication)throw computerUseRemoteError('REMOTE_BAD_REQUEST');
        if(current.authentication.expiresAt<=this.now()+30_000){
          const own=await this.deps.identity.currentAuthorization('agent'),peers=await this.deps.identity.directory('agent');
          const peer=peers.find(p=>p.body.agentDeviceId===link.deviceId);
          if(!peer||own.body.agentDeviceId!==source.deviceId||own.policyDigest!==current.authentication.ownHash||peer.policyDigest!==current.authentication.peerHash){this.closeSession(link,current);throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');}
          current.authentication.expiresAt=Math.min(own.body.expiresAt,peer.body.expiresAt);
        }
      }
      return current;
    }
    if(current)this.closeSession(link,current);
    return this.hello(connection,link,target,source,deadline);
  }
  /** §7.2: an ephemeral key per attempt (never reused), the connection tag and this Mac's platform. One retry of a read failure. */
  private async hello(connection:Connection,link:Link,target:Target,source:{deviceId:string;endpointId:string},deadline:number):Promise<Session>{
    if(this.deps.identity)return this.authenticatedHello(connection,link,target,source,deadline);
    const device=this.device(link.deviceId);
    let last:ComputerUseRemoteClassified=failureOf('REMOTE_NO_ANSWER');
    for(let attempt=0;attempt<2;attempt++){
      const now=this.now();
      device.hellos=device.hellos.filter(at=>now-at<HELLO_WINDOW_MS);
      if(device.hellos.length>=this.limits.helloPerDevicePerMinute)throw computerUseRemoteError('REMOTE_RATE_LIMITED');
      const remaining=deadline-now;
      if(remaining<=0)throw computerUseRemoteError('REMOTE_SESSION_PENDING');
      device.hellos.push(now);
      const {keyPair,publicKey}=await generateComputerUseRemoteKeyPair();
      const id=newComputerUseRemoteId(),platform=this.platform;
      const envelope:ComputerUseRemoteEnvelope={kind:COMPUTER_USE_REMOTE_KIND,v:COMPUTER_USE_REMOTE_VERSION,op:'hello',session:id,seq:0,
        sentAt:this.now(),pub:publicKey,instance:connection.tag,platform};
      let pinned=source.endpointId,addressed:string|null=null;
      const exchange=await this.exchange(link,target,envelope,Math.min(this.limits.helloTimeoutMs,remaining),{operation:'hello'},
        {source:source.endpointId,onSent:(endpoint,targetDeviceId)=>{pinned=endpoint;addressed=targetDeviceId;}});
      if('failure' in exchange){
        last=exchange.failure;
        this.noteRemote(link.deviceId,last.code);
        if(last.outcome==='not-run')throw new ClassifiedFailure(last);
        continue;
      }
      if(addressed!==null&&(addressed as string).toLowerCase()!==link.deviceId){
        // The database delivered to another device than the list named: never talk to it.
        throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');
      }
      const response=exchange.response;
      if(response.ok===false){
        last=classifyComputerUseRemoteRefusal(response.error,{operation:'hello'});
        this.noteRemote(link.deviceId,last.code);
        if(last.outcome==='not-run')throw new ClassifiedFailure(last);
        continue;
      }
      try{
        if(response.ok!==true)throw Error();
        const reply=parseComputerUseRemoteReply('hello',response.body);
        const channel=await ComputerUseRemoteChannel.establish({side:'sender',privateKey:keyPair.privateKey,peerPublicKey:reply.pub,clock:this.now,
          binding:{session:id,senderDeviceId:source.deviceId,receiverDeviceId:link.deviceId,instance:connection.tag,platform}});
        const at=this.now();
        if(link.bootId!==null&&link.bootId!==reply.bootId)this.bootChanged(connection,link.deviceId,reply.bootId);
        link.bootId=reply.bootId;
        const session:Session={id,channel,bootId:reply.bootId,source:pinned,seq:0,labelsSent:false,openedAt:at,lastExchangeAt:at,lastHeartbeatAt:at};
        link.session=session;
        this.startTicking();
        return session;
      }catch{last=classifyComputerUseRemoteBadAnswer({operation:'hello'});}
    }
    // Without a session the request itself never went out: whatever the hello's own failure, the request is not run.
    let message=last.message;
    if(last.code==='REMOTE_NO_ANSWER'){
      const seen=target.lastSeenAt?Date.parse(target.lastSeenAt):Number.NaN;
      const minutes=Number.isFinite(seen)?Math.max(0,Math.floor((this.now()-seen)/60_000)):undefined;
      message=computerUseRemoteError('REMOTE_NO_ANSWER',minutes===undefined?{}:{lastSeenMinutes:minutes}).message;
    }
    throw new ClassifiedFailure({outcome:'not-run',code:last.code==='REMOTE_UNKNOWN_OUTCOME'||last.code==='REMOTE_STATE_UNKNOWN'?'REMOTE_NO_ANSWER':last.code,message});
  }
  /** No downgrade: the native component path proves both identities and both ephemeral key holders before use. */
  private async authenticatedHello(connection:Connection,link:Link,target:Target,source:{deviceId:string;endpointId:string},deadline:number):Promise<Session>{
    const identity=this.deps.identity!,device=this.device(link.deviceId),now=this.now();
    device.hellos=device.hellos.filter(at=>now-at<HELLO_WINDOW_MS);
    if(device.hellos.length>=this.limits.helloPerDevicePerMinute)throw computerUseRemoteError('REMOTE_RATE_LIMITED');device.hellos.push(now);
    const own=await identity.currentAuthorization('agent'),peers=await identity.directory('agent'),matches=peers.filter(p=>p.body.agentDeviceId===link.deviceId);
    if(own.body.agentDeviceId!==source.deviceId||matches.length!==1)throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');const peer=matches[0]!;
    const {keyPair,publicKey}=await generateComputerUseRemoteKeyPair(),id=newComputerUseRemoteId();
    const hello:AuthenticatedComputerUseHello={kind:'computer-use',v:2,op:'hello',session:id,seq:0,sentAt:this.now(),pub:publicKey,instance:connection.tag,platform:'darwin',nonce:computerUseAuthNonce(),authorization:own.envelope,expectedReceiver:peer.body.deviceId};
    const first=await this.exchange(link,target,hello as unknown as Record<string,unknown>,Math.min(this.limits.helloTimeoutMs,deadline-this.now()),{operation:'hello'},{source:source.endpointId});
    if('failure' in first)throw new ClassifiedFailure({...first.failure,outcome:'not-run'});
    if(first.response.ok!==true)throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const reply=communityObject(first.response.body,['v','pub','bootId','nonce','authorization','proof','confirmation']);
    if(reply.v!==2||typeof reply.pub!=='string'||typeof reply.bootId!=='string'||typeof reply.nonce!=='string'||typeof reply.proof!=='string')throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const certified=await identity.verifyAuthorization(reply.authorization as any,peer.body.deviceId);
    if(certified.policyDigest!==peer.policyDigest)throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');
    const transcript=computerUseAuthenticatedTranscript({sender:own,receiver:certified,hello,reply:{pub:reply.pub,bootId:reply.bootId,nonce:reply.nonce}});
    if(!await verifyCommunityComponentPeerProof(transcript,'receiver',certified,reply.proof,this.now()))throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const confirmation=await ComputerUsePeerConfirmation.create(transcript,'sender',keyPair.privateKey);await confirmation.verify(reply.confirmation);
    const proof=await identity.signHandshake('agent','sender',transcript,own,certified);
    const final=await this.exchange(link,target,{kind:'computer-use',v:2,op:'confirm',session:id,seq:0,sentAt:this.now(),proof:communityBase64(proof),confirmation:await confirmation.proof()},Math.min(this.limits.helloTimeoutMs,deadline-this.now()),{operation:'hello'},{source:source.endpointId});
    if('failure' in final)throw new ClassifiedFailure({...final.failure,outcome:'not-run'});
    if(final.response.ok!==true)throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const accepted=communityObject(final.response.body,['v','session','bootId','confirmation']);
    if(accepted.v!==2||accepted.session!==id||accepted.bootId!==reply.bootId)throw computerUseRemoteError('REMOTE_BAD_REQUEST');await confirmation.verify(accepted.confirmation,true);
    if(!own.permits('agent',this.now())||!certified.permits('agent',this.now()))throw computerUseRemoteError('REMOTE_BAD_REQUEST');
    const channel=await ComputerUseRemoteChannel.establish({side:'sender',privateKey:keyPair.privateKey,peerPublicKey:reply.pub,clock:this.now,
      binding:{session:id,senderDeviceId:source.deviceId,receiverDeviceId:link.deviceId,instance:connection.tag,platform:'darwin',authenticationHash:confirmation.transcriptHash}});
    if(link.bootId!==null&&link.bootId!==reply.bootId)this.bootChanged(connection,link.deviceId,reply.bootId);link.bootId=reply.bootId;
    const at=this.now(),session:Session={id,channel,bootId:reply.bootId,source:source.endpointId,seq:0,labelsSent:false,openedAt:at,lastExchangeAt:at,lastHeartbeatAt:at,
      authentication:{ownHash:own.policyDigest,peerHash:certified.policyDigest,expiresAt:Math.min(own.body.expiresAt,certified.body.expiresAt)}};
    link.session=session;this.startTicking();return session;
  }
  /** B restarted: every open input of the earlier boot can no longer be settled (§7.7, §7.8-7). */
  private bootChanged(connection:Connection,deviceId:string,bootId:string){
    for(const binding of connection.bindings.values())
      if(binding.deviceId===deviceId&&binding.state!=='settled'&&binding.bootId!==bootId)this.settle(binding);
  }
  /** Ends a session here and tells B (best effort, a sealed disconnect). Nothing waits for it. */
  private closeSession(link:Link,session:Session){
    if(link.session===session)link.session=null;
    // After whatever the link is doing now, so the old session's seqs stay in order.
    void this.serial(link,()=>this.background(link,session,'disconnect')).catch(()=>undefined);
  }
  /** A sealed, empty `bg:1` heartbeat or disconnect. Best effort: it never blocks a call and is never retried. */
  private async background(link:Link,session:Session,op:'heartbeat'|'disconnect'){
    if(op==='heartbeat'&&link.session!==session)return;
    const seq=session.seq+1,sentAt=this.now();
    session.seq=seq;
    const box=await session.channel.sealRequest({op,seq,sentAt},{});
    const envelope:ComputerUseRemoteEnvelope={kind:COMPUTER_USE_REMOTE_KIND,v:COMPUTER_USE_REMOTE_VERSION,op,session:session.id,seq,sentAt,bg:1,box};
    let exchange:Exchange;
    try{exchange=await this.exchange(link,{deviceId:link.deviceId,endpointId:link.targetEndpointId,name:link.deviceName,lastSeenAt:null,self:''},envelope,
      op==='disconnect'?DISCONNECT_TIMEOUT_MS:HEARTBEAT_TIMEOUT_MS,{operation:op},{});}
    catch{return;} // over the row limits: skipped
    if('failure' in exchange)return;
    const response=exchange.response;
    if(response.ok===false){
      if(classifyComputerUseRemoteRefusal(response.error,{operation:op}).code==='REMOTE_SESSION_MISSING'&&link.session===session)link.session=null;
      return;
    }
    try{
      await session.channel.openReply({op,seq,sentAt},parseComputerUseRemoteReply(op,response.body).box);
      if(op==='heartbeat')session.lastExchangeAt=this.now();
    }catch{}
  }

  // ── Late answers (§7.8-6) ─────────────────────────────────────────────────────────────────────────────────────────
  private rememberLate(link:Link,late:LateAnswer){
    link.late.push(late);
    while(link.late.length>this.limits.lateAnswersPerSession)link.late.shift();
  }
  /** Before anything else on the link: collect late answers through the endpoints that sent them, and settle their inputs. */
  private async collectLate(connection:Connection,link:Link){
    const now=this.now();
    link.late=link.late.filter(late=>now-late.rememberedAt<this.limits.lateAnswerMemoryMs);
    const bySource=new Map<string,LateAnswer[]>();
    for(const late of link.late)bySource.set(late.source,[...bySource.get(late.source)??[],late]);
    for(const [source,group] of bySource){
      let read:AgentDialogueControlResults;
      try{read=await this.deps.dialogue.controlResult(group.map(late=>late.controlId),source);}
      catch(error){
        // That endpoint is gone: its late answers cannot be read any more; their receipts decide (§7.8-6).
        if(/SOURCE_UNAVAILABLE/.test(`${errorCode(error)} ${(error as Error)?.message??''}`))link.late=link.late.filter(late=>late.source!==source);
        continue;
      }
      const waiting=new Set(read.waiting);
      for(const late of group){
        const answered=read.results.find(row=>row.controlId===late.controlId);
        if(answered){late.row.answered=true;await this.settleLate(connection,late,answered.response);}
        if(answered||!waiting.has(late.controlId))link.late=link.late.filter(item=>item!==late);
      }
    }
  }
  /**
   * A late answer settles this route's gate for its input: an actual receipt in it is kept (with the boot of the session
   * that sent the input) and answers the next receipt; a certain not-run only opens the gate — a receipt then asks the
   * other Mac, whose answer the MCP judges.
   */
  private async settleLate(connection:Connection,late:LateAnswer,response:Record<string,unknown>|null){
    if(!late.requestId)return; // a read or a state change: the AI reads again
    const binding=connection.bindings.get(late.requestId);
    if(!binding||binding.state==='settled'||!response)return;
    if(response.ok===false){
      const failure=classifyComputerUseRemoteRefusal(response.error,{operation:late.operation as ComputerUseRemoteClassifyOptions['operation'],requestId:late.requestId});
      if(failure.outcome==='not-run')this.settle(binding);
      return;
    }
    try{
      const reply=parseComputerUseRemoteReply('call',response.body);
      if(reply.parts!==1)return;
      const opened=await late.channel.openReply(late.header,reply.box);
      const content=parseComputerUseRemoteReplyContent(opened.meta,opened.attachment);
      if(content.kind==='error'){if(content.outcome==='not-run')this.settle(binding);return;}
      const receipt=parseComputerUseRemoteReceipt(content.result.receipt);
      if(receipt&&receipt.requestId===late.requestId&&ACTUAL.includes(receipt.state))this.settle(binding,this.storedReceipt(late.bootId,receipt,content.result));
    }catch{}
  }

  // ── This route's gate ─────────────────────────────────────────────────────────────────────────────────────────────
  /** Ends an input's gate entry; `stored` is a receipt the other Mac answered for it, kept to answer receipts. */
  private settle(binding:Binding,stored?:ComputerUseRemoteReceiptAnswer){
    binding.state='settled';
    if(stored)binding.stored=stored;else delete binding.stored;
  }
  /**
   * An actual receipt the other Mac sent in an input's own answer (or its late answer), as its receipt answer would carry
   * it: with the boot of the session the input went out on. `evictedThroughSentAt` is null — it only qualifies `unseen`,
   * and this is a positive record. Undefined when the shape does not pass the receipt-answer parser.
   */
  private storedReceipt(bootId:string|null,receipt:ComputerUseRemoteReceipt,result:Record<string,unknown>):ComputerUseRemoteReceiptAnswer|undefined{
    if(!bootId)return undefined;
    const guidance=typeof result.guidance==='string'?computerUseRemoteCleanText(result.guidance,1000):'';
    const parsed=parseComputerUseRemoteReceiptAnswer({success:true,bootId,evictedThroughSentAt:null,receipt,
      ...(['human','person','agent'].includes(result.owner as string)?{owner:result.owner}:{}),...(guidance?{guidance}:{})});
    return parsed?{...parsed,success:true}:undefined;
  }
  /** The gate's memory: an open entry past sentAt + 10 min is settled (the MCP calls it unknown-final); anything past 15 min is forgotten. */
  private expire(connection:Connection){
    const now=this.now();
    for(const [requestId,binding] of connection.bindings){
      if(now-binding.sentAt>=this.limits.bindingTtlMs){connection.bindings.delete(requestId);continue;}
      if(binding.state==='open'&&!computerUseRemoteLedgerOpen(binding,now))this.settle(binding);
    }
    for(const [grant,bound] of connection.grants)if(now-bound.at>=this.limits.bindingTtlMs)connection.grants.delete(grant);
    // Answered inputs are kept for their receipts only; past the cap the oldest answered go first, never an open one.
    for(const [requestId,binding] of connection.bindings){
      if(connection.bindings.size<=BINDINGS_MAX)break;
      if(binding.state==='settled')connection.bindings.delete(requestId);
    }
  }
  private worstOutcome(operation:string):ComputerUseRemoteOutcome{
    const effect=computerUseRemoteEffect(operation);
    return effect==='read'?'read':effect==='state-change'?'state-unknown':'unknown';
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────────────────────────────────────────────
  private async connection(instance:unknown):Promise<Connection>{
    if(typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw new ComputerUseRemoteError('REMOTE_BAD_REQUEST','AI 연결을 확인하지 못했습니다. AI 연결을 다시 여세요.');
    const now=this.now();
    let connection=this.connections.get(instance);
    if(!connection){
      this.prune(now);
      if(this.connections.size>=CONNECTIONS_MAX)throw computerUseRemoteError('REMOTE_RATE_LIMITED');
      connection={instance,tag:await computerUseRemoteConnectionTag(instance),links:new Map(),bindings:new Map(),grants:new Map(),mcpHeartbeatAt:now,seenAt:now};
      this.connections.set(instance,connection);
    }
    connection.seenAt=now;
    return connection;
  }
  /**
   * An MCP connection that is gone: no heartbeat and no request for COMPUTER_USE_REMOTE_MCP_ALIVE_MS (a live MCP beats every
   * 20 s once it used another Mac), and nothing of it in flight.
   */
  private silent(connection:Connection,now:number):boolean{
    return now-Math.max(connection.mcpHeartbeatAt,connection.seenAt)>=COMPUTER_USE_REMOTE_MCP_ALIVE_MS
      &&![...connection.links.values()].some(link=>link.busy>0);
  }
  /**
   * Forgets MCP connections that are gone, open sessions and gate entries included — a killed or crashed MCP never sends
   * `disconnect`, and kept connections would fill the 64 places for good. Their sessions are closed (a best-effort sealed
   * disconnect; B's lease would end them anyway, as nothing is forwarded for a silent connection). Their gate entries go
   * with them: that MCP instance does not come back (a new process has a new instance), and if it does ask a receipt
   * after all, the other Mac's ledger answers it and the MCP judges it.
   */
  private prune(now:number){
    for(const [instance,connection] of this.connections){
      this.expire(connection);
      if(!this.silent(connection,now))continue;
      this.closeConnection(connection);
      this.connections.delete(instance);
    }
  }
  private link(connection:Connection,target:Target,caller:ComputerUseRemoteCaller):Link{
    let link=connection.links.get(target.deviceId);
    if(!link){
      link={deviceId:target.deviceId,targetEndpointId:target.endpointId,deviceName:target.name,client:null,queue:Promise.resolve(),busy:0,session:null,bootId:null,late:[],lastCallAt:0};
      connection.links.set(target.deviceId,link);
    }
    link.targetEndpointId=target.endpointId;link.deviceName=target.name;
    const client=computerUseRemoteCleanText(caller.client??'',40);if(client)link.client=client;
    return link;
  }
  /** Every request of one (connection, device) runs after the previous one: seqs reach B in order, and only one hello. */
  private serial<T>(link:Link,work:()=>Promise<T>):Promise<T>{
    link.busy+=1;
    const run=link.queue.then(work,work);
    link.queue=run.catch(()=>undefined);
    return run.finally(()=>{link.busy-=1;});
  }
  private device(deviceId:string):DeviceState{
    let state=this.devicesState.get(deviceId);
    if(!state){state={rows:[],hellos:[],lastCaptureAt:null,remote:null};this.devicesState.set(deviceId,state);}
    return state;
  }
  /**
   * §8.7 per target device: rows without an answer that may still be taken (sent in the last 130 s) at most 8, and rows
   * without an answer in the last ten minutes at most 24, so this Mac's 64 open rows per endpoint stay free for others.
   */
  private reserveRow(deviceId:string):Row{
    const state=this.device(deviceId),now=this.now();
    state.rows=state.rows.filter(row=>row.inserted!=='no'&&!row.answered&&now-row.sentAt<this.limits.unansweredWindowMs);
    const awaiting=state.rows.filter(row=>now-row.sentAt<this.limits.awaitingReleaseMs).length;
    if(awaiting>=this.limits.awaitingRowsPerDevice||state.rows.length>=this.limits.unansweredRowsPerDevice)throw computerUseRemoteError('REMOTE_RATE_LIMITED');
    const row:Row={sentAt:now,answered:false,inserted:'unknown'};
    state.rows.push(row);
    return row;
  }
  private async target(device:string):Promise<Target>{
    let listed:Awaited<ReturnType<ComputerUseRemoteDialogue['controlDevices']>>;
    try{listed=await this.deps.dialogue.controlDevices();}
    catch(error){throw profileError(error)?computerUseRemoteError('REMOTE_PROFILE_REQUIRED'):new ComputerUseRemoteError('REMOTE_DEVICE_UNKNOWN',DEVICES_UNREADABLE);}
    if(!listed.inside)throw computerUseRemoteError('REMOTE_NOT_IN_COMMUNITY');
    const ref=device.toLowerCase(),self=listed.deviceId.toLowerCase();
    if(ref===self)throw computerUseRemoteError('REMOTE_SELF');
    // `device` is a deviceId; an endpointId from list_ops_devices names the same Mac.
    const row=listed.devices.find(item=>item.deviceId.toLowerCase()===ref)??listed.devices.find(item=>item.endpointId.toLowerCase()===ref);
    if(!row)throw computerUseRemoteError('REMOTE_DEVICE_UNKNOWN');
    if(row.deviceId.toLowerCase()===self)throw computerUseRemoteError('REMOTE_SELF');
    return {deviceId:row.deviceId.toLowerCase(),endpointId:row.endpointId,name:computerUseRemoteCleanText(row.displayName,60)||row.deviceId.slice(0,8),lastSeenAt:row.lastSeenAt,self};
  }
  /** What a refusal says about the device, for `devices`. */
  private noteRemote(deviceId:string,code:string|undefined){
    const state:ComputerUseRemoteDeviceState|null=code==='REMOTE_HOST_OUTDATED'?'outdated':code==='REMOTE_UNSUPPORTED'?'unsupported'
      :code==='REMOTE_BLOCKED_BY_PERSON'||code==='REMOTE_DEVICE_BLOCKED'?'blocked-by-person':code==='REMOTE_NEEDS_STANDING'?'needs-standing'
      :code==='REMOTE_PEER_NOT_READY'||code==='REMOTE_APP_SCOPE_ACTIVE'||code==='REMOTE_RECOVERY_REQUIRED'||code==='REMOTE_NO_ANSWER'?'not-ready':null;
    if(state)this.device(deviceId).remote={state,at:this.now()};
  }
  /** A status answer: the device's readiness, and the grants it holds for this connection (bound to that device). */
  private noteStatus(connection:Connection,link:Link,result:Record<string,unknown>){
    const remote=plain(result.remote)?result.remote:null;
    if(remote)this.device(link.deviceId).remote={state:remote.appScope===true?'not-ready':remote.standing===true?'ready':'needs-standing',at:this.now()};
    for(const grant of Array.isArray(result.grants)?result.grants:[]){
      const value=plain(grant)?grant.grant:undefined;
      if(typeof value==='string'&&grantPattern.test(value))connection.grants.set(value,{deviceId:link.deviceId,deviceName:link.deviceName,at:this.now()});
    }
  }
  private closeConnection(connection:Connection):number{
    let closed=0;
    for(const link of connection.links.values())if(link.session){this.closeSession(link,link.session);closed+=1;}
    return closed;
  }
}

/** A classified failure carried through `throw` inside the module (outcome already decided). */
class ClassifiedFailure extends ComputerUseRemoteError {
  constructor(readonly failure:ComputerUseRemoteClassified){
    super(failure.code,failure.message);
    (this as {outcome:ComputerUseRemoteOutcome}).outcome=failure.outcome;
  }
}

// ── The loopback route ──────────────────────────────────────────────────────────────────────────────────────────────
const HEADERS={'Content-Type':'application/json','Cache-Control':'private, no-store'};
const BODY_MAX_BYTES=16_000;
const ANSWER_MAX_BYTES=512_000;
async function readBody(request:Request):Promise<unknown>{
  const reader=request.body?.getReader();if(!reader)throw Error('JSON 요청이 필요합니다.');
  let length=0;const chunks:Uint8Array[]=[];const deadline=Date.now()+5000;
  try{
    while(true){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const remaining=deadline-Date.now();if(remaining<=0)throw Error('요청 시간이 초과됐습니다.');
      const next=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('요청 시간이 초과됐습니다.')),remaining);timer.unref?.();})])
        .finally(()=>{if(timer)clearTimeout(timer);});
      if(next.done)break;length+=next.value.length;if(length>BODY_MAX_BYTES)throw Error('요청 크기를 줄여 주세요.');chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
/**
 * `POST COMPUTER_USE_REMOTE_AGENT_PATH` — the same gate as the local agent route (src/computerUseApi.ts): `authorized`
 * is the profile token checked by the server with no Origin; a local JSON POST of at most 16,000 bytes. `opsWorker` and
 * `host` are the server's own readings of the caller (its Workroom hint, its host app); they authorize nothing.
 */
export async function handleComputerUseRemote(request:Request,client:()=>ComputerUseRemoteClient,
  options:{authorized:boolean;opsWorker?:()=>Promise<boolean>;host?:()=>Promise<string|null>}):Promise<Response>{
  if(!options.authorized)return Response.json({success:false,error:'이 연결에서 컴퓨터 유즈를 쓸 수 없습니다.'},{status:403,headers:HEADERS});
  try{
    const url=new URL(request.url);
    if(request.method!=='POST'||url.search||request.headers.get('content-type')?.split(';')[0]!=='application/json'||request.headers.has('origin'))
      throw Error('로컬 JSON POST만 허용합니다.');
    const body=await readBody(request);
    let host:string|null=null;
    try{host=await options.host?.()??null;}catch{host=null;}
    const result=await client().agent({instance:request.headers.get(COMPUTER_USE_INSTANCE_HEADER),client:request.headers.get(COMPUTER_USE_CLIENT_HEADER),
      host,...(options.opsWorker?{opsWorker:options.opsWorker}:{})},body);
    const encoded=JSON.stringify(result);
    if(Buffer.byteLength(encoded)>ANSWER_MAX_BYTES)throw Error('응답 한도를 초과했습니다.');
    return new Response(encoded,{headers:HEADERS});
  }catch(error){
    const code=error instanceof ComputerUseRemoteError?{code:error.code,outcome:error.outcome}:{};
    return Response.json({success:false,error:error instanceof Error?error.message:'컴퓨터 유즈 결과를 확인하지 못했습니다.',...code},{status:400,headers:HEADERS});
  }
}
