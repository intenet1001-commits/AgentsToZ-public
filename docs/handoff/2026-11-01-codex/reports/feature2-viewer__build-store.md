# feature2-viewer · build:store

(agent final report, verbatim)

English translation: "This is about connecting once and then using it comfortably from then on, right?"

이번 설계에서는 등록은 A→B 한 쌍마다 한 번이면 되고, 그 뒤로는 계속 씁니다(H4). 다만 연결은 매번 따로입니다. 연결할 때마다 B를 고르고 생체 인증을 한 번 받습니다(H7). 자동 재연결은 없습니다. 보기 세션은 60분, 조작 세션은 60분 동안 입력이 없거나 8시간이 지나면 끝납니다. 90일 동안 안 쓰면 등록이 만료됩니다. 이번 묶음은 그 「한 번 등록」이 B에 남는 저장 부분입니다.

모델/에포트: 저장 형식과 검증 중심의 작업이라 지금 설정으로 충분합니다(권고만 하고 바꾸지 않았습니다).

## 결과 (wp-controller-store)

- **브랜치**: `feat/viewer-controller-store` (main f3e96658에서 만들었고, 의존 브랜치가 없어 병합한 것은 없습니다)
- **커밋**: `451936ac` feat(screen): controllers item format 2 with enrollment, format 1 migration and SR-22 check (푸시하지 않음)
- **파일**
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-3/native/screen-control/Sources/ScreenHost/ScreenControllers.swift
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-3/native/screen-control/Tests/ScreenHostTests/ControllerStoreTests.swift (새 파일, 11개 시험)
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-3/native/screen-control/Tests/ScreenHostTests/ScreenControllerTests.swift — 묶음 밖이지만 고칠 수밖에 없었습니다. 이 파일이 「format은 1」과 「format 2는 손상」을 단언하고 있었기 때문입니다. 바꾼 곳은 세 줄입니다: 도우미에 `try` 추가, 1→2, 2→3. 한도·스위치·canControl 시험은 그대로입니다.

## 구현한 것

**format 2 저장 형식**
- 행은 설계 7.3 그대로입니다: `{id, publicKey, name, alias?, model, grant, enrollment:{method "direct-sas"|"phone-broker", attested, attestationKeyID?, brokerAttestationKeyID?}, registeredAt, lastConnectedAt?}`
- 방식별 규칙:
  - `direct-sas`: attested가 참인 것과 attestationKeyID가 있는 것이 정확히 같아야 하고, broker 키는 없어야 합니다.
  - `phone-broker`: broker 키가 반드시 있고, attested=true여야 하며, attestationKeyID는 없어야 합니다.
  - App Attest 키 ID는 정확히 32바이트여야 합니다.
- 규칙을 어긴 행은 그 행만 버리고 개수를 셉니다.

**format 1 → 2 이전**
- format 1 행은 읽을 때 `phone-broker`, attested=true로 옮깁니다.
- 읽기만으로는 저장하지 않고, 다음 저장 때 format 2로 씁니다.
- 1·2가 아닌 format이나 모양은 `ScreenStoreError.corrupt`로 닫힌 쪽으로 실패합니다. 시험한 값: 0, 3, -1, 99, "2", "1", 2.5, true, null, format 없음 등.

**이중 등록 판정 (SR-22)**
- `[RegisteredDevice].holds(fp)`: 저장된 ID와 키 지문 양쪽으로 맞춰 보고, 만료된 폰도 셉니다.
- `ScreenControllers.holds(fp)`: 스위치가 꺼져 있어도 셉니다.
- `doublyRegistered(with:)`: 두 집합에 함께 있는 키 목록입니다.
- `enrolling(_:replacing:phones:)`:
  - 폰 키는 `.registeredAsPhone`으로 거절합니다.
  - 승인 한 번으로 스위치를 켜고 행을 더합니다.
  - 같은 키의 행은 새 행으로 바꿉니다.
  - `replacing`은 후보 행만 받고, 그 밖은 `.notAReplacementCandidate`입니다.

**그 밖의 도우미**
- `replacementCandidates(name:model:excluding:)`: 「기존 항목 바꾸기」 후보입니다. 등록 이름으로 맞추고(NFC·공백·대소문자 무시) 모델은 정확히 같아야 합니다. 별칭은 보지 않습니다.
- `keyFingerprint` / `keyFingerprint(of:)`: 지문 hex 앞 4자리입니다.
- `controller(for:)`, `attested`, `alias`, `displayName`, `alias(from:)`(폰과 같은 규칙)
- 표시할 수 없는 저장된 별칭은 nil로 읽고 행은 남깁니다.

## 실행한 검증 (모두 이번 실행 결과)

- `swift test --package-path native/screen-control --filter "ControllerStoreTests|ScreenControllerTests"` → 18개 실행, 0 실패 (ControllerStoreTests 11, ScreenControllerTests 7). 커밋한 상태에서 다시 돌린 결과입니다.
- `bun run test:screen-control` → 102/102 통과, 상태 파일 계약 일치, XCTest 필터 13개 0 실패
- 변이 검사(스크래치 스크립트, 커밋 안 함): 10개 변이를 모두 잡았습니다.
- `bun run typecheck`와 `cargo test`는 돌리지 않았습니다. TS·Rust 변경이 없습니다.
- 실화면·입력·TCC·키체인은 건드리지 않았습니다. 시험은 메모리 저장만 씁니다.
- format 1 고정 데이터는 옛 인코더가 실제로 쓴 바이트를 캡처한 것입니다. 캡처에 쓴 임시 시험 파일은 지웠습니다.

## 남은 것과 다른 묶음에 넘길 것

- **게이트에서 빠져 있음**: `scripts/check-screen-control.ts`의 XCTest 필터에 `ControllerStoreTests`가 아직 없어서, 지금은 `bun run test:screen-control`이 새 시험 11개를 돌리지 않습니다. 필터 확장은 wp-core-v5가 맡기로 되어 있어 손대지 않았습니다(같은 줄을 고치면 충돌합니다). 합칠 때 확인이 필요합니다.
- **호출 방식 변경**: 옛 `RegisteredController.init(record:grant:brokerAttestationKeyID:at:)`가 이제 `throws`입니다. 지금 쓰는 곳은 시험뿐입니다.
- **지문 4자리 규칙**: `keyFingerprint`는 ScreenHost에 있어서 Viewer가 링크할 수 없습니다. wp-pairing과 wp-viewer-app은 같은 규칙(SHA-256(x963 공개 키)의 소문자 hex 앞 4자리)을 써야 하고, 필요하면 Core로 옮겨야 합니다.
- **wp-screen-host가 해야 할 연결**: 서비스 코드는 이번 묶음 범위가 아니라 아무것도 연결하지 않았습니다. 세 가지가 남았습니다.
  - 폰 등록 경로에서 `controllers.holds(record.deviceID)`로 컨트롤러 키를 거절하기
  - 두 조회에서 `doublyRegistered(with:)` 키를 빼기
  - 출시 관문에서 `attested` 읽기
- **문서**: 10-29 설계의 「format 1」 기술 갱신은 wp-docs-tester 몫이라 문서는 고치지 않았습니다.
