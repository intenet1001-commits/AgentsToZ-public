import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ONBOARDING_GUIDE_URL,
  ONBOARDING_SCENARIOS,
  ONBOARDING_TOOLS,
  buildOnboardingAgentPrompt,
  toolRequirement,
  toolsForScenario,
} from '../src/onboardingInfrastructure';

const root = join(import.meta.dir, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('onboarding infrastructure center', () => {
  test('keeps scenario requirements explicit instead of installing every integration', () => {
    const local = toolsForScenario('local', 'mac');
    expect(local.find(tool => tool.id === 'bun')).toBeDefined();
    expect(toolRequirement(local.find(tool => tool.id === 'bun')!, 'local', 'mac')).toBe('required');
    expect(toolRequirement(local.find(tool => tool.id === 'github')!, 'local', 'mac')).toBe('optional');
    expect(toolRequirement(local.find(tool => tool.id === 'vercel')!, 'local', 'mac')).toBe('optional');

    const aws = toolsForScenario('aws', 'linux');
    for (const id of ['git', 'api', 'curl', 'python']) {
      const tool = aws.find(candidate => candidate.id === id);
      expect(tool).toBeDefined();
      expect(toolRequirement(tool!, 'aws', 'linux')).toBe('required');
    }
    expect(aws.some(tool => tool.id === 'buzz')).toBe(false);
    expect(ONBOARDING_SCENARIOS.map(item => item.id)).toEqual(['local', 'first', 'additional', 'aws']);
  });

  test('keeps Antigravity copy commands on the official CLI installer path', () => {
    const antigravity = toolsForScenario('local', 'mac').find(tool => tool.id === 'antigravity');
    expect(antigravity).toBeDefined();
    expect(antigravity?.officialUrl).toBe('https://antigravity.google/docs/cli/install/');
    expect(antigravity?.install.mac).toContain('antigravity.google/cli/install.sh');
    expect(antigravity?.install.windows).toContain('antigravity.google/cli/install.ps1');
  });

  test('keeps package-manager prerequisites and official cross-platform installers explicit', () => {
    const byId = (id: string) => ONBOARDING_TOOLS.find(tool => tool.id === id)!;
    const dependencies = byId('dependencies');
    expect(dependencies.description).toContain('설치 앱에는 이미 포함');
    expect(dependencies.install.mac).toContain('api-server.ts');
    expect(dependencies.install.windows).toContain('Test-Path .\\src-tauri');

    const supabase = byId('supabase');
    expect(supabase.install.windows).toContain('Get-Command scoop');
    expect(supabase.install.windows).toContain('scoop bucket add supabase https://github.com/supabase/scoop-bucket.git');
    expect(supabase.install.linux).toBe('curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install | bash');
    expect(supabase.verify).toBe('supabase projects list');

    const vercel = byId('vercel');
    expect(vercel.description).toContain('Node.js LTS·npm 필요');
    expect(vercel.install.windows).toContain('OpenJS.NodeJS.LTS');
    expect(vercel.install.linux).toContain('https://nodejs.org/en/download');
    expect(vercel.verify).toContain('node --version\nnpm --version');

    const codex = byId('codex');
    expect(codex.officialUrl).toBe('https://developers.openai.com/codex/cli/');
    expect(codex.install.mac).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(codex.install.windows).toContain('https://chatgpt.com/codex/install.ps1');
    expect(codex.install.linux).not.toContain('npm install -g');

    const api = source('api-server.ts');
    expect(api).toContain("join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')");
  });

  test('keeps SetupWizard on user-scoped Scoop and the native macOS Claude installer', () => {
    const setup = source('src/SetupWizard.tsx');
    const scoopSection = setup.slice(
      setup.indexOf('① Scoop 패키지 매니저 설치 (없는 경우)'),
      setup.indexOf('② Supabase CLI 설치 (Scoop)'),
    );
    expect(scoopSection).toContain('PowerShell을 <strong>일반 권한</strong>으로 열고 실행');
    expect(scoopSection).toContain('관리자 권한 사용 안 함');
    expect(scoopSection).not.toContain('PowerShell을 <strong>관리자 권한</strong>으로 열고 실행');

    const macWizard = setup.slice(
      setup.indexOf('function MacEnvWizard'),
      setup.indexOf('// ─── 통합 개발 환경 마법사'),
    );
    expect(macWizard).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(macWizard).toContain('Node.js·npm은 필요하지 않습니다.');
    expect(macWizard).toContain('설치 확인 — 버전이 표시되면 정상');
    expect(macWizard).toContain('전체 설치·연결 현황판');
    expect(macWizard).toContain('<strong>다시 검사</strong>');
    expect(macWizard).not.toContain('npm install -g @anthropic-ai/claude-code');
    expect(macWizard).not.toContain('brew install node');
  });

  test('builds AI-neutral prompts without diagnostic secrets or local details', () => {
    const prompt = buildOnboardingAgentPrompt({
      scenario: 'additional',
      platform: 'windows',
      diagnostics: [{
        id: 'supabase',
        state: 'needs-login',
        installed: true,
        authenticated: false,
        version: 'secret-token-should-not-leak',
        detail: 'C:\\Users\\Private\\token.txt',
      }],
    });
    expect(prompt).toContain('어떤 AI에서든');
    expect(prompt).toContain('기존 device ID, service_role, CLI 토큰은 옮기지 않고');
    expect(prompt).toContain('"state": "needs-login"');
    expect(prompt).toContain('"authenticated": false');
    expect(prompt).not.toContain('secret-token-should-not-leak');
    expect(prompt).not.toContain('C:\\Users\\Private');
    expect(prompt).not.toContain('sk-');
  });

  test('ships the public unauthenticated guide from its own deployment', () => {
    const vite = source('vite.guide.config.ts');
    const portalVite = source('vite.portal.config.ts');
    const vercel = JSON.parse(source('vercel.guide.json')) as { rewrites: Array<{ source: string; destination: string }> };
    expect(vite).toContain("guide: 'guide.html'");
    expect(portalVite).not.toContain("guide: 'guide.html'");
    expect(source('guide.html')).toContain('/src/onboarding-guide-main.tsx');
    expect(vercel.rewrites).toContainEqual({ source: '/', destination: '/guide.html' });
    expect(vercel.rewrites).toContainEqual({ source: '/guide', destination: '/guide.html' });
    expect(source('README.md')).toContain(ONBOARDING_GUIDE_URL);
  });

  test('keeps the public guide read-only and sends local setup back to the installed app', () => {
    const guide = source('src/onboarding-guide-main.tsx');
    expect(guide).not.toContain('href="/setup"');
    expect(guide).toContain('읽기 전용 웹 설명서');
    expect(guide).toContain('이 웹 페이지는 내 PC를 진단하거나 설정을 저장하지 않습니다.');
    expect(guide).toContain('설치된 AgentsToZ 앱을 열고 헤더의 설정(로켓)');
    expect(guide).toContain('설정은 설치된 앱에서 진행');
  });

  test('prepares and verifies Git before every novice Windows clone flow', () => {
    const readme = source('README.md');
    const guide = source('docs/user-guide/GUIDE.md');
    const sections = [
      readme.slice(readme.indexOf('### 방법 A:'), readme.indexOf('### 방법 B:')),
      readme.slice(readme.indexOf('<summary><b>Windows (PowerShell)</b></summary>'), readme.indexOf('</details>')),
      guide.slice(guide.indexOf('### Windows PowerShell'), guide.indexOf('### macOS Terminal')),
    ];

    for (const section of sections) {
      expect(section).toContain('& {');
      expect(section).toContain('Get-Command git -ErrorAction SilentlyContinue');
      expect(section).toContain('winget install --id Git.Git --exact --source winget');
      expect(section).toContain('git --version');
      expect(section.indexOf('Get-Command git')).toBeLessThan(section.indexOf('git clone'));
      expect(section.indexOf('git --version')).toBeLessThan(section.indexOf('git clone'));
    }

    expect(readme).toContain('PowerShell 5.1');
    expect(guide).toContain('PowerShell 5.1');
  });

  test('checks real macOS Git readiness before clone and opens the Apple installer when needed', () => {
    const readme = source('README.md');
    const guide = source('docs/user-guide/GUIDE.md');
    const readmeMacStart = readme.indexOf('<summary><b>macOS (bash / zsh)</b></summary>');
    const guideMacStart = guide.indexOf('### macOS Terminal');
    const sections = [
      readme.slice(readmeMacStart, readme.indexOf('</details>', readmeMacStart)),
      guide.slice(guideMacStart, guide.indexOf('브라우저에서 <http://localhost:9000>', guideMacStart)),
    ];

    for (const section of sections) {
      expect(section).toContain('if ! git --version >/dev/null 2>&1; then');
      expect(section).toContain('xcode-select --install');
      expect(section).toContain('새 Terminal');
      expect(section.indexOf('git --version')).toBeLessThan(section.indexOf('git clone'));
    }
  });

  test('uses the real Windows build guidance name and keeps the auto-updater disclaimer', () => {
    for (const path of ['README.md', 'docs/user-guide/GUIDE.md']) {
      const document = source(path);
      expect(document).toContain('Windows 빌드·출시 안내');
      expect(document).not.toContain('Windows PC 업데이트');
      expect(document).toContain('자동 업데이트 기능이 아닙니다');
    }

    const readme = source('README.md');
    expect(readme).toContain('Windows 네이티브 `claude --bg`를 우선');
    expect(readme).not.toContain('Windows에서 WSL의 `claude --bg`로 연결');
  });

  test('uses one cached secret-free read-only diagnostics endpoint', () => {
    const api = source('api-server.ts');
    const center = source('src/OnboardingInfrastructureCenter.tsx');
    const route = api.slice(
      api.indexOf('if (url.pathname === "/api/onboarding/tools"'),
      api.indexOf('// Portal 데이터 로드'),
    );
    expect(route).toContain('onboardingToolsStatus(force)');
    expect(route).toContain("'Cache-Control': 'no-store'");
    expect(api).toContain('ONBOARDING_TOOLS_CACHE_TTL_MS = 30_000');
    expect(api).toContain('timeout: 2_000');
    expect(api).toContain('AGENT_BIN_CACHE.clear()');
    expect(api).toContain('readOnboardingSyncEvidence(portal)');
    expect(api).toContain("endpoint.searchParams.set('select', 'last_push_at')");
    expect(api).toContain("normalizedModuleDir.includes('/$bunfs/')");
    expect(api).toContain("/^agentstoz-api-sidecar(?:\\.exe)?$/i.test(basename(process.execPath))");
    expect(api).not.toContain("join(process.cwd(), 'node_modules', 'react')");
    expect(api).toContain("state: dependenciesReady ? 'ready' : 'missing'");
    expect(route).toContain("error: '설치 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'");
    expect(route).not.toContain('error.message');
    expect(route).not.toContain('String(error)');
    expect(route).not.toContain('serviceRoleKey');
    expect(route).not.toContain('accessToken');
    expect(center).toContain('/api/onboarding/status');
    expect(center).toContain('onboarding-device-connection-status');
    expect(center).toContain('단말 등록과 실제 Push/Pull 성공을 따로 확인');
    expect(center).toContain('Supabase 왕복');
  });
});
