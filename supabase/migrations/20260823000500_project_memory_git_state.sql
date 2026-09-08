-- A memory hash alone cannot tell whether every device is also on the same
-- repository revision. Store a bounded, network-free snapshot beside each
-- device's memory status. Upstream values are the last locally fetched refs.
alter table public.portmgr_project_memory_devices
  add column if not exists git_head_sha text,
  add column if not exists git_branch text,
  add column if not exists git_remote_url text,
  add column if not exists git_upstream_sha text,
  add column if not exists git_ahead integer,
  add column if not exists git_behind integer,
  add column if not exists git_dirty boolean,
  add column if not exists git_commit_at timestamptz,
  add column if not exists git_checked_at timestamptz;

comment on column public.portmgr_project_memory_devices.git_upstream_sha is
  'Last locally fetched upstream SHA; this write does not contact GitHub.';
comment on column public.portmgr_project_memory_devices.git_checked_at is
  'When the local Git snapshot was collected.';
