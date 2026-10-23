# 자체 작업 흐름 아키텍처

- 기준 HEAD: `3619c91bc90ef83dd3b1ce6888db7e24edb45f09`; 2026-10-23. **신규 제안**은 미구현 심볼/API다. 용어·Repository 정본은 [domain-analysis.md](domain-analysis.md).
- 순서: 프로젝트 상태 묶음 → 조회 도구 묶음 → 규격 명령 기반 작업 팩. ego-lite/Aside 실행 환경·브라우저·독립 runtime/mission UI/DB/스케줄러/marketplace/범용 SDK/원격 임의 코드는 제외한다.

## 핵심 설계 결정

Phase1부터 `TargetBinding`·`ReadBudget`·`ReadSourceAdapter`를 사용하는 **공통 조회 executor 하나**를 둔다. `ProjectStateBundle`은 고정 조회 목록의 projection, `ReadToolBatch`는 사용자가 고른 타입 있는 단계 목록, `WorkPackRun`은 검토된 `WorkPackDefinition` 참조가 붙은 같은 batch의 projection이다. 각각 scheduler/adapter/timeout을 새로 만들지 않는다.
팩은 기존 `PromptGuideEntry`를 유지하고 **sourceLibraryId + 계정/library identity + guideId + commandBodyHash**에 결속한 암호화 local sidecar manifest로 저장한다. 본문은 기존 명령 보관함에 한 번만 저장한다. 정의는 현재 호스트 사용자의 라이브러리 metadata이고 대상·역할·권한은 실행 때 결속한다. 팩 공유·클라우드 동기화는 이번 범위 밖이다.
대안인 guide/envelope v2 일괄 전환은 가능하지만 구형 local/shared 검증기와 동시 업데이트가 필요하고 일반 텍스트 읽기까지 막는다. sidecar는 그 호환을 보존하는 대신 본문·삭제·계정 결속을 별도 검증해야 한다. 이번 최소확장에는 sidecar가 적합하다. 별도 엔진/DB는 사용자 범위 밖이므로 제안하지 않는다. sidecar는 호환성을 고려한 **계획 작성자의 권고**이며 사용자 선택·승인으로 기록하지 않는다. 가역적인 기술 설계 권고는 이미 요청한 계획 범위이므로 별도 질문 없이 구체화한다.

## 기존 기능 재사용과 독립 확인

| 실제 심볼·근거 | 재사용 / 추가 계약 |
|---|---|
| `buildAgentRuntimeTargetInventory`, `deriveAgentRuntimeWorktreeTargetId` — `src/agentRuntimeTargetInventory.ts:59-87,124-155,176-192` | 등록/Git 소유 opaque ID 재사용; 수집 시작·끝·전송 직전 binding 재검증 추가 |
| `verifyFreshAgentRuntimeWorktree` — `api-server.ts:8565-8599` | canonical directory·inode·Git common-dir 증명 재사용; 클라이언트 path 입력 금지 |
| activity `snapshot/events` — `src/aiTerminalActivity.ts:381-391` | 현재 exact-target 세션 projection; 프로젝트 전체 atomic snapshot이라고 부르지 않음 |
| `WorkroomThreadService.allowed/perform` — `src/workroomThreadService.ts:56-90`; `WorkroomSubmissions` — `src/workroomSubmissions.ts:17-35,80-102` | owner/target/revision와 prepared/write_started/written/unknown 영수증 재사용; 조회는 thread/AI를 생성하지 않음 |
| `TesterReport.source` — `src/testerAgentContract.ts:33-35`; `TesterAgentHost.perform` — `src/testerAgentHost.ts:159-167,274-284` | 기존 report/source 사용; start/ensure 분리·checkout freshness 추가 |
| `detectProjectMemoryForRecall/recallProjectMemory` — `project-memory-server.ts:2677-2683,2726-2785` | canonical 기억·교정 선별 재사용; curated-only 좁은 reader 추가 |
| `promptKindOf/workroomCommandBody/withBuiltinCommands` — `src/promptLibrary.ts:12-62` | 원본 명령·본문·기존 UI 유지; 검토된 선언 metadata만 추가 |
| `ServiceUseAdapter`, `ServiceUseHost.bind/receipt` — `src/serviceUseHost.ts:11-23,154-170,203-221` | 설치 코드·역할/device/grant·원래 requestId 원칙 재사용; broad USE status를 read-only로 간주하지 않음 |

## 논리 4레이어와 최소 모듈

기존 `src/` flat 구조를 유지한다. 4레이어는 논리 책임이며 폴더/class 계층을 강요하지 않는다.
- Domain: 순수 타입·검증·projection.
- Application: 조회 조율·정의 검토·실행 준비.
- Interface adapter: 기존 source reader·ThreadStore facade·sidecar 저장.
- Framework/UI: API 조립·Tauri proxy·React UI.

| 책임 | 신규 제안 배치 | 의존 방향 |
|---|---|---|
| Domain | `src/projectStateBundle.ts`: 타입·exact union parser·budget/condition 검증·projection | framework/React/fs/DB/provider import 없음 |
| Application | `src/projectStateBundleHost.ts`: 공통 collect/admit/read/cancel executor; `src/workPack.ts`: 정의 검토·결속·준비 | domain + 좁은 function port |
| Interface adapter | 기존 Git/runtime/tester/memory reader 주입, `WorkroomThreadStore` facade, `src/workPackStore.ts` sidecar adapter(필요 시) | application/domain 구현; source 간 직접 호출 금지 |
| Framework/UI | `api-server.ts` 조립, 기존 Tauri proxy, `src/projectStateBundleClient.ts`, 기존 Workroom/Prompt UI | UI가 shell·DB를 직접 접근하지 않음 |

신규 production module4개는 목표이며 억지 상한이 아니다. crypto/fs/암호화는 Application의 workPack.ts에 넣지 않고 필요하면 workPackStore.ts adapter로 분리한다. 이는 중복 엔진/DB가 아니다. preview UI component도 필요에 따라 분리한다. Repository는 기존 저장소 facade이며 `WorkPackRun`용 repository/journal/DB는 없다. 정본 signature:
```ts
interface ReadSourceAdapter { read(binding: TargetBinding, input: ReadSourceInput, budget: ReadBudget, signal: AbortSignal): Promise<SourceObservation>; }
interface ReadToolBatchRepository {
  admit(input: ReadToolBatchAdmission, active: () => boolean): Promise<{ batch: ReadToolBatch; created: boolean }>;
  read(threadId: string, requestId: string, owner: string, active: () => boolean): Promise<ReadToolBatch | null>;
  compareAndSet(threadId: string, requestId: string, owner: string, expectedRevision: number, next: ReadToolBatch, active: () => boolean): Promise<ReadToolBatch>;
}
interface WorkPackDefinitionRepository {
  read(sourceLibraryId: string, guideId: string): Promise<WorkPackDefinition | null>;
  save(expected: { sourceLibraryId: string; libraryRevision: string; guideId: string; commandBodyHash: string; definitionRevision: string | null }, next: WorkPackDefinition): Promise<WorkPackDefinition>;
}
```

## Phase1: 상태 묶음과 전송 경계

`TargetBinding`은 host 확인 owner/principal·host/device·role·projectTargetId/targetId·scope·canonical checkout/Git common-dir identity hash·branch/HEAD·grant revision을 가진다. 경로는 내부 전용이다. v1은 **로컬 데스크톱의 등록 DEV 프로젝트/worktree**만 지원한다. USE/OPS/remote 입력은 unsupported로 표시하고 DEV로 fallback하지 않는다. terminal/records grant는 새 조회 authority가 아니다.
요청시 캐시를 우회해 시작 binding을 확정 → 고정source를 동일executor로 수집 → 완료 binding 재검증 → preview/항목선택 → 원하는 경우 기존 Workroom draft에 첨부한다. 조회 자체는 새 thread/AI세션/앱/provider를 시작하지 않는다. thread 없는 preview가 가능하며 사용자가 원할 때 기존 업무에 작은 run참조를 붙인다. source마다 `observedAt`, 수집 구간, revision/hash, `availability:ready|unconfigured|partial|unknown|unavailable`와 `freshness:current|stale|unknown`의 독립 두 축, error code를 보존한다. identity/checkout/branch/권한 revision 변경은 **전체 invalidated·AI 전송 전체 차단**이다. 정상 source의 partial로 권한실패를 숨기지 않는다. 시작/끝 일치도 전역 atomic transaction을 뜻하지 않는다.
Git은 branch/commit·변경 개수·제한된 상대파일명만, runtime은 세션 요약만 수집한다. 기억은 명시 선택한 관련 query의 curated 항목만 반환한다. raw diff/log/transcript/env/credential/기억전체/절대경로는 자동 수집·보존·전송하지 않는다. 비밀 가능 문자열은 mask/withheld, 결과는 비신뢰 데이터로 감싼다. 전송 직전 binding/source hash와 기존 channel byte제한을 다시 확인하고, 선택한 항목만 기존 submission pipeline으로 보낸다. 초과는 선택축소 안내이며 몰래 잘라 송신하지 않는다.
테스터는 `source.commit`과 `source.fingerprint`를 현재 source와 모두 비교한다. 둘 다 없는 과거 report는 unknown, 명시적 불일치는 stale이며 commit만 같다고 dirty source의 최신 PASS로 만들지 않는다. 다른 target report는 제외하고 PASS는 기존 테스터의 원래 판정만 표시한다.

| 현재 read 경로·근거 | 확인한 부수효과 / 좁은 adapter 조건 |
|---|---|
| tester `status/read`→`reconcile` — `src/testerAgentHost.ts:126-129,159-167,284` | run receipt metadata save 가능. 이 제한적 local reconciliation은 명시 허용하되 ensure/start/apply/accept·실제 테스트/AI 실행은 금지; inspect의 IO/time도 신규 budget 적용 |
| 기억 recall→journal — `project-memory-server.ts:2707-2723,2762-2765`; `src/projectMemoryJournalRecall.ts:174-180` | mkdir/SQLite index create. 기본은 includeCommon:false+skipJournal:true를 감싼 좁은 export; Pull/index생성·복구·공통기억 확대 금지 |
| `readMemoryDocument` — `project-memory-server.ts:3153-3175` | manifest parts 동기전체read. canonical 검증 재사용, 파일별/합산 byte gate를 I/O전에 적용; 초과는 partial/withheld |
| USE status — `src/serviceUseHost.ts:112-125` | scope/phoneTargets의 login/vault/앱 접근 가능. 전체status는 v1 allowlist 제외; metadata-only `mentionServices`(:58-70) 원칙만 참고 |
| history `listTarget` — `src/workroomConversationService.ts:234-251`; ThreadStore constructor/open(false) — `src/workroomThreadStore.ts:31-40` | reconcile/probe revision 이동, directory생성/PRAGMA/DDL 가능. runtime source는 activity snapshot만 사용; source수집 중 history probe·키생성·migration 금지 |

첫 preview는 volatile이므로 encrypted store 생성/준비가 필요 없다. 사용자가 업무연결/batch실행을 선택할 때만 metadata receipt를 보존한다. 기존 키읽기와 키생성을 구분하고 준비되지 않으면 preview는 유지하며 저장불가를 표시한다.

## Phase2: 조회 도구 묶음

| operation ID | strict input signature(공통 binding 제외) | 출력 |
|---|---|---|
| `project.git.read` | `{operation:'project.git.read', pathsLimit?:0..20}` | branch/HEAD/counts/제한 상대경로 |
| `workroom.status.read` | `{operation:'workroom.status.read', sessionsLimit?:1..8}` | exact-target session/agent/activity/lastOutputAt, transcript 제외 |
| `tester.status.read` | `{operation:'tester.status.read'}` | configured/active/latest runId/freshness |
| `tester.report.read` | `{operation:'tester.report.read', runId:TesterRunId}` | 해당target report/check요약/source |
| `memory.reference.read` | `{operation:'memory.reference.read', role:'dev', query:string, limit?:1..3}` | curated entryId/contentVersionHash/excerpt/caution |

`dependsOn`은 같은batch의 앞선stage ID부분집합, 조건은 always/on-current/on-report-present 고정enum만 허용한다. runId만 선행 tester.status의 `latest.runId` 참조를 지원한다. cycle/잘못된참조/중복ID/알수없는 key/operation은 admission 전에 거부한다. 임의 JSONPath/JS/eval/shell·URL·credential·동적adapter등록·test start·remember·push·Pull·app launch는 금지한다. 필요한 source가 unknown/unconfigured이면 종속단계 skipped와 이유를 남긴다. stage는 target/role/grant를 바꿀 수 없다.
Admission에는 검증된 기존 DEV threadId가 필수다. 기존 encrypted ThreadStore facade가 `get(threadId)` 후 owner/target을 검사하고 `(threadId, requestId)`에 원래 binding/intentHash를 결속한다. 전체 스레드 JSON 검색, 새 receipt index, 단독 batch 저장은 이번 범위 밖이다. 같은 key의 다른 내용은 conflict이며 같은 내용 재요청은 원래 receipt를 돌려준다. CAS 충돌은 metadata만 병합하고 완료 source를 재호출하지 않는다. 단계별 pending/running/completed/partial/failed/skipped/cancelled/unknown과 source 시각·freshness·output digest·오류를 보존한다. 제한적 local metadata 저장은 조회의 도메인 동작과 구별한다. 독립 source 오류만 부분 계속하며 identity/권한 변경은 전체 중단·전송 금지다.
취소는 새 stage를 중지하고 AbortSignal을 adapter까지 전달한다. 실제 child/native operation 종료 전 concurrency slot을 반환하지 않는다. timeout이나 화면 닫기는 종료 증명이 아니다. 재시작 후 running은 unknown이며 자동 재개하지 않고 원래 ID receipt만 조회한다. 영속 기록에는 단계 상태·출처 ID/시각·digest·오류 같은 metadata만 남긴다. preview 만료나 재시작으로 source 값이 사라졌으면 payload unavailable로 표시하고 receipt 조회가 source를 다시 수집하지 않는다. 다시 수집은 사용자 선택에 따른 새 ID의 관측이며 과거 receipt는 유지한다.

## 공통 예산·수명(신규 제안값)

| 항목 | 초기 상한/정책 |
|---|---|
| wire/stages | control4 KiB·body2초, response32 KiB; stages8·의존깊이3 |
| concurrency | batch2·host4; target당active batch1·host active batch2; 초과 admission거부, 무한대기열 없음 |
| time | source3초·전체10초·cancel settle2초 뒤unknown; 실제종료까지 slot유지 |
| I/O·출력 | source1 MiB/총2 MiB; Git stdout+stderr128 KiB·상대경로20; 기억3hits·excerpt각700자; stage4 KiB/preview24 KiB·UTF8경계 truncation사유 |
| 전송 | 선택summary 기본4 KiB, user text합산 기존channel제한도 재검증. thread는6000 UTF8/JSON6100 bytes(`src/workroomThreadProtocol.ts:24-27`) |
| volatile | target당1/host8 previews·각32 KiB·5분. UI숨김은 신규수집만 중지하며 admitted작업/receipt 유지 |
| durable | batch metadata16 KiB·업무 attachment참조512 bytes. raw payload보존금지. 기존1000행/100 MiB/record512 KiB한도에 함께계산(`src/workroomThreadStore.ts:63-65`) |
| retention | 완료metadata30일 뒤 사용자정리대상표시, 자동삭제없음. unknown/미완료/dedup보존. 한도도달 admission중지·기존기록보존 |

Git은 설치 코드의 고정 argv와 읽기 설정으로만 호출하며 generic runner를 노출하지 않는다. 동기 전체 파일 읽기나 Git helper를 Promise.race로 감싸는 것만으로 deadline이 집행된다고 주장하지 않는다. 큰 기억 문서는 바이트 제한을 적용하는 비동기 reader를 사용하고, 차단될 수 있는 source는 해당 reader에 한해 기존 격리 probe를 재사용하거나 unsupported로 표시한다. 느린 source를 읽는 동안에도 다른 로컬 API와 취소 UI가 응답해야 하며 실제 I/O/child 종료까지 slot을 유지한다. 새 일반 worker engine은 만들지 않는다. 초과는 partial/unknown으로 표시하며 timeout 상향이나 추가 AI로 우회하지 않는다. 대표 두 프로젝트 실측 전 효율 향상을 보장하지 않는다.

## Phase3: 정의·CAS·호환

`WorkPackDefinition`에는 입력schema(문자열/enum/boolean·required/길이/기본값), 허용조회단계·고정조건, 성공근거source provenance, sourceLibrary/account identity·guideId·commandBodyHash·source revision, definitionRevision·검토상태만 둔다. target/grant/role/profile/credential·run receipt·비밀·기억은 넣지 않는다. 입력/대상선택→단계preview→명시실행→결과preview→선택시기존draft/업무참조다. 실행과 AI전송은 별개며 실제test/쓰기 권한은 생기지 않는다.
`kind:'command'`로 사용자저장된 entry만 팩을 붙인다. virtual builtin은 저장전 승격불가(`src/promptLibrary.ts:24-56`), 간단프롬프트 암묵변환/자동실행 없음. sidecar `work-packs.v1.enc`는 기존guide directory·전용key namespace/AAD·owned lock/atomic rename/fsync를 사용한다. 명시첫팩저장에서만 keycreate, read는 create금지. max256 KiB/100정의/정의당16 KiB·0600/0700·symlink/hardlink검증을 둔다.
CAS는 definitionRevision+현재libraryRevision/guideId/bodyHash/account를 같이 검증하고 local guide writer와 같은 lock을 사용한다. 두파일의 전역atomic transaction을 주장하지 않고 admission/실행전 재검증한다. unrelated pin/reorder/title은 유지, body/kind변경 stale, 삭제 tombstone/orphan, 같은ID/body 재import도 명시재검토전 부활금지다. legacy host가 삭제생애주기를 증명하지 못하면 provenance unknown으로 실행차단한다. shared source는 sourceLibraryId로 ID충돌을 막고 update/계정전환시 검토필요; 검증 불가 shared repository는 팩unsupported·텍스트사용유지다. metadata자체는 local-only다.
GuideEntry optional field 추가는 local exact-object/알려진key복사(`src/promptGuideStore.ts:24-46`), future schema거부(:65-77), shared5/6키검증(`src/sharedPromptGuideSql.ts:40-56`) 때문에 안전하지 않다. 기존v1 guides/RPC/SQL은 바꾸지 않는다. sidecar 손상/future schema/키유실은 원본보존·실행차단이며 새키교체/schema하향/본문복사로 회복하지 않는다.
Batch는 기존 스레드의 `StoredWorkroomThread.readExecutions`라는 **신규 제안 typed metadata**에 runId별로 추가하며 이전 receipt를 덮어쓰지 않는다. 새 스레드·CLI·가짜 agent를 생성하거나 serviceExecution/원래 thread.state를 변경하지 않는다. UI에는 작은 run 참조와 요약만 표시한다. 기존 512 KiB/행·호스트 예산에 함께 계산하며 한도에서는 새 admission을 거절한다. 실행 중 CLI가 source를 바꾸면 관측 시점·fingerprint에 따라 invalidated/partial로 표시하고 전역 원자성을 주장하지 않는다.
첫 영속화 때 thread_meta.version4로 올리고 새 host는1..4를 지원한다. 구형 `[1,2,3]` guard는 fail closed다(`src/workroomThreadStore.ts:43-51`). USE의 현재 version3 쓰기(:59-61)를 포함해 모든 writer가 version을 단조 증가시켜야 한다. 활성화 전 writer 지원 확인과 DB checkpoint/close 후 암호화 pre-v4 backup을 수행한다. preview-only에는 migration이 없다. v4 후 feature-off는 새 입장만 막고 현재 host의 기록 조회를 유지하며 구형 host는 전체 thread 저장소 접근을 차단한다. 자동 schema 하향/복원은 금지한다. 실제 downgrade는 v4 원본 보존과 명시적 복원 절차가 필요하며 백업 이후 업무가 복원본에 없을 수 있음을 알린다. sidecar rollback은 feature-off와 파일 보존으로 처리하고 guides는 유지한다.

## API·UI·최소 패치·gate

신규제안은 정확한 `POST /api/agent-runtime/project-state` 하나의 `preview|batch.start|batch.read|batch.cancel|pack.read|pack.save|pack.prepare` strictunion이다. Phase1은 preview만, pack.prepare는 검토/결속/preview만 한다. 기존 AgentRuntime capability·origin·owner/device/role guard를 재사용하고 외부path/임의operation전달은 거부한다. Tauri는 `agent_runtime_request`와 정확한path/method allowlist를 확장(`src-tauri/src/lib.rs:563-581,1421-1428`); 기존request256 KiB/response3 MiB(:1061-1081)는 늘리지 않고 신규4/32 KiB budget·path별15초만 적용한다. native invoke취소가 실제host중단은 아니므로 실제완료전busy slot을 유지한다. v1 remoteworkspace/MCP action은 미지원; 후속지원에는 negotiated feature+별도opt-in grant가 먼저다.
기존 PromptGuideBar/SharedPromptGuideBar/CommunityChatPanel/CommunityWorkspace/WorkroomConversationPanel 안에 preview·정의편집·작은run카드를 붙인다. 새catalog/mission탭 없음. collecting/partial/invalidated/unknown·text-only/draft/reviewed/stale/orphan/unsupported를 색상외텍스트로 구분한다. ko/en을 `src/i18n.ts`에 함께추가하고 dialog이름·선택label·키보드focus복원·aria-live진행/role=alert오류를 제공한다. 숨김/재연결은 재실행trigger가 아니다.

| 순서 | 최소 패치와 통과 기준 |
|---|---|
| P1 | domain/host/client3module + 기존sourcereader·api-server·Rust정확route·기존composer/i18n. 같은target boundedpreview·source별freshness·전송선택·identity/권한변경전체차단·noAI/test/keycreate/Pull을 확인 |
| P2 | P1 executor재사용 + ThreadStore facade/v4guard/CAS + 같은handler/client·기존결과UI. 독립병렬/의존순서/부분실패/취소/동일IDconflict/재시작unknown/owner회수·기존USE회귀를 확인 |
| P3 | workPack1module + 기존guide lock/key패턴·Prompt UI. 같은팩을2프로젝트에서 입력/대상을달리사용; legacykind/simple/command roundtrip·pin/reorder 유지·edit/delete/reimport stale/orphan·source principal/account전환·future-schema/oldhost차단·본문보존 확인 |
| 전체 | `build-sidecar.ts` compile경로(:6,107)에 새module포함확인. 구현검증은 기존projecttester/verify절차 적용; 본계획은 실제build/배포지시 아님. 이전gate통과전다음phase활성화금지 |

우려(필터없음): **높음/확신높음** 기존read의receipt/index/history/DDL부수효과는 위근거대로 분리해야 read-only가 성립한다. **높음/확신높음** v4후구형host의전체thread UI단절비용이 있으므로 activate전backup/지원확인·flagrollback과실제downgrade복원을 구분한다. **중간/확신높음** bodyHash만으로삭제/재생성생애주기증명불가→tombstone/unknown차단. **중간/확신높음** source간atomic불가→관측구간/시각/partial명시. **중간/확신중간** budgets는실측전제안→두프로젝트에서 검증후조정.
`briefing_correction`: runtime기본은256 KiB/3 MiB이며 신규4 KiB control예산과다르다. `serviceUseRegistry.ts`는없고 `ServiceUseHost.adapters/adapter`(:34-39,104-110)가등록정본이다. 별도WorkPackRunRepository/journal은 만들지않고 batchprojection으로 정정했다.
