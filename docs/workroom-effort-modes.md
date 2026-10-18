# 워크룸 에포트 조정

워크룸 설정은 실행 호스트의 모든 워크룸이 함께 쓴다. Mac 본창·분리창·모바일 워크룸·새 작업 화면의 **워크룸 설정 → 에포트 조정**에서 선택한다.

| 모드 | 동작 |
|---|---|
| 자동선택 (기본) | 첫 요청과 후속 전체 요청의 난이도를 다시 판단해 낮음·보통·높음 중 선택하고 현재 CLI 세션에 적용한다. |
| 추천제공 | 요청별 강도를 안내하며 시작 인자나 실행 중 CLI 설정은 변경하지 않는다. |
| 미선택 | 자동 변경과 추천을 끄고 현재 CLI 설정을 따른다. |

`workroom-effort-auto.json`의 v2는 `mode: auto | recommend | off`를 저장한다. 파일이 없으면 자동선택이며 v1의 명시적 `auto: false`는 미선택으로 읽는다. 기존 boolean 요청은 계속 호환된다. 세 모드 요청·응답은 `effortModes: true`로 명시하며 다른 community 기기의 설정 변경은 계속 거부한다. 모바일은 기존 프로젝트 grant를 확인하고 실제 실행 호스트의 설정을 사용한다.

난이도 판단은 기존 결정 규칙을 재사용하며 추가 AI 호출이 없다. 모델과 계정을 변경하지 않는다. 사용자가 CLI에서 직접 `/effort`, `/model`, `/reasoning`을 선택하면 해당 세션은 직접 선택을 우선한다. 실행 중인 요청을 강제로 끊지 않는다.

## 실행 중 변경

- Codex 0.163 이상은 메타데이터와 기본 키맵을 확인한 뒤 세션 전용 `Alt+,`·`Alt+.`를 사용한다. 실행 인자로 현재 모델·강도를 네이티브 상태 줄에 표시하고 한 단계씩 변경 결과를 확인한다. 전역 기본값을 저장하는 `/model` 확정 경로는 사용하지 않는다.
- Claude Code는 v2.1.257 이상을 메타데이터로 확인하고 `/effort` 슬라이더에서 `s`로 현재 세션에만 적용한다. 기본값을 저장하는 `/effort <level>`·Enter 경로는 사용하지 않는다.
- Hermes는 `/reasoning <level>`을 사용하며 `--global`을 붙이지 않는다. 모델·계정 선택은 Hermes의 정식 `/model` 화면을 사용한다. Codex OAuth는 Hermes의 정식 `hermes auth add openai-codex` 로그인으로 연결한다. 기존 Claude 자격 증명과 공존하며, Hermes의 별도 인증 저장소를 사용하고 Codex CLI의 갱신 토큰을 복사하지 않는다. 로그인 후 `/model`에서 Codex 공급자와 실제 계정이 제공하는 모델을 선택한다. 계정 승인이 완료되기 전에는 연결 완료로 표시하지 않는다.

Hermes 0.22 TUI에서는 명령 텍스트와 Enter를 따로 보낸다. 명령 텍스트가 정확히 입력된 화면과 커서 위치를 확인하고, Enter 직전에도 초안·승인 화면·권한을 다시 확인한다. `· reasoning: low` 형식의 네이티브 확인 행과 빈 입력칸이 돌아와야 적용 완료다. 시작 강도를 계속 표시할 수 있는 상태 줄은 변경 영수증으로 사용하지 않는다. 첫 화면의 합성 커서·안내 문구는 알려진 준비 상태·입력칸 배치에서만 빈 입력으로 해석하며, 사람이 입력한 같은 문구나 기존 초안은 보존한다.
Hermes의 대기 시계는 PTY를 계속 갱신할 수 있으므로, 네이티브 `ready` 상태 줄과 입력칸·구분선 배치가 함께 확인되면 일반 출력 정적 대기 판정과 별개로 입력 가능을 증명한다. 작업 중 표시·알 수 없는 화면에는 이 예외를 적용하지 않는다.

승인·선택 화면과 편집 중인 원본 터미널 입력에는 제어 명령을 보내지 않는다. Claude/Hermes 응답이 진행 중이면 입력 대기 시점을 최대 60초 기다린다. 권한 취소·종료·Esc·프로젝트 변경은 대기를 중단한다. 네이티브 변경 결과를 확인하지 못하면 사용자 요청을 쓰기 전에 거부하여 초안을 유지한다. 실제 요청 접수·PTY 쓰기는 기존 durable submission receipt를 사용하며 자동 재전송하지 않는다. 자동 제어로 잠시 열린 선택 화면은 사용자 질문으로 스레드에 게시하지 않는다.

확인할 수 없는 CLI 버전·모델·사용자 키맵·환경 강제 설정은 임의로 덮어쓰지 않는다. Antigravity는 기존처럼 자동 적용 대상에서 제외한다. 원본 터미널의 개별 키 입력은 그대로 전달하고 전체 요청 전송 경로에서 난이도를 판단한다.

이 설정은 워크룸 CLI의 실행 정책이며 외부 AI 앱·현재 Codex 대화의 모델/추론 강도 추천 정책과 별개다.

## 근거와 검증

- [Codex 0.163.0 세션 전용 추론 단축키](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/chatwidget/reasoning_shortcuts.rs)
- [Claude Code 에포트와 세션 전용 선택](https://code.claude.com/docs/en/model-config#adjust-effort-level)
- [Hermes reasoning 설정](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#reasoning-effort)
- [Hermes 모델과 Codex OAuth 공급자](https://hermes-agent.nousresearch.com/docs/integrations/providers)

계약·가상 PTY·Chromium/WebKit 화면 검사는 AI를 호출하지 않는다. 사용자의 현재 제약에 따라 Claude 토큰을 사용하는 실기 실행은 하지 않으며, 실제 AI 실행은 Codex 경로로 검증한다. 모의 Claude/Hermes 제어 검사를 실제 공급자 응답 검증으로 보고하지 않는다.
