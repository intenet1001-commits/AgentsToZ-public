import { portFenceGeneration, type PortFenceGenerationInput } from './portDurableFence';
import { githubRepositoryUrlFields, githubRepositoryUrls } from './githubUrls';

const MAX_METADATA_ROWS = 10_000;
const STRING_FIELDS = ['name', 'commandPath', 'terminalCommand', 'folderPath', 'worktreeParentId',
  'deployUrl', 'manualPath', 'logFilePath', 'category', 'description', 'memo', 'memoUpdatedAt'] as const;
export const PORT_UPLOAD_FIELD_LABELS = {
  name: '프로젝트명', port: '포트', commandPath: '실행 파일', terminalCommand: '실행 명령', folderPath: '폴더',
  worktreeParentId: '워크트리 원본', deployUrl: '배포 주소', githubUrls: 'GitHub 저장소',
  manualPath: '매뉴얼', logFilePath: '로그 문서', favorite: '즐겨찾기', category: '카테고리', description: '메모', memo: '상세 메모',
} as const;
export type PortUploadMetadataField = keyof typeof PORT_UPLOAD_FIELD_LABELS;
const METADATA_FIELDS = Object.keys(PORT_UPLOAD_FIELD_LABELS) as PortUploadMetadataField[];
const DATABASE_FIELDS = {
  name: 'name', port: 'port', commandPath: 'command_path', terminalCommand: 'terminal_command', folderPath: 'folder_path',
  worktreeParentId: 'worktree_parent_id', deployUrl: 'deploy_url', githubUrls: 'github_urls', githubUrl: 'github_url',
  manualPath: 'manual_path', logFilePath: 'log_file_path', favorite: 'favorite', category: 'category', description: 'description',
  memo: 'memo', memoUpdatedAt: 'memo_updated_at',
} as const;
export const PORT_UPLOAD_METADATA_SELECT = ['id', 'sync_generation', ...Object.values(DATABASE_FIELDS)].join(',');

export interface PortUploadMetadataRow extends Partial<Record<typeof STRING_FIELDS[number], string | null>> {
  id: string;
  syncGeneration?: PortFenceGenerationInput;
  port?: number | null;
  favorite?: boolean | null;
  githubUrl?: string | null;
  githubUrls?: readonly string[] | null;
}

export interface PortUploadMetadataConflict {
  id: string;
  fields: PortUploadMetadataField[];
}

/** Exact remote projection shared by Pull comparison and manual Push preflight. */
export function portUploadMetadataFromRemote(raw: unknown): PortUploadMetadataRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PORT_AUTO_UPLOAD_METADATA_ROW_INVALID');
  const row = raw as Record<string, unknown>;
  const result: Record<string, unknown> = { id: row.id, syncGeneration: row.sync_generation ?? '0' };
  for (const [field, column] of Object.entries(DATABASE_FIELDS)) result[field] = row[column];
  // The comparison validates this untrusted projection before merging/displaying it.
  return result as unknown as PortUploadMetadataRow;
}

function fieldValue(row: PortUploadMetadataRow, field: PortUploadMetadataField): string | number | boolean | readonly string[] | undefined {
  if (field !== 'githubUrls') return row[field] ?? undefined;
  const urls = githubRepositoryUrls(row);
  // An explicit empty array/string is a known local clear, unlike a legacy
  // row that never had either repository field.
  return urls.length > 0 || Array.isArray(row.githubUrls) || row.githubUrl === '' ? urls : undefined;
}
function sameValue(field: PortUploadMetadataField, left: ReturnType<typeof fieldValue>, right: ReturnType<typeof fieldValue>): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  if (field === 'favorite') return (left ?? false) === (right ?? false);
  // Existing folder-only rows use 0. Keep it as an explicit local port clear,
  // while treating the portal's NULL representation as the same absent port.
  if (field === 'port') return (left ?? 0) === (right ?? 0);
  // The portal clears optional text to NULL while desktop editors use ''.
  // Those represent the same clear and must not create an unresolvable review.
  if (field !== 'name' && (left === '' && right === undefined || left === undefined && right === '')) return true;
  return left === right;
}

export function portUploadFieldDisplay(row: PortUploadMetadataRow, field: PortUploadMetadataField): string {
  const value = fieldValue(row, field);
  return value === undefined ? '' : Array.isArray(value) ? value.join('\n') : typeof value === 'boolean' ? value ? '켜짐' : '꺼짐' : String(value);
}

function checkedRows(rows: readonly PortUploadMetadataRow[]) {
  if (!Array.isArray(rows) || rows.length > MAX_METADATA_ROWS) {
    throw new Error('PORT_AUTO_UPLOAD_METADATA_ROWS_INVALID');
  }
  const result = new Map<string, { row: PortUploadMetadataRow; generation: bigint }>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 512
      || row.id.includes('\0') || result.has(row.id)
      || STRING_FIELDS.some(field => row[field] != null && typeof row[field] !== 'string')
      || (row.port != null && (!Number.isSafeInteger(row.port) || row.port < 0 || row.port > 65_535))
      || (row.favorite != null && typeof row.favorite !== 'boolean')
      || (row.githubUrl != null && typeof row.githubUrl !== 'string')
      || (row.githubUrls != null && (!Array.isArray(row.githubUrls) || row.githubUrls.length > 1_000
        || row.githubUrls.some((value: unknown) => typeof value !== 'string')))) {
      throw new Error('PORT_AUTO_UPLOAD_METADATA_ROW_INVALID');
    }
    const generation = BigInt(portFenceGeneration(
      row.syncGeneration === undefined ? '0' : row.syncGeneration,
    ));
    result.set(row.id, { row, generation });
  }
  return result;
}

/** Without a durable edit baseline, disagreement cannot authorize overwriting either copy. */
export function findPortUploadMetadataConflicts(
  localRows: readonly PortUploadMetadataRow[],
  remoteRows: readonly PortUploadMetadataRow[],
): PortUploadMetadataConflict[] {
  const local = checkedRows(localRows);
  const remote = checkedRows(remoteRows);
  const conflicts: PortUploadMetadataConflict[] = [];
  for (const [id, current] of local) {
    const incoming = remote.get(id);
    if (!incoming) continue;
    const fields = METADATA_FIELDS.filter(field => {
      const localValue = fieldValue(current.row, field);
      const remoteValue = fieldValue(incoming.row, field);
      // Missing local data adopts the remote value in mergePorts. A missing
      // remote value at the same legacy generation can be schema backfill;
      // at a newer generation it can instead represent an explicit clear.
      return localValue !== undefined && !sameValue(field, localValue, remoteValue)
        && (remoteValue !== undefined || incoming.generation > current.generation);
    });
    if (fields.length > 0) conflicts.push({ id, fields });
  }
  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

/** Preserve every known local upload value; missing values may adopt remote data.
 * A remote generation cannot authorize replaying different local bytes. The
 * caller also closes its upload gate and keeps both versions for review.
 */
export function mergePortUploadFields<T extends PortUploadMetadataRow>(local: T, remote: T): Partial<T> {
  const conflicts = findPortUploadMetadataConflicts([local], [remote]);
  const blocked = conflicts.length > 0;
  const patch: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS) {
    if (field === 'memo' || field === 'githubUrls') continue;
    patch[field] = blocked ? fieldValue(local, field) : fieldValue(local, field) ?? fieldValue(remote, field);
  }
  const urls = blocked ? fieldValue(local, 'githubUrls') : fieldValue(local, 'githubUrls') ?? fieldValue(remote, 'githubUrls');
  Object.assign(patch, githubRepositoryUrlFields(urls));
  if (Array.isArray(urls) && urls.length === 0) patch.githubUrls = [];
  const localGeneration = portFenceGeneration(local.syncGeneration ?? '0');
  const remoteGeneration = portFenceGeneration(remote.syncGeneration ?? localGeneration);
  // An older read/DB restore must never lower the local CAS authority. Keeping
  // the newer local receipt makes a stale server reject the subsequent write.
  patch.syncGeneration = blocked || BigInt(localGeneration) > BigInt(remoteGeneration)
    ? localGeneration : remoteGeneration;
  return patch as Partial<T>;
}
