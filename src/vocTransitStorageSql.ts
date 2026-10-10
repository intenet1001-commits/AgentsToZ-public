/**
 * Canonical SQL for the photo-VOC transit bucket (portmgr-voc-transit).
 *
 * Identical to supabase/migrations/20260927010000_voc_transit_storage.sql
 * (tests/voc-transit-storage-sql.test.ts keeps them equal). It is part of the
 * setup SQL so a freshly self-hosted Supabase can receive phone photo VOCs;
 * without it the phone reports 「사진 전송용 저장소가 아직 준비되지 않았습니다」.
 */
export const VOC_TRANSIT_STORAGE_SQL = `-- VOC 사진 전송용 비공개 Storage 버킷 (짧게 머무는 경유지).
--
-- 휴대폰은 사진마다 새 AES-256-GCM 키로 암호화한 **암호문만** 이 버킷에 올린다. 키는 E2E 릴레이
-- 봉투 안에만 있으므로 버킷이 읽혀도 사진은 보이지 않는다. Mac은 받은 즉시 객체를 지우고
-- (service_role이 있는 Mac), 아니면 휴대폰이 Mac의 수신 확인을 받은 즉시 자기 객체를 지운다.
-- 전달되지 못한 객체는 Mac의 정리 작업이 24시간 뒤 지운다(Storage API 사용 — storage 테이블을
-- SQL로 직접 지우지 않는다).
--
-- 경로: <relay hostId>/<업로더 auth.uid()>/<objectId>.bin
-- 접근: 허용된 멤버(portmgr_is_member)만. 올리기·읽기·지우기는 자기 uid 폴더 안에서만.
-- Mac은 서명 URL(휴대폰이 발급, 짧은 만료)로 내려받으므로 Mac에 별도 읽기 권한이 필요 없다.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portmgr-voc-transit', 'portmgr-voc-transit', false, 10485760, array['application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists portmgr_voc_transit_insert on storage.objects;
create policy portmgr_voc_transit_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'portmgr-voc-transit'
    and (select public.portmgr_is_member())
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] ~ '^[A-Za-z0-9_-]{8,64}$'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and name ~ '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bin$'
  );

drop policy if exists portmgr_voc_transit_select on storage.objects;
create policy portmgr_voc_transit_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'portmgr-voc-transit'
    and (select public.portmgr_is_member())
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists portmgr_voc_transit_delete on storage.objects;
create policy portmgr_voc_transit_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'portmgr-voc-transit'
    and (select public.portmgr_is_member())
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- 덮어쓰기(update)는 허용하지 않는다: 객체마다 새 경로·새 키를 쓴다.
`;
