import {randomUUID,verify,sign,type KeyObject} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {b64,demand,uuid,integer,hash,publicKey,seal,openSealed,type Member} from './protocol';
import {exact,checkAccessProof,accessSigned,type AccessAuthorization,type AccessEnvelope,type AccessPlan,type AccessRequest,type AccessUseSession} from './accessProtocol';
import type {RegistryStore} from './store';

export const SAFETY_OPERATIONS=['screen-safety-subscribe','receiver-safety-poll','screen-safety-stop','screen-safety-result','receiver-safety-event','screen-safety-state'] as const;
export const SAFETY_RESULT_DOMAIN=Buffer.from('agentstoz.community-screen-safety.result/v1\0');
export const SAFETY_NOTICE_DOMAIN=Buffer.from('agentstoz.community-screen-safety.notice/v1\0');
export const SAFETY_OUTCOMES=['ended','turned-off','revoked','nothing-to-do','refused','superseded'] as const;
interface Policy {plan:AccessPlan;enrollmentId:string;revision:number}
interface Community {id:string;profileId:string;revision:number;memberIds:string[]}
interface Session {id:string;communityId:string;enrollmentId:string;publicKey:string;capabilities:AccessPlan['capabilities'];sequence:number;lastHumanAt:number;expiresAt:number;closed:boolean;revision:number}
export interface SafetyContext {
  store:RegistryStore;issuer:KeyObject;stateKey:Buffer;now:number;topics:readonly string[];pushConfigured:boolean;
  member(id:unknown):Member;policy(m:Member):Policy;community(id:unknown):Community;
  authorization(m:Member,p:Policy,now:number):AccessAuthorization;
  liveSession(id:unknown,m:Member,p:Policy):Session;useSession(s:Session,now:number):AccessUseSession;
}
export interface SafetySubscription {token:string;environment:'sandbox'|'production';topic:string;generation:string;policyDigest:string;keyEpoch:number;revision:number}
export interface SafetyWatcher {enrollmentId:string;deviceId:string;hostPublicKey:string;operationPublicKey:string;keyEpoch:number;revision:number;policyDigest:string;subscriptionGeneration:string;authorizationExpiresAt:number;administrator:true}
export interface SafetySnapshot {observationSequence:number;power:'on'|'waiting'|'off';held:boolean;session:null|{channelId:string;controllerEnrollmentId:string;since:number}}
interface Receiver {activationId:string;policyDigest:string;keyEpoch:number;state:SafetySnapshot;lastPollAt:number}
interface StopRecord {commandId:string;sequence:number;acceptedAt:number;expiresAt:number;receiverPolicyDigest:string;subscriptionGeneration:string;authorization:AccessEnvelope;useSession:AccessEnvelope;request:AccessEnvelope;
  receiverEnrollmentId:string;activationId:string;ownerEnrollmentId:string;ownerKeyEpoch:number;ownerOperationKey:string;ownerPolicyDigest:string;action:'end'|'turnOff'|'revoke';result:AccessEnvelope|null}
interface EventRecord {eventId:string;communityId:string;receiverEnrollmentId:string;receiverPolicyDigest:string;activationId:string;kind:'connection'|'enrollment'|'security';actorEnrollmentId:string|null;issuedAt:number;expiresAt:number}
export interface SafetyNotification {eventKind:'connection'|'enrollment'|'security';eventId:string;communityId:string;recipientId:string;recipientKeyEpoch:number;subscriptionGeneration:string;token:string;environment:'sandbox'|'production';topic:string;expiresAt:number;notice:AccessEnvelope}
export function safetyPolicyDigest(b:AccessAuthorization):string {return hash(Buffer.from(JSON.stringify([b.version,b.communityId,b.profileId,b.enrollmentId,b.deviceId,b.agentDeviceId,b.deviceKind,b.name,b.hostPublicKey,b.publicKey,b.biometricPublicKey,b.controlKey,b.capabilities,b.revision,b.keyEpoch])));}
export function safetyWatcherHash(cid:string,receiver:string,activation:string,policy:string,watchers:readonly SafetyWatcher[]):string {
  return hash(Buffer.concat([Buffer.from('agentstoz.community-screen-safety.watchers/v1\0'),Buffer.from(JSON.stringify([1,cid,receiver,activation,policy,watchers.map(w=>[w.enrollmentId,w.deviceId,w.hostPublicKey,w.operationPublicKey,w.keyEpoch,w.revision,w.policyDigest,w.subscriptionGeneration,true])]))]));
}

/** A separate common-only negative-control channel. It never creates a legacy phone, execution grant or human session. */
export class CommunityScreenSafety {
  constructor(private readonly c:SafetyContext){}
  private auth(m:Member):AccessAuthorization{return this.c.authorization(m,this.c.policy(m),this.c.now);}
  subscription(m:Member,watcher=false):SafetySubscription|undefined {
    try{
      if(m.revokedAt!==null||!m.admin)return;
      const a=this.auth(m);if(a.deviceKind!=='mobile'||watcher&&!a.capabilities.includes('screen.view'))return;
      const raw=this.c.store.get<string>('safety-subscription:'+m.enrollmentId);if(!raw)return;
      const s=openSealed<SafetySubscription>(raw,this.c.stateKey,'safety:'+m.enrollmentId);
      if(s.policyDigest!==safetyPolicyDigest(a)||s.keyEpoch!==m.keyEpoch||s.revision!==a.revision||!uuid(s.generation)||!this.c.topics.includes(s.topic))return;
      return s;
    }catch{return;}
  }
  private watchers(community:Community):SafetyWatcher[]{
    if(!this.c.pushConfigured)return [];
    return community.memberIds.flatMap(id=>{
      try {const m=this.c.member(id),s=this.subscription(m,true);if(!s)return [];const a=this.auth(m);
        return [{enrollmentId:m.enrollmentId,deviceId:m.deviceId,hostPublicKey:m.hostKey,operationPublicKey:a.publicKey,keyEpoch:m.keyEpoch,revision:a.revision,policyDigest:s.policyDigest,subscriptionGeneration:s.generation,authorizationExpiresAt:a.expiresAt,administrator:true as const}];
      }catch{return [];}
    }).sort((a,b)=>a.enrollmentId.localeCompare(b.enrollmentId)).slice(0,16);
  }
  private receiver(m:Member):AccessAuthorization {const a=this.auth(m);demand(a.deviceKind==='desktop'&&a.capabilities.includes('screen.receive.view'),'RECEIVER_REQUIRED');return a;}
  private mobile(r:AccessRequest,m:Member,p:Policy):Session {
    demand(p.plan.kind==='mobile'&&m.admin&&p.plan.capabilities.includes('screen.view'),'SAFETY_WATCHER_REQUIRED');
    const use=this.c.liveSession(r.args[1],m,p);demand(use.capabilities.includes('screen.view'),'NOT_AUTHORIZED');checkAccessProof(r,use.publicKey);return use;
  }
  private getRecord(id:string):StopRecord|undefined {const raw=this.c.store.get<string>('safety-command:'+id);if(!raw)return;const record=openSealed<StopRecord>(raw,this.c.stateKey,'safety-command:'+id);return record.acceptedAt+7*86400_000>this.c.now?record:undefined;}
  private putRecord(record:StopRecord):void {this.c.store.put('safety-command:'+record.commandId,seal(record,this.c.stateKey,'safety-command:'+record.commandId),record.acceptedAt+7*86400_000);}
  private ids(receiver:string):string[]{return (this.c.store.get<string[]>('safety-command-index:'+receiver)??[]).filter(id=>this.getRecord(id)!==undefined);}
  private currentRecord(record:StopRecord,receiver:AccessAuthorization):boolean {
    try {const m=this.c.member(record.ownerEnrollmentId),s=this.subscription(m,true),a=this.auth(m),host=this.c.store.get<Receiver>('safety-receiver:'+receiver.enrollmentId);
      return !!s&&m.communityId===receiver.communityId&&m.keyEpoch===record.ownerKeyEpoch&&a.publicKey===record.ownerOperationKey&&s.policyDigest===record.ownerPolicyDigest&&s.generation===record.subscriptionGeneration
        &&record.receiverPolicyDigest===safetyPolicyDigest(receiver)&&host?.activationId===record.activationId;
    }catch{return false;}
  }
  private result(record:StopRecord|undefined,id:string,receiver?:AccessAuthorization):unknown {
    const state=!record?'unseen':record.result?'result':record.expiresAt<=this.c.now?'expired':(!receiver||!this.currentRecord(record,receiver))?'refused':'queued';
    return {version:1,commandId:id,receiverEnrollmentId:record?.receiverEnrollmentId??null,activationId:record?.activationId??null,state,result:record?.result??null,code:state==='refused'?'SAFETY_CONTEXT_CHANGED':null,issuedAt:this.c.now,expiresAt:this.c.now+90_000};
  }
  private signed(kind:string,r:AccessRequest,value:unknown):AccessEnvelope{return accessSigned(kind,r.id,this.c.now,value,this.c.issuer);}
  execute(r:AccessRequest,m:Member,community:Community,p:Policy):{key:string;kind:string;payload:unknown}{
    const a=r.args,now=this.c.now;let key:string,kind:string,payload:unknown;
    if(r.op==='screen-safety-subscribe'){
      demand(a.length===3&&p.plan.kind==='mobile','MOBILE_REQUIRED');key=p.plan.operationKey;checkAccessProof(r,key);
      exact(a[2],['sequence','policyDigest','keyEpoch']);const observation=a[2];
      demand(integer(observation.sequence)&&observation.sequence>0&&typeof observation.policyDigest==='string'&&/^[0-9a-f]{64}$/.test(observation.policyDigest)&&observation.keyEpoch===m.keyEpoch,'INVALID_SUBSCRIPTION_OBSERVATION');
      const sequenceKey='safety-subscription-observation:'+m.enrollmentId,lastSequence=this.c.store.get<number>(sequenceKey)??0;
      demand(observation.sequence>lastSequence,'SUBSCRIPTION_OBSERVATION_STALE');
      const own=this.auth(m),digest=safetyPolicyDigest(own);
      let generation:string|null=null;
      if(a[1]===null)this.c.store.remove('safety-subscription:'+m.enrollmentId);
      else{
        demand(m.admin,'ADMIN_REQUIRED');demand(observation.policyDigest===digest,'SUBSCRIPTION_POLICY_CHANGED');exact(a[1],['token','environment','topic']);const v=a[1];
        demand(typeof v.token==='string'&&/^[0-9a-f]{64,200}$/.test(v.token)&&v.token.length%2===0&&(v.environment==='sandbox'||v.environment==='production')&&typeof v.topic==='string'&&this.c.topics.includes(v.topic),'PUSH_NOT_CONFIGURED');
        const prior=this.subscription(m);
        const count=community.memberIds.filter(id=>{try{return !!this.subscription(this.c.member(id));}catch{return false;}}).length;
        demand(!!prior||count<16,'SAFETY_SUBSCRIPTION_LIMIT');
        generation=prior&&prior.token===v.token&&prior.environment===v.environment&&prior.topic===v.topic?prior.generation:randomUUID();
        this.c.store.put('safety-subscription:'+m.enrollmentId,seal({token:v.token,environment:v.environment,topic:v.topic,generation,policyDigest:digest,keyEpoch:m.keyEpoch,revision:own.revision} satisfies SafetySubscription,this.c.stateKey,'safety:'+m.enrollmentId));
      }
      this.c.store.put(sequenceKey,observation.sequence);
      kind='safety-subscribed';payload={version:1,communityId:community.id,enrollmentId:m.enrollmentId,subscriptionGeneration:generation,policyDigest:digest,keyEpoch:m.keyEpoch,revision:own.revision,issuedAt:now,expiresAt:now+90_000};
    }else if(r.op==='receiver-safety-poll'){
      demand(a.length===5&&uuid(a[1])&&integer(a[2])&&Array.isArray(a[3])&&a[3].length<=16);key=m.hostKey;checkAccessProof(r,key);
      const receiver=this.receiver(m),digest=safetyPolicyDigest(receiver),activation=a[1];const state=this.snapshot(a[4],community);
      const observationKey='safety-receiver-observation:'+m.enrollmentId,previousObservation=this.c.store.get<number>(observationKey)??0;
      demand(state.observationSequence>previousObservation,'SAFETY_POLL_STALE');
      this.c.store.put(observationKey,state.observationSequence);
      for(const result of a[3])this.acceptResult(result,m,community,activation);
      this.c.store.put('safety-receiver:'+m.enrollmentId,{activationId:activation,policyDigest:digest,keyEpoch:m.keyEpoch,state,lastPollAt:now} satisfies Receiver);
      const watchers=this.watchers(community),watcherIds=new Set(watchers.map(w=>w.enrollmentId)),all=this.ids(m.enrollmentId).map(id=>this.getRecord(id)!).filter(v=>!v.result&&v.expiresAt>now&&v.activationId===activation&&watcherIds.has(v.ownerEnrollmentId)&&this.currentRecord(v,receiver)).sort((x,y)=>x.sequence-y.sequence);
      const rotated=[...all.filter(v=>v.sequence>(a[2] as number)),...all.filter(v=>v.sequence<=(a[2] as number))];
      const commands=rotated.slice(0,4).map(v=>({commandId:v.commandId,sequence:v.sequence,acceptedAt:v.acceptedAt,expiresAt:v.expiresAt,receiverPolicyDigest:v.receiverPolicyDigest,subscriptionGeneration:v.subscriptionGeneration,authorization:v.authorization,useSession:v.useSession,request:v.request}));
      kind='safety-round';payload={version:1,receiver,activationId:activation,pollRequestId:r.id,pollNonce:r.nonce,communityRevision:community.revision,watcherSetHash:safetyWatcherHash(community.id,m.enrollmentId,activation,digest,watchers),watchers,commands,nextSequence:commands.at(-1)?.sequence??a[2],issuedAt:now,expiresAt:now+90_000};
      demand(Buffer.byteLength(JSON.stringify(payload))<=32_000,'SAFETY_RESPONSE_TOO_LARGE');
    }else if(r.op==='screen-safety-state'){
      demand(a.length===3&&uuid(a[2]));const use=this.mobile(r,m,p);key=use.publicKey;
      const target=this.c.member(a[2]);demand(target.communityId===community.id,'OTHER_COMMUNITY');const receiver=this.receiver(target),saved=this.c.store.get<Receiver>('safety-receiver:'+target.enrollmentId);
      const matches=saved?.policyDigest===safetyPolicyDigest(receiver)&&saved.keyEpoch===target.keyEpoch;
      kind='safety-state';payload={version:1,receiver,activationId:matches?saved.activationId:null,state:matches&&this.c.pushConfigured&&saved.lastPollAt>=now-90_000?saved.state:null,lastPollAt:matches?saved.lastPollAt:null,issuedAt:now,expiresAt:now+90_000};
    }else if(r.op==='screen-safety-stop'){
      demand(a.length===5&&uuid(a[2])&&uuid(a[3]));demand(r.at<=now+5_000,'INVALID_SAFETY_STOP_TIME');const use=this.mobile(r,m,p);key=use.publicKey;
      const subscription=this.subscription(m,true);demand(subscription,'SAFETY_SUBSCRIPTION_REQUIRED');
      const target=this.c.member(a[2]);demand(target.communityId===community.id,'OTHER_COMMUNITY');const receiver=this.receiver(target),host=this.c.store.get<Receiver>('safety-receiver:'+target.enrollmentId),receiverDigest=safetyPolicyDigest(receiver);
      demand(host&&host.activationId===a[3]&&host.policyDigest===receiverDigest,'SAFETY_ACTIVATION_CHANGED');
      exact(a[4],['action','targetEnrollmentId','expectedSessionId']);const command=a[4];
      demand(command.action==='end'||command.action==='turnOff'||command.action==='revoke');
      if(command.action==='end'){demand(command.targetEnrollmentId===null&&uuid(command.expectedSessionId));demand(host.lastPollAt>=now-90_000&&host.state.power==='on'&&!host.state.held&&host.state.session?.channelId===command.expectedSessionId,'STALE_SAFETY_SESSION');}
      if(command.action==='turnOff')demand(command.targetEnrollmentId===null&&command.expectedSessionId===null);
      if(command.action==='revoke'){
        demand(uuid(command.targetEnrollmentId)&&command.expectedSessionId===null);const peer=this.c.member(command.targetEnrollmentId);
        demand(peer.communityId===community.id&&peer.enrollmentId!==target.enrollmentId,'OTHER_COMMUNITY');
      }
      const ids=this.ids(target.enrollmentId),records=ids.map(id=>this.getRecord(id)!);
      demand(records.filter(v=>!v.result&&v.expiresAt>now&&this.currentRecord(v,receiver)).length<32,'SAFETY_QUEUE_FULL');demand(ids.length<512,'SAFETY_RECEIPTS_FULL');
      const seq=(this.c.store.get<number>('safety-sequence:'+target.enrollmentId)??0)+1;demand(integer(seq));this.c.store.put('safety-sequence:'+target.enrollmentId,seq);
      const authorization=this.auth(m),record:StopRecord={commandId:r.id,sequence:seq,acceptedAt:now,expiresAt:Math.min(r.at,now)+(command.action==='end'?600_000:7*86400_000),receiverPolicyDigest:receiverDigest,subscriptionGeneration:subscription.generation,
        authorization:this.signed('authorization',r,authorization),useSession:this.signed('session',r,this.c.useSession(use,now)),request:{payload:r.bytes.toString('base64url'),signature:r.signature.toString('base64url')},
        receiverEnrollmentId:target.enrollmentId,activationId:a[3],ownerEnrollmentId:m.enrollmentId,ownerKeyEpoch:m.keyEpoch,ownerOperationKey:p.plan.operationKey,ownerPolicyDigest:safetyPolicyDigest(authorization),action:command.action,result:null};
      this.putRecord(record);this.c.store.put('safety-command-index:'+target.enrollmentId,[...ids,r.id]);kind='safety-result';payload=this.result(record,r.id,receiver);
    }else if(r.op==='screen-safety-result'){
      demand(a.length===3&&uuid(a[2]));const use=this.mobile(r,m,p);key=use.publicKey;const record=this.getRecord(a[2]);
      if(record)demand(record.ownerEnrollmentId===m.enrollmentId&&record.ownerKeyEpoch===m.keyEpoch&&record.ownerOperationKey===p.plan.operationKey,'OTHER_COMMAND_OWNER');
      let receiver:AccessAuthorization|undefined;if(record){try{receiver=this.receiver(this.c.member(record.receiverEnrollmentId));}catch{}}
      kind='safety-result';payload=this.result(record,a[2],receiver);
    }else{
      demand(r.op==='receiver-safety-event'&&a.length===5&&uuid(a[1])&&uuid(a[2])&&['connection','enrollment','security'].includes(a[3] as string)&&(a[4]===null||uuid(a[4])));
      key=m.hostKey;checkAccessProof(r,key);const receiver=this.receiver(m);
      if(a[4]!==null)demand(this.c.member(a[4]).communityId===community.id,'OTHER_COMMUNITY');
      const existing=this.c.store.get<EventRecord>('safety-event:'+a[2]);
      demand(!existing||(existing.communityId===community.id&&existing.receiverEnrollmentId===m.enrollmentId&&existing.activationId===a[1]&&existing.kind===a[3]&&existing.actorEnrollmentId===a[4]),'SAFETY_EVENT_ID_CONFLICT');
      const index='safety-events:'+m.enrollmentId,ids=(this.c.store.get<string[]>(index)??[]).filter(id=>{const v=this.c.store.get<EventRecord>('safety-event:'+id);return v&&v.expiresAt>now;});
      const coalesce='safety-event-coalesce:'+m.enrollmentId+':'+a[1]+':'+a[3]+':'+String(a[4]);const previous=this.c.store.get<number>(coalesce);
      const budgetKey='safety-event-rate:'+m.enrollmentId+':'+Math.floor(now/60_000),budget=this.c.store.get<number>(budgetKey)??0;
      let state:'queued'|'coalesced'|'not-configured'=!this.c.pushConfigured?'not-configured':existing||previous!==undefined&&previous>now-120_000||ids.length>=32||budget>=6?'coalesced':'queued';
      if(state==='queued'){
        this.c.store.put(budgetKey,budget+1,now+120_000);
        const event:EventRecord={eventId:a[2],communityId:community.id,receiverEnrollmentId:m.enrollmentId,receiverPolicyDigest:safetyPolicyDigest(receiver),activationId:a[1],kind:a[3] as EventRecord['kind'],actorEnrollmentId:a[4] as string|null,issuedAt:now,expiresAt:now+600_000};
        this.c.store.put('safety-event:'+event.eventId,event,event.expiresAt);this.c.store.put(index,[...ids,event.eventId]);this.c.store.put(coalesce,now,now+600_000);
        const queue=(this.c.store.get<string[]>('safety-event-queue')??[]).filter(id=>{const v=this.c.store.get<EventRecord>('safety-event:'+id);return v&&v.expiresAt>now;});
        demand(queue.length<128,'SAFETY_EVENT_QUEUE_FULL');this.c.store.put('safety-event-queue',[...queue,event.eventId]);
      }
      kind='safety-event';payload={version:1,eventId:a[2],state,issuedAt:now,expiresAt:now+90_000};
    }
    return {key,kind,payload};
  }
  private snapshot(value:unknown,community:Community):SafetySnapshot {
    exact(value,['power','held','session','observationSequence']);demand(integer(value.observationSequence)&&value.observationSequence>0&&['on','waiting','off'].includes(value.power as string)&&typeof value.held==='boolean');
    if(value.session!==null){exact(value.session,['channelId','controllerEnrollmentId','since']);demand(uuid(value.session.channelId)&&uuid(value.session.controllerEnrollmentId)&&integer(value.session.since)&&value.session.since<=this.c.now+5_000&&value.power==='on'&&!value.held);
      const controller=this.c.member(value.session.controllerEnrollmentId);demand(controller.communityId===community.id,'OTHER_COMMUNITY');demand(this.c.policy(controller).plan.capabilities.includes('screen.view'),'NOT_AUTHORIZED');}
    return value as unknown as SafetySnapshot;
  }
  private acceptResult(value:unknown,m:Member,community:Community,activation:string):void {
    exact(value,['payload','signature']);const bytes=b64(value.payload,2048),signature=b64(value.signature,86);demand(signature.length===64);
    let fields:unknown;try{fields=JSON.parse(bytes.toString('utf8'));}catch{demand(false);}
    demand(Array.isArray(fields)&&fields.length===7&&fields[0]===1&&fields[1]===community.id&&fields[2]===m.enrollmentId&&uuid(fields[3])&&uuid(fields[4])&&SAFETY_OUTCOMES.includes(fields[5] as never)&&integer(fields[6])&&fields[6]<=this.c.now+5_000,'INVALID_SAFETY_RESULT');
    demand(verify('sha256',Buffer.concat([SAFETY_RESULT_DOMAIN,bytes]),{key:publicKey(m.hostKey).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},signature),'INVALID_SAFETY_RESULT');
    const record=this.getRecord(fields[4]);demand(record,'SAFETY_COMMAND_UNKNOWN');
    demand(fields[6]>=record.acceptedAt-5_000&&fields[6]<=record.expiresAt+5_000,'INVALID_SAFETY_RESULT_TIME');
    demand(record.receiverEnrollmentId===m.enrollmentId&&record.activationId===fields[3],'OTHER_SAFETY_ACTIVATION');
    demand(!['ended','turned-off','revoked'].includes(fields[5])||({end:'ended',turnOff:'turned-off',revoke:'revoked'}[record.action]===fields[5]),'INVALID_SAFETY_RESULT');
    const envelope={payload:value.payload as string,signature:value.signature as string};
    if(record.result)demand(record.result.payload===envelope.payload&&record.result.signature===envelope.signature,'SAFETY_RESULT_CONFLICT');else{record.result=envelope;this.putRecord(record);}
  }
  takeNotifications(limit=4):SafetyNotification[]{
    demand(integer(limit)&&limit<=4);const jobs:SafetyNotification[]=[];
    for(const id of (this.c.store.get<string[]>('safety-event-queue')??[]).slice(-128)){
      const event=this.c.store.get<EventRecord>('safety-event:'+id);if(!event||event.expiresAt<=this.c.now)continue;
      for(const m of this.c.community(event.communityId).memberIds.flatMap(id=>{try{return [this.c.member(id)];}catch{return [];}})){
        if(jobs.length>=limit)return jobs;const subscription=this.subscription(m,true),claim='safety-event-claim:'+id+':'+m.enrollmentId;
        if(!subscription||this.c.store.get(claim))continue;this.c.store.put(claim,true,event.expiresAt);
        const bytes=Buffer.from(JSON.stringify([1,'screen-safety-notice',id,this.c.now,event.communityId,m.profileId,event.receiverEnrollmentId,event.activationId,event.kind,event.actorEnrollmentId,event.expiresAt]));
        // The separate event domain is not an enrollment or execution capability.
        jobs.push({...subscription,eventKind:event.kind,eventId:id,communityId:event.communityId,recipientId:m.enrollmentId,recipientKeyEpoch:m.keyEpoch,subscriptionGeneration:subscription.generation,expiresAt:event.expiresAt,notice:{payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([SAFETY_NOTICE_DOMAIN,bytes]),{key:this.c.issuer.export({format:'pem',type:'pkcs8'}),dsaEncoding:'ieee-p1363'}).toString('base64url')}});
      }
    }
    return jobs;
  }
  hasNotifications():boolean {
    for(const id of (this.c.store.get<string[]>('safety-event-queue')??[]).slice(-128)){
      const e=this.c.store.get<EventRecord>('safety-event:'+id);if(!e||e.expiresAt<=this.c.now)continue;
      const c=this.c.community(e.communityId);if(c.memberIds.some(id=>{try{return !!this.subscription(this.c.member(id),true)&&!this.c.store.get('safety-event-claim:'+e.eventId+':'+id);}catch{return false;}}))return true;
    }return false;
  }
  notificationCurrent(job:SafetyNotification):boolean {
    try{const event=this.c.store.get<EventRecord>('safety-event:'+job.eventId),m=this.c.member(job.recipientId),s=this.subscription(m,true),receiver=this.receiver(this.c.member(event?.receiverEnrollmentId));
      return !!event&&event.expiresAt>this.c.now&&event.communityId===job.communityId&&event.receiverPolicyDigest===safetyPolicyDigest(receiver)&&m.keyEpoch===job.recipientKeyEpoch&&!!s&&s.generation===job.subscriptionGeneration&&s.token===job.token&&s.topic===job.topic&&s.environment===job.environment;
    }catch{return false;}
  }
  removeDeadPush(job:Pick<SafetyNotification,'recipientId'|'subscriptionGeneration'|'token'|'topic'|'environment'>):void {
    const raw=this.c.store.get<string>('safety-subscription:'+job.recipientId);if(!raw)return;
    const current=openSealed<SafetySubscription>(raw,this.c.stateKey,'safety:'+job.recipientId);
    if(current.generation===job.subscriptionGeneration&&current.token===job.token&&current.topic===job.topic&&current.environment===job.environment)this.c.store.remove('safety-subscription:'+job.recipientId);
  }
}
