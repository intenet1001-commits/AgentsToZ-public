# Supabase 보안 설정

anon key 노출 대응, RLS 활성화, 키 로테이션 절차를 다룬다.

---

## 왜 필요한가

- **anon key는 클라이언트에 박히는 키다. 숨길 수 없다. 이건 정상이다.**
  브라우저 번들, Tauri 앱 바이너리, `portal.json` 어디에 넣든 사용자가 꺼낼 수 있다.
  Supabase 설계상 anon key는 "공개되는 것을 전제로 한" 식별자다.
- **유일한 방어선은 RLS(Row Level Security)다.**
  RLS가 꺼져 있으면 anon key를 가진 누구나 `portmgr_*` 테이블 전체를 읽고, 쓰고, 지울 수 있다.
  포트 목록, 폴더 경로, 메모, 프로젝트 장기기억까지 전부다.
- 이 저장소를 fork한 사람도 **반드시 자기 Supabase 프로젝트에 RLS를 켜야 한다.** (→ 5장)

> 요약: anon key 유출 자체는 사고가 아니다. **RLS 없이 anon key를 쓰는 것**이 사고다.

---

## 0. 목표 상태와 점검 순서

이 저장소는 각 사용자의 live Supabase 상태를 알 수 없으며, RLS 적용 여부를 추정하지 않는다.
정본 `MIGRATION_SQL`은 모든 `portmgr_*` 테이블의 anon 접근을 차단하고 `authenticated` 세션만
허용한다. 실제 프로젝트가 이 목표 상태인지 아래 절차로 검증한다.

browser mode와 배포 포털은 Google OAuth의 `portmgr-auth` JWT를 사용한다. Tauri 앱은
사용자 로그인을 하지 않고, 고정된 localhost sidecar가 별도 파일의 `service_role` 키를
PostgREST 요청에 주입한다. 이 키를 `portal.json`, 프런트 상태, HTTP 응답에 넣지 않는다.

```
1) 정본 MIGRATION_SQL 적용 + RLS enabled 확인
2) browser/배포 포털을 쓸 때만 Redirect URLs에 browser root 허용
3) browser Google 로그인 후 portmgr_is_member() = true 확인
4) Tauri 설정에서 service_role 키 존재와 localhost 프록시 조회 확인
5) portmgr_allowed_members에 웹 포털 허용 이메일 row 등록
6) 필요할 때 anon/service_role 키 로테이션 및 모든 기기 설정 갱신
```

`anon` 허용 정책을 추가하거나 RLS를 끄지 마라. 기존 설치를 복구할 때도 앱의 초기 설정
마법사와 API 설치 경로가 같은 정본 DDL을 사용한다.

---

## 1. 내 RLS 상태 확인하기

### 1-1. 대시보드에서 확인

Supabase Dashboard → **Table Editor** → 각 테이블 선택 → 테이블명 옆 배지 확인.
`RLS disabled` (또는 "Unrestricted") 표시가 있으면 무방비다.
Dashboard → **Authentication → Policies** 에서도 테이블별 RLS on/off 와 정책 목록을 한 번에 볼 수 있다.

### 1-2. SQL로 확인 (SQL Editor)

```sql
-- (A) RLS 켜짐 여부 — rls_enabled 가 false 인 테이블이 무방비다
select tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public' and tablename like 'portmgr\_%'
order by tablename;

-- (B) 정책 목록 — roles 에 anon 또는 public 이 들어간 정책이 있으면 위험하다
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename like 'portmgr\_%'
order by tablename, policyname;

-- (C) anon / PUBLIC 롤에 남은 테이블 권한 — 0건이어야 안전하다
select table_name, privilege_type, grantee
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name like 'portmgr\_%'
  and grantee in ('anon', 'PUBLIC')
order by table_name, grantee, privilege_type;
```

**해석**

- (A)에서 `rls_enabled = false` → 그 테이블은 anon key만 있으면 누구나 전체 접근.
- (A)가 true여도 (B)에 `roles = {anon}` 또는 `{public}` 정책이 있으면 켠 의미가 없다.
- (C)에 행이 남아 있으면, 나중에 누가 RLS를 다시 껐을 때 즉시 뚫린다.

### 1-3. 터미널에서 확인 (실제 공격자 시점)

`<PROJECT_REF>` = Supabase 프로젝트 ref (`https://<PROJECT_REF>.supabase.co`), `<ANON_KEY>` = anon key.

**macOS / Linux (bash)**

```bash
PROJECT_REF="<PROJECT_REF>"
ANON_KEY="<ANON_KEY>"

curl -s -w '\nHTTP %{http_code}\n' \
  "https://${PROJECT_REF}.supabase.co/rest/v1/portmgr_ports?select=id,name&limit=3" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}"
```

**Windows (PowerShell)**

> PowerShell에서 `curl` 은 `Invoke-WebRequest` 별칭이다. 반드시 **`curl.exe`** 로 호출한다.

```powershell
$ref = "<PROJECT_REF>"
$key = "<ANON_KEY>"

curl.exe -s -w "`nHTTP %{http_code}`n" `
  "https://$ref.supabase.co/rest/v1/portmgr_ports?select=id,name&limit=3" `
  -H "apikey: $key" `
  -H "Authorization: Bearer $key"
```

**결과 해석 — 이게 핵심이다**

| 응답 | 의미 | 판정 |
|---|---|---|
| `HTTP 200` + 실제 행 데이터(`[{"id":...}]`) | RLS 꺼짐. anon key만으로 전체 열람 가능 | **무방비** |
| `HTTP 200` + `[]` (빈 배열) | RLS는 켜졌지만 anon에게 테이블 GRANT가 남아 있음. 읽기는 0행이지만 권한 자체는 살아 있다 | 부분 방어 |
| `HTTP 401` + `permission denied for table portmgr_ports` (code `42501`) | RLS + REVOKE 둘 다 적용됨 | **정상 차단** |

읽기가 막혀도 쓰기가 뚫려 있을 수 있으므로 INSERT도 확인한다.
⚠️ **RLS가 꺼져 있으면 이 요청은 실제로 행을 삽입한다.** 성공하면 아래 DELETE로 즉시 지운다.

```bash
# 쓰기 프로브 (bash)
curl -s -w '\nHTTP %{http_code}\n' -X POST \
  "https://${PROJECT_REF}.supabase.co/rest/v1/portmgr_ports" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"id":"rls-probe","name":"rls-probe","port":1,"device_id":"rls-probe","favorite":false}'

# 삽입에 성공했다면(=무방비) 즉시 정리
curl -s -X DELETE \
  "https://${PROJECT_REF}.supabase.co/rest/v1/portmgr_ports?id=eq.rls-probe" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}"
```

차단된 상태라면 `new row violates row-level security policy` 또는 `permission denied for table` 이 돌아온다.

---

## 2. RLS 켜기

### 2-1. 정본 SQL 생성

```bash
ALLOWED_EMAIL=owner@example.com bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```

Windows PowerShell:

```powershell
$env:ALLOWED_EMAIL = 'owner@example.com'
bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```

내용 요약:

- 현재 `src/schemaSql.ts`의 `PORTMGR_TABLES` 전체를 만들고 RLS를 켠다.
- 앱 데이터 테이블당 정책 1개: `"portmgr_authenticated_all"` — `for all to authenticated using/with check (public.portmgr_is_member())`.
  **anon 정책이 하나도 없다 = anon 전면 차단.**
- `portmgr_allowed_members`는 authenticated grant/policy 없이 service_role만 관리한다.
- `portmgr_allowed_members` table과 `portmgr_is_member()`가 실제 server authorization을 소유한다.
  membership table이 비어 있으면 authenticated 사용자도 모두 차단한다.
- 방어 심층화: `revoke all privileges ... from anon, public`. 나중에 누가 RLS를 다시 꺼도 anon은 못 들어온다.
- `device_id` / `'__shared__'` 는 정책 조건에 **일절 등장하지 않는다.** 기기 격리는 앱 레벨 필터링 그대로 유지된다.
- 과거 느슨한 정책명(`anon_all`, `Enable read access for all users`) DROP 포함. **재실행 안전(idempotent).**

### 2-2. 적용 방법 A — Supabase SQL Editor (권장, 가장 확실함)

1. Supabase Dashboard → 프로젝트 선택 → 좌측 **SQL Editor** → **New query**
2. 2-1 명령의 출력 **전체**를 복사해 붙여넣는다(owner seed 포함)
3. **Run**

### 2-3. 적용 방법 B — supabase CLI

프로젝트가 이미 link 되어 있어야 한다.

**macOS / Linux (bash)**

```bash
cd /path/to/portmanagement
supabase link --project-ref <PROJECT_REF>   # 최초 1회
supabase db push
```

**Windows (PowerShell)**

```powershell
Set-Location C:\Windows\System32\portmanagement
supabase link --project-ref <PROJECT_REF>   # 최초 1회
supabase db push
```

기존 RLS 설치를 server membership 방식으로 **업그레이드만** 하려면:

```bash
supabase db query --linked --file supabase/migrations/20260815010000_enforce_server_email_allowlist.sql
```

이 파일은 full schema 생성용이 아니다. fresh setup은 2-1 personalized SQL 또는 전체 `supabase db push`를 사용한다.

### 2-4. Server membership 관리

빈 membership table은 **모두 차단**한다. 계정 추가/삭제는 SQL Editor에서 table row로 관리한다.

```sql
insert into public.portmgr_allowed_members(email)
values ('owner@example.com'), ('teammate@example.com')
on conflict (email) do nothing;

delete from public.portmgr_allowed_members
where email = 'former-member@example.com';
```

`VITE_ALLOWED_EMAIL`은 UI prefilter일 뿐 server 권한을 바꾸지 않는다. 신규 가입 차단은 추가 방어로
사용할 수 있지만 membership 등록을 대신하지 않는다.

### 2-5. 적용 후 검증

마이그레이션 파일 하단의 검증 쿼리 A~D를 그대로 실행한다.

```sql
-- A: 현재 PORTMGR_TABLES 모두 rls_enabled = true
-- B: 앱 데이터 테이블마다 portmgr_authenticated_all 정책 1개, roles = {authenticated}. anon 포함 정책 0건
-- C: anon / PUBLIC 권한 0건
-- D: 로그인 JWT로 select public.portmgr_is_member();  -- 반드시 true
```

그리고 1-3의 curl 프로브를 다시 돌린다 → `permission denied for table` 이 나와야 통과.

되돌려야 하면 마이그레이션 파일 맨 아래 `ROLLBACK` 주석 블록을 해제해서 실행한다.
⚠️ 롤백 블록의 `grant ... to anon` 을 실행하면 **원래의 취약 상태로 완전히 되돌아간다.**

---

## 3. anon key 로테이션 (키가 노출된 경우)

### 3-1. 먼저 알아야 할 것

- **레포를 private으로 바꿔도 히스토리에 있던 키는 그대로 유효하다.** 이미 클론/캐시된 사본, GitHub 이벤트 API, 검색엔진 캐시에 남는다. 노출된 키는 반드시 무효화해야 한다.
- anon key는 프로젝트 **JWT 시크릿으로 서명된 JWT**다. 따라서 "anon key만 골라서 바꾸기"는 되지 않는다.
  **서명 키(JWT secret)를 교체하면 anon key와 `service_role` key가 함께 바뀌고, 발급된 사용자 세션도 전부 무효가 된다.**
- ⚠️ **재발급하는 순간 옛 키를 쓰는 모든 기기가 즉시 끊긴다.** 맥/윈도우/Vercel 포털 전부 새 키로 갱신해야 한다.
- ⚠️ **1~2장(로그인 도입 + RLS)을 끝낸 뒤에 로테이션한다.** 로테이션만 먼저 하면 유출된 구 키는 무력화되지만, 새 키도 RLS에 막혀 앱이 안 뜬다.

### 3-2. 재발급 절차

Supabase 대시보드는 API 키 체계를 개편 중이라 프로젝트 생성 시점에 따라 메뉴가 다르다. **자기 대시보드에서 보이는 쪽을 따른다.**

**경우 1 — 레거시 JWT 기반 키(anon / service_role)를 쓰는 프로젝트**

1. Dashboard → 프로젝트 선택 → **Settings**(톱니) → **API**
2. **JWT Settings** 섹션을 찾는다 (프로젝트에 따라 **Settings → JWT Keys** 로 분리되어 있다)
3. JWT 시크릿 교체(회전) 실행 — 문구는 `Generate a new secret` / `Rotate secret` / `Rotate keys` 중 하나
4. 확인 다이얼로그를 승인한다. 잠시 후 **Settings → API** 의 `anon` `public` 키 값이 새 값으로 바뀐다
5. 새 anon key를 복사한다 (`service_role` 키를 쓰는 서버가 있다면 그것도 새 값으로 교체)

**경우 2 — 신규 API 키 체계(publishable / secret)가 보이는 프로젝트**

1. Dashboard → **Settings** → **API Keys**
2. **Legacy API keys** 탭에서 기존 anon / service_role 키를 확인하고 회전 또는 비활성화한다
3. 신규 체계로 갈아탄다면 **publishable key**(클라이언트용, anon 대체) / **secret key**(서버 전용, service_role 대체)를 발급받아 사용한다
   - 이 앱은 아직 `supabaseAnonKey` 필드명을 쓰지만, 값 자리에 publishable key를 넣어도 동작한다
4. 레거시 키를 완전히 비활성화하기 전에 **모든 기기 갱신을 먼저 끝낸다**

> 메뉴 문구가 위와 다르면 대시보드 화면을 우선한다. 핵심은 하나다 — **노출된 키가 더 이상 인증되지 않게 만들 것.**

### 3-3. 재발급 후 반드시 할 일 (전부 하지 않으면 그 기기만 죽는다)

1. **앱(맥/윈도우) 설정에 새 키 입력**
   - 포털 탭 → 설정 → `Project URL` + `Anon Key` 에 새 값 입력 → 저장
   - 또는 설정 마법사(SetupWizard) 재실행
2. **저장 파일 직접 확인** — `portal.json` 의 `supabaseAnonKey` 가 새 값인지 본다
   - macOS: `~/Library/Application Support/com.portmanager.portmanager/portal.json`
   - Windows: `%APPDATA%\com.portmanager.portmanager\portal.json`

   ```bash
   # macOS — 앞 20자만 확인 (전체 출력 금지)
   grep -o '"supabaseAnonKey"[^,]*' ~/Library/Application\ Support/com.portmanager.portmanager/portal.json | cut -c1-40
   ```

   ```powershell
   # Windows
   (Get-Content "$env:APPDATA\com.portmanager.portmanager\portal.json" -Raw |
     ConvertFrom-Json).supabaseAnonKey.Substring(0,20)
   ```
3. **Vercel 포털 환경변수 갱신** — Vercel 프로젝트 → Settings → Environment Variables
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 를 새 값으로 수정 후 **재배포**(빌드타임에 번들되므로 재배포 필수)
4. **다른 기기 전부 반복** — 다른 맥/윈도우 설치본, 로컬 API 서버가 도는 머신 모두
5. **로컬 백엔드 키 갱신** — `project-memory-server.ts` / `api-server.ts` 는 `portal.json` 의 값을 읽으므로 2번으로 커버된다. 별도로 `service_role` 키를 env에 뒀다면 그것도 교체한다
6. **검증** — 각 기기에서 Push/Pull 1회 성공, 그리고 1-3의 curl 프로브를 **옛 키**로 실행 → 인증 실패(`Invalid API key` 등)가 나와야 로테이션 성공

---

## 4. 키가 이미 공개된 경우 체크리스트

순서대로 진행한다. 위에서부터 아래로.

- [ ] **레포 private 전환 또는 히스토리 정리**
      private 전환만으로는 이미 유출된 키가 무효화되지 않는다. 로테이션은 별도로 반드시 한다.
      히스토리에서 지우려면 `git filter-repo` 또는 BFG로 재작성 후 force push (공동 작업자 전원 재클론 필요).
      노출된 키 문자열이 아직 트리에 남아 있는지 확인:
      ```bash
      # macOS — 커밋 히스토리 전체에서 anon key 형태(JWT) 탐색
      git log -p --all -S 'supabaseAnonKey' --oneline | head -40
      git rev-list --all | xargs -I{} git grep -l 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' {} 2>/dev/null | head
      ```
      ```powershell
      # Windows
      git log -p --all -S 'supabaseAnonKey' --oneline | Select-Object -First 40
      ```
- [ ] **anon key 로테이션** → 3장
- [ ] **RLS 활성화** → 2장 (검증 쿼리 A~D 통과 확인)
- [ ] **Tauri 앱은 로그인 없이 sidecar Push/Pull, 웹 포털은 로그인 세션으로 Push/Pull 확인** → 0장
- [ ] **신규 가입 차단 또는 이메일 화이트리스트** → 2장 2-4
- [ ] **정본 `MIGRATION_SQL`의 RLS 정책 적용 확인** → SQL Editor에서 각 `portmgr_` 테이블이 RLS enabled인지 확인
- [ ] **이상 접근 흔적 확인** → 아래

### 이상 접근 흔적 확인 (Supabase Logs)

1. Dashboard → 좌측 **Logs** → **API Gateway**(Edge) 또는 **PostgREST** 선택
2. 노출 기간(예: 키가 public이었던 약 9일)으로 시간 범위를 지정한다
3. 확인 포인트
   - 내 기기가 아닌 **낯선 IP / User-Agent**
   - `/rest/v1/portmgr_*` 에 대한 대량 `GET`, 특히 `select=*` 또는 `limit` 이 큰 요청
   - 예상하지 못한 `DELETE` / `PATCH` / `POST`
4. **Logs → Logs Explorer** 에서 SQL로 직접 필터링할 수도 있다 (`edge_logs` 소스에 요청 경로/상태코드/IP가 들어 있다)
5. DB 쪽 흔적은 데이터 자체로도 본다:
   ```sql
   -- 최근 생성된 낯선 행 / 모르는 기기가 있는지
   select device_id, device_name, count(*) from portmgr_ports group by 1,2 order by 3 desc;
   select id, name, last_push_at from portmgr_devices order by last_push_at desc nulls last limit 20;
   select created_at, table_name, device_name, row_count from portmgr_push_snapshots order by created_at desc limit 20;
   ```

> ⚠️ **로그 보존 기간에 한계가 있다.** 무료 플랜은 보존 기간이 짧아서 노출 기간의 로그가 이미 사라졌을 수 있다.
> 로그가 비어 있다는 것이 "접근이 없었다"는 증거는 아니다. 흔적을 못 찾더라도 로테이션 + RLS는 그대로 진행한다.

---

## 5. fork한 사용자를 위한 안내

**원작자의 Supabase DB에 접근할 일은 없고, 접근해서도 안 된다.**
이 앱은 "각자 자기 Supabase 프로젝트를 쓰는" 구조다. 저장소에는 URL도 키도 들어 있지 않다 —
값은 로컬 `portal.json`(또는 Vercel 환경변수)에만 저장된다.

fork 후 할 일:

1. **자기 Supabase 프로젝트를 새로 만든다** — https://supabase.com/dashboard → New project
2. **테이블 생성** — 앱의 설정 마법사(SetupWizard)를 따르거나, `src/schemaSql.ts` 의 DDL을 SQL Editor에 붙여넣는다
3. **RLS를 켠다** — 2장 그대로. 이건 선택이 아니다
4. **자기 Project URL + anon key** 를 앱 설정에 입력한다
5. 온보딩 에이전트가 위 과정을 안내한다:

   ```bash
   cd <프로젝트 폴더>
   claude
   # 프롬프트에 "온보딩 해줘" 입력
   ```

   (`.claude/skills/onboarding/SKILL.md`)

원작자 저장소에 있던 어떤 키도 **쓰지 말고, 커밋하지 말고, 이슈에 붙여넣지 마라.**
자기 키를 커밋에 넣지 않으려면 `portal.json`과 `.env` 계열이 `.gitignore`에 있는지 먼저 확인한다.

---

## 참고

- RLS/membership 마이그레이션: `supabase/migrations/20260815010000_enforce_server_email_allowlist.sql`
- 스키마 정본: `src/schemaSql.ts`
- 클라이언트 초기화: `src/lib/supabaseClient.ts`, `src/portal-main.tsx`
- 로컬 백엔드 초기화: `api-server.ts`, `project-memory-server.ts`
- 테이블 스키마 / device_id 격리 정책: `CLAUDE.md`

© 2025 CS & Company. All rights reserved.
