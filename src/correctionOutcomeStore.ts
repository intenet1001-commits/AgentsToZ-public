import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {
  CORRECTION_OUTCOME_COVERAGE, CORRECTION_OUTCOME_PROTOCOL, correctionObservationId, correctionOutcomeProtocolHash,
  evaluateCorrectionLearningTrack, parseCorrectionObservation, summarizeCorrectionOutcomes,
  type CorrectionClassification, type CorrectionExposureState, type CorrectionExposureUnit, type CorrectionObservation,
  type CorrectionOutcome, type CorrectionOutcomeProtocol, type CorrectionOutcomeSummary,
} from './projectMemoryCorrectionOutcome';

/**
 * App-local, append-only store for correction outcomes. A separate file from the workroom history journal, so the
 * journal schema (workroom_meta.version 2) and a rollback to an older build are untouched.
 *
 * Observations and outcomes are INSERT-only (triggers refuse UPDATE/DELETE). A unit may only change while its
 * submission is still non-final (prepared/write_started). At the row cap new writes are refused and nothing is deleted.
 * The store is bound to one journal lineage; a different journal instance is never mixed in.
 */
export const CORRECTION_OUTCOME_STORE_ROW_LIMIT = 20_000;
/** The file never grows past this (plus at most one row's pages): every write is refused once it is reached. */
export const CORRECTION_OUTCOME_STORE_MAX_BYTES = 64 * 1024 * 1024;
const DIRECTORY = 'correction-outcomes-v1';
const FILE = 'outcomes.sqlite';
const NON_FINAL: readonly CorrectionExposureState[] = ['prepared', 'write_started'];
type Write = 'inserted' | 'exists' | 'full';

const stamp = (path: string, directory: boolean, privateRoot = false) => {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || process.platform !== 'win32' && (s.uid !== process.getuid?.() || (s.mode & (directory && !privateRoot ? 0o022 : 0o077)) !== 0)) {
    throw new Error('교정 결과 저장소의 접근 권한을 확인하세요.');
  }
  return `${s.dev}:${s.ino}`;
};

const SCHEMA = `
  CREATE TABLE correction_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, instance_id TEXT NOT NULL,
    activated_at TEXT NOT NULL, journal_instance_id TEXT, rowid_cursor INTEGER NOT NULL);
  CREATE TABLE correction_units(unit_id TEXT PRIMARY KEY, submission_key TEXT NOT NULL, memory_id TEXT NOT NULL, entry_key TEXT NOT NULL,
    content_version_hash TEXT NOT NULL, state TEXT NOT NULL, written_at TEXT, body TEXT NOT NULL);
  CREATE INDEX correction_units_scope ON correction_units(memory_id, entry_key, content_version_hash);
  CREATE TABLE correction_observations(observation_id TEXT NOT NULL, unit_id TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(observation_id, unit_id));
  CREATE TABLE correction_outcomes(unit_id TEXT NOT NULL, protocol_hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
    finalized_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(unit_id, protocol_hash));
  CREATE TRIGGER correction_outcomes_append_only_update BEFORE UPDATE ON correction_outcomes BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER correction_outcomes_append_only_delete BEFORE DELETE ON correction_outcomes BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER correction_observations_append_only_update BEFORE UPDATE ON correction_observations BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER correction_observations_append_only_delete BEFORE DELETE ON correction_observations BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER correction_units_no_delete BEFORE DELETE ON correction_units BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER correction_units_final BEFORE UPDATE ON correction_units WHEN OLD.state NOT IN ('prepared','write_started')
    BEGIN SELECT RAISE(ABORT,'final'); END;
`;

/**
 * Added after version 1 shipped, created on open with IF NOT EXISTS: additive tables an older build ignores, so the
 * meta version stays 1 and a rollback still opens the file. Both are append-only like the evidence tables.
 * - correction_requests: idempotency ledger of management requests (attest/bind) by requestId.
 * - correction_bindings: a human's binding of one correction scope to manifest check ids (latest row wins).
 */
const MANAGEMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS correction_requests(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS correction_bindings(memory_id TEXT NOT NULL, entry_key TEXT NOT NULL, content_version_hash TEXT NOT NULL,
    bound_at TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS correction_bindings_scope ON correction_bindings(memory_id, entry_key, content_version_hash);
  CREATE TRIGGER IF NOT EXISTS correction_requests_append_only_update BEFORE UPDATE ON correction_requests BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER IF NOT EXISTS correction_requests_append_only_delete BEFORE DELETE ON correction_requests BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER IF NOT EXISTS correction_bindings_append_only_update BEFORE UPDATE ON correction_bindings BEGIN SELECT RAISE(ABORT,'append-only'); END;
  CREATE TRIGGER IF NOT EXISTS correction_bindings_append_only_delete BEFORE DELETE ON correction_bindings BEGIN SELECT RAISE(ABORT,'append-only'); END;
`;

/** A human's binding of a correction scope to at most four manifest checks, with each pinned digest (definition + argv-named files) at bind time. */
export interface CorrectionCheckBinding {
  memoryId: string;
  entryKey: string;
  contentVersionHash: string;
  checks: {id: string; digest: string}[];
  boundAt: string;
  requestId: string;
}
export type CorrectionManagementRecord =
  | {state: 'recorded'; result: Record<string, unknown>}
  | {state: 'replayed'; result: Record<string, unknown>}
  | {state: 'conflict'}
  | {state: 'full'}
  /** `openUnitId` already had an outcome when the write's transaction looked: nothing was written. */
  | {state: 'final'};

const decodeUnit = (body: string): CorrectionExposureUnit => {
  if (body.length > 4096) throw new Error('교정 결과 기록 크기를 확인하세요.');
  return JSON.parse(body) as CorrectionExposureUnit;
};
const decodeOutcome = (unitId: string, body: string): CorrectionOutcome => {
  if (body.length > 8192) throw new Error('교정 결과 기록 크기를 확인하세요.');
  return {...(JSON.parse(body) as CorrectionClassification), unitId};
};

export class CorrectionOutcomeStore {
  readonly #db: Database;
  readonly #path: string;
  readonly #root: string;
  readonly #parent: string;
  readonly #identity: string;
  readonly #rootIdentity: string;
  readonly #parentIdentity: string;
  readonly #rowLimit: number;
  readonly #maxBytes: number;
  #closed = false;
  constructor(appDataDir: string, private readonly now = () => new Date().toISOString(), options: {rowLimit?: number; maxBytes?: number} = {}) {
    if (!isAbsolute(appDataDir)) throw new Error('교정 결과 저장 위치를 확인하세요.');
    this.#rowLimit = Math.max(1, Math.min(CORRECTION_OUTCOME_STORE_ROW_LIMIT, options.rowLimit ?? CORRECTION_OUTCOME_STORE_ROW_LIMIT));
    this.#maxBytes = Math.max(16 * 1024, Math.min(CORRECTION_OUTCOME_STORE_MAX_BYTES, options.maxBytes ?? CORRECTION_OUTCOME_STORE_MAX_BYTES));
    stamp(appDataDir, true);
    this.#parent = realpathSync(appDataDir);
    this.#parentIdentity = stamp(this.#parent, true);
    this.#root = join(this.#parent, DIRECTORY);
    try { lstatSync(this.#root); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(this.#root, {mode: 0o700});
    }
    this.#rootIdentity = stamp(this.#root, true, true);
    this.#path = join(this.#root, FILE);
    let fresh = false;
    try { lstatSync(this.#path); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      closeSync(openSync(this.#path, 'wx', 0o600)); fresh = true;
    }
    this.#identity = stamp(this.#path, false);
    this.#db = new Database(this.#path, {create: false, strict: true});
    try {
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF;');
      if (fresh) {
        this.#db.exec(SCHEMA);
        this.#db.query('INSERT INTO correction_meta VALUES(1,1,?,?,NULL,0)').run(randomUUID(), this.now());
      }
      const meta = this.#db.query('SELECT version FROM correction_meta WHERE singleton=1').get() as {version: number} | null;
      if (meta?.version !== 1) throw new Error('지원되지 않거나 손상된 교정 결과 기록입니다. 원본은 유지합니다.');
      this.#db.exec(MANAGEMENT_SCHEMA);
    } catch (error) { this.#db.close(); throw error; }
  }
  #validate() {
    if (this.#closed || stamp(this.#parent, true) !== this.#parentIdentity || stamp(this.#root, true, true) !== this.#rootIdentity
      || stamp(this.#path, false) !== this.#identity) throw new Error('교정 결과 저장소가 변경되었거나 닫혔습니다.');
  }
  #full(table: string) {
    if (statSync(this.#path).size >= this.#maxBytes) return true;
    return (this.#db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n >= this.#rowLimit;
  }
  meta() {
    this.#validate();
    const row = this.#db.query('SELECT activated_at,journal_instance_id,rowid_cursor FROM correction_meta WHERE singleton=1').get() as
      {activated_at: string; journal_instance_id: string | null; rowid_cursor: number};
    return {activatedAt: row.activated_at, journalStoreInstanceId: row.journal_instance_id, rowidCursor: row.rowid_cursor};
  }
  /** Binds the first journal lineage seen; a different one is refused instead of mixed. */
  bindJournal(instanceId: string): 'ok' | 'mismatch' {
    const meta = this.meta();
    if (meta.journalStoreInstanceId === null) {
      this.#db.query('UPDATE correction_meta SET journal_instance_id=? WHERE singleton=1 AND journal_instance_id IS NULL').run(instanceId);
      return this.meta().journalStoreInstanceId === instanceId ? 'ok' : 'mismatch';
    }
    return meta.journalStoreInstanceId === instanceId ? 'ok' : 'mismatch';
  }
  advanceCursor(rowid: number) {
    this.#validate();
    if (!Number.isSafeInteger(rowid) || rowid < 0) throw new Error('교정 결과 기록 위치를 확인하세요.');
    this.#db.query('UPDATE correction_meta SET rowid_cursor=MAX(rowid_cursor,?) WHERE singleton=1').run(rowid);
  }
  putUnit(unit: CorrectionExposureUnit, submissionKey: string): Write {
    this.#validate();
    if (this.#db.query('SELECT 1 FROM correction_units WHERE unit_id=?').get(unit.unitId)) return 'exists';
    if (this.#full('correction_units')) return 'full';
    const body = JSON.stringify(unit);
    if (body.length > 4096) throw new Error('교정 노출 기록 크기를 확인하세요.');
    this.#db.query('INSERT OR IGNORE INTO correction_units VALUES(?,?,?,?,?,?,?,?)')
      .run(unit.unitId, submissionKey, unit.memoryId, unit.entryKey, unit.contentVersionHash, unit.state, unit.writtenAt, body);
    return 'inserted';
  }
  /** Only a still-writing unit may move to its final state; the trigger refuses anything else. */
  refreshUnit(unitId: string, state: CorrectionExposureState, writtenAt: string | null) {
    this.#validate();
    const row = this.#db.query('SELECT body FROM correction_units WHERE unit_id=?').get(unitId) as {body: string} | null;
    if (!row) return;
    const unit = decodeUnit(row.body);
    if (!NON_FINAL.includes(unit.state)) return;
    const next = {...unit, state, writtenAt};
    this.#db.query('UPDATE correction_units SET state=?,written_at=?,body=? WHERE unit_id=?').run(state, writtenAt, JSON.stringify(next), unitId);
  }
  nonFinalUnits(): {unitId: string; submissionKey: string; state: CorrectionExposureState}[] {
    this.#validate();
    return (this.#db.query("SELECT unit_id,submission_key,state FROM correction_units WHERE state IN ('prepared','write_started') LIMIT 256").all() as
      {unit_id: string; submission_key: string; state: CorrectionExposureState}[]).map(r => ({unitId: r.unit_id, submissionKey: r.submission_key, state: r.state}));
  }
  units(memoryId?: string): CorrectionExposureUnit[] {
    this.#validate();
    const rows = (memoryId === undefined
      ? this.#db.query('SELECT body FROM correction_units ORDER BY rowid').all()
      : this.#db.query('SELECT body FROM correction_units WHERE memory_id=? ORDER BY rowid').all(memoryId)) as {body: string}[];
    return rows.map(r => decodeUnit(r.body));
  }
  unitsInScope(memoryId: string, entryKey: string, contentVersionHash: string): CorrectionExposureUnit[] {
    this.#validate();
    return (this.#db.query('SELECT body FROM correction_units WHERE memory_id=? AND entry_key=? AND content_version_hash=? ORDER BY rowid LIMIT 1024')
      .all(memoryId, entryKey, contentVersionHash) as {body: string}[]).map(r => decodeUnit(r.body));
  }
  /** Oldest first; units without a write time (always excluded) come first so they leave the queue at once. */
  unitsWithoutOutcome(limit: number): CorrectionExposureUnit[] {
    this.#validate();
    return (this.#db.query('SELECT body FROM correction_units WHERE unit_id NOT IN (SELECT unit_id FROM correction_outcomes) ORDER BY COALESCE(written_at,\'\'),rowid LIMIT ?')
      .all(Math.max(1, Math.min(256, limit))) as {body: string}[]).map(r => decodeUnit(r.body));
  }
  addObservation(unitId: string, observation: CorrectionObservation): Write {
    this.#validate();
    const parsed = parseCorrectionObservation(observation), id = correctionObservationId(parsed);
    if (this.#db.query('SELECT 1 FROM correction_observations WHERE observation_id=? AND unit_id=?').get(id, unitId)) return 'exists';
    if (this.#full('correction_observations')) return 'full';
    this.#db.query('INSERT OR IGNORE INTO correction_observations VALUES(?,?,?,?)').run(id, unitId, parsed.source, JSON.stringify(parsed));
    return 'inserted';
  }
  observations(unitId: string): CorrectionObservation[] {
    this.#validate();
    return (this.#db.query('SELECT body FROM correction_observations WHERE unit_id=? ORDER BY rowid LIMIT 256').all(unitId) as {body: string}[])
      .map(r => parseCorrectionObservation(JSON.parse(r.body)));
  }
  addOutcome(unitId: string, outcome: CorrectionClassification): Write {
    this.#validate();
    if (outcome.status === 'pending') throw new Error('관찰 기간이 끝나지 않은 결과는 확정하지 않습니다.');
    if (this.#db.query('SELECT 1 FROM correction_outcomes WHERE unit_id=? AND protocol_hash=?').get(unitId, outcome.protocolHash)) return 'exists';
    if (this.#full('correction_outcomes')) return 'full';
    const {status, reason, evidenceRefs, sources, protocolHash} = outcome;
    this.#db.query('INSERT OR IGNORE INTO correction_outcomes VALUES(?,?,?,?,?,?)')
      .run(unitId, protocolHash, status, reason, this.now(), JSON.stringify({status, reason, evidenceRefs, sources, protocolHash}));
    return 'inserted';
  }
  outcome(unitId: string): CorrectionOutcome | null {
    this.#validate();
    const row = this.#db.query('SELECT body FROM correction_outcomes WHERE unit_id=? ORDER BY rowid LIMIT 1').get(unitId) as {body: string} | null;
    return row ? decodeOutcome(unitId, row.body) : null;
  }
  outcomes(memoryId?: string): CorrectionOutcome[] {
    this.#validate();
    const rows = (memoryId === undefined
      ? this.#db.query('SELECT unit_id,body FROM correction_outcomes ORDER BY rowid').all()
      : this.#db.query('SELECT o.unit_id,o.body FROM correction_outcomes o JOIN correction_units u ON u.unit_id=o.unit_id WHERE u.memory_id=? ORDER BY o.rowid').all(memoryId)) as
      {unit_id: string; body: string}[];
    return rows.map(r => decodeOutcome(r.unit_id, r.body));
  }
  unit(unitId: string): CorrectionExposureUnit | null {
    this.#validate();
    const row = this.#db.query('SELECT body FROM correction_units WHERE unit_id=?').get(unitId) as {body: string} | null;
    return row ? decodeUnit(row.body) : null;
  }
  /** Written units of one memory, newest first. Bounded; the caller filters eligibility. */
  recentWrittenUnits(memoryId: string, limit: number): CorrectionExposureUnit[] {
    this.#validate();
    return (this.#db.query("SELECT body FROM correction_units WHERE memory_id=? AND state='written' ORDER BY written_at DESC, rowid DESC LIMIT ?")
      .all(memoryId, Math.max(1, Math.min(256, limit))) as {body: string}[]).map(r => decodeUnit(r.body));
  }
  /** The answer already recorded for a management requestId, or null. */
  managementRequest(requestId: string): {fingerprint: string; result: Record<string, unknown>} | null {
    this.#validate();
    const row = this.#db.query('SELECT fingerprint,result FROM correction_requests WHERE request_id=?').get(requestId) as {fingerprint: string; result: string} | null;
    if (!row) return null;
    if (row.result.length > 4096) throw new Error('교정 결과 기록 크기를 확인하세요.');
    return {fingerprint: row.fingerprint, result: JSON.parse(row.result)};
  }
  /**
   * One management write, idempotent by requestId: the same id with the same fingerprint replays the stored answer, a
   * different fingerprint is a conflict, and the evidence row and the ledger row are written in one transaction.
   * `openUnitId`: the unit the write is about must still have no outcome — checked inside that same transaction, since the
   * caller awaited between its own checks and this write and an observer tick may have finalized the unit meanwhile
   * (review S4-05, 2026-10-16). A replay still answers first: a request recorded before finality keeps its answer.
   */
  recordManagement(requestId: string, fingerprint: string, result: Record<string, unknown>,
    write: {observation: {unitId: string; observation: CorrectionObservation}} | {binding: CorrectionCheckBinding},
    openUnitId?: string): CorrectionManagementRecord {
    this.#validate();
    const body = JSON.stringify(result);
    if (body.length > 4096) throw new Error('교정 결과 기록 크기를 확인하세요.');
    return this.#db.transaction((): CorrectionManagementRecord => {
      const existing = this.managementRequest(requestId);
      if (existing) return existing.fingerprint === fingerprint ? {state: 'replayed', result: existing.result} : {state: 'conflict'};
      if (openUnitId !== undefined && this.#db.query('SELECT 1 FROM correction_outcomes WHERE unit_id=? LIMIT 1').get(openUnitId)) return {state: 'final'};
      if (this.#full('correction_requests')) return {state: 'full'};
      if ('observation' in write) {
        if (this.addObservation(write.observation.unitId, write.observation.observation) === 'full') return {state: 'full'};
      } else {
        if (this.#full('correction_bindings')) return {state: 'full'};
        const binding = JSON.stringify(write.binding);
        if (binding.length > 4096) throw new Error('교정 결과 기록 크기를 확인하세요.');
        this.#db.query('INSERT INTO correction_bindings VALUES(?,?,?,?,?)')
          .run(write.binding.memoryId, write.binding.entryKey, write.binding.contentVersionHash, write.binding.boundAt, binding);
      }
      this.#db.query('INSERT INTO correction_requests VALUES(?,?,?)').run(requestId, fingerprint, body);
      return {state: 'recorded', result};
    })();
  }
  /** The latest binding of a scope made no later than `notAfter` (an ISO time), or null. */
  binding(memoryId: string, entryKey: string, contentVersionHash: string, notAfter?: string): CorrectionCheckBinding | null {
    this.#validate();
    const row = this.#db.query('SELECT body FROM correction_bindings WHERE memory_id=? AND entry_key=? AND content_version_hash=? AND (? IS NULL OR bound_at<=?) ORDER BY rowid DESC LIMIT 1')
      .get(memoryId, entryKey, contentVersionHash, notAfter ?? null, notAfter ?? null) as {body: string} | null;
    if (!row) return null;
    if (row.body.length > 4096) throw new Error('교정 결과 기록 크기를 확인하세요.');
    return JSON.parse(row.body) as CorrectionCheckBinding;
  }
  close() { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}

export interface CorrectionOutcomeReport {
  protocolVersion: number;
  protocolHash: string;
  protocolStatus: CorrectionOutcomeProtocol['status'];
  summary: Omit<CorrectionOutcomeSummary, 'protocolVersion' | 'protocolHash' | 'protocolStatus'> | null;
  coverage: typeof CORRECTION_OUTCOME_COVERAGE;
  learning: ReturnType<typeof evaluateCorrectionLearningTrack>;
  productGoalVerified: false;
  efficacyVerified: false;
}

/**
 * Read-only export: counts, the protocol version/hash and the coverage note. No ids, titles, evidence or task text.
 * Never creates the store — a missing store is reported as not run.
 */
export function readCorrectionOutcomeReport(appDataDir: string, now = Date.now(), protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL): CorrectionOutcomeReport {
  const base = {protocolVersion: protocol.version, protocolHash: correctionOutcomeProtocolHash(protocol), protocolStatus: protocol.status,
    coverage: CORRECTION_OUTCOME_COVERAGE, productGoalVerified: false as const, efficacyVerified: false as const};
  if (!isAbsolute(appDataDir)) throw new Error('교정 결과 저장 위치를 확인하세요.');
  const path = join(appDataDir, DIRECTORY, FILE);
  try { lstatSync(path); } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    return {...base, summary: null, learning: evaluateCorrectionLearningTrack(null)};
  }
  stamp(join(appDataDir, DIRECTORY), true, true);
  stamp(path, false);
  const db = new Database(path, {readonly: true, strict: true});
  try {
    const meta = db.query('SELECT version,activated_at FROM correction_meta WHERE singleton=1').get() as {version: number; activated_at: string} | null;
    if (meta?.version !== 1) throw new Error('지원되지 않거나 손상된 교정 결과 기록입니다.');
    const units = (db.query('SELECT body FROM correction_units ORDER BY rowid').all() as {body: string}[]).map(r => decodeUnit(r.body));
    const outcomes = (db.query('SELECT unit_id,body FROM correction_outcomes ORDER BY rowid').all() as {unit_id: string; body: string}[])
      .map(r => decodeOutcome(r.unit_id, r.body));
    const {protocolVersion: _v, protocolHash: _h, protocolStatus: _s, ...summary} = summarizeCorrectionOutcomes(units, outcomes, now, protocol, {activatedAt: meta.activated_at});
    return {...base, summary, learning: evaluateCorrectionLearningTrack({...summary, protocolVersion: _v, protocolHash: _h, protocolStatus: _s})};
  } finally { db.close(); }
}
