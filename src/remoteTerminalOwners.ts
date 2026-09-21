/**
 * Who may drive an AI terminal from a remote surface.
 *
 * This lived inline in api-server.ts as a pair of maps over `status().sessions`, which made the
 * rule untestable: the LAN suites had to restate the predicate in their own fixtures, so reverting
 * the production filter broke nothing. The rule is small and load-bearing enough to own a file.
 *
 * Two things gate an owner, and they are different questions:
 *   - LAN: is a socket attached right now? A paired phone stays listed while its screen is locked
 *     so the operator can still revoke it, but a session with no socket is nobody to grant a PTY.
 *   - Internet: has the Mac approved this controller? Pending and revoked controllers are listed
 *     too, and neither has been let in.
 */

export type LanTerminalOwnerSource = {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
};

export type InternetTerminalOwnerSource = {
  readonly sessionId: string;
  readonly controllerName: string;
  readonly approvalState: string;
};

export type RemoteTerminalOwner = { id: string; label: string };

export function remoteTerminalOwners(sources: {
  lan?: readonly LanTerminalOwnerSource[];
  internet?: readonly InternetTerminalOwnerSource[];
}): RemoteTerminalOwner[] {
  return [
    ...(sources.lan ?? [])
      .filter(session => session.connected)
      .map(session => ({ id: 'lan:' + session.id, label: session.label })),
    ...(sources.internet ?? [])
      .filter(session => session.approvalState === 'approved')
      .map(session => ({ id: 'internet:' + session.sessionId, label: session.controllerName })),
  ];
}
