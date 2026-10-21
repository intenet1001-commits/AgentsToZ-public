export interface GithubRepositoryRoleRow {
  repository_url: string;
  owner_login: string | null;
  collaborators: string[] | null;
  updated_at: string | null;
}

export interface GithubRepositoryIdentity {
  repositoryUrl: string;
  ownerLogin: string;
  repositoryName: string;
}

function githubPath(value: string): string | null {
  const trimmed = value.trim();
  const scp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

export function githubRepositoryIdentity(value: string | null | undefined): GithubRepositoryIdentity | null {
  const path = value ? githubPath(value) : null;
  if (!path) return null;
  const [ownerLogin, repositoryName] = path.split('/');
  if (!ownerLogin || !repositoryName) return null;
  return {
    repositoryUrl: `https://github.com/${ownerLogin.toLowerCase()}/${repositoryName.toLowerCase()}`,
    ownerLogin,
    repositoryName,
  };
}

export function normalizeGithubCollaborators(value: string | readonly string[]): string[] {
  const parts = typeof value === 'string' ? value.split(/[\s,]+/) : value;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of parts) {
    const login = raw.trim().replace(/^@+/, '');
    if (!login || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function repositoryRolesFor(
  repositoryUrl: string | null | undefined,
  stored: GithubRepositoryRoleRow | null | undefined,
): { repositoryUrl: string; ownerLogin: string; repositoryName: string; collaborators: string[]; updatedAt: string | null } | null {
  const identity = githubRepositoryIdentity(repositoryUrl);
  if (!identity) return null;
  return {
    ...identity,
    ownerLogin: stored?.owner_login?.trim().replace(/^@+/, '') || identity.ownerLogin,
    collaborators: normalizeGithubCollaborators(stored?.collaborators ?? []),
    updatedAt: stored?.updated_at ?? null,
  };
}
