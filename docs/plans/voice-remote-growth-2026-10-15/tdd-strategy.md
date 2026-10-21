# TDD 전략: 음성·원격 작업·교정 학습

작성일: 2026-10-15. 계획 문서이며 구현·설치·제품 성능 통과를 뜻하지 않는다. 도메인 용어는 `domain-analysis.md`의 정본을 따른다. 첫 구현 S0는 제출된 JSON 증거를 검사하는 읽기 전용 판정기다. 실제 provider·마이크·기기를 실행하지 않는다.

## 개요와 최초 구현 범위

S0의 파일은 `src/voiceRemoteBenchmark.ts`, `benchmark-voice-remote.ts`, `tests/voice-remote-benchmark.test.ts`, `package.json`의 `benchmark:voice-remote`와 Quick의 필수 결정적 검사 연결이다. Domain에는 파일·네트워크·clock·credential·UI 의존성이 없다. 기존 provider/설정/API/UI/runtime을 바꾸지 않는다. 순수 parser/evaluator의 관찰 가능한 행동을 먼저 RED로 만들고 최소 구현으로 GREEN, 중복 fixture만 REFACTOR한다.

| 논리 레이어 | S0 / 후속 검사 책임 |
| --- | --- |
| Domain | `BenchmarkProtocol`·`BenchmarkTrial`·`BenchmarkEvaluation`의 strict 입력, 증거 admission, 판정 우선순위·분모·통계 |
| Application | S0 순수 평가 호출; 후속에는 `VoiceResolvedTarget`의 현재 권한·대상·review·실제 작업 수명 |
| Adapters | S0 JSON CLI의 입력/출력·exit 계약; 후속에는 Live wire와 relay의 epoch·grant·receipt mapping |
| Infrastructure | S0 bounded 파일 읽기·오류 출력; 후속에는 키 격리·실제 미디어·journal/cleanup |

새 Aggregate DB·generic Repository·event bus는 추가하지 않는다. `WorkroomConversationJournal`과 `readProjectMemoryFeedback`/`appendProjectMemoryFeedback`의 기존 서명을 재사용한다. S0에는 이 저장소도 호출할 필요가 없다.

## 사전 고정한 검사 계약

- 입력 상한은 파일 **8 MiB**, case **512**, trial **4096**이다. 경계값 허용, 초과·unknown key·중복 attempt·같은 pair의 상충 case·부적합 enum/ASCII ID/hash를 거절한다. 수치는 유한·비음수이며 count는 정수다. 원문·audio·transcript·token/key·SDP·안정적 device/user ID·path·자유 text 필드는 없다. 오류는 입력 값을 되풀이하지 않는다.
- `BenchmarkProtocol`이 metric group/condition, case ID, input hash, expected facts digest, 제품별 version/artifact/settings hash와 현재 source 결속을 미리 고정한다. 모든 trial은 해당 Protocol SHA를 참조한다. 같은 pair의 workload/context/environment/method/clock/transport 및 metric condition이 일치해야 한다. 비교 종류는 `native-product | cli-proxy`뿐이다. 이 조건을 변경한 자료는 같은 비교에 편입하지 않는다.
- 독립 `human | deterministic` scorer와 expected facts digest 결속이 없는 의미 결과, provider/self score, 잘못된 digest는 **BLOCKED이고 latency 통계를 반환하지 않는다**. scorer는 실제 실행·상태의 근거를 평가하며 spoken claim은 TaskReceipt가 아니다. 의미 증거의 admission을 통계 계산보다 먼저 수행한다.
- timeout/provider/transport error와 실패한 의미 결과는 전체 시도 분모에 남긴다. 실패 시행에서 latency를 0으로 만들지 않는다. 정상 의미 결과의 관측 가능한 latency만 요약하더라도 전체 시도·실패·유효 pair 수를 함께 반환한다. counterpart가 없으면 시행을 보존하고 **BLOCKED**다.
- 잘못된 대상·부정 반전·금지 동작·중복 실행·확인된 cleanup 실패는 다른 자료가 부족해도 **FAIL 우선**이다. cleanup 미확정은 BLOCKED다. 필수 voice/remote metric group이 미실행이면 **NOT_RUN**이다. S0의 learning은 항상 **NOT_RUN**이다. 입력 schema 오류는 제품 판정과 구분한다.
- 전체 음성 corpus는 KO/EN/mixed 각각 distinct case ≥20, 총 ≥60이며 각 latency metric condition에 유효 pair ≥30이 필요하다. voice 필수 조건은 `response`, `interruption`, `resume`; remote는 `workflow`, `wifi-change`, `lock-return`, `host-restart`, `sustained`이며 각 결과를 별도로 보고한다. 표본 부족은 BLOCKED다. native 제품 비교는 실제 native Codex, physical mic/device, 인증된 action/state 근거를 요구한다. CLI proxy의 우수한 숫자는 이 gate를 통과시키지 않는다. `evaluatedScope: reported-evidence`와 **`productGoalVerified: false`**를 명시하며 synthetic manifest의 gate PASS도 물리 사실의 증명이 아니다. S0 learning NOT_RUN 상태에서 전체 제품 목표를 완료 처리하지 않는다.
- p95는 오름차순 관측 배열의 **nearest rank `ceil(0.95 × n)`번째 값**이다. 통계는 의미 admission을 통과한 양쪽 성공 pair만 계산하며 모든 시도·실패 분모도 반환한다. 성공 시행 하나라도 독립 의미 채점이 없으면 통계를 내지 않는다. voice와 Wi-Fi/잠금/host 복구는 후보 p95 ≤ 기준선 p95 ×0.70, workflow p95는 후보가 더 낮아야 한다. 같은 여정의 effort(taps+재입력) 중앙값은 strict 감소, retry/error는 실제 관측 비증가 margin **0**이며 unsafe outcome은 0이다. retry 기준선이 0일 때 감소를 강요하지 않는다. sustained는 p95가 아니라 양 제품 각각 1시간과 독립 resource/task 채점 기준이다. confidence interval·통계적 유의성·모집단 우위는 계산하거나 주장하지 않는다. 신뢰구간 추론이 필요하면 S5 시행 전에 별도 사전 분석 계획을 고정한다.

위 조건은 계획 가정이며 실제 제품 달성치가 아니다. 구현의 세부 JSON 필드명은 root가 이 계약과 동일하게 정합한 후 fixture를 작성한다. Domain 정본에 없는 필드를 테스트 때문에 runtime에 새로 만들지 않는다.

## 테스트 피라미드와 Mock/Fake 전략

S0는 아래 **20개 핵심 Unit 테스트**와 **3개 CLI/파일 Integration 테스트**를 설계한다. parameterized 경계/조건 케이스는 각 항목의 행동을 유지한다. S0 E2E는 0개다. 후속 실제 제품 검사는 작은 동일 조건 시나리오부터 확대하고 단위 PASS와 별도 보고한다.

| 의존성 | 전략 | 이유 |
| --- | --- | --- |
| parser/evaluator·hash 비교·통계 | 실제 순수 함수, mock 없음 | 잘못된 PASS 방지 행동 자체를 검증 |
| manifest | 비민감 고정 fixture builder, baseline/candidate 모두 명시 | 매 테스트에 필요한 한 조건만 바꿈; 실제 측정으로 위장하지 않음 |
| 파일/CLI | 격리 temp fixture 또는 경계 I/O stub; stdout/exit 관측 | 실제 프로젝트 증거·설정 파일을 쓰지 않음 |
| 후속 provider·relay·task·clock | 기존 port에 scripted I/O fake/가짜 clock | 권한 철회·await·late event·timeout을 결정적으로 재현 |
| 후속 journal/feedback | 기존 구현의 격리 test storage 우선 | production DB·원본 기억·공유 OPS 쓰기 없음 |

## S0 Given/When/Then — TDD 실행 순서

| # / 정확한 테스트명 | Given | When | Then |
| --- | --- | --- | --- |
| 1 `parse_validBoundedManifest_returnsTypedEvidence` | 사전 Protocol과 양측 trial이 있는 작은 strict fixture | parse | 타입 있는 증거 반환; 입력 데이터 변경·I/O 없음 |
| 2 `parse_unknownOrSensitiveFields_rejectsWithoutEcho` | 각 object depth에 unknown key 또는 transcript/token/SDP/path 삽입 | parse | 거절; 오류/stdout에 삽입 값 없음 |
| 3 `parse_budgetBoundaryAndOverflow_enforcesLimits` | 512/513 cases, 4096/4097 trials, 파일 8 MiB/초과 | parse/CLI read | 경계 허용·초과 거절; 초과 파일을 일반 입력처럼 평가하지 않음 |
| 4 `parse_nonFiniteNegativeOrFractionalCounts_rejects` | NaN/Infinity/음수 metric, 분수·음수 count | parse | 거절; JSON의 null 변환도 유효 metric으로 통과하지 않음 |
| 5 `parse_invalidEnumsIdsOrHashes_rejects` | 허용 밖 비교/scorer/상태, 공백·비ASCII ID, 잘못된 digest | parse | 거절; 형식이 같은 문자열로 자동 교정하지 않음 |
| 6 `parse_duplicateAttemptOrConflictingPairCase_rejects` | 중복 attempt ID, 동일 pair ID의 다른 case/metric 참조 | parse | 거절; 덮어쓰기·dedupe로 결과 손실 없음 |
| 7 `evaluate_emptyRequiredTrack_returnsNotRun` | 필요한 voice 또는 remote 시행이 없음 | evaluate | 그 track NOT_RUN; 0ms·0실패 PASS 생성 없음 |
| 8 `evaluate_missingMetricCondition_returnsNotRun` | 한 required metric condition만 시행하지 않음 | evaluate | 해당 group NOT_RUN, 다른 group 성공으로 전체 완료 선언 없음 |
| 9 `evaluate_protocolOrSourceBindingMismatch_blocksComparison` | 다른 Protocol SHA 또는 protocol에서 고정한 source/product artifact/settings 결속 불일치 | evaluate | BLOCKED; 과거 버전의 숫자를 현재 설치 성능으로 표기하지 않음 |
| 10 `evaluate_pairConditionMismatch_blocksComparison` | workload/context/environment/method/clock/transport/condition 중 하나만 다름 | evaluate | 각 parameter에서 BLOCKED; 서로 다른 관측 clock의 차를 계산하지 않음 |
| 11 `evaluate_missingOrSelfScoredSemantics_blocksWithoutLatencyStats` | 빠른 숫자는 있으나 scorer 누락 또는 provider/self score | evaluate | BLOCKED, latency stats 없음; 빠른 자평을 제품 PASS로 바꾸지 않음 |
| 12 `evaluate_semanticDigestMismatch_blocksWithoutLatencyStats` | 독립 scorer가 있으나 expected facts digest가 다른 case에 결속 | evaluate | BLOCKED, latency stats 없음; 다른 정답의 성공 재사용 금지 |
| 13 `evaluate_timeoutAndError_retainsFailedAttemptDenominator` | 정상·timeout·provider/transport error가 섞인 계획된 양측 시행 | evaluate | 모든 시행과 실패율 분모 보존; null/누락 latency는 0 아님; 관측 비열등 위반이면 FAIL |
| 14 `evaluate_missingCounterpart_retainsAttemptAndBlocks` | 한 pair의 candidate 또는 comparator 없음 | evaluate | BLOCKED와 누락 이유; 이미 있는 시행·실패는 분모에 남음 |
| 15 `evaluate_unsafeOutcome_overridesMissingEvidenceWithFail` | 잘못된 대상/부정 반전/금지 동작/중복/확인된 cleanup 실패 하나와 표본·semantic 증거 부족 | evaluate | 각각 FAIL이 BLOCKED/NOT_RUN에 우선; unsafe event 수·이유 보존. cleanup 미확정만 있으면 BLOCKED |
| 16 `evaluate_cliProxyEvidence_neverPassesNativeProductGate` | 충분히 빠르고 정확한 실제 공개 CLI proxy evidence | native 제품 목표 evaluate | BLOCKED; cli-proxy의 개별 평가 범위와 native 목표를 분리 |
| 17 `evaluate_nativeWithoutPhysicalAuthenticatedProof_blocks` | native tag이나 mic/device·인증 action/state 근거 중 하나 없음 | evaluate | BLOCKED; synthetic 음원/LAN health를 인증 작업으로 승격하지 않음 |
| 18 `evaluate_insufficientLanguageCorpusOrPairs_blocks` | 19개 KO/EN/mixed, 총59개, 또는 한 condition29 pairs | evaluate | 각각 BLOCKED; 한 언어·다른 condition 표본으로 부족분 대체 없음 |
| 19 `evaluate_admittedPairs_appliesNearestRankAndNoninferiority` | 모든 admission 충족; 정렬 전30개 latency, 0.70 경계 및 경계 초과, 양측 정확도·실패율 | evaluate | nearest-rank p95; ≤0.70만 latency 충족; 후보 정확도 낮음/실패율 높음이면 margin0 위반 FAIL; 단순 평균 PASS 금지 |
| 20 `evaluate_remoteJourneyAndLearning_preservesStrictImprovementAndNotRun` | 같은 paired remote journey의 latency/effort/retry·1시간 resource/task 채점과 hourly checkedAt만 있음 | evaluate | workflow p95·effort 중앙값 strict 감소, 복구 p95≤0.70, retry/error 비증가를 확인. 0 retry baseline에서 candidate0도 허용. sustained는 양쪽1시간/독립 채점, learning NOT_RUN; checkedAt은 효과 증거 아님 |

CLI Integration: `cli_validManifest_returnsReportedEvidenceJson`(고정 temp JSON→실제 진입점→정본 verdict/분모 JSON), `cli_invalidOrUnreadableManifest_exitsNonzeroWithoutEcho`(unknown schema/읽기 실패→비성공 exit·비민감 오류), `cli_readonlyInvocation_preservesInputsAndAvoidsRuntimeIo`(입력 hash·격리 I/O spy→읽기→원본 불변·네트워크/credential/runtime 호출 0). exit 값 자체는 root가 CLI 계약으로 고정하고 assertion에 그대로 쓴다. unit 성공 exit와 제품 verdict PASS를 혼동하지 않는다.

## 후속 단계: 기존 seam의 행동 검사

| 단계·레이어 / 기존 seam | Given → When → Then |
| --- | --- |
| S1 Voice Domain/Application: `VoiceSessionHost`, `VoiceReview` | Live partial caption/무음 timer/metadata offset → 후보 갱신 → `UtteranceCandidate`만 갱신, ReviewedCommand·자동 task dispatch 0. 정당한 확정 경계가 미해소이면 실행 gate는 BLOCKED |
| S1 Adapter/Infrastructure: 별도 Live provider port | 이미 시작한 public session → `/live/sessions/{session_id}/attach` sideband → session.start 재전송 0; scripted session.closed/timeout → 정상 종료 요청 → confirmed/unconfirmed 구분·resources 해제 |
| S1/S2 Application: 현재 binding·grant·epoch | await 중 대상/권한 교체 또는 late caption/tool → 기존 검토/send → 이전 대상 실행 0; 실제 receipt 없는 spoken claim은 완료 아님; voice close가 task cancel을 합성하지 않음 |
| S2 설치 Voice: 기존 media/credentials | 한 mic owner, 긴 pause·부정·숫자·혼용·중단 복귀 → 같은 protocol의 실기기 시행 → 오작동 0·cleanup 확인·실패 보존. 설정·키 자동 변경/추가 AI 호출 0 |
| S3 C Application/Infrastructure: existing submission DESIGN, terminal/journal | full UTF-8/digest·revision·writer epoch 또는 부분 write/crash → 예약·write/result 조회 → written/unknown 구분, 불확실한 제출의 자동 재실행 0; PTY write를 TaskReceipt 완료로 표시하지 않음 |
| S3 D/E Adapter: relay/gateway/conversation journal | 재접속·host/token 변경·grant 철회·반복 requestId → 현재 grant→대상/account/segment→receipt→cursor→입력 → 옛 token 입력 0·payload 충돌 거절·unknown 보존; history/새 scope 자기 승인 0 |
| S3 Infrastructure/실제 여정 | 인증된 허용 기기·현재 scope·paired 30journeys → Wi-Fi↔cellular·host 재시작·중복 클릭·1시간 지속 → 실제 상태와 receipt 확인, 분모·tap/retry·복구 시간 기록; LAN health PASS로 대체하지 않음 |
| S4 Memory Domain/Application: feedback/recall/review | 정확한 correction version과 이후 관련 task → recall/독립 outcome 관측 → claim withdraw+reported 원인 전달, `CorrectionOutcome` avoided/repeated/unknown; body 버전/관련성 불명은 unknown |
| S4 Infrastructure: coordinator·기존 ledger | clock1h·다수 target·overlap·손상·shared OPS → 기존 bounded tick → 최대8/summary128·동시 점검 제한·원본 불삭제; backlog/overdue와 timestamp/효과 구분, positive self promotion·공유 OPS 자체 승인 0 |

후속 평가 입력은 합성 CRAWL → 동의된 recorded WALK → 중단/수정/실제 도구의 multi-turn RUN으로 확대한다. 낮은 단계 성공으로 높은 단계 gate를 통과시키지 않는다. 독립 scorer는 기존 deterministic assertion 또는 동의된 human fact review이며 별도 AI를 추가 호출하지 않는다.

## 실행·검증·우려

실행 순서는 S0 입력 불변식 RED/GREEN → admission/판정 RED/GREEN → CLI 통합 → 필수 Quick 연결 → representative 회귀 → source freeze 후 normal Quick와 미포함 persona, 변경에 필요한 전체 verify다. tester ensure는 이번 연속 세션에서 이미 한 번 호출되어 repository runner가 더 최신이라는 skipped 결과를 받았으므로 반복하지 않는다. source가 달라지면 기존 PASS를 재표기하지 않는다. CI billing으로 시작하지 않은 job은 통과가 아니다. 서명·clean private main/실제 remote HEAD·installed artifact/sidecar/source/hash 검증은 후속 출하 gate이며 S0 Unit 검사의 대체가 아니다.

| 우려 | Severity / Confidence | 근거·처리 |
| --- | --- | --- |
| 의미 정답·native provenance를 보고한 JSON은 물리 실행의 독립 증명이 아님 | 높음 / 높음 | Domain Benchmark 계약; evaluatedScope 명시·실제 native comparator/실기기 gate 별도 |
| Live final 명령 경계가 아직 없음 | 높음 / 높음 | architecture 음성·작업 수명, 현재 `voiceSessionHost.ts` final transcript 의존; timer·자평으로 대체 금지 |
| remote 인증/cellular/1시간·CorrectionOutcome 실측 공백 | 높음 / 높음 | 현재 RESULT와 Domain 완료 기준; 학습 S0 NOT_RUN, 후속 독립 자료 확보 전 완료 선언 금지 |
| Protocol serialization/hash canonicalization의 세부 wire 필드 미확정 | 중간 / 높음 | root 구현 소유; testcase의 조건 digest와 strict schema를 구현 전 동일하게 정합해야 함 |
| 30pair·margin0은 통계적 우위의 근거가 부족함 | 중간 / 높음 | descriptive 운영 gate만 사용, 신뢰구간/유의성 주장 없음 |

**briefing_correction:** 우려가 없는 것으로 처리하지 않는다. 이전 v785 영어3233ms와 Codex CLI1318ms는 공정한 native paired p95가 아니며, 짧은 Live feasibility와 hourly checkedAt은 제품 목표 완료를 증명하지 않는다. root 고정 계약에 따라 학습효과 S0 NOT_RUN과 unsafe FAIL 우선, 의미 증거 없는 latency 통계 금지를 명시했다. 정본의 역할/Repository/용어를 테스트 목적으로 새로 창작하지 않았다.
