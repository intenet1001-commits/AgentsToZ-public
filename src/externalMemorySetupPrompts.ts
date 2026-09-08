/**
 * 이 앱이 설치되지 않은 환경에 같은 장기기억 구조를 만들게 하는 복사 프롬프트.
 *
 * 프로젝트 하나에 매이지 않는다 — 받는 쪽 에이전트가 자기 PROJECT_ROOT 를 스스로 구하므로,
 * 어떤 프로젝트를 고르든 문자열이 같다. 그래서 프로젝트 상세 패널이 아니라 장기기억 탭의
 * 「다른 환경에 설치·연결」 한 곳에서만 제공한다 (VOC 2026-08-28: 프로젝트마다 같은 버튼이
 * 뜨는 바람에 무엇이 프로젝트 단위이고 무엇이 환경 단위인지 구분되지 않았다).
 */
import { CURRENT_PROJECT_MEMORY_VERSION, standaloneMemoryVersionMarker } from './projectMemoryVersion';
import { SHARED_OUTPUT_STYLE_PROMPT } from './agentOutputStyle';
import { MODEL_EFFORT_ADVICE_POLICY } from './modelEffortAdvicePolicy';

// 버전은 '프로젝트 장기기억' 기능 전체가 하나로 쓴다 (src/projectMemoryVersion.ts).
// 앱이 설치하는 스킬·훅과 이 복사 프롬프트가 같은 번호를 공유하므로, 기능을 개선해 번호를
// 올리면 앱 없는 PC용 프롬프트도 같이 새 버전이 된다.
export const STANDALONE_MEMORY_PROMPT_VERSION = CURRENT_PROJECT_MEMORY_VERSION;
export const STANDALONE_MEMORY_PROMPT_MARKER = standaloneMemoryVersionMarker();

const manualInitPrompt = [
  'AgentsToZ_byCS 프로젝트 장기기억을 이 폴더에 새로 설정해줘.',
  '1. 프로젝트 루트를 구해: PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)" (Windows PowerShell은 $PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }).',
  '2. 아래 API를 호출해 초기화해 (macOS/Linux/Git Bash는 curl, Windows PowerShell은 curl.exe 사용):',
  '   curl -fsS -X POST http://127.0.0.1:3001/api/project-memory/init -H "Content-Type: application/json" -d "{\\"folderPath\\":\\"$PROJECT_ROOT\\",\\"projectName\\":\\"$(basename \\"$PROJECT_ROOT\\")\\",\\"agent\\":\\"claude\\",\\"autoBackup\\":true}"',
  '3. 응답에서 .agent-memory/CORE.md가 생성됐는지 확인하고 결과를 요약해줘.',
  '(AgentsToZ_byCS 앱의 로컬 API 서버가 http://127.0.0.1:3001 에서 실행 중이어야 합니다. 실행 중이 아니면 앱을 먼저 열어달라고 알려줘.)',
].join('\n');

// 이 앱을 모르는 PC용. 외부 앱/서버 참조 없이, 파일만으로 같은 구조 + /remember-session 실행 경로를 만든다.
const standaloneInitPrompt = [
  '이 폴더에 프로젝트 장기기억(long-term memory)을 만들어줘. 외부 앱이나 서버, 네트워크는 쓰지 않고 이 저장소 안의 파일만으로 동작해야 한다.',
  '저장 실행은 앞으로 `/remember-session` 하나로 처리되게 만든다.',
  `이 설정 절차의 버전은 ${STANDALONE_MEMORY_PROMPT_VERSION} 이다. 마커 문자열: ${STANDALONE_MEMORY_PROMPT_MARKER}`,
  '',
  '0. 프로젝트 루트: PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
  '   (Windows PowerShell: $PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path })',
  '   먼저 설치 버전을 확인한다: .agent-memory/config.json 의 memoryVersion 과',
  '   .claude/skills/remember-session/SKILL.md 안의 project-memory 마커를 읽는다.',
  '   버전이 같아도 ID 완전성 검증을 한다: fenced code 밖의 모든 실제 ### 항목 바로 뒤에',
  '   유효한 24자리 소문자 16진수 memory-entry-id가 하나씩 있고 전체에서 고유한지 센다.',
  '     - 아무것도 없으면: 신규 설치. 아래를 전부 만든다.',
  `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 보다 낮거나 ID 검증이 불완전하면: 아래 순서로 1회 업그레이드한다.`,
  '       (a) 수정 전에 .agent-memory/backups/standalone-v<이전버전>-<UTC시각>/ 디렉터리를 만들고',
  '           config.json, CORE.md, notes/ 전체, manifest.json, 기존 remember-session 스킬을 바이트 그대로 백업한다.',
  '           journal/ 은 append-only 원본이므로 수정하거나 백업본으로 덮어쓰지 않는다.',
  '       (b) 기존의 유효하고 고유한 ID는 보존한다. 누락된 항목에만 새 ID를 넣고, 복사된 중복 ID는 첫 항목만 보존해 나머지만 새 ID로 교체한다.',
  '           제목·섹션·본문의 사용자 내용은 바꾸지 않는다.',
  '       (c) manifest.json 의 entries·bytes와 CORE.md 색인을 노트에서 다시 생성하되, 변경할 각 파일은 원본을 건드리지 않고 같은 디렉터리의 임시 파일에 먼저 쓴다.',
  '       (d) 임시 파일들로 구성한 staged 문서에서 모든 실제 ### 항목 수와 유효하고 고유한 memory-entry-id 수가 같은지 검증하고, manifest 순서로 재구성한 문서가 모든 기존 본문을 포함하는지 확인한다.',
  '       (e) 검증 성공 후 본문·색인·manifest 임시 파일을 원자적 rename으로 교체하고, config.json과 스킬 버전 마커 파일은 마지막에 교체한다.',
  `           검증이 모두 성공한 마지막 단계에서만 memoryVersion·promptVersion과 스킬 마커를 ${STANDALONE_MEMORY_PROMPT_VERSION} 으로 올린다.`,
  '           어느 rename이나 검증이 실패하면 백업에서 원상 복구하고 버전 마커를 올리지 않는다. 남은 임시 파일을 지우고 무엇을 복구했는지 보고한다.',
  '       (버전이 건너뛰어 올라갔을 수 있다. 중간 단계를 찾지 말고 위 절차로 현재 버전에 맞춘다.)',
  `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 이고 ID 검증도 완전하면: 이미 최신이다. 파일을 고치지 말고 그 사실만 보고한다.`,
  `     - 설치 버전이 ${STANDALONE_MEMORY_PROMPT_VERSION} 보다 높으면: 다운그레이드하지 말고 그대로 두고 알린다.`,
  '',
  '1. 저장소 구조 (모두 PROJECT_ROOT 기준)',
  '   .agent-memory/config.json',
  `     {"schemaVersion":1,"memoryVersion":${STANDALONE_MEMORY_PROMPT_VERSION},"sourcePath":".agent-memory/CORE.md","lastRememberedAt":null,"lastRememberedHead":null}`,
  '   .agent-memory/notes/00-header.md — 프로젝트명·생성일 + "지속되는 결정만 담는다"는 머리말',
  '   .agent-memory/notes/01-project-identity.md, 02-key-decisions.md, 03-strategic-patterns.md,',
  '   04-recurring-issues.md, 05-active-constraints.md, 06-contested-entries.md',
  '     — 각 노트는 "## <섹션명>" 으로 시작하고, 항목은 "### <항목 제목>" 으로 쓴다. 처음엔 비어 있어도 된다.',
  '       각 항목 제목 바로 다음 줄에 <!-- memory-entry-id:<24자리 소문자 16진수> --> 를 둔다.',
  '   .agent-memory/notes/manifest.json',
  '     {"version":1,"parts":[{"file":"00-header.md","title":null,"entries":[],"bytes":0}, ...]} — parts 순서가 문서의 정본 순서다',
  '   .agent-memory/CORE.md — 생성물. 머리말 + 목차(섹션마다 노트 경로·항목 수·크기·항목 제목 목록)',
  '   .agent-memory/journal/<YYYY-MM>.md — append-only 세션 일지',
  '   .agent-memory/.gitignore — backups/ 와 *.tmp-* 만 제외. journal/ 과 notes/ 는 커밋한다.',
  '',
  '2. 지켜야 할 규칙 (이 규칙들을 아래 3번 스킬 본문에도 그대로 적는다)',
  '   - 에이전트는 평소 CORE.md(색인)만 읽고, 필요한 섹션의 노트 하나만 열어 읽는다.',
  '   - CORE.md 는 노트에서 다시 생성되는 색인이다. 손으로 고치지 말고 노트를 고친 뒤 색인을 재생성한다.',
  '   - manifest.json 의 parts 를 순서대로 이어 붙이면 전체 문서가 된다. 노트 파일을 지우거나 순서를 바꾸면 manifest 도 같이 고친다.',
  '   - 기존 memory-entry-id 는 제목을 바꾸거나 섹션을 옮겨도 보존한다. 관계없는 새 항목만 새 ID를 쓴다.',
  '   - 노트 하나는 12,000바이트를 넘기지 않는다. 넘치면 그 노트 안에서 오래된 항목을 통합·압축한다.',
  '     대체된 결정은 그것을 대체한 항목 안으로 합치되, 지속되는 결정을 통째로 지우지는 않는다.',
  '   - 비밀키·토큰·환경값·원본 대화 로그·임시 상태는 넣지 않는다. 기존 결정과 모순되는 내용은 Contested Entries 에 남긴다.',
  '',
  '3. 실행 경로: `/remember-session` 스킬을 만든다.',
  '   .claude/skills/remember-session/SKILL.md 를 만들고, frontmatter 에',
  '     name: remember-session',
  '     description: 이 프로젝트의 지속되는 결정·패턴을 .agent-memory 에 저장한다. "세션 기억하기", "작업 내용 기억해줘", "세션 종료" 에도 사용.',
  `   frontmatter 바로 아래 첫 줄에 버전 마커를 그대로 적는다: ${STANDALONE_MEMORY_PROMPT_MARKER}`,
  '   (이 마커가 설치 버전의 정본이다. 나중에 같은 설정 프롬프트를 다시 받았을 때 갱신이 필요한지 이 줄로 판단한다.)',
  '   본문에는 아래 절차를 적는다.',
  '     (1) PROJECT_ROOT 를 구하고 .agent-memory/config.json 과 CORE.md 색인을 읽는다.',
  '     (2) 이번 세션 대화 + `git status --short`, `git diff --stat`, `git log`(config 의 lastRememberedHead 이후)를 근거로 삼는다.',
  '     (3) 지속되는 것만 해당 노트에 반영한다: 결정과 근거 / 안정적인 제약 / 원인과 우회법이 있는 반복 이슈 / 검증된 이 프로젝트 전용 절차.',
  '         변경 파일 목록 같은 일회성 내용은 노트에 넣지 않는다.',
  '     (4) manifest.json 의 entries·bytes 를 갱신하고 CORE.md 색인을 재생성한다.',
  '     (5) journal/<YYYY-MM>.md 에 "## <UTC 시각> · <에이전트> · <HEAD 짧은 해시>" 항목을 append 한다.',
  '         첫 줄에는 이번 세션에서 배우거나 정한 것을 사용자 언어로 한두 문장 쓴다(파일 목록이 아니라).',
  '     (6) config.json 의 lastRememberedAt(현재 UTC)과 lastRememberedHead(현재 HEAD)를 갱신한다.',
  '     (7) 저장한 섹션과 각 노트 크기를 보고한다.',
  '   Codex 등 다른 CLI 를 쓰면 같은 내용을 그 도구의 프롬프트/커맨드 위치에도 같이 둔다.',
  '',
  '4. 에이전트가 이 기억을 실제로 읽고 같은 응답 형식을 쓰게 만든다.',
  '   AGENTS.md와 CLAUDE.md 모두에 짧은 장기기억 절을 추가한다: 중요한 작업 전에 .agent-memory/CORE.md 색인을 읽고 관련 노트만 열 것,',
  '   사용자가 세션을 기억해 달라고 하면 `/remember-session` 절차를 따를 것. 이미 같은 절이 있으면 새로 만들지 말고 그 안을 갱신한다.',
  '   아래 모델·추론 권유 규칙도 프로젝트 지침의 장기기억 절에 넣는다. 기존 작업 문맥만 사용하며 추가 AI 호출·자동 모델 변경은 하지 않는다.',
  MODEL_EFFORT_ADVICE_POLICY,
  '   아래 공통 응답 규칙을 AGENTS.md와 CLAUDE.md에 표시 마커와 함께 추가하고, Antigravity용',
  '   .agents/rules/agentstoz-output-style.md에도 같은 원문을 저장한다. 기존 사용자 지침은 보존하고 같은 마커 블록만 멱등 교체한다.',
  '   Hermes가 설치된 환경이면 $HERMES_HOME/SOUL.md(기본 ~/.hermes/SOUL.md)에도 같은 마커 블록을 추가하되 기존 persona는 보존한다.',
  '   시작 마커: <!-- AgentsToZ shared-output-style:start -->',
  SHARED_OUTPUT_STYLE_PROMPT,
  '   끝 마커: <!-- AgentsToZ shared-output-style:end -->',
  '',
  `5. 끝나면 설치/업그레이드 여부와 설치 버전(${STANDALONE_MEMORY_PROMPT_VERSION}), 만든 파일 목록과 각 노트 크기를 표로 요약하고,`,
  '   `/remember-session` 을 어떻게 쓰는지 한 줄로 알려줘.',
].join('\n');

/** 이 PC의 다른 폴더 — 앱의 로컬 API(3001)를 그대로 쓴다. */
export function buildManualInitPrompt(): string {
  return manualInitPrompt;
}

/** 앱도 로컬 API도 없는 PC — 파일만으로 같은 구조를 만든다. */
export function buildStandaloneInitPrompt(): string {
  return standaloneInitPrompt;
}
