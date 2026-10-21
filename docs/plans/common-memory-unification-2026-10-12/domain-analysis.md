# 도메인 분석: 공통기억 통합과 SDK 재사용 후보
protocol: LOOP-PROTOCOL loaded; recall: E3/C5/N0 (상위 전달, 현재 근거로 재검증); hitl: auto.
분석 기준: worktree HEAD `e0818efe`. 이 문서는 **제안 계약**이며 구현·테스트·실기 성공 보고가 아니다.
## 개요와 확인한 현재 모델
- 공통기억은 클라우드 `CommonMemory` 하나로 관리하고 검색·복수 선택·보관 조회를 제공한다. 저장 형식의 출처가 별도 편집 화면을 만들지 않는다.
- 현재 `CommonMemory`는 schema1, source 1~16개, 실제 기억 revision/hash 근거와 검토·게시 규칙을 요구한다 (`src/commonMemory.ts:4`, `:8`, `:33`, `:59`).
- 현재 `MetaCommonMemory`는 독립 수동 지식, include/exclude 연결과 카테고리 규칙을 가진 로컬 정본이다 (`src/metaCommonMemoryContract.ts:5`, `:95`).
- 로컬 head는 **512 KiB 이하**이고 history/요청 영수증이 SQLite에 함께 저장된다. 256×12KB 조합이 모두 저장되는 것은 아니다 (`src/metaCommonMemoryStore.ts:50`, `:112`).
- 기존 클라우드의 6개 테이블·RPC는 schema1 및 1~16 sources를 강제한다. v2가 기존에 지원된다고 주장하지 않는다 (`src/commonMemorySql.ts:1`, `:64`).
## 액터와 유스케이스
| 액터 | 책임 | 유스케이스 |
|---|---|---|
| 인증된 사람 | 기존 지식과 실제 연결을 관리·복구, 후보 승인 | PreviewLegacyMigration, ExecuteLegacyMigration, ManageCommonMemory, ApproveSdkReuseCandidate |
| 등록 Mac 호스트 | scope·등록·기억 정체성·CAS·영수증 검증 | ReadLegacyMigrationStatus, RollbackLegacyMigration, ResolveLinkedCommonMemories |
| MCP 에이전트 | 범위에 맞는 회상, 후보 제안·검증 근거 제출 | RecallCompatibleCommonMemory, PrepareSdkReuseCandidate, TestSdkReuseCandidate |
| 프로젝트 담당자 | 선택한 SDK 후보를 특정 대상에 적용·확인 | ApplySdkReuseCandidate |
- **PreviewLegacyMigration**: source 읽기 트랜잭션으로 원본 head를 해석하고 현재 등록 대상의 portId+expectedMemoryId를 확인한다. 쓰기·초기화하지 않는다.
- **ExecuteLegacyMigration**: 검토한 동일 plan을 requestId에 결속해 cloud CAS·hash readback·local handoff까지 수행한다. 충돌/미확정은 원본을 남기고 쓰기를 보류한다.
- **ManageCommonMemory**: 하나의 화면에서 지식·연결·목표·게시·적용 근거를 편집한다. 복수 선택은 ID별 CAS와 개별 결과를 반환하고 부분 실패를 감춘 완료 표시를 금지한다.
- **ResolveLinkedCommonMemories**: 등록 폴더/프로젝트 상세에 적용되는 기억 이름·목표·게시본·재검토 상태·동일 관리 화면 링크를 반환한다.
- **RecallCompatibleCommonMemory**: 기존 읽기 호출과 선택된 goal publication을 독립 출처로 반환한다. unavailable을 빈 성공으로 바꾸지 않는다.
- SDK 순서: **PrepareSdkReuseCandidate → ReviewSdkReuseCandidate → TestSdkReuseCandidate → ApproveSdkReuseCandidate → ApplySdkReuseCandidate**. 자동 전체 프로젝트 수정은 없다.
## 도메인 모델과 불변식
### Aggregate: CommonMemory (기존 schema1 루트의 additive 확장)
- ID: `groupId` UUID. 저장소 version, goalVersion, legacy 호환 revision은 다른 카운터다. 이름·단말 role·폴더는 식별자가 아니다.
- **최종 제안** `CommonMemoryUnified = CommonMemory & {portableKnowledge?:PortableKnowledge;goalConfigured?:boolean}`. 기존 schemaVersion:1과 non-null goal 형태를 유지한다.
- `PortableKnowledge = {snapshot:MetaCommonMemory;sourceFingerprint:string;importedAt:string;current:MetaCommonMemory}`. snapshot은 원래 ID·본문·상태·연결·카테고리·시각·revision을 보존하는 불변 이관 기준이며 current는 cloud에서 관리하는 호환 뷰다.
- `GoalMemory`는 기존 flat `goal/goalVersion/sourceMemoryIds/items/sourceHeads/publication` 필드 묶음의 논리 명칭이다. 별도 큐·범용 모델·중복 저장 루트가 아니다.
- legacy-only 이관은 description||name을 objective로 한 정규 goal, `goalVersion:1,goalConfigured:false,sourceMemoryIds:[],items:[],sourceHeads:[],publication:null`이다. 기본 objective는 ‘목표 미설정’ 표시용이며 사람의 목표·검토·게시 성공이 아니다.
- `CommonMemoryMembership`는 current.members(include/exclude)+current.categories의 의미이며, goal의 최대 16개 evidence sources와 별개다.
- snapshot/current의 id는 root id와 동일하다. current.name/archived는 root와 한 트랜잭션에서 동기화한다. snapshot은 cloud 편집으로 변하지 않는다.
- 지식 편집·명명·연결·보관 변경은 current.revision을 증가시키며 모든 변경은 cloud version CAS를 통과한다. goal만 바뀌어도 최신 current를 보존해야 한다.
- `active`는 확정 지식, `contested`는 논쟁 상태를 표시한 회상 대상이다. `candidate/superseded`는 회상하지 않는다. 어느 상태도 goal item의 reviewed를 의미하지 않는다.
- 목표/증거 변경은 기존 GoalMemory의 재검토·게시 규칙을 그대로 따른다. 수동 지식을 실제 project revision 근거로 위장하지 않는다.
- pure goal의 create/configure는 기존 source 1~16 규칙을 유지한다. source 0개는 호스트가 검증한 portableKnowledge가 있는 독립 지식 분기에만 허용한다. DB/RPC는 이미 저장된 portableKnowledge/goalConfigured의 누락·불변 snapshot 변경을 거부한다.
- 전체 snapshot+current+goal state는 기존 1MB 예산을 검사한다. 복제가 큰 그룹의 이관을 제한할 수 있으므로 blocked 이유를 표시하고 원본·항목을 절삭하지 않는다.
- wire 응답은 불변 snapshot 전체를 보내지 않고 current 항목·연결을 페이지로 제공한다. 전체 escaped JSON350KB 창과 기존4KB 조각/2MB 결과 한도를 유지한다.
- Entity: `MetaMemoryEntry(id)`, `CommonMemoryItem(id)`, `CommonMemoryPublication(id)`; VO: `CommonMemoryGoal`, `CommonMemoryEvidence`, `CommonMemoryMembership`, `CommonMemorySelection`.
- Domain Event: `CommonMemoryMigrated`, `CommonMemoryMembershipChanged`는 기존 durable receipt에 대응하는 사실이며 새 event bus를 요구하지 않는다.
### 이관 VO와 영수증 (추가 Aggregate 없음)
- `LegacyMigrationPlan={groupId,scopeId,expectedLocalRevision,expectedCloudVersion,sourceFingerprint,assignments,knowledgeCounts,payloadBytes,status:'ready'|'blocked',reason?}`.
- `assignments`는 기존 `MetaMemoryAssignment[]`이다. 선택한 등록 port와 expectedMemoryId를 신선하게 해석하며, plan fingerprint 자체는 권한이 아니다.
- `LegacyMigrationReceipt={groupId,scopeId,requestId,sourceFingerprint,state:'prepared'|'cloud-committed'|'handed-off'|'conflict'|'unknown',committedVersion?,committedHash?}`.
- `LegacyMigrationKey={groupId,scopeId,requestId}`; `LegacyMemorySource={snapshot:MetaCommonMemory,sourceFingerprint,historyCount}`.
- `LegacyMemoryRevision={revision,operation,createdAt,payload:MetaCommonMemory}`는 원본 SQLite의 읽기 DTO다. 과거 모든 revision을 cloud에 재작성하지 않는다.
### Aggregate: SdkReuseCandidate (제안)
- 루트 ID: candidateId UUID; 소유: 선택된 등록 SDK projectRef와 실제 sdk memoryId. 로컬 version 및 request 영수증으로 중복·동시 변경을 제어한다.
- 필드: 목표, 선택한 source project refs, `SdkSourceEvidence[]`, 상대 artifact 경로+hash, review, 실제 test receipt, humanApproval, targetApplications. 상태는 `proposed|reviewed|tested|approved|needs-review`.
- 정본 필드명: candidateId/version/sdkProjectRef/sdkMemoryId/goal/sourceProjectRefs/evidence/artifacts/review/testReceipt/humanApproval/targetApplications; SdkSourceEvidence는 projectRef/memoryId/gitHead/code[{relativePath,hash}]/memory[{revisionId,entryId,contentHash}]이다.
- `SdkSourceEvidence`: 등록 프로젝트 해석 증명, 실제 코드 상대 경로/hash/Git HEAD, 기억 memoryId/revisionId/entryId/contentHash. 원문 전체 저장소·credential을 후보에 넣지 않는다.
- source 선택은 최대 4개, 코드 evidence 최대 32개·전체 캡처 512 KiB로 제한하는 초기 제안이다. 코드와 기억의 현재 hash를 review/test/apply 직전에 다시 확인한다.
- 기존 catalog의 32 modules 및 1,000 files/8MB scan 예산을 재사용한다 (`src/sdkProjectManagement.ts:19`, `:25`). missing memory는 명시적 부족 상태이며 자동 init으로 메우지 않는다.
- review는 재사용 범위·제외 조건·API 계약·근거를 확인한다. 최신이라는 이유만으로 최적 구현이라고 판정하지 않는다.
- 문서·데모는 등록 SDK 내부의 후보 소유 상대 경로 `docs/reuse/<candidateId>/index.html`에만 만든다. HTML escape·외부 접속 제한과 sandbox 미리보기, 소유 manifest/hash를 요구한다.
- 실제 검사는 고정·검토된 catalog/scenario 실행 계약으로 수행하고 exit/result/source hash를 기록한다. 추천·prepare 상태나 임의 AI 문자열을 test 통과로 취급하지 않는다.
- humanApproval은 현재 candidate version·artifact hash·test receipt에 결속한다. 목표·근거·후보 내용 변경은 tested/approved를 무효화하고 needs-review로 전환한다.
- targetApplications는 명시적으로 선택한 등록 프로젝트별 preview/diff·권한·CAS·request receipt를 갖는다. 변경 파일만 적용하며 dirty SDK/Cdp/대상 파일은 덮어쓰지 않는다.
- MCP는 제안/검사 근거를 제출할 수 있으나 자기 후보를 사람 승인으로 확정하지 않는다. 적용 결과는 대상별 실제 검증이며 후보 승인과 다르다.
- Domain Event: `SdkReuseCandidateApproved`, `SdkReuseCandidateApplied`; Entity: target application receipt; VO: SdkSourceEvidence, humanApproval.
## Repository (명칭·시그니처 정본)
이하는 모두 **제안 인터페이스**이며 기존 함수형 module/dispatcher에 구현한다. architecture.md는 그대로 인용·구체화한다.
```ts
type Page<T>={items:T[];next:string|null;truncated:boolean};
type CommonMemoryRecordUnified={state:CommonMemoryUnified;version:number;scopeId:string};
type CommonMemoryQuery={query:string;archived:'active'|'archived';after:string|null;limit:number};
type CommonMemoryOperationKey={scopeId:string;groupId:string;requestId:string;requestHash:string};
type CommonMemoryCommit=CommonMemoryOperationKey & {expectedVersion:number;state:CommonMemoryUnified};
type CommonMemoryCommitReceipt=CommonMemoryOperationKey & {version:number;stateHash:string;replayed:boolean};
interface CommonMemoryRepository {
  findById(scopeId:string,groupId:string):Promise<CommonMemoryRecordUnified|null>;
  list(scopeId:string,query:CommonMemoryQuery):Promise<Page<CommonMemorySummary>>;
  commit(input:CommonMemoryCommit):Promise<CommonMemoryCommitReceipt>;
  operationStatus(key:CommonMemoryOperationKey):Promise<CommonMemoryCommitReceipt|null>;
}
interface LegacyCommonMemoryRepository {
  snapshot(groupId:string):Promise<LegacyMemorySource>;
  replay(groupId:string,requestId:string,requestHash:string):Promise<MetaCommonMemory|null>;
  prepareHandoff(plan:LegacyMigrationPlan,requestId:string):Promise<LegacyMigrationReceipt>;
  completeHandoff(receipt:LegacyMigrationReceipt):Promise<LegacyMigrationReceipt>;
  status(key:LegacyMigrationKey):Promise<LegacyMigrationReceipt|null>;
  history(groupId:string,beforeRevision?:number):Promise<Page<LegacyMemoryRevision>>;
  releaseHandoff(receipt:LegacyMigrationReceipt,withdrawal:CommonMemoryCommitReceipt):Promise<void>;
}
interface SdkReuseCandidateRepository {
  findById(sdkProjectRef:string,candidateId:string):Promise<SdkReuseCandidate|null>;
  commit(input:{sdkProjectRef:string;expectedVersion:number;requestId:string;requestHash:string;candidate:SdkReuseCandidate}):Promise<SdkCandidateReceipt>;
  operationStatus(sdkProjectRef:string,requestId:string):Promise<SdkCandidateReceipt|null>;
}
```
`CommonMemorySummary`는 groupId/name/archived/knowledgeCounts/goal/publication/review 표시 DTO, `SdkCandidateReceipt`는 sdkProjectRef/candidateId/requestId/requestHash/version/stateHash의 영수증 DTO다.
## 도메인 서비스와 호환·복구 규칙
- `previewLegacyMigration({localGroupId,scopeId,assignments})`는 LegacyMigrationPlan, `executeLegacyMigration({plan,requestId})`는 LegacyMigrationReceipt, `legacyMigrationStatus(key)`는 읽기 전용 결과를 반환한다.
- 호스트가 source snapshot을 재구성한다. same group ID의 기존 cloud가 다른 provenance이면 이름·expectedVersion만으로 채택하지 않는다. 동일 scope/원본 fingerprint/요청의 영수증만 재사용한다.
- 순서의 의미는 source 읽기 → 원본 backup·현재 head 검증·legacy writer fence → cloud CAS → canonical state hash readback → 같은 source의 local handoff receipt다. fence는 groups/members/revisions의 기존 쓰기도 막아야 한다.
- SQLite user_version 변경만으로 이미 검사 후 대기 중인 writer를 막았다고 가정하지 않는다. 원본 history backup은 복구 가능한 상태로 보존한다.
- unknown·권한/연결 변경은 새로운 request로 자동 재시도하지 않는다. 원본은 남고 둘 다 편집 정본으로 쓰지 않는다. 영수증 없음만으로 prepared fence를 해제하지 않는다.
- `rollbackLegacyMigration({receipt,expectedCloudVersion,requestId})`는 이관 뒤 cloud 편집이 없는 exact CAS withdrawal/archive 및 readback 후 local fence를 해제한다. 이후 편집이 있으면 수동 정합성 확인 대상으로 차단한다.
- handoff 뒤 old API/MCP의 list/read/save-entry/propose-entry/review/assignment/recall은 cloud current에 연결한다. 과거 expectedRevision은 current.revision으로 확인하고 cloud version CAS도 수행한다. 후보 검토에 대한 기존 사람 승인 경계를 보존한다.
- 이관 전 성공 요청의 재전송은 남겨 둔 SQLite requestId/hash 영수증부터 확인해 원래 결과를 읽기만 한다. cloud 새 mutation으로 중복 저장하지 않으며 다른 payload의 ID 재사용은 거부한다(`src/metaCommonMemoryStore.ts:86`).
- 호환 recall은 archived 제외 → explicit exclude/include 우선 → category 정확한 NFC 매치 → active/contested만 검색이다 (`src/metaCommonMemoryContract.ts:95`, `src/metaCommonMemoryStore.ts:127`). dormant 원본 member는 삭제·다른ID 치환하지 않는다.
- goal published pin 조회는 기존 revisionId/goalVersion을 따른다. 호환 지식 hit와 goal item은 kind/출처/버전을 표시하고 중복 전달하지 않는다. cloud 장애 시 stale 로컬 정본으로 조용히 회귀하지 않는다.
- 프로젝트 상세·bundle은 portableKnowledge.current.members의 현재 include를 기억 identity로 해석한다. goal-only는 기존 sourceMemoryIds를 기본 연결 투영으로 사용한다. source가 0이어도 현재 두 연결을 표시하고, unavailable/uninitialized에는 init 없이 상태만 반환한다.
- 기존 bundle preview 최대16을 유지한다. legacy 연결이 더 많으면 전체 연결 수·페이지·명시적 subset 선택을 제공하고 자동으로 앞16개만 복제하지 않는다. 수동 accepted 지식은 별도 recall channel이며 이번 단계에서 가짜 project revision으로 goal evidence를 만들지 않는다.
- 등록 프로젝트가 uninitialized/unavailable이더라도 기존 member ID/출처는 보존한다. migration이 prepare-project·initializeProjectMemory·memoryId 생성·CORE 쓰기를 호출해서는 안 된다 (`api-server.ts:5993`, `:6009`).
- NHCS 실제 이관 대상은 parent 관측 `d14813cf-a25d-48fb-8c35-03b85261b25e` revision1/active4/member2다. 이것은 본 worker의 live 검증 결과가 아니다.
- 사람 지정 현재 대상: marketplace port `3ea092ae-8498-48de-adb5-08c4bf83df12`/memory `1eb621cd-79c2-46fa-bf38-dd6c2a9a9657`, usher port `0951a853-9fd7-4bdb-be7e-ee856c0ceb92`/memory `3c880ef4-46b6-5731-b388-ad79bf29ef88`; source snapshot의 old usher `3fbdfd1a-dab4-5c6a-99e6-9cf22546d865`는 provenance에 남긴다.
- 따라서 exact 두 현재 member로의 변경은 별도 명시적 assignment로 current에만 반영하며 snapshot의 old usher를 현재 usher와 병합하지 않는다. 별도 goal 설정 없이 4 active를 candidate 또는 goal publication으로 변환하지 않는다.
## Bounded Context와 표시 계약
- 공통기억 context는 accepted 지식·현재 연결·goal 검토를 관리한다. 프로젝트 장기기억은 독립 root/CORE를 유지하고 SDK candidate는 선택 근거만 읽는다.
- 공유 이름은 canonical memoryId→display_name을 읽으며 로컬 폴더명과 독립이다. 기존 alias 계보만 정체성 전달에 사용한다 (`src/projectMemoryDirectory.ts:614`, `:637`, `:688`).
- karaoke/song 동명 그룹, stale DEV 단말 70839979는 root의 실제 조사 전 합병·삭제하지 않는다. 이름/role/device 상태는 memory identity가 아니다.
- role 저장 계약은 ops/dev/managed 유지, SDK는 catalog가 확인된 별도 표시 투영이다. unknown은 역할 확인 필요로 표시한다 (`src/projectRole.ts:7`, `:24`, `:45`).
- OPS 선택은 agent/surface별 지원 mode/bypass만 저장하며 preference가 권한을 부여하지 않는다. desktop Codex/Hermes/agy bypass는 지원하지 않는다 (`src/opsLaunchOptions.ts:3`).
- `AiConnectionEvidence`는 설정 검사와 실제 MCP 호출 성공(agent/profile/surface/호출시각/도구)을 구분한다. configured는 실행 증명이 아니다 (`src/controlProfileConnections.ts:68`, `:121`).
- QA3 archived는 기본 active 목록·추천·새 적용에서 숨기되 보관 필터에서 읽기·복구 가능하다. cleanup은 archive이며 hard delete가 아니다.
## 유비쿼터스 언어 용어집
| 정본 용어 | 의미·권위 |
|---|---|
| CommonMemory / CommonMemoryUnified | 통합 cloud Aggregate / schema1 additive 제안; groupId 기준 |
| PortableKnowledge | 불변 이관 snapshot+현재 호환 지식 뷰; 확정성과 goal review 분리 |
| GoalMemory | 기존 flat goal·evidence·review·publication 필드 묶음 |
| CommonMemoryMembership | 명시 include/exclude 및 category 적용; evidence sources와 별개 |
| LegacyMigrationPlan / Receipt | exact scope/source/target preview / durable handoff 사실 |
| CommonMemorySelection | 실제 게시 revision/goalVersion 선택; recall은 적용 성공이 아님 |
| SdkReuseCandidate / SdkSourceEvidence | 검토·실검사·사람 승인할 구현 후보 / 코드+기억 hash 근거 |
| AiConnectionEvidence / SDK projection | 실제 연결 증거 / managed role 위의 catalog 기반 표시 |
## 가정 목록·우려와 briefing_correction
- **높음/높은 확신**: 현행 1~16 source RPC로 독립 지식 이관 불가. additive portableKnowledge 분기·field-loss guard가 필요하다 (`src/commonMemorySql.ts:64`, `:67`). v2/null goal은 설치 iPhone745/MCP의 non-null goal 전제와 충돌하므로 미선택 대안이다(parent 관측).
- **높음/높은 확신**: ID 불일치 원본 연결을 현재 ID로 조용히 치환하면 계보 훼손. 위 current 두 대상은 parent 전달 승인, 실제 fresh registry 검사는 구현 단계의 조건이다.
- **높음/중간 확신**: prepared fence/구형 writer·cloud unknown 처리는 설치 기기에서 미검증. 원본 보존과 쓰기 보류가 필수이며 trigger/backup 원자성 검사는 architecture·test의 책임이다.
- **중간/높은 확신**: duplicate snapshot/current 때문에 일부 정상 legacy head도 combined1MB를 넘을 수 있다. 실제 NHCS 먼저, 초과는 명시 blocked; 전체 history cloudrewrite로 확대하지 않는다.
- **중간/높은 확신**: 현재 SDK는 status/prepare/recommend까지다. synthesis/HTML candidate/humanApproval/target apply는 새 제안 (`api-server.ts:4656`, `src/sdkProjectManagement.ts:32`).
- **briefing_correction**: HEAD e0818efe 확인. status는 최초 두 문서 외 API/OPS 소스·테스트도 진행 중이며 owner 변경을 건드리지 않았다. OPS persistence는 현재 source에서 지원 options 확장이 확인되어 기존 미수정 버그로 보고하지 않는다.
- **briefing_correction**: legacy 최대 entry 조합이 실제 모두 저장된다는 해석을 수정했다(실제512KiB head). missing 파일 `src/agentstozUseMcp.ts`를 근거로 사용하지 않았다.
- **미검증 경계**: live NHCS/current membership/QA3/실제 MCP heads는 parent 관측이다. 이 worker는 코드 읽기와 이 문서 작성만 했으며 tester reconcile·테스트·SDK/DB/원본기억 쓰기를 수행하지 않았다.

