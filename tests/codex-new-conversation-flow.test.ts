import {describe, expect, test} from 'bun:test';
import {runCodexNewConversationFlow} from '../src/codexNewConversationFlow';

const tagged = (code: string) => Object.assign(new Error(code), {code});
describe('remote Codex new-conversation flow', () => {
  test('preserves the same intent on lost start or ack and clears only after ack succeeds', async () => {
    const starts: string[] = [], acks: string[] = []; let clear = 0, startAttempts = 0, ackAttempts = 0;
    const flow = {
      actionId: 'same-id',
      async start(id: string) { starts.push(id); if (++startAttempts === 1) throw new Error('network unknown'); },
      async acknowledge(id: string) { acks.push(id); if (++ackAttempts === 1) throw new Error('ack unknown'); },
      async review() { return null; }, async confirmReview() { return false; }, complete() { clear++; },
    };
    await expect(runCodexNewConversationFlow(flow)).rejects.toThrow('network unknown');
    expect(clear).toBe(0);
    await expect(runCodexNewConversationFlow(flow)).rejects.toThrow('ack unknown');
    expect(clear).toBe(0);
    expect(await runCodexNewConversationFlow(flow)).toBe('created-or-recovered');
    expect(starts).toEqual(['same-id', 'same-id', 'same-id']);
    expect(acks).toEqual(['same-id', 'same-id']);
    expect(clear).toBe(1);
  });

  test('clears only an authenticated not-sent start, not unknown failures or ack failures', async () => {
    let clears = 0;
    const common = {actionId: 'id', async acknowledge() {}, async review() { return null; }, async confirmReview() { return false; }, complete() { clears++; }};
    await expect(runCodexNewConversationFlow({...common, async start() { throw tagged('CODEX_NEW_CHAT_NOT_SENT'); }})).rejects.toThrow();
    expect(clears).toBe(1);
    await expect(runCodexNewConversationFlow({...common, async start() { throw new Error('unknown'); }})).rejects.toThrow();
    await expect(runCodexNewConversationFlow({...common, async start() {}, async acknowledge() { throw tagged('CODEX_NEW_CHAT_NOT_SENT'); }})).rejects.toThrow();
    expect(clears).toBe(1);
  });

  test('a different-origin review requires explicit confirmation and acknowledges the original id', async () => {
    let confirmed = false, clears = 0; const acked: string[] = [];
    const flow = {actionId: 'new-origin-id', async start() { throw tagged('CODEX_NEW_CHAT_REVIEW_REQUIRED'); },
      async review() { return {actionId: 'original-id', state: 'completed' as const}; },
      async confirmReview() { return confirmed; }, async acknowledge(id: string) { acked.push(id); }, complete() { clears++; }};
    expect(await runCodexNewConversationFlow(flow)).toBe('review-declined');
    expect(acked).toEqual([]); expect(clears).toBe(0);
    confirmed = true;
    expect(await runCodexNewConversationFlow(flow)).toBe('reviewed');
    expect(acked).toEqual(['original-id']); expect(clears).toBe(1);
    await expect(runCodexNewConversationFlow({...flow, async review() { return {actionId: 'original-id', state: 'started' as const}; }})).rejects.toThrow('아직 확인되지 않았습니다');
    expect(acked).toEqual(['original-id']);
  });
});
