/**
 * Older Supabase projects can be missing optional `portmgr_ports` columns.
 * Retry after removing only the unavailable group, and keep retrying because
 * PostgREST generally reports one missing column per request.
 */
const OPTIONAL_PORT_COLUMN_GROUPS = [
  ['manual_path', 'log_file_path'],
  ['github_urls'],
  ['device_id', 'device_name'],
] as const;

type OptionalColumnError = { message?: string } | null;

export function missingOptionalPortColumns(
  error: OptionalColumnError,
  alreadyOmitted: ReadonlySet<string> = new Set(),
): string[] {
  const message = error?.message?.toLowerCase() ?? '';
  if (!message) return [];
  const columns: string[] = [];
  for (const group of OPTIONAL_PORT_COLUMN_GROUPS) {
    if (!group.some(column => message.includes(column))) continue;
    for (const column of group) {
      if (!alreadyOmitted.has(column)) columns.push(column);
    }
  }
  return columns;
}

export function omitPortColumns<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  columns: readonly string[],
): Row[] {
  if (columns.length === 0) return [...rows];
  return rows.map(row => {
    const copy: Record<string, unknown> = { ...row };
    for (const column of columns) delete copy[column];
    return copy as Row;
  });
}

export async function retryPortUpsertWithoutMissingOptionalColumns<
  Row extends Record<string, unknown>,
  ErrorType extends OptionalColumnError,
>(
  initialRows: readonly Row[],
  upsert: (rows: Row[]) => Promise<{ error: ErrorType }>,
): Promise<{ rows: Row[]; error: ErrorType; omittedColumns: string[] }> {
  let rows = [...initialRows];
  let { error } = await upsert(rows);
  const omitted = new Set<string>();

  while (error) {
    const columns = missingOptionalPortColumns(error, omitted);
    if (columns.length === 0) break;
    for (const column of columns) omitted.add(column);
    rows = omitPortColumns(rows, columns);
    ({ error } = await upsert(rows));
  }

  return { rows, error, omittedColumns: [...omitted] };
}
