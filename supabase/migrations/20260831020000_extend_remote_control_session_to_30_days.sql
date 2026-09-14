-- Keep one-use QR proofs and pending approval at 24 hours, but retain a
-- Mac-approved, end-to-end encrypted controller session for 30 days.
-- A host lives for 32 days so a QR claimed near its deadline can still spend
-- one day pending approval and receive the full approved-session lifetime.

alter table public.portmgr_remote_control_hosts
  drop constraint if exists portmgr_remote_control_hosts_ttl_check;
alter table public.portmgr_remote_control_hosts
  add constraint portmgr_remote_control_hosts_ttl_check
  check (expires_at > created_at and expires_at <= created_at + interval '62 days');

alter table public.portmgr_remote_control_sessions
  drop constraint if exists portmgr_remote_control_sessions_ttl_check;
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

revoke all on function public.portmgr_remote_control_register_host(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_remote_control_register_host(uuid, text, text, text, integer)
  to service_role;

revoke all on function public.portmgr_remote_control_host_approve_session(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.portmgr_remote_control_host_approve_session(uuid, text, uuid)
  to service_role;
