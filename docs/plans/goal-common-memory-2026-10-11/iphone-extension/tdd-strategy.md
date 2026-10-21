# TDD 전략: iPhone·MCP 목표별 클라우드 공통기억 확장

## 개요·측정 범위

정본은 [domain-analysis.md](domain-analysis.md)와 [architecture.md](architecture.md)다. 현재 source membership의 **Clone-only**, 초안 허용, 원본 memoryId·CORE·자체 목표·과거 pin 보존을 기준으로 한다. 새 목표나 게시본 연결은 별도 명시 선택이다. publication revisionId가 없는 구성 계획을 실패로 만드는 테스트는 작성하지 않는다.

34개의 행동 검사 묶음을 제안한다. 아래 수치는 실제 `test()` 개수나 통과 수가 아니라 설계한 acceptance 단위다. Unit 7개, Application/Adapter/Infrastructure 통합 23개, 실제 기기 E2E 4개다. 동일 행동의 경계값은 table-driven 입력으로 확장하고, 기존 검사가 해당 Then을 이미 증명하면 새 중복 테스트를 만들지 않는다. 이 문서는 읽기와 전략 파일 작성만 수행했다. 기능 통과·MCP 호출·실기기 검증은 **미측정**이다. parent가 전달한 baseline quick PASS는 새 기능 증거가 아니다.

현재 작업트리에서 독립 확인한 러너는 `package.json:25-32`의 `test:maintainer → typecheck → test → test:rust`인 `verify`다. `test`는 `bun test --cwd tests --max-concurrency=1`, `bunfig.toml:4`는 `root = "./tests"`다. 기존 Bun 파일 패턴 `tests/*.test.ts`와 UI `*.mjs`/fixtures를 재사용한다. 프로젝트 tester ensure는 상위 세션에서 이미 1회 호출했으므로 다시 호출하지 않는다. 실제 명령·결과·로그는 구현 담당자가 별도로 기록한다.

## FIRST·TDD 실행 순서

| 순서 | RED: 먼저 고정할 행동 | GREEN의 최소 범위 | REFACTOR·종료 조건 |
|---|---|---|---|
| 1 | T01–T07: 정체성·구성 상태·고정 계획 | 기존 순수 Domain 함수와 검증 확장 | React/fs/Bun/Supabase import 없이 같은 행동 유지 |
| 2 | T08–T17: one-member·영수증·원본 복원 | 주입된 함수형 실행 서비스, exact binding 읽기 | 단계 공통 처리 정리; 실패·중단에도 소유 증거 보존 |
| 3 | T18–T22: 엄격 요청·권한·전송·MCP | HTTP/MCP/mobile 공통 parser 및 bounded projection | 기존 meta 경로와 권한의 회귀 통과 |
| 4 | T23–T26: 메뉴·입력·미확정 UX | 주입 client와 상태 generation, 안전한 intent metadata | DOM 행동 검사; 화면이 닫히거나 host가 바뀌어도 원래 요청 결속 유지 |
| 5 | T27–T30: 실제 파일·Git·등록·SDK 경계 | 기존 lease/durability/clone/register 조립 | subprocess·임시 파일 정리, 원본 파일 byte/hash 보존 증명 |
| 6 | T31–T34: 실제 iPhone 및 production 연결 | 실제 연결에서 대표 정상·중단·접근성 동작 | fixture·실기·production 증거를 각각 명시; 안 한 단계는 미측정 |

각 RED는 실패 이유를 로그로 확인한 뒤 최소 구현한다. 이미 root 구현이 진행된 경계는 과거 RED를 있었다고 기록하지 말고 **현재 행동 회귀 추가**라고 기록한다. 독립 temp root/cloud/owner/requestId를 사용하고 실행 순서에 의존하지 않는다. 시간은 주입 clock, concurrency는 deferred barrier로 제어해 임의 sleep을 피한다. 성공 판정은 화면 문구·호출 횟수만이 아니라 영수증·파일·등록 ID·scope의 관측 가능한 결과로 만든다.

## Mock/Fake 전략

| 의존성 | 사용할 double 또는 실물 | 검증할 행동·제한 |
|---|---|---|
| CommonMemoryRepository·cloud | 기존 `tests/fixtures/common-memory/cloud.ts:4-19`의 CommonCloud Fake 확장 | CAS, alias, 원본 head/hash, exact binding 및 조회 실패를 모델링. fake의 테이블만 바꾼 결과를 production RLS 증거로 사용하지 않음 |
| CommonMemoryProjectRepository | 실제 Application 서비스 + 주입 root/source/inventory | 가짜 `projectsAdd`가 expected receipt를 그대로 반환하도록 만들지 않음; 실제 revalidation·선택·단계를 실행 |
| Git clone / memory restore / register | 행동 가능한 Fake + deferred barrier + spy event log | clone은 실제 temp Git 폴더와 config를 만들고 restore는 exact memoryId·파일을 복원. spy는 금지된 init/push/bind/다른 member 효과를 검출하는 데 한정 |
| 영수증·identity·lease | 실제 `FileProjectLaunchReceiptStore`, 실제 temp filesystem; 일부 fault injection | restart는 새 서비스 인스턴스/프로세스가 같은 temp app-data를 읽도록 한다. public marker만으로 ownership을 fake하지 않음 |
| 원격 transfer | 실제 host/client/parser/gateway + Fake 실행 포트와 clock | meta/cloud가 같은 pool과 owner budget을 공유하게 조립. 전체 serialized escaped wire byte와 request 수를 측정 |
| React client | 실제 `createCommonMemoryClient` + 기록하는 injected transport | 오류·지연·역순 응답·unknown·receipt 응답을 제공; DOM과 전송 payload를 함께 관측 |
| MCP | 실제 `agentstoz-use-mcp-server.ts` subprocess + 통제된 endpoint | 기존 `tests/agentstoz-use-mcp-stdio.test.ts:19-61` 패턴 재사용. 소스 문자열 검색만으로 tools/list/call 통과를 주장하지 않음 |
| Git·SDK·WKWebView·relay | 격리된 실제 Git 저장소·실제 준비 receipt·실제 iPhone | clone/restore/register/SDK 준비/production SAS를 각각 분리해 증명 |

## Domain Layer

기존 규칙은 `src/commonMemory.ts:32-42,58-77`, 구성 규칙은 `src/commonMemoryProjects.ts:3-23`에서 확인했다. 기존 `tests/common-memory.test.ts`와 새 집중 `tests/common-memory-projects.test.ts`에 매핑한다.

| ID / 행동 | Given | When | Then |
|---|---|---|---|
| T01 `configure_goalOrMembership_invalidatesReview` | A+B 그룹, 검토 항목·게시본, 별도 원본 A/B 파일 | 이름만 변경 후 목표 또는 구성 변경 | 이름만 바꾸면 goalVersion 유지; 목표/구성 변경은 증가·재검토, 기존 게시 snapshot과 원본 목표/CORE/pin 불변. 원본 1·16 허용, 0·17 거부 |
| T02 `projectsPlan_draftMembership_allMembersVisible` | publication 없는 draft, 현재 A+B+C, A만 해당 memoryId로 등록 | 순수 계획 생성 | 게시 여부를 요구하지 않고 세 구성원이 보임. A present, B/C missing; matching display name은 존재 증거가 아님. plan은 경로/portId/credential을 포함하지 않음 |
| T03 `projectsPlan_unknownInventory_neverMissing` | 같은 기억의 접근 불가 등록 또는 inventory 조회가 불완전한 행 | 전체 구성 상태 계산 | 해당 행 unavailable; 미확인 inventory를 missing으로 승격하지 않음. 원본 GitHub 없음은 별도의 no-repository 안내. 상태는 기존 네 값만 사용 |
| T04 `projectsPlan_memoryRepoOrFolderCollision_conflict` | 다른 memoryId의 같은 repo, 두 source의 같은 repo, 대소문자만 다른 folderName 또는 점유 폴더 | 구성 계획 생성 | 충돌 구성원 conflict, clone 불가. GitHub https/SSH 등 허용 입력은 기존 parser의 canonical 주소로 비교; 이름 같음으로 기억 합병 없음 |
| T05 `projectsPlan_presentAddressChanged_updateHintOnly` | 접근 가능한 exact memoryId 등록, 실제 origin과 원본 canonical GitHub 주소가 다름 | 상태와 안내 생성 | present와 주소 변경 확인 안내가 함께 나옴; 자동 pull/remote 변경/CORE 교체 없음 |
| T06 `validatePlan_snapshotChanged_requiresNewPreview` | 유효 계획과 group CAS/goalVersion/source membership/head/hash/GitHub/scope/rootIdentity 중 하나 변경 | 계획 재검증, tampered nested member/hash 전달 | 변경/조작 거부; hash 일치만으로 발급·권한을 인정하지 않음. 다른 cloud의 동일 UUID도 거부. 동일 안전 입력은 안정적인 fingerprint |
| T07 `selection_historicalPin_notLatestOrApplied` | 추천의 선택된 revision R1, 이후 게시 R2, 실제 검사 미실행 | 기존 pin으로 recall·적용 상태 조회 | 기존 작업은 R1 고정; 새 적용은 별도 명시 선택. recall·reported passed는 검사 실행 인증이 아님. publication·source revision·CAS version·goalVersion을 혼용하지 않음 |

## Application Layer

기존 `common-memory-server.ts:68-78`의 catalog/projectSources와 `common-memory-projects-server.ts:11-52`의 계획·추가 조립을 확인했다. 신규 집중 `tests/common-memory-projects-service.test.ts` 및 기존 `tests/common-memory-service.test.ts`를 사용한다. 아래는 정본 시그니처 `projectsPlan`, `projectsAdd({plan,requestId,memoryId})`, `projectReceipt({scopeId,requestId,memoryId})` 기준이다.

| ID / 행동 | Given | When | Then |
|---|---|---|---|
| T08 `projectsAdd_selectedMember_onlyOneEffect` | A/B 두 missing 구성원, 승인된 root·계획 | 새 ID로 B만 명시하여 추가 | B만 clone→원본 restore→register; A 효과 0. B의 단계 결과·남은 A 상태 반환, 단계 전에 durable reservation 생성 |
| T09 `projectsAdd_sameRequest_replaysOnlyChosenMember` | B 완료 영수증과 등록·폴더 identity | 같은 owner/scope/requestId/plan/B를 반복 또는 동시에 전달 | B 기존 결과만 replay; clone/restore/register 추가 효과 0, A 자동 진행 0. 다음 A는 명시 A+새 ID에서만 실행 |
| T10 `projectsAdd_requestRebound_rejected` | B에 예약된 requestId | 같은 ID로 A 또는 다른 planHash/owner/scope 전달 | 충돌 또는 접근 거부, 어떤 side effect도 새로 시작하지 않음. requestId 문자열만으로 다른 owner 영수증 조회 불가 |
| T11 `projectReceipt_unknown_readOnly` | dispatch 후 응답 유실, 완료 여부 불명 또는 저장소 오류 | 결과 확인·재접속·서비스 restart | exact member/scope에 결속된 기존 단계 조회; unknown을 failed/rollback으로 단정하지 않음, 새 UUID 생성·자동 실행 없음. 쓰기 동의 철회 후 허용된 authenticated 읽기만 검증 |
| T12 `projectsAdd_freshOccupied_neverAdopt` | 새 request의 target에 사용자 폴더 또는 공개 marker 존재 | 추가 실행 | prior 서버 영수증/projectId/실제 directory identity 없는 폴더는 거부·byte 보존. 같은 memoryId/origin/hash marker만으로 adopt하지 않음 |
| T13 `projectsAdd_ownedPartial_preservesAndRecovers` | 해당 request가 clone했고 restore에서 실패한 durable 단계, 동일 실제 폴더 identity | restart 후 읽기 및 명시한 동일 작업 복구 | 이미 확인한 단계·폴더 유지, 반복 clone 없음. 폴더 교체/identity mismatch면 정지. 결과 읽기만으로 복구를 자동 실행하지 않음 |
| T14 `projectsAdd_sourceChangesAcrossClone_stopsRestore` | clone barrier 이전 유효한 계획 | clone 중 head/hash/membership/GitHub/scope/root를 바꾼 후 barrier 해제 | restore/register 전에 다시 검증해 정지하거나 정본에 고정한 exact revision만 복원; 최신 revision으로 조용한 전환 없음. 자기 clone 결과와 영수증 유지 |
| T15 `projectsAdd_restoreOriginalMemory_pullBeforeInit` | Git에 config가 있거나 기억이 cloud backup에만 있는 B, 원본 CORE snapshot | B 복원 성공·backup 없음·다른 memoryId를 각각 주입 | 성공은 exact B Pull과 byte/hash 검증 후 등록; init/new push로 backup 부족·불일치를 해결하지 않음. 원본 cloud head와 다른 기기 CORE도 보존 |
| T16 `restoreBinding_exactOriginalGoalAndPin_only` | B cloud binding의 원래 goal+historical R1, 선택한 그룹은 다른 goal/R2, local binding 유무/충돌 | 새 단말 B 복원 | exact projectMemoryId/scope로 원래 goal/R1 복원, `selections()` latest·새 `bind` write 없음. null/unavailable을 pin 해제 동의로 사용하지 않고 기존 local goal/pin 보존·차이 안내 |
| T17 `projectsAdd_revocationBetweenSteps_noNewEffect` | clone 또는 restore가 진행 중이며 동의를 취소할 barrier | 현재 단계 결과를 받거나 연결 종료 후 다음 단계 진입 | 실제 완료한 단계 기록; 현재 execution consent·projects.add·root grant를 재확인하고 취소 뒤 새 restore/register/bind 효과 없음. 연결 유실만으로 이미 시작한 작업을 실패 처리하지 않음 |

## Interface Adapters Layer

공통 parser `src/commonMemoryRequest.ts:5-25`, transfer `src/metaCommonMemoryRemoteHost.ts:28-74`, `src/metaCommonMemoryRemoteProtocol.ts:5,40-49`, gateway `src/mobileWorkspaceGateway.ts:55-74`, 실제 MCP 정의 `agentstoz-use-mcp-server.ts:86-99,474`를 읽었다. 기존 `tests/meta-common-memory-remote.test.ts`, `tests/agentstoz-use-mcp-stdio.test.ts`, UI fixture를 확장한다.

| ID / 행동 | Given | When | Then |
|---|---|---|---|
| T18 `request_allSurfaces_sameStrictContract` | 정상 create/review/report/plan/add/receipt 입력과 malformed nested plan/evidence/application | HTTP·MCP·mobile parser로 각각 전달 | 같은 accepted/rejected 의미; unknown fields, 부족 required fields, UUID/hash·길이·배열·offset 초과·member mismatch는 side effect 전에 거부. scope/request/member를 receipt wire에서 누락하지 않음 |
| T19 `gateway_cloudMetaClone_scopesIndependent` | terminal-only, meta-only, cloud-only, cloud+projects.add, 잘못된 root identity의 grant 표 | read/manage/clone 요청·취소·peer forwarding 시도 | cloud는 common-memory.manage, meta는 meta-memory.manage, clone은 추가 projects.add와 현재 root/execution consent 필요. legacy bulk/terminal grant 확대 없음. 구 host는 지원 feature 업데이트 안내 |
| T20 `transfer_sharedPool_ownerAndTtlBounded` | meta/cloud 같은 host, 여러 owner, 주입 clock | upload/replay/execute/read/release, 4·8 한계 및 TTL 5분 경계 | 공유 전체 8/owner 4; owner+kind+rpcId isolation, escaped wire≤4,000 bytes, result≤2 MiB. duplicate execute는 1회 효과; 누락/변조·wrong owner 거부. TTL 후 버퍼 없어도 durable receipt 유지 |
| T21 `remote_fullStateAndList_pagesWithinBudget` | 큰 rule/조건/원본본문/보고, group state≈1 MiB, 목록≈2,000개, Unicode·escape 반복 | list/inspect/read-source를 끝까지 원격 page 조회 | 항목·publication·보고·목록 각각 bounded; 누락 없는 cursor/count 또는 명시적 partial. 각 응답 wire≤4,000, envelope≤8,500 bytes; 목표≤200 result chunks, 한 응답 왕복이 300/min budget 내 정상 요청 여유를 남김. CSS redraw로 수신 성공 판정하지 않음 |
| T22 `mcp_stdio_listSchemaAndCalls_realProcess` | 실제 MCP subprocess와 통제 endpoint, 정상/denied/unknown·긴 entry fixture | initialize→tools/list→tools/call, sources/list/inspect/read-source/recommend/recall/manage/plan/add/receipt 호출 | 광고된 tool/schema와 dispatcher 일치; 실제 JSON-RPC ID 응답, required member/root/scope validation, denied 효과 0, unknown 결과 확인 효과 0, full body/paging 완결 또는 truncation 명시. 새 binding은 explicit choice에서만 요청 |
| T23 `macNavigation_commonMemory_peerAccessible` | Mac top-level menu·cloud/meta 별도 기능 | 클릭, Arrow/Home/End, focus 이동 | 장기기억/공통기억 sibling, tab/tabpanel ARIA·순서 일치, cloud 기본/meta 내부 선택·권한 설명 분명, 중복 관리 panel 없음 |
| T24 `sharedPanel_clientGeneration_preservesDraft` | 입력 중인 폼, 느린 host A 응답, host B 전환/숨김 | B 조회 후 뒤늦은 A 응답·refresh·unmount | stable injected client와 generation으로 A 결과 무효화; B에 A source/goal/scope 섞이지 않음, 사용자 입력 보존. 닫힌 화면이 새 poll/load를 시작하지 않음 |
| T25 `unknownIntent_remount_readOnlyReceipt` | manage 또는 B clone unknown, scope/requestId/hash/member metadata 저장됨 | unmount·reload 후 결과 확인, cloud 전환, 원래 create 응답 뒤 catalog 갱신 | credential·원문 없이 필요한 metadata 유지; 원래 scope의 read-only receipt만 조회, 새 ID·다음 member 자동 실행 없음. 현재 cloud catalog가 다르면 원래 create 성공과 새 cloud 입력을 합치지 않음 |
| T26 `deviceHints_currentInventory_addOrCheck` | 기기별 present/missing/conflict/unavailable 및 no-repository/주소 변경, 두 기기 지연 응답 | 기기 전환→힌트→현재 source preview→한 member 선택 | missing N과 확인 필요 N 구분, unknown inventory는 missing/최신으로 표시하지 않음. Add는 정확한 missing member, Update 안내는 주소 확인; 전체 clone·Git pull·새 binding을 자동 승인하지 않음 |

T23–T26은 `tests/fixtures/common-memory/panel.tsx`·`server.ts`와 기존 `tests/mobile-workspace-panel-ui.mjs:1-28`의 Chromium/WebKit DOM 행동 방식을 재사용한다. 현재 fixture server의 hard-coded styling이 앱 Tailwind 실제 크기를 대체하지 않게 한다. 소스 문자열 검사만으로 클릭·focus·폼 보존의 증거를 만들지 않는다.

## Infrastructure Layer

실제 `src/projectLaunchReceipt.ts:17-48,62-98`의 identity·strict format·0600·fsync/rename과 현재 실행 조립부를 독립 확인했다. `tests/common-memory-projects-service.test.ts`와 필요한 기존 Git/receipt/SDK 회귀에 매핑한다.

| ID / 행동 | Given | When | Then |
|---|---|---|---|
| T27 `receipt_restartFaultAndCapacity_preservesUnknown` | 실제 temp app-data, pending 단계, atomic write/rename 전후 fault·잘못된 JSON·symlink·용량 한계 | 새 서비스/프로세스로 재시작·조회·보수적 복구 | 형식·0600·owner 결속·확인 단계 보존; 불확실 저장은 unknown/blocked, 원본·진행 폴더 손상 없음. 용량 때문에 미확정 작업을 삭제하지 않음 |
| T28 `clone_filesystemAndOrigin_strictIsolation` | 실제 temp root/로컬 fixture Git, 악성 folder/URL, root/.git/config/marker symlink 또는 clone 중 target 점유 | 고정 argv clone·staging publish·restore | 안전한 root containment·canonical origin·exact memory 검증, shell injection 0. fresh 점유 target overwrite/delete 0; 자기 staging만 정리, 다른 폴더·credential 원문 DTO 누출 0 |
| T29 `leases_concurrentRegistration_noLostUpdate` | 같은 root에 동시 B/C 추가, 등록 저장 barrier와 기존 unrelated 등록 | 두 요청 완료 및 nested lease 호출 경로 실행 | 중복 clone 0, 정확한 receipt 두 개와 모든 등록 유지, 오래된 inventory write로 다른 등록 소실 없음. 일정 deadline 안에 완료해 lease 재진입 교착 없음 |
| T30 `sdkClone_portableCatalog_notDevicePreparation` | SDK 관리 source, relative catalog와 원래 memoryId, 원본 goal/pin, 다른 Mac 준비 기록 | 새 Mac clone→기억 복원→등록; 별도 승인 준비 | catalog/origin/memoryId·원본 CORE/goal/pin 유지, 새 Mac 준비는 미준비로 표시. 명시 `build-and-test` 선택 모듈만 실행·실제 receipt 기록; Git clone 성공으로 준비 완료 표시 없음 |

## 실제 hardware personas: 4개 E2E

정확한 대상은 iPhone 13 Pro Max / iOS 26.3이며 제품군 표현과 구별해 기록한다. no-reset/foreground 유지, 원본 테스트 전후 hash, 화면·서버 receipt·등록 결과를 함께 수집한다. 물리 기기 fixture UI와 production relay/SAS/현재 scope 동의는 별도 결과다. SIM/5G 시험을 하지 않으면 그 경로의 통과를 주장하지 않는다.

| ID / persona | Given | When | Then·남길 증거 |
|---|---|---|---|
| T31 처음 사용하는 사용자 | 실제 WKWebView foreground, 이름·목표·A+B 원본 선택, advanced 닫힘 | 공통기억 열기→draft 생성→조건 펼치기→근거 검토→게시→Mac/MCP 조회 | 읽기 순서와 안내가 이해 가능, 저장/오류 접근 가능, 동일 cloud/group/head/goalVersion 관측. fixture 여부와 실제 cloud receipt 기록, 창 표시만으로 저장 성공 판정하지 않음 |
| T32 한 손·키보드 사용자 | iPhone portrait, 한 손 입력, 키보드 표시, safe area | 긴 이름/목표 편집, 원본 선택, 저장·이어가기, background→foreground | 입력 font≥16px, 주요 target≥44pt, 키보드가 실행/결과 확인을 가리지 않음, viewport 오동작·input 손실 없음. no-reset 및 foreground 전후 사진/recording |
| T33 낮은 시력·눈부심 사용자 | 큰 Dynamic Type/페이지 확대, 밝은 환경, dark/light 지원 상태 | 조건·충돌·no-repository·적용 근거 읽기, focus/VoiceOver 탐색 | 잘림/가로 강제 scroll/색만 있는 상태 구분 없음, label·focus·안내 읽기 가능, 확대에서도 결과 확인 접근 가능. 실제 기기 설정·화면·미지원 요소를 기록 |
| T34 새 Mac 가져오기·연결 유실 사용자 | 실제 production relay/SAS 승인과 cloud 관리+projects.add 별도 동의, A present/B missing/C unavailable | B 한 개 추가 중 연결 끊기→foreground/reconnect→읽기 결과 확인→다음 항목 명시 선택; 권한 취소도 확인 | B 효과 1회·exact 원본 memoryId/CORE/goal/R1 pin·폴더/등록/receipt 대조, C 자동 실행 0. 다른 기기 inventory 오류는 누락 아님. production 연결·실제 Clone·기억 복원·원본 binding·SDK 준비는 각 측정 결과로 기록 |

## 추적성과 검증 절차

| 도메인·유스케이스 | 검사 |
|---|---|
| CommonMemory/Goal/SourceHead·관리/검토/게시 | T01, T06, T18, T21–T22, T31 |
| Selection/Publication/Application·추천/회상/명시 연결 | T07, T16, T22, T31 |
| Source/LocalProject/Member·계획·기기별 안내 | T02–T06, T18, T26 |
| ProjectPlan·one-member 실행·root/cloud 재검증 | T06, T08, T12, T14, T17, T19, T28–T29 |
| ProjectReceipt·재전송·중단·원본 복원 | T09–T17, T20, T25, T27, T34 |
| local meta Bounded Context·전송·권한 | T19–T20, T23 |
| SDK·portable identity·기기별 준비 | T30, T34 |
| Mac/iPhone/MCP 사용 경로 | T22–T26, T31–T34 |

구현 담당자는 집중 Bun 회귀 → UI Chromium/WebKit fixture → actual MCP stdio → 적합한 verify/maintainer quick → 실제 iPhone·production 경로 순서로 실행한다. 실패·새 수정이 없으면 이미 통과한 광범위 검사를 반복하지 않는다. 명령 예시는 `bun test ./tests/common-memory-projects.test.ts`, `bun test ./tests/common-memory-projects-service.test.ts`, `bun test ./tests/meta-common-memory-remote.test.ts`, `bun test ./tests/agentstoz-use-mcp-stdio.test.ts`이며 신규 파일은 생성 후 실행한다. 하드웨어 검사는 Bun unit에 포함되지 않는다. 출하·설치는 clean committed published source guard를 통과한 별도 단계다.

## 현재 코드에서 관측한 위험·미해결

아래 line은 전략 작성 시점 worktree 관측이며 root의 후속 편집으로 이동할 수 있다. 요구 계약과 current implementation gap을 구분한다.

| 항목 | severity / confidence | 현재 근거·우선 검사 |
|---|---|---|
| 프로젝트 영수증 wire가 requestId만으로 조회되어 정본 scope/member 키가 누락됨 | 높음 / 높음 | `src/commonMemoryRequest.ts:5`, `agentstoz-use-mcp-server.ts:91`, `common-memory-projects-server.ts:50`: T10–T11/T18/T22로 exact owner/scope/member 조회와 공개 projection 확인 |
| 완료 replay 및 단계 결과 projection이 정본 영수증과 아직 다름 | 높음 / 높음 | `common-memory-projects-server.ts:40-47`: restore/register 후 outcomes/complete 반환, 등록 후 동일 요청이 단계 효과를 재실행하지 않는 T09와 unknown 보존 T11 우선 |
| clone 이후 source/root/cloud 재검증이 현재 조립의 restore 앞에서 보이지 않음 | 높음 / 높음 | `common-memory-projects-server.ts:19-20,38-42`: T14/T17 barrier로 실제 검출. 정본 요구를 기존 통과로 표현하지 않음 |
| exact 원본 binding 읽기·휴대성은 일반 bind 쓰기와 별도 구현 필요 | 높음 / 높음 | `common-memory-server.ts:149`와 installer의 private capsule: T16/T30. 최신 selection 조회를 과거 pin 복원으로 사용하면 안 됨 |
| 큰 state/list 및 응답 chunk/rate 한계 | 높음 / 높음 | `src/metaCommonMemoryRemoteProtocol.ts:5`, `src/mobileWorkspaceGateway.ts:58-62`; inspect에 현재 item paging 편집이 관측됐어도 T21에서 전체 serialized body/rate 증거가 필요 |
| UX·production relay/private clone 실측 필요 | 중간 / 높음 | `tests/fixtures/common-memory/server.ts:3-7`는 fixture. T31–T34 전까지 실제 기기/production 성공은 미측정 |

`briefing_correction: []` — 상위 brief의 계약·러너는 독립 확인과 모순되지 않았다. 계획의 publication 부재를 실패로 보는 옛 해석은 정본에서 이미 수정되었으며 이 전략은 draft Clone-only 정책을 따른다. 현재 코드의 미완성 계약은 위 risk 표로 보고했고, 확인하지 못한 외부 경로는 가정으로 통과 처리하지 않았다.
