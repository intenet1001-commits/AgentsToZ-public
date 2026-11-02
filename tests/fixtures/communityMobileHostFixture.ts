// Software-only Native/consumer stand-ins. Never imported by a production entry point.
import {generateKeyPairSync,createECDH,createPrivateKey,createPublicKey,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CommunityAccessReply,CommunityRelayTicket,communityBase64,communityBytes,type CommunityMobileRelayPurpose} from '../../src/communityAccessClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from '../../src/communityMobilePrincipal';
import {CommunityRelayClient,type CommunityRelaySocketFactory,type CommunityRelayRecord} from '../../src/communityRelayClient';
import {CommunityMobileControlHost} from '../../src/communityMobileControlHost';import {CommunityMobileControlLedger} from '../../src/communityMobileControlLedger';
import type {CommunityMobileHostIdentity,CommunityMobileConsumers,CommunityMobileEffectGuard} from '../../src/communityMobileControlTypes';
import {createMobileControlEphemeral,deriveMobileControlKeys,mobileControlProofBytes,mobileControlConfirmation,verifyMobileControlConfirmation,verifyMobileControlProof,verifyMobileControlReady,
  sealMobileControlRecord,openMobileControlRecord,readMobileControlResponse,type MobileControlKeys,type MobileControlTranscript} from '../../src/communityMobileControlProtocol';
const pair=(scalar?:number)=>{if(scalar===undefined)return generateKeyPairSync('ec',{namedCurve:'prime256v1'});const raw=Buffer.alloc(32);raw.writeUInt32BE(scalar,28);const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(raw);const pub=ecdh.getPublicKey();const privateKey=createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',d:raw.toString('base64url'),x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33).toString('base64url')}});return {privateKey,publicKey:createPublicKey(privateKey)};};
export const point=(key:ReturnType<typeof pair>['publicKey'])=>{const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x!,'base64url'),Buffer.from(k.y!,'base64url')]).toString('base64url');};
export const signature=(key:ReturnType<typeof pair>['privateKey'],data:Uint8Array)=>sign('sha256',data,{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
const person=(mobile:boolean,scalar?:number)=>({mobile,id:randomUUID(),enrollment:randomUUID(),host:pair(),operation:pair(),bio:pair(),control:mobile?pair():pair(4),session:pair(scalar),sessionId:randomUUID(),active:true,revision:1});
export async function waitFor<T>(read:()=>T|Promise<T>,test:(v:T)=>boolean,timeout=2000):Promise<T>{const end=Date.now()+timeout;for(;;){const v=await read();if(test(v))return v;if(Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,5));}}
export function createMobileHostFixture(externalSockets?:CommunityRelaySocketFactory){
  const issuer=pair(11),profile=randomUUID(),community=randomUUID(),people=[person(false),person(true,3),person(true,13)],receiver=people[0]!,mobiles=people.slice(1),root=mkdtempSync(join(tmpdir(),'mobile-host-fixture-')),dataKey=randomBytes(32);
  const authority={origin:'https://mobile-fixture.workers.dev',issuerPublicKey:point(issuer.publicKey),profileId:profile};let offset=0,issueDelay=0;
  const now=()=>Date.now()+offset;const caps=['agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'];
  const state={localOff:false,denyScope:false,throwRun:false,oversize:false,effects:0,prepared:0,lookup:0,ledgerOpens:0,ledgerFailure:null as string|null,ledgerPurposes:[] as CommunityMobileRelayPurpose[],lastGuard:null as CommunityMobileEffectGuard|null,
    block:undefined as undefined|Promise<void>,blockBeforeGuard:false,dropResponses:false};
  const signed=(kind:string,id:string,payload:any,at=now())=>{const bytes=Buffer.from(JSON.stringify([2,kind,id,at,payload]));return {payload:bytes.toString('base64url'),signature:signature(issuer.privateKey,Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]))};};
  const body=(p:typeof receiver)=>({version:1,communityId:community,profileId:profile,enrollmentId:p.enrollment,deviceId:p.id,deviceKind:p.mobile?'mobile':'desktop',name:p.mobile?'Mobile fixture':'Main fixture',
    hostPublicKey:point(p.host.publicKey),publicKey:point(p.operation.publicKey),biometricPublicKey:point(p.bio.publicKey),controlKey:p.mobile?null:point(p.control.publicKey),agentDeviceId:p.mobile?null:randomPortal,
    capabilities:caps,revision:p.revision,keyEpoch:1,issuedAt:now()-issueDelay,expiresAt:now()-issueDelay+90_000});
  const randomPortal=randomUUID();
  const auth=async(p:typeof receiver)=>{const b=body(p);return CommunityDeviceAuthorization.fromEnvelope(signed('authorization',randomUUID(),b,b.issuedAt),authority,{communityId:community,deviceId:p.id,deviceKind:p.mobile?'mobile':'desktop'},now());};
  const use=async(p:typeof receiver,a:CommunityDeviceAuthorization)=>{if(!p.active)throw Error('SESSION_EXPIRED');const at=now()-issueDelay,b={version:1,communityId:community,enrollmentId:p.enrollment,sessionId:p.sessionId,publicKey:point(p.session.publicKey),capabilities:caps,revision:p.revision,sequence:0,lastHumanAt:at,idleExpiresAt:at+3_600_000,issuedAt:at,expiresAt:at+90_000};
    return CommunityMobileUseSession.fromEnvelope(signed('session',randomUUID(),b,at),a,{sessionId:p.sessionId},now());};
  const ticket=async(p:typeof receiver,purpose:CommunityMobileRelayPurpose,connectionId:string,role:'host'|'client')=>{const at=now(),id=randomUUID(),b={version:1,ticketId:id,communityId:community,enrollmentId:p.enrollment,deviceId:p.id,deviceKind:p.mobile?'mobile':'desktop',
    connectionId,publicKey:point((p.mobile?p.session:p.control).publicKey),purpose,role,sessionId:p.mobile?p.sessionId:null,revision:p.revision,issuedAt:at,expiresAt:at+30_000,leaseExpiresAt:at+90_000};
    const reply=await CommunityAccessReply.verify(signed('ticket',id,b,at),authority.issuerPublicKey,id,at);return CommunityRelayTicket.fromReply(reply,{communityId:community,enrollmentId:p.enrollment,deviceId:p.id,connectionId,publicKey:b.publicKey,purpose,role,sessionId:b.sessionId},at);};
  const identity:CommunityMobileHostIdentity={context:async()=>{if(state.localOff)throw Error('native off');return {authority,communityId:community,profileId:profile,enrollmentId:receiver.enrollment,deviceId:receiver.id,controlKey:point(receiver.control.publicKey),agentDeviceId:randomPortal,revision:receiver.revision,capabilities:[...caps].sort()};},
    authorization:async()=>{if(state.localOff)throw Error('native off');return auth(receiver);},directory:async()=>Promise.all(people.filter(p=>p.active).map(auth)),
    currentUse:async(_purpose,a,id)=>{if(state.localOff)throw Error('native off');const p=mobiles.find(p=>p.id===a.body.deviceId&&p.enrollment===a.body.enrollmentId);if(!p||p.sessionId!==id)throw Error('SESSION_EXPIRED');return use(p,a);},
    ticket:(purpose,id)=>ticket(receiver,purpose,id,'host'),signRelayProof:async(_p,t,challenge)=>Buffer.from(signature(receiver.control.privateKey,Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',t.body.ticketId,t.body.connectionId,challenge]))),'base64url'),
    signHandshake:async(_p,t)=>signature(receiver.control.privateKey,mobileControlProofBytes(t,'host'))};
  type Peer={body:any;challenge:string;ready:boolean;message:(s:string)=>void;close:()=>void};const peers=new Set<Peer>();
  const sockets=externalSockets??{open:async input=>{
    const b=JSON.parse(Buffer.from(input.authorization.slice(10).split('.')[0]!,'base64url').toString())[4],peer:Peer={body:b,challenge:randomBytes(32).toString('base64url'),ready:false,message:input.onMessage,close:input.onClose};peers.add(peer);
    queueMicrotask(()=>peer.message(JSON.stringify({type:'challenge',ticketId:b.ticketId,connectionId:b.connectionId,challenge:peer.challenge})));
    return {bufferedAmount:0,close:()=>{peers.delete(peer);peer.close();for(const x of peers)if(x.ready)x.message(JSON.stringify({type:'peer-ended',from:b.deviceId,fromConnection:b.connectionId}));},send:text=>{
      const r=JSON.parse(text);if(r.type==='proof'){
        const p=people.find(p=>p.id===b.deviceId)!;if(!verify('sha256',Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',b.ticketId,b.connectionId,peer.challenge])),{key:(p.mobile?p.session:p.control).publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(r.signature,'base64url')))return peer.close();
        peer.ready=true;queueMicrotask(()=>peer.message(JSON.stringify({type:'ready',connectionId:b.connectionId,leaseExpiresAt:b.leaseExpiresAt})));return;
      }
      if(r.type==='authorize'){peer.body=JSON.parse(Buffer.from(r.ticket.payload,'base64url').toString())[4];queueMicrotask(()=>peer.message(JSON.stringify({type:'authorized',leaseExpiresAt:peer.body.leaseExpiresAt})));return;}
      let reachable=false;for(const other of peers)if(other.ready&&other.body.deviceId===r.to&&other.body.purpose===b.purpose&&other.body.role!==b.role){reachable=true;if(!(state.dropResponses&&b.role==='host'))queueMicrotask(()=>other.message(JSON.stringify({type:'data',from:b.deviceId,fromConnection:b.connectionId,id:r.id,ciphertext:r.ciphertext})));}
      queueMicrotask(()=>peer.message(JSON.stringify({type:'forwarded',id:r.id,reachable})));
    }};
  }} satisfies CommunityRelaySocketFactory;
  const backend=new Map<string,unknown>();
  const consumers:CommunityMobileConsumers={capabilities:()=>[{op:'count',mode:'effect',label:'Synthetic effect'},{op:'read',mode:'query',label:'Synthetic query'}],
    prepare:async(_principal,_p,mode,command)=>{++state.prepared;if(state.denyScope||!['count','read'].includes(command.op as string)||mode==='query'&&command.op!=='read'||mode==='effect'&&command.op!=='count')throw Error('private/path/must-not-escape');
      return {scope:'fixture-private-scope',run:async guard=>{state.lastGuard=guard;if(state.blockBeforeGuard&&state.block)await state.block;await guard.beforeEffect();
        if(mode==='effect'){++state.effects;const value={outcome:'done',count:state.effects};backend.set(guard.operationId!,value);if(state.throwRun)throw Error('secret/backend/error');if(state.oversize)return {text:'x'.repeat(16_001)};if(state.block&&!state.blockBeforeGuard)await state.block;return value;}if(state.block)await state.block;return {outcome:'value',count:state.effects};}};},
    authorizeReceipt:async()=>!state.denyScope,readReceipt:async(_p,_purpose,_scope,id)=>{++state.lookup;return backend.has(id)?{state:'result',result:backend.get(id)}:{state:'unknown'};}};
  let host:CommunityMobileControlHost;
  const makeHost=()=>new CommunityMobileControlHost(identity,consumers,sockets,async (own,purpose)=>{++state.ledgerOpens;state.ledgerPurposes.push(purpose);if(state.ledgerFailure)throw Error(state.ledgerFailure);return new CommunityMobileControlLedger(root,{profileId:own.body.profileId,communityId:own.body.communityId,deviceId:own.body.deviceId},dataKey,now);},{clock:now});
  host=makeHost();const clients:MobileHostFixtureClient[]=[];
  const client=async(index=0,purpose:CommunityMobileRelayPurpose='mobile-agent')=>{const p=mobiles[index]!;const c=new MobileHostFixtureClient(p,receiver.id,purpose,sockets,()=>auth(p),a=>use(p,a),()=>auth(receiver),id=>ticket(p,purpose,id,'client'),now);clients.push(c);await c.connect();return c;};
  return {issuer,authority,people,receiver,mobiles,state,identity,consumers,root,dataKey,now,auth,use,ticket,signed,get host(){return host;},client,
    addMobile:()=>{const p=person(true);people.push(p);mobiles.push(p);return p;},
    advance:(ms:number)=>{offset+=ms;},issueDelay:(ms:number)=>{issueDelay=ms;},restart:async()=>{host.close();host=makeHost();await host.start();},
    seed:()=>({community,profile,people:people.map(p=>({auth:body(p),session:p.mobile?{id:p.sessionId,communityId:community,enrollmentId:p.enrollment,publicKey:point(p.session.publicKey),capabilities:caps,sequence:0,lastHumanAt:now(),expiresAt:now()+3_600_000,closed:false,revision:p.revision}:null}))}),
    close:async()=>{for(const c of clients)c.close();host.close();await new Promise(r=>setTimeout(r,20));dataKey.fill(0);rmSync(root,{recursive:true,force:true});}};
}

type MobileFixturePerson=ReturnType<typeof person>;
export class MobileHostFixtureClient {
  readonly packets:any[]=[];relay!:CommunityRelayClient;private connection='';private channel=crypto.randomUUID();private messages:any[]=[];private keys?:MobileControlKeys;private transcript?:MobileControlTranscript;private sendSeq=0;private recvSeq=0;
  constructor(readonly person:MobileFixturePerson,private readonly target:string,readonly purpose:CommunityMobileRelayPurpose,sockets:CommunityRelaySocketFactory,
    private readonly auth:()=>Promise<CommunityDeviceAuthorization>,private readonly use:(a:CommunityDeviceAuthorization)=>Promise<CommunityMobileUseSession>,private readonly own:()=>Promise<CommunityDeviceAuthorization>,
    ticket:(connection:string)=>Promise<CommunityRelayTicket>,private readonly now:()=>number){
    let last:CommunityRelayTicket;
    // The real client is created by connect() after the issuer-certified subjects are known.
    this.make=(a,u)=>new CommunityRelayClient(a.authority.origin,{communityId:a.body.communityId,enrollmentId:a.body.enrollmentId,deviceId:a.body.deviceId,purpose,role:'client',sessionId:u.body.sessionId},
      {publicKey:u.body.publicKey,signRelayProof:async ({challenge})=>Buffer.from(signature(person.session.privateKey,Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',last.body.ticketId,last.body.connectionId,challenge]))),'base64url')},
      async id=>{this.connection=id;last=await ticket(id);return last;},sockets,record=>this.receive(record),()=>{},now);
  }
  private make:(a:CommunityDeviceAuthorization,u:CommunityMobileUseSession)=>CommunityRelayClient;
  private receive(record:CommunityRelayRecord){if(record.from!==this.target)return;const value=JSON.parse(new TextDecoder().decode(communityBytes(record.ciphertext,34_000)));this.messages.push({value,from:record.from,connection:record.fromConnection});this.packets.push(value);}
  async next(type:string,timeout=2000){return waitFor(()=>{const i=this.messages.findIndex(m=>m.value.type===type);return i<0?null:this.messages.splice(i,1)[0];},v=>v!==null,timeout);}
  async send(value:unknown){return this.relay.sendRecord({to:this.target,id:randomUUID(),ciphertext:communityBase64(new TextEncoder().encode(JSON.stringify(value)))});}
  async connect(){const a=await this.auth(),u=await this.use(a);(this as any).relay=this.make(a,u);await this.relay.connect();}
  async hello(patch:Record<string,unknown>={}){
    const a=await this.auth(),u=await this.use(a),own=await this.own(),ephemeral=await createMobileControlEphemeral();
    await this.send({v:2,type:'hello',purpose:this.purpose,channelId:this.channel,senderAuthorization:a.envelope,senderUseSession:u.envelope,expectedReceiver:{deviceId:own.body.deviceId,enrollmentId:own.body.enrollmentId,policyDigest:own.policyDigest},
      senderConnectionId:this.connection,receiverConnectionId:null,senderEphemeral:ephemeral.publicKey,senderNonce:communityBase64(crypto.getRandomValues(new Uint8Array(32))),...patch});
    return {a,u,own,ephemeral};
  }
  async handshake(){const h=await this.hello(),challenge=(await this.next('challenge'))!,t=challenge.value.transcript as MobileControlTranscript;
    if(t.senderConnectionId!==this.connection||t.receiverConnectionId!==challenge.connection||t.senderPolicyDigest!==h.a.policyDigest||t.senderUsePolicyDigest!==h.u.policyDigest||t.receiverPolicyDigest!==h.own.policyDigest||!await verifyMobileControlProof(t,'host',h.own.body.controlKey!,challenge.value.hostProof))throw Error('fixture host binding');
    const keys=await deriveMobileControlKeys(h.ephemeral.privateKey,t.receiverEphemeral,t);if(!await verifyMobileControlConfirmation(keys,'host',challenge.value.hostProof,challenge.value.hostConfirmation))throw Error('fixture host confirmation');
    const clientProof=signature(this.person.session.privateKey,mobileControlProofBytes(t,'client'));
    await this.send({v:2,type:'finish',channelId:this.channel,clientProof,clientConfirmation:await mobileControlConfirmation(keys,'client',clientProof)});
    const ready=(await this.next('ready'))!;if(!await verifyMobileControlReady(keys,clientProof,challenge.value.hostProof,ready.value.confirmation))throw Error('fixture ready confirmation');this.keys=keys;this.transcript=t;
  }
  async dispatch(request:Record<string,unknown>){const requestId=randomUUID();await this.send(await sealMobileControlRecord(this.keys!,this.transcript!,'client',++this.sendSeq,requestId,{v:1,kind:'request',requestId,...request}));return requestId;}
  async result(requestId:string,timeout=2000){const record=await waitFor(()=>{const i=this.messages.findIndex(m=>m.value.type==='record'&&m.value.requestId===requestId);return i<0?null:this.messages.splice(i,1)[0];},v=>v!==null,timeout);
    const clear=await openMobileControlRecord(this.keys!,this.transcript!,'host',++this.recvSeq,record!.value);return readMobileControlResponse(clear,requestId);}
  close(){this.relay?.close();}
}
