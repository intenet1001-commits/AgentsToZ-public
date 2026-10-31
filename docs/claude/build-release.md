# Tauri 빌드·배포 · 버전 번호 · 빌드 시스템

Control 독립 helper의 서명 빌드(`scripts/build-computer-use-control-app.ts`)는 Swift 컴파일 전에 전용 App ID·팀·Developer ID 배포 형태·
만료·승인 Keychain group을 검사한다(`computerUseSigningProfile.ts`). Screen 프로필·개발 기기 프로필을 대체 사용하지 않는다.
프로필 metadata 통과와 실제 OS profile 검증·설치·TCC·Secure Enclave 사람 승인은 별도 증거이며, 없는 프로필을 생성/갱신하지 않는다.
프로필은 허용 범위이므로 Apple이 발급한 같은 팀의 `TEAM.*` Keychain 허용값도 전용 group을 허용한다. 바이너리의 `controlEntitlements()`는 항상 정확한 Control group 하나를 요청하며 wildcard를 복사하지 않는다. 2026-10-27 다른 Mac의 기존 공증 Control v1527 프로필에서 이 차이를 확인했다.
실기 재현(2026-10-28): Control 프로필이 다른 Developer ID 인증서에 결속된 상태에서 서명·Apple 공증·Gatekeeper는 통과했지만,
실제 실행은 AMFI의 `No matching profile found`로 거부됐다. 프로필의 `DeveloperCertificates` 공개 SHA-1 지문과 `--sign`이 선택한
유효 identity를 컴파일 전에 대조하고, 일치하지 않거나 이름이 모호하면 빌드·공증 전에 거절한다. 유일하게 해석된 지문을
`codesign`에 넘기고 검증한 프로필 바이트를 그대로 내장한다. 이 검사는 인증서 소속만 확인하며 Apple의 프로필 신뢰·실행을 보장하지 않는다.
프로필 XML을 Python에 stdin으로 넘길 때는 `plistlib.loads(sys.stdin.buffer.read())`를 쓴다. 이 Mac의 Python 3.9에서 `plistlib.load(sys.stdin.buffer)`는 nonseekable pipe를 rewind하려다 실패했다. 합성 프로필을 실제 파이프로 읽는 회귀를 `computer-use-signing-profile.test.ts`에 둔다.

**보안 타임스탬프가 기본이다 (2026-10-28).** 예전에는 `--timestamp`를 빼면 조용히 `--timestamp=none`으로 서명했다. 핸드오프가 만든 helper가 그 상태였다 — `codesign -dvv`에 Developer ID·hardened runtime은 있지만 `Timestamp=` 없이 `Signed Time=`만 있어 Apple 공증이 거절한다. 이제 서명 빌드는 항상 `codesign --timestamp`로 서명하고, `codesign --display --verbose=4`에 `Timestamp=`가 없으면 빌드를 실패시킨다(`--timestamp`는 기본값이 되어 그대로 받는다). `--timestamp=none`은 서명 빌드에서만 쓰는 명시적 로컬 전용 옵션이다. stderr 경고와 결과 JSON의 `notarizable:false`로 공증할 수 없다고 알리고, `--notarize`와 함께 쓸 수 없다.

**공증은 옵트인 `--notarize --notary-profile <기존 notarytool keychain profile> [--notary-keychain <절대 경로>]`.** 플래그가 없으면 이전처럼 서명까지만 한다.
- 전제: 위 서명 조건(전용 Developer ID 프로필 + `--sign`) + **이미 저장된** notarytool keychain profile. Control은 direct-distribution·`check-macos-notary.ts`와 같은 keychain profile 경로를 쓴다. 메인 앱도 이제 `--developer-id --notary-profile <이름>`으로 같은 기존 프로필을 명시할 수 있고, 미지정하면 기존 App Store Connect API 키 경로를 유지한다. 스크립트는 자격 증명을 만들거나 바꾸지 않고(store-credentials를 실행하지 않는다) 출력하지도 않는다.
- 순서: Swift 컴파일 전에 `checkMacOSNotary`(= `bun check-macos-notary.ts`)로 한 번, 업로드 직전에 한 번 더 확인한다 — 빌드하는 동안 화면이 잠길 수 있다(장기기억 「Notary profile lookup can fail while the screen is locked」). 잠긴 세션의 조회 실패·프로필 없음·Apple 401을 따로 보고하며, 조회 실패만으로 프로필이 지워졌다고 보지 않는다. 그다음 확인된 **같은 auth 인자**로 `ditto -c -k --sequesterRsrc --keepParent` zip → `notarytool submit --wait --timeout 60m --output-format json` → `notarytool log` → Accepted가 아니면 로그와 함께 실패 → `stapler staple`·`stapler validate` → helper 요구사항 재검사 → `spctl --assess --type execute`가 `source=Notarized Developer ID`인지 확인한다.
- 영수증: 앱 옆의 `AgentsToZ Control.notary-receipt.json`(0600, 모든 검사를 통과한 뒤에만 쓴다)과 `AgentsToZ Control.notary-log.json`. 둘 중 하나라도 이미 있으면 빌드 전에 거절한다 — 옛 영수증을 새 빌드 것으로 덮지 않는다.
- 결과를 모르는 제출(JSON 없음·시간 초과)은 **다시 보내지 않는다.** 읽기 전용 재확인으로 잠금·401을 구분하고 `notarytool history`로 먼저 찾아보라고 안내한다. 이때 재확인 결과의 안내는 업로드 전 안내(「빌드를 다시 돌려라」·「이 빌드는 아무것도 바꾸지 않았다」)를 쓰지 않는다 — 이 스크립트는 항상 빌드하고 업로드하므로 다시 돌리면 다시 업로드된다. 서명된 앱의 위치와 함께 「history에서 Apple이 받지 않았음을 확인한 뒤에만 다시 돌린다」고 말한다(`controlNotaryPreflightError`의 `after-unconfirmed-upload`, 2026-10-28 리뷰에서 발견). notarytool의 원문 stderr는 출력하지 않는다. Accepted 뒤 staple·Gatekeeper에서 실패하면 그 submission id를 알려 주고 다시 제출하지 말라고 한다.
- 검증: `tests/computer-use-control-bundle.test.ts`가 주입한 러너로 순서·인자·실패 분기를 검사한다(Apple에 접속하지 않는다). 실제 공증도 2026-10-28 통과했다: `/private/tmp/agentstoz-control-notarized-20261028/AgentsToZ Control.app`, submission `caf3c23f-c75b-46fb-ae74-fc3bf3af1f10`. Developer ID 서명·secure timestamp·Accepted·staple·Gatekeeper 검증 완료, `installed:false`. 설치·LaunchAgent 등록·TCC·Touch ID 승인은 여전히 별도의 수동 단계다.

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## Tauri 빌드 & 배포
- **앱 빌드 (macOS)**: .app 번들 생성 (Applications 폴더 설치용)
- **DMG 빌드 (macOS)**: 완전 자동화된 macOS 배포 패키지 생성
- **Windows 빌드**: NSIS .exe 설치 파일 로컬 빌드 (`bun run tauri:build:win`)
  - 결과물: `%USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe`
  - **기본 경로는 실제 Windows PC**: 검증·NSIS 빌드·설치본 확인을 그 PC에서 수행한다. Windows 빌드 요청만으로 GitHub Actions Windows 가상머신 사용을 승인한 것으로 보지 않는다. 사용자가 Actions 실행을 명시적으로 요청했거나 Windows PC 빌드 불가를 확인하고 별도 승인을 받은 때만 수동 CI를 쓴다.
  - **Windows Bun 기준은 1.3.12**(2026-10-24 실측). 같은 소스의 실제 ConPTY 입력·종료·워크룸 다시 시작 검사는 1.3.12에서 7/7 통과했다. 1.4.2에서는 `windowsPty.ts`의 conin descriptor 쓰기가 `EBADF`로 실패하고 입력 바이트 수가 0이 된다. Mac의 런타임 기준을 Windows에 그대로 적용하지 말고, 업그레이드 전에 `bun test --timeout 30000 ./tests/windows-pty.test.ts ./tests/windows-workroom-session.test.ts`의 실제 입출력을 확인한다. Windows 수동 CI도 1.3.12로 고정한다.
  - **설치본 검사는 복원된 기준 버전과 비교하지 않는다.** `run-windows-packaged-e2e.ps1`은 `buildVersion.ts`의 Git 계산 버전과 설치된 PE 버전을 비교한다. 빌드 후 `tauri.conf.json`은 기준점 625로 돌아오기 때문이다. 기본 산출물 경로도 빌드 래퍼와 같은 `%USERPROFILE%\cargo-targets\portmanager`다. v1257에서 무인 설치·API 기동·제거와 실제 설치 앱의 IPC·실행/재시작/중지·분리 자식 종료 2/2를 확인했다.
  - **⚠️ CARGO_TARGET_DIR 고정 이유**: 프로젝트가 `C:\Windows\System32\` 경로에 있으면 makensis.exe가 해당 경로 파일 읽기를 OS가 차단(os error 2/5). `build-win.ts`가 target dir을 홈 디렉터리로 자동 리다이렉트하여 NSIS 번들링 성공시킴.
  - **Windows 코드는 main에 있다 (2026-10-08 합침).** 2호(Windows)가 쓰던 `feat/windows-app-parity`(Windows 워크룸 ConPTY·
    격리 런처·Python UTF-8 등 51커밋)를 main으로 합쳤다. 이제 세 기기가 **같은 커밋을 빌드해 같은 번호**를 받는다.
    합치며 macOS를 지키려고 바꾼 세 가지 — 되돌리지 말 것:
    ① Windows에서만 만들어지는 리소스(`resources/pty-runtime/`·`agentstoz-windows-contain*`)는 **`tauri.windows.conf.json`**
    에만 있다. 공용 `tauri.conf.json`에 두면 macOS 빌드가 「아무것도 가리키지 않는 리소스」로 실패한다. Windows 파일은
    JSON Merge Patch로 **배열을 통째로 바꾸므로** 기본 목록을 모두 다시 적어야 한다(`tests/windows-pty-runtime.test.ts`가 지킨다).
    ② 격리 런처는 앱 크레이트의 bin이 아니라 **별도 패키지 `src-tauri/windows-contain/`** 다. Tauri는 앱 패키지의 모든 bin을
    번들에 복사해서, bin이던 동안 macOS 앱 `Contents/MacOS`에 실려 `codesign --verify --deep --strict`가 깨졌다
    (`required-features`로 막아도 번들러가 파일을 찾다 실패한다). `build-sidecar.ts`가 Windows에서만 그 매니페스트로 빌드한다.
    ③ Windows 경로를 다루는 헬퍼(pty 런타임 탐색, Python 고정 경로, win32 서명 Codex 신원)는 `path.win32`로 판정한다 —
    호스트 `path`를 쓰면 macOS에서 `C:\…`를 절대 경로로 못 봐서 Windows 테스트 6건이 Mac에서만 실패했다.
- **버전 = git 기록에서 센 빌드 번호 (2026-10-07)**: 정본은 `buildVersion.ts`. `build-number.json`은 **기준점**
  `{buildNumber, baseCommit}`이고, 빌드의 번호는 `buildNumber + baseCommit 뒤의 커밋 수`다.
  - **bump 커밋은 더 없다.** 예전에는 빌드마다 버전 파일 12개를 `chore: bump to vN`으로 커밋해서 한 주 157커밋 중
    72개가 bump였고, 3호가 같은 커밋을 빌드하면 자기 번호(v626)를 냈다. 지금은 **같은 커밋 = 어느 기기든 같은 번호**다.
  - 빌드 동안 `update-version.ts`가 버전 파일(`VERSION_FILES`)을 제자리에 쓰고 `build-number.json`에서 `baseCommit`을 뺀다
    (빌드 중 그 파일을 읽는 쪽 — 사이드카의 MCP 버전, stamp-icon.py, Vite — 이 두 번 세지 않게). 빌드 래퍼가 끝날 때
    (실패·중단 포함, `process.on("exit")`) git에서 되돌린다. 중단된 빌드가 남긴 버전 파일만 더러우면 다음 빌드가 먼저 되돌린다.
  - ⚠️ **얕은 clone은 셀 수 없다.** 앱·Windows·iOS 빌드는 거절하고(Windows CI는 `fetch-depth: 0`), 표시 전용인
    포털(Vercel)은 기준 번호로 떨어진다 — Vercel 프로젝트에 `VERCEL_DEEP_CLONE=true`를 넣어 실제 번호가 나오게 했다.
  - 기준점을 옮길 일은 없다. 옮긴다면 `buildNumber`와 `baseCommit`을 **같은 커밋 기준으로 함께** 바꿀 것.
  - `--allow-unpublished-source` 빌드는 아직 올리지 않은 커밋까지 세므로, 나중에 다른 커밋이 같은 번호를 받을 수 있다(공식 배포본 아님).
  - 다른 Mac에는 빌드한 앱을 그대로 설치한다: `bun scripts/install-remote-mac.ts <ssh 호스트>`.
    옛 앱은 지우지 않고 `/Applications/.AgentsToZ_byCS-backups/`로 옮긴 뒤 교체하며, 교체나 다시 띄운 앱의 health가
    실패하면 옛 앱을 되돌려 다시 띄우고 0이 아닌 코드로 끝난다(2026-10-09 — 그 전에는 `rm -rf` 후 복사라 실패 시 앱이 없었고
    사이드카가 죽어도 ✅였다). `tests/install-remote-mac.test.ts`가 임시 Applications 폴더에서 스크립트를 실제로 돌린다.
    ⚠️ SSH에서 `open`으로 앱을 띄우면 그 셸의 환경(`SSH_CONNECTION`·`SSH_CLIENT`)이 앱과 **워크룸 CLI까지** 내려간다.
    Antigravity는 그것을 원격으로 보고 키체인을 건너뛰어 워크룸에서만 「로그인 안 됨」이었다(3호 2026-10-08, 같은 agy가 Orca에서는 로그인).
    그래서 설치 스크립트는 `env -u SSH_* open`으로 띄우고, 워크룸(`aiTerminalService`)도 CLI에 SSH_*를 넘기지 않는다.
  - **DMG 빌드 후처리**: macOS 버전 호환성 문제 시 자동으로 임시 DMG를 최종 위치로 복사
  - **아이콘 버전 스탬프**: `update-version.ts` 실행 시 `stamp-icon.py` 자동 호출 → 앱 아이콘 우하단에 `vN` 표시
    - 의존성: `Pillow` (`pip install Pillow`) — 없으면 스탬프 스킵 후 빌드 계속
    - 원본 보존: `src-tauri/icons/icon.original.png` (최초 1회 자동 백업)
- **실시간 빌드 로그**:
  - 빌드 진행 상황을 실시간으로 확인할 수 있는 모달 창
  - 색상 코딩 (성공: 초록, 에러: 빨강, 경고: 노랑)
  - 1초마다 자동 폴링으로 로그 업데이트
  - 로그 복사 기능 (클립보드)
  - 빌드 완료/실패 자동 감지
- **DMG 출시하기**: 빌드된 DMG를 Desktop으로 자동 복사
- Bundle identifier: `com.portmanager.portmanager`
- 창 크기: 1000x1050 (최소: 800x700)
- **데이터 저장 위치**:
  - macOS: `~/Library/Application Support/com.portmanager.portmanager/ports.json`
  - Windows: `%APPDATA%\com.portmanager.portmanager\ports.json`
  - 로그: `{앱 데이터 디렉토리}/logs/{portId}.log`
- **다른 기기로 이전**:
  - 방법 1: Supabase Push/Pull 동기화 (권장, 멀티 기기)
  - 방법 2: "내보내기"/"불러오기" 버튼 사용
  - 방법 3: `ports.json` 파일 수동 복사
## 빌드 시스템

### 공개 이력 이어 붙이기 — 명시적 `--append-public-history` (2026-10-26)

`bun run publish --append-public-history [--dry-run]`은 다른 Mac의 기존 공개 clone이
fast-forward Pull을 이어가도록 현재 공개 `main`을 부모로 쓰는 선택 경로다. 기본 orphan
출판과 offline `--dry-run`은 유지한다. append는 dry-run에서도 먼저 fetch/push URL 단일성·
동일성, 공개 저장소 신원·PUBLIC·WRITE 권한, 모든 source remote와의 분리를 감사한다.
감사한 고정 URL에서 원격 `main` SHA를 읽고 그 정확한 SHA를 tags 없이 fetch한 뒤
`FETCH_HEAD` 일치와 commit 타입을 확인한다. 로컬 tracking ref나 source HEAD를 대신 쓰지 않는다.

새 tree는 기존 private 경로 제외·값 치환·비밀 스캔을 그대로 거친다. candidate의 부모가
감사한 공개 SHA 하나와 정확히 같은지 확인하며, 실제 push의 lease도 같은 SHA에 고정한다.
그사이 원격 `main`이 바뀌면 새 lease만 얻어 기존 candidate를 밀지 않고 중단한다.
이 모드는 기존에 공개된 이력만 유지한다. 기본 orphan 경로로 이미 끊긴 더 오래된 clone이나
로컬에서 갈라진 작업 이력을 자동으로 reset·merge하지 않는다. 회귀는 임시 로컬 bare remote와
별도 clone의 실제 `git pull --ff-only`로 검증하고 외부 저장소에는 쓰지 않는다.
공개 snapshot은 버전 파일이 이미 확정돼 있으므로 `update-version.ts`는 Cargo 버전 필드의
존재를 검사하고 같은 버전의 재빌드도 허용한다. 실제 updater를 두 번 실행하는 회귀로 확인한다.

### Screen 동봉과 독립 설치 (2026-10-26)

일반·내장 브라우저 macOS 빌드와 공개 Developer ID base 빌드는 모두
`stageScreenControlBundle.ts`로 같은 소스의 Screen을 Developer ID 서명한 뒤
`Contents/Helpers/AgentsToZ Screen.app`에 설치용 사본을 넣는다. Screen 버전은 메인 앱의
빌드 버전과 같고 키체인 entitlement·고유 식별자·팀은 기존 Screen과 동일하다. 이 사본은
중첩된 위치에서 실행하지 않는다. 메인 앱의 시작/Screen 열기 경로가 서명된 사본을 독립
Applications 앱으로 설치한다. 사용자 권한 승인·제어 켜기·기기 등록은 기존 Screen 흐름이다.

동봉 Screen은 알림 중계 주소를 **명시 옵션으로만** 받는다(2026-11-01, `pushEndpoint`). 환경 변수는 물려받지 않으며
(`screenBundleBuildEnvironment`), 이 Mac의 `build-macos.ts`만 `AGENTSTOZ_SCREEN_PUSH_URL`이 있을 때 넘긴다. 공개 Developer ID base
파이프라인은 넘기지 않는다. 만든 뒤 동봉 사본의 `AgentsToZScreenPushURL`이 요청과 같지 않으면(없어야 할 때 있는 것 포함) 빌드가 실패한다.

Screen에 GUI 서명이나 `--deep --force`를 적용하지 않는다. 원래 Developer ID 서명과
키체인 권한을 검사한 뒤 보존한다. base 빌드의 전체 파일 digest에도 Screen이 포함된다.
일반 Tauri DMG는 이 staging보다 먼저 생기므로 최종 앱 서명 뒤 이번 실행에서 만든 DMG만
다시 생성한다. Developer ID 경로는 기존 공증된 앱 → DMG 재생성 절차를 유지한다.
최상위 앱의 공증은 내부 코드의 ticket도 발급하므로, 완료 뒤 Screen과 메인 앱 각각에
ticket을 붙이고 검증한다. 다른 Mac에 독립 복사한 Screen도 그 ticket을 함께 가져간다.
근거: [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

공개 소스와 설치 파일은 별도 표면이다. `bun run publish --dry-run`의 비밀/개인 배포 스캔을
통과한 스냅샷만 공개하고, 공개 clean snapshot에서 만든 패키지의 Screen 포함·외부 설치·
서명·기기 등록을 별도로 검증한다. 서명 키를 가진 빌드 호스트가 필요하며 Git Pull만으로
다른 Mac의 설치 앱이 업데이트되지는 않는다. Screen은 macOS 14 이상이다.

### 내장 Chromium 앱 (2026-10-24)

`bun run tauri:build:browser`는 기존 clean/published 출하 가드를 그대로 거쳐 Apple Silicon `.app`만 빌드한다. `CEF_PATH`의 고정 CEF 156.0.7 SDK와 CMake 3.x·Ninja가 필요하며 macOS 최소 버전은 실제 framework의 `LC_BUILD_VERSION`에 맞춘 13.0이다. 기본·DMG·Windows 빌드는 바꾸지 않는다. `stageWorkroomBrowserBundle.ts`는 Tauri의 식별자·UI·sidecar·출하 근거를 보존하고 framework, 고유 ID의 sandbox helper 5개와 CREDITS만 넣는다.

GUI의 고정 designated requirement를 `--deep`으로 새 helper에도 적용하면 서로 다른 helper 식별자와 어긋나 `nested code is modified or invalid`가 재현됐다. framework와 새 helper를 먼저 안쪽부터 ad-hoc 서명한 뒤, GUI에만 기존 entitlement와 고정 requirement를 적용하고 전체를 deep/strict 검증한다. `tests/workroom-browser-package.mjs`는 실제 컴파일된 앱과 CEF로 임시 번들을 만들고 이 순서, GUI 마이크 권한 유지와 helper에 그 권한이 추가되지 않는 것을 검사한다. 설치하거나 실행하지 않는다. 미공개 테스트 예외 산출물의 설치 금지와 Developer ID·공증의 별도 경계는 그대로다.

### Developer ID 서명·공증 빌드 — 옵트인 `--developer-id` (2026-10-25)

사용자 결정: 「빌드 옵션으로 추가 — 서명·공증 빌드를 만들어 검증만 하고, 지금 쓰는 방식은 그대로」. **플래그가 없으면 이 경로는 실행되지 않는다** — 기본 빌드는 지금처럼 ad-hoc + `identifier "com.intenet.agentstozbycs"`뿐인 지정 요구사항이다. 근거는 `docs/design/screen-control-2026-10-24/DESIGN.md`의 결정 1과 S0-7(식별자만 있는 요구사항은 같은 식별자로 ad-hoc 서명한 다른 코드도 통과한다).

- **실행**: `bun run tauri:build:browser:developer-id`(내장 Chromium 앱 — 지금 설치된 형태) 또는 `bun run tauri:build:developer-id`(기본 형태, `--dmg`와 함께 쓸 수 있다). 내장 브라우저는 `CEF_PATH=/tmp/agentstoz-cef-runtime-156 PATH="/tmp/agentstoz-cef-build-tools/bin:$PATH"`가 그대로 필요하다. 미공개 소스로 검증만 할 때는 `bun build-macos.ts --embedded-browser --developer-id --allow-unpublished-source`처럼 직접 부른다(공식 배포본 아님).
- **산출물 위치**: `AGENTSTOZ_CARGO_TARGET_DIR`(절대 경로)가 있으면 그곳, 없으면 `~/cargo-targets/portmanager-devid`. 기본 빌드의 `~/cargo-targets/portmanager`(설치·「DMG 출시하기」가 집는 곳)를 덮지 않는다. 이 환경변수는 기본 빌드에도 통한다. 영수증·공증 로그는 `<target>/release/developer-id/`.
- **하는 일** (`src/macOSDeveloperIdBuild.ts`): 시작 전에 키체인의 `Developer ID Application: … (DA8QKAQ2C9)` 하나와 공증 키를 확인한다(없으면 빌드 전에 실패). Tauri가 만든 앱의 Mach-O를 모두 찾아 **안쪽부터** 서명한다 — `Resources/resources`·`Library/LaunchServices`의 실행 파일 → CEF dylib → framework → helper 앱 → 앱. 모두 hardened runtime + 보안 타임스탬프, `--deep`은 쓰지 않는다. 그다음 deep/strict 검증, 조각마다 Team ID 앵커와 정확한 엔타이틀먼트 확인, 앱의 지정 요구사항 확인 → `xcrun notarytool submit --wait` → **Accepted가 아니면 공증 로그를 출력하고 실패** → staple·validate → `spctl`이 `source=Notarized Developer ID`인지 확인. 이 빌드가 만든 DMG가 있으면 공증된 앱으로 다시 만들어(hdiutil, Tauri DMG의 창 배치 없음) 서명·공증·스테이플한다.
- **기존 키체인 프로필 선택 (2026-10-28)**: `bun build-macos.ts --developer-id --notary-profile <기존 이름> [--notary-keychain /absolute/path]`. `--embedded-browser`와 조합할 수 있다. 프로필을 명시하면 raw API 키 설정/파일을 읽지 않고 `checkMacOSNotary`의 읽기 전용 history 검사로 검증한다. 빌드 전과 각 제출 직전에 같은 프로필을 확인하며 실패하면 raw 키로 대체하거나 자격 증명을 생성·추출하지 않는다. 프로필 미지정은 기존 `~/.appstoreconnect/agentstoz-asc.json` 경로 그대로다. `--notary-keychain` 단독·중복·상대 경로·`--developer-id` 없는 선택은 거부한다. 미확정 제출은 자동 재시도하지 않고 같은 인증의 history로 확인한다. 공개 clean-source 가드·Developer ID 팀·entitlement·서명·설치 제한은 바뀌지 않았다. 관련 유닛 검증은 합성 러너만 사용하며 실제 메인 앱 공증의 증거가 아니다.
- **지정 요구사항**: `identifier "com.intenet.agentstozbycs" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = DA8QKAQ2C9` — 같은 팀의 Developer ID 서명 없이는 흉내 낼 수 없다.
- **엔타이틀먼트는 조각마다 따로**(GUI 것을 helper에 주지 않는다):
  - GUI: 마이크(`device.audio-input`, 음성 도크 — `Voice.entitlements`) + **Apple Events**(`automation.apple-events`). 앱과 사이드카가 osascript로 Terminal·iTerm·System Events·Orca·ChatGPT를 부르고 TCC는 그것을 앱의 요청으로 본다. hardened 앱에 이 엔타이틀먼트가 없으면 묻지도 않고 거절된다. 화면 기록(screencapture)·손쉬운 사용(kmsg, System Events 키 입력)은 엔타이틀먼트가 아니라 TCC 허용이라 더하지 않는다. 카메라는 Mac 앱이 쓰지 않는다(QR 카메라는 휴대폰 포털). Info.plist에는 마이크·Apple Events 설명 문구가 이미 있다 — 단 Apple Events 문구는 ChatGPT만 말한다.
  - bun으로 컴파일한 사이드카 3개(API·USE MCP·런타임 가드): `cs.allow-jit` **하나만**. 실측(이 Mac, Developer ID + hardened runtime으로 서명한 가드 사본): 없으면 JavaScriptCore가 조용히 인터프리터로 떨어져 같은 루프가 0.14초 → 6.15초가 되고, `bun:ffi`(`src/localMetadataFile.ts`)는 예외를 던진다. allow-jit만으로 둘 다 정상 — unsigned-executable-memory·disable-library-validation은 필요 없다.
  - CEF Renderer·GPU helper: `cs.allow-jit`(V8·SwiftShader). Chrome이 자기 helper에 주는 것과 같다. 기본·Plugin·Alerts helper, framework·dylib, kmsg, 런타임 broker·fixture: 없음.
  - 계획 표에 없는 Mach-O가 번들에 나오면 **빌드를 멈춘다** — 추측한 권한으로 서명하지 않는다. 새 실행 파일을 넣으면 그 표에 엔타이틀먼트와 함께 더할 것(`tests/macos-developer-id-build.test.ts`).
- ⚠️ **처음 설치할 때 TCC 권한을 한 번 다시 허용해야 한다.** 지정 요구사항이 바뀌어 macOS가 다른 앱으로 본다 — 마이크, 자동화(Apple Events: Terminal·iTerm·System Events…), 손쉬운 사용, 화면 기록, 파일·폴더 접근. 그 뒤로는 같은 팀·식별자라 업데이트해도 유지된다. ad-hoc 빌드로 되돌리면 한 번 더 묻는다. 키체인 항목은 `/usr/bin/security`로 읽고 쓰므로 영향이 없을 것으로 본다(확인하지 않았다).
- ⚠️ **한 번이라도 실행한 공증 번들은 제자리에서 다시 서명할 수 없다.** 그 안의 코드가 한 번 돌면 macOS가 번들을 보호해(App Management, `com.apple.macl`) `codesign --force`가 `internal error in Code Signing subsystem`, `chmod`·`touch`가 `Operation not permitted`로 실패한다(2026-10-25 재현). 번들을 통째로 지우는 것은 된다. 빌드는 매번 Tauri가 새로 만든 번들에 서명하므로 영향이 없고, 손으로 다시 서명할 때만 문제가 된다 — 새로 빌드하거나 복사본에 할 것.
- **검증 (2026-10-25, v1323, 미공개 소스 `8cc598f0`)**: `codesign --verify --deep --strict` 통과, 요구사항에 `certificate leaf[subject.OU] = DA8QKAQ2C9`, 공증 Accepted(issues 없음), `stapler validate` 통과, `spctl` → `source=Notarized Developer ID`, `syspolicy_check distribution` 통과. 서명된 사이드카 3개는 hardened runtime에서 JIT·`bun:ffi`가 동작하고 USE MCP는 `initialize`·`tools/list`(107개)에 답했다. kmsg와 broker·fixture도 실행된다. DMG 경로는 같은 계획으로 서명한 v1263 사본으로 공증·스테이플까지 확인했다. **GUI·CEF·마이크·Apple Events는 실행해 보지 않았다** — 설치된 앱이 3001을 쓰고 있어서였다.

### 실시간 빌드 로그 모달
- **UI 컴포넌트**: 풀스크린 모달 (App.tsx:743-815)
  - 헤더: 빌드 타입 표시 (App/DMG), 진행 상태 아이콘
  - 로그 영역: 스크롤 가능한 터미널 스타일 로그
  - 푸터: 로그 라인 수 표시, 로그 복사 버튼
- **색상 코딩**:
  - ✅ (초록): 성공 메시지
  - ❌ (빨강): 에러 메시지
  - ⚠️ (노랑): 경고 메시지
  - 일반 텍스트 (회색): 기본 로그
- **실시간 업데이트**:
  - 1초마다 `/api/build-status` 폴링
  - 중복 로그 자동 필터링
  - 빌드 완료 시 자동 감지 및 폴링 중지
  - 10분 타임아웃 보호

### 빌드 프로세스
- **앱 빌드 (handleBuildApp)**:
  - `bun run tauri:build` 실행
  - .app 번들 생성
  - Applications 폴더 설치 가능
- **DMG 빌드 (handleBuildDmg)**:
  - `bun run tauri:build:dmg` 실행
  - 배포용 DMG 파일 생성
  - Desktop으로 자동 복사 가능
- **백그라운드 실행**: 빌드는 별도 프로세스에서 실행되어 UI 블로킹 없음
- **로그 수집**: stdout/stderr를 실시간으로 캡처하여 Frontend에 전달

### 사용 방법
1. "앱 빌드" 또는 "DMG 빌드" 버튼 클릭
2. 자동으로 빌드 로그 모달 열림
3. 실시간으로 빌드 진행 상황 확인
4. 완료 후 모달 닫기 또는 로그 복사
5. 에러 발생 시 빨간색 메시지로 즉시 확인 가능
