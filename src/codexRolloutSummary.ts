export interface CodexRolloutLifecycle {
  state: 'running' | 'complete';
  turnId: string | null;
  capturedAt: string | null;
}
export interface CodexRolloutSummary {
  meta: any;
  turn: any;
  tokenEvent: any;
  lifecycle: CodexRolloutLifecycle | null;
}

/**
 * Extract only metadata, context usage and lifecycle evidence from bounded
 * JSONL slices. Message/tool payloads are deliberately ignored: automatic
 * checkpoint scheduling never needs the user's transcript.
 */
export function summarizeCodexRolloutLines(lines: readonly string[]): CodexRolloutSummary {
  let meta: any = null;
  let turn: any = null;
  let tokenEvent: any = null;
  let lifecycle: CodexRolloutLifecycle | null = null;
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === 'session_meta' && !meta) {
        meta = row.payload;
      } else if (row.type === 'turn_context') {
        turn = row.payload;
      } else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload?.info) {
        tokenEvent = row;
      } else if (row.type === 'event_msg' && row.payload?.type === 'task_started') {
        lifecycle = {
          state: 'running',
          turnId: typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null,
          capturedAt: typeof row.timestamp === 'string' ? row.timestamp : null,
        };
      } else if (row.type === 'event_msg' && row.payload?.type === 'task_complete') {
        lifecycle = {
          state: 'complete',
          turnId: typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null,
          capturedAt: typeof row.timestamp === 'string' ? row.timestamp : null,
        };
      }
    } catch {
      // A bounded head/tail slice can begin or end inside one JSONL record.
    }
  }
  return { meta, turn, tokenEvent, lifecycle };
}
