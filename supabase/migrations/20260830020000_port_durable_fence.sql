-- Permanent generation CAS prevents stale overwrites and resurrection of a
-- physically deleted port row. Authenticated clients mutate only through the
-- atomic RPCs below; triggers retain defense for privileged/legacy direct DML.

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

alter table public.portmgr_ports
  add column if not exists sync_generation bigint not null default 0;
alter table public.portmgr_ports add column if not exists memory_id text;
alter table public.portmgr_ports alter column sync_generation set default 0;
update public.portmgr_ports set sync_generation = 0 where sync_generation is null;
alter table public.portmgr_ports alter column sync_generation set not null;

create table if not exists public.portmgr_port_fences (
  port_id text primary key,
  generation bigint not null default 0 check (generation >= 0),
  state text not null default 'active' check (state in ('active', 'deleted')),
  owner_device_id text,
  deleted_name text,
  operation_id uuid,
  operation_base_generation bigint check (
    operation_base_generation is null or operation_base_generation >= 0
  ),
  operation_payload_sha256 text check (
    operation_payload_sha256 is null
    or operation_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  changed_at timestamptz not null default now()
);
alter table public.portmgr_port_fences add column if not exists deleted_name text;
alter table public.portmgr_port_fences
  add column if not exists operation_base_generation bigint;
alter table public.portmgr_port_fences
  add column if not exists operation_payload_sha256 text;
alter table public.portmgr_port_fences drop column if exists operation_payload;

insert into public.portmgr_port_fences(
  port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
)
select port.id, port.sync_generation, 'active', port.device_id, null, null, now()
from public.portmgr_ports port
on conflict (port_id) do nothing;

create or replace function public.portmgr_enforce_port_fence_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fence public.portmgr_port_fences%rowtype;
  v_upsert_operation_id text;
  v_upsert_port_id text;
  v_upsert_base_generation text;
  v_upsert_target_generation text;
begin
  if new.id is null or new.id = '' then
    raise exception using errcode = '23502', message = 'PORT_FENCE_ID_REQUIRED';
  end if;
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception using errcode = '22023', message = 'PORT_FENCE_ID_IMMUTABLE';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || new.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = new.id
  for update;

  if not found then
    if tg_op = 'UPDATE' then
      insert into public.portmgr_port_fences(
        port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
      ) values (
        old.id, old.sync_generation, 'active', old.device_id, null, null, now()
      )
      on conflict (port_id) do nothing;
    else
      insert into public.portmgr_port_fences(
        port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
      ) values (
        new.id, 0, 'active', new.device_id, null, null, now()
      )
      on conflict (port_id) do nothing;
    end if;
    select fence.* into strict v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = new.id
    for update;
  end if;

  if v_fence.state <> 'active' then
    raise exception using
      errcode = '55000',
      message = 'PORT_FENCE_DELETED',
      detail = new.id;
  end if;

  if tg_op = 'INSERT' then
    if new.sync_generation is distinct from v_fence.generation then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_GENERATION_MISMATCH',
        detail = new.id;
    end if;
    if v_fence.owner_device_id is distinct from new.device_id then
      raise exception using
        errcode = '22023',
        message = 'PORT_FENCE_OWNER_IMMUTABLE',
        detail = new.id;
    end if;
    return new;
  end if;

  if new.device_id is distinct from old.device_id
    or v_fence.owner_device_id is distinct from old.device_id then
    raise exception using
      errcode = '22023',
      message = 'PORT_FENCE_OWNER_IMMUTABLE',
      detail = new.id;
  end if;

  if new.sync_generation is not distinct from old.sync_generation then
    if new.sync_generation is distinct from v_fence.generation then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_GENERATION_MISMATCH',
        detail = new.id;
    end if;
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_UPSERT_RPC_REQUIRED',
        detail = new.id;
    end if;
    return new;
  end if;

  if old.sync_generation = 9223372036854775807 then
    raise exception using
      errcode = '22003',
      message = 'PORT_FENCE_GENERATION_EXHAUSTED',
      detail = new.id;
  end if;
  if new.sync_generation is distinct from old.sync_generation + 1
    or v_fence.generation is distinct from new.sync_generation then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_GENERATION_ADVANCE_INVALID',
      detail = new.id;
  end if;

  v_upsert_operation_id := nullif(
    current_setting('portmgr.port_upsert_operation_id', true),
    ''
  );
  v_upsert_port_id := nullif(
    current_setting('portmgr.port_upsert_port_id', true),
    ''
  );
  v_upsert_base_generation := nullif(
    current_setting('portmgr.port_upsert_base_generation', true),
    ''
  );
  v_upsert_target_generation := nullif(
    current_setting('portmgr.port_upsert_target_generation', true),
    ''
  );
  if v_fence.operation_id is null
    or v_fence.operation_payload_sha256 is null
    or v_upsert_operation_id is distinct from v_fence.operation_id::text
    or v_upsert_port_id is distinct from new.id
    or v_upsert_base_generation is distinct from old.sync_generation::text
    or v_upsert_target_generation is distinct from new.sync_generation::text
    or v_fence.operation_base_generation is distinct from old.sync_generation then
    raise exception using
      errcode = '42501',
      message = 'PORT_FENCE_GENERATION_ADVANCE_UNAUTHORIZED',
      detail = new.id;
  end if;
  return new;
end;
$$;

create or replace function public.portmgr_tombstone_port_fence_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fence public.portmgr_port_fences%rowtype;
  v_operation_setting text;
  v_operation_id uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || old.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = old.id
  for update;

  if not found then
    insert into public.portmgr_port_fences(
      port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
    ) values (
      old.id, old.sync_generation, 'active', old.device_id, null, null, now()
    )
    on conflict (port_id) do nothing;
    select fence.* into strict v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = old.id
    for update;
  end if;

  if v_fence.state <> 'active'
    or v_fence.generation is distinct from old.sync_generation then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_DELETE_GENERATION_MISMATCH',
      detail = old.id;
  end if;
  if v_fence.generation = 9223372036854775807 then
    raise exception using
      errcode = '22003',
      message = 'PORT_FENCE_GENERATION_EXHAUSTED',
      detail = old.id;
  end if;

  v_operation_setting := nullif(
    current_setting('portmgr.port_deletion_operation_id', true),
    ''
  );
  v_operation_id := case
    when v_operation_setting is null then gen_random_uuid()
    else v_operation_setting::uuid
  end;

  update public.portmgr_port_fences fence
  set generation = fence.generation + 1,
      state = 'deleted',
      owner_device_id = old.device_id,
      deleted_name = old.name,
      operation_id = v_operation_id,
      operation_base_generation = old.sync_generation,
      operation_payload_sha256 = null,
      changed_at = now()
  where fence.port_id = old.id
    and fence.state = 'active'
    and fence.generation = old.sync_generation;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_DELETE_GENERATION_MISMATCH',
      detail = old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists portmgr_enforce_port_fence_write
  on public.portmgr_ports;
create trigger portmgr_enforce_port_fence_write
before insert or update on public.portmgr_ports
for each row execute function public.portmgr_enforce_port_fence_write();

drop trigger if exists portmgr_tombstone_port_fence_on_delete
  on public.portmgr_ports;
create trigger portmgr_tombstone_port_fence_on_delete
before delete on public.portmgr_ports
for each row execute function public.portmgr_tombstone_port_fence_on_delete();

create or replace function public.portmgr_upsert_ports_if_generation_matches(
  p_rows jsonb,
  p_upsert_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_payload jsonb;
  v_payload_sha256 text;
  v_row public.portmgr_ports%rowtype;
  v_existing public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_existing_found boolean;
  v_fence_found boolean;
  v_port_id text;
  v_new_generation bigint;
  v_row_changed boolean;
  v_mutation_count integer := 0;
  v_replay_count integer := 0;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_upsert_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_rows is null
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in (
          'id', 'sync_generation', 'device_id', 'device_name', 'name', 'port',
          'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
          'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
          'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
          'created_at'
        )
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct (item ->> 'id'))
    from jsonb_array_elements(p_rows) as supplied(item)
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROW_DUPLICATE';
  end if;

  for v_port_id in
    select item ->> 'id'
    from jsonb_array_elements(p_rows) as supplied(item)
    order by item ->> 'id'
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_item in
    select item
    from jsonb_array_elements(p_rows) as supplied(item)
    order by item ->> 'id'
  loop
    v_port_id := v_item ->> 'id';
    v_payload := jsonb_set(
      v_item,
      '{sync_generation}',
      to_jsonb(((v_item ->> 'sync_generation')::bigint)::text),
      true
    );
    v_payload_sha256 := encode(
      sha256(convert_to(v_payload::text, 'UTF8')),
      'hex'
    );
    select port.* into v_existing
    from public.portmgr_ports port
    where port.id = v_port_id
    for update;
    v_existing_found := found;

    if v_existing_found then
      select * into v_row
      from jsonb_populate_record(v_existing, v_item);
      v_row_changed := (to_jsonb(v_existing) - 'sync_generation')
        is distinct from (to_jsonb(v_row) - 'sync_generation');
    else
      select * into v_row
      from jsonb_populate_record(null::public.portmgr_ports, v_item);
      if not (v_item ? 'favorite') then v_row.favorite := false; end if;
      if not (v_item ? 'created_at') then v_row.created_at := now(); end if;
      v_row_changed := true;
    end if;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_port_id
    for update;
    v_fence_found := found;

    if not v_fence_found then
      if v_existing_found or v_row.sync_generation <> 0 then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
          detail = v_row.id;
      end if;
      v_mutation_count := v_mutation_count + 1;
    elsif v_fence.state <> 'active' then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_DELETED',
        detail = v_row.id;
    elsif v_fence.operation_id = p_upsert_op_id then
      if not v_existing_found
        or v_fence.operation_base_generation is distinct from v_row.sync_generation
        or v_fence.operation_payload_sha256 is distinct from v_payload_sha256
        or v_existing.sync_generation is distinct from v_fence.generation
        or v_existing.device_id is distinct from v_row.device_id
        or v_fence.owner_device_id is distinct from v_existing.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_OPERATION_REUSED',
          detail = v_row.id;
      end if;
      v_replay_count := v_replay_count + 1;
    elsif not v_existing_found
      or v_fence.generation is distinct from v_row.sync_generation
      or v_existing.sync_generation is distinct from v_row.sync_generation then
      -- A caller that lost a committed response may retry with a fresh UUID
      -- and the old generation. Adopt only the immediately preceding exact
      -- base+payload operation. A generic partial-patch no-op is insufficient:
      -- it could otherwise grant a stale client write authority over omitted
      -- columns that another client changed.
      if v_existing_found
        and v_fence.generation is not distinct from v_existing.sync_generation
        and v_existing.sync_generation > v_row.sync_generation
        and not v_row_changed
        and v_existing.device_id is not distinct from v_row.device_id
        and v_fence.owner_device_id is not distinct from v_existing.device_id
        and v_fence.operation_base_generation is not distinct from v_row.sync_generation
        and v_fence.operation_payload_sha256 is not distinct from v_payload_sha256 then
        v_mutation_count := v_mutation_count + 1;
      else
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
          detail = v_row.id;
      end if;
    elsif v_existing.device_id is distinct from v_row.device_id
      or v_fence.owner_device_id is distinct from v_existing.device_id then
      raise exception using
        errcode = '22023',
        message = 'PORT_FENCE_OWNER_IMMUTABLE',
        detail = v_row.id;
    elsif v_row_changed
      and v_fence.generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_row.id;
    else
      v_mutation_count := v_mutation_count + 1;
    end if;
  end loop;

  if v_mutation_count > 0 and v_replay_count > 0 then
    raise exception using errcode = '40001', message = 'PORT_FENCE_UPSERT_MIXED_REPLAY';
  end if;

  if v_mutation_count > 0 then
    for v_item in
      select item
      from jsonb_array_elements(p_rows) as supplied(item)
      order by item ->> 'id'
    loop
      v_port_id := v_item ->> 'id';
      v_payload := jsonb_set(
        v_item,
        '{sync_generation}',
        to_jsonb(((v_item ->> 'sync_generation')::bigint)::text),
        true
      );
      v_payload_sha256 := encode(
        sha256(convert_to(v_payload::text, 'UTF8')),
        'hex'
      );
      select port.* into v_existing
      from public.portmgr_ports port
      where port.id = v_port_id
      for update;
      v_existing_found := found;
      if v_existing_found then
        select * into v_row
        from jsonb_populate_record(v_existing, v_item);
        v_row_changed := (to_jsonb(v_existing) - 'sync_generation')
          is distinct from (to_jsonb(v_row) - 'sync_generation');
      else
        select * into v_row
        from jsonb_populate_record(null::public.portmgr_ports, v_item);
        if not (v_item ? 'favorite') then v_row.favorite := false; end if;
        if not (v_item ? 'created_at') then v_row.created_at := now(); end if;
        v_row_changed := true;
      end if;

      if v_existing_found then
        -- A byte-identical patch records bounded latest-operation metadata but
        -- keeps the generation stable, avoiding a Push/Pull feedback loop.
        update public.portmgr_port_fences fence
        set generation = case
              when v_row_changed then fence.generation + 1
              else fence.generation
            end,
            deleted_name = null,
            operation_id = p_upsert_op_id,
            operation_base_generation = v_row.sync_generation,
            operation_payload_sha256 = v_payload_sha256,
            changed_at = now()
        where fence.port_id = v_row.id
          and fence.state = 'active'
          and fence.generation = v_existing.sync_generation
          and fence.owner_device_id is not distinct from v_existing.device_id
        returning fence.generation into v_new_generation;
        if not found then
          raise exception using
            errcode = '40001',
            message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
            detail = v_row.id;
        end if;

        if v_row_changed then
          v_row.sync_generation := v_new_generation;
          perform set_config(
            'portmgr.port_upsert_operation_id',
            p_upsert_op_id::text,
            true
          );
          perform set_config('portmgr.port_upsert_port_id', v_row.id, true);
          perform set_config(
            'portmgr.port_upsert_base_generation',
            v_existing.sync_generation::text,
            true
          );
          perform set_config(
            'portmgr.port_upsert_target_generation',
            v_new_generation::text,
            true
          );
          update public.portmgr_ports port
          set device_id = v_row.device_id,
              device_name = v_row.device_name,
              name = v_row.name,
              port = v_row.port,
              command_path = v_row.command_path,
              terminal_command = v_row.terminal_command,
              folder_path = v_row.folder_path,
              worktree_parent_id = v_row.worktree_parent_id,
              deploy_url = v_row.deploy_url,
              github_url = v_row.github_url,
              github_urls = v_row.github_urls,
              manual_path = v_row.manual_path,
              log_file_path = v_row.log_file_path,
              favorite = v_row.favorite,
              category = v_row.category,
              description = v_row.description,
              memo = v_row.memo,
              memo_updated_at = v_row.memo_updated_at,
              memory_id = v_row.memory_id,
              created_at = v_row.created_at,
              sync_generation = v_row.sync_generation
          where port.id = v_row.id
            and port.sync_generation = v_existing.sync_generation
            and port.device_id is not distinct from v_existing.device_id;
          if not found then
            raise exception using
              errcode = '40001',
              message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
              detail = v_row.id;
          end if;
          perform set_config('portmgr.port_upsert_operation_id', '', true);
          perform set_config('portmgr.port_upsert_port_id', '', true);
          perform set_config('portmgr.port_upsert_base_generation', '', true);
          perform set_config('portmgr.port_upsert_target_generation', '', true);
        end if;
      else
        insert into public.portmgr_port_fences(
          port_id, generation, state, owner_device_id, deleted_name, operation_id,
          operation_base_generation, operation_payload_sha256, changed_at
        ) values (
          v_row.id, 0, 'active', v_row.device_id, null, p_upsert_op_id,
          0, v_payload_sha256, now()
        );
        insert into public.portmgr_ports
        select (v_row).*;
      end if;
    end loop;
  end if;

  return query
  select item ->> 'id', fence.generation
  from jsonb_array_elements(p_rows) as supplied(item)
  join public.portmgr_port_fences fence on fence.port_id = (item ->> 'id')
  where fence.state = 'active'
    and fence.operation_id = p_upsert_op_id
    and fence.operation_base_generation = (item ->> 'sync_generation')::bigint
    and fence.operation_payload_sha256 = encode(
      sha256(convert_to(jsonb_set(
        item,
        '{sync_generation}',
        to_jsonb(((item ->> 'sync_generation')::bigint)::text),
        true
      )::text, 'UTF8')),
      'hex'
    )
  order by (item ->> 'id');
end;
$$;

create or replace function public.portmgr_delete_ports_if_identity_matches(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_port_id text;
  v_active_count integer := 0;
  v_replay_count integer := 0;
  v_deleted_count integer := 0;
  v_previous_operation_setting text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_expected.id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_MISSING',
        detail = v_expected.id;
    end if;

    if v_fence.state = 'deleted'
      and v_fence.operation_id = p_deletion_op_id then
      if v_port_found
        or v_fence.generation - 1 is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_expected.device_id
        or v_fence.deleted_name is distinct from v_expected.name then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_DELETE_REPLAY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_replay_count := v_replay_count + 1;
    elsif v_fence.state = 'active' then
      if not v_port_found
        or v_port.device_id is distinct from v_expected.device_id
        or v_port.name is distinct from v_expected.name
        or v_port.sync_generation is distinct from v_expected.sync_generation
        or v_fence.generation is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_port.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_DELETE_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_active_count := v_active_count + 1;
    else
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_DELETE_IDENTITY_MISMATCH',
        detail = v_expected.id;
    end if;
  end loop;

  if v_active_count > 0 and v_replay_count > 0 then
    raise exception using errcode = '40001', message = 'PORT_FENCE_DELETE_MIXED_REPLAY';
  end if;

  if v_active_count > 0 then
    v_previous_operation_setting := current_setting(
      'portmgr.port_deletion_operation_id',
      true
    );
    perform set_config(
      'portmgr.port_deletion_operation_id',
      p_deletion_op_id::text,
      true
    );
    delete from public.portmgr_ports port
    using jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    where port.id = expected.id;
    get diagnostics v_deleted_count = row_count;
    perform set_config(
      'portmgr.port_deletion_operation_id',
      coalesce(v_previous_operation_setting, ''),
      true
    );
    if v_deleted_count <> jsonb_array_length(p_expected_rows) then
      raise exception using errcode = '40001', message = 'PORT_FENCE_DELETE_COUNT_MISMATCH';
    end if;
  end if;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.operation_id = p_deletion_op_id
    and fence.generation - 1 = expected.sync_generation
  order by expected.id;
end;
$$;

create or replace function public.portmgr_tombstone_absent_ports(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_id text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform 1 from public.portmgr_ports port where port.id = v_expected.id;
    if found then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_ABSENT_ROW_PRESENT',
        detail = v_expected.id;
    end if;
    if v_expected.sync_generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_expected.id;
    end if;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    if found then
      if v_fence.state <> 'deleted'
        or v_fence.generation - 1 is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_expected.device_id
        or v_fence.deleted_name is distinct from v_expected.name then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_ABSENT_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
    end if;
  end loop;

  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    insert into public.portmgr_port_fences(
      port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
    ) values (
      v_expected.id, v_expected.sync_generation + 1, 'deleted',
      v_expected.device_id, v_expected.name, p_deletion_op_id, now()
    )
    on conflict (port_id) do nothing;
  end loop;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.generation - 1 = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name
  order by expected.id;
end;
$$;

create or replace function public.portmgr_delete_or_tombstone_ports_if_identity_matches(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_fence_found boolean;
  v_port_id text;
  v_present_count integer := 0;
  v_deleted_count integer := 0;
  v_result_count integer := 0;
  v_previous_operation_setting text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  -- One deterministic lock order covers both physical rows and absent IDs.
  -- No validation below may mutate either table.
  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  -- Prevalidate the complete mixed batch before deleting or synthesizing any
  -- tombstone. A committed exact tombstone is accepted with a new UUID so a
  -- caller can reconcile a lost response without knowing the original UUID.
  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    if v_expected.sync_generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_expected.id;
    end if;

    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_expected.id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    v_fence_found := found;

    if v_port_found then
      if not v_fence_found
        or v_fence.state <> 'active'
        or v_port.device_id is distinct from v_expected.device_id
        or v_port.name is distinct from v_expected.name
        or v_port.sync_generation is distinct from v_expected.sync_generation
        or v_fence.generation is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_port.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_MIXED_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_present_count := v_present_count + 1;
    elsif not v_fence_found then
      -- Exact missing identities are synthesized after every row validates.
      null;
    elsif v_fence.state = 'active' then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_ACTIVE_WITHOUT_PORT',
        detail = v_expected.id;
    elsif v_fence.state <> 'deleted'
      or v_fence.generation is distinct from v_expected.sync_generation + 1
      or coalesce(
        v_fence.operation_base_generation,
        v_fence.generation - 1
      ) is distinct from v_expected.sync_generation
      or v_fence.owner_device_id is distinct from v_expected.device_id
      or v_fence.deleted_name is distinct from v_expected.name then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_MIXED_IDENTITY_MISMATCH',
        detail = v_expected.id;
    end if;
  end loop;

  if v_present_count > 0 then
    v_previous_operation_setting := current_setting(
      'portmgr.port_deletion_operation_id',
      true
    );
    perform set_config(
      'portmgr.port_deletion_operation_id',
      p_deletion_op_id::text,
      true
    );
    delete from public.portmgr_ports port
    using jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    where port.id = expected.id
      and port.device_id is not distinct from expected.device_id
      and port.name is not distinct from expected.name
      and port.sync_generation = expected.sync_generation;
    get diagnostics v_deleted_count = row_count;
    perform set_config(
      'portmgr.port_deletion_operation_id',
      coalesce(v_previous_operation_setting, ''),
      true
    );
    if v_deleted_count <> v_present_count then
      raise exception using errcode = '40001', message = 'PORT_FENCE_MIXED_DELETE_COUNT_MISMATCH';
    end if;
  end if;

  -- After the physical deletes every supplied port is absent. Only IDs that
  -- had no fence before validation can still satisfy this insert predicate.
  insert into public.portmgr_port_fences(
    port_id, generation, state, owner_device_id, deleted_name, operation_id,
    operation_base_generation, operation_payload_sha256, changed_at
  )
  select expected.id, expected.sync_generation + 1, 'deleted',
         expected.device_id, expected.name, p_deletion_op_id,
         expected.sync_generation, null, now()
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  where not exists (
    select 1 from public.portmgr_port_fences fence
    where fence.port_id = expected.id
  );

  select count(*) into v_result_count
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where not exists (
      select 1 from public.portmgr_ports port where port.id = expected.id
    )
    and fence.state = 'deleted'
    and fence.generation = expected.sync_generation + 1
    and coalesce(
      fence.operation_base_generation,
      fence.generation - 1
    ) = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name;
  if v_result_count <> jsonb_array_length(p_expected_rows) then
    raise exception using errcode = '40001', message = 'PORT_FENCE_MIXED_RESULT_COUNT_MISMATCH';
  end if;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.generation = expected.sync_generation + 1
    and coalesce(
      fence.operation_base_generation,
      fence.generation - 1
    ) = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name
  order by expected.id;
end;
$$;

create or replace function public.portmgr_restore_port_if_generation_matches(
  p_row jsonb,
  p_deleted_generation bigint,
  p_restore_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.portmgr_ports%rowtype;
  v_existing public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_existing_found boolean;
  v_new_generation bigint;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_restore_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_row is null
    or jsonb_typeof(p_row) <> 'object'
    or not (p_row ? 'id')
    or not (p_row ? 'device_id')
    or not (p_row ? 'name')
    or not (p_row ? 'sync_generation')
    or jsonb_typeof(p_row -> 'id') <> 'string'
    or jsonb_typeof(p_row -> 'device_id') not in ('string', 'null')
    or jsonb_typeof(p_row -> 'name') <> 'string'
    or jsonb_typeof(p_row -> 'sync_generation') not in ('string', 'number')
    or coalesce(p_row ->> 'id', '') = ''
    or coalesce(p_row ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
    or exists (
      select 1
      from jsonb_object_keys(p_row) as supplied(field_name)
      where supplied.field_name not in (
        'id', 'sync_generation', 'device_id', 'device_name', 'name', 'port',
        'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
        'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
        'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
        'created_at'
      )
    ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_RESTORE_ROW_INVALID';
  end if;
  if p_deleted_generation is null
    or p_deleted_generation < 1
    or p_deleted_generation = 9223372036854775807 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_DELETED_GENERATION_INVALID';
  end if;

  select * into v_row
  from jsonb_populate_record(null::public.portmgr_ports, p_row);
  if v_row.sync_generation is distinct from p_deleted_generation - 1 then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_SOURCE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || v_row.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = v_row.id
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'PORT_FENCE_MISSING',
      detail = v_row.id;
  end if;

  select port.* into v_existing
  from public.portmgr_ports port
  where port.id = v_row.id
  for update;
  v_existing_found := found;

  if v_fence.state = 'active'
    and v_fence.operation_id = p_restore_op_id
    and v_fence.generation = p_deleted_generation + 1 then
    if not v_existing_found
      or v_existing.sync_generation is distinct from v_fence.generation
      or v_fence.owner_device_id is distinct from v_row.device_id
      or (to_jsonb(v_existing) - 'sync_generation')
        is distinct from (to_jsonb(v_row) - 'sync_generation') then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_RESTORE_REPLAY_MISMATCH',
        detail = v_row.id;
    end if;
    return query select v_row.id, v_fence.generation;
    return;
  end if;

  if v_fence.state <> 'deleted'
    or v_fence.generation is distinct from p_deleted_generation
    or v_fence.owner_device_id is distinct from v_row.device_id
    or v_fence.deleted_name is distinct from v_row.name
    or v_existing_found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  update public.portmgr_port_fences fence
  set generation = fence.generation + 1,
      state = 'active',
      owner_device_id = v_row.device_id,
      deleted_name = null,
      operation_id = p_restore_op_id,
      operation_base_generation = p_deleted_generation,
      operation_payload_sha256 = null,
      changed_at = now()
  where fence.port_id = v_row.id
    and fence.state = 'deleted'
    and fence.generation = p_deleted_generation
  returning fence.generation into v_new_generation;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  v_row.sync_generation := v_new_generation;
  insert into public.portmgr_ports
  select (v_row).*;

  return query select v_row.id, v_new_generation;
end;
$$;

create or replace function public.portmgr_restore_ports_snapshot_if_preflight_matches(
  p_device_id text,
  p_restore_rows jsonb,
  p_exact_extra_rows jsonb,
  p_upsert_op_id uuid,
  p_delete_op_id uuid
)
returns table(id text, generation bigint, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_row jsonb;
  v_candidate jsonb;
  v_expected_generation bigint;
  v_payload_sha256 text;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_fence_found boolean;
  v_regular_match boolean;
  v_replay_match boolean;
  v_port_id text;
  v_upsert_rows jsonb := '[]'::jsonb;
  v_skipped_rows jsonb := '[]'::jsonb;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_upsert_op_id is null or p_delete_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_upsert_op_id = p_delete_op_id then
    raise exception using
      errcode = '22023',
      message = 'PORT_FENCE_SNAPSHOT_OPERATION_IDS_NOT_DISTINCT';
  end if;
  if p_restore_rows is null or jsonb_typeof(p_restore_rows) <> 'array'
    or p_exact_extra_rows is null or jsonb_typeof(p_exact_extra_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_ROWS_INVALID';
  end if;

  -- Desired snapshot bytes are separate from read-only preflight authority.
  -- A null expected_generation means that exact ID was absent at preflight.
  for v_item in select value from jsonb_array_elements(p_restore_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'row')
      or not (v_item ? 'expected_generation')
      or jsonb_typeof(v_item -> 'row') <> 'object'
      or jsonb_typeof(v_item -> 'expected_generation') not in ('string', 'null')
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('row', 'expected_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_RESTORE_ROW_INVALID';
    end if;
    v_row := v_item -> 'row';
    if not (v_row ? 'id')
      or not (v_row ? 'device_id')
      or not (v_row ? 'name')
      or jsonb_typeof(v_row -> 'id') <> 'string'
      or jsonb_typeof(v_row -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_row -> 'name') <> 'string'
      or coalesce(v_row ->> 'id', '') = ''
      or (v_row ->> 'device_id') is distinct from p_device_id
      or (jsonb_typeof(v_item -> 'expected_generation') = 'string'
        and coalesce(v_item ->> 'expected_generation', '') !~ '^(0|[1-9][0-9]*)$')
      or exists (
        select 1
        from jsonb_object_keys(v_row) as supplied(field_name)
        where supplied.field_name not in (
          'id', 'device_id', 'device_name', 'name', 'port',
          'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
          'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
          'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
          'created_at'
        )
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_RESTORE_ROW_INVALID';
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_exact_extra_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or (v_item ->> 'device_id') is distinct from p_device_id
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_EXTRA_ROW_INVALID';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select item -> 'row' ->> 'id' as port_id
      from jsonb_array_elements(p_restore_rows) as supplied(item)
      union all
      select item ->> 'id' as port_id
      from jsonb_array_elements(p_exact_extra_rows) as supplied(item)
    ) supplied_ids
    group by supplied_ids.port_id
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_ROW_DUPLICATE';
  end if;

  -- Only the exact preflight scope is locked. A newly created unrelated row is
  -- intentionally preserved rather than inferred as a snapshot extra.
  for v_port_id in
    select supplied_ids.port_id
    from (
      select item -> 'row' ->> 'id' as port_id
      from jsonb_array_elements(p_restore_rows) as supplied(item)
      union
      select item ->> 'id' as port_id
      from jsonb_array_elements(p_exact_extra_rows) as supplied(item)
    ) supplied_ids
    order by supplied_ids.port_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_item in
    select item
    from jsonb_array_elements(p_restore_rows) as supplied(item)
    order by item -> 'row' ->> 'id'
  loop
    v_row := v_item -> 'row';
    v_port_id := v_row ->> 'id';
    v_expected_generation := case
      when jsonb_typeof(v_item -> 'expected_generation') = 'null' then null
      else (v_item ->> 'expected_generation')::bigint
    end;
    v_candidate := v_row || jsonb_build_object(
      'sync_generation', coalesce(v_expected_generation, 0)::text
    );
    v_payload_sha256 := encode(
      sha256(convert_to(v_candidate::text, 'UTF8')),
      'hex'
    );

    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_port_id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_port_id
    for update;
    v_fence_found := found;

    if v_fence_found and v_fence.state = 'deleted' then
      if v_port_found or v_fence.owner_device_id is distinct from p_device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_DELETED_IDENTITY_MISMATCH',
          detail = v_port_id;
      end if;
      v_skipped_rows := v_skipped_rows || jsonb_build_array(jsonb_build_object(
        'id', v_port_id,
        'generation', v_fence.generation::text
      ));
      continue;
    end if;

    v_replay_match := v_port_found
      and v_fence_found
      and v_fence.state = 'active'
      and v_fence.operation_id = p_upsert_op_id
      and v_fence.operation_base_generation is not distinct from coalesce(v_expected_generation, 0)
      and v_fence.operation_payload_sha256 is not distinct from v_payload_sha256
      and v_port.sync_generation is not distinct from v_fence.generation
      and v_port.device_id is not distinct from p_device_id
      and v_fence.owner_device_id is not distinct from p_device_id;

    if v_expected_generation is null then
      -- Zero alone is ambiguous: a different concurrent create can also be at
      -- generation zero. Only this exact child UUID + digest proves our replay.
      if not ((not v_port_found and not v_fence_found) or v_replay_match) then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_CONCURRENT_APPEARANCE',
          detail = v_port_id;
      end if;
    else
      v_regular_match := v_port_found
        and v_fence_found
        and v_fence.state = 'active'
        and v_port.sync_generation is not distinct from v_expected_generation
        and v_fence.generation is not distinct from v_expected_generation
        and v_port.device_id is not distinct from p_device_id
        and v_fence.owner_device_id is not distinct from p_device_id;
      if not (v_regular_match or v_replay_match) then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_GENERATION_MISMATCH',
          detail = v_port_id;
      end if;
    end if;

    v_upsert_rows := v_upsert_rows || jsonb_build_array(v_candidate);
  end loop;

  if jsonb_array_length(v_upsert_rows) > 0 then
    return query
    select restored.id, restored.generation, 'restored'::text
    from public.portmgr_upsert_ports_if_generation_matches(
      v_upsert_rows,
      p_upsert_op_id
    ) restored;
  end if;

  if jsonb_array_length(p_exact_extra_rows) > 0 then
    return query
    select removed.id, removed.generation, 'deleted_extra'::text
    from public.portmgr_delete_or_tombstone_ports_if_identity_matches(
      p_exact_extra_rows,
      p_delete_op_id
    ) removed;
  end if;

  return query
  select skipped.id, skipped.generation, 'skipped_deleted'::text
  from jsonb_to_recordset(v_skipped_rows) as skipped(id text, generation bigint)
  order by skipped.id;
end;
$$;

alter table public.portmgr_port_fences enable row level security;
drop policy if exists anon_all on public.portmgr_port_fences;
drop policy if exists "Enable read access for all users" on public.portmgr_port_fences;
drop policy if exists portmgr_authenticated_all on public.portmgr_port_fences;
drop policy if exists portmgr_authenticated_read on public.portmgr_port_fences;
create policy portmgr_authenticated_read on public.portmgr_port_fences
  for select to authenticated
  using ((select public.portmgr_is_member()));

revoke all privileges on table public.portmgr_port_fences
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_port_fences to authenticated, service_role;
revoke all privileges on table public.portmgr_ports
  from authenticated, service_role;
grant select on table public.portmgr_ports to authenticated, service_role;

revoke all on function public.portmgr_enforce_port_fence_write()
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_tombstone_port_fence_on_delete()
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_upsert_ports_if_generation_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_delete_ports_if_identity_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_delete_or_tombstone_ports_if_identity_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_tombstone_absent_ports(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_restore_port_if_generation_matches(jsonb, bigint, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_restore_ports_snapshot_if_preflight_matches(text, jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_upsert_ports_if_generation_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_delete_ports_if_identity_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_delete_or_tombstone_ports_if_identity_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_tombstone_absent_ports(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_restore_port_if_generation_matches(jsonb, bigint, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_restore_ports_snapshot_if_preflight_matches(text, jsonb, jsonb, uuid, uuid)
  to authenticated, service_role;
