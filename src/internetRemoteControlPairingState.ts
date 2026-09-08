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
