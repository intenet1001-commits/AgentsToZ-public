# AgentsToZ 프로젝트 메인테이너

Python이 먼저 실제 검사를 실행하고, 사람이 결과를 검토하거나 필요한 부분만 AI에 전달한다.
Python은 기존 Bun/Rust/Playwright/Xcode 검사를 대체하지 않고 실행·시간 제한·결과 분류·회귀 비교를 맡는다.
AI가 없어도 검사는 끝나며, AI 제공자와 관계없이 같은 근거를 사용한다.

프로젝트 카드와 상세 화면의 **테스터 에이전트**에서 설정·업데이트·실행·결과 확인·취소를 할 수 있다.
처음에는 **테스터 설정하기 → 설정 적용 → 테스트 실행** 순서다. 검사할 워크트리와 프로젝트에 정의된 프로필을 선택할 수 있다.
장기기억 탭의 **테스트 에이전트 관리**에서 이 기기의 등록 프로젝트를 선택하면 설치 버전과 **앱 제공 버전**, 업데이트 상태를 확인할 수 있다. Supabase 연결 없이도 이 영역은 사용할 수 있다. 프로젝트 상세의 장기기억 영역에서도 같은 정보를 제공한다.
**테스트 에이전트 업그레이드 → 변경 파일 확인 → 설정 적용**으로 공통 실행기와 AI 사용 지침을 갱신한다. 프로젝트별 검사 설정·추가 테스트·장기기억은 보존한다. 직접 수정한 실행기는 검토가 필요하다고 표시하며 덮어쓰지 않는다. 검사 중에는 업데이트를 제한하고, 프로젝트의 테스터가 앱보다 새로운 형식이면 앱 업데이트를 안내한다. 앱 제공 버전은 설치된 앱이 포함한 버전이며 인터넷에서 최신 버전을 조회한 결과가 아니다.
이 버튼은 이미 제공된 공통 버전을 적용하는 기능이다. 장기기억으로 개선 후보를 만들거나 워크룸에서 새 테스트를 작성하는 개선 루프는 실행하지 않는다.
테스트 명령이 없으면 **AI로 테스트 구성**, 실패를 개선하려면 **AI로 개선**을 사용한다. Python이 없거나 설정이 잘못되면 환경 준비 인계문을 제공한다.
Codex·Claude Code는 인계문과 함께 워크룸을 시작한다. Hermes·Antigravity는 **인계문 복사·워크룸 열기** 후 준비된 CLI에 붙여넣는다.
앱은 파일 생성·AI 지침 연결과 실제 검사 결과를 구분한다. 모바일 원격 tester 버튼은 후속 단계이며 현재 프로젝트 원격제어 권한에 추가하지 않았다.
실제 계약과 검증 범위는 [구현 기록](plans/project-tester-agent-2026-09-14/EXECUTION.md), 확장 방향은 [설계](plans/project-tester-agent-2026-09-14/PLAN.md)에 있다.

## 공통 페르소나와 프로젝트별 확장

러너 1.7.0은 **처음 사용자·반복 사용자·실패 후 돌아온 사용자**의 공통 관점 팩 1.0.0을 제공한다.
테스터의 **개발 맥락에 맞는 페르소나 확장 → 공통 페르소나와 프로젝트별 여정**에서 관점을 선택하고
프로젝트의 목표·시작 상황·순서 있는 여정·성공 기준·실제 검사를 연결한다. 등록만으로 AI나 검사를 실행하지 않는다.
응답 유실은 같은 등록 요청으로 확인하고, 개발 맥락이 바뀌면 현재 역할을 읽은 뒤 다시 검토한다.

공통 관점은 앱이 `.agentstoz/personas/common/*.json`에 설치한다. 프로젝트 소유 카탈로그는
`.agentstoz/personas.json`이며 기존 `tests/personas/catalog.json`도 그대로 지원한다. 둘을 동시에 만들지 않는다.
프로젝트 항목의 `extends`는 공통 관점 ID이고 `situation`, `journey`, `successCriteria`, `tests`는 프로젝트가 소유한다.
공통 팩의 버전과 프로젝트 설정 리비전은 별개이며 공통 업데이트는 프로젝트 카탈로그와 검사 설정을 덮어쓰지 않는다.
로컬에서 수정한 공통 파일도 보존하며, 더 새로운 공통 팩은 구형 앱이 내려쓰지 않는다.

```sh
python3 scripts/agentstoz-maintainer.py personas templates --root . --json
python3 scripts/agentstoz-maintainer.py personas candidates --root . --json
python3 scripts/agentstoz-maintainer.py personas create first-time-user --root . \
  --revision <현재-context-revision> --goal '첫 프로젝트를 찾는다' \
  --situation '처음 설치한 Mac에서 프로젝트 이름만 알고 있다' \
  --journey-step '프로젝트 목록을 연다' --journey-step '이름을 검색한다' \
  --success-criterion '원하는 프로젝트를 구분할 수 있다' --evidence-check <실제-check-id>
```

MCP 1.41.0의 `agentstoz_use_review_tester_personas`가 같은 공통 팩과 맥락을 반환하고
`agentstoz_use_create_tester_persona`가 같은 검토·저장 계약을 사용한다. 기존 모바일 실행 권한은 이 등록 작업을 허용하지 않는다.
실제 판정은 `personas run`이 실행한 검사 결과다. 공통 관점·프로젝트 여정·연결 검사 정의가 바뀌면 이전 결과에
**재검사 필요**를 표시하고, 정의 리비전이 없는 옛 보고서는 **정의 버전 미확인**으로 표시한다.
여러 프로젝트에서 확인한 재사용 가능한 개선은 소스 검토 후 다음 공통 팩으로 배포한다.
이 저장소의 검증 프로필은 `python3 scripts/agentstoz-maintainer.py run --profile persona-layers`다.
기존 첫 연결·반복 워크룸·충돌 복구의 세 역할에 공통 관점을 연결했고 실제 검사 연결은 보존했다.

## 프로젝트 페이지의 두 테스트 세트

프로젝트·폴더 목록에는 **일반 검사 수 · 페르소나 역할 수 · 후보 수**가 보인다. 선택한 프로젝트의
**이 프로젝트의 테스트 세트**에서 공통 시나리오와 공통 관점의 버전, 프로젝트 검사 범위·역할,
시작 상황·여정·성공 기준·실제 검사 연결을 펼쳐 확인한다. 미구성·잘못된 설정·조회 실패는 서로 구분한다.
메인 프로젝트 구성 조회는 새 등록·파일 증거와 제한된 메타정보만 읽으며 Python·Git·AI·검사·설정을 실행하지 않는다. 명시한 워크트리의 신원 확인은 기존 Git 검증 경로를 유지한다.
보이는 행만 구독하고 동시 조회 2개·캐시 64개/4 MB·대기 64개로 제한한다. 숨김/해제 때 대기를 취소하며
주기 조회는 없다. 갱신은 표시/명시 새로고침/구성 변경 때만 수행한다.

공통 지침 v26과 테스터 지침 v2는 Codex·Claude·Hermes·Antigravity에서 의미 있는 구현 변경을 검증할 때
일반 프로필과 구성된 페르소나 세트를 함께 사용하도록 제공된다. 이미 프로필 안에서 페르소나를 검사하면
중복 실행하지 않는다. 구성 화면의 ‘지침 있음’은 프로젝트 지침 파일이 제공되었다는 뜻이며 실제 AI 실행의
증거가 아니다. 등록 폴더의 공통 영역 조정은 세션당 한 번이고 기존 Git의 프로젝트 검사·여정은 보존한다.

## 도메인 역할과 시나리오 후보

공통 3종은 관점이다. 역할을 제한하지 않는다. 현재 개발 에이전트는 README·관련 코드와 문서·정본 기억에서
필요한 사용자와 이해관계자를 파악하고, 기존 역할과 비교해 후보를 남긴다. 증권사 직원/담당 관리자,
게임 초보자/숙련자/프로게이머, 보안 운영자/감독기관 검토자 등이 프로젝트 근거에 따라 가능하다.
정해진 업종 키워드로 자동 역할을 단정하거나 별도 모델을 백그라운드 호출하지 않는다.

```sh
python3 scripts/agentstoz-maintainer.py personas context --root . --json
python3 scripts/agentstoz-maintainer.py personas propose --root . \
  --revision <context-revision> --role '게임 초보자' \
  --reason '프로젝트 문서에 처음 시작하는 이용자의 도움말 여정이 있다' \
  --goal '첫 게임의 목표와 다음 행동을 이해한다' --situation '규칙을 모르는 첫 실행' \
  --journey-step '도움말을 읽는다' --journey-step '첫 게임을 시작한다' \
  --success-criterion '다음 행동과 완료 여부를 이해한다' --source-path README.md
```

`--evidence-check <id>`를 생략하면 **검사 구현 필요** 후보다. 활성 카탈로그에 들어가지 않고 PASS/FAIL도
없다. 실제 검사를 구현한 뒤 현재 맥락으로 다시 제안하고 앱에서 역할·목표·근거를 검토해 연결한다.
후보에는 역할·필요 이유·상황·순서 있는 여정·성공 기준·근거 파일의 버전이 남는다. 근거 파일이 바뀌면
오래된 적용을 차단하고 동일한 검토의 응답 유실은 기존 영수증으로 확인한다. 같은 목표라도 역할이 다르면
별개의 페르소나이며 각자의 기준과 여정을 보존한다. 같은 역할·목표도 시작 상황이나 여정·성공 기준이 다르면 별개의 시나리오로 둔다. 기존 프로젝트의 역할과 직접 수정한 공통 파일은 유지한다.

MCP는 `agentstoz_use_get_tester_sets`(읽기)와 `agentstoz_use_propose_tester_persona`(후보 쓰기)를 제공한다.
모바일 권한은 기존 준비된 검사 실행/조회/취소 범위로 유지한다.

## 이 저장소에서 실행

```sh
python3 scripts/agentstoz-maintainer.py plan
python3 scripts/agentstoz-maintainer.py run --profile quick
python3 scripts/agentstoz-maintainer.py run --profile verify
python3 scripts/agentstoz-maintainer.py run --profile tester
python3 scripts/agentstoz-maintainer.py run --profile web
python3 scripts/agentstoz-maintainer.py run --profile native
```

Python 3.9 이상, 표준 라이브러리만 사용한다. 각 검사의 Bun·Node·Xcode·브라우저 등은 해당 검사에 필요하다.
Git이 없는 폴더도 사용할 수 있다. 이 경우 로컬 소스 파일의 제한된 해시를 비교하며 테스트 보고서·의존성 폴더·장기기억은 제외한다. 개인 환경값은 Git에 넣지 않는다.
`plan`은 명령을 실행하지 않는다. `run`은 저장소에 버전 관리된 설정의 명령을 실행하므로 소스를 검토한 저장소에서 사용한다.
검사는 순서대로 실행하며 기본적으로 실패한 독립 검사 다음에도 계속 진행한다. 성공 결과를 캐시해서 재사용하지 않는다.

실제 iPhone 검사는 연결된 기기 ID, **별도 테스트 앱** 템플릿, 그 템플릿의 개발 서명을 지정한다.
현재 사용자 기기 ID나 서명 계정은 Git에 넣지 않는다.

```sh
AGENTSTOZ_TEST_DEVICE='<connected-device-id>' \
AGENTSTOZ_TEST_IOS_TEMPLATE='<signed-workspacetest.app>' \
AGENTSTOZ_TEST_SIGNING_IDENTITY='<Apple Development identity>' \
python3 scripts/agentstoz-maintainer.py run --profile device
```

`device`는 실제 iPhone의 WKWebView·LAN·PTY 수명 검증이다. 별도 bundle ID `com.intenet.agentstoz.workspacetest`를 사용하고 검사 후 제거한다.
운영 앱·계정 데이터는 사용하지 않으며, 실제 AI 및 개인 인터넷 relay의 정상 작동을 대신 증명하지 않는다.
`native`의 XCUITest는 새 시뮬레이터를 만들고 종료·삭제한다. 기존 시뮬레이터는 건드리지 않는다.

## 결과와 AI 인계

결과는 `.agentstoz/maintainer/runs/<run-id>/report.json`, `report.md`, `handoff.md`에 저장된다.
최근 결과는 `python3 scripts/agentstoz-maintainer.py status`로 조회한다.

- `passed`: 선택한 검사를 실제로 실행해서 통과했다.
- `failed`: 검사 실패 또는 시간 초과다. 종료 코드 1.
- `blocked`: 실행 도구·필수 입력·플랫폼이 없거나 선행 검사가 끝나지 않았다. 종료 코드 2.
- `interrupted`: 사용자가 중단했다. 종료 코드 130.
- 테스트 실행 중 소스가 바뀌면 결과를 완전한 성공으로 판정하지 않는다.

장기기억은 현재 프로젝트의 canonical worktree에서만 읽는다. `.agent-memory/config.json`의 정본과 인덱스가 가리키는 관련 노트에서 제한된 발췌를 만든다.
실패한 검사의 검색어와 일치하는 근거만 인계하며, 기억과 검사 출력은 **명령이 아닌 검토 자료**다.
API·LLM·기억 저장·Git Push는 러너가 자동 실행하지 않는다. 검증 후 남길 교훈은 기존 `remember-session` 흐름으로 저장한다.

AI에는 `handoff.md`를 먼저 전달한다. 실패 재현 → 원인 확인 → 최소 수정 → 관련 검사 재실행 → 필요한 전체 검증 순서다.
메인테이너 자체 개선도 Python 회귀 검사와 코드 리뷰를 통과시켜 Git으로 배포한다. 실행 중 스스로 코드를 내려받아 교체하지 않는다.

원본 출력은 디스크에 저장하지 않는다. 메모리에서 제한된 끝부분을 수집한 뒤 알려진 비밀값·토큰·개인 경로를 가려 보고서에 넣는다.
자동 가림이 모든 민감 정보를 알아낼 수는 없으므로 보고서·장기기억 발췌는 Git에서 제외하고 외부 공유 전 확인한다.
동일 프로젝트의 중복 실행은 잠금으로 막는다. 검사 시간 제한 시 해당 실행이 만든 프로세스 그룹을 정리한다. 최근 10회 보고서만 유지하며 프로젝트 기억은 삭제하지 않는다.

## 속도 비교

같은 프로필·설정·러너·환경에서 통과한 결과가 3회 이상 모이면:

```sh
python3 scripts/agentstoz-maintainer.py baseline --profile quick
```

이후 결과에 중앙값 대비 **검사 소요시간** 변화를 표시한다. 이는 앱 응답시간이나 AI 속도가 아니다.
`web`은 별도로 격리된 production 모바일 초기 화면의 cold/warm 렌더링 지표를 검사한다.
실제 로그인·네트워크·작업량이 다른 성능은 별도로 측정해야 하며, 실행 시간이 증가했다는 이유만으로 기능 실패를 만들지 않는다.

## 다른 프로젝트에 설치

```sh
python3 scripts/agentstoz-maintainer.py init --root /path/to/another-project
```

기본은 미리보기다. 파일 목록을 확인한 뒤 `--apply`를 붙인다. 해당 프로젝트에 독립 실행 가능한 동일 Python 파일, 검사 설정, 사용 안내와 보고서 제외 규칙을 생성한다.
기존 파일은 덮어쓰지 않는다. Bun/npm 또는 Python의 **명시된 기존 검사**만 초안으로 제안하며 검사가 없으면 `blocked`로 남긴다.
자동 설치나 다른 프로젝트의 일괄 실행은 하지 않는다. 새로 생성된 소스 파일을 그 프로젝트의 평소 리뷰·커밋·Push 과정에 포함하면 다른 Mac에도 전달된다.

검사 도구·설정·회귀 테스트는 각 프로젝트 Git의 개발 자산이고, DEV 기억은 그 프로젝트의 판단 근거다.
아젠투지(OPS) 운영 폴더 `AgentsToZ-OPS`(예전 이름 `AgentsToZ-Control`)는 여러 프로젝트의 결과·다음 조치를 조율한다. 원본 기억을 OPS나 public Git으로 복제할 필요는 없다.

## 검증 범위의 한계

소스 검사, 브라우저 fixture, 시뮬레이터, 실기기 fixture, 설치된 앱, 실제 서비스 계정, TestFlight는 별도 증거다.
하위 계층 통과를 배포·로그인 성공으로 바꾸지 않는다. `full`은 기기 입력이 없으면 미완료로 표시한다.
테스트 시스템도 모든 결함의 부재를 보증할 수는 없다. 발견한 문제를 재현 가능한 회귀 검사로 남겨 다음 실행의 검출 범위를 넓힌다.
