import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import contract from '../context-api-contract.json';

// These values are deliberately independent of src/whatISaidStore.ts and the
// adapter helper. They let an external implementation validate every byte
// before it ever connects to a user's local feed.
const EXPECTED = Object.freeze({
  derivedKeySha256: 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e',
  requestSignature: 'e1231e0e8997d9ef9cddf91902c7a6bbbc9642c947860268956d4ab2eaaf8f97',
  authorization: 'AgentsToZ-HMAC v1:f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687:e1231e0e8997d9ef9cddf91902c7a6bbbc9642c947860268956d4ab2eaaf8f97',
  responseBodySha256: '6085d18b3b28db6fdaa0cef47bfde9f7e6fc55f794986848b46e6e73e34505f3',
  responseSignature: '24aed09bd948f05d71b29854498bcf4f20d0e88a5a91465bd5928927f42f0c40',
  responseProof: 'v1:f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687:24aed09bd948f05d71b29854498bcf4f20d0e88a5a91465bd5928927f42f0c40',
});

describe('What-I-said feed external-caller contract', () => {
  test('publishes byte-exact request and response HMAC vectors without store helpers', () => {
    const auth = contract.whatISaidFeedAuth;
    const vector = auth.testVector;

    expect(Buffer.from(auth.requestProofDomain, 'utf8').at(-1)).toBe(0);
    expect(Buffer.from(auth.responseProofDomain, 'utf8').at(-1)).toBe(0);
    expect(auth.requestProof.messageSegments[2]).toMatchObject({ literalHex: '0047455400' });
    expect(auth.responseProof.messageSegments[4]).toMatchObject({ literalHex: '00' });

    const key = createHash('sha256').update(vector.accessKey, 'utf8').digest();
    expect(key.toString('hex')).toBe(EXPECTED.derivedKeySha256);
    expect(vector.derivedKeySha256).toBe(EXPECTED.derivedKeySha256);

    const requestMessage = Buffer.concat([
      Buffer.from(auth.requestProofDomain, 'utf8'),
      // The challenge is authenticated as lowercase-hex ASCII, not 32 decoded bytes.
      Buffer.from(vector.challenge, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('GET', 'ascii'),
      Buffer.from([0x00]),
      Buffer.from(vector.requestTarget, 'utf8'),
    ]);
    expect(requestMessage.toString('hex')).toBe(vector.requestMessageHex);
    const requestSignature = createHmac('sha256', key).update(requestMessage).digest('hex');
    expect(requestSignature).toBe(EXPECTED.requestSignature);
    expect(vector.requestSignature).toBe(EXPECTED.requestSignature);
    expect(`${auth.scheme} v${auth.version}:${vector.challenge}:${requestSignature}`)
      .toBe(EXPECTED.authorization);
    expect(vector.authorization).toBe(EXPECTED.authorization);

    const responseBody = Buffer.from(vector.responseBodyUtf8, 'utf8');
    const bodyHash = createHash('sha256').update(responseBody).digest('hex');
    expect(bodyHash).toBe(EXPECTED.responseBodySha256);
    expect(vector.responseBodySha256).toBe(EXPECTED.responseBodySha256);
    const responseMessage = Buffer.concat([
      Buffer.from(auth.responseProofDomain, 'utf8'),
      Buffer.from(vector.challenge, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('GET', 'ascii'),
      Buffer.from([0x00]),
      Buffer.from(vector.requestTarget, 'utf8'),
      Buffer.from([0x00]),
      // The digest is authenticated as lowercase-hex ASCII, not 32 digest bytes.
      Buffer.from(bodyHash, 'utf8'),
    ]);
    expect(responseMessage.toString('hex')).toBe(vector.responseMessageHex);
    const responseSignature = createHmac('sha256', key).update(responseMessage).digest('hex');
    expect(responseSignature).toBe(EXPECTED.responseSignature);
    expect(vector.responseSignature).toBe(EXPECTED.responseSignature);
    expect(`v1:${vector.challenge}:${responseSignature}`).toBe(EXPECTED.responseProof);
    expect(vector.responseProof).toBe(EXPECTED.responseProof);
  });
});
