import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PROJECT_MEMORY_LEDGER_SCALE_SQL,
  PROJECT_MEMORY_MIGRATION_SQL,
  PROJECT_MEMORY_TABLES,
} from "../src/schemaSql";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260828010000_project_memory_ledger_scale.sql",
  import.meta.url,
), "utf8");
const recoveryMigration = readFileSync(new URL(
  "../supabase/migrations/20260828020000_project_memory_ledger_cursor_recovery.sql",
  import.meta.url,
), "utf8");

function compact(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s+\(/g, "(")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*(\|\||<>|>=|<=|:=|!~|::|=|>|<)\s*/g, "$1")
    .trim()
    .toLowerCase();
}

function functionDefinition(sql: string, name: string): string {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name.toLowerCase()}`);
  if (start < 0) throw new Error(`missing SQL function ${name}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`unterminated SQL function ${name}`);
  return compact(sql.slice(start, end + 3).replace(/--[^\n]*/g, ""));
}

describe("project-memory decades-scale SQL contracts", () => {
  test("keeps canonical repair SQL and the versioned migration function contracts identical", () => {
    for (const name of [
      "portmgr_project_memory_feedback_lineage_id",
      "portmgr_record_project_memory_ledger_change",
      "portmgr_copy_project_memory_ledgers",
      "portmgr_copy_project_memory_ledgers_on_merge",
      "portmgr_lock_project_memory_merge_ledgers",
      "portmgr_project_memory_ledger_delta",
      "portmgr_project_memory_ledger_cursor_status",
      "portmgr_list_project_memory_head_page",
    ]) {
      expect(functionDefinition(PROJECT_MEMORY_MIGRATION_SQL, name)).toBe(functionDefinition(migration, name));
    }
    expect(functionDefinition(PROJECT_MEMORY_MIGRATION_SQL, "portmgr_project_memory_ledger_cursor_status"))
      .toBe(functionDefinition(recoveryMigration, "portmgr_project_memory_ledger_cursor_status"));
    for (const name of [
      "portmgr_project_memory_feedback_lineage_id",
      "portmgr_record_project_memory_ledger_change",
      "portmgr_copy_project_memory_ledgers",
      "portmgr_project_memory_ledger_delta",
    ]) {
      expect(functionDefinition(PROJECT_MEMORY_MIGRATION_SQL, name))
        .toBe(functionDefinition(recoveryMigration, name));
    }
    expect(compact(recoveryMigration)).toContain(
      "grant execute on function public.portmgr_project_memory_ledger_cursor_status(text,text,text,text) to authenticated,service_role",
    );
  });

  test("uses an append-only server-ingestion identity for both immutable ledgers", () => {
    for (const source of [PROJECT_MEMORY_LEDGER_SCALE_SQL, migration]) {
      const sql = compact(source);
      expect(sql).toContain("create table if not exists public.portmgr_project_memory_ledger_changes");
      expect(sql).toContain("sync_seq bigint generated always as identity primary key");
      expect(sql).toContain("unique(layer,row_id)");
      expect(sql).toContain("on public.portmgr_project_memory_ledger_changes(memory_id,sync_seq)");
      expect(sql).toMatch(/create trigger portmgr_record_project_memory_journal_change after insert on public\.portmgr_project_memory_journal/);
      expect(sql).toMatch(/create trigger portmgr_record_project_memory_feedback_change after insert on public\.portmgr_project_memory_feedback/);
      expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('portmgr-project-memory-ledger:'||new.memory_id,0))");
      expect(sql).toContain("on conflict(layer,row_id) do nothing");
      expect(sql).toMatch(/v_canonical_memory_id\s*:=\s*public\.portmgr_resolve_project_memory_id\(new\.memory_id\)/);
      expect(sql).toContain("v_canonical_memory_id||':'||new.entry_hash");
      expect(sql).toContain("public.portmgr_project_memory_feedback_lineage_id(v_canonical_memory_id,coalesce(new.origin_event_id,new.id))");
      expect(sql).toMatch(/create trigger portmgr_lock_project_memory_merge_ledgers before insert on public\.portmgr_project_memory_merges/);
      expect(sql).toContain("from unnest(new.source_memory_ids||array[new.target_memory_id]) candidate");
      expect(sql).toContain("order by candidate");
      expect(sql).toContain("select 'journal',j.memory_id,j.id");
      expect(sql).toContain("select 'feedback',f.memory_id,f.id");
      expect(sql).toContain("'origin_event_id',feedback.origin_event_id");
      expect(sql).not.toMatch(/(?:delete|update)\s+(?:from\s+)?public\.portmgr_project_memory_(?:journal|feedback)/);
    }
    expect(PROJECT_MEMORY_TABLES).toContain("portmgr_project_memory_ledger_changes");
    expect(PROJECT_MEMORY_MIGRATION_SQL.indexOf("create table if not exists portmgr_project_memory_ledger_changes"))
      .toBeLessThan(PROJECT_MEMORY_MIGRATION_SQL.indexOf("portmgr_project_memory_ledger_changes',"));
  });

  test("keeps one feedback origin across chained merges and late alias forwarding", () => {
    for (const source of [PROJECT_MEMORY_MIGRATION_SQL, migration, recoveryMigration]) {
      const sql = compact(source);
      expect(sql).toContain("add column if not exists origin_event_id text");
      expect(sql).toContain("create or replace function public.portmgr_project_memory_feedback_lineage_id(p_target_memory_id text,p_origin_event_id text)");
      expect(sql).toContain("p_target_memory_id||chr(10)||p_origin_event_id");
      expect(sql).toContain("coalesce(f.origin_event_id,f.id)");
      expect(sql).toContain("coalesce(new.origin_event_id,new.id)");
      expect(sql).toContain("coalesce(existing.origin_event_id,existing.id)=coalesce(f.origin_event_id,f.id)");
      expect(sql).toContain("coalesce(existing.origin_event_id,existing.id)=coalesce(new.origin_event_id,new.id)");
      expect(sql).not.toContain("p_target_memory_id||chr(10)||f.id");
      expect(sql).not.toContain("v_canonical_memory_id||chr(10)||new.id");
      expect(sql).toContain("revoke all on function public.portmgr_project_memory_feedback_lineage_id(text,text) from public,anon,authenticated");
      expect(sql).toContain("grant execute on function public.portmgr_project_memory_feedback_lineage_id(text,text) to service_role");
    }
  });

  test("exposes one bigint-safe strict cursor across journal and feedback", () => {
    for (const source of [PROJECT_MEMORY_LEDGER_SCALE_SQL, migration]) {
      const sql = compact(source);
      expect(sql).toContain("create or replace function public.portmgr_project_memory_ledger_delta(p_memory_id text,p_after_seq text default '0',p_limit integer default 1000)");
      expect(sql).toContain("returns table(seq text,layer text,row_id text,payload jsonb)");
      expect(sql).toContain("language plpgsql stable security invoker set search_path=public");
      expect(sql).toContain("ledger_change.sync_seq::text");
      expect(sql).toContain("ledger_change.sync_seq>v_after_seq");
      expect(sql).toContain("order by ledger_change.sync_seq asc");
      expect(sql).toContain("least(greatest(coalesce(p_limit,1000),1),1000)");
      expect(sql).toContain("project_memory_ledger_cursor_invalid");
      for (const key of [
        "'memory_id'", "'entry_hash'", "'recorded_at'", "'agent'",
        "'head_commit'", "'summary'", "'body'", "'id'", "'entry_key'",
        "'kind'", "'evidence'", "'device_id'",
      ]) expect(sql).toContain(key);
      expect(sql).toContain("revoke all on function public.portmgr_project_memory_ledger_delta(text,text,integer) from public,anon");
      expect(sql).toContain("grant execute on function public.portmgr_project_memory_ledger_delta(text,text,integer) to authenticated,service_role");
      expect(sql).toContain("create or replace function public.portmgr_project_memory_ledger_cursor_status(p_memory_id text,p_cursor text,p_layer text,p_row_id text)");
      expect(sql).toContain("returns table(cursor_valid boolean,max_seq text)");
      expect(sql).toContain("ledger_change.sync_seq=v_cursor");
      expect(sql).toContain("ledger_change.layer=p_layer and ledger_change.row_id=p_row_id");
      expect(sql).toContain("select max(ledger_change.sync_seq)");
      expect(sql).toContain("revoke all on function public.portmgr_project_memory_ledger_cursor_status(text,text,text,text) from public,anon");
      expect(sql).toContain("grant execute on function public.portmgr_project_memory_ledger_cursor_status(text,text,text,text) to authenticated,service_role");
    }
  });

  test("repairs heads and pages one metadata-only row per memory with keyset ordering", () => {
    for (const source of [PROJECT_MEMORY_LEDGER_SCALE_SQL, migration]) {
      const sql = compact(source);
      expect(sql).toContain("select distinct on(r.memory_id) r.memory_id,r.id");
      expect(sql).toContain("order by r.memory_id,r.created_at desc nulls last,r.id desc");
      expect(sql).toContain("on conflict(memory_id) do update");
      expect(sql).toContain("head.head_revision_id is distinct from excluded.head_revision_id");
      expect(sql).toMatch(/update public\.portmgr_project_memory_heads head set head_revision_id\s*=\s*null/);
      expect(sql).toContain("create or replace function public.portmgr_list_project_memory_head_page(p_after_memory_id text default null,p_limit integer default 100)");
      expect(sql).toContain("returns table(id text,memory_id text,project_name text,github_url text,device_id text,device_name text,content_hash text,created_at timestamptz)");
      expect(sql).toContain("language sql stable security invoker set search_path=public");
      expect(sql).toContain("left join lateral");
      expect(sql).toContain("head.memory_id>p_after_memory_id");
      expect(sql).toContain("order by head.memory_id asc");
      expect(sql).toContain("least(greatest(coalesce(p_limit,100),1),500)");
      expect(sql).toContain("revoke all on function public.portmgr_list_project_memory_head_page(text,integer) from public,anon");
      expect(sql).toContain("grant execute on function public.portmgr_list_project_memory_head_page(text,integer) to authenticated,service_role");

      const rpc = sql.slice(
        sql.indexOf("create or replace function public.portmgr_list_project_memory_head_page"),
        sql.indexOf("alter table public.portmgr_project_memory_ledger_changes enable row level security"),
      );
      expect(rpc).not.toContain("content text");
      expect(rpc).not.toContain("selected_head.content,");
    }
  });

  test("is safe to replay and does not reopen mutation privileges", () => {
    for (const source of [PROJECT_MEMORY_LEDGER_SCALE_SQL, migration]) {
      const sql = compact(source);
      expect(sql).toContain("create table if not exists");
      expect(sql).toContain("create index if not exists");
      expect(sql).toContain("create or replace function");
      expect(sql).toContain("drop trigger if exists");
      expect(sql).toContain("drop policy if exists");
      expect(sql).toContain("alter table public.portmgr_project_memory_ledger_changes enable row level security");
      expect(sql).toContain("revoke all privileges on table public.portmgr_project_memory_ledger_changes from public,anon,authenticated,service_role");
      expect(sql).toContain("grant select on table public.portmgr_project_memory_ledger_changes to authenticated,service_role");
      expect(sql).not.toMatch(/grant (?:insert|update|delete)[^;]*portmgr_project_memory_ledger_changes/);
    }
  });
});
