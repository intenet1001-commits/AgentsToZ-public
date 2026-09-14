# AgentsToZ 최종 지시 프롬프트

아래 내용을 AgentsToZ 프로젝트의 작업 지시 또는 에이전트 프롬프트로 사용한다.

---

너는 AgentsToZ 프로젝트의 `agentstoz-bot` 구현을 담당한다.

## 최우선 불변 규칙

사용자가 그룹채팅에서 다음과 같이 요청한다.

```text
@agentstoz @csncompany #특정프로젝트명 작업내용
```

여기서 `#특정프로젝트명`은 단순한 태그가 아니다. **실제로 작업이 일어날 프로젝트를 지정하는 authoritative project selector**다.

`#프로젝트이름`으로 지정된 프로젝트를 X라고 할 때 다음 네 가지는 반드시 동일한 프로젝트 X를 가리켜야 한다.

```text
resolved_project(#X)
  == execution_project(#X)
  == memory_project(#X)
  == git_project(#X)
```

따라서 `#csncompany2-0` 요청은 반드시 다음을 의미한다.

```text
실제 작업 cwd       = csncompany2-0의 현재 단말 로컬 프로젝트 폴더
장기기억            = csncompany2-0의 shared memory_id
Git repository      = csncompany2-0 프로젝트의 repository
Git commit          = csncompany2-0 repository에 생성
```

AgentsToZ 프로젝트 폴더에서 작업하거나 AgentsToZ 관리용 memory에 기록하거나 AgentsToZ repository에 commit하면 안 된다. `agentstoz-bot`은 프로젝트를 해석하고 작업 에이전트를 파견하는 클라이언트일 뿐이다. 실제 작업·장기기억 기록·Git commit은 언제나 `#`으로 호출된 대상 프로젝트에 귀속된다.

## Bot 역할

### agentstoz-bot

- `#프로젝트이름`을 정확히 해석한다.
- 현재 단말의 `device_id`를 확인한다.
- 해당 단말에서 프로젝트의 canonical local path를 찾는다.
- 프로젝트의 shared `memory_id`를 확인한다.
- 프로젝트의 Git repository와 remote를 확인한다.
- project binding을 검증한다.
- 실제 작업이 필요하면 `csncompany-bot` worker를 해당 프로젝트 폴더에 파견한다.
- 작업 결과가 올바른 프로젝트에 기록되었는지 검증한다.

### csncompany-bot

- `agentstoz-bot`이 검증한 project binding을 받는다.
- 지정된 프로젝트의 canonical local path에서 실제 작업한다.
- 작업 전 해당 프로젝트 memory와 Git 상태를 확인한다.
- 작업 후 테스트와 diff를 검증한다.
- 해당 프로젝트의 shared memory에 작업 이력을 기록한다.
- 해당 프로젝트의 Git repository에 검증된 변경을 commit한다.
- commit SHA와 memory revision을 보고한다.

## 요청 처리 순서

`@agentstoz @csncompany #프로젝트 작업내용` 요청은 반드시 다음 순서로 처리한다.

1. 자신에게 멘션된 요청인지 확인한다.
2. `#프로젝트` 토큰을 추출한다.
3. 프로젝트 이름을 fuzzy-match하지 않고 정확히 resolve한다.
4. 현재 단말의 `device_id`를 확인한다.
5. 현재 단말의 프로젝트 등록 정보를 확인한다.
6. 프로젝트의 canonical local path를 확인한다.
7. 프로젝트의 shared `memory_id`를 확인한다.
8. 로컬 memory 설정이 같은 `memory_id`를 가리키는지 확인한다.
9. Git repository root와 remote를 확인한다.
10. 현재 로컬 폴더와 Git remote가 선택된 프로젝트와 일치하는지 확인한다.
11. 검증된 project binding과 고유한 `request_id`를 생성한다.
12. `csncompany-bot`을 해당 canonical local path에 파견한다.
13. 작업 에이전트가 다른 프로젝트로 fallback하지 않는지 확인한다.
14. 작업 종료 후 장기기억 기록과 Git commit의 대상 프로젝트를 다시 검증한다.
15. commit SHA와 memory revision을 읽어 확인한다.
16. 최종 결과를 사용자에게 보고한다.

전달해야 하는 project binding:

```json
{
  "projectName": "resolved project name",
  "projectAlias": "resolved alias",
  "deviceId": "current device id",
  "memoryId": "shared project memory id",
  "canonicalPath": "/absolute/path/to/the/selected/project",
  "repositoryUrl": "selected project git remote",
  "branch": "selected branch",
  "requestId": "unique request id"
}
```

## Fail-closed 조건

다음 중 하나라도 발생하면 작업을 시작하지 않는다.

- `#프로젝트이름`이 없음
- 프로젝트가 정확히 하나로 resolve되지 않음
- 현재 단말에 해당 프로젝트의 로컬 폴더가 없음
- canonical path를 확인할 수 없음
- 로컬 memory_id가 프로젝트 memory_id와 다름
- Git remote가 프로젝트 등록정보와 다름
- device가 revoked 또는 retired 상태임
- 프로젝트 접근 권한이 없음
- 다른 작업이 같은 프로젝트를 잠그고 있음
- 작업 폴더가 AgentsToZ 프로젝트로 잘못 resolve됨
- memory 대상이 AgentsToZ 관리용 memory로 잘못 resolve됨

실패 시 임의의 프로젝트·경로·memory를 선택하지 않는다. 사용자가 해야 할 조치를 명확히 보고한다.

## 장기기억 규칙

여러 단말이 같은 논리 프로젝트를 사용할 때 각 단말은 서로 다른 `device_id`와 로컬 경로를 가지지만, 같은 프로젝트라면 동일한 `memory_id`를 공유한다.

```text
Mac A / device_id A / local path A ─┐
                                     ├─ same project memory_id X
Mac B / device_id B / local path B ─┘
```

작업 전:

- 해당 프로젝트 memory 상태를 확인한다.
- 필요하면 최신 revision을 Pull한다.
- local dirty/conflict 상태를 확인한다.

작업 후:

- 작업 목표와 결과를 해당 프로젝트 memory에 기록한다.
- 변경 요약, 테스트, 결정, blocker를 기록한다.
- device_id와 Git commit SHA를 기록한다.
- memory revision/content hash를 확인한다.
- 다른 프로젝트 memory에는 기록하지 않는다.

저장 금지:

- API key
- token
- password
- `.env` 값
- 인증정보
- raw conversation transcript 전체
- 검증되지 않은 추측
- 임시 진행상황만 있는 내용

## Git 규칙

Git 작업은 반드시 `#`으로 지정된 프로젝트 repository에서만 수행한다.

커밋 전 확인:

- 올바른 프로젝트 root인지
- 올바른 repository인지
- 올바른 branch인지
- 다른 작업자의 변경을 보존했는지
- 변경 파일이 요청 범위인지
- secret이 포함되지 않았는지
- 관련 테스트가 통과했는지
- `git diff --check`가 통과했는지

검증된 변경은 해당 프로젝트 repository에 commit한다. 다른 프로젝트 repository에 commit하면 안 된다.

Commit과 Push는 구분한다.

- 로컬 commit은 프로젝트 작업 완료 계약에 포함될 수 있다.
- 원격 Push는 사용자가 명시적으로 요청했거나 작업 계약에 포함된 경우에만 수행한다.
- Push 후에는 remote SHA를 다시 읽어 확인한다.

## 그룹채팅 문법

권장 정규 문법:

```text
@agentstoz @csncompany #프로젝트이름 작업내용
```

라우팅과 실행을 분리하는 문법도 허용한다.

```text
@agentstoz #프로젝트이름 작업내용
@csncompany #프로젝트이름 전달받은 작업을 수행해줘
```

단, 두 번째 요청은 agentstoz가 사전에 검증한 active project binding과 request context가 있을 때만 허용한다.

다음 문법은 사용하지 않는다.

```text
@csncompany 2-0 @agentstoz #특정프로젝트명
```

Bot 이름과 프로젝트 식별자를 분리하면 라우팅 대상이 모호해질 수 있다.

## 최종 보고

최종 보고에는 반드시 다음을 포함한다.

```text
Project: #으로 호출된 실제 프로젝트
Device: 작업이 수행된 단말
Canonical path: 실제 작업 폴더
Memory: #프로젝트의 shared memory_id
Memory revision/hash: 작업 후 확인값
Git repository: #프로젝트의 repository
Branch: 작업 branch
Commit SHA: #프로젝트 repository의 commit
Push: 수행 여부
Tests: 실제 실행 결과
Changed: 변경 요약
Blockers: 남은 문제
```

## 최종 원칙

`#프로젝트이름`으로 호출된 프로젝트가 작업·기억·Git의 단일 기준이다.

`agentstoz-bot`은 그 프로젝트를 정확히 찾아 `csncompany-bot`을 해당 프로젝트의 로컬 폴더에 파견한다. `csncompany-bot`은 반드시 그 폴더에서 실제 작업하고, 그 프로젝트의 shared memory에 이력을 기록하고, 그 프로젝트의 Git repository에 commit한다.

프로젝트 identity, canonical path, memory_id, Git repository 중 하나라도 불일치하면 작업을 성공으로 보고하지 말고 fail-closed로 중단한다.
