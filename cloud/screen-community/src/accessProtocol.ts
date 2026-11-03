import {randomBytes,sign,verify,type KeyObject} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {b64,demand,publicKey,uuid,integer,name,Fault} from './protocol';

export const ACCESS_REQUEST_DOMAIN=Buffer.from('agentstoz.community-access.request/v2\0');
export const ACCESS_RESPONSE_DOMAIN=Buffer.from('agentstoz.community-access.response/v2\0');
export const ACCESS_NOTICE_DOMAIN=Buffer.from('agentstoz.community-access.notice/v2\0');
export const ACCESS_IDLE_MS=60*60_000,ACCESS_LEASE_MS=90_000,ACCESS_PLAN_MS=10*60_000;
export const CAPABILITIES=['screen.view','screen.control','screen.receive.view','screen.receive.control',
  'agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser','screen.desktop-trust','screen.owner-delegation'] as const;
export type Capability=typeof CAPABILITIES[number];
export type DeviceKind='desktop'|'mobile';
export const ACCESS_OPERATIONS=['owner-delegation-set','owner-recovery-request','owner-recovery-poll','owner-recovery-publish','owner-recovery-list','owner-recovery-approve','owner-recovery-result','owner-recovery-status','screen-safety-subscribe','receiver-safety-poll','screen-safety-stop','screen-safety-result','receiver-safety-event','screen-safety-state','prepare','recover-registration','status','receipt','list','review','approve','review-management','approve-management','authorization','directory','session-open','session-status','activity','session-close','relay-ticket','receiver-status','receiver-directory','receiver-ticket','receiver-session','component-status','component-directory','component-ticket','component-session'] as const;
export type AccessOperation=typeof ACCESS_OPERATIONS[number];
export interface AccessEnvelope {payload:string;signature:string}
export interface AccessRequest {op:AccessOperation;id:string;at:number;nonce:string;actor:string|null;args:unknown[];bytes:Buffer;signature:Buffer}
export interface AccessPlan {version:1;profileId:string;deviceId:string;name:string;kind:DeviceKind;hostKey:string;biometricKey:string;operationKey:string;controlKey:string|null;agentDeviceId:string|null;capabilities:Capability[]}
export interface AccessAuthorization {version:1;communityId:string;profileId:string;enrollmentId:string;deviceId:string;deviceKind:DeviceKind;
  name:string;hostPublicKey:string;publicKey:string;biometricPublicKey:string;controlKey:string|null;agentDeviceId:string|null;capabilities:Capability[];revision:number;keyEpoch:number;issuedAt:number;expiresAt:number}
export interface AccessUseSession {version:1;communityId:string;enrollmentId:string;sessionId:string;publicKey:string;capabilities:Capability[];
  revision:number;sequence:number;lastHumanAt:number;idleExpiresAt:number;issuedAt:number;expiresAt:number}
export const MOBILE_RELAY_PURPOSES=['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'] as const;
export const RELAY_PURPOSES=['screen','agent','teams','agent-settings','browser',...MOBILE_RELAY_PURPOSES] as const;
export type MobileRelayPurpose=typeof MOBILE_RELAY_PURPOSES[number];
export type RelayPurpose=typeof RELAY_PURPOSES[number];
export const mobileRelayPurpose=(value:unknown):value is MobileRelayPurpose=>MOBILE_RELAY_PURPOSES.includes(value as MobileRelayPurpose);
export function accessRelayRoleAllowed(kind:DeviceKind,purpose:RelayPurpose,role:'host'|'client'):boolean{
  if(mobileRelayPurpose(purpose))return kind==='mobile'?role==='client':role==='host';
  return kind!=='mobile'||purpose==='screen'&&role==='client';
}
export interface AccessRelayTicket {version:1;ticketId:string;communityId:string;enrollmentId:string;deviceId:string;deviceKind:DeviceKind;
  connectionId:string;publicKey:string;purpose:RelayPurpose;role:'host'|'client';sessionId:string|null;revision:number;issuedAt:number;expiresAt:number;leaseExpiresAt:number}
export function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
  demand(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));
}
export function capabilities(value:unknown,kind?:DeviceKind):Capability[]{
  demand(Array.isArray(value)&&value.length>0&&value.length<=CAPABILITIES.length&&value.every(v=>CAPABILITIES.includes(v))&&new Set(value).size===value.length);
  const result=CAPABILITIES.filter(c=>value.includes(c));
  demand(kind!=='mobile'||!result.some(c=>c.startsWith('screen.receive.')),'MOBILE_CANNOT_HOST');
  demand(kind!=='mobile'||!result.includes('screen.desktop-trust'),'MOBILE_CANNOT_TRUST_DESKTOP');
  demand(kind!=='mobile'||!result.includes('screen.owner-delegation'),'MOBILE_CANNOT_DELEGATE_OWNER');
  demand(!result.includes('screen.owner-delegation')||result.includes('screen.desktop-trust')&&result.includes('screen.receive.control')&&result.includes('screen.receive.view'),'OWNER_DELEGATION_REQUIRES_TRUSTED_RECEIVER');
  demand(!result.includes('screen.desktop-trust')||result.includes('screen.view')||result.includes('screen.receive.view'),'DESKTOP_TRUST_REQUIRES_SCREEN');
  demand(!result.includes('screen.control')||result.includes('screen.view'),'MISSING_CAPABILITY');
  demand(!result.includes('screen.receive.control')||result.includes('screen.receive.view'),'MISSING_CAPABILITY');
  return [...result];
}
export function accessPlan(value:unknown):AccessPlan{
  exact(value,['version','profileId','deviceId','name','kind','hostKey','biometricKey','operationKey','controlKey','agentDeviceId','capabilities']);
  demand(value.version===1&&uuid(value.profileId)&&uuid(value.deviceId)&&name(value.name)&&(value.kind==='desktop'||value.kind==='mobile'));
  publicKey(value.hostKey);publicKey(value.biometricKey);publicKey(value.operationKey);
  const caps=capabilities(value.capabilities,value.kind);
  demand(value.controlKey===null||typeof value.controlKey==='string');if(value.controlKey!==null)publicKey(value.controlKey);
  demand(value.kind!=='mobile'||value.controlKey===null,'MOBILE_CANNOT_HOST');
  demand(value.kind!=='desktop'||!caps.some(c=>c==='computer-use.agent-settings'||c==='computer-use.browser'||c==='agent.communicate'||c==='teams.run')||value.controlKey!==null,'CONTROL_KEY_REQUIRED');
  demand(value.agentDeviceId===null||uuid(value.agentDeviceId));
  demand(value.kind!=='mobile'||value.agentDeviceId===null,'MOBILE_CANNOT_HOST');
  demand(value.kind!=='desktop'||!caps.some(c=>c==='agent.communicate'||c==='teams.run')||value.agentDeviceId!==null,'AGENT_DEVICE_ID_REQUIRED');
  const keys=[value.hostKey,value.biometricKey,value.operationKey,...(value.controlKey===null?[]:[value.controlKey])];
  demand(new Set(keys).size===keys.length,'KEYS_MUST_DIFFER');
  return {version:1,profileId:value.profileId,deviceId:value.deviceId,name:value.name,kind:value.kind,
    hostKey:value.hostKey as string,biometricKey:value.biometricKey as string,operationKey:value.operationKey as string,controlKey:value.controlKey as string|null,agentDeviceId:value.agentDeviceId as string|null,capabilities:caps};
}
export function accessPlanBytes(value:AccessPlan):Buffer{
  return Buffer.from(JSON.stringify([value.version,value.profileId,value.deviceId,value.name,value.kind,value.hostKey,value.biometricKey,value.operationKey,value.controlKey,value.agentDeviceId,value.capabilities]));
}
export function readAccessRequest(value:unknown,now:number):AccessRequest{
  exact(value,['payload','signature']);const bytes=b64(value.payload,32_000),signature=b64(value.signature,86);demand(bytes.length<=24_000&&signature.length===64);
  let fields:unknown;try{fields=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Fault('INVALID_REQUEST');}
  demand(Array.isArray(fields)&&fields.length===7&&fields[0]===2&&ACCESS_OPERATIONS.includes(fields[1])&&uuid(fields[2])&&integer(fields[3])
    &&Math.abs(now-fields[3])<=60_000&&b64(fields[4],43).length===32&&(fields[5]===null||uuid(fields[5]))&&Array.isArray(fields[6])&&fields[6].length<=(fields[1]==='approve-management'?6:5));
  return {op:fields[1],id:fields[2],at:fields[3],nonce:fields[4],actor:fields[5],args:fields[6],bytes,signature};
}
export function checkAccessProof(r:AccessRequest,key:string):void{
  demand(verify('sha256',Buffer.concat([ACCESS_REQUEST_DOMAIN,r.bytes]),{key:publicKey(key).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},r.signature),'INVALID_PROOF');
}
export function accessSigned(kind:string,id:string|null,at:number,payload:unknown,key:KeyObject):AccessEnvelope{
  const bytes=Buffer.from(JSON.stringify([2,kind,id,at,payload]));demand(bytes.length<=48_000,'RESPONSE_TOO_LARGE');
  return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([ACCESS_RESPONSE_DOMAIN,bytes]),{key:key.export({format:'pem',type:'pkcs8'}),dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
export function verifyAccessEnvelope(value:unknown,issuer:string):unknown[]{
  exact(value,['payload','signature']);const bytes=b64(value.payload,65_536),signature=b64(value.signature,86);
  demand(bytes.length<=48_000&&signature.length===64&&verify('sha256',Buffer.concat([ACCESS_RESPONSE_DOMAIN,bytes]),{key:publicKey(issuer).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},signature),'INVALID_ISSUER');
  const fields=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  demand(Array.isArray(fields)&&fields.length===5&&fields[0]===2&&typeof fields[1]==='string'&&(fields[2]===null||uuid(fields[2]))&&integer(fields[3]));return fields;
}
export function accessPurposeAllowed(caps:readonly Capability[],purpose:RelayPurpose,role:'host'|'client'):boolean{
  switch(purpose){case 'screen':return role==='host'?caps.includes('screen.receive.view'):caps.includes('screen.view');
    case 'agent':case 'mobile-agent':return caps.includes('agent.communicate');case 'teams':case 'mobile-teams':return caps.includes('teams.run');
    case 'agent-settings':case 'mobile-agent-settings':return caps.includes('computer-use.agent-settings');case 'browser':case 'mobile-browser':return caps.includes('computer-use.browser');}
}
export const accessChallenge=()=>randomBytes(32).toString('base64url');

/** Advisory discovery only: no membership or approval authority is carried by a notice. */
export function accessNoticeSigned(planId:string,communityId:string,profileId:string,digest:string,at:number,expiresAt:number,key:KeyObject):AccessEnvelope {
  demand(uuid(planId)&&uuid(communityId)&&uuid(profileId)&&/^[0-9a-f]{64}$/.test(digest)&&integer(at)&&integer(expiresAt)&&expiresAt>at&&expiresAt<=at+ACCESS_PLAN_MS);
  const bytes=Buffer.from(JSON.stringify([2,'access-enrollment-notice',planId,at,communityId,profileId,digest,expiresAt]));
  return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([ACCESS_NOTICE_DOMAIN,bytes]),{key:key.export({format:'pem',type:'pkcs8'}),dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
