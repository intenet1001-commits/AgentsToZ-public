import {Buffer} from 'node:buffer';
import {b64,demand,uuid,integer,seal,openSealed,hash,type Member} from './protocol';
import {exact,checkAccessProof,accessSigned,readAccessRequest,type AccessAuthorization,type AccessEnvelope,type AccessPlan,type AccessRequest} from './accessProtocol';
import {safetyPolicyDigest} from './screenSafety';
import type {RegistryStore} from './store';
import type {KeyObject} from 'node:crypto';

export const OWNER_RECOVERY_OPERATIONS=['owner-delegation-set','owner-recovery-request','owner-recovery-poll','owner-recovery-publish','owner-recovery-list','owner-recovery-approve','owner-recovery-result','owner-recovery-status'] as const;
interface Policy {plan:AccessPlan;enrollmentId:string;revision:number}
interface Community {id:string;profileId:string;memberIds:string[]}
interface Context {store:RegistryStore;issuer:KeyObject;stateKey:Buffer;now:number;member(id:unknown):Member;policy(m:Member):Policy;community(id:unknown):Community;authorization(m:Member,p:Policy,now:number):AccessAuthorization}
export interface OwnerDelegation {version:1;communityId:string;targetEnrollmentId:string;enabled:boolean;revision:number;issuedAt:number;expiresAt:number}
export interface OwnerRecoveryIntent {version:1;action:'resume-input';targetEnrollmentId:string;sourceEnrollmentId:string;delegationRevision:number;targetPolicyDigest:string;sourcePolicyDigest:string;holdGeneration:string;connectionId:string|null;challenge:string;expiresAt:number}
export interface OwnerRecoveryRecord {version:1;requestId:string;communityId:string;targetEnrollmentId:string;sourceEnrollmentId:string;delegationRevision:number;targetPolicyDigest:string;sourcePolicyDigest:string;state:'waiting-host'|'ready'|'approved'|'applied'|'refused'|'superseded'|'expired';createdAt:number;expiresAt:number;intent:OwnerRecoveryIntent|null;approval:{request:AccessEnvelope;source:AccessEnvelope;target:AccessEnvelope;delegation:AccessEnvelope}|null;outcome:'applied'|'refused'|'superseded'|null}
interface SavedDelegation {enabled:boolean;revision:number;policyDigest:string}
const terminal=(r:OwnerRecoveryRecord)=>['applied','refused','superseded','expired'].includes(r.state);
const RETAIN=7*86400_000;

/** App-owned input recovery only. It is neither OS authentication nor an enrollment/management grant. */
export class CommunityOwnerRecovery {
 constructor(private readonly c:Context){}
 private auth(m:Member){return this.c.authorization(m,this.c.policy(m),this.c.now);}
 private desktop(m:Member,receiver=false):AccessAuthorization {
  const a=this.auth(m);demand(a.deviceKind==='desktop'&&a.capabilities.includes('screen.desktop-trust')&&a.capabilities.includes(receiver?'screen.receive.control':'screen.view'),'OWNER_DESKTOP_REQUIRED');
  if(receiver)demand(a.capabilities.includes('screen.receive.view'),'OWNER_RECEIVER_REQUIRED');return a;
 }
 private source(m:Member):AccessAuthorization {return this.desktop(m);}
 private delegation(m:Member):OwnerDelegation {
  const a=this.auth(m),s=this.c.store.get<SavedDelegation>('owner-delegation:'+m.enrollmentId);
  const eligible=a.deviceKind==='desktop'&&a.capabilities.includes('screen.desktop-trust')&&a.capabilities.includes('screen.receive.control')&&a.capabilities.includes('screen.receive.view');
  const enrollmentOptIn=a.capabilities.includes('screen.owner-delegation');
  const key='owner-delegation-derived-revision:'+m.enrollmentId,old=this.c.store.get<number>(key);
  demand(old===undefined||integer(old),'OWNER_DELEGATION_STATE_INVALID');
  const derived=Math.max(old??0,!s&&enrollmentOptIn?a.revision:0);
  if(!s&&derived>(old??0))this.c.store.put(key,derived);
  // Losing cap10 disables authority, but must not roll back a revision already pinned by the target.
  // A never-opted-in legacy target still starts at zero; an explicit saved selection always wins.
  return {version:1,communityId:a.communityId,targetEnrollmentId:m.enrollmentId,enabled:eligible&&(s?!!s.enabled&&s.policyDigest===safetyPolicyDigest(a):enrollmentOptIn),revision:s?.revision??derived,issuedAt:this.c.now,expiresAt:this.c.now+90_000};
 }
 private save(r:OwnerRecoveryRecord){this.c.store.put('owner-recovery:'+r.requestId,seal(r,this.c.stateKey,'owner-recovery:'+r.requestId),r.createdAt+RETAIN);}
 private load(id:string):OwnerRecoveryRecord|undefined {const raw=this.c.store.get<string>('owner-recovery:'+id);return raw?openSealed<OwnerRecoveryRecord>(raw,this.c.stateKey,'owner-recovery:'+id):undefined;}
 private ids(cid:string):string[]{return (this.c.store.get<string[]>('owner-recovery-index:'+cid)??[]).filter(id=>!!this.load(id));}
 private current(r:OwnerRecoveryRecord):OwnerRecoveryRecord {
  if(terminal(r))return r;
  let valid=false;
  try {const target=this.c.member(r.targetEnrollmentId),source=this.c.member(r.sourceEnrollmentId),t=this.desktop(target,true),s=this.source(source),d=this.delegation(target);
   valid=d.enabled&&d.revision===r.delegationRevision&&t.communityId===r.communityId&&s.communityId===r.communityId&&target.deviceId!==source.deviceId&&safetyPolicyDigest(t)===r.targetPolicyDigest&&safetyPolicyDigest(s)===r.sourcePolicyDigest;
  }catch{}
  if(!valid||r.expiresAt<=this.c.now){r.state=!valid?'superseded':'expired';this.save(r);}return r;
 }
 private get(r:AccessRequest,m:Member):OwnerRecoveryRecord {
  demand(uuid(r.args[1]));const record=this.load(r.args[1]);demand(record&&record.communityId===m.communityId,'OWNER_REQUEST_UNKNOWN');
  demand(record.targetEnrollmentId===m.enrollmentId||record.sourceEnrollmentId===m.enrollmentId,'OTHER_OWNER_REQUEST');return this.current(record);
 }
 private sign(kind:string,id:string|null,value:unknown){return accessSigned(kind,id,this.c.now,value,this.c.issuer);}
 private round(r:AccessRequest,m:Member,target:boolean){
  if(target){
   const a=this.auth(m);demand(a.deviceKind==='desktop','OWNER_DESKTOP_REQUIRED');
   // A host may always read its own negative policy CAS after receiving permissions are removed.
   // Such a snapshot contains no challenge or positive work to execute.
   if(!a.capabilities.includes('screen.desktop-trust')||!a.capabilities.includes('screen.receive.control')||!a.capabilities.includes('screen.receive.view')){
    return {version:1,communityId:m.communityId,targetEnrollmentId:m.enrollmentId,delegation:this.sign('owner-delegation',r.id,this.delegation(m)),requests:[],issuedAt:this.c.now,expiresAt:this.c.now+90_000};
   }
  }else this.source(m);
  const requests=this.ids(m.communityId).map(id=>this.current(this.load(id)!)).filter(v=>!terminal(v)&&(target?v.targetEnrollmentId:v.sourceEnrollmentId)===m.enrollmentId);
  demand(requests.length<=4,'OWNER_QUEUE_FULL');const body={version:1,communityId:m.communityId,...(target?{targetEnrollmentId:m.enrollmentId,delegation:this.sign('owner-delegation',r.id,this.delegation(m))}:{}),requests,issuedAt:this.c.now,expiresAt:this.c.now+90_000};
  demand(Buffer.byteLength(JSON.stringify(body))<=32_000,'OWNER_RESPONSE_TOO_LARGE');return body;
 }
 execute(r:AccessRequest,m:Member,community:Community,p:Policy):{key:string;kind:string;payload:unknown}{
  const a=r.args,now=this.c.now;let key:string,kind='owner-recovery',payload:unknown;
  if(r.op==='owner-delegation-set'){
   demand(a.length===2);exact(a[1],['version','enabled','expectedRevision']);const v=a[1],prior=this.delegation(m);
   demand(v.version===1&&typeof v.enabled==='boolean'&&integer(v.expectedRevision)&&v.expectedRevision===prior.revision,'OWNER_DELEGATION_STALE');
   if(v.enabled){this.desktop(m,true);demand(r.at<=now+5_000,'INVALID_OWNER_APPROVAL_TIME');}
   else demand(this.auth(m).deviceKind==='desktop','OWNER_DESKTOP_REQUIRED');
   key=v.enabled?m.viewerKey:m.hostKey;checkAccessProof(r,key);
   const next={enabled:v.enabled,revision:prior.revision+1,policyDigest:safetyPolicyDigest(this.auth(m))};demand(integer(next.revision));this.c.store.put('owner-delegation:'+m.enrollmentId,next);kind='owner-delegation';payload=this.delegation(m);
  }else if(r.op==='owner-recovery-request'){
   demand(a.length===2&&uuid(a[1]));const source=this.source(m);key=p.plan.operationKey;checkAccessProof(r,key);
   demand(!this.load(r.id),'OWNER_REQUEST_ID_REUSED');
   const target=this.c.member(a[1]),t=this.desktop(target,true),d=this.delegation(target);
   demand(target.communityId===community.id&&target.deviceId!==m.deviceId&&target.enrollmentId!==m.enrollmentId,'OTHER_OWNER_TARGET');demand(d.enabled,'OWNER_DELEGATION_DISABLED');
   const ids=this.ids(community.id),records=ids.map(id=>this.current(this.load(id)!)),active=records.filter(v=>!terminal(v));
   const existing=active.find(v=>v.targetEnrollmentId===target.enrollmentId&&v.sourceEnrollmentId===m.enrollmentId);
   if(existing)payload=existing;else{
    demand(ids.length<512&&active.length<64&&active.filter(v=>v.targetEnrollmentId===target.enrollmentId).length<4&&active.filter(v=>v.sourceEnrollmentId===m.enrollmentId).length<4,'OWNER_QUEUE_FULL');
    const value:OwnerRecoveryRecord={version:1,requestId:r.id,communityId:community.id,targetEnrollmentId:target.enrollmentId,sourceEnrollmentId:m.enrollmentId,delegationRevision:d.revision,targetPolicyDigest:safetyPolicyDigest(t),sourcePolicyDigest:safetyPolicyDigest(source),state:'waiting-host',createdAt:now,expiresAt:now+300_000,intent:null,approval:null,outcome:null};
    this.save(value);this.c.store.put('owner-recovery-index:'+community.id,[...ids,value.requestId]);payload=value;
   }
  }else if(r.op==='owner-recovery-poll'||r.op==='owner-recovery-list'){
   demand(a.length===1);const target=r.op==='owner-recovery-poll';key=target?m.hostKey:p.plan.operationKey;checkAccessProof(r,key);kind=target?'owner-recovery-round':'owner-recovery-list';payload=this.round(r,m,target);
  }else{
   if(r.op==='owner-recovery-status'&&a.length===3&&uuid(a[1])&&!this.load(a[1])){
    key=p.plan.operationKey;checkAccessProof(r,key);this.source(m);
    exact(a[2],['payload','signature']);const raw=b64(a[2].payload,32_000);let fields:unknown;try{fields=JSON.parse(raw.toString('utf8'));}catch{demand(false);}
    demand(Array.isArray(fields)&&integer(fields[3]),'INVALID_OWNER_ORIGINAL');const original=readAccessRequest(a[2],fields[3]);
    demand(original.op==='owner-recovery-request'&&original.id===a[1]&&original.actor===m.enrollmentId&&original.args.length===2&&original.args[0]===community.id&&uuid(original.args[1]),'OWNER_ORIGINAL_MISMATCH');
    checkAccessProof(original,key);demand(now>original.at+60_000,'OWNER_REQUEST_STILL_POSSIBLE');
    demand(!this.c.store.get('access-receipt:'+original.id),'OWNER_RECEIPT_EXISTS');
    return {key,kind:'owner-recovery-absent',payload:{version:1,communityId:community.id,sourceEnrollmentId:m.enrollmentId,targetEnrollmentId:original.args[1],requestId:original.id,originalRequestHash:hash(Buffer.from(JSON.stringify([a[2].payload,a[2].signature]))),originalIssuedAt:original.at,issuedAt:now,expiresAt:now+90_000}};
   }
   // A known record can also be read using the recovery form; the optional original is never executed.
   if(r.op==='owner-recovery-status'&&a.length===3){
    demand(uuid(a[1]));key=p.plan.operationKey;checkAccessProof(r,key);this.source(m);const value=this.get(r,m);demand(value.sourceEnrollmentId===m.enrollmentId,'OTHER_OWNER_REQUEST');return {key,kind,payload:value};
   }
   demand(a.length===(r.op==='owner-recovery-status'?2:3));const value=this.get(r,m),isTarget=value.targetEnrollmentId===m.enrollmentId;
   key=r.op==='owner-recovery-approve'?m.viewerKey:isTarget?m.hostKey:p.plan.operationKey;checkAccessProof(r,key);
   if(r.op==='owner-recovery-status'){if(isTarget)this.desktop(m,true);else this.source(m);payload=value;}
   else if(r.op==='owner-recovery-publish'){
    demand(isTarget&&value.state==='waiting-host','OWNER_REQUEST_NOT_WAITING');this.desktop(m,true);
    exact(a[2],['version','action','holdGeneration','connectionId','challenge']);const v=a[2];
    demand(v.version===1&&v.action==='resume-input'&&uuid(v.holdGeneration)&&(v.connectionId===null||uuid(v.connectionId))&&b64(v.challenge,43).length===32,'INVALID_OWNER_CHALLENGE');
    value.expiresAt=Math.min(value.expiresAt,now+120_000);value.intent={version:1,action:'resume-input',targetEnrollmentId:value.targetEnrollmentId,sourceEnrollmentId:value.sourceEnrollmentId,delegationRevision:value.delegationRevision,targetPolicyDigest:value.targetPolicyDigest,sourcePolicyDigest:value.sourcePolicyDigest,holdGeneration:v.holdGeneration,connectionId:v.connectionId,challenge:v.challenge as string,expiresAt:value.expiresAt};value.state='ready';this.save(value);payload=value;
   }else if(r.op==='owner-recovery-approve'){
    demand(r.at<=now+5_000,'INVALID_OWNER_APPROVAL_TIME');
    demand(!isTarget&&value.sourceEnrollmentId===m.enrollmentId&&value.state==='ready'&&value.intent,'OWNER_REQUEST_NOT_READY');this.source(m);
    exact(a[2],['version','action','targetEnrollmentId','sourceEnrollmentId','delegationRevision','targetPolicyDigest','sourcePolicyDigest','holdGeneration','connectionId','challenge','expiresAt']);
    const submitted=a[2] as Record<string,unknown>;
    demand(Object.keys(value.intent).every(k=>submitted[k]===value.intent![k as keyof OwnerRecoveryIntent]),'OWNER_INTENT_CHANGED');
    const target=this.c.member(value.targetEnrollmentId);
    value.approval={request:{payload:r.bytes.toString('base64url'),signature:r.signature.toString('base64url')},source:this.sign('authorization',r.id,this.source(m)),target:this.sign('authorization',r.id,this.desktop(target,true)),delegation:this.sign('owner-delegation',r.id,this.delegation(target))};
    value.state='approved';this.save(value);payload=value;
   }else{
    demand(r.op==='owner-recovery-result'&&isTarget,'INVALID_OPERATION');exact(a[2],['version','outcome']);const v=a[2];demand(v.version===1&&['applied','refused','superseded'].includes(v.outcome as string),'INVALID_OWNER_RESULT');
    // A delayed outcome reports an effect already decided by the target's durable CAS; it is never new authority.
    // Preserve a genuine applied report even when its network acknowledgement arrives after the intent expires.
    demand(v.outcome!=='applied'||value.approval!==null,'OWNER_REQUEST_NOT_APPROVED');
    demand(value.outcome===null||value.outcome===v.outcome,'OWNER_RESULT_CONFLICT');value.outcome=v.outcome as OwnerRecoveryRecord['outcome'];value.state=v.outcome as 'applied'|'refused'|'superseded';this.save(value);payload=value;
   }
  }
  return {key,kind,payload};
 }
}
