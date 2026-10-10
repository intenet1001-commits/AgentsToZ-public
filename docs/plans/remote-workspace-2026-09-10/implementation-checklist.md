# 구현 체크리스트: Mac·웹·iOS 프로젝트와 워크룸

이 문서는 계획 당시의 구현 순서와 출하 조건이다. 아래 미체크 항목은 전체 조건 충족을 뜻하지 않으며, 실제 구현·테스트·미검증 범위는 [실행 증거](./execution-evidence.md)에서 구분한다. 계획의 28개 계약 전체와 설치·배포 완료를 일괄 체크하지 않는다. [domain-analysis.md](./domain-analysis.md)의 7개 유스케이스·Receipt/Grant 계약, [architecture.md](./architecture.md)의 경계, [tdd-strategy.md](./tdd-strategy.md)의 **28개 테스트명**을 정본으로 사용한다. 테스트명은 아래 RED에 각각 한 번 등장한다.

## 환경 설정

- [ ] 기존 React/TypeScript·Bun·Rust·Swift 테스트 환경을 그대로 사용한다. 새 프레임워크 설치·프로젝트 재초기화·일괄 파일 이동은 하지 않는다.
- [ ] 작업 시작 시 로컬 변경과 원격 기본 브랜치를 확인하고 필요한 격리 작업공간을 준비한다. 운영 포트 3001·실제 app-data·사용자 CLI 대신 임시 파일/Git fixture·fake provider를 사용한다.
- [ ] 현재 설치본의 사용자가 누른 버튼→Tauri 요청→target 해석→spawn→첫 출력 결과를 재현한다. 로그는 호스트/기능/단계/시간/오류 코드만 보존하고 token·PID·원시 경로·대화 원문은 넣지 않는다.
- [ ] P0~P6는 PLAN의 납품 단계다. 실제 구현은 아래처럼 **순수 정책·Receipt/Grant → use case → 저장/전송 adapter → Mac UI → 웹/iOS → 설치 검증** 순서로 진행한다. P4 권한의 도메인 계약은 원격 UI보다 먼저 만든다.

## P0 — 준비 상태와 복구의 순수 정책

파일: `src/projectLaunchPolicy.ts`, 기존 `src/agentRuntimeReadiness*.ts`, `src/agentRuntimeSupervisor.ts`. 테스트: `tests/agent-runtime-readiness.test.ts`, `tests/project-launch-receipt.test.ts`, `tests/portal-file-lock.test.ts`, `tests/agent-runtime-guard-registry.test.ts`, `tests/agent-runtime-restart-e2e.test.ts`.

- [ ] 🔴 RED: `runtimeReadiness_supervisorUnavailable_preservesIndependentActions` — supervisor 실패·CLI/앱 준비 상태를 조합해 전역 차단을 잡는다.
- [ ] 🔴 RED: `projectLaunchStatus_osOpenAccepted_doesNotClaimWindowConfirmed` — 전달 요청·실행/선택 확인·로그인·실제 작업 완료를 분리한다.
- [ ] 🔴 RED: `runtimeSupervisor_deadOwnerWithoutContainment_refusesRecovery` — dead PID·시간 경과만으로 복구하지 않는 계약을 고정한다.
- [ ] 🟢 GREEN: 워크룸 CLI·읽기 전용 지속 대화·관리형 실행·Codex 앱 상태를 독립 계산하고 stale/unknown·다음 행동을 반환한다. 기존 targets 제공을 유지한다.
- [ ] 🟢 GREEN: supervisor 복구는 정확한 owner/부팅 세대·권한 종료 증거가 있는 지원 경로만 허용한다. 증거 없는 legacy lock은 확인 필요로 남긴다. 관리형 flag·잠금 삭제로 우회하지 않는다.
- [ ] 🔵 RFCT: 관측 adapter와 표시 정책을 분리해 React/Bun/Tauri import가 순수 정책에 들어오지 않게 한다.

## P1·P4 선행 — Value Object, Receipt/Grant, Repository와 Fake

파일: `src/projectLaunchReceipt.ts`, `src/remoteTerminalGrant.ts`; 테스트: 새 `tests/project-launch-receipt.test.ts`, `tests/remote-terminal-grant.test.ts`와 기존 vault 테스트.

- [ ] 🔴 RED: `projectLaunchReceipt_sameRequest_returnsOriginalReceipt` — 같은 요청 원자 reserve와 CAS 경쟁을 검증한다.
- [ ] 🔴 RED: `projectLaunchReceipt_changedIdentity_rejectsRequestReuse` — host/owner 격리와 같은 key의 다른 intent 충돌을 검증한다.
- [ ] 🔴 RED: `projectLaunchReceipt_unconfirmedDispatch_requiresReconciliation` — 부작용 여부 미확정인 재시작에서 결과 조회를 먼저 요구한다.
- [ ] 🔴 RED: `remoteTerminalGrant_sameDeviceReconnect_reusesExplicitGrant` — 승인+29일 23:59·장기 offline 복귀·Mac/기기/sidecar 재시작에서 QR/승인 반복 없이 같은 기기를 복원한다.
- [ ] 🔴 RED: `remoteTerminalGrant_changedBindingOrExpiry_requiresNewConsent` — 정확히 승인+30일, 다른 host/controller, revoke, scope 밖 대상과 조작을 거부한다.
- [ ] 🔴 RED: `remoteTerminalGrant_legacySessionScope_doesNotMigrateConsent` — 기존 task/conversation/session-only 동의를 지속형 권한으로 승격하지 않는다.
- [ ] 🟢 GREEN: domain의 `ProjectLaunchReceiptRepository.find/reserve/update`와 `RemoteTerminalGrantStore.find/update`를 그대로 선언하고 Map fake를 만든다. identity·fingerprint·stage·revision·유한 길이를 검증한다.
- [ ] 🟢 GREEN: grant는 stable host/controller+scope+grantedAt+expiresAt+revocation revision에 결속한다. grantedAt은 QR 발급일이 아닌 최초 pairing/SAS 승인 시각이고 30일·승인 세션 상한을 넘겨 연장하지 않는다.
- [ ] 🟢 GREEN: scope는 selected targets 또는 명시 선택 root의 `이 기기가 만든 프로젝트 포함`이다. 후자는 root identity+같은 controller creation Receipt+현재 등록 신원을 매 실행 검증한다. 다른 기기/전체 프로젝트를 자동 포함하지 않는다.
- [ ] 🔵 RFCT: Receipt는 결과, Grant는 승인 범위, socket epoch는 현재 연결 증명으로 구분한다. 새로운 WorkroomSession 등 기존 세션 동의어를 만들지 않는다.

## P1 — 프로젝트 생성 Use Case와 영속 어댑터

파일: `src/projectLaunchCoordinator.ts`, `src/projectLaunchReceiptStore.ts`, 기존 `api-server.ts`의 `createAgentsToZUseProject/createRemoteControlProject`, `src/remoteControlCore.ts`. 테스트: `tests/project-launch-receipt.test.ts`, `tests/remote-control-core.test.ts`, `tests/remote-control-project-card.test.ts`.

- [ ] 🔴 RED: `projectCreate_createdOutsideFirstPage_selectsExactProject` — 첫 페이지 밖에 정렬되는 새 프로젝트도 반환 ID로 선택한다.
- [ ] 🔴 RED: `projectCreate_postRegistrationFailure_preservesRegisteredFolder` — 현재 nonblocking인 일반 lastVisit I/O 실패를 유지하고, 추출 뒤 등록 후 부가 예외·백업 지연이 폴더 이동으로 이어지지 않는 예방 계약을 고정한다.
- [ ] 🔴 RED: `projectCreate_lostResponse_reconcilesOriginalRegistration` — mkdir 전/후·등록 직후 crash와 응답 유실에 프로젝트가 복제되지 않게 한다.
- [ ] 🟢 GREEN: 부작용 전에 projectId/root identity를 Receipt에 원자 예약하고 기존 parent/directory lease를 재사용한다. 등록 전 예약 ID는 생성 성공으로 표시하지 않는다.
- [ ] 🟢 GREEN: 폴더+등록을 commit point로 삼고 정확한 created controlId·카드·단계 결과를 반환한다. 같은 이름의 기존 폴더를 이번 생성으로 입양하지 않는다.
- [ ] 🟢 GREEN: Git·장기기억 기본 준비를 유지한다. 등록 뒤 최근 방문·백업은 nonblocking이고 실패 상태와 원본을 보존한다. 초기 Git baseline 실패는 main 워크룸을 막지 않으며 worktree 생성만 기존 gate로 제한한다.
- [ ] 🟢 GREEN: private app-data 파일/기존 잠금으로 Receipt reserve/CAS를 구현하고 같은 계약을 실제 저장 fixture에 적용한다. Codex pending store와 두 정본이 경쟁하지 않게 단일 쓰기 경로로 연결한다.
- [ ] 🔵 RFCT: 생성/등록·부가 처리·원격 DTO 변환을 작은 기존 seam에서 나누고 `api-server.ts`에는 조합만 남긴다.

## P2 — 워크룸 서비스와 Mac 주요 행동

파일: 기존 `src/aiTerminalService.ts`, `src/aiTerminalRemoteGateway.ts`, `src/AiTerminalPanel.tsx`, 새 `src/ProjectLaunchActions.tsx`, `src/App.tsx`. 테스트: `tests/ai-terminal.test.ts`, `tests/ai-terminal-remote.test.ts`, `tests/remote-control-process-gateway.test.ts`, 기존 workroom E2E 2개.

- [ ] 🔴 RED: `workroomStart_mainWorktreeIdentity_runsOnlySelectedCheckout` — 동명 main/worktree·alias·경로 교체에 정확한 checkout만 실행한다.
- [ ] 🔴 RED: `workroomStart_duplicateRequest_keepsOneLiveSession` — 동일 시작의 spawn 1회·동일 sessionId·입력 순서·EOF 종료를 확인한다.
- [ ] 🔴 RED: `projectWorkspace_createAndChooseAction_worksAcrossMacAndWeb` — 실제 UI에서 생성 대상·두 행동·버튼 클릭·초안 보존을 검증한다.
- [ ] 🟢 GREEN: 기존 target inventory→정확한 하나 선택→AiTerminalService start→확인된 sessionId의 워크룸 이동을 연결한다. PTY 생성과 CLI 로그인 대기를 별도로 표시한다.
- [ ] 🟢 GREEN: 실제 한글 IME·긴 입력·출력 누적·세션 전환·짧은 창 스크롤에서 입력 순서와 버튼 접근을 확인한다. 클릭/탭 피드백 100ms 이내를 목표로 실제 계측하고, CLI 첫 출력 지연과 UI 반응을 분리 기록한다. 목표를 이미 달성한 수치로 표시하지 않는다.
- [ ] 🟢 GREEN: `워크룸에서 작업`과 `Mac의 Codex 앱에서 처음/이어 열기`를 주요 행동으로 둔다. Finder 폴더 열기·외부 터미널·새 창·새 대화는 보조 메뉴로 정리한다. 전역 터미널 설정이 주 행동의 목적을 바꾸지 않게 한다.
- [ ] 🔵 RFCT: App의 상세/생성 완료/워크트리 진입에서 공통 컴포넌트를 재사용하고 실제 CLI 수명은 화면 수명과 분리한다.

## P3 — Codex 프로젝트 첫 대화 준비와 같은 대화 재열기

파일: 기존 `src/codexFirstConversationLaunch.ts`, `src/codexFirstConversationPendingStore.ts`, `src/codexDesktopProjectSubmit.ts`, `api-server.ts`의 Codex adapter. 테스트: `tests/codex-first-conversation.test.ts`, `tests/codex-first-conversation-launch.test.ts`, `tests/codex-first-conversation-pending-store.test.ts`, `tests/codex-desktop-submission-fence.test.ts`, `tests/codex-desktop-project-submit.test.ts`.

- [ ] 🔴 RED: `codexFirstConversation_unknownDesktopAssociation_blocksCreation` — cwd 일치만으로 처음/이어 열기를 결정하지 않는다.
- [ ] 🔴 RED: `codexFirstConversation_openFailure_reopensCreatedThread` — 생성 뒤 open 실패·동시 재시도·재시작에도 고정 준비 메시지는 1회다.
- [ ] 🔴 RED: `codexFirstConversation_submissionUncertain_requiresReview` — 제출/metadata 불명확이면 fence를 유지하고 재조회한다.
- [ ] 🟢 GREEN: exact desktop membership+thread 있음→이어 열기, 확실한 없음→처음 열기, unknown→재확인으로 결정한다. 기존 고정 준비 메시지를 한 번만 보내고 생성 ID를 즉시 보존한다.
- [ ] 🟢 GREEN: ‘프로젝트 연결용 첫 대화만 준비하며 실제 작업은 Mac Codex 앱에서 이어서 진행’을 표시한다. 앱 선택/OS open 요청·실제 화면 확인을 구분한다. 보조 `앱만 열기(mode=new)`는 영구 연결 성공으로 표시하지 않는다.
- [ ] 🔵 RFCT: 기존 first-conversation coordinator를 정본으로 두고 Receipt 어댑터만 연결한다. 새 생성 상태기계를 나란히 만들지 않는다.

## P4 — 권한 저장/전송, Vercel 흐름과 공통 디자인

파일: 기존 LAN/인터넷 vault·core/controller·gateway, `src/remote-control-portal-main.tsx`, `src/remoteControlMobilePage.ts`, `src/portal-main.tsx`, `src/appAppearance.ts`, CSS/공통 UI. 테스트: 기존 `ai-terminal-remote`, LAN reconnect, transport integration, internet-agent, host-restart/switcher, security/vault, relay-controller, workroom/portal E2E.

- [ ] 🔴 RED: `remoteTerminalGrant_revokedDuringAwait_blocksQueuedIO` — await/큐 중 revoke 후 입력·resize·출력을 전달하지 않는다.
- [ ] 🔴 RED: `remoteReconnect_newSocketEpoch_rejectsOldSocket` — 같은 기기 새 socket만 허용하고 이전 socket은 모두 거부한다.
- [ ] 🔴 RED: `workroomReconnect_missingSession_doesNotRestartCLI` — 재시작/다른 호스트에서 없어진 PTY를 자동 복제하지 않는다.
- [ ] 🔴 RED: `remoteLaunch_protocolBoundary_preservesNarrowAuthority` — strict parser·구버전 협상·민감정보 비노출·scope 분리를 유지한다.
- [ ] 🔴 RED: `remoteWorkroom_reconnect_preservesSelectionAndConsent` — 실제 선택/cursor 복귀와 30일 내 무재승인을 검증한다.
- [ ] 🔴 RED: `remoteReconnect_locatorChange_verifiesPinnedHost` — IP/port가 바뀌어도 pinned host proof 확인 후 locator만 갱신한다.
- [ ] 🔴 RED: `portalRemoteWorkroom_sharedAppearance_preservesUsableControls` — light/dark·모바일·데스크톱·125%에서 computed style 역할과 실제 조작을 확인한다.
- [ ] 🟢 GREEN: versioned 기존 vault에 명시 device grant를 저장하고 저장 성공 뒤 현재 socket 권한으로 축소한다. legacy 동의 미승격, grant scope/revision/expiry와 socket epoch를 요청·await 뒤·입력 직전 검사한다.
- [ ] 🟢 GREEN: QR1회+최초 승인으로 30일 연결을 복원한다. host key/device key 증명과 pinned identity를 보호된 저장소에 결속하며 주소를 identity로 쓰지 않는다. 제한된 discovery/검증한 새 locator로 주소 변경을 처리한다.
- [ ] 🟢 GREEN: 30일 pairing과 Google/Supabase token TTL을 구분한다. 기존 getAuthenticatedSupabaseClient refresh를 재사용하고 network/read 실패에 credential을 지우지 않는다. 같은 계정 재인증 후 pinned controller/E2EE를 복원하며 다른 계정·실제 revoke는 거부한다. token 만료만으로 QR을 요구하거나 새 polling/RLS 완화를 추가하지 않는다.
- [ ] 🟢 GREEN: 생성 완료 시 정확한 프로젝트 상세→워크룸/앱 열기로 연결한다. 호스트 전환 후 지연 응답은 버리고 offline에서는 실행 요청을 무한 대기시키지 않는다.
- [ ] 🟢 GREEN: index.css의 공통 토큰·자체 호스팅 폰트만 추출하고 appAppearance를 재사용한다. portal/remote/workroom의 header/nav/card/input/dialog/status/empty/error와 하드코딩 테마를 통일한다. 전체 index reset을 중복 import하지 않는다.
- [ ] 🟢 GREEN: 로그인/승인/프로젝트/워크룸/실패 모든 화면에서 모바일 320/375/430px·44px 조작부, 데스크톱 1024/1440px·125%, 대비·focus·키보드를 검증한다. xterm ANSI의 어두운 표면은 예외로 유지한다.
- [ ] 🔵 RFCT: transport별 중복 정책과 팔레트를 공통 계약으로 모으고 private path/token·본문이 DTO/로그에 추가되지 않았는지 검토한다.

## P5 — iOS 두 탭과 인터넷 인증 복귀

파일: `mobile/ios/App/RemoteHomeView.swift`, `LANWorkroomView.swift`, `AgentsToZCore`의 연결/저장/인증 경계. 테스트: `mobile/ios/AgentsToZCore/Tests/AgentsToZCoreTests/RemoteTests.swift`, 앱 UI fixture·기존 iOS 검사 scripts.

- [ ] 🔴 RED: `iosRemoteWorkspace_tabSwitch_reusesOneConnection` — 같은 host의 프로젝트/워크룸 탭과 앱 복귀가 새 QR 없이 한 owner를 유지한다.
- [ ] 🔴 RED: `iosInternetAuth_returnRestoresApprovedEncryptedSession` — fixture 실패부터 시작하고 실제 iPhone의 인증 복귀/E2EE/취소/다른 host를 마지막에 확인한다.
- [ ] 🟢 GREEN: 같은 origin의 단일 transport owner와 선택 target을 공유한다. 기존 WKWebView 수명 공유를 우선 검증하고 필요 시 검증된 일회용 handoff를 사용한다. 토큰/cookie 복사·숨은 이중 controller를 만들지 않는다.
- [ ] 🟢 GREEN: Google 인증은 시스템 인증 세션에서 PKCE/state/정확한 callback을 검증해 앱으로 복귀한다. WKWebView 직접 OAuth 우회는 쓰지 않는다. 실제 Supabase/Google 설정 변경 필요 여부를 먼저 확인한다.
- [ ] 🟢 GREEN: iOS token refresh/같은 계정 재인증 뒤 같은 controller·30일 grant·E2EE 세션으로 돌아온다. offline을 revoke로 처리하지 않으며 명시 signout·만료·철회만 인증 보관 상태를 정리한다.
- [ ] 🟢 GREEN: 네이티브 bridge가 필요하면 기존 등록 프로젝트/terminal의 typed 메시지로 한정한다. LAN·인터넷 모두 앱 안에서 두 탭을 사용하며 Safari 링크만 열리는 상태를 완료로 세지 않는다.
- [ ] 🔵 RFCT: 연결/백그라운드/저장소 lifecycle을 한 곳에서 소유하고 화면 전환과 명시 연결 해제·terminal 종료를 분리한다.

## P6 — 자원·설치·실기기·출하

테스트: `tests/ai-terminal.test.ts`, `tests/ai-terminal-scheduling.test.ts`, `tests/project-launch-receipt.test.ts` 및 영향별 기존 resource suites.

- [ ] 🔴 RED: `runtimeResources_capacityReached_preservesExistingWork` — 가득 찬 상태에서도 read/close/revoke/미확정 결과 조회가 가능하다.
- [ ] 🟢 GREEN: 새 시작만 제한하며 unknown Receipt·진행 작업·기억 원본을 삭제하지 않는다. 유효한 created-projects grant가 참조하는 완료 생성 Receipt도 만료/해제와 retry 수명까지 보존한다. 완료 기록 정리는 만료 fence를 지키고 기존 PTY/입력/relay 상한을 유지한다.
- [ ] 🔵 RFCT: 추가 map·timer·조회 cache에 수명/상한을 지정하고 숨은 화면이 실제 작업을 종료하지 않게 한다.
- [ ] `bun run verify`의 typecheck → Bun tests → sidecar build/Rust tests를 통과한다. Bun 0 fail을 판정하며 과거 테스트 개수 일치를 요구하지 않는다.
- [ ] 자원/queue/보존 경계 변경은 `bun run test:resources`, remote wire/iOS 변경은 `bun run test:ios`와 Swift tests, native build/preflight를 별도 실행한다. UI E2E·smoke는 Bun test에 포함됐다고 간주하지 않는다.
- [ ] 지원 호스트/웹 프로토콜 버전을 협상하고 host-first 배포 순서·구버전 안내를 검증한다. 변경한 LAN 30일·새 locator·동의·복구·두 탭 문서를 최신화한다.
- [ ] 출하 소스 guard가 요구하는 clean/remote default HEAD를 확인한 뒤 Mac Developer ID 서명 설치본과 실제 sidecar 버전에서 사용자가 누른 경로를 검증한다. fixture만 통과한 기능을 설치 성공으로 표시하지 않는다.
- [ ] 실제 Mac·Vercel·iPhone에서 생성→main/worktree→워크룸 입력/출력/종료, 생성→Codex 준비 1회→사용자 앱 작업을 확인한다. 반복 QR·승인 없이 잠금/복귀·앱/호스트 재시작·주소 변경·29일 경계와 30일 만료를 증거로 남긴다. 30일 clock fixture와 실제 짧은 재연결 증거를 구분한다.
- [ ] iPhone 서명/provisioning·카메라/LAN 권한·인터넷 로그인 복귀·E2EE·앱 background 복귀를 실제 기기에서 확인한다. 무서명 build나 Safari 대체를 최종 native 성공으로 표시하지 않는다.

## Critical Files / 충돌 위험

| 파일 | 위험 | 완화 |
|---|---|---|
| `src/App.tsx` | 상세·워크트리·실행 상태가 모인 대형 파일 | 신규 공통 행동/정책을 만든 뒤 작은 import·props 연결만 적용 |
| `api-server.ts` | 생성/등록·runtime·capability·Codex 조합 충돌 | existing seam별 추출, 한 소유자가 composition 변경, effect 전후 증거 재검토 |
| `src/remote-control-portal-main.tsx` | auth·host·relay·UI가 함께 변경됨 | 정책/전송 계약 먼저 고정, 기능 UI와 token 적용 diff 분리 |
| `src/portal-main.tsx`·CSS | reset 중복·색상 하드코딩·테마 회귀 | 공통 token/font만 추출, computed style+interaction 교차 검증 |
| iOS SwiftUI/WKWebView 경계 | 화면 전환 때 이중 socket·세션 유실 | 단일 connection owner 먼저 구현, auth/handoff 별도 adapter |

- [ ] 큰 파일을 병렬로 직접 수정하지 않고 모듈 변경→조합 순서로 합친다. Push 전 원격 기본 브랜치와 commit 차이를 확인하고 5개 이상 뒤처졌으면 merge/rebase를 우선 검토한다. 사용자의 미커밋 변경은 보존한다.

## 최종 Definition of Done

- [ ] 28개 행동 계약의 Unit/Integration/E2E가 통과하고 각 경계의 거부·실패·unknown·재시작 사례가 존재한다. Receipt 전이와 기존 action/terminal 응답을 검증하며 새 event bus는 만들지 않는다.
- [ ] P0의 실제 실행 실패가 해결되고 P6 설치본에서 동일 경로가 통과한다. 재현 불가를 ‘수정 완료’로 대체하지 않는다. 실제로 통과한 표면과 미검증 표면을 기록한다.
- [ ] 30일 내 동일 승인 기기의 routine reconnect·백그라운드·탭·앱 재시작에는 QR/동의를 반복하지 않는다. 만료/해제/의도적 저장소 초기화만 재pairing으로 안내하며 다른 host/device는 구분한다.
- [ ] 순수 정책은 framework import가 없고 저장은 정본 Repository/Grant Store를 통해 접근한다. 앱에 내부 ID·capability·raw error를 노출하지 않으며 사용자에게 원인과 다음 행동을 설명한다.
- [ ] README/런타임/자원/iOS 문서와 필요한 auth 설정을 갱신한다. 새 설정이 없으면 해당 범위에 한해 없다고 명시한다. 배포·서명·실제 AI/기기 검증은 구현 시점의 승인된 범위에서만 수행한다.

### 커버리지 판정

| 범위 | 판정/기록 |
|---|---|
| 새 pure Receipt·Grant·준비/결과 정책 | **branch ≥90%**. branch 지표를 지원하는 계측을 먼저 확인하고 파일/분기/커버 결과를 기록. Bun line/function 수치를 branch로 바꿔 주장하지 않음 |
| 핵심 deny/revoke/expiry/unknown/CAS 분기 | 위 비율과 별개로 전부 행동 테스트에 대응 |
| 기존 대형 App/API·외부 OS·생성 코드 | 신규 pure branch 비율 분모에서 제외 사유 명시. 변경 adapter는 통합 테스트, UI/OS는 E2E/실설치로 검증 |

- [ ] 계측이 branch를 제공하지 않으면 분기 위치·양쪽 결과·실행 증거의 검토표를 별도로 만들고 미계측 사실을 밝힌다. 전체 프로젝트 커버리지나 실제 기기 성공률을 만들어 내지 않는다.

## 빠른 시작 명령어

아래는 해당 테스트/구현이 만들어진 뒤 사용하는 명령이며 계획 작성 중 실행한 기록이 아니다.

```bash
bun test --cwd tests project-launch-receipt.test.ts --watch
bun test --cwd tests remote-terminal-grant.test.ts
bun test --cwd tests --coverage project-launch-receipt.test.ts remote-terminal-grant.test.ts
bun run verify
bun run test:resources
bun run test:ios
swift test --package-path mobile/ios/AgentsToZCore
node tests/workroom-usability.e2e.mjs
node tests/workroom-input-lifecycle.e2e.mjs
```
