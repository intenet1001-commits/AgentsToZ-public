# 프로젝트 CLI 복수 계정

CLI 설치와 계정 프로필은 별개다. 한 실행 파일을 재사용하면서 GitHub·Vercel·Supabase·Google Workspace의 인증과 프로젝트 대상을 분리한다. Codex·Claude·Hermes·agy의 AI 로그인 계정은 기존 `cliAccount*` 계약을 유지한다.

GitHub의 같은 사용자명이 앱 연결 계정과 기존 CLI 로그인에 모두 있으면 계정 선택 목록에는 한 번만 표시한다. 연결 계정 1개라면 ‘기기 기본값 따르기’와 해당 계정이 표시되며 같은 계정의 ‘기존 로그인’ 행은 중복 표시하지 않는다. 기존 프로젝트가 CLI 로그인을 직접 지정했다면 해당 선택 ID를 보존하며 인증 소스를 자동 전환하지 않는다. 서로 다른 GitHub 로그인은 별도 계정이다.

## 처음 설치한 기기에서

`내 기기와 연결` 또는 `앱 설정 → CLI 계정 관리`에서 네 서비스의 설치 여부와 이메일 확인을 마친 연결 계정 수를 각각 확인한다. 설치 여부 확인은 인증을 읽거나 새 계정을 등록하지 않는다. 필요한 CLI만 공식 안내나 현재 상태를 담은 AI 인계문으로 설치하고 `설치 상태 다시 확인`을 누른다. 자동 설치를 제공하는 기존 Codex·Claude·GitHub 설치 카드와 별개로, Vercel·Supabase·gws 설치는 공식 안내/로컬 작업이 가능한 AI의 도움을 사용한다. 인계문 복사는 설치 완료가 아니다.

설치된 서비스에서 `연결할 이메일`을 정한 뒤 `기존 로그인 확인·연결` 또는 `브라우저로 계정 연결`을 선택한다. 기존 로그인은 실제 이메일이 일치할 때만 OS vault에 연결하며 전역 활성 로그인은 유지한다. 불일치·접근 거부에서는 다른 인증으로 대체하지 않는다. 계정이 없으면 제공자의 공식 화면에서 가입 후 계속한다. 연결 뒤 `기본 계정으로 사용`을 누르며 프로젝트별 명시적 선택은 유지된다.

로컬 사용은 여기서 끝낼 수 있다. 동기화·기억 백업이 필요하면 `첫 기기 · 동기화 설정`의 **Supabase 관리 계정**에서 실제 사용할 계정을 선택한다. 그 계정으로 프로젝트 목록·공개 연결 키·로컬 관리자 연결을 확인한다. 앱 자체 DB는 이 마법사의 명시적 연결 때만 설정되며 일반 CLI 기본값 변경과 독립이다. `로그인 허용 이메일`은 iPhone·웹앱에 접속할 사용자이므로 관리 계정과 달라도 된다. 이미 동기화하는 PC가 있으면 새 프로젝트를 만들지 않고 기존 PC의 초대로 추가 기기를 연결한다.

## 사용자 흐름

1. 계정 우선순위는 **프로젝트에서 지정한 계정 → 이 기기 OS 사용자의 서비스 기본 계정 → 기존 CLI 로그인(기기 기본값을 설정하지 않은 경우만)**이다. 저장소·배포 대상은 프로젝트에 남으며 기기 기본 계정에 공통 배포 대상을 넣지 않는다. 기본 이메일을 예약하고 아직 인증하지 않았다면 `로그인 필요`로 표시하고 실행을 차단한다. 프로젝트별 명시적 선택과 다른 기기은 변경하지 않는다.
2. 계정 변경이 필요할 때 앱 설정 → CLI 계정 관리에서 CLI와 프로젝트를 선택한다. GitHub의 기존 로그인은 **사용할 계정**에서 바로 선택하며 인증을 복사하거나 `gh auth switch`를 실행하지 않는다. **브라우저로 계정 연결**에서 이메일을 입력하고 제공자 화면에서 직접 승인한다. GitHub·Vercel·Supabase의 공식 CLI 로그인과 Google OAuth를 사용하는 gws를 격리 실행한다. gws는 Google의 공식 지원 제품이 아니다. 토큰·사용자 OAuth JSON 수동 등록은 접힌 고급 설정으로 유지한다.
3. 브라우저 연결은 요청한 이메일을 GitHub verified emails, Vercel 사용자, Supabase profile primary_email, Google Drive 사용자로 확인한 뒤 연결한다. 표시 이름이나 현재 로그인명으로 이메일을 추정하지 않는다. 연결 확인은 해당 인증만 사용한다. GitHub 사용자, Vercel 사용자, Supabase 프로젝트 열거, Google Drive 사용자 조회를 수행한다. 실패한 연결은 프로젝트 기본 계정으로 선택할 수 없다.
4. 등록 프로젝트와 사용할 계정, 필요하면 팀·프로젝트 ID를 연결한다. 이 설정은 같은 기기의 모든 연결 에이전트와 SDK/CLI 호스트가 공유한다.
5. GitHub 푸시 확인창에서 실제 사용자·저장소·브랜치·커밋을 보고 푸시한다. 명시적으로 저장한 계정·대상이 사라지면 다른 로그인이나 origin으로 대체하지 않는다. origin도 없고 원격이 여러 개일 때 선택이 필요하다. 프로젝트를 기기 기본값으로 되돌리려면 **기기 기본값 따르기**를 선택한다. 프로젝트별 대상은 필요에 따라 유지할 수 있다.

이 기능은 **범용 로컬 프로젝트의 외부 서비스 관리**다. AgentsToZ 자체 데이터·기억 백업·기기 동기화용 Supabase 설정과 저장소를 공유하지 않으며, 계정 전환으로 앱 운영 DB 연결을 변경하지 않는다. 앱의 Supabase URL·anon/service-role 키와 DB 연결 환경은 CLI 자식 프로세스에서 제거한다. Supabase 관리 계정에는 사용자 PAT만 받고 앱 DB 키를 받지 않는다.

계정의 `목록에서 제외`는 목록만 숨긴다. 기존 프로젝트 연결과 기기 기본값의 계정 ID는 보존하여 실행을 차단하며, 다른 계정으로 대체하지 않는다. OS 자격 증명 원본을 지우거나 서비스의 토큰을 폐기하지 않는다. 토큰 갱신은 새 계정을 추가·확인한 뒤 프로젝트를 재연결한다. 같은 표시명은 기존 계정을 제외한 후 재사용한다.

## 계정 전환 — 이 Mac 전체와 프로젝트별 (2026-10-31)

같은 계정 목록을 세 곳에서 고른다. 고르면 바로 적용되고, 이미 로그인해 둔 계정은 다시 로그인하지 않는다.

| 위치 | 화면 | 바뀌는 것 |
|---|---|---|
| 이 Mac 전체 | 설정 → 「CLI 계정 전환 · 이 Mac 전체」(프로젝트 화면의 「이 Mac 전체 계정 바꾸기」에서도 열림) | gh·supabase·vercel 자신의 로그인. 프로젝트 계정이 없는 폴더에서 터미널·다른 앱·아젠투지가 모두 이 계정을 쓴다 |
| 한 프로젝트 | 프로젝트 화면 → 「CLI 계정 · 이 프로젝트」 | 그 프로젝트의 계정 연결(binding). 그 폴더에서는 워크룸·터미널·VS Code·git 어디서든 이 계정. 이 Mac 로그인은 그대로 |
| 만들 프로젝트 | 프로젝트 추가 → 새 프로젝트·기존 폴더 등록 탭의 「계정」 | 등록 직후 같은 연결을 만든다. 복제할 때는 고른 GitHub 계정으로 clone한다 |

**우선순위는 프로젝트 계정 → 이 Mac 로그인 → 그 밖의 어떤 것도 아님**이다. 프로젝트가 고른 계정이 사라지거나 깨지면 다른 계정으로 대체하지 않고 멈춘다.

### 이 Mac 전체 전환 (`native-status`·`native-switch`)

- GitHub: `gh auth switch`. gh가 모르는 연결 계정은 먼저 `gh auth login --with-token`으로 넣는다(토큰은 stdin으로만). git push는 macOS 키체인 계정을 먼저 쓰므로, 화면의 「git push도 이 전환을 따르게」(`native-git-setup` = `gh auth setup-git`)를 사람이 누를 때만 git 설정을 바꾼다.
- Supabase: `~/.supabase/profile` 선택자가 아젠투지가 만든 descriptor 파일을 가리키고, 그 프로필의 키체인 항목(`Supabase CLI`)은 `security -i`에 stdin으로 쓴다. 원래 프로필(`supabase`)은 「기존 프로필」로 남아 다시 고를 수 있다.
- Vercel: 계정마다 auth.json과 config.json의 currentTeam을 갈아 끼운다. 바뀌기 전 로그인은 먼저 연결 계정으로 남기거나 백업한다.
- 같은 요청 ID는 `native-switch.json` 영수증으로 한 번만 실행된다. 전환하면 아젠투지 기기 기본값도 그 계정을 따른다(어긋나 있으면 「이 Mac 계정으로 맞추기」).
- gws는 계정 전환 기능이 없다 — 기기 기본값(`set-default`)만 바꾸며 아젠투지·워크룸 실행에만 적용된다.

### 프로젝트 계정 (`project`·`bind`)

- 이미 로그인된 계정(gh 기존 로그인·연결 계정)을 고르면 그 자리에서 연결된다. 새 로그인도, 비밀 복사도 없다.
- 「＋ 다른 계정 로그인해서 추가…」는 공식 브라우저 로그인(`login-add-start`)을 열고, 승인한 실제 이메일을 확인한 뒤 그 계정을 바로 이 프로젝트에 연결한다. **계정 추가는 이 Mac 기본값을 바꾸지 않는다** — 빈 기기 기본값을 채우는 것은 처음 설치 흐름(`login-onboarding-start`)뿐이다.
- 연결 계정의 「목록에서 제외」(`archive`)는 두 번 눌러야 한다. 그 계정을 쓰던 프로젝트는 다른 계정으로 바뀌지 않고 멈춘다.

### 어디서든 — 등록 프로젝트 폴더라면 터미널·VS Code·git 모두 (`src/platformCliEverywhere.ts`)

프로젝트 계정은 워크룸뿐 아니라 **그 폴더를 어떻게 열든** 적용된다. 처음으로 어떤 프로젝트가 자기 계정을 고르면 설치된 앱이 아래 두 가지를 넣는다. 사람이 「워크룸에서만 쓰기」로 끄면 둘 다 지우고, 끈 뒤에는 새 연결이 생겨도 다시 켜지 않는다(`everywhere.json`의 mode — 없으면 auto).

- **터미널**: `~/.zprofile`·`~/.zshrc`(로그인 셸이 zsh면 없을 때 만든다)와, 이미 있으면 `~/.bash_profile`·`~/.bashrc` 맨 끝에 `# >>> AgentsToZ CLI accounts >>>` 블록을 둔다. 블록은 워크룸과 같은 shim 폴더를 PATH 맨 앞에 놓을 뿐이다. 그래서 Terminal·iTerm·VS Code 터미널(대화형 셸 → `.zshrc`)과 Codex 같은 AI 앱의 `zsh -lc`(로그인 셸 → `.zprofile`)가 모두 같은 shim을 쓴다. 이미 열려 있던 터미널은 새로 열어야 한다.
- **git**: 전역 git 설정 맨 끝에 `include.path = <APP_DATA>/platform-cli-v1/git/github.gitconfig` 하나를 둔다. 그 파일은 github.com 도우미 목록을 비우고 같은 폴더의 `credential-helper` 스크립트를 넣는다. 스크립트는 `agentstoz-use-mcp git-credential`을 부르고, 연결된 프로젝트 폴더면 그 계정으로 답하고 그 밖에는 이 Mac의 원래 도우미(`git config --show-origin`에서 아젠투지 include를 뺀 체인)에 그대로 넘긴다. VS Code의 소스 제어처럼 git을 부르는 앱도 같다. 아젠투지가 지워져 런처가 없으면 스크립트가 원래 도우미를 직접 차례대로 부른다(git이 깨지지 않게 — 이때는 프로젝트 계정도 적용되지 않는다).
- **다른 도구가 뒤에 끼어들면** — `gh auth setup-git`이 도우미를 아젠투지 include 뒤에 덧붙이거나, 다른 설치기가 블록 뒤에 PATH 줄을 넣으면 — 상태가 「일부만 적용」이 되고, 앱 시작·「git push도 이 전환을 따르게」 뒤·「다시 적용」에서 **아젠투지 블록·include만** 맨 끝으로 옮긴다. 남의 줄은 고치지 않는다.
- 셸 시작 파일이 심볼릭 링크(dotfiles 관리)면 링크를 유지하고 실제 파일만 바꾼다. 블록 표식이 깨져 있으면 그 파일은 건드리지 않고 알린다.
- 비용: 등록 프로젝트 밖에서 `gh`를 부르면 실제 CLI가 그대로 실행되며 shim을 거치는 비용은 약 30–40ms다(컴파일한 런처, 2026-10-31 실측).
- **개발·테스트 서버는 스스로 켜지 않는다**(`autoApply`는 설치 앱 사이드카만). 사람이 화면에서 켤 때만 적용한다.

### 워크룸 안에서 프로젝트 계정이 적용되는 방식

토큰을 워크룸 환경 변수에 넣지 않는다(`src/platformCliWorkroom.ts`).

- 워크룸 PATH 맨 앞에 `gh`·`supabase`·`vercel`·`gws` shim(`APP_DATA/platform-cli-v1/shims`)이 있다. 각 shim은 `~/.agentstoz/bin/agentstoz-use-mcp cli-exec <provider> --real <실제 CLI>`를 부르고, 런처가 없으면 실제 CLI를 그대로 실행한다.
- `cli-exec`는 **호출할 때마다** cwd로 등록 프로젝트를 찾는다. 연결된 계정이 있으면 그 계정의 환경으로 실제 CLI를 터미널에 붙여 실행하고, 없으면 손대지 않고 실행한다. 그래서 프로젝트 화면에서 바꾸면 워크룸을 다시 시작하지 않아도 다음 명령부터 적용된다.
- `gh auth token`·`gh auth git-credential`·`gh auth status -t/--show-token`은 막는다(계정은 쓰되 보여주지 않는다).
- git: `GIT_CONFIG_COUNT/KEY/VALUE`로 github.com 자격 도우미 목록을 비우고 `agentstoz-use-mcp git-credential`을 넣는다. 원래 github.com 도우미 체인은 `AGENTSTOZ_GIT_CREDENTIAL_FALLBACK`(JSON)으로 넘긴다. 연결된 프로젝트의 `get`에는 프로젝트 계정으로 답하고 `store`/`erase`는 무시해 키체인을 오염시키지 않는다. 연결이 없거나 github.com이 아니면 원래 도우미에 그대로 넘긴다. 연결된 계정이 깨졌으면 `quit=1`로 멈춘다.
- 제한 세션(대직)과 Windows에는 적용하지 않는다.

### 한계 (의도된 것)

- 셸을 거치지 않고 `gh`를 직접 실행하는 GUI 앱(launchd의 기본 PATH만 가진 앱)은 shim을 보지 못해 이 Mac 로그인을 쓴다. 터미널·IDE 터미널·셸을 여는 AI 앱·git은 위 「어디서든」으로 프로젝트 계정을 쓴다. fish 같은 다른 셸 설정은 바꾸지 않는다. 저장소 자체 설정(`.git/config`)에 github.com 도우미를 따로 둔 저장소는 그 설정이 우선한다.
- Windows는 워크룸에서만 적용된다.
- 워크룸 안의 에이전트는 `git credential fill`로 연결 계정의 토큰을 얻을 수 있다. 이 Mac에서 `gh auth token`이 주는 노출과 같은 수준이며, 막는 것은 토큰을 화면에 출력하는 gh 명령뿐이다.
- gws는 이 Mac 전체 전환이 없다.

### MCP로 (AI 채팅에서)

`agentstoz_use_platform_cli`의 `native-status`·`native-switch`(사람이 그 계정을 원할 때만)·`native-git-setup`·`everywhere-set {enabled}`(사람이 원할 때만)·`project`·`bind`·`login-add-start`→`login-status`(Supabase는 `login-code`)·`login-cancel`·`archive`. 토큰은 어떤 응답에도 없다. AI가 여는 로그인은 프로젝트 작업용뿐이며 앱 동기화 계정과 처음 설치 흐름은 앱에서 한다.

검증: `tests/platform-cli-native-switch.test.ts`(가짜 gh·supabase·vercel·security로 세 CLI 전환·영수증·되돌리기), `tests/platform-cli-workroom.test.ts`(실제 git으로 shim·자격 도우미·실패 시 멈춤), `tests/platform-cli-login.test.ts`(계정 추가가 기본값을 바꾸지 않음), `tests/platform-cli-everywhere.test.ts`(실제 zsh·bash·git으로 로그인/대화형 셸의 shim, 프로젝트 안팎 git, 뒤에 끼어든 도우미·PATH 줄, 심볼릭 링크, 끄기 후 원상 복구, 런처 없을 때 원래 도우미), `tests/platform-account-switcher-ui.mjs`(Chromium·WebKit, 390/1120px — 이 Mac 전환, 프로젝트 즉시 전환·새 로그인 없음, 계정 추가 후 연결, 새 프로젝트 선택). 테스터 검사 `platform-cli-contracts`·`platform-cli-screen`에 들어 있다.

## 에이전트·외부 CLI·SDK

### Google Console 파일로 계정 연결

설정 → CLI 계정 관리 → Google Workspace에서 터미널 명령 없이 다음 순서로 연결한다.

1. **Google 클라이언트 JSON 첨부**에서 Google Cloud Console의 **데스크톱 앱** OAuth 클라이언트 파일을 선택하거나 점선 첨부 영역에 끌어 놓는다. 한 번에 JSON 한 개(16KB 이하)를 받으며 두 방법 모두 같은 검증을 거친다. JSON을 검사하고 이 기기의 OS 자격 증명 저장소에 보관한다. 웹 앱·서비스 계정·이미 로그인한 사용자의 인증 JSON은 이 단계에서 거부한다. 파일 준비는 계정 연결 완료가 아니다.
2. **Google 계정 연결**에서 이메일을 입력하고 브라우저로 계정 연결을 누른다. 해당 계정의 브라우저 프로필에서 Google 승인을 완료한다. 처음에는 Drive 읽기 권한만 요청한다. 외부 앱이 테스트 중이면 연결할 이메일을 각각 Google Console의 테스트 사용자에 등록해야 한다.
3. Google이 승인한 실제 이메일을 검증한 뒤 연결된 계정 목록에 추가한다. 여러 이메일을 반복해서 연결하고 **이 기기의 기본 계정** 또는 **프로젝트 연결 → 사용할 계정**에서 선택한다. `gws` 실행 파일 하나를 재사용하고 계정 인증·프로젝트 선택은 분리한다. 파일 첨부나 로그인 화면을 연 것만으로 계정이 연결됐다고 표시하지 않는다.

기존 gws 클라이언트 설정도 사용할 수 있다. 첨부한 파일은 기존 gws 설정을 덮어쓰지 않으며, 앱의 파일을 읽지 못할 때 다른 클라이언트로 대체하지 않는다. 클라이언트를 교체해도 진행 중인 로그인은 시작 때 복사한 파일을 유지하고, 이미 연결된 계정의 인증과 프로젝트 선택을 변경하지 않는다. 기존 사용자 인증 JSON의 직접 등록은 별도 **고급** 항목이다. 클라이언트 파일은 앱의 계정 레지스트리·프로젝트 Git·MCP 응답에 내보내지 않는다.

이 흐름의 Console 단계와 여러 계정 안내는 로컬 참조 프로젝트 `Gwc-help-bycs`의 `app/guide/credentials/page.tsx`, `app/guide/console-setup/page.tsx`, `app/guide/multi-account/page.tsx`를 참고했다. Console 준비는 [gws 인증 안내](https://github.com/googleworkspace/cli#authentication)와 [Google 데스크톱 OAuth 문서](https://developers.google.com/identity/protocols/oauth2/native-app)를 따른다. 계정별 Google 승인과 CLI 설치 여부는 별도이며, JSON만으로 Google 승인 절차를 생략하지 않는다.

`agentstoz_use_platform_cli`는 `project`, `bind`, `push-options`, `prepare-push`, `execute-push`를 제공한다. 등록 프로젝트 ID를 먼저 조회한다. `project` 응답의 `deviceDefaults`와 프로젝트별 `bindings`는 기본값 상속과 재정의를 구별한다. `project`의 기존 GitHub 로그인도 대화형 `bind`에 사용할 수 있다. `pcli_default`와 빈 scope/resourceId는 프로젝트 연결을 기본으로 되돌린다. 계정 등록·인증 정보 입력·로컬 경로·임의 명령 실행은 이 MCP 표면에 없다. `prepare-push` 결과를 작업 지시에 따라 실행한다. 프로젝트에서 계정을 지정하지 않으면 기기 기본값을 따르며, 기기 기본값도 없을 때 기존 로그인을 사용한다. 저장소 기본은 origin이며, 대상이 실제로 모호한 경우에만 선택을 요청한다.

설치 앱에 이미 포함된 `agentstoz-use-mcp` 실행 파일은 `cli` 하위 명령도 제공한다. 소스 checkout에서는 다음과 같이 실행한다.

```sh
bun agentstoz-use-mcp-server.ts cli status --project PROJECT_ID
bun agentstoz-use-mcp-server.ts cli github --project PROJECT_ID -- pr list
bun agentstoz-use-mcp-server.ts cli github --project PROJECT_ID --account ACCOUNT_ID --remote company --yes -- push
bun agentstoz-use-mcp-server.ts cli vercel --project PROJECT_ID -- deploy
bun agentstoz-use-mcp-server.ts cli supabase --project PROJECT_ID -- functions list
bun agentstoz-use-mcp-server.ts cli google-workspace --project PROJECT_ID -- drive files list
```

CLI는 현재 폴더·등록 프로젝트·Git worktree를 다시 검증한다. 같은 폴더의 등록 행이 여러 개면 `--project`를 명시한다. `--yes`가 없는 GitHub push는 계획만 출력하고 전송하지 않는다. 일반 CLI 명령은 프로젝트 기본 계정을 사용하며, 인증·설정·대상 우회 인수는 받지 않는다. 원시 `gh`, `git`, `vercel` 명령 자체를 가로채지는 않는다. 외부 에이전트는 이 명령, 연결 MCP 또는 SDK 호스트를 사용해야 한다.

SDK 0.4.0의 `PlatformCliStore`, `PlatformCliHost`, `PlatformGithubPush`는 같은 구현이다. 소비 호스트는 등록 대상의 최신 해석기, 실행 파일 경로와 작업 실행 권한을 제공한다. import만으로 실행 권한이 생기지 않는다. 앱의 원격·모바일 기기 grant는 늘리지 않는다.

## 인증·대상 경계

- 새로 추가한 영속 인증은 `Bun.secrets`를 통한 이 기기의 OS 자격 증명 저장소에 둔다. 기존 GitHub 로그인은 native CLI에서 해당 사용자만 해석하며 복사하지 않는다. 명시적 연결의 읽기 실패·인증 해시 변경에서는 실행하지 않으며 기본 로그인으로 대체하지 않는다. 계정 레지스트리는 앱 데이터의 private 디렉터리/파일에 메타데이터만 저장한다. 클라우드·프로젝트 Git·MCP 응답에는 인증을 넣지 않는다.
- GitHub는 실행별 `GH_TOKEN`, Supabase는 `SUPABASE_ACCESS_TOKEN`을 명시한다. 다른 서비스의 토큰과 관리 capability, Git 환경 재정의를 자식 프로세스에서 제거한다.
- Vercel과 Google Workspace는 호출마다 별도 private 임시 설정/인증 파일을 만들고 종료 시 정리한다. 동시 호출끼리 파일을 공유하지 않는다. 강제 프로세스 종료 시 남은 private 임시 파일은 자동으로 다른 계정의 설정으로 사용하지 않는다.
- GitHub push는 선택 계정의 저장소 쓰기 권한과 불변 repository node ID를 확인한다. 단일 push URL만 허용하고, 저장소의 URL 재작성·HTTP 인증 재정의가 있으면 중단한다. Git 전역 인증 설정을 쓰지 않고 선택한 `gh`의 credential helper로 고정한다. 토큰은 argv·URL·로그에 넣지 않는다. 전송 refspec은 확인한 정확한 커밋 SHA이며 force를 사용하지 않는다.
- 계획은 5분·최대 64개다. 실행 전에 프로젝트 경로·계정 리비전·원격·브랜치·커밋·repository ID·권한을 재검사한다. 첫 전송 전에 durable `executing` 영수증을 쓰고 같은 계획/요청 ID 재시도는 그 영수증만 반환한다. 미확정 결과를 새 요청으로 자동 반복하지 않는다. 완료/실패 기록은 7일, 미확정 기록은 유지하며 최대 512개에서 새 요청을 멈춘다.

기본 GitHub 로그인도 준비 시 실제 사용자·인증 리비전을 고정한다. 준비 이후 native 활성 계정을 바꿔도 그 푸시는 원래 사용자를 유지하며, 인증 자체가 바뀌면 중단한다. 명시적 계정·대상 변경은 다음 명령부터 읽고 이미 실행 중인 명령을 바꾸지 않는다.

현재 GitHub 대상은 GitHub.com이다. Vercel·Supabase의 기본 모드는 프로젝트의 native 링크를 유지한다. 별도 계정을 연결하면 Vercel 팀·프로젝트 ID, Supabase functions의 project ref를 명시한다. Supabase DB 비밀번호 작업은 PAT만으로 연결하지 않으며 별도 DB 연결이 필요하다. Google 계정 확인에는 Drive 사용자 읽기 권한이 필요하다. 다른 기기의 자격 증명을 자동으로 복사하지 않는다. Windows 실행·OS 자격 증명 통합은 Windows 실기 검증 전까지 확인되지 않은 범위다.

## 근거와 검증

- [GitHub CLI 환경](https://cli.github.com/manual/gh_help_environment), [복수 로그인](https://cli.github.com/manual/gh_auth_switch)
- [Vercel 전역 설정·scope·프로젝트](https://vercel.com/docs/cli/global-options)
- [Supabase CLI 토큰](https://supabase.com/docs/guides/platform/personal-access-tokens), [v2.90.0의 프로필·legacy 토큰 fallback](https://github.com/supabase/cli/blob/v2.90.0/internal/utils/access_token.go)
- [Google Workspace CLI 환경](https://github.com/googleworkspace/cli#environment-variables). `gws`는 Google의 공식 지원 제품으로 표시하지 않는다.
- `bun test ./tests/platform-cli-accounts.test.ts`
- `bun tests/platform-cli-accounts-ui.mjs` — 실제 React 설정/푸시창, 두 브라우저와 두 폭. fake provider/OS vault로 실제 계정과 프로덕션 저장소에 접근하지 않는다.

## 브라우저 로그인 수명과 제한

- 로컬 앱의 `login-start`, `login-status`, `login-code`, `login-cancel`, `set-default`만 로그인과 기기 기본값을 변경한다. MCP 에이전트 표면은 이 작업·확인 코드를 받지 않는다.
- 로그인마다 private scratch HOME/config를 만든다. GitHub는 격리한 임시 `--insecure-storage` 파일에서 승인 결과를 읽어 OS vault로 옮기며 기존 gh Keychain 항목을 갱신하지 않는다. Vercel은 별도 global-config, Supabase는 공식 endpoint만 담은 전용 profile JSON과 고유 OS 항목, gws는 복사한 Desktop OAuth client와 별도 암호화 설정을 쓴다. 원래 활성 로그인·프로젝트 링크를 수정하거나 전역 logout을 호출하지 않는다.
- Supabase v2.90의 `--profile`은 계정 별명이 아니라 프로필 JSON 경로다. JSON의 `name`이 OS 자격 증명 항목의 키이며, 승인 후 해당 항목만 정리한다. Supabase 브라우저 로그인은 classic 계정 전체 토큰을 만든다. 필요한 경우 고급 등록의 scoped PAT를 사용한다.
- Google Desktop OAuth `client_secret.json` 준비는 선행 조건이다. 이 흐름은 Drive 읽기 scope부터 요청하며 추가 쓰기 권한을 자동 부여하지 않는다.
- Vercel OAuth의 refreshToken/expiresAt를 OS vault에 함께 보존한다. 같은 계정의 OAuth 명령은 직렬화하고 공식 CLI가 갱신한 결과를 원래 계정에만 저장한다. 오래된 인증 리비전은 다른 계정으로 대체하지 않는다.
- 로그인 출력은 Workroom·대화·기억에 넣지 않는다. 공식 URL·일회용 코드만 메모리와 로컬 화면으로 전달하고 종료 시 제거한다. 로그인의 계정·상태 영수증에는 URL·코드·OAuth 본문을 넣지 않는다. 10분 제한, 출력 64KB, 메모리 최대 8개, 디스크 admission 영수증 최대 128개다. 완료 메타데이터는 24시간 재시도 창 이후 정리하고, 재시작 후 같은 요청을 자동 재실행하지 않는다. private scratch는 종료 시 제거하고 다음 로그인 시작 때 만료된 잔여 scratch를 정리한다.
- 명령을 준비한 뒤 기기 기본값을 변경해도 그 명령의 인증 계정과 대상은 유지한다. 새 명령은 새 기본값을 읽는다. Vercel·Supabase의 명시적 대상은 선택 인증으로 고정 API 조회를 통과해야 실행된다.

실제 CLI 시작 검증(2026-10-18, 아젠투지1호)은 네 서비스 모두 격리 설정에서 공식 승인 URL까지 확인하고 사용자 승인 없이 취소했다. 실제 네 계정 OAuth 완료·토큰 갱신·설치 앱 반영을 증명하는 결과는 아니다.

추가 실계정 검증(2026-10-18)에서는 Google Workspace의 `intenet1001@gmail.com`, `intenet1002@gmail.com`, `intenet8821@gmail.com`을 각각의 브라우저 프로필에서 Drive 읽기 권한으로 승인하고, 저장한 계정으로 다시 조회했다. GitHub·Vercel·Supabase의 기존 CLI 인증도 계정 확인 뒤 앱에 연결했다. 네 서비스의 기기 기본 이메일은 `intenet1001@gmail.com`이다. 이 검증은 개발 소스의 호스트에서 수행했으며 설치 앱 검증은 빌드 후 별도로 확인한다.

Supabase 브라우저 로그인은 해당 요청의 임시 프로필만 읽고 정리한다. macOS CLI가 사용하는 [go-keyring의 base64·hex 저장 형식](https://github.com/zalando/go-keyring/blob/v0.2.8/keyring_darwin.go)을 해석하며, 잘못된 인코딩에서는 기존 전역 계정이나 파일로 대체하지 않는다.

### 아젠투지 데이터 저장소와 작업용 CLI의 경계

첫 기기 동기화 화면의 ‘Supabase 관리 로그인 추가’는 데이터 저장소를 준비할 관리 로그인만 연결한다. 여기에는 일반 CLI의 기본 계정·프로젝트 연결·다른 서비스·계정 제외 기능을 표시하지 않는다. 로그인 후 상단에서 관리 계정을 다시 읽고 명시적으로 선택한다. 이 화면의 기존 로그인 가져오기와 브라우저 로그인은 `purpose=app-sync-account`로 결속되어, 같은 이메일의 프로젝트 CLI 기본값이 로그인 대기 중이어도 자동 연결하지 않는다. 같은 요청 ID의 용도 변경은 거부한다.

‘프로젝트 작업용 CLI 계정 관리’는 이 Mac의 작업 계정과 프로젝트별 연결을 관리한다. 어느 쪽에서 로그인을 연결하거나 CLI 기본값을 변경해도 기존 아젠투지 DB URL·키는 바뀌지 않는다. 아젠투지 데이터 저장소는 별도 첫 기기 설정 완료로만 바뀐다. iPhone·웹의 로그인 허용 이메일 역시 Supabase 관리 계정과 독립적이다.
