import {test,expect} from 'bun:test';
import {randomUUID,sign} from 'node:crypto';
import {CommunityAccessReply} from '../src/communityAccessClient';
import {CommunitySafetyRound,communitySafetyPolicyDigest,verifyCommunitySafetyHostResult} from '../src/communityScreenSafetyClient';
import {verifyCommunityMobileAccessEnvelope} from '../src/communityMobilePrincipal';
import {screenSafetyFixture,safetyKey} from './fixtures/community-screen-safety';
function prepared(){const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();return f;}
function fields(envelope:{payload:string}){return JSON.parse(Buffer.from(envelope.payload,'base64url').toString()) as any[];}
function expected(f:ReturnType<typeof screenSafetyFixture>){const b=f.authorization(f.host);return {communityId:f.cid,profileId:f.profile,enrollmentId:b.enrollmentId,deviceId:b.deviceId,hostPublicKey:b.hostPublicKey,keyEpoch:b.keyEpoch,revision:b.revision,policyDigest:communitySafetyPolicyDigest(b)};}
function authority(f:ReturnType<typeof screenSafetyFixture>){return {origin:'https://safety-fixture.workers.dev',profileId:f.profile,issuerPublicKey:f.issuerPublic};}
async function reply(f:ReturnType<typeof screenSafetyFixture>,request:ReturnType<ReturnType<typeof screenSafetyFixture>['pollRequest']>){const r=f.run(request),id=fields(request)[2];return {reply:await CommunityAccessReply.verify(r.envelope,f.issuerPublic,id,f.now()),poll:{requestId:id,nonce:fields(request)[4],activationId:fields(request)[6][1]},raw:r};}
test('real authority round is consumed end-to-end by the pinned SDK including the original RAM signed command and independent host result',async()=>{
 const f=prepared(),stop=f.run(f.stopRequest()),request=f.pollRequest(),r=await reply(f,request),a=authority(f);
 const round=await CommunitySafetyRound.fromReply(r.reply,a,expected(f),r.poll,f.now());expect(CommunitySafetyRound.isVerified(round)).toBe(true);expect(round.body.commands[0]?.commandId).toBe(stop.value.commandId);
 await expect(verifyCommunityMobileAccessEnvelope(r.raw.envelope,a,undefined,f.now())).rejects.toThrow('UNVERIFIED_REPLY');
 const proof=f.result(stop.value.commandId),accepted=f.now();f.advance(120_000);expect(f.poll([proof]).kind).toBe('safety-round');
 const receipt=await verifyCommunitySafetyHostResult(proof,{communityId:f.cid,receiverEnrollmentId:f.host.enrollment!,activationId:f.activation,commandId:stop.value.commandId,hostPublicKey:f.authorization(f.host).hostPublicKey,action:'turnOff',acceptedAt:accepted,expiresAt:accepted+7*86400_000},f.now());
 expect(receipt.outcome).toBe('turned-off');
 await expect(verifyCommunitySafetyHostResult(proof,{communityId:f.cid,receiverEnrollmentId:f.host.enrollment!,activationId:randomUUID(),commandId:stop.value.commandId,hostPublicKey:f.authorization(f.host).hostPublicKey,acceptedAt:accepted,expiresAt:accepted+7*86400_000},f.now())).rejects.toThrow();
});
test('an accepted turnOff still verifies after the original one-hour mobile use episode expires',async()=>{
 const f=prepared();const stop=f.run(f.stopRequest());f.advance(3_601_000);const request=f.pollRequest(),r=await reply(f,request);
 const round=await CommunitySafetyRound.fromReply(r.reply,authority(f),expected(f),r.poll,f.now());expect(round.body.commands[0]?.commandId).toBe(stop.value.commandId);
});
test('prototype forgery, a reply verified under another issuer, wrong receiver and replayed poll subjects cannot supply a safety witness',async()=>{
 const f=prepared(),request=f.pollRequest(),r=await reply(f,request),a=authority(f);
 await expect(CommunitySafetyRound.fromReply(Object.create(CommunityAccessReply.prototype),a,expected(f),r.poll,f.now())).rejects.toThrow();
 expect(CommunitySafetyRound.isVerified(Object.create(CommunitySafetyRound.prototype))).toBe(false);
 await expect(CommunitySafetyRound.fromReply(r.reply,a,{...expected(f),deviceId:randomUUID()},r.poll,f.now())).rejects.toThrow();
 await expect(CommunitySafetyRound.fromReply(r.reply,a,expected(f),{...r.poll,nonce:Buffer.alloc(32,1).toString('base64url')},f.now())).rejects.toThrow();
 await expect(CommunitySafetyRound.fromReply(r.reply,a,expected(f),r.poll,f.now()+91_000)).rejects.toThrow();
 const other=safetyKey(),v=fields(r.raw.envelope),bytes=Buffer.from(JSON.stringify(v)),wrapped={payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]),{key:other.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
 const jwk=other.publicKey.export({format:'jwk'}),pub=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64url');
 const foreign=await CommunityAccessReply.verify(wrapped,pub,r.poll.requestId,f.now());await expect(CommunitySafetyRound.fromReply(foreign,a,expected(f),r.poll,f.now())).rejects.toThrow();
});
