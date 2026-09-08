export type WorktreePollingTab = "ports" | "runtime" | "terminal" | "portal" | "memory" | "what-i-said";

export function shouldRunRichWorktreePoll(
  activeTab: WorktreePollingTab,
  documentHidden: boolean,
  expandedCount: number,
): boolean {
  return activeTab === "ports" && !documentHidden && expandedCount > 0;
}

export function shouldApplyRichWorktreePollResult(
  activeTab: WorktreePollingTab,
  documentHidden: boolean,
  expandedIds: ReadonlySet<string>,
  projectId: string,
): boolean {
  return shouldRunRichWorktreePoll(activeTab, documentHidden, expandedIds.size)
    && expandedIds.has(projectId);
}

export interface ProjectFamilyRow {
  id: string;
  name?: string | null;
  folderPath?: string | null;
  worktreePath?: string | null;
  worktreeParentId?: string | null;
}

export interface LiveWorktreeEvidence {
  path: string;
  is_main?: boolean;
}

const present = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
};

/**
 * Returns a parent only when the row carries positive generated-worktree
 * evidence. An `_wt_` substring by itself is user-controlled data, not
 * provenance, and must never authorize local or remote deletion.
 */
export function generatedWorktreeParentId(
  rows: readonly ProjectFamilyRow[],
  row: ProjectFamilyRow,
): string | null {
  const worktreePath = present(row.worktreePath);
  const folderPath = present(row.folderPath);
  if (!worktreePath || folderPath !== worktreePath) return null;

  const explicitParent = present(row.worktreeParentId);
  if (explicitParent && explicitParent !== row.id
    && rows.some(candidate => candidate.id === explicitParent)) {
    return explicitParent;
  }

  const candidates = rows
    .filter(candidate => candidate.id !== row.id && row.id.startsWith(`${candidate.id}_wt_`))
    .sort((left, right) => right.id.length - left.id.length);
  return candidates[0]?.id ?? null;
}

/**
 * Resolve a generated row back to the stable top-level project. Malformed
 * provenance can contain a cycle, so stop at the first repeated ID instead of
 * looping or accidentally widening a destructive family operation.
 */
export function canonicalProjectFamilyRootId(
  rows: readonly ProjectFamilyRow[],
  row: ProjectFamilyRow,
): string {
  const byId = new Map(rows.map(candidate => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = row;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const parentId = generatedWorktreeParentId(rows, current);
    if (!parentId) return current.id;
    const parent = byId.get(parentId);
    if (!parent) return current.id;
    current = parent;
  }
  return row.id;
}

/**
 * Non-destructive surfaces may hide an orphaned generated card when its own
 * persisted provenance is still positive. Destructive family operations use
 * `generatedWorktreeParentId` instead, which additionally requires the parent
 * to remain present.
 */
export function isGeneratedWorktreeRow(
  rows: readonly ProjectFamilyRow[],
  row: ProjectFamilyRow,
): boolean {
  const worktreePath = present(row.worktreePath);
  const folderPath = present(row.folderPath);
  if (!worktreePath || folderPath !== worktreePath) return false;
  const explicitParent = present(row.worktreeParentId);
  if (explicitParent && explicitParent !== row.id) return true;
  return generatedWorktreeParentId(rows, row) !== null;
}

/**
 * Older local rows predate `worktreeParentId`. Backfill only after the live Git
 * family supplies the exact worktree path and the legacy row also carries the
 * historical parent-id/branch evidence. A manual row merely sharing the path
 * is never rewritten.
 */
export function canBackfillGeneratedWorktreeParent(input: {
  row: ProjectFamilyRow;
  parentId: string;
  worktreePath: string;
  branch?: string | null;
}): boolean {
  if (present(input.row.worktreeParentId)) return false;
  if (!input.row.id.startsWith(`${input.parentId}_wt_`)) return false;
  if (present(input.row.folderPath) !== present(input.worktreePath)) return false;
  const legacyWorktree = present(input.row.worktreePath);
  return legacyWorktree === present(input.worktreePath)
    || (!!present(input.branch) && legacyWorktree === present(input.branch));
}

const comparableWorktreePath = (value: string | null | undefined): string | null => {
  const normalized = present(value)?.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || null;
};

/**
 * Pre-column Supabase rows have no explicit parent marker. This returns only
 * strong candidates: historical ID shape, generated display-name shape, a
 * live parent row, and a folder path. It is a discovery aid, never deletion
 * authority by itself.
 */
export function legacyGeneratedWorktreeParentCandidates(
  rows: readonly ProjectFamilyRow[],
  row: ProjectFamilyRow,
): ProjectFamilyRow[] {
  if (present(row.worktreeParentId) || !present(row.folderPath) || !present(row.name)) return [];
  return rows.filter(parent => parent.id !== row.id
    && row.id.startsWith(`${parent.id}_wt_`)
    && !!present(parent.name)
    && row.name!.startsWith(`${parent.name} (`));
}

/**
 * Identifies a legacy generated remote child only while the exact folder is a
 * currently Git-listed non-main worktree of one unambiguous parent. Callers may
 * hide/skip that remote derivative, but must not use this inference to delete
 * the remote row.
 */
export function verifiedLegacyGeneratedWorktreeParentId(
  rows: readonly ProjectFamilyRow[],
  row: ProjectFamilyRow,
  worktreesByParent: Readonly<Record<string, readonly LiveWorktreeEvidence[]>>,
): string | null {
  const folderPath = comparableWorktreePath(row.folderPath);
  if (!folderPath) return null;
  const matches = legacyGeneratedWorktreeParentCandidates(rows, row).filter(parent =>
    (worktreesByParent[parent.id] ?? []).some(worktree =>
      worktree.is_main === false && comparableWorktreePath(worktree.path) === folderPath));
  return matches.length === 1 ? matches[0]!.id : null;
}

export function withoutVerifiedLegacyGeneratedRemoteRows<T extends ProjectFamilyRow>(input: {
  localRows: readonly ProjectFamilyRow[];
  remoteRows: readonly T[];
  worktreesByParent: Readonly<Record<string, readonly LiveWorktreeEvidence[]>>;
}): T[] {
  const allRows = [...input.localRows, ...input.remoteRows];
  return input.remoteRows.filter(row =>
    verifiedLegacyGeneratedWorktreeParentId(allRows, row, input.worktreesByParent) === null);
}

export function projectFamilyIdsForRemoval(
  rows: readonly ProjectFamilyRow[],
  parentId: string,
): string[] {
  const ids = [parentId];
  const included = new Set(ids);
  // Old versions could create a child whose parent was itself another
  // generated row. Traverse the whole proven descendant graph so cleanup does
  // not strand grandchildren in ports.json or Supabase.
  for (let cursor = 0; cursor < ids.length; cursor += 1) {
    const currentParentId = ids[cursor]!;
    for (const row of rows) {
      if (included.has(row.id)) continue;
      if (generatedWorktreeParentId(rows, row) !== currentParentId) continue;
      included.add(row.id);
      ids.push(row.id);
    }
  }
  return ids;
}

export function withoutProjectFamilyRows<T extends ProjectFamilyRow>(
  rows: readonly T[],
  parentId: string,
): T[] {
  const removed = new Set(projectFamilyIdsForRemoval(rows, parentId));
  return rows.filter(row => !removed.has(row.id));
}
