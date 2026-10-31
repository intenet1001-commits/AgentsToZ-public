import {CodexFirstConversationLaunchCoordinator, type CodexFirstConversationRecoveryStatus} from './codexFirstConversationLaunch';
import type {ProjectCodexLaunchResult} from './projectLaunchPolicy';

export class ProjectCodexLaunchError extends Error {
  readonly code = 'CODEX_PROJECT_CONNECTION_UNAVAILABLE';
  constructor() { super('이 프로젝트의 Codex 연결을 확인하지 못했습니다. 새 대화를 만들지 않았습니다. Codex 앱을 연 뒤 다시 확인하세요.'); }
}

export interface ProjectCodexLaunchDependencies {
  coordinator: CodexFirstConversationLaunchCoordinator;
  latest(): {state: 'found'; sessionId: string} | {state: 'none' | 'unavailable'};
  verify(threadId: string): Promise<CodexFirstConversationRecoveryStatus> | CodexFirstConversationRecoveryStatus;
  create(retain: (threadId: string) => void): Promise<{threadId: string}>;
  finalize(threadId: string): Promise<void>;
  open(threadId: string): void | Promise<void>;
}

/** The desktop primary action continues an existing conversation; the explicit
 * mobile new-chat action creates another one after the same availability and
 * recovery checks. Both intents share a project-scoped in-flight fence. */
export async function openProjectCodexWorkspace(
  projectKey: string,
  deps: ProjectCodexLaunchDependencies,
  options: {intent?: 'prepare-or-reopen' | 'new'; onConfirmed?: (threadId: string) => Promise<void>} = {},
): Promise<ProjectCodexLaunchResult> {
  const latest = deps.latest();
  if (latest.state === 'unavailable') throw new ProjectCodexLaunchError();
  if (options.intent !== 'new' && latest.state === 'found' && !deps.coordinator.hasPending(projectKey)) {
    if (await deps.verify(latest.sessionId) !== 'verified') throw new ProjectCodexLaunchError();
    await deps.open(latest.sessionId);
    if (await deps.verify(latest.sessionId) !== 'verified') throw new ProjectCodexLaunchError();
    await options.onConfirmed?.(latest.sessionId);
    return {mode: 'reopened', projectConfirmed: true, deliveryRequested: true, selectionVerified: false};
  }
  const launch = await deps.coordinator.createAndOpen({
    projectKey,
    createConversation: retain => {
      // In prepare-or-reopen mode, a newly visible thread may be the retained,
      // not-yet-finalized first conversation. Never create around it. A new
      // intent can create alongside a verified, previously completed thread.
      if (options.intent !== 'new' && latest.state !== 'none') throw new ProjectCodexLaunchError();
      return deps.create(retain);
    },
    finalizeConversation: async threadId => {
      await deps.finalize(threadId);
      // Verify this exact thread after finalization. A different recent thread
      // in the same folder cannot prove the new thread's project association.
      if (await deps.verify(threadId) !== 'verified') throw new ProjectCodexLaunchError();
    },
    verifyRecoveredConversation: async threadId => deps.verify(threadId),
    openThread: deps.open,
    afterOpen: async threadId => {
      if (await deps.verify(threadId) !== 'verified') throw new ProjectCodexLaunchError();
      await options.onConfirmed?.(threadId);
    },
  });
  return {mode: launch.reusedCreatedThread ? 'reopened' : 'prepared', projectConfirmed: true, deliveryRequested: true, selectionVerified: false};
}
