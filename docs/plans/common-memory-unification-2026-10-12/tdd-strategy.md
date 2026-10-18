# TDD 전략: 공통기억 통합·보존 이관·SDK 재사용 후보

## 개요

정본은 같은 폴더의 `domain-analysis.md`와 `architecture.md`다. schema1 additive `CommonMemoryUnified`, 불변 `PortableKnowledge.snapshot`과 편집 가능한 `current`, 기존 flat `GoalMemory`, 별도 SDK 후보·대상 영수증 계약을 검증한다. 아래는 **작성할 테스트 계획**이며 실행·커버리지·이관·SDK 생성·MCP·실기 성공 보고가 아니다. 기존 iPhone extension의 34개 검증을 반복하지 않고 이번 통합으로 달라지는 행동에 집중한다.

`hitl:auto`, CLARIFY 없음. 상위 전달 Phase R `E3/C5/N0`는 untrusted history이며 THEN의 근거로 승격하지 않았다. Wave 1 두 문서와 현재 `package.json`, `src/metaCommonMemoryStore.ts:41`, `src/commonMemorySql.ts:64`, `src/sdkProjectManagement.ts:32`, `src/opsLaunchOptions.ts`를 읽어 러너·버전 검사·source 제한·기존 prepare 경로를 확인했다. root가 작업 중인 OPS 수정은 이미 완료 관측으로 취급하고 동일 문제를 다시 미해결로 보고하지 않는다.

실행 러너는 현재 `bun test --cwd tests --max-concurrency=1`이다. DB/파일/권한의 실제 성질은 해당 엔진과 실제 dispatcher로 검증하고 문자열 검색으로 대체하지 않는다. `App.tsx`·API·MCP에는 좁은 dispatch만 연결하고 새 helper 중심으로 검사한다.

## 테스트 피라미드 분포

- Unit 7개: U01–U07, 순수 값·상태 전이·회상/적용 조건.
- Integration 20개: U08–U27, SQLite/SQL/파일/Git/dispatcher/실제 stdio·React 동작.
- E2E 3개: U28–U30, 실제 Mac 및 연결 iPhone persona.
- 합계 **30개 행동 묶음**. 오류 경계의 매개변수별 하위 사례는 별도 실행 결과로 기록한다. 위험 경계가 많아 통합 비중이 높으며 단순 표시 문구마다 테스트를 늘리지 않는다.

새 순수 core·이관 조율·SDK 권한/영수증 helper의 branch coverage **90% 이상은 목표**다. 아직 측정되지 않았다. 기존 전체 저장소·실기·UI 체감 품질을 같은 수치로 주장하지 않는다.

## Mock/Fake 전략

| 의존성 | 전략 | 검증 범위·한계 |
|---|---|---|
| 순수 Domain | 실제 함수·불변 fixture | Mock하지 않음; input/output와 상태 의미를 비교 |
| `CommonMemoryRepository` | stateful CAS/receipt Fake + 실제 SQL 엔진 별도 검사 | Fake는 orchestration·fault injection용. DB 권한/잠금 성질의 증거가 아님 |
| `LegacyCommonMemoryRepository` | 임시 실제 SQLite/WAL, 독립 두 연결, 재시작 | 백업·이력·대기 중 구형 writer·fence는 실제 엔진 검증 |
| cloud RPC/RLS | 기존 SQL fixture를 사용하는 PGlite 또는 격리 Postgres | guard/역할은 엔진에서 실행. 다중 세션 advisory lock·실제 Supabase RLS는 지원되는 격리 Postgres/부모 환경에서 따로 확인; 단일 PGlite 결과로 주장 금지 |
| 시간/UUID/provider | injected deterministic clock/ID, 제한된 runner Spy/Fake | 만료·rebind·실패 시점 고정. Fake AI 응답은 실제 AI 성공 증거가 아님 |
| SDK/source/target 파일 | 임시 실제 Git 프로젝트·dirty 파일·symlink·owned staging | 실제 before/after hash와 Git 상태 비교, 사용자 SDK/Cdp 수정 금지 |
| 고정 검사 실행기 | 허용 check 계약의 실제 짧은 Bun subprocess + 실패 runner | exit/output/code hash로 not-run/failed/pass 구분, 임의 요청 명령은 실행 안 됨 |
| HTTP/MCP/remote | 실제 strict dispatcher·실제 stdio subprocess, bounded transport | protocol initialize/list/call부터 확인. caller-supplied 이름은 provider 인증이 아님 |
| 공유 React UI | 주입 client + 실제 DOM 이벤트·deferred barrier | 검색·선택·scope 전환·부분 실패 검증; 렌더 snapshot/소스 regex만으로 대체 금지 |
| Mac/iPhone | 부모 소유 실제 기기·설치 앱·Appium/WDA | fixture wire와 production pairing/SAS/relay·cloud readback을 별도 기록 |

각 통합 fixture는 임시 owned 디렉터리·독립 requestId/scope와 teardown을 갖는다. SQLite backup은 WAL을 포함한 일관된 스냅샷으로 열어 검사하고 DB 파일 복사 성공만으로 보존을 판정하지 않는다. deferred barrier는 시점 재현용이며 긴 sleep·자동 재시도 루프를 쓰지 않는다.

## 테스트 케이스 목록 (TDD 실행 순서)

### Phase 1: Value Object·Aggregate — Unit

#### U01 테스트: `unifiedValidation_portableKnowledge_preservesSchemaAndIndependentGoal`

Given: schema1 legacy 지식 snapshot/current, 동일 groupId, 정규 non-null goal, `goalConfigured:false`, sources/heads/items가 비어 있는 호스트 검증 import.
When: 신규 unified 검증과 기존 reader의 `goal.objective` 접근을 실행하고, ID 불일치·PK 누락·임의 client 0-source pure goal을 각각 전달한다.
Then: 유효 import는 원래 지식 필드·상태·revision을 유지한다. 잘못된 입력은 명시 오류이며 가짜 source/CORE/goal publication을 만들지 않는다. 구형 읽기 구조는 유지한다.

#### U02 테스트: `compatibleRecall_membershipAndStates_preservesProvenanceWithoutGoalPromotion`

Given: include/exclude·NFC category, active/candidate/contested/superseded 항목과 archived 그룹, 별도 실제 publication pin.
When: 같은 task/project에 legacy 호환 회상과 goal 회상을 실행한다.
Then: exclude가 category보다 우선하며 active/contested만 반환하고 contested를 표시한다. archived/candidate/superseded는 제외한다. 지식 ID/revision·kind와 goal pin 출처를 분리해 중복 전달하지 않으며 accepted 지식을 reviewed 또는 적용 성공으로 바꾸지 않는다.

#### U03 테스트: `commonMemoryMutation_knowledgeOrGoalChange_keepsSnapshotAndDistinctVersions`

Given: unified record에 불변 snapshot, current revision, cloud version, goalVersion과 검토·게시 항목이 있다.
When: 지식·연결·name/archive 변경과 목표/증거 변경을 각각 전이시킨다.
Then: snapshot은 byte-equivalent로 유지한다. 지식/연결 변경은 current revision과 cloud version을 갱신하고 root/current name·archived는 일치한다. goal 변경은 current 지식을 보존하면서 기존 goal 재검토 규칙을 적용한다. 지식 승인과 goal 검토 카운터를 혼동하지 않는다.

#### U04 테스트: `publication_legacyZeroSources_neverPassesEmptyHeadEquality`

Given: `goalConfigured:false`, sources=[], heads=[]인 지식 import 및 goalConfigured를 위조한 0-source publication 요청.
When: ready/publish/recommend/bind의 게시 적격성을 판정한다.
Then: 0==0 head-count 비교가 승인을 만들지 않는다. 신규 게시·binding은 명시 목표와 1..16 verified sources·검토 항목을 요구한다. 지식 회상·지식 편집은 계속 가능하며 기존 publication의 역사 조회와 새 추천을 구분한다.

#### U05 테스트: `commonMemoryMembership_legacyMembers_separatesBundleFromEvidenceSources`

Given: sources=[]지만 current에 명시 include 두 명과 exclude/category 규칙이 있고, 별도 17명 include fixture와 missing-head 등록 프로젝트가 있다.
When: projectSources·연결 요약·bundle preview 대상을 해석한다.
Then: 현재 두 member가 표시되고 없는 Usher head는 unavailable 사유로 남는다. 지식 membership은 증거 source 집합으로 바뀌지 않는다. 17명은 전체 개수/페이지와 사용자의 ≤16 subset 선택을 요구하며 앞16개 자동 복제·memory init을 하지 않는다.

#### U06 테스트: `sdkSourceEvidence_unsafeOrExcessSelection_rejectsWithoutSilentTruncation`

Given: 등록 source≤4, code evidence≤32·캡처≤512KiB·실제 memory revision/hash인 정상 근거와 경계 초과/절대경로/상위경로/symlink/credential/raw transcript fixture.
When: `SdkSourceEvidence`와 후보 artifact manifest를 검증한다.
Then: 정상 상대 경로·hash만 사용한다. 초과·경로 탈출·비밀 포함은 명시 blocked/범위 축소 안내이며 잘라서 전체 비교 완료로 표시하지 않는다. memory 없음은 부족 상태이고 신규 memoryId를 만들지 않는다.

#### U07 테스트: `sdkReuseCandidate_changedEvidenceOrArtifacts_invalidatesExactApproval`

Given: reviewed/tested/approved candidate와 exact version·artifact hash·실제 test receipt·선택 target에 결속된 humanApproval.
When: goal/source HEAD·memory hash/code·artifact/target 선택을 바꾼다.
Then: 영향 있는 변경은 needs-review이며 기존 test/approval을 재사용하지 못한다. proposed→reviewed→tested→approved 의미와 targetApplications의 적용 영수증은 독립이다. 후보 승인만으로 applied를 표시하지 않는다.

### Phase 2: 보존 이관·SQLite·클라우드 — Integration

#### U08 테스트: `migrationPreview_exactNhcsAssignments_preservesOriginalIdentityAndNoInit`

Given: 임시 SQLite에 NHCS group `d14813cf-a25d-48fb-8c35-03b85261b25e` rev1/active4/member2 형상의 원본·이력과 fresh 등록 목록을 구성한다. Marketplace port `3ea092ae-8498-48de-adb5-08c4bf83df12`/memory `1eb621cd-79c2-46fa-bf38-dd6c2a9a9657`, Usher port `0951a853-9fd7-4bdb-be7e-ee856c0ceb92`/memory `3c880ef4-46b6-5731-b388-ad79bf29ef88`를 명시 지정하며 Usher cloud head는 없다.
When: preview를 실행하고 등록 memoryId·scope가 바뀐 variant를 반복한다.
Then: 정확한 대상만 ready이며 source snapshot의 old Usher `3fbdfd1a-dab4-5c6a-99e6-9cf22546d865`는 provenance로 남는다. current assignment만 명시 변경하고 alias/merge를 생성하지 않는다. DB·프로젝트 파일·CORE·config·registry·memory init 호출은 무변경이며 head 없음은 지식 이관을 막는 가짜 증거 조건으로 쓰지 않는다.

#### U09 테스트: `migrationExecute_verifiedReadback_handsOffOnceAndKeepsRecoverableHistory`

Given: U08의 ready plan·검증된 두 현재 assignment, 실제 SQLite/WAL backup, stateful cloud CAS/operation receipt adapter.
When: 원본 검증→backup/fence→cloud commit→전체 state hash readback→handoff를 실행하고 같은 요청을 재전송한다.
Then: group/entry ID·body·active 상태·category/tags·시간·revision·원래 연결을 snapshot에 완전 보존한다. current는 승인된 두 현재 ID를 갖는다. readback hash/버전과 durable receipt가 일치하고 cloud mutation은 한 번이다. backup을 독립 DB로 열어 head/history 전체를 비교하며 원본 파일과 과거 이력을 복구 가능하게 남긴다.

#### U10 테스트: `migrationFence_oldWriterAfterVersionCheck_rejectsAllLegacyTableWrites`

Given: 실제 SQLite 연결 A가 구형 user_version 검사를 통과한 뒤 barrier에서 대기하고 연결 B가 prepare/fence를 commit한다.
When: A로 groups/members/revisions의 insert/update/delete 계열 write를 재개한다.
Then: DB trigger가 모든 해당 group write를 거부하며 head/member/history가 변하지 않는다. unrelated group의 정상 write는 가능하다. user_version 숫자만 변경한 대조 구현은 실패하므로 방어 성질을 입증한다.

#### U11 테스트: `migrationRecovery_crashAfterCloudCommit_readsStatusWithoutDuplicateExecution`

Given: cloud commit 뒤 local handoff 이전, readback 실패, prepared 뒤 timeout, 완료 receipt 기록 직전의 fault-injection 지점과 디스크 영수증.
When: 프로세스를 종료·재개하고 원래 key로 status를 조회한다.
Then: cloud-committed/handed-off/unknown을 사실에 맞게 복원한다. 동일 키 readback으로만 handoff를 확정하고 status는 mutation·AI·init을 실행하지 않는다. receipt not-found/권한 유실/TTL 만료는 신규 request 생성·fence 해제·자동 재실행의 근거가 아니다. 원본과 pending intent는 보존한다.

#### U12 테스트: `migrationRequest_reboundOrPreHandoffReplay_rejectsConflictAndReturnsOriginalResult`

Given: 동일 group/request에 원본 scope/hash receipt, 다른 provenance의 cloud group 충돌, 이관 전 성공한 legacy mutation receipt가 있다.
When: scope/group/payload/assignment를 바꿔 재전송하고 옛 성공 요청을 handoff 뒤 다시 보낸다.
Then: 요청 rebind·다른 provenance 채택은 거부하며 이름 일치로 덮어쓰지 않는다. 옛 성공 요청은 원래 SQLite requestId/hash 결과를 읽기만 반환하고 cloud version·지식 revision을 올리지 않는다. 동일 ID의 다른 payload는 conflict다.

#### U13 테스트: `migrationRollback_unknownOrLaterCloudEdit_keepsFenceUntilExactWithdrawalReadback`

Given: handed-off 또는 unknown receipt, 같은 이관 이후 cloud edit가 있는 variant와 변경 없는 variant.
When: rollback을 명시 요청하며 withdrawal CAS/readback을 실패·성공시킨다.
Then: not-found·unknown·이후 편집·CAS/readback 실패에서는 fence와 원본을 유지한다. 변경 없는 exact withdrawal/archive의 확인 뒤에만 로컬 권위를 재개한다. 이력·cloud record를 hard delete하지 않는다.

#### U14 테스트: `cloudRpc_unifiedShapeAndRoles_rejectsFieldLossAndUnauthorizedPublication`

Given: 실제 SQL fixture에 6테이블·additive RPC와 anon/member/nonmember/service-side 역할, 정상 unified record를 설치한다.
When: 구형 writer의 PK/goalConfigured 누락, snapshot 변경·ID 불일치, client 0-source import, goal-only legacy publication 공격 및 허용/비허용 role의 read/write/EXECUTE를 수행한다.
Then: DB가 형식 손실·불변 snapshot 변경·0-source 게시를 거부하고 정상 호스트 검증 지식 import만 허용한다. 기존 member-read와 서버 write 경계·SECURITY INVOKER·EXECUTE 제한을 유지한다. 거부 시 state·receipt·publication/source 행이 부분 저장되지 않는다. service credential이 HTTP/mobile/MCP 응답에 나오지 않는다.

#### U15 테스트: `compatibleMutation_afterHandoff_routesCloudAndNeverReopensLocalAuthority`

Given: handed-off 그룹과 기존 list/read/save-entry/propose-entry/review/assignment/recall 요청, current revision 및 별도 cloud version.
When: 실제 호환 dispatcher로 정상·오래된 revision·권한 없는 review·cloud 장애 요청을 보낸다.
Then: 정상 작업은 cloud current CAS와 bounded before/after history에 반영된다. 후보 사람 검토 경계는 유지한다. cloud unavailable은 명시 오류 또는 읽기 전용 이관 전 사본 표시이며 로컬 편집 정본을 다시 만들지 않는다. 과거 이력 조회는 원본 revision을 유지한다.

#### U16 테스트: `commonMemoryCommit_concurrentKnowledgeAndGoalCas_preservesBothOrReportsConflict`

Given: 같은 version을 읽은 두 writer가 서로 다른 knowledge/member·goal 변경을 준비하고 SQL operation receipt를 쓴다.
When: deferred barrier로 commit을 경쟁시켜 하나를 완료한 뒤 다른 writer가 최신 state로 명시 재검토한다.
Then: 하나는 CAS conflict 또는 직렬 commit이며 조용한 lost update가 없다. 최신 지식과 목표가 함께 보존되고 current/root 동기화·불변 snapshot·revision 구분을 유지한다. delta/receipt가 같은 트랜잭션에서 남아 수정 전후 본문을 재구성할 수 있다. group→정렬 source-head lock 순서는 실제 다중 세션 환경에서 교착 없이 검사한다.

### Phase 3: 표시·권한·전송 계약 — Integration

#### U17 테스트: `unifiedPaging_filterBeforePage_boundsEscapedWireAndReportsFullCounts`

Given: legacy+goal·QA archived3·같은 이름의 별도 그룹, 512KiB 이내 정상 legacy head 및 snapshot/current/goal 합계 1MB 초과 fixture, 따옴표·줄바꿈·한글·이모지가 많은 entries/members/publications/reports.
When: 검색·active/archived 필터·list/inspect/member 페이지를 실제 transport로 요청한다.
Then: 필터를 페이지보다 먼저 적용해 누락/중복 없는 cursor와 전체 개수를 반환한다. immutable snapshot 전체는 wire에서 제외하고 완성된 escaped JSON 창≤350KB·조각4000 bytes·request600KiB·result2MiB·기존 8 global/4 owner/5분 TTL을 지킨다. 원본 통합 1MB 초과는 명시 blocked이며 항목을 절삭하지 않는다. pool 만료가 durable 이관/SDK 영수증을 삭제하지 않는다.

#### U18 테스트: `sharedPanel_searchAndMultiCheck_preservesSelectionAndSeparatesScopePending`

Given: 하나의 CommonMemoryPanel에 legacy+goal 목록·보관 필터·두 cloud scope, 여러 선택과 pending ID별 CAS 요청.
When: 검색/페이지/보관 필터를 바꾸고 복수 edit 중 한 그룹만 conflict되게 하며 scope·group·관리 링크로 이동 후 재진입한다.
Then: 숨겨진 선택도 개수와 ID를 유지하고 성공/충돌/unknown은 ID별로 표시한다. scope가 다른 draft·pending을 오저장하지 않으며 결과 조회부터 복원한다. 별도 editable legacy 화면·중복 편집 인스턴스가 없다. QA3는 기본 목록·추천·새 적용에서 숨고 보관함에서 복구 가능하다.

#### U19 테스트: `projectIdentity_sharedLabelAndSdkFacet_keepsIdsFoldersAndDormantLinks`

Given: canonical memory label과 서로 다른 Mac folder 이름, song/karaoke 동명 두 ID 그룹, stale DEV device `70839979`, ops/dev/managed 저장 행과 검증된 SDK catalog, ready/uninitialized/unavailable 프로젝트.
When: 프로젝트·폴더 상세 및 SDK navigation projection을 읽고 canonical 표시명을 바꾼다.
Then: 표시명만 정본 label을 따른다. folder/port/memory/group ID·기존 alias 계보·persisted role은 유지하고 동명 합병·단말값을 identity로 쓰지 않는다. SDK는 catalog+memoryId로 확인된 projection이다. 상세는 지식 연결·목표 미설정/게시/review 상태와 단일 관리 링크를 표시하며 dormant member를 삭제·다른 ID 치환·init하지 않는다.

#### U20 테스트: `unifiedRequest_allTransports_enforcesStrictContractAndIndependentGrants`

Given: 실제 HTTP/common-memory remote/MCP dispatcher, 정상 listed IDs/plan/key와 서로 다른 cloud/meta/projects.add/memory.save/source/target grant.
When: preview/manage/migrate/links/SDK 요청의 unknown field·임의 path/body snapshot·spoofed fingerprint·잘못된 scope/owner, grant 누락·중간 폐기를 전달한다.
Then: 모든 표면이 동일 strict 유스케이스를 호출하며 거부에 부작용이 없다. 이관은 meta+cloud 각각, clone은 projects.add/exact root, binding은 memory.save, SDK 적용은 target authority를 요구한다. UI 통합·OPS preference·callerName이 권한을 승격하지 않는다. 미지원 구형 client에는 업데이트 안내를 반환한다.

#### U21 테스트: `aiConnection_configProbeAndObservedCall_neverAuthenticatesSpoofedClientName`

Given: 설정만 있는 상태, 실제 설치 launcher의 bounded stdio probe 성공/실패, 서버가 관측한 read-only 호출, `clientInfo.name`을 Claude/Codex 등으로 위조한 실제 MCP subprocess.
When: initialize→tools/list→허용 read-only tools/call을 수행하고 연결 증거 상태를 조회한다.
Then: configured/probe/observed invocation을 구분한다. 실제 관측에는 시간·build/config fingerprint와 검증 가능한 context만 남고 caller-supplied 이름은 authenticated provider로 승격되지 않는다. 호출을 하지 않은 AI는 verified로 표시하지 않고 비밀·자동 AI 실행을 넣지 않는다. 기존/새 도구 schema와 실제 reply가 모두 유효하다.

#### U22 테스트: `opsLaunch_supportedPreferences_persistAndRevalidateAtExecution`

Given: root가 수정한 기존 OPS preference/capability helper와 부모 관측 5-pass 회귀, agent/surface별 지원·비지원 mode/bypass 값.
When: 기존 회귀를 재사용해 저장/재시작/재조회·실제 launch adapter를 실행하며 오래된 비지원 값을 전달한다.
Then: 지원 값만 영속·적용하고 UI와 backend가 같은 capability 의미를 사용한다. Codex/Hermes/agy desktop 비지원 옵션은 안내와 함께 실제 실행에서도 무효화한다. preference가 target/approval 권한을 주지 않는다. 이 테스트는 기존 수정 유지 검증이며 새 pending 버그를 주장하지 않는다.

### Phase 4: SDK 실제 후보·검사·승인·대상 적용 — Integration

#### U23 테스트: `sdkPrepare_selectedCodeAndMemory_createsOwnedCandidateWithoutDirtyRootRewrite`

Given: 목표·선택 source Git/code+memory 근거, 등록 SDK/Cdp의 사용자 dirty 변경, 검증된 기존 v0.2 catalog/prepare receipt와 owned staging/worktree.
When: 실제 candidate prepare adapter에 bounded generator를 연결해 후보 implementation·lock·HTML 설명/demo·manifest를 생성하고 source hash가 준비 중 바뀐 variant를 검사한다.
Then: 후보는 실제 코드와 문서/demo hash를 갖고 근거·범위·제외 조건을 표시한다. SDK/Cdp/source 기존 dirty hash는 그대로이며 등록 밖 쓰기·자동 전체 프로젝트 rewrite가 없다. source 변경은 needs-review다. 기존 v0.2 prepare/status/recommend 계약은 유지되고 다른 Mac clone/pull의 후보 검토 가능성을 해당 Mac 검사 완료로 표시하지 않는다. Fake generator 결과는 실제 AI 품질 증거가 아니다.

#### U24 테스트: `sdkHtml_maliciousEvidenceAndAssetPaths_cannotEscapeOwnedSandbox`

Given: 코드/기억/표시명에 script·닫는 태그·URL·quote payload, 소유 manifest 밖 asset·symlink·상위경로와 실제 HTML 후보.
When: 실제 artifact adapter로 파일을 조회하고 browser sandbox/CSP 문서를 렌더한다.
Then: 근거 텍스트는 escape되어 실행되지 않으며 상위창·credential·외부 network 접근을 막는다. allowlist 밖 파일은 거부한다. 안전한 설명/demo는 정상 사용 가능하다. HTML만 있는 fixture는 implementation 완료로 인정하지 않는다.

#### U25 테스트: `sdkTest_fixedScenario_requiresActualExecutionAndCurrentArtifactHashes`

Given: reviewed candidate와 catalog/scenario의 고정 허용 check, actual runner 성공/실패·미실행·timeout·검사 중 source 변경 fixture.
When: test use case를 실행하고 client가 보낸 임의 command·AI success 문자열·오래된 output hash를 제출한다.
Then: 실제 checkId/실행 정책/exitCode/output hash·시간·code hash가 결속된 성공만 tested다. 실패·미실행·timeout·변경은 failed/not-run/needs-review로 사실대로 표시한다. 임의 명령은 실행하지 않고 예전 receipt로 승인하지 않는다. 추천·기억 recall을 test 통과로 쓰지 않는다.

#### U26 테스트: `sdkApproval_spoofOrStaleVersion_rejectsAndBindsExactHumanTargets`

Given: 실제 통과한 candidate와 인증 사람의 명시 action, 현재 version·artifact/test hash·선택 target IDs, MCP 자기 승인 및 오래된 token fixture.
When: approve와 apply preview를 호출하고 goal/artifact/test/target 범위를 바꾸어 재사용한다.
Then: 서버는 정확한 candidate/test/artifact/선택 target에만 humanApproval을 발급한다. AI 이름·success-report·OPS bypass·다른 사람/scope는 token을 만들거나 재사용하지 못한다. 승인 뒤 변경은 무효화되며 선택하지 않은 프로젝트는 적용 대상이 아니다.

#### U27 테스트: `sdkApply_changedTargetOrCrash_keepsPerTargetReceiptsWithoutAutoAdvance`

Given: 명시 승인된 두 target, 실제 temp Git/files·workspace lease·root identity/memoryId/HEAD/dirty fingerprint, 대상별 before/after journal과 request key.
When: 한 target만 적용하며 다른 target 변경·동시 편집·권한 폐기·부분 파일 쓰기 뒤 crash/restart·unknown 응답을 주입한다.
Then: lease 아래 최신 target/candidate/hash CAS를 확인하고 manifest 파일만 수정한다. dirty/conflict는 보존하며 applied/failed/unknown 및 실제 검증 결과를 target별 durable receipt로 남긴다. unknown 조회는 읽기만 하고 자동 재적용·다음 target 이동이 없다. 동일 request/hash 수동 replay는 중복 쓰기 없이 결과를 재사용하고 다른 request 내용은 거부한다. 다른 Mac은 로컬 검사/권한·준비를 다시 확인해야 한다.

### Phase 5: 실제 Mac/iPhone persona — E2E

#### U28 테스트: `realPersona_newUser_searchMultiCheckAndProjectLinks_understandsOneCommonMemory`

Given: 부모가 검증한 production 이관·cloud readback·설치 Mac와 연결 iPhone, legacy-only NHCS/goal 그룹/QA 보관 fixture가 준비된다.
When: 처음 쓰는 사용자가 단일 공통기억 메뉴에서 검색·복수 선택·지식/목표/연결을 확인하고 프로젝트/폴더 상세 링크를 열어 변경을 저장·재시작한다.
Then: 별도 legacy 편집 메뉴 없이 같은 group을 관리하고 선택·연결·지식 active4/현재 member2·원본 provenance가 정확하다. QA3 보관/복구와 목표 미설정/재검토 의미를 이해할 수 있고 Mac/iPhone persistence·cloud readback이 일치한다. 원본 CORE·folder·memory ID는 변하지 않는다.

#### U29 테스트: `realPersona_oneHandAndLowVision_sharedSearchRemainsUsableWithKeyboardAndLargeText`

Given: 부모 소유 실제 iPhone13 Pro Max/iOS26.3와 Mac, 좁은 화면·큰 텍스트·키보드/VoiceOver 사용 조건.
When: 한 손·낮은 시력 사용자가 검색/복수 체크·접는 상세·프로젝트 링크·CAS 오류를 처리한다.
Then: 16px 입력과 44pt touch, 초점/ARIA·상태 텍스트, 한 열 배치에서 기능을 완료한다. 키보드가 저장/선택 개수를 가리지 않고 정상 입력에 의도치 않은 확대·가로 overflow가 없다. 선택/unknown/재검토를 색상만으로 전달하지 않는다. fixture screenshot만으로 실기 통과를 주장하지 않는다.

#### U30 테스트: `realPersona_projectOwner_mcpAndSdkUnknownRecovery_requiresExactApproval`

Given: 실제 AI client의 MCP 호출 context, production pairing/SAS/relay가 확인된 iPhone와 등록 SDK·사람이 선택한 target, 다른 Mac 또는 동등하게 분리된 호스트 확인 조건.
When: 대화로 지식 검색·SDK 후보 제안/고정 검사·사람 exact 승인·한 대상 적용을 수행하고 적용/이관 도중 연결을 끊어 재연결한다.
Then: configured/probe/실제 관측 call을 구분하고 자기 승인/미검사 적용을 거부한다. 상태 조회로 unknown을 처리하며 자동 다음 대상 쓰기가 없다. 실제 후보 코드·safe demo·check receipt·대상 diff/영수증을 사람이 검토할 수 있다. 다른 Mac 준비는 별도로 검증한다. 실제 5G/SIM·다른 Mac이 없는 경우 그 구간은 미실행으로 남긴다.

## 테스트 데이터 전략·엣지 케이스

| 데이터·경계 | 준비·판정 |
|---|---|
| NHCS 실제 지정 ID | U08 fixture는 부모 라이브 관측의 형태를 재현할 뿐 live 원본 검증이 아니다. 실제 적용은 root가 동일 ID/revision/hash를 fresh 확인한다 |
| old/current Usher | snapshot old ID는 불변 provenance, current 두 assignment는 명시 선택. alias를 만드는 시나리오는 거부 |
| missing memory/head | dormant/uninitialized/unavailable 표시·bundle 사유를 비교하며 init Spy 호출 0, 실제 파일 hash 무변경 검사 |
| state/history | active4 외에 contested/candidate/superseded·포괄 이력 fixture로 의미를 비교. accepted 표시를 goal reviewed로 비교하지 않음 |
| size | 정상 head≤512KiB, snapshot+current+goal≤1,000,000 bytes의 실제 SQL 기준과 wire escaped≤350KB를 각각 경계 검사. 256×12KB가 정상 저장 가능하다고 가정하지 않음 |
| request identity | UUID·scope·group·hash·version을 하나씩 변경해 conflict/owner-bound 결과 판정 |
| name/category | NFC category, 같은 이름 두 group ID, 다른 Mac folder 이름·canonical label 변경; 이름으로 합병하지 않음 |
| source/target changes | 변경 전/검토 후/검사 중/적용 직전 barriers, 파일/hash·dirty 보존과 권한 재검증 |
| unknown | not-found·timeout·TTL·재시작·receipt 쓰기 실패에 자동 실행/해제/다음 대상 부작용 0 |

## RED → GREEN → REFACTOR와 실행 게이트

1. U01–U07부터 의미/검증 실패를 재현한다. 작은 pure helper로 통과시킨 뒤 불변 snapshot·membership·goal 적격성·SDK approval guard의 중복을 정리한다.
2. U08–U16을 실제 SQLite/fault fixture로 RED로 만든다. backup/fence→cloud CAS/readback→handoff 순서와 durable 복구를 최소 구현한다. SQL guard/RLS·다중 writer는 실제 엔진 검사를 통과한 뒤 연결을 정리한다.
3. U17–U22로 페이지·strict DTO·한 패널·상세 링크·증거/권한 경계를 확인한다. OPS 기존 5-pass suite를 재사용한다. UI 라벨/소스 regex를 런타임 증거로 쓰지 않는다.
4. U23–U27로 owned candidate 코드·safe demo·고정 subprocess 검사·사람 exact 승인·대상별 journal/receipt를 구현한다. source/SDK/Cdp dirty 보존 실패는 적용 게이트를 닫는다.
5. 대표 집중 검사·현재 quick profile·`bun run verify` 통과 후 U28–U30을 수행한다. root가 tester ensure를 이번 세션에 한 번 수행했으므로 이 역할/구현자는 반복하지 않는다.

집중 파일은 제안 `tests/common-memory-unified.test.ts`, `tests/common-memory-migration.test.ts`, `tests/common-memory-unified-sql.test.ts`, `tests/common-memory-unified-contract.test.ts`, `tests/common-memory-links.test.ts`, `tests/sdk-reuse.test.ts`, `tests/sdk-reuse-contract.test.ts`로 작게 나누되 기존 helper suite 확장이 더 명료하면 재사용한다. 파일 생성 전에 실제 기존 tests 구조를 확인한다.

```sh
# 구현자가 실행할 명령 예시 — 이 문서 작성 중에는 실행하지 않음
bun test ./tests/common-memory-unified.test.ts ./tests/common-memory-migration.test.ts ./tests/common-memory-unified-sql.test.ts ./tests/common-memory-unified-contract.test.ts ./tests/common-memory-links.test.ts ./tests/sdk-reuse.test.ts ./tests/sdk-reuse-contract.test.ts --max-concurrency=1
bun run verify
# verify = maintainer Python → typecheck → Bun tests → sidecar build + Rust
```

실기 증거에는 정확한 device/model/iOS·Mac/iPhone build·시나리오·관측 UI·서버 request/receipt key·cloud readback hash/시간·기존 원본 backup 검증을 credential 없이 기록한다. 연결된 실제 모델은 부모 관측 iPhone13 Pro Max/iOS26.3이며 이를 기본 iPhone13 실측으로 바꾸지 않는다. Appium4723/noReset은 부모가 관리한다. 사람의 다른 앱을 방해하지 않고 production QR/SAS/relay 확인과 fixture UI를 별도로 기록한다. clean/published source 설치 가드를 유지한다.

## 커버리지 매핑·briefing_correction

| Domain·유스케이스 | 필수 테스트 |
|---|---|
| CommonMemoryUnified/PortableKnowledge/GoalMemory | U01,U03,U04,U09,U14,U16 |
| CommonMemoryMembership/호환 회상/선택 | U02,U05,U15,U19 |
| LegacyMigrationPlan/Receipt/세 Repository | U08–U16,U20 |
| 단일 UI·이름·SDK projection·archived | U17–U19,U28,U29 |
| AiConnectionEvidence/OPS persistence | U20–U22,U30 |
| SdkSourceEvidence/SdkReuseCandidate/targetApplications | U06,U07,U23–U27,U30 |

- 높음/높은 확신: SQLite old-writer fence·unknown 및 DB field-loss/0-head publication guard는 실제 엔진 검사가 필요하다. Wave 1 계약과 현행 Store version 검사/SQL source 조건을 근거로 한다(U10–U14).
- 높음/높은 확신: SDK 승인과 per-target 적용은 실제 파일/runner/권한·해시 결과가 필요하다. 현재 catalog prepare를 후보 generation/승인/적용 완료로 해석하지 않는다(U23–U27).
- 중간/높은 확신: 기존 compact wire는 전체 snapshot/current와 많은 연결을 실을 수 없으므로 byte 측정·필터 선적용·전체 counts가 필요하다(U17).
- briefing_correction: OPS preference는 root의 이미 수정된 작업과 5-pass 관측을 재사용한다. NHCS/current assignment/QA3/기기/build 관측은 부모 제공이며 이 worker가 live 검증한 사실이 아니다. 원본 E3/C5/N0는 회상 증거로 채택하지 않았다.
- 미실행: 모든 U01–U30·SQL migration·SDK/code generation·MCP·실기·coverage. 이 역할은 문서 작성만 했고 source/API/tests/SDK/원본기억/DB를 쓰지 않았다. 계획 THEN 미확정 항목은 없으며 actual provider 인증 증거·다른 Mac/5G 조건이 없으면 해당 실기 범위는 미검증으로 명시한다.
