-- Tell the phone whether the Mac is actually listening.
--
-- The host stamps portmgr_remote_control_hosts.last_seen_at on every poll (once
-- a second while it has sessions), so the relay has always known. It just never
-- handed that to the controller, and without it a sleeping Mac is
-- indistinguishable from a busy one: the phone sends an action and waits out its
-- whole result budget for a reply nobody is going to send. Now it can say
-- "Mac이 응답하지 않습니다" in the first second instead of after a minute.
--
-- Nothing about authority changes. This is the same row the caller is already
-- allowed to read (owner or member, own session only), with one more column.
-- A controller that predates the column reads it as absent, which stays
-- "unknown" and blocks nothing.

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

-- ⚠️ Dropping a function drops its grants AND restores Postgres' default, which
-- is EXECUTE for PUBLIC — so anon silently regains it. Observed live: after the
-- drop/create above, anon could execute this again. Re-revoke before granting.
revoke all on function public.portmgr_remote_control_session_status(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_session_status(uuid,uuid) to authenticated;
