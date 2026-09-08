import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("project memory session synchronization order", () => {
  test("pulls the shared remote head before updating local memory", () => {
    const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
    const start = source.indexOf("export async function sessionEndProjectMemory");
    const end = source.indexOf("\n}", source.indexOf("backupError: error?.message", start)) + 2;
    const body = source.slice(start, end);

    expect(body.indexOf("await pullProjectMemory(input)")).toBeGreaterThan(-1);
    expect(body.indexOf("await pullProjectMemory(input)")).toBeLessThan(body.indexOf("await updateProjectMemory(input)"));
    expect(body).toContain("preflightConflict: true");
    expect(body).toContain("localSaved: false");
    expect(body).not.toContain("Pull 후 다시 시도하세요");
  });
});
