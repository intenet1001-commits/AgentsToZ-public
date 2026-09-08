export type GitHubRepositoryVisibility = "private" | "public";

/**
 * GitHub repository names are limited to ASCII letters, digits, `.`, `-`, and `_`.
 * Keep a readable ASCII portion when one exists; otherwise use the stable local
 * project id so a Korean-only project still gets a valid, predictable name.
 */
export function githubRepositoryNameFromProject(input: {
  projectName?: unknown;
  folderName?: unknown;
  projectId: string;
}): string {
  const source = [input.folderName, input.projectName]
    .find(value => typeof value === "string" && value.trim()) as string | undefined;
  const ascii = (source ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100);
  if (ascii) return ascii;
  const suffix = input.projectId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase();
  return `project-${suffix || "local"}`.slice(0, 100);
}

export function githubRepositoryCreateArgs(input: {
  repositoryName: string;
  folderPath: string;
  visibility: GitHubRepositoryVisibility;
}): string[] {
  return [
    "repo",
    "create",
    input.repositoryName,
    `--${input.visibility}`,
    "--source",
    input.folderPath,
    "--remote",
    "origin",
    "--push",
  ];
}
