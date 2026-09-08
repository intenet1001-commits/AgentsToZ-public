import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MIGRATION_SQL,
  PORTMGR_TABLES,
  REMOTE_CONTROL_RELAY_SQL,
  REMOTE_CONTROL_RELAY_TABLES,
} from "../src/schemaSql";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260830030000_remote_control_relay.sql",
  import.meta.url,
), "utf8");
const ttlMigration = readFileSync(new URL(
  "../supabase/migrations/20260831010000_extend_remote_control_ttl.sql",
  import.meta.url,
), "utf8");
const monthSessionMigration = readFileSync(new URL(
  "../supabase/migrations/20260831020000_extend_remote_control_session_to_30_days.sql",
  import.meta.url,
), "utf8");
const renewHostMigration = readFileSync(new URL(
  "../supabase/migrations/20260901070000_renew_remote_control_host.sql",
  import.meta.url,
), "utf8");
const hostLastSeenMigration = readFileSync(new URL(
  "../supabase/migrations/20260901060000_expose_remote_control_host_last_seen.sql",
  import.meta.url,
), "utf8");
const sessionPairingMigration = readFileSync(new URL(
  "../supabase/migrations/20260901081000_expose_remote_control_session_pairing_id.sql",
  import.meta.url,
), "utf8");
const boundedPairingMigration = readFileSync(new URL(
  "../supabase/migrations/20260901082000_bound_remote_control_pairings.sql",
  import.meta.url,
), "utf8");
const monthPairingMigration = readFileSync(new URL(
  "../supabase/migrations/20260901010000_extend_remote_control_pairing_to_30_days.sql",
  import.meta.url,
), "utf8");

function compact(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+\(/g, "(")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*(->>|->|\|\||<>|>=|<=|:=|!~|::|=|>|<|\+|-|\*|\/|%)\s*/g, "$1")
    .trim()
    .toLowerCase();
}

function functionDefinition(sql: string, name: string): string {
  const start = sql.toLowerCase().indexOf(
    `create or replace function public.${name.toLowerCase()}`,
  );
  if (start < 0) throw new Error(`missing SQL function ${name}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`unterminated SQL function ${name}`);
  return compact(sql.slice(start, end + 3));
}

const HOST_RPCS = [
  ["portmgr_remote_control_register_host", "uuid,text,text,text,integer"],
  ["portmgr_remote_control_create_pairing", "uuid,text,text"],
  ["portmgr_remote_control_host_list_sessions", "uuid,text"],
  ["portmgr_remote_control_host_approve_session", "uuid,text,uuid"],
  ["portmgr_remote_control_host_revoke_session", "uuid,text,uuid"],
  ["portmgr_remote_control_disable_host", "uuid,text"],
  ["portmgr_remote_control_host_send_message", "uuid,text,uuid,uuid,uuid,text,timestamptz,text,text"],
  ["portmgr_remote_control_host_receive_messages", "uuid,text,text,integer"],
  ["portmgr_remote_control_host_ack_messages", "uuid,text,uuid,text"],
  ["portmgr_remote_control_cleanup", "integer"],
] as const;

const CONTROLLER_RPCS = [
  ["portmgr_remote_control_claim_pairing", "uuid,text,text,text"],
  ["portmgr_remote_control_session_status", "uuid,uuid"],
  ["portmgr_remote_control_revoke_session", "uuid,uuid"],
  ["portmgr_remote_control_owner_disable_host", "uuid"],
  ["portmgr_remote_control_controller_send_message", "uuid,uuid,uuid,uuid,text,timestamptz,text,text"],
  ["portmgr_remote_control_controller_receive_messages", "uuid,uuid,text,integer"],
  ["portmgr_remote_control_controller_ack_messages", "uuid,uuid,text"],
] as const;

const SECURITY_DEFINER_RPCS = [
  "portmgr_remote_control_authorize_host",
  "portmgr_remote_control_require_member_session",
  "portmgr_remote_control_store_message",
  ...HOST_RPCS.map(([name]) => name),
  ...CONTROLLER_RPCS.map(([name]) => name),
];

const BOUNDED_LIFECYCLE_FUNCTIONS = [
  "portmgr_remote_control_store_message",
  "portmgr_remote_control_renew_host",
  "portmgr_remote_control_create_pairing",
  "portmgr_remote_control_claim_pairing",
  "portmgr_remote_control_host_list_sessions",
  "portmgr_remote_control_host_approve_session",
  "portmgr_remote_control_host_revoke_session",
  "portmgr_remote_control_disable_host",
  "portmgr_remote_control_revoke_session",
  "portmgr_remote_control_owner_disable_host",
] as const;

describe("ephemeral Internet remote-control relay SQL", () => {
  test("keeps the deployed base immutable while the canonical SQL includes forward upgrades", () => {
    // This migration has already shipped. Editing it makes Supabase migration
    // history/checksums drift; all later behavior belongs in forward files.
    expect(createHash("sha256").update(migration).digest("hex"))
      .toBe("2607844fe83f901ee846a615a61e925d318021e427b8e10a32bde32636b2ce06");
    expect(migration).not.toBe(REMOTE_CONTROL_RELAY_SQL);
    for (const name of BOUNDED_LIFECYCLE_FUNCTIONS) {
      expect(functionDefinition(REMOTE_CONTROL_RELAY_SQL, name))
        .toBe(functionDefinition(boundedPairingMigration, name));
    }
  });

  test("integrates the relay into canonical setup without generic authenticated CRUD", () => {
    expect(MIGRATION_SQL).toContain(REMOTE_CONTROL_RELAY_SQL);
    expect(MIGRATION_SQL.indexOf(REMOTE_CONTROL_RELAY_SQL))
      .toBeGreaterThan(MIGRATION_SQL.indexOf("create table if not exists portmgr_ports"));
    for (const table of REMOTE_CONTROL_RELAY_TABLES) {
      expect(PORTMGR_TABLES).toContain(table);
      expect(MIGRATION_SQL).toContain(`public.${table}`);
      expect(MIGRATION_SQL).not.toContain(
        `create policy portmgr_authenticated_all on ${table}`,
      );
      expect(MIGRATION_SQL).not.toContain(
        `grant select, insert, update, delete on table ${table} to authenticated, service_role`,
      );
    }
    expect(MIGRATION_SQL).toContain(
      "alter table public.%I force row level security",
    );
    expect(MIGRATION_SQL).toContain(
      "revoke all privileges on table public.%I from public, anon, authenticated, service_role",
    );
  });

  test("defines and grants only the exact host/controller RPC signatures", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    for (const [name, args] of HOST_RPCS) {
      expect(sql).toContain(`create or replace function public.${name}(`);
      expect(sql).toContain(
        `revoke all on function public.${name}(${args}) from public,anon,authenticated,service_role`,
      );
      expect(sql).toContain(`grant execute on function public.${name}(${args}) to service_role`);
      expect(sql).not.toContain(`grant execute on function public.${name}(${args}) to authenticated`);
    }
    for (const [name, args] of CONTROLLER_RPCS) {
      expect(sql).toContain(`create or replace function public.${name}(`);
      expect(sql).toContain(
        `revoke all on function public.${name}(${args}) from public,anon,authenticated,service_role`,
      );
      expect(sql).toContain(`grant execute on function public.${name}(${args}) to authenticated`);
      expect(sql).not.toContain(`grant execute on function public.${name}(${args}) to service_role`);
    }
    expect(sql).not.toMatch(/grant execute on function [^;]+ to (?:public|anon)/);
  });

  test("uses fixed-search-path SECURITY DEFINER wrappers and private helpers", () => {
    for (const name of SECURITY_DEFINER_RPCS) {
      const fn = functionDefinition(REMOTE_CONTROL_RELAY_SQL, name);
      expect(fn).toContain("security definer");
      expect(fn).toContain("set search_path=pg_catalog,public,extensions,pg_temp");
    }
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    for (const signature of [
      "portmgr_remote_control_valid_public_key(text)",
      "portmgr_remote_control_public_key_fingerprint(text)",
      "portmgr_remote_control_base64url_decode(text)",
      "portmgr_remote_control_base64url_encode(bytea)",
      "portmgr_remote_control_authorize_host(uuid,text,boolean)",
      "portmgr_remote_control_require_member_session(uuid,uuid,boolean)",
      "portmgr_remote_control_store_message(uuid,uuid,uuid,text,uuid,text,timestamptz,text,text)",
    ]) {
      expect(sql).toContain(
        `revoke all on function public.${signature} from public,anon,authenticated,service_role`,
      );
      expect(sql).not.toContain(`grant execute on function public.${signature}`);
    }
  });

  test("forces RLS and denies direct access to every relay table and sequence", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    for (const table of ["hosts", "pairings", "sessions", "messages"]) {
      expect(sql).toContain(`'portmgr_remote_control_${table}'`);
    }
    expect(sql).toContain("alter table public.%i enable row level security");
    expect(sql).toContain("alter table public.%i force row level security");
    expect(sql).toContain(
      "revoke all privileges on table public.%i from public,anon,authenticated,service_role",
    );
    expect(sql).toContain(
      "revoke all privileges on sequence public.portmgr_remote_control_messages_relay_seq_seq from public,anon,authenticated,service_role",
    );
    expect(sql).not.toMatch(/grant (?:select|insert|update|delete|all)[^;]*portmgr_remote_control_/);
    expect(sql).not.toContain("create policy");
  });

  test("keeps host, one-use QR candidate, approved session, and rows ephemeral", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    // 호스트는 자기가 앵커하는 가장 긴 사슬보다 오래 살아야 한다 —
    // 마지막 날 claim 된 30일 QR + 하루 승인 대기 + 30일 승인 세션.
    expect(sql).toContain("expires_at<=created_at+interval '62 days'");
    // QR 자체는 승인된 세션과 같은 30일 (VOC 2026-09-01).
    expect(sql).toContain("expires_at<=created_at+interval '30 days'");
    expect(sql).toContain("v_expires_at:=least(now()+interval '30 days',v_host_expires_at)");
    // 승인 대기 창은 그대로 24시간이다 — 스캔만 되고 승인 안 된 세션이
    // 한 달을 떠 있으면 안 된다. 그래서 남은 '24 hours'는 정확히 이 한 곳이다.
    expect(sql.match(/expires_at<=created_at\+interval '24 hours'/g)).toHaveLength(1);
    expect(sql).toContain("v_session_expires_at:=least(now()+interval '24 hours',v_host.expires_at)");
    expect(sql).toContain("expires_at<=approved_at+interval '30 days'");
    expect(sql).toContain("secs=>least(greatest(coalesce(p_ttl_seconds,5356800),60),5356800)");
    expect(sql).toContain("h.expires_at>now()");
    expect(sql).toContain("s.expires_at>now()");
    expect(sql).toContain("delete from public.portmgr_remote_control_hosts h");
    expect(sql).toContain("delete from public.portmgr_remote_control_sessions s");
    expect(sql).not.toContain("keychain");
    expect(sql).not.toContain("credential");
    expect(sql).not.toContain("refresh_token");
  });

  test("upgrades an existing relay without changing the reviewed RPC security bodies", () => {
    const compactUpgrade = compact(ttlMigration);
    expect(compactUpgrade).toContain("portmgr_remote_control_hosts_ttl_check");
    expect(compactUpgrade).toContain("expires_at<=created_at+interval '62 days'");
    expect(compactUpgrade).toContain("expires_at<=created_at+interval '30 days'");
    // 남은 '24 hours'는 승인 대기 창 하나뿐이다 — QR 자체는 30일이 됐다.
    expect(compactUpgrade.match(/expires_at<=created_at\+interval '24 hours'/g)).toHaveLength(1);
    expect(compactUpgrade).toContain("expires_at<=approved_at+interval '30 days'");
    for (const name of [
      "portmgr_remote_control_register_host",
      "portmgr_remote_control_create_pairing",
      "portmgr_remote_control_claim_pairing",
      "portmgr_remote_control_host_approve_session",
      "portmgr_remote_control_cleanup",
    ]) {
      expect(functionDefinition(ttlMigration, name)).toBe(functionDefinition(migration, name));
    }
    expect(compactUpgrade).toContain(
      "grant execute on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text) to authenticated",
    );
    expect(compactUpgrade).not.toMatch(/grant execute on function [^;]+ to (?:public|anon)/);
  });

  test("ships an exact pairing-id session upgrade without widening caller roles", () => {
    const compactUpgrade = compact(sessionPairingMigration);
    const upgraded = functionDefinition(
      sessionPairingMigration,
      "portmgr_remote_control_host_list_sessions",
    );
    expect(compactUpgrade).toContain(
      "drop function if exists public.portmgr_remote_control_host_list_sessions(uuid,text)",
    );
    expect(upgraded).not.toBe(functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_host_list_sessions"));
    expect(functionDefinition(boundedPairingMigration, "portmgr_remote_control_host_list_sessions"))
      .toBe(functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_host_list_sessions"));
    expect(upgraded).toContain("returns table(session_id uuid,pairing_id uuid,controller_id uuid");
    expect(upgraded).toContain("select s.session_id,s.pairing_id,s.controller_id");
    expect(compactUpgrade).toContain(
      "grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text) to service_role",
    );
    expect(compactUpgrade).not.toMatch(/grant execute on function [^;]+ to (?:public|anon|authenticated)/);
    expect(compactUpgrade).toContain("set local lock_timeout='10s'");
    expect(compactUpgrade).toContain("set local statement_timeout='2min'");
  });

  test("bounds live sessions and unused QRs with one host lock and exact grants", () => {
    const compactUpgrade = compact(boundedPairingMigration);
    const createPairing = functionDefinition(
      boundedPairingMigration,
      "portmgr_remote_control_create_pairing",
    );
    const claimPairing = functionDefinition(
      boundedPairingMigration,
      "portmgr_remote_control_claim_pairing",
    );
    const approveSession = functionDefinition(
      boundedPairingMigration,
      "portmgr_remote_control_host_approve_session",
    );
    expect(compactUpgrade).toContain("set local lock_timeout='10s'");
    expect(compactUpgrade).toContain("set local statement_timeout='2min'");
    expect(createPairing).toBe(functionDefinition(
      REMOTE_CONTROL_RELAY_SQL,
      "portmgr_remote_control_create_pairing",
    ));
    expect(claimPairing).toBe(functionDefinition(
      REMOTE_CONTROL_RELAY_SQL,
      "portmgr_remote_control_claim_pairing",
    ));
    expect(approveSession).toBe(functionDefinition(
      REMOTE_CONTROL_RELAY_SQL,
      "portmgr_remote_control_host_approve_session",
    ));
    expect(createPairing).toContain("p.claimed_at is null and p.expires_at>now()");
    expect(createPairing).toContain("if v_outstanding_count>=8 then");
    expect(createPairing).not.toContain("remote_control_pairing_limit");
    expect(createPairing).toContain("retired_pairing_ids uuid[]");
    expect(createPairing).toContain("delete from public.portmgr_remote_control_pairings p using oldest");
    expect(createPairing).toContain("array_agg(deleted.pairing_id order by oldest.created_at,oldest.pairing_id)");
    for (const sql of [compact(REMOTE_CONTROL_RELAY_SQL), compactUpgrade]) {
      const drop = sql.indexOf(
        "drop function if exists public.portmgr_remote_control_create_pairing(uuid,text,text)",
      );
      const create = sql.indexOf(
        "create or replace function public.portmgr_remote_control_create_pairing(",
      );
      const finalRevoke = sql.indexOf(
        "revoke all on function public.portmgr_remote_control_create_pairing(uuid,text,text) from public,anon,authenticated,service_role",
        create,
      );
      expect(drop).toBeGreaterThan(-1);
      expect(create).toBeGreaterThan(drop);
      expect(finalRevoke).toBeGreaterThan(create);
      expect(sql.slice(0, drop)).not.toContain(
        "revoke all on function public.portmgr_remote_control_create_pairing(uuid,text,text)",
      );
    }
    expect(claimPairing).toContain("s.approval_state in('pending','approved')");
    expect(claimPairing).toContain("if v_active_session_count>=8 then");
    expect(claimPairing).toContain("remote_control_session_limit");
    // Claim discovers host id without a row lock, then serializes on the host,
    // revalidates/locks the pairing, and follows host -> session. This avoids
    // both create(pairing cleanup) and host_send(host -> session SHARE) cycles.
    const pairingDiscovery = claimPairing.indexOf("select p.host_id into v_discovered_host_id");
    const claimLock = claimPairing.indexOf("pg_advisory_xact_lock");
    const pairingSelect = claimPairing.indexOf("select p.*into v_pairing");
    const pairingRowLock = claimPairing.indexOf("for update", pairingSelect);
    const claimHostRowLock = claimPairing.indexOf("select h.*into v_host");
    const claimSessionRowLock = claimPairing.indexOf("select s.*into v_existing_session");
    expect(pairingDiscovery).toBeGreaterThan(-1);
    expect(claimLock).toBeGreaterThan(pairingDiscovery);
    expect(pairingSelect).toBeGreaterThan(-1);
    expect(pairingRowLock).toBeGreaterThan(pairingSelect);
    expect(pairingSelect).toBeGreaterThan(claimLock);
    expect(claimHostRowLock).toBeGreaterThan(pairingRowLock);
    expect(claimSessionRowLock).toBeGreaterThan(claimHostRowLock);
    const approveLock = approveSession.indexOf("pg_advisory_xact_lock");
    const approveSessionRowLock = approveSession.indexOf("select s.approval_state,s.auth_user_id");
    const approveHostRowLock = approveSession.indexOf("select h.owner_user_id into v_owner_user_id");
    expect(approveLock).toBeGreaterThan(-1);
    expect(approveHostRowLock).toBeGreaterThan(approveLock);
    expect(approveSessionRowLock).toBeGreaterThan(approveHostRowLock);
    for (const [signature, role] of [
      ["portmgr_remote_control_create_pairing(uuid,text,text)", "service_role"],
      ["portmgr_remote_control_claim_pairing(uuid,text,text,text)", "authenticated"],
      ["portmgr_remote_control_host_approve_session(uuid,text,uuid)", "service_role"],
      ["portmgr_remote_control_renew_host(uuid,text,integer)", "service_role"],
      ["portmgr_remote_control_host_list_sessions(uuid,text)", "service_role"],
      ["portmgr_remote_control_host_revoke_session(uuid,text,uuid)", "service_role"],
      ["portmgr_remote_control_disable_host(uuid,text)", "service_role"],
      ["portmgr_remote_control_revoke_session(uuid,uuid)", "authenticated"],
      ["portmgr_remote_control_owner_disable_host(uuid)", "authenticated"],
    ] as const) {
      const revoke = compactUpgrade.indexOf(
        `revoke all on function public.${signature} from public,anon,authenticated,service_role`,
      );
      const grant = compactUpgrade.indexOf(
        `grant execute on function public.${signature} to ${role}`,
      );
      expect(revoke).toBeGreaterThan(-1);
      expect(grant).toBeGreaterThan(revoke);
    }
    expect(compactUpgrade).not.toMatch(/grant execute on function [^;]+ to (?:public|anon)/);
  });

  test("uses one host lifecycle order and holds a session share lock through message insert", () => {
    const lifecycle = [
      ["portmgr_remote_control_renew_host", "portmgr_remote_control_authorize_host", "update public.portmgr_remote_control_hosts", null],
      ["portmgr_remote_control_create_pairing", "portmgr_remote_control_authorize_host", "perform 1 from public.portmgr_remote_control_hosts", "delete from public.portmgr_remote_control_pairings"],
      ["portmgr_remote_control_host_list_sessions", "portmgr_remote_control_authorize_host", "update public.portmgr_remote_control_hosts", "update public.portmgr_remote_control_sessions"],
      ["portmgr_remote_control_host_approve_session", "portmgr_remote_control_authorize_host", "select h.owner_user_id into v_owner_user_id", "select s.approval_state,s.auth_user_id"],
      ["portmgr_remote_control_host_revoke_session", "portmgr_remote_control_authorize_host", "perform 1 from public.portmgr_remote_control_hosts", "update public.portmgr_remote_control_sessions"],
      ["portmgr_remote_control_disable_host", "portmgr_remote_control_authorize_host", "update public.portmgr_remote_control_hosts", "update public.portmgr_remote_control_sessions"],
      ["portmgr_remote_control_revoke_session", "public.portmgr_is_member", "select h.owner_user_id into v_owner_user_id", "update public.portmgr_remote_control_sessions"],
      ["portmgr_remote_control_owner_disable_host", "public.portmgr_is_member", "update public.portmgr_remote_control_hosts", "update public.portmgr_remote_control_sessions"],
    ] as const;
    for (const [name, authorizationNeedle, hostNeedle, sessionNeedle] of lifecycle) {
      const fn = functionDefinition(REMOTE_CONTROL_RELAY_SQL, name);
      const lock = fn.indexOf("pg_advisory_xact_lock");
      const authorization = fn.indexOf(authorizationNeedle);
      const host = fn.indexOf(hostNeedle);
      expect(lock).toBeGreaterThan(-1);
      expect(authorization).toBeGreaterThan(lock);
      expect(host).toBeGreaterThan(authorization);
      if (sessionNeedle) expect(fn.indexOf(sessionNeedle)).toBeGreaterThan(host);
    }

    const store = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_store_message");
    const sessionRead = store.indexOf("select s.expires_at into v_session_expires_at");
    const share = store.indexOf("for share of s", sessionRead);
    const insert = store.indexOf("insert into public.portmgr_remote_control_messages");
    expect(sessionRead).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(sessionRead);
    expect(insert).toBeGreaterThan(share);

    const status = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_session_status");
    expect(status).not.toContain("pg_advisory_xact_lock");
    const hostSend = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_host_send_message");
    expect(hostSend.indexOf("update public.portmgr_remote_control_hosts"))
      .toBeLessThan(hostSend.indexOf("portmgr_remote_control_store_message"));
  });

  test("ships a live upgrade for the 30-day one-use QR without widening caller roles", () => {
    const compactUpgrade = compact(monthPairingMigration);
    expect(compactUpgrade).toContain("portmgr_remote_control_pairings_ttl_check");
    expect(compactUpgrade).toContain("expires_at<=created_at+interval '30 days'");
    expect(compactUpgrade).toContain("expires_at<=created_at+interval '62 days'");
    // 승인 관문은 이 마이그레이션이 건드리지 않는다 — 유효기간만 늘린다.
    expect(compactUpgrade).not.toContain("portmgr_remote_control_host_approve_session");
    expect(compactUpgrade).not.toContain("portmgr_remote_control_claim_pairing");
    // register_host stayed unchanged; create_pairing is intentionally the
    // historical 30-day form and the later bounded migration upgrades it.
    expect(functionDefinition(monthPairingMigration, "portmgr_remote_control_register_host"))
      .toBe(functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_register_host"));
    expect(functionDefinition(monthPairingMigration, "portmgr_remote_control_create_pairing"))
      .not.toContain("remote_control_pairing_limit");
    expect(compactUpgrade).not.toMatch(/grant execute on function [^;]+ to (?:public|anon|authenticated)/);
  });

  test("ships a live upgrade for the 30-day approved session without widening caller roles", () => {
    const compactUpgrade = compact(monthSessionMigration);
    expect(compactUpgrade).toContain("expires_at<=created_at+interval '62 days'");
    expect(compactUpgrade).toContain("expires_at<=approved_at+interval '30 days'");
    expect(functionDefinition(monthSessionMigration, "portmgr_remote_control_register_host"))
      .toBe(functionDefinition(migration, "portmgr_remote_control_register_host"));
    expect(functionDefinition(monthSessionMigration, "portmgr_remote_control_host_approve_session"))
      .toBe(functionDefinition(migration, "portmgr_remote_control_host_approve_session"));
    expect(compactUpgrade).toContain(
      "grant execute on function public.portmgr_remote_control_register_host(uuid,text,text,text,integer) to service_role",
    );
    expect(compactUpgrade).toContain(
      "grant execute on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid) to service_role",
    );
    expect(compactUpgrade).not.toMatch(/grant execute on function [^;]+ to (?:public|anon|authenticated)/);
  });

  test("creates a proof-bound candidate and binds its Google owner only on Mac approval", () => {
    const claim = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_claim_pairing");
    const approve = functionDefinition(
      REMOTE_CONTROL_RELAY_SQL,
      "portmgr_remote_control_host_approve_session",
    );
    expect(claim).toContain("v_user_id uuid:=auth.uid()");
    expect(claim).toContain("public.portmgr_is_member()");
    expect(claim).toContain("for update");
    expect(claim).toContain("v_pairing.claimed_at is not null");
    expect(claim).toContain("(v_pairing.claimed_at is null and v_pairing.expires_at<=now())");
    expect(claim).toContain("extensions.digest(convert_to(p_pairing_secret,'utf8'),'sha256')");
    expect(claim).toContain("v_pairing.claimed_by_user_id is distinct from v_user_id");
    expect(claim).toContain("v_existing_session.controller_name is distinct from btrim(p_controller_name)");
    expect(claim).toContain("v_existing_session.controller_public_key is distinct from p_controller_public_key");
    expect(claim).toContain("v_existing_session.approval_state is distinct from 'pending'");
    expect(claim).toContain("v_existing_session.session_id,v_existing_session.controller_id");
    expect(claim).toContain("'pending'::text");
    expect(claim).not.toContain("set owner_user_id=v_user_id");
    expect(approve).toContain("v_host_expires_at:=public.portmgr_remote_control_authorize_host");
    expect(approve).toContain("select h.owner_user_id into v_owner_user_id");
    expect(approve).toContain("set owner_user_id=v_candidate_user_id,claimed_at=now()");
    expect(approve).toContain("remote_control_owner_mismatch");
    expect(approve).toContain("set approval_state='approved'");
    expect(approve).toContain("when s.approval_state='pending' then least(now()+interval '30 days',v_host_expires_at)");
    expect(approve).toContain("else s.expires_at");
    expect(approve).not.toContain("v_pairing_expires_at");
  });

  test("runs service-role cleanup in bounded lock-skipping batches", () => {
    const cleanup = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_cleanup");
    expect(cleanup).toContain("p_limit integer default 500");
    expect(cleanup).toContain("least(greatest(coalesce(p_limit,500),1),500)");
    expect(cleanup.match(/limit v_limit/g)).toHaveLength(5);
    expect(cleanup.match(/for update(?: of s)? skip locked/g)).toHaveLength(5);
    expect(cleanup).toContain("s.approval_state='pending' and s.expires_at<=now()");
    expect(cleanup).not.toContain("join public.portmgr_remote_control_pairings p on p.pairing_id=s.pairing_id");
    expect(cleanup).toContain("not exists(select 1 from public.portmgr_remote_control_messages m where m.session_id=s.session_id)");
    expect(cleanup).toContain("not exists(select 1 from public.portmgr_remote_control_sessions s where s.pairing_id=p.pairing_id)");
    expect(cleanup).toContain("not exists(select 1 from public.portmgr_remote_control_pairings p where p.host_id=h.host_id)");
  });

  test("uses one canonical raw P-256 key, base64url fingerprint, and explicit IDs", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    expect(sql).toContain("public_key text not null check(public_key ~ '^[a-za-z0-9_-]{87}$')");
    expect(sql).toContain(
      "controller_public_key text not null check(controller_public_key ~ '^[a-za-z0-9_-]{87}$')",
    );
    expect(sql).toContain("octet_length(v_key)=65 and get_byte(v_key,0)=4");
    expect(sql).toContain("public_key_fingerprint ~ '^[a-za-z0-9_-]{43}$'");
    expect(sql).toContain("controller_key_fingerprint ~ '^[a-za-z0-9_-]{43}$'");
    expect(sql).toContain("extensions.digest(decode(translate(p_key,'-_','+/')||'=','base64'),'sha256')");
    for (const name of [
      "portmgr_remote_control_claim_pairing",
      "portmgr_remote_control_host_list_sessions",
      "portmgr_remote_control_host_approve_session",
      "portmgr_remote_control_session_status",
      "portmgr_remote_control_host_receive_messages",
      "portmgr_remote_control_controller_receive_messages",
    ]) {
      expect(functionDefinition(REMOTE_CONTROL_RELAY_SQL, name)).toContain("controller_id uuid");
    }
  });

  test("stores and reproduces exactly the authenticated envelope AAD fields", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    const store = functionDefinition(REMOTE_CONTROL_RELAY_SQL, "portmgr_remote_control_store_message");
    expect(sql).toContain("relay_seq bigint generated always as identity primary key");
    expect(sql).toContain("message_id uuid not null unique");
    expect(sql).toContain("sender_sequence bigint not null check(sender_sequence>=0)");
    expect(sql).toContain("envelope_expires_at timestamptz not null");
    expect(sql).toContain("unique(session_id,direction,sender_sequence)");
    expect(store).toContain("p_message_id uuid");
    expect(store).toContain("p_sender_sequence text");
    expect(store).toContain("p_envelope_expires_at timestamptz");
    expect(store).toContain("v_existing.message_id is distinct from p_message_id");
    expect(store).toContain("v_existing.sender_sequence is distinct from v_sender_sequence");
    expect(store).toContain("v_existing.envelope_expires_at is distinct from p_envelope_expires_at");
    expect(store).toContain("remote_control_dedupe_mismatch");
    expect(store).toContain("remote_control_sender_sequence_replayed");
    expect(sql).not.toContain("dedupe_key");
    expect(sql).not.toContain("key_id");
    expect(sql).not.toContain("message_type");
  });

  test("keeps plaintext out and enforces ciphertext, rate, cursor, ack, and TTL bounds", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    expect(sql).toContain("nonce bytea not null check(octet_length(nonce)=12)");
    expect(sql).toContain(
      "ciphertext bytea not null check(octet_length(ciphertext) between 16 and 16384)",
    );
    expect(sql).not.toContain("payload");
    expect(sql).not.toContain("plaintext");
    expect(sql).toContain(
      "pg_advisory_xact_lock(hashtextextended('portmgr-remote-control:'||p_session_id::text||':'||p_direction,0))",
    );
    expect(sql).toContain("m.created_at>now()-interval '1 minute'");
    expect(sql).toContain("if v_recent_count>=60 then");
    expect(sql).toContain("remote_control_rate_limited");
    expect(sql).toContain("m.relay_seq::text");
    expect(sql).toContain("order by m.relay_seq asc");
    expect(sql).toContain("set acknowledged_at=now()");
    expect(sql).toContain("m.acknowledged_at is null");
    expect(sql).toContain("m.envelope_expires_at<=now()");
  });

  test("is independent from the chosen static HTTPS hosting vendor", () => {
    const sql = compact(REMOTE_CONTROL_RELAY_SQL);
    expect(sql).not.toContain("vercel");
    expect(sql).not.toContain("chatgpt");
    expect(sql).not.toContain("websocket");
    expect(sql).not.toContain("http://");
    expect(sql).not.toContain("https://");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("auth.role()");
  });
});

describe("host liveness reaches the phone", () => {
  test("ships as its own migration and matches the canonical module", () => {
    // The base migration is the module verbatim, so a database that already ran
    // it needs this incremental one or the phone keeps guessing.
    const canonical = REMOTE_CONTROL_RELAY_SQL.slice(
      REMOTE_CONTROL_RELAY_SQL.indexOf("drop function if exists public.portmgr_remote_control_session_status"),
    );
    const definition = canonical.slice(0, canonical.indexOf("$$;") + 4);
    expect(hostLastSeenMigration).toContain(definition);
    expect(REMOTE_CONTROL_RELAY_SQL).toContain("host_last_seen_at timestamptz");
    expect(REMOTE_CONTROL_RELAY_SQL).toContain("s.revoked_at, h.last_seen_at");
    // Changing a RETURNS TABLE needs the drop; create-or-replace alone errors.
    expect(hostLastSeenMigration).toContain("drop function if exists public.portmgr_remote_control_session_status(uuid, uuid);");
    // ⚠️ Dropping a function drops its grants and restores Postgres' default of
    // EXECUTE for PUBLIC, so anon silently regains it — observed live on this
    // very migration. The revoke has to come back before the grant.
    const revoke = hostLastSeenMigration.indexOf(
      "revoke all on function public.portmgr_remote_control_session_status(uuid,uuid) from public, anon, authenticated, service_role;",
    );
    const grant = hostLastSeenMigration.indexOf(
      "grant execute on function public.portmgr_remote_control_session_status(uuid,uuid) to authenticated;",
    );
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    // Still member-gated and still scoped to the caller's own session.
    expect(hostLastSeenMigration).toContain("REMOTE_CONTROL_MEMBER_REQUIRED");
    expect(hostLastSeenMigration).toContain("s.auth_user_id = v_user_id");
  });
});

describe("a host in daily use never expires underneath its user", () => {
  test("renew_host is service-role only and can only move the expiry later", () => {
    expect(REMOTE_CONTROL_RELAY_SQL).toContain("create or replace function public.portmgr_remote_control_renew_host(");
    // Proves the secret like every other host call, and cannot resurrect a
    // revoked, disabled or already-expired host.
    expect(renewHostMigration).toContain("perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);");
    expect(renewHostMigration).toContain("set expires_at = greatest(h.expires_at, v_expires_at)");
    const revoke = renewHostMigration.indexOf(
      "revoke all on function public.portmgr_remote_control_renew_host(uuid,text,integer) from public, anon, authenticated, service_role;",
    );
    const grant = renewHostMigration.indexOf(
      "grant execute on function public.portmgr_remote_control_renew_host(uuid,text,integer) to service_role;",
    );
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(renewHostMigration).not.toContain("to authenticated;");
  });

  test("the canonical SQL stays ASCII, or it stops matching its own migration", () => {
    // String.raw keeps the transpiler's \uXXXX escapes literal, so one em-dash
    // in a SQL comment makes the module and the migration differ by five
    // characters each — which is exactly how this was found.
    const nonAscii = [...REMOTE_CONTROL_RELAY_SQL].filter(character => character.codePointAt(0)! > 127);
    expect(nonAscii).toEqual([]);
  });
});
