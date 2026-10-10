export const PORT_FENCE_TABLE = 'portmgr_port_fences';

const DEFAULT_FENCE_QUERY_CHUNK_SIZE = 100;

export interface KnownPortFenceReference {
  id: string;
  sourcePortId?: string;
}

export interface DeletedPortFencePropagation {
  /** False only when this is an older database where the fence table is absent. */
  available: boolean;
  queriedIds: string[];
  /** Queried IDs whose durable fence was explicitly observed as active. */
  activeFenceIds: string[];
  deletedFenceIds: string[];
  /** Local IDs plus captured source IDs that must be added to remoteDeletedPortIds. */
  markerIds: string[];
}

export interface PortFenceQueryClient {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: readonly string[]): PromiseLike<{
        data: unknown;
        error: unknown;
      }>;
    };
  };
}

function validPortId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.includes('\0');
}

function errorText(error: unknown): string {
  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    rpcError?: unknown;
    cause?: unknown;
  } | null;
  const direct = [value?.code, value?.message, value?.details, value?.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const nested = value?.rpcError && value.rpcError !== error ? errorText(value.rpcError) : '';
  const cause = value?.cause && value.cause !== error ? errorText(value.cause) : '';
  return [direct, nested, cause].filter(Boolean).join(' ');
}

/** Only a genuinely old schema may degrade to no-op; network/auth failures stay visible. */
export function isPortFenceTableUnavailable(error: unknown): boolean {
  const value = error as { code?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
  const text = errorText(error).toLowerCase();
  if (!text.includes(PORT_FENCE_TABLE)) return false;
  return code === '42P01'
    || code === 'PGRST205'
    || /relation .* does not exist|could not find (?:the )?table|schema cache/.test(text);
}

/** Recognize the durable RPC's exact deleted-state rejection, including nested errors. */
export function isPortFenceDeletedError(error: unknown): boolean {
  return /(?:^|\b)PORT_FENCE_DELETED(?:\b|$)/i.test(errorText(error));
}

/**
 * Remember exactly which permanent markers were absent before a destructive
 * attempt. A deterministic pre-mutation failure may roll back only this set;
 * markers discovered by an earlier Pull/Mac are durable deletion evidence and
 * must survive every unrelated retry.
 */
export function portFenceMarkerIdsAddedThisAttempt(
  candidateIds: readonly string[],
  authoritativeExistingIds: readonly string[],
): string[] {
  const existing = new Set<string>();
  for (const id of authoritativeExistingIds) {
    if (!validPortId(id)) throw new Error('PORT_FENCE_PROPAGATION_EXISTING_MARKER_INVALID');
    existing.add(id);
  }
  const added = new Set<string>();
  for (const id of candidateIds) {
    if (!validPortId(id)) throw new Error('PORT_FENCE_PROPAGATION_MARKER_ID_INVALID');
    if (!existing.has(id)) added.add(id);
  }
  return [...added].sort((left, right) => left.localeCompare(right));
}

/**
 * A local clone can have a new local ID while still referring to its original
 * Supabase row through sourcePortId. Query both and map a deleted source back to
 * every affected local clone. Nothing here grants deletion authority or mutates DB.
 */
export function portFenceReferences(
  rows: readonly KnownPortFenceReference[],
): { queriedIds: string[]; markerIdsByFenceId: Map<string, string[]> } {
  const markerSets = new Map<string, Set<string>>();
  const add = (fenceId: string, markerId: string) => {
    const markers = markerSets.get(fenceId) ?? new Set<string>();
    markers.add(markerId);
    markerSets.set(fenceId, markers);
  };

  for (const row of rows) {
    if (!validPortId(row.id)) throw new Error('PORT_FENCE_PROPAGATION_LOCAL_ID_INVALID');
    add(row.id, row.id);
    if (row.sourcePortId !== undefined) {
      if (!validPortId(row.sourcePortId)) {
        throw new Error(`PORT_FENCE_PROPAGATION_SOURCE_ID_INVALID:${row.id}`);
      }
      add(row.sourcePortId, row.sourcePortId);
      add(row.sourcePortId, row.id);
    }
  }

  const queriedIds = [...markerSets.keys()].sort((left, right) => left.localeCompare(right));
  return {
    queriedIds,
    markerIdsByFenceId: new Map(queriedIds.map(id => [
      id,
      [...(markerSets.get(id) ?? [])].sort((left, right) => left.localeCompare(right)),
    ])),
  };
}

export async function queryDeletedPortFencePropagation(
  client: PortFenceQueryClient,
  rows: readonly KnownPortFenceReference[],
  chunkSize = DEFAULT_FENCE_QUERY_CHUNK_SIZE,
): Promise<DeletedPortFencePropagation> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) {
    throw new Error('PORT_FENCE_PROPAGATION_CHUNK_SIZE_INVALID');
  }
  const { queriedIds, markerIdsByFenceId } = portFenceReferences(rows);
  if (queriedIds.length === 0) {
    return {
      available: true,
      queriedIds: [],
      activeFenceIds: [],
      deletedFenceIds: [],
      markerIds: [],
    };
  }

  const states = new Map<string, 'active' | 'deleted'>();
  for (let index = 0; index < queriedIds.length; index += chunkSize) {
    const chunk = queriedIds.slice(index, index + chunkSize);
    const { data, error } = await client
      .from(PORT_FENCE_TABLE)
      .select('port_id,state')
      .in('port_id', chunk);
    if (error) {
      if (isPortFenceTableUnavailable(error)) {
        return {
          available: false,
          queriedIds,
          activeFenceIds: [],
          deletedFenceIds: [],
          markerIds: [],
        };
      }
      throw new Error(`PORT_FENCE_PROPAGATION_QUERY_FAILED:${errorText(error) || 'unknown error'}`);
    }
    if (!Array.isArray(data)) throw new Error('PORT_FENCE_PROPAGATION_RESPONSE_INVALID');
    const requested = new Set(chunk);
    for (const value of data) {
      if (!value || typeof value !== 'object') {
        throw new Error('PORT_FENCE_PROPAGATION_RESPONSE_INVALID');
      }
      const record = value as Record<string, unknown>;
      if (!validPortId(record.port_id)
        || !requested.has(record.port_id)
        || (record.state !== 'active' && record.state !== 'deleted')
        || states.has(record.port_id)) {
        throw new Error('PORT_FENCE_PROPAGATION_RESPONSE_INVALID');
      }
      states.set(record.port_id, record.state);
    }
  }

  const activeFenceIds = queriedIds.filter(id => states.get(id) === 'active');
  const deletedFenceIds = queriedIds.filter(id => states.get(id) === 'deleted');
  const markerIds = [...new Set(deletedFenceIds.flatMap(
    id => markerIdsByFenceId.get(id) ?? [id],
  ))].sort((left, right) => left.localeCompare(right));
  return { available: true, queriedIds, activeFenceIds, deletedFenceIds, markerIds };
}
