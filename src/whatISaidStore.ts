import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { redactWhatISaidForFeed, type WhatISaidRedactionReason } from "./whatISaidRedaction";

/**
 * Local, encrypted authority for the optional "What I said" collection.
 *
 * This is deliberately not part of project-memory journal/feedback.  It has its
 * own consent, retention, deletion and sharing lifecycle and never writes into
 * the project tree.
 */

export type WhatISaidAgent = "claude" | "codex";
export type WhatISaidRetention = 30 | 90 | 365 | "forever";
export type WhatISaidPromptOrigin = "human" | "agentstoz" | "unknown";

export interface WhatISaidLocation {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
}

export interface WhatISaidCryptoLocation extends WhatISaidLocation {
  /** Injected by the caller. Production callers use whatISaidKeyProvider.ts. */
  key: Uint8Array;
}

export type WhatISaidStoreErrorCode =
  | "WHAT_I_SAID_INPUT_INVALID"
  | "WHAT_I_SAID_PATH_UNSAFE"
  | "WHAT_I_SAID_KEY_INVALID"
  | "WHAT_I_SAID_STORE_UNAVAILABLE"
  | "WHAT_I_SAID_SCHEMA_UNSUPPORTED"
  | "WHAT_I_SAID_SOURCE_EVENT_CONFLICT"
  | "WHAT_I_SAID_DECRYPT_FAILED"
  | "WHAT_I_SAID_FEED_DISABLED"
  | "WHAT_I_SAID_FEED_UNAUTHORIZED"
  | "WHAT_I_SAID_FEED_REGISTRATION_AMBIGUOUS"
  | "WHAT_I_SAID_CURSOR_INVALID"
  | "WHAT_I_SAID_CURSOR_STALE";

const ERROR_MESSAGES: Record<WhatISaidStoreErrorCode, string> = {
  WHAT_I_SAID_INPUT_INVALID: "What-I-said request is invalid.",
  WHAT_I_SAID_PATH_UNSAFE: "What-I-said storage path is unsafe.",
  WHAT_I_SAID_KEY_INVALID: "What-I-said encryption key is unavailable.",
  WHAT_I_SAID_STORE_UNAVAILABLE: "What-I-said local store is unavailable.",
  WHAT_I_SAID_SCHEMA_UNSUPPORTED: "What-I-said local store needs an application update.",
  WHAT_I_SAID_SOURCE_EVENT_CONFLICT: "What-I-said source event conflicts with its stored receipt.",
  WHAT_I_SAID_DECRYPT_FAILED: "What-I-said entry cannot be decrypted.",
  WHAT_I_SAID_FEED_DISABLED: "What-I-said feed sharing is disabled.",
  WHAT_I_SAID_FEED_UNAUTHORIZED: "What-I-said feed authorization failed.",
  WHAT_I_SAID_FEED_REGISTRATION_AMBIGUOUS: "What-I-said feed registration cannot be safely identified.",
  WHAT_I_SAID_CURSOR_INVALID: "What-I-said feed cursor is invalid.",
  WHAT_I_SAID_CURSOR_STALE: "What-I-said feed cursor is stale.",
};

export class WhatISaidStoreError extends Error {
  constructor(readonly code: WhatISaidStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WhatISaidStoreError";
  }
}

export interface WhatISaidStatus {
  enabled: boolean;
  enabledAt: string | null;
  lastScanAt: string | null;
  lastCaptureAt: string | null;
  retention: WhatISaidRetention;
  /** Separate consent: collection never implies permission to send text to AI. */
  analysisAllowed: boolean;
  counts: {
    active: number;
    softDeleted: number;
    purgedReceipts: number;
    withheld: number;
  };
  feed: {
    enabled: boolean;
    updatedAt: string | null;
  };
}

export interface WhatISaidEntry {
  id: string;
  seq: string;
  agent: WhatISaidAgent;
  recordedAt: string;
  capturedAt: string;
  text: string;
  contentHash: string;
  retentionUntil: string | null;
  /**
   * 이 프롬프트를 수집한 기기. 저장소가 이미 기기 로컬이라 오늘은 한 저장소
   * 안에서 모두 같은 값이지만, 기록은 나중에 합쳐진다 — 아카이브·다른 Mac의
   * 저장소 복원·원격 적재 어느 쪽이든 출처를 되찾을 방법이 행 안에 없으면
   * 그때는 이미 늦다 (VOC 2026-09-01 "단말정보를 포함해서 기록이 되는지").
   * 이름은 바뀌므로 수집 시점의 이름을 함께 박아 둔다. 외부 피드에는 내보내지 않는다.
   */
  deviceId: string | null;
  deviceName: string | null;
  /** Explicit clipboard provenance. Existing pre-v6 rows remain unknown. */
  promptOrigin: WhatISaidPromptOrigin;
}

export interface WhatISaidFeedItem {
  id: string;
  recordedAt: string;
  agent: WhatISaidAgent;
  text: string;
  contentHash: string;
  promptOrigin: WhatISaidPromptOrigin;
  redaction: {
    state: "clean" | "redacted";
    reasons: WhatISaidRedactionReason[];
    truncated: boolean;
  };
}

export interface WhatISaidFeedPage {
  schemaVersion: 2;
  redactionPolicyVersion: 1;
  items: WhatISaidFeedItem[];
  nextCursor: string;
  hasMore: boolean;
  scan: {
    complete: boolean;
    unreadable: number;
    withheld: number;
  };
}

const STORE_SCHEMA_VERSION = 6;
const ENCRYPTED_FEED_KEY_SENTINEL = "encrypted-v3";
const STORAGE_DIRECTORY = "what-i-said";
const MAX_MEMORY_ID_BYTES = 512;
const MAX_SOURCE_ID_BYTES = 4_096;
export const WHAT_I_SAID_MAX_PROMPT_BYTES = 64 * 1024;
const MAX_LIST_LIMIT = 500;
const MAX_FEED_LIMIT = 250;
const DEFAULT_RETENTION: WhatISaidRetention = 90;
const EVENT_ID = /^wis_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEQUENCE = /^(?:0|[1-9][0-9]*)$/;

interface StoreIdentity {
  canonicalProjectRoot: string;
  identityHash: string;
  databasePath: string;
}

interface SettingsRow {
  schema_version: unknown;
  identity_hash: unknown;
  memory_id: unknown;
  key_version: unknown;
  key_verifier: unknown;
  capture_enabled: unknown;
  capture_enabled_at: unknown;
  last_scan_at: unknown;
  last_capture_at: unknown;
  retention_policy: unknown;
  analysis_allowed: unknown;
  feed_enabled: unknown;
  feed_token_hash: unknown;
  feed_key_nonce: unknown;
  feed_key_ciphertext: unknown;
  feed_key_auth_tag: unknown;
  feed_registration_id: unknown;
  feed_token_updated_at: unknown;
  index_epoch: unknown;
  updated_at: unknown;
}

interface EventRow {
  seq: unknown;
  event_id: unknown;
  source_agent: unknown;
  recorded_at: unknown;
  captured_at: unknown;
  content_hash: unknown;
  nonce: unknown;
  ciphertext: unknown;
  auth_tag: unknown;
  retention_until: unknown;
  withheld_reason?: unknown;
  device_id?: unknown;
  device_name?: unknown;
  prompt_origin?: unknown;
}

export interface WhatISaidTranscriptCursor {
  sourceId: string;
  generation: number;
  fileIdentity: string;
  byteOffset: number;
  lineNumber: number;
  anchorLength: number;
  anchorHash: string | null;
  /** An over-limit JSONL record was receipted; discard bytes until its LF. */
  discardUntilNewline: boolean;
}

export type WhatISaidDiscoveryScope = "codex";

export interface WhatISaidTranscriptClassification {
  sourceId: string;
  fileIdentity: string;
  classifiedSize: number;
  owned: boolean;
}

function fail(code: WhatISaidStoreErrorCode): never {
  throw new WhatISaidStoreError(code);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function assertMemoryId(memoryId: string): void {
  if (!boundedText(memoryId, MAX_MEMORY_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
}

function canonicalProjectRoot(projectRoot: string): string {
  const requested = resolve(projectRoot);
  if (!existsSync(requested)) fail("WHAT_I_SAID_PATH_UNSAFE");
  const info = lstatSync(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("WHAT_I_SAID_PATH_UNSAFE");
  return realpathSync(requested);
}

function prepareStorageDirectory(appDataDir: string): string {
  const requested = resolve(appDataDir);
  if (existsSync(requested)) {
    const info = lstatSync(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("WHAT_I_SAID_PATH_UNSAFE");
  } else {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
  }
  const canonicalAppData = realpathSync(requested);
  const directory = join(canonicalAppData, STORAGE_DIRECTORY);
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(directory) !== directory) {
      fail("WHAT_I_SAID_PATH_UNSAFE");
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function storeIdentity(input: WhatISaidLocation): StoreIdentity {
  assertMemoryId(input.memoryId);
  const root = canonicalProjectRoot(input.projectRoot);
  // memoryId is the stable lineage identity. A folder name/path is mutable and
  // external worktrees may live outside the main checkout, so it is validated
  // as call context but never participates in the authority/key identity.
  const identityHash = createHash("sha256")
    .update(`what-i-said-memory-v1\0${input.memoryId}`, "utf8")
    .digest("hex");
  return {
    canonicalProjectRoot: root,
    identityHash,
    databasePath: join(prepareStorageDirectory(input.appDataDir), `${identityHash}.sqlite`),
  };
}

function existingStoreIdentity(input: WhatISaidLocation): StoreIdentity | null {
  assertMemoryId(input.memoryId);
  const root = canonicalProjectRoot(input.projectRoot);
  const requestedAppData = resolve(input.appDataDir);
  const appDataInfo = lstatIfPresent(requestedAppData);
  if (!appDataInfo) return null;
  if (appDataInfo.isSymbolicLink() || !appDataInfo.isDirectory()) fail("WHAT_I_SAID_PATH_UNSAFE");
  const canonicalAppData = realpathSync(requestedAppData);
  const storageDirectory = join(canonicalAppData, STORAGE_DIRECTORY);
  const storageInfo = lstatIfPresent(storageDirectory);
  if (!storageInfo) return null;
  if (storageInfo.isSymbolicLink() || !storageInfo.isDirectory()
    || realpathSync(storageDirectory) !== storageDirectory) fail("WHAT_I_SAID_PATH_UNSAFE");
  const identityHash = createHash("sha256")
    .update(`what-i-said-memory-v1\0${input.memoryId}`, "utf8")
    .digest("hex");
  const databasePath = join(storageDirectory, `${identityHash}.sqlite`);
  const databaseInfo = lstatIfPresent(databasePath);
  if (!databaseInfo) {
    for (const sidecar of [`${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
      const info = lstatIfPresent(sidecar);
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile()) fail("WHAT_I_SAID_PATH_UNSAFE");
      // A sidecar without its database is incomplete durable state, not proof
      // of a fresh lineage. Never create a replacement encryption key here.
      fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    }
    return null;
  }
  if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) fail("WHAT_I_SAID_PATH_UNSAFE");
  assertRegularDatabaseFiles(databasePath);
  return { canonicalProjectRoot: root, identityHash, databasePath };
}

export function whatISaidDatabasePath(input: WhatISaidLocation): string {
  return storeIdentity(input).databasePath;
}

/**
 * Feed-auth discovery must not create a DB, migrate it, change pragmas, bind a
 * key verifier, or create an OS credential. It only returns the registration
 * bound to an internally valid enabled feed in an existing v3/v4 store.
 */
export function whatISaidFeedRegistrationReadOnly(input: WhatISaidLocation): string | null {
  let db: Database | null = null;
  try {
    const identity = existingStoreIdentity(input);
    if (!identity) return null;
    db = new Database(identity.databasePath, { readonly: true, create: false });
    const version = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
    if (version !== 3 && version !== 4 && version !== 5 && version !== STORE_SCHEMA_VERSION) fail("WHAT_I_SAID_SCHEMA_UNSUPPORTED");
    const row = db.query(`
      SELECT schema_version, identity_hash, memory_id, key_version, key_verifier,
             feed_enabled, feed_token_hash, feed_key_nonce, feed_key_ciphertext,
             feed_key_auth_tag, feed_registration_id
      FROM what_i_said_settings WHERE singleton = 1
    `).get() as Record<string, unknown> | null;
    if (!row
      || row.schema_version !== version
      || row.identity_hash !== identity.identityHash
      || row.memory_id !== input.memoryId
      || row.key_version !== 1
      || (row.key_verifier !== null
        && (typeof row.key_verifier !== "string" || !SHA256.test(row.key_verifier)))) {
      fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    }
    if (row.feed_enabled === 0) {
      if (row.feed_token_hash !== null || row.feed_key_nonce !== null
        || row.feed_key_ciphertext !== null || row.feed_key_auth_tag !== null
        || row.feed_registration_id !== null) fail("WHAT_I_SAID_STORE_UNAVAILABLE");
      return null;
    }
    if (row.feed_enabled !== 1
      || row.feed_token_hash !== ENCRYPTED_FEED_KEY_SENTINEL
      || !(row.feed_key_nonce instanceof Uint8Array) || row.feed_key_nonce.byteLength !== 12
      || !(row.feed_key_ciphertext instanceof Uint8Array) || row.feed_key_ciphertext.byteLength !== 32
      || !(row.feed_key_auth_tag instanceof Uint8Array) || row.feed_key_auth_tag.byteLength !== 16
      || typeof row.feed_registration_id !== "string"
      || !boundedText(row.feed_registration_id, MAX_SOURCE_ID_BYTES)) {
      fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    }
    return row.feed_registration_id;
  } catch (error) {
    if (error instanceof WhatISaidStoreError) throw error;
    throw new WhatISaidStoreError("WHAT_I_SAID_STORE_UNAVAILABLE");
  } finally {
    db?.close();
  }
}

export function isWhatISaidFeedEnabledReadOnly(input: WhatISaidLocation): boolean {
  return whatISaidFeedRegistrationReadOnly(input) !== null;
}

export interface WhatISaidCaptureProbe {
  /**
   * false means this store could not be read at all. The caller must render
   * that as "unknown", never as the claim that nothing was ever captured — an
   * unreadable store and a store that has never run are different facts.
   */
  readable: boolean;
  /** null with `readable` true is the honest "never captured" answer. */
  lastCaptureAt: string | null;
}

/**
 * Read-only freshness probe for the prompt library header.
 *
 * Capture is session-bound, so a library can be days old while being perfectly
 * healthy; the header has to say so, and the only durable evidence is
 * `last_capture_at` in each store. This must stay as cheap and as harmless as
 * the feed-auth discovery above: it is asked for every memory in the current
 * library scope, so it never creates a database, never migrates one, never
 * changes pragmas, and never binds a key. A label must not be able to write to
 * disk.
 */
export function probeWhatISaidLastCaptureReadOnly(input: WhatISaidLocation): WhatISaidCaptureProbe {
  let db: Database | null = null;
  try {
    const identity = existingStoreIdentity(input);
    // No store on disk is a knowable fact, not a failure: this memory has
    // genuinely never captured anything on this device.
    if (!identity) return { readable: true, lastCaptureAt: null };
    db = new Database(identity.databasePath, { readonly: true, create: false });
    const version = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
    // `last_capture_at` has existed since the first schema, so every migrated
    // version can answer this question without being migrated first.
    if (version < 1 || version > STORE_SCHEMA_VERSION) return { readable: false, lastCaptureAt: null };
    const row = db.query(`
      SELECT memory_id, last_capture_at FROM what_i_said_settings WHERE singleton = 1
    `).get() as Record<string, unknown> | null;
    if (!row || row.memory_id !== input.memoryId) return { readable: false, lastCaptureAt: null };
    const value = row.last_capture_at;
    if (value === null) return { readable: true, lastCaptureAt: null };
    return typeof value === "string" && Number.isFinite(Date.parse(value))
      ? { readable: true, lastCaptureAt: value }
      : { readable: false, lastCaptureAt: null };
  } catch {
    // A locked, corrupt or unsafe store must not fail the library it is only
    // annotating, and must not be reported as "never captured".
    return { readable: false, lastCaptureAt: null };
  } finally {
    db?.close();
  }
}

/**
 * Read-only key-provider preflight. A legacy status call may have created a DB
 * before any OS key existed; only an identity-matching, event-free, feed-free,
 * unbound store is still virgin enough to receive its first key.
 */
export function whatISaidStoreAllowsInitialKey(input: WhatISaidLocation): boolean {
  let db: Database | null = null;
  try {
    const identity = existingStoreIdentity(input);
    if (!identity) return true;
    db = new Database(identity.databasePath, { readonly: true, create: false });
    const version = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== STORE_SCHEMA_VERSION) return false;
    const row = db.query(`SELECT * FROM what_i_said_settings WHERE singleton = 1`).get() as Record<string, unknown> | null;
    if (!row
      || row.schema_version !== version
      || row.identity_hash !== identity.identityHash
      || row.memory_id !== input.memoryId
      || row.capture_enabled !== 0
      || row.capture_enabled_at !== null
      || row.last_scan_at !== null
      || row.last_capture_at !== null
      || row.retention_policy !== "90"
      || row.analysis_allowed !== 0
      || row.feed_enabled !== 0
      || row.feed_token_hash !== null
      || row.feed_token_updated_at !== null
      || (version >= 2 && row.key_version !== 1)
      || (version >= 3 && (
        row.feed_key_nonce !== null
        || row.feed_key_ciphertext !== null
        || row.feed_key_auth_tag !== null
        || row.feed_registration_id !== null
      ))
      || (version >= 2 && row.key_verifier !== null)) {
      return false;
    }
    const settingColumns = new Set(
      (db.query(`PRAGMA table_info(what_i_said_settings)`).all() as Array<{ name?: unknown }>)
        .map(column => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (settingColumns.has("retention_updated_at") && row.retention_updated_at !== null) return false;
    if (Number((db.query(`SELECT count(*) AS count FROM what_i_said_events`).get() as { count?: unknown } | null)?.count ?? -1) !== 0) {
      return false;
    }
    if (version === STORE_SCHEMA_VERSION) {
      for (const table of [
        "what_i_said_transcript_cursors",
        "what_i_said_discovery_cursors",
        "what_i_said_transcript_classifications",
      ]) {
        const count = Number((db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count?: unknown } | null)?.count ?? -1);
        if (count !== 0) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRegularDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    const info = lstatIfPresent(candidate);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) fail("WHAT_I_SAID_PATH_UNSAFE");
  }
}

function applyPrivateDatabasePermissions(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function runTransaction<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the fixed public error. */ }
    throw error;
  }
}

function retentionStorageValue(retention: WhatISaidRetention): string {
  return retention === "forever" ? retention : String(retention);
}

function parseRetention(value: unknown): WhatISaidRetention | null {
  if (value === "forever") return "forever";
  if (value === "30" || value === "90" || value === "365") return Number(value) as 30 | 90 | 365;
  return null;
}

function validRetention(value: unknown): value is WhatISaidRetention {
  return value === 30 || value === 90 || value === 365 || value === "forever";
}

function iso(value: string | undefined): string {
  const milliseconds = value === undefined ? Date.now() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("WHAT_I_SAID_INPUT_INVALID");
  return new Date(milliseconds).toISOString();
}

function initialSchema(db: Database, identity: StoreIdentity, memoryId: string): void {
  const now = new Date().toISOString();
  runTransaction(db, () => {
    db.exec(`
      CREATE TABLE what_i_said_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version INTEGER NOT NULL,
        identity_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        key_verifier TEXT,
        capture_enabled INTEGER NOT NULL CHECK(capture_enabled IN (0, 1)),
        capture_enabled_at TEXT,
        last_scan_at TEXT,
        last_capture_at TEXT,
        retention_policy TEXT NOT NULL CHECK(retention_policy IN ('30', '90', '365', 'forever')),
        analysis_allowed INTEGER NOT NULL CHECK(analysis_allowed IN (0, 1)),
        feed_enabled INTEGER NOT NULL CHECK(feed_enabled IN (0, 1)),
        feed_token_hash TEXT,
        feed_key_nonce BLOB,
        feed_key_ciphertext BLOB,
        feed_key_auth_tag BLOB,
        feed_registration_id TEXT,
        feed_token_updated_at TEXT,
        index_epoch TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((capture_enabled = 0) OR (capture_enabled_at IS NOT NULL AND last_scan_at IS NOT NULL)),
        CHECK((feed_enabled = 0 AND feed_token_hash IS NULL
               AND feed_key_nonce IS NULL AND feed_key_ciphertext IS NULL
               AND feed_key_auth_tag IS NULL AND feed_registration_id IS NULL)
           OR (feed_enabled = 1 AND feed_token_hash = 'encrypted-v3'
               AND feed_key_nonce IS NOT NULL AND feed_key_ciphertext IS NOT NULL
               AND feed_key_auth_tag IS NOT NULL AND feed_registration_id IS NOT NULL))
      );
      CREATE TABLE what_i_said_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_agent TEXT NOT NULL CHECK(source_agent IN ('claude', 'codex')),
        recorded_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        replay_hash TEXT,
        nonce BLOB,
        ciphertext BLOB,
        auth_tag BLOB,
        retention_until TEXT,
        deleted_at TEXT,
        purged_at TEXT,
        withheld_reason TEXT,
        device_id TEXT,
        device_name TEXT,
        prompt_origin TEXT NOT NULL DEFAULT 'unknown'
          CHECK(prompt_origin IN ('human', 'agentstoz', 'unknown')),
        CHECK(
          (purged_at IS NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL)
          OR
          (purged_at IS NOT NULL AND deleted_at IS NOT NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL)
        )
      );
      CREATE INDEX what_i_said_events_active_seq
        ON what_i_said_events(seq) WHERE deleted_at IS NULL;
      CREATE INDEX what_i_said_events_retention
        ON what_i_said_events(retention_until) WHERE purged_at IS NULL;
      CREATE UNIQUE INDEX what_i_said_events_replay_hash
        ON what_i_said_events(replay_hash) WHERE replay_hash IS NOT NULL;
      CREATE TABLE what_i_said_transcript_cursors (
        source_id TEXT PRIMARY KEY CHECK(length(source_id) = 69 AND source_id GLOB 'wisc_[0-9a-f]*'),
        source_agent TEXT NOT NULL CHECK(source_agent IN ('claude', 'codex')),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        file_identity TEXT NOT NULL,
        byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        line_number INTEGER NOT NULL CHECK(line_number >= 0),
        anchor_length INTEGER NOT NULL CHECK(anchor_length >= 0 AND anchor_length <= 256 AND anchor_length <= byte_offset),
        anchor_hash TEXT,
        discard_until_newline INTEGER NOT NULL DEFAULT 0 CHECK(discard_until_newline IN (0, 1)),
        updated_at TEXT NOT NULL,
        CHECK((anchor_length = 0 AND anchor_hash IS NULL)
           OR (anchor_length > 0 AND length(anchor_hash) = 64))
      );
      CREATE TABLE what_i_said_discovery_cursors (
        scope TEXT PRIMARY KEY CHECK(scope = 'codex'),
        after_source_id TEXT CHECK(after_source_id IS NULL OR (length(after_source_id) = 69 AND after_source_id GLOB 'wisc_[0-9a-f]*')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE what_i_said_transcript_classifications (
        source_id TEXT PRIMARY KEY CHECK(length(source_id) = 69 AND source_id GLOB 'wisc_[0-9a-f]*'),
        source_agent TEXT NOT NULL CHECK(source_agent = 'codex'),
        file_identity TEXT NOT NULL,
        classified_size INTEGER NOT NULL CHECK(classified_size >= 0),
        owned INTEGER NOT NULL CHECK(owned IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `);
    db.query(`
      INSERT INTO what_i_said_settings(
        singleton, schema_version, identity_hash, memory_id, key_version, key_verifier,
        capture_enabled, capture_enabled_at, last_scan_at, last_capture_at, retention_policy,
        analysis_allowed,
        feed_enabled, feed_token_hash, feed_key_nonce, feed_key_ciphertext,
        feed_key_auth_tag, feed_registration_id, feed_token_updated_at,
        index_epoch, updated_at
      ) VALUES (1, ?, ?, ?, 1, NULL, 0, NULL, NULL, NULL, ?, 0,
                0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      STORE_SCHEMA_VERSION,
      identity.identityHash,
      memoryId,
      retentionStorageValue(DEFAULT_RETENTION),
      randomUUID(),
      now,
    );
    db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
  });
}

function readSettingsRow(db: Database, identity: StoreIdentity, memoryId: string): SettingsRow {
  const row = db.query(`SELECT * FROM what_i_said_settings WHERE singleton = 1`).get() as SettingsRow | null;
  const retention = parseRetention(row?.retention_policy);
  const enabledAtValid = row?.capture_enabled_at === null
    || (typeof row?.capture_enabled_at === "string" && Number.isFinite(Date.parse(row.capture_enabled_at)));
  const lastScanAtValid = row?.last_scan_at === null
    || (typeof row?.last_scan_at === "string" && Number.isFinite(Date.parse(row.last_scan_at)));
  const lastCaptureAtValid = row?.last_capture_at === null
    || (typeof row?.last_capture_at === "string" && Number.isFinite(Date.parse(row.last_capture_at)));
  const feedDisabledFieldsValid = row?.feed_enabled === 0
    && row.feed_token_hash === null
    && row.feed_key_nonce === null
    && row.feed_key_ciphertext === null
    && row.feed_key_auth_tag === null
    && row.feed_registration_id === null;
  const feedEnabledFieldsValid = row?.feed_enabled === 1
    && row.feed_token_hash === ENCRYPTED_FEED_KEY_SENTINEL
    && row.feed_key_nonce instanceof Uint8Array && row.feed_key_nonce.byteLength === 12
    && row.feed_key_ciphertext instanceof Uint8Array && row.feed_key_ciphertext.byteLength === 32
    && row.feed_key_auth_tag instanceof Uint8Array && row.feed_key_auth_tag.byteLength === 16
    && typeof row.feed_registration_id === "string"
    && boundedText(row.feed_registration_id, MAX_SOURCE_ID_BYTES);
  if (!row
    || row.schema_version !== STORE_SCHEMA_VERSION
    || row.identity_hash !== identity.identityHash
    || row.memory_id !== memoryId
    || row.key_version !== 1
    || (row.key_verifier !== null && (typeof row.key_verifier !== "string" || !SHA256.test(row.key_verifier)))
    || (row.capture_enabled !== 0 && row.capture_enabled !== 1)
    || !enabledAtValid
    || !lastScanAtValid
    || !lastCaptureAtValid
    || (row.capture_enabled === 1 && (row.capture_enabled_at === null || row.last_scan_at === null))
    || !retention
    || (row.analysis_allowed !== 0 && row.analysis_allowed !== 1)
    || (row.feed_enabled !== 0 && row.feed_enabled !== 1)
    || (!feedDisabledFieldsValid && !feedEnabledFieldsValid)
    || typeof row.index_epoch !== "string"
    || row.index_epoch.length < 16) {
    fail("WHAT_I_SAID_STORE_UNAVAILABLE");
  }
  return row;
}

function migrateSchema1To2(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      ALTER TABLE what_i_said_settings
        ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE what_i_said_settings
        ADD COLUMN key_verifier TEXT;
      UPDATE what_i_said_settings SET schema_version = 2, key_version = 1;
      PRAGMA user_version = 2;
    `);
  });
}

function migrateSchema2To3(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      ALTER TABLE what_i_said_settings ADD COLUMN feed_key_nonce BLOB;
      ALTER TABLE what_i_said_settings ADD COLUMN feed_key_ciphertext BLOB;
      ALTER TABLE what_i_said_settings ADD COLUMN feed_key_auth_tag BLOB;
      ALTER TABLE what_i_said_settings ADD COLUMN feed_registration_id TEXT;
      UPDATE what_i_said_settings
      SET schema_version = 3,
          feed_enabled = 0,
          feed_token_hash = NULL,
          feed_key_nonce = NULL,
          feed_key_ciphertext = NULL,
          feed_key_auth_tag = NULL,
          feed_registration_id = NULL,
          index_epoch = lower(hex(randomblob(16))),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      PRAGMA user_version = 3;
    `);
  });
}

function migrateSchema3To4(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      ALTER TABLE what_i_said_events ADD COLUMN withheld_reason TEXT;
      ALTER TABLE what_i_said_events ADD COLUMN replay_hash TEXT;
      CREATE UNIQUE INDEX what_i_said_events_replay_hash
        ON what_i_said_events(replay_hash) WHERE replay_hash IS NOT NULL;
      CREATE TABLE what_i_said_transcript_cursors (
        source_id TEXT PRIMARY KEY CHECK(length(source_id) = 69 AND source_id GLOB 'wisc_[0-9a-f]*'),
        source_agent TEXT NOT NULL CHECK(source_agent IN ('claude', 'codex')),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        file_identity TEXT NOT NULL,
        byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        line_number INTEGER NOT NULL CHECK(line_number >= 0),
        anchor_length INTEGER NOT NULL CHECK(anchor_length >= 0 AND anchor_length <= 256 AND anchor_length <= byte_offset),
        anchor_hash TEXT,
        discard_until_newline INTEGER NOT NULL DEFAULT 0 CHECK(discard_until_newline IN (0, 1)),
        updated_at TEXT NOT NULL,
        CHECK((anchor_length = 0 AND anchor_hash IS NULL)
           OR (anchor_length > 0 AND length(anchor_hash) = 64))
      );
      CREATE TABLE what_i_said_discovery_cursors (
        scope TEXT PRIMARY KEY CHECK(scope = 'codex'),
        after_source_id TEXT CHECK(after_source_id IS NULL OR (length(after_source_id) = 69 AND after_source_id GLOB 'wisc_[0-9a-f]*')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE what_i_said_transcript_classifications (
        source_id TEXT PRIMARY KEY CHECK(length(source_id) = 69 AND source_id GLOB 'wisc_[0-9a-f]*'),
        source_agent TEXT NOT NULL CHECK(source_agent = 'codex'),
        file_identity TEXT NOT NULL,
        classified_size INTEGER NOT NULL CHECK(classified_size >= 0),
        owned INTEGER NOT NULL CHECK(owned IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      UPDATE what_i_said_settings
      SET schema_version = 4,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      PRAGMA user_version = 4;
    `);
  });
}

/**
 * 기존 행은 device_id/device_name 이 NULL 로 남는다 — 그 프롬프트가 어느 기기에서
 * 수집됐는지는 지나간 사실이고, 지금 저장소가 있는 기기를 소급해 박으면 그건
 * 기록이 아니라 추측이다. 읽는 쪽은 null 을 "기록 이전"으로 다룬다.
 */
function migrateSchema4To5(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      ALTER TABLE what_i_said_events ADD COLUMN device_id TEXT;
      ALTER TABLE what_i_said_events ADD COLUMN device_name TEXT;
      UPDATE what_i_said_settings
      SET schema_version = 5,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      PRAGMA user_version = 5;
    `);
  });
}

/** Existing rows predate explicit clipboard evidence and must not be guessed. */
function migrateSchema5To6(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      ALTER TABLE what_i_said_events ADD COLUMN prompt_origin TEXT NOT NULL DEFAULT 'unknown'
        CHECK(prompt_origin IN ('human', 'agentstoz', 'unknown'));
      UPDATE what_i_said_settings
      SET schema_version = 6,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      PRAGMA user_version = 6;
    `);
  });
}

function ensureSchema(db: Database, identity: StoreIdentity, memoryId: string): void {
  let version = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
  if (version === 0) initialSchema(db, identity, memoryId);
  else {
    if (version === 1) {
      migrateSchema1To2(db);
      version = 2;
    }
    if (version === 2) {
      migrateSchema2To3(db);
      version = 3;
    }
    if (version === 3) {
      migrateSchema3To4(db);
      version = 4;
    }
    if (version === 4) {
      migrateSchema4To5(db);
      version = 5;
    }
    if (version === 5) {
      migrateSchema5To6(db);
      version = 6;
    }
    if (version !== STORE_SCHEMA_VERSION) fail("WHAT_I_SAID_SCHEMA_UNSUPPORTED");
  }
  readSettingsRow(db, identity, memoryId);
}

function withDatabase<T>(input: WhatISaidLocation, operation: (db: Database, identity: StoreIdentity) => T): T {
  let db: Database | null = null;
  try {
    const identity = storeIdentity(input);
    assertRegularDatabaseFiles(identity.databasePath);
    db = new Database(identity.databasePath, { create: true });
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = 3000;
      PRAGMA foreign_keys = ON;
    `);
    applyPrivateDatabasePermissions(identity.databasePath);
    ensureSchema(db, identity, input.memoryId);
    return operation(db, identity);
  } catch (error) {
    if (error instanceof WhatISaidStoreError) throw error;
    throw new WhatISaidStoreError("WHAT_I_SAID_STORE_UNAVAILABLE");
  } finally {
    db?.close();
  }
}

function keyBuffer(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail("WHAT_I_SAID_KEY_INVALID");
  return Buffer.from(key);
}

function agent(value: unknown): WhatISaidAgent {
  if (value !== "claude" && value !== "codex") fail("WHAT_I_SAID_INPUT_INVALID");
  return value;
}

function promptOrigin(value: unknown): WhatISaidPromptOrigin {
  return value === "human" || value === "agentstoz" || value === "unknown"
    ? value
    : "unknown";
}

function contentHash(key: Buffer, text: string): string {
  // The receipt is stored next to ciphertext. A plain SHA-256 would let
  // anyone who copied the DB confirm guesses for short prompts, paths, email
  // addresses, or secrets without decrypting them.
  return createHmac("sha256", key)
    .update("agentstoz-what-i-said-content-v1\0", "utf8")
    .update(text, "utf8")
    .digest("hex");
}

export function whatISaidFeedProjectionHash(text: string): string {
  return feedProjectionHash(text);
}

function feedProjectionHash(text: string): string {
  // Feed consumers only receive the already-redacted projection. Its hash is
  // therefore derived from exactly that visible value, never from hidden raw
  // prompt bytes.
  return createHash("sha256")
    .update("agentstoz-what-i-said-feed-projection-v1\0", "utf8")
    .update(text, "utf8")
    .digest("hex");
}

export function deriveWhatISaidSourceEventId(input: {
  key: Uint8Array;
  agent: WhatISaidAgent;
  sourceIdentity: string;
  sourceEventIdentity: string;
}): string {
  const key = keyBuffer(input.key);
  const sourceAgent = agent(input.agent);
  if (!boundedText(input.sourceIdentity, MAX_SOURCE_ID_BYTES)
    || !boundedText(input.sourceEventIdentity, MAX_SOURCE_ID_BYTES)) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  const digest = createHmac("sha256", key)
    .update("agentstoz-what-i-said-source-v1\0", "utf8")
    .update(sourceAgent, "utf8")
    .update("\0", "utf8")
    .update(input.sourceIdentity, "utf8")
    .update("\0", "utf8")
    .update(input.sourceEventIdentity, "utf8")
    .digest("hex");
  return `wis_${digest}`;
}

function aad(input: {
  memoryId: string;
  eventId: string;
  agent: WhatISaidAgent;
  recordedAt: string;
  contentHash: string;
}): Buffer {
  return Buffer.from([
    "agentstoz-what-i-said-entry-v1",
    input.memoryId,
    input.eventId,
    input.agent,
    input.recordedAt,
    input.contentHash,
  ].join("\0"), "utf8");
}

function encryptText(input: {
  key: Buffer;
  memoryId: string;
  eventId: string;
  agent: WhatISaidAgent;
  recordedAt: string;
  text: string;
  hash: string;
}): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(aad({
    memoryId: input.memoryId,
    eventId: input.eventId,
    agent: input.agent,
    recordedAt: input.recordedAt,
    contentHash: input.hash,
  }));
  const ciphertext = Buffer.concat([cipher.update(input.text, "utf8"), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function bytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail("WHAT_I_SAID_DECRYPT_FAILED");
}

function decryptRow(key: Buffer, memoryId: string, row: EventRow): string {
  try {
    if (!EVENT_ID.test(String(row.event_id))
      || (row.source_agent !== "claude" && row.source_agent !== "codex")
      || typeof row.recorded_at !== "string"
      || !SHA256.test(String(row.content_hash))) {
      fail("WHAT_I_SAID_DECRYPT_FAILED");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(row.nonce));
    decipher.setAAD(aad({
      memoryId,
      eventId: String(row.event_id),
      agent: row.source_agent,
      recordedAt: row.recorded_at,
      contentHash: String(row.content_hash),
    }));
    decipher.setAuthTag(bytes(row.auth_tag));
    const plaintext = Buffer.concat([decipher.update(bytes(row.ciphertext)), decipher.final()]).toString("utf8");
    if (contentHash(key, plaintext) !== row.content_hash) fail("WHAT_I_SAID_DECRYPT_FAILED");
    return plaintext;
  } catch (error) {
    if (error instanceof WhatISaidStoreError) throw error;
    fail("WHAT_I_SAID_DECRYPT_FAILED");
  }
}

function keyVerifier(key: Buffer, identity: StoreIdentity, memoryId: string): string {
  return createHmac("sha256", key)
    .update("agentstoz-what-i-said-key-verifier-v1\0", "utf8")
    .update(identity.identityHash, "utf8")
    .update("\0", "utf8")
    .update(memoryId, "utf8")
    .digest("hex");
}

function bindOrVerifyDatabaseKey(
  db: Database,
  identity: StoreIdentity,
  memoryId: string,
  key: Buffer,
): void {
  const settings = readSettingsRow(db, identity, memoryId);
  const expected = Buffer.from(keyVerifier(key, identity, memoryId), "hex");
  if (typeof settings.key_verifier === "string") {
    const stored = Buffer.from(settings.key_verifier, "hex");
    if (stored.byteLength !== expected.byteLength || !timingSafeEqual(stored, expected)) {
      fail("WHAT_I_SAID_KEY_INVALID");
    }
    return;
  }

  // A pre-fingerprint store can be bound only when the supplied key is
  // cryptographically proven by an existing ciphertext, or when the store is
  // completely empty and has never exposed a feed identity. Purged-only
  // receipts deliberately fail closed because their plaintext is gone.
  const totals = db.query(`
    SELECT count(*) AS total,
           sum(CASE WHEN purged_at IS NULL THEN 1 ELSE 0 END) AS decryptable
    FROM what_i_said_events
  `).get() as { total?: unknown; decryptable?: unknown } | null;
  const total = Number(totals?.total ?? 0);
  const decryptable = Number(totals?.decryptable ?? 0);
  if (decryptable > 0) {
    let afterSeq = "0";
    let verified = 0;
    while (true) {
      const rows = db.query(`
        SELECT CAST(seq AS TEXT) AS seq, event_id, source_agent, recorded_at, captured_at,
               content_hash, nonce, ciphertext, auth_tag, retention_until, prompt_origin
        FROM what_i_said_events
        WHERE purged_at IS NULL AND seq > CAST(? AS INTEGER)
        ORDER BY seq ASC LIMIT 250
      `).all(afterSeq) as EventRow[];
      if (!rows.length) break;
      for (const row of rows) {
        try {
          decryptRow(key, memoryId, row);
        } catch {
          fail("WHAT_I_SAID_KEY_INVALID");
        }
        afterSeq = String(row.seq);
        verified += 1;
      }
      if (rows.length < 250) break;
    }
    if (verified !== decryptable) fail("WHAT_I_SAID_KEY_INVALID");
  } else if (total !== 0 || settings.feed_enabled === 1) {
    fail("WHAT_I_SAID_KEY_INVALID");
  }
  db.query(`
    UPDATE what_i_said_settings SET key_verifier = ? WHERE singleton = 1 AND key_verifier IS NULL
  `).run(expected.toString("hex"));
  const bound = readSettingsRow(db, identity, memoryId);
  if (typeof bound.key_verifier !== "string") fail("WHAT_I_SAID_STORE_UNAVAILABLE");
  const stored = Buffer.from(bound.key_verifier, "hex");
  if (stored.byteLength !== expected.byteLength || !timingSafeEqual(stored, expected)) {
    fail("WHAT_I_SAID_KEY_INVALID");
  }
}

function assertKeyBoundBeforeCiphertextPurge(db: Database): void {
  const settings = db.query(`
    SELECT key_verifier FROM what_i_said_settings WHERE singleton = 1
  `).get() as { key_verifier?: unknown } | null;
  if (typeof settings?.key_verifier === "string" && SHA256.test(settings.key_verifier)) return;
  const hasCiphertext = db.query(`
    SELECT 1 AS found FROM what_i_said_events WHERE purged_at IS NULL LIMIT 1
  `).get() !== null;
  if (hasCiphertext) fail("WHAT_I_SAID_KEY_INVALID");
}

/** Binds a virgin store or proves that an existing store still has its original key. */
export function verifyWhatISaidStoreKey(input: WhatISaidCryptoLocation): void {
  const key = keyBuffer(input.key);
  withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
  }));
}

function retentionUntil(retention: WhatISaidRetention, recordedAt: string): string | null {
  if (retention === "forever") return null;
  return new Date(Date.parse(recordedAt) + retention * 24 * 60 * 60 * 1000).toISOString();
}

function applyEventRetention(db: Database, retention: WhatISaidRetention): void {
  if (retention === "forever") {
    db.query(`
      UPDATE what_i_said_events SET retention_until = NULL WHERE purged_at IS NULL
    `).run();
    return;
  }
  const rows = db.query(`
    SELECT event_id, recorded_at FROM what_i_said_events WHERE purged_at IS NULL
  `).all() as Array<{ event_id?: unknown; recorded_at?: unknown }>;
  const update = db.query(`
    UPDATE what_i_said_events SET retention_until = ? WHERE event_id = ? AND purged_at IS NULL
  `);
  for (const row of rows) {
    if (typeof row.event_id !== "string" || typeof row.recorded_at !== "string"
      || !Number.isFinite(Date.parse(row.recorded_at))) {
      fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    }
    update.run(retentionUntil(retention, row.recorded_at), row.event_id);
  }
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return Number((db.query(sql).get(...params) as { count?: unknown } | null)?.count ?? 0);
}

function publicStatus(db: Database, identity: StoreIdentity, memoryId: string, now: string): WhatISaidStatus {
  const settings = readSettingsRow(db, identity, memoryId);
  return {
    enabled: settings.capture_enabled === 1,
    enabledAt: typeof settings.capture_enabled_at === "string" ? settings.capture_enabled_at : null,
    lastScanAt: typeof settings.last_scan_at === "string" ? settings.last_scan_at : null,
    lastCaptureAt: typeof settings.last_capture_at === "string" ? settings.last_capture_at : null,
    retention: parseRetention(settings.retention_policy)!,
    analysisAllowed: settings.analysis_allowed === 1,
    counts: {
      active: count(db, `
        SELECT count(*) AS count FROM what_i_said_events
        WHERE deleted_at IS NULL AND purged_at IS NULL
          AND (retention_until IS NULL OR retention_until > ?)
      `, now),
      softDeleted: count(db, `
        SELECT count(*) AS count FROM what_i_said_events
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL
      `),
      purgedReceipts: count(db, `
        SELECT count(*) AS count FROM what_i_said_events WHERE purged_at IS NOT NULL
      `),
      withheld: count(db, `
        SELECT count(*) AS count FROM what_i_said_events WHERE withheld_reason IS NOT NULL
      `),
    },
    feed: {
      enabled: settings.feed_enabled === 1,
      updatedAt: typeof settings.feed_token_updated_at === "string" ? settings.feed_token_updated_at : null,
    },
  };
}

export function readWhatISaidStatus(input: WhatISaidLocation & { now?: string }): WhatISaidStatus {
  const now = iso(input.now);
  return withDatabase(input, (db, identity) => publicStatus(db, identity, input.memoryId, now));
}

export function enableWhatISaidCapture(input: WhatISaidLocation & {
  retention?: WhatISaidRetention;
  now?: string;
}): WhatISaidStatus {
  const now = iso(input.now);
  const retention = input.retention ?? DEFAULT_RETENTION;
  if (!validRetention(retention)) fail("WHAT_I_SAID_INPUT_INVALID");
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    const settings = readSettingsRow(db, identity, input.memoryId);
    const enabledAt = settings.capture_enabled === 1 && typeof settings.capture_enabled_at === "string"
      ? settings.capture_enabled_at
      : now;
    const lastScanAt = settings.capture_enabled === 1 && typeof settings.last_scan_at === "string"
      ? settings.last_scan_at
      : now;
    db.query(`
      UPDATE what_i_said_settings
      SET capture_enabled = 1,
          capture_enabled_at = ?,
          last_scan_at = ?,
          retention_policy = ?,
          updated_at = ?
      WHERE singleton = 1
    `).run(
      enabledAt,
      lastScanAt,
      retentionStorageValue(retention),
      now,
    );
    applyEventRetention(db, retention);
    return publicStatus(db, identity, input.memoryId, now);
  }));
}

/** Applies the three user-facing privacy controls as one SQLite transaction. */
export function configureWhatISaidCapture(input: WhatISaidLocation & {
  enabled: boolean;
  retention: WhatISaidRetention;
  analysisAllowed: boolean;
  now?: string;
}): WhatISaidStatus {
  const now = iso(input.now);
  if (typeof input.enabled !== "boolean"
    || typeof input.analysisAllowed !== "boolean"
    || !validRetention(input.retention)) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    const settings = readSettingsRow(db, identity, input.memoryId);
    const enabledAt: string | null = input.enabled
      ? settings.capture_enabled === 1 && typeof settings.capture_enabled_at === "string"
        ? settings.capture_enabled_at
        : now
      : typeof settings.capture_enabled_at === "string" ? settings.capture_enabled_at : null;
    const lastScanAt: string | null = input.enabled
      ? settings.capture_enabled === 1 && typeof settings.last_scan_at === "string"
        ? settings.last_scan_at
        : now
      : typeof settings.last_scan_at === "string" ? settings.last_scan_at : null;
    db.query(`
      UPDATE what_i_said_settings
      SET capture_enabled = ?, capture_enabled_at = ?, last_scan_at = ?,
          retention_policy = ?, analysis_allowed = ?, updated_at = ?
      WHERE singleton = 1
    `).run(
      input.enabled ? 1 : 0,
      enabledAt,
      lastScanAt,
      retentionStorageValue(input.retention),
      input.analysisAllowed ? 1 : 0,
      now,
    );
    applyEventRetention(db, input.retention);
    return publicStatus(db, identity, input.memoryId, now);
  }));
}

export function setWhatISaidRetention(input: WhatISaidLocation & {
  retention: WhatISaidRetention;
  now?: string;
}): WhatISaidStatus {
  const now = iso(input.now);
  if (!validRetention(input.retention)) fail("WHAT_I_SAID_INPUT_INVALID");
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    db.query(`
      UPDATE what_i_said_settings SET retention_policy = ?, updated_at = ? WHERE singleton = 1
    `).run(retentionStorageValue(input.retention), now);
    applyEventRetention(db, input.retention);
    return publicStatus(db, identity, input.memoryId, now);
  }));
}

export function setWhatISaidAnalysisAllowed(input: WhatISaidLocation & {
  allowed: boolean;
  now?: string;
}): WhatISaidStatus {
  const now = iso(input.now);
  if (typeof input.allowed !== "boolean") fail("WHAT_I_SAID_INPUT_INVALID");
  return withDatabase(input, (db, identity) => {
    db.query(`
      UPDATE what_i_said_settings SET analysis_allowed = ?, updated_at = ? WHERE singleton = 1
    `).run(input.allowed ? 1 : 0, now);
    return publicStatus(db, identity, input.memoryId, now);
  });
}

/**
 * Commits a collector checkpoint only after its caller has durably persisted
 * every candidate through this instant. Older/equal retries are harmless.
 */
export function advanceWhatISaidScan(input: WhatISaidLocation & {
  scannedThrough: string;
}): WhatISaidStatus {
  const scannedThrough = iso(input.scannedThrough);
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    const settings = readSettingsRow(db, identity, input.memoryId);
    if (settings.capture_enabled === 1
      && typeof settings.capture_enabled_at === "string"
      && typeof settings.last_scan_at === "string"
      && Date.parse(scannedThrough) >= Date.parse(settings.capture_enabled_at)) {
      const nextScanAt = Date.parse(scannedThrough) > Date.parse(settings.last_scan_at)
        ? scannedThrough
        : settings.last_scan_at;
      const nextCaptureAt = typeof settings.last_capture_at !== "string"
        || Date.parse(scannedThrough) > Date.parse(settings.last_capture_at)
        ? scannedThrough
        : settings.last_capture_at;
      db.query(`
        UPDATE what_i_said_settings
        SET last_scan_at = ?, last_capture_at = ?, updated_at = ?
        WHERE singleton = 1
      `).run(nextScanAt, nextCaptureAt, scannedThrough);
    }
    return publicStatus(db, identity, input.memoryId, scannedThrough);
  }));
}

const TRANSCRIPT_SOURCE_ID = /^wisc_[0-9a-f]{64}$/;

function safeCursorInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function transcriptSourceId(key: Buffer, sourceAgent: WhatISaidAgent, sourceIdentity: string): string {
  if (!boundedText(sourceIdentity, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  return `wisc_${createHmac("sha256", key)
    .update("agentstoz-what-i-said-transcript-source-v1\0", "utf8")
    .update(sourceAgent, "utf8")
    .update("\0", "utf8")
    .update(sourceIdentity, "utf8")
    .digest("hex")}`;
}

function transcriptAnchorHash(input: {
  key: Buffer;
  sourceId: string;
  generation: number;
  byteOffset: number;
  anchor: Uint8Array;
}): string {
  return createHmac("sha256", input.key)
    .update("agentstoz-what-i-said-transcript-anchor-v1\0", "utf8")
    .update(input.sourceId, "utf8")
    .update("\0", "utf8")
    .update(String(input.generation), "utf8")
    .update("\0", "utf8")
    .update(String(input.byteOffset), "utf8")
    .update("\0", "utf8")
    .update(input.anchor)
    .digest("hex");
}

function transcriptCursorFromRow(row: Record<string, unknown> | null): WhatISaidTranscriptCursor | null {
  if (!row) return null;
  const cursor: WhatISaidTranscriptCursor = {
    sourceId: String(row.source_id ?? ""),
    generation: Number(row.generation),
    fileIdentity: String(row.file_identity ?? ""),
    byteOffset: Number(row.byte_offset),
    lineNumber: Number(row.line_number),
    anchorLength: Number(row.anchor_length),
    anchorHash: row.anchor_hash === null ? null : String(row.anchor_hash ?? ""),
    discardUntilNewline: Number(row.discard_until_newline ?? 0) === 1,
  };
  if (!TRANSCRIPT_SOURCE_ID.test(cursor.sourceId)
    || !safeCursorInteger(cursor.generation)
    || !boundedText(cursor.fileIdentity, MAX_SOURCE_ID_BYTES)
    || !safeCursorInteger(cursor.byteOffset)
    || !safeCursorInteger(cursor.lineNumber)
    || !safeCursorInteger(cursor.anchorLength)
    || cursor.anchorLength > 256
    || cursor.anchorLength > cursor.byteOffset
    || (cursor.anchorLength === 0 ? cursor.anchorHash !== null : !SHA256.test(cursor.anchorHash ?? ""))) {
    fail("WHAT_I_SAID_STORE_UNAVAILABLE");
  }
  return cursor;
}

function selectTranscriptCursor(db: Database, sourceId: string): WhatISaidTranscriptCursor | null {
  return transcriptCursorFromRow(db.query(`
    SELECT source_id, generation, file_identity, byte_offset, line_number,
           anchor_length, anchor_hash
           , discard_until_newline
    FROM what_i_said_transcript_cursors WHERE source_id = ?
  `).get(sourceId) as Record<string, unknown> | null);
}

function sameTranscriptCursor(
  left: WhatISaidTranscriptCursor | null,
  right: WhatISaidTranscriptCursor | null,
): boolean {
  if (!left || !right) return left === right;
  return left.sourceId === right.sourceId
    && left.generation === right.generation
    && left.fileIdentity === right.fileIdentity
    && left.byteOffset === right.byteOffset
    && left.lineNumber === right.lineNumber
    && left.anchorLength === right.anchorLength
    && left.anchorHash === right.anchorHash
    && left.discardUntilNewline === right.discardUntilNewline;
}

export function deriveWhatISaidTranscriptSourceId(input: WhatISaidCryptoLocation & {
  agent: WhatISaidAgent;
  sourceIdentity: string;
}): string {
  return transcriptSourceId(keyBuffer(input.key), agent(input.agent), input.sourceIdentity);
}

export function readWhatISaidTranscriptCursor(input: WhatISaidCryptoLocation & {
  agent: WhatISaidAgent;
  sourceIdentity: string;
}): WhatISaidTranscriptCursor | null {
  const key = keyBuffer(input.key);
  const sourceAgent = agent(input.agent);
  const sourceId = transcriptSourceId(key, sourceAgent, input.sourceIdentity);
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    return selectTranscriptCursor(db, sourceId);
  }));
}

export function verifyWhatISaidTranscriptCursorAnchor(input: WhatISaidCryptoLocation & {
  cursor: WhatISaidTranscriptCursor;
  anchor: Uint8Array;
}): boolean {
  const key = keyBuffer(input.key);
  if (!(input.anchor instanceof Uint8Array)
    || input.anchor.byteLength !== input.cursor.anchorLength
    || input.cursor.anchorHash === null) return input.anchor.byteLength === 0 && input.cursor.anchorLength === 0;
  const expected = Buffer.from(transcriptAnchorHash({
    key,
    sourceId: input.cursor.sourceId,
    generation: input.cursor.generation,
    byteOffset: input.cursor.byteOffset,
    anchor: input.anchor,
  }), "hex");
  const actual = Buffer.from(input.cursor.anchorHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function commitWhatISaidTranscriptCursor(input: WhatISaidCryptoLocation & {
  agent: WhatISaidAgent;
  sourceIdentity: string;
  expected: WhatISaidTranscriptCursor | null;
  next: {
    generation: number;
    fileIdentity: string;
    byteOffset: number;
    lineNumber: number;
    anchor: Uint8Array;
    discardUntilNewline?: boolean;
  };
  now?: string;
}): { committed: boolean; cursor: WhatISaidTranscriptCursor } {
  const key = keyBuffer(input.key);
  const sourceAgent = agent(input.agent);
  const sourceId = transcriptSourceId(key, sourceAgent, input.sourceIdentity);
  const now = iso(input.now);
  const next = input.next;
  if (!safeCursorInteger(next.generation)
    || !boundedText(next.fileIdentity, MAX_SOURCE_ID_BYTES)
    || !safeCursorInteger(next.byteOffset)
    || !safeCursorInteger(next.lineNumber)
    || !(next.anchor instanceof Uint8Array)
    || next.anchor.byteLength !== Math.min(256, next.byteOffset)) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  if (input.expected && input.expected.sourceId !== sourceId) fail("WHAT_I_SAID_INPUT_INVALID");
  if (!input.expected) {
    if (next.generation !== 0) fail("WHAT_I_SAID_INPUT_INVALID");
  } else if (next.generation === input.expected.generation) {
    if (next.byteOffset < input.expected.byteOffset || next.lineNumber < input.expected.lineNumber) {
      fail("WHAT_I_SAID_INPUT_INVALID");
    }
  } else if (next.generation !== input.expected.generation + 1) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  const anchorHash = next.anchor.byteLength
    ? transcriptAnchorHash({ key, sourceId, generation: next.generation, byteOffset: next.byteOffset, anchor: next.anchor })
    : null;
  const nextCursor: WhatISaidTranscriptCursor = {
    sourceId,
    generation: next.generation,
    fileIdentity: next.fileIdentity,
    byteOffset: next.byteOffset,
    lineNumber: next.lineNumber,
    anchorLength: next.anchor.byteLength,
    anchorHash,
    discardUntilNewline: next.discardUntilNewline === true,
  };
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const current = selectTranscriptCursor(db, sourceId);
    if (!sameTranscriptCursor(current, input.expected)) {
      if (!current) fail("WHAT_I_SAID_STORE_UNAVAILABLE");
      return { committed: false, cursor: current };
    }
    db.query(`
      INSERT INTO what_i_said_transcript_cursors(
        source_id, source_agent, generation, file_identity, byte_offset,
        line_number, anchor_length, anchor_hash, discard_until_newline, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_agent = excluded.source_agent,
        generation = excluded.generation,
        file_identity = excluded.file_identity,
        byte_offset = excluded.byte_offset,
        line_number = excluded.line_number,
        anchor_length = excluded.anchor_length,
        anchor_hash = excluded.anchor_hash,
        discard_until_newline = excluded.discard_until_newline,
        updated_at = excluded.updated_at
    `).run(
      sourceId,
      sourceAgent,
      nextCursor.generation,
      nextCursor.fileIdentity,
      nextCursor.byteOffset,
      nextCursor.lineNumber,
      nextCursor.anchorLength,
      nextCursor.anchorHash,
      nextCursor.discardUntilNewline ? 1 : 0,
      now,
    );
    return { committed: true, cursor: nextCursor };
  }));
}

/**
 * Persistent round-robin state for recursive transcript discovery. Only keyed
 * source IDs are stored, never a raw session path. This prevents a stable set
 * of unrelated early-sorted files from consuming every byte budget forever.
 */
export function readWhatISaidDiscoveryCursor(input: WhatISaidCryptoLocation & {
  scope: WhatISaidDiscoveryScope;
}): string | null {
  const key = keyBuffer(input.key);
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const row = db.query(`
      SELECT after_source_id FROM what_i_said_discovery_cursors WHERE scope = ?
    `).get(input.scope) as { after_source_id?: unknown } | null;
    if (!row || row.after_source_id === null) return null;
    if (typeof row.after_source_id !== "string" || !TRANSCRIPT_SOURCE_ID.test(row.after_source_id)) {
      fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    }
    return row.after_source_id;
  }));
}

export function commitWhatISaidDiscoveryCursor(input: WhatISaidCryptoLocation & {
  scope: WhatISaidDiscoveryScope;
  expected: string | null;
  next: string;
  now?: string;
}): { committed: boolean; cursor: string | null } {
  if ((input.expected !== null && !TRANSCRIPT_SOURCE_ID.test(input.expected))
    || !TRANSCRIPT_SOURCE_ID.test(input.next)) fail("WHAT_I_SAID_INPUT_INVALID");
  const key = keyBuffer(input.key);
  const now = iso(input.now);
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const row = db.query(`
      SELECT after_source_id FROM what_i_said_discovery_cursors WHERE scope = ?
    `).get(input.scope) as { after_source_id?: unknown } | null;
    const current = row?.after_source_id === null || row === null
      ? null
      : typeof row.after_source_id === "string" && TRANSCRIPT_SOURCE_ID.test(row.after_source_id)
        ? row.after_source_id
        : fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    if (current !== input.expected) return { committed: false, cursor: current };
    db.query(`
      INSERT INTO what_i_said_discovery_cursors(scope, after_source_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        after_source_id = excluded.after_source_id,
        updated_at = excluded.updated_at
    `).run(input.scope, input.next, now);
    return { committed: true, cursor: input.next };
  }));
}

export function readWhatISaidTranscriptClassifications(
  input: WhatISaidCryptoLocation & { sourceIds?: readonly string[] },
): Record<string, WhatISaidTranscriptClassification> {
  if (input.sourceIds && (input.sourceIds.length > 256
    || input.sourceIds.some(id => !TRANSCRIPT_SOURCE_ID.test(id)))) fail("WHAT_I_SAID_INPUT_INVALID");
  const key = keyBuffer(input.key);
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    if (input.sourceIds?.length === 0) return {};
    // Collectors load only the current discovery batch. The full read remains
    // available to diagnostics without retaining every historical row per scan.
    const sourceFilter = input.sourceIds
      ? ` AND source_id IN (${input.sourceIds.map(() => "?").join(",")})`
      : "";
    const rows = db.query(`
      SELECT source_id, file_identity, classified_size, owned
      FROM what_i_said_transcript_classifications
      WHERE source_agent = 'codex'${sourceFilter}
    `).all(...(input.sourceIds ?? [])) as Array<Record<string, unknown>>;
    const result: Record<string, WhatISaidTranscriptClassification> = {};
    for (const row of rows) {
      const sourceId = String(row.source_id ?? "");
      const fileIdentity = String(row.file_identity ?? "");
      const classifiedSize = Number(row.classified_size);
      const owned = Number(row.owned);
      if (!TRANSCRIPT_SOURCE_ID.test(sourceId)
        || !boundedText(fileIdentity, MAX_SOURCE_ID_BYTES)
        || !safeCursorInteger(classifiedSize)
        || (owned !== 0 && owned !== 1)) fail("WHAT_I_SAID_STORE_UNAVAILABLE");
      result[sourceId] = { sourceId, fileIdentity, classifiedSize, owned: owned === 1 };
    }
    return result;
  }));
}

export function commitWhatISaidTranscriptClassifications(input: WhatISaidCryptoLocation & {
  items: readonly WhatISaidTranscriptClassification[];
  now?: string;
}): void {
  if (input.items.length > 10_000) fail("WHAT_I_SAID_INPUT_INVALID");
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!TRANSCRIPT_SOURCE_ID.test(item.sourceId)
      || seen.has(item.sourceId)
      || !boundedText(item.fileIdentity, MAX_SOURCE_ID_BYTES)
      || !safeCursorInteger(item.classifiedSize)
      || typeof item.owned !== "boolean") fail("WHAT_I_SAID_INPUT_INVALID");
    seen.add(item.sourceId);
  }
  if (input.items.length === 0) return;
  const key = keyBuffer(input.key);
  const now = iso(input.now);
  withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const upsert = db.query(`
      INSERT INTO what_i_said_transcript_classifications(
        source_id, source_agent, file_identity, classified_size, owned, updated_at
      ) VALUES (?, 'codex', ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_agent = 'codex',
        file_identity = excluded.file_identity,
        classified_size = excluded.classified_size,
        owned = excluded.owned,
        updated_at = excluded.updated_at
    `);
    for (const item of input.items) {
      upsert.run(item.sourceId, item.fileIdentity, item.classifiedSize, item.owned ? 1 : 0, now);
    }
  }));
}

export function disableWhatISaidCapture(input: WhatISaidLocation & { now?: string }): WhatISaidStatus {
  const now = iso(input.now);
  return withDatabase(input, (db, identity) => {
    db.query(`
      UPDATE what_i_said_settings SET capture_enabled = 0, updated_at = ? WHERE singleton = 1
    `).run(now);
    return publicStatus(db, identity, input.memoryId, now);
  });
}

export type CaptureWhatISaidResult =
  | { stored: true; duplicate: boolean; id: string; seq: string }
  | { stored: false; reason: "disabled" | "before-enabled" | "expired" | "prompt-too-large"; id: string };

export type CaptureWhatISaidWithheldResult =
  | { stored: true; duplicate: boolean; id: string }
  | { stored: false; reason: "disabled"; id: string };

/**
 * Leaves a keyed, content-free receipt before a permanently unusable JSONL
 * record is skipped. The cursor may advance only after this succeeds, so one
 * malformed or enormous record cannot permanently hide later normal prompts
 * and no raw bytes from that record enter SQLite.
 */
export function captureWhatISaidWithheldTranscriptRecord(input: WhatISaidCryptoLocation & {
  agent: WhatISaidAgent;
  sourceIdentity: string;
  sourceEventIdentity: string;
  recordBytes: number;
  reason: "record-too-large" | "record-malformed";
  now?: string;
}): CaptureWhatISaidWithheldResult {
  if (!safeCursorInteger(input.recordBytes) || input.recordBytes < 1) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  const key = keyBuffer(input.key);
  const sourceAgent = agent(input.agent);
  const now = iso(input.now);
  const eventId = deriveWhatISaidSourceEventId({
    key,
    agent: sourceAgent,
    sourceIdentity: input.sourceIdentity,
    sourceEventIdentity: input.sourceEventIdentity,
  });
  const hash = createHmac("sha256", key)
    .update("agentstoz-what-i-said-withheld-v1\0", "utf8")
    .update(input.reason, "utf8")
    .update("\0", "utf8")
    .update(String(input.recordBytes), "utf8")
    .digest("hex");
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const settings = readSettingsRow(db, identity, input.memoryId);
    if (settings.capture_enabled !== 1) return { stored: false, reason: "disabled", id: eventId };
    const existing = db.query(`
      SELECT content_hash, withheld_reason FROM what_i_said_events WHERE event_id = ?
    `).get(eventId) as { content_hash?: unknown; withheld_reason?: unknown } | null;
    if (existing) {
      if (existing.content_hash !== hash || existing.withheld_reason !== input.reason) {
        fail("WHAT_I_SAID_SOURCE_EVENT_CONFLICT");
      }
      return { stored: true, duplicate: true, id: eventId };
    }
    db.query(`
      INSERT INTO what_i_said_events(
        event_id, source_agent, recorded_at, captured_at, content_hash,
        nonce, ciphertext, auth_tag, retention_until, deleted_at, purged_at, withheld_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
    `).run(eventId, sourceAgent, now, now, hash, now, now, input.reason);
    return { stored: true, duplicate: false, id: eventId };
  }));
}

const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_NAME_LENGTH = 80;

/**
 * 기기 정보는 없을 수도 있고(포털 설정 전) 사용자가 고친 값일 수도 있다. 비었거나
 * 길이를 넘으면 저장을 실패시키지 않고 null 로 떨어뜨린다 — 부가 정보 하나 때문에
 * 프롬프트를 잃는 쪽이 훨씬 나쁘다.
 */
function normalizedDeviceField(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

export function captureWhatISaidPrompt(input: WhatISaidCryptoLocation & {
  agent: WhatISaidAgent;
  sourceIdentity: string;
  sourceEventIdentity: string;
  recordedAt: string;
  text: string;
  /** 수집한 기기. 없으면 기록하지 않는다 — 모르는 것을 지어내지 않는다. */
  deviceId?: string | null;
  deviceName?: string | null;
  /** Proven only by the local AgentsToZ clipboard registry; omitted means unknown. */
  promptOrigin?: WhatISaidPromptOrigin;
  /** Stable collector identity across transcript truncate/replace generations. */
  replayIdentity?: string;
  /**
   * Explicit user-initiated backfill. Turning capture on records the instant of
   * consent and everything before it is refused, which is right for automatic
   * capture — but it also means a freshly enabled project stays empty until the
   * next session save. This lets the user deliberately ask for the existing
   * history, and only then. Retention and size limits still apply.
   */
  allowBeforeEnabled?: boolean;
  now?: string;
}): CaptureWhatISaidResult {
  const key = keyBuffer(input.key);
  const sourceAgent = agent(input.agent);
  const now = iso(input.now);
  const recordedAt = iso(input.recordedAt);
  const deviceId = normalizedDeviceField(input.deviceId, MAX_DEVICE_ID_LENGTH);
  const deviceName = normalizedDeviceField(input.deviceName, MAX_DEVICE_NAME_LENGTH);
  const storedPromptOrigin = promptOrigin(input.promptOrigin);
  if (typeof input.text !== "string"
    || input.text.length === 0
    || input.text.includes("\0")) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  const eventId = deriveWhatISaidSourceEventId({
    key,
    agent: sourceAgent,
    sourceIdentity: input.sourceIdentity,
    sourceEventIdentity: input.sourceEventIdentity,
  });
  const hash = contentHash(key, input.text);
  if (input.replayIdentity !== undefined
    && !boundedText(input.replayIdentity, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  const replayHash = input.replayIdentity === undefined ? null : createHmac("sha256", key)
    .update("agentstoz-what-i-said-replay-receipt-v1\0", "utf8")
    .update(sourceAgent, "utf8")
    .update("\0", "utf8")
    .update(input.replayIdentity, "utf8")
    .update("\0", "utf8")
    .update(recordedAt, "utf8")
    .update("\0", "utf8")
    .update(hash, "utf8")
    .digest("hex");

  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const settings = readSettingsRow(db, identity, input.memoryId);
    if (settings.capture_enabled !== 1 || typeof settings.capture_enabled_at !== "string") {
      return { stored: false, reason: "disabled", id: eventId };
    }
    if (input.allowBeforeEnabled !== true
      && Date.parse(recordedAt) < Date.parse(settings.capture_enabled_at)) {
      return { stored: false, reason: "before-enabled", id: eventId };
    }
    const existing = db.query(`
      SELECT CAST(seq AS TEXT) AS seq, content_hash, withheld_reason
      FROM what_i_said_events WHERE event_id = ?
    `).get(eventId) as { seq?: unknown; content_hash?: unknown; withheld_reason?: unknown } | null;
    if (existing) {
      if (existing.content_hash !== hash) fail("WHAT_I_SAID_SOURCE_EVENT_CONFLICT");
      if (existing.withheld_reason === "prompt-too-large") {
        return { stored: false, reason: "prompt-too-large", id: eventId };
      }
      return { stored: true, duplicate: true, id: eventId, seq: String(existing.seq) };
    }
    // A transcript generation changes event_id. The optional collector-only
    // replay receipt preserves deletion without collapsing two distinct user
    // events that merely have the same text and timestamp.
    const samePrompt = replayHash === null ? null : db.query(`
      SELECT CAST(seq AS TEXT) AS seq, event_id, withheld_reason
      FROM what_i_said_events
      WHERE replay_hash = ? LIMIT 1
    `).get(replayHash) as {
      seq?: unknown;
      event_id?: unknown;
      withheld_reason?: unknown;
    } | null;
    if (samePrompt) {
      const existingId = String(samePrompt.event_id ?? "");
      const existingSeq = String(samePrompt.seq ?? "");
      if (!EVENT_ID.test(existingId) || !SEQUENCE.test(existingSeq)) {
        fail("WHAT_I_SAID_STORE_UNAVAILABLE");
      }
      if (samePrompt.withheld_reason === "prompt-too-large") {
        return { stored: false, reason: "prompt-too-large", id: existingId };
      }
      return { stored: true, duplicate: true, id: existingId, seq: existingSeq };
    }
    const retention = parseRetention(settings.retention_policy)!;
    const expiresAt = retentionUntil(retention, recordedAt);
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now)) {
      return { stored: false, reason: "expired", id: eventId };
    }
    if (Buffer.byteLength(input.text, "utf8") > WHAT_I_SAID_MAX_PROMPT_BYTES) {
      db.query(`
        INSERT INTO what_i_said_events(
          event_id, source_agent, recorded_at, captured_at, content_hash, replay_hash,
          nonce, ciphertext, auth_tag, retention_until, deleted_at, purged_at, withheld_reason,
          device_id, device_name, prompt_origin
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'prompt-too-large', ?, ?, ?)
      `).run(eventId, sourceAgent, recordedAt, now, hash, replayHash, now, now, deviceId, deviceName, storedPromptOrigin);
      return { stored: false, reason: "prompt-too-large", id: eventId };
    }
    const encrypted = encryptText({
      key,
      memoryId: input.memoryId,
      eventId,
      agent: sourceAgent,
      recordedAt,
      text: input.text,
      hash,
    });
    db.query(`
      INSERT INTO what_i_said_events(
        event_id, source_agent, recorded_at, captured_at, content_hash, replay_hash,
        nonce, ciphertext, auth_tag, retention_until, deleted_at, purged_at, withheld_reason,
        device_id, device_name, prompt_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `).run(
      eventId,
      sourceAgent,
      recordedAt,
      now,
      hash,
      replayHash,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authTag,
      expiresAt,
      deviceId,
      deviceName,
      storedPromptOrigin,
    );
    const inserted = db.query(`
      SELECT CAST(seq AS TEXT) AS seq FROM what_i_said_events WHERE event_id = ?
    `).get(eventId) as { seq?: unknown } | null;
    if (!inserted || typeof inserted.seq !== "string") fail("WHAT_I_SAID_STORE_UNAVAILABLE");
    return { stored: true, duplicate: false, id: eventId, seq: inserted.seq };
  }));
}

function validatedSequence(value: string | null | undefined): string {
  if (value === undefined || value === null) return "0";
  if (!SEQUENCE.test(value)) fail("WHAT_I_SAID_INPUT_INVALID");
  return value;
}

export function listWhatISaidEntries(input: WhatISaidCryptoLocation & {
  afterSeq?: string | null;
  limit?: number;
  now?: string;
}): { items: WhatISaidEntry[]; nextSeq: string | null } {
  const key = keyBuffer(input.key);
  const afterSeq = validatedSequence(input.afterSeq);
  const limit = input.limit ?? 100;
  const now = iso(input.now);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) fail("WHAT_I_SAID_INPUT_INVALID");
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const rows = db.query(`
      SELECT CAST(seq AS TEXT) AS seq, event_id, source_agent, recorded_at, captured_at,
             content_hash, nonce, ciphertext, auth_tag, retention_until, device_id, device_name,
             prompt_origin
      FROM what_i_said_events
      WHERE seq > CAST(? AS INTEGER)
        AND deleted_at IS NULL AND purged_at IS NULL
        AND (retention_until IS NULL OR retention_until > ?)
      ORDER BY seq ASC LIMIT ?
    `).all(afterSeq, now, limit) as EventRow[];
    const items = rows.map(row => ({
      id: String(row.event_id),
      seq: String(row.seq),
      agent: row.source_agent as WhatISaidAgent,
      recordedAt: String(row.recorded_at),
      capturedAt: String(row.captured_at),
      text: decryptRow(key, input.memoryId, row),
      contentHash: String(row.content_hash),
      retentionUntil: typeof row.retention_until === "string" ? row.retention_until : null,
      deviceId: typeof row.device_id === "string" ? row.device_id : null,
      deviceName: typeof row.device_name === "string" ? row.device_name : null,
      promptOrigin: promptOrigin(row.prompt_origin),
    }));
    return { items, nextSeq: items.at(-1)?.seq ?? null };
  }));
}

/** Newest-first local UI page. Sequence values stay decimal strings end-to-end. */
export function listRecentWhatISaidEntries(input: WhatISaidCryptoLocation & {
  beforeSeq?: string | null;
  limit?: number;
  now?: string;
}): { items: WhatISaidEntry[]; nextBeforeSeq: string | null } {
  const key = keyBuffer(input.key);
  const beforeSeq = input.beforeSeq === undefined || input.beforeSeq === null
    ? null
    : validatedSequence(input.beforeSeq);
  const limit = input.limit ?? 100;
  const now = iso(input.now);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) fail("WHAT_I_SAID_INPUT_INVALID");
  return withDatabase(input, (db, identity) => runTransaction(db, () => {
    bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
    const rows = db.query(`
      SELECT CAST(seq AS TEXT) AS seq, event_id, source_agent, recorded_at, captured_at,
             content_hash, nonce, ciphertext, auth_tag, retention_until, device_id, device_name,
             prompt_origin
      FROM what_i_said_events
      WHERE (? IS NULL OR seq < CAST(? AS INTEGER))
        AND deleted_at IS NULL AND purged_at IS NULL
        AND (retention_until IS NULL OR retention_until > ?)
      ORDER BY seq DESC LIMIT ?
    `).all(beforeSeq, beforeSeq, now, limit) as EventRow[];
    const items = rows.map(row => ({
      id: String(row.event_id),
      seq: String(row.seq),
      agent: row.source_agent as WhatISaidAgent,
      recordedAt: String(row.recorded_at),
      capturedAt: String(row.captured_at),
      text: decryptRow(key, input.memoryId, row),
      contentHash: String(row.content_hash),
      retentionUntil: typeof row.retention_until === "string" ? row.retention_until : null,
      deviceId: typeof row.device_id === "string" ? row.device_id : null,
      deviceName: typeof row.device_name === "string" ? row.device_name : null,
      promptOrigin: promptOrigin(row.prompt_origin),
    }));
    return {
      items,
      nextBeforeSeq: rows.length === limit ? items.at(-1)?.seq ?? null : null,
    };
  }));
}

function validatedEventIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (!unique.length || unique.some(id => !EVENT_ID.test(id))) fail("WHAT_I_SAID_INPUT_INVALID");
  return unique;
}

function rotateEpoch(db: Database, now: string): void {
  db.query(`
    UPDATE what_i_said_settings SET index_epoch = ?, updated_at = ? WHERE singleton = 1
  `).run(randomUUID(), now);
}

export function softDeleteWhatISaidEntries(input: WhatISaidLocation & {
  ids: readonly string[];
  now?: string;
}): { softDeleted: number } {
  const ids = validatedEventIds(input.ids);
  const now = iso(input.now);
  return withDatabase(input, db => runTransaction(db, () => {
    let softDeleted = 0;
    for (const id of ids) {
      softDeleted += db.query(`
        UPDATE what_i_said_events SET deleted_at = ?
        WHERE event_id = ? AND deleted_at IS NULL
      `).run(now, id).changes;
    }
    if (softDeleted > 0) rotateEpoch(db, now);
    return { softDeleted };
  }));
}

/** Read-only identity preflight for a remote-first delete. The caller must
 * establish that the local row exists before deleting its remote projection;
 * otherwise a stale id could remove only the remote row and then return a
 * misleading local 404. */
export function hasActiveWhatISaidEntry(input: WhatISaidLocation & { id: string }): boolean {
  const id = validatedEventIds([input.id])[0]!;
  return withDatabase(input, db => {
    const row = db.query(`
      SELECT 1 AS found
      FROM what_i_said_events
      WHERE event_id = ? AND deleted_at IS NULL AND purged_at IS NULL
      LIMIT 1
    `).get(id) as { found?: unknown } | null;
    return row?.found === 1;
  });
}

export function softDeleteAllWhatISaidEntries(
  input: WhatISaidLocation & { now?: string },
): { softDeleted: number };
export function softDeleteAllWhatISaidEntries(
  location: WhatISaidLocation,
  options?: { now?: string },
): { softDeleted: number };
export function softDeleteAllWhatISaidEntries(
  location: WhatISaidLocation & { now?: string },
  options: { now?: string } = {},
): { softDeleted: number } {
  const input = { ...location, ...options };
  const now = iso(input.now);
  return withDatabase(input, db => runTransaction(db, () => {
    const softDeleted = db.query(`
      UPDATE what_i_said_events SET deleted_at = ? WHERE deleted_at IS NULL
    `).run(now).changes;
    if (softDeleted > 0) rotateEpoch(db, now);
    return { softDeleted };
  }));
}

export function purgeWhatISaidEntries(input: WhatISaidLocation & {
  ids?: readonly string[];
  includeExpired?: boolean;
  now?: string;
}): { purged: number } {
  const ids = input.ids === undefined ? [] : validatedEventIds(input.ids);
  if (!ids.length && input.includeExpired !== true) fail("WHAT_I_SAID_INPUT_INVALID");
  const now = iso(input.now);
  return withDatabase(input, db => runTransaction(db, () => {
    assertKeyBoundBeforeCiphertextPurge(db);
    let purged = 0;
    for (const id of ids) {
      purged += db.query(`
        UPDATE what_i_said_events
        SET deleted_at = COALESCE(deleted_at, ?), purged_at = ?,
            nonce = NULL, ciphertext = NULL, auth_tag = NULL
        WHERE event_id = ? AND purged_at IS NULL
      `).run(now, now, id).changes;
    }
    if (input.includeExpired === true) {
      purged += db.query(`
        UPDATE what_i_said_events
        SET deleted_at = COALESCE(deleted_at, ?), purged_at = ?,
            nonce = NULL, ciphertext = NULL, auth_tag = NULL
        WHERE purged_at IS NULL AND retention_until IS NOT NULL AND retention_until <= ?
      `).run(now, now, now).changes;
    }
    if (purged > 0) rotateEpoch(db, now);
    return { purged };
  }));
}

/** Irreversibly removes every remaining ciphertext while retaining only the
 * keyed receipt needed to keep an overlapping transcript scan idempotent. */
export function purgeAllWhatISaidEntries(
  input: WhatISaidLocation & { now?: string },
): { purged: number } {
  const now = iso(input.now);
  return withDatabase(input, db => runTransaction(db, () => {
    assertKeyBoundBeforeCiphertextPurge(db);
    const purged = db.query(`
      UPDATE what_i_said_events
      SET deleted_at = COALESCE(deleted_at, ?), purged_at = ?,
          nonce = NULL, ciphertext = NULL, auth_tag = NULL
      WHERE purged_at IS NULL
    `).run(now, now).changes;
    if (purged > 0) rotateEpoch(db, now);
    return { purged };
  }));
}

export function purgeExpiredWhatISaidEntries(
  input: WhatISaidLocation & { now?: string },
): { purged: number } {
  return purgeWhatISaidEntries({ ...input, includeExpired: true });
}

/** Retention sweep for stores whose project was unregistered or moved out of
 * the current ports list. It never decrypts content and opens only regular,
 * hash-named DB files inside the private What-I-said directory. */
export function purgeExpiredWhatISaidDatabases(input: {
  appDataDir: string;
  now?: string;
}): { databases: number; purged: number; unavailable: number } {
  const now = iso(input.now);
  const appData = resolve(input.appDataDir);
  if (!existsSync(appData)) return { databases: 0, purged: 0, unavailable: 0 };
  const appDataInfo = lstatSync(appData);
  if (appDataInfo.isSymbolicLink() || !appDataInfo.isDirectory()) fail("WHAT_I_SAID_PATH_UNSAFE");
  const directory = join(realpathSync(appData), STORAGE_DIRECTORY);
  if (!existsSync(directory)) return { databases: 0, purged: 0, unavailable: 0 };
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || realpathSync(directory) !== directory) {
    fail("WHAT_I_SAID_PATH_UNSAFE");
  }
  let databases = 0;
  let purged = 0;
  let unavailable = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[0-9a-f]{64}\.sqlite$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      unavailable += 1;
      continue;
    }
    databases += 1;
    let db: Database | null = null;
    try {
      // Revalidate the database and all SQLite sidecars immediately before the
      // background read-write open. A hash-named regular Dirent alone does not
      // make a swapped `-wal`/`-journal` symlink safe.
      assertRegularDatabaseFiles(path);
      db = new Database(path, { create: false, readwrite: true });
      db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
        PRAGMA busy_timeout = 3000;
      `);
      const settings = db.query(`
        SELECT schema_version, key_verifier FROM what_i_said_settings WHERE singleton = 1
      `).get() as { schema_version?: unknown; key_verifier?: unknown } | null;
      if (settings?.schema_version !== 3 && settings?.schema_version !== 4
        && settings?.schema_version !== 5 && settings?.schema_version !== STORE_SCHEMA_VERSION) {
        unavailable += 1;
        continue;
      }
      purged += runTransaction(db, () => {
        const hasExpiredCiphertext = db!.query(`
          SELECT 1 AS found FROM what_i_said_events
          WHERE purged_at IS NULL AND retention_until IS NOT NULL AND retention_until <= ? LIMIT 1
        `).get(now) !== null;
        if (hasExpiredCiphertext
          && (typeof settings?.key_verifier !== "string" || !SHA256.test(settings.key_verifier))) {
          fail("WHAT_I_SAID_KEY_INVALID");
        }
        const changed = db!.query(`
          UPDATE what_i_said_events
          SET deleted_at = COALESCE(deleted_at, ?), purged_at = ?,
              nonce = NULL, ciphertext = NULL, auth_tag = NULL
          WHERE purged_at IS NULL AND retention_until IS NOT NULL AND retention_until <= ?
        `).run(now, now, now).changes;
        if (changed > 0) rotateEpoch(db!, now);
        return changed;
      });
    } catch {
      unavailable += 1;
    } finally {
      db?.close();
    }
  }
  return { databases, purged, unavailable };
}

function tokenFromBytes(value?: Uint8Array): string {
  const bytes = value === undefined ? randomBytes(32) : Buffer.from(value);
  if (bytes.byteLength !== 32) fail("WHAT_I_SAID_INPUT_INVALID");
  return bytes.toString("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function feedKeyAad(memoryId: string, registrationId: string): Buffer {
  return Buffer.from([
    "agentstoz-what-i-said-feed-key-v1",
    memoryId,
    registrationId,
  ].join("\0"), "utf8");
}

function encryptFeedKey(
  key: Buffer,
  memoryId: string,
  registrationId: string,
  feedKey: Buffer,
): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(feedKeyAad(memoryId, registrationId));
  const ciphertext = Buffer.concat([cipher.update(feedKey), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptFeedKey(key: Buffer, memoryId: string, settings: SettingsRow): Buffer {
  try {
    if (settings.feed_enabled !== 1
      || settings.feed_token_hash !== ENCRYPTED_FEED_KEY_SENTINEL
      || typeof settings.feed_registration_id !== "string") {
      fail("WHAT_I_SAID_FEED_DISABLED");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, bytes(settings.feed_key_nonce));
    decipher.setAAD(feedKeyAad(memoryId, settings.feed_registration_id));
    decipher.setAuthTag(bytes(settings.feed_key_auth_tag));
    const feedKey = Buffer.concat([
      decipher.update(bytes(settings.feed_key_ciphertext)),
      decipher.final(),
    ]);
    if (feedKey.byteLength !== 32) fail("WHAT_I_SAID_KEY_INVALID");
    return feedKey;
  } catch (error) {
    if (error instanceof WhatISaidStoreError) throw error;
    fail("WHAT_I_SAID_KEY_INVALID");
  }
}

function feedRegistrationMatchesOrRevoke(
  db: Database,
  settings: SettingsRow,
  expectedRegistrationId: string,
): boolean {
  if (!boundedText(expectedRegistrationId, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  if (settings.feed_enabled !== 1) return false;
  if (settings.feed_registration_id === expectedRegistrationId) return true;
  const now = new Date().toISOString();
  runTransaction(db, () => {
    db.query(`
      UPDATE what_i_said_settings
      SET feed_enabled = 0, feed_token_hash = NULL,
          feed_key_nonce = NULL, feed_key_ciphertext = NULL, feed_key_auth_tag = NULL,
          feed_registration_id = NULL, feed_token_updated_at = ?,
          index_epoch = ?, updated_at = ?
      WHERE singleton = 1
    `).run(now, randomUUID(), now);
  });
  return false;
}

export function enableWhatISaidFeed(input: WhatISaidCryptoLocation & {
  registrationId: string;
  now?: string;
  tokenBytes?: Uint8Array;
}): { token: string; status: WhatISaidStatus["feed"] } {
  if (!boundedText(input.registrationId, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  const now = iso(input.now);
  const token = tokenFromBytes(input.tokenBytes);
  const key = keyBuffer(input.key);
  const feedKey = Buffer.from(tokenHash(token), "hex");
  try {
    return withDatabase(input, (db, identity) => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const encrypted = encryptFeedKey(key, input.memoryId, input.registrationId, feedKey);
      db.query(`
        UPDATE what_i_said_settings
        SET feed_enabled = 1, feed_token_hash = ?,
            feed_key_nonce = ?, feed_key_ciphertext = ?, feed_key_auth_tag = ?,
            feed_registration_id = ?, feed_token_updated_at = ?,
            index_epoch = ?, updated_at = ?
        WHERE singleton = 1
      `).run(
        ENCRYPTED_FEED_KEY_SENTINEL,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        input.registrationId,
        now,
        randomUUID(),
        now,
      );
      return { token, status: publicStatus(db, identity, input.memoryId, now).feed };
    });
  } finally {
    key.fill(0);
    feedKey.fill(0);
  }
}

/** Rebinds the same feed secret to a surviving registration in one transaction. */
export function rebindWhatISaidFeedRegistration(input: WhatISaidCryptoLocation & {
  registrationId: string;
  now?: string;
}): WhatISaidStatus["feed"] {
  if (!boundedText(input.registrationId, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  const now = iso(input.now);
  const key = keyBuffer(input.key);
  try {
    return withDatabase(input, (db, identity) => runTransaction(db, () => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const settings = readSettingsRow(db, identity, input.memoryId);
      if (settings.feed_enabled !== 1) return publicStatus(db, identity, input.memoryId, now).feed;
      if (settings.feed_registration_id === input.registrationId) {
        return publicStatus(db, identity, input.memoryId, now).feed;
      }
      const feedKey = decryptFeedKey(key, input.memoryId, settings);
      try {
        const encrypted = encryptFeedKey(key, input.memoryId, input.registrationId, feedKey);
        db.query(`
          UPDATE what_i_said_settings
          SET feed_key_nonce = ?, feed_key_ciphertext = ?, feed_key_auth_tag = ?,
              feed_registration_id = ?, updated_at = ?
          WHERE singleton = 1 AND feed_enabled = 1
        `).run(
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
          input.registrationId,
          now,
        );
        return publicStatus(db, identity, input.memoryId, now).feed;
      } finally {
        feedKey.fill(0);
      }
    }));
  } finally {
    key.fill(0);
  }
}

export function rotateWhatISaidFeedToken(input: WhatISaidCryptoLocation & {
  now?: string;
  tokenBytes?: Uint8Array;
}): { token: string; status: WhatISaidStatus["feed"] } {
  const now = iso(input.now);
  const token = tokenFromBytes(input.tokenBytes);
  const key = keyBuffer(input.key);
  const feedKey = Buffer.from(tokenHash(token), "hex");
  try {
    return withDatabase(input, (db, identity) => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const settings = readSettingsRow(db, identity, input.memoryId);
      if (settings.feed_enabled !== 1 || typeof settings.feed_registration_id !== "string") {
        fail("WHAT_I_SAID_FEED_DISABLED");
      }
      const encrypted = encryptFeedKey(key, input.memoryId, settings.feed_registration_id, feedKey);
      db.query(`
        UPDATE what_i_said_settings
        SET feed_token_hash = ?, feed_key_nonce = ?, feed_key_ciphertext = ?,
            feed_key_auth_tag = ?, feed_token_updated_at = ?, updated_at = ?
        WHERE singleton = 1
      `).run(
        ENCRYPTED_FEED_KEY_SENTINEL,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        now,
        now,
      );
      return { token, status: publicStatus(db, identity, input.memoryId, now).feed };
    });
  } finally {
    key.fill(0);
    feedKey.fill(0);
  }
}

export function revokeWhatISaidFeed(input: WhatISaidLocation & { now?: string }): WhatISaidStatus["feed"] {
  const now = iso(input.now);
  return withDatabase(input, (db, identity) => {
    db.query(`
      UPDATE what_i_said_settings
      SET feed_enabled = 0, feed_token_hash = NULL,
          feed_key_nonce = NULL, feed_key_ciphertext = NULL, feed_key_auth_tag = NULL,
          feed_registration_id = NULL, feed_token_updated_at = ?,
          index_epoch = ?, updated_at = ?
      WHERE singleton = 1
    `).run(now, randomUUID(), now);
    return publicStatus(db, identity, input.memoryId, now).feed;
  });
}

/**
 * Revokes a feed for a registration that no longer has a usable local path.
 * The scan never decrypts prompts or creates a database. Legacy enabled stores
 * without a registration binding make the operation fail closed because the
 * caller cannot prove which registration owns that credential.
 */
export function revokeWhatISaidFeedByRegistrationId(input: {
  appDataDir: string;
  registrationId: string;
  now?: string;
}): { revoked: number } {
  if (!boundedText(input.registrationId, MAX_SOURCE_ID_BYTES)) fail("WHAT_I_SAID_INPUT_INVALID");
  const now = iso(input.now);
  const appData = resolve(input.appDataDir);
  if (!existsSync(appData)) return { revoked: 0 };
  const appDataInfo = lstatSync(appData);
  if (appDataInfo.isSymbolicLink() || !appDataInfo.isDirectory()) fail("WHAT_I_SAID_PATH_UNSAFE");
  const directory = join(realpathSync(appData), STORAGE_DIRECTORY);
  if (!existsSync(directory)) return { revoked: 0 };
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || realpathSync(directory) !== directory) {
    fail("WHAT_I_SAID_PATH_UNSAFE");
  }

  const matches: string[] = [];
  let ambiguous = false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[0-9a-f]{64}\.sqlite$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      // A hash-named unsafe entry could be a temporarily swapped-out enabled
      // store. Treat it as ambiguous so revocation cannot report success and
      // later let the restored credential become live again.
      ambiguous = true;
      continue;
    }
    const path = join(directory, entry.name);
    let db: Database | null = null;
    try {
      assertRegularDatabaseFiles(path);
      db = new Database(path, { readonly: true, create: false });
      const version = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
      if (version !== 3 && version !== 4 && version !== 5 && version !== STORE_SCHEMA_VERSION) {
        const legacy = db.query(`SELECT feed_enabled FROM what_i_said_settings WHERE singleton = 1`)
          .get() as { feed_enabled?: unknown } | null;
        if (legacy?.feed_enabled === 1) ambiguous = true;
        continue;
      }
      const settings = db.query(`SELECT feed_enabled, feed_registration_id FROM what_i_said_settings WHERE singleton = 1`)
        .get() as { feed_enabled?: unknown; feed_registration_id?: unknown } | null;
      if (settings?.feed_enabled !== 1) continue;
      if (!boundedText(settings.feed_registration_id, MAX_SOURCE_ID_BYTES)) {
        ambiguous = true;
        continue;
      }
      if (settings.feed_registration_id === input.registrationId) matches.push(path);
    } catch {
      // A transiently unreadable store may become usable again after the
      // registration disappears. Ownership cannot be disproved, so deletion
      // must fail closed instead of letting an old credential revive later.
      ambiguous = true;
    } finally {
      db?.close();
    }
  }
  if (ambiguous) fail("WHAT_I_SAID_FEED_REGISTRATION_AMBIGUOUS");

  let revoked = 0;
  for (const path of matches) {
    let db: Database | null = null;
    try {
      // Revalidate immediately before the read-write open; the read-only scan
      // above is not authority if the path was swapped in between passes.
      assertRegularDatabaseFiles(path);
      db = new Database(path, { create: false, readwrite: true });
      db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;`);
      revoked += db.query(`
        UPDATE what_i_said_settings
        SET feed_enabled = 0, feed_token_hash = NULL,
            feed_key_nonce = NULL, feed_key_ciphertext = NULL, feed_key_auth_tag = NULL,
            feed_registration_id = NULL, feed_token_updated_at = ?,
            index_epoch = ?, updated_at = ?
        WHERE singleton = 1 AND feed_enabled = 1 AND feed_registration_id = ?
      `).run(now, randomUUID(), now, input.registrationId).changes;
    } finally {
      db?.close();
    }
  }
  return { revoked };
}

const FEED_AUTHORIZATION = /^AgentsToZ-HMAC v1:([0-9a-f]{64}):([0-9a-f]{64})$/;

function feedProofParts(authorization: string | null | undefined): {
  challenge: string;
  signature: string;
} | null {
  const match = typeof authorization === "string" ? FEED_AUTHORIZATION.exec(authorization) : null;
  return match ? { challenge: match[1]!, signature: match[2]! } : null;
}

function feedProof(feedKey: Uint8Array, challenge: string, requestTarget: string): Buffer {
  return createHmac("sha256", feedKey)
    .update("agentstoz-what-i-said-feed-request-v1\0", "utf8")
    .update(challenge, "utf8")
    .update("\0GET\0", "utf8")
    .update(requestTarget, "utf8")
    .digest();
}

function feedResponseProof(
  feedKey: Uint8Array,
  challenge: string,
  requestTarget: string,
  responseBody: string,
): Buffer {
  const bodyHash = createHash("sha256").update(responseBody, "utf8").digest("hex");
  return createHmac("sha256", feedKey)
    .update("agentstoz-what-i-said-feed-response-v1\0", "utf8")
    .update(challenge, "utf8")
    .update("\0GET\0", "utf8")
    .update(requestTarget, "utf8")
    .update("\0", "utf8")
    .update(bodyHash, "utf8")
    .digest();
}

export function createWhatISaidFeedAuthorization(input: {
  token: string;
  challenge: string;
  requestTarget: string;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.token)
    || !/^[0-9a-f]{64}$/.test(input.challenge)
    || !input.requestTarget.startsWith("/api/what-i-said/feed")
    || input.requestTarget.includes("\r")
    || input.requestTarget.includes("\n")) {
    fail("WHAT_I_SAID_INPUT_INVALID");
  }
  const feedKey = Buffer.from(tokenHash(input.token), "hex");
  try {
    const signature = feedProof(feedKey, input.challenge, input.requestTarget).toString("hex");
    return `AgentsToZ-HMAC v1:${input.challenge}:${signature}`;
  } finally {
    feedKey.fill(0);
  }
}

export function whatISaidFeedAuthorizationChallenge(
  authorization: string | null | undefined,
): string | null {
  return feedProofParts(authorization)?.challenge ?? null;
}

export function createWhatISaidFeedResponseProof(input: WhatISaidCryptoLocation & {
  expectedRegistrationId: string;
  authorization: string;
  requestTarget: string;
  responseBody: string;
}): string {
  const proof = feedProofParts(input.authorization);
  if (!proof || typeof input.responseBody !== "string") fail("WHAT_I_SAID_INPUT_INVALID");
  const key = keyBuffer(input.key);
  try {
    return withDatabase(input, (db, identity) => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const settings = readSettingsRow(db, identity, input.memoryId);
      if (settings.feed_enabled !== 1) fail("WHAT_I_SAID_FEED_DISABLED");
      if (!feedRegistrationMatchesOrRevoke(db, settings, input.expectedRegistrationId)) {
        fail("WHAT_I_SAID_FEED_UNAUTHORIZED");
      }
      const feedKey = decryptFeedKey(key, input.memoryId, settings);
      try {
        if (!authorizedWithFeedKey(feedKey, input.authorization, input.requestTarget)) {
          fail("WHAT_I_SAID_FEED_UNAUTHORIZED");
        }
        const signature = feedResponseProof(
          feedKey,
          proof.challenge,
          input.requestTarget,
          input.responseBody,
        ).toString("hex");
        return `v1:${proof.challenge}:${signature}`;
      } finally {
        feedKey.fill(0);
      }
    });
  } finally {
    key.fill(0);
  }
}

export function verifyWhatISaidFeedResponseProof(input: {
  token: string;
  authorization: string;
  requestTarget: string;
  responseBody: string;
  responseProof: string | null | undefined;
}): boolean {
  if (!/^[0-9a-f]{64}$/.test(input.token)) return false;
  const authorization = feedProofParts(input.authorization);
  const received = typeof input.responseProof === "string"
    ? /^v1:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(input.responseProof)
    : null;
  if (!authorization || !received || received[1] !== authorization.challenge) return false;
  const feedKey = Buffer.from(tokenHash(input.token), "hex");
  try {
    const expected = feedResponseProof(
      feedKey,
      authorization.challenge,
      input.requestTarget,
      input.responseBody,
    );
    const signature = Buffer.from(received[2]!, "hex");
    return signature.byteLength === expected.byteLength && timingSafeEqual(signature, expected);
  } finally {
    feedKey.fill(0);
  }
}

function authorizedWithFeedKey(
  feedKey: Uint8Array,
  authorization: string | null | undefined,
  requestTarget: string,
): boolean {
  const proof = feedProofParts(authorization);
  if (!proof) return false;
  const expected = feedProof(feedKey, proof.challenge, requestTarget);
  const received = Buffer.from(proof.signature, "hex");
  return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
}

export function verifyWhatISaidFeedProof(input: WhatISaidCryptoLocation & {
  expectedRegistrationId: string;
  authorization?: string | null;
  requestTarget: string;
}): boolean {
  const key = keyBuffer(input.key);
  try {
    return withDatabase(input, (db, identity) => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const settings = readSettingsRow(db, identity, input.memoryId);
      if (!feedRegistrationMatchesOrRevoke(db, settings, input.expectedRegistrationId)) return false;
      const feedKey = decryptFeedKey(key, input.memoryId, settings);
      try {
        return authorizedWithFeedKey(feedKey, input.authorization, input.requestTarget);
      } finally {
        feedKey.fill(0);
      }
    });
  } finally {
    key.fill(0);
  }
}

interface CursorPayload {
  v: 1;
  e: string;
  s: string;
}

function cursorMac(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key)
    .update("agentstoz-what-i-said-feed-cursor-v1\0", "utf8")
    .update(body, "utf8")
    .digest();
}

function encodeCursor(key: Buffer, epoch: string, seq: string): string {
  const body = Buffer.from(JSON.stringify({ v: 1, e: epoch, s: seq } satisfies CursorPayload), "utf8")
    .toString("base64url");
  return `${body}.${cursorMac(key, body).toString("base64url")}`;
}

function decodeCursor(key: Buffer, cursor: string | null | undefined, epoch: string): string {
  if (cursor === undefined || cursor === null || cursor === "") return "0";
  try {
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) fail("WHAT_I_SAID_CURSOR_INVALID");
    const received = Buffer.from(parts[1], "base64url");
    const expected = cursorMac(key, parts[0]);
    if (received.toString("base64url") !== parts[1]
      || received.byteLength !== expected.byteLength
      || !timingSafeEqual(received, expected)) {
      fail("WHAT_I_SAID_CURSOR_INVALID");
    }
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (payload.v !== 1 || typeof payload.e !== "string" || typeof payload.s !== "string" || !SEQUENCE.test(payload.s)) {
      fail("WHAT_I_SAID_CURSOR_INVALID");
    }
    if (payload.e !== epoch) fail("WHAT_I_SAID_CURSOR_STALE");
    return payload.s;
  } catch (error) {
    if (error instanceof WhatISaidStoreError) throw error;
    fail("WHAT_I_SAID_CURSOR_INVALID");
  }
}

export function resetWhatISaidFeedEpoch(input: WhatISaidLocation & { now?: string }): void {
  const now = iso(input.now);
  withDatabase(input, db => rotateEpoch(db, now));
}

function hasActiveAfter(db: Database, seq: string, now: string): boolean {
  return db.query(`
    SELECT 1 AS found FROM what_i_said_events
    WHERE seq > CAST(? AS INTEGER)
      AND deleted_at IS NULL AND purged_at IS NULL
      AND (retention_until IS NULL OR retention_until > ?)
    ORDER BY seq ASC LIMIT 1
  `).get(seq, now) !== null;
}

export function readWhatISaidFeed(input: WhatISaidCryptoLocation & {
  expectedRegistrationId: string;
  authorization?: string | null;
  requestTarget: string;
  cursor?: string | null;
  limit?: number;
  now?: string;
}): WhatISaidFeedPage {
  const key = keyBuffer(input.key);
  const now = iso(input.now);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FEED_LIMIT) fail("WHAT_I_SAID_INPUT_INVALID");
  try {
    return withDatabase(input, (db, identity) => {
      bindOrVerifyDatabaseKey(db, identity, input.memoryId, key);
      const settings = readSettingsRow(db, identity, input.memoryId);
      if (settings.feed_enabled !== 1) fail("WHAT_I_SAID_FEED_DISABLED");
      if (!feedRegistrationMatchesOrRevoke(db, settings, input.expectedRegistrationId)) {
        fail("WHAT_I_SAID_FEED_UNAUTHORIZED");
      }
      const feedKey = decryptFeedKey(key, input.memoryId, settings);
      try {
        if (!authorizedWithFeedKey(feedKey, input.authorization, input.requestTarget)) {
          fail("WHAT_I_SAID_FEED_UNAUTHORIZED");
        }
      } finally {
        feedKey.fill(0);
      }
      const epoch = String(settings.index_epoch);
      let scanSeq = decodeCursor(key, input.cursor, epoch);
      let scanned = 0;
      let unreadable = 0;
      let withheld = 0;
      const maxScan = Math.max(250, limit * 10);
      const items: WhatISaidFeedItem[] = [];

    while (items.length < limit && scanned < maxScan) {
      const batchSize = Math.min(250, maxScan - scanned);
      const rows = db.query(`
        SELECT CAST(seq AS TEXT) AS seq, event_id, source_agent, recorded_at, captured_at,
               content_hash, nonce, ciphertext, auth_tag, retention_until, prompt_origin
        FROM what_i_said_events
        WHERE seq > CAST(? AS INTEGER)
          AND deleted_at IS NULL AND purged_at IS NULL
          AND (retention_until IS NULL OR retention_until > ?)
        ORDER BY seq ASC LIMIT ?
      `).all(scanSeq, now, batchSize) as EventRow[];
      if (!rows.length) break;
      for (const row of rows) {
        scanSeq = String(row.seq);
        scanned += 1;
        let plaintext: string;
        try {
          plaintext = decryptRow(key, input.memoryId, row);
        } catch {
          unreadable += 1;
          continue;
        }
        const redaction = redactWhatISaidForFeed(plaintext);
        if (redaction.withheld || redaction.text === null) {
          withheld += 1;
          continue;
        }
        items.push({
          id: String(row.event_id),
          recordedAt: String(row.recorded_at),
          agent: row.source_agent as WhatISaidAgent,
          text: redaction.text,
          contentHash: feedProjectionHash(redaction.text),
          promptOrigin: promptOrigin(row.prompt_origin),
          redaction: {
            state: redaction.reasons.length ? "redacted" : "clean",
            reasons: redaction.reasons,
            truncated: redaction.truncated,
          },
        });
        if (items.length === limit) break;
      }
      if (rows.length < batchSize) break;
    }

    const hasMore = hasActiveAfter(db, scanSeq, now);
      return {
        schemaVersion: 2,
        redactionPolicyVersion: 1,
        items,
        nextCursor: encodeCursor(key, epoch, scanSeq),
        hasMore,
        scan: { complete: !hasMore, unreadable, withheld },
      };
    });
  } finally {
    key.fill(0);
  }
}
