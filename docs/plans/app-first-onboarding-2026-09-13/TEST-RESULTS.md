# 새 앱 기능 검증 결과

2026-09-13 · 진행 중. [TEST-PLAN.md](TEST-PLAN.md)의 실행 기록이다.
온보딩 소스 `901dac2c`, iOS 대화창·테스트 앱 실행 격리 수정 `098bb589`. 설치 Mac은 v464다. 후속 저장·종료 수정은 아래에 별도로 기록한다.

| 항목 | 결과 | 근거/제한 |
|---|---|---|
| 타입 검사 | 통과 | 이번 변경본 tsc --noEmit |
| 온보딩 집중 회귀 | 통과 | 24 pass / 0 fail, 4개 파일 |
| 프런트 production build | 통과 | 기존 chunk 크기 경고는 남음 |
| 실제 App 번들 온보딩 fixture | 통과 | 첫 프로젝트 초기 옵션/재개/Control/연결 센터/첫 작업 이동 |
| 준비 기록 UI | 통과 | 기록 보존/복사/clipboard 실패 대안 |
| 첫 실행 UI | 통과 | 격리 fixture, 실제 계정 생성 아님 |
| 워크룸 입력 | 통과 | 13개 시나리오. IME 이벤트 fixture이며 실제 Mac IME와 구분 |
| 저장·종료 footer | 통과 | Chromium/WebKit 각 7개, 총 14개 시나리오 |
| 화면·터미널 렌더링 | 통과 | Chromium/WebKit × desktop/mobile 4개. 출력/숨김 복원/저장 상태 조회 및 밝은·어두운 테마 버튼 대비 4.5:1 이상 |
| 모바일 승인 UI | 통과 | 375/1024px × 선택 프로젝트/루트/전체/불완전 목록 8개 |
| 워크룸 사용성 | 통과 | 34개 그룹: 자동 기억/복구/키체인 실패/입력 중 상태 변경 |
| 전체 verify | 통과 | 타입 검사 + Bun 4,234 pass / 0 fail + sidecar 빌드 + Rust 58 pass / 0 fail |
| iOS native 회귀 | 통과 | 11개 그룹. pairing/list/confirmed action/resume/redirect/cancel은 로컬 시험 |
| 실제 iPhone | 부분 통과 | 13 Pro Max/iOS 26.3에 USB v464 설치·실행. 격리된 실기 WKWebView의 대화창·LAN·PTY·복귀·재연결 32개 검사 통과. 개인 외부 연결 전체 성공과 구분 |
| 새 Mac 앱 | 설치·실행 통과 | v464, source 901dac2c, 서명 검증 후 정상 사용자 환경으로 실행 |
| Mac TestFlight | 미완료 | 인증서 준비와 실제 서명/업로드/설치는 별개 |

## 검사 도중 수정

- 실제 화면 검토에서 밝은 테마의 저장 영역이 어두운 고정 배경과 어두운 버튼 글자를 함께 사용함을 확인했다.
  저장 영역과 종료 확인창을 앱 테마 색상에 연결했다. 네 가지 브라우저/화면 조합에서 두 테마의 버튼 대비를 검사하고 WebKit 모바일 결과를 직접 확인했다.
- `workroom-rendering.e2e.mjs`와 `workroom-usability.e2e.mjs`가 새 footer의 `workspace/workroom.status` 요청을 처리하지 못했다.
  순수 렌더링 시험은 resize만 예상했고 사용성 시험은 최상위 sessionId만 찾았다.
- 두 fixture를 실제 요청 계약에 맞췄다. 상태 조회 action/target/session을 검증하고 원격 fixture에 별도 workspace transport를 연결했다.
  테스트가 임의 요청을 성공 처리하지 않는다. 렌더링에서는 footer의 준비 상태·오류 없음도 검사한다.
- 실제 제품의 원격 진입은 이미 별도 workspaceTransport를 전달하고 있다. 이 실패를 제품 수정으로 부풀리지 않는다.

## 로그

로컬 `/tmp/agentstoz-testplan-*.log`에 각 러너의 결과가 있다.
주요 로그: `verify`, `focused`, `build`, `onboarding-app`, `workroom-input`,
`workroom-footer`, `workroom-render`, `workroom-usability`, `approval`, `ios`.
키/계정 비밀/원본 대화는 기록하지 않는다.

## 남은 관문

최종 검사 → source 검토/커밋/공개 snapshot → 새 Mac 앱 빌드 → 버전·sidecar 일치 →
테스트 전용 프로젝트의 CLI/저장 → 실제 iPhone 왕복 → 업데이트/새 사용자/장시간 시험.
미구현 온보딩 전체 자동 설정·다중 OS 사용자 endpoint는 통과로 계산하지 않는다.

## 설치 후 실제 환경에서 발견한 결함

- 기존 v463 프로세스가 `agentstoz-use-api-*` 임시 HOME으로 실행되어 테스트 프로젝트 4개를 표시하고 실제 MCP controller ID 조회를 거부했다. 실제 사용자 ports.json의 138개 행은 보존되어 있었다.
- Workroom HTTP 회귀의 `start-workroom-session`이 `/usr/bin/open`으로 실제 설치 앱을 열던 것이 원인이었다. 테스트 전용 프로세스 entrypoint에서 정확한 앱 열기 호출만 기록하도록 격리했다. 네 CLI 시작마다 기록되는 요청도 검사한다(16 pass). 생산 앱의 실행 함수는 바꾸지 않았다.
- v464를 정상 사용자 환경으로 재시작한 뒤 앱의 138개 행과 MCP에서 경로 검증을 통과한 94개 프로젝트를 확인했다. 등록 행 수와 실행 가능한 프로젝트 수는 서로 다른 값이다.
- **모바일 생성 무반응:** iOS WKUIDelegate에 JavaScript confirm/prompt/alert 처리가 없었다. 개인 포털의 `createProject()`는 confirm 결과가 false면 생성 요청 전에 반환한다. 네이티브 확인·취소·텍스트 입력창을 추가했다. 동일 origin의 main frame만 받으며, 취소·세션 종료·중복 응답은 승인으로 바꾸지 않는다. 연속 confirm→prompt는 이전 창의 dismiss 완료 후 이어진다.
- 실제 iPhone의 테스트 앱에서 다섯 대화창 결과(확인 수락/취소, 한글 입력/취소, 안내)와 중복 응답 무시를 검증했다. 초기 반복 실패는 다음 창이 이전 dismiss 완료 전에 요청되는 문제를 찾는 데 사용했다. 테스트 UI task의 중복 진입도 막았다.
- USB 일반 앱 v464의 최종 설치 빌드는 **260913123410**, 소스 `098bb589`다. 대화창 수정을 포함해 iPhone 13 Pro Max에서 설치·실행했다. 기존 TestFlight v462에는 아직 이 수정이 없다.
- 실제 Codex·Claude Code·Antigravity CLI에서 각각 `AGENTSTOZ-V464-CODEX-OK`, `AGENTSTOZ-V464-CLAUDE-OK`, `AGENTSTOZ-V464-AGY-OK` 응답을 확인했다. Claude는 Opus 5, agy는 Gemini 3.8 Flash였다. Hermes는 claude-opus-5로 시작했지만 OAuth 만료 HTTP 401로 응답 실패. `hermes auth status anthropic`은 logged in을 반환하므로 저장된 인증과 실제 요청 성공을 구분해야 한다.
- 프로젝트 생성 집중 회귀 40 pass 및 LAN 브라우저 동일 actionId 재시도/재로드 검사 통과. 실제 개인 인터넷 연결에서 폴더 생성까지 성공했다고 확대하지 않는다.

실기 근거: `mobile/ios/build/workroom-device-evidence/result.json` (ignored; actualIPhone=true, realAI=false, productionData=false).

## 확대 검사와 후속 결함

- AI 작업 composer 9개 시나리오 통과: 이전 요청의 늦은 성공/실패가 새 초안을 덮어쓰지 않음, 같은 requestId 재시도, 탭 전환 중 자동 이동 방지, 불완전 목록/조회 취소, Control 조정자와 4종 worker 선택, 125% 확대 접근성.
- 모바일 작업 패널 Chromium/WebKit 통과: 긴 발언 페이지 읽기, 초안 전달, 기억 저장 1회, 로컬/백업 상태 분리, 확인 뒤 대직 설정 요청.
- production 포털 빌드 통과. 모바일 shell Chromium/WebKit에서 탭 20회, 문서 이동 없음, 밝게/어둡게/기기 테마, 외부 터치·Escape·초점 복원, 가로 넘침 없음 검사 통과.
- 실제 Mac 워크룸 수동 저장과 ‘저장하고 종료’의 **로컬 저장·Supabase 백업 완료 영수증**을 확인했다. 그러나 종료 시 ‘저장 이후 활동’ 오류가 발생해 프로세스는 유지되었다.
- 원인: 저장 과정에서 `.agents/rules/agentstoz-output-style.md`를 다시 쓰는데 활동 fingerprint 제외 목록에는 이 앱 관리 파일이 빠져 있었다. 다른 사용자 활동 없이도 mtime 변경으로 닫기 검증이 실패했다.
- Git/일반 폴더에서 같은 결함을 재현하는 두 검사를 먼저 실패시킨 뒤, 정확한 앱 관리 경로만 제외했다. 사용자 `.agents/rules/my-project.md` 변경과 새 활동 marker는 여전히 종료 증거를 무효화한다. 집중 회귀 12 pass / 0 fail. 설치 앱에서 수정 후 같은 종료 동작 재검사는 별도 관문이다.

## iOS TestFlight 후속 시도

- `098bb589`의 v464.0.0(464) TestFlight 전용 archive 생성 성공. USB 앱과 배포 bundle ID는 각각 기존 값을 유지한다.
- 21:36 업로드 시도에서 Apple 서버의 업로드 준비 행은 생성됐으나, 실제 Payload의 Apple Distribution codesign 단계가 Keychain 응답 없이 멈췄다. 240초 제한 뒤 업로드 부모와 남은 해당 서명 프로세스만 정리했다.
- 업로드 완료·처리 완료·테스터 배포는 확인되지 않았다. 준비 행 ID는 업로드 성공 증거가 아니다. 비밀번호/키를 읽거나 키체인 보호를 우회하지 않았다.

- 저장·종료 수정 후 전체 verify 재실행: exit 0, typecheck + Bun 4,233 pass / 0 fail + Rust 58 pass / 0 fail (`/tmp/agentstoz-testplan-verify-close-fix.log`).
- 로컬에서 제공한 production 포털의 미연결 홈, Chromium 모바일 390×844, cold/warm 각 5회: cold LCP 중앙값 52ms/p95 132ms, warm 56ms/p95 60ms, CLS 0, TBT 0. 이는 로컬 정적 초기 화면 값이며 실제 외부망 로그인·프로젝트 목록·AI 응답 지연 수치가 아니다 (`/tmp/agentstoz-testplan-performance.json`).
- DEV 프로젝트 장기기억 sync 성공 후 검증된 교훈 3개 저장. Supabase content/journal/feedback 백업 완료를 개별 결과로 확인했다. 실기 테스트 프로젝트의 저장 영수증과 이 DEV 기록은 서로 다른 기억이다.

## 최신 산출물과 실제 확인 범위

| 대상 | 확인 결과 | 남은 조건 |
|---|---|---|
| Mac 설치 앱 | v464, 3종 CLI 실제 응답·수동 저장/백업·테스트 세션 종료 확인 | v465 교체 후 저장하고 종료 재검사 |
| Mac 새 산출물 | v465.0.0, 소스 `25bc474`, 공식 source guard 및 codesign deep/strict 통과 | 사용자 `actionfollow · codex` 세션 종료 동의 전에는 설치 앱을 재시작하지 않음 |
| iPhone USB | v464.0.0 / 260913123410, 소스 `098bb589`, 대화창 수정 포함 | 개인 외부망에서 생성→워크룸 입력→셀룰러 전환까지 전체 실기 |
| TestFlight | iOS archive 생성 완료, 업로드 배포 서명 정지. Mac 업로드 미완료 | Keychain 서명 완료 및 실제 배포본 다운로드 검사 |
| 웹 production | Vercel READY, 모바일 375×812 실배포 smoke 4/4 | 인증·실제 원격 제어 성공은 이 공개 홈 시험으로 증명하지 않음 |

실배포 smoke가 공개 기본 홈을 ‘인증된 관리 화면’으로 부르던 보고 오류도 수정했다.
`workspace-shell`을 별도 분류하고 Google 로그인 gate·기존 관리 화면과 구분한다.
실제 배포 재검사에서 ‘기본 작업 홈 정상 렌더 (로그인·원격 작업 검증은 별도)’로 4/4 통과했다.

테스트용 mobiletest의 Codex/Claude/Hermes/agy 5개 시작 세션은 모두 종료 상태를 확인했다.
사용자가 만든 actionfollow 세션, 원본 파일, 원격 승인 정보는 이 정리 대상이 아니다.
장시간 60분/2시간, 실제 30일 경과, 새 OS 계정 동시 실행, 신규 cloud OAuth 전체 온보딩,
실제 음성 전사→MCP, TestFlight 다운로드 후 개인 외부망 여정은 아직 통과로 계산하지 않는다.

최종 smoke 분류 수정까지 포함한 `bun run verify`는 exit 0, Bun **4,234 pass / 0 fail**, Rust **58 pass / 0 fail**, 타입 검사 통과다 (`/tmp/agentstoz-testplan-verify-final-report.log`). 테스트 전용 Vite/성능 서버는 종료했다.
