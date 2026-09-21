# Agent Runtime Containment Gate

- 상태: 설계 확정, production execution `BLOCKED`
- 우선 구현 대상: Apple Silicon + macOS 26+
- 최종 갱신: 2026-09-04

## 왜 별도 격리가 필요한가

Codex의 `workspace-write` sandbox는 파일 접근 범위를 제한하지만 task의 모든 자손 수명을
소유하지 않는다. macOS에서 sandbox 안의 Node가 `detached:true`로 새 session/PGID를 만든 뒤
provider와 현재 guard가 끝나도 허용된 workspace를 계속 수정하는 것을 재현했다. 따라서 다음은
서로 다른 안전 경계다.

- Codex sandbox: tool의 파일·네트워크 권한
- AgentsToZ containment: task의 모든 실행 주체 수명과 실제 프로젝트 쓰기 권한
- Workspace Lease: 위 경계를 따르는 협조적 host writer의 직렬화

PGID 소멸이나 provider 종료만으로 마지막 두 조건을 증명할 수 없다. 이 gate를 통과하기 전에는
`workspace-write`와 `dangerously-bypass-approvals-and-sandbox` 모두 production에서 열지 않는다.

## 공통 불변식

1. untrusted task는 등록된 실제 project, linked worktree, Git common-dir, 앱 데이터, 장기기억
   원본을 직접 RW로 받지 않는다.
2. provider spawn 전에 task identity와 containment resource를 durable하게 예약한다.
3. success, failure, cancel, timeout, app/sidecar crash 모두 같은 강제 종료 경로를 지난다.
4. OS resource의 empty/absent proof 전에는 terminal success, lease release, 다음 writer 시작을
   확정하지 않는다.
5. task 결과는 regular-file-only manifest로 검증한 뒤 host가 새 AgentsToZ branch/worktree에
   materialize한다. task가 `.git`을 직접 수정한 결과는 가져오지 않는다.
6. target HEAD 또는 identity가 snapshot 뒤 바뀌면 자동 적용하지 않고 격리 결과를 보관한다.
7. containment dependency, version, binary/image identity, self-test 중 하나라도 불명확하면
   provider spawn 전에 fail closed한다. 약한 fallback은 두지 않는다.

## macOS V1 결정

```text
clean registered Git target
        │ host snapshot: exact commit + clean proof
        ▼
별도 runtime UID가 소유한 task별 독립 staging checkout
        │ Git·기억·provider 제어 파일을 제외한 작업 파일만 포함
        │ staging만 RW mount
        ▼
signed app → root broker → 전용 UID worker
        │ exact policy/TCB digest + durable reserve/seal
        ▼
Apple Container: task마다 별도 Linux VM
        │ pinned Linux Codex image + app-server
        ▼
exact stopped inspect → start → running inspect
        │ stop → kill → force-delete → list absent
        │ marker quiet + target/common-dir hash unchanged
        ▼
bounded result manifest 검증
        │ host-side Git operation under family lease
        ▼
새 AgentsToZ branch/worktree에 regular-file 변경 반영
```

실제 target을 VM에 RW mount하지 않는다. 여기서 staging checkout은 `.git`, `.agent-memory`,
`.agents`, `.claude`, `.codex`, `AGENTS.md`, `CLAUDE.md` 같은 제어 파일을 애초에 포함하지 않는
일회용 작업 트리다. 필요한 지침은 별도의 고정·읽기 전용 입력으로 주입한다. Apple `container`
daemon과 guest가 sidecar보다 오래 살아도 수정 가능한 곳은 폐기 가능한 staging뿐이어야 한다.
로그인 사용자와 같은 UID의 Apple service는 service root와 상태를 바꿔 proof를 위조할 수 있으므로
production 경계가 아니다. signed Tauri main process, 최소 root broker, 전용 non-login UID의
`user/<uid>` launchd domain worker를 분리한다. `container run` host process에
signal을 보내는 것만으로 종료를 판정하지 않는다. exact container ID와 nonce를 durable registry에
기록하고 별도 trusted argv로 `stop`, `kill`, `delete --force`를 실행한 뒤 부재를 확인한다.

상세한 권한·서명·filesystem 설계와 harmless namespace 시험은
[`agent-runtime-macos-broker.md`](./agent-runtime-macos-broker.md)가 정본이다.

### 최초 capability gate

- `arm64`, macOS 26 이상
- Apple `container` CLI와 API server가 모두 정상
- Developer ID로 상호 인증된 Tauri main process/root broker와 전용 UID worker
- exact appRoot/installRoot/config/plugin/launchd inventory와 같은-UID service 교체 불가 proof
- 자동 설치·자동 latest pull 금지
- 실측한 exact CLI version allowlist. 첫 검증 후보는 `1.3.1`
- 전체 1.3.1 payload code identity, 추출 kernel hash, pinned vminit/workload OCI identity 일치
- task별 sanitized `CODEX_HOME`; 실제 host home·credential의 guest tool 노출 금지
- 최종 정책과 같은 adversarial self-test 통과

서명·hash·version·service 상태 검사는 dependency probe다. 모두 맞아도 capability는
`self-test-required`이며, 고정 image와 설치본에서 아래 escape 시험의 최신 성공 증거까지 결합한
최종 gate만 `ready`를 만들 수 있다. dependency probe 단독 성공을 실행 권한으로 승격하지 않는다.

현재 trusted argv planner의 `network none`은 lifecycle canary/E2E 전용이다. 실제 Codex
app-server는 provider와 통신할 guest 외부망이 필요하므로 production image는 바깥 VM의 제한된
provider 통신과 안쪽 tool process의 네트워크 namespace를 분리한다. 고정 Codex build의 Linux
bubblewrap permission profile로 tool child의 network를 끊고 `CODEX_HOME/auth.json`을 deny-read한
상태를 adversarial test로 검증해야 한다. app-server의 `thread/shellCommand`는 공식 문서상 thread
sandbox를 상속하지 않는 unsandboxed API이므로 AgentsToZ runtime allowlist와 원격 protocol에 넣지
않는다. 이 구조는 일반 `workspace-write` 후보를 위한 것이며 위험 모드의 증거로 재사용하지 않는다.

Apple `--init`은 별도 implicit artifact를 선택하므로 사용하지 않는다. 고정 OCI digest 안의 PID 1
init/reaper, Codex build, bubblewrap와 permission profile도 image identity 및 E2E 증거의 일부다.
[Codex app-server API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[Codex Linux bubblewrap](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/bwrap.rs)

현재 개발 Mac은 `arm64`, macOS `26.5.1`이다. 관리자 승인을 거쳐 공식 Apple Container 1.3.1이
설치됐고 package receipt(`com.apple.container-installer`), CLI version, 17개 payload의 exact
SHA-256/Apple signing identity와 closed plugin tree를 읽기 전용으로 검증했다. 이 증거의 scope는
`identity-only`, `ready:false`다. 별도-UID broker gate 전에는 `container system start`나 canary를
실행하지 않는다. Apple Container는 container마다 경량 VM을 사용한다.
[Apple Container 기술 개요](https://github.com/apple/container/blob/main/docs/technical-overview.md),
[설치 요구사항](https://github.com/apple/container),
[1.3.1 release](https://github.com/apple/container/releases/tag/1.3.1)

macOS app/broker의 `src/macOSRuntimeBrokerSigning.ts` schema v2 검사도 같은 원칙을 따른다. 전체
bundle과 두 peer의 정적 서명을 엄격히 확인하더라도 반환값은
`scope:static-signature-snapshot-only`, `authoritative:false`, `reusable:false`, `ready:false`다.
호출자가 Team ID를 넘길 수 없고 signed native build의 compile-time pin만 허용한다. pathname
snapshot은 live process 권한이나 `brokerTcbDigest`로 재사용하지 않는다. 최종 gate는 notarized
Gatekeeper app bundle protection, exact SMAppService 승인 상태, 공개 XPC live peer code-signing requirement,
broker가 직접 산출한 fresh TCB proof를 별도로 요구한다. 현재 로컬 앱은 ad-hoc/Gatekeeper rejected,
설치 앱에는 broker helper가 없으므로 계속 fail closed한다.

Apple Container의 foreground client signal forwarding에는 아직 열린 결함이 있으므로 lifecycle
구현은 `container run` PID 종료에 의존하지 않는다.
[apple/container PR #1997](https://github.com/apple/container/pull/1997)

## Linux 기준선

Linux production 경계는 `root-owned narrow broker → PID1 systemd transient system service →
cgroup v2 → fixed bwrap namespaces → Codex app-server`로 제한한다. `systemd-run --user`, PGID,
bare bwrap, cgroup v1/hybrid, legacy Landlock fallback은 production authority가 아니다.

- unit: `ExitType=cgroup`, `KillMode=control-group`, `Delegate=no`,
  `ProtectControlGroups=strict`, `NoNewPrivileges=yes`, resource limits
- sandbox: user/PID/mount/IPC/UTS/cgroup/network namespace, minimal RO runtime, selected staging만 RW
- 종료 proof: anchored cgroup의 `cgroup.kill` 뒤 recursive `cgroup.events`가 `populated 0`
- broker는 arbitrary command/path/env가 아닌 registered target ID와 fixed policy만 받음

[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[systemd cgroup delegation](https://github.com/systemd/systemd/blob/main/docs/CGROUP_DELEGATION.md),
[bubblewrap](https://github.com/containers/bubblewrap),
[Codex Linux sandbox](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)

## Windows 기준선

기존 PowerShell Job wrapper는 일반 프로세스용으로 유지하되 Agent Runtime 보안 경계로 재사용하지
않는다. Rust native helper가 provider를 생성 순간부터 non-inheritable Job Object에 넣고 제한된
stdio handle만 전달해야 한다.

- `PROC_THREAD_ATTRIBUTE_JOB_LIST`로 spawn race 제거
- `KILL_ON_JOB_CLOSE` 설정 readback과 `IsProcessInJob` 확인
- 모든 종료 경로에서 `TerminateJobObject` 뒤 `ActiveProcesses == 0` 확인
- registry는 guard PID와 process creation time을 함께 저장해 PID reuse를 거부
- Windows Codex PE/package/hash/version과 가능한 Authenticode identity 검증

Job을 상속하지 않는 WMI/service/task-scheduler 같은 broker 탈출 표면이 있으므로 native Job만으로
위험 모드를 열지 않는다. staging 격리, Codex sandbox 호환, broker escape E2E까지 별도 통과해야 한다.
[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)

## 구현 state machine

```text
reserved
  → staging-prepared
  → containment-created
  → running
  → stopping
  → stopped-proven
  → result-validated
  → materialized
  → disposed
```

- `reserved`는 어떤 external create보다 먼저 FULL-durable 저장한다.
- `reserved`에는 아직 staging identity가 없다. 준비가 끝난 뒤 `sealStaging` CAS만
  `staging-prepared`와 immutable identity를 같은 transaction으로 기록하며 일반 transition은 이를
  대신할 수 없다.
- registry와 audit은 exact image, `executionPolicyDigest`, 실제 `kernelSha256`, 전체
  `brokerTcbDigest`를 불변으로 보존한다. 정책/TCB가 바뀌면 기존 row를 재사용하지 않는다.
- `containment-created` 이후에는 resource가 존재하지 않을 가능성까지 포함해 exact-ID reconcile을
  수행한다. 단순 PID lookup이나 이름 prefix 일괄 kill은 금지한다.
- `stopped-proven` 전 cleanup timeout은 `PROCESS_TERMINATION_UNCONFIRMED`이며 host를 degraded로
  두고 자동 lease recovery와 새 writer를 차단한다.
- 새 sidecar는 이전 task의 OS resource를 먼저 reconcile한 뒤에만 containment-qualified supervisor
  lock을 회수한다. broker는 app/sidecar와 독립적으로 disconnect/lease expiry를 처리하고 OS namespace
  전체와 durable registry를 대조한다. 현재 `manual` lock을 무조건 삭제하는 migration은 두지 않는다.
- `materialized`는 target base identity, output manifest, 새 worktree identity를 한 transaction-like
  journal 흐름에 기록한다. 실패 시 staging을 quarantine하고 실제 target은 그대로 둔다.

## 결과 반영 allowlist

- 상대 normalized path의 regular file과 명시적 deletion만 허용
- 절대경로, `..`, NUL, case collision, Unicode normalization collision 거부
- symlink, hardlink ambiguity, FIFO, socket, device, mount point 거부
- `.git` 전체와 app-data/memory control 파일 거부
- file count, per-file bytes, total bytes, path depth 제한
- base snapshot과 다른 target에는 자동 apply 금지
- 새 branch/worktree 생성 뒤 diff를 다시 계산해 UI review 대상으로 제공

## 설치본 acceptance gate

다음 fixture는 TERM/HUP를 무시하고 double-fork, `setsid`/새 PGID, detached stdio, process rename,
heartbeat write를 수행한다.

- 정상 완료, cancel, timeout, guard crash, sidecar crash, 전체 앱 crash
- reserve/create/handshake/provider exit/cleanup 각 경계에서 강제 crash
- containment empty/absent proof 전에 lease가 풀리지 않음
- proof 뒤 heartbeat가 멈추고 orphan resource가 없음
- 실행 중과 종료 후 실제 target, sibling worktree, Git common-dir, 앱 데이터, 기억 원본 hash 불변
- 잘못된 task ID/nonce가 다른 resource를 정리하지 못함
- CLI/image/helper 교체와 version drift가 spawn 전에 차단됨
- 로그인 UID가 Apple service register/bootout/swap, appRoot/installRoot/plugin/config/kernel 교체,
  broker/worker IPC impersonation을 하지 못함
- malicious output path/symlink/special-file/case-collision이 materialize되지 않음
- staging ancestor rename/symlink ABA가 native fd-relative 재검증에서 차단됨
- snapshot 뒤 target 변경 시 결과 보관만 하고 자동 반영하지 않음
- 100회 crash/restart 반복에서 orphan, 중복 terminal event, 중복 writer가 0건

macOS 설치본에서 이 gate를 통과한 뒤에만 `workspace-write` capability를 연다. 위험 모드는 task
코드의 credential·network 접근을 별도로 차단하고 검증하기 전까지 계속 비활성화한다.
