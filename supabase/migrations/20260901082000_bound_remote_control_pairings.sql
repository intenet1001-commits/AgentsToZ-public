-- Bound both halves of internet remote control to the product's eight-device
-- contract. Eight live sessions and eight unclaimed invitations is the maximum
-- secret set the host has to retain (16 total).
begin;
set local lock_timeout = '10s';
set local statement_timeout = '2min';

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

-- CREATE OR REPLACE preserves the existing grants; reassert the exact roles so
-- a manual repair cannot leave a wider permission behind.
revoke all on function public.portmgr_remote_control_create_pairing(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_store_message(uuid,uuid,uuid,text,uuid,text,timestamptz,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_renew_host(uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_host_revoke_session(uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_disable_host(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_revoke_session(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_remote_control_owner_disable_host(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_create_pairing(uuid,text,text)
  to service_role;
grant execute on function public.portmgr_remote_control_claim_pairing(uuid,text,text,text)
  to authenticated;
grant execute on function public.portmgr_remote_control_host_approve_session(uuid,text,uuid)
  to service_role;
grant execute on function public.portmgr_remote_control_renew_host(uuid,text,integer)
  to service_role;
grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  to service_role;
grant execute on function public.portmgr_remote_control_host_revoke_session(uuid,text,uuid)
  to service_role;
grant execute on function public.portmgr_remote_control_disable_host(uuid,text)
  to service_role;
grant execute on function public.portmgr_remote_control_revoke_session(uuid,uuid)
  to authenticated;
grant execute on function public.portmgr_remote_control_owner_disable_host(uuid)
  to authenticated;

commit;
