import type { MemoryBackupStatus } from './memoryBackupContract';
export const CODEX_AUTO_REMEMBER_SCHEMA_VERSION = 1;

/**
 * A long-running session can continue after its first memory checkpoint.  The
 * first save happens around the user's requested halfway point, while the two
 * later checkpoints keep a session that approaches compaction from having one
 * increasingly stale durable summary.
 */
export const CODEX_AUTO_REMEMBER_THRESHOLDS = Object.freeze([50, 75, 90] as const);
/** A completed session that falls this far has compacted or changed windows;
 * later growth is a new checkpoint cycle rather than a duplicate 50% event. */
export const CODEX_AUTO_REMEMBER_RESET_PERCENT = 35;

export type CodexAutoRememberTurnState = 'running' | 'complete' | 'unknown';

export interface CodexAutoRememberObservation {
  sourceAgent?: 'codex' | 'claude';
  sessionId: string;
  cwd: string;
  usedPercent: number;
  capturedAt: string;
  turnState: CodexAutoRememberTurnState;
  turnId: string | null;
  turnCompletedAt: string | null;
}

export interface CodexAutoRememberSettings {
  enabled: boolean;
  enabledAt: string | null;
  thresholds: number[];
}

export type CodexAutoRememberSessionPhase =
  | 'observing'
  | 'waiting-for-turn'
  | 'waiting-for-project'
  | 'waiting-for-changes'
  | 'saving'
  | 'saved'
  | 'retrying'
  | 'failed'
  | 'recovery-required';

export interface CodexAutoRememberSessionStatus {
  sessionId: string;
  usedPercent: number;
  observedAt: string;
  nextThreshold: number | null;
  phase: CodexAutoRememberSessionPhase;
  projectId: string | null;
  projectName: string | null;
  lastCheckpointAt: string | null;
  lastCheckpointThreshold: number | null;
  backupWarning: string | null;
  message: string;
}

export interface CodexAutoRememberStatus {
  schemaVersion: typeof CODEX_AUTO_REMEMBER_SCHEMA_VERSION;
  settings: CodexAutoRememberSettings;
  running: boolean;
  backups?: MemoryBackupStatus[];
  sessions: CodexAutoRememberSessionStatus[];
}

export function nextCodexAutoRememberThreshold(
  usedPercent: number,
  completedThresholds: readonly number[],
  thresholds: readonly number[] = CODEX_AUTO_REMEMBER_THRESHOLDS,
): number | null {
  const completed = new Set(completedThresholds);
  // If the app was asleep while usage moved from 49% to 91%, one checkpoint
  // satisfies every crossed fence. Choosing the highest due level prevents
  // three consecutive model calls for the same completed turn.
  return [...thresholds]
    .filter(threshold => usedPercent >= threshold && !completed.has(threshold))
    .sort((left, right) => right - left)[0] ?? null;
}
