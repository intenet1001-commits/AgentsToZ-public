import {test,expect} from 'bun:test';
import {randomUUID,createHash} from 'node:crypto';
import {CAPABILITIES,accessSigned,accessPlan,accessPlanBytes,verifyAccessEnvelope,type AccessPlan,type AccessAuthorization} from '../cloud/screen-community/src/accessProtocol';
import {keyString} from '../cloud/screen-community/src/protocol';
import {safetyPolicyDigest} from '../cloud/screen-community/src/screenSafety';
import {CommunityAccessReply} from '../src/communityAccessClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession,COMMUNITY_MOBILE_CAPABILITY_ORDER} from '../src/communityMobilePrincipal';
import {CommunityComponentAuthorization} from '../src/communityComponentIdentity';
import {CommunitySafetyRound,communitySafetyPolicyDigest} from '../src/communityScreenSafetyClient';
import {screenSafetyFixture,safetyKey,type SafetyPerson} from './fixtures/community-screen-safety';
import golden from '../native/screen-control/Tests/Fixtures/community-access-v2.json';
import desktopGolden from '../native/screen-control/Tests/Fixtures/community-desktop-trust-v1.json';

type Fixture=ReturnType<typeof screenSafetyFixture>;
const trust='screen.desktop-trust' as const;
const oldCaps:AccessPlan['capabilities']=['screen.view','screen.control','screen.receive.view','screen.receive.control','agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'];
const oldPlan=(f:Fixture):AccessPlan=>structuredClone(f.store.get<{plan:AccessPlan}>('access-policy:'+f.host.enrollment)!.plan);
function stage(f:Fixture,plan:AccessPlan,who:SafetyPerson=f.host){
 const prepared=f.call('prepare',[plan],who,'host',null);expect(prepared.kind).toBe('prepared');
 const review=f.call('review',[f.cid,prepared.value.planId]);expect(review.kind).toBe('review');return {prepared,review};
}
function approval(f:Fixture,s:ReturnType<typeof stage>){const r=s.review.value;return f.request('approve',[f.cid,r.planId,r.digest,r.challenge,r.revision],f.root,'bio');}
async function signed(f:Fixture,kind:string,body:unknown){const id=randomUUID(),envelope=accessSigned(kind,id,f.now(),body,f.issuer.privateKey);return CommunityAccessReply.verify(envelope,f.issuerPublic,id,f.now());}
const authority=(f:Fixture)=>({origin:'https://desktop-trust-fixture.workers.dev',profileId:f.profile,issuerPublicKey:f.issuerPublic});

test('the ninth explicit desktop capability preserves all eight prior capabilities and original Plan11 golden bytes',()=>{
 expect(CAPABILITIES.slice(0,8)).toEqual(oldCaps);expect(CAPABILITIES[8]).toBe(trust);expect(COMMUNITY_MOBILE_CAPABILITY_ORDER).toEqual(CAPABILITIES);
 expect(createHash('sha256').update(accessPlanBytes(golden.plan as AccessPlan)).digest('hex')).toBe(golden.digest);
 const f=screenSafetyFixture();expect(f.authorization(f.host).capabilities).not.toContain(trust);
 expect(Object.keys(f.authorization(f.host))).toHaveLength(17);expect(Object.keys(oldPlan(f))).toHaveLength(11);
});
test('mobile Plans and use episodes reject desktop trust and desktop standalone trust is not a screen grant',()=>{
 const f=screenSafetyFixture(),mobile=f.store.get<{plan:AccessPlan}>('access-policy:'+f.mobile.enrollment)!.plan;
 expect(f.call('prepare',[{...mobile,capabilities:['screen.view',trust]}],f.mobile,'host',null).value.code).toBe('MOBILE_CANNOT_TRUST_DESKTOP');
 expect(f.call('prepare',[{...oldPlan(f),capabilities:[trust]}],f.host,'host',null).value.code).toBe('DESKTOP_TRUST_REQUIRES_SCREEN');
 expect(f.call('session-open',[f.cid,keyString(f.mobile.ram.publicKey),['screen.view',trust]],f.mobile,'bio').value.code).toBe('MOBILE_CANNOT_TRUST_DESKTOP');
});
test('pending, rejected, unknown and expired updates preserve accepted enrollment, policy and every key until exact approval',()=>{
 const f=screenSafetyFixture(),before=f.authorization(f.host),plan=oldPlan(f),saved=f.store.get<Record<string,unknown>>('access-policy:'+f.host.enrollment),s=stage(f,{...plan,capabilities:[...plan.capabilities,trust]});
 expect(f.store.get<Record<string,unknown>>('access-policy:'+f.host.enrollment)).toEqual(saved);
 const r=s.review.value;expect(f.call('approve',[f.cid,r.planId,r.digest,r.challenge,r.revision],f.root,'host').value.code).toBe('INVALID_PROOF');
 expect(f.authorization(f.host).revision).toBe(before.revision);expect(f.authorization(f.host).capabilities).not.toContain(trust);
 f.advance(601_000);expect(f.run(approval(f,s)).value.code).toBe('REQUEST_EXPIRED');expect(f.store.get<Record<string,unknown>>('access-policy:'+f.host.enrollment)).toEqual(saved);
 const retry=stage(f,{...plan,capabilities:[...plan.capabilities,trust]}),request=approval(f,retry),result=f.run(request),id=JSON.parse(Buffer.from(request.payload,'base64url').toString())[2];
 expect(result.kind).toBe('authorization');expect(result.value.enrollmentId).toBe(before.enrollmentId);expect(result.value.keyEpoch).toBe(before.keyEpoch);expect(result.value.revision).toBeGreaterThan(before.revision);
 for(const field of ['hostPublicKey','publicKey','biometricPublicKey','controlKey'])expect(result.value[field]).toBe(before[field]);
 expect(f.store.get<{admin:boolean}>('member:'+f.host.enrollment)!.admin).toBe(false);
 // A lost approval response is recovered under its original ID, not by another approval or enrollment.
 const recovered=f.call('receipt',[id],f.root,'host');expect(recovered.value.result).toEqual(result.envelope);expect(f.run(request).envelope).toEqual(result.envelope);
});
test('a trust upgrade cannot rotate host, biometric, operation or an existing Control key',()=>{
 for(const field of ['hostKey','biometricKey','operationKey'] as const){
  const f=screenSafetyFixture(),plan=oldPlan(f),replacement=safetyKey(),before=f.authorization(f.host),who=field==='hostKey'?{...f.host,host:replacement}:f.host;
  const s=stage(f,{...plan,[field]:keyString(replacement.publicKey),capabilities:[...plan.capabilities,trust]},who),rejected=f.run(approval(f,s));
  expect(rejected.value.code).toBe(field==='operationKey'?'DESKTOP_TRUST_KEYS_IMMUTABLE':'IDENTITY_CHANGED');expect(f.authorization(f.host)).toEqual(before);
 }
 const f=screenSafetyFixture(),control=safetyKey(),initial=stage(f,{...oldPlan(f),controlKey:keyString(control.publicKey)});expect(f.run(approval(f,initial)).kind).toBe('authorization');
 const plan=oldPlan(f),before=f.authorization(f.host),s=stage(f,{...plan,controlKey:keyString(safetyKey().publicKey),capabilities:[...plan.capabilities,trust]});
 expect(f.run(approval(f,s)).value.code).toBe('DESKTOP_TRUST_KEYS_IMMUTABLE');expect(f.authorization(f.host)).toEqual(before);
});
test('a null Control slot stays unchanged for trust-only or Agent/Teams-only and may be filled with a selected Computer Use feature',()=>{
 for(const capability of [null,'agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'] as const){
  const f=screenSafetyFixture(),plan=oldPlan(f),control=safetyKey(),combined=capability?.startsWith('computer-use.')===true;
  const s=stage(f,{...plan,controlKey:keyString(control.publicKey),agentDeviceId:capability==='agent.communicate'||capability==='teams.run'?randomUUID():null,capabilities:[...plan.capabilities,...(capability?[capability]:[]),trust]});
  const result=f.run(approval(f,s));
  if(!combined){expect(result.value.code).toBe('DESKTOP_TRUST_KEYS_IMMUTABLE');expect(f.authorization(f.host).controlKey).toBeNull();}
  else {expect(result.kind).toBe('authorization');expect(result.value.controlKey).toBe(keyString(control.publicKey));expect(result.value.publicKey).toBe(plan.operationKey);
   const proofOwner={...f.host,op:control};expect(f.call('component-ticket',[f.cid,capability==='computer-use.browser'?'browser':'agent-settings',randomUUID(),'host'],proofOwner,'op').kind).toBe('ticket');}
 }
});
test('capability removal and stale reviewed policy never silently retain desktop trust or admit an old ticket',()=>{
 const f=screenSafetyFixture(),plan=oldPlan(f),s=stage(f,{...plan,capabilities:[...plan.capabilities,trust]});f.run(approval(f,s));
 const old=f.call('receiver-ticket',[f.cid,randomUUID()],f.host),remove=stage(f,plan);expect(f.run(approval(f,remove)).kind).toBe('authorization');
 expect(f.authorization(f.host).capabilities).not.toContain(trust);expect(()=>f.service().admitTicket(old.envelope)).toThrow('STALE_AUTHORIZATION');
 expect(f.run(approval(f,s)).value.code).toBe('REQUEST_EXPIRED');
});
test('closed unknown prepares recover absence for the exact pending trust update without returning or deleting the old accepted policy',()=>{
 for(const combined of [false,true]){
  const f=screenSafetyFixture(),before=f.store.get<Record<string,unknown>>('access-policy:'+f.host.enrollment),plan=oldPlan(f);
  const next:AccessPlan={...plan,controlKey:combined?keyString(safetyKey().publicKey):plan.controlKey,agentDeviceId:combined?randomUUID():plan.agentDeviceId,capabilities:[...plan.capabilities,...(combined?['computer-use.browser' as const]:[]),trust]};
  const original=f.request('prepare',[next],f.host,'host',null),lookup=()=>f.call('recover-registration',[next,original],f.host,'host',null);
  expect(lookup().value.code).toBe('REQUEST_STILL_POSSIBLE');f.advance(61_000);
  const absent=lookup();expect(absent.kind).toBe('registration-absent');expect(absent.value.originalRequestId).toBe(JSON.parse(Buffer.from(original.payload,'base64url').toString())[2]);
  expect(f.store.get<Record<string,unknown>>('access-policy:'+f.host.enrollment)).toEqual(before);expect(f.authorization(f.host).capabilities).not.toContain(trust);
  expect(f.run(original).value.code).toBe('INVALID_REQUEST');
  const malformed={...next,operationKey:keyString(safetyKey().publicKey)},bad=f.request('prepare',[malformed],f.host,'host',null);f.advance(61_000);
  expect(f.call('recover-registration',[malformed,bad],f.host,'host',null).value.code).toBe('POLICY_CHANGED');
 }
});
test('strict TS readers accept a trusted desktop certificate without projecting trust into Control or mobile authority',async()=>{
 const f=screenSafetyFixture(),base=f.authorization(f.host),control=safetyKey(),body={...base,controlKey:keyString(control.publicKey),agentDeviceId:randomUUID(),capabilities:['screen.receive.view','agent.communicate',trust]};
 const reply=await signed(f,'authorization',body),a=authority(f),expected={communityId:f.cid,deviceId:f.host.device,deviceKind:'desktop' as const};
 const desktop=await CommunityDeviceAuthorization.fromReply(reply,a,expected,f.now()),component=await CommunityComponentAuthorization.fromReply(reply,f.profile,f.host.device,f.now());
 expect(desktop.body.capabilities).toContain(trust);expect(component.body.capabilities).toContain(trust);expect(component.permits('agent',f.now())).toBe(true);expect(component.permits('teams',f.now())).toBe(false);expect(desktop.permits('mobile-browser',f.now())).toBe(false);
 await expect(CommunityDeviceAuthorization.fromReply(reply,a,expected,f.now()+90_001)).rejects.toThrow();
 const mobile=f.authorization(f.mobile),mobileExpected={communityId:f.cid,deviceId:f.mobile.device,deviceKind:'mobile' as const};
 await expect(CommunityDeviceAuthorization.fromReply(await signed(f,'authorization',{...mobile,capabilities:[...mobile.capabilities,trust]}),a,mobileExpected,f.now())).rejects.toThrow('INVALID_CAPABILITIES');
 const mobileAuth=await CommunityDeviceAuthorization.fromReply(await signed(f,'authorization',mobile),a,mobileExpected,f.now()),use=f.openUse().value;
 await expect(CommunityMobileUseSession.fromReply(await signed(f,'session',{...use,capabilities:[...use.capabilities,trust]}),mobileAuth,{sessionId:use.sessionId},f.now())).rejects.toThrow('INVALID_CAPABILITIES');
});
test('the pinned safety reader recognizes a screen-only trusted desktop without inventing a component key or a ready watcher',async()=>{
 const f=screenSafetyFixture(),plan=oldPlan(f),s=stage(f,{...plan,capabilities:[...plan.capabilities,trust]});f.run(approval(f,s));
 const request=f.pollRequest(),raw=f.run(request),fields=JSON.parse(Buffer.from(request.payload,'base64url').toString()),auth=f.authorization(f.host),reply=await CommunityAccessReply.verify(raw.envelope,f.issuerPublic,fields[2],f.now());
 const round=await CommunitySafetyRound.fromReply(reply,authority(f),{communityId:f.cid,profileId:f.profile,enrollmentId:f.host.enrollment!,deviceId:f.host.device,hostPublicKey:auth.hostPublicKey,keyEpoch:auth.keyEpoch,revision:auth.revision,policyDigest:communitySafetyPolicyDigest(auth)},{requestId:fields[2],nonce:fields[4],activationId:f.activation},f.now());
 expect(round.body.receiver.capabilities).toContain(trust);expect(round.body.receiver.controlKey).toBeNull();expect(round.body.watchers).toEqual([]);
});
test('the unchanged Swift desktop-trust direct and directory signatures agree with strict CF/SDK readers without becoming Control authority',async()=>{
 expect(desktopGolden.softwareOnly).toBe(true);
 const bodies=[desktopGolden.controller,desktopGolden.receiver] as AccessAuthorization[];
 for(const [envelope,body] of [[desktopGolden.controllerEnvelope,bodies[0]!],[desktopGolden.receiverEnvelope,bodies[1]!]] as const){
  const fields=verifyAccessEnvelope(envelope,desktopGolden.authority.issuerPublicKey),reply=await CommunityAccessReply.verify(envelope,desktopGolden.authority.issuerPublicKey,fields[2] as string,desktopGolden.at);
  expect(reply.kind).toBe('authorization');expect(reply.payload as AccessAuthorization).toEqual(body);expect(fields[4] as AccessAuthorization).toEqual(body);expect(Object.keys(body)).toHaveLength(17);
  const plan=accessPlan({version:1,profileId:body.profileId,deviceId:body.deviceId,name:body.name,kind:body.deviceKind,hostKey:body.hostPublicKey,biometricKey:body.biometricPublicKey,operationKey:body.publicKey,controlKey:body.controlKey,agentDeviceId:body.agentDeviceId,capabilities:body.capabilities});
  expect(Object.keys(plan)).toHaveLength(11);expect(plan.capabilities).toEqual(body.capabilities);expect(plan.capabilities.at(-1)).toBe(trust);
  expect(communitySafetyPolicyDigest(body)).toBe(safetyPolicyDigest(body));expect(plan.controlKey).toBeNull();
  // These are Screen-only credentials. Recognizing the new cap must not manufacture a Control component key.
  await expect(CommunityDeviceAuthorization.fromReply(reply,desktopGolden.authority,{communityId:body.communityId,deviceId:body.deviceId,deviceKind:'desktop'},desktopGolden.at)).rejects.toThrow('WRONG_PRINCIPAL');
  await expect(CommunityComponentAuthorization.fromReply(reply,body.profileId,body.deviceId,desktopGolden.at)).rejects.toThrow('invalid component authorization');
 }
 const fields=verifyAccessEnvelope(desktopGolden.directoryEnvelope,desktopGolden.authority.issuerPublicKey),reply=await CommunityAccessReply.verify(desktopGolden.directoryEnvelope,desktopGolden.authority.issuerPublicKey,fields[2] as string,desktopGolden.at);
 expect(reply.kind).toBe('directory');expect(reply.payload as AccessAuthorization[]).toEqual(bodies);
 const original=JSON.parse(Buffer.from(desktopGolden.controllerEnvelope.payload,'base64url').toString());original[4].capabilities=original[4].capabilities.filter((cap:string)=>cap!==trust);
 const downgraded={...desktopGolden.controllerEnvelope,payload:Buffer.from(JSON.stringify(original)).toString('base64url')};
 expect(()=>verifyAccessEnvelope(downgraded,desktopGolden.authority.issuerPublicKey)).toThrow('INVALID_ISSUER');
 await expect(CommunityAccessReply.verify(downgraded,desktopGolden.authority.issuerPublicKey,original[2],desktopGolden.at)).rejects.toThrow('INVALID_ISSUER');
});
