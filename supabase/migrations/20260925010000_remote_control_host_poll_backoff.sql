-- Host relay poll backoff: stop writing the same rows every second.
--
-- The Mac host used to poll at 1s for as long as any approved 30-day session
-- existed, and each poll stamped portmgr_remote_control_hosts.last_seen_at twice
-- (list + receive). The phone's own 1s receive loop stamped the session row the
-- same way. That is a constant UPDATE load around the clock, phone or no phone.
--
-- 1. host_list_sessions also returns the session's last_seen_at, which the
--    controller receive loop stamps. The host backs off (1s -> 5s -> 20s) when
--    that stamp stops moving and returns to 1s as soon as it moves again.
-- 2. last_seen_at stamps are written only when older than 10 seconds. The phone
--    calls a Mac silent after 60s (REMOTE_CONTROL_HOST_SILENT_MS), so a 20s poll
--    plus a 10s stamp gap still leaves room.
--
-- Changing RETURNS TABLE needs a drop; the drop restores PUBLIC execute, so the
-- revoke comes back before the grant. The receive RPCs keep their signatures
-- and grants (create or replace).
begin;
set local lock_timeout = '10s';
set local statement_timeout = '2min';

drop function if exists public.portmgr_remote_control_host_list_sessions(uuid,text);

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
  revoked_at timestamptz,
  last_seen_at timestamptz
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
  where h.host_id = p_host_id
    and (h.last_seen_at is null or h.last_seen_at < now() - interval '10 seconds');
  update public.portmgr_remote_control_sessions s
  set approval_state = 'revoked', revoked_at = coalesce(s.revoked_at, now())
  where s.host_id = p_host_id and s.approval_state = 'pending'
    and s.expires_at <= now();
  return query
    select s.session_id, s.pairing_id, s.controller_id, s.controller_name, s.controller_public_key,
      s.controller_key_fingerprint, s.approval_state, s.created_at,
      s.expires_at, s.approved_at, s.revoked_at, s.last_seen_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.expires_at > now()
    order by s.created_at desc, s.session_id;
end;
$$;

revoke all on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  to service_role;

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
  where h.host_id = p_host_id
    and (h.last_seen_at is null or h.last_seen_at < now() - interval '10 seconds');
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
  where s.session_id = p_session_id
    and (s.last_seen_at is null or s.last_seen_at < now() - interval '10 seconds');
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

commit;
