-- Security remediation: CLI login tokens must remain local to each device.
-- Preserve device and portal configuration while removing previously stored tokens.

DO $$
BEGIN
  -- 일부 신규 설치는 취약한 레거시 테이블을 만든 적이 없다. 그 경우에도
  -- 전체 마이그레이션이 중단되지 않도록 존재할 때만 폐기 조치를 적용한다.
  IF to_regclass('public.portmgr_device_credentials') IS NOT NULL THEN
    ALTER TABLE public.portmgr_device_credentials ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "anon_all" ON public.portmgr_device_credentials;

    REVOKE ALL PRIVILEGES ON TABLE public.portmgr_device_credentials FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE public.portmgr_device_credentials FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE public.portmgr_device_credentials FROM authenticated;

    UPDATE public.portmgr_device_credentials
    SET github_token_enc = NULL,
        vercel_token_enc = NULL,
        supabase_access_token_enc = NULL
    WHERE github_token_enc IS NOT NULL
       OR vercel_token_enc IS NOT NULL
       OR supabase_access_token_enc IS NOT NULL;
  END IF;
END
$$;
