import type { InternetRemoteControlSession } from './internetRemoteControlContract';

/**
 * A one-use QR is spent when the relay reports any session created by that
 * exact pairing row. A later revoke does not make the already-claimed QR
 * reusable, so revoked rows must clear the stale QR too.
 */
export function isInternetRemotePairingClaimed(
  pairingId: string | null,
  sessions: ReadonlyArray<Pick<InternetRemoteControlSession, 'pairingId' | 'approvalState'>>,
): boolean {
  return Boolean(pairingId && sessions.some(session => session.pairingId === pairingId));
}

export type InternetRemoteStatusView = 'loading' | 'unavailable' | 'ready';

/**
 * A failed status check must end the spinner. Before this, one failed check
 * left `status` null forever and the dialog kept saying «확인 중…» with no way
 * to retry except closing it. «Not yet checked» (no failure recorded) is still
 * loading, so the first paint before the effect runs does not flash an error.
 */
export function internetRemoteStatusView(input: {
  initialLoading: boolean;
  hasStatus: boolean;
  loadFailed: boolean;
}): InternetRemoteStatusView {
  if (input.hasStatus && !input.initialLoading) return 'ready';
  if (!input.initialLoading && input.loadFailed) return 'unavailable';
  return 'loading';
}
