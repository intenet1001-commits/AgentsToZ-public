-- Keep the one-use QR at 24 hours and approved remote-control access at 30 days.
-- The host remains time-bounded for 32 days so a QR claimed near hour 24 has
-- a full-day approval window and a complete 30-day approved session. Existing
-- auth, SAS approval, one-use claim, RLS, ciphertext, revoke, and cleanup
-- boundaries are unchanged.

do $$
declare
  v_table regclass;
  v_constraint record;
begin
  foreach v_table in array array[
    'public.portmgr_remote_control_hosts'::regclass,
    'public.portmgr_remote_control_pairings'::regclass,
    'public.portmgr_remote_control_sessions'::regclass
  ] loop
    for v_constraint in
      select c.conname
      from pg_catalog.pg_constraint c
      where c.conrelid = v_table
        and c.contype = 'c'
        and pg_catalog.pg_get_constraintdef(c.oid) ilike '%expires_at%'
        and pg_catalog.pg_get_constraintdef(c.oid) ilike '%created_at%'
    loop
      execute format('alter table %s drop constraint %I', v_table, v_constraint.conname);
    end loop;
  end loop;
end;
$$;

alter table public.portmgr_remote_control_hosts
  add constraint portmgr_remote_control_hosts_ttl_check
  check (expires_at > created_at and expires_at <= created_at + interval '62 days');

alter table public.portmgr_remote_control_pairings
  add constraint portmgr_remote_control_pairings_ttl_check
  check (expires_at > created_at and expires_at <= created_at + interval '30 days');

alter table public.portmgr_remote_control_sessions
  add constraint portmgr_remote_control_sessions_ttl_check
  check (
    expires_at > created_at
    and (
      (approved_at is null and expires_at <= created_at + interval '24 hours')
      or (approved_at is not null and expires_at <= approved_at + interval '30 days')
    )
  );

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

create or replace function public.portmgr_remote_control_create_pairing(
  p_host_id uuid,
  p_host_secret text,
  p_pairing_secret_hash text
)
returns table(
  pairing_id uuid,
  expires_at timestamptz,
  host_public_key text,
  host_public_key_fingerprint text
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_pairing_id uuid := extensions.gen_random_uuid();
  v_host_expires_at timestamptz;
  v_expires_at timestamptz;
begin
  v_host_expires_at := public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  if p_pairing_secret_hash is null or p_pairing_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_CONTROL_PAIRING_HASH_INVALID';
  end if;
  v_expires_at := least(now() + interval '30 days', v_host_expires_at);
  insert into public.portmgr_remote_control_pairings(
    pairing_id, host_id, pairing_secret_hash, expires_at
  ) values (v_pairing_id, p_host_id, p_pairing_secret_hash, v_expires_at);
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  return query
    select v_pairing_id, v_expires_at, h.public_key, h.public_key_fingerprint
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
  v_pairing public.portmgr_remote_control_pairings%rowtype;
  v_host public.portmgr_remote_control_hosts%rowtype;
  v_existing_session public.portmgr_remote_control_sessions%rowtype;
  v_session_id uuid := extensions.gen_random_uuid();
  v_controller_id uuid := extensions.gen_random_uuid();
  v_fingerprint text;
  v_session_expires_at timestamptz;
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
  select p.* into v_pairing
  from public.portmgr_remote_control_pairings p
  where p.pairing_id = p_pairing_id
  for update;
  if not found or (v_pairing.claimed_at is null and v_pairing.expires_at <= now())
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
    if not found
      or v_pairing.claimed_by_user_id is distinct from v_user_id
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
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, false);
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.approval_state = 'pending'
    and s.expires_at <= now();
  update public.portmgr_remote_control_hosts h set last_seen_at = now()
  where h.host_id = p_host_id;
  return query
    select s.session_id, s.controller_id, s.controller_name, s.controller_public_key,
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
  v_host_expires_at := public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
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
  select h.owner_user_id into v_owner_user_id
  from public.portmgr_remote_control_hosts h
  where h.host_id = p_host_id
  for update;
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

revoke all on function public.portmgr_remote_control_register_host(uuid,text,text,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_create_pairing(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_cleanup(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_register_host(uuid,text,text,text,integer)
  to service_role;
grant execute on function public.portmgr_remote_control_create_pairing(uuid,text,text)
  to service_role;
grant execute on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text)
  to authenticated;
grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  to service_role;
grant execute on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid)
  to service_role;
grant execute on function public.portmgr_remote_control_cleanup(integer)
  to service_role;
