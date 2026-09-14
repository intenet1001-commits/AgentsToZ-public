# TDD 전략: 프로젝트 생성부터 워크룸·Codex 앱 연결까지

## 개요

기존 동작 테스트를 확장하여 28개 행동 계약을 검증한다. 아래 **테스트명 문자열이 implementation-checklist.md의 정본**이며 구현 체크리스트는 번호와 이름을 그대로 참조한다. 실제 AI 호출·실제 앱 실행·원격 배포는 이 계획 작성 단계에서 수행하지 않는다. 모의 검증 통과와 설치본/실기기 출하 증거를 구분한다.

부모가 보고한 기존 5개 파일 23 pass는 기존 일부 회귀의 기준선이며 새 계획의 완료 증거가 아니다. 이 역할에서는 그 실행을 반복하거나 실제 AI를 호출하지 않았다. 최종 범위는 Mac·Vercel·iOS이며 Mac+웹의 우선 출하가 전체 완료를 뜻하지 않는다.

## 테스트 피라미드 분포

- Unit: 9개 행동(1–9). 작은 receipt/grant/준비 정책의 경계와 상태 전이.
- Integration: 14개 행동(10–20, 25, 27–28). 실제 core/service/coordinator와 가짜 OS·provider·transport.
- E2E/출하 gate: 5개 행동(21–24, 26). 기존 React·xterm·Swift 연결 lifecycle을 사용하고 실제 배포/기기 증거는 별도 수집.

표면·transport·오류 종류는 `test.each` 또는 기존 fixture 매개변수로 검사한다. 같은 계약에 desktop/web/iOS 이름을 각각 추가하여 테스트 수를 부풀리지 않는다. 기존 테스트의 안전 경계는 삭제하거나 새 UI 요구에 맞춰 느슨하게 바꾸지 않는다.

## Mock/Fake 전략

| 의존성 | 전략 | 검증 범위 |
|---|---|---|
| ProjectLaunchReceiptRepository | Map fake + 동일 계약의 실제 private-file/DB adapter fixture | 원자 reserve, fingerprint 충돌, CAS 경쟁, 재시작 후 결과 유지 |
| RemoteTerminalGrantStore | 가짜 시계와 versioned vault fixture | expiry, revoke revision, 기존 grant 미승격, 저장 실패 시 권한 확대 금지 |
| 등록 프로젝트/Git | 임시 폴더와 실제 소형 Git worktree fixture | main/worktree, 동명이인, symlink/등록 교체, branch 동명 |
| AiTerminalService | 기존 fake spawn·PTY·deferred exited | start/input/close 순서, 원래 session identity, EOF, authority await 경합 |
| Codex | 기존 create/open/finalize callback fake와 pending store | 실제 모델·접근성 조작 없이 정확한 desktop association, 생성 중복 방지, 전송 불확실 |
| LAN/인터넷 | 실제 host/controller/core + 메모리 relay·가짜 socket | E2EE 검증·cursor·socket epoch·동일 기기 복원; crypto 자체는 mock하지 않음 |
| React·xterm | 기존 workroom E2E의 격리 API | 실제 CSS/입력/선택/연결 상태; 화면 문자열 존재만으로 성공 판정하지 않음 |
| iOS | 기존 AgentsToZCore fake transport와 앱 UI fixture | 단일 connection owner, 탭 전환, resume·disconnect; 실제 기기 인증은 별도 gate |

## 테스트 케이스 목록 (TDD 실행 순서)

### Phase 1: 작은 정책 — Unit 9개

**1. `projectLaunchReceipt_sameRequest_returnsOriginalReceipt`**
- Given: 같은 host·stable owner·requestId와 fingerprint의 접수/부분 성공 receipt.
- When: 동시 reserve 및 응답 유실 뒤 같은 요청을 재조회한다.
- Then: 처음 한 호출만 created이고 동일 생성 프로젝트/세션/대화 ID를 돌려준다. 중복 효과 호출은 0회 추가다.
- 파일: 새 `tests/project-launch-receipt.test.ts`; 기존 core의 fingerprint 동작은 유지한다.

**2. `projectLaunchReceipt_changedIdentity_rejectsRequestReuse`**
- Given: 이미 사용한 요청 ID.
- When: 다른 host/owner 대상 결속 또는 같은 key에 다른 target/AI/prompt fingerprint로 재사용한다.
- Then: 다른 key는 격리되고 같은 key의 다른 intent는 충돌이다. 기존 receipt를 덮어쓰지 않는다.
- 파일: `tests/project-launch-receipt.test.ts`.

**3. `projectLaunchReceipt_unconfirmedDispatch_requiresReconciliation`**
- Given: 예약 뒤 외부 효과 확인 전에 sidecar가 중단된 receipt.
- When: 재시작 후 결과를 읽고 재시도한다.
- Then: `unknown`에서 기존 등록/세션/대화 확인을 먼저 요구하며 자동 새 실행을 하지 않는다. 확인된 앞 단계 성공을 실패로 지우지 않는다.
- 파일: `tests/project-launch-receipt.test.ts`.

**4. `remoteTerminalGrant_sameDeviceReconnect_reusesExplicitGrant`**
- Given: 별도 Mac opt-in으로 저장한 유효 host/controller/target/expiry/revision grant.
- When: 같은 승인 기기가 승인 후 29일 23:59에 새 socket epoch로 재접속하고, 29일 오프라인 후 복귀·Mac/sidecar/iOS/브라우저 재시작·백그라운드 복귀를 반복한다.
- Then: QR 재스캔·Mac 재승인 없이 같은 허용 프로젝트의 권한을 현재 socket에만 부여한다. 최초 승인부터 30일인 유효기간을 줄이거나 연장하지 않는다. 미사용 QR 발급일을 grant 시작일로 쓰지 않는다. grant 자체가 원격 bearer credential로 전달되지 않는다.
- 파일: 새 `tests/remote-terminal-grant.test.ts`.

**5. `remoteTerminalGrant_changedBindingOrExpiry_requiresNewConsent`**
- Given: 저장된 기기 grant.
- When: 새 pairing/controller·다른 host·scope 밖 프로젝트·승인부터 정확히 30일 만료 경계·철회 revision·조작한 복원본으로 요청한다.
- Then: 표면/transport와 관계없이 접근을 거부하고 필요한 새 동의만 안내한다. 과거 grant를 자동 확대하지 않는다. 최초 명시한 root 범위에서 같은 controller가 만든 새 프로젝트만 생성 receipt와 root identity 확인 후 즉시 포함해 Mac 추가 승인 없이 워크룸을 시작한다. 다른 root/controller/기존 타인 프로젝트는 parameterized fixture로 거부한다.
- 파일: `tests/remote-terminal-grant.test.ts`.

**6. `remoteTerminalGrant_legacySessionScope_doesNotMigrateConsent`**
- Given: 기존 session-only terminal 권한 또는 task/conversation scopes만 있는 v1 vault.
- When: 새 schema로 업그레이드/복원한다.
- Then: 지속형 워크룸 권한은 기본 거부다. 독립 opt-in 이후에만 저장되며 persistence 실패 시 새 권한을 활성화하지 않는다.
- 파일: `tests/remote-terminal-grant.test.ts`, 기존 `tests/remote-control-host-vault.test.ts`, `tests/remote-control-lan-vault.test.ts` 확장.

**7. `runtimeReadiness_supervisorUnavailable_preservesIndependentActions`**
- Given: supervisor recovery-required이고 CLI·프로젝트·Codex 앱은 각각 다른 준비 상태다.
- When: Mac/원격의 실행 선택지를 계산한다.
- Then: structured 작업·읽기 전용 대화에만 관련 장애를 표시한다. 기존 targets와 워크룸/생성/앱 열기를 전역 차단하지 않는다. broker registered/probe만으로 managed ready를 만들지 않는다.
- 파일: 기존 `tests/agent-runtime-readiness.test.ts` 확장.

**8. `codexFirstConversation_unknownDesktopAssociation_blocksCreation`**
- Given: cwd는 같지만 desktop membership 또는 thread 결속이 모호/확인 불가다.
- When: `처음 열기`/`이어 열기` 상태를 계산한다.
- Then: 확인된 기존 association만 이어 열기, 확실한 부재만 처음 열기다. unknown은 재확인을 제공하고 생성하지 않는다.
- 파일: 기존 `tests/codex-first-conversation.test.ts`, `tests/codex-first-conversation-launch.test.ts` 확장.

**9. `projectLaunchStatus_osOpenAccepted_doesNotClaimWindowConfirmed`**
- Given: OS deep link 접수 성공이나 실제 앱/프로젝트 화면 확인은 없음.
- When: 실행 결과를 UI 상태로 변환한다.
- Then: `요청 보냄`/`Mac에서 확인 필요`를 표시한다. 앱 열기·PTY 생성·로그인 완료·작업 완료의 의미를 합치지 않는다.
- 파일: `tests/project-launch-receipt.test.ts` 또는 architecture가 배치한 작은 상태 정책 테스트.

### Phase 2: 서비스와 영속 경계 — Integration 14개

**10. `projectCreate_createdOutsideFirstPage_selectsExactProject`**
- Given: 20개 이상 등록 프로젝트와 새 프로젝트가 첫 페이지 밖에 정렬되는 목록.
- When: 기존 project.create를 수행한다.
- Then: 생성 gateway가 반환한 정확한 등록 결과가 현재 연결 controlId로 전달되고 선택된다. 이름·첫 행·추정된 경로로 선택하지 않는다.
- 파일: 기존 `tests/remote-control-core.test.ts`, `tests/remote-control-project-card.test.ts` 확장.

**11. `projectCreate_postRegistrationFailure_preservesRegisteredFolder`**
- Given: 기본 Git/장기기억 준비 후 폴더+등록 commit point에 도달함.
- When: 실제 saveLastVisit 내부 저장이 실패하거나 backup이 실패/지연한다. 추출한 부가 어댑터가 예외를 던지는 변형도 예방 계약으로 검사한다.
- Then: 이미 등록한 폴더를 failed 경로로 이동하지 않는다. 생성 결과는 즉시 사용 가능하고 부가 상태만 warning/pending이며 같은 프로젝트에서 재시도한다. Git/기억 기본 준비를 통째로 제거하지 않는다.
- 파일: 새 `tests/project-launch-receipt.test.ts`의 생성 adapter 통합 또는 기존 생성 service 테스트가 추출되면 거기로 이동.
- 반증 반영: 현재 `api-server.ts:8237`의 saveLastVisitData는 일반 저장 오류를 내부에서 처리한다. 이 테스트는 이미 있는 nonblocking 동작과 추출 후 commit 경계를 지키는 회귀 계약이며, 실제 lastVisit IO 실패가 폴더 이동을 일으킨다는 재현 증거가 아니다.

**12. `projectCreate_lostResponse_reconcilesOriginalRegistration`**
- Given: 부작용 전 projectId/root identity를 예약한 상태, mkdir 직전/직후/등록 직후의 각 중단 fixture.
- When: 같은 요청을 다시 보낸다.
- Then: 부작용 전 보존한 예약 ID와 creation manifest/현재 등록 결과로 원래 프로젝트를 재선택한다. 이름이 같다는 이유로 기존 폴더를 입양하지 않는다. 새 폴더·번호 붙인 복제본·두 번째 등록은 생성되지 않는다. commit 전에 생긴 불완전 상태는 확인 없이 성공 처리하지 않는다.
- 파일: `tests/project-launch-receipt.test.ts`, `tests/remote-control-core.test.ts`.

**13. `workroomStart_mainWorktreeIdentity_runsOnlySelectedCheckout`**
- Given: 같은 이름·branch를 가진 main/worktree와 모호한 alias fixture.
- When: 시작 직전 등록/디렉터리를 재해석하고 중간에 경로를 교체한다.
- Then: 정확히 선택한 checkout만 시작하고 교체/모호함은 거부한다. 다른 checkout으로 자동 대체하지 않는다. wire에는 경로를 노출하지 않는다.
- 파일: 기존 `tests/ai-terminal.test.ts`, `tests/ai-terminal-remote.test.ts`, `tests/remote-control-process-gateway.test.ts` 확장.

**14. `workroomStart_duplicateRequest_keepsOneLiveSession`**
- Given: 허용된 등록 대상과 fake CLI.
- When: 같은 start를 두 번 보내고 입력·출력·종료를 수행한다.
- Then: spawn은 1회, 두 응답의 sessionId는 같다. 입력은 순서대로 전달되고 EOF를 읽은 뒤 exited를 표시한다. CLI 첫 로그인 대기는 start 실패/작업 성공으로 오인하지 않는다.
- 파일: 기존 `tests/ai-terminal.test.ts`, `tests/ai-terminal-remote.test.ts` 유지/확장.

**15. `remoteTerminalGrant_revokedDuringAwait_blocksQueuedIO`**
- Given: 유효 grant로 시작한 원격 입력/출력과 지연 target resolver.
- When: await 중 grant를 철회하거나 revision을 바꾼 뒤 resolver를 완료한다.
- Then: old revision의 입력·resize·대기 출력은 전달되지 않는다. 권한 확대 저장 실패도 같은 기준으로 거부한다. 로컬 CLI는 임의 종료하지 않는다.
- 파일: 기존 `tests/ai-terminal-remote.test.ts`, `tests/ai-terminal.test.ts` 확장.

**16. `remoteReconnect_newSocketEpoch_rejectsOldSocket`**
- Given: 지속형 grant가 있는 같은 승인 기기의 socket A.
- When: socket B로 복원한 후 A의 지연 프레임/응답을 전달한다.
- Then: B는 재동의 없이 같은 작업을 사용할 수 있고 A는 모든 원격 IO에서 거부된다. LAN/인터넷의 실제 core/controller를 parameterize한다.
- 파일: 기존 `tests/remote-control-lan-reconnect.integration.test.ts`, `tests/remote-control-transport-integration.test.ts`, `tests/remote-control-internet-agent.test.ts` 확장.

**17. `workroomReconnect_missingSession_doesNotRestartCLI`**
- Given: 선택한 sessionId가 있지만 sidecar가 재시작했거나 세션이 종료됐다.
- When: 같은 host에서 다시 연결하거나 다른 host로 전환한다.
- Then: 현재 host 목록과 exact target을 확인하고 원래 세션을 찾을 수 없으면 상태를 설명한다. CLI 자동 새 시작·다른 호스트의 같은 ID 선택은 0회다.
- 파일: 기존 `tests/remote-control-host-restart.test.ts`, `tests/remote-control-portal-host-switcher.test.ts`, `tests/ai-terminal-remote.test.ts` 확장.

**18. `codexFirstConversation_openFailure_reopensCreatedThread`**
- Given: 첫 준비 대화 생성·exact association 확인 후 OS open 실패.
- When: 동시 재시도 및 pending store 복원 뒤 다시 누른다.
- Then: 고정 준비 메시지는 1회, 기존 threadId를 다시 연다. 사용자 임의 작업은 실행하지 않고 성공한 생성 사실을 유지한다.
- 파일: 기존 `tests/codex-first-conversation-launch.test.ts`, `tests/codex-first-conversation-pending-store.test.ts` 확장.

**19. `codexFirstConversation_submissionUncertain_requiresReview`**
- Given: 첫 메시지 제출 여부가 불명확하거나 metadata 검증이 timeout됨.
- When: 최초/새 대화 버튼을 재요청한다.
- Then: 기존 submission fence와 pending 기록을 통해 재확인한다. 같은 fixed message를 다시 보내거나 새 thread를 생성하지 않는다. 정확한 부재를 검증한 경우에만 다시 시작한다.
- 파일: 기존 `tests/codex-desktop-submission-fence.test.ts`, `tests/codex-desktop-project-submit.test.ts`, `tests/codex-first-conversation-launch.test.ts` 확장.

**20. `remoteLaunch_protocolBoundary_preservesNarrowAuthority`**
- Given: 새 receipt/grant/capability 응답과 구버전 client fixture.
- When: path/env/command/credential 또는 unknown scope/target/field를 주입한다.
- Then: parser와 gateway가 거부하거나 지원 불가를 명시한다. terminal grant는 task/conversation 권한을 얻지 못하며 private host 데이터·receipt identityHash는 응답/로그에 없다. 구버전은 조용히 실행하지 않는다.
- 파일: 기존 `tests/remote-control-security-boundary.test.ts`, `tests/remote-control-security-api.test.ts`, `tests/remote-control-host-vault.test.ts` 확장.

### Phase 3: 사용자가 겪는 흐름 — E2E/출하 gate 5개

**21. `projectWorkspace_createAndChooseAction_worksAcrossMacAndWeb`**
- Given: 빈/다중 프로젝트·짧은 창·125% 배율·좁은 웹 화면과 격리 API.
- When: 새 프로젝트 생성 → main/worktree 확인 → 워크룸 또는 Codex 앱 선택.
- Then: 생성 대상이 유지되고 선택 가능한 두 핵심 행동과 현재 준비 상태가 보인다. 워크룸의 입력·종료 버튼 중앙이 클릭 가능하고 요청 초안이 오류/접기/AI 변경에도 보존된다.
- 파일: 기존 `tests/workroom-usability.e2e.mjs`, `tests/workroom-input-lifecycle.e2e.mjs` 확장.
- 사용성 변형: 준비된 같은 Mac의 프로젝트 전환에 추가 로그인·QR·전체 페이지 재로딩이 없다. 한글 IME·Enter·포커스와 터미널 스크롤/자동 스크롤 선택을 보존하고 모바일 키보드가 입력/전송을 가리지 않는다. 입력 누락·중복은 0건이어야 한다. 클릭/전송 후 로컬 진행 표시 100ms 이내를 목표로 측정하고 건강한 연결의 실제 입출력 지연 기준선을 별도 기록한다. 이 수치는 아직 측정한 결과가 아니다.

**22. `remoteWorkroom_reconnect_preservesSelectionAndConsent`**
- Given: 명시 device grant와 실행 중 워크룸, 일부 확인한 출력.
- When: 인터넷/LAN 끊김·페이지 새로고침·백그라운드 복귀를 수행한다.
- Then: 같은 host/project/session을 선택하고 cursor부터 재개한다. 동일 유효 기기는 Mac 재승인/새QR을 요구하지 않는다. 만료/철회만 필요한 동의를 안내하고 지연 출력은 새 화면에 섞이지 않는다.
- 파일: 기존 workroom E2E와 `tests/remote-control-reconnect.test.ts` fixture 확장. 실제 Vercel·Mac 설치본은 별도 확인.
- 인증 수명 변형: Google/Supabase access token 만료는 기존 인증 클라이언트의 갱신으로 처리하고 QR 연결 만료와 구분한다. 갱신 중 네트워크/조회 실패는 credential을 지우지 않으며, 같은 계정 재인증 뒤 기존 pinned controller/E2EE를 복원한다. 실제 권한 철회·명시 sign-out·다른 계정에는 이전 권한을 부여하지 않는다. 재접속 뒤 입력·포커스·스크롤 선택도 보존한다.

**23. `iosRemoteWorkspace_tabSwitch_reusesOneConnection`**
- Given: 한 Mac에 승인 연결된 iOS 앱과 선택한 프로젝트.
- When: 프로젝트/워크룸 두 탭 왕복, 백그라운드/복귀, 새 프로젝트 생성/선택을 수행한다.
- Then: 새 QR이나 disconnect/re-pair 없이 같은 connection owner·host·선택을 유지한다. 명시 연결 해제만 두 탭과 보관 상태를 함께 끝낸다.
- 파일: 기존 `mobile/ios/AgentsToZCore/Tests/AgentsToZCoreTests/RemoteTests.swift` + 앱 UI 테스트. `mobile/ios/App/RemoteHomeView.swift:40-41`의 새QR 요구를 제거하는 사용자 결과를 검증.

**24. `iosInternetAuth_returnRestoresApprovedEncryptedSession`**
- Given: 실제 iPhone·설치 Mac·Vercel 포털 및 테스트 계정의 승인 가능한 연결.
- When: 시스템 브라우저의 PKCE 인증 및 검증한 callback으로 돌아와 SAS 승인·device grant·E2EE 연결을 완료하고 앱 재실행/네트워크 전환한다.
- Then: 동일 host/controller로 돌아오며 두 탭이 사용 가능하고 envelope counter와 revoke 경계를 유지한다. auth cancel·잘못된 return URL·다른 host는 새 권한 없이 설명한다. 테스트용 원문이 relay에 평문으로 남지 않는다.
- 파일: 우선 Swift/transport fixture로 RED 작성; 최종 실제 기기 gate를 별도 기록. 브라우저로 링크만 보내는 기존 동작으로 완료 판정하지 않는다. Google 인증을 WKWebView 안에 가두는 우회는 사용하지 않는다.
- 인증 수명 변형: access token 갱신 또는 동일 계정 재인증이 유효한 30일 pairing을 재소비하지 않는지 확인한다. 잘못된 계정·명시 해지에는 보관된 controller/grant를 자동 연결하지 않는다. 새 고빈도 갱신 루프나 RLS 완화를 요구하지 않는다.

**25. `remoteReconnect_locatorChange_verifiesPinnedHost`**
- Given: 30일 내 유효한 pinned host·승인 기기·device grant와 변경된 Mac LAN IP/port 또는 인터넷 locator.
- When: 같은 host가 새 주소를 제시하거나 다른 장치가 옛 주소를 차지한다.
- Then: 암호학적 host identity를 재확인한 같은 host만 locator를 갱신하며 QR/승인을 반복하지 않는다. 옛 주소의 다른 장치·조작한 host proof에는 토큰/권한을 넘기지 않는다. 새 pairing secret을 재소비하지 않는다. 이 행동은 transport integration 분류다.
- 파일: 기존 `tests/remote-control-lan-reconnect.integration.test.ts`, `tests/remote-control-relay-controller.test.ts`, `tests/remote-control-host-vault.test.ts` 확장. 실제 네트워크 변경 기기 확인도 출하 기록에 포함.

**26. `portalRemoteWorkroom_sharedAppearance_preservesUsableControls`**
- Given: 포털·원격 프로젝트·워크룸·인증/승인 화면과 공통 appAppearance 토큰, light/dark 각각의 fixture.
- When: 휴대폰 320/375/430px, 데스크톱 1024/1440px·125% 배율에서 화면/호스트/탭을 이동하고 버튼·모달·오류·터미널 입력을 조작한다.
- Then: typography/spacing/색/버튼/모달/내비게이션의 computed style 역할이 일치한다. 휴대폰 주 조작부는 44px 이상, focus가 보이고 오류를 읽을 수 있으며 일반 텍스트 대비 4.5:1·큰 텍스트/주요 UI 3:1을 확인한다. xterm ANSI의 별도 어두운 역할 색은 유지할 수 있다. 버튼 클릭 차단·잘림·승인 옵션 누락은 없어야 한다. 문자열 snapshot만으로 통과시키지 않는다.
- 파일: 기존 `tests/workroom-usability.e2e.mjs` 및 포털 E2E fixture 확장. 근거: 부모 조사 `src/remote-control-portal.css:1-11`, `src/index.css:10`, `src/portal-main.tsx:1674`의 테마 분리. 공통 토큰 추출·appAppearance 재사용 후 실제 computed style과 interaction으로 확인.

**27. `runtimeSupervisor_deadOwnerWithoutContainment_refusesRecovery`**
- Given: supervisor lock의 owner PID가 죽었지만 detached descendant의 부재는 증명되지 않은 legacy/manual 상태, 그리고 별도의 검증 가능한 boot epoch/격리 증명 fixture.
- When: 진단·복구를 시도한다.
- Then: dead PID 또는 경과 시간만으로 lock을 삭제하지 않는다. 검증 가능한 동일 소유 실행·부팅 세대·격리 종료 증명이 있는 지원 경로만 단일 supervisor로 회복하며, 과거 증거가 불명확하면 확인 필요를 유지한다. structured runtime 복구 실패는 기존 워크룸을 임의 종료하거나 막지 않는다.
- 파일: 기존 `tests/portal-file-lock.test.ts`, `tests/agent-runtime-guard-registry.test.ts`, `tests/agent-runtime-restart-e2e.test.ts`의 fake process/boot evidence 확장. 실제 broker/격리 증거 없는 fixture 성공을 production recovery 지원으로 표시하지 않는다.

**28. `runtimeResources_capacityReached_preservesExistingWork`**
- Given: receipt/grant 보관 예산 또는 터미널 실행/입력 대기열 한도에 도달했고 진행/결과 미확정 작업이 존재함.
- When: 새 시작 요청과 기존 세션 read/close/결과 조회를 동시에 보낸다.
- Then: 새 작업은 설명과 재시도 가능 상태로 제한한다. 기존 출력 읽기·종료·권한 철회·미확정 결과 확인은 계속 가능하다. unknown receipt나 실행 중 상태를 삭제해 같은 요청을 새로 실행하지 않는다. 완료 기록 정리는 재시도 수명과 만료 fence를 보존한다.
- 파일: 기존 `tests/ai-terminal.test.ts`, `tests/ai-terminal-scheduling.test.ts`, 새 `tests/project-launch-receipt.test.ts` 확장. 버퍼/세션/대기열의 실제 한도 경계를 작은 fixture 예산으로 검사한다.

## 실행 순서와 판정

각 phase에서 행동 하나의 실패를 먼저 확인하고 최소 구현→리팩터링한다. 기존 파일명에 맞는 집중 Bun 테스트부터 수행한다. 중요한 오류 경로가 빠지지 않도록 새 pure receipt/grant/상태 정책에 한해 branch coverage 90% 이상을 목표로 삼는다. DOM 구조나 저장 배열 모양을 그대로 복제한 테스트를 추가해 숫자를 맞추지 않는다.

- 집중: `bun test --cwd tests <변경한 테스트 파일>`; 폴더 전체 자동 탐색을 넓히지 않는다.
- 통합: 실제 파일/Git fixture와 memory relay를 연결하되 fake provider 외의 CLI/AI를 실행하지 않는다.
- UI: 기존 E2E runner는 `bun test`에 포함되지 않으므로 별도 실행한다.
- 커밋 전: `bun run verify`의 typecheck → Bun → Rust를 수행한다. smoke·iOS 빌드/기기 테스트는 각 별도 runner와 변경 범위에 맞춰 수행한다.
- 출하 전: Mac 설치본·Vercel 배포·실제 iPhone의 버전/환경/행동/결과를 기록한다. 소스/fixture 통과로 대체하지 않는다. P0 사용자 실행 실패를 재현하지 못했다면 미해결로 남기고 P6 설치본에서 사용자가 누른 실제 경로가 통과해야 완료다.

## 엣지 케이스와 테스트 데이터

| 데이터/상황 | fixture | 기대 |
|---|---|---|
| 같은 이름·branch의 main/worktree | 임시 Git repo 2 checkout | exact identity만 실행(13) |
| 첫 페이지 밖 생성 | 25개 등록 행, 새 프로젝트 정렬 위치 24 | 반환된 created target 선택(10) |
| 생성 후 부가 실패 | 실제 lastVisit IO 실패, 추출 어댑터 예외, backup deferred | 현재 nonblocking 보존과 향후 commit 경계 검증; 실측 버그 주장 아님(11) |
| 같은 요청 다른 내용 | 고정 requestId·다른 target/prompt hash | 충돌, 새 실행 없음(2) |
| 아직 확인 안 된 효과 | reserve→dispatch→crash | unknown, 원래 결과 조정(3/12/19) |
| 다른 host / 새 pairing | 표시 이름 동일·stable IDs 다름 | 이전 grant/세션 재사용 없음(5/17) |
| 재연결 중 old socket | 두 fake socket·deferred resolver | 새 epoch만 허용(15/16) |
| 기존 opt-in 부재 | v1 task/conversation/session-only 기록 | persistent grant 거부(6) |
| 한글·긴 입력 | 기존 xterm IME fixture | 확정 입력 순서, 버튼/키 보존(14/21) |
| iOS auth 반환 | 성공·취소·다른 origin/host callback | 올바른 승인 세션만 복원(24) |

## 발견·가정·미해결 항목

- 높음/높음: 지속형 device grant는 현재 구현이 아니다. 현재 LAN 재접속 grant 재요청을 최종안으로 고정하면 사용성 목표를 놓친다. 기존 vault에는 selected targets 또는 same-controller-created projects root scope와 stable LAN host/pairing binding을 versioned로 추가해야 한다(`src/remoteControlHostVault.ts:209-218`, `src/remoteControlLanVault.ts:42-48`).
- 높음/높음: iOS는 현재 워크룸 전환에 새QR을 요구하고 인터넷을 시스템 브라우저로 넘긴다(`mobile/ios/App/RemoteHomeView.swift:40-41`, `:78-80`). 최종 완료에 별도 connection lifecycle 및 인증 복귀 실기기 증거가 필요하다.
- 높음/중간: app open 접수 이상의 실제 화면 관측 수단은 설치본에서 검증해야 한다. 없으면 `확인 필요`가 올바른 결과다.
- 중간/높음: 기존 5파일 23 pass는 부분 기준선뿐이다. 28개 행동과 real-device gate가 구현/실행되었다는 주장을 하지 않는다.

`briefing_correction`: 도메인 초안의 iOS 후속 제외·재접속마다 무조건 재grant는 최종 방향에 맞춰 수정했다. 기존 구현의 현상과 제안한 최종 계약을 구분한다.
