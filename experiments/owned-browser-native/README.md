# AgentsToZ 자체 Chromium: macOS 기술 검증

최종 제품 목표는 Ego Lite와 Aside 양쪽의 핵심 사용자 여정을 AgentsToZ만으로 더 편하게 끝내는 것입니다. 이 실험은 그 목표의 첫 엔진 검증이며 출시 기능이 아닙니다. 기존 설치 앱의 워크룸과 실제 CLI는 연결하지 않았습니다.

실제 Tauri/WKWebView UI와 CEF Chromium 두 화면을 하나의 macOS 창에서 실행합니다. 시스템 Chrome, Ego, Aside의 실행 파일·프로필을 사용하지 않습니다. CEF는 공식 배포를 받는 `tauri-apps/cef-rs` 156.0.0+156.0.7을 고정했습니다. 가상 문서만 제공하는 임시 loopback 서버 외의 URL을 거부합니다. 두 공간은 같은 origin을 사용하지만 독립된 메모리 RequestContext를 갖습니다. 실제 로그인, 계정 복제, 영구 프로필 저장은 구현하지 않았습니다.

## 빌드·재현

macOS, Rust/Cargo, Xcode SDK, CMake, Ninja가 필요합니다. 처음에는 공식 CEF 바이너리와 Cargo 의존성을 내려받습니다. 시스템 설정이나 `/Applications`를 바꾸지 않습니다.

```sh
cd experiments/owned-browser-native
python3 verify.py --build --repeat 3
python3 verify.py --contracts-only
open bundle/agentstoz-browser-spike.app
```

CEF 캐시를 공유하려면 `CEF_PATH`를 빌드·패키지 명령 양쪽에 같은 값으로 지정합니다. 기본 위치 외의 `CARGO_TARGET_DIR`는 이 실험의 패키지 도구에서 지원하지 않습니다. Cargo.lock을 유지하며 `--locked`로 빌드합니다. 자동 검증은 실제 `.app` 실행과 정상 종료를 요구합니다. 번들이 없거나 macOS가 아니면 미검증으로 실패하며 웹 모형으로 대체하지 않습니다. 실행 로그와 소스 지문은 무시되는 `evidence/`에 남습니다.

프로젝트 공통 실행기에는 `project.owned-browser-native` 시나리오와 두 검사 정의를 추가했습니다. 기존 16개 프로필은 보존했습니다. 앱을 먼저 빌드한 뒤 프로젝트 루트에서 실행합니다.

```sh
python3 scripts/agentstoz-maintainer.py run --root . --scenario project.owned-browser-native
```

## 구현한 경계

- 에이전트 작업 공간에만 고정된 문서 입력 명령을 전달합니다. 사람 전용 공간에는 그 명령을 연결하지 않습니다.
- 제어권 회수는 revision을 올리고 브라우저의 전환 확인을 받은 다음 사람 입력을 엽니다. 반환은 다시 읽은 문서와 새 revision이 있어야 에이전트 입력을 허용합니다.
- 에이전트 제어 중 작업 공간으로 들어가는 일반 마우스·키보드 초점을 차단합니다. 사람 전용 공간과 앱 UI는 독립적으로 입력받습니다.
- 화면을 숨길 때 브라우저와 문서를 파괴하지 않습니다. 앱 종료 뒤에는 임시 프로필과 서버를 정리합니다. 프로세스 충돌 후 문서 복원은 아직 없습니다.
- Chromium 페이지에는 Tauri IPC를 주입하지 않습니다. 외부 탐색·팝업·고정 fixture 외 하위 요청을 거부하며 원격 디버깅 포트를 열지 않습니다.

## 이번 실험을 제품 보안 경계로 재사용하지 않을 부분

가상 문서의 관찰·전환 확인은 `document.title`과 페이지의 `window.__atzEpoch`를 이용합니다. 임의 웹사이트는 이를 바꿀 수 있으므로 이 방식으로 일반 인터넷 페이지의 권한을 판단해서는 안 됩니다. 실제 제품 연결 전, renderer의 비공개 상태와 CEF 프로세스 메시지로 확인·명령을 옮겨야 합니다. 사이트가 전달한 내용은 문서 데이터로만 취급해야 합니다.

`use-mock-keychain`, 고정 16ms 메시지 펌프, 자동화용 `human-fixture-type`도 실험 전용입니다. 실제 로그인 전 Keychain 경계와 저장 정책을 정하고, 제품에서는 CEF의 외부 펌프 예약 API와 종료 수명을 구현해야 합니다. sandbox 초기화를 요청하고 별도 helper를 실행하지만, 공증된 배포본의 sandbox·서명·클린 Mac 검증을 완료했다는 뜻은 아닙니다. 이 실험은 macOS arm64에서 확인하며 Windows 검증을 대신하지 않습니다.

## 확인하며 수정한 결함

1. `RunEvent::Exit` 안에서 CEF를 종료하면 Tao의 외부 autorelease pool에 남은 Chromium 객체가 뒤늦게 해제되면서 SIGTRAP이 발생했습니다. `run_return`으로 이벤트 루프와 pool이 정리된 뒤 CEF를 종료하도록 바꿨습니다. 검사 10개가 참이어도 프로세스 종료가 실패하면 검증기는 실패합니다.
2. CEF를 WKWebView의 자식으로 넣으면 실제 페이지가 접근성 트리에 나타나지 않았습니다. NSView 컨테이너에서 WKWebView와 CEF를 형제로 배치하고 Chromium 접근성을 활성화해 두 문서의 입력 요소를 확인했습니다.
3. 회수·반환 직후의 오래된 UI 상태가 계속 표시됐습니다. 전환 확인을 기다린 뒤 완료 상태를 표시하도록 바꿨습니다.

페르소나 설계와 다음 제품 연결 순서는 [실행 기록](../../docs/design/browser-workroom-persona-2026-10-24/NATIVE-EXECUTION.md)에 정리했습니다. 실제 비교 사용자 테스트 없이 Ego Lite/Aside보다 우수하다고 판정하지 않습니다.

## 근거

- [Tauri 엔진 차이](https://v2.tauri.app/reference/webview-versions/)
- [cef-rs와 공식 helper/bundle 구성](https://github.com/tauri-apps/cef-rs)
- [CEF 프로세스·RequestContext·macOS 수명](https://chromiumembedded.github.io/cef/general_usage)
