import {describe, expect, test} from 'bun:test';
import {parseServerMessage} from '../src/remoteControlRelayController';

describe('Codex new conversation review response', () => {
  test('accepts only the bounded receipt identity and state', () => {
    const base = {type: 'action.result', actionId: 'review-1', ok: true} as const;
    expect(parseServerMessage({...base, codexNewChatReceipt: null})).toEqual({...base, codexNewChatReceipt: null});
    expect(parseServerMessage({...base, codexNewChatReceipt: {actionId: 'start-1', state: 'completed'}}))
      .toEqual({...base, codexNewChatReceipt: {actionId: 'start-1', state: 'completed'}});
    for (const receipt of [
      {actionId: 'start-1', state: 'unknown'},
      {actionId: 'with spaces', state: 'started'},
      {actionId: 'start-1', state: 'completed', path: '/private'},
    ]) expect(() => parseServerMessage({...base, codexNewChatReceipt: receipt})).toThrow('REMOTE_CONTROL_RESPONSE_INVALID');
    expect(() => parseServerMessage({...base, codexNewChatReceipt: null, project: null})).toThrow('REMOTE_CONTROL_RESPONSE_INVALID');
  });
});
