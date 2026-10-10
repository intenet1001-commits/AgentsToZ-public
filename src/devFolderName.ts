/**
 * This app's own development checkout was created as `portmanagement`; it is now
 * `AgentsToZ_byCS`. GitHub renamed the repository in place, so the old URL
 * redirects and an existing clone keeps the old folder and remote until someone
 * moves it by hand.
 *
 * Both names identify the same development repository forever — exactly the
 * situation `opsFolderName.ts` already documents for the OPS folder. Before this
 * module, `projectRole.ts` and `primaryProject.ts` each compared against the
 * single literal `'AgentsToZ_byCS'`, so a checkout still sitting in
 * `portmanagement/` (measured on a real machine: folder `portmanagement`, origin
 * `AgentsToZ_byCS`) was classified `관리 프로젝트` and the sidebar reported
 * `AgentsToZ DEV · 0`. With no UI that writes an explicit `role`, there was no
 * way to get the DEV role at all.
 *
 * ⚠️ The folder is only one signal. A clone can be put in a directory named
 * anything, so the registered GitHub repository name is checked too.
 *
 * Keep this module dependency-free with erasable syntax only: `projectRole.ts`
 * (and through it `ports-merge.ts`) is imported natively by the Node smoke runners.
 */
export const DEV_FOLDER_NAME = 'AgentsToZ_byCS';
export const LEGACY_DEV_FOLDER_NAMES: readonly string[] = ['portmanagement'];
export const DEV_GITHUB_REPOSITORY_NAME = 'AgentsToZ_byCS';
export const LEGACY_DEV_GITHUB_REPOSITORY_NAMES: readonly string[] = ['portmanagement'];

const folded = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
const DEV_NAMES = new Set([DEV_FOLDER_NAME, ...LEGACY_DEV_FOLDER_NAMES].map(folded));
const CURRENT_NAME = folded(DEV_FOLDER_NAME);
const DEV_REPOSITORIES = new Set(
  [DEV_GITHUB_REPOSITORY_NAME, ...LEGACY_DEV_GITHUB_REPOSITORY_NAMES].map(folded),
);

/** Either development folder name, ignoring surrounding space and case. */
export function isDevFolderName(value: unknown): boolean {
  const key = folded(value);
  return key !== '' && DEV_NAMES.has(key);
}

/** The current name only. Used to prefer a migrated checkout when both are registered. */
export function isCurrentDevFolderName(value: unknown): boolean {
  return folded(value) === CURRENT_NAME;
}

/** `owner/repo` segment of a registered GitHub URL, under either repository name. */
export function isDevGitHubRepositoryName(value: unknown): boolean {
  const key = folded(value);
  return key !== '' && DEV_REPOSITORIES.has(key);
}

/**
 * Repository segment of a github.com URL, or '' when it is not one. Deliberately
 * tolerant of `.git`, a trailing slash and SSH form, because these values come
 * from whatever the user pasted into the project's GitHub field.
 */
export function devGitHubRepositorySegment(url: unknown): string {
  if (typeof url !== 'string') return '';
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[^@/\s:]+@github\.com:)[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(url.trim());
  return match?.[1] ?? '';
}

/** True when any registered GitHub URL names this app's development repository. */
export function isDevRepositoryUrl(url: unknown): boolean {
  return isDevGitHubRepositoryName(devGitHubRepositorySegment(url));
}
