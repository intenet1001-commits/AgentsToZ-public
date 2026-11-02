import {createHash, createHmac, createPublicKey, diffieHellman, ECDH, hkdfSync, timingSafeEqual, type KeyObject} from 'node:crypto';
import {computerUseCommunityHandshakeBytes, verifyComputerUseCommunityHandshake} from './computerUseCommunityHandshake';

type HandshakeInput = Parameters<typeof verifyComputerUseCommunityHandshake>[0];
type Role = 'sender' | 'receiver';
const DOMAIN = Buffer.from('agentstoz.computer-use.key-confirmation/v2', 'utf8');

function publicPoint(key: KeyObject): string {
  const jwk = key.export({format:'jwk'});
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw Error('invalid ephemeral key');
  const bytes=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]);
  const checked=ECDH.convertKey(bytes,'prime256v1',undefined,undefined,'uncompressed');
  if (!Buffer.isBuffer(checked) || !checked.equals(bytes)) throw Error('invalid ephemeral key');
  return bytes.toString('base64url');
}
function publicKey(encoded: string): KeyObject {
  const bytes=Buffer.from(encoded,'base64url');
  if (bytes.length!==65 || bytes[0]!==4 || bytes.toString('base64url')!==encoded) throw Error('invalid ephemeral key');
  return createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:bytes.subarray(1,33).toString('base64url'),y:bytes.subarray(33).toString('base64url')}});
}
function derive(secret:Buffer,transcript:Buffer,role:Role):Buffer {
  return Buffer.from(hkdfSync('sha256',secret,transcript,Buffer.concat([DOMAIN,Buffer.from(`/${role}`)]),32));
}
function confirm(key:Buffer,transcript:Buffer,role:Role):Buffer {
  return createHmac('sha256',key).update(DOMAIN).update(Buffer.from(`/${role}\0`)).update(transcript).digest();
}

/**
 * A single in-memory key-confirmation exchange after BOTH credential-backed signatures were verified. The supplied
 * private key must be a fresh ephemeral key for this session. This class is not a durable replay fence, live membership
 * lease, mailbox transport or permission grant; no production connection currently relies on it.
 */
export class ComputerUseCommunityKeyConfirmation {
  private readonly transcript:Buffer;
  private readonly ownKey:Buffer;
  private readonly peerKey:Buffer;
  private ownMade=false;
  private peerAccepted=false;
  private closed=false;

  constructor(private readonly role:Role, handshake:HandshakeInput, ownEphemeralPrivate:KeyObject) {
    if ((role!=='sender' && role!=='receiver') || !verifyComputerUseCommunityHandshake(handshake)
      || ownEphemeralPrivate.type!=='private') throw Error('unverified handshake');
    const t=handshake.transcript;
    const own=role==='sender'?t.senderEphemeral:t.receiverEphemeral;
    const peer=role==='sender'?t.receiverEphemeral:t.senderEphemeral;
    if (publicPoint(createPublicKey(ownEphemeralPrivate))!==own) throw Error('ephemeral key mismatch');
    this.transcript=createHash('sha256').update(computerUseCommunityHandshakeBytes(t,'sender'))
      .update(computerUseCommunityHandshakeBytes(t,'receiver')).digest();
    const secret=diffieHellman({privateKey:ownEphemeralPrivate,publicKey:publicKey(peer)});
    try {this.ownKey=derive(secret,this.transcript,role);this.peerKey=derive(secret,this.transcript,role==='sender'?'receiver':'sender');}
    finally {secret.fill(0);}
  }
  makeProof():string {
    if (this.closed || this.ownMade) throw Error('confirmation already used');
    this.ownMade=true;
    const proof=confirm(this.ownKey,this.transcript,this.role).toString('base64url');
    if (this.peerAccepted) this.close();
    return proof;
  }
  acceptPeer(value:unknown):void {
    if (this.closed || this.peerAccepted) throw Error('confirmation already used');
    const peer:Role=this.role==='sender'?'receiver':'sender';
    const expected=confirm(this.peerKey,this.transcript,peer);
    const actual=typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value)?Buffer.from(value,'base64url'):Buffer.alloc(0);
    const okay=actual.length===expected.length && typeof value==='string' && actual.toString('base64url')===value && timingSafeEqual(actual,expected);
    expected.fill(0);actual.fill(0);
    if (!okay) {this.close();throw Error('invalid peer confirmation');}
    this.peerAccepted=true;
    if (this.ownMade) this.close();
  }
  get proofsVerified():boolean {return this.ownMade && this.peerAccepted;}
  close():void {this.closed=true;this.ownKey.fill(0);this.peerKey.fill(0);}
}
