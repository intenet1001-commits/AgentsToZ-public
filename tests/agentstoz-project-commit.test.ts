import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitApprovedAgentsToZProject } from "../src/agentstozProjectDispatch";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-commit-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "AgentsToZ test"]);
  writeFileSync(join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "--", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

test("unapproved project commit is rejected without changing HEAD", () => {
  const root = repo();
  const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(root, "change.txt"), "change\n");
  expect(commitApprovedAgentsToZProject({ canonicalPath: root, approved: false, message: "change", paths: ["change.txt"] })).toEqual({ ok: false, code: "APPROVAL_REQUIRED" });
  expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(before);
});

test("approved project commit stages only explicit paths and reads back SHA", () => {
  const root = repo();
  writeFileSync(join(root, "change.txt"), "change\n");
  writeFileSync(join(root, "untouched.txt"), "leave dirty\n");
  const result = commitApprovedAgentsToZProject({ canonicalPath: root, approved: true, message: "AgentsToZ verified change", paths: ["change.txt"] });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.commitSha).toBe(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toContain("?? untouched.txt");
  }
});
