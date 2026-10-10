export const PORT_DELETE_FENCE_RPC = 'portmgr_delete_ports_if_identity_matches';
export const PORT_DELETE_OR_TOMBSTONE_FENCE_RPC = 'portmgr_delete_or_tombstone_ports_if_identity_matches';
export const PORT_TOMBSTONE_ABSENT_FENCE_RPC = 'portmgr_tombstone_absent_ports';
export const PORT_RESTORE_FENCE_RPC = 'portmgr_restore_port_if_generation_matches';
export const PORT_SNAPSHOT_RESTORE_FENCE_RPC = 'portmgr_restore_ports_snapshot_if_preflight_matches';
export const PORT_UPSERT_FENCE_RPC = 'portmgr_upsert_ports_if_generation_matches';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORT_UPSERT_COLUMNS = new Set([
  'id', 'sync_generation', 'device_id', 'device_name', 'name', 'port',
  'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
  'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
  'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
  'created_at',
]);

export type PortFenceGenerationInput = string | number | bigint;

export interface PortFenceExpectedRow {
  id: string;
  device_id: string | null;
  name: string;
  sync_generation: PortFenceGenerationInput;
}

/** Mandatory base-generation CAS identity plus any optional port columns being patched. */
export type PortFenceUpsertRow = Readonly<Record<string, unknown>> & {
  id: string;
  device_id: string | null;
  name: string;
  sync_generation: PortFenceGenerationInput;
};

export interface PortFenceResult {
  id: string;
  /** Changed rows return base + 1; no-ops and new inserts return the current generation. */
  generation: string;
}

export interface PortSnapshotRestoreRow {
  /** Desired snapshot bytes. sync_generation is deliberately forbidden here. */
  row: Readonly<Record<string, unknown>> & {
    id: string;
    device_id: string | null;
    name: string;
  };
  /** null means the row was absent during the caller's read-only preflight. */
  expected_generation: PortFenceGenerationInput | null;
}

export interface PortSnapshotRestoreOperationIds {
  upsert: string;
  delete: string;
}

export interface PortSnapshotRestoreFenceRow {
  port_id: string;
  generation: PortFenceGenerationInput;
  state: 'active' | 'deleted';
  owner_device_id: string | null;
}

export interface FrozenPortSnapshotRestorePreflight {
  /** Frozen CAS authority for every snapshot ID; null proves preflight absence. */
  expectedGenerationById: ReadonlyMap<string, string | null>;
  /** Only rows observed on this device and absent from the snapshot may be removed. */
  exactExtraRows: readonly PortFenceExpectedRow[];
  /** Advisory only: the transactional wrapper remains the deletion authority. */
  deletedSnapshotIds: readonly string[];
}

export type PortSnapshotRestoreOutcome = 'restored' | 'deleted_extra' | 'skipped_deleted';

export interface PortSnapshotRestoreResult extends PortFenceResult {
  outcome: PortSnapshotRestoreOutcome;
}

export interface PortFenceRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export type PortDurableFenceFailure = 'unavailable' | 'rejected' | 'invalid-response';

export class PortDurableFenceError extends Error {
  readonly failure: PortDurableFenceFailure;
  readonly rpcName: string;
  readonly rpcError: unknown;
  /** True means the caller must reconcile/retry with the same operation UUID. */
  readonly mutationMayHaveCommitted: boolean;

  constructor(
    failure: PortDurableFenceFailure,
    rpcName: string,
    message: string,
    rpcError: unknown = null,
    mutationMayHaveCommitted = false,
  ) {
    super(message);
    this.name = 'PortDurableFenceError';
    this.failure = failure;
    this.rpcName = rpcName;
    this.rpcError = rpcError;
    this.mutationMayHaveCommitted = mutationMayHaveCommitted;
  }
}

function requiredText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`PORT_FENCE_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function operationId(value: unknown, field: string): string {
  const id = requiredText(value, field);
  if (!UUID_PATTERN.test(id)) throw new Error(`PORT_FENCE_INVALID_${field.toUpperCase()}`);
  return id.toLowerCase();
}

/** Canonicalize a PostgreSQL bigint without ever accepting an imprecise JS number. */
export function portFenceGeneration(value: unknown): string {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('PORT_FENCE_INVALID_GENERATION');
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error('PORT_FENCE_INVALID_GENERATION');
  }
  if (parsed < 0n || parsed > MAX_POSTGRES_BIGINT) {
    throw new Error('PORT_FENCE_INVALID_GENERATION');
  }
  return parsed.toString();
}

/**
 * Freeze the read-only snapshot-restore preflight without trusting historical
 * snapshot generations. The database wrapper rechecks this exact authority
 * under per-ID transaction locks; this helper rejects an incoherent read or a
 * cross-device owner before any local deletion marker is written.
 */
export function freezePortSnapshotRestorePreflight(
  deviceId: string | null,
  snapshotIds: readonly string[],
  currentRows: readonly PortFenceExpectedRow[],
  fenceRows: readonly PortSnapshotRestoreFenceRow[],
): FrozenPortSnapshotRestorePreflight {
  if (deviceId !== null && typeof deviceId !== 'string') {
    throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
  }

  const snapshotIdSet = new Set<string>();
  for (const value of snapshotIds) {
    const id = requiredText(value, 'snapshot_id');
    if (snapshotIdSet.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_SNAPSHOT_ID:${id}`);
    snapshotIdSet.add(id);
  }

  const currentById = new Map<string, PortFenceExpectedRow & { sync_generation: string }>();
  for (const value of currentRows) {
    const id = requiredText(value?.id, 'current_id');
    if (currentById.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_CURRENT_ID:${id}`);
    if (value.device_id !== deviceId) {
      throw new Error(`PORT_FENCE_SNAPSHOT_CURRENT_DEVICE_SCOPE_MISMATCH:${id}`);
    }
    currentById.set(id, {
      id,
      device_id: value.device_id,
      name: requiredText(value.name, 'current_name', true),
      sync_generation: portFenceGeneration(value.sync_generation),
    });
  }

  const knownIds = new Set([...snapshotIdSet, ...currentById.keys()]);
  const fenceById = new Map<string, {
    generation: string;
    state: 'active' | 'deleted';
  }>();
  for (const value of fenceRows) {
    const id = requiredText(value?.port_id, 'fence_id');
    if (!knownIds.has(id) || fenceById.has(id)) {
      throw new Error(`PORT_FENCE_SNAPSHOT_UNEXPECTED_OR_DUPLICATE_FENCE:${id}`);
    }
    if (value.state !== 'active' && value.state !== 'deleted') {
      throw new Error(`PORT_FENCE_SNAPSHOT_INVALID_FENCE_STATE:${id}`);
    }
    if (value.owner_device_id !== deviceId) {
      throw new Error(`PORT_FENCE_SNAPSHOT_OWNER_MISMATCH:${id}`);
    }
    fenceById.set(id, {
      generation: portFenceGeneration(value.generation),
      state: value.state,
    });
  }

  for (const [id, current] of currentById) {
    const fence = fenceById.get(id);
    if (!fence) throw new Error(`PORT_FENCE_SNAPSHOT_CURRENT_WITHOUT_FENCE:${id}`);
    if (fence.state !== 'active') {
      throw new Error(`PORT_FENCE_SNAPSHOT_DELETED_FENCE_WITH_CURRENT:${id}`);
    }
    if (fence.generation !== current.sync_generation) {
      throw new Error(`PORT_FENCE_SNAPSHOT_CURRENT_GENERATION_MISMATCH:${id}`);
    }
  }
  for (const [id, fence] of fenceById) {
    if (fence.state === 'active' && !currentById.has(id)) {
      throw new Error(`PORT_FENCE_SNAPSHOT_ACTIVE_FENCE_WITHOUT_CURRENT:${id}`);
    }
  }

  const expectedGenerationById = new Map<string, string | null>();
  const deletedSnapshotIds: string[] = [];
  for (const id of snapshotIds) {
    expectedGenerationById.set(id, currentById.get(id)?.sync_generation ?? null);
    if (fenceById.get(id)?.state === 'deleted') deletedSnapshotIds.push(id);
  }

  const exactExtraRows = [...currentById.values()]
    .filter(row => !snapshotIdSet.has(row.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    expectedGenerationById,
    exactExtraRows,
    deletedSnapshotIds: deletedSnapshotIds.sort((left, right) => left.localeCompare(right)),
  };
}

export function buildPortDeletionRpcArgs(
  expectedRows: readonly PortFenceExpectedRow[],
  deletionOperationId: string,
): Record<string, unknown> {
  if (expectedRows.length === 0) throw new Error('PORT_FENCE_DELETE_ROWS_REQUIRED');
  const seen = new Set<string>();
  const rows = expectedRows.map(row => {
    const id = requiredText(row.id, 'id');
    if (seen.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_ID:${id}`);
    seen.add(id);
    if (row.device_id !== null && typeof row.device_id !== 'string') {
      throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
    }
    return {
      id,
      device_id: row.device_id,
      name: requiredText(row.name, 'name', true),
      sync_generation: portFenceGeneration(row.sync_generation),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    p_expected_rows: rows,
    p_deletion_op_id: operationId(deletionOperationId, 'deletion_op_id'),
  };
}

export function buildPortUpsertRpcArgs(
  rows: readonly PortFenceUpsertRow[],
  upsertOperationId: string,
): Record<string, unknown> {
  if (rows.length === 0) throw new Error('PORT_FENCE_UPSERT_ROWS_REQUIRED');
  const seen = new Set<string>();
  const normalized = rows.map(row => {
    const id = requiredText(row.id, 'id');
    if (seen.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_ID:${id}`);
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(row, 'device_id')
      || (row.device_id !== null && typeof row.device_id !== 'string')) {
      throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
    }
    for (const column of Object.keys(row)) {
      if (!PORT_UPSERT_COLUMNS.has(column)) {
        throw new Error(`PORT_FENCE_UNKNOWN_UPSERT_COLUMN:${column}`);
      }
    }
    return {
      ...row,
      id,
      device_id: row.device_id,
      name: requiredText(row.name, 'name', true),
      sync_generation: portFenceGeneration(row.sync_generation),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    p_rows: normalized,
    p_upsert_op_id: operationId(upsertOperationId, 'upsert_op_id'),
  };
}

export function buildPortSnapshotRestoreRpcArgs(
  deviceId: string | null,
  restoreRows: readonly PortSnapshotRestoreRow[],
  exactExtraRows: readonly PortFenceExpectedRow[],
  operationIds: PortSnapshotRestoreOperationIds,
): Record<string, unknown> {
  if (deviceId !== null && typeof deviceId !== 'string') {
    throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
  }
  const upsertOperationId = operationId(operationIds.upsert, 'snapshot_upsert_op_id');
  const deleteOperationId = operationId(operationIds.delete, 'snapshot_delete_op_id');
  if (upsertOperationId === deleteOperationId) {
    throw new Error('PORT_FENCE_SNAPSHOT_OPERATION_IDS_NOT_DISTINCT');
  }

  const seen = new Set<string>();
  const normalizedRestoreRows = restoreRows.map(item => {
    if (!item || typeof item !== 'object' || !item.row || typeof item.row !== 'object') {
      throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RESTORE_ROW');
    }
    const row = item.row;
    const id = requiredText(row.id, 'id');
    if (seen.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_ID:${id}`);
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(row, 'device_id')
      || (row.device_id !== null && typeof row.device_id !== 'string')) {
      throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
    }
    if (row.device_id !== deviceId) throw new Error('PORT_FENCE_SNAPSHOT_DEVICE_SCOPE_MISMATCH');
    if (Object.prototype.hasOwnProperty.call(row, 'sync_generation')) {
      throw new Error('PORT_FENCE_SNAPSHOT_STORED_GENERATION_FORBIDDEN');
    }
    for (const column of Object.keys(row)) {
      if (!PORT_UPSERT_COLUMNS.has(column)) {
        throw new Error(`PORT_FENCE_UNKNOWN_SNAPSHOT_COLUMN:${column}`);
      }
    }
    return {
      row: {
        ...row,
        id,
        device_id: row.device_id,
        name: requiredText(row.name, 'name', true),
      },
      expected_generation: item.expected_generation === null
        ? null
        : portFenceGeneration(item.expected_generation),
    };
  }).sort((left, right) => left.row.id.localeCompare(right.row.id));

  const normalizedExtraRows = exactExtraRows.map(row => {
    const id = requiredText(row.id, 'id');
    if (seen.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_ID:${id}`);
    seen.add(id);
    if (row.device_id !== null && typeof row.device_id !== 'string') {
      throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
    }
    if (row.device_id !== deviceId) throw new Error('PORT_FENCE_SNAPSHOT_DEVICE_SCOPE_MISMATCH');
    return {
      id,
      device_id: row.device_id,
      name: requiredText(row.name, 'name', true),
      sync_generation: portFenceGeneration(row.sync_generation),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    p_device_id: deviceId,
    p_restore_rows: normalizedRestoreRows,
    p_exact_extra_rows: normalizedExtraRows,
    p_upsert_op_id: upsertOperationId,
    p_delete_op_id: deleteOperationId,
  };
}

export function buildPortRestoreRpcArgs(
  row: Readonly<Record<string, unknown>>,
  deletedGeneration: PortFenceGenerationInput,
  restoreOperationId: string,
): Record<string, unknown> {
  const id = requiredText(row.id, 'id');
  requiredText(row.name, 'name', true);
  if (!Object.prototype.hasOwnProperty.call(row, 'device_id')
    || (row.device_id !== null && typeof row.device_id !== 'string')) {
    throw new Error('PORT_FENCE_INVALID_DEVICE_ID');
  }
  for (const column of Object.keys(row)) {
    if (!PORT_UPSERT_COLUMNS.has(column)) {
      throw new Error(`PORT_FENCE_UNKNOWN_RESTORE_COLUMN:${column}`);
    }
  }
  const deleted = BigInt(portFenceGeneration(deletedGeneration));
  if (deleted === 0n) throw new Error('PORT_FENCE_INVALID_DELETED_GENERATION');
  const supplied = BigInt(portFenceGeneration(row.sync_generation));
  if (supplied + 1n !== deleted) {
    throw new Error('PORT_FENCE_RESTORE_SOURCE_GENERATION_MISMATCH');
  }

  return {
    p_row: { ...row, id, sync_generation: supplied.toString() },
    p_deleted_generation: deleted.toString(),
    p_restore_op_id: operationId(restoreOperationId, 'restore_op_id'),
  };
}

export function parsePortFenceResults(data: unknown): PortFenceResult[] {
  if (!Array.isArray(data)) throw new Error('PORT_FENCE_INVALID_RPC_RESULT');
  const seen = new Set<string>();
  return data.map(value => {
    if (!value || typeof value !== 'object') throw new Error('PORT_FENCE_INVALID_RPC_RESULT');
    const record = value as Record<string, unknown>;
    const id = requiredText(record.id, 'result_id');
    if (seen.has(id)) throw new Error(`PORT_FENCE_DUPLICATE_RESULT_ID:${id}`);
    seen.add(id);
    return { id, generation: portFenceGeneration(record.generation) };
  });
}

export function parsePortSnapshotRestoreResults(
  data: unknown,
  restoreIds: readonly string[],
  extraIds: readonly string[],
): PortSnapshotRestoreResult[] {
  if (!Array.isArray(data)) throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
  const restore = new Set(restoreIds);
  const extras = new Set(extraIds);
  const expected = new Set([...restore, ...extras]);
  if (expected.size !== restoreIds.length + extraIds.length) {
    throw new Error('PORT_FENCE_DUPLICATE_SNAPSHOT_RESULT_ID');
  }
  const seen = new Set<string>();
  const results = data.map(value => {
    if (!value || typeof value !== 'object') {
      throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
    }
    const record = value as Record<string, unknown>;
    const id = requiredText(record.id, 'result_id');
    if (seen.has(id) || !expected.has(id)) {
      throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
    }
    seen.add(id);
    const outcome = record.outcome as PortSnapshotRestoreOutcome;
    if (outcome !== 'restored' && outcome !== 'deleted_extra' && outcome !== 'skipped_deleted') {
      throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
    }
    if ((extras.has(id) && outcome !== 'deleted_extra')
      || (restore.has(id) && outcome === 'deleted_extra')) {
      throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
    }
    return {
      id,
      generation: portFenceGeneration(record.generation),
      outcome,
    };
  });
  if (seen.size !== expected.size) throw new Error('PORT_FENCE_INVALID_SNAPSHOT_RPC_RESULT');
  return results;
}

function rpcErrorText(error: unknown): string {
  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  } | null;
  return [value?.code, value?.message, value?.details, value?.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

/** Missing durable RPCs are a hard stop: deletion must never fall back to table DELETE. */
export function isPortDurableFenceRpcMissing(error: unknown, rpcName: string): boolean {
  const value = error as { code?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
  const text = rpcErrorText(error);
  if (!text.toLowerCase().includes(rpcName.toLowerCase())) return false;
  return code === 'PGRST202'
    || code === '42883'
    || /could not find (?:the )?function|function .* does not exist|schema cache/i.test(text);
}

function rpcFailure(error: unknown, rpcName: string): PortDurableFenceError {
  if (isPortDurableFenceRpcMissing(error, rpcName)) {
    return new PortDurableFenceError(
      'unavailable',
      rpcName,
      `PORT_DURABLE_FENCE_RPC_UNAVAILABLE:${rpcName}`,
      error,
    );
  }
  const value = error as { code?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code.trim() : '';
  const commitUnknown = !code
    || /fetch|network|timeout|timed out|abort|connection|gateway/i.test(rpcErrorText(error));
  return new PortDurableFenceError(
    'rejected',
    rpcName,
    `PORT_DURABLE_FENCE_RPC_REJECTED:${rpcName}:${rpcErrorText(error) || 'unknown error'}`,
    error,
    commitUnknown,
  );
}

function assertExactResults(
  rpcName: string,
  expectedIds: readonly string[],
  data: unknown,
): PortFenceResult[] {
  let results: PortFenceResult[];
  try {
    results = parsePortFenceResults(data);
  } catch (error) {
    throw new PortDurableFenceError(
      'invalid-response',
      rpcName,
      `PORT_DURABLE_FENCE_INVALID_RESPONSE:${rpcName}`,
      error,
      true,
    );
  }
  const expected = [...expectedIds].sort();
  const received = results.map(result => result.id).sort();
  if (expected.length !== received.length
    || expected.some((id, index) => id !== received[index])) {
    throw new PortDurableFenceError(
      'invalid-response',
      rpcName,
      `PORT_DURABLE_FENCE_INVALID_RESPONSE:${rpcName}`,
      data,
      true,
    );
  }
  return results;
}

async function invokeRpc(
  client: PortFenceRpcClient,
  rpcName: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  try {
    return await client.rpc(rpcName, args);
  } catch (error) {
    throw new PortDurableFenceError(
      'invalid-response',
      rpcName,
      `PORT_DURABLE_FENCE_COMMIT_UNKNOWN:${rpcName}`,
      error,
      true,
    );
  }
}

export async function upsertPortsWithDurableFence(
  client: PortFenceRpcClient,
  rows: readonly PortFenceUpsertRow[],
  upsertOperationId: string,
): Promise<PortFenceResult[]> {
  const args = buildPortUpsertRpcArgs(rows, upsertOperationId);
  const { data, error } = await invokeRpc(client, PORT_UPSERT_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_UPSERT_FENCE_RPC);
  return assertExactResults(PORT_UPSERT_FENCE_RPC, rows.map(row => row.id), data);
}

export async function deletePortsWithDurableFence(
  client: PortFenceRpcClient,
  expectedRows: readonly PortFenceExpectedRow[],
  deletionOperationId: string,
): Promise<PortFenceResult[]> {
  const args = buildPortDeletionRpcArgs(expectedRows, deletionOperationId);
  const { data, error } = await invokeRpc(client, PORT_DELETE_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_DELETE_FENCE_RPC);
  return assertExactResults(PORT_DELETE_FENCE_RPC, expectedRows.map(row => row.id), data);
}

/**
 * Atomically delete exact present rows and synthesize permanent tombstones for
 * exact absent IDs. The server validates the complete mixed batch before any
 * row or fence mutation, so callers must never split or directly retry it.
 */
export async function deleteOrTombstonePortsWithDurableFence(
  client: PortFenceRpcClient,
  expectedRows: readonly PortFenceExpectedRow[],
  deletionOperationId: string,
): Promise<PortFenceResult[]> {
  const args = buildPortDeletionRpcArgs(expectedRows, deletionOperationId);
  const { data, error } = await invokeRpc(client, PORT_DELETE_OR_TOMBSTONE_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_DELETE_OR_TOMBSTONE_FENCE_RPC);
  return assertExactResults(
    PORT_DELETE_OR_TOMBSTONE_FENCE_RPC,
    expectedRows.map(row => row.id),
    data,
  );
}

/**
 * Permanently fence IDs already proven absent. This is deliberately separate
 * from physical deletion so an unexpected present row makes the whole RPC fail.
 */
export async function tombstoneAbsentPortsWithDurableFence(
  client: PortFenceRpcClient,
  expectedRows: readonly PortFenceExpectedRow[],
  deletionOperationId: string,
): Promise<PortFenceResult[]> {
  const args = buildPortDeletionRpcArgs(expectedRows, deletionOperationId);
  const { data, error } = await invokeRpc(client, PORT_TOMBSTONE_ABSENT_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_TOMBSTONE_ABSENT_FENCE_RPC);
  return assertExactResults(
    PORT_TOMBSTONE_ABSENT_FENCE_RPC,
    expectedRows.map(row => row.id),
    data,
  );
}

export async function restorePortWithDurableFence(
  client: PortFenceRpcClient,
  row: Readonly<Record<string, unknown>>,
  deletedGeneration: PortFenceGenerationInput,
  restoreOperationId: string,
): Promise<PortFenceResult> {
  const args = buildPortRestoreRpcArgs(row, deletedGeneration, restoreOperationId);
  const { data, error } = await invokeRpc(client, PORT_RESTORE_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_RESTORE_FENCE_RPC);
  const [result] = assertExactResults(PORT_RESTORE_FENCE_RPC, [String(row.id)], data);
  if (!result) {
    throw new PortDurableFenceError(
      'invalid-response',
      PORT_RESTORE_FENCE_RPC,
      `PORT_DURABLE_FENCE_INVALID_RESPONSE:${PORT_RESTORE_FENCE_RPC}`,
      data,
      true,
    );
  }
  return result;
}

/**
 * Restore the visible snapshot rows and delete only exact preflight extras in
 * one database transaction. A commit-unknown retry must reuse the same frozen
 * request and both child operation UUIDs; there is intentionally no direct-DML
 * or split-RPC fallback.
 */
export async function restorePortsSnapshotWithDurableFence(
  client: PortFenceRpcClient,
  deviceId: string | null,
  restoreRows: readonly PortSnapshotRestoreRow[],
  exactExtraRows: readonly PortFenceExpectedRow[],
  operationIds: PortSnapshotRestoreOperationIds,
): Promise<PortSnapshotRestoreResult[]> {
  const args = buildPortSnapshotRestoreRpcArgs(
    deviceId,
    restoreRows,
    exactExtraRows,
    operationIds,
  );
  const { data, error } = await invokeRpc(client, PORT_SNAPSHOT_RESTORE_FENCE_RPC, args);
  if (error) throw rpcFailure(error, PORT_SNAPSHOT_RESTORE_FENCE_RPC);
  try {
    return parsePortSnapshotRestoreResults(
      data,
      restoreRows.map(item => item.row.id),
      exactExtraRows.map(row => row.id),
    );
  } catch (parseError) {
    throw new PortDurableFenceError(
      'invalid-response',
      PORT_SNAPSHOT_RESTORE_FENCE_RPC,
      `PORT_DURABLE_FENCE_INVALID_RESPONSE:${PORT_SNAPSHOT_RESTORE_FENCE_RPC}`,
      parseError,
      true,
    );
  }
}
