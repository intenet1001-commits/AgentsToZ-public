# AgentsToZ_byCS 처음 설치 가이드

> 코딩을 몰라도 따라갈 수 있는 첫 단말·추가 단말·AWS 연결 설명서입니다. 최신 웹 버전은 [온라인 설치 설명서](https://agentstoz-guide.vercel.app)에서 볼 수 있습니다.

이 온라인 설명서는 누구나 보는 **공개 설명서 전용 주소**입니다. 내 북마크 포털 주소나 Supabase 연결 정보가 들어가지 않습니다.

![AgentsToZ_byCS 기능 한눈에 보기](../images/agents-toz-overview.png)

## 먼저 알아둘 것

AgentsToZ_byCS는 프로젝트 폴더, 실행 포트, AI 에이전트, 북마크, 프로젝트 장기기억을 한 화면에서 관리합니다. 처음부터 모든 외부 서비스를 설치할 필요는 없습니다.

| 구성 | 쉬운 뜻 | 꼭 필요한가요? |
|---|---|---|
| 로컬 앱 | 내 컴퓨터의 프로젝트를 실행하고 관리 | 공개 소스를 직접 실행할 때 필요 |
| GitHub | 소스 코드 보관·복제·협업 | 소스를 clone할 때 Git은 필요, GitHub CLI는 선택 |
| Supabase | 여러 기기의 설정·북마크·장기기억 동기화 | 한 기기에서 로컬로만 쓰면 불필요 |
| Vercel | 북마크 포털과 이 설명서를 웹 주소로 배포 | 휴대폰·원격 브라우저 접속이 필요할 때만 |
| Claude Code·Codex·Antigravity | 프로젝트를 도와주는 코딩 AI | 선택 |
| Hermes·Telegram | AWS 등 화면 없는 서버에서 AI와 대화 | 선택 |
| Buzz | 에이전트·채널을 만들고 프로젝트와 연결하는 별도 협업 앱 | 선택 |

처음에는 **Bun + Git + 로컬 실행**만 완료해도 됩니다. 설치 현황 대시보드에서 `필수`, `선택`, `확인 필요`를 구분하고, 내 상황에 맞는 AI용 프롬프트를 복사할 수 있습니다. `확인 필요`는 곧바로 “설치 안 됨”이라는 뜻이 아닙니다. 새 터미널을 연 뒤 다시 확인하세요.

## 안전 규칙

- 앱이나 AI가 로그인, 2단계 인증, 프로그램 설치를 요청하면 내용을 확인한 뒤 직접 승인합니다.
- `service_role` 키, GitHub·Vercel 로그인 토큰, Telegram bot token은 채팅·Git 저장소·단말 초대 정보에 넣지 않습니다.
- Supabase RLS는 끄지 않습니다. 웹 포털은 Google OAuth 로그인과 RLS로 보호하고, 데스크톱 앱은 로컬 sidecar가 서버 전용 연결을 맡습니다.
- 추가 PC에 기존 단말 UUID를 복사하지 않습니다. 각 물리 단말은 새 UUID를 가져야 합니다.
- AI에게 비밀값 입력 화면을 넘기지 않습니다. 로그인과 비밀값 입력은 사용자가 하고, 완료된 다음 화면부터 AI가 이어서 돕게 합니다.

## 어떤 경로를 선택할까요?

![현재 초기 설정 마법사](../images/setup-wizard-current.png)

![시나리오별 설치·연결 현황판](../images/onboarding-dashboard.png)

| 지금 상황 | 마법사에서 선택 | 결과 |
|---|---|---|
| 우선 내 컴퓨터에서만 써 보고 싶음 | **로컬로 바로 시작** | 계정 없이 프로젝트 관리 시작 |
| 이 환경을 처음 만들거나 첫 PC를 연결함 | **첫 단말 · 동기화 설정** | 기존 또는 새 Supabase·Vercel 환경 연결 |
| 이미 쓰는 PC가 있고 Mac·Windows 한 대를 더 연결함 | **두 번째·추가 기기 연결** | 기존 클라우드는 재사용하고 새 단말 UUID 생성 |
| Ubuntu·AWS·화면 없는 Linux를 연결함 | **클라우드·서버** | 호스트를 먼저 등록하고 프로젝트를 그 아래 연결 |

“무엇을 설치해야 할지 모르겠다”면 초기 설정의 설치 현황에서 시나리오를 고르고 **AI 안내 프롬프트 복사**를 누르세요. Claude Code, Codex 등 어느 AI에든 붙여넣을 수 있습니다. AI는 현재 OS와 설치 상태를 다시 확인하고, 한 단계가 끝난 뒤 다음 단계로 넘어가야 합니다.

## 1. 로컬에서 5분 안에 시작하기

공개 소스를 직접 실행할 때만 아래 명령이 필요합니다. 이미 설치된 데스크톱 앱을 받은 사용자는 앱을 열고 **로컬로 바로 시작**을 선택하면 됩니다.

### Windows PowerShell

아래 블록 하나를 붙여넣으세요. Windows 기본 PowerShell 5.1에서도 동작합니다. Git 또는 Bun이
없으면 먼저 설치하고 clone 전에 멈춥니다. 안내가 나오면 PowerShell을 닫고 새로 연 뒤 **같은
블록을 다시 붙여넣으세요.** `winget`이 없는 PC에서는 공식 Git 설치 페이지가 열립니다.

```powershell
& {
  $restartRequired = $false

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Start-Process "https://git-scm.com/download/win"
      Write-Host "Git 설치 페이지를 열었습니다. 설치 후 PowerShell을 닫고 새로 연 뒤 이 블록을 다시 실행하세요." -ForegroundColor Yellow
      return
    }
    winget install --id Git.Git --exact --source winget
    if ($LASTEXITCODE -ne 0) { return }
    $restartRequired = $true
  }

  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
    if ($LASTEXITCODE -ne 0) { return }
    $restartRequired = $true
  }

  if ($restartRequired) {
    Write-Host "Git/Bun 설치가 끝났습니다. PowerShell을 닫고 새로 연 뒤 이 블록을 다시 실행하세요." -ForegroundColor Yellow
    return
  }

  git --version
  bun --version
  $devRoot = Join-Path $env:USERPROFILE "dev"
  $projectRoot = Join-Path $devRoot "AgentsToZ_byCS"
  New-Item -ItemType Directory -Path $devRoot -Force | Out-Null
  if (Test-Path (Join-Path $projectRoot ".git")) {
    Write-Host "기존 AgentsToZ_byCS 저장소를 사용합니다."
  } elseif (Test-Path $projectRoot) {
    Write-Host "$projectRoot 폴더가 이미 있지만 Git 저장소가 아닙니다. 폴더 이름을 확인한 뒤 다시 실행하세요." -ForegroundColor Yellow
    return
  } else {
    git clone https://github.com/intenet1001-commits/AgentsToZ-public.git $projectRoot
    if ($LASTEXITCODE -ne 0) { return }
  }

  Set-Location $projectRoot
  bun install
  if ($LASTEXITCODE -ne 0) { return }
  bun run start
}
```

### macOS Terminal

아래 블록은 실제 `git --version`부터 확인합니다. Git이 준비되지 않았으면 Apple 명령줄 도구
설치 창을 열고 clone 전에 멈춥니다. 설치를 마친 뒤 새 Terminal에서 같은 블록을 다시
실행하세요. Bun을 새로 설치한 경우에도 새 Terminal에서 한 번 더 실행합니다.

```bash
(
  if ! git --version >/dev/null 2>&1; then
    xcode-select --install 2>/dev/null || true
    echo "Apple 명령줄 도구 설치 창에서 설치를 마친 뒤 새 Terminal에서 이 블록을 다시 실행하세요."
    exit 0
  fi

  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    echo "Bun 설치가 끝났습니다. 새 Terminal을 열고 이 블록을 다시 실행하세요."
    exit 0
  fi

  git --version
  bun --version
  dev_root="$HOME/dev"
  project_root="$dev_root/AgentsToZ_byCS"
  mkdir -p "$dev_root"
  if [ -d "$project_root/.git" ]; then
    echo "기존 AgentsToZ_byCS 저장소를 사용합니다."
  elif [ -e "$project_root" ]; then
    echo "$project_root 폴더가 이미 있지만 Git 저장소가 아닙니다. 폴더 이름을 확인한 뒤 다시 실행하세요."
    exit 0
  else
    git clone https://github.com/intenet1001-commits/AgentsToZ-public.git "$project_root" || exit 1
  fi

  cd "$project_root" || exit 1
  bun install || exit 1
  bun run start
)
```

브라우저에서 <http://localhost:9000>을 엽니다. Windows는 `실행.bat`, macOS는 `./실행.command`로도 시작할 수 있습니다.

프로젝트는 실행 파일이 없어도 등록할 수 있습니다. 폴더를 추가하면 앱이 `package.json`, `pyproject.toml`, `Cargo.toml`을 찾아 시작 명령을 제안합니다.

## 2. 첫 단말에 동기화 환경 연결하기

첫 단말이라고 해서 GitHub·Supabase·Vercel 프로젝트를 무조건 새로 만들 필요는 없습니다.

1. 초기 설정에서 **첫 단말 · 동기화 설정**을 엽니다.
2. 설치 현황에서 Bun, Git, 프로젝트 의존성이 준비됐는지 확인합니다.
3. Supabase 프로젝트가 있으면 기존 Project URL과 anon/publishable key를 사용합니다. 없을 때만 새 프로젝트를 만듭니다.
4. 이 PC에서 `supabase login`을 완료하고 마법사의 자동 연결을 진행합니다. 서버 전용 키는 이 PC의 앱 데이터에만 저장합니다.
5. 웹 포털이 필요하면 기존 Vercel 프로젝트를 연결합니다. 기존 프로젝트가 없을 때만 새로 배포합니다.
6. 배포 포털에서는 Google 로그인 후 허용된 계정인지 확인합니다.
7. GitHub 자동 재배포나 Private 장기기억 보관이 필요할 때만 GitHub CLI 로그인을 추가합니다.

앱의 자동 배포가 끝나면 검증된 개인 `*.vercel.app` 주소를 이 PC의 `portal.json`에 저장합니다. 이후 앱의 **포털 열기**와 **새 단말 등록 링크**는 그 주소를 사용합니다. 공개 README나 소스 파일에 개인 주소를 적지 마세요. 사용자 지정 도메인의 localhost 장기기억 연동은 운영자가 `PORTMGR_PORTAL_INTEGRATION_ORIGINS`에 별도로 허용할 때만 켜집니다.

본인 Supabase와 본인 Vercel로 처음부터 분리해 배포하는 화면별 순서는 [내 계정으로 개인 포털 만들기](../SELF-HOSTING.md)를 보세요.

`VITE_ALLOWED_EMAIL`은 로그인 화면에서 빠르게 안내하기 위한 클라이언트/UI 사전 필터일 뿐입니다. 실제 접근 허용 목록의 정본은 Supabase의 `public.portmgr_allowed_members`이며, RLS가 이 목록을 서버에서 강제합니다. 두 설정을 함께 확인하고 UI 값만으로 보안이 끝났다고 판단하지 마세요.

Supabase의 공개 anon/publishable key는 프런트엔드 연결에 쓰이지만, 이것만으로 데이터를 읽게 두면 안 됩니다. 정본 마이그레이션이 anon 접근을 회수하고 authenticated 사용자에게만 권한을 주는지 확인해야 합니다. `401`, `403`, `PGRST301` 오류가 난다고 RLS를 끄지 마세요.

## 3. 두 번째 Mac·Windows 연결하기

핵심은 **기존 클라우드를 재사용하되 단말 신원은 새로 만드는 것**입니다.

### 기존 PC에서

1. 앱의 초기 설정에서 **다른 PC 연결 정보 만들기**를 엽니다.
2. 새 PC를 알아볼 수 있는 이름을 입력합니다.
3. v3 연결 정보를 복사합니다. 개인 Vercel 포털을 쓰는 경우 **단말 연결 → Mac·Windows 연결**에서도 만들 수 있습니다.

연결 정보에는 다음 공개 연결값만 들어갑니다.

- Supabase Project URL
- anon/publishable key
- 추천 단말 이름

기존 단말 UUID, `service_role` 키, Supabase 로그인 토큰은 들어가지 않습니다.

### 새 PC에서

1. 같은 GitHub 저장소를 새 PC의 안전한 폴더에 clone하고 앱을 실행합니다.
2. **두 번째·추가 기기 연결**을 열어 v3 연결 정보를 붙여넣습니다.
3. 이 PC에서 직접 `supabase login`을 하고 자동 연결을 완료합니다.
4. 앱이 만든 **새 UUID**로 등록이 끝났는지 확인합니다.
5. 동기화 후 프로젝트별 로컬 폴더 경로를 이 PC의 실제 위치로 다시 지정합니다.
6. 기존 Vercel 포털 주소를 그대로 북마크합니다. 두 번째 PC 때문에 새 포털을 배포할 필요는 없습니다.

재설치한 같은 물리 단말의 과거 기록을 연결하는 작업은 “추가 단말”과 다릅니다. 이 경우 장기기억 화면의 **이전 ID 연결**을 사용하며, 새 PC에 과거 UUID를 수동 입력하지 않습니다.

## 4. Ubuntu·AWS·화면 없는 Linux 연결하기

AWS는 데스크톱 앱 초대와 다른 흐름입니다. 서버 한 대가 여러 프로젝트를 가질 수 있으므로 **호스트를 먼저 등록**합니다.

1. 배포 포털의 **단말 연결 → 클라우드·서버** 또는 앱의 **장기기억 → 클라우드 단말**을 엽니다.
2. 호스트 이름과 환경을 고르고 일회용 등록 명령을 만듭니다.
3. 10분·1시간·24시간 중 고른 유효 시간 안에 AWS/Linux 터미널에 명령을 붙여넣습니다. 이 시간은 초대의 만료 시간이며, 등록 뒤 연결이 끊기는 시간이 아닙니다.
4. 호스트 카드가 먼저 생겼는지 확인합니다.
5. 호스트 카드의 **런타임 준비**에서 Bun과 AgentsToZ API를 확인합니다. API가 준비되지 않았으면 **아무 AI에나 붙여넣을 준비 프롬프트 복사**로 한 단계씩 진행합니다. Hermes·Telegram은 선택입니다.
6. API 준비가 확인된 뒤 그 호스트 아래에서 **새 프로젝트**, **GitHub 복제**, **장기기억 복원** 중 필요한 작업을 선택합니다.
7. `agentstoz-status`로 마지막 보고 시각과 Git 상태를 확인합니다.

등록 명령에는 공개 anon key만 포함되며 `service_role` 키는 포함되지 않습니다. credential은 일회용 claim 응답으로만 서버에 전달됩니다. AWS에 데스크톱 앱이나 Vercel을 다시 설치할 필요는 없습니다. GitHub 저장소가 필요할 때만 서버에서 clone하고, Hermes·Telegram은 원격 대화가 필요할 때 추가합니다.

## 5. 선택 기능 연결하기

다음 도구는 AgentsToZ_byCS에 묶여 설치되는 구성요소가 아니라 각각 별도의 앱 또는 서비스입니다. 설치 현황에서 사용할 기능만 선택하세요.

| 기능 | 언제 필요한가요? | 설치·로그인 위치 |
|---|---|---|
| Claude Code | AI 이름 추천, 프로젝트 작업, 장기기억 저장 | 사용할 각 Mac·Windows·서버 |
| Codex | 프로젝트 작업과 Codex용 장기기억 명령 | 사용할 각 Mac·Windows·서버 |
| Antigravity CLI (`agy`) | Antigravity 에이전트 실행 버튼 | 사용할 각 단말 |
| Hermes | AWS/서버에서 원격 에이전트와 장기기억 명령 사용 | 해당 서버. 설치 후 Telegram에서 `/reload_skills` 실행 |
| Telegram | 휴대폰에서 Hermes와 대화 | BotFather로 봇 생성 후 Hermes 서버에만 token 저장 |
| Buzz | Buzz 에이전트·채널을 AgentsToZ 프로젝트와 연결 | 사용하는 데스크톱에 Buzz 앱 별도 설치 후 로그인·채널 준비 |
| GitHub CLI (`gh`) | Actions 빌드, 저장소 생성, Private 장기기억 보관 | GitHub 작업을 할 단말 |
| Vercel CLI | 개인 포털 첫 배포·환경 변수 관리 | 보통 첫 단말 한 곳이면 충분 |

![AI 사용량과 에이전트 상태 패널](../images/ai-usage-panel.png)

Telegram bot token과 각 서비스 로그인은 연결 초대에 넣지 않습니다. Buzz 설치, Hermes bot 연결, Telegram 설정은 서로 독립적이므로 한 번에 전부 설치하지 말고 실제 사용할 조합만 완료하세요.

## 6. Windows 업데이트와 빌드

### 일반 사용자

배포자가 실제 Windows에서 확인한 최신 NSIS `.exe`를 받아 기존 앱 위에 설치하는 방법이 가장 쉽습니다. 앱의 **Windows 빌드·출시 안내** 버튼을 누른 것만으로 설치된 바이너리가 자동 교체되지는 않습니다.

### 소스를 수정하는 유지보수자

**Windows 빌드·출시 안내**는 현재 저장소를 갱신하고 검증한 뒤 설치본을 만들도록 AI에 전달할 유지보수 프롬프트를 복사하는 기능입니다. 실제 자동 업데이트 기능이 아닙니다. Windows 릴리스는 실제 Windows PC에서 빌드하는 것을 권장합니다.

```powershell
bun run verify
bun run tauri:build:win
```

결과물은 다음 위치에 생깁니다.

```text
%USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe
```

실제 Windows에서는 설치, 앱 실행, sidecar IPC, 포트 감지·중지, WebView2 화면, 기존 버전 위 설치를 확인할 수 있습니다. GitHub Actions의 **GitHub Windows 빌드**는 로컬 Rust·Build Tools 없이 아티팩트를 만들 때 유용하지만, 클라우드 빌드 성공만으로 실기 설치 검증을 대신할 수는 없습니다.

프로젝트를 `C:\Windows\System32` 아래에 clone하지 마세요. 권장 위치는 `C:\Users\<이름>\dev\AgentsToZ_byCS`입니다.

## 7. 앱의 세 화면 사용하기

| 화면 | 하는 일 |
|---|---|
| **프로젝트·폴더** | 프로젝트 등록, 실행·중지·강제 재실행, 로그, 에이전트, 워크트리 관리 |
| **북마크** | URL을 카테고리와 고정 상태로 관리하고 기기 간 공유 |
| **장기기억** | 프로젝트별 기억 상태, 동기화, 복원, 단말·클라우드 호스트 관리 |

![북마크 화면](../images/portal.png)

프로젝트 카드의 삭제는 목록에서 항목을 제거하는 작업이며 프로젝트 폴더 자체를 삭제하지 않습니다. 장기기억의 원본은 프로젝트 안의 `.agent-memory/`입니다. Supabase와 Private GitHub 보관은 복구 사본이고, 백업 실패가 로컬 기억을 되돌리면 안 됩니다.

## 문제 해결

| 증상 | 먼저 할 일 |
|---|---|
| `bun` 또는 `git` 명령을 찾지 못함 | 설치 뒤 터미널을 완전히 닫고 새로 열어 버전 확인 |
| `node_modules`가 없음 | 저장소 루트에서 `bun install` 실행 |
| 3001 또는 9000 포트가 이미 사용 중 | 실행 중인 이전 AgentsToZ_byCS를 종료한 뒤 다시 시작 |
| 추가 PC가 기존 PC와 같은 단말로 보임 | 기존 UUID를 복사하지 말고 v3 연결 정보로 새 UUID 등록 |
| Supabase에서 `401`·`403`·`PGRST301` 발생 | RLS를 끄지 말고 웹은 Google 세션, 앱은 로컬 service-role 연결 상태 확인 |
| 추가 PC에서 프로젝트 폴더가 열리지 않음 | 동기화 후 그 PC의 실제 로컬 경로로 다시 지정 |
| Windows `link.exe not found` | Visual Studio Build Tools 2022의 C++ 워크로드 설치 |
| Windows 설치 앱이 빈 화면 | Windows 10이라면 WebView2 Runtime 설치 여부 확인 |
| AWS 호스트가 보이지 않음 | 초대 만료 여부와 `agentstoz-status` 결과 확인 후 새 일회용 명령 생성 |
| Hermes 명령이 안 보임 | 해당 서버에 Hermes 스킬을 설치하고 Telegram에서 `/reload_skills` 직접 실행 |

## 설치 완료 기준

- 로컬 앱이 열리고 프로젝트 폴더 하나를 등록할 수 있다.
- 첫 단말은 Supabase 연결과 단말 등록이 확인된다.
- 추가 Mac·Windows는 기존 단말과 다른 UUID로 보인다.
- AWS는 호스트가 먼저 보이고 프로젝트가 그 아래 나타난다.
- 웹 포털은 Google 로그인 뒤 허용 계정만 접근한다.
- 사용하지 않는 Buzz·Hermes·Telegram·Antigravity를 억지로 설치하지 않았다.
- Windows 설치본은 실제 Windows에서 설치와 실행을 확인했다.

더 자세한 기술 계약과 API는 저장소의 [AGENTS.md](../../AGENTS.md), 운영 검증 절차는 [온보딩 E2E 검증 가이드](../onboarding-audit.md)를 참고하세요.
