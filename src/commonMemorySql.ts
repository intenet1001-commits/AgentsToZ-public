export const COMMON_MEMORY_TABLES=['portmgr_common_memories','portmgr_common_memory_sources','portmgr_common_memory_revisions','portmgr_common_memory_operations','portmgr_common_memory_applications','portmgr_common_memory_bindings'] as const;
/** Server-mediated writes; existing member authentication is reused for cloud reads. */
export const COMMON_MEMORY_SQL = `
create table if not exists public.portmgr_common_memories (
  group_id uuid primary key,
  version bigint not null check (version > 0),
  state jsonb not null check (state->>'schemaVersion'='1'),
  updated_at timestamptz not null default now()
);
create table if not exists public.portmgr_common_memory_sources (
  group_id uuid not null references public.portmgr_common_memories(group_id),
  memory_id text not null,
  active boolean not null default true,
  primary key(group_id,memory_id)
);
create index if not exists idx_common_memory_source_active on public.portmgr_common_memory_sources(memory_id,group_id) where active;
create table if not exists public.portmgr_common_memory_revisions (
  revision_id uuid primary key,
  group_id uuid not null references public.portmgr_common_memories(group_id),
  parent_revision_id uuid references public.portmgr_common_memory_revisions(revision_id),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(group_id,revision_id)
);
create index if not exists idx_common_memory_revisions_group on public.portmgr_common_memory_revisions(group_id,created_at desc);
create table if not exists public.portmgr_common_memory_operations (
  group_id uuid not null references public.portmgr_common_memories(group_id),
  request_id text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(group_id,request_id)
);
create table if not exists public.portmgr_common_memory_applications (
  application_id uuid primary key,
  group_id uuid not null,
  revision_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  foreign key(group_id,revision_id) references public.portmgr_common_memory_revisions(group_id,revision_id)
);
create index if not exists idx_common_memory_applications_group on public.portmgr_common_memory_applications(group_id,created_at desc);
create table if not exists public.portmgr_common_memory_bindings (
  project_memory_id text primary key,
  project_goal text not null,
  selections jsonb not null check (jsonb_typeof(selections)='array'),
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
${COMMON_MEMORY_TABLES.map(table=>`alter table public.${table} enable row level security;
revoke all privileges on table public.${table} from public, anon, authenticated;
grant select on table public.${table} to authenticated;
drop policy if exists common_memory_member_read on public.${table};
create policy common_memory_member_read on public.${table} for select to authenticated using ((select public.portmgr_is_member()));
grant select, insert on table public.${table} to service_role;`).join('\n')}
grant update on public.portmgr_common_memories, public.portmgr_common_memory_sources, public.portmgr_common_memory_bindings to service_role;

create or replace function public.portmgr_write_common_memory(
  p_group_id uuid, p_expected_version bigint, p_state jsonb, p_request_id text, p_request_hash text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_old portmgr_common_memories%rowtype; v_receipt portmgr_common_memory_operations%rowtype;
  v_version bigint; v_head jsonb; v_result jsonb; v_revision uuid; v_parent uuid;
begin
  if p_state->>'id' is distinct from p_group_id::text or p_state->>'schemaVersion' is distinct from '1'
    or p_expected_version is null or p_expected_version<0 or p_request_id is null or p_request_hash is null
    or octet_length(p_state::text)>1000000 or jsonb_typeof(p_state->'sourceMemoryIds') is distinct from 'array'
    or jsonb_array_length(p_state->'sourceMemoryIds') not between 0 and 16
    or (jsonb_array_length(p_state->'sourceMemoryIds')=0 and p_state->'portableKnowledge'->>'schemaVersion' is distinct from '1')
    or length(p_request_id) not between 1 and 200 or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='COMMON_MEMORY_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_group_id::text,741));
  select * into v_receipt from portmgr_common_memory_operations where group_id=p_group_id and request_id=p_request_id;
  if found then
    if v_receipt.request_hash<>p_request_hash then raise exception 'COMMON_MEMORY_REQUEST_CONFLICT'; end if;
    select * into v_old from portmgr_common_memories where group_id=p_group_id;
    return jsonb_build_object('state',v_old.state,'version',v_old.version,'replayed',true,'committedVersion',v_receipt.result->'version');
  end if;
  select * into v_old from portmgr_common_memories where group_id=p_group_id for update;
  if coalesce(v_old.version,0)<>p_expected_version then raise exception 'COMMON_MEMORY_VERSION_CHANGED'; end if;
  if p_state ? 'portableKnowledge' then
    if p_state->'portableKnowledge'->>'schemaVersion' is distinct from '1'
      or p_state->'portableKnowledge'->'snapshot'->>'id' is distinct from p_group_id::text
      or p_state->'portableKnowledge'->'current'->>'id' is distinct from p_group_id::text
      or jsonb_typeof(p_state->'portableKnowledge'->'snapshot'->'entries') is distinct from 'array'
      or jsonb_typeof(p_state->'portableKnowledge'->'current'->'entries') is distinct from 'array'
      or jsonb_array_length(p_state->'portableKnowledge'->'current'->'entries')>256
      or jsonb_typeof(p_state->'portableKnowledge'->'current'->'members') is distinct from 'array'
      or jsonb_array_length(p_state->'portableKnowledge'->'current'->'members')>2000
      or jsonb_typeof(p_state->'goalConfigured') is distinct from 'boolean'
      or p_state->'portableKnowledge'->'current'->>'name' is distinct from p_state->>'name'
      or p_state->'portableKnowledge'->'current'->>'archived' is distinct from p_state->>'archived'
    then raise exception 'COMMON_MEMORY_KNOWLEDGE_INVALID'; end if;
  end if;
  if v_old.state ? 'portableKnowledge' and (
    not (p_state ? 'portableKnowledge')
    or p_state->'portableKnowledge'->'snapshot' is distinct from v_old.state->'portableKnowledge'->'snapshot'
    or p_state->'portableKnowledge'->'sourceFingerprint' is distinct from v_old.state->'portableKnowledge'->'sourceFingerprint'
    or p_state->'portableKnowledge'->'importedAt' is distinct from v_old.state->'portableKnowledge'->'importedAt'
  ) then raise exception 'COMMON_MEMORY_KNOWLEDGE_INVALID'; end if;
  v_version:=p_expected_version+1;
  if p_state->'publication' is not null and p_state->'publication'<>'null'::jsonb
    and p_state->'publication'->>'id' is distinct from v_old.state->'publication'->>'id' then
    if p_state->>'goalConfigured'='false' or jsonb_array_length(p_state->'sourceMemoryIds') not between 1 and 16
      or p_state->'publication'->>'goalVersion' is distinct from p_state->>'goalVersion'
      or jsonb_typeof(p_state->'publication'->'items') is distinct from 'array'
      or jsonb_array_length(p_state->'publication'->'items') not between 1 and 500
      or exists(select 1 from jsonb_array_elements(p_state->'publication'->'items') i where i->>'state' is distinct from 'reviewed' or i->>'goalVersion' is distinct from p_state->>'goalVersion')
      or jsonb_typeof(p_state->'publication'->'sourceHeads') is distinct from 'array'
      or jsonb_array_length(p_state->'publication'->'sourceHeads')<>jsonb_array_length(p_state->'sourceMemoryIds')
      or exists(select 1 from jsonb_array_elements(p_state->'publication'->'sourceHeads') h where not (p_state->'sourceMemoryIds' ? (h->>'memoryId')))
      or (select count(distinct h->>'memoryId') from jsonb_array_elements(p_state->'publication'->'sourceHeads') h)<>jsonb_array_length(p_state->'sourceMemoryIds')
      then raise exception 'COMMON_MEMORY_REVIEW_REQUIRED'; end if;
    -- Serialize source publication/merge with the existing memory head/ledger locks.
    for v_head in select value from jsonb_array_elements(p_state->'publication'->'sourceHeads') order by value->>'memoryId' loop
      perform pg_advisory_xact_lock(hashtextextended('portmgr-project-memory-ledger:'||(v_head->>'memoryId'),0));
      perform 1 from portmgr_project_memory_heads h where h.memory_id=v_head->>'memoryId' for share;
      if not exists(select 1 from portmgr_project_memory_heads h join portmgr_project_memory_revisions r on r.id=h.head_revision_id
        where h.memory_id=v_head->>'memoryId' and h.head_revision_id=v_head->>'revisionId' and r.content_hash=v_head->>'contentHash')
        or public.portmgr_resolve_project_memory_id(v_head->>'memoryId')<>v_head->>'memoryId'
        or exists(select 1 from portmgr_project_memory_trash t where t.memory_id=v_head->>'memoryId' and t.trashed_at is not null)
      then raise exception 'COMMON_MEMORY_SOURCE_CHANGED'; end if;
    end loop;
    v_revision:=(p_state->'publication'->>'id')::uuid;
    v_parent:=(v_old.state->'publication'->>'id')::uuid;
  end if;
  insert into portmgr_common_memories(group_id,version,state) values(p_group_id,v_version,p_state)
    on conflict(group_id) do update set version=excluded.version,state=excluded.state,updated_at=now();
  update portmgr_common_memory_sources set active=false where group_id=p_group_id;
  insert into portmgr_common_memory_sources(group_id,memory_id,active)
    select p_group_id,value,true from jsonb_array_elements_text(p_state->'sourceMemoryIds')
    on conflict(group_id,memory_id) do update set active=true;
  if v_revision is not null then insert into portmgr_common_memory_revisions(revision_id,group_id,parent_revision_id,payload)
    values(v_revision,p_group_id,v_parent,p_state->'publication'); end if;
  v_result:=jsonb_build_object('state',p_state,'version',v_version);
  insert into portmgr_common_memory_operations(group_id,request_id,request_hash,result) values(p_group_id,p_request_id,p_request_hash,jsonb_build_object('version',v_version,'revisionId',v_revision,'knowledgeRevision',p_state->'portableKnowledge'->'current'->'revision','knowledgeOperation',case when v_old.version is null then 'migration' else 'cloud-update' end,'knowledgeBefore',case when v_old.state->'portableKnowledge'->'current' is distinct from p_state->'portableKnowledge'->'current' then v_old.state->'portableKnowledge'->'current' else null end,'knowledgeAfter',case when v_old.state->'portableKnowledge'->'current' is distinct from p_state->'portableKnowledge'->'current' then p_state->'portableKnowledge'->'current' else null end));
  return v_result;
end; $$;
revoke all on function public.portmgr_write_common_memory(uuid,bigint,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.portmgr_write_common_memory(uuid,bigint,jsonb,text,text) to service_role;

create or replace function public.portmgr_bind_common_memory(p_memory_id text,p_project_goal text,p_selections jsonb,p_expected_version bigint)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_version bigint; v_selection jsonb; v_head jsonb;
begin
  if length(p_project_goal) not between 1 and 12000 or jsonb_typeof(p_selections) is distinct from 'array' or jsonb_array_length(p_selections)>8 then raise exception 'COMMON_MEMORY_INPUT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_memory_id,742));
  select version into v_version from portmgr_common_memory_bindings where project_memory_id=p_memory_id for update;
  if coalesce(v_version,0)<>p_expected_version then raise exception 'COMMON_MEMORY_VERSION_CHANGED'; end if;
  for v_selection in select value from jsonb_array_elements(p_selections) order by value->>'groupId' loop
    perform pg_advisory_xact_lock(hashtextextended(v_selection->>'groupId',741));
    perform 1 from portmgr_common_memories where group_id=(v_selection->>'groupId')::uuid for share;
    if not exists(select 1 from portmgr_common_memory_revisions r where r.group_id=(v_selection->>'groupId')::uuid and r.revision_id=(v_selection->>'revisionId')::uuid and r.payload->>'goalVersion'=v_selection->>'goalVersion') then raise exception 'COMMON_MEMORY_REVIEW_REQUIRED'; end if;
    if not exists(select 1 from portmgr_common_memories g where g.group_id=(v_selection->>'groupId')::uuid and g.state->>'archived'='false' and g.state->'publication'->>'id'=v_selection->>'revisionId' and g.state->>'goalVersion'=v_selection->>'goalVersion') then raise exception 'COMMON_MEMORY_REVIEW_REQUIRED'; end if;
  end loop;
  for v_head in select h.value from portmgr_common_memory_revisions r join jsonb_array_elements(p_selections) s on r.revision_id=(s->>'revisionId')::uuid cross join lateral jsonb_array_elements(r.payload->'sourceHeads') h order by h.value->>'memoryId' loop
    perform pg_advisory_xact_lock(hashtextextended('portmgr-project-memory-ledger:'||(v_head->>'memoryId'),0));
    perform 1 from portmgr_project_memory_heads where memory_id=v_head->>'memoryId' for share;
    if not exists(select 1 from portmgr_project_memory_heads h join portmgr_project_memory_revisions r on r.id=h.head_revision_id where h.memory_id=v_head->>'memoryId' and h.head_revision_id=v_head->>'revisionId' and r.content_hash=v_head->>'contentHash')
      or public.portmgr_resolve_project_memory_id(v_head->>'memoryId')<>v_head->>'memoryId'
      or exists(select 1 from portmgr_project_memory_trash where memory_id=v_head->>'memoryId' and trashed_at is not null) then raise exception 'COMMON_MEMORY_SOURCE_CHANGED'; end if;
  end loop;
  v_version:=coalesce(v_version,0)+1;
  insert into portmgr_common_memory_bindings(project_memory_id,project_goal,selections,version) values(p_memory_id,p_project_goal,p_selections,v_version)
    on conflict(project_memory_id) do update set project_goal=excluded.project_goal,selections=excluded.selections,version=excluded.version,updated_at=now();
  return jsonb_build_object('version',v_version);
end; $$;
revoke all on function public.portmgr_bind_common_memory(text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.portmgr_bind_common_memory(text,text,jsonb,bigint) to service_role;
`;
