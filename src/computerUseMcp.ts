import {parseComputerAgentRequest} from './computerUseProtocol';
import {parseComputerScopeAgentRequest} from './computerUseScopeProtocol';
import {computerUseScopeMcpCall} from './computerUseScopeMcp';
import {
  COMPUTER_USE_REMOTE_ERRORS,COMPUTER_USE_REMOTE_LIMITS,COMPUTER_USE_REMOTE_NOT_THIS_CONNECTION_MESSAGE,
  ComputerUseRemoteError,computerUseRemoteEffect,computerUseRemoteErrorMessage,isComputerUseRemoteInput,
  parseComputerUseRemoteReceiptAnswer,remoteReceiptVerdict,
  type ComputerUseRemoteErrorCode,type ComputerUseRemoteLedgerEntry,type ComputerUseRemoteOutcome,type ComputerUseRemoteReceiptVerdict,
} from './computerUseRemoteProtocol';
export const COMPUTER_USE_MCP_TOOL={
  name:'agentstoz_use_computer',
  // Claude Code truncates long MCP text: keep onboarding and safety first, and the whole text short.
  description:'Use one Mac window a person approved in AgentsToZ Control, through background Accessibility actions. First call status; the person then selects this MCP connection and one window in AgentsToZ Tools and Settings → Computer Use and approves in Control with Touch ID. A connection may cover several chats of an app; do not claim per-chat isolation. Observe before every action; human activity pauses or refuses input. capture returns an image only when screen images were approved for that grant in Control and macOS Screen Recording is allowed. click takes window-relative points (image pixel × windowWidth/width and × windowHeight/height), needs a capture of the same observation and presses only an exactly observed accessible control. No global mouse, arbitrary keys, canvas pixel clicks, process launch or self-approval; agent, terminal and security apps are excluded. Keep request IDs, read receipts after uncertainty and never replay an unknown action.',
  inputSchema:{type:'object',properties:{operation:{type:'string',enum:['status','observe','capture','click','press','set-value','receipt','request-human']},grant:{type:'string'},epoch:{type:'integer'},requestId:{type:'string'},observationId:{type:'string'},element:{type:'string'},value:{type:'string'},x:{type:'number'},y:{type:'number'}},required:['operation'],additionalProperties:false},
} as const;
/**
 * Return pixels as an MCP image block, not duplicated in text or structured metadata. A result with `success:false` (a
 * refusal or an open outcome from another Mac) is a tool error, but keeps its fields: an unknown outcome is never
 * reported as "not performed".
 */
export function computerUseMcpResult(result:Record<string,unknown>) {
  const image=result.image;
  if(result.success===true&&image&&typeof image==='object'&&!Array.isArray(image)) {
    const {data,mediaType,...dimensions}=image as Record<string,unknown>;
    if(mediaType!=='image/jpeg'||typeof data!=='string'||data.length>320000||!data.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Invalid screen image.');
    const metadata={...result,image:{mediaType,...dimensions}};
    return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',mimeType:mediaType,data}],structuredContent:metadata,isError:false};
  }
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:result.success===false};
}
export function computerUseMcpRequest(value:unknown):Record<string,unknown>{
  if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as any).operation==='string'&&(value as any).operation.startsWith('scope-'))return parseComputerScopeAgentRequest(value);
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&(value as any).operation==='status')return {operation:'status'};
  return parseComputerAgentRequest(value);
}

// ── Another community Mac (DESIGN remote-computer-use §6, §7.8) ────────────────────────────────────────────────────
/** One answer of this Mac's remote route: its HTTP status and JSON body (null when the body was not JSON). */
export interface ComputerUseRemoteHttpAnswer {status:number;body:unknown}
/**
 * Sends one body to this Mac's remote route (src/computerUseScopeMcp.ts COMPUTER_USE_REMOTE_AGENT_PATH). It throws only
 * when no answer arrived. A thrown ComputerUseRemoteError whose outcome is `not-run` means nothing was sent (no profile
 * connection); a thrown error with code `ConnectionRefused` means the route was never reached. Anything else is open.
 */
export type ComputerUseRemoteTransport=(body:Record<string,unknown>)=>Promise<ComputerUseRemoteHttpAnswer>;
/** The fetch deadline of each remote body (§8.7): the route's whole budget is 40 s, the MCP waits 45 s. */
export function computerUseRemoteMcpTimeoutMs(body:Record<string,unknown>):number{
  if(body.operation==='disconnect')return 2_000;
  if(body.operation==='heartbeat'||body.operation==='devices')return 15_000;
  return COMPUTER_USE_REMOTE_LIMITS.mcpFetchMs;
}
/** The MCP process's own codes beside the protocol's (§10). Both are not-run: nothing reached another Mac. */
const HOST_OUTDATED_MESSAGE='이 Mac의 AgentsToZ가 이 MCP보다 오래돼 다른 Mac을 쓸 수 없습니다. AgentsToZ를 업데이트하거나 다시 시작한 뒤, AI CLI 세션도 새로 여세요. 이 Mac에서 대신 실행하지 않았습니다.';
const HOST_UNAVAILABLE_MESSAGE='이 Mac의 AgentsToZ가 실행 중이 아니라 보내지 않았습니다. AgentsToZ를 연 뒤 다시 하세요.';
/** The receipt state the MCP reports (§8.5): an actual receipt, or not-run / in-progress / unknown-final. */
const BOUND_LOCAL='이 Mac(device 없이)';
const NO_BOOT='0'.repeat(32);
const HEX32=/^[0-9a-f]{32}$/;
const plain=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const OUTCOMES:readonly ComputerUseRemoteOutcome[]=['not-run','unknown','state-unknown','read'];
const openOutcome=(outcome:ComputerUseRemoteOutcome|null)=>outcome==='unknown'||outcome==='state-unknown';
const knownCode=(code:unknown):code is ComputerUseRemoteErrorCode=>typeof code==='string'&&Object.hasOwn(COMPUTER_USE_REMOTE_ERRORS,code);
/** The ledger is keyed by device and requestId: one device's entry never overwrites or settles another's. */
const ledgerKey=(device:string,requestId:string)=>device+' '+requestId;
const oneLine=(value:unknown)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,1000):'';
type Target='local'|string;
/** A grant or requestId and where this MCP connection sent it (the binding table, §6). Inputs also keep sentAt and bootId. */
interface Binding {target:Target;touchedAt:number;sentAt?:number;bootId?:string|null}
const MAX_BINDINGS=4096;
interface DeviceDirectory {at:number;self:string|null;devices:Set<string>;endpoints:Map<string,string>}
/** An open input (§7.8-1). bootId is null only when this connection never learnt that device's boot (then `unseen` proves nothing). */
type OpenEntry=Omit<ComputerUseRemoteLedgerEntry,'bootId'>&{bootId:string|null};

/**
 * One transport per MCP process. The secret is sent in a header, never in a tool body or result.
 *
 * For `agentstoz_use_computer_session` (`session`) it also keeps, in this process only (§6, §7.8):
 * - the binding table: each grant and requestId and where it went (this Mac or one device), for 15 minutes. A value is
 *   claimed the moment its call is accepted, before it waits in a lane, and a binding never moves: a value bound to one
 *   place is refused anywhere else (REMOTE_ID_BOUND_ELSEWHERE), and a remote receipt for an ID this connection never
 *   sent there is not asked about (unknown-final): another connection's "unseen" is no evidence;
 * - the unknown-outcome ledger: (device, requestId) → sentAt, that device's bootId. While a device has an entry, new
 *   input to it is refused (REMOTE_BLOCKED_BY_UNKNOWN); reads are not. Only its receipt settles it
 *   (remoteReceiptVerdict). Nothing is ever resent automatically;
 * - one lane per device for inputs, so two inputs are never in flight to one Mac at once.
 * A restart of this process forgets all of it, which only ever makes an answer unknown-final, never "not run".
 */
export class ComputerUseMcpConnection {
  private timer?:ReturnType<typeof setInterval>;
  private active=false;
  private failures=0;
  private remoteActive=false;
  private remoteFailures=0;
  private readonly bindings=new Map<string,Binding>();
  private readonly ledger=new Map<string,OpenEntry>();
  private readonly boots=new Map<string,string>();
  private readonly lanes=new Map<string,Promise<unknown>>();
  private directory:DeviceDirectory|null=null;
  constructor(private readonly request:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>,
    private readonly remote?:ComputerUseRemoteTransport,private readonly clock:()=>number=Date.now){}
  async call(value:unknown){
    const body=computerUseMcpRequest(value),result=await this.request(body);
    if(result.success===true&&!this.active){this.active=true;this.failures=0;this.ensureTimer();}
    return result;
  }
  /** `agentstoz_use_computer_session`: this Mac, the community device list, or another Mac named by `device`. */
  async session(value:unknown):Promise<Record<string,unknown>>{
    const call=computerUseScopeMcpCall(value);this.prune();
    if(call.target==='local')return this.localSession(call.request);
    if(call.target==='devices')return this.devices();
    const resolved=await this.resolveDevice(call.device);
    if(typeof resolved!=='string')return resolved;
    return this.remoteSession(resolved,call.request);
  }
  /** Open unknown outcomes, by device (for tests and the panel; nothing secret). */
  openOutcomes(){return [...this.ledger.values()].map(e=>({requestId:e.requestId,device:e.deviceId,sentAt:e.sentAt}));}

  private async localSession(request:Record<string,any>):Promise<Record<string,unknown>>{
    const conflict=this.claim('local',request,null);if(conflict)return conflict;
    const result=await this.call(request);
    this.learnGrants('local',result);
    return result;
  }
  private async remoteSession(device:string,request:Record<string,any>):Promise<Record<string,unknown>>{
    // Claimed now, before anything waits (RC-7, §6): while this input waits in the device's lane, the same grant or
    // requestId can go neither to this Mac nor to another device.
    const conflict=this.claim(device,request,null);if(conflict)return conflict;
    if(request.operation==='scope-receipt')return this.remoteReceipt(device,request);
    if(!isComputerUseRemoteInput(request.operation))return this.remoteSend(device,request);
    return this.lane(device,async()=>{
      const open=[...this.ledger.values()].find(e=>e.deviceId===device);
      if(open)return this.failure('REMOTE_BLOCKED_BY_UNKNOWN',{device,requestId:open.requestId});
      return this.remoteSend(device,request);
    });
  }
  /** One read, state change or input to another Mac, read with RC-7: an input whose outcome is open enters the ledger. */
  private async remoteSend(device:string,request:Record<string,any>):Promise<Record<string,unknown>>{
    const operation=request.operation,effect=computerUseRemoteEffect(operation),requestId=typeof request.requestId==='string'?request.requestId:undefined;
    const sentAt=this.clock();
    // Checked again right before it goes (the claim made on arrival is re-made if it was pruned meanwhile); this also
    // records the attempt's sentAt and that device's boot on the requestId's binding.
    const conflict=this.claim(device,request,sentAt);if(conflict)return conflict;
    const answer=await this.send({device,...request});
    const echo=answer.body?.device===device;
    if(echo)this.noteBoot(device,answer.body?.bootId);
    const open=(bootId:unknown)=>{
      if(effect==='input'&&requestId){
        this.ledger.set(ledgerKey(device,requestId),{requestId,deviceId:device,sentAt,bootId:HEX32.test(String(bootId))?String(bootId):this.boots.get(device)??null});
        return {success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',state:'unknown',device,requestId,
          error:computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId})};
      }
      if(effect==='state-change')return {success:false,code:'REMOTE_STATE_UNKNOWN',outcome:'state-unknown',device,error:COMPUTER_USE_REMOTE_ERRORS.REMOTE_STATE_UNKNOWN.message};
      return this.failure(answer.kind==='lost'?'REMOTE_NO_ANSWER':'REMOTE_BAD_ANSWER',{device});
    };
    if(answer.kind==='refused')return {...answer.result,device};
    if(answer.kind==='lost'||!plain(answer.body))return open(undefined);
    const body=answer.body;
    if(body.success===true){
      if(!echo){
        // A read is discarded; a route that does not echo at all predates this contract.
        if(effect==='read')return body.device===undefined?this.failure('AGENTSTOZ_USE_HOST_OUTDATED',{device}):this.failure('REMOTE_BAD_ANSWER',{device});
        return open(undefined);
      }
      // An input answer is its receipt: one missing, or about another request, is not this input's outcome.
      if(effect==='input'&&(!plain(body.receipt)||body.receipt.requestId!==requestId))return open(body.bootId);
      this.learnGrants(device,body);
      return body;
    }
    // A failure. Its outcome is the stricter of the route's claim and its code's own outcome: an open one (unknown,
    // state-unknown) on either side is never weakened by the other side's not-run. Not run is believed only from the
    // route that read this body (its echo); an unclaimed input failure is open.
    const claimed=OUTCOMES.includes(body.outcome)?body.outcome as ComputerUseRemoteOutcome:null;
    const implied=knownCode(body.code)?COMPUTER_USE_REMOTE_ERRORS[body.code].outcome:null;
    const outcome=openOutcome(claimed)?claimed:openOutcome(implied)?implied:claimed??implied;
    if(openOutcome(outcome)||effect!=='read'&&(!echo||outcome!=='not-run'))return open(echo?body.bootId:undefined);
    const code=typeof body.code==='string'&&/^[A-Z_]{3,60}$/.test(body.code)?body.code:effect==='read'?'REMOTE_BAD_ANSWER':'REMOTE_NOT_RUN';
    return {success:false,code,outcome:outcome??(effect==='read'?'read':'not-run'),device,...(requestId?{requestId}:{}),
      error:oneLine(body.error)||(knownCode(code)?COMPUTER_USE_REMOTE_ERRORS[code].message:'그 Mac의 컴퓨터 유즈가 이 요청을 거절했습니다.')};
  }
  /**
   * §7.8-3..7: a receipt is asked of the device only for an ID this connection sent there, and is settled against this
   * connection's own record of it (sentAt, the bootId of that time). A settled answer closes the ledger entry.
   */
  private async remoteReceipt(device:string,request:Record<string,any>):Promise<Record<string,unknown>>{
    // remoteSession already claimed the grant and checked that this requestId, if bound, is bound to this device.
    const requestId=String(request.requestId),bound=this.bindings.get('r:'+requestId),key=ledgerKey(device,requestId);
    if(!bound||bound.target!==device||bound.sentAt===undefined)return {success:true,device,receipt:{requestId,state:'unknown-final',reason:'not-this-connection'},guidance:COMPUTER_USE_REMOTE_NOT_THIS_CONNECTION_MESSAGE};
    // The latest attempt's record: the open entry if there is one, else what the binding kept when it was sent.
    const entry:OpenEntry=this.ledger.get(key)??{requestId,deviceId:device,sentAt:bound.sentAt,bootId:bound.bootId??null};
    const answer=await this.send({device,...request});
    const body=answer.kind==='answer'&&plain(answer.body)&&answer.body.device===device?answer.body:null;
    if(body)this.noteBoot(device,body.bootId);
    const raw=body?.success===true?{success:true,bootId:body.bootId,evictedThroughSentAt:body.evictedThroughSentAt,receipt:body.receipt,
      ...('owner'in body?{owner:body.owner}:{}),...('guidance'in body?{guidance:body.guidance}:{})}:undefined;
    const verdict=this.verdict(entry,raw);bound.touchedAt=this.clock();
    if(verdict.settled)this.ledger.delete(key);
    switch(verdict.verdict){
      case 'receipt':return {success:true,device,receipt:verdict.receipt,...(verdict.owner?{owner:verdict.owner}:{}),...(verdict.guidance?{guidance:verdict.guidance}:{})};
      case 'not-run':return {success:true,device,receipt:{requestId,state:'not-run',reason:verdict.reason},guidance:verdict.message};
      case 'unknown-final':return {success:true,device,receipt:{requestId,state:'unknown-final',reason:verdict.why},guidance:verdict.message};
      default:{
        if(verdict.why==='in-progress')return {success:true,device,receipt:{requestId,state:'in-progress'},guidance:verdict.message};
        // The receipt itself was not answered (or not readably): ask again; the entry stays open.
        const failed=answer.kind==='refused'?answer.result.code:body&&body.success!==true&&typeof body.code==='string'?body.code:answer.kind==='answer'?'REMOTE_BAD_ANSWER':'REMOTE_NO_ANSWER';
        return {success:false,code:failed,outcome:'read',device,requestId,error:verdict.message};}
    }
  }
  /** remoteReceiptVerdict, with a positive record (an actual receipt, not-run, in-progress) still read when this connection never learnt the bootId. */
  private verdict(entry:OpenEntry,raw:unknown):ComputerUseRemoteReceiptVerdict{
    if(entry.bootId)return remoteReceiptVerdict({...entry,bootId:entry.bootId},raw,this.clock());
    const parsed=parseComputerUseRemoteReceiptAnswer(raw);
    const positive=parsed&&!['unseen','evicted'].includes(parsed.receipt.state);
    return remoteReceiptVerdict({...entry,bootId:positive?parsed!.bootId:NO_BOOT},raw,this.clock());
  }
  private async devices():Promise<Record<string,unknown>>{
    const answer=await this.send({operation:'devices'});
    if(answer.kind==='refused')return answer.result;
    const body=answer.kind==='answer'&&plain(answer.body)?answer.body:null;
    if(body?.success===true&&Array.isArray(body.devices)){this.learnDirectory(body);return body;}
    // The route's own refusal (no community, no profile connection) keeps its code; anything else is a failed read.
    return this.failure(knownCode(body?.code)?body!.code:body?'REMOTE_BAD_ANSWER':'REMOTE_NO_ANSWER',{},oneLine(body?.error));
  }
  /** `device` is a deviceId; an endpointId of that device is converted (§6). This Mac and unknown devices are refused here. */
  private async resolveDevice(value:string):Promise<string|Record<string,unknown>>{
    const now=this.clock(),known=()=>{
      const d=this.directory;if(!d)return null;
      if(value===d.self)return this.failure('REMOTE_SELF',{device:value});
      return d.devices.has(value)?value:d.endpoints.get(value)??null;
    };
    const hit=known();if(hit)return hit;
    if(this.directory&&now-this.directory.at<5_000)return this.failure('REMOTE_DEVICE_UNKNOWN',{device:value});
    const listed=await this.devices();if(listed.success!==true)return listed;
    return known()??this.failure('REMOTE_DEVICE_UNKNOWN',{device:value});
  }
  private learnDirectory(body:Record<string,any>){
    const id=(v:unknown)=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v)?v.toLowerCase():null;
    const devices=new Set<string>(),endpoints=new Map<string,string>();
    for(const row of (body.devices as unknown[]).slice(0,256)){
      if(!plain(row))continue;const device=id(row.device)??id(row.deviceId);if(!device)continue;
      devices.add(device);const endpoint=id(row.endpointId);if(endpoint)endpoints.set(endpoint,device);
    }
    this.directory={at:this.clock(),self:id(body.deviceId),devices,endpoints};
  }
  /** Sends one body. Never throws: `refused` = certainly not sent, `lost` = no answer (the outcome is open), `answer` = HTTP answer. */
  private async send(body:Record<string,unknown>):Promise<{kind:'answer';body:Record<string,any>|null;status:number}|{kind:'lost';body?:undefined}|{kind:'refused';result:Record<string,any>;body?:undefined}>{
    if(!this.remote)return {kind:'refused',result:this.failure('AGENTSTOZ_USE_HOST_OUTDATED',{})};
    let answer:ComputerUseRemoteHttpAnswer;
    try{answer=await this.remote(body);}
    catch(error){
      if(error instanceof ComputerUseRemoteError&&error.outcome==='not-run')return {kind:'refused',result:this.failure(error.code,{},error.message)};
      if((error as {code?:unknown})?.code==='ConnectionRefused')return {kind:'refused',result:this.failure('AGENTSTOZ_USE_HOST_UNAVAILABLE',{})};
      return {kind:'lost'};
    }
    const parsed=plain(answer.body)?answer.body:null;
    // An AgentsToZ from before the route answers its generic 404 ({error:'Not found'}, no echo): nothing was run, here or
    // anywhere (never "run it on this Mac instead"). A 404 that echoes a device or names a known code came from the
    // route itself and is read like any other answer, so an input's outcome there stays open.
    if(answer.status===404&&!(parsed&&(Object.hasOwn(parsed,'device')||knownCode(parsed.code))))
      return {kind:'refused',result:this.failure('AGENTSTOZ_USE_HOST_OUTDATED',{})};
    // A remote session may exist now: keep its lease through this Mac's route until close (RC-9 — the route forwards).
    if(body.device!==undefined&&!this.remoteActive){this.remoteActive=true;this.remoteFailures=0;this.ensureTimer();}
    return {kind:'answer',body:parsed,status:answer.status};
  }
  private failure(code:ComputerUseRemoteErrorCode|'AGENTSTOZ_USE_HOST_OUTDATED'|'AGENTSTOZ_USE_HOST_UNAVAILABLE',
    detail:{device?:string;requestId?:string;boundTo?:string},message?:string):Record<string,any>{
    const outcome:ComputerUseRemoteOutcome=knownCode(code)?COMPUTER_USE_REMOTE_ERRORS[code].outcome:'not-run';
    const error=message||(code==='AGENTSTOZ_USE_HOST_OUTDATED'?HOST_OUTDATED_MESSAGE:code==='AGENTSTOZ_USE_HOST_UNAVAILABLE'?HOST_UNAVAILABLE_MESSAGE
      :computerUseRemoteErrorMessage(code,{requestId:detail.requestId,boundTo:detail.boundTo}));
    return {success:false,code,outcome,...(detail.device?{device:detail.device}:{}),...(detail.requestId?{requestId:detail.requestId}:{}),error};
  }
  /**
   * Checks and binds in one synchronous step, so no other call can take a value between the two: a grant or requestId
   * already bound to another place (this Mac or another device) is refused (REMOTE_ID_BOUND_ELSEWHERE) and nothing is
   * sent; otherwise the grant (first use) and the requestId (not a receipt's) are bound to `target`. A binding is never
   * moved. With `sentAt` (the moment it is sent) the requestId's binding records that attempt and the device's boot.
   */
  private claim(target:Target,request:Record<string,any>,sentAt:number|null):Record<string,unknown>|null{
    const grantKey=typeof request.grant==='string'?'g:'+request.grant:null;
    const idKey=typeof request.requestId==='string'?'r:'+request.requestId:null;
    for(const key of [grantKey,idKey]){
      const bound=key?this.bindings.get(key):undefined;if(!bound||bound.target===target)continue;
      const requestId=typeof request.requestId==='string'?request.requestId:undefined;
      return {...this.failure('REMOTE_ID_BOUND_ELSEWHERE',{...(target==='local'?{}:{device:target}),requestId,boundTo:bound.target==='local'?BOUND_LOCAL:bound.target}),
        boundDevice:bound.target==='local'?null:bound.target};
    }
    const now=this.clock();
    if(grantKey){const b=this.bindings.get(grantKey);if(b)b.touchedAt=now;else this.bindings.set(grantKey,{target,touchedAt:now});}
    if(idKey&&request.operation!=='scope-receipt'){
      const b=this.bindings.get(idKey);
      // An input records its latest attempt (a requestId resent after a settled answer is a new attempt).
      if(b){b.touchedAt=now;if(sentAt!==null){b.sentAt=sentAt;b.bootId=this.boots.get(target)??null;}}
      else this.bindings.set(idKey,{target,touchedAt:now,...(sentAt!==null?{sentAt,bootId:this.boots.get(target)??null}:{})});
    }
    return null;
  }
  /** A status answer names this connection's grants on that Mac: they belong there. */
  private learnGrants(target:Target,result:Record<string,unknown>){
    if(!Array.isArray(result.grants))return;const now=this.clock();
    for(const g of result.grants.slice(0,64))if(plain(g)&&typeof g.grant==='string'&&/^[a-f0-9]{64}$/.test(g.grant)){
      const key='g:'+g.grant,b=this.bindings.get(key);if(b)b.touchedAt=now;else this.bindings.set(key,{target,touchedAt:now});
    }
  }
  private noteBoot(device:string,bootId:unknown){if(typeof bootId==='string'&&HEX32.test(bootId))this.boots.set(device,bootId);}
  /** Forgets bindings untouched for 15 minutes, except an ID still open in the ledger; and keeps the table bounded. */
  private prune(){
    const now=this.clock(),ttl=COMPUTER_USE_REMOTE_LIMITS.bindingTtlMs;
    const open=new Set([...this.ledger.values()].map(e=>'r:'+e.requestId));
    for(const[key,b]of this.bindings)if(now-b.touchedAt>ttl&&!open.has(key))this.bindings.delete(key);
    if(this.bindings.size<=MAX_BINDINGS)return;
    const oldest=[...this.bindings].filter(([key])=>!open.has(key)).sort((a,b)=>a[1].touchedAt-b[1].touchedAt);
    for(const[key]of oldest.slice(0,this.bindings.size-MAX_BINDINGS))this.bindings.delete(key);
  }
  /** Inputs to one device run one after another, so the ledger is read after the previous input's outcome is known. */
  private lane<T>(device:string,run:()=>Promise<T>):Promise<T>{
    const previous=this.lanes.get(device)??Promise.resolve();
    const next=previous.then(run,run);
    const settled=next.catch(()=>{});this.lanes.set(device,settled);
    void settled.then(()=>{if(this.lanes.get(device)===settled)this.lanes.delete(device);});
    return next;
  }
  private ensureTimer(){
    if(this.timer)return;
    this.timer=setInterval(()=>this.beat(),20000);this.timer.unref?.();
  }
  /** Keeps the leases: this Mac's connection, and the remote sessions through this Mac's route (it forwards, RC-9). */
  private beat(){
    if(this.active)void this.request({operation:'heartbeat'}).then(r=>{
      if(r.success===true)this.failures=0;else if(++this.failures>=3)this.stopLocal();
    }).catch(()=>{if(++this.failures>=3)this.stopLocal();});
    if(this.remoteActive&&this.remote)void this.remote({operation:'heartbeat'}).then(r=>{
      if(plain(r.body)&&r.body.success===true)this.remoteFailures=0;else if(++this.remoteFailures>=3)this.stopRemote();
    }).catch(()=>{if(++this.remoteFailures>=3)this.stopRemote();});
  }
  private stopLocal(){this.active=false;this.failures=0;this.idle();}
  private stopRemote(){this.remoteActive=false;this.remoteFailures=0;this.idle();}
  private idle(){if(!this.active&&!this.remoteActive&&this.timer){clearInterval(this.timer);this.timer=undefined;}}
  async close(){
    const wasActive=this.active,wasRemote=this.remoteActive;
    this.active=false;this.remoteActive=false;this.idle();
    if(wasActive)await this.request({operation:'disconnect'}).catch(()=>{});
    if(wasRemote&&this.remote)await this.remote({operation:'disconnect'}).catch(()=>{});
  }
}
