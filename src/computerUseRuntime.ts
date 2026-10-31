import {createHash,randomUUID} from 'node:crypto';
import {ComputerCallerRegistry,computerCallerGeneration,type AuthenticatedComputerCaller} from './computerUseCaller';
import {ComputerApprovalVerifier} from './computerUseApproval';
import {ComputerUseHost} from './computerUseHost';
import {nativeComputerWorker,RevokingComputerUseChannel,type ComputerUseNativeChannel} from './computerUseNative';
import type {ComputerUseRecovery} from './computerUseRecovery';
import {COMPUTER_USE_CONTROL_PROTOCOL,COMPUTER_USE_WORKER_PROTOCOL,controlAdvertisesScreen,parseComputerTarget} from './computerUseProtocol';
import {ComputerUseScopeHost} from './computerUseScopeHost';
import {unknownCallerHost,type ComputerCallerHost,type ComputerCallerHostResolver,type ComputerCallerOrigin} from './computerUseCallerHost';
import {COMPUTER_USE_SCOPE_LIMITS,parseComputerUseScope,protectedScopeBundle,sameComputerUseScope,type ComputerUseScope} from './computerUseScopeProtocol';


const LEASE_MS=75_000,MAX_CONNECTIONS=64,NATIVE_STATUS_CACHE_MS=10_000,ACCESS_REQUEST_INTERVAL_MS=60_000;
/** Under the standing allowance another connection may take over a grant left this long without a request. */
export const STANDING_IDLE_MS=120_000;
const STANDING_GRANTED='상시 허용으로 바로 허용됐습니다. status로 grant와 epoch를 받아 observe부터 시작하세요.';
const STANDING_PENDING='상시 허용이 켜져 있어 Control이 곧 허용합니다. 잠시 뒤 status로 grant를 확인하세요. 같은 요청을 다시 보내지 마세요.';
const ACCESS_OFF='컴퓨터 유즈가 꺼져 있습니다. 사람이 AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 켜야 합니다. AI는 켜거나 승인할 수 없습니다.';
const ACCESS_PENDING='사람에게 AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 「승인 검토 열기」를 누르고 Control에서 Touch ID로 승인해 달라고 알리세요. 승인되면 status로 grant와 epoch를 받습니다. 같은 요청을 다시 보내지 마세요.';
const HOST_NAMES:Record<string,string>={'com.intenet.agentstozbycs':'AgentsToZ','com.stablyai.orca':'Orca','com.openai.codex':'Codex','com.openai.chat':'ChatGPT',
  'com.anthropic.claudefordesktop':'Claude','com.apple.terminal':'Terminal','com.googlecode.iterm2':'iTerm','dev.warp.warp-stable':'Warp','com.mitchellh.ghostty':'Ghostty'};
/** The request's name in Control's review: who asks (MCP client name and the apps it runs in, read from its process
 *  ancestry) and the scope the person switched on. Built here, never from an AI body. */
function accessLabel(client:string,host:ComputerCallerHost,scope:ComputerUseScope){
  const where=host.state==='known'&&host.bundleIds.length?host.bundleIds.map(id=>HOST_NAMES[id.toLowerCase()]??id).join('/'):'실행 앱 미확인';
  return [client,where,scope.kind==='desktop'?'전체 Mac':scope.application.bundleId].join(' · ');
}
const NATIVE_STATUS_CODES=new Set(['signed-main-required','signed-main-link-required','signed-helper-required','helper-unavailable','invalid-native-response','native-outcome-unknown','unsupported-platform']);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
/** `host`: the app this connection's AI runs in, read once from its process ancestry when it registers (never from a body). */
type Connection={id:string;code:string;label:string;credential:string;until:number;createdAt:number;grants:Map<string,{grant:string;epoch:number;expiresAt:number}>;host:Promise<ComputerCallerHost>};
type Pending={connection:Connection;caller:AuthenticatedComputerCaller;generation:string;request:ReturnType<ComputerUseHost['requestApproval']>;label:string};
/**
 * A transport identifies an MCP connection, not an app's individual chat. No caller from a body or ancestry hint
 * authorizes input. Only Control's native human approval creates a grant; connections are bounded and short leased.
 */
export class ComputerUseRuntime {
  private registry:ComputerCallerRegistry;
  private host:ComputerUseHost;
  private approvals:ComputerApprovalVerifier;
  private connections=new Map<string,Connection>();
  private pending=new Map<string,Pending>();
  /**
   * The person's switch. While on, an AI connection may ask for exactly this scope and Control still asks the person
   * (Touch ID or password) for each request. Memory only: an app restart turns it off.
   */
  private access:{enabled:false}|{enabled:true;scope:ComputerUseScope}={enabled:false};
  /**
   * Control's standing allowance (상시 허용) as last read. The person turns it on in Control with Touch ID; it outlives
   * app and Control restarts. While on and the switch is off, the switch reads as on for the whole Mac and Control
   * approves desktop requests itself. Only Control decides it; this copy only shows it and skips the per-minute limit.
   */
  private standing:{since:number}|null=null;
  private accessAsked=new Map<string,number>();
  private accessRequesting=false;
  private publicKey?:Uint8Array;
  private syncing=false;
  private disposed=false;
  private nativeStatus?:{observedAt:number;value:Record<string,unknown>};
  private readonly startedAvailable:boolean;
  private now:()=>number;
  private readonly channel:ComputerUseNativeChannel;
  private readonly scope:ComputerUseScopeHost;
  private readonly callerHost?:ComputerCallerHostResolver;
  /** `callerHost` reads a new connection's host app (src/computerUseCallerHost.ts); without it every host is unknown. */
  constructor(channel:ComputerUseNativeChannel,private readonly recovery:ComputerUseRecovery,options:{now?:()=>number;callerHost?:ComputerCallerHostResolver}={}){
    this.callerHost=options.callerHost;
    this.startedAvailable=channel.available;this.channel=new RevokingComputerUseChannel(channel);
    // A connection ends by its 75 s lease (heartbeats renew it) or disconnect, not a day later: the credential lasts as
    // long as a switched-on v2 grant may (COMPUTER_USE_SCOPE_LIMITS.grantMs), so a long session is not cut silently.
    this.now=options.now??Date.now;this.registry=new ComputerCallerRegistry({now:this.now,limit:MAX_CONNECTIONS,lifetimeMs:COMPUTER_USE_SCOPE_LIMITS.grantMs});
    const approvals=this.approvals=new ComputerApprovalVerifier({now:this.now,helperPublicKey:()=>{
      if(!this.publicKey)throw Error('서명된 도우미 승인 키가 없습니다.');return this.publicKey;
    }});
    this.host=new ComputerUseHost({now:this.now,recovery,approvals,createWorker:async context=>nativeComputerWorker(this.channel,context)});
    this.scope=new ComputerUseScopeHost(this.channel,recovery,this.now,
      async sessionId=>[...this.connections.values()].find(c=>c.id===sessionId)?.host??unknownCallerHost('connection-ended'));
  }
  private touch(instance:unknown,label:unknown,create=true,origin:ComputerCallerOrigin|null=null):Connection{
    if(this.disposed||typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw Error('AI 연결을 확인하지 못했습니다.');
    this.reap();const key=hash(instance);let connection=this.connections.get(key);
    if(!connection){
      if(!create||this.connections.size>=MAX_CONNECTIONS)throw Error('AI 연결을 다시 열어 주세요.');
      const id='mcp_'+randomUUID();
      const name=typeof label==='string'?label.replace(/[^A-Za-z0-9 ._()+-]/g,'').trim().slice(0,40):'';
      // Read from the socket that registers the connection, so a later request cannot name a different host.
      const host=this.callerHost?this.callerHost(origin).catch(()=>unknownCallerHost('resolver-failed')):Promise.resolve(unknownCallerHost('resolver-missing'));
      connection={id,code:id.slice(4),label:name||'MCP',credential:this.registry.issue({sessionId:id,lane:'connection'}),until:this.now()+LEASE_MS,createdAt:this.now(),grants:new Map(),host};
      this.connections.set(key,connection);
    }
    connection.until=this.now()+LEASE_MS;return connection;
  }
  private caller(connection:Connection){
    const caller=this.registry.authenticate(connection.credential);if(!caller)throw Error('AI 연결이 끝났습니다.');return caller;
  }
  /** The switch as the person sees it: theirs, or the whole Mac while the standing allowance is on. */
  private effectiveAccess():{enabled:false}|{enabled:true;scope:ComputerUseScope}{return this.access.enabled?this.access:this.standing?{enabled:true,scope:{kind:'desktop'}}:{enabled:false};}
  private sameAccess(a:{enabled:boolean;scope?:ComputerUseScope},b:{enabled:boolean;scope?:ComputerUseScope}){return a.enabled===b.enabled&&(!a.enabled||!!a.scope&&!!b.scope&&sameComputerUseScope(a.scope,b.scope));}
  private publicAccess(){const access=this.effectiveAccess(),standing=this.standing?{standing:{since:this.standing.since}}:{};
    return access.enabled?{enabled:true,scope:structuredClone(access.scope),...standing}:{enabled:false,...standing};}
  /** Off ends every grant and waiting request of every connection (both modes); the connections themselves stay. */
  private turnAccessOff(){
    this.access={enabled:false};this.accessAsked.clear();
    // Retire only sessions that hold something: the channel has a bounded retirement queue (up to 64 connections).
    const v1=new Set([...this.host.list().map(g=>g.caller.sessionId),...[...this.pending.values()].map(p=>p.connection.id)]);
    for(const c of this.connections.values()){
      this.scope.endSession(c.id);
      if(v1.has(c.id)){this.host.endSession(c.id);this.channel.retire!({operation:'revoke-session',sessionId:c.id});}
    }
    for(const[id]of this.pending){this.pending.delete(id);this.approvals.cancel(id);}
  }
  /**
   * An AI asks for the scope the person switched on. It names nothing itself: scope comes from the switch, the label from
   * this connection's registered name and process ancestry. One waiting request at a time, one per connection per minute.
   */
  private async requestAccess(c:Connection):Promise<Record<string,any>>{
    // One request travels at a time, so a second ask cannot pass the checks below before the first is recorded.
    if(this.accessRequesting)throw Error('승인 요청을 Control에 보내는 중입니다. 잠시 뒤 status로 확인하고 같은 요청을 다시 보내지 마세요.');
    this.accessRequesting=true;
    try{
      this.standing=await this.scope.standing();
      const access=this.effectiveAccess();if(!access.enabled)throw Error(ACCESS_OFF);
      // Control approves only a desktop request by itself; an application scope still asks the person every time.
      const standing=!!this.standing&&access.scope.kind==='desktop';
      let scoped=await this.scope.managementStatus();
      if(scoped.grants.some(g=>!g.halted&&g.caller.sessionId===c.id&&sameComputerUseScope(g.scope,access.scope)))return {success:true,state:'granted',guidance:'이미 허용됐습니다. status로 grant와 epoch를 받으세요.'};
      const mine=scoped.pending.find(p=>p.connectionId===c.id);if(mine)return {success:true,state:'pending',expiresAt:mine.expiresAt,guidance:standing?STANDING_PENDING:ACCESS_PENDING};
      if(standing&&this.scope.yieldIdle(c.id,STANDING_IDLE_MS))scoped=await this.scope.managementStatus();
      if(scoped.grants.some(g=>!g.halted)||this.host.list().some(g=>!g.halted))throw Error(standing
        ?'다른 AI 연결이 지금 컴퓨터 유즈로 작업 중입니다. 그 연결이 2분 동안 아무 요청도 하지 않으면 넘겨받을 수 있으니, 잠시 뒤 request-access를 한 번 다시 보내세요.'
        :'다른 AI 연결이 컴퓨터 유즈를 사용 중입니다. 사람이 그 허용을 끝낸 뒤 다시 요청하세요.');
      if(scoped.pending.length||this.pending.size)throw Error('다른 승인 요청이 Control에서 대기 중입니다. 그 요청이 끝난 뒤 다시 요청하세요.');
      // The limit keeps the person from being asked again and again; under the standing allowance nobody is asked.
      const last=this.accessAsked.get(c.id);
      if(!standing&&last!==undefined&&this.now()-last<ACCESS_REQUEST_INTERVAL_MS)throw Error('방금 보낸 승인 요청이 승인되지 않았습니다. 사람이 원한다고 할 때까지 다시 요청하지 마세요.');
      const label=('연결 '+c.code.slice(0,8)+' / '+accessLabel(c.label,await c.host,access.scope)).slice(0,100);
      if(!this.sameAccess(this.effectiveAccess(),access))throw Error(ACCESS_OFF);
      // The interval starts once the request may have reached Control, including an unknown delivery, so neither is
      // followed by a fresh request inside it. A refusal before it left (a recovery row, an unread or own host, missing
      // permissions, a request that was not sent) starts nothing: the person never saw it to decline.
      const result=await this.scope.requestApproval(this.caller(c),c.id,access.scope,label,()=>{this.accessAsked.set(c.id,this.now());});
      // Switched off or changed while the request travelled: end it again so nothing outlives the switch.
      if(!this.sameAccess(this.effectiveAccess(),access)){this.scope.endSession(c.id);throw Error(ACCESS_OFF);}
      if(standing){
        // Control approved it as it arrived (or will on the next read, once an ended grant is gone there): open it now.
        const now=await this.scope.managementStatus();
        if(now.grants.some(g=>!g.halted&&g.caller.sessionId===c.id&&sameComputerUseScope(g.scope,access.scope)))return {success:true,state:'granted',guidance:STANDING_GRANTED};
        return {...result,guidance:STANDING_PENDING};
      }
      return {...result,guidance:ACCESS_PENDING};
    }finally{this.accessRequesting=false;}
  }
  private end(connection:Connection){
    this.accessAsked.delete(connection.id);
    this.registry.retire(connection.id);this.host.endSession(connection.id);
    this.scope.endSession(connection.id);
    for(const[id,p]of this.pending)if(p.connection===connection)this.pending.delete(id);
    this.channel.retire!({operation:'revoke-session',sessionId:connection.id});
  }
  reap(){for(const[key,c]of this.connections)if(c.until<=this.now()||!this.registry.authenticate(c.credential)) {this.connections.delete(key);this.end(c);}}
  private async syncApprovals(){
    if(this.syncing||!this.channel.available)return;this.syncing=true;
    try{for(const[id,p]of this.pending){
      if(p.connection.until<=this.now()||computerCallerGeneration(p.caller)!==p.generation){this.pending.delete(id);continue;}
      const result=await this.channel.request({operation:'approval-status',approvalId:id,caller:{...p.request.caller,generation:p.generation}});
      if(!this.pending.has(id)||computerCallerGeneration(p.caller)!==p.generation)continue;
      if(result.success!==true||['denied','cancelled','expired','unknown','consumed'].includes(result.state)||p.request.expiresAt<=this.now()){
        this.pending.delete(id);this.approvals.cancel(id);continue;
      }
      if(result.state!=='approved')continue;
      if(typeof result.helperPublicKey!=='string'||!/^[A-Za-z0-9+/]{87}=$/.test(result.helperPublicKey))throw Error('승인 공개키를 확인하지 못했습니다.');
      const key=Buffer.from(result.helperPublicKey,'base64');if(key.length!==65||key[0]!==4)throw Error('승인 공개키가 올바르지 않습니다.');
      this.publicKey=key;
      // The host verifies nonce, exact target/caller/generation/expiry and signature before opening the native grant.
      let opened:Awaited<ReturnType<ComputerUseHost['grant']>>;
      try{opened=await this.host.grant(result.approval);}
      catch(error){
        // No request reached Control: retain the same native approval for the next status read. Never create a
        // replacement approval, queue input or repeat a bind whose delivery could have happened.
        if((error as {notDispatched?:boolean})?.notDispatched===true)continue;
        this.pending.delete(id);this.approvals.cancel(id);throw error;
      }
      this.pending.delete(id);
      if(computerCallerGeneration(p.caller)!==p.generation){this.host.revoke(opened.id);continue;}
      p.connection.grants.set(opened.id,{grant:opened.grant,epoch:opened.epoch,expiresAt:opened.expiresAt});
    }}finally{this.syncing=false;}
  }
  private ownGrants(connection:Connection){
    const current=this.host.list().filter(g=>g.caller.sessionId===connection.id);
    for(const[id]of connection.grants)if(!current.some(g=>g.id===id))connection.grants.delete(id);
    return current.map(g=>({...g,grant:connection.grants.get(g.id)?.grant}));
  }
  private rememberNativeStatus(result:Record<string,any>){
    let value:Record<string,unknown>;
    if(result.success===true&&result.protocolVersion===COMPUTER_USE_CONTROL_PROTOCOL&&result.workerProtocol===COMPUTER_USE_WORKER_PROTOCOL&&result.backgroundOnly===true&&typeof result.accessibility==='boolean'&&typeof result.secureInput==='boolean'){
      // `capture` says whether this Control can take capture/click at all; permissions are still checked per request.
      value={state:!result.accessibility?'accessibility-required':result.secureInput?'secure-input':'ready',
        capture:controlAdvertisesScreen(result)?'supported':'control-update-required'};
    }else if(result.success===false){
      value={state:'unavailable',...(typeof result.code==='string'&&NATIVE_STATUS_CODES.has(result.code)?{code:result.code}:{})};
    }else value={state:'unknown'};
    this.nativeStatus={observedAt:this.now(),value};
  }
  private cachedNativeStatus(){
    if(!this.channel.available)return {state:'unavailable'};
    const cached=this.nativeStatus,age=cached?this.now()-cached.observedAt:-1;
    return cached&&age>=0&&age<=NATIVE_STATUS_CACHE_MS?{...cached.value,observedAt:cached.observedAt}:{state:'unknown'};
  }
  async agent(instance:unknown,label:unknown,body:unknown,origin:ComputerCallerOrigin|null=null){
    if(!plain(body)||typeof body.operation!=='string')throw Error('컴퓨터 유즈 요청을 확인하세요.');
    if(body.operation==='disconnect'){
      if(!exact(body,['operation'])||typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw Error('연결 종료 요청을 확인하세요.');
      const c=this.connections.get(hash(instance));if(c){this.connections.delete(hash(instance));this.end(c);}return {success:true};
    }
    const fresh=typeof instance==='string'&&!this.connections.has(hash(instance));
    const connection=this.touch(instance,label,body.operation!=='heartbeat',origin);
    // The registering request waits for its host read, so the socket it is read from is still this caller's.
    if(fresh)await connection.host;
    if(body.operation==='heartbeat'){if(!exact(body,['operation']))throw Error('잘못된 연결 확인입니다.');return {success:true};}
    if(body.operation==='status'){
      if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');await this.syncApprovals();
      // Do not add an RPC on this shared channel: a slow helper status can occupy it or retire
      // live grants. Only reuse a recent result from the existing management status request.
      const native=this.cachedNativeStatus();
      return {success:true,connection:{id:connection.id,code:connection.code,label:connection.label,scope:'mcp-connection'},available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,
        native,
        grants:this.ownGrants(connection),pending:[...this.pending.values()].filter(p=>p.connection===connection).map(p=>({expiresAt:p.request.expiresAt})),
        guidance:'available은 앱 연결 상태입니다. native는 관리 화면이 최근 확인한 Control 상태이며 확인 전이거나 오래되면 unknown입니다. 창 조작에는 이 AI 연결의 별도 승인이 필요합니다. AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 연결과 창을 선택하고 Control 앱에서 승인하세요. 연결은 개별 대화와 다를 수 있습니다. native.capture가 control-update-required이면 Control을 업데이트하기 전에는 capture/click을 쓸 수 없습니다.'};
    }
    if(body.operation==='scope-request-access'){
      if(!exact(body,['operation']))throw Error('승인 요청에는 범위·이름·권한을 넣을 수 없습니다.');
      return this.requestAccess(connection);
    }
    if(body.operation.startsWith('scope-')){
      const caller=this.caller(connection),result=await this.scope.agent(caller,body);
      if(body.operation!=='scope-status')return result;
      // The status just read Control (at most 10 s old): after an app restart the standing allowance is how it is on.
      this.standing=this.scope.knownStanding();const on=this.effectiveAccess().enabled;
      return {...result,success:true,connection:{id:connection.id,code:connection.code,label:connection.label,scope:'mcp-connection'},available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,
        // The host's own word (the person holds the Mac from the Control bar) comes before the request-access hint.
        access:this.publicAccess(),guidance:on&&typeof result.guidance==='string'?result.guidance:on?(this.standing?'grant가 없으면 request-access를 한 번 보내세요. 상시 허용이 켜져 있어 사람의 승인 없이 바로 허용됩니다.':'grant가 없으면 request-access를 한 번 보내 승인을 요청하세요. 범위는 사람이 켠 설정을 따릅니다.'):ACCESS_OFF};
    }
    return this.host.agent(this.caller(connection),body);
  }
  async manage(body:unknown){
    if(!plain(body)||typeof body.operation!=='string')throw Error('컴퓨터 유즈 관리 요청을 확인하세요.');this.reap();
    switch(body.operation){
      case 'status':{
        if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');await this.syncApprovals();
        let native:Record<string,any>;try{native=await this.channel.request({operation:'status'});this.rememberNativeStatus(native);}catch{native={success:false,code:'helper-unavailable'};this.nativeStatus=undefined;}
        const scoped=await this.scope.managementStatus();
        // The last Control status read (the panel's capability check, an AI's status or request): no extra round trip here.
        this.standing=this.scope.knownStanding();
        return {success:true,native,access:this.publicAccess(),available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,connections:[...this.connections.values()].map(c=>({id:c.id,code:c.code,label:c.label,scope:'mcp-connection',expiresAt:c.until})),
          grants:this.host.list(),pending:[...this.pending.values()].map(p=>({approvalId:p.request.approvalId,connectionId:p.connection.id,label:p.label,target:p.request.target,expiresAt:p.request.expiresAt})),recovery:this.recovery.pending(),scoped};
      }
      case 'scope-request-approval':{
        if(!exact(body,['operation','connectionId','scope','label']))throw Error('허용할 AI 연결과 범위를 선택하세요.');
        const c=[...this.connections.values()].find(c=>c.id===body.connectionId);if(!c)throw Error('해당 AI 연결이 끝났습니다. AI에서 상태를 다시 확인하세요.');
        if(typeof body.label!=='string'||!body.label.trim()||body.label.length>100||/[\u0000-\u001f\u007f]/.test(body.label))throw Error('맡길 작업 이름을 확인하세요.');
        return this.scope.requestApproval(this.caller(c),c.id,body.scope,('연결 '+c.code+' / '+body.label.trim()).slice(0,100));
      }
      case 'scope-access-set':{
        // Off also ends Control's standing allowance: the person's off means no AI asks or acts without them again.
        if(exact(body,['operation','enabled'])&&body.enabled===false){this.turnAccessOff();await this.scope.standingOff();this.standing=await this.scope.standing();return {success:true,access:this.publicAccess()};}
        if(!exact(body,['operation','enabled','scope'])||body.enabled!==true)throw Error('컴퓨터 유즈 켜기 요청을 확인하세요.');
        const scope=parseComputerUseScope(body.scope);
        if(scope.kind==='application'&&protectedScopeBundle(scope.application.bundleId))throw Error('이 앱은 컴퓨터 유즈 대상이 될 수 없습니다.');
        // A different scope first ends what the old one allowed, so no grant outlives the scope the person now sees.
        if(this.access.enabled&&sameComputerUseScope(this.access.scope,scope))return {success:true,access:this.publicAccess()};
        if(this.access.enabled)this.turnAccessOff();
        this.accessAsked.clear();this.access={enabled:true,scope};return {success:true,access:this.publicAccess()};
      }
      case 'scope-status':{
        if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');const scoped=await this.scope.refreshCapability();this.standing=this.scope.knownStanding();
        return {success:true,scoped,access:this.publicAccess()};}
      case 'scope-revoke':
        if(!exact(body,['operation','id'])||typeof body.id!=='string')throw Error('종료할 범위 허용을 확인하세요.');return this.scope.revoke(body.id);
      case 'scope-review-recovery':
        if(!exact(body,['operation','id','confirmed'])||body.confirmed!==true||typeof body.id!=='string')throw Error('현재 상태를 직접 확인한 뒤 검토를 완료하세요.');return {success:true,reviewed:this.recovery.reviewScope(body.id)};
      case 'request-approval':{
        if(!exact(body,['operation','connectionId','target','label']))throw Error('허용할 AI 연결과 창을 선택하세요.');
        const c=[...this.connections.values()].find(c=>c.id===body.connectionId);if(!c)throw Error('해당 AI 연결이 끝났습니다. AI에서 상태를 다시 확인하세요.');
        if(!this.channel.available)throw Error('서명된 컴퓨터 유즈 도우미 연결을 준비하세요.');
        const caller=this.caller(c),generation=computerCallerGeneration(caller)!;
        if(typeof body.label!=='string'||!body.label.trim()||body.label.length>100||/[\u0000-\u001f\u007f]/.test(body.label))throw Error('맡길 작업 이름을 확인하세요.');
        // The client-supplied display name never becomes a native confirmation code or approval label.
        const label=('연결 '+c.code+' / '+body.label.trim()).slice(0,100);
        const request=this.host.requestApproval(caller,parseComputerTarget(body.target),label);
        this.pending.set(request.approvalId,{connection:c,caller,generation,request,label});
        let result:Record<string,any>;
        try{result=await this.channel.request({...request,operation:'request-approval',caller:{...request.caller,generation},label});}
        catch(error){
          if((error as {notDispatched?:boolean})?.notDispatched===true){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}
          throw Error('승인 요청의 전달이 미확인입니다. 대기 상태를 확인하고 새 요청으로 자동 재전송하지 마세요.');
        }
        if(computerCallerGeneration(caller)!==generation||!this.pending.has(request.approvalId))throw Error('AI 연결이 끝나 승인 요청을 취소했습니다.');
        if(result.success!==true){if(result.notDispatched===true){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}throw Error('승인 요청의 전달을 확인하지 못했습니다. 대기 상태를 확인하고 새 요청으로 자동 재전송하지 마세요.');}
        return {success:true,approvalId:request.approvalId,state:'pending',expiresAt:request.expiresAt};
      }
      case 'revoke':
        if(!exact(body,['operation','id'])||typeof body.id!=='string')throw Error('종료할 허용을 확인하세요.');return this.host.revoke(body.id);
      case 'disconnect':{
        if(!exact(body,['operation','connectionId']))throw Error('종료할 AI 연결을 확인하세요.');
        for(const[key,c]of this.connections)if(c.id===body.connectionId){this.connections.delete(key);this.end(c);}return {success:true};
      }
      case 'review-recovery':
        if(!exact(body,['operation','id','confirmed'])||body.confirmed!==true||typeof body.id!=='string')throw Error('앱의 현재 상태를 직접 확인한 뒤 검토를 완료하세요.');
        return {success:true,reviewed:this.recovery.review(body.id)};
      default:throw Error('지원하지 않는 컴퓨터 유즈 관리 요청입니다.');
    }
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const c of this.connections.values())this.end(c);this.connections.clear();this.host.dispose();this.scope.dispose();this.pending.clear();this.publicKey=undefined;this.channel.dispose();}
}
