# AgentsToZ 프로젝트 메인테이너

Python이 먼저 실제 검사를 실행하고, 사람이 결과를 검토하거나 필요한 부분만 AI에 전달한다.
Python은 기존 Bun/Rust/Playwright/Xcode 검사를 대체하지 않고 실행·시간 제한·결과 분류·회귀 비교를 맡는다.
AI가 없어도 검사는 끝나며, AI 제공자와 관계없이 같은 근거를 사용한다.

프로젝트 카드와 상세 화면의 **테스터 에이전트**에서 설정·업데이트·실행·결과 확인·취소를 할 수 있다.
처음에는 **테스터 설정하기 → 설정 적용 → 테스트 실행** 순서다. 검사할 워크트리와 프로젝트에 정의된 프로필을 선택할 수 있다.
테스트 명령이 없으면 **AI로 테스트 구성**, 실패를 개선하려면 **AI로 개선**을 사용한다. Python이 없거나 설정이 잘못되면 환경 준비 인계문을 제공한다.
Codex·Claude Code는 인계문과 함께 워크룸을 시작한다. Hermes·Antigravity는 **인계문 복사·워크룸 열기** 후 준비된 CLI에 붙여넣는다.
앱은 파일 생성·AI 지침 연결과 실제 검사 결과를 구분한다. 모바일 원격 tester 버튼은 후속 단계이며 현재 프로젝트 원격제어 권한에 추가하지 않았다.
실제 계약과 검증 범위는 [구현 기록](plans/project-tester-agent-2026-09-14/EXECUTION.md), 확장 방향은 [설계](plans/project-tester-agent-2026-09-14/PLAN.md)에 있다.

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
총괄 AgentsToZ Control은 여러 프로젝트의 결과·다음 조치를 조율한다. 원본 기억을 Control이나 public Git으로 복제할 필요는 없다.

## 검증 범위의 한계

소스 검사, 브라우저 fixture, 시뮬레이터, 실기기 fixture, 설치된 앱, 실제 서비스 계정, TestFlight는 별도 증거다.
하위 계층 통과를 배포·로그인 성공으로 바꾸지 않는다. `full`은 기기 입력이 없으면 미완료로 표시한다.
테스트 시스템도 모든 결함의 부재를 보증할 수는 없다. 발견한 문제를 재현 가능한 회귀 검사로 남겨 다음 실행의 검출 범위를 넓힌다.
