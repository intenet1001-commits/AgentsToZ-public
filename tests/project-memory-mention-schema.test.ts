import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROJECT_MEMORY_MENTION_SQL, PORTMGR_TABLES, migrationSqlForAllowedEmails } from "../src/schemaSql";

const migration = readFileSync(new URL("../supabase/migrations/20260825010000_project_memory_mentions.sql", import.meta.url), "utf8");

test("shared mention aliases have a dedicated cross-device schema and atomic rename RPC", () => {
  expect(PORTMGR_TABLES).toContain("portmgr_project_memory_mentions");
  for (const sql of [PROJECT_MEMORY_MENTION_SQL, migration]) {
    expect(sql).toContain("create table if not exists public.portmgr_project_memory_mentions");
    expect(sql).toContain("primary key (alias)");
    expect(sql).toContain("one_primary_per_memory");
    expect(sql).toContain("portmgr_save_project_memory_mention");
    expect(sql).toContain("status = 'redirect'");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("portmgr_project_memory_mentions_read");
    expect(sql).toContain("portmgr_is_member");
    expect(sql).toContain("revoke all");
  }
  expect(PROJECT_MEMORY_MENTION_SQL).not.toContain("portmgr_project_memory_aliases");
  const canonicalSetup = migrationSqlForAllowedEmails(["owner@example.com"]);
  expect(canonicalSetup).toContain("create table if not exists public.portmgr_project_memory_mentions");
  expect(canonicalSetup).toContain("portmgr_save_project_memory_mention");
});
