const LEGACY_PENDING_START_STORAGE_KEY = 'agentstoz.agent-runtime.pending-start.v1';
const PENDING_START_STORAGE_KEY = 'agentstoz.agent-runtime.pending-start.v2';
const PENDING_START_TTL_MS = 24 * 60 * 60_000;
const PENDING_START_RECEIPT_LIMIT = 16;
const REQUEST_ID_RE = /^request_[A-Za-z0-9_-]{8,120}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface AgentRuntimePendingStartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredPendingStartReceipt {
  intentDigest: string;
  requestId: string;
  createdAt: number;
}

interface LegacyStoredPendingStart extends StoredPendingStartReceipt {
  version: 1;
}

interface StoredPendingStarts {
  version: 2;
  receipts: StoredPendingStartReceipt[];
}

type ParsedStoredPendingStarts =
  | { kind: 'current'; value: StoredPendingStarts }
  | { kind: 'future' };

type StoredRead<T> =
  | { state: 'missing' | 'unavailable' }
  | { state: 'invalid'; raw: string }
  | { state: 'valid'; raw: string; value: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseReceipt(value: unknown): StoredPendingStartReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, ['intentDigest', 'requestId', 'createdAt'])
    || typeof value.intentDigest !== 'string'
    || !SHA256_HEX_RE.test(value.intentDigest)
    || typeof value.requestId !== 'string'
    || !REQUEST_ID_RE.test(value.requestId)
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0) return null;
  return {
    intentDigest: value.intentDigest,
    requestId: value.requestId,
    createdAt: value.createdAt,
  };
}

function parseLegacyStoredPendingStart(value: string): LegacyStoredPendingStart | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ['version', 'intentDigest', 'requestId', 'createdAt'])
      || parsed.version !== 1) return null;
    const receipt = parseReceipt({
      intentDigest: parsed.intentDigest,
      requestId: parsed.requestId,
      createdAt: parsed.createdAt,
    });
    return receipt ? { version: 1, ...receipt } : null;
  } catch {
    return null;
  }
}

function parseStoredPendingStarts(value: string): ParsedStoredPendingStarts | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)
      && typeof parsed.version === 'number'
      && Number.isSafeInteger(parsed.version)
      && parsed.version > 2) {
      // A newer app owns this value. An older renderer cannot safely merge or
      // delete it without losing idempotency receipts it does not understand.
      return { kind: 'future' };
    }
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ['version', 'receipts'])
      || parsed.version !== 2
      || !Array.isArray(parsed.receipts)
      || parsed.receipts.length > PENDING_START_RECEIPT_LIMIT) return null;
    const receipts: StoredPendingStartReceipt[] = [];
    const digests = new Set<string>();
    const requestIds = new Set<string>();
    for (const candidate of parsed.receipts) {
      const receipt = parseReceipt(candidate);
      if (!receipt || digests.has(receipt.intentDigest) || requestIds.has(receipt.requestId)) return null;
      digests.add(receipt.intentDigest);
      requestIds.add(receipt.requestId);
      receipts.push(receipt);
    }
    return { kind: 'current', value: { version: 2, receipts } };
  } catch {
    return null;
  }
}

function readStored<T>(
  storage: AgentRuntimePendingStartStorage,
  key: string,
  parse: (raw: string) => T | null,
): StoredRead<T> {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { state: 'unavailable' };
  }
  if (raw === null) return { state: 'missing' };
  const value = parse(raw);
  return value === null ? { state: 'invalid', raw } : { state: 'valid', raw, value };
}

function removeIfUnchanged(
  storage: AgentRuntimePendingStartStorage,
  key: string,
  raw: string,
): void {
  try {
    if (storage.getItem(key) === raw) storage.removeItem(key);
  } catch {
    // Persistence only strengthens retry behavior; cleanup is best effort.
  }
}

function isCurrent(receipt: StoredPendingStartReceipt, now: number): boolean {
  return receipt.createdAt <= now && now - receipt.createdAt <= PENDING_START_TTL_MS;
}

function boundReceipts(receipts: StoredPendingStartReceipt[]): StoredPendingStartReceipt[] {
  return [...receipts]
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
      if (left.intentDigest === right.intentDigest) return 0;
      return left.intentDigest < right.intentDigest ? -1 : 1;
    })
    .slice(0, PENDING_START_RECEIPT_LIMIT);
}

function mergeReceipt(
  receipts: StoredPendingStartReceipt[],
  receipt: StoredPendingStartReceipt,
): StoredPendingStartReceipt[] {
  return boundReceipts([
    ...receipts.filter(existing => (
      existing.intentDigest !== receipt.intentDigest && existing.requestId !== receipt.requestId
    )),
    receipt,
  ]);
}

function legacyReceipt(value: LegacyStoredPendingStart): StoredPendingStartReceipt {
  return {
    intentDigest: value.intentDigest,
    requestId: value.requestId,
    createdAt: value.createdAt,
  };
}

function writeStoredPendingStarts(
  storage: AgentRuntimePendingStartStorage,
  receipts: StoredPendingStartReceipt[],
): void {
  if (receipts.length === 0) {
    storage.removeItem(PENDING_START_STORAGE_KEY);
    return;
  }
  storage.setItem(PENDING_START_STORAGE_KEY, JSON.stringify({
    version: 2,
    receipts,
  } satisfies StoredPendingStarts));
}

/** Hashes the full local intent so retry state never persists the raw prompt or model. */
export async function digestAgentRuntimeStartIntent(fingerprint: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function recoverAgentRuntimePendingRequestId(
  storage: AgentRuntimePendingStartStorage,
  intentDigest: string,
  now = Date.now(),
): string | null {
  if (!SHA256_HEX_RE.test(intentDigest) || !Number.isSafeInteger(now) || now < 0) return null;

  const stored = readStored(storage, PENDING_START_STORAGE_KEY, parseStoredPendingStarts);
  if (stored.state === 'valid' && stored.value.kind === 'future') return null;
  if (stored.state === 'invalid') removeIfUnchanged(storage, PENDING_START_STORAGE_KEY, stored.raw);
  const currentStored = stored.state === 'valid' && stored.value.kind === 'current'
    ? stored.value.value
    : null;
  let receipts = currentStored
    ? currentStored.receipts.filter(receipt => isCurrent(receipt, now))
    : [];
  let shouldWrite = currentStored !== null
    && receipts.length !== currentStored.receipts.length;

  const legacy = readStored(storage, LEGACY_PENDING_START_STORAGE_KEY, parseLegacyStoredPendingStart);
  if (legacy.state === 'invalid') {
    removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
  } else if (legacy.state === 'valid') {
    if (isCurrent(legacy.value, now)) {
      const merged = mergeReceipt(receipts, legacyReceipt(legacy.value));
      shouldWrite ||= merged.length !== receipts.length
        || merged.some((receipt, index) => receipt !== receipts[index]);
      receipts = merged;
    } else {
      removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
    }
  }

  if (shouldWrite) {
    try {
      writeStoredPendingStarts(storage, receipts);
      if (legacy.state === 'valid' && isCurrent(legacy.value, now)) {
        removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
      }
    } catch {
      // A valid legacy receipt remains readable if migration could not commit.
    }
  } else if (legacy.state === 'valid' && isCurrent(legacy.value, now)
    && receipts.some(receipt => (
      receipt.intentDigest === legacy.value.intentDigest
      && receipt.requestId === legacy.value.requestId
    ))) {
    removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
  }

  return receipts.find(receipt => receipt.intentDigest === intentDigest)?.requestId ?? null;
}

export function persistAgentRuntimePendingRequest(
  storage: AgentRuntimePendingStartStorage,
  intentDigest: string,
  requestId: string,
  now = Date.now(),
): void {
  if (!SHA256_HEX_RE.test(intentDigest) || !REQUEST_ID_RE.test(requestId)
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid pending Agent Runtime request receipt.');
  }

  const stored = readStored(storage, PENDING_START_STORAGE_KEY, parseStoredPendingStarts);
  if (stored.state === 'valid' && stored.value.kind === 'future') {
    throw new Error('Pending Agent Runtime receipts were written by a newer app version.');
  }
  if (stored.state === 'invalid') removeIfUnchanged(storage, PENDING_START_STORAGE_KEY, stored.raw);
  const currentStored = stored.state === 'valid' && stored.value.kind === 'current'
    ? stored.value.value
    : null;
  let receipts = currentStored
    ? currentStored.receipts.filter(receipt => isCurrent(receipt, now))
    : [];

  const legacy = readStored(storage, LEGACY_PENDING_START_STORAGE_KEY, parseLegacyStoredPendingStart);
  if (legacy.state === 'invalid') {
    removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
  } else if (legacy.state === 'valid') {
    if (isCurrent(legacy.value, now)) receipts = mergeReceipt(receipts, legacyReceipt(legacy.value));
    else removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
  }

  receipts = mergeReceipt(receipts, { intentDigest, requestId, createdAt: now });
  writeStoredPendingStarts(storage, receipts);
  if (legacy.state === 'valid') {
    removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
  }
}

export function clearAgentRuntimePendingRequest(
  storage: AgentRuntimePendingStartStorage,
  requestId: string,
): void {
  try {
    const stored = readStored(storage, PENDING_START_STORAGE_KEY, parseStoredPendingStarts);
    if (stored.state === 'invalid') {
      removeIfUnchanged(storage, PENDING_START_STORAGE_KEY, stored.raw);
    } else if (stored.state === 'valid' && stored.value.kind === 'current') {
      const remaining = stored.value.value.receipts.filter(receipt => receipt.requestId !== requestId);
      if (remaining.length !== stored.value.value.receipts.length) {
        writeStoredPendingStarts(storage, remaining);
      }
    }

    const legacy = readStored(storage, LEGACY_PENDING_START_STORAGE_KEY, parseLegacyStoredPendingStart);
    if (legacy.state === 'invalid'
      || (legacy.state === 'valid' && legacy.value.requestId === requestId)) {
      removeIfUnchanged(storage, LEGACY_PENDING_START_STORAGE_KEY, legacy.raw);
    }
  } catch {
    // Persistence only strengthens retry behavior; it must not break a task.
  }
}
