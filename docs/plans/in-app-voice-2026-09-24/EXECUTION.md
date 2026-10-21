# 앱 내 음성 구현 기록

2026-09-24 · 작업 브랜치 `codex/in-app-voice` · 시작 소스 `14c93df`.

동시에 다른 변경이 진행 중인 기본 작업 폴더를 보존하기 위해 별도 워크트리 `../AgentsToZ_voice_20260924`에서 구현했다. 최초 구현 검증 뒤 사용자가 Mac 앱 빌드·테스트를 요청하여 로컬 빌드 검증을 추가했다. 병합·push·앱 설치·포털 배포와 로컬 테스트 패키지 생성을 구분한다.

## 구현 범위

- Mac 프로젝트 화면 상단·OPS 프로필 패널의 OPS 음성 버튼과 각 실행 중인 워크룸의 음성 버튼.
- 공통 패널: 제공자 설정, 명시적 음성/문맥 전송 동의, 말해서 입력/실시간 대화, 마이크·스피커 상태, 전사/답변 자막, 수정 가능한 지시 초안, 입력 준비 확인 후 전송, 취소·종료.
- 호스트 OpenAI Realtime unified SDP 연결과 서버 sideband. 기본 모델 `gpt-realtime-2.1`, 음성 `marin`, 전사 `gpt-4o-mini-transcribe`/한국어. 호스트 설정에서 Realtime 모델을 변경할 수 있다. 일반 ChatGPT/Codex 구독과 별도 API 설정이다.
- OPS 도구: 운영 기억 회상, 허용된 등록 프로젝트·워크트리/워크룸 목록, 워크룸 시작 및 초기 출력 확인, 출력 조회, 지정 워크룸 지시 초안, 로컬 OPS 기억 후보 제출. 공유 기억의 승인 도구는 제공하지 않는다. 로컬 전용 OPS는 기존 저장 결과를 그대로 구별한다.
- 워크룸 도구: 정확한 프로젝트·세션 출력 조회, 지시 초안. 폴더 identity와 세션 입력 revision을 검증하고, 검토 뒤 키보드 입력이 바뀌면 보내지 않는다. 여러 줄/탭은 공백으로 이어 한 번의 Enter로 보낸다.
- iPhone: 기존 HTTPS 모바일 shell의 워크룸 음성 버튼, OPS 영역의 운영 프로젝트 선택 + 음성 버튼. 호스트가 실제 OPS binding을 확인하며 이름으로 판정하지 않는다. 원격 OPS는 선택한 운영 프로젝트 grant 범위만 사용한다.
- 별도 `voice.use` 기기/프로젝트 권한, `voice-v1` 호스트 기능 협상. 기존 터미널·기록 권한만으로 음성을 허용하지 않는다. 원격에서 API 키 설정은 거부한다.
- SDP만 4,000자 조각으로 기존 암호화 workspace 요청에 전달한다. 전체 SDP 24,000바이트, 조각 8개 이하. 기존 relay 평문/envelope 상한을 늘리지 않았다. 오디오는 WebRTC로 제공자와 직접 교환한다.
- Mac/iOS 마이크 사용 설명, HTTPS 메인 프레임의 WKWebView 마이크 permission prompt, 포털 루트/portal.html/remote 경로의 self microphone policy. 나머지 기본 웹 정책 및 LAN HTTP 미디어 차단은 유지한다.
- Mac GUI에만 `com.apple.security.device.audio-input`을 추가했다. 기본 Developer ID 서명 계획은 GUI audio-input·API sidecar JIT·나머지 helper 무권한을 각각 검증한다. 강화 런타임 broker의 권한에는 오디오를 추가하지 않는다.

## 사용 방법

1. 구현 소스로 실행한 Mac에서 **OPS 음성 → 음성 제공자 설정**에 OpenAI API 키를 입력하고 저장한다. 키는 Keychain에 저장되며 브라우저 저장소·설정 JSON·프로세스 argv·원격 응답에 포함하지 않는다. 개발용 별도 환경 변수는 `AGENTSTOZ_VOICE_API_KEY`다. API 호스트는 시작할 때 이 값을 전용 메모리 객체로 분리하고 자식 프로세스 환경에서 제거한다. 워크룸 실행기에서도 같은 변수를 거부한다.
2. 음성/필요 문맥 전송 동의를 체크하고 시작한다. 워크룸의 기본 모드는 **말해서 입력**, OPS는 **실시간 대화**다.
3. 워크룸 지시는 초안과 대상/빈 입력창을 확인한 후 **이 워크룸에 보내기**를 누른다. 기존 AI의 로그인·신뢰·승인 화면은 사용자가 직접 처리한다.
4. iPhone은 업데이트한 Mac과 HTTPS 개인 포털에 연결한다. Mac 워크룸의 기기 권한에서 해당 프로젝트의 **음성 입력·실시간 대화**를 허용한다. OPS 음성은 실제 등록된 운영 프로젝트를 선택한다.

## 수명·실패 처리

한 웹 화면에서 미디어 소유자 하나, 호스트에서 같은 owner/target에 활성 세션 하나. 준비 요청과 전송 요청은 동일 ID·동일 내용에 대해 영수증을 재사용한다. HTTP 응답이 유실되어도 새 ID로 자동 재전송하지 않는다. 재시작 뒤 이전 세션 ID는 거부한다.

세션 최대 15분, 전사 모드의 마이크 캡처 최대 2분, 무발화 60초 후 마이크 종료. 일반 heartbeat 20초 유실 시 종료하며 최대 30초 제공자 연결 중에는 45초 grace를 적용한다. 화면 숨김/pagehide/구성 변경/컴포넌트 해제/장치·네트워크 단절 시 tracks·peer·채널·재생·타이머를 정리한다. 늦은 권한/연결 응답은 즉시 해제한다. 음성 종료는 CLI 작업을 종료하지 않는다.

원음 파일과 음성 대화 자체는 영구 저장하지 않는다. 세션 초안은 메모리에만 있고 종료하면 폐기한다. 워크룸으로 보낸 지시는 기존 CLI 기록/What I Said 수집 정책의 적용 대상이며, 이번 변경은 별도의 음성 발언 저장/동기화 경로를 추가하지 않는다.

## 검증과 한계

- Python maintainer quick: `20260924T014721Z-11c8504b` 통과(maintainer-self, essential-contracts).
- 1차 `bun run verify`: Bun 4,399개/595파일, Rust 60개 통과. 이후 추가한 서명·음성 회귀는 별도로 재검증했다. 최종 전체 결과는 아래에 기록한다.
- 음성/Keychain/provider/실제 PTY/서명/네이티브 권한 집중 테스트 60개 통과. 전용 환경 키가 실제 CLI에 상속되지 않는 회귀를 포함한 워크룸 테스트 25개도 통과. 원격 음성 grant 회귀도 통과. PTY 준비 출력 대신 고정 100ms를 기다리던 테스트가 부하에서 실패해 `READY`를 확인한 후 입력하도록 고쳤다.
- 브라우저 fixture: 전송 전 확인 필수, 응답 유실 후 동일 requestId 두 번에 실제 전송 1회, 마이크 track 종료, 권한 거부 시 prepare→stop, 모바일 390px 화면 확인. 가상 마이크/제공자이며 실제 음성 왕복 증거는 아니다.
- 독립 macOS WKWebView probe: `tauri://localhost`에서 `isSecureContext=true`, `getUserMedia`와 `RTCPeerConnection` 제공 확인. 실제 마이크 호출·서명 앱 TCC 승인·음성 왕복 검증과 구분한다.
- iOS Simulator SDK `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 통과. iPhone 실기기 검증이나 설치를 뜻하지 않는다.
- desktop Vite build 및 portal Vite build 통과. 기존 대형 chunk/동적 import 경고는 남는다.

**남은 실사용 인수:** 실제 사용자 API 키로 서명된 Mac 앱과 iPhone에서 한국어 왕복, 이어폰/스피커 피드백, 오디오 중단·재생 허용, 응답 지연 확인. API 키가 제공되지 않아 유료 live API 호출은 실행하지 않았다.

**제공하지 않는 기능:** 일반 PTY 출력만으로 네 AI의 입력 준비·턴 완료를 자동 판정하지 않는다. 실시간 대화 중에도 실행 지시는 화면 확인 후 보내며, 출력 조회는 관찰 결과일 뿐 작업 완료 보장이 아니다. iPhone LAN HTTP에는 웹 마이크가 없고 네이티브 LAN 미디어 어댑터는 미구현이므로 HTTPS 연결을 안내한다.

## 참조한 제공자 계약

- [OpenAI Realtime WebRTC 연결](https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime)
- [서버 sideband 제어](https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime)
- [Realtime 이벤트와 대화](https://developers.openai.com/api/docs/guides/realtime-conversations)

GPT-Live 및 Conversations API 계약을 Realtime 세션과 섞지 않았다.

## 최종 검증 결과

- 전체 `bun run verify` 정상 종료: Python 34개, Bun **4,411개 / 597파일 / 0 fail**, Rust **60개 / 0 fail**. 로그: `/tmp/agentstoz-voice-verify-complete.log`.
- 중간 전체 실행에서 기존 네이티브 layout 테스트의 entitlement 개수 가정이 실패했다. GUI의 두 정확한 권한과 broker의 기존 한 권한을 검사하도록 갱신한 뒤 위 전체 실행이 통과했다. broker 오디오 권한·GUI false 값·추가 권한을 거부하는 검증을 유지했다.
- 최종 전체 실행 이후 느린 원격 제공자 연결이 완료될 때 heartbeat 기준을 새로 시작하도록 보완했다. 30초 연결 지연을 재현한 회귀를 포함하여 음성 host **10개**와 TypeScript 검사가 추가로 통과했다. 로그: `/tmp/agentstoz-voice-heartbeat-final.log`.
- 초안 편집을 시작하면 마이크를 끄고, 뒤늦은 전사가 와도 수정한 문장을 보존한다. 이 UI 보완 후 TypeScript 검사와 desktop/portal production 웹 빌드를 다시 통과했다.
- `git diff --check` 통과. 실제 Keychain/UI 입력 없이 fixture 키로 보관 계약을 검사했으며, 사용자의 API 키나 실제 음성을 테스트에 사용하지 않았다.

## Mac 패키지 후속 검증

- 현재 요청의 Python quick 실행 `20260924T024400Z-7ef63e83`: 두 검사 통과.
- 실제 macOS Keychain에 임의의 전용 테스트 서비스로 임시 키를 저장·읽기·삭제했다. production `VoiceCredentials`를 사용하고 서비스 이름만 격리했으며, stdin 전달과 메타데이터의 비밀 미포함을 확인했다. 사용자 API 키·기존 Keychain 항목을 사용하지 않았다.
- macOS 빌드의 마지막 ad-hoc 재서명에 `--preserve-metadata=entitlements`를 추가했다. GUI 마이크 권한과 각 helper의 기존 권한을 보존하며, GUI 권한을 helper 전체에 적용하지 않는다.
- `--allow-unpublished-source` 빌드는 clean 로컬 커밋을 요구하며 공식 설치·배포에 쓰지 않는다. 기본 작업 폴더·실행 중인 설치 앱의 세션은 그대로 둔다.
- 네이티브 UI 검사는 별도 bundle ID·데이터 폴더·loopback 포트의 fixture에서 production `VoiceButton`, Tauri 요청 프록시, 실제 번들 sidecar를 연결한다. 글로벌 설정 자동 맞춤은 끄며, UI 진입점만 두 음성 버튼과 명시적 로컬 마이크 검사로 제한한다. 이 fixture는 전체 설치 앱의 인수 결과와 구분한다.

### v495 빌드 결과

- 새 전체 `bun run verify` 종료 코드 0: Python **34**, Bun **4,412 / 597파일 / 0 fail**, Rust **60 / 0 fail**. 로그 `/tmp/agentstoz-voice-mac-verify.log`.
- 구현 커밋 `1031a44`에서 `bun build-macos.ts --allow-unpublished-source` 종료 코드 0. 래퍼가 빌드 번호를 v495로 올리고 버전 커밋 `69f907e`를 생성했다. 원격 push·병합 없음.
- 보존한 앱: `/Users/gwanli/cargo-targets/agentstoz-voice-v495/AgentsToZ_byCS.app`. `codesign --verify --deep --strict` 통과, GUI에만 정확한 microphone entitlement 존재, `NSMicrophoneUsageDescription` 존재 확인. 같은 폴더의 `build-verification.json`과 `signature-check.json`에 결과를 남겼다.
- DMG: `/Users/gwanli/cargo-targets/portmanager/release/bundle/dmg/AgentsToZ_byCS_495.0.0_aarch64.dmg`. `hdiutil verify` 체크섬 통과. 이는 설치·공증·음성 실사용 인수 증거가 아니다.
- 별도 네이티브 창에서 OPS 음성/워크룸 음성 패널 열기·닫기, OPS 실시간 대화 기본값, 워크룸 말해서 입력 기본값, 키 미설정 시작 차단, 잘못된 모델 거부 및 올바른 모델 저장을 확인했다. 실제 Tauri capability 프록시와 번들 sidecar를 사용했으며, 데이터 폴더 `com.agentstoz.voice-native-smoke-20260924`에만 설정이 생겼다.
- 실제 마이크 검사에서 macOS TCC 권한 요청이 발생했다. 컴퓨터 제어 도구가 `UserNotificationCenter` 조작을 안전상 거부하여 사용자에게 직접 허용을 요청했다. 후속 진행 요청에서 네이티브 창의 성공 결과를 확인했다: 실제 오디오 트랙 **1개**, WebRTC 오디오 SDP 생성, 종료 후 트랙 상태 **ended**, 외부 음성 전송 **0**. 이는 격리된 Tauri/WKWebView의 실제 로컬 캡처 검사이며 제공자 연결·음성 인식 정확도·AI 응답 재생의 검증은 아니다.
- 후속 네이티브 설정 확인에서도 API 키는 미설정이며 시작 버튼이 비활성화되어 있었다. 외부 OpenAI 음성 왕복은 미실행이다.
- 설치된 `/Applications/AgentsToZ_byCS.app`와 해당 sidecar 프로세스는 교체·종료하지 않았다. 로컬 테스트 빌드는 설치/배포본이 아니다.
- 네이티브 fixture 생성 코드·검사 UI·격리 범위는 로컬 `artifacts/voice-v495-native-check/`에 보관했다.

## v498 변경과 통합 · 설치 준비

- 교체 요청 후 설치본이 이미 **v498**이고 Gemini Live 키 저장·실제 연결 확인이 추가되어 있음을 확인했다. v495 테스트 앱으로 덮어쓰지 않고 원격 `origin/main`의 `677b3e4`와 통합했다. Gemini의 저장 키/모델 설정 경로는 그대로 사용하며, 음성 송수신 버튼은 **OpenAI Realtime**이다. Gemini의 성공한 setupComplete는 Gemini 음성 송수신 구현 완료를 뜻하지 않는다.
- 최신 OpenAI 공식 WebRTC 지침의 Realtime unified SDP/server key 패턴을 다시 확인했다. GPT-Live 세션 계약과 섞지 않았다. OpenAI 키 저장 표시를 ‘키 저장됨’으로 바꾸어 연결 성공과 구별했다.
- Python quick `20260924T031333Z-58710fb3` 통과. 타입 검사와 음성·Gemini·실제 PTY·capability 집중 검사 **85개 / 0 fail** 통과.
- Gemini 설정 UI는 Chromium/WebKit **22개** 검사 통과. 워크룸 기존 UI fixture가 새 Gemini status 조회를 모의 처리하지 않아 실패하는 것을 재현했고, 정확한 POST/status 조회만 격리 응답하도록 보완했다. 외부 요청 차단 및 나머지 미등록 API 실패 검사는 유지했다. 이후 워크룸 UI **6개 suite** 전부 통과(키보드 14, 터치 1, 사용성 37개 그룹 포함).
- 통합본 `verify` 실행 `20260924T031800Z-0c4251ff` 통과. 검사 중 소스 불변 확인, TypeScript 성공, Bun **4,429개 / 599파일 / 0 fail**, Rust **61개 / 0 fail**. 테스트 fixture 수정이 들어간 앞선 실행은 중단했고 성공으로 계산하지 않았다.
- desktop/portal production 웹 빌드 모두 통과. 기존 chunk 크기 경고는 남는다. 실제 키를 사용한 OpenAI 음성 왕복과 iPhone 실기기는 아직 미검증이다.
- 설치 전 기준: v498, 등록 프로젝트 **134개**, Gemini 암호화 설정 파일 존재. 교체 작업은 기존 앱 백업과 서명 검증을 사용하는 설치 절차로 진행한다.

## v499 설치 완료

- 검증된 음성 변경만 새 release 작업 브랜치 `codex/in-app-voice-v499`에 옮겼다. 별도 장기기억 설계 문서 변경은 원래 작업 브랜치에 보존하고 이번 반영에서 제외했다. 기능 `d366de1`과 버전 `8c8e7c9`를 비공개 `origin/main`에 fast-forward 반영했다. 공개 snapshot/포털 배포는 하지 않았다.
- `bun build-macos.ts`가 clean source `d366de1`과 실제 원격 기본 HEAD 일치를 확인했고 unpublished override 없이 **v499** 앱·DMG 빌드를 마쳤다. 기존 설치본과 같은 ad-hoc 로컬 앱 서명이며 Developer ID 공증 완료 주장은 하지 않는다.
- 패키지와 설치 앱 모두 `codesign --verify --deep --strict` 통과. GUI 마이크 사용 설명과 audio-input entitlement 존재, 서명된 보조 프로세스 6개에는 audio-input 없음. 설치 앱 executable/sidecar SHA-256이 이번 빌드와 일치한다.
- 2026-09-24 **12:27 KST**, 기존 앱의 `/api/install-app` staging/backup 절차로 `/Applications/AgentsToZ_byCS.app`을 v498에서 **v499**로 교체·재시작했다. 이전 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790220464903-39766.app`에 보존했다.
- 새 GUI PID 39160, 새 번들 sidecar PID 39201, health 성공을 확인했다. 프로젝트 **134개**의 ID·폴더·워크트리 identity hash와 Gemini 암호화 설정 파일 hash가 설치 전과 같다. 기존 API 키를 열거나 출력하지 않았다.
- 실제 설치 앱 화면에서 **v499**, **OPS 음성** 버튼, 기본 `gpt-realtime-2.1`의 OpenAI 키 입력 패널을 확인하고 열어 두었다. API 키 저장/사용자 마이크 허용 및 실제 제공자 한국어 음성 왕복은 사용자가 이어서 확인할 단계다. 이 설치는 iPhone 앱 설치·포털 배포·Gemini 음성 streaming 구현을 포함하지 않는다.
- 로컬 설치/패키지 영수증은 `artifacts/voice-v499-install/`, 빌드 로그는 `/tmp/agentstoz-voice-v499-build.log`에 보관했다.

## OpenAI 키 저장 안내 수정

- 사용자 화면에서 키가 입력되어 있지만 Keychain 항목과 설정 metadata가 없는 상태를 확인했다. 키 값을 읽지 않고 설치 앱의 기존 ‘설정 저장’ 버튼을 눌렀으며, 실제 Keychain 항목/설정 저장과 ‘마이크 켜고 시작’ 활성화를 확인했다. 저장 성공은 OpenAI API 인증·음성 왕복 성공과 구분한다.
- v499 코드에서 Enter 입력 후 configure 요청이 발생하지 않는 실패를 isolated UI test로 재현했다. 밝은 테마에서 undefined surface-highlight fallback 때문에 검은 배경·검은 글자가 되는 버튼도 확인했다.
- form/Enter 저장, trim 처리, 저장 중·저장 완료/실패 표시, 저장 후 capability readback, 실패 시 입력 보존을 추가했다. 저장 전 새 키/모델 초안이 남아 있으면 이전 설정으로 마이크를 시작하지 않는다. 서버에서 온 문자열 오류도 표시한다. 버튼은 실제 raised/ink 테마 토큰을 쓰며 상위 헤더의 nowrap을 패널에서 해제한다.
- `tests/voice-settings.e2e.mjs`: Chromium/WebKit **28개** UI 검사 통과(Enter 한 번 저장, trim, 동의 및 저장 gate, 저장 실패/거짓 영수증/불일치 readback, light/dark 대비, 390px overflow). `VOICE_UI_BASELINE=1`은 실행 시 Git HEAD의 구현을 읽는다. 수정 커밋 전 v499 HEAD에서 실행해 Enter 저장 실패를 재현했다.
- Python quick `20260924T033410Z-9faa52e4` 통과. 최종 verify `20260924T033910Z-750f6ff7` 통과, 검사 중 소스 불변: TypeScript 성공, Bun **4,429 / 599파일 / 0 fail**, Rust **61 / 0 fail**. Desktop production 웹 빌드 통과.
- 실제 v499 앱에서 저장한 키로 음성 시작을 시도했지만 마이크 획득 단계에서 준비 시간 초과를 확인했다. 사용자에게 macOS 마이크 허용 창 확인을 요청했으며, 실제 OpenAI 연결·한국어 왕복·OPS/워크룸 음성 UAT는 미완료다. 마이크 테스트가 통과했다고 보고하지 않는다.

## v500 설치 및 사용자 테스트 준비

- 키 저장 안내 수정 `c59e00e`와 버전 `f4ba645`를 비공개 `origin/main`에 fast-forward 반영했다. `bun build-macos.ts`가 clean source와 live 원격 기본 HEAD를 확인하고 unpublished override 없이 v500 앱·DMG를 빌드했다. 공개 snapshot/HTTPS 포털/iPhone 앱/TestFlight 업데이트는 하지 않았다.
- 기존 앱의 staging/backup 설치 절차로 `/Applications/AgentsToZ_byCS.app`을 **500.0.0**으로 교체·재시작했다. 이전 v499 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790221789848-39201.app`에 보존했다.
- 설치 앱의 deep/strict 서명 검증, 새 번들 sidecar health, executable/sidecar SHA-256 빌드 일치를 확인했다. GUI audio-input entitlement와 마이크 사용 설명이 있다. 로컬 ad-hoc 서명이며 Developer ID 공증을 뜻하지 않는다.
- 등록 프로젝트 **134개**의 ID·폴더·워크트리 identity, Gemini 암호화 설정, OpenAI 설정 metadata가 설치 전과 같다. API 키 값은 읽거나 출력하지 않았다. 설치 영수증은 로컬 `artifacts/voice-v500-install/`, 빌드 로그는 `/tmp/agentstoz-voice-v500-build.log`에 보관했다.
- 실제 설치 UI에서 **v500**, OPS 음성 패널의 **이 Mac에 OpenAI 키가 저장되어 있습니다**, 읽을 수 있는 설정 저장/닫기 버튼, 줄바꿈된 안내 문구를 확인했다. 사용자 동의는 새 패널에서 체크되지 않은 상태로 남겨 두었다.
- 사용자 테스트 순서는 **Mac OPS → Mac 워크룸 → iPhone HTTPS 원격 → TestFlight**다. OPS에서는 프로젝트/워크룸 조회와 지시 초안의 대상 확인을, 워크룸에서는 기본 ‘말해서 입력’ 대신 ‘실시간 대화 · 지시 전 확인’을 선택해 한국어 전사·응답 재생·말 끊기·종료 후 마이크 해제를 확인한다. 실행 지시는 화면에서 검토 후 직접 보낸다.
- Mac 테스트에 iPhone은 필요 없다. iPhone 원격 실기기 테스트에는 iPhone이 필요하지만 일반 HTTPS/QR 연결에 USB는 필요 없다. 업데이트된 HTTPS 포털을 Safari에서 먼저 검증할 수 있으며, 네이티브 앱 경로는 개발 앱 설치 또는 TestFlight 업데이트가 별도로 필요하다. 현재 LAN HTTP 음성은 지원하지 않는다.
- **미완료:** 앞선 v499 실사용 시도는 마이크 획득 단계에서 준비 시간 초과였다. 사용자의 마이크 허용 상태 확인을 기다리고 있으며 v500의 실제 OpenAI 인증·음성 왕복, OPS/워크룸 음성 사용자 테스트, iPhone 원격 실기기 테스트는 통과로 기록하지 않는다.

## 긴 OpenAI 키 잘림 재현 및 수정

- v500 실사용 화면의 HTTP 401과 저장된 키를 사용하는 단일 모델 조회의 `invalid_api_key`를 확인했다. 이는 저장 내용의 정확성을 증명하지 않는다. 이후 사용자의 저장 기능 재점검 요청에서 실제 원인을 재현했다. 기존 `security add-generic-password ... -w` 비밀번호 프롬프트는 stdin의 긴 키를 **128자로 조용히 자르고 exit 0**을 반환했다. 기존 네이티브 smoke의 38자 키로는 이 결함을 검출하지 못했다.
- 기존 방식의 실제 Keychain 검사: 입력 32/127/128자는 일치, 입력 **164/256/512자는 모두 128자로 저장되지만 configured=true**였다. 테스트는 임의 서비스·생성한 값만 사용하고 마지막에 지웠다. 사용자 키 값이나 제공자 오류 원문은 출력하지 않았다.
- `security -i`의 command stdin으로 전체 키를 전달해 argv 노출 없이 길이 제한을 피한다. 20~512자의 ASCII token만 허용해 줄바꿈·명령 구분자를 차단하며, 저장 후 정확한 Keychain readback이 일치할 때만 metadata/성공 응답을 갱신한다. interactive command의 exit 0만으로 성공 처리하지 않는다.
- 단위 회귀에서 긴 키 잘림, 실패한 readback의 거짓 성공, 교체 실패 후 metadata 보존, stdin 주입 방지를 먼저 실패로 재현한 뒤 **6개 / 0 fail**을 확인했다. TypeScript 검사 성공. Python quick `20260924T040059Z-759737b8` 통과.
- 재실행 가능한 실제 Keychain 검사 `bun scripts/check-voice-keychain.ts`: **32/127/128/129/164/256/512자 7종**의 반복 교체·새 인스턴스 재조회 exact match 성공, metadata에 비밀 없음, 테스트 항목 삭제 확인, 제공자 호출 0. production subprocess runner를 사용하며 서비스 이름만 격리한다.
- 잘려 저장된 기존 사용자 키의 뒷부분은 복원할 수 없다. 수정 앱 교체 후 사용자가 전체 키를 앱에 직접 다시 입력해야 하며, 이후 OpenAI 인증·한국어 왕복·OPS/워크룸 UAT를 별도로 확인한다.

- 최종 전체 verify `20260924T040418Z-4bc3222f` 통과(402.474초), 검사 중 소스 불변. Python/TypeScript/Bun/Rust 전체 성공. 상세 결과는 로컬 maintainer report에 보존했다.

### v501 설치 완료

- 수정 `92cb6f3`, 버전 `3f01fd3`을 비공개 origin/main에 반영했다. 정상 빌드 래퍼가 clean/published 소스를 확인했고 override 없이 **v501** 앱·DMG를 만들었다. 최종 전체 검사: Bun **4,433 / 599파일 / 0 fail**, Rust **61 / 0 fail**, TypeScript 성공.
- `/Applications/AgentsToZ_byCS.app`을 기존 staging/backup 절차로 **501.0.0**으로 교체했다. 설치본 deep/strict 서명·GUI microphone entitlement·사용 설명·새 번들 sidecar health와 app/sidecar 빌드 hash 일치를 확인했다. 로컬 ad-hoc 서명이며 공개 배포·공증은 별도다.
- 프로젝트 **134개**의 ID/폴더/워크트리 identity와 Gemini 암호화 설정, OpenAI metadata hash가 설치 전과 같다. 이전 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790223213198-26525.app`에 보존했다. 로컬 설치 영수증은 `artifacts/voice-v501-install/`, 빌드 로그는 `/tmp/agentstoz-voice-v501-build.log`에 있다.
- 실제 설치 UI의 **v501**과 OpenAI 키 재입력 화면을 확인했다. 이전 저장 과정에서 유실된 키 뒷부분은 복구할 수 없어 사용자에게 전체 키를 직접 다시 입력하도록 안내했다. 저장 기능의 실제 Keychain 회귀 통과와 사용자 키의 OpenAI 인증·음성 왕복 성공은 별개이며, 후자는 아직 미확인이다.

## 저장 상태 표시와 OPS 입력 방식 개선

- v501 이후 사용자가 ‘저장하면 키 입력칸이 비어서 저장 안 된 것처럼 보임’이라고 명확히 설명했다. 실제 저장 값은 **164자 전체**였고, 해당 키로 OpenAI의 `GET /v1/models/gpt-realtime-2.1`를 한 번 조회해 **HTTP 200**과 모델 ID 일치를 확인했다. 키 값·원본 응답은 출력하지 않았다. 이는 인증/모델 조회 성공이며 Realtime 오디오 왕복 성공과 구별한다.
- 저장 후 빈 password 입력칸 대신 **✓ 키 저장됨 / 키 변경**을 표시한다. 키 변경을 눌렀을 때만 새 입력칸이 나타나고, 취소하면 저장 상태로 돌아간다. 변경 사항이 없으면 저장됨 버튼을 비활성화하고 configure를 다시 호출하지 않는다. 설정 패널은 저장 후 열린 상태를 유지하며 완료 안내를 설정 바로 아래에 표시한다.
- OPS의 모드는 실시간 대화로 고정이므로 disabled select를 **실시간 대화 · 지시 전 확인**이라는 일반 텍스트로 바꿨다. 워크룸만 말해서 입력/실시간 대화 두 옵션을 선택한다.
- 실제 Chromium/WebKit UI 회귀 **42개** 통과: 빈 입력칸 제거, 패널 재열기 저장 상태, 키 변경/취소, 변경 없는 Enter의 무요청, OPS select 없음/고정 텍스트, 워크룸 두 옵션 전환, 기존 저장 실패·readback·테마 대비·모바일 폭 유지. 이전 구현에서 저장 후 빈 입력칸이 남는 실패를 먼저 재현했다. Python quick `20260924T041634Z-a2d2dbb3` 통과.

- 최종 전체 verify `20260924T041932Z-f8fb1158` 통과, 검사 중 소스 불변. Python/TypeScript/Bun/Rust 전체 성공. UI 검사와 전체 소스 검증은 실제 음성 왕복 결과와 구별한다.

### v502 설치 완료

- 화면 수정 `5aac157`, 버전 `2bf249f`을 비공개 origin/main에 반영하고 clean/published 빌드로 **v502**를 설치했다. 전체 검사는 Bun **4,433 / 599파일 / 0 fail**, Rust **61 / 0 fail**, TypeScript 성공이며 Chromium/WebKit UI **42개**가 통과했다.
- 설치본 **502.0.0**, deep/strict 서명, GUI microphone entitlement, API health, executable/sidecar 빌드 hash 일치를 확인했다. 프로젝트 **134개**의 identity와 Gemini 암호화 설정, OpenAI metadata hash가 설치 전과 같다. API sidecar hash는 v501과 같아 인증 저장 코드는 변경되지 않았다. 로컬 영수증은 `artifacts/voice-v502-install/`에 있다.
- 이전 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790224131523-19042.app`에 보존했다. 실제 설치 앱에서 **v502**, 빈 입력칸 대신 **✓ 키 저장됨 / 키 변경**, 비활성 **저장됨** 버튼, 화살표 없는 OPS 입력 방식 문구를 확인하고 패널을 열어 두었다. 현재 키 재입력은 필요 없다. 공개 포털/iPhone 업데이트 및 실제 음성 왕복 검증은 이번 UI 변경의 완료 범위가 아니다.

## 프로젝트 문맥 연결 및 마이크 입력 진단

- 사용자 재현: 워크룸에서 현재 프로젝트·작업을 물어도 모르며, OPS는 연결됨 표시 뒤 전사가 보이지 않음. 시작 세션에는 대상 표시명만 있고 최근 출력 문맥이 없었으며, read_workroom의 필수 after=0 조회는 오래된 첫 페이지였다. Mac 기본 입력은 내장 MacBook Pro 마이크로 확인했으므로 다른 입력 장치를 원인으로 단정하지 않았다.
- 시작 전 정확히 결속된 워크룸의 프로젝트명·AI·최근 최대 6,000자 출력과 관찰 시각을 전달한다. 최신 작업 질문은 read_workroom으로 다시 조회하며, after 생략 시 최신 출력으로 읽는다. host-only 최근 cursor를 사용해 전체 버퍼를 페이지 순회하지 않는다. 읽기 전후 권한·대상 identity를 재검증하고, 원격은 기존 voice/terminal grant 범위를 유지한다. 파일·장기기억 전체 접근을 새로 부여하지 않는다.
- 문맥은 신뢰된 system 지시와 분리한 user-role JSON 메시지이며, 제공자의 일치하는 item acknowledgement를 받아야 연결 완료로 표시한다. OPS에는 허용된 프로젝트 목록과 도구별 역할을 제공하고, 워크룸 전용 prepare_instruction 대신 OPS prepare_workroom_instruction을 안내한다. 지시 초안은 기존 사람의 검토/전송 경계를 유지한다.
- 실제 OpenAI 호출에서 item.id 길이 제한 오류를 발견해 32자 이하로 수정했다. 모의 검사는 이를 검출하지 못했으며, 실제 제공자 검증을 별도로 수행했다. 공식 문서: https://developers.openai.com/api/docs/guides/realtime-conversations 및 https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime . GPT-Live 스키마로 변경하지 않았다.
- UI는 마이크 장치명, 로컬 입력량, 발화 감지/인식 중/인식 완료를 구분한다. Web Audio 측정만 사용하고 추가 녹음·업로드는 없다. 측정 불가를 무음으로 표시하지 않으며 종료/입력 끝내기/오류 때 context·timer를 해제한다. 전사 실패도 표시한다. 이 변경만으로 사용자의 실제 마이크 인식 품질 향상을 주장하지 않는다.
- 재현용 유료 opt-in 검사: `bun --no-env-file scripts/check-voice-project-context.ts --live` 및 `--live --ops`. 저장된 키는 호스트 메모리에서만 읽고, 격리 PTY의 합성 프로젝트와 macOS Yuna 한국어 합성 음성을 실제 WebRTC로 전송한다. 사용자 마이크·프로젝트·기억은 사용하지 않는다. 종료 시 call/PTY/browser/temp를 정리한다. 첫 fixture는 음성 뒤 무음 RTP가 없어 발화 종료가 안 되었으므로 3초 무음 버퍼와 호스트 heartbeat를 추가했다.
- 실제 **워크룸/OPS 둘 다** 한국어 발화 감지·전사·read_workroom 호출·프로젝트/작업에 맞는 응답과 오디오 수신을 확인했다. 워크룸 질문 “지금 연결된 프로젝트 이름과 현재 작업 내용을 알려주세요.”에 “별빛 정원, claude, 로그인 오류 수정 중, 아직 테스트 완료 전”이라고 답했다. API 오류 없음. 이는 합성 음성의 실제 API 통과이며, 사용자 내장 마이크/실제 작업 UAT와 iPhone 검증은 별도다.
- source 회귀: 시작 문맥 누락/읽기 실패 시 연결 차단, 최신 출력/오래된 출력 제외, 원격 프로젝트 필터, 문맥 ACK ID 일치, 마이크 meter 수명 검사. Chromium/WebKit 이벤트 UI 검사(입력/감지/전사/실패/종료) 및 저장 UI 42개 성공. Python quick `20260924T044230Z-eb8d63da` 성공.

- 최종 전체 verify `20260924T045732Z-dabcd5d6` 성공(414.289초), 검사 중 소스 불변. 실제 Web Audio 합성 신호의 입력량 측정도 Chromium/WebKit 모두 확인했다. 네이티브 사용자 마이크와 구분한다.

### v503 설치 완료

- 수정 `cb70c22`, 버전 `10a3258`을 비공개 origin/main에 반영했다. clean/published source guard를 통과한 정상 빌드로 **503.0.0** 앱·DMG를 생성했다. 최종 전체 검사는 Bun **4,438 / 600파일 / 0 fail**, Rust **61 / 0 fail**, TypeScript 성공이다.
- 기존 staging/backup 절차로 설치·재시작했다. 설치 앱 deep/strict 서명, GUI 마이크 entitlement/설명, API health, 실행 파일 및 sidecar의 빌드 hash 일치를 확인했다. 로컬 ad-hoc 서명이다. 이전 앱은 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790226473562-84592.app`에 보존했다.
- 프로젝트 **134개**의 identity, Gemini 암호화 설정, OpenAI metadata hash가 설치 전과 같다. 영수증은 로컬 `artifacts/voice-v503-install/`, 빌드 로그는 `/tmp/agentstoz-voice-v503-build.log`다.
- 실제 설치 화면의 **v503**을 확인하고 **OPS 음성** 패널을 마이크 대기 상태로 열어 두었다. 자동으로 사용자 마이크를 시작하지 않았다. 사용자는 동의 후 “현재 프로젝트와 진행 중인 작업을 알려줘”를 말하고 입력 막대→발화 감지→전사→답변을 확인한다. 워크룸은 ‘실시간 대화’를 선택한다. 실제 사용자 마이크의 인식 품질과 iPhone 원격 음성은 아직 검증 완료로 기록하지 않는다.

## Voice records and shared operating memory

- Opted-in voice sessions retain final user transcripts and generated assistant replies in a separate local AES-GCM encrypted SQLite store, with its own Keychain/DPAPI key. Audio is not saved. `내가 한 말 → 음성 세션` exposes bounded session/utterance pages and recording failures. Remote voice may opt into recording on the Mac; raw-history reads remain local, separate from mobile `voice.use` and the cloud CLI feed.
- Completed project voice utterances are real `voice` evidence for the existing V2 memory pipeline: exact source digest, registration checks, consent boundary, eight-turn/input budgets, provider binding, dispatcher/leases, one-attempt recovery and durable local receipt. Schema 11 fences older hosts from interpreting the new source type. No fake Claude/Codex transcript is created. Interrupted/incomplete sessions remain readable but are excluded from automatic completion evidence.
- Existing host manual/legacy session saves include a bounded oldest pending voice batch. Only a verified local save acknowledges that batch; further voice evidence stays pending independently of the CLI remembered timestamp. Voice history's session-save action uses the existing dispatcher and async durable job receipt; it never falls back around a V2 policy or recovery hold.
- The connected `AgentsToZ-Control` and OPS already share the same memory ID/root. Voice sessions now share that OPS scope, recall and proposal tools; ordinary projects remain separate. Shared OPS candidates still require the established human review. A Control workroom does not gain cross-project execution tools just because it uses OPS memory.
- Closing the voice panel hides it, leaves the live media session running, and shows a compact microphone/session control. Explicit voice end releases media. Project/session removal, document background/exit, expired grants and network failure retain the existing lifecycle stops.
- Removed forced Korean ASR language; added Korean/English proper-name hints and bilingual response instructions. This improves the configuration for mixed speech, but does not guarantee recognition of every accent or noisy input.
- iPhone voice uses the existing HTTPS portal and OS microphone prompt. LAN HTTP cannot acquire browser microphone permission. The TestFlight wrapper and production portal must both be updated; simulator/fixture checks are not physical iPhone audio evidence.

### Validation for v504

- Final maintainer verify `20260924T060040Z-c14f8451` passed in 422.493 seconds with source unchanged: TypeScript, Bun **4,446 / 601 files / 0 fail**, Rust **61 / 0 fail**. The earlier run with schema expectations and concurrent source edits failed and is not release evidence.
- The concurrent voice-store append/read failure was reproduced before adding in-process serialization under the existing external lock. Relevant final regressions passed **42 / 0 fail**, including encrypted voice evidence through the existing memory dispatcher and a durable local receipt with an isolated provider fixture.
- Chromium/WebKit media checks passed: hiding and reopening the panel preserves the same live track/session, while explicit end releases it. History paging, speaker labels and project/OPS memory controls passed in both browsers; settings UI passed **42 checks**. Native iPhone-wrapper regression checks passed **11 groups**. These do not prove physical iPhone audio.
- Real OpenAI WebRTC check `bun --no-env-file scripts/check-voice-project-context.ts --live --mixed` passed with synthetic Korean/English speech, final transcript, current-workroom read and context-correct answer audio. OpenAI and TestFlight were recognized; Realtime appeared phonetically as 리얼타임. No provider error codes. This was a synthetic audio test, not the user's microphone or project conversation.
- Shared OPS remains a reviewed operating-memory candidate workflow. The exact current Control root and memory ID share OPS memory; other projects use their own memory. Interrupted records are retained for inspection and excluded from complete automatic evidence. Existing automatic-memory rotation, consent and budgets still apply.

### v504 Mac installation, portal deployment and iPhone upload

- Functional commit `7508305` and version commit `ac91be1` were fast-forwarded to private `origin/main`. The normal macOS wrapper verified clean published source and built **504.0.0** without the unpublished override. No public repository snapshot was published.
- Installed through the existing staging/backup API. The installed app's deep/strict signature, microphone entitlement/usage text, sidecar health and executable/sidecar hashes match this build. All **134** registered project identities, Gemini encrypted settings and OpenAI metadata match the immediate pre-install baseline. The prior app remains at `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1790230378192-20375.app`. This is the existing local ad-hoc signing route, not a new notarized distribution claim.
- Native installed UI shows **v504**, the `내가 한 말 → 음성 세션` view and the OPS panel's encrypted-recording choice plus automatic Korean/English recognition text. The panel is left at microphone standby; no user microphone was started during installation verification. Earlier unrecorded sessions are not retroactively recovered.
- Deployed a clean tracked-source staging directory, excluding local artifacts/memory/credentials, to the existing private portal Vercel project. Its production alias returns release **504.0.0**, source `ac91be1aa9fc663876728d79f38583f8dde42538`, protocol `agentstoz-local-v9`. Both `/` and `/remote/` allow self microphone; `/remote/` retains `no-store` and its restrictive CSP. Existing chunk-size warnings remain.
- Archived signed iPhone **504.0.0 (504)** using the existing TestFlight bundle `com.intenet.agentstoz.mobile.testflight` and team `DA8QKAQ2C9`. Verified device archive signature, microphone usage text, privacy manifest and testflight/source metadata. Xcode upload completed with **EXPORT SUCCEEDED** at 15:13 KST on 2026-09-24; Apple accepted the package for processing.
- **Still pending:** App Store Connect browser login, Apple's completed processing state, and inclusion in the existing internal test group. Upload success is not proof of TestFlight download availability. Physical iPhone install, microphone/playback, relay/cellular recovery and user conversation quality remain unverified. The authenticated browser step was left for the user; no credentials or approval settings were changed.
- Local evidence: `artifacts/voice-v504-install/`, `artifacts/voice-v504-ios/`; build/upload logs `/tmp/agentstoz-voice-v504-build.log`, `/tmp/agentstoz-v504-ios-archive.log`, `/tmp/agentstoz-v504-ios-upload.log`, `/tmp/agentstoz-v504-portal-deploy.log`.

## OpenAI Realtime / Gemini Live 선택과 프로젝트 기억 연결

- 한 음성 세션에서 **OpenAI Realtime 또는 Gemini Live**를 선택한다. 두 키는 각각 Mac에 저장되며 브라우저·iPhone 응답에 포함하지 않는다. OpenAI는 브라우저 WebRTC와 Mac sideband를, Gemini는 Mac의 Live WebSocket과 인증된 클라이언트의 PCM16 16 kHz 입력·PCM16 24 kHz 출력을 사용한다. Gemini PCM은 기존 E2EE workspace channel의 별도 bounded budget을 사용하고 원음 파일은 저장하지 않는다.
- 두 제공자는 같은 `VoiceSessionHost` 대상 바인딩과 도구를 사용한다. 워크룸은 현재 target/session에 고정되어 최근 출력과 `recall_project_memory`로 **그 프로젝트의 정본 장기기억**만 검색한다. 대상 경로·inode·memory binding이 바뀌면 세션을 닫는다. OPS는 현재 Control profile에 고정되고 `recall_ops`로 OPS 운영 기억을 조회하며, 허용된 프로젝트의 워크룸만 다룬다.
- 워크룸 지시는 `prepare_instruction`, OPS 지시는 `prepare_workroom_instruction` 초안으로 남아 사람의 입력 준비 확인 뒤 전송된다. 공유 OPS 기억은 `propose_ops_memory` 후보까지만 만들며 음성 모델이 승인할 수 없다. 동의한 최종 발언·답변은 기존 암호화 음성 기록과 프로젝트 세션 기억 정리 대상에 들어가고 원음은 저장하지 않는다.
- Gemini는 현재 실시간 대화 모드만 제공한다. 브라우저는 약 43 ms 입력 조각으로 downsample하고, Mac은 declared tool만 실행하며 transcript/audio/interruption을 bounded queue로 반환한다. 연결 종료·권한 변경·대상 변경 때 socket, AudioContext, track과 재생 queue를 해제한다.
- 회귀 근거: dual-provider 프로토콜/호스트/Gemini Live 변환/PCM 변환/모바일 별도 budget/프로젝트 장기기억 범위 테스트 **42개 / 0 fail**, TypeScript 성공, Chromium/WebKit 설정 UI **48개** 성공, production web build 성공. 실제 사용자 Gemini 계정의 음성 왕복과 물리 iPhone 마이크·재생은 설치본 배포 뒤 별도 확인한다.
