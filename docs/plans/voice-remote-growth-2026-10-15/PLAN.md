---
cs_artifact:
  type: PLAN.md
  producer: CS-plan
  produced_at: 2026-10-14T23:14:22Z
  status: ready
  gate:
    passed: true
    criterion: "4개 산출물의 실제 코드 기반 품질·용어·테스트명 정합성 게이트 통과"
    blocking_items: []
execution_status: runtime_in_progress
product_goal_status: unmet
---

# AgentsToZ 음성·원격제어·교정 학습 개선 계획

2026-10-15 · 기준 소스 `c85d644fcf5fcf8bbe4225c63472df9ce454f74c` · 작업 브랜치 `codex/voice-remote-growth-plan`.

protocol: LOOP-PROTOCOL [a-f] loaded (round budget 1)
recall: E3/C0/N0
hitl: auto — arch-choice: B(default 권장안) 채택
contracts: 4 issued / 4 accepted
coverage: 4/4 specialists (100%); planning gate PASS

이 계획은 **첫 구현에 착수 가능한 상태**다. 설치 v785의 Codex 대비 음성·원격제어 우위와 실제 반복 실패 감소는 여전히 미달·미검증이다. 계획 게이트의 PASS는 제품 성능 PASS가 아니다. 사용자 지시인 “계획을 설계하고 진행” 및 세부 처리를 위임한 기존 답변에 따라 추가 아키텍처 승인 질문 없이 실행한다.

## 빠른 시작

1. S0의 strict schema와 Protocol hash·CLI exit 계약을 구현 직전에 고정한다. 아래 숫자·상태·필수 조건을 낮추지 않는다.
2. [TDD 정본](tdd-strategy.md)의 정확한 Unit 20개 및 CLI 3개 행동을 RED로 확인한다.
3. 순수 parser → admission/evaluator → 읽기 전용 CLI → package/Quick 연결 순으로 최소 구현한다.
4. 소스·문서를 freeze한 뒤 현재 프로젝트의 Quick·미포함 persona·verify를 실행한다. 실제 제품 비교는 후속 단계의 별도 영수증으로 남긴다.

| 문서 | 담당 범위 |
| --- | --- |
| [domain-analysis.md](domain-analysis.md) | 실제 일관성 경계·액터·용어·기존 Repository와 유스케이스 |
| [architecture.md](architecture.md) | 단계적 adapter·권한/수명·원격 C/D/E·예산·복구 |
| [tdd-strategy.md](tdd-strategy.md) | Given/When/Then·판정 우선순위·정확한 테스트명 |
| [implementation-checklist.md](implementation-checklist.md) | Inside-Out RED/GREEN/RFCT 및 단계별 완료 조건 |

## 아키텍처 선택 (arch-choice 체크포인트 결과)

**B: 측정·판정 기반을 먼저 만들고, 명령 확정 계약을 입증한 뒤 별도 Live adapter를 기존 orchestration에 연결한다.** 선택 주체는 auto default이며 사용자에게 위임받은 실행 범위다. 기존 Realtime와 사용자 선택 설정은 fallback으로 유지한다. Domain/작업 수명/adapter/키·미디어·파일의 논리적 4레이어는 현재 flat TypeScript 구조에 적용한다. 새 폴더 계층·generic Repository·event bus·거대 파일 재작성은 필요하지 않다.

대안 A(legacy tuning만)는 회귀 범위가 작지만 새 후보의 가능성을 확인하지 못한다. 대안 C(hosted Responses 추가)는 backend 정본·비용·동의를 새로 설계해야 하므로 자동 채택하지 않는다. Live의 빠른 독립 시험만으로 B의 실행 통합을 승인하지 않는다.

## 현재 기준선과 성공 기준

| 트랙 | 실제 확인 범위 | 완료에 필요한 추가 증거 |
| --- | --- | --- |
| 음성 | v785 자동 영어 첫 decoded audio 3233ms. 다른 문맥의 별도 Codex CLI 시험 1318ms. Live 독립 세 시험 1242/889/984ms. 한국어·혼용 오류가 남음 | 같은 입력·문맥·관측 조건의 반복 측정, 실제 mic, 정확한 명령/대상/결과, 중단·복귀와 종료 |
| 원격 | v781 물리 iPhone LAN health 30/30, p95 121ms. 인증된 조작·cellular·Codex 모바일 UX는 미측정 | 인증된 같은 여정, 끊김·잠금·host 재시작·중복 클릭·권한 철회, 실제1시간 사용 |
| 교정 학습 | 정확한 entry/body 버전의 보고·claim 철회·bounded 회상·hourly 점검. 실제 반복 실패 감소는 미측정 | 해당 교정이 다음 관련 작업에 전달됐다는 trace와 독립 avoided/repeated/unknown 결과 |

근거는 [설치 실측 결과](../../../.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:21), [비교 기준의 기존 제안](../../research/rea-voice-resilience-2026-10-14.md:59), `src/projectMemoryCorrectionReview.ts:5`다. 단일 관측을 paired p95로 재해석하지 않는다. 예전 설치본·예전 소스의 PASS를 이번 변경 결과로 다시 표기하지 않는다.

사전 고정할 관측 목표:

- 음성 corpus: KO/EN/mixed 각각 distinct20개, 총60개 이상. response/interruption/resume의 각 metric condition에 유효 pair30쌍 이상. 의미·인식·작업 정확도와 오류/실패는 관측 비열등 margin0, 잘못된 대상·부정 반전·금지 동작·중복 실행0. 주요 latency p95≤Codex 기준선0.70배.
- 원격: workflow의 p95와 effort(taps+재입력) 중앙값은 각각 strict 감소. retry/error는 비증가 margin0. Wi-Fi/잠금/host 복구 p95≤0.70배, 각 latency 조건30쌍 이상. sustained는 p95가 아니라 양 제품 각각1시간과 독립 resource/task 채점이다.
- 교정: 정확한 보고 버전 → 다음 관련 작업 recall → 독립 결과를 연결한다. 반복률의 분모·unknown·미해결을 함께 공개한다. checkedAt·pending0·긍정 자평은 개선 효과가 아니다. efficacy 표본·관련성/관측 기간은 S4 진입 전에 고정하고 과거 실패를 사후 선택하지 않는다.

이 값은 달성 결과가 아닌 실행 기준이다. nearest-rank p95와 관측 비율은 기술 통계다. 신뢰구간·모집단 우위·통계적 유의성은 S0에서 계산하지 않으며 S5 전체 우위 주장 전 별도 사전 분석을 고정해야 한다.

## 실행 단계와 진입·종료 조건

| 단계 | 구현·조사 | 종료 조건 / 미달 처리 |
| --- | --- | --- |
| **S0: 지금 시작** | bounded 증거 DTO·순수 판정기·파일 CLI·회귀/Quick 연결 | 잘못된 PASS 방지와 모든 현재 소스 검증. 제품/학습 효과는 미완료 유지 |
| S1: 명령·수명 spike | 공개 Live 연결/sideband/종료 및 authoritative 명령 확정·수정·review 계약 | partial caption·timer·위임 metadata에서 명령을 합성하지 않고 완전한 명령/현재 대상/전송 의사를 입증. 미해소이면 실행 adapter 미연결 |
| S2: 설치 음성 개선 | S1 결과에 따른 작은 adapter 또는 원인 입증된 legacy 수정, 기존 guarded orchestration 유지 | CRAWL→WALK→RUN별 correctness·권한·중단/복귀·close·실제 mic 및 같은 protocol 비교. 빠르지만 잘못 실행하는 후보 거절 |
| S3-C | complete UTF-8/digest/revision/writer epoch·영속 제출 receipt | 부분 입력 write0, write_started crash는 unknown·자동 재실행0 |
| S3-D→E | 현재 grant 기반 history 복구 → semantic cursor·opt-in 암호화 초안/queue | 계정/대상/segment/receipt/cursor 검증, 다른 정본 병합 금지, 실제 authenticated phone·cellular·1시간 여정 검증 |
| S4: 교정 효과 | 기존 ledger/recall에 독립 다음 작업 outcome 연결, due/backlog/overdue 관측 | avoided/repeated/unknown·본문 버전·관련 task 근거. hourly metadata와 효과를 분리, 공유 OPS 사람 검토 유지 |
| S5: 실제 비교·출하 | 실제 native comparator·현재 설치 source/artifact·사전 분석·같은 여정 증거 | 세 트랙 충족 전 목표 완료 금지. native 접근 차단은 BLOCKED, CLI proxy는 별도 범위 |

S1 이후 각 단계는 진입 시 해당 seam의 구체적인 Given/When/Then과 source scope를 먼저 확정한다. 미해결 계약을 숨겨 다음 단계에서 구현하지 않는다. S2와 로컬 S3-C는 S0 후 독립 원인 수정이 가능하지만 D는 C의 receipt를, E는 D의 권한·복구를 선행한다. S4는 기존 정확한 correction/recall을 선행하며 Live 제공자 선택에 의존하지 않는다.

현재 Live는 자동 commit과 `response.done`의 직접 대응이 없고 client 위임 이벤트에 완전한 발화 본문을 주지 않는다. 원래 이벤트인 것처럼 합성해 Workroom 자동 relay에 넣지 않는다. [이행 계약](https://developers.openai.com/api/docs/guides/live-migration), [위임 문맥](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client)

후속 sideband는 공개 `/v1/live/sessions/{session_id}/attach`로 시작한 세션에 붙으며 `session.start`를 다시 보내지 않는다. close는 `session.closed` 최종 확인 또는 미확정 결과를 남긴다. 음성 종료와 backend task 취소는 독립 계약이다. [서버 제어](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live), [종료 확인](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close)

## S0의 고정 계약과 작업 파일

| 파일 | 책임 |
| --- | --- |
| `src/voiceRemoteBenchmark.ts` | BenchmarkProtocol/BenchmarkTrial/BenchmarkEvaluation strict parser와 순수 evaluator |
| `benchmark-voice-remote.ts` | bounded 파일 read→평가→비민감 JSON 보고; 입력 수정/네트워크/runtime 호출0 |
| `tests/voice-remote-benchmark.test.ts` | Unit20개·CLI3개의 정확한 행동 검사 |
| `package.json`, `.agentstoz/maintainer.json` | benchmark:voice-remote·Quick 필수 결정적 회귀의 좁은 등록 |

상한은 **512 cases /4096 trials /8MiB file**다. unknown key·민감 자유 text·오디오/전사/키/SDP/경로·비유한 수치·부적합 enum/ASCII ID/hash·중복 attempt·상충 pair를 거절한다. Protocol SHA·case input/expected fact hashes 및 각 제품 version/artifact/settings/source 결속을 고정한다. pair의 workload/context/environment/method/clock/transport/metric/condition이 일치해야 한다.

의미는 expected facts digest에 결속된 독립 human/deterministic scorer가 판정한다. 성공 시행 하나라도 의미 증거가 누락되거나 자평이면 BLOCKED 및 latency 통계 없음이다. 유효한 양쪽 성공 pair만 p95에 넣고 **실패·timeout·error·unpaired 시행은 전체 분모에 남긴다**. 누락 latency를0으로 만들지 않는다.

| 상태 | 의미 |
| --- | --- |
| FAIL | 관측된 candidate unsafe/확인된 cleanup 실패 또는 admitted 기준 미달; 부족 자료보다 우선 |
| BLOCKED | 불일치·누락 의미/상대 pair·표본 부족·cleanup unknown·native 필요 증거/접근 불가 |
| NOT_RUN | 해당 필수 condition/트랙 시행 없음; S0의 learning은 항상 NOT_RUN |
| PASS | 제출된 증거가 해당 관측 기준 충족. 실제 사실의 독립 인증이나 전체 목표 달성이 아님 |

comparisons는 `native-product | cli-proxy`만 허용한다. 단독 direct-provider feasibility를 Codex 비교로 바꾸지 않는다. native 비교에는 native surface·실제 mic/device·인증 action/state 보고가 필요하지만 태그 자체가 물리 사실을 증명하지는 않는다. 출력은 항상 **evaluatedScope:'reported-evidence', productGoalVerified:false**다.

## 검증·자원·복구

이번 연속 세션에서 tester ensure는 이미 한 번 수행했고 더 최신 repository runner 때문에 skipped였다. 다시 호출하지 않는다. `.agentstoz/MAINTAINER.md`의 현재 설정으로 Quick, Quick에 포함되지 않은 persona, `bun run verify`를 실행한다. common-memory4개와 나머지12개로 총16개이며 중복 실행·빈 catalog 통과는 없다. 수정한 source/docs는 실행 전에 freeze하고 sourceUnchanged·실패/blocked 영수증을 유지한다. persona 후보64개 상한에서는 기존 후보를 승인/삭제하지 않고 필요한 새 역할을 needs checks로 남긴다.

첫 대표 검사:

```bash
bun test ./tests/voice-remote-benchmark.test.ts
```

provider key·동의·원격 scope·기억 원본은 S0에서 변경하지 않는다. 후속 trial은 소유한 세션만 한정 시간·횟수로 열고 종료 확인을 수집한다. 백그라운드 AI·새 자동 저장 동의를 암묵 추가하지 않는다. 기존 hourly tick60초/8 targets/target1시간/summary128을 유지하며 많거나 불가한 target은 overdue를 표시한다. 원본 기억·미완료 receipt를 quota 때문에 지우지 않는다.

실행 adapter의 kill switch는 새 admission을 막고 기존 세션을 drain한다. fallback/reconnect는 unknown task의 재전송 권한이 아니다. C/D/E 기능을 꺼도 journal과 미확정 영수증을 보존한다. 기존 설정과 설치 backup으로 복구할 때 새 grant·positive memory 승인·provider 작업을 자동 재실행하지 않는다.

제품 설치 변경이 있는 단계는 검증 후 private main 병합/실제 원격 HEAD와 clean source guard→normal build→서명·bundle/sidecar hash→설치/실행 버전→실제 같은 protocol 재측정 순이다. 기존 rollback backup을 보존한다. CI는 계정 결제/사용 한도로 시작하지 않았으므로 cloud PASS로 표기하지 않는다. public publish·Windows CI·DB migration은 이 계획의 자동 확장 범위가 아니다.

## 계획 게이트 결과와 남은 불확실성

4개 파일의 존재/200bytes 이상/역할 필수 섹션을 내용 읽기 전에 확인했다. 각 역할의 실질 내용·현재 소스 인용·실제 4레이어·기존 일관성 경계를 확인했다. 용어·p95 수치·retry0의 불가능한 감소 조건을 단일 정합 라운드에서 고쳤다. Unit20개 이름 및 CLI3개 RED 이름은 기계 대조에서 23/23 일치했다. `StartVoice`·`RecoverSubmission`·`ObserveCorrectionOutcome`의 Domain→Architecture→TDD→체크리스트 연결을 점검했다. 추가 verifier/평가 AI 호출은 없다.

Phase R은 episodic3건과 bounded project adapter 결과를 읽었다. adapter의 contested/history 항목은 확정 사실로 채택하지 않아 C0이다. root의 별도 bounded 현재 기억 회상에서 QR web/native voice grant 분리, 입력 접수/완료 분리, single mic owner를 현재 소스의 제약과 함께 사용했다. 기억 Pull409 충돌은 덮어쓰거나 재시도하지 않았다.

| 미해결 사항 | Severity / Confidence | 후속 해소 |
| --- | --- | --- |
| Live 명령 확정·legacy 수명과의 차이 | 높음 / 높음 | S1 public API 및 실제 command/lifecycle spike; 없는 final event를 만들지 않음 |
| native Codex 화면 자동 제어 안전 차단 | 높음 / 높음 | 승인된 공개 CLI proxy만 비교. alternate UI/private daemon 우회0; native gate BLOCKED |
| 인증 휴대폰·cellular·1시간 및 교정 efficacy 공백 | 높음 / 높음 | S3/S4 실제 결과·동의·현재 권한 근거, 기존 timestamp/health로 대체0 |
| schema serialization·exit의 실제 wire 정합 | 중간 / 높음 | S0 RED 시작 전에 고정하고 fixture/CLI를 같은 계약으로 구현 |
| 관측 표본의 통계적 일반화 한계 | 중간 / 높음 | S5 사전 분석·불확실성; S0는 reported descriptive evidence만 |

REA/GitHub 방법론은 static 해시/graph에서 의심 경로를 찾고 실제 경로를 같은 조건으로 측정해 원인만 수정한 뒤 재측정하는 데 쓴다. 이미 있는 연구를 재사용하며 알 수 없는 계약이 생길 때만 좁은 추가 조사를 한다. 합성→기록된 입력→다중 턴, intent→delegation→실제 tool→state→spoken claim의 단계 구분을 따른다. S0에 새 AI 평가자를 추가하지 않는다. [공식 음성 평가 방법론](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation), [기존 REA 조사](../../research/rea-voice-resilience-2026-10-14.md)

S0 구현의 실제 wire와 초기 회귀는 [계약](BENCHMARK.md)·[실행 기록](EXECUTION.md)에 있다.
설치 동작을 바꾸는 후속 구현·보장 범위·migration·검증 gate는 [RUNTIME.md](RUNTIME.md)에 있다.
전체 제품 목표는 실제 세 트랙의 후속 gate가 충족될 때만 완료한다.
