-- Let the local Mac match each pending session to the exact one-use QR that
-- created it. Multiple unclaimed QRs may coexist; "newest secret" is not a
-- safe substitute because an older QR can be scanned later.
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
    select s.session_id, s.pairing_id, s.controller_id, s.controller_name,
      s.controller_public_key, s.controller_key_fingerprint, s.approval_state,
      s.created_at, s.expires_at, s.approved_at, s.revoked_at
    from public.portmgr_remote_control_sessions s
    where s.host_id = p_host_id and s.expires_at > now()
    order by s.created_at desc, s.session_id;
end;
$$;

revoke all on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_host_list_sessions(uuid,text)
  to service_role;

commit;
