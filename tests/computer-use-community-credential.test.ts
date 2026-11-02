import {describe, expect, test} from 'bun:test';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {computerUseCommunityCredentialBytes, verifyComputerUseCommunityCredential,
  type ComputerUseCommunityCredential} from '../src/computerUseCommunityCredential';

function publicPoint(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const jwk = key.export({format: 'jwk'});
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
}

function fixture() {
  const issuer = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const device = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const now = 1_900_000_000_000;
  const credential: ComputerUseCommunityCredential = {version: 1, purpose: 'agentstoz-computer-use-device',
    issuer: 'issuer-1', profileId: randomUUID(), deviceId: randomUUID(), enrollmentId: randomUUID(),
    keyEpoch: 2, membershipRevision: 3, issuedAt: now - 1000, expiresAt: now + 60_000,
    identityPublicKey: publicPoint(device.publicKey)};
  const signature = sign('sha256', computerUseCommunityCredentialBytes(credential),
    {key: issuer.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url');
  const params = {credential, signature, trustedIssuers: new Map([['issuer-1', publicPoint(issuer.publicKey)]]),
    profileId: credential.profileId, deviceId: credential.deviceId, now, minimumKeyEpoch: 2, minimumMembershipRevision: 3};
  return {credential, params};
}

describe('community device credentials', () => {
  test('accepts only an issuer-signed exact device and profile at the permitted revision', () => {
    const {credential, params} = fixture();
    expect(verifyComputerUseCommunityCredential(params)).toEqual(credential);
    expect(verifyComputerUseCommunityCredential({...params, profileId: randomUUID()})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, deviceId: randomUUID()})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, minimumKeyEpoch: 3})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, minimumMembershipRevision: 4})).toBeNull();
  });

  test('rejects forged, modified, extended, expired and untrusted certificates', () => {
    const {credential, params} = fixture();
    expect(verifyComputerUseCommunityCredential({...params, credential: {...credential, deviceId: randomUUID()}})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, credential: {...credential, keyEpoch: 3}})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, credential: {...credential, surprise: true}})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, signature: Buffer.alloc(64).toString('base64url')})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, trustedIssuers: new Map()})).toBeNull();
    const impostor = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    expect(verifyComputerUseCommunityCredential({...params, trustedIssuers: new Map([['issuer-1', publicPoint(impostor.publicKey)]])})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, now: credential.expiresAt})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, now: credential.issuedAt - 1})).toBeNull();
  });

  test('rejects malformed keys, invalid values and unbounded lifetimes before verification', () => {
    const {credential, params} = fixture();
    for (const altered of [
      {...credential, identityPublicKey: Buffer.alloc(65).toString('base64url')},
      {...credential, issuer: 'ISSUER'}, {...credential, profileId: credential.profileId.toUpperCase()},
      {...credential, expiresAt: credential.issuedAt + 24 * 60 * 60 * 1000 + 1},
      {...credential, membershipRevision: 0}, {...credential, keyEpoch: Number.MAX_SAFE_INTEGER + 1},
    ]) expect(verifyComputerUseCommunityCredential({...params, credential: altered})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, trustedIssuers: new Map([['issuer-1', 'invalid']])})).toBeNull();
    expect(verifyComputerUseCommunityCredential({...params, signature: params.signature + '='})).toBeNull();
  });
});
