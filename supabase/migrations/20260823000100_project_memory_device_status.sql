-- One durable row per memory/device. Revision history alone cannot prove that a
-- device pulled the current head because a successful Pull creates no revision.
create table if not exists public.portmgr_project_memory_devices (
  memory_id text not null,
  device_id text not null,
  device_name text,
  platform text,
  revision_id text,
  content_hash text,
  last_synced_at timestamptz,
  last_seen_at timestamptz not null default now(),
  primary key (memory_id, device_id)
);
create index if not exists idx_portmgr_project_memory_devices_seen
  on public.portmgr_project_memory_devices(memory_id, last_seen_at desc);

alter table public.portmgr_project_memory_devices enable row level security;
drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_devices;
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_devices;
create policy portmgr_authenticated_read on public.portmgr_project_memory_devices
  for select to authenticated
  using ((select public.portmgr_is_member()));

revoke all privileges on table public.portmgr_project_memory_devices
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_project_memory_devices to authenticated;
grant select, insert, update on table public.portmgr_project_memory_devices to service_role;
