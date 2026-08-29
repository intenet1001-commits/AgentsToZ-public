const DEFAULT_PUBLIC_REPOSITORY_URL = 'https://github.com/intenet1001-commits/AgentsToZ-public';

/**
 * Vercel의 Git import에는 공개 GitHub 저장소 주소만 전달한다.
 * 사용자 정보, query string, fragment, credential이 섞인 URL은 기본 공개 저장소로 되돌린다.
 */
export function publicGitHubRepositoryUrl(
  candidate: string | undefined,
  fallback = DEFAULT_PUBLIC_REPOSITORY_URL,
): string {
  const normalize = (value: string): string | null => {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) return null;
      const [owner, rawRepository] = parts;
      const repository = rawRepository?.replace(/\.git$/, '');
      const safePart = /^[A-Za-z0-9_.-]+$/;
      if (!owner || !repository || !safePart.test(owner) || !safePart.test(repository)) return null;
      return `https://github.com/${owner}/${repository}`;
    } catch {
      return null;
    }
  };

  return normalize(candidate ?? '') ?? normalize(fallback) ?? DEFAULT_PUBLIC_REPOSITORY_URL;
}

/**
 * 이 URL은 코드 저장소 위치만 전달한다. Supabase/Vercel/Google 값은 URL parameter로
 * 운반하지 않고 사용자가 로그인한 Vercel 프로젝트의 Environment Variables에 입력한다.
 */
export function buildVercelImportUrl(repositoryUrl: string): string {
  const target = new URL('https://vercel.com/new/clone');
  target.searchParams.set('repository-url', publicGitHubRepositoryUrl(repositoryUrl));
  return target.toString();
}

export function buildSelfHostingAgentPrompt(repositoryUrl: string): string {
  const sourceRepository = publicGitHubRepositoryUrl(repositoryUrl);
  return `AgentsToZ 공개판을 원작자의 배포 환경과 완전히 분리해 내 계정으로 배포하도록 도와줘.

소스 저장소: ${sourceRepository}

안전 규칙:
1. 먼저 이 저장소의 onboarding 지침을 읽고 현재 PC의 운영체제와 설치 상태를 읽기 전용으로 확인해.
2. 원작자의 Vercel 주소·Supabase 프로젝트는 사용하거나 변경하지 마. 내가 로그인한 Vercel 계정과 내가 소유한 Supabase 프로젝트인지 화면과 CLI 상태로 각각 확인해.
3. 계정 로그인, 2단계 인증, CAPTCHA, Google OAuth Client Secret 입력은 내가 직접 하게 멈춰. 비밀번호·쿠키·access token·Client Secret·service_role 키를 요구하거나 채팅, 명령 인자, URL, Git, 스크린샷에 남기지 마.
4. Vercel 가져오기 URL에는 위 공개 GitHub 저장소 주소만 넣어. Supabase URL·anon/publishable key·이메일도 query parameter로 전달하지 말고 Vercel Project Settings의 Production Environment Variables에 직접 저장해.
5. Vercel에는 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ALLOWED_EMAIL만 설정해. service_role은 데스크톱 앱의 로컬 sidecar 전용이므로 Vercel에 절대 넣지 마.
6. Supabase SQL은 src/schemaSql.ts의 정본으로 적용하고 RLS를 끄지 마. public.portmgr_allowed_members에 내 Google 이메일을 등록하고 authenticated 세션만 데이터에 접근하는지 확인해. VITE_ALLOWED_EMAIL은 UI 사전 필터이고 서버 권한 정본이 아님을 구분해.
7. Google OAuth Client ID/Secret은 Supabase Authentication > Providers > Google에만 저장해. Supabase가 보여주는 callback URL을 Google에 등록하고, 내 Vercel production URL을 Supabase URL Configuration의 Redirect URLs에 추가해.
8. 프로젝트 생성, 환경 변수 변경, production 배포 직전에는 대상 계정·프로젝트와 바뀌는 내용을 한 문장으로 보여주고 내 확인을 받아.
9. 배포 뒤 내 Vercel URL에서 Google 로그인, portmgr_is_member() 허용, 실제 데이터 읽기를 확인해. 401/403이 나도 RLS를 끄지 말고 OAuth 세션과 allowed member를 고쳐.
10. 추가 Mac·Windows는 기존 device ID를 복사하지 않고 새 UUID를 만든다. 연결 정보에는 Project URL·anon/publishable key·추천 이름만 포함하고 service_role·로그인 토큰은 넣지 마.

각 단계는 한 번에 하나씩 진행하고, 성공 근거를 확인한 뒤 다음 단계로 넘어가줘.`;
}
