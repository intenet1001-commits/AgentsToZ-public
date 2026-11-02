import {createHash} from 'node:crypto';
import {CommunityAccessClient,CommunityAccessReply,CommunityRelayTicket,communityObject,communityBytes,communityBase64,
 type CommunityAccessEnvelope,type CommunityAccessRequest,type CommunityAccessFetch} from './communityAccessClient';

export type CommunityComponentPurpose='agent'|'teams';
export type CommunityComponentRole='sender'|'receiver';
export interface CommunityComponentAuthorizationBody {
 version:1;communityId:string;profileId:string;enrollmentId:string;deviceId:string;deviceKind:'desktop';name:string;
 hostPublicKey:string;publicKey:string;biometricPublicKey:string;controlKey:string;agentDeviceId:string;
 capabilities:readonly string[];revision:number;keyEpoch:number;issuedAt:number;expiresAt:number;
}
const capOrder=['screen.view','screen.control','screen.receive.view','screen.receive.control','agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'];
const capability=(purpose:CommunityComponentPurpose)=>purpose==='agent'?'agent.communicate':'teams.run';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const encoder=new TextEncoder();
const knownAuthorizations=new WeakSet<object>();
const bodyKeys=['version','communityId','profileId','enrollmentId','deviceId','deviceKind','name','hostPublicKey','publicKey','biometricPublicKey','controlKey','agentDeviceId','capabilities','revision','keyEpoch','issuedAt','expiresAt'];
function policyValues(b:CommunityComponentAuthorizationBody):unknown[]{return [b.version,b.communityId,b.profileId,b.enrollmentId,b.deviceId,b.agentDeviceId,b.deviceKind,b.name,b.hostPublicKey,b.publicKey,b.biometricPublicKey,b.controlKey,b.capabilities,b.revision,b.keyEpoch];}
export class CommunityComponentAuthorization {
 readonly policyDigest:string;
 private constructor(readonly body:Readonly<CommunityComponentAuthorizationBody>,readonly envelope:CommunityAccessEnvelope){
  this.policyDigest=createHash('sha256').update(JSON.stringify(policyValues(body))).digest('hex');knownAuthorizations.add(this);
 }
 static async fromReply(reply:CommunityAccessReply,profileId:string,deviceId?:string,now=Date.now()):Promise<CommunityComponentAuthorization>{
  if(!(reply instanceof CommunityAccessReply)||!['authorization','directory'].includes(reply.kind))throw Error('component authorization missing');
  const rows=reply.kind==='directory'?reply.payload:[reply.payload];if(!Array.isArray(rows)||!rows.length||rows.length>32)throw Error('invalid component directory');
  const selected=rows.filter(row=>!!row&&typeof row==='object'&&(!deviceId||(row as any).deviceId===deviceId));
  if(selected.length!==1)throw Error('component device ambiguous');
  const value=communityObject(selected[0],bodyKeys);
  const caps=value.capabilities;
  if(value.version!==1||value.deviceKind!=='desktop'||!['communityId','profileId','enrollmentId','deviceId','agentDeviceId'].every(k=>uuid(value[k]))
   ||value.profileId!==profileId||typeof value.name!=='string'||!value.name.trim()||value.name!==value.name.trim()||encoder.encode(value.name).length>120
   ||/[\p{Cc}\p{Cf}]/u.test(value.name)||!integer(value.revision)||value.revision<1||!integer(value.keyEpoch)||value.keyEpoch<1
   ||value.issuedAt!==reply.issuedAt||!integer(value.expiresAt)||value.expiresAt<=now||value.expiresAt>reply.issuedAt+90_000
   ||!Array.isArray(caps)||!caps.length||JSON.stringify(caps)!==JSON.stringify(capOrder.filter(c=>caps.includes(c))))throw Error('invalid component authorization');
  if(caps.includes('screen.control')&&!caps.includes('screen.view')||caps.includes('screen.receive.control')&&!caps.includes('screen.receive.view'))throw Error('invalid paired capability');
  const keys=['hostPublicKey','publicKey','biometricPublicKey','controlKey'].map(k=>value[k]);
  if(new Set(keys).size!==4)throw Error('duplicate component key');
  for(const key of keys){const bytes=communityBytes(key,65);if(bytes.length!==65||bytes[0]!==4)throw Error('invalid component public key');await crypto.subtle.importKey('raw',new Uint8Array(bytes),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}
  const body=Object.freeze({...value,capabilities:Object.freeze([...caps])}) as unknown as Readonly<CommunityComponentAuthorizationBody>;
  return new CommunityComponentAuthorization(body,Object.freeze({...reply.envelope}));
 }
 isCurrent(now=Date.now()){return knownAuthorizations.has(this)&&this.body.expiresAt>now&&this.body.issuedAt<=now+60_000;}
 permits(purpose:CommunityComponentPurpose,now=Date.now()){return this.isCurrent(now)&&this.body.capabilities.includes(capability(purpose));}
}
export function communityComponentCertificateHash(auth:CommunityComponentAuthorization):string{
 if(!knownAuthorizations.has(auth))throw Error('unverified component certificate');return auth.policyDigest;
}
export interface CommunityComponentHandshake {
 version:1;purpose:CommunityComponentPurpose;profileId:string;communityId:string;senderDeviceId:string;receiverDeviceId:string;
 senderAgentDeviceId:string;receiverAgentDeviceId:string;senderEnrollmentId:string;receiverEnrollmentId:string;
 senderCertificateHash:string;receiverCertificateHash:string;session:string;instance:string;receiverBootId:string;
 senderEphemeral:string;receiverEphemeral:string;senderNonce:string;receiverNonce:string;
}
export const COMMUNITY_COMPONENT_HANDSHAKE_FIELDS=['version','purpose','profileId','communityId','senderDeviceId','receiverDeviceId','senderAgentDeviceId','receiverAgentDeviceId','senderEnrollmentId','receiverEnrollmentId','senderCertificateHash','receiverCertificateHash','session','instance','receiverBootId','senderEphemeral','receiverEphemeral','senderNonce','receiverNonce'] as const;
export function communityComponentHandshakeBytes(t:CommunityComponentHandshake,role:CommunityComponentRole):Uint8Array{
 communityObject(t,COMMUNITY_COMPONENT_HANDSHAKE_FIELDS);
 if(t.version!==1||!['agent','teams'].includes(t.purpose)||!['sender','receiver'].includes(role))throw Error('invalid component transcript');
 for(const key of ['profileId','communityId','senderDeviceId','receiverDeviceId','senderAgentDeviceId','receiverAgentDeviceId','senderEnrollmentId','receiverEnrollmentId'] as const)if(!uuid(t[key]))throw Error('invalid transcript identity');
 if(t.senderDeviceId===t.receiverDeviceId||t.senderAgentDeviceId===t.receiverAgentDeviceId||t.senderEnrollmentId===t.receiverEnrollmentId)throw Error('reflected component identity');
 for(const key of ['senderCertificateHash','receiverCertificateHash'] as const)if(!/^[0-9a-f]{64}$/.test(t[key]))throw Error('invalid transcript digest');
 for(const key of ['session','instance','receiverBootId'] as const)if(!/^[0-9a-f]{32}$/.test(t[key]))throw Error('invalid transcript session');
 for(const key of ['senderEphemeral','receiverEphemeral'] as const)if(communityBytes(t[key],65).length!==65)throw Error('invalid ephemeral');
 for(const key of ['senderNonce','receiverNonce'] as const)if(communityBytes(t[key],32).length!==32)throw Error('invalid nonce');
 if(t.senderEphemeral===t.receiverEphemeral||t.senderNonce===t.receiverNonce)throw Error('reflected key');
 return encoder.encode('agentstoz.community-component.handshake/v1\0'+role+'\0'+JSON.stringify(COMMUNITY_COMPONENT_HANDSHAKE_FIELDS.map(k=>t[k])));
}
export async function verifyCommunityComponentHandshake(input:{transcript:CommunityComponentHandshake;sender:CommunityComponentAuthorization;receiver:CommunityComponentAuthorization;senderProof:string;receiverProof:string;now?:number}):Promise<boolean>{
 try{
  const {transcript:t,sender,receiver}=input,now=input.now??Date.now();
  if(!sender.permits(t.purpose,now)||!receiver.permits(t.purpose,now)||sender.body.profileId!==t.profileId||receiver.body.profileId!==t.profileId
   ||sender.body.communityId!==t.communityId||receiver.body.communityId!==t.communityId||sender.body.controlKey===receiver.body.controlKey)return false;
  for(const [role,auth,proof] of [['sender',sender,input.senderProof],['receiver',receiver,input.receiverProof]] as const){
   const b=auth.body;if(t[`${role}DeviceId`]!==b.deviceId||t[`${role}AgentDeviceId`]!==b.agentDeviceId||t[`${role}EnrollmentId`]!==b.enrollmentId||t[`${role}CertificateHash`]!==auth.policyDigest)return false;
   const key=await crypto.subtle.importKey('raw',new Uint8Array(communityBytes(b.controlKey,65)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,new Uint8Array(communityBytes(proof,64)),new Uint8Array(communityComponentHandshakeBytes(t,role))))return false;
  }return true;
 }catch{return false;}
}
export async function verifyCommunityComponentPeerProof(transcript:CommunityComponentHandshake,role:CommunityComponentRole,auth:CommunityComponentAuthorization,proof:string,now=Date.now()):Promise<boolean>{
 try{
  const b=auth.body;if(!auth.permits(transcript.purpose,now)||b.profileId!==transcript.profileId||b.communityId!==transcript.communityId
   ||transcript[`${role}DeviceId`]!==b.deviceId||transcript[`${role}AgentDeviceId`]!==b.agentDeviceId||transcript[`${role}EnrollmentId`]!==b.enrollmentId||transcript[`${role}CertificateHash`]!==auth.policyDigest)return false;
  const key=await crypto.subtle.importKey('raw',new Uint8Array(communityBytes(b.controlKey,65)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,new Uint8Array(communityBytes(proof,64)),new Uint8Array(communityComponentHandshakeBytes(transcript,role)));
 }catch{return false;}
}

export interface CommunityComponentContext {communityId:string;profileId:string;enrollmentId:string;deviceId:string;agentDeviceId:string;publicKey:string}
type MainLink={readonly verifiedMain:boolean;request(value:Record<string,unknown>):Promise<Record<string,unknown>>};
export class NativeCommunityComponentIdentity {
 private contextValue?:CommunityComponentContext;
 private authority?:{origin:string;issuerPublicKey:string;profileId:string};
 constructor(private readonly link:MainLink,private readonly fetcher:CommunityAccessFetch=(url,init)=>fetch(url,init),private readonly now=Date.now){}
 async relayOrigin():Promise<string>{await this.context();return this.authority!.origin;}
 private async invoke(value:Record<string,unknown>):Promise<Record<string,unknown>>{
  // Admission belongs to the one bounded shared Main link; do not hide an unbounded feature-specific queue here.
  if(!this.link.verifiedMain)throw Error('verified Main required');const result=await this.link.request(value);
  if(!this.link.verifiedMain||result.success!==true||result.halted!==false)throw Error('native component refused');return result;
 }
 async context():Promise<CommunityComponentContext>{
  const result=await this.invoke({operation:'community-component-context'});
  if(result.configured!==true||result.storeAvailable!==true||!result.authority||!result.binding)throw Error('component enrollment required');
  const a=communityObject(result.authority,['origin','issuerPublicKey','profileId']),b=result.binding as Record<string,unknown>;
  if(typeof a.origin!=='string'||!a.origin.startsWith('https://')||!uuid(a.profileId)||typeof a.issuerPublicKey!=='string'||b.localOff!==false
   ||!['communityId','profileId','enrollmentId','deviceId','agentDeviceId'].every(k=>uuid(b[k]))||b.profileId!==a.profileId||typeof b.controlKey!=='string')throw Error('invalid component context');
  const context={communityId:b.communityId,profileId:b.profileId,enrollmentId:b.enrollmentId,deviceId:b.deviceId,agentDeviceId:b.agentDeviceId,publicKey:b.controlKey} as CommunityComponentContext;
  if(this.contextValue&&JSON.stringify(this.contextValue)!==JSON.stringify(context))throw Error('component identity changed');
  this.contextValue=Object.freeze(context);this.authority={origin:a.origin,issuerPublicKey:a.issuerPublicKey,profileId:a.profileId};return this.contextValue;
 }
 private async exchange(purpose:CommunityComponentPurpose,operation:'component-status'|'component-directory'|'component-ticket',extra:unknown[]=[]):Promise<CommunityAccessReply>{
  const context=await this.context(),authority=this.authority!;
  const signer={publicKey:context.publicKey,signAccessRequest:async(request:Readonly<CommunityAccessRequest>)=>{
   const result=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'access',request}});
   if(result.publicKey!==context.publicKey||typeof result.payload!=='string'||typeof result.signature!=='string')throw Error('native signature invalid');return {payload:result.payload,signature:result.signature};
  }};
  const client=new CommunityAccessClient(authority.origin,authority.issuerPublicKey,signer,this.fetcher,this.now);
  return client.exchange({operation:operation as CommunityAccessRequest['operation'],requestId:crypto.randomUUID(),observedAt:this.now(),nonce:communityBase64(crypto.getRandomValues(new Uint8Array(32))),actor:context.enrollmentId,args:[context.communityId,...extra]});
 }
 async currentAuthorization(purpose:CommunityComponentPurpose):Promise<CommunityComponentAuthorization>{
  const reply=await this.exchange(purpose,'component-status'),context=this.contextValue!;
  const auth=await CommunityComponentAuthorization.fromReply(reply,context.profileId,context.deviceId,this.now());
  if(auth.body.controlKey!==context.publicKey||auth.body.agentDeviceId!==context.agentDeviceId||!auth.permits(purpose,this.now()))throw Error('component authorization mismatch');
  await this.invoke({operation:'community-component-refresh',requestId:reply.requestId,envelope:reply.envelope});return auth;
 }
 async directory(purpose:CommunityComponentPurpose):Promise<CommunityComponentAuthorization[]>{
  await this.currentAuthorization(purpose);const reply=await this.exchange(purpose,'component-directory'),context=this.contextValue!;
  if(reply.kind!=='directory'||!Array.isArray(reply.payload)||reply.payload.length>32)throw Error('component directory missing');
  const result:CommunityComponentAuthorization[]=[];
  for(const value of reply.payload){if((value as any)?.deviceKind!=='desktop'||!(value as any)?.capabilities?.includes(capability(purpose)))continue;
   const auth=await CommunityComponentAuthorization.fromReply(reply,context.profileId,(value as any).deviceId,this.now());if(auth.body.communityId!==context.communityId)throw Error('different community');result.push(auth);}
  if(new Set(result.map(a=>a.body.agentDeviceId)).size!==result.length)throw Error('ambiguous agent mapping');return result;
 }
 async ticket(purpose:CommunityComponentPurpose,connectionId:string,role:'host'|'client'):Promise<CommunityRelayTicket>{
  await this.currentAuthorization(purpose);const reply=await this.exchange(purpose,'component-ticket',[purpose,connectionId,role]),c=this.contextValue!;
  return CommunityRelayTicket.fromReply(reply,{communityId:c.communityId,enrollmentId:c.enrollmentId,deviceId:c.deviceId,connectionId,publicKey:c.publicKey,purpose,role,sessionId:null},this.now());
 }
 async signRelayProof(purpose:CommunityComponentPurpose,ticket:CommunityRelayTicket,challenge:string):Promise<Uint8Array>{
  const context=await this.context(),result=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'relay-bind',ticket:ticket.envelope,challenge}});
  if(result.publicKey!==context.publicKey)throw Error('component key changed');const bytes=communityBytes(result.signature,64);if(bytes.length!==64)throw Error('signature missing');return bytes;
 }
 async signHandshake(purpose:CommunityComponentPurpose,role:CommunityComponentRole,transcript:CommunityComponentHandshake,ownAuthorization:CommunityComponentAuthorization,peerAuthorization:CommunityComponentAuthorization):Promise<Uint8Array>{
  communityComponentHandshakeBytes(transcript,role);const context=await this.context();
  const result=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'handshake',role,transcript,ownAuthorization:ownAuthorization.envelope,peerAuthorization:peerAuthorization.envelope}});
  if(result.publicKey!==context.publicKey)throw Error('component key changed');const proof=communityBytes(result.signature,64);if(proof.length!==64)throw Error('signature missing');return proof;
 }
 async verifyAuthorization(envelope:CommunityAccessEnvelope,deviceId?:string):Promise<CommunityComponentAuthorization>{
  await this.context();const raw=JSON.parse(new TextDecoder().decode(communityBytes(envelope.payload,48_000)));
  if(!Array.isArray(raw)||typeof raw[2]!=='string')throw Error('invalid peer envelope');
  const reply=await CommunityAccessReply.verify(envelope,this.authority!.issuerPublicKey,raw[2],this.now());
  return CommunityComponentAuthorization.fromReply(reply,this.authority!.profileId,deviceId,this.now());
 }
}
