import {
  addLocalOnlyDeletedPortIds,
  normalizeLocalOnlyDeletedPortIds,
  removeLocalOnlyDeletedPortIds,
} from './portLocalDeletion';

export const PORTAL_LOCAL_METADATA_EVENT = 'agentstoz:portal-local-metadata';

export interface PortalLocalMetadata {
  localOnlyDeletedPortIds?: string[];
  remoteDeletedPortIds?: string[];
  verifiedLegacyGeneratedWorktreeIds?: string[];
}

export type PortalLocalMetadataField = keyof PortalLocalMetadata;
export type PortalLocalMetadataMutationMode = 'add' | 'remove';

/**
 * Stable, content-only generation for the three local safety marker sets.
 * The order of IDs is not semantic, so sort copies before comparing. This lets
 * long-running reloads detect both a concurrent deletion (add) and an explicit
 * restore (remove) without including portal credentials in the fingerprint.
 */
export function portalLocalMetadataFingerprint(
  metadata: PortalLocalMetadata | null | undefined,
): string {
  return JSON.stringify([
    [...normalizeLocalOnlyDeletedPortIds(metadata?.localOnlyDeletedPortIds)].sort(),
    [...normalizeLocalOnlyDeletedPortIds(metadata?.remoteDeletedPortIds)].sort(),
    [...normalizeLocalOnlyDeletedPortIds(metadata?.verifiedLegacyGeneratedWorktreeIds)].sort(),
  ]);
}

/**
 * These fields are local safety state, not import/export payload. Full portal
 * writers must carry the authoritative on-disk values forward verbatim.
 */
export function preservePortalLocalMetadata<T extends Record<string, any>>(
  incoming: T,
  authoritative: PortalLocalMetadata | null | undefined,
): Omit<T, keyof PortalLocalMetadata> & PortalLocalMetadata {
  return {
    ...incoming,
    localOnlyDeletedPortIds: normalizeLocalOnlyDeletedPortIds(
      authoritative?.localOnlyDeletedPortIds,
    ),
    remoteDeletedPortIds: normalizeLocalOnlyDeletedPortIds(
      authoritative?.remoteDeletedPortIds,
    ),
    verifiedLegacyGeneratedWorktreeIds: normalizeLocalOnlyDeletedPortIds(
      authoritative?.verifiedLegacyGeneratedWorktreeIds,
    ),
  };
}

export function mutatePortalLocalMetadata(
  authoritative: PortalLocalMetadata | null | undefined,
  input: { field: unknown; ids: unknown; mode: unknown },
): Required<PortalLocalMetadata> {
  if ((input.field !== 'localOnlyDeletedPortIds'
      && input.field !== 'remoteDeletedPortIds'
      && input.field !== 'verifiedLegacyGeneratedWorktreeIds')
    || (input.mode !== 'add' && input.mode !== 'remove')
    || !Array.isArray(input.ids)
    || input.ids.length > 2_048) {
    throw new Error('포털 로컬 메타데이터 변경 요청이 올바르지 않습니다.');
  }
  const current = preservePortalLocalMetadata({}, authoritative) as Required<PortalLocalMetadata>;
  const ids = input.ids.filter((value): value is string => typeof value === 'string');
  current[input.field] = input.mode === 'add'
    ? addLocalOnlyDeletedPortIds(current[input.field], ids)
    : removeLocalOnlyDeletedPortIds(current[input.field], ids);
  return current;
}

// App and PortalManager share one renderer but independently write portal.json.
// Serialize read/merge/write sequences so a stale full write cannot erase or
// resurrect a local safety marker.
let portalWriteTail: Promise<void> = Promise.resolve();

export function runPortalDataWriteExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const run = portalWriteTail.then(operation, operation);
  portalWriteTail = run.then(() => undefined, () => undefined);
  return run;
}

export function dispatchPortalLocalMetadata(metadata: PortalLocalMetadata): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PORTAL_LOCAL_METADATA_EVENT, {
    detail: {
      localOnlyDeletedPortIds: normalizeLocalOnlyDeletedPortIds(metadata.localOnlyDeletedPortIds),
      remoteDeletedPortIds: normalizeLocalOnlyDeletedPortIds(metadata.remoteDeletedPortIds),
      verifiedLegacyGeneratedWorktreeIds: normalizeLocalOnlyDeletedPortIds(
        metadata.verifiedLegacyGeneratedWorktreeIds,
      ),
    },
  }));
}
