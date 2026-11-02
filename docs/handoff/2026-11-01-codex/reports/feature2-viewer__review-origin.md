# feature2-viewer · review:origin

(agent final report, verbatim)

English translation: "Once it's connected, the idea is that you can just keep using it comfortably, right?"

**판정: 막는 결함은 없습니다. 낮은 등급 4건이 있습니다.** 아래는 심각한 순서입니다.

1. **pid 0이라는 전제 중 기록되지 않은 위험이 있습니다**
   - 위치: `/Users/cs-work/forcs/AgentsToZ_byCS/native/screen-control/Tests/InputOriginContract/vectors.json:36-40, 62-63, 75`, `/Users/cs-work/forcs/AgentsToZ_byCS/native/screen-control/Tests/ScreenControlCoreTests/InputOriginChecks.swift:91, 212`
   - 이유: `measured:false`와 `residualRisk` 표식은 가상 HID에만 붙어 있습니다. S-M3는 다음 두 출처도 재기로 되어 있는데, 이 둘의 전제는 확정된 벡터로 들어가 있습니다.
     - 다른 프로세스가 만든 합성 이벤트: 프로그램이 `eventSourceUnixProcessID`를 0으로 직접 써서 보내면 0으로 읽히는지 아무도 재지 않았습니다.
     - Jump·Apple 원격: 원격 데스크톱 입력은 자기 pid를 단다고 가정했습니다.
   - 영향: 벡터의 원격 데스크톱 입력은 모두 pid가 0이 아닙니다. 그래서 검사 「remote desktop is named, never accepted」는 원격 데스크톱 입력이 자기 pid를 달 때만 참입니다. 지금 S-M3 기록은 가상 HID 행만 바꾸면 끝나므로, 이 두 전제는 아무도 확인하지 않은 채 넘어갈 수 있습니다.
   - 당장 출시 위험은 없습니다. 조작은 빌드에서 꺼져 있고, B의 권한 올리기와 A의 연결은 생체 인증도 거칩니다.
   - 고칠 것:
     - 기대값이 accept이고 `measured:false`·`residualRisk`가 붙은 벡터 두 개를 더합니다. 하나는 「합성 이벤트인데 pid 필드가 0」, 다른 하나는 「원격 데스크톱 입력이 pid 0으로 도착」입니다.
     - `fields` 설명에 sourcePid 전제도 S-M3 대상이라고 적습니다.
     - 검사 이름을 「pid가 있는 원격 데스크톱은 거절」로 좁힙니다.

2. **SPIKES.md는 저장소에 없고, 검사도 읽지 않습니다**
   - 위치: `/Users/cs-work/forcs/AgentsToZ_byCS/native/screen-control/Sources/ScreenControlCore/ScreenInputOrigin.swift:82-83`. 빌더 보고도 같은 말을 되풀이합니다.
   - 이유: 주석은 「current·SPIKES.md·벡터 calibration을 함께 바꾸고, 어긋나면 InputOriginChecks가 실패한다」고 적습니다. 실제로는 다음과 같습니다.
     - SPIKES.md는 저장소에도, DESIGN.md에도 없습니다.
     - 검사가 맞춰 보는 것은 `current`와 vectors의 `calibration`뿐입니다.
   - 고칠 것: 기록 위치를 실제 위치(DESIGN 13절 또는 wp-spikes 산출물)로 바꿉니다. 「어긋나면 실패」라는 말은 current와 벡터 사이에만 적용된다고 고칩니다.

3. **조작 빌드 플래그를 다른 모듈이 우회할 수 있습니다**
   - 위치: `/Users/cs-work/forcs/AgentsToZ_byCS/native/screen-control/Sources/ScreenControlCore/ScreenInputOrigin.swift:77, 88`
   - 이유: `ScreenInputCalibration`의 `init`이 public이고 `allowsControl`은 인스턴스 속성입니다. 그래서 이 코어를 링크하는 ScreenHost·Viewer·iOS 앱 어디서든 `.passed` 값을 만들어 `allowsControl == true`를 얻을 수 있습니다. TS 검사는 `current = uncalibrated`라는 글자만 고정하므로 이 우회를 잡지 못합니다.
   - 고칠 것: `init`을 internal로 바꿉니다. 검사는 `@testable`이나 CORE_CHECKS 단일 모듈로 돌므로 그대로 동작합니다. 또는 `static var controlBuild: Bool { current.allowsControl }` 하나만 공개합니다.

4. **사용자 질문에 대한 답에 조건이 빠졌습니다** (코드가 아니라 빌더 보고의 답 부분)
   - 이유: 답은 「켜 두기를 켜면 재시작·업데이트 뒤 저장 네트워크에서 다시 켜진다」를 조건 없이 말합니다. 설계와 비교하면 다음이 빠졌습니다.
     - 켜 두기는 pushLive일 때만 켤 수 있습니다. pushLive에는 푸시 배포(H10, TestFlight 사람 단계 포함)와 Apple 보고 발송 기록이 필요하고, 그 전에는 선택지가 숨겨집니다(9절, SR-27).
     - 90일 동안 쓰지 않은 등록은 만료됩니다(6.6). 「등록은 한 번만」과 어긋납니다.
     - 조작은 지금 빌드에서 꺼져 있습니다. S-M3 보정과 pushLive를 모두 통과해야 열립니다.
     - A가 잠기거나 잠들거나 사용자를 바꾸면 세션이 즉시 끝납니다(12절).
   - 고칠 것: 위 네 조건을 답에 덧붙입니다.

**확인한 범위**
- **diff 범위**: 새 파일 4개와 `all` 줄 한 칸뿐입니다. 폰 골든 벡터와 프로토콜은 바뀌지 않았습니다.
- **격리**: 새 소스는 Foundation만 쓰는 순수 로직입니다. AI나 MCP의 진입점이 없고, 실제 화면·TCC·키체인·52741을 건드리지 않습니다.
- **설계와의 대조**: forward와 humanClick/humanKey의 판정 순서(놓인 곳 → 시각 → 출처), 원격 데스크톱 거절, 조작 관문(`allowsControl == (status == .passed)`), 12절 문구가 설계와 맞습니다.
- **임시 worktree 실행 결과** (`.claude/worktrees/rv-viewer-origin`, fa83eb8f)
  - `bun scripts/check-screen-control.ts`: 108/108 통과, 호스트 XCTest 13건 0 실패
  - `swift test --filter .../testSecurityRequirements`: 0 실패
  - `bun test screen-input-origin-sync.test.ts`: 6 pass
  - 주변 테스트(screen-·computer-use-control 등): 155 pass, 0 fail
  - `bun run typecheck`: 종료 코드 0
- **변이 시험**: 결함 두 개를 일부러 넣어 검사가 잡는지 봤고, 둘 다 실패로 잡혔습니다. 하나는 humanClick에서 inControl 확인을 뺀 것이고, 다른 하나는 ControlBarRules의 freshSeconds를 1.5로 바꾼 것입니다.
- 끝난 뒤 worktree는 지웠고, main 트리는 깨끗합니다.
