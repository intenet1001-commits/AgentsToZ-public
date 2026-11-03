import {test,expect} from 'bun:test';
import {randomUUID,randomBytes,sign,createHash} from 'node:crypto';
import {verifyAccessEnvelope,ACCESS_REQUEST_DOMAIN,readAccessRequest,checkAccessProof} from '../cloud/screen-community/src/accessProtocol';
import golden from '../native/screen-control/Tests/Fixtures/community-owner-recovery-v1.json';
import {screenSafetyFixture,safetyPerson} from './fixtures/community-screen-safety';
import type {OwnerRecoveryRecord} from '../cloud/screen-community/src/ownerRecovery';

test('the shared public worker vector binds the source BIO signature and target challenge without any private key',()=>{
 expect(golden.softwareOnly).toBe(true);
 const key=golden.authority.issuerPublicKey,record=golden.record;
 expect(verifyAccessEnvelope(golden.approvedEnvelope,key)[4]).toEqual(record);
 expect(verifyAccessEnvelope(golden.roundEnvelope,key)[4]).toMatchObject({targetEnrollmentId:golden.target.enrollmentId,requests:[record]});
 expect(verifyAccessEnvelope(record.approval.source,key)[4]).toEqual(golden.source);
 expect(verifyAccessEnvelope(record.approval.target,key)[4]).toEqual(golden.target);
 expect(verifyAccessEnvelope(record.approval.delegation,key)[4]).toMatchObject({enabled:true,targetEnrollmentId:golden.target.enrollmentId,revision:record.delegationRevision});
 const request=readAccessRequest(record.approval.request,golden.at);
 expect(request.op).toBe('owner-recovery-approve');expect(request.actor).toBe(golden.source.enrollmentId);
 expect(request.args).toEqual([record.communityId,record.requestId,record.intent]);
 expect(()=>checkAccessProof(request,golden.source.biometricPublicKey)).not.toThrow();
 expect(()=>checkAccessProof(request,golden.source.publicKey)).toThrow();
 expect(()=>checkAccessProof(request,golden.target.biometricPublicKey)).toThrow();
});

function fixture(){
 const f=screenSafetyFixture(),caps=['screen.view','screen.control','screen.receive.view','screen.receive.control','screen.desktop-trust'] as const;
 f.enroll(f.root,[...caps],false);f.enroll(f.host,[...caps],false);
 const enable=(target=f.host,enabled=true,revision=0)=>f.call('owner-delegation-set',[f.cid,{version:1,enabled,expectedRevision:revision}],target,enabled?'bio':'host');
 const request=(source=f.root,target=f.host)=>f.call('owner-recovery-request',[f.cid,target.enrollment],source,'op');
 const publish=(record:OwnerRecoveryRecord,who=f.host)=>f.call('owner-recovery-publish',[f.cid,record.requestId,{version:1,action:'resume-input',holdGeneration:randomUUID(),connectionId:null,challenge:randomBytes(32).toString('base64url')}],who,'host');
 const ready=()=>{const own=verifyAccessEnvelope(f.call('owner-recovery-poll',[f.cid],f.host).value.delegation,f.issuerPublic)[4] as {enabled:boolean;revision:number};if(!own.enabled)expect(enable(f.host,true,own.revision).kind).toBe('owner-delegation');const r=request();expect(r.kind).toBe('owner-recovery');return publish(r.value);};
 const approve=(record:OwnerRecoveryRecord,who=f.root)=>f.call('owner-recovery-approve',[f.cid,record.requestId,record.intent],who,'bio');
 return {...f,enable,requestRecovery:request,publish,ready,approve};
}
test('delegation is initially disabled; only the target biometric key enables this narrow permission',()=>{
 const f=fixture(),poll=f.call('owner-recovery-poll',[f.cid],f.host);
 expect(verifyAccessEnvelope(poll.value.delegation,f.issuerPublic)[4]).toMatchObject({enabled:false,revision:0});
 expect(f.requestRecovery().value.code).toBe('OWNER_DELEGATION_DISABLED');
 expect(f.call('owner-delegation-set',[f.cid,{version:1,enabled:true,expectedRevision:0}],f.host,'host').value.code).toBe('INVALID_PROOF');
 expect(f.enable().value).toMatchObject({enabled:true,revision:1});expect(f.enable(f.host,false,1).value).toMatchObject({enabled:false,revision:2});
 expect(f.requestRecovery().value.code).toBe('OWNER_DELEGATION_DISABLED');
});
test('any qualified trusted Mac can approve its own request without gaining a global administrator role',()=>{
 const f=fixture();expect(f.store.get<{admin:boolean}>('member:'+f.host.enrollment)!.admin).toBe(false);
 expect(f.enable(f.root).kind).toBe('owner-delegation');const requested=f.requestRecovery(f.host,f.root),ready=f.publish(requested.value,f.root);
 const approved=f.approve(ready.value,f.host);expect(approved.value.state).toBe('approved');
 expect(f.store.get<{admin:boolean}>('member:'+f.host.enrollment)!.admin).toBe(false);
 expect(verifyAccessEnvelope(approved.value.approval.source,f.issuerPublic)[4]).toMatchObject({enrollmentId:f.host.enrollment});
});
test('approval keeps raw source BIO evidence and exact target policy; target result alone completes the operation',()=>{
 const f=fixture(),ready=f.ready(),raw=f.request('owner-recovery-approve',[f.cid,ready.value.requestId,ready.value.intent],f.root,'bio'),approved=f.run(raw);
 expect(approved.value.state).toBe('approved');expect(approved.value.approval.request).toEqual(raw);
 expect(verifyAccessEnvelope(approved.value.approval.target,f.issuerPublic)[4]).toMatchObject({enrollmentId:f.host.enrollment});
 expect(verifyAccessEnvelope(approved.value.approval.delegation,f.issuerPublic)[4]).toMatchObject({enabled:true,revision:1});
 expect(f.call('owner-recovery-result',[f.cid,ready.value.requestId,{version:1,outcome:'applied'}],f.root,'op').value.code).toBe('INVALID_OPERATION');
 const done=f.call('owner-recovery-result',[f.cid,ready.value.requestId,{version:1,outcome:'applied'}],f.host);expect(done.value.state).toBe('applied');
 expect(f.call('owner-recovery-result',[f.cid,ready.value.requestId,{version:1,outcome:'refused'}],f.host).value.code).toBe('OWNER_RESULT_CONFLICT');
});
test('a general operation or host key cannot replace the source biometric signature',()=>{
 const f=fixture(),r=f.ready();for(const key of ['op','host'] as const)expect(f.call('owner-recovery-approve',[f.cid,r.value.requestId,r.value.intent],f.root,key).value.code).toBe('INVALID_PROOF');
 expect(f.approve(r.value).value.state).toBe('approved');
});
test('a modified target, challenge, generation, deadline or extra permission cannot be approved',()=>{
 const f=fixture(),r=f.ready();for(const [field,value] of [['targetEnrollmentId',f.root.enrollment],['holdGeneration',randomUUID()],['connectionId',randomUUID()],['challenge',randomBytes(32).toString('base64url')],['expiresAt',f.now()+1],['action','turnOn']] as const){
  expect(f.call('owner-recovery-approve',[f.cid,r.value.requestId,{...r.value.intent,[field]:value}],f.root,'bio').value.code).toBe('OWNER_INTENT_CHANGED');
 }
 expect(f.call('owner-recovery-approve',[f.cid,r.value.requestId,{...r.value.intent,arbitraryCommand:'anything'}],f.root,'bio').kind).toBe('error');
 expect(f.approve(r.value).value.state).toBe('approved');
});
test('disabled delegation and changed source policy invalidate pending and already approved positive requests',()=>{
 for(const phase of ['ready','approved']){
  const f=fixture(),r=f.ready();if(phase==='approved')expect(f.approve(r.value).value.state).toBe('approved');
  expect(f.enable(f.host,false,1).kind).toBe('owner-delegation');
  expect(f.call('owner-recovery-poll',[f.cid],f.host).value.requests).toEqual([]);
  expect(f.call('owner-recovery-status',[f.cid,r.value.requestId],f.root,'op').value.state).toBe('superseded');
 }
 const f=fixture(),r=f.ready();f.enroll(f.root,['screen.view'],false);
 expect(f.call('owner-recovery-poll',[f.cid],f.host).value.requests).toEqual([]);
});
test('a request has a five-minute setup deadline and the published challenge only two minutes',()=>{
 const f=fixture(),r=f.ready();expect(r.value.expiresAt).toBe(f.now()+120_000);f.advance(120_001);
 expect(f.approve(r.value).value.code).toBe('OWNER_REQUEST_NOT_READY');expect(f.call('owner-recovery-status',[f.cid,r.value.requestId],f.root,'op').value.state).toBe('expired');
});
test('lost approval responses recover the exact outer mutation receipt; a fresh id never approves twice',()=>{
 const f=fixture(),r=f.ready(),raw=f.request('owner-recovery-approve',[f.cid,r.value.requestId,r.value.intent],f.root,'bio');
 const id=JSON.parse(Buffer.from(raw.payload,'base64url').toString())[2],first=f.run(raw);expect(f.run(raw).envelope).toEqual(first.envelope);
 expect(f.call('receipt',[id],f.root,'host').value.result).toEqual(first.envelope);
 expect(f.approve(r.value).value.code).toBe('OWNER_REQUEST_NOT_READY');
});
test('a delayed target outcome is historical evidence and cannot revive an expired approval',()=>{
 const f=fixture(),r=f.ready();f.approve(r.value);f.advance(121_000);
 expect(f.call('owner-recovery-poll',[f.cid],f.host).value.requests).toEqual([]);
 expect(f.call('owner-recovery-result',[f.cid,r.value.requestId,{version:1,outcome:'applied'}],f.host).value.state).toBe('applied');
 expect(f.call('owner-recovery-poll',[f.cid],f.host).value.requests).toEqual([]);
});
test('mobile, non-trusted, self-target and cross-member replies cannot gain recovery permission',()=>{
 const f=fixture();f.enable();expect(f.requestRecovery(f.mobile).value.code).toBe('OWNER_DESKTOP_REQUIRED');
 expect(f.requestRecovery(f.root,f.root).value.code).toBe('OTHER_OWNER_TARGET');
 const other=safetyPerson('Other');f.enroll(other,['screen.view','screen.desktop-trust'],false);
 const r=f.ready();expect(f.call('owner-recovery-status',[f.cid,r.value.requestId],other,'op').value.code).toBe('OTHER_OWNER_REQUEST');
 expect(f.call('owner-recovery-approve',[f.cid,r.value.requestId,r.value.intent],other,'bio').value.code).toBe('OTHER_OWNER_REQUEST');
});
test('duplicate logical requests coalesce and bounded queues retain terminal receipts',()=>{
 const f=fixture();f.enable();const first=f.requestRecovery();expect(f.requestRecovery().value.requestId).toBe(first.value.requestId);
 f.advance(61_000); // Keep the real six-prepares/minute guard; this case measures recovery queue capacity.
 for(let i=0;i<3;i++){const other=safetyPerson('Peer '+i);f.enroll(other,['screen.view','screen.desktop-trust'],false);expect(f.requestRecovery(other).kind).toBe('owner-recovery');}
 const excess=safetyPerson('Fifth');f.enroll(excess,['screen.view','screen.desktop-trust'],false);expect(f.requestRecovery(excess).value.code).toBe('OWNER_QUEUE_FULL');
 f.advance(301_000);expect(f.call('owner-recovery-status',[f.cid,first.value.requestId],f.host).value.state).toBe('expired');expect(f.requestRecovery(excess).kind).toBe('owner-recovery');
});
test('a mutation ID retains its original result for seven days rather than being reused after ten minutes',()=>{
 const f=fixture();f.enable();const raw=f.request('owner-recovery-request',[f.cid,f.host.enrollment],f.root,'op'),first=f.run(raw);
 const fields=JSON.parse(Buffer.from(raw.payload,'base64url').toString());f.advance(601_000);
 expect(f.call('receipt',[fields[2]],f.root,'host').value.result).toEqual(first.envelope);
 fields[3]=f.now();fields[4]=randomBytes(32).toString('base64url');const bytes=Buffer.from(JSON.stringify(fields));
 const reused={payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([ACCESS_REQUEST_DOMAIN,bytes]),{key:f.root.op.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
 expect(f.run(reused).value.code).toBe('REQUEST_CONFLICT');
 // Even an interrupted/corrupt missing generic receipt cannot overwrite the retained original record.
 f.store.remove('access-receipt:'+fields[2]);expect(f.run(reused).value.code).toBe('OWNER_REQUEST_ID_REUSED');
 expect(f.call('owner-recovery-status',[f.cid,fields[2]],f.host).value.requestId).toBe(first.value.requestId);
 expect(f.store.get<string[]>('owner-recovery-index:'+f.cid)).toEqual([first.value.requestId]);
});
test('only a signed original whose complete acceptance window closed can prove absence and release its exact fence',()=>{
 const f=fixture();f.enable();const raw=f.request('owner-recovery-request',[f.cid,f.host.enrollment],f.root,'op');
 const fields=JSON.parse(Buffer.from(raw.payload,'base64url').toString()),lookup=()=>f.call('owner-recovery-status',[f.cid,fields[2],raw],f.root,'op');
 expect(lookup().value.code).toBe('OWNER_REQUEST_STILL_POSSIBLE');f.advance(61_000);
 const absent=lookup();expect(absent.kind).toBe('owner-recovery-absent');expect(absent.value).toMatchObject({requestId:fields[2],sourceEnrollmentId:f.root.enrollment,targetEnrollmentId:f.host.enrollment,originalIssuedAt:fields[3],originalRequestHash:createHash('sha256').update(JSON.stringify([raw.payload,raw.signature])).digest('hex')});
 expect(f.run(raw).value.code).toBe('INVALID_REQUEST');
 expect(f.call('owner-recovery-status',[f.cid,randomUUID(),raw],f.root,'op').value.code).toBe('OWNER_ORIGINAL_MISMATCH');
});
test('receipt saturation rolls back a positive mutation but preserves the separate negative OFF reserve',()=>{
 const f=fixture();f.enable();const key='owner-mutation-receipts:'+f.cid+':positive';
 f.store.put(key,Array.from({length:1024},()=>({id:randomUUID(),expiresAt:f.now()+86_400_000})));
 expect(f.requestRecovery().value.code).toBe('OWNER_MUTATION_RECEIPTS_FULL');expect(f.store.get('owner-recovery-index:'+f.cid)).toBeUndefined();
 expect(f.enable(f.host,false,1).value).toMatchObject({enabled:false,revision:2});
});
test('one explicit enrollment-plan approval bootstraps delegation without promoting a global admin or reopening an explicit OFF',()=>{
 const f=fixture(),caps=f.authorization(f.host).capabilities;
 f.enroll(f.host,[...caps,'screen.owner-delegation'],false);
 const poll=f.call('owner-recovery-poll',[f.cid],f.host),policy=verifyAccessEnvelope(poll.value.delegation,f.issuerPublic)[4] as any;
 expect(policy).toMatchObject({enabled:true,revision:f.authorization(f.host).revision});
 expect(f.store.get<{admin:boolean}>('member:'+f.host.enrollment)!.admin).toBe(false);
 expect(f.enable(f.host,false,policy.revision).value.enabled).toBe(false);
 // A fresh grant/renewal cannot override the separately persisted negative selection.
 f.enroll(f.host,[...caps,'screen.owner-delegation'],false);
 expect((verifyAccessEnvelope(f.call('owner-recovery-poll',[f.cid],f.host).value.delegation,f.issuerPublic)[4] as any).enabled).toBe(false);
});

test('a target host can make OFF sticky after receiving permissions are removed and before they are regranted',()=>{
 const f=fixture(),caps=[...f.authorization(f.host).capabilities,'screen.owner-delegation'] as const;
 f.advance(61_000); // Leave enrollment setup's real prepare budget intact.
 f.enroll(f.host,[...caps],false);
 expect(f.requestRecovery().kind).toBe('owner-recovery');
 const bootstrap=verifyAccessEnvelope(f.call('owner-recovery-poll',[f.cid],f.host).value.delegation,f.issuerPublic)[4] as {revision:number};
 expect(bootstrap.revision).toBeGreaterThan(0);
 f.enroll(f.host,['screen.view'],false);
 const poll=f.call('owner-recovery-poll',[f.cid],f.host);
 expect(poll.kind).toBe('owner-recovery-round');expect(poll.value.requests).toEqual([]);
 const prior=verifyAccessEnvelope(poll.value.delegation,f.issuerPublic)[4] as {enabled:boolean;revision:number};
 expect(prior).toMatchObject({enabled:false,revision:bootstrap.revision});
 expect(f.enable(f.host,false,prior.revision).value).toMatchObject({enabled:false,revision:bootstrap.revision+1});
 expect(f.enable(f.host,true,bootstrap.revision+1).value.code).toBe('OWNER_DESKTOP_REQUIRED');
 f.enroll(f.host,[...caps],false);
 expect(verifyAccessEnvelope(f.call('owner-recovery-poll',[f.cid],f.host).value.delegation,f.issuerPublic)[4]).toMatchObject({enabled:false,revision:bootstrap.revision+1});
 expect(f.requestRecovery().value.code).toBe('OWNER_DELEGATION_DISABLED');
});
test('owner-delegation capability is desktop-only and requires the explicit trusted receiving permissions',()=>{
 const f=fixture();
 for(const capabilities of [['screen.owner-delegation'],['screen.view','screen.desktop-trust','screen.owner-delegation']]){
  const original=f.store.get<{plan:any}>('access-policy:'+f.host.enrollment)!.plan;
  expect(f.call('prepare',[{...original,capabilities}],f.host,'host',null).value.code).toBe('OWNER_DELEGATION_REQUIRES_TRUSTED_RECEIVER');
 }
 const mobile=f.store.get<{plan:any}>('access-policy:'+f.mobile.enrollment)!.plan;
 expect(f.call('prepare',[{...mobile,capabilities:['screen.view','screen.owner-delegation']}],f.mobile,'host',null).value.code).toBe('MOBILE_CANNOT_DELEGATE_OWNER');
});
