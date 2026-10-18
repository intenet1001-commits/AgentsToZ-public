/**
 * Does the separate 「아젠투지 호출」 window still exist? The main window only offers its reopen button
 * once it knows the window is gone (VOC 2026-10-15: closing it left no way back short of quitting the app).
 *
 * `epoch` advances on every event we witnessed ourselves, so a state query that was sent before a close or
 * an open cannot overwrite what happened after it was sent.
 */
export type VoiceDockWindowStatus = 'unknown' | 'open' | 'closed' | 'opening';
export type VoiceDockWindowState = {status: VoiceDockWindowStatus; epoch: number};
export type VoiceDockWindowEvent =
  | {type: 'open-requested'}
  | {type: 'opened'}
  | {type: 'open-failed'}
  | {type: 'closed'}
  | {type: 'queried'; epoch: number; open: boolean};

export const initialVoiceDockWindowState: VoiceDockWindowState = {status: 'unknown', epoch: 0};

export function voiceDockWindowReducer(state: VoiceDockWindowState, event: VoiceDockWindowEvent): VoiceDockWindowState {
  switch (event.type) {
    case 'open-requested': return {status: 'opening', epoch: state.epoch + 1};
    case 'opened': return {status: 'open', epoch: state.epoch + 1};
    case 'open-failed': return {status: 'closed', epoch: state.epoch + 1};
    case 'closed': return {status: 'closed', epoch: state.epoch + 1};
    case 'queried':
      // A stale answer, or one that races an open we are still waiting for, says nothing new.
      if (event.epoch !== state.epoch || state.status === 'opening') return state;
      return {status: event.open ? 'open' : 'closed', epoch: state.epoch};
  }
}

export function showVoiceDockReopen(state: VoiceDockWindowState): boolean {
  return state.status === 'closed';
}

/** Window event that asks the main window to bring back the compact dock (「도구 및 설정」). */
export const OPEN_VOICE_DOCK_EVENT = 'agentstoz:open-voice-dock';
