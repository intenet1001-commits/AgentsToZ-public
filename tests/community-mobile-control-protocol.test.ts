import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {communityBytes} from '../src/communityAccessClient';
import {MOBILE_CONTROL_TRANSCRIPT_FIELDS,deriveMobileControlKeys,mobileControlAAD,mobileControlConfirmation,mobileControlNonce,mobileControlOperationTime,mobileControlProofBytes,mobileControlReady,mobileControlResponse,mobileControlTranscriptBytes,openMobileControlRecord,parseMobileControlHello,parseMobileControlRequest,readMobileControlResponse,sealMobileControlRecord,validateMobileControlTranscript,verifyMobileControlConfirmation,verifyMobileControlProof,verifyMobileControlReady,type MobileControlTranscript} from '../src/communityMobileControlProtocol';
const g=JSON.parse(readFileSync(new URL('../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json',import.meta.url),'utf8'));
const t=g.transcript as MobileControlTranscript;
async function fixtureKeys(){
  const pub=communityBytes(t.senderEphemeral,65),d=Buffer.from(BigInt(g.softwareKeyScalars.senderEphemeral).toString(16).padStart(64,'0'),'hex').toString('base64url');
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:Buffer.from(pub.subarray(1,33)).toString('base64url'),y:Buffer.from(pub.subarray(33)).toString('base64url'),d},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  return deriveMobileControlKeys(key,t.receiverEphemeral,t);
}
test('native and Main share the exact 24-field Unicode transcript, role proofs and real P-256 verification',async()=>{
  expect(MOBILE_CONTROL_TRANSCRIPT_FIELDS).toEqual(g.transcriptFields);
  expect(Buffer.from(mobileControlTranscriptBytes(t)).toString('hex')).toBe(g.transcriptBytesHex);
  for(const role of ['client','host'] as const){
    expect(Buffer.from(mobileControlProofBytes(t,role)).toString('hex')).toBe(g.proofBytesHex[role]);
    expect(await verifyMobileControlProof(t,role,role==='client'?g.useSession.publicKey:g.receiverAuthorization.controlKey,g.signatures[role])).toBe(true);
    expect(await verifyMobileControlProof({...t,channelId:'11111111-1111-4111-8111-111111111111'},role,role==='client'?g.useSession.publicKey:g.receiverAuthorization.controlKey,g.signatures[role])).toBe(false);
    expect(await verifyMobileControlProof(t,role,role==='host'?g.useSession.publicKey:g.receiverAuthorization.controlKey,g.signatures[role])).toBe(false);
  }
  await expect(validateMobileControlTranscript({...t,senderEphemeral:'B'+ 'A'.repeat(86)})).rejects.toThrow();
  expect(()=>mobileControlTranscriptBytes({...t,receiverConnectionId:t.senderConnectionId})).toThrow();
  expect(()=>mobileControlTranscriptBytes({...t,receiverInstance:t.receiverBootId})).toThrow();
  expect(()=>mobileControlTranscriptBytes({...t,senderEphemeral:t.senderUsePublicKey})).toThrow();
});
test('HKDF/HMAC/ready and the actual AEAD fixture match; keys remain nonextractable',async()=>{
  const keys=await fixtureKeys();
  for(const key of [keys.clientToHost,keys.hostToClient,keys.clientConfirm,keys.hostConfirm])expect(key.extractable).toBe(false);
  for(const role of ['client','host'] as const){
    expect(await mobileControlConfirmation(keys,role,g.signatures[role])).toBe(g.confirmations[role]);
    expect(await verifyMobileControlConfirmation(keys,role,g.signatures[role],g.confirmations[role])).toBe(true);
    expect(await verifyMobileControlConfirmation(keys,role,g.signatures[role],g.confirmations[role==='client'?'host':'client'])).toBe(false);
  }
  expect(await mobileControlReady(keys,g.signatures.client,g.signatures.host)).toBe(g.readyConfirmation);
  expect(await verifyMobileControlReady(keys,g.signatures.client,g.signatures.host,g.readyConfirmation)).toBe(true);
  expect(await verifyMobileControlReady(keys,g.signatures.host,g.signatures.client,g.readyConfirmation)).toBe(false);
  expect(Buffer.from(mobileControlNonce(g.record.direction,g.record.seq)).toString('hex')).toBe(g.record.nonceHex);
  expect(Buffer.from(mobileControlAAD(t,g.record.direction,g.record.seq,g.record.requestId)).toString('utf8')).toBe(g.record.aadUTF8);
  const record=await sealMobileControlRecord(keys,t,g.record.direction,g.record.seq,g.record.requestId,JSON.parse(g.record.plaintextUTF8));
  expect(record.ciphertext).toBe(g.record.ciphertext);
  expect(await openMobileControlRecord(keys,t,g.record.direction,g.record.seq,record)).toEqual(JSON.parse(g.record.plaintextUTF8));
  await expect(openMobileControlRecord(keys,t,g.record.direction,g.record.seq+1,record)).rejects.toThrow();
  await expect(openMobileControlRecord(keys,{...t,purpose:'mobile-browser'},g.record.direction,g.record.seq,record)).rejects.toThrow();
  await expect(openMobileControlRecord(keys,t,g.record.direction,g.record.seq,{...record,requestId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow();
});
test('request mode, UUIDv7 timestamp and result bytes stay bound; unknown fields and oversized data refuse',async()=>{
  const id=g.record.requestId,command={op:'fixture-read'},effect={v:1,kind:'request',mode:'effect',requestId:id,...g.effect,command};
  expect(mobileControlOperationTime(g.effect.operationId)).toBe(g.effect.createdAt);
  expect(parseMobileControlRequest(effect,id)).toEqual(effect);expect(Object.isFrozen(effect.command)).toBe(true);
  expect(()=>parseMobileControlRequest({...effect,createdAt:g.effect.createdAt+1},id)).toThrow();
  expect(()=>parseMobileControlRequest({...effect,path:'/untrusted'},id)).toThrow();
  expect(()=>parseMobileControlRequest({v:1,kind:'request',mode:'query',requestId:id,command:[],operationId:g.effect.operationId},id)).toThrow();
  const result={outcome:'fixture-result',text:'한글 / exact bytes'},response=mobileControlResponse(id,result);
  expect(readMobileControlResponse(response,id).result).toEqual(result);
  expect(()=>readMobileControlResponse({...response,resultDigest:'0'.repeat(64)},id)).toThrow();
  expect(()=>mobileControlResponse(id,{text:'x'.repeat(16_001)})).toThrow();
  expect(()=>mobileControlResponse(id,undefined)).toThrow();
  await expect(sealMobileControlRecord(await fixtureKeys(),t,'client',1,id,{text:'x'.repeat(24_001)})).rejects.toThrow();
  const hello={v:2,type:'hello',purpose:t.purpose,channelId:t.channelId,senderAuthorization:g.envelopes.mobile,senderUseSession:g.envelopes.use,
    expectedReceiver:{deviceId:t.receiverDeviceId,enrollmentId:t.receiverEnrollmentId,policyDigest:t.receiverPolicyDigest},senderConnectionId:t.senderConnectionId,receiverConnectionId:null,senderEphemeral:t.senderEphemeral,senderNonce:t.senderNonce};
  expect(parseMobileControlHello(hello).receiverConnectionId).toBeNull();
  expect(()=>parseMobileControlHello({...hello,legacy:true})).toThrow();
  expect(()=>parseMobileControlHello({...hello,receiverConnectionId:'unknown'})).toThrow();
});
