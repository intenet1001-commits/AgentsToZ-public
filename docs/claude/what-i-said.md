# 내가 한 말(What I Said)

## 개인 프로필과의 경계

사람이 확인한 선호는 [내 프로필](../user-profile.md)의 전용 로컬 정본 하나에 둔다. What I Said의
프로젝트별 암호화 DB나 OPS 운영 기억에 섞지 않는다. 첫 구현은 직접 작성·확인·수정·사용 중지이며
원문 자동 분석·복사·AI 추론 저장을 하지 않는다. 장기기억과 원문 화면의 이동만 연결한다.
`recall_user_profile`의 활성 선호와 `recall_user_memory`의 과거 지시는 다른 근거이고 현재 지시가 우선한다.
개인 계정 바인딩을 검증하기 전에는 service-role 연결이나 OPS profileId를 사람의 정체성으로 사용하지 않는다.

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## What I Said — 비싼 것은 검색이 아니라 프로젝트 열거였다

`registeredWhatISaidProjects()`가 memoryId마다 `resolveRegisteredProjectMemory`를 부르고, 그 안에서
**등록된 모든 후보 경로마다** `detectProjectMemory`(git 2회 spawn)를 돌린다. 실측 138행/95별칭/41
lineage 기기에서 **한 번의 호출이 3,908회 spawn**이었고, `Bun.spawnSync`는 양보하지 않으므로 단일
스레드 API 서버 전체가 그동안 멎었다.

| 경로 | 개선 전 | 개선 후 |
|---|---|---|
| 「모든 프로젝트」 라이브러리 | **51.9s** | 2.2s(cold) / 0.8s(warm) |
| 외부 앱 feed(서명 요청) | **50.2s**(90s `idleTimeout`에 소켓 끊김) | 1.49s / 0.10s |

- 해결은 열거를 **identity 전용 비동기 캐시**로 바꾼 것이다(`src/projectMemoryIdentityCache.ts` —
  async git·동시 4개·in-flight 공유·TTL). What-I-Said는 60초, 장기기억 resolve 계열
  (`resolve-project`·`open/refresh-resolved`·`dispatch-worker`·`project-route`·`thread/*`·`memory-ids`)은
  `registeredProjectMemoryRootResolver`로 **5초**다. 음수 결과도 캐시해야 한다
  (95개 별칭 중 41개만 초기화돼 있어, 실패를 캐시 안 하면 절반밖에 못 줄인다).
  resolve 계열은 열거만 캐시하고 **골라낸 루트 하나에는 전체 detect를 다시 돈다**(쓰기 게이트는 신선한 판정).
  메모리를 만드는 경로는 `initializeProjectMemory` 래퍼가 두 캐시를 함께 비운다.
- ⚠️ **`detectProjectMemory`(전체 detect)를 전역으로 캐시하지 말 것** — 「세션 기억하기 필요」 배지가
  이 결과를 폴링하므로 배지가 늦어진다. `/api/project-memory/detect`는 여전히 캐시하지 않는다.
  유일한 예외는 프로젝트 패널의 `/api/project-memory/panel-status`(`scope: 'local'`) 스냅샷이고,
  지연을 **묶어 둔** 형태다: 2초 안은 공유, 60초까지는 이전 답을 `stale: true`로 즉시 주고 백그라운드에서
  한 번 다시 detect, 패널은 stale을 받으면 1.5초 뒤 한 번 더 읽는다(`src/projectMemoryPanelStatus.ts`).
- ⚠️ 파괴적 경로(`survivingRegisteredWhatISaidLineage` 등 소스 해지 범위 검사)는 **캐시를 쓰지 않는다** —
  신선한 `detectProjectMemoryIdentitySync`/`detectProjectMemory`만 쓴다.
- What-I-Said 해석 캐시는 별도로 5초다(`WHAT_I_SAID_PROJECT_RESOLUTION_CACHE_MS`); 감지 메모 60초는
  `WHAT_I_SAID_MEMORY_DETECT_TTL_MS`다.
- ⚠️ 사용자는 "검색 때문에 느린 것 같다"고 지목했지만 **검색은 원인이 아니었다**(입력은 서버 작업
  0회, 제출 때만 조회). 지목된 곳이 아니라 측정된 곳을 고칠 것.
- `configure-all`은 preflight와 apply가 각각 열거해 **두 번** 쓸었다. preflight가 목록을 돌려주고
  apply가 그것을 받는다(`options.projects`) — reconcile 경로는 preflight가 없으므로 optional 유지.

## What I Said — 원격은 기다리지 않는다 (로컬 먼저 · 차단기 · 적재 게이트)

라이브러리는 매 요청 Supabase 왕복(범위 순회·제외 목록·목록 RPC, 각 8초 타임아웃)을 먼저 기다렸고,
15초 순환 수집은 새로 담은 것이 없어도 매번 원격 적재(제외 목록·커서·정리 RPC)를 했다. 장애 중에는
둘 다 쉬지 않고 두드렸다. 상태 기계의 정본은 `src/whatISaidRemoteThrottle.ts` 한 곳이다.

- **목록은 로컬 먼저.** 패널이 `source: 'local'`로 이 Mac 기록 한 페이지를 바로 그리고, 이어서
  `source: 'remote'`로 공유 기록을 읽어 교체한다(`loadWhatISaidLibraryLocalFirst`). 응답의
  `localFirst: true`가 있을 때만 두 번째 요청을 한다 — 옛 sidecar는 `source`를 무시하고 원격 우선으로
  답하므로 두 번 물으면 느린 왕복만 두 배가 된다. 기본값 `auto`(외부 호출자·프롬프트 가이드)는 예전처럼
  원격 우선이다. 「더 불러오기」는 **지금 보이는 목록의 출처**로 이어 읽는다(커서 형식이 다르다) —
  그 출처는 ref(`listSourceRef`)에 둔다. state로 두면 `loadPrompts`가 바뀌어 목록 전체를 다시 읽는다.
- **차단기**(`WhatISaidRemoteBreaker`, 15초에서 두 배씩 최대 10분)를 목록·`remote/status`·순환 적재가
  **함께** 본다. 열려 있으면 `auto`는 원격을 부르지 않고 로컬로 답하며 `remoteDegraded`/`remoteRetryAt`을
  싣고, `remote`는 즉시 503 `WHAT_I_SAID_REMOTE_DEGRADED`다. 사용자가 누른 「동기화」만 차단기를 무시한다.
  ⚠️ **차단기는 원격 실패만 연다.** 적재 중 로컬 저장소 읽기·복호화·레닥션 실패(`WhatISaidLocalPushError`
  → `localFailure`)로 열면, 저장소 하나의 문제가 라이브러리 전체를 「Supabase가 응답하지 않는다」로
  거짓 보고한다. 연결 대상(URL·키)이 바뀌면 차단·캐시·게이트를 모두 비운다(`noteWhatISaidRemoteTarget`).
- 원격 새로고침 중에는 「더 불러오기」를 **숨긴다.** 로컬 커서로 이어 읽으면 요청 번호가 바뀌어 원격
  새로고침이 버려지고, 다른 기기 기록이 빠진 목록이 안내 없이 남는다.
- **제외 목록·클라우드 범위는 60초 캐시**다. 이 기기의 제외·삭제·새 장기기억 적재가 무효화한다. 다른 Mac의
  제외는 최대 60초 늦게 보이지만, 목록 RPC와 적재 트리거가 **DB에서** 제외를 강제하므로 그 사이에도
  제외된 행이 보이거나 올라가지 않는다. 실패는 캐시하지 않는다(적재의 fail-closed 유지).
- **순환 적재 게이트**: 새로 저장한 행이 없고 로컬 최대 seq(`probeWhatISaidMaxSeqReadOnly`, 키·쓰기 잠금
  없이 읽는다)가 마지막으로 올린 지점을 넘지 않았으면 원격 적재를 시작하지 않는다. 한 시간에 한 번은
  확인하고, 실패하면 기억을 지워 다음 기회에 다시 올린다. 만료 정리 RPC도 한 시간에 한 번이다.
  적재가 페이지 상한(200×200행)에서 멈추면(`complete: false`) "여기까지 올렸다"로 기록하지 않는다 —
  기록하면 남은 분이 확인 주기(1시간)까지 멈춘다.
- ⚠️ **원격 검색 인덱스는 마이그레이션만 있고 적용되지 않았다**
  (`20260925020000_what_i_said_trigram_search.sql`) — **그 뒤 적용됐다(2026-10-06 실측: `pg_trgm` 설치됨,
  `portmgr_what_i_said_prompts_body_trgm_idx` 존재).** 적용 전에는 `position()`이 인덱스를 못 써서 검색마다 전 본문을
  NFKC 정규화했다. 같은 식 `lower(normalize(body, NFKC))`에 pg_trgm GIN을 걸고 RPC를 이스케이프한 LIKE로
  바꾼다 — 식이 한 글자라도 다르면 인덱스를 못 쓴다. 인덱스 생성은 표를 쓰기 잠그므로 한가할 때 적용할 것.

## 전체 저장은 "앞으로"의 정책이다 — 과거는 명시적으로만 담는다

`applyWhatISaidGlobalCapturePolicy`는 프로젝트마다 저장소를 만들 뿐 **가져오지 않는다.** 실측 41개
저장소 중 74건이 든 1개만 비어 있지 않았고, 나머지 40개는 "아직 수집된 프롬프트가 없습니다"로 떠서
기능이 고장 난 것처럼 읽혔다.

- 빈 상태는 **셋**이다: 필터 결과 없음 / 아직 수집 전 / 정말 없음. 둘로 뭉치면 방금 켠 사용자가
  고장으로 읽는다. 라이브러리 제목 옆의 저장 건수(`what-i-said-stored-count`)가 그것을 자명하게 한다.
- 과거로 거슬러 담는 것은 **`backfill: true`뿐**이고 사용자 확인을 받는다. 켠 순간이 곧 동의 시점이라,
  정책 토글의 부수효과로 과거 대화를 담으면 안 된다.
- ⚠️ **backfill은 시간 하한만 낮춰서는 동작하지 않는다.** 파일마다 내구성 바이트 커서가 EOF에 있어
  그대로 건너뛴다. `backfill`일 때는 커서를 무시하고 0바이트부터 다시 읽는다 — 저장이 라인별 안정
  event id 기준이라 재읽기는 중복으로 처리되어 안전하다.
- 「지금 수집」은 전체 저장이 켜져 있어도 **누를 수 있는 것이 맞다.** 전역 정책은 앞으로의 세션 저장을
  다루고, 지금 이 순간의 대화를 담는 길은 이 버튼뿐이다. 설명은 버튼 **위**에 둔다 — 아래 두면
  모순으로 읽힌다(VOC 2026-08-31).
