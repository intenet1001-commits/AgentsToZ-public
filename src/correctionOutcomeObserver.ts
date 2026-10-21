import {
  CORRECTION_OUTCOME_PROTOCOL, classifyCorrectionOutcome, correctionExposureExclusion, correctionExposureUnitId,
  correctionObservationApplies, parseCorrectionObservation, summarizeCorrectionOutcomes,
  type CorrectionExposureUnit, type CorrectionObservation, type CorrectionOutcomeProtocol,
} from './projectMemoryCorrectionOutcome';
import {correctionReportId, type CorrectionTaskExposure} from './projectMemoryCorrectionContext';
import {isProjectMemoryCorrection, type ProjectMemoryFeedbackEvent} from './projectMemoryFeedback';
import type {CorrectionOutcomeStore} from './correctionOutcomeStore';
import type {StoredSubmission} from './workroomSubmissions';

const INGEST_LIMIT = 256;
const FINALIZE_LIMIT = 32;
const HOUR = 3_600_000;
/** Ticks an exposure row whose target cannot be resolved is retried before it is disclosed as excluded. */
export const CORRECTION_OUTCOME_UNRESOLVED_RETRY_TICKS = 5;

export interface CorrectionExposureSource {
  readonly storeInstanceId: string;
  correctionExposureUnits(afterRowid: number, limit: number): {rowid: number; key: string; state: StoredSubmission['state']; targetId: string;
    sessionId: string; startedAt: string | null; writtenAt: string | null; exposure: CorrectionTaskExposure | null}[];
  submission(key: string): StoredSubmission | null;
}
export interface CorrectionOutcomeObserverDeps {
  /** Opened lazily; only constructed at all when the pipeline is enabled. */
  store(): CorrectionOutcomeStore;
  journal(): CorrectionExposureSource | null;
  /**
   * true: OPS or a protected shared root, never ingested. false: ingest. 'unresolved': the target could not be resolved
   * right now (for example the registry was unreadable) — retried on later ticks, then disclosed as excluded.
   */
  excluded(targetId: string): Promise<boolean | 'unresolved'>;
  /** That target's feedback ledger, or null when it cannot be read (the unit then stays unfinalized). */
  ledger(targetId: string): Promise<ProjectMemoryFeedbackEvent[] | null>;
  /** This device's portal deviceId; locally recorded events carry none. */
  deviceId(): string | null;
  /**
   * Tester-check observations (S4-06) for a unit whose scope a human bound to manifest checks. Optional; a throw or an
   * unreadable history gives no signal. `tick` is a per-finalize cache so one target's files are read once.
   */
  testerObservations?(unit: CorrectionExposureUnit, store: CorrectionOutcomeStore, tick: Map<string, unknown>): Promise<CorrectionObservation[]>;
  now?(): number;
  protocol?: CorrectionOutcomeProtocol;
}
/**
 * The exclusion rule for one target, shared by the observer and the attestation route. true: OPS or a protected shared
 * root. 'unresolved': it could not be shown to be neither right now (the registry, the profile or the OPS binding was
 * unreadable) — never treated as ingestible.
 */
export async function correctionOutcomeTargetExclusion(targetId: string, deps: {
  opsProjectId(): string | null | undefined;
  resolveCwd(targetId: string): Promise<string>;
  protectsSharedRoot(cwd: string): boolean;
}): Promise<boolean | 'unresolved'> {
  try {
    if (targetId === deps.opsProjectId()) return true;
    return deps.protectsSharedRoot(await deps.resolveCwd(targetId));
  } catch { return 'unresolved'; }
}
export interface CorrectionOutcomeOverview {
  state: 'idle' | 'ok' | 'unavailable' | 'full';
  pending: number;
  /** Window closed but not yet finalized. */
  backlog: number;
  /** Backlog older than window + 1h. */
  overdue: number;
  /** Re-corrections and tester runs that fell inside two sessions' windows: attributed to neither. */
  ambiguous: number;
}

/**
 * Ingests exposure receipts from the workroom journal by rowid cursor, gathers re-correction observations from the
 * existing feedback ledger, and finalizes units whose window has closed. Never calls a model, never writes
 * .agent-memory, never re-scores a finalized unit.
 */
export class CorrectionOutcomeObserver {
  #running = false;
  #ambiguous = new Set<string>();
  /** Consecutive ticks each target has been unresolvable; cleared once it resolves. */
  #unresolved = new Map<string, number>();
  #overview: CorrectionOutcomeOverview = {state: 'idle', pending: 0, backlog: 0, overdue: 0, ambiguous: 0};
  constructor(private readonly deps: CorrectionOutcomeObserverDeps) {}
  get #protocol() { return this.deps.protocol ?? CORRECTION_OUTCOME_PROTOCOL; }
  #now() { return this.deps.now?.() ?? Date.now(); }

  async observe() {
    if (this.#running) return;
    this.#running = true;
    let state: CorrectionOutcomeOverview['state'] = 'ok';
    let store: CorrectionOutcomeStore | null = null;
    try {
      store = this.deps.store();
      const journal = this.deps.journal();
      if (!journal || store.bindJournal(journal.storeInstanceId) !== 'ok') { state = 'unavailable'; return; }
      // Only units still being written are re-read; final units are never touched again.
      const reread = new Map<string, StoredSubmission | null>();
      for (const unit of store.nonFinalUnits()) {
        if (!reread.has(unit.submissionKey)) reread.set(unit.submissionKey, journal.submission(unit.submissionKey));
        const record = reread.get(unit.submissionKey);
        if (record && record.state !== unit.state) store.refreshUnit(unit.unitId, record.state, record.writtenAt ?? null);
      }
      const rows = journal.correctionExposureUnits(store.meta().rowidCursor, INGEST_LIMIT);
      let caughtUp = rows.length < INGEST_LIMIT;
      const counted = new Set<string>();
      ingest: for (const row of rows) {
        const verdict = row.exposure ? await this.deps.excluded(row.targetId) : true;
        let targetUnresolved = false;
        if (verdict === 'unresolved') {
          // Count one attempt per target per tick. Until the retries run out the cursor stays on this row, so nothing
          // after it is ingested out of order and finalization waits.
          if (!counted.has(row.targetId)) { counted.add(row.targetId); this.#unresolved.set(row.targetId, (this.#unresolved.get(row.targetId) ?? 0) + 1); }
          if ((this.#unresolved.get(row.targetId) ?? 0) < CORRECTION_OUTCOME_UNRESOLVED_RETRY_TICKS) { caughtUp = false; break; }
          targetUnresolved = true;
        } else if (row.exposure) this.#unresolved.delete(row.targetId);
        if (row.exposure && verdict !== true) {
          for (const entry of row.exposure.entries) {
            const unit: CorrectionExposureUnit = {
              unitId: correctionExposureUnitId(row.key, entry.entryKey, entry.contentVersionHash),
              memoryId: row.exposure.memoryId, entryKey: entry.entryKey, contentVersionHash: entry.contentVersionHash,
              reportIds: [...entry.reportIds], targetId: row.targetId, sessionId: row.sessionId, writtenAt: row.writtenAt,
              state: row.state, sourceWithheld: row.exposure.sourceWithheld, relatedness: entry.relatedness ?? null,
              ...(targetUnresolved ? {targetUnresolved: true as const} : {}),
            };
            if (store.putUnit(unit, row.key) === 'full') { state = 'full'; caughtUp = false; break ingest; }
          }
        }
        store.advanceCursor(row.rowid);
      }
      // Finalize only once ingestion has caught up: a later exposure in the same scope changes attribution.
      if (caughtUp && !(await this.#finalize(store))) state = 'full';
    } catch (error) {
      state = 'unavailable';
      throw error;
    } finally {
      this.#running = false;
      this.#overview = {...this.#counts(store, state), state};
    }
  }

  async #finalize(store: CorrectionOutcomeStore) {
    const protocol = this.#protocol, now = this.#now(), {activatedAt} = store.meta();
    const ledgers = new Map<string, ProjectMemoryFeedbackEvent[] | null>(), tick = new Map<string, unknown>();
    let finalized = 0;
    for (const unit of store.unitsWithoutOutcome(INGEST_LIMIT)) {
      if (finalized >= FINALIZE_LIMIT) break;
      if (unit.state === 'prepared' || unit.state === 'write_started') continue;
      if (correctionExposureExclusion(unit, protocol, {activatedAt})) {
        if (store.addOutcome(unit.unitId, classifyCorrectionOutcome(unit, [], now, protocol, {activatedAt})) === 'full') return false;
        finalized++; continue;
      }
      if (now <= Date.parse(unit.writtenAt!) + protocol.windowMs) continue;
      if (!ledgers.has(unit.targetId)) {
        let events: ProjectMemoryFeedbackEvent[] | null = null;
        try { events = await this.deps.ledger(unit.targetId); } catch { events = null; }
        ledgers.set(unit.targetId, events);
      }
      const events = ledgers.get(unit.targetId);
      // An unreadable ledger is not 'no repeat': the unit stays unfinalized and shows up as backlog.
      if (!events) continue;
      for (const observation of this.#reCorrections(unit, events)) {
        if (!this.#attributes(store, unit, observation, observation.reportId)) continue;
        if (store.addObservation(unit.unitId, observation) === 'full') return false;
      }
      if (this.deps.testerObservations) {
        let tester: CorrectionObservation[] = [];
        try { tester = await this.deps.testerObservations(unit, store, tick); } catch { tester = []; }
        for (const raw of tester) {
          let observation: CorrectionObservation;
          try { observation = parseCorrectionObservation(raw); } catch { continue; }
          if (observation.source !== 'tester-check' || !correctionObservationApplies(unit, observation, protocol)) continue;
          // One run is one observation: the binding covers the whole scope, so every unit in it sees the same run.
          if (!this.#attributes(store, unit, observation, `tester:${observation.runId}:${observation.checkId}`)) continue;
          if (store.addObservation(unit.unitId, observation) === 'full') return false;
        }
      }
      const result = classifyCorrectionOutcome(unit, store.observations(unit.unitId), now, protocol, {activatedAt});
      if (result.status === 'pending') continue;
      if (store.addOutcome(unit.unitId, result) === 'full') return false;
      finalized++;
    }
    return true;
  }

  /**
   * The attribution rule every scope-wide signal shares (a re-correction, a tester run). Of the eligible units in the
   * scope whose window contains the observation, only the latest is credited; when units of more than one session
   * apply it is credited to none and counted as ambiguous under `ambiguityKey`.
   */
  #attributes(store: CorrectionOutcomeStore, unit: CorrectionExposureUnit, observation: CorrectionObservation, ambiguityKey: string) {
    const protocol = this.#protocol, {activatedAt} = store.meta();
    // A tester observation names one unit; ask each candidate the same question about the same run.
    const about = (c: CorrectionExposureUnit): CorrectionObservation => observation.source === 're-correction' ? observation : {...observation, unitId: c.unitId};
    const candidates = store.unitsInScope(unit.memoryId, unit.entryKey, unit.contentVersionHash)
      .filter(c => !correctionExposureExclusion(c, protocol, {activatedAt}) && correctionObservationApplies(c, about(c), protocol));
    if (new Set(candidates.map(c => c.sessionId)).size > 1) { this.#ambiguous.add(ambiguityKey); return false; }
    const latest = candidates.sort((a, b) => Date.parse(b.writtenAt!) - Date.parse(a.writtenAt!) || b.unitId.localeCompare(a.unitId))[0];
    return latest?.unitId === unit.unitId;
  }

  /** A later user re-correction of the same entry version. Labelled by its source; its author is not verified. */
  #reCorrections(unit: CorrectionExposureUnit, events: readonly ProjectMemoryFeedbackEvent[]) {
    const deviceId = this.deps.deviceId(), out: Extract<CorrectionObservation, {source: 're-correction'}>[] = [];
    for (const event of events) {
      if (!isProjectMemoryCorrection(event.kind) || event.memoryId !== unit.memoryId || event.entryKey !== unit.entryKey
        || event.contentVersionHash !== unit.contentVersionHash || !Number.isFinite(Date.parse(event.recordedAt))) continue;
      const observation = {source: 're-correction' as const, memoryId: event.memoryId, entryKey: event.entryKey,
        contentVersionHash: event.contentVersionHash, reportId: correctionReportId(event.id), at: event.recordedAt,
        localOrigin: event.deviceId == null || (deviceId !== null && event.deviceId === deviceId)};
      if (correctionObservationApplies(unit, observation, this.#protocol)) out.push(observation);
    }
    return out;
  }

  #counts(store: CorrectionOutcomeStore | null, state: CorrectionOutcomeOverview['state']) {
    const empty = {pending: 0, backlog: 0, overdue: 0, ambiguous: this.#ambiguous.size};
    if (!store || state === 'unavailable') return empty;
    try {
      const protocol = this.#protocol, now = this.#now(), {activatedAt} = store.meta();
      for (const unit of store.unitsWithoutOutcome(INGEST_LIMIT)) {
        if (unit.state !== 'written' || correctionExposureExclusion(unit, protocol, {activatedAt})) continue;
        const closes = Date.parse(unit.writtenAt!) + protocol.windowMs;
        if (now <= closes) empty.pending++;
        else { empty.backlog++; if (now > closes + HOUR) empty.overdue++; }
      }
    } catch { /* Counts are a display; a store error is reported through state on the next pass. */ }
    return empty;
  }

  overview(): CorrectionOutcomeOverview { return {...this.#overview}; }

  /** Summary for one memory (or all). Counts only — no ids or text. */
  summary(memoryId?: string) {
    const store = this.deps.store(), {activatedAt} = store.meta();
    return summarizeCorrectionOutcomes(store.units(memoryId), store.outcomes(memoryId), this.#now(), this.#protocol, {activatedAt});
  }
}
