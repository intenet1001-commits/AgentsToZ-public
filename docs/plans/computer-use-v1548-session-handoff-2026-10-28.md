# Computer Use v1548 세션 인수인계 — 2026-10-28

사용자 요청: Git push 및 세션 저장. 이 문서는 Git에 보관하는 작업 인수인계이며,
정본 프로젝트 장기기억 저장 완료를 뜻하지 않는다.

## 반영한 릴리스

- 설치 버전: 메인 앱과 AgentsToZ Control 모두 **1548.0.0**.
- 설치 소스: `6bf0463766dfed2d214af5087deb1c9381ce074c`
  (`Add consented desktop and application computer control`).
- 비공개 `origin/main`에 소스 반영 완료. 세션 종료 시 같은 소스를 다시 push하여
  `Everything up-to-date`를 확인했다. 공개 `publish` remote에는 push하지 않았다.
- `/Applications/AgentsToZ_byCS.app` 및 `/Applications/AgentsToZ Control.app`에
  Developer ID 서명·공증·staple을 마친 앱을 설치했다.
- 메인 앱 공증 ID: `4e23f7f6-af54-45ab-88db-92f8c3ab9c38`.
- Control 공증 ID: `5f9b00b8-3a69-458b-8476-bc8bf29c5ed2`.
- 이전 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-pre-1548-scoped.app`
  및 `/Applications/.AgentsToZ-Control-backups/AgentsToZ Control-pre-1548-scoped.app`에 보존했다.
- 이 인수인계 문서의 추가 커밋은 설치된 실행 파일의 소스 커밋과 별개다.

## 구현과 동의 경계

정확한 계약은 [`native/computer-use/SCOPE-CONTRACT.md`](../../native/computer-use/SCOPE-CONTRACT.md)를 따른다.

- 전체 Mac·특정 앱·특정 창 범위를 추가했다. v2의 넓은 범위는 native Control에서
  별도로 승인해야 하며, 기존 v1 창 승인이 넓은 권한으로 확대되지 않는다.
- 승인은 범위·호출 연결 세대·메인 소유자·권한·만료에 결속하며 최대 10분이다.
  앱 범위는 서명된 정확한 프로세스 세대에 결속한다. 재시작·업데이트 후에는 재승인이 필요하다.
- MCP 계약 **1.66.0**의 새 도구는 `agentstoz_use_computer_session`이다.
  기존 인증된 MCP 연결을 사용한다. 대화별로 격리된 연결이라고 주장하지 않는다.
- ScreenCaptureKit의 디스플레이·앱 필터와 CGEvent의 클릭·입력·키·스크롤·드래그,
  관찰한 앱으로의 포커스 변경을 구현했다. 보호된 UI와 입력 대상 검증을 유지한다.
- 정상 이벤트 전송도 `dispatched-unverified`이며 관찰을 소비한다. 다음 동작 전 재관찰해야 하고,
  이벤트 전송만으로 작업 성공을 보고하지 않는다. 결과가 불명확하거나 부분 실행·사용자 개입이
  감지되면 중단하고 사람의 검토를 요구한다. 불명확한 동작은 자동 재전송하지 않는다.
- 키보드·텍스트는 실제 비보안 AX 포커스 leaf 확인이 필요하다. 이를 확인할 수 없는
  canvas 입력은 거부될 수 있다. 보호된 입력 검증을 우회하는 대안은 사용하지 않았다.
- 화면 필터와 전후 검증은 원자적이지 않다. 순간적인 보호 overlay의 완전한 제거를 보장하지 않는다.
- 잠금 검사는 동일 UID의 활성 GUI 세션 및 IORegistry `IOConsoleLocked`의 명시적 false를
  확인한다. 해당 키는 공개 SDK의 안정성 보장이 있는 API가 아니라 XNU 구현 진단값이다.

## 통과한 검사

| 검사 | 결과 | 이 Mac의 근거 |
| --- | --- | --- |
| 전체 verify·typecheck | Bun 9,301 pass / 12 skip / 0 fail, Rust 142 pass / 1 ignored / 0 fail; sourceUnchanged | `.agentstoz/maintainer/runs/20261028T130132Z-8f5919ce/report.md` |
| 페르소나 | 16 역할 / 74 checks; sourceUnchanged | `.agentstoz/maintainer/runs/20261028T131804Z-f43f62f1/report.md` |
| Native Swift | fake event sink 55 pass; 실제 OS 입력 검사가 아님 | `/private/tmp/agentstoz-scope-native-secure-focus-test.log` |
| UI Chromium·WebKit | 1100px·390px 검사 통과 | `/private/tmp/agentstoz-scope-ui-20261028.log` |
| 서명 패키지 격리 실행 | 임시 HOME 16/16 pass; 새 OS 계정 검사가 아님 | `/private/tmp/agentstoz-scope-fresh-1548/fresh-native-profile.json` |

실제 설치 앱의 화면에서 버전 1548·소스 `6bf04637`, v2 helper 연결, 세 범위 선택,
실행 앱 목록의 Orca(`com.stablyai.orca`)·Hermes(`com.nousresearch.hermes`)를 확인했다.
Orca를 선택하고 Return으로 선택값을 확정했다. v2 승인 요청은 아직 제출하지 않았다.
앞선 v1 실기 성공은 사용자가 직접 창을 열어 승인한 뒤의 결과다.

## 미완료와 다음 시작점

1. **v2 범위의 실제 사람 승인이 아직 없다.** 실제 화면 캡처·좌표·키보드·드래그·HID
   이벤트 구분·앱의 두 창 전환 실기 검사는 미완료다. Hermes·Orca 전체 연동 완료로 보고하면 안 된다.
2. 현재 대화의 도구 목록은 기존 `agentstoz_use_computer`만 노출했다.
   새 연결에서 MCP 1.66.0과 `agentstoz_use_computer_session` 노출 여부를 먼저 확인해야 한다.
3. 사용자가 승인 설정을 변경했다고 알린 뒤 재시도한 MCP도
   `MCP tool call requires approval, but approval policy is never`로 거부됐다.
   실행 중인 도구 호스트에 설정이 적용됐다고 추정하지 않는다.
4. Codex 자체 UI 조작은 `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`로
   거부됐다. 다른 앱·도구·에이전트나 임의 CLI 연결을 통해 이 거부를 우회하지 않는다.
5. 호스트 승인과 새 도구 연결이 실제로 확인되면, 사람의 native 범위 승인 후
   일회용 fixture에서만 입력·두 창·해제·만료 검사를 이어간다. 자체 승인을 하지 않는다.

준비만 된 자료:

- `/private/tmp/agentstoz-scope-fixture-20261028/mcp-pilot.ts`: 공식 설치 MCP 실행 파일을
  사용하는 pilot. **실행하지 않았다.** 호스트 정책 거부를 우회하는 용도로 실행하면 안 된다.
- `/private/tmp/agentstoz-scope-fixture-20261028/Scope Fixture A.app`:
  `dev.cswork.scopefixture.a`, 두 창 fixture. 실행했으나 실제 입력 검사는 하지 않았다.
- fixture B는 CUA 접근이 거부되어 다른 경로를 시도하지 않았다.
- 릴리스 체크포인트: `/private/tmp/agentstoz-scope-release-state-1548.json`.
- 메인 빌드 로그: `/private/tmp/agentstoz-scope-main-1548-build-20261028.log`.
- Control 빌드 로그: `/private/tmp/agentstoz-scope-control-1548-build-20261028.log`.

`/private/tmp` 근거는 이 Mac의 임시 파일이므로 이후 정리되면 사라질 수 있다.

## 정본 장기기억 저장 상태

- 정본 root: `/Users/cs-work/forcs/AgentsToZ_byCS`.
- memoryId: `884575df-63c4-407c-8b43-860d1295e663`.
- 이번 저장 전 동기화 시도 1회가 **HTTP 409**, `ok:false`, `action:"none"`으로 중단됐다.
  정본 기억 업데이트와 이번 세션의 Supabase 백업은 완료되지 않았다.
- `remember-session`의 “On conflict/HTTP 409, do not edit, overwrite, force, or retry.”에 따라
  기억 파일·생성 index를 수정하지 않았고, 강제 Pull·Push·동기화 재시도·`mark-remembered`도 하지 않았다.
- 전체 응답은 `/private/tmp/agentstoz-session-save-sync-20261028.json`에 0600으로 보존했다.
  원문 기억이 포함되므로 Git에 추가하거나 로그에 출력하지 않는다.
- primary checkout에는 다른 작업의 미커밋 변경이 있다. 세션 저장을 위해 일괄 stage·reset·stash·pull하지 않는다.
  원래 로컬 작업 일지는 `docs/plans/astra-reliability-2026-10-28.md`에 남아 있다.
- OPS 기억 후보 `aab72165-a330-40d7-9450-50840501b725`는 여전히 `saved:false`이며
  자체 승인하지 않았다. 공통 기억의 `COMMON_MEMORY_MIGRATION_REQUIRED`도 별도 미해결이다.

## 다음 세션에서 유지할 작업 원칙

- 창을 열었다는 반환값과 실제 전면 노출·내용을 구분한다. 화면을 확인하기 전에는
  “승인 창이 맨앞에 있다”고 보고하지 않는다. 빈 승인 대기를 유효한 승인 요청으로 보고하지 않는다.
- 구현·단위검사·설치 UI 확인·사람 승인·실제 입력·작업 성공을 각각 근거에 따라 구분한다.
- 사용자에게 같은 설정 변경을 반복 요청하기 전에 실제 연결 세대·도구 버전·승인 상태를 확인한다.
- 기존 프로젝트 기억·사용자 데이터·다른 에이전트 변경을 보존한다.
