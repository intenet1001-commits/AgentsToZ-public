import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
  type RemoteControlRelayPairingBootstrap,
} from '../src/remoteControlRelayContract';
import {
  RemoteControlRelayBootstrapVault,
  type RemoteControlRelayBootstrapStorage,
} from '../src/remoteControlRelayBootstrapVault';
import {
  exportRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
} from '../src/remoteControlRelayCrypto';

const now = Date.parse('2099-08-30T12:00:00.000Z');
const hostId = 'host_12345678901';

class MemoryStorage implements RemoteControlRelayBootstrapStorage {
  records = new Map<string, unknown>();
  async read(recordKey: string) { return this.records.get(recordKey) ?? null; }
  async write(recordKey: string, value: unknown) { this.records.set(recordKey, value); }
  async delete(recordKey: string) { this.records.delete(recordKey); }
  async entries() { return [...this.records].map(([recordKey, value]) => ({ recordKey, value })); }
  async clear() { this.records.clear(); }
}

async function pairingUrl(expiresAt = '2099-08-30T12:05:00.000Z', host = hostId): Promise<string> {
  const hostKeys = await generateRemoteControlRelayKeyPair();
  const bootstrap: RemoteControlRelayPairingBootstrap = {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: host,
    pairingId: 'pairing_12345678',
    pairingSecret: encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(7)),
    hostPublicKey: await exportRemoteControlRelayPublicKey(hostKeys.publicKey),
    expiresAt,
  };
  return buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', bootstrap);
}

/**
 * Rewrites what this vault sealed as the pre-multi-host record: one entry under
 * the fixed key, without the host id or the write time. Re-sealing it here by
 * hand would test this file's crypto rather than the migration.
 */
function fileUnderLegacyKey(storage: MemoryStorage, host: string): void {
  const { hostId: _hostId, updatedAt: _updatedAt, ...envelope } = storage.records.get(host) as Record<string, unknown>;
  storage.records.clear();
  storage.records.set('pending', { ...envelope, schemaVersion: 1 });
}

describe('OAuth pairing bootstrap vault', () => {
  test('round-trips a valid fragment bootstrap without storing plaintext', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    const url = await pairingUrl();
    expect(await vault.seal(url)).toBe(hostId);
    expect(JSON.stringify(storage.records.get(hostId))).not.toContain(url);
    expect((storage.records.get(hostId) as { key: CryptoKey }).key.extractable).toBe(false);
    expect(await vault.load(hostId)).toBe(url);
    await vault.clear();
    expect(storage.records.size).toBe(0);
  });

  test('clears and rejects ciphertext or authenticated-expiry tampering', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    await vault.seal(await pairingUrl());
    const record = storage.records.get(hostId) as { ciphertext: ArrayBuffer };
    const tampered = record.ciphertext.slice(0);
    const tamperedBytes = new Uint8Array(tampered);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0x80;
    storage.records.set(hostId, { ...(storage.records.get(hostId) as object), ciphertext: tampered });
    await expect(vault.load(hostId)).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' });
    expect(storage.records.has(hostId)).toBe(false);

    await vault.seal(await pairingUrl());
    storage.records.set(hostId, { ...(storage.records.get(hostId) as object), expiresAt: '2099-08-30T12:04:00.000Z' });
    await expect(vault.load(hostId)).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' });
    expect(storage.records.has(hostId)).toBe(false);
  });

  test('expires fail-closed and removes the sealed bootstrap', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    await vault.seal(await pairingUrl('2099-08-30T12:00:01.000Z'));
    const expiredVault = new RemoteControlRelayBootstrapVault({ storage, now: () => now + 1_001 });
    expect(await expiredVault.load(hostId)).toBeNull();
    expect(storage.records.size).toBe(0);
  });

  test('keeps one sealed bootstrap per Mac instead of overwriting the first', async () => {
    // Scanning a second Mac's QR used to replace the first: both records were
    // filed under one fixed key, so a phone could only ever know one Mac.
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    const first = await pairingUrl('2099-08-30T12:05:00.000Z', 'host_first_00000001');
    const second = await pairingUrl('2099-08-30T12:05:00.000Z', 'host_second_0000002');
    await vault.seal(first);
    await vault.seal(second);
    expect(storage.records.size).toBe(2);
    expect(await vault.load('host_first_00000001')).toBe(first);
    expect(await vault.load('host_second_0000002')).toBe(second);
    expect(await vault.loadAll()).toEqual([
      { hostId: 'host_first_00000001', pairingUrl: first },
      { hostId: 'host_second_0000002', pairingUrl: second },
    ]);

    await vault.clearHost('host_first_00000001');
    expect(await vault.load('host_first_00000001')).toBeNull();
    expect(await vault.load('host_second_0000002')).toBe(second);
  });

  test('adopts a pre-multi-host record under its host id instead of dropping it', async () => {
    // An upgrading phone must not be logged out of the only Mac it had, so the
    // record sealed under the old fixed key is re-filed rather than ignored.
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    const url = await pairingUrl();
    await vault.seal(url);
    fileUnderLegacyKey(storage, hostId);

    const upgraded = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    expect(await upgraded.loadAll()).toEqual([{ hostId, pairingUrl: url }]);
    expect(storage.records.has('pending')).toBe(false);
    expect(await upgraded.load(hostId)).toBe(url);
  });

  test('drops a tampered pre-multi-host record without failing the other Macs', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    await vault.seal(await pairingUrl());
    fileUnderLegacyKey(storage, hostId);
    const legacy = storage.records.get('pending') as { ciphertext: ArrayBuffer };
    const tampered = legacy.ciphertext.slice(0);
    const tamperedBytes = new Uint8Array(tampered);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0x80;
    storage.records.set('pending', { ...(legacy as object), ciphertext: tampered });
    const survivor = await pairingUrl('2099-08-30T12:05:00.000Z', 'host_second_0000002');
    await new RemoteControlRelayBootstrapVault({ storage, now: () => now }).seal(survivor);

    const upgraded = new RemoteControlRelayBootstrapVault({ storage, now: () => now });
    expect(await upgraded.loadAll()).toEqual([{ hostId: 'host_second_0000002', pairingUrl: survivor }]);
    expect(storage.records.has('pending')).toBe(false);
  });

  test('evicts the least recently sealed Mac past the stored-host bound', async () => {
    // Without a bound the store grows one sealed record per Mac the browser
    // profile has ever met.
    const storage = new MemoryStorage();
    let clock = now;
    const vault = new RemoteControlRelayBootstrapVault({ storage, now: () => clock });
    for (let index = 0; index < 9; index += 1) {
      clock = now + index * 1_000;
      await vault.seal(await pairingUrl('2099-08-30T13:00:00.000Z', `host_bounded_00000${index}`));
    }
    expect(storage.records.size).toBe(8);
    expect(storage.records.has('host_bounded_000000')).toBe(false);
    expect(storage.records.has('host_bounded_000008')).toBe(true);
  });

  test('tracked implementation never persists the QR bootstrap in web string stores or a query', () => {
    const source = readFileSync(new URL('../src/remoteControlRelayBootstrapVault.ts', import.meta.url), 'utf8');
    const forbidden = ['local' + 'Storage', 'session' + 'Storage', 'location.' + 'search'];
    for (const token of forbidden) expect(source).not.toContain(token);
  });
});
