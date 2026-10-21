import type { AiTerminalSummary } from './aiTerminalProtocol';
import type { AiTerminalResume } from './aiTerminalResume';

/** Host-only facts. Never accepted from a wire request or returned to a client. */
export interface WorkroomSessionContext {
  summary: AiTerminalSummary;
  cwd: string;
  providerHome: string;
  accountFingerprint: string;
  targetFingerprint: string;
  providerConversationId?: string;
  processGroup?: number;
  exitedAt?: string;
  restricted: boolean;
  /** Started with the approval bypass (kept as a session fact; a resume always comes back without it). */
  bypass?: boolean;
  /** The CLI has had a first request or any input, so a liveness tick may look for its saved conversation (only a
   *  running Codex's thread lock binds it — a keystroke alone never claims a rollout). Recorded as a session fact too. */
  submitted?: boolean;
}
export interface WorkroomHistoryLaunch {
  logicalConversationId: string;
  resume: AiTerminalResume;
  accountId: string;
  cwd: string;
  validate(context: WorkroomSessionContext): void | Promise<void>;
  launching(): void;
}
export interface WorkroomHistoryObserver {
  started(context: WorkroomSessionContext, logicalConversationId?: string, previousSessionId?: string): void;
  ended(context: WorkroomSessionContext): Promise<void>;
  /** The session got its first input (w14): kept so a crash cannot make a never-used Codex row claim a rollout. */
  input?(sessionId: string): void;
}
