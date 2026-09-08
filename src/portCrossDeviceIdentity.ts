import {
  githubRepositoryUrlFields,
  githubRepositoryUrls,
  normalizeGitHubRepositoryUrl,
  type GitHubUrlFields,
  type GitHubUrlSource,
} from './githubUrls';

export interface CrossDeviceIdentityPort extends GitHubUrlSource {
  id: string;
  sourceDeviceId?: string;
  syncGeneration?: string;
  sourcePortId?: string;
  sourcePortDeviceId?: string;
  sourcePortSyncGeneration?: string;
}

export interface SourcePortIdentity {
  sourcePortId?: string;
  sourcePortDeviceId?: string;
  sourcePortSyncGeneration?: string;
}

const present = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const githubRepositoryKeys = (port: GitHubUrlSource): Set<string> => new Set(
  githubRepositoryUrls(port)
    .map(url => normalizeGitHubRepositoryUrl(url)?.toLowerCase())
    .filter((url): url is string => !!url),
);

const sharesStableRepository = (
  existing: GitHubUrlSource,
  remote: GitHubUrlSource,
): boolean => {
  const existingKeys = githubRepositoryKeys(existing);
  if (existingKeys.size === 0) return false;
  return [...githubRepositoryKeys(remote)].some(key => existingKeys.has(key));
};

/**
 * A cross-device Pull still uses the display name to decide where shared,
 * non-destructive metadata is shown. A name, however, is never deletion
 * authority: unrelated projects can legitimately have the same name.
 *
 * Existing source identity is immutable here. In particular, a legacy partial
 * identity is not completed from a later same-name row. A previously local row
 * may gain source identity only when the remote row has a captured owner and a
 * stable identity agrees: the exact row UUID or a canonical GitHub repository.
 */
export function sourcePortIdentityAfterCrossDeviceMatch(
  existing: CrossDeviceIdentityPort,
  remote: CrossDeviceIdentityPort,
): SourcePortIdentity {
  const existingSourcePortId = present(existing.sourcePortId);
  const existingSourcePortDeviceId = present(existing.sourcePortDeviceId);
  const existingSourcePortSyncGeneration = present(existing.sourcePortSyncGeneration);
  if (existingSourcePortId || existingSourcePortDeviceId) {
    // ID and owner are immutable authority, but generation is a moving CAS
    // cursor. A fresh Pull of that exact established source may advance it;
    // otherwise an ordinary edit on the source Mac would make deletion from
    // this Mac permanently impossible even after the user pulled again.
    const exactEstablishedSource = !!existingSourcePortId
      && !!existingSourcePortDeviceId
      && present(remote.id) === existingSourcePortId
      && present(remote.sourceDeviceId) === existingSourcePortDeviceId;
    const refreshedGeneration = exactEstablishedSource
      ? present(remote.syncGeneration) ?? existingSourcePortSyncGeneration
      : existingSourcePortSyncGeneration;
    return {
      sourcePortId: existingSourcePortId,
      sourcePortDeviceId: existingSourcePortDeviceId,
      ...(refreshedGeneration
        ? { sourcePortSyncGeneration: refreshedGeneration }
        : {}),
    };
  }

  const remoteId = present(remote.id);
  const remoteDeviceId = present(remote.sourceDeviceId);
  if (!remoteId || !remoteDeviceId) return {};

  const exactRow = present(existing.id) === remoteId;
  if (!exactRow && !sharesStableRepository(existing, remote)) return {};

  return {
    sourcePortId: remoteId,
    sourcePortDeviceId: remoteDeviceId,
    ...(present(remote.syncGeneration)
      ? { sourcePortSyncGeneration: present(remote.syncGeneration) }
      : {}),
  };
}

/**
 * Repository URLs are identity-bearing metadata. A name-only Pull must not
 * copy them into the local row, because a second Pull could then mistake that
 * copied URL for independent lineage proof and grant remote deletion rights.
 */
export function githubFieldsAfterCrossDeviceMatch(
  existing: CrossDeviceIdentityPort,
  remote: CrossDeviceIdentityPort,
  identity: SourcePortIdentity,
): GitHubUrlFields {
  const trustedSource = present(remote.id) === present(identity.sourcePortId)
    && present(remote.sourceDeviceId) === present(identity.sourcePortDeviceId);
  const remoteUrls = githubRepositoryUrls(remote);
  return githubRepositoryUrlFields(
    trustedSource && remoteUrls.length > 0 ? remoteUrls : githubRepositoryUrls(existing),
  );
}
