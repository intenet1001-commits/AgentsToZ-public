// Actual disposable workerd/SQLite and software keys only. No Native ownership or human-input claim is made here.
import {Miniflare,Log,LogLevel} from 'miniflare';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommunityAccessClient} from '../../../src/communityAccessClient.ts';
import {CommunityDeviceAuthorization} from '../../../src/communityMobilePrincipal.ts';
import {CommunityComponentAuthorization} from '../../../src/communityComponentIdentity.ts';
import {communitySafetyPolicyDigest} from '../../../src/communityScreenSafetyClient.ts';
import shared from '../../../native/screen-control/Tests/Fixtures/community-desktop-trust-v1.json';

const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function point(key){const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]).toString('base64url');}
const signature=(key,domain,bytes)=>sign('sha256',Buffer.concat([Buffer.from(domain),bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
const person=name=>({name,id:randomUUID(),host:keys(),bio:keys(),operation:keys(),control:keys(),enrollment:null,plan:null});
const root=person('Fixture admin'),a=person('Mac A'),b=person('Mac B'),mobile=person('iPad'),issuer=keys(),profile=randomUUID(),origin='https://desktop-trust-fixture.workers.dev',trust='screen.desktop-trust';
const directory=await mkdtemp(join(tmpdir(),'community-desktop-trust-'));let worker,goldenVerifier,outbound=0;
try{
 const built=await Bun.build({entrypoints:[new URL('../src/worker.ts',import.meta.url).pathname],target:'browser',external:['cloudflare:workers','node:*'],outdir:directory});assert(built.success);
 worker=new Miniflare({cf:false,scriptPath:join(directory,'worker.js'),modules:true,modulesRoot:directory,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),
  durableObjects:{REGISTRY:{className:'ScreenCommunityRegistry',useSQLite:true},RELAY:{className:'CommunityRelayHub',useSQLite:true}},
  outboundService:async()=>{++outbound;throw Error('Outbound prohibited');},
  bindings:{COMMUNITY_ISSUER_JWK:JSON.stringify(issuer.privateKey.export({format:'jwk'})),COMMUNITY_STATE_KEY:randomBytes(32).toString('base64url'),COMMUNITY_BOOTSTRAP_HOST:point(root.host.publicKey),COMMUNITY_BOOTSTRAP_VIEWER:point(root.bio.publicKey),COMMUNITY_BOOTSTRAP_PROFILE:profile}});
 const bytes=Buffer.from(JSON.stringify([1,'bootstrap',randomUUID(),Date.now(),randomBytes(32).toString('base64url'),null,[profile,root.id,root.name,point(root.host.publicKey),point(root.bio.publicKey),'none','Fixture']]));
 const bootstrap=await worker.dispatchFetch(origin+'/v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:bytes.toString('base64url'),signature:signature(root.bio.privateKey,'agentstoz.screen-community.request/v1\0',bytes),hostSignature:signature(root.host.privateKey,'agentstoz.screen-community.request/v1\0',bytes)})});
 const bootEnvelope=await bootstrap.json(),bootBytes=Buffer.from(bootEnvelope.payload,'base64url');assert(verify('sha256',Buffer.concat([Buffer.from('agentstoz.screen-community.response/v1\0'),bootBytes]),{key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(bootEnvelope.signature,'base64url')));
 const boot=JSON.parse(bootBytes);assert.equal(boot[1],'member');const cid=boot[4];root.enrollment=boot[6];
 const authority={origin,issuerPublicKey:point(issuer.publicKey),profileId:profile};
 function client(key){return new CommunityAccessClient(origin,authority.issuerPublicKey,{publicKey:point(key.publicKey),signAccessRequest:async request=>{
  const bytes=Buffer.from(JSON.stringify([2,request.operation,request.requestId,request.observedAt,request.nonce,request.actor,request.args]));return {payload:bytes.toString('base64url'),signature:signature(key.privateKey,'agentstoz.community-access.request/v2\0',bytes)};
 }},(url,init)=>worker.dispatchFetch(url,init));}
 const request=(operation,args,actor)=>({operation,args,actor,requestId:randomUUID(),observedAt:Date.now(),nonce:randomBytes(32).toString('base64url')});
 const plan=(p,caps,kind='desktop')=>({version:1,profileId:profile,deviceId:p.id,name:p.name,kind,hostKey:point(p.host.publicKey),biometricKey:point(p.bio.publicKey),operationKey:point(p.operation.publicKey),controlKey:null,agentDeviceId:null,capabilities:caps});
 async function stage(p,value){const prepared=await client(p.host).exchange(request('prepare',[value],null));const review=await client(root.host).exchange(request('review',[cid,prepared.payload.planId],root.enrollment));return {value,prepared,review};}
 async function approve(p,staged){const r=staged.review.payload,input=request('approve',[cid,r.planId,r.digest,r.challenge,r.revision],root.enrollment),reply=await client(root.bio).exchange(input);p.plan=staged.value;p.enrollment=reply.payload.enrollmentId;return {input,reply};}
 const current=p=>client(p.operation).exchange(request('authorization',[cid],p.enrollment));
 await approve(a,await stage(a,plan(a,['screen.view','screen.control'])));await approve(b,await stage(b,plan(b,['screen.receive.view','screen.receive.control'])));mobile.plan=plan(mobile,['screen.view'],'mobile');
 const originalA=(await current(a)).payload,originalB=(await current(b)).payload;assert(!originalA.capabilities.includes(trust));assert(!originalB.capabilities.includes(trust));
 const pending=await stage(a,{...a.plan,capabilities:[...a.plan.capabilities,trust]});assert.deepEqual((await current(a)).payload.capabilities,originalA.capabilities,'pending plan grants nothing');
 const wrong={...pending.review.payload,challenge:randomBytes(32).toString('base64url')};await assert.rejects(client(root.bio).exchange(request('approve',[cid,wrong.planId,wrong.digest,wrong.challenge,wrong.revision],root.enrollment)),{code:'STALE_APPROVAL'});
 const accepted=await approve(a,pending);const recovered=await client(root.host).exchange(request('receipt',[accepted.input.requestId],root.enrollment));assert.deepEqual(recovered.payload.result,accepted.reply.envelope);
 const freshA=(await current(a)).payload;assert.equal(freshA.enrollmentId,originalA.enrollmentId);assert.equal(freshA.keyEpoch,originalA.keyEpoch);assert(freshA.revision>originalA.revision);
 for(const key of ['hostPublicKey','publicKey','biometricPublicKey','controlKey'])assert.equal(freshA[key],originalA[key]);
 assert(!(await current(b)).payload.capabilities.includes(trust),'one-sided trust does not migrate its peer');
 await approve(b,await stage(b,{...b.plan,controlKey:point(b.control.publicKey),agentDeviceId:randomUUID(),capabilities:[...b.plan.capabilities,'agent.communicate','computer-use.browser',trust]}));
 const freshB=await current(b),desktop=await CommunityDeviceAuthorization.fromReply(freshB,authority,{communityId:cid,deviceId:b.id,deviceKind:'desktop'});assert(desktop.body.capabilities.includes(trust));assert.equal(desktop.permits('mobile-agent'),true);assert.equal(desktop.permits('mobile-teams'),false);
 const component=await client(b.control).exchange(request('component-status',[cid],b.enrollment));assert((await CommunityComponentAuthorization.fromReply(component,profile,b.id)).body.capabilities.includes(trust));
 assert.equal((await client(b.control).exchange(request('component-ticket',[cid,'browser',randomUUID(),'host'],b.enrollment))).kind,'ticket');
 await assert.rejects(client(b.operation).exchange(request('component-ticket',[cid,'browser',randomUUID(),'host'],b.enrollment)),{code:'INVALID_PROOF'});
 await assert.rejects(client(mobile.host).exchange(request('prepare',[{...mobile.plan,capabilities:['screen.view',trust]}],null)),{code:'MOBILE_CANNOT_TRUST_DESKTOP'});
 const oldTicket=await client(a.operation).exchange(request('relay-ticket',[cid,'screen',randomUUID(),'client',null],a.enrollment));
 await approve(a,await stage(a,{...a.plan,capabilities:originalA.capabilities}));assert(!(await current(a)).payload.capabilities.includes(trust));
 assert.equal((await worker.dispatchFetch(origin+'/relay',{headers:{Upgrade:'websocket',Authorization:`AgentsToZ ${oldTicket.envelope.payload}.${oldTicket.envelope.signature}`}})).status,403,'policy revision rejects the original unused ticket');
 const rotated=await stage(a,{...a.plan,operationKey:point(keys().publicKey),capabilities:[...a.plan.capabilities,trust]});await assert.rejects(approve(a,rotated),{code:'DESKTOP_TRUST_KEYS_IMMUTABLE'});assert.deepEqual((await current(a)).payload.capabilities,originalA.capabilities);assert.equal((await current(a)).payload.publicKey,originalA.publicKey);
 // A separate fixture-only Worker bundles the actual CF parser/crypto and consumes the unchanged Swift envelopes.
 // It creates no authority, registration, receiver or Native key; the explicit date is the shared software clock.
 const entry=join(directory,'golden-verifier.ts'),verifierDirectory=join(directory,'golden');
 await writeFile(entry,`
 import g from ${JSON.stringify(new URL('../../../native/screen-control/Tests/Fixtures/community-desktop-trust-v1.json',import.meta.url).pathname)};
 import {accessPlan,verifyAccessEnvelope} from ${JSON.stringify(new URL('../src/accessProtocol.ts',import.meta.url).pathname)};
 import {safetyPolicyDigest} from ${JSON.stringify(new URL('../src/screenSafety.ts',import.meta.url).pathname)};
 import {demand} from ${JSON.stringify(new URL('../src/protocol.ts',import.meta.url).pathname)};
 const project=(b:any)=>({version:1,profileId:b.profileId,deviceId:b.deviceId,name:b.name,kind:b.deviceKind,hostKey:b.hostPublicKey,biometricKey:b.biometricPublicKey,operationKey:b.publicKey,controlKey:b.controlKey,agentDeviceId:b.agentDeviceId,capabilities:b.capabilities});
 const code=(fn:()=>unknown)=>{try{fn();return null;}catch(error){return (error as {code?:string}).code;}};
 export default {fetch(){
  demand(g.softwareOnly);const bodies=[g.controller,g.receiver],envelopes=[g.controllerEnvelope,g.receiverEnvelope];
  const plans=bodies.map((body,i)=>{const fields=verifyAccessEnvelope(envelopes[i],g.authority.issuerPublicKey);demand(fields[1]==='authorization'&&fields[3]===g.at);
   const decoded=fields[4] as any;demand(Object.keys(decoded).length===17&&Object.keys(body).every(k=>JSON.stringify(decoded[k])===JSON.stringify((body as any)[k])));
   demand(decoded.issuedAt===g.at&&decoded.expiresAt===g.at+90000);return accessPlan(project(decoded));});
  const dir=verifyAccessEnvelope(g.directoryEnvelope,g.authority.issuerPublicKey);demand(dir[1]==='directory'&&dir[3]===g.at&&Array.isArray(dir[4])&&dir[4].length===2);
  demand((dir[4] as any[]).every((b,i)=>Object.keys(b).length===17&&Object.keys(bodies[i]).every(k=>JSON.stringify(b[k])===JSON.stringify((bodies[i] as any)[k]))));
  return Response.json({authorizationFields:bodies.map(b=>Object.keys(b).length),planFields:plans.map(p=>Object.keys(p).length),capabilities:plans.map(p=>p.capabilities),policyDigests:bodies.map(safetyPolicyDigest),controlKeys:plans.map(p=>p.controlKey),
   mobile:code(()=>accessPlan({...project(g.controller),kind:'mobile'})),standalone:code(()=>accessPlan({...project(g.receiver),capabilities:['screen.desktop-trust']})),
   wrongSignature:code(()=>verifyAccessEnvelope({...g.receiverEnvelope,signature:g.controllerEnvelope.signature},g.authority.issuerPublicKey)),directory:true});
 }};
 `);
 const verificationBuild=await Bun.build({entrypoints:[entry],target:'browser',external:['node:*'],outdir:verifierDirectory});assert(verificationBuild.success);
 goldenVerifier=new Miniflare({cf:false,scriptPath:join(verifierDirectory,'golden-verifier.js'),modules:true,modulesRoot:verifierDirectory,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),outboundService:async()=>{++outbound;throw Error('Outbound prohibited');}});
 const result=await goldenVerifier.dispatchFetch(origin+'/golden');assert.equal(result.status,200);const metadata=await result.json();
 assert.deepEqual(metadata.authorizationFields,[17,17]);assert.deepEqual(metadata.planFields,[11,11]);assert.deepEqual(metadata.capabilities,[shared.controller.capabilities,shared.receiver.capabilities]);
 assert.deepEqual(metadata.policyDigests,[communitySafetyPolicyDigest(shared.controller),communitySafetyPolicyDigest(shared.receiver)]);assert.deepEqual(metadata.controlKeys,[null,null]);
 assert.equal(metadata.mobile,'MOBILE_CANNOT_TRUST_DESKTOP');assert.equal(metadata.standalone,'DESKTOP_TRUST_REQUIRES_SCREEN');assert.equal(metadata.wrongSignature,'INVALID_ISSUER');assert.equal(metadata.directory,true);
 assert.equal(outbound,0);console.log('PASS: actual workerd desktop trust reviewed upgrade, original receipt, immutable keys, combined Control, strict SDK, mobile rejection, policy removal and unchanged Swift golden CF/SDK interop; no live networking');
}finally{await goldenVerifier?.dispose();await worker?.dispose();await rm(directory,{recursive:true,force:true});}
