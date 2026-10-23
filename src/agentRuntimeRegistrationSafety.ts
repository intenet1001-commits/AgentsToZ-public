import { normalizeLocalOnlyDeletedPortIds } from './portLocalDeletion';

export interface AgentRuntimeRegistrationSafetyMetadata {
  localOnlyDeletedPortIds?: unknown;
  remoteDeletedPortIds?: unknown;
  verifiedLegacyGeneratedWorktreeIds?: unknown;
}

export interface NormalizedAgentRuntimeRegistrationSafetyMetadata {
  localOnlyDeletedPortIds: string[];
  remoteDeletedPortIds: string[];
  verifiedLegacyGeneratedWorktreeIds: string[];
}

const SAFETY_FIELDS = [
  'localOnlyDeletedPortIds',
  'remoteDeletedPortIds',
  'verifiedLegacyGeneratedWorktreeIds',
] as const;

/**
 * Agent Runtime treats all three local suppression ledgers as execution
 * authority. A malformed ledger shape is unknown authority, not an empty set.
 */
export function normalizeAgentRuntimeRegistrationSafetyMetadata(
  value: unknown,
): NormalizedAgentRuntimeRegistrationSafetyMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AGENT_RUNTIME_REGISTRATION_SAFETY_INVALID');
  }
  const metadata = value as AgentRuntimeRegistrationSafetyMetadata;
  for (const field of SAFETY_FIELDS) {
    if (metadata[field] !== undefined && !Array.isArray(metadata[field])) {
      throw new Error('AGENT_RUNTIME_REGISTRATION_SAFETY_INVALID');
    }
  }
  return {
    localOnlyDeletedPortIds: normalizeLocalOnlyDeletedPortIds(
      metadata.localOnlyDeletedPortIds,
    ),
    remoteDeletedPortIds: normalizeLocalOnlyDeletedPortIds(
      metadata.remoteDeletedPortIds,
    ),
    verifiedLegacyGeneratedWorktreeIds: normalizeLocalOnlyDeletedPortIds(
      metadata.verifiedLegacyGeneratedWorktreeIds,
    ),
  };
}

/** Pure, runtime-only projection from persisted rows to executable rows. */
export function withoutAgentRuntimeSuppressedTargets<T extends { id?: unknown }>(
  rows: readonly T[],
  metadataInput: unknown,
): T[] {
  const metadata = normalizeAgentRuntimeRegistrationSafetyMetadata(metadataInput);
  const excluded = new Set([
    ...metadata.localOnlyDeletedPortIds,
    ...metadata.remoteDeletedPortIds,
    ...metadata.verifiedLegacyGeneratedWorktreeIds,
  ]);
  return rows.filter(row => typeof row.id !== 'string' || !excluded.has(row.id));
}
