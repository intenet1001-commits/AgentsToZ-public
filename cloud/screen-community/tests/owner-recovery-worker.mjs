// Isolated real workerd/SQLite, software keys and ephemeral loopback only.
import {Miniflare,Log,LogLevel} from 'miniflare';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommunityAccessClient,CommunityAccessReply} from '../../../src/communityAccessClient.ts';
const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function point(key){const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]).toString('base64url');}
const signature=(key,domain,bytes)=>sign('sha256',Buffer.concat([Buffer.from(domain),bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
const person=name=>({name,id:randomUUID(),host:keys(),bio:keys(),operation:keys(),enrollment:null,plan:null});
const root=person('Fixture manager'),a=person('Trusted Mac A'),b=person('Trusted Mac B'),c=person('Batch opt-in Mac'),issuer=keys(),profile=randomUUID(),origin='https://owner-recovery-fixture.workers.dev',trust='screen.desktop-trust';
const directory=await mkdtemp(join(tmpdir(),'community-owner-recovery-'));let worker,outbound=0;
try{
 const built=await Bun.build({entrypoints:[new URL('../src/worker.ts',import.meta.url).pathname],target:'browser',external:['cloudflare:workers','node:*'],outdir:directory});assert(built.success);
 worker=new Miniflare({cf:false,scriptPath:join(directory,'worker.js'),modules:true,modulesRoot:directory,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),durableObjects:{REGISTRY:{className:'ScreenCommunityRegistry',useSQLite:true},RELAY:{className:'CommunityRelayHub',useSQLite:true}},outboundService:async()=>{++outbound;throw Error('Outbound prohibited');},bindings:{COMMUNITY_ISSUER_JWK:JSON.stringify(issuer.privateKey.export({format:'jwk'})),COMMUNITY_STATE_KEY:randomBytes(32).toString('base64url'),COMMUNITY_BOOTSTRAP_HOST:point(root.host.publicKey),COMMUNITY_BOOTSTRAP_VIEWER:point(root.bio.publicKey),COMMUNITY_BOOTSTRAP_PROFILE:profile}});
 const bytes=Buffer.from(JSON.stringify([1,'bootstrap',randomUUID(),Date.now(),randomBytes(32).toString('base64url'),null,[profile,root.id,root.name,point(root.host.publicKey),point(root.bio.publicKey),'none','Fixture']]));
 const response=await worker.dispatchFetch(origin+'/v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:bytes.toString('base64url'),signature:signature(root.bio.privateKey,'agentstoz.screen-community.request/v1\0',bytes),hostSignature:signature(root.host.privateKey,'agentstoz.screen-community.request/v1\0',bytes)})});
 const envelope=await response.json(),raw=Buffer.from(envelope.payload,'base64url');assert(verify('sha256',Buffer.concat([Buffer.from('agentstoz.screen-community.response/v1\0'),raw]),{key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(envelope.signature,'base64url')));
 const boot=JSON.parse(raw);assert.equal(boot[1],'member');const cid=boot[4];root.enrollment=boot[6];
 function client(key){return new CommunityAccessClient(origin,point(issuer.publicKey),{publicKey:point(key.publicKey),signAccessRequest:async r=>{const bytes=Buffer.from(JSON.stringify([2,r.operation,r.requestId,r.observedAt,r.nonce,r.actor,r.args]));return {payload:bytes.toString('base64url'),signature:signature(key.privateKey,'agentstoz.community-access.request/v2\0',bytes)};}},(url,init)=>worker.dispatchFetch(url,init));}
 const request=(operation,args,actor)=>({operation,args,actor,requestId:randomUUID(),observedAt:Date.now(),nonce:randomBytes(32).toString('base64url')});
 const exchange=(p,key,operation,args)=>client(p[key]).exchange(request(operation,[cid,...args],p.enrollment));
 async function enroll(p,caps){const plan={version:1,profileId:profile,deviceId:p.id,name:p.name,kind:'desktop',hostKey:point(p.host.publicKey),biometricKey:point(p.bio.publicKey),operationKey:point(p.operation.publicKey),controlKey:null,agentDeviceId:null,capabilities:caps};const prepared=await client(p.host).exchange(request('prepare',[plan],null)),review=(await exchange(root,'host','review',[prepared.payload.planId])).payload;const accepted=await exchange(root,'bio','approve',[review.planId,review.digest,review.challenge,review.revision]);p.plan=plan;p.enrollment=accepted.payload.enrollmentId;return accepted;}
 await enroll(a,['screen.view','screen.control',trust]);await enroll(b,['screen.receive.view','screen.receive.control',trust]);
 await assert.rejects(exchange(a,'operation','owner-recovery-request',[b.enrollment]),{code:'OWNER_DELEGATION_DISABLED'});
 await assert.rejects(exchange(b,'host','owner-delegation-set',[{version:1,enabled:true,expectedRevision:0}]),{code:'INVALID_PROOF'});
 const enabled=await exchange(b,'bio','owner-delegation-set',[{version:1,enabled:true,expectedRevision:0}]);assert.equal(enabled.payload.enabled,true);
 const requested=await exchange(a,'operation','owner-recovery-request',[b.enrollment]);assert.equal(requested.payload.state,'waiting-host');
 assert.equal((await exchange(a,'operation','owner-recovery-request',[b.enrollment])).payload.requestId,requested.payload.requestId);
 const ready=await exchange(b,'host','owner-recovery-publish',[requested.payload.requestId,{version:1,action:'resume-input',holdGeneration:randomUUID(),connectionId:null,challenge:randomBytes(32).toString('base64url')}]);
 await assert.rejects(exchange(a,'operation','owner-recovery-approve',[ready.payload.requestId,ready.payload.intent]),{code:'INVALID_PROOF'});
 const approved=await exchange(a,'bio','owner-recovery-approve',[ready.payload.requestId,ready.payload.intent]);assert.equal(approved.payload.state,'approved');
 const round=await exchange(b,'host','owner-recovery-poll',[]);assert.equal(round.payload.requests[0].state,'approved');
 const delegation=round.payload.delegation,fields=JSON.parse(Buffer.from(delegation.payload,'base64url'));
 assert.equal((await CommunityAccessReply.verify(delegation,point(issuer.publicKey),fields[2])).kind,'owner-delegation');
 const done=await exchange(b,'host','owner-recovery-result',[ready.payload.requestId,{version:1,outcome:'applied'}]);assert.equal(done.payload.state,'applied');
 assert.equal((await exchange(a,'operation','owner-recovery-status',[ready.payload.requestId])).payload.outcome,'applied');
 assert.equal((await exchange(b,'host','owner-delegation-set',[{version:1,enabled:false,expectedRevision:1}])).payload.enabled,false);
 await assert.rejects(exchange(a,'operation','owner-recovery-request',[b.enrollment]),{code:'OWNER_DELEGATION_DISABLED'});
 await enroll(c,['screen.receive.view','screen.receive.control',trust,'screen.owner-delegation']);
 assert.equal((await exchange(a,'operation','owner-recovery-request',[c.enrollment])).payload.state,'waiting-host');
 await enroll(b,[...b.plan.capabilities,'screen.owner-delegation']);
 await assert.rejects(exchange(a,'operation','owner-recovery-request',[b.enrollment]),{code:'OWNER_DELEGATION_DISABLED'});
 assert.equal(outbound,0);console.log('PASS: actual workerd owner delegation, non-admin trusted source BIO, immutable target result, explicit OFF and single-plan batch bootstrap; no live networking');
}finally{await worker?.dispose();await rm(directory,{recursive:true,force:true});}
