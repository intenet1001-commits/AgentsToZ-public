import {createHash,createHmac,randomUUID} from 'node:crypto';
import {constants,openSync,renameSync,writeFileSync,closeSync,fsyncSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,readPromptGuideFile,syncPromptGuideDirectory} from './promptGuideKeyProvider';
import {describeAgentDialogueRpcError} from './agentDialogueDatabaseState';
import {parseAgentDialogueRequest,type AgentDialogueRequest,type AgentDialogueTarget} from './agentDialogueContract';
import {communityDeviceRef,communityDeviceRows} from './communityDeviceRef';
import {COMMUNITY_CONTROL_ACTIVE_WINDOW_MS} from './agentDialogueControl';

export interface AgentDialogueLocalTarget {kind:'ops'|'project';portId?:string;displayName:string;memoryId?:string|null}
export interface AgentDialogueHostDependencies {
  appDataDir:string;
  identity():{profileId:string;deviceId:string};
  resolveTarget(target:AgentDialogueTarget):Promise<AgentDialogueLocalTarget>;
  rpc(operation:string,profileId:string,deviceId:string,secret:string,args:Record<string,unknown>):Promise<Record<string,any>>;
  /** Isolated tests may supply a key; production always uses the OS protected store. */
  secret?(profileId:string,deviceId:string,allowCreate:boolean):Promise<string>;
  /**
   * IDs still in this device's project registration. A project endpoint whose ID is gone is
   * retired. Throw when the registration cannot be read: nothing is retired on doubt. Not the
   * resolvable-project list, which also drops a project whose folder is merely unreachable.
   */
  registeredProjectIds?():Promise<ReadonlySet<string>>;
  now?:()=>number;
}
interface EnabledEndpoint {kind:'ops'|'project';portId?:string;incarnationId:string;endpointId:string;displayName:string}
/** Another community device this Mac can drive. Display only; every request is re-checked by the database. */
export interface AgentDialogueControlDevice {endpointId:string;deviceId:string;displayName:string;kind:'ops'|'project';lastSeenAt:string|null}
/** Below the Tauri proxy's 30-second read timeout for the control route, with room to answer. */
export const AGENT_DIALOGUE_CONTROL_TIMEOUT_MS=20_000;
/**
 * 휴대폰이 거친 전달에는 더 짧은 마감을 준다. 휴대폰 릴레이는 요청을 **하나씩** 처리하므로, 답하지
 * 않는 Mac을 20초씩 기다리면 그 동안 화면의 배경 조회가 전부 뒤에 줄을 서다 32개 상한에 걸려
 * 「대기 중인 원격 입력이 많습니다」로 바뀐다 — 실제 원인(그 Mac이 답하지 않음)이 가려진다
 * (2026-10-05 아이폰 17 실기). 깨어 있는 Mac은 유휴 폴링 3초 + 왕복이라 8초로 충분하다.
 */
export const AGENT_DIALOGUE_CONTROL_MOBILE_TIMEOUT_MS=8_000;
/** 전달 대상 조회를 묶어 두는 시간. 짧게 — 기기가 나가면 다음 요청에서 다시 조회한다. */
export const FORWARD_TARGET_CACHE_MS=10_000;
/** 파생 비밀 메모 수명. 짧게 — 프로필·기기가 바뀌면 `load`·`disable`에서 함께 비운다. */
export const SECRET_CACHE_MS=30_000;
/** 다른 기기가 보낸 요청 하나의 실행 마감. 휴대폰 마감(8초)보다 길지만 폴을 영구히 잡지는 못한다. */
export const CONTROL_EXECUTE_DEADLINE_MS=25_000;
/** 한 번의 우편함 폴이 쓸 수 있는 전체 시간. 남은 건은 다음 폴로 넘긴다. */
export const CONTROL_POLL_BUDGET_MS=60_000;
/** Display-only facts about the MCP connection asking; never used for authorization. */
export interface AgentDialogueRequester {client?:string|null}
interface PendingGrant {id:string;instanceId:string;endpointId:string;roomId?:string;requestHash:string;summary:string;expiresAt:number;request:AgentDialogueRequest;
  requestedAt:number;client:string|null;connection:string}
interface ActiveGrant {instanceId:string;endpointId:string;roomId:string;expiresAt:number;hardExpiresAt:number}
interface PendingRevocation {endpointId:string;profileId:string;deviceId:string}
/** A room grant idles out after 30 minutes but every use renews it, so an agent waiting on a slow
 *  peer is not asked again; it never outlives the room's own 24-hour lifetime. */
const GRANT_IDLE_TTL=30*60_000;
const GRANT_MAX_TTL=24*60*60_000;
const APPROVAL_TTL=5*60_000;
/** 유지 틱의 heartbeat 동시 발송 수. 직렬이면 공개 수만큼 줄 서고, 전부 동시면 릴레이를 때린다. */
const MAINTENANCE_HEARTBEAT_CONCURRENCY=6;
/** A cold Mac can publish many endpoints. Bound the parallel membership probes. */
const COMMUNITY_STATUS_CONCURRENCY=6;
const PAIRED_PEERS_TTL=60_000;
type CommunityMembership={roomId:string|null;inside:boolean;expiresAt:number};
const AUTO_JOIN_PER_TICK=8;
const CLIENT_LABEL_MAX=40;
/** The MCP client's self-reported name is untrusted: keep plain printable text only. */
export function agentDialogueClientLabel(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const text=value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g,'').trim();
  return text?text.slice(0,CLIENT_LABEL_MAX):null;
}
/** Two requests from different MCP connections must look different, without exposing the private instance id. */
const connectionTag=(instanceId:string)=>createHash('sha256').update(`agent-dialogue-connection\0${instanceId}`).digest('hex').slice(0,6);
const FILE_NAME='agent-dialogue-endpoints.v1.json';
const instancePattern=/^[0-9a-f]{64}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key=(target:AgentDialogueTarget)=>'target'in target?'ops':`project:${target.portId}`;
const roomGrantKey=(instanceId:string,endpointId:string,roomId:string)=>`${instanceId}:${endpointId}:${roomId}`;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** How many of the newest room events a freshly opened community screen starts with. */
const COMMUNITY_FIRST_READ_TAIL=5; // = one phone payload (REMOTE_COMMUNITY_MESSAGE_LIMIT), so the newest line is in the first answer
export class AgentDialogueHostError extends Error {
  constructor(readonly code:string,message:string,readonly status=409){super(message);this.name='AgentDialogueHostError';}
}

/** No remote write, Keychain access or directory creation during construction/status. */
/**
 * 같은 요청 id → 같은 uuid. 휴대폰 봉투의 requestId는 uuid가 아닐 수 있는데(`[A-Za-z0-9_-]{8,160}`)
 * 대화 DB의 멱등 키는 uuid다. 그대로 넘기면 캐스팅에서 죽고, 매번 새로 만들면 재시도가 **두 번
 * 보낸다**. 그래서 결정적으로 유도한다.
 */
function stableRequestUuid(seed:string):string{
  const h=createHash('sha256').update('agentstoz-community-request:'+seed).digest('hex');
  const variant=((parseInt(h.slice(16,17),16)&0x3)|0x8).toString(16);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${variant}${h.slice(17,20)}-${h.slice(20,32)}`;
}

/**
 * `communityMobile`가 돌려주는 것. community-status의 원본 키가 그대로 지나가고(그대로
 * `remoteCommunityState`가 깎는다) 여기서 더해지는 것은 기기 목록·메시지·커서다.
 */
export interface AgentDialogueCommunityMobileSnapshot extends Record<string,unknown> {
  inside:boolean;
  roomId:string|null;
  devices:{ref:string;name:string;kind:'ops'|'project'}[];
  messages:unknown[];
}

export class AgentDialogueHost {
  private readonly deps:AgentDialogueHostDependencies;
  private readonly clock:()=>number;
  private readonly file:string;
  private loadedProfile:string|null=null;
  private loadedDeviceId:string|null=null;
  private registered=false;
  private enabled=new Map<string,EnabledEndpoint>();
  private pending=new Map<string,PendingGrant>();
  private approved=new Map<string,number>();
  private grants=new Map<string,ActiveGrant>();
  private revocations:PendingRevocation[]=[];
  private maintenanceRunning=false;
  /** endpointId -> active paired peer endpointId -> that pairing's expiry (ms). */
  private pairedPeers=new Map<string,{peers:Map<string,number>;expiresAt:number}>();
  /** One device-wide answer for the auto-join tick: local endpointId -> its paired peers. */
  private devicePairings:{pairs:Map<string,Set<string>>;expiresAt:number}|null=null;
  private autoJoinRunning=false;
  private controlPolling=false;
  /** endpointId -> this endpoint's standing community membership. Entering is the consent, so a
   *  member may talk in that room without a per-request approval; everything else still asks. */
  private community=new Map<string,CommunityMembership>();
  /** A cache miss shared by overlapping control, mobile, and MCP reads of the same endpoint. */
  private communityInFlight=new Map<string,{promise:Promise<CommunityMembership>;fresh:boolean}>();
  private communityRevision=0;
  /** A project already found inside is checked immediately after OPS on later scans. */
  private preferredCommunityEndpointId:string|null=null;
  /** 전달 대상 조회 캐시(ref → endpointId). 권한이 아니라 **조회**만 캐시한다 — DB가 매 요청마다 본다. */
  private forwardTargets:{byRef:Map<string,string>;expiresAt:number}|null=null;
  /** 파생 비밀의 짧은 메모 — 폴링이 보호 저장소를 매번 읽지 않게. */
  private secrets=new Map<string,{value:string;expiresAt:number}>();
  /** 상대 기기가 마지막으로 답한 시각 — 되묻기 간격을 물러나게 할지 판단한다. */
  private controlAnsweredAt:number|null=null;
  constructor(deps:AgentDialogueHostDependencies){this.deps=deps;this.clock=deps.now??Date.now;this.file=join(deps.appDataDir,FILE_NAME);}
  private identity(){
    const value=this.deps.identity();
    if(!value.profileId||!value.deviceId)throw new AgentDialogueHostError('AGENT_DIALOGUE_PROFILE_REQUIRED','공유 AgentsToZ 총괄 프로필과 기기를 연결하세요.');
    if(this.loadedProfile!==value.profileId||this.loadedDeviceId!==value.deviceId)this.load(value.profileId,value.deviceId);
    return value;
  }
  private load(profileId:string,deviceId:string){
    const priorProfile=this.loadedProfile,priorDevice=this.loadedDeviceId;
    const priorEndpoints=[...this.enabled.values()],priorRevocations=[...this.revocations];
    this.loadedProfile=profileId;this.loadedDeviceId=deviceId;this.registered=false;
    this.enabled.clear();this.pending.clear();this.approved.clear();this.grants.clear();this.revocations=[];this.pairedPeers.clear();this.devicePairings=null;this.invalidateCommunityMembership();this.preferredCommunityEndpointId=null;this.devicesCache=null;this.secrets.clear();this.forwardTargets=null;
    if(priorProfile&&priorDevice){
      this.revocations=[...priorRevocations,...priorEndpoints.map(item=>({
        endpointId:item.endpointId,profileId:priorProfile,deviceId:priorDevice}))];
      this.registered=this.revocations.length>0;
      try{this.save();}catch{
        this.loadedProfile=null;this.loadedDeviceId=null;
        throw new AgentDialogueHostError('AGENT_DIALOGUE_STORE_UNAVAILABLE','계정 전환 중 대화 연결 설정을 저장하지 못했습니다.');
      }
      return;
    }
    try{
      if(!promptGuideDirectory(this.deps.appDataDir))return;
      const bytes=readPromptGuideFile(this.file,64*1024);if(!bytes)return;
      let doc:Record<string,any>;
      try{doc=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
      if(![1,2].includes(doc.schemaVersion)||typeof doc.profileId!=='string'||!Array.isArray(doc.endpoints))
        throw new Error('invalid endpoint store');
      if(doc.schemaVersion===2&&(typeof doc.deviceId!=='string'||!doc.deviceId))throw new Error('missing stored device');
      const storedDevice=doc.schemaVersion===2?doc.deviceId as string:deviceId;
      this.registered=true;
      if(Array.isArray(doc.revocations))this.revocations=doc.revocations.filter((item:unknown):item is PendingRevocation=>
        !!item&&typeof item==='object'&&typeof (item as PendingRevocation).endpointId==='string'
        &&typeof (item as PendingRevocation).deviceId==='string').map((item:PendingRevocation)=>({
          endpointId:item.endpointId,deviceId:item.deviceId,
          profileId:typeof item.profileId==='string'?item.profileId:doc.profileId}));
      const switched=doc.profileId!==profileId||storedDevice!==deviceId;
      for(const item of doc.endpoints){
        if(!item||!['ops','project'].includes(item.kind)||typeof item.incarnationId!=='string'||typeof item.endpointId!=='string')continue;
        if(item.kind==='project'&&(typeof item.portId!=='string'||!item.portId))continue;
        if(switched){this.revocations.push({endpointId:item.endpointId,profileId:doc.profileId,deviceId:storedDevice});continue;}
        const target=item.kind==='ops'?{target:'ops' as const}:{portId:item.portId as string};
        this.enabled.set(key(target),{kind:item.kind,...(item.kind==='project'?{portId:item.portId}:{}),incarnationId:item.incarnationId,endpointId:item.endpointId,displayName:String(item.displayName??'').slice(0,120)});
      }
      if(switched)this.save();
    }catch{
      this.loadedProfile=null;this.loadedDeviceId=null;this.enabled.clear();this.revocations=[];this.pairedPeers.clear();this.devicePairings=null;this.invalidateCommunityMembership();this.preferredCommunityEndpointId=null;this.devicesCache=null;this.secrets.clear();this.forwardTargets=null;
      throw new AgentDialogueHostError('AGENT_DIALOGUE_STORE_UNAVAILABLE','저장된 대화 상대 설정을 읽지 못했습니다. 파일을 보존하고 점검하세요.');
    }
  }
  private save(){
    const directory=promptGuideDirectory(this.deps.appDataDir,true)!;
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    const descriptor=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    try{
      writeFileSync(descriptor,JSON.stringify({schemaVersion:2,profileId:this.loadedProfile,deviceId:this.loadedDeviceId,
        endpoints:[...this.enabled.values()],revocations:this.revocations})+'\n');fsyncSync(descriptor);
    }catch(error){closeSync(descriptor);unlinkSync(temporary);throw error;}
    closeSync(descriptor);
    renameSync(temporary,this.file);syncPromptGuideDirectory(directory);
  }
  /**
   * ⚠️ 파생 비밀을 짧게 메모한다. 이 호출은 보호 저장소를 읽는 **프로세스 spawn**이고(실측 13~28ms),
   * 제어 우편함 폴링은 활성일 때 0.6초마다 돈다 — 초당 ~1.7회를 그냥 쓰고 있었다(2026-10-05 감사).
   * 문자열은 지울 수 없으므로 TTL을 짧게 두고, 프로필 전환(`load`)과 공개 해제(`disable`)에서 비운다.
   */
  private async secret(profileId:string,deviceId:string,allowCreate=false):Promise<string>{
    const key=profileId+'\u0000'+deviceId;
    const cached=this.secrets.get(key);
    if(cached&&cached.expiresAt>this.clock())return cached.value;
    const value=await this.secretUncached(profileId,deviceId,allowCreate);
    this.secrets.set(key,{value,expiresAt:this.clock()+SECRET_CACHE_MS});
    return value;
  }
  private async secretUncached(profileId:string,deviceId:string,allowCreate=false):Promise<string>{
    if(this.deps.secret)return this.deps.secret(profileId,deviceId,allowCreate);
    const provider=createProductionPromptGuideKeyProvider({appDataDir:this.deps.appDataDir,namespace:{
      keychainService:'com.portmanager.portmanager.agent-dialogue.v1',keychainAccount:'device-master-v1',
      dpapiFile:'agent-dialogue.v1.key.dpapi',dpapiEntropy:'agentstoz-agent-dialogue-v1'}});
    const master=allowCreate?await provider.create():await provider.read();
    if(!master)throw new AgentDialogueHostError('AGENT_DIALOGUE_KEY_MISSING','기존 대화 기기 키가 없습니다. 새 키를 만들지 않고 연결을 중단했습니다.');
    try{return createHmac('sha256',master).update(`${profileId}\0${deviceId}`).digest('hex');}
    finally{master.fill(0);}
  }
  private prune(){
    const now=this.clock();
    for(const [id,value] of this.pending)if(value.expiresAt<=now)this.pending.delete(id);
    for(const [id,until] of this.approved)if(until<=now)this.approved.delete(id);
    for(const [id,value] of this.grants)if(value.expiresAt<=now)this.grants.delete(id);
  }
  /**
   * A deleted project kept advertising its endpoint to every peer until someone pressed 연결 끄기
   * (2026-10-04). Retire it like 연결 끄기 does, but drop only that endpoint's grants and requests so
   * other rooms keep working; the revocation queue revokes it remotely.
   */
  private retireUnregisteredProjects(registered:ReadonlySet<string>|undefined,profileId:string,deviceId:string){
    if(!registered)return;
    let changed=false;
    for(const [target,item] of [...this.enabled]){
      if(item.kind!=='project'||!item.portId||registered.has(item.portId))continue;
      this.enabled.delete(target);
      for(const [id,grant] of this.grants)if(grant.endpointId===item.endpointId)this.grants.delete(id);
      for(const [id,request] of this.pending)if(request.endpointId===item.endpointId)this.pending.delete(id);
      this.revocations.push({endpointId:item.endpointId,profileId,deviceId});changed=true;
    }
    if(changed){
      this.invalidateCommunityMembership();
      if(![...this.enabled.values()].some(item=>item.endpointId===this.preferredCommunityEndpointId))
        this.preferredCommunityEndpointId=null;
      this.save();
    }
  }
  /** A bounded host tick performs remote retention only for an already enabled profile. */
  async maintenance():Promise<void>{
    if(this.maintenanceRunning)return;
    this.maintenanceRunning=true;
    try{
      const {profileId,deviceId}=this.identity();
      if(!this.registered)return;
      let revocationError:unknown;
      try{this.retireUnregisteredProjects(await this.deps.registeredProjectIds?.(),profileId,deviceId);}
      catch(error){revocationError??=error;}
      for(const item of [...this.revocations]){
        try{
          const revocationSecret=await this.secret(item.profileId,item.deviceId);
          await this.deps.rpc('revoke-endpoint',item.profileId,item.deviceId,revocationSecret,{endpointId:item.endpointId});
          this.revocations=this.revocations.filter(candidate=>candidate.endpointId!==item.endpointId
            ||candidate.profileId!==item.profileId||candidate.deviceId!==item.deviceId);
          this.save();
        }catch(error){revocationError??=error;}
      }
      if(this.enabled.size>0){
        try{await this.syncDisplayNames(profileId,deviceId);}catch(error){revocationError??=error;}
        const secret=await this.secret(profileId,deviceId);
        // ⚠️ heartbeat 를 **직렬로** 돌면 공개한 엔드포인트 수만큼 왕복이 줄 선다(실측 101개 공개 →
        // 틱 하나가 101번의 직렬 RPC). 그 동안 단일 스레드 사이드카가 다른 요청을 받지 못한다.
        // 한꺼번에 101개를 던지지도 않는다 — 6개씩 끊어 보낸다. 하나가 실패해도 나머지는 보내고
        // (옛 동작은 첫 실패에서 멈춰 뒤쪽 엔드포인트가 조용히 늙었다) 첫 오류를 그대로 던진다.
        const beats=[...this.enabled.values()];
        let beatError:unknown;
        for(let index=0;index<beats.length;index+=MAINTENANCE_HEARTBEAT_CONCURRENCY){
          const results=await Promise.allSettled(beats.slice(index,index+MAINTENANCE_HEARTBEAT_CONCURRENCY)
            .map(item=>this.deps.rpc('heartbeat',profileId,deviceId,secret,{sourceEndpointId:item.endpointId})));
          for(const result of results)if(result.status==='rejected')beatError??=result.reason;
        }
        if(beatError)throw beatError;
        try{await this.autoJoinPairedInvitations();}catch(error){revocationError??=error;}
        await this.deps.rpc('prune',profileId,deviceId,secret,{});
      }
      if(revocationError)throw revocationError;
    }finally{this.maintenanceRunning=false;}
  }
  status(){
    this.identity();this.prune();
    return {enabled:[...this.enabled.entries()].map(([target,item])=>({target,kind:item.kind,portId:item.portId,
      endpointId:item.endpointId,displayName:item.displayName})),remoteRevocationPending:this.revocations.length,
      pending:[...this.pending.values()].sort((a,b)=>b.requestedAt-a.requestedAt).map(item=>({
        id:item.id,summary:item.summary,expiresAt:new Date(item.expiresAt).toISOString(),
        requestedAt:new Date(item.requestedAt).toISOString(),client:item.client,connection:item.connection,
        source:item.request.source,operation:item.request.operation,roomId:item.roomId??null}))};
  }
  /** Keep existing consent and endpoint identity when the local device nickname changes. */
  async refreshDisplayNames():Promise<{updated:number}>{
    const {profileId,deviceId}=this.identity();
    return this.syncDisplayNames(profileId,deviceId);
  }
  private async syncDisplayNames(profileId:string,deviceId:string):Promise<{updated:number}>{
    let secret:string|null=null,updated=0,firstError:unknown;
    // One project whose folder is briefly unreachable must not keep every later endpoint on its old name.
    for(const [target,item] of [...this.enabled]){
      try{
        const local=await this.deps.resolveTarget(item.kind==='ops'?{target:'ops'}:{portId:item.portId!});
        if(local.kind!==item.kind||local.kind==='project'&&local.portId!==item.portId){
          throw new AgentDialogueHostError('AGENT_DIALOGUE_SOURCE_MISMATCH','등록된 대화 대상을 다시 확인하세요.');
        }
        if(local.displayName===item.displayName)continue;
        if(!secret){
          secret=await this.secret(profileId,deviceId);
          await this.deps.rpc('register-device',profileId,deviceId,secret,{});
        }
        const result=await this.deps.rpc('register-endpoint',profileId,deviceId,secret,{
          kind:item.kind,...(item.kind==='project'?{portId:item.portId,memoryId:local.memoryId??null}:{}),
          incarnationId:item.incarnationId,displayName:local.displayName});
        if(typeof result.endpointId!=='string')throw new AgentDialogueHostError('AGENT_DIALOGUE_BAD_RECEIPT','대화 상대 이름 변경 영수증을 확인하지 못했습니다.');
        if(result.endpointId!==item.endpointId){
          this.pending.clear();this.approved.clear();this.grants.clear();this.invalidateCommunityMembership();
          if(this.preferredCommunityEndpointId===item.endpointId)this.preferredCommunityEndpointId=null;
        }
        this.enabled.set(target,{...item,endpointId:result.endpointId,displayName:local.displayName});
        this.save();updated++;
      }catch(error){firstError??=error;}
    }
    if(firstError)throw firstError;
    return {updated};
  }
  async enable(target:AgentDialogueTarget,consent:boolean){
    if(consent!==true)throw new AgentDialogueHostError('AGENT_DIALOGUE_CONSENT_REQUIRED','대화 본문과 대상 정보의 Supabase 저장에 동의해야 합니다.');
    const {profileId,deviceId}=this.identity();
    const local=await this.deps.resolveTarget(target);
    if(local.kind==='ops'&&'portId'in target||local.kind==='project'&&'target'in target)
      throw new AgentDialogueHostError('AGENT_DIALOGUE_SOURCE_MISMATCH','선택한 총괄 또는 프로젝트를 다시 확인하세요.');
    const previous=this.enabled.get(key(target));
    const secret=await this.secret(profileId,deviceId,true);
    await this.deps.rpc('register-device',profileId,deviceId,secret,{});
    const incarnationId=previous?.incarnationId??randomUUID();
    const result=await this.deps.rpc('register-endpoint',profileId,deviceId,secret,{
      kind:local.kind,...(local.kind==='project'?{portId:local.portId,memoryId:local.memoryId??null}:{}),
      incarnationId,displayName:local.displayName});
    if(typeof result.endpointId!=='string')throw new AgentDialogueHostError('AGENT_DIALOGUE_BAD_RECEIPT','대화 상대 등록 영수증을 확인하지 못했습니다.');
    this.enabled.set(key(target),{kind:local.kind,...(local.kind==='project'?{portId:local.portId}:{}),
      incarnationId,endpointId:result.endpointId,displayName:local.displayName});
    this.invalidateCommunityMembership(result.endpointId);
    if(previous?.endpointId&&previous.endpointId!==result.endpointId){
      this.invalidateCommunityMembership(previous.endpointId);
      if(this.preferredCommunityEndpointId===previous.endpointId)this.preferredCommunityEndpointId=null;
    }
    this.registered=true;
    this.save();
    return {endpointId:this.enabled.get(key(target))!.endpointId,kind:local.kind};
  }
  /**
   * The peers this endpoint is mutually paired with. A pairing is the 30-day equivalent of the QR
   * remote control's session: it removes the per-room approval for that exact couple and nothing
   * else. Every RPC still re-checks the profile, the device key and both endpoints' state, so a
   * stale cache can only cost one extra approval, never grant access.
   */
  private invalidateCommunityMembership(endpointId?:string){
    if(endpointId){
      this.community.delete(endpointId);
      this.communityInFlight.delete(endpointId);
    }else{
      // Profile changes and disabling the host fence every outstanding endpoint read.
      this.communityRevision++;
      this.community.clear();
      this.communityInFlight.clear();
    }
  }
  private async communityMembership(profileId:string,deviceId:string,secret:string,endpointId:string,fresh=false){
    const existing=this.communityInFlight.get(endpointId);
    if(fresh){
      // A fresh read bypasses a prior ordinary probe, while two overlapping fresh callers can
      // share the same server answer without invalidating one another.
      if(existing?.fresh)return existing.promise;
      this.invalidateCommunityMembership(endpointId);
    }else{
      const cached=this.community.get(endpointId);
      if(cached&&cached.expiresAt>this.clock())return cached;
      if(existing)return existing.promise;
    }
    const revision=this.communityRevision;
    let flight!:{promise:Promise<CommunityMembership>;fresh:boolean};
    const pending=(async()=>{
      const result=await this.rpc('community-status',profileId,deviceId,secret,{sourceEndpointId:endpointId});
      // A leave, disable, or profile change may finish while the network read is pending. The old
      // answer must neither authorize a caller nor fill the new identity's endpoint cache.
      if(revision!==this.communityRevision||this.communityInFlight.get(endpointId)!==flight
        ||this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId
        ||![...this.enabled.values()].some(item=>item.endpointId===endpointId))
        return {roomId:null,inside:false,expiresAt:this.clock()};
      const value={roomId:typeof result.roomId==='string'?result.roomId:null,inside:result.inside===true,
        expiresAt:this.clock()+PAIRED_PEERS_TTL};
      this.community.set(endpointId,value);
      return value;
    })();
    flight={promise:pending,fresh};
    this.communityInFlight.set(endpointId,flight);
    try{return await pending;}
    finally{if(this.communityInFlight.get(endpointId)===flight)this.communityInFlight.delete(endpointId);}
  }
  private async activePairings(profileId:string,deviceId:string,secret:string,endpointId:string,fresh=false):Promise<Map<string,number>>{
    const cached=this.pairedPeers.get(endpointId);
    if(!fresh&&cached&&cached.expiresAt>this.clock())return cached.peers;
    const result=await this.rpc('pairings',profileId,deviceId,secret,{sourceEndpointId:endpointId});
    const peers=new Map<string,number>();
    for(const row of Array.isArray(result.pairings)?result.pairings:[]){
      const value=row as Record<string,unknown>;
      if(value.state!=='active'||typeof value.peerEndpointId!=='string')continue;
      const until=typeof value.expiresAt==='string'?Date.parse(value.expiresAt):Number.NaN;
      peers.set(value.peerEndpointId,Number.isFinite(until)?until:this.clock()+PAIRED_PEERS_TTL);
    }
    this.pairedPeers.set(endpointId,{peers,expiresAt:this.clock()+PAIRED_PEERS_TTL});
    return peers;
  }
  /**
   * Join the rooms a paired peer opened, without a person. An unanswered invitation is exactly what
   * left cross-device dialogue silent (2026-10-04: the remote OPS never joined, so the room held
   * only the sender), and the 10-minute retention tick is far too slow for a conversation — this
   * runs on its own fast timer.
   *
   * Two device-wide reads per tick, not two per endpoint: a Mac can publish a hundred endpoints.
   * When this device has no active pairing the invitation read is skipped and the answer is reused
   * for a minute, so an unpaired Mac costs one RPC a minute. Only an active mutual pairing qualifies
   * and the join RPC re-checks both endpoints, so a stale cache cannot widen access.
   */
  async autoJoinPairedInvitations():Promise<{joined:number}>{
    if(this.autoJoinRunning)return {joined:0};
    this.autoJoinRunning=true;
    try{
      const {profileId,deviceId}=this.identity();
      if(!this.registered||this.enabled.size===0)return {joined:0};
      const secret=await this.secret(profileId,deviceId);
      const now=this.clock();
      if(this.devicePairings===null||this.devicePairings.expiresAt<=now){
        const listed=await this.rpc('device-pairings',profileId,deviceId,secret,{});
        const pairs=new Map<string,Set<string>>();
        for(const row of Array.isArray(listed.pairings)?listed.pairings:[]){
          const value=row as Record<string,unknown>;
          if(typeof value.sourceEndpointId!=='string'||typeof value.peerEndpointId!=='string')continue;
          const peers=pairs.get(value.sourceEndpointId)??new Set<string>();
          peers.add(value.peerEndpointId);pairs.set(value.sourceEndpointId,peers);
        }
        this.devicePairings={pairs,expiresAt:now+PAIRED_PEERS_TTL};
      }
      const {pairs}=this.devicePairings;
      if(pairs.size===0)return {joined:0};
      const found=await this.rpc('device-invitations',profileId,deviceId,secret,{});
      const mine=new Set([...this.enabled.values()].map(item=>item.endpointId));
      let joined=0;
      for(const row of Array.isArray(found.invitations)?found.invitations:[]){
        if(joined>=AUTO_JOIN_PER_TICK)break;
        const value=row as Record<string,unknown>;
        const source=value.sourceEndpointId;
        if(typeof source!=='string'||!mine.has(source))continue;
        if(typeof value.roomId!=='string'||typeof value.from!=='string')continue;
        if(!pairs.get(source)?.has(value.from))continue;
        await this.deps.rpc('join',profileId,deviceId,secret,
          {sourceEndpointId:source,roomId:value.roomId,requestId:randomUUID()});
        joined+=1;
      }
      return {joined};
    }finally{this.autoJoinRunning=false;}
  }
  /**
   * The app's own pairing surface. A click in 「아젠투지 설정」 is the approval — the same place every
   * other approval is given — so these do not open a pending request. They still re-check the
   * profile, the device key and that this exact local target is the enabled endpoint.
   */
  /**
   * 한 곳에서 보내므로, DB가 이 동작을 모르는 경우를 한 번만 설명하면 된다.
   *
   * ⚠️ `label` 은 **설명용 이름**이고 와이어로 가지 않는다. 커뮤니티의 보내기·읽기는 방 조작이라 RPC
   * 이름이 `send`·`read` 인데, 그 이름만 보면 「커뮤니티가 유휴로 거절됐다」를 커뮤니티 문제로 설명할 수
   * 없다(감사 2026-10-06: 이름 경로가 이중으로 막혀 원시 코드가 화면에 그대로 떴다).
   */
  private async rpc(operation:string,profileId:string,deviceId:string,secret:string,args:Record<string,unknown>,label=operation){
    try{return await this.deps.rpc(operation,profileId,deviceId,secret,args);}
    catch(error){
      const described=describeAgentDialogueRpcError(label,error);
      if(described)throw new AgentDialogueHostError(described.code,described.message,409);
      throw error;
    }
  }
  private async uiEndpoint(target:AgentDialogueTarget){
    const {profileId,deviceId}=this.identity();
    const endpoint=this.enabled.get(key(target));
    if(!endpoint)throw new AgentDialogueHostError('AGENT_DIALOGUE_NOT_ENABLED','이 총괄 또는 프로젝트의 대화 연결을 먼저 켜세요.');
    const local=await this.deps.resolveTarget(target);
    if(local.kind!==endpoint.kind||local.kind==='project'&&local.portId!==endpoint.portId)
      throw new AgentDialogueHostError('AGENT_DIALOGUE_SOURCE_CHANGED','등록 대상이 변경됐습니다. 연결을 다시 준비하세요.');
    return {profileId,deviceId,endpoint,secret:await this.secret(profileId,deviceId)};
  }
  async uiPeers(target:AgentDialogueTarget){
    const {profileId,deviceId,endpoint,secret}=await this.uiEndpoint(target);
    const result=await this.rpc('peers',profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId});
    return {peers:Array.isArray(result.peers)?result.peers:[]};
  }
  async uiPairings(target:AgentDialogueTarget){
    const {profileId,deviceId,endpoint,secret}=await this.uiEndpoint(target);
    const result=await this.rpc('pairings',profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId});
    return {pairings:Array.isArray(result.pairings)?result.pairings:[]};
  }
  async uiPair(target:AgentDialogueTarget,peerEndpointId:unknown,revoke=false){
    if(typeof peerEndpointId!=='string'||!uuidPattern.test(peerEndpointId))
      throw new AgentDialogueHostError('AGENT_DIALOGUE_PAIR_PEER_INVALID','연결할 상대를 다시 선택하세요.');
    const {profileId,deviceId,endpoint,secret}=await this.uiEndpoint(target);
    const result=await this.rpc(revoke?'pair-revoke':'pair',profileId,deviceId,secret,
      {sourceEndpointId:endpoint.endpointId,peerEndpointId,requestId:randomUUID()});
    this.pairedPeers.delete(endpoint.endpointId);this.devicePairings=null;
    return result;
  }
  async uiCommunity(target:AgentDialogueTarget,action:'status'|'join'|'leave'){
    const {profileId,deviceId,endpoint,secret}=await this.uiEndpoint(target);
    const result=await this.rpc(action==='status'?'community-status':`community-${action}`,
      profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId,
        ...(action==='status'?{}:{requestId:randomUUID()})});
    if(action!=="status"){
      this.invalidateCommunityMembership(endpoint.endpointId);this.devicesCache=null;
      if(action==='join')this.preferredCommunityEndpointId=endpoint.endpointId;
      else if(this.preferredCommunityEndpointId===endpoint.endpointId)this.preferredCommunityEndpointId=null;
    }
    return result;
  }
  /**
   * The local endpoint that speaks for this device in the community: the OPS endpoint when it is
   * inside, otherwise any enabled endpoint that is. Membership is cached for a minute. A Mac with
   * many outside endpoints still needs to check them all when that cache expires, so probe in a
   * bounded pool rather than waiting for each network round trip serially. An active project is
   * remembered and checked just after OPS next time; this keeps the common joined case small.
   */
  private async communityEndpoint(fresh=false):Promise<{profileId:string;deviceId:string;secret:string;endpoint:EnabledEndpoint;roomId:string}|null>{
    const {profileId,deviceId}=this.identity();
    if(!this.registered||this.enabled.size===0)return null;
    const secret=await this.secret(profileId,deviceId);
    if(this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId)return null;
    const ordered=[...this.enabled.values()].sort((a,b)=>
      (a.kind==='ops'?0:1)-(b.kind==='ops'?0:1)
      ||(a.endpointId===this.preferredCommunityEndpointId?-1:0)-(b.endpointId===this.preferredCommunityEndpointId?-1:0));
    // OPS takes precedence even if a project is also inside. Checking it first avoids the
    // unnecessary burst on the usual OPS device.
    const first=ordered.shift()!;
    const firstMembership=await this.communityMembership(profileId,deviceId,secret,first.endpointId,fresh);
    if(this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId)return null;
    if(firstMembership.inside&&firstMembership.roomId){
      this.preferredCommunityEndpointId=first.endpointId;
      return {profileId,deviceId,secret,endpoint:first,roomId:firstMembership.roomId};
    }
    const preferredIndex=ordered.findIndex(endpoint=>endpoint.endpointId===this.preferredCommunityEndpointId);
    if(preferredIndex>=0){
      const preferred=ordered.splice(preferredIndex,1)[0]!;
      const membership=await this.communityMembership(profileId,deviceId,secret,preferred.endpointId,fresh);
      if(this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId)return null;
      if(membership.inside&&membership.roomId)
        return {profileId,deviceId,secret,endpoint:preferred,roomId:membership.roomId};
      this.preferredCommunityEndpointId=null;
    }
    for(let offset=0;offset<ordered.length;offset+=COMMUNITY_STATUS_CONCURRENCY){
      if(this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId)return null;
      const batch=ordered.slice(offset,offset+COMMUNITY_STATUS_CONCURRENCY);
      const memberships=await Promise.all(batch.map(endpoint=>
        this.communityMembership(profileId,deviceId,secret,endpoint.endpointId,fresh)));
      if(this.loadedProfile!==profileId||this.loadedDeviceId!==deviceId)return null;
      for(let index=0;index<batch.length;index++){
        const membership=memberships[index]!;
        if(!membership.inside||!membership.roomId)continue;
        const endpoint=batch[index]!;
        this.preferredCommunityEndpointId=endpoint.endpointId;
        return {profileId,deviceId,secret,endpoint,roomId:membership.roomId};
      }
    }
    return null;
  }
  /**
   * 휴대폰에서 보는 커뮤니티 — 상태·읽기·보내기. UI 경로이므로 MCP 승인 장부를 거치지 않는다:
   * 부르는 쪽은 이미 이 Mac의 원격 제어 페어링과 SAS 승인을 통과한 기기이고, api-server가 요청 대상이
   * **이 Mac의 OPS 프로젝트**인지 먼저 본다.
   *
   * ⚠️ 방 id와 참여자 id는 **여기서 정한다** — 휴대폰이 보낸 값을 쓰지 않는다. 휴대폰은 커서(`afterSeq`)와
   * 보낼 글만 준다. 커뮤니티에 들어가고 나가는 것은 여전히 Mac 화면에서만 한다.
   */
  async communityMobile(action:'status'|'read'|'send',options:{afterSeq?:number;text?:string;requestId?:string}={}):Promise<AgentDialogueCommunityMobileSnapshot>{
    // ⚠️ `fresh=true`로 부르지 않는다. 그러면 멤버십 캐시를 건너뛰어 `community-status`를 한 번 더
    // 쓰고(아래에서 또 부른다) 보호 저장소 읽기도 두 번이 된다 — 휴대폰이 12초마다 두드리는 경로라
    // 그 비용이 지연에 그대로 붙었다(2026-10-05 감사). 캐시는 멤버십 **조회**뿐이고, 입장·나가기는
    // 캐시를 비우며(`uiCommunity`) 아래 status가 `inside`를 **다시** 확인하므로 판정이 늙지 않는다.
    const self=await this.communityEndpoint();
    if(!self){
      if(action!=='status')throw new AgentDialogueHostError('AGENT_DIALOGUE_COMMUNITY_OUTSIDE',
        '이 기기가 먼저 커뮤니티에 입장해야 합니다. 이 기기의 AgentsToZ 「기기 간 대화」(아젠투지 설정 옆)에서 입장하세요.');
      // 입장 전에도 방이 있는지는 보여 준다 — 「커뮤니티가 없다」와 「아직 안 들어갔다」는 다르다.
      const ops=[...this.enabled.values()].sort((a,b)=>(a.kind==='ops'?0:1)-(b.kind==='ops'?0:1))[0];
      if(!ops)return {inside:false,roomId:null,unread:0,nextSeq:0,members:[],devices:[],messages:[]};
      const {profileId,deviceId}=this.identity();
      const secret=await this.secret(profileId,deviceId);
      const status=await this.rpc('community-status',profileId,deviceId,secret,{sourceEndpointId:ops.endpointId});
      return {...status,inside:false,roomId:typeof status.roomId==='string'?status.roomId:null,devices:[],messages:[],selfEndpointId:ops.endpointId};
    }
    const status=await this.rpc('community-status',self.profileId,self.deviceId,self.secret,{sourceEndpointId:self.endpoint.endpointId});
    const participantId=typeof status.participantId==='string'?status.participantId:null;
    if(status.inside!==true||!participantId)throw new AgentDialogueHostError('AGENT_DIALOGUE_COMMUNITY_OUTSIDE',
      '이 기기가 커뮤니티에서 나갔습니다. 이 기기의 AgentsToZ 「아젠투지 설정」에서 다시 입장하세요.');
    const roomNextSeq=Number.isSafeInteger(status.nextSeq)?Number(status.nextSeq):0;
    const devices=communityDeviceRows(status.members,self.deviceId)
      .map(device=>({ref:communityDeviceRef(device.endpointId),name:device.displayName,kind:device.kind}));
    const args={sourceEndpointId:self.endpoint.endpointId,roomId:self.roomId,participantId};
    if(action==='send'){
      // 사람이 휴대폰에서 적어 보내는 말은 상대 AI가 답하거나 실행할 것 — 그래서 `question`이다.
      await this.rpc('send',self.profileId,self.deviceId,self.secret,
        {...args,requestId:options.requestId?stableRequestUuid(options.requestId):randomUUID(),kind:'question',text:options.text??''},
        'community-send');
    }
    // 커서가 방의 끝이면 읽지 않는다. SQL은 `afterSeq>=next_seq`를 CURSOR_INVALID로 거절하므로
    // 빈 방을 새로고침하는 것만으로 오류가 났다. 보낸 직후에는 자기 줄까지 함께 받는다.
    let messages:unknown[]=[],nextSeq=roomNextSeq;
    // 커서를 주지 않은 `send`는 읽지 않는다 — 0부터 읽으면 가장 **오래된** 7건이 돌아와 방금 보낸 말
    // 대신 옛 대화가 보인다. 커서는 읽은 쪽만 안다.
    const cursorGiven=Number.isSafeInteger(options.afterSeq);
    if(action==='read'||action==='send'&&cursorGiven){
      const given=Math.max(0,Math.min(cursorGiven?Number(options.afterSeq):0,roomNextSeq));
      // 보낸 직후에는 **보낸 줄 앞**에서 읽어야 그 줄이 들어온다 — 방금 쓴 메시지의 seq가 보내기 전의
      // next_seq이고 `read`는 `seq>afterSeq`만 주므로, 커서가 그 끝에 있으면 자기 말이 빠진다.
      // 처음 여는 화면(커서 0)은 방의 **끝 몇 줄**부터 읽는다. 읽기는 오래된 것부터 오므로 0에서 시작하면
      // 며칠 전 대화가 먼저 보이고, 한 번에 몇 줄씩이라 최신에 닿기까지 몇 분이 걸렸다(2026-10-06 실기).
      const after=action==='send'?Math.max(0,Math.min(given,roomNextSeq-1))
        :given===0?Math.max(0,roomNextSeq-1-COMMUNITY_FIRST_READ_TAIL):given;
      if(after<nextSeq||action==='send'){
        const read=await this.rpc('read',self.profileId,self.deviceId,self.secret,{...args,afterSeq:after},'community-read');
        messages=Array.isArray(read.events)?read.events:[];
        if(Number.isSafeInteger(read.nextSeq))nextSeq=Number(read.nextSeq);
      }else nextSeq=after;
    }
    return {...status,inside:true,roomId:self.roomId,devices,messages,nextSeq,selfEndpointId:self.endpoint.endpointId,selfParticipantId:participantId};
  }
  /**
   * 휴대폰이 고른 다른 아젠투지에 요청 하나를 넘긴다. 참조는 **지금의** 커뮤니티 목록에서 되찾으므로
   * 그 기기가 나갔으면 가리킬 것이 없다(fail-closed).
   */
  async communityForward(deviceRef:string,request:Record<string,unknown>,timeoutMs?:number):Promise<Record<string,unknown>>{
    // ⚠️ 참조 되돌리기를 **매 요청마다** 다시 하지 않는다. `controlDevices()`는 멤버십 확인 +
    // community-status RPC(그리고 그 앞의 보호 저장소 읽기)를 critical path에서 또 하는데, 전달은
    // 터미널 읽기마다 일어나므로 그 비용이 지연에 그대로 붙었다(2026-10-05 감사). 10초 캐시로 묶는다.
    // 권한이 캐시되는 것이 아니다 — DB가 **모든 제어 요청마다** 양쪽 멤버십을 다시 보므로, 캐시는
    // 「ref → endpointId」 조회뿐이고 나간 기기에 보내면 그쪽에서 거절된다.
    const now=this.clock();
    let endpointId=this.forwardTargets&&this.forwardTargets.expiresAt>now
      ?this.forwardTargets.byRef.get(deviceRef)??null:null;
    if(!endpointId){
      const {devices}=await this.controlDevices();
      const byRef=new Map(devices.map(device=>[communityDeviceRef(device.endpointId),device.endpointId]));
      this.forwardTargets={byRef,expiresAt:this.clock()+FORWARD_TARGET_CACHE_MS};
      endpointId=byRef.get(deviceRef)??null;
    }
    if(!endpointId)throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TARGET_INVALID',
      '그 아젠투지가 지금 커뮤니티에 없습니다. 기기 목록을 새로고침하세요.',404);
    try{return await this.controlCall(endpointId,request,timeoutMs);}
    catch(error){
      // 상대가 커뮤니티에서 나갔거나 끝점이 바뀐 신호 — 다음 요청은 새로 조회하게 캐시를 버린다.
      const text=error instanceof Error?error.message:String(error);
      if(!text.includes('AGENT_DIALOGUE_CONTROL_TIMEOUT'))this.forwardTargets=null;
      // 캐시된 참조로 보냈다가 DB가 「그 기기는 지금 멤버가 아니다」로 거절한 경우, 사용자에게는
      // 조회가 먼저 걸렀을 때와 **같은 문장**을 보여준다(권한 판정은 여전히 DB가 한다).
      // ⚠️ 클래스가 아니라 **문구**로 본다 — 이 예외는 SQL의 raise이고, 경로에 따라 평범한 Error로도
      // 오고 api-server의 rpc 래퍼를 거쳐 AgentDialogueHostError로도 온다.
      if(text.includes('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE'))
        throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TARGET_INVALID',
          '그 아젠투지가 지금 커뮤니티에 없습니다. 기기 목록을 새로고침하세요.',404);
      throw error;
    }
  }
  /** Other devices in this profile's community that this Mac can drive. Display only: the database
   *  re-checks membership on every control request. */
  /**
   * ⚠️ `unread`·`lastMessageAt`은 **덤이다** — 이 호출이 이미 `community-status`를 부르므로 RPC가 늘지
   * 않는다. 워크룸의 15초 기기 조회가 그대로 「읽지 않음 N개」를 싣고 오게 해서, 맥 대화창이 접혀 있는
   * 동안 따로 두드리지 않게 하는 것이 목적이다.
   */
  /** Several windows (main, pop-outs, the dock) ask for the same list within seconds: one RPC answers them all. */
  private devicesCache:{at:number;value:Promise<{inside:boolean;deviceId:string;devices:AgentDialogueControlDevice[];unread:number;lastMessageAt:string|null}>}|null=null;
  controlDevices():Promise<{inside:boolean;deviceId:string;devices:AgentDialogueControlDevice[];unread:number;lastMessageAt:string|null}>{
    if(this.devicesCache&&this.clock()-this.devicesCache.at<5_000)return this.devicesCache.value;
    const value=this.loadControlDevices();
    this.devicesCache={at:this.clock(),value};
    value.catch(()=>{if(this.devicesCache?.value===value)this.devicesCache=null;});
    return value;
  }
  private async loadControlDevices():Promise<{inside:boolean;deviceId:string;devices:AgentDialogueControlDevice[];unread:number;lastMessageAt:string|null}>{
    // ⚠️ `fresh=true`로 부르지 않는다 — `communityMobile`과 같은 이유다(2026-10-05 감사). 멤버십 캐시를
    // 건너뛰면 바로 아래의 `community-status`와 **같은 인자로 두 번** 부르게 되고, 입장하지 않은 Mac은
    // 공개한 엔드포인트 **전부**를 매 호출 순회한다(실측 101개 공개 → 15초마다 101 RPC). 이 함수는
    // 워크룸의 15초 기기 조회가 부르고 팝아웃 창마다 늘어난다. 입장·나가기는 캐시를 비우므로
    // (`uiCommunity`) 판정이 늙지 않고, 아래 status가 `inside`를 어차피 다시 확인한다.
    const self=await this.communityEndpoint();
    const {deviceId}=this.identity();
    if(!self)return {inside:false,deviceId,devices:[],unread:0,lastMessageAt:null};
    const result=await this.rpc('community-status',self.profileId,self.deviceId,self.secret,{sourceEndpointId:self.endpoint.endpointId});
    // 기기 한 대에 한 줄 — 판정은 `communityDeviceRows` 한 곳이다(휴대폰 목록도 같은 것을 쓴다).
    return {inside:true,deviceId,devices:communityDeviceRows(result.members,self.deviceId),
      unread:Number.isSafeInteger(result.unread)&&Number(result.unread)>0?Number(result.unread):0,
      lastMessageAt:typeof result.lastMessageAt==='string'?result.lastMessageAt:null};
  }
  /**
   * Run one request on another community device and wait for its answer. The request waits in the
   * database until that device's sidecar takes it (it polls fast while it is being driven), so the
   * deadline here is the whole round trip. A timeout is an unknown outcome, not a refusal: the
   * other Mac may still execute a request it took just before the deadline.
   */
  async controlCall(targetEndpointId:unknown,request:Record<string,unknown>,timeoutMs=AGENT_DIALOGUE_CONTROL_TIMEOUT_MS):Promise<Record<string,unknown>>{
    if(typeof targetEndpointId!=='string'||!uuidPattern.test(targetEndpointId))
      throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TARGET_INVALID','제어할 기기를 다시 선택하세요.',400);
    const self=await this.communityEndpoint();
    if(!self)throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY','이 기기가 커뮤니티에 입장해야 다른 기기를 제어할 수 있습니다.');
    const sent=await this.rpc('control-send',self.profileId,self.deviceId,self.secret,
      {sourceEndpointId:self.endpoint.endpointId,targetEndpointId,request}).catch(error=>{
        // The target left the community: the shared device list must not keep offering it.
        if(`${(error as {code?:unknown})?.code} ${(error as Error)?.message}`.includes('TARGET_UNAVAILABLE'))this.devicesCache=null;
        throw error;
      });
    if(typeof sent.controlId!=='string')throw new AgentDialogueHostError('AGENT_DIALOGUE_BAD_RECEIPT','제어 요청 영수증을 확인하지 못했습니다.');
    const deadline=this.clock()+timeoutMs;
    // 되묻기는 150ms에서 시작해 400ms까지 물러났다. 상대가 **방금 답한 적 있으면**(활성) 그 물러남이
    // 왕복마다 최대 0.25초를 그냥 보태므로 150ms로 고정한다 — 쓰기가 아니라 `control-result` 읽기다.
    const activePeer=this.controlAnsweredAt!==null&&this.clock()-this.controlAnsweredAt<COMMUNITY_CONTROL_ACTIVE_WINDOW_MS;
    for(let delay=150;;delay=activePeer?150:Math.min(delay+100,400)){
      const result=await this.rpc('control-result',self.profileId,self.deviceId,self.secret,
        {sourceEndpointId:self.endpoint.endpointId,controlIds:[sent.controlId]});
      const answer=(Array.isArray(result.results)?result.results:[]).find((row:any)=>row?.controlId===sent.controlId) as {response?:unknown}|undefined;
      if(answer){
        if(!answer.response||typeof answer.response!=='object'||Array.isArray(answer.response))
          throw new AgentDialogueHostError('AGENT_DIALOGUE_BAD_RECEIPT','상대 기기의 응답을 확인하지 못했습니다.');
        this.controlAnsweredAt=this.clock();
        return answer.response as Record<string,unknown>;
      }
      if(this.clock()+delay>deadline)throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TIMEOUT',
        '상대 기기가 제때 답하지 않았습니다. 그 기기의 AgentsToZ가 켜져 있는지 확인하세요. 요청이 실행됐는지는 알 수 없습니다.',504);
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
  }
  /**
   * Take and run the requests other community devices addressed to this Mac, one at a time and in
   * the order they were sent. Returns how many ran so the caller can poll faster while driven.
   * An executor failure becomes that request's error answer; it never stops the others.
   */
  /**
   * 한 제어 요청의 실행 마감. 넘으면 **보내는 쪽에 먼저 답하고** 폴을 이어간다 — 실행 자체는 취소하지
   * 않고 늦은 결과만 버린다(이 저장소의 「알 수 없음」 선례와 같다). 버려진 promise의 거절은
   * 삼켜 두어야 unhandled rejection으로 사이드카를 죽이지 않는다.
   */
  private withControlDeadline<T>(work:Promise<T>):Promise<T>{
    work.catch(()=>undefined);
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_EXECUTE_TIMEOUT',
        '이 기기에서 그 요청이 제때 끝나지 않았습니다. 실행됐는지는 알 수 없습니다.',504)),CONTROL_EXECUTE_DEADLINE_MS);
      (timer as unknown as {unref?:()=>void}).unref?.();
      work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
    });
  }
  async controlPoll(execute:(request:Record<string,unknown>,from:{deviceId:string;name:string})=>Promise<Record<string,unknown>>):Promise<{handled:number}>{
    if(this.controlPolling)return {handled:0};
    this.controlPolling=true;
    try{
      const self=await this.communityEndpoint();
      if(!self)return {handled:0};
      const inbox=await this.rpc('control-inbox',self.profileId,self.deviceId,self.secret,{});
      let handled=0;
      // 한 폴이 쓸 수 있는 전체 시간도 묶는다. 우편함은 한 번에 16건까지 오고, 각자 마감을 다 쓰면
      // 합산 침묵이 남는다. ⚠️ 받은 행은 SQL이 이미 `taken`으로 바꿨으므로 다음 폴에 다시 오지 않는다 —
      // 예산을 넘긴 건은 실행하지 않고 **그렇다고 답한다**(답이 없으면 보내는 쪽은 마감까지 기다리고, 그 행은
      // 10분 동안 보낸 쪽의 대기 64건 한도를 차지한다. 2026-10-06 리뷰).
      const pollUntil=this.clock()+CONTROL_POLL_BUDGET_MS;
      for(const row of Array.isArray(inbox.controls)?inbox.controls:[]){
        const control=row as Record<string,unknown>;
        if(typeof control.controlId!=='string')continue;
        let response:Record<string,unknown>;
        if(this.clock()>pollUntil){
          await this.deps.rpc('control-respond',self.profileId,self.deviceId,self.secret,{controlId:control.controlId,
            response:{ok:false,error:'상대 기기가 바빠 이 요청을 실행하지 않았습니다. 다시 시도하세요.'}}).catch(()=>undefined);
          continue;
        }
        try{
          if(!control.request||typeof control.request!=='object'||Array.isArray(control.request))throw new Error('제어 요청 형식이 올바르지 않습니다.');
          // ⚠️ **요청별 마감이 필요하다.** 예전에는 `execute`를 그냥 await해서, 끝나지 않는 요청 하나가
          // 이 폴을 영구히 붙잡고(`controlPolling`이 풀리지 않아) **그 Mac을 커뮤니티 전체에 침묵**시켰다
          // (2026-10-05 감사). 릴레이 쪽에 이미 같은 모양이 있다(`#withinDeadline`). 작업은 취소되지
          // 않으므로(늦은 결과는 버린다) 보내는 쪽에는 「알 수 없음」으로 답한다 — controlCall의 마감
          // 문구와 같은 성질이다.
          response={ok:true,body:await this.withControlDeadline(execute(control.request as Record<string,unknown>,
            {deviceId:String(control.fromDeviceId??''),name:String(control.fromName??'')}))};
        }catch(error){response={ok:false,error:error instanceof Error?error.message.slice(0,500):'제어 요청을 처리하지 못했습니다.'};}
        try{await this.deps.rpc('control-respond',self.profileId,self.deviceId,self.secret,{controlId:control.controlId,response});}
        catch{
          // Most likely the answer is over the size limit; tell the sender instead of leaving it waiting.
          await this.deps.rpc('control-respond',self.profileId,self.deviceId,self.secret,{controlId:control.controlId,
            response:{ok:false,error:'응답이 너무 커서 전달하지 못했습니다.'}}).catch(()=>undefined);
        }
        handled+=1;
      }
      return {handled};
    }finally{this.controlPolling=false;}
  }
  async disable(target:AgentDialogueTarget){
    const {profileId,deviceId}=this.identity();const item=this.enabled.get(key(target));if(!item)return {disabled:true};
    this.enabled.delete(key(target));this.pending.clear();this.approved.clear();this.grants.clear();this.pairedPeers.clear();this.devicePairings=null;this.invalidateCommunityMembership();this.preferredCommunityEndpointId=null;this.devicesCache=null;this.secrets.clear();this.forwardTargets=null;
    this.revocations.push({endpointId:item.endpointId,profileId,deviceId});this.save();
    try{
      const secret=await this.secret(profileId,deviceId);
      await this.deps.rpc('revoke-endpoint',profileId,deviceId,secret,{endpointId:item.endpointId});
      this.revocations=this.revocations.filter(candidate=>candidate.endpointId!==item.endpointId
        ||candidate.profileId!==profileId||candidate.deviceId!==deviceId);this.save();
      return {disabled:true,remoteRevocationPending:false};
    }catch{return {disabled:true,remoteRevocationPending:true};}
  }
  async approve(id:string,accept:boolean){
    const {profileId,deviceId}=this.identity();this.prune();const item=this.pending.get(id);
    if(!item)throw new AgentDialogueHostError('AGENT_DIALOGUE_APPROVAL_EXPIRED','승인 요청이 만료됐습니다. 에이전트에서 다시 요청하세요.');
    if(!accept&&item.request.operation==='join'&&item.request.roomId){
      const current=this.enabled.get(key(item.request.source));
      if(!current||current.endpointId!==item.endpointId)
        throw new AgentDialogueHostError('AGENT_DIALOGUE_NOT_ENABLED','대화 연결이 꺼졌습니다.');
      const local=await this.deps.resolveTarget(item.request.source);
      if(local.kind!==current.kind||local.kind==='project'&&local.portId!==current.portId)
        throw new AgentDialogueHostError('AGENT_DIALOGUE_SOURCE_CHANGED','등록 대상이 변경됐습니다.');
      const secret=await this.secret(profileId,deviceId);
      const found=await this.deps.rpc('invitations',profileId,deviceId,secret,{sourceEndpointId:current.endpointId});
      const invitation=(Array.isArray(found.invitations)?found.invitations:[])
        .find((row:Record<string,unknown>)=>row.roomId===item.request.roomId);
      if(invitation){
        await this.deps.rpc('decline',profileId,deviceId,secret,{sourceEndpointId:current.endpointId,
          roomId:item.request.roomId,participantId:invitation.participantId,requestId:randomUUID()});
      }
    }
    this.pending.delete(id);
    if(accept)this.approved.set(item.requestHash,item.expiresAt);
    return {approved:accept,declined:!accept&&item.request.operation==='join',requestId:item.request.requestId??null};
  }
  private approval(instanceId:string,endpointId:string,request:AgentDialogueRequest,detail='',requester:AgentDialogueRequester={}):Record<string,unknown>|null{
    this.prune();
    const roomId=request.roomId;
    if(roomId&&request.operation!=='invite'&&this.grants.has(roomGrantKey(instanceId,endpointId,roomId)))return null;
    const requestHash=digest([instanceId,endpointId,request]);
    if(this.approved.has(requestHash))return null;
    const existing=[...this.pending.values()].find(value=>value.requestHash===requestHash);
    if(existing)return {approvalRequired:true,pendingId:existing.id};
    const id=randomUUID(),requestedAt=this.clock(),expiresAt=requestedAt+APPROVAL_TTL;
    const summary=`${request.operation}: ${request.source&&'target'in request.source?'아젠투지(OPS)':('portId'in request.source?request.source.portId:'프로젝트')}${roomId?` / 방 ${roomId.slice(0,8)}`:''}${detail?` / ${detail}`:''}`;
    this.pending.set(id,{id,instanceId,endpointId,roomId,requestHash,summary,expiresAt,request,
      requestedAt,client:agentDialogueClientLabel(requester.client),connection:connectionTag(instanceId)});
    return {approvalRequired:true,pendingId:id};
  }
  /** Renew a room grant after a successful use; the absolute cap is kept from when it was first granted. */
  private touchGrant(instanceId:string,endpointId:string,roomId:string){
    const grantKey=roomGrantKey(instanceId,endpointId,roomId),grant=this.grants.get(grantKey);
    if(grant)grant.expiresAt=Math.min(this.clock()+GRANT_IDLE_TTL,grant.hardExpiresAt);
  }
  async perform(instanceId:string,raw:unknown,requester:AgentDialogueRequester={}):Promise<Record<string,unknown>>{
    if(!instancePattern.test(instanceId))throw new AgentDialogueHostError('AGENT_DIALOGUE_INSTANCE_INVALID','MCP 연결을 다시 시작하세요.',403);
    const request=parseAgentDialogueRequest(raw);
    const {profileId,deviceId}=this.identity();
    const endpoint=this.enabled.get(key(request.source));
    if(!endpoint)throw new AgentDialogueHostError('AGENT_DIALOGUE_NOT_ENABLED','앱에서 이 총괄 또는 프로젝트의 대화 연결을 먼저 켜세요.');
    const local=await this.deps.resolveTarget(request.source);
    if(local.kind!==endpoint.kind||local.kind==='project'&&local.portId!==endpoint.portId)
      throw new AgentDialogueHostError('AGENT_DIALOGUE_SOURCE_CHANGED','등록 대상이 변경됐습니다. 연결을 다시 준비하세요.');
    const secret=await this.secret(profileId,deviceId);
    // `pairings` only reads this endpoint's own couples. `pair`/`pair-revoke` always ask the app:
    // accepting a 30-day pairing IS the consent moment, so it is never skipped by an earlier one.
    let paired=false;
    if(!['peers','invitations','pairings','pair','pair-revoke','community-status','community-join','community-leave']
      .includes(request.operation)){
      const needed=request.operation==='create'?request.endpointIds??[]
        :request.operation==='invite'?[request.endpointId!]:[];
      if(needed.length>0){
        const couples=await this.activePairings(profileId,deviceId,secret,endpoint.endpointId);
        paired=needed.every(id=>couples.has(id));
      }
      // Standing community membership replaces «who calls whom»: this endpoint entered once in the
      // app, so talking in that room needs no further approval.
      //
      // ⚠️ Closing or leaving the community is refused outright, not merely approval-gated. A
      // legitimate community `send` leaves a room grant on this MCP connection (the host reopens a
      // grant after send/wait), and that grant would then carry `close` straight through — one AI
      // could evict every device. Ending or leaving the group is an app decision.
      if(request.roomId&&['close','leave'].includes(request.operation)){
        const membership=await this.communityMembership(profileId,deviceId,secret,endpoint.endpointId);
        if(membership.roomId===request.roomId)
          throw new AgentDialogueHostError('AGENT_DIALOGUE_COMMUNITY_UI_ONLY',
            '커뮤니티 나가기와 종료는 아젠투지 설정에서만 할 수 있습니다.',403);
      }
      if(!paired&&request.roomId&&['send','read','wait'].includes(request.operation)){
        const membership=await this.communityMembership(profileId,deviceId,secret,endpoint.endpointId);
        if(membership.inside&&membership.roomId===request.roomId)paired=true;
      }
    }
    if(!['peers','invitations','pairings','community-status'].includes(request.operation)){
      let detail='';
      if(request.operation==='create'||request.operation==='invite'){
        const directory=await this.deps.rpc('peers',profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId});
        const byId=new Map((Array.isArray(directory.peers)?directory.peers:[]).map((peer:Record<string,unknown>)=>[peer.endpointId,String(peer.displayName??'')]));
        const selected=request.operation==='create'?request.endpointIds??[]:[request.endpointId!];
        detail=selected.map(id=>byId.get(id)??id).join(', ').slice(0,350);
      }else if(request.operation==='join'){
        const invitations=await this.deps.rpc('invitations',profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId});
        const invitation=(Array.isArray(invitations.invitations)?invitations.invitations:[]).find((row:Record<string,unknown>)=>row.roomId===request.roomId);
        detail=invitation?String(invitation.fromName??''):String(request.roomId??'');
        if(invitation&&typeof invitation.from==='string'){
          const couples=await this.activePairings(profileId,deviceId,secret,endpoint.endpointId);
          paired=couples.has(invitation.from);
        }
      }else if(request.operation==='community-join'||request.operation==='community-leave'){
        // Entering the community publishes this endpoint into a standing group room. That is the
        // consent moment, so an AI asking for it always goes through the app.
        detail=request.operation==='community-join'?'커뮤니티 입장':'커뮤니티 나가기';
      }else if(request.operation==='pair'||request.operation==='pair-revoke'){
        const directory=await this.deps.rpc('peers',profileId,deviceId,secret,{sourceEndpointId:endpoint.endpointId});
        const peer=(Array.isArray(directory.peers)?directory.peers:[])
          .find((row:Record<string,unknown>)=>row.endpointId===request.peerEndpointId);
        detail=String(peer?.displayName??request.peerEndpointId??'').slice(0,350);
      }else if(request.operation==='send')detail=String(request.text??'').slice(0,150);
      if(!paired){const pending=this.approval(instanceId,endpoint.endpointId,request,detail,requester);if(pending)return pending;}
    }
    const {source,operation,...rest}=request;
    const args={sourceEndpointId:endpoint.endpointId,...rest};
    let result:Record<string,any>;
    if(operation==='wait'&&request.timeoutMs){
      const deadline=this.clock()+request.timeoutMs;
      let cursor=request.afterSeq!;
      while(true){
        if(this.enabled.get(key(request.source))?.endpointId!==endpoint.endpointId)
          throw new AgentDialogueHostError('AGENT_DIALOGUE_NOT_ENABLED','대화 연결이 꺼졌습니다.');
        result=await this.deps.rpc('read',profileId,deviceId,secret,{...args,afterSeq:cursor});
        if(Array.isArray(result.events)&&result.events.length>0||result.hasMore||this.clock()>=deadline)break;
        if(Number.isSafeInteger(result.nextSeq)&&result.nextSeq>=cursor)cursor=result.nextSeq;
        await new Promise<void>(resolve=>setTimeout(resolve,Math.min(2000,Math.max(1,deadline-this.clock()))));
      }
    }else{
      result=await this.deps.rpc(operation==='wait'?'read':operation,profileId,deviceId,secret,args);
    }
    const grantRoom=(roomId:string)=>{
      const grantedAt=this.clock();
      this.grants.set(roomGrantKey(instanceId,endpoint.endpointId,roomId),
        {instanceId,endpointId:endpoint.endpointId,roomId,expiresAt:grantedAt+GRANT_IDLE_TTL,hardExpiresAt:grantedAt+GRANT_MAX_TTL});
    };
    if(operation==='pair'||operation==='pair-revoke'){this.pairedPeers.delete(endpoint.endpointId);this.devicePairings=null;}
    if(operation==="community-join"||operation==="community-leave"){
      this.invalidateCommunityMembership(endpoint.endpointId);this.devicesCache=null;
      if(operation==='community-join')this.preferredCommunityEndpointId=endpoint.endpointId;
      else if(this.preferredCommunityEndpointId===endpoint.endpointId)this.preferredCommunityEndpointId=null;
    }
    if((operation==='create'||operation==='join')&&typeof result.roomId==='string')grantRoom(result.roomId);
    else if(operation==='leave'||operation==='close')this.grants.delete(roomGrantKey(instanceId,endpoint.endpointId,request.roomId!));
    else if(request.roomId&&this.grants.has(roomGrantKey(instanceId,endpoint.endpointId,request.roomId)))this.touchGrant(instanceId,endpoint.endpointId,request.roomId);
    // An expired grant was re-approved by the user for this exact room and connection: reopen it
    // instead of asking again for every following message.
    else if(request.roomId&&(operation==='send'||operation==='wait'))grantRoom(request.roomId);
    return result;
  }
}
