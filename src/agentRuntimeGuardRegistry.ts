import { randomBytes, createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { constants as sqliteConstants, Database } from 'bun:sqlite';

export const AGENT_RUNTIME_GUARD_REGISTRY_SCHEMA_VERSION = 1;
export const AGENT_RUNTIME_GUARD_RESERVATION_ENV =
  'AGENTSTOZ_AGENT_RUNTIME_GUARD_RESERVATION_V1';
export const AGENT_RUNTIME_GUARD_REGISTRY_FILENAME = 'process-guards-v1.sqlite';

const REGISTRY_PROTOCOL = 'agentstoz-process-guard-reservation-v1';
const REGISTRY_DIRECTORY = 'agent-runtime';
const MAX_ENCODED_RESERVATION_BYTES = 16 * 1024;
const REGISTRY_BUSY_TIMEOUT_MS = 1_000;
const LAUNCH_ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
// v2 is retained only for a crashed supervisor created by the immediately
// previous build. New recoverable locks explicitly declare `guarded`; a v3
// `manual` lock can never enter this proof path.
const OWNED_LOCK_RE = /^(?:v2:([1-9][0-9]{0,9}):[0-9a-f]{32}|v3:([1-9][0-9]{0,9}):[0-9a-f]{32}:guarded)$/;

export type AgentRuntimeGuardKind = 'codex' | 'claude-remote';

export interface AgentRuntimeGuardRegistry {
  readonly databasePath: string;
  reserve(input: {
    kind: AgentRuntimeGuardKind;
    cwd: string;
    parentPid?: number;
  }): AgentRuntimeGuardReservation;
  canRecoverDeadOwner(owner: string): boolean;
  cancelReservation(reservation: AgentRuntimeGuardReservation): boolean;
  releaseAfterGroupTermination(
    reservation: AgentRuntimeGuardReservation,
    expectedPgid: number,
  ): boolean;
}

export interface AgentRuntimeGuardReservation {
  readonly protocol: typeof REGISTRY_PROTOCOL;
  readonly databasePath: string;
  readonly launchId: string;
  readonly token: string;
  readonly parentPid: number;
  readonly kind: AgentRuntimeGuardKind;
}

export interface AgentRuntimeGuardRecord {
  readonly launchId: string;
  readonly state: 'reserved' | 'active';
  readonly parentPid: number;
  readonly guardPid: number | null;
  readonly pgid: number | null;
  readonly kind: AgentRuntimeGuardKind;
  readonly scopeHash: string;
  readonly createdAtMs: number;
  readonly activatedAtMs: number | null;
}

interface GuardRegistryRow {
  launch_id: unknown;
  token: unknown;
  state: unknown;
  parent_pid: unknown;
  guard_pid: unknown;
  pgid: unknown;
  kind: unknown;
  scope_hash: unknown;
  created_at_ms: unknown;
  activated_at_ms: unknown;
}

interface OpenRegistryOptions {
  create: boolean;
  repairPermissions: boolean;
}

function safePid(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 1) {
    throw new Error(`${field} is not a safe process identifier.`);
  }
  return value;
}

function exactNullablePid(value: unknown, field: string): number | null {
  if (value === null) return null;
  return safePid(value, field);
}

function exactSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is not a safe integer.`);
  }
  return value;
}

function exactGuardKind(value: unknown): AgentRuntimeGuardKind {
  if (value !== 'codex' && value !== 'claude-remote') {
    throw new Error('The process guard kind is invalid.');
  }
  return value;
}

function normalizeRow(row: GuardRegistryRow): AgentRuntimeGuardRecord & { token: string } {
  if (typeof row.launch_id !== 'string' || !LAUNCH_ID_RE.test(row.launch_id)
    || typeof row.token !== 'string' || !TOKEN_RE.test(row.token)
    || (row.state !== 'reserved' && row.state !== 'active')
    || typeof row.scope_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.scope_hash)) {
    throw new Error('The process guard registry contains an invalid record.');
  }
  const parentPid = safePid(row.parent_pid, 'parent_pid');
  const guardPid = exactNullablePid(row.guard_pid, 'guard_pid');
  const pgid = exactNullablePid(row.pgid, 'pgid');
  const activatedAtMs = row.activated_at_ms === null
    ? null
    : exactSafeInteger(row.activated_at_ms, 'activated_at_ms');
  if (row.state === 'reserved') {
    if (guardPid !== null || pgid !== null || activatedAtMs !== null) {
      throw new Error('A reserved process guard record is inconsistent.');
    }
  } else if (guardPid === null || pgid === null || guardPid !== pgid || activatedAtMs === null) {
    throw new Error('An active process guard record is inconsistent.');
  }
  return {
    launchId: row.launch_id,
    token: row.token,
    state: row.state,
    parentPid,
    guardPid,
    pgid,
    kind: exactGuardKind(row.kind),
    scopeHash: row.scope_hash,
    createdAtMs: exactSafeInteger(row.created_at_ms, 'created_at_ms'),
    activatedAtMs,
  };
}

function isContainedPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== ''
    && child !== '..'
    && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(child);
}

function assertPrivateDirectory(path: string, tightenReadOnlyPermissions = false): string {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('The process guard registry directory is unsafe.');
  }
  if (process.platform !== 'win32') {
    if (typeof process.geteuid === 'function' && entry.uid !== process.geteuid()) {
      throw new Error('The process guard registry directory ownership is unsafe.');
    }
    const exposedPermissions = entry.mode & 0o077;
    // A pre-registry directory owned by this user may inherit 0755 from an
    // older app version. Tighten that migration case only when nobody else
    // could write it. Once a registry exists, any exposure is ambiguous and
    // callers pass false so startup fails closed instead of laundering it.
    if (exposedPermissions !== 0) {
      if (!tightenReadOnlyPermissions || (entry.mode & 0o022) !== 0) {
        throw new Error('The process guard registry directory permissions are unsafe.');
      }
      // Never chmod before the no-symlink/type/owner checks above. Otherwise a
      // malicious final-component symlink could mutate an out-of-scope target.
      chmodSync(path, 0o700);
    }
    const secured = lstatSync(path);
    if (secured.isSymbolicLink() || !secured.isDirectory() || (secured.mode & 0o077) !== 0) {
      throw new Error('The process guard registry directory permissions are unsafe.');
    }
  }
  return realpathSync(path);
}

function prepareRegistryDatabasePath(appDataDir: string): string {
  if (typeof appDataDir !== 'string'
    || appDataDir.length === 0
    || appDataDir.includes('\0')
    || !isAbsolute(appDataDir)) {
    throw new Error('A safe absolute app-data path is required for the process guard registry.');
  }
  const normalized = resolve(appDataDir);
  if (normalized === parse(normalized).root) {
    throw new Error('The filesystem root cannot be used as process guard app-data.');
  }
  mkdirSync(normalized, { recursive: true, mode: 0o700 });
  const canonicalAppData = assertPrivateDirectory(normalized, true);
  const requestedRuntimeDirectory = join(canonicalAppData, REGISTRY_DIRECTORY);
  mkdirSync(requestedRuntimeDirectory, { recursive: true, mode: 0o700 });
  const requestedDatabasePath = join(
    requestedRuntimeDirectory,
    AGENT_RUNTIME_GUARD_REGISTRY_FILENAME,
  );
  const canonicalRuntimeDirectory = assertPrivateDirectory(
    requestedRuntimeDirectory,
    !existsSync(requestedDatabasePath),
  );
  if (!isContainedPath(canonicalAppData, canonicalRuntimeDirectory)) {
    throw new Error('The process guard registry escaped app-data.');
  }
  return join(canonicalRuntimeDirectory, AGENT_RUNTIME_GUARD_REGISTRY_FILENAME);
}

function assertSecureDatabaseFile(path: string, repairPermissions: boolean): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('The process guard registry must be a regular file.');
  }
  if (process.platform !== 'win32') {
    if (typeof process.geteuid === 'function' && entry.uid !== process.geteuid()) {
      throw new Error('The process guard registry owner is unsafe.');
    }
    if (entry.nlink !== 1) {
      throw new Error('The process guard registry link count is unsafe.');
    }
    if (repairPermissions) chmodSync(path, 0o600);
    const secured = lstatSync(path);
    if ((secured.mode & 0o077) !== 0) {
      throw new Error('The process guard registry permissions are unsafe.');
    }
  }
}

function configureDatabaseSafety(database: Database): void {
  database.exec(`
    PRAGMA busy_timeout = ${REGISTRY_BUSY_TIMEOUT_MS};
    PRAGMA trusted_schema = OFF;
  `);
}

function configureDatabaseDurability(database: Database): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA fullfsync = ON;
  `);
}

function ensureSchema(database: Database, allowInitializeEmpty: boolean): void {
  const tables = (database.query(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name?: unknown }>).map(row => row.name);
  if (tables.includes('process_guard_registry_meta')) {
    const existingMeta = database.query(`
      SELECT schema_version AS schemaVersion
      FROM process_guard_registry_meta WHERE singleton = 1
    `).get() as { schemaVersion?: unknown } | null;
    if (existingMeta?.schemaVersion !== AGENT_RUNTIME_GUARD_REGISTRY_SCHEMA_VERSION) {
      throw new Error('The process guard registry schema is unsupported.');
    }
  }
  if (tables.length === 0) {
    if (!allowInitializeEmpty) {
      throw new Error('The process guard registry is corrupt or missing.');
    }
    withImmediateTransaction(database, () => {
      database.exec(`
        CREATE TABLE process_guard_registry_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL
        );
        INSERT INTO process_guard_registry_meta (singleton, schema_version)
        VALUES (1, ${AGENT_RUNTIME_GUARD_REGISTRY_SCHEMA_VERSION});
        CREATE TABLE process_guard_records (
          launch_id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('reserved', 'active')),
          parent_pid INTEGER NOT NULL CHECK (parent_pid > 1),
          guard_pid INTEGER,
          pgid INTEGER,
          kind TEXT NOT NULL CHECK (kind IN ('codex', 'claude-remote')),
          scope_hash TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          activated_at_ms INTEGER,
          CHECK (
            (state = 'reserved' AND guard_pid IS NULL AND pgid IS NULL AND activated_at_ms IS NULL)
            OR
            (state = 'active' AND guard_pid > 1 AND pgid = guard_pid AND activated_at_ms IS NOT NULL)
          )
        );
      `);
    });
  } else if (tables.length !== 2
    || tables[0] !== 'process_guard_records'
    || tables[1] !== 'process_guard_registry_meta') {
    throw new Error('The process guard registry schema is corrupt or unsupported.');
  }
  const meta = database.query(`
    SELECT schema_version AS schemaVersion
    FROM process_guard_registry_meta WHERE singleton = 1
  `).get() as { schemaVersion?: unknown } | null;
  if (meta?.schemaVersion !== AGENT_RUNTIME_GUARD_REGISTRY_SCHEMA_VERSION) {
    throw new Error('The process guard registry schema is unsupported.');
  }
  const columns = (database.query('PRAGMA table_info(process_guard_records)').all() as Array<{
    name?: unknown;
  }>).map(row => row.name);
  const expectedColumns = [
    'launch_id', 'token', 'state', 'parent_pid', 'guard_pid', 'pgid', 'kind',
    'scope_hash', 'created_at_ms', 'activated_at_ms',
  ];
  if (columns.length !== expectedColumns.length
    || !columns.every((column, index) => column === expectedColumns[index])) {
    throw new Error('The process guard registry schema is corrupt or unsupported.');
  }
}

function openRegistryDatabase(path: string, options: OpenRegistryOptions): Database {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('The process guard registry path is invalid.');
  }
  const canonicalDirectory = assertPrivateDirectory(dirname(path));
  if (join(canonicalDirectory, AGENT_RUNTIME_GUARD_REGISTRY_FILENAME) !== path) {
    throw new Error('The process guard registry path is not canonical.');
  }
  const existedBeforeOpen = existsSync(path);
  if (!options.create && !existedBeforeOpen) {
    throw new Error('The process guard registry is unavailable.');
  }
  if (existedBeforeOpen) assertSecureDatabaseFile(path, false);
  const flags = sqliteConstants.SQLITE_OPEN_READWRITE
    | sqliteConstants.SQLITE_OPEN_NOFOLLOW
    | (options.create ? sqliteConstants.SQLITE_OPEN_CREATE : 0);
  const database = new Database(path, flags);
  try {
    if (!existsSync(path)) throw new Error('The process guard registry was not created.');
    assertSecureDatabaseFile(path, options.repairPermissions && !existedBeforeOpen);
    configureDatabaseSafety(database);
    if (!existedBeforeOpen) {
      // The first schema transaction itself must be FULL-durable. An existing
      // empty file is never treated as fresh: it could be a crash/tamper that
      // erased active ownership evidence.
      configureDatabaseDurability(database);
      ensureSchema(database, true);
    } else {
      // Validate version and exact tables before any file-mutating PRAGMA. A
      // newer/corrupt registry must remain untouched and block recovery.
      ensureSchema(database, false);
      configureDatabaseDurability(database);
    }
    assertSecureDatabaseFile(path, false);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function withImmediateTransaction<T>(database: Database, operation: () => T): T {
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const result = operation();
    database.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

function processDefinitelyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: any) {
    return error?.code === 'ESRCH';
  }
}

function processGroupDefinitelyAbsent(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error: any) {
    // EPERM and unknown kernel errors are existence/identity ambiguity, not
    // deletion or recovery authority.
    return error?.code === 'ESRCH';
  }
}

function selectAllRows(database: Database): Array<AgentRuntimeGuardRecord & { token: string }> {
  const rows = database.query(`
    SELECT launch_id, token, state, parent_pid, guard_pid, pgid, kind,
           scope_hash, created_at_ms, activated_at_ms
    FROM process_guard_records
    ORDER BY created_at_ms, launch_id
  `).all() as GuardRegistryRow[];
  return rows.map(normalizeRow);
}

function deleteExactRecord(
  database: Database,
  record: AgentRuntimeGuardRecord & { token: string },
): boolean {
  const result = database.query(`
    DELETE FROM process_guard_records
    WHERE launch_id = ? AND token = ? AND state = ? AND parent_pid = ?
      AND kind = ? AND scope_hash = ?
      AND guard_pid IS ? AND pgid IS ?
      AND created_at_ms = ? AND activated_at_ms IS ?
  `).run(
    record.launchId,
    record.token,
    record.state,
    record.parentPid,
    record.kind,
    record.scopeHash,
    record.guardPid,
    record.pgid,
    record.createdAtMs,
    record.activatedAtMs,
  );
  return result.changes === 1;
}

function encodeReservation(reservation: AgentRuntimeGuardReservation): string {
  const encoded = Buffer.from(JSON.stringify(reservation), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_ENCODED_RESERVATION_BYTES) {
    throw new Error('The process guard reservation exceeds its private transport limit.');
  }
  return encoded;
}

export function decodeAgentRuntimeGuardReservation(
  encoded: string,
): AgentRuntimeGuardReservation {
  if (typeof encoded !== 'string'
    || encoded.length === 0
    || Buffer.byteLength(encoded) > MAX_ENCODED_RESERVATION_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('A bounded process guard reservation is required.');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) {
    throw new Error('The process guard reservation encoding is non-canonical.');
  }
  const value: unknown = JSON.parse(decoded.toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The process guard reservation is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['databasePath', 'kind', 'launchId', 'parentPid', 'protocol', 'token'].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])
    || record.protocol !== REGISTRY_PROTOCOL
    || typeof record.databasePath !== 'string'
    || !isAbsolute(record.databasePath)
    || record.databasePath.includes('\0')
    || typeof record.launchId !== 'string' || !LAUNCH_ID_RE.test(record.launchId)
    || typeof record.token !== 'string' || !TOKEN_RE.test(record.token)) {
    throw new Error('The process guard reservation is invalid.');
  }
  return Object.freeze({
    protocol: REGISTRY_PROTOCOL,
    databasePath: record.databasePath,
    launchId: record.launchId,
    token: record.token,
    parentPid: safePid(record.parentPid, 'reservation.parentPid'),
    kind: exactGuardKind(record.kind),
  });
}

export function activateAgentRuntimeGuardReservation(
  encoded: string,
  expectedParentPid: number,
  expectedKind: AgentRuntimeGuardKind,
): AgentRuntimeGuardReservation {
  const reservation = decodeAgentRuntimeGuardReservation(encoded);
  const parentPid = safePid(expectedParentPid, 'guard.parentPid');
  const guardPid = safePid(process.pid, 'guard.pid');
  if (reservation.parentPid !== parentPid || reservation.kind !== expectedKind) {
    throw new Error('The process guard reservation owner does not match the launcher.');
  }
  const database = openRegistryDatabase(reservation.databasePath, {
    create: false,
    repairPermissions: false,
  });
  try {
    const activatedAtMs = Date.now();
    withImmediateTransaction(database, () => {
      const result = database.query(`
        UPDATE process_guard_records
        SET state = 'active', guard_pid = ?, pgid = ?, activated_at_ms = ?
        WHERE launch_id = ? AND token = ? AND state = 'reserved'
          AND parent_pid = ? AND kind = ?
          AND guard_pid IS NULL AND pgid IS NULL AND activated_at_ms IS NULL
      `).run(
        guardPid,
        guardPid,
        activatedAtMs,
        reservation.launchId,
        reservation.token,
        reservation.parentPid,
        reservation.kind,
      );
      if (result.changes !== 1) {
        throw new Error('The process guard reservation is no longer owned by this launch.');
      }
    });
    return reservation;
  } finally {
    database.close();
  }
}

export function inspectAgentRuntimeGuardRecords(
  registry: Pick<AgentRuntimeGuardRegistry, 'databasePath'>,
): AgentRuntimeGuardRecord[] {
  const database = openRegistryDatabase(registry.databasePath, {
    create: false,
    repairPermissions: false,
  });
  try {
    return selectAllRows(database).map(({ token: _token, ...record }) => Object.freeze(record));
  } finally {
    database.close();
  }
}

export function prepareAgentRuntimeGuardRegistry(appDataDir: string): AgentRuntimeGuardRegistry {
  const databasePath = prepareRegistryDatabasePath(appDataDir);
  const prepared = openRegistryDatabase(databasePath, { create: true, repairPermissions: true });
  try {
    // Startup health means both the schema and every durable ownership row are
    // trustworthy. Advertising a registry with a malformed active/reserved
    // record would let the sidecar start while crash-recovery proof is already
    // unusable, so validate the complete bounded ownership set up front.
    selectAllRows(prepared);
  } finally {
    prepared.close();
  }

  const registry: AgentRuntimeGuardRegistry = Object.freeze({
    databasePath,
    reserve(input: {
      kind: AgentRuntimeGuardKind;
      cwd: string;
      parentPid?: number;
    }): AgentRuntimeGuardReservation {
      const parentPid = safePid(input.parentPid ?? process.pid, 'reservation.parentPid');
      const kind = exactGuardKind(input.kind);
      if (typeof input.cwd !== 'string' || input.cwd.length === 0 || input.cwd.includes('\0')) {
        throw new Error('A process guard scope is required.');
      }
      const launchId = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('hex');
      const reservation: AgentRuntimeGuardReservation = Object.freeze({
        protocol: REGISTRY_PROTOCOL,
        databasePath,
        launchId,
        token,
        parentPid,
        kind,
      });
      const database = openRegistryDatabase(databasePath, {
        create: false,
        repairPermissions: false,
      });
      try {
        withImmediateTransaction(database, () => {
          database.query(`
            INSERT INTO process_guard_records (
              launch_id, token, state, parent_pid, guard_pid, pgid, kind,
              scope_hash, created_at_ms, activated_at_ms
            ) VALUES (?, ?, 'reserved', ?, NULL, NULL, ?, ?, ?, NULL)
          `).run(
            launchId,
            token,
            parentPid,
            kind,
            createHash('sha256').update(input.cwd).digest('hex'),
            Date.now(),
          );
        });
        // Validate transport before a launcher can cross the process boundary.
        encodeReservation(reservation);
        return reservation;
      } finally {
        database.close();
      }
    },
    canRecoverDeadOwner(owner: string): boolean {
      const match = OWNED_LOCK_RE.exec(owner);
      if (!match) return false;
      const deadParentPid = Number(match[1] ?? match[2]);
      if (!Number.isSafeInteger(deadParentPid) || deadParentPid <= 1
        || !processDefinitelyAbsent(deadParentPid)) {
        return false;
      }
      const database = openRegistryDatabase(databasePath, {
        create: false,
        repairPermissions: false,
      });
      try {
        return withImmediateTransaction(database, () => {
          let allSafe = true;
          for (const record of selectAllRows(database)) {
            if (record.parentPid !== deadParentPid) {
              allSafe = false;
              continue;
            }
            const removable = record.state === 'reserved'
              ? true
              : record.pgid !== null && processGroupDefinitelyAbsent(record.pgid);
            if (!removable) {
              allSafe = false;
              continue;
            }
            if (!deleteExactRecord(database, record)) allSafe = false;
          }
          return allSafe;
        });
      } finally {
        database.close();
      }
    },
    cancelReservation(reservation: AgentRuntimeGuardReservation): boolean {
      if (reservation.databasePath !== databasePath) return false;
      const database = openRegistryDatabase(databasePath, {
        create: false,
        repairPermissions: false,
      });
      try {
        return withImmediateTransaction(database, () => (
          database.query(`
            DELETE FROM process_guard_records
            WHERE launch_id = ? AND token = ? AND state = 'reserved'
              AND parent_pid = ? AND kind = ?
              AND guard_pid IS NULL AND pgid IS NULL AND activated_at_ms IS NULL
          `).run(
            reservation.launchId,
            reservation.token,
            reservation.parentPid,
            reservation.kind,
          ).changes === 1
        ));
      } finally {
        database.close();
      }
    },
    releaseAfterGroupTermination(
      reservation: AgentRuntimeGuardReservation,
      expectedPgid: number,
    ): boolean {
      const pgid = safePid(expectedPgid, 'release.pgid');
      if (reservation.databasePath !== databasePath || !processGroupDefinitelyAbsent(pgid)) {
        return false;
      }
      const database = openRegistryDatabase(databasePath, {
        create: false,
        repairPermissions: false,
      });
      try {
        return withImmediateTransaction(database, () => {
          const raw = database.query(`
            SELECT launch_id, token, state, parent_pid, guard_pid, pgid, kind,
                   scope_hash, created_at_ms, activated_at_ms
            FROM process_guard_records
            WHERE launch_id = ? AND token = ?
          `).get(reservation.launchId, reservation.token) as GuardRegistryRow | null;
          if (raw === null) return true;
          const record = normalizeRow(raw);
          if (record.parentPid !== reservation.parentPid
            || record.kind !== reservation.kind
            || (record.state === 'active' && record.pgid !== pgid)) {
            return false;
          }
          return deleteExactRecord(database, record);
        });
      } finally {
        database.close();
      }
    },
  });
  return registry;
}

export function encodeAgentRuntimeGuardReservation(
  reservation: AgentRuntimeGuardReservation,
): string {
  return encodeReservation(reservation);
}
