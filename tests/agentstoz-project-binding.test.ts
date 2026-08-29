import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyAgentsToZProjectBinding } from "../src/agentstozProjectDispatch";

function git(root: string, ...args: string[]) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

describe("AgentsToZ project worker binding", () => {
  test("accepts one canonical initialized project with matching Git identity", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-binding-"));
    mkdirSync(join(root, ".agent-memory"), { recursive: true });
    writeFileSync(join(root, ".agent-memory/config.json"), JSON.stringify({ memoryId: "memory-1" }));
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "https://github.com/example/project.git");

    expect(verifyAgentsToZProjectBinding({
      canonicalPath: root,
      memoryId: "memory-1",
      gitRemote: "https://github.com/example/project.git",
    })).toEqual({ ok: true, canonicalPath: root, memoryId: "memory-1", gitRemote: "https://github.com/example/project.git" });
  });

  test("accepts a local-only Git project when no remote identity is expected", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-binding-local-"));
    mkdirSync(join(root, ".agent-memory"), { recursive: true });
    writeFileSync(join(root, ".agent-memory/config.json"), JSON.stringify({ memoryId: "memory-local" }));
    git(root, "init", "-q");

    expect(verifyAgentsToZProjectBinding({
      canonicalPath: root,
      memoryId: "memory-local",
    })).toEqual({ ok: true, canonicalPath: root, memoryId: "memory-local", gitRemote: null });
  });

  test("fails closed on path, memory, Git root, and remote mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-binding-"));
    mkdirSync(join(root, ".agent-memory"), { recursive: true });
    writeFileSync(join(root, ".agent-memory/config.json"), JSON.stringify({ memoryId: "memory-1" }));
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "https://github.com/example/project.git");

    expect(verifyAgentsToZProjectBinding({ canonicalPath: root, memoryId: "wrong" }).ok).toBe(false);
    expect(verifyAgentsToZProjectBinding({ canonicalPath: root, memoryId: "memory-1", gitRemote: "https://github.com/other/project.git" }).ok).toBe(false);
    expect(verifyAgentsToZProjectBinding({ canonicalPath: join(root, "missing"), memoryId: "memory-1" }).ok).toBe(false);
  });
});
