import { describe, expect, test } from 'bun:test';

import {
  clearAgentRuntimePendingRequest,
  digestAgentRuntimeStartIntent,
  persistAgentRuntimePendingRequest,
  recoverAgentRuntimePendingRequestId,
  type AgentRuntimePendingStartStorage,
} from '../src/agentRuntimePendingStart';

const LEGACY_STORAGE_KEY = 'agentstoz.agent-runtime.pending-start.v1';
const STORAGE_KEY = 'agentstoz.agent-runtime.pending-start.v2';
const TTL_MS = 24 * 60 * 60_000;

function memoryStorage(): AgentRuntimePendingStartStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

describe('Agent Runtime pending start receipts', () => {
  test('recovers A after A -> B -> A without persisting raw prompt or model', async () => {
    const storage = memoryStorage();
    const prompt = '아직 공개하지 않은 요청';
    const model = 'private-model-selection';
    const firstDigest = await digestAgentRuntimeStartIntent(JSON.stringify([
      'target_12345678', 'codex', model, 'workspace-write', prompt,
    ]));
    const secondDigest = await digestAgentRuntimeStartIntent(JSON.stringify([
      'target_12345678', 'codex', 'another-model', 'workspace-write', prompt,
    ]));

    persistAgentRuntimePendingRequest(storage, firstDigest, 'request_first_12345678', 1_000);
    persistAgentRuntimePendingRequest(storage, secondDigest, 'request_second_12345678', 2_000);

    expect(recoverAgentRuntimePendingRequestId(storage, firstDigest, 3_000))
      .toBe('request_first_12345678');
    expect(recoverAgentRuntimePendingRequestId(storage, secondDigest, 3_000))
      .toBe('request_second_12345678');
    const persisted = [...storage.values.values()].join('');
    expect(persisted).not.toContain(prompt);
    expect(persisted).not.toContain(model);
  });

  test('clear removes only the matching request and preserves other digests', async () => {
    const storage = memoryStorage();
    const firstDigest = await digestAgentRuntimeStartIntent('first intent');
    const secondDigest = await digestAgentRuntimeStartIntent('second intent');
    persistAgentRuntimePendingRequest(storage, firstDigest, 'request_first_12345678', 1_000);
    persistAgentRuntimePendingRequest(storage, secondDigest, 'request_second_12345678', 2_000);

    clearAgentRuntimePendingRequest(storage, 'request_second_12345678');

    expect(recoverAgentRuntimePendingRequestId(storage, firstDigest, 3_000))
      .toBe('request_first_12345678');
    expect(recoverAgentRuntimePendingRequestId(storage, secondDigest, 3_000)).toBeNull();
  });

  test('expires receipts independently after 24 hours', async () => {
    const storage = memoryStorage();
    const staleDigest = await digestAgentRuntimeStartIntent('stale intent');
    const currentDigest = await digestAgentRuntimeStartIntent('current intent');
    persistAgentRuntimePendingRequest(storage, staleDigest, 'request_stale_12345678', 1_000);
    persistAgentRuntimePendingRequest(storage, currentDigest, 'request_current_12345678', 2_000);

    const now = TTL_MS + 1_001;
    expect(recoverAgentRuntimePendingRequestId(storage, staleDigest, now)).toBeNull();
    expect(recoverAgentRuntimePendingRequestId(storage, currentDigest, now))
      .toBe('request_current_12345678');
  });

  test('rejects and cleans a receipt dated in the future', async () => {
    const storage = memoryStorage();
    const digest = await digestAgentRuntimeStartIntent('future intent');
    storage.values.set(STORAGE_KEY, JSON.stringify({
      version: 2,
      receipts: [{
        intentDigest: digest,
        requestId: 'request_future_12345678',
        createdAt: 3_000,
      }],
    }));

    expect(recoverAgentRuntimePendingRequestId(storage, digest, 2_000)).toBeNull();
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
  });

  test('bounds the receipt map at 16 and evicts the oldest receipt', () => {
    const storage = memoryStorage();
    const digests = Array.from({ length: 17 }, (_, index) => index.toString(16).padStart(64, '0'));
    for (const [index, digest] of digests.entries()) {
      persistAgentRuntimePendingRequest(
        storage,
        digest,
        `request_cap_${String(index).padStart(8, '0')}`,
        1_000 + index,
      );
    }

    expect(recoverAgentRuntimePendingRequestId(storage, digests[0]!, 2_000)).toBeNull();
    for (let index = 1; index < digests.length; index += 1) {
      expect(recoverAgentRuntimePendingRequestId(storage, digests[index]!, 2_000))
        .toBe(`request_cap_${String(index).padStart(8, '0')}`);
    }
    const stored = JSON.parse(storage.values.get(STORAGE_KEY) ?? 'null') as { receipts?: unknown[] };
    expect(stored.receipts).toHaveLength(16);
  });

  test('migrates a valid v1 receipt on recovery only after v2 is written', async () => {
    const storage = memoryStorage();
    const digest = await digestAgentRuntimeStartIntent('legacy recovery');
    storage.values.set(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1,
      intentDigest: digest,
      requestId: 'request_legacy_12345678',
      createdAt: 1_000,
    }));

    expect(recoverAgentRuntimePendingRequestId(storage, digest, 2_000))
      .toBe('request_legacy_12345678');
    expect(storage.values.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect(JSON.parse(storage.values.get(STORAGE_KEY) ?? 'null')).toMatchObject({
      version: 2,
      receipts: [{ intentDigest: digest, requestId: 'request_legacy_12345678', createdAt: 1_000 }],
    });
  });

  test('preserves a v1 receipt while persist migrates it alongside a new digest', async () => {
    const storage = memoryStorage();
    const legacyDigest = await digestAgentRuntimeStartIntent('legacy persisted intent');
    const newDigest = await digestAgentRuntimeStartIntent('new persisted intent');
    storage.values.set(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1,
      intentDigest: legacyDigest,
      requestId: 'request_legacy_12345678',
      createdAt: 1_000,
    }));

    persistAgentRuntimePendingRequest(storage, newDigest, 'request_new_12345678', 2_000);

    expect(storage.values.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect(recoverAgentRuntimePendingRequestId(storage, legacyDigest, 3_000))
      .toBe('request_legacy_12345678');
    expect(recoverAgentRuntimePendingRequestId(storage, newDigest, 3_000))
      .toBe('request_new_12345678');
  });

  test('does not delete the v1 receipt when recovery migration cannot commit', async () => {
    const storage = memoryStorage();
    const digest = await digestAgentRuntimeStartIntent('legacy interrupted migration');
    storage.values.set(LEGACY_STORAGE_KEY, JSON.stringify({
      version: 1,
      intentDigest: digest,
      requestId: 'request_legacy_12345678',
      createdAt: 1_000,
    }));
    const failingStorage: AgentRuntimePendingStartStorage = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem: (key, value) => {
        if (key === STORAGE_KEY) throw new Error('quota');
        storage.setItem(key, value);
      },
    };

    expect(recoverAgentRuntimePendingRequestId(failingStorage, digest, 2_000))
      .toBe('request_legacy_12345678');
    expect(storage.values.has(LEGACY_STORAGE_KEY)).toBe(true);
  });

  test('fails closed and cleans corrupt current-version storage', async () => {
    const digest = await digestAgentRuntimeStartIntent('untrusted stored intent');
    for (const invalid of [
      '{bad json',
      JSON.stringify({
        version: 2,
        receipts: [{
          intentDigest: digest,
          requestId: 'request_invalid_12345678',
          createdAt: 1_000,
          prompt: 'must not be accepted',
        }],
      }),
    ]) {
      const storage = memoryStorage();
      storage.values.set(STORAGE_KEY, invalid);
      expect(recoverAgentRuntimePendingRequestId(storage, digest, 2_000)).toBeNull();
      expect(storage.values.has(STORAGE_KEY)).toBe(false);
    }
  });

  test('preserves a future storage version instead of destroying unknown receipts', async () => {
    const storage = memoryStorage();
    const digest = await digestAgentRuntimeStartIntent('future storage version');
    const future = JSON.stringify({
      version: 3,
      receipts: [{
        intentDigest: digest,
        requestId: 'request_future_12345678',
        createdAt: 1_000,
        futureField: true,
      }],
    });
    storage.values.set(STORAGE_KEY, future);

    expect(recoverAgentRuntimePendingRequestId(storage, digest, 2_000)).toBeNull();
    expect(() => persistAgentRuntimePendingRequest(
      storage,
      digest,
      'request_current_12345678',
      2_000,
    )).toThrow();
    clearAgentRuntimePendingRequest(storage, 'request_future_12345678');
    expect(storage.values.get(STORAGE_KEY)).toBe(future);
  });
});
