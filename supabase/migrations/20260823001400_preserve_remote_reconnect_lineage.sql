-- A reconnect enrollment may already name a revoked physical-device predecessor.
-- Claiming without a still-valid old credential must not erase that explicit lineage.
create or replace function public.portmgr_preserve_remote_reconnect_lineage()
returns trigger
language plpgsql set search_path = public as $$
begin
  if old.previous_device_id is not null
    and new.previous_device_id is null
    and old.claimed_at is null
    and new.claimed_at is not null then
    new.previous_device_id := old.previous_device_id;
  end if;
  return new;
end;
$$;

drop trigger if exists portmgr_preserve_remote_reconnect_lineage
  on public.portmgr_remote_device_enrollments;
create trigger portmgr_preserve_remote_reconnect_lineage
before update of previous_device_id on public.portmgr_remote_device_enrollments
for each row execute function public.portmgr_preserve_remote_reconnect_lineage();
