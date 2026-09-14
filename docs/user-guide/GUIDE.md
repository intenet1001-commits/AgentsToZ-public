# AgentsToZ_byCS 처음 설치 가이드

> 코딩을 몰라도 따라갈 수 있는 첫 단말·추가 단말·AWS 연결 설명서입니다. 최신 웹 버전은 [온라인 설치 설명서](https://agentstoz-guide.vercel.app)에서 볼 수 있습니다.

## 여러 프로젝트를 위한 관제센터

Codex Voice나 텍스트 대화에서 “AgentsToZ, 관제센터 만들어”라고 말하면 AgentsToZ MCP가 작업 루트를 확인하고 `AgentsToZ-Control` 폴더, Git 초기 이력, 장기기억, 관제 문서를 함께 준비합니다. 데스크톱 앱의 **도구 및 설정 → Control 바로 열기**로 이 프로젝트를 바로 열 수 있습니다.

공개판을 처음 시작하면 초기 설정에 **내 Control 자동 만들기**가 권장 작업으로 표시됩니다. 작업 루트가 하나면 즉시 만들고, 없거나 여러 개면 생성 위치만 확인합니다. 기존 사용자는 **다른 Mac의 Control 복원**을 눌러 자신의 Private GitHub 저장소를 clone합니다.

다른 Mac에서는 관제센터의 별도 GitHub 저장소를 **새 프로젝트 → GitHub 주소**로 clone하고 장기기억과 Supabase 백업을 켭니다. clone 뒤에는 기존 `memoryId`를 보존한 채 원격 기억을 먼저 Pull합니다. GitHub 저장소는 문서와 이력을 옮기고 Supabase는 기억 리비전을 옮기므로 둘 다 연결되어야 완전한 관제 문맥을 이어갈 수 있습니다.

이 온라인 설명서는 누구나 보는 **공개 설명서 전용 주소**입니다. 내 북마크 포털 주소나 Supabase 연결 정보가 들어가지 않습니다.

![AgentsToZ_byCS 기능 한눈에 보기](../images/agents-toz-overview.png)

## 먼저 알아둘 것

AgentsToZ_byCS는 프로젝트 폴더, 실행 포트, AI 에이전트, 북마크, 프로젝트 장기기억을 한 화면에서 관리합니다. 처음부터 모든 외부 서비스를 설치할 필요는 없습니다.

| 구성 | 쉬운 뜻 | 꼭 필요한가요? |
|---|---|---|
| AgentsToZ 로컬 화면 | 내 컴퓨터의 프로젝트를 실행하고 관리하는 기본 제품 | Windows는 설치 파일, macOS 공개 사용자는 현재 소스 웹 모드로 시작 |
| GitHub | 소스 코드 보관·복제·협업 | Windows 설치 파일에는 불필요. macOS 공개 소스 실행에는 Git만 필요하며 GitHub 계정은 불필요 |
| Supabase | 여러 기기의 설정·북마크·장기기억 동기화 | 한 기기에서 로컬로만 쓰면 불필요 |
| Vercel 개인 웹 포털 | 내 전용 웹 주소를 만들어 휴대폰·다른 브라우저에서 보기 | 선택 기능. 데스크톱 앱 설치가 아님 |
| Claude Code·Codex·Antigravity | 프로젝트를 도와주는 코딩 AI | 선택 |
| Hermes·Telegram | AWS 등 화면 없는 서버에서 AI와 대화 | 선택 |
| Buzz | 에이전트·채널을 만들고 프로젝트와 연결하는 별도 협업 앱 | 선택 |

Windows 설치 파일로 시작할 때는 Bun·Git·GitHub clone이 필요 없습니다. macOS에서 공개 소스를 직접 실행할 때만 Git 준비 → Bun 준비 → 공개 저장소 clone → 의존성 설치 순서가 필요합니다. 설치·연결 현황판은 모든 신규 사용자의 사전 체크리스트가 아니라, 설치 앱/소스 실행을 구분하고 동기화·서버 연결을 구성할 때 보는 상세 도구 목록입니다.

## 안전 규칙

- 앱이나 AI가 로그인, 2단계 인증, 프로그램 설치를 요청하면 내용을 확인한 뒤 직접 승인합니다.
- `service_role` 키, GitHub·Vercel 로그인 토큰, Telegram bot token은 채팅·Git 저장소·단말 초대 정보에 넣지 않습니다.
- Supabase RLS는 끄지 않습니다. 웹 포털은 Google OAuth 로그인과 RLS로 보호하고, 데스크톱 앱은 로컬 sidecar가 서버 전용 연결을 맡습니다.
- 추가 PC에 기존 단말 UUID를 복사하지 않습니다. 각 물리 단말은 새 UUID를 가져야 합니다.
- AI에게 비밀값 입력 화면을 넘기지 않습니다. 로그인과 비밀값 입력은 사용자가 하고, 완료된 다음 화면부터 AI가 이어서 돕게 합니다.

## 어떤 경로를 선택할까요?

아직 GitHub 가입이나 clone을 하지 않았어도 괜찮습니다.

| 처음 원하는 결과 | 시작 방법 | 먼저 필요하지 않은 것 |
|---|---|---|
| Windows에서 앱 열기 | 공식 릴리스의 `x64-setup.exe` 설치 → **로컬로 바로 시작** | GitHub 계정, Git, Bun, clone, Supabase, Vercel |
| macOS에서 먼저 체험 | Terminal 명령으로 Git·Bun 확인 → 공개 소스 clone → `bun run start` | GitHub 계정, Supabase, Vercel. 이 경로는 DMG 설치가 아니라 로컬 웹 모드 |
| 휴대폰용 내 웹 주소 만들기 | 로컬 사용과 별도로 개인 웹 포털 과정 진행 | 데스크톱 앱 설치를 대신하지 않음 |

![현재 초기 설정 마법사](../images/setup-wizard-current.png)

![시나리오별 설치·연결 현황판](../images/onboarding-dashboard.png)

| 지금 상황 | 마법사에서 선택 | 결과 |
|---|---|---|
| 우선 내 컴퓨터에서만 써 보고 싶음 | **로컬로 바로 시작** | 계정 없이 프로젝트 관리 시작 |
| 이미 등록한 Mac·Windows에서 앱을 업데이트함 | **기존 환경 이어쓰기** | 기존 단말 ID·프로젝트·기억을 유지하고 현재 연결 상태 확인 |
| 이 환경을 처음 만들거나 첫 PC를 연결함 | **첫 단말 · 동기화 설정** | 기존 또는 새 Supabase 동기화 연결. Vercel은 개인 웹 포털이 필요할 때만 선택 |
| 이미 쓰는 PC가 있고 Mac·Windows 한 대를 더 연결함 | **두 번째·추가 기기 연결** | 기존 클라우드는 재사용하고 새 단말 UUID 생성 |
| Ubuntu·AWS·화면 없는 Linux를 연결함 | **클라우드·서버** | 호스트를 먼저 등록하고 프로젝트를 그 아래 연결 |

“무엇을 설치해야 할지 모르겠다”면 초기 설정의 **설치·연결 현황판**에서 `설치된 앱` 또는 `소스 직접 실행`을 먼저 고른 뒤 **AI 안내 프롬프트 복사**를 누르세요. Claude Code, Codex 등 어느 AI에든 붙여넣을 수 있습니다. AI는 현재 OS와 설치 상태를 다시 확인하고, 한 단계가 끝난 뒤 다음 단계로 넘어가야 합니다.

이미 등록한 단말에서는 **기존 환경 이어쓰기 → 이 설정으로 앱 열기**를 사용하세요. 현재 서버 응답, 로컬 연결 정보의 저장 여부, 마지막 동기화 기록을 구분해 표시합니다. 기록이 있어도 현재 연결이 끊겼을 수 있으므로 문제가 있으면 **현재 연결 점검**을 엽니다. 상태 확인 실패를 처음 설치한 상태로 취급하지 않으며, **다시 확인**으로 재시도할 수 있습니다. 진행 중인 추가 단말 등록은 같은 ID로 이어갑니다.

## AI 복붙으로 모든 과정 진행하기

온라인 설명서의 각 과정에는 **Windows용 프롬프트 복사**, **macOS용 프롬프트 복사** 또는 해당 과정의 **AI 프롬프트 복사** 버튼이 있습니다.

1. 지금 하려는 과정으로 이동합니다.
2. 내 PC에 맞는 복사 버튼을 누릅니다.
3. Claude·Codex 등 사용하는 AI의 **새 대화**에 붙여넣습니다.
4. AI가 알려주는 다음 행동 하나만 실행하고, 완료 화면이나 오류 문구를 AI에게 알려줍니다.
5. 로그인·비밀번호·토큰 입력 화면에서는 AI가 멈추며, 값은 사용자가 직접 입력합니다.

복사 버튼을 쓸 수 없는 환경에서는 아래 프롬프트 전체를 복사해 새 대화에 그대로 붙여넣으세요.

```text
AgentsToZ_byCS 설치·연결을 컴퓨터 설정에 익숙하지 않은 사람과 진행해줘.

먼저 내 OS와 현재 화면·설치 상태를 읽기 전용으로 확인하고, 지금 필요한 과정부터 판정해줘:
- 한 PC에서 계정 없이 로컬로 시작
- 첫 단말 Supabase 동기화
- 두 번째 Mac·Windows 연결
- AWS·Ubuntu 호스트 연결
- Vercel 개인 웹 포털
- Windows 앱 설치·업데이트

진행 규칙:
1. 설명을 한꺼번에 하지 말고 다음 행동은 반드시 하나만 알려줘.
2. 내가 결과를 보내면 성공 증거를 확인한 뒤에만 다음 단계로 넘어가.
3. 버튼을 눌러야 하면 현재 화면에 보이는 정확한 메뉴 이름을 알려줘. 화면이 다르면 추측하지 말고 현재 문구를 물어봐.
4. 설치·로그인·권한 변경·계정 생성·클라우드 리소스 생성·배포 직전에는 무엇이 바뀌는지 한 문장으로 말하고 내 확인을 받아.
5. 비밀번호·토큰·secret 입력은 내가 직접 하게 멈춰. 그 값을 읽거나 채팅·로그·스크린샷에 남기지 마.
6. 각 단계가 끝날 때 실제 성공 증거와 다음 행동 하나만 보고해줘.

정본 설명서: https://agentstoz-guide.vercel.app
```

## 1. 로컬에서 5분 안에 시작하기

Windows 일반 사용자는 먼저 [공식 최신 릴리스](https://github.com/intenet1001-commits/AgentsToZ-public/releases/latest)의 `x64-setup.exe`를 설치하고 앱에서 **로컬로 바로 시작**을 선택하세요. 아래 명령은 Windows에서 설치 파일 대신 소스를 직접 실행하거나, macOS에서 현재 공개 소스 웹 모드를 실행할 때만 필요합니다.

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
2. **설치·연결 현황판**에서 실행 형태를 확인합니다. 설치된 앱이면 Bun·Git·`node_modules`를 요구하지 않고 내장 로컬 API 상태만 확인합니다. 공개 소스를 직접 실행할 때만 Bun·Git·프로젝트 의존성을 확인합니다.
3. Supabase 프로젝트가 있으면 기존 Project URL과 anon/publishable key를 사용합니다. 없을 때만 새 프로젝트를 만듭니다.
4. 이 PC에서 `supabase login`을 완료하고 마법사의 자동 연결을 진행합니다. 서버 전용 키는 이 PC의 앱 데이터에만 저장합니다.
5. 웹 포털이 필요하면 기존 Vercel 프로젝트를 연결합니다. 기존 프로젝트가 없을 때만 새로 배포합니다.
6. 배포 포털에서는 Google 로그인 후 허용된 계정인지 확인합니다.
7. GitHub 자동 재배포나 Private 장기기억 보관이 필요할 때만 GitHub CLI 로그인을 추가합니다.

앱의 자동 배포가 끝나면 검증된 개인 `*.vercel.app` 주소를 이 PC의 `portal.json`에 저장합니다. 이후 앱의 **포털 열기**와 **새 단말 등록 링크**는 그 주소를 사용합니다. 공개 README나 소스 파일에 개인 주소를 적지 마세요. 사용자 지정 도메인의 localhost 장기기억 연동은 운영자가 `PORTMGR_PORTAL_INTEGRATION_ORIGINS`에 별도로 허용할 때만 켜집니다.

본인 Supabase와 본인 Vercel로 처음부터 분리해 배포하는 화면별 순서는 [내 계정으로 개인 포털 만들기](../SELF-HOSTING.md)를 보세요.

실제 접근 허용 목록의 단일 정본은 Supabase의 `public.portmgr_allowed_members`입니다. 포털은 Google 로그인 뒤 `portmgr_is_member()`로 이를 확인하고 RLS가 같은 목록을 서버에서 강제합니다. build-time 이메일 목록이나 브라우저 캐시는 회원 판정에 사용하지 않습니다.

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

## 5. 선택 기능: 내 개인 웹 포털 만들기

이 과정의 결과는 **내 Vercel 계정에 생기는 휴대폰·브라우저용 웹 주소**입니다. 데스크톱 앱을 설치하거나 내 PC에 GitHub 저장소를 clone하지 않습니다. 한 PC의 로컬 화면만 쓴다면 건너뛰세요.

**Vercel에 내 개인 포털 프로젝트 만들기** 버튼은 다음 일을 합니다.

- Vercel 계정이 없으면 가입·로그인 단계로 안내합니다.
- 연결한 GitHub·GitLab·Bitbucket 계정에 AgentsToZ 공개 소스 사본을 만듭니다.
- 본인 Vercel 계정에 새 프로젝트와 `https://<내-프로젝트>.vercel.app` 주소를 만듭니다.
- Supabase 값·이메일·토큰을 버튼 URL로 전송하지 않습니다.

완료하려면 본인 소유의 Git 제공자·Vercel·Supabase·Google 계정이 필요합니다. 먼저 Supabase 정본 SQL·허용 이메일·Google OAuth를 준비한 뒤, Vercel 프로젝트에는 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`만 저장해 Production 배포합니다. 마지막으로 발급된 Vercel 주소를 Supabase **Redirect URLs**에 추가하고 실제 Google 로그인과 `portmgr_is_member()` 허용을 확인합니다.

설치된 앱에서 자동 배포하면 발급된 Vercel 주소가 앱에도 자동 저장됩니다. `service_role`과 Google Client Secret은 Vercel 환경 변수나 URL에 넣지 않습니다. 정확한 화면 이름과 성공 근거는 [내 계정으로 개인 포털 만들기](../SELF-HOSTING.md)를 따릅니다.

## 6. 그 밖의 선택 기능 연결하기

다음 도구는 AgentsToZ_byCS에 묶여 설치되는 구성요소가 아니라 각각 별도의 앱 또는 서비스입니다. 설치·연결 현황판에서 사용할 기능만 선택하세요.

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

## 7. Windows 업데이트와 빌드

### 일반 사용자

다음 순서만 그대로 따라갑니다.

1. 실행 중인 AgentsToZ 앱을 완전히 종료하고 5초 기다립니다. 처음 설치라면 건너뜁니다.
2. [공식 최신 Windows 릴리스](https://github.com/intenet1001-commits/AgentsToZ-public/releases/latest)를 엽니다.
3. 페이지 아래 **Assets**를 펼치고 `AgentsToZ_byCS_<버전>_x64-setup.exe`를 누릅니다.
4. 다운로드 폴더에서 `.exe`를 두 번 누릅니다.
5. Windows 보호 화면이 나오면 주소와 파일명이 위 안내와 일치하는지 확인한 뒤에만 **추가 정보 → 실행**을 누릅니다.
6. 설치를 끝내고 AgentsToZ_byCS를 엽니다. 처음이면 **로컬로 바로 시작**을 선택합니다. 업데이트라면 기존 프로젝트 카드가 남아 있는지 확인합니다.

한 PC에서 로컬로만 쓸 때 Supabase·GitHub CLI·Vercel 계정은 필요하지 않습니다. 앱의 **Windows 빌드·출시 안내** 버튼을 누른 것만으로 설치된 바이너리가 자동 교체되지는 않습니다.

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

## 8. 앱의 세 화면 사용하기

| 화면 | 하는 일 |
|---|---|
| **프로젝트·폴더** | 프로젝트 등록, 실행·중지·강제 재실행, 로그, 에이전트, 워크트리 관리 |
| **북마크** | URL을 카테고리와 고정 상태로 관리하고 기기 간 공유 |
| **장기기억** | 프로젝트별 기억 상태, 동기화, 복원, 단말·클라우드 호스트 관리 |

![북마크 화면](../images/portal.png)

프로젝트 카드의 삭제는 목록에서 항목을 제거하는 작업이며 프로젝트 폴더 자체를 삭제하지 않습니다. 장기기억의 원본은 프로젝트 안의 `.agent-memory/`입니다. Supabase와 Private GitHub 보관은 복구 사본이고, 백업 실패가 로컬 기억을 되돌리면 안 됩니다.

## 9. QR로 이 Mac 원격제어

휴대폰이나 iPad에서 Mac 앞과 같은 프로젝트 작업을 이어 할 수 있습니다. 같은 개인 Wi‑Fi와 외부 인터넷은 연결 방식이 다릅니다.

### 같은 Wi‑Fi에서 연결

1. Mac 앱의 **더보기 → QR 원격제어 · 이 Mac**을 엽니다.
2. 집·사무실의 신뢰할 수 있는 개인 Wi‑Fi인지 확인하고, 표시된 사설 IPv4 하나를 선택해 **원격제어 켜기**를 누릅니다.
3. 30일 동안 한 번만 유효한 QR을 카메라로 엽니다. LAN은 같은 기기의 저장된 연결로 최대 30일 안에 재접속하며, 앱·로컬 API 재시작 뒤에도 검증된 연결 기록을 복원합니다. 연결 해제·만료·저장소 초기화에는 새 QR이 필요합니다. LAN 주소 변경의 자동 탐색은 아직 지원하지 않습니다. 이 HTTP QR은 공용 Wi‑Fi, 포트 포워딩, 인터넷 공유에 사용하지 마세요.

### Wi‑Fi 밖에서 개인 포털로 연결

1. Mac 앱의 **더보기 → 외부 인터넷 QR 원격제어 · 베타**를 열고 본인의 HTTPS 개인 포털 주소를 확인합니다.
2. **외부 인터넷 원격제어 켜고 QR 발급**을 누릅니다.
3. 휴대폰 홈 화면에 추가한 개인 포털에서 상단의 **원격제어 QR 스캔**을 누릅니다. 실시간 카메라가 제한되면 **카메라 촬영·QR 사진으로 열기**를 사용합니다.
4. Google 로그인 뒤 휴대폰과 Mac에 표시된 6자리 코드가 정확히 같을 때만 Mac에서 승인합니다. QR 스캔만으로 제어 권한이 열리지는 않습니다.
5. 외부 QR도 30일 동안 한 번만 유효하고, 스캔 후 승인 대기는 최대 24시간, 승인된 연결은 최초 승인 시점부터 최대 30일 유지됩니다. Mac의 외부 host identity·pairing secret·세션 cursor는 계정 전용 앱 데이터의 권한 0600 vault에 저장되어 재시작 뒤 복원을 시도하며, 외부 원격제어 끄기나 기기 연결 해제 시 폐기됩니다. 늦은 QR 승인에도 전체 기간을 보장하기 위해 암호화 릴레이의 내부 호스트 행만 최대 62일 유지됩니다.

### 연결 뒤 할 수 있는 일

- 프로젝트와 자동 발견된 연결 워크트리를 별도 카드로 보고 실행·중지·재실행합니다.
- 선택한 프로젝트·워크트리를 Orca 사이드바의 Claude/Codex/AGY/Hermes로 열거나 Codex/Claude/Hermes 앱으로 엽니다.
- 새 프로젝트를 Claude 앱에서 처음 이어갈 때는 **첫 Claude Code 대화 시작·열기** 하나만 누릅니다. Mac의 해당 프로젝트 폴더에서 Claude Code 공식 Remote Control 단일 세션이 시작되고, `기기명 · 프로젝트명`으로 Claude 모바일 앱의 Code 목록에 표시되며 Mac의 Claude 앱도 그 정확한 세션을 엽니다. 사용자가 첫 메시지를 보내기 전에는 Claude가 파일이나 명령을 실행하지 않습니다. **기존 Claude 프로젝트 열기**는 선행 단계가 아닙니다.
- 아직 Codex 대화가 하나도 없을 때는 **첫 Codex 대화 생성·열기** 하나만 누릅니다. Mac의 Codex App Server가 고정된 안전 안내문과 짧은 응답을 영구 대화로 저장한 뒤 그 정확한 대화를 앱에서 자동으로 엽니다. **기존 Codex 프로젝트 열기**를 먼저 또는 이어서 누를 필요가 없습니다. 휴대폰에서 임의 프롬프트·경로·명령을 전달하지 않으며, 이미 대화가 있는 프로젝트만 **기존 Codex 프로젝트 열기**를 사용합니다.
- 등록 작업 루트에 새 프로젝트를 만들고, Commit·fast-forward Pull·Push·안전검사 Merge를 실행합니다. **AgentsToZ 워크트리**는 앱과 같은 표준 `worktrees/` Git 작업 공간을 만들고, **Orca 워크트리**는 Orca 사이드바에도 등록합니다. 두 방식 모두 다음 목록 갱신에서 별도 워크트리 카드로 자동 인식됩니다.
- Merge는 양쪽 worktree가 깨끗하고 기능 브랜치가 먼저 Push됐으며 원격 기본 브랜치가 확인되고 충돌 사전검사를 통과할 때만 실행됩니다. Merge 뒤에는 기본 프로젝트 카드에서 **Push**를 별도로 눌러야 GitHub에 반영됩니다. 워크트리 삭제는 원격에서 제공하지 않습니다.

휴대폰에는 연결에 필요한 일회용 pairing secret·암호화 세션 토큰과 세션용 임시 ID·표시 정보·허용 버튼만 전달됩니다. 실제 내부 ID·로컬 경로·실행 명령·PID·환경값·로컬 저장 credential·service_role·Git/API 로그인 토큰·장기기억·What I Said는 표시하거나 전달하지 않습니다. 작업을 마치면 Mac에서 해당 기기 연결을 해제하거나 원격제어 전체를 끄세요. 앱과 포털의 원격 프로토콜이 업데이트된 뒤에는 이전 연결을 재사용하지 말고 새 QR을 발급합니다.

QR 원격제어는 What I Said 읽기 전용 피드와 주소·인증·권한이 완전히 별개이므로, 원격제어 QR을 외부 앱의 What I Said 소스 주소로 사용할 수 없습니다.

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
