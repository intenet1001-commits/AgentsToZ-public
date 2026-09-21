-- Server-enforced email membership for every portmgr_* RLS policy.
-- Existing function-based allowlists are copied before replacement. An empty
-- member table denies every authenticated user until an owner is inserted.

create table if not exists public.portmgr_allowed_members (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint portmgr_allowed_members_normalized check (
    email = lower(btrim(email))
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);
alter table public.portmgr_allowed_members enable row level security;

do $portmgr_membership_migrate$
begin
  if to_regprocedure('public.portmgr_allowed_emails()') is not null then
    execute $copy$
      insert into public.portmgr_allowed_members(email)
      select distinct lower(btrim(value))
      from unnest(public.portmgr_allowed_emails()) as value
      where btrim(value) <> ''
      on conflict (email) do nothing
    $copy$;
  end if;
end
$portmgr_membership_migrate$;

alter table public.portmgr_allowed_members enable row level security;
revoke all privileges on table public.portmgr_allowed_members from public, anon, authenticated;
grant select, insert, update, delete on table public.portmgr_allowed_members to service_role;

create or replace function public.portmgr_allowed_emails()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(email order by email), array[]::text[])
  from public.portmgr_allowed_members;
$$;

create or replace function public.portmgr_is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and exists (
      select 1
      from public.portmgr_allowed_members member
      where member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all on function public.portmgr_allowed_emails() from public, anon, authenticated;
revoke all on function public.portmgr_is_member() from public, anon;
grant execute on function public.portmgr_is_member() to authenticated;

-- Configure at least one owner through SQL Editor or the setup wizard-generated
-- migration. Example (replace the value; do not commit a personal address):
-- insert into public.portmgr_allowed_members(email)
-- values ('owner@example.com')
-- on conflict (email) do nothing;
