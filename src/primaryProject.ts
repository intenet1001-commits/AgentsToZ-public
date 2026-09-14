import { githubRepositoryUrls, normalizeGitHubRepositoryUrl } from './githubUrls';
import { folderLeafName } from './projectFolderRenamePrompt';

interface PrimaryProjectCandidate {
  folderPath?: string;
  githubUrl?: string;
  githubUrls?: string[];
}

/** A public validation clone must not displace the registered development root. */
export function resolvePrimaryProject<T extends PrimaryProjectCandidate>(
  projects: readonly T[],
  publicRepositoryUrl: string,
): T | null {
  const development = projects.find(project => project.folderPath
    && folderLeafName(project.folderPath) === 'AgentsToZ_byCS');
  if (development) return development;
  const repository = normalizeGitHubRepositoryUrl(publicRepositoryUrl);
  if (!repository) return null;
  return projects.find(project => githubRepositoryUrls(project).some(url => (
    normalizeGitHubRepositoryUrl(url) === repository
  ))) ?? null;
}
