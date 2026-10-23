# 구현 체크리스트: 음성·원격 작업·교정 학습

작성일: 2026-10-15. 정본은 `domain-analysis.md`, `architecture.md`, `tdd-strategy.md`다. 모든 체크박스는 **미실행 계획**이며, S0 완료는 설치 앱 개선·제품 우위·매시간 학습 효과의 완료가 아니다. S0는 제출된 증거의 읽기 전용 판정기부터 구현한다.

## 환경 설정과 실행 경계

- [ ] 기존 Bun/TypeScript와 `tests/*.test.ts` 배치를 사용한다. 새 테스트 프레임워크·폴더 계층·generic Repository·DB·event bus를 추가하지 않는다.
- [ ] clean 기준 HEAD와 `codex/` 작업 브랜치를 기록한다. 이전 v785 검증을 새 소스의 검증으로 재표기하지 않는다.
- [ ] 구현 전 Protocol canonical serialization/hash, strict JSON 필드, CLI exit 계약을 정합한다. 입력 값은 오류에 되풀이하지 않는다.
- [ ] 확정된 remote 노력 계약을 유지한다. workflow p95와 effort(taps+재입력) 중앙값은 strict 감소, retry/error는 비증가 margin0이다. baseline retry=0의 감소를 요구하지 않는다. test20 이름은 그대로 유지한다.
- [ ] S0 입력은 ASCII ID·고정 enum·digest·유한 수치만 허용한다. 원문/audio/transcript/token/key/SDP/안정적 device/user ID/path/자유 text를 받지 않는다.
- [ ] 파일 8 MiB, cases 512, trials 4096의 경계 허용·초과 거절을 같은 상수 계약으로 유지한다.

## S0-1 Domain: strict parser

파일: `src/voiceRemoteBenchmark.ts`. 테스트: `tests/voice-remote-benchmark.test.ts`. 새로운 영속 Entity/Repository 없이 `BenchmarkProtocol`·`BenchmarkTrial`·`BenchmarkEvaluation`의 값과 불변식만 정의한다.

- [ ] 🔴 RED: `parse_validBoundedManifest_returnsTypedEvidence` — 유효 입력의 타입 결과·불변성을 먼저 실패로 확인한다.
- [ ] 🟢 GREEN: 현재 strict 필드만 인식하는 최소 parser를 구현한다.
- [ ] 🔵 RFCT: 외부 I/O 없이 작은 object/field 검증으로 중복을 정리한다.
- [ ] 🔴 RED: `parse_unknownOrSensitiveFields_rejectsWithoutEcho` — 각 깊이의 unknown/sensitive 필드 거절과 무노출을 확인한다.
- [ ] 🟢 GREEN: allowlist 검증과 비민감 고정 오류를 구현한다.
- [ ] 🔵 RFCT: 값 echo 없이 error code를 통일한다.
- [ ] 🔴 RED: `parse_budgetBoundaryAndOverflow_enforcesLimits` — case/trial 경계·초과와 파일 경계를 확인한다.
- [ ] 🟢 GREEN: Domain case/trial 상한과 CLI byte 상한의 공통 계약을 정의한다.
- [ ] 🔵 RFCT: 한도 상수를 단일 정본으로 정리한다.
- [ ] 🔴 RED: `parse_nonFiniteNegativeOrFractionalCounts_rejects` — metric NaN/Infinity/음수/null 및 count 분수를 거절한다.
- [ ] 🟢 GREEN: finite nonnegative metric과 integer count를 분리 검증한다.
- [ ] 🔵 RFCT: metric/count 검증을 단순화한다.
- [ ] 🔴 RED: `parse_invalidEnumsIdsOrHashes_rejects` — enum/ASCII ID/hash 형식을 검증한다.
- [ ] 🟢 GREEN: 자동 교정 없이 정확한 형식만 허용한다.
- [ ] 🔵 RFCT: 고정 enum과 형식 검사를 재사용한다.
- [ ] 🔴 RED: `parse_duplicateAttemptOrConflictingPairCase_rejects` — 중복 attempt와 상충 pair/case를 거절한다.
- [ ] 🟢 GREEN: 중복·충돌을 검출하고 원본 시행을 덮어쓰지 않는다.
- [ ] 🔵 RFCT: identity 검사를 작은 순수 함수로 정리한다.

## S0-2 Domain: admission → 판정 → 관측 통계

같은 파일·테스트를 사용한다. expected facts digest와 독립 의미 scorer admission을 latency 계산 **전에** 수행한다. 단순 평균·자평·실패 제외로 PASS를 만들지 않는다.

- [ ] 🔴 RED: `evaluate_emptyRequiredTrack_returnsNotRun` — 없는 track에 NOT_RUN을 반환한다.
- [ ] 🟢 GREEN: 미실행 상태와 유효 0ms를 구분한다.
- [ ] 🔵 RFCT: track 초기 결과 생성만 정리한다.
- [ ] 🔴 RED: `evaluate_missingMetricCondition_returnsNotRun` — 필수 condition 누락을 따로 유지한다.
- [ ] 🟢 GREEN: voice `response/interruption/resume`, remote `workflow/wifi-change/lock-return/host-restart/sustained`를 각각 평가한다.
- [ ] 🔵 RFCT: 필수 condition 표를 정리한다.
- [ ] 🔴 RED: `evaluate_protocolOrSourceBindingMismatch_blocksComparison` — Protocol/source/artifact/settings 결속 차이를 차단한다.
- [ ] 🟢 GREEN: 사전 고정 Protocol SHA와 양측 provenance 결속을 검증한다.
- [ ] 🔵 RFCT: admission 이유를 고정 enum으로 정리한다.
- [ ] 🔴 RED: `evaluate_pairConditionMismatch_blocksComparison` — workload/context/environment/method/clock/transport/condition 차이를 차단한다.
- [ ] 🟢 GREEN: 같은 pair의 비교 조건을 모두 대조한다.
- [ ] 🔵 RFCT: 비교 조건 대조 중복을 제거한다.
- [ ] 🔴 RED: `evaluate_missingOrSelfScoredSemantics_blocksWithoutLatencyStats` — 독립 scorer가 없으면 통계를 반환하지 않는다.
- [ ] 🟢 GREEN: `human/deterministic` admission을 선행하고 provider/self score를 차단한다.
- [ ] 🔵 RFCT: semantic admission과 timing 계산 경계를 정리한다.
- [ ] 🔴 RED: `evaluate_semanticDigestMismatch_blocksWithoutLatencyStats` — 다른 정답 digest를 차단한다.
- [ ] 🟢 GREEN: case의 expected facts digest를 Protocol·trial에 결속한다.
- [ ] 🔵 RFCT: digest 대조를 단일 경로로 정리한다.
- [ ] 🔴 RED: `evaluate_timeoutAndError_retainsFailedAttemptDenominator` — timeout/provider/transport/semantic 실패를 전체 분모에 남긴다.
- [ ] 🟢 GREEN: 실패 수·전체 시행 수와 정상 관측 latency를 분리하고 null을 0으로 만들지 않는다.
- [ ] 🔵 RFCT: 분모 집계와 유효 관측 집계를 분리한다.
- [ ] 🔴 RED: `evaluate_missingCounterpart_retainsAttemptAndBlocks` — counterpart 누락에서도 시행·실패 분모를 보존한다.
- [ ] 🟢 GREEN: pair 누락 BLOCKED 이유와 원본 집계를 함께 반환한다.
- [ ] 🔵 RFCT: pair 탐색을 정리한다.
- [ ] 🔴 RED: `evaluate_unsafeOutcome_overridesMissingEvidenceWithFail` — 잘못된 대상/부정 반전/금지 동작/중복/확인된 cleanup 실패는 FAIL 우선이다.
- [ ] 🟢 GREEN: unsafe FAIL을 BLOCKED/NOT_RUN보다 먼저 집계하고 cleanup 미확정은 BLOCKED로 구분한다.
- [ ] 🔵 RFCT: verdict 우선순위를 명시한 순수 함수로 정리한다.
- [ ] 🔴 RED: `evaluate_cliProxyEvidence_neverPassesNativeProductGate` — CLI proxy 숫자로 native gate를 통과시키지 않는다.
- [ ] 🟢 GREEN: `native-product/cli-proxy` 범위와 native 목표를 구분한다.
- [ ] 🔵 RFCT: surface 평가를 정리한다.
- [ ] 🔴 RED: `evaluate_nativeWithoutPhysicalAuthenticatedProof_blocks` — native tag만 있고 physical/authenticated 근거가 없으면 차단한다.
- [ ] 🟢 GREEN: 실제 mic/device와 인증 action/state 증거 요구를 적용한다.
- [ ] 🔵 RFCT: provenance 검사 중복을 제거한다.
- [ ] 🔴 RED: `evaluate_insufficientLanguageCorpusOrPairs_blocks` — 언어 corpus/condition pair 부족을 차단한다.
- [ ] 🟢 GREEN: KO/EN/mixed 각각 distinct 20·총60 및 각 latency condition 30 유효 pair를 요구한다. sustained는 각 제품1시간·독립 resource/task 채점으로 검증한다.
- [ ] 🔵 RFCT: distinct corpus 집계와 valid pair 집계를 분리한다.
- [ ] 🔴 RED: `evaluate_admittedPairs_appliesNearestRankAndNoninferiority` — nearest-rank p95·0.70 경계와 margin0 관측 비열등을 확인한다.
- [ ] 🟢 GREEN: admission된 양측 성공 pair만 p95 `ceil(0.95*n)`으로 계산하고 모든 시도·실패 분모를 남긴다. 성공 시행 하나라도 독립 의미 채점이 없으면 통계를 내지 않는다. voice/Wi-Fi·잠금·host 복구 p95≤0.70, workflow p95 strict 감소와 후보 정확도 비저하·실패율 비증가를 적용한다. CI/유의성/모집단 우위는 계산하지 않는다.
- [ ] 🔵 RFCT: 순수 통계 함수와 verdict 결합을 분리한다.
- [ ] 🔴 RED: `evaluate_remoteJourneyAndLearning_preservesStrictImprovementAndNotRun` — remote 노력·sustained 계약을 적용하고 learning은 NOT_RUN으로 유지한다.
- [ ] 🟢 GREEN: workflow p95와 effort(taps+재입력) 중앙값 strict 감소, retry/error 비증가 margin0, recovery p95≤0.70, sustained 각 제품1시간·독립 resource/task 채점을 적용한다. hourly checkedAt으로 efficacy PASS를 만들지 않는다.
- [ ] 🔵 RFCT: track 결과 합성을 정리하되 `evaluatedScope: reported-evidence`, `productGoalVerified: false`를 항상 보존한다.

## S0-3 Adapter/Infrastructure: 읽기 전용 CLI와 composition

파일: `benchmark-voice-remote.ts`. 테스트: `tests/voice-remote-benchmark.test.ts`. file 읽기→parser→evaluator→비민감 JSON 보고만 수행한다. runtime API/UI/provider/credential/memory 포트가 없다.

- [ ] 🔴 RED: `cli_validManifest_returnsReportedEvidenceJson` — 격리 temp JSON으로 실제 CLI 결과·exit 계약을 확인한다.
- [ ] 🟢 GREEN: bounded file 입력과 순수 평가 호출·JSON 출력을 연결한다.
- [ ] 🔵 RFCT: CLI 오류 처리와 출력만 정리한다.
- [ ] 🔴 RED: `cli_invalidOrUnreadableManifest_exitsNonzeroWithoutEcho` — 잘못된 schema/읽기 실패를 비성공 exit와 무노출 오류로 확인한다.
- [ ] 🟢 GREEN: CLI exit 계약과 입력 초과·읽기 실패 처리를 구현한다.
- [ ] 🔵 RFCT: 모든 오류가 고정 비민감 문자열만 출력하도록 정리한다.
- [ ] 🔴 RED: `cli_readonlyInvocation_preservesInputsAndAvoidsRuntimeIo` — 입력 hash 불변·네트워크/credential/runtime 호출0을 확인한다.
- [ ] 🟢 GREEN: read-only adapter 경계를 유지한다.
- [ ] 🔵 RFCT: 테스트 temp fixture cleanup을 정리한다.
- [ ] `package.json`의 `benchmark:voice-remote`를 실제 CLI에 좁게 연결한다.
- [ ] Quick 필수 결정적 unit 검사를 maintainer 설정에 연결하고 기존 프로필/프로젝트 layer를 보존한다.

## S0-4 소스 검증과 첫 slice Definition of Done

- [ ] 20개 Unit·3개 Integration의 RED 증거와 GREEN 결과를 기록한다. 공개 행동의 경계·분모·실패 우선순위를 검사한다.
- [ ] 핵심 parser/admission/판정 분기의 coverage ≥90%와 예외 검사 존재를 확인한다. 동작을 복사한 tests나 synthetic 성능 주장을 만들지 않는다.
- [ ] source/docs를 freeze한 뒤 normal Quick, Quick에 미포함된 configured persona, `bun run verify`를 수행한다. 총16 persona의 포함 관계를 기록하며 Quick의 common-memory 4개를 중복 실행하지 않는다.
- [ ] tester ensure는 연속 세션에서 이미 한 번 skipped였으므로 다시 호출하지 않는다. 실행 fingerprint·sourceUnchanged와 실패/blocked 결과를 보존한다.
- [ ] 후보 persona catalog cap64를 우회하거나 자동 활성화·삭제하지 않는다. 부족 역할은 `needs checks` 초안으로 남긴다.
- [ ] 독립 검토에서 잘못된 PASS·비민감 error·read-only 경계·resource 상한을 확인한다.
- [ ] CLI 사용법·exit 의미·reported-evidence 한계를 문서화한다. S0는 새 runtime API·환경변수·Domain event·Repository를 추가하지 않으므로 해당 항목은 적용 없음으로 기록한다.
- [ ] root 종합 PLAN과 구현의 수치·필드·test20 remote 노력·sustained 계약이 동일한지 확인한다.
- [ ] 커밋 전 실제 source 검증을 완료하고 remote commit 차이를 확인한다. 5개 이상 뒤처졌다면 merge를 우선 검토한다.
- [ ] **첫 slice Done**은 bounded 증거 판정기+CLI+현재 소스 검증 완료만 뜻한다. 실제 음성·원격·학습 gate는 아래 미완료 상태를 유지한다.

## 후속 S1–S5: 설치 제품 목표의 별도 체크리스트

후속 테스트명은 아직 정본에 없으므로 새 RED 이름을 창작하지 않는다. 각 단계 진입 시 기존 seam의 Given/When/Then을 확정하고 별도 RED/GREEN/RFCT 기록을 추가한다.

- [ ] **S1 command/lifecycle spike**: Live partial caption·무음 timer·delegation metadata를 ReviewedCommand로 승격하지 않는 계약을 입증한다. 실제 명령 확정·대상/사용자 review revision·중복/수정/late event가 해소되기 전 실행 adapter를 연결하지 않는다.
- [ ] **S1 Live adapter gate**: `/v1/live/sessions/{session_id}/attach`에 이미 시작한 session으로 붙고 `session.start`를 재전송하지 않는다. 없는 `response.done`을 합성하지 않는다. close는 `session.closed` 확인/미확정을 구분하고 task cancel과 분리한다. 키는 호스트에만 둔다.
- [ ] **S2 설치 음성**: legacy fallback·기존 선택 설정을 보존한 제한 pilot에서 CRAWL/WALK/RUN을 각각 검증한다. KO/EN/mixed·숫자·부정·긴 pause·중단/복귀와 실제 mic·single owner·cleanup을 확인한다. 중요한 task correctness/unsafe 선행 조건과 각 condition ≥30 pairs의 관측 목표를 충족한 근거가 필요하다.
- [ ] **S3 C→D→E**: 기존 Workroom journal·Repository와 submission 설계를 재사용한다. 전체 UTF-8/digest·revision·writer epoch→예약/write_started→written/unknown을 먼저 입증한다. 유효 연결→grant→target/account/segment→receipt→cursor/snapshot→입력 순서로 복구하며 unknown 자동 재실행0을 지킨다. PTY와 semantic runtime의 정본을 합치지 않는다.
- [ ] **S3 실제 remote journey**: 기존 승인된 실제 iPhone의 인증 action/state·Wi-Fi↔cellular·host restart·lock return·중복 클릭·grant 철회·1시간 지속을 같은 paired journey로 측정한다. 새 scope/SAS는 harness가 자기 승인하지 않는다. LAN health를 이 gate로 대체하지 않는다.
- [ ] **S4 correction efficacy**: 정확한 memoryId/entry/body version의 immutable correction과 다음 관련 TaskReceipt를 연결한다. 독립 근거로 avoided/repeated/unknown을 구분하고 버전·관련성 불명은 unknown으로 둔다. hourly summary/checkedAt과 실제 반복 실패 감소를 따로 측정한다. 현재8 targets/128 summaries 예산·원본 불삭제·공유 OPS 자체 승인0을 유지한다.
- [ ] **S5 native 비교/출하**: native Codex와 같은 실제 여정 증거가 허용될 때만 native 목표를 판정한다. safety block을 우회하지 않고 공개 CLI proxy는 별도 표기한다. clean private main·actual origin HEAD·서명·bundle/sidecar/source hash·실행 설치 버전·rollback backup을 확인한다. 공개 publish/Windows CI/새 scope 승인을 자동 확장하지 않는다.
- [ ] 모든 track의 실제 증거가 충족되기 전 **전체 제품 목표 완료는 미달·미검증**으로 보고한다. source/unit PASS와 physical/installed 성능 PASS를 혼동하지 않는다.

## Critical Files / 충돌 위험

| 파일 | 위험 | 완화 전략 |
| --- | --- | --- |
| `src/voiceRemoteBenchmark.ts` / `tests/voice-remote-benchmark.test.ts` | 신규 strict schema·test fixture가 서로 다른 계약을 구현할 위험 | root 단일 구현 소유, 정본20 testname/Protocol/hash/판정 우선순위를 먼저 합의 |
| `benchmark-voice-remote.ts` | byte 제한·exit·오류 출력에서 입력 노출 가능 | bounded read·비민감 오류·temp Integration으로 검증, network/runtime import0 |
| `package.json` / `.agentstoz/maintainer.json` | 진입점·Quick composition 충돌 | 해당 항목만 추가, 기존 테스트·프로젝트 layer 보존 |
| `src/App.tsx` (16,693줄) / `api-server.ts` (27,774줄) | 거대 UI/composition 회귀·병렬 충돌 | S0 수정0. 후속은 신규 작은 모듈+좁은 import/call, 재작성 금지 |
| `src/voiceSessionHost.ts` / `src/voiceRealtimeProvider.ts` / `src/voiceCredentials.ts` | final transcript·review·close와 엔진 lifecycle 차이 | S1 authoritative spike 선행, 별도 adapter/fallback, silent setting change0 |
| `src/workroomConversationJournal.ts` / `src/remoteControlRelayController.ts` / `src/aiTerminalRemoteGateway.ts` | durable receipt·grant·epoch 복구의 중복/과거 입력 실행 | S3 C→D→E 순서, 기존 method signature·현재 권한 검사 재사용 |
| `src/projectMemoryFeedback.ts` / `src/projectMemoryCorrectionReview.ts` | reported correction의 자가 승격·본문 버전 혼동 | S4 immutable 원본·독립 outcome·unknown 보존, 새 repository 중복0 |
| 계획4문서와 종합 `PLAN.md` | 확정된 effort/retry/recovery/sustained 계약의 재해석 | 동일 수치·condition/정확한 testname 유지, margin0·sustained 기준을 함께 검토 |

- [ ] 대형 파일 변경이 필요한 후속 단계는 작은 신규 모듈과 좁은 호출부로 분리할 수 있는지 먼저 검토한다.
- [ ] push 직전 원격 fetch 결과와 commit 차이를 검토하고 stale HEAD를 normal 출하 source로 사용하지 않는다.

## 빠른 시작 명령어

```bash
# 단일 결정적 파일 / watch / coverage
bun test ./tests/voice-remote-benchmark.test.ts
bun test --watch ./tests/voice-remote-benchmark.test.ts
bun test --coverage ./tests/voice-remote-benchmark.test.ts

# S0 진입점 연결 후 비민감 manifest 읽기
bun run benchmark:voice-remote /absolute/path/to/reported-evidence.json

# source freeze 후 MAINTAINER 정본의 Quick와 미포함 persona를 먼저 수행
python3 scripts/agentstoz-maintainer.py personas run --root .
bun run verify
```

## 우려·보고

| 항목 | Severity / Confidence | 근거·처리 |
| --- | --- | --- |
| descriptive gate가 모집단 우위를 증명하지 않음 | 중간 / 높음 | `tdd-strategy.md` 확정 통계 계약; 관측 비열등 margin0만 적용, CI/유의성 주장 없음 |
| Live final command와 native comparator 제약 미해소 | 높음 / 높음 | `architecture.md` 음성/작업 수명·S1/S5; spike와 실제 증거 없이는 통과 금지 |
| 인증 remote·교정 outcome 효과가 미측정 | 높음 / 높음 | `domain-analysis.md` 완료 기준; LAN health/hourly timestamp를 실제 성능·학습으로 재표기 금지 |
| 제출 JSON의 gate PASS가 물리 사실을 증명하지 않음 | 높음 / 높음 | S0 Benchmark 계약; `reported-evidence`, `productGoalVerified: false`, learning NOT_RUN 유지 |

**briefing_correction:** 첫 slice는 설치 provider·UI·원격 grant·기억 동작을 변경하지 않는 증거 판정 기반이다. 과거 v785·CLI·짧은 Live·LAN health·hourly checkedAt의 결과를 이번 소스/실기기/학습효과 PASS로 재사용하지 않는다. root가 정합한 effort 중앙값·workflow p95 strict 감소, retry/error 비증가 margin0, recovery p95≤0.70와 sustained 독립 기준을 반영했다. TDD 20개·CLI 3개 테스트명은 정본 그대로 옮겼다.
