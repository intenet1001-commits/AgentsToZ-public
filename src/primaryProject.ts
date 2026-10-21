import { githubRepositoryUrls, normalizeGitHubRepositoryUrl } from './githubUrls';
import { folderLeafName } from './projectFolderRenamePrompt';
import { isCurrentDevFolderName, isDevFolderName, isDevRepositoryUrl } from './devFolderName';

interface PrimaryProjectCandidate {
  role?: unknown;
  worktreeParentId?: string;
  worktreePath?: string;
  folderPath?: string;
  githubUrl?: string;
  githubUrls?: string[];
}

/** A public validation clone must not displace the registered development root. */
export function resolvePrimaryProject<T extends PrimaryProjectCandidate>(
  projects: readonly T[],
  publicRepositoryUrl: string,
): T | null {
  const roots = projects.filter(project => !project.worktreeParentId && !project.worktreePath);
  const explicit = roots.find(project => project.role === 'dev');
  if (explicit) return explicit;
  const legacy = roots.filter(project => project.role === undefined);
  // Both development folder names, newest first so a migrated checkout wins when an
  // old one is still registered. A single `'AgentsToZ_byCS'` literal here meant a
  // checkout in `portmanagement/` — the repository's own former name — produced no
  // primary project at all, which is what left `devProjectId` undefined and the
  // sidebar reporting `AgentsToZ DEV · 0` (see devFolderName.ts).
  const byFolder = legacy.filter(project => project.folderPath && isDevFolderName(folderLeafName(project.folderPath)));
  const development = byFolder.find(project => isCurrentDevFolderName(folderLeafName(project.folderPath!)))
    ?? byFolder[0];
  if (development) return development;
  // A clone can be placed in a directory named anything, so the registered
  // repository is checked before falling back to the public validation clone.
  const byRepository = legacy.find(project => githubRepositoryUrls(project).some(url => isDevRepositoryUrl(url)));
  if (byRepository) return byRepository;
  const repository = normalizeGitHubRepositoryUrl(publicRepositoryUrl);
  if (!repository) return null;
  return legacy.find(project => githubRepositoryUrls(project).some(url => (
    normalizeGitHubRepositoryUrl(url) === repository
  ))) ?? null;
}
