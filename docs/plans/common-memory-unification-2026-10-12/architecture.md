# 아키텍처: 공통기억 통합·안전한 이관·SDK 개선 후보

> ✅ 확정 아키텍처: schema1 additive 통합 cloud + 기존 6테이블 + 보존 이관 fence + SDK 후보/대상별 영수증 (arch-choice 체크포인트, auto default)

## 개요
기존 React/Bun 함수 모듈에 네 논리 레이어를 적용한다. 디렉터리 재편·새 프레임워크·자동 프로젝트 전체 수정은 도입하지 않는다. 이 문서는 추가 구현 설계이며 구현·DB 적용·실기 검증 완료를 뜻하지 않는다.
`hitl: auto` — 아래 옵션 1을 계획 기본값으로 선택한다. 설계 승인 질문은 없으며 SDK 후보 승인과 대상 적용은 제품의 별도 명시 행동으로 유지한다.
도메인 명칭과 Repository 시그니처의 정본은 같은 폴더의 `domain-analysis.md`다. 부모가 전달한 실기·라이브 관측은 코드 확인과 구분하며 원본·SDK 작업트리는 수정하지 않는다.

## 핵심 설계 결정
**옵션 1 권장:** 단일 schema1 `CommonMemoryUnified`의 additive 확장 + 기존 클라우드 6테이블의 최소 RPC guard + 이관 전 SQLite 보존 + 등록 SDK의 후보/영수증 저장. UI와 클라우드 편집 정본은 하나이며 지식 승인 상태와 목표 검토 상태는 각각 유지한다.
| 옵션 | Domain | Application | Interface Adapters | Infrastructure | 이득·비용 |
|---|---|---|---|---|---|
| 1 기본값 | `CommonMemoryUnified`, `PortableKnowledge`, `SdkReuseCandidate` | 기존 공통기억 조율 + 이관·SDK 후보 유스케이스 | 단일 공통기억 패널·호환 MCP·등록 대상 해석 | 기존 6테이블 additive RPC guard·SQLite fence·SDK 작업트리/영수증 | non-null goal 구조 유지; goalConfigured와 지식/목표 의미·총 JSON 예산의 엄격 분리가 필요 |
| 2 확장 대안 | 같은 Aggregate + 지식/연결 저장 포트 분리 | 동일 유스케이스 + 페이지 단위 연결/항목 commit | 동일 UI + 서버 검색/페이지 어댑터 | 별도 지식/연결 테이블·FK/CAS/RLS migration | 큰 집합 검색에 유리하나 현재 작은 NHCS 이관에 추가 테이블·트랜잭션 비용; 정상 데이터가 1MB를 지속 초과하거나 indexed 검색 실측이 필요할 때 재평가 |
| 3 형식 대안·미선택 | 같은 의미를 schema2/nullable goal로 구분 | schema1 변환·schema2 유스케이스 | 명시 feature/version negotiation·구형 client 업데이트 오류 | schema1/2 check·RPC downgrade guard | 목표 부재 표현이 명확하나 iPhone745/MCP의 goal.objective 접근과 충돌; 원격 reader까지 먼저 교체해야 하므로 이번 단계에는 채택하지 않음 |
옵션 1의 네 레이어 파일 목록은 아래가 Wave 2의 구현 기본값이다. 옵션 2는 대량 데이터 근거가 생길 때 채택하며 지금 선택하지 않는다.

## Domain
`src/commonMemory.ts`를 확장하고 `src/commonMemoryMembership.ts`, `src/sdkReuseCandidate.ts`의 순수 타입·검증·상태 전이를 작은 함수로 둔다. 외부 DB·파일·React·실행기는 import하지 않는다.
정본 제안: `CommonMemoryUnified = CommonMemory & {portableKnowledge?:PortableKnowledge;goalConfigured?:boolean}`. schemaVersion1과 non-null goal을 유지해 기존 reader의 구조 접근을 보존한다.
정본 제안: `PortableKnowledge={snapshot:MetaCommonMemory; sourceFingerprint:string; importedAt:string; current:MetaCommonMemory}`. `snapshot`은 이관 원본이며 불변, `current`만 cloud CAS로 편집한다.
`GoalMemory`는 기존 flat `goal/goalVersion/sourceMemoryIds/items/sourceHeads/publication`의 논리 필드셋이다. 새 legacy-only 이관은 objective=`description||name`의 정규 goal과 `goalVersion:1, goalConfigured:false, sourceMemoryIds:[], items:[], sourceHeads:[], publication:null`이다. 설명 투영은 목표 검토 완료가 아니다.
`CommonMemoryMembership`의 include/exclude/categoryRules는 `current.members/categories`의 의미를 보존한다. 목표 원본 선택 1..16개와 적용 프로젝트 연결 최대 2000개는 다른 집합이다. exclude가 category 자동 연결보다 우선한다.
wire 항목 상태는 `active | candidate | contested | superseded`다. 사용자 표시 ‘승인됨’은 active를 가리키며 목표별 `reviewed`·게시·검사 통과로 승격하지 않는다. legacy 회상은 active/contested와 원본 ID·revision을 돌려준다.
순수 goal create/configure는 기존 원본 1..16개·verified heads·goalVersion 규칙을 유지한다. 0개 sources는 호스트가 검증한 `portableKnowledge` 지식 분기에만 허용한다. `goalConfigured:false`는 검색/수정/호환 회상 대상이며 새 게시 추천·publication binding 대상은 아니다.
root와 snapshot/current의 ID는 같다. root의 name/archived와 current를 함께 CAS commit하고 지식·연결 변경은 current.revision도 검사·증가한다. 미초기화 등록은 persisted member UUID를 dormant로 보존해 ready/uninitialized/unavailable로 표시하며 CORE·새 memoryId를 만들지 않는다.

### Repository Interface — 도메인 정본 그대로 인용
```ts
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
`CommonMemoryCommit={scopeId,groupId,expectedVersion,requestId,requestHash,state:CommonMemoryUnified}`; `CommonMemoryOperationKey={scopeId,groupId,requestId,requestHash}`; `CommonMemoryCommitReceipt={...key,version,stateHash,replayed}`.
`CommonMemoryQuery={query,archived:'active'|'archived',after:string|null,limit:number}`; `Page<T>={items:T[],next:string|null,truncated:boolean}`. cursor·limit는 서버가 제한하며 클라이언트 입력으로 budget을 늘리지 못한다.
`LegacyMemorySource={snapshot:MetaCommonMemory,sourceFingerprint,historyCount}`; `LegacyMigrationKey={groupId,scopeId,requestId}`; `LegacyMemoryRevision={revision,operation,createdAt,payload:MetaCommonMemory}`. 원본 history는 read-only 페이지로 조회한다.

## Application
`common-memory-server.ts`는 goal·지식·membership 조율을 유지하고, 신규 `common-memory-migration-server.ts`와 `sdk-reuse-server.ts`에 이관·SDK 작업을 분리한다. DB 트랜잭션 안에서 AI·Git·테스트를 실행하지 않는다.
| 유스케이스 정본 | 입력·결과 | 핵심 경계 |
|---|---|---|
| `PreviewLegacyMigration` | `previewLegacyMigration({localGroupId,scopeId,assignments}) -> LegacyMigrationPlan` | 호스트 readonly snapshot·현재 클라우드 CAS·등록 ID를 다시 해석; 실제 이관 전 무변경 |
| `ExecuteLegacyMigration` | `executeLegacyMigration({plan,requestId}) -> LegacyMigrationReceipt` | 원본 fingerprint 재확인 → local prepare/fence → cloud CAS/receipt → 전체 hash readback → handoff |
| `ReadLegacyMigrationStatus` | `legacyMigrationStatus({groupId,scopeId,requestId})` | 결과 조회만; 타임아웃/없음이 새로운 실행 또는 fence 해제를 허용하지 않음 |
| `RollbackLegacyMigration` | matching receipt·명시 withdrawal | cloud archive/withdrawal의 CAS readback 후에만 원래 로컬 authority 재개; 자동 rollback 없음 |
| `PrepareSdkReuseCandidate` | 목표·명시 등록 source IDs·SDK ref | 제한된 코드/기억 비교 후 재사용 후보 실제 코드·문서·demo 생성; 원본 수정 없음 |
| `ReviewSdkReuseCandidate` / `TestSdkReuseCandidate` | exact candidate version/hash | diff·의존성·실제 시험 결과를 후보에 결속; 비교/분석만으로 성공 표시 금지 |
| `ApproveSdkReuseCandidate` / `ApplySdkReuseCandidate` | human decision·정확한 대상·snapshot | 승인 범위·해시·target version 검증, 한 대상 한 durable receipt로 적용 |
`LegacyMigrationPlan={groupId,scopeId,expectedLocalRevision,expectedCloudVersion,sourceFingerprint,assignments,knowledgeCounts,payloadBytes,status:'ready'|'blocked',reason?}`; `LegacyMigrationReceipt={groupId,scopeId,requestId,sourceFingerprint,state:'prepared'|'cloud-committed'|'handed-off'|'conflict'|'unknown',committedVersion?,committedHash?}`.

### 이관의 실행·복구 경계
1. 서버가 `localGroupId`로 source snapshot을 재구성하고 group/entry/member ID·state·categories/tags·timestamps·body·include/exclude를 비교한다. 공개 fingerprint나 임의 snapshot body는 권한 증명이 아니다.
2. SQLite/WAL을 함께 반영한 일관된 원본 backup을 owned staging에 만들고 historyCount/head hash를 보존한다. 전체 과거 revision을 클라우드로 재작성하지 않는다. 복구 원본 경로는 모바일 DTO로 내보내지 않는다.
3. 짧은 SQLite immediate transaction에서 원본 revision/fingerprint를 다시 확인하고 `migration_fences`와 해당 group의 groups/members/revisions write triggers를 함께 설치한다. 현재 DB user_version2만 올리는 방법은 대기 중 구형 writer를 막지 못하므로 금지한다.
4. prepared fence 뒤 로컬 항목/연결 쓰기는 차단하고 cloud RPC에 같은 scope/group/request/hash와 expectedVersion을 전달한다. 동일 요청은 replay, 내용·scope 변경은 conflict; 동일 ID의 다른 cloud group은 덮어쓰기/이름 합병하지 않는다. 이관 전 mutation 재전송은 `replay`로 원본 영수증의 성공 결과만 반환한다.
5. cloud commit·operation receipt는 한 트랜잭션이다. 전체 `stateHash`와 immutable snapshot/current의 원본 보존 항목을 readback으로 확인한 뒤 local handoff를 완료한다. readback 실패는 fence와 원본을 유지하고 unknown을 표시한다.
6. 앱 재시작·권한 폐기·네트워크 단절 후에는 저장된 key로 status만 조회한다. receipt not-found는 아직 진행 중 commit의 부재를 증명하지 않는다. 수동 재시도도 원래 request/hash만 사용한다.
7. handed-off group의 기존 local API/MCP 호환 읽기는 cloud `current`로 라우팅한다. cloud unavailable은 명시 오류 또는 ‘이관 전 사본’ read-only 표시이며 별도의 로컬 편집 정본을 만들지 않는다.
8. `projectSources`·bundle·상세는 PK.current.members의 explicit include를 별도 해석한다. sources=[]인 current2도 표시하며 >16 members는 전체 개수/페이지를 보인 뒤 사용자가 선택한 ≤16 subset만 preview한다. 제외·미초기화·head 없음은 명시 상태이며 verified goal source를 꾸며내지 않는다.
실제 NHCS group `d14813cf-a25d-48fb-8c35-03b85261b25e` rev1/active4/member2는 부모 라이브 관측이다. original old Usher `3fbdfd1a-dab4-5c6a-99e6-9cf22546d865`는 snapshot에서 보존한다.
사용자가 지정한 현재 Marketplace port `3ea092ae-8498-48de-adb5-08c4bf83df12` / memory `1eb621cd-79c2-46fa-bf38-dd6c2a9a9657`, Usher port `0951a853-9fd7-4bdb-be7e-ee856c0ceb92` / memory `3c880ef4-46b6-5731-b388-ad79bf29ef88`는 fresh 등록 확인 후 current membership에 명시 반영한다. old/current Usher 사이 alias·기억 합병을 생성하지 않는다.

### SDK 후보 생성·검토·적용
`SdkReuseCandidate`의 정본 필드는 candidateId/version/sdkProjectRef/sdkMemoryId/goal/sourceProjectRefs/evidence/artifacts/review/testReceipt/humanApproval/targetApplications이며 상태는 proposed/reviewed/tested/approved/needs-review다. 적용은 후보의 applied 상태 대신 target별 receipt로 표시한다.
목표와 source IDs를 서버에서 해석한 뒤 `SdkSourceEvidence={projectRef,memoryId,gitHead,code:[{relativePath,hash}],memory:[{revisionId,entryId,contentHash}]}`로 고정한다. 선택 source≤4·code evidence≤32·캡처≤512KiB이며 현재 dirty SDK/Cdp는 보존하고 등록 SDK owned staging/worktree에서 실제 implementation을 만든다.
비교는 제한된 파일/byte manifest를 사용하고 `.env`·credential·raw transcript·symlink·등록 외 경로를 제외한다. 초과 시 선택 범위를 좁히도록 요청하며 조용히 잘라 ‘전체 비교 완료’로 표시하지 않는다. 생성 AI의 provider·model은 실제 실행기에 확인된 값만 기록한다.
후보 코드·의존성 lock·safe HTML 설명·demo와 manifest hash를 함께 저장한다. 문서는 등록 SDK의 `docs/reuse/<candidateId>/index.html`에 둔다. HTML만 생성하면 implementation 미완료다. iframe sandbox/CSP로 네트워크/상위창/credential 접근을 막고 artifact URL은 서버 allowlist manifest로 해석한다.
실제 test 실행의 checkId/명령 정책/exitCode/출력 hash·시간·code hash가 없으면 `not-run`이다. 시험 실패·미실행·근거 부족은 그대로 표시하고 재검토하게 한다. ‘최선’·모든 프로젝트 적용을 자동 선언하지 않는다.
승인은 사람의 명시 action에서 서버가 발급한 exact candidate/test/artifact hash·선택 target IDs의 token이다. AI가 자신의 후보를 승인하거나 임의 success-report로 token을 만들지 못한다. 변경된 후보는 기존 승인을 무효화한다.
적용 직전에 target의 실제 root identity·memoryId·HEAD·dirty fingerprint·후보 version·권한을 workspace lease 아래 다시 확인한다. 한 target씩 변경 manifest와 before/after hash를 journal에 준비하고 CAS를 만족하는 파일만 쓴다. target dirty 변경은 충돌로 보존한다.
disconnect/restart 뒤 applied/failed/unknown의 durable receipt를 조회한다. unknown은 자동 적용·다음 target 이동을 하지 않는다. 원래 요청의 수동 재시도만 동일 fingerprint 결과를 재사용한다. 기존 module prepare v0.2 API·catalog·receipt의 의미는 유지한다.

## Interface Adapters
`src/commonMemoryRequest.ts`/client를 동일 strict 계약으로 확장하고 `src/CommonMemoryPanel.tsx` 하나에 검색·복수 체크·지식/목표/연결/이력 표시를 둔다. 기존 별도 editable `MetaCommonMemoryPanel` 노출은 통합 패널로 교체한다.
신규 `src/CommonMemoryLinks.tsx`, `src/sdkReuseRequest.ts`, `src/SdkReusePanel.tsx`를 작은 컴포넌트/요청 변환으로 두며 `App.tsx`, `api-server.ts`, `agentstoz-use-mcp-server.ts`에는 좁은 import·dispatch 연결만 추가한다.
| 제안 endpoint/adapter | 요청 요지 | 서버 결과·권한 |
|---|---|---|
| POST `/api/common-memory/list` / `inspect` / `knowledge-recall` | scoped query 또는 group/task/project ref | 활성 기본 목록·페이지·명시 상태; cloud read authority |
| POST `/api/common-memory/manage` | 기존 goal operation + knowledge/member operation·CAS/key | 하나의 cloud record commit; cloud manage |
| POST `/api/common-memory/migration-preview` / `migration-execute` / `migration-status` | 위 정본 plan/key | host local read + cloud write + owner-bound status; raw snapshot 받지 않음 |
| POST `/api/common-memory/project-links` | listed registered project ref | 이름·목표·게시·재검토·관리 shortcut·dormant 상태; 로컬 path 없음 |
| 기존 `/api/meta-common-memory`·`agentstoz_use_*meta*` | 기존 read/recall/history 형식 | handed-off는 cloud current로 변환; 목표 evidence/publication fabrication 금지 |
| POST `/api/sdk-project/reuse-{prepare,review,test,approve,apply,status}` | sdk ref·exact version/hash·request key·선택 target | 같은 SDK use case dispatcher; 기존 status/prepare/recommend는 그대로 |
모바일은 기존 암호화 common-memory transport/pool을 재사용한다. 기존 non-null goal 구조는 읽기 crash를 막고 새 기능 미지원은 업데이트 안내로 표시한다. PK 전체가 빠진 구형 저장은 거부하며 client의 임의 입력을 host migration으로 간주하지 않는다.

### Authority·이름·역할
| 동작 | 필요한 경계 | UI 통합이 부여하지 않는 권한 |
|---|---|---|
| legacy read + cloud 이관 write | `meta-memory.manage`와 `common-memory.manage`를 각각 확인 | 하나의 grant를 다른 것으로 승격하지 않음 |
| cloud 지식/goal 관리 | 현재 cloud scope·manage·CAS | project clone·terminal·memory init |
| project Clone/등록·binding | 기존 `projects.add` + exact root; binding은 project `memory.save` | legacy member 편집 권한만으로 파일 쓰기 |
| SDK candidate prepare/test | 현재 등록 SDK·명시 source read·허용 실행 | source 수정·대상 자동 적용 |
| SDK approve/apply | authenticated human approval + exact target write/execution authority | OPS bypass·callerName·설정 존재만으로 승인 |
shared project displayName은 기존 canonical memory label로 투영하고 folder basename은 각 기기에 남긴다. 이름이 같은 karaoke/song 그룹은 ID/검증된 계보 증거 없이 합치지 않는다. stale DEV device `70839979`의 진단/정리는 root가 수행한다.
persisted `ops/dev/managed`는 유지하고 확인된 SDK catalog+memoryId로 SDK navigation facet을 추가한다. OPS·DEV·관리·SDK 표시의 의미를 명확히 하며 UI role은 기억 ID/권한이 아니다.
OPS mode/bypass preference·checkbox·unsupported desktop 안내는 현재 root 변경에 이미 추가됐다. 단일 browser-safe capability helper를 UI/백엔드가 공유하고 실제 실행에서 재검증한다; Codex/Hermes/agy desktop은 지원하지 않는 옵션을 적용하지 않는다.
MCP 상태는 설정 존재 / 설치 launcher의 bounded stdio probe / 실제 client context에서 서버가 관측한 read-only invocation을 구분한다. `clientInfo.name`은 caller-supplied이므로 인증된 provider 증거로 사용하지 않는다. 시간·build·config fingerprint만 보관하고 비밀·자동 AI 실행을 넣지 않는다.

## Infrastructure
`src/commonMemorySql.ts`와 정식 imperative migration에서 기존 6테이블/schema1을 유지한다. RPC가 PK structure·snapshot/current 동일 ID·goalConfigured를 검증하고 0-source는 host-validated 지식 import에만 허용한다. 기존 PK 누락·불변 snapshot 변경·goalConfigured 손실을 DB에서도 명시 차단한다.
게시 RPC/ready/recommend/bind는 goalConfigured!==false·실제 검토 항목·verified source heads를 요구한다. 이번 단계의 portable accepted 지식을 project revision evidence로 바꾸는 기능은 없으며 원래 승인/회상 의미로만 보존한다. 현재 Usher의 없는 Supabase head를 생성해 메우지 않는다.
knowledge/member 변경 이력은 기존 operations.result에 bounded before/after delta·compat revision·stateHash를 함께 보존하고 publication revisions에는 기존 목표 게시본만 둔다. 기존 request_hash만으로 수정 전 본문을 복원할 수는 없다. migration 이전 전체 이력은 원본 SQLite에 보존하므로 새 cloud history 테이블은 필요 없다.
전체 snapshot+current+goal/evidence JSON은 1MB 한도다. 정상 legacy head는 기존 Store가 512KiB로 제한한다. 한도 초과는 명시 blocked+원본 보존이며 entries/member ID·body/state를 절삭하지 않는다. 지식 항목/멤버·goal 항목/게시본·보고는 각각 페이지와 전체 escaped JSON 예산을 지킨다.
Supabase는 기존 member-read RLS와 localhost 서버 write를 유지한다. service_role은 sidecar만 사용하고 새 RPC도 `SECURITY INVOKER`+불필요한 EXECUTE revoke를 따른다. 외부 client에 새 credential이나 직접 write 통로를 추가하지 않는다.
SQL commit은 group lock→정렬된 source-head lock의 기존 순서를 유지하며 receipt를 함께 쓴다. local SQLite fence/backup, provider run, Git/workspace lease, SDK files는 network RPC와 다른 짧은 commit 경계로 분리한다.
기존 transfer의 4000 escaped bytes·request600KiB·result2MiB·8 global/4 owner·5분 TTL을 늘리지 않는다. migration body는 호스트에서 읽으므로 작은 plan/key만 전송; immutable snapshot 전체는 wire에서 제외하고 current/list/member를 페이지화해 escaped JSON≤350KB로 제한한다. 영수증은 pool TTL과 별개로 보존한다.
SDK 후보 구현/문서/manifest는 등록 SDK의 Git에 운반 가능하게 두고 host 실행 receipts·승인 token·root path는 app-data의 owned durable store로 분리한다. 다른 Mac clone/pull은 후보 검토 가능함을 뜻하며 그 Mac에서 test/prepare 완료를 뜻하지 않는다.
의존성: React/HTTP/MCP → strict DTO → Application → Domain/Repository ports ← Supabase/SQLite/SDK adapters. 기본 DI는 기존 create* 함수의 injected deps로 구현한다. 새 class framework·상시 scheduler·일괄 변경 queue는 필요 없다.

## 디자인 시스템 영향도
공통기억은 장기기억과 같은 깊이의 현재 탭을 유지하고 검색어·복수 선택·선택 개수·include/exclude/category 상태를 한 화면에 표시한다. 필터로 숨겨진 선택은 남기며 ‘보관함’은 별도 filter로, root가 보관한 QA 3그룹은 정상 목록에서 숨기고 복구 가능하게 둔다.
프로젝트·폴더 상세에 공통기억 이름/목표(미설정 포함)/publication/review 상태·관리 바로가기를 공용 컴포넌트로 표시한다. target/group scope가 바뀌면 draft·pending request를 분리해 이전 group에 저장하지 않는다.
기존 `--surface/--line/--ink/--danger` token, 16px 입력·44pt touch, 키보드 focus/ARIA·상태 텍스트를 유지한다. 검토 필요·승인·unknown은 색상만으로 구분하지 않고 좁은 iPhone에서는 한 열과 접는 상세를 사용한다.

## 근거·우려·briefing_correction
| 항목 | severity/confidence | 근거·영향 |
|---|---|---|
| 최소 schema 확장 필요 | 높음/높음 | `commonMemorySql.ts:7,64-68,83-100`, `common-memory-server.ts:21`은 schema1/원본1..16/실제heads만 허용; 무근거 goal/pub 생성으로 import할 수 없음 |
| 구형 writer·unknown fence | 높음/높음 | `metaCommonMemoryStore.ts:41-42,94-121`의 version 검사와 mutation 시점이 다름; prepare DB trigger와 deferred old-connection 검증이 구현 필수 |
| legacy provenance·회상 | 높음/높음 | `metaCommonMemoryContract.ts:2-15,95-99`, `metaCommonMemoryStore.ts:123-146`은 goal source와 다른 membership/state/회상 의미 |
| SDK evidence workflow 미구현 | 높음/높음 | `sdkProjectManagement.ts:16-57`, `api-server.ts:4656-4670`, MCP `84,473-474`는 catalog/status/prepare/recommend이며 synthesis/approval/apply를 제공하지 않음 |
| UI 검색·보관·링크 보강 | 중간/높음 | `App.tsx:14648`의 로컬 별도 details, `CommonMemoryPanel.tsx:38,50` 목록/원본 체크; 통합 검색·archived 기본 filter·shared link 필요 |
| 이름/역할·MCP 증거 과장 방지 | 높음/높음 | `projectMemoryDirectory.ts:614-642,688,908`, `projectRole.ts:5-7,32-65`, `controlProfileConnections.ts:64-94`, MCP `828-833` |
briefing_correction: HEAD e0818efe는 확인했지만 조사 시점 root가 API/OPS UI/preference/tests/helper를 변경 중이었다. 이 delta는 기저 오류로 재보고하지 않는다. legacy 실제 저장 state는 active이며 accepted는 표시 표현, 정상 head는 512KiB 제한이다. 기존 256×12KB 타입 상한만으로 정상 group>1MB라 추정하지 않는다.
확인하지 않은 사항: 실제 NHCS cloud write/readback·구형 동시 writer 차단·candidate 실제 code/test·human approval token·대상 적용·iPhone/MCP 실기. 이번 역할은 코드 읽기와 이 문서 작성만 수행했다.
