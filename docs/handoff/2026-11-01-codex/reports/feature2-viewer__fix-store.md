# feature2-viewer · fix:store

(agent final report, verbatim)

English translation: "This is about connecting once and then using it comfortably from then on, right?"

모델/에포트: 지금 설정을 유지하면 충분합니다. 권고만 하고 설정은 바꾸지 않았습니다.

**wp-controller-store 검토 결과: 5건을 고쳤고, 1건(4번)은 다른 묶음 소관이라 넘깁니다.**

**브랜치와 커밋**
- 요청대로 `feat/viewer-controller-store`에 커밋하지 못했습니다. 이 브랜치가 다른 작업 공간(`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-3`)에 체크아웃돼 있어 git이 체크아웃을 거절했고, 그 작업 공간은 건드리지 않았습니다.
- 대신 `feat/viewer-controller-store-fix`를 451936ac에서 만들어 커밋했습니다: **b1f42621**. 451936ac 바로 다음 커밋이므로, -3 작업 공간이 비면 `feat/viewer-controller-store`를 이 커밋으로 그대로 당기면(fast-forward) 됩니다.

**고친 파일**
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-7/native/screen-control/Sources/ScreenHost/ScreenControllers.swift`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-7/native/screen-control/Tests/ScreenHostTests/ControllerStoreTests.swift`
- `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-7/native/screen-control/Sources/ScreenControlCore/ShortFingerprint.swift`: 새 파일이고 이 묶음의 파일 목록 밖입니다. Viewer는 ScreenControlCore만 링크하므로(SR-32) Core에 둘 수밖에 없었습니다. 새 파일이라 다른 묶음과 충돌하지 않습니다.

**검토 지적별 처리**
1. **고침.** 출시 관문 판정을 `bindsGenuineViewer`(`.directSAS && attested`)로 따로 두었습니다. 컨트롤러와 등록 방식 양쪽에 있습니다.
   - format 1에서 옮긴 행과 폰 중개 행은 `enrollment.attested == true`이지만, 이 판정은 false입니다. 그래서 9절 관문을 받습니다.
   - `RegisteredController.attested`는 없앴습니다. 관문 코드가 잘못된 값을 읽으면 합칠 때 컴파일이 실패하게 하려는 것입니다.
   - `enrollment.attested`는 7.3 저장 필드로 그대로 둡니다.
2. **고침.** 등록할 때 거절하는 대신 보여 줄 때 거르는 방식을 택했습니다. 6.3이 거절이 아니라 「이름 없는 Mac」 표시를 요구하기 때문입니다.
   - `displayName`은 `isShowableName`을 통과하는 첫 값을 씁니다. 별칭, 등록 이름, `"이름 없는 Mac"` 순서입니다. 반환 타입은 `String` 그대로라서 푸시의 actorName 검사(`isDisplaySafeName`)도 항상 통과합니다.
   - 모델은 `showableModel: String?`으로 거릅니다.
   - 원래 이름은 `replacementCandidates` 비교용으로 남기고, 행을 버리지 않습니다.
3. **고침.** `directSAS(attestation: AppAttestation?)`로 바꿔, 검증기를 거치지 않으면 attested가 될 수 없게 했습니다. `phoneBroker(...)`와 `init(record:brokerAttestationKeyID:)`는 internal로 바꿨습니다(D-1 뒤로 쓰는 곳이 없음).
4. **넘김.** `scripts/check-screen-control.ts`의 XCTest 필터는 설계 15절에 따라 wp-core-v5가 넓힙니다. 같은 줄을 여기서 고치면 합칠 때 충돌합니다.
   - 그때까지 `bun run test:screen-control`은 ControllerStoreTests 12개를 돌리지 않습니다.
   - wp-integration에서 필터에 들어갔는지 반드시 확인해야 합니다.
5. **고침.** 258행 문구를 "reading a corrupt item does not write"로 낮췄습니다.
   - 93행 "reading never writes"는 그대로 둡니다. format 1을 읽을 때 옮겨 쓰지 않는다는 실제 성질을 시험하기 때문입니다.
   - 「손상된 항목을 덮어쓰지 않음」은 서비스의 성질이라 wp-screen-host가 시험해야 합니다.
6. **고침.** 지문 4자리 규칙을 `ScreenControlIdentity.shortFingerprint(of:)`와 `shortFingerprint(_:)`로 Core에 두었습니다. 행의 `keyFingerprint`와 정적 `keyFingerprint(of:)`는 이것을 그대로 씁니다. 키 0x11에서 "2bad"가 나오는 것을 시험으로 고정했습니다.

**실행한 검증 (모두 이번 실행 결과)**
- `swift test --package-path native/screen-control --filter "ControllerStoreTests|ScreenControllerTests"`: 19개 실행, 실패 0. ControllerStoreTests 12개(새 시험 `testANameThisMacCannotShowReadsAsAnUnnamedMac` 포함)와 ScreenControllerTests 7개입니다.
- `bun run test:screen-control`: 종료 코드 0, pass 102 / fail 0, XCTest 13.
- `swift build --package-path native/screen-control --build-tests`: 종료 코드 0. 바꾼 파일에서 경고는 없었습니다.
- iOS 시뮬레이터 SDK(iPhoneSimulator26.5, `arm64-apple-ios17.0-simulator`)로 `Sources/ScreenControlCore/*.swift`를 `swiftc -typecheck`: 종료 코드 0, 오류 0.
- 폰 골든 벡터, 프로토콜, 핸드셰이크 바이트는 바뀌지 않았습니다(Core에는 순수 함수 하나만 더함). 키체인, TCC, 실화면, 52741, 3001은 건드리지 않았습니다.
- 돌리지 않은 것:
  - `bun run typecheck`와 `cargo test`: TS와 Rust를 바꾸지 않았습니다.
  - `bun run verify`: 돌리지 않았습니다.
  - 필터 없는 전체 `swift test`: 실화면 시험이 들어 있어 돌리지 않았습니다.
  - 테스터 맞추기(ensure): 3001 접속이 금지라 하지 않았습니다.

**451936ac를 기준으로 만든 다른 묶음에 영향을 주는 API 변경 (합칠 때 컴파일 오류로 드러납니다)**
- `RegisteredController.attested` 삭제 → 출시 관문은 `controller.bindsGenuineViewer`를 읽습니다(wp-screen-host). Screen 목록의 「정품 확인됨」 표시도 이 값을 씁니다(wp-screen-ui).
- `directSAS(attestationKeyID:)`가 `directSAS(attestation:)`로 바뀌었습니다. wp-pairing은 clientDataHash 결속을 확인한 뒤 검증기 결과를 넘깁니다.
- 화면과 푸시에는 `displayName`과 `showableModel`을 씁니다.
- Viewer(wp-viewer-app)는 `ScreenControlIdentity.shortFingerprint`를 씁니다.

**사람(D-1 소유자)에게 확인할 설계 문제**
- 설계 7.3(format 1은 attested=true)과 9절(attested=true면 관문 없음)이 서로 충돌합니다. 코드는 2절과 11절에 맞춰 폰 중개 행도 관문을 받게 했습니다.
- 지문 4자리는 16비트라서 약 6.5만 번이면 같은 값의 키를 만들 수 있습니다. 그래서 11절의 「양쪽 지문 대조」는 일부러 노리는 공격자를 막지 못합니다. 설계를 다시 판단해야 합니다.
