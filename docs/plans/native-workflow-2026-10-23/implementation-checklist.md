# 구현 체크리스트: 상태 묶음 → 조회 도구 묶음 → 작업 팩

- 기준 HEAD `3619c91bc90ef83dd3b1ce6888db7e24edb45f09`. **구현 전 계획**이며 아래 테스트·검증은 이번에 실행하지 않았다.
- [domain-analysis.md](domain-analysis.md)·[architecture.md](architecture.md)·[tdd-strategy.md](tdd-strategy.md)가 정본이다. RED의25개 테스트명은 TDD 표를 그대로 인용한다. 신규 파일명도 제안이며 기존 `src/` flat·`tests/*.test.ts` Bun 관례를 유지한다.
- 모든 단위는 실제 RED 실패·이유 기록 → 최소 GREEN → 동작 유지 RFCT 순서다. 이름/내부구조만 검사하지 말고 권한·출처·부수효과·결과를 판정한다. 앞 Phase gate 전 다음 기능을 활성화하지 않는다.

## 환경 설정과 구현 전 고정

- [ ] 기존 worktree/branch·변경 파일을 확인하고 사용자 작업을 보존한다. 새 프로젝트/테스트 프레임워크/레이어 디렉터리를 만들지 않는다.
- [ ] TargetBinding/ReadBudget/SourceObservation과 정본 Repository signature를 고정한다. availability=`ready|unconfigured|partial|unknown|unavailable`, freshness=`current|stale|unknown` 두 축을 분리한다.
- [ ] Domain → Application → Interface adapter → Framework/UI 책임을 유지한다. module 4개는 목표이지 상한이 아니며 crypto/fs는 필요 시 `workPackStore.ts` adapter로 분리한다. 신규 engine/DB/runtime/browser/scheduler/SDK/catalog는 만들지 않는다.

## Phase1 — 프로젝트 상태 묶음

### 1. 순수 타입·예산·projection·source port

- [ ] 🔴 RED: T01 `source_observation_status_freshness_stay_independent`, T06 `preview_selection_redacts_sensitive_sources` — `tests/project-state-bundle.test.ts`에서 실패를 확인한다.
- [ ] 🟢 GREEN: `projectStateBundle.ts`의 정본 타입·exact parser·ReadBudget·SourceObservation projection과 `ReadSourceAdapter`를 최소 구현한다. 기존 report의 commit/fingerprint·unknown/미설정·출처를 보존하고 선택된 안전 요약만 만든다.
- [ ] 🔵 RFCT: 순수 domain에서 React/fs/DB/provider 의존을 제거하고 단위·byte 상수를 공통화한다. raw diff/log/PTY/env/credential/기억 전체를 자동 전송할 경로가 없는지 확인한다.

### 2. 같은 host executor와 Fake reader

- [ ] 🔴 RED: T02 `binding_branch_head_change_blocks_send`, T04 `binding_grant_revoked_blocks_all_send`, T05 `preview_readers_no_domain_mutation` — `tests/project-state-bundle-host.test.ts`의 fake clock/binding/read 호출 장부로 실패를 확인한다.
- [ ] 🟢 GREEN: `projectStateBundleHost.ts`에 fixed-list collect를 만들고 시작/끝/전송 직전 binding을 재검증한다. 변경은 전체 invalidated·송신 0회다. thread 없는 volatile preview를 허용하고 test/AI/기억쓰기/Pull/keycreate/index/history-probe/create-thread는0회로 유지한다.
- [ ] 🔵 RFCT: P2도 같은 host/reader/budget/취소를 재사용하게 한다. snapshot 전용 큐/timeout을 따로 만들지 않는다. source 변화는 invalidated/partial로 표시하며 전역 atomic 보장을 주장하지 않는다.

### 3. 좁은 기존 reader 연결

- [ ] 🔴 RED: T03 `binding_checkout_recreate_blocks_send` — `tests/project-state-bundle-api.test.ts`의 임시 Git/worktree로 실패를 확인하고 T05를 실제 adapter 경계에도 적용한다. 공통 예산의 T11 `budget_concurrency_and_bounds_hold`, T12 `budget_deadline_output_utf8_limits_are_explicit`, T13 `cancel_timeout_hold_real_slots`는 Phase1 preview에도 먼저 적용한다.
- [ ] 🟢 GREEN: 기존 inventory/checkout proof/Git 요약/activity snapshot/tester metadata/curated memory를 주입한다. 기억은 includeCommon:false·skipJournal:true가 기본이며 I/O 전 바이트 한도를 적용한다. 느린 source 중 다른 API와 취소 UI도 응답하도록 비동기 reader 또는 해당 source의 기존 격리 probe를 사용한다. 동기 reader를 Promise.race로 감싸는 것만으로 중단을 보장하지 않는다. tester receipt reconciliation만 별도 metadata 장부로 구분한다.
- [ ] 🔵 RFCT: generic shell/URL/credential·USE broad status·history resume probe를 reader에서 제거한다. 같은 경로 재생성·main fallback·부분 source 오류와 권한 실패를 구분한다.

### 4. exact API·Rust proxy·선택 전송

- [ ] 🔴 RED: T07 `preview_submission_exact_scope_unknown_no_replay`, T23 `api_capability_routes_limits_and_remote_fail_closed` — `tests/project-state-bundle-api.test.ts` 및 기존 Rust 테스트에서 실패를 확인한다.
- [ ] 🟢 GREEN: 제안된 정확한 POST 경로·operation union·capability/origin/owner guard·native/web client를 붙인다. 신규 control4 KiB/result32 KiB와 path timeout만 적용하고 기존 proxy 상한은 확대하지 않는다. 선택 전송은 기존 submission receipt/정확 target·hash를 사용한다.
- [ ] 🔵 RFCT: `api-server.ts`는 작은 import/조립/위임으로 제한한다. channel byte 초과는 전송전 거절, unknown은 원래 receipt 조회로 처리한다. remote/MCP/USE/OPS 미지원은 명시 거절하고 DEV fallback하지 않는다.

### 5. 기존 UI preview와 Phase1 gate

- [ ] 🔴 RED: T24 `ui_ko_en_keyboard_ime_focus_preview` — `tests/project-state-bundle.e2e.mjs`의 기존 Workroom/Prompt UI journey에서 실패를 확인한다.
- [ ] 🟢 GREEN: thread 없는 preview·항목선택·기존 draft 첨부와 ko/en·dialog label·IME/keyboard/focus를 구현한다. 열기/선택만으로 실행·전송·AI launch가 발생하지 않게 한다.
- [ ] 🔵 RFCT: 기존 composer/panel 안에 배치하고 별도 mission/catalog UI를 만들지 않는다. Phase1 gate는 같은 target의 제한된 근거, 두 축 상태·민감정보 제한·명시선택·binding 변경 전체차단의 관측 가능한 증거로 닫는다.

## Phase2 — 조회 도구 묶음

### 6. strict plan·DAG·typed reference

- [ ] 🔴 RED: T08 `batch_allowlist_strict_no_code_or_mutation`, T09 `batch_dag_and_typed_refs_validate_before_admission` — `tests/project-state-bundle.test.ts`에서 실패를 확인한다.
- [ ] 🟢 GREEN: 정본 5 operations, 선행 step 부분집합 dependsOn·고정 조건·tester.latest.runId typed 참조만 허용한다. unknown key/code/mutation/cycle/잘못된 참조는 admission/adapter 실행전에 거절한다.
- [ ] 🔵 RFCT: target/role/grant를 stage가 바꿀 수 없게 하고 source input union 검증을 한곳에서 재사용한다. 임의 JS/JSONPath/eval과 generic runner를 도입하지 않는다.

### 7. 같은 executor·예산·취소

- [ ] 🔴 RED: T10 `batch_dependencies_fail_skip_and_partial`, T11 `budget_concurrency_and_bounds_hold`, T12 `budget_deadline_output_utf8_limits_are_explicit`, T13 `cancel_timeout_hold_real_slots` — host fake와 `tests/project-state-bundle-api.test.ts`의 느린 I/O 통합 벡터에서 실패를 확인한다. Phase1의 같은 예산 검사를 조회 조합에도 적용한다.
- [ ] 🟢 GREEN: 기존 executor에 사용자 단계 목록만 추가한다. 독립조회 bounded 병렬·의존 순서·skipped/이유·단계 receipt·source/전체 deadline·I/O/output/UTF8 한도·AbortSignal을 구현하고 실제 native/child 종료 전 slot을 유지한다.
- [ ] 🔵 RFCT: 무한 대기열·자동 timeout상향·취소즉시종료 가정을 제거한다. preview TTL과 실행수명은 분리하며 UI 숨김도 admitted 작업/receipt를 취소하지 않는다.

### 8. 기존 exact DEV thread의 append-only receipt·CAS·v4

- [ ] 🔴 RED: T14 `receipt_exact_thread_append_only_cas_never_replays`, T20 `thread_v4_old_writer_rollback_preserves_records` — `tests/workroom-thread-read-execution.test.ts`; T15 `receipt_owner_role_device_access_control` — `tests/project-state-bundle-api.test.ts`에서 실패를 확인한다.
- [ ] 🟢 GREEN: durable admission은 **선택한 기존 exact DEV threadId 필수**로 한다. read/CAS도 threadId 명시→ThreadStore.get(threadId)→owner/target검증→nested run lookup, key=(threadId,requestId,owner/binding intent)로 구현한다. runId별 append-only metadata, CAS충돌은 metadata만 재병합하고 완료 source 재호출은0회로 한다.
- [ ] 🔵 RFCT: 새 thread/CLI/가짜agent·전체 JSON scan·새 index/DB를 금지하고 `serviceExecution`/`thread.state`를 덮어쓰지 않는다. record·총량 한도 도달은 admission 정지다. version1..4 읽기·단조 version·oldhost failclosed, 활성화전 backup을 검증한다. feature-off와 실제 downgrade의 원본 보존/명시복원을 구분한다.

### 9. 기존 결과 UI와 Phase2 gate

- [ ] 🔴 RED: T25 `ui_cancel_aria_live_ignores_late_results` — `tests/project-state-bundle.e2e.mjs`에서 실패를 확인한다.
- [ ] 🟢 GREEN: 기존 업무에 작은 run reference+summary만 표시하고 partial/cancelled/unknown·재시작을 구분한다. 늦은 결과가 다른 선택에 표시되지 않게 하며 aria-live/alert와 취소상태를 제공한다.
- [ ] 🔵 RFCT: 재연결/원래 ID read는 재실행이 아니게 유지한다. Phase2 gate는 T08–T15/T20/T25·기존USE 회귀, completed source 재호출 0회와 정확 권한 증거로 닫는다.

## Phase3 — 기존 규격 명령 기반 작업 팩

### 10. sidecar·source identity·CAS·key provenance

- [ ] 🔴 RED: T16 `workpack_manifest_scope_cas_body_binding`, T17 `workpack_legacy_guides_roundtrip_preserves_meaning`, T18 `workpack_source_edits_deletes_reimports_need_review`, T19 `workpack_storage_keys_future_schema_preserved` — `tests/work-pack-store.test.ts`에서 실패를 확인한다.
- [ ] 🟢 GREEN: sourceLibrary/account identity+guideId+commandBodyHash/definitionRevision CAS, 기존 lock/atomic-write·전용key/AAD·bounded 암호화 sidecar를 구현한다. 본문·local/shared 원본 schema/RPC는 불변, read keycreate 0회·명시 첫 저장만 생성한다. body/kind변경 stale·삭제 orphan/tombstone·재import/계정 전환은 명시재검토다.
- [ ] 🔵 RFCT: pin/reorder/title은 의미 변경과 구분하고 legacykind/simple/command roundtrip을 유지한다. virtual builtin은 사용자 저장 전 승격금지, 손상/future schema/키유실은 원본 보존·실행차단이다. 공유 metadata 동기화·새 명령복제·자동부활을 넣지 않는다.

### 11. typed 완료 조건과 기존 Prompt UI

- [ ] 🔴 RED: T21 `workpack_schema_conditions_do_not_grant_or_assert_pass` — `tests/work-pack.test.ts`, T24의 기존 Prompt UI 회귀를 먼저 실패로 확인한다.
- [ ] 🟢 GREEN: `workPack.ts`에서 정본 입력schema/typed condition/검토상태를 구현하고 기존 PromptGuideBar/SharedPromptGuideBar에 입력·단계preview·명시실행을 붙인다. 정의 검토·조회 완료·실제 검사 verdict를 구분한다. T24 UI에서 legacy kind/simple/command·pin/reorder·edit/delete/reimport의 stale/orphan·principal 전환을 직접 확인한다.
- [ ] 🔵 RFCT: target/role/grant/profile 지정·자연어 자동실행을 거절한다. crypto/fs는 adapter로 격리하고 기존 텍스트 명령 사용을 보존한다. 불확실한 shared source는 팩unsupported로 표시한다.

### 12. 두 프로젝트 재사용과 Phase3 gate

- [ ] 🔴 RED: T22 `workpack_two_projects_runs_never_cross_bind` — `tests/project-state-bundle-host.test.ts`의 두 등록프로젝트/기존 DEV thread로 실패를 확인한다.
- [ ] 🟢 GREEN: 동일 reviewed 정의에 두 대상·입력을 매 실행 새로 결속한다. WorkPackRun은 같은 executor/batch projection이며 동일 threadId/requestId/owner-binding key와 append-only receipt를 사용한다.
- [ ] 🔵 RFCT: 정의/기억/receipt 중복저장·A/B 결과 혼합·thread.state 덮어쓰기를 제거한다. Phase3 gate는 T16–T22와 T23–T25회귀·원본 보존·두 프로젝트 여정 증거로 닫는다.

## Critical Files / 충돌 위험

| 파일 | 위험 | 완화 |
|---|---|---|
| `api-server.ts`, `src/App.tsx` | 큰 조립/UI 파일·동시 수정 충돌 | 신규module import·작은 위임만, 편집owner를 정하고 단계별 diff검토 |
| `src/i18n.ts`, 기존 Workroom/Prompt 패널 | ko/en 누락·IME/focus/late result 회귀 | 같은 UI패치에서 ko/en·T24/T25, 기존 navigation 재사용 |
| `src-tauri/src/lib.rs` | exact proxy·timeout·포장build 회귀 | 정확 경로만 허용, blanket 상한변경금지·기존 Rust회귀 |
| `src/workroomThreadStore.ts`, thread service/protocol | schema/USE/미완료기록 손실·가짜launch | v4단조guard·T14/T20, get(threadId)→nestedrun, 기존 상태불변 |
| `src/promptGuideStore.ts`, `src/promptGuideClient.ts`, `src/sharedPromptGuideClient.ts`, `src/sharedPromptGuideSql.ts` | strict keys·old writer·본문손실 | 기존schema/RPC/본문불변, sidecar exact source+CAS·T16–T19 |
| `project-memory-server.ts`, 기존 tester host, `build-sidecar.ts` | read에 숨은 mutation·새module 패키징 누락 | 좁은 reader/port·부수효과장부·기존 sidecar compile검증 |

- [ ] 병렬 편집 전 위 파일의 소유 구간을 나누고 단계별 diff를 검토한다. 사용자 변경을 자동으로 덮어쓰거나 이번 계획을 push·merge 지시로 해석하지 않는다.

## 최종 Definition of Done와 검증 순서

- [ ] 구현 검증 시작시 tester ensure를 **세션당 1회** reconcile한다. installed/updated/ready면 MAINTAINER의 quick 기본 또는 변경에 맞는 workroom-improvement를 사용한다. unreachable/skipped/not registered면 이유 한 줄 후 기존 runner로 계속한다.
- [ ] configured full persona를 실행한다: `python3 scripts/agentstoz-maintainer.py personas run --root .`. `tests/personas/catalog.json`의 16역할·legacy fallback(`scripts/persona-tests.py:1-12`)을 확인하고 quick의4개 common-memory-personas를 full로 간주하지 않는다. 이미 profile에 포함한 full은 중복실행하지 않는다. catalog 없음은 unconfigured다.
- [ ] `bun run verify`의 실제 순서 test:maintainer→typecheck→test→test:rust(sidecar+cargo)를 충족하고 `bun run test:smoke` 별도 결과를 기록한다. smoke는 변경 소스의 격리 dev API/Vite와 기존 .mjs fixture의 임시 서버·app-data 경로를 재사용하며, 설치된 3001 sidecar/실데이터 결과를 새 소스 검증으로 혼동하지 않는다. macOS에서 APP_DATA_DIR 환경변수 하나만으로 격리됐다고 가정하지 않는다. 신규module의 sidecar 포함을 확인하되 요청 없는 앱 build/설치/배포는 하지 않는다.
- [ ] T01–T25와 중요 예외·권한·재시작·CAS·예산 시나리오의 실제 판정을 연결한다. coverage%/PASS 수치를 미리 약속하지 않는다. 순수 domain·port 접근·동일executor·opaque/비밀없는 event참조·명확한 에러·ko/en·설정/한계 문서를 검토한다.
- [ ] 기존 16역할의 goal/여정 확장을 우선 비교하고 구현 후 active context/current revision에서만 personas propose한다. actor/reason/시작 상황/ordered journey/success/source/checkId를 포함하고 부족 check는빈 값·needs checks, 후보 64개 한도 때문에 기존 후보를 자동삭제하지 않는다. 제안은 활성화/PASS가 아니다.
- [ ] synthetic Bun/API/UI, 설치 Mac, 실제 Windows PC, 모바일/원격거절을 별도증거로 기록한다. 미실행 환경은 미검증이며 fixture 성공으로 대신하지 않는다. 요청없이 Actions VM/실기기 빌드/배포로 대체하지 않는다.

## 빠른 시작 명령어 — 구현 때 실행, 현재 미실행

```sh
bun test ./tests/project-state-bundle.test.ts --watch
bun test ./tests/project-state-bundle-host.test.ts
bun test --coverage ./tests/project-state-bundle.test.ts
python3 scripts/agentstoz-maintainer.py personas run --root .
bun run verify
bun run test:smoke
```

우려: 높음/확신높음 — v4후 구형 host의 전체 thread 접근 차단·read부수효과·CAS 중복 호출은 T05/T14/T20의 필수gate다(architecture 근거표). 중간/확신높음 — 실제 native 종료는 synthetic 증거만으로 충족하지 않는다(T13). `briefing_correction`: durablebatch는 새 기록 row/가짜 thread가 아닌 선택한 기존 exact DEV thread의 append-only nested metadata로 수용기준을 구체화했다. 정본 문서의 최종 signature 수정은 plan-lead가 담당하며 이 체크리스트는 기존 문서를 수정하지 않았다.
