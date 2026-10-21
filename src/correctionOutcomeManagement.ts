import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {
  CORRECTION_OUTCOME_PROTOCOL, correctionExposureExclusion,
  type CorrectionObservation, type CorrectionOutcomeProtocol,
} from './projectMemoryCorrectionOutcome';
import type {CorrectionCheckBinding, CorrectionOutcomeStore} from './correctionOutcomeStore';
import type {TesterManifestCheck} from './correctionTesterObservations';
import {
  CORRECTION_OUTCOME_BIND_CHECK_LIMIT, CORRECTION_OUTCOME_LIST_LIMIT,
  type CorrectionOutcomeListRow, type CorrectionOutcomeRequest, type CorrectionOutcomeVerdict,
} from './correctionOutcomeWire';

/**
 * The Mac-only management route for the two human-driven outcome signals (S4-05 attestation, S4-06 check binding).
 *
 * POST /api/agent-runtime/correction-outcomes, reachable only through the agent-runtime management gate (the local
 * AgentsToZ UI with its capability). There is no MCP/agentstoz_use surface and no remote/phone path: an AI or a paired
 * phone cannot attest its own work. `perform` additionally refuses any authority other than 'local-management'.
 *
 * - list:   ≤20 recent eligible exposures of one project memory — conversation title, entry title, times, window
 *           state, the stored outcome and earlier attestations. Never task text or evidence text.
 * - attest: a verdict ('avoided' | 'repeated' | 'unsure') on one written, eligible exposure while its window is open.
 *           Idempotent by requestId. A second, different verdict is stored too and the unit finalizes as
 *           unknown('conflict') — the classifier, not this route, decides.
 * - bind:   ties the exposure's correction scope to ≤4 checks of the target's current manifest, recording each check's
 *           pinned digest (manifest entry + the files its argv names); only tester runs after the binding are scored.
 */
export {
  CORRECTION_OUTCOMES_MAX_REQUEST_BYTES, CORRECTION_OUTCOMES_PATH, CORRECTION_OUTCOME_BIND_CHECK_LIMIT, CORRECTION_OUTCOME_LIST_LIMIT,
} from './correctionOutcomeWire';
export type {CorrectionOutcomeListRow, CorrectionOutcomeRequest, CorrectionOutcomeVerdict} from './correctionOutcomeWire';
const LIST_SCAN_LIMIT = 200;
const AVAILABLE_CHECK_LIMIT = 32;
const TITLE_LIMIT = 120;

export type CorrectionOutcomeAuthority = 'local-management';

export class CorrectionOutcomeManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const fail = (code: string, message: string, status = 409): never => { throw new CorrectionOutcomeManagementError(code, message, status); };

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/, UNIT_ID = /^[0-9a-f]{64}$/, CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYS: Record<CorrectionOutcomeRequest['operation'], readonly string[]> = {
  list: ['operation', 'folderPath', 'requestId'],
  attest: ['operation', 'unitId', 'verdict', 'requestId'],
  bind: ['operation', 'unitId', 'checkIds', 'requestId'],
};

/** Strict: exact keys per operation. Anything else is refused before the store is touched. */
export function normalizeCorrectionOutcomeRequest(value: unknown): CorrectionOutcomeRequest {
  const invalid = () => fail('CORRECTION_OUTCOME_REQUEST_INVALID', '교정 결과 요청 형식이 올바르지 않습니다.', 400);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>, keys = KEYS[raw.operation as CorrectionOutcomeRequest['operation']];
  if (!keys) return invalid();
  const actual = Object.keys(raw);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  if (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) return invalid();
  if (raw.operation === 'list') {
    if (typeof raw.folderPath !== 'string' || !raw.folderPath || raw.folderPath.length > 4096 || raw.folderPath.includes('\0')
      || !isAbsolute(raw.folderPath)) return invalid();
    return {operation: 'list', folderPath: raw.folderPath, requestId: raw.requestId};
  }
  if (typeof raw.unitId !== 'string' || !UNIT_ID.test(raw.unitId)) return invalid();
  if (raw.operation === 'attest') {
    if (!['avoided', 'repeated', 'unsure'].includes(raw.verdict as string)) return invalid();
    return {operation: 'attest', unitId: raw.unitId, verdict: raw.verdict as CorrectionOutcomeVerdict, requestId: raw.requestId};
  }
  const ids = raw.checkIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > CORRECTION_OUTCOME_BIND_CHECK_LIMIT
    || !ids.every(id => typeof id === 'string' && CHECK_ID.test(id)) || new Set(ids).size !== ids.length) return invalid();
  return {operation: 'bind', unitId: raw.unitId, checkIds: [...ids] as string[], requestId: raw.requestId};
}

export interface CorrectionOutcomeManagementDeps {
  /** The pipeline is on for this process. When false nothing is opened. */
  active(): boolean;
  store(): CorrectionOutcomeStore;
  /** The project memory at `folderPath` and its current entries (titles only), or null. */
  memory(folderPath: string): Promise<{memoryId: string; entries: {entryKey: string; contentVersionHash: string; title: string}[]} | null>;
  /** Same rule as the observer: true = OPS/shared root, 'unresolved' = cannot be shown otherwise. */
  excluded(targetId: string): Promise<boolean | 'unresolved'>;
  /** The saved conversation title for a workroom session, or null. */
  conversationTitle(sessionId: string): string | null;
  /** The target's current manifest checks, or null when it cannot be read. */
  checks(targetId: string): Promise<ReadonlyMap<string, TesterManifestCheck> | null>;
  now?(): number;
  protocol?: CorrectionOutcomeProtocol;
}


const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const title = (value: string | null | undefined) => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return text ? text.slice(0, TITLE_LIMIT) : null;
};
const iso = (ms: number) => new Date(ms).toISOString();

export class CorrectionOutcomeManagement {
  constructor(private readonly deps: CorrectionOutcomeManagementDeps) {}
  get #protocol() { return this.deps.protocol ?? CORRECTION_OUTCOME_PROTOCOL; }
  #now() { return this.deps.now?.() ?? Date.now(); }

  async perform(value: unknown, authority: CorrectionOutcomeAuthority) {
    if (!this.deps.active()) fail('CORRECTION_OUTCOMES_DISABLED', '교정 결과 확인이 꺼져 있습니다.');
    const request = normalizeCorrectionOutcomeRequest(value);
    if (authority !== 'local-management') fail('CORRECTION_OUTCOME_LOCAL_ONLY', '교정 결과는 이 Mac의 AgentsToZ 화면에서만 남길 수 있습니다.', 403);
    if (request.operation === 'list') return this.#list(request);
    return request.operation === 'attest' ? this.#attest(request) : this.#bind(request);
  }

  async #list(request: Extract<CorrectionOutcomeRequest, {operation: 'list'}>) {
    const memory = await this.deps.memory(request.folderPath);
    if (!memory) fail('CORRECTION_OUTCOME_MEMORY_NOT_FOUND', '이 폴더의 장기기억을 찾지 못했습니다.', 404);
    const store = this.deps.store(), protocol = this.#protocol, now = this.#now(), {activatedAt} = store.meta();
    const eligible = store.recentWrittenUnits(memory!.memoryId, LIST_SCAN_LIMIT)
      .filter(unit => !correctionExposureExclusion(unit, protocol, {activatedAt}));
    const units = eligible.slice(0, CORRECTION_OUTCOME_LIST_LIMIT);
    const targets = new Map<string, boolean>(), checks = new Map<string, ReadonlyMap<string, TesterManifestCheck> | null>();
    for (const unit of units) {
      if (targets.has(unit.targetId)) continue;
      let allowed = false;
      try { allowed = (await this.deps.excluded(unit.targetId)) === false; } catch { allowed = false; }
      targets.set(unit.targetId, allowed);
    }
    const entries = new Map(memory!.entries.map(entry => [entry.entryKey, entry]));
    const rows: CorrectionOutcomeListRow[] = [];
    for (const unit of units) {
      const written = Date.parse(unit.writtenAt!), closes = written + protocol.windowMs, windowOpen = now >= written && now <= closes;
      const outcome = store.outcome(unit.unitId)?.status ?? null;
      const attestable = windowOpen && outcome === null && targets.get(unit.targetId) === true;
      if (attestable && !checks.has(unit.targetId)) {
        let current: ReadonlyMap<string, TesterManifestCheck> | null = null;
        try { current = await this.deps.checks(unit.targetId); } catch { current = null; }
        checks.set(unit.targetId, current);
      }
      const available = attestable ? checks.get(unit.targetId) : null;
      let conversationTitle: string | null = null;
      try { conversationTitle = title(this.deps.conversationTitle(unit.sessionId)); } catch { conversationTitle = null; }
      const entry = entries.get(unit.entryKey);
      rows.push({
        unitId: unit.unitId, conversationTitle, entryTitle: title(entry?.title), entryCurrent: entry?.contentVersionHash === unit.contentVersionHash,
        writtenAt: unit.writtenAt!, windowClosesAt: iso(closes), windowOpen, attestable, outcome,
        attestations: this.#attestations(store, unit.unitId),
        boundChecks: store.binding(unit.memoryId, unit.entryKey, unit.contentVersionHash)?.checks.map(check => check.id) ?? [],
        availableChecks: available ? [...available].filter(([, check]) => !check.quarantined).map(([id]) => id).sort().slice(0, AVAILABLE_CHECK_LIMIT) : [],
      });
    }
    return {ok: true as const, operation: 'list' as const, units: rows, truncated: eligible.length > units.length};
  }

  #attestations(store: CorrectionOutcomeStore, unitId: string): CorrectionOutcomeVerdict[] {
    return store.observations(unitId).flatMap(o => o.source === 'human-attestation' ? [o.verdict] : []);
  }

  /** The checks every write shares: the unit exists, is eligible, belongs to a measurable target and is still open. */
  async #writable(store: CorrectionOutcomeStore, unitId: string) {
    const protocol = this.#protocol, {activatedAt} = store.meta();
    const unit = store.unit(unitId);
    if (!unit) return fail('CORRECTION_OUTCOME_UNIT_NOT_FOUND', '교정이 전달된 요청 기록을 찾지 못했습니다.', 404);
    if (correctionExposureExclusion(unit, protocol, {activatedAt})) {
      return fail('CORRECTION_OUTCOME_UNIT_INELIGIBLE', '이 요청은 결과 측정 대상이 아닙니다(전달 미확정·민감 원문 보류·관련성 부족·측정 시작 전).');
    }
    let excluded: boolean | 'unresolved' = 'unresolved';
    try { excluded = await this.deps.excluded(unit.targetId); } catch { excluded = 'unresolved'; }
    if (excluded !== false) return fail('CORRECTION_OUTCOME_TARGET_EXCLUDED', '운영(OPS)·공유 폴더이거나 지금 확인할 수 없는 프로젝트라 결과를 남기지 않습니다.');
    if (store.outcome(unit.unitId)) return fail('CORRECTION_OUTCOME_ALREADY_FINAL', '이미 결과가 확정된 요청입니다.');
    this.#openAt(unit);
    return {unit};
  }

  /**
   * The window, with the clock read at the call (review S4-05, 2026-10-16): a time taken before the route's awaits could
   * stamp a result inside a window that had already closed. attest/bind call it again right before their write, with no
   * await in between; finality is re-read inside the write's own transaction (recordManagement's `openUnitId`).
   */
  #openAt(unit: {writtenAt: string | null}) {
    const now = this.#now();
    const written = Date.parse(unit.writtenAt!);
    if (!(now >= written && now <= written + this.#protocol.windowMs)) {
      return fail('CORRECTION_OUTCOME_WINDOW_CLOSED', '관찰 기간이 끝난 요청입니다. 결과는 관찰 기간 안에만 남길 수 있습니다.');
    }
    return now;
  }

  #replay(store: CorrectionOutcomeStore, requestId: string, fingerprint: string) {
    const existing = store.managementRequest(requestId);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) fail('CORRECTION_OUTCOME_REQUEST_ID_CONFLICT', '같은 요청 ID로 다른 결과가 이미 기록됐습니다. 새로 다시 보내세요.');
    return existing.result;
  }

  async #attest(request: Extract<CorrectionOutcomeRequest, {operation: 'attest'}>) {
    const store = this.deps.store(), fingerprint = sha256(['attest', request.unitId, request.verdict]);
    const conflictFor = () => new Set(this.#attestations(store, request.unitId)).size > 1;
    const replayed = this.#replay(store, request.requestId, fingerprint);
    if (replayed) return {...replayed, recorded: 'exists' as const, conflict: conflictFor()};
    const {unit} = await this.#writable(store, request.unitId);
    const recordedAt = iso(this.#openAt(unit));
    const observation: CorrectionObservation = {source: 'human-attestation', unitId: unit.unitId, verdict: request.verdict, at: recordedAt};
    const result = {ok: true, operation: 'attest', unitId: unit.unitId, verdict: request.verdict, recordedAt};
    return this.#settle(store.recordManagement(request.requestId, fingerprint, result, {observation: {unitId: unit.unitId, observation}}, unit.unitId), conflictFor);
  }

  async #bind(request: Extract<CorrectionOutcomeRequest, {operation: 'bind'}>) {
    const store = this.deps.store(), checkIds = [...request.checkIds].sort();
    const fingerprint = sha256(['bind', request.unitId, checkIds]);
    const replayed = this.#replay(store, request.requestId, fingerprint);
    if (replayed) return {...replayed, recorded: 'exists' as const};
    const {unit} = await this.#writable(store, request.unitId);
    let current: ReadonlyMap<string, TesterManifestCheck> | null = null;
    try { current = await this.deps.checks(unit.targetId); } catch { current = null; }
    if (!current) return fail('CORRECTION_OUTCOME_CHECKS_UNAVAILABLE', '이 프로젝트의 테스터 설정(.agentstoz/maintainer.json)을 읽지 못했습니다.');
    const checks = checkIds.map(id => {
      const check = current!.get(id);
      if (!check) return fail('CORRECTION_OUTCOME_CHECK_UNKNOWN', `테스터 설정에 없는 검사입니다: ${id}`);
      if (check.quarantined) return fail('CORRECTION_OUTCOME_CHECK_QUARANTINED', `격리된 검사는 연결할 수 없습니다: ${id}`);
      return {id, digest: check.digest};
    });
    const boundAt = iso(this.#openAt(unit));
    const binding: CorrectionCheckBinding = {memoryId: unit.memoryId, entryKey: unit.entryKey, contentVersionHash: unit.contentVersionHash, checks, boundAt, requestId: request.requestId};
    const result = {ok: true, operation: 'bind', unitId: unit.unitId, checkIds, boundAt};
    return this.#settle(store.recordManagement(request.requestId, fingerprint, result, {binding}, unit.unitId));
  }

  #settle(record: ReturnType<CorrectionOutcomeStore['recordManagement']>, conflictFor?: () => boolean) {
    if (record.state === 'full') return fail('CORRECTION_OUTCOME_STORE_FULL', '교정 결과 기록이 가득 찼습니다. 새 결과를 더 남기지 않습니다.');
    if (record.state === 'conflict') return fail('CORRECTION_OUTCOME_REQUEST_ID_CONFLICT', '같은 요청 ID로 다른 결과가 이미 기록됐습니다. 새로 다시 보내세요.');
    if (record.state === 'final') {
      return fail('CORRECTION_OUTCOME_FINALIZED_MEANWHILE', '남기는 사이 이 요청의 관찰 결과가 확정되어 이 결과는 남기지 않았습니다.');
    }
    return {...record.result, recorded: record.state === 'recorded' ? 'inserted' as const : 'exists' as const, ...(conflictFor ? {conflict: conflictFor()} : {})};
  }
}
