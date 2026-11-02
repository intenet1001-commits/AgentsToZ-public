import {createHash,createHmac,createPublicKey,createPrivateKey,createCipheriv,createDecipheriv,randomBytes,
  sign,verify,type KeyObject} from 'node:crypto';
import {Buffer} from 'node:buffer';

export const REQUEST_DOMAIN=Buffer.from('agentstoz.screen-community.request/v1\0');
export const RESPONSE_DOMAIN=Buffer.from('agentstoz.screen-community.response/v1\0');
export const JOIN_TTL=5*60_000,RECEIPT_TTL=10*60_000,LEASE_TTL=90_000,MAX_MEMBERS=32;
export type Operation='discover'|'bootstrap'|'invite'|'join'|'entry'|'receipt'|'recover'|'lookup'|'review'|'approve'|'approve-entry'|'push-register'|'push-remove'|'directory'|'route'|'revoke'|'leave';
export type Grant='none'|'view'|'control';
export interface Envelope {payload:string;signature:string;hostSignature?:string}
export interface Request {op:Operation;id:string;at:number;nonce:string;actor:string|null;args:unknown[];bytes:Buffer;signature:Buffer;hostSignature?:Buffer}
export interface Member {
  enrollmentId:string;communityId:string;profileId:string;deviceId:string;name:string;
  hostKey:string;viewerKey:string;platform:'mac'|'ios';grant:Grant;admin:boolean;keyEpoch:number;joinedAt:number;revokedAt:number|null;route:string|null;
}
export class Fault extends Error {constructor(readonly code:string,readonly status=400){super(code);}}
export function demand(value:unknown,code='INVALID_REQUEST'):asserts value {if(!value)throw new Fault(code);}
export function uuid(value:unknown):value is string {return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);}
export function integer(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>=0;}
export function b64(value:unknown,max=32_768):Buffer{
  demand(typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9_-]+$/.test(value));
  const bytes=Buffer.from(value,'base64url');demand(bytes.toString('base64url')===value);return bytes;
}
export function publicKey(value:unknown):KeyObject{
  const raw=b64(value,87);demand(raw.length===65&&raw[0]===4);
  try{return createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:raw.subarray(1,33).toString('base64url'),y:raw.subarray(33).toString('base64url')}});}
  catch{throw new Fault('INVALID_KEY');}
}
export function keyString(key:KeyObject):string{
  const jwk=key.export({format:'jwk'});demand(jwk.kty==='EC'&&jwk.crv==='P-256'&&jwk.x&&jwk.y);
  return Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');
}
export function privateKey(jwk:string):KeyObject{
  const key=createPrivateKey({format:'jwk',key:JSON.parse(jwk)});demand(key.asymmetricKeyType==='ec'&&key.asymmetricKeyDetails?.namedCurve==='prime256v1','ISSUER_NOT_CONFIGURED');return key;
}
export function name(value:unknown):value is string{
  return typeof value==='string'&&value===value.trim()&&value.length>0&&Buffer.byteLength(value)<=120&&!/[\p{Cc}\p{Cf}]/u.test(value);
}
export function grant(value:unknown):value is Grant{return value==='none'||value==='view'||value==='control';}
export function privateIPv4(value:unknown):value is string{
  if(typeof value!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return false;
  const p=value.split('.').map(Number),second=p[1]??-1;return p.every((n,i)=>n>=0&&n<=255&&String(n)===value.split('.')[i])
    &&(p[0]===10||p[0]===172&&second>=16&&second<=31||p[0]===192&&p[1]===168);
}
export function hash(value:string|Buffer):string{return createHash('sha256').update(value).digest('hex');}
export function fingerprint(value:string):string{return hash(b64(value,87));}
export function readRequest(value:unknown,now:number):Request{
  demand(value!==null&&typeof value==='object'&&!Array.isArray(value)&&['payload,signature','hostSignature,payload,signature'].includes(Object.keys(value).sort().join(',')));
  const envelope=value as Envelope,bytes=b64(envelope.payload),signature=b64(envelope.signature,86);demand(signature.length===64);
  let a:unknown;try{a=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Fault('INVALID_REQUEST');}
  demand(Array.isArray(a)&&a.length===7&&a[0]===1&&['discover','bootstrap','invite','join','entry','receipt','recover','lookup','review','approve','approve-entry','push-register','push-remove','directory','route','revoke','leave'].includes(a[1])
    &&uuid(a[2])&&integer(a[3])&&Math.abs(now-a[3])<=60_000&&typeof a[4]==='string'&&b64(a[4],43).length===32
    &&(a[5]===null||uuid(a[5]))&&Array.isArray(a[6])&&a[6].length<=8);
  const hostSignature=envelope.hostSignature===undefined?undefined:b64(envelope.hostSignature,86);
  demand(a[1]==='bootstrap'?hostSignature?.length===64:hostSignature===undefined);
  return {op:a[1],id:a[2],at:a[3],nonce:a[4],actor:a[5],args:a[6],bytes,signature,hostSignature};
}
export function checkProof(request:Request,key:string):void{
  // workerd's Node compatibility layer accepts encoded keys here; a KeyObject nested in signing options is not
  // portable across runtimes. P1363 remains the wire encoding shared with CryptoKit.
  demand(verify('sha256',Buffer.concat([REQUEST_DOMAIN,request.bytes]),{key:publicKey(key).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},request.signature),'INVALID_PROOF');
}
export function signed(payload:unknown[],key:KeyObject):Envelope{
  const bytes=Buffer.from(JSON.stringify(payload));demand(bytes.length<=48_000,'RESPONSE_TOO_LARGE');
  return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([RESPONSE_DOMAIN,bytes]),{key:key.export({format:'pem',type:'pkcs8'}),dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
export function verifyEnvelope(envelope:Envelope,key:string):unknown[]{
  const bytes=b64(envelope.payload,65_536),signature=b64(envelope.signature,86);
  demand(signature.length===64&&verify('sha256',Buffer.concat([RESPONSE_DOMAIN,bytes]),{key:publicKey(key).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},signature),'INVALID_ISSUER');
  const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));demand(Array.isArray(payload));return payload;
}
export function codeHash(code:string,key:Buffer):string{return createHmac('sha256',key).update('screen-community-code/v1\0').update(code).digest('hex');}
export function newCode():string{for(let n=0;n<16;n++){const value=randomBytes(4).readUInt32BE();if(value<4_200_000_000)return String(value%100_000_000).padStart(8,'0');}throw new Fault('RANDOM_UNAVAILABLE',503);}
export function seal(value:unknown,key:Buffer,context:string):string{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));
  const bytes=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value),'utf8')),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');
}
export function openSealed<T>(value:string,key:Buffer,context:string):T{
  const bytes=b64(value,262_144);demand(bytes.length>=28);const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(context));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as T;
}
export function memberFields(m:Member):unknown[]{return [m.enrollmentId,m.deviceId,m.name,m.hostKey,m.viewerKey,m.grant,m.admin,m.keyEpoch,m.joinedAt,m.route,m.platform];}
