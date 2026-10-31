# 공통기억 — 장기기억(memoryId) 위의 공유 지식

공통기억은 여러 프로젝트가 함께 쓰는 지식 묶음이다. 연결 단위는 프로젝트가 아니라 **장기기억(memoryId)** 이다 —
메인 체크아웃과 워크트리가 한 장기기억을 함께 쓰므로, 공통기억은 그 장기기억에 붙고 그 기억을 쓰는 모든 등록 폴더가 같은
지식을 본다. 공통기억은 프로젝트 전용 기억·OPS 기억의 정체성을 바꾸지 않고, 프로젝트를 지우거나 이름을 바꿔도 지워지지 않는다.

> 이 문서는 예전에 「이 기기의 SQLite가 정본」이라고 적혀 있었다. **지금은 클라우드가 정본이다.** 로컬 SQLite는 아래
> 「로컬 저장소」의 조건에서만 쓰인다.

## 정본과 연결

- **정본은 클라우드 표 `portmgr_common_memories`** 다(한 행 = 공통기억 하나, `state` jsonb). 지식은
  `state.portableKnowledge.current`에 있고, 연결은 그 안의 `members: [{memoryId, name, mode:'include'|'exclude'}]`다.
  변경 이력은 `portmgr_common_memory_operations`에 남는다. 서비스는 `common-memory-server.ts`의 `createCommonMemoryService`.
- **연결 형식은 둘이다**(`parseMetaMemoryRequest`, `src/metaCommonMemoryContract.ts`):
  - 새 형식 `{memoryId, mode}` — 장기기억을 직접 고른다. 클라우드에만 있는 장기기억도 연결된다. 저장 전에
    `memoryTargets(ids)`가 클라우드에서 **새로**(카탈로그 캐시를 쓰지 않고) 확인한다 — alias·휴지통·없는 기억은 거절.
  - 옛 형식 `{portId, expectedMemoryId, mode}` — 이 Mac의 등록 프로젝트 카드로 고른다. 아직 클라우드에 올라가지 않은
    장기기억(방금 만든 프로젝트)은 이 형식만 검증된다. 두 형식을 한 항목에 섞거나 다른 키를 더하면 거절한다.
  - 화면은 `memberForm:'memory'`(클라우드 `read`가 알려 준다) 또는 호스트 능력 `memory-members`일 때만 새 형식을 쓴다.
    로컬 그룹은 새 형식을 `META_MEMORY_CLOUD_REQUIRED`로 거절하므로 프로젝트 카드 형식으로 보낸다
    (`linkNewProjectCommonMemories`, `src/commonMemoryEntrypoints.ts`).
- **이름 하나에 id 하나**(`normalizeMetaMemoryVocabulary`): 지식 요청에서 `groupId`는 공통기억 그룹, `memoryId`는 장기기억이다 —
  recall `{memoryId, query}`, `assignments[].memoryId`, `evidence[].memoryId`, 그리고 `groupId`가 있을 때 save-entry/propose-entry의
  `memoryId`(출처 장기기억 = `sourceMemoryId`). 그룹을 최상위 `memoryId`로 부르던 원래 형식은 `groupId`가 없을 때 그대로 받는다(옛 휴대폰·호스트).
  `groupId`와 다른 그룹을 가리키는 `memoryId`는 거절한다.
- **카테고리는 보조 규칙이다.** 회상할 때 「이 Mac에서 그 장기기억을 쓰는 등록 폴더」의 카테고리가 그룹의 `categories`와
  맞으면 적용된다. 명시적 include/exclude가 카테고리보다 우선한다(`metaMemoryApplies`). 카테고리 편집칸은 이미 카테고리가 있는
  그룹에서만 보이고, 명시적 연결을 권한다. 라이브 데이터에는 카테고리가 0개다.

## 회상 — 한 경로, 1회 조회

세 입구가 같은 회상을 쓴다: 프로젝트 기억 회상(`POST /api/project-memory/recall`의 `commonMemory`, 세션 정리 문맥),
MCP `agentstoz_use_recall_common_memory`, 휴대폰. 끝은 모두 `common-memory-migration-server.ts`의 `recall(memoryId, query, category)`다.

| 단계 | 하는 일 |
|---|---|
| 권한 | `registeredMemoryCategory`(`src/projectMetaMemoryContext.ts`) — 이 Mac에 등록된 폴더(메인 또는 워크트리)가 그 폴더 자체(realpath)이거나, 식별 캐시로 같은 정본 memoryId로 풀릴 때만 그 줄의 카테고리를 돌려준다. 아니면 `null` |
| 조회 | `knowledgeForMember(memoryId, category)` — `members`에 대한 **JSON 포함 조건 한 번**(`.filter('state->portableKnowledge->current->members','cs',JSON.stringify([{memoryId,mode:'include'}]))`). 카테고리가 있으면 별도 읽기 하나를 **병렬로** 더한다. 15초 캐시, 이 모듈의 쓰기가 비운다 |
| 마감 | `COMMON_MEMORY_RECALL_DEADLINE_MS` = 6초. 넘으면 `COMMON_MEMORY_RECALL_TIMEOUT`(504) |
| 예산 | 8개 항목 · 32개 그룹 · 16 KB(`rebudgetRecall`). 넘으면 `truncated` |

- **비용**: 클라우드 1회 왕복, 그룹별 `get` 0회, 목록 읽기 0회(`tests/common-memory-recall-bridge.test.ts`). 로컬 저장소는 울타리
  없는(unfenced) 로컬 그룹이 있을 때만 연다. 이 저장소에서 프로젝트 회상 한 번은 중앙값 220 ms → 22 ms(문서 1회 읽기,
  reader 1회 호출, 전체 detect 대신 identity만).
- **memoryId 하나로는 아무것도 열리지 않는다.** 이 Mac 어디에도 등록되지 않은 장기기억은 명시적 include 멤버여도 회상하지
  않는다. 워크트리만 등록된 경우는 식별 캐시로 같은 기억이 확인되므로 회상한다. 식별 캐시의 TTL만큼 늦을 수 있다.
- **실패는 이유를 말한다**(기존 `error` 필드, 새 키 없음 — `commonMemoryRecallFailure`): `META_MEMORY_PROJECT_UNAVAILABLE`(등록 안 됨),
  `COMMON_MEMORY_CLOUD_REQUIRED`(클라우드 설정 없음), `COMMON_MEMORY_CLOUD_UNAVAILABLE`(연결 실패), `COMMON_MEMORY_RECALL_TIMEOUT`,
  `COMMON_MEMORY_SCOPE_CHANGED`. 어느 경우에도 프로젝트 전용 기억은 그대로 돌아온다. 음성의 프로젝트 회상은 `includeCommon:false`로 reader를 부르지 않는다.
- JSON 포함 조건을 PostgREST가 이해하지 못하면(`PGRST100`·`22P02` 등) 필터 없는 페이지 순회로 한 번 내려가고, 보관된 행은
  건너뛰며 계속 읽는다 — 보관된 행이 살아 있는 그룹을 밀어내지 않는다.

## 클라우드 읽기의 비용

- **원본 기억 읽기(`sources`)**: 64개마다 alias·휴지통·head를 한 번에 읽고, revision은 한 번(hash/meta) 또는 내용이 필요하면
  8개씩 읽다가 2 MB 예산에서 멈춘다. 16개를 읽는 데 순차 왕복 3회 이하. 입력 순서대로 걸으며 예전 id별 체인과 **같은 첫 오류**를 낸다.
  alias 행이 보이면 그 id만 `portmgr_resolve_project_memory_id` RPC에 묻는다 — 자기 자신을 가리키는 alias·순환·깊은 사슬이
  예전과 똑같이 실패한다(PGlite에서 실제 SQL 함수와 대조, `tests/common-memory-batching.test.ts`).
- **캐시와 쓰기**: 모든 쓰기와 명시적 비우기가 세대(`cacheGeneration`)를 올린다. 읽기는 시작할 때의 세대가 그대로일 때만 결과를 캐시에
  넣는다 — 쓰기 전에 시작해 쓰기 뒤에 끝난 읽기가 옛 연결을 TTL(지식 15초·카탈로그 30초) 동안 되살리지 않는다(`tests/common-memory-cache-race.test.ts`).
- **카탈로그**: 고르는 화면은 새로 읽고 30초 범위 캐시를 갱신한다. `catalogAll`·주제 발견·워크룸 초안·`project-names`가 그것을 쓴다.
- **revision 캐시**: 파싱한 revision 8개 · 60초 · 8 MB(LRU). head가 그대로면 다시 받지 않는다.
- **목록 페이지**: `listPage`는 size+1행 한 번. 체인 마감은 `withCommonMemoryDeadline`(기본 20초, 읽기마다 15초).

## 주제 발견 — 같은 교훈 묶음 (2026-11-01)

「교집합·카테고리 후보 확인」과 MCP `recommend_common_memory_topics`(op `topic-candidates`)는 읽기 전용이다. 카탈로그 한 쪽의 원본
8개(또는 고른 `memoryIds` 최대 16개)를 읽고, 한 조회는 500개 항목·2 MB(`COMMON_MEMORY_DISCOVERY_MAX_ENTRIES`·`_BYTES`)에서 멈춘다.

- **방법**(`src/commonMemoryLessonClusters.ts`의 `clusterCrossMemoryLessons`, 순수·결정적): 제목+본문을 정규화(마크다운·코드 블록·경로·URL·
  날짜·id·버전·숫자 제거)하고, 공백을 뺀 문자 n-gram(한글은 3자, 라틴 문자에서 시작하면 5자)의 Jaccard가 `LESSON_CLUSTER_THRESHOLD`(0.1)
  이상인 **다른 장기기억**의 항목끼리 단일 연결로 묶는다. 두 기억 이상에 걸친 묶음만 후보이고, 한 기억 안의 반복은 후보가 아니다. 묶음은 16개까지다.
- **상투문**: 조회한 기억의 75%(최소 4개)에 있는 n-gram은 버리고, 그 때문에 60% 이상을 잃은 항목은 뺀다. 앱이 생성하는 제목(지침 블록 제목,
  `Review remote version:`)은 처음부터 뺀다. 기억이 3개 이하면 비율 규칙이 상투문과 공유 교훈을 구분하지 못하므로 생성 제목 목록만 지킨다.
- **후보 모양은 그대로다** — `key·name·category·sourceMemoryIds·evidence·method·needsSemanticReview`(+ 서버의 `existingGroups`), 키를 더하지 않았고
  MCP 계약(1.39.0)도 그대로다. 이름은 대표 항목(다른 항목과 가장 비슷한 것)의 제목, 분류는 키워드 주제가 항목 절반 이상에 맞으면 그 분류이고 아니면
  「공통 교훈」이다. 근거는 기억마다 한 항목씩 먼저 싣고(최대 16), 원본의 `revisionId`·`entryId`·`contentHash`를 그대로 지녀 `propose-source-entry`에 쓸 수 있다.
- **키워드 주제 7개는 폴백이다** — 그 조회에 같은 교훈이 하나도 없을 때만 예전 정규식 주제(`source-entry-topic-intersection`)가 나온다. 섞으면 넓은 주제가
  구체적인 교훈을 같은 7자리에서 밀어낸다. 후보와 응답 최상위의 `method`(`cross-memory-lesson-cluster` 또는 `source-entry-topic-intersection`)가 어느 쪽인지 말한다.
- **왜 라틴 문자는 5자이고 문턱은 0.1인가**(실측 2026-11-01, 읽기 전용, 기억 103개 중 항목이 있는 48개·1,038항목의 모든 기억 간 쌍): 3-gram만 쓰면
  서로 무관한 영어 항목이 0.20–0.25로 실제 공유 교훈(0.22–0.23)과 같은 높이에 섞여 어떤 문턱도 둘을 가르지 못했다. 지금 방식에서는 무관한 쌍이 0.08 미만이고,
  0.07–0.1 사이에는 같은 교훈(0.069–0.096)과 주제만 같은 쌍(최대 0.093)이 섞이며, 0.1 이상은 같은 절차를 다른 프로젝트에 적은 두 쌍뿐이었다.
  사람이 후보를 모두 읽으므로 정밀도를 택했다. 바꿔 쓴 시험 교훈은 0.19–0.32, 조금 고친 사본은 0.5 이상이다.
- ⚠️ **한계 — 쪽 경계**: 한 번에 그 쪽의 원본만 비교한다. 실측에서 전체를 한꺼번에 비교하면(조회 한도 밖, 오프라인) 묶음이 1개(기억 3개)였지만 그 세 기억은
  memoryId 순서로 15·57·98번째라 어느 쪽에서도 만나지 않았다 — 13쪽 모두 키워드 주제로 돌아가 예전과 같은 41개를 냈다. 범위를 `memoryIds`로 고르면
  그 안에서는 찾는다. 쪽을 넘는 비교(앞 쪽 항목의 n-gram 요약 보관 등)는 다음 단계다.
- 검증: `tests/common-memory-lesson-clusters.test.ts`(한국어·영어 바꿔 쓰기, 무관한 교훈, 모든 기억의 상투문, 같은 기억의 반복, 500개·2 MB 한도와 순서 무관,
  클라우드 서비스의 근거 참조와 쓰기 없음). 폴백 경로는 기존 `tests/common-memory-topics.test.ts`·`tests/common-memory-cloud-topics-ui.mjs`가 지킨다.

## 호스트 디스패치와 능력

`common-memory-dispatch.ts`의 `createCommonMemoryDispatch`가 HTTP·MCP·휴대폰 요청을 받는다(api-server는 연결만 한다).

- `list` 결과 안에 `hostCapabilities`와 `scopeId`가 실린다 — **바깥 봉투가 아니라 안쪽 결과**라 옛 휴대폰은 무시한다.
  능력은 `COMMON_MEMORY_HOST_CAPABILITIES`(`src/commonMemoryCapabilities.ts`): `memory-members` · `recall-by-memory` ·
  `project-links-by-memory` · `compact-inspect` · `lean-read`. 클라이언트는 이것을 보고 새 형식을 고르고, 오류 문구로 짐작하지 않는다.
- 등록 프로젝트 열거는 요청마다 필요할 때 한 번(`lazyProjects`): `list`·`history`·`export`·`archive`·검토·항목 편집은 열거하지 않고,
  `read`·portId 회상·프로젝트 카드 저장만 한다.
- `recall`은 `{memoryId, query}`도 받는다(`{groupId, task, revisionId}`와 배타). 응답에 `mode:'memory'`와 `memoryId`를 돌려준다.
- `project-links`는 `{memoryId}`도 받는다. 라벨·목록·binding·`knowledgeForMember`를 병렬로 읽는다 — binding으로 고른
  이전 방식 그룹도 빠지지 않는다. 휴대폰은 memoryId로만 묻는다(portId·`project-names`·`migration-*`·`bind-project`는 거절).
- `lean-read`: 지식 `read`에 `withProjects:false`를 주면 등록 프로젝트 목록(100개면 약 19 KB, v2 조각 2개 더)을 빼고 열거도 하지 않는다.
  휴대폰만 그 능력을 본 뒤에 묻고, 목록은 「연결할 장기기억」을 펼칠 때 `projects`로 받는다 — 그룹 열기가 v2 **3회**(inspect·read·history).
  옛 휴대폰은 플래그가 없어 예전 그대로다(`tests/common-memory-lean-read.test.ts`).
- 휴대폰의 페이지 `inspect`는 원본 항목을 한 쪽에 5개까지(`COMMON_MEMORY_REMOTE_INSPECT_PAGE_SIZE`), `nextOffset`은 그대로.
- 휴대폰 `list`는 `localPending`(이 Mac의 로컬 그룹 중 울타리가 없고 클라우드에도 없는 수)을 싣는다. 데스크톱은 대신
  `legacyPending`(이관할 로컬 그룹)을 받는다.

## 이전 방식(목표·원본 검토·게시)

목표를 세우고 장기기억 원본을 검토해 게시하는 모델은 **「이전 방식」으로 울타리만 쳤고 지우지 않았다.** 그룹 화면에서
`이전 방식 (목표·원본 검토·게시)` 접힘 칸(`common-memory-legacy`) 하나에 모였고, 그 모델을 가진 그룹(원본·검토 항목·게시가 있는 그룹)에서만
그려진다. 지식만 있는 그룹은 목표·원본·게시 UI를 보이지 않는다. 보관된 목표 그룹은 읽기 전용이다. 만들기에서는 직접 쓰기가 먼저이고
「기존 장기기억에서 가져오기」는 이전 방식으로 표시돼 남아 있다. 동작(op)·testid는 하나도 지우지 않았다. 새 프로젝트 만들기 화면의
목표 선택(`ProjectCommonMemoryChoice`)은 그리지 않지만 export는 남겼고, 호스트는 옛 휴대폰을 위해 `common-memory.bind`를 계속 받는다.

## 로컬 저장소 — 울타리 친 보관소이자 이관 다리

`meta-common-memory-v1/memories.sqlite`(앱 데이터, `src/metaCommonMemoryStore.ts`)는 이제 정본이 아니다.

- 클라우드로 이관한 그룹은 **울타리**(handoff 영수증)가 쳐지고 SQLite 트리거가 쓰기를 `META_MEMORY_CLOUD_AUTHORITY`로 막는다.
  `fenceState()`·`fencedIds()`·`hasUnfenced()`는 모든 페이지를 한 번의 읽기 전용 열기로 본다.
- **데스크톱**: `compatibility()`는 목록 프로브를 하지 않는다 — `legacy()`의 첫 실제 클라우드 읽기가 `COMMON_MEMORY_MIGRATION_REQUIRED`
  (42P01·PGRST205) 또는 `COMMON_MEMORY_CLOUD_REQUIRED`를 내고, **울타리 친 그룹이 하나도 없을 때만** 로컬 저장소로 돌아간다.
  클라우드가 있으면 새 그룹은 클라우드에 만들어지고, 아직 이관하지 않은 로컬 그룹은 이관 전까지 로컬에서 읽고 고친다.
- **휴대폰(「이 Mac의 기억」, `meta-memory-v1`)**: 울타리 친 그룹은 목록에서 빠지고 열면 `META_MEMORY_CLOUD_AUTHORITY`다. 클라우드
  읽기가 실제로 성공하면(`cloudAvailable`) 새 그룹 만들기는 `META_MEMORY_CLOUD_REQUIRED`로 거절된다 — 클라우드가 없거나 마이그레이션 전이면
  로컬에 만든다. 포털은 클라우드 `list`가 성공하고 `localPending`이 0일 때만 이 탭을 숨긴다(`portalLocalCommonVisible`).

## 휴대폰 RPC — v1과 v2

휴대폰 공통기억 요청(클라우드·로컬)은 암호화된 workspace 봉투 안에서 조각으로 오간다(`src/metaCommonMemoryRemoteProtocol.ts`).

| | v1 | v2 (`common-memory-rpc-v2`) |
|---|---|---|
| 조각 | 4,000바이트(escape된 JSON) | 7,600바이트 |
| 흐름 | upload … → execute → read … → release | upload …(마지막 앞까지) → `call`(실행 + 첫 결과 조각) → 남은 `read` |
| 해제 | release 필수 | 마지막 조각을 내준 뒤 스스로 해제, release는 중단·오류 때만 |

- **v2는 Mac이 확장 기능 `common-memory-rpc-v2`를 광고할 때만** 쓴다(`createMetaMemoryRemoteRequester(…,{rpcV2})`). 오류 문구로 내리지
  않고, 잃어버린 `call`은 「불확실」로 남기며 변경 요청을 자동으로 다시 보내지 않는다.
- **실행 전 거절은 「불확실」이 아니다.** v2의 작은 요청은 `call` 한 번이라, 휴대폰이 보내기 전에 거절한 것(오프라인·앞선 요청이 아직 휴대폰에 있음·
  진행 중)과 Mac이 실행 전에 거절한 것(게이트웨이의 허용·요청 한도, 호스트의 전송 한도·조각 검증)을 잃어버린 응답과 구분해야 한다.
  Mac 쪽 실행 전 거절은 오류를 던지지 않고 409 봉투를 담은 한 조각짜리 `result`로 답한다(`metaMemoryRemoteRefusal`) — 던진 오류는 휴대폰에
  문구만 닿아 실행 여부를 알 수 없기 때문이다. 휴대폰 쪽 거절은 그 코드(`REMOTE_CONTROL_PHONE_OFFLINE`·`…_UNSENT_AHEAD`·
  `REMOTE_CONTROL_ACTION_IN_PROGRESS`)로 판정한다. 보관된 봉투(`…_REQUEST_UNSENT`)와 결과를 못 읽은 것은 여전히 불확실이다
  (`tests/common-memory-rpc-v2-refusals.test.ts`).
- **v1은 바이트 그대로다** — 옛 휴대폰이 새 Mac에 붙어도 같은 바이트를 주고받는다.
- 레거시 `protocol.capabilities` 답(8개 상한)에서는 `goal-common-memory-v1`과 함께 이 이름도 뺀다 — 넣으면 `conversations-v1`이 밀려난다.
  확장 답(`protocol.capabilities.extended`)에만 있다. LAN 서버는 광고하지 않는다.
- 최악 escape(따옴표·역슬래시·제어문자)에서도 모든 v2 조각 + workspace 래퍼가 8,500바이트, 릴레이 봉투가 11,000바이트 안이다.
  한 requester의 동시 호출은 차례로 돈다(릴레이가 직렬이다).
- **측정된 왕복**(`tests/common-memory-rpc-v2.test.ts`의 고정 픽스처 — 원본 400개 inspect, 결과 크기에 따라 달라진다):
  첫 화면(list·updates·catalog) v2 **3회** / v1 13회, 그룹 열기(inspect·projects-status·history) v2 **7회** / v1 20회.
  테스트는 v2 상한을 4회·10회로 고정한다.
- 화면 쪽 절약: 패널을 열면 `list`+`updates` 두 요청뿐이고, 휴대폰은 원본을 추적하는 그룹이 없으면 `updates`도 건너뛰며 연결별로 마지막
  목록을 먼저 그린다. 저장 뒤에는 그 그룹만 `inspect`한다(`tests/common-memory-panel-requests-ui.mjs`).
- 권한은 그대로다: 클라우드 공통기억은 `goal-common-memory-v1`, 이 Mac의 로컬 기억은 `meta-memory-v1`이고 둘 다 연결별 허용이 필요하다.
  등록 프로젝트 ID는 기기 연결별 불투명 참조로 바뀌고 경로·자격 증명은 나가지 않는다. 전송 버퍼는 전역 8개 · 연결당 4개 · 5분.

## 입구

- 장기기억 목록의 줄마다 「공통기억」 바로가기(memoryId를 넘긴다)와 위쪽 「공통기억 관리」.
- 프로젝트 화면의 연결 목록(`ProjectCommonMemoryLinks`)은 memoryId로 `project-links`를 묻고, 옛 파서에는 portId로 한 번만 되묻는다.
- `focusMemoryId`는 `project-links` 한 번으로 그 장기기억을 연결한 그룹을 연다(지식 멤버 우선). 없으면 그 기억을 미리 고른 채 만들기를 연다.
  조회가 실패해도 목록은 열린다.
- 새 프로젝트 만들기는 지식 고르기(`MetaCommonMemoryPicker`) 하나만 있다.

## MCP 1.39.0

`AGENTSTOZ_USE_MCP_CONTRACT_VERSION = '1.39.0'`. 공통기억 도구는 **21개**다:
`list_common_memories` · `inspect_common_memory` · `common_memory_history` · `recall_common_memory` · `manage_common_memory` ·
`manage_common_knowledge` · `recommend_common_memories` · `recommend_common_memory_topics` · `list_common_memory_sources` ·
`read_common_memory_source` · `read_cloud_common_memory_source` · `list_common_memory_updates` · `prepare_common_memory_workroom` ·
`record_common_memory_application` · `bind_project_common_memory` · `inspect_project_memory_links` · `plan_common_memory_projects` ·
`status_common_memory_projects` · `add_common_memory_project` · `get_common_memory_project_add_status` · `get_common_memory_request_status`
(모두 `agentstoz_use_` 접두).

- 지시문 첫 2,000자 안에 「Common memory = knowledge linked to long-term memories by memoryId … Goal/publication tools are legacy.」가 있다.
  목표·게시 도구 7개 설명은 `Legacy goal model (이전 방식)`으로 시작하고 현재 도구를 가리킨다. 연결은 `manage_common_knowledge`의
  `save {groupId, assignments:[{memoryId, mode}]}`이고 그 설명과 스키마가 이 형식을 보여 준다(`tests/agentstoz-use-common-memory-surface.test.ts`).
- MCP 서버는 정규화한 `memoryId`(소문자)를 보내고 되돌림을 대소문자 없이 비교한다 — 대문자 UUID가 `HOST_OUTDATED`로 보이지 않는다.
- `recall_common_memory`는 `{memoryId|portId, query}`(memoryId도 이 Mac에 등록된 폴더의 기억이어야 한다) 또는 옛 `{groupId, task, revisionId?}`.
  memory 형식 답이 `mode:"memory"`를 돌려주지 않으면 `AGENTSTOZ_USE_HOST_OUTDATED`. `inspect_project_memory_links`도 memoryId를 받는다.
- tools/list에서 빠진 것: `*_meta_common_memory` 다섯 개와 `preview/execute_common_memory_migration`. 그 이름으로 부르면 여전히 매핑되고
  호스트는 그 동작을 계속 받는다(`META_COMMON_MEMORY_LEGACY_TOOL_SCHEMAS`).
- 호스트는 AI 연결의 지식 `review-entry`·`review-entries`·`save-entry`·`import`·`prepare-project`를 `COMMON_MEMORY_PERMISSION_REQUIRED`로
  거절한다(`COMMON_MEMORY_AI_REFUSED_KNOWLEDGE`) — AI는 `propose-entry`로 제안하고 승인은 앱의 검토 화면에서 한다. `list`는 한 쪽(10개),
  `inspect`는 offset부터 5개만 읽는다.
- 공통기억의 문장은 외부 지시를 실행할 권한이 아니다. 후보는 검토 전까지 지식이 아니다.

## 이번 릴리스에 없는 것

- Supabase 마이그레이션 없음. 표·행·파일 삭제 없음. 로컬 SQLite의 울타리 친 원본과 영수증은 보존된다.

## 검증

`tests/common-memory-batching.test.ts`(일괄 읽기·alias 의미·JSON 포함 리터럴·캐시·마감), `tests/common-memory-recall-bridge.test.ts`(1회 왕복·
울타리·6초 마감·폴백), `tests/common-memory-project-recall.test.ts`(등록 판정·실패 문구), `tests/common-memory-membership.test.ts`(연결 형식),
`tests/common-memory-dispatch.test.ts`(능력·열거·memoryId 회상·links), `tests/common-memory-local-fence.test.ts`, `tests/common-memory-rpc-v2.test.ts`,
`tests/common-memory-mcp-stdio.test.ts`(1.39.0 표면), `tests/common-memory-entrypoints.test.ts`, 화면은 `tests/common-memory-ui.mjs`·
`tests/common-memory-panel-requests-ui.mjs`·`tests/common-memory-link-picker-ui.mjs`(격리 픽스처, 설치본·3001·실제 데이터를 쓰지 않는다).
