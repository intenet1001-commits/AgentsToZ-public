import {test,expect} from 'bun:test';
import {createECDH,createPrivateKey,createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {CommunityAccessReply,type CommunityAccessEnvelope} from '../src/communityAccessClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession,verifyCommunityMobileAccessEnvelope,
  type CommunityDeviceAuthorizationExpectation} from '../src/communityMobilePrincipal';
import golden from '../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json';

const clone=<T>(value:T):T=>structuredClone(value);
const authority=golden.authority,now=golden.now;
function softwareKey(scalar:number){
  const raw=Buffer.alloc(32);raw.writeUInt32BE(scalar,28);const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(raw);const point=ecdh.getPublicKey();
  return {publicKey:point.toString('base64url'),privateKey:createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',d:raw.toString('base64url'),x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')}})};
}
const issuer=softwareKey(golden.softwareKeyScalars.issuer);
function envelope(kind:string,payload:unknown,issuedAt=now,key=issuer.privateKey,id=randomUUID()):CommunityAccessEnvelope{
  const bytes=Buffer.from(JSON.stringify([2,kind,id,issuedAt,payload]));return {payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
async function reply(kind:string,payload:unknown,at=now){
  const wrapped=envelope(kind,payload,at),id=JSON.parse(Buffer.from(wrapped.payload,'base64url').toString())[2];return CommunityAccessReply.verify(wrapped,authority.issuerPublicKey,id,at);
}
const mobileExpected=(changes:Partial<CommunityDeviceAuthorizationExpectation>={}):CommunityDeviceAuthorizationExpectation=>({communityId:golden.mobileAuthorization.communityId,deviceId:golden.mobileAuthorization.deviceId,deviceKind:'mobile',...changes});
const receiverExpected=(changes:Partial<CommunityDeviceAuthorizationExpectation>={}):CommunityDeviceAuthorizationExpectation=>({communityId:golden.receiverAuthorization.communityId,deviceId:golden.receiverAuthorization.deviceId,deviceKind:'desktop',...changes});
const mobile=async(body:unknown=golden.mobileAuthorization,at=now,expected=mobileExpected(),configured=authority)=>CommunityDeviceAuthorization.fromReply(await reply('authorization',body,at),configured,expected,at);

test('Swift golden issuer envelopes produce the same mobile, receiver and use policy hashes',async()=>{
  const auth=await CommunityDeviceAuthorization.fromEnvelope(golden.envelopes.mobile,authority,mobileExpected({purpose:'mobile-agent'}),now);
  const receiver=await CommunityDeviceAuthorization.fromEnvelope(golden.envelopes.receiver,authority,receiverExpected({purpose:'mobile-agent'}),now);
  const use=await CommunityMobileUseSession.fromEnvelope(golden.envelopes.use,auth,{sessionId:golden.useSession.sessionId,purpose:'mobile-agent'},now);
  expect(auth.body as unknown).toEqual(golden.mobileAuthorization);expect(receiver.body as unknown).toEqual(golden.receiverAuthorization);expect(use.body as unknown).toEqual(golden.useSession);
  expect(auth.policyDigest).toBe(golden.transcript.senderPolicyDigest);expect(receiver.policyDigest).toBe(golden.transcript.receiverPolicyDigest);expect(use.policyDigest).toBe(golden.transcript.senderUsePolicyDigest);
  expect(auth.receiptOwnerHash).toBe(createHash('sha256').update('agentstoz.community-mobile-control/receipt-owner/v2\0'+JSON.stringify([auth.body.profileId,auth.body.communityId,auth.body.enrollmentId,auth.body.deviceId,auth.body.keyEpoch,auth.body.publicKey])).digest('hex'));
  for(const purpose of ['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'] as const){expect(auth.permits(purpose,now)).toBe(true);expect(receiver.permits(purpose,now)).toBe(true);expect(use.permits(purpose,now)).toBe(true);}
  expect(Object.isFrozen(auth)).toBe(true);expect(Object.isFrozen(auth.body)).toBe(true);expect(Object.isFrozen(use.body.capabilities)).toBe(true);
  expect(auth.isCurrent(now+90_000)).toBe(false);expect(use.isCurrent(now+90_000)).toBe(false);
});

test('stable policy excludes renewable timestamps while receipt ownership survives a fresh mobile RAM episode',async()=>{
  const original=await mobile(),first=await CommunityMobileUseSession.fromReply(await reply('session',golden.useSession),original,{sessionId:golden.useSession.sessionId},now);
  const at=now+40_000,authBody={...golden.mobileAuthorization,issuedAt:at,expiresAt:at+90_000},renewed=await mobile(authBody,at);
  const renewedBody={...golden.useSession,sequence:9,lastHumanAt:now+30_000,idleExpiresAt:now+3_630_000,issuedAt:at,expiresAt:at+90_000};
  const next=await CommunityMobileUseSession.fromReply(await reply('session',renewedBody,at),renewed,{sessionId:renewedBody.sessionId},at);
  expect(renewed.policyDigest).toBe(original.policyDigest);expect(next.policyDigest).toBe(first.policyDigest);expect(next.receiptOwnerHash).toBe(first.receiptOwnerHash);
  const episode={...renewedBody,sessionId:randomUUID(),publicKey:softwareKey(21).publicKey};
  const fresh=await CommunityMobileUseSession.fromReply(await reply('session',episode,at),renewed,{sessionId:episode.sessionId},at);
  expect(fresh.policyDigest).not.toBe(first.policyDigest);expect(fresh.receiptOwnerHash).toBe(first.receiptOwnerHash);
  const narrowed=await mobile({...authBody,capabilities:['agent.communicate'],revision:2},at);
  expect(narrowed.receiptOwnerHash).toBe(original.receiptOwnerHash);expect(narrowed.permits('mobile-teams',at)).toBe(false);
  expect((await mobile({...authBody,keyEpoch:2},at)).receiptOwnerHash).not.toBe(original.receiptOwnerHash);
  expect((await mobile({...authBody,publicKey:softwareKey(22).publicKey},at)).receiptOwnerHash).not.toBe(original.receiptOwnerHash);
});

test('a reply branded under another issuer cannot be promoted into the sealed authority',async()=>{
  const forgedIssuer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=forgedIssuer.publicKey.export({format:'jwk'});
  const publicPoint=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64url');
  const wrapped=envelope('authorization',golden.mobileAuthorization,now,forgedIssuer.privateKey),id=JSON.parse(Buffer.from(wrapped.payload,'base64url').toString())[2];
  const branded=await CommunityAccessReply.verify(wrapped,publicPoint,id,now);expect(CommunityAccessReply.isVerified(branded)).toBe(true);
  await expect(CommunityDeviceAuthorization.fromReply(branded,authority,mobileExpected(),now)).rejects.toThrow('INVALID_ISSUER');
  await expect(CommunityDeviceAuthorization.fromEnvelope(wrapped,authority,mobileExpected(),now)).rejects.toThrow('INVALID_ISSUER');
});

test('prototype objects and runtime constructor calls cannot fabricate verified principals',async()=>{
  const legitimate=await mobile(),authForgery=Object.assign(Object.create(CommunityDeviceAuthorization.prototype),{body:legitimate.body,authority,policyDigest:legitimate.policyDigest});
  expect(CommunityDeviceAuthorization.isVerified(authForgery)).toBe(false);expect(authForgery.isCurrent(now)).toBe(false);expect(authForgery.permits('mobile-agent',now)).toBe(false);
  const forgedReply=Object.assign(Object.create(CommunityAccessReply.prototype),{kind:'authorization',requestId:randomUUID(),issuedAt:now,payload:golden.mobileAuthorization,envelope:golden.envelopes.mobile});
  await expect(CommunityDeviceAuthorization.fromReply(forgedReply,authority,mobileExpected(),now)).rejects.toThrow('UNVERIFIED_REPLY');
  await expect(CommunityMobileUseSession.fromReply(await reply('session',golden.useSession),authForgery,{sessionId:golden.useSession.sessionId},now)).rejects.toThrow('UNVERIFIED_PRINCIPAL');
  expect(()=>Reflect.construct(CommunityDeviceAuthorization,[Symbol('issuer-verified-mobile-principal'),golden.mobileAuthorization,golden.envelopes.mobile,authority])).toThrow('UNVERIFIED_PRINCIPAL');
  expect(()=>Reflect.construct(CommunityMobileUseSession,[undefined,golden.useSession,golden.envelopes.use,legitimate])).toThrow('UNVERIFIED_PRINCIPAL');
  const forgedUse=Object.create(CommunityMobileUseSession.prototype);expect(CommunityMobileUseSession.isVerified(forgedUse)).toBe(false);expect(forgedUse.isCurrent(now)).toBe(false);
});

test('authority roots, exact subject expectations, lease dates and explicit null fields are enforced',async()=>{
  for(const origin of ['https://Fixture.workers.dev','https://fixture.workers.dev/','https://fixture.workers.dev:443','https://fixture.workers.dev/path','https://fixture.workers.dev?x=1','https://fixture.workers.dev#x','https://u@fixture.workers.dev','http://fixture.workers.dev','https://fixture.workers.dev.',' https://fixture.workers.dev'])
    await expect(mobile(golden.mobileAuthorization,now,mobileExpected(),{...authority,origin})).rejects.toThrow('INVALID_AUTHORITY');
  for(const expected of [mobileExpected({deviceId:randomUUID()}),mobileExpected({communityId:randomUUID()}),mobileExpected({enrollmentId:randomUUID()}),mobileExpected({deviceKind:'desktop'}),mobileExpected({revision:2}),mobileExpected({policyDigest:'0'.repeat(64)})])
    await expect(mobile(golden.mobileAuthorization,now,expected)).rejects.toThrow();
  for(const patch of [{profileId:randomUUID()},{version:2},{controlKey:softwareKey(23).publicKey},{agentDeviceId:randomUUID()},{issuedAt:now-1},{issuedAt:now+5_001,expiresAt:now+95_001},{expiresAt:now},{expiresAt:now+90_001},{extra:true}])
    await expect(mobile({...golden.mobileAuthorization,...patch})).rejects.toThrow();
  const missing=clone(golden.mobileAuthorization) as Record<string,unknown>;delete missing.controlKey;await expect(mobile(missing)).rejects.toThrow();
  const futureReply=await reply('authorization',{...golden.mobileAuthorization,issuedAt:now+5_001,expiresAt:now+95_001},now+5_001);
  await expect(CommunityDeviceAuthorization.fromReply(futureReply,authority,mobileExpected(),now)).rejects.toThrow('INVALID_AUTHORIZATION');
});

test('all identity and RAM keys must be distinct actual P-256 points; selected desktop receiver needs its component key',async()=>{
  const invalid=Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url');
  for(const patch of [{hostPublicKey:invalid},{publicKey:golden.mobileAuthorization.hostPublicKey},{biometricPublicKey:golden.mobileAuthorization.publicKey}])await expect(mobile({...golden.mobileAuthorization,...patch})).rejects.toThrow('INVALID_PUBLIC_KEY');
  const receiver=golden.receiverAuthorization;
  for(const patch of [{controlKey:null},{controlKey:receiver.hostPublicKey},{controlKey:invalid},{agentDeviceId:null}])
    await expect(CommunityDeviceAuthorization.fromReply(await reply('authorization',{...receiver,...patch}),authority,receiverExpected(),now)).rejects.toThrow();
  const settings={...receiver,capabilities:['computer-use.browser'],agentDeviceId:null};
  const scoped=await CommunityDeviceAuthorization.fromReply(await reply('authorization',settings),authority,receiverExpected({purpose:'mobile-browser'}),now);expect(scoped.body.agentDeviceId).toBeNull();
  const auth=await mobile();for(const key of [invalid,auth.body.hostPublicKey,auth.body.publicKey,auth.body.biometricPublicKey])
    await expect(CommunityMobileUseSession.fromReply(await reply('session',{...golden.useSession,publicKey:key}),auth,{sessionId:golden.useSession.sessionId},now)).rejects.toThrow('INVALID_PUBLIC_KEY');
});

test('capability ordering, dependencies, mobile receive restrictions, subsets and purpose downgrade are rejected',async()=>{
  for(const capabilities of [['agent.communicate','agent.communicate'],['root.admin'],['teams.run','agent.communicate'],['screen.control'],['screen.receive.view']])
    await expect(mobile({...golden.mobileAuthorization,capabilities})).rejects.toThrow('INVALID_CAPABILITIES');
  const auth=await mobile({...golden.mobileAuthorization,capabilities:['agent.communicate']});
  expect(auth.permits('agent' as any,now)).toBe(false);
  await expect(CommunityDeviceAuthorization.fromReply(await reply('authorization',auth.body),authority,mobileExpected({purpose:'mobile-teams'}),now)).rejects.toThrow('CAPABILITY_DENIED');
  await expect(CommunityMobileUseSession.fromReply(await reply('session',golden.useSession),auth,{sessionId:golden.useSession.sessionId},now)).rejects.toThrow('CAPABILITY_DENIED');
  const use=await CommunityMobileUseSession.fromReply(await reply('session',{...golden.useSession,capabilities:['agent.communicate']}),auth,{sessionId:golden.useSession.sessionId,purpose:'mobile-agent'},now);
  expect(use.permits('mobile-teams',now)).toBe(false);expect(use.permits('agent' as any,now)).toBe(false);
  await expect(CommunityMobileUseSession.fromReply(await reply('session',use.body),auth,{sessionId:use.body.sessionId,purpose:'mobile-teams'},now)).rejects.toThrow('CAPABILITY_DENIED');
  await expect(CommunityMobileUseSession.fromReply(await reply('session',use.body),auth,{sessionId:use.body.sessionId,purpose:'agent' as any},now)).rejects.toThrow('INVALID_PURPOSE');
});

test('use sessions bind exact owner, revision and RAM episode and cannot stretch human idle or lease windows',async()=>{
  const auth=await mobile();
  for(const patch of [{version:2},{communityId:randomUUID()},{enrollmentId:randomUUID()},{sessionId:randomUUID()},{revision:2},{sequence:-1},{sequence:0.5},{lastHumanAt:now+1},
    {idleExpiresAt:now+3_600_001},{idleExpiresAt:now},{expiresAt:now+90_001},{expiresAt:now},{issuedAt:now-1},{unknown:true}])
    await expect(CommunityMobileUseSession.fromReply(await reply('session',{...golden.useSession,...patch}),auth,{sessionId:golden.useSession.sessionId},now)).rejects.toThrow();
  const shortened={...golden.useSession,idleExpiresAt:now+30_000,expiresAt:now+30_000};
  expect((await CommunityMobileUseSession.fromReply(await reply('session',shortened),auth,{sessionId:shortened.sessionId},now)).isCurrent(now+29_999)).toBe(true);
  await expect(CommunityMobileUseSession.fromReply(await reply('session',{...shortened,expiresAt:now+30_001}),auth,{sessionId:shortened.sessionId},now)).rejects.toThrow('INVALID_USE_SESSION');
  const otherBody={...golden.mobileAuthorization,enrollmentId:randomUUID(),deviceId:randomUUID()},other=await mobile(otherBody,now,mobileExpected({enrollmentId:otherBody.enrollmentId,deviceId:otherBody.deviceId}));
  expect(other.receiptOwnerHash).not.toBe(auth.receiptOwnerHash);await expect(CommunityMobileUseSession.fromReply(await reply('session',golden.useSession),other,{sessionId:golden.useSession.sessionId},now)).rejects.toThrow('INVALID_USE_SESSION');
});

test('signed directories reject duplicate/cross-community subjects while permitting an unrelated Screen-only Mac',async()=>{
  const screen={...golden.receiverAuthorization,controlKey:null,agentDeviceId:null,capabilities:['screen.view']};
  const mixed=await reply('directory',[golden.mobileAuthorization,screen]);
  expect((await CommunityDeviceAuthorization.fromReply(mixed,authority,mobileExpected(),now)).body.deviceId).toBe(golden.mobileAuthorization.deviceId);
  await expect(CommunityDeviceAuthorization.fromReply(mixed,authority,receiverExpected(),now)).rejects.toThrow('WRONG_PRINCIPAL');
  for(const values of [[],[golden.mobileAuthorization,golden.mobileAuthorization],[golden.mobileAuthorization,{...screen,communityId:randomUUID()}],[golden.mobileAuthorization,{...screen,profileId:randomUUID()}],Array(33).fill(golden.mobileAuthorization)])
    await expect(CommunityDeviceAuthorization.fromReply(await reply('directory',values),authority,mobileExpected(),now)).rejects.toThrow();
});

test('typed expectations are snapshotted before asynchronous key verification and old valid leases remain usable until expiry',async()=>{
  const r=await reply('directory',[golden.mobileAuthorization,golden.receiverAuthorization]),expected=mobileExpected(),configured={...authority};
  const pending=CommunityDeviceAuthorization.fromReply(r,configured,expected,now);expected.deviceId=golden.receiverAuthorization.deviceId;expected.deviceKind='desktop';configured.origin='https://other.workers.dev';
  const verified=await pending;expect(verified.body.deviceId).toBe(golden.mobileAuthorization.deviceId);expect(verified.authority.origin).toBe(authority.origin);
  expect((await CommunityDeviceAuthorization.fromEnvelope(golden.envelopes.mobile,authority,mobileExpected(),now+70_000)).isCurrent(now+70_000)).toBe(true);
  await expect(CommunityDeviceAuthorization.fromEnvelope(golden.envelopes.mobile,authority,mobileExpected(),now+90_000)).rejects.toThrow();
  const id=JSON.parse(Buffer.from(golden.envelopes.mobile.payload,'base64url').toString())[2];
  expect((await verifyCommunityMobileAccessEnvelope(golden.envelopes.mobile,authority,id,now)).kind).toBe('authorization');
  await expect(verifyCommunityMobileAccessEnvelope(golden.envelopes.mobile,authority,randomUUID(),now)).rejects.toThrow('UNVERIFIED_REPLY');
  await expect(CommunityDeviceAuthorization.fromEnvelope({...golden.envelopes.mobile,hostSignature:'extra'},authority,mobileExpected(),now)).rejects.toThrow();
});
