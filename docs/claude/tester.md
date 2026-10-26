# 버전 일괄 갱신 · 프로젝트 테스터 · 페르소나

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 버전 붙은 기능의 일괄 갱신

장기기억 에이전트(`CURRENT_MEMORY_AGENT_VERSION`)와 저장소 워크플로
(`CURRENT_REPOSITORY_WORKFLOW_VERSION`) 둘 다 installed/current 버전을 갖는다.
**버전을 올리면 이미 설치된 프로젝트가 한꺼번에 뒤처진다** — 실측으로 기억 30/31,
워크플로 36/49가 구버전이 됐고, 갱신 버튼은 프로젝트 패널 안에만 있어 66번 열어야 했다.

- 헤더의 `업데이트 N` 배지(`src/components/BulkUpgradeButton.tsx`)가 백로그가 있을 때만 뜬다.
- `POST /api/upgrade-status` — 전체 폴더를 **서버에서 1회 스윕**. 프로젝트당 왕복 금지.
- `POST /api/upgrade-batch` — `target`('memory'|'workflow') 직렬 실행, **프로젝트별 성공/실패**
  개별 반환. 부분 실패는 부분 실패로 보고한다.
- 스캔은 **폴링하지 않는다.** 백로그는 앱을 새로 깔 때만 바뀌는데 파일시스템 작업은 매번 든다.
- 집계 대상은 활성 섹션이 아니라 **전체 프로젝트 목록**이다.
- ⚠️ 새로 버전을 붙이는 기능을 만들면 이 두 엔드포인트에 함께 등록할 것.
- **프로젝트 테스터도 이 백로그에 든다**(target `tester`). 상태 스윕은 `.agentstoz/tester-agent.json`의
  `templateVersion`만 읽고(프로젝트마다 Python을 띄우지 않는다), 갱신은 `TesterAgentHost.ensure()`가 한다 —
  ensure가 자기 워크스페이스 lease를 잡으므로 batch의 공용 `withManagedWorkspaceLease`로 감싸지 않는다(자기 자신을 막는다).
  테스터가 **없는** 프로젝트는 백로그가 아니다(그러면 배지가 130개가 된다) — 설치는 아래 자연어 경로가 맡는다.

### 페르소나 검사 — 공통 러너의 `personas` 동작 (러너 1.5.0, 2026-10-08)

사용자 목표(페르소나)를 실제 테스트에 묶는 검사가 **공통 러너에 들어갔다** — 예전에는 이 저장소의
`scripts/persona-tests.py`에만 있어 다른 프로젝트는 쓸 수 없었다. 이제 어느 프로젝트든 자기 카탈로그로 쓴다.
**판정은 테스트의 종료 코드뿐이고 러너는 AI를 부르지 않는다.**

- **카탈로그**: 프로젝트 계층 `.agentstoz/personas.json`(그 프로젝트 Git 소유). 이 저장소는 옛
  `tests/personas/catalog.json`을 그대로 읽고, 둘 다 있으면 거절한다. `schemaVersion:1`, 페르소나마다
  `{id, goal, tests[], explore?}`이고 모르는 키는 거절한다.
- **근거 항목 세 가지**(언어·도구 중립): `{"check":"<maintainer.json 검사 id>"}`(kind 기본 contract — 화면 근거로
  부풀리지 않는다), `{"argv":[...],"kind":"contract|screen",…}`(kind 필수, `{python}`·`{root}`·`{env:X}` 자리표시자),
  그리고 옛 단축형(`*.test.ts` → `bun test`, `*.mjs` → 화면 스크립트).
- 옛 규칙은 그대로 옮겼다: **빈 `tests`는 거절**(`all([])`이 True라 이름만 추가한 페르소나가 0회 실행으로
  통과했다), id 중복·경로 탈출·심링크 거절, 종류별 제한 시간, 같은 명령은 한 번 실행해 나눠 붙임, 화면 근거가
  없으면 「source contracts only, no rendered screen」.
- 명령: `personas list|run|brief <id>|observe <id> --findings <파일>`. 카탈로그가 없으면 `run`은 **종료 코드 78**
  (「통과도 실패도 아님」 — 깨진 것과 구분). 결과는 일반 실행 보고서·이력에 프로필 `personas`로 남고, `inspect`·
  `capabilities`가 페르소나 지원을 알린다. 이 저장소의 `persona-tests.py`는 러너를 부르는 얇은 래퍼다.
- **AI 탐색은 초안으로만 넘어간다(3단계).** `personas brief`가 목표·`explore.successCriteria`·`forbidden`·기존 근거·
  보고 형식을 담은 브리프를 만들고, 앱(ProjectTesterPanel 「AI 탐색 초안」)과 MCP(`prepare_tester_handoff`의
  `mode:'explore'`+`personaId`)가 그것을 **워크룸 초안**으로 넣는다 — 보내지 않고 저장하지 않는다(16,000바이트·safeText).
  브리프는 AI에게 ① 실제 화면을 조작하고 ② 결함마다 근거를 남기고 ③ 확인된 결함을 **결정적 회귀 테스트로 만들어
  그 페르소나의 `tests`에 추가**하고 ④ 탐색 자체를 PASS/FAIL로 보고하지 말라고 한다.
- ⚠️ **탐색 결과는 판정에 들어가지 않는다.** `observe`는 `.agentstoz/maintainer/exploration/<id>/`에
  `exploratory/observed`로만 쓰고 실행 보고서·이력·통계에 넣지 않는다. 판정처럼 보이는 키(verdict·pass·fail…)가
  든 기록은 거절한다. `persona_verdicts`는 결정적 검사 상태만 읽는다. 비결정적인 AI 관찰이 통과율을 바꾸면
  그 숫자는 그날 AI의 기분이 된다.
- 다른 프로젝트로 퍼지는 길은 공통 계층과 같다: **앱 빌드(번들 러너) → 일괄 갱신/`ensure`**. 실행(`start personas`)은
  그 프로젝트 러너가 1.5.0일 때만 되고, 상태·브리프는 번들 러너가 읽으므로 옛 러너에서도 보인다.
- 검증: `tests/maintainer/test_personas.py`(`ExplorationBoundaryTests` — 탐색 기록이 있어도 실패 테스트면 FAIL,
  판정 키 거절, 브리프는 파일을 쓰지 않음·최대 크기에서도 규칙이 남음), `tests/maintainer/test_persona_tests.py`,
  `tests/tester-personas.test.ts`, `tests/project-tester.e2e.mjs`의 `personas`·`personas-none` 시나리오.

### 공통 테스터 계층의 학습 루프 — 후보는 모으고, 퍼지는 것은 커밋뿐 (2026-10-06)

장기기억·프로젝트별 시나리오에서 배워 **공통 계층**을 올리는 길이 하나도 없었다(공통을 늘리는 유일한
수단이 러너 소스를 손으로 고쳐 앱을 배포하는 것이었고 `accept_scenario`는 `common.*`을 하드 거절한다).
이제 세 조각이 있다.

1. **러너 `scenarios promote`** (`scripts/agentstoz-maintainer.py`, `promotion_candidates`) — **읽기 전용**이다.
   프로젝트 계층 시나리오마다 증거(통계의 `passed/failed/blocked` 합, `flakyRate`, `lastState`,
   `averageSeconds`)와 **이식성**(argv 토큰이 이 프로젝트에만 있는 경로·스크립트를 가리키는지,
   `PORTABLE_ARGV`)을 적고 `blockers`로 이유를 나눈다. ⚠️ 「아직 증명되지 않았다(runs<3)」와
   「증명됐지만 이 프로젝트에 묶여 있다」는 **다른 답**이라 합치지 않는다. 후보 id 는 `candidate.*`이고
   **`common.*`을 만들지 않는다** — 이름과 승격 여부는 사람·AI가 정한다. `writes: []`가 계약이다.
2. **앱의 자리 = 헤더 「업데이트 N」 배지 팝오버의 행 하나**(`bulk-upgrade-row-promote`).
   사용자가 원한 「아젠투지를 업그레이드할 때 필요하면 작동」이 **그 배지의 정의 그 자체**다(러너 버전이
   오르면 설치된 전 프로젝트가 백로그가 되고 사용자가 여는 곳이 정확히 그 팝오버다). 후보 **수집은
   그 스윕에 얹혀 자동**(`.agentstoz/scenarios/project/`에 파일이 있는 폴더만 센다 — `readdir` 한 번,
   `tester-agent.json` 읽기와 같은 비용 등급)이고 **적용은 사람이 누른다**. ⚠️ 그 스윕은 **타이머로 돌지
   않는다**(기존 주석의 계약) — 승격도 같다. 항목이 0이면 행도 배지도 화면에 남지 않는다.
3. **`/api/upgrade-batch` `target:'promote'`** — 폴더마다 `promote`를 모아 앱 데이터
   `tester-promotion/<시각>.json`에 보고서 한 장만 남긴다(0600). 프로젝트는 **하나도 바뀌지 않는다**.

⚠️ **공통 계층이 전 프로젝트로 퍼지는 경로는 하나뿐이다: 이 저장소 커밋 + 러너 `VERSION` 상승 + 일괄
갱신.** 사용자 기기에서 번들 밖 공통 overlay에 직접 쓰는 설계를 고르지 말 것 — `RELEASED_RUNNERS`
해시 장부와 `inspect_project`의 해시 동일성 판정, `managedRunnerHash` conflict 판정이 전부 무의미해진다.
`setup_plan`의 `allowed`가 `COMMON_SCENARIOS`만 허용하므로 **승격 대기 중인 후보는 어떤 프로젝트에도
설치되지 않는다.**
- ⚠️ **러너 소스를 고치면 `VERSION`을 올리고 이전 버전의 해시를 `RELEASED_RUNNERS`에 남긴다.**
  남기지 않으면 그 버전을 들고 있는 프로젝트가 metadata 없이 「직접 고친 러너」(conflict)로 읽혀
  `ensure`가 거절한다. `tests/maintainer/test_maintainer.py`의 두 테스트가 이것을 강제한다.
- **`ensure`가 끝날 때 `scenarios discover`를 한 번 돈다**(`src/testerAgentHost.ts`). 자연어 경로의 유일한
  입구라서, 이것 하나로 프로젝트별 계층이 **자동으로 자란다**(그 전에는 이 저장소만 `project=15`,
  나머지 22개는 전부 `project=0`이었다). discover 는 제안만 쓰고 **아무 것도 실행하지 않으므로**
  「테스트를 돌리지 않는다·커밋하지 않는다」 계약을 깨지 않고, 제안은 gitignore 된
  `.agentstoz/maintainer/`에만 쓰인다. 실패해도 ensure 결과를 바꾸지 않는다.
- **변경 파일 짝짓기는 언어·모듈을 넘지 않는다 (러너 1.4.0, 2026-10-06).** `discovered:changed-test-file`이
  이름 조각만 맞춰 짝을 지어, 실측에서 통역사의 네 제안 중 **셋이 오탐**이었다 —
  `backend/tests/test_fanout_realtime.py` ← `ios/…/Fanout.swift`(Swift를 고치면 파이썬 테스트를 돌리라는 뜻),
  `test_quality_metrics.py` ← `scripts/eval/metrics.py`, `test_settings_keys.py` ← `frontend/…/settings.ts`.
  판정은 `covers_changed_source` 한 곳이고 두 조건을 함께 본다: ① **같은 언어 계열**(이 러너가 인식하는
  테스트는 Python과 JS/TS뿐이라 다른 생태계의 소스는 그 테스트가 덮을 수 있는 대상이 아니다),
  ② **같은 모듈 루트**(가장 가까운 매니페스트까지 올라가 비교 — 모노레포의 `backend/`와 `frontend/`는 다른
  프로그램이고, 한 모듈 안의 `tests/ ↔ src/`는 둘 다 같은 루트로 떨어져 그대로 짝이 된다).
  ⚠️ **「같은 top-level 디렉터리」로 구현하지 말 것** — 가장 흔한 `tests/ ↔ src/` 배치가 통째로 죽는다.
  적용 결과(실측): 통역사 4 → 1, 전체 `changed-test-file` 제안은 2건만 남았고 둘 다 같은 모듈·같은 언어의
  정당한 짝이었다(`tools/edgtts_csversion/`). 검증은 `tests/maintainer/test_maintainer.py`의
  `ChangedTestFileDiscoveryTests` — 그 세 짝이 거절되는지, 한 모듈의 `tests/ ↔ src/`가 web·python 둘 다
  남는지를 함께 본다.
- **제안 사슬을 끝까지 돌린 실측 (2026-10-06).** 러너 1.4.0을 번들에 넣어(v622) 일괄 갱신 26개 프로젝트
  성공 → 각 `ensure`가 `discover`를 다시 돌려 제안이 새 규칙으로 재생성 → 28건 전부 `scenarios accept`.
  프로젝트 계층 시나리오가 **15 → 43**, 시나리오를 가진 프로젝트가 1 → **14개**가 됐다(그 전에는 이
  저장소만 사슬이 끝까지 돌았다). `freeparking-1`에서 quick 프로필이 실제로 통과하는 것까지 확인했다.
  ⚠️ **수락은 파일만 쓰고 커밋하지 않는다** — 14개 프로젝트에 미커밋 변경이 남아 있고, 각 프로젝트의
  Git에 넣는 것은 그 프로젝트에서 승인받아 할 일이다. 이 저장소에서 대신 커밋하지 말 것.
- ⚠️ **러너의 하위 동작과 그 대상(`scenarios accept <id>`)은 플래그보다 앞에 와야 한다** — argparse 가
  `nargs='?'` 위치 인자를 옵션 뒤에서 받지 못해 `unrecognized arguments`로 죽는다(실측 두 번: 동작에서
  한 번, 대상에서 또 한 번). `python()`의 `leading` 인자가 그 위치 인자들이고 `args` 가 플래그다.
- **발견된 제안을 읽고 받아들이는 길**(`proposals`·`accept`, MCP `agentstoz_use_list_tester_proposals`·
  `agentstoz_use_accept_tester_scenario`). 이것이 없던 동안 `discover` 가 제안을 만들어도 **와이어에
  읽을 방법이 아예 없어** 사슬이 제안 단계에서 끊겼다 — 실측(2026-10-06): 러너를 23개 프로젝트에 퍼뜨린
  직후 **12개에 제안이 쌓였는데 시나리오가 된 프로젝트는 하나뿐**이었다. `accept` 는 쓰기라 원격 차단
  목록(status·start·read·cancel)에 걸려 휴대폰에서는 쓸 수 없고, 러너가 `project.<name>` 만 받으므로
  이 길로 **공통 계층은 바뀌지 않는다**.
  ⚠️ 테스트는 제안을 **직접 심어** 검사한다 — 최소 픽스처에서는 `discover` 가 아무 것도 제안하지 않아
  (실측 0건) 그대로 두면 사슬 테스트가 조용히 통과한다.
- **러너는 AI를 부르지 않는다**(선언이자 코드의 사실). 「어느 후보를 공통으로 올릴까」는 LLM 판단이므로
  러너가 하지 않고 보고서를 읽는 사람·워크룸 AI가 고른다.
- 검증: `tests/maintainer/test_maintainer.py`의 `PromotionCandidateTests`(아무 파일도 쓰지 않음 ·
  `candidate.*`만 · 두 blocker 를 구분), `tests/bulk-upgrade.test.ts`의 승격 행 묶음.

### 프로젝트 테스터는 자연어로 시작된다 (`/api/project-tester/ensure`)

- 네 에이전트의 상시 지침(공유 출력 블록의 `PROJECT_TESTER_AUTO_SETUP_POLICY`)이 «이 프로젝트를 테스트해»류 요청에서
  `.agentstoz/maintainer.json`이 없으면 이 엔드포인트를 curl로 부르게 한다. 앱에서 설정 버튼을 누르지 않아도 된다.
- 서버가 안전을 판정한다: **등록된 프로젝트만**(폴더·연결 워크트리 → 주 체크아웃 → 등록 id), 설치 위치는 주 체크아웃,
  상태 `absent`/`partial`/`needs-update`만 쓰고 `conflict`(러너를 직접 고침)·`unsupported`·Python 없음은 `skipped`+이유.
  setup-plan이 직접 고친 러너·스킬을 거절하므로 덮어쓰지 않는다. **테스트를 돌리지 않고 커밋하지 않는다.**
- 문구를 바꾸면 `CURRENT_PROJECT_MEMORY_VERSION`을 올린다(v22에서 도입) — 공유 블록이 프로젝트 지침 파일에도 들어가기 때문이다.
- **장기기억 버전의 정본은 `src/projectMemoryVersion.ts`의 `CURRENT_PROJECT_MEMORY_VERSION`
  하나다.** `CURRENT_MEMORY_AGENT_VERSION`은 이 값의 별칭이고, 「앱 없는 PC용」 복사 프롬프트도
  같은 번호를 쓴다. 두 표면 중 **어느 쪽 문구를 고치든 이 상수를 올린다** — 표면마다 번호를 따로
  두면 한쪽만 개선하고 다른 쪽은 "이미 최신"으로 판정돼 개선분이 도달하지 않는다.
- 다만 복사 프롬프트로 설치된 PC는 위 두 엔드포인트의 스윕 대상이 **아니다**(그 파일시스템에
  접근할 수 없다). 그쪽의 갱신 경로는 사용자가 버튼을 다시 복사해 붙여넣는 것뿐이고, 받는 쪽은
  스킬 파일의 `<!-- project-memory:N -->` 마커로 자기 버전을 알아 필요한 만큼만 갱신한다.
