import {expect,test} from 'bun:test';
import {ComputerUseRemoteChannel,generateComputerUseRemoteKeyPair,type ComputerUseRemoteBinding} from '../src/computerUseRemoteCrypto';

// This demonstrates the existing v1 threat, not a security property of the proposed device-authenticated protocol.
// An active mailbox adversary can substitute both ephemeral public keys while keeping all visible AAD fields intact.
test('v1 permits an active mailbox intermediary to read and alter both directions',async()=>{
  const binding:ComputerUseRemoteBinding={session:'0123456789abcdef0123456789abcdef',
    senderDeviceId:'11111111-1111-4111-8111-111111111111',receiverDeviceId:'22222222-2222-4222-8222-222222222222',
    instance:'fedcba9876543210fedcba9876543210',platform:'darwin'};
  const [a,b,attackerForA,attackerForB]=await Promise.all(Array.from({length:4},()=>generateComputerUseRemoteKeyPair()));
  const [sender,interceptorReceiver,interceptorSender,receiver]=await Promise.all([
    ComputerUseRemoteChannel.establish({side:'sender',privateKey:a!.keyPair.privateKey,peerPublicKey:attackerForA!.publicKey,binding}),
    ComputerUseRemoteChannel.establish({side:'receiver',privateKey:attackerForA!.keyPair.privateKey,peerPublicKey:a!.publicKey,binding}),
    ComputerUseRemoteChannel.establish({side:'sender',privateKey:attackerForB!.keyPair.privateKey,peerPublicKey:b!.publicKey,binding}),
    ComputerUseRemoteChannel.establish({side:'receiver',privateKey:b!.keyPair.privateKey,peerPublicKey:attackerForB!.publicKey,binding}),
  ]);
  const header={op:'call' as const,seq:1,sentAt:1_700_000_000_001};
  const original=await sender.sealRequest(header,{operation:'scope-type-text',text:'원래 내용'});
  expect((await interceptorReceiver.openRequest(header,original)).meta.text).toBe('원래 내용');
  const changed=await interceptorSender.sealRequest(header,{operation:'scope-type-text',text:'변조된 내용'});
  expect((await receiver.openRequest(header,changed)).meta.text).toBe('변조된 내용');
  const genuineReply=await receiver.sealReply(header,{success:true,value:'B의 응답'});
  expect((await interceptorSender.openReply(header,genuineReply)).meta.value).toBe('B의 응답');
  const fakeReply=await interceptorReceiver.sealReply(header,{success:true,value:'변조된 응답'});
  expect((await sender.openReply(header,fakeReply)).meta.value).toBe('변조된 응답');
});
