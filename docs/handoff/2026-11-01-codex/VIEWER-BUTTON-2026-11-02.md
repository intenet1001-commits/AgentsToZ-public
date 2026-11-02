# Mac 간 제어 버튼·포장 점검 — 2026-11-02

## 결론과 수정

현재 설치본을 같은 소스로 다시 빌드하는 것만으로는 Mac 간 Viewer 버튼이 생기지 않는다.
`main`에는 `src/useViewerHelper.ts`가 없고, 구현 브랜치의 진입점은 **근무 모드 → 다른 Mac 화면 보기**다.
새 본체에는 이 구현과 `--developer-id --with-viewer`로 만든 독립 Viewer payload가 모두 필요하다.
Viewer가 설치·동봉·실행 중 어느 상태도 아니면 해당 부분은 숨겨진다.

추가로 실제 포장 결함을 찾았다. 기존 stager는 `Contents/Helpers/AgentsToZViewer.app`에 넣었지만,
Rust의 `bundled_payload()`와 상태 조회는 `Contents/Helpers/AgentsToZ Viewer.app`을 찾았다.
이 불일치로 payload가 있어도 `bundled:false`가 되어 버튼이 숨겨질 수 있었다.

- `53f52e37`: Rust의 실제 Viewer `app_name`과 stager 경로를 교차 검사하는 회귀를 추가했다. **1 fail**로 결함을 재현했다.
- `121873a9`: 최종 payload 이름을 Rust와 일치시켰다. 독립 QA 빌더의 임시 출력명 `AgentsToZViewer.app`은 유지한다.
- 기기별 Viewer 프로필 입력을 `.gitignore`에 추가했다. 내려받은 프로필을 소스에 커밋하지 않고 기본 빌드 경로에서 사용할 수 있다.

실제 전용 프로필·기존 Developer ID 인증서로 stager를 실행해 올바른 이름의 Viewer QA payload를 만들었고,
복사된 payload의 `codesign --verify --deep --strict`가 exit 0이었다.
이 검사는 **실행 파일 없는 임시 본체 디렉터리** 안에서 수행했다. 전체 본체 빌드·공증·설치 성공을 뜻하지 않는다.
설치 앱을 교체·재시작하거나 사람 Viewer 세션을 시작하지 않았다.

## 설치된 두 Mac의 상태

| 대상 | 확인 결과 | 근거·한계 |
|---|---|---|
| 현재 Mac | 본체·Screen `1675.0.0`, 표준 설치 위치에서 AgentsToZ Viewer 없음 | 실행 중인 앱 경로와 Info.plist 읽기 |
| 1호 | 본체·Screen·설치 Control `1646.0.0`, 표준 설치 위치·Spotlight·실행 목록에 Viewer 없음 | 기존 OPS 진단 요청 `d20c4b5a-7006-46d9-8d3f-9768148aa5ab`의 completed 결과. Control 실행 경로는 상대 경로여서 설치본과 동일한지 미확인 |
| 1호 Screen 표시 | 새로 표시한 Jump 탭에서 「화면 제어 켜짐 · 근거리 직접 연결」, 현재 연결 0대 | 이전 09:48의 꺼짐 화면은 갱신 전 이미지였다. 10:10 이후 새 화면으로 정정. Mac 간 실제 입력 시험은 하지 않음 |

Jump의 네이티브 메뉴와 기존 탭 전환은 작동했다. 탭을 다시 선택해 원격 화면 갱신도 확인했다.
좌표 클릭은 `noWindowsAvailable`로 실패했고, 키 전달의 실제 반영도 확인하지 못했다.
이를 Jump 또는 AgentsToZ의 원격 조작 성공으로 판정하지 않는다. 연결을 끊거나 원격 앱을 재시작하지 않았다.

## 최신 브랜치 검증

깨끗한 소스 **`121873a9a6ac99517922baf841065622a40c9677`**에서 검증했다. 실행 중 추적 파일을 고치지 않았다.
이후에는 문서만 갱신하며, 제품 소스가 검증 소스와 같은지 확인한다.

| 검사 | 결과 |
|---|---|
| Viewer 포장·근무 모드·Developer ID 집중 검사 | **30 pass / 0 fail** |
| 실제 Viewer QA payload 생성·strict 서명 검사 | exit 0, 실행·설치 없음 |
| `tests/work-mode-ui.mjs` | Chromium·WebKit 둘 다 통과. 격리된 fixture의 버튼 표시·열기·실패·재시도 검사이며 실제 Viewer 세션이 아님 |
| 공통 runner quick의 `essential-contracts` | 1 통과, `20261102T011022Z-2419633f`, source unchanged true |
| 원격 사용자·저시력 사용자 persona | 10 통과 / 0 실패, `20261102T011211Z-2f561b91`, source unchanged true |
| `bun run verify` | **exit 1**. Python 138 통과·타입 검사 통과·Bun **10,312 pass / 12 skip / 1 fail** |
| 실패 파일 분리 실행 | `tests/ai-terminal-cursor-position.test.ts`: **17 pass / 0 fail** |
| 별도 `bun run test:rust` | exit 0, **165 pass / 0 fail / 1 ignored** |

전체 실패는 `a stall of the host right after the body still leaves the measured gap before Enter`다.
CLI에서 측정된 본문→Enter 간격이 기대 `>=100ms`에 못 미친 **94ms**였다.
해당 제품 함수와 검사는 이번에 변경하지 않았고, 제품 함수는 현재 main과도 같다.
분리 실행은 통과했으나 원인을 확정하지 못했다. 단언·대기 시간을 바꾸거나 재전송을 추가하지 않았다.
**별도 Rust·분리 검사 성공을 합쳐 전체 verify 성공으로 표시하지 않는다.** 정식 출시 전 해결 또는 재검증이 필요하다.

테스터 ensure는 이 세션에서 이미 한 번 호출했고 임시 사본은 미등록으로 skipped였다.
전체 quick·전체 persona·실제 두 Mac UI 검사를 통과했다고 확대하지 않는다.

## S-K2 지원 여부의 정정

[Apple의 `isSupported` 문서](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported)는
Mac에서 App Attest 지원 값이 false이며 Mac Catalyst·Apple silicon의 iOS/iPadOS 앱도 포함한다고 명시한다.
설치 Xcode SDK의 `DeviceCheck.framework/Headers/DCAppAttestService.h:55`에도 같은 설명이 있다.
Context7의 `/websites/developer_apple_devicecheck`에서 동일한 공식 문서 근거를 확인했다.

따라서 S-K2는 **문서상 미지원, 런타임 실측 없음, PASS 아님**으로 기록한다.
프로필을 다시 발급하거나 사람의 추가 로그인을 기다리며 해결할 항목으로 두지 않는다.
설계의 미결속 직접 등록과 H10 푸시 관문·사람의 생체/SAS 보호는 유지하며, 보안 기준을 낮추지 않았다.

## 남은 일과 증거

Viewer 진입 소스를 정식 출시 소스에 반영하고 올바른 payload를 포함한 본체·Screen·Viewer를 양쪽 Mac에 준비해야 한다.
현재 브랜치는 main 미병합·미출시이며, 전체 verify 실패를 남긴 채 설치·배포하지 않았다.
S-M3 물리 입력 비교·H10 실제 알림 수신/원격 차단·S-N2 및 두 Mac 등록/보기/입력/보류 실기는 여전히 남아 있다.
Mac 컨트롤러 조작 기본 꺼짐과 SR-23을 유지한다. AI 커뮤니티 신뢰·영속 사람 보류 통합도 미완료다.

원본 저장소의 gitignored `tests/results/remote-continuation-20261102/button-fix/`에 전체/분리/Rust 로그,
공통 runner 보고서·UI fixture 이미지·서명 포장 영수증·최소 수정 patch·지원 문서 근거를 보존했다.
1호 진단의 실제 completed 영수증은 인접 `live-mac1-preflight/completed-receipt.json`에 있다.
`next-step/signing/`의 프로필 원본과 QA 앱은 계속 보존한다.
