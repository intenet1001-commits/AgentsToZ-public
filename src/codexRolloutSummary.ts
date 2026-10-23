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
  usagePeak?: { usedPercent: number; capturedAt: string };
  usagePeaks?: { usedPercent: number; capturedAt: string }[];
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
  let usagePeak: CodexRolloutSummary['usagePeak'];
  const usagePeaks: NonNullable<CodexRolloutSummary['usagePeaks']> = [];
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
        const info = row.payload.info;
        const used = info.last_token_usage?.total_tokens;
        const window = info.model_context_window;
        if (typeof used === 'number' && Number.isFinite(used) && used >= 0
          && typeof window === 'number' && Number.isFinite(window) && window > 0
          && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))) {
          const usedPercent = Math.min(100, used / window * 100);
          if (!usagePeak || usedPercent >= usagePeak.usedPercent) usagePeak = { usedPercent, capturedAt: row.timestamp };
          usagePeaks.push({usedPercent, capturedAt: row.timestamp});
          if (usagePeaks.length > 32) usagePeaks.shift();
        }
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
  return { meta, turn, tokenEvent, lifecycle, usagePeak, usagePeaks };
}
