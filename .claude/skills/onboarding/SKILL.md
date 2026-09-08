---
name: onboarding
description: AgentsToZ_byCS의 로컬 첫 실행, 첫 동기화 단말, 추가 Mac·Windows, Ubuntu/AWS 호스트 등록을 상황별로 안전하게 안내하는 대화형 온보딩. 사용자가 "온보딩 해줘", "처음 설치", "새 기기 연결", "AWS 단말 등록", onboarding, setup 이라고 말할 때 사용한다.
---

# 온보딩 에이전트 (AgentsToZ_byCS)

레포를 clone만 한 사용자를 **앱이 실제로 뜨는 상태**까지 데려간다.

## 가장 먼저 알아야 할 사실

**로컬 전용으로 쓸 거면 필요한 계정은 0개, 필수 설치는 `bun` + `git` 2개뿐이다.**
Supabase / GitHub / Vercel / Tauri 빌드 도구는 **전부 선택**이다.
사용자에게 이 사실을 맨 먼저 알려주고, 필요 없는 단계로 끌고 가지 마라.

| 단계 | 필수 여부 | 없으면 생기는 일 |
|---|---|---|
| 1. Bun + Git + `bun install` | **필수** | 앱이 아예 안 뜸 |
| 2. `bun run dev` | **필수** | — |
| 3. Supabase 동기화 | 선택 | Push/Pull 버튼만 실패. 데이터는 로컬 JSON에 저장되어 정상 동작 |
| 4. GitHub 연동 | 선택 | 내 포크에 커밋 불가. 앱 사용엔 무관 |
| 5. Vercel | 선택 | 북마크 포털을 폰에서 못 봄 |
| 6. Tauri 데스크톱 빌드 | 선택 | 브라우저(`localhost:9000`)로 쓰면 됨 |

### 단말 연결의 정본 구조

| 대상 | 정본 UI | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| 첫 Mac·Windows | 새 앱의 `첫 단말 · 동기화 설정` | Supabase·RLS를 만들고 이 앱의 신원을 준비 | 다른 단말 ID 재사용 |
| 추가 Mac·Windows | 기존 앱 `다른 PC 연결 정보 만들기` 또는 배포 포털 `단말 연결 → Mac·Windows 연결` → **새 PC의 앱** | 연결 정보만 만들고, 새 앱이 자기 신원을 등록 | 빈 단말 행 선생성, service_role·로그인 토큰 전달 |
| Ubuntu/AWS/Linux | 포털 `단말 연결 → 클라우드·서버` 또는 앱 `장기기억 → 클라우드 단말` | 호스트용 일회용 명령 발급, 서버가 자체 credential로 등록 | 데스크톱 설치 마법사로 서버 프로젝트 하나를 단말처럼 등록 |

추가 단말의 계층은 항상 **호스트 → 프로젝트**다. 먼저 Ubuntu/AWS 호스트를 한 번 등록하고,
그다음 새 프로젝트·GitHub 복제·장기기억 복원으로 하위 프로젝트를 연결한다.
포털은 연결 정보만 만든다. 실제 단말 신원과 DB 행은 대상 앱 또는 서버가 성공할 때 확정한다.

같은 물리 단말이 재설치·설정 초기화로 여러 ID를 갖게 되면 행을 삭제하거나 프로젝트를
새 ID로 일괄 재작성하지 않는다. `portmgr_device_identity_aliases`로 이전 ID를 현재 ID에
연결하고, 포털은 그 ID들의 프로젝트를 한 호스트 카드 아래 합쳐 보여준다. 이름이 비슷하다는
이유만으로 자동 연결하지 말고 hostname·플랫폼·현재 로컬 설정을 함께 확인한다.

보안 경계도 분리한다.
- Tauri 데스크톱 앱: localhost sidecar가 이 PC에만 저장된 service_role 키를 사용한다. 일상 사용에 Google 로그인은 요구하지 않는다.
- browser/배포 포털: Google OAuth authenticated JWT와 `portmgr_allowed_members`를 사용한다.
- 초대 정보: 공개 Project URL·anon key·추천 단말 이름만 포함한다. 기존 단말 ID, service_role 키, 로그인 토큰은 포함하지 않는다.

### 첫 단말/추가 단말 자동 판정

API가 실행 중이면 질문보다 먼저 아래 상태를 읽는다. 이 응답은 key나 토큰 값을 반환하지 않는다.

```bash
curl --fail-with-body -sS http://127.0.0.1:3001/api/onboarding/status
```

| `stage` | 판정 | 다음 행동 |
|---|---|---|
| `registered` | 이 설치는 이미 확정된 단말 | 현재 신원을 덮어쓰지 않는다. 다른 PC 추가는 현재 앱의 `다른 PC 연결 정보 만들기`를 권장 |
| `additional-pending` | 추가 단말 DB 등록이 중간에 끊김 | 저장된 같은 UUID로 `두 번째·추가 기기 연결`을 재개. 새 UUID 생성 금지 |
| `configured-unregistered` | URL/key 또는 ID 일부만 있음 | 첫 설정을 마칠지, 기존 PC 초대를 붙여넣을지 1회 확인 |
| `fresh` | 이 설치에 로컬 신원이 없음 | 다른 PC에서 이미 동기화를 쓰는지만 1회 확인 후 첫/추가 경로 선택 |

완전히 새 clone에는 원격 Supabase 정보가 없으므로 다른 단말의 존재를 스스로 조회할 수 없다.
이때 “첫 단말”이라고 추측하지 말고 **기존 PC에서 이미 AgentsToZ 동기화를 쓰는지 한 번만 묻는다.**
v3 초대 JSON을 사용자가 제공했다면 추가 단말임이 증명되므로 다시 묻지 않는다.

개인 Vercel 포털은 추가 Mac·Windows의 필수 조건이 아니다. 등록된 첫 단말 앱에서
`초기 설정 → 다른 PC 연결 정보 만들기`로 v3 초대를 복사하고 새 PC 앱에 붙여넣으면 된다.
배포 포털은 폰/원격 브라우저 접근과 기기 현황판을 원하는 사용자에게 권장하는 선택 기능이다.

---

## 0단계: 진단 (질문하기 전에 먼저 실행)

사용자에게 아무것도 묻지 말고 **스스로 환경을 검사**한 뒤, 결과를 표로 보여준다.

### 클론 위치 확인 (Windows에서 특히 중요)

`pwd`로 현재 경로를 확인한다. 경로가 `C:\Windows\System32\` 하위라면 **경고**한다:
NSIS(makensis.exe)가 System32 하위 파일 읽기를 OS 차단당해(os error 2/5)
`.exe` 빌드가 실패한다. 권장 위치는 `C:\Users\<이름>\dev\AgentsToZ_byCS`.
단, 브라우저 모드로만 쓸 거면 그대로 진행해도 무방하다 — 사용자에게 선택시킨다.

### 도구 존재 확인

**Windows (PowerShell 도구):**
```powershell
Get-Command bun,git,gh,supabase,vercel,cargo,node,rustc -ErrorAction SilentlyContinue | Select-Object Name,Version,Source
```

**macOS (Bash 도구):**
```bash
command -v bun git gh supabase vercel cargo node
```

### 버전/상태 확인
```bash
bun --version
git --version
```

의존성 설치 여부는 Vite 실행 파일로 판정한다. **판정 파일이 플랫폼마다 다르다:**
- macOS: `node_modules/.bin/vite`
- Windows: `node_modules\.bin\vite.exe` — Windows에는 확장자 없는 `vite` 파일이 생기지 않는다
  (`vite.exe`, `vite.bunx`만 생성됨). `Test-Path node_modules\.bin\vite`는 설치 성공 후에도
  항상 False이므로 판정 기준으로 쓰지 마라.

(`dev.ts`는 `./node_modules/.bin/vite`를 spawn하지만 Windows에서는 Bun이 `.exe`를 해석해
실제 실행은 성공한다 — 실행 경로와 존재 판정 경로가 다른 이유.)

### 진단 결과 출력 형식

```
| 항목 | 상태 | 조치 |
|---|---|---|
| 클론 위치 | C:\Users\me\dev\AgentsToZ_byCS | OK |
| bun | 1.2.x | OK |
| git | 2.4x | OK |
| node_modules | 없음 | 2단계에서 bun install |
| supabase CLI | 없음 | 선택 — 3단계에서 결정 |
```

**이미 있는 항목은 다시 언급하지 말고 넘어간다.**

---

## 1단계: 필수 런타임 설치

없는 것만 설치한다. 이미 있으면 이 단계 전체를 건너뛴다.

### Bun

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```
설치 후 **반드시 새 PowerShell 창을 열어야** PATH가 갱신된다. 같은 창에서 `bun`을 부르면 인식 안 된다.

**macOS (bash):**
```bash
curl -fsSL https://bun.sh/install | bash
```

검증: `bun --version` → 버전 문자열이 나와야 한다.

### Git

**Windows:**
```powershell
winget install Git.Git
```
**macOS:**
```bash
xcode-select --install   # 또는: brew install git
```

검증: `git --version`

> Git은 clone/포크·PR에 쓰인다. 앱 버전은 git이 아니라 `build-number.json`의 빌드 번호로 만들어진다.

### (선택) Tauri `.exe`/`.dmg`를 직접 빌드할 때만

6단계에서 빌드를 원한다고 했을 때만 설치한다. **지금 묻지 마라.**

**Windows:**
```powershell
winget install Rustlang.Rustup
# 새 창에서:
rustup default stable-msvc
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# Windows 10이면 추가:
winget install Microsoft.EdgeWebView2Runtime
```
- Rust는 **1.77.2 이상** 필요 (`src-tauri/Cargo.toml`).
- MSVC Build Tools 없으면 `link.exe not found`로 실패.
- NSIS는 별도 설치 불필요 — Tauri CLI가 자동 다운로드한다.

**macOS:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install
```

검증: `cargo --version`

> (선택·무해) 아이콘에 `vN` 버전 스탬프를 찍으려면 Python + Pillow가 필요하다.
> 없으면 `stamp-icon.py`는 스킵되고 빌드는 그대로 진행된다.

---

## 2단계: 의존성 설치 및 첫 실행 — **여기까지만 해도 앱은 다 된다**

```bash
bun install
```
검증 (플랫폼별로 판정 파일이 다르다):
- macOS: `node_modules/.bin/vite` 파일이 생겼는지 확인
- Windows (PowerShell): `Test-Path node_modules\.bin\vite.exe` → `True`
  (확장자 없는 `node_modules\.bin\vite`는 Windows에 생기지 않으므로 그 경로로 판정하지 마라)

```bash
bun run dev
```
`package.json`의 `dev`는 `bun dev.ts`이며, 하나의 러너가 **API 서버(3001) + Vite(9000)** 를 함께 띄우고 종료 시 둘 다 정리한다.
(`bun run start`도 같은 스크립트다. `bun run api`는 API 서버만 띄운다.)

> ⚠️ `vite`를 직접 호출하지 마라. `dev.ts`가 `./node_modules/.bin/vite`를 직접 spawn한다.

**브라우저에서 열기: http://localhost:9000**

포트와 설정이 모두 없는 새 로컬 프로필에서는 초기 설정 마법사가 자동으로 열린다.
**"로컬로 바로 시작" 또는 "건너뛰기"를 누르면 바로 사용할 수 있다.**
이미 사용 중인 프로필은 헤더의 로켓(설정) 버튼에서 마법사를 연다.

### 여기서 한 번 멈춘다

사용자에게 이렇게 말한다:

> 여기까지면 앱은 이미 쓸 수 있습니다. 포트 등록·실행·중지·로그·북마크 전부 동작하고,
> 데이터는 로컬에 저장됩니다
> (Windows: `%APPDATA%\com.portmanager.portmanager\ports.json` /
> macOS: `~/Library/Application Support/com.portmanager.portmanager/ports.json`).
>
> 다음은 전부 선택입니다:
> ③ 여러 기기 동기화(Supabase) ④ GitHub 포크 연동 ⑤ 모바일 포털(Vercel) ⑥ 데스크톱 앱 빌드
>
> 필요한 것만 골라주세요. 아무것도 필요 없으면 여기서 끝내도 됩니다.

**사용자가 고르기 전에 3단계로 넘어가지 마라.**

---

## 3단계: Supabase 동기화 (선택 — 기기가 2대 이상일 때만)

### 먼저 물어본다

> PC와 노트북처럼 **기기를 2대 이상** 쓰면서 포트 목록·북마크를 공유하고 싶습니까?
> 기기가 1대면 불필요합니다 — 건너뛰어도 앱은 완전히 동작합니다.

"아니오"면 즉시 4단계 안내로 넘어간다.

### 3-1. 계정 및 프로젝트

1. https://supabase.com 가입 (GitHub 로그인 가능)
2. New Project 생성 — **무료 Free 플랜으로 충분**하다 (프로젝트 2개, DB 500MB)
   - ⚠️ 무료 플랜은 **7일간 활동이 없으면 프로젝트가 자동 일시정지**된다. 대시보드에서 재개하면 된다.
3. Dashboard → **Settings → API** 에서 두 값을 복사:
   - **Project URL** — `https://<ref>.supabase.co`
   - **anon public key** — ⚠️ `service_role` 키는 **절대 쓰지 마라**

### 3-2. 테이블 생성 — 경로 (a): SQL Editor 붙여넣기 (권장, CLI 불필요)

DDL의 정본은 `src/schemaSql.ts`의 `MIGRATION_SQL` **하나뿐**이다. 현재 `PORTMGR_TABLES`와
**RLS 정책(로그인한 사용자만 접근, anon 전면 차단)** 이 한 덩어리로 들어 있다.
이 문서에 SQL 사본을 두지 않는다. 사본은 반드시 정본과 어긋나게 되기 때문이다.

owner 이메일을 검증해 포함한 정본 SQL 추출 (레포 루트):
```bash
ALLOWED_EMAIL=owner@example.com bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```
Windows PowerShell에서는 먼저 `$env:ALLOWED_EMAIL = 'owner@example.com'`을 실행한 뒤
같은 `bun -e` 명령을 실행한다.

출력 **전체**를 Supabase Dashboard → **SQL Editor → New query** 에 붙여넣고 Run.
(앱의 초기 설정 마법사가 보여주는 SQL과 동일 출처이므로, 앱 화면에서 복사해도 같다.)

- ⚠️ 하단의 RLS 블록(`enable row level security`, `revoke ... from anon`)을 **빼고 실행하지 마라.**
  RLS 없이 테이블만 만들면 anon key를 가진 누구나 전체 데이터를 읽고 쓸 수 있다.
- 실행 후 Table Editor에서 현재 `PORTMGR_TABLES`가 보이는지, 각 테이블에 **RLS enabled** 배지가
  붙어 있는지(= "Unrestricted" 표시가 없는지) 확인시킨다.
- 보안 배경·검증 쿼리·키 로테이션 절차: `docs/SECURITY-SETUP.md`

### 3-3. 테이블 생성 — 경로 (b): Supabase CLI

CLI를 이미 쓰는 사용자에게만 제안한다. (a)로 충분하다.

**Windows** — Supabase CLI는 winget으로 설치되지 않는다. Scoop을 쓴다:
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
irm get.scoop.sh | iex
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```
> ⚠️ 앱의 CLI 탐색 로직이 `%APPDATA%\scoop\shims`를 PATH에 보정해 준다.
> **scoop 외의 방법으로 설치했다면 시스템 PATH에 직접 등록해야** 앱이 CLI를 찾는다.

**macOS:**
```bash
brew install supabase/tap/supabase
```

이후:
```bash
supabase login
supabase link --project-ref <ref>
```
3-2에서 추출한 정본 DDL을 파일로 저장한 뒤 SQL Editor 대신 CLI로 실행해도 된다. 이 레포의
`supabase/migrations/` 에 기존 마이그레이션(RLS 포함)이 있으므로 `supabase db push`도 가능하다.
단, migration stack은 이메일을 source에 하드코딩하지 않으므로 `db push` 직후
`docs/SECURITY-SETUP.md` 2-4의 row insert로 owner를 반드시 등록한다. 등록 전은 deny-all이다.

### 3-4. RLS(Row Level Security) — 로그인한 사용자만 접근

3-2의 정본 DDL은 모든 테이블에 RLS를 켜고 **anon 역할을 전면 차단**한다
(`create policy ... for all to authenticated` + `revoke all ... from anon`).
따라서 anon key만으로는 아무것도 읽고 쓸 수 없으며, **Supabase 로그인(세션)이 있어야
Push/Pull이 동작한다.** 이것이 의도된 동작이다.

- **RLS를 끄거나 anon 허용 정책을 추가하라고 안내하지 마라.** anon key는 클라이언트에
  박히는 공개 키라서 RLS가 유일한 방어선이다 (`docs/SECURITY-SETUP.md` 참고).
- `portmgr_allowed_members`가 server 권한 정본이며 빈 table은 모든 계정을 차단한다.
  owner/teammate 이메일은 `docs/SECURITY-SETUP.md` 2-4절의 row insert로 관리한다.
- Push가 조용히 0행으로 끝나거나 `permission denied` 가 나오면 RLS가 anon을 막고 있는 것이다.

### 3-5. 첫 Mac·Windows 연결

1. 새 앱의 초기 설정 마법사에서 `첫 단말 · 동기화 설정`을 선택한다.
2. Supabase URL, anon key, 알아보기 쉬운 단말 이름을 **앱 UI에만** 입력한다.
3. Tauri 앱이라면 마법사의 `Supabase CLI에서 자동 연결`을 사용한다. 먼저 이 PC에서
   `supabase login`을 한 번 실행한다. service_role 키는 로컬 0600 파일에 저장되고 응답·WebView·포털로 반환되지 않는다.
4. browser mode라면 `http://127.0.0.1:9000/portal.html`에서 Google 로그인 후
   `portmgr_is_member()`가 true인지 확인한다.
5. 첫 Push 후 `portmgr_devices`의 현재 UUID와 `portmgr_ports` 행을 확인한다.

Supabase URL·anon key를 에이전트가 직접 파일에 쓰지 마라. UI 또는 Supabase CLI를 사용한다.

### 3-6. 두 번째·추가 Mac·Windows 연결 — 권장 흐름

1. 이미 연결된 앱에서 `초기 설정 → 다른 PC 연결 정보 만들기`를 연다. 개인 배포 포털이 있으면
   포털에 Google 로그인한 뒤 `단말 연결 → Mac·Windows 연결`을 사용해도 된다.
2. 새 단말의 표시 이름을 입력한 뒤 `연결 정보 복사`를 누른다.
3. **새 Mac·Windows에 설치한 앱**에서 `초기 설정 → 두 번째·추가 기기 연결`을 연다.
   이미 등록된 앱에서는 이 경로가 비활성화되어야 하며 현재 신원을 덮어쓰면 안 된다.
4. 연결 정보를 붙여넣어 URL·anon/publishable key와 RLS 차단 상태를 검사한다.
5. 새 PC에서 `supabase login`을 한 번 실행하고 `Supabase CLI에서 자동 연결`을 누른다.
6. 새 단말 앱이 새 UUID를 생성하고 `portmgr_devices` upsert 응답을 받은 뒤 등록을 확정한다.

반드시 지킬 안전 규칙:
- 기존 단말 ID를 복사하거나 선택하지 않는다. 같은 컴퓨터의 재설치 중복은 장기기억의 `중복 단말 정리`에서 데이터 삭제 없이 한 단말로 묶는다.
- 포털은 DB에 빈 단말 행을 미리 만들지 않는다. 실제 앱이 성공할 때만 행이 생긴다.
- 응답이 끊기면 `pendingDeviceRegistration`에 보존된 같은 UUID로 재시도한다. 매번 새 UUID를 만들지 않는다.
- 연결 정보에는 service_role 키나 Supabase CLI 로그인 토큰을 넣지 않는다.
- 같은 PC의 과거 ID가 확인되면 `중복 단말 정리`로 이력을 접고, 포털 프로젝트 조회는 대표 ID와 모든 이전 ID를 함께 읽는다.

### 3-7. Ubuntu/AWS/Linux 호스트 연결

Ubuntu/AWS는 추가 Mac·Windows 마법사에 넣지 않는다.

1. 포털 `단말 연결 → 클라우드·서버` 또는 앱 `장기기억 → 클라우드 단말`을 연다.
2. 호스트 이름과 환경을 정하고 호스트용 일회용 등록 명령을 만든다.
3. 서버 터미널에서 명령을 실행해 **호스트를 먼저 등록**한다.
4. 호스트가 보인 뒤 하위에서 `새 프로젝트`, `GitHub 복제`, `장기기억 복원` 중 하나를 실행한다.
5. `~/.local/bin/agentstoz-status`와 마지막 보고 시각, agent 버전으로 온라인·동기화 상태를 확인한다.
6. agent v4 이상이면 각 프로젝트의 로컬 Telegram 바인딩 파일을 읽어 토픽 ID가 있는 프로젝트만 호스트 인벤토리에 함께 보고한다.

일회용 명령의 만료 시간은 초대가 유효한 시간일 뿐이다. 등록된 호스트 연결은 `등록 해제`할 때까지 유지된다.
`등록 해제`는 원격 credential을 실제로 폐기한다. 화면 안 2단계 확인을 거쳐야 하며, 실수로
해제했다면 이력 행을 삭제하지 말고 `이력 승계 재연결`을 만들어 기존 서버에서 실행한다.
이 재연결은 새 credential을 발급하되 이전 원격 ID와 그 아래 프로젝트를 새 ID 계보로 자동 연결한다.
기기 관리의 사용 중 대수는 대표 물리 단말만 세며, 재설치 ID·원시 hostname·등록 해제 이력은 별도 단말 수로 세지 않는다.
장기기억 카드의 `확인 대상에서 제외`는 이 동작과 다르다. 기억 내용·ID·Git 이력은 이동하거나
삭제하지 않고 동기화 집계에서만 제외한다. 내용을 합치는 일은 별도의 `기억 병합` 절차다.

---

## 브라우저 보조 모드 — 첫 단말의 개인 포털/OAuth (선택)

사용자가 개인 배포 포털을 원하면서 “브라우저로 도와줘”, “Playwright로 해줘”,
“보고 따라가기 어렵다”고 말했을 때만 실행한다. 첫 단말 로컬 등록이 끝나지 않았다면 먼저 3-5를 마친다.

### 시작 전 검사

1. `/api/onboarding/status`가 `registered`인지 확인한다.
2. `command -v npx >/dev/null 2>&1`로 Playwright CLI 전제조건을 확인한다.
3. 사용 가능한 Playwright/browser automation 지침을 먼저 읽고 해당 wrapper나 CLI를 사용한다.
   사용 가능한 Playwright CLI가 없고 새 패키지 다운로드가 필요하면 명령과 영향을 먼저 보여주고 승인을 받는다.
4. headed 브라우저로 열고, 이동 또는 큰 UI 변화 뒤에는 매번 새 snapshot을 얻는다. 예전 selector나
   문서의 버튼 위치를 현재 화면보다 우선하지 않는다.

### 안전 경계

- 계정 로그인, 2단계 인증, CAPTCHA, Google Client Secret 입력은 사용자가 브라우저에서 직접 한다.
- 비밀번호, 쿠키, access token, Client Secret을 읽거나 채팅·로그·스크린샷·trace에 남기지 않는다.
  비밀값 입력 화면에서는 snapshot을 만들지 말고 사용자가 저장·이동한 뒤 다시 snapshot한다.
- Supabase/Vercel 프로젝트 생성, OAuth client 생성, 환경 변수 변경, production 배포처럼 외부 상태를
  바꾸는 마지막 클릭 직전에 변경 내용을 한 문장으로 알리고 확인을 받는다.
- RLS를 끄거나 anon 정책을 추가하지 않는다. Google OAuth Client ID/Secret은 Vercel 환경 변수가 아니라
  Supabase Authentication → Providers → Google에만 넣는다.

### 권장 순서

1. Supabase Dashboard에서 기존 첫 단말 프로젝트를 열고 Table/RLS와 owner membership을 확인한다.
2. Google Cloud Console에서 Web application OAuth client를 만든다. Authorized redirect URI는
   Supabase Google provider 화면이 보여주는 `https://<project-ref>.supabase.co/auth/v1/callback`을 쓴다.
3. Supabase Google provider에 Client ID/Secret을 사용자가 직접 입력하고 Google을 활성화한다.
4. 앱 `포털 배포 · Google 로그인`의 자동 배포를 사용한다. 이 경로는 현재 clone을 직접 배포하므로
   GitHub Fork가 필수가 아니다. Fork는 Git push 자동 재배포가 필요할 때만 선택으로 제안한다.
5. 배포 URL이 나오면 Supabase URL Configuration의 Redirect URLs에 production URL을 추가한다.
6. production 포털을 열어 Google 로그인 → `portmgr_is_member()` 허용 → 기기 현황 표시를 검증한다.
7. 추가 PC 설치는 Vercel 없이도 첫 단말 앱 `다른 PC 연결 정보 만들기`로 가능하다는 선택지를 함께 남긴다.

화면 문구가 바뀌어도 Playwright snapshot으로 현재 UI를 탐색한다. 대시보드 자동화가 막히면 현재 화면과
사용자가 눌러야 할 단 하나의 동작만 말하고, 완료 후 다음 snapshot부터 이어간다.

---

## 4단계: GitHub 연동 (선택)

**공개 레포라 clone만 할 거면 계정이 필요 없다.** 다음일 때만 필요하다:
- 내 포크에 커밋/푸시하고 싶다
- GitHub Actions로 Windows `.exe`를 클라우드 빌드하고 싶다 (로컬 Rust/MSVC 설치를 피할 수 있다)

```powershell
winget install GitHub.cli     # Windows
```
```bash
brew install gh               # macOS
```
```bash
gh auth login --web
gh auth status                # 검증
```

포크 흐름:
```bash
gh repo fork intenet1001-commits/AgentsToZ-public --remote=false
git remote add fork https://github.com/<내계정>/AgentsToZ-public.git
git push fork main
```

클라우드 빌드를 쓰려면 포크한 레포에서 `.github/workflows/build-windows.yml`을
workflow_dispatch로 실행하고 아티팩트를 내려받는다. 이 경우 6단계(Rust/MSVC)는 불필요하다.

---

## 5단계: Vercel 개인 포털 (선택 — 첫 단말에서 권장 가능)

**이 앱 자체는 로컬 데스크톱/브라우저 앱이므로 Vercel이 전혀 필요 없다.**
Vercel은 **북마크·기기 현황을 폰/원격 브라우저에서 보고 싶을 때** 쓴다. 추가 Mac·Windows
연결만을 위해서는 필요 없지만, 첫 단말을 만들 때 개인 포털까지 원하는 사용자에게 함께 권장할 수 있다.

가장 쉬운 경로는 앱 `초기 설정 → 포털 배포 · Google 로그인`이다. 첫 단말에 저장된 공개
Supabase URL·anon/publishable key와 owner 이메일을 Vercel Production 환경 변수에 넣고 배포한다.
현재 공개 clone을 직접 배포하므로 GitHub Fork는 필수가 아니며, Git push 자동 재배포가 필요할 때만 선택한다.

```powershell
winget install OpenJS.NodeJS.LTS   # Windows (npx 필요)
```
```bash
npm install -g vercel
vercel login
```

수동 배포에서는 빌드 타임에 환경변수가 주입되어야 하므로 Vercel 프로젝트에 등록한다:
```bash
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
vercel env add VITE_ALLOWED_EMAIL          # 선택 — Google 로그인 허용 이메일 목록
```
같은 값을 로컬 `.env`에도 넣으려면 `.env.example`을 복사해 채운다.

`VITE_ALLOWED_EMAIL`을 비워도 포털은 공개되지 않는다. 비어 있으면 로그인한 모든 Google
계정을 UI에서 허용하며, 실제 데이터 접근은 Supabase RLS와 로그인 세션이 계속 제한한다.
Google OAuth Client ID/Secret과 Redirect URL은 Vercel 환경변수가 아니라 Supabase
Authentication → Providers → Google 및 URL Configuration에 설정한다.

로컬 포털 빌드 확인: `bun run build:portal`

---

## 6단계: Tauri 데스크톱 앱 빌드 (선택)

브라우저(`localhost:9000`)로 쓸 거면 필요 없다. 1단계의 Rust/Build Tools가 선행되어야 한다.

**Windows:**
```powershell
bun run tauri:build:win
```
결과물: `%USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe`

> **CARGO_TARGET_DIR 주의**: `build-win.ts`가 target 디렉터리를 홈 디렉터리
> (`~\cargo-targets\portmanager`)로 강제 리다이렉트한다. 프로젝트가 `C:\Windows\System32\`
> 하위에 있을 때 makensis.exe의 파일 읽기가 OS에 차단되는 문제(os error 2/5)를 우회하기 위한
> 장치다. 그래서 빌드 결과물이 프로젝트 폴더가 아니라 홈 디렉터리에 생긴다.

**macOS:**
```bash
bun run tauri:build         # .app 번들
bun run tauri:build:dmg     # 배포용 DMG
```
결과물 (`productName`은 `update-version.ts`가 `AgentsToZ_byCS`로 고정한다):
- `.app`: `~/cargo-targets/portmanager/release/bundle/macos/AgentsToZ_byCS.app`
- DMG: `~/cargo-targets/portmanager/release/bundle/dmg/AgentsToZ_byCS_<N>.0.0_aarch64.dmg`

> 버전은 날짜가 아니라 **빌드 번호**다. `update-version.ts`가 `build-number.json`의
> `buildNumber`를 1 올리고 `tauri.conf.json`의 `version`을 `<N>.0.0`으로 쓴다.
> 빌드할 때마다 번호가 올라가며 git 커밋 여부와는 무관하다.

개발 중 데스크톱 창으로 확인만 하려면 빌드 없이:
```bash
bun run tauri:dev
```

---

## 완료 체크리스트

사용자가 스스로 확인할 수 있게 해당되는 항목만 제시한다.

**필수**
- [ ] `bun --version`이 버전을 출력한다
- [ ] `git --version`이 버전을 출력한다
- [ ] vite 실행 파일이 존재한다 — macOS: `node_modules/.bin/vite` / Windows: `node_modules\.bin\vite.exe`
- [ ] `bun run dev` 실행 중 콘솔에 에러가 없다
- [ ] 브라우저에서 http://localhost:9000 이 열린다
- [ ] 포트를 하나 등록하고 앱을 껐다 켜도 목록이 남아 있다
- [ ] `bun run typecheck` 가 0 에러 (코드를 수정할 계획이면)

**Supabase (3단계를 했다면)**
- [ ] Table Editor에 현재 `PORTMGR_TABLES`가 있다 (전부 RLS enabled — "Unrestricted" 없음)
- [ ] 설정에 URL/anon key/기기 이름이 저장돼 있다
- [ ] `portmgr_allowed_members`에 owner 이메일을 등록했고 `portmgr_is_member()`가 true다
- [ ] Vercel `VITE_ALLOWED_EMAIL`의 owner와 `portmgr_allowed_members`의 owner가 일치한다
- [ ] Tauri 앱은 로컬 service_role 연결이 있고, browser/배포 포털은 Google 세션이 있다
- [ ] Push 후 `portmgr_ports`에 행이 실제로 늘어난다 (0행이면 RLS 거부 여부 확인)
- [ ] 다른 기기에서 Pull하면 목록이 들어온다

**추가 Mac·Windows (3-6을 했다면)**
- [ ] 초대 JSON은 v3이며 URL·anon key·추천 이름만 들어 있다
- [ ] 새 앱이 기존 단말 ID가 아닌 새 UUID를 사용한다
- [ ] 등록 완료 후에만 `pendingDeviceRegistration`이 false다
- [ ] `portmgr_devices`에 새 이름으로 행이 하나만 생겼다

**Ubuntu/AWS/Linux (3-7을 했다면)**
- [ ] 호스트 카드가 먼저 보이고 프로젝트가 그 아래에 보인다
- [ ] agent 버전·마지막 보고 시각·프로젝트별 기억/Git 상태가 보인다
- [ ] agent v4 이상이면 연결된 프로젝트의 Telegram 토픽 ID가 보인다
- [ ] 등록 해제된 호스트는 `이력 승계 재연결`로 복구할 수 있고, 기본 확인 대화상자 없이 즉시 폐기되지 않는다

**GitHub (4단계)**
- [ ] `gh auth status` 가 로그인 상태를 보고한다

**Vercel (5단계)**
- [ ] `vercel whoami` 가 계정을 출력한다
- [ ] 배포된 포털 URL이 폰에서 열린다 (빈 화면이면 VITE_* 환경변수 확인)

**Tauri 빌드 (6단계)**
- [ ] `cargo --version` 이 1.77.2 이상
- [ ] 빌드 산출물이 `~/cargo-targets/portmanager/release/bundle/` 아래에 생성됐다

---

## 진행 원칙 (에이전트 행동 지침)

1. **한 번에 한 단계씩.** 각 단계가 끝나면 결과를 보고하고 사용자 확인을 받은 뒤 다음으로 간다.
2. **이미 설치된 것은 절대 재설치하지 않는다.** 0단계 진단 결과를 신뢰하고, 있는 항목은 언급조차 최소화한다.
3. **선택 단계(3~6)는 반드시 "할지 말지" 먼저 묻는다.** 사용자가 원한다고 말하기 전에 설치 명령을 실행하지 마라.
4. **명령 실행 후 결과를 검증한다.** 실패하면 원인을 한 문장으로 설명하고 대안을 제시한다
   (예: Supabase CLI 설치 실패 → SQL Editor 수동 경로 / 로컬 Rust 빌드 실패 → GitHub Actions 빌드).
5. **API 키·토큰을 받아서 파일에 쓰지 않는다.** 앱 UI 또는 각 CLI의 로그인 명령으로 입력하도록 안내한다.
   `.env`는 Vercel 배포용 빌드타임 변수에 한해서만 다룬다.
6. **장황한 설명 금지.** 사용자가 이미 아는 내용은 반복하지 않는다. 명령 + 검증 방법 + 실패 시 의미만 전달한다.
7. **설치 명령은 사용자 확인 후 실행한다.** 특히 `winget install`, `Set-ExecutionPolicy`,
   `wsl --install`(재부팅 유발)처럼 시스템을 바꾸는 명령은 무단 실행하지 마라.
8. **Windows는 PowerShell, macOS는 bash**로 명령을 구분해 제시한다. 플랫폼에 맞는 쪽만 보여준다.
9. 사용자가 "다 됐다"고 하면 완료 체크리스트 중 해당 항목만 요약해 마무리한다.
10. **단말 ID를 운반하지 않는다.** 새 물리 단말은 항상 새 ID를 만들고, 재설치 중복은 `중복 단말 정리`로 처리한다.
11. **등록 완료 순서를 바꾸지 않는다.** 로컬 credential 저장 → 새 ID 보존 → DB upsert 확인 → pending 해제 순서다.
12. **호스트와 프로젝트를 섞지 않는다.** Ubuntu/AWS 호스트 등록이 1단계, 그 호스트의 프로젝트 생성·복제·복원이 2단계다.
