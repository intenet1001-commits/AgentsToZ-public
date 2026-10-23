# AgentsToZ 음성 세션 설계

작성일: 2026-09-24

## 목표

펫 캐릭터나 화면 복제가 아니라 두 가지 음성 진입 경로를 정확한 OPS 또는 프로젝트 Workroom에 결속한다.

1. **Codex 음성 경로**: Codex 앱에서 시작한 음성 대화가 `agentstoz_use_*` MCP 도구로 AgentsToZ를 호출한다.
2. **AgentsToZ 자체 음성 경로**: Mac 또는 승인된 원격 iPhone에서 시작한 Gemini Live 세션이 OPS 또는 현재 Workroom을 직접 호출한다.

두 경로의 음성 엔진과 대화 소유자는 다르지만 프로젝트 해석, 사람 확인, 권한, 실행 영수증, 기록 귀속은 같은 AgentsToZ 계약을 사용한다.

## 현재 코드에서 재사용할 근거

- `src/projectCodexVoice.ts`는 Codex Desktop `realtime_voice` 기록의 프로젝트 요청, 실제 적용 경로, 실제 실행 경로를 분리해 판정한다. 프로젝트를 선택했다는 표시만으로 프로젝트 실행이나 기억 저장 성공을 주장하지 않는다.
- `src/projectCodexVoiceLaunch.ts`와 `api-server.ts`의 `/api/open-project-codex-voice`, `/api/start-global-codex-voice`는 Codex 앱의 프로젝트 Composer와 전역 Voice를 별도 동작으로 취급한다.
- `agentstoz-use-mcp-server.ts`와 `src/agentstozInvocationInstaller.ts`는 Codex·Claude·Hermes·Antigravity에서 사용할 AgentsToZ 호출 규칙을 설치한다.
- Workroom은 이미 등록 프로젝트의 opaque `targetId`, 네 AI 종류, Bypass 선택, 모바일 grant, 암호화된 원격 연결을 갖고 있다. 음성 명령도 이 경계를 재사용하고 로컬 경로나 임의 shell을 새로 노출하지 않는다.

공개 Codex CLI는 Apache-2.0 코드이므로 해당 저장소의 재사용은 가능하다. 그러나 Codex 데스크톱의 펫·Voice UI가 공개 CLI 저장소와 동일한 오픈소스 범위라는 전제는 두지 않는다. AgentsToZ는 화면을 복제하지 않고 공개 계약과 자체 구현을 사용한다.

## 사용자 동작

### Codex 앱에서 말할 때

1. 사용자가 Codex의 전역 또는 프로젝트 음성 대화를 시작한다.
2. “아젠투지…” 호출은 설치된 AgentsToZ MCP를 사용한다.
3. 별칭은 다음과 같이 해석한다.
   - `아젠투지`, `아젠투지오피에스`, `아젠투지 운영` → 현재 인증된 OPS binding
   - `아젠투지데브` → 등록 역할 `dev`인 프로젝트
   - 그 밖의 정확한 등록 프로젝트명 → 해당 프로젝트
4. 이름이 없거나 중복되면 후보를 읽고 사용자의 확인을 받는다.
5. Codex 음성 대화가 실제로 대상 프로젝트에서 실행됐다는 증거가 없으면 파일 작업과 프로젝트 기억 저장을 허용하지 않는다.

### AgentsToZ에서 직접 말할 때

1. 앱 공통 음성 진입점은 OPS Workroom을 만들거나 이어서 연다.
2. 각 Workroom의 음성 버튼은 그 Workroom의 `targetId`를 세션 시작 때 고정한다.
3. Gemini Live는 음성 입출력과 function calling만 담당한다.
4. 프로젝트 조회, Workroom 시작, 메시지 전달, 상태 읽기는 Mac 호스트가 기존 AgentsToZ API/MCP 계약으로 실행한다.
5. 대상 전환은 표시명과 opaque ID를 다시 해석하고 사용자에게 프로젝트명을 확인받은 뒤 적용한다.

## 공통 세션 계약

```ts
type VoiceProvider = 'codex-desktop' | 'gemini-live' | 'openai-realtime';
type VoiceEntrySurface = 'global-ops' | 'workroom' | 'remote-workroom';

interface VoiceSessionBinding {
  sessionId: string;
  provider: VoiceProvider;
  entrySurface: VoiceEntrySurface;
  target: { kind: 'ops' | 'project'; targetId: string; label: string };
  controllerId: string | null;
  state: 'connecting' | 'active' | 'interrupted' | 'ended';
  createdAt: string;
}
```

- `targetId`는 등록 프로젝트/Workroom 조회가 반환한 값만 허용한다.
- 로컬 경로, API key, shell command, profile secret은 음성 모델과 원격 단말에 보내지 않는다.
- 세션 시작 뒤 표시명 변경이 생겨도 ID가 정본이다. 삭제·재등록 또는 OPS profile 전환은 세션을 중단하고 다시 확인한다.
- 한 음성 세션은 한 시점에 대상 하나에만 결속된다. 프로젝트 간 전달은 새 대상 Workroom 영수증을 받은 뒤 별도 기록으로 남긴다.

## Gemini Live 연결 구조

### Mac

- 사용자가 입력한 Gemini API key는 localhost/Tauri 관리 요청으로 받아 macOS Keychain에 저장한다.
- 상태 조회는 `missing | ready | locked | invalid`만 반환하며 key 원문은 다시 반환하지 않는다.
- 공급자 연결 검사는 사용자가 누른 1회 동작으로 실행하고 성공 결과가 음성 자동 실행 동의가 되지는 않는다.
- Mac 음성 UI는 마이크 PCM과 재생을 담당하고 Gemini Live WebSocket을 연다.

### 원격 iPhone

- 원격 연결에 `voice.use` grant를 별도로 추가한다. 기존 터미널 권한만으로 마이크·음성 도구 호출을 허용하지 않는다.
- iPhone 네이티브 앱이 마이크와 오디오 세션을 소유한다. Mac은 승인된 controller와 target binding을 확인해 짧은 수명의 공급자 세션 권한을 발급한다.
- 장기 API key는 iPhone, 웹 페이지, relay, 로그에 전달하지 않는다.
- LAN HTTP 웹 페이지는 브라우저 secure-context 제약 때문에 정식 마이크 경로로 간주하지 않는다. 같은 Wi-Fi에서도 iPhone 네이티브 앱을 사용한다.
- 개인 HTTPS 포털은 브라우저 마이크 권한을 받을 수 있지만, 동일한 `voice.use` grant와 암호화된 host session이 없으면 도구 실행을 허용하지 않는다.

초기 구현은 Gemini가 지원하는 짧은 수명의 클라이언트 토큰을 사용한다. 지원 범위나 정책이 맞지 않으면 Mac이 오디오 WebSocket 프록시를 맡는 fallback을 사용한다. 이 선택은 API key를 단말에 전달하는 방식으로 우회하지 않는다.

## 모델에 공개하는 도구

음성 모델에는 다음처럼 좁은 도구만 공개한다.

- `resolve_target(aliasOrName)` → path 없는 후보와 stable ID
- `open_workroom(targetId, agent)` → 기존 네 AI 시작 영수증
- `send_workroom_message(sessionId, text)` → 기존 bounded input
- `read_workroom_status(sessionId)` → 실행/종료와 제한된 표시 상태
- `switch_voice_target(targetId, confirmationId)` → 사람이 확인한 대상 전환

임의 shell, 파일 경로 입력, memory write, Git push/merge, 권한 변경은 음성 모델의 일반 function call로 열지 않는다. 기존 UI가 확인을 요구하는 동작은 음성에서도 같은 확인 영수증을 요구한다.

## 기록과 장기기억

- 전역 AgentsToZ 음성은 OPS binding에 운영 기록을 남긴다.
- Workroom 음성은 해당 프로젝트의 세션 기록에 남긴다.
- 다른 프로젝트로 전달하면 원본에는 전달 요청, 대상에는 새 Workroom 실행 및 수신 기록을 남긴다.
- transcript는 실행 증거이자 대화 기록이며 curated 장기기억이 아니다. 완료 뒤 기존 `remember-session` 또는 승인된 자동 기억 정책이 별도로 저장한다.
- Codex Desktop 음성은 기존 `realtime_voice`의 실제 실행 경로를 계속 확인한다. Gemini Live는 AgentsToZ가 세션을 직접 생성하므로 생성 시점의 target binding과 모든 도구 영수증으로 귀속을 증명한다.

## 구현 순서

1. **대상 계약**
   - `VoiceSessionBinding` 정규화와 alias resolver를 순수 모듈로 만든다.
   - OPS profile binding, DEV role, 프로젝트 표시명 중복을 테스트한다.
2. **Mac 공급자 설정**
   - Keychain add/read-status/delete와 Gemini 연결 검사 관리 API를 만든다.
   - 상태 요청은 Keychain prompt나 네트워크 호출 없이 끝나게 한다.
3. **Gemini Live 세션**
   - 중단 발화, transcript, function call, backpressure, 종료 영수증을 구현한다.
   - 전역 진입은 OPS, Workroom 진입은 현재 target을 사용한다.
4. **원격 iPhone**
   - `voice.use` grant, 네이티브 마이크 권한, 오디오 중단/복구, 화면 잠금 후 재연결을 구현한다.
   - relay에는 암호화된 음성/제어 envelope만 보이게 한다.
5. **표면 연결**
   - Mac 공통 음성 버튼과 Workroom 음성 버튼을 추가한다.
   - 모바일 OPS/프로젝트 Workroom에 같은 상태·중단·대상 확인 UI를 추가한다.
6. **두 진입 경로 통합 검증**
   - Codex 앱에서 AgentsToZ MCP 호출과 Gemini 직접 세션이 같은 target resolver와 기록 정책을 지키는지 검증한다.
   - OpenAI Realtime은 같은 provider adapter에 추가할 수 있게 두되 1차 출하를 막지 않는다.

## 검증 기준

- Mac 전역 음성 → OPS Workroom 1개가 시작 또는 재개되고 OPS 기록에만 남는다.
- Mac 프로젝트 음성 → 정확한 프로젝트 Workroom에만 기록된다.
- Codex 앱 음성에서 세 별칭이 같은 OPS binding을 사용하고 `아젠투지데브`는 DEV를 사용한다.
- 중복 프로젝트명은 확인 전 메시지를 보내지 않는다.
- iPhone 17에서 LAN 네이티브 원격 음성, 인터넷 원격 음성, 화면 잠금·복귀, 네트워크 변경, controller revoke를 검증한다.
- revoke/만료/target 삭제 뒤 모델의 늦은 function call은 실행되지 않는다.
- API key와 로컬 경로가 브라우저, iPhone 저장소, relay, transcript, 로그에 나타나지 않는다.
- 음성 중단 중에도 기존 Workroom 터미널 세션과 텍스트 입력이 유지된다.
- transcript 생성 성공을 장기기억 저장 성공으로 표시하지 않는다.

## 공식 참조

- Codex 공개 저장소와 라이선스: <https://github.com/openai/codex>, <https://github.com/openai/codex/blob/main/docs/license.md>
- Gemini Live API: <https://ai.google.dev/gemini-api/docs/live-api>
- Gemini Live WebSocket: <https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket>
- OpenAI Realtime API: <https://platform.openai.com/docs/api-reference/realtime>

## 1차 키 설정 구현 (2026-09-24)

- Workroom의 `Gemini 음성 설정`에서 API 키 저장·교체·삭제, 수정 가능한 Live 모델 ID, 사용자 클릭 1회 연결 검사를 제공한다.
- 설치 Mac의 기존 Agent Runtime capability와 정확한 POST `/api/agent-runtime/voice-settings`만 사용한다. 원격 DTO에는 추가하지 않는다.
- 전용 macOS Keychain wrapping key로 API 키를 AES-256-GCM 암호화하여 0600 앱 데이터 파일에 보관한다. API 키는 CLI 인수, 응답, 브라우저 저장소, 원격 단말로 내보내지 않는다. 설정 화면 상태 조회는 Keychain·네트워크에 접근하지 않는다.
- 기존 암호화 설정의 Keychain 키 유실 때 새 wrapping key를 생성하지 않는다. 교체·삭제·검사는 직렬화하며 키 교체 시 기존 검사 영수증을 초기화한다.
- Live WebSocket은 고정 Google endpoint에 setup만 전송하고 setupComplete를 받은 뒤 닫는다. 마이크·대화·프로젝트·function call은 전송하지 않는다. text와 binary JSON 응답, 15초 시간 상한, 64KB 응답 상한을 처리한다.
- 실제 공식 문서의 현재 예시는 `gemini-3.8-live`; Context7 예시는 `gemini-3.1-flash-live-preview`이므로 모델 ID를 사용자가 변경할 수 있게 했다. 계정의 실제 이용 가능 여부는 키 입력 후 검사해야 한다. https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket 와 https://ai.google.dev/api/live 확인.
- 전체 verify `20260924T001149Z-e203cfec` 통과. 이후 binary 응답/입력란 크기 보완은 Gemini 회귀 7개와 TypeScript로 추가 검증했다. 실제 공급자 키·음성 연결은 아직 검증하지 않았다.
- 후속: 마이크/오디오, OPS·프로젝트 음성 세션 및 실행 영수증, 원격 voice.use grant와 iPhone 네이티브 음성. 이번 키 설정을 음성 기능 전체 완료로 표시하지 않는다.

## 키 저장 상태 UX 보완 (2026-09-24)

- 사용자가 저장했다고 알렸지만 설치 v496은 미등록을 반환했고, encrypted settings 파일과 전용 wrapping-key metadata 모두 없었다. 키 원문을 읽지 않았다. 이전 클릭의 성공/실패 안내를 사용자가 확인하지 못했으므로 특정 저장 실패 원인을 단정하지 않는다.
- 별도 이름의 임시 Keychain과 컴파일된 host canary에서 가짜 키 저장·재조회·삭제가 성공했다. 임시 키와 파일은 정리했다. 이 재현 성공은 사용자의 실제 키 저장 성공을 뜻하지 않는다.
- 설정 버튼에 미등록/저장됨/연결 확인됨을 상시 표시하고 최초 렌더에서 상태를 읽는다. 폼은 입력 중 상태와 저장 완료를 구분하고 Enter 저장을 지원한다. 저장 ack 뒤 상태를 다시 읽어 확인하기 전에는 draft를 지우지 않는다.
- 오류는 입력란 위 alert로 표시하고 상태 새로고침으로 지우지 않는다. 저장·조회 중 중복 동작과 늦은 결과의 덮어쓰기를 막는다. 접고 펼쳐도 미저장 입력을 유지한다.
- `node tests/gemini-voice-settings.e2e.mjs`: Chromium/WebKit 20개 검사 통과. 모든 외부/API 요청을 막은 fixture로 실패/false receipt/재조회 실패/성공 및 390px 레이아웃을 확인한다.
- maintainer quick `20260924T004923Z-f033ae2c`, 전체 verify `20260924T005139Z-05ba8d15` 통과. 후자는 소스 변경 없이 TypeScript·Bun·Rust를 394.995초에 검증했다. 실제 사용자 키 저장과 Google 연결 성공은 별도로 확인해야 한다.

## Authorization key 호환성 수정 (2026-09-24)

- v497 실제 저장 시도에서 `API 키 형식을 확인하세요` 오류를 확인했다. 키 원문은 조회하지 않았다.
- 기존 `[A-Za-z0-9_-]{20,256}` 검사가 Google의 새 `AQ.` 인증 키 형식을 거부하는 문제를 fixture로 재현했다. 입력란의 256자 제한도 긴 키를 자를 수 있었다. 특정 사용자 입력값의 내용이나 길이를 확인한 것은 아니다.
- Google 공식 API key 문서와 Context7에서 authorization key 전환을 확인했다. Live WebSocket은 기존 공식 query-key 인증을 유지한다. 참조: https://ai.google.dev/gemini-api/docs/api-key 및 Google 지원 답변 https://discuss.ai.google.dev/t/gemini-api-key-start-from-aq/171575/2 .
- 키를 provider가 검증할 불투명한 printable ASCII 값으로 처리한다. 애플리케이션 자원 상한은 2048자로 두고 공백·제어문자는 거부한다. 입력란도 같은 상수를 사용한다. 인증 유효성은 별도 Live 검사로 확인하며 저장 성공으로 판단하지 않는다.
- 2048자 가짜 인증 키의 파싱·암호화 저장·재조회·probe 전달, 기존 형식 및 잘못된 입력 거부를 포함한 8개 host 검사 통과. Chromium/WebKit에서 긴 입력 유지·접기 후 draft 보존·저장 영수증 등 22개 UI 검사 통과. 외부 호출은 차단한 fixture 검사다.
- maintainer quick `20260924T010749Z-f9c7a073`와 전체 verify `20260924T010823Z-57af0970` (405.06초) 통과. 실제 키 저장과 Google 인증 성공은 설치 후 별도 확인한다.
