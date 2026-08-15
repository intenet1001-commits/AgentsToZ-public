# AgentsToZ_byCS 프로젝트 장기기억 프롬프트 안내

> 작성 기준: 2026-08-04  
> 장기기억 에이전트 버전: v4

이 문서는 AgentsToZ_byCS의 **프로젝트 장기기억** 기능이 어떤 자료를 읽고,
Claude 또는 Codex에 어떤 지침을 전달하며, 로컬 기억과 Supabase 백업을 어떻게
관리하는지 공유하기 위한 기술 안내서입니다.

## 핵심 구조

- 프로젝트별 장기기억 원본: `.agent-memory/CORE.md`
- 프로젝트별 설정: `.agent-memory/config.json`
- 로컬 파일이 기억의 원본이며 Supabase는 리비전 백업 용도입니다.
- Claude와 Codex는 서로 다른 저장소를 사용하지 않고 동일한 `CORE.md`를 읽고 씁니다.
- 앱에서 선택한 `세션 기억 실행 AI`에 따라 Claude 또는 Codex가 같은 갱신 프롬프트를 실행합니다.
- Supabase 백업에 실패해도 성공한 로컬 기억 갱신은 되돌리지 않습니다.

## 앱의 `세션 기억하기`가 사용하는 실제 프롬프트

다음 프롬프트 뒤에 동적으로 수집된 `PROJECT CONTEXT`가 붙습니다.

```text
You maintain a project's curated long-term memory.

Return the COMPLETE updated Markdown file only, starting with "# Project Core Memory".
Preserve existing durable decisions and dates. Add only facts supported by the supplied project
context: architectural/product decisions, repeated issues with root causes, stable constraints,
and validated workflows. Do not store secrets, credentials, environment values, raw chat logs,
temporary status, or speculative claims. If evidence contradicts an existing entry, keep both
under Contested Entries. Update the Last Updated date to today.

PROJECT CONTEXT:
${context}
```

### 프롬프트의 의미

AI는 기존 장기기억을 유지하면서 다음과 같은 장기적으로 유효한 정보만 추가합니다.

- 아키텍처 및 제품 결정과 그 근거
- 반복적으로 발생한 문제, 확인된 원인과 해결책
- 안정적으로 유지되어야 하는 기술·제품·보안·작업 제약
- 실제로 검증된 프로젝트별 작업 절차

다음 정보는 저장하지 않도록 명시되어 있습니다.

- 비밀번호, API 키, 토큰 등 비밀정보
- 환경변수 값과 자격증명
- 원본 채팅 로그
- 일시적인 작업 상태
- 근거 없는 추측

새로운 근거가 기존 기억과 충돌하면 기존 기록을 임의로 삭제하지 않고
`Contested Entries` 영역에 양쪽 내용을 함께 보존합니다.

## AI에 제공되는 프로젝트 컨텍스트

앱은 현재 프로젝트와 연결 워크트리에서 다음 자료를 수집하여 프롬프트에 붙입니다.

1. 프로젝트 최상위 파일·폴더 목록(최대 80개)
2. `README.md` 내용(최대 8,000자)
3. `AGENTS.md` 내용(최대 8,000자)
4. `CLAUDE.md` 내용(최대 8,000자)
5. `package.json` 내용(최대 4,000자)
6. 최근 Git 커밋 12개
7. 커밋되지 않은 변경 통계
8. 커밋되지 않은 diff(최대 12,000자)
9. 연결된 Git 워크트리의 경로, 브랜치, HEAD, 최근 로그, 상태와 diff
10. 현재 `.agent-memory/CORE.md` 전체 내용

워크트리별 diff는 크기를 제한하여 전달하므로 장기기억 갱신이 지나치게 큰 입력으로
확장되지 않도록 되어 있습니다.

## Claude와 Codex 실행 방식

두 AI 모두 동일한 프롬프트와 동일한 프로젝트 기억 파일을 사용합니다.

### Claude 선택 시

```text
claude --safe-mode -p --no-session-persistence <prompt>
```

- 비대화형으로 한 번 실행됩니다.
- 별도의 Claude 대화 세션을 저장하지 않습니다.
- 실행 제한 시간은 180초입니다.

### Codex 선택 시

```text
codex exec -C <project-root> --sandbox read-only --ephemeral \
  --skip-git-repo-check -o <temporary-output-path> <prompt>
```

- 읽기 전용 샌드박스와 임시 세션으로 실행됩니다.
- AI 출력은 임시 파일로 받은 다음 검증 후 삭제합니다.
- 실행 제한 시간은 180초입니다.

AI 응답은 반드시 `# Project Core Memory`로 시작해야 합니다. 형식이 맞지 않거나
결과가 1MB를 초과하면 현재 기억을 교체하지 않고 오류로 처리합니다. 정상 응답일 때도
기존 기억을 먼저 `.agent-memory/backups/`에 백업한 뒤 새 파일을 기록합니다.

## 채팅에서 `세션 기억하기`를 실행할 때

프로젝트 장기기억을 초기화하면 Claude와 Codex용 `remember-session` 로컬 스킬도
함께 만들어집니다.

- Claude: `/remember-session`
- Codex: `$remember-session`
- 공통 자연어: `세션 기억하기`

이 스킬은 에이전트에게 다음 순서로 작업하도록 지시합니다.

1. Git 기준으로 메인 프로젝트 루트를 찾습니다.
2. `.agent-memory/config.json`과 설정된 `sourcePath`의 기억 파일을 읽습니다.
3. 현재 대화 맥락과 `git status --short`, `git diff --stat`, `git diff`,
   `git log -10`을 검토합니다.
4. 변경이 있는 연결 워크트리도 함께 검토합니다.
5. 영구적으로 유효한 결정·제약·반복 문제·검증된 작업법만 기억에 반영합니다.
6. 로컬 파일을 안전하게 저장한 후 현재 활동을 `기억 완료` 상태로 표시합니다.
7. Supabase에 최신 로컬 기억을 Push합니다.
8. 로컬 저장 결과와 Supabase 백업 결과를 별도로 보고합니다.

앱 버튼과 채팅 명령의 중요한 차이는 다음과 같습니다.

- **앱 버튼:** 프로젝트 파일과 Git·워크트리 상태를 비대화형 AI에 전달합니다.
- **채팅 명령:** 실행 중인 에이전트가 현재 대화 맥락도 함께 검토할 수 있습니다.

두 방식 모두 최종적으로 동일한 프로젝트 로컬 기억 파일을 관리합니다.

## `지금부터 장기기억 시작` 버튼

이 버튼 자체는 AI를 호출하지 않습니다. 다음 구조의 초기 `CORE.md`와 설정·로컬
스킬·활동 감지 훅을 생성합니다.

```markdown
# Project Core Memory

**Project**: 프로젝트 이름
**Created**: YYYY-MM-DD
**Last Updated**: YYYY-MM-DD

## Project Identity

## Key Decisions

## Strategic Patterns

## Recurring Issues

## Active Constraints

## Contested Entries
```

처음 `세션 기억하기`를 실행할 때 실제 프로젝트 자료를 바탕으로 이 문서가 채워집니다.

## 활동 감지와 토큰 사용

Claude/Codex의 `UserPromptSubmit` 활동 훅은 프롬프트 본문을 저장하지 않고 버립니다.
훅이 기록하는 값은 다음 두 가지뿐입니다.

- 마지막 활동 시각
- 사용 AI 종류(`claude` 또는 `codex`)

따라서 활동 감지 훅 자체는 AI를 호출하지 않으며 토큰을 사용하지 않습니다. 앱은 이
활동 정보와 메인 프로젝트·연결 워크트리의 Git 활동 지문을 비교해
`세션 기억하기 필요` 상태를 표시합니다. 실제 AI 호출은 사용자가 `세션 기억하기`
버튼이나 명령을 실행할 때 한 번 발생합니다.

## 저장 및 백업 순서

```text
프로젝트/Git/워크트리 자료 수집
        ↓
선택한 Claude 또는 Codex로 기억 문서 생성
        ↓
AI 응답 형식·크기 검증
        ↓
기존 CORE.md 로컬 백업
        ↓
새 CORE.md 저장
        ↓
현재 활동을 기억 완료로 표시
        ↓
자동 백업이 켜져 있으면 Supabase에 새 리비전 Push
```

Supabase Push 실패는 로컬 기억 갱신을 취소하지 않습니다. 사용자는 앱의 Push 버튼으로
나중에 다시 백업할 수 있습니다.

## 구현 위치

- 핵심 프롬프트 및 컨텍스트 조립: `project-memory-server.ts`
- 장기기억 API 라우팅: `api-server.ts`
- 앱 UI와 실행 버튼: `src/ProjectMemoryPanel.tsx`
- 프로젝트 기억 원본: 각 프로젝트의 `.agent-memory/CORE.md`
- Claude 로컬 스킬: `.claude/skills/project-memory/`, `.claude/skills/remember-session/`
- Codex 로컬 스킬: `.agents/skills/project-memory/`, `.agents/skills/remember-session/`

