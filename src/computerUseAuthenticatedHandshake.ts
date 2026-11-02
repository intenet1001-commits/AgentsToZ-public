import {communityBytes,communityBase64,type CommunityAccessEnvelope} from './communityAccessClient';
import {communityComponentHandshakeBytes,type CommunityComponentHandshake,type CommunityComponentRole,
 type NativeCommunityComponentIdentity,type CommunityComponentAuthorization} from './communityComponentIdentity';
export type ComputerUseCommunityIdentity=Pick<NativeCommunityComponentIdentity,'context'|'currentAuthorization'|'directory'|'signHandshake'|'verifyAuthorization'>;
const encoder=new TextEncoder(),buffer=(bytes:Uint8Array)=>new Uint8Array(bytes).buffer;
export const computerUseAuthNonce=()=>communityBase64(crypto.getRandomValues(new Uint8Array(32)));
export class ComputerUsePeerConfirmation {
 private constructor(readonly transcriptHash:string,private readonly own:CryptoKey,private readonly peer:CryptoKey,private readonly hash:Uint8Array,private readonly role:CommunityComponentRole){}
 static async create(t:CommunityComponentHandshake,role:CommunityComponentRole,privateKey:CryptoKey):Promise<ComputerUsePeerConfirmation>{
  const a=communityComponentHandshakeBytes(t,'sender'),b=communityComponentHandshakeBytes(t,'receiver'),joined=new Uint8Array(a.length+b.length);joined.set(a);joined.set(b,a.length);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(joined))),peer=await crypto.subtle.importKey('raw',buffer(communityBytes(role==='sender'?t.receiverEphemeral:t.senderEphemeral,65)),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256));
  try{
   const base=await crypto.subtle.importKey('raw',buffer(shared),'HKDF',false,['deriveKey']);
   const key=(side:CommunityComponentRole)=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:buffer(hash),info:buffer(encoder.encode('agentstoz.computer-use.authenticated/v2\0confirmation\0'+side))},base,{name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
   return new ComputerUsePeerConfirmation(Array.from(hash,x=>x.toString(16).padStart(2,'0')).join(''),await key(role),await key(role==='sender'?'receiver':'sender'),hash,role);
  }finally{shared.fill(0);}
 }
 private message(role:CommunityComponentRole,final=false){const prefix=encoder.encode('agentstoz.computer-use.authenticated/v2\0'+(final?'complete':'confirm')+'\0'+role+'\0'),input=new Uint8Array(prefix.length+this.hash.length);input.set(prefix);input.set(this.hash,prefix.length);return input;}
 async proof(final=false):Promise<string>{return communityBase64(new Uint8Array(await crypto.subtle.sign('HMAC',this.own,buffer(this.message(this.role,final)))));}
 async verify(value:unknown,final=false):Promise<void>{
  const bytes=communityBytes(value,32);if(bytes.length!==32||!await crypto.subtle.verify('HMAC',this.peer,buffer(bytes),buffer(this.message(this.role==='sender'?'receiver':'sender',final))))throw Error('peer key confirmation failed');
 }
}
export interface AuthenticatedComputerUseHello {
 kind:'computer-use';v:2;op:'hello';session:string;seq:0;sentAt:number;pub:string;instance:string;platform:'darwin';nonce:string;
 authorization:CommunityAccessEnvelope;expectedReceiver:string;
}
export interface AuthenticatedComputerUseReply {v:2;pub:string;bootId:string;nonce:string;authorization:CommunityAccessEnvelope;proof:string;confirmation:string}
export function computerUseAuthenticatedTranscript(input:{sender:CommunityComponentAuthorization;receiver:CommunityComponentAuthorization;hello:AuthenticatedComputerUseHello;reply:Pick<AuthenticatedComputerUseReply,'pub'|'bootId'|'nonce'>}):CommunityComponentHandshake{
 const {sender:s,receiver:r,hello:h,reply}=input;
 const t:CommunityComponentHandshake={version:1,purpose:'agent',profileId:s.body.profileId,communityId:s.body.communityId,
  senderDeviceId:s.body.deviceId,receiverDeviceId:r.body.deviceId,senderAgentDeviceId:s.body.agentDeviceId,receiverAgentDeviceId:r.body.agentDeviceId,
  senderEnrollmentId:s.body.enrollmentId,receiverEnrollmentId:r.body.enrollmentId,senderCertificateHash:s.policyDigest,receiverCertificateHash:r.policyDigest,
  session:h.session,instance:h.instance,receiverBootId:reply.bootId,senderEphemeral:h.pub,receiverEphemeral:reply.pub,senderNonce:h.nonce,receiverNonce:reply.nonce};
 communityComponentHandshakeBytes(t,'sender');return t;
}
