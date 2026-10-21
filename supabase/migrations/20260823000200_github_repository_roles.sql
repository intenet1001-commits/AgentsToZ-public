-- Explicit shared ownership/collaboration metadata. Repository owner can be
-- derived from the URL; collaborators cannot be inferred safely without a
-- GitHub token, especially for private repositories.
create table if not exists public.portmgr_github_repository_roles (
  repository_url text primary key,
  owner_login text not null,
  collaborators text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.portmgr_github_repository_roles enable row level security;
drop policy if exists portmgr_authenticated_all on public.portmgr_github_repository_roles;
create policy portmgr_authenticated_all on public.portmgr_github_repository_roles
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table public.portmgr_github_repository_roles from public, anon;
grant select, insert, update, delete on table public.portmgr_github_repository_roles to authenticated, service_role;
