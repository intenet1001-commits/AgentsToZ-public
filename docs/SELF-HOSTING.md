# 내 계정으로 AgentsToZ 개인 포털 만들기

이 설명은 공개판 사용자가 **자기 Supabase와 자기 Vercel**로 독립된 웹 포털을 만드는 순서입니다.
원작자의 개인 포털이나 데이터베이스에는 연결하지 않습니다.

로컬 앱만 쓸 때는 이 작업이 필요 없습니다. 웹 포털을 휴대폰이나 다른 브라우저에서도 열고
싶을 때만 진행하세요. 아래 1번부터 한 단계씩 완료하고, 각 단계의 **성공 근거**를 확인한 뒤
다음으로 넘어가면 됩니다.

## 먼저 알아둘 것

| 값 | 저장 위치 | 공개 저장소·채팅에 넣기 |
|---|---|---|
| Supabase Project URL | Vercel Production 환경 변수 | Git에는 넣지 않음 |
| Supabase anon/publishable key | Vercel Production 환경 변수 | 프런트 연결용 공개 키지만 Git에는 넣지 않음 |
| 허용 Google 이메일 | Vercel `VITE_ALLOWED_EMAIL` + Supabase `portmgr_allowed_members` | 개인 정보이므로 Git에는 넣지 않음 |
| Google Client ID/Secret | Supabase Authentication의 Google Provider | **절대 금지** |
| Supabase `service_role` | 설치된 데스크톱 앱의 로컬 sidecar | **Vercel·Git·채팅·URL에 절대 금지** |

`VITE_ALLOWED_EMAIL`은 로그인 화면의 사전 확인입니다. 실제 데이터 권한의 정본은
Supabase의 `portmgr_allowed_members`와 RLS입니다. 오류가 나도 RLS를 끄면 안 됩니다.

## 1. Supabase 프로젝트 준비

1. [Supabase Dashboard](https://supabase.com/dashboard/projects)에 본인 계정으로 로그인합니다.
2. 이미 본인이 소유한 프로젝트가 있으면 그 프로젝트를 선택합니다. 없을 때만 **New project**로
   하나 만듭니다.
3. **Project Settings → API**에서 다음 두 값의 위치를 확인합니다. 지금은 공개 문서나 채팅에
   붙여넣지 말고, 뒤의 Vercel 환경 변수 화면에서만 사용합니다.

   - Project URL
   - anon 또는 publishable key (`service_role`이 아님)

**성공 근거:** Supabase Dashboard 상단에 본인 프로젝트 이름이 보이고, Project URL과
anon/publishable key의 위치를 찾았습니다.

## 2. 정본 SQL 실행과 owner 이메일 등록

AgentsToZ의 테이블, `portmgr_allowed_members`, authenticated 전용 RLS는 저장소의
`src/schemaSql.ts`가 만드는 SQL 하나가 정본입니다. 문서에 오래된 SQL 사본을 따로 두지 않습니다.

### 가장 쉬운 복사 방법: 설치된 앱

1. AgentsToZ 앱에서 **초기 설정 → 첫 단말 · 동기화 설정 → 동기화 DB 준비**를 엽니다.
2. **Google 로그인 허용 이메일**에 본인 이메일을 입력합니다.
3. `테이블 … + authenticated 전용 RLS (정본)` 코드 영역의 **복사** 버튼을 누릅니다.
4. Supabase Dashboard의 **SQL Editor → New query**에 붙여넣고 **Run**을 누릅니다.

### 소스 저장소에서 출력하는 방법

아래 명령은 저장소 최상위 폴더에서 실행합니다. `owner@example.com`을 실제 로그인할 본인
이메일로 바꾸세요. 출력된 SQL 전체만 복사해 Supabase **SQL Editor → New query**에서 실행합니다.

macOS/Linux:

```bash
ALLOWED_EMAIL=owner@example.com bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```

Windows PowerShell:

```powershell
$env:ALLOWED_EMAIL = 'owner@example.com'
bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```

실행 뒤 Supabase SQL Editor에서 아래 확인 SQL도 실행합니다. 두 결과가 모두 **0행**이어야 합니다.

```sql
select tablename
from pg_tables
where schemaname = 'public'
  and tablename like 'portmgr_%'
  and rowsecurity = false;

select table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name like 'portmgr_%'
  and grantee in ('anon', 'PUBLIC');
```

**성공 근거:** SQL Editor가 오류 없이 완료되고, Table Editor의
`public.portmgr_allowed_members`에 본인 이메일이 소문자로 1행 보입니다. 위 두 확인 쿼리는
0행입니다. 설치된 앱에서는 다음 단계의 **연결과 보안 테스트**가
`URL/Key 정상 · 익명 접근 차단 정상`으로 표시됩니다.

## 3. Google OAuth 연결

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)에서 본인 프로젝트를
   선택하거나 새 프로젝트를 만듭니다.
2. OAuth 동의 화면이 아직 없으면 구성합니다. 앱이 테스트 상태라면 로그인할 본인 Google
   계정을 테스트 사용자로 추가합니다.
3. **사용자 인증 정보 만들기 → OAuth 클라이언트 ID**를 누르고 애플리케이션 유형을
   **웹 애플리케이션**으로 선택합니다.
4. Supabase Dashboard의 **Authentication → Providers → Google** 화면에 표시된 callback URL을
   Google의 **승인된 리디렉션 URI**에 정확히 등록합니다. 형식은 다음과 같습니다.

   ```text
   https://<내-project-ref>.supabase.co/auth/v1/callback
   ```

5. Google이 발급한 Client ID와 Client Secret을
   **Supabase Authentication → Providers → Google**에만 입력하고 Google Provider를 켠 뒤 저장합니다.

Client Secret을 Vercel 환경 변수, Git, AI 채팅, 스크린샷에 넣지 마세요. Vercel 주소는 아직
만들기 전이므로 Supabase Redirect URLs 등록은 5번 단계에서 합니다.

**성공 근거:** Supabase의 Google Provider가 Enabled로 보이고, 그 화면의 callback URL과
Google의 승인된 리디렉션 URI가 글자 하나까지 같습니다.

## 4. 공개 GitHub를 내 Vercel로 가져오고 배포

설치된 앱에서 첫 단말 연결을 끝냈다면 자동 배포가 가장 쉽습니다. 앱이 없거나 자동 배포를
쓸 수 없으면 바로 아래 수동 방법을 사용하세요.

### 방법 A: 설치된 앱에서 자동 배포 (권장)

1. AgentsToZ 앱에서 **초기 설정 → 포털 배포 · Google 로그인**을 엽니다.
2. 본인의 Vercel 계정으로 `vercel login`을 완료합니다.
3. 앱에서 **Vercel 로그인 확인**을 눌러 표시된 계정이 본인 계정인지 확인합니다.
4. 2번 단계에서 등록한 것과 같은 Google 이메일을 입력합니다.
5. 대상 계정과 기존 프로젝트 연결 사용 여부 확인란을 체크합니다.
6. **환경 변수 저장 + 자동 배포 시작**을 누릅니다.

앱은 이미 로컬에 저장된 Supabase의 공개 연결값을 Vercel CLI의 표준 입력으로 전달합니다.
값을 명령 인자나 배포 URL에 붙이지 않으며 `service_role`은 전달하지 않습니다.

### 방법 B: Deploy with Vercel로 수동 배포

[내 계정에서 Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fintenet1001-commits%2FAgentsToZ-public)

이 버튼에는 공개 GitHub 저장소 주소만 들어 있습니다. Supabase 값, 이메일, 토큰은 URL로
전달하지 않습니다.

1. Vercel에 로그인합니다.
2. 화면에 표시된 계정/팀이 본인 소유인지 확인하고, 새 프로젝트 이름을 정한 뒤 Import합니다.
3. 프로젝트 **Settings → Environment Variables**에서 **Production**에 아래 세 항목을 추가합니다.

   - `VITE_SUPABASE_URL`: 1번에서 확인한 본인 Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY`: 1번에서 확인한 본인 anon 또는 publishable key
   - `VITE_ALLOWED_EMAIL`: 2번 SQL에 등록한 것과 같은 Google 이메일

4. `service_role`, Google Client Secret, GitHub/Vercel 로그인 토큰은 추가하지 않습니다.
5. Vercel의 **Deployments**에서 최신 배포를 **Redeploy**하여 Production에 반영합니다.
6. 완료된 본인 `https://<내-프로젝트>.vercel.app` 주소를 복사합니다.

자기 GitHub fork를 배포했다면 선택적으로 `VITE_REPO_URL`에 그 fork의 공개 URL을 넣을 수
있습니다. 이 값도 GitHub 저장소 주소일 뿐이며 credential이나 token이 포함되면 안 됩니다.

**성공 근거:** Vercel Deployment가 **Ready / Production**으로 표시되고, 주소를 열었을 때
AgentsToZ Google 로그인 화면이 보입니다. Vercel의 계정/팀과 프로젝트가 모두 본인 소유입니다.

## 5. Supabase Redirect URL 등록과 실제 로그인

1. Supabase Dashboard에서 **Authentication → URL Configuration → Redirect URLs**를 엽니다.
2. 4번에서 받은 본인 Vercel Production 주소를 끝의 `/`까지 포함해 추가하고 저장합니다.

   ```text
   https://<내-프로젝트>.vercel.app/
   ```

3. 그 Vercel 주소를 새 창에서 열고 **Google로 로그인**을 누릅니다.
4. 2번 SQL에 등록한 Google 이메일로 로그인합니다.
5. Google 로그인 뒤 같은 Vercel 주소로 돌아오고 포털 데이터가 열리는지 확인합니다.

**성공 근거:** 허용한 이메일은 Google 로그인 뒤 프로젝트·기기 화면을 읽을 수 있습니다.
허용 목록에 없는 계정은 데이터를 읽지 못합니다. 브라우저 개발자 도구나 Git 파일에는
`service_role`, OAuth Client Secret, CLI token이 없습니다.

## 마지막 확인

- 본인의 Vercel URL에서 Google 로그인이 완료된다.
- 허용된 이메일은 포털 데이터를 읽고, 허용되지 않은 계정은 읽지 못한다.
- 브라우저 개발자 도구나 Git 파일에 `service_role`, OAuth secret, CLI token이 없다.
- 두 번째 Mac·Windows는 첫 PC의 device ID를 복사하지 않고 새 UUID를 만든다.
- 추가 PC 연결 정보에는 Project URL, anon/publishable key, 추천 이름만 들어 있다.

`401`, `403`, `PGRST301`이 나오면 RLS를 끄지 말고 Google 로그인 세션,
`portmgr_allowed_members`, Redirect URLs를 차례로 확인하세요.
