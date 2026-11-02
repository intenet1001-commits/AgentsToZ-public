import {describe, expect, test} from 'bun:test';
import {generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject} from 'node:crypto';
import {computerUseCommunityCredentialBytes, type ComputerUseCommunityCredential} from '../src/computerUseCommunityCredential';
import {computerUseCommunityCertificateHash, computerUseCommunityHandshakeBytes, verifyComputerUseCommunityHandshake,
  type ComputerUseCommunityHandshake} from '../src/computerUseCommunityHandshake';
import {ComputerUseCommunityKeyConfirmation} from '../src/computerUseCommunityKeyConfirmation';

const keypair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function point(key: KeyObject) {const jwk=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64url');}
const signature=(key: KeyObject, bytes: Buffer)=>sign('sha256',bytes,{key,dsaEncoding:'ieee-p1363'}).toString('base64url');

function fixture() {
  const issuer=keypair(),a=keypair(),b=keypair(),ea=keypair(),eb=keypair(),now=1_900_000_000_000,profileId=randomUUID();
  const cert=(deviceId:string,key:KeyObject):ComputerUseCommunityCredential=>({version:1,purpose:'agentstoz-computer-use-device',
    issuer:'authority-1',profileId,deviceId,enrollmentId:randomUUID(),keyEpoch:1,membershipRevision:5,
    issuedAt:now-1000,expiresAt:now+60_000,identityPublicKey:point(key)});
  const sender=cert(randomUUID(),a.publicKey),receiver=cert(randomUUID(),b.publicKey);
  const t:ComputerUseCommunityHandshake={profileId,senderDeviceId:sender.deviceId,receiverDeviceId:receiver.deviceId,
    session:randomBytes(16).toString('hex'),instance:randomBytes(16).toString('hex'),receiverBootId:randomBytes(16).toString('hex'),
    senderCertificateHash:computerUseCommunityCertificateHash(sender),receiverCertificateHash:computerUseCommunityCertificateHash(receiver),
    senderEphemeral:point(ea.publicKey),receiverEphemeral:point(eb.publicKey),senderNonce:randomBytes(32).toString('base64url'),receiverNonce:randomBytes(32).toString('base64url')};
  const issue=(value:ComputerUseCommunityCredential)=>signature(issuer.privateKey,computerUseCommunityCredentialBytes(value));
  const input={transcript:t,sender:{credential:sender,signature:issue(sender),proof:signature(a.privateKey,computerUseCommunityHandshakeBytes(t,'sender'))},
    receiver:{credential:receiver,signature:issue(receiver),proof:signature(b.privateKey,computerUseCommunityHandshakeBytes(t,'receiver'))},
    trustedIssuers:new Map([['authority-1',point(issuer.publicKey)]]),now,minimumSenderKeyEpoch:1,minimumReceiverKeyEpoch:1,minimumMembershipRevision:5};
  return {input, a, b, ea, eb};
}

describe('authenticated community handshake transcript',()=>{
  test('accepts two separately issued device credentials and both role-specific proofs',()=>{
    const {input}=fixture();
    expect(verifyComputerUseCommunityHandshake(input)).toBe(true);
    expect(verifyComputerUseCommunityHandshake({...input,minimumMembershipRevision:6})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,minimumReceiverKeyEpoch:2})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,now:input.now+61_000})).toBe(false);
  });
  test('rejects active mailbox key substitution, role reflection, replay to another boot and downgrade fields',()=>{
    const {input}=fixture(),attacker=keypair();
    const altered={...input.transcript,receiverEphemeral:point(attacker.publicKey)};
    expect(verifyComputerUseCommunityHandshake({...input,transcript:altered})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,transcript:altered,receiver:{...input.receiver,
      proof:signature(attacker.privateKey,computerUseCommunityHandshakeBytes(altered,'receiver'))}})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,receiver:{...input.receiver,proof:input.sender.proof}})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,transcript:{...input.transcript,receiverBootId:randomBytes(16).toString('hex')}})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,transcript:{...input.transcript,version:1} as ComputerUseCommunityHandshake})).toBe(false);
  });
  test('rejects another profile, another certified device and altered trust roots',()=>{
    const {input}=fixture();
    expect(verifyComputerUseCommunityHandshake({...input,transcript:{...input.transcript,profileId:randomUUID()}})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,sender:input.receiver})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,trustedIssuers:new Map([['authority-1',point(keypair().publicKey)]])})).toBe(false);
    expect(verifyComputerUseCommunityHandshake({...input,transcript:{...input.transcript,receiverNonce:input.transcript.senderNonce}})).toBe(false);
  });
  test('confirms both parties computed the same ephemeral key without permitting role reflection or reuse',()=>{
    const {input,ea,eb}=fixture();
    const a=new ComputerUseCommunityKeyConfirmation('sender',input,ea.privateKey);
    const b=new ComputerUseCommunityKeyConfirmation('receiver',input,eb.privateKey);
    const ap=a.makeProof(),bp=b.makeProof();
    expect(ap).not.toBe(bp);
    a.acceptPeer(bp);b.acceptPeer(ap);
    expect(a.proofsVerified).toBe(true);expect(b.proofsVerified).toBe(true);
    expect(()=>a.makeProof()).toThrow();expect(()=>b.acceptPeer(ap)).toThrow();
  });
  test('rejects a reflected confirmation, an unrelated private key and an altered signed handshake',()=>{
    const {input,ea,eb}=fixture();
    const a=new ComputerUseCommunityKeyConfirmation('sender',input,ea.privateKey);
    const own=a.makeProof();
    expect(()=>a.acceptPeer(own)).toThrow();
    expect(a.proofsVerified).toBe(false);
    expect(()=>a.acceptPeer(own)).toThrow();
    expect(()=>new ComputerUseCommunityKeyConfirmation('sender',input,eb.privateKey)).toThrow();
    expect(()=>new ComputerUseCommunityKeyConfirmation('receiver',{...input,transcript:{...input.transcript,
      receiverBootId:randomBytes(16).toString('hex')}},eb.privateKey)).toThrow();
  });
});
