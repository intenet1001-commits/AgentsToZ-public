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

/** Shared Mac/remote entry: create only on a positively empty desktop inventory. */
export async function openProjectCodexWorkspace(projectKey: string, deps: ProjectCodexLaunchDependencies): Promise<ProjectCodexLaunchResult> {
  const latest = deps.latest();
  if (latest.state === 'unavailable') throw new ProjectCodexLaunchError();
  if (latest.state === 'found' && !deps.coordinator.hasPending(projectKey)) {
    if (await deps.verify(latest.sessionId) !== 'verified') throw new ProjectCodexLaunchError();
    await deps.open(latest.sessionId);
    return {mode: 'reopened', projectConfirmed: true, deliveryRequested: true, selectionVerified: false};
  }
  await deps.coordinator.createAndOpen({
    projectKey,
    createConversation: retain => {
      // A newly visible thread can be the retained, not-yet-finalized first
      // conversation. Finish it through the coordinator, never create around it.
      if (latest.state !== 'none') throw new ProjectCodexLaunchError();
      return deps.create(retain);
    },
    finalizeConversation: deps.finalize,
    verifyRecoveredConversation: async threadId => deps.verify(threadId),
    openThread: deps.open,
  });
  return {mode: 'prepared', projectConfirmed: true, deliveryRequested: true, selectionVerified: false};
}
