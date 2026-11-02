import {expect,test} from 'bun:test';
import golden from '../native/computer-use/Tests/ControlContract/community-component-golden.json';
import {CommunityAccessReply,communityBytes,communityBase64} from '../src/communityAccessClient';
import {CommunityComponentAuthorization,communityComponentHandshakeBytes,verifyCommunityComponentHandshake,type CommunityComponentHandshake} from '../src/communityComponentIdentity';
import {remoteTeamDeviceChoices} from '../src/remoteTeamHost';

test('the same public software vector verifies issuer, Unicode policy digests and all 19 role-bound handshake fields in Bun and Swift',async()=>{
  const senderReply=await CommunityAccessReply.verify(golden.sender.envelope,golden.issuerPublicKey,golden.sender.requestId,golden.now);
  const receiverReply=await CommunityAccessReply.verify(golden.receiver.envelope,golden.issuerPublicKey,golden.receiver.requestId,golden.now);
  const sender=await CommunityComponentAuthorization.fromReply(senderReply,golden.profileId,undefined,golden.now),receiver=await CommunityComponentAuthorization.fromReply(receiverReply,golden.profileId,undefined,golden.now);
  expect(sender.policyDigest).toBe(golden.sender.expectedPolicyDigest);expect(receiver.policyDigest).toBe(golden.receiver.expectedPolicyDigest);
  const transcript=golden.transcript as CommunityComponentHandshake;
  expect(communityBase64(communityComponentHandshakeBytes(transcript,'sender'))).toBe(golden.expectedSenderMessage);
  expect(communityBase64(communityComponentHandshakeBytes(transcript,'receiver'))).toBe(golden.expectedReceiverMessage);
  expect(communityBytes(golden.senderProof,64)).toHaveLength(64);
  expect(await verifyCommunityComponentHandshake({transcript,sender,receiver,senderProof:golden.senderProof,receiverProof:golden.receiverProof,now:golden.now})).toBe(true);
  expect(await verifyCommunityComponentHandshake({transcript:{...transcript,senderAgentDeviceId:receiver.body.agentDeviceId},sender,receiver,senderProof:golden.senderProof,receiverProof:golden.receiverProof,now:golden.now})).toBe(false);
  expect(await verifyCommunityComponentHandshake({transcript,sender,receiver,senderProof:golden.receiverProof,receiverProof:golden.senderProof,now:golden.now})).toBe(false);
});
test('remote Teams discovery joins actual portal IDs and community endpoints to verified issuer policy without treating an OPS route or CF UUID as the peer',async()=>{
  const sender=await CommunityComponentAuthorization.fromReply(await CommunityAccessReply.verify(golden.sender.envelope,golden.issuerPublicKey,golden.sender.requestId,golden.now),golden.profileId,undefined,golden.now);
  const receiver=await CommunityComponentAuthorization.fromReply(await CommunityAccessReply.verify(golden.receiver.envelope,golden.issuerPublicKey,golden.receiver.requestId,golden.now),golden.profileId,undefined,golden.now);
  const endpoint='99999999-9999-4999-8999-999999999999';
  const devices=[{deviceId:receiver.body.agentDeviceId,endpointId:endpoint,displayName:'Community role name',kind:'ops',lastSeenAt:null},{deviceId:receiver.body.deviceId,endpointId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{deviceId:sender.body.agentDeviceId,endpointId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}];
  expect(remoteTeamDeviceChoices(sender,[sender,receiver],devices,golden.now)).toEqual([{deviceId:receiver.body.agentDeviceId,endpointId:endpoint,name:receiver.body.name}]);
  expect(()=>remoteTeamDeviceChoices(sender,[receiver,receiver],devices,golden.now)).toThrow('중복');
  expect(()=>remoteTeamDeviceChoices(sender,[receiver],[...devices,{deviceId:receiver.body.agentDeviceId,endpointId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}],golden.now)).toThrow('중복');
  expect(()=>remoteTeamDeviceChoices(sender,[receiver],devices,golden.now+90_001)).toThrow('동의');
});
