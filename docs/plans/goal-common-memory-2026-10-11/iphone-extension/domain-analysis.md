# 도메인 분석: iPhone·MCP 목표별 클라우드 공통기억 확장

## 개요와 확정 범위

`CommonMemory`는 기존 원본 프로젝트 기억에서 목표에 맞는 규칙을 검토·게시하는 클라우드 집합이다. 이번 확장은 같은 집합을 Mac 최상위 메뉴, iPhone의 기존 WKWebView, 실제 MCP에서 조회·관리하고, 연결된 원본 프로젝트가 특정 Mac에 있는지 확인하여 개별 Clone·복원·등록하는 기능이다. 기존 로컬 `meta-common-memory`는 별도 저장소·기능·권한으로 유지한다.

총괄이 확정한 프로젝트 생성 정책은 **current source membership Clone-only**다. 미게시 초안에서도 `sourceMemoryIds`의 현재 구성 프로젝트를 가져올 수 있다. 미리보기에는 **현재 연결된 원본 프로젝트**라고 표시한다. 구성 프로젝트를 가져오는 행위는 선택한 그룹의 목표·게시본을 적용하는 행위가 아니다. 새 공통기억의 적용은 기존 `ProjectCommonMemoryChoice`와 명시적인 연결 동작으로 수행한다. 따라서 `CommonMemoryProjectPlan`에 게시본 `revisionId`가 없다는 사실만으로 오류로 판정하지 않는다.

관찰 기준은 worktree `/Users/gwanli/.codex/worktrees/goal-common-memory-publish/AgentsToZ_byCS`, HEAD `05164f9a`, 2026-10-11이다. 아래의 진행 중 계약은 `git status --short`에서 수정·미추적 상태로 관찰한 구현이며 출하 완료 증거가 아니다. 도메인 문서만 작성했고 앱 코드·테스트·기억·설정은 수정하지 않았다.

## 액터 (Actors)

| 액터 | 책임과 허용 범위 |
|---|---|
| 사용자 | 목표·원본·검토 근거·게시·적용할 공통기억·작업 루트·Clone 계획을 명시적으로 선택한다. |
| Mac host | 현재 클라우드, 등록 프로젝트, 실제 폴더·Git origin·memoryId와 권한을 재검증하고 작업을 실행한다. |
| iPhone 사용자 | 승인한 host의 암호화 workspace 연결로 같은 서비스를 사용한다. 브라우저의 현재 상태는 실행 권한이나 완료 증거가 아니다. |
| MCP 호출자 | 실제 목록·상세·추천·회상·관리·프로젝트 가져오기 도구를 호출한다. 추천 결과만으로 선택 동의를 만들지 않는다. |
| 클라우드 기억 저장소 | 원본 head·GitHub 메타데이터, 공통기억의 CAS 상태·불변 게시본·기존 프로젝트 binding을 제공한다. |
| GitHub 저장소 | 원본 프로젝트 소스를 Clone한다. 저장소 접근 성공, 원본 기억 복원, 프로젝트 등록, SDK 준비는 각각 다른 결과다. |

## 유스케이스 목록

1. **InspectCommonMemory**: 같은 cloud scope의 목록·목표·원본·검토 상태·적용 근거를 제한된 페이지로 조회한다. 미지원 host, 부분 조회, 원본 접근 실패를 빈 목록으로 표현하지 않는다.
2. **ConfigureCommonMemory**: 목표 또는 원본 구성을 바꾸면 `goalVersion`을 증가시키고 해당 규칙을 재검토 대상으로 만든다. 이름만 바뀐 경우와 구분한다.
3. **ReviewCommonMemoryItem / PublishCommonMemory**: 실제 원본 항목과 hash를 확인하여 이유·조건을 검토하고 현재 목표·source heads의 불변 게시본을 만든다.
4. **SelectCommonMemory**: 프로젝트 목표에 대한 추천은 후보다. 사용자가 선택한 `CommonMemorySelection`을 생성·연결 직전에 다시 확인한다. 목표 변경은 추천 선택을 다시 확정하게 하며 기존 작업 pin을 자동 변경하지 않는다.
5. **PlanCommonMemoryProjects**: 선택한 그룹의 현재 `sourceMemoryIds`를 실제 로컬 기억·origin과 비교하여 모든 구성 프로젝트의 present/missing/conflict/unavailable 정보를 표시한다. GitHub 주소 누락은 unavailable의 이유·안내로 구분한다. 초안은 허용한다.
6. **AddCommonMemoryProject**: 계획에서 missing인 원본 하나를 명시적인 `memoryId`로 지정하고 Clone·기억 복원·등록한다. 호출 한 번은 구성 프로젝트 하나만 실행하고 영수증과 남은 상태를 돌려준다.
7. **ReadCommonMemoryProjectReceipt**: 중단·응답 유실·권한 철회 후 기존 요청 결과를 읽는다. 알려지지 않은 결과를 실패로 단정하거나 새 요청으로 자동 실행하지 않는다.
8. **RestoreOriginalProjectBinding**: 새 단말에 동일 원본 프로젝트의 기존 목표와 과거 pin이 있다면 정확한 binding을 복원한다. 새 그룹의 목표나 최신 게시본으로 치환하지 않는다.
9. **PrepareSdkProject**: 같은 원본 저장소의 SDK catalog를 유지하고 해당 Mac의 준비 상태를 별도로 확인한다. Clone 성공으로 모든 SDK 모듈 준비 완료를 표시하지 않는다.

## 도메인 모델

### Aggregate: CommonMemory (기존)

Root Entity는 `CommonMemory`이고 ID는 기존 UUID `id`다. 영속 상태의 CAS `version`은 `CommonMemoryRecord`에 있고, 목표 의미의 `goalVersion`과 게시본 ID는 서로 다른 값이다. 원본 프로젝트의 `memoryId`를 그룹 ID로 바꾸지 않는다.

- 속성: 기존 `name`, `goal`, `goalVersion`, `sourceMemoryIds`, `items`, `sourceHeads`, `publication`, `archived`를 유지한다 (`src/commonMemory.ts:7-15`).
- 원본은 1~16개이고 선택 그룹은 최대 8개다. 원본 중복은 `memoryId`로 정규화한다. 표시명으로 합치지 않는다 (`src/commonMemory.ts:32`, `common-memory-server.ts:139-142`).
- 목표·source membership 변경 시 `goalVersion` 증가, source heads 초기화, 기존 규칙 `needs-review`가 적용된다 (`src/commonMemory.ts:38-42`).
- 게시에는 현재 목표 버전의 reviewed 규칙과 source heads 일치가 필요하며 게시본은 복제된 목표·근거·항목을 갖는다 (`src/commonMemory.ts:73-77`).
- 목표별 새 적용에는 현재 ready 게시본이 필요하지만 과거 `revisionId`를 명시한 회상은 기존 pin을 유지한다 (`common-memory-server.ts:123-129`).
- `sourceMemoryIds`가 동일하더라도 source head·GitHub 주소가 바뀌면 기존 프로젝트 가져오기 계획의 입력과는 다르다.
- `CommonMemoryGoal`은 공통 규칙 선별 목표이고 구성 원본 프로젝트의 자체 목표를 대신하지 않는다.

Value Objects는 기존 `CommonMemoryGoal`, `CommonMemorySourceHead`, `CommonMemorySelection`, `CommonMemoryEvidence`다. `CommonMemorySelection`의 식별 단위는 group/revision/goalVersion와 해당 cloud scope다. `CommonMemorySourceHead`의 revision/hash는 원본 입력 검증이고 그룹 게시본 revision과 혼동하지 않는다.

Domain Events는 `CommonMemoryConfigured`, `CommonMemoryPublished`, `CommonMemoryProjectAdded`로 개념만 정의한다. 기존 action·영수증의 결과가 사건의 근거이며 별도 event bus·outbox·DB 재편을 요구하지 않는다. `CommonMemoryProjectAdded`는 같은 원본 기억 복원과 등록까지 확인된 경우다.

### Value Object: CommonMemoryProjectPlan (추가 경계)

진행 중 `src/commonMemoryProjects.ts:3-6`의 명칭을 유지한다. 계획은 `schemaVersion`, `groupId`, `version`, `goalVersion`, `scopeId`, `workspaceRootId`, `rootIdentity`, `members`, `planHash`를 갖는다. `CommonMemoryProjectSource`는 `CommonMemorySourceHead`와 `name`/`githubUrl`의 결합이고 `CommonMemoryLocalProject`는 등록 ID·확인한 memoryId/origin·접근 가능 상태다.

- 계획의 의미는 현재 source membership이다. 게시 readiness나 그룹 게시본은 Clone-only의 선행조건이 아니다.
- 모든 구성 원본의 source head/hash, canonical GitHub metadata, group CAS version/goalVersion, cloud scope, root identity, member 목록을 계획 hash에 고정한다.
- 실행 직전에 같은 host가 다시 읽어 비교한다. 새 구성원, 계보 합병, scope/root 변경, GitHub 주소 변경은 계획 재확인이 필요하다.
- 이미 완료된 구성원에 따른 로컬 상태 변화는 해당 계획의 durable 영수증과 실제 등록/폴더 identity가 일치할 때만 진행 결과로 인정한다. 다른 작업이 만든 변화와 혼동하지 않는다.
- `rootIdentity`는 검증용 값이고 권한이 아니다. 절대 경로·명령·credential·실제 등록 port ID를 원격 계획에 노출하지 않는다.
- GitHub 주소는 기존 `parseGitCloneRequest`의 canonical 주소로 제한한다 (`src/gitCloneRequest.ts:52-59`).

`CommonMemoryProjectMember.status`는 기존 네 가지 값 present/missing/conflict/unavailable을 유지한다. no-repository는 unavailable의 구조화된 이유 또는 message로 구분하며 별도 status를 추가하지 않는다 (`src/commonMemoryProjects.ts:5,13-20`).

| status | 판정 근거 | 사용자에게 제공할 정보 |
|---|---|---|
| `present` | 등록 폴더의 검증된 memoryId가 원본과 같고 실제 폴더에 접근 가능 | 이미 있는 프로젝트; cloud 주소와 실제 origin이 달라지면 주소 갱신 확인 안내 |
| `missing` | 동일 memoryId의 등록이 없고 안전한 저장소·작업 루트·폴더 이름에 충돌 없음 | 원본 프로젝트 하나의 Clone·기억 복원·등록 제안 |
| `conflict` | 같은 저장소에 다른 기억이 결속되거나 중복 source repo·폴더 충돌·불일치 origin이 있음 | 충돌 원인과 확인 대상; 자동 계보 합병·기존 폴더 사용 없음 |
| `unavailable` | canonical GitHub 주소가 없거나 등록 폴더·원본 metadata 조회를 완료하지 못함 | no-repository 이유라면 원본 GitHub 주소 추가·갱신 안내; 조회 실패라면 해당 원인과 재확인 안내. 존재하지 않는 것으로 간주하지 않음 |

`present`는 등록·identity의 상태이고 source hash가 최신이라는 뜻은 아니다. 기존 프로젝트에 자동 Git pull, 원본 CORE 교체, 프로젝트 목표 변경, 최신 pin 연결을 실행하지 않는다. 주소 안내는 사용자 선택을 돕는 정보이며 자동 remote 변경 명령이 아니다.

### Aggregate: CommonMemoryProjectReceipt (추가)

외부 Git·로컬 파일·클라우드 복원·등록은 단일 DB 트랜잭션으로 묶을 수 없다. 따라서 영수증의 최소 일관성 경계는 **인증된 실행자 + cloud scope + requestId + planHash + 선택한 member memoryId**다. 사용자 명시 동작마다 원본 하나를 선택하여 side effect 전에 영수증을 예약한다. source 최대 16개 범위를 유지한다.

```ts
type CommonMemoryProjectReceipt = {
  schemaVersion: 1;
  requestId: string;
  scopeId: string;
  groupId: string;
  planHash: string;
  memberMemoryId: string;
  step: 'reserved' | 'cloned' | 'restored' | 'registered';
  outcome: 'pending' | 'complete' | 'blocked' | 'failed' | 'unknown';
  message: string;
  remaining: Array<{memoryId: string; status: CommonMemoryProjectMember['status']}>;
};
```

위 타입은 안전한 공통 결과 projection이다. host 내부에는 owner·폴더 identity·등록 identity·복원 revision/hash를 durable하게 함께 보관하되 원격 DTO로 내보내지 않는다. 실패가 발생해도 확인한 `step`을 지우지 않는다. 다음 구성원 진행과 동일 구성원의 재시도는 구분해야 한다.

- 같은 requestId+memoryId+plan 입력 재전송은 이미 선택한 member의 기존 영수증만 replay한다. 완료 member를 재Clone하거나 응답 유실 재전송만으로 다음 member를 시작하지 않는다. 같은 요청 ID에 다른 member나 계획을 넣으면 거부한다.
- 미확정 member는 같은 요청·member·계획·identity로 영수증을 조회하거나 replay하여 결과를 확인한다. 재전송을 새로운 실행 명령으로 해석하지 않으며 자동 재시도는 하지 않는다.
- 다음 member의 명시적 Continue는 그 member의 `memoryId`와 새 요청 ID를 전달한다. 동일 member의 결과 확인과 다음 member의 진행은 확정된 wire 계약에서 구분된다.
- Clone 완료 뒤 원본 기억 복원이 실패하면 폴더를 새 소유물로 간주해 반복 Clone하지 않는다. 영수증이 소유·origin·기억을 증명한 경우에만 복원을 재개한다. 기존 사용자 폴더를 덮어쓰거나 삭제하지 않는다.
- 새 시도는 이미 점유된 target을 채택하지 않는다. 복구는 같은 prior server receipt의 projectId와 directory identity가 일치하는 자기 materialized 폴더에만 허용한다. 같은 origin/memoryId가 있다는 사실만으로 폴더 소유를 얻지 않는다.
- Clone 이후에도 source head·cloud·group 상태를 다시 확인한다. 그 사이 source가 바뀌면 기억 복원·등록을 계속하지 않고 needs-review/partial로 표시하며 자기 materialized 폴더와 영수증을 보존한다. 원본 변경의 영향을 이전 기준으로 성공 처리하지 않는다.
- 등록 전에 복원된 memoryId가 해당 member의 원본과 정확히 같은지 확인한다. 원격 백업 부재/identity mismatch는 새 기억 push/init로 대체하지 않는다.
- `pullProjectMemory` 내부의 canonical origin 기반 config 준비는 기존 복원 경로의 일부다. 별도 신규 기억 생성·초기 Push fallback과 구분한다 (`project-memory-server.ts:6167-6197`).
- 호스트는 권한 철회 후 새 side effect를 시작하지 않는다. 이미 시작한 저장/등록이 완료됐는지 모르는 경우 client outcome은 unknown이며 failure나 rollback 완료로 표현하지 않는다.

## Repository

이 섹션이 문서간 포트 시그니처 정본이다. 클래스·테이블 재편은 요구하지 않으며 기존 함수형 서비스를 유지한다. 실제 코드 추가 전 타입명과 wire operation의 단일 의미를 맞춘다.

```ts
// 기존 서비스의 시그니처를 그대로 재사용하는 구조형 포트.
type CommonMemoryRepository = Pick<
  ReturnType<typeof createCommonMemoryService>,
  'get' | 'list' | 'inspect' | 'action' | 'recommend' | 'recall' |
  'report' | 'selections' | 'bind' | 'history' | 'catalog' | 'projectSources'
> & {
  // 기존 cloud binding의 정확한 목표·과거 pin 조회만 추가 제안.
  binding(projectMemoryId: string, scopeId?: string): Promise<{
    projectMemoryId: string;
    projectGoal: string;
    selections: CommonMemorySelection[];
    version: number;
  } | null>;
};

type CommonMemoryProjectRepository = {
  projectsPlan(input: {
    groupId: string; workspaceRootId: string;
  }): Promise<CommonMemoryProjectPlan>;
  projectsAdd(input: {
    plan: CommonMemoryProjectPlan; requestId: string; memoryId: string;
  }): Promise<CommonMemoryProjectReceipt>;
  projectReceipt(input: {
    scopeId: string; requestId: string; memoryId: string;
  }): Promise<CommonMemoryProjectReceipt | null>;
};
```

`catalog(after?: string | null)`와 `projectSources(groupId: string)`는 진행 중 서비스 추가 함수이며 실제 반환은 같은 cloud scope에서 읽는다 (`common-memory-server.ts:68-79,152`). 기존 `inspect(id: string, offset?: number)`, `selections(groupIds: string[], expected?: CommonMemorySelection[])`, `recall(groupId, task, revisionId?, scopeId?)`, `bind(projectMemoryId, projectGoal, selected)`는 기존 계약을 유지한다. 위 Repository는 새 독립 저장소 클래스가 아니라 HTTP/MCP/mobile이 공유할 호출 경계다.

`projectsPlan`은 읽기이고 `projectsAdd`는 별도 `projects.add` 권한으로 보호된다. 실행은 입력 `memoryId`가 계획의 missing member와 정확히 같은지 확인한다. `projectReceipt` 조회는 인증된 owner의 scope/requestId/memoryId 결속을 검증하며 requestId를 아는 것만으로 다른 실행자의 결과를 읽을 수 없다. 영수증 조회 operation은 HTTP/MCP/mobile에서도 같은 member key를 보존한다.

`binding`은 새 단말의 **기존 원본 binding 복원**에만 사용한다. `selections`는 새 최신 선택의 검증이므로 과거 pin 복원에 사용하지 않는다. `installProjectCommonMemory`는 정확한 saved revision을 회상하여 원본 CORE 외부에 선택 문서를 쓰는 기존 함수다 (`common-memory-server.ts:155-192`). 복원은 새 `bind` write나 새 그룹 적용을 호출하지 않는다. `null` binding은 정보 부재이고 pin 해제 동의가 아니다. 기존 local 목표/pin이 있으면 덮어쓰지 않으며 cloud와 다르면 차이를 표시한다.

## 도메인 서비스와 경계

- `createCommonMemoryService`: 같은 cloud client/scope, source 검증, CAS·request hash 영수증, 검토·게시·회상·binding을 담당한다. 원본 기억을 쓰지 않는다 (`common-memory-server.ts:23-27,62-66,88-115`).
- `planCommonMemoryProjects` / `validateCommonMemoryProjectPlan`: 전달받은 안전한 source/local metadata로 member와 계획 hash를 만든다. 파일 시스템 효과나 권한 승인을 수행하지 않는다 (`src/commonMemoryProjects.ts:7-30`).
- 프로젝트 가져오기 host 경계: 기존 Clone의 staging·parent lease, `pullProjectMemory`, `registerExistingAgentsToZUseProject`를 순서대로 재사용하되 member identity·영수증·revalidate를 조율한다 (`api-server.ts:2807-2828,23709-23757`; `project-memory-server.ts:6157-6267`).
- `createCommonMemoryClient`: UI/SDK transport 주입 경계다. iPhone은 고정 localhost URL 대신 기존 암호화 transport를 주입한다 (`src/commonMemoryClient.ts:2-15`; `src/CommonMemoryPanel.tsx:7`).
- `MetaCommonMemoryRemoteHost`: cloud/meta 구분을 유지한 bounded upload/execute/read/release 전송을 재사용한다. 임시 transfer는 durable 실행 영수증을 대신하지 않는다 (`src/metaCommonMemoryRemoteHost.ts:16-27,30-34,58-74`).
- `SdkProjectManagement`: Git에 있는 catalog와 relative paths는 휴대 가능한 입력이며 기기별 준비 결과는 별개다. `.agentstoz/sdk-project.json`과 origin을 검증하고 기존 memoryId를 유지한다 (`src/sdkProjectManagement.ts:6,16-35`).

Bounded Context는 목표별 cloud 공통기억, 원본 프로젝트 기억, 단말 프로젝트 등록/Git, 로컬 메타 기억, SDK 준비로 구분한다. 앞의 네 경계는 identity와 안전한 metadata를 교환하며 저장소·권한을 합치지 않는다. 공통기억 goal은 Shared Kernel 데이터 계약이지 다른 원본 프로젝트 지침의 우선권을 바꾸는 권한이 아니다.

## Mac·iPhone 표시의 도메인 제약

Mac의 공통기억은 장기기억과 같은 top-level 진입점으로 제공하는 설계를 검토한다. 기존 `TopLevelTab`에는 memory만 있고 local meta panel은 그 아래 있으므로 두 기능의 이름·경로를 명확히 구분해야 한다 (`src/App.tsx:1580-1581,14604-14607`). 프로젝트 만들기의 '공통기억으로부터 만들기'는 여러 원본의 개별 상태·현재 작업 루트·이번에 실행할 member·남은 구성원을 보여준다.

cloud/mobile 목표 관리의 feature/target은 `goal-common-memory-v1` / `goal-common-memory`, 권한은 `common-memory.manage`다. Clone·등록은 추가 `projects.add`, 기존 로컬 meta는 `meta-memory.manage`다. 터미널 grant나 source 등록만으로 cloud 전체 관리나 Clone 동의를 만들지 않는다 (`src/commonMemoryRequest.ts:2-3`; `src/mobileWorkspaceProtocol.ts:12-17,57-78`).

기존 input `text-sm`, button `min-h-10`은 모바일 목표 16px 입력·44pt 조작에 미달할 수 있다 (`src/CommonMemoryPanel.tsx:9-10`). 크기는 UI 목표이며 실제 WKWebView의 확대·키보드·스크롤·읽기 순서·foreground 상태 확인으로 입증한다. fixture 성공이나 시뮬레이터 성공은 production pairing과 연결 권한 성공을 대신하지 않는다. 기존 transfer의 4KB wire, 600KiB request, 2MiB response, host8/owner4, 5분 TTL을 공유한다 (`src/metaCommonMemoryRemoteProtocol.ts:5`). 서버 전체 데이터/전체 state를 그대로 원격에 보내지 않고 페이지·bounded projection을 사용해야 한다.

## 가정 목록과 우려·미해결 항목

| 항목 | 상태·severity·confidence | 근거와 필요한 처리 |
|---|---|---|
| Clone-only/current membership·draft 허용·새 capsule 자동 적용 없음 | 확정 설계 / 높음 / 높음 | 이번 wave에서 총괄이 전달한 root의 명시 결정. 게시 readiness 요구를 Clone 선행조건에 추가하지 않는다. |
| source memoryId·CORE·자체 목표·과거 pin 유지 | 확정 요구 / 높음 / 높음 | 작업 계약 및 `common-memory-server.ts:155-192`; 원본 읽기와 선택 사본 분리. |
| Git ignored 목표/pin의 새 Mac 복원 | 구현 공백 / 높음 / 높음 | `common-memory-server.ts:178-180,196-198`은 Git 제외, :145-149는 binding 쓰기만 제공. Clone+CORE pull만으로 목표/pin 휴대성 완료를 주장할 수 없다. 위 `binding` read/restore 경계 필요. |
| cloud binding이 없는 원본의 목표/pin | 미해결 데이터 가용성 / 중간 / 높음 | 현재 cloud binding 조회 미제공 및 Git 제외 증거. 원본 기기에만 있는 값은 추정해 복원하지 않고 정보 부재로 표시한다. |
| 호출당 one-member와 동일 요청 재전송/다음 member 진행 구분 | 확정 계약·검증 필요 / 높음 / 높음 | root의 명시 member 계약 `{plan,requestId,memoryId}` + 기존 CAS/request conflict 계약 `common-memory-server.ts:88-98`. 같은 ID+member는 기존 영수증 replay, 다음 member는 새 ID. owner/scope/request/member 결속을 실제 MCP·remote에서도 확인한다. |
| 점유 target 소유와 Clone 후 source-change | 필수 실행 guard / 높음 / 높음 | 기존 Clone의 target 부재·staging 보장 `api-server.ts:23709-23757`, source head 확인 `common-memory-server.ts:40-60`. 신규 시도 occupied target 채택 금지; 복구는 prior server receipt+projectId+directory identity 결속. Clone 후 변경은 partial로 보존한다. |
| unavailable의 no-repository 이유 | 확정 계약·안내 검증 필요 / 중간 / 높음 | `src/commonMemoryProjects.ts:5,15`의 기존 네 상태 유지. UI/실제 MCP는 unavailable의 이유·message로 GitHub 주소 누락과 폴더 조회 실패를 구별한다. |
| 현재 입력은 cloud 최신 source heads | 확인됨 / 중간 / 높음 | `common-memory-server.ts:40-60,75-78`; 미Push 로컬 편집은 cloud source 입력으로 간주하지 않는다. |
| ready 소실·goal 변경 후 기존 task pin 유지 | 확인됨 / 높음 / 높음 | `src/commonMemory.ts:38-49`; `common-memory-server.ts:123-142`; 과거 binding 복원에서 최신 `selections` 호출 금지. |
| 실제 연결된 iPhone은 iPhone13ProMax, iOS26.3 | UNVERIFIED 실기 정보 / 중간 / 중간 | 부모 전달 및 `../IPHONE-PLAN.md:3`. 본 분석은 device query·실제 화면 검사를 수행하지 않았다. 기본 iPhone13의 화면 결과로 확대 해석하지 않는다. |
| 현재 WKWebView/fixture 검사는 production 동의를 증명 | 부정한 추론 금지 / 높음 / 높음 | `mobile/ios/App/LANWorkroomView.swift:193-199`는 WKWebView 존재만 증명. 실제 pairing·scope 승인·권한 철회·응답 유실은 별도 실행 증거가 필요하다. |
| SDK 전체 플랫폼 준비 완료 | UNVERIFIED / 중간 / 높음 | `../EXECUTION.md:29-35`는 common-memory-sdk 준비와 기존 모듈 manual-module을 구분. 이번 분석은 실제 다른 Mac/SDK 실행을 하지 않았다. |
| remote 페이지/작업 수명 | 구현 검토 필요 / 중간 / 높음 | `common-memory-server.ts:29-38,80-86`의 내부 최대2000 목록/전체 state와 `src/metaCommonMemoryRemoteProtocol.ts:5`의 TTL/response 상한. bounded domain 결과와 host 서비스 전체 반환을 구분한다. |

## briefing_correction

- HEAD `05164f9a` 설명의 'mobile legacy만 지원'은 진행 중 작업tree에 대해서는 오래된 설명이다. 현재 파일에는 cloud target/feature, `common-memory.manage`, `projects.add`, shared cloud transfer 경로가 추가되어 있다 (`src/commonMemoryRequest.ts:2-3`; `src/mobileWorkspaceProtocol.ts:12-17`; `src/metaCommonMemoryRemoteHost.ts:27,58`). 검증·출하 완료는 확인되지 않았다.
- inspect는 진행 중 구현에서 `offset`을 제공하면 source 20개·application10개로 제한하고 count/nextOffset을 돌려준다. offset을 생략하면 전체 source·application100개를 유지하므로 '전부 해결'로 표현하지 않는다 (`common-memory-server.ts:80-86`).
- '선택 게시본 검증이 모든 프로젝트 Clone의 선행조건'은 root 결정으로 정정된다. Clone-only는 current membership이며 source/group/cloud/root/계획 검증을 한다. 게시본 검증은 새 goal-specific 적용/연결에 필요하다.

## 유비쿼터스 언어 용어집

| 정본 용어 | 의미와 사용 제한 |
|---|---|
| `CommonMemory` / 목표별 클라우드 공통기억 | 목표와 복수 원본 기억에 기초한 규칙 집합. local meta 기억의 동의어로 사용하지 않는다. |
| `CommonMemoryGoal` | objective/include/exclude/conditions/checks/sdkModules를 갖는 선별 목표. 원본 프로젝트 자체 목표와 별개다. |
| `goalVersion` | 목표·source membership 변경의 의미 버전. CAS `version`이나 Git commit과 다르다. |
| `CommonMemoryRecord.version` | cloud state 수정의 CAS 버전. 실행 미리보기의 group 상태 고정 값이다. |
| `sourceMemoryIds` | 해당 그룹에 현재 연결된 원본 기억 ID 목록. 프로젝트 이름이나 원격 port ID 목록이 아니다. |
| `CommonMemorySourceHead` | 원본 memoryId/revisionId/contentHash의 정확한 읽기 기준. 그룹 publication ID와 구분한다. |
| `CommonMemoryPublication` / 게시본 | 검토된 목표·source heads·규칙을 고정한 기존 불변 snapshot. |
| `CommonMemorySelection` / pin | groupId/revisionId/goalVersion/scopeId로 고정한 적용 선택. 자동 latest 갱신 없음. |
| `CommonMemoryApplication` / 적용 기록 | 정확한 게시본·항목에 대한 관찰/통과/실패/미적용 근거. 회상이나 보고된 passed가 검사 실행 인증은 아니다. |
| `CommonMemoryProjectSource` | 프로젝트 가져오기에 필요한 검증된 source head·표시명·canonical GitHub 주소. |
| `CommonMemoryLocalProject` | host가 등록과 실제 기억/origin/접근 가능성을 확인한 로컬 프로젝트 비교 입력. |
| `CommonMemoryProjectMember` / 구성 프로젝트 | 공통기억의 원본 하나와 해당 단말의 네 상태 present/missing/conflict/unavailable·Clone 폴더 이름·확인 안내. no-repository는 unavailable의 이유다. |
| `CommonMemoryProjectPlan` / 프로젝트 계획 | current source membership, cloud/root identity와 원본·주소를 고정한 읽기 결과. 실행 권한이 아니다. |
| `CommonMemoryProjectReceipt` / 프로젝트 영수증 | 특정 요청·계획·member의 확인한 side effect 단계와 결과. transfer의 rpcId/임시 buffer와 다르다. |
| `CommonMemoryRepository` | 기존 createCommonMemoryService 함수와 정확한 기존 binding 조회를 표현한 구조형 포트. 새 DB/class tree를 뜻하지 않는다. |
| `CommonMemoryProjectRepository` | projectsPlan/projectsAdd/projectReceipt를 공유하는 최소 host 함수 경계. |
| `projectsPlan` / `projects-plan` | 현재 연결된 원본 프로젝트를 비교하는 읽기 동작. |
| `projectsAdd` / `projects-add` | 승인한 계획의 `memoryId` 하나를 명시하여 Clone·원본 기억 복원·등록하는 동작. 같은 ID+member는 replay, 다음 member는 새 ID. |
| `projectReceipt` | 인증된 owner의 scope/requestId/memoryId에 결속된 기존 결과 조회. 다음 member 실행 동의가 아니다. |
| `binding` / 기존 원본 연결 | 원래 프로젝트 memoryId에 저장된 자체 projectGoal·selections·version의 조회 결과. 새 공통기억 적용과 구분한다. |
| `meta-common-memory` / 로컬 메타 공통 기억 | 기존 Mac별 local meta 저장소·기능. 별도 meta-memory.manage 권한을 유지한다. |
| `scopeId` | 현재 cloud 연결을 구분하는 hash. 같은 group/memory UUID의 다른 cloud 오사용을 차단한다. |
| `SDK 관리 프로젝트` | 원본 기억·repository·relative module catalog를 보존하는 기존 등록 프로젝트. 기기별 준비 결과를 복제하지 않는다. |

## 완료 보고

Aggregate 2개(기존 `CommonMemory`, 최소 추가 `CommonMemoryProjectReceipt`), 유스케이스 9개, 기존 핵심 Value Object 4개와 추가 계획 Value Object 1개, 개념 Domain Event 3개를 정의했다. Repository 시그니처와 용어집은 이 문서가 정본이다. 코드·DB·테스트·기억 변경이나 실제 기기/MCP 검증은 수행하지 않았다. Clone-only 정책·명시 member wire·네 status는 확정됐으며 binding 휴대성·member 영수증 결속·remote bounded projection의 실제 구현 검증이 남아 있다.
