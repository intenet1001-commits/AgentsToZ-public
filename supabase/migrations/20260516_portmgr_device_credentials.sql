-- portmgr_device_credentials: 기기별 CLI 자격증명 (서버사이드 AES-GCM 암호화 저장)
CREATE TABLE IF NOT EXISTS portmgr_device_credentials (
  id                       text PRIMARY KEY,  -- portmgr_devices.id와 동일 device UUID
  supabase_url             text,
  supabase_anon_key        text,
  github_token_enc         text,              -- AES-256-GCM 암호화된 GitHub token
  vercel_token_enc         text,              -- AES-256-GCM 암호화된 Vercel token
  supabase_access_token_enc text,             -- AES-256-GCM 암호화된 Supabase CLI token
  portal_url               text,              -- 배포 포털 URL
  setup_completed_at       timestamptz,
  created_at               timestamptz DEFAULT now()
);

ALTER TABLE portmgr_device_credentials ENABLE ROW LEVEL SECURITY;

-- anon key로 읽기/쓰기 허용 (RLS anon 정책)
CREATE POLICY "anon_all" ON portmgr_device_credentials
  FOR ALL TO anon USING (true) WITH CHECK (true);
