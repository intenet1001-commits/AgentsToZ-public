import {randomUUID,type KeyObject} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {Fault,demand,uuid,integer,hash,publicKey,fingerprint,seal,openSealed,type Member,MAX_MEMBERS} from './protocol';
import {type RegistryStore} from './store';
import {accessPlan,accessPlanBytes,accessChallenge,accessSigned,accessNoticeSigned,readAccessRequest,checkAccessProof,capabilities,verifyAccessEnvelope,exact,
  ACCESS_IDLE_MS,ACCESS_LEASE_MS,ACCESS_PLAN_MS,accessPurposeAllowed,accessRelayRoleAllowed,mobileRelayPurpose,RELAY_PURPOSES,type AccessPlan,type AccessRequest,type AccessEnvelope,
  type AccessAuthorization,type AccessUseSession,type AccessRelayTicket,type RelayPurpose} from './accessProtocol';

import {CommunityScreenSafety,SAFETY_OPERATIONS,type SafetyNotification} from './screenSafety';
import {accessManagementDigest,type AccessManagementIntent} from './accessManagement';
import {CommunityOwnerRecovery,OWNER_RECOVERY_OPERATIONS} from './ownerRecovery';

interface Community {id:string;profileId:string;name:string;revision:number;memberIds:string[]}
interface PendingPlan {id:string;communityId:string;plan:AccessPlan;digest:string;expiresAt:number;enrollmentId:string|null}
interface Policy {plan:AccessPlan;enrollmentId:string;revision:number}
interface Review {admin:string;planId:string;digest:string;revision:number;challenge:string;expiresAt:number;management?:AccessManagementIntent}
interface Session {id:string;communityId:string;enrollmentId:string;publicKey:string;capabilities:AccessPlan['capabilities'];sequence:number;lastHumanAt:number;expiresAt:number;closed:boolean;revision:number}
interface AccessPushSubscription {token:string;environment:'sandbox'|'production';topic:string}
export interface CommunityAccessNotification extends AccessPushSubscription {planId:string;communityId:string;digest:string;recipientId:string;recipientKeyEpoch:number;subscriptionGeneration?:string;expiresAt:number;notice:AccessEnvelope}
interface Receipt {key:string;recoveryKey:string;actor:string|null;hash:string;cipher:string;expiresAt:number}

function desktopTrustUpdatePreservesIdentity(prior:AccessPlan,next:AccessPlan):boolean {
  const combined=next.capabilities.some(cap=>cap==='computer-use.agent-settings'||cap==='computer-use.browser');
  const addingControl=prior.controlKey===null&&next.controlKey!==null&&combined;
  return prior.kind==='desktop'&&next.kind==='desktop'&&next.capabilities.includes('screen.desktop-trust')
    &&prior.profileId===next.profileId&&prior.deviceId===next.deviceId&&prior.hostKey===next.hostKey&&prior.biometricKey===next.biometricKey&&prior.operationKey===next.operationKey
    &&(prior.controlKey===next.controlKey||addingControl)
    &&(prior.agentDeviceId===next.agentDeviceId||prior.agentDeviceId===null&&addingControl);
}

/** Shares only the existing issuer/member registry. Product memories, jobs and conversations are not moved here. */
export class CommunityAccessRegistry {
  constructor(private readonly store:RegistryStore,private readonly issuer:KeyObject,private readonly issuerPublic:string,
    private readonly stateKey:Buffer,private readonly clock=Date.now,private readonly allowedPushTopics:readonly string[]=[],private readonly safetyPushConfigured=false){demand(stateKey.length===32,'ISSUER_NOT_CONFIGURED');}
  screenSafety(now=this.clock()):CommunityScreenSafety {
    return new CommunityScreenSafety({store:this.store,issuer:this.issuer,stateKey:this.stateKey,now,topics:this.allowedPushTopics,pushConfigured:this.safetyPushConfigured,
      member:id=>this.member(id),policy:m=>this.policy(m),community:id=>this.community(id),authorization:(m,p,at)=>this.authorization(m,p,at),
      liveSession:(id,m,p)=>this.liveSession(id,m,p),useSession:(session,at)=>this.useSession(session,at)});
  }
  private ownerRecovery(now=this.clock()):CommunityOwnerRecovery {
    return new CommunityOwnerRecovery({store:this.store,issuer:this.issuer,stateKey:this.stateKey,now,
      member:id=>this.member(id),policy:m=>this.policy(m),community:id=>this.community(id),authorization:(m,p,at)=>this.authorization(m,p,at)});
  }
  private pushSubscription(m:Member,now=this.clock()):(AccessPushSubscription&{subscriptionGeneration?:string})|undefined {
    const safety=this.screenSafety(now).subscription(m);
    if(safety)return {token:safety.token,environment:safety.environment,topic:safety.topic,subscriptionGeneration:safety.generation};
    const cipher=this.store.get<string>('push:'+m.enrollmentId);return cipher?openSealed<AccessPushSubscription>(cipher,this.stateKey,m.enrollmentId):undefined;
  }
  handle(value:unknown,bucket:string):{status:number;envelope:AccessEnvelope}{
    let r:AccessRequest|undefined;
    try{
      r=readAccessRequest(value,this.clock());
      this.store.transaction(()=>{this.store.collect(this.clock());const key=`access-rate:${hash(bucket)}:${Math.floor(this.clock()/60_000)}`,count=(this.store.get<number>(key)??0)+1;
        demand(count<=600,'RATE_LIMITED');this.store.put(key,count,this.clock()+120_000);});
      return {status:200,envelope:this.store.transaction(()=>this.execute(r!))};
    }catch(error){const fault=error instanceof Fault?error:new Fault('SERVICE_UNAVAILABLE',503);
      return {status:fault.status,envelope:accessSigned('error',r?.id??null,this.clock(),{code:fault.code},this.issuer)};}
  }
  /** The outbox is bounded and claimed once. Delivery failure never changes a committed registration result. */
  takeNotifications(limit=4):CommunityAccessNotification[] {
    demand(integer(limit)&&limit<=4);if(limit===0)return [];
    return this.store.transaction(()=>{
      const now=this.clock(),jobs:CommunityAccessNotification[]=[];
      for(const id of (this.store.get<string[]>('access-notification-queue')??[]).slice(-32)){
        const p=this.store.get<PendingPlan>(`access-plan:${id}`);if(!p||p.expiresAt<=now||p.enrollmentId)continue;
        const c=this.community(p.communityId);
        for(const recipientId of c.memberIds){
          if(jobs.length===limit)return jobs;
          const m=this.store.get<Member>(`member:${recipientId}`),claim=`access-notified:${p.id}:${recipientId}`;
          if(!m||m.communityId!==c.id||m.revokedAt!==null||!m.admin||this.store.get(claim))continue;
          const subscription=this.pushSubscription(m,now);if(!subscription)continue;
          if(!this.allowedPushTopics.includes(subscription.topic))continue;
          this.store.put(claim,true,p.expiresAt);
          jobs.push({...subscription,planId:p.id,communityId:c.id,digest:p.digest,recipientId,recipientKeyEpoch:m.keyEpoch,expiresAt:p.expiresAt,
            notice:accessNoticeSigned(p.id,c.id,c.profileId,p.digest,now,p.expiresAt,this.issuer)});
        }
      }
      return jobs;
    });
  }
  hasNotifications():boolean {
    const now=this.clock();
    for(const id of (this.store.get<string[]>('access-notification-queue')??[]).slice(-32)){
      const p=this.store.get<PendingPlan>(`access-plan:${id}`);if(!p||p.expiresAt<=now||p.enrollmentId)continue;
      const c=this.community(p.communityId);
      for(const recipientId of c.memberIds){
        const m=this.store.get<Member>(`member:${recipientId}`);
        if(!m||m.communityId!==c.id||m.revokedAt!==null||!m.admin||this.store.get(`access-notified:${p.id}:${recipientId}`))continue;
        const subscription=this.pushSubscription(m,now);if(subscription&&this.allowedPushTopics.includes(subscription.topic))return true;
      }
    }
    return false;
  }
  notificationCurrent(job:CommunityAccessNotification):boolean {
    const now=this.clock(),p=this.store.get<PendingPlan>(`access-plan:${job.planId}`),m=this.store.get<Member>(`member:${job.recipientId}`);
    if(!p||p.enrollmentId||p.expiresAt<=now||p.communityId!==job.communityId||p.digest!==job.digest||!m||m.communityId!==job.communityId||m.revokedAt!==null||!m.admin||m.keyEpoch!==job.recipientKeyEpoch||!this.allowedPushTopics.includes(job.topic))return false;
    const current=this.pushSubscription(m,now);if(!current||current.subscriptionGeneration!==job.subscriptionGeneration)return false;
    return current.token===job.token&&current.topic===job.topic&&current.environment===job.environment;
  }
  removeDeadPush(job:CommunityAccessNotification):void {
    this.store.transaction(()=>{
      if(job.subscriptionGeneration){this.screenSafety().removeDeadPush({...job,subscriptionGeneration:job.subscriptionGeneration});return;}
      const cipher=this.store.get<string>(`push:${job.recipientId}`);if(!cipher)return;
      const current=openSealed<AccessPushSubscription>(cipher,this.stateKey,job.recipientId);
      if(current.token===job.token&&current.topic===job.topic&&current.environment===job.environment)this.store.remove(`push:${job.recipientId}`);
    });
  }
  private reply(r:AccessRequest,kind:string,payload:unknown,now:number):AccessEnvelope{return accessSigned(kind,r.id,now,payload,this.issuer);}
  private community(id:unknown):Community{demand(uuid(id));const c=this.store.get<Community>(`community:${id}`);demand(c,'COMMUNITY_NOT_FOUND');return c;}
  private member(id:unknown):Member{demand(uuid(id),'NOT_ENROLLED');const m=this.store.get<Member>(`member:${id}`);demand(m&&m.revokedAt===null,'NOT_ENROLLED');return m;}
  private policy(m:Member):Policy{const p=this.store.get<Policy>(`access-policy:${m.enrollmentId}`);demand(p&&p.plan.hostKey===m.hostKey&&p.plan.biometricKey===m.viewerKey,'NOT_AUTHORIZED');return p;}
  private authorization(m:Member,p:Policy,now:number):AccessAuthorization{
    const c=this.community(m.communityId);
    return {version:1,communityId:c.id,profileId:c.profileId,enrollmentId:m.enrollmentId,deviceId:m.deviceId,deviceKind:p.plan.kind,
      name:p.plan.name,hostPublicKey:m.hostKey,publicKey:p.plan.operationKey,biometricPublicKey:m.viewerKey,controlKey:p.plan.controlKey,agentDeviceId:p.plan.agentDeviceId,capabilities:p.plan.capabilities,revision:p.revision,keyEpoch:m.keyEpoch,issuedAt:now,expiresAt:now+ACCESS_LEASE_MS};
  }
  private managementTarget(c:Community,plan:AccessPlan,actor:Member):Member|undefined {
    demand(plan.deviceId!==actor.deviceId&&![plan.hostKey,plan.biometricKey].some(k=>k===actor.hostKey||k===actor.viewerKey),'SELF_MANAGEMENT_FORBIDDEN');
    const target=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`)).find(m=>m?.deviceId===plan.deviceId&&m.revokedAt===null);
    if(target)demand(target.communityId===c.id&&target.platform==='ios'&&target.hostKey===plan.hostKey&&target.viewerKey===plan.biometricKey&&target.keyEpoch>0,'IDENTITY_CHANGED');
    else demand(!c.memberIds.some(id=>{const old=this.store.get<Member>(`member:${id}`);return old?.deviceId===plan.deviceId&&old.revokedAt!==null;}),'REVOKED_IDENTITY');
    return target;
  }
  private useSession(s:Session,now:number):AccessUseSession{return {version:1,communityId:s.communityId,enrollmentId:s.enrollmentId,sessionId:s.id,
    publicKey:s.publicKey,capabilities:s.capabilities,revision:s.revision,sequence:s.sequence,lastHumanAt:s.lastHumanAt,idleExpiresAt:s.expiresAt,issuedAt:now,expiresAt:Math.min(now+ACCESS_LEASE_MS,s.expiresAt)};}
  private liveSession(id:unknown,m:Member,p:Policy):Session{
    demand(uuid(id),'SESSION_REQUIRED');const s=this.store.get<Session>(`access-session:${id}`),now=this.clock();
    demand(s&&!s.closed&&s.enrollmentId===m.enrollmentId&&s.communityId===m.communityId&&s.expiresAt>now&&s.revision===p.revision
      &&this.store.get(`access-current-session:${m.enrollmentId}`)===id,'SESSION_EXPIRED');return s;
  }
  private record(r:AccessRequest,key:string,result:AccessEnvelope):AccessEnvelope{
    const recoveryKey=r.actor?this.member(r.actor).hostKey:key;
    const ownerMutation=['owner-delegation-set','owner-recovery-request','owner-recovery-publish','owner-recovery-approve','owner-recovery-result'].includes(r.op);
    const expiresAt=this.clock()+(ownerMutation?7*86400_000:ACCESS_PLAN_MS);
    if(ownerMutation){
      // Keep a bounded seven-day mutation fence; read-only polling retains its existing short receipt lifetime.
      // A separate negative reserve lets OFF be reported even after the positive journal is full.
      const negative=r.op==='owner-delegation-set'&&(r.args[1] as {enabled?:unknown})?.enabled===false;
      const index=`owner-mutation-receipts:${String(r.args[0])}:${negative?'negative':'positive'}`;
      const live=(this.store.get<{id:string;expiresAt:number}[]>(index)??[]).filter(v=>v.expiresAt>this.clock());
      demand(live.length<(negative?128:1024),'OWNER_MUTATION_RECEIPTS_FULL');
      this.store.put(index,[...live,{id:r.id,expiresAt}]);
    }
    this.store.put(`access-receipt:${r.id}`,{key,recoveryKey,actor:r.actor,hash:hash(r.bytes),cipher:seal(result,this.stateKey,'access:'+r.id),expiresAt} satisfies Receipt,expiresAt);
    this.store.put(`access-nonce:${fingerprint(key)}:${r.nonce}`,r.id,expiresAt);return result;
  }
  private execute(r:AccessRequest):AccessEnvelope{
    const a=r.args,now=this.clock(),prior=this.store.get<Receipt>(`access-receipt:${r.id}`);
    // A replay can recover only the same signed result. It cannot extend a session or a lease.
    if(prior){demand(prior.hash===hash(r.bytes),'REQUEST_CONFLICT');checkAccessProof(r,prior.key);return openSealed<AccessEnvelope>(prior.cipher,this.stateKey,'access:'+r.id);}
    let proofKey:string,kind:string,payload:unknown;
    if(r.op==='receipt'){
      demand(a.length===1&&uuid(a[0]));const receipt=this.store.get<Receipt>(`access-receipt:${a[0]}`);
      demand(receipt&&receipt.actor===r.actor&&receipt.expiresAt>now,'RECEIPT_NOT_FOUND');checkAccessProof(r,receipt.recoveryKey);
      return this.reply(r,'receipt',{originalRequestId:a[0],result:openSealed<AccessEnvelope>(receipt.cipher,this.stateKey,'access:'+a[0])},now);
    }else if(r.op==='recover-registration'){
      demand(r.actor===null&&(a.length===1||a.length===2));const plan=accessPlan(a[0]);proofKey=plan.hostKey;checkAccessProof(r,proofKey);
      let original:AccessRequest|undefined,originalRequestHash:string|null=null;
      if(a.length===2){
        exact(a[1],['payload','signature']);demand(typeof a[1].payload==='string');
        let raw:unknown;try{raw=JSON.parse(Buffer.from(a[1].payload,'base64url').toString('utf8'));}catch{throw new Fault('INVALID_REQUEST');}
        demand(Array.isArray(raw)&&integer(raw[3]));original=readAccessRequest(a[1],raw[3]);
        demand(original.op==='prepare'&&original.actor===null&&original.args.length===1&&hash(accessPlanBytes(accessPlan(original.args[0])))===hash(accessPlanBytes(plan)),'RECOVERY_BINDING_MISMATCH');
        checkAccessProof(original,proofKey);originalRequestHash=hash(Buffer.from(JSON.stringify([a[1].payload,a[1].signature])));
        const receipt=this.store.get<Receipt>(`access-receipt:${original.id}`);if(receipt)demand(receipt.hash===hash(original.bytes)&&receipt.key===proofKey,'REQUEST_CONFLICT');
      }
      const c=this.community(this.store.get<string>('bootstrap-completed'));demand(c.profileId===plan.profileId,'OTHER_COMMUNITY');
      const digest=hash(accessPlanBytes(plan)),members=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`));
      const target=members.find(m=>m?.deviceId===plan.deviceId&&m.revokedAt===null);
      if(target){
        demand(target.hostKey===plan.hostKey&&target.viewerKey===plan.biometricKey,'IDENTITY_CHANGED');
        const policy=this.store.get<Policy>(`access-policy:${target.enrollmentId}`);
        if(policy){
          if(hash(accessPlanBytes(policy.plan))===digest){kind='authorization';payload=this.authorization(target,this.policy(target),now);return this.record(r,proofKey,this.reply(r,kind,payload,now));}
          // An expired feature/name update must not be confused with the already-approved, different policy.
          // Read only: preserve that policy; permit absence only for the same complete stable key identity.
          demand(policy.plan.kind===plan.kind&&policy.plan.operationKey===plan.operationKey&&policy.plan.controlKey===plan.controlKey&&policy.plan.agentDeviceId===plan.agentDeviceId
            ||desktopTrustUpdatePreservesIdentity(policy.plan,plan),'POLICY_CHANGED');
        }
      }else demand(!members.some(m=>m?.deviceId===plan.deviceId&&m.revokedAt!==null),'REGISTRATION_REVOKED');
      const pending=(this.store.get<string[]>(`access-pending:${c.id}`)??[]).map(id=>this.store.get<PendingPlan>(`access-plan:${id}`))
        .find(p=>p&&p.expiresAt>now&&!p.enrollmentId&&p.plan.deviceId===plan.deviceId);
      if(pending){demand(pending.plan.hostKey===plan.hostKey&&pending.plan.biometricKey===plan.biometricKey&&pending.digest===digest,'RECOVER_EXISTING_REQUEST');kind='prepared';payload={planId:pending.id,communityId:c.id,digest:pending.digest,expiresAt:pending.expiresAt};}
      else{
        // A delayed original prepare remains admissible for 60 seconds. A current absence cannot close that fence.
        if(original)demand(now>original.at+60_000,'REQUEST_STILL_POSSIBLE');
        kind='registration-absent';payload={communityId:c.id,profileId:plan.profileId,deviceId:plan.deviceId,planDigest:digest,
          originalRequestId:original?.id??null,originalRequestHash,originalIssuedAt:original?.at??null};
      }
    }else if(r.op==='prepare'){
      demand(r.actor===null&&a.length===1);const plan=accessPlan(a[0]);proofKey=plan.hostKey;checkAccessProof(r,proofKey);
      const c=this.community(this.store.get<string>('bootstrap-completed'));demand(c.profileId===plan.profileId,'OTHER_COMMUNITY');
      const budgetKey=`access-prepare:${c.id}:${Math.floor(now/60_000)}`,count=this.store.get<number>(budgetKey)??0;
      demand(count<6,'RATE_LIMITED');this.store.put(budgetKey,count+1,now+120_000);
      const pending=this.store.get<string[]>(`access-pending:${c.id}`)??[];
      const live=pending.map(id=>this.store.get<PendingPlan>(`access-plan:${id}`)).filter((p):p is PendingPlan=>!!p&&p.expiresAt>now&&!p.enrollmentId);
      demand(live.length<32,'TOO_MANY_REQUESTS');const digest=hash(accessPlanBytes(plan));
      const existing=live.find(p=>p.plan.deviceId===plan.deviceId&&p.plan.hostKey===plan.hostKey);
      demand(!existing||existing.digest===digest,'RECOVER_EXISTING_REQUEST');
      const p=existing??{id:r.id,communityId:c.id,plan,digest,expiresAt:now+ACCESS_PLAN_MS,enrollmentId:null};
      if(!existing){
        this.store.put(`access-plan:${p.id}`,p,p.expiresAt);this.store.put(`access-pending:${c.id}`,[...live.map(p=>p.id),p.id]);
        const queue=(this.store.get<string[]>('access-notification-queue')??[]).filter(id=>{const queued=this.store.get<PendingPlan>(`access-plan:${id}`);return !!queued&&queued.expiresAt>now&&!queued.enrollmentId;});
        this.store.put('access-notification-queue',[...queue.filter(id=>id!==p.id),p.id].slice(-32));
      }
      kind='prepared';payload={planId:p.id,communityId:c.id,digest:p.digest,expiresAt:p.expiresAt};
    }else if(r.op==='status'){
      demand(r.actor===null&&a.length===1&&uuid(a[0]));const p=this.store.get<PendingPlan>(`access-plan:${a[0]}`);demand(p,'REQUEST_EXPIRED');
      proofKey=p.plan.hostKey;checkAccessProof(r,proofKey);
      if(p.enrollmentId){const m=this.member(p.enrollmentId);kind='authorization';payload=this.authorization(m,this.policy(m),now);}
      else{demand(p.expiresAt>now,'REQUEST_EXPIRED');kind='prepared';payload={planId:p.id,communityId:p.communityId,digest:p.digest,expiresAt:p.expiresAt};}
    }else{
      const m=this.member(r.actor),c=this.community(m.communityId);demand(a[0]===c.id,'OTHER_COMMUNITY');
      if((OWNER_RECOVERY_OPERATIONS as readonly string[]).includes(r.op)){
        const result=this.ownerRecovery(now).execute(r,m,c,this.policy(m));proofKey=result.key;kind=result.kind;payload=result.payload;
      }else if((SAFETY_OPERATIONS as readonly string[]).includes(r.op)){
        const result=this.screenSafety(now).execute(r,m,c,this.policy(m));proofKey=result.key;kind=result.kind;payload=result.payload;
      }else if(['list','review','approve','review-management','approve-management'].includes(r.op)){
        const managementOperation=r.op==='review-management'||r.op==='approve-management';
        const approving=r.op==='approve'||r.op==='approve-management';
        demand(m.admin,'ADMIN_REQUIRED');proofKey=approving?m.viewerKey:m.hostKey;checkAccessProof(r,proofKey);
        if(r.op==='list'){
          demand(a.length===1);kind='pending-list';payload=(this.store.get<string[]>(`access-pending:${c.id}`)??[])
            .map(id=>this.store.get<PendingPlan>(`access-plan:${id}`)).filter((p):p is PendingPlan=>!!p&&p.expiresAt>now&&!p.enrollmentId)
            .map(p=>({planId:p.id,name:p.plan.name,kind:p.plan.kind,expiresAt:p.expiresAt}));
        }else{
          demand(uuid(a[1]));const p=this.store.get<PendingPlan>(`access-plan:${a[1]}`);demand(p&&p.communityId===c.id&&p.expiresAt>now&&!p.enrollmentId,'REQUEST_EXPIRED');
          if(!approving){
            demand(a.length===(managementOperation?3:2));const review:Review={admin:m.enrollmentId,planId:p.id,digest:p.digest,revision:c.revision,challenge:accessChallenge(),expiresAt:Math.min(p.expiresAt,now+120_000)};
            if(managementOperation){
              demand(typeof a[2]==='boolean'&&p.plan.kind==='mobile','INVALID_MANAGEMENT');
              const target=this.managementTarget(c,p.plan,m);
              demand(target?.admin!==a[2]&&(a[2]||target?.admin===true),'MANAGEMENT_ROLE_UNCHANGED');
              const intent:Omit<AccessManagementIntent,'digest'>={version:1,communityId:c.id,targetEnrollmentId:target?.enrollmentId??null,targetKeyEpoch:target?.keyEpoch??1,
                previousAdministrator:target?.admin??false,administrator:a[2],issuedAt:now,nonce:r.nonce};
              review.management={...intent,digest:accessManagementDigest(review,p.plan,intent)};
            }
            this.store.put(`access-review:${m.enrollmentId}:${p.id}`,review,review.expiresAt);kind=managementOperation?'management-review':'review';payload={...review,plan:p.plan};
          }else{
            demand(a.length===(managementOperation?6:5)&&a[2]===p.digest&&typeof a[3]==='string'&&integer(a[4]),'INVALID_APPROVAL');
            const review=this.store.get<Review>(`access-review:${m.enrollmentId}:${p.id}`);
            demand(review&&review.challenge===a[3]&&review.digest===p.digest&&review.revision===a[4]&&c.revision===a[4]&&review.expiresAt>now,'STALE_APPROVAL');
            demand(!!review.management===managementOperation,'MANAGEMENT_REVIEW_REQUIRED');
            if(review.management){
              const intent=review.management,target=this.managementTarget(c,p.plan,m);
              demand(p.plan.kind==='mobile'&&intent.communityId===c.id&&intent.targetEnrollmentId===(target?.enrollmentId??null)&&intent.targetKeyEpoch===(target?.keyEpoch??1)
                &&intent.previousAdministrator===(target?.admin??false)&&intent.digest===a[5]&&intent.digest===accessManagementDigest(review,p.plan,intent),'STALE_MANAGEMENT');
              if(!intent.administrator)demand(c.memberIds.some(id=>{const other=this.store.get<Member>(`member:${id}`);return !!other&&other.revokedAt===null&&other.admin&&other.enrollmentId!==target?.enrollmentId;}),'LAST_ADMIN_REQUIRED');
            }
            const members=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`)).filter((x):x is Member=>!!x&&x.revokedAt===null);
            let target=members.find(x=>x.deviceId===p.plan.deviceId);
            if(target){demand(target.hostKey===p.plan.hostKey&&target.viewerKey===p.plan.biometricKey,'IDENTITY_CHANGED');
              demand(target.platform===(p.plan.kind==='mobile'?'ios':'mac'),'DEVICE_KIND_CHANGED');
              const old=this.store.get<Policy>(`access-policy:${target.enrollmentId}`);
              if(old&&p.plan.capabilities.includes('screen.desktop-trust')){
                // Component ownership is checked by the native audited candidate-binding flow before it signs this
                // reviewed plan. The issuer enforces the explicit combined scope and preserves every existing key.
                demand(desktopTrustUpdatePreservesIdentity(old.plan,p.plan),'DESKTOP_TRUST_KEYS_IMMUTABLE');
              }
            }
            else{
              demand(members.length<MAX_MEMBERS&&c.memberIds.length<1024,'COMMUNITY_FULL');
              target={enrollmentId:randomUUID(),communityId:c.id,profileId:c.profileId,deviceId:p.plan.deviceId,name:p.plan.name,hostKey:p.plan.hostKey,viewerKey:p.plan.biometricKey,
                platform:p.plan.kind==='mobile'?'ios':'mac',grant:'none',admin:false,keyEpoch:1,joinedAt:now,revokedAt:null,route:null};c.memberIds.push(target.enrollmentId);
            }
            demand(members.every(x=>x.enrollmentId===target!.enrollmentId||![x.hostKey,x.viewerKey].some(k=>[p.plan.hostKey,p.plan.biometricKey,p.plan.operationKey,p.plan.controlKey].includes(k))),'KEY_CONFLICT');
            const existingPolicies=members.filter(x=>x.enrollmentId!==target!.enrollmentId).map(x=>this.store.get<Policy>(`access-policy:${x.enrollmentId}`));
            demand(existingPolicies.every(x=>!x||![x.plan.hostKey,x.plan.biometricKey,x.plan.operationKey,...(x.plan.controlKey?[x.plan.controlKey]:[])].some(k=>[p.plan.hostKey,p.plan.biometricKey,p.plan.operationKey,p.plan.controlKey].includes(k))),'KEY_CONFLICT');
            demand(p.plan.agentDeviceId===null||existingPolicies.every(x=>!x||x.plan.agentDeviceId!==p.plan.agentDeviceId),'AGENT_DEVICE_ID_CONFLICT');
            c.revision++;target.grant=p.plan.capabilities.includes('screen.receive.control')?'control':p.plan.capabilities.includes('screen.receive.view')?'view':'none';
            // Only a freshly reviewed management-domain BIO proof can change this role. Normal approval preserves it.
            if(review.management){target.admin=review.management.administrator;if(!target.admin){this.store.remove(`push:${target.enrollmentId}`);this.store.remove('safety-subscription:'+target.enrollmentId);}}
            const policy:Policy={plan:p.plan,enrollmentId:target.enrollmentId,revision:c.revision};p.enrollmentId=target.enrollmentId;
            this.store.put(`member:${target.enrollmentId}`,target);this.store.put(`community:${c.id}`,c);this.store.put(`access-policy:${target.enrollmentId}`,policy);
            this.store.put(`access-plan:${p.id}`,p,now+ACCESS_PLAN_MS);this.store.remove(`access-review:${m.enrollmentId}:${p.id}`);
            kind='authorization';payload=this.authorization(target,policy,now);
          }
        }
      }else if(['component-status','component-directory','component-ticket','component-session'].includes(r.op)){
        const policy=this.policy(m);demand(policy.plan.kind==='desktop'&&policy.plan.controlKey!==null,'COMPONENT_KEY_REQUIRED');
        proofKey=policy.plan.controlKey;checkAccessProof(r,proofKey);
        if(r.op==='component-status'){
          demand(a.length===1);kind='authorization';payload=this.authorization(m,policy,now);
        }else if(r.op==='component-directory'){
          demand(a.length===1&&policy.plan.capabilities.some(c=>c==='agent.communicate'||c==='teams.run'||c==='computer-use.agent-settings'||c==='computer-use.browser'),'CAPABILITY_DENIED');
          kind='directory';payload=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`))
            .filter((other):other is Member=>!!other&&other.revokedAt===null&&!!this.store.get(`access-policy:${other.enrollmentId}`))
            .map(other=>this.authorization(other,this.policy(other),now));
        }else if(r.op==='component-session'){
          demand(a.length===4&&mobileRelayPurpose(a[1])&&uuid(a[2])&&uuid(a[3]));
          const purpose=a[1];demand(accessPurposeAllowed(policy.plan.capabilities,purpose,'host'),'CAPABILITY_DENIED');
          const controller=this.member(a[2]),controllerPolicy=this.policy(controller);
          demand(controller.communityId===m.communityId,'OTHER_COMMUNITY');demand(controllerPolicy.plan.kind==='mobile','MOBILE_SESSION_REQUIRED');
          const session=this.liveSession(a[3],controller,controllerPolicy);
          demand(accessPurposeAllowed(controllerPolicy.plan.capabilities,purpose,'client')&&accessPurposeAllowed(session.capabilities,purpose,'client'),'CAPABILITY_DENIED');
          kind='session';payload=this.useSession(session,now);
        }else{
          demand(a.length===4&&a[1]!=='screen'&&RELAY_PURPOSES.includes(a[1] as RelayPurpose)&&uuid(a[2])&&['host','client'].includes(a[3] as string));
          const purpose=a[1] as RelayPurpose,role=a[3] as 'host'|'client';demand(accessRelayRoleAllowed('desktop',purpose,role),'INVALID_TICKET_ROLE');demand(accessPurposeAllowed(policy.plan.capabilities,purpose,role),'CAPABILITY_DENIED');
          kind='ticket';payload={version:1,ticketId:r.id,communityId:c.id,enrollmentId:m.enrollmentId,deviceId:m.deviceId,deviceKind:'desktop',
            connectionId:a[2],publicKey:proofKey,purpose,role,sessionId:null,revision:policy.revision,issuedAt:now,expiresAt:now+30_000,leaseExpiresAt:now+ACCESS_LEASE_MS} satisfies AccessRelayTicket;
        }
      }else if(['receiver-status','receiver-directory','receiver-ticket','receiver-session'].includes(r.op)){
        const policy=this.policy(m);demand(policy.plan.kind==='desktop'&&policy.plan.capabilities.includes('screen.receive.view'),'CAPABILITY_DENIED');
        proofKey=m.hostKey;checkAccessProof(r,proofKey);
        if(r.op==='receiver-status'){
          demand(a.length===1);kind='authorization';payload=this.authorization(m,policy,now);
        }else if(r.op==='receiver-directory'){
          demand(a.length===1);kind='directory';payload=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`))
            .filter((other):other is Member=>!!other&&other.revokedAt===null&&!!this.store.get(`access-policy:${other.enrollmentId}`))
            .map(other=>this.authorization(other,this.policy(other),now));
        }else if(r.op==='receiver-session'){
          demand(a.length===3&&uuid(a[1])&&uuid(a[2]));const controller=this.member(a[1]),controllerPolicy=this.policy(controller);
          demand(controller.communityId===m.communityId&&controllerPolicy.plan.kind==='mobile','OTHER_COMMUNITY');
          const session=this.liveSession(a[2],controller,controllerPolicy);demand(session.capabilities.includes('screen.view'),'CAPABILITY_DENIED');
          kind='session';payload=this.useSession(session,now);
        }else{
          demand(a.length===2&&uuid(a[1]));
          kind='ticket';payload={version:1,ticketId:r.id,communityId:c.id,enrollmentId:m.enrollmentId,deviceId:m.deviceId,deviceKind:'desktop',
            connectionId:a[1],publicKey:m.hostKey,purpose:'screen',role:'host',sessionId:null,revision:policy.revision,issuedAt:now,expiresAt:now+30_000,leaseExpiresAt:now+ACCESS_LEASE_MS} satisfies AccessRelayTicket;
        }
      }else{
        const policy=this.policy(m);proofKey=policy.plan.operationKey;
        if(r.op==='authorization'){
          demand(a.length===1);checkAccessProof(r,proofKey);kind='authorization';payload=this.authorization(m,policy,now);
        }else if(r.op==='directory'){
          demand(a.length===2);
          if(policy.plan.kind==='mobile'){proofKey=this.liveSession(a[1],m,policy).publicKey;}else demand(a[1]===null,'INVALID_SESSION');
          checkAccessProof(r,proofKey);kind='directory';payload=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`))
            .filter((other):other is Member=>!!other&&other.revokedAt===null&&!!this.store.get(`access-policy:${other.enrollmentId}`))
            .map(other=>this.authorization(other,this.policy(other),now));
        }else if(r.op==='session-open'){
          demand(policy.plan.kind==='mobile'&&a.length===3,'MOBILE_SESSION_REQUIRED');publicKey(a[1]);
          demand(a[1]!==m.hostKey&&a[1]!==m.viewerKey&&a[1]!==policy.plan.operationKey,'KEYS_MUST_DIFFER');
          proofKey=m.viewerKey;checkAccessProof(r,proofKey);const caps=capabilities(a[2],'mobile');demand(caps.every(cap=>policy.plan.capabilities.includes(cap)),'CAPABILITY_DENIED');
          const s:Session={id:r.id,communityId:c.id,enrollmentId:m.enrollmentId,publicKey:a[1] as string,capabilities:caps,sequence:0,lastHumanAt:now,expiresAt:now+ACCESS_IDLE_MS,closed:false,revision:policy.revision};
          this.store.put(`access-session:${s.id}`,s,s.expiresAt+ACCESS_PLAN_MS);this.store.put(`access-current-session:${m.enrollmentId}`,s.id,s.expiresAt+ACCESS_PLAN_MS);
          kind='session';payload=this.useSession(s,now);
        }else if(r.op==='activity'||r.op==='session-close'||r.op==='session-status'){
          demand(policy.plan.kind==='mobile'&&a.length===(r.op==='activity'?4:2));const s=this.liveSession(a[1],m,policy);
          proofKey=s.publicKey;checkAccessProof(r,proofKey);
          if(r.op==='activity'){
            demand(integer(a[2])&&a[2]===s.sequence+1&&['touch','key','action'].includes(a[3] as string),'INVALID_ACTIVITY');
            const observedAt=Math.min(now,r.at);demand(observedAt>=s.lastHumanAt,'INVALID_ACTIVITY');
            s.sequence++;s.lastHumanAt=observedAt;s.expiresAt=observedAt+ACCESS_IDLE_MS;
          }else if(r.op==='session-close'){s.closed=true;}
          this.store.put(`access-session:${s.id}`,s,s.expiresAt+ACCESS_PLAN_MS);
          kind=s.closed?'session-closed':'session';payload=s.closed?{sessionId:s.id}:this.useSession(s,now);
        }else if(r.op==='relay-ticket'){
          demand(a.length===5&&RELAY_PURPOSES.includes(a[1] as RelayPurpose)&&uuid(a[2])&&(a[3]==='host'||a[3]==='client'));
          const purpose=a[1] as RelayPurpose,role=a[3] as 'host'|'client';let expiry=now+ACCESS_LEASE_MS,sessionId:string|null=null,caps=policy.plan.capabilities;
          demand(purpose!=='screen'||role!=='host','RECEIVER_TICKET_REQUIRED');
          demand(policy.plan.kind!=='desktop'||purpose==='screen','COMPONENT_TICKET_REQUIRED');
          demand(accessRelayRoleAllowed(policy.plan.kind,purpose,role),'INVALID_TICKET_ROLE');
          if(policy.plan.kind==='mobile'){const s=this.liveSession(a[4],m,policy);proofKey=s.publicKey;caps=s.capabilities;expiry=Math.min(expiry,s.expiresAt);sessionId=s.id;demand(role==='client','MOBILE_CANNOT_HOST');}
          else demand(a[4]===null,'INVALID_SESSION');
          checkAccessProof(r,proofKey);demand(accessPurposeAllowed(caps,purpose,role),'CAPABILITY_DENIED');
          const ticket:AccessRelayTicket={version:1,ticketId:r.id,communityId:c.id,enrollmentId:m.enrollmentId,deviceId:m.deviceId,deviceKind:policy.plan.kind,
            connectionId:a[2],publicKey:proofKey,purpose,role,sessionId,revision:policy.revision,issuedAt:now,expiresAt:Math.min(now+30_000,expiry),leaseExpiresAt:expiry};
          kind='ticket';payload=ticket;
        }else throw new Fault('INVALID_OPERATION');
      }
    }
    const nonce=this.store.get<string>(`access-nonce:${fingerprint(proofKey!)}:${r.nonce}`);demand(nonce===undefined||nonce===r.id,'REPLAYED_NONCE');
    return this.record(r,proofKey!,this.reply(r,kind!,payload,now));
  }
  /** Only the private DO binding calls this. The public Worker does not expose the admission URL. */
  admitTicket(value:unknown):AccessRelayTicket{
    return this.store.transaction(()=>{
      const fields=verifyAccessEnvelope(value,this.issuerPublic);demand(fields[1]==='ticket');const ticket=fields[4] as AccessRelayTicket;
      exact(ticket,['version','ticketId','communityId','enrollmentId','deviceId','deviceKind','connectionId','publicKey','purpose','role','sessionId','revision','issuedAt','expiresAt','leaseExpiresAt']);
      demand(ticket.version===1&&[ticket.ticketId,ticket.communityId,ticket.enrollmentId,ticket.deviceId,ticket.connectionId].every(uuid)
        &&['desktop','mobile'].includes(ticket.deviceKind)&&RELAY_PURPOSES.includes(ticket.purpose)
        &&['host','client'].includes(ticket.role)&&(ticket.sessionId===null||uuid(ticket.sessionId))
        &&[ticket.revision,ticket.issuedAt,ticket.expiresAt,ticket.leaseExpiresAt].every(integer)&&ticket.revision>0,'INVALID_TICKET');
      publicKey(ticket.publicKey);
      const now=this.clock();demand(fields[2]===ticket.ticketId&&ticket.issuedAt===fields[3]
        &&ticket.issuedAt<=now&&ticket.expiresAt>now&&ticket.expiresAt<=ticket.issuedAt+30_000&&ticket.expiresAt<=ticket.leaseExpiresAt
        &&ticket.leaseExpiresAt>now&&ticket.leaseExpiresAt<=ticket.issuedAt+ACCESS_LEASE_MS,'TICKET_EXPIRED');
      const member=this.member(ticket.enrollmentId),policy=this.policy(member);demand(ticket.communityId===member.communityId&&ticket.deviceId===member.deviceId&&ticket.deviceKind===policy.plan.kind&&ticket.revision===policy.revision,'STALE_AUTHORIZATION');
      demand(accessRelayRoleAllowed(ticket.deviceKind,ticket.purpose,ticket.role),'INVALID_TICKET_ROLE');
      let caps=policy.plan.capabilities;
      if(ticket.deviceKind==='mobile'){const session=this.liveSession(ticket.sessionId,member,policy);demand(ticket.publicKey===session.publicKey&&ticket.leaseExpiresAt<=session.expiresAt&&ticket.role==='client','SESSION_EXPIRED');caps=session.capabilities;}
      else demand(ticket.sessionId===null&&ticket.publicKey===(ticket.purpose==='screen'?(ticket.role==='host'?member.hostKey:policy.plan.operationKey):policy.plan.controlKey),'INVALID_PROOF');
      demand(accessPurposeAllowed(caps,ticket.purpose,ticket.role),'CAPABILITY_DENIED');
      const key=`access-ticket-used:${ticket.ticketId}`;demand(!this.store.get(key),'TICKET_ALREADY_USED');this.store.put(key,true,ticket.leaseExpiresAt);
      return ticket;
    });
  }
}
