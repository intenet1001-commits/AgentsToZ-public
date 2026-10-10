import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectMemoryPrivateGitHubNamespace,
  type ProjectMemoryPrivateGitHubArchiveResult,
} from "../src/projectMemoryPrivateGitHubArchive";
import {
  disableProjectMemoryPrivateGitHubArchive,
  enableProjectMemoryPrivateGitHubArchive,
  projectMemoryPrivateGitHubArchiveStatus,
  recordProjectMemoryPrivateGitHubArchiveResult,
} from "../src/projectMemoryPrivateGitHubArchiveSettings";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-private-archive-settings-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const appDataDir = join(root, "app-data");
  mkdirSync(projectRoot);
  return { projectRoot, appDataDir, memoryId: "memory-1" };
}

function archiveResult(overrides: Partial<ProjectMemoryPrivateGitHubArchiveResult> = {}): ProjectMemoryPrivateGitHubArchiveResult {
  return {
    success: true,
    status: "pushed",
    repository: "example/private-memory",
    repositoryId: "R_private_memory_1",
    memoryNamespace: projectMemoryPrivateGitHubNamespace("memory-1"),
    branch: "agentstoz-memory-v1",
    stagingPath: "/app-data/stage",
    commit: "abcdef1234567890",
    manifestHash: "1".repeat(64),
    attemptedPush: true,
    localMemoryChanged: false,
    supabaseChanged: false,
    ...overrides,
  };
}

describe("Private GitHub archive device opt-in settings", () => {
  test("enables only after a successful first push and can be disabled without deleting remote data", () => {
    const input = fixture();
    expect(projectMemoryPrivateGitHubArchiveStatus(input).enabled).toBe(false);

    const enabled = enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "git@github.com:example/private-memory.git",
      archiveResult: archiveResult(),
      now: "2026-08-28T00:00:00.000Z",
    });
    expect(enabled).toMatchObject({
      enabled: true,
      repositoryUrl: "https://github.com/example/private-memory.git",
      lastSuccessAt: "2026-08-28T00:00:00.000Z",
      lastCommit: "abcdef1234567890",
    });
    expect(disableProjectMemoryPrivateGitHubArchive({
      ...input,
      now: "2026-08-28T01:00:00.000Z",
    }).enabled).toBe(false);
  });

  test("records an automatic archive failure without erasing the last successful recovery point", () => {
    const input = fixture();
    enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory",
      archiveResult: archiveResult(),
      now: "2026-08-28T00:00:00.000Z",
    });
    const failed = recordProjectMemoryPrivateGitHubArchiveResult({
      ...input,
      result: archiveResult({
        success: false,
        status: "failed",
        commit: null,
        manifestHash: null,
        errorCode: "PUSH_FAILED",
        error: "temporary push failure",
      }),
      now: "2026-08-28T02:00:00.000Z",
    });
    expect(failed).toMatchObject({
      enabled: true,
      lastSuccessAt: "2026-08-28T00:00:00.000Z",
      lastCommit: "abcdef1234567890",
      lastErrorCode: "PUSH_FAILED",
      lastError: "temporary push failure",
    });
  });

  test("rejects a forged successful follow-up result for another memory or branch", () => {
    const input = fixture();
    enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory",
      archiveResult: archiveResult(),
    });
    expect(() => recordProjectMemoryPrivateGitHubArchiveResult({
      ...input,
      result: archiveResult({ memoryNamespace: projectMemoryPrivateGitHubNamespace("another-memory") }),
    })).toThrow(/활성 프로젝트 기억/);
    expect(() => recordProjectMemoryPrivateGitHubArchiveResult({
      ...input,
      result: archiveResult({ repositoryId: "R_recreated_repository" }),
    })).toThrow(/활성 프로젝트 기억/);
    expect(() => recordProjectMemoryPrivateGitHubArchiveResult({
      ...input,
      result: { ...archiveResult(), branch: "unexpected-branch" as "agentstoz-memory-v1" },
    })).toThrow(/활성 프로젝트 기억/);
  });

  test("does not transfer export authorization to a different memory at the same path", () => {
    const input = fixture();
    enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory",
      archiveResult: archiveResult(),
    });
    expect(projectMemoryPrivateGitHubArchiveStatus({ ...input, memoryId: "memory-reinitialized" }).enabled).toBe(false);
  });

  test("rejects credential-bearing repository URLs and a failed first archive", () => {
    const input = fixture();
    expect(() => enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://token@github.com/example/private-memory.git",
      archiveResult: archiveResult(),
    })).toThrow(/credential 없는/);
    expect(() => enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory.git",
      archiveResult: archiveResult({ success: false, status: "failed", commit: null }),
    })).toThrow(/첫 Private GitHub 보관 Push/);
    expect(() => enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory.git",
      archiveResult: archiveResult({ manifestHash: null }),
    })).toThrow(/첫 Private GitHub 보관 Push/);
    expect(() => enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory.git",
      archiveResult: archiveResult({ repositoryId: null }),
    })).toThrow(/첫 Private GitHub 보관 Push/);
  });

  test("keeps settings private and rejects file or directory symlink substitution", () => {
    const input = fixture();
    enableProjectMemoryPrivateGitHubArchive({
      ...input,
      repositoryUrl: "https://github.com/example/private-memory",
      archiveResult: archiveResult(),
    });
    const settingsDirectory = join(input.appDataDir, "project-memory-private-github");
    const settingsFile = join(settingsDirectory, "settings.json");
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).version).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(settingsDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    }
    if (!canCreateFileSymlinks) return;
    const victim = join(input.appDataDir, "victim.json");
    writeFileSync(victim, "do-not-touch");
    rmSync(settingsFile);
    symlinkSync(victim, settingsFile, "file");
    expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(() => projectMemoryPrivateGitHubArchiveStatus(input)).toThrow(/안전하지/);
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");

    const second = fixture();
    mkdirSync(second.appDataDir, { recursive: true });
    const outside = join(second.appDataDir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(second.appDataDir, "project-memory-private-github"), directorySymlinkType);
    expect(() => projectMemoryPrivateGitHubArchiveStatus(second)).toThrow(/안전한 실제 폴더/);
  });
});
