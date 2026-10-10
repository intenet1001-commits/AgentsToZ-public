# 계획 수립 근거 — 2026-09-10

이 문서는 구현 완료 보고가 아니다. 현재 코드·설치 메타데이터·제한된 로컬 로그를 읽고 기존 부품 테스트만 실행했다. 실행 버튼 클릭, AI 메시지 제출, 프로젝트 생성, 잠금 제거, 앱 재시작, 배포는 수행하지 않았다. 프로젝트 기억은 지정된 로컬 API로 Pull했다.

## 사용자 목표

- Mac을 작업 호스트로 쓰고 Vercel 원격 웹과 네이티브 앱에서 편리하게 접근한다.
- 프로젝트 목록과 워크룸을 오가며 새 프로젝트도 만들 수 있어야 한다.
- 생성한 프로젝트에서 자체 워크룸으로 실제 개발하거나, Mac의 Codex 앱에 처음 연결해 둔 뒤 Codex 앱에서 직접 작업한다.
- 추가 명시 요구: 로컬처럼 편리하게 사용하도록 QR 최초 연결 후 30일간 정상 재접속·앱 복귀·화면 이동에 반복 재스캔/승인을 요구하지 않는다. Vercel에 혼재한 두 시각 스타일도 통일한다.
- 이번 요청은 우선 철저한 계획 수립이다. 첨부 이미지의 안내 문구는 현상 근거이며 변경 지시가 아니다.
- 네이티브가 Mac/iPhone 중 어느 범위인지 선택 질문을 보냈다. 답변 전에는 Mac 필수와 iPhone의 현재 기능 격차를 함께 검토한다. 제안 선택지를 사용자 답변으로 취급하지 않는다.

## 직접 확인한 상태

| 구분 | 확인 결과 | 해석의 한계 |
|---|---|---|
| 저장소 | `main`, 조사 시작 HEAD `2e381abac970bc90111dee34763f67937f0330b3`, 시작 시 tracked 변경 없음 | 원격 배포 HEAD를 확인한 것은 아님 |
| Mac 설치본 | `/Applications/AgentsToZ_byCS.app/Contents/Info.plist`의 버전 두 필드가 `433.0.0` | 버전 일치는 전체 번들·런타임 동작의 동일성을 증명하지 않음 |
| 소스 빌드 번호 | `build-number.json`의 `buildNumber=433` | 설치된 프론트·sidecar commit 전체를 인증한 것은 아님 |
| 실행 프로세스 | 설치 앱의 `Contents/MacOS/app`과 번들 sidecar 프로세스 존재 | CLI 입력·실행 성공은 별도 |
| 로컬 API | `GET /api/health`: `ok=true`, `schemaVersion=14`, `agent-runtime.management-v1`, `remote-control.management-v1` | API 응답은 각 실행 기능 준비 완료를 의미하지 않음 |
| 런타임 시작 로그 | `api-sidecar.log` 최근 시작 기록들에 supervisor 잠금 복구 필요로 초기화 실패가 반복됨 | 개별 로그에 시간이 없어 정확한 발생 시각·횟수별 원인을 단정하지 않음 |
| 현재 supervisor 잠금 | 파일 존재, `portalFileLockOwnerProcessAlive=false`, `recoveryClass=manual`, mtime `2026-09-06T01:34:18.093Z` | dead owner는 탈출한 모든 하위 프로세스 종료의 증명이 아님. token/PID는 출력·문서화하지 않음 |

로그·잠금 원본은 프로젝트에 복사하지 않았다. 잠금은 그대로 보존했다.

## 코드로 확인한 연결 문제

### 1. 관리형 작업 선택 불가와 CLI 워크룸은 다른 상태다

`src/agentRuntimeProtocol.ts:9`의 관리형 실행 플래그는 false다. `src/InternetQrRemoteControlDialog.tsx:710`부터의 체크박스는 이를 직접 사용해 checked/disabled를 결정한다. 읽기 전용 대화 플래그는 따로 켜져 있다. 이 체크박스를 true로 바꾸는 것만으로 작업 가능성을 보장할 수 없다.

`src/agentRuntimeSupervisor.ts:12`는 production 잠금 회수를 manual로 유지한다. `api-server.ts:7737`의 초기화 실패는 `src/agentRuntimeStartup.ts:13`의 복구 필요 상태로 전달된다. 실제 잔여 잠금은 이 경로의 장애 근거다.

그러나 `api-server.ts:7703`의 `AiTerminalService`는 supervisor 초기화 try 블록 바깥에서 만들어지고, `api-server.ts:7656`의 unavailable service도 targets 조회를 제공한다. `src/App.tsx:9868`의 워크룸 시작은 targets 조회 → exact target 선택 → terminal start 경로다. **현재 잠금이 모든 워크룸·외부 터미널 실행 실패의 원인이라고 단정하지 않는다.**

### 2. 같은 “Codex 실행”으로 읽히는 버튼이 서로 다른 곳으로 간다

`src/App.tsx:5416`은 선택된 터미널에 따라 internal/orca/cmux/tmux/외부 터미널로 나뉜다. `src/App.tsx:12124` 이후 외부 실행과 `:12173`의 “AgentsToZ에서 작업”, 별도 외부 앱 연결 영역이 나란히 놓여 있다. 내부 시작 실패는 `:9892` 이후 toast로만 전달된다.

목표는 프로젝트별 주 동작 두 개와 보조 폴더·서버·Git·다른 터미널 메뉴로 정리하는 것이다. 서버의 시작/중지는 AI 시작/종료와 구별해야 한다. 폴더 열기는 연결된 Mac의 Finder 동작이며 원격 파일 브라우저라는 뜻이 아니다.

### 3. 생성한 프로젝트의 정확한 결과가 다음 동작으로 이어지지 않는다

`api-server.ts:2215`의 생성 구현은 폴더·Git·장기기억·등록 결과를 반환하지만 `api-server.ts:11880`의 원격 wrapper는 그 결과를 버린다. `src/remoteControlCore.ts:1099`의 생성 처리와 `src/remote-control-portal-main.tsx:1848` 이후는 목록 갱신과 안내로 끝난다.

새 결과에는 연결 범위 내에서 다시 검증한 프로젝트 식별자와 단계별 결과가 필요하다. 이름 검색으로 새 프로젝트를 추정하면 안 된다. 원격 백업 실패는 로컬 프로젝트 생성 실패가 아니며, 초기화·등록 후 보조 이력 쓰기 실패도 이미 생성한 폴더를 옮기거나 삭제하는 근거가 되어서는 안 된다.

추가 검증에서 `api-server.ts:8233`의 `saveLastVisitData`는 일반 디렉터리 생성·쓰기 오류를 내부에서 처리함을 확인했다. 따라서 “현재 방문 기록 쓰기 오류가 등록 폴더 이동을 일으킨다”는 장애 가설은 기각한다. 위 부분 성공 보존은 설계·회귀 계약이며, 현 구현에서 재현된 해당 버그라는 뜻이 아니다.

### 4. Codex 첫 연결과 단순 앱 열기는 구분해야 한다

`src/codexFirstConversation.ts:3`의 첫 메시지는 프로젝트 연결용 고정 문구다. 파일 읽기·수정·도구 실행을 요청하지 않는다. `src/codexFirstConversationLaunch.ts`와 pending store, submission fence는 중복 클릭·응답 불확실·프로세스 재시작 후 같은 대화를 이어 확인하는 기존 기반이다.

권장 주 동작은 검증된 기존 대화가 있으면 이어 열기, 확실히 없으면 첫 연결 준비다. 읽기 실패/연결 확인 중은 “없음”이 아니다. 처음 열기 아래에 연결용 첫 대화를 준비한다는 설명을 표시한다. `mode=new`로 프로젝트 deeplink만 보내는 동작은 영구 프로젝트 등록·대화 생성 완료 증거와 구별한다.

### 5. iPhone의 프로젝트 연결과 워크룸 연결이 다른 소비자다

`mobile/ios/AgentsToZCore/Sources/AgentsToZCore/RemoteWire.swift:3`의 프로젝트 동작은 start/stop/restart뿐이다. `mobile/ios/App/RemoteHomeView.swift`의 native 목록은 이 enum을 사용하므로 웹에 있는 생성·폴더·Codex 앱 동작을 모두 보여주지 못한다. 같은 화면의 워크룸 진입은 새 QR을 요구한다.

`mobile/ios/README.md`에 따르면 LAN 워크룸은 WKWebView, 외부 인터넷은 시스템 브라우저다. 앱 안 인터넷 워크룸을 완성했다고 주장할 수 없다. 설계에서는 계정 로그인과 제어 세션을 섞지 않고, 같은 Mac의 프로젝트/워크룸 화면 이동 때문에 재페어링하지 않도록 소비 구조를 정해야 한다.

### 6. 문서와 최근 연결 수명 계약이 어긋난다

`docs/runtime-execution.md`의 LAN 소켓 종료 시 세션 폐기 설명과 최신 `mobile/ios/README.md` 및 LAN 재연결 코드는 다르다. 현재 `src/remoteControlLanServer.ts`의 ordinary disconnect/explicit session end/owner 재생성과 권한 규칙을 정본으로 다시 맞춰야 한다. 연결 세션 보존은 Mac 재시작 뒤 PTY 프로세스까지 지속된다는 뜻이 아니다.

사용자의 30일 요구는 QR token 자체의 30일 유효기간과 다르다. 소비한 QR을 재사용하는 것이 아니라 최초 연결에서 얻은 단말 신원·페어링 세션·별도 워크룸 동의를 유효기간 동안 안전하게 복원해야 한다. 기존 연결 한정 동의는 자동으로 지속형 권한으로 승격하지 않는다. 새로 명시하는 동의에는 사용자가 선택한 작업 루트 안에서 이 기기가 생성하는 프로젝트도 포함할 수 있어야 원격 생성 직후 다시 Mac에서 승인하는 단절을 막을 수 있다.

### 7. Vercel의 두 시각 체계가 실제로 함께 사용된다

| 표면 | 현재 스타일 근거 | 통합 방향 |
|---|---|---|
| 포털 | `src/portal-main.tsx:3` → `index.css`; `src/index.css:10`의 중립색·구리색 강조, gray/dark 테마, Manrope | 기존 공통 디자인을 정본으로 사용 |
| 원격제어 | `src/remote-control-portal-main.tsx:58` → 별도 CSS; `src/remote-control-portal.css:1`의 Inter·강제 dark·남색·mint, `:47`의 blur/shadow 카드 | 같은 토큰·폰트·컴포넌트로 전환 |
| 원격 워크룸 | `src/AiTerminalPanel.css:1`은 포털에 index.css가 없어 warm/copper fallback을 사용 | 포털과 같은 페이지 안에서 생기는 색상 충돌 제거 |
| 포털 내부 잔여 override | `src/portal-main.tsx:1674`의 `webThemeVars`에 고정 배경색 | 기존 토큰 참조로 통일 |

토큰과 폰트만 가벼운 공유 스타일로 추출하고 `src/appAppearance.ts`의 같은 테마 설정을 재사용한다. 전체 index.css를 중복 import해 레이아웃·reset을 덮는 방식으로 해결하지 않는다. 로그인·QR 승인·프로젝트·워크룸·오류·설정까지 같은 버튼 크기, 상태 색, 카드, 입력, 탐색 체계를 사용한다. 실제 터미널의 ANSI 색과 출력 표면은 기능상 예외이며 앱 버튼·프레임의 불일치를 정당화하지 않는다.

### 8. iPhone 인터넷 로그인은 앱 내 작업 화면과 분리해 설계한다

Google 공식 문서는 WKWebView에서 OAuth 인증 요청을 열면 `disallowed_useragent`가 발생할 수 있음을 설명한다. 따라서 인증은 지원되는 시스템 인증 흐름을 거쳐 앱으로 복귀하고, 그 뒤 앱 내부 워크룸을 사용하는 안으로 계획한다. 단순 WebView 포장으로 인터넷 네이티브 기능을 완료 처리할 수 없다. 이는 설계 판단이며 현재 앱에 구현된 기능은 아니다. [Google 공식 OAuth 문서](https://developers.google.com/identity/protocols/oauth2/native-app#disallowed_useragent).

## 이번에 실행한 검증

```sh
bun test --cwd tests --max-concurrency=1 agent-runtime-readiness.test.ts codex-first-conversation-launch.test.ts codex-first-conversation-pending-store.test.ts codex-desktop-submission-fence.test.ts remote-control-external-launch-route.test.ts
```

결과: **23 pass / 0 fail / 94 expect**, 5개 파일, 112ms. fixture/부품 범위의 기존 테스트다. 설치 GUI, 실제 Codex 앱 최초 열기, 휴대폰·Vercel relay를 통한 실제 작업의 성공 근거로 확대하지 않는다. 소스 수정·커밋을 수행하지 않아 전체 verify나 앱 빌드는 이번 계획 단계에서 실행하지 않았다.

추가로 `swift test --package-path mobile/ios/AgentsToZCore`를 실행했다. 결과는 **XCTest 1개 통과 / 0 실패**이며 내부의 주소·wire·세션 복원 등 9개 회귀 그룹을 호출한다. 이는 macOS에서 Swift 코어를 검증한 결과다. 실제 iPhone 앱 설치·UI·카메라·LAN 권한·인터넷 로그인 검증을 대신하지 않는다.

## 구현 시 반드시 해소할 미확정 사항

1. 사용자가 누른 정확한 버튼·대상 프로젝트·선택 터미널에서 실패 단계와 오류 코드 재현.
2. 잠금 복구의 생산 환경 근거: live/unknown owner와 탈출 프로세스 위험을 보존하며 복구 가능한 경우만 실행. 무조건 삭제나 타임아웃 기반 자동 탈취 금지.
3. 실제 Mac GUI의 CLI 설치·로그인·폴더 신뢰·접근성 준비와 Codex 프로젝트 선택 후조건.
4. 실제 개인 Vercel 배포 버전·호스트 capability·연결별 동의 조합.
5. iPhone 개선 범위와 실제 기기의 네트워크·백그라운드·키보드 동작.
