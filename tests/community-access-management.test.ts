import {describe,test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomBytes,randomUUID,generateKeyPairSync,sign,verify} from 'node:crypto';
import {CommunityRegistry} from '../cloud/screen-community/src/registry';
import {CommunityAccessRegistry} from '../cloud/screen-community/src/accessRegistry';
import {DurableRegistryStore} from '../cloud/screen-community/src/store';
import {REQUEST_DOMAIN,keyString,verifyEnvelope,seal,openSealed} from '../cloud/screen-community/src/protocol';
import {ACCESS_REQUEST_DOMAIN,ACCESS_NOTICE_DOMAIN,verifyAccessEnvelope,type AccessPlan,type AccessOperation} from '../cloud/screen-community/src/accessProtocol';
import {accessManagementDigest} from '../cloud/screen-community/src/accessManagement';
const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function fixture(){
  let now=1_800_000_000_000;
  const db=new Database(':memory:');const store=new DurableRegistryStore({sql:{exec:(sql:string,...args:unknown[])=>db.query(sql).all(...args as never[]) as never},transactionSync:<T>(body:()=>T)=>db.transaction(body)()});
  const issuer=key(),admin={host:key(),bio:key(),operation:key(),device:randomUUID()},mobile={host:key(),bio:key(),operation:key(),device:randomUUID()},profile=randomUUID(),state=randomBytes(32),issuerPublic=keyString(issuer.publicKey),topic='com.example.fixture.mobile';
  function signature(bytes:Buffer,signer:typeof issuer.privateKey,domain:Buffer){return sign('sha256',Buffer.concat([domain,bytes]),{key:signer,dsaEncoding:'ieee-p1363'}).toString('base64url');}
  const old=new CommunityRegistry(store,issuer.privateKey,state,()=>now,()=>true,[topic]);
  const boot=Buffer.from(JSON.stringify([1,'bootstrap',randomUUID(),now,randomBytes(32).toString('base64url'),null,[profile,admin.device,'Manager',keyString(admin.host.publicKey),keyString(admin.bio.publicKey),'none','Fixture']]));
  const body=verifyEnvelope(old.handle({payload:boot.toString('base64url'),signature:signature(boot,admin.bio.privateKey,REQUEST_DOMAIN),hostSignature:signature(boot,admin.host.privateKey,REQUEST_DOMAIN)},'software').envelope,issuerPublic);
  const cid=body[4] as string,actor=body[6] as string;
  const service=()=>new CommunityAccessRegistry(store,issuer.privateKey,issuerPublic,state,()=>now,[topic]);
  const request=(op:AccessOperation,args:unknown[],signer=admin.host.privateKey,subject:string|null=actor)=>{const bytes=Buffer.from(JSON.stringify([2,op,randomUUID(),now,randomBytes(32).toString('base64url'),subject,args]));return {payload:bytes.toString('base64url'),signature:signature(bytes,signer,ACCESS_REQUEST_DOMAIN)};};
  const run=(envelope:ReturnType<typeof request>)=>{const response=service().handle(envelope,'software');const fields=verifyAccessEnvelope(response.envelope,issuerPublic);return {envelope:response.envelope,kind:fields[1],value:fields[4] as any};};
  const plan:AccessPlan={version:1,profileId:profile,deviceId:mobile.device,name:'iPad / 한글',kind:'mobile',hostKey:keyString(mobile.host.publicKey),biometricKey:keyString(mobile.bio.publicKey),operationKey:keyString(mobile.operation.publicKey),controlKey:null,agentDeviceId:null,capabilities:['screen.view','agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser']};
  const prepare=(value=plan,signer=mobile.host.privateKey)=>run(request('prepare',[value],signer,null)).value;
  const review=(planId:string,role?:boolean)=>run(request(role===undefined?'review':'review-management',role===undefined?[cid,planId]:[cid,planId,role]));
  const approval=(r:any,role=false,signer=admin.bio.privateKey)=>request(role?'approve-management':'approve',[cid,r.planId,r.digest,r.challenge,r.revision,...(role?[r.management.digest]:[])],signer);
  const subscribe=(id=actor,token='ab'.repeat(32))=>store.put(`push:${id}`,seal({token,environment:'sandbox',topic},state,id));
  return {db,store,issuer,issuerPublic,state,admin,mobile,profile,cid,actor,topic,service,request,run,plan,prepare,review,approval,subscribe,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
function member(f:ReturnType<typeof fixture>,deviceId=f.mobile.device){return (f.store.get<any>(`community:${f.cid}`).memberIds as string[]).map(id=>f.store.get<any>(`member:${id}`)).find(m=>m.deviceId===deviceId&&m.revokedAt===null);}
describe('explicit management consent and advisory v2 notifications',()=>{
  test('ordinary full-feature approval never creates a mobile administrator and preserves a prior role',()=>{
    const f=fixture(),p=f.prepare(),r=f.review(p.planId).value;expect(f.run(f.approval(r)).kind).toBe('authorization');expect(member(f).admin).toBe(false);
    const m=member(f);m.admin=true;f.store.put(`member:${m.enrollmentId}`,m);
    const next=f.prepare(),review=f.review(next.planId).value;expect(f.run(f.approval(review)).kind).toBe('authorization');expect(member(f).admin).toBe(true);
  });
  test('management bytes bind the reviewed plan, exact keys, role, revision, nonce and target epoch; only BIO can approve',()=>{
    const f=fixture(),p=f.prepare(),r=f.review(p.planId,true).value;
    expect(accessManagementDigest(r,r.plan,r.management)).toBe(r.management.digest);
    for(const changed of [{administrator:false},{targetKeyEpoch:2},{nonce:randomBytes(32).toString('base64url')},{communityId:randomUUID()}])expect(accessManagementDigest(r,r.plan,{...r.management,...changed})).not.toBe(r.management.digest);
    expect(f.run(f.approval(r,true,f.admin.host.privateKey)).value.code).toBe('INVALID_PROOF');
    const bad=f.request('approve-management',[f.cid,r.planId,r.digest,r.challenge,r.revision,'0'.repeat(64)],f.admin.bio.privateKey);expect(f.run(bad).value.code).toBe('STALE_MANAGEMENT');
    const proof=f.approval(r,true),ok=f.run(proof);expect(ok.kind).toBe('authorization');expect(member(f).admin).toBe(true);
    expect(f.run(proof).envelope).toEqual(ok.envelope);expect(f.store.get<any>(`community:${f.cid}`).revision).toBe(r.revision+1);
  });
  test('normal and management reviews cannot consume each other or downgrade the selected role',()=>{
    const f=fixture(),p=f.prepare(),management=f.review(p.planId,true).value;
    expect(f.run(f.approval(management)).value.code).toBe('MANAGEMENT_REVIEW_REQUIRED');
    const normal=f.review(p.planId).value;
    expect(f.run(f.request('approve-management',[f.cid,p.planId,normal.digest,normal.challenge,normal.revision,management.management.digest],f.admin.bio.privateKey)).value.code).toBe('MANAGEMENT_REVIEW_REQUIRED');
    expect(member(f)).toBeUndefined();expect(f.run(f.approval(normal)).kind).toBe('authorization');expect(member(f).admin).toBe(false);
  });
  test('fresh grant/revoke is atomic with the selected plan; revocation removes its push subscription',()=>{
    const f=fixture(),p=f.prepare(),r=f.review(p.planId,true).value;f.run(f.approval(r,true));const m=member(f);f.subscribe(m.enrollmentId);
    const next=f.prepare({...f.plan,capabilities:['screen.view']}),revoke=f.review(next.planId,false).value;
    expect(revoke.management.previousAdministrator).toBe(true);expect(revoke.management.administrator).toBe(false);
    const result=f.run(f.approval(revoke,true));expect(result.kind).toBe('authorization');expect(result.value.capabilities).toEqual(['screen.view']);expect(member(f).admin).toBe(false);expect(f.store.get(`push:${m.enrollmentId}`)).toBeUndefined();
  });
  test('self management, wrong kind, revoked identity, stale revision/epoch and expired reviews are refused',()=>{
    for(const change of ['self','kind','revoked','revision','epoch','expiry']){
      const f=fixture();let plan=f.plan;
      if(change==='self'){const m=f.store.get<any>(`member:${f.actor}`);m.platform='ios';f.store.put(`member:${f.actor}`,m);plan={...plan,deviceId:f.admin.device,hostKey:keyString(f.admin.host.publicKey),biometricKey:keyString(f.admin.bio.publicKey),operationKey:keyString(f.admin.operation.publicKey)};}
      if(change==='kind')plan={...plan,kind:'desktop',capabilities:['screen.view']};
      if(['revoked','epoch'].includes(change)){
        const p=f.prepare(),r=f.review(p.planId).value;f.run(f.approval(r));const m=member(f);if(change==='revoked'){m.revokedAt=f.now();f.store.put(`member:${m.enrollmentId}`,m);}
      }
      const p=f.prepare(plan,change==='self'?f.admin.host.privateKey:f.mobile.host.privateKey),r=f.review(p.planId,true);
      if(change==='self'){expect(r.value.code).toBe('SELF_MANAGEMENT_FORBIDDEN');continue;}
      if(change==='kind'){expect(r.value.code).toBe('INVALID_MANAGEMENT');continue;}
      if(change==='revoked'){expect(r.value.code).toBe('REVOKED_IDENTITY');continue;}
      if(change==='revision'){const c=f.store.get<any>(`community:${f.cid}`);c.revision++;f.store.put(`community:${f.cid}`,c);}
      if(change==='epoch'){const m=member(f);m.keyEpoch++;f.store.put(`member:${m.enrollmentId}`,m);}
      if(change==='expiry')f.advance(120_001);
      const result=f.run(f.approval(r.value,true));expect(result.kind).toBe('error');expect(member(f)?.admin??false).toBe(false);
    }
  });
  test('a forged last-admin state is still refused without committing policy or role',()=>{
    const f=fixture(),p=f.prepare(),r=f.review(p.planId,true).value;f.run(f.approval(r,true));
    const next=f.prepare(),revoke=f.review(next.planId,false).value;
    // Defensive corrupted-state fixture: the approved actor is not in the community's admin enumeration.
    const c=f.store.get<any>(`community:${f.cid}`);c.memberIds=c.memberIds.filter((id:string)=>id!==f.actor);f.store.put(`community:${f.cid}`,c);
    expect(f.run(f.approval(revoke,true)).value.code).toBe('LAST_ADMIN_REQUIRED');expect(member(f).admin).toBe(true);
  });
  test('new prepare emits one issuer/domain-bound advisory job; replay/status do not emit again',()=>{
    const f=fixture();f.subscribe();const request=f.request('prepare',[f.plan],f.mobile.host.privateKey,null),prepared=f.run(request),jobs=f.service().takeNotifications();expect(jobs).toHaveLength(1);const job=jobs[0]!;
    const bytes=Buffer.from(job.notice.payload,'base64url');expect(verify('sha256',Buffer.concat([ACCESS_NOTICE_DOMAIN,bytes]),{key:f.issuer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(job.notice.signature,'base64url'))).toBe(true);
    expect(JSON.parse(bytes.toString())).toEqual([2,'access-enrollment-notice',prepared.value.planId,f.now(),f.cid,f.profile,prepared.value.digest,prepared.value.expiresAt]);
    expect(bytes.includes(Buffer.from(f.plan.hostKey))).toBe(false);expect(bytes.includes(Buffer.from(job.token))).toBe(false);
    expect(f.run(request).envelope).toEqual(prepared.envelope);f.run(f.request('status',[prepared.value.planId],f.mobile.host.privateKey,null));expect(f.service().takeNotifications()).toEqual([]);
  });
  test('queued recipients and requests revalidate current admin, revocation, epoch, topic, token, expiry and approval',()=>{
    for(const change of ['admin','revoke','epoch','token','expiry','approved']){
      const f=fixture();f.subscribe();const p=f.prepare(),job=f.service().takeNotifications()[0]!;expect(f.service().notificationCurrent(job)).toBe(true);
      const m=f.store.get<any>(`member:${f.actor}`);
      if(change==='admin')m.admin=false;if(change==='revoke')m.revokedAt=f.now();if(change==='epoch')m.keyEpoch++;
      f.store.put(`member:${f.actor}`,m);
      if(change==='token')f.subscribe(f.actor,'cd'.repeat(32));if(change==='expiry')f.advance(600_001);
      if(change==='approved'){const r=f.review(p.planId).value;f.run(f.approval(r));}
      expect(f.service().notificationCurrent(job)).toBe(false);
    }
  });
  test('dead-token cleanup cannot erase a newer registration',()=>{
    const f=fixture();f.subscribe();f.prepare();const job=f.service().takeNotifications()[0]!;f.subscribe(f.actor,'cd'.repeat(32));f.service().removeDeadPush(job);
    expect(openSealed<any>(f.store.get<string>(`push:${f.actor}`)!,f.state,f.actor).token).toBe('cd'.repeat(32));
    const next={...job,token:'cd'.repeat(32)};f.service().removeDeadPush(next);expect(f.store.get(`push:${f.actor}`)).toBeUndefined();
  });
  test('closed approval and expired staging recover the exact registered policy without any legacy client certificate',()=>{
    const f=fixture(),original=f.request('prepare',[f.plan],f.mobile.host.privateKey,null),p=f.run(original).value,r=f.review(p.planId).value;
    const approved=f.run(f.approval(r));f.advance(600_001);
    const recovered=f.run(f.request('recover-registration',[f.plan,original],f.mobile.host.privateKey,null));
    expect(recovered.kind).toBe('authorization');expect(recovered.value.enrollmentId).toBe(approved.value.enrollmentId);expect(recovered.value.publicKey).toBe(f.plan.operationKey);
    const otherPlan=f.run(f.request('recover-registration',[{...f.plan,name:'Different reviewed plan'}],f.mobile.host.privateKey,null));expect(otherPlan.kind).toBe('registration-absent');expect(otherPlan.value.originalRequestId).toBeNull();
    expect(f.run(f.request('recover-registration',[f.plan],f.admin.host.privateKey,null)).value.code).toBe('INVALID_PROOF');
  });
  test('an expired same-key feature update can be checked without overwriting the prior registered policy or resurrecting changed keys',()=>{
    const f=fixture(),first=f.prepare(),review=f.review(first.planId).value,approved=f.run(f.approval(review)),id=approved.value.enrollmentId;
    const update={...f.plan,name:'iPad revised',capabilities:['screen.view'] as AccessPlan['capabilities']};
    const original=f.request('prepare',[update],f.mobile.host.privateKey,null),pending=f.run(original);
    expect(pending.kind).toBe('prepared');
    expect(f.run(f.request('recover-registration',[update,original],f.mobile.host.privateKey,null)).kind).toBe('prepared');
    f.advance(600_001);
    const absent=f.run(f.request('recover-registration',[update,original],f.mobile.host.privateKey,null));expect(absent.kind).toBe('registration-absent');expect(absent.value.originalRequestId).toBe(pending.value.planId);
    const current=f.run(f.request('authorization',[f.cid],f.mobile.operation.privateKey,id));expect(current.value.capabilities).toEqual(f.plan.capabilities);expect(current.value.name).toBe(f.plan.name);
    const changedKey={...update,operationKey:keyString(key().publicKey)};
    expect(f.run(f.request('recover-registration',[changedKey],f.mobile.host.privateKey,null)).value.code).toBe('POLICY_CHANGED');
    expect(f.run(f.request('recover-registration',[f.plan],f.mobile.host.privateKey,null)).kind).toBe('authorization');
    const next=f.run(f.request('prepare',[update],f.mobile.host.privateKey,null));expect(next.kind).toBe('prepared');
  });
  test('an absence probe inside the original acceptance window never releases a delayed prepare',()=>{
    const f=fixture(),original=f.request('prepare',[f.plan],f.mobile.host.privateKey,null);
    const probe=f.run(f.request('recover-registration',[f.plan,original],f.mobile.host.privateKey,null));expect(probe.value.code).toBe('REQUEST_STILL_POSSIBLE');
    const committed=f.run(original);expect(committed.kind).toBe('prepared');
    const positive=f.run(f.request('recover-registration',[f.plan,original],f.mobile.host.privateKey,null));expect(positive.kind).toBe('prepared');expect(positive.value.planId).toBe(committed.value.planId);
    f.advance(60_001);expect(f.run(f.request('recover-registration',[f.plan,original],f.mobile.host.privateKey,null)).kind).toBe('prepared');
  });
  test('a bound absence is issued only after the old signature can no longer be admitted; plan-only absence cannot claim a fence',()=>{
    const f=fixture(),original=f.request('prepare',[f.plan],f.mobile.host.privateKey,null),at=f.now();
    const readOnly=f.run(f.request('recover-registration',[f.plan],f.mobile.host.privateKey,null));expect(readOnly.kind).toBe('registration-absent');expect(readOnly.value.originalRequestId).toBeNull();expect(readOnly.value.originalRequestHash).toBeNull();
    f.advance(60_001);const result=f.run(f.request('recover-registration',[f.plan,original],f.mobile.host.privateKey,null));expect(result.kind).toBe('registration-absent');
    expect(result.value.originalIssuedAt).toBe(at);expect(result.value.originalRequestId).toBe(JSON.parse(Buffer.from(original.payload,'base64url').toString())[2]);
    expect(result.value.originalRequestHash).toBe(require('node:crypto').createHash('sha256').update(JSON.stringify([original.payload,original.signature])).digest('hex'));
    expect(f.run(original).kind).toBe('error');expect(member(f)).toBeUndefined();expect(f.store.get(`access-pending:${f.cid}`)).toBeUndefined();
    const changed=f.request('prepare',[{...f.plan,name:'Foreign original'}],f.mobile.host.privateKey,null);f.advance(60_001);
    expect(f.run(f.request('recover-registration',[f.plan,changed],f.mobile.host.privateKey,null)).value.code).toBe('RECOVERY_BINDING_MISMATCH');
  });

  test('four-job batches retain remaining recipients and many pending plans stay bounded',()=>{
    const f=fixture();f.subscribe();const community=f.store.get<any>(`community:${f.cid}`);
    for(let i=0;i<4;i++){const id=randomUUID(),host=key(),bio=key();community.memberIds.push(id);f.store.put(`member:${id}`,{enrollmentId:id,communityId:f.cid,profileId:f.profile,deviceId:randomUUID(),name:'Other manager',hostKey:keyString(host.publicKey),viewerKey:keyString(bio.publicKey),platform:'ios',grant:'none',admin:true,keyEpoch:1,joinedAt:f.now(),revokedAt:null,route:null});f.subscribe(id,(10+i).toString(16).padStart(2,'0').repeat(32));}
    f.store.put(`community:${f.cid}`,community);f.prepare();expect(f.service().takeNotifications()).toHaveLength(4);expect(f.service().hasNotifications()).toBe(true);expect(f.service().takeNotifications()).toHaveLength(1);expect(f.service().hasNotifications()).toBe(false);
    const bounded=fixture();
    for(let i=0;i<32;i++){if(i&&i%6===0)bounded.advance(61_000);const host=key(),bio=key(),op=key();const plan={...bounded.plan,deviceId:randomUUID(),hostKey:keyString(host.publicKey),biometricKey:keyString(bio.publicKey),operationKey:keyString(op.publicKey)};expect(bounded.prepare(plan,host.privateKey).planId).toBeDefined();}
    expect(bounded.store.get<string[]>('access-notification-queue')).toHaveLength(32);
    const host=key(),bio=key(),op=key();const next={...bounded.plan,deviceId:randomUUID(),hostKey:keyString(host.publicKey),biometricKey:keyString(bio.publicKey),operationKey:keyString(op.publicKey)};
    expect(bounded.prepare(next,host.privateKey).code).toBe('TOO_MANY_REQUESTS');expect(bounded.store.get<string[]>('access-notification-queue')).toHaveLength(32);
  });

});
