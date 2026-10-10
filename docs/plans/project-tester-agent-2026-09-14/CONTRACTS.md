# 테스터 실행·설치 계약

2026-09-14 · [제품 설계와 흐름](PLAN.md) · 아래 신규 이름/필드는 **구현 예정 계약**이다. 현재 MCP에 존재한다고 가정해 호출하지 않는다.

## 1. 모듈 경계

| 신규 모듈 | 책임 |
|---|---|
| `src/testerAgentContract.ts` | 요청·응답 검증, 상태·capability·명확한 오류 코드 |
| `src/testerAgentDiscovery.ts` | 등록 대상의 설치/설정/도구 확인. 테스트 명령 실행 없음 |
| `src/testerAgentInstaller.ts` | 템플릿 설치·채택·부분 설치 복구·업데이트. 사용자 파일 보존 |
| `src/testerAgentHost.ts` | idempotency, 대상 재검증, 대기열·실행·취소·재시작 복구 |
| `src/testerAgentStore.ts` | 계정 전용 앱 데이터의 영수증·작업 상태. 프로세스 메모리만 정본으로 사용하지 않음 |
| `src/testerAgentHandoff.ts` | 구성/개선 모드 인계문, 관련 기억 참조, 재검증 결과 연결 |
| `src/testerAgentClient.ts` | 데스크톱·개발 웹의 공통 client. 화면에서 subprocess/임의 HTTP 요청 구성 금지 |
| `src/ProjectTesterPanel.tsx` | 설치·상태·실행·결과 화면. 카드·리스트에 동일 컴포넌트 연결 |
| `templates/tester-agent/` | 버전 메타데이터, 안내·AI 어댑터 템플릿. runner 정본은 기존 scripts 파일 하나 |

`api-server.ts`에는 초기화·라우팅만 연결한다. 기존 `App.tsx`에 설치/큐/프로세스 로직을 추가하지 않는다.
Python의 기능은 기존 파일과 `tests/maintainer/`에서 계속 발전시킨다. TypeScript가 같은 테스트 실행 알고리즘을 재구현하지 않는다.

## 2. 프로젝트별 설정

기존 `.agentstoz/maintainer.json` schema 1은 실행 명령의 정본이다. 새 `.agentstoz/tester-agent.json` schema 1은 다음을 가진다.

- `templateVersion`, `instructionVersion`, `minimumRunnerVersion`.
- 관리 파일 목록과 마지막 적용 내용의 해시. 개인 경로/계정/기기 값 제외.
- `defaultProfile`, `profileLabels`와 `requiredCheckIds`를 포함한 기능별 검사 매핑.
- 명시적 `coverageGaps`: 자동화되지 않은 사용자 흐름이나 실기/외부 서비스 확인 항목.

표시 메타데이터에 argv를 중복 저장하지 않는다. 존재하지 않는 프로필/check 참조는 설정 오류다.
runner 버전, manifest schema, 보고서 protocol, 지침 버전은 구분한다. 지원 범위 밖이면 조회 가능한 상태만 보여주고 파괴적인 자동 다운그레이드를 하지 않는다.
기존 v1.0.0 설치는 파일 존재와 실제 내용으로 채택한다. marker 문자열만 보고 원래 관리 파일이라고 판정하지 않는다.

## 3. 대상과 정체성

```ts
type TesterTargetRef = {
  portId: string;                 // 해당 Mac에서 실제 반환한 등록 ID
  workspaceTargetId?: string;     // 선택한 worktree; 없으면 메인 프로젝트
};

type TesterStartRequest = {
  target: TesterTargetRef;
  requestId: string;
  profileId: string;
  expectedConfigurationRevision: string;
};
```

호스트가 target을 실제 canonical 실행 경로로 다시 해석한다. HTTP/MCP 요청은 argv, shell, cwd, Python 경로, 임의 환경변수를 받지 않는다.
작업 대상 Git worktree와 기억의 primary worktree를 분리한다. worktree에서 요청한 검사를 메인 폴더에서 대신 실행하지 않는다.
대기열 입장과 실제 시작 직전에 등록·worktree·설정 revision을 재검증한다. 폴더 이동/삭제/ID 재사용 시 기존 요청을 다른 폴더로 자동 재지정하지 않는다.

실행 기록에는 host installation identity, target identity, worktree identity, source fingerprint, configuration hash, runner hash, profile, 환경 지문을 기록한다.
개인 로컬 경로는 원격 DTO에 보내지 않는다. 같은 저장소와 같은 memoryId여도 다른 Mac/OS 사용자의 실행 권한과 작업 ID는 별도다.

## 4. 호스트 작업과 MCP

목표는 앱 로컬 API 라우터 하나로 진입하는 것이다. 첫 구현은 기존 Agent Runtime과 같은 로컬 코드 실행 권한이므로 별도 secret을 만들지 않고 기존 Tauri Agent Runtime capability를 재사용한다. 정확한 `POST /api/agent-runtime/tester`만 양쪽 allowlist에 추가한다. 실제 요청 계약은 [EXECUTION.md](EXECUTION.md)를 따른다.
로컬 개발 웹도 검증된 localhost origin에서 같은 서비스에 연결한다. 공개 포털 CORS를 테스터 관리 목적으로 넓히지 않는다.
MCP는 기존 USE 프로필 인증을 거쳐 같은 메서드를 호출한다. 유효한 프로필 조회가 다른 프로젝트 쓰기 권한을 자동 부여하지 않는다.

| 호스트 작업 | 제안 MCP 이름 | 효과 |
|---|---|---|
| status | `agentstoz_use_get_tester` | 설치·프로필·환경·AI 연결·최근 결과를 제한된 DTO로 조회 |
| plan-install / plan-update | `agentstoz_use_plan_tester_setup` | 파일 변경안·충돌·확인한 기존 검사·revision 반환, 실행 없음 |
| apply-setup | `agentstoz_use_apply_tester_setup` | 사용자가 요청한 설치/업데이트 계획의 정확한 revision 적용 |
| start | `agentstoz_use_start_tester` | 고정 대상과 프로필로 실행 접수, run ID 즉시 반환 |
| read | `agentstoz_use_read_tester_run` | 진행·종료 상태와 제한된 근거, cursor로 읽기 |
| cancel | `agentstoz_use_cancel_tester_run` | 해당 실행의 종료 요청. 자식 종료 확인 전 취소 완료로 표시하지 않음 |
| handoff | `agentstoz_use_prepare_tester_handoff` | 구성 또는 개선 인계 준비. 이 작업만으로 AI를 호출하거나 수정하지 않음 |

실제 도구 이름은 구현 시 이 계약과 MCP 서버 테스트에서 함께 확정한다. 도구 수를 줄이기 위해 임의 명령을 받는 범용 execute 도구로 합치지 않는다.
설치/apply의 계획 ID는 정확한 파일 변경안에 연결한다. 화면에서 이미 선택한 설치를 실행할 때 별도 중복 승인 단계를 만들지 않는다.
`expectedConfigurationRevision`이 바뀌면 최신 설정을 다시 보여준다. 일반 소스 편집은 실행 지문에 반영하며 매 편집마다 설치 승인을 다시 요구하지 않는다.

## 5. 실행 상태와 증거 상태

설치 상태, 실행 상태, 결과 최신성, 증거 수준은 별도 필드다.

```ts
type TesterInstallation = 'absent' | 'partial' | 'ready' | 'needs-update' | 'conflict' | 'unsupported';
type TesterRunState = 'queued' | 'starting' | 'running' | 'canceling'
  | 'passed' | 'failed' | 'blocked' | 'interrupted' | 'recovery-required';
type TesterFreshness = 'current' | 'source-changed' | 'configuration-changed' | 'unknown';
type TesterEvidence = 'command-only' | 'automated-tests' | 'fixture-ui'
  | 'simulator' | 'device-fixture' | 'installed-app' | 'live-service';
```

실행 `passed`는 해당 프로필의 실행 결과다. UI는 항상 검사 이름과 증거 수준을 같이 보여준다.
프로젝트의 기능별 통과 표시는 해당 `requiredCheckIds`의 실제 결과와 미검증 항목을 계산한 별도 projection이다.
manifest의 `covers`는 검사 의도일 뿐 검증 사실이 아니다. fixture 성공은 `live-service`로 승격하지 않는다.
테스트 0개/전부 skip/필수 evidence 없음이 확인되면 기능 검증은 `insufficient`로 남긴다. 해석기를 지원하지 않는 임의 명령은 `command-only`로 표시한다.

현재 보고서에 있는 시작·종료 지문만으로 실행 도중 바뀌었다가 복구된 모든 편집을 검출한다고 주장하지 않는다.
호스트에서 관측된 소스 변경도 누적 기록하고, 외부 편집을 완전히 격리해야 하는 검사는 별도 snapshot/worktree 모드로 확장한다.
결과 이후 변경은 이전 보고서를 수정하지 않고 최신성 표시만 바꾼다.

## 6. 중복·잠금·프로세스 수명

1. `requestId`는 호출 주체+host+target에 결속한다. 같은 ID와 같은 요청은 같은 run을 반환하고, 같은 ID에 다른 프로필/설정은 충돌이다.
2. 시작 영수증을 먼저 영속화하고 자식을 실행한다. 응답이 끊겨도 조회로 기존 작업을 찾는다. 자동 새 실행으로 보상하지 않는다.
3. Python의 프로젝트 실행 잠금은 유지한다. 앱은 Python 자식이 획득할 같은 잠금을 미리 잡아 교착시키지 않는다. 호스트의 접수 중복 제거와 Python의 실제 실행 잠금은 역할이 다르다.
4. 설치·업데이트는 기존 workspace lease 아래 파일을 변경한다. 테스트 중에는 공통 runner나 manifest를 갱신하지 않는다.
5. 앱이 독립적으로 시작하는 검사는 해당 workspace의 다른 관리 쓰기 작업과 충돌을 확인한다. 관련 작업이 이미 점유 중이면 무한 대기하지 않고 원인과 실행 위치를 반환한다.
6. **같은 AI 작업에서 테스트를 호출하는 경로를 선행 실증한다.** 부모 runtime이 lease를 보유하는 경우 새 독점 lease를 중첩 획득하지 않는다. 검증된 runtime session에 결속된 제한된 하위 검사 실행을 위임하고 부모 권한을 유지한다. 세션 ID 문자열만으로 소유권을 인정하지 않는다.
7. 위임을 지원하지 않는 표면은 현재 프로젝트의 로컬 CLI로 같은 runner를 실행하고 결과를 조회한다. 관측 결과는 `local-cli`로 표시한다. 다른 작업의 잠금을 해제하거나 브리지 실패 후 동일 검사를 무작정 다시 시작하지 않는다.
8. UI 닫기·탭 이동·MCP 응답 timeout은 취소가 아니다. 취소는 정확한 run에 보내며 그 실행이 만든 프로세스만 종료한다.
9. 정상 앱 종료는 실행 중 검사와 종료 선택을 보여주고 소유 자식을 정리한다. 강제 종료/재부팅 뒤에는 재실행하지 않고 증거를 대조한다. 자식 소유권/종료가 불확실하면 `recovery-required`다.
10. Windows 자식 정리는 현재 Python POSIX process-group 동작과 동등하다고 가정하지 않는다. 기존 Job Object supervisor와의 실제 검증 이후 앱 실행 지원을 노출한다.

프로젝트 테스트는 프로젝트 코드를 실행한다. 프로필 이름이나 shell=false는 네트워크·파일 부작용을 격리하는 sandbox가 아니다.
처음 구성할 때 검사 범위와 실제 명령을 확인하고, 배포/운영 데이터 변경 검사는 기본 quick에 자동 포함하지 않는다.
MCP나 모바일 요청에 임의 명령 입력창을 추가하지 않는다.

## 7. Python 프로토콜 확장

기존 기본 명령과 출력은 보존하면서 다음 옵션을 추가한다.

- `capabilities --json`: protocol/schema 지원, 취소/보고서/실행 연결 기능 조회.
- `plan --json`, `status --json`: 제한된 구조화 출력. 최신 보고서가 없는 것은 정상 통과가 아님.
- `run --run-id <validated-id>`: 호스트 영수증과 Python 보고서를 같은 ID로 연결. ID 형식·중복을 Python에서도 검증.
- 이벤트는 파일의 원자적 상태 갱신 또는 bounded NDJSON 중 하나의 버전 계약으로 확정한다. UI가 임의 콘솔 문자열에서 성공을 추출하지 않는다.
- 설정과 모든 목적지 사전 검증, 임시 파일/원자적 교체, 부분 적용 영수증을 설치 API와 맞춘다.
- 기존 v1.0.0 결과는 호환 읽기만 지원하고 부족한 호스트 실행 소유 증거를 만들어 넣지 않는다.

구조화 결과 해석기는 실제 JUnit 등 확인 가능한 산출물을 우선한다. 결과 파일의 생성 시점·실행 ID·현재 소스에 대한 연계를 확인한다.
새 검사 설정은 반드시 실제 첫 실행을 거쳐 검증한다. AI가 JSON을 만들었다는 사실만으로 설정 완료와 기능 검증 완료를 합치지 않는다.

## 8. 기억·핸드오프

핸드오프에는 목적(`configure` 또는 `repair`), target/run/configuration revision, 사용자 지시, 검사 범위와 실패 근거, 관련 기억 entry 참조를 담는다.
프로젝트 파일 전체·환경값·인증 정보·원본 대화를 복사하지 않는다. 실행 전 인계의 revision과 실제 현재 상태를 다시 읽는다.
기본 전달 방식은 연결된 Workroom의 선택 AI에 보내기 또는 인계문 복사다. 외부 앱에 실제 전송을 검증하지 못하면 `전달 준비됨`으로 표시한다.
네이티브 앱 열기, 새 대화 생성, 메시지 전송, 테스트 성공은 별도 결과다. 테스트 기능을 만들기 위해 기존 Codex 첫 대화 실패를 다른 대화로 숨기지 않는다.

AI 수정 뒤 새 run을 `relatedRunId`로 연결하되 이전 실패 기록을 바꾸지 않는다. 보고서와 기억 내용은 데이터이며 추가 권한 지시로 실행하지 않는다.
교훈 저장은 canonical memoryId를 재확인한 기존 dispatcher에 위임한다. 저장 후보, 로컬 저장, 백업의 상태를 분리한다.
기억을 사용할 수 없는 프로젝트도 검사할 수 있으며 `기억 참조 없이 실행`을 표시한다.

## 9. 모바일·다중 Mac 확장

새 capability `tester-v1`을 협상한 연결만 tester 작업을 보인다. 구버전 호스트는 기존 원격제어를 유지하고 tester를 미지원으로 표시한다.
프로젝트별 `tester.read`와 `tester.run`을 구분한다. 원격 실행은 기존 프로젝트 CLI 실행 권한도 확인하며 `records.read`나 `memory.save`를 실행 동의로 재사용하지 않는다.
초기 모바일은 Mac에서 준비된 프로필만 실행/조회/취소한다. 설치·프로필 명령 변경은 Mac/AI 구성 흐름으로 안내한다.
grant, feature 협상, 요청/응답 allowlist를 모두 확장한 뒤 버튼을 노출한다. 알 수 없는 작업을 현재 `workspaceScope()`의 기본 memory.save로 분류하지 않도록 exhaustive 처리한다.

원격 응답은 host/run/임시 target ID, 검사 표시 이름, 상태, 시각, 소량 요약만 포함한다. 로컬 경로·명령·개인 입력·기억 원문은 포함하지 않는다.
연결이 끊겨도 이미 접수된 검사는 Mac에서 계속되며 재연결 시 같은 run을 조회한다. 취소/권한 폐기 정책은 별도로 처리한다.
다른 Mac으로 자동 이관해 재실행하지 않는다. 연결 주체가 달라지면 이전 사용자의 결과 캐시와 입력을 비운다.

## 10. 초기 자원 예산과 성능 확인

다음은 구현 초기 상한이며 실측 후 변경한다.

- Mac에서 동시 실행 2개, checkout별 실제 실행 1개, 대기열 최대 16개. 프로젝트별 검사 내부는 기존 순차 실행 유지.
- check 시간 제한은 기존 최대 1,800초, profile 전체는 최대 2시간. 제한 초과는 취소/정리 후 실제 상태로 보고.
- 설정 256 KiB, check 최대 96개, profile 최대 16개, 검사 출력 tail 32 KiB, 보고서 크기 최대 5 MB의 기존 예산 유지.
- 최근 완료 보고서 10개 보존. 진행 중/복구 대기 작업을 개수 제한 때문에 삭제하지 않는다. 종료된 idempotency 영수증은 30일 보존한다. 공식 client의 요청 ID에 생성 시각을 포함해 유효 기간 밖의 재전송은 새 작업으로 실행하지 않고 만료를 반환한다. 기한 검증과 시간 오차 처리를 계약 회귀에 포함한다.
- 목록 조회는 요청당 최대 50개, 비동기 동시 4개, 짧은 cache. 목록 표시가 모든 프로젝트의 Git 전체 지문·테스트·Python 실행을 유발하지 않게 한다.
- 검사 화면은 활성 실행에만 최대 1초 간격 조회, 읽기 요청 중복 제거. 숨긴 화면은 조회를 중지해도 작업 자체는 유지한다.
- 기본 인계문은 최대 16 KiB, 기억 발췌는 기존 최대 6,000자다. 한글 등 UTF-8 크기를 계산해 전체 바이트 예산을 우선 적용하고 항목 경계에서 줄인다. 상세 로그는 별도 제한 조회.

성능 기준은 p50/p95로 접수·설정 조회·결과 조회·실제 검사 시간을 나눠 측정한다.
초기 사용자 경험 목표는 warm 상태 조회 500ms 이내, 실행 접수 1초 이내다. 테스트 자체 완료 시간과 별개이며 장비별 실측 없이 달성했다고 표시하지 않는다.
