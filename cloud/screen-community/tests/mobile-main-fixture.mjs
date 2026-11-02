// Actual loopback workerd relay + SQLite admission + receiving TS Host. All identities/consumers are explicit software fixtures.
import {Miniflare,Log,LogLevel,Response as LocalResponse} from 'miniflare';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {strict as assert} from 'node:assert';
import {randomBytes,randomUUID} from 'node:crypto';
import {createMobileHostFixture} from '../../../tests/fixtures/communityMobileHostFixture.ts';
let worker,outbound=0;const temporary=await mkdtemp(join(tmpdir(),'mobile-main-workerd-'));
const sockets={open:async input=>{
  const response=await worker.dispatchFetch(input.url.replace(/^wss:/,'https:'),{headers:{Upgrade:'websocket',Authorization:input.authorization}});
  assert.equal(response.status,101);const ws=response.webSocket;ws.addEventListener('message',e=>input.onMessage(e.data));ws.addEventListener('close',input.onClose);ws.accept();
  return {bufferedAmount:0,send:text=>ws.send(text),close:(code,reason)=>ws.close(code,reason)};
}};
const f=createMobileHostFixture(sockets);
const json=(body,status=200)=>new LocalResponse(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
try{
  const source=new URL('../src/',import.meta.url).pathname,entry=join(temporary,'mobile-relay-fixture.ts');
  await writeFile(entry,`import {DurableObject} from 'cloudflare:workers';import {Buffer} from 'node:buffer';
    import {CommunityRelayHub} from ${JSON.stringify(source+'relayHub.ts')};
    import {CommunityAccessRegistry} from ${JSON.stringify(source+'accessRegistry.ts')};
    import {DurableRegistryStore} from ${JSON.stringify(source+'store.ts')};
    import {privateKey} from ${JSON.stringify(source+'protocol.ts')};
    export {CommunityRelayHub};
    export class FixtureRegistry extends DurableObject {
      async fetch(request){const store=new DurableRegistryStore(this.ctx.storage),seed=JSON.parse(this.env.FIXTURE_SEED);
        if(!store.get('fixture-seeded'))store.transaction(()=>{for(const p of seed.people){const b=p.auth;
          store.put('member:'+b.enrollmentId,{enrollmentId:b.enrollmentId,communityId:b.communityId,profileId:b.profileId,deviceId:b.deviceId,name:b.name,hostKey:b.hostPublicKey,viewerKey:b.biometricPublicKey,platform:b.deviceKind==='mobile'?'ios':'mac',grant:'none',admin:false,keyEpoch:b.keyEpoch,joinedAt:b.issuedAt,revokedAt:null,route:null});
          store.put('access-policy:'+b.enrollmentId,{enrollmentId:b.enrollmentId,revision:b.revision,plan:{version:1,profileId:b.profileId,deviceId:b.deviceId,name:b.name,kind:b.deviceKind,hostKey:b.hostPublicKey,biometricKey:b.biometricPublicKey,operationKey:b.publicKey,controlKey:b.controlKey,agentDeviceId:b.agentDeviceId,capabilities:b.capabilities}});
          if(p.session){store.put('access-session:'+p.session.id,p.session);store.put('access-current-session:'+b.enrollmentId,p.session.id);}}
          store.put('fixture-seeded',true);});
        if(new URL(request.url).pathname!=='/internal/relay-admission')return new Response(null,{status:404});
        try{const service=new CommunityAccessRegistry(store,privateKey(this.env.FIXTURE_ISSUER),this.env.FIXTURE_ISSUER_PUBLIC,Buffer.from(this.env.FIXTURE_STATE_KEY,'base64url'));return Response.json(service.admitTicket(await request.json()));}
        catch{return new Response(null,{status:403});}}
    }
    export default {fetch(request,env){const path=new URL(request.url).pathname;
      if(path.startsWith('/fixture/'))return env.FIXTURE.fetch(request);
      if(path!=='/relay')return new Response(null,{status:404});return env.RELAY.get(env.RELAY.idFromName('community-access-relay-v2')).fetch(request);}};`);
  assert((await Bun.build({entrypoints:[entry],target:'browser',external:['cloudflare:workers','node:*'],outdir:temporary})).success);
  worker=new Miniflare({cf:false,name:'mobile-main-fixture',scriptPath:join(temporary,'mobile-relay-fixture.js'),modules:true,modulesRoot:temporary,port:0,host:'127.0.0.1',
    compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.ERROR),
    durableObjects:{REGISTRY:{className:'FixtureRegistry',useSQLite:true},RELAY:{className:'CommunityRelayHub',useSQLite:true}},
    outboundService:async()=>{++outbound;throw Error('outbound prohibited');},
    bindings:{FIXTURE_SEED:JSON.stringify(f.seed()),FIXTURE_ISSUER:JSON.stringify(f.issuer.privateKey.export({format:'jwk'})),FIXTURE_ISSUER_PUBLIC:f.authority.issuerPublicKey,FIXTURE_STATE_KEY:randomBytes(32).toString('base64url')},
    serviceBindings:{FIXTURE:async request=>{
      const path=new URL(request.url).pathname;
      if(path==='/fixture/metadata'&&request.method==='GET'){
        const mobile=f.mobiles[0],authorization=await f.auth(mobile),use=await f.use(mobile,authorization),receiver=await f.auth(f.receiver);
        return json({fixtureOnly:true,authority:f.authority,now:f.now(),receiverAuthorization:receiver.envelope,mobileAuthorization:authorization.envelope,mobileUseSession:use.envelope,
          receiverDeviceId:receiver.body.deviceId,mobileDeviceId:mobile.id,mobileUseScalar:3,hostControlScalar:4});
      }
      if(path==='/fixture/ticket'&&request.method==='POST'){
        const value=await request.json();if(!value||Object.keys(value).sort().join(',')!=='connectionId,deviceId,purpose'||!['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'].includes(value.purpose))return json({error:'FIXTURE_INVALID_REQUEST'},400);
        const p=f.mobiles.find(p=>p.id===value.deviceId);if(!p)return json({error:'FIXTURE_DEVICE_MISSING'},404);
        return json({fixtureOnly:true,ticket:(await f.ticket(p,value.purpose,value.connectionId,'client')).envelope});
      }
      if(path==='/fixture/state'&&request.method==='GET')return json({fixtureOnly:true,effects:f.state.effects,host:f.host.status(),lastOperationId:f.state.lastGuard?.operationId??null,lastCreatedAt:f.state.lastGuard?.createdAt??null});
      return json({error:'FIXTURE_NOT_FOUND'},404);
    }}});
  await f.host.start();assert(f.host.status().purposes.every(p=>p.connected));
  if(process.argv.includes('--serve')){
    const url=await worker.ready;console.log(JSON.stringify({fixtureReady:true,origin:url.origin,relay:url.origin.replace(/^http:/,'ws:')+'/relay',metadata:url.origin+'/fixture/metadata',ticket:url.origin+'/fixture/ticket',state:url.origin+'/fixture/state'}));
    await new Promise(resolve=>{const timer=setTimeout(resolve,180_000);const stop=()=>{clearTimeout(timer);resolve();};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
  }else{
    const a=await f.client(0),b=await f.client(1);await Promise.all([a.handshake(),b.handshake()]);assert.equal(f.host.status().activeChannels,2);
    const cap=await a.dispatch({mode:'query',command:{op:'capabilities'}});assert.equal((await a.result(cap)).result.outcome,'capabilities');
    const at=f.now(),bytes=randomBytes(16);bytes.writeUIntBE(at,0,6);bytes[6]=(bytes[6]&15)|0x70;bytes[8]=(bytes[8]&63)|0x80;const h=bytes.toString('hex'),operationId=h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
    const request={mode:'effect',operationId,createdAt:at,command:{op:'count'}},id=await a.dispatch(request),result=await a.result(id);assert.equal(result.result.count,1);
    const duplicate=await a.dispatch(request);assert.deepEqual((await a.result(duplicate)).result,result.result);assert.equal(f.state.effects,1);
    const receipt=await a.dispatch({mode:'receipt',operationId,createdAt:at});assert.equal((await a.result(receipt)).response.result,result.response.result);
    const consumed=await a.dispatch({mode:'consumed',operationId,createdAt:at,resultDigest:result.response.resultDigest});assert.equal((await a.result(consumed)).result.outcome,'consumed');
    const second=await b.dispatch({mode:'query',command:{op:'read'}});assert.equal((await b.result(second)).result.count,1);assert.equal(outbound,0);
    console.log('PASS: actual loopback workerd/SQLite admission/relay + TS receiving Host; two mobile mutual confirmations, capabilities, durable one-time synthetic effect, exact receipt and consumed; outbound=0; software Native/consumers only');
  }
}finally{await f.close();await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
