import {test,expect} from 'bun:test';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuthenticatedCommunityTransport,communityControlIdTime,type AuthenticatedCommunityIdentity,type AuthenticatedCommunityMembership} from '../src/authenticatedCommunityTransport';
import {CommunityAccessReply,CommunityRelayTicket,type CommunityAccessEnvelope} from '../src/communityAccessClient';
import {CommunityComponentAuthorization,communityComponentHandshakeBytes,type CommunityComponentHandshake,type CommunityComponentPurpose} from '../src/communityComponentIdentity';
import type {CommunityRelaySocketFactory} from '../src/communityRelayClient';
import {AgentDialogueHost} from '../src/agentDialogueHost';

const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const point=(key:ReturnType<typeof keys>['publicKey'])=>{const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x!,'base64url'),Buffer.from(k.y!,'base64url')]).toString('base64url');};
async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean,timeout=2000):Promise<T>{const deadline=Date.now()+timeout;for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)throw Error('fixture deadline');await new Promise(r=>setTimeout(r,5));}}
async function fixture(controlledClock=false){
  let moment=Date.now();const now=()=>controlledClock?moment:Date.now();
  const issuer=keys(),profile=randomUUID(),community=randomUUID(),room=randomUUID(),roots:string[]=[];
  const people=Array.from({length:3},()=>({cf:randomUUID(),portal:randomUUID(),endpoint:randomUUID(),enrollment:randomUUID(),host:keys(),operation:keys(),biometric:keys(),control:keys(),enabled:true}));
  const signed=(kind:string,id:string,payload:unknown)=>{const bytes=Buffer.from(JSON.stringify([2,kind,id,now(),payload]));return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]),{key:issuer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};};
  const auth=async(p:typeof people[number])=>{const at=now(),id=randomUUID();const wrapped=signed('authorization',id,{version:1,communityId:community,profileId:profile,enrollmentId:p.enrollment,
    deviceId:p.cf,agentDeviceId:p.portal,deviceKind:'desktop',name:'Software native fixture',hostPublicKey:point(p.host.publicKey),publicKey:point(p.operation.publicKey),
    biometricPublicKey:point(p.biometric.publicKey),controlKey:point(p.control.publicKey),capabilities:['agent.communicate','teams.run'],revision:1,keyEpoch:1,issuedAt:at,expiresAt:at+90_000});
    // Force one timestamp in the fixture's body and envelope as the production registry does.
    const fields=JSON.parse(Buffer.from(wrapped.payload,'base64url').toString());fields[3]=at;const bytes=Buffer.from(JSON.stringify(fields));wrapped.payload=bytes.toString('base64url');wrapped.signature=sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]),{key:issuer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return CommunityComponentAuthorization.fromReply(await CommunityAccessReply.verify(wrapped,point(issuer.publicKey),id,now()),profile,p.cf,now());};
  const identity=(p:typeof people[number]):AuthenticatedCommunityIdentity=>({
    context:async()=>{if(!p.enabled)throw Error('native off');return {communityId:community,profileId:profile,enrollmentId:p.enrollment,deviceId:p.cf,agentDeviceId:p.portal,publicKey:point(p.control.publicKey)};},
    relayOrigin:async()=>'https://fixture.workers.dev',
    currentAuthorization:async()=>{if(!p.enabled)throw Error('native off');return auth(p);},
    directory:async()=>Promise.all(people.filter(p=>p.enabled).map(auth)),
    verifyAuthorization:async(envelope,deviceId)=>{const fields=JSON.parse(Buffer.from(envelope.payload,'base64url').toString());return CommunityComponentAuthorization.fromReply(await CommunityAccessReply.verify(envelope,point(issuer.publicKey),fields[2],now()),profile,deviceId,now());},
    ticket:async(purpose,connectionId,role)=>{if(!p.enabled)throw Error('native off');const id=randomUUID(),at=now();const envelope=signed('ticket',id,{version:1,ticketId:id,communityId:community,enrollmentId:p.enrollment,deviceId:p.cf,deviceKind:'desktop',
      connectionId,publicKey:point(p.control.publicKey),purpose,role,sessionId:null,revision:1,issuedAt:at,expiresAt:at+30_000,leaseExpiresAt:at+90_000});
      const fields=JSON.parse(Buffer.from(envelope.payload,'base64url').toString());fields[3]=at;const bytes=Buffer.from(JSON.stringify(fields));envelope.payload=bytes.toString('base64url');envelope.signature=sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]),{key:issuer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
      return CommunityRelayTicket.fromReply(await CommunityAccessReply.verify(envelope,point(issuer.publicKey),id,now()),{communityId:community,enrollmentId:p.enrollment,deviceId:p.cf,connectionId,publicKey:point(p.control.publicKey),purpose,role,sessionId:null},now());},
    signRelayProof:async(_purpose,ticket,challenge)=>sign('sha256',Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',ticket.body.ticketId,ticket.body.connectionId,challenge])),{key:p.control.privateKey,dsaEncoding:'ieee-p1363'}),
    signHandshake:async(purpose,role,t,own,peer)=>{if(!p.enabled||own.body.deviceId!==p.cf||own.body.agentDeviceId!==p.portal||own.body.controlKey!==point(p.control.publicKey)
      ||t.purpose!==purpose||t[`${role}DeviceId`]!==p.cf||t[`${role}AgentDeviceId`]!==p.portal||!people.some(p=>p.enabled&&p.cf===peer.body.deviceId&&p.portal===peer.body.agentDeviceId))throw Error('native bound signature refused');
      return sign('sha256',communityComponentHandshakeBytes(t,role),{key:p.control.privateKey,dsaEncoding:'ieee-p1363'});},
  });
  type Peer={body:any;challenge:string;message:(text:string)=>void;close:()=>void;ready:boolean};
  const peers=new Set<Peer>(),wire:string[]=[];let dropHostRecords=false,dropClientRecords=false;
  const sockets:CommunityRelaySocketFactory={open:async input=>{
    const token=input.authorization.slice(10).split('.'),wrapped={payload:token[0]!,signature:token[1]!};const fields=JSON.parse(Buffer.from(wrapped.payload,'base64url').toString());
    const reply=await CommunityAccessReply.verify(wrapped,point(issuer.publicKey),fields[2],now()),body=reply.payload as any;
    const peer:Peer={body,challenge:randomBytes(32).toString('base64url'),message:input.onMessage,close:input.onClose,ready:false};peers.add(peer);
    queueMicrotask(()=>peer.message(JSON.stringify({type:'challenge',ticketId:body.ticketId,connectionId:body.connectionId,challenge:peer.challenge})));
    return {bufferedAmount:0,close:()=>{peers.delete(peer);peer.close();for(const other of peers)if(other.ready)other.message(JSON.stringify({type:'peer-ended',from:body.deviceId,fromConnection:body.connectionId}));},send:text=>{
      const packet=JSON.parse(text);if(packet.type==='proof'){
        const key=people.find(p=>point(p.control.publicKey)===body.publicKey)!.control.publicKey;
        if(!verify('sha256',Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',body.ticketId,body.connectionId,peer.challenge])),{key,dsaEncoding:'ieee-p1363'},Buffer.from(packet.signature,'base64url')))return peer.close();
        peer.ready=true;queueMicrotask(()=>peer.message(JSON.stringify({type:'ready',connectionId:body.connectionId,leaseExpiresAt:body.leaseExpiresAt})));return;
      }
      if(packet.type!=='data')return;wire.push(text);let reachable=false;
      for(const other of peers)if(other.ready&&other.body.deviceId===packet.to&&other.body.purpose===body.purpose&&other.body.role!==body.role){reachable=true;
        if(!((dropHostRecords&&body.role==='host')||(dropClientRecords&&body.role==='client')))queueMicrotask(()=>other.message(JSON.stringify({type:'data',from:body.deviceId,fromConnection:body.connectionId,id:packet.id,ciphertext:packet.ciphertext})));}
      queueMicrotask(()=>peer.message(JSON.stringify({type:'forwarded',id:packet.id,reachable})));
    }};
  }};
  const members=()=>people.filter(p=>p.enabled).map(p=>({endpointId:p.endpoint,deviceId:p.portal,name:'Fixture'}));
  const transports:AuthenticatedCommunityTransport[]=[],packets:{from:number;packet:Record<string,any>}[]=[];
  const make=(index:number,root?:string,teams=false)=>{const p=people[index]!;root??=mkdtempSync(join(tmpdir(),'authenticated-control-'));if(!roots.includes(root))roots.push(root);
    const transport=new AuthenticatedCommunityTransport(root,identity(p),sockets,teams,now);
    const internal=transport as any,seal=internal.seal.bind(transport);internal.seal=(channel:any,packet:Record<string,any>)=>{packets.push({from:index,packet:structuredClone(packet)});return seal(channel,packet);};transports.push(transport);transport.bindMembership(async()=>p.enabled?({profileId:profile,deviceId:p.portal,sourceEndpointId:p.endpoint,localEndpointIds:[p.endpoint],members:members()}):null);
    return {p,root,transport,rpc:(op:Parameters<AuthenticatedCommunityTransport['rpc']>[0],args:Record<string,unknown>,purpose:CommunityComponentPurpose='agent')=>transport.rpc(op,profile,p.portal,'a'.repeat(64),args,purpose)};};
  return {profile,room,people,wire,make,members,identity,sockets,packets,advance:(ms:number)=>{moment+=ms;},now,dropClient:(value:boolean)=>{dropClientRecords=value;},drop:(value:boolean)=>{dropHostRecords=value;},close:()=>{for(const t of transports)t.close();for(const root of roots)rmSync(root,{recursive:true,force:true});}};
}

test('native identities authenticate different CF/portal IDs before encrypted control delivery; target receipt survives restart',async()=>{
  const f=await fixture(),a=f.make(0),b=f.make(1);
  try {
    await b.rpc('control-inbox',{});const originalId=randomUUID(),text='private-workroom-request-marker';
    const sent=await a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,request:{kind:'ops-request',operation:'submit',requestId:originalId,text}});
    const inbox=await until(()=>b.rpc('control-inbox',{}),value=>value.controls.length===1);
    expect(inbox.controls[0].fromDeviceId).toBe(a.p.portal);expect(inbox.controls[0].fromDeviceId).not.toBe(a.p.cf);expect(inbox.controls[0].request.requestId).toBe(originalId);
    const response={ok:true,body:{requestId:originalId,state:'completed',result:'target-original-receipt'}};
    f.drop(true);expect(await b.rpc('control-respond',{controlId:sent.controlId,response})).toEqual({responded:true});
    const absent=await a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]});expect(absent.results).toEqual([]);
    expect((await b.rpc('control-inbox',{})).controls).toEqual([]);
    b.transport.close();const restored=f.make(1,b.root);await restored.rpc('control-inbox',{});f.drop(false);
    const recovered=await until(()=>a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]}),value=>value.results.length===1);
    expect(recovered.results[0]).toEqual({controlId:sent.controlId,response});expect((await restored.rpc('control-inbox',{})).controls).toEqual([]);
    expect(f.wire.join('')).not.toContain(text);expect(f.wire.join('')).not.toContain('a'.repeat(64));
    const publicPackets=f.wire.map(w=>JSON.parse(Buffer.from(JSON.parse(w).ciphertext,'base64url').toString())).map(p=>Buffer.from(p.part,'base64url').toString()).join('');
    expect(publicPackets).not.toContain(text);expect(publicPackets).not.toContain('target-original-receipt');
    for(const root of [a.root,b.root])for(const name of readdirSync(root))if(name.includes('.sqlite'))expect(readFileSync(join(root,name)).includes(Buffer.from(text))).toBe(false);
  }finally{f.close();}
},10_000);

test('AgentDialogueHost actual call/poll/respond/result uses only the injected transport and preserves the request ID',async()=>{
  const f=await fixture(),a=f.make(0),b=f.make(1),forbidden:string[]=[];
  try {
    const host=(p:typeof a.p,transport:AuthenticatedCommunityTransport,root:string)=>new AgentDialogueHost({appDataDir:root,identity:()=>({profileId:f.profile,deviceId:p.portal}),
      secret:async()=> 'a'.repeat(64),resolveTarget:async()=>({kind:'ops',displayName:'Fixture OPS'}),controlTransport:transport,
      rpc:async(operation)=>{if(operation.startsWith('control-')){forbidden.push(operation);throw Error('database mailbox must not be called');}
        if(operation==='register-endpoint')return {endpointId:p.endpoint};if(operation==='community-status')return {inside:true,roomId:f.room,members:f.members()};return {};}});
    const first=host(a.p,a.transport,a.root),second=host(b.p,b.transport,b.root);await first.enable({target:'ops'},true);await second.enable({target:'ops'},true);
    await second.controlPoll(async()=>({unused:true}));const requestId=randomUUID();let observed:string|undefined;
    const call=first.controlCall(b.p.endpoint,{kind:'ops-request',operation:'submit',requestId,text:'fixture task'},3000,{onSent:s=>{observed=s.controlId;}});
    let executions=0;
    await until(()=>second.controlPoll(async request=>{++executions;return {requestId:request.requestId,done:true};}),value=>value.handled===1);
    expect(await call).toEqual({ok:true,body:{requestId,done:true}});expect(observed).toMatch(/^[a-f0-9-]{36}$/);expect(executions).toBe(1);expect(forbidden).toEqual([]);
    f.people[1]!.enabled=false;
    await expect(first.controlCall(b.p.endpoint,{kind:'projects'},10)).rejects.toThrow();expect(forbidden).toEqual([]);
  }finally{f.close();}
},10_000);

test('Teams requires a trusted explicit route, and native identity mismatch cannot dispatch a command',async()=>{
  const f=await fixture(),a=f.make(0),b=f.make(1);
  try {
    await expect(a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,request:{kind:'ops-request',operation:'submit',requestId:randomUUID(),text:'not a trusted team route'}},'teams')).rejects.toThrow('COMMUNITY_TEAMS_ROUTE_UNAVAILABLE');
    await expect(a.transport.rpc('control-send',f.profile,b.p.portal,'a'.repeat(64),{sourceEndpointId:b.p.endpoint,targetEndpointId:a.p.endpoint,request:{kind:'projects'}})).rejects.toThrow('COMMUNITY_CONTROL_IDENTITY_CHANGED');
    expect(f.wire).toEqual([]);
  }finally{f.close();}
});

test('trusted Teams packets use only the dedicated dispatcher, never the ordinary OPS executor',async()=>{
  const f=await fixture(),a=f.make(0,undefined,true),b=f.make(1,undefined,true);let ordinary=0,teams=0;
  try {
    const makeHost=(p:typeof a.p,t:AuthenticatedCommunityTransport,root:string,receiving:boolean)=>new AgentDialogueHost({appDataDir:root,
      identity:()=>({profileId:f.profile,deviceId:p.portal}),secret:async()=>'a'.repeat(64),resolveTarget:async()=>({kind:'ops',displayName:'Fixture OPS'}),
      controlTransport:t,...(receiving?{trustedTeamsDispatcher:async(request:Record<string,unknown>)=>{if(request.kind!=='team'||request.op!=='status')throw Error('strict Teams DTO required');++teams;return {result:{requestId:request.requestId,state:'working'}};}}:{}),
      rpc:async operation=>{if(operation.startsWith('control-'))throw Error('DB fallback forbidden');if(operation==='register-endpoint')return {endpointId:p.endpoint};
        return operation==='community-status'?{inside:true,roomId:f.room,members:f.members()}:{};}});
    const sender=makeHost(a.p,a.transport,a.root,false),receiver=makeHost(b.p,b.transport,b.root,true);
    await sender.enable({target:'ops'},true);await receiver.enable({target:'ops'},true);
    await receiver.controlPoll(async()=>{++ordinary;return {};});const requestId=randomUUID();
    const sent=sender.controlCall(b.p.endpoint,{kind:'team',version:1,op:'status',requestId,remoteRef:'fixture-only'},3000,{transportPurpose:'teams'});
    await until(()=>receiver.controlPoll(async()=>{++ordinary;return {};}),v=>v.handled===1);
    expect(await sent).toEqual({ok:true,body:{result:{requestId,state:'working'}}});expect(teams).toBe(1);expect(ordinary).toBe(0);
  }finally{f.close();}
},10_000);

test('more than 512 actual encrypted control deliveries consume, compact and retire without replaying requests',async()=>{
  const f=await fixture(true);let a=f.make(0),b=f.make(1);let first:Record<string,any>|undefined;
  try{
    await b.rpc('control-inbox',{});
    for(let i=0;i<600;i++){
      const sent=await a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,request:{kind:'projects',ordinal:i}});
      expect(communityControlIdTime(sent.controlId)).toBe(f.now());
      const inbox=await until(()=>b.rpc('control-inbox',{}),v=>v.controls.length===1);expect(inbox.controls[0].controlId).toBe(sent.controlId);
      expect(await b.rpc('control-respond',{controlId:sent.controlId,response:{ok:true,ordinal:i}})).toEqual({responded:true});
      const result=await until(()=>a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]}),v=>v.results.length===1);
      expect(result.results[0].response).toEqual({ok:true,ordinal:i});
      await until(async()=>((a.transport as any).ledger.pendingConsumption().length),n=>n===0);
      if(!first)first=f.packets.find(p=>p.from===0&&p.packet.type==='request')!.packet;
      f.advance(100);
      if(i===100){a.transport.close();b.transport.close();a=f.make(0,a.root);b=f.make(1,b.root);await b.rpc('control-inbox',{});}
    }
    expect(f.packets.filter(p=>p.from===0&&p.packet.type==='request')).toHaveLength(600);
    const internal=a.transport as any,channel=[...internal.channels.values()].find((c:any)=>c.side==='sender'&&c.ready);
    await internal.seal(channel,{...first!,createdAt:f.now()});
    await internal.seal(channel,first!);
    await new Promise(r=>setTimeout(r,10));expect((await b.rpc('control-inbox',{})).controls).toEqual([]);
    const floor=(b.transport as any).ledger.retiredBefore;f.advance(-50_000);
    await internal.seal(channel,first!);await new Promise(r=>setTimeout(r,10));expect((await b.rpc('control-inbox',{})).controls).toEqual([]);
    expect((b.transport as any).ledger.retiredBefore).toBeGreaterThanOrEqual(floor);
    await expect(a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,request:{kind:'projects'}})).rejects.toThrow('COMMUNITY_CONTROL_CLOCK_REGRESSED');
    f.advance(50_000);
    await expect(a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[first!.controlId]})).rejects.toThrow('COMMUNITY_CONTROL_RECEIPT_EXPIRED');
  }finally{f.close();}
},30_000);

test('only application consumption clears the target result; lost consumption acknowledgement recovers after restart',async()=>{
  const f=await fixture(true);let a=f.make(0);const b=f.make(1);
  try{
    await b.rpc('control-inbox',{});const sent=await a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,request:{kind:'projects'}});
    await until(()=>b.rpc('control-inbox',{}),v=>v.controls.length===1);
    await b.rpc('control-respond',{controlId:sent.controlId,response:{ok:true,retained:'until consumed'}});
    await until(async()=>((a.transport as any).ledger.get(sent.controlId)?.response),v=>!!v);
    const receiverLedger=(b.transport as any).ledger,original=receiverLedger.get(sent.controlId);
    expect(original.response).toEqual({ok:true,retained:'until consumed'});expect(original.consumed).not.toBe(true);
    const internal=a.transport as any,channel=[...internal.channels.values()].find((c:any)=>c.side==='sender'&&c.ready);
    await internal.seal(channel,{type:'result-consumed',controlId:sent.controlId,sourceEndpointId:a.p.endpoint,targetEndpointId:b.p.endpoint,digest:'0'.repeat(64),createdAt:original.createdAt});
    await new Promise(r=>setTimeout(r,10));expect(receiverLedger.get(sent.controlId).response).toEqual(original.response);
    f.dropClient(true);expect((await a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]})).results).toHaveLength(1);
    await new Promise(r=>setTimeout(r,10));expect(receiverLedger.get(sent.controlId).response).toEqual(original.response);
    expect((a.transport as any).ledger.get(sent.controlId)).toMatchObject({consumed:true,ackPending:true,response:null});
    a.transport.close();a=f.make(0,a.root);f.dropClient(false);f.advance(1500);
    expect((await a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]})).results).toEqual([]);
    await until(async()=>receiverLedger.get(sent.controlId)?.consumed,v=>v===true);
    await until(async()=>((a.transport as any).ledger.pendingConsumption().length),n=>n===0);
    expect(receiverLedger.get(sent.controlId)).toMatchObject({consumed:true,response:null});
    expect(f.packets.filter(p=>p.from===0&&p.packet.type==='request')).toHaveLength(1);
    f.advance(31_000);await b.rpc('control-inbox',{});expect(receiverLedger.get(sent.controlId)).toBeUndefined();
  }finally{f.close();}
},10_000);

test('sixteen offline-peer consumption retries do not block a live peer or its lost acknowledgement recovery',async()=>{
  const f=await fixture(true);let a=f.make(0);const live=f.make(2),offline=f.people[1]!;
  try{
    await a.rpc('control-inbox',{});await live.rpc('control-inbox',{});
    const own=await f.identity(a.p).currentAuthorization('agent'),peer=await f.identity(offline).currentAuthorization('agent'),offlineIds:string[]=[];
    for(let i=0;i<16;i++){
      const id=(await import('../src/authenticatedCommunityTransport')).communityControlId(f.now());offlineIds.push(id);
      (a.transport as any).ledger.put({id,profile:f.profile,device:a.p.portal,direction:'out',sourceEndpoint:a.p.endpoint,targetEndpoint:offline.endpoint,
        fromDevice:a.p.portal,toDevice:offline.portal,purpose:'agent',digest:'d'.repeat(64),createdAt:f.now(),state:'done',request:null,response:null,consumed:true,ackPending:true,
        ownPolicy:own.policyDigest,peerPolicy:peer.policyDigest});f.advance(1);
    }
    offline.enabled=false;
    const sent=await a.rpc('control-send',{sourceEndpointId:a.p.endpoint,targetEndpointId:live.p.endpoint,request:{kind:'projects'}});
    await until(()=>live.rpc('control-inbox',{}),v=>v.controls.length===1);await live.rpc('control-respond',{controlId:sent.controlId,response:{ok:true,live:true}});
    await until(async()=>((a.transport as any).ledger.get(sent.controlId)?.response),v=>!!v);
    f.dropClient(true);expect((await a.rpc('control-result',{sourceEndpointId:a.p.endpoint,controlIds:[sent.controlId]})).results).toHaveLength(1);
    await new Promise(r=>setTimeout(r,10));a.transport.close();a=f.make(0,a.root);f.dropClient(false);f.advance(1500);
    await a.rpc('control-inbox',{});
    await until(async()=>((live.transport as any).ledger.get(sent.controlId)?.consumed),v=>v===true);
    for(const id of offlineIds)expect((a.transport as any).ledger.get(id)).toMatchObject({consumed:true,ackPending:true});
    expect(f.packets.filter(p=>p.from===0&&p.packet.type==='request')).toHaveLength(1);
  }finally{f.close();}
},10_000);
