# S0 측정 증거 계약

첫 구현은 보고된 자료의 완전성과 비교 조건을 검사한다. 실제 음성·원격 실행을 시작하거나
물리 사실을 인증하는 도구가 아니다. 계획의 세 트랙과 S1–S5 완료 기준은 [PLAN](PLAN.md)을 따른다.

## 실행과 판정

```bash
bun run benchmark:voice-remote /absolute/path/to/reported-evidence.json
```

파일 읽기만 수행하고 JSON을 stdout에 출력한다. 입력 파일·설정·기억을 쓰지 않으며
provider/CLI/호스트 API·Keychain을 호출하지 않는다. 입력 값을 오류에 되풀이하지 않는다.
현재 원시 pilot JSON은 이 형식이 아니므로 자동으로 비교 통과 자료로 변환하지 않는다.

| Exit | 뜻 |
| --- | --- |
| 0 | 제출된 voice/remote native 비교 기준 PASS |
| 1 | 관측 안전 실패 또는 입증된 비교 기준 미달 FAIL |
| 2 | 누락·조건 차이·불충분 근거·CLI proxy의 native 목표 BLOCKED |
| 3 | 비교 시행 자체가 없음 NOT_RUN |
| 64 | 사용법 오류 |
| 65 | 잘못된 schema·UTF-8·한도·읽기 오류 |

모든 출력은 `evaluatedScope: reported-evidence`, `productGoalVerified: false`다.
learning은 항상 NOT_RUN이다. Exit 0도 세 트랙 목표 완료나 물리 측정 성공의 인증이 아니다.
JSON의 surface/physical/authenticated 태그와 독립 채점 주장은 수집자가 원본 증거로 확인해야 한다.
서명된 수집기·실측 runner는 후속 단계이며 S0는 metadata를 검증한다.

## 오프라인 평가 도구 (2026-10-15)

한국어 정확도 실험(제품 안의 조건 비교)과 이 비교(제품 대 제품)는 **같은 말뭉치·채점기·합성기**를 쓴다 —
20개 이상 distinct 계약이 두 벌로 갈라지지 않게 하기 위해서다. 모두 순수 함수이고 네트워크·provider를 부르지 않는다.

| 모듈 | 역할 |
| --- | --- |
| `src/voiceEvalCorpus.ts` | KO 22·EN 22·mixed 21 문항(숫자·부정·긴 멈춤·끼어들기·프로젝트/AI 이름), 버전·해시된 expected facts, 원문 없는 공개 case 목록 |
| `src/voiceEvalScoring.ts` | 숫자 정규화(아라비아·한자어·고유어·영어)와 「마지막 응답의 마지막 숫자」 채점, relay 전달문 채점 |
| `src/voiceEvalSynth.ts` · `scripts/voice-eval-render.ts` | `say` + ffmpeg 렌더 계획(순수)과 수동 실행기(0600 클립·원문 없는 manifest) |
| `src/voiceBenchmarkProtocol.ts` · `scripts/voice-benchmark-protocol.ts` | spec → 봉인된 protocol, 쌍 순서·시간창을 지키는 다음 단계 |
| `src/voiceBenchmarkTiming.ts` · `scripts/analyze-voice-benchmark-capture.ts` | 동기 chirp 기준 응답·끼어들기·재개 지연(없으면 null, 겹치면 overlap) |
| `src/voiceBenchmarkAssembler.ts` | 캡처 기록 + 채점표 → trial(가상 입력은 실제 마이크가 아님, 증명 태그는 기본 false) |
| `src/voiceEvalExperiment.ts` · `src/voiceEvalLive.ts` · `scripts/voice-eval-live.ts` | 사전 등록 실험 계획·분석과 `--live` + `AGENTSTOZ_VOICE_EVAL_LIVE=1` 이중 게이트 runner(유료, 미실행) |
| `src/remoteJourneyReducer.ts` | 원격 여정 이벤트 로그(tap·reentry·draft·submit·receipt·answer·disconnect·reconnect·perturb·gate) → latency·effort·retry·violations·taskStateObserved, 그리고 assembler의 remote `CaptureRecord` |
| `mobile/ios/scripts/remote-journey-iphone.ts` | 후보 쪽 실기 여정(F11): AgentsToZ 개발 앱만, `--device` + `AGENTSTOZ_REMOTE_JOURNEY_DEVICE=attended` 이중 게이트, 사람이 하는 Wi‑Fi·잠금·Mac 재시작(미실행 골격) |

원격 여정의 판정 규칙(정본은 리듀서 머리말): latency는 workflow면 첫 이벤트 → 기한 안의 첫 nonce 답, 복구 metric이면
**사람이 확인한 교란 끝** → **그 끝 뒤에 보낸 요청의** 첫 답이고, 하나라도 관측되지 않으면 null이다(sustained-1h는 늘 null). 끝
이전에 보냈거나 답이 보인 요청은 교란 중에 답했을 수 있어 복구를 말해 주지 않으므로 null이다(`SUBMIT_BEFORE_RECOVERY`·
`ANSWER_BEFORE_RECOVERY`). 그래서 실기 스크립트는 초안을 써 둔 채 사람이 교란을 끝낸 뒤에 보낸다. effort = tap + reentry,
retry = 첫 submit 뒤의 submit. duplicate-action은 **두 번째 실행의 증거**(written 영수증 둘·nonce 답 둘)가 있어야 하고 두 번째
탭만으로는 아니다 — 같은 영수증으로 돌아온 재전송은 retry다. draft-lost는 전달되지 않은 초안이 의도 없이 사라지고 다시
보이지 않을 때다(id 없는 submit — 옛 입력 경로 — 이 보내면서 비운 것은 아니다). grant-bypass는 철회 중에 보낸 입력이 written·답이
됐을 때다. 철회 전에 보내 철회 뒤 written으로 읽힌 입력은 bypass로 단정하지 않고, id 없는 submit의 답은 그 앞 요청이 아직 답을 못
받았으면 귀속하지 않는다(`BYPASS_UNATTRIBUTABLE`). taskStateObserved는 written 영수증과 답이 **둘 다** 관측됐을 때만 참이고, authenticated는 여전히
사람의 확인이다. 실기 스크립트는 Mac 승인(6자리) 화면에서 멈추며 SAS·권한·범위를 승인하지 않고, `--project`와 정확히 같은 세션
하나에만 입력한다(다른 세션이 열려 있으면 그 세션을 먼저 고르고, 없거나 둘이면 아무것도 입력하지 않고 멈춘다).

## 입력 모양

정본 타입은 `src/voiceRemoteBenchmark.ts`의 BenchmarkManifest다. object마다 정확한 필드만 허용한다.
ID는 1–80자 ASCII, hash는 소문자 SHA-256 64자리, 버전은 최대64자다.
원문·오디오·전사·키·SDP·경로·기기/사용자/provider 고유 ID·자유 설명 필드는 없다.
임의 객체의 accessor/toJSON, 추가 배열 속성, unknown key도 거절한다.

| 객체 | 필드 |
| --- | --- |
| Manifest | schemaVersion=1, protocol, trials |
| Protocol | id, sealedAt(Unix ms), comparison(native-product 또는 cli-proxy), products, cases, groups |
| products.candidate/reference | version, artifactHash, sourceHash, settingsHash |
| cases[] | id, domain(voice/remote), language(ko/en/mixed/none), inputHash, expectedFactsHash |
| groups[] | id, domain, metric, condition, workloadHash, contextHash, environmentHash, methodHash, clockHash, transport, pairs |
| groups[].pairs[] | id, caseId |
| trials[] | attemptId, pairId, groupId, caseId, side, protocolHash, 제품 결속 필드, inputHash, 조건 필드, startedAt, outcome, latencyMs, elapsedMs, effortCount, retryCount, manualCommit, cleanup, semantics, violations, proof |
| semantics | verdict(correct/incorrect/unscored), source(human/deterministic/self/null), expectedFactsHash, evidenceHash |
| proof | surface, physicalDevice, physicalMicrophone, authenticated, taskStateObserved, captureHash |

sourceHash는 해당 설치 산출물에 결속한 **원본 소스의 지문**이다. CLI 코드의 현재 지문과
설치본의 지문을 혼동하지 않는다. source/artifact/settings 값은 각 제품의 사전 protocol 값과 대조한다.
workload/context는 공통 과제·시작 상태·문맥, environment는 물리 장치/마이크/네트워크/부하,
method/clock는 타이밍 시작·끝·관측기 정의다. 원본 상세 정의와 hash 생성 기록은
수집 단계의 별도 증거에 보관한다. hash의 일치만으로 의미적 동등성을 새로 증명하지 않는다.

`fingerprintBenchmarkProtocol`은 object key를 정렬한 JSON을 SHA-256으로 계산한다.
배열 순서는 유지한다. trial.protocolHash가 이를 참조한다. 각 group의 pairs는 **시험 전에**
고정할 예정표다. 같은 pair에 candidate/reference 각 한 시도만 허용하며 재시도는 새 예정 pair다.
첫 pair는 candidate 먼저, 다음은 reference 먼저로 교대한다. 앞 시험 종료 뒤 상대를 시작한다.
두 시작의 간격은 최대10분(sustained는2시간)이다. sealedAt 이전 시행은 차단한다.
이 시각·hash의 진실성 및 실제 사전 등록은 수집자 검증 사항이다.

두 행을 모두 삭제해도 예정 pair가 남으므로 누락으로 표시한다. 시행을 통째로 삭제하거나
새 protocol로 바꿔 과거 실패를 숨기는 것은 새 시험이며 원래 예정표/원본 결과를 보존해야 한다.
ID 덮어쓰기·서로 다른 case의 같은 pair·알려지지 않은 pair는 입력 오류다.
voice case의 입력 hash도 서로 달라야 하므로 한 음원을 60개 ID로 복제할 수 없다.

## Admission과 관측 목표

필수 metric은 voice response/interrupt/resume,
remote workflow/wifi-change/lock-return/host-restart/sustained-1h다.
선언했으나 미실행한 group과 빠진 metric은 NOT_RUN이며 전체로 올리면 완료를 차단한다.

- voice corpus는 보고된 양측 시행의 distinct 입력 KO/EN/mixed 각각20개 이상이다.
- latency group마다 정상 의미 결과를 가진 양측 pair30개 이상이 필요하다.
- latency는 반드시 정해진 관측 시작/끝의 비음수 ms다. 평균 대신 nearest-rank p95를 쓴다.
  voice/remote 복구 p95는 기준선0.70배 이하, workflow p95와 effort 중앙값은 각각 strict 감소다.
  기준선 p95가0이면 상대 감소를 판정하지 않고 BLOCKED다.
- error/timeout/incorrect/unsafe는 전체 시도·실패 분모에 남는다.
  전체 실패율, 응답한 결과의 의미 오류율, 전체 시행의 provider/transport 오류율과 retry를
  각각 비증가 margin0으로 검사한다. 오답과 무응답의 합계가 같아도 서로 상쇄하지 못한다.
  semanticResponses/semanticErrors/transportErrors도 분리 보고한다. 지연은 양쪽 정상 성공 pair에서만 요약하고
  planned/observed/missing/failed/admitted 수를 함께 보고한다.
- 성공 결과에 독립 human/deterministic 채점과 같은 expected facts/evidence digest가 없으면
  BLOCKED이고 지연 통계가 없다. 오류로 답 자체가 없는 시행은 실패로 집계한다.
  연결 오류 이전에 독립적으로 관측한 의미 결과는 별도로 채점하고 보존한다.
- wrong-target/negation-reversed/forbidden-action/duplicate-action/draft-lost/grant-bypass 또는
  후보의 확인된 cleanup 실패는 자료 부족보다 FAIL이 먼저다. cleanup unknown은 BLOCKED다.
- sustained는 양측1시간 이상과 독립 resource/task 결과 채점이며 지연 percentile이 아니다.
- native voice는 실제 마이크/기기, native remote는 실제 휴대폰과 현재 인증·작업 상태 근거가
  필요하다. physicalDevice는 remote에서 휴대폰을 뜻한다. CLI proxy는 별도 범위이며 native 목표는 BLOCKED다.

descriptive 관측 기준이다. confidence interval·모집단 우위·학습 효과를 계산하지 않는다.
S1 이후 명령·도구·상태·발화의 실제 연결과 수집 provenance를 검증해야 한다.

## 예산과 검사

파일8MiB /cases512 /trials4096 /groups32 /planned pairs2048, count는0–10000 정수,
elapsed/latency는최대24시간, timestamp는비음수 safe integer다. 한계값은 허용한다.
symlink/비정규 파일/읽는 동안 바뀐 파일/잘못된 UTF-8/초과 입력을 거절한다.
원본 receipt·음성·기억을 예산 때문에 삭제하지 않는다.

테스트 정본 Unit20+CLI3은 [TDD](tdd-strategy.md)와 같은 이름이다.
`voice-remote-benchmark`를 Quick에 추가했다. 기존 음성·원격·기억 검사는 유지한다.
실행 증거와 현재 소스의 전체 검증은 로컬
`.agentstoz/maintainer/voice-remote-growth-20261015/RESULT.md`에 기록한다.
