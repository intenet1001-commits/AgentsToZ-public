-- Extend the one-use QR proof from 24 hours to 30 days, matching the approved
-- session it leads to. Requested twice as VOC 2026-09-01 "30일로 안되어있는데?":
-- the dialog showed a 30-day session next to a 24-hour countdown, and the two
-- numbers read as one number that was wrong.
--
-- What does NOT change: the QR is still single-use (claimed_at is set on first
-- claim and a second claimer is rejected), the phone still cannot act until the
-- Mac approves a matching 6-digit SAS code, the pending-approval window stays
-- 24 hours, and RLS / ciphertext / revoke / cleanup boundaries are untouched.
-- The added exposure is that a month-old QR image can still raise an approval
-- prompt on the Mac; approval itself is unchanged.
--
-- A host must outlive the longest chain it can anchor: a 30-day QR claimed on
-- its last day, one day pending approval, then a full 30-day approved session.
-- Hence 62 days. Leaving the host at 32 days would silently clamp the QR via
-- least(now() + interval '30 days', v_host_expires_at) and the countdown would
-- disagree with the copy.

alter table public.portmgr_remote_control_pairings
  drop constraint if exists portmgr_remote_control_pairings_ttl_check;
alter table public.portmgr_remote_control_pairings
  add constraint portmgr_remote_control_pairings_ttl_check
  check (expires_at > created_at and expires_at <= created_at + interval '30 days');

alter table public.portmgr_remote_control_hosts
  drop constraint if exists portmgr_remote_control_hosts_ttl_check;
alter table public.portmgr_remote_control_hosts
  add constraint portmgr_remote_control_hosts_ttl_check
  check (expires_at > created_at and expires_at <= created_at + interval '62 days');

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

revoke all on function public.portmgr_remote_control_register_host(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_remote_control_register_host(uuid, text, text, text, integer)
  to service_role;

revoke all on function public.portmgr_remote_control_create_pairing(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.portmgr_remote_control_create_pairing(uuid, text, text)
  to service_role;
