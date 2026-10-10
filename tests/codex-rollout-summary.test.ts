import { describe, expect, test } from 'bun:test';

import { summarizeCodexRolloutLines } from '../src/codexRolloutSummary';

const row = (timestamp: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp, type, payload });

describe('Codex rollout summary', () => {
  test('tracks the latest context and proves a completed turn without retaining messages', () => {
    const summary = summarizeCodexRolloutLines([
      row('2026-09-05T00:00:00.000Z', 'session_meta', { id: 'session-1', cwd: '/work' }),
      row('2026-09-05T00:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      row('2026-09-05T00:00:02.000Z', 'response_item', { type: 'message', content: 'must not be selected' }),
      row('2026-09-05T00:00:03.000Z', 'turn_context', { cwd: '/work/tree', model: 'gpt' }),
      row('2026-09-05T00:00:04.000Z', 'event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 50 }, model_context_window: 100 } }),
      row('2026-09-05T00:00:05.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'ignored' }),
    ]);
    expect(summary.meta).toMatchObject({ id: 'session-1' });
    expect(summary.turn).toMatchObject({ cwd: '/work/tree' });
    expect(summary.tokenEvent.payload.info.last_token_usage.total_tokens).toBe(50);
    expect(summary.lifecycle).toEqual({
      state: 'complete',
      turnId: 'turn-1',
      capturedAt: '2026-09-05T00:00:05.000Z',
    });
    expect(JSON.stringify(summary)).not.toContain('must not be selected');
    expect(JSON.stringify(summary)).not.toContain('ignored');
  });

  test('a newer task_started makes the session busy even after an earlier completion', () => {
    const summary = summarizeCodexRolloutLines([
      row('2026-09-05T00:00:00.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
      row('2026-09-05T00:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
    ]);
    expect(summary.lifecycle).toEqual({
      state: 'running',
      turnId: 'turn-2',
      capturedAt: '2026-09-05T00:00:01.000Z',
    });
  });
});
