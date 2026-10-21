/**
 * The OPS operating folder was created as `AgentsToZ-Control`; it is now `AgentsToZ-OPS`.
 * GitHub renamed the repository in place (same node id, the old URL redirects).
 *
 * Both names identify the same OPS folder forever. Another Mac may not have migrated
 * yet, Supabase registration rows and memory revisions keep the name they were written
 * with, and an older app version still creates or restores the legacy name. Every
 * identity or detection site therefore asks `isOpsFolderName`, never one literal.
 *
 * Keep this module dependency-free with erasable syntax only: projectRole.ts (and through
 * it ports-merge.ts) is imported natively by the Node smoke runners.
 */
export const OPS_FOLDER_NAME = 'AgentsToZ-OPS';
export const LEGACY_OPS_FOLDER_NAMES: readonly string[] = ['AgentsToZ-Control'];
export const OPS_GITHUB_REPOSITORY_NAME = 'AgentsToZ-OPS';
export const LEGACY_OPS_GITHUB_REPOSITORY_NAMES: readonly string[] = ['AgentsToZ-Control'];
/** New control centers write the new rule file; an existing clone keeps its legacy file as is. */
export const OPS_RULE_FILE = '.agents/rules/agentstoz-ops.md';
export const LEGACY_OPS_RULE_FILES: readonly string[] = ['.agents/rules/agentstoz-control.md'];

const folded = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
const OPS_NAMES = new Set([OPS_FOLDER_NAME, ...LEGACY_OPS_FOLDER_NAMES].map(folded));
const LEGACY_NAMES = new Set(LEGACY_OPS_FOLDER_NAMES.map(folded));
const LEGACY_REPOSITORIES = new Set(LEGACY_OPS_GITHUB_REPOSITORY_NAMES.map(folded));

/** Either OPS folder name, ignoring surrounding space and case. A display label such as «AgentsToZ OPS» is not a folder name. */
export function isOpsFolderName(value: unknown): boolean {
  const key = folded(value);
  return key !== '' && OPS_NAMES.has(key);
}

export function isLegacyOpsFolderName(value: unknown): boolean {
  const key = folded(value);
  return key !== '' && LEGACY_NAMES.has(key);
}

export function isLegacyOpsGitHubRepositoryName(value: unknown): boolean {
  const key = folded(value);
  return key !== '' && LEGACY_REPOSITORIES.has(key);
}

/** Last path segment of a POSIX or Windows path, ignoring trailing separators. */
export function opsFolderLeaf(folderPath: unknown): string {
  if (typeof folderPath !== 'string') return '';
  return folderPath.trim().replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
}

/**
 * `value` moved with its folder: each alias is [old folder, new folder]. A path is rebased only
 * when it IS the old folder or lies inside it (`…/AgentsToZ-Control-backup` is not inside);
 * otherwise null, so unrelated paths are never rewritten.
 */
export function rebasePath(value: unknown, aliases: ReadonlyArray<readonly [string, string]>): string | null {
  if (typeof value !== 'string') return null;
  for (const [rawFrom, rawTo] of aliases) {
    const from = rawFrom.replace(/[/\\]+$/, ''), to = rawTo.replace(/[/\\]+$/, '');
    if (!from || !to) continue;
    if (value === from) return to;
    if (value.startsWith(`${from}/`) || value.startsWith(`${from}\\`)) return to + value.slice(from.length);
  }
  return null;
}

/** A github.com remote split as [prefix incl. owner, repository, `.git`, trailing slash]. */
const GITHUB_REMOTE = /^((?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[^@/\s:]+@github\.com:)[A-Za-z0-9_.-]+\/)([A-Za-z0-9_.-]+?)(\.git)?(\/?)$/i;

/**
 * The same GitHub remote with the legacy repository segment renamed, keeping its scheme,
 * user, port and `.git` suffix (an SSH clone stays SSH). Null when the remote is not a
 * legacy OPS repository on github.com, so nothing else is ever rewritten.
 */
export function renamedOpsGitHubRemote(remoteUrl: unknown): string | null {
  if (typeof remoteUrl !== 'string') return null;
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (!match || !isLegacyOpsGitHubRepositoryName(match[2])) return null;
  return `${match[1]}${OPS_GITHUB_REPOSITORY_NAME}${match[3] ?? ''}${match[4] ?? ''}`;
}

/**
 * The inverse: a remote of the new OPS repository on github.com under each legacy name, same owner and
 * form. Empty for any other remote. The memory registry may know an OPS lineage only by one of these.
 */
export function legacyOpsGitHubRemotes(remoteUrl: unknown): string[] {
  if (typeof remoteUrl !== 'string') return [];
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (!match || folded(match[2]) !== folded(OPS_GITHUB_REPOSITORY_NAME)) return [];
  return LEGACY_OPS_GITHUB_REPOSITORY_NAMES.map(name => `${match[1]}${name}${match[3] ?? ''}${match[4] ?? ''}`);
}
