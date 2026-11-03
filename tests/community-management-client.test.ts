import {describe,test,expect} from 'bun:test';
import {createECDH,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import golden from '../native/screen-control/Tests/Fixtures/community-access-management-v1.json';
import {CommunityAccessReply,communityRequestBytes,communityBytes} from '../src/communityAccessClient';
import {CommunityManagementReview,communityManagementBytes,communityEnrollmentNoticeRoute,verifyCommunityAccessNotice} from '../src/communityManagementClient';
import {accessManagementDigest,type AccessManagementIntent} from '../cloud/screen-community/src/accessManagement';
import {ACCESS_RESPONSE_DOMAIN,ACCESS_NOTICE_DOMAIN,type AccessPlan} from '../cloud/screen-community/src/accessProtocol';
function software(n:number){const d=Buffer.alloc(32);d[31]=n;const ec=createECDH('prime256v1');ec.setPrivateKey(d);const p=ec.getPublicKey();return createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:p.subarray(1,33).toString('base64url'),y:p.subarray(33).toString('base64url'),d:d.toString('base64url')}});}
const issuer=software(7),now=golden.at;
function response(body:any,kind='management-review',key=issuer,at=now){const fields=JSON.parse(Buffer.from(golden.reviewEnvelope.payload,'base64url').toString());fields[1]=kind;fields[3]=at;fields[4]=body;const bytes=Buffer.from(JSON.stringify(fields));return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([ACCESS_RESPONSE_DOMAIN,bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')};}
async function read(envelope=golden.reviewEnvelope,a=golden.authority){const id=JSON.parse(Buffer.from(envelope.payload,'base64url').toString())[2];return CommunityAccessReply.verify(envelope,a.issuerPublicKey,id,now);}
describe('pinned SDK management and notice contract',()=>{
 test('Worker, SDK and Swift consume the exact same management transcript and BIO request bytes',async()=>{
  const r=await CommunityManagementReview.fromReply(await read(),golden.authority,golden.actor,now);
  expect(CommunityManagementReview.isVerified(r)).toBe(true);expect(Buffer.from(communityManagementBytes(r.body)).toString('base64url')).toBe(golden.managementBytes);
  expect(accessManagementDigest(golden.review,golden.review.plan as AccessPlan,golden.review.management as AccessManagementIntent)).toBe(golden.managementDigest);
  const fields=JSON.parse(Buffer.from(golden.approvalRequestBytes,'base64url').toString());expect(r.approvalArguments()).toEqual(fields[6]);
  expect(Buffer.from(communityRequestBytes({operation:'approve-management',requestId:fields[2],observedAt:fields[3],nonce:fields[4],actor:fields[5],args:fields[6]})).toString('base64url')).toBe(golden.approvalRequestBytes);
  expect(verify('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'),Buffer.from(golden.approvalRequestBytes,'base64url')]),{key:createPublicKey(software(5)),dsaEncoding:'ieee-p1363'},Buffer.from(golden.approvalRequestEnvelope.signature,'base64url'))).toBe(true);
  expect(()=>communityRequestBytes({operation:'approve',requestId:fields[2],observedAt:fields[3],nonce:fields[4],actor:fields[5],args:fields[6]})).toThrow();
 });
 test('prototype or constructor forgery cannot produce an approval intent',async()=>{
  const forged=Object.create(CommunityAccessReply.prototype);expect(CommunityAccessReply.isVerified(forged)).toBe(false);
  await expect(CommunityManagementReview.fromReply(forged,golden.authority,golden.actor,now)).rejects.toThrow();
  expect(()=>Reflect.construct(CommunityManagementReview,[Symbol(),golden.review,golden.reviewEnvelope])).toThrow();
  const fake=Object.assign(Object.create(CommunityManagementReview.prototype),{body:golden.review});expect(CommunityManagementReview.isVerified(fake)).toBe(false);expect(()=>fake.approvalArguments()).toThrow();
 });
 test('the sealed issuer is rechecked even if another issuer created a genuine verified response',async()=>{
  const other=software(8),pub=other.export({format:'jwk'});const point=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x!,'base64url'),Buffer.from(pub.y!,'base64url')]).toString('base64url');
  const e=response(golden.review,'management-review',other),r=await read(e,{...golden.authority,issuerPublicKey:point});
  await expect(CommunityManagementReview.fromReply(r,golden.authority,golden.actor,now)).rejects.toThrow();
 });
 test('digest tampering, wrong roles/context, stale replies and malformed fields never become approvable',async()=>{
  const mutations=[(v:any)=>v.management.administrator=false,(v:any)=>v.management.targetKeyEpoch++,(v:any)=>v.management.nonce='AA',(v:any)=>v.management.previousAdministrator=0,(v:any)=>v.plan.operationKey=v.plan.hostKey,(v:any)=>v.plan.capabilities.reverse(),(v:any)=>v.plan.controlKey=v.plan.hostKey,(v:any)=>v.management.communityId=crypto.randomUUID(),(v:any)=>v.management.targetEnrollmentId=golden.actor.enrollmentId,(v:any)=>v.management.extra=true,(v:any)=>v.expiresAt=now-1];
  for(const mutate of mutations){const v=structuredClone(golden.review);mutate(v);await expect(CommunityManagementReview.fromReply(await read(response(v)),golden.authority,golden.actor,now)).rejects.toThrow();}
  await expect(CommunityManagementReview.fromReply(await read(),{...golden.authority,origin:golden.authority.origin+'/'},golden.actor,now)).rejects.toThrow();
  await expect(CommunityManagementReview.fromReply(await read(),golden.authority,{...golden.actor,deviceId:golden.review.plan.deviceId},now)).rejects.toThrow();
  await expect(CommunityManagementReview.fromReply(await read(),golden.authority,golden.actor,now+120_001)).rejects.toThrow();
  await expect(CommunityManagementReview.fromReply(await read(response(golden.review,'review')),golden.authority,golden.actor,now)).rejects.toThrow();
 });
 test('the separate notice domain is advisory and cannot downgrade into legacy routing',async()=>{
  expect(communityEnrollmentNoticeRoute(golden.noticeEnvelope)).toBe('access');const n=await verifyCommunityAccessNotice(golden.noticeEnvelope,golden.authority,golden.actor.communityId,now);
  expect(n.planId).toBe(golden.review.planId);expect(n.digest).toBe(golden.review.digest);expect(Object.keys(n)).toEqual(['planId','issuedAt','communityId','profileId','digest','expiresAt']);
  const bytes=Buffer.from(golden.noticeEnvelope.payload,'base64url');expect(verify('sha256',Buffer.concat([ACCESS_NOTICE_DOMAIN,bytes]),{key:createPublicKey(issuer),dsaEncoding:'ieee-p1363'},Buffer.from(golden.noticeEnvelope.signature,'base64url'))).toBe(true);
  await expect(verifyCommunityAccessNotice(golden.noticeEnvelope,golden.authority,crypto.randomUUID(),now)).rejects.toThrow();
  await expect(verifyCommunityAccessNotice(golden.noticeEnvelope,golden.authority,golden.actor.communityId,now+600_001)).rejects.toThrow();
  for(const signature of [golden.reviewEnvelope.signature,'AA'])await expect(verifyCommunityAccessNotice({...golden.noticeEnvelope,signature},golden.authority,golden.actor.communityId,now)).rejects.toThrow();
  const fields=JSON.parse(bytes.toString());fields[1]='enrollment-notice';expect(()=>communityEnrollmentNoticeRoute({...golden.noticeEnvelope,payload:Buffer.from(JSON.stringify(fields)).toString('base64url')})).toThrow();
  expect(communityBytes(golden.noticeEnvelope.payload,1024).length).toBeLessThan(1024);
 });
});
