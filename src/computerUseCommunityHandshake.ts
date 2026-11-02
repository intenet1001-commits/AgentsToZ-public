import {createHash, createPublicKey, ECDH, verify} from 'node:crypto';
import {computerUseCommunityCredentialBytes, verifyComputerUseCommunityCredential,
  type ComputerUseCommunityCredential} from './computerUseCommunityCredential';

/** Candidate transcript verification only. No mailbox or Control admission uses this module yet. */
export interface ComputerUseCommunityHandshake {
  profileId: string; senderDeviceId: string; receiverDeviceId: string;
  session: string; instance: string; receiverBootId: string;
  senderCertificateHash: string; receiverCertificateHash: string;
  senderEphemeral: string; receiverEphemeral: string; senderNonce: string; receiverNonce: string;
}
type Role = 'sender' | 'receiver';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex32 = /^[0-9a-f]{32}$/;
const hash64 = /^[0-9a-f]{64}$/;
const fields = ['profileId','senderDeviceId','receiverDeviceId','session','instance','receiverBootId',
  'senderCertificateHash','receiverCertificateHash','senderEphemeral','receiverEphemeral','senderNonce','receiverNonce'] as const;

function decode(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('invalid encoding');
  const data = Buffer.from(value, 'base64url');
  if (data.length !== length || data.toString('base64url') !== value) throw Error('invalid encoding');
  return data;
}
function publicKey(value: string) {
  const bytes = decode(value, 65);
  if (bytes[0] !== 4) throw Error('invalid P-256 key');
  const checked = ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');
  if (!Buffer.isBuffer(checked) || !checked.equals(bytes)) throw Error('invalid P-256 key');
  return createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:bytes.subarray(1,33).toString('base64url'),y:bytes.subarray(33).toString('base64url')}});
}
function frame(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap(value => {const bytes=Buffer.from(value,'utf8'), size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);return [size,bytes];}));
}

export function computerUseCommunityCertificateHash(value: ComputerUseCommunityCredential): string {
  return createHash('sha256').update(computerUseCommunityCredentialBytes(value)).digest('hex');
}

/** The signer role is included to prevent reflecting one side's signature as the other side's proof. */
export function computerUseCommunityHandshakeBytes(value: ComputerUseCommunityHandshake, role: Role): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key)) || (role !== 'sender' && role !== 'receiver')
    || !uuid.test(value.profileId) || !uuid.test(value.senderDeviceId) || !uuid.test(value.receiverDeviceId)
    || value.senderDeviceId === value.receiverDeviceId || !hex32.test(value.session) || !hex32.test(value.instance)
    || !hex32.test(value.receiverBootId) || !hash64.test(value.senderCertificateHash) || !hash64.test(value.receiverCertificateHash))
    throw Error('invalid handshake binding');
  publicKey(value.senderEphemeral); publicKey(value.receiverEphemeral);
  if (value.senderEphemeral === value.receiverEphemeral) throw Error('duplicate ephemeral key');
  decode(value.senderNonce, 32); decode(value.receiverNonce, 32);
  if (value.senderNonce === value.receiverNonce) throw Error('duplicate nonce');
  return frame(['agentstoz.computer-use.community-handshake/v2',role,'darwin',...fields.map(key=>value[key])]);
}

/**
 * Verifies both independent certificates and both signatures over a shared session. This is not channel key
 * confirmation, a replay fence, a current membership lease, or permission to dispatch an input.
 */
export function verifyComputerUseCommunityHandshake(input: {transcript: ComputerUseCommunityHandshake;
  sender: {credential: unknown; signature: unknown; proof: unknown}; receiver: {credential: unknown; signature: unknown; proof: unknown};
  trustedIssuers: ReadonlyMap<string,string>; now: number; minimumSenderKeyEpoch: number; minimumReceiverKeyEpoch: number;
  minimumMembershipRevision: number}): boolean {
  try {
    const t=input.transcript;
    const common={trustedIssuers:input.trustedIssuers,profileId:t.profileId,now:input.now,minimumMembershipRevision:input.minimumMembershipRevision};
    const sender=verifyComputerUseCommunityCredential({...common,deviceId:t.senderDeviceId,minimumKeyEpoch:input.minimumSenderKeyEpoch,
      credential:input.sender.credential,signature:input.sender.signature});
    const receiver=verifyComputerUseCommunityCredential({...common,deviceId:t.receiverDeviceId,minimumKeyEpoch:input.minimumReceiverKeyEpoch,
      credential:input.receiver.credential,signature:input.receiver.signature});
    if (!sender || !receiver || sender.identityPublicKey === receiver.identityPublicKey
      || computerUseCommunityCertificateHash(sender)!==t.senderCertificateHash || computerUseCommunityCertificateHash(receiver)!==t.receiverCertificateHash)
      return false;
    return verify('sha256',computerUseCommunityHandshakeBytes(t,'sender'),{key:publicKey(sender.identityPublicKey),dsaEncoding:'ieee-p1363'},decode(input.sender.proof,64))
      && verify('sha256',computerUseCommunityHandshakeBytes(t,'receiver'),{key:publicKey(receiver.identityPublicKey),dsaEncoding:'ieee-p1363'},decode(input.receiver.proof,64));
  } catch { return false; }
}
