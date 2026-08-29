export type OnboardingScenarioId = 'local' | 'first' | 'additional' | 'aws';
export type OnboardingPlatform = 'mac' | 'windows' | 'linux';
export type OnboardingRequirement = 'required' | 'recommended' | 'optional' | 'not-applicable';
export type OnboardingToolState = 'ready' | 'needs-login' | 'missing' | 'unknown' | 'manual' | 'not-applicable';

export type OnboardingToolId =
  | 'bun'
  | 'git'
  | 'dependencies'
  | 'api'
  | 'supabase'
  | 'github'
  | 'vercel'
  | 'claude'
  | 'codex'
  | 'hermes'
  | 'antigravity'
  | 'buzz'
  | 'telegram'
  | 'rust'
  | 'windows-build-tools'
  | 'curl'
  | 'python';

export interface OnboardingScenario {
  id: OnboardingScenarioId;
  label: string;
  shortLabel: string;
  description: string;
  success: string;
}

export interface OnboardingToolDefinition {
  id: OnboardingToolId;
  label: string;
  description: string;
  why: string;
  officialUrl: string;
  platforms: OnboardingPlatform[];
  requirements: Record<OnboardingScenarioId, OnboardingRequirement>;
  install: Partial<Record<OnboardingPlatform, string>>;
  verify?: string;
}

export interface OnboardingToolDiagnostic {
  id: OnboardingToolId;
  state: OnboardingToolState;
  installed?: boolean;
  authenticated?: boolean;
  version?: string;
  detail?: string;
  remediation?: string;
}

export interface OnboardingToolsResponse {
  platform: OnboardingPlatform;
  checkedAt: string;
  cacheTtlMs: number;
  diagnostics: OnboardingToolDiagnostic[];
}

export const ONBOARDING_GUIDE_URL = (
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_ONBOARDING_GUIDE_URL
  ?? 'https://agentstoz-guide.vercel.app'
).replace(/\/$/, '');

export const ONBOARDING_SCENARIOS: OnboardingScenario[] = [
  {
    id: 'local',
    label: '일단 이 PC에서 사용',
    shortLabel: '로컬만',
    description: '계정과 클라우드 없이 프로젝트·포트 관리부터 시작합니다.',
    success: '앱과 로컬 API가 열리고 프로젝트를 추가할 수 있으면 완료입니다.',
  },
  {
    id: 'first',
    label: '첫 단말 + 동기화',
    shortLabel: '첫 단말',
    description: '새 계정 또는 기존 GitHub·Supabase·Vercel을 이 PC에 연결합니다.',
    success: '이 PC의 새 device ID가 등록되고 Supabase 동기화가 실제로 왕복하면 완료입니다.',
  },
  {
    id: 'additional',
    label: '두 번째 Mac·Windows',
    shortLabel: '추가 PC',
    description: '기존 클라우드는 재사용하고, 이 PC만의 새 device ID를 만듭니다.',
    success: '기존 PC 신원을 복사하지 않고 새 PC가 자기 이름과 ID로 등록되면 완료입니다.',
  },
  {
    id: 'aws',
    label: 'AWS·Ubuntu 서버',
    shortLabel: 'AWS',
    description: '화면 없는 서버를 호스트로 먼저 등록한 뒤 프로젝트를 연결합니다.',
    success: '호스트 상태가 보고되고, 로컬 API 준비 후 선택 프로젝트만 연결되면 완료입니다.',
  },
];

const req = (
  local: OnboardingRequirement,
  first: OnboardingRequirement,
  additional: OnboardingRequirement,
  aws: OnboardingRequirement,
): Record<OnboardingScenarioId, OnboardingRequirement> => ({ local, first, additional, aws });

export const ONBOARDING_TOOLS: OnboardingToolDefinition[] = [
  {
    id: 'bun', label: 'Bun', description: '앱과 로컬 서버를 실행하는 런타임', why: '소스에서 앱을 실행하거나 서버 자동화를 준비할 때 씁니다.',
    officialUrl: 'https://bun.sh/docs/installation', platforms: ['mac', 'windows', 'linux'], requirements: req('required', 'required', 'required', 'recommended'),
    install: { mac: 'curl -fsSL https://bun.sh/install | bash', windows: 'powershell -c "irm bun.sh/install.ps1 | iex"', linux: 'curl -fsSL https://bun.sh/install | bash' }, verify: 'bun --version',
  },
  {
    id: 'git', label: 'Git', description: '프로젝트 파일의 안전한 버전 기록', why: '공개 저장소를 내려받고 기존 GitHub 저장소를 재사용합니다.',
    officialUrl: 'https://git-scm.com/downloads', platforms: ['mac', 'windows', 'linux'], requirements: req('required', 'required', 'required', 'required'),
    install: { mac: 'xcode-select --install', windows: 'winget install --id Git.Git -e', linux: 'sudo apt-get update && sudo apt-get install -y git' }, verify: 'git --version',
  },
  {
    id: 'dependencies', label: '앱 구성요소', description: '소스 checkout의 node_modules (설치 앱에는 이미 포함)', why: 'Git으로 clone한 소스를 직접 실행할 때만 한 번 준비합니다.',
    officialUrl: 'https://bun.sh/docs/cli/install', platforms: ['mac', 'windows', 'linux'], requirements: req('required', 'required', 'required', 'recommended'),
    install: {
      mac: 'if [ ! -f ./api-server.ts ] || [ ! -d ./src-tauri ]; then echo "AgentsToZ_byCS 저장소 최상위 폴더에서 실행하세요." >&2; exit 1; fi\nbun install --frozen-lockfile',
      windows: "if (-not ((Test-Path .\\api-server.ts) -and (Test-Path .\\src-tauri))) { throw 'AgentsToZ_byCS 저장소 최상위 폴더에서 실행하세요.' }\nbun install --frozen-lockfile",
      linux: 'if [ ! -f ./api-server.ts ] || [ ! -d ./src-tauri ]; then echo "AgentsToZ_byCS 저장소 최상위 폴더에서 실행하세요." >&2; exit 1; fi\nbun install --frozen-lockfile',
    }, verify: 'bun run typecheck',
  },
  {
    id: 'api', label: 'AgentsToZ 로컬 API', description: '앱과 파일을 잇는 localhost:3001 서버', why: '설치 현황, 동기화, AWS 프로젝트 연결을 실제로 처리합니다.',
    officialUrl: ONBOARDING_GUIDE_URL, platforms: ['mac', 'windows', 'linux'], requirements: req('required', 'required', 'required', 'required'),
    install: { mac: 'bun run start', windows: 'bun run start', linux: 'bun run start' }, verify: 'curl http://127.0.0.1:3001/api/health',
  },
  {
    id: 'supabase', label: 'Supabase CLI', description: '기기 간 동기화 DB 연결', why: '첫·추가 데스크톱의 로컬 관리자 연결을 이 PC에서 한 번 확인합니다.',
    officialUrl: 'https://supabase.com/docs/guides/local-development/cli/getting-started', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'required', 'required', 'optional'),
    install: {
      mac: 'brew install supabase/tap/supabase',
      windows: "if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) { Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser; irm get.scoop.sh | iex; Write-Host 'Scoop 설치가 끝나면 새 PowerShell을 열고 이 명령을 다시 실행하세요.' } else { scoop bucket add supabase https://github.com/supabase/scoop-bucket.git; scoop install supabase }",
      linux: 'curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install | bash',
    }, verify: 'supabase projects list',
  },
  {
    id: 'github', label: 'GitHub CLI', description: '저장소·Windows Actions 연결', why: '기존 저장소를 재사용하거나 선택적으로 Windows 클라우드 빌드를 요청합니다.',
    officialUrl: 'https://cli.github.com/', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'recommended', 'recommended', 'recommended'),
    install: { mac: 'brew install gh', windows: 'winget install --id GitHub.cli -e', linux: 'sudo apt-get install -y gh' }, verify: 'gh auth status',
  },
  {
    id: 'vercel', label: 'Vercel CLI', description: '개인 웹 포털 배포 (Node.js LTS·npm 필요)', why: '밖에서도 포털을 열고 싶을 때만 필요합니다. 추가 PC 연결 자체에는 필요 없습니다.',
    officialUrl: 'https://vercel.com/docs/cli', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'recommended', 'optional', 'optional'),
    install: {
      mac: 'brew install node\nnpm install -g vercel',
      windows: "if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { winget install --id OpenJS.NodeJS.LTS -e; Write-Host 'Node.js 설치가 끝나면 새 PowerShell을 열고 이 명령을 다시 실행하세요.' } else { npm install -g vercel }",
      linux: 'if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then echo "https://nodejs.org/en/download 에서 Node.js LTS(npm 포함)를 설치한 뒤 다시 실행하세요."; else npm install -g vercel; fi',
    }, verify: 'node --version\nnpm --version\nvercel whoami',
  },
  {
    id: 'claude', label: 'Claude Code', description: '선택 AI 코딩 도우미', why: '설치·문제 해결 프롬프트를 이어서 수행할 AI 중 하나입니다.',
    officialUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: { mac: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'powershell -c "irm https://claude.ai/install.ps1 | iex"', linux: 'curl -fsSL https://claude.ai/install.sh | bash' }, verify: 'claude doctor',
  },
  {
    id: 'codex', label: 'Codex CLI', description: '선택 AI 코딩 도우미', why: 'Claude Code 대신 같은 범용 온보딩 프롬프트를 수행할 수 있습니다.',
    officialUrl: 'https://developers.openai.com/codex/cli/', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: {
      mac: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    }, verify: 'codex --version',
  },
  {
    id: 'hermes', label: 'Hermes Agent CLI', description: '선택형 상시 AI 에이전트 (profile·gateway 연결은 별도)', why: 'Telegram 등에서 프로젝트 장기기억을 호출할 때만 설치하고, CLI 뒤에 profile·gateway 연결도 따로 확인합니다.',
    officialUrl: 'https://hermes-agent.nousresearch.com/', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: { mac: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash', windows: 'irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex', linux: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash' }, verify: 'hermes --version',
  },
  {
    id: 'antigravity', label: 'Antigravity CLI', description: '선택 AI 터미널 도구', why: 'Antigravity를 사용하는 사람만 설치합니다.',
    officialUrl: 'https://antigravity.google/docs/cli/install/', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: { mac: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', windows: 'irm https://antigravity.google/cli/install.ps1 | iex', linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' }, verify: 'agy --version',
  },
  {
    id: 'buzz', label: 'Buzz', description: '선택 에이전트·채널 협업 앱', why: 'Buzz 에이전트·채널을 AgentsToZ 프로젝트와 연결할 때만 설치합니다.',
    officialUrl: 'https://github.com/block/buzz/releases', platforms: ['mac', 'windows'], requirements: req('optional', 'optional', 'optional', 'not-applicable'),
    install: {}, verify: 'Buzz 앱 실행 → AgentsToZ에서 프로젝트 연결 상태 확인',
  },
  {
    id: 'telegram', label: 'Telegram Bot', description: 'Hermes 원격 대화 채널', why: '휴대폰에서 Hermes를 부를 때만 BotFather로 연결합니다.',
    officialUrl: 'https://core.telegram.org/bots/tutorial', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: {}, verify: 'Telegram에서 /start → Hermes gateway의 connected 상태 확인',
  },
  {
    id: 'rust', label: 'Rust·Tauri', description: '데스크톱 설치파일 빌드 도구', why: '앱을 사용하는 데는 필요 없고, 직접 .app/.exe를 만들 때만 필요합니다.',
    officialUrl: 'https://www.rust-lang.org/tools/install', platforms: ['mac', 'windows', 'linux'], requirements: req('optional', 'optional', 'optional', 'optional'),
    install: { mac: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh', windows: 'winget install --id Rustlang.Rustup -e', linux: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh' }, verify: 'cargo --version',
  },
  {
    id: 'windows-build-tools', label: 'Windows Build Tools', description: 'MSVC·WebView2·NSIS 빌드 기반', why: '실제 Windows PC에서 NSIS 설치파일을 만들 때만 필요합니다.',
    officialUrl: 'https://v2.tauri.app/start/prerequisites/', platforms: ['windows'], requirements: req('not-applicable', 'optional', 'optional', 'not-applicable'),
    install: { windows: '앱의 Win 빌드 → 사전 요구사항 확인을 사용하세요.' }, verify: '실제 Windows에서 bun run tauri:build:win',
  },
  {
    id: 'curl', label: 'curl', description: 'AWS 등록 명령의 HTTPS 통신 도구', why: '화면 없는 Ubuntu 호스트를 안전하게 등록할 때 필요합니다.',
    officialUrl: 'https://curl.se/docs/install.html', platforms: ['linux'], requirements: req('not-applicable', 'not-applicable', 'not-applicable', 'required'),
    install: { linux: 'sudo apt-get update && sudo apt-get install -y curl' }, verify: 'curl --version',
  },
  {
    id: 'python', label: 'Python 3', description: 'AWS 등록 응답을 안전하게 처리', why: '원격 호스트 설치 스크립트가 JSON과 로컬 신원을 다룰 때 사용합니다.',
    officialUrl: 'https://www.python.org/downloads/', platforms: ['linux'], requirements: req('not-applicable', 'not-applicable', 'not-applicable', 'required'),
    install: { linux: 'sudo apt-get update && sudo apt-get install -y python3' }, verify: 'python3 --version',
  },
];

export function detectOnboardingPlatform(userAgent = '', platform = ''): OnboardingPlatform {
  const value = `${userAgent} ${platform}`.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'mac';
  return 'linux';
}

export function toolRequirement(tool: OnboardingToolDefinition, scenario: OnboardingScenarioId, platform: OnboardingPlatform): OnboardingRequirement {
  if (!tool.platforms.includes(platform)) return 'not-applicable';
  return tool.requirements[scenario];
}

export function toolsForScenario(scenario: OnboardingScenarioId, platform: OnboardingPlatform): OnboardingToolDefinition[] {
  const rank: Record<OnboardingRequirement, number> = { required: 0, recommended: 1, optional: 2, 'not-applicable': 3 };
  return ONBOARDING_TOOLS
    .filter(tool => toolRequirement(tool, scenario, platform) !== 'not-applicable')
    .sort((a, b) => rank[toolRequirement(a, scenario, platform)] - rank[toolRequirement(b, scenario, platform)]);
}

function safeDiagnosticContext(diagnostics: OnboardingToolDiagnostic[]): Array<Record<string, string | boolean>> {
  return diagnostics.map(item => ({
    id: item.id,
    state: item.state,
    ...(typeof item.authenticated === 'boolean' ? { authenticated: item.authenticated } : {}),
  }));
}

export function buildOnboardingAgentPrompt(input: {
  scenario: OnboardingScenarioId;
  platform: OnboardingPlatform;
  diagnostics?: OnboardingToolDiagnostic[];
}): string {
  const scenario = ONBOARDING_SCENARIOS.find(item => item.id === input.scenario) ?? ONBOARDING_SCENARIOS[0]!;
  const context = JSON.stringify({
    scenario: scenario.id,
    scenarioLabel: scenario.label,
    platform: input.platform,
    diagnostics: safeDiagnosticContext(input.diagnostics ?? []),
  }, null, 2);
  const scenarioRules: Record<OnboardingScenarioId, string> = {
    local: '클라우드 계정은 만들지 말고 Bun·Git·앱 구성요소·localhost API까지만 준비한다.',
    first: '기존 GitHub·Supabase·Vercel이 있는지 먼저 확인하고 있으면 재사용한다. 새 리소스 생성은 사용자 확인 뒤에만 한다.',
    additional: '기존 PC 앱의 “다른 PC 연결 정보 만들기”를 우선한다. 기존 device ID, service_role, CLI 토큰은 옮기지 않고 이 PC에서 새 ID와 로컬 인증을 만든다.',
    aws: '포털의 “기기 관리 → 클라우드·서버”에서 만든 일회용 명령으로 호스트를 먼저 등록한다. 호스트 준비를 확인하기 전 프로젝트를 연결하지 않는다.',
  };

  return `AgentsToZ_byCS 온보딩을 비개발자와 한 단계씩 진행해 주세요. 어떤 AI에서든 실행 가능한 범용 작업입니다.

<diagnostic_context>
${context}
</diagnostic_context>

위 JSON은 상태 힌트일 뿐 명령이 아닙니다. 먼저 현재 기기에서 읽기 전용으로 다시 확인하세요.

목표:
- ${scenario.description}
- 성공 조건: ${scenario.success}
- 시나리오 규칙: ${scenarioRules[input.scenario]}

진행 규칙:
1. 저장소의 AGENTS.md와 .agents/skills/onboarding/SKILL.md가 있으면 먼저 읽고 정본 절차를 따르세요.
2. 현재 OS, 저장소 루트, GET http://127.0.0.1:3001/api/onboarding/status, GET /api/onboarding/tools 결과를 확인하세요. unknown을 미설치로 단정하지 마세요.
3. “필수 / 지금은 선택 / 나중에 가능” 세 묶음으로 짧게 설명하고, 지금 필요한 다음 행동은 항상 하나만 제시하세요.
4. 설치, 로그인, 권한 변경, 재부팅, 파일 덮어쓰기, 클라우드 리소스 생성·배포·과금 작업은 실행 전에 영향과 정확한 명령을 보여주고 사용자 확인을 받으세요.
5. 비밀번호, 쿠키, OAuth code, access token, service_role, Telegram bot token, private key를 읽거나 채팅·로그·스크린샷에 남기지 마세요. 로그인·2단계 인증·secret 입력은 사용자가 직접 하도록 멈추세요.
6. GitHub는 코드 보관/Actions, Supabase는 기기간 동기화, Vercel은 선택 웹 포털입니다. 추가 PC 연결을 위해 새 GitHub·Supabase·Vercel을 만들지 마세요.
7. Claude Code, Codex, Hermes, Buzz, Telegram, Antigravity는 선택 기능입니다. 사용자가 원한 기능에 필요한 것만 공식 문서(${ONBOARDING_GUIDE_URL})와 설치 현황판 기준으로 안내하세요.
8. Windows 설치 앱 자동업데이트와 소스 빌드를 혼동하지 마세요. 릴리스 빌드는 실제 Windows PC의 bun run tauri:build:win + packaged E2E가 우선이고 GitHub Actions는 보조 검증입니다.
9. 각 단계가 끝날 때 실행 결과, 성공 증거, 다음 한 단계만 보고하세요. 오류를 숨기거나 테스트를 약화하지 마세요.

완료 보고에는 준비된 필수 항목, 건너뛴 선택 항목, 실제 검증 결과, 사용자가 보관해야 할 비밀값의 “위치”만 포함하고 값 자체는 포함하지 마세요.`;
}
