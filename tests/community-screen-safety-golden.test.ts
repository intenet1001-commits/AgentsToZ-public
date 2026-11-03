import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import golden from '../native/screen-control/Tests/Fixtures/community-screen-safety-v1.json';
import paging from '../native/screen-control/Tests/Fixtures/community-screen-safety-paging-v1.json';
import {CommunityAccessReply} from '../src/communityAccessClient';
import type {CommunityDeviceAuthorizationBody} from '../src/communityMobilePrincipal';
import {CommunitySafetyRound,communitySafetyPolicyDigest,communitySafetyWatcherHash,verifyCommunitySafetyHostResult} from '../src/communityScreenSafetyClient';

function expected(receiver:CommunityDeviceAuthorizationBody){return {communityId:receiver.communityId,profileId:receiver.profileId,enrollmentId:receiver.enrollmentId,deviceId:receiver.deviceId,hostPublicKey:receiver.hostPublicKey,keyEpoch:receiver.keyEpoch,revision:receiver.revision,policyDigest:communitySafetyPolicyDigest(receiver)};}
test('Swift shared software vector matches the pinned SDK policy, watcher, RAM command and original host-result proof',async()=>{
 expect(golden.softwareOnly).toBe(true);
 const receiver=golden.round.receiver as CommunityDeviceAuthorizationBody,poll=JSON.parse(Buffer.from(golden.pollRequestBytes,'base64url').toString('utf8'));
 expect(communitySafetyPolicyDigest(receiver)).toBe(golden.receiverPolicyDigest);
 expect(communitySafetyWatcherHash(receiver,golden.ids.activation,golden.round.watchers as any)).toBe(golden.watcherSetHash);
 expect(createHash('sha256').update(Buffer.from(golden.watcherBytes,'base64url')).digest('hex')).toBe(golden.watcherSetHash);
 const reply=await CommunityAccessReply.verify(golden.roundEnvelope,golden.authority.issuerPublicKey,golden.ids.poll,golden.at);
 const round=await CommunitySafetyRound.fromReply(reply,golden.authority,expected(receiver),{requestId:poll[2],nonce:poll[4],activationId:poll[6][1]},golden.at);
 expect(round.body.commands[0]?.request).toEqual(golden.stopRequestEnvelope);
 expect(Buffer.from(round.body.commands[0]!.request.payload,'base64url').toString('base64url')).toBe(golden.stopRequestBytes);
 expect((await verifyCommunitySafetyHostResult(golden.resultEnvelope,{communityId:golden.ids.community,receiverEnrollmentId:golden.ids.host,activationId:golden.ids.activation,commandId:golden.ids.command,hostPublicKey:golden.keys.host.publicKey,acceptedAt:round.body.commands[0]!.acceptedAt,expiresAt:round.body.commands[0]!.expiresAt,action:'end'},golden.at)).outcome).toBe('ended');
});
test('the actual CF registry signed five-command paging vector wraps without treating the cursor as an acknowledgement',async()=>{
 const receiver=paging.receiver as CommunityDeviceAuthorizationBody,poll=JSON.parse(Buffer.from(paging.pollRequestBytes,'base64url').toString('utf8'));
 const reply=await CommunityAccessReply.verify(paging.round,paging.authority.issuerPublicKey,poll[2],paging.now);
 const round=await CommunitySafetyRound.fromReply(reply,paging.authority,expected(receiver),{requestId:poll[2],nonce:poll[4],activationId:paging.activationId},paging.now);
 expect(round.body.commands.map(c=>c.sequence)).toEqual([4,5,1,2]);expect(round.body.nextSequence).toBe(2);
 expect(round.body.commands.map(c=>c.sequence)).toEqual(paging.expectedSequences);expect(round.body.nextSequence).toBe(paging.expectedNextSequence);
});
