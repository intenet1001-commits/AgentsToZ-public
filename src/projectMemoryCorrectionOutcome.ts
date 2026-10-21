import {createHash} from 'node:crypto';

/**
 * Pre-registered correction-outcome protocol and a pure classifier/summarizer.
 *
 * Question: after a reported correction was delivered into a later related task, did the same failure repeat?
 * Only three independent sources can answer it (a human attestation, a later user re-correction of the same entry
 * version, a deterministic tester check). Delivery counts, checkedAt, a zero pending count, agent applied/confirmed
 * feedback, self-reports and transcripts are not expressible as observations — the parser refuses them.
 *
 * CONFIRMED (2026-10-15): the user confirmed the window (72h), the relatedness thresholds (2 matched terms, 1 evidence
 * term) and the minimum samples (30 finalized units, 5 distinct corrections) that were proposed during planning.
 * Confirming flipped `status`, which bumped `version` to 2 and therefore the protocol hash. A new version never
 * re-scores outcomes already finalized under an older one; changing any constant again needs another version.
 *
 * No fs, fetch or clock access here: `now` is always passed in.
 */

/** The build switch. While false no outcome store is created or opened (AGENTSTOZ_CORRECTION_OUTCOMES=off turns it off too). */
export const CORRECTION_OUTCOME_PIPELINE_ENABLED: boolean = true;

/**
 * Whether this process runs the pipeline: built enabled and not switched off with AGENTSTOZ_CORRECTION_OUTCOMES=off.
 * The variable can only turn it off — nothing in the environment enables a pipeline the build has off.
 */
export function correctionOutcomePipelineActive(
  env: Readonly<Record<string, string | undefined>>,
  built: boolean = CORRECTION_OUTCOME_PIPELINE_ENABLED,
): boolean {
  return built && env.AGENTSTOZ_CORRECTION_OUTCOMES !== 'off';
}

const HOUR = 3_600_000;

export interface CorrectionOutcomeProtocol {
  version: number;
  /** 'proposed' until the user confirms the constants (confirmed for version 2). */
  status: 'proposed' | 'confirmed';
  /** Observation window after the exposure was written. At least one hour. */
  windowMs: number;
  /** related ⇔ matchedTerms ≥ minMatchedTerms AND evidenceMatchedTerms ≥ minEvidenceTerms. */
  relatedness: {minMatchedTerms: number; minEvidenceTerms: number};
  minFinalizedUnitsForRate: number;
  minDistinctCorrectionsForRate: number;
}

/** Confirmed values (see the module comment). Changing any of them requires a new version. */
export const CORRECTION_OUTCOME_PROTOCOL: Readonly<CorrectionOutcomeProtocol> = Object.freeze({
  version: 2,
  status: 'confirmed' as const,
  windowMs: 72 * HOUR,
  relatedness: Object.freeze({minMatchedTerms: 2, minEvidenceTerms: 1}),
  minFinalizedUnitsForRate: 30,
  minDistinctCorrectionsForRate: 5,
});

/** Which submission paths can carry a correction into a task. Results describe only these. */
export const CORRECTION_OUTCOME_COVERAGE = Object.freeze({
  exposedPaths: Object.freeze(['composer-submission', 'reviewed-voice', '@-route-submission'] as const),
  // Images attached in the composer ride the same submission write and do receive corrections. So does an @ handoff
  // typed into a receiver that takes whole-request submissions (an existing session, or a new one typed once ready);
  // one carried as a new session's first request, or typed in raw parts (an older receiver, the LAN page), does not.
  notExposed: Object.freeze(['mcp-instruction', 'new-session-first-prompt', '@-route-raw', 'legacy-lan'] as const),
});

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function correctionOutcomeProtocolHash(protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL): string {
  if (!Number.isSafeInteger(protocol.windowMs) || protocol.windowMs < HOUR) throw new Error('교정 결과 관찰 기간은 1시간 이상이어야 합니다.');
  for (const n of [protocol.version, protocol.relatedness.minMatchedTerms, protocol.relatedness.minEvidenceTerms,
    protocol.minFinalizedUnitsForRate, protocol.minDistinctCorrectionsForRate]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('교정 결과 프로토콜 값을 확인하세요.');
  }
  return sha256({
    version: protocol.version, status: protocol.status, windowMs: protocol.windowMs,
    relatedness: {minMatchedTerms: protocol.relatedness.minMatchedTerms, minEvidenceTerms: protocol.relatedness.minEvidenceTerms},
    minFinalizedUnitsForRate: protocol.minFinalizedUnitsForRate, minDistinctCorrectionsForRate: protocol.minDistinctCorrectionsForRate,
  });
}

export interface CorrectionRelatednessCounts {queryTerms: number; matchedTerms: number; evidenceMatchedTerms: number}
export type CorrectionExposureState = 'prepared' | 'write_started' | 'written' | 'unknown' | 'rejected';

/** One delivered correction entry inside one written submission. Metadata only — never task or evidence text. */
export interface CorrectionExposureUnit {
  unitId: string;
  memoryId: string;
  entryKey: string;
  contentVersionHash: string;
  /** correctionReportId(eventId) of the reports that were shown. */
  reportIds: string[];
  targetId: string;
  sessionId: string;
  writtenAt: string | null;
  state: CorrectionExposureState;
  sourceWithheld: boolean;
  relatedness: CorrectionRelatednessCounts | null;
  /**
   * Set when the submission's target could not be resolved through the bounded retries, so it could not be shown to be
   * outside OPS/shared roots. The unit is kept only to be counted as excluded, never silently dropped.
   */
  targetUnresolved?: true;
}

export const correctionExposureUnitId = (submissionKey: string, entryKey: string, contentVersionHash: string) =>
  sha256([submissionKey, entryKey, contentVersionHash]);

export type CorrectionObservation =
  | {source: 'human-attestation'; unitId: string; verdict: 'avoided' | 'repeated' | 'unsure'; at: string}
  | {source: 're-correction'; memoryId: string; entryKey: string; contentVersionHash: string; reportId: string; at: string; localOrigin: boolean}
  | {source: 'tester-check'; unitId: string; checkId: string; verdict: 'avoided' | 'repeated'; runId: string; at: string};
export type CorrectionObservationSource = CorrectionObservation['source'];
export const CORRECTION_OBSERVATION_SOURCES: readonly CorrectionObservationSource[] = ['human-attestation', 're-correction', 'tester-check'];

const OBSERVATION_KEYS: Record<CorrectionObservationSource, readonly string[]> = {
  'human-attestation': ['source', 'unitId', 'verdict', 'at'],
  're-correction': ['source', 'memoryId', 'entryKey', 'contentVersionHash', 'reportId', 'at', 'localOrigin'],
  'tester-check': ['source', 'unitId', 'checkId', 'verdict', 'runId', 'at'],
};
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512;

/** Strict: exactly the three sources, exactly their keys. Anything else is not evidence. */
export function parseCorrectionObservation(value: unknown): CorrectionObservation {
  const invalid = () => { throw new Error('교정 결과 관찰 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const keys = OBSERVATION_KEYS[raw.source as CorrectionObservationSource];
  if (!keys) return invalid();
  const actual = Object.keys(raw);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  if (!text(raw.at) || !Number.isFinite(Date.parse(raw.at as string))) return invalid();
  if (raw.source === 'human-attestation') {
    if (!text(raw.unitId) || !['avoided', 'repeated', 'unsure'].includes(raw.verdict as string)) return invalid();
  } else if (raw.source === 're-correction') {
    if (![raw.memoryId, raw.entryKey, raw.contentVersionHash, raw.reportId].every(text) || typeof raw.localOrigin !== 'boolean') return invalid();
  } else if (!text(raw.unitId) || !text(raw.checkId) || !text(raw.runId) || !['avoided', 'repeated'].includes(raw.verdict as string)) return invalid();
  return {...raw} as CorrectionObservation;
}
export const correctionObservationId = (observation: CorrectionObservation) => sha256(observation);

export type CorrectionExclusionReason = 'delivery-uncertain' | 'withheld' | 'pre-protocol' | 'unrelated' | 'target-unresolved';
export type CorrectionOutcomeStatus = 'excluded' | 'pending' | 'avoided' | 'repeated' | 'unknown';
export interface CorrectionClassification {
  status: CorrectionOutcomeStatus;
  reason: CorrectionExclusionReason | 'window-open' | 'conflict' | 'no-independent-evidence' | 'attested-unsure' | 'independent-evidence';
  evidenceRefs: string[];
  sources: CorrectionObservationSource[];
  protocolHash: string;
}
export interface CorrectionOutcome extends CorrectionClassification {unitId: string}

/** null = eligible. Units written before the outcome store was activated are pre-protocol: no retroactive selection. */
export function correctionExposureExclusion(
  unit: CorrectionExposureUnit,
  protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL,
  options: {activatedAt?: string | null} = {},
): CorrectionExclusionReason | null {
  if (unit.state !== 'written') return 'delivery-uncertain';
  if (unit.targetUnresolved) return 'target-unresolved';
  if (unit.sourceWithheld) return 'withheld';
  if (!unit.writtenAt || !Number.isFinite(Date.parse(unit.writtenAt))) return 'pre-protocol';
  if (options.activatedAt && Date.parse(unit.writtenAt) < Date.parse(options.activatedAt)) return 'pre-protocol';
  if (!unit.relatedness) return 'pre-protocol';
  if (unit.relatedness.matchedTerms < protocol.relatedness.minMatchedTerms
    || unit.relatedness.evidenceMatchedTerms < protocol.relatedness.minEvidenceTerms) return 'unrelated';
  return null;
}

/** Whether an observation is about this unit at all (scope, own report, origin, window). */
export function correctionObservationApplies(unit: CorrectionExposureUnit, observation: CorrectionObservation, protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL) {
  if (!unit.writtenAt) return false;
  const start = Date.parse(unit.writtenAt), at = Date.parse(observation.at);
  if (!(at >= start && at <= start + protocol.windowMs)) return false;
  if (observation.source === 're-correction') {
    return observation.localOrigin && observation.memoryId === unit.memoryId && observation.entryKey === unit.entryKey
      && observation.contentVersionHash === unit.contentVersionHash && !unit.reportIds.includes(observation.reportId);
  }
  return observation.unitId === unit.unitId;
}

export function classifyCorrectionOutcome(
  unit: CorrectionExposureUnit,
  observations: readonly unknown[],
  now: number,
  protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL,
  options: {activatedAt?: string | null} = {},
): CorrectionClassification {
  const protocolHash = correctionOutcomeProtocolHash(protocol);
  const excluded = correctionExposureExclusion(unit, protocol, options);
  if (excluded) return {status: 'excluded', reason: excluded, evidenceRefs: [], sources: [], protocolHash};
  const relevant: CorrectionObservation[] = [];
  for (const raw of observations) {
    let observation: CorrectionObservation;
    try { observation = parseCorrectionObservation(raw); } catch { continue; }
    if (correctionObservationApplies(unit, observation, protocol)) relevant.push(observation);
  }
  const verdictOf = (o: CorrectionObservation) => o.source === 're-correction' ? 'repeated' : o.verdict;
  const verdicts = [...new Set(relevant.map(verdictOf))];
  const evidenceRefs = relevant.map(correctionObservationId).sort();
  const sources = [...new Set(relevant.map(o => o.source))].sort() as CorrectionObservationSource[];
  if (verdicts.length > 1) return {status: 'unknown', reason: 'conflict', evidenceRefs, sources, protocolHash};
  if (verdicts.length === 1) {
    if (verdicts[0] === 'unsure') return {status: 'unknown', reason: 'attested-unsure', evidenceRefs, sources, protocolHash};
    return {status: verdicts[0] as 'avoided' | 'repeated', reason: 'independent-evidence', evidenceRefs, sources, protocolHash};
  }
  if (now <= Date.parse(unit.writtenAt!) + protocol.windowMs) return {status: 'pending', reason: 'window-open', evidenceRefs: [], sources: [], protocolHash};
  // Absence of a repeat is never 'avoided'.
  return {status: 'unknown', reason: 'no-independent-evidence', evidenceRefs: [], sources: [], protocolHash};
}

type Finalized = {avoided: number; repeated: number; unknown: number};
type Rate = {repeated: number; denominator: number} | null;
export interface CorrectionOutcomeSummary {
  protocolVersion: number;
  protocolHash: string;
  protocolStatus: CorrectionOutcomeProtocol['status'];
  exposuresObserved: number;
  excluded: Record<CorrectionExclusionReason, number>;
  eligible: number;
  pending: number;
  finalized: Finalized;
  /** Units already finalized under a different protocol version; never re-scored. */
  otherProtocol: number;
  distinctCorrections: number;
  bySource: Record<CorrectionObservationSource, number>;
  conflicts: number;
  /** The first eligible exposure after each correction report — the 'next related task'. */
  primary: {units: number; finalized: Finalized; repeatRate: Rate; repeatRateReason: 'insufficient-sample' | null};
  secondary: {units: number; finalized: Finalized; repeatRate: Rate; repeatRateReason: 'insufficient-sample' | null};
  coverage: typeof CORRECTION_OUTCOME_COVERAGE;
  efficacyVerified: false;
}

export function summarizeCorrectionOutcomes(
  units: readonly CorrectionExposureUnit[],
  outcomes: readonly CorrectionOutcome[],
  now: number,
  protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL,
  options: {activatedAt?: string | null} = {},
): CorrectionOutcomeSummary {
  const protocolHash = correctionOutcomeProtocolHash(protocol);
  const byUnit = new Map<string, CorrectionOutcome[]>();
  for (const outcome of outcomes) byUnit.set(outcome.unitId, [...(byUnit.get(outcome.unitId) ?? []), outcome]);
  const excluded: Record<CorrectionExclusionReason, number> = {'delivery-uncertain': 0, withheld: 0, 'pre-protocol': 0, unrelated: 0, 'target-unresolved': 0};
  const bySource: Record<CorrectionObservationSource, number> = {'human-attestation': 0, 're-correction': 0, 'tester-check': 0};
  const finalized: Finalized = {avoided: 0, repeated: 0, unknown: 0};
  const status = new Map<string, CorrectionOutcomeStatus>();
  const eligibleUnits: CorrectionExposureUnit[] = [];
  let pending = 0, otherProtocol = 0, conflicts = 0;
  for (const unit of units) {
    const stored = byUnit.get(unit.unitId) ?? [];
    const current = stored.find(outcome => outcome.protocolHash === protocolHash);
    if (!current && stored.length) { otherProtocol++; continue; }
    const result = current ?? classifyCorrectionOutcome(unit, [], now, protocol, options);
    if (result.status === 'excluded') { excluded[result.reason as CorrectionExclusionReason]++; continue; }
    eligibleUnits.push(unit);
    // Without a stored (finalized) outcome the unit is still pending, even when its window has closed.
    if (!current) { pending++; status.set(unit.unitId, 'pending'); continue; }
    status.set(unit.unitId, current.status);
    if (current.status === 'avoided' || current.status === 'repeated' || current.status === 'unknown') finalized[current.status]++;
    if (current.reason === 'conflict') conflicts++;
    for (const source of current.sources) bySource[source]++;
  }
  const reports = new Map<string, CorrectionExposureUnit>();
  for (const unit of [...eligibleUnits].sort((a, b) => Date.parse(a.writtenAt!) - Date.parse(b.writtenAt!) || a.unitId.localeCompare(b.unitId))) {
    for (const reportId of unit.reportIds) if (!reports.has(reportId)) reports.set(reportId, unit);
  }
  const primaryUnits = [...new Set(reports.values())];
  const isFinalized = (unit: CorrectionExposureUnit) => {
    const s = status.get(unit.unitId);
    return s === 'avoided' || s === 'repeated' || s === 'unknown';
  };
  const tally = (list: readonly CorrectionExposureUnit[]) => {
    const counts: Finalized = {avoided: 0, repeated: 0, unknown: 0};
    for (const unit of list) { const s = status.get(unit.unitId); if (s === 'avoided' || s === 'repeated' || s === 'unknown') counts[s]++; }
    return counts;
  };
  // The distinct-correction gate counts only the reports carried by units inside the rate's denominator: a pending unit
  // must not lend its report to a rate computed over other, finalized units.
  const rate = (counts: Finalized, distinctCorrections: number) => {
    const denominator = counts.avoided + counts.repeated + counts.unknown;
    const enough = denominator >= protocol.minFinalizedUnitsForRate && distinctCorrections >= protocol.minDistinctCorrectionsForRate;
    return {repeatRate: enough ? {repeated: counts.repeated, denominator} : null, repeatRateReason: enough ? null : 'insufficient-sample' as const};
  };
  const primaryFinalized = tally(primaryUnits);
  const primaryDistinct = [...reports.values()].filter(isFinalized).length;
  const secondaryDistinct = new Set(eligibleUnits.filter(isFinalized).flatMap(unit => unit.reportIds)).size;
  return {
    protocolVersion: protocol.version, protocolHash, protocolStatus: protocol.status,
    exposuresObserved: units.length, excluded, eligible: eligibleUnits.length, pending, finalized, otherProtocol,
    distinctCorrections: reports.size, bySource, conflicts,
    primary: {units: primaryUnits.length, finalized: primaryFinalized, ...rate(primaryFinalized, primaryDistinct)},
    secondary: {units: eligibleUnits.length, finalized: {...finalized}, ...rate(finalized, secondaryDistinct)},
    coverage: CORRECTION_OUTCOME_COVERAGE, efficacyVerified: false,
  };
}

/**
 * The benchmark learning track. Descriptive outcome counts never become PASS: with no finalized outcome it was not run,
 * and with outcomes but no pre-registered baseline/comparison design there is nothing to compare against.
 */
export function evaluateCorrectionLearningTrack(summary: CorrectionOutcomeSummary | null): {status: 'NOT_RUN' | 'BLOCKED'; reason: 'no-outcome-store' | 'no-finalized-outcomes' | 'baseline-missing'} {
  if (!summary) return {status: 'NOT_RUN', reason: 'no-outcome-store'};
  const {avoided, repeated, unknown} = summary.finalized;
  if (avoided + repeated + unknown === 0) return {status: 'NOT_RUN', reason: 'no-finalized-outcomes'};
  return {status: 'BLOCKED', reason: 'baseline-missing'};
}
