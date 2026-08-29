import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Disposable per-device acceleration state for the append-only remote ledger.
 * Authoritative journal/feedback files remain in the project. Losing this DB
 * deliberately produces an empty cursor and acknowledgement set, causing a
 * safe idempotent replay rather than data loss.
 */

export type ProjectMemoryLedgerLayer = "journal" | "feedback";

export interface ProjectMemoryLedgerAnchor {
  seq: string;
  layer: ProjectMemoryLedgerLayer;
  rowId: string;
}

export interface ProjectMemoryLedgerLocation {
  appDataDir: string;
  root: string;
  memoryId: string;
}

export interface ProjectMemoryLedgerState {
  version: 3;
  memoryId: string;
  /** Supabase ingestion sequence, kept as text so JavaScript never rounds bigint. */
  remoteCursor: string | null;
  /**
   * Exact immutable row at remoteCursor. A bigint alone cannot detect a
   * Supabase PITR/restore that rewinds and later reuses sequence values.
   */
  remoteAnchor: ProjectMemoryLedgerAnchor | null;
}

export interface ProjectMemoryLedgerCommitResult {
  state: ProjectMemoryLedgerState;
  added: Record<ProjectMemoryLedgerLayer, number>;
}

const LEDGER_SCHEMA_VERSION = 3;
const JOURNAL_KEY = /^[0-9a-f]{16}$/;
const REMOTE_CURSOR = /^(?:0|[1-9][0-9]*)$/;
const MAX_FEEDBACK_ID_BYTES = 512;
const MAX_MEMORY_ID_BYTES = 512;
const MAX_LEDGER_ROW_ID_BYTES = 1024;
const SQLITE_IN_CHUNK = 400;

// Remote delta sync spans multiple SQLite transactions and network calls. Keep
// one in-process queue per canonical project identity so a Push and Pull cannot
// advance the same disposable cursor out of order. Different projects retain
// full concurrency.
const ledgerSyncTails = new Map<string, Promise<void>>();

function validBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function assertMemoryId(memoryId: string): void {
  if (!validBoundedText(memoryId, MAX_MEMORY_ID_BYTES)) {
    throw new Error("project memory ledger identity is invalid");
  }
}

function ledgerCacheKey(root: string, memoryId: string): string {
  assertMemoryId(memoryId);
  const canonicalRoot = realpathSync(root);
  return createHash("sha256")
    .update(`${canonicalRoot}\n${memoryId}`, "utf8")
    .digest("hex");
}

export function projectMemoryLedgerStatePath(input: ProjectMemoryLedgerLocation): string {
  return join(
    input.appDataDir,
    "project-memory-ledger",
    `${ledgerCacheKey(input.root, input.memoryId)}.sqlite`,
  );
}

function ledgerIdentityHash(input: ProjectMemoryLedgerLocation): string {
  return ledgerCacheKey(input.root, input.memoryId);
}

export async function withProjectMemoryLedgerLock<T>(
  input: ProjectMemoryLedgerLocation,
  operation: () => Promise<T>,
): Promise<T> {
  const key = ledgerIdentityHash(input);
  const previous = ledgerSyncTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // A rejected caller must not poison the queue for later syncs.
  const tail = previous.catch(() => undefined).then(() => gate);
  ledgerSyncTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (ledgerSyncTails.get(key) === tail) ledgerSyncTails.delete(key);
  }
}

function assertLayer(layer: ProjectMemoryLedgerLayer): void {
  if (layer !== "journal" && layer !== "feedback") {
    throw new Error("project memory ledger layer is invalid");
  }
}

function validAckKey(layer: ProjectMemoryLedgerLayer, value: unknown): value is string {
  return layer === "journal"
    ? typeof value === "string" && JOURNAL_KEY.test(value)
    : validBoundedText(value, MAX_FEEDBACK_ID_BYTES);
}

function validatedAckKeys(
  layer: ProjectMemoryLedgerLayer,
  values: readonly string[] | undefined,
): string[] {
  assertLayer(layer);
  if (!values?.length) return [];
  const unique = new Set<string>();
  for (const value of values) {
    if (!validAckKey(layer, value)) {
      throw new Error(`project memory ledger ${layer} acknowledgement is invalid`);
    }
    unique.add(value);
  }
  return [...unique];
}

function normalizedCursor(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!REMOTE_CURSOR.test(value)) throw new Error("project memory ledger cursor is invalid");
  return value;
}

function normalizedAnchor(
  value: ProjectMemoryLedgerAnchor | null | undefined,
): ProjectMemoryLedgerAnchor | null | undefined {
  if (value === undefined || value === null) return value;
  if (!REMOTE_CURSOR.test(value.seq) || value.seq === "0") {
    throw new Error("project memory ledger anchor cursor is invalid");
  }
  assertLayer(value.layer);
  if (!validBoundedText(value.rowId, MAX_LEDGER_ROW_ID_BYTES)) {
    throw new Error("project memory ledger anchor row is invalid");
  }
  return { ...value };
}

export function emptyProjectMemoryLedgerState(memoryId: string): ProjectMemoryLedgerState {
  assertMemoryId(memoryId);
  return { version: 3, memoryId, remoteCursor: null, remoteAnchor: null };
}

function cacheDirectory(input: ProjectMemoryLedgerLocation): string {
  return join(input.appDataDir, "project-memory-ledger");
}

function assertRegularCacheFiles(path: string): void {
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    const info = lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error("project memory ledger cache must not be a symbolic link");
    if (!info.isFile()) throw new Error("project memory ledger cache must be a regular file");
  }
}

function prepareCacheDirectory(input: ProjectMemoryLedgerLocation): void {
  const dir = cacheDirectory(input);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("project memory ledger cache directory must be a real directory");
  }
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

function applyPrivatePermissions(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      identity_hash TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      remote_cursor TEXT,
      remote_cursor_layer TEXT CHECK(remote_cursor_layer IN ('journal', 'feedback')),
      remote_cursor_row_id TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger_ack (
      layer TEXT NOT NULL CHECK(layer IN ('journal', 'feedback')),
      ack_key TEXT NOT NULL,
      PRIMARY KEY(layer, ack_key)
    ) WITHOUT ROWID;
  `);
}

function runTransaction<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function rebuildTables(db: Database, input: ProjectMemoryLedgerLocation): void {
  runTransaction(db, () => {
    db.exec("DROP TABLE IF EXISTS ledger_ack; DROP TABLE IF EXISTS ledger_state;");
    createTables(db);
    db.query(`
      INSERT INTO ledger_state(
        singleton, schema_version, identity_hash, memory_id,
        remote_cursor, remote_cursor_layer, remote_cursor_row_id
      ) VALUES (1, ?, ?, ?, NULL, NULL, NULL)
    `).run(LEDGER_SCHEMA_VERSION, ledgerIdentityHash(input), input.memoryId);
    db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
  });
}

interface LedgerStateRow {
  schema_version: unknown;
  identity_hash: unknown;
  memory_id: unknown;
  remote_cursor: unknown;
  remote_cursor_layer: unknown;
  remote_cursor_row_id: unknown;
}

function stateRow(db: Database): LedgerStateRow | null {
  return db.query(`
    SELECT schema_version, identity_hash, memory_id,
           remote_cursor, remote_cursor_layer, remote_cursor_row_id
    FROM ledger_state WHERE singleton = 1
  `).get() as LedgerStateRow | null;
}

function validStateRow(row: LedgerStateRow | null, input: ProjectMemoryLedgerLocation): boolean {
  return row !== null
    && row.schema_version === LEDGER_SCHEMA_VERSION
    && row.identity_hash === ledgerIdentityHash(input)
    && row.memory_id === input.memoryId
    && (row.remote_cursor === null
      || (typeof row.remote_cursor === "string"
        && REMOTE_CURSOR.test(row.remote_cursor)
        && row.remote_cursor !== "0"))
    && (row.remote_cursor === null
      ? row.remote_cursor_layer === null && row.remote_cursor_row_id === null
      : (row.remote_cursor_layer === "journal" || row.remote_cursor_layer === "feedback")
        && validBoundedText(row.remote_cursor_row_id, MAX_LEDGER_ROW_ID_BYTES));
}

function ensureSchema(db: Database, input: ProjectMemoryLedgerLocation): void {
  const userVersion = Number((db.query("PRAGMA user_version").get() as { user_version?: unknown } | null)?.user_version ?? 0);
  if (userVersion !== LEDGER_SCHEMA_VERSION) {
    rebuildTables(db, input);
    return;
  }
  createTables(db);
  if (!validStateRow(stateRow(db), input)) rebuildTables(db, input);
}

function isDatabaseCorruption(error: unknown): boolean {
  const item = error as { message?: unknown; code?: unknown } | null;
  const message = `${typeof item?.code === "string" ? item.code : ""} ${
    typeof item?.message === "string" ? item.message : String(error)
  }`;
  return /SQLITE_(?:CORRUPT|NOTADB)|database disk image is malformed|file is not a database|unsupported file format/i.test(message);
}

function deleteDisposableDatabase(path: string): void {
  assertRegularCacheFiles(path);
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function useLedgerDatabase<T>(
  input: ProjectMemoryLedgerLocation,
  operation: (db: Database) => T,
  recovered = false,
): T {
  assertMemoryId(input.memoryId);
  prepareCacheDirectory(input);
  const path = projectMemoryLedgerStatePath(input);
  assertRegularCacheFiles(path);
  let db: Database | null = null;
  try {
    db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 2000;");
    applyPrivatePermissions(path);
    ensureSchema(db, input);
    return operation(db);
  } catch (error) {
    if (!recovered && isDatabaseCorruption(error)) {
      try { db?.close(); } finally { db = null; }
      deleteDisposableDatabase(path);
      return useLedgerDatabase(input, operation, true);
    }
    throw error;
  } finally {
    db?.close();
  }
}

function readStateFromDatabase(db: Database, memoryId: string): ProjectMemoryLedgerState {
  const row = stateRow(db);
  const cursor = typeof row?.remote_cursor === "string" ? row.remote_cursor : null;
  const layer = row?.remote_cursor_layer === "journal" || row?.remote_cursor_layer === "feedback"
    ? row.remote_cursor_layer
    : null;
  const rowId = typeof row?.remote_cursor_row_id === "string" ? row.remote_cursor_row_id : null;
  return {
    version: 3,
    memoryId,
    remoteCursor: cursor,
    remoteAnchor: cursor && layer && rowId ? { seq: cursor, layer, rowId } : null,
  };
}

function insertAcknowledgements(
  db: Database,
  layer: ProjectMemoryLedgerLayer,
  keys: readonly string[],
): number {
  let added = 0;
  for (let start = 0; start < keys.length; start += SQLITE_IN_CHUNK) {
    const chunk = keys.slice(start, start + SQLITE_IN_CHUNK);
    const values = chunk.map(() => "(?, ?)").join(",");
    const params = chunk.flatMap(key => [layer, key]);
    added += db.query(
      `INSERT OR IGNORE INTO ledger_ack(layer, ack_key) VALUES ${values}`,
    ).run(...params).changes;
  }
  return added;
}

/** Opens or rebuilds the disposable cache and reads only O(1) cursor metadata. */
export function readProjectMemoryLedgerState(
  input: ProjectMemoryLedgerLocation,
): ProjectMemoryLedgerState {
  return useLedgerDatabase(input, db => readStateFromDatabase(db, input.memoryId));
}

/**
 * Returns only the requested keys that are already acknowledged. It never
 * materializes the complete multi-decade acknowledgement table in JavaScript.
 */
export function hasProjectMemoryLedgerAcknowledgements(input: ProjectMemoryLedgerLocation & {
  layer: ProjectMemoryLedgerLayer;
  keys: readonly string[];
}): Set<string> {
  const keys = validatedAckKeys(input.layer, input.keys);
  if (!keys.length) return new Set();
  return useLedgerDatabase(input, db => {
    const found = new Set<string>();
    for (let start = 0; start < keys.length; start += SQLITE_IN_CHUNK) {
      const chunk = keys.slice(start, start + SQLITE_IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.query(`
        SELECT ack_key FROM ledger_ack
        WHERE layer = ? AND ack_key IN (${placeholders})
      `).all(input.layer, ...chunk) as Array<{ ack_key: string }>;
      for (const row of rows) found.add(row.ack_key);
    }
    return found;
  });
}

/** Counts in SQLite so status reporting does not load every key into memory. */
export function countProjectMemoryLedgerAcknowledgements(input: ProjectMemoryLedgerLocation & {
  layer: ProjectMemoryLedgerLayer;
}): number {
  assertLayer(input.layer);
  return useLedgerDatabase(input, db => Number((db.query(
    "SELECT count(*) AS count FROM ledger_ack WHERE layer = ?",
  ).get(input.layer) as { count?: unknown } | null)?.count ?? 0));
}

/**
 * Proves that every key remembered as durable remotely is still present in the
 * authoritative local ledger. A count-only comparison is insufficient: one
 * deleted historical key plus one new key has the same cardinality.
 */
export function projectMemoryLedgerAcknowledgementCoverage(
  input: ProjectMemoryLedgerLocation & {
    layer: ProjectMemoryLedgerLayer;
    localKeys: readonly string[];
  },
): { acknowledged: number; present: number; complete: boolean } {
  const localKeys = validatedAckKeys(input.layer, input.localKeys);
  return useLedgerDatabase(input, db => {
    const acknowledged = Number((db.query(
      "SELECT count(*) AS count FROM ledger_ack WHERE layer = ?",
    ).get(input.layer) as { count?: unknown } | null)?.count ?? 0);
    let present = 0;
    for (let start = 0; start < localKeys.length; start += SQLITE_IN_CHUNK) {
      const chunk = localKeys.slice(start, start + SQLITE_IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      present += Number((db.query(`
        SELECT count(*) AS count FROM ledger_ack
        WHERE layer = ? AND ack_key IN (${placeholders})
      `).get(input.layer, ...chunk) as { count?: unknown } | null)?.count ?? 0);
    }
    return { acknowledged, present, complete: present === acknowledged };
  });
}

/**
 * Drops only disposable acceleration state. The next delta starts at zero and
 * every local row is idempotently re-sent, repairing both local truncation and
 * a rewound/restored Supabase ledger without deleting either authority.
 */
export function resetProjectMemoryLedgerState(
  input: ProjectMemoryLedgerLocation,
): ProjectMemoryLedgerState {
  return useLedgerDatabase(input, db => runTransaction(db, () => {
    db.exec("DELETE FROM ledger_ack");
    db.exec(`
      UPDATE ledger_state
      SET remote_cursor = NULL,
          remote_cursor_layer = NULL,
          remote_cursor_row_id = NULL
      WHERE singleton = 1
    `);
    return readStateFromDatabase(db, input.memoryId);
  }));
}

/**
 * Atomically inserts acknowledgements from both layers and advances cursor
 * metadata. Existing keys are ignored by the (layer,key) primary key.
 */
export function commitProjectMemoryLedgerState(input: ProjectMemoryLedgerLocation & {
  remoteCursor?: string | null;
  remoteAnchor?: ProjectMemoryLedgerAnchor | null;
  journalAcked?: readonly string[];
  feedbackAcked?: readonly string[];
}): ProjectMemoryLedgerCommitResult {
  const remoteCursor = normalizedCursor(input.remoteCursor);
  const remoteAnchor = normalizedAnchor(input.remoteAnchor);
  if (remoteCursor !== undefined && remoteCursor !== null) {
    if (!remoteAnchor || remoteAnchor.seq !== remoteCursor) {
      throw new Error("project memory ledger cursor requires its exact remote anchor");
    }
  } else if (remoteAnchor !== undefined && remoteAnchor !== null) {
    throw new Error("project memory ledger anchor requires a cursor");
  }
  // Validate every key before opening a transaction: a bad feedback ID must not
  // leave otherwise-valid journal acknowledgements partially committed.
  const journalAcked = validatedAckKeys("journal", input.journalAcked);
  const feedbackAcked = validatedAckKeys("feedback", input.feedbackAcked);
  return useLedgerDatabase(input, db => runTransaction(db, () => {
    const journalAdded = insertAcknowledgements(db, "journal", journalAcked);
    const feedbackAdded = insertAcknowledgements(db, "feedback", feedbackAcked);

    const current = readStateFromDatabase(db, input.memoryId);
    let nextCursor = current.remoteCursor;
    let nextAnchor = current.remoteAnchor;
    if (remoteCursor !== undefined
      && remoteCursor !== null
      && compareLedgerCursor(remoteCursor, current.remoteCursor) > 0) {
      nextCursor = remoteCursor;
      nextAnchor = remoteAnchor!;
      db.query(`
        UPDATE ledger_state
        SET remote_cursor = ?, remote_cursor_layer = ?, remote_cursor_row_id = ?
        WHERE singleton = 1
      `).run(nextCursor, nextAnchor.layer, nextAnchor.rowId);
    }
    return {
      state: { ...current, remoteCursor: nextCursor, remoteAnchor: nextAnchor },
      added: { journal: journalAdded, feedback: feedbackAdded },
    };
  }));
}

export function addProjectMemoryLedgerAcknowledgements(input: ProjectMemoryLedgerLocation & {
  layer: ProjectMemoryLedgerLayer;
  keys: readonly string[];
}): { added: number } {
  const result = commitProjectMemoryLedgerState({
    appDataDir: input.appDataDir,
    root: input.root,
    memoryId: input.memoryId,
    ...(input.layer === "journal" ? { journalAcked: input.keys } : { feedbackAcked: input.keys }),
  });
  return { added: result.added[input.layer] };
}

/** Backward-compatible cursor writer; acknowledgement arrays no longer exist. */
export function writeProjectMemoryLedgerState(input: ProjectMemoryLedgerLocation & {
  state: ProjectMemoryLedgerState;
}): void {
  if (input.state.version !== 3 || input.state.memoryId !== input.memoryId) {
    throw new Error("project memory ledger state identity is invalid");
  }
  commitProjectMemoryLedgerState({
    appDataDir: input.appDataDir,
    root: input.root,
    memoryId: input.memoryId,
    remoteCursor: input.state.remoteCursor,
    remoteAnchor: input.state.remoteAnchor,
  });
}

export function compareLedgerCursor(a: string | null, b: string | null): number {
  const left = a ?? "0";
  const right = b ?? "0";
  if (!REMOTE_CURSOR.test(left) || !REMOTE_CURSOR.test(right)) return 0;
  const leftBig = BigInt(left);
  const rightBig = BigInt(right);
  return leftBig < rightBig ? -1 : leftBig > rightBig ? 1 : 0;
}
