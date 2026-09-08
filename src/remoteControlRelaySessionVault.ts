import {
  REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION,
  type RemoteControlRelayControllerSnapshot,
} from './remoteControlRelayController';
import { isRemoteControlRelaySessionKey } from './remoteControlRelayCrypto';

const DATABASE_NAME = 'agentstoz-remote-control-session-v1';
const OBJECT_STORE_NAME = 'sealed-session';
/**
 * The one approved session used to live under this single key, so pairing a
 * second Mac silently threw away the first Mac's 30-day session. Records are
 * filed under their host id now, and this key is adopted on the first read so
 * an upgrading phone keeps the Mac it is already connected to. A host id is at
 * least 16 characters (`OPAQUE_ID_RE`), so it can never collide here.
 */
const LEGACY_RECORD_KEY = 'active';
/**
 * Bound the store so a browser profile cannot accumulate one sealed session per
 * Mac it has ever met. Eight is well past the number of Macs one phone drives,
 * and the least recently written host is evicted first — a live session is
 * re-sealed on every poll, so the Mac actually in use is never the victim.
 */
const MAX_REMEMBERED_HOSTS = 8;
const VAULT_SCHEMA_VERSION = 2 as const;
const LEGACY_VAULT_SCHEMA_VERSION = 1 as const;
const VAULT_AAD_DOMAIN = 'agentstoz.remote-control.session-vault/v1';
const AES_GCM_NONCE_BYTES = 12;
const MAX_SEALED_BYTES = 64 * 1024;
const MAX_HOST_ID_LENGTH = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type SealedSessionEnvelope = {
  expiresAt: string;
  key: CryptoKey;
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type SealedSessionRecord = SealedSessionEnvelope & {
  schemaVersion: typeof VAULT_SCHEMA_VERSION;
  hostId: string;
  updatedAt: number;
};

type LegacySealedSessionRecord = SealedSessionEnvelope & {
  schemaVersion: typeof LEGACY_VAULT_SCHEMA_VERSION;
};

type SerializableSnapshot = Omit<RemoteControlRelayControllerSnapshot, 'sendKey' | 'receiveKey'>;

export interface RemoteControlRelaySessionVaultEntry {
  hostId: string;
  snapshot: RemoteControlRelayControllerSnapshot;
}

export interface RemoteControlRelaySessionStorage {
  read(recordKey: string): Promise<unknown | null>;
  write(recordKey: string, value: unknown): Promise<void>;
  delete(recordKey: string): Promise<void>;
  entries(): Promise<Array<{ recordKey: string; value: unknown }>>;
  clear(): Promise<void>;
}

export interface RemoteControlRelaySessionVaultOptions {
  storage?: RemoteControlRelaySessionStorage;
  crypto?: Crypto;
  now?: () => number;
}

export class RemoteControlRelaySessionVaultError extends Error {
  constructor(
    readonly code: string,
    message = '원격제어 세션을 안전하게 복구하지 못했습니다. Mac에서 새 QR을 스캔해 주세요.',
  ) {
    super(message);
    this.name = 'RemoteControlRelaySessionVaultError';
  }
}

function fail(code: string, message?: string): never {
  throw new RemoteControlRelaySessionVaultError(code, message);
}

function exactArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isVaultKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === 'undefined' || !(value instanceof CryptoKey)) return false;
  const algorithm = value.algorithm as AesKeyAlgorithm;
  return value.type === 'secret'
    && value.extractable === false
    && algorithm.name === 'AES-GCM'
    && algorithm.length === 256
    && value.usages.length === 2
    && value.usages.includes('encrypt')
    && value.usages.includes('decrypt');
}

function isSealedEnvelope(record: Record<string, unknown>): boolean {
  return typeof record.expiresAt === 'string'
    && Number.isFinite(Date.parse(record.expiresAt))
    && isVaultKey(record.key)
    && isRemoteControlRelaySessionKey(record.sendKey, 'encrypt')
    && isRemoteControlRelaySessionKey(record.receiveKey, 'decrypt')
    && exactArrayBuffer(record.nonce)
    && record.nonce.byteLength === AES_GCM_NONCE_BYTES
    && exactArrayBuffer(record.ciphertext)
    && record.ciphertext.byteLength >= 16
    && record.ciphertext.byteLength <= MAX_SEALED_BYTES;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function vaultAad(expiresAt: string): ArrayBuffer {
  return arrayBuffer(encoder.encode(`${VAULT_AAD_DOMAIN}\0${expiresAt}`));
}

function cryptoApi(value?: Crypto): Crypto {
  const api = value ?? globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== 'function') return fail('WEBCRYPTO_UNAVAILABLE');
  return api;
}

function validateRecord(value: unknown): SealedSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VAULT_RECORD_INVALID');
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'hostId', 'updatedAt', 'expiresAt', 'key', 'sendKey', 'receiveKey', 'nonce', 'ciphertext'];
  if (Object.keys(record).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))
    || record.schemaVersion !== VAULT_SCHEMA_VERSION
    || typeof record.hostId !== 'string'
    || !record.hostId
    || record.hostId.length > MAX_HOST_ID_LENGTH
    || typeof record.updatedAt !== 'number'
    || !Number.isFinite(record.updatedAt)
    || !isSealedEnvelope(record)) {
    return fail('VAULT_RECORD_INVALID');
  }
  return record as SealedSessionRecord;
}

function validateLegacyRecord(value: unknown): LegacySealedSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VAULT_RECORD_INVALID');
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'expiresAt', 'key', 'sendKey', 'receiveKey', 'nonce', 'ciphertext'];
  if (Object.keys(record).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))
    || record.schemaVersion !== LEGACY_VAULT_SCHEMA_VERSION
    || !isSealedEnvelope(record)) {
    return fail('VAULT_RECORD_INVALID');
  }
  return record as LegacySealedSessionRecord;
}

function recordUpdatedAt(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0;
}

function openIndexedDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new RemoteControlRelaySessionVaultError('INDEXED_DB_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteControlRelaySessionVaultError('INDEXED_DB_UNAVAILABLE'));
    request.onblocked = () => reject(new RemoteControlRelaySessionVaultError('INDEXED_DB_BLOCKED'));
  });
}

function indexedDbRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openIndexedDb().then(database => new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    let result: T;
    let requestCompleted = false;
    let settled = false;
    const transaction = database.transaction(OBJECT_STORE_NAME, mode);
    const finish = (error?: RemoteControlRelaySessionVaultError) => {
      if (settled) return;
      settled = true;
      database.close();
      if (error) reject(error);
      else if (requestCompleted) resolve(result);
      else reject(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
    };
    try {
      request = operation(transaction.objectStore(OBJECT_STORE_NAME));
    } catch {
      finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
      return;
    }
    request.onsuccess = () => {
      result = request.result;
      requestCompleted = true;
    };
    request.onerror = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
    transaction.oncomplete = () => finish();
    transaction.onerror = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
    transaction.onabort = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
  }));
}

/**
 * Keys and values are read through one cursor rather than a `getAllKeys` plus a
 * `getAll`: two transactions can disagree while another tab of the same portal
 * is saving a session, which would pair a key with the wrong record.
 */
function indexedDbEntries(): Promise<Array<{ recordKey: string; value: unknown }>> {
  return openIndexedDb().then(database => new Promise((resolve, reject) => {
    const entries: Array<{ recordKey: string; value: unknown }> = [];
    let settled = false;
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
    const finish = (error?: RemoteControlRelaySessionVaultError) => {
      if (settled) return;
      settled = true;
      database.close();
      if (error) reject(error);
      else resolve(entries);
    };
    let request: IDBRequest<IDBCursorWithValue | null>;
    try {
      request = transaction.objectStore(OBJECT_STORE_NAME).openCursor();
    } catch {
      finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
      return;
    }
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string') entries.push({ recordKey: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
    transaction.oncomplete = () => finish();
    transaction.onerror = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
    transaction.onabort = () => finish(new RemoteControlRelaySessionVaultError('INDEXED_DB_FAILED'));
  }));
}

export function createIndexedDbRemoteControlRelaySessionStorage(): RemoteControlRelaySessionStorage {
  return {
    async read(recordKey: string) {
      const value = await indexedDbRequest('readonly', store => store.get(recordKey));
      return value ?? null;
    },
    async write(recordKey: string, value: unknown) {
      await indexedDbRequest('readwrite', store => store.put(value, recordKey));
    },
    async delete(recordKey: string) {
      await indexedDbRequest('readwrite', store => store.delete(recordKey));
    },
    entries() {
      return indexedDbEntries();
    },
    async clear() {
      await indexedDbRequest('readwrite', store => store.clear());
    },
  };
}

export class RemoteControlRelaySessionVault {
  readonly #storage: RemoteControlRelaySessionStorage;
  readonly #crypto: Crypto;
  readonly #now: () => number;
  #legacyAdopted = false;

  constructor(options: RemoteControlRelaySessionVaultOptions = {}) {
    this.#storage = options.storage ?? createIndexedDbRemoteControlRelaySessionStorage();
    this.#crypto = cryptoApi(options.crypto);
    this.#now = options.now ?? Date.now;
  }

  async save(snapshot: RemoteControlRelayControllerSnapshot): Promise<void> {
    const hostId = snapshot?.claim?.hostId;
    if (snapshot.schemaVersion !== REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION
      || typeof hostId !== 'string' || !hostId || hostId.length > MAX_HOST_ID_LENGTH
      || !isRemoteControlRelaySessionKey(snapshot.sendKey, 'encrypt')
      || !isRemoteControlRelaySessionKey(snapshot.receiveKey, 'decrypt')) {
      return fail('SESSION_INVALID');
    }
    const expiresAtMs = Date.parse(snapshot.claim.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.#now()) {
      await this.#storage.delete(hostId).catch(() => undefined);
      return fail('SESSION_EXPIRED');
    }
    const expiresAt = new Date(expiresAtMs).toISOString();
    const { sendKey, receiveKey, ...serializable } = snapshot;
    const plaintext = encoder.encode(JSON.stringify(serializable satisfies SerializableSnapshot));
    if (plaintext.byteLength > MAX_SEALED_BYTES - 16) return fail('SESSION_TOO_LARGE');
    const key = await this.#crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const nonce = this.#crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
    const ciphertext = await this.#crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(nonce),
        additionalData: vaultAad(expiresAt),
        tagLength: 128,
      },
      key,
      arrayBuffer(plaintext),
    );
    await this.#storage.write(hostId, {
      schemaVersion: VAULT_SCHEMA_VERSION,
      hostId,
      updatedAt: this.#now(),
      expiresAt,
      key,
      sendKey,
      receiveKey,
      nonce: arrayBuffer(nonce),
      ciphertext,
    } satisfies SealedSessionRecord);
    await this.#evictLeastRecentlyWritten(hostId);
  }

  async load(hostId: string): Promise<RemoteControlRelayControllerSnapshot | null> {
    await this.#adoptLegacyRecord();
    const stored = await this.#storage.read(hostId);
    if (stored === null) return null;
    try {
      const record = validateRecord(stored);
      if (Date.parse(record.expiresAt) <= this.#now()) {
        await this.#storage.delete(hostId);
        return null;
      }
      const plaintext = await this.#unseal(record);
      const value = JSON.parse(decoder.decode(plaintext)) as SerializableSnapshot;
      // The record key is not authenticated by the AAD, so a session moved to
      // another host's key must be refused rather than resumed against it.
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schemaVersion !== REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION
        || value.claim?.expiresAt !== record.expiresAt
        || value.claim?.hostId !== hostId
        || record.hostId !== hostId) {
        return fail('VAULT_CONTEXT_MISMATCH');
      }
      return { ...value, sendKey: record.sendKey, receiveKey: record.receiveKey };
    } catch (error) {
      await this.#storage.delete(hostId).catch(() => undefined);
      if (error instanceof RemoteControlRelaySessionVaultError) throw error;
      return fail('VAULT_DECRYPT_FAILED');
    }
  }

  /**
   * One unreadable or expired Mac must not take the others down with it: its
   * record is dropped and every session that still opens is returned.
   */
  async loadAll(): Promise<RemoteControlRelaySessionVaultEntry[]> {
    await this.#adoptLegacyRecord();
    const entries: RemoteControlRelaySessionVaultEntry[] = [];
    for (const entry of await this.#storage.entries()) {
      if (entry.recordKey === LEGACY_RECORD_KEY) continue;
      const snapshot = await this.load(entry.recordKey).catch(() => null);
      if (snapshot) entries.push({ hostId: entry.recordKey, snapshot });
    }
    return entries;
  }

  async hasActive(): Promise<boolean> {
    return (await this.loadAll()).length > 0;
  }

  async clearHost(hostId: string): Promise<void> {
    await this.#storage.delete(hostId);
  }

  async clear(): Promise<void> {
    await this.#storage.clear();
  }

  async #unseal(record: SealedSessionEnvelope): Promise<ArrayBuffer> {
    return this.#crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: record.nonce,
        additionalData: vaultAad(record.expiresAt),
        tagLength: 128,
      },
      record.key,
      record.ciphertext,
    );
  }

  /**
   * Re-file the legacy record under its host id without decrypting and
   * re-sealing it: the key, session keys, nonce, ciphertext and AAD move across
   * untouched, so the resumed session keeps its exact replay cursors.
   */
  async #adoptLegacyRecord(): Promise<void> {
    if (this.#legacyAdopted) return;
    const stored = await this.#storage.read(LEGACY_RECORD_KEY);
    if (stored === null) {
      this.#legacyAdopted = true;
      return;
    }
    let migrated: SealedSessionRecord | null = null;
    try {
      const record = validateLegacyRecord(stored);
      const value = JSON.parse(decoder.decode(await this.#unseal(record))) as SerializableSnapshot;
      const hostId = value?.claim?.hostId;
      if (value?.claim?.expiresAt === record.expiresAt
        && typeof hostId === 'string' && hostId && hostId.length <= MAX_HOST_ID_LENGTH
        && Date.parse(record.expiresAt) > this.#now()) {
        migrated = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          hostId,
          updatedAt: this.#now(),
          expiresAt: record.expiresAt,
          key: record.key,
          sendKey: record.sendKey,
          receiveKey: record.receiveKey,
          nonce: record.nonce,
          ciphertext: record.ciphertext,
        };
      }
    } catch {
      // A tampered or expired legacy record can never be adopted; it is only
      // removed. A failing store instead throws below, keeping the legacy
      // record so the next load retries the migration.
    }
    if (migrated) await this.#storage.write(migrated.hostId, migrated);
    await this.#storage.delete(LEGACY_RECORD_KEY);
    this.#legacyAdopted = true;
  }

  async #evictLeastRecentlyWritten(keep: string): Promise<void> {
    const others = (await this.#storage.entries())
      .filter(entry => entry.recordKey !== LEGACY_RECORD_KEY && entry.recordKey !== keep);
    const excess = others.length + 1 - MAX_REMEMBERED_HOSTS;
    if (excess <= 0) return;
    // A record with no readable `updatedAt` sorts oldest, so a broken entry is
    // evicted before a working Mac.
    const ordered = others
      .map(entry => ({ recordKey: entry.recordKey, updatedAt: recordUpdatedAt(entry.value) }))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const victim of ordered.slice(0, excess)) {
      await this.#storage.delete(victim.recordKey);
    }
  }
}
