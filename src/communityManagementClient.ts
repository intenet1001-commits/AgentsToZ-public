import {CommunityAccessClientError,CommunityAccessReply,communityAuthority,communityBytes,communityId,communityObject,type CommunityAccessEnvelope} from './communityAccessClient';

export interface CommunityManagementAuthority {origin:string;issuerPublicKey:string;profileId:string}
export interface CommunityManagementPlan {
  version:1;profileId:string;deviceId:string;name:string;kind:'mobile';hostKey:string;biometricKey:string;operationKey:string;controlKey:null;agentDeviceId:null;capabilities:readonly string[];
}
export interface CommunityManagementIntent {
  version:1;communityId:string;targetEnrollmentId:string|null;targetKeyEpoch:number;previousAdministrator:boolean;administrator:boolean;issuedAt:number;nonce:string;digest:string;
}
export interface CommunityManagementReviewBody {
  admin:string;planId:string;digest:string;revision:number;challenge:string;expiresAt:number;plan:Readonly<CommunityManagementPlan>;management:Readonly<CommunityManagementIntent>;
}
export interface CommunityManagementActor {communityId:string;enrollmentId:string;deviceId:string;hostPublicKey:string;biometricPublicKey:string}
export interface CommunityAccessNoticeBody {planId:string;issuedAt:number;communityId:string;profileId:string;digest:string;expiresAt:number}
const encoder=new TextEncoder(),TOKEN=Symbol(),verified=new WeakSet<CommunityManagementReview>();
const caps=['screen.view','screen.control','agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'];
const fail=():never=>{throw new CommunityAccessClientError('INVALID_MANAGEMENT_REVIEW');};
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const id=(v:unknown):v is string=>communityId(v)&&v===v.toLowerCase();
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
async function point(v:unknown):Promise<string>{
  if(typeof v!=='string')return fail();const b=communityBytes(v,65);if(b.length!==65||b[0]!==4)return fail();
  try{await crypto.subtle.importKey('raw',new Uint8Array(b).buffer,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{return fail();}return v;
}
function input(domain:string,body:Uint8Array):Uint8Array {const head=encoder.encode(domain),result=new Uint8Array(head.length+body.length);result.set(head);result.set(body,head.length);return result;}
async function hash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),v=>v.toString(16).padStart(2,'0')).join('');}
async function authority(a:CommunityManagementAuthority):Promise<void>{if(communityAuthority(a.origin).origin!==a.origin||!id(a.profileId))return fail();await point(a.issuerPublicKey);}
async function plan(value:unknown,profileId:string):Promise<Readonly<CommunityManagementPlan>>{
  const p=communityObject(value,['version','profileId','deviceId','name','kind','hostKey','biometricKey','operationKey','controlKey','agentDeviceId','capabilities']);
  if(p.version!==1||p.profileId!==profileId||!id(p.deviceId)||p.kind!=='mobile'||p.controlKey!==null||p.agentDeviceId!==null||typeof p.name!=='string'||!p.name||p.name.trim()!==p.name||encoder.encode(p.name).length>120||/[\p{Cc}\p{Cf}]/u.test(p.name))return fail();
  const keys=await Promise.all([point(p.hostKey),point(p.biometricKey),point(p.operationKey)]);if(new Set(keys).size!==3)return fail();
  if(!Array.isArray(p.capabilities))return fail();const selected:unknown[]=p.capabilities;
  if(!selected.length||new Set(selected).size!==selected.length||!selected.every(v=>typeof v==='string'&&caps.includes(v))||JSON.stringify(selected)!==JSON.stringify(caps.filter(c=>selected.includes(c)))||selected.includes('screen.control')&&!selected.includes('screen.view'))return fail();
  return Object.freeze({...p,capabilities:Object.freeze([...selected])}) as unknown as Readonly<CommunityManagementPlan>;
}
export function communityManagementBytes(r:CommunityManagementReviewBody):Uint8Array {
  const p=r.plan,m=r.management;
  return input('agentstoz.community-access.management/v1\0',encoder.encode(JSON.stringify([m.version,m.communityId,r.admin,r.planId,r.digest,p.deviceId,p.hostKey,p.biometricKey,p.operationKey,p.controlKey,p.agentDeviceId,r.revision,m.targetEnrollmentId,m.targetKeyEpoch,m.previousAdministrator,m.administrator,r.challenge,m.issuedAt,r.expiresAt,m.nonce])));
}
/** Only a pinned issuer response can produce an approval intent. This class owns no signing key. */
export class CommunityManagementReview {
  private constructor(token:typeof TOKEN,readonly body:Readonly<CommunityManagementReviewBody>,readonly envelope:CommunityAccessEnvelope){if(token!==TOKEN)return fail();}
  static isVerified(value:CommunityManagementReview):boolean{return verified.has(value);}
  static async fromReply(reply:CommunityAccessReply,a:CommunityManagementAuthority,own:CommunityManagementActor,now=Date.now()):Promise<CommunityManagementReview>{
    if(!CommunityAccessReply.isVerified(reply)||reply.kind!=='management-review'||!reply.requestId)return fail();await authority(a);
    // A WeakSet response verified for a different issuer is not a trust root.
    const pinned=await CommunityAccessReply.verify(reply.envelope,a.issuerPublicKey,reply.requestId,now);
    const raw=communityObject(pinned.payload,['admin','planId','digest','revision','challenge','expiresAt','plan','management']);
    const p=await plan(raw.plan,a.profileId),m=communityObject(raw.management,['version','communityId','targetEnrollmentId','targetKeyEpoch','previousAdministrator','administrator','issuedAt','nonce','digest']);
    if(!id(own.communityId)||!id(own.enrollmentId)||!id(own.deviceId)||raw.admin!==own.enrollmentId||!id(raw.planId)||!digest(raw.digest)||!integer(raw.revision)||raw.revision<1||!integer(raw.expiresAt)||raw.expiresAt<=now||raw.expiresAt>pinned.issuedAt+120_000||communityBytes(raw.challenge,32).length!==32)return fail();
    await Promise.all([point(own.hostPublicKey),point(own.biometricPublicKey)]);
    if(m.version!==1||m.communityId!==own.communityId||!(m.targetEnrollmentId===null||id(m.targetEnrollmentId))||!integer(m.targetKeyEpoch)||m.targetKeyEpoch<1||typeof m.previousAdministrator!=='boolean'||typeof m.administrator!=='boolean'||m.previousAdministrator===m.administrator||m.issuedAt!==pinned.issuedAt||communityBytes(m.nonce,32).length!==32||!digest(m.digest))return fail();
    if(m.targetEnrollmentId===own.enrollmentId||p.deviceId===own.deviceId||[p.hostKey,p.biometricKey].some(k=>k===own.hostPublicKey||k===own.biometricPublicKey)||m.targetEnrollmentId===null&&(m.previousAdministrator||!m.administrator||m.targetKeyEpoch!==1))return fail();
    const planHash=await hash(encoder.encode(JSON.stringify([p.version,p.profileId,p.deviceId,p.name,p.kind,p.hostKey,p.biometricKey,p.operationKey,p.controlKey,p.agentDeviceId,p.capabilities])));if(planHash!==raw.digest)return fail();
    const body=Object.freeze({...raw,plan:p,management:Object.freeze({...m})}) as unknown as Readonly<CommunityManagementReviewBody>;
    if(await hash(communityManagementBytes(body))!==m.digest)return fail();
    const result=new CommunityManagementReview(TOKEN,body,Object.freeze({...pinned.envelope}));verified.add(result);return Object.freeze(result);
  }
  approvalArguments():readonly [string,string,string,string,number,string]{
    if(!verified.has(this))return fail();const r=this.body;return Object.freeze([r.management.communityId,r.planId,r.digest,r.challenge,r.revision,r.management.digest] as const);
  }
}
/** Routing does not verify a signature. Unknown/new versions are refused rather than sent to legacy review. */
export function communityEnrollmentNoticeRoute(value:CommunityAccessEnvelope):'legacy'|'access'{
  const bytes=communityBytes(value.payload,1024);let v:unknown;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
  if(!Array.isArray(v)||v.length!==8)return fail();if(v[0]===1&&v[1]==='enrollment-notice')return 'legacy';if(v[0]===2&&v[1]==='access-enrollment-notice')return 'access';return fail();
}
export async function verifyCommunityAccessNotice(value:CommunityAccessEnvelope,a:CommunityManagementAuthority,community:string,now=Date.now()):Promise<Readonly<CommunityAccessNoticeBody>>{
  await authority(a);if(!id(community)||communityEnrollmentNoticeRoute(value)!=='access')return fail();
  const wrapped=communityObject(value,['payload','signature']),bytes=communityBytes(wrapped.payload,1024),signature=communityBytes(wrapped.signature,64);if(signature.length!==64)return fail();
  const key=await crypto.subtle.importKey('raw',new Uint8Array(communityBytes(a.issuerPublicKey,65)).buffer,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,new Uint8Array(signature).buffer,new Uint8Array(input('agentstoz.community-access.notice/v2\0',bytes)).buffer))return fail();
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown[];
  if(!id(v[2])||!integer(v[3])||v[3]>now+5_000||v[4]!==community||v[5]!==a.profileId||!digest(v[6])||!integer(v[7])||v[7]<=now||v[7]<=v[3]||v[7]>v[3]+600_000)return fail();
  return Object.freeze({planId:v[2],issuedAt:v[3],communityId:community,profileId:a.profileId,digest:v[6],expiresAt:v[7]});
}
