/**
 * GitHub repository URL helpers.
 *
 * `githubUrl` predates multi-repository support and remains the primary URL for
 * compatibility with older local data, Supabase schemas, and integrations.
 * `githubUrls` contains the complete ordered set, including that primary URL.
 */
export interface GitHubUrlSource {
  githubUrl?: string | null;
  githubUrls?: readonly string[] | null;
}

export interface GitHubUrlFields {
  githubUrl?: string;
  githubUrls?: string[];
}

export const normalizeGitHubRepositoryUrl = (remoteUrl: string): string | null => {
  const trimmed = remoteUrl.trim();
  const scpMatch = trimmed.match(/^git@github\.com:([^/]+\/.+)$/i);
  if (scpMatch) {
    const repoPath = scpMatch[1]!.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    return repoPath.split('/').length === 2 ? `https://github.com/${repoPath}` : null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return repoPath.split('/').length === 2 ? `https://github.com/${repoPath}` : null;
  } catch {
    return null;
  }
};

/** Accept one URL per line or comma-separated values, retaining non-empty legacy values. */
export const parseGitHubRepositoryUrls = (value: unknown): string[] => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // Normalize GitHub SSH/HTTPS remotes so link actions can open them, but do
    // not discard a legacy value merely because it is not parseable here.
    const url = normalizeGitHubRepositoryUrl(trimmed) ?? trimmed;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
};

/** Returns all URLs in primary-first order, transparently reading legacy records. */
export const githubRepositoryUrls = (source: GitHubUrlSource): string[] =>
  parseGitHubRepositoryUrls([
    ...(source.githubUrl == null ? [] : [source.githubUrl]),
    ...(source.githubUrls ?? []),
  ]);

export const primaryGitHubRepositoryUrl = (source: GitHubUrlSource): string | undefined =>
  githubRepositoryUrls(source)[0];

export const githubRepositoryUrlsText = (source: GitHubUrlSource): string =>
  githubRepositoryUrls(source).join('\n');

/** Keeps the old single field as a mirror of the first URL when saving new data. */
export const githubRepositoryUrlFields = (value: unknown): GitHubUrlFields => {
  const githubUrls = parseGitHubRepositoryUrls(value);
  return githubUrls.length > 0
    ? { githubUrl: githubUrls[0], githubUrls }
    : { githubUrl: undefined, githubUrls: undefined };
};

/** Append a detected remote without replacing URLs the user already entered. */
export const appendGitHubRepositoryUrl = (value: unknown, next: string): string =>
  parseGitHubRepositoryUrls([
    ...parseGitHubRepositoryUrls(value),
    next,
  ]).join('\n');
