type MainLink={readonly verifiedMain:boolean;request(value:Record<string,unknown>):Promise<Record<string,unknown>>};
export interface CommunityReceiveSnapshot {configured:boolean;authorized:boolean;communityId:string|null;profileId:string|null;deviceId:string|null;issuerRevision:number|null;expiresAt:number;policy:{revision:number;allowRemote:boolean;blockedDevices:string[];blockedConnections:{deviceId:string;instance:string;until:number}[]}}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const object=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
/** One audited Main broker. No JS setting can grant or restore reception; the Native policy owns revisions. */
export class CommunityReceiveAuthorization {
  private latest:CommunityReceiveSnapshot|null=null;
  private revision=0;
  private pending?:{id:string;state:string};
  constructor(private readonly link:MainLink,private readonly now=Date.now,private readonly refreshAuthority?:()=>Promise<void>){}
  current(){const v=this.latest;return this.link.verifiedMain&&v&&v.expiresAt>this.now()?v:null;}
  async refresh(legacyRestricted:boolean):Promise<CommunityReceiveSnapshot>{
    try{
      if(!this.link.verifiedMain)throw Error('verified Main required');
      if(this.pending?.state==='pending'){
        const r=await this.link.request({operation:'community-receive-review-status',reviewId:this.pending.id});
        if(r.success===true&&r.reviewId===this.pending.id&&['pending','approved','denied','expired','unknown'].includes(String(r.state)))this.pending.state=String(r.state);
      }
      let r=await this.link.request({operation:'community-receive-status',legacyRestricted});
      if(r.success===true&&r.configured===true&&r.authorized===false&&this.refreshAuthority){await this.refreshAuthority();r=await this.link.request({operation:'community-receive-status',legacyRestricted});}
      const p=r.policy,clock=this.now();
      if(!this.link.verifiedMain||!object(r,['success','halted','receiveProtocolVersion','configured','authorized','communityId','profileId','deviceId','issuerRevision','expiresAt','policy','restorationRequiresAuthentication'])
        ||r.success!==true||r.halted!==false||r.receiveProtocolVersion!==1||typeof r.configured!=='boolean'||typeof r.authorized!=='boolean'||r.restorationRequiresAuthentication!==true
        ||!Number.isSafeInteger(r.expiresAt)||(r.expiresAt as number)<=clock||(r.expiresAt as number)>clock+5000
        ||!object(p,['revision','allowRemote','blockedDevices','blockedConnections'])||!Number.isSafeInteger(p.revision)||p.revision<this.revision||typeof p.allowRemote!=='boolean'
        ||!Array.isArray(p.blockedDevices)||p.blockedDevices.length>64||!p.blockedDevices.every(uuid)||new Set(p.blockedDevices).size!==p.blockedDevices.length
        ||!Array.isArray(p.blockedConnections)||p.blockedConnections.length>256||!p.blockedConnections.every((b:unknown)=>object(b,['deviceId','instance','until'])&&uuid(b.deviceId)&&/^[0-9a-f]{32}$/.test(b.instance)&&Number.isSafeInteger(b.until)&&b.until>0)
        ||r.authorized===true&&(!r.configured||!uuid(r.communityId)||!uuid(r.profileId)||!uuid(r.deviceId)||!Number.isSafeInteger(r.issuerRevision)||(r.issuerRevision as number)<1))throw Error('원격 수신의 Native 권한을 확인하지 못했습니다.');
      this.revision=p.revision;this.latest=structuredClone(r) as unknown as CommunityReceiveSnapshot;return this.latest;
    }catch(error){this.latest=null;throw error;}
  }
  reviewState(){return this.pending?{...this.pending}:null;}
  async restrict(change:Readonly<Record<string,unknown>>){
    this.latest=null;if(!this.link.verifiedMain)throw Error('verified Main required');
    const r=await this.link.request({operation:'community-receive-restrict',change});
    if(r.success!==true||r.halted!==false||r.restricted!==true||!Number.isSafeInteger(r.revision))throw Error('Native 차단 저장을 확인하지 못했습니다. 원격 입력을 중단했습니다.');
    this.revision=Math.max(this.revision,r.revision as number);return this.refresh(true);
  }
  async review(change:Readonly<Record<string,unknown>>,legacyRestricted:boolean){
    const status=await this.refresh(legacyRestricted);
    if(!status.authorized)throw Error('공통 등록과 기존 전체 Mac 상시 허용을 먼저 확인하세요.');
    if(this.pending?.state==='pending')throw Error('권한관리 인증을 이미 검토 중입니다. 다시 승인 요청하지 않습니다.');
    const id=crypto.randomUUID();this.pending={id,state:'unknown'};
    const r=await this.link.request({operation:'community-receive-review',requestId:id,expectedRevision:status.policy.revision,change});
    if(r.success!==true||r.halted!==false||r.reviewId!==id||!['pending','approved','denied','expired','unknown'].includes(String(r.state)))throw Error('권한관리 검토 결과가 미확정입니다. 자동 재요청하지 않습니다.');
    this.pending.state=String(r.state);return this.reviewState();
  }
}
