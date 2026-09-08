import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readAgentsToZProjectWorkerEvidence } from "../src/agentstozProjectDispatch";

function git(root: string, ...args: string[]) { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); }

test("worker evidence reads project memory and Git state after execution", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-evidence-"));
  mkdirSync(join(root, ".agent-memory"), { recursive: true });
  writeFileSync(join(root, ".agent-memory/config.json"), JSON.stringify({ memoryId: "memory-1" }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");

  const evidence = readAgentsToZProjectWorkerEvidence(root);
  expect(evidence.ok).toBe(true);
  if (evidence.ok) {
    expect(evidence.memoryId).toBe("memory-1");
    expect(evidence.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.gitDirty).toBe(false);
    expect(evidence.memoryConfigHash).toMatch(/^[0-9a-f]{64}$/);
  }
});
