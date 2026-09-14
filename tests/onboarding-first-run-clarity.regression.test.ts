import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('first-run onboarding clarity', () => {
  const guide = source('src/onboarding-guide-main.tsx');
  const manual = source('docs/user-guide/GUIDE.md');
  const selfHosting = source('docs/SELF-HOSTING.md');
  const wizard = source('src/SetupWizard.tsx');
  const clipboard = source('src/onboardingClipboard.ts');

  test('makes local use the primary outcome and keeps the personal portal optional', () => {
    const hero = guide.slice(guide.indexOf('<main id="top">'), guide.indexOf('<section id="start"'));
    expect(hero).toContain('처음 설치·실행하기');
    expect(hero).toContain('이미 앱이 있어요');
    expect(hero).toContain('선택: 개인 웹 포털');
    expect(hero.indexOf('처음 설치·실행하기')).toBeLessThan(hero.indexOf('선택: 개인 웹 포털'));

    const split = guide.slice(
      guide.indexOf('data-testid="onboarding-product-split"'),
      guide.indexOf('data-testid="first-run-paths"'),
    );
    expect(split).toContain('기본 제품');
    expect(split).toContain('내 컴퓨터에서 시작');
    expect(split).toContain('나중에 선택');
    expect(split).toContain('데스크톱 앱 설치가 아닙니다.');

    expect(wizard).toContain('data-testid="setup-personal-portal-optional"');
    expect(wizard).not.toContain('data-testid="setup-personal-portal-primary"');
    expect(wizard.indexOf('로컬로 바로 시작')).toBeLessThan(wizard.indexOf('setup-personal-portal-optional'));
    expect(wizard).toContain('선택 기능 · 개인 웹 포털과 고급 설정');
  });

  test('gives no-clone beginners honest platform-specific first steps', () => {
    const firstRun = guide.slice(
      guide.indexOf('data-testid="first-run-paths"'),
      guide.indexOf('<ToolPlan />'),
    );
    expect(firstRun).toContain('GitHub 계정·Git·Bun·clone이 모두 필요 없습니다.');
    expect(firstRun).toContain('Windows 설치 파일 받기');
    expect(firstRun).toContain('macOS · 현재는 소스 웹 모드');
    expect(firstRun).toContain('이 경로는 DMG 데스크톱 앱 설치가 아닙니다.');
    expect(firstRun).toContain('GitHub 계정이나 미리 clone한 폴더 없이');
    expect(firstRun).toContain('Mac 시작 명령 복사');

    expect(manual).toContain('Windows 설치 파일로 시작할 때는 Bun·Git·GitHub clone이 필요 없습니다.');
    expect(manual).toContain('이 경로는 DMG 설치가 아니라 로컬 웹 모드');
  });

  test('keeps technical inventory collapsed and places handoff after the choices', () => {
    const toolPlan = guide.slice(guide.indexOf('function ToolPlan()'), guide.indexOf('function GuideApp()'));
    expect(toolPlan).toContain('<details data-testid="advanced-tool-plan"');
    expect(toolPlan).not.toContain('<details open');
    expect(toolPlan).toContain("useState<OnboardingScenarioId>('local')");
    expect(toolPlan).toContain("useState<OnboardingRuntimeMode>('source')");
    expect(toolPlan.indexOf('ONBOARDING_SCENARIOS.map')).toBeLessThan(toolPlan.indexOf('선택한 과정 AI에게 맡기기'));
    expect(toolPlan).toContain('이 목록은 앱 설치 전 공통 체크리스트가 아닙니다.');
    expect(toolPlan).toContain('<fieldset>');
    expect(toolPlan).toContain('aria-pressed={runtimeMode === \'packaged\'}');
    expect(toolPlan).toContain('Bun·node_modules·GitHub clone은 필요 없습니다.');
  });

  test('explains exactly what the Vercel button creates and does not create', () => {
    for (const document of [guide, manual, selfHosting, wizard]) {
      expect(document).toContain('개인 웹 포털');
      expect(document).toContain('데스크톱 앱 설치');
    }

    expect(guide).toContain('data-testid="vercel-deploy-boundary"');
    expect(guide).toContain('버튼이 만드는 것');
    expect(guide).toContain('버튼이 하지 않는 것');
    expect(guide).toContain('GitHub·GitLab·Bitbucket');
    expect(guide).toContain('내 PC에 <code className="text-zinc-300">git clone</code>하지 않고');
    expect(guide).toContain('Vercel에 내 개인 포털 프로젝트 만들기');
    expect(selfHosting).toContain('설치 파일 다운로드 버튼이 아닙니다.');
    expect(selfHosting).toContain('Vercel 계정이 없다면 버튼 안에서 가입할 수 있지만');
  });

  test('keeps the copied Mac command in the same order described to users', () => {
    const command = guide.slice(
      guide.indexOf('const MAC_LOCAL_START_COMMAND'),
      guide.indexOf('const overviewImage'),
    );
    const positions = [
      command.indexOf('git --version'),
      command.indexOf('command -v bun'),
      command.indexOf('git clone'),
      command.indexOf('bun install'),
      command.indexOf('bun run start'),
    ];
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('does not fail silently when clipboard access is unavailable', () => {
    const copyAction = guide.slice(guide.indexOf('function CopyAction'), guide.indexOf('function GuideShareAction'));
    expect(copyAction).toContain("setCopyState('copying')");
    expect(copyAction).toContain('writeOnboardingClipboard(value)');
    expect(copyAction).toContain("setCopyState('failed')");
    expect(copyAction).toContain('자동 복사가 막혔습니다.');
    expect(copyAction).toContain('aria-label="직접 복사할 내용"');
    expect(copyAction).toContain('onFocus={event => event.currentTarget.select()}');
    expect(clipboard).toContain("targetDocument.execCommand('copy')");
    expect(wizard).toContain('writeOnboardingClipboard(code)');
    expect(wizard).toContain('aria-label="직접 복사할 명령"');
    expect(wizard).toContain('aria-label="직접 복사할 AI 온보딩 프롬프트"');
    expect(wizard).toContain('aria-label="직접 복사할 추가 PC 연결 정보"');
    expect(wizard).toContain('Windows 공식 설치 파일을 쓰면 GitHub clone·Git·Bun이 필요 없습니다.');
  });

  test('keeps the setup dialog reachable at saved high zoom', () => {
    expect(wizard).not.toContain('h-[95vh]');
    expect(wizard).toContain("height: 'min(680px, calc(var(--ui-viewport-height, 100dvh) - 16px))'");
    expect(wizard).toContain('role="dialog"');
    expect(wizard).toContain('aria-modal="true"');
    expect(wizard).toContain('aria-labelledby="setup-wizard-title"');
    expect(wizard).toContain('aria-label="초기 설정 닫기"');
    expect(wizard).toContain('className="group flex h-11 w-11');
    expect(wizard).toContain('className="min-h-0 flex-1 overflow-hidden"');
  });

  test('exposes the mobile guide menu state to assistive technology', () => {
    expect(guide).toContain("aria-label={menuOpen ? '목차 닫기' : '목차 열기'}");
    expect(guide).toContain('aria-expanded={menuOpen}');
    expect(guide).toContain('aria-controls="guide-mobile-navigation"');
    expect(guide).toContain('id="guide-mobile-navigation"');
    expect(guide).toContain('break-words text-2xl font-bold tracking-tight text-[var(--text-primary)] [overflow-wrap:anywhere]');
    expect(guide).toContain('inline-flex min-h-11 min-w-11 items-center justify-center');
    expect(guide).toContain('className="flex min-h-11 items-center rounded-lg');
  });
});
