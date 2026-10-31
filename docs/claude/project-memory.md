# 프로젝트 장기기억 · 공통기억 · Hermes 명령

## 저장 실패 알림의 진단 동선 (2026-10-29)

- Codex stderr는 CLI 헤더·작업 경로·입력 프롬프트까지 담을 수 있다. `runProjectMemoryAgent`는 실패 출력을
  Error로 넘기지 않고 `projectMemoryAgentOutput`의 고정 문구와 `PROJECT_MEMORY_AGENT_FAILED` 코드만 반환한다.
  성공 출력은 기존 문서/원문 복사 방지 검사를 그대로 통과해야 한다. 프런트도 임의 `error`/`backupError`를 알림에 붙이지 않는다.
- `unsavedSessionMemory`는 충돌·AI 실패·미확정·백업·기타 상태를 분류한다. 로컬 저장 후 백업만 실패한 결과는
  로컬 저장 성공을 유지하면서 확인 대상으로 표시한다. 미확정 저장을 자동 재전송하거나 다음 저장을 시작하지 않는다.
- 알림은 `확인·해결`에서 프로젝트를 현재 등록 경로로 다시 해석하고, 사람이 AI를 골라 진단 워크룸을 연다.
  원문 오류는 진단 프롬프트에도 넣지 않는다. 양쪽 기억과 기존 영수증을 먼저 확인하고, 충돌 원본 보존·백업만 복구·
  미확정 저장 중복 실행 금지를 고정 진단 작업에 포함한다. 워크룸 시작 자체를 기억 저장 성공으로 표시하지 않는다.
- 시작 응답 유실은 재시작하지 않고 같은 프로젝트·AI의 최신 워크룸 최대 16개에서 사람이 선택한다. 창 열기만 실패하면
  확인된 같은 세션을 다시 연다. 생성/실행 결과를 추측해서 다른 프로젝트나 다른 세션을 고르지 않는다.
- 알림용 모듈은 `memorySaveNoticeRecovery*`다. 기존 V2 `memorySaveRecovery.ts`의 복구 계약과 섞지 않는다.
  회귀는 `memory-save-notice-recovery.test.ts`, `unsaved-session-memory.test.ts`, capability HTTP 검사와
  Chromium/WebKit `check-memory-save-notice-recovery.ts`에 있다. 실제 제공자 호출은 화면 fixture의 검증 범위가 아니다.

## 「모두 바뀌어 저장하지 않았습니다」 — 가짜 충돌과 도크 「비교·해결」 (2026-11-01)

- `pullProjectMemory`는 로컬만 바뀌어도(Supabase head = 마지막 동기화) `conflict:true`를 돌려준다(Pull이 로컬을
  덮지 않으려는 것). 세션 저장 preflight가 이것을 「양쪽 다 바뀜」으로 읽어 백업 안 된 로컬 변경이 있는 프로젝트의
  저장을 매번 막았다. 이제 충돌 응답에 `remoteChangedSinceSync`·`localChangedSinceSync`를 싣고, preflight는
  `sessionPreflightBlocksSave`로 **head가 실제로 움직였을 때만**(또는 필드가 없을 때) 멈춘다. head 이동 판정은
  `projectMemoryRemoteMovedSinceSync` 하나 — push의 CAS 검사도 같은 함수를 쓴다.
- 도크 행의 「비교·해결」(`DockMemoryConflictReview.tsx`): `POST /api/project-memory/conflict-preview`(읽기 전용 —
  claim·Pull·쓰기 없음)가 로컬·Supabase와 **검증된 기준 리비전**(`lastPulledRevisionId`·`lastSyncedHash`가 가리키고
  sha256이 맞는 행만)을 준다. `src/projectMemoryConflictEntries.ts`가 항목(`###`, memory-entry-id) 단위로 비교한다.
  선택은 로컬 유지 / Supabase 받기 / 항목 합치기이고, 확인 뒤 기존 `resolve-conflict`로 **한 번만** 보낸다(비교한
  해시·리비전을 함께 보내 그 사이 바뀌면 stale). 응답 유실은 다시 보내지 않고 「다시 비교」만 연다.
- 「항목 합치기」는 기준이 있고, 양쪽이 **서로 없는 항목을 더하기만** 했고, 항목 밖 머리말·섹션 설명이 같고, ID가
  모호하지 않을 때만 연다. 로컬 문서를 그대로 두고 Supabase 추가분만 같은 섹션 끝에 넣는다 — 「Contested Entries」
  절을 만들지 않는다. 고침·지움이 하나라도 있으면 이유를 보여 주고 프로젝트 화면의 충돌 검토로 보낸다.
- 회귀: `project-memory-conflict-detection.test.ts`(가짜 Supabase로 preflight·preview·병합 resolve·재전송 stale),
  `project-memory-conflict-entries.test.ts`, `scripts/check-voice-dock-sessions.ts`(Chromium·WebKit).

## 합의 기록이 없을 때 Pull은 로컬을 덮지 않는다 (2026-11-01)

- `lastSyncedHash`가 없는 기기(이 기기의 첫 동기화, `state.json`이 없거나 사라짐 — gitignore라 clone에는 없다, 계보를 바꾼
  identity claim이 커서를 지움)에서 `pullProjectMemory`는 로컬을 **바뀌지 않은 것으로** 읽고 백업 뒤 Supabase head로
  교체했다. `/sync`의 `conflict` 방향(합의 없음 + 시각 동률/불명)은 그 Pull을 부른 뒤 `conflict: true`(409)로 답해,
  화면·스킬은 「덮어쓰지 않았다」고 멈추는데 로컬은 이미 교체되고 원격이 새 합의로 기록됐다(다음 싱크는 「동기화됨」).
- 이제 합의가 없으면 **아무도 쓰지 않은 문서**만 받는다 — 없음·빈 문서·초기 템플릿 그대로(`projectMemoryHoldsNoLocalWork`,
  프로젝트 이름·날짜 줄만 다를 수 있음, 한 줄이라도 고쳤으면 아님). 그 밖의 차이는 충돌 응답(비교 본문 포함)이고 선택은
  기존 resolve / 도크 「비교·해결」(기준 없음 → 두 쪽 비교)로 사람이 한다. 같은 바이트면 합의를 기록한다. `force` Pull은 그대로.
- `/sync`·`/thread/sync`는 `projectMemorySyncAnswer` 하나로 답한다: Push·Pull이 충돌로 멈추면 **최상위** `conflict: true`
  (패널·도크·스킬이 거기를 본다 — `result` 안에 있으면 「요청 실패 (409)」만 보였다), `conflict` 방향의 Pull이 받기를 했으면
  `action: 'pull'`로 답한다. 공통기억 복원은 Pull 충돌을 `COMMON_MEMORY_PROJECT_CONFLICT`로 실패시킨다(완료로 보고하지 않음).
- 회귀: `project-memory-unagreed-sync.test.ts`(가짜 Supabase + 실제 API의 `/sync`).

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## Hermes `/remember_session` — 인자 유무가 표면을 가른다

스킬 규약(`templates/hermes/remember-session/SKILL.md`)이 정본이다.

| 형태 | 해석 | 어디서 |
|---|---|---|
| `/remember_session` (인자 없음) | 현재 Telegram topic 바인딩을 따름 | Telegram 대화 |
| `/remember_session <경로>` | one-shot local-terminal selection (바인딩 안 함) | 로컬 터미널 Hermes |

- 그래서 UI도 두 자리로 나눈다: 「로컬 터미널 AI」 줄에는 **인자 붙은** 버튼
  (`copy-hermes-remember-session-local`), 「Hermes 명령」 상자는 **Telegram 대화용**이라고
  제목과 본문에서 먼저 못 박는다(`project-memory-hermes-scope`).
- ⚠️ 로컬 줄에 인자 없는 형태를 넣지 말 것 — 바인딩된 topic이 없어 그냥 멈춘다.
- 명령은 **붙여넣은 대화가 도는 호스트**의 API를 부른다(이 PC의 Hermes면 이 PC,
  AWS의 Hermes면 그 서버). 경로 인자도 그 호스트 기준이다.
## 공통기억 — 장기기억(memoryId) 위의 공유 지식 (2026-10-13)

정본은 클라우드 `portmgr_common_memories`이고 연결 단위는 장기기억(memoryId)이다. 전체 계약은 `docs/meta-common-memory.md`.
회상은 한 경로(`recall` → `knowledgeForMember`, 클라우드 1회 · 6초 `COMMON_MEMORY_RECALL_TIMEOUT`)이고, 로컬 SQLite는 울타리 친
보관소이자 이관 다리다. 되돌리지 말 것:
- **`sources()`의 alias 일괄 읽기는 resolve 의미에 기댄다.** alias 행이 보이면 그 id만 `portmgr_resolve_project_memory_id`에 묻는다 —
  alias를 정본으로 바로 읽으면 자기 자신 alias·순환이 예전과 다르게(조용히) 통과한다. PGlite 대조 테스트가 지킨다.
- **`compatibility()`에는 목록 프로브가 없다.** 첫 실제 클라우드 읽기가 `COMMON_MEMORY_MIGRATION_REQUIRED`(42P01·PGRST205)를 내고,
  울타리 친 그룹이 없을 때만 로컬로 돌아간다. 프로브를 되살리면 요청마다 전체 목록을 한 번 더 읽는다.
- **memoryId 회상은 여전히 등록을 요구한다**(`registeredMemoryCategory` — ports.json + 식별 캐시). 계획은 「명시 멤버는 등록 없이」였지만
  「memoryId 하나로는 아무것도 열리지 않는다」를 지키려고 의도적으로 남겼다. 바뀐 것은 워크트리만 등록된 경우도 식별 캐시로 인정한다는 것뿐이다.
- **v1은 바이트 그대로다**(아래 절). 옛 휴대폰이 새 Mac에 붙는다.
- **변경 요청은 자동으로 다시 보내지 않는다** — 잃어버린 응답(v2 `call` 포함)은 「불확실」이다. 형식 후퇴(memory → 프로젝트 카드)도 파서의
  `INPUT_INVALID` 거절에만 한 번이다.
- **`common-memory-rpc-v2`는 레거시 capability 답(8개)에 넣지 않는다** — `conversations-v1`이 밀려난다. 확장 답에만 있다.
- **이전 방식(목표·원본 검토·게시)은 울타리일 뿐 삭제가 아니다.** op·testid·`ProjectCommonMemoryChoice` export·`common-memory.bind`가 남아 있다.
- **이번 릴리스에는 마이그레이션이 없다.** 표·행·파일도 지우지 않았다.
- **주제 발견은 같은 교훈 묶음이 먼저다**(`src/commonMemoryLessonClusters.ts`, 2026-11-01). 다른 장기기억에 비슷하게 적힌 항목을 n-gram Jaccard로 묶고,
  예전 키워드 주제 7개는 그 조회에 같은 교훈이 없을 때만 나온다. 라틴 문자 5-gram을 3-gram으로 되돌리지 말 것 — 실측에서 무관한 영어 항목이 실제
  공유 교훈과 같은 유사도로 섞였다. 후보에 키를 더하지 않는다. 문턱의 근거와 한계(한 쪽 안에서만 비교)는 `docs/meta-common-memory.md` 「주제 발견」.
- `hostCapabilities`는 `list` **결과 안쪽**에 실린다(옛 휴대폰의 엄격한 정규화기가 바깥 키를 거절한다). JSON 포함 조건은 `.filter(…,'cs',JSON)`으로만 —
  supabase-js `.contains()`는 객체 배열을 `cs.{[object Object]}`로 보낸다. 카테고리를 `.or()`로 섞지 말 것.

## 휴대폰 공통기억 RPC v2 — 확장 기능 `common-memory-rpc-v2` (2026-10-13)

공통기억(클라우드·로컬) 원격 요청 하나가 v1에서는 upload·execute·read(들)·release로 최소 4번 왕복했다(릴레이는 한 번에 하나).
v2는 마지막 조각을 실은 `call` 한 번이 실행까지 하고 첫 결과 조각(`result`)을 돌려준다 — 작은 요청은 **1왕복**, 큰 결과는
나머지 조각만 `read`한다. 조각은 7,600바이트(escape된 JSON 기준)이고 v2 전송은 마지막 조각을 내준 뒤 **스스로 지워진다**
(release는 중단·오류 때만). 정본: `src/metaCommonMemoryRemoteProtocol.ts`·`…RemoteHost.ts`·`…RemoteClient.ts`.
- ⚠️ **v2는 Mac이 확장 기능을 광고할 때만 쓴다**(`createMetaMemoryRemoteRequester(…,{rpcV2})`, 포털이 `supportedFeatures`에서 정한다).
  오류 문구로 내리지 않는다 — 옛 Mac이 `call`을 거절하면 그 오류가 그대로 보이고, 변경 요청은 다시 보내지 않는다(실행 여부 불확실).
- v1은 바이트 그대로다(4,000바이트 조각, release 필수). 레거시 `protocol.capabilities` 답에서는 `goal-common-memory-v1`과 함께
  이 이름도 빠진다 — 안 빼면 8개 상한에서 `conversations-v1`이 밀려난다. 확장 목록 상한 16 중 한 칸을 쓴다. LAN 서버는 광고하지 않는다.
- 한 requester의 동시 호출은 **차례로** 돈다(릴레이가 직렬이라 병렬은 이득이 없고, v1에서는 소유자당 전송 4개 상한만 채운다).
- 검증: `tests/common-memory-rpc-v2.test.ts`(v1 바이트 동일·1왕복·자동 해제·중단 시 release·잃은 `call`=불확실·옛 Mac·최악 escape가
  8,500/11,000 안·화면 예산), `tests/remote-control-core.test.ts`(레거시 8개 그대로).
## 세션 기억하기 필요 — 판정 계약

배지는 **양쪽이 모두 참일 때만** 켜진다 (`memoryActivityStatus`, `project-memory-server.ts`).
예전에는 둘 중 하나(OR)였고, 각 래치가 작업 없이도 켜져서 실측 26개 중 20개(77%)가 상시 점등이었다.

**현행은 v8이다.** v7의 프롬프트 카운터 게이트(`ACTIVITY_MIN_PROMPTS` 3회 +
`ACTIVITY_COOL_OFF_MS` 20분 + `.agent-memory/activity-count` + `countedGateUsable`)는
**전부 삭제됐다.** `ensureAdapters`는 업그레이드 시 남아 있던 `activity-count` 파일을
오히려 지운다(`project-memory-server.ts:622,644`). 카운터를 다시 도입하기 전에
왜 지웠는지부터 읽을 것 — 끝없이 자라는 파일이 디스크 churn이 됐다.

| 신호 | 조건 (v8) |
|---|---|
| 세션 | 훅 마커의 마지막 활동 시각이 마지막 remember 시각보다 **뒤면 참** (`markerTime > rememberedTime`, `:1211`). 프롬프트 **1회면 충분**하고, 쿨오프 대기 시간은 없다 |
| 내용 | 지문이 baseline과 다르고 **remember 이후 churn 차이 ≥ `ACTIVITY_CHURN_THRESHOLD`**, 저장한 변경 줄 히스토그램 차이가 그 이상, 또는 워크트리 HEAD가 이동함. 비Git 폴더의 churn 0은 지문 변화를 따른다 (`project-memory-server.ts`의 `memoryActivityStatus`) |

- **세션 게이트가 먼저** 평가되고, 통과 못 하면 git을 아예 실행하지 않는다. 조용한 프로젝트의
  detect 비용이 워크트리당 4회 spawn → 0회가 된다 (94개 스윕 실측 2052ms → 1116ms).
- **churn 0에서 지문 변화만으로 켜는 경우는 기준선 churn도 0이거나 숫자 기준선이 없는 기존 상태다.**
  HEAD 이동은 별도로 감지한다. 기억할 때 미커밋 변경이 있었고 이후 되돌려 churn이 0이 된
  경우는 지문 변화만으로 다시 켜지지 않는다. churn은 작업트리만 잰다.
- ~~배지가 remember 직후 되살아난다~~ — **해결.** 기기별 `state.json`에 remember 시점의
  작업트리 churn과 워크트리 HEAD 지문을 함께 기록한다. 배지는 이후 churn의 차이가 임계값을
  넘거나 HEAD가 움직였을 때만 켜진다. 큰 미커밋 변경을 기억한 직후 1바이트 수정은 조용하고,
  이후 큰 변경 또는 커밋은 다시 표시됨을 회귀 테스트로 확인했다. 숫자 기준선이 없는 기존
  기기 상태는 과거 미커밋 변경량을 역산할 수 없어 다음 remember까지 이전 판정을 유지한다.
- **같은 churn의 다른 작업도 판별한다.** remember 시 tracked diff·미추적 일반 텍스트 파일의 변경 줄을
  원문 없이 512칸 히스토그램으로 기기 로컬 `state.json`에 기록한다. 지문은 달라졌지만 총 churn
  차이가 작은 경우에만 현재 변경 줄을 다시 읽어 비교한다. 파일 읽기는 512 KiB·6,000줄·2초로
  제한하고, 한도를 넘거나 바이너리·기존 기준선 등으로 비교할 수 없으면 이전 숫자 판정으로
  돌아간다. 50줄 동일 규모 교체와 한 줄 수정 억제를 회귀 테스트로 확인했다.
- `degraded: true` 는 이제 **훅 부재**(`hooks.claude`·`hooks.codex` 둘 다 false)일 때만 참이다.
  v7의 "카운터 파일이 없어 폴백 중"이라는 의미는 더 이상 없다.
- 지문 알고리즘을 바꾸면 `ACTIVITY_FINGERPRINT_VERSION`을 올린다. 버전이 다른 baseline은
  "변경됨"이 아니라 **조용한 재기준선**으로 처리한다. 안 그러면 개선이 곧 전 프로젝트 점등이 된다.
- `runGit`은 항상 `-c core.quotePath=false`를 붙이고, status는 `runGitRaw`(trim 안 함)로 읽는다.
  출력 전체를 trim하면 `git status --short` 첫 줄의 선행 공백이 사라져 경로 첫 글자가 잘린다.
- 이 모듈의 git 호출은 전부 읽기이므로 `READ_ONLY_GIT_ENV`(`GIT_OPTIONAL_LOCKS=0`)로 돈다. 없으면
  `git status`가 stat이 바뀐 인덱스를 다시 쓰며 `index.lock`을 잡아, 패널 폴링이 사용자의
  `git commit`과 부딪힌다(`tests/project-memory-readonly-git.test.ts`). 쓰기 git을 여기 추가하면 이 env를 빼고 부를 것.

### 프로젝트 장기기억 패널은 한 번의 요청으로 그린다

패널은 예전에 열 때마다 detect → Private GitHub 보관 상태(detect) → 원격 상태(detect 2회) + 즉시 폴링
detect를 돌렸다 — 전부 동기 git + 문서 해시라 그 동안 사이드카 전체가 멈췄다.

- 정본은 `POST /api/project-memory/panel-status`(`src/projectMemoryPanelStatus.ts`). `scope: 'full'`(열 때·
  동작 뒤)은 detect 1회를 보관·원격 판정에 그대로 넘기고, 원격 실패는 `remote: {ok:false}`로 **로컬 상태 옆에**
  싣는다. `scope: 'local'`(30초 폴링·focus)은 위 스냅샷에서 답한다.
- ⚠️ **원격 절반은 작업공간 lease 안에서 돈다**(`remoteStatusUnderWorkspaceLease`). identity claim이
  `config.json`을 통째로 다시 쓰므로 `remote-status`는 lease 경로다. panel-status 자체는 lease 경로가
  아니어서(로컬 절반은 writer가 도는 중에도 읽혀야 한다) 원격 절반이 lease를 직접 잡고, 그 안에서 읽은
  config로 바꿔 넘긴다 — lease 밖 detect의 config를 쓰면 그 사이 push·remember가 바꾼 필드를 되돌려 쓴다.
  lease가 바쁘면 `remote: {ok:false}`만 실패한다.
- `remoteProjectMemoryStatus`는 호출자가 준 detect(`local`)를 재사용하고, identity가 memoryId를
  canonicalize했을 때만 다시 detect한다.
- 옛 경로(`detect`·`remote-status`·`private-github-archive/status`)는 다른 호출자(AI 사용량 패널 등)를 위해
  남긴다. 패널은 **코드 없는 404**(=그 경로를 모르는 옛 사이드카)일 때만 옛 3단 호출로 후퇴한다.

### 장기기억 탭은 head 첫 페이지로 먼저 그린다

`loadMemoryDirectory`는 보조 테이블을 head 페이지와 **함께** 읽고, head가 한 페이지(250)를 넘으면 첫 페이지 +
보조 테이블로 만든 중간 결과(`complete: false`)를 `onProgress`로 한 번 넘긴다. 탭은 그것을 그리고
「먼저 불러온 기억 N개」 안내(`portal-memory-progressive-loading`)를 띄우며, 새로고침·합병 버튼은 완성될 때까지
`loading`으로 막힌다. 중간 결과는 **캐시하지 않고**, 이미 완성된 목록을 중간 결과로 줄여 보이지 않는다.

## 교정 결과 측정 — 같은 실패가 다시 났는가 (2026-10-15)

「교정·실패 기억하기」로 남긴 교정이 **다음 관련 요청에 전달된 뒤 같은 실패를 피했는지**를 잰다. 묻는 것은 그 하나뿐이고,
답할 수 있는 근거는 **독립적인 세 가지뿐**이다. 전달 횟수·`checkedAt`·대기 0건·AI가 남긴 applied/confirmed·자기 보고·대화 원문은
관찰 형식(`parseCorrectionObservation`)이 아예 받지 않는다. 정본: `src/projectMemoryCorrectionOutcome.ts`(프로토콜·분류·요약, IO 없음)·
`src/correctionOutcomeStore.ts`(앱 데이터 `correction-outcomes-v1/outcomes.sqlite`)·`src/correctionOutcomeObserver.ts`(틱)·
`src/correctionOutcomeManagement.ts`(사람의 입력 경로)·`src/correctionTesterObservations.ts`(테스터 신호).

| 근거(source) | 어디서 오나 | 판정 |
|---|---|---|
| `re-correction` | 같은 항목·같은 본문 버전에 관찰 기간 안 **이 Mac에서** 남긴 새 교정(기존 기록 장부) | 반복 |
| `human-attestation` | Mac 화면 「요청 결과 직접 확인하기」에서 사람이 고른 피했다·반복됐다·모르겠다 | 그대로(모르겠다 = 알 수 없음) |
| `tester-check` | 사람이 연결한 테스터 검사(최대 4개)의 실행 기록 | 실패 = 반복, 소스가 바뀐 뒤 통과 = 피함 |

- **프로토콜 v2(확정, 2026-10-15 사용자 승인)**: 관찰 기간 72시간, 관련성 = 일치 단어 2개 이상 + 근거 단어 1개 이상, 반복률은
  확정 30건 + 서로 다른 교정 5개 이상일 때만 낸다(그 전에는 `insufficient-sample`). 상수를 하나라도 바꾸면 `version`을 올린다 —
  해시가 바뀌고, 이미 확정된 결과는 **다시 채점하지 않는다**(`otherProtocol`로 따로 센다).
- **기간 안에 독립 근거가 없으면 「알 수 없음」이지 「피함」이 아니다.** 근거끼리 다르면 `unknown('conflict')`다.
- **측정 대상(coverage)**: 작성칸 제출·검토한 음성·요청 전체로 입력된 `@` 전달만 교정을 받는다. MCP 지시·새 세션 첫 요청·나눠 입력된
  `@` 전달·옛 LAN 페이지는 교정을 받지 않으므로 결과에도 없다(`CORRECTION_OUTCOME_COVERAGE`, 화면 문구가 같이 말한다).
- **제외는 숨기지 않고 센다**: 전달 미확정·민감 원문 보류·관련성 부족·**측정 시작 전**(저장소가 처음 열리기 전에 쓰인 노출 —
  켜기 전 기록을 소급해 고르지 않는다)·대상 확인 불가(5틱 재시도 뒤). OPS·공유 폴더 대상은 아예 들이지 않는다
  (`correctionOutcomeTargetExclusion` — 확인하지 못하면 `unresolved`, 절대 측정 대상으로 읽지 않는다).
- **사람의 입력 경로는 Mac 관리 경로 하나다**: `POST /api/agent-runtime/correction-outcomes`(`list`·`attest`·`bind`, 8 KiB,
  사이드카 게이트와 Rust `is_allowed_agent_runtime_route` 둘 다 정확한 POST만). **MCP·agentstoz_use·휴대폰·LAN 경로가 없다** —
  AI나 연결된 휴대폰이 자기 일을 스스로 채점할 수 없게 하는 것이 목적이다. `attest`는 관찰 기간 안의 쓰인 노출에만, requestId로
  멱등이고(같은 ID 다른 판정은 `REQUEST_ID_CONFLICT`), 다른 판정을 새로 남기면 둘 다 저장돼 그 단위가 conflict로 확정된다.
  `list`는 최근 20건의 대화 제목·항목 제목·시각만 준다(요청 글·근거 글 없음). 화면 칸은 **펼치기 전에는 아무 요청도 하지 않는다.**
- **테스터 신호의 함정**: 통과한 검사는 산출물을 증명할 뿐 AI의 행동을 증명하지 않는다 — 그래서 별도 라벨이다. 연결 시점에
  **고정(pin)하는 것**은 그 검사의 maintainer.json 항목과, argv가 이름으로 가리키는 루트 안 일반 파일의 바이트(최대 8개·각 1 MiB,
  `testerCheckPinnedDigest`)다. 둘 중 하나가 바뀌었거나 격리됐거나 건너뛴 실행이거나 비교 키(설정·러너·의존성)가 달라졌으면 신호가 없다.
  연결 **이후**의 실행만 센다(이미 통과한 검사를 골라 붙이는 사후 선택 방지). 기록은 `history-v1.jsonl`의 끝 256 KiB만 읽고 심볼릭
  링크는 따라가지 않는다(argv의 파일이 링크면 링크 자체로 고정한다). 회전된 `.1.jsonl`은 읽지 않는다(72시간 창 안에서는 충분).
  ⚠️ **「AI가 테스트를 약하게 고치지 못한다」·「AI가 자기 일을 채점하지 못한다」고 쓰지 말 것 — 테스터 신호에는 거짓이다.**
  비교 키는 테스트 파일 내용을 보지 않고(소스 지문만 바뀌는데, 소스 지문 변화가 곧 「피함」의 조건이다), 고정은 argv가 가리키는 파일만
  덮는다 — 테스트가 import하는 헬퍼·픽스처·대상 코드, argv의 디렉터리는 덮지 않는다. 그리고 `history-v1.jsonl`은 워크룸 AI가 쓸 수 있는
  프로젝트 폴더에 있고 행에 서명이 없어서, 행 하나를 덧붙이면 「피함」이 된다(리뷰 2026-10-15 재현). **테스터 「피함」은 약한 근거다.**
  「AI가 스스로 채점하지 못한다」는 사람 확인(attest)·검사 연결(bind) 경로에만 맞는 말이다.
- ⚠️ **한 실행은 관찰 하나다.** 연결은 범위(memoryId·항목·본문 버전) 전체에 걸리므로 같은 교정이 세 세션에 전달되면 세 단위가 같은
  실행을 본다. 예전에는 실행 하나가 세 번의 「반복」으로 세어져 확정 건수(최소 표본 30건)와 반복률을 부풀렸다. 지금은 다시 교정과 같은
  규칙(`#attributes`)이다: 그 실행을 창에 담는 적격 단위 중 **가장 늦은 것 하나**에만 붙이고, 세션이 둘 이상이면 아무에게도 붙이지 않고
  `ambiguous`로 센다.
- **비용 상한**: 켜도 시작 때 아무것도 열지 않는다(관찰자는 60초 틱에서 처음 열고, 품질 조회가 처음 물을 때 만든다). 한 틱은
  저널 256행·확정 32건까지, 저장소는 표마다 20,000행 **그리고 파일 64 MiB**에서 새 쓰기를 거절하고 아무것도 지우지 않는다.
- **끄는 법**: ① 이 프로세스만 — `AGENTSTOZ_CORRECTION_OUTCOMES=off`로 사이드카를 띄운다(끄기만 가능, 환경변수로 켜는 길은 없다).
  ② 빌드 — `CORRECTION_OUTCOME_PIPELINE_ENABLED`를 `false`로 되돌린다(켠 커밋 하나만 되돌리면 된다). 꺼지면 관찰자도 관리 경로도
  저장소를 열지 않고 관리 경로는 `CORRECTION_OUTCOMES_DISABLED`(409)로 답한다. 이미 쌓인 파일은 지우지 않는다.
- ⚠️ **효과 검증이 아니다.** 요약은 언제나 `efficacyVerified:false`이고 학습 트랙은 기준선 설계가 없어 `BLOCKED(baseline-missing)`다 —
  「반복 감소」를 주장하려면 별도 비교 설계(예: 보류군)가 필요하고, 그것은 사람의 따로 받은 동의 없이는 하지 않는다.
- **사용자 결정(2026-10-16): S4-11 보류군(holdout)은 하지 않는다** — 구현하지 않았고, 학습 트랙은 `BLOCKED(baseline-missing)` 그대로다.
  유료 실시간 한국어 ASR 측정도 하지 않는다(비용 0, 오프라인 도구만).
- ⚠️ **확정은 쓰기 트랜잭션 안에서 다시 본다**(리뷰 2026-10-16). `attest`·`bind`는 자기 확인(`#writable`) 뒤에도 await한다(`#writable` 자체,
  `bind`의 검사 목록 읽기) — 그 사이 관찰자 틱이 단위를 확정해도 예전에는 그대로 `inserted`로 저장했고 화면은 「결과를 남겼습니다」라고 했다.
  지금은 `recordManagement(…, openUnitId)`가 같은 트랜잭션에서 결과 행을 보고 있으면 아무것도 쓰지 않으며(`final` — 이미 기록된 같은
  requestId의 재생은 먼저 답한다), 경로가 `CORRECTION_OUTCOME_FINALIZED_MEANWHILE`로 답한다. 관찰 기간도 쓰기 직전의 시계로 다시 본다(예전엔
  await 전에 읽은 시각이라, 닫힌 기간 안의 시각이 찍힐 수 있었다). 화면은 그 문구를 남긴 채 목록을 조용히 다시 읽어 확정된 행을 보여 준다.
- 읽기 전용 보고: `bun report-correction-outcomes.ts --app-data-dir <dir>`(개수·해시만, 저장소를 만들지 않음).
- 검증: `tests/project-memory-correction-outcome.test.ts`(분류·요약·관찰자·상한·시작 무IO), `tests/correction-outcome-signals.test.ts`
  (사람 확인·검사 연결·테스터 판정·심볼릭 링크·256 KiB·한 실행의 귀속·테스트 파일 고정·확정 경합의 attest/bind·기간 경합), `tests/correction-outcome-served.test.ts`(실제 API: 게이트·꺼짐·시작 때 파일 없음),
  Rust `correction_outcome_route_is_exact_post_management_only`, `bun tests/project-memory-corrections-ui.mjs`(접힌 칸 무요청·제목만·한 번 전송·늦은 확정이면 「남겼습니다」 없이 확정 행).
## 장기기억 문서 레이아웃 — 색인 + 노트

기억이 24KB를 넘으면 다음 저장에서 **자동으로** `##` 섹션별 노트로 쪼개진다
(`src/projectMemoryDocument.ts`). 되돌리는 마이그레이션 스크립트는 없다 — 저장이 곧 이전이고,
그 직전에 백업이 남는다.

| | 역할 |
|---|---|
| `.agent-memory/CORE.md` | **생성물.** 머리말 + 전체 항목 제목 목록 + 각 섹션이 어느 노트에 있는지. 에이전트가 항상 읽는 유일한 파일 |
| `.agent-memory/notes/NN-*.md` | 본문. 필요한 것 **하나만** 연다 |
| `.agent-memory/notes/manifest.json` | 파트 순서. 문서를 다시 합칠 때의 정본 |

- **분할은 원본 문자열의 분해다.** 각 노트는 원본의 연속된 구간이고, manifest 순서대로
  이어 붙이면 **바이트 단위로 원본**이 된다. 이 성질 덕분에 Supabase push/pull·리비전·충돌
  해결·`contentHash`가 레이아웃을 전혀 모르고도 그대로 동작한다. 실측: 43,799B 문서가
  왕복 일치, 색인은 5,012B(11.4%).
- 문서를 통째로 다루는 코드는 **반드시** `readMemoryDocument`/`writeMemoryDocument`를 쓴다.
  `readFileSync(memoryPath)`를 직접 쓰면 분해된 프로젝트에서 색인만 읽고, 그걸 push하면
  원격의 기억이 색인으로 덮어써진다.
- 노트가 하나라도 없으면 `readMemoryDocument`는 **던진다**(`MEMORY_NOTE_MISSING`).
  남은 노트만 반환하면 그 손실이 다음 push로 원격에 전파된다.
- ⚠️ **색인을 손으로 고치지 말 것.** 저장할 때마다 노트에서 다시 생성된다. 스킬·지침도
  같은 말을 한다.

### 예산은 파일 전체가 아니라 섹션 하나

전체 파일 예산(`MEMORY_BUDGET_BYTES`)은 "네 출력 바이트를 세어라"는 지시라 **3회 연속
실패**했다(43,290 → 43,799, 예산 42,000). 이제 저장 프롬프트는 `MEMORY_NOTE_BUDGET_BYTES`
(12KB)를 넘는 **섹션 하나를 이름과 실제 크기와 함께** 지목하고 나머지는 건드리지 말라고
한다(`selectMemoryNoteToCompact`). 확인 가능한 지시이고, 통합 범위가 항상 한 노트로 제한된다.

### 두 저장 경로는 같은 것을 남겨야 한다

`/remember-session`(살아있는 세션)과 앱 버튼은 **같은 기록을 남기는 것이 목적**이다. 차이는
설계가 아니라 **맥락 접근**이었다 — 버튼은 대화에 없던 새 프로세스를 띄우므로 git만 볼 수 있었다.

| | 스킬 | 버튼 |
|---|---|---|
| 문서를 쓰는 주체 | 살아있는 에이전트가 노트에 직접 | 새 `claude -p`가 전체 재생성 |
| 맥락 | 대화 그 자체 | git + **세션 기록 주입**(`sessionContext`) |
| 색인 갱신 | `mark-remembered`가 재생성 | 저장이 곧 재생성 |

- **Claude와 Codex 양쪽을 다 쓸어담는다** — 어느 에이전트로 저장하든. Codex로 작업하고
  Claude로 기억하면 그 세션을 잃는다.
- Claude: Claude Code는 **워크트리를 별도 슬러그로 파일링**하므로 프로젝트 자기 슬러그만
  보면 그날 작업이 통째로 안 보인다 (실측 2026-08-09: 마지막 remember 이후 메인 슬러그
  수정 0건, 전부 워크트리에 있었음). 그래서 소속 판정은 **이름 모양이 아니라 실제로 링크된
  워크트리 경로**로 한다 — `git worktree list`로 얻은 경로들을 각각 슬러그로 변환해
  `~/.claude/projects/` 아래에서 찾는다.
  ⚠️ **`<slug>--*` 이중 대시 매칭을 다시 쓰지 말 것.** 그 모양은 레거시 배치인
  `<repo>/.claude/worktrees/`가 `-claude-worktrees-`로 슬러그되며 생긴 **우연**이었다.
  현행 배치인 `<repo>/worktrees/<name>`은 단일 대시 슬러그라 그 규칙에 안 걸리고,
  결과적으로 지금 쓰는 워크트리 세션이 통째로 누락된다. Codex 쪽 `isPathInsideProject`가
  이미 경로 기준이며, 그쪽이 옳은 형태다.
- Codex: `~/.codex/sessions/`는 날짜별로 쌓이므로 위치가 아니라 **rollout 헤더의 `cwd`**로
  프로젝트를 판정한다(`session_meta`). 프로젝트 폴더 안이면 워크트리도 포함.
- ⚠️ **rollout 첫 줄은 짧지 않다.** `session_meta`가 모델 지침을 통째로 싣기 때문에 실측
  318개에서 250B ~ 47,671B(중앙값 44,055B)다. 8KB만 읽으면 311개가 JSON 중간에서 잘리고,
  잘린 헤더는 "rollout이 아님"으로 파싱되어 **Codex 세션 전부가 조용히 누락**된다
  (이 프로젝트 실측 117개 → 0개로 보고됨). 헤더 읽기는 256KB로 잡는다.
- 스윕 비용은 실측 318개 전수 헤더 판독에 **40ms**. mtime 필터가 대부분을 먼저 걸러낸다.
- 스윕은 **건너뛴 개수를 센다**(`sessionContextStats`: considered / matched / unreadable).
  판독 실패가 0이 아닌데 매칭이 0이면 "이 프로젝트에 Codex 작업이 없다"가 아니라 **읽기가
  레코드를 자르고 있다**는 신호다. 위 8KB 사고가 정확히 그 상태였고, 카운터가 없어서
  깨끗한 0으로 보였다. 파싱 실패를 건너뛰는 모든 경로는 그 수를 세어 밖으로 내보낼 것.
- **agy(Antigravity)는 주입 대상이 아니다 — 기록은 로컬에 있지만 암호화돼 있다.**
  대화는 `~/.gemini/antigravity-cli/conversations/*.pb`에 저장된다(요약 색인은
  `conversation_summaries.db`). **"로컬에 저장소가 없다"는 앞선 서술은 틀렸다** —
  `~/.antigravity`·`~/.cache/antigravity`만 보고 내린 결론이었고, 실제 저장소는 `~/.gemini` 밑이다.
  열 수 없는 이유는 형식이 아니라 암호화다: 실측 엔트로피 **7.999 bits/byte**(최대 8),
  인쇄가능 문자 37.3%, `strings -n 12`가 190KB에서 2건(전부 잡음), 선두 바이트 `65 12 5b 61`로
  gzip·zstd·zlib 매직 아님. 같은 폴더에 `antigravity-oauth-token`이 있어 키는 계정에 묶여 있을
  가능성이 크다.
  → agy로 한 작업은 **git 근거로만** 기억에 들어간다. **로컬 경로를 다시 찾아 헤매지 말 것** —
  경로는 이미 찾았고 문제는 복호화다. agy가 평문 export나 JSON 세션 덤프를 제공하게 되면
  그때 다시 본다. agy는 실행 대상일 뿐 `ProjectMemoryAgent`(claude|codex)가 아니어서
  **기억을 쓰는 주체가 되는 일도 없다.**
- 프롬프트·산문만 담는다. 도구 호출/결과/시스템 리마인더가 바이트의 대부분이고 의미는 거의 없다.
- mtime이 `lastRememberedAt`보다 오래된 파일은 **열지 않는다**. 실측: 286개 중 1개만 읽어 12.7KB.
- 예산 초과 시 **오래된 것부터** 버린다(최신부터 채우고 뒤집어 출력) — 잘려야 할 것은 결론이 아니라 도입부다.
- 읽을 수 없으면 조용히 빈 문자열 → 예전 동작 그대로. 기억 저장이 기록 유실로 실패하면 안 된다.
- ⚠️ **`장기기억 시작하기` 버튼에는 적용하지 않는다.** AI 호출이 없는 결정적 작업이고, 서술할
  세션 자체가 없다. 여기에 세션 의존을 넣으면 세션이 없을 때 시작조차 못 하게 된다.

### Hermes 프로젝트 장기기억 명령 어댑터는 기기당 하나다

Claude·Codex 어댑터는 프로젝트마다 깔린다(`ensureAdapters`). Hermes의 `/remember_session`과
`/memory_*`는 프로젝트 **밖의 Telegram 대화**에서 실행되는 게이트웨이 명령이라 성격이 다르고,
설치도 기기당 한 번이다 (`installHermesProjectMemoryAdapter`, `src/hermesProjectMemoryAdapter.ts`).

- **Hermes가 슬래시 명령으로 인식하는 스킬은 `<HERMES_HOME>/skills/`와 `config.yaml`의
  `skills.external_dirs` 두 곳에서만 온다.** 프로젝트 안의 `.agents/skills/`·`.claude/skills/`는
  스캔 대상이 아니다 — 그래서 프로젝트마다 `remember-session`이 깔려 있어도 Hermes에는 아무
  명령도 생기지 않았고, 앱이 나눠주던 `/remember_session <경로>`가 `Unknown command`로 거절됐다.
  (2026-08-12 실측. CLI `cli.py:10852`·게이트웨이 `gateway/run.py:16206` 모두 LLM에 전달조차 안 한다.)
- **명령 이름은 폴더가 아니라 frontmatter의 `name`에서 온다.** 내부 `remember-session`은
  Telegram 메뉴에서 `/remember_session`으로 노출한다. 모호한 `/remember` 별칭은 설치하지 않는다.
- 설치 위치는 `<HERMES_HOME>/agentstoz-skills/`다. `~/.hermes/skills/`는 스킬 허브·큐레이터의
  관리 영역이라 앱이 파일을 얹지 않고, 자기 폴더를 `external_dirs`로 등록한다.
- **파일과 등록이 둘 다 있어야 설치된 것이다.** 하나만 있으면 명령이 안 뜨므로 `updateAvailable`이
  참이다. `config.yaml`은 사용자가 손으로 관리하는 파일이라 YAML 재직렬화 대신 필요한 줄만
  삽입한다 — 주석·키 순서·따옴표가 보존된다.
- ⚠️ **명령을 호스트(로컬/AWS)로 가르지 말 것.** 스킬 본문이 **전부**
  `http://127.0.0.1:3001`을 부르므로 "AWS용 명령"은 존재하지 않는다 — 같은 명령을 **어느
  호스트의 Hermes에 붙여넣느냐**일 뿐이다. 실제로 갈리는 축은 **인자 유무**다:
  경로 인자 있음 → `resolve-project`로 일회성(topic 바인딩 안 함), 없음 → `thread/status`로
  현재 topic. 패널은 이 축으로 두 그룹(`project-memory-hermes-topic-commands` /
  `-path-commands`)을 나눈다. ⚠️ `/memory_link`·`/hermes_open`은 **memoryId 인자를 받지만
  topic 그룹**이다 — 그 인자는 대상 선택이지 topic 우회가 아니다. 그래서 그룹 제목은
  「인자 없이」가 아니라 「이 topic 기준으로 실행」이다.
- **topic 명령 목록은 `hermesTopicCommands` 표 하나에서 렌더되고, 설치되는 스킬
  (`templates/hermes/*`)과 1:1이어야 한다.** 예전에는 8개 중 5개만 버튼이었고
  `/memory_start`·`/memory_stop`은 각주 한 줄, `/hermes_open`은 아예 없었다 — 정작 Hermes는
  그 스킬들을 전부 로드하므로 Telegram 메뉴에 뜨는 목록과 앱이 어긋났다(VOC로 접수됨).
  새 스킬 템플릿을 추가하면 이 표에도 행을 추가할 것. 테스트가 `templates/hermes/`를
  읽어 누락을 잡는다. **순서는 빈도가 아니라 실행 순서(연결 → 사용 → 해제)** 이고 `step`
  필드가 그 구분을 낸다 — 전부 topic 바인딩을 전제하므로, 빈도순으로 `/remember_session`을
  맨 위에 두면 새 topic에서 가장 먼저 보이는 명령이 곧 가장 먼저 거절되는 명령이 된다.
  연결 단계는 `/project_start`(프로젝트 폴더째 새로) → `/memory_start`(기억만 새로) →
  `/memory_link`(기존에 잇기) 셋 중 하나다.

### `/project_start` 와 `/memory_start` 는 만드는 것이 다르다 (v12)

둘 다 폴더를 만들고 기억을 깔고 topic에 바인딩한다. **갈리는 것은 폴더의 위치뿐**이고,
그 차이가 "코드를 둘 수 있는가"를 정한다.

| | 위치 | 쓰는 때 |
|---|---|---|
| `/project_start <이름>` | 등록된 **작업 루트** 아래 사람이 읽는 이름 | 실제로 만들 프로젝트 |
| `/memory_start [이름]` | 앱 데이터 폴더 안 `telegram-memory-<uuid>` | 코드 없이 대화만 남길 때 |

- 위치 규칙의 정본은 `src/projectStartLocation.ts` 한 곳이다(파일시스템을 건드리지 않는
  순수 함수). 루트 **2개 이상 → 되물음**(`needsRoot`), **1개 → 안 묻고 사용**(고를 것이
  없는데 묻는 것은 잡음), **지정된 루트는 등록된 것 중 하나여야 함**(오타 하나로 홈 밖에
  폴더가 생기면 사용자는 그것을 찾지 못한다).
- 루트가 하나도 없으면 홈 아래 `~/projects/<이름>`에 만들고 **만든 경로를 반드시 알린다**
  (`rootWasDefaulted: true`). 한동안 이 경우를 거절했는데, 그 판단은 "루트가 없는 호스트 =
  메시지 중계일 뿐"이라는 좁은 전제 위에 있었다. AgentsToZ와 Hermes가 깔린 AWS는
  **에이전트가 실제로 코드를 쓰는 곳**이라 거기 만든 폴더는 빈 폴더가 아니다. 게다가 그 호스트는
  GUI가 없어 작업 루트를 등록할 방법이 마땅치 않아서, 거절하면 거기서는 프로젝트를 시작할 길이
  아예 없어진다. ⚠️ 위치를 사용자가 고른 것이 아니므로 **경로를 말하지 않으면 자기 프로젝트가
  어디 있는지 모르는 상태**가 된다 — 그래서 알림이 이 경로의 필수 조건이다.
- 판정 축은 **OS가 아니라 작업 루트 등록 여부**다. 루트 등록은 "나는 이 호스트에서
  작업한다"는 선언이라, 로컬 맥과 **원격 개발 상자로 쓰는 AWS**를 한 규칙으로 덮는다.
  OS로 가르면 후자를 틀리게 막는다.
- 이름은 폴더명이 되므로 **파일시스템에 닿는 입력**이다(`sanitizeProjectFolderName`):
  경로 구분자·제어문자 제거, 선행 점/대시 제거(`.hidden`·`..`·`-flag` 차단), 60자 컷.
  이미 있는 폴더는 **덮지 않고 거절**한다 — 사용자의 작업이 들어 있을 수 있다.
- ⚠️ 메뉴 plugin(`__init__.py`)은 스킬과 달리 **버전 마커가 스탬프되지 않고 그대로
  복사**된다. 상수만 올리고 그 파일을 잊으면 `menuPluginInstalled`가 조용히 false가 되어
  Telegram 메뉴에서 명령이 통째로 사라진다(v12에서 실제로 났다). 테스트가 마커 일치와
  스킬 1:1 등록을 함께 잡는다.
- ⚠️ **Hermes 템플릿의 정본은 저장소 루트 `templates/` 다.**
  `src-tauri/resources/templates/`는 `build-sidecar.ts`가 만드는 **gitignore된 사본**이라,
  거기를 고치면 다음 빌드에 지워진다.
- ⚠️ **같은 명령에 복사 버튼을 둘 두지 말 것.** `/remember_session <경로>` 버튼이 「로컬
  터미널 AI」 줄과 Hermes 상자 양쪽에 있었고 **복사되는 문자열까지 같았다** — 각각 다른
  시점에 테스트까지 붙으며 쌓인 중복이다. 이제 버튼은 항상 보이는 로컬 줄 하나뿐이고
  (로컬 터미널에서는 인자형만 동작한다), Hermes 상자는 의미만 문장으로 남긴다.
  `/memory_stop`처럼 동작이 같은 별칭은 표에 `aliasOf`로 남겨 대상 행의 꼬리말이 된다 —
  표에서 지우면 Telegram 메뉴에는 있는데 앱에는 없는 어긋남으로 되돌아가고, 버튼을 주면
  "무엇이 다른가"를 되묻게 된다. 테스트가 두 중복을 모두 막는다.
- **호스트 스위치(`Telegram → 이 PC의 Hermes` / `Telegram → AWS의 Hermes`)는 목록을
  복제하지 않는다.** 축은 "Telegram으로 **무엇을 제어하는가**"이고, 그것을 정하는 것은
  **그 대화를 받는 gateway가 도는 호스트**다(호스트마다 하나씩 띄운다). 라벨에 대상만 적으면
  (`이 PC의 Hermes`) 로컬 터미널에서 Hermes를 쓰는 이야기와 섞여 읽힌다 — 그 축은 이미
  「로컬 터미널 AI」 줄이 맡고 있다.
  판정은 `src/hermesCommandHost.ts` 한 곳. 명령 문자열은 호스트로 갈리지 않지만(전부
  `127.0.0.1:3001`), **실제로 갈리는 것이 셋 있다** — 이 셋만 스위치가 다시 칠한다:
  ① `/hermes_open`은 데스크톱 창을 여므로 화면 없는 호스트에서는 **해당 없음**
  (실측 근거: `awsUbuntuMemorySetup.ts`의 AWS 설치 검증이 요구하는 스킬은 6개이고
  `hermes-open`이 빠져 있다 — AWS Telegram 메뉴에 7개만 뜬 이유), ② 경로 인자 기준 호스트,
  ③ 무엇이 저장되는가(그 호스트의 폴더·세션 기록). 설치 상태는 **로컬일 때만** 표시한다 —
  읽을 수 없는 원격을 로컬 판정으로 칠하면 잘 도는 명령이 미설치로 보인다. 선택은 기기별
  localStorage(`portmanager-hermes-command-host`)이고, 깨진 값은 **로컬**로 떨어진다. 각 행은 한 줄 설명을 갖고, 설치 상태를 **읽을 수 있을 때만**
  「이 PC의 Hermes에는 아직 없음」을 표시한다(AWS에만 Hermes가 있는 사용자에게 전
  목록을 미설치로 칠하지 않기 위해). 예전 "AWS·Telegram Hermes" 상자는 없는 구분을 만들고 이 구분을
  감췄고, 그 결과 Mac 절대경로가 박힌 `/remember_session <경로>`를 AWS Telegram에 붙이면
  실패한다는 사실이 UI 어디에도 없었다.
- 호스트를 건너 옮겨 다니는 값은 **`memoryId` 하나뿐**이다(`/memory_link`). 나머지 넷은
  붙여넣은 호스트 안에서만 의미가 있다.
- **설치 버튼 라벨은 남은 작업을 말한다** — `hermesPendingWork()`(같은 파일). `(7/7)` 같은
  설치 개수는 "완료"로 읽히는데, 실측에서 남은 일이 레거시 별칭 삭제 하나뿐인데도 그 라벨이
  떠 있었다. 그래서 `detectHermesProjectMemoryAdapter`가 `legacyAliasPresent`를 **밖으로
  내보낸다** — `updateAvailable`에만 먹이고 버리면 UI가 이유를 말할 수 없다. 새 설치 조건을
  추가하면 이 함수에도 라벨을 추가할 것.
- ⚠️ **새 명령을 깐 뒤의 갱신 경로 — 셸 재시작만 막히고, 나머지 둘은 열려 있다.**
  실행 중인 게이트웨이는 스킬 목록을 캐시하므로(`get_skill_commands()`) 새 스킬이 바로
  인식되지 않는다. 갱신하는 길은 셋인데 하나만 막혀 있다:
  - **셸 `hermes gateway restart` → 막힘.** 터미널 도구가 거절한다 —
    *"cannot restart or stop the gateway from inside the gateway process"*, 그 대화를 돌리는
    것이 바로 그 게이트웨이라 SIGTERM이 명령 자신에게 전파되기 때문이다
    (`tools/terminal_tool.py`의 `contains_gateway_lifecycle_command_or_referenced_script`).
  - **슬래시 `/restart` → 정상.** core 명령이고("Gracefully restart the gateway after draining
    active runs") 활성 작업을 정리한 뒤 재시작한다. 봇이 몇 초 끊긴다.
  - **슬래시 `/reload_skills` → 정상, 무중단.** 기본으로 이것을 안내한다.
  ⚠️ 이 셋을 뭉뚱그려 "재시작은 막힌다"고 쓰지 말 것 — 실제로는 열려 있는 길을 막혔다고
  안내하게 되고, 화면 없는 호스트의 사용자를 SSH로 내몬다(그렇게 틀린 적이 있다).
  **무중단 경로는 `/reload_skills`** — 게이트웨이 core 명령이고 스킬 디렉터리를 인프로세스로
  다시 스캔한다. ⚠️ **디스패치와 자동완성 메뉴를 묶어서 말하지 말 것**: `/reload_skills`는
  실행을 되살리지만 Telegram BotCommand 목록은 갱신하지 않는다(그 어댑터에는
  `refresh_skill_group`이 없다 — Discord에만 있다). 즉 **메뉴에 없어도 직접 입력하면 실행된다.**
  메뉴는 다음 게이트웨이 재시작 때 `set_my_commands`로 갱신된다.
- ⚠️ **서버 응답에 없는 필드를 「아니오」로 읽지 말 것.** 앱은 **이미 떠 있는 로컬 API를
  그대로 채택**하므로 UI가 sidecar보다 새로운 상태가 상시 가능하다. 실측(2026-08-14):
  앱이 물고 있던 sidecar 응답에 `hermesCliPath` 키가 아예 없었는데 UI가
  `typeof status?.hermesCliPath === 'string'`으로 읽어 **`false`(=미설치 확정)**로 승격시켰고,
  Hermes가 멀쩡히 깔린 기기(`/Users/…/.local/bin/hermes`)에서 실행 버튼이
  "설치되어 있지 않습니다"로 막혔다. 판정은 `hermesCliAvailabilityFromStatus`
  (`src/hermesCliPresence.ts`) 한 곳이고 **세 값**이다 — `true` / `false`(서버가 찾아보고
  없다고 답함) / `null`(판단 불가 → 막지 않고 서버 409에 맡김). 새 필드를 읽는 UI 판정은
  전부 이 규칙을 따를 것.
- **Hermes가 없는 기기에서도 안내는 남긴다**(`project-memory-hermes-absent`). 그 상태가
  정확히 AWS에만 Hermes가 있는 사용자이고, 안내가 가장 필요한 경우다. 예전에는 그때 줄
  전체가 사라져서 "어디에 뭘 설치해야 하는지"가 0이었다. 이 앱은 로컬 `~/.hermes`만 다룰 수
  있고(원격 호스트 개념 없음), 다른 호스트는 「AWS Ubuntu 설정 프롬프트」 경로다.

### 색인은 remember마다 다시 만든다

스킬은 에이전트에게 "노트에 쓰고 색인은 건드리지 마라"고 시킨다. 그런데 **그 노트로부터 색인을
다시 만드는 코드가 없으면** 스킬 경로로 저장할수록 색인이 낡는다. 두 경로가 공통으로 부르는
`markProjectMemoryRemembered`가 시작 시 `refreshMemoryIndex`로 재생성한다(결정적·멱등).

- 노트가 없어도 **remember는 통과시킨다.** 파생 파일 때문에 세션 기록을 잃는 쪽이 더 나쁘다.
- 같은 이유로 `detectProjectMemory`는 던지지 않는다 — 패널이 이걸 폴링하므로 던지면 기억 UI가
  통째로 에러가 된다. 거절은 데이터를 지키는 자리(push·merge용 읽기)에만 남긴다.

### 버튼 저장의 narrative

앱 버튼 뒤에는 세션이 없어서 저널에 커밋 제목만 남았다. 이제 통합 프롬프트가 첫 줄에
`SESSION: <한 문장>`을 요구하고 `extractSessionNarrative`가 그것만 떼어내
`markProjectMemoryRemembered`에 넘긴다. 문서 본문 안의 `SESSION:` 은 내용이지 요약이 아니므로
**머리말에서만** 읽는다. 없어도 오류가 아니다 — 저널 항목은 git만으로도 써진다.
## 환경 단위 설치·연결은 장기기억 탭 한 곳에만 둔다

「앱 없는 PC용」·「다른 폴더 수동 설치」·「AWS Ubuntu 연결」·「Telegram Bot 일괄 온보딩」은
**프로젝트 하나가 아니라 PC·서버 한 대에 한 번** 하는 작업이다. 그런데 프로젝트 상세의
장기기억 패널과 장기기억 탭 양쪽에 있어서, 사용자가 무엇이 프로젝트 단위이고 무엇이 환경
단위인지 구분하지 못했다 (VOC 2026-08-28 3건).

- 복사 버튼의 정본 자리는 **장기기억 탭의 `portal-memory-external-setup`** 하나다.
  프로젝트 → Hermes profile 연동, profile → Telegram Bot 연동, Buzz Agent 연결은 이미
  그 위 `portal-memory-onboarding-actions` 에 더 나은 형태(선택 확인 모달)로 있다.
- 프로젝트 패널에는 `project-memory-external-setup-pointer` 한 줄과
  `project-memory-open-memory-tab` 버튼만 남긴다. **버튼을 말없이 지우지 말 것** —
  사라진 기능으로 읽힌다. 탭 이동은 `onOpenMemoryTab` prop 으로 받고, 없으면 문구만 보인다.
- 프롬프트 **문자열의 정본은 `src/externalMemorySetupPrompts.ts`** 하나다. 두 프롬프트는
  프로젝트 이름·경로를 인자로 받지 않는다 — 받는 쪽 에이전트가 자기 PROJECT_ROOT 를 구하므로
  어느 프로젝트를 골라도 문자열이 같고, 그래서 프로젝트마다 버튼을 둘 이유가 없다.
- 라벨은 **동작이 아니라 용도**를 먼저 말한다(「다른 폴더에서 수동 실행」 → 「앱은 있는 PC의
  다른 폴더에 장기기억 만들기」). 용도가 안 보이면 언제 쓰는 버튼인지 알 수 없다는 지적이
  실제로 들어왔다.
- 문자열 내용을 고치면 `CURRENT_PROJECT_MEMORY_VERSION` 을 올린다. **자리를 옮기기만 한
  것은 올리지 않는다** — 설치되는 내용이 같은데 번호가 오르면 전 프로젝트가 구버전이 된다.
