import type {CodexAutoRememberObservation} from './codexAutoRememberContract';

/** Pair a measured statusline context window with a matching, completed transcript turn. */
export function claudeAutoRememberObservation(snapshot: any, transcriptTail: string): CodexAutoRememberObservation | null {
  if (!snapshot || typeof snapshot.sessionId !== 'string' || !/^[\w-]{8,100}$/.test(snapshot.sessionId)
    || typeof snapshot.cwd !== 'string' || !snapshot.cwd || /[\0\r\n]/.test(snapshot.cwd)) return null;
  const usedPercent = snapshot.contextWindow?.used_percentage;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
    || !Number.isFinite(Date.parse(snapshot.capturedAt))) return null;
  let turnState: CodexAutoRememberObservation['turnState'] = 'unknown';
  let turnId: string | null = null, turnCompletedAt: string | null = null;
  for (const line of transcriptTail.split(/\r?\n/).filter(line=>line.trim())) {
    let row: any;
    try { row = JSON.parse(line); } catch { turnState='unknown';turnId=null;turnCompletedAt=null;continue; }
    if (row.sessionId !== snapshot.sessionId || row.isSidechain === true) continue;
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    turnState='running';turnId=null;turnCompletedAt=null;
    if (row.type === 'assistant' && row.message?.stop_reason === 'end_turn'
      && typeof row.uuid === 'string' && row.uuid.length <= 128 && Number.isFinite(Date.parse(row.timestamp))
      && Date.parse(snapshot.capturedAt) >= Date.parse(row.timestamp)) {
      turnState='complete';turnId=row.uuid;turnCompletedAt=row.timestamp;
    }
  }
  return {sourceAgent:'claude',sessionId:`claude:${snapshot.sessionId}`,cwd:snapshot.cwd,usedPercent,
    capturedAt:snapshot.capturedAt,turnState,turnId,turnCompletedAt};
}
