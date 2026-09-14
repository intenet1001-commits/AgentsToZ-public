import {
  PortDurableFenceError,
  portFenceGeneration,
  type PortFenceGenerationInput,
} from './portDurableFence';

export interface LocalPortGenerationRow {
  id: string;
  syncGeneration?: PortFenceGenerationInput;
}

export interface PortFenceGenerationResultLike {
  id: string;
  generation: PortFenceGenerationInput;
}

export interface AppliedPortFenceGenerations<
  TPort extends LocalPortGenerationRow,
  TOtherPort,
> {
  /** The latest local rows, with only matching rows' syncGeneration updated. */
  ports: readonly TPort[];
  /** Other-platform rows are never owned or rewritten by this operation. */
  otherPlatformPorts: readonly TOtherPort[];
  changed: boolean;
}

/**
 * Retry exactly once only when the first durable RPC response cannot prove
 * whether the mutation committed. The caller owns and closes over one stable
 * operation UUID; generating an ID inside this helper would break semantic
 * replay and is intentionally impossible.
 */
export async function retryPortFenceMutationAfterCommitUnknown<T>(
  runWithSameOperationId: () => Promise<T>,
): Promise<T> {
  try {
    return await runWithSameOperationId();
  } catch (error) {
    if (!(error instanceof PortDurableFenceError) || !error.mutationMayHaveCommitted) {
      throw error;
    }
  }
  return runWithSameOperationId();
}

function requiredId(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PORT_GENERATION_STATE_INVALID_${context.toUpperCase()}_ID`);
  }
  return value;
}

function uniqueIds(values: readonly unknown[], context: string): string[] {
  const seen = new Set<string>();
  return values.map(value => {
    const id = requiredId(value, context);
    if (seen.has(id)) {
      throw new Error(`PORT_GENERATION_STATE_DUPLICATE_${context.toUpperCase()}_ID:${id}`);
    }
    seen.add(id);
    return id;
  });
}

function exactGenerationResults(
  expectedIds: readonly string[],
  results: readonly PortFenceGenerationResultLike[],
): ReadonlyMap<string, string> {
  const expected = uniqueIds(expectedIds, 'expected');
  const resultIds = uniqueIds(results.map(result => result?.id), 'result');
  const expectedSet = new Set(expected);
  if (expected.length !== resultIds.length
    || resultIds.some(id => !expectedSet.has(id))) {
    throw new Error('PORT_GENERATION_STATE_RESULT_SET_MISMATCH');
  }

  return new Map(results.map((result, index) => [
    resultIds[index]!,
    portFenceGeneration(result?.generation),
  ]));
}

/**
 * Apply a committed RPC's generation results to the latest in-memory rows.
 *
 * The caller deliberately passes the response-time arrays, not the rows that
 * were submitted to the RPC. That means a concurrent UI edit stays intact and
 * a row removed while the request was in flight is never reinserted. Results
 * must still exactly match the submitted IDs, so a partial/duplicated server
 * response cannot silently advance local CAS state.
 */
export function applyPortFenceResultGenerations<
  TPort extends LocalPortGenerationRow,
  TOtherPort,
>(
  currentPorts: readonly TPort[],
  otherPlatformPorts: readonly TOtherPort[],
  expectedIds: readonly string[],
  results: readonly PortFenceGenerationResultLike[],
): AppliedPortFenceGenerations<TPort, TOtherPort> {
  const generationById = exactGenerationResults(expectedIds, results);

  const targetedLocalIds = new Set<string>();
  for (const row of currentPorts) {
    const id = requiredId(row?.id, 'local');
    if (!generationById.has(id)) continue;
    if (targetedLocalIds.has(id)) {
      throw new Error(`PORT_GENERATION_STATE_DUPLICATE_LOCAL_ID:${id}`);
    }
    targetedLocalIds.add(id);
  }

  let changed = false;
  const nextPorts = currentPorts.map(row => {
    const generation = generationById.get(row.id);
    if (generation === undefined) return row;
    const currentGeneration = portFenceGeneration(row.syncGeneration ?? '0');
    if (currentGeneration === generation) return row;
    changed = true;
    return { ...row, syncGeneration: generation };
  });

  return {
    ports: changed ? nextPorts : currentPorts,
    otherPlatformPorts,
    changed,
  };
}

export interface RemotePortGenerationRow {
  id: string;
  sync_generation: PortFenceGenerationInput;
}

export interface RemotePortFenceStateRow {
  port_id: string;
  generation: PortFenceGenerationInput;
  state: 'active' | 'deleted';
}

export type ResolvedSnapshotRow<TSnapshot extends { id: string }> =
  Omit<TSnapshot, 'sync_generation'> & { sync_generation: string };

export interface ResolvedSnapshotRows<TSnapshot extends { id: string }> {
  /** Original order is retained, excluding IDs protected by deleted fences. */
  rows: readonly ResolvedSnapshotRow<TSnapshot>[];
  skippedDeletedIds: readonly string[];
}

/**
 * Rebase historical snapshot bytes onto the current durable CAS state.
 *
 * A snapshot generation is historical evidence, never current write authority:
 * an active row uses the live fence generation, an ID absent from both live
 * tables starts at generation 0, and a deleted fence permanently suppresses
 * resurrection. Any row/fence invariant violation fails before rows are built.
 */
export function resolveHistoricalSnapshotRows<
  TSnapshot extends { id: string; sync_generation?: PortFenceGenerationInput },
>(
  snapshotRows: readonly TSnapshot[],
  currentRemoteRows: readonly RemotePortGenerationRow[],
  currentFenceRows: readonly RemotePortFenceStateRow[],
): ResolvedSnapshotRows<TSnapshot> {
  const snapshotIds = uniqueIds(snapshotRows.map(row => row?.id), 'snapshot');
  const remoteIds = uniqueIds(currentRemoteRows.map(row => row?.id), 'remote');
  const fenceIds = uniqueIds(currentFenceRows.map(row => row?.port_id), 'fence');

  const remoteById = new Map(currentRemoteRows.map((row, index) => [
    remoteIds[index]!,
    portFenceGeneration(row?.sync_generation),
  ]));
  const fenceById = new Map(currentFenceRows.map((row, index) => {
    if (row?.state !== 'active' && row?.state !== 'deleted') {
      throw new Error(`PORT_SNAPSHOT_INVALID_FENCE_STATE:${fenceIds[index]}`);
    }
    return [fenceIds[index]!, {
      state: row.state,
      generation: portFenceGeneration(row.generation),
    }] as const;
  }));

  // Validate the supplied remote snapshot as one coherent state before using
  // any of it. In particular, an active fence without its row is not evidence
  // that an old snapshot may safely recreate the row.
  for (const [id, generation] of remoteById) {
    const fence = fenceById.get(id);
    if (!fence) throw new Error(`PORT_SNAPSHOT_REMOTE_ROW_WITHOUT_FENCE:${id}`);
    if (fence.state !== 'active') {
      throw new Error(`PORT_SNAPSHOT_DELETED_FENCE_WITH_REMOTE_ROW:${id}`);
    }
    if (fence.generation !== generation) {
      throw new Error(`PORT_SNAPSHOT_REMOTE_FENCE_GENERATION_MISMATCH:${id}`);
    }
  }
  for (const [id, fence] of fenceById) {
    if (fence.state === 'active' && !remoteById.has(id)) {
      throw new Error(`PORT_SNAPSHOT_ACTIVE_FENCE_WITHOUT_REMOTE_ROW:${id}`);
    }
  }

  const skippedDeletedIds: string[] = [];
  let rowsChanged = false;
  const rows = snapshotRows.flatMap((row, index): ResolvedSnapshotRow<TSnapshot>[] => {
    const id = snapshotIds[index]!;
    const fence = fenceById.get(id);
    if (fence?.state === 'deleted') {
      skippedDeletedIds.push(id);
      rowsChanged = true;
      return [];
    }

    const generation = fence?.generation ?? '0';
    const snapshotGeneration = row.sync_generation === undefined
      ? null
      : portFenceGeneration(row.sync_generation);
    if (snapshotGeneration === generation) {
      return [row as ResolvedSnapshotRow<TSnapshot>];
    }
    rowsChanged = true;
    return [{ ...row, sync_generation: generation } as ResolvedSnapshotRow<TSnapshot>];
  });

  return {
    rows: rowsChanged
      ? rows
      : snapshotRows as readonly ResolvedSnapshotRow<TSnapshot>[],
    skippedDeletedIds,
  };
}
