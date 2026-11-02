/**
 * PGlite Supabase shim for the emulator harness (harness-design §2.4, WP2).
 *
 * `supabase start` needs Docker, which this Mac does not have, so the lanes talk to ONE in-memory PGlite
 * carrying the canonical schema (`migrationSqlForAllowedEmails`, src/schemaSql.ts: relay, dialogue and the
 * real membership function) behind two loopback doors:
 *
 *   - http  `http://127.0.0.1:<ephemeral>` — what the sidecar may use (server-supabase-service.ts allows
 *     plaintext only to exact loopback).
 *   - https `https://localhost[:port]`, port 443 preferred — a per-run CA (./fixtureCa.ts). The phone's
 *     bundled portal requires an https origin without a port, and the Mac only puts `supabase` into a QR
 *     for an https project (src/remoteControlPairingSupabase.ts). When 443 cannot be bound without root the
 *     door falls back to an ephemeral port and SAYS SO (`https.fallback`); lanes that need 443 are blocked.
 *
 * What is emulated, deliberately small:
 *   - PostgREST `POST /rest/v1/rpc/:fn` — the function is resolved from the catalog by argument names (as
 *     PostgREST's schema cache does), arguments are bound through json_to_record, the result is serialized
 *     by Postgres itself, and every call runs in its own transaction with `SET LOCAL ROLE` plus
 *     `request.jwt.claims` / `request.jwt.claim.{role,sub,email}` and Supabase's API search_path
 *     (public, extensions). Stable functions run read-only. Supabase's default privileges are emulated. Grants and
 *     RLS are therefore the real ones: an anon key calling a service-only function gets 401/42501.
 *   - GoTrue email-code subset: `/auth/v1/otp`, `/verify` (type=email, one code fixed per run),
 *     `/user`, `/token?grant_type=refresh_token`, `/logout`. Only existing users may sign in
 *     (the portal sends shouldCreateUser:false). Keys and access tokens are HS256 JWTs under a per-run secret.
 *     Refresh follows supabase/auth (internal/tokens/service.go RefreshTokenGrant, read 2026-11-01): a used
 *     token that is the parent of the session's newest active token gets that active token back (a client
 *     that lost the response); any other used token is still swapped inside the reuse interval (default 10 s,
 *     the hosted default, counted from that token's last swap) and past it revokes every refresh token of the
 *     session (`refresh_token_already_used`) — the session and its access tokens stay, as in GoTrue. Logout
 *     deletes sessions (global/local/others).
 *
 * What it refuses, so a difference from Supabase cannot hide:
 *   - Any other route, method, query, Prefer header, CORS request header or auth feature is answered 404/400
 *     AND recorded; `report().ok` is false and the CLI exits 3. A lane must treat that as a failure.
 *   - Browser origins other than `https://portal.test` and `agentstoz-app://portal` (403, recorded).
 *   - Binding anything but literal 127.0.0.1 / ::1 (no wildcard, no LAN, not even the name "localhost"), and
 *     binding 3001 / 52741 / 4723 at all (installed sidecar, real Screen, Appium).
 *   - A scratch or app-data folder under the real home, an evidence folder under the real app data or an
 *     agent's config, and a self-check against anything but a loopback URL (never production Supabase).
 *
 * Known differences that remain (also listed in every report as `knownDifferences`):
 *   - SECURITY DEFINER functions are owned by PGlite's superuser, which bypasses every grant and RLS policy
 *     inside them. In Supabase their owner (`postgres`) is NOT a superuser, so a definer function that relies
 *     on a grant it lacks passes here and fails in production. The report counts those functions.
 *   - No rate limits, sign-up, MFA, realtime, storage, edge functions or table (REST) routes.
 *
 * Isolation: design §2.3 requires every host process to run under the WP1 sandbox. The shim measures its own
 * process with the kernel's sandbox_check() and reports `isolation`; "not-sandboxed" means the run is not an
 * isolated one, whatever else passed. The CLI refuses to start with a HOME, TMPDIR or app-data folder under the
 * real home (read from directory services — Bun's os.homedir() follows $HOME) or with the design's forbidden
 * environment keys (CODEX_HOME, SUPABASE_*, VITE_*, PORTMGR_*, ...).
 *
 * Evidence: on stop() it writes `relay-db.json`, `dialogue-db.json` and `supabase-shim-report.json` to the
 * evidence directory with every key, secret, hash, token, nonce and ciphertext replaced by "[redacted]".
 * Relay message inserts and dialogue control transitions are also copied into an audit schema by triggers,
 * because the relay deletes acknowledged rows: "no sequence reuse" must be judged on the history, not on
 * whatever rows happen to survive until the end.
 *
 * Harness-only. Nothing in src/ imports this file and it adds no switch a production build could flip.
 * It never reads the agent's environment for configuration: everything comes from options/argv.
 *
 * CLI:
 *   bun scripts/emulator-e2e/supabaseShim.ts serve --scratch <dir> [--evidence <dir>] [--run-id <id>]
 *       [--member <email>]... [--outsider <email>]... [--https-port <n>] [--require-https-port]
 *       [--no-https] [--no-http]
 *     Prints JSON event lines on stdout — read them by `event`, not by position: {"event":"starting"} once its
 *     SIGTERM/SIGINT handlers are armed, {"event":"ready",...} when both doors are open (no secrets; credentials
 *     go to <scratch>/supabase-shim.json, mode 0600), {"event":"stopped",...} at the end.
 *     SIGTERM/SIGINT (also during startup) or losing the parent process stops it, writes evidence and exits 0; 3 when
 *     unknown routes / rejected origins / internal errors were seen; 4 when the evidence could not be written or
 *     the shim did not stop cleanly.
 *   bun scripts/emulator-e2e/supabaseShim.ts client-selfcheck --credentials <file> --door http|https --app-data <dir>
 *     Drives the real relay RPC clients, the real AgentDialogueHost and the portal's email-code login against a
 *     running shim and prints one JSON result line (exit 0 only when every check passed, 1 otherwise).
 *   Both commands exit 2, before doing anything, on a usage error (missing, relative or unknown argument, a
 *   reserved port) or a refused environment.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveAppDataDir, resolveAppDataDirFromEnvironment } from '../../src/appDataDir';
import { AGENT_DIALOGUE_TABLES, REMOTE_CONTROL_RELAY_TABLES, migrationSqlForAllowedEmails } from '../../src/schemaSql';
import { createFixtureCa, type FixtureCa } from './fixtureCa';

export type ShimDoor = 'http' | 'https';
export type ShimRole = 'anon' | 'authenticated' | 'service_role';
/** Literal loopback addresses only. "localhost" is a name, not an address: it is resolved, so it is refused. */
export type ShimLoopbackHost = '127.0.0.1' | '::1';

export const SHIM_DEFAULT_ALLOWED_ORIGINS = ['https://portal.test', 'agentstoz-app://portal'] as const;
export const SHIM_DEFAULT_MEMBER_EMAIL = 'owner@emulator.test';
export const SHIM_DEFAULT_OUTSIDER_EMAIL = 'outsider@emulator.test';
export const SHIM_CREDENTIALS_FILE = 'supabase-shim.json';
export const SHIM_REPORT_FILE = 'supabase-shim-report.json';
export const SHIM_RELAY_DUMP_FILE = 'relay-db.json';
export const SHIM_DIALOGUE_DUMP_FILE = 'dialogue-db.json';
/** CLI exit code for a usage error or a refused environment; nothing was started. */
export const SHIM_EXIT_USAGE = 2;
/** CLI exit code when the shim saw something it does not emulate (unknown route, foreign origin, internal error). */
export const SHIM_EXIT_UNSUPPORTED = 3;
/** CLI exit code when the evidence could not be written or requests were still running when the shim stopped. */
export const SHIM_EXIT_STOP_FAILED = 4;
/** Installed sidecar, real AgentsToZ Screen, Appium (design §2.3): never bound by the shim, never a self-check target. */
export const SHIM_RESERVED_PORTS: readonly number[] = Object.freeze([3001, 52741, 4723]);
/** Supabase's hosted default for "refresh token reuse interval" (GoTrue's RefreshTokenReuseInterval, seconds). */
export const SHIM_DEFAULT_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS = 10;
/** Environment keys design §2.2 says a harness child must not carry (exact names, then prefixes). */
export const SHIM_FORBIDDEN_ENV_KEYS: readonly string[] = Object.freeze([
  'CODEX_HOME', 'AGENTSTOZ_CLI_SHIM_DIR', 'AGENTSTOZ_USE_ENDPOINT', 'AGENTSTOZ_IOS_PORTAL_URL', 'CLAUDECODE', 'API_PORT',
]);
export const SHIM_FORBIDDEN_ENV_PREFIXES: readonly string[] = Object.freeze(['PORTMGR_', 'SUPABASE_', 'VITE_']);
/** Differences from Supabase the shim cannot remove; every report repeats them so no lane reads more into a pass. */
export const SHIM_KNOWN_DIFFERENCES: readonly string[] = Object.freeze([
  'SECURITY DEFINER functions are owned by PGlite\'s superuser here, which bypasses every grant and RLS policy inside them; in Supabase their owner (postgres) is not a superuser, so a definer function that relies on a grant it lacks passes here and fails in production (see superuserOwnedDefinerFunctions).',
  'PostgREST supports POST RPC, the empty fixture policy read and the exact service-role device-alias lookup; other table routes are refused and recorded.',
  'GoTrue: email code only (one fixed code per run), no rate limits, no sign-up, no MFA, no session timeboxes; refresh reuse follows GoTrue with the configured reuse interval.',
  'No realtime, storage or edge functions.',
  'The fixture CA carries DNS name constraints only (Bun rejects iPAddress constraints).',
]);

const ROLES: ReadonlySet<string> = new Set<ShimRole>(['anon', 'authenticated', 'service_role']);
const MAX_BODY_BYTES = 1024 * 1024;
const PREFLIGHT_HEADERS = new Set([
  'apikey', 'authorization', 'content-type', 'accept', 'x-client-info', 'x-supabase-api-version',
  'content-profile', 'accept-profile', 'x-retry-count',
]);
const GOTRUE_API_VERSION = '2024-01-01';
/** How long stop() waits for requests that were already running when the doors closed. */
const STOP_DRAIN_MS = 10_000;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export interface SupabaseShimUser {
  email: string;
  /** Default true. A non-member exists in auth.users (can sign in) but is not in portmgr_allowed_members. */
  member?: boolean;
}

export interface SupabaseShimOptions {
  /** Absolute scratch directory (created 0700): CA, credentials file. Never a real app-data folder. */
  scratchDir: string;
  /** Absolute evidence directory; stop() writes the redacted dumps and the report here. */
  evidenceDir?: string;
  runId?: string;
  /** Default: one member and one outsider (see SHIM_DEFAULT_*_EMAIL). At least one member is required. */
  users?: readonly SupabaseShimUser[];
  /** 6–8 digits; default a random 8-digit code (the shared project uses 8). One code per run. */
  otpCode?: string;
  /** Default 3600. */
  accessTokenTtlSeconds?: number;
  /** Default 3600. A code is valid this long after the /otp request that "sent" it. */
  otpTtlSeconds?: number;
  /** Default 10 (Supabase's hosted default). A used refresh token may still be swapped this long after use. */
  refreshTokenReuseIntervalSeconds?: number;
  http?: false | { hostname?: ShimLoopbackHost; port?: number };
  https?: false | {
    hostname?: ShimLoopbackHost;
    /** Default 443. 0 means "ephemeral, do not try a fixed port". */
    preferredPort?: number;
    /** Default false: fall back to an ephemeral port and record why. True: throw instead. */
    requirePreferredPort?: boolean;
    /** Default true: also bind ::1 on the same port so `localhost` works whichever family resolves first. */
    alsoIpv6?: boolean;
  };
  /** Reuse a CA (e.g. one already added to an owned simulator). Default: mint one under scratchDir/ca. */
  ca?: FixtureCa;
  allowedOrigins?: readonly string[];
  now?: () => number;
}

export interface ShimUnknownRoute {
  at: string;
  door: ShimDoor;
  method: string;
  path: string;
  /** Query parameter NAMES only; values may carry tokens. */
  queryKeys: string[];
  reason: string;
}
export interface ShimRejectedOrigin { at: string; door: ShimDoor; method: string; path: string; origin: string }
export interface ShimRequestRecord {
  seq: number;
  at: string;
  door: ShimDoor;
  method: string;
  path: string;
  status: number;
  role?: ShimRole;
  fn?: string;
  /** Postgres / PostgREST / GoTrue error code of a failed call. */
  code?: string;
}
export interface ShimAuthEvent { at: string; door: ShimDoor; type: 'otp' | 'verify' | 'refresh' | 'logout' | 'user'; email?: string; ok: boolean; code?: string }

/**
 * Whether the process is inside a sandbox, as the kernel answers sandbox_check(getpid()). "sandboxed" proves
 * SOME profile applies, not which one: the lane still has to show it launched the WP1 profile it hashed.
 */
export interface ShimIsolation {
  status: 'sandboxed' | 'not-sandboxed' | 'unknown';
  processSandboxed: boolean | null;
  method: 'sandbox_check' | 'unavailable';
}

export interface SupabaseShimReport {
  version: 2;
  runId: string;
  /** False on any unknown route, rejected origin, internal error or stop error. Isolation is reported, not judged. */
  ok: boolean;
  isolation: ShimIsolation;
  http: { url: string } | null;
  https: { url: string; port: number; preferredPort: number; fallback: string | null; ipv6: boolean; caFingerprintSha256: string } | null;
  unknownRoutes: ShimUnknownRoute[];
  rejectedOrigins: ShimRejectedOrigin[];
  internalErrors: { at: string; door: ShimDoor; path: string; message: string }[];
  /** Requests cut off because stop() closed the doors under them (recorded, not a failure). */
  interruptedAtStop: { at: string; door: ShimDoor; method: string; path: string }[];
  /** Evidence that could not be written, or requests still running after the drain window. */
  stopErrors: string[];
  requestCount: number;
  rpcCalls: Record<string, Record<string, number>>;
  authEvents: { type: ShimAuthEvent['type']; ok: number; failed: number }[];
  /** Public SECURITY DEFINER functions owned by a superuser (all of them, in PGlite) — see knownDifferences. */
  superuserOwnedDefinerFunctions: number;
  knownDifferences: string[];
}

export interface SupabaseShimCredentials {
  version: 1;
  runId: string;
  pid: number;
  http: { url: string } | null;
  https: { url: string; port: number; fallback: string | null } | null;
  anonKey: string;
  serviceRoleKey: string;
  otpCode: string;
  users: { email: string; member: boolean }[];
  caCertPath: string | null;
  caFingerprintSha256: string | null;
}

export interface SupabaseShim {
  readonly runId: string;
  readonly httpUrl: string | null;
  readonly httpsUrl: string | null;
  readonly httpsPort: number | null;
  /** Why the https door is not on its preferred port (e.g. "EACCES binding 127.0.0.1:443"), or null. */
  readonly httpsFallback: string | null;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly otpCode: string;
  readonly ca: FixtureCa | null;
  readonly credentialsPath: string;
  readonly isolation: ShimIsolation;
  credentials(): SupabaseShimCredentials;
  /** Requests whose handling has started and not finished. */
  inFlight(): number;
  unknownRoutes(): ShimUnknownRoute[];
  rejectedOrigins(): ShimRejectedOrigin[];
  requests(): ShimRequestRecord[];
  authEvents(): ShimAuthEvent[];
  /** Number of calls to one RPC (any outcome), e.g. to assert "claim RPC 0" in a negative case. */
  rpcCallCount(fn: string): number;
  /** Redacted relay and dialogue tables plus the audit history. */
  dump(): Promise<{ relay: ShimTableDump; dialogue: ShimTableDump }>;
  report(): SupabaseShimReport;
  /** Mint a token as GoTrue would for an existing user — for negative tests (expired, other roles). */
  signTestJwt(claims: Record<string, unknown>): string;
  /**
   * Closes both doors, waits for requests already running (so they are in the report), writes evidence (if
   * configured) and closes the database. Never rejects: a failure is in `stopErrors`. Idempotent.
   */
  stop(): Promise<SupabaseShimReport>;
}

export interface ShimTableDump {
  tables: Record<string, unknown[]>;
  audit: Record<string, unknown[]>;
}

// ── JWT (HS256 only) ───────────────────────────────────────────────────────────────────────────

function signJwt(secret: string, payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

type JwtResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: 'malformed' | 'algorithm' | 'signature' | 'expired' | 'claims' };

function verifyJwt(secret: string, token: string, nowSeconds: number): JwtResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return { ok: false, reason: 'malformed' };
  let header: unknown, payload: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'HS256') return { ok: false, reason: 'algorithm' };
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'claims' };
  const claims = payload as Record<string, unknown>;
  if (claims.exp !== undefined && typeof claims.exp !== 'number') return { ok: false, reason: 'claims' };
  if (typeof claims.exp === 'number' && claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  if (typeof claims.role !== 'string' || !ROLES.has(claims.role)) return { ok: false, reason: 'claims' };
  return { ok: true, claims };
}

function sameSecret(a: string | null, b: string): boolean {
  if (a === null) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ── SQL ────────────────────────────────────────────────────────────────────────────────────────

/** The parts of a Supabase database the canonical migration expects to exist already. */
const SUPABASE_PRELUDE_SQL = `
set timezone to 'UTC';
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges: every new public object is granted to the API roles, and each
-- migration must revoke what it does not mean to expose. Emulating that keeps a forgotten revoke visible.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  aud text not null default 'authenticated',
  role text not null default 'authenticated',
  email text unique,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
revoke all on table auth.users from public, anon, authenticated, service_role;
-- Same bodies as Supabase's auth helpers: PostgREST's request.jwt.claims first-class, the legacy
-- request.jwt.claim.* settings honoured too.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1, '/') $$;
`;

/** Insert history the relay and dialogue SQL would otherwise delete. Private to the superuser. */
const AUDIT_SQL = `
create schema emulator_audit;
revoke all on schema emulator_audit from public, anon, authenticated, service_role;
create table emulator_audit.relay_messages (
  audit_id bigint generated always as identity primary key,
  relay_seq bigint not null,
  message_id uuid not null,
  host_id uuid not null,
  session_id uuid not null,
  controller_id uuid not null,
  direction text not null,
  sender_sequence bigint not null,
  created_at timestamptz not null,
  inserted_by_role text
);
create function emulator_audit.record_relay_message() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into emulator_audit.relay_messages(relay_seq, message_id, host_id, session_id, controller_id,
    direction, sender_sequence, created_at, inserted_by_role)
  values (new.relay_seq, new.message_id, new.host_id, new.session_id, new.controller_id,
    new.direction, new.sender_sequence, new.created_at, nullif(current_setting('request.jwt.claim.role', true), ''));
  return null;
end $$;
revoke all on function emulator_audit.record_relay_message() from public, anon, authenticated, service_role;
create trigger emulator_audit_relay_messages after insert on public.portmgr_remote_control_messages
  for each row execute function emulator_audit.record_relay_message();

create table emulator_audit.dialogue_controls (
  audit_id bigint generated always as identity primary key,
  control_id uuid not null,
  event text not null,
  state text,
  from_endpoint_id uuid,
  to_endpoint_id uuid,
  to_device_id text,
  request_id text,
  request_kind text,
  at timestamptz not null default clock_timestamp()
);
create function emulator_audit.record_dialogue_control() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare v_request jsonb := new.request;
begin
  if tg_op = 'UPDATE' then
    if new.state is not distinct from old.state then return null; end if;
    -- control-respond clears the request to '{}'; keep the identity of what was answered.
    v_request := old.request;
  end if;
  insert into emulator_audit.dialogue_controls(control_id, event, state, from_endpoint_id, to_endpoint_id,
    to_device_id, request_id, request_kind)
  values (new.control_id, lower(tg_op), new.state, new.from_endpoint_id, new.to_endpoint_id,
    new.to_device_id, v_request ->> 'requestId', v_request ->> 'kind');
  return null;
end $$;
revoke all on function emulator_audit.record_dialogue_control() from public, anon, authenticated, service_role;
create trigger emulator_audit_dialogue_controls after insert or update on public.portmgr_agent_dialogue_controls
  for each row execute function emulator_audit.record_dialogue_control();
`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface CatalogFunction {
  inArgs: { name: string; type: string }[];
  required: number;
  volatility: 'i' | 's' | 'v';
  returnsSet: boolean;
  returnsComposite: boolean;
  returnsVoid: boolean;
}

const CATALOG_SQL = `
select p.provolatile::text as volatility,
       p.proretset as returns_set,
       (p.prorettype = 'void'::regtype) as returns_void,
       (t.typtype = 'c' or p.prorettype = 'record'::regtype) as returns_composite,
       p.pronargs as nargs,
       p.pronargdefaults as ndefaults,
       coalesce(p.proargnames, array[]::text[]) as arg_names,
       coalesce(p.proargmodes::text[], array[]::text[]) as arg_modes,
       array(select format_type(u.t, null)
             from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as u(t, n)
             order by u.n) as arg_types
from pg_proc p
join pg_type t on t.oid = p.prorettype
where p.pronamespace = 'public'::regnamespace and p.proname = $1 and p.prokind = 'f'`;

// ── PostgREST error shape ─────────────────────────────────────────────────────────────────────

/**
 * PostgREST's "SQLSTATE → HTTP status" table (docs.postgrest.org/en/stable/references/errors.html, read
 * 2026-11-01), exact codes before their class: 53400 → 500 although 53* → 503; 54* → 500; `PTxyz` → xyz.
 */
export function postgrestHttpStatus(code: string, role: ShimRole): number {
  const custom = /^PT([1-5]\d\d)$/.exec(code);
  if (custom) return Number(custom[1]);
  switch (code) {
    case '42501': return role === 'anon' ? 401 : 403;
    case '42883': case '42P01': return 404;
    case '42P17': return 500;
    case '23503': case '23505': return 409;
    case '25006': return 405;
    case '53400': return 500;
    case 'P0001': return 400;
  }
  switch (code.slice(0, 2)) {
    case '08': case '53': return 503;
    case '0L': case '0P': case '28': return 403;
    case '09': case '25': case '2D': case '38': case '39': case '3B': case '40': case '54': case '55': case '57': case '58':
    case 'F0': case 'HV': case 'P0': case 'XX':
      return 500;
  }
  return 400;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

// ── Redaction ──────────────────────────────────────────────────────────────────────────────────

const SECRET_FIELD = /secret|hash|token|cipher|nonce|password|salt|signature|credential|private|key/i;
const SECRET_TEXT = /#pair=|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|sb_(?:secret|publishable)_/;

/** Replace every value under a secret-looking name, at any depth, and any string that embeds a token. */
export function redactForEvidence(value: unknown, field?: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (field !== undefined && SECRET_FIELD.test(field)) return '[redacted]';
  if (typeof value === 'string') return SECRET_TEXT.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(entry => redactForEvidence(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactForEvidence(entry, key)]));
  }
  return value;
}

// ── Binding ────────────────────────────────────────────────────────────────────────────────────

function assertLoopbackHost(hostname: unknown, door: ShimDoor): ShimLoopbackHost {
  if (hostname === '127.0.0.1' || hostname === '::1') return hostname;
  throw new Error(`supabase shim: refusing to bind the ${door} door to ${JSON.stringify(hostname)} — only literal 127.0.0.1 or ::1`);
}

function assertPort(port: unknown, door: ShimDoor): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`supabase shim: invalid ${door} port ${JSON.stringify(port)}`);
  }
  if (SHIM_RESERVED_PORTS.includes(port)) {
    throw new Error(`supabase shim: refusing reserved port ${port} for the ${door} door (installed sidecar, real Screen or Appium)`);
  }
  return port;
}

/** Bind on an ephemeral port, never landing on a reserved one (52741 is inside macOS's ephemeral range). */
function serveEphemeral(options: Parameters<typeof Bun.serve>[0]): ReturnType<typeof Bun.serve> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = Bun.serve({ ...options, port: 0 } as Parameters<typeof Bun.serve>[0]);
    if (!SHIM_RESERVED_PORTS.includes(server.port ?? 0)) return server;
    void server.stop(true);
  }
  throw new Error('supabase shim: the kernel kept handing out a reserved port');
}

// ── Safety guards: real home, protected folders, isolation, loopback targets ──────────────────

let cachedRealHome: string | null = null;

/**
 * The account's home from directory services. Bun's os.homedir() and os.userInfo().homedir both follow $HOME
 * (measured 2026-11-01), so neither can tell whether a child's HOME is the real one.
 */
export function shimRealHome(): string {
  if (cachedRealHome) return cachedRealHome;
  if (process.platform === 'darwin') {
    const entry = Bun.spawnSync(['/usr/bin/id', '-P'], { env: { PATH: '/usr/bin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const home = new TextDecoder().decode(entry.stdout).trim().split(':')[8];
    if (entry.exitCode !== 0 || !home || !isAbsolute(home)) throw new Error('supabase shim: could not read the real home from directory services');
    return (cachedRealHome = home);
  }
  return (cachedRealHome = userInfo().homedir);
}

/** Folders the harness must never write into: the installed app's data, agent configs and the keychains. */
export function shimProtectedRoots(home: string = shimRealHome()): string[] {
  return [
    join(home, 'Library', 'Application Support', 'com.portmanager.portmanager'),
    join(home, 'Library', 'Keychains'),
    join(home, '.claude'), join(home, '.codex'), join(home, '.hermes'), join(home, '.gemini'),
  ];
}

function isWithin(path: string, root: string): boolean {
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  return path === base || path.startsWith(`${base}/`);
}

/** Resolve symlinks of the deepest existing ancestor (`/var` → `/private/var`); the missing tail stays literal. */
function canonicalPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...tail.reverse()); } catch { /* walk up */ }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.push(basename(current));
    current = parent;
  }
}

/**
 * `outside-real-home`: scratch and app-data folders (design §2.2 — macOS app data follows the home).
 * `outside-protected`: evidence, which normally lives in the run's worktree under the home.
 */
export function assertShimPathAllowed(path: string, label: string, rule: 'outside-real-home' | 'outside-protected', home: string = shimRealHome()): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(`supabase shim: ${label} must be an absolute path`);
  const forms = [resolve(path), canonicalPath(path)];
  const homeForms = [resolve(home), canonicalPath(home)];
  const roots = rule === 'outside-real-home' ? homeForms : homeForms.flatMap(form => shimProtectedRoots(form));
  for (const root of roots) {
    if (forms.some(form => isWithin(form, root))) {
      throw new Error(`supabase shim: refusing ${label} ${path} — it is inside ${rule === 'outside-real-home' ? 'the real home' : 'a protected real folder'} (${root})`);
    }
  }
  return path;
}

let cachedIsolation: ShimIsolation | null = null;

/** Ask the kernel whether this process is sandboxed (sandbox_check(pid, NULL, 0) → 1). */
export function measureShimIsolation(): ShimIsolation {
  if (cachedIsolation) return cachedIsolation;
  if (process.platform !== 'darwin') return (cachedIsolation = { status: 'unknown', processSandboxed: null, method: 'unavailable' });
  try {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', { sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
    try {
      const answer = lib.symbols.sandbox_check(process.pid, null, 0);
      const sandboxed = answer === 1;
      return (cachedIsolation = { status: sandboxed ? 'sandboxed' : 'not-sandboxed', processSandboxed: sandboxed, method: 'sandbox_check' });
    } finally {
      lib.close();
    }
  } catch {
    return (cachedIsolation = { status: 'unknown', processSandboxed: null, method: 'unavailable' });
  }
}

/** Loopback only: the self-check writes hosts, pairings and dialogue rows wherever it points. */
export function assertLoopbackShimUrl(value: string, door: ShimDoor): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`supabase shim self-check: the ${door} URL is not a URL`); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (url.protocol !== `${door}:` || !loopback || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`supabase shim self-check: refusing ${door} target ${url.protocol}//${url.hostname} — only a loopback shim origin`);
  }
  const port = url.port ? Number(url.port) : door === 'https' ? 443 : 80;
  if (SHIM_RESERVED_PORTS.includes(port)) throw new Error(`supabase shim self-check: refusing reserved port ${port}`);
  return url;
}

/**
 * The CLI's own check before it runs anything (design §2.2): HOME, TMPDIR and the app-data folder the product
 * code would resolve must be outside the real home, and the forbidden keys must be absent.
 */
export function assertIsolatedShimEnvironment(env: Record<string, string | undefined> = process.env, home: string = shimRealHome()): void {
  const present = Object.keys(env).filter(key => env[key] !== undefined
    && (SHIM_FORBIDDEN_ENV_KEYS.includes(key) || SHIM_FORBIDDEN_ENV_PREFIXES.some(prefix => key.startsWith(prefix))));
  if (present.length) throw new Error(`supabase shim: refusing to run with forbidden environment keys: ${present.sort().join(', ')}`);
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error('supabase shim: HOME must be an absolute scratch folder');
  // For the live process also ask Node's own resolvers, which is what product code calls.
  const live = env === process.env;
  const resolvedHome = live ? homedir() : env.HOME;
  const paths: [string, string][] = [
    ['HOME', env.HOME],
    ['os.homedir()', resolvedHome],
    ['TMPDIR', live ? tmpdir() : env.TMPDIR ?? '/tmp'],
    ['the default app-data folder', resolveAppDataDir(process.platform, env, resolvedHome)],
    ['the app-data folder', resolveAppDataDirFromEnvironment(process.platform, env, resolvedHome)],
  ];
  for (const [label, path] of paths) assertShimPathAllowed(path, label, 'outside-real-home', home);
}

/** Option checks that run before anything is created or bound. Exported so the rules can be tested on a fake home. */
export function validateSupabaseShimOptions(options: SupabaseShimOptions, home: string = shimRealHome()): void {
  assertShimPathAllowed(options.scratchDir, 'scratchDir', 'outside-real-home', home);
  if (options.evidenceDir !== undefined) assertShimPathAllowed(options.evidenceDir, 'evidenceDir', 'outside-protected', home);
  for (const [door, config] of [['http', options.http], ['https', options.https]] as const) {
    if (config) {
      if (config.hostname !== undefined) assertLoopbackHost(config.hostname, door);
      const port = 'port' in config ? config.port : 'preferredPort' in config ? config.preferredPort : undefined;
      if (port !== undefined) assertPort(port, door);
    }
  }
  if (options.users && !options.users.some(user => user.member ?? true)) throw new Error('supabase shim: at least one member user is required');
  const reuse = options.refreshTokenReuseIntervalSeconds;
  if (reuse !== undefined && (!Number.isInteger(reuse) || reuse < 0 || reuse > 3600)) {
    throw new Error('supabase shim: refreshTokenReuseIntervalSeconds must be an integer 0..3600');
  }
}

/** Bun reports every failed bind as "in use"; ask the kernel through node:net for the real errno. */
async function bindFailureCode(hostname: string, port: number): Promise<string> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'UNKNOWN'));
    server.listen({ host: hostname, port, exclusive: true }, () => server.close(() => resolve('BINDABLE_ON_RETRY')));
  });
}

function urlHost(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

// ── The shim ───────────────────────────────────────────────────────────────────────────────────

type Route =
  | { kind: 'rpc'; fn: string }
  | { kind: 'empty-policy-read' }
  | { kind: 'device-alias-read' }
  | { kind: 'otp' } | { kind: 'verify' } | { kind: 'user' } | { kind: 'refresh' } | { kind: 'logout' };

function routeOf(method: string, url: URL): Route | { unsupported: string } | null {
  const path = url.pathname;
  if (path === '/rest/v1/portmgr_what_i_said_memory_policy') return method === 'GET' ? {kind: 'empty-policy-read'} : {unsupported: `${method} on fixture policy (only GET is emulated)`};
  if (path === '/rest/v1/portmgr_device_identity_aliases') return method === 'GET' ? {kind: 'device-alias-read'} : {unsupported: `${method} on fixture aliases (only GET is emulated)`};
  const rpc = path.match(/^\/rest\/v1\/rpc\/([A-Za-z_][A-Za-z0-9_]{0,62})$/);
  if (rpc) return method === 'POST' ? { kind: 'rpc', fn: rpc[1]! } : { unsupported: `${method} on an RPC (only POST is emulated)` };
  if (path === '/auth/v1/otp') return method === 'POST' ? { kind: 'otp' } : null;
  if (path === '/auth/v1/verify') return method === 'POST' ? { kind: 'verify' } : null;
  if (path === '/auth/v1/user') return method === 'GET' ? { kind: 'user' } : { unsupported: `${method} /auth/v1/user (only GET is emulated)` };
  if (path === '/auth/v1/logout') return method === 'POST' ? { kind: 'logout' } : null;
  if (path === '/auth/v1/token' && method === 'POST') {
    return url.searchParams.get('grant_type') === 'refresh_token'
      ? { kind: 'refresh' }
      : { unsupported: `grant_type=${(url.searchParams.get('grant_type') ?? '').slice(0, 40)} is not emulated` };
  }
  return null;
}

/** A GoTrue session row. Logout deletes it (and its refresh tokens); nothing else ends it. */
interface SessionRecord { userId: string }
/** A GoTrue refresh_tokens row: `seq` stands in for the serial id GoTrue orders "newest active" by. */
interface RefreshRecord { sessionId: string; revoked: boolean; parent: string | null; updatedAt: number; seq: number }

class SupabaseShimServer implements SupabaseShim {
  readonly runId: string;
  httpUrl: string | null = null;
  httpsUrl: string | null = null;
  httpsPort: number | null = null;
  httpsFallback: string | null = null;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly otpCode: string;
  ca: FixtureCa | null = null;
  readonly credentialsPath: string;

  readonly #options: SupabaseShimOptions;
  readonly #jwtSecret = randomBytes(32).toString('base64url');
  readonly #now: () => number;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #users: { email: string; member: boolean; id: string }[];
  readonly #db: PGlite;
  readonly #servers: ReturnType<typeof Bun.serve>[] = [];
  readonly #functions = new Map<string, CatalogFunction[]>();
  readonly #unknown: ShimUnknownRoute[] = [];
  readonly #rejected: ShimRejectedOrigin[] = [];
  readonly #internal: SupabaseShimReport['internalErrors'] = [];
  readonly #requests: ShimRequestRecord[] = [];
  readonly #authEvents: ShimAuthEvent[] = [];
  readonly #pendingOtp = new Map<string, number>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #refresh = new Map<string, RefreshRecord>();
  readonly #inFlight = new Set<Promise<Response>>();
  readonly #interrupted: SupabaseShimReport['interruptedAtStop'] = [];
  readonly #stopErrors: string[] = [];
  readonly isolation: ShimIsolation = measureShimIsolation();
  #refreshSeq = 0;
  #superuserDefiners = 0;
  #httpsPreferredPort = 0;
  #httpsIpv6 = false;
  #stopping = false;
  #stopped: Promise<SupabaseShimReport> | null = null;

  constructor(options: SupabaseShimOptions, db: PGlite) {
    this.#options = options;
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.runId = (options.runId ?? `shim-${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'shim';
    this.#allowedOrigins = new Set(options.allowedOrigins ?? SHIM_DEFAULT_ALLOWED_ORIGINS);
    this.#users = (options.users ?? [
      { email: SHIM_DEFAULT_MEMBER_EMAIL, member: true },
      { email: SHIM_DEFAULT_OUTSIDER_EMAIL, member: false },
    ]).map(user => ({ email: user.email.trim().toLowerCase(), member: user.member ?? true, id: randomUUID() }));
    for (const user of this.#users) {
      if (!EMAIL_PATTERN.test(user.email)) throw new Error(`supabase shim: invalid user email ${JSON.stringify(user.email)}`);
    }
    if (new Set(this.#users.map(user => user.email)).size !== this.#users.length) throw new Error('supabase shim: duplicate user email');
    const code = options.otpCode ?? String(randomInt(10_000_000, 100_000_000));
    if (!/^\d{6,8}$/.test(code)) throw new Error('supabase shim: otpCode must be 6–8 digits');
    this.otpCode = code;
    const iat = Math.floor(this.#now() / 1000);
    const ref = `emulator-${this.runId}`.slice(0, 40);
    this.anonKey = signJwt(this.#jwtSecret, { iss: 'supabase', ref, role: 'anon', iat, exp: iat + 30 * 86_400 });
    this.serviceRoleKey = signJwt(this.#jwtSecret, { iss: 'supabase', ref, role: 'service_role', iat, exp: iat + 30 * 86_400 });
    this.credentialsPath = join(options.scratchDir, SHIM_CREDENTIALS_FILE);
  }

  async initialize(): Promise<void> {
    await this.#db.exec(SUPABASE_PRELUDE_SQL);
    await this.#db.exec(migrationSqlForAllowedEmails(this.#users.filter(user => user.member).map(user => user.email)));
    for (const user of this.#users) {
      await this.#db.query('insert into auth.users(id, email, email_confirmed_at) values ($1, $2, now())', [user.id, user.email]);
    }
    await this.#db.exec(AUDIT_SQL);
    const { rows } = await this.#db.query<{ n: number }>(`select count(*)::int as n from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.prosecdef and r.rolsuper and p.pronamespace = 'public'::regnamespace`);
    this.#superuserDefiners = rows[0]?.n ?? 0;
  }

  async listen(): Promise<void> {
    // Every handler is tracked until it settles, so stop() can wait for it and the report misses nothing.
    const fetchFor = (door: ShimDoor) => (request: Request) => {
      const handling = this.#handle(request, door);
      this.#inFlight.add(handling);
      void handling.finally(() => this.#inFlight.delete(handling)).catch(() => undefined);
      return handling;
    };
    const common = { maxRequestBodySize: MAX_BODY_BYTES, idleTimeout: 30, development: false } as const;
    if (this.#options.http !== false) {
      const hostname = assertLoopbackHost(this.#options.http?.hostname ?? '127.0.0.1', 'http');
      const port = assertPort(this.#options.http?.port ?? 0, 'http');
      const server = port === 0
        ? serveEphemeral({ ...common, hostname, fetch: fetchFor('http') })
        : Bun.serve({ ...common, hostname, port, fetch: fetchFor('http') });
      this.#servers.push(server);
      this.httpUrl = `http://${urlHost(hostname)}:${server.port}`;
    }
    if (this.#options.https !== false) {
      const config = this.#options.https ?? {};
      const hostname = assertLoopbackHost(config.hostname ?? '127.0.0.1', 'https');
      const preferred = assertPort(config.preferredPort ?? 443, 'https');
      this.#httpsPreferredPort = preferred;
      this.ca = this.#options.ca ?? createFixtureCa({ dir: join(this.#options.scratchDir, 'ca'), label: this.runId });
      const tls = { cert: this.ca.serverCertPem, key: this.ca.serverKeyPem };
      let server: ReturnType<typeof Bun.serve> | null = null;
      if (preferred !== 0) {
        try {
          server = Bun.serve({ ...common, hostname, port: preferred, tls, fetch: fetchFor('https') });
        } catch {
          const code = await bindFailureCode(hostname, preferred);
          this.httpsFallback = `${code} binding ${urlHost(hostname)}:${preferred}`;
          if (config.requirePreferredPort) throw new Error(`supabase shim: https door needs port ${preferred}: ${this.httpsFallback}`);
        }
      }
      server ??= serveEphemeral({ ...common, hostname, tls, fetch: fetchFor('https') });
      this.#servers.push(server);
      this.httpsPort = server.port ?? null;
      if (config.alsoIpv6 ?? true) {
        const other = hostname === '127.0.0.1' ? '::1' : '127.0.0.1';
        try {
          this.#servers.push(Bun.serve({ ...common, hostname: other, port: server.port, tls, fetch: fetchFor('https') }));
          this.#httpsIpv6 = true;
        } catch {
          this.#httpsIpv6 = false;
        }
      }
      // The certificate is for "localhost"; that is also the name the iOS app and the QR carry.
      this.httpsUrl = server.port === 443 ? 'https://localhost' : `https://localhost:${server.port}`;
    }
    if (!this.httpUrl && !this.httpsUrl) throw new Error('supabase shim: at least one door is required');
  }

  credentials(): SupabaseShimCredentials {
    return {
      version: 1,
      runId: this.runId,
      pid: process.pid,
      http: this.httpUrl ? { url: this.httpUrl } : null,
      https: this.httpsUrl && this.httpsPort !== null ? { url: this.httpsUrl, port: this.httpsPort, fallback: this.httpsFallback } : null,
      anonKey: this.anonKey,
      serviceRoleKey: this.serviceRoleKey,
      otpCode: this.otpCode,
      users: this.#users.map(user => ({ email: user.email, member: user.member })),
      caCertPath: this.ca?.caCertPath ?? null,
      caFingerprintSha256: this.ca?.caFingerprintSha256 ?? null,
    };
  }

  writeCredentials(): void {
    writeFileSync(this.credentialsPath, JSON.stringify(this.credentials(), null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.credentialsPath, 0o600);
  }

  unknownRoutes() { return this.#unknown.map(entry => ({ ...entry, queryKeys: [...entry.queryKeys] })); }
  rejectedOrigins() { return this.#rejected.map(entry => ({ ...entry })); }
  requests() { return this.#requests.map(entry => ({ ...entry })); }
  authEvents() { return this.#authEvents.map(entry => ({ ...entry })); }
  rpcCallCount(fn: string) { return this.#requests.filter(entry => entry.fn === fn).length; }
  inFlight() { return this.#inFlight.size; }
  signTestJwt(claims: Record<string, unknown>) { return signJwt(this.#jwtSecret, claims); }

  report(): SupabaseShimReport {
    const rpcCalls: Record<string, Record<string, number>> = {};
    for (const entry of this.#requests) {
      if (!entry.fn) continue;
      const bucket = rpcCalls[entry.fn] ??= {};
      const key = `${entry.role ?? 'none'}:${entry.status}`;
      bucket[key] = (bucket[key] ?? 0) + 1;
    }
    const auth = new Map<ShimAuthEvent['type'], { ok: number; failed: number }>();
    for (const event of this.#authEvents) {
      const bucket = auth.get(event.type) ?? { ok: 0, failed: 0 };
      if (event.ok) bucket.ok += 1; else bucket.failed += 1;
      auth.set(event.type, bucket);
    }
    return {
      version: 2,
      runId: this.runId,
      ok: this.#unknown.length === 0 && this.#rejected.length === 0 && this.#internal.length === 0 && this.#stopErrors.length === 0,
      isolation: { ...this.isolation },
      http: this.httpUrl ? { url: this.httpUrl } : null,
      https: this.httpsUrl && this.httpsPort !== null && this.ca
        ? { url: this.httpsUrl, port: this.httpsPort, preferredPort: this.#httpsPreferredPort, fallback: this.httpsFallback, ipv6: this.#httpsIpv6, caFingerprintSha256: this.ca.caFingerprintSha256 }
        : null,
      unknownRoutes: this.unknownRoutes(),
      rejectedOrigins: this.rejectedOrigins(),
      internalErrors: this.#internal.map(entry => ({ ...entry })),
      interruptedAtStop: this.#interrupted.map(entry => ({ ...entry })),
      stopErrors: [...this.#stopErrors],
      requestCount: this.#requests.length,
      rpcCalls,
      authEvents: [...auth.entries()].map(([type, counts]) => ({ type, ...counts })),
      superuserOwnedDefinerFunctions: this.#superuserDefiners,
      knownDifferences: [...SHIM_KNOWN_DIFFERENCES],
    };
  }

  async dump(): Promise<{ relay: ShimTableDump; dialogue: ShimTableDump }> {
    const table = async (qualified: string, order: string) => {
      const { rows } = await this.#db.query<{ body: string }>(
        `select coalesce(json_agg(t), '[]'::json)::text as body from (select * from ${qualified} order by ${order}) t`);
      return redactForEvidence(JSON.parse(rows[0]?.body ?? '[]')) as unknown[];
    };
    const relayTables: Record<string, unknown[]> = {};
    for (const name of REMOTE_CONTROL_RELAY_TABLES) relayTables[name] = await table(`public.${quoteIdent(name)}`, '1');
    const dialogueTables: Record<string, unknown[]> = {};
    for (const name of AGENT_DIALOGUE_TABLES) dialogueTables[name] = await table(`public.${quoteIdent(name)}`, '1');
    return {
      relay: { tables: relayTables, audit: { relay_messages: await table('emulator_audit.relay_messages', 'audit_id') } },
      dialogue: { tables: dialogueTables, audit: { dialogue_controls: await table('emulator_audit.dialogue_controls', 'audit_id') } },
    };
  }

  stop(): Promise<SupabaseShimReport> {
    this.#stopped ??= (async () => {
      this.#stopping = true;
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
      // Bun's stop(true) resolves before the handlers it cut off have finished (measured 2026-11-01), so wait
      // for them too: otherwise their records would be missing from the report and the dumps.
      await Promise.allSettled(this.#servers.map(server => server.stop(true)));
      const drained = await Promise.race([
        Promise.allSettled([...this.#inFlight]).then(() => true),
        Bun.sleep(STOP_DRAIN_MS).then(() => false),
      ]);
      if (!drained) this.#stopErrors.push(`${this.#inFlight.size} request(s) still running ${STOP_DRAIN_MS} ms after the doors closed`);
      try {
        const evidence = this.#options.evidenceDir;
        if (evidence) {
          const write = (name: string, value: unknown) =>
            writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
          try {
            mkdirSync(evidence, { recursive: true, mode: 0o700 });
            const dumps = await this.dump();
            write(SHIM_RELAY_DUMP_FILE, dumps.relay);
            write(SHIM_DIALOGUE_DUMP_FILE, dumps.dialogue);
          } catch (error) {
            this.#stopErrors.push(`evidence dumps not written: ${message(error)}`);
          }
          try {
            write(SHIM_REPORT_FILE, this.report());
          } catch (error) {
            this.#stopErrors.push(`evidence report not written: ${message(error)}`);
          }
        }
      } finally {
        await this.#db.close().catch(error => { this.#stopErrors.push(`database close failed: ${message(error)}`); });
      }
      return this.report();
    })();
    return this.#stopped;
  }

  // ── request handling ──────────────────────────────────────────────────────────────────────

  #at(): string { return new Date(this.#now()).toISOString(); }

  #recordUnknown(request: Request, url: URL, door: ShimDoor, reason: string): Response {
    this.#unknown.push({
      at: this.#at(), door, method: request.method, path: url.pathname.slice(0, 300),
      queryKeys: [...new Set(url.searchParams.keys())].slice(0, 20), reason,
    });
    return json(404, { code: 'SHIM_UNKNOWN_ROUTE', message: `The emulator Supabase shim does not emulate this request: ${reason}` });
  }

  #cors(origin: string | null, response: Response): Response {
    if (origin === null) return response;
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Expose-Headers', 'Content-Range, X-Supabase-Api-Version');
    return response;
  }

  async #handle(request: Request, door: ShimDoor): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const meta: Pick<ShimRequestRecord, 'role' | 'fn' | 'code'> = {};
    let response: Response;
    try {
      if (this.#stopping) {
        this.#interrupted.push({ at: this.#at(), door, method: request.method, path: url.pathname.slice(0, 300) });
        meta.code = 'SHIM_STOPPING';
        response = json(503, { code: 'SHIM_STOPPING', message: 'The emulator Supabase shim is stopping.' });
      } else if (origin !== null && !this.#allowedOrigins.has(origin)) {
        this.#rejected.push({ at: this.#at(), door, method: request.method, path: url.pathname.slice(0, 300), origin: origin.slice(0, 200) });
        response = json(403, { code: 'SHIM_ORIGIN_REJECTED', message: 'This origin may not call the emulator Supabase shim.' });
      } else if (request.method === 'OPTIONS') {
        response = this.#cors(origin, this.#preflight(request, url, door));
      } else {
        const route = routeOf(request.method, url);
        // Allowed origins see every answer, the refusals included, so a browser lane can report what it hit.
        if (!route) response = this.#cors(origin, this.#recordUnknown(request, url, door, `${request.method} ${url.pathname.slice(0, 120)}`));
        else if ('unsupported' in route) response = this.#cors(origin, this.#recordUnknown(request, url, door, route.unsupported));
        else response = this.#cors(origin, await this.#dispatch(route, request, url, door, meta));
      }
    } catch (error) {
      if (this.#stopping) {
        // stop() closed the connection under this request (e.g. its body was still arriving): recorded, not a defect.
        this.#interrupted.push({ at: this.#at(), door, method: request.method, path: url.pathname.slice(0, 300) });
        meta.code = 'SHIM_STOPPING';
        response = json(503, { code: 'SHIM_STOPPING', message: 'The emulator Supabase shim is stopping.' });
      } else {
        const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        this.#internal.push({ at: this.#at(), door, path: url.pathname.slice(0, 300), message });
        response = json(500, { code: 'SHIM_INTERNAL_ERROR', message: 'The emulator Supabase shim failed internally.' });
      }
    }
    this.#requests.push({ seq: this.#requests.length + 1, at: this.#at(), door, method: request.method, path: url.pathname.slice(0, 300), status: response.status, ...meta });
    return response;
  }

  #preflight(request: Request, url: URL, door: ShimDoor): Response {
    const method = (request.headers.get('access-control-request-method') ?? '').toUpperCase();
    const route = method ? routeOf(method, url) : null;
    if (!route || 'unsupported' in route) {
      return this.#recordUnknown(request, url, door, `preflight for ${method || '(no method)'} ${url.pathname.slice(0, 120)}`);
    }
    const asked = (request.headers.get('access-control-request-headers') ?? '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    // A header outside the emulated set would make the browser fail with a bare CORS error while the report
    // stayed clean; record it like any other unemulated request instead.
    const unsupported = [...new Set(asked.filter(header => !PREFLIGHT_HEADERS.has(header)))];
    if (unsupported.length) {
      return this.#recordUnknown(request, url, door, `preflight asks for unemulated request header(s) ${unsupported.join(', ').slice(0, 120)}`);
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': asked.join(', '),
        'Access-Control-Max-Age': '600',
      },
    });
  }

  #apiKey(request: Request): { role: 'anon' | 'service_role'; claims: Record<string, unknown> } | Response {
    const key = request.headers.get('apikey');
    if (key === null || key === '') {
      return json(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
    }
    const role = sameSecret(key, this.anonKey) ? 'anon' : sameSecret(key, this.serviceRoleKey) ? 'service_role' : null;
    if (!role) return json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    // Both keys were minted by this shim; still verify (expiry) rather than trust the bytes.
    const checked = verifyJwt(this.#jwtSecret, key, Math.floor(this.#now() / 1000));
    if (!checked.ok || checked.claims.role !== role) return json(401, { message: 'Invalid API key', hint: 'The fixture API key expired.' });
    return { role, claims: checked.claims };
  }

  async #readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
    const text = await request.text();
    if (!text.trim()) return {};
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  async #dispatch(route: Route, request: Request, url: URL, door: ShimDoor, meta: Pick<ShimRequestRecord, 'role' | 'fn' | 'code'>): Promise<Response> {
    const key = this.#apiKey(request);
    if (key instanceof Response) return key;
    switch (route.kind) {
      case 'rpc': return this.#rpc(route.fn, request, url, door, key.claims, meta);
      case 'empty-policy-read': {
        // This is an explicitly empty fixture, not a general table emulator. Do not
        // silently answer other queries or tokens as if RLS had been evaluated.
        const authorization = request.headers.get('authorization');
        if (key.role !== 'service_role' || (authorization !== null && authorization !== `Bearer ${this.serviceRoleKey}`)) return json(403, {code: '42501', message: 'fixture policy read requires service role'});
        const params = [...url.searchParams.entries()];
        const select = url.searchParams.get('select');
        const ids = url.searchParams.get('memory_id');
        if (params.length !== 2 || select !== 'memory_id,capture_configured,capture_enabled,capture_enabled_at,retention_days,analysis_allowed,updated_at' || !ids || !/^in\.\([0-9a-fA-F,\-]+\)$/.test(ids) || request.headers.has('prefer')) return this.#recordUnknown(request, url, door, 'unsupported fixture policy query');
        meta.role = 'service_role';
        return json(200, []);
      }
      case 'device-alias-read': {
        // Exact api-server lookup only. The canonical table's service_role grant and RLS remain in force: query it as
        // that role, rather than inventing an empty answer or accepting arbitrary PostgREST table requests.
        const authorization = request.headers.get('authorization');
        if (key.role !== 'service_role' || (authorization !== null && authorization !== `Bearer ${this.serviceRoleKey}`))
          return json(403, {code:'42501', message:'fixture alias read requires service role'});
        const params = [...url.searchParams.entries()], canonical = url.searchParams.get('canonical_device_id');
        const id = canonical?.match(/^eq\.([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/)?.[1];
        if (params.length !== 3 || url.searchParams.get('select') !== 'alias_device_id' || url.searchParams.get('limit') !== '500' || !id || request.headers.has('prefer'))
          return this.#recordUnknown(request, url, door, 'unsupported fixture alias query');
        meta.role = 'service_role';
        const rows = await this.#db.transaction(async tx => {
          await tx.exec('set local role service_role');
          return (await tx.query('select alias_device_id from public.portmgr_device_identity_aliases where canonical_device_id = $1 limit 500', [id])).rows;
        });
        return json(200, rows);
      }
      case 'otp': return this.#otp(request, url, door);
      case 'verify': return this.#verify(request, url, door);
      case 'user': return this.#user(request, door);
      case 'refresh': return this.#refreshToken(request, url, door);
      case 'logout': return this.#logout(request, url, door);
    }
  }

  // ── PostgREST RPC ─────────────────────────────────────────────────────────────────────────

  async #catalog(fn: string): Promise<CatalogFunction[]> {
    const cached = this.#functions.get(fn);
    if (cached) return cached;
    const { rows } = await this.#db.query<{
      volatility: string; returns_set: boolean; returns_void: boolean; returns_composite: boolean;
      nargs: number; ndefaults: number; arg_names: string[]; arg_modes: string[]; arg_types: string[];
    }>(CATALOG_SQL, [fn]);
    const functions = rows.map(row => {
      const inArgs: { name: string; type: string }[] = [];
      row.arg_types.forEach((type, index) => {
        const mode = row.arg_modes.length ? row.arg_modes[index] : 'i';
        if (mode === 'i' || mode === 'b' || mode === 'v') inArgs.push({ name: row.arg_names[index] ?? '', type });
      });
      return {
        inArgs,
        required: row.nargs - row.ndefaults,
        volatility: (row.volatility === 'i' || row.volatility === 's' ? row.volatility : 'v') as CatalogFunction['volatility'],
        returnsSet: row.returns_set,
        returnsComposite: row.returns_composite,
        returnsVoid: row.returns_void,
      };
    });
    this.#functions.set(fn, functions);
    return functions;
  }

  async #rpc(fn: string, request: Request, url: URL, door: ShimDoor, keyClaims: Record<string, unknown>, meta: Pick<ShimRequestRecord, 'role' | 'fn' | 'code'>): Promise<Response> {
    meta.fn = fn;
    // PostgREST reads the role from the bearer token; Supabase's gateway substitutes the apikey when absent.
    let claims = keyClaims;
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const match = authorization.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
      const checked = match ? verifyJwt(this.#jwtSecret, match[1]!, Math.floor(this.#now() / 1000)) : { ok: false as const, reason: 'malformed' as const };
      if (!checked.ok) {
        meta.code = checked.reason === 'expired' ? 'PGRST303' : 'PGRST301';
        return json(401, {
          code: meta.code, details: null, hint: null,
          message: checked.reason === 'expired' ? 'JWT expired' : `JWT could not be verified (${checked.reason})`,
        }, { 'WWW-Authenticate': `Bearer error="invalid_token"` });
      }
      claims = checked.claims;
    }
    const role = claims.role as ShimRole;
    meta.role = role;
    if ([...url.searchParams.keys()].length) {
      return this.#recordUnknown(request, url, door, `query parameters on an RPC (${[...new Set(url.searchParams.keys())].join(',').slice(0, 80)})`);
    }
    if (request.headers.get('prefer') !== null) return this.#recordUnknown(request, url, door, 'Prefer header on an RPC');
    const profile = request.headers.get('content-profile') ?? request.headers.get('accept-profile');
    if (profile !== null && profile !== 'public') {
      meta.code = 'PGRST106';
      return json(406, { code: 'PGRST106', details: null, hint: null, message: 'The schema must be one of the following: public' });
    }
    const accept = (request.headers.get('accept') ?? '').toLowerCase();
    const single = accept.includes('application/vnd.pgrst.object+json');
    if (accept && !single && !accept.includes('application/json') && !accept.includes('*/*')) {
      return this.#recordUnknown(request, url, door, `Accept ${accept.slice(0, 60)} on an RPC`);
    }
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    if (type && !type.startsWith('application/json')) return this.#recordUnknown(request, url, door, `Content-Type ${type.slice(0, 60)} on an RPC`);
    const body = await this.#readJsonObject(request);
    if (!body) {
      meta.code = 'PGRST102';
      return json(400, { code: 'PGRST102', details: null, hint: null, message: 'Request body must be a JSON object' });
    }
    const keys = Object.keys(body);
    const candidates = (await this.#catalog(fn)).filter(candidate => {
      const names = candidate.inArgs.map(arg => arg.name);
      return keys.every(name => names.includes(name)) && names.slice(0, candidate.required).every(name => keys.includes(name));
    });
    if (candidates.length !== 1) {
      meta.code = candidates.length ? 'PGRST203' : 'PGRST202';
      return json(candidates.length ? 300 : 404, {
        code: meta.code, details: null, hint: null,
        message: candidates.length
          ? `Could not choose the best candidate function between overloads of public.${fn}`
          : `Could not find the function public.${fn}(${[...keys].sort().join(', ')}) in the schema cache`,
      });
    }
    const target = candidates[0]!;
    const used = target.inArgs.filter(arg => keys.includes(arg.name));
    const call = `public.${quoteIdent(fn)}(${used.map(arg => `${quoteIdent(arg.name)} := _a.${quoteIdent(arg.name)}`).join(', ')})`;
    const source = used.length ? `json_to_record($1::json) as _a(${used.map(arg => `${quoteIdent(arg.name)} ${arg.type}`).join(', ')})` : '';
    const sql = target.returnsVoid
      ? `select ${call}${source ? ` from ${source}` : ''}`
      : `select coalesce(json_agg(_t), '[]'::json)::text as body from ${source ? `${source} cross join lateral ` : ''}${call} as _t`;
    const params = used.length ? [JSON.stringify(body)] : [];
    const settings = [
      JSON.stringify(claims), role, typeof claims.sub === 'string' ? claims.sub : '',
      typeof claims.email === 'string' ? claims.email : '', 'POST', url.pathname,
    ];
    let text: string | null = null;
    try {
      await this.#db.transaction(async tx => {
        // PostgREST runs stable/immutable functions read-only; a "stable" function that writes fails there too.
        if (target.volatility !== 'v') await tx.exec('set transaction read only');
        await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', $2, true),
          set_config('request.jwt.claim.sub', $3, true), set_config('request.jwt.claim.email', $4, true),
          set_config('request.method', $5, true), set_config('request.path', $6, true),
          set_config('search_path', 'public, extensions', true)`, settings);
        // `role` passed verifyJwt's allowlist; it is one of three fixed identifiers.
        await tx.exec(`set local role ${quoteIdent(role)}`);
        const result = await tx.query<{ body?: string }>(sql, params);
        text = target.returnsVoid ? null : result.rows[0]?.body ?? '[]';
      });
    } catch (error) {
      const raw = error as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
      const code = typeof raw.code === 'string' ? raw.code : 'XX000';
      meta.code = code;
      return json(postgrestHttpStatus(code, role), {
        code,
        details: typeof raw.detail === 'string' ? raw.detail : null,
        hint: typeof raw.hint === 'string' ? raw.hint : null,
        message: typeof raw.message === 'string' ? raw.message : 'database error',
      });
    }
    if (target.returnsVoid) return new Response(null, { status: 204 });
    const rows = JSON.parse(text ?? '[]') as unknown[];
    const payload = target.returnsSet ? rows : rows[0] ?? null;
    if (single) {
      const list = Array.isArray(payload) ? payload : [payload];
      if (list.length !== 1) {
        meta.code = 'PGRST116';
        return json(406, { code: 'PGRST116', details: `The result contains ${list.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
      }
      return json(200, list[0], { 'Content-Type': 'application/vnd.pgrst.object+json; charset=utf-8' });
    }
    return json(200, payload);
  }

  // ── GoTrue subset ────────────────────────────────────────────────────────────────────────

  #authError(request: Request, status: number, code: string, message: string): Response {
    // auth-js reads `code` as the error code only when the response declares API version >= 2024-01-01.
    if (request.headers.get('x-supabase-api-version')) {
      return json(status, { code, message }, { 'X-Supabase-Api-Version': GOTRUE_API_VERSION });
    }
    return json(status, { code: status, error_code: code, msg: message });
  }

  #authOk(body: unknown, status = 200): Response {
    return body === undefined
      ? new Response(null, { status, headers: { 'X-Supabase-Api-Version': GOTRUE_API_VERSION } })
      : json(status, body, { 'X-Supabase-Api-Version': GOTRUE_API_VERSION });
  }

  #event(event: Omit<ShimAuthEvent, 'at'>): void {
    this.#authEvents.push({ at: this.#at(), ...event });
  }

  async #userRow(id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.#db.query<{ body: string }>(
      `select json_build_object('id', id, 'aud', aud, 'role', role, 'email', email, 'phone', '',
         'email_confirmed_at', email_confirmed_at, 'confirmed_at', email_confirmed_at,
         'last_sign_in_at', last_sign_in_at, 'app_metadata', raw_app_meta_data,
         'user_metadata', raw_user_meta_data, 'identities', '[]'::json,
         'created_at', created_at, 'updated_at', updated_at, 'is_anonymous', false)::text as body
       from auth.users where id = $1`, [id]);
    return rows[0] ? JSON.parse(rows[0].body) as Record<string, unknown> : null;
  }

  /** A fresh refresh token in `sessionId`; `parent` is the token it was swapped from (GoTrue's refresh_tokens.parent). */
  #newRefreshToken(sessionId: string, parent: string | null): string {
    const token = randomBytes(18).toString('base64url');
    this.#refresh.set(token, { sessionId, revoked: false, parent, updatedAt: this.#now(), seq: ++this.#refreshSeq });
    return token;
  }

  /** A new access token for the session, paired with the given refresh token (new or GoTrue's "active" one). */
  async #sessionBody(url: URL, userId: string, sessionId: string, refreshToken: string): Promise<Record<string, unknown>> {
    const user = await this.#userRow(userId);
    if (!user) throw new Error('user vanished while issuing a session');
    const iat = Math.floor(this.#now() / 1000);
    const ttl = this.#options.accessTokenTtlSeconds ?? 3600;
    const accessToken = signJwt(this.#jwtSecret, {
      aud: 'authenticated', exp: iat + ttl, iat, iss: `${url.origin}/auth/v1`, sub: userId,
      email: user.email, phone: '', app_metadata: user.app_metadata, user_metadata: user.user_metadata,
      role: 'authenticated', aal: 'aal1', amr: [{ method: 'otp', timestamp: iat }], session_id: sessionId, is_anonymous: false,
    });
    return { access_token: accessToken, token_type: 'bearer', expires_in: ttl, expires_at: iat + ttl, refresh_token: refreshToken, user };
  }

  async #otp(request: Request, url: URL, door: ShimDoor): Promise<Response> {
    if ([...url.searchParams.keys()].some(name => name !== 'redirect_to')) return this.#recordUnknown(request, url, door, 'unexpected /otp query');
    const body = await this.#readJsonObject(request);
    if (!body) return this.#authError(request, 400, 'bad_json', 'Could not parse request body as JSON');
    if (body.phone !== undefined || typeof body.email !== 'string') return this.#recordUnknown(request, url, door, 'otp without an email (phone/SMS is not emulated)');
    const email = body.email.trim().toLowerCase();
    const user = this.#users.find(candidate => candidate.email === email);
    if (!user) {
      if (body.create_user !== false) return this.#recordUnknown(request, url, door, 'otp sign-up (create_user) is not emulated');
      this.#event({ door, type: 'otp', email, ok: false, code: 'otp_disabled' });
      return this.#authError(request, 422, 'otp_disabled', 'Signups not allowed for otp');
    }
    // Delivered "by mail": the code is the run's fixed code, handed to the lane through the credentials file.
    this.#pendingOtp.set(email, this.#now());
    this.#event({ door, type: 'otp', email, ok: true });
    return this.#authOk({});
  }

  async #verify(request: Request, url: URL, door: ShimDoor): Promise<Response> {
    if ([...url.searchParams.keys()].some(name => name !== 'redirect_to')) return this.#recordUnknown(request, url, door, 'unexpected /verify query');
    const body = await this.#readJsonObject(request);
    if (!body) return this.#authError(request, 400, 'bad_json', 'Could not parse request body as JSON');
    if (body.type !== 'email' || typeof body.email !== 'string' || typeof body.token !== 'string' || body.token_hash !== undefined) {
      return this.#recordUnknown(request, url, door, `verify type ${String(body.type).slice(0, 20)} (only email + code is emulated)`);
    }
    const email = body.email.trim().toLowerCase();
    const requestedAt = this.#pendingOtp.get(email);
    const fresh = requestedAt !== undefined && this.#now() - requestedAt <= (this.#options.otpTtlSeconds ?? 3600) * 1000;
    const user = this.#users.find(candidate => candidate.email === email);
    if (!user || !fresh || !sameSecret(body.token, this.otpCode)) {
      this.#event({ door, type: 'verify', email, ok: false, code: 'otp_expired' });
      return this.#authError(request, 403, 'otp_expired', 'Token has expired or is invalid');
    }
    this.#pendingOtp.delete(email); // single use
    await this.#db.query('update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1', [user.id]);
    const sessionId = randomUUID();
    this.#sessions.set(sessionId, { userId: user.id });
    this.#event({ door, type: 'verify', email, ok: true });
    return this.#authOk(await this.#sessionBody(url, user.id, sessionId, this.#newRefreshToken(sessionId, null)));
  }

  #bearerUser(request: Request): { userId: string; sessionId: string } | { status: number; code: string; message: string } {
    const match = (request.headers.get('authorization') ?? '').match(/^Bearer ([A-Za-z0-9_.-]+)$/);
    if (!match) return { status: 401, code: 'no_authorization', message: 'This endpoint requires a valid Bearer token' };
    const checked = verifyJwt(this.#jwtSecret, match[1]!, Math.floor(this.#now() / 1000));
    if (!checked.ok) {
      return { status: 403, code: 'bad_jwt', message: checked.reason === 'expired' ? 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired' : 'invalid JWT: unable to parse or verify signature' };
    }
    const { sub, session_id: sessionId, role } = checked.claims;
    if (role !== 'authenticated' || typeof sub !== 'string') return { status: 403, code: 'bad_jwt', message: 'invalid claim: missing sub claim' };
    const session = typeof sessionId === 'string' ? this.#sessions.get(sessionId) : undefined;
    if (!session || session.userId !== sub) {
      return { status: 403, code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' };
    }
    return { userId: sub, sessionId: sessionId as string };
  }

  async #user(request: Request, door: ShimDoor): Promise<Response> {
    const who = this.#bearerUser(request);
    if ('status' in who) {
      this.#event({ door, type: 'user', ok: false, code: who.code });
      return this.#authError(request, who.status, who.code, who.message);
    }
    const user = await this.#userRow(who.userId);
    if (!user) return this.#authError(request, 403, 'user_not_found', 'User from sub claim in JWT does not exist');
    this.#event({ door, type: 'user', ok: true });
    return this.#authOk(user);
  }

  /**
   * GoTrue's RefreshTokenGrant (supabase/auth internal/tokens/service.go, read 2026-11-01):
   *   - unknown token, or its session was logged out → 400 refresh_token_not_found;
   *   - a used token that is the parent of the session's newest active token → that active token again, with a
   *     new access token (the client lost the previous response);
   *   - any other used token → still swapped while now <= its updated_at + reuse interval; past that, every
   *     refresh token of the session is revoked (updated_at = now) and 400 refresh_token_already_used. The
   *     session itself stays, so access tokens already issued keep working until they expire;
   *   - an active token → revoked and swapped for a child token.
   * Every swap (models.GrantRefreshTokenSwap) writes the presented token's updated_at = now, also when it was
   * already used, so a reuse inside the interval moves that token's interval forward. Handing back the active
   * token does not touch the presented token.
   */
  async #refreshToken(request: Request, url: URL, door: ShimDoor): Promise<Response> {
    const body = await this.#readJsonObject(request);
    if (!body || typeof body.refresh_token !== 'string') return this.#authError(request, 400, 'validation_failed', 'refresh_token required');
    const token = body.refresh_token;
    const record = this.#refresh.get(token);
    const session = record ? this.#sessions.get(record.sessionId) : undefined;
    if (!record || !session) {
      this.#event({ door, type: 'refresh', ok: false, code: 'refresh_token_not_found' });
      return this.#authError(request, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    }
    const now = this.#now();
    let issued: string | null = null;
    if (record.revoked) {
      let active: [string, RefreshRecord] | null = null;
      for (const entry of this.#refresh) {
        if (entry[1].sessionId === record.sessionId && !entry[1].revoked && (!active || entry[1].seq > active[1].seq)) active = entry;
      }
      if (active && active[1].parent === token) {
        issued = active[0];
      } else {
        const reuseMs = (this.#options.refreshTokenReuseIntervalSeconds ?? SHIM_DEFAULT_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS) * 1000;
        if (now > record.updatedAt + reuseMs) {
          for (const other of this.#refresh.values()) {
            if (other.sessionId === record.sessionId && !other.revoked) { other.revoked = true; other.updatedAt = now; }
          }
          this.#event({ door, type: 'refresh', ok: false, code: 'refresh_token_already_used' });
          return this.#authError(request, 400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
        }
      }
    }
    if (issued === null) {
      // GrantRefreshTokenSwap sets revoked and calls UpdateOnly(token, "revoked") even on a used token, and pop
      // writes updated_at = now() on every update (storage/dial.go getExcludedColumns never excludes it). So each
      // swap — a reuse inside the interval too — restarts this token's reuse interval.
      record.revoked = true;
      record.updatedAt = now;
      issued = this.#newRefreshToken(record.sessionId, token);
    }
    this.#event({ door, type: 'refresh', ok: true });
    return this.#authOk(await this.#sessionBody(url, session.userId, record.sessionId, issued));
  }

  /** GoTrue deletes the sessions (and with them their refresh tokens); access tokens then fail with session_not_found. */
  #deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [token, record] of this.#refresh) if (record.sessionId === sessionId) this.#refresh.delete(token);
  }

  async #logout(request: Request, url: URL, door: ShimDoor): Promise<Response> {
    const scope = url.searchParams.get('scope') ?? 'global';
    if (!['global', 'local', 'others'].includes(scope) || [...url.searchParams.keys()].some(name => name !== 'scope')) {
      return this.#recordUnknown(request, url, door, 'unexpected /logout query');
    }
    const who = this.#bearerUser(request);
    if ('status' in who) {
      this.#event({ door, type: 'logout', ok: false, code: who.code });
      return this.#authError(request, who.status, who.code, who.message);
    }
    for (const [id, session] of [...this.#sessions]) {
      if (session.userId !== who.userId) continue;
      if (scope === 'global' || (scope === 'local' && id === who.sessionId) || (scope === 'others' && id !== who.sessionId)) this.#deleteSession(id);
    }
    this.#event({ door, type: 'logout', ok: true });
    return this.#authOk(undefined, 204);
  }
}

/** Start a shim: database first (fails fast on schema drift), then the doors, then the credentials file. */
export async function startSupabaseShim(options: SupabaseShimOptions): Promise<SupabaseShim> {
  // Every refusal happens here, before a folder is created, a database opened or a port bound.
  validateSupabaseShimOptions(options);
  mkdirSync(options.scratchDir, { recursive: true, mode: 0o700 });
  chmodSync(options.scratchDir, 0o700);
  // Fail fast on an evidence folder that cannot be created, rather than only at stop().
  if (options.evidenceDir !== undefined) mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  const shim = new SupabaseShimServer(options, db);
  try {
    await shim.initialize();
    await shim.listen();
    shim.writeCredentials();
  } catch (error) {
    await shim.stop().catch(() => undefined);
    throw error;
  }
  return shim;
}

/** Alias for orchestrators that expect start()/stop(). */
export const start = startSupabaseShim;

// ── Client self-check (drives the real product clients against a running shim) ────────────────

export interface ShimSelfcheckResult {
  ok: boolean;
  door: ShimDoor;
  url: string;
  /** Of the process that ran the product clients; "not-sandboxed" means this run is not an isolated one. */
  isolation: ShimIsolation;
  checks: { name: string; ok: boolean; detail?: unknown; error?: { code?: string; message: string } }[];
}

/** Input checks of runShimClientSelfcheck, before any folder, import or request. Exported for fake-home tests. */
export function validateShimSelfcheckInput(input: { credentials: SupabaseShimCredentials; door: ShimDoor; appDataDir: string }, home: string = shimRealHome()): string {
  if (input.door !== 'http' && input.door !== 'https') throw new Error('supabase shim self-check: door must be http or https');
  const doorInfo = input.door === 'http' ? input.credentials?.http : input.credentials?.https;
  if (!doorInfo || typeof doorInfo.url !== 'string') throw new Error(`supabase shim self-check: the ${input.door} door is not open`);
  // Never production (or any other) Supabase: the check registers hosts and writes pairings and dialogue rows.
  const url = assertLoopbackShimUrl(doorInfo.url, input.door).origin;
  assertShimPathAllowed(input.appDataDir, 'appDataDir', 'outside-real-home', home);
  return url;
}

class SelfcheckFailure extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function errorInfo(error: unknown): { code?: string; message: string } {
  const raw = error as { code?: unknown; kind?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof raw?.code === 'string' ? raw.code
    : typeof raw?.cause?.code === 'string' ? raw.cause.code
      : typeof raw?.kind === 'string' ? raw.kind : undefined;
  return { ...(code ? { code } : {}), message: (typeof raw?.message === 'string' ? raw.message : String(error)).slice(0, 300) };
}

/**
 * Real product code on the client side of every door:
 *   - RemoteControlRelayHostRpcTransport over createServiceRoleRemoteControlRelayRpcInvoker (the sidecar's raw fetch),
 *   - RemoteControlRelayControllerRpcClient over supabase-js signed in with the portal's own email-code functions,
 *   - RemoteControlInternetAgent for register → create_pairing → claim → approve (SAS compared) → controller_send →
 *     host_receive → host_send → controller_receive, plus one action executed exactly once,
 *   - two AgentDialogueHosts over supabase-js with the service-role key (as api-server.ts wires it): control call + poll,
 *   - grant/RLS refusals for anon, a signed-in member and service_role on the wrong functions.
 */
export async function runShimClientSelfcheck(input: {
  credentials: SupabaseShimCredentials;
  door: ShimDoor;
  appDataDir: string;
}): Promise<ShimSelfcheckResult> {
  const url = validateShimSelfcheckInput(input);
  const { anonKey, serviceRoleKey, otpCode } = input.credentials;
  const member = input.credentials.users.find(user => user.member)?.email;
  const outsider = input.credentials.users.find(user => !user.member)?.email ?? null;
  if (!member) throw new Error('supabase shim self-check: no member user');
  mkdirSync(input.appDataDir, { recursive: true, mode: 0o700 });
  const isolation = measureShimIsolation();
  const checks: ShimSelfcheckResult['checks'] = [];
  const result = (): ShimSelfcheckResult => ({ ok: checks.every(entry => entry.ok), door: input.door, url, isolation: { ...isolation }, checks });
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      const detail = await run();
      checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      checks.push({ name, ok: false, error: errorInfo(error) });
      throw new SelfcheckFailure(name);
    }
  };
  const rawRpc = async (fn: string, key: string, bearer: string, args: Record<string, unknown>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  };
  /** GoTrue's own answer for an access token: 200, or the status/code that refused it. */
  const sessionState = async (accessToken: string) => {
    const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'X-Supabase-Api-Version': GOTRUE_API_VERSION } });
    const body = await response.json().catch(() => null) as { code?: string } | null;
    return response.status === 200 ? 'live' : `${response.status}/${body?.code ?? '?'}`;
  };
  const rawRefresh = async (refreshToken: string) => {
    const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json', 'X-Supabase-Api-Version': GOTRUE_API_VERSION },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as { code?: string; refresh_token?: string } | null };
  };
  const expectDenied = (outcome: { status: number; body: Record<string, unknown> | null }, status: number, label: string) => {
    if (outcome.status !== status || outcome.body?.code !== '42501') {
      throw new SelfcheckFailure(`${label}: expected ${status}/42501, got ${outcome.status}/${String(outcome.body?.code)}`);
    }
    return { status: outcome.status, code: outcome.body.code };
  };

  const [
    { createClient },
    { requestPortalEmailCode, verifyPortalEmailCode, PortalEmailCodeError },
    relayClient,
    { RemoteControlInternetAgent },
    { REMOTE_CONTROL_PROTOCOL_VERSION },
    relayContract,
    relayCrypto,
    { remoteControlRelaySasCode },
    { pairingSupabaseConfig },
    { normalizeServerSupabaseUrl },
    { AgentDialogueHost },
  ] = await Promise.all([
    import('@supabase/supabase-js'),
    import('../../src/portalEmailCodeAuth'),
    import('../../src/remoteControlRelayRpcClient'),
    import('../../src/remoteControlInternetAgent'),
    import('../../src/remoteControlCore'),
    import('../../src/remoteControlRelayContract'),
    import('../../src/remoteControlRelayCrypto'),
    import('../../src/remoteControlRelaySas'),
    import('../../src/remoteControlPairingSupabase'),
    import('../../server-supabase-service'),
    import('../../src/agentDialogueHost'),
  ]);
  const hostRegisterArgs = {
    p_host_id: randomUUID(), p_display_name: 'shim check', p_public_key: 'A'.repeat(87), p_host_secret: 'x'.repeat(43), p_ttl_seconds: 600,
  };

  try {
    await step('transport', async () => {
      // A refusal proves the request crossed the door (TLS included) and reached Postgres' grant check.
      const outcome = await rawRpc('portmgr_is_member', anonKey, anonKey, {});
      return expectDenied(outcome, 401, 'anon portmgr_is_member');
    });
    await step('anon-denied-service-functions', async () => ({
      registerHost: expectDenied(await rawRpc('portmgr_remote_control_register_host', anonKey, anonKey, hostRegisterArgs), 401, 'anon register_host'),
      dialogue: expectDenied(await rawRpc('portmgr_agent_dialogue_call', anonKey, anonKey, {
        p_operation: 'peers', p_profile_id: randomUUID(), p_device_id: randomUUID(), p_secret: 'x'.repeat(44), p_args: {},
      }), 401, 'anon agent_dialogue_call'),
    }));

    const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' as const };
    const phone = createClient(url, anonKey, { auth });
    await step('email-code-login', async () => {
      const unknownAccount = await requestPortalEmailCode(phone, 'nobody@emulator.test').then(() => 'accepted', error => error instanceof PortalEmailCodeError ? error.kind : 'other');
      if (unknownAccount !== 'no-account') throw new SelfcheckFailure(`unknown email answered ${unknownAccount}`);
      const email = await requestPortalEmailCode(phone, member);
      const wrong = otpCode.slice(0, -1) + String((Number(otpCode.at(-1)) + 1) % 10);
      const wrongKind = await verifyPortalEmailCode(phone, email, wrong).then(() => 'accepted', error => error instanceof PortalEmailCodeError ? error.kind : 'other');
      if (wrongKind !== 'invalid-code') throw new SelfcheckFailure(`a wrong code answered ${wrongKind}`);
      await verifyPortalEmailCode(phone, email, otpCode);
      const { data, error } = await phone.auth.getUser();
      if (error || data.user?.email !== member) throw new SelfcheckFailure(`getUser after sign-in: ${error?.message ?? data.user?.email}`);
      const replay = await verifyPortalEmailCode(phone, email, otpCode).then(() => 'accepted', error => error instanceof PortalEmailCodeError ? error.kind : 'other');
      if (replay !== 'invalid-code') throw new SelfcheckFailure(`a used code answered ${replay}`);
      return { unknownAccount, wrongCode: wrongKind, usedCode: replay };
    });
    await step('member-rpc', async () => {
      const { data, error } = await phone.rpc('portmgr_is_member');
      if (error || data !== true) throw new SelfcheckFailure(`portmgr_is_member: ${error?.message ?? String(data)}`);
      return { member: true };
    });
    await step('member-denied-host-functions', async () => {
      const { error, status } = await phone.rpc('portmgr_remote_control_register_host', hostRegisterArgs);
      if (status !== 403 || error?.code !== '42501') throw new SelfcheckFailure(`member register_host: ${status}/${error?.code}`);
      return { status, code: error.code };
    });
    const service = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await step('service-denied-controller-functions', async () => {
      const { error, status } = await service.rpc('portmgr_remote_control_claim_pairing', {
        p_pairing_id: randomUUID(), p_pairing_secret: 'x'.repeat(43), p_controller_name: 'x', p_controller_public_key: 'A'.repeat(87),
      });
      if (status !== 403 || error?.code !== '42501') throw new SelfcheckFailure(`service claim_pairing: ${status}/${error?.code}`);
      return { status, code: error.code };
    });

    await step('relay-roundtrip', async () => {
      const host = new relayClient.RemoteControlRelayHostRpcTransport(
        relayClient.createServiceRoleRemoteControlRelayRpcInvoker({ supabaseUrl: url, serviceRoleKey }));
      const controller = new relayClient.RemoteControlRelayControllerRpcClient(relayClient.createSupabaseRemoteControlRelayRpcInvoker(phone));
      const executions: string[] = [];
      const agent = new RemoteControlInternetAgent({
        gateway: {
          listRegisteredProjects: () => [{ internalId: 'p', name: '에뮬레이터 프로젝트', port: 4317, kind: 'main' as const, folderPath: '/nonexistent/emulator', command: 'true', status: 'stopped' as const, actions: ['start' as const] }],
          executeRegisteredProjectAction: async request => { executions.push(request.actionId); },
        },
        transport: host,
        controllerOrigin: 'https://portal.test',
        hostName: '에뮬레이터 Mac',
        autoPoll: false,
        pairingSupabase: () => pairingSupabaseConfig({ supabaseUrl: url, supabaseAnonKey: anonKey }, serviceRoleKey, normalizeServerSupabaseUrl),
      });
      const qr = relayContract.parseRemoteControlRelayPairingUrl((await agent.initialize()).pairingUrl);
      const qrSupabase = qr.bootstrap.supabase?.url ?? null;
      // The production rule this harness exists to exercise: only an https project rides in the QR.
      const expectedSupabase = input.door === 'https' ? new URL(url).origin : null;
      if (qrSupabase !== expectedSupabase) throw new SelfcheckFailure(`QR supabase field ${qrSupabase} (expected ${expectedSupabase})`);
      const phoneKeys = await relayCrypto.generateRemoteControlRelayKeyPair();
      const phonePublicKey = await relayCrypto.exportRemoteControlRelayPublicKey(phoneKeys.publicKey);
      const claim = await controller.claimPairing({ pairingId: qr.bootstrap.pairingId, pairingSecret: qr.bootstrap.pairingSecret, controllerName: '에뮬레이터 iPhone', controllerPublicKey: phonePublicKey });
      const phoneSas = await remoteControlRelaySasCode({ hostPublicKey: qr.bootstrap.hostPublicKey, controllerPublicKey: phonePublicKey, pairingSecret: qr.bootstrap.pairingSecret });
      await agent.pollNow();
      const hostSas = agent.status().sessions.find(session => session.sessionId === claim.sessionId)?.sasCode ?? null;
      if (!hostSas || hostSas !== phoneSas) throw new SelfcheckFailure('host and phone SAS differ');
      // Scripted approval: the Mac-screen comparison a person would make (scriptedApproval in the lane receipts).
      await agent.approveSession(claim.sessionId, phoneSas);
      const hostPublic = await relayCrypto.importRemoteControlRelayPublicKey(qr.bootstrap.hostPublicKey);
      const keyInput = { privateKey: phoneKeys.privateKey, peerPublicKey: hostPublic, sessionId: claim.sessionId, controllerId: claim.controllerId };
      const sendKey = await relayCrypto.deriveRemoteControlRelaySessionKey({ ...keyInput, direction: 'controller-to-host', usages: ['encrypt'] });
      const receiveKey = await relayCrypto.deriveRemoteControlRelaySessionKey({ ...keyInput, direction: 'host-to-controller', usages: ['decrypt'] });
      let sequence = 0;
      const send = async (payload: unknown) => {
        sequence += 1;
        const envelope = await relayCrypto.encryptRemoteControlRelayEnvelope({
          key: sendKey,
          metadata: { schemaVersion: relayContract.REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: randomUUID(), sessionId: claim.sessionId, controllerId: claim.controllerId, sequence, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
          plaintext: new TextEncoder().encode(JSON.stringify(payload)),
          now: Date.now(),
        });
        await controller.sendEnvelope(claim.hostId, claim.sessionId, envelope);
      };
      let cursor = '0', received = 0;
      const inbox = async () => {
        const delivered = await controller.receiveEnvelopes(claim.hostId, claim.sessionId, cursor);
        received += delivered.length;
        const bodies = await Promise.all(delivered.map(async entry => JSON.parse(new TextDecoder().decode(
          await relayCrypto.decryptRemoteControlRelayEnvelope({ key: receiveKey, envelope: entry.envelope, now: Date.now() }))) as Record<string, any>));
        const last = delivered.at(-1);
        if (last) {
          cursor = last.relaySequence;
          await controller.acknowledge(claim.hostId, claim.sessionId, cursor);
        }
        return bodies;
      };
      await send({ type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token: qr.bootstrap.pairingSecret });
      await agent.pollNow();
      const ready = (await inbox()).find(body => typeof body.sessionToken === 'string');
      if (!ready) throw new SelfcheckFailure('the host did not answer the pair message');
      const controlId = ready.projects?.[0]?.controlId;
      if (typeof controlId !== 'string') throw new SelfcheckFailure('the host listed no project');
      await send({ type: 'action.request', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken, actionId: 'emulator-start-1', action: 'start', controlId, remoteConfirmed: true });
      await agent.pollNow();
      await agent.pollNow();
      await inbox();
      if (executions.length !== 1 || executions[0] !== 'emulator-start-1') throw new SelfcheckFailure(`host executions ${JSON.stringify(executions)}`);
      return { qrSupabase, sasMatched: true, phoneMessages: sequence, hostMessages: received, executions: executions.length };
    });

    await step('dialogue-control', async () => {
      const profileId = randomUUID();
      const dialogueRpc = async (operation: string, p: string, d: string, secret: string, args: Record<string, unknown>) => {
        // The same call api-server.ts makes with the service-role client.
        const { data, error } = await service.rpc('portmgr_agent_dialogue_call', {
          p_operation: operation, p_profile_id: p, p_device_id: d, p_secret: secret, p_args: args,
        }).abortSignal(AbortSignal.timeout(15_000));
        if (error) throw new Error(/^AGENT_DIALOGUE_[A-Z_]+$/.test(error.message) ? error.message : `dialogue rpc failed: ${error.code} ${error.message}`);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AGENT_DIALOGUE_BAD_RECEIPT');
        return data as Record<string, any>;
      };
      const makeHost = (deviceId: string, name: string) => new AgentDialogueHost({
        appDataDir: mkdtempSync(join(input.appDataDir, 'dialogue-')),
        identity: () => ({ profileId, deviceId }),
        // A fixture key per device; production derives it from the OS protected store, which this must never touch.
        secret: async () => createHmac('sha256', 'emulator-dialogue').update(deviceId).digest('base64url').padEnd(44, 'x'),
        resolveTarget: async () => ({ kind: 'ops' as const, displayName: `${name} / 아젠투지(OPS)` }),
        rpc: dialogueRpc,
      });
      const a = makeHost(randomUUID(), '에뮬레이터 A'), b = makeHost(randomUUID(), '에뮬레이터 B');
      const ops = { target: 'ops' as const };
      for (const hostOf of [a, b]) await hostOf.enable(ops, true);
      for (const hostOf of [a, b]) await hostOf.uiCommunity(ops, 'join');
      const listed = await a.controlDevices();
      const target = listed.devices[0]?.endpointId;
      if (!listed.inside || !target) throw new SelfcheckFailure('A does not see B in the community');
      const seen: string[] = [];
      let polling = true;
      const poller = (async () => {
        while (polling) {
          await b.controlPoll(async request => { seen.push(String(request.kind)); return { echo: request.kind }; });
          await Bun.sleep(30);
        }
      })();
      let answer: Record<string, unknown>;
      try {
        answer = await a.controlCall(target, { kind: 'projects', requestId: `emulator-${randomUUID()}` }, 10_000);
      } finally {
        polling = false;
        await poller;
      }
      if (JSON.stringify(answer) !== JSON.stringify({ ok: true, body: { echo: 'projects' } }) || seen.join() !== 'projects') {
        throw new SelfcheckFailure(`control call answered ${JSON.stringify(answer)}, B saw ${JSON.stringify(seen)}`);
      }
      return { answer, executedOnB: seen.length };
    });

    if (outsider) {
      await step('outsider-not-member', async () => {
        const other = createClient(url, anonKey, { auth });
        await requestPortalEmailCode(other, outsider);
        await verifyPortalEmailCode(other, outsider, otpCode);
        const { data, error } = await other.rpc('portmgr_is_member');
        if (error || data !== false) throw new SelfcheckFailure(`outsider portmgr_is_member: ${error?.message ?? String(data)}`);
        // auth-js swallows 401/403/404 from /logout, so prove the logout by the session's state on both sides of it.
        const session = (await other.auth.getSession()).data.session;
        if (!session) throw new SelfcheckFailure('outsider has no session');
        const before = await sessionState(session.access_token);
        if (before !== 'live') throw new SelfcheckFailure(`outsider session before sign-out: ${before}`);
        const { error: signOutError } = await other.auth.signOut();
        if (signOutError) throw new SelfcheckFailure(`outsider signOut: ${signOutError.message}`);
        const after = await sessionState(session.access_token);
        if (after !== '403/session_not_found') throw new SelfcheckFailure(`outsider session after sign-out: ${after}`);
        return { member: false, beforeSignOut: before, afterSignOut: after };
      });
    }

    await step('refresh-and-logout', async () => {
      const before = (await phone.auth.getSession()).data.session;
      if (!before) throw new SelfcheckFailure('no session to refresh');
      const refreshed = await phone.auth.refreshSession();
      const after = refreshed.data.session;
      // Only the refresh token must rotate; two access tokens minted in the same second may be byte-identical.
      if (refreshed.error || !after || after.refresh_token === before.refresh_token) {
        throw new SelfcheckFailure(`refresh: ${refreshed.error?.message ?? 'token not rotated'}`);
      }
      const { data: stillMember, error: memberError } = await phone.rpc('portmgr_is_member');
      if (memberError || stillMember !== true) throw new SelfcheckFailure('the refreshed token was not accepted');
      // A client that lost the refresh response retries with the token it sent: GoTrue hands back the token that
      // replaced it (still active) instead of signing the client out. (Reuse past the reuse interval — the
      // "already used" case — needs a controlled clock and is covered by the shim's unit tests.)
      const retried = await rawRefresh(before.refresh_token);
      if (retried.status !== 200 || retried.body?.refresh_token !== after.refresh_token) {
        throw new SelfcheckFailure(`retried refresh: ${retried.status}/${retried.body?.code ?? (retried.body?.refresh_token === undefined ? 'no token' : 'another token')}`);
      }
      // Logout on a session nothing else has ended, proven on both sides (auth-js ignores 401/403/404 on sign-out).
      const beforeLogout = await sessionState(after.access_token);
      if (beforeLogout !== 'live') throw new SelfcheckFailure(`session before logout: ${beforeLogout}`);
      const { error: signOutError } = await phone.auth.signOut();
      if (signOutError) throw new SelfcheckFailure(`signOut: ${signOutError.message}`);
      const afterLogout = await sessionState(after.access_token);
      if (afterLogout !== '403/session_not_found') throw new SelfcheckFailure(`session after logout: ${afterLogout}`);
      const refreshAfterLogout = await rawRefresh(after.refresh_token);
      if (refreshAfterLogout.status !== 400 || refreshAfterLogout.body?.code !== 'refresh_token_not_found') {
        throw new SelfcheckFailure(`refresh after logout: ${refreshAfterLogout.status}/${refreshAfterLogout.body?.code}`);
      }
      return { rotated: true, retriedRefresh: 'active-token-returned', beforeLogout, afterLogout, refreshAfterLogout: refreshAfterLogout.body.code };
    });
  } catch (error) {
    if (!(error instanceof SelfcheckFailure)) checks.push({ name: 'unexpected', ok: false, error: errorInfo(error) });
  }
  return result();
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

/** A refusal before anything started: wrong, missing or unknown arguments, or an environment the CLI will not run in. */
export class ShimUsageError extends Error {}

type FlagKind = 'value' | 'multi' | 'switch';

/** Strict flags: unknown flags, positional extras, a missing value or a repeated single value are usage errors. */
export function parseShimFlags(argv: readonly string[], spec: Record<string, FlagKind>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const kind = spec[name];
    if (!kind) throw new ShimUsageError(name.startsWith('--') ? `unknown flag ${name}` : `unexpected argument ${JSON.stringify(name.slice(0, 80))}`);
    const values = out.get(name) ?? [];
    if (kind === 'switch') {
      if (values.length) throw new ShimUsageError(`${name} given twice`);
      values.push('true');
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ShimUsageError(`${name} needs a value`);
      if (kind === 'value' && values.length) throw new ShimUsageError(`${name} given twice`);
      values.push(value);
      index += 1;
    }
    out.set(name, values);
  }
  return out;
}

const SERVE_FLAGS: Record<string, FlagKind> = {
  '--scratch': 'value', '--evidence': 'value', '--run-id': 'value', '--member': 'multi', '--outsider': 'multi',
  '--https-port': 'value', '--require-https-port': 'switch', '--no-https': 'switch', '--no-http': 'switch',
};
const SELFCHECK_FLAGS: Record<string, FlagKind> = { '--credentials': 'value', '--door': 'value', '--app-data': 'value' };

/** Usage checks of `serve`, turned into the options startSupabaseShim gets. Throws ShimUsageError only. */
export function serveOptionsFromArgv(argv: readonly string[]): SupabaseShimOptions {
  const flags = parseShimFlags(argv, SERVE_FLAGS);
  const one = (name: string) => flags.get(name)?.[0];
  const usage = <T>(run: () => T): T => {
    try { return run(); } catch (error) { throw error instanceof ShimUsageError ? error : new ShimUsageError(error instanceof Error ? error.message : String(error)); }
  };
  const scratchDir = one('--scratch');
  if (!scratchDir || !isAbsolute(scratchDir)) throw new ShimUsageError('serve: --scratch <absolute dir> is required');
  const evidenceDir = one('--evidence');
  if (evidenceDir !== undefined && !isAbsolute(evidenceDir)) throw new ShimUsageError('serve: --evidence must be an absolute dir');
  const runId = one('--run-id');
  if (runId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(runId)) throw new ShimUsageError('serve: --run-id must be 1-64 of [A-Za-z0-9._-]');
  if (flags.has('--no-http') && flags.has('--no-https')) throw new ShimUsageError('serve: --no-http and --no-https leave no door');
  const httpsPortText = one('--https-port');
  let httpsPort: number | undefined;
  if (httpsPortText !== undefined) {
    if (!/^\d{1,5}$/.test(httpsPortText)) throw new ShimUsageError(`serve: --https-port must be a number, got ${JSON.stringify(httpsPortText.slice(0, 20))}`);
    httpsPort = Number(httpsPortText);
  }
  if (flags.has('--no-https') && (httpsPort !== undefined || flags.has('--require-https-port'))) {
    throw new ShimUsageError('serve: --https-port/--require-https-port contradict --no-https');
  }
  const members = flags.get('--member') ?? [], outsiders = flags.get('--outsider') ?? [];
  for (const email of [...members, ...outsiders]) {
    if (!EMAIL_PATTERN.test(email.trim().toLowerCase())) throw new ShimUsageError(`serve: invalid email ${JSON.stringify(email.slice(0, 80))}`);
  }
  if (!members.length && outsiders.length) throw new ShimUsageError('serve: --outsider needs at least one --member');
  const options: SupabaseShimOptions = {
    scratchDir,
    evidenceDir,
    runId,
    users: members.length ? [...members.map(email => ({ email, member: true })), ...outsiders.map(email => ({ email, member: false }))] : undefined,
    http: flags.has('--no-http') ? false : {},
    https: flags.has('--no-https') ? false : {
      ...(httpsPort !== undefined ? { preferredPort: httpsPort } : {}),
      requirePreferredPort: flags.has('--require-https-port'),
    },
  };
  // Path, port and user rules are the library's; a refusal there is the caller's mistake, not a shim failure.
  usage(() => validateSupabaseShimOptions(options));
  return options;
}

async function serveCli(argv: string[]): Promise<number> {
  const options = serveOptionsFromArgv(argv);
  // Arm the signal handlers before anything starts. Registering them after "ready" left a window in which a
  // SIGTERM took the default action: exit 143 and no evidence (seen once under load, 2026-11-01). A signal
  // that arrives during startup is kept and acted on as soon as the shim is up.
  let early: string | null = null;
  let deliver = (why: string) => { early ??= why; };
  process.on('SIGTERM', () => deliver('SIGTERM'));
  process.on('SIGINT', () => deliver('SIGINT'));
  console.log(JSON.stringify({ event: 'starting', pid: process.pid }));
  const shim = await startSupabaseShim(options);
  // No keys, codes or tokens on stdout: those are in the 0600 credentials file.
  console.log(JSON.stringify({
    event: 'ready', runId: shim.runId, pid: process.pid, httpUrl: shim.httpUrl, httpsUrl: shim.httpsUrl,
    httpsPort: shim.httpsPort, httpsFallback: shim.httpsFallback, caCertPath: shim.ca?.caCertPath ?? null,
    caFingerprintSha256: shim.ca?.caFingerprintSha256 ?? null, credentialsPath: shim.credentialsPath, isolation: shim.isolation,
  }));
  const parent = process.ppid;
  return new Promise(resolve => {
    let stopping = false;
    const finish = async (why: string) => {
      if (stopping) return;
      stopping = true;
      clearInterval(watch);
      try {
        const report = await shim.stop();
        console.log(JSON.stringify({
          event: 'stopped', why, ok: report.ok, unknownRoutes: report.unknownRoutes.length,
          rejectedOrigins: report.rejectedOrigins.length, internalErrors: report.internalErrors.length,
          interruptedAtStop: report.interruptedAtStop.length, stopErrors: report.stopErrors, requestCount: report.requestCount,
          isolation: report.isolation.status,
        }));
        resolve(report.stopErrors.length ? SHIM_EXIT_STOP_FAILED : report.ok ? 0 : SHIM_EXIT_UNSUPPORTED);
      } catch (error) {
        // stop() does not reject by contract; if it ever does, still exit with a code that says "not clean".
        console.error(JSON.stringify({ event: 'error', phase: 'stop', message: error instanceof Error ? error.message : String(error) }));
        resolve(SHIM_EXIT_STOP_FAILED);
      }
    };
    // Never outlive the orchestrator: an orphaned shim would keep a port and a database nobody reads.
    const watch = setInterval(() => { if (process.ppid !== parent) void finish('parent-exited'); }, 1000);
    deliver = why => void finish(why);
    if (early) void finish(early);
  });
}

async function selfcheckCli(argv: string[]): Promise<number> {
  const flags = parseShimFlags(argv, SELFCHECK_FLAGS);
  const path = flags.get('--credentials')?.[0], door = flags.get('--door')?.[0], appDataDir = flags.get('--app-data')?.[0];
  if (!path || !isAbsolute(path) || (door !== 'http' && door !== 'https') || !appDataDir || !isAbsolute(appDataDir)) {
    throw new ShimUsageError('client-selfcheck: --credentials <absolute file> --door http|https --app-data <absolute dir> are required');
  }
  let credentials: SupabaseShimCredentials;
  try {
    credentials = JSON.parse(readFileSync(path, 'utf8')) as SupabaseShimCredentials;
  } catch (error) {
    throw new ShimUsageError(`client-selfcheck: cannot read credentials: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
  try {
    validateShimSelfcheckInput({ credentials, door, appDataDir });
  } catch (error) {
    throw new ShimUsageError(error instanceof Error ? error.message : String(error));
  }
  const outcome = await runShimClientSelfcheck({ credentials, door, appDataDir });
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const run = command === 'serve' ? serveCli : command === 'client-selfcheck' ? selfcheckCli : null;
  const usageExit = (message: string): never => {
    console.error(JSON.stringify({ event: 'usage-error', message }));
    console.error('usage: supabaseShim.ts serve --scratch <dir> [...] | client-selfcheck --credentials <file> --door http|https --app-data <dir>');
    process.exit(SHIM_EXIT_USAGE);
  };
  if (!run) usageExit(`unknown command ${JSON.stringify(command ?? '')}`);
  // Both commands run product code (the selfcheck runs host code): refuse a real HOME, TMPDIR or app data first.
  try { assertIsolatedShimEnvironment(); } catch (error) { usageExit(error instanceof Error ? error.message : String(error)); }
  run!(rest).then(code => process.exit(code), error => {
    if (error instanceof ShimUsageError) usageExit(error.message);
    console.error(JSON.stringify({ event: 'error', message: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
