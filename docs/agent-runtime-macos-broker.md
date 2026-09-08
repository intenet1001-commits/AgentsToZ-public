# macOS Agent Runtime privilege boundary

- 상태: 설계 확정 · Tauri-main SMAppService/XPC client bridge · native broker/same-UID fixture · 전용 UID background worker/coordinator · OpenDirectory 전용 계정 provisioner · 개발/운영 app bundle stage와 generated Objective-C compile 경로 구현 · 운영 인증서 실서명/전체 app 서명/실제 계정 생성·등록·fixture 실행 전 · containment readiness `BLOCKED`
- 대상: Apple Silicon, macOS 26+, Apple Container 1.3.1
- 최종 갱신: 2026-09-05

## 결론

macOS production 경계는 다음 3계층이다.

```text
Developer ID로 서명된 Tauri main process
        │ mutual code-sign-pinned NSXPC
        ▼
최소 root broker (SMAppService, system domain)
        │ root/dedicated-UID 전용 IPC
        ▼
unprivileged runtime worker (전용 non-login UID, user/<uid> domain)
        │
        └─ com.apple.container.* services + task별 Linux VM
```

현재 로그인 사용자의 Apple Container service를 앱이 직접 호출하는 구성은 보안 경계가 아니다.
Apple Container 1.3.1의 XPC 권한은 같은 UID의 다른 프로세스를 구분하지 못하므로, 실행 중인 task가
service를 중지하고 자신이 제어하는 `appRoot`/`installRoot`로 다시 시작해 container 상태와 검증 출력을
위조할 수 있다. 같은 UID의 서명된 wrapper를 하나 더 두어도 이 문제는 사라지지 않는다.

## 위협 모델

VM 안의 provider/tool 코드가 다음을 시도한다고 가정한다.

- daemonize, double-fork, `setsid`, 새 PGID, app/sidecar 연결 종료 뒤 계속 쓰기
- 로그인 사용자 권한으로 CLI/XPC/launchd/service 상태를 교체하거나 위조
- 사용자 설정, plugin search path, mutable image/kernel alias로 다음 실행의 TCB 교체
- 앱·sidecar·worker·Mac crash 사이에서 registry rollback 또는 orphan resource 재사용
- staging path의 symlink/rename/ancestor ABA로 실제 프로젝트에 쓰기

앱의 orchestrator와 서명된 broker 설치본은 trusted computing base지만 crash할 수 있다. root compromise,
커널 compromise와 사용자가 관리자 권한으로 의도적으로 설치본을 바꾸는 경우는 이 경계 밖이다. 단,
그런 변경을 다음 실행 전 identity drift로 감지해 fail closed해야 한다.

## 왜 단순 LaunchDaemon이 아닌가

Apple Container의 `system start`와 apiserver는 실행 중 직접 plist를 만들고 `launchctl bootstrap`으로
plugin과 instance service를 추가한다. `UserName=_agentstoz`만 붙인 system LaunchDaemon에서 stock
apiserver를 실행하면 unprivileged process가 root 전용 system domain을 수정해야 해 동작이 보장되지
않는다. 반대로 apiserver 전체를 root로 실행하면 큰 Apple Container/plugin 표면 전체가 root가 된다.

따라서 root broker는 계정과 launchd domain lifecycle만 소유하고, Apple Container는 전용 UID의
`user/<uid>` domain 안에서 unprivileged worker가 실행한다. `launchctl(1)`상 user domain은 GUI 로그인
세션 없이도 존재할 수 있지만, stock 1.3.1의 동적 descendant bootstrap이 이 Background domain에서
끝까지 동작하는지는 harmless fixture로 먼저 실증한다. 실패하면 Apple Container provider는 보류하며
root 실행으로 우회하지 않는다.

## 각 계층의 최소 권한

### Tauri main process

- Bun/API sidecar가 아니라 native Tauri main process만 broker의 NSXPC client가 된다.
- 기존 local/remote authorization을 먼저 통과한 opaque task intent만 전달한다.
- arbitrary executable, argv, shell, environment, host path, credential을 broker에 보내지 않는다.
- broker의 exact signing identifier와 Team ID를 연결 resume 전에 검증한다.

### Root broker

- `SMAppService`가 등록한 exact system label과 Mach service만 사용한다.
- exact 앱 identifier, Team ID, Developer ID Application chain/OID, 전용 entitlement를 가진 client만
  받으며 PID·path·UID만으로 인증하지 않는다.
- 전용 계정 manifest를 검증하고 `user/<uid>` domain과 worker lifecycle을 소유한다.
- task namespace enumeration, lease expiry, client disconnect와 부팅 시 미완료 resource를 먼저
  reconcile한다. JavaScript `finally`는 crash cleanup 근거가 아니다.
- prompt, provider output, Git diff, OCI payload를 해석하거나 Apple CLI를 root로 실행하지 않는다.

### Runtime worker

- 설치 시 만든 locally unique non-login/no-password/non-admin UID/GID로만 실행한다.
- 자신의 `user/<uid>` namespace와 private socket만 사용한다.
- broker가 고정한 policy ID에 해당하는 argv만 실행한다. 임의 command/path/env 요청은 없다.
- 실제 프로젝트·worktree·Git common-dir·장기기억을 읽거나 mount하지 않는다. 전용 UID가 소유한
  task별 staging 하나만 guest에 RW로 제공한다.

## 서명과 배포 gate

production client 인증에는 다음이 전부 필요하다.

- Developer ID Application으로 앱, native bridge, broker, worker를 inside-out 서명
- exact identifier와 같은 non-placeholder Team ID
- Hardened Runtime, secure timestamp, exact 전용 entitlement
- Developer ID Installer로 서명한 `.pkg`와 notarization/stapling
- 앱과 broker 양쪽의 mutual code-signing requirement

`src/macOSRuntimeBrokerSigning.ts`의 schema v2 검사는 이 목록 중 정적 서명 형식만 보는 일회성
snapshot이다. 결과는 literal `authoritative:false`, `reusable:false`, `ready:false`이며 registry의
`brokerTcbDigest`나 실행 권한 입력으로 사용할 수 없다. Team ID도 후보 파일이나 환경변수에서 받지
않고 signed native build에 compile-time으로 고정한다. 현재 그 pin은 의도적으로 미설정이다.

production build 입력 발견도 별도 fail-closed 단계다. `src/macOSRuntimeProductionIdentity.ts`는
shell 없이 exact `/usr/bin/security find-identity -v -p codesigning`만 실행하고, 출력 전체와 summary
count를 엄격히 파싱해 exact `Developer ID Application` 후보가 하나일 때만 내부 identity를 만든다.
0개·복수·placeholder/malformed Team ID·알 수 없는 출력·timeout/truncation은 모두 거절한다. 공개
diagnostic에는 인증서 이름·fingerprint·Team ID가 없고 이것만으로 build나 runtime을 허용하지 않는다.

`src/macOSRuntimeProductionCanary.ts`는 그 한 후보의 private key로 fixed `/usr/bin/true` 사본만 임시
서명한다. `--options runtime --timestamp` 뒤 exact Team ID, 3단 Developer ID authority chain,
Hardened Runtime flag, secure timestamp와 Apple OID를 포함한 designated requirement를 다시 검증하고
임시 디렉터리를 제거한다. 시스템 사본의 thin arm64/arm64e와 universal x86_64+arm64/arm64e 형식을
허용하되 서명·requirement 검증은 모든 architecture에 적용한다. 출하하는 broker·worker·app의
thin arm64 검사는 별도로 유지한다. canary도 `build-key-possession-snapshot-only`이며
`authoritative:false`, `reusable:false`, `ready:false`다. `bun run inspect:macos-runtime-production`은
두 공개 diagnostic만 출력하며 하나라도 실패하면 exit 2다. 실제 production build는 이 snapshot
뒤에도 generated compile-time pin, inside-out artifact verification, notarization, 설치 후 live XPC
검증을 별도로 통과해야 한다.

첫 generated pin 단계도 코드로 분리했다. `src/macOSRuntimeProductionSourcePin.ts`는 raw Team ID가
아니라 canary가 통과한 build-private resolution만 받고, checked-in `nil` sentinel이 각 파일에 정확히
한 번 있을 때만 Swift contract/self-test, Objective-C Tauri bridge, TypeScript static probe 네 source를
한꺼번에 생성한다. fingerprint와 인증서 common name은 결과 source에 넣지 않으며, 일부만 생성하거나
저장소 원본을 수정하는 API는 없다. 아직 이 생성 결과를 scratch Tauri/Swift build에 소비해 실제
Developer ID 산출물을 만드는 orchestration은 연결 전이다.

`stage-macos-runtime-production-sources.ts`는 이 생성기를 실제 scratch tree에 연결한다. identity와 네
sentinel을 모두 메모리에서 먼저 검증한 뒤에만 임시 디렉터리를 만들고, Swift package의
`Package.swift`·`Sources`·`Config`·`ClientBridge`만 symlink 없이 복사한다. `.artifacts`와 다른 작업
산출물은 복사하지 않는다. Swift 두 파일은 scratch package 안에서 교체하고 Objective-C/TypeScript
생성본은 별도 `Generated` 폴더에 둔다. stage descriptor를 바꿔치기한 cleanup은 거절하며, 현재
실제 인증서 0개 상태에서는 scratch directory 생성 전 `production-identity-unavailable`로 끝난다.

`bun run test:macos-runtime-production-sources`는 고정 test-only Team ID를 이 scratch 경로에만 넣어
Swift release package와 protocol self-test, macOS 10.13 target Objective-C bridge, TypeScript probe를
실제로 컴파일한다. 2026-09-05 실측은 세 컴파일이 모두 통과했다. 이 fixture는 서명하지 않고
서비스·계정·설치본을 건드리지 않으며 결과도 `ready:false`다. macOS 26 Apple Silicon CI에도 기존
harmless native fixture와 별도 단계로 추가했다.

`bun run test:macos-runtime-native:repeat`는 먼저 development artifact manifest와 broker-fixture
SHA-256을 맞춘 뒤 same-UID bounded challenge를 정확히 100회 새 프로세스로 실행한다. 2026-09-05
실측은 100/100 통과(약 1.14초)였다. 이것은 process/stdio protocol 반복 안정성 근거이지, 아직 없는
Developer ID root service의 crash/reboot 100회 증거가 아니다.

`src/macOSRuntimeProductionSigningPlan.ts`는 canary identity와 exact scratch artifact layout에서만
8개의 `/usr/bin/codesign` argv를 만든다. broker와 dedicated worker를 먼저 각각 Hardened Runtime +
secure timestamp로 서명하고, 두 파일을 strict verify/display한 다음 Apple Developer ID issuer/leaf OID,
Team ID, identifier를 requirement로 재검증한다. broker requirement에만 exact `service-v1` entitlement를
요구하고 worker 서명에는 entitlement 입력을 넣지 않는다. 이 plan 자체는 앱 서명·notarization·설치를
하지 않으며 `ready:false`다. `src/macOSRuntimeProductionSigningExecutor.ts`는 이 여덟 명령만 순서대로
실행하고 bounded/fatal-UTF8 출력을 검사한 뒤, 두 display에서 identifier·thin arm64·SHA-256 full CDHash·
Team ID·3단 authority·Hardened Runtime·secure timestamp를 다시 파싱한다. integrity, inspection,
requirement 진행 상태를 서로 다른 receipt 필드로 남겨 중간 성공을 전체 검증으로 표시하지 않는다.
가짜 command 결과에 대한 성공/오염/timeout/partial-progress 테스트는 통과했지만, 실제 identity가 없어
host에서 이 executor의 production 성공 경로는 아직 실행하지 못했다.

`build-macos-runtime-native-production.ts`는 위 단계를 한 생명주기로 연결했다. canary를 한 번 통과한
identity로 scratch source를 만들고, Swift release build와 protocol self-test, thin arm64/minimum 13.0을
검증한 뒤 fresh scratch artifact root에 broker·dedicated worker·broker entitlement만 복사한다. 이어
8단계 signing executor가 성공해야만 서명 후 SHA-256 manifest를 callback에 제공하며 callback 종료 뒤
source와 signed artifacts를 함께 제거한다. manifest에는 Team ID·fingerprint·certificate name이 없고,
앱 bundle/sign/notarize/install/service/account 필드는 모두 false다. 현재 실제 실행은
`production-identity-unavailable` exit 2였으며 작업트리 변화가 없었다.

`stage-macos-runtime-production-bundle.ts`는 signing receipt의 여덟 세부 증명과 broker/worker/plist/
app-client-entitlement SHA-256을 다시 확인한 뒤에만 두 helper와 두 고정 plist를 새 app bundle에
원자적으로 배치한다. 이 결과도 전체 app 서명 전이므로 `executionAuthorized:false`와 `ready:false`다.
`src-tauri/build.rs`는 평상시에는 Team ID가 nil인 checked-in bridge만 컴파일하지만, production native
callback이 제공한 exact scratch `Generated/RuntimeBrokerClientBridge.m`만 별도 경로로 받아 컴파일할 수
있다. 상대경로, symlink, 다른 파일명·scratch 구조는 빌드 전에 거절한다.

`src/macOSRuntimeProductionAppSigningPlan.ts`와
`src/macOSRuntimeProductionAppSigningExecutor.ts`는 unsigned Tauri app에 위 helper가 stage된 다음의
inside-out 서명을 고정한다. 세 compiled sidecar를 각각 stable identifier로 sign/verify/require하고,
이미 서명된 broker/worker를 다시 verify한 뒤에만 client entitlement를 가진 outer app을 서명한다.
마지막 deep verify는 검증에만 사용하며 `--deep` 재서명은 금지한다. 총 17개 codesign 동작은 bounded
출력과 partial progress를 기록하고 app의 Team ID·Developer ID chain·Hardened Runtime·timestamp·client
entitlement를 다시 파싱한다. 이 receipt도 notarization·설치·live XPC 전이므로 권한은 부여하지 않는다.
`src/macOSRuntimeProductionAppBuild.ts`는 native callback, helper/plist stage, 17단계 app signing receipt를
하나의 fail-closed build 결과로 합친다. 모든 세부 증명이 맞아야
`signed-awaiting-notarization`이 되며, 이 상태도 `executionAuthorized:false`다.

snapshot은 전체 app bundle의 deep/all-architecture 서명, app/helper의 exact identifier·thin arm64
format·full CDHash·Developer ID issuer/leaf OID·authority chain·Hardened Runtime·timestamp와 역할별
단 하나의 versioned entitlement를 확인한다. 경로의 dev/inode/uid/gid/mode/nlink/size/ctime drift도
호출 사이에 거절하지만 pathname TOCTOU를 제거하는 권한 증명은 아니다. production 권한은 native
계층이 다음을 모두 확인한 뒤에만 부여한다.

- notarized product를 Gatekeeper가 확인해 app bundle protection이 적용된 상태
- exact `Contents/Library/LaunchDaemons` plist, `BundleProgram`, SMAppService label/status와 사용자 승인
- 새 연결마다 공개 XPC code-signing peer requirement가 확인한 live sender의 exact identifier, Team ID,
  Developer ID chain과 versioned role entitlement. `NSXPCConnection`의 공개 API에 raw audit token은 없으므로
  KVC/SPI나 PID→경로 재탐색으로 대체하지 않는다.
- broker가 root/전용 UID namespace에서 직접 산출한 fresh TCB digest와 registry policy digest 일치

현재 `/Applications/AgentsToZ_byCS.app`은 로컬 개발용 ad-hoc 서명이고 Gatekeeper assessment가
`rejected`이며 broker helper도 없다. 새 Swift package가 만든 helper는 ignored `.artifacts` 밖으로
나가지 않고 앱 번들에도 포함되지 않는다. 따라서 이 설치본으로 SMAppService 등록이나 broker 실행을
시도하지 않는다. production notarized+Gatekeeper-protected embedded-helper 모델을 쓰지 않는다면
대안은 pkg가 root-only 경로와 legacy LaunchDaemon을 설치하는 별도 설계이며 두 모델의 증거를 섞지
않는다.

현재 `src-tauri/tauri.conf.json`의 `signingIdentity: "-"`와 `build-macos.ts`의 identifier-only ad-hoc
재서명은 개발 전용이다. 같은 identifier의 바이너리를 로그인 사용자가 만들 수 있으므로 이 채널은
broker 등록과 production XPC를 항상 거절한다. `codesign --deep --sign -` 후처리를 production 빌드에
사용하지 않는다. build wrapper는 현재 `--dmg`, `--allow-unpublished-source` 외 옵션을 version 증가 전에
exit 64로 거절하며, 아직 연결되지 않은 `--production-runtime`을 주면 ad-hoc build로 조용히 대체하지
않는다는 오류를 낸다.

## 고정 filesystem/TCB 정책

- `installRoot`는 exact `/usr/local`이며 Apple 1.3.1의 17개 payload, closed built-in plugin tree,
  Apple Team ID, signing identifier와 SHA-256을 모두 다시 확인한다.
- `/usr/local/libexec/container-plugins`는 **부재**해야 한다. 이 user-plugin 경로는 built-in보다 먼저
  검색되며 directory symlink도 허용하므로 존재 자체를 drift로 취급한다.
- release root는 exact
  `/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1`이다.
  상위와 appRoot top-level은 root 소유·비쓰기 가능이어야 하고, 미리 열거한 mutable leaf만 전용 UID
  0700으로 둔다. stock layout이 이 정책에서 동작하는지 fixture로 확인한다.
- service health의 `appRoot`는 release root 아래 `app-root`, `installRoot`는 `/usr/local`, `logRoot`는
  release root 아래 `logs`와 byte-for-byte 일치해야 한다. 절대경로라는 사실만으로 통과시키지 않는다.
- `config/config.toml`은 root 소유의 exact content/hash다. 전용 계정 home의
  `.config/container/config.toml`은 부재해야 한다. writable parent 안의 0444 파일은 rename 교체가
  가능하므로 충분하지 않다.
- `plugin-state`에는 allowlist된 built-in 5개에서 파생된 service만 허용한다.
- kernel은 source archive digest가 아니라 추출된 exact file의 SHA-256을 release manifest에 고정하고
  root 소유 read-only 경로를 매 task `--kernel`에 전달한다. 자동 kernel 설치는 비활성화한다.
- vminit은 immutable linux/arm64 OCI manifest digest, config, layer set을 검증한다. mutable image store가
  이를 바꿀 수 있으면 readiness를 열지 않는다.
- worker environment는 exact `CONTAINER_APP_ROOT`, `CONTAINER_INSTALL_ROOT`와 고정 locale/PATH만
  만든다. 그 밖의 `CONTAINER_*`, proxy, credential, debug 변수는 상속하지 않는다.

`brokerTcbDigest`는 broker/worker Mach-O identity, launchd plist, 계정 manifest, exact roots,
config/plugin inventory, Apple payload, kernel, vminit과 환경 정책의 canonical record를 묶는다.
`executionPolicyDigest`는 이 값과 실제 kernel hash, exact create argv, OCI descriptor와 init process를
다시 묶는다. 예약 뒤 어느 값이 달라지면 기존 승인을 재사용하지 않고 새 task로 시작한다.

## 첫 harmless go/no-go fixture

### 2A. 무권한 same-UID protocol fixture — 구현·통과

`src-tauri/native/macos-runtime`은 외부 dependency가 없는 Swift package다. 다음 세 실행 표면을
분리한다.

- production-shaped broker 골격: macOS 26+, root EUID/GID, launchd parent, compile-time Team ID와
  자기 자신의 live Developer ID requirement를 모두 통과하기 전에는 Mach listener를 만들지 않는다.
  XPC 표면은 32-byte `NSData` probe와 같은 크기의 challenge만 받는 fixed dedicated-identity fixture,
  전용 계정 provisioning 세 개이며 executable/argv/path/environment/credential/provider 요청을 받지 않는다.
- broker fixture: exact sibling worker 하나에만 32-byte CSPRNG challenge를 전달하며 3초 timeout과
  4 KiB 입출력 상한을 둔다.
- worker fixture: exact flag와 canonical JSON 한 줄만 받고 UID/GID와 challenge를 되돌린다. 파일 쓰기,
  네트워크, 자식 process, Apple Container 호출이 없다.

`bun run test:macos-runtime-native`는 thin arm64, deployment target 13.0, exact ad-hoc identifier,
Hardened Runtime, plist lint, strict envelope, fail-closed broker와 실제 challenge 왕복을 검사했다. 성공
proof도 `mode:development-same-uid`, `serviceRegistered:false`, `accountCreated:false`,
`containerInvoked:false`, `authoritative:false`, `reusable:false`, `ready:false`로 고정된다. 이 시험 중
`SMAppService.register`, `launchctl`, 계정 생성과 Apple Container는 호출하지 않는다.

개발 broker에는 production entitlement를 서명하지 않는다. macOS는 신뢰 가능한 Team identity가 없는
ad-hoc 실행 파일이 이 entitlement를 주장하면 실행을 종료하기 때문이다. exact entitlement plist는
향후 Developer ID inside-out 서명의 입력일 뿐이다.

### 2B. 관리자 승인 dedicated-UID/launchd fixture — 코드 경계 구현, 설치본 실행 전

Apple Container를 호출하기 전에 다음만 검증한다.

1. production 서명 preflight가 ad-hoc, 다른 Team ID/identifier/entitlement, timestamp 또는 hardened
   runtime 부재를 모두 거절한다.
2. root broker가 전용 계정 manifest를 만들고 재부팅 뒤 같은 GeneratedUID/UID/GID를 확인한다.
3. `user/<uid>` domain의 harmless worker가 exact UID/GID와 `managername=Background`를 보고한다.
4. worker가 같은 domain에 harmless descendant service/Mach endpoint를 동적 bootstrap한다.
5. 로그인 UID가 worker/service를 register, bootout, kickstart, swap하거나 private IPC에 연결하지 못한다.
6. 앱 종료, XPC disconnect, broker/worker kill, reboot, 승인 취소에서 broker가 orphan을 reconcile한다.
7. 100회 반복에서 중복 worker, 남은 service, 권한 상승, rollback된 generation이 0건이다.

이 시험의 성공은 containment `ready`가 아니다. 별도 UID namespace가 stock Apple Container 통합을
진행할 수 있다는 한 가지 전제만 증명한다.

현재 구현된 부분은 다음과 같다.

- Tauri main에만 링크되는 Objective-C bridge가 `SMAppService` 상태·등록·해제와 mutual code-sign-pinned
  XPC를 소유한다. macOS 26, exact `/Applications` bundle, compile-time Team ID, client entitlement,
  embedded broker/plist를 OS 호출 전에 확인한다.
- checked-in Team ID는 `nil`이므로 ad-hoc/개발 빌드에서는 등록·해제·probe·fixture가 모두
  `production-identity-unavailable`로 선행 차단된다. 프런트엔드에 전달되는 진단은 실행 capability가 아니다.
- `_agentstoz`, UID/GID 400...499, `/var/empty`, `/usr/bin/false`, PID 1, non-admin groups,
  `managername=Background`를 모두 요구하는 one-shot worker와 고정 launchd plist가 구현됐다.
- root broker의 OpenDirectory provisioner는 이름과 UID/GID를 caller에게 받지 않고 400...499의 동시
  미사용 ID 하나만 선택한다. 기존 user/group/manifest가 하나라도 부분적이거나 policy와 다르면 덮어쓰기·
  채택·삭제 없이 거절한다. 새 group/user만 생성하고 중간 실패 시 이번 호출에서 만든 record handle만
  역순 삭제하며, 성공 뒤 root-owned 0444 manifest의 GeneratedUID/UID/GID와 실제 directory record를
  재검증한다. 결과 역시 `executionAuthorized:false`, `ready:false`인 challenge proof일 뿐이다.
- root broker coordinator는 client의 32-byte challenge를 root-owned fixed file로 전달하고,
  `/bin/launchctl`의 exact `user/<uid>` bootstrap/bootout만 수행한 뒤 stdout JSON의 exact keys,
  challenge, UID/GID, Background 상태와 false safety fields를 다시 검증한다. 15초 client timeout과
  5초 worker proof deadline을 넘기면 통과시키지 않는다.
- macOS 개발 빌드는 native manifest의 SHA-256을 다시 확인한 broker/worker와 두 plist만
  `Contents/Library/LaunchServices`·`LaunchDaemons`에 원자적으로 배치한 뒤 ad-hoc app을 다시 봉인한다.
  same-UID fixture와 entitlement 파일은 bundle에 넣지 않으며 stage 결과도
  `productionIdentityEmbedded:false`, `entitlementsApplied:false`, `ready:false`다.

2026-09-05에는 버전 파일과 설치본을 건드리지 않는 임시 `CARGO_TARGET_DIR`에서 실제 Tauri app bundle을
만들어 이 stage를 적용했다. deployment target 10.13으로 Objective-C bridge를 release compile하고,
두 plist lint, 네 고정 bundle file, deep strict codesign을 확인했다. 결과는 의도대로
`Signature=adhoc`, `TeamIdentifier=not set`이므로 production preflight를 통과하지 않는다. 이 검증에서
macOS 15에 도입된 `SMAppServiceErrorDomain` 참조의 availability 누락을 발견해 15+ guard를 추가했다.

이 Mac의 2026-09-05 실제 검사에서는 valid code-signing identity가 0개여서 identity 단계가
`developer-id-application-missing`, canary가 `production-identity-unavailable`로 종료됐다. 임의 Team ID를
주입하거나 ad-hoc 서명으로 대체하지 않았고 두 결과 모두 not-ready다.

아직 구현·실증되지 않은 부분은 signed native callback을 실제 scratch Cargo/Tauri app build 생명주기로
감싸는 최종 orchestration, generated TypeScript diagnostic source 연결, 앱까지 포함한 전체 inside-out
Developer ID 서명의 실제 인증서 실행,
서명된 설치본에서의 실제 `_agentstoz` 생성과 재부팅 후 manifest 검증, 실제 관리자 승인, 로그인 UID 공격,
crash/reboot/승인 취소 및 100회 반복이다. 따라서 readiness는 계속 닫혀 있다.

## 구현 순서

1. identity discovery, private-key signing canary, static installed-signature snapshot과 dev/production
   channel 분리 — 구현됨, 항상 non-authoritative/not-ready
2. production-shaped broker + bounded same-UID worker protocol fixture — 구현됨, 앱/서비스와 분리
3. Tauri-main SMAppService/XPC client와 harmless dedicated-UID worker/coordinator — 코드 구현,
   운영 서명·bundle·관리자 승인 실행 증거 전
4. OpenDirectory 전용 계정과 root-owned manifest provisioner — 코드 구현, 설치본 실제 생성·재부팅 검증 전
5. desktop UID 공격, crash/reboot, 승인/폐기 E2E
6. config/plugin/kernel/vminit과 전체 broker TCB proof
7. stock Apple Container 1.3.1의 dedicated user-domain integration
8. exact-root health proof와 detached-descendant escape canary
9. drain-first update/uninstall lifecycle

업데이트는 새 task 차단 → drain/absence proof → dedicated domain bootout → 앱 번들 전체 원자 교체 →
서명/manifest 재검증 → 재bootstrap 순서다. Mach-O를 in-place로 바꾸지 않는다. 제거 시 AgentsToZ
broker/account/state만 제거하며 공유 `/usr/local` Apple Container payload를 자동 삭제·업데이트하지
않는다.

## 근거

- [Apple: Designing Secure Helpers and Daemons](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/DesigningSecureHelpers/DesigningSecureHelpers.html)
- [Apple: SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
- [Apple: NSXPCListener code-signing requirement](https://developer.apple.com/documentation/foundation/nsxpclistener/setconnectioncodesigningrequirement%28_%3A%29)
- [Apple: TN3127 — Inside Code Signing Requirements](https://developer.apple.com/documentation/Technotes/tn3127-inside-code-signing-requirements)
- [Apple: Packaging Mac software](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [Apple Container 1.3.1 `SystemStart`](https://github.com/apple/container/blob/a9a62e28f6beb88940122a3d7b286f2d5ae8053a/Sources/ContainerCommands/System/SystemStart.swift#L75-L130)
- [Apple Container 1.3.1 `ServiceManager`](https://github.com/apple/container/blob/a9a62e28f6beb88940122a3d7b286f2d5ae8053a/Sources/ContainerPlugin/ServiceManager.swift#L36-L40)
- [Apple Container 1.3.1 `PluginLoader`](https://github.com/apple/container/blob/a9a62e28f6beb88940122a3d7b286f2d5ae8053a/Sources/ContainerPlugin/PluginLoader.swift#L91-L163)
- [Apple Container 1.3.1 `ConfigurationLoader`](https://github.com/apple/container/blob/a9a62e28f6beb88940122a3d7b286f2d5ae8053a/Sources/ContainerPersistence/ConfigurationLoader.swift#L183-L223)
