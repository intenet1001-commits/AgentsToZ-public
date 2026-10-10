const HERMES_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface HermesProjectSessionCandidate {
  id: string;
  source: string | null | undefined;
  startedAt: number | null | undefined;
  lastActivityAt: number | null | undefined;
  cwd: string | null | undefined;
  gitRepoRoot: string | null | undefined;
  profileName: string | null | undefined;
  archived: boolean | number | null | undefined;
  hidden: boolean | number | null | undefined;
}

const normalizedWorkspacePath = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const sameWorkspacePath = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => {
  const a = normalizedWorkspacePath(left);
  const b = normalizedWorkspacePath(right);
  return !!a && a === b;
};

const isWorkspacePathOrDescendant = (
  candidate: string | null | undefined,
  workspaceRoot: string,
): boolean => {
  const path = normalizedWorkspacePath(candidate);
  const root = normalizedWorkspacePath(workspaceRoot);
  return !!path && !!root && (path === root || path.startsWith(`${root}/`));
};

const sessionActivity = (candidate: HermesProjectSessionCandidate): number => {
  const lastActivity = Number(candidate.lastActivityAt);
  if (Number.isFinite(lastActivity)) return lastActivity;
  const started = Number(candidate.startedAt);
  return Number.isFinite(started) ? started : Number.NEGATIVE_INFINITY;
};

/**
 * Select the newest visible Hermes Desktop conversation for one exact
 * workspace. Hermes itself keys Git projects by `git_repo_root`; sessions
 * without a Git root are keyed by their cwd (or a descendant cwd).
 *
 * The project-scoped launcher uses the default profile, so a session belonging
 * to another profile must not be sent to that window as if it were available.
 */
export function selectLatestHermesProjectSession(
  folderPath: string,
  candidates: readonly HermesProjectSessionCandidate[],
): HermesProjectSessionCandidate | null {
  let selected: HermesProjectSessionCandidate | null = null;
  for (const candidate of candidates) {
    if (!HERMES_SESSION_ID_RE.test(candidate.id)) continue;
    if (candidate.source !== 'desktop') continue;
    if (candidate.archived === true || Number(candidate.archived) === 1) continue;
    if (candidate.hidden === true || Number(candidate.hidden) === 1) continue;
    const profile = candidate.profileName?.trim() || 'default';
    if (profile !== 'default') continue;

    const matches = candidate.gitRepoRoot
      ? sameWorkspacePath(candidate.gitRepoRoot, folderPath)
      : isWorkspacePathOrDescendant(candidate.cwd, folderPath);
    if (!matches) continue;

    const activity = sessionActivity(candidate);
    const selectedActivity = selected ? sessionActivity(selected) : Number.NEGATIVE_INFINITY;
    if (!selected
      || activity > selectedActivity
      || (activity === selectedActivity && candidate.id > selected.id)) {
      selected = candidate;
    }
  }
  return selected;
}

/** Only a locally selected, syntax-checked ID is allowed into the URL. */
export function hermesSessionDeepLink(sessionId: string): string {
  if (!HERMES_SESSION_ID_RE.test(sessionId)) {
    throw new Error('Hermes session id is invalid');
  }
  return `hermes://open/${encodeURIComponent(sessionId)}`;
}
