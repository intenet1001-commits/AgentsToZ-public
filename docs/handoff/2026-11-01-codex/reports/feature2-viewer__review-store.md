# feature2-viewer · review:store

(agent final report, verbatim)

English translation: "This is about connecting once and then using it comfortably from then on, right?"

모델/에포트: 읽기 전용 검토라 지금 설정으로 충분합니다. 권고만 하고 설정은 바꾸지 않았습니다.

**wp-controller-store (`feat/viewer-controller-store` 451936ac) 검토 결과: 결함이 있습니다. 심각한 순서로 6건입니다.**

이번에 직접 확인한 것:
- 임시 worktree에서 `swift test --filter "ControllerStoreTests|ScreenControllerTests"`를 돌렸고 18개 모두 통과했습니다. 바뀐 파일에서 컴파일러 경고는 없었습니다.
- `bun scripts/check-screen-control.ts`도 통과했습니다(102 pass, 0 fail, XCTest 13개).
- format 1 고정 데이터를 main d093fa88의 인코더로 다시 만들어 비교했습니다. JSON 내용이 같았고, main의 디코더로 읽은 값도 같았습니다. 그러니 「옛 인코더 캡처」라는 설명은 사실입니다.
- 폰 골든 벡터와 ScreenControlCore에는 변경이 없습니다.
- 시험은 메모리 저장소와 소프트웨어 키만 씁니다. 키체인, TCC, 실화면, 52741은 건드리지 않습니다.
- main에는 `controllers` 항목을 쓰는 코드가 없습니다. 그래서 실제로 남아 있는 format 1 데이터는 없습니다.
- 임시 worktree는 지웠고, 주 체크아웃은 깨끗합니다.

1. **[중간, 지금은 잠복] `native/screen-control/Sources/ScreenHost/ScreenControllers.swift:49-50, 177`: `attested`가 폰 중개 등록과 정품 Viewer 결속 등록을 같은 값으로 취급합니다.**
   - 설계 안에서 두 규칙이 충돌합니다.
     - 7.3은 「format 1 → phone-broker, attested=true(폰 App Attest)」로 옮기라고 합니다.
     - 9절은 「정품 결속 등록(attested=true)」이면 보기 세션에 관문이 없다고 합니다.
     - 그런데 2절과 11절은 폰 App Attest가 pk_A가 정품 Viewer의 생체 키임을 증명하지 못한다고 합니다. 결속되지 않은 직접 등록과 같은 위험이라는 것입니다. SR-23도 「연결마다 생체 인증」을 정품 결속 등록에서만 보장합니다.
   - 구현은 7.3을 글자 그대로 따랐습니다. 주석도 「not attested면 push 관문 전 세션 없음」이라고 적었습니다. 빌더는 wp-screen-host에 「출시 관문에서 `attested` 읽기」를 넘겼습니다.
   - 그대로 연결하면 phone-broker 행이 pushLive 관문 없이 보기 세션을 엽니다. 이런 행은 format 1 이전으로도 생기고, 아직 public인 `RegisteredController(record:brokerAttestationKeyID:)`로도 새로 만들 수 있습니다.
   - 고칠 방법: 관문 전용 판정을 따로 둡니다. 예: `bindsGenuineViewer = enrollment.method == .directSAS && enrollment.attested`. `attested` 주석에서 9절 관문 문구를 빼고, 넘기는 내용도 이 판정을 읽도록 바꿉니다. 설계의 7.3과 9절 충돌은 사람(D-1 소유자)에게 알려야 합니다.

2. **[낮음~중간] `ScreenControllers.swift:113, 154, 167`: 이름과 모델을 검사하지 않고, `displayName`이 원래 이름을 그대로 돌려줍니다.**
   - 예전에는 행이 검증된 `RegistrationRecord`로만 만들어졌습니다. 그 기록은 `isDisplaySafeName`으로 이름과 모델을 걸렀습니다(NFC, 64B 이하).
   - 새 public init `RegisteredController(publicKey:name:model:...)`와 format 2 디코딩은 아무 문자열이나 받습니다. 별칭은 읽을 때 `isShowableName`으로 거르지만(140행), 이름은 거르지 않습니다.
   - 그래서 「이 Mac이 보이는 이름」인 `displayName`이 LAN의 P1이 보낸 name_A를 그대로 보일 수 있습니다. 예를 들어 RTL 오버라이드가 든 이름입니다. 6.3의 「통과 못하면 ‘이름 없는 Mac’」 규칙과 어긋납니다.
   - 고칠 방법:
     - `displayName`이 `alias ?? (isShowableName(name) ? name : nil)` 꼴로 거르게 하고, nil이면 UI가 「이름 없는 Mac」을 보이게 합니다. 아니면 init에서 이름과 모델을 폰과 같은 규칙으로 검증합니다.
     - 모델도 같은 규칙으로 거릅니다.
     - 시험을 더합니다.

3. **[낮음, 강화] `ScreenControllers.swift:73`: `directSAS(attestationKeyID: Data?)`는 32바이트이기만 하면 어떤 Data든 attested=true로 만듭니다.**
   - `AppAttestation`은 Core의 검증기만 만들 수 있습니다(memberwise init이 internal). 그러니 `AppAttestation?`을 받게 하면 「검증 없이 attested」를 타입으로 막을 수 있습니다. 폰 경로(`ScreenService.swift:697`)도 `attestation.keyID`를 쓰고 있습니다.

4. **[낮음, 게이트] `scripts/check-screen-control.ts:65`: 필터에 `ControllerStoreTests`가 없습니다.**
   - 지금 `feat/viewer-core-v5`에는 main 이후 커밋이 0개입니다. 그래서 필터 확장은 아직 어디에도 없습니다.
   - `bun run verify`는 Swift 시험을 돌리지 않습니다. 결국 새 시험 11개를 지키는 관문이 지금은 없습니다.
   - 고칠 방법: wp-core-v5의 필터 확장을 먼저 합치거나, wp-integration에서 반드시 확인합니다.

5. **[낮음, 시험 정직성] `native/screen-control/Tests/ScreenHostTests/ControllerStoreTests.swift:258`(93행도 비슷): 단언이 항상 참입니다.**
   - 「a corrupt item is never written over」는 읽기 API인 `store.controllers()`만 부른 뒤에 단언합니다. 이 API는 원래 쓰지 않으므로 항상 참입니다. 「손상을 덮어쓰지 않음」은 서비스(wp-screen-host)의 성질입니다.
   - 고칠 방법: 문구를 「reading does not write」로 낮추고, 서비스 묶음에서 실제 저장 경로를 시험합니다.

6. **[낮음, 통합과 설계 메모] `ScreenControllers.swift:181-184`: `keyFingerprint`가 ScreenHost에 있습니다.**
   - SR-32에 따라 Viewer는 ScreenControlCore만 링크합니다. 그래서 A가 이 규칙을 따로 다시 구현해야 하고, 두 구현이 어긋날 위험이 있습니다. 빌더도 같은 점을 적었습니다.
   - 고칠 방법: Core로 옮깁니다. 예: `ScreenControlIdentity.shortFingerprint`.
   - 설계 메모: 4 hex는 16비트입니다. 키를 약 6.5만 번만 만들면 같은 지문을 맞출 수 있습니다. 11절이 S-K2 실패 때의 완화책으로 「양쪽 지문 대조」를 들고 있으니, 설계 쪽에서 이 한계를 다시 판단해야 합니다.

**설계와 일치하는 것**: format 2의 모양, 방식별 필드 규칙, 32바이트 키 ID, 1과 2 외 format의 닫힌 실패, 손상된 행만 버리기, 읽기만으로는 저장하지 않음, SR-22 도우미(만료된 폰과 스위치 꺼짐도 셈), 「기존 항목 바꾸기」 후보 판정, 승인 한 번으로 스위치 켜기와 행 더하기를 함께 함.

**범위**: AI 진입점, 입력 출처 검사, push 관문 연결, 켜 두기와 잠금 해제 조건은 이 묶음 밖이고 손대지 않았습니다.
