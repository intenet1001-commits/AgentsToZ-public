// Actual workerd + SQLite Durable Object, isolated ephemeral port and ephemeral issuer/device keys.
import {Miniflare,Log,LogLevel,Response as LocalResponse} from 'miniflare';
import {generateKeyPairSync,randomBytes,randomUUID,sign,verify} from 'node:crypto';
import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function keyString(key){const k=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(k.x,'base64url'),Buffer.from(k.y,'base64url')]).toString('base64url');}
const issuer=keys(),admin={host:keys(),viewer:keys(),id:randomUUID()},joining={host:keys(),viewer:keys(),id:randomUUID()},profile=randomUUID();
const temporary=await mkdtemp(join(tmpdir(),'screen-community-worker-'));
const apns=keys(),pushes=[];
let worker;
try{
  const bundle=await Bun.build({entrypoints:[new URL('../src/worker.ts',import.meta.url).pathname],target:'browser',
    external:['cloudflare:workers','node:*'],outdir:temporary});
  assert(bundle.success,'Worker bundle must build');
  worker=new Miniflare({cf:false,scriptPath:join(temporary,'worker.js'),modules:true,modulesRoot:temporary,compatibilityDate:'2026-07-29',
    compatibilityFlags:['nodejs_compat'],port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),
    durableObjects:{REGISTRY:{className:'ScreenCommunityRegistry',useSQLite:true}},
    // All outbound traffic is intercepted. This test must never contact Apple or any production service.
    outboundService:async request=>{
      const url=new URL(request.url);assert.equal(url.host,'api.push.apple.com');assert.equal(request.method,'POST');
      pushes.push({url:request.url,headers:request.headers,body:await request.json()});
      return new LocalResponse(null,{status:200});
    },
    bindings:{COMMUNITY_ISSUER_JWK:JSON.stringify(issuer.privateKey.export({format:'jwk'})),COMMUNITY_STATE_KEY:randomBytes(32).toString('base64url'),
      COMMUNITY_BOOTSTRAP_HOST:keyString(admin.host.publicKey),COMMUNITY_BOOTSTRAP_VIEWER:keyString(admin.viewer.publicKey),COMMUNITY_BOOTSTRAP_PROFILE:profile,
      APNS_KEY_P8:apns.privateKey.export({format:'pem',type:'pkcs8'}),APNS_KEY_ID:'FAKEKEY001',APNS_TEAM_ID:'FAKETEAM01',APNS_TOPICS:'com.intenet.agentstoz.mobile'}});
  function request(op,args,person=admin,actor=null){
    const bytes=Buffer.from(JSON.stringify([1,op,randomUUID(),Date.now(),randomBytes(32).toString('base64url'),actor,args]));
    const input=Buffer.concat([Buffer.from('agentstoz.screen-community.request/v1\0'),bytes]);
    const signature=key=>sign('sha256',input,{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return {payload:bytes.toString('base64url'),signature:signature(['bootstrap','approve','approve-entry','revoke','push-register','push-remove'].includes(op)?person.viewer.privateKey:person.host.privateKey),
      ...(op==='bootstrap'?{hostSignature:signature(person.host.privateKey)}:{})};
  }
  async function run(envelope){
    const response=await worker.dispatchFetch('https://community.test/v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope)});
    const result=await response.json();
    assert(result.payload,`Expected a signed response; status ${response.status}: ${JSON.stringify(result)}`);
    const bytes=Buffer.from(result.payload,'base64url');
    assert(verify('sha256',Buffer.concat([Buffer.from('agentstoz.screen-community.response/v1\0'),bytes]),
      {key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(result.signature,'base64url')),'issuer proof');
    return {status:response.status,envelope:result,body:JSON.parse(bytes)};
  }
  const boot=await run(request('bootstrap',[profile,admin.id,'Mac 3',keyString(admin.host.publicKey),keyString(admin.viewer.publicKey),'control','AgentsToZ']));
  assert.equal(boot.body[1],'member',JSON.stringify(boot.body));const community=boot.body[4],actor=boot.body[6];
  const invite=await run(request('invite',[community],admin,actor));assert.equal(invite.body[1],'invite');
  const joinRequest=request('join',[profile,joining.id,'Mac 1',keyString(joining.host.publicKey),keyString(joining.viewer.publicKey),'control',invite.body[8]],joining);
  const concurrentJoin=await Promise.all(Array.from({length:8},()=>run(joinRequest)));
  for(const result of concurrentJoin)assert.deepEqual(result.envelope,concurrentJoin[0].envelope,'identical join replays recover exactly one receipt');
  const pending=concurrentJoin[0].body;assert.equal(pending[1],'pending');
  const approvals=await Promise.all(Array.from({length:8},()=>run(request('approve',[community,pending[4],pending[9],'control',false,1],admin,actor))));
  assert.equal(approvals.filter(r=>r.body[1]==='approved').length,1,'one concurrent approval changes membership');
  const receipt=await run(request('receipt',[JSON.parse(Buffer.from(joinRequest.payload,'base64url'))[2]],joining));
  assert.equal(receipt.body[1],'member');const member=receipt.body[6];
  const lease=await run(request('directory',[community],joining,member));assert.equal(lease.body[10].length,2);
  const recovered=await run(request('recover',[profile,joining.id,keyString(joining.host.publicKey),keyString(joining.viewer.publicKey)],joining));
  assert.equal(recovered.body[6],member,'recovery returns existing membership');
  const revokes=await Promise.all(Array.from({length:8},()=>run(request('revoke',[community,member,2],admin,actor))));
  assert.equal(revokes.filter(r=>r.body[1]==='revoked').length,1,'one concurrent revoke changes membership');
  const denied=await run(request('directory',[community],joining,member));assert.equal(denied.body.at(-1),'NOT_ENROLLED');
  const revive=await run(request('recover',[profile,joining.id,keyString(joining.host.publicKey),keyString(joining.viewer.publicKey)],joining));
  assert.equal(revive.body.at(-1),'NOT_ENROLLED','recovery cannot undo revoke');
  const subscribed=await run(request('push-register',[community,'ab'.repeat(32),'production','com.intenet.agentstoz.mobile'],admin,actor));
  assert.equal(subscribed.body[1],'push-registered');
  const entry=await run(request('entry',[profile,joining.id,'iPad',keyString(joining.host.publicKey),keyString(joining.viewer.publicKey),'none',community,'ios'],joining));
  assert.equal(entry.body[1],'pending');
  const deadline=Date.now()+5000;while(!pushes.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(pushes.length,1,'workerd delivers one advisory notification to the enrolled admin');
  assert.equal(pushes[0].headers.get('apns-topic'),'com.intenet.agentstoz.mobile');
  const jwt=pushes[0].headers.get('authorization').replace(/^bearer /,'').split('.');
  assert.equal(JSON.parse(Buffer.from(jwt[0],'base64url')).kid,'FAKEKEY001');
  assert(verify('sha256',Buffer.from(jwt.slice(0,2).join('.')),{key:apns.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(jwt[2],'base64url')),'APNs provider proof works in workerd');
  const notice=pushes[0].body.communityEnrollment;
  const noticeBytes=Buffer.from(notice.payload,'base64url');
  assert(verify('sha256',Buffer.concat([Buffer.from('agentstoz.screen-community.response/v1\0'),noticeBytes]),{key:issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(notice.signature,'base64url')),'notification issuer proof');
  assert.equal(JSON.parse(noticeBytes)[1],'enrollment-notice');
  assert(!noticeBytes.toString().includes(entry.body[9]),'push is not a code/approval capability');
  const review=await run(request('review',[community,entry.body[4]],admin,actor));assert.equal(review.body[1],'pending-review');
  const approveEntry=await run(request('approve-entry',[community,entry.body[4],review.body[14],'none',true,review.body[5]],admin,actor));
  assert.equal(approveEntry.body[1],'approved');
  const leaving=request('leave',[community],joining,approveEntry.body[6]);
  const left=await run(leaving);assert.equal(left.body[1],'revoked');
  const leaveReceipt=await run(request('receipt',[JSON.parse(Buffer.from(leaving.payload,'base64url'))[2]],joining));
  assert.equal(leaveReceipt.body[1],'receipt');assert.deepEqual(leaveReceipt.body[5],left.envelope);
  const tooLarge=await worker.dispatchFetch('https://community.test/v1',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(32_769)});
  assert.equal(tooLarge.status,413);
  console.log('PASS: actual workerd/SQLite concurrent enrollment/revocation, push provider+issuer signatures with intercepted APNs, owner review, host-key leave receipt, recovery denial and bounded body');
}finally{await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
