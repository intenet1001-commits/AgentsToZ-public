import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectProjectGitSync, READ_ONLY_GIT_ENV } from "../project-memory-server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const indexHash = (root: string) => createHash("sha256").update(readFileSync(join(root, ".git", "index"))).digest("hex");

describe("read-only git probes", () => {
  test("declare optional locks off", () => {
    expect(READ_ONLY_GIT_ENV.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  test("a status probe never rewrites the index (no index.lock contention with the user's git)", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-readonly-git-"));
    roots.push(root);
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "file.txt"), "same\n");
    Bun.spawnSync(["git", "add", "file.txt"], { cwd: root, env });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: root, env });
    // Same content, new stat: a plain `git status` refreshes and rewrites the index.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(root, "file.txt"), later, later);
    const before = indexHash(root);

    const snapshot = inspectProjectGitSync(root);

    expect(snapshot?.dirty).toBe(false);
    expect(indexHash(root)).toBe(before);
  });
});
