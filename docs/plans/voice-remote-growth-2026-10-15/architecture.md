# 아키텍처 설계: 설치 음성·원격제어·교정 학습의 지속 개선

> ✅ 확정 아키텍처: B — S0 측정·판정 후 조건부 Live adapter와 기존 legacy fallback (arch-choice, auto default; 사용자에게 위임받은 계획·진행 범위).

작성일: 2026-10-15. 상태: **설계 초안**. 현재 설치 v785의 전체 제품 우위는 미달·미검증이다. 아래 신규 모듈·인터페이스·수치는 구현 완료 또는 기존 지원 기능을 뜻하지 않는다.

## 개요

세 트랙은 같은 증거 판정 규칙을 사용하되 실행 수명·권한·저장 경계를 각각 유지한다. 첫 변경 S0는 **재현 가능한 측정 명세와 순수 판정기**다. 현재 사용자 음성 설정, API, UI, 원격 grant, 기억 원본과 AI 호출 경로는 S0에서 변경하지 않는다. 이후 GPT-Live는 명령 확정·기존 워크룸 결속·종료 계약을 입증한 경우에만 독립 adapter로 추가한다. 대규모 폴더 재편이나 `src/App.tsx`·`api-server.ts` 재작성은 필요하지 않다.

현 상태의 출발 근거:

| 관찰 | 설계에 주는 조건 | 근거 |
| --- | --- | --- |
| v785 자동 영어 응답 첫 decoded audio 3233ms, 이전 별도 CLI 시험 1318ms | 동일 조건 반복 측정 전 속도 우위를 판정할 수 없음 | `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:21`, `:37` |
| 한국어·혼용 오류 및 Gemini 영어 미통과 | 빠른 영어 한 사례로 전체 정확도를 대체하지 않음 | 같은 파일 `:29`, `:33`, `:53` |
| GPT-Live 독립 짧은 시험 1242/889/984ms | 후보의 가능성일 뿐 설치 제품·실제 명령 통과 증거가 아님 | 같은 파일 `:59` |
| 실제 iPhone LAN health 30회 성공 | 인증된 쓰기·셀룰러·재접속·1시간 사용은 별도 gate | 같은 파일 `:15`, `:17`, `:55` |
| hourly review 시각 관측, 반복 실패 감소 미측정 | 다음 작업의 실제 outcome과 교정 노출을 결속해야 함 | 같은 파일 `:11`, `:56`; `src/projectMemoryCorrectionReview.ts:5` |
| native Codex 화면 제어 안전 거절 | 공개 별도 CLI proxy와 native 제품 비교의 판정을 분리; 우회 금지 | 같은 파일 `:49` |

## 레이어 구조

기존 flat TypeScript 배치에서 **논리적 4레이어**를 구분한다. 기존 파일을 옮기지 않으며 작은 순수 모듈과 adapter를 composition 지점에 연결한다.

```text
Domain
  src/voiceRemoteBenchmark.ts                   [S0 신규: BenchmarkProtocol/BenchmarkTrial/BenchmarkEvaluation]
  src/projectMemoryFeedback.ts                 [기존: 교정 종류·항목/본문 버전 결속]
  src/voiceSessionProtocol.ts                   [기존: 음성 요청/응답 DTO]
Application
  src/voiceSessionHost.ts                       [기존: 대상 결속·review·실행·관찰]
  src/projectMemoryCorrectionReview.ts          [기존: 제한된 결정적 점검]
  src/aiTerminalService.ts                      [기존: 워크룸 실행 진입점]
Adapters
  src/voiceRealtimeProvider.ts                  [기존: Realtime wire·sideband]
  src/geminiLiveProvider.ts                     [기존: Gemini wire]
  src/remoteControlRelayController.ts           [기존: 암호화 요청·queue·결과 수신]
  src/aiTerminalRemoteGateway.ts                [기존: 실제 프로젝트 grant 해석]
  [후속 Live adapter]                          [위임·자막·종료의 독립 계약, gate 전 미연결]
Infrastructure
  benchmark-voice-remote.ts                     [S0 신규: bounded JSON 파일 입력/보고 CLI]
  api-server.ts / src/App.tsx                   [기존: composition / UI]
  src/voiceCredentials.ts / Tauri / WebRTC      [기존: 키·미디어·호스트]
```

새 Domain은 filesystem, fetch, Keychain, UI, clock, 모델 호출을 import하지 않는다. CLI는 Domain을 호출하고 파일 크기·읽기 실패를 처리한다. provider wire와 공개 문서의 변화는 adapter가 흡수한다. 기존 거대 파일에는 연결용 import와 좁은 호출부만 추가한다.

## Domain Layer

### 정본 명칭과 객체

S0의 정본 명칭은 **BenchmarkProtocol, BenchmarkTrial, BenchmarkEvaluation**이다(`domain-analysis.md:107`)—이하 Protocol, Trial, Evaluation은 설명용 약칭이다. 세부 필드·Repository 메서드 정본은 `domain-analysis.md`를 따른다. 현재 실측 파일을 보존한 채 별도 새 schema로 입력하며 임의의 기존 JSON을 성공 표본으로 자동 변환하지 않는다.

| 객체 | 책임 | 핵심 불변식 |
| --- | --- | --- |
| Protocol | 측정 대상·조건·지표 정의와 판정 기준 고정 | schema/버전·조건 hash가 같아야 비교 가능; 시행 후 기준 변경 금지 |
| Trial | 한 회의 측정 사실과 실패·종료 증거 | 독립 식별자·pair ID·case hash; 결과와 관측 방식 구분; 누락 수치를 0으로 대체하지 않음 |
| Evaluation | 음성·원격·학습 각각의 판정 및 이유 | `PASS / FAIL / BLOCKED / NOT_RUN`; 관측한 안전 실패를 작은 평균값으로 덮지 않음 |

측정 manifest에 오디오·전사 원문·키·토큰·SDP·원격 기기 고유 ID·사용자 경로를 저장하지 않는다. 합성 corpus의 case hash와 검사 사실, 버전·조건의 비밀 없는 tag만 사용한다. 원본 실측의 짧은 문맥·합성 음원·CLI 표면·수동 commit 여부를 모두 보존한다. Evaluation에는 `evaluatedScope: 'reported-evidence'`를 필수로 두어 validator가 물리 실행 자체를 증명하지 않았음을 표시한다. expected facts digest는 독립 human/deterministic scorer의 사실 채점과 결속하며 S0에 새 AI 평가자 호출을 넣지 않는다.

### 측정 admission

비교에는 같은 corpus, 입력 방식, 발화 종료 기준, 문맥 정책, 전송 방식, backend 업무, 장치/네트워크 조건 및 scorer 정책이 필요하다. 앱·provider·모델 버전은 후보와 기준선의 차이를 설명하는 tag이며, 일부 차이가 허용되는지는 Protocol에 **시험 전에** 고정한다. 서로 다른 시험 시각의 단일 best case를 pair로 만들지 않는다. S0는 Protocol SHA·input/expected-fact hashes·version/artifact/settings hashes를 보존하고, pair의 workload/context/environment/method/clock/transport 일치를 검사한다. comparisons는 `native-product | cli-proxy`로 구분한다.

- 전체 음성 coverage는 한국어/영어/혼용 각각 20개 이상·합계 서로 다른 발화 60개 이상이고, 비교 지표·조건마다 유효한 paired 시행 30쌍 이상을 요구한다. 언어·숫자·부정 지시·개발 용어·중단/복귀의 미측정 구간을 coverage에서 숨기지 않는다.
- 의미·실제 작업 결과를 독립적으로 먼저 채점하고 지연을 그 뒤에 해석한다. `input accepted`·PTY write·응답 영수증은 AI 작업 완료가 아니다. 기존 호스트도 이를 구분한다(`src/voiceSessionHost.ts:585`, `:638`).
- 잘못된 schema, unknown keys, 중복 Trial ID, 다른 내용의 같은 pair/case ID, 비유한/음수 시간은 입력 오류다. 검증에 실패한 manifest에 제품 판정을 부여하지 않는다.
- 실패·제공자 오류·forced commit·종료 미확정·관측 timeout은 전체 시행 분모와 별도 상태에 남긴다. 정상 완료의 latency만 요약할 때도 실패율·전체 시행 수를 함께 반환한다. 실패 행 삭제로 p95를 개선하지 않는다.
- native 제품 비교 gate는 실제 native comparator 증거를 요구한다. 공개 Codex CLI proxy가 우수해도 native 비교는 `BLOCKED`; 데이터 없음은 `NOT_RUN`; comparator의 접근 제한은 시험 성공이 아니다.

S0의 출력은 숫자를 새로 만들어 내는 성능 테스트가 아니라 입력 증거의 **admission과 판정**이다. S0에서 learning은 `NOT_RUN`으로 유지한다. 테스트 전략의 임계값과 계산법은 Protocol 및 TDD 문서에서 확정하며 구현은 동일 값만 사용한다.

합성 발화(CRAWL), 기록된 현실 입력(WALK), 여러 턴의 중단·수정·도구 실행(RUN)을 별도 evidence 단계로 태그한다. intent → delegation → 실제 tool → state → spoken claim의 연결을 확인해야 하며 낮은 단계의 성공으로 실제 마이크·다중 턴을 통과 처리하지 않는다. 이 단계 구분은 [공식 음성 평가 예제](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation)의 방법론을 후속 시행 설계에 적용하는 제안이다. REA 정적 graph도 실행·설치 성능 증거와 구분한다. 현재 semantic VAD auto의 수치를 바꿔 속도만 최적화하지 않으며 한국어 미완성 발화·긴 pause 회귀를 먼저 검증한다(`src/voiceRealtimeProvider.ts:25`).

### 교정의 정체성과 결과

현 ledger는 version-bound 교정만 기존 claim을 철회하며 긍정적 자기평가 promotion은 꺼져 있다(`src/projectMemoryFeedback.ts:11`). 후속 결과 결속도 `(memoryId, entryKey, contentVersionHash, correction event, task/outcome receipt)`를 사용한다. 본문 교체·memory 계보 이동·미확인 provider 결과를 성공 학습으로 세지 않는다. 원인/다음 처리의 사용자 보고와 검증된 대안은 서로 다른 상태다. Domain 정본의 제안 `CorrectionOutcome`은 `avoided | repeated | unknown`이며 관련 task·독립 근거가 없으면 unknown이다(`domain-analysis.md:101`). Repository 인터페이스를 architecture에서 별도 창작하지 않으며 Domain 정본에 없는 저장 연산은 후속 설계 대상으로 남긴다.

### Repository 정본 재사용

VoiceSession과 Benchmark에는 새 영속 Repository가 없다. Workroom과 기억은 Domain 정본의 기존 서명만 재사용한다(`domain-analysis.md:65`, `:77`, `:105`).

```ts
type WorkroomConversationRepository = Pick<WorkroomConversationJournal,
  'get' | 'list' | 'receipt' | 'prepareResume' | 'finishResume' | 'mutate'>;
// readProjectMemoryFeedback(root)
// appendProjectMemoryFeedback(root, input) / 기존 batch
```

새 벤치마크 DB·범용 Repository 또는 기억/실행 journal 간 분산 transaction은 추가하지 않는다.

## Application Layer

### 유스케이스와 포트

| 유스케이스 | 입력 → 출력 | 재사용 계약 / 제안 포트 |
| --- | --- | --- |
| 측정 admission·판정(S0) | Protocol + Trial[] → Evaluation | 순수 parse/validate/evaluate 함수; 네트워크·AI 포트 없음 |
| 음성 연결·종료 | 현재 VoiceRequest/Authority → VoiceSnapshot + lifecycle 결과 | `VoiceProviderConnect`, `VoiceResolvedTarget` 재사용; 후속 engine별 lifecycle capability |
| 검토된 지시 실행·관찰 | 확정된 요청/대상/revision → 접수·작업 상태 | `VoiceReview.send/observe`; 실행 직전 authority 및 binding 재검증 |
| 원격 입력·복구(C/D/E) | grant + epoch + logical/session/submission ID → receipt/snapshot | 기존 terminal service/gateway; 영속 제출 계약은 기존 C 설계 정본 |
| 교정 적용 결과 관찰 | 정확한 교정 버전 + 다음 작업 결과 → 증거 상태 | 기존 recall/feedback와 독립 outcome 증거의 연결; 자동 긍정 promotion 없음 |

현재 `VoiceResolvedTarget`은 `validate`, 제한된 `tools/run`, `review`, `reviewWorkroom`, `reviewOps`를 제공한다(`src/voiceSessionHost.ts:31`). authority와 binding을 await 전후 다시 검사하는 패턴을 유지한다(`:124`, `:568`, `:623`). 실행 **후** 검사는 이미 생긴 부작용을 취소하지 못하므로 실제 write/도구 진입점 안의 active callback과 receipt 예약도 필요하다(`:23`, `:635`; `src/aiTerminalRemoteGateway.ts:29`).

### 음성·작업 수명 분리

1. 미디어 연결은 대상 binding·연결 epoch에 결속한다. 늦게 온 자막·오디오·도구 결과가 새 연결의 상태나 다른 프로젝트에 들어가지 않는다.
2. `caption fragment`와 `reviewed command`는 다른 입력이다. 자막 시간 간격, 무음 timer, 위임 metadata만으로 실행 가능한 final command를 만들지 않는다.
3. 기존 Realtime의 final transcript·function-call 완료 이벤트는 그대로 유지한다(`src/voiceSessionHost.ts:530`, `:544`, `:550`). Live를 그 이벤트로 가장해 기존 자동 relay에 연결하지 않는다.
4. Live에 기존 Workroom을 붙이기 전 spike는 **실제 명령 확정·대상/사용자 확인 revision·중복 위임·수정/취소·late caption**의 authoritative 계약을 검증한다. 확인되지 않으면 Live 실행 경로는 열지 않고 현재 provider를 유지한다.
5. stop voice는 backend task 취소와 별개다. 음성 종료 버튼이 완료된 입력을 재실행하거나 실행 중 작업을 조용히 취소하지 않는다. 별도 task cancel은 현재 task ID·권한과 실제 취소 결과를 요구한다.
6. 권한 철회·대상 교체 뒤 아직 실행하지 않은 tool은 거절한다. 이미 실행한 작업은 실제 receipt 상태를 확인한다. 다시 연결했다고 불확실한 작업을 새로운 ID로 재전송하지 않는다.

Live 문서에 따르면 client delegation은 metadata/offset만 주며 발화 본문은 주지 않는다. 자막 조각은 완전한 user turn도 아니다. 따라서 현재 자동 relay와 직접 호환된다고 가정할 수 없다. [Client delegation의 문맥 계약](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client#keep-the-conversation-context-in-your-application)

### 종료 상태

후속 Live adapter의 정상 종료는 `closing → finalization-confirmed | finalization-unconfirmed → resources-released`다. `session.closed` listener를 먼저 설치하고 `session.close` 이후 receiver/sideband를 유지한 채 최종 usage/reason을 받는다. 타임아웃은 미확정 결과로 보존하고 모든 자원을 해제한다. 이미 active backend 작업의 처리/취소는 별도 정책이다. [Graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close)

S1의 공개 sideband는 `wss://api.openai.com/v1/live/sessions/{session_id}/attach`로 이미 시작한 세션에 붙으며 sideband에서 `session.start`를 다시 보내지 않는다. WebRTC 미디어와 server event receiver의 수명도 분리한다. [서버 연결 계약](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#attach-to-the-existing-session)

현재 호스트는 종료 시 abort한 뒤 close를 기다린다(`src/voiceSessionHost.ts:139`); 현재 Realtime close는 hangup best-effort다(`src/voiceRealtimeProvider.ts:49`). Live에 이 구현을 그대로 재사용하면 finalization drain을 잃을 수 있어 lifecycle를 따로 정의해야 한다. `VoiceProviderConnection.close(): Promise<void>`만으로 confirmed/unconfirmed를 구분할 수 없다는 점도 후속 interface spike 대상이다(`src/voiceRealtimeProvider.ts:3`).

## Interface Adapters Layer

### S0: 파일 CLI

`benchmark-voice-remote.ts`는 bounded JSON 파일을 읽고 `src/voiceRemoteBenchmark.ts`에 전달한다. `package.json`에는 `benchmark:voice-remote` 진입점을 제안한다. 저장 schema와 출력은 strict하게 검증하며 입력 failure를 `PASS` JSON으로 바꾸지 않는다. 상한 초과/잘못된 파일/알 수 없는 schema는 비밀·원문을 출력하지 않는 오류다. S0에는 localhost 관리 API, UI, credential 조회 또는 실제 provider 호출이 없다.

### 후속 Live adapter

Realtime와 Live는 서로 다른 protocol이다. Live에는 manual commit 및 매 spoken-response 종료의 대응 이벤트가 없고 prompt도 voice style과 backend 업무로 나눠야 한다. [공식 이행 계약](https://developers.openai.com/api/docs/guides/live-migration#from-realtime-api)

후보는 **client delegation + 기존 orchestration**이다. voice prompt에는 역할·언어·대화/위임 동작만 둔다. workflow/도구/권한/기억 검증은 기존 backend가 소유한다. 현재 `providerInstructions`의 전체 실행 규칙을 그대로 복사하지 않는다(`src/voiceSessionHost.ts:419`). 실제 key는 현재 Keychain/Windows secret store에서 호스트만 읽고 UI·SDP 응답·sideband DTO에는 싣지 않는다(`src/voiceCredentials.ts:7`, `:44`). 선택된 모델을 설정 migration으로 자동 바꾸지 않는다(`:30`, `:36`, `:86`).

client delegation이 기존 agent·결과 검토·routing에 적합하다는 문서 근거는 선택을 지지한다. 하지만 우리 앱의 command finalization이 해결됐다는 근거는 아니다. 추가 Responses backend를 숨겨 호출하지 않는다. 필요한 새 AI 경로라면 task/비용/동의의 별도 계약과 측정이 먼저다. [위임 방식 선택](https://developers.openai.com/api/docs/guides/live-delegation#choose-a-delegation-mode)

### 원격 adapter와 C/D/E

현재 relay는 admission 시 token을 캡처하고 await 후 재검증하며, poll 중 변경도 거절한다(`src/remoteControlRelayController.ts:1457`, `:1537`, `:1607`). foreground/voice/background queue와 4회 후 오래된 waiter 진행을 유지한다(`:93`, `:1505`). 조회 cache가 실행 권한이 되지 않도록 gateway의 현재 grant 검사를 유지한다(`src/aiTerminalRemoteGateway.ts:9`, `:18`, `:31`).

후속 C/D/E는 기존 [설계](../workroom-conversation-recovery-2026-10-13/DESIGN.md)의 계약을 재사용한다.

- **C:** 전체 UTF-8/digest/참조 ID/크기 확인 후 writer epoch·revision을 예약하고 PTY write 전에 `write_started`를 영속 기록한다. crash/부분 쓰기는 unknown, 자동 재실행은 0이다. 외부 CLI exactly-once를 약속하지 않는다(`DESIGN.md:134`, `:152`).
- **D:** 유효 연결 → grant → target/account/segment → receipt → cursor/snapshot → 입력 순서로 복구한다. 제안된 history scope는 기존 승인에 자동 부여하지 않는다. 원격 DTO는 opaque ID·표시 metadata만 전달한다(`DESIGN.md:184`, `:194`, `:196`).
- **E:** PTY와 semantic runtime의 정본·영수증을 합치지 않는다. 정확한 event cursor 및 opt-in 암호화 초안/대기열은 별도 단계다(`DESIGN.md:82`, `:244`).

현재 A+B 구현 기록도 C/D/E가 후속임을 명시한다(`../workroom-conversation-recovery-2026-10-13/EXECUTION.md:55`). 새 기기·SAS·scope 승인 자체는 사용자의 명시적 기기 권한 절차이며 테스트 harness가 자기 승인하지 않는다.

## Infrastructure Layer

### Composition과 저장

S0는 `voiceRemoteBenchmark.ts ← benchmark-voice-remote.ts` 단방향이다. 기존 API 서버의 background review와 provider composition은 변경하지 않는다. 후속 adapter 연결도 `VoiceSessionHost → port ← Live/Realtime adapter` 방향을 지켜 provider wire가 도구 권한을 소유하지 않도록 한다.

교정은 기존 프로젝트의 canonical memory와 version-bound ledger를 사용한다. 공통 OPS와 프로젝트 기억의 정체성을 섞지 않는다. 현재 hourly coordinator는 OPS/shared root를 제외하고 target 경로를 다시 해석한다(`api-server.ts:27483`). 현재 control read는 같은 snapshot에서 document/revision을 계산하면서 access와 memory identity를 매번 검사한다(`src/controlProfileStore.ts:87`, `:116`). 성능 때문에 이 검사를 권한 cache로 대체하지 않는다.

### 예산·kill switch·복구

| 영역 | 초기 예산/정책 | 정지·복구 |
| --- | --- | --- |
| S0 manifest | 파일8 MiB·cases512개·trials4096개 상한; string 길이·nesting도 유한 검사; unknown fields 거절 | 초과 입력 오류; 결과 history 자동 삭제 없음 |
| 실제 trial 후속 | 사전 cap된 시행 수·최대 session 시간·대기 시간; 단일 실행 소유자 | provider/transport 오류 시 cleanup; 실패 행 보존; retry는 새 시행으로 기록 |
| Live pilot | 기존 선택 기본값 유지, 별도 한정 pilot enable; command gate 통과 전 실행 도구 없음 | kill switch로 신규 연결 거절; active session은 drain; 기존 Realtime 복귀 시 미확정 task 재전송 없음 |
| relay | 기존 total32/background16/voice8 admission·공정성 유지 | host/epoch 변경 시 대기 입력 폐기; receipt 확인 후 새 사용자 입력만 허용 |
| hourly review | 기존 tick60초·최대8 target·target별1시간·summary128 유지 | overlap 방지·unavailable target 격리·disabled 시 신규 점검 없음; 원본 교정 증거는 축출하지 않음 |
| 학습 outcome 후속 | 독립 사실 receipt를 제한적으로 참조; 원문/무한 이력 캐시 없음 | 증거 손상·버전 불일치·shared OPS는 보류; 자동 자기 승인 없음 |

review 예산은 `src/projectMemoryCorrectionReview.ts:33`에 실제 구현되어 있다. 다른 신규 수치는 TDD/부하 실측으로 확정하고 `docs/resource-management.md`에 같은 값으로 기록한다. “매시간 성장”은 모델 가중치 자동 교체가 아니라 검증된 교정의 회상·작업 적용·결과 확인 주기로 정의한다. 현재 pending/changed/unbound 집계는 outcome 증거를 포함하지 않는다(`src/projectMemoryCorrectionReview.ts:5`).

## 단계별 통합 gate

| 단계 | 나가는 조건 | 미달 시 |
| --- | --- | --- |
| S0 증거 기반 | pure schema/evaluator + file CLI, bounded 입력, failure 보존, 조건 불일치/CLI proxy 차단, 결정적 회귀 | provider/원격/기억 동작 변경 없이 검사 수정 |
| S1 Live spike | 공개 계약의 lifecycle·미디어·sideband·비밀 격리 + 실제 command finalization 해소 | 실행 통합 보류; caption timer를 final command로 승격하지 않음 |
| S2 설치 음성 | 한국어·영어·혼용 coverage·각 조건 ≥30 pairs, 중요 이름/숫자/부정 지시 정확성, 권한·재전송 안전 위반0, 실제 mic·중단 복귀·종료 확인 | 기본 provider 유지; latency만 빠른 후보는 거절 |
| S3 원격 C→D→E | authenticated paired 실제 iPhone·Wi-Fi↔셀룰러·host 재시작·중복 클릭·grant 철회·1시간 사용; unknown 재실행0 | 이미 쓰인 입력 자동 fallback/재시도 없이 영수증 상태 유지 |
| S4 hourly efficacy | 정확한 교정 버전의 다음 작업 노출과 독립 outcome, 한 시간 이상 실제 유지, 반복 실패 전후 분모/미해결 수 공개 | metadata timestamp만으로 학습 성공 판정하지 않음 |
| 제품 비교/출하 | 각 track 별 판정; native 동일 여정 comparator와 설치 source/hash 증거 | native comparator 안전 차단은 BLOCKED 유지 |

제안 성능 목표는 correctness·안전의 선행 조건을 만족한 뒤 voice paired p95가 기준선의 **0.70배 이하(30% 이상 감소)**가 되도록 하는 Domain 정본을 따른다(`domain-analysis.md:133`). 원격은 같은 여정에서 더 적은 tap/retry와 조작·복구 시간 감소를 관측하며 임의의 tap 감소 비율을 미리 발명하지 않는다. 이 숫자는 현재 달성치가 아니다. S0는 nearest-rank 관측 p95와 관측 오류·실패 비율만 계산하고 비열등 margin은 0이다. 신뢰구간·모집단 추론·통계적 우위는 계산하지 않으며, 제품 전체 비교 전에 별도 사전 고정 분석 설계가 필요하다. 네이티브 Codex 비교가 허용되지 않으면 그 목표가 완전히 달성됐다는 판정도 불가능하다.

실행 소스는 테스트 시작 전에 freeze한다. normal Quick과 구성된 persona는 중복 포함 여부를 확인하여 수행하고, 그 뒤 필요한 전체 verify를 실행한다(`.agentstoz/MAINTAINER.md:6`). 기존 같은-source 검증을 새 소스 pass로 재표기하지 않는다. 최종 설치는 clean private main·실제 원격 HEAD·서명·bundle/sidecar hash·실행 버전·rollback backup을 각각 입증한다. Windows/cellular/마이크 미측정은 대응 플랫폼의 통과가 아니다.

## 의존성 검증과 우려

- 신규 Domain의 외부 I/O 의존성 0, CLI만 파일 접근. 재사용하는 provider 포트와 task port를 분리해 caption/playback 종료가 실행 완료로 변환되지 않도록 한다.
- repository 정본을 중복 창작하지 않는다. 범용 event bus·DI container·대형 폴더 이동은 현 요구에 필요하지 않다.
- legacy와 Live의 capability가 다르므로 공통 인터페이스를 맞추려고 없는 final 이벤트를 생성하지 않는다.

| 항목 | Severity / Confidence | 근거·처리 |
| --- | --- | --- |
| Live의 metadata/자막으로 command 확정 가능성 미해소 | 높음 / 높음 | 공식 client 문서와 `src/voiceSessionHost.ts:530`; S1 전제, 미해소 시 실행 adapter 금지 |
| native 비교 증거 확보 제한 | 높음 / 높음 | RESULT.md:49; 공개 CLI proxy만 구별하여 사용, native gate BLOCKED |
| 실제 원격 회복·학습 효능 공백 | 높음 / 높음 | RESULT.md:55·56; 각기 설치/실기기/outcome gate 필요 |
| voice ended와 provider finalized 차이 | 높음 / 높음 | `src/voiceSessionHost.ts:139` 및 graceful-close 문서; engine별 종료 결과를 분리 |
| 거대 composition 파일의 회귀 범위 | 중간 / 높음 | App 16,693줄, API 27,774줄의 현재 파일; 작은 모듈/좁은 호출부, 재작성 금지 |
| 통계 목표·trial cap의 최종 값 | 중간 / 중간 | 설계 제안값; Protocol/TDD와 실제 예산에서 확정 후 시행 |

**briefing_correction:** 브리핑의 개선 가능성과 설치 결과를 독립 확인했으나 “빠른 Live 후보이면 기존 명령 자동 전달도 가능”이라는 결론은 채택하지 않는다. 원격 C/D/E는 완료 기능이 아니라 후속 계약이다. 현재 hourly 점검이 반복 실패를 이미 줄였다는 근거도 없다. Domain 정본 명칭 및 Repository 정의와 이 문서가 충돌하면 이름을 임의로 바꾸지 않고 plan-lead에서 정합한다.

## 핵심 설계 결정

**선택: B — 기존 orchestration을 유지하는 단계적 Live adapter, legacy fallback.** 첫 구현은 S0 측정·판정 모듈이고 제공자 전환은 S1의 실제 명령 확정·수명·권한 계약이 성립한 뒤에만 진행한다. 기존 설정을 조용히 바꾸거나 추가 AI를 숨겨 호출하지 않는다. 세 개선 트랙의 성공은 각각 실제 증거로 판정한다.

| 선택지 | 얻는 것 | 비용·제약 |
| --- | --- | --- |
| A: 기존 Realtime 최적화·측정 유지 | 가장 작은 회귀 범위, 기존 final transcript/tool 계약 유지 | 최신 후보의 지연 잠재력 검증·통합은 별도로 필요; 현재 3233ms 미달 해소 보장 없음 |
| **B: S0 → command spike → 조건부 Live adapter** | 현재 Workroom/교정/승인/receipt를 재사용하며 실제 성능 후보 평가 가능 | command finalization을 별도로 입증해야 함; 두 provider lifecycle을 유지하는 비용 |
| C: hosted Responses delegation 추가 | 위임 요청과 backend tool loop를 제공자가 구성 | 새 AI 비용·정책·동의·워크룸 정본 중복 가능; 현재 요구에 자동 채택하지 않음 |

4레이어 책임은 **Domain: 증거/판정 불변식**, **Application: 대상/작업 수명과 현재 인가**, **Adapters: 서로 다른 provider/relay wire 변환**, **Infrastructure: 키·파일·미디어·composition**이다. 선택 B는 아직 설치 기본값 변경을 승인하는 기술적 근거가 아니며 S0부터 구현 가능한 결정을 뜻한다.
