# 컴팩팅 전 자동 저장 점검

2026-09-24 KST. 사용자가 이번 세션의 50% 저장 여부와 Codex/GPT/Hermes/Antigravity 공통 적용 범위를 질문하여 읽기 전용 점검했다. 자동 저장 설정 변경이나 소급 저장은 하지 않았다.

## 확인된 결과

- 설치 v493의 자동 체크포인트 설정은 enabled=true, thresholds=[50,75,90].
- 현재 세션의 status.lastCheckpointAt/lastCheckpointThreshold는 null. 자동 체크포인트 SQLite의 receipts, attempts, intents, outcomes, completion_contexts에 해당 세션 행이 없다.
- 별도 V2 자동 기억 정리 정책은 enabled=false.
- 세션 원문은 복사하지 않고 token_count, task_started/task_complete, compacted 메타데이터만 집계했다.
- 최근 구간: 9월 23일 23:49:35 컨텍스트 51.74%, 9월 24일 00:05:28 90.94%, 00:08:08 compacted. 이 구간에는 task_complete가 없었다. 컴팩팅 직후 사용량은 11.08%로 떨어졌다.
- 따라서 이번 최근 컴팩팅 전에 50% 자동 저장이 실행·완료됐다는 증거는 없으며, 현재 저장 기록상 미실행이다. 이전 구간의 누락 사유를 모두 동일하다고 단정하지 않는다.

## 구현과 목적의 차이

`api-server.ts`의 readCodexAutoRememberObservations는 최신 token_count를 컨텍스트 창 크기로 나누고, CodexAutoRememberCoordinator는 임계값 도달 후에도 턴 완료 증거를 기다린다. 그 뒤 등록 프로젝트·기억 초기화·needsRemember 조건을 확인한다. 실행 중 컴팩팅이 먼저 발생하면 최신 사용량이 낮아져 임계값 조건이 사라질 수 있다.

관찰 입력은 Codex rollout과 Claude context snapshot이다. 같은 모델 이름을 사용하더라도 일반 ChatGPT 대화는 Codex rollout과 동일한 입력이 아니다. 이 경로에는 Hermes/Antigravity 관찰 adapter가 없다. V2도 이 기기에서 꺼져 있으며 이 점검으로 활성화하지 않았다.

## 후속 설계 기준

1. 사용자 목적은 턴 종료 후 기억 정리와 별도의 **컴팩팅 전 복구 체크포인트**로 정의한다.
2. 50% 교차를 session/turn/context-cycle별로 고정하고, 사용량이 내려가도 미완료 체크포인트 요청을 잃지 않는다.
3. 실행 중 원본을 일관된 경계까지 보존하는 기능과 AI 기억 요약·프로젝트 파일 변경을 분리한다. 진행 중 작업과 같은 파일에 경쟁 쓰기를 하지 않는다.
4. 가능하면 제공 도구의 공식 pre-compaction 신호에 연결하고, 없는 표면은 보장 불가/최선형을 명시한다. 외부 도구의 컴팩팅을 임의로 중단할 수 있다고 가정하지 않는다.
5. 저장 완료 영수증과 covered-through 경계가 컴팩팅보다 앞서는지 검증한다. 50→90% 단일 턴, 폴링 사이 컴팩팅, 재시작, 저장 실패·중복·복원, 대화만 있는 경우를 검증한다.
6. Codex, 일반 ChatGPT, Claude, Hermes, Antigravity는 각각 관찰·보존·복구 가능 범위를 확인한 뒤 지원 여부를 표시한다.

이 문서는 진단과 후속 설계 기준이며, 위 개선이 구현됐거나 모든 제공자에서 저장을 보장한다는 뜻이 아니다.
