const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function githubRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim();
  const scp = /^git@github\.com:([^/?#]+)\/([^/?#]+?)(?:\.git)?$/.exec(value);
  if (scp) {
    const owner = scp[1];
    const repository = scp[2];
    return owner && repository && SAFE_SEGMENT.test(owner) && SAFE_SEGMENT.test(repository)
      ? `${owner}/${repository}`
      : null;
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com" || url.password || url.search || url.hash) return null;
    if (url.username && !(url.protocol === "ssh:" && url.username === "git")) return null;
    if (!["https:", "ssh:", "git:"].includes(url.protocol)) return null;

    const [owner, rawRepository, ...extra] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !rawRepository || extra.length > 0) return null;
    const repository = rawRepository.replace(/\.git$/, "");
    return SAFE_SEGMENT.test(owner) && SAFE_SEGMENT.test(repository)
      ? `${owner}/${repository}`
      : null;
  } catch {
    return null;
  }
}

export interface GitHubPublicationTarget {
  nameWithOwner: string;
  visibility: string;
}

export function publicationTargetError(
  repository: string,
  sourceRepositories: readonly string[],
  target: GitHubPublicationTarget,
): string | null {
  const canonical = (value: string) => value.trim().toLowerCase();
  const expected = canonical(repository);
  if (sourceRepositories.some(source => canonical(source) === expected)) {
    return "SOURCE_PUBLISH_REMOTE_MATCH";
  }
  if (canonical(target.nameWithOwner) !== expected) {
    return "PUBLISH_REPOSITORY_IDENTITY_MISMATCH";
  }
  if (target.visibility.toUpperCase() !== "PUBLIC") {
    return "PUBLISH_REPOSITORY_NOT_PUBLIC";
  }
  return null;
}
