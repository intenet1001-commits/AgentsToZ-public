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

  test("prepares an isolated index without switching branches, deleting refs or touching source files", () => {
    expect(publishSource).toContain('GIT_INDEX_FILE');
    expect(publishSource).toContain('git read-tree ${sourceSha}');
    expect(publishSource).toContain('git commit-tree');
    expect(publishSource).toContain('assertSourceUnchanged');
    expect(publishSource).toContain('GIT_OPTIONAL_LOCKS: "0"');
    expect(publishSource).toContain('refs/agentstoz/publication-candidates/');
    expect(publishSource).not.toContain('git checkout');
    expect(publishSource).not.toContain('git branch -D');
    expect(publishSource).toContain('readTreeResult.exitCode');
    expect(publishSource).toContain('commitResult.exitCode');
  });

  test("excludes private development records before committing and rejects unreviewed linked files", () => {
    expect(publishSource).toContain('PRIVATE_ONLY_PATHS');
    expect(publishSource).toContain('"CLAUDE.md",');
    expect(publishSource).toContain('"docs/design/"');
    expect(publishSource).toContain('"docs/handoffs/"');
    expect(publishSource).toContain('"release/"');
    expect(publishSource).toContain('PROJECT_MEMORY.*_HANDOFF');
    expect(publishSource).toContain('git update-index -z --index-info');
    expect(publishSource).toContain('.filter(isPrivateOnlyPath)');
    expect(publishSource).toContain('filesResult.stdout.toString().split("\\0")');
    expect(publishSource).toContain('exclusionResult.exitCode');
    expect(publishSource).toContain('symlink/submodule/file mode');
  });

  test("fails closed when a committed blob cannot be scanned", () => {
    expect(publishSource).toContain("contentResult.exitCode");
  });

  test("treats the maintainer's personal Vercel deployment as private-only metadata", () => {
    const privateProjectPrefix = ['portmanager', 'portal'].join('-');
    const privateHostname = `${privateProjectPrefix}.${['vercel', 'app'].join('.')}`;
    expect(publishSource).toContain("PRIVATE_DEPLOYMENT_PATTERNS");
    expect(publishSource).toContain('개인용 Vercel 배포 주소');
    expect(publishSource).toContain('publicationScanVariants');
    expect(publishSource).toContain('decodeURIComponent');
    expect(publishSource).not.toContain(privateProjectPrefix);
    expect(publishSource).not.toContain(privateHostname);
  });

  test("constructs and blocks the private source repository identity without publishing the literal", () => {
    const privateRepository = [
      ['intenet1001', 'commits'].join('-'),
      ['AgentsToZ', 'byCS'].join('_'),
    ].join('/');
    expect(publishSource).toContain('비공개 원본 GitHub 저장소 식별자');
    expect(publishSource).toContain('privateSourceOwner');
    expect(publishSource).toContain('privateSourceRepository');
    expect(publishSource).not.toContain(privateRepository);
  });

  test("derives private Supabase refs from ignored local configuration without logging or embedding them", () => {
    expect(publishSource).toContain("localPrivateSupabasePatterns");
    expect(publishSource).toContain("LOCAL_PRIVATE_ENV_FILES");
    expect(publishSource).toContain("PRIVATE_SUPABASE_ENV_KEYS");
    expect(publishSource).toContain("로컬 환경의 개인 Supabase project ref");
    expect(publishSource).toContain("실제 Supabase project URL");
    expect(publishSource).toContain("publicationScanVariants(input)");
  });
});
