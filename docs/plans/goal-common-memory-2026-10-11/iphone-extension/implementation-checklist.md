# 구현 체크리스트: iPhone·MCP 목표별 클라우드 공통기억

정본은 [domain-analysis.md](domain-analysis.md), [architecture.md](architecture.md), [tdd-strategy.md](tdd-strategy.md)다. 기존 함수형 모듈에서 Domain → Repository 경계와 Application → Interface Adapters → Infrastructure 순서로 진행한다. 아래 T01–T34의 RED 라벨은 TDD 전략의 행동 문자열을 그대로 사용한다. T31–T34는 전략에 정의된 hardware persona 이름이며 Bun 테스트명을 새로 만들지 않는다.

이 문서는 계획만 작성했다. 모든 체크박스는 미완료이고 기능·커버리지·실제 MCP·실기기 결과는 **미측정**이다. 상위 세션의 baseline quick PASS는 새 기능의 통과 증거가 아니다. 이미 구현한 경계는 과거 RED를 소급해 주장하지 않고 현재 행동 회귀를 추가한다. 하나의 행동에서 실패 이유를 확인하고 GREEN에 도달한 다음 RFCT한다.

## 환경 설정과 시작 조건

- [ ] 기존 `src/*.ts`/`src/*.tsx`, 루트 서버, `tests/*.test.ts`, UI `*.mjs`/fixture 배치를 유지한다. 새 프레임워크·클래스 계층·레이어 디렉터리를 만들지 않는다.
- [ ] `package.json:25-32`, `bunfig.toml:4`의 실제 명령을 유지한다. `bun test --cwd tests --max-concurrency=1`와 tests 탐색 경계를 따른다.
- [ ] 프로젝트 tester ensure는 상위 세션에서 이미 1회 수행했으므로 반복하지 않는다. 검증 단계에서 `.agentstoz/MAINTAINER.md`의 quick profile과 현재 프로젝트 시나리오를 따른다.
- [ ] 현재 작업트리의 병행 수정 범위를 확인하고 담당 파일을 조율한다. 이 계획 작성 단계는 source/test/memory를 수정하지 않는다.
- [ ] 독립 temp root/cloud/owner/requestId, 주입 clock, deferred barrier를 준비한다. 실기·production 작업 대상과 fixture 데이터를 구별하고 실제 실행 결과를 별도 기록한다.
- [ ] 기존 검사가 해당 Given/When/Then을 이미 증명하면 확장·재사용한다. 구조나 호출 횟수를 그대로 복제하는 중복 검사를 늘리지 않는다.

## Phase 1 — 순수 Domain 규칙

### CommonMemory·Goal·Selection

**구현 위치:** `src/commonMemory.ts` 및 기존 회상/선택 규칙. **검사 위치:** `tests/common-memory.test.ts`, 필요한 기존 `tests/common-memory-service.test.ts`.

- [ ] 🔴 RED — T01 `configure_goalOrMembership_invalidatesReview`: 이름 변경과 목표/구성 변경을 구별하고 source 1/16·0/17 경계를 확인한다.
- [ ] 🔴 RED — T07 `selection_historicalPin_notLatestOrApplied`: R1 pin을 R2 게시 뒤에도 유지하고 회상·reported passed를 검사 실행 인증으로 취급하지 않는다.
- [ ] 🟢 GREEN — 기존 goalVersion·CAS version·source revision·publication 의미를 유지한다. 목표/구성 변경만 재검토하고 원본 CORE·자체 목표·과거 pin은 보존한다. 새 목표·게시본 연결은 명시 선택으로만 수행한다.
- [ ] 🔵 RFCT — 기존 순수 규칙과 명칭을 재사용하고 snapshot 복제·검증 중복을 정리한다. 새 event bus/outbox를 추가하지 않는다.

### CommonMemoryProjectSource·LocalProject·Member·Plan

**구현 위치:** `src/commonMemoryProjects.ts`, `src/gitCloneRequest.ts`. **검사 위치:** `tests/common-memory-projects.test.ts`.

- [ ] 🔴 RED — T02 `projectsPlan_draftMembership_allMembersVisible`: publication 없는 draft의 현재 A+B+C 전체를 비교한다.
- [ ] 🔴 RED — T03 `projectsPlan_unknownInventory_neverMissing`: 접근 불가·불완전 inventory와 no-repository 이유를 구별한다.
- [ ] 🔴 RED — T04 `projectsPlan_memoryRepoOrFolderCollision_conflict`: 기억/repo/대소문자 폴더/점유 충돌을 실행 불가 상태로 유지한다.
- [ ] 🔴 RED — T05 `projectsPlan_presentAddressChanged_updateHintOnly`: exact memoryId의 present와 주소 확인 안내를 함께 제공한다.
- [ ] 🔴 RED — T06 `validatePlan_snapshotChanged_requiresNewPreview`: CAS·goalVersion·membership·head/hash·GitHub·scope/root 변경 및 중첩 plan 조작을 거부한다.
- [ ] 🟢 GREEN — 현재 `sourceMemoryIds`를 정본으로 모든 구성원을 `present | missing | conflict | unavailable`에 매핑한다. canonical GitHub와 group/source/cloud/root snapshot을 고정하고 서버 재계산과 비교한다. planHash를 권한으로 쓰지 않으며 로컬 경로/portId/credential을 projection에서 제외한다.
- [ ] 🔵 RFCT — canonical 주소·fingerprint·상태 판정을 순수 함수로 정리한다. `fs`/Bun/React/Supabase import 없이 유지하고 GitHub 없는 이유는 unavailable의 reason/message로 표현한다.

## Phase 2 — Repository 경계·Fake·Application

### 원본 조회·기억·binding 복원

**구현 위치:** `common-memory-server.ts`, `common-memory-projects-server.ts`의 주입 포트. **검사 위치:** `tests/common-memory-service.test.ts`, `tests/common-memory-projects-service.test.ts`, 기존 `tests/fixtures/common-memory/cloud.ts`.

- [ ] 🔴 RED — T15 `projectsAdd_restoreOriginalMemory_pullBeforeInit`: exact 원본 Pull·byte/hash 검증과 backup 부재·ID 불일치를 검사한다.
- [ ] 🔴 RED — T16 `restoreBinding_exactOriginalGoalAndPin_only`: 원래 projectGoal·historical R1을 복원하고 local 값/조회 실패를 보존한다.
- [ ] 🟢 GREEN — 정본 `CommonMemoryRepository`/`CommonMemoryProjectRepository` 시그니처를 기존 서비스 함수에 매핑한다. 기존 CommonCloud Fake를 행동 가능하게 확장한다. `binding(projectMemoryId, scopeId?)`는 exact 원본 연결만 읽고 pinned source 복원에 필요한 함수를 주입한다. init/new push/latest selections/새 bind write를 복원 fallback으로 호출하지 않는다.
- [ ] 🔵 RFCT — 원본 구성 조회·binding 조회와 새 binding 쓰기의 경계를 명확히 한다. null/unavailable/충돌은 해제 동의나 성공이 아니며 기존 local goal/pin과 차이를 반환한다. 원본 CORE 및 기계 관리 마커를 건드리지 않고 기존 durable installer를 재사용한다.

### one-member 실행·idempotency·결과 조회

**구현 위치:** `common-memory-projects-server.ts`. **검사 위치:** `tests/common-memory-projects-service.test.ts`.

- [ ] 🔴 RED — T08 `projectsAdd_selectedMember_onlyOneEffect`: B 하나만 clone→restore→register하고 단계 전 durable reservation을 만든다.
- [ ] 🔴 RED — T09 `projectsAdd_sameRequest_replaysOnlyChosenMember`: 반복·동시 재전송에서 B replay만 반환하고 다음 A 효과는 만들지 않는다.
- [ ] 🔴 RED — T10 `projectsAdd_requestRebound_rejected`: 같은 ID에 다른 member/plan/owner/scope를 넣으면 거부한다.
- [ ] 🔴 RED — T11 `projectReceipt_unknown_readOnly`: 응답 유실·restart 뒤 exact key의 기존 결과만 읽고 새 실행을 만들지 않는다.
- [ ] 🟢 GREEN — `projectsPlan({groupId,workspaceRootId})`, `projectsAdd({plan,requestId,memoryId})`, `projectReceipt({scopeId,requestId,memoryId})`를 구현한다. authenticated owner·scope·requestId·planHash·member를 결속하고 기존 receipt를 먼저 확인한다. 완료 replay는 추가 효과 없이 반환하고 다음 member는 별도 명시 memoryId+새 requestId로만 진행한다.
- [ ] 🔵 RFCT — 단계 projection과 `pending/complete/blocked/failed/unknown` 설명을 통일한다. 임시 transfer/rpcId를 durable receipt와 혼용하지 않고 unknown을 failure/rollback으로 바꾸지 않는다. 결과 확인은 읽기 전용으로 유지한다.

### 소유·변경·동의 재검증

**구현 위치:** 같은 함수형 실행 서비스와 주입된 consent/identity 검사. **검사 위치:** `tests/common-memory-projects-service.test.ts`.

- [ ] 🔴 RED — T12 `projectsAdd_freshOccupied_neverAdopt`: 새 요청은 사용자 폴더·공개 marker를 채택하지 않는다.
- [ ] 🔴 RED — T13 `projectsAdd_ownedPartial_preservesAndRecovers`: prior server receipt/projectId/directory identity의 자기 폴더만 명시적으로 복구한다.
- [ ] 🔴 RED — T14 `projectsAdd_sourceChangesAcrossClone_stopsRestore`: clone barrier 뒤 source/GitHub/group/head/scope/root 변경을 재검증한다.
- [ ] 🔴 RED — T17 `projectsAdd_revocationBetweenSteps_noNewEffect`: 현재 단계 결과는 기록하고 권한 철회 뒤 새 효과를 멈춘다.
- [ ] 🟢 GREEN — 실행 직전 및 clone 후 restore/register 전에 현재 source·group·cloud·root·권한을 다시 검증한다. 고정 exact source 기준을 조용히 최신으로 바꾸지 않는다. fresh 점유 target은 거부하고, 복구는 이전 서버 영수증의 실제 identity가 일치할 때만 허용한다. 검증 중단 시 자기 폴더와 확인한 단계를 보존한다.
- [ ] 🔵 RFCT — 각 단계의 active/consent 검사와 확인 결과 기록을 정리한다. 연결 유실과 권한 폐기를 구별하고 read-only receipt 조회를 자동 재개 권한으로 바꾸지 않는다.

## Phase 3 — 엄격 어댑터·권한·전송·MCP

### 공유 요청 계약과 독립 권한

**구현 위치:** `src/commonMemoryRequest.ts`, `src/mobileWorkspaceProtocol.ts`, `src/mobileWorkspaceGateway.ts`, HTTP/MCP dispatcher. **검사 위치:** 기존 common-memory/remote/stdio 회귀의 해당 행동.

- [ ] 🔴 RED — T18 `request_allSurfaces_sameStrictContract`: HTTP·MCP·mobile의 정상/중첩 malformed 입력을 같은 계약으로 판정한다.
- [ ] 🔴 RED — T19 `gateway_cloudMetaClone_scopesIndependent`: terminal/meta/cloud/clone/root grant 조합과 구 host를 검사한다.
- [ ] 🟢 GREEN — 공통 parser에서 operation별 allowlist·required fields·UUID/hash·길이·개수·offset·member를 효과 전에 검증한다. cloud는 `common-memory.manage`, meta는 `meta-memory.manage`, Clone은 추가 `projects.add`와 현재 execution/root consent를 요구한다. local project binding은 별도 project grant로 보호한다. `goal-common-memory-v1`/`goal-common-memory` 지원을 확인한다.
- [ ] 🔵 RFCT — 어댑터마다 중복 검증을 만들지 않고 normalized 요청과 bounded 결과를 공유한다. legacy bulk/terminal 권한이나 peer forwarding으로 새로운 권한을 얻지 못하게 한다.

### 공유 transfer 수명과 전체 page

**구현 위치:** `src/metaCommonMemoryRemoteHost.ts`, `src/metaCommonMemoryRemoteClient.ts`, 기존 protocol/client/server 조회. **검사 위치:** `tests/meta-common-memory-remote.test.ts`.

- [ ] 🔴 RED — T20 `transfer_sharedPool_ownerAndTtlBounded`: meta/cloud 공유 pool과 owner·namespace·TTL·wire/result 한계를 검사한다.
- [ ] 🔴 RED — T21 `remote_fullStateAndList_pagesWithinBudget`: 큰 state/list/publication/report를 누락 없이 page로 조회하며 escaped serialized byte와 왕복 수를 측정한다.
- [ ] 🟢 GREEN — 기존 하나의 pool에 `(owner,kind,rpcId)` 결속을 유지한다. 전체 8/owner 4/TTL 5분, escaped wire 4,000 bytes, envelope 8,500 bytes, response 2 MiB, 300 transfer/min을 유지한다. 전체 group state·목록·항목·게시본·보고를 각각 bounded page로 내보내고 목표 200 result chunks 이내로 응답 크기를 줄인다. partial/count/cursor 상태를 명시한다.
- [ ] 🔵 RFCT — upload/execute/read/release 정리를 공유하고 duplicate execute 효과를 막는다. TTL 종료 뒤 durable receipt는 유지한다. redraw나 일부 sourceEntries 조회를 전체 수신 성공으로 표시하지 않는다.

### 실제 MCP stdio 계약

**구현 위치:** `agentstoz-use-mcp-server.ts`의 tool 목록·schema·dispatcher. **검사 위치:** `tests/agentstoz-use-mcp-stdio.test.ts`.

- [ ] 🔴 RED — T22 `mcp_stdio_listSchemaAndCalls_realProcess`: 실제 subprocess의 initialize→tools/list→tools/call과 denied/unknown/긴 body를 검사한다.
- [ ] 🟢 GREEN — sources/list/inspect/read-source/recommend/recall/manage/plan/add/receipt 도구를 공유 dispatcher와 맞춘다. 반환된 project/root ID만 사용하고 scope/request/member 결속과 paging/truncation을 보존한다. 새 binding은 explicit choice에서만 요청한다.
- [ ] 🔵 RFCT — 실제 JSON-RPC ID별 출력과 오류를 읽을 수 있게 정리한다. 소스 문자열 검사나 fixture endpoint 응답만으로 production MCP/cloud 통과를 주장하지 않는다.

## Phase 4 — Mac·공유 React·iPhone 입력 상태

### 최상위 메뉴와 주입 client

**구현 위치:** `src/App.tsx`의 작은 메뉴 연결, `src/CommonMemoryPanel.tsx`, `src/commonMemoryClient.ts`. **검사 위치:** 기존 `tests/fixtures/common-memory/panel.tsx`·`server.ts`, `tests/mobile-workspace-panel-ui.mjs` 방식의 DOM 행동 검사.

- [ ] 🔴 RED — T23 `macNavigation_commonMemory_peerAccessible`: sibling menu·ARIA·키보드·focus·중복 panel을 확인한다.
- [ ] 🔴 RED — T24 `sharedPanel_clientGeneration_preservesDraft`: host A/B 역순 응답·refresh·숨김 뒤 폼과 현재 scope를 확인한다.
- [ ] 🟢 GREEN — 장기기억과 같은 깊이의 공통기억 메뉴를 추가하고 cloud 기본/meta 내부 선택·권한 설명을 연결한다. ARIA tab/tabpanel와 Arrow/Home/End 순서를 함께 바꾼다. stable injected client·generation으로 이전 host/cloud 응답을 무효화하고 사용자 입력을 보존한다. 닫힌 화면은 새 load/poll을 시작하지 않는다.
- [ ] 🔵 RFCT — 큰 App 파일에서 UI·transport 로직을 focused module로 분리하고 작은 import/연결을 유지한다. deployed-web 판정만으로 실제 연결된 iPhone 관리 기능을 차단하지 않는다. fixture styling을 실제 Tailwind 크기 증거로 사용하지 않는다.

### 미확정 intent·단말별 Add/Update 안내

**구현 위치:** `src/CommonMemoryProjectsPanel.tsx`, `src/remote-control-portal-main.tsx`의 생성/records 연결, 기존 공통 panel.

- [ ] 🔴 RED — T25 `unknownIntent_remount_readOnlyReceipt`: reload·cloud 전환·create 후 catalog 응답에서 원래 요청 결속을 확인한다.
- [ ] 🔴 RED — T26 `deviceHints_currentInventory_addOrCheck`: 기기별 네 상태와 no-repository/주소 변경을 현재 source preview로 연결한다.
- [ ] 🟢 GREEN — credential/원문 없는 bounded pending metadata를 유지하고 원래 scope/request/member의 read-only 결과 확인을 제공한다. 새 group create 뒤 catalog도 같은 scope/generation을 검사한다. missing N과 확인 필요 N을 구별하고 registered root·이번 member·남은 목록을 보여준다. Add는 한 missing member의 명시 실행이고 Update는 주소 확인 안내다.
- [ ] 🔵 RFCT — unknown에서 새 UUID·다음 member·전체 Clone을 자동 실행하지 않는다. 원래 create 성공을 다른 cloud 입력과 합치지 않는다. inventory 오류를 없음/최신으로 표시하지 않고 원본 프로젝트 CORE·goal·pin의 자동 변경을 막는다.

## Phase 5 — 실제 durability·Git·lease·등록·SDK 조립

### durable 영수증 저장

**구현 위치:** 기존 `src/projectLaunchReceipt.ts`와 app-data receipt store 주입. **검사 위치:** 실제 temp filesystem을 쓰는 service/receipt 회귀.

- [ ] 🔴 RED — T27 `receipt_restartFaultAndCapacity_preservesUnknown`: atomic write/rename fault·형식·symlink·용량·새 process restart를 검사한다.
- [ ] 🟢 GREEN — 앱 소유 경로·0600·strict format·owner 결속·fsync/atomic rename을 재사용한다. 보수적 복구로 확인 단계와 unknown/blocked를 유지하며 미확정 기록을 용량 때문에 삭제하지 않는다.
- [ ] 🔵 RFCT — 원격 projection에서 실제 경로·명령·credential·서비스 키·원문 로그를 제거하고 기록 수명·bounded metadata 정책을 문서화한다. transient transfer 정리와 durable 기록 정리를 분리한다.

### 실제 clone·restore·등록 merge와 lease

**구현 위치:** `api-server.ts`의 작은 조립부, 기존 Git clone/기억 Pull/등록 함수, 함수형 프로젝트 서비스. **검사 위치:** `tests/common-memory-projects-service.test.ts`와 기존 Git/등록 회귀.

- [ ] 🔴 RED — T28 `clone_filesystemAndOrigin_strictIsolation`: temp Git·악성 입력·symlink·점유 race에서 argv/root/origin/memory를 확인한다.
- [ ] 🔴 RED — T29 `leases_concurrentRegistration_noLostUpdate`: 같은 root 동시 B/C와 unrelated 등록, nested lease 경로의 deadline을 검사한다.
- [ ] 🟢 GREEN — staging·timeout·non-interactive clone을 기존 고정 argv 경로로 실행한다. publish 전 root containment·canonical origin·exact memory·target 점유를 다시 검사하고 자기 staging만 정리한다. lease 소유를 조립부에서 한 번 정의하고 등록 저장은 현재 데이터와 merge하여 다른 등록을 보존한다.
- [ ] 🔵 RFCT — root lease 재진입 대기를 제거하고 side effect 수명·deadline을 명확히 한다. 실제 temp 결과·receipt 두 개·등록 ID와 원본 file byte/hash로 성공을 판정하며 source/init/push/bind 금지 효과도 확인한다.

### SDK 휴대 입력과 단말 준비

**구현 위치:** 기존 `src/sdkProjectManagement.ts`, 등록·준비 receipt 경로. **검사 위치:** 기존 SDK 회귀와 실제 승인 준비 결과.

- [ ] 🔴 RED — T30 `sdkClone_portableCatalog_notDevicePreparation`: catalog/origin/memoryId·원래 goal/pin과 새 Mac 미준비 상태를 확인한다.
- [ ] 🟢 GREEN — 원본 repository·relative module catalog·memoryId를 보존한다. 원래 Mac 준비 기록은 복제하지 않고 별도 `build-and-test`로 승인된 모듈만 준비하여 실제 receipt를 남긴다.
- [ ] 🔵 RFCT — Clone·원본 복원·등록·SDK 준비 결과를 각각 표시한다. Git의 실제 mode 160000 증거가 있을 때만 gitlink 출하 순서를 적용한다.

## Phase 6 — 실제 iPhone 13 Pro Max·production 연결

**검증 위치:** 기존 Swift WKWebView 및 실제 iPhone 13 Pro Max/iOS 26.3, 생산 relay/SAS, 실제 host/cloud. hardware 검사는 Bun unit 밖에서 기록한다.

- [ ] 🔴 RED — T31 `처음 사용하는 사용자`: 실제 foreground에서 draft 생성→검토→게시→Mac/MCP readback의 baseline과 동일 cloud/group/head/goalVersion을 확인한다.
- [ ] 🔴 RED — T32 `한 손·키보드 사용자`: portrait·키보드·safe area·background/foreground에서 font/target·저장·결과 확인을 확인한다.
- [ ] 🔴 RED — T33 `낮은 시력·눈부심 사용자`: Dynamic Type/확대·밝은 환경·VoiceOver/focus에서 상태·충돌·근거를 읽고 조작한다.
- [ ] 🔴 RED — T34 `새 Mac 가져오기·연결 유실 사용자`: production relay/SAS·별도 권한 뒤 B 한 개 추가·연결 유실·읽기 확인·명시 다음 선택·권한 취소를 확인한다.
- [ ] 🟢 GREEN — 대표 UX를 최소 수정한다. mobile/coarse 입력은 최소 16px, 주요 touch target은 44pt이며 이름·목표·원본을 먼저, 고급 조건은 펼쳐 편집한다. noReset/foreground와 키보드·safe area·확대 상태에서 실행/오류/결과 확인을 접근 가능하게 유지한다. B의 효과 1회와 exact 원본 memoryId/CORE/goal/R1 pin·폴더·등록·서버 receipt를 대조한다.
- [ ] 🔵 RFCT — fixture pairing·실제 기기 UI·production SAS·실제 Clone/기억 복원/binding/SDK 준비 증거를 구별한다. 사진/recording·서버 결과·readback을 연결하고 안 한 SIM/5G·추가 Mac 경로는 미측정으로 남긴다. 화면 redraw/foreground 표시만으로 received bytes·cloud 저장 성공을 판정하지 않는다.

## Critical Files / 충돌 위험

아래 line은 서베이/TDD 전략 시점 근거이며 root의 후속 편집으로 이동할 수 있다. 수정 직전 해당 함수·메뉴 위치를 다시 찾는다.

| 파일·근거 | 위험: severity / confidence | 완화·담당 경계 |
|---|---|---|
| `src/App.tsx:1580,2652,13934,14604` | 대형 파일의 메뉴·생성·권한 병행 충돌: 높음 / 높음 | focused panel/client에 로직을 두고 TopLevelTab/TOP_LEVEL_TABS·ARIA·생성 연결만 작게 편집; T23–T26 |
| `api-server.ts:2584,20327,23685` | clone/복원/등록의 identity·lease·lost update: 높음 / 높음 | `common-memory-projects-server.ts` 주입 서비스로 조율하고 기존 clone/Pull/register 재사용; 등록 merge와 단일 lease 소유; T12–T17/T28–T29 |
| `agentstoz-use-mcp-server.ts:86-99,474` | tool schema와 wire의 scope/member 누락: 높음 / 높음 | shared parser/projection을 연결하고 실제 stdio 검증; T18/T22 |
| `common-memory-server.ts:68-78,149,155-192` | 원본 pin 복원을 latest/new binding으로 오인: 높음 / 높음 | exact binding 읽기·기존 installer만 사용하고 새 선택은 분리; T07/T15–T16/T30 |
| `src/metaCommonMemoryRemoteHost.ts:28-74`, `src/metaCommonMemoryRemoteProtocol.ts:5`, `src/mobileWorkspaceGateway.ts:58-62` | 공유 pool·전체 state/list·rate 초과: 높음 / 높음 | 기존 단일 pool, bounded page·escaped byte/왕복 측정·durable receipt; T20–T21 |
| `src/remote-control-portal-main.tsx` 생성/records; `architecture.md:111-117` | cloud 전환·remount 후 오래된 입력/결과 결합: 중간 / 높음 | stable client/generation·bounded pending metadata·readonly receipt; T24–T26 |
| `src/projectLaunchReceipt.ts:17-48,62-98` | public marker/손상 기록으로 폴더 소유 오판: 높음 / 높음 | prior 서버 receipt/projectId/directory identity, strict store·보수적 복구; T12–T13/T27 |

- [ ] 큰 파일마다 신규 focused module + 작은 import/연결로 변경을 줄일 수 있는지 확인한다.
- [ ] 변경 직전 현재 diff를 확인하고 다른 담당자의 편집을 덮어쓰지 않는다. 현재 gap 관측을 구현 완료로 기록하지 않는다.
- [ ] push 전에 원격을 fetch하고 실제 default branch를 해석한다. `git symbolic-ref refs/remotes/origin/HEAD`, `git rev-list --count HEAD..origin/HEAD`, `git rev-list --count origin/HEAD..HEAD`로 양쪽 차이를 확인한다. 원격이 5커밋 이상 앞서면 merge 우선 검토하고 충돌 뒤 필요한 검증을 수행한다.
- [ ] 공식 설치용 빌드는 clean committed published source와 원격 기본 브랜치 일치 가드를 통과한 뒤 만든다. 미공개 테스트 빌드·fixture 실행을 공식 설치 완료로 보고하지 않는다.

## Definition of Done

### 기능·계약

- [ ] T01–T30의 Unit/통합/DOM/actual stdio 행동을 구현에 맞게 실행하고 명령·결과·실패 수정 근거를 남긴다. T31–T34의 실제 기기 결과는 별도 기록한다.
- [ ] 현재 source membership의 draft Clone-only를 제공하고 복수 원본의 전체 네 상태·no-repository 이유·단말별 Add/Update 안내를 정확히 보여준다.
- [ ] 한 호출은 명시 member 하나만 실행한다. 같은 ID+member replay는 효과 0이고 다른 member/plan 재결속은 거부한다. 다음 구성원은 새 ID+명시 선택을 요구한다.
- [ ] fresh 점유 폴더를 채택하지 않고 복구는 prior server receipt/projectId/실제 directory identity의 자기 결과에만 허용한다.
- [ ] clone 후 source/GitHub/group/head/scope/root/동의를 재검증하고 정확한 원본 기억·기존 binding만 복원한다. 원본 CORE·자체 목표·historical pin의 전후 byte/hash·revision 근거를 보존한다.
- [ ] missing backup·ID 불일치·binding 조회 실패를 새 init/push/latest pin으로 해결하지 않는다. 원본 조회 실패와 unknown은 완료/없음으로 보고하지 않는다.
- [ ] cloud/meta/projects.add/local binding 권한을 독립 검사하며 legacy terminal/bulk grant 확대가 없다.
- [ ] 전체 state/list/publication/report paging, shared pool 8/owner 4/TTL 5분, escaped wire·2 MiB response·300/min 예산을 실제 serialized 결과로 확인한다.
- [ ] unmount/restart 뒤 bounded pending metadata와 읽기 전용 결과 확인이 유지된다. 오래된 cloud catalog·host 응답이 현재 입력을 reset/결합하지 않는다.
- [ ] Mac sibling 메뉴·ARIA·키보드, 실제 iPhone 입력 16px/touch 44pt·키보드·safe area·확대/VoiceOver·foreground를 검증한다.
- [ ] actual MCP stdio schema/call, production relay/SAS/현재 scope 동의/readback과 fixture 결과를 구별한다.
- [ ] SDK catalog/memoryId는 휴대되고 기기별 준비는 별도 승인·receipt로 증명된다.

### 품질·검증·인계

- [ ] 순수 Domain은 외부 모듈을 import하지 않고 Repository 경계를 통해 Application에 주입된다. 새 프레임워크·DB/class tree 없이 기존 CAS·불변 게시본·RLS 관련 회귀를 유지한다.
- [ ] 기존 `bun run verify`의 maintainer → typecheck → Bun → Rust를 필요한 최종 수정 후 통과하고 `.agentstoz/MAINTAINER.md` quick 결과를 기능 검증과 구별한다. 새 실패/변경이 없으면 광범위 검사를 불필요하게 반복하지 않는다.
- [ ] 비즈니스 규칙 예외·원본 접근 실패·권한 철회·응답 유실·동시성·restart·byte/rate 경계가 의미 있는 행동 검사로 존재한다.
- [ ] 핵심 비즈니스 로직 커버리지 **≥90%는 정책 목표**다. 측정 전에는 미측정이며 성공 판정이 아니다. 실제 coverage 보고서의 대상/분모/제외·잔여 위험을 기록하고 수치를 만들지 않는다.
- [ ] `CommonMemoryConfigured`/`CommonMemoryPublished`/`CommonMemoryProjectAdded`의 개념적 결과를 기존 action/receipt로 검증한다. Added는 exact 복원+등록 완료에만 대응하고 별도 event bus 발행을 꾸며내지 않는다.
- [ ] 설정·권한·API/MCP 계약·복구·수명·실기기 한계를 관련 README/docs에 반영한다. 에러는 사용자가 확인할 단계와 원인을 설명하고 경로/credential 원문을 내보내지 않는다.
- [ ] 인계는 구현 범위·실행한 명령·실기 증거·미측정 경로·남은 위험을 포함한다. 공식 빌드/설치는 출하 source guard와 실제 실행 증거가 있을 때만 완료로 보고한다.

## 빠른 시작 명령어

명령은 구현 담당자의 향후 실행 항목이다. 새 집중 파일은 생성 후 실행한다. 개별 실행에서도 `tests` 탐색 경계를 유지한다.

```bash
bun test --watch ./tests/common-memory-projects.test.ts
bun test ./tests/common-memory-projects.test.ts
bun test ./tests/common-memory-projects-service.test.ts
bun test ./tests/common-memory-service.test.ts
bun test ./tests/common-memory-sql.test.ts
bun test ./tests/meta-common-memory-remote.test.ts
bun test ./tests/agentstoz-use-mcp-stdio.test.ts
bun test --cwd tests --max-concurrency=1 --coverage
bun run test:maintainer
bun run verify
```

UI Chromium/WebKit fixture와 실제 iPhone 검증은 TDD 전략의 기존 runner/fixture 방식을 따른다. 하드웨어·production 통과는 위 Bun 명령에 포함되지 않는다.

## 가정·미해결 인계

| 항목 | severity / confidence | 근거와 다음 확인 |
|---|---|---|
| 실제 구현 파일은 root 작업으로 계속 변한다 | 중간 / 높음 | `architecture.md:11`, TDD 전략의 현재 gap 표; 수정 직전 함수 위치·wire·diff 재확인 |
| 한 member도 transfer TTL보다 오래 걸릴 수 있다 | 중간 / 높음 | `architecture.md:101-105`; T11/T13/T20/T27/T34에서 durable 단계·readonly 결과 확인 증명 |
| 실기/production/private Clone 성공 여부는 계획에서 알 수 없다 | 중간 / 높음 | `architecture.md:142-144`, TDD 전략 T31–T34; 실제 화면·서버 receipt·등록/readback 확보 전 미측정 |
| coverage ≥90% 달성 여부와 전체 원격 예산은 아직 측정되지 않았다 | 중간 / 높음 | TDD 전략의 측정 범위 및 T20–T21; 실제 coverage/escaped bytes/왕복 수 보고서 필요 |

`briefing_correction: []` — 정본 계약과 다른 명칭·테스트를 새로 도입하지 않았다. publication 부재는 draft 구성 가져오기의 실패 조건이 아니다.
