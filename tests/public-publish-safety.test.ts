import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { githubRepositoryFromRemote, publicationTargetError } from "../src/publicRepositoryRemote";

const publishSource = readFileSync(new URL("../scripts/publish.ts", import.meta.url), "utf8");

describe("public snapshot publication safety", () => {
  test.each([
    ["https://github.com/example/public.git", "example/public"],
    ["git@github.com:example/public.git", "example/public"],
    ["ssh://git@github.com/example/public.git", "example/public"],
  ])("normalizes a safe GitHub remote without putting it in argv", (remote, expected) => {
    expect(githubRepositoryFromRemote(remote)).toBe(expected);
  });

  test.each([
    "https://token@github.com/example/public.git",
    "https://github.com/example/public.git?token=secret",
    "https://github.com/example/public.git#credential",
    "https://example.com/example/public.git",
  ])("rejects credential-bearing or non-GitHub remotes", remote => {
    expect(githubRepositoryFromRemote(remote)).toBeNull();
  });

  test("audits every fetch and push URL on each source remote", () => {
    expect(publishSource).toContain('["git", "remote", "get-url", "--all", remote]');
    expect(publishSource).toContain('["git", "remote", "get-url", "--push", "--all", remote]');
  });

  test("accepts only a distinct canonical public publication target", () => {
    const source = ["owner/private-source", "owner/internal-mirror"];
    expect(publicationTargetError("owner/private-source", source, {
      nameWithOwner: "owner/private-source",
      visibility: "PUBLIC",
    })).toBe("SOURCE_PUBLISH_REMOTE_MATCH");
    expect(publicationTargetError("owner/public", source, {
      nameWithOwner: "owner/other",
      visibility: "PUBLIC",
    })).toBe("PUBLISH_REPOSITORY_IDENTITY_MISMATCH");
    expect(publicationTargetError("owner/public", source, {
      nameWithOwner: "owner/public",
      visibility: "PRIVATE",
    })).toBe("PUBLISH_REPOSITORY_NOT_PUBLIC");
    expect(publicationTargetError("Owner/Public", source, {
      nameWithOwner: "owner/public",
      visibility: "PUBLIC",
    })).toBeNull();
  });

  test("requires GitHub write permission and a non-mutating push probe", () => {
    expect(publishSource).toContain("viewerPermission");
    expect(publishSource).toContain("--dry-run");
    expect(publishSource).toContain("WRITE");
  });

  test("replaces main only under an explicit captured remote lease", () => {
    expect(publishSource).toContain("ls-remote");
    expect(publishSource).toContain("--force-with-lease=refs/heads/main:");
    expect(publishSource).not.toMatch(/git push[^\n]*\s--force(?:\s|`)/);
  });

  test("validates the exact push URL instead of a separate fetch URL", () => {
    expect(publishSource).toContain('get-url", "--push", "--all", PUBLISH_REMOTE');
    expect(publishSource).toContain('PUBLISH_PUSH_URL_MISMATCH');
    expect(publishSource).toContain('pushRemoteUrls.length !== 1');
    expect(publishSource).toContain('pushRemoteUrls[0] !== publishRemoteUrl');
  });

  test("unwinds the orphan branch even when a safety gate aborts", () => {
    expect(publishSource).not.toContain("process.exit(");
    expect(publishSource).toContain("throw new PublishAbort");
    expect(publishSource).toContain("process.exitCode = 1");
    expect(publishSource).toContain("finally");
    expect(publishSource).toContain("await backToMain()");
  });

  test("never builds or pushes from a failed orphan checkout or commit", () => {
    expect(publishSource).toContain("checkoutResult.exitCode");
    expect(publishSource).toContain("commitResult.exitCode");
  });

  test("removes private-only material from the orphan index before committing", () => {
    expect(publishSource).toContain('PRIVATE_ONLY_PATHS');
    expect(publishSource).toContain('"CLAUDE.md",');
    expect(publishSource).toContain('".cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc"');
    expect(publishSource).toContain('"docs/superpowers/"');
    expect(publishSource).toContain('PROJECT_MEMORY.*_HANDOFF');
    expect(publishSource).not.toContain("PROJECT_MEMORY_V9_HANDOFF_2026-08-12");
    expect(publishSource).toContain("git rm --cached --ignore-unmatch");
    expect(publishSource).toContain('git ls-tree -rz --name-only');
    expect(publishSource).toContain('.filter(isPrivateOnlyPath)');
    expect(publishSource).toContain('filesResult.stdout.toString().split("\\0")');
    expect(publishSource).toContain("exclusionResult && exclusionResult.exitCode");
    expect(publishSource).toContain("trackedPrivatePaths");
    expect(publishSource).toContain("restoreResult.exitCode");
  });

  test("fails closed when a committed blob cannot be scanned", () => {
    expect(publishSource).toContain("contentResult.exitCode");
  });
});
