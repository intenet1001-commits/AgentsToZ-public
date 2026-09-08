import { describe, expect, test } from 'bun:test';
import {
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';
import {
  exportRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
} from '../src/remoteControlRelayCrypto';
import { remoteControlRelaySasCode } from '../src/remoteControlRelaySas';

describe('explicit controller approval SAS', () => {
  test('is stable on both peers and changes for key, role, or one-use secret changes', async () => {
    const host = await generateRemoteControlRelayKeyPair();
    const controller = await generateRemoteControlRelayKeyPair();
    const other = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controller.publicKey);
    const otherPublicKey = await exportRemoteControlRelayPublicKey(other.publicKey);
    const pairingSecret = encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(4));
    const input = { hostPublicKey, controllerPublicKey, pairingSecret };
    const first = await remoteControlRelaySasCode(input);
    expect(first).toMatch(/^\d{6}$/);
    expect(await remoteControlRelaySasCode(input)).toBe(first);
    expect(await remoteControlRelaySasCode({ ...input, controllerPublicKey: otherPublicKey })).not.toBe(first);
    expect(await remoteControlRelaySasCode({
      hostPublicKey: controllerPublicKey,
      controllerPublicKey: hostPublicKey,
      pairingSecret,
    })).not.toBe(first);
    expect(await remoteControlRelaySasCode({
      ...input,
      pairingSecret: encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(5)),
    })).not.toBe(first);
  });

  test('rejects malformed public key and short pairing proof', async () => {
    const pair = await generateRemoteControlRelayKeyPair();
    const publicKey = await exportRemoteControlRelayPublicKey(pair.publicKey);
    await expect(remoteControlRelaySasCode({
      hostPublicKey: publicKey,
      controllerPublicKey: 'A'.repeat(87),
      pairingSecret: encodeRemoteControlRelayBase64Url(new Uint8Array(32)),
    })).rejects.toThrow();
    await expect(remoteControlRelaySasCode({
      hostPublicKey: publicKey,
      controllerPublicKey: publicKey,
      pairingSecret: encodeRemoteControlRelayBase64Url(new Uint8Array(16)),
    })).rejects.toThrow();
  });
});
