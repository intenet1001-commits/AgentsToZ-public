# 프로젝트 테스터 에이전트 첫 구현

2026-09-14 · runner 1.1.1 · MCP 1.14.0

## 사용 흐름

등록 프로젝트 카드 또는 상세 화면에서 **테스터 에이전트**를 펼친다.
처음에는 **테스터 설정하기 → 설정 적용 → 테스트 실행**, 이후에는 **테스트 실행** 한 번이다.
별도 기억 초기화나 GitHub 계정 없이 사용할 수 있다. Git이 없는 폴더도 제한된 파일 지문으로 실행 전후를 비교한다.
기존 Bun/npm의 `verify`/`test`, Python unittest를 초기 명령으로 연결하고, 발견한 테스트가 없으면 AI 구성으로 안내한다.
설정 파일이 있다는 이유로 테스트 완료를 표시하지 않는다.

검사 실패 시 **AI로 개선**에서 인계문을 복사하거나 선택한 워크룸을 연다.
Codex/Claude는 현재 runtime이 지원하는 초기 prompt를 사용한다. Hermes/agy는 초기 prompt 지원이 없으므로 복사 후 워크룸을 열고 사용자가 붙여넣는다.
생성한 지침은 AGENTS.md·CLAUDE.md·GEMINI.md·agy workspace rule와 Codex/Claude `agentstoz-test` skill에 연결된다.
설치된 Hermes의 prompt builder가 프로젝트 AGENTS.md를 읽는 경로도 확인했다. 이는 실제 제공자 인증·AI 실행 성공과 별도다.
관련 canonical DEV 기억은 실패 검사에 설정한 `memoryQueries`로 제한 조회한다. 검증한 교훈은 기존 remember-session에 맡기며 별도 기억 DB를 만들지 않는다.

## 현재 실행 계약

- 기존 Python 실행기 하나를 재사용한다. `capabilities`, `inspect`, `setup-plan`, `setup-apply`와 `run --run-id`를 추가했다. Python/설정 문제가 있으면 진단·인계문을 제공한다.
- `POST /api/agent-runtime/tester`: `operation`, `portId`, 선택 `workspaceTargetId`와 작업별 고정 필드만 받는다. `start`는 `revision`, `profileId`, `requestId`; `apply`는 `revision`; `read/cancel`은 `runId`; `handoff`는 `mode`, 선택 `runId`다. 파일 경로·argv·환경값은 요청에서 받지 않는다.
- 로컬 웹 origin과 설치 앱의 기존 Agent Runtime capability를 확인한다. Rust proxy도 정확한 POST 경로만 허용한다. 기존 원격 QR 권한이나 포털 CORS에 tester를 추가하지 않았다.
- MCP의 7개 tester 도구는 USE 프로필 인증 후 같은 호스트를 호출한다. 구형 controller project ID만으로는 허용하지 않는다.
- `requestId`는 `test_<13자리 epoch ms>_<UUID>`다. 재전송은 같은 ID·내용을 유지한다. 같은 실행 영수증을 돌려주며 30일이 지난 요청은 재실행하지 않는다.
- 앱 사용자별 SQLite 영수증을 유지한다. 대상 실제 경로·inode·설정 revision을 실행 직전에 재검증한다. 앱 재시작 시 미확정 작업은 `recovery-required`, 자동 재실행 없음이다.
- 최대 실행 2개, 대기·미확정 합계 16개, Python 조회 동시 4개다. 화면을 펼칠 때만 조회하며 숨기면 폴링을 멈춘다. 작업 자체는 화면과 독립적으로 계속된다.
- 앱 작업은 workspace lease, Python 작업은 프로젝트 flock으로 중복을 제한한다. 부모 AI 작업이 lease를 가진 경우 앱 중첩 실행을 막고 **현재 AI 세션 안에서 동일 CLI 실행**을 안내한다. 잠금을 강제 해제하지 않는다.
- 취소·종료는 소유한 Python 자식에 신호를 보내고 결과를 확인한다. Python은 자신이 만든 검사 프로세스 그룹을 정리한다. macOS에서 종료된 그룹의 EPERM은 프로세스 상태를 확인하며 살아 있는 그룹의 정리 실패를 성공으로 표시하지 않는다.
- 보고서별 출력은 Python에서 가린 뒤 호스트에서 다시 제한한다. 앱 조회 총 출력 16,000자, 검사당 2,000자, AI 인계문 16,000바이트다. 로컬 CLI 결과와 앱 실행 영수증의 출처를 구분한다.
- 설정은 파일별 전후 내용과 revision으로 준비·적용·복구한다. 기존 사용자 지침을 보존하고 맞춤 manifest는 업데이트하지 않는다. 사용자 수정 runner는 덮어쓰지 않는다. 중단된 계획은 허용된 설치 경로와 동일 폴더 정체성·revision을 재검증한다.
- 배포 앱에는 `templates/tester-agent/agentstoz-maintainer.py`를 번들한다. 프로젝트별 runner·manifest·안내·AI 지침·정적 메타데이터는 해당 프로젝트 Git에 포함한다. 보고서·잠금·개인 실행 영수증은 공유하지 않는다.

## 회귀 근거

- Python 행동 회귀: 기존 실행·출력·시간 제한·기억·worktree 검사와 설치 보존·부분 복구·고정 run ID·Git 없는 폴더·잘못된 복구 계획을 검사한다.
- 호스트 회귀: 실제 Python 임시 프로젝트로 설정, 중복 실행, 설정 변경, 취소, 부모 lease, Python 없음, 잘못된 JSON, 선택 run 인계, 재시작을 검사한다.
- 실제 HTTP fixture: 운영 포트와 분리된 API에서 등록 ID, origin, 경로/query 거부, 요청 크기, 설정→실행→결과를 검사한다.
- Chromium/WebKit 각각 8개 흐름: 설정, 실행 결과, 응답 유실 후 동일 요청 재조회, 취소, AI 구성, Python 없음, worktree/profile 선택, AI 인계, 오래된 상태 응답 폐기를 묶어 검사한다. 393px 화면에서 44px 버튼 터치도 확인한다.
- 반복 명령: `bun run test:tester` 또는 `python3 scripts/agentstoz-maintainer.py run --profile tester`. 저장소 전체 필수 검사는 `bun run verify`다.

## 첫 구현의 한계와 다음 검증

이 구현은 일반 명령의 종료 결과와 선언된 검사 범위를 표시한다. 모든 테스트 프레임워크의 0건/skip 해석기, 기능별 coverage 계산, snapshot 격리는 아직 없다.
시작·종료 지문 사이에 변경 후 원복된 모든 편집을 감지한다고 주장하지 않는다. 큰 비 Git 폴더·심볼릭 링크 등에서 지문을 확정하지 못하면 검사 전체를 성공으로 표시하지 않는다.
구버전 runner는 현재 템플릿으로 검토·업데이트한 뒤 앱 실행한다. 이전 버전별 호환 매트릭스와 자동 충돌 병합은 아직 없다.
기존 CLI 결과 조회는 가능하지만 앱은 자신이 시작하지 않은 프로세스를 취소하지 않는다. 앱 강제 종료 후 남은 작업의 최종 보고서가 없으면 미확정 상태를 보존한다.
서명된 배포 채널, 다른 실제 Mac의 clone/Pull, 모든 AI의 실제 인증·수정·기억 저장, 1,000개 프로젝트 부하 검증은 별도 실증 항목이다.
P5 모바일/Control 집계·원격 tester grant의 후속 구현은 [MOBILE-CONTROL.md](MOBILE-CONTROL.md)를 따른다. 기존 iPhone 원격 작업의 모든 기능을 이번 tester 시험 결과로 대체 평가하지 않는다.

## 검증 기록

- `bun run verify`: Python 32건, Bun 4,275건, Rust 58건, TypeScript 및 sidecar 빌드 통과. 첫 실행에서 구형 MCP 도구 수(23)를 기대한 회귀가 실패해 실제 30개 계약으로 갱신한 뒤 전체 재검증했다.
- Chromium·WebKit 총 16개 화면 흐름 통과. 화면 닫기/재열기 중 늦은 응답이 다른 화면의 상태·오류·버튼 대기를 바꾸지 않도록 요청 세대를 분리했다.
- 실제 API에서 프로필 준비 후 MCP `read_tester_run`으로 동일 Python 실행 결과 조회까지 통과했다. 실제 LLM 호출은 이 시험에 포함하지 않는다.
- `bun scripts/check-tester-bundle.ts`: 컴파일된 sidecar와 옆에 번들된 템플릿만 사용해 소스 없는 임시 프로젝트에서 설정→Python 실행→결과를 확인했다. capability 없는 요청 거부도 확인했다. run `20260914T025147Z-86ced677` 통과.
- 설치 Mac UI와 새 배포 채널의 검증은 위 source/fixture 결과와 별도다. 앱 설치 버전은 배포 후 기록한다.
- v469 설치 UI 검증에서 Tauri `agent_runtime_request`의 `{status, body}` envelope를 바로 tester 결과로 읽는 결함을 발견했다. 네이티브 전용 decoder로 body를 해석하고 서버 거절과 응답 유실을 구분하도록 수정했다. `tests/tester-agent-client.test.ts`에 실제 Rust envelope·오류·잘못된 transport 응답 회귀를 추가했다. 브라우저 fixture만으로 네이티브 통신까지 완료로 판정하지 않는다.
- runner 1.1.1은 앱 부모 PID 감시 환경값을 현재 runner에서 소비한다. 하위 테스트가 다시 Python runner를 실행할 때 원래 앱 PID를 상속해 잘못 중단되는 것을 막는다. 이 실행 경계도 실제 subprocess 회귀로 확인한다.
- 수정 후 검증: Python 34건, Bun 4,278건, Rust 58건, TypeScript 및 브라우저 16개 흐름 통과. 새로운 버전 메타데이터의 자동 다운그레이드도 거부한다.
- v470 설치 앱에서 `tester` 프로필을 버튼으로 실행해 `maintainer-self`와 `tester-integration` 통과 및 MCP의 동일 run `20260914T030915Z-b6af758c` 조회를 확인했다. 영수증 생성보다 Python 시작이 늦어도 같은 run ID면 앱 출처를 유지하도록 화면 회귀의 시각도 실제처럼 분리했다. 이 검사는 실제 LLM 호출이나 iPhone tester UI를 포함하지 않는다.
- 설치 앱의 AI 인계문에서도 선택한 실행의 검사 프로필을 유지한다. 기본 `quick`으로 바뀌지 않도록 서로 다른 프로필로 실행한 두 결과 중 지정한 run의 명령을 확인하는 회귀를 추가했다.
