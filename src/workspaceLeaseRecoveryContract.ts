/** Browser-safe shapes shared by the workspace-lease recovery API and its dialog. */

export interface OrphanedWorkspaceLease {
  /** Lock file name without `.lock`: the opaque SHA-256 workspace identity. */
  key: string;
  /** PID recorded by the owner that died while holding this lock. */
  pid: number;
  /** Last heartbeat (the lock file's mtime), ISO-8601. */
  lockedAt: string;
  kind: 'directory' | 'git-family' | 'unknown';
  /** Registered folder this lock guards, or null when no registered folder maps to it. */
  workspacePath: string | null;
}

export type WorkspaceLeaseRecoveryOutcome =
  | 'recovered'
  | 'missing'
  | 'owner-changed'
  | 'owner-alive'
  | 'not-manual'
  | 'invalid';

export interface WorkspaceLeaseRecoveryResult {
  key: string;
  outcome: WorkspaceLeaseRecoveryOutcome;
}
