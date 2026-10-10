# AgentsToZ 인수인계서
## `agentstoz-bot` 멘션·프로젝트 라우팅·실제 로컬 작업·장기기억·Git 커밋 통합

## 1. 가장 중요한 요구사항

이 작업의 핵심은 `agentstoz-bot`을 단순한 단말 관리 봇으로 만드는 것이 아니다.

`agentstoz-bot`은 **AgentsToZ 프로젝트 작업을 받는 클라이언트 Bot**이며, 사용자가 Bot을 멘션하고 `#프로젝트이름`을 지정하면 AgentsToZ가 해당 프로젝트의 로컬 폴더를 정확히 찾아 그 폴더에 실제 작업 에이전트를 파견해야 한다.

예시:

```text
@agentstoz-bot #csncompany2-0 로그인 버그를 조사하고 테스트까지 실행해줘
```

이 요청은 다음과 같이 처리되어야 한다.

```text
Telegram 메시지
  → @agentstoz-bot 멘션 감지
  → #csncompany2-0 프로젝트 토큰 추출
  → AgentsToZ에서 프로젝트 식별
  → 현재 단말의 해당 프로젝트 로컬 경로 확인
  → 그 경로를 cwd로 실제 Hermes 작업 에이전트 파견
  → 작업·테스트·검토 수행
  → 해당 프로젝트 장기기억에 활동/결과 기록
  → 변경사항 검증
  → 해당 프로젝트 Git 저장소에 커밋
  → 커밋 SHA·기억 revision·검증 결과 보고
```

따라서 Bot은 원격으로 모든 파일을 직접 소유하는 서버가 아니라, **AgentsToZ의 프로젝트 라우팅을 통해 해당 단말의 로컬 프로젝트 작업 에이전트를 호출하는 클라이언트**다.

## 2. Bot 역할 분리

### 2.1 `agentstoz-bot`

AgentsToZ 자체를 Bot 클라이언트로 연결한다.

주요 책임:

- `@agentstoz-bot` 멘션 수신
- `#프로젝트이름` 프로젝트 선택자 파싱
- 프로젝트 이름/alias를 안정적인 프로젝트 식별자로 해석
- 현재 단말의 해당 프로젝트 local path 결정
- 올바른 cwd에 작업 에이전트 파견
- 작업 lifecycle 관리
- 프로젝트 장기기억 기록 트리거
- Git 상태 확인 및 커밋 workflow 수행
- 작업 결과·memory revision·commit SHA 보고
- 단말에 해당 프로젝트가 없으면 안전하게 중단하고 clone/onboarding 안내

`agentstoz-bot`은 AgentsToZ control-plane 정보도 조회할 수 있지만, 핵심은 단말 관리가 아니라 **프로젝트를 찾아 실제 로컬 폴더에 작업을 파견하는 것**이다.

### 2.2 `csncompany-bot`

CSnCompany 2-0의 프로젝트 작업 클라이언트다.

주요 책임:

- 지정된 CSnCompany 2-0 프로젝트 폴더에서 실제 개발 작업
- 코드·테스트·Git 상태 확인
- 프로젝트 장기기억 Pull/Update/Push
- 작업 결과 검토 및 증거 생성
- 상위 `agentstoz-bot`이 전달한 cwd와 프로젝트 identity를 준수

정리하면:

```text
agentstoz-bot  = 프로젝트를 찾고 작업을 파견하는 AgentsToZ 클라이언트
csncompany-bot = CSnCompany 2-0 폴더에서 실제 업무를 수행하는 Hermes worker/client
```

두 이름이 항상 별도 프로세스여야 한다는 뜻은 아니다. 중요한 것은 **역할과 라우팅 계약을 분리하는 것**이다. `agentstoz-bot`이 로컬 Hermes worker를 호출하거나, 같은 Hermes runtime에서 역할별 adapter를 사용할 수 있다.

## 3. 프로젝트 선택 계약

### 3.0 절대 불변 규칙

`#프로젝트이름`은 단순한 라벨이나 작업 분류 태그가 아니다. **작업이 실제로 일어날 프로젝트를 지정하는 authoritative project selector**다.

예:

```text
@agentstoz @csncompany #csncompany2-0 로그인 버그를 수정해줘
```

위 요청의 모든 작업 결과는 반드시 `csncompany2-0` 프로젝트에 귀속되어야 한다.

```text
#csncompany2-0
  ├─ 실제 작업 cwd: csncompany2-0의 로컬 프로젝트 폴더
  ├─ 장기기억: csncompany2-0의 shared memory_id
  ├─ Git: csncompany2-0의 repository
  └─ commit: csncompany2-0 repository의 commit
```

`agentstoz` 프로젝트 폴더에서 작업하거나, AgentsToZ의 관리용 memory에 작업 이력을 기록하거나, 다른 프로젝트 repository에 commit하면 안 된다. `agentstoz`는 프로젝트를 해석하고 worker를 파견할 뿐이며, 실제 작업·장기기억·Git 결과는 항상 `#`으로 지정된 대상 프로젝트에 기록된다.

다음 불변식은 모든 구현·테스트·보고에 적용한다.

```text
resolved_project(#X)
  == execution_project(#X)
  == memory_project(#X)
  == git_project(#X)
```

이 네 가지가 하나라도 다르면 작업 성공으로 판정하지 않는다. 대상 프로젝트의 로컬 폴더가 현재 단말에 없거나, 그 프로젝트의 memory_id/Git remote를 확인할 수 없으면 작업을 시작하지 않고 clone·등록·memory 연결을 안내한다.

### 3.1 트리거

최소한 다음 형식을 지원한다.

```text
@agentstoz-bot #프로젝트이름 작업내용
```

지원할 수 있는 확장 형식:

```text
@agentstoz-bot #프로젝트alias 작업내용
@agentstoz-bot #memory-id 작업내용
@agentstoz-bot #project-name --new 작업내용
```

단, 기본 경로는 사람이 읽는 `#프로젝트이름`이다.

### 3.2 해석 우선순위

프로젝트 토큰을 다음 순서로 해석한다.

1. 현재 Telegram topic/thread의 명시적 project binding
2. 현재 단말에 등록된 프로젝트 alias
3. 현재 단말의 정확한 project name
4. AgentsToZ의 등록된 project record
5. 명시적이고 검증된 `memory_id`

다음은 금지한다.

- 비슷한 이름을 fuzzy-match하여 임의 선택
- 단말이 다른 프로젝트를 자동 선택
- `memory_id`가 다른 프로젝트를 이름만 보고 연결
- 로컬에 없는 프로젝트를 경로 추측으로 열기
- 사용자가 지정하지 않은 기본 프로젝트로 조용히 fallback

해석 결과에는 최소한 다음이 있어야 한다.

```json
{
  "projectName": "csncompany2-0",
  "memoryId": "stable-shared-memory-id",
  "deviceId": "current-device-id",
  "canonicalPath": "/absolute/path/to/csncompany2-0",
  "repositoryUrl": "https://github.com/owner/repository",
  "bindingSource": "telegram-topic|device-project|explicit-memory-id"
}
```

### 3.3 해석 실패

다음 상황에서는 작업을 시작하지 않는다.

- 프로젝트 토큰 없음
- 둘 이상의 프로젝트가 일치
- 현재 단말에 프로젝트 폴더 없음
- 등록된 `memory_id`와 로컬 memory 설정 불일치
- Git remote가 예상 repository와 불일치
- 프로젝트가 revoked/retired 상태
- 다른 작업이 같은 프로젝트에 active lock을 보유

사용자에게 다음 중 필요한 조치를 명확히 안내한다.

- 정확한 `#프로젝트이름` 재지정
- 프로젝트 등록
- 해당 단말에 GitHub clone
- 기존 `memory_id` 연결
- device enrollment/권한 승인

## 4. 실제 로컬 작업 파견 계약

프로젝트 해석이 끝나면 `canonicalPath`를 작업 cwd로 사용한다.

```text
hermes desktop --cwd <canonicalPath>
```

또는 AgentsToZ의 기존 local API/native launcher를 이용하되, 최종적으로 다음을 검증해야 한다.

- 실제 child process cwd가 `canonicalPath`인지
- 작업 에이전트가 의도한 Hermes profile인지
- 작업 대상 프로젝트 이름과 memory ID가 일치하는지
- 작업 에이전트가 다른 프로젝트로 조용히 fallback하지 않는지
- 작업 완료 후 프로세스와 lock이 정상 정리되는지

cwd 환경변수나 backend 기본 폴더만 맞는 것은 충분한 증거가 아니다. 실제 실행 프로세스와 작업 결과가 해당 프로젝트에 생성되었는지 확인한다.

## 5. 장기기억 기록 계약

각 프로젝트는 단말별 로컬 경로가 다를 수 있지만, 같은 논리 프로젝트라면 같은 `memory_id`를 공유한다.

```text
Mac A / device_id A / local path A ─┐
                                     ├─ same memory_id X
Mac B / device_id B / local path B ─┘
```

작업 lifecycle:

```text
resolve project
  → Pull/check latest memory
  → execute work in canonicalPath
  → record activity and result in project memory
  → verify local memory hash
  → Push new memory revision
```

장기기억에는 최소한 다음 유형의 정보가 기록되어야 한다.

- 작업 목표
- 실제 선택된 프로젝트 identity
- 사용한 단말 identity
- 변경된 파일/영역의 요약
- 실행한 테스트와 결과
- 중요한 결정과 남은 blocker
- Git commit SHA
- memory revision/content hash
- 다음 작업에 필요한 durable context

저장하지 않는다.

- API key/token/password
- `.env` 값
- raw transcript 전체
- 임시 진행상황만 있는 내용
- 추측을 사실처럼 기록한 내용
- generic knowledge

memory 업데이트는 프로젝트의 canonical path와 stable `memory_id`를 다시 검증한 뒤 수행한다. 프로젝트를 추측하거나 다른 memory에 기록하면 안 된다.

## 6. Git 커밋 계약

이 Bot의 프로젝트 작업은 단순히 파일을 수정하고 끝나면 안 된다. 작업 결과는 해당 프로젝트의 Git repository에 남아야 한다.

기본 workflow:

```text
project resolve
  → git status/branch/remote 확인
  → 작업 수행
  → focused tests
  → 필요한 전체 검증
  → diff review
  → 장기기억 기록
  → git commit
  → commit SHA readback
  → memory revision과 함께 보고
```

커밋 전 필수 조건:

- 올바른 repository인지 확인
- 올바른 branch인지 확인
- 다른 작업자의 dirty changes 보존
- staged/unstaged/untracked 변경을 모두 검토
- secret scan
- `git diff --check`
- 관련 테스트와 typecheck/build 실행
- 커밋 대상 파일이 요청 범위를 벗어나지 않는지 확인

Push는 commit과 구분한다.

- 사용자 작업 계약이 명시적으로 원격 반영까지 포함하면 Push 수행
- 그렇지 않으면 로컬 commit까지만 하고 remote Push는 별도 승인
- Push 후에는 remote SHA를 다시 읽어 검증

최종 보고에는 반드시 다음을 포함한다.

- project name
- device ID 또는 안전한 축약 식별자
- canonical path
- memory ID 또는 안전한 식별자
- memory revision/hash
- commit SHA
- 실행한 테스트
- Git ahead/behind/dirty 상태
- Push 여부
- 남은 blocker

## 7. 단말·프로젝트·Bot 데이터 모델

현재 AgentsToZ 기반에는 다음 구조가 있다.

- 단말별 `device_id`
- 단말별 프로젝트 경로
- 공통 `memory_id`
- `device_id + memory_id` 접근 관계
- memory revision/hash
- 단말 sync 상태
- device identity alias/rotation
- 원격 AWS/Linux 단말 인벤토리
- Telegram chat/thread 연결 정보

추가로 다음 개념이 필요하다.

```text
ProjectBinding
  ├─ project_name / alias
  ├─ memory_id
  ├─ device_id
  ├─ canonical_path
  ├─ repository_url
  ├─ telegram_chat_id
  ├─ telegram_thread_id
  └─ binding_status

AgentRuntimeBinding
  ├─ device_id
  ├─ runtime_type: hermes
  ├─ profile_name
  ├─ role: project-router | project-worker
  ├─ capabilities
  ├─ adapter_version
  ├─ health_status
  └─ binding_status
```

Bot profile 이름만으로 authorization을 판단하지 않는다. device, project, memory, role, capability를 함께 검증한다.

## 8. Enrollment과 다른 Mac 설치

다른 Mac에서의 표준 설치 흐름:

1. AgentsToZ clone 및 설치
2. Hermes 설치
3. `csncompany-bot`과 `agentstoz-bot` runtime 준비
4. 새 Mac 전용 `device_id` 발급
5. 프로젝트 GitHub repository clone
6. 프로젝트의 기존 shared `memory_id` 연결
7. AgentsToZ에 `device_id + project + memory_id` 등록
8. local Hermes binding 등록
9. `@agentstoz-bot #프로젝트이름` read-only resolve 테스트
10. 해당 폴더에서 실제 작업 파견 smoke test
11. memory pull/readback 테스트
12. 테스트 작업 commit 및 SHA 검증

기존 Mac의 다음 항목은 복사하지 않는다.

- device ID
- Hermes auth/token
- `.env`
- `auth.json`
- state DB
- raw session transcript
- Gateway runtime lock

새 단말은 새 identity로 등록하고, 필요하면 기존 physical device history와 안전한 alias/rotation 절차를 사용한다.

## 9. `agentstoz-bot` 최소 명령

명령 이름은 기존 command registry와 충돌하지 않게 조정한다.

```text
/project resolve #프로젝트이름
/project status #프로젝트이름
/project devices #프로젝트이름

/memory status #프로젝트이름
/memory history #프로젝트이름
/memory pull #프로젝트이름
/memory push #프로젝트이름

/bot list
/bot status
/device list
/device enroll
/device revoke
```

그러나 가장 중요한 명령은 별도 `/project` 명령이 아니라 자연어 작업 트리거다.

```text
@agentstoz-bot #프로젝트이름 실제 작업 요청
```

이 경로가 반드시 project resolve → local dispatch → memory record → Git commit까지 연결되어야 한다.

## 10. 구현 우선순위

### Phase 1 — 프로젝트 멘션 라우터

- Telegram/Hermes 멘션 수신
- `#프로젝트이름` 파싱
- 현재 topic/device/project binding 조회
- exact resolver 구현
- ambiguous/missing project fail-closed 처리
- resolve 결과 read-only 보고

### Phase 2 — 실제 local dispatch

- canonical path 검증
- Hermes worker launch
- cwd/process/project identity 검증
- project lock 및 concurrent work 처리
- success/failure lifecycle 보고

### Phase 3 — memory lifecycle

- 작업 전 Pull/status 확인
- 작업 후 activity 기록
- memory update 및 hash 검증
- Supabase revision Push
- conflict 시 중단 및 사용자 선택

### Phase 4 — Git lifecycle

- status/remote/branch 검증
- secret scan
- 테스트·diff review
- commit 생성
- SHA readback
- Push는 별도 정책에 따라 수행

### Phase 5 — 두 번째 단말 검증

- 서로 다른 `device_id`
- 서로 다른 local path
- 동일한 `memory_id`
- 같은 `#프로젝트이름` resolve
- A에서 작업/commit/memory Push
- B에서 Pull 후 이어서 작업
- conflict 및 dirty 상태 검증

### Phase 6 — Hermes profile 정리

위 기능이 실제로 검증된 후에만 다음을 진행한다.

- `csncompany-bot` 기능 parity 확인
- `cs-company` 비밀정보 분리 아카이브
- `csn-maintainer` 아카이브
- 기존 Gateway/alias 제거
- `csncompany-bot` 및 `agentstoz-bot` runtime 안정성 확인

## 11. 필수 검증 매트릭스

### 라우팅

- 멘션 없는 메시지는 해당 Bot 작업으로 처리하지 않음
- `#프로젝트이름` 없음은 fail-closed
- 정확한 프로젝트 선택
- 동일 이름 충돌 처리
- 다른 단말 프로젝트로 fallback하지 않음

### 작업 실행

- 올바른 cwd
- 올바른 Git remote
- 올바른 memory ID
- 실제 변경 파일이 선택된 프로젝트 내부
- concurrent lock 확인

### 장기기억

- 작업 전 memory 상태 확인
- 작업 후 기록 생성
- memory hash/revision readback
- 다른 프로젝트 memory에 기록하지 않음
- conflict 자동 overwrite 금지

### Git

- commit 전 diff/secret/test 검증
- commit SHA readback
- commit과 Push 상태 구분
- 원격 Push 시 remote SHA readback

### 표면별 통합

- Telegram mention/command
- local Hermes adapter/plugin
- local API
- native/Tauri command
- desktop UI 또는 launcher
- packaged runtime
- 두 번째 Mac

UI에 버튼이나 command 문자열만 존재하는 것으로 완료 판정하지 않는다. 실제 멘션부터 최종 로컬 폴더 작업·memory 기록·Git SHA까지 end-to-end로 확인한다.

## 12. 보안 및 운영 금지사항

- 프로젝트 이름 fuzzy-match 금지
- 임의 경로 열기 금지
- 사용자 승인 없는 다른 단말 작업 금지
- revoked device 허용 금지
- token/credential Git 저장 금지
- raw conversation transcript 장기기억 저장 금지
- dirty worktree를 삭제하거나 stash로 덮어쓰기 금지
- 다른 작업자의 변경을 포함한 커밋 금지
- conflict 상태 자동 overwrite 금지
- 단순 API 200을 실제 작업 성공으로 간주 금지

## 13. Hermes 그룹 봇 채팅 운영 프로토콜

궁극적인 운영 방식은 하나의 Hermes 그룹 봇 채팅에서 두 Bot을 함께 사용하고, `#프로젝트이름`은 반드시 `agentstoz`의 프로젝트 라우팅 문법으로 해석하는 것이다.

가장 안전한 정규 문법:

```text
@agentstoz @csncompany #csncompany2-0 로그인 버그를 수정하고 테스트 후 커밋해줘
```

또는 라우팅과 실행을 두 단계로 분리한다.

```text
@agentstoz #csncompany2-0 이 프로젝트의 로그인 버그 작업을 시작해줘
@csncompany #csncompany2-0 전달받은 작업을 수행하고 테스트 후 커밋해줘
```

`@csncompany 2-0 @agentstoz #특정프로젝트명`처럼 Bot 이름과 프로젝트 이름을 분리하거나, `2-0`을 별도 토큰으로 두는 문법은 사용하지 않는다. 프로젝트 선택자가 어느 Bot에 속하는지 모호해지고, 잘못된 프로젝트로 fallback할 위험이 있다.

역할은 중복 실행되지 않도록 분리한다.

### `@agentstoz`

- `#프로젝트`를 유일한 authoritative project selector로 해석한다.
- 현재 device_id, memory_id, canonical local path, Git remote를 검증한다.
- 작업 대상 단말과 Bot capability를 확인한다.
- 같은 메시지에 `@csncompany`가 있으면 검증된 project binding과 request ID를 csncompany worker에게 전달한다.
- 직접 프로젝트 파일을 수정하지 않는다. 단, AgentsToZ control-plane 변경은 별도 명시된 경우에만 수행한다.
- resolve 실패·권한 부족·경로 불일치이면 fail-closed로 중단한다.

### `@csncompany`

- 같은 메시지에 있더라도 `#프로젝트`를 독자적으로 fuzzy-match하지 않는다.
- agentstoz가 제공한 project binding과 request ID를 사용한다.
- binding이 없으면 작업하지 않고 agentstoz resolve를 요청한다.
- canonical local path에서 실제 작업한다.
- 작업 전 memory 상태와 Git dirty 상태를 확인한다.
- 작업 후 테스트·diff·secret 검사를 실행한다.
- 프로젝트 장기기억에 durable activity/result를 기록한다.
- 검증된 변경을 프로젝트 Git repository에 commit하고 SHA를 보고한다.
- 원격 Push는 별도 승인 또는 요청 계약이 있을 때만 수행한다.

### 그룹채팅 공통 규칙

- Bot은 자신에게 멘션된 요청만 처리한다.
- `#프로젝트`는 항상 `agentstoz`가 authoritative resolver로 처리한다.
- `@agentstoz @csncompany #프로젝트 작업` 형식에서는 agentstoz가 먼저 resolve하고 csncompany가 실행한다.
- `@agentstoz #프로젝트`만 있는 형식에서는 agentstoz가 resolve 후 필요할 때 csncompany를 파견한다.
- `@csncompany #프로젝트` 단독 형식은 이전에 검증된 active binding/request context가 있을 때만 허용한다.
- `request_id`를 사용해 `agentstoz`와 `csncompany`가 같은 요청을 중복 처리하지 않게 한다.
- agentstoz의 resolve 결과 없이 csncompany가 임의 경로를 추측하지 않는다.
- 최종 결과에는 project, device, memory revision, commit SHA, tests, Push 여부를 포함한다.

## 14. 다음 작업 시작점

1. 현재 branch/SHA/dirty tree 보존
2. 기존 AgentsToZ project resolver와 Telegram topic binding 조사
3. `@agentstoz-bot #project` 입력의 source-to-runtime 경로 추적
4. RED test 작성: exact project resolve
5. GREEN 구현: local canonical path dispatch
6. 작업 결과의 memory/Git lifecycle 계약 추가
7. read-only smoke test 후 실제 테스트 프로젝트에서 end-to-end 검증
8. 두 번째 단말에서 동일 memory ID로 Pull/작업/commit 검증
9. 그 후 Hermes profile consolidation 수행

## 최종 지시사항

> `agentstoz-bot`은 단순한 AgentsToZ 관리 봇이 아니다. 사용자의 `@agentstoz-bot` 멘션과 `#프로젝트이름`을 프로젝트 라우팅 트리거로 사용하여, 현재 단말의 해당 로컬 프로젝트 폴더에 실제 작업 에이전트를 파견하는 클라이언트다. 작업 결과는 반드시 해당 프로젝트 장기기억에 기록되고, 검증된 변경은 해당 프로젝트 Git repository에 커밋되어야 한다. 프로젝트 식별·cwd·memory ID·Git repository가 하나라도 불일치하면 작업을 시작하지 말고 fail-closed로 보고한다.
