# 도메인 분석: 프로젝트 상태 묶음 → 조회 도구 묶음 → 작업 팩

- 작성일: 2026-10-23 (Asia/Seoul). 기준 HEAD: `3619c91bc90ef83dd3b1ce6888db7e24edb45f09`. 상태: 구현 전 계획.
- 입력: [자체 생태계 분석](../../research/agentstoz-native-ecosystem-features-2026-10-23.md). source 근거는 기준 HEAD에서 직접 확인했다.

## 개요와 비목표
핵심은 현재 선택한 대상의 허용된 근거를 제한적으로 읽고, 검토한 조회 절차를 기존 규격 명령에 연결해 재사용하는 것이다. Phase 1의 고정 projection과 Phase 2의 사용자 조합은 같은 adapter·TargetBinding·ReadBudget·executor를 사용한다. Phase 3은 그 조합을 기존 명령에 additive 연결한다. 새 class/계층 폴더를 요구하지 않는다.
외부 ego-lite·Aside 앱/서비스/CLI/브라우저 엔진, 독립 runtime/mission 화면/스케줄러/marketplace/범용 SDK/원격 임의 코드는 제외한다. 조회는 테스트 실행·Git fetch/pull/push·기억 쓰기·앱 실행·설치·배포·외부 전송을 수행하지 않는다. 사용자가 보관을 선택한 뒤의 제한된 로컬 영수증 저장은 업무 데이터의 mutation과 구분한다.

## 액터와 유스케이스
| 액터 | 목표 / 유스케이스 | 권한 경계 |
|---|---|---|
| 프로젝트 개발자 | 상태 묶음 미리보기 → 선택해 기존 작업에 전달 → 조회 조합 → 팩 작성 | 현재 등록 DEV 대상만, 자동 AI launch 없음 |
| 돌아온 개발자 | 이전 run의 현재성·출처·실패/미확인을 확인 | 과거 결과 자동 재실행 없음 |
| 제품 일반 사용자 | 허용된 제품 운영 정보 조회 | USE의 기억·사용자·설치·grant 유지, Git/DEV/테스터로 자동 확대 없음 |
| OPS 운영자 | 정확히 선택한 프로젝트 또는 OPS 상태 조회 | 현재 프로필·역할·대상 권한만, 전체 프로젝트 자동 열람 없음 |
| 규격 명령 작성자/공유 보관함 구성원 | 검토한 절차를 다른 대상에서 재사용 | 정의 공유가 실행 결과·비밀·기억 공유를 뜻하지 않음 |
미리보기는 대상 선택→시작 identity→고정 조회→끝 identity→source별 상태 표시다. 새 업무·AI 세션·기억 저장을 만들지 않는다. 사용자가 항목과 기존 thread/워크룸을 선택한 뒤에만 전달하며, 직전 권한·identity·현재성을 재확인한다. 조합 실행은 전체 입력/DAG를 먼저 검증한 뒤 독립 단계만 제한 병렬화한다. 원래 requestId 조회는 재실행이 아니다. 팩 작성은 저장된 command 선택→schema/단계/완료 조건/출처 검토→로컬 manifest 저장이며, 실행 시 현재 대상에 새로 결속한다.

## 현행 중복 방지 매핑 — file:line + symbol
| 기존 기반 | 직접 확인한 증거 | 추가 계약 |
|---|---|---|
| 대상/워크트리 | `src/agentRuntimeTargetInventory.ts:64 deriveAgentRuntimeWorktreeTargetId`, `:83 buildAgentRuntimeTargetInventory`; `api-server.ts:8571 verifyFreshAgentRuntimeWorktree` | ID는 경로 기반이므로 inode/common-dir/fresh porcelain proof를 재사용해 같은 경로 재생성도 구별 |
| 등록 대상 해석 | `src/agentRuntimeTargetResolver.ts:39 resolveRegisteredAgentRuntimeTarget`, `:55` worktreePath 우선; `src/agentRuntimeApiContract.ts:63 AgentRuntimeTarget` | opaque ID만 수신, canonical 경로는 호스트 내부; 수집 전후/전달 직전 재해석 |
| 워크룸 활동 | `src/aiTerminalActivity.ts:28 WorkroomActivity`, `:7` exact/추정 구분, `:12` local-only | 상태만 제한 조회; PTY/대화 원문 기본 제외; 기존 모바일 DTO에 무단 추가 금지 |
| 스레드/결과 | `src/workroomThreadProtocol.ts:13 WorkroomThreadMessage`; `src/workroomThreadService.ts:56 allowed`, `:165 readSingle`, `:234` durable admission | 기존 작업에 결과 연결, 새 mission UI/가짜 CLI launch 없음 |
| 영수증/이력 | `src/workroomThreadStore.ts:25 WorkroomThreadStore`, `:59 write`, `:137 mutate`; `src/workroomConversationProtocol.ts:7 WorkroomConversation` | 암호화 task body에 결과 한 번 보관; history는 metadata/연결 ID만; 별도 팩 journal 없음 |
| 테스터 | `src/testerAgentContract.ts:34 TesterReport`, `:44 TesterStatus`, `:78 fields` | status/read만 사용, source/freshness 보존; ensure/start/apply/cancel 제외 |
| 기억 | `src/agentstozMention.ts:35 parseAgentMentionReference`, `:52 AGENTSTOZ_READ_REFERENCE_TOOL`; `src/projectMemoryRecall.ts:350 recallProjectMemoryEntries` | 기존 역할별 gateway, curated-only 기본·좁은 query·bounded hit; auto Pull/기억 쓰기 없음 |
| 규격 명령 | `src/promptLibrary.ts:13 LibraryEntry`, `:47 workroomCommandBody`, `:100 STANDARD_COMMAND_SECTIONS`; `src/PromptGuideBar.tsx:417` | 명령은 대상 독립; 저장된 기존 항목 참조, 본문 강제 변환/복제/자동 실행 없음 |
| local/shared 보관함 | `src/promptGuideStore.ts:35 exactObject 호출`, `:43` known-field 반환, `:69` schema guard; `src/sharedPromptGuideSql.ts:43` 5/6키 제한; `src/sharedPromptGuideClient.ts:3 PromptGuideRepository` | optional field 단순 추가 불가. v1은 source ref+bodyHash의 local sidecar; 기존 CAS와 source 검증 재사용 |
| USE/receipt | `src/serviceUseProtocol.ts:10 ServiceUseBinding`; `src/serviceUseHost.ts:161 bind`, `:176 execute`, `:203 receipt` | 사용자·보관함·설치·기기·revision 결속 원칙 재사용; 기존 mutation 도구 전체를 조회 batch에 노출하지 않음 |
| 설치된 어댑터 | `src/serviceUseHost.ts:11 ServiceUseAdapter`, `:104 adapter` | 코드 등록 소수 allowlist; 프롬프트/JSON이 도구 등록·권한 확대 불가 |

## 도메인 모델 — Aggregate 2개
**Aggregate: ReadToolBatch / Root Entity: ReadToolBatch.** ID는 원래 requestId, 소유자는 owner다. TargetBinding·고정 steps/input digest·ReadBudget·revision·시각·단계 결과와 optional threadId/workPackRef를 소유한다. 하나의 정확한 대상·역할·사용자·기기 권한에 결속하며 동일 ID의 결속/입력이 다르면 충돌이다. accepted→running→completed/partial/failed/cancelled/unknown/blocked. completed는 조회 완료이며 검사 PASS가 아니다. 대상/권한 변경 시 후속 실행 및 전체 모델 전달을 차단한다.
**Child Entity: ReadStep.** stepId·strict operation 입력·dependsOn·required·상태·SourceObservation을 가진다. DAG를 실행 전 검증하고 dependency 실패는 skipped로 보존한다. 의존 입력은 알려진 field의 typed 참조만 허용하며 JSONPath/eval/임의 표현식을 만들지 않는다. 취소/timeout이 실제 종료 증거가 아니면 완료/취소로 단정하지 않는다.
**Value Objects.** TargetBinding은 현재 대상·checkout proof·role·owner/기기/권한 digest를 호스트가 만든 결속이다. ReadBudget은 단계 수/동시성/시간/출력/보관 상한이다. SourceObservation은 값+observedAt+알 수 있는 sourceProducedAt/revision/commit/fingerprint+availability+freshness+truncated/limits다. availability의 ready/unconfigured/partial/unknown/unavailable과 freshness의 current/stale/unknown을 구별한다. ProjectStateBundle은 고정 batch의 projection, WorkPackRun은 workPackRef가 있는 batch의 typed 결과 projection이며 별도 Aggregate/journal이 아니다.
**Aggregate: WorkPackDefinition / Root Entity: WorkPackDefinition.** ID는 sourceLibraryId+guideId, 속성은 definition revision·저장 CAS용 libraryRevision·commandBodyHash·input schema·allowlisted steps·completion condition·provenance·review/disabled/stale/orphan 상태다. v1 manifest는 로컬에만 저장한다. 기존 명령 본문을 복제하지 않는다. shared source는 frozen ref+hash로 검증하고 실행/기억/비밀을 공유 DB로 보내지 않는다. 팩은 target/role/grant/기기/CLI profile을 지정·승격하지 않는다. virtual builtin은 사용자 사본 저장 전 팩 정본이 아니다. 본문 편집/삭제/reimport는 재검토, pin/reorder는 의미변경이 아니다. 자연어 본문을 자동 실행/PTY 전송하지 않는다.
**Domain Events.** ReadToolBatchCollected(결과 확정), ReadToolBatchBlocked(identity/권한 차단), WorkPackDefinitionReviewed(exact source 검토), WorkPackDefinitionInvalidated(source 변경). payload는 opaque ID/상태/출처 참조만, 비밀·본문·경로 제외. 새 event bus/AI watcher는 요구하지 않는다.

## Repository
시그니처 정본은 아래다. 기존 저장소를 감싸는 함수 포트로도 충분하며 새 class/DB를 강요하지 않는다.
```ts
interface ReadToolBatchRepository {
  admit(input: ReadToolBatchAdmission, active: () => boolean): Promise<{ batch: ReadToolBatch; created: boolean }>;
  read(threadId: string, requestId: string, owner: string, active: () => boolean): Promise<ReadToolBatch | null>;
  compareAndSet(threadId: string, requestId: string, owner: string, expectedRevision: number, next: ReadToolBatch, active: () => boolean): Promise<ReadToolBatch>;
}
interface WorkPackDefinitionRepository {
  read(sourceLibraryId: string, guideId: string): Promise<WorkPackDefinition | null>;
  save(expected: { sourceLibraryId: string; libraryRevision: string; guideId: string; commandBodyHash: string; definitionRevision: string | null }, next: WorkPackDefinition): Promise<WorkPackDefinition>;
}
interface ReadSourceAdapter {
  read(binding: TargetBinding, input: ReadSourceInput, budget: ReadBudget, signal: AbortSignal): Promise<SourceObservation>;
}
```
ReadToolBatchAdmission에는 owner/requestId/TargetBinding/steps/ReadBudget와 검증된 **기존 threadId가 필수**이고 workPackRef만 선택 사항이다. 미리보기는 메모리에만 두며 admit하지 않는다. 영속 실행은 기존 DEV 스레드를 선택한 뒤 `WorkroomThreadStore.get(threadId)`로 단건 조회하고 owner/target을 검증해 `(threadId, requestId)`별 metadata를 한 번 추가한다. 같은 requestId라도 다른 스레드는 다른 결속이며 전체 스레드 JSON 검색이나 새 receipt index는 만들지 않는다. 새 스레드·CLI·가짜 agent를 생성하거나 serviceExecution/원래 thread.state를 덮어쓰지 않는다. CAS 충돌은 metadata만 병합하며 완료한 source를 다시 호출하지 않는다. 기존 행/호스트 한도에 도달하면 새 입장을 거절하고 과거 receipt를 유지한다.
WorkPackRunRepository는 만들지 않는다. WorkPackDefinitionRepository는 기존 PromptGuideRepository의 read/CAS와 local sidecar를 조합한다. 두 저장소가 원자적이라고 주장하지 않으며 실행 직전 exact source를 재검증한다. 원본 조회 실패는 빈 library가 아니다. 삭제 tombstone/비활성화를 보존해 같은 ID/body 재가져오기도 명시 재검토한다.

## 공통 조회 operation / 도메인 서비스
| operation ID | 조회 데이터 | 제외 |
|---|---|---|
| project.git.read | branch/HEAD·dirty 요약·bounded 변경 경로 | remote/credential URL, 원문 diff/파일 내용 기본 제외, fetch 없음 |
| workroom.status.read | 선택 대상 세션/업무 상태와 exact 근거 | PTY 원문/다른 대상/계정 비밀 |
| tester.status.read | 설치/설정/최근·활성 검사 metadata | ensure/start/cancel/apply |
| tester.report.read | exact runId 보고서·source·limits | 임의 과거 run 대체, 불필요한 output/환경 원문 |
| memory.reference.read | 현재 역할의 curated 기억·좁은 query·bounded hit | raw journal/역할 혼합/auto Pull/쓰기 |
ReadSourceInput은 위 다섯 operation의 strict discriminated union이다. 공통 서비스의 책임은 binding 재검증, 계획/DAG 검증, 예산 집행, source 현재성 판정, 선택 projection, 팩 source 검증이다. 추가 AI 호출은 없다. 반환한 source/기억/명령 본문은 권한이 아닌 참조 데이터다.

## Bounded Context
조회 수집은 기존 등록 대상/Git/기억/테스터 계약을 소비한다. 규격 명령은 LibraryEntry 정본과 local manifest를 소유한다. 워크룸 기록은 task 결과를, 대화 history는 metadata만 소유한다. DEV/USE/OPS host가 권한 공급자이며 batch/팩/공유 보관함은 그 소비자다. 첫 릴리즈는 로컬 DEV부터, 미지원 역할은 fail closed이며 USE→DEV fallback이 없다.

## 가정 목록
| 가정 | severity / confidence | 근거 / 재확인 조건 |
|---|---|---|
| 로컬 DEV부터 출시, 원격/USE 확대 별도 gate | 중간 / 높음 | aiTerminalActivity.ts:12 local-only, serviceUseProtocol.ts:10 권한 결속 |
| 기본 기억 curated만, 전송 전 선택 가능 | 높음 / 높음 | agentstozMention.ts:52 역할별 reference 계약 |
| 효율 향상은 아직 가설 | 중간 / 높음 | 연구 문서 실측 전. 반복 설명/왕복/확인 시간 비교 후 판정 |
| unfinished/dedupe를 예산 확보용으로 삭제하지 않음 | 높음 / 높음 | workroomThreadStore.ts:25, :63 admission 상한 |

## Phase gate와 수용 기준
| Phase | 결과 | gate |
|---|---|---|
| 1 ProjectStateBundle | 고정 묶음 미리보기/선택 전달 | checkout 재생성·branch/HEAD/권한 변경 시 전체 전달 차단. source별 시각/불완전성 표시. 미리보기의 AI launch/새업무/test run/기억 쓰기 0회 |
| 2 ReadToolBatch | allowlist 조합/단계별 결과 | unknown field/코드/mutation/순환/출력폭주 실행 전 거절. 동일 adapter/binding/budget. 취소/timeout/재시작/동일 ID 조회가 새 호출을 만들지 않음 |
| 3 WorkPackDefinition/WorkPackRun | 기존 명령 기반 조회 절차 재사용 | 사용자 명령 1개로 대표 팩 작성 후 두 등록 프로젝트에 새 binding으로 실행. source 충돌·편집/삭제/reimport·old writer·CAS 안전 처리 |
첫 팩은 개발 현황 조회다. Git→tester status→exact 최신 report(있을 때), 선택한 관련 기억을 읽고 현재성/누락을 표시한다. 검사 실패도 유효한 조회 결과다. 검사 실행/수정/merge/build는 포함하지 않는다. persona 미설정은 PASS가 아니다(testerAgentContract.ts:36).

## UX·권한·삭제·재시작 한계와 우려
| 우려 | severity / confidence | 증거 / 필수 처리 |
|---|---|---|
| 같은 ID/경로가 다른 checkout을 가리킴 | 높음 / 높음 | inventory.ts:64 + api-server.ts:8571. fresh proof 재사용 |
| 전역 원자 snapshot/ABA 완전 탐지 오인 | 높음 / 높음 | source는 다른 저장소. 수집 구간·source별 시각 표시; 시작/끝 identity 일치는 동일순간 증명 아님 |
| 역할/owner 혼합·회수 뒤 모델 전송 | 높음 / 높음 | mention.ts:35, threadService.ts:56, serviceUseHost.ts:192. 전달 직전 재검증, 실패 시 전체 전송 차단 |
| optional 필드를 구형 writer가 거부/손실 | 높음 / 높음 | promptGuideStore.ts:35,:43,:69, sharedPromptGuideSql.ts:43. source schema 유지+local sidecar, 향후 내장 전 migration/old writer guard |
| 구형 ThreadStore가 새 receipt를 재저장 | 높음 / 높음 | workroomThreadStore.ts:45,:60. typed receipt에 explicit schema version guard |
| UI 취소 뒤 native read가 살아 예산 초과 | 중간 / 높음 | promptGuideClient.ts:107. 실제 호출 종료 전 slot 유지 |
| 삭제/reimport로 옛 팩 부활 | 중간 / 높음 | sharedPromptGuideClient.ts:33 import. tombstone·exact hash·재검토 |
| 오래된 PASS/조회 완료를 프로젝트 성공으로 표시 | 높음 / 높음 | testerAgentContract.ts:34,:49. 조회 상태와 검사 verdict 분리 |
| 원문 중복 보관/재시작 자동 재실행 | 높음 / 높음 | threadStore.ts:25, threadService.ts:166, serviceUseHost.ts:210. encrypted body 한 번, history 참조만, unknown 원래 receipt 조회 |
프로젝트/워크트리 삭제·grant 회수 뒤 현재 권한 없이 과거 결과를 열람하지 않는다. 자동 데이터 삭제로 복구하지 않는다. 정의 삭제는 과거 run을 삭제하지 않으며 run은 frozen ref를 보존한다. source가 사라지면 원문 복구를 주장하지 않는다.

## 용어집 — 후속 문서의 원문 정본
| 용어 | 의미 |
|---|---|
| ProjectStateBundle | 고정 허용 조회의 source별 관측을 선택 항목으로 투영한 프로젝트 상태 묶음. 전역 원자 snapshot이 아니다. |
| ReadToolBatch | 한 대상·역할·사용자의 조회 단계와 원래 requestId·예산·결과를 소유하는 실행 단위. |
| WorkPackDefinition | 기존 저장 명령의 exact source에 결속한 입력 schema·조회 단계·완료 조건·출처·revision의 검토된 선언. |
| WorkPackRun | 특정 WorkPackDefinition revision을 쓴 ReadToolBatch 결과 projection. 별도 실행기/저장소가 아니다. |
| TargetBinding | 현재 등록 대상·checkout·역할·사용자·기기·권한을 호스트가 재검증한 결속. ReadBinding 등 동의어를 만들지 않는다. |
| ReadBudget | 단계 수·동시성·시간·출력·보관량의 공통 상한. |
| SourceObservation | source 값과 observedAt·revision·현재성·미설정·부분성·잘림을 함께 나타내는 불변 결과. |
| ReadStep | batch 안의 stepId·strict operation 입력·의존성·상태를 가진 조회 단계. |
| LibraryEntry | 현행 promptLibrary 항목. 팩을 위해 새 보관함 항목으로 복제하지 않는다. |
| sourceLibraryId / commandBodyHash | local/shared 및 library/account의 opaque source identity / 검토한 명령 본문의 exact hash. |
| completion condition | 알려진 조회 결과의 typed 완료 조건. 검사 PASS/AI의 성공 표현과 같지 않다. |

## briefing_correction
- `src/serviceUseRegistry.ts` 후보는 기준 HEAD에 없다. 현행 정본은 `serviceUseHost.ts:11 ServiceUseAdapter`, `:104 adapter`다. severity 낮음 / confidence 높음.
- Phase 3의 additive는 기존 PromptGuideEntry에 optional 필드를 즉시 넣는다는 뜻이 아니다. local/shared exact 키·future schema guard 때문에 v1은 local sidecar source 연결이며 향후 내장에 migration/old writer guard가 필요하다. severity 높음 / confidence 높음; `promptGuideStore.ts:35,:43,:69`, `sharedPromptGuideSql.ts:43`.
