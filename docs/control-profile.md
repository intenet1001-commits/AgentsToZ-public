# AgentsToZ 운영 프로필

AgentsToZ는 이 OS 사용자의 여러 프로젝트에서 함께 쓰는 운영 기억을 제공합니다.
프로젝트 목록에 `AgentsToZ-Control`이 없어도 도구 및 설정의 **아젠투지 · 운영 프로필** 또는
AI 작업의 **운영 프로필과 기억 확인**에서 준비 상태를 볼 수 있습니다.

## 시작과 복원

- 새 공개 사용자: 첫 로컬 API/앱 실행에서 사용자 전용 앱 데이터에 프로필을 준비합니다. 프로젝트, GitHub, 작업 루트는 필요하지 않습니다.
- 기존 Control: 등록된 Control의 실제 기억 ID와 내용을 유지합니다. 여러 후보가 있으면 화면에서 하나를 선택합니다.
- 다른 Mac에서 개인 byCS 업데이트: Private 소스에만 있는 복원 메타데이터로 기존 Private 저장소의 불변 ID를 확인하고, byCS 옆의 Control을 복원합니다. 기억 Pull이 완료되어야 연결 완료로 표시합니다.
- 공개 사용자가 자기 Control을 복원한 경우: 기존 GitHub 복원 흐름을 완료한 뒤 프로필 화면에서 등록된 Control을 연결합니다. 이미 운영 기록이 쌓인 다른 프로필은 자동 교체하지 않습니다.

`git pull`은 실행 중인 앱 바이너리를 교체하지 않습니다. 소스를 Pull한 뒤 **최신 런타임을 실행**해야 합니다.
개인 복원 정보는 공개 snapshot에서 제외되며 토큰이나 Mac 절대경로를 포함하지 않습니다.

## AI에서 사용

프로필 화면에서 설치된 AI의 연결을 확인·준비하고 해당 AI의 MCP 도구를 새로고침합니다.
Codex와 agy는 CLI의 MCP 등록 명령, Claude Code는 사용자 MCP 설정, Hermes는 실제로 설정된
기본/custom home 및 개별 프로필에 연결합니다. 다른 모델·인증·MCP 설정을 교체하지 않습니다.
agy CLI 설정 확인은 Antigravity IDE에서의 실제 실행 확인과 구분합니다.

예: “아젠투지, 운영 기억을 확인하고 프로젝트 목록을 보여줘.”

공통 도구는 다음과 같습니다.

| 도구 | 결과 |
|---|---|
| `agentstoz_use_get_control_profile` | 현재 사용자 프로필, 기억 기준 revision, 갱신 시각과 동기화 상태 |
| `agentstoz_use_recall_control_context` | 질의와 관련된 운영 기억 최대 8개·16 KiB |
| `agentstoz_use_propose_control_memory` | 운영 기억 저장 후보. 실제 저장 완료가 아님 |

후보는 프로필 화면에서 내용·근거를 검토하고 저장합니다. 로컬 저장과 원격 백업 결과는 따로 표시합니다.
AI 작업의 AgentsToZ 기본 관제와 cs-ceo 전략은 같은 운영 기억을 읽습니다. 구현 작업에는 해당 프로젝트의 기억을 함께 사용합니다.
이 기능은 지원 AI가 전달하는 음성/텍스트 요청을 받습니다. 항상 켜진 마이크나 모든 AI 서비스의 자동 도구 지원을 뜻하지 않습니다.

## 저장과 재시작

- `control-profile/binding.json`: 고정 프로필/기억 ID와 이 사용자에 해당하는 로컬 위치.
- `control-profile/access.json`: 해당 OS 사용자만 읽는 로컬 MCP 연결 키. 응답 DTO나 공개 소스에 포함하지 않습니다.
- `control-profile/proposals.json`: 검토 후보와 처리 결과. request ID와 기억 revision으로 중복·충돌을 확인합니다.
- 기존 Control의 `.agentstoz-control-profile.json`: 토큰 없는 공유 정체성 표식.
- 명시적인 Control 연결 전환은 기존 바인딩과 기억을 보존합니다. 기록된 전환을 재시작 후 이어가며 임의의 새 기억/키를 생성하지 않습니다.

원격 백업이 설정된 운영 기억은 시작·수동 연결 재확인·MCP 프로필 조회에서 기존 Pull/충돌 처리를 사용합니다.
MCP 조회에 따른 원격 대조는 60초 이내 재사용하고 동시에 들어온 요청은 하나로 처리합니다. 별도 AI 호출이나 상시 폴링은 없습니다.
오프라인/충돌에서는 마지막 로컬 기억을 유지하고 동기화 확인 필요를 표시합니다. 상태 조회만으로 기억 후보를 저장하지 않습니다.

실제 앱 배포 서명, TestFlight 설치, 다른 물리 Mac, 네 AI의 모델 호출 결과는 각각 별도 검증 대상입니다.
구현 및 검증 기록은 [실행 기록](plans/app-first-onboarding-2026-09-13/CONTROL-PROFILE-EXECUTION.md)을 참조하세요.
