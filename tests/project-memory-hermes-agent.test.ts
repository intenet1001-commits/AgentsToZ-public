import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("Hermes is not silently routed through the Codex project-memory runner", () => {
  const server = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
  const api = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");
  const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");
  expect(server).toContain('export type ProjectMemoryAgent = "claude" | "codex";');
  expect(server).not.toContain('| "hermes"');
  expect(api).not.toContain('body.agent === "hermes"');
  expect(api).toContain('PROJECT_MEMORY_AGENT_UNSUPPORTED');
  expect(panel).not.toContain('<option value="hermes">Hermes</option>');
});
