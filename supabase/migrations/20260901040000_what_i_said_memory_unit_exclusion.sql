-- 제외를 기기별에서 **장기기억 단위**로 옮긴다. 기기별로 두면 Mac A 에서 제외해도
-- Mac B 가 계속 올려서, 사용자가 "뺐다"고 믿는 프로젝트가 원격에 남는다.
-- 전역 스위치(이 Mac 이 적재를 하는가)는 기기의 결정이라 로컬에 그대로 둔다.

create table if not exists public.portmgr_what_i_said_memory_policy (
  memory_id text primary key,
  upload_excluded boolean not null default false,
  excluded_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_portmgr_what_i_said_memory_policy_excluded
  on public.portmgr_what_i_said_memory_policy(memory_id)
  where upload_excluded;

alter table portmgr_what_i_said_memory_policy enable row level security;
drop policy if exists "anon_all" on portmgr_what_i_said_memory_policy;
drop policy if exists "Enable read access for all users" on portmgr_what_i_said_memory_policy;
drop policy if exists portmgr_authenticated_all on portmgr_what_i_said_memory_policy;
create policy portmgr_authenticated_all on portmgr_what_i_said_memory_policy
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table portmgr_what_i_said_memory_policy from anon;
revoke all privileges on table portmgr_what_i_said_memory_policy from public;
grant select, insert, update, delete on table portmgr_what_i_said_memory_policy to authenticated, service_role;