import {CommunityAccessClient,CommunityAccessReply,CommunityRelayTicket,communityBase64,communityBytes,communityObject,
  communityComponentSessionArgs,type CommunityAccessFetch,type CommunityAccessRequest,type CommunityMobileRelayPurpose} from './communityAccessClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession,type CommunityMobileAuthority} from './communityMobilePrincipal';
import {mobileControlPurpose,mobileControlUuid,validateMobileControlTranscript,verifyMobileControlProof,type MobileControlTranscript} from './communityMobileControlProtocol';

export interface CommunityMobileMainLink {
  readonly verifiedMain:boolean;
  request(value:Record<string,unknown>):Promise<Record<string,unknown>>;
}
export interface NativeCommunityMobileContext {
  readonly authority:Readonly<CommunityMobileAuthority>;readonly communityId:string;readonly profileId:string;readonly enrollmentId:string;
  readonly deviceId:string;readonly controlKey:string;readonly agentDeviceId:string|null;readonly revision:number;readonly capabilities:readonly string[];
}
export class NativeCommunityMobileIdentityError extends Error {
  constructor(readonly code:string){super(code);this.name='NativeCommunityMobileIdentityError';}
}
const fail=(code:string):never=>{throw new NativeCommunityMobileIdentityError(code);};
const CONTROL_CAPS=['agent.communicate','computer-use.agent-settings','computer-use.browser','teams.run'] as const;
const BINDING_KEYS=['candidatePrepared','profileId','deviceId','controlKey','revision','localOff','agentDeviceId','communityId','enrollmentId','capabilities'];
const encoder=new TextEncoder();
const cap=(purpose:CommunityMobileRelayPurpose)=>{
  switch(purpose){case 'mobile-agent':return 'agent.communicate';case 'mobile-teams':return 'teams.run';
    case 'mobile-agent-settings':return 'computer-use.agent-settings';case 'mobile-browser':return 'computer-use.browser';default:return fail('NATIVE_INVALID_PURPOSE');}
};
const fingerprint=(value:unknown)=>JSON.stringify(value);
const authorityFingerprint=(a:CommunityMobileAuthority)=>[a.origin,a.issuerPublicKey,a.profileId].join('\0');
const buffer=(bytes:Uint8Array)=>new Uint8Array(bytes).buffer;
async function curve(value:unknown):Promise<string>{
  try{const bytes=communityBytes(value,65);if(bytes.length!==65||bytes[0]!==4)return fail('NATIVE_INVALID_KEY');
    await crypto.subtle.importKey('raw',buffer(bytes),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);return value as string;
  }catch{return fail('NATIVE_INVALID_KEY');}
}
async function verifyProof(publicKey:string,signature:unknown,message:Uint8Array):Promise<Uint8Array>{
  const bytes=communityBytes(signature,64);if(bytes.length!==64)return fail('NATIVE_INVALID_PROOF');
  const key=await crypto.subtle.importKey('raw',buffer(communityBytes(publicKey,65)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,buffer(bytes),buffer(message)))return fail('NATIVE_INVALID_PROOF');return bytes;
}

/** Uses only the shared inherited Main link. No fallback signer, new native queue, key generation or execution surface. */
export class NativeCommunityMobileIdentity {
  private binding?:NativeCommunityMobileContext;private keyEpoch?:number;private stopped=false;
  /** A pinned Native lineage ended. Its old operations stay fenced; a supervisor may create a new instance. */
  get ended():boolean{return this.stopped;}
  constructor(private readonly link:CommunityMobileMainLink,private readonly fetcher:CommunityAccessFetch=(url,init)=>fetch(url,init),private readonly now=Date.now){}
  private live():void{if(this.stopped)return fail('NATIVE_IDENTITY_ENDED');if(!this.link.verifiedMain){this.stopped=true;return fail('NATIVE_MAIN_REQUIRED');}}
  private async invoke(request:Record<string,unknown>):Promise<Record<string,unknown>>{
    this.live();const result=await this.link.request(request);this.live();
    if(result.success!==true||result.halted!==false)return fail('NATIVE_COMPONENT_REFUSED');return result;
  }
  async context():Promise<NativeCommunityMobileContext>{
    const response=await this.invoke({operation:'community-component-context'});
    try{
      communityObject(response,['success','halted','communityProtocolVersion','configured','storeAvailable','authority','binding']);
      if(response.communityProtocolVersion!==3||response.configured!==true||response.storeAvailable!==true||!response.authority||!response.binding)return fail('NATIVE_ENROLLMENT_REQUIRED');
      const a=communityObject(response.authority,['origin','profileId','issuerPublicKey']),b=communityObject(response.binding,BINDING_KEYS);
      if(typeof a.origin!=='string'||!mobileControlUuid(a.profileId)||typeof a.issuerPublicKey!=='string')return fail('NATIVE_INVALID_AUTHORITY');
      const url=new URL(a.origin);if(url.protocol!=='https:'||url.origin!==a.origin||url.pathname!=='/'||url.username||url.password||url.port||url.search||url.hash||!url.hostname.endsWith('.workers.dev'))return fail('NATIVE_INVALID_AUTHORITY');
      if(b.candidatePrepared!==true||b.localOff!==false||!Number.isSafeInteger(b.revision)||(b.revision as number)<1
        ||!['profileId','communityId','enrollmentId','deviceId'].every(k=>mobileControlUuid(b[k]))||b.profileId!==a.profileId
        ||b.agentDeviceId!==null&&!mobileControlUuid(b.agentDeviceId)||!Array.isArray(b.capabilities)||b.capabilities.length<1
        ||fingerprint(b.capabilities)!==fingerprint(CONTROL_CAPS.filter(c=>b.capabilities instanceof Array&&b.capabilities.includes(c)))
        ||b.capabilities.some(c=>c==='agent.communicate'||c==='teams.run')&&b.agentDeviceId===null)return fail('NATIVE_INVALID_CONTEXT');
      const controlKey=await curve(b.controlKey),issuerPublicKey=await curve(a.issuerPublicKey);this.live();
      const value:NativeCommunityMobileContext=Object.freeze({authority:Object.freeze({origin:a.origin,profileId:a.profileId,issuerPublicKey}),
        communityId:b.communityId as string,profileId:b.profileId as string,enrollmentId:b.enrollmentId as string,deviceId:b.deviceId as string,
        controlKey,agentDeviceId:b.agentDeviceId as string|null,revision:b.revision as number,capabilities:Object.freeze([...b.capabilities]) as readonly string[]});
      if(this.binding&&fingerprint(this.binding)!==fingerprint(value)){this.stopped=true;return fail('NATIVE_CONTEXT_CHANGED');}
      this.binding??=value;return this.binding;
    }catch(error){if(this.binding)this.stopped=true;throw error;}
  }
  async relayOrigin():Promise<string>{return (await this.context()).authority.origin;}
  private purpose(c:NativeCommunityMobileContext,purpose:CommunityMobileRelayPurpose):void {
    if(!mobileControlPurpose(purpose)||!c.capabilities.includes(cap(purpose)))fail('NATIVE_CAPABILITY_DENIED');
  }
  private async unchanged(c:NativeCommunityMobileContext):Promise<void>{
    const current=await this.context();if(fingerprint(current)!==fingerprint(c)){this.stopped=true;fail('NATIVE_CONTEXT_CHANGED');}
  }
  private sameAuthority(c:NativeCommunityMobileContext,authorization:CommunityDeviceAuthorization):void {
    if(!CommunityDeviceAuthorization.isVerified(authorization)||authorityFingerprint(c.authority)!==authorityFingerprint(authorization.authority)
      ||authorization.body.communityId!==c.communityId||authorization.body.profileId!==c.profileId)return fail('NATIVE_PRINCIPAL_MISMATCH');
  }
  private own(c:NativeCommunityMobileContext,a:CommunityDeviceAuthorization,purpose:CommunityMobileRelayPurpose):void {
    this.sameAuthority(c,a);const b=a.body;
    if(!a.permits(purpose,this.now())||b.deviceKind!=='desktop'||b.enrollmentId!==c.enrollmentId||b.deviceId!==c.deviceId||b.controlKey!==c.controlKey
      ||b.agentDeviceId!==c.agentDeviceId||b.revision!==c.revision||fingerprint(CONTROL_CAPS.filter(capability=>b.capabilities.includes(capability)))!==fingerprint(c.capabilities))return fail('NATIVE_PRINCIPAL_MISMATCH');
    if(this.keyEpoch!==undefined&&this.keyEpoch!==b.keyEpoch){this.stopped=true;return fail('NATIVE_KEY_EPOCH_CHANGED');}
  }
  private async exchange(c:NativeCommunityMobileContext,purpose:CommunityMobileRelayPurpose,operation:'component-status'|'component-directory'|'component-ticket'|'component-session',extra:readonly unknown[]=[]):Promise<CommunityAccessReply>{
    this.purpose(c,purpose);
    const signer={publicKey:c.controlKey,signAccessRequest:async(request:Readonly<CommunityAccessRequest>)=>{
      await this.unchanged(c);
      const answer=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'access',request}});await this.unchanged(c);
      const v=communityObject(answer,['success','halted','publicKey','payload','signature']);if(v.publicKey!==c.controlKey||typeof v.payload!=='string'||typeof v.signature!=='string')return fail('NATIVE_INVALID_PROOF');
      const payload=communityBytes(v.payload,24_000),domain=encoder.encode('agentstoz.community-access.request/v2\0'),message=new Uint8Array(domain.length+payload.length);message.set(domain);message.set(payload,domain.length);
      await verifyProof(c.controlKey,v.signature,message);await this.unchanged(c);return {payload:v.payload,signature:v.signature};
    }};
    const client=new CommunityAccessClient(c.authority.origin,c.authority.issuerPublicKey,signer,async(url,init)=>{
      await this.unchanged(c);this.live();const response=await this.fetcher(url,init);await this.unchanged(c);return response;
    },this.now);
    const reply=await client.exchange({operation,requestId:crypto.randomUUID(),observedAt:this.now(),nonce:communityBase64(crypto.getRandomValues(new Uint8Array(32))),
      actor:c.enrollmentId,args:[c.communityId,...extra]});await this.unchanged(c);return reply;
  }
  async authorization(purpose:CommunityMobileRelayPurpose):Promise<CommunityDeviceAuthorization>{
    if(!mobileControlPurpose(purpose))return fail('NATIVE_INVALID_PURPOSE');const c=await this.context();this.purpose(c,purpose);
    const reply=await this.exchange(c,purpose,'component-status'),a=await CommunityDeviceAuthorization.fromReply(reply,c.authority,
      {communityId:c.communityId,deviceId:c.deviceId,deviceKind:'desktop',enrollmentId:c.enrollmentId,revision:c.revision,purpose},this.now());this.own(c,a,purpose);
    const installed=await this.invoke({operation:'community-component-refresh',requestId:reply.requestId,envelope:reply.envelope});
    communityObject(installed,['success','halted','installed','revision','expiresAt']);
    if(installed.installed!==true||installed.revision!==a.body.revision||installed.expiresAt!==a.body.expiresAt)return fail('NATIVE_REFRESH_MISMATCH');
    await this.unchanged(c);this.own(c,a,purpose);this.keyEpoch??=a.body.keyEpoch;return a;
  }
  async directory(purpose:CommunityMobileRelayPurpose):Promise<CommunityDeviceAuthorization[]>{
    const own=await this.authorization(purpose),c=await this.context(),reply=await this.exchange(c,purpose,'component-directory');
    const directoryOwn=await CommunityDeviceAuthorization.fromReply(reply,c.authority,{communityId:c.communityId,deviceId:c.deviceId,deviceKind:'desktop',enrollmentId:c.enrollmentId,revision:c.revision,policyDigest:own.policyDigest,purpose},this.now());this.own(c,directoryOwn,purpose);
    if(!Array.isArray(reply.payload))return fail('NATIVE_DIRECTORY_MISMATCH');const result:CommunityDeviceAuthorization[]=[];
    for(const row of reply.payload){
      if(!row||typeof row!=='object'||!Array.isArray(row.capabilities)||!row.capabilities.includes(cap(purpose)))continue;
      result.push(await CommunityDeviceAuthorization.fromReply(reply,c.authority,{communityId:c.communityId,deviceId:row.deviceId,deviceKind:row.deviceKind,purpose},this.now()));
    }
    await this.unchanged(c);return result;
  }
  private async use(c:NativeCommunityMobileContext,purpose:CommunityMobileRelayPurpose,mobile:CommunityDeviceAuthorization,sessionId:string):Promise<CommunityMobileUseSession>{
    this.sameAuthority(c,mobile);if(mobile.body.deviceKind!=='mobile'||!mobile.permits(purpose,this.now())||!mobileControlUuid(sessionId))return fail('NATIVE_PRINCIPAL_MISMATCH');
    const args=communityComponentSessionArgs({communityId:c.communityId,purpose,mobileEnrollmentId:mobile.body.enrollmentId,sessionId});
    const reply=await this.exchange(c,purpose,'component-session',args.slice(1));
    const use=await CommunityMobileUseSession.fromReply(reply,mobile,{sessionId,purpose},this.now());await this.unchanged(c);return use;
  }
  async currentUse(purpose:CommunityMobileRelayPurpose,mobile:CommunityDeviceAuthorization,sessionId:string):Promise<CommunityMobileUseSession>{
    await this.authorization(purpose);return this.use(await this.context(),purpose,mobile,sessionId);
  }
  async ticket(purpose:CommunityMobileRelayPurpose,connectionId:string):Promise<CommunityRelayTicket>{
    if(!mobileControlUuid(connectionId))return fail('NATIVE_INVALID_CONNECTION');await this.authorization(purpose);const c=await this.context();
    const reply=await this.exchange(c,purpose,'component-ticket',[purpose,connectionId,'host']);
    const ticket=CommunityRelayTicket.fromReply(reply,{communityId:c.communityId,enrollmentId:c.enrollmentId,deviceId:c.deviceId,connectionId,publicKey:c.controlKey,purpose,role:'host',sessionId:null},this.now());
    await this.unchanged(c);return ticket;
  }
  async signRelayProof(purpose:CommunityMobileRelayPurpose,ticket:CommunityRelayTicket,challenge:string):Promise<Uint8Array>{
    if(!mobileControlPurpose(purpose)||!CommunityRelayTicket.isVerified(ticket))return fail('NATIVE_INVALID_TICKET');
    const challengeBytes=communityBytes(challenge,32);if(challengeBytes.length!==32)return fail('NATIVE_INVALID_CHALLENGE');
    await this.authorization(purpose);const c=await this.context();
    const reply=await CommunityAccessReply.verify(ticket.envelope,c.authority.issuerPublicKey,ticket.body.ticketId,this.now());
    const pinned=CommunityRelayTicket.fromReply(reply,{communityId:c.communityId,enrollmentId:c.enrollmentId,deviceId:c.deviceId,connectionId:ticket.body.connectionId,publicKey:c.controlKey,purpose,role:'host',sessionId:null},this.now());
    if(fingerprint(pinned.body)!==fingerprint(ticket.body))return fail('NATIVE_INVALID_TICKET');
    const answer=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'relay-bind',ticket:pinned.envelope,challenge}});
    const v=communityObject(answer,['success','halted','publicKey','signature']);if(v.publicKey!==c.controlKey)return fail('NATIVE_INVALID_PROOF');
    const bytes=await verifyProof(c.controlKey,v.signature,encoder.encode(JSON.stringify(['agentstoz.relay.bind/v2',pinned.body.ticketId,pinned.body.connectionId,challenge])));
    await this.unchanged(c);return bytes;
  }
  async signHandshake(purpose:CommunityMobileRelayPurpose,transcript:MobileControlTranscript,own:CommunityDeviceAuthorization,mobile:CommunityDeviceAuthorization,use:CommunityMobileUseSession):Promise<string>{
    if(!mobileControlPurpose(purpose))return fail('NATIVE_INVALID_PURPOSE');const t=Object.freeze({...transcript});await validateMobileControlTranscript(t);
    const refreshedOwn=await this.authorization(purpose),c=await this.context();this.own(c,own,purpose);this.sameAuthority(c,mobile);
    if(refreshedOwn.policyDigest!==own.policyDigest||!CommunityMobileUseSession.isVerified(use)||!use.permits(purpose,this.now())
      ||use.authorization.policyDigest!==mobile.policyDigest)return fail('NATIVE_PRINCIPAL_MISMATCH');
    const freshUse=await this.use(c,purpose,mobile,use.body.sessionId);
    if(freshUse.policyDigest!==use.policyDigest||t.purpose!==purpose||t.profileId!==c.profileId||t.communityId!==c.communityId
      ||t.receiverDeviceId!==c.deviceId||t.receiverEnrollmentId!==c.enrollmentId||t.receiverPolicyDigest!==own.policyDigest
      ||t.senderDeviceId!==mobile.body.deviceId||t.senderEnrollmentId!==mobile.body.enrollmentId||t.senderPolicyDigest!==mobile.policyDigest
      ||t.senderUseId!==freshUse.body.sessionId||t.senderUsePublicKey!==freshUse.body.publicKey||t.senderUsePolicyDigest!==freshUse.policyDigest)return fail('NATIVE_TRANSCRIPT_MISMATCH');
    const answer=await this.invoke({operation:'community-component-sign',purpose,payload:{kind:'mobile-host-handshake',transcript:t,
      ownAuthorization:refreshedOwn.envelope,controllerAuthorization:mobile.envelope,controllerUseSession:freshUse.envelope}});
    const v=communityObject(answer,['success','halted','publicKey','signature']);if(v.publicKey!==c.controlKey||typeof v.signature!=='string'
      ||!await verifyMobileControlProof(t,'host',c.controlKey,v.signature))return fail('NATIVE_INVALID_PROOF');
    await this.unchanged(c);this.own(c,refreshedOwn,purpose);if(!freshUse.isCurrent(this.now()))return fail('NATIVE_SESSION_EXPIRED');return v.signature;
  }
  close():void{this.stopped=true;}
}
