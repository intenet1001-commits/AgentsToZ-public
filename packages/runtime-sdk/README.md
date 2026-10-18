# AgentsToZ Runtime SDK 0.4.0

기존 AgentsToZ 런타임을 다른 Bun 앱에서도 재사용하기 위한 비공개 SDK입니다.
Codex app-server 어댑터, 작업·지속 대화 서비스, SQLite journal, 실행 파일 검증과 브라우저/Tauri 클라이언트를 제공합니다.

## 앱에서 사용

호스트는 `@agentstoz/runtime-sdk`, UI는 `@agentstoz/runtime-sdk/client`를 가져옵니다.
`createAgentRuntimeService` / `AgentRuntimeConversationService`에 등록 프로젝트 해석기,
실행 파일 검증기, workspace lease, journal과 실행 조건을 주입합니다.
프로젝트 경로나 자격증명을 브라우저에 전달하지 않습니다.

```ts
import { createAgentRuntimeService, RUNTIME_SDK_VERSION } from '@agentstoz/runtime-sdk';
// dependencies는 기존 앱 호스트와 동일한 등록·권한·저장 경계를 구현해야 합니다.
const service = createAgentRuntimeService(dependencies);
```

`dependencies`는 사용 앱이 제공해야 하는 예시 자리표시자입니다. SDK를 import하는 것만으로 실행을 허용하지 않습니다.
`runCodexAgentTask` 같은 저수준 export를 UI 요청에 직접 연결하지 말고 호스트 서비스를 거쳐 사용합니다.
CLI 계정·API 키·사용자 대화·로컬 DB는 배포물에 포함하지 않습니다. 로그인과 CLI 설치는 소비 앱의 실행 단말에서 준비합니다.

## 프롬프트 복사 기능에 적용

버튼에서 생성한 요청과 등록 프로젝트 ID를 실행 확인 화면에 전달하고, 사용자가 모델과 작업 범위를 선택한 뒤
서비스의 작업 시작 API를 호출합니다. 같은 요청 ID는 유지해 재시도 중복 실행을 막고, journal 이벤트로 진행·완료·실패를 표시합니다.
취소는 기존 프로세스 정리 확인까지 기다립니다. 파일 변경·Git push 등의 실행 조건은 기존 서비스와 동일합니다.
현재 배포본의 managed execution 제한은 SDK 분리로 해제되지 않습니다.

이번 버전은 기존 런타임을 재사용 가능한 경계로 패키징한 버전이며, 복사형 기능의 직접 실행 전환과 속도 개선을 완료한 버전은 아닙니다.
Codex가 현재 구현된 실행 어댑터이며 Claude/Hermes/agy 등록 항목은 지원 완료를 뜻하지 않습니다.

## 버전 및 재현

원본: AgentsToZ_byCS의 `packages/runtime-sdk`와 manifest에 기록된 의존 소스.
앱 저장소에서 `bun run sdk:export -- /절대/출력/폴더`로 내보냅니다.
외부 SDK 폴더는 독립 Git 저장소로 관리하고 해당 릴리스 태그로 고정합니다.
`source-manifest.json`은 기반 Git commit, 소스 파일 SHA-256, SDK 버전을 포함합니다.
호환 API 변경은 major, 기능 추가는 minor, 수정은 patch 버전을 올리고 CHANGELOG를 갱신합니다.
SDK를 다시 빌드하려면 `bun install` 후 `bun run build`를 실행합니다.

## 제품에서 두 실행 방식 구분

- **AI 작업**: 이 SDK가 제공하는 자체 실행기. 짧고 범위가 명확한 앱 기능의 요청·진행·결과 연결에 사용합니다.
- **AI 터미널**: 프로젝트 개발을 위해 앱 내부 PTY에서 공식 Codex CLI·Claude Code·Hermes 등을 실행하는 별도 방식입니다. CLI 자체 화면·설정·기능을 유지합니다.

0.2.0은 `AgentRuntimeQuickLabels`의 도구 없는 짧은 추천 작업과 `AiTerminalService`의 실제 CLI PTY 호스트를 함께 제공합니다. UI와 원격 접근 동의는 호스트 앱이 담당합니다. AI 터미널은 CLI 자체 설정·권한으로 동작하며 관리형 작업의 격리 보장을 뜻하지 않습니다. Claude Code는 터미널로 실행하며 구조화된 Claude SDK 어댑터는 포함하지 않습니다.
모델 품질이나 실행 속도 개선은 아직 측정하지 않았으며 패키지 분리가 성능 향상을 보장하지 않습니다.

## 워크룸 밖의 프로젝트 에포트 관리

`createProjectAgentTerminal({appDataDir, dependencies})`는 워크룸 창 없이 사용하는 CLI 호스트입니다.
등록 프로젝트 해석기·실행 파일 해석기·기기 권한은 호스트가 제공하고, 터미널 화면은 소비 앱이 소유합니다.
AgentsToZ 앱도 같은 생성 경로를 사용합니다. 같은 호스트의 승인된 `appDataDir`를 제공하면 기존
`workroom-effort-auto.json`의 자동선택(기본)·추천제공·미선택을 공유합니다. 다른 호스트의 데이터 경로를
추측하거나 복사하지 않습니다. 설정을 바꾸면 후속 요청부터 다시 읽습니다.

```ts
import {createProjectAgentTerminal, WorkroomConversationJournal} from '@agentstoz/runtime-sdk';
const journal = new WorkroomConversationJournal(appDataDir);
const terminal = createProjectAgentTerminal({appDataDir, dependencies: {
  ...dependencies, // 등록 프로젝트·실행 파일 해석기 등 호스트가 소유한 실행 경계
  submissions: () => journal,
}});
// existing terminal protocol: start -> read -> whole-request submission -> read -> close
// 호스트 종료 시: await terminal.shutdown(); journal.close();
```

Codex·Claude Code·Hermes의 최초 요청과 후속 요청에 기존 세션 전용 제어를 사용합니다.
직접 선택한 강도, 모델·계정, 승인 화면, 작성 중 입력은 기존 CLI 계약대로 보존합니다.
Antigravity처럼 모델 변경과 강도가 결합된 환경은 자동 변경을 지원하지 않습니다.
이 생성기를 쓰지 않은 기존 `AiTerminalService` 소비자의 실행 기본값은 바뀌지 않습니다.

네이티브 앱·플러그인은 `ProjectAgentEffortController`에 등록된 현재 세션의 `resolve`,
검증된 세션 전용 `apply`, 공통 모드를 읽는 `mode`를 연결할 수 있습니다. 매 사용자 요청과
계획·구현·검증 전환 시 기존 작업 문맥으로 `adjust`를 호출합니다. 도구 출력만으로 단계 전환을 추정하거나
별도 AI 평가를 실행하지 않습니다. `apply`는 전달받은 프로젝트·세션·모델·revision을 쓰기 직전에
원자적으로 재검증해야 합니다. 실제 강도를 다시 읽어 일치한 경우에만 `applied`를 반환합니다.

일반 Codex/Claude 앱이나 CLI가 이 호스트 또는 네이티브 제어 어댑터에 연결되어 있어야 실제 변경됩니다.
`AGENTS.md`·`CLAUDE.md` 또는 `UserPromptSubmit`의 추가 문맥만으로는 네이티브 에포트를 바꿀 수 없습니다.
제어 API가 없는 환경은 `unsupported`와 추천을 반환합니다. 이 상태를 자동 적용 완료로 표시하지 않습니다.
정책은 등록·승인 권한을 넓히지 않으며 사용자 프롬프트·인증 정보·추천 이력은 보관하지 않습니다.


## 프로젝트 CLI 계정 (0.4.0)

`PlatformCliStore(appDataDir)`와 `PlatformCliHost({store, executable, resolveProject})`는
GitHub·Vercel·Supabase·Google Workspace의 프로젝트 계정 연결을 공유합니다. `host.run(projectId, provider, argv)`는
기본은 프로젝트의 기존 native 연결·현재 로그인이며, 명시적으로 연결한 계정은 실패 시 다른 로그인으로 대체하지 않습니다. GitHub의 기존 로그인도 복사 없이 선택합니다. 전역 CLI 로그인은 바꾸지 않습니다.
소비 호스트가 명령 실행 권한과 최신 등록 대상을 확인해야 하며, 이 저수준 실행기를 원격 임의 명령 API로 노출하지 않습니다.

`PlatformGithubPush`는 `options → prepare → execute`로 계정·저장소·브랜치·커밋을 검토하고
같은 요청 ID의 중복 전송을 방지합니다. 미확정 영수증을 성공으로 표시하거나 새 요청으로 자동 반복하지 않습니다.
인증은 단말 OS 자격 증명 저장소에 있고 브라우저/모델에는 public metadata만 전달합니다.
이 범용 프로젝트 계정은 AgentsToZ 자체 데이터·동기화용 Supabase와 분리됩니다.
Vercel 팀·프로젝트, Supabase functions의 project ref, Google Workspace 사용자 OAuth를 지원합니다.
Supabase DB 비밀번호 연결과 Windows 실기는 별도 범위입니다.
