export interface VerifiedOrcaBrowserPage {
  browserPageId: string;
  url: string;
}

export interface VerifiedOrcaManagedWorktree {
  path: string;
  branch: string;
}

function normalizeUrl(value: unknown): string {
  return String(value ?? '').trim().replace(/\/$/, '');
}

function normalizePath(value: unknown): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function verifyOrcaBrowserPage(
  createdResult: unknown,
  shownResult: unknown,
  expectedUrl: string,
): VerifiedOrcaBrowserPage | null {
  const created = createdResult as any;
  const shown = shownResult as any;
  const browserPageId = created?.browserPageId;
  const tab = shown?.tab ?? shown;
  if (typeof browserPageId !== 'string' || !browserPageId.trim()) return null;
  if (tab?.browserPageId !== browserPageId) return null;
  if (normalizeUrl(tab?.url) !== normalizeUrl(expectedUrl)) return null;
  return { browserPageId, url: String(tab.url) };
}

export function verifyOrcaManagedWorktree(
  createdResult: unknown,
  listedResult: unknown,
): VerifiedOrcaManagedWorktree | null {
  const created = createdResult as any;
  const listed = listedResult as any;
  const worktree = created?.worktree;
  const path = typeof worktree?.path === 'string' ? worktree.path : '';
  if (!path) return null;
  const items: any[] = Array.isArray(listed?.worktrees) ? listed.worktrees : [];
  if (!items.some((entry) => normalizePath(entry?.path) === normalizePath(path))) return null;
  const branch = typeof worktree?.branch === 'string'
    ? worktree.branch.replace(/^refs\/heads\//, '')
    : '';
  return { path, branch };
}
