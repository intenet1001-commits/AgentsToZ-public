import {describe, expect, test} from 'bun:test';
import {confirmCodexRemoteReceipt} from '../src/CodexRemoteReceiptReview';

describe('Mac remote Codex receipt review', () => {
  test('does not resolve without an exact receipt and explicit confirmation', async () => {
    const calls: unknown[][] = [];
    const resolve = async (...args: [string, string]) => { calls.push(args); };
    const revision = 'a'.repeat(64);
    expect(await confirmCodexRemoteReceipt('project', null, async () => true, resolve)).toBe(false);
    expect(await confirmCodexRemoteReceipt('project', {state: 'completed', revision}, async () => false, resolve)).toBe(false);
    expect(calls).toEqual([]);
    expect(await confirmCodexRemoteReceipt('project', {state: 'completed', revision}, async () => true, resolve)).toBe(true);
    expect(calls).toEqual([['project', revision]]);
  });

  test('a started request requires explicit confirmation and the host can still refuse unsafe recovery', async () => {
    const receipt = {state: 'started' as const, revision: 'b'.repeat(64)};
    let called = 0;
    const resolve = async () => { called++; throw new Error('result unknown'); };
    expect(await confirmCodexRemoteReceipt('project', receipt, async () => false, resolve)).toBe(false);
    expect(called).toBe(0);
    await expect(confirmCodexRemoteReceipt('project', receipt, async () => true, resolve)).rejects.toThrow('result unknown');
    expect(called).toBe(1);
  });
});
