import {createHash} from 'node:crypto';
import {CommunityAccessReply,COMMUNITY_MOBILE_RELAY_PURPOSES,communityBytes,communityObject,
  type CommunityAccessEnvelope,type CommunityMobileRelayPurpose} from './communityAccessClient';

export interface CommunityMobileAuthority {origin:string;issuerPublicKey:string;profileId:string}
export const COMMUNITY_MOBILE_CAPABILITY_ORDER=['screen.view','screen.control','screen.receive.view','screen.receive.control',
  'agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser','screen.desktop-trust','screen.owner-delegation'] as const;
export type CommunityMobileCapability=typeof COMMUNITY_MOBILE_CAPABILITY_ORDER[number];
export interface CommunityDeviceAuthorizationBody {
  version:1;communityId:string;profileId:string;enrollmentId:string;deviceId:string;deviceKind:'desktop'|'mobile';name:string;
  hostPublicKey:string;publicKey:string;biometricPublicKey:string;controlKey:string|null;agentDeviceId:string|null;
  capabilities:readonly CommunityMobileCapability[];revision:number;keyEpoch:number;issuedAt:number;expiresAt:number;
}
export interface CommunityMobileUseSessionBody {
  version:1;communityId:string;enrollmentId:string;sessionId:string;publicKey:string;capabilities:readonly CommunityMobileCapability[];
  revision:number;sequence:number;lastHumanAt:number;idleExpiresAt:number;issuedAt:number;expiresAt:number;
}
export interface CommunityDeviceAuthorizationExpectation {
  communityId:string;deviceId:string;deviceKind:'desktop'|'mobile';enrollmentId?:string;revision?:number;
  policyDigest?:string;purpose?:CommunityMobileRelayPurpose;
}
export interface CommunityMobileUseSessionExpectation {sessionId:string;purpose?:CommunityMobileRelayPurpose}
export class CommunityMobilePrincipalError extends Error {
  constructor(readonly code:string){super(code);this.name='CommunityMobilePrincipalError';}
}
const fail=(code:string):never=>{throw new CommunityMobilePrincipalError(code);};
const TOKEN=Symbol('issuer-verified-mobile-principal');
const knownAuthorizations=new WeakSet<object>(),knownSessions=new WeakSet<object>();
const pinnedReplies=new WeakMap<CommunityAccessReply,string>();
const AUTH_KEYS=['version','communityId','profileId','enrollmentId','deviceId','deviceKind','name','hostPublicKey','publicKey','biometricPublicKey','controlKey','agentDeviceId','capabilities','revision','keyEpoch','issuedAt','expiresAt'];
const USE_KEYS=['version','communityId','enrollmentId','sessionId','publicKey','capabilities','revision','sequence','lastHumanAt','idleExpiresAt','issuedAt','expiresAt'];
const MAX_LEASE_MS=90_000,IDLE_MS=3_600_000,FUTURE_SKEW_MS=5_000;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const digest=(prefix:string,values:readonly unknown[])=>createHash('sha256').update(prefix,'utf8').update(JSON.stringify(values),'utf8').digest('hex');
const requiredCapability=(purpose:CommunityMobileRelayPurpose):CommunityMobileCapability=>{
  switch(purpose){case 'mobile-agent':return 'agent.communicate';case 'mobile-teams':return 'teams.run';
    case 'mobile-agent-settings':return 'computer-use.agent-settings';case 'mobile-browser':return 'computer-use.browser';default:return fail('INVALID_PURPOSE');}
};
function checkPurpose(purpose:unknown):asserts purpose is CommunityMobileRelayPurpose {
  if(!COMMUNITY_MOBILE_RELAY_PURPOSES.includes(purpose as CommunityMobileRelayPurpose))fail('INVALID_PURPOSE');
}
function caps(value:unknown,mobile:boolean):readonly CommunityMobileCapability[]{
  if(!Array.isArray(value)||value.length===0||value.length>COMMUNITY_MOBILE_CAPABILITY_ORDER.length
    ||JSON.stringify(value)!==JSON.stringify(COMMUNITY_MOBILE_CAPABILITY_ORDER.filter(c=>value.includes(c))))return fail('INVALID_CAPABILITIES');
  if(mobile&&value.some(c=>c==='screen.receive.view'||c==='screen.receive.control'||c==='screen.desktop-trust'||c==='screen.owner-delegation')
    ||value.includes('screen.owner-delegation')&&(!value.includes('screen.desktop-trust')||!value.includes('screen.receive.control')||!value.includes('screen.receive.view'))
    ||value.includes('screen.desktop-trust')&&!value.includes('screen.view')&&!value.includes('screen.receive.view')
    ||value.includes('screen.control')&&!value.includes('screen.view')||value.includes('screen.receive.control')&&!value.includes('screen.receive.view'))return fail('INVALID_CAPABILITIES');
  return Object.freeze([...value]) as readonly CommunityMobileCapability[];
}
async function publicKey(value:unknown):Promise<string>{
  try{
    const bytes=communityBytes(value,65);if(bytes.length!==65||bytes[0]!==4)return fail('INVALID_PUBLIC_KEY');
    await crypto.subtle.importKey('raw',new Uint8Array(bytes),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    return value as string;
  }catch{return fail('INVALID_PUBLIC_KEY');}
}
function authority(value:CommunityMobileAuthority):Readonly<CommunityMobileAuthority>{
  const v=communityObject({...value},['origin','issuerPublicKey','profileId']);
  if(typeof v.origin!=='string'||typeof v.issuerPublicKey!=='string'||!uuid(v.profileId))return fail('INVALID_AUTHORITY');
  let url:URL;try{url=new URL(v.origin);}catch{return fail('INVALID_AUTHORITY');}
  // Native supplies the sealed authority. Do not silently canonicalize a body/URL-selected substitute.
  if(url.protocol!=='https:'||url.origin!==v.origin||url.pathname!=='/'||url.username||url.password||url.port||url.search||url.hash
    ||!url.hostname.endsWith('.workers.dev'))return fail('INVALID_AUTHORITY');
  return Object.freeze({origin:v.origin,issuerPublicKey:v.issuerPublicKey,profileId:v.profileId});
}
function clock(now:number):void{if(!integer(now))fail('INVALID_CLOCK');}
function current(issuedAt:number,expiresAt:number,now:number):boolean {
  return integer(now)&&issuedAt<=now+FUTURE_SKEW_MS&&expiresAt>now&&expiresAt>issuedAt&&expiresAt<=issuedAt+MAX_LEASE_MS;
}
async function pinned(reply:CommunityAccessReply,a:Readonly<CommunityMobileAuthority>):Promise<void>{
  if(!CommunityAccessReply.isVerified(reply))fail('UNVERIFIED_REPLY');
  const requestId=reply.requestId;if(requestId===null||!uuid(requestId))return fail('UNVERIFIED_REPLY');
  const pin=a.origin+'\0'+a.issuerPublicKey+'\0'+a.profileId;if(pinnedReplies.get(reply)===pin)return;
  // The SDK WeakSet proves a signature was checked, but it does not expose which issuer was used.
  // Verify at the signed issuance time; each principal independently checks its actual 90-second lease below.
  await publicKey(a.issuerPublicKey);
  await CommunityAccessReply.verify(reply.envelope,a.issuerPublicKey,requestId,reply.issuedAt);
  pinnedReplies.set(reply,pin);
}
/** Validate an envelope forwarded in a hello. The authority must come from the sealed native context, never the peer body. */
export async function verifyCommunityMobileAccessEnvelope(value:unknown,configured:CommunityMobileAuthority,expectedRequestId?:string,now=Date.now()):Promise<CommunityAccessReply>{
  clock(now);const a=authority(configured),wrapped=communityObject(value,['payload','signature']);
  if(typeof wrapped.payload!=='string'||typeof wrapped.signature!=='string')return fail('UNVERIFIED_REPLY');
  let fields:unknown;try{fields=JSON.parse(decoder.decode(communityBytes(wrapped.payload,48_000)));}catch{return fail('UNVERIFIED_REPLY');}
  if(!Array.isArray(fields)||fields.length!==5||fields[0]!==2||!['authorization','directory','session'].includes(fields[1])
    ||!uuid(fields[2])||!integer(fields[3])||fields[3]>now+FUTURE_SKEW_MS||fields[3]<now-MAX_LEASE_MS
    ||expectedRequestId!==undefined&&fields[2]!==expectedRequestId)return fail('UNVERIFIED_REPLY');
  const reply=await CommunityAccessReply.verify({payload:wrapped.payload,signature:wrapped.signature},a.issuerPublicKey,fields[2],fields[3]);
  pinnedReplies.set(reply,a.origin+'\0'+a.issuerPublicKey+'\0'+a.profileId);return reply;
}
function expectation(value:CommunityDeviceAuthorizationExpectation):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||!['communityId','deviceId','deviceKind'].every(k=>Object.hasOwn(value,k))
    ||Object.keys(value).some(k=>!['communityId','deviceId','deviceKind','enrollmentId','revision','policyDigest','purpose'].includes(k))
    ||!uuid(value.communityId)||!uuid(value.deviceId)||!['mobile','desktop'].includes(value.deviceKind)
    ||value.enrollmentId!==undefined&&!uuid(value.enrollmentId)||value.revision!==undefined&&(!integer(value.revision)||value.revision<1)
    ||value.policyDigest!==undefined&&!/^[0-9a-f]{64}$/.test(value.policyDigest))fail('WRONG_PRINCIPAL');
  if(value.purpose!==undefined)checkPurpose(value.purpose);
}
/** An issuer credential is immutable and branded; a class prototype or a caller Boolean cannot create authority. */
export class CommunityDeviceAuthorization {
  readonly policyDigest:string;readonly receiptOwnerHash:string;
  private constructor(token:typeof TOKEN,readonly body:Readonly<CommunityDeviceAuthorizationBody>,readonly envelope:Readonly<CommunityAccessEnvelope>,readonly authority:Readonly<CommunityMobileAuthority>){
    if(token!==TOKEN)fail('UNVERIFIED_PRINCIPAL');
    const b=body;
    this.policyDigest=digest('',[b.version,b.communityId,b.profileId,b.enrollmentId,b.deviceId,b.agentDeviceId,b.deviceKind,b.name,b.hostPublicKey,b.publicKey,b.biometricPublicKey,b.controlKey,b.capabilities,b.revision,b.keyEpoch]);
    this.receiptOwnerHash=digest('agentstoz.community-mobile-control/receipt-owner/v2\0',[b.profileId,b.communityId,b.enrollmentId,b.deviceId,b.keyEpoch,b.publicKey]);
    knownAuthorizations.add(this);Object.freeze(this);
  }
  static isVerified(value:unknown):value is CommunityDeviceAuthorization{return !!value&&typeof value==='object'&&knownAuthorizations.has(value);}
  static async fromEnvelope(envelope:unknown,configured:CommunityMobileAuthority,expected:CommunityDeviceAuthorizationExpectation,now=Date.now()):Promise<CommunityDeviceAuthorization>{
    return this.fromReply(await verifyCommunityMobileAccessEnvelope(envelope,configured,undefined,now),configured,expected,now);
  }
  static async fromReply(reply:CommunityAccessReply,configured:CommunityMobileAuthority,expected:CommunityDeviceAuthorizationExpectation,now=Date.now()):Promise<CommunityDeviceAuthorization>{
    clock(now);expected=Object.freeze({...expected});expectation(expected);const a=authority(configured);await pinned(reply,a);
    if(!['authorization','directory'].includes(reply.kind))return fail('INVALID_AUTHORIZATION');
    const values=reply.kind==='directory'?reply.payload:[reply.payload];if(!Array.isArray(values)||values.length<1||values.length>32)return fail('INVALID_AUTHORIZATION');
    // Validate every row's shape and subject namespace before selecting a directory row.
    const seenDevice=new Set<string>(),seenEnrollment=new Set<string>(),seenOperation=new Set<string>();
    let selected:Readonly<CommunityDeviceAuthorizationBody>|undefined;
    for(const raw of values){
      const v=communityObject(raw,AUTH_KEYS);
      if(v.version!==1||!['communityId','profileId','enrollmentId','deviceId'].every(k=>uuid(v[k]))||v.profileId!==a.profileId||v.communityId!==expected.communityId
        ||!['mobile','desktop'].includes(v.deviceKind as string)||typeof v.name!=='string'||!v.name.trim()||v.name!==v.name.trim()||encoder.encode(v.name).length>120
        ||/[\p{Cc}\p{Cf}]/u.test(v.name)||decoder.decode(encoder.encode(v.name))!==v.name
        ||!integer(v.revision)||v.revision<1||!integer(v.keyEpoch)||v.keyEpoch<1||v.issuedAt!==reply.issuedAt||!integer(v.issuedAt)||!integer(v.expiresAt)
        ||!current(v.issuedAt,v.expiresAt,now))return fail('INVALID_AUTHORIZATION');
      const mobile=v.deviceKind==='mobile',normalized=caps(v.capabilities,mobile);
      if(mobile&&(v.controlKey!==null||v.agentDeviceId!==null)||!mobile&&(v.controlKey!==null&&typeof v.controlKey!=='string'||v.agentDeviceId!==null&&!uuid(v.agentDeviceId)
        ||normalized.some(c=>c==='agent.communicate'||c==='teams.run')&&!uuid(v.agentDeviceId)
        ||normalized.some(c=>c==='agent.communicate'||c==='teams.run'||c==='computer-use.agent-settings'||c==='computer-use.browser')&&v.controlKey===null))return fail('INVALID_AUTHORIZATION');
      const keys=[await publicKey(v.hostPublicKey),await publicKey(v.publicKey),await publicKey(v.biometricPublicKey)];
      if(v.controlKey!==null)keys.push(await publicKey(v.controlKey));if(new Set(keys).size!==keys.length)return fail('INVALID_PUBLIC_KEY');
      if(seenDevice.has(v.deviceId as string)||seenEnrollment.has(v.enrollmentId as string)||seenOperation.has(v.publicKey as string))return fail('INVALID_AUTHORIZATION');
      seenDevice.add(v.deviceId as string);seenEnrollment.add(v.enrollmentId as string);seenOperation.add(v.publicKey as string);
      if(v.deviceId===expected.deviceId){
        if(!mobile&&v.controlKey===null||v.deviceKind!==expected.deviceKind||expected.enrollmentId!==undefined&&v.enrollmentId!==expected.enrollmentId||expected.revision!==undefined&&v.revision!==expected.revision)return fail('WRONG_PRINCIPAL');
        selected=Object.freeze({...v,capabilities:normalized}) as unknown as Readonly<CommunityDeviceAuthorizationBody>;
      }
    }
    if(!selected)return fail('WRONG_PRINCIPAL');
    const result=new CommunityDeviceAuthorization(TOKEN,selected,Object.freeze({...reply.envelope}),a);
    if(expected.policyDigest!==undefined&&result.policyDigest!==expected.policyDigest)return fail('WRONG_PRINCIPAL');
    if(expected.purpose!==undefined&&!result.permits(expected.purpose,now))return fail('CAPABILITY_DENIED');return result;
  }
  /** Lease freshness only. Revocation/episode replacement also requires the receiver's fresh typed CF lookup. */
  isCurrent(now=Date.now()):boolean{return CommunityDeviceAuthorization.isVerified(this)&&current(this.body.issuedAt,this.body.expiresAt,now);}
  permits(purpose:CommunityMobileRelayPurpose,now=Date.now()):boolean{return COMMUNITY_MOBILE_RELAY_PURPOSES.includes(purpose)&&this.isCurrent(now)&&this.body.capabilities.includes(requiredCapability(purpose));}
}

/** The RAM episode key authorizes execution; the operation-key owner hash separately owns receipts across episodes. */
export class CommunityMobileUseSession {
  readonly policyDigest:string;readonly receiptOwnerHash:string;
  private constructor(token:typeof TOKEN,readonly body:Readonly<CommunityMobileUseSessionBody>,readonly envelope:Readonly<CommunityAccessEnvelope>,readonly authorization:CommunityDeviceAuthorization){
    if(token!==TOKEN)fail('UNVERIFIED_PRINCIPAL');const b=authorization.body,a=authorization.authority,u=body;
    this.policyDigest=digest('agentstoz.community-mobile-control/use-policy/v2\0',[u.version,a.origin,a.issuerPublicKey,b.profileId,b.communityId,b.enrollmentId,b.deviceId,b.revision,b.keyEpoch,u.sessionId,u.publicKey,u.capabilities,IDLE_MS]);
    this.receiptOwnerHash=authorization.receiptOwnerHash;knownSessions.add(this);Object.freeze(this);
  }
  get authority():Readonly<CommunityMobileAuthority>{return this.authorization.authority;}
  static isVerified(value:unknown):value is CommunityMobileUseSession{return !!value&&typeof value==='object'&&knownSessions.has(value);}
  static async fromEnvelope(envelope:unknown,authorization:CommunityDeviceAuthorization,expected:CommunityMobileUseSessionExpectation,now=Date.now()):Promise<CommunityMobileUseSession>{
    if(!CommunityDeviceAuthorization.isVerified(authorization))return fail('UNVERIFIED_PRINCIPAL');
    return this.fromReply(await verifyCommunityMobileAccessEnvelope(envelope,authorization.authority,undefined,now),authorization,expected,now);
  }
  static async fromReply(reply:CommunityAccessReply,authorization:CommunityDeviceAuthorization,expected:CommunityMobileUseSessionExpectation,now=Date.now()):Promise<CommunityMobileUseSession>{
    clock(now);expected=Object.freeze({...expected});if(!CommunityDeviceAuthorization.isVerified(authorization)||!authorization.isCurrent(now)||authorization.body.deviceKind!=='mobile')return fail('UNVERIFIED_PRINCIPAL');
    if(!expected||typeof expected!=='object'||Array.isArray(expected)||!Object.hasOwn(expected,'sessionId')||!uuid(expected.sessionId)||Object.keys(expected).some(k=>!['sessionId','purpose'].includes(k)))return fail('WRONG_PRINCIPAL');
    if(expected.purpose!==undefined)checkPurpose(expected.purpose);await pinned(reply,authorization.authority);if(reply.kind!=='session')return fail('INVALID_USE_SESSION');
    const v=communityObject(reply.payload,USE_KEYS),b=authorization.body;
    if(v.version!==1||v.communityId!==b.communityId||v.enrollmentId!==b.enrollmentId||v.revision!==b.revision||!uuid(v.sessionId)||v.sessionId!==expected.sessionId
      ||!integer(v.sequence)||!integer(v.lastHumanAt)||!integer(v.idleExpiresAt)||v.issuedAt!==reply.issuedAt||!integer(v.issuedAt)||!integer(v.expiresAt)
      ||v.lastHumanAt>v.issuedAt||v.idleExpiresAt<=v.lastHumanAt||v.idleExpiresAt>v.lastHumanAt+IDLE_MS
      ||v.expiresAt>v.idleExpiresAt||!current(v.issuedAt,v.expiresAt,now))return fail('INVALID_USE_SESSION');
    const normalized=caps(v.capabilities,true);if(!normalized.every(c=>b.capabilities.includes(c)))return fail('CAPABILITY_DENIED');
    const key=await publicKey(v.publicKey);if([b.hostPublicKey,b.publicKey,b.biometricPublicKey].includes(key))return fail('INVALID_PUBLIC_KEY');
    const result=new CommunityMobileUseSession(TOKEN,Object.freeze({...v,capabilities:normalized}) as unknown as Readonly<CommunityMobileUseSessionBody>,Object.freeze({...reply.envelope}),authorization);
    if(expected.purpose!==undefined&&!result.permits(expected.purpose,now))return fail('CAPABILITY_DENIED');return result;
  }
  isCurrent(now=Date.now()):boolean{return CommunityMobileUseSession.isVerified(this)&&this.authorization.isCurrent(now)&&current(this.body.issuedAt,this.body.expiresAt,now)&&this.body.idleExpiresAt>now;}
  permits(purpose:CommunityMobileRelayPurpose,now=Date.now()):boolean{return COMMUNITY_MOBILE_RELAY_PURPOSES.includes(purpose)&&this.isCurrent(now)&&this.authorization.permits(purpose,now)&&this.body.capabilities.includes(requiredCapability(purpose));}
}
