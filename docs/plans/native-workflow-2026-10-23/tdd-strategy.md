# TDD 전략: 프로젝트 상태 묶음 → 조회 도구 묶음 → 작업 팩

- 작성일: 2026-10-23 (Asia/Seoul). 기준 HEAD: `3619c91bc90ef83dd3b1ce6888db7e24edb45f09`.
- 정본: [domain-analysis.md](domain-analysis.md), [architecture.md](architecture.md)의 용어·Repository·논리 4레이어. 아래 파일/테스트명은 신규 제안이다. 이번 계획 작성에서는 테스트를 실행하지 않았다.

## 목표와 테스트 피라미드

Phase 1의 고정 ProjectStateBundle, Phase 2의 ReadToolBatch, Phase 3의 WorkPackRun이 같은 TargetBinding·ReadBudget·SourceObservation·executor를 사용한다는 행동을 검증한다. 이름/폴더 구조를 테스트하는 대신 권한·대상·출처·부수효과·영수증의 관측 가능한 결과를 검사한다. 독립 engine/UI/DB/scheduler/SDK/marketplace나 외부 ego/Aside 의존을 전제하지 않는다.
25개 이름을 체크리스트의 정본으로 고정한다. Unit/domain·host fake, 실제 저장소/API 통합, UI journey를 구분하되 한 이름이 여러 검증 유형을 포함할 수 있다. 표의 한 이름은 parameterized 하위 벡터를 가질 수 있으므로 실제 assertion/테스트 개수는 구현 후 달라질 수 있다. 숫자는 계획이며 PASS/coverage 실측이 아니다.
실행 순서는 순수 domain/VO→host fake→기존 암호화 store·API 통합→기존 UI다. 각 단계는 RED(의도한 행동으로 실패 확인)→GREEN(최소 구현)→REFACTOR(동일 행동 유지)로 진행한다. 기능 Phase 1 gate를 통과하기 전 Phase 2를 활성화하지 않으며 Phase 3도 같은 원칙을 따른다.

## Mock/Fake 전략

| 의존성 | 전략 | 검증 이유 |
|---|---|---|
| 시간·timeout·TTL | 주입 fake clock, 수동 advance | sleep 없이 source/전체 deadline·preview TTL·late completion 재현 |
| adapter·child/native invoke | 시작/종료/abort가 독립인 bounded fake, 호출 장부 | AbortSignal 전달과 실제 종료를 분리해 종료 전 slot 반환을 잡음 |
| target/grant/source | revision/branch/HEAD/checkout proof를 바꾸는 fake | 수집 시작·중간·끝·전송 직전 변경을 각각 재현 |
| 순수 parser/projection/condition | 실제 함수, mock 금지 | strict 입력·두 축 상태·민감정보 projection을 행동으로 검사 |
| ThreadStore/sidecar/key provider | 통합에서는 임시 실제 파일/SQLite/crypto+주입 test key | CAS·lock·schema·key namespace·원본 보존 검증, 실제 Keychain/login 없음 |
| Git/API/UI | 임시 두 프로젝트/워크트리, in-process handler, 기존 UI test harness | 실제 권한 계정/기억/credential 없이 target 격리·route·UI 검증 |

## Given / When / Then 테스트 목록 — 이름 정본

아래 U=Unit/domain, H=host fake, I=기존 store/API 통합, UI=synthetic UI journey다. P1/P2/P3는 기능 단계다. source 수집 중 mutation callbacks는 0회이며 기존 tester의 제한 receipt metadata reconciliation은 별도 장부로 구분한다.

| ID / 고정 테스트명 | Phase / 파일 / 유형 | Given | When | Then |
|---|---|---|---|---|
| T01 `source_observation_status_freshness_stay_independent` | P1 / `tests/project-state-bundle.test.ts` / U | ready/unconfigured/partial/unknown/unavailable 및 current/stale/unknown source, commit 같고 dirty fingerprint 다른 report | 묶음 projection | 두 축·observedAt·sourceProducedAt·limits 유지, mismatch=stale/미증명=unknown, 빈 catalog/과거 PASS를 현재 PASS로 바꾸지 않음 |
| T02 `binding_branch_head_change_blocks_send` | P1 / `tests/project-state-bundle-host.test.ts` / H | 수집 전후 또는 전송 직전 branch/HEAD가 바뀌는 target | collect/선택 전달 | 전체 invalidated·모델 전송 0회, 정상 source의 partial로 권한/identity 실패를 숨기지 않음 |
| T03 `binding_checkout_recreate_blocks_send` | P1 / `tests/project-state-bundle-api.test.ts` / I | 임시 Git worktree를 같은 경로에 재생성, opaque ID는 같고 checkout proof는 다름 | fresh resolve 후 전달 | inode/common-dir/family proof 변경으로 전체 차단, main checkout fallback·client path 수신 없음 |
| T04 `binding_grant_revoked_blocks_all_send` | P1 / `tests/project-state-bundle-host.test.ts` / H | owner/device/role/grant가 단계 도중 또는 반환 직전 바뀜 | collect/전달 | 후속 adapter 중지 및 전체 모델 전송 차단, USE/OPS/remote를 DEV로 대체하지 않음 |
| T05 `preview_readers_no_domain_mutation` | P1 / `tests/project-state-bundle-host.test.ts` / H | test/AI/remember/Pull/history-probe/keycreate/index/create-thread 콜백과 metadata reconciliation 장부 | thread 없는 preview | 금지 콜백 0회, curated-only skipJournal/includeCommon:false, 허용 tester metadata만 구분 기록, 키/저장소 미준비도 preview 유지 |
| T06 `preview_selection_redacts_sensitive_sources` | P1 / `tests/project-state-bundle.test.ts` / U | fake secret·절대경로·PTY/log/env/raw diff·기억 source와 사용자 선택 | 모델용 projection | 선택한 허용 요약만, mask/withheld·UTF-8 한도·비신뢰 데이터 경계 보존, 숨은 원문/계정 비밀 없음 |
| T07 `preview_submission_exact_scope_unknown_no_replay` | P1 / `tests/project-state-bundle-api.test.ts` / I | 기존 composer/submission receipt, 제한 넘는 입력 또는 write_started 뒤 응답 소실 | 사용자가 명시 전달/같은 ID 재조회 | exact target/source/hash/선택을 검증, 초과는 전송 전 거절, written/unknown을 보존하며 자동 재전송/AI launch 없음 |
| T08 `batch_allowlist_strict_no_code_or_mutation` | P2 / `tests/project-state-bundle.test.ts` / U | 정본 5 operations와 unknown key/JS/eval/shell/path/URL/credential/test-start/remember/push/Pull/app-launch 입력 | parse/admit | 허용 strict union만 승인, 나머지는 adapter/receipt admission 전에 거절 |
| T09 `batch_dag_and_typed_refs_validate_before_admission` | P2 / `tests/project-state-bundle.test.ts` / U | duplicate/cycle/깊이초과/뒤 stage/임의 JSONPath 및 tester.latest.runId typed ref | plan 검증 | 유효한 앞선 의존/고정 조건/runId ref만 허용, 잘못된 전체 계획은 0단계 실행 |
| T10 `batch_dependencies_fail_skip_and_partial` | P2 / `tests/project-state-bundle-host.test.ts` / H | 독립 성공/실패와 unconfigured/unknown predecessor | 공통 executor 실행 | 독립 결과 보존·종속 skipped/이유·단계별 시각과 상태 유지, identity 실패는 전체 중단 |
| T11 `budget_concurrency_and_bounds_hold` | P1/P2 / `tests/project-state-bundle-host.test.ts` / H | host/batch/target 상한과 아직 settle 안 된 children | 여러 batch admission 및 단계 실행 | 독립 단계만 상한 이내 병렬, 종속 순서 유지, 초과 거절·무한 대기열 없음, P1/P2 동일 집행 |
| T12 `budget_deadline_output_utf8_limits_are_explicit` | P1/P2 / `tests/project-state-bundle-host.test.ts`, `tests/project-state-bundle-api.test.ts` / H+I | 느린 source·대형 stdout/stderr·multibyte 경계·큰 기억 manifest 및 bounded async/격리된 기존 probe | fake clock advance와 느린 source 수집 중 다른 API/cancel UI 요청 | IO 전 byte gate·deadline·bounded partial/unknown/truncated와 사유, event loop/API/cancel UI 응답 및 실제 IO/child 종료까지 slot 유지. 동기 readMemoryDocument/helper를 Promise.race로 감싸 종료를 보장했다고 주장하지 않으며 차단성 reader는 해당 source만 분리하거나 unsupported |
| T13 `cancel_timeout_hold_real_slots` | P1/P2 / `tests/project-state-bundle-host.test.ts` / H | abort를 받아도 아직 살아 있는 child/native invoke | 취소/timeout→새 요청→실제 settle | 신규 stage 중단·신호 전달, 실제 종료 전 slot 유지, settle 미확정은 unknown, 완료 전 동시성 초과 없음 |
| T14 `receipt_exact_thread_append_only_cas_never_replays` | P2 / `tests/workroom-thread-read-execution.test.ts` / I | 선택한 기존 exact DEV thread, key=(threadId,requestId,owner/binding intent), 완료 source 및 CAS 충돌/old boot | admit/retry/read/CAS/restart | threadId 필수·ThreadStore.get(threadId) 후 nested run lookup, 같은 입력 원래 receipt/다른 입력 conflict, append-only metadata 재병합·완료 source 재호출 0, 새 thread/CLI/가짜 agent/전체 JSON scan/index 0, serviceExecution/thread.state 불변·old running=unknown·만료된 값은 payload unavailable, receipt read가 source를 다시 수집하지 않음 |
| T15 `receipt_owner_role_device_access_control` | P2 / `tests/project-state-bundle-api.test.ts` / I | 명시 threadId의 원래/다른 owner·역할·기기 및 revoked binding 결과 | read/cancel/첨부 | get(threadId) 후 owner/target 검증 및 nested run lookup, 현재 원래 권한만 허용, readAll로 USE/팩 우회 없음·다른 thread/target/계정 원문 노출 없음 |
| T16 `workpack_manifest_scope_cas_body_binding` | P3 / `tests/work-pack-store.test.ts` / I | local/shared/계정 A·B의 같은 guideId, library/definition revision·본문 hash | read/save/prepare | sourceLibraryId/account+guideId+hash exact 결속, 두 CAS 충돌 보존, unrelated library 변경을 의미변경으로 단정하지 않음 |
| T17 `workpack_legacy_guides_roundtrip_preserves_meaning` | P3 / `tests/work-pack-store.test.ts` / I | kind 없음/simple/command·virtual builtin·pin/reorder/title 변경 | 기존 local/shared roundtrip 및 팩 연결 | 기존 v1 entry/본문 보존·optional 필드 주입 없음, pin/reorder 의미 유지, builtin은 사용자 사본 저장 전 팩 승격 불가 |
| T18 `workpack_source_edits_deletes_reimports_need_review` | P3 / `tests/work-pack-store.test.ts` / I | reviewed 팩의 body/kind 편집·삭제·같은 ID/body reimport·계정 전환 | prepare/read | stale/orphan/provenance unknown 차단, tombstone 유지·자동 부활 없음, 명시 재검토 전 실행 불가, 과거 run 참조 보존 |
| T19 `workpack_storage_keys_future_schema_preserved` | P3 / `tests/work-pack-store.test.ts` / I | 전용 key/AAD·키없음/다른 namespace·손상/future schema·symlink/hardlink/과대 파일 | read/save 실패 및 feature-off | read keycreate 0회·원본 그대로·execution 차단, 새키/하향/본문복사로 복구 없음, 명시 첫 저장만 keycreate |
| T20 `thread_v4_old_writer_rollback_preserves_records` | P2/P3 / `tests/workroom-thread-read-execution.test.ts` / I | v1..3 및 readExecutions v4, 기존 USE write, 미완료/dedupe·pre-v4 backup | 새/구형 host 접근·feature-off·복원 검토 | version 단조증가·old host fail closed·자동 downgrade 없음, 원본/미완료 보존·예산 초과 admission 거절, rollback 비용 명시 |
| T21 `workpack_schema_conditions_do_not_grant_or_assert_pass` | P3 / `tests/work-pack.test.ts` / U | input schema/고정 조건·팩의 target/role/grant/profile 지정·AI 성공문자열·실패 tester report | validate/condition 판정 | 권한 지정/eval 거절, 정의 검토는 실행이 아님, required 조회 완료와 실제 tester verdict 분리·자연어 자동실행 0회 |
| T22 `workpack_two_projects_runs_never_cross_bind` | P3 / `tests/project-state-bundle-host.test.ts` / H | 같은 reviewed 팩과 등록 프로젝트 A/B·선택한 기존 exact DEV thread 두 개·다른 입력/source | 각각 명시 실행 | (threadId,requestId,owner/binding intent)에 새 결속·같은 executor, WorkPackRun은 batch projection·append-only metadata, 정의/기억/receipt 중복 저장·A/B 결과 혼합·thread.state 덮어쓰기 없음 |
| T23 `api_capability_routes_limits_and_remote_fail_closed` | P1/P2/P3 / `tests/project-state-bundle-api.test.ts` 및 `src-tauri/src/lib.rs` 기존 테스트 / I | exact route/method·capability/origin 및 remote/unknown operation·과대 요청 | handler/Tauri proxy 호출 | 기존 권한 아래 strict union만, 신규 좁은 budget 유지·임의 proxy/path 금지, remote/MCP 미지원은 명시 거절 |
| T24 `ui_ko_en_keyboard_ime_focus_preview` | P1/P3 / `tests/project-state-bundle.e2e.mjs` / UI | 기존 UI의 ko/en·키보드/IME·thread 없는 preview, legacy kind 없음/simple/command, source principal/account | 미리보기/선택/편집/닫기 및 roundtrip·pin/reorder·edit/delete/reimport·계정 전환 | 별도 mission/catalog UI 없음·IME Enter 오전송 0·focus/label 유지·명시 전 실행/전송 0. 기존 명령 roundtrip·pin/reorder 의미 보존, 편집/삭제/재가져오기 stale/orphan 표시·실행 차단, principal/account 전환 후 원래 팩/결과 오노출 없음 |
| T25 `ui_cancel_aria_live_ignores_late_results` | P1/P2/P3 / `tests/project-state-bundle.e2e.mjs` / UI | 수집 중 선택 변경·취소·UI숨김/재연결·늦은 응답 | 결과 도착/대상 전환 | 이전 선택 결과를 현재 화면에 쓰지 않음, aria-live/alert와 텍스트 상태·취소/unknown 표시, 숨김이 재실행 trigger가 아니며 admitted 작업/receipt 유지 |

## 도메인/아키텍처 추적

| 정본 요소 | 우선 테스트 |
|---|---|
| TargetBinding / SourceObservation / ProjectStateBundle | T01–T07. Domain `projectStateBundle.ts` 순수 검증과 Application `projectStateBundleHost.ts`의 재검증 구분 |
| ReadToolBatch / ReadStep / ReadBudget / Repository CAS | T08–T15, T20. 같은 adapter·executor, 기존 ThreadStore facade와 API를 연결 |
| WorkPackDefinition / sourceLibraryId / commandBodyHash | T16–T19, T21. `workPack.ts`는 순수 정의/준비, crypto/fs는 필요 시 `workPackStore.ts` adapter |
| WorkPackRun / completion condition / events | T14, T21–T22. projection·원래 receipt·상태 연결을 검사하며 새 journal/event bus를 만들지 않음 |
| Framework/UI 및 기존 자산 회귀 | T17, T20, T23–T25. 기존 guides/USE/대화 metadata 보존·정확 proxy·React 상호작용 |

## 검증 실행 workflow — 구현 시 적용

1. 세션에서 아직 하지 않았다면 등록 프로젝트 tester를 한 번만 reconcile한다. 이미 결과가 있으면 재호출하지 않는다. 이 단계 자체는 테스트/커밋을 수행하지 않는다.
```sh
curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel 2>/dev/null || pwd)" http://127.0.0.1:3001/api/project-tester/ensure
```
2. installed/updated/ready면 `.agentstoz/MAINTAINER.md`의 해당 normal profile(quick 기본, 변경과 맞으면 workroom-improvement)을 따른다. unreachable/skipped/not registered는 이유 한 줄 후 기존 runner로 계속한다. 순수/host fake는 `bun test ./tests/해당파일.test.ts`처럼 tests 범위에서 시작한다.
3. configured persona 전체를 실행한다: `python3 scripts/agentstoz-maintainer.py personas run --root .`. catalog는 `tests/personas/catalog.json`의 16역할, legacy fallback은 `scripts/persona-tests.py:1-12`다. quick의 common-memory-personas 4개는 전체를 대체하지 않는다. profile이 실제 full persona를 이미 포함하면 중복 실행하지 않는다. catalog 없음은 unconfigured이며 PASS가 아니다.
4. 변경 범위 테스트 뒤 실제 `bun run verify` 경로는 `test:maintainer → typecheck → test → test:rust(sidecar+cargo)`다. `bun run test:smoke`는 별도 runner이며 변경 소스에 맞는 격리된 개발 API/Vite를 대상으로 실행한다. 기존 `.mjs` fixture의 임시 서버·임시 app data 경로를 재사용하고 설치된 기존 3001 sidecar/실데이터를 검사한 결과와 혼동하지 않는다. macOS에서 APP_DATA_DIR 하나만 지정해 격리됐다고 가정하지 않는다. 같은 검사를 이미 완료한 profile에서 충족했다면 실행 근거를 연결하며 불필요하게 반복하지 않는다.
5. 기존 16역할의 goal/여정 확장을 우선 비교한다. 빠진 새 journey는 구현 후 active context/current revision으로 personas propose하며 actor/reason/situation/ordered journey/success/source/checkId를 포함한다. check 증거가 없으면 빈값·needs checks, 후보 64개 상한의 기존 항목 자동 삭제 금지. 실제 검사 구현 후 covers 연결→기존 review로 활성화하며 제안/관측은 PASS가 아니다.

## 실측·증거 구분과 리스크

| 검증 환경 | 증명하는 것 / 한계 |
|---|---|
| synthetic Bun/API/UI·임시 Git/키 | 결정적 권한·상태·예산·CAS·UI 행동. 설치 Keychain/실제 provider/서명 앱 증거가 아님 |
| 설치 Mac | 실제 proxy/키읽기와 keycreate 경계·워크룸 전송·재시작·late native settle를 같은 테스트 ID로 별도 기록. fixture PASS 대체 불가 |
| 실제 Windows PC | 실제 경로 identity·암호화·sidecar/proxy·취소/재시작 확인. 미실행이면 미검증; 요청 없이 Actions VM으로 대체하지 않음 |
| 모바일/원격 | v1 신규 기능 미지원 거절과 기존 동작 회귀를 구별. 모바일을 실행하지 않았다면 실제 기기 통과 주장 금지 |

- 높음 / confidence 높음: read 자체의 부수효과를 놓치면 설계가 깨진다. T05로 tester receipt metadata만 허용하고 기억 index/history probe/key 생성은 0회를 확인한다. 근거: architecture의 read 경로 표, domain의 중복 방지 매핑.
- 높음 / confidence 높음: v4는 구형 host 전체 thread 접근을 차단한다. T20에서 데이터 보존/단조 version/명시 복원 비용을 확인한다. 근거: `src/workroomThreadStore.ts:43-61`.
- 중간 / confidence 높음: 종료/권한 변경 동시성은 실제 native 통합에서만 일부 드러난다. T13의 bounded fake 뒤 설치 Mac/Windows 증거를 별도 요구한다. 근거: `src/promptGuideClient.ts:107`의 실제 완료 전 slot 유지.
- 중간 / confidence 중간: 예산값은 실측 전 제안이다. T11/T12와 대표 두 프로젝트로 검증하며 호출 수 감소를 전체 시간/비용 감소로 단정하지 않는다.
- `briefing_correction`: sidecar는 호환성에 대한 작성자 권고이며 사용자 승인 사실이 아니다. 테스트용 fake receipt와 installed/physical 결과를 섞지 않는다. 추가 source 조사·실행 없이 위 정본 두 문서와 수집된 context로 전략을 작성했다.
