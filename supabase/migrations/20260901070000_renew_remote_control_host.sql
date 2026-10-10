-- Keep a host that is in daily use from expiring underneath its user.
--
-- register_host is a plain insert with no upsert, so once a host row expires it
-- cannot be re-registered under the same id. Everything the phone holds — the
-- QR, the pinned public key, the approved session — dies with that row, and the
-- only cure is scanning a new QR. At a 62-day TTL that was a scheduled break
-- roughly every two months for a connection that was working the whole time.
--
-- The Mac renews itself while it is still authorized, which is the one moment
-- we can be sure it is the same Mac. Renewal proves the host secret like every
-- other host call, and greatest() means it can only ever move the expiry later.
-- authorize_host still refuses a revoked, disabled, or already-expired host, so
-- this cannot resurrect anything.

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
  perform public.portmgr_remote_control_authorize_host(p_host_id, p_host_secret, true);
  update public.portmgr_remote_control_hosts h
  set expires_at = greatest(h.expires_at, v_expires_at), last_seen_at = now()
  where h.host_id = p_host_id
  returning h.expires_at into v_expires_at;
  return query select p_host_id, v_expires_at;
end;
$$;

revoke all on function public.portmgr_remote_control_renew_host(uuid,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.portmgr_remote_control_renew_host(uuid,text,integer) to service_role;
