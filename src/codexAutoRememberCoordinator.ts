import { memorySaveDispatchRetryable } from './memorySaveDispatcher';
import type { AutoRememberBackup } from './memoryBackupContract';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AutoRememberAttemptStore, type AutoRememberReceipt } from './autoRememberAttemptStore';

import {
  CODEX_AUTO_REMEMBER_SCHEMA_VERSION,
  CODEX_AUTO_REMEMBER_RESET_PERCENT,
  CODEX_AUTO_REMEMBER_THRESHOLDS,
  nextCodexAutoRememberThreshold,
  type CodexAutoRememberObservation,
  type CodexAutoRememberSessionStatus,
  type CodexAutoRememberSettings,
  type CodexAutoRememberStatus,
} from './codexAutoRememberContract';

type CodexAutoRememberReceipt = AutoRememberReceipt;

interface CodexAutoRememberPersistedAttempt {
  turnId: string;
  threshold: number;
  retryAfterAt: string | null;
  terminalForTurn: boolean;
  message: string;
}

interface CodexAutoRememberFile {
  schemaVersion: typeof CODEX_AUTO_REMEMBER_SCHEMA_VERSION;
  settings: CodexAutoRememberSettings;
  receiptEpoch: string;
  receipts: Record<string, CodexAutoRememberReceipt>;
  /**
   * Failed-turn fences survive a sidecar restart. Without this, one hard
   * failure could invoke the memory model again for the exact same completed
   * turn every time the desktop app reopened.
   */
  attempts: Record<string, CodexAutoRememberPersistedAttempt>;
}

export interface CodexAutoRememberProject {
  projectId: string;
  projectName: string;
  projectRoot: string;
  memoryId?: string;
  /** Internal evidence check, invoked by the host inside its save lease. */
  validateRegistration?: () => Promise<boolean>;
}

export type CodexAutoRememberProjectResolver = (observation: CodexAutoRememberObservation) =>
  Promise<CodexAutoRememberProject | null> | CodexAutoRememberProject | null;

export interface CodexAutoRememberMemoryState {
  managedExternally?: boolean;
  exists: boolean;
  needsRemember: boolean;
  autoBackup: boolean;
}

export interface CodexAutoRememberCheckpointResult {
  localSaved: boolean;
  remoteBackedUp: boolean;
  backupError?: string | null;
  backupSkipped?: boolean;
  localWarning?: string;
  backup?: AutoRememberBackup;
}

export interface CodexAutoRememberCoordinatorDependencies {
  stateFile: string;
  listObservations(): Promise<CodexAutoRememberObservation[]> | CodexAutoRememberObservation[];
  resolveProject(observation: CodexAutoRememberObservation): Promise<CodexAutoRememberProject | null> | CodexAutoRememberProject | null;
  /** Lazily prepare one fresh identity snapshot for this tick only. */
  prepareProjectResolver?: () => Promise<CodexAutoRememberProjectResolver>;
  inspectMemory(project: CodexAutoRememberProject): Promise<CodexAutoRememberMemoryState> | CodexAutoRememberMemoryState;
  /** A rejected call is ambiguous unless the host proves the memory operation
   * never began with autoRememberNotStarted=true (or a busy workspace lease). */
  retryBackup?: (backup: AutoRememberBackup) => Promise<'complete' | 'blocked' | 'retry'>;
  checkpoint(input: {
    saveId: string;
    observation: CodexAutoRememberObservation;
    project: CodexAutoRememberProject;
    memory: CodexAutoRememberMemoryState;
    threshold: number;
    isActive(): boolean;
    recordLocalSave(result: CodexAutoRememberCheckpointResult): void;
  }): Promise<CodexAutoRememberCheckpointResult>;
  now?: () => Date;
}

const defaultFile = (): CodexAutoRememberFile => ({
  schemaVersion: CODEX_AUTO_REMEMBER_SCHEMA_VERSION,
  settings: {
    // Automatic model calls and memory writes are opt-in. The user who enables
    // the feature is fenced from historical sessions by enabledAt below.
    enabled: false,
    enabledAt: null,
    thresholds: [...CODEX_AUTO_REMEMBER_THRESHOLDS],
  },
  receiptEpoch: '',
  receipts: {},
  attempts: {},
});

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeFile(value: unknown): CodexAutoRememberFile {
  const fallback = defaultFile();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const settings = record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
    ? record.settings as Record<string, unknown>
    : {};
  const receiptsValue = record.receipts && typeof record.receipts === 'object' && !Array.isArray(record.receipts)
    ? record.receipts as Record<string, unknown>
    : {};
  const attemptsValue = record.attempts && typeof record.attempts === 'object' && !Array.isArray(record.attempts)
    ? record.attempts as Record<string, unknown>
    : {};
  const receipts: Record<string, CodexAutoRememberReceipt> = {};
  for (const [sessionId, raw] of Object.entries(receiptsValue).slice(-256)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)
      || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const receipt = raw as Record<string, unknown>;
    const completedThresholds = Array.isArray(receipt.completedThresholds)
      ? receipt.completedThresholds.filter((entry): entry is number => (
        typeof entry === 'number' && CODEX_AUTO_REMEMBER_THRESHOLDS.includes(entry as any)
      ))
      : [];
    receipts[sessionId] = {
      completedThresholds: [...new Set(completedThresholds)],
      lastCheckpointAt: validIso(receipt.lastCheckpointAt) ? receipt.lastCheckpointAt : null,
      lastCheckpointThreshold: typeof receipt.lastCheckpointThreshold === 'number'
        && CODEX_AUTO_REMEMBER_THRESHOLDS.includes(receipt.lastCheckpointThreshold as any)
        ? receipt.lastCheckpointThreshold
        : null,
      projectId: typeof receipt.projectId === 'string' ? receipt.projectId.slice(0, 128) : null,
      projectName: typeof receipt.projectName === 'string' ? receipt.projectName.slice(0, 120) : null,
      backupWarning: typeof receipt.backupWarning === 'string' ? receipt.backupWarning.slice(0, 500) : null,
    };
  }
  const attempts: Record<string, CodexAutoRememberPersistedAttempt> = {};
  for (const [sessionId, raw] of Object.entries(attemptsValue).slice(-256)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)
      || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const attempt = raw as Record<string, unknown>;
    if (typeof attempt.turnId !== 'string' || attempt.turnId.length < 1 || attempt.turnId.length > 128
      || typeof attempt.threshold !== 'number'
      || !CODEX_AUTO_REMEMBER_THRESHOLDS.includes(attempt.threshold as any)
      || typeof attempt.terminalForTurn !== 'boolean'
      || typeof attempt.message !== 'string' || attempt.message.length < 1
      || (attempt.retryAfterAt !== null && !validIso(attempt.retryAfterAt))) continue;
    attempts[sessionId] = {
      turnId: attempt.turnId,
      threshold: attempt.threshold,
      retryAfterAt: attempt.retryAfterAt,
      terminalForTurn: attempt.terminalForTurn,
      message: attempt.message.slice(0, 500),
    };
  }
  return {
    schemaVersion: CODEX_AUTO_REMEMBER_SCHEMA_VERSION,
    settings: {
      enabled: settings.enabled === true,
      enabledAt: validIso(settings.enabledAt) ? settings.enabledAt : null,
      // V1 has one audited policy. Do not trust arbitrary on-disk thresholds.
      thresholds: [...CODEX_AUTO_REMEMBER_THRESHOLDS],
    },
    receiptEpoch: typeof record.receiptEpoch === 'string' && record.receiptEpoch.length <= 128
      ? record.receiptEpoch : (validIso(settings.enabledAt) ? settings.enabledAt : ''),
    receipts,
    attempts,
  };
}

function loadFile(path: string): CodexAutoRememberFile {
  if (!existsSync(path)) return defaultFile();
  try {
    return normalizeFile(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return defaultFile();
  }
}

function saveFile(path: string, value: CodexAutoRememberFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let installed = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    installed = true;
  } finally {
    if (!installed && existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
    }
  }
  try { chmodSync(path, 0o600); } catch { /* Windows has no POSIX mode guarantee. */ }
}

function statusMessage(phase: CodexAutoRememberSessionStatus['phase'], threshold: number | null): string {
  if (phase === 'waiting-for-turn') return `${threshold ?? 50}% 체크포인트를 현재 턴 종료 뒤 실행합니다.`;
  if (phase === 'waiting-for-project') return '등록 프로젝트·워크트리와 정확히 연결되지 않아 자동 저장하지 않습니다.';
  if (phase === 'waiting-for-changes') return '파일 변경 기준으로 정리할 내용이 없어 대기합니다. 대화 내용까지 저장됐다는 뜻은 아닙니다.';
  if (phase === 'saving') return `${threshold ?? 50}% 프로젝트 기억 체크포인트를 저장하고 있습니다.`;
  if (phase === 'saved') return '프로젝트 기억 체크포인트를 로컬에 안전하게 저장했습니다.';
  if (phase === 'retrying') return '작업공간 사용이 끝나면 프로젝트 기억 체크포인트를 다시 시도합니다.';
  if (phase === 'recovery-required') return '이전 자동 저장의 완료 여부를 확인해야 합니다. 중복 실행을 막기 위해 자동 재시도를 중단했습니다.';
  if (phase === 'failed') return '프로젝트 기억 체크포인트에 실패했습니다. 다음 완료 턴에서 다시 확인합니다.';
  return threshold === null ? '다음 컨텍스트 체크포인트를 관찰하고 있습니다.' : `${threshold}% 체크포인트를 관찰하고 있습니다.`;
}

export class CodexAutoRememberCoordinator {
  readonly #dependencies: CodexAutoRememberCoordinatorDependencies;
  #file: CodexAutoRememberFile;
  #runtime = new Map<string, CodexAutoRememberSessionStatus>();
  #attempts: AutoRememberAttemptStore;
  #tickPromise: Promise<void> | null = null;
  #backupPromise: Promise<void> | null = null;
  #policyEpoch = 0;
  #lastAttemptedSessionId: string | null = null;

  constructor(dependencies: CodexAutoRememberCoordinatorDependencies) {
    this.#dependencies = dependencies;
    this.#file = loadFile(dependencies.stateFile);
    this.#attempts = new AutoRememberAttemptStore(`${dependencies.stateFile}.attempts.sqlite`, this.#file.attempts,
      this.#file.receipts, this.#file.receiptEpoch);
    // Keep legacy JSON until the indexed store has actually committed it.
    // Initialization is lazy so a disabled feature cannot block API startup.
  }

  settings(): CodexAutoRememberSettings {
    return { ...this.#file.settings, thresholds: [...this.#file.settings.thresholds] };
  }

  setEnabled(enabled: boolean): CodexAutoRememberSettings {
    if (this.#file.settings.enabled === enabled) return this.settings();
    this.#policyEpoch += 1;
    this.#file.settings.enabled = enabled;
    this.#file.settings.enabledAt = enabled ? this.#now().toISOString() : null;
    this.#runtime.clear();
    this.#lastAttemptedSessionId = null;
    this.#attempts.clear();
    this.#file.attempts = {};
    if (enabled) {
      // A fresh opt-in is a new policy epoch. enabledAt still prevents old
      // completed turns from being swept, while prior receipts cannot suppress
      // new project work after a user deliberately re-enables the feature.
      this.#file.receipts = {};
      this.#file.receiptEpoch = randomUUID();
    }
    saveFile(this.#dependencies.stateFile, this.#file);
    return this.settings();
  }

  status(): CodexAutoRememberStatus {
    return {
      schemaVersion: CODEX_AUTO_REMEMBER_SCHEMA_VERSION,
      settings: this.settings(),
      running: this.#tickPromise !== null,
      backups: this.#dependencies.retryBackup ? this.#attempts.backupStatus() : undefined,
      sessions: [...this.#runtime.values()]
        .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
        .slice(0, 24)
        .map(session => ({ ...session })),
    };
  }

  tick(): Promise<void> {
    if (this.#tickPromise) return this.#tickPromise;
    if (this.#dependencies.retryBackup && !this.#backupPromise) {
      this.#backupPromise = this.#runBackupTick().catch(error => {
        console.error('[CodexAutoRemember] backup queue failed:', error instanceof Error ? error.message : String(error));
      }).finally(() => { this.#backupPromise = null; });
    }
    const running = this.#runTick().catch(error => {
      console.error('[CodexAutoRemember] checkpoint poll failed:', error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (this.#tickPromise === running) this.#tickPromise = null;
    });
    this.#tickPromise = running;
    return running;
  }

  #now(): Date {
    return this.#dependencies.now?.() ?? new Date();
  }

  #receipt(sessionId: string): CodexAutoRememberReceipt {
    const receipt = this.#attempts.receipt(sessionId, this.#file.receiptEpoch);
    this.#file.receipts = {};
    return receipt ?? {
      completedThresholds: [],
      lastCheckpointAt: null,
      lastCheckpointThreshold: null,
      projectId: null,
      projectName: null,
      backupWarning: null,
    };
  }

  completeRecoveredSave(id: string, root: string, memoryId: string, result: { backup?: AutoRememberBackup; backupWarning: string|null }): void {
    this.#attempts.completeRecovered(id,root,memoryId,result);
  }

  #setRuntime(
    observation: CodexAutoRememberObservation,
    phase: CodexAutoRememberSessionStatus['phase'],
    threshold: number | null,
    project?: CodexAutoRememberProject | null,
    overrides?: Partial<CodexAutoRememberSessionStatus>,
  ): void {
    const receipt = this.#receipt(observation.sessionId);
    this.#runtime.set(observation.sessionId, {
      sessionId: observation.sessionId,
      usedPercent: observation.usedPercent,
      observedAt: observation.capturedAt,
      nextThreshold: threshold,
      phase,
      projectId: project?.projectId ?? receipt.projectId,
      projectName: project?.projectName ?? receipt.projectName,
      lastCheckpointAt: receipt.lastCheckpointAt,
      lastCheckpointThreshold: receipt.lastCheckpointThreshold,
      backupWarning: receipt.backupWarning,
      message: statusMessage(phase, threshold),
      ...overrides,
    });
  }

  async #runBackupTick(): Promise<void> {
    const retry = this.#dependencies.retryBackup;
    if (!retry || !existsSync(`${this.#dependencies.stateFile}.attempts.sqlite`)) return;
    const job = this.#attempts.claimBackup(this.#now().getTime());
    if (!job) return;
    let state: 'complete' | 'blocked' | 'retry';
    try { state = await retry(job.backup); }
    catch (error: any) {
      if (error?.code === 'WORKSPACE_LEASE_BUSY' || memorySaveDispatchRetryable(error)) {
        this.#attempts.deferBusyBackup(job.id, job.attempt, this.#now().getTime());
        return;
      }
      state = error?.code === 'BACKUP_GUARD_CHANGED' ? 'blocked' : 'retry';
    }
    if (state !== 'retry') this.#attempts.finishBackup(job.id, state);
    else if (job.attempt >= 8) this.#attempts.finishBackup(job.id, 'blocked');
  }

  async #runTick(): Promise<void> {
    if (existsSync(`${this.#dependencies.stateFile}.attempts.sqlite`)) this.#attempts.recoverOutcomes();
    if (!this.#file.settings.enabled || !this.#file.settings.enabledAt) return;
    const receiptEpoch = this.#file.receiptEpoch;
    const enabledAt = Date.parse(this.#file.settings.enabledAt);
    const policyEpoch = this.#policyEpoch;
    const observations = (await this.#dependencies.listObservations())
      .filter(observation => Number.isFinite(observation.usedPercent))
      .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))
      .slice(0, 48);

    // One model call per tick, with a rotating cursor so a busy project cannot
    // consume every tick's only slot. Retain only one session ID, not history.
    const previousIndex = observations.findIndex(row => row.sessionId === this.#lastAttemptedSessionId);
    if (previousIndex >= 0) observations.push(...observations.splice(0, previousIndex + 1));
    let checkpointAttempted = false;
    let resolveProject: CodexAutoRememberProjectResolver | undefined;
    const inspected = new Map<string, CodexAutoRememberMemoryState>();
    const stillEnabled = () => this.#file.settings.enabled
      && this.#policyEpoch === policyEpoch;
    if (!stillEnabled()) return;
    for (const observation of observations) {
      if (this.#attempts.hasIntent(observation.sessionId)) {
        this.#setRuntime(observation, 'recovery-required', null);
        continue;
      }
      let receipt = this.#receipt(observation.sessionId);
      if (observation.usedPercent <= CODEX_AUTO_REMEMBER_RESET_PERCENT
        && receipt.completedThresholds.length > 0) {
        receipt = { ...receipt, completedThresholds: [] };
        this.#attempts.setReceipt(observation.sessionId, receiptEpoch, receipt);
        saveFile(this.#dependencies.stateFile, this.#file);
      }
      const threshold = nextCodexAutoRememberThreshold(
        observation.usedPercent,
        receipt.completedThresholds,
        this.#file.settings.thresholds,
      );
      if (threshold === null) {
        this.#setRuntime(observation, receipt.lastCheckpointAt ? 'saved' : 'observing', null);
        continue;
      }
      const completedAt = observation.turnCompletedAt ? Date.parse(observation.turnCompletedAt) : Number.NaN;
      if (observation.turnState !== 'complete' || !observation.turnId || !Number.isFinite(completedAt)) {
        this.#setRuntime(observation, 'waiting-for-turn', threshold);
        continue;
      }
      // Enabling the policy must not sweep every historical 50%+ rollout. The
      // first eligible evidence is a task_complete written after explicit opt-in.
      if (completedAt < enabledAt) {
        this.#setRuntime(observation, 'observing', threshold, null, {
          message: '자동 체크포인트를 켠 뒤 완료되는 다음 턴부터 적용됩니다.',
        });
        continue;
      }
      const priorAttempt = this.#attempts.get(observation.sessionId);
      this.#file.attempts = {};
      if (priorAttempt
        && priorAttempt.turnId === observation.turnId
        && priorAttempt.threshold === threshold) {
        if (priorAttempt.terminalForTurn) {
          this.#setRuntime(observation, 'failed', threshold, null, { message: priorAttempt.message });
          continue;
        }
        if (this.#now().getTime() < Date.parse(priorAttempt.retryAfterAt ?? '')) {
          this.#setRuntime(observation, 'retrying', threshold, null, { message: priorAttempt.message });
          continue;
        }
      } else if (priorAttempt) {
        this.#attempts.delete(observation.sessionId);
        saveFile(this.#dependencies.stateFile, this.#file);
      }
      if (checkpointAttempted) {
        this.#setRuntime(observation, 'retrying', threshold, null, {
          message: '다른 세션의 체크포인트를 처리 중입니다. 다음 순서에 확인합니다.',
        });
        continue;
      }

      let project: CodexAutoRememberProject | null = null;
      let intentId: string | null = null;
      let providerReturned = false;
      let checkpointDispatched = false;
      try {
        resolveProject ??= this.#dependencies.prepareProjectResolver
          ? await this.#dependencies.prepareProjectResolver()
          : this.#dependencies.resolveProject.bind(this.#dependencies);
        if (!stillEnabled()) return;
        project = await resolveProject(observation);
        if (!stillEnabled()) return;
        if (!project) {
          this.#setRuntime(observation, 'waiting-for-project', threshold);
          continue;
        }
        const inspectionKey = JSON.stringify([project.projectId, project.projectRoot, project.memoryId]);
        let memory = inspected.get(inspectionKey);
        if (!memory) {
          memory = await this.#dependencies.inspectMemory(project);
          inspected.set(inspectionKey, memory);
        }
        if (!stillEnabled()) return;
        if (!memory.exists) {
          this.#setRuntime(observation, 'waiting-for-project', threshold, project, {
            message: '등록 프로젝트에 장기기억이 초기화되지 않아 자동 저장하지 않습니다.',
          });
          continue;
        }
        if (memory.managedExternally) {
          this.#setRuntime(observation, 'observing', threshold, project, {message:'이 프로젝트는 V2 자동 기억 정리가 담당합니다. 기존 체크포인트는 대기합니다.'});
          continue;
        }
        if (!memory.needsRemember) {
          this.#setRuntime(observation, 'waiting-for-changes', threshold, project);
          continue;
        }

        const candidateIntentId = randomUUID();
        if (!this.#attempts.begin(observation.sessionId, candidateIntentId, receiptEpoch, receipt)) {
          this.#setRuntime(observation, 'retrying', threshold, project);
          continue;
        }
        intentId = candidateIntentId;
        checkpointAttempted = true;
        this.#lastAttemptedSessionId = observation.sessionId;
        this.#setRuntime(observation, 'saving', threshold, project);
        checkpointDispatched = true;
        const checkpointProject = project;
        const makeReceipt = (result: CodexAutoRememberCheckpointResult): CodexAutoRememberReceipt => ({
          completedThresholds: [...new Set([...receipt.completedThresholds,
            ...this.#file.settings.thresholds.filter(candidate => observation.usedPercent >= candidate)])].sort((a, b) => a - b),
          lastCheckpointAt: this.#now().toISOString(),
          lastCheckpointThreshold: threshold,
          projectId: checkpointProject.projectId,
          projectName: checkpointProject.projectName,
          backupWarning: [result.localWarning, result.remoteBackedUp || result.backupSkipped ? null
            : (result.backupError?.trim() || 'Supabase 백업 대기 중입니다.')].filter(Boolean).join('; ').slice(0, 500) || null,
          localWarning: result.localWarning?.slice(0, 500),
          saveId: candidateIntentId,
        });
        if (project.memoryId) this.#attempts.prepareCompletion({ id: candidateIntentId, sessionId: observation.sessionId,
          epoch: receiptEpoch, root: project.projectRoot, memoryId: project.memoryId,
          receipt: makeReceipt({ localSaved: false, remoteBackedUp: false }) });
        let durableReceipt: CodexAutoRememberReceipt | null = null;
        const result = await this.#dependencies.checkpoint({ saveId: candidateIntentId, observation, project, memory, threshold, isActive: stillEnabled,
          recordLocalSave: result => {
            if (!result.localSaved || durableReceipt) throw new Error('로컬 저장 증거가 올바르지 않습니다.');
            const prepared = makeReceipt(result);
            this.#attempts.recordOutcome(observation.sessionId, candidateIntentId, receiptEpoch, prepared, result.backup);
            durableReceipt = prepared;
          },
        });
        providerReturned = true;
        if (!result.localSaved) throw new Error('프로젝트 기억 체크포인트의 로컬 저장을 확인하지 못했습니다.');
        const nextReceipt: CodexAutoRememberReceipt = durableReceipt ?? makeReceipt(result);
        const checkpointAt = nextReceipt.lastCheckpointAt!;
        // The receipt and removal of the in-flight fence commit together. If
        // this fails after local files changed, retain the intent for recovery.
        this.#attempts.finish(observation.sessionId, intentId, receiptEpoch, nextReceipt);
        intentId = null;
        if (!stillEnabled()) return;
        this.#setRuntime(observation, 'saved', nextCodexAutoRememberThreshold(
          observation.usedPercent,
          nextReceipt.completedThresholds,
          this.#file.settings.thresholds,
        ), project, {
          lastCheckpointAt: checkpointAt,
          lastCheckpointThreshold: threshold,
          backupWarning: nextReceipt.backupWarning,
          message: nextReceipt.backupWarning
            ? `로컬 체크포인트 완료 · ${nextReceipt.backupWarning}`
            : result.backupSkipped ? '로컬 체크포인트 완료 · 자동 백업 꺼짐'
            : '프로젝트 기억 체크포인트와 Supabase 백업을 완료했습니다.',
        });
      } catch (error: any) {
        const provenNotStarted = error?.autoRememberNotStarted === true || (error?.code === 'WORKSPACE_LEASE_BUSY' || memorySaveDispatchRetryable(error));
        if (intentId && (providerReturned || (checkpointDispatched && !provenNotStarted))) {
          if (stillEnabled()) this.#setRuntime(observation, 'recovery-required', threshold, project);
          continue;
        }
        if (!stillEnabled()) return;
        const retryable = error?.code === 'WORKSPACE_LEASE_BUSY' || memorySaveDispatchRetryable(error);
        const message = (retryable
          ? '현재 작업공간이나 기억 저장 대기열을 사용 중입니다. 다음 확인에서 다시 시도합니다.'
          : `프로젝트 기억 체크포인트 실패: ${error?.message ?? String(error)}`).slice(0, 500);
        this.#attempts.fail(observation.sessionId, intentId, {
          turnId: observation.turnId,
          threshold,
          retryAfterAt: retryable ? new Date(this.#now().getTime() + 30_000).toISOString() : null,
          terminalForTurn: !retryable,
          message,
        });
        saveFile(this.#dependencies.stateFile, this.#file);
        this.#setRuntime(observation, retryable ? 'retrying' : 'failed', threshold, project, {
          message,
        });
      }
    }
    const visible = new Set(observations.map(observation => observation.sessionId));
    for (const sessionId of this.#runtime.keys()) {
      if (!visible.has(sessionId)) this.#runtime.delete(sessionId);
    }
  }
}
