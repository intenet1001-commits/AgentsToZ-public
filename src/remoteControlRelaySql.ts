/**
 * Canonical schema for the Internet QR remote-control relay.
 *
 * V1 is deliberately time-bounded: enabling remote control creates a host id
 * and 32-byte secret, a QR proof is single-use for 30 days,
 * and every approved session dies no later than 30 days after approval. The
 * host row lives for at most 62 days so a last-day claim, its 24-hour pending
 * approval window, and the full approved session can complete. The Mac stores
 * its host/key/pairing state in its account-only 0600 vault and attempts to
 * restore the same authority after a process restart. Static controller hosts (Vercel,
 * ChatGPT Sites, or any equivalent HTTPS host) use only Supabase Auth RPCs;
 * they never receive service_role or direct table access. Mailbox bodies are
 * end-to-end encrypted ciphertext.
 *
 * Keep byte-for-byte SQL behavior aligned with
 * supabase/migrations/20260830030000_remote_control_relay.sql.
 */
export const REMOTE_CONTROL_RELAY_SQL = String.raw`-- Ephemeral Internet QR remote control.
-- All relay rows expire, browser callers use authenticated RPCs only, and the
-- Mac sidecar uses service_role RPCs plus a private host secret restored from
-- its account-only local vault across process restarts.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.portmgr_remote_control_hosts (
  host_id uuid primary key,
  owner_user_id uuid references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  public_key_fingerprint text not null check (public_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  host_secret_hash text not null check (host_secret_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint portmgr_remote_control_hosts_ttl_check
    check (expires_at > created_at and expires_at <= created_at + interval '62 days'),
  check ((owner_user_id is null and claimed_at is null) or (owner_user_id is not null and claimed_at is not null)),
  check (revoked_at is null or enabled = false)
);
create index if not exists idx_portmgr_remote_control_hosts_expiry
  on public.portmgr_remote_control_hosts(expires_at);

create table if not exists public.portmgr_remote_control_pairings (
  pairing_id uuid primary key,
  host_id uuid not null references public.portmgr_remote_control_hosts(host_id) on delete cascade,
  pairing_secret_hash text not null unique check (pairing_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by_user_id uuid references auth.users(id) on delete set null,
  session_id uuid,
  controller_id uuid,
  constraint portmgr_remote_control_pairings_ttl_check
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check (
    (claimed_at is null and claimed_by_user_id is null and session_id is null and controller_id is null)
    or (claimed_at is not null and claimed_by_user_id is not null and session_id is not null and controller_id is not null)
  )
);
create index if not exists idx_portmgr_remote_control_pairings_host_expiry
  on public.portmgr_remote_control_pairings(host_id, expires_at);

create table if not exists public.portmgr_remote_control_sessions (
  session_id uuid primary key,
  controller_id uuid not null unique,
  host_id uuid not null references public.portmgr_remote_control_hosts(host_id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  pairing_id uuid unique references public.portmgr_remote_control_pairings(pairing_id) on delete set null,
  controller_name text not null check (char_length(controller_name) between 1 and 80),
  controller_public_key text not null check (controller_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  controller_key_fingerprint text not null check (controller_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  approval_state text not null default 'pending'
    check (approval_state in ('pending', 'approved', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  unique (host_id, controller_key_fingerprint),
  unique (session_id, controller_id),
  constraint portmgr_remote_control_sessions_ttl_check
    check (
      expires_at > created_at
      and (
        (approved_at is null and expires_at <= created_at + interval '24 hours')
        or (approved_at is not null and expires_at <= approved_at + interval '30 days')
      )
    ),
  check (
    (approval_state = 'pending' and approved_at is null and revoked_at is null)
    or (approval_state = 'approved' and approved_at is not null and revoked_at is null)
    or (approval_state = 'revoked' and revoked_at is not null)
  )
);
create index if not exists idx_portmgr_remote_control_sessions_host_state
  on public.portmgr_remote_control_sessions(host_id, approval_state, expires_at);

create table if not exists public.portmgr_remote_control_messages (
  relay_seq bigint generated always as identity primary key,
  message_id uuid not null unique,
  host_id uuid not null references public.portmgr_remote_control_hosts(host_id) on delete cascade,
  session_id uuid not null,
  controller_id uuid not null,
  direction text not null check (direction in ('controller_to_host', 'host_to_controller')),
  sender_sequence bigint not null check (sender_sequence >= 0),
  envelope_expires_at timestamptz not null,
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 16 and 16384),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  unique (session_id, direction, sender_sequence),
  foreign key (session_id, controller_id)
    references public.portmgr_remote_control_sessions(session_id, controller_id) on delete cascade
);
create index if not exists idx_portmgr_remote_control_messages_host_direction_seq
  on public.portmgr_remote_control_messages(host_id, direction, relay_seq);
create index if not exists idx_portmgr_remote_control_messages_expiry
  on public.portmgr_remote_control_messages(envelope_expires_at, acknowledged_at);

do $$
declare t text;
begin
  foreach t in array array[
    'portmgr_remote_control_hosts',
    'portmgr_remote_control_pairings',
    'portmgr_remote_control_sessions',
    'portmgr_remote_control_messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated, service_role',
      t
    );
  end loop;
end;
$$;
revoke all privileges on sequence public.portmgr_remote_control_messages_relay_seq_seq
  from public, anon, authenticated, service_role;

create or replace function public.portmgr_remote_control_valid_public_key(p_key text)
returns boolean
language plpgsql immutable security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_key bytea;
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{87}$' then
    return false;
  end if;
  begin
    v_key := decode(translate(p_key, '-_', '+/') || '=', 'base64');
  exception when others then
    return false;
  end;
  return octet_length(v_key) = 65 and get_byte(v_key, 0) = 4;
end;
$$;

create or replace function public.portmgr_remote_control_public_key_fingerprint(p_key text)
returns text
language sql immutable security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select rtrim(
    translate(
      replace(
        encode(
          extensions.digest(decode(translate(p_key, '-_', '+/') || '=', 'base64'), 'sha256'),
          'base64'
        ),
        chr(10),
        ''
      ),
      '+/',
      '-_'
    ),
    '='
  );
$$;

create or replace function public.portmgr_remote_control_base64url_decode(p_value text)
returns bytea
language sql immutable security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select case
    when p_value is null or p_value !~ '^[A-Za-z0-9_-]+$' or char_length(p_value) % 4 = 1
      then null
    else decode(
      translate(p_value, '-_', '+/') || repeat('=', (4 - char_length(p_value) % 4) % 4),
      'base64'
    )
  end;
$$;

create or replace function public.portmgr_remote_control_base64url_encode(p_value bytea)
returns text
language sql immutable security invoker
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select rtrim(
    translate(replace(encode(p_value, 'base64'), chr(10), ''), '+/', '-_'),
    '='
  );
$$;

create or replace function public.portmgr_remote_control_authorize_host(
  p_host_id uuid,
  p_host_secret text,
  p_require_enabled boolean default true
)
returns timestamptz
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_expires_at timestamptz;
  v_enabled boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SERVICE_ROLE_REQUIRED';
  end if;
  if p_host_secret is null or p_host_secret !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_HOST_AUTH_FAILED';
  end if;
  select h.expires_at, h.enabled into v_expires_at, v_enabled
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
    and h.revoked_at is null and h.expires_at > now()
    and h.host_secret_hash = encode(
      extensions.digest(convert_to(p_host_secret, 'UTF8'), 'sha256'), 'hex'
    );
  if not found then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_HOST_AUTH_FAILED';
  end if;
  if coalesce(p_require_enabled, true) and not v_enabled then
    raise exception using errcode = '55000', message = 'REMOTE_CONTROL_HOST_DISABLED';
  end if;
  return v_expires_at;
end;
$$;

create or replace function public.portmgr_remote_control_require_member_session(
  p_host_id uuid,
  p_session_id uuid,
  p_require_approved boolean default true
)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_MEMBER_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.portmgr_remote_control_hosts h
    join public.portmgr_remote_control_sessions s on s.host_id = h.host_id
    where h.host_id = p_host_id and h.owner_user_id = v_user_id
      and h.enabled and h.revoked_at is null and h.expires_at > now()
      and s.session_id = p_session_id and s.auth_user_id = v_user_id
      and s.revoked_at is null and s.expires_at > now()
      and (not coalesce(p_require_approved, true) or s.approval_state = 'approved')
  ) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SESSION_ACCESS_DENIED';
  end if;
  return v_user_id;
end;
$$;

create or replace function public.portmgr_remote_control_store_message(
  p_host_id uuid,
  p_session_id uuid,
  p_controller_id uuid,
  p_direction text,
  p_message_id uuid,
  p_sender_sequence text,
  p_envelope_expires_at timestamptz,
  p_nonce text,
  p_ciphertext text
)
returns table(
  message_id uuid,
  relay_seq text,
  duplicate boolean,
  sender_sequence text,
  envelope_expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_nonce bytea;
  v_ciphertext bytea;
  v_relay_seq bigint;
  v_sender_sequence bigint;
  v_session_expires_at timestamptz;
  v_existing public.portmgr_remote_control_messages%rowtype;
  v_recent_count integer;
  v_max_sender_sequence bigint;
begin
  if p_direction not in ('controller_to_host', 'host_to_controller')
    or p_message_id is null or p_controller_id is null then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_MESSAGE_METADATA_INVALID';
  end if;
  if coalesce(p_sender_sequence, '') !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_SENDER_SEQUENCE_INVALID';
  end if;
  begin
    v_sender_sequence := p_sender_sequence::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_SENDER_SEQUENCE_INVALID';
  end;
  if p_nonce is null or char_length(p_nonce) <> 16 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_NONCE_INVALID';
  end if;
  if p_ciphertext is null or char_length(p_ciphertext) < 22 or char_length(p_ciphertext) > 21846 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CIPHERTEXT_INVALID';
  end if;
  begin
    v_nonce := public.portmgr_remote_control_base64url_decode(p_nonce);
    v_ciphertext := public.portmgr_remote_control_base64url_decode(p_ciphertext);
  exception when others then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_ENVELOPE_ENCODING_INVALID';
  end;
  if v_nonce is null or octet_length(v_nonce) <> 12 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_NONCE_INVALID';
  end if;
  if v_ciphertext is null or octet_length(v_ciphertext) not between 16 and 16384 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CIPHERTEXT_INVALID';
  end if;

  select s.expires_at into v_session_expires_at
  from public.portmgr_remote_control_sessions s
  where s.host_id = p_host_id and s.session_id = p_session_id
    and s.controller_id = p_controller_id
    and s.approval_state = 'approved' and s.revoked_at is null and s.expires_at > now()
  for share of s;
  if not found then
    raise exception using errcode = '55000', message = 'REMOTE_CONTROL_SESSION_UNAVAILABLE';
  end if;
  if p_envelope_expires_at is null or p_envelope_expires_at <= now()
    or p_envelope_expires_at > v_session_expires_at then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_ENVELOPE_EXPIRY_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control:' || p_session_id::text || ':' || p_direction, 0)
  );
  select m.* into v_existing
  from public.portmgr_remote_control_messages m
  where m.message_id = p_message_id
    or (
      m.session_id = p_session_id and m.direction = p_direction
      and m.sender_sequence = v_sender_sequence
    )
  order by case when m.message_id = p_message_id then 0 else 1 end
  limit 1;
  if found then
    if v_existing.message_id is distinct from p_message_id
      or v_existing.host_id is distinct from p_host_id
      or v_existing.session_id is distinct from p_session_id
      or v_existing.controller_id is distinct from p_controller_id
      or v_existing.direction is distinct from p_direction
      or v_existing.sender_sequence is distinct from v_sender_sequence
      or v_existing.envelope_expires_at is distinct from p_envelope_expires_at
      or v_existing.nonce is distinct from v_nonce
      or v_existing.ciphertext is distinct from v_ciphertext then
      raise exception using errcode = '23505', message = 'REMOTE_CONTROL_DEDUPE_MISMATCH';
    end if;
    return query select
      v_existing.message_id, v_existing.relay_seq::text, true,
      v_existing.sender_sequence::text, v_existing.envelope_expires_at;
    return;
  end if;

  select max(m.sender_sequence) into v_max_sender_sequence
  from public.portmgr_remote_control_messages m
  where m.session_id = p_session_id and m.direction = p_direction;
  if v_max_sender_sequence is not null and v_sender_sequence <= v_max_sender_sequence then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_SENDER_SEQUENCE_REPLAYED';
  end if;

  select count(*)::integer into v_recent_count
  from public.portmgr_remote_control_messages m
  where m.session_id = p_session_id and m.direction = p_direction
    and m.created_at > now() - interval '1 minute';
  if v_recent_count >= 60 then
    raise exception using errcode = 'P0001', message = 'REMOTE_CONTROL_RATE_LIMITED';
  end if;
  insert into public.portmgr_remote_control_messages as m(
    message_id, host_id, session_id, controller_id, direction,
    sender_sequence, envelope_expires_at, nonce, ciphertext
  ) values (
    p_message_id, p_host_id, p_session_id, p_controller_id, p_direction,
    v_sender_sequence, p_envelope_expires_at, v_nonce, v_ciphertext
  ) returning m.relay_seq into v_relay_seq;
  return query select
    p_message_id, v_relay_seq::text, false,
    v_sender_sequence::text, p_envelope_expires_at;
end;
$$;

create or replace function public.portmgr_remote_control_register_host(
  p_host_id uuid,
  p_display_name text,
  p_public_key text,
  p_host_secret text,
  p_ttl_seconds integer default 5356800
)
returns table(host_id uuid, expires_at timestamptz, public_key_fingerprint text)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_expires_at timestamptz := now() + make_interval(
    secs => least(greatest(coalesce(p_ttl_seconds, 5356800), 60), 5356800)
  );
  v_fingerprint text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SERVICE_ROLE_REQUIRED';
  end if;
  if p_host_id is null then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_HOST_ID_INVALID';
  end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_HOST_NAME_INVALID';
  end if;
  if not public.portmgr_remote_control_valid_public_key(p_public_key) then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_HOST_PUBLIC_KEY_INVALID';
  end if;
  if p_host_secret is null or p_host_secret !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_HOST_SECRET_INVALID';
  end if;
  v_fingerprint := public.portmgr_remote_control_public_key_fingerprint(p_public_key);
  insert into public.portmgr_remote_control_hosts(
    host_id, display_name, public_key, public_key_fingerprint,
    host_secret_hash, expires_at, last_seen_at
  ) values (
    p_host_id, btrim(p_display_name), p_public_key, v_fingerprint,
    encode(extensions.digest(convert_to(p_host_secret, 'UTF8'), 'sha256'), 'hex'),
    v_expires_at, now()
  );
  return query select p_host_id, v_expires_at, v_fingerprint;
end;
$$;

-- Keep a host that is still in daily use from expiring underneath its user.
--
-- register_host is a plain insert with no upsert, so an expired host cannot be
-- re-registered under the same id. Everything the phone holds (the QR, the
-- pinned key, the approved session) dies with it and the only cure is a new
-- QR scan. The Mac renews itself while it is still authorized, which is the
-- one moment we can be sure it is the same Mac.
--
-- Renewal proves the host secret, exactly like every other host call, and can
-- only ever push the expiry later, never bring a revoked or already-expired
-- host back (authorize_host refuses both).
create or replace function public.portmgr_remote_control_renew_host(
  p_host_id uuid,
  p_host_secret text,
  p_ttl_seconds integer default 5356800
)
returns table(host_id uuid, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_expires_at timestamptz := now() + make_interval(
    secs => least(greatest(coalesce(p_ttl_seconds, 5356800), 60), 5356800)
  );
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  update public.portmgr_remote_control_hosts h
  set expires_at = greatest(h.expires_at, v_expires_at), last_seen_at = now()
  where h.host_id = p_host_id
  returning h.expires_at into v_expires_at;
  return query select p_host_id, v_expires_at;
end;
$$;

-- The forward upgrade adds retired_pairing_ids to the TABLE result. PostgreSQL
-- cannot change a function return row with CREATE OR REPLACE, so canonical
-- setup must also be safely rerunnable over an older installed relay. DROP
-- removes the old ACL; the transaction's final revoke/grant restores it.
drop function if exists public.portmgr_remote_control_create_pairing(uuid,text,text);
create or replace function public.portmgr_remote_control_create_pairing(
  p_host_id uuid,
  p_host_secret text,
  p_pairing_secret_hash text
)
returns table(
  pairing_id uuid,
  expires_at timestamptz,
  host_public_key text,
  host_public_key_fingerprint text,
  retired_pairing_ids uuid[]
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_pairing_id uuid := extensions.gen_random_uuid();
  v_host_expires_at timestamptz;
  v_expires_at timestamptz;
  v_outstanding_count integer;
  v_retired_pairing_ids uuid[] := '{}'::uuid[];
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  v_host_expires_at := public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  perform 1
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
  for update;
  if p_pairing_secret_hash is null or p_pairing_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_PAIRING_HASH_INVALID';
  end if;
  select count(*)::integer into v_outstanding_count
  from public.portmgr_remote_control_pairings p
  where p.host_id = p_host_id and p.claimed_at is null and p.expires_at > now();
  if v_outstanding_count >= 8 then
    with oldest as (
      select candidate.pairing_id, candidate.created_at
      from public.portmgr_remote_control_pairings candidate
      where candidate.host_id = p_host_id
        and candidate.claimed_at is null and candidate.expires_at > now()
      order by candidate.created_at, candidate.pairing_id
      limit (v_outstanding_count - 7)
    ), deleted as (
      delete from public.portmgr_remote_control_pairings p
      using oldest
      where p.pairing_id = oldest.pairing_id
      returning p.pairing_id
    )
    select coalesce(
      array_agg(deleted.pairing_id order by oldest.created_at, oldest.pairing_id),
      '{}'::uuid[]
    ) into v_retired_pairing_ids
    from deleted join oldest using (pairing_id);
  end if;
  v_expires_at := least(now() + interval '30 days', v_host_expires_at);
  insert into public.portmgr_remote_control_pairings(
    pairing_id, host_id, pairing_secret_hash, expires_at
  ) values (v_pairing_id, p_host_id, p_pairing_secret_hash, v_expires_at);
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  return query
    select v_pairing_id, v_expires_at, h.public_key, h.public_key_fingerprint,
      v_retired_pairing_ids
    from public.portmgr_remote_control_hosts h where h.host_id = p_host_id;
end;
$$;

create or replace function public.portmgr_remote_control_claim_pairing(
  p_pairing_id uuid,
  p_pairing_secret text,
  p_controller_name text,
  p_controller_public_key text
)
returns table(
  session_id uuid,
  controller_id uuid,
  host_id uuid,
  host_name text,
  host_public_key text,
  host_public_key_fingerprint text,
  approval_state text,
  expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_discovered_host_id uuid;
  v_pairing public.portmgr_remote_control_pairings%rowtype;
  v_host public.portmgr_remote_control_hosts%rowtype;
  v_existing_session public.portmgr_remote_control_sessions%rowtype;
  v_session_id uuid := extensions.gen_random_uuid();
  v_controller_id uuid := extensions.gen_random_uuid();
  v_fingerprint text;
  v_session_expires_at timestamptz;
  v_active_session_count integer;
begin
  if v_user_id is null or not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_MEMBER_REQUIRED';
  end if;
  if p_pairing_secret is null or p_pairing_secret !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_PAIRING_PROOF_INVALID';
  end if;
  if p_controller_name is null or char_length(btrim(p_controller_name)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CONTROLLER_NAME_INVALID';
  end if;
  if not public.portmgr_remote_control_valid_public_key(p_controller_public_key) then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CONTROLLER_PUBLIC_KEY_INVALID';
  end if;
  select p.host_id into v_discovered_host_id
  from public.portmgr_remote_control_pairings p
  where p.pairing_id = p_pairing_id;
  if not found then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || v_discovered_host_id::text, 0)
  );
  select p.* into v_pairing
  from public.portmgr_remote_control_pairings p
  where p.pairing_id = p_pairing_id
  for update;
  if not found or v_pairing.host_id is distinct from v_discovered_host_id
    or (v_pairing.claimed_at is null and v_pairing.expires_at <= now())
    or v_pairing.pairing_secret_hash is distinct from encode(
      extensions.digest(convert_to(p_pairing_secret, 'UTF8'), 'sha256'), 'hex'
    ) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED';
  end if;
  select h.* into v_host
  from public.portmgr_remote_control_hosts h
  where h.host_id = v_pairing.host_id
  for update;
  if not found or not v_host.enabled or v_host.revoked_at is not null or v_host.expires_at <= now() then
    raise exception using errcode = '55000', message = 'REMOTE_CONTROL_HOST_UNAVAILABLE';
  end if;
  if v_host.owner_user_id is not null and v_host.owner_user_id is distinct from v_user_id then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_OWNER_REQUIRED';
  end if;
  if v_pairing.claimed_at is not null then
    select s.* into v_existing_session
    from public.portmgr_remote_control_sessions s
    where s.session_id = v_pairing.session_id
      and s.controller_id = v_pairing.controller_id
      and s.pairing_id = v_pairing.pairing_id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED';
    end if;
    if v_pairing.claimed_by_user_id is distinct from v_user_id
      or v_existing_session.auth_user_id is distinct from v_user_id
      or v_existing_session.host_id is distinct from v_host.host_id
      or v_existing_session.controller_name is distinct from btrim(p_controller_name)
      or v_existing_session.controller_public_key is distinct from p_controller_public_key
      or v_existing_session.approval_state is distinct from 'pending'
      or v_existing_session.revoked_at is not null
      or v_existing_session.expires_at <= now() then
      raise exception using errcode = '42501', message = 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED';
    end if;
    return query select
      v_existing_session.session_id, v_existing_session.controller_id,
      v_host.host_id, v_host.display_name, v_host.public_key,
      v_host.public_key_fingerprint, 'pending'::text, v_existing_session.expires_at;
    return;
  end if;
  select count(*)::integer into v_active_session_count
  from public.portmgr_remote_control_sessions s
  where s.host_id = v_host.host_id
    and s.approval_state in ('pending', 'approved')
    and s.revoked_at is null and s.expires_at > now();
  if v_active_session_count >= 8 then
    raise exception using errcode = '54000', message = 'REMOTE_CONTROL_SESSION_LIMIT';
  end if;
  v_fingerprint := public.portmgr_remote_control_public_key_fingerprint(p_controller_public_key);
  v_session_expires_at := least(now() + interval '24 hours', v_host.expires_at);
  insert into public.portmgr_remote_control_sessions(
    session_id, controller_id, host_id, auth_user_id, pairing_id, controller_name,
    controller_public_key, controller_key_fingerprint, expires_at
  ) values (
    v_session_id, v_controller_id, v_host.host_id, v_user_id, v_pairing.pairing_id,
    btrim(p_controller_name), p_controller_public_key, v_fingerprint,
    v_session_expires_at
  );
  update public.portmgr_remote_control_pairings p
  set claimed_at = now(), claimed_by_user_id = v_user_id,
    session_id = v_session_id, controller_id = v_controller_id
  where p.pairing_id = v_pairing.pairing_id;
  return query select
    v_session_id, v_controller_id, v_host.host_id, v_host.display_name, v_host.public_key,
    v_host.public_key_fingerprint, 'pending'::text, v_session_expires_at;
end;
$$;

create or replace function public.portmgr_remote_control_host_list_sessions(
  p_host_id uuid,
  p_host_secret text
)
returns table(
  session_id uuid,
  pairing_id uuid,
  controller_id uuid,
  controller_name text,
  controller_public_key text,
  controller_key_fingerprint text,
  approval_state text,
  created_at timestamptz,
  expires_at timestamptz,
  approved_at timestamptz,
  revoked_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, false);
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.approval_state = 'pending'
    and s.expires_at <= now();
  return query
    select s.session_id, s.pairing_id, s.controller_id, s.controller_name, s.controller_public_key,
      s.controller_key_fingerprint, s.approval_state, s.created_at,
      s.expires_at, s.approved_at, s.revoked_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.expires_at > now()
    order by s.created_at desc, s.session_id;
end;
$$;

create or replace function public.portmgr_remote_control_host_approve_session(
  p_host_id uuid,
  p_host_secret text,
  p_session_id uuid
)
returns table(
  session_id uuid,
  controller_id uuid,
  approval_state text,
  controller_public_key text,
  controller_key_fingerprint text,
  approved_at timestamptz,
  expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_state text;
  v_candidate_user_id uuid;
  v_owner_user_id uuid;
  v_host_expires_at timestamptz;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  v_host_expires_at := public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  select h.owner_user_id into v_owner_user_id
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'REMOTE_CONTROL_HOST_UNAVAILABLE';
  end if;
  select s.approval_state, s.auth_user_id
  into v_state, v_candidate_user_id
  from public.portmgr_remote_control_sessions s
  where s.host_id = p_host_id and s.session_id = p_session_id and s.expires_at > now()
  for update of s;
  if not found then
    raise exception using errcode = 'P0002', message = 'REMOTE_CONTROL_SESSION_NOT_FOUND';
  end if;
  if v_state = 'revoked' then
    raise exception using errcode = '55000', message = 'REMOTE_CONTROL_SESSION_REVOKED';
  end if;
  if v_owner_user_id is null then
    update public.portmgr_remote_control_hosts h
    set owner_user_id = v_candidate_user_id, claimed_at = now()
    where h.host_id = p_host_id;
  elsif v_owner_user_id is distinct from v_candidate_user_id then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_OWNER_MISMATCH';
  end if;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'approved',
    approved_at = coalesce(s.approved_at, now()),
    expires_at = case
      when s.approval_state = 'pending' then least(now() + interval '30 days', v_host_expires_at)
      else s.expires_at
    end
  where s.host_id = p_host_id and s.session_id = p_session_id;
  return query
    select s.session_id, s.controller_id, s.approval_state, s.controller_public_key,
      s.controller_key_fingerprint, s.approved_at, s.expires_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.session_id = p_session_id;
end;
$$;

create or replace function public.portmgr_remote_control_host_revoke_session(
  p_host_id uuid,
  p_host_secret text,
  p_session_id uuid
)
returns table(session_id uuid, approval_state text, revoked_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, false);
  perform 1
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
  for update;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.session_id = p_session_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'REMOTE_CONTROL_SESSION_NOT_FOUND';
  end if;
  delete from public.portmgr_remote_control_messages m
  where m.host_id = p_host_id and m.session_id = p_session_id;
  return query
    select s.session_id, s.approval_state, s.revoked_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.session_id = p_session_id;
end;
$$;

create or replace function public.portmgr_remote_control_disable_host(
  p_host_id uuid,
  p_host_secret text
)
returns table(host_id uuid, enabled boolean, revoked_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, false);
  update public.portmgr_remote_control_hosts h
  set enabled = false, revoked_at = coalesce(h.revoked_at, now())
  where h.host_id = p_host_id;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.approval_state <> 'revoked';
  delete from public.portmgr_remote_control_messages m where m.host_id = p_host_id;
  return query
    select h.host_id, h.enabled, h.revoked_at
    from public.portmgr_remote_control_hosts h where h.host_id = p_host_id;
end;
$$;

-- The return type gains a column, and Postgres will not let create-or-replace
-- change one. Dropping first is required, not tidiness.
drop function if exists public.portmgr_remote_control_session_status(uuid, uuid);
create or replace function public.portmgr_remote_control_session_status(
  p_host_id uuid,
  p_session_id uuid
)
returns table(
  session_id uuid,
  controller_id uuid,
  approval_state text,
  host_enabled boolean,
  host_expires_at timestamptz,
  session_expires_at timestamptz,
  revoked_at timestamptz,
  -- Whether the Mac is actually polling right now. The host already stamps this
  -- on every poll; without handing it to the phone, a sleeping Mac is
  -- indistinguishable from a busy one and the phone waits out the full result
  -- budget for a reply nobody is going to send.
  host_last_seen_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_MEMBER_REQUIRED';
  end if;
  return query
    select s.session_id, s.controller_id, s.approval_state,
      h.enabled, h.expires_at, s.expires_at, s.revoked_at, h.last_seen_at
    from public.portmgr_remote_control_hosts h
    join public.portmgr_remote_control_sessions s on s.host_id = h.host_id
    where h.host_id = p_host_id
      and (h.owner_user_id is null or h.owner_user_id = v_user_id)
      and s.session_id = p_session_id and s.auth_user_id = v_user_id;
  if not found then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SESSION_ACCESS_DENIED';
  end if;
end;
$$;

create or replace function public.portmgr_remote_control_revoke_session(
  p_host_id uuid,
  p_session_id uuid
)
returns table(session_id uuid, approval_state text, revoked_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner_user_id uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  if v_user_id is null or not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_MEMBER_REQUIRED';
  end if;
  select h.owner_user_id into v_owner_user_id
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
  for update;
  if not found or (v_owner_user_id is not null and v_owner_user_id is distinct from v_user_id) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SESSION_ACCESS_DENIED';
  end if;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.session_id = p_session_id and s.auth_user_id = v_user_id;
  if not found then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SESSION_ACCESS_DENIED';
  end if;
  delete from public.portmgr_remote_control_messages m
  where m.host_id = p_host_id and m.session_id = p_session_id;
  return query
    select s.session_id, s.approval_state, s.revoked_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.session_id = p_session_id;
end;
$$;

create or replace function public.portmgr_remote_control_owner_disable_host(p_host_id uuid)
returns table(host_id uuid, enabled boolean, revoked_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_user_id uuid := auth.uid();
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-remote-control-host:' || p_host_id::text, 0)
  );
  if v_user_id is null or not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_MEMBER_REQUIRED';
  end if;
  update public.portmgr_remote_control_hosts h
  set enabled = false, revoked_at = coalesce(h.revoked_at, now())
  where h.host_id = p_host_id and h.owner_user_id = v_user_id;
  if not found then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_OWNER_REQUIRED';
  end if;
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.approval_state <> 'revoked';
  delete from public.portmgr_remote_control_messages m where m.host_id = p_host_id;
  return query
    select h.host_id, h.enabled, h.revoked_at
    from public.portmgr_remote_control_hosts h where h.host_id = p_host_id;
end;
$$;

create or replace function public.portmgr_remote_control_controller_send_message(
  p_host_id uuid,
  p_session_id uuid,
  p_controller_id uuid,
  p_message_id uuid,
  p_sender_sequence text,
  p_envelope_expires_at timestamptz,
  p_nonce text,
  p_ciphertext text
)
returns table(
  message_id uuid, relay_seq text, duplicate boolean,
  sender_sequence text, envelope_expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform public.portmgr_remote_control_require_member_session(p_host_id, p_session_id, true);
  if not exists (
    select 1 from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.session_id = p_session_id
      and s.controller_id = p_controller_id
  ) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_CONTROLLER_ID_MISMATCH';
  end if;
  update public.portmgr_remote_control_sessions s set last_seen_at = now()
  where s.session_id = p_session_id;
  return query select * from public.portmgr_remote_control_store_message(
    p_host_id, p_session_id, p_controller_id, 'controller_to_host',
    p_message_id, p_sender_sequence, p_envelope_expires_at, p_nonce, p_ciphertext
  );
end;
$$;

create or replace function public.portmgr_remote_control_host_send_message(
  p_host_id uuid,
  p_host_secret text,
  p_session_id uuid,
  p_controller_id uuid,
  p_message_id uuid,
  p_sender_sequence text,
  p_envelope_expires_at timestamptz,
  p_nonce text,
  p_ciphertext text
)
returns table(
  message_id uuid, relay_seq text, duplicate boolean,
  sender_sequence text, envelope_expires_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  if not exists (
    select 1 from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.session_id = p_session_id
      and s.controller_id = p_controller_id
      and s.approval_state = 'approved' and s.revoked_at is null and s.expires_at > now()
  ) then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SESSION_NOT_APPROVED';
  end if;
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  return query select * from public.portmgr_remote_control_store_message(
    p_host_id, p_session_id, p_controller_id, 'host_to_controller',
    p_message_id, p_sender_sequence, p_envelope_expires_at, p_nonce, p_ciphertext
  );
end;
$$;

create or replace function public.portmgr_remote_control_host_receive_messages(
  p_host_id uuid,
  p_host_secret text,
  p_after_relay_seq text default '0',
  p_limit integer default 100
)
returns table(
  relay_seq text, message_id uuid, session_id uuid, controller_id uuid,
  direction text, sender_sequence text, envelope_expires_at timestamptz,
  nonce text, ciphertext text, created_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_after_seq bigint;
begin
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  if coalesce(p_after_relay_seq, '') !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end if;
  begin v_after_seq := p_after_relay_seq::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end;
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  return query
    select m.relay_seq::text, m.message_id, m.session_id, m.controller_id,
      m.direction, m.sender_sequence::text, m.envelope_expires_at,
      public.portmgr_remote_control_base64url_encode(m.nonce),
      public.portmgr_remote_control_base64url_encode(m.ciphertext),
      m.created_at
    from public.portmgr_remote_control_messages m
    join public.portmgr_remote_control_sessions s on s.session_id = m.session_id
    where m.host_id = p_host_id and m.direction = 'controller_to_host'
      and m.relay_seq > v_after_seq and m.envelope_expires_at > now()
      and m.acknowledged_at is null
      and s.approval_state = 'approved' and s.revoked_at is null and s.expires_at > now()
    order by m.relay_seq asc
    limit least(greatest(coalesce(p_limit, 100), 1), 100);
end;
$$;

create or replace function public.portmgr_remote_control_controller_receive_messages(
  p_host_id uuid,
  p_session_id uuid,
  p_after_relay_seq text default '0',
  p_limit integer default 100
)
returns table(
  relay_seq text, message_id uuid, session_id uuid, controller_id uuid,
  direction text, sender_sequence text, envelope_expires_at timestamptz,
  nonce text, ciphertext text, created_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_after_seq bigint;
begin
  perform public.portmgr_remote_control_require_member_session(p_host_id, p_session_id, true);
  if coalesce(p_after_relay_seq, '') !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end if;
  begin v_after_seq := p_after_relay_seq::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end;
  update public.portmgr_remote_control_sessions s set last_seen_at = now()
  where s.session_id = p_session_id;
  return query
    select m.relay_seq::text, m.message_id, m.session_id, m.controller_id,
      m.direction, m.sender_sequence::text, m.envelope_expires_at,
      public.portmgr_remote_control_base64url_encode(m.nonce),
      public.portmgr_remote_control_base64url_encode(m.ciphertext),
      m.created_at
    from public.portmgr_remote_control_messages m
    where m.host_id = p_host_id and m.session_id = p_session_id
      and m.direction = 'host_to_controller'
      and m.relay_seq > v_after_seq and m.envelope_expires_at > now()
      and m.acknowledged_at is null
    order by m.relay_seq asc
    limit least(greatest(coalesce(p_limit, 100), 1), 100);
end;
$$;

create or replace function public.portmgr_remote_control_host_ack_messages(
  p_host_id uuid,
  p_host_secret text,
  p_session_id uuid,
  p_through_relay_seq text
)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_through_seq bigint; v_count integer;
begin
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  if coalesce(p_through_relay_seq, '') !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end if;
  begin v_through_seq := p_through_relay_seq::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end;
  update public.portmgr_remote_control_messages m set acknowledged_at = now()
  where m.host_id = p_host_id and m.session_id = p_session_id
    and m.direction = 'controller_to_host' and m.relay_seq <= v_through_seq
    and m.acknowledged_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.portmgr_remote_control_controller_ack_messages(
  p_host_id uuid,
  p_session_id uuid,
  p_through_relay_seq text
)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare v_through_seq bigint; v_count integer;
begin
  perform public.portmgr_remote_control_require_member_session(p_host_id, p_session_id, true);
  if coalesce(p_through_relay_seq, '') !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end if;
  begin v_through_seq := p_through_relay_seq::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_CURSOR_INVALID';
  end;
  update public.portmgr_remote_control_messages m set acknowledged_at = now()
  where m.host_id = p_host_id and m.session_id = p_session_id
    and m.direction = 'host_to_controller' and m.relay_seq <= v_through_seq
    and m.acknowledged_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.portmgr_remote_control_cleanup(p_limit integer default 500)
returns table(
  deleted_messages integer,
  deleted_sessions integer,
  deleted_pairings integer,
  deleted_hosts integer
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_messages integer;
  v_sessions integer;
  v_pairings integer;
  v_hosts integer;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 500);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'REMOTE_CONTROL_SERVICE_ROLE_REQUIRED';
  end if;
  with expired_pending as (
    select s.session_id
    from public.portmgr_remote_control_sessions s
    where s.approval_state = 'pending' and s.expires_at <= now()
    order by s.expires_at, s.session_id
    limit v_limit
    for update of s skip locked
  )
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  from expired_pending e where e.session_id = s.session_id;
  with doomed as (
    select m.relay_seq
    from public.portmgr_remote_control_messages m
    where m.envelope_expires_at <= now()
      or (m.acknowledged_at is not null and m.acknowledged_at <= now() - interval '1 minute')
    order by m.relay_seq
    limit v_limit
    for update skip locked
  )
  delete from public.portmgr_remote_control_messages m
  using doomed d where d.relay_seq = m.relay_seq;
  get diagnostics v_messages = row_count;
  with doomed as (
    select s.session_id
    from public.portmgr_remote_control_sessions s
    where (
      s.expires_at <= now()
      or (s.revoked_at is not null and s.revoked_at <= now() - interval '1 minute')
    ) and not exists (
      select 1 from public.portmgr_remote_control_messages m where m.session_id = s.session_id
    )
    order by s.expires_at, s.session_id
    limit v_limit
    for update skip locked
  )
  delete from public.portmgr_remote_control_sessions s
  using doomed d where d.session_id = s.session_id;
  get diagnostics v_sessions = row_count;
  with doomed as (
    select p.pairing_id
    from public.portmgr_remote_control_pairings p
    where p.expires_at <= now() and not exists (
      select 1 from public.portmgr_remote_control_sessions s where s.pairing_id = p.pairing_id
    )
    order by p.expires_at, p.pairing_id
    limit v_limit
    for update skip locked
  )
  delete from public.portmgr_remote_control_pairings p
  using doomed d where d.pairing_id = p.pairing_id;
  get diagnostics v_pairings = row_count;
  with doomed as (
    select h.host_id
    from public.portmgr_remote_control_hosts h
    where (
      h.expires_at <= now()
      or (h.revoked_at is not null and h.revoked_at <= now() - interval '1 minute')
    ) and not exists (
      select 1 from public.portmgr_remote_control_sessions s where s.host_id = h.host_id
    ) and not exists (
      select 1 from public.portmgr_remote_control_pairings p where p.host_id = h.host_id
    )
    order by h.expires_at, h.host_id
    limit v_limit
    for update skip locked
  )
  delete from public.portmgr_remote_control_hosts h
  using doomed d where d.host_id = h.host_id;
  get diagnostics v_hosts = row_count;
  return query select v_messages, v_sessions, v_pairings, v_hosts;
end;
$$;

-- Internal helpers have no PostgREST caller role.
revoke all on function public.portmgr_remote_control_valid_public_key(text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_public_key_fingerprint(text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_base64url_decode(text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_base64url_encode(bytea) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_authorize_host(uuid,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_require_member_session(uuid,uuid,boolean) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_store_message(uuid,uuid,uuid,text,uuid,text,timestamptz,text,text) from public, anon, authenticated, service_role;

-- Mac sidecar: service_role plus the private persisted host secret on every host RPC.
revoke all on function public.portmgr_remote_control_register_host(uuid,text,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_renew_host(uuid,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_create_pairing(uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_list_sessions(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_revoke_session(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_disable_host(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_send_message(uuid,text,uuid,uuid,uuid,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_receive_messages(uuid,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_ack_messages(uuid,text,uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_cleanup(integer) from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_register_host(uuid,text,text,text,integer) to service_role;
grant execute on function public.portmgr_remote_control_renew_host(uuid,text,integer) to service_role;
grant execute on function public.portmgr_remote_control_create_pairing(uuid,text,text) to service_role;
grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text) to service_role;
grant execute on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid) to service_role;
grant execute on function public.portmgr_remote_control_host_revoke_session(uuid,text,uuid) to service_role;
grant execute on function public.portmgr_remote_control_disable_host(uuid,text) to service_role;
grant execute on function public.portmgr_remote_control_host_send_message(uuid,text,uuid,uuid,uuid,text,timestamptz,text,text) to service_role;
grant execute on function public.portmgr_remote_control_host_receive_messages(uuid,text,text,integer) to service_role;
grant execute on function public.portmgr_remote_control_host_ack_messages(uuid,text,uuid,text) to service_role;
grant execute on function public.portmgr_remote_control_cleanup(integer) to service_role;

-- Static phone/tablet controller: authenticated Google member RPCs only.
revoke all on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_session_status(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_revoke_session(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_owner_disable_host(uuid) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_controller_send_message(uuid,uuid,uuid,uuid,text,timestamptz,text,text) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_controller_receive_messages(uuid,uuid,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_controller_ack_messages(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text) to authenticated;
grant execute on function public.portmgr_remote_control_session_status(uuid,uuid) to authenticated;
grant execute on function public.portmgr_remote_control_revoke_session(uuid,uuid) to authenticated;
grant execute on function public.portmgr_remote_control_owner_disable_host(uuid) to authenticated;
grant execute on function public.portmgr_remote_control_controller_send_message(uuid,uuid,uuid,uuid,text,timestamptz,text,text) to authenticated;
grant execute on function public.portmgr_remote_control_controller_receive_messages(uuid,uuid,text,integer) to authenticated;
grant execute on function public.portmgr_remote_control_controller_ack_messages(uuid,uuid,text) to authenticated;
`;
