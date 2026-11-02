import {createHash} from 'node:crypto';
import {communityBase64,communityBytes,communityObject,type CommunityAccessEnvelope,type CommunityMobileRelayPurpose} from './communityAccessClient';

export const MOBILE_CONTROL_MAX_PLAINTEXT=24_000,MOBILE_CONTROL_MAX_RESULT=16_000,MOBILE_CONTROL_MAX_HANDSHAKE=32_000;
export const MOBILE_CONTROL_TRANSCRIPT_FIELDS=['version','purpose','profileId','communityId','channelId','senderKind','receiverKind','senderDeviceId','receiverDeviceId','senderEnrollmentId','receiverEnrollmentId','senderPolicyDigest','receiverPolicyDigest','senderUseId','senderUsePublicKey','senderUsePolicyDigest','senderConnectionId','receiverConnectionId','receiverBootId','receiverInstance','senderEphemeral','receiverEphemeral','senderNonce','receiverNonce'] as const;
export type MobileControlRole='client'|'host';
export interface MobileControlTranscript {
  version:2;purpose:CommunityMobileRelayPurpose;profileId:string;communityId:string;channelId:string;senderKind:'mobile';receiverKind:'desktop';
  senderDeviceId:string;receiverDeviceId:string;senderEnrollmentId:string;receiverEnrollmentId:string;
  senderPolicyDigest:string;receiverPolicyDigest:string;senderUseId:string;senderUsePublicKey:string;senderUsePolicyDigest:string;
  senderConnectionId:string;receiverConnectionId:string;receiverBootId:string;receiverInstance:string;
  senderEphemeral:string;receiverEphemeral:string;senderNonce:string;receiverNonce:string;
}
export interface MobileControlHello {
  v:2;type:'hello';purpose:CommunityMobileRelayPurpose;channelId:string;senderAuthorization:CommunityAccessEnvelope;senderUseSession:CommunityAccessEnvelope;
  expectedReceiver:{deviceId:string;enrollmentId:string;policyDigest:string};senderConnectionId:string;receiverConnectionId:string|null;senderEphemeral:string;senderNonce:string;
}
export interface MobileControlRecord {v:2;type:'record';channelId:string;direction:MobileControlRole;seq:number;requestId:string;ciphertext:string}
export type MobileControlRequest =
  |{v:1;kind:'request';mode:'query';requestId:string;command:Readonly<Record<string,unknown>>}
  |{v:1;kind:'request';mode:'effect';requestId:string;operationId:string;createdAt:number;command:Readonly<Record<string,unknown>>}
  |{v:1;kind:'request';mode:'receipt';requestId:string;operationId:string;createdAt:number}
  |{v:1;kind:'request';mode:'consumed';requestId:string;operationId:string;createdAt:number;resultDigest:string};
export interface MobileControlResponse {v:1;kind:'response';requestId:string;result:string;resultDigest:string}
export interface MobileControlKeys {clientToHost:CryptoKey;hostToClient:CryptoKey;clientConfirm:CryptoKey;hostConfirm:CryptoKey;transcriptHash:Uint8Array}
export class MobileControlProtocolError extends Error {constructor(readonly code:string){super(code);this.name='MobileControlProtocolError';}}
function fail(code:string):never {throw new MobileControlProtocolError(code);}
const utf8=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
function jsonBytes(value:unknown):Uint8Array {const text=JSON.stringify(value);if(typeof text!=='string')fail('MOBILE_INVALID_JSON');return utf8.encode(text);}
const buf=(bytes:Uint8Array)=>new Uint8Array(bytes).buffer;
export const mobileControlUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const mobileControlPurpose=(v:unknown):v is CommunityMobileRelayPurpose=>['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'].includes(v as string);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
export const mobileControlHash=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
function point(value:unknown):Uint8Array {const bytes=communityBytes(value,65);if(bytes.length!==65||bytes[0]!==4)fail('MOBILE_INVALID_POINT');return bytes;}
function exactEnvelope(value:unknown):CommunityAccessEnvelope {const v=communityObject(value,['payload','signature']);communityBytes(v.payload,48_000);if(communityBytes(v.signature,64).length!==64)fail('MOBILE_INVALID_ENVELOPE');return Object.freeze(v) as unknown as CommunityAccessEnvelope;}
function freezeJSON(value:unknown):void {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freezeJSON(child);}}
export function mobileControlTranscriptBytes(t:MobileControlTranscript):Uint8Array {
  communityObject(t,MOBILE_CONTROL_TRANSCRIPT_FIELDS);
  if(t.version!==2||!mobileControlPurpose(t.purpose)||t.senderKind!=='mobile'||t.receiverKind!=='desktop')fail('MOBILE_INVALID_TRANSCRIPT');
  for(const key of ['profileId','communityId','channelId','senderDeviceId','receiverDeviceId','senderEnrollmentId','receiverEnrollmentId','senderUseId','senderConnectionId','receiverConnectionId'] as const)if(!mobileControlUuid(t[key]))fail('MOBILE_INVALID_TRANSCRIPT');
  if(t.senderDeviceId===t.receiverDeviceId||t.senderEnrollmentId===t.receiverEnrollmentId||t.senderConnectionId===t.receiverConnectionId)fail('MOBILE_REFLECTED_TRANSCRIPT');
  for(const key of ['senderPolicyDigest','receiverPolicyDigest','senderUsePolicyDigest'] as const)if(!digest(t[key]))fail('MOBILE_INVALID_TRANSCRIPT');
  for(const key of ['receiverBootId','receiverInstance'] as const)if(!/^[a-f0-9]{32}$/.test(t[key]))fail('MOBILE_INVALID_EPOCH');
  if(t.receiverBootId===t.receiverInstance)fail('MOBILE_REFLECTED_EPOCH');
  for(const key of ['senderUsePublicKey','senderEphemeral','receiverEphemeral'] as const)point(t[key]);
  if(new Set([t.senderUsePublicKey,t.senderEphemeral,t.receiverEphemeral]).size!==3)fail('MOBILE_REFLECTED_KEY');
  if(communityBytes(t.senderNonce,32).length!==32||communityBytes(t.receiverNonce,32).length!==32||t.senderNonce===t.receiverNonce)fail('MOBILE_INVALID_NONCE');
  return utf8.encode('agentstoz.community-mobile-control/transcript/v2\0'+JSON.stringify(MOBILE_CONTROL_TRANSCRIPT_FIELDS.map(k=>t[k])));
}
/** Parsing bytes and validating the actual P-256 points are separate, and both precede signing or admission. */
export async function validateMobileControlTranscript(t:MobileControlTranscript):Promise<void>{
  mobileControlTranscriptBytes(t);
  for(const key of ['senderUsePublicKey','senderEphemeral','receiverEphemeral'] as const)await crypto.subtle.importKey('raw',buf(point(t[key])),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
}
export function mobileControlProofBytes(t:MobileControlTranscript,role:MobileControlRole):Uint8Array {
  if(role!=='client'&&role!=='host')fail('MOBILE_INVALID_ROLE');
  return new Uint8Array(Buffer.concat([Buffer.from('agentstoz.community-mobile-control/proof/v2\0'+role+'\0'),createHash('sha256').update(mobileControlTranscriptBytes(t)).digest()]));
}
export async function verifyMobileControlProof(t:MobileControlTranscript,role:MobileControlRole,publicKey:string,signature:string):Promise<boolean>{
  try{
    const bytes=communityBytes(signature,64);if(bytes.length!==64)return false;
    await validateMobileControlTranscript(t);
    const key=await crypto.subtle.importKey('raw',buf(point(publicKey)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,buf(bytes),buf(mobileControlProofBytes(t,role)));
  }catch{return false;}
}
export async function createMobileControlEphemeral():Promise<{privateKey:CryptoKey;publicKey:string}>{
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  return {privateKey:pair.privateKey,publicKey:communityBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)))};
}
export async function deriveMobileControlKeys(privateKey:CryptoKey,peer:string,t:MobileControlTranscript):Promise<MobileControlKeys>{
  await validateMobileControlTranscript(t);
  const peerKey=await crypto.subtle.importKey('raw',buf(point(peer)),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:peerKey},privateKey,256));
  try{
    const material=await crypto.subtle.importKey('raw',buf(secret),'HKDF',false,['deriveKey']);
    const hash=new Uint8Array(createHash('sha256').update(mobileControlTranscriptBytes(t)).digest());
    const derive=(label:string,algorithm:AesKeyGenParams|HmacKeyGenParams,usages:KeyUsage[])=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:buf(hash),info:buf(utf8.encode('agentstoz.community-mobile-control/keys/v2\0'+label))},material,algorithm,false,usages);
    return {clientToHost:await derive('client-to-host',{name:'AES-GCM',length:256},['encrypt','decrypt']),hostToClient:await derive('host-to-client',{name:'AES-GCM',length:256},['encrypt','decrypt']),
      clientConfirm:await derive('client-confirm',{name:'HMAC',hash:'SHA-256',length:256},['sign','verify']),hostConfirm:await derive('host-confirm',{name:'HMAC',hash:'SHA-256',length:256},['sign','verify']),transcriptHash:hash};
  }finally{secret.fill(0);}
}
function confirmationInput(keys:MobileControlKeys,role:MobileControlRole,proof:string):Uint8Array {
  const sig=communityBytes(proof,64);if(sig.length!==64)fail('MOBILE_INVALID_PROOF');
  return new Uint8Array(Buffer.concat([Buffer.from('agentstoz.community-mobile-control/confirm/v2\0'+role+'\0'),Buffer.from(keys.transcriptHash),createHash('sha256').update(sig).digest()]));
}
export async function mobileControlConfirmation(keys:MobileControlKeys,role:MobileControlRole,proof:string):Promise<string>{
  return communityBase64(new Uint8Array(await crypto.subtle.sign('HMAC',role==='client'?keys.clientConfirm:keys.hostConfirm,buf(confirmationInput(keys,role,proof)))));
}
export async function verifyMobileControlConfirmation(keys:MobileControlKeys,role:MobileControlRole,proof:string,confirmation:string):Promise<boolean>{
  try{return await crypto.subtle.verify('HMAC',role==='client'?keys.clientConfirm:keys.hostConfirm,buf(communityBytes(confirmation,32)),buf(confirmationInput(keys,role,proof)));}catch{return false;}
}
function readyInput(keys:MobileControlKeys,clientProof:string,hostProof:string):Uint8Array {
  const client=communityBytes(clientProof,64),host=communityBytes(hostProof,64);if(client.length!==64||host.length!==64)fail('MOBILE_INVALID_PROOF');
  return new Uint8Array(Buffer.concat([Buffer.from('agentstoz.community-mobile-control/ready/v2\0'),Buffer.from(keys.transcriptHash),createHash('sha256').update(client).digest(),createHash('sha256').update(host).digest()]));
}
export async function mobileControlReady(keys:MobileControlKeys,clientProof:string,hostProof:string):Promise<string>{return communityBase64(new Uint8Array(await crypto.subtle.sign('HMAC',keys.hostConfirm,buf(readyInput(keys,clientProof,hostProof)))));}
export async function verifyMobileControlReady(keys:MobileControlKeys,clientProof:string,hostProof:string,value:string):Promise<boolean>{try{return await crypto.subtle.verify('HMAC',keys.hostConfirm,buf(communityBytes(value,32)),buf(readyInput(keys,clientProof,hostProof)));}catch{return false;}}
export function mobileControlNonce(direction:MobileControlRole,seq:number):Uint8Array {
  if(!['client','host'].includes(direction)||!integer(seq)||seq<1)fail('MOBILE_INVALID_SEQUENCE');
  const bytes=Buffer.alloc(12);bytes.write(direction==='client'?'c2h\0':'h2c\0',0,'ascii');bytes.writeBigUInt64BE(BigInt(seq),4);return bytes;
}
export function mobileControlAAD(t:MobileControlTranscript,direction:MobileControlRole,seq:number,requestId:string):Uint8Array {
  if(!mobileControlUuid(requestId))fail('MOBILE_INVALID_REQUEST_ID');mobileControlNonce(direction,seq);
  return utf8.encode(JSON.stringify(['agentstoz.community-mobile-control/record/v2',t.channelId,t.purpose,direction,seq,requestId]));
}
export async function sealMobileControlRecord(keys:MobileControlKeys,t:MobileControlTranscript,direction:MobileControlRole,seq:number,requestId:string,value:unknown):Promise<MobileControlRecord>{
  const clear=jsonBytes(value);if(clear.length>MOBILE_CONTROL_MAX_PLAINTEXT)fail('MOBILE_RECORD_TOO_LARGE');
  try{
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:buf(mobileControlNonce(direction,seq)),additionalData:buf(mobileControlAAD(t,direction,seq,requestId))},direction==='client'?keys.clientToHost:keys.hostToClient,buf(clear));
    return {v:2,type:'record',channelId:t.channelId,direction,seq,requestId,ciphertext:communityBase64(new Uint8Array(ciphertext))};
  }finally{clear.fill(0);}
}
export async function openMobileControlRecord(keys:MobileControlKeys,t:MobileControlTranscript,direction:MobileControlRole,expectedSequence:number,value:unknown):Promise<unknown>{
  const r=communityObject(value,['v','type','channelId','direction','seq','requestId','ciphertext']);
  if(r.v!==2||r.type!=='record'||r.channelId!==t.channelId||r.direction!==direction||r.seq!==expectedSequence||!mobileControlUuid(r.requestId))fail('MOBILE_RECORD_BINDING');
  const encrypted=communityBytes(r.ciphertext,MOBILE_CONTROL_MAX_PLAINTEXT+16);if(encrypted.length<16)fail('MOBILE_INVALID_RECORD');
  const clear=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:buf(mobileControlNonce(direction,expectedSequence)),additionalData:buf(mobileControlAAD(t,direction,expectedSequence,r.requestId))},direction==='client'?keys.clientToHost:keys.hostToClient,buf(encrypted)));
  try{if(clear.length>MOBILE_CONTROL_MAX_PLAINTEXT)fail('MOBILE_RECORD_TOO_LARGE');return JSON.parse(decoder.decode(clear));}finally{clear.fill(0);}
}
export function parseMobileControlHello(value:unknown):MobileControlHello {
  const h=communityObject(value,['v','type','purpose','channelId','senderAuthorization','senderUseSession','expectedReceiver','senderConnectionId','receiverConnectionId','senderEphemeral','senderNonce']);
  if(h.v!==2||h.type!=='hello'||!mobileControlPurpose(h.purpose)||!mobileControlUuid(h.channelId)||!mobileControlUuid(h.senderConnectionId)||(h.receiverConnectionId!==null&&!mobileControlUuid(h.receiverConnectionId)))fail('MOBILE_INVALID_HELLO');
  const target=communityObject(h.expectedReceiver,['deviceId','enrollmentId','policyDigest']);if(!mobileControlUuid(target.deviceId)||!mobileControlUuid(target.enrollmentId)||!digest(target.policyDigest))fail('MOBILE_INVALID_TARGET');
  point(h.senderEphemeral);if(communityBytes(h.senderNonce,32).length!==32)fail('MOBILE_INVALID_NONCE');
  exactEnvelope(h.senderAuthorization);exactEnvelope(h.senderUseSession);
  if(utf8.encode(JSON.stringify(h)).length>MOBILE_CONTROL_MAX_HANDSHAKE)fail('MOBILE_HANDSHAKE_TOO_LARGE');
  freezeJSON(h);return h as unknown as MobileControlHello;
}
export function parseMobileControlRequest(value:unknown,requestId:string):MobileControlRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('MOBILE_INVALID_REQUEST');
  const mode=(value as Record<string,unknown>).mode;
  const extra=mode==='query'?['command']:mode==='effect'?['operationId','createdAt','command']:mode==='receipt'?['operationId','createdAt']:mode==='consumed'?['operationId','createdAt','resultDigest']:fail('MOBILE_INVALID_MODE');
  const r=communityObject(value,['v','kind','mode','requestId',...extra]);
  if(r.v!==1||r.kind!=='request'||r.requestId!==requestId||!mobileControlUuid(requestId))fail('MOBILE_REQUEST_BINDING');
  if(mode!=='query'&&(!integer(r.createdAt)||mobileControlOperationTime(r.operationId)!==r.createdAt))fail('MOBILE_INVALID_OPERATION');
  if(mode==='consumed'&&!digest(r.resultDigest))fail('MOBILE_INVALID_RESULT_DIGEST');
  if((mode==='query'||mode==='effect')&&(!r.command||typeof r.command!=='object'||Array.isArray(r.command)))fail('MOBILE_INVALID_COMMAND');
  freezeJSON(r);return r as unknown as MobileControlRequest;
}
export function mobileControlOperationTime(id:unknown):number|null {
  if(!mobileControlUuid(id)||id[14]!=='7'||!/[89ab]/.test(id[19]!))return null;
  return Number.parseInt(id.slice(0,8)+id.slice(9,13),16);
}
export function mobileControlResponse(requestId:string,result:unknown):MobileControlResponse {
  if(!mobileControlUuid(requestId))fail('MOBILE_INVALID_REQUEST_ID');
  const bytes=jsonBytes(result);if(bytes.length>MOBILE_CONTROL_MAX_RESULT)fail('MOBILE_RESULT_TOO_LARGE');
  return {v:1,kind:'response',requestId,result:communityBase64(bytes),resultDigest:mobileControlHash(bytes)};
}
export function readMobileControlResponse(value:unknown,requestId:string):{response:MobileControlResponse;result:unknown}{
  const r=communityObject(value,['v','kind','requestId','result','resultDigest']);
  if(r.v!==1||r.kind!=='response'||r.requestId!==requestId||!digest(r.resultDigest))fail('MOBILE_RESPONSE_BINDING');
  const bytes=communityBytes(r.result,MOBILE_CONTROL_MAX_RESULT);if(mobileControlHash(bytes)!==r.resultDigest)fail('MOBILE_RESULT_DIGEST_MISMATCH');
  return {response:r as unknown as MobileControlResponse,result:JSON.parse(decoder.decode(bytes))};
}
