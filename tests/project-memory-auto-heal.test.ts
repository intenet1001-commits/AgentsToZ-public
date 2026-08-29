import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLinkedSupabaseProject,
  projectMemoryAutoHealSql,
  withProjectMemorySchemaRepair,
} from "../project-memory-server";
import { PROJECT_MEMORY_MIGRATION_SQL } from "../src/schemaSql";

describe("project-memory schema auto-heal", () => {
  test("uses the canonical complete Project Memory migration", () => {
    expect(projectMemoryAutoHealSql()).toBe(PROJECT_MEMORY_MIGRATION_SQL);
    for (const table of [
      "portmgr_project_memory_revisions",
      "portmgr_project_memory_journal",
      "portmgr_project_memories",
      "portmgr_project_memory_heads",
      "portmgr_project_memory_feedback",
      "portmgr_project_memory_devices",
      "portmgr_project_memory_device_retirements",
    ]) {
      expect(PROJECT_MEMORY_MIGRATION_SQL).toContain(table);
    }
    for (const contract of [
      "portmgr_claim_project_memory",
      "portmgr_append_project_memory_revision",
      "portmgr_guard_project_memory_revision_insert",
      "PROJECT_MEMORY_STALE_PARENT",
      "portmgr_authenticated_read",
    ]) {
      expect(PROJECT_MEMORY_MIGRATION_SQL).toContain(contract);
    }
  });

  test("repairs a missing claim RPC once and retries the whole operation", async () => {
    let operations = 0;
    let repairs = 0;
    const result = await withProjectMemorySchemaRepair(
      async () => {
        operations += 1;
        if (operations === 1) {
          const error = new Error("Could not find the function public.portmgr_claim_project_memory in the schema cache");
          (error as Error & { code?: string }).code = "PROJECT_MEMORY_MIGRATION_REQUIRED";
          throw error;
        }
        return "recovered";
      },
      async () => {
        repairs += 1;
      },
    );

    expect(result).toBe("recovered");
    expect(operations).toBe(2);
    expect(repairs).toBe(1);
  });

  test("does not repair or retry unrelated failures", async () => {
    let operations = 0;
    let repairs = 0;
    await expect(withProjectMemorySchemaRepair(
      async () => {
        operations += 1;
        throw new Error("network timeout");
      },
      async () => {
        repairs += 1;
      },
    )).rejects.toThrow("network timeout");
    expect(operations).toBe(1);
    expect(repairs).toBe(0);
  });

  test("allows --linked repair only when its project ref matches the portal URL", () => {
    const workdir = mkdtempSync(join(tmpdir(), "memory-auto-heal-link-"));
    const expectedRef = ["abcdefghijkl", "mnopqrst"].join("");
    const otherRef = ["zzzzzzzzzz", "zzzzzzzzzz"].join("");
    try {
      mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(workdir, "supabase", ".temp", "project-ref"), `${expectedRef}\n`);

      expect(assertLinkedSupabaseProject(`https://${expectedRef}.supabase.co`, workdir))
        .toBe(expectedRef);
      expect(() => assertLinkedSupabaseProject(
        `https://${otherRef}.supabase.co`,
        workdir,
      )).toThrow(/다른 Supabase 프로젝트/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
