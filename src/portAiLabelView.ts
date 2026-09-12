import type { PortAiLabelExpected, PortAiLabelPatch, PortAiLabelPatchResult } from './portAiLabelPatch';
import type { PortRecord } from './ports-merge';

const fields = ['name', 'folderPath', 'aiName', 'category', 'description'] as const;

/** Capture full persisted values, never the truncated metadata sent to a model. */
export function portAiLabelExpected(row: { name: string; folderPath?: string; aiName?: string; category?: string; description?: string }): PortAiLabelExpected {
  return { name: row.name, folderPath: row.folderPath ?? null, aiName: row.aiName ?? null,
    category: row.category ?? null, description: row.description ?? null };
}

export function portAiLabelExpectedMatches(row: object, expected: PortAiLabelExpected): boolean {
  const record = row as Record<string, unknown>;
  return fields.every(field => (record[field] ?? null) === expected[field]);
}

/** A malformed receipt may follow a committed write. Never fall back to a full save. */
export function readPortAiLabelReceipt(value: unknown, patches: PortAiLabelPatch[]): PortAiLabelPatchResult {
  const fail = (): never => { throw new Error('이름 적용 결과를 확인하지 못했습니다. 프로젝트를 다시 불러와 확인해 주세요.'); };
  if (!value || typeof value !== 'object') return fail();
  const result = value as PortAiLabelPatchResult & { success?: boolean };
  if (result.success !== true || !Array.isArray(result.ports) || !Array.isArray(result.appliedIds)
    || !Array.isArray(result.unchangedIds) || !Array.isArray(result.skipped)) return fail();
  const expected = new Map(patches.map(patch => [patch.id, patch]));
  const ids = [...result.appliedIds, ...result.unchangedIds, ...result.skipped.map(item => item?.id)];
  if (ids.length !== patches.length || new Set(ids).size !== ids.length || ids.some(id => !expected.has(id))) return fail();
  if (result.skipped.some(item => !item || !['missing', 'changed'].includes(item.reason)
    || !Array.isArray(item.fields) || item.fields.some(field => !fields.includes(field)))) return fail();
  const rows = new Map<string, PortRecord>();
  for (const row of result.ports) {
    if (!row || typeof row.id !== 'string' || rows.has(row.id)) return fail();
    rows.set(row.id, row);
  }
  for (const id of [...result.appliedIds, ...result.unchangedIds]) {
    const row = rows.get(id);
    if (!row || Object.entries(expected.get(id)!.desired).some(([field, desired]) => (row as Record<string, unknown>)[field] !== desired)) return fail();
  }
  return result;
}

/** Refresh only acknowledged label fields while preserving every unrelated UI/baseline field. */
export function mergePortAiLabelReceipt<T extends PortRecord>(
  current: readonly T[], patches: PortAiLabelPatch[], result: PortAiLabelPatchResult,
): T[] {
  const accepted = new Set([...result.appliedIds, ...result.unchangedIds]);
  const byId = new Map(patches.map(patch => [patch.id, patch]));
  return current.map(row => {
    const patch = byId.get(row.id);
    return patch && accepted.has(row.id) && portAiLabelExpectedMatches(row, patch.expected)
      ? { ...row, ...patch.desired } : row;
  });
}

/** Carry a committed receipt through edits queued while the request was in
 * flight. Only labels still equal to their pre-request values are replaced;
 * row removal, folder changes and intentional label edits remain untouched. */
export function rebasePortAiLabelReceipt<T extends PortRecord>(
  current: readonly T[], patches: PortAiLabelPatch[], result: PortAiLabelPatchResult,
): T[] {
  const accepted = new Set([...result.appliedIds, ...result.unchangedIds]);
  const byId = new Map(patches.map(patch => [patch.id, patch]));
  return current.map(row => {
    const patch = byId.get(row.id);
    const record = row as Record<string, unknown>;
    if (!patch || !accepted.has(row.id) || (record.folderPath ?? null) !== patch.expected.folderPath) return row;
    const changes: Record<string, string> = {};
    for (const field of ['aiName', 'category'] as const) {
      const value = patch.desired[field];
      if (value !== undefined && (record[field] ?? null) === patch.expected[field] && record[field] !== value) changes[field] = value;
    }
    return Object.keys(changes).length ? { ...row, ...changes } : row;
  });
}
