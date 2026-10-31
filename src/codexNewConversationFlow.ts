export type CodexNewReview = {actionId: string; state: 'started' | 'completed'};

/** The client may clear its saved intent only after a host acknowledgement or
 * a durable, authenticated proof that the first message was never sent. */
export async function runCodexNewConversationFlow(input: {
  actionId: string;
  start(actionId: string): Promise<void>;
  acknowledge(actionId: string): Promise<void>;
  review(): Promise<CodexNewReview | null>;
  confirmReview(): Promise<boolean>;
  complete(): void;
}): Promise<'created-or-recovered' | 'reviewed' | 'review-declined'> {
  try {
    await input.start(input.actionId);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'CODEX_NEW_CHAT_NOT_SENT') {
      input.complete();
      throw error;
    }
    if (code !== 'CODEX_NEW_CHAT_REVIEW_REQUIRED') throw error;
    const review = await input.review();
    if (!review || review.state !== 'completed') {
      throw new Error('이전 새 대화 요청의 결과가 아직 확인되지 않았습니다. Mac의 Codex 프로젝트를 확인하세요.');
    }
    if (!(await input.confirmReview())) return 'review-declined';
    await input.acknowledge(review.actionId);
    input.complete();
    return 'reviewed';
  }
  await input.acknowledge(input.actionId);
  input.complete();
  return 'created-or-recovered';
}
