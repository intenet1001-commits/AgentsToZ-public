
-- Macs that polled at least once: the devices each one lists as registered and in use now.
create table if not exists public.portmgr_screen_push_macs (
  mac_fingerprint text primary key check (mac_fingerprint ~ '^[0-9a-f]{64}$'),
  device_ids text[] not null default '{}' check (cardinality(device_ids) <= 16),
  synced_at timestamptz not null default now()
);
-- Where to push each device about each Mac. One row per (Mac, device); a device the Mac does not list yet may hold
-- one of at most 4 waiting rows per Mac.
create table if not exists public.portmgr_screen_push_tokens (
  mac_fingerprint text not null check (mac_fingerprint ~ '^[0-9a-f]{64}$'),
  device_id text not null check (device_id ~ '^[0-9a-f]{64}$'),
  device_key text not null check (device_key ~ '^04[0-9a-f]{128}$'),
  token text not null check (token ~ '^[0-9a-f]{16,200}$'),
  environment text not null check (environment in ('sandbox', 'production')),
  topic text not null check (topic ~ '^[A-Za-z0-9.-]{1,100}$'),
  registered_at timestamptz not null default now(),
  listed_at timestamptz,
  primary key (mac_fingerprint, device_id)
);
-- Remote stops waiting for a Mac, and the Mac's signed answers.
create table if not exists public.portmgr_screen_push_commands (
  command_id text primary key check (command_id ~ '^[0-9a-f]{64}$'),
  mac_fingerprint text not null check (mac_fingerprint ~ '^[0-9a-f]{64}$'),
  device_id text not null check (device_id ~ '^[0-9a-f]{64}$'),
  message text not null check (char_length(message) between 1 and 6000),
  signature text not null check (char_length(signature) between 1 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  result text check (result is null or char_length(result) between 1 and 200),
  answered_at timestamptz
);
create index if not exists portmgr_screen_push_commands_mac on public.portmgr_screen_push_commands (mac_fingerprint, created_at);
create index if not exists portmgr_screen_push_commands_expiry on public.portmgr_screen_push_commands (expires_at);
-- Signed requests seen: replay protection and rate limits.
create table if not exists public.portmgr_screen_push_requests (
  rate_key text not null check (rate_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('register', 'unregister', 'notify', 'fetch', 'command', 'result')),
  nonce text not null check (nonce ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  primary key (rate_key, kind, nonce)
);
create index if not exists portmgr_screen_push_requests_window on public.portmgr_screen_push_requests (rate_key, kind, created_at);
create index if not exists portmgr_screen_push_requests_age on public.portmgr_screen_push_requests (created_at);

alter table public.portmgr_screen_push_macs enable row level security;
alter table public.portmgr_screen_push_tokens enable row level security;
alter table public.portmgr_screen_push_commands enable row level security;
alter table public.portmgr_screen_push_requests enable row level security;
revoke all on public.portmgr_screen_push_macs, public.portmgr_screen_push_tokens, public.portmgr_screen_push_commands,
  public.portmgr_screen_push_requests from public, anon, authenticated;
grant select, insert, update, delete on public.portmgr_screen_push_macs, public.portmgr_screen_push_tokens,
  public.portmgr_screen_push_commands, public.portmgr_screen_push_requests to service_role;

-- One signed request: 'replayed' for a nonce seen before, 'rate_limited' over the key's limit, 'busy' when the relay
-- as a whole takes too many new requests, else 'ok'.
create or replace function public.portmgr_screen_push_admit(
  p_key text, p_kind text, p_nonce text, p_window_seconds integer, p_limit integer
) returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  if p_window_seconds not between 1 and 86400 or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'SCREEN_PUSH_INVALID';
  end if;
  if (select count(*) from public.portmgr_screen_push_requests where created_at > now() - interval '1 minute') >= 120 then
    return 'busy';
  end if;
  -- Kept as long as the longest window or freshness (20 minutes) needs, then dropped.
  delete from public.portmgr_screen_push_requests
   where rate_key = p_key and kind = p_kind
     and created_at < now() - make_interval(secs => greatest(p_window_seconds, 1200));
  insert into public.portmgr_screen_push_requests(rate_key, kind, nonce) values (p_key, p_kind, p_nonce)
  on conflict do nothing;
  if not found then return 'replayed'; end if;
  select count(*) into v_count from public.portmgr_screen_push_requests
   where rate_key = p_key and kind = p_kind and created_at > now() - make_interval(secs => p_window_seconds);
  if v_count > p_limit then return 'rate_limited'; end if;
  return 'ok';
end $$;

-- A device's signed token registration (the relay checked the signature). Only for a Mac that polled; a device the
-- Mac does not list yet takes one of 4 waiting places until the Mac lists it or drops it.
create or replace function public.portmgr_screen_push_register(
  p_mac text, p_device text, p_device_key text, p_token text, p_environment text, p_topic text
) returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_listed text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtext('portmgr_screen_push:' || p_mac));
  select device_ids into v_listed from public.portmgr_screen_push_macs where mac_fingerprint = p_mac;
  if not found then return 'not_ready'; end if;
  if not (p_device = any(v_listed))
     and not exists (select 1 from public.portmgr_screen_push_tokens where mac_fingerprint = p_mac and device_id = p_device)
     and (select count(*) from public.portmgr_screen_push_tokens
           where mac_fingerprint = p_mac and not (device_id = any(v_listed))) >= 4 then
    return 'not_registered';
  end if;
  insert into public.portmgr_screen_push_tokens(mac_fingerprint, device_id, device_key, token, environment, topic, listed_at)
  values (p_mac, p_device, p_device_key, p_token, p_environment, p_topic, case when p_device = any(v_listed) then now() end)
  on conflict (mac_fingerprint, device_id) do update
    set device_key = excluded.device_key, token = excluded.token, environment = excluded.environment,
        topic = excluded.topic, registered_at = now(), listed_at = coalesce(excluded.listed_at, portmgr_screen_push_tokens.listed_at);
  return 'ok';
end $$;

-- Holding the token is the authority to stop pushes to it.
create or replace function public.portmgr_screen_push_unregister(p_mac text, p_device text, p_token text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  delete from public.portmgr_screen_push_tokens where mac_fingerprint = p_mac and device_id = p_device and token = p_token;
  return found;
end $$;

-- The tokens of the devices a Mac's signed event names.
create or replace function public.portmgr_screen_push_targets(p_mac text, p_devices text[])
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  if cardinality(p_devices) > 16 then raise exception using errcode = '22023', message = 'SCREEN_PUSH_INVALID'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('deviceID', device_id, 'token', token, 'environment', environment, 'topic', topic))
    from (select device_id, token, environment, topic from public.portmgr_screen_push_tokens
           where mac_fingerprint = p_mac and device_id = any(p_devices) order by device_id limit 16) t), '[]'::jsonb);
end $$;

-- A token APNs called dead.
create or replace function public.portmgr_screen_push_drop_token(p_mac text, p_device text, p_token text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  delete from public.portmgr_screen_push_tokens where mac_fingerprint = p_mac and device_id = p_device and token = p_token;
end $$;

-- A Mac's signed poll: remember the devices it lists, drop the tokens of devices it no longer lists, keep the first
-- answer to each of its commands, clean up, and hand over the commands still waiting.
create or replace function public.portmgr_screen_push_sync(p_mac text, p_devices text[], p_results jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  if cardinality(p_devices) > 16 or jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results) > 16 then
    raise exception using errcode = '22023', message = 'SCREEN_PUSH_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtext('portmgr_screen_push:' || p_mac));
  insert into public.portmgr_screen_push_macs(mac_fingerprint, device_ids, synced_at) values (p_mac, p_devices, now())
  on conflict (mac_fingerprint) do update set device_ids = excluded.device_ids, synced_at = now();
  update public.portmgr_screen_push_tokens set listed_at = now()
   where mac_fingerprint = p_mac and device_id = any(p_devices);
  -- Revoked or expired at the Mac. A registration a moment old may be newer than the list the Mac sent.
  delete from public.portmgr_screen_push_tokens
   where mac_fingerprint = p_mac and not (device_id = any(p_devices)) and registered_at < now() - interval '2 minutes';
  update public.portmgr_screen_push_commands c set result = r.result, answered_at = now()
    from jsonb_to_recordset(p_results) as r(command_id text, result text)
   where c.command_id = r.command_id and c.mac_fingerprint = p_mac and c.result is null
     and r.result is not null and char_length(r.result) between 1 and 200;
  delete from public.portmgr_screen_push_requests
   where created_at < now() - interval '1 day' or (kind = 'fetch' and created_at < now() - interval '10 minutes');
  delete from public.portmgr_screen_push_commands
   where expires_at < now() - interval '1 day' or answered_at < now() - interval '1 day';
  delete from public.portmgr_screen_push_tokens where coalesce(listed_at, registered_at) < now() - interval '180 days';
  delete from public.portmgr_screen_push_macs where synced_at < now() - interval '180 days';
  return coalesce((select jsonb_agg(jsonb_build_object('message', message, 'signature', signature) order by created_at)
    from (select message, signature, created_at from public.portmgr_screen_push_commands
           where mac_fingerprint = p_mac and result is null and expires_at > now() and device_id = any(p_devices)
           order by created_at limit 16) waiting), '[]'::jsonb);
end $$;

-- A device's signed remote stop, from a device the Mac lists, at most 4 waiting per device and 32 per Mac.
create or replace function public.portmgr_screen_push_queue(
  p_command_id text, p_mac text, p_device text, p_message text, p_signature text, p_expires_at timestamptz
) returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_listed text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  if p_expires_at > now() + interval '8 days' then raise exception using errcode = '22023', message = 'SCREEN_PUSH_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('portmgr_screen_push:' || p_mac));
  select device_ids into v_listed from public.portmgr_screen_push_macs where mac_fingerprint = p_mac;
  if not found then return 'not_ready'; end if;
  if not (p_device = any(v_listed)) then return 'unknown_device'; end if;
  if (select count(*) from public.portmgr_screen_push_commands
       where mac_fingerprint = p_mac and device_id = p_device and result is null and expires_at > now()) >= 4
     or (select count(*) from public.portmgr_screen_push_commands
       where mac_fingerprint = p_mac and result is null and expires_at > now()) >= 32 then
    return 'queue_full';
  end if;
  insert into public.portmgr_screen_push_commands(command_id, mac_fingerprint, device_id, message, signature, expires_at)
  values (p_command_id, p_mac, p_device, p_message, p_signature, p_expires_at)
  on conflict (command_id) do nothing;
  return 'ok';
end $$;

-- The Mac's signed answer to one command, or null while there is none.
create or replace function public.portmgr_screen_push_status(p_command_id text)
returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'SCREEN_PUSH_FORBIDDEN';
  end if;
  return (select result from public.portmgr_screen_push_commands where command_id = p_command_id);
end $$;

revoke all on function public.portmgr_screen_push_admit(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_register(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_unregister(text, text, text) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_targets(text, text[]) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_drop_token(text, text, text) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_sync(text, text[], jsonb) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_queue(text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.portmgr_screen_push_status(text) from public, anon, authenticated;
grant execute on function public.portmgr_screen_push_admit(text, text, text, integer, integer) to service_role;
grant execute on function public.portmgr_screen_push_register(text, text, text, text, text, text) to service_role;
grant execute on function public.portmgr_screen_push_unregister(text, text, text) to service_role;
grant execute on function public.portmgr_screen_push_targets(text, text[]) to service_role;
grant execute on function public.portmgr_screen_push_drop_token(text, text, text) to service_role;
grant execute on function public.portmgr_screen_push_sync(text, text[], jsonb) to service_role;
grant execute on function public.portmgr_screen_push_queue(text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.portmgr_screen_push_status(text) to service_role;
