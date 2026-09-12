import { createHash } from 'node:crypto';

export const MEMORY_SAVE_PAGE_LIMIT = 128;
export const MEMORY_SAVE_SCHEMA_VERSION = 10;
export type {MemorySaveFailure} from './memorySaveFailure';
export type MemorySavePhase = 'prepared' | 'summarizing' | 'recovery-required' | 'local-saved' | 'superseded-unknown';
/** Metadata supplied only after the host adapter verifies registration, cwd and completion.
 * Byte ranges are half-open, immutable record-aligned fragments; no body or path is stored.
 * A fragment receipt does not mean that its entire turn/session has been saved. */
export interface MemorySaveSource {
  agent: 'codex' | 'claude' | 'hermes' | 'agy';
  instanceId: string;
  sessionId: string;
  turnId: string;
  startByte: number;
  endByte: number;
  sourceDigest: string;
  memoryId: string;
  policyEpoch: number;
  completedAt: number;
  coverageKind?: 'fragment' | 'complete-turn';
}
export interface MemorySaveJob {
  sequence: number;
  saveId: string;
  memoryId: string;
  policyEpoch: number;
  coverageDigest: string;
  phase: MemorySavePhase;
  attemptId: string | null;
}
export interface MemorySaveCommitReceipt {
  manifestDigest: string;
  beforeHash: string;
  afterHash: string;
  localRevisionId: string;
}
export interface MemorySaveAttemptIntent {
  inputDigest: string;
  beforeHash: string;
  providerBindingDigest: string;
}
/** Host-only review metadata. No paths, prompts, provider replies or keys. The
 * separate UI consent must name this exact short-lived review before admission. */
export interface MemorySaveRecoveryBinding extends MemorySaveAttemptIntent {
  parentSaveId:string;parentAttemptId:string;memoryId:string;policyEpoch:number;
  coverageDigest:string;originalIntentDigest:string;policyRevision:number;
  targetId:string;rootDigest:string;registrationDigest:string;
  /** All three fields are present only for a separately verified CLI transition.
   * providerBindingDigest remains the successor's execution binding. */
  transitionId?:string;proofDigest?:string;originalProviderBindingDigest?:string;
}
export interface MemorySaveRecoveryApproval {
  version:1;approvalId:string;reviewDigest:string;reviewedAt:number;expiresAt:number;
  binding:MemorySaveRecoveryBinding;
}
export interface MemorySaveRecoveryCandidate {
  job:MemorySaveJob;intent:MemorySaveAttemptIntent;
  sources:{sourceKey:string;source:MemorySaveSource}[];
}
export interface MemorySaveRecoveryDecision {
  version:1;reason:'response-unconfirmed';approvalId:string;reviewDigest:string;
  parentSaveId:string;parentAttemptId:string;successorSaveId:string;successorAttemptId:string;
  coverageOwnerSaveId:string;consumedAt:number;binding:MemorySaveRecoveryBinding;
}
export interface MemorySaveRecoveryAdmission {
  approvalId:string;reviewDigest:string;explicitConsent:true;
  /** Recomputed by the host under its dispatcher/workspace/app-data leases. */
  binding:MemorySaveRecoveryBinding;
}
export const MEMORY_SAVE_RECOVERY_REVIEW_TTL=5*60*1000;
export function canonicalMemorySaveRecoveryBinding(raw:MemorySaveRecoveryBinding):MemorySaveRecoveryBinding {
  if(!raw||![raw.parentSaveId,raw.parentAttemptId,raw.memoryId,raw.targetId].every(saveToken)
    ||![raw.policyEpoch,raw.policyRevision].every(saveInteger)
    ||![raw.coverageDigest,raw.originalIntentDigest,raw.inputDigest,raw.beforeHash,raw.providerBindingDigest,raw.rootDigest,raw.registrationDigest].every(saveHash))throw new MemorySaveError('INVALID_INPUT');
  const transition=raw.transitionId!==undefined||raw.proofDigest!==undefined||raw.originalProviderBindingDigest!==undefined;
  if(transition&&(!saveToken(raw.transitionId)||!saveHash(raw.proofDigest)||!saveHash(raw.originalProviderBindingDigest)))throw new MemorySaveError('INVALID_INPUT');
  return {parentSaveId:raw.parentSaveId,parentAttemptId:raw.parentAttemptId,memoryId:raw.memoryId,policyEpoch:raw.policyEpoch,
    coverageDigest:raw.coverageDigest,originalIntentDigest:raw.originalIntentDigest,inputDigest:raw.inputDigest,beforeHash:raw.beforeHash,
    providerBindingDigest:raw.providerBindingDigest,policyRevision:raw.policyRevision,targetId:raw.targetId,rootDigest:raw.rootDigest,registrationDigest:raw.registrationDigest,
    ...(transition?{transitionId:raw.transitionId!,proofDigest:raw.proofDigest!,originalProviderBindingDigest:raw.originalProviderBindingDigest!}:{})};
}
export class MemorySaveError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'SOURCE_CONFLICT' | 'COVERAGE_RESERVED' | 'REVISION_CONFLICT' | 'RECOVERY_REQUIRED' | 'STORAGE_UNAVAILABLE' | 'UNSUPPORTED_VERSION' | 'POLICY_DISABLED' | 'POLICY_CHANGED' | 'CLOCK_ROLLBACK' | 'AUTOMATIC_ONLY' | 'EXECUTION_BUSY' | 'SOURCES_INELIGIBLE' | 'BUDGET_PAUSED') {
    super(`Memory save: ${code}`);
  }
}
export function saveDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function saveToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
}
export function saveHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function saveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function canonicalSaveSource(raw: MemorySaveSource): MemorySaveSource {
  if (!raw || !['codex','claude','hermes','agy'].includes(raw.agent)
    || ![raw.instanceId,raw.sessionId,raw.turnId,raw.memoryId].every(saveToken)
    || ![raw.startByte,raw.endByte,raw.policyEpoch,raw.completedAt].every(saveInteger)
    || raw.endByte <= raw.startByte || !saveHash(raw.sourceDigest)
    || (raw.coverageKind !== undefined && !['fragment','complete-turn'].includes(raw.coverageKind))) throw new MemorySaveError('INVALID_INPUT');
  // Explicit projection: extra properties, transcripts and caller paths never enter SQLite.
  return {agent:raw.agent,instanceId:raw.instanceId,sessionId:raw.sessionId,turnId:raw.turnId,
    startByte:raw.startByte,endByte:raw.endByte,sourceDigest:raw.sourceDigest,memoryId:raw.memoryId,
    policyEpoch:raw.policyEpoch,completedAt:raw.completedAt,coverageKind:raw.coverageKind ?? 'fragment'};
}
export function memorySaveSourceKey(source: MemorySaveSource): string {
  return saveDigest([source.agent,source.instanceId,source.sessionId,source.turnId,source.startByte,source.endByte]);
}

/** Immutable host-plan binding; no document body or filesystem path is stored here. */
export interface MemorySaveHostBinding {sessionPlanId:string;planDigest:string;rootDigest:string;beforeHash:string;afterHash:string;backupRequested:boolean;
 backup?:{memoryId:string;contentHash:string;destinationHash:string;parentRevisionId:string|null}}
