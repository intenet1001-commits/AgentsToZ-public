import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlCore';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  decodeRemoteControlRelayBase64Url,
  encodeRemoteControlRelayBase64Url,
  serializeRemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelopeMetadata,
} from '../src/remoteControlRelayContract';
import {
  REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES,
  RemoteControlRelayCryptoError,
  decryptRemoteControlRelayEnvelope,
  deriveRemoteControlRelaySessionKey,
  encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
  generateRemoteControlRelayHostKeyPair,
} from '../src/remoteControlRelayCrypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = Date.parse('2099-08-30T12:00:00.000Z');

function metadata(overrides: Partial<RemoteControlRelayEnvelopeMetadata> = {}): RemoteControlRelayEnvelopeMetadata {
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    messageId: 'message_123456789',
    sessionId: 'session_123456789',
    controllerId: 'controller_123456',
    sequence: 1,
    expiresAt: '2099-08-30T12:05:00.000Z',
    ...overrides,
  };
}

async function directionalKeys(direction: 'controller-to-host' | 'host-to-controller' = 'controller-to-host') {
  const host = await generateRemoteControlRelayKeyPair();
  const controller = await generateRemoteControlRelayKeyPair();
  const hostPublic = await importRemoteControlRelayPublicKey(await exportRemoteControlRelayPublicKey(host.publicKey));
  const controllerPublic = await importRemoteControlRelayPublicKey(await exportRemoteControlRelayPublicKey(controller.publicKey));
  const send = await deriveRemoteControlRelaySessionKey({
    privateKey: controller.privateKey,
    peerPublicKey: hostPublic,
    sessionId: 'session_123456789',
    controllerId: 'controller_123456',
    direction,
    usages: ['encrypt'],
  });
  const receive = await deriveRemoteControlRelaySessionKey({
    privateKey: host.privateKey,
    peerPublicKey: controllerPublic,
    sessionId: 'session_123456789',
    controllerId: 'controller_123456',
    direction,
    usages: ['decrypt'],
  });
  return { host, controller, hostPublic, controllerPublic, send, receive };
}

function tamperCiphertext(envelope: RemoteControlRelayEnvelope): RemoteControlRelayEnvelope {
  const bytes = decodeRemoteControlRelayBase64Url(envelope.ciphertext);
  bytes[0] = bytes[0]! ^ 0x80;
  return { ...envelope, ciphertext: encodeRemoteControlRelayBase64Url(bytes) };
}

describe('P-256 ECDH and HKDF-SHA256 relay session keys', () => {
  test('exports only the public point while generated and derived private material stays nonextractable', async () => {
    const pair = await generateRemoteControlRelayKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.type).toBe('private');
    expect(pair.publicKey.extractable).toBe(true);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();

    const exported = await exportRemoteControlRelayPublicKey(pair.publicKey);
    const raw = decodeRemoteControlRelayBase64Url(exported);
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
    const imported = await importRemoteControlRelayPublicKey(exported);
    expect(await exportRemoteControlRelayPublicKey(imported)).toBe(exported);
    expect(await fingerprintRemoteControlRelayPublicKey(exported)).toHaveLength(43);
    expect(await fingerprintRemoteControlRelayPublicKey(exported))
      .toBe(await fingerprintRemoteControlRelayPublicKey(exported));
  });

  test('creates persistable host keys repeatedly without exposing their private handles', async () => {
    for (let index = 0; index < 128; index += 1) {
      const host = await generateRemoteControlRelayHostKeyPair();
      expect(host.privateScalar).toHaveLength(43);
      expect(host.keyPair.privateKey.extractable).toBe(false);
      expect(await exportRemoteControlRelayPublicKey(host.keyPair.publicKey)).toBe(host.publicKey);
    }
  });

  test('derives matching directional material for opposite peers with least-privilege usages', async () => {
    const keys = await directionalKeys();
    expect(keys.send.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(keys.receive.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(keys.send.extractable).toBe(false);
    expect(keys.receive.extractable).toBe(false);
    expect(keys.send.usages).toEqual(['encrypt']);
    expect(keys.receive.usages).toEqual(['decrypt']);
  });

  test('rejects malformed public points and invalid derivation context', async () => {
    await expect(importRemoteControlRelayPublicKey('A'.repeat(43))).rejects.toMatchObject({
      code: 'INVALID_PUBLIC_KEY',
    });
    const invalidPoint = new Uint8Array(65);
    invalidPoint[0] = 0x04;
    await expect(importRemoteControlRelayPublicKey(
      encodeRemoteControlRelayBase64Url(invalidPoint),
    )).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });

    const pair = await generateRemoteControlRelayKeyPair();
    await expect(deriveRemoteControlRelaySessionKey({
      privateKey: pair.privateKey,
      peerPublicKey: pair.publicKey,
      sessionId: 'too-short',
      controllerId: 'controller_123456',
      direction: 'controller-to-host',
    })).rejects.toThrow();
  });
});

describe('AES-256-GCM external relay envelope', () => {
  test('round-trips the protocol-v4 one-use controller pairing message', async () => {
    const { send, receive } = await directionalKeys();
    const innerMessage = {
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: 'A'.repeat(43),
    };
    const encrypted = await encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata(),
      plaintext: encoder.encode(JSON.stringify(innerMessage)),
      now,
    });
    const relayVisible = serializeRemoteControlRelayEnvelope(encrypted);
    expect(relayVisible).not.toContain('controller.pair');
    expect(relayVisible).not.toContain(innerMessage.token);
    const decrypted = await decryptRemoteControlRelayEnvelope({ key: receive, envelope: encrypted, now });
    expect(JSON.parse(decoder.decode(decrypted))).toEqual(innerMessage);
  });

  test('round-trips the protocol-v4 action request while the relay sees no action or project plaintext', async () => {
    const { send, receive } = await directionalKeys();
    const innerMessage = {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: 'session-token-remains-e2e-private',
      actionId: 'start-1',
      action: 'start',
      controlId: 'session-scoped-control-id',
      remoteConfirmed: true,
    };
    const plaintext = encoder.encode(JSON.stringify(innerMessage));
    const encrypted = await encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata(),
      plaintext,
      now,
    });
    const relayVisible = serializeRemoteControlRelayEnvelope(encrypted);
    expect(Object.keys(encrypted)).toEqual([
      'schemaVersion', 'messageId', 'sessionId', 'controllerId',
      'sequence', 'expiresAt', 'nonce', 'ciphertext',
    ]);
    for (const secretText of [
      'action.request', 'agentstoz-local-v7', 'session-token-remains-e2e-private',
      'start', 'session-scoped-control-id', 'remoteConfirmed',
    ]) expect(relayVisible).not.toContain(secretText);
    expect(decodeRemoteControlRelayBase64Url(encrypted.nonce)).toHaveLength(12);

    const decrypted = await decryptRemoteControlRelayEnvelope({
      key: receive,
      envelope: encrypted,
      now,
      expected: {
        sessionId: metadata().sessionId,
        controllerId: metadata().controllerId,
        messageId: metadata().messageId,
        sequence: 1,
      },
    });
    expect(JSON.parse(decoder.decode(decrypted))).toEqual(innerMessage);
  });

  test('fails authentication for wrong AAD, wrong peer key, wrong direction, and ciphertext tampering', async () => {
    const keys = await directionalKeys();
    const plaintext = encoder.encode('{"type":"controller.pair"}');
    const encrypted = await encryptRemoteControlRelayEnvelope({
      key: keys.send,
      metadata: metadata(),
      plaintext,
      now,
    });

    await expect(decryptRemoteControlRelayEnvelope({
      key: keys.receive,
      envelope: { ...encrypted, sequence: 2 },
      now,
    })).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    await expect(decryptRemoteControlRelayEnvelope({
      key: keys.receive,
      envelope: tamperCiphertext(encrypted),
      now,
    })).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });

    const rogue = await generateRemoteControlRelayKeyPair();
    const wrongPeerKey = await deriveRemoteControlRelaySessionKey({
      privateKey: rogue.privateKey,
      peerPublicKey: keys.controllerPublic,
      sessionId: metadata().sessionId,
      controllerId: metadata().controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    await expect(decryptRemoteControlRelayEnvelope({
      key: wrongPeerKey,
      envelope: encrypted,
      now,
    })).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });

    const wrongDirection = await deriveRemoteControlRelaySessionKey({
      privateKey: keys.host.privateKey,
      peerPublicKey: keys.controllerPublic,
      sessionId: metadata().sessionId,
      controllerId: metadata().controllerId,
      direction: 'host-to-controller',
      usages: ['decrypt'],
    });
    await expect(decryptRemoteControlRelayEnvelope({
      key: wrongDirection,
      envelope: encrypted,
      now,
    })).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });

  test('fails closed on expired/context-mismatched messages and plaintext above the bounded envelope budget', async () => {
    const { send, receive } = await directionalKeys();
    const encrypted = await encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata(),
      plaintext: encoder.encode('bounded'),
      now,
    });
    await expect(decryptRemoteControlRelayEnvelope({
      key: receive,
      envelope: encrypted,
      now: Date.parse(metadata().expiresAt),
    })).rejects.toMatchObject({ code: 'ENVELOPE_EXPIRED' });
    await expect(decryptRemoteControlRelayEnvelope({
      key: receive,
      envelope: encrypted,
      now,
      expected: { controllerId: 'different_controller_1' },
    })).rejects.toMatchObject({ code: 'ENVELOPE_CONTEXT_MISMATCH' });
    await expect(encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata(),
      plaintext: new Uint8Array(REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES + 1),
      now,
    })).rejects.toMatchObject({ code: 'PLAINTEXT_TOO_LARGE' });
    await expect(encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata({ expiresAt: new Date(now).toISOString() }),
      plaintext: encoder.encode('expired'),
      now,
    })).rejects.toMatchObject({ code: 'ENVELOPE_EXPIRED' });
  });

  test('does not expose decryption-oracle details through WebCrypto failures', async () => {
    const { send, receive } = await directionalKeys();
    const encrypted = await encryptRemoteControlRelayEnvelope({
      key: send,
      metadata: metadata(),
      plaintext: encoder.encode('private'),
      now,
    });
    const promise = decryptRemoteControlRelayEnvelope({
      key: receive,
      envelope: tamperCiphertext(encrypted),
      now,
    });
    await expect(promise).rejects.toBeInstanceOf(RemoteControlRelayCryptoError);
    await expect(promise).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
      message: '릴레이 암호문 인증에 실패했습니다.',
    });
  });
});
