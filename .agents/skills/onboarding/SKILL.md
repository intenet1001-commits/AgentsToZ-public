---
name: onboarding
description: 이 프로젝트(AgentsToZ_byCS)를 처음 설치하는 사용자를 위한 Codex용 대화형 온보딩. 환경 진단, CLI 설치, 계정 가입 안내, Supabase 테이블 생성, 첫 실행까지 단계별로 진행한다. 사용자가 "온보딩 해줘", "처음 설치", "환경 설정 도와줘", onboarding, setup 이라고 말할 때 사용한다.
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

---

## 0단계: 진단 (질문하기 전에 먼저 실행)

사용자에게 아무것도 묻지 말고 **스스로 환경을 검사**한 뒤, 결과를 표로 보여준다.

### 클론 위치 확인 (Windows에서 특히 중요)

`pwd`로 현재 경로를 확인한다. 경로가 `C:\Windows\System32\` 하위라면 **경고**한다:
NSIS(makensis.exe)가 System32 하위 파일 읽기를 OS 차단당해(os error 2/5)
`.exe` 빌드가 실패한다. 권장 위치는 `C:\Users\<이름>\dev\AgentsToZ_byCS`.
단, 브라우저 모드로만 쓸 거면 그대로 진행해도 무방하다 — 사용자에게 선택시킨다.

### 도구 존재 확인

shell 도구로 실행한다.

**Windows** — `powershell -NoProfile -Command "..."` 로 감싸 실행:
```powershell
Get-Command bun,git,gh,supabase,vercel,cargo,node,rustc -ErrorAction SilentlyContinue | Select-Object Name,Version,Source
```

**macOS:**
```bash
command -v bun git gh supabase vercel cargo node
```

### 버전/상태 확인
```bash
bun --version
git --version
```

의존성 설치 여부는 플랫폼별 실행 파일로 판정한다:
- macOS: `node_modules/.bin/vite`
- Windows: `node_modules\.bin\vite.exe`

`dev.ts`는 `./node_modules/.bin/vite`를 spawn하며, Windows에서 Bun은 해당 shim을 해석한다.

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
검증:
- macOS: `node_modules/.bin/vite` 파일이 생겼는지 확인
- Windows (PowerShell): `Test-Path node_modules\.bin\vite.exe` 가 `True`인지 확인

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

DDL의 정본은 `src/schemaSql.ts`의 `MIGRATION_SQL` 하나뿐이다. 이 문서에 SQL 사본이나
테이블 개수를 두지 마라. 현재 `PORTMGR_TABLES` 목록과 RLS 정책을 함께 만든다.

owner 이메일을 검증해 포함한 정본 SQL 추출 (레포 루트):
```bash
ALLOWED_EMAIL=owner@example.com bun -e "import { migrationSqlForAllowedEmails } from './src/schemaSql.ts'; console.log(migrationSqlForAllowedEmails([process.env.ALLOWED_EMAIL ?? '']))"
```
Windows PowerShell에서는 먼저 `$env:ALLOWED_EMAIL = 'owner@example.com'`을 실행한 뒤
같은 `bun -e` 명령을 실행한다.

출력 전체를 Supabase Dashboard → **SQL Editor → New query** 에 붙여넣고 Run.
(초기 설정 마법사와 API 자동 생성도 같은 정본을 사용한다.)

- RLS 블록(`enable row level security`, `revoke ... from anon`)을 빼지 마라.
- Table Editor에서 `PORTMGR_TABLES`의 각 테이블과 **RLS enabled** 상태를 확인한다.
- 보안 배경·검증 쿼리·키 로테이션 절차: `docs/SECURITY-SETUP.md`.

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
`supabase/migrations/` 을 사용할 땐 `supabase db push`로 적용한다.
단, migration stack은 이메일을 source에 하드코딩하지 않으므로 `db push` 직후
`docs/SECURITY-SETUP.md` 2-4의 row insert로 owner를 반드시 등록한다. 등록 전은 deny-all이다.

### 3-4. RLS(Row Level Security) — 로그인한 사용자만 접근

정본 DDL은 모든 앱 테이블에 RLS를 켜고 **anon 역할을 전면 차단**한다.

- RLS를 끄거나 anon 허용 정책을 추가하라고 임의로 안내하지 마라.
- `portmgr_allowed_members`가 server 권한 정본이며 빈 table은 모두 차단한다.
- `permission denied`나 0행 Push는 RLS가 anon을 막고 있다는 뜻이다.

### 3-5. 앱에 URL/키 입력 — **파일에 쓰지 말고 UI에 입력시킨다**

1. 앱 화면(`localhost:9000`)의 초기 설정 마법사에서 `처음 사용` 또는
   `기존 Supabase 프로젝트 빠른 연결`을 선택해 `Supabase URL`, `anon key`, 기기 이름을 저장한다.
   - 값은 `portal.json`(앱 데이터 디렉터리)에 저장된다.
   - 에이전트는 키를 받아 파일에 기록하지 말고, 반드시 UI 입력으로 유도한다.
2. Supabase Redirect URLs에 browser `http://127.0.0.1:9000/`과 desktop
   `http://127.0.0.1:3001/api/auth/native/callback/*`를 등록한다.
3. 앱의 Google 로그인 후 `portmgr_is_member()`가 true인지 확인하고 Push/Pull한다.

검증: Push 버튼 → Table Editor에서 `portmgr_ports` 행이 생기는지 확인.

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
gh repo fork intenet1001-commits/AgentsToZ_byCS --remote=false
git remote add fork https://github.com/<내계정>/AgentsToZ_byCS.git
git push fork main
```

클라우드 빌드를 쓰려면 포크한 레포에서 `.github/workflows/build-windows.yml`을
workflow_dispatch로 실행하고 아티팩트를 내려받는다. 이 경우 6단계(Rust/MSVC)는 불필요하다.

---

## 5단계: Vercel (선택 — 대부분 불필요)

**이 앱 자체는 로컬 데스크톱/브라우저 앱이므로 Vercel이 전혀 필요 없다.**
Vercel이 쓰이는 곳은 단 하나 — **북마크 포털을 스마트폰에서 보고 싶을 때**다.

```powershell
winget install OpenJS.NodeJS.LTS   # Windows (npx 필요)
```
```bash
npm install -g vercel
vercel login
```

포털을 배포하면 빌드 타임에 환경변수가 주입되어야 하므로 Vercel 프로젝트에 등록한다:
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
- [ ] Vite 실행 파일이 존재한다 — macOS: `node_modules/.bin/vite` / Windows: `node_modules\.bin\vite.exe`
- [ ] `bun run dev` 실행 중 콘솔에 에러가 없다
- [ ] 브라우저에서 http://localhost:9000 이 열린다
- [ ] 포트를 하나 등록하고 앱을 껐다 켜도 목록이 남아 있다
- [ ] `bun run typecheck` 가 0 에러 (코드를 수정할 계획이면)

**Supabase (3단계를 했다면)**
- [ ] Table Editor에 현재 `PORTMGR_TABLES`가 있고 모두 RLS enabled다
- [ ] 설정에 URL/anon key/기기 이름이 저장돼 있다
- [ ] `portmgr_allowed_members`에 owner 이메일을 등록했고 `portmgr_is_member()`가 true다
- [ ] Push 후 `portmgr_ports`에 행이 실제로 늘어난다 (0행이면 RLS 거부 여부 확인)
- [ ] 다른 기기에서 Pull하면 목록이 들어온다

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
   Codex의 shell 도구에서 Windows 명령을 돌릴 때는 `powershell -NoProfile -Command "..."` 로 감싼다.
   네트워크가 차단된 샌드박스라면 설치 명령을 직접 돌리지 말고, 사용자가 자기 터미널에서
   실행하도록 명령문을 그대로 제시한 뒤 결과만 검증한다.
9. 사용자가 "다 됐다"고 하면 완료 체크리스트 중 해당 항목만 요약해 마무리한다.
