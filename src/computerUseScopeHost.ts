import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {computerCallerGeneration,isLiveComputerCallerGeneration,type AuthenticatedComputerCaller} from './computerUseCaller';
import type {ComputerUseNativeChannel} from './computerUseNative';
import {ComputerScopeApprovalVerifier,parseScopeOwner,type ScopeCaller,type ScopeOwner} from './computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS,parseComputerScopeAgentRequest,parseComputerUseScope,protectedScopeBundle,sameComputerUseScope,type ComputerUseScope,type ComputerUseScopeLimits} from './computerUseScopeProtocol';
import type {ComputerUseRecovery,ScopedRecoveryOperation} from './computerUseRecovery';
import {callerHostOwns,unknownCallerHost,type ComputerCallerHost} from './computerUseCallerHost';

const nowDefault=()=>Date.now(), hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const id=(v:unknown)=>typeof v==='string'&&Buffer.byteLength(v)<=200&&/^[\x21-\x7e]+$/.test(v);
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
// Control's content-free guard readings (native ScopedGuardSamples): HID idle age, time since this action's own event and
// counter changes since the observation. Anything not exactly that shape is dropped whole. They explain a receipt only:
// state, halt, recovery row and replay rule are unchanged, and no value says whether a person or this process caused it.
const GUARD_COUNTERS=new Set(['keyDown','keyUp','flagsChanged','mouseMoved','leftMouseDown','leftMouseUp','rightMouseDown','rightMouseUp','otherMouseDown','otherMouseUp','leftMouseDragged','rightMouseDragged','otherMouseDragged','scrollWheel']);
const guardMs=(v:unknown,max:number)=>Number.isSafeInteger(v)&&(v as number)>=-1&&(v as number)<=max;
function guardSample(v:unknown){
  if(!v||typeof v!=='object'||Array.isArray(v))return undefined;const o=v as Record<string,unknown>;
  if(!Object.keys(o).every(k=>k==='idleMs'||k==='sincePostMs'||k==='counters')||!guardMs(o.idleMs,600000)||'sincePostMs' in o&&!guardMs(o.sincePostMs,60000)||!('counters' in o))return undefined;
  let counters:Record<string,number>|null=null;
  if(o.counters!==null){
    if(!o.counters||typeof o.counters!=='object'||Array.isArray(o.counters))return undefined;const entries=Object.entries(o.counters);
    if(!entries.every(([k,n])=>GUARD_COUNTERS.has(k)&&Number.isSafeInteger(n)&&(n===-1||(n as number)>=1&&(n as number)<=99)))return undefined;
    counters=Object.fromEntries(entries) as Record<string,number>;
  }
  return {idleMs:o.idleMs as number,...('sincePostMs' in o?{sincePostMs:o.sincePostMs as number}:{}),counters};
}
export function scopeGuardSamples(v:unknown):Record<string,unknown>|undefined{
  if(!v||typeof v!=='object'||Array.isArray(v))return undefined;const o=v as Record<string,unknown>,keys=Object.keys(o);
  if(!keys.length||!keys.every(k=>k==='before'||k==='after'||k==='refusal'))return undefined;
  const out:Record<string,ReturnType<typeof guardSample>>={};for(const k of keys){const sample=guardSample(o[k]);if(!sample)return undefined;out[k]=sample;}
  // `before` precedes the action's first event and `after` follows one.
  if(out.before&&'sincePostMs' in out.before||out.after&&!('sincePostMs' in out.after))return undefined;
  return out;
}
const requiredOps=COMPUTER_USE_SCOPE_OPERATIONS;
/** Control's `standing` (StandingAllowance.json): exactly `{scope:{kind:'desktop'},since}`, or null. Anything else is unknown. */
function parseStanding(v:unknown):{since:number}|null|undefined{
  if(v===null)return null;
  if(!exact(v,['scope','since'])||!exact((v as any).scope,['kind'])||(v as any).scope.kind!=='desktop'||!Number.isSafeInteger((v as any).since)||(v as any).since<=0)return undefined;
  return {since:(v as any).since};
}
const hasCapability=(value:Record<string,any>)=>value.success===true&&value.scopeProtocolVersion===2&&Array.isArray(value.operations)&&value.operations.length<=64&&requiredOps.every(op=>value.operations.includes(op))&&typeof value.accessibility==='boolean'&&typeof value.screenRecording==='boolean'&&typeof value.secureInput==='boolean';
type NativeCaller=ScopeCaller;
type Pending={connectionId:string;caller:AuthenticatedComputerCaller;request:ReturnType<ComputerScopeApprovalVerifier['request']>};
type Snapshot={id:string;nativeId:string;expires:number;displays:Map<string,{width:number;height:number;originX:number;originY:number}>;applications:Set<string>;bundles:Map<string,string>;foreground:string|null;capture?:{displayId:string;width:number;height:number}};
const INPUT_OPERATIONS=new Set(['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app']);
// setTimeout runs a longer delay at once, so a grant's 30-day horizon is waited for in steps.
const MAX_TIMER_MS=2_147_483_647;
// A spent request ID whose full receipt was dropped (only the newest are kept): it was settled and never runs again.
const EVICTED_GUIDANCE='이 요청 ID는 이미 사용됐고 결과가 정해졌습니다. 영수증은 최근 것만 보관합니다. 다시 보내지 말고 화면을 새로 관찰하세요.';
const evicted=(requestId:string)=>({success:true,receipt:{requestId,state:'evicted'},guidance:EVICTED_GUIDANCE});
const OWN_HOST_REFUSED='이 AI가 실행 중인 앱(자기 호스트)에는 컴퓨터 유즈로 입력하지 않습니다. 그 앱의 창은 사람이 다룹니다.';
const HOST_UNKNOWN_REFUSED='이 AI 연결이 실행 중인 앱을 확인하지 못해 보내지 않았습니다. AI 연결을 다시 연 뒤 상태를 확인하세요.';
// Control refuses a request whose deadline is past its own wait limit as `approval-expired`. A request made just now can
// only hit that when the running Control waits less than this host asks (an older Control: 120 s against 10 min), so that
// Control process is remembered as needing an update until another Control process answers (2026-10-31, 1호: Control 1557).
const CONTROL_UPDATE_REQUIRED='이 Mac의 AgentsToZ Control이 메인 앱보다 이전 버전이라 승인 요청을 받지 못했습니다(control-update-required). 사람이 AgentsToZ Control을 최신으로 설치한 뒤 다시 요청하게 하세요. 같은 요청을 자동으로 다시 보내지 마세요.';
const controlCode=(v:unknown)=>typeof v==='string'&&/^[a-z-]{1,60}$/.test(v)?v:'unknown';
const ownerKey=(owner:ScopeOwner)=>`${owner.pid}:${owner.start}`;
// Control refused to open before changing anything and the person's approval stays valid until it expires:
// a busy channel, or a passing lock/secure-input state (a password field still open). Ask again on the next sync.
const OPEN_GRANT_LATER=new Set(['native-busy','secure-state-unavailable']);
// The person pressed 「직접 하기」 on Control's on-screen bar: the grant stays open and nothing halts, but Control refuses
// every agent operation (before dispatch) until the person presses 「AI에게 넘기기」 there. Only that bar hands it back.
const PERSON_HOLDS='사람이 AgentsToZ Control 막대의 「직접 하기」로 Mac을 쓰고 있습니다(person-has-control). 허용은 그대로이니 request-access를 다시 하지 말고 같은 요청 ID도 다시 보내지 마세요. 약 30초마다 status로 확인해 owner가 agent로 돌아오면 새로 observe한 뒤 이어가세요.';
const personHolds=(answer:Record<string,any>)=>answer.success!==true&&answer.code==='person-has-control'&&answer.notDispatched===true&&answer.halted!==true;
/** `usedAt`: its last agent request, so another connection may take over a grant left idle under the standing allowance. */
type Grant={id:string;secret:string;nativeGrant:string;epoch:number;scope:ComputerUseScope;caller:NativeCaller;label:string;expiresAt:number;usedAt:number;busy:boolean;halted:boolean;person:boolean;nativeRevoked:boolean;observation?:Snapshot;receipts:Map<string,{fingerprint:string;receipt:Record<string,unknown>}>;spent:Set<string>;timer?:ReturnType<typeof setTimeout>};
/** Scoped v2 has its own approvals and grant state; native Control remains the authority for scope and input. */
export class ComputerUseScopeHost {
  private readonly approvals:ComputerScopeApprovalVerifier;private pending=new Map<string,Pending>();private grants=new Map<string,Grant>();
  private syncing=false;private disposed=false;private native?:Record<string,unknown>;private outdatedControl:string|null=null;
  /** Control's standing allowance from its last status: `null` off, undefined unknown (not read yet, or an older Control). */
  private standingState?:{since:number}|null;private standingOffSupported=false;
  /**
   * `callerHost`: the app the connection's AI runs in, resolved by the runtime from its process ancestry at registration
   * (src/computerUseCallerHost.ts). Without it every host is unknown: no application scope and no desktop input.
   */
  constructor(private readonly channel:ComputerUseNativeChannel,private readonly recovery:ComputerUseRecovery,private readonly now:()=>number=nowDefault,
    private readonly callerHost:(sessionId:string)=>Promise<ComputerCallerHost>=async()=>unknownCallerHost('resolver-missing'),
    private readonly limits:ComputerUseScopeLimits=COMPUTER_USE_SCOPE_LIMITS){this.approvals=new ComputerScopeApprovalVerifier(now);}
  private async host(sessionId:string):Promise<ComputerCallerHost>{try{return await this.callerHost(sessionId);}catch{return unknownCallerHost('resolver-failed');}}
  private caller(caller:AuthenticatedComputerCaller):NativeCaller {const generation=computerCallerGeneration(caller);if(!generation)throw Error('AI 연결이 끝났습니다.');return {sessionId:caller.sessionId,lane:caller.lane,generation};}
  private safeRecovery(scope:ComputerUseScope){try{return this.recovery.unresolvedScope(scope);}catch{return true;}}
  private retire(body:Record<string,unknown>){if(this.channel.retire)this.channel.retire(body);else void this.channel.request(body).catch(()=>this.channel.dispose());}
  private retireGrant(g:Grant){if(g.nativeRevoked)return;g.nativeRevoked=true;this.retire({operation:'scope-revoke',grant:g.nativeGrant,caller:g.caller});}
  private remove(g:Grant){g.halted=true;g.observation=undefined;if(g.timer)clearTimeout(g.timer);this.grants.delete(g.id);this.retireGrant(g);}
  private schedule(g:Grant){const left=g.expiresAt-this.now();if(left<=0){this.remove(g);return;}
    g.timer=setTimeout(()=>{if(this.grants.get(g.id)===g)this.schedule(g);},Math.min(left,MAX_TIMER_MS));g.timer.unref?.();}
  private reap(){for(const g of this.grants.values())if(g.expiresAt<=this.now()||!isLiveComputerCallerGeneration(g.caller.generation))this.remove(g);for(const [id,p] of this.pending)if(p.request.expiresAt<=this.now()||!isLiveComputerCallerGeneration(p.request.caller.generation)){this.pending.delete(id);this.approvals.cancel(id);}}
  private active(g:Grant){this.reap();if(this.disposed||!this.grants.has(g.id)||g.halted||!isLiveComputerCallerGeneration(g.caller.generation))throw Error('제어 허용이 끝났습니다. 다시 승인해야 합니다.');}
  private publicGrant(g:Grant,secret=false){return {id:g.id,label:g.label,scope:structuredClone(g.scope),caller:{sessionId:g.caller.sessionId,lane:g.caller.lane},epoch:g.epoch,expiresAt:g.expiresAt,halted:g.halted,busy:g.busy,owner:g.halted?'human':g.person?'person':'agent',...(secret?{grant:g.secret}:{})};}
  private async checkNative():Promise<{value:Record<string,any>;owner:ScopeOwner}>{
    if(!this.channel.available)throw Error('서명된 컴퓨터 유즈 도우미 연결을 준비하세요.');
    let answer:Record<string,any>;try{answer=await this.channel.request({operation:'scope-status'});}catch{this.native={success:false,code:'scope-status-unavailable',observedAt:this.now()};throw Error('범위 제어 도우미 상태를 확인하지 못했습니다.');}
    if(!hasCapability(answer)){this.native={success:false,code:'scope-update-required',observedAt:this.now()};throw Error('범위 제어를 지원하는 최신 Control이 필요합니다.');}
    const owner=parseScopeOwner(answer.owner);
    if(this.outdatedControl===ownerKey(owner)){this.native={success:false,code:'scope-update-required',observedAt:this.now()};throw Error(CONTROL_UPDATE_REQUIRED);}
    // Control holds one grant: who has it, from the bar. An older Control sends nothing and nothing changes.
    if(answer.control==='person'||answer.control==='agent')for(const g of this.grants.values())if(!g.halted)this.holder(g,answer.control==='person');
    this.standingOffSupported=answer.operations.includes('scope-standing-off');this.standingState=parseStanding(answer.standing);
    this.native={success:true,scopeProtocolVersion:2,operations:answer.operations.filter((op:unknown)=>(COMPUTER_USE_SCOPE_OPERATIONS as readonly unknown[]).includes(op)),accessibility:answer.accessibility,screenRecording:answer.screenRecording,secureInput:answer.secureInput,
      ...(this.standingState!==undefined?{standing:this.standingState}:{}),observedAt:this.now()};
    return {value:answer,owner};
  }
  /** `delivered` runs once the request may have reached Control (delivered, or its delivery unknown), never for a refusal before it left. */
  async requestApproval(caller:AuthenticatedComputerCaller,connectionId:string,value:unknown,label:string,delivered?:()=>void){
    this.reap();if(this.disposed)throw Error('제어 연결이 끝났습니다.');const scope=parseComputerUseScope(value);
    if(this.safeRecovery(scope))throw Error('이 범위에 결과를 확인하지 못한 작업이 있습니다. 사람이 먼저 확인해야 합니다.');
    // An application scope is never the app this AI runs in, and an unread host cannot show that it is not.
    if(scope.kind==='application'){const host=await this.host(caller.sessionId);
      if(host.state!=='known')throw Error(HOST_UNKNOWN_REFUSED);if(callerHostOwns(host,scope.application.bundleId))throw Error(OWN_HOST_REFUSED);}
    const {owner,value:native}=await this.checkNative();
    if(native.accessibility!==true||native.screenRecording!==true||native.secureInput===true)throw Error('Control의 손쉬운 사용과 화면 기록 권한을 확인하고 보안 입력을 끝낸 뒤 다시 요청하세요.');
    const nativeCaller=this.caller(caller);
    const request=this.approvals.request(caller,scope,label,owner);const pending:Pending={connectionId,caller,request};this.pending.set(request.approvalId,pending);
    let answer:Record<string,any>;
    try{answer=await this.channel.request({operation:'scope-request-approval',approvalId:request.approvalId,scope:request.scope,caller:nativeCaller,label:request.label,expiresAt:request.expiresAt});}
    catch(error){if((error as {notDispatched?:boolean})?.notDispatched===true){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}else delivered?.();throw Error('승인 요청의 전달이 미확인입니다. 상태를 확인하고 자동 재전송하지 마세요.');}
    if(answer.notDispatched!==true)delivered?.();
    if(computerCallerGeneration(caller)!==nativeCaller.generation||!this.pending.has(request.approvalId))throw Error('AI 연결이 끝나 승인 요청을 취소했습니다.');
    if(answer.success!==true){const code=controlCode(answer.code);
      if(answer.notDispatched===true||code==='approval-expired'){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}
      if(code==='approval-expired'){this.outdatedControl=ownerKey(owner);this.native={success:false,code:'scope-update-required',observedAt:this.now()};throw Error(CONTROL_UPDATE_REQUIRED);}
      throw Error(`승인 요청 전달을 확인하지 못했습니다(Control: ${code}). 자동 재전송하지 마세요.`);}
    return {success:true,approvalId:request.approvalId,state:'pending',expiresAt:request.expiresAt};
  }
  async sync(){
    this.reap();if(this.disposed||this.syncing||!this.channel.available)return;this.syncing=true;
    try{for(const [id,p] of this.pending){
      if(computerCallerGeneration(p.caller)!==p.request.caller.generation){this.pending.delete(id);this.approvals.cancel(id);continue;}
      let answer:Record<string,any>;try{answer=await this.channel.request({operation:'scope-approval-status',approvalId:id,caller:p.request.caller});}catch{continue;}
      if(!this.pending.has(id)||computerCallerGeneration(p.caller)!==p.request.caller.generation)continue;
      if(answer.success!==true)continue;
      if(['denied','cancelled','expired','unknown','consumed'].includes(answer.state)){this.pending.delete(id);this.approvals.cancel(id);continue;}
      if(answer.state!=='approved')continue;
      if(typeof answer.helperPublicKey!=='string'||! /^[A-Za-z0-9+/]{87}=$/.test(answer.helperPublicKey))throw Error('범위 승인 공개키를 확인하지 못했습니다.');
      const key=Buffer.from(answer.helperPublicKey,'base64');if(key.length!==65||key[0]!==4)throw Error('범위 승인 공개키가 올바르지 않습니다.');
      const verified=this.approvals.verify(answer.approval,key);
      if(this.safeRecovery(verified.scope))throw Error('결과를 확인하지 못한 작업을 먼저 검토해야 합니다.');
      let opened:Record<string,any>;try{opened=await this.channel.request({operation:'scope-open-grant',approvalId:id,scope:verified.scope,caller:verified.caller});}
      catch(error){if((error as {notDispatched?:boolean})?.notDispatched===true)continue;this.pending.delete(id);this.approvals.cancel(id);this.channel.dispose();throw Error('범위 허용 결과를 확인하지 못했습니다. 자동 재전송하지 마세요.');}
      if(opened.success!==true){if(opened.notDispatched===true&&OPEN_GRANT_LATER.has(opened.code))continue;this.pending.delete(id);this.approvals.cancel(id);if(opened.notDispatched!==true)this.channel.dispose();continue;}
      let nativeScope:ComputerUseScope;try{nativeScope=parseComputerUseScope(opened.scope);}catch{this.channel.dispose();throw Error('범위 허용을 확인하지 못했습니다.');}
      if(opened.bound!==true||opened.scopeProtocolVersion!==2||typeof opened.grant!=='string'||! /^[a-f0-9]{32}$/.test(opened.grant)||!sameComputerUseScope(nativeScope,verified.scope)||JSON.stringify(opened.permissions)!==JSON.stringify(COMPUTER_USE_SCOPE_PERMISSIONS)
        ||!Array.isArray(opened.operations)||!requiredOps.every(op=>opened.operations.includes(op))||!Number.isSafeInteger(opened.expiresAt)||opened.expiresAt<=this.now()||opened.expiresAt>this.now()+this.limits.grantMs){this.channel.dispose();throw Error('범위 허용을 확인하지 못했습니다.');}
      if(computerCallerGeneration(p.caller)!==verified.caller.generation||!this.pending.has(id)||this.safeRecovery(verified.scope)){this.retire({operation:'scope-revoke',grant:opened.grant,caller:verified.caller});this.pending.delete(id);this.approvals.cancel(id);continue;}
      this.approvals.redeem(id);this.pending.delete(id);
      const g:Grant={id:randomUUID(),secret:randomBytes(32).toString('hex'),nativeGrant:opened.grant,epoch:1,scope:verified.scope,caller:verified.caller,label:verified.label,expiresAt:opened.expiresAt,usedAt:this.now(),busy:false,halted:false,nativeRevoked:false,person:false,receipts:new Map(),spent:new Set()};
      this.grants.set(g.id,g);this.schedule(g);
    }}finally{this.syncing=false;}
  }
  async refreshCapability(){try{await this.checkNative();}catch{}return this.managementStatus();}
  knownStanding(){return this.standingState??null;}
  /** Read fresh from Control: the person may have turned it on or off there (or pressed 「중단」) since the last status. */
  async standing():Promise<{since:number}|null>{try{await this.checkNative();}catch{return null;}return this.standingState??null;}
  /** The person's 「끄기」 in the main app. Control halts the open grant itself. An older Control has nothing to end. */
  async standingOff(){
    if(!this.standingOffSupported&&this.standingState===undefined)try{await this.checkNative();}catch{}
    if(!this.standingOffSupported)return;
    try{const answer=await this.channel.request({operation:'scope-standing-off'});if(answer.success===true)this.standingState=null;}
    catch{throw Error('Control에서 상시 허용을 껐는지 확인하지 못했습니다. Control 메뉴에서 「상시 허용 끄기」를 확인하세요.');}
  }
  /**
   * Under the standing allowance, a grant another connection left idle (no request for `idleMs`, nothing running, not
   * held by the person or halted) ends so this connection can take over. A grant in use is never taken.
   */
  yieldIdle(sessionId:string,idleMs:number){
    this.reap();let ended=false;
    for(const g of [...this.grants.values()])if(g.caller.sessionId!==sessionId&&!g.halted&&!g.busy&&!g.person&&this.now()-g.usedAt>=idleMs){this.remove(g);ended=true;}
    return ended;
  }
  async managementStatus(){this.reap();await this.sync();const age=this.native&&typeof this.native.observedAt==='number'?this.now()-this.native.observedAt:-1;
    const native=age>=0&&age<=10000?this.native:{success:false,code:'scope-status-unchecked'};
    return {native,grants:[...this.grants.values()].map(g=>this.publicGrant(g)),pending:[...this.pending.values()].map(p=>({approvalId:p.request.approvalId,connectionId:p.connectionId,label:p.request.label,scope:structuredClone(p.request.scope),expiresAt:p.request.expiresAt})),recovery:this.recovery.pendingScope()};}
  async agentStatus(caller:AuthenticatedComputerCaller){await this.sync();const c=this.caller(caller),age=this.native&&typeof this.native.observedAt==='number'?this.now()-this.native.observedAt:-1;if(age<0||age>10000)try{await this.checkNative();}catch{}if(computerCallerGeneration(caller)!==c.generation)throw Error('AI 연결이 끝났습니다.');const mine=[...this.grants.values()].filter(g=>g.caller.generation===c.generation);
    return {native:this.native??{success:false,code:'scope-status-unchecked'},grants:mine.map(g=>this.publicGrant(g,true)),...(mine.some(g=>!g.halted&&g.person)?{guidance:PERSON_HOLDS}:{}),pending:[...this.pending.values()].filter(p=>p.request.caller.generation===c.generation).map(p=>({expiresAt:p.request.expiresAt}))};}
  revoke(id:string){const g=this.grants.get(id);if(g)this.remove(g);return {success:true};}
  endSession(sessionId:string){let had=false;for(const g of [...this.grants.values()])if(g.caller.sessionId===sessionId){had=true;this.remove(g);}for(const[id,p]of this.pending)if(p.request.caller.sessionId===sessionId){had=true;this.pending.delete(id);this.approvals.cancel(id);}if(had)this.retire({operation:'scope-revoke-session',sessionId});}
  private holder(g:Grant,person:boolean){if(person)g.observation=undefined;g.person=person;}
  private halt(g:Grant){if(!g.halted){g.halted=true;g.epoch++;}g.observation=undefined;this.retireGrant(g);}
  async agent(caller:AuthenticatedComputerCaller,input:unknown):Promise<Record<string,any>> {
    const c=this.caller(caller),r=parseComputerScopeAgentRequest(input);if(r.operation==='scope-status')return this.agentStatus(caller);this.reap();
    const g=[...this.grants.values()].find(g=>hash(g.secret)===hash(r.grant));
    if(!g||g.caller.generation!==c.generation||g.caller.sessionId!==c.sessionId||g.caller.lane!==c.lane)throw Error('사람이 허용한 컴퓨터 제어 연결이 필요합니다.');
    g.usedAt=this.now();
    if(r.operation==='scope-receipt'){const record=g.receipts.get(r.requestId);if(record)return {success:true,receipt:{...record.receipt}};if(g.spent.has(r.requestId))return evicted(r.requestId);throw Error('이 요청의 영수증이 없습니다.');}
    this.active(g);if(r.epoch!==g.epoch)throw Error('새 관찰이 필요합니다.');if(r.operation==='scope-request-human'){this.halt(g);return {success:true,owner:'human'};}
    // Checked again on every operation, not only at approval: an application scope on the caller's own host does nothing,
    // and desktop input needs a host it can tell apart (below, against the observed target).
    const host=await this.host(c.sessionId);this.active(g);
    if(g.scope.kind==='application'&&(host.state!=='known'||callerHostOwns(host,g.scope.application.bundleId)))throw Error(host.state!=='known'?HOST_UNKNOWN_REFUSED:OWN_HOST_REFUSED);
    if(host.state!=='known'&&INPUT_OPERATIONS.has(r.operation))throw Error(HOST_UNKNOWN_REFUSED);
    if(g.busy)throw Error('다른 제어 작업이 진행 중입니다.');
    if(r.operation==='scope-observe'){
      g.busy=true;g.observation=undefined;try{
        let answer:Record<string,any>;try{answer=await this.channel.request({operation:'scope-observe',grant:g.nativeGrant,caller:g.caller});}catch(error){if((error as {notDispatched?:boolean})?.notDispatched!==true)this.halt(g);throw Error('도우미 관찰 결과를 확인하지 못했습니다.');}
        this.active(g);if(answer.halted===true){this.halt(g);throw Error('제어가 중단됐습니다.');}
        if(personHolds(answer)){this.holder(g,true);throw Error(PERSON_HOLDS);}
        if(answer.success!==true)throw Error(`화면 관찰을 확인하지 못했습니다: ${typeof answer.code==='string'&&/^[a-z-]{1,60}$/.test(answer.code)?answer.code:'observe-failed'}`);
        if(!id(answer.snapshotId)||!sameComputerUseScope(parseComputerUseScope(answer.scope),g.scope)||!Array.isArray(answer.applications)||answer.applications.length>100||!Array.isArray(answer.displays)||answer.displays.length>16)throw Error('화면 관찰을 확인하지 못했습니다.');
        const displays=new Map<string,{width:number;height:number;originX:number;originY:number}>(),applications=new Set<string>(),bundles=new Map<string,string>();
        for(const d of answer.displays){if(!exact(d,['id','originX','originY','width','height','scale','rotation'])||!id(d.id)||displays.has(d.id)||![d.originX,d.originY,d.width,d.height,d.scale,d.rotation].every(finite)||d.width<=0||d.height<=0||d.scale<=0||d.width>100000||d.height>100000)throw Error('화면 정보를 확인하지 못했습니다.');displays.set(d.id,{width:d.width,height:d.height,originX:d.originX,originY:d.originY});}
        for(const a of answer.applications){if(!exact(a,['id','name','bundleId'])||!id(a.id)||applications.has(a.id)||typeof a.name!=='string'||a.name.length>200||typeof a.bundleId!=='string'||! /^[A-Za-z0-9.-]{1,200}$/.test(a.bundleId)||protectedScopeBundle(a.bundleId)||g.scope.kind==='application'&&a.bundleId!==g.scope.application.bundleId)throw Error('앱 정보를 확인하지 못했습니다.');applications.add(a.id);bundles.set(a.id,a.bundleId);}
        if(answer.foreground!==null&&(!exact(answer.foreground,['applicationId','bundleId','pid','processStart'])||!applications.has(answer.foreground.applicationId)||bundles.get(answer.foreground.applicationId)!==answer.foreground.bundleId||protectedScopeBundle(answer.foreground.bundleId)||!Number.isSafeInteger(answer.foreground.pid)||answer.foreground.pid<1||typeof answer.foreground.processStart!=='string'||! /^[1-9][0-9]{0,19}$/.test(answer.foreground.processStart)||g.scope.kind==='application'&&(answer.foreground.pid!==g.scope.application.pid||answer.foreground.processStart!==g.scope.application.processStart)))throw Error('전면 앱 정보를 확인하지 못했습니다.');
        this.holder(g,false);const observationId=randomUUID();g.observation={id:observationId,nativeId:answer.snapshotId,expires:this.now()+15000,displays,applications,bundles,foreground:answer.foreground?.bundleId??null};
        return {success:true,epoch:g.epoch,observationId,observation:{scope:structuredClone(g.scope),applications:answer.applications,displays:answer.displays,foreground:answer.foreground}};
      }finally{g.busy=false;}
    }
    const fingerprint=r.operation==='scope-capture'?undefined:hash(JSON.stringify(r));
    if(fingerprint!==undefined){const prior=g.receipts.get(r.requestId);if(prior){if(prior.fingerprint!==fingerprint)throw Error('같은 요청 ID의 내용이 달라졌습니다.');return {success:true,receipt:{...prior.receipt}};}
      if(g.spent.has(r.requestId))return evicted(r.requestId);}
    const obs=g.observation;if(!obs||obs.id!==r.observationId||obs.expires<=this.now())throw Error('대상을 새로 관찰하세요.');
    if(r.operation==='scope-capture'){
      if(!obs.displays.has(r.displayId))throw Error('화면을 새로 관찰하세요.');g.busy=true;obs.capture=undefined;
      try{let answer:Record<string,any>;try{answer=await this.channel.request({operation:'scope-capture',grant:g.nativeGrant,caller:g.caller,snapshotId:obs.nativeId,displayId:r.displayId});}catch(error){if((error as {notDispatched?:boolean})?.notDispatched!==true)this.halt(g);throw error;}this.active(g);
        if(personHolds(answer)){this.holder(g,true);throw Error(PERSON_HOLDS);}
        if(answer.success!==true){if(answer.halted===true||answer.notDispatched!==true)this.halt(g);throw Error(`화면을 읽지 못했습니다: ${typeof answer.code==='string'&&/^[a-z-]{1,60}$/.test(answer.code)?answer.code:'capture-failed'}`);}
        if(g.observation!==obs||obs.expires<=this.now()||answer.halted===true||answer.displayId!==r.displayId||answer.mediaType!=='image/jpeg'||typeof answer.data!=='string'||!answer.data.length||answer.data.length>320000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(answer.data)||!Number.isSafeInteger(answer.width)||!Number.isSafeInteger(answer.height)||answer.width<1||answer.height<1||answer.width>1280||answer.height>1280||!finite(answer.displayWidth)||!finite(answer.displayHeight)||answer.displayWidth<=0||answer.displayHeight<=0||!finite(answer.originX)||!finite(answer.originY)){this.halt(g);throw Error('화면 결과를 확인하지 못했습니다.');}
        const d=obs.displays.get(r.displayId)!;if(d.width!==answer.displayWidth||d.height!==answer.displayHeight||d.originX!==answer.originX||d.originY!==answer.originY){g.observation=undefined;throw Error('화면 구성이 바뀌었습니다.');}obs.capture={displayId:r.displayId,width:d.width,height:d.height};
        return {success:true,observationId:obs.id,image:{mediaType:answer.mediaType,data:answer.data,width:answer.width,height:answer.height,displayWidth:answer.displayWidth,displayHeight:answer.displayHeight,displayId:answer.displayId,originX:answer.originX,originY:answer.originY}};
      }finally{g.busy=false;}
    }
    // The memory bound of the spent IDs, not a time: the grant ends so request-access can ask the person again.
    if(g.spent.size>=this.limits.actionsPerGrant){this.remove(g);throw Error(`이 승인으로 할 수 있는 작업 수(${this.limits.actionsPerGrant}개)를 다 써서 허용을 끝냈습니다. request-access로 다시 승인을 요청하세요.`);}
    if(['scope-click','scope-scroll','scope-drag'].includes(r.operation)){
      const cap=obs.capture;if(!cap||cap.displayId!==r.displayId||r.x>=cap.width||r.y>=cap.height||r.operation==='scope-drag'&&(r.endX>=cap.width||r.endY>=cap.height))throw Error('화면을 다시 확인하세요.');
    }
    if(r.operation==='scope-focus-app'&&!obs.applications.has(r.applicationId))throw Error('앱을 새로 관찰하세요.');
    // Desktop input never goes to the caller's own host: not by focusing it, not while it is the observed foreground.
    // Focusing another app is how the AI leaves its host, so focus-app is judged by its target alone; Control still
    // applies its own foreground and overlay rules. A background host window under a desktop pointer is not told apart
    // here (that needs the native hit test).
    if(r.operation==='scope-focus-app'){const target=obs.bundles.get(r.applicationId);
      if(!target||protectedScopeBundle(target))throw Error('이 앱은 컴퓨터 유즈 대상이 될 수 없습니다.');if(callerHostOwns(host,target))throw Error(OWN_HOST_REFUSED);}
    else if(INPUT_OPERATIONS.has(r.operation)&&callerHostOwns(host,obs.foreground))throw Error(OWN_HOST_REFUSED);
    let recoveryId:string;try{recoveryId=this.recovery.beginScope({scope:g.scope,operation:r.operation as ScopedRecoveryOperation,requestId:r.requestId,sessionId:c.sessionId,lane:c.lane});}catch{throw Error('결과를 확인하지 못한 작업이 있거나 기록을 남기지 못해 보내지 않았습니다.');}
    const receipt:Record<string,unknown>={requestId:r.requestId,state:'unknown'};g.spent.add(r.requestId);g.receipts.set(r.requestId,{fingerprint:fingerprint!,receipt});
    // Only a settled receipt is dropped: an unknown or takeover halts the grant, so it is always the newest.
    if(g.receipts.size>this.limits.receiptsKept)g.receipts.delete(g.receipts.keys().next().value as string);
    g.observation=undefined;g.busy=true;
    try{
      const {grant,epoch,observationId,...fields}=r;let answer:Record<string,any>;
      try{answer=await this.channel.request({...fields,grant:g.nativeGrant,caller:g.caller,snapshotId:obs.nativeId});}catch(error){if((error as {notDispatched?:boolean})?.notDispatched===true){try{this.recovery.settleScope(recoveryId);}catch{}receipt.state='refused';return {success:true,receipt:{...receipt}};}this.halt(g);return {success:true,receipt:{...receipt},owner:'human'};}
      let state='unknown';if(answer.success===true&&answer.receipt?.requestId===r.requestId&&['confirmed','refused','dispatched-unverified','human-takeover'].includes(answer.receipt.state))state=answer.receipt.state;else if(answer.success===false&&answer.notDispatched===true)state='refused';
      // A receipt saying dispatch finished is not proof of its UI effect, but it is a known delivery outcome.
      // The observation was consumed above; another action needs a new observation and is never a replay.
      // A partial/unknown dispatch or human takeover stays durable and halts until a person reviews it.
      if(state==='confirmed'||state==='refused'||state==='dispatched-unverified')try{this.recovery.settleScope(recoveryId);}catch{}
      receipt.state=state;
      if(personHolds(answer)){receipt.reason='person-has-control';this.holder(g,true);return {success:true,receipt:{...receipt},owner:'person',guidance:PERSON_HOLDS};}
      if((state==='refused'||state==='human-takeover')&&typeof answer.receipt?.reason==='string'&&/^[a-z-]{1,60}$/.test(answer.receipt.reason))receipt.reason=answer.receipt.reason;
      // The native guard check that refused it (a code only): beside the generic reason, never instead of it.
      if(state==='refused'&&answer.success===true&&answer.receipt?.requestId===r.requestId&&typeof answer.receipt.guardReason==='string'&&/^[a-z-]{1,60}$/.test(answer.receipt.guardReason))receipt.guardReason=answer.receipt.guardReason;
      if(answer.success===true&&answer.receipt?.requestId===r.requestId){const samples=scopeGuardSamples(answer.receipt.guardSamples);if(samples)receipt.guardSamples=samples;}
      if(state==='unknown'||state==='human-takeover'||answer.halted===true)this.halt(g);
      return {success:true,receipt:{...receipt},...(g.halted?{owner:'human'}:{})};
    }finally{g.busy=false;}
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const g of [...this.grants.values()])this.remove(g);for(const[id]of this.pending)this.approvals.cancel(id);this.pending.clear();}
}
