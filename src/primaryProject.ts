import { githubRepositoryUrls, normalizeGitHubRepositoryUrl } from './githubUrls';
import { folderLeafName } from './projectFolderRenamePrompt';

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
  const development = legacy.find(project => project.folderPath
    && folderLeafName(project.folderPath) === 'AgentsToZ_byCS');
  if (development) return development;
  const repository = normalizeGitHubRepositoryUrl(publicRepositoryUrl);
  if (!repository) return null;
  return legacy.find(project => githubRepositoryUrls(project).some(url => (
    normalizeGitHubRepositoryUrl(url) === repository
  ))) ?? null;
}
