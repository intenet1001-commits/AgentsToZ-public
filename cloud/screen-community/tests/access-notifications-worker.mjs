// Actual workerd/SQLite, software identities, local-only APNs interception; no account, device or production data.
import {Miniflare,Log,LogLevel,Response as LocalResponse} from 'miniflare';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function point(key){const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]).toString('base64url');}
const issuer=keys(),provider=keys(),profile=randomUUID(),topic='com.example.fixture.mobile';
const device=(name,kind='mobile')=>({name,kind,host:keys(),bio:keys(),op:keys(),device:randomUUID(),enrollment:null});
const admin=device('Manager','desktop'),mobile=device('iPad / 한글'),joining=device('Mac B','desktop');
const temp=await mkdtemp(join(tmpdir(),'community-access-notifications-'));const pushes=[];let service,mode='ok',outbound=0,inFlight=0,maximumInFlight=0,rotateDuringDelivery;
const accessPushes=()=>pushes.filter(p=>JSON.parse(Buffer.from(p.body.communityEnrollment.payload,'base64url'))[0]===2);
const sig=(key,domain,bytes)=>sign('sha256',Buffer.concat([Buffer.from(domain),bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
try{
 const built=await Bun.build({entrypoints:[new URL('../src/worker.ts',import.meta.url).pathname],target:'browser',external:['cloudflare:workers','node:*'],outdir:temp});assert(built.success);
 // Test-only RPC waits for the actual production promise (including dead-token cleanup); it never drains or mutates.
 await appendFile(join(temp,'worker.js'),'\nexport class NotificationFixtureRegistry extends ScreenCommunityRegistry { async fixtureNotificationIdle() { await this.notificationDelivery; } }\n');
 service=new Miniflare({cf:false,scriptPath:join(temp,'worker.js'),modules:true,modulesRoot:temp,compatibilityDate:'2026-07-29',compatibilityFlags:['nodejs_compat'],port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),durableObjects:{REGISTRY:{className:'NotificationFixtureRegistry',useSQLite:true}},
  outboundService:async request=>{const deliveryMode=mode;++outbound;++inFlight;maximumInFlight=Math.max(maximumInFlight,inFlight);try{const url=new URL(request.url);assert.equal(url.host,'api.sandbox.push.apple.com');assert.equal(request.method,'POST');const jwt=request.headers.get('authorization').replace(/^bearer /,'').split('.');assert.equal(JSON.parse(Buffer.from(jwt[0],'base64url')).kid,'FAKEKEY001');assert.equal(JSON.parse(Buffer.from(jwt[1],'base64url')).iss,'FAKETEAM01');assert(verify('sha256',Buffer.from(jwt.slice(0,2).join('.')),{key:provider.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(jwt[2],'base64url')));pushes.push({body:await request.json(),url:request.url,topic:request.headers.get('apns-topic'),mode:deliveryMode});if(deliveryMode==='dead'&&rotateDuringDelivery){const rotate=rotateDuringDelivery;rotateDuringDelivery=undefined;await rotate();}await new Promise(r=>setTimeout(r,10));return deliveryMode==='dead'?new LocalResponse(JSON.stringify({reason:'Unregistered'}),{status:410}):deliveryMode==='fail'?new LocalResponse(JSON.stringify({reason:'InternalServerError'}),{status:500}):new LocalResponse(null,{status:200});}finally{--inFlight;}},
  bindings:{COMMUNITY_ISSUER_JWK:JSON.stringify(issuer.privateKey.export({format:'jwk'})),COMMUNITY_STATE_KEY:randomBytes(32).toString('base64url'),COMMUNITY_BOOTSTRAP_HOST:point(admin.host.publicKey),COMMUNITY_BOOTSTRAP_VIEWER:point(admin.bio.publicKey),COMMUNITY_BOOTSTRAP_PROFILE:profile,APNS_KEY_P8:provider.privateKey.export({format:'pem',type:'pkcs8'}),APNS_KEY_ID:'FAKEKEY001',APNS_TEAM_ID:'FAKETEAM01',APNS_TOPICS:topic}});
 function request(v,op,args,person=admin,actor=person.enrollment,key){const bytes=Buffer.from(JSON.stringify([v,op,randomUUID(),Date.now(),randomBytes(32).toString('base64url'),actor,args]));const domain=v===1?'agentstoz.screen-community.request/v1\0':'agentstoz.community-access.request/v2\0';return {payload:bytes.toString('base64url'),signature:sig(key??(op==='bootstrap'||op.startsWith('approve')||['push-register','push-remove','revoke'].includes(op)?person.bio.privateKey:person.host.privateKey),domain,bytes),...(op==='bootstrap'?{hostSignature:sig(person.host.privateKey,domain,bytes)}:{})};}
 async function run(v,envelope){const response=await service.dispatchFetch(`https://community.invalid/v${v}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope)});const wrapped=await response.json();assert(wrapped.payload,'signed response required');const bytes=Buffer.from(wrapped.payload,'base64url'),domain=v===1?'agentstoz.screen-community.response/v1\0':'agentstoz.community-access.response/v2\0';assert(verify('sha256',Buffer.concat([Buffer.from(domain),bytes]),{key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(wrapped.signature,'base64url')));return {status:response.status,envelope:wrapped,body:JSON.parse(bytes)};}
 const legacy=await run(1,request(1,'bootstrap',[profile,admin.device,admin.name,point(admin.host.publicKey),point(admin.bio.publicKey),'none','Fixture'],admin,null));const cid=legacy.body[4];admin.enrollment=legacy.body[6];
 const v1=(op,args,who=admin)=>run(1,request(1,op,args,who));
 const v2=(op,args,who=admin,actor=who.enrollment,key)=>run(2,request(2,op,args,who,actor,key));
 function plan(who){return {version:1,profileId:profile,deviceId:who.device,name:who.name,kind:who.kind,hostKey:point(who.host.publicKey),biometricKey:point(who.bio.publicKey),operationKey:point(who.op.publicKey),controlKey:null,agentDeviceId:null,capabilities:['screen.view']};}
 async function wait(count){const end=Date.now()+7000;while((accessPushes().length<count||inFlight>0)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(accessPushes().length,count);assert.equal(inFlight,0,'provider response phase must finish before the next mode');const ns=await service.getDurableObjectNamespace('REGISTRY');await ns.get(ns.idFromName('screen-community-registry-v1')).fixtureNotificationIdle();}
 function checkNotice(push,pending){assert.equal(push.topic,topic);const n=push.body.communityEnrollment,bytes=Buffer.from(n.payload,'base64url');assert(verify('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.notice/v2\0'),bytes]),{key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(n.signature,'base64url')));const fields=JSON.parse(bytes);assert.deepEqual([fields[0],fields[1],fields[2],fields[4],fields[5],fields[6]],[2,'access-enrollment-notice',pending.planId,cid,profile,pending.digest]);assert(!bytes.toString().includes(point(mobile.host.publicKey)));}
 assert.equal((await v1('push-register',[cid,'ab'.repeat(32),'sandbox',topic])).body[1],'push-registered');
 const submitted=request(2,'prepare',[plan(mobile)],mobile,null),prepared=await run(2,submitted);assert.equal(prepared.body[1],'prepared');await wait(1);checkNotice(accessPushes()[0],prepared.body[4]);
 assert.deepEqual((await run(2,submitted)).envelope,prepared.envelope);assert.equal(accessPushes().length,1,'duplicate prepare does not notify again');
 const reviewed=(await v2('review-management',[cid,prepared.body[4].planId,true])).body[4];assert(reviewed.management.administrator);
 const args=[cid,reviewed.planId,reviewed.digest,reviewed.challenge,reviewed.revision,reviewed.management.digest];
 assert.equal((await v2('approve',args.slice(0,5))).body[4].code,'MANAGEMENT_REVIEW_REQUIRED');
 assert.equal((await v2('approve-management',args,admin,admin.enrollment,admin.host.privateKey)).body[4].code,'INVALID_PROOF');
 const approval=request(2,'approve-management',args),approved=await run(2,approval);assert.equal(approved.body[1],'authorization');mobile.enrollment=approved.body[4].enrollmentId;
 assert.deepEqual((await run(2,approval)).envelope,approved.envelope,'same approval returns the original durable receipt');
 const self=await v1('recover',[profile,mobile.device,point(mobile.host.publicKey),point(mobile.bio.publicKey)],{...mobile,enrollment:null});assert.equal(self.body[1],'member');assert.equal(self.body[12],true,'fresh signed self-member certificate reports explicit administrator role');
 assert.equal((await v1('push-register',[cid,'cd'.repeat(32),'sandbox',topic],mobile)).body[1],'push-registered');
 const extra=[];
 for(let i=0;i<3;i++){
  const person=device(`Other manager ${i}`),entry=await v1('entry',[profile,person.device,person.name,point(person.host.publicKey),point(person.bio.publicKey),'none',cid,'ios'],{...person,enrollment:null});
  const review=await v1('review',[cid,entry.body[4]]),accepted=await v1('approve-entry',[cid,entry.body[4],review.body[14],'none',true,review.body[5]]);person.enrollment=accepted.body[6];
  assert.equal((await v1('push-register',[cid,(10+i).toString(16).padStart(2,'0').repeat(32),'sandbox',topic],person)).body[1],'push-registered');extra.push(person);
 }
 // One request, five eligible recipients, and no follow-up client request: the fifth must arrive from the durable alarm.
 const second=await v2('prepare',[plan(joining)],joining,null);assert.equal(second.body[1],'prepared');await wait(6);
 for(const push of accessPushes().slice(1,6))checkNotice(push,second.body[4]);
 assert(maximumInFlight<=4,'legacy and v2 share one four-job concurrency budget');
 for(const person of [admin,...extra])await v1('push-remove',[cid],person);
 mode='fail';const third=device('Failure is advisory','desktop'),thirdRequest=request(2,'prepare',[plan(third)],third,null),failure=await run(2,thirdRequest);assert.equal(failure.body[1],'prepared');await wait(7);assert.deepEqual((await run(2,thirdRequest)).envelope,failure.envelope);assert.equal(accessPushes().length,7,'provider failure never retries or changes the registration receipt');
 mode='dead';rotateDuringDelivery=async()=>{assert.equal((await v1('push-register',[cid,'ef'.repeat(32),'sandbox',topic],mobile)).body[1],'push-registered');};
 const fourth=device('Dead token after rotation','desktop');assert.equal((await v2('prepare',[plan(fourth)],fourth,null)).body[1],'prepared');await wait(8);
 mode='ok';
 const ownUpdate=await v2('prepare',[{...plan(mobile),name:'Explicit role revoke'}],mobile,null);await wait(9);
 assert(accessPushes()[8].url.endsWith('ef'.repeat(32)),'late dead-token response preserved the new subscription');
 const rr=(await v2('review-management',[cid,ownUpdate.body[4].planId,false])).body[4];
 assert.equal((await v2('approve-management',[cid,rr.planId,rr.digest,rr.challenge,rr.revision,rr.management.digest])).body[1],'authorization');
 const after=(await v1('recover',[profile,mobile.device,point(mobile.host.publicKey),point(mobile.bio.publicKey)],{...mobile,enrollment:null})).body;assert.equal(after[12],false);
 assert.equal((await v1('push-register',[cid,'ef'.repeat(32),'sandbox',topic],mobile)).body.at(-1),'ADMIN_REQUIRED');
 const count=accessPushes().length,sixth=device('After revoke','desktop');assert.equal((await v2('prepare',[plan(sixth)],sixth,null)).body[1],'prepared');await new Promise(r=>setTimeout(r,1200));assert.equal(accessPushes().length,count,'revoked management role cannot receive more notices');
 assert(maximumInFlight<=4);assert.equal(outbound,pushes.length,'all outbound requests were verified local APNs interceptions');
 console.log('PASS: actual workerd/SQLite explicit management BIO approval+receipt, pinned notice/provider signatures, v2 delivery to five recipients without follow-up requests, four-job concurrency, failure isolation, in-flight token rotation and role revocation; no live networking');
}finally{await service?.dispose();await rm(temp,{recursive:true,force:true});}
