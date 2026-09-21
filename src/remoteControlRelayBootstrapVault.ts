import {
  isRemoteControlRelayPairingExpired,
  parseRemoteControlRelayPairingUrl,
} from './remoteControlRelayContract';

const DATABASE_NAME = 'agentstoz-remote-control-bootstrap-v1';
const OBJECT_STORE_NAME = 'sealed-bootstrap';
/**
 * Every sealed bootstrap used to live under this single key, so scanning a
 * second Mac's QR silently replaced the first. Records are filed under their
 * host id now, and this key is adopted on the first read rather than ignored —
 * ignoring it would log an upgrading phone out of the only Mac it had. A host
 * id is at least 16 characters (`OPAQUE_ID_RE`), so it can never collide here.
 */
const LEGACY_RECORD_KEY = 'pending';
/**
 * Bound the store so a browser profile cannot accumulate one sealed record per
 * Mac it has ever met. Eight is well past the number of Macs one phone drives,
 * and the least recently written host is evicted first.
 */
const MAX_REMEMBERED_HOSTS = 8;
const VAULT_SCHEMA_VERSION = 2 as const;
const LEGACY_VAULT_SCHEMA_VERSION = 1 as const;
const VAULT_AAD_DOMAIN = 'agentstoz.remote-control.bootstrap-vault/v1';
const AES_GCM_NONCE_BYTES = 12;
const MAX_SEALED_BYTES = 8 * 1024;
const MAX_HOST_ID_LENGTH = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type SealedBootstrapEnvelope = {
  expiresAt: string;
  key: CryptoKey;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type SealedBootstrapRecord = SealedBootstrapEnvelope & {
  schemaVersion: typeof VAULT_SCHEMA_VERSION;
  hostId: string;
  updatedAt: number;
};

type LegacySealedBootstrapRecord = SealedBootstrapEnvelope & {
  schemaVersion: typeof LEGACY_VAULT_SCHEMA_VERSION;
};

export interface RemoteControlRelayBootstrapVaultEntry {
  hostId: string;
  pairingUrl: string;
}

export interface RemoteControlRelayBootstrapStorage {
  read(recordKey: string): Promise<unknown | null>;
  write(recordKey: string, value: unknown): Promise<void>;
  delete(recordKey: string): Promise<void>;
  entries(): Promise<Array<{ recordKey: string; value: unknown }>>;
  clear(): Promise<void>;
}

export interface RemoteControlRelayBootstrapVaultOptions {
  storage?: RemoteControlRelayBootstrapStorage;
  crypto?: Crypto;
  now?: () => number;
}

export class RemoteControlRelayBootstrapVaultError extends Error {
  constructor(
    readonly code: string,
    message = 'QR 연결 정보를 안전하게 보관하지 못했습니다. 새 QR을 스캔해 주세요.',
  ) {
    super(message);
    this.name = 'RemoteControlRelayBootstrapVaultError';
  }
}

function fail(code: string, message?: string): never {
  throw new RemoteControlRelayBootstrapVaultError(code, message);
}

function exactArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isAesGcmVaultKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === 'undefined' || !(value instanceof CryptoKey)) return false;
  const algorithm = value.algorithm as AesKeyAlgorithm;
  return value.type === 'secret'
    && value.extractable === false
    && algorithm.name === 'AES-GCM'
    && algorithm.length === 256
    && value.usages.includes('decrypt');
}

function isSealedEnvelope(record: Record<string, unknown>): boolean {
  return typeof record.expiresAt === 'string'
    && Number.isFinite(Date.parse(record.expiresAt))
    && isAesGcmVaultKey(record.key)
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
  if (!api?.subtle || typeof api.getRandomValues !== 'function') {
    return fail('WEBCRYPTO_UNAVAILABLE');
  }
  return api;
}

function validateRecord(value: unknown): SealedBootstrapRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VAULT_RECORD_INVALID');
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'hostId', 'updatedAt', 'expiresAt', 'key', 'nonce', 'ciphertext'];
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
  return record as SealedBootstrapRecord;
}

function validateLegacyRecord(value: unknown): LegacySealedBootstrapRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VAULT_RECORD_INVALID');
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'expiresAt', 'key', 'nonce', 'ciphertext'];
  if (Object.keys(record).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))
    || record.schemaVersion !== LEGACY_VAULT_SCHEMA_VERSION
    || !isSealedEnvelope(record)) {
    return fail('VAULT_RECORD_INVALID');
  }
  return record as LegacySealedBootstrapRecord;
}

function recordUpdatedAt(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0;
}

function openIndexedDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_UNAVAILABLE'));
    request.onblocked = () => reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_BLOCKED'));
  });
}

function indexedDbRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openIndexedDb().then(database => new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      request = operation(database.transaction(OBJECT_STORE_NAME, mode).objectStore(OBJECT_STORE_NAME));
    } catch {
      database.close();
      reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_FAILED'));
      return;
    }
    request.onsuccess = () => {
      const result = request.result;
      database.close();
      resolve(result);
    };
    request.onerror = () => {
      database.close();
      reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_FAILED'));
    };
  }));
}

/**
 * Keys and values are read through one cursor rather than a `getAllKeys` plus
 * a `getAll`: two transactions can disagree while another tab of the same
 * portal is sealing a host, which would pair a key with the wrong record.
 */
function indexedDbEntries(): Promise<Array<{ recordKey: string; value: unknown }>> {
  return openIndexedDb().then(database => new Promise((resolve, reject) => {
    const entries: Array<{ recordKey: string; value: unknown }> = [];
    let request: IDBRequest<IDBCursorWithValue | null>;
    try {
      request = database.transaction(OBJECT_STORE_NAME, 'readonly').objectStore(OBJECT_STORE_NAME).openCursor();
    } catch {
      database.close();
      reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_FAILED'));
      return;
    }
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        database.close();
        resolve(entries);
        return;
      }
      if (typeof cursor.key === 'string') entries.push({ recordKey: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => {
      database.close();
      reject(new RemoteControlRelayBootstrapVaultError('INDEXED_DB_FAILED'));
    };
  }));
}

export function createIndexedDbRemoteControlRelayBootstrapStorage(): RemoteControlRelayBootstrapStorage {
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

export class RemoteControlRelayBootstrapVault {
  readonly #storage: RemoteControlRelayBootstrapStorage;
  readonly #crypto: Crypto;
  readonly #now: () => number;
  #legacyAdopted = false;

  constructor(options: RemoteControlRelayBootstrapVaultOptions = {}) {
    this.#storage = options.storage ?? createIndexedDbRemoteControlRelayBootstrapStorage();
    this.#crypto = cryptoApi(options.crypto);
    this.#now = options.now ?? Date.now;
  }

  async seal(pairingUrl: string): Promise<string> {
    const parsed = parseRemoteControlRelayPairingUrl(pairingUrl);
    const hostId = parsed.bootstrap.hostId;
    if (isRemoteControlRelayPairingExpired(parsed.bootstrap, this.#now())) {
      await this.#storage.delete(hostId).catch(() => undefined);
      return fail('PAIRING_EXPIRED', 'QR 연결 시간이 만료되었습니다. 새 QR을 스캔해 주세요.');
    }
    const plaintext = encoder.encode(pairingUrl);
    if (plaintext.byteLength > MAX_SEALED_BYTES - 16) return fail('PAIRING_URL_TOO_LARGE');
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
        additionalData: vaultAad(parsed.bootstrap.expiresAt),
        tagLength: 128,
      },
      key,
      arrayBuffer(plaintext),
    );
    await this.#storage.write(hostId, {
      schemaVersion: VAULT_SCHEMA_VERSION,
      hostId,
      updatedAt: this.#now(),
      expiresAt: parsed.bootstrap.expiresAt,
      key,
      nonce: arrayBuffer(nonce),
      ciphertext,
    } satisfies SealedBootstrapRecord);
    await this.#evictLeastRecentlyWritten(hostId);
    return hostId;
  }

  async load(hostId: string): Promise<string | null> {
    await this.#adoptLegacyRecord();
    const stored = await this.#storage.read(hostId);
    if (stored === null) return null;
    try {
      const record = validateRecord(stored);
      if (Date.parse(record.expiresAt) <= this.#now()) {
        await this.#storage.delete(hostId);
        return null;
      }
      const pairingUrl = await this.#unseal(record);
      const parsed = parseRemoteControlRelayPairingUrl(pairingUrl);
      // The record key is not authenticated by the AAD, so a record moved to
      // another host's key must be refused rather than answered for that host.
      if (parsed.bootstrap.expiresAt !== record.expiresAt
        || parsed.bootstrap.hostId !== hostId
        || record.hostId !== hostId
        || isRemoteControlRelayPairingExpired(parsed.bootstrap, this.#now())) {
        return fail('VAULT_CONTEXT_MISMATCH');
      }
      return pairingUrl;
    } catch (error) {
      await this.#storage.delete(hostId).catch(() => undefined);
      if (error instanceof RemoteControlRelayBootstrapVaultError) throw error;
      return fail('VAULT_DECRYPT_FAILED');
    }
  }

  /**
   * One unreadable or expired Mac must not take the others down with it: its
   * record is dropped and every host that still opens is returned.
   */
  async loadAll(): Promise<RemoteControlRelayBootstrapVaultEntry[]> {
    await this.#adoptLegacyRecord();
    const entries: RemoteControlRelayBootstrapVaultEntry[] = [];
    for (const entry of await this.#storage.entries()) {
      if (entry.recordKey === LEGACY_RECORD_KEY) continue;
      const pairingUrl = await this.load(entry.recordKey).catch(() => null);
      if (pairingUrl) entries.push({ hostId: entry.recordKey, pairingUrl });
    }
    return entries;
  }

  async clearHost(hostId: string): Promise<void> {
    await this.#storage.delete(hostId);
  }

  async clear(): Promise<void> {
    await this.#storage.clear();
  }

  async #unseal(record: SealedBootstrapEnvelope): Promise<string> {
    return decoder.decode(await this.#crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: record.nonce,
        additionalData: vaultAad(record.expiresAt),
        tagLength: 128,
      },
      record.key,
      record.ciphertext,
    ));
  }

  /**
   * Re-file the legacy record under its host id without decrypting and
   * re-sealing it: the key, nonce, ciphertext and AAD move across untouched.
   */
  async #adoptLegacyRecord(): Promise<void> {
    if (this.#legacyAdopted) return;
    const stored = await this.#storage.read(LEGACY_RECORD_KEY);
    if (stored === null) {
      this.#legacyAdopted = true;
      return;
    }
    let migrated: SealedBootstrapRecord | null = null;
    try {
      const record = validateLegacyRecord(stored);
      const parsed = parseRemoteControlRelayPairingUrl(await this.#unseal(record));
      if (parsed.bootstrap.expiresAt === record.expiresAt
        && !isRemoteControlRelayPairingExpired(parsed.bootstrap, this.#now())) {
        migrated = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          hostId: parsed.bootstrap.hostId,
          updatedAt: this.#now(),
          expiresAt: record.expiresAt,
          key: record.key,
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
