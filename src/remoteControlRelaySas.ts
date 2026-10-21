import {
  REMOTE_CONTROL_RELAY_PAIRING_SECRET_BYTES,
  REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES,
  decodeRemoteControlRelayBase64Url,
} from './remoteControlRelayContract';
import { importRemoteControlRelayPublicKey } from './remoteControlRelayCrypto';

const SAS_DOMAIN = 'agentstoz.remote-control.relay/sas/v1';
const encoder = new TextEncoder();

export interface RemoteControlRelaySasInput {
  hostPublicKey: string;
  controllerPublicKey: string;
  pairingSecret: string;
  crypto?: Crypto;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Six digits shown on both the Mac and controller before explicit approval.
 * Role ordering is fixed, so a reflected or swapped public key yields a
 * different code. This is an approval aid; transport authentication remains
 * the one-use pairing proof plus ECDH/AES-GCM.
 */
export async function remoteControlRelaySasCode(input: RemoteControlRelaySasInput): Promise<string> {
  const api = input.crypto ?? globalThis.crypto;
  if (!api?.subtle) throw new Error('REMOTE_CONTROL_WEBCRYPTO_UNAVAILABLE');
  const host = decodeRemoteControlRelayBase64Url(input.hostPublicKey, 'host public key');
  const controller = decodeRemoteControlRelayBase64Url(input.controllerPublicKey, 'controller public key');
  const pairingSecret = decodeRemoteControlRelayBase64Url(input.pairingSecret, 'pairing secret');
  if (host.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES
    || controller.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES
    || pairingSecret.byteLength !== REMOTE_CONTROL_RELAY_PAIRING_SECRET_BYTES) {
    throw new Error('REMOTE_CONTROL_SAS_INPUT_INVALID');
  }
  await Promise.all([
    importRemoteControlRelayPublicKey(input.hostPublicKey),
    importRemoteControlRelayPublicKey(input.controllerPublicKey),
  ]);
  const material = concatBytes(
    encoder.encode(`${SAS_DOMAIN}\0host\0`),
    host,
    encoder.encode('\0controller\0'),
    controller,
    encoder.encode('\0pairing\0'),
    pairingSecret,
  );
  const digest = new Uint8Array(await api.subtle.digest('SHA-256', material.slice().buffer));
  const value = ((((digest[0]! << 16) | (digest[1]! << 8) | digest[2]!) >>> 0) % 1_000_000);
  return String(value).padStart(6, '0');
}
