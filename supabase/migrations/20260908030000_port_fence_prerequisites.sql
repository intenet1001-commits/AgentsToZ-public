-- Additive repair for legacy databases whose ports table predates the current
-- installer. RPC bodies use the complete row type, even for a partial patch.
-- Keep existing rows/values and their unknown creation times unchanged.
alter table public.portmgr_ports add column if not exists device_id text;
alter table public.portmgr_ports add column if not exists device_name text;
alter table public.portmgr_ports add column if not exists terminal_command text;
alter table public.portmgr_ports add column if not exists worktree_parent_id text;
alter table public.portmgr_ports add column if not exists github_urls text[];
alter table public.portmgr_ports add column if not exists manual_path text;
alter table public.portmgr_ports add column if not exists log_file_path text;
alter table public.portmgr_ports add column if not exists favorite boolean default false;
alter table public.portmgr_ports add column if not exists category text;
alter table public.portmgr_ports add column if not exists description text;
alter table public.portmgr_ports add column if not exists memo text;
alter table public.portmgr_ports add column if not exists memo_updated_at timestamptz;
alter table public.portmgr_ports add column if not exists memory_id text;
alter table public.portmgr_ports add column if not exists created_at timestamptz;
alter table public.portmgr_ports alter column created_at set default now();
