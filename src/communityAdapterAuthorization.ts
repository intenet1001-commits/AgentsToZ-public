import type {WorkroomEffortMode} from './workroomEffortMode';
import type {WorkroomEffortSettingStore} from './workroomEffortSetting';

export type CommunityAdapterCapability='computer-use.agent-settings'|'computer-use.browser';
type VerifiedMainLink={readonly verifiedMain:boolean;request(value:Record<string,unknown>):Promise<Record<string,unknown>>};
export type CommunityAdapterWitness=Readonly<{capability:CommunityAdapterCapability;communityId:string;profileId:string;deviceId:string;revision:number;expiresAt:number}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const capabilities=new Set<CommunityAdapterCapability>(['computer-use.agent-settings','computer-use.browser']);

/**
 * Trusted sidecar -> currently audited Main -> Control. Construct only in the trusted host composition root;
 * no HTTP/MCP body, browser boolean, health-advertised key or caller-owned DTO can manufacture a witness.
 */
export class CommunityAdapterAuthorization {
  private readonly witnesses=new WeakMap<object,number>();
  private generation=0;
  private readonly pending=new Map<CommunityAdapterCapability,Promise<CommunityAdapterWitness>>();
  private tail:Promise<unknown>=Promise.resolve();
  private highest?:{communityId:string;profileId:string;deviceId:string;revision:number};
  private disposed=false;
  constructor(private readonly link:VerifiedMainLink,private readonly now=Date.now){}
  authorize(capability:CommunityAdapterCapability):Promise<CommunityAdapterWitness>{
    if(!capabilities.has(capability))return Promise.reject(Error('지원하지 않는 공통 인증 목적입니다.'));
    const pending=this.pending.get(capability);if(pending)return pending;
    // Only two purposes can queue, and concurrent reads of one purpose coalesce. The private Main link allows one
    // request at a time; browser and effort checks must not collide with each other or duplicate a native read.
    const run=this.tail.then(()=>this.readNative(capability)).catch(error=>{this.generation++;throw error;});
    this.pending.set(capability,run);this.tail=run.catch(()=>{});
    void run.finally(()=>{if(this.pending.get(capability)===run)this.pending.delete(capability);}).catch(()=>{});
    return run;
  }
  private async readNative(capability:CommunityAdapterCapability):Promise<CommunityAdapterWitness>{
    if(!capabilities.has(capability)||this.disposed||!this.link.verifiedMain)throw Error('공통 인증을 확인할 수 없습니다.');
    const result=await this.link.request({operation:'community-adapter-authorize',capability});
    const clock=this.now();
    if(this.disposed||!this.link.verifiedMain||!plain(result)
      ||Object.keys(result).sort().join(',')!==['success','halted','authorized','capability','communityId','profileId','deviceId','revision','expiresAt','desktopGrant'].sort().join(',')
      ||result.success!==true||result.halted!==false||result.authorized!==true||result.desktopGrant!==false||result.capability!==capability
      ||!uuid(result.communityId)||!uuid(result.profileId)||!uuid(result.deviceId)||!Number.isSafeInteger(result.revision)||(result.revision as number)<1
      ||!Number.isSafeInteger(result.expiresAt)||(result.expiresAt as number)<=clock||(result.expiresAt as number)>clock+90_000)throw Error('현재 기기의 공통 인증이 유효하지 않습니다.');
    const current={communityId:result.communityId,profileId:result.profileId,deviceId:result.deviceId,revision:result.revision as number};
    if(this.highest&&(this.highest.communityId!==current.communityId||this.highest.profileId!==current.profileId
      ||this.highest.deviceId!==current.deviceId||current.revision<this.highest.revision))throw Error('공통 인증의 기기 또는 정책이 바뀌었습니다.');
    this.highest=current;
    const witness=Object.freeze({...current,capability,expiresAt:result.expiresAt as number});this.witnesses.set(witness,this.generation);return witness;
  }
  isCurrent(witness:CommunityAdapterWitness,capability:CommunityAdapterCapability):boolean{
    const policy=this.highest;
    return !this.disposed&&this.link.verifiedMain&&this.witnesses.get(witness)===this.generation&&witness.capability===capability
      &&witness.expiresAt>this.now()&&!!policy&&policy.revision===witness.revision&&policy.communityId===witness.communityId
      &&policy.profileId===witness.profileId&&policy.deviceId===witness.deviceId;
  }
  /**
   * Community-originated Workroom requests reuse the host's existing Auto/Recommend/Off choice. Enrollment never
   * changes it, a pinned effort or desktop advice-only mode. The actual CLI adapter must keep its native guards.
   */
  async workroomEffortPolicy(setting:WorkroomEffortSettingStore):Promise<{mode:WorkroomEffortMode;witness:CommunityAdapterWitness;isAuthorized:()=>boolean;beforeEffect:()=>Promise<boolean>}>{
    const witness=await this.authorize('computer-use.agent-settings');
    const mode=setting.getMode?.()??(setting.get()?'auto':'off');
    if(!['auto','recommend','off'].includes(mode)||!this.isCurrent(witness,'computer-use.agent-settings'))throw Error('워크룸 에포트 정책을 확인하지 못했습니다.');
    const isAuthorized=()=>this.isCurrent(witness,'computer-use.agent-settings')&&(setting.getMode?.()??(setting.get()?'auto':'off'))===mode;
    return {mode,witness,isAuthorized,beforeEffect:async()=>{
      try{const fresh=await this.authorize('computer-use.agent-settings');return fresh.communityId===witness.communityId&&fresh.profileId===witness.profileId&&fresh.deviceId===witness.deviceId&&fresh.revision===witness.revision&&isAuthorized();}catch{return false;}
    }};
  }
  dispose(){this.disposed=true;this.generation++;this.highest=undefined;}
}
