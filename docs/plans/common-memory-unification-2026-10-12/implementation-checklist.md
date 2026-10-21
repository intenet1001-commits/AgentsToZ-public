# 구현 체크리스트: 공통기억 통합·보존 이관·SDK 후보

정본은 [domain-analysis.md](domain-analysis.md), [architecture.md](architecture.md), [tdd-strategy.md](tdd-strategy.md)다. 옵션 1의 schema1 additive 통합과 기존 함수 모듈을 따른다. 아래 모든 체크박스는 **미실행**이다. 계획 작성자는 소스·문서만 읽었으며 테스트·DB 이관·SDK 생성·실기·커버리지를 측정하지 않았다.

`hitl:auto`, CLARIFY 없음. RED 이름은 최종 TDD U01–U30의 문자열 그대로다. 기존 iPhone extension 34개 검사를 새 검사로 중복 집계하지 않는다. Phase R `E3/C5/N0`는 상위 전달 이력이며 현재 증거로 채택하지 않는다. 실제 이관·검사·GitHub 반영·설치는 root가 실행하고 결과를 기록한다.

## 환경과 시작 조건

- [ ] 기존 React/TypeScript/Bun, root 서버, `src/*.ts[x]`, `tests/*.test.ts` 구조를 유지한다. 새 프레임워크·설치·디렉터리 재편 없이 작은 helper와 injected 의존성을 사용한다.
- [ ] 현재 owner의 App/API/OPS helper·필터·테스트·문서 변경을 먼저 확인하고 보존한다. 작업 단위와 파일 소유권을 정한 뒤 좁은 diff로 연결한다.
- [ ] tester ensure는 부모가 이번 세션에 이미 한 번 수행했으므로 반복하지 않는다. `.agentstoz/MAINTAINER.md`와 `maintainer.json`의 현재 quick/verify 프로필을 따르고 같은 run/lease의 검사를 중복 실행하지 않는다.

이관 대상은 부모 관측 NHCS `d14813cf-a25d-48fb-8c35-03b85261b25e` revision1/active4/member2다. 실행 직전에 실제 revision/hash/등록을 다시 확인한다. Marketplace는 port `3ea092ae-8498-48de-adb5-08c4bf83df12`, memory `1eb621cd-79c2-46fa-bf38-dd6c2a9a9657`; Usher는 port `0951a853-9fd7-4bdb-be7e-ee856c0ceb92`, memory `3c880ef4-46b6-5731-b388-ad79bf29ef88`다. 원래 Usher `3fbdfd1a-dab4-5c6a-99e6-9cf22546d865`는 불변 snapshot provenance에 남기고 현재 assignment만 명시 변경한다. alias/merge·CORE 초기화·가짜 cloud head를 만들지 않는다.

## Phase 1 — Value Object·Aggregate·순수 상태 전이

**구현:** `src/commonMemory.ts`, 신규 `src/commonMemoryMembership.ts`, `src/sdkReuseCandidate.ts`.
**검사:** 제안 `tests/common-memory-unified.test.ts`, `tests/sdk-reuse.test.ts`; 기존 순수 helper 검사를 재사용할 수 있다.

- [ ] 🔴 RED U01: `unifiedValidation_portableKnowledge_preservesSchemaAndIndependentGoal` — schema1/non-null goal·동일 ID·호스트 검증 지식 분기와 잘못된 입력을 재현한다.
- [ ] 🔴 RED U02: `compatibleRecall_membershipAndStates_preservesProvenanceWithoutGoalPromotion` — exclude/category·상태·출처·goal pin의 독립성을 확인한다.
- [ ] 🔴 RED U03: `commonMemoryMutation_knowledgeOrGoalChange_keepsSnapshotAndDistinctVersions` — immutable snapshot과 current/cloud/goal 버전 구분을 검증한다.
- [ ] 🔴 RED U04: `publication_legacyZeroSources_neverPassesEmptyHeadEquality` — 빈 source/head의 일치가 게시·추천·binding 적격성을 만들지 못하게 한다.
- [ ] 🔴 RED U05: `commonMemoryMembership_legacyMembers_separatesBundleFromEvidenceSources` — 현재 연결·dormant 상태·전체 개수와 명시적 ≤16 subset을 확인한다.
- [ ] 🔴 RED U06: `sdkSourceEvidence_unsafeOrExcessSelection_rejectsWithoutSilentTruncation` — 등록 source≤4/code≤32/캡처≤512KiB·경로/비밀 경계를 확인한다.
- [ ] 🔴 RED U07: `sdkReuseCandidate_changedEvidenceOrArtifacts_invalidatesExactApproval` — 후보 변경 시 검사/승인 무효화와 대상 적용의 별도 의미를 확인한다.
- [ ] 🟢 GREEN: 작은 순수 검증·전이 함수로 U01–U07을 차례로 통과시킨다. `CommonMemoryUnified`/`PortableKnowledge` 정본 필드, description/name 기본 goal+`goalConfigured:false`, current membership을 유지한다. 일반 goal create/configure와 publication은 실제 source 1..16 규칙을 유지한다.
- [ ] 🔵 RFCT: DB/파일/React/실행기 import를 제거하고 공통 ID·byte budget·membership·승인 검사만 추출한다. active/contested를 reviewed나 실제 적용 성공으로 변환하지 않는다.

## Phase 2 — Repository 포트·Fake·실제 저장 경계

**구현:** Wave 1의 `CommonMemoryRepository`, `LegacyCommonMemoryRepository`, `SdkReuseCandidateRepository` 시그니처를 그대로 구현한다. `src/metaCommonMemoryStore.ts`, `src/commonMemorySql.ts`와 정식 additive migration에 실제 adapter를 둔다.
**검사:** 제안 `tests/common-memory-migration.test.ts`, `tests/common-memory-unified-sql.test.ts`; orchestration은 stateful CAS/receipt Fake, 저장 성질은 실제 엔진으로 확인한다.

- [ ] 🔴 RED U10: `migrationFence_oldWriterAfterVersionCheck_rejectsAllLegacyTableWrites` — 독립 SQLite 두 연결과 barrier로 구형 writer의 groups/members/revisions 쓰기를 재개한다.
- [ ] 🔴 RED U14: `cloudRpc_unifiedShapeAndRoles_rejectsFieldLossAndUnauthorizedPublication` — 실제 SQL에서 field loss·snapshot 변경·0-source 위조·role/EXECUTE 거부와 원자성을 확인한다.
- [ ] 🟢 GREEN: 읽기 snapshot/history/replay와 durable prepare/status 포트를 연결한다. 일관된 SQLite/WAL backup 뒤 짧은 immediate transaction에 fence+DB trigger를 설치한다. 기존 6테이블/schema1 RPC에 PK/goalConfigured 보존, 동일 ID·불변 snapshot, 호스트 검증 import·게시 guard를 추가한다.
- [ ] 🔵 RFCT: provider/Git/테스트를 DB transaction 밖으로 분리한다. user_version 숫자만으로 old writer 차단을 대신하지 않는다. 실제 다중 세션 lock/RLS는 지원되는 격리 Postgres 또는 부모 환경에서 확인하며 단일 PGlite 결과로 주장하지 않는다.

## Phase 3 — 이관·호환 관리·동시 변경 유스케이스

**구현:** 신규 `common-memory-migration-server.ts`, 기존 `common-memory-server.ts`, legacy 호환 dispatcher. 포트와 의존성은 Phase 2의 injected 계약을 사용한다.
**검사:** 제안 `tests/common-memory-migration.test.ts`, `tests/common-memory-unified-contract.test.ts`; 실제 temp SQLite/파일 hash·fault injection을 사용한다.

- [ ] 🔴 RED U08: `migrationPreview_exactNhcsAssignments_preservesOriginalIdentityAndNoInit` — exact 등록 assignment와 원본 provenance·무변경 preview를 확인한다.
- [ ] 🔴 RED U09: `migrationExecute_verifiedReadback_handsOffOnceAndKeepsRecoverableHistory` — backup/fence→CAS/receipt→전체 hash readback→handoff와 같은 요청 replay를 확인한다.
- [ ] 🔴 RED U11: `migrationRecovery_crashAfterCloudCommit_readsStatusWithoutDuplicateExecution` — 재시작·timeout·not-found·권한/TTL 변경에서 조회만 수행하는지 확인한다.
- [ ] 🔴 RED U12: `migrationRequest_reboundOrPreHandoffReplay_rejectsConflictAndReturnsOriginalResult` — scope/hash/provenance 충돌과 이관 전 성공 영수증의 read-only replay를 확인한다.
- [ ] 🔴 RED U13: `migrationRollback_unknownOrLaterCloudEdit_keepsFenceUntilExactWithdrawalReadback` — exact withdrawal CAS/readback 이전의 fence 해제를 거부한다.
- [ ] 🔴 RED U15: `compatibleMutation_afterHandoff_routesCloudAndNeverReopensLocalAuthority` — 기존 API/MCP가 cloud current CAS로 관리하고 사람 검토 경계를 유지하는지 확인한다.
- [ ] 🔴 RED U16: `commonMemoryCommit_concurrentKnowledgeAndGoalCas_preservesBothOrReportsConflict` — 지식/목표 경쟁에 lost update가 없고 delta/receipt가 원자적으로 남는지 확인한다.
- [ ] 🟢 GREEN: preview→prepare→cloud commit→전체 state hash readback→handoff를 작은 유스케이스로 연결한다. unknown에는 원본/fence/pending key를 보존하고 status만 조회한다. 같은 ID의 다른 provenance는 채택하지 않으며 이관 전 replay는 원래 SQLite 결과를 반환한다.
- [ ] 🔵 RFCT: current.revision/cloud version/goalVersion을 명확히 분리하고 bounded before/after history를 공유한다. cloud 장애 때 로컬 편집 정본으로 회귀하지 않으며 rollback은 이후 편집이 없는 exact 확인에만 허용한다.

## Phase 4 — Strict HTTP/MCP/모바일·조회·권한 어댑터

**구현:** `src/commonMemoryRequest.ts`/client, 기존 remote transport, HTTP/MCP 좁은 dispatcher, `src/controlProfileConnections.ts`의 연결 증거. SDK strict DTO는 신규 `src/sdkReuseRequest.ts`에 둔다.
**검사:** 제안 `tests/common-memory-unified-contract.test.ts`, `tests/sdk-reuse-contract.test.ts`; 기존 실제 stdio·remote·OPS 회귀를 재사용한다.

- [ ] 🔴 RED U17: `unifiedPaging_filterBeforePage_boundsEscapedWireAndReportsFullCounts` — 필터 선적용·cursor/counts와 전체 escaped JSON 예산을 실제 전송에서 측정한다.
- [ ] 🔴 RED U20: `unifiedRequest_allTransports_enforcesStrictContractAndIndependentGrants` — unknown field/path/snapshot/scope·owner·spoof 및 독립 grant/중간 폐기를 확인한다.
- [ ] 🔴 RED U21: `aiConnection_configProbeAndObservedCall_neverAuthenticatesSpoofedClientName` — 실제 initialize/list/call과 설정/probe/관측 호출을 구분한다.
- [ ] 🔴 RED U22: `opsLaunch_supportedPreferences_persistAndRevalidateAtExecution` — 부모가 수정한 기존 OPS 회귀를 재사용해 지원 값·재시작·실제 실행 재검증을 확인한다.
- [ ] 🟢 GREEN: 하나의 strict 유스케이스 계약으로 HTTP/MCP/암호화 remote를 연결한다. migration은 meta+cloud, clone은 projects.add/exact root, binding은 memory.save, SDK는 source read·사람 승인·target 권한을 각각 확인한다. 구형 reader 구조를 유지하고 미지원 동작은 업데이트 안내로 응답한다.
- [ ] 🔵 RFCT: immutable snapshot을 wire에서 제외하고 current/list/members/goal/publication/reports를 페이지화한다. combined state≤1,000,000 bytes, escaped 창≤350KB, 조각4000 bytes, request600KiB/result2MiB, 8 global/4 owner/5분 TTL은 늘리지 않는다. TTL과 durable 영수증 수명을 분리하고 caller-supplied clientInfo.name을 provider 인증으로 쓰지 않는다.

## Phase 5 — 한 공통기억 화면·연결 상세·표시 정체성

**구현:** `src/CommonMemoryPanel.tsx` 하나, 신규 `src/CommonMemoryLinks.tsx`, 기존 `src/projectMemoryDirectory.ts`, `src/projectRole.ts`/`ProjectRoleLabels.tsx`; App에는 작은 연결부만 둔다.
**검사:** 제안 `tests/common-memory-links.test.ts`와 실제 React DOM/client barrier 검사; source regex 또는 렌더 snapshot만으로 판정하지 않는다.

- [ ] 🔴 RED U18: `sharedPanel_searchAndMultiCheck_preservesSelectionAndSeparatesScopePending` — 검색·페이지·보관 필터의 숨은 선택, ID별 부분 결과와 scope별 draft/pending을 확인한다.
- [ ] 🔴 RED U19: `projectIdentity_sharedLabelAndSdkFacet_keepsIdsFoldersAndDormantLinks` — canonical label·folder 독립성과 동명 ID/role/dormant 연결 보존을 확인한다.
- [ ] 🟢 GREEN: 장기기억과 같은 깊이의 현재 공통기억 탭에서 legacy+goal 검색·복수 체크·선택 개수·지식/목표/연결/이력을 관리한다. 별도 editable legacy 노출을 교체하고 프로젝트/폴더 상세에 이름·목표 미설정·게시/review·동일 관리 링크를 제공한다. QA3는 기본 목록·추천·새 적용에서 숨기고 보관함에서 복구한다.
- [ ] 🔵 RFCT: 한 공용 패널/연결 컴포넌트와 안정된 client를 사용한다. canonical memory label만 공유 표시하고 로컬 folder/ID·alias 계보는 보존한다. song/karaoke 동명 그룹·stale DEV 70839979로 합병하지 않는다. SDK는 검증 catalog 기반 facet이며 persisted ops/dev/managed와 모든 프로젝트 필터 의미를 유지한다.

## Phase 6 — SDK 실제 후보·안전한 문서·검사·사람 승인·대상 적용

**구현:** 신규 `sdk-reuse-server.ts`, `src/SdkReusePanel.tsx` 및 Phase 1/4의 후보·DTO helper. 기존 `src/sdkProjectManagement.ts` v0.2 catalog/status/prepare/recommend를 보존한다.
**검사:** 제안 `tests/sdk-reuse.test.ts`, `tests/sdk-reuse-contract.test.ts`; 실제 temp Git/files·짧은 허용 subprocess·browser sandbox를 사용한다.

- [ ] 🔴 RED U23: `sdkPrepare_selectedCodeAndMemory_createsOwnedCandidateWithoutDirtyRootRewrite` — actual implementation/lock/docs/demo manifest와 SDK/Cdp/source dirty hash 보존을 확인한다.
- [ ] 🔴 RED U24: `sdkHtml_maliciousEvidenceAndAssetPaths_cannotEscapeOwnedSandbox` — 실제 HTML escape·CSP/sandbox·asset allowlist·경로 경계를 확인한다.
- [ ] 🔴 RED U25: `sdkTest_fixedScenario_requiresActualExecutionAndCurrentArtifactHashes` — 실제 고정 check 영수증과 실패/not-run/timeout/변경을 구분한다.
- [ ] 🔴 RED U26: `sdkApproval_spoofOrStaleVersion_rejectsAndBindsExactHumanTargets` — 사람 action의 exact version/artifact/test/선택 target 결속과 자기 승인 거부를 확인한다.
- [ ] 🔴 RED U27: `sdkApply_changedTargetOrCrash_keepsPerTargetReceiptsWithoutAutoAdvance` — lease 아래 target CAS·journal·crash/unknown·동일 요청 replay를 확인한다.
- [ ] 🟢 GREEN: 목표+선택 등록 프로젝트의 code/memory hash 비교→owned staging/worktree의 실제 후보→`docs/reuse/<candidateId>/index.html` 설명/demo→고정 검사→사람 exact 승인→한 target씩 적용을 구현한다. 코드 없는 HTML, AI success 문자열, 추천·prepare만으로 완료 표시하지 않는다.
- [ ] 🔵 RFCT: artifact manifest와 before/after journal·durable receipt를 공용 helper로 정리한다. 적용 직전 root identity/memoryId/HEAD/dirty fingerprint/후보/권한을 재확인하고 conflict 파일을 유지한다. unknown은 조회만 하며 자동 재적용/다음 target 이동을 하지 않는다. portable 후보와 host-local 검사/준비/승인 token을 분리한다.

## Phase 7 — 통합 게이트·실제 Mac/iPhone persona·출하

**검사:** U28–U30은 root 소유 production pairing/SAS/relay·cloud readback·실제 설치 앱에서 실행한다. 연결 모델은 부모 관측 iPhone13 Pro Max/iOS26.3이며 기본 iPhone13 실측으로 바꾸어 표기하지 않는다.

- [ ] 🔴 RED U28: `realPersona_newUser_searchMultiCheckAndProjectLinks_understandsOneCommonMemory` — 처음 사용자 검색/선택/연결/관리·재시작·QA 보관/복구·cloud 정합성을 확인한다.
- [ ] 🔴 RED U29: `realPersona_oneHandAndLowVision_sharedSearchRemainsUsableWithKeyboardAndLargeText` — 한 손·큰 텍스트·키보드/VoiceOver·오류 처리의 실제 사용성을 확인한다.
- [ ] 🔴 RED U30: `realPersona_projectOwner_mcpAndSdkUnknownRecovery_requiresExactApproval` — 실제 AI MCP→후보/검사/승인/한 대상 적용·연결 유실/재연결을 확인한다.
- [ ] 🟢 GREEN: 집중 검사·현재 quick·verify 통과 뒤 실제 여정을 수행한다. request/receipt key·code/state hash·build·기기·시간과 실제 결과를 비밀 없이 기록한다. 실제 5G/SIM·다른 Mac이 없는 구간은 미실행으로 남기고 나머지 승인된 작업은 계속 완료한다.
- [ ] 🔵 RFCT: 발견한 재현 가능 결함만 필요한 회귀로 전환해 다시 검사한다. 16px 입력·44pt touch·한 열/접는 상세·focus/ARIA·텍스트 상태를 유지하며 fixture와 production 근거를 구분한다. clean/published source 확인 후 공식 설치 경로를 사용한다.

## Critical Files / 충돌 위험

| 파일·소유 범위 | 위험 | 완화·diff guard |
|---|---|---|
| `src/App.tsx` — root UI 연결 | 읽은 시점 16,669행, OPS/필터 동시 수정 | 새 CommonMemoryLinks/SdkReusePanel/helper로 분리; import/탭/상세 연결만 편집하고 root delta 보존 |
| `api-server.ts` — root 라우팅/등록 권한 | 읽은 시점 27,710행, OPS API 수정 중 | 신규 migration/SDK server에 조율; 작은 dispatch·허용 경로 연결, 기존 credential/lease 경계 유지 |
| `agentstoz-use-mcp-server.ts` — root MCP 연결 | 1,012행, 도구 schema·호환 계약 | 기존 이름·initialize/list/call 보존, strict mapper와 read-only 연결 증거만 좁게 추가 |
| `src/commonMemorySql.ts` + 정식 migration — DB adapter owner | PK field loss·권한·원자성·0-source 공격 | schema1/6테이블 additive guard; 기존 정책/EXECUTE 비교와 실제 SQL 거부 검사 |
| `src/metaCommonMemoryStore.ts` — migration adapter owner | 구형 writer·WAL backup·fence/history | group별 trigger/영수증; 소유 임시 DB에서 검증, 실제 원본 보존 및 rollout 순서 명시 |
| `common-memory-server.ts`, request/client/remote | current/goal 버전·grant·전송 예산 혼동 | domain 포트 시그니처 그대로; source/member 별도; broad replace와 한도 확대 금지 |
| `src/projectMemoryDirectory.ts`, role/filter, OPS helper/tests | 이름·ID/role 혼동, 현재 수정 유실 | canonical label과 folder 분리; SDK projection만 추가; 기존 OPS 5-pass 관측 회귀 재사용 |
| `src/sdkProjectManagement.ts`, 실제 SDK/Cdp/source/target | v0.2 계약 또는 사용자 dirty 데이터 손상 | 후보 소유 worktree/manifest·대상별 lease/journal; 기존 폴더 전체 rewrite/clear/reset 금지 |
| 신규 `tests/*unified*`, migration/SDK tests | 같은 이름 중복·회귀 약화 | TDD U01–U30 정본 이름 사용; 기존 의미 검사를 재사용하고 실패를 숨기는 assertion 변경 금지 |

- [ ] 각 phase 종료 시 owner 변경과 실제 diff를 대조하고 import/dispatch 밖 대형 파일 수정은 필요한 근거를 남긴다. 저장소·SDK·원본 기억에 무관한 수정이 섞이지 않았는지 확인한다.
- [ ] Push 전에 원격 실제 기본 브랜치를 조회해 fetch 후 `HEAD..<remote-default>` 차이를 확인한다. 5커밋 이상 뒤처졌다면 merge/재검증을 우선 검토한다. main을 추정하거나 force/reset으로 맞추지 않는다.

## 최종 Definition of Done

- [ ] U01–U30의 실제 결과를 구분해 기록하고 필요한 예외·거부·unknown 경계를 모두 검사한다. Unit 7/Integration 20/E2E 3은 계획 묶음 수이며 실행 테스트 수와 혼동하지 않는다.
- [ ] NHCS exact ID/revision/hash·active4·원래 snapshot/member/history와 현재 명시 member2를 fresh 확인하고 migration receipt+전체 hash readback으로 handoff를 증명한다. 원본 CORE/config/Git/registry·old Usher provenance와 복구 backup이 보존된다.
- [ ] SQLite old writer/fence와 cloud 형식 손실/RLS/CAS를 실제 엔진에서 확인한다. unknown/not-found·뒤늦은 commit에 자동 unfence/재실행/로컬 authority 재개가 없다.
- [ ] goal은 유동적으로 수정되고 지식/current가 유지되며 기존 검토/게시/pin 규칙이 작동한다. 0-source 지식은 관리/회상 가능하되 게시·추천/binding으로 승격되지 않는다.
- [ ] 한 검색·복수 선택 화면, ID별 부분 결과, 숨은 선택 개수, scope별 pending 복원, QA3 보관/복구와 프로젝트/폴더 연결 shortcut이 Mac/iPhone에 일치한다.
- [ ] canonical 표시명·로컬 folder 독립, 동명 그룹/단말 identity 보존, 모든 프로젝트 필터와 SDK facet·persisted ops/dev/managed 호환성을 확인한다.
- [ ] 독립 meta/cloud/projects.add/memory.save/source/target grant와 실행 직전 폐기 검사가 통과한다. OPS preference·UI role·callerName으로 권한을 만들지 않는다.
- [ ] 설정/probe/실제 MCP-call 근거를 구분한다. 기존 80/94 live tool 수는 부모의 과거 관측으로 명시하고 현재 실제 stdio/client tools/list+call을 다시 기록한다. 이 문서가 새 80/94 테스트 통과를 주장하지 않는다.
- [ ] SDK 목표·선택 source의 실제 code/memory 근거, 후보 implementation·safe HTML/demo·manifest·실제 test receipt·사람 exact 승인·대상별 적용/검증 receipt가 검토 가능하다. 기존 v0.2 prepare 호환과 dirty SDK/Cdp/source/target 보존을 확인한다.
- [ ] 다른 Mac의 clone/Pull은 후보 운반과 해당 Mac의 준비/검사를 구분한다. unknown 대상에 자동 재적용/다음 대상 쓰기가 없고 원래 key로 조회·명시 replay한다.
- [ ] `CommonMemoryMigrated`/`CommonMemoryMembershipChanged`/`SdkReuseCandidateApproved`/`SdkReuseCandidateApplied` 사실을 해당 durable receipt·delta에서 확인한다. 별도 event bus 없이 거래와 기록이 일치한다.
- [ ] 변경 핵심 순수 규칙·이관·SDK 권한/영수증 helper의 coverage≥90% 목표를 실제 범위/측정 종류/분모와 함께 평가한다. 측정되지 않거나 branch 도구가 지원하지 않는 부분은 그대로 표시하며 전체 저장소·실기 품질 수치로 확대하지 않는다.
- [ ] domain→외부 의존성 없음, Repository 포트 접근, 상수/예산 공유, 명확한 오류·미실행 상태와 필요한 설정/API/README 문서가 확인된다. 추가 credential·임의 shell/path·직접 cloud write 통로가 없다.
- [ ] 현재 quick와 `bun run verify`의 maintainer Python→typecheck→Bun→sidecar build+Rust가 통과하고 필요한 실제 persona 근거를 별도로 기록한다. 부모 OPS 5-pass는 부모 관측이며 최종 현재 회귀와 구분한다.
- [ ] GitHub 반영 시 원격 기본 브랜치와 최종 source를 확인한다. 공식 Mac/iPhone 설치는 clean/published source guard를 유지하고 미공개 검증 패키지를 공식 설치/배포로 사용하지 않는다.

## 빠른 시작 명령어

아래는 **구현자가 실행할 실제 러너 명령**이다. 새 테스트 파일은 Phase별로 만든 뒤 실행한다. 새 npm script·셋업 설치를 요구하지 않는다.

```sh
# 현행 대표 회귀
bun test ./tests/common-memory.test.ts ./tests/meta-common-memory.test.ts ./tests/sdk-project-management.test.ts --max-concurrency=1

# 새 core 파일 작성 후 첫 RED / watch
bun test ./tests/common-memory-unified.test.ts --max-concurrency=1
bun test ./tests/common-memory-unified.test.ts --watch

# 새 집중 파일 작성 후 실제 범위의 coverage
bun test ./tests/common-memory-unified.test.ts ./tests/common-memory-migration.test.ts ./tests/common-memory-unified-sql.test.ts ./tests/common-memory-unified-contract.test.ts ./tests/common-memory-links.test.ts ./tests/sdk-reuse.test.ts ./tests/sdk-reuse-contract.test.ts --coverage --max-concurrency=1

# 같은 작업/lease 안에서 현재 quick와 전체 게이트
python3 scripts/agentstoz-maintainer.py run --root . --profile quick
bun run verify
```

## 우려·briefing_correction

- **높음/높은 확신:** old writer/fence·unknown·PK field loss와 exact SDK 승인/target journal은 실행 전 핵심 게이트다. 근거: `metaCommonMemoryStore.ts:41,94–121`, `commonMemorySql.ts:64–100`, 최종 TDD U10–U16/U26–U27. 상태 문자열만 구현해서 완료할 수 없다.
- **중간/높은 확신:** 정상 legacy head는 512KiB지만 snapshot/current/goal 합계와 wire escaping은 별도 측정이 필요하다. 근거: `metaCommonMemoryStore.ts:114`, `metaCommonMemoryRemoteProtocol.ts:5`, U17. 초과 시 원본 보존·blocked를 반환한다.
- **briefing_correction:** 실제 MCP 파일은 `agentstoz-use-mcp-server.ts`; 별도 `sdk-project-server.ts`는 없고 현행 SDK route는 API에 있다. App/API 행 수는 root 동시 수정으로 Wave 1 시점과 달라졌다. OPS persistence 수정은 현재 helper에서 확인해 이미 수정된 회귀로 취급했다.
- **미검증:** 라이브 NHCS/QA/80·94 tool/기기·build·OPS 5-pass는 부모 제공 관측이다. 이번 역할은 이를 새 PASS로 승격하지 않았으며 source/API/tests/SDK/DB/원본 기억을 수정하지 않았다. 미해결 계획 매핑 충돌은 없다.
