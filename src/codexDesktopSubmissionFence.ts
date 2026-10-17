import { randomUUID } from 'node:crypto';
import { CodexFirstConversationError } from './codexFirstConversation';
import type { CodexFirstConversationPendingStore } from './codexFirstConversationLaunch';
import type { CodexDesktopComposerAutomationErrorCode } from './codexDesktopProjectSubmit';

/** A blank Desktop draft can have no thread ID until Return is dispatched. */
export async function submitCodexDesktopDraft(input: {
  store: CodexFirstConversationPendingStore;
  projectKey: string;
  submit: () => Promise<{ ok: true } | { ok: false; code: CodexDesktopComposerAutomationErrorCode; error: string }>;
  findCreatedThread: () => Promise<string | null>;
  retainCreatedThread: (threadId: string) => void;
}): Promise<{ threadId: string }> {
  if (input.store.load(input.projectKey)) {
    throw new CodexFirstConversationError(
      'CODEX_DESKTOP_SUBMISSION_UNCERTAIN',
      '이전 첫 메시지 전달 결과가 불확실해 중복 전송을 차단했습니다. Mac의 Codex에서 생성된 대화를 확인하세요. 새 대화를 자동으로 다시 만들지 않습니다.',
    );
  }
  // This registry stores an attempt UUID, not a thread UUID. Persist BEFORE
  // Return, including for drafts with no pre-existing metadata ID.
  input.store.save(input.projectKey, randomUUID());
  const submission = await input.submit();
  if (!submission.ok) {
    // These explicit automation errors occur before key code 36/SendKeys.
    // An exception or unknown outcome leaves the durable fence intact.
    if (submission.code !== 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN') input.store.clear(input.projectKey);
    throw new CodexFirstConversationError(submission.code, submission.error);
  }
  const threadId = await input.findCreatedThread();
  if (!threadId) {
    throw new CodexFirstConversationError(
      'CODEX_THREAD_PERSISTENCE_TIMEOUT',
      '첫 메시지를 전달했지만 프로젝트 대화 저장을 확인하지 못했습니다. 중복 전송을 막기 위해 Mac의 Codex에서 대화를 확인해야 합니다.',
    );
  }
  input.retainCreatedThread(threadId);
  input.store.clear(input.projectKey);
  return { threadId };
}
