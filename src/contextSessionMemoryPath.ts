import type { ContextSurfacePresence } from './contextSessionPresence';
import type { ContextSessionProjectHint } from './contextSessionMetadata';
import type { ProjectCodexVoiceBindingState } from './projectCodexVoice';

/**
 * One row of `/api/context-usage` and the folder whose project memory it may touch.
 *
 * Kept apart from AiUsagePanel (lazy, it pulls in the project-memory client) so the always-loaded
 * 「아젠투지 호출」 dock can find unsaved sessions with the same rules.
 */
export interface ContextSession {
  sessionId: string;
  sourceAgent: 'claude' | 'codex';
  cwd: string | null;
  /** Original cwd from the session record, retained so a completed move can
   * be explained without treating its old scratch directory as a project. */
  initialCwd?: string | null;
  projectDir?: string | null;
  threadSource?: string | null;
  threadTitle?: string | null;
  projectHint?: ContextSessionProjectHint | null;
  modelId: string | null;
  modelName: string | null;
  windowSize: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  usedTokens: number | null;
  costUsd: number | null;
  ageMs: number;
  state: 'active' | 'idle' | 'stale';
  clientLabel: string;
  surfaceKind: string;
  surfaceLabel: string;
  surfaceDetail: string | null;
  /** Runtime presence for integrations such as Orca and cmux.  Snapshot
   * freshness is intentionally a separate field (`state`). */
  surfacePresence?: ContextSurfacePresence | null;
  /** Project binding for a ChatGPT Desktop `realtime_voice` rollout. This is
   * independent of whether the Voice rollout emitted a token-count event. */
  voiceBindingState?: ProjectCodexVoiceBindingState;
  navigation?: {
    available: boolean;
    kind: string | null;
    exact: boolean;
    actionLabel: string | null;
    detail: string;
  };
}

/** A Voice row may show a remembered project assignment before it is safe to
 * use that project's durable memory. Only an applied assignment with either a
 * confirmed project execution or no turn yet is allowed to reach the memory
 * API. This fails closed when an older sidecar cannot supply binding state. */
export const voiceProjectMemoryIsBlocked = (session: ContextSession): boolean => (
  session.sourceAgent === 'codex'
  && session.threadSource === 'realtime_voice'
  && !!session.projectHint
  && session.voiceBindingState !== 'execution-confirmed'
  && session.voiceBindingState !== 'assigned-awaiting-execution'
);

/** The currently assigned project can differ from the rollout cwd while the
 * ChatGPT desktop client applies a project move. */
export const contextSessionProjectPath = (session: ContextSession): string | null => (
  session.projectHint?.path ?? session.projectDir ?? session.cwd
);

/** Voice project moves must fail closed: a scratch/subfolder can resolve back
 * to a main worktree's memory root, so do not even probe memory until the
 * Voice binding is verified. Non-Voice relocation keeps its existing cwd
 * behavior. */
export const contextSessionMemoryPath = (session: ContextSession): string | null => (
  voiceProjectMemoryIsBlocked(session)
    ? null
    : session.projectHint?.moveState === 'pending'
    || session.voiceBindingState === 'move-pending'
    || session.voiceBindingState === 'scope-conflict'
      ? session.cwd
      : contextSessionProjectPath(session)
);
