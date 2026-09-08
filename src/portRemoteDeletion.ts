import { portFenceGeneration } from './portDurableFence';

export interface LocalRemoteDeletionPort {
  id: string;
  name: string;
  worktreeParentId?: string;
  sourceDeviceId?: string;
  syncGeneration?: string;
  sourcePortId?: string;
  sourcePortDeviceId?: string;
  sourcePortSyncGeneration?: string;
}

export interface RemoteDeletionIdentityRow {
  id: string;
  device_id: string | null;
  name: string | null;
  sync_generation: string | number;
}

export interface RemoteDeletionCandidate {
  id: string;
  expectedDeviceId: string;
  expectedName: string;
  expectedGeneration: string;
}

const present = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const isFamilyDerivative = (
  port: LocalRemoteDeletionPort,
): boolean => {
  const parentId = present(port.worktreeParentId);
  // A positive parent marker can only reduce destructive authority here. The
  // parent need not be in this slice: deleting a child card by itself must not
  // reinterpret an inherited parent source ID as the child's remote identity.
  return !!parentId && parentId !== port.id;
};

/**
 * A clone imported from another device is safe to hide/delete only when its
 * original row and owner were captured together. Older name-only clones lack
 * that proof and must remain visible until a fresh Pull repairs the identity.
 */
export function assertCompleteImportedSourceIdentity(
  localFamily: readonly LocalRemoteDeletionPort[],
  ownDeviceId: string,
): void {
  const own = present(ownDeviceId);
  for (const port of localFamily) {
    if (isFamilyDerivative(port)) continue;
    const apparentOwner = present(port.sourceDeviceId);
    if (!apparentOwner || apparentOwner === own) continue;
    const sourcePortId = present(port.sourcePortId);
    const sourceOwner = present(port.sourcePortDeviceId);
    const sourceGeneration = present(port.sourcePortSyncGeneration);
    if (!sourcePortId || !sourceOwner || !sourceGeneration || sourceOwner !== apparentOwner) {
      throw new Error(`REMOTE_PORT_DELETE_SOURCE_IDENTITY_INCOMPLETE:${port.id}`);
    }
  }
}

/** Exact IDs that may be suppressed locally after source identity validation. */
export function localDeletionTargetIds(
  localFamily: readonly LocalRemoteDeletionPort[],
  ownDeviceId: string,
): string[] {
  assertCompleteImportedSourceIdentity(localFamily, ownDeviceId);
  const ids = new Set<string>();
  for (const port of localFamily) {
    ids.add(port.id);
    if (isFamilyDerivative(port)) continue;
    const sourcePortId = present(port.sourcePortId);
    const sourceOwner = present(port.sourcePortDeviceId);
    if (sourcePortId && sourceOwner) ids.add(sourcePortId);
  }
  return [...ids];
}

/** Build exact, non-destructive candidates. Authority is verified separately. */
export function remoteDeletionCandidates(
  localFamily: readonly LocalRemoteDeletionPort[],
  ownDeviceId: string,
): RemoteDeletionCandidate[] {
  const candidates = new Map<string, RemoteDeletionCandidate>();
  const add = (candidate: RemoteDeletionCandidate) => {
    const previous = candidates.get(candidate.id);
    if (previous && (previous.expectedDeviceId !== candidate.expectedDeviceId
      || previous.expectedName !== candidate.expectedName
      || previous.expectedGeneration !== candidate.expectedGeneration)) {
      throw new Error(`REMOTE_PORT_DELETE_IDENTITY_AMBIGUOUS:${candidate.id}`);
    }
    candidates.set(candidate.id, candidate);
  };
  for (const port of localFamily) {
    const name = present(port.name);
    if (!name) throw new Error(`REMOTE_PORT_DELETE_IDENTITY_INVALID:${port.id}`);
    const localOwner = present(port.sourceDeviceId) ?? present(ownDeviceId);
    if (localOwner) add({
      id: port.id,
      expectedDeviceId: localOwner,
      expectedName: name,
      expectedGeneration: portFenceGeneration(port.syncGeneration ?? '0'),
    });

    // App-generated worktrees are device-local derivatives. Old versions
    // copied their parent's source identity onto the child, which must not
    // become a second candidate for the same remote row under a child name.
    if (isFamilyDerivative(port)) continue;
    const sourcePortId = present(port.sourcePortId);
    if (!sourcePortId) continue;
    const sourceOwner = present(port.sourcePortDeviceId)
      ?? (present(port.sourceDeviceId) !== present(ownDeviceId) ? present(port.sourceDeviceId) : null);
    const sourceGeneration = present(port.sourcePortSyncGeneration);
    // A source row without its independently captured owner is not destructive
    // authority. It remains remote until the user Pulls it again.
    if (sourceOwner && sourceGeneration) add({
      id: sourcePortId,
      expectedDeviceId: sourceOwner,
      expectedName: name,
      expectedGeneration: portFenceGeneration(sourceGeneration),
    });
  }
  return [...candidates.values()];
}

/**
 * Only rows whose current server identity still matches the captured device and
 * display identity may be deleted. One mismatch fails the whole operation so a
 * forged/stale sourcePortId cannot become partial destructive authority.
 */
export function verifiedRemoteDeletionIds(
  candidates: readonly RemoteDeletionCandidate[],
  remoteRows: readonly RemoteDeletionIdentityRow[],
): string[] {
  const expected = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const verified: string[] = [];
  for (const row of remoteRows) {
    const candidate = expected.get(row.id);
    if (!candidate
      || row.device_id !== candidate.expectedDeviceId
      || row.name !== candidate.expectedName
      || portFenceGeneration(row.sync_generation) !== candidate.expectedGeneration) {
      throw new Error(`REMOTE_PORT_DELETE_IDENTITY_MISMATCH:${row.id}`);
    }
    verified.push(row.id);
  }
  return [...new Set(verified)];
}
