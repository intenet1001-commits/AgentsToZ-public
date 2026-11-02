import {communityBase64,communityBytes,communityObject,COMMUNITY_MOBILE_RELAY_PURPOSES,type CommunityMobileRelayPurpose,type CommunityRelayTicket} from './communityAccessClient';
import {CommunityRelayClient,type CommunityRelayRecord,type CommunityRelaySocketFactory} from './communityRelayClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from './communityMobilePrincipal';
import {CommunityMobileControlLedger,type MobileControlReceipt} from './communityMobileControlLedger';
import {createMobileControlEphemeral,deriveMobileControlKeys,mobileControlConfirmation,mobileControlHash,mobileControlReady,
  mobileControlUuid,openMobileControlRecord,parseMobileControlHello,parseMobileControlRequest,sealMobileControlRecord,
  validateMobileControlTranscript,verifyMobileControlConfirmation,verifyMobileControlProof,MOBILE_CONTROL_MAX_RESULT,
  type MobileControlKeys,type MobileControlTranscript,type MobileControlRequest} from './communityMobileControlProtocol';
import type {CommunityMobileConsumers,CommunityMobileEffectGuard,CommunityMobileHostIdentity,CommunityMobilePrincipal,CommunityMobileCommandDescriptor} from './communityMobileControlTypes';

export interface CommunityMobileHostOptions {clock?:()=>number;bootId?:string;instance?:string;refreshMs?:number}
interface Link {purpose:CommunityMobileRelayPurpose;client:CommunityRelayClient;connection:string;ticket?:CommunityRelayTicket;ended:boolean;ready:boolean;own:CommunityDeviceAuthorization}
interface Channel {
  id:string;purpose:CommunityMobileRelayPurpose;from:string;connection:string;receiverConnection:string;phase:'pending'|'active'|'closed';
  principal?:CommunityMobilePrincipal;transcript?:MobileControlTranscript;keys?:MobileControlKeys;hostProof?:string;
  timer?:ReturnType<typeof setTimeout>;working:boolean;sendSeq:number;receiveSeq:number;
}
const utf8=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const purposeCap=(p:CommunityMobileRelayPurpose)=>({'mobile-agent':'agent.communicate','mobile-teams':'teams.run','mobile-agent-settings':'computer-use.agent-settings','mobile-browser':'computer-use.browser'}[p]);
const epoch=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const key=(p:string,id:string)=>p+'\0'+id;
function fail(code:string):never{throw new Error(code);}
function canonical(value:unknown,maximum=MOBILE_CONTROL_MAX_RESULT):string {
  const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort((v as Record<string,unknown>)[k])])):v;
  const text=JSON.stringify(sort(value));if(typeof text!=='string'||utf8.encode(text).length>maximum)fail('MOBILE_RESULT_UNAVAILABLE');return text;
}
const code=(error:unknown)=>['MOBILE_STORE_FULL','MOBILE_OPERATION_EXPIRED','MOBILE_OPERATION_ID_CONFLICT','MOBILE_OPERATION_RESULT_CONFLICT'].includes((error as Error)?.message)?(error as Error).message:'MOBILE_REQUEST_REFUSED';

/** Mobile-only receiver. A ready cryptographic channel is still subject to current Native and consumer scope checks. */
export class CommunityMobileControlHost {
  private readonly now:()=>number;private readonly boot:string;private readonly instance:string;private readonly refreshMs:number;
  private readonly links=new Map<CommunityMobileRelayPurpose,Link>();private readonly channels=new Map<string,Channel>();
  private readonly pending=new Set<Channel>();private readonly queues=new Map<string,{count:number;tail:Promise<void>}>();
  private readonly running=new Map<string,{ledger:CommunityMobileControlLedger;owner:string;id:string}>();
  private readonly errors=new Map<CommunityMobileRelayPurpose,string>();private closed=false;private refreshing?:Promise<void>;private interval?:ReturnType<typeof setInterval>;
  private ledger?:Promise<CommunityMobileControlLedger>;private ledgerScope?:string;
  constructor(private readonly identity:CommunityMobileHostIdentity,private readonly consumers:CommunityMobileConsumers,private readonly sockets:CommunityRelaySocketFactory,
    private readonly ledgerFactory:(receiver:CommunityDeviceAuthorization,purpose:CommunityMobileRelayPurpose)=>Promise<CommunityMobileControlLedger>,options:CommunityMobileHostOptions={}){
    this.now=options.clock??Date.now;this.boot=options.bootId??epoch();this.instance=options.instance??epoch();this.refreshMs=options.refreshMs??15_000;
    if(!/^[a-f0-9]{32}$/.test(this.boot)||!/^[a-f0-9]{32}$/.test(this.instance)||this.boot===this.instance||!Number.isSafeInteger(this.refreshMs)||this.refreshMs<1000||this.refreshMs>60_000)fail('MOBILE_HOST_OPTIONS');
  }
  status(){const purposes=COMMUNITY_MOBILE_RELAY_PURPOSES.map(p=>({purpose:p,connected:this.links.get(p)?.ready===true&&!this.links.get(p)!.ended,supported:this.descriptors(p).length>0,code:this.errors.get(p)??null}));
    return {closed:this.closed,phase:this.closed?'closed':purposes.some(p=>p.connected&&p.supported)?'ready':'unsupported',pendingHandshakes:this.pending.size,activeChannels:[...this.channels.values()].filter(c=>c.phase==='active').length,purposes};}
  async start():Promise<void>{
    if(this.closed)return;if(!this.interval){this.interval=setInterval(()=>{void this.refresh();},this.refreshMs);this.interval.unref?.();}await this.refresh();
  }
  private refresh():Promise<void>{
    if(this.closed)return Promise.resolve();if(this.refreshing)return this.refreshing;
    const task=(async()=>{
      let context:Awaited<ReturnType<CommunityMobileHostIdentity['context']>>;
      try{context=await this.identity.context();}catch{for(const p of COMMUNITY_MOBILE_RELAY_PURPOSES)this.endLink(p,'MOBILE_NATIVE_UNAVAILABLE');return;}
      for(const p of COMMUNITY_MOBILE_RELAY_PURPOSES){
        if(this.closed)return;if(!context.capabilities.includes(purposeCap(p))){this.endLink(p,'MOBILE_PURPOSE_UNAVAILABLE');continue;}
        try{const own=await this.identity.authorization(p);if(this.closed)return;if(!CommunityDeviceAuthorization.isVerified(own)||!own.permits(p,this.now())||own.body.deviceKind!=='desktop'||own.body.deviceId!==context.deviceId||own.body.communityId!==context.communityId)fail('MOBILE_NATIVE_UNAVAILABLE');
          this.errors.delete(p);if(!this.links.has(p))await this.connect(p,own);
        }catch{this.endLink(p,'MOBILE_NATIVE_UNAVAILABLE');}
      }
    })();this.refreshing=task;void task.finally(()=>{if(this.refreshing===task)this.refreshing=undefined;}).catch(()=>{});return task;
  }
  private async connect(purpose:CommunityMobileRelayPurpose,own:CommunityDeviceAuthorization){
    let link:Link;
    const client=new CommunityRelayClient(own.authority.origin,{communityId:own.body.communityId,enrollmentId:own.body.enrollmentId,deviceId:own.body.deviceId,purpose,role:'host',sessionId:null},
      {publicKey:own.body.controlKey!,signRelayProof:({challenge})=>this.identity.signRelayProof(purpose,link.ticket!,challenge)},
      async connection=>{link.connection=connection;const ticket=await this.identity.ticket(purpose,connection);link.ticket=ticket;return ticket;},this.sockets,
      record=>this.enqueue(link,record),()=>{if(this.links.get(purpose)===link)this.endLink(purpose,'MOBILE_RELAY_ENDED');},this.now,
      peer=>{for(const c of this.channels.values())if(c.purpose===purpose&&c.from===peer.from&&c.connection===peer.fromConnection)this.drop(c);});
    link={purpose,client,connection:'',ended:false,ready:false,own};this.links.set(purpose,link);
    try{await client.connect();link.ready=true;if(this.closed||this.links.get(purpose)!==link){client.close();return;}}catch(error){if(this.links.get(purpose)===link)this.endLink(purpose,'MOBILE_RELAY_UNAVAILABLE');throw error;}
  }
  private endLink(purpose:CommunityMobileRelayPurpose,reason:string){
    this.errors.set(purpose,reason);const link=this.links.get(purpose);if(link){this.links.delete(purpose);link.ended=true;link.client.close();}
    for(const c of [...this.channels.values()])if(c.purpose===purpose)this.drop(c);
  }
  private alive(c:Channel){return !this.closed&&c.phase!=='closed'&&this.channels.get(key(c.purpose,c.id))===c&&this.links.get(c.purpose)?.connection===c.receiverConnection;}
  private drop(c:Channel){if(this.channels.get(key(c.purpose,c.id))===c)this.channels.delete(key(c.purpose,c.id));c.phase='closed';c.keys=undefined;if(c.timer)clearTimeout(c.timer);if(!c.working)this.pending.delete(c);}
  private enqueue(link:Link,incoming:CommunityRelayRecord){
    if(this.closed||this.links.get(link.purpose)!==link)return;const record={...incoming},receivedAt=this.now(),id=key(link.purpose,record.from+'\0'+record.fromConnection);
    let queue=this.queues.get(id);if(!queue){if(this.queues.size>=64)return;queue={count:0,tail:Promise.resolve()};this.queues.set(id,queue);}if(queue.count>=8)return;
    ++queue.count;const q=queue;q.tail=q.tail.then(async()=>{if(this.closed||this.links.get(link.purpose)!==link)return;
      let value:unknown;try{value=JSON.parse(decode.decode(communityBytes(record.ciphertext,34_000)));}catch{return;}
      if(!value||typeof value!=='object'||Array.isArray(value))return;const packet=value as Record<string,any>;
      if(packet.type==='hello'){await this.hello(link,record,packet).catch(()=>{});return;}
      if(!mobileControlUuid(packet.channelId))return;const c=this.channels.get(key(link.purpose,packet.channelId));
      if(!c||c.from!==record.from||c.connection!==record.fromConnection)return;
      try{if(packet.type==='finish'&&c.phase==='pending')await this.finish(c,packet);else if(packet.type==='record'&&c.phase==='active')await this.record(c,packet,receivedAt);else if(c.phase==='active')this.drop(c);}catch{this.drop(c);}
    }).catch(()=>{}).finally(()=>{--q.count;if(q.count===0&&this.queues.get(id)===q)this.queues.delete(id);});
  }
  private async send(c:Channel,value:unknown){
    if(!this.alive(c))fail('MOBILE_CHANNEL_ENDED');const bytes=utf8.encode(JSON.stringify(value));if(bytes.length>34_000)fail('MOBILE_WIRE_TOO_LARGE');
    const link=this.links.get(c.purpose)!;await link.client.sendRecord({to:c.from,id:crypto.randomUUID(),ciphertext:communityBase64(bytes)});if(!this.alive(c))fail('MOBILE_CHANNEL_ENDED');
  }
  private async hello(link:Link,record:CommunityRelayRecord,value:unknown){
    const h=parseMobileControlHello(value);if(h.purpose!==link.purpose||h.senderConnectionId!==record.fromConnection||h.receiverConnectionId!==null&&h.receiverConnectionId!==link.connection
      ||this.channels.has(key(link.purpose,h.channelId))||this.pending.size>=8)return;
    if([...this.channels.values()].some(c=>c.phase==='pending'&&c.purpose===link.purpose&&c.from===record.from))return;
    const active=[...this.channels.values()].filter(c=>c.phase==='active');if(active.length>=32&&!active.some(c=>c.purpose===link.purpose&&c.from===record.from))return;
    const c:Channel={id:h.channelId,purpose:link.purpose,from:record.from,connection:record.fromConnection,receiverConnection:link.connection,phase:'pending',working:true,sendSeq:0,receiveSeq:0};
    this.channels.set(key(c.purpose,c.id),c);this.pending.add(c);c.timer=setTimeout(()=>this.drop(c),10_000);c.timer.unref?.();
    try{
      const own=await this.identity.authorization(c.purpose);if(!this.alive(c))return;
      if(!CommunityDeviceAuthorization.isVerified(own)||own.body.deviceKind!=='desktop'||!own.permits(c.purpose,this.now())||own.policyDigest!==link.own.policyDigest||JSON.stringify(own.authority)!==JSON.stringify(link.own.authority))fail('MOBILE_NATIVE_UNAVAILABLE');
      if(h.expectedReceiver.deviceId!==own.body.deviceId||h.expectedReceiver.enrollmentId!==own.body.enrollmentId||h.expectedReceiver.policyDigest!==own.policyDigest||own.body.deviceId===record.from)fail('MOBILE_TARGET_MISMATCH');
      const mobile=await CommunityDeviceAuthorization.fromEnvelope(h.senderAuthorization,own.authority,{communityId:own.body.communityId,deviceId:record.from,deviceKind:'mobile',purpose:c.purpose},this.now());
      const advertised=await CommunityMobileUseSession.fromEnvelope(h.senderUseSession,mobile,{sessionId:JSON.parse(decode.decode(communityBytes(h.senderUseSession.payload,48_000)))[4]?.sessionId,purpose:c.purpose},this.now());
      const use=await this.identity.currentUse(c.purpose,mobile,advertised.body.sessionId);if(!this.alive(c))return;if(use.policyDigest!==advertised.policyDigest)fail('MOBILE_USE_MISMATCH');
      const forbidden=[mobile.body.hostPublicKey,mobile.body.publicKey,mobile.body.biometricPublicKey,use.body.publicKey,own.body.hostPublicKey,own.body.publicKey,own.body.biometricPublicKey,own.body.controlKey];
      if(forbidden.includes(h.senderEphemeral))fail('MOBILE_IDENTITY_KEY_REUSE');const ephemeral=await createMobileControlEphemeral();if(forbidden.includes(ephemeral.publicKey))fail('MOBILE_IDENTITY_KEY_REUSE');
      const t:MobileControlTranscript={version:2,purpose:c.purpose,profileId:own.body.profileId,communityId:own.body.communityId,channelId:c.id,senderKind:'mobile',receiverKind:'desktop',
        senderDeviceId:mobile.body.deviceId,receiverDeviceId:own.body.deviceId,senderEnrollmentId:mobile.body.enrollmentId,receiverEnrollmentId:own.body.enrollmentId,
        senderPolicyDigest:mobile.policyDigest,receiverPolicyDigest:own.policyDigest,senderUseId:use.body.sessionId,senderUsePublicKey:use.body.publicKey,senderUsePolicyDigest:use.policyDigest,
        senderConnectionId:c.connection,receiverConnectionId:c.receiverConnection,receiverBootId:this.boot,receiverInstance:this.instance,senderEphemeral:h.senderEphemeral,receiverEphemeral:ephemeral.publicKey,senderNonce:h.senderNonce,receiverNonce:communityBase64(crypto.getRandomValues(new Uint8Array(32)))};
      await validateMobileControlTranscript(t);const proof=await this.identity.signHandshake(c.purpose,t,own,mobile,use);if(!await verifyMobileControlProof(t,'host',own.body.controlKey!,proof))fail('MOBILE_INVALID_HOST_PROOF');
      const keys=await deriveMobileControlKeys(ephemeral.privateKey,h.senderEphemeral,t);if(!this.alive(c))return;
      c.principal={receiver:own,mobile,use};c.transcript=t;c.keys=keys;c.hostProof=proof;
      await this.send(c,{v:2,type:'challenge',transcript:t,receiverAuthorization:own.envelope,hostProof:proof,hostConfirmation:await mobileControlConfirmation(keys,'host',proof)});
    }catch(error){this.drop(c);throw error;}finally{c.working=false;if(c.phase==='closed')this.pending.delete(c);}
  }
  private async finish(c:Channel,value:unknown){
    const f=communityObject(value,['v','type','channelId','clientProof','clientConfirmation']);
    if(f.v!==2||f.type!=='finish'||f.channelId!==c.id||!c.keys||!c.transcript||!c.principal||typeof f.clientProof!=='string'||typeof f.clientConfirmation!=='string')fail('MOBILE_INVALID_FINISH');
    if(!await verifyMobileControlProof(c.transcript,'client',c.principal.use.body.publicKey,f.clientProof)||!await verifyMobileControlConfirmation(c.keys,'client',f.clientProof,f.clientConfirmation))fail('MOBILE_INVALID_CLIENT_PROOF');
    await this.fresh(c);if(!this.alive(c))return;
    const others=[...this.channels.values()].filter(x=>x!==c&&x.phase==='active'&&x.purpose===c.purpose&&x.from===c.from);
    if([...this.channels.values()].filter(x=>x.phase==='active').length-others.length>=32)fail('MOBILE_CHANNEL_LIMIT');
    // Only verified key possession and confirmation may replace an existing channel.
    for(const other of others)this.drop(other);c.phase='active';if(c.timer)clearTimeout(c.timer);this.pending.delete(c);
    await this.send(c,{v:2,type:'ready',channelId:c.id,confirmation:await mobileControlReady(c.keys!,f.clientProof,c.hostProof!)});
  }
  private async fresh(c:Channel):Promise<CommunityMobilePrincipal>{
    if(!this.alive(c)||!c.principal)fail('MOBILE_CHANNEL_ENDED');const initial=c.principal;
    try{
      const own=await this.identity.authorization(c.purpose);if(!this.alive(c))fail('MOBILE_CHANNEL_ENDED');
      const peers=await this.identity.directory(c.purpose);if(!this.alive(c))fail('MOBILE_CHANNEL_ENDED');
      const found=peers.filter(p=>CommunityDeviceAuthorization.isVerified(p)&&p.body.deviceKind==='mobile'&&p.body.deviceId===c.from&&p.body.enrollmentId===initial.mobile.body.enrollmentId);
      if(!CommunityDeviceAuthorization.isVerified(own)||found.length!==1||JSON.stringify(own.authority)!==JSON.stringify(initial.receiver.authority)||JSON.stringify(found[0]?.authority)!==JSON.stringify(initial.mobile.authority)||own.policyDigest!==initial.receiver.policyDigest||found[0]!.policyDigest!==initial.mobile.policyDigest||!own.permits(c.purpose,this.now())||!found[0]!.permits(c.purpose,this.now()))fail('MOBILE_POLICY_CHANGED');
      const use=await this.identity.currentUse(c.purpose,found[0]!,initial.use.body.sessionId);if(!this.alive(c)||!CommunityMobileUseSession.isVerified(use)||!use.permits(c.purpose,this.now())||use.policyDigest!==initial.use.policyDigest||use.receiptOwnerHash!==initial.mobile.receiptOwnerHash)fail('MOBILE_USE_CHANGED');
      c.principal={receiver:own,mobile:found[0]!,use};return c.principal;
    }catch(error){this.drop(c);throw error;}
  }
  private descriptors(purpose:CommunityMobileRelayPurpose):readonly CommunityMobileCommandDescriptor[]{
    try{const values=this.consumers.capabilities(purpose);if(!Array.isArray(values)||values.length>64)return [];const seen=new Set<string>();
      for(const d of values){communityObject(d,['op','mode','label']);if(!/^[a-z][a-z0-9.-]{0,63}$/.test(d.op)||!['query','effect'].includes(d.mode)||typeof d.label!=='string'||utf8.encode(d.label).length>160||/[\p{Cc}\p{Cf}]/u.test(d.label)||seen.has(d.op+'\0'+d.mode))return [];seen.add(d.op+'\0'+d.mode);}
      return values.map(d=>({...d}));
    }catch{return [];}
  }
  private async store(receiver:CommunityDeviceAuthorization,purpose:CommunityMobileRelayPurpose){
    const b=receiver.body,scope=JSON.stringify([b.profileId,b.communityId,b.deviceId]);if(this.ledgerScope&&scope!==this.ledgerScope)fail('MOBILE_STORE_BINDING');
    if(!this.ledger){
      this.ledgerScope=scope;
      const preparing=Promise.resolve().then(()=>this.ledgerFactory(receiver,purpose)).catch(error=>{
        // A failed first preparation reserved and executed nothing. Release only that factory promise, keeping the
        // receiver scope pinned; a later receipt read/new intent may retry the same protected storage policy.
        if(this.ledger===ready)this.ledger=undefined;
        throw error;
      });
      const ready=preparing.then(ledger=>{if(JSON.stringify([ledger.identity.profileId,ledger.identity.communityId,ledger.identity.deviceId])!==scope){ledger.close();fail('MOBILE_STORE_BINDING');}if(this.closed)ledger.close();return ledger;});
      this.ledger=ready;
    }
    const ledger=await this.ledger;if(this.closed)fail('MOBILE_HOST_CLOSED');return ledger;
  }
  private async response(c:Channel,requestId:string,raw:string){
    if(utf8.encode(raw).length>MOBILE_CONTROL_MAX_RESULT)fail('MOBILE_RESULT_UNAVAILABLE');await this.fresh(c);
    const seq=++c.sendSeq,record=await sealMobileControlRecord(c.keys!,c.transcript!,'host',seq,requestId,{v:1,kind:'response',requestId,result:communityBase64(utf8.encode(raw)),resultDigest:mobileControlHash(raw)});await this.send(c,record);
  }
  private async receipt(c:Channel,r:Extract<MobileControlRequest,{mode:'receipt'|'consumed'}>,ledger:CommunityMobileControlLedger):Promise<string>{
    const principal=await this.fresh(c),owner=principal.mobile.receiptOwnerHash,row=ledger.get(owner,r.operationId);
    if(!row)return canonical({outcome:ledger.missingState(r.operationId),operationId:r.operationId,createdAt:r.createdAt});
    if(row.createdAt!==r.createdAt||row.purpose!==c.purpose||!await this.consumers.authorizeReceipt(principal,c.purpose,row.scope))return canonical({outcome:'refused',code:'MOBILE_RECEIPT_SCOPE_DENIED'});
    if(r.mode==='consumed')return canonical(ledger.consume(owner,r.operationId,r.createdAt,r.resultDigest)?{outcome:'consumed',operationId:r.operationId,createdAt:r.createdAt}:{outcome:'refused',code:'MOBILE_CONSUMPTION_MISMATCH'});
    if(row.state==='done')return row.result??canonical({outcome:'consumed',operationId:r.operationId,createdAt:r.createdAt});
    if(this.consumers.readReceipt){
      const recovered=await this.consumers.readReceipt(principal,c.purpose,row.scope,row.operationId,row.createdAt);
      await this.fresh(c);if(recovered.state==='result'){const text=canonical(recovered.result);return ledger.settle(owner,row.operationId,text).result!;}
      if(recovered.state==='unknown')ledger.unknown(owner,row.operationId);return canonical({outcome:recovered.state,operationId:row.operationId,createdAt:row.createdAt});
    }
    return canonical({outcome:row.state,operationId:row.operationId,createdAt:row.createdAt});
  }
  private async record(c:Channel,packet:Record<string,any>,receivedAt:number){
    const value=await openMobileControlRecord(c.keys!,c.transcript!,'client',c.receiveSeq+1,packet);++c.receiveSeq;
    const r=parseMobileControlRequest(value,packet.requestId),deadline=receivedAt+10_000;let raw:string;
    const principal=await this.fresh(c);
    if(r.mode==='receipt'||r.mode==='consumed'){
      try{raw=await this.receipt(c,r,await this.store(principal.receiver,c.purpose));}catch{raw=canonical({outcome:'unknown',operationId:r.operationId,createdAt:r.createdAt,code:'MOBILE_RECEIPT_UNAVAILABLE'});}
      await this.response(c,r.requestId,raw);return;
    }
    if(r.mode==='query'&&r.command.op==='capabilities'){
      raw=Object.keys(r.command).length===1?canonical({outcome:'capabilities',purpose:c.purpose,commands:this.descriptors(c.purpose)}):canonical({outcome:'refused',code:'MOBILE_INVALID_COMMAND'});
      await this.response(c,r.requestId,raw);return;
    }
    let prepared:Awaited<ReturnType<CommunityMobileConsumers['prepare']>>;
    try{prepared=await this.consumers.prepare(principal,c.purpose,r.mode,r.command);if(typeof prepared.scope!=='string'||utf8.encode(prepared.scope).length>1024||typeof prepared.run!=='function')fail('MOBILE_COMMAND_REFUSED');}
    catch{await this.response(c,r.requestId,canonical({outcome:'refused',code:'MOBILE_COMMAND_REFUSED'}));return;}
    const guard:CommunityMobileEffectGuard={operationId:r.mode==='effect'?r.operationId:null,createdAt:r.mode==='effect'?r.createdAt:null,
      active:()=>this.alive(c)&&c.phase==='active'&&this.now()<=deadline,
      beforeEffect:async()=>{if(!guard.active())fail('MOBILE_EFFECT_DEADLINE');const current=await this.fresh(c);const check=await this.consumers.prepare(current,c.purpose,r.mode,r.command);if(!guard.active()||check.scope!==prepared.scope)fail('MOBILE_SCOPE_CHANGED');}};
    if(r.mode==='query'){
      try{await guard.beforeEffect();raw=canonical(await prepared.run(guard));}catch{raw=canonical({outcome:'unknown',code:'MOBILE_QUERY_UNAVAILABLE'});}await this.response(c,r.requestId,raw);return;
    }
    const ledger=await this.store(principal.receiver,c.purpose),owner=principal.mobile.receiptOwnerHash;let receipt:MobileControlReceipt;
    try{const reserved=ledger.reserve({owner,operationId:r.operationId,createdAt:r.createdAt,purpose:c.purpose,commandDigest:mobileControlHash(canonical(r.command,24_000)),scope:prepared.scope,executionBoot:this.boot});receipt=reserved.receipt;
      if(!reserved.fresh){raw=await this.receipt(c,{v:1,kind:'request',mode:'receipt',requestId:r.requestId,operationId:r.operationId,createdAt:r.createdAt},ledger);await this.response(c,r.requestId,raw);return;}
    }catch(error){await this.response(c,r.requestId,canonical({outcome:'refused',code:code(error)}));return;}
    const runningKey=owner+'\0'+r.operationId;this.running.set(runningKey,{ledger,owner,id:r.operationId});
    try{await guard.beforeEffect();const result=await prepared.run(guard);raw=canonical(result);if(this.closed)return;ledger.settle(owner,r.operationId,raw);}
    catch{if(!this.closed)ledger.unknown(owner,r.operationId);raw=canonical({outcome:'unknown',operationId:r.operationId,createdAt:r.createdAt,code:'MOBILE_EXECUTION_UNCERTAIN'});}
    finally{this.running.delete(runningKey);}
    if(this.alive(c))await this.response(c,r.requestId,raw!);
  }
  close(){
    if(this.closed)return;this.closed=true;if(this.interval)clearInterval(this.interval);
    for(const running of this.running.values())try{running.ledger.unknown(running.owner,running.id);}catch{}
    for(const c of [...this.channels.values()])this.drop(c);for(const link of this.links.values()){link.ended=true;link.client.close();}this.links.clear();this.queues.clear();
    void this.ledger?.then(ledger=>ledger.close()).catch(()=>{});
  }
}
