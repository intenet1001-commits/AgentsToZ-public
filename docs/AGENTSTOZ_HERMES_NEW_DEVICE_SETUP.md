# AgentsToZ + Hermes Bot 새 단말 설치·등록·검증 매뉴얼

이 문서는 **새 Mac/PC에 AgentsToZ를 설치한 뒤 Hermes Desktop Bot을 연결하고, 실제 프로젝트 작업까지 검증하는 표준 절차**다.

AI에게 이 문서를 전달하면 설치만 설명하지 말고, 아래 순서를 실제로 실행하고 각 단계의 증거를 readback해야 한다.

## 0. 이번 작업의 목표

새 단말에서 다음 구조를 완성한다.

```text
새 단말 device_id
  ├─ AgentsToZ 앱/API
  ├─ Hermes Desktop
  ├─ agentstoz-bot  (control-plane)
  ├─ cs-ceo         (resident CEO/worker)
  └─ #project
       ├─ 현재 단말의 canonical local path
       ├─ 기존 shared memory_id
       └─ 정확한 Git remote
```

핵심 불변식:

```text
resolved project
= execution project
= project-memory project
= Git project
```

하나라도 다르면 작업을 시작하지 말고 fail-closed로 중단한다.

## 1. 절대 보존할 것과 복사하지 않을 것

### 새 단말에서 새로 발급해야 하는 것

- 새 단말 전용 `device_id`
- 새 단말의 local project path
- 새 단말의 Hermes profile/gateway runtime

### 기존 단말에서 복사하지 않는 것

- 기존 `device_id`
- Hermes auth/token
- `.env`
- `auth.json`
- Hermes state DB
- raw session transcript
- gateway lock/pid 파일
- 다른 단말의 포트·프로세스 상태 파일

비밀번호, API key, OAuth token, Supabase service-role key, 연결 문자열은 매뉴얼·채팅·Git에 기록하지 않는다. 필요한 값은 사용자가 해당 단말의 안전한 입력창에서 직접 입력한다.

## 2. 사전 점검

새 단말에서 다음을 확인한다.

```bash
uname -a
hermes --version
hermes doctor
git --version
```

Windows PowerShell에서는 다음을 사용한다.

```powershell
$PSVersionTable
hermes --version
git --version
```

실패하면 설치를 계속하지 말고 정확한 명령과 오류를 보고한다.

## 3. AgentsToZ 설치 및 실행

1. 공식/승인된 저장소에서 AgentsToZ를 clone한다.
2. 저장소 루트에서 의존성을 설치한다.
3. 앱/API를 실행한다.
4. API health를 확인한다.

예시:

```bash
git clone <APP_REPOSITORY_URL> AgentsToZ_byCS
cd AgentsToZ_byCS
# 저장소의 AGENTS.md/README.md에 정의된 설치 명령을 우선 사용한다.
curl -fsS http://127.0.0.1:3001/api/health
```

health 응답에서 다음을 확인한다.

```text
ok=true
service=agentstoz-api
schemaVersion 존재
```

설치 명령은 저장소의 현재 `AGENTS.md`와 `README.md`가 이 문서보다 우선한다. 추측해서 패키지 매니저나 포트를 바꾸지 않는다.

## 4. Hermes 설치 및 Bot profile 구성

Hermes를 새 단말에 설치하고, 새 단말에서 profile을 확인한다.

필수 profile:

```text
default
agentstoz-bot
cs-ceo
```

역할:

- `agentstoz-bot`: AgentsToZ control-plane. 프로젝트를 resolve하고 binding을 검증한 뒤 작업을 `cs-ceo`에 위임한다. 직접 프로젝트 파일을 수정하지 않는다.
- `cs-ceo`: Hermes에 상주하는 CEO/worker. 검증된 canonical project path에서만 실제 작업을 수행한다.
- `Hermes`: 단체방 결과를 검토·종합한다.

사용하지 않는 profile/이름:

```text
csncompany-bot
```

Bot identity는 추측하지 않는다. Hermes Desktop의 Bots 화면에서 실제 표시된 이름과 handle을 readback한다.

예상 identity:

```text
Hermes        @hermes
CS CEO        @cs-ceo
Agentstoz Bot @agentstoz-bot
```

## 5. 새 단말 identity 등록

AgentsToZ 앱의 기기 등록 흐름을 사용해 새 `device_id`를 발급·등록한다.

검증 항목:

```text
device_id가 새 단말 전용인가?
기존 단말 device_id를 재사용하지 않았는가?
device 등록 상태가 서버/API readback에 존재하는가?
현재 viewing device와 authoritative device를 혼동하지 않았는가?
```

기기 등록이 확인되지 않으면 프로젝트 작업이나 memory 연결을 진행하지 않는다.

## 6. 프로젝트 clone/연결

대상 프로젝트를 정확한 Git remote에서 clone한다. 프로젝트 이름만으로 다른 폴더를 추측하지 않는다.

clone 후 반드시 확인한다.

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
printf '%s\n' "$PROJECT_ROOT"
git -C "$PROJECT_ROOT" remote -v
git -C "$PROJECT_ROOT" status --short --branch
```

Windows PowerShell:

```powershell
$PROJECT_ROOT = (git rev-parse --show-toplevel)
$PROJECT_ROOT
git -C $PROJECT_ROOT remote -v
git -C $PROJECT_ROOT status --short --branch
```

### 6.1 `cs-ceo` 기본 프로젝트 자동 준비

새 단말에서 `cs-ceo` Bot을 만들 때 `csncompany2-0`이 설치·등록되어 있지 않으면 Bot 생성 프롬프트가 다음 exact GitHub 저장소를 자동 준비하도록 지시한다.

```text
https://github.com/intenet1001-commits/CSnCompany_2-0
```

표준 처리 순서:

1. `csncompany2-0` exact project resolve
2. 기존 canonical path·memory ID·Git remote readback
3. 프로젝트가 없을 때 등록된 workspace root가 정확히 하나인지 확인
4. target 폴더가 없을 때만 `CSnCompany_2-0` clone
5. clone 후 project-memory 초기화
6. AgentsToZ project registration
7. canonical path·memory ID·Git root·Git remote·device binding readback
8. remote memory backup 상태 확인
9. 전부 통과한 경우에만 `cs-ceo` Ready 처리

안전 규칙:

- 기존 폴더는 삭제·reset·checkout·clean·stash하지 않는다.
- 기존 폴더가 있으나 등록/remote가 다르면 `PROJECT_BOOTSTRAP_CONFLICT`로 중단한다.
- workspace root가 없거나 여러 개면 임의 경로를 선택하지 않고 사용자 선택을 요청한다.
- GitHub 인증 실패와 remote memory backup 실패는 성공으로 보고하지 않는다.
- clone·memory 초기화·등록·Bot Ready는 각각 독립 결과로 기록한다.


새 단말은 새 local path를 사용하지만, 같은 논리 프로젝트라면 기존 `memory_id`를 공유한다.

```text
단말 A: device_id A + local path A + memory_id X
단말 B: device_id B + local path B + memory_id X
```

연결 전에 다음을 확인한다.

1. AgentsToZ exact project resolver 결과
2. resolver의 canonicalPath
3. resolver의 memoryId
4. resolver의 Git remote
5. 로컬 `.agent-memory/config.json`
6. 로컬 `git rev-parse --show-toplevel`
7. 로컬 `git remote get-url origin`

다음 값이 하나라도 불일치하면 memory를 새로 만들거나 다른 프로젝트에 기록하지 말고 중단한다.

```text
resolver.canonicalPath == local Git root
resolver.memoryId == local .agent-memory/config.json.memoryId
resolver.gitRemote == local origin
```

연결 후에는 작업 전 Pull/status를 수행하고, conflict나 dirty 상태를 자동으로 덮어쓰지 않는다.

## 8. Hermes Desktop 단체방 설정

Hermes Desktop에서 실제 Bot을 선택해 새 Group Chat을 만든다.

필수 참여자:

```text
Hermes
CS CEO — Hermes 상주 Bot
Agentstoz Bot
```

생성 직후 readback:

```text
방 제목
멤버 수 = 3
Bot 수 = 3
3 of 3 available
각 Bot handle
```

작업 중 새 메시지는 기존 turn을 중단할 수 있으므로, 각 단계가 `turn settled` 된 뒤 다음 메시지를 보낸다. 중복 request를 보내지 않는다.

## 9. 단계별 테스트 시나리오

### Test A — Bot availability

단체방에서 각 Bot의 identity와 Ready 상태를 확인한다.

```text
[PASS 조건] 3개 Bot이 실제 화면에 있고 모두 Ready/Available
```

### Test B — read-only project resolve

```text
@agentstoz-bot #<PROJECT_SELECTOR> request_id=device-onboard-resolve-<UNIQUE_ID>
실행하지 말고 exact project resolve만 해줘. canonical path, memory ID, Git remote, branch, HEAD, device binding을 보고해줘.
```

[PASS 조건]: 작업·파일·memory 변경 없이 resolver 값과 로컬 readback이 일치한다.

### Test C — 정상 단체방 E2E

```text
@agentstoz-bot @cs-ceo #<PROJECT_SELECTOR> request_id=device-onboard-e2e-<UNIQUE_ID>
새 단말 온보딩 통합 테스트를 실행해줘. Agentstoz Bot은 먼저 project/device/memory/Git binding을 exact 검증하고, 통과한 경우에만 cs-ceo에게 위임해. cs-ceo는 프로젝트 루트 내부에서만 최소한의 테스트 증거 파일을 만들고 project-memory journal에 기록해. Hermes는 전체 결과를 검토해. commit/push는 하지 말고 local 파일, memory journal, remote memory status, Git local/remote SHA를 모두 readback해.
```

[PASS 조건]:

- Agentstoz 검증 응답
- cs-ceo worker 응답
- Hermes 종합 응답
- 실제 파일 readback
- journal entry readback
- remote memory `exists=true`, `inSync=true`
- Git 변경 범위가 의도한 파일만 포함
- commit/push 없음

### Test D — invalid selector fail-closed

```text
@agentstoz-bot #does-not-exist request_id=device-onboard-invalid-<UNIQUE_ID>
selector 검증만 해줘. 등록되지 않은 프로젝트면 fail-closed로 거절하고 worker dispatch, 파일 변경, memory 변경을 하지 마.
```

[PASS 조건]: `PROJECT_NOT_REGISTERED` 또는 동등한 4xx와 함께 모든 side effect가 0이다.

### Test E — duplicate request

정상 E2E에서 사용한 request ID를 다시 사용한다.

```text
@agentstoz-bot @cs-ceo #<PROJECT_SELECTOR> request_id=<ALREADY_COMPLETED_ID>
중복 안전성만 확인해줘. 실제 작업, 파일 변경, memory append, commit/push는 하지 마.
```

[PASS 조건]: 이미 완료된 request로 인식하고 worker 재실행·파일 변경·memory append가 없다.

### Test F — dirty/conflict 보호

의도하지 않은 기존 변경을 만들거나 지우지 않는다. dirty 상태가 있으면 다음을 확인한다.

```text
기존 dirty 파일 목록
현재 memory hash
remote revision
```

[PASS 조건]: 자동 reset/checkout/stash/clean/overwrite가 없고 사용자 선택 없이 conflict를 해결하지 않는다.

## 10. 필수 독립 readback

AI의 최종 설명만 믿지 말고 다음을 직접 실행한다.

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
git -C "$PROJECT_ROOT" status --short --branch
git -C "$PROJECT_ROOT" rev-parse HEAD
git -C "$PROJECT_ROOT" remote get-url origin
cat "$PROJECT_ROOT/.agent-memory/config.json"
```

Project-memory API:

```bash
curl --fail-with-body -sS -X POST --get \
  --data-urlencode "folderPath=$PROJECT_ROOT" \
  http://127.0.0.1:3001/api/project-memory/remote-status
```

다음이 모두 있어야 정상 완료다.

```text
local project-memory 존재
remote revision 존재
remote inSync=true
canonical path 일치
memory ID 일치
Git remote 일치
local HEAD/remote SHA 판정 명확
```

## 11. 실패·중단 규칙

다음 중 하나라도 발생하면 성공으로 보고하지 않는다.

- Bot identity를 화면에서 확인하지 못함
- device_id가 새 단말 것인지 확인하지 못함
- exact project resolve 실패
- canonical path 추측 또는 fuzzy match
- memory ID 불일치
- Git remote 불일치
- 다른 프로젝트나 parent directory에 파일 생성
- remote memory backup 실패
- pytest/프로젝트 테스트가 실행되지 않음
- 새 메시지 때문에 이전 turn이 interrupt됨
- Bot이 working/thinking 상태에서 settle되지 않음
- commit/push가 사용자 승인 없이 실행됨

실패 보고 형식:

```text
단계:
상태: PASS / FAIL / BLOCKED / NOT VERIFIED
실제 증거:
변경된 파일:
다음 조치:
```

## 12. 최종 보고 형식

```text
새 단말 device_id: [값 자체는 필요 시 마스킹]
AgentsToZ API health: PASS/FAIL
Hermes profile: PASS/FAIL
Bot identity/availability: PASS/FAIL
Project resolve: PASS/FAIL
Canonical path: PASS/FAIL
Shared memory ID: PASS/FAIL
Git remote/branch/HEAD: PASS/FAIL
Local memory: PASS/FAIL
Remote memory/inSync: PASS/FAIL
Group E2E: PASS/FAIL
Invalid selector fail-closed: PASS/FAIL
Duplicate request guard: PASS/FAIL
Test runner: PASS/FAIL
Commit/push: 미수행 또는 승인된 경우에만 기록
Blockers: 없음 또는 정확한 오류
```

부분 성공을 전체 성공으로 합치지 않는다. 새 단말 온보딩은 **설치 완료**가 아니라 위 readback과 테스트 증거가 모두 있을 때만 완료다.
