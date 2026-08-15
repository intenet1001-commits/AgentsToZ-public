import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProjectMemoryLocalVersion } from "../project-memory-server";
import { readFileSync } from "node:fs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function functionBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("project-memory local compare-and-swap guard", () => {
  test("rejects a stale write after the local memory changed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-local-cas-")));
    roots.push(root);
    const memoryPath = join(root, "CORE.md");
    const original = "# Project Core Memory\n\nOriginal.\n";
    writeFileSync(memoryPath, original);
    writeFileSync(memoryPath, "# Project Core Memory\n\nConcurrent edit.\n");

    expect(() => assertProjectMemoryLocalVersion(root, memoryPath, hash(original)))
      .toThrow(/동시에 변경/);
  });

  test("rechecks after the AI result and immediately before update writes", () => {
    const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
    const body = functionBody(source, "export async function updateProjectMemory", "\nfunction loadPortalConfig");
    const guard = body.indexOf("assertProjectMemoryLocalVersion(root, memoryPath, originalLocalHash)");
    expect(guard).toBeGreaterThan(body.indexOf("const nextBytes"));
    expect(guard).toBeLessThan(body.indexOf("backupMemory(root, memoryPath)"));
  });

  test("rechecks after a conflict-resolution remote CAS and before replacing local memory", () => {
    const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
    const body = functionBody(source, "export async function resolveProjectMemoryConflict", "\nexport async function sessionEndProjectMemory");
    const remoteCas = body.indexOf("const cas = await appendProjectMemoryRevisionCas(sb, revision)");
    const guard = body.indexOf(
      "assertProjectMemoryLocalVersion(root, local.memoryPath, localHash)",
      remoteCas,
    );
    const backup = body.indexOf("backupMemory(root, local.memoryPath)", remoteCas);
    expect(remoteCas).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(remoteCas);
    expect(guard).toBeLessThan(backup);
  });
});
