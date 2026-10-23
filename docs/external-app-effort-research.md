# 외부 앱 에포트 조사 · 2026-10-19

사용자 확정: **CLI는 자동(기본)·추천·OFF, 외부 앱은 추천(기본)·OFF**.
장기기억·공통 지침을 읽는 앱의 활성 에이전트가 이미 가진 작업 맥락으로 추천한다.
자동 변경이 기술적으로 가능한 앱도 이 제품 정책에서는 추천만 제공한다.

| 실행 표면 | 확인한 제어 | 채택 범위 |
|---|---|---|
| Codex Desktop | 공식 App Server는 thread/turn별 설정 제어를 제공한다. 설치 CLI 0.163의 별도 daemon은 현재 Desktop 채팅을 소유하지 않았고, 앱 tools pipe는 일반 App Server 프록시가 아니었다. | 프로젝트 AGENTS.md·project-memory·기기 공통 지침을 통한 추천·OFF |
| Claude Desktop | 설치 앱 내부에는 세션별 setEffort가 있지만 외부 연결 계약은 확인되지 않았다. Claude Code의 UserPromptSubmit은 문맥 주입이며 설정 변경 API가 아니다. Chat·Cowork·Code는 같은 표면으로 추정하지 않는다. | 해당 모드가 프로젝트 지침·기억을 읽은 경우 추천·OFF |
| Antigravity | PreInvocation은 문맥 step 주입을 제공한다. CLI /effort는 기본 설정도 저장하며 model variant와 결합될 수 있다. | GEMINI.md·workspace rule·프로젝트 기억을 통한 추천·OFF |
| Hermes Desktop | 공식 Desktop은 hermes serve와 같은 core를 사용한다. llm_request 미들웨어는 요청 변경을 지원한다. pre_llm_call은 문맥용이고 pre_api_request 반환은 설정 제어가 아니다. Codex app-server 경로에는 별도 실행 분기가 있다. | SOUL.md·프로젝트 기억을 통한 추천·OFF. 자동 변경 플러그인은 설치하지 않음 |

설치된 앱 코드는 읽기 전용으로 조사했다. 비공개 IPC를 호출하거나 daemon에 Desktop 채팅을
resume하지 않았고, 전역 provider/model/effort 기본값·rollout·계정·다른 세션을 바꾸지 않았다.
기억을 읽지 못하는 앱, 파일·연결 도구가 없는 대화에는 규칙 전달이나 OFF의 즉시 반영을 보장하지 않는다.
이미 열린 대화는 새 지침을 다시 읽어야 할 수 있다. 이는 모든 앱을 감시하는 전역 자동 제어기가 아니다.

## 설정 전달

- 실행 도구에 CLI와 앱을 구분하여 표시한다. 앱에는 자동 선택지를 제공하지 않는다.
- CLI의 `workroom-effort-auto.json`과 앱의 `desktop-effort-advice.json`을 독립적으로 원자 저장한다.
- 공통 지침·프로젝트 장기기억 스킬에 같은 표면별 규칙을 제공한다. 일반 회상 응답은 해당 실행
  호스트의 두 모드를 `includeEffortAdvice: true` 요청 시에만 읽기 전용으로 포함하여 기존 응답을 보존한다.
  추천 때문에 별도 AI·감시 루프·대화 복사본을 만들지 않는다.
- SDK desktop host는 네이티브 제어가 있더라도 추천만 반환한다. OFF는 추천도 반환하지 않는다.

## 공식 근거

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): 세션과 턴의 소유 및 설정 계약.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks), [모델·에포트 설정](https://code.claude.com/docs/en/model-config): 훅 문맥과 실제 설정 조작의 구분.
- [Antigravity hooks](https://antigravity.google/docs/hooks/), [CLI effort 명령](https://antigravity.google/docs/cli/commands/effort/): PreInvocation 반환 및 설정 수명.
- [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), [공식 플러그인](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins): 공통 런타임·미들웨어와 observer hook의 차이.

테스트는 표면별 기본값·독립 저장·앱 auto 거부·원격 쓰기 거부·SDK 무변경·UI 확인 응답·기존
지침/기억 보존을 검증한다. 실제 앱에서 AI가 매번 추천을 따르는지와 공급자 응답은 이 회귀검사의
통과 범위로 주장하지 않는다.
