import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';
import {
  RemoteControlRelayController,
  type RemoteControlRelayControllerSnapshot,
  type RemoteControlRelayControllerTransport,
} from '../src/remoteControlRelayController';
import {
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
} from '../src/remoteControlRelayCrypto';
import {
  RemoteControlRelaySessionVault,
  type RemoteControlRelaySessionStorage,
} from '../src/remoteControlRelaySessionVault';

const now = Date.parse('2099-08-30T12:00:00.000Z');
const expiresAt = '2099-08-30T12:30:00.000Z';
const hostId = '11111111-1111-4111-8111-111111111111';

class MemoryStorage implements RemoteControlRelaySessionStorage {
  records = new Map<string, unknown>();
  async read(recordKey: string) { return this.records.get(recordKey) ?? null; }
  async write(recordKey: string, value: unknown) { this.records.set(recordKey, value); }
  async delete(recordKey: string) { this.records.delete(recordKey); }
  async entries() { return [...this.records].map(([recordKey, value]) => ({ recordKey, value })); }
  async clear() { this.records.clear(); }
}

async function pendingController(host = hostId) {
  const hostKeys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
  const transport: RemoteControlRelayControllerTransport = {
    async claimPairing(input) {
      expect(input.controllerPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
      return {
        sessionId: '33333333-3333-4333-8333-333333333333',
        controllerId: '44444444-4444-4444-8444-444444444444',
        hostId: host,
        hostName: '내 Mac',
        hostPublicKey,
        hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
        approvalState: 'pending',
        expiresAt,
      };
    },
    async status() {
      return {
        sessionId: '33333333-3333-4333-8333-333333333333',
        controllerId: '44444444-4444-4444-8444-444444444444',
        approvalState: 'pending',
        hostEnabled: true,
        hostExpiresAt: expiresAt,
        sessionExpiresAt: expiresAt,
        revokedAt: null,
        hostLastSeenAt: null,
      };
    },
    async sendEnvelope() {},
    async receiveEnvelopes() { return []; },
    async acknowledge() {},
    async revoke() {},
  };
  const controller = new RemoteControlRelayController({
    transport,
    controllerName: '내 iPhone',
    pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
      hostId: host,
      pairingId: '22222222-2222-4222-8222-222222222222',
      pairingSecret: encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(7)),
      hostPublicKey,
      expiresAt: '2099-08-30T12:05:00.000Z',
    }),
    now: () => now,
  });
  await controller.initialize();
  return { controller, transport };
}

/**
 * Rewrites what this vault sealed as the pre-multi-host record: the one session
 * under the fixed key, without the host id or the write time. Re-sealing it
 * here by hand would test this file's crypto rather than the migration.
 */
function fileUnderLegacyKey(storage: MemoryStorage, host: string): void {
  const { hostId: _hostId, updatedAt: _updatedAt, ...envelope } = storage.records.get(host) as Record<string, unknown>;
  storage.records.clear();
  storage.records.set('active', { ...envelope, schemaVersion: 1 });
}

describe('hosted remote-control active session vault', () => {
  test('seals keys, token context, and replay cursors without plaintext and restores the controller', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelaySessionVault({ storage, now: () => now });
    const { controller, transport } = await pendingController();
    const snapshot = controller.snapshot();
    expect(snapshot).not.toBeNull();
    await vault.save(snapshot!);
    expect(JSON.stringify(storage.records.get(hostId))).not.toContain('내 Mac');
    expect(JSON.stringify(storage.records.get(hostId))).not.toContain(snapshot!.pairingUrl);
    expect((storage.records.get(hostId) as { key: CryptoKey }).key.extractable).toBe(false);
    expect((storage.records.get(hostId) as { sendKey: CryptoKey }).sendKey.extractable).toBe(false);

    const restored = await vault.load(hostId);
    expect(restored).not.toBeNull();
    const resumed = new RemoteControlRelayController({
      transport,
      controllerName: '내 iPhone',
      restoredSession: restored,
      now: () => now,
    });
    expect(resumed.status()).toMatchObject({ state: 'approval-required', hostName: '내 Mac' });
    await expect(resumed.refresh()).resolves.toMatchObject({ state: 'approval-required' });
  });

  test('rejects a restored session that claims both a control action and Codex task are pending', async () => {
    const { controller, transport } = await pendingController();
    const snapshot = controller.snapshot()!;
    expect(() => new RemoteControlRelayController({
      transport,
      controllerName: '내 iPhone',
      restoredSession: {
        ...snapshot,
        pendingActionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        pendingTaskOperationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      now: () => now,
    })).toThrow('REMOTE_CONTROL_RESTORE_INVALID');
  });

  test('expires or clears authenticated ciphertext tampering instead of returning a partial session', async () => {
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelaySessionVault({ storage, now: () => now });
    const { controller } = await pendingController();
    await vault.save(controller.snapshot()!);
    const record = storage.records.get(hostId) as { ciphertext: ArrayBuffer };
    const tampered = record.ciphertext.slice(0);
    const tamperedBytes = new Uint8Array(tampered);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0x80;
    storage.records.set(hostId, { ...(storage.records.get(hostId) as object), ciphertext: tampered });
    await expect(vault.load(hostId)).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' });
    expect(storage.records.has(hostId)).toBe(false);

    await vault.save(controller.snapshot()!);
    const expired = new RemoteControlRelaySessionVault({ storage, now: () => Date.parse(expiresAt) });
    expect(await expired.load(hostId)).toBeNull();
    expect(storage.records.size).toBe(0);
  });

  test('keeps one approved session per Mac and drops only the Mac that is disconnected', async () => {
    // Both sessions used to share the fixed 'active' key, so pairing a second
    // Mac threw away the first Mac's 30-day session on the spot.
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelaySessionVault({ storage, now: () => now });
    const second = '55555555-5555-4555-8555-555555555555';
    const first = await pendingController();
    const other = await pendingController(second);
    await vault.save(first.controller.snapshot()!);
    await vault.save(other.controller.snapshot()!);
    expect(storage.records.size).toBe(2);
    expect((await vault.loadAll()).map(entry => entry.hostId)).toEqual([hostId, second]);

    await vault.clearHost(hostId);
    expect(await vault.load(hostId)).toBeNull();
    expect((await vault.load(second))?.claim.hostId).toBe(second);
  });

  test('adopts a pre-multi-host session under its host id instead of dropping it', async () => {
    // The upgrade must not disconnect the Mac the phone is already paired to.
    const storage = new MemoryStorage();
    const vault = new RemoteControlRelaySessionVault({ storage, now: () => now });
    const { controller } = await pendingController();
    await vault.save(controller.snapshot()!);
    fileUnderLegacyKey(storage, hostId);

    const upgraded = new RemoteControlRelaySessionVault({ storage, now: () => now });
    const restored = await upgraded.loadAll();
    expect(restored.map(entry => entry.hostId)).toEqual([hostId]);
    expect(restored[0]!.snapshot.claim.hostId).toBe(hostId);
    expect(storage.records.has('active')).toBe(false);
  });

  test('evicts the least recently written Mac past the stored-host bound', async () => {
    const storage = new MemoryStorage();
    let clock = now;
    const vault = new RemoteControlRelaySessionVault({ storage, now: () => clock });
    const { controller } = await pendingController();
    const base = controller.snapshot()!;
    for (let index = 0; index < 9; index += 1) {
      clock = now + index * 1_000;
      await vault.save({
        ...base,
        claim: { ...base.claim, hostId: `bounded-host-0000000${index}` },
      } satisfies RemoteControlRelayControllerSnapshot);
    }
    expect(storage.records.size).toBe(8);
    expect(storage.records.has('bounded-host-00000000')).toBe(false);
    expect(storage.records.has('bounded-host-00000008')).toBe(true);
  });

  test('never stores the live session in string web storage', () => {
    const source = readFileSync(new URL('../src/remoteControlRelaySessionVault.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('local' + 'Storage');
    expect(source).not.toContain('session' + 'Storage');
  });
});
