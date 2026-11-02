# feature2-viewer · fix:viewer

(agent final report, verbatim)

English translation: "So the idea is that once it's connected, I can just keep using it comfortably, right?"

**결과: 리뷰 결함 10건을 모두 고쳐 `feat/viewer-app`에 커밋했습니다(`e9385988`, 기반 `bfa50bfc`). 거절한 항목은 없고, 검사는 138/138 통과입니다.**

이제 A를 만지지 않고 보기만 해도 B의 한도(보기 60분)까지 연결이 이어집니다. 이전에는 A의 디스플레이가 꺼지는 시간에 끊겼습니다.

**고친 내용**
1. **화면 꺼짐으로 끊김:** B 화면이 보이는 동안 A의 디스플레이가 유휴로 꺼지지 않게 했습니다. 디스플레이가 꺼지지 않으니 그 뒤에 오는 자동 잠금도 일어나지 않습니다. 창을 가리거나 최소화하면 이 유지를 풉니다. A의 잠금, 시스템 잠자기, 일부러 끈 디스플레이, 사용자 전환은 여전히 즉시 끝냅니다.
2. **SR-29 키 판정:** keyDown은 키보드 초점을 가진 그 컨트롤만 작동시킵니다(`window.firstResponder === control`). 이 판정을 코어의 `ViewerControlActuation`으로 옮겨 검사로 확인합니다.
3. **연결 중 경비·삭제:** 연결하는 동안 A가 잠기거나 잠들거나 사용자가 바뀌면, 또는 그 Mac을 「이 Mac에서 삭제」하면 연결을 취소합니다. 늦게 돌아온 연결은 창을 열지 않고 B 세션을 바로 닫습니다.
4. **Secure Event Input:** 입력칸이 활성 앱의 key 창에서 초점을 가진 동안만 켭니다. 세션이 끝나면 칸을 닫으며 끄고, `deinit`에서도 끕니다.
5. **잠긴 B 입력칸:** 잠금 화면이 보내는 `.secureInput`으로는 칸을 닫지 않습니다. 다른 이유(권한 없음, 입력 감시 중단, B 앞 사용, 보기 전용)나 입력 상태 미수신이면 닫습니다. B가 `.blocked`로 답하면 「잠긴 B에는 입력할 수 없음」을 띄웁니다.
6. **눌린 채 남는 입력:** 영상 밖에서 뗀 버튼은 영상 가장자리에서 떼어 보냅니다. 창이 초점을 잃거나, 사람이 일시 정지하거나, 입력 관문이 닫히면 B에 눌려 있는 키와 버튼을 모두 뗍니다(떼기만 보냅니다). 마우스를 올려 두는 동작도 B로 갑니다.
7. **띠 문구:** 권한 없음, 입력 감시 중단, B 앞 사용 문구를 더했습니다. 5분 경고는 5초마다 다시 판정해, 입력으로 마감이 늦춰지면 내려갑니다.
8. **잠금 입력 줄:** 라벨, 칸, 「보내기」를 함께 보이거나 함께 숨깁니다. 「가짜일 수 있으니」 경고는 B가 잠기지 않았다고 알렸고 키가 B로 가는 동안만 보입니다.
9. **시험 범위:** `ViewerSession`의 판단을 코어의 `ViewerSessionModel`로 옮겨 직접 시험합니다. loopback 검사도 이 모델을 그대로 씁니다. 검사 이름에 「takeover (played for B)」, 즉 B 쪽 이어받기는 흉내라고 밝혔습니다.
10. **저장 실패:** 주소 저장이 실패하면 제안을 남기고 띠에 알립니다. 연결 직후나 권한 수신 때 목록 갱신이 실패하면 상태 줄이나 띠에 알립니다. 소스 계약 검사가 목록 쓰기의 `try?`를 막습니다.

**검증 결과**
- `bun run test:screen-control`: 138/138 checks 통과(새 검사 2개), SR-36 검사와 상태 파일 검사 통과, `swift test` 13건 실패 없음.
- `swift build --product AgentsToZViewer`와 `swift build`: 경고 없이 빌드됩니다.
- 공용 코어를 iOS 시뮬레이터 대상으로 타입 검사했고 통과했습니다(`xcrun --sdk iphonesimulator swiftc -swift-version 6 -typecheck -target arm64-apple-ios17.0-simulator …`).
- 새 규칙 7개를 하나씩 일부러 깨뜨린 사본을 만들었고, 매번 검사 하나가 실패했습니다(137/138).
- TS·Rust는 바꾸지 않아 typecheck와 cargo test는 돌리지 않았습니다.
- 폰 골든 벡터, iOS 소스, `vectors.json`은 바뀌지 않았습니다. 실제 화면, TCC, 키체인, 52741, 3001에는 닿지 않았습니다.

**남은 것과 결정이 필요한 것**
- **브랜치 상태:** `feat/viewer-app`은 다른 worktree(`wf_5de5c4d1-61e-15`)에 체크아웃된 상태여서 `git checkout --ignore-other-worktrees`로 가져왔습니다. 그 worktree는 이제 이전 내용과 달라 보입니다.
- **1번은 설계 결정입니다:** 세션 동안 A가 잠기지 않는 것으로 정했습니다. 대신 자리를 비운 A는 B의 한도(보기는 시작 후 60분, 조작은 무입력 60분)까지 잠기지 않고 깨어 있습니다. 이 결정을 DESIGN 5.1 「세션 경비」에 적어야 합니다. 제 작업 범위 밖이라 문서는 고치지 않았습니다.
- **실기 미확인:** 화면 보호기가 실제로 억제되는지, AX 누르기가 사람의 키와 같은 순간에 들어오는지, 창 밖 mouseUp이 어떻게 전달되는지는 실기로 확인하지 않았습니다. 조작은 S-M3 전까지 빌드에서 막혀 있습니다.
- **5번은 B 쪽 계약이 남았습니다:** B는 지금도 Secure Event Input 중에는 텍스트 입력을 막습니다(`InputInjector.swift:173`). 그래서 지금 빌드에서는 A가 보내도 「입력할 수 없음」이 뜹니다. 잠긴 B가 무엇을 알리고 받을지는 wp-screen-host와 S0-2에서 정해야 합니다.
- **9번의 남은 범위:** AppKit 연결 코드(`ViewerSession`, `TargetList`, `SessionWindow`)는 여전히 소스 계약 검사로만 지켜집니다. B의 실제 중재기(이어받기)는 이 검사에서 시험하지 않습니다.

**바꾼 파일** (모두 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_5de5c4d1-61e-21/native/screen-control/` 아래)
- `Sources/ScreenControlCore/ScreenTargetRoute.swift`
- `Sources/AgentsToZViewer/HumanAction.swift`
- `Sources/AgentsToZViewer/InputForwarder.swift`
- `Sources/AgentsToZViewer/SecureEntryView.swift`
- `Sources/AgentsToZViewer/SessionWindow.swift`
- `Sources/AgentsToZViewer/TargetList.swift`
- `Sources/AgentsToZViewer/ViewerApp.swift`
- `Sources/AgentsToZViewer/ViewerSession.swift`
- `Tests/ScreenControlCoreTests/ViewerRouteChecks.swift`

푸시하지 않았고 main은 건드리지 않았습니다.
