import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight, BookOpen, Check, ChevronRight, Cloud, Copy, ExternalLink,
  Github, Laptop, Menu, Monitor, Server, Share2, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import './index.css';
import { writeOnboardingClipboard } from './onboardingClipboard';
import {
  ONBOARDING_GUIDE_URL,
  ONBOARDING_SCENARIOS,
  buildOnboardingAgentPrompt,
  toolRequirement,
  toolsForScenario,
  type OnboardingPlatform,
  type OnboardingRuntimeMode,
  type OnboardingScenarioId,
} from './onboardingInfrastructure';
import {
  buildSelfHostingAgentPrompt,
  buildVercelImportUrl,
  publicGitHubRepositoryUrl,
} from './selfHosting';
import { sharePublicGuide, type PublicGuideShareResult } from './publicGuideShare';

const PUBLIC_REPOSITORY_URL = publicGitHubRepositoryUrl(import.meta.env.VITE_REPO_URL);
const VERCEL_IMPORT_URL = buildVercelImportUrl(PUBLIC_REPOSITORY_URL);
const SELF_HOSTING_PROMPT = buildSelfHostingAgentPrompt(PUBLIC_REPOSITORY_URL);
const SELF_HOSTING_GUIDE_URL = `${PUBLIC_REPOSITORY_URL}/blob/main/docs/SELF-HOSTING.md`;
const WINDOWS_RELEASES_URL = `${PUBLIC_REPOSITORY_URL}/releases/latest`;
const SECURITY_SETUP_GUIDE_URL = `${PUBLIC_REPOSITORY_URL}/blob/main/docs/SECURITY-SETUP.md`;
const SUPABASE_DASHBOARD_URL = 'https://supabase.com/dashboard';
const VERCEL_DEPLOY_BUTTON_GUIDE_URL = 'https://vercel.com/docs/deploy-button';

const MAC_LOCAL_START_COMMAND = `(
  if ! git --version >/dev/null 2>&1; then
    xcode-select --install 2>/dev/null || true
    echo "Apple 명령줄 도구 설치를 마친 뒤 새 Terminal에서 같은 명령을 다시 실행하세요."
    exit 0
  fi

  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    echo "Bun 설치를 마친 뒤 새 Terminal에서 같은 명령을 다시 실행하세요."
    exit 0
  fi

  project_root="$HOME/dev/AgentsToZ_byCS"
  mkdir -p "$HOME/dev"
  if [ -d "$project_root/.git" ]; then
    echo "이미 내려받은 AgentsToZ 공개 소스를 사용합니다."
  elif [ -e "$project_root" ]; then
    echo "$project_root 폴더가 이미 있지만 Git 저장소가 아닙니다. 폴더 이름을 확인하세요."
    exit 0
  else
    git clone ${PUBLIC_REPOSITORY_URL}.git "$project_root" || exit 1
  fi

  cd "$project_root" || exit 1
  bun install || exit 1
  bun run start
)`;

const overviewImage = new URL('../docs/images/agents-toz-overview.png', import.meta.url).href;
const setupImage = new URL('../docs/images/setup-wizard-current.png', import.meta.url).href;
const dashboardImage = new URL('../docs/images/onboarding-dashboard.png', import.meta.url).href;
const portalImage = new URL('../docs/images/portal.png', import.meta.url).href;
const aiUsageImage = new URL('../docs/images/ai-usage-panel.png', import.meta.url).href;

const NAV = [
  ['start', '처음 시작'],
  ['first-device', '첫 단말'],
  ['second-device', '두 번째 PC'],
  ['aws', 'AWS·Ubuntu'],
  ['cloud-reuse', '기존 서비스 재사용'],
  ['self-hosting', '개인 웹 포털(선택)'],
  ['connections', 'Buzz·Hermes·Telegram'],
  ['windows-update-build', 'Windows 설치·업데이트'],
] as const;

function CopyAction({ value, children = '복사' }: { value: string; children?: React.ReactNode }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');

  async function handleCopy() {
    setCopyState('copying');
    const copied = await writeOnboardingClipboard(value);
    if (copied) {
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 3000);
    } else {
      setCopyState('failed');
    }
  }

  const label = copyState === 'copying'
    ? '복사 중…'
    : copyState === 'copied'
      ? '복사됐어요'
      : copyState === 'failed'
        ? '자동 복사 실패'
        : children;

  return (
    <span className="inline-flex max-w-full flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => void handleCopy()}
        disabled={copyState === 'copying'}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-teal-300/30 bg-teal-400/10 px-3 py-2 text-xs font-semibold text-teal-100 transition hover:bg-teal-400/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 disabled:cursor-wait disabled:opacity-60"
        aria-live="polite"
      >
        {copyState === 'copied' ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
        {label}
      </button>
      {copyState === 'failed' && (
        <span className="w-full max-w-lg rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-2 text-xs leading-5 text-amber-100/90">
          자동 복사가 막혔습니다. 아래 내용을 길게 눌러 전체 선택한 뒤 복사하세요.
          <textarea
            readOnly
            value={value}
            onFocus={event => event.currentTarget.select()}
            aria-label="직접 복사할 내용"
            className="mt-2 block h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs leading-5 text-zinc-200"
          />
        </span>
      )}
    </span>
  );
}

function GuideShareAction() {
  const [result, setResult] = useState<PublicGuideShareResult | 'failed' | null>(null);

  async function handleShare() {
    try {
      const next = await sharePublicGuide(navigator);
      setResult(next === 'cancelled' ? null : next);
      if (next !== 'cancelled') window.setTimeout(() => setResult(null), 2200);
    } catch {
      setResult('failed');
      window.setTimeout(() => setResult(null), 2600);
    }
  }

  const label = result === 'shared'
    ? '공유했어요'
    : result === 'copied'
      ? '주소를 복사했어요'
      : result === 'failed'
        ? '공유하지 못했어요'
        : '공유하기';

  return (
    <button
      type="button"
      onClick={() => void handleShare()}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:border-teal-300/40 hover:text-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"
      aria-label={label}
      title="공개 설명서 주소 공유"
    >
      {result === 'shared' || result === 'copied'
        ? <Check className="h-4 w-4 text-emerald-300" />
        : <Share2 className="h-4 w-4 text-teal-300" />}
      <span className="hidden sm:inline" aria-live="polite">{label}</span>
    </button>
  );
}

function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">{eyebrow}</p>
      <h2 className="mt-2 break-words text-2xl font-bold tracking-tight text-[var(--text-primary)] [overflow-wrap:anywhere] sm:text-3xl">{title}</h2>
      <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">{children}</p>
    </div>
  );
}

function Steps({ items }: { items: Array<{ title: string; body: React.ReactNode; success?: string }> }) {
  return (
    <ol className="mt-7 grid gap-3">
      {items.map((item, index) => (
        <li key={item.title} className="flex gap-4 rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-4 sm:p-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-teal-300/30 bg-teal-400/10 text-sm font-bold text-teal-200">{index + 1}</span>
          <div className="min-w-0">
            <h3 className="break-words font-semibold text-zinc-100 [overflow-wrap:anywhere]">{item.title}</h3>
            <div className="mt-1 text-sm leading-6 text-zinc-400">{item.body}</div>
            {item.success && <p className="mt-2 text-xs text-emerald-300">성공 화면: {item.success}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="mt-7 overflow-hidden rounded-2xl border border-zinc-800 bg-[var(--bg-card)] shadow-[var(--dialog-shadow)]">
      <img src={src} alt={alt} className="block h-auto w-full" loading="lazy" />
      <figcaption className="border-t border-zinc-800 px-4 py-3 text-xs leading-5 text-zinc-500">{caption}</figcaption>
    </figure>
  );
}

function buildGuideJourneyPrompt(input: {
  journey: string;
  goal: string;
  success: string;
  scenario?: OnboardingScenarioId;
  platform?: OnboardingPlatform;
  runtimeMode?: OnboardingRuntimeMode;
}): string {
  const onboardingPrompt = input.scenario && input.platform
    ? `\n\n아래 AgentsToZ 정본 규칙도 함께 지켜줘.\n\n${buildOnboardingAgentPrompt({ scenario: input.scenario, platform: input.platform, runtimeMode: input.runtimeMode })}`
    : '';

  return `AgentsToZ_byCS의 “${input.journey}” 이 과정만 맡아줘. 나는 컴퓨터 설정에 익숙하지 않으니 설명을 길게 하지 말고 실제 화면과 상태를 확인하며 한 단계씩 진행해줘.

목표: ${input.goal}
성공 조건: ${input.success}

진행 규칙:
1. 현재 상태를 먼저 읽기 전용으로 확인하고 이미 끝난 단계는 건너뛰어.
2. 다음 행동은 한 번에 하나만 알려주고, 내가 결과를 보내면 성공 증거를 확인한 뒤에만 다음 단계로 넘어가.
3. 버튼을 눌러야 하면 현재 화면에 보이는 정확한 메뉴 이름과 누를 위치를 알려줘. 화면이 다르면 추측하지 말고 나에게 현재 문구를 물어봐.
4. 설치·로그인·권한 변경·계정 또는 클라우드 리소스 생성·배포 직전에는 무엇이 바뀌는지 한 문장으로 말하고 내 확인을 받아.
5. 비밀번호·쿠키·OAuth code·access token·service_role·private key는 읽거나 채팅·로그·스크린샷에 남기지 마. 로그인·비밀번호·토큰 입력은 직접 하게 멈춰줘.
6. 실패하면 같은 행동을 반복시키지 말고 오류 문구와 실제 상태를 확인한 뒤 안전한 다음 행동 하나만 제시해.

AgentsToZ 전체 설명서: ${ONBOARDING_GUIDE_URL}${onboardingPrompt}`;
}

function AgentHandoff({
  title,
  description,
  actions,
  links = [],
}: {
  title: string;
  description: string;
  actions: Array<{ label: string; prompt: string }>;
  links?: Array<{ label: string; href: string }>;
}) {
  return (
    <div data-testid="guide-agent-handoff" className="mt-6 rounded-2xl border border-violet-300/20 bg-violet-400/[0.055] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-400/10"><Sparkles className="h-4 w-4 text-violet-200" /></span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-200">AI에게 그대로 맡기기</p>
          <h3 className="mt-1 font-semibold text-[var(--text-primary)]">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{description}</p>
        </div>
      </div>
      <ol className="mt-4 grid gap-2 text-xs leading-5 text-zinc-300 sm:grid-cols-3">
        <li className="rounded-lg border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 px-3 py-2"><strong className="text-violet-200">1. 프롬프트 복사</strong><br />내 PC에 맞는 버튼을 누릅니다.</li>
        <li className="rounded-lg border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 px-3 py-2"><strong className="text-violet-200">2. Claude·Codex 새 대화에 붙여넣기</strong><br />복사된 문장 전체를 그대로 보냅니다.</li>
        <li className="rounded-lg border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 px-3 py-2"><strong className="text-violet-200">3. AI가 알려주는 한 단계만 실행</strong><br />완료 화면이나 오류 문구만 알려줍니다.</li>
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        {actions.map(action => <CopyAction key={action.label} value={action.prompt}>{action.label}</CopyAction>)}
        {links.map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-sky-200 hover:border-sky-300/30"><ExternalLink className="h-3.5 w-3.5" />{link.label}</a>)}
      </div>
      <p className="mt-3 text-xs leading-5 text-zinc-400"><strong className="text-zinc-200">직접 해야 하는 것:</strong> 로그인·비밀번호·토큰 입력은 직접 하고, 값을 AI 채팅에 붙여넣지 마세요. AI가 한 번에 여러 단계를 말하면 “다음 행동 하나만 알려줘”라고 답하세요.</p>
    </div>
  );
}

function SimplePrompt({ name, goal, success, officialUrl }: { name: string; goal: string; success: string; officialUrl: string }) {
  const prompt = `${name} 연동을 컴퓨터를 처음 쓰는 사람과 한 단계씩 진행해줘.

목표: ${goal}
공식 문서: ${officialUrl}
성공 조건: ${success}

규칙:
1. 현재 OS와 설치 상태를 먼저 읽기 전용으로 확인하고, 다음 행동은 하나만 알려줘.
2. 다운로드·설치·로그인·권한 변경·외부 계정 생성 직전에는 무엇이 바뀌는지 쉽게 설명하고 내 확인을 받아.
3. 비밀번호, 쿠키, access token, service_role, bot token, private key를 읽거나 채팅·로그·스크린샷에 남기지 마. secret 입력은 내가 직접 하게 멈춰.
4. 화면 문구가 다르면 추측하지 말고 현재 화면을 다시 확인해.
5. 마지막에는 실제 성공 증거와 아직 하지 않은 선택 기능만 짧게 알려줘.

AgentsToZ 전체 설명서: ${ONBOARDING_GUIDE_URL}`;
  return <CopyAction value={prompt}>{name} AI 프롬프트</CopyAction>;
}

function ToolPlan() {
  const [scenario, setScenario] = useState<OnboardingScenarioId>('local');
  const [platform, setPlatform] = useState<OnboardingPlatform>('mac');
  const [runtimeMode, setRuntimeMode] = useState<OnboardingRuntimeMode>('source');
  const tools = useMemo(() => toolsForScenario(scenario, platform, runtimeMode), [runtimeMode, scenario, platform]);
  const prompt = buildOnboardingAgentPrompt({ scenario, platform, runtimeMode });
  return (
    <details data-testid="advanced-tool-plan" className="group mt-8 rounded-2xl border border-zinc-800 bg-[var(--bg-card)]">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-zinc-200 sm:px-5">
        <span>
          소스 실행·동기화 도구를 직접 준비해야 하나요?
          <span className="mt-1 block text-xs font-normal leading-5 text-zinc-500">Windows 설치 파일로 시작한다면 이 목록은 필요 없습니다.</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 transition group-open:rotate-90" />
      </summary>
      <div className="border-t border-zinc-800 p-4 sm:p-5">
        <div className="rounded-xl border border-sky-300/15 bg-sky-400/[0.04] px-4 py-3 text-xs leading-6 text-zinc-400">
          <strong className="text-sky-200">이 목록은 앱 설치 전 공통 체크리스트가 아닙니다.</strong> macOS에서 공개 소스를 실행하거나, 여러 기기 동기화·AWS 연결을 직접 구성할 때만 현재 상황에 맞춰 확인하세요.
        </div>
        <div className="mt-4">
          <div>
            <h3 className="font-semibold text-[var(--text-primary)]">선택한 과정의 기술 준비 목록</h3>
            <p className="mt-1 text-xs text-zinc-500">먼저 상황과 OS를 고르면 필요한 도구만 분류합니다.</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-zinc-300">1. 무엇을 하려나요?</legend>
            <div className="flex flex-wrap gap-2">
              {ONBOARDING_SCENARIOS.map(item => (
                <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} className={`min-h-11 rounded-full border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${scenario === item.id ? 'border-teal-300/40 bg-teal-400/15 text-teal-100' : 'border-zinc-700 text-zinc-300 hover:text-zinc-100'}`}>{item.shortLabel}</button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-zinc-300">2. 어느 컴퓨터인가요?</legend>
            <div className="flex flex-wrap gap-2">
              {(['mac', 'windows', 'linux'] as OnboardingPlatform[]).map(item => (
                <button key={item} type="button" aria-pressed={platform === item} onClick={() => {
                  setPlatform(item);
                  setRuntimeMode(item === 'windows' ? 'packaged' : item === 'linux' ? 'remote' : 'source');
                }} className={`min-h-11 rounded-full border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 ${platform === item ? 'border-sky-300/40 bg-sky-400/10 text-sky-100' : 'border-zinc-700 text-zinc-300 hover:text-zinc-100'}`}>{item === 'mac' ? 'macOS' : item === 'windows' ? 'Windows' : 'AWS·Linux'}</button>
              ))}
            </div>
          </fieldset>
          {platform !== 'linux' && (
            <fieldset>
              <legend className="mb-2 text-xs font-semibold text-zinc-300">3. 앱을 어떻게 열었나요?</legend>
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-pressed={runtimeMode === 'packaged'} onClick={() => setRuntimeMode('packaged')} className={`min-h-11 rounded-full border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${runtimeMode === 'packaged' ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-100' : 'border-zinc-700 text-zinc-300 hover:text-zinc-100'}`}>설치 파일·이미 설치된 앱</button>
                <button type="button" aria-pressed={runtimeMode === 'source'} onClick={() => setRuntimeMode('source')} className={`min-h-11 rounded-full border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${runtimeMode === 'source' ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-100' : 'border-zinc-700 text-zinc-300 hover:text-zinc-100'}`}>공개 소스 직접 실행</button>
              </div>
              <p className="mt-2 text-xs leading-5 text-zinc-400">{runtimeMode === 'packaged' ? 'Bun·node_modules·GitHub clone은 필요 없습니다. Git은 나중에 프로젝트 버전 관리가 필요할 때만 선택합니다.' : '이 경로에서만 Bun·Git·node_modules와 로컬 API 실행이 필요합니다.'}</p>
            </fieldset>
          )}
        </div>
        <div className="mt-3"><CopyAction value={prompt}>선택한 과정 AI에게 맡기기</CopyAction></div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map(tool => {
            const requirement = toolRequirement(tool, scenario, platform, runtimeMode);
            return (
              <div key={tool.id} className="rounded-xl border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-200">{tool.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${requirement === 'required' ? 'bg-rose-500/10 text-rose-200' : requirement === 'recommended' ? 'bg-sky-500/10 text-sky-200' : 'bg-zinc-800 text-zinc-300'}`}>{requirement === 'required' ? '필수' : requirement === 'recommended' ? '권장' : '선택'}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-zinc-400">{tool.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function GuideApp() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="onboarding-guide min-h-screen bg-[var(--bg-base)] text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--bg-base-rgb))]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <a href="#top" className="flex min-h-11 items-center gap-2 font-semibold text-[var(--text-primary)]"><ShieldCheck className="h-5 w-5 text-teal-300" /> AgentsToZ 시작 설명서</a>
          <nav className="hidden items-center gap-5 lg:flex" aria-label="설명서 목차">
            {NAV.map(([id, label]) => <a key={id} href={`#${id}`} className="text-xs text-zinc-400 hover:text-teal-200">{label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <GuideShareAction />
            <button type="button" onClick={() => setMenuOpen(value => !value)} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-zinc-800 text-zinc-300 lg:hidden" aria-label={menuOpen ? '목차 닫기' : '목차 열기'} aria-expanded={menuOpen} aria-controls="guide-mobile-navigation">{menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
          </div>
        </div>
        {menuOpen && <nav id="guide-mobile-navigation" className="grid gap-1 border-t border-zinc-800 px-4 py-3 lg:hidden">{NAV.map(([id, label]) => <a key={id} href={`#${id}`} onClick={() => setMenuOpen(false)} className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900">{label}</a>)}</nav>}
      </header>

      <main id="top">
        <section className="relative overflow-hidden border-b border-[rgb(var(--surface-highlight-rgb))]/[0.06] px-4 py-20 sm:px-6 sm:py-28">
          <div className="pointer-events-none absolute left-1/2 top-0 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-teal-400/10 blur-3xl" />
          <div className="relative mx-auto max-w-5xl text-center">
            <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-teal-300/20 bg-teal-400/[0.07] px-3 py-1.5 text-xs text-teal-200"><Sparkles className="h-3.5 w-3.5" /> 처음 온 분을 위한 시작 안내</div>
            <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)] sm:text-6xl">AgentsToZ를 이해하고,<br /><span className="text-teal-300">내 첫 화면을</span> 여세요.</h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-8 text-zinc-400 sm:text-lg">AgentsToZ는 내 컴퓨터의 프로젝트·AI·북마크를 한곳에서 관리하는 앱입니다. GitHub clone이나 Vercel 배포를 해본 적이 없어도 괜찮습니다.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <a href="#start" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-5 py-3 text-sm font-bold text-[var(--text-on-accent)] hover:bg-teal-200">처음 설치·실행하기 <ArrowRight className="h-4 w-4" /></a>
              <a href="#first-device" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-teal-300/30 bg-teal-400/10 px-5 py-3 text-sm font-semibold text-teal-100 hover:bg-teal-400/15">이미 앱이 있어요 <Monitor className="h-4 w-4" /></a>
              <a href="#self-hosting" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm font-semibold text-zinc-200 hover:border-zinc-600">선택: 개인 웹 포털 <ExternalLink className="h-4 w-4" /></a>
            </div>
            <p className="mx-auto mt-4 max-w-2xl text-xs leading-6 text-zinc-500"><strong className="text-zinc-300">먼저 구분하세요:</strong> 데스크톱 앱이 기본 제품이고, Vercel 개인 웹 포털은 휴대폰·다른 브라우저에서도 볼 때만 만드는 선택 기능입니다.</p>
            <p className="mx-auto mt-2 max-w-2xl text-xs leading-6 text-zinc-500"><strong className="text-zinc-300">읽기 전용 웹 설명서:</strong> 이 웹 페이지는 내 PC를 진단하거나 설정을 저장하지 않습니다. 실제 진단·설정은 <strong className="text-zinc-300">설치된 AgentsToZ 앱을 열고 헤더의 설정(로켓) → 초기 설정 → 설치·연결 현황판</strong>에서 진행하세요.</p>
          </div>
        </section>

        <section id="start" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionTitle eyebrow="처음 시작" title="GitHub에 아무것도 없어도 여기서 시작하세요.">GitHub 계정, clone한 폴더, Vercel, Supabase를 먼저 준비할 필요가 없습니다. 사용할 컴퓨터에 맞는 첫 경로 하나만 선택하세요.</SectionTitle>

            <div data-testid="onboarding-product-split" className="mt-8 grid gap-3 md:grid-cols-2">
              <article className="rounded-2xl border border-teal-300/25 bg-teal-400/[0.05] p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3"><span className="rounded-full bg-teal-300 px-2.5 py-1 text-xs font-bold text-[var(--text-on-accent)]">기본 제품</span><Monitor className="h-5 w-5 text-teal-300" /></div>
                <h3 className="mt-4 text-lg font-bold text-[var(--text-primary)]">내 컴퓨터에서 AgentsToZ 사용</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-400">프로젝트 실행·정리와 AI 도구 연결은 여기서 시작합니다. 한 대에서 로컬로만 쓰면 외부 계정이 필요 없습니다.</p>
                <a href="#local-start-paths" className="mt-4 inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-teal-300 px-3 py-2 text-xs font-bold text-[var(--text-on-accent)] hover:bg-teal-200">내 컴퓨터에서 시작 <ChevronRight className="h-3.5 w-3.5" /></a>
              </article>
              <article className="rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3"><span className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-300">나중에 선택</span><ExternalLink className="h-5 w-5 text-zinc-500" /></div>
                <h3 className="mt-4 text-lg font-bold text-[var(--text-primary)]">휴대폰용 개인 웹 포털 만들기</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-400">Vercel·Supabase·Google 계정으로 내 전용 웹 주소를 만드는 별도 과정입니다. 데스크톱 앱 설치가 아닙니다.</p>
                <a href="#self-hosting" className="mt-4 inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-sky-200 hover:text-sky-100">필요할 때 과정 보기 <ChevronRight className="h-3.5 w-3.5" /></a>
              </article>
            </div>

            <div id="local-start-paths" data-testid="first-run-paths" className="mt-8 scroll-mt-24 grid gap-4 lg:grid-cols-2">
              <article className="rounded-3xl border border-sky-300/20 bg-sky-400/[0.035] p-5 sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-300">Windows · 일반 사용자 권장</p>
                <h3 className="mt-2 text-xl font-bold text-[var(--text-primary)]">설치 파일 하나로 앱 열기</h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400">GitHub 계정·Git·Bun·clone이 모두 필요 없습니다. 공식 릴리스의 <code className="text-sky-200">x64-setup.exe</code>를 받아 설치하세요.</p>
                <ol className="mt-5 grid gap-2 text-sm leading-6 text-zinc-300">
                  <li><strong className="text-sky-200">1.</strong> 최신 Windows 설치 파일 페이지 열기</li>
                  <li><strong className="text-sky-200">2.</strong> Assets에서 <code className="text-zinc-200">x64-setup.exe</code> 다운로드·실행</li>
                  <li><strong className="text-sky-200">3.</strong> 앱에서 <strong className="text-[var(--text-primary)]">로컬로 바로 시작</strong> 선택</li>
                </ol>
                <a href={WINDOWS_RELEASES_URL} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-sky-300 px-4 py-2 text-sm font-bold text-[var(--text-on-accent)] hover:bg-sky-200">Windows 설치 파일 받기 <ExternalLink className="h-4 w-4" /></a>
              </article>

              <article className="rounded-3xl border border-violet-300/20 bg-violet-400/[0.035] p-5 sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300">macOS · 현재는 소스 웹 모드</p>
                <h3 className="mt-2 text-xl font-bold text-[var(--text-primary)]">공개 소스를 받아 브라우저에서 실행</h3>
                <p className="mt-2 text-sm leading-7 text-zinc-400">이 경로는 DMG 데스크톱 앱 설치가 아닙니다. GitHub 계정이나 미리 clone한 폴더 없이, Git 준비 확인 → Bun 설치 확인 → 공개 소스 내려받기(<code className="text-violet-200">git clone</code>) → 로컬 웹 화면 실행 순서로 진행합니다.</p>
                <ol className="mt-5 grid gap-2 text-sm leading-6 text-zinc-300">
                  <li><strong className="text-violet-200">1.</strong> Mac의 <strong className="text-[var(--text-primary)]">Terminal</strong> 앱 열기</li>
                  <li><strong className="text-violet-200">2.</strong> 아래 버튼으로 명령 전체를 복사해 붙여넣고 Enter</li>
                  <li><strong className="text-violet-200">3.</strong> 설치 후 <code className="text-zinc-200">http://localhost:9000</code> 화면 확인</li>
                </ol>
                <div className="mt-5 flex flex-wrap gap-2">
                  <CopyAction value={MAC_LOCAL_START_COMMAND}>Mac 시작 명령 복사</CopyAction>
                  <CopyAction value={buildGuideJourneyPrompt({ journey: '처음 Mac에서 AgentsToZ 공개 소스 실행', goal: 'GitHub 계정이나 기존 clone 없이 Git 준비 확인부터 공개 저장소 내려받기, Bun·구성요소 설치, 로컬 화면 실행까지 완료', success: 'http://localhost:9000에서 AgentsToZ 첫 화면이 열림', scenario: 'local', platform: 'mac', runtimeMode: 'source' })}>Mac 과정을 AI에게 맡기기</CopyAction>
                </div>
                <p className="mt-3 text-xs leading-5 text-zinc-500">Apple 도구나 Bun을 새로 설치했다면 안내대로 새 Terminal을 열고 같은 명령을 한 번 더 실행합니다.</p>
              </article>
            </div>

            <div className="mt-8 rounded-2xl border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 p-5">
              <p className="text-sm font-semibold text-zinc-200">이미 AgentsToZ 화면이 열렸나요?</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">한 PC에서만 쓰면 <strong className="text-zinc-300">로컬로 바로 시작</strong>하면 끝입니다. 여러 PC에서 같은 목록을 쓸 때만 첫 단말 동기화를 연결하세요.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <a href="#first-device" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-teal-300/30 px-3 py-2 text-xs font-semibold text-teal-100">첫 단말·동기화 보기 <ChevronRight className="h-3.5 w-3.5" /></a>
                <a href="#second-device" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300">두 번째 PC 연결 <ChevronRight className="h-3.5 w-3.5" /></a>
                <a href="#aws" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300">AWS·Ubuntu 연결 <ChevronRight className="h-3.5 w-3.5" /></a>
              </div>
            </div>
            <ToolPlan />
            <Screenshot src={dashboardImage} alt="AgentsToZ 설치·연결 현황판에서 필수 도구가 준비됨으로 표시된 화면" caption="앱을 연 뒤 동기화나 소스 실행을 구성할 때 보는 설치·연결 현황판입니다. Windows 설치 파일로 앱만 시작하는 데 이 도구 목록이 먼저 필요한 것은 아닙니다." />
            <Screenshot src={overviewImage} alt="AgentsToZ 앱의 프로젝트, 북마크, 장기기억 화면 전체 모습" caption="AgentsToZ의 큰 구조입니다. 프로젝트·폴더, 북마크, 장기기억을 한 앱에서 관리합니다." />
          </div>
        </section>

        <section id="first-device" className="scroll-mt-24 border-y border-[rgb(var(--surface-highlight-rgb))]/[0.06] bg-[var(--bg-input)] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="첫 단말 · 선택 동기화" title="한 PC만 쓰면 계정 없이 바로 시작합니다.">설치 앱을 로컬로만 쓸 때 필요한 외부 계정은 0개입니다. 두 PC 이상에서 같은 목록을 쓰고 싶을 때만 Supabase 동기화를 연결하세요.</SectionTitle>
            <Steps items={[
              { title: '앱에서 사용할 방식 하나 선택', body: '한 PC에서만 쓰면 ‘로컬로 바로 시작’을 누릅니다. 여러 PC에서 동기화할 때만 ‘첫 단말 · 동기화 설정’을 선택합니다.', success: '로컬은 프로젝트 화면, 동기화는 첫 단말 설정 카드가 열림' },
              { title: '동기화를 선택한 경우에만 Supabase 준비', body: '로컬로 시작했다면 아래 단계는 모두 건너뜁니다. 동기화할 때는 새 프로젝트를 만들거나 이미 가진 프로젝트를 선택하고, 앱이 보여주는 정본 SQL을 SQL Editor에서 한 번 실행합니다.', success: '테이블 생성과 authenticated 전용 RLS 확인' },
              { title: '동기화 PC에서 Supabase CLI 로그인 1회', body: 'DB를 만드는 데 CLI가 꼭 필요한 것은 아니지만, 데스크톱 앱의 안전한 로컬 관리자 연결을 끝내려면 이 PC에서 한 번 인증합니다.', success: '“로컬 관리자 연결 완료” 표시' },
              { title: '동기화 기기 이름과 Push/Pull 확인', body: '예: “Demo Mac”. 로그인 토큰과 service_role은 다른 PC로 복사하지 않습니다.', success: '이 PC의 새 device ID와 동기화 시각 표시' },
            ]} />
            <AgentHandoff
              title="첫 단말 설정을 처음부터 끝까지 같이 진행"
              description="아래에서 내 PC에 맞는 프롬프트 하나만 복사하세요. AI가 먼저 ‘한 PC만 사용’인지 ‘여러 PC 동기화’인지 확인하고, 필요 없는 Supabase 단계는 건너뜁니다."
              actions={[
                {
                  label: 'Windows용 프롬프트 복사',
                  prompt: buildGuideJourneyPrompt({
                    journey: '첫 단말 설정',
                    goal: '한 PC만 쓰면 계정 없이 로컬로 시작하고, 여러 PC 동기화가 필요할 때만 Supabase 첫 단말 연결을 완료',
                    success: '로컬 사용자는 프로젝트 화면이 열리고, 동기화 사용자는 새 device ID와 Push/Pull 성공 시각이 표시됨',
                    scenario: 'first',
                    platform: 'windows',
                    runtimeMode: 'packaged',
                  }),
                },
                {
                  label: 'macOS용 프롬프트 복사',
                  prompt: buildGuideJourneyPrompt({
                    journey: '첫 단말 설정',
                    goal: '한 PC만 쓰면 계정 없이 로컬로 시작하고, 여러 PC 동기화가 필요할 때만 Supabase 첫 단말 연결을 완료',
                    success: '로컬 사용자는 프로젝트 화면이 열리고, 동기화 사용자는 새 device ID와 Push/Pull 성공 시각이 표시됨',
                    scenario: 'first',
                    platform: 'mac',
                    runtimeMode: 'source',
                  }),
                },
              ]}
              links={[
                { label: 'Supabase Dashboard 열기', href: SUPABASE_DASHBOARD_URL },
                { label: '보안 설정 설명서', href: SECURITY_SETUP_GUIDE_URL },
              ]}
            />
            <Screenshot src={setupImage} alt="AgentsToZ 초기 설정에서 상황을 선택하는 화면" caption="설치 화면 문구는 버전에 따라 조금 달라질 수 있습니다. 현재 화면의 ‘설치·연결 현황판’을 먼저 열면 다음 행동을 확인할 수 있습니다." />
          </div>
        </section>

        <section id="second-device" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="두 번째 Mac·Windows" title="새로 만들지 말고, 기존 것을 안전하게 이어 씁니다.">가장 쉬운 출발점은 기존 PC 앱의 ‘다른 PC 연결 정보 만들기’입니다. 개인 Vercel 포털은 선택입니다.</SectionTitle>
            <Steps items={[
              { title: '기존 PC에서 연결 정보 만들기', body: '앱 또는 개인 포털의 Mac·Windows 연결 메뉴를 사용합니다. 초대에는 공개 URL·anon/publishable key·추천 이름만 들어갑니다.', success: '짧은 연결 정보가 클립보드에 복사됨' },
              { title: '새 PC에 앱을 설치하고 붙여넣기', body: '기존 PC의 device ID, service_role, Supabase/GitHub/Vercel 로그인 토큰은 절대 옮기지 않습니다.', success: '새 PC가 자기 UUID를 생성' },
              { title: '새 PC에서 Supabase CLI 로그인', body: '이 PC의 로컬 관리자 권한은 이 PC에서 새로 확인합니다.', success: '기기 이름과 DB 등록 완료' },
              { title: 'Pull 후 경로만 다시 지정', body: '프로젝트 목록은 오지만 Mac과 Windows의 폴더 경로는 다르므로 새 PC에서 선택합니다.', success: '각 프로젝트 카드가 실제 폴더를 열 수 있음' },
            ]} />
            <AgentHandoff
              title="두 번째 PC 연결을 새 신원으로 안전하게 진행"
              description="새 Supabase·GitHub·Vercel을 만들지 않고 기존 PC의 연결 정보만 사용합니다. 새 PC는 기존 device ID를 복사하지 않고 자기 ID를 만듭니다."
              actions={[
                {
                  label: '새 Windows PC용 프롬프트 복사',
                  prompt: buildGuideJourneyPrompt({
                    journey: '두 번째 Windows PC 연결',
                    goal: '기존 PC의 연결 정보를 새 Windows 앱에 붙여넣고 새 device ID와 로컬 인증으로 등록',
                    success: '새 PC가 별도 기기로 한 번만 등록되고 Pull 뒤 실제 프로젝트 폴더를 다시 지정함',
                    scenario: 'additional',
                    platform: 'windows',
                    runtimeMode: 'packaged',
                  }),
                },
                {
                  label: '새 macOS용 프롬프트 복사',
                  prompt: buildGuideJourneyPrompt({
                    journey: '두 번째 macOS 연결',
                    goal: '기존 PC의 연결 정보를 새 Mac 앱에 붙여넣고 새 device ID와 로컬 인증으로 등록',
                    success: '새 Mac이 별도 기기로 한 번만 등록되고 Pull 뒤 실제 프로젝트 폴더를 다시 지정함',
                    scenario: 'additional',
                    platform: 'mac',
                    runtimeMode: 'source',
                  }),
                },
              ]}
              links={[{ label: '새 PC용 Windows 설치 파일', href: WINDOWS_RELEASES_URL }]}
            />
            <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] p-5 text-sm leading-6 text-amber-100/80"><strong className="text-amber-100">기억할 한 문장:</strong> 같은 클라우드를 쓰되, 각 PC는 자기 신분증(device ID)과 자기 열쇠(로컬 인증)를 가집니다.</div>
          </div>
        </section>

        <section id="aws" className="scroll-mt-24 border-y border-[rgb(var(--surface-highlight-rgb))]/[0.06] bg-[var(--bg-input)] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="AWS·Ubuntu" title="서버는 ‘호스트 먼저, 프로젝트는 나중’입니다.">AWS는 화면 없는 두 번째 PC라고 생각하면 쉽습니다. 데스크톱 초대를 복사하지 않고 클라우드·서버 전용 일회용 명령을 씁니다.</SectionTitle>
            <Steps items={[
              { title: '포털 → 기기 관리 → 클라우드·서버', body: 'AWS 호스트 이름과 만료 시간을 정해 일회용 등록 명령을 만듭니다.', success: '10분·1시간·24시간 중 선택한 유효시간 표시' },
              { title: 'SSH로 Ubuntu에 접속해 명령 1회 실행', body: '처음에는 curl·Python 3·Git 준비 상태를 확인합니다. 명령에 service_role은 들어가지 않습니다.', success: '호스트 카드가 온라인으로 바뀜' },
              { title: '런타임 준비 상태 확인', body: 'Bun·AgentsToZ 로컬 API·Hermes 상태를 각각 봅니다. API 준비 전에는 프로젝트 연결을 시작하지 않습니다.', success: 'apiReady 또는 설치 동행 프롬프트 표시' },
              { title: '필요한 프로젝트만 연결', body: '호스트 아래에 새 프로젝트, 기존 GitHub clone, 또는 장기기억 복원 중 하나를 선택합니다.', success: '프로젝트가 호스트의 하위 항목으로 표시' },
            ]} />
            <AgentHandoff
              title="AWS·Ubuntu 호스트를 먼저 등록하고 프로젝트 연결"
              description="AI가 로컬 PC와 SSH 서버를 섞지 않도록 호스트 등록 완료를 먼저 확인한 뒤 프로젝트 단계로 넘어갑니다."
              actions={[{
                label: 'AWS·Ubuntu 프롬프트 복사',
                prompt: buildGuideJourneyPrompt({
                  journey: 'AWS·Ubuntu 호스트 연결',
                  goal: '호스트 등록 → 런타임 준비 → 필요한 프로젝트 연결을 순서대로 완료',
                  success: '호스트 online, API health 정상, 선택한 프로젝트만 호스트 아래에 표시됨',
                  scenario: 'aws',
                  platform: 'linux',
                }),
              }]}
            />
          </div>
        </section>

        <section id="cloud-reuse" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionTitle eyebrow="기존 서비스 재사용" title="GitHub·Supabase·Vercel은 서로 다른 일을 합니다.">‘연동’이라는 말 때문에 전부 새로 만들기 쉽지만, 두 번째 단말에서는 세 서비스 모두 기존 것을 재사용하는 것이 원칙입니다.</SectionTitle>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                [Github, 'GitHub', '코드 보관함', '기존 저장소 remote와 기본 브랜치를 확인합니다. Windows Actions는 선택 빌드입니다.', 'gh auth status'],
                [Cloud, 'Supabase', '동기화 서랍', '기존 Project URL과 공개 key를 쓰되, 각 PC 인증과 device ID는 새로 만듭니다.', 'supabase projects list'],
                [ExternalLink, 'Vercel', '선택 웹 현관', '개인 포털을 밖에서 열 때만 필요합니다. 추가 PC 연결의 필수 조건이 아닙니다.', 'vercel whoami'],
              ].map(([Icon, title, analogy, body, verify]) => (
                <article key={String(title)} className="rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5">
                  {React.createElement(Icon as React.ComponentType<{ className?: string }>, { className: 'h-5 w-5 text-teal-300' })}
                  <h3 className="mt-4 font-semibold text-[var(--text-primary)]">{String(title)} <span className="ml-1 text-xs font-normal text-zinc-600">{String(analogy)}</span></h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">{String(body)}</p>
                  <div className="mt-4"><CopyAction value={String(verify)}>로그인 확인 명령</CopyAction></div>
                </article>
              ))}
            </div>
            <div id="self-hosting" className="mt-8 scroll-mt-24 rounded-3xl border border-emerald-300/20 bg-emerald-400/[0.04] p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">선택 기능 · 개인 웹 포털</p>
                  <h3 className="mt-2 text-xl font-bold text-[var(--text-primary)] sm:text-2xl">내 계정에 개인 웹 포털 만들기</h3>
                  <p className="mt-2 text-sm leading-7 text-zinc-400">데스크톱 앱을 설치하는 과정이 아닙니다. 앱의 북마크·프로젝트 정보를 휴대폰이나 다른 브라우저에서도 보고 싶은 사용자만 진행합니다. 내 Supabase + 내 Vercel로 완전히 분리해 씁니다.</p>
                </div>
              </div>

              <div data-testid="vercel-deploy-boundary" className="mt-6 grid gap-3 lg:grid-cols-3">
                <article className="rounded-2xl border border-emerald-300/20 bg-emerald-400/[0.045] p-4">
                  <p className="text-xs font-bold text-emerald-200">버튼이 만드는 것</p>
                  <p className="mt-2 text-xs leading-6 text-zinc-400">Vercel 가입·로그인 화면을 거쳐, 연결한 GitHub·GitLab·Bitbucket 계정에 공개 소스 사본을 만들고 내 Vercel 프로젝트와 웹 주소를 생성합니다.</p>
                </article>
                <article className="rounded-2xl border border-rose-300/15 bg-rose-400/[0.035] p-4">
                  <p className="text-xs font-bold text-rose-200">버튼이 하지 않는 것</p>
                  <p className="mt-2 text-xs leading-6 text-zinc-400">내 PC에 <code className="text-zinc-300">git clone</code>하지 않고 데스크톱 앱도 설치하지 않습니다. 원작자의 개인 Vercel·Supabase와도 연결하지 않습니다.</p>
                </article>
                <article className="rounded-2xl border border-sky-300/15 bg-sky-400/[0.035] p-4">
                  <p className="text-xs font-bold text-sky-200">완료하려면 필요한 것</p>
                  <p className="mt-2 text-xs leading-6 text-zinc-400">본인 소유의 Git 제공자·Vercel·Supabase·Google 계정과 환경 변수 2개가 필요합니다. 가입·요금제·사용량 비용은 각 서비스에서 본인이 확인합니다.</p>
                </article>
              </div>

              <Steps items={[
                { title: '개인 웹 포털이 필요한지 먼저 결정', body: '한 PC의 데스크톱 앱만 쓴다면 여기서 멈춥니다. 휴대폰·다른 브라우저 접속이 필요할 때만 다음 단계로 갑니다.', success: '만들 결과가 “데스크톱 앱”이 아니라 “내 개인 웹 주소”임을 확인' },
                { title: '내 Supabase와 데이터 권한 준비', body: '설치 앱 또는 자세한 설명서에서 정본 SQL을 실행하고 로그인할 이메일을 허용합니다. RLS는 끄지 않습니다.', success: '테이블·허용 이메일·authenticated 전용 RLS 확인' },
                { title: 'Google OAuth 준비', body: 'Google Client ID·Secret은 Supabase Google Provider에만 저장합니다. 비밀값을 Vercel URL이나 AI 채팅에 넣지 않습니다.', success: 'Supabase Google Provider가 Enabled로 표시' },
                { title: '내 Git 제공자와 Vercel에 새 프로젝트 생성', body: '아래 버튼에서 가입하거나 로그인하고 본인 계정·팀을 확인합니다. Vercel이 연결한 Git 제공자 계정에 공개 소스 사본을 만들고 새 Vercel 프로젝트를 생성합니다.', success: 'Git 제공자의 내 소스 사본과 내 Vercel 프로젝트 이름이 보임' },
                { title: '환경 변수 2개 저장 후 Production 배포', body: 'Vercel Production에 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY만 저장하고 Deploy 또는 Redeploy합니다. 회원 이메일은 Supabase DB에서만 관리하고 service_role은 넣지 않습니다.', success: 'https://<내-프로젝트>.vercel.app가 Ready로 표시' },
                { title: '발급 주소를 Supabase Redirect URLs에 연결하고 로그인', body: '내 Vercel 주소 끝의 /까지 Supabase Authentication → URL Configuration → Redirect URLs에 추가한 뒤, 같은 주소를 열어 허용한 Google 계정으로 로그인합니다.', success: '내 웹 주소에서 프로젝트·기기 화면의 실제 데이터가 열림' },
              ]} />
              <AgentHandoff
                title="개인 포털 준비부터 실제 로그인까지 동행"
                description="프롬프트를 붙여넣으면 AI가 먼저 개인 웹 포털이 필요한지 확인하고, 내 계정·현재 화면을 기준으로 다음 클릭 하나만 안내합니다. 로그인·2단계 인증·Google Client Secret은 직접 입력합니다."
                actions={[{ label: '개인 웹 포털 전체 과정 복사', prompt: SELF_HOSTING_PROMPT }]}
              />
              <div className="mt-5 flex flex-wrap gap-3">
                <a href={VERCEL_IMPORT_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-300 px-4 py-2 text-sm font-bold text-[var(--text-on-accent)] hover:bg-emerald-200">Vercel에 내 개인 포털 프로젝트 만들기 <ExternalLink className="h-4 w-4" /></a>
                <a href={SELF_HOSTING_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 hover:border-zinc-600">자세한 개인 배포 설명서 <BookOpen className="h-4 w-4" /></a>
                <a href={VERCEL_DEPLOY_BUTTON_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-sky-200 hover:text-sky-100">Vercel 공식 버튼 설명 <ExternalLink className="h-3.5 w-3.5" /></a>
              </div>
              <p className="mt-3 text-xs leading-6 text-zinc-500"><strong className="text-zinc-300">기술 이름:</strong> Vercel은 이 흐름을 “Deploy Button”이라고 부릅니다. 설치된 앱의 자동 배포를 쓰면 발급된 Vercel 주소가 앱에도 자동 저장됩니다. Deploy 버튼 URL에는 <code className="text-zinc-300">repository-url</code>만 들어가며, 비밀값은 로그인한 서비스의 비밀 입력 화면에서 직접 저장하세요.</p>
            </div>
            <Screenshot src={portalImage} alt="AgentsToZ 웹 포털에서 프로젝트와 기기를 보는 화면" caption="Vercel 포털은 브라우저에서 프로젝트와 장기기억을 보는 선택 기능입니다. Google 로그인과 서버 RLS가 함께 허용해야 데이터가 열립니다." />
          </div>
        </section>

        <section id="connections" className="scroll-mt-24 border-y border-[rgb(var(--surface-highlight-rgb))]/[0.06] bg-[var(--bg-input)] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionTitle eyebrow="다른 앱 연결" title="Buzz·Hermes·Telegram·Antigravity는 따로, 쉽게 연결합니다.">AgentsToZ의 필수 구성요소가 아닙니다. 원하는 사용 장면이 있을 때 카드 하나씩 진행하세요.</SectionTitle>
            <p className="mt-5 rounded-xl border border-violet-300/15 bg-violet-400/[0.04] px-4 py-3 text-xs leading-6 text-zinc-400"><strong className="text-violet-200">복붙 사용법:</strong> 원하는 카드의 AI 프롬프트를 복사해 Claude·Codex 새 대화에 붙여넣고, AI가 알려주는 다음 행동 하나만 실행하세요. 옆의 공식 설명 링크는 AI가 말한 화면 이름을 확인할 때 사용합니다.</p>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {[
                { id: 'buzz', name: 'Buzz', use: '에이전트·채널을 AgentsToZ 프로젝트와 연결', steps: '공식 앱 설치 → Buzz 로그인 → 에이전트·채널 준비 → AgentsToZ 프로젝트 연결 → 실제 채널 이름 확인', success: '프로젝트 카드에 Buzz channel UUID와 검증 상태 표시', url: 'https://github.com/block/buzz/releases' },
                { id: 'hermes', name: 'Hermes Agent', use: '항상 켜진 AI와 프로젝트 장기기억 연결', steps: '공식 CLI 설치 → profile 만들기 → AgentsToZ 어댑터 설치 → /reload_skills → 실제 recall 확인', success: 'profile·gateway·memory adapter가 준비됨', url: 'https://hermes-agent.nousresearch.com/' },
                { id: 'telegram', name: 'Telegram Bot', use: '휴대폰에서 Hermes와 대화', steps: 'BotFather에서 봇 생성 → token은 직접 secret 입력 → Hermes gateway 연결 → /start 테스트', success: 'gateway에서 Telegram connected, 실제 응답 수신', url: 'https://core.telegram.org/bots/tutorial' },
                { id: 'antigravity', name: 'Antigravity CLI', use: '원하는 경우 추가 AI 터미널 사용', steps: '공식 문서 확인 → OS용 설치 → 최초 로그인/신뢰를 직접 승인 → agy --version 확인', success: '현재 터미널에서 agy 실행과 로그인 확인', url: 'https://antigravity.google/docs/cli/using/' },
              ].map(item => (
                <article key={item.id} id={item.id} className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5 sm:p-6">
                  <p className="text-xs font-semibold text-teal-300">선택 기능</p><h3 className="mt-2 text-xl font-bold text-[var(--text-primary)]">{item.name}</h3><p className="mt-1 text-sm text-zinc-500">{item.use}</p>
                  <p className="mt-4 text-sm leading-7 text-zinc-300">{item.steps}</p><p className="mt-2 text-xs leading-5 text-emerald-300">성공 화면: {item.success}</p>
                  <div className="mt-5 flex flex-wrap gap-2"><SimplePrompt name={item.name} goal={item.use} success={item.success} officialUrl={item.url} /><a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 py-2 text-xs text-sky-300 hover:text-sky-200">공식 설명 <ExternalLink className="h-3.5 w-3.5" /></a></div>
                </article>
              ))}
            </div>
            <Screenshot src={aiUsageImage} alt="AgentsToZ에서 Claude와 Codex 사용 상태를 보는 패널" caption="AI 도구는 각각 독립적으로 설치·로그인합니다. 하나만 준비돼도 시작할 수 있고, 나머지는 선택입니다." />
          </div>
        </section>

        <section id="windows-update-build" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="Windows 설치·업데이트" title="설치 파일을 받는 곳부터 한 줄씩 따라갑니다.">일반 사용자는 소스를 빌드하지 않습니다. 아래 공식 릴리스에서 검증된 설치 파일을 받아 기존 앱 위에 설치하면 됩니다.</SectionTitle>
            <div className="mt-8 rounded-3xl border border-teal-300/20 bg-teal-400/[0.035] p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-2xl">
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">일반 사용자 설치·업데이트</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">이미 설치한 앱을 업데이트해도 프로젝트 목록은 앱 데이터 폴더에 남습니다. 설치 전에 실행 중인 AgentsToZ 창만 닫으세요.</p>
                </div>
                <a href={WINDOWS_RELEASES_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-4 py-2 text-sm font-bold text-[var(--text-on-accent)] hover:bg-teal-200">최신 Windows 설치 파일 열기 <ExternalLink className="h-4 w-4" /></a>
              </div>
              <Steps items={[
                { title: '실행 중인 앱을 완전히 종료', body: 'AgentsToZ 창을 닫고 5초 기다립니다. 처음 설치하는 경우에는 바로 다음 단계로 갑니다.', success: 'AgentsToZ 창이 더 이상 보이지 않음' },
                { title: '공식 릴리스의 Assets 열기', body: <>위 버튼을 누른 뒤 GitHub 페이지 아래의 <strong className="text-zinc-200">Assets</strong>를 펼칩니다. 파일명은 <code className="text-teal-200">{'AgentsToZ_byCS_<버전>_x64-setup.exe'}</code> 형식입니다.</>, success: '다운로드 목록에서 x64-setup.exe 파일이 보임' },
                { title: '다운로드한 .exe 실행', body: <>다운로드 폴더에서 설치 파일을 두 번 누릅니다. Windows 보호 화면이 나오면 주소와 파일명이 위 안내와 일치하는지 확인한 뒤에만 <strong className="text-zinc-200">추가 정보 → 실행</strong>을 누릅니다.</>, success: 'AgentsToZ_byCS 설치 화면이 열림' },
                { title: '설치 완료 뒤 앱 열기', body: '설치 버튼을 끝까지 누르고 AgentsToZ_byCS를 엽니다. 처음이면 ‘로컬로 바로 시작’을 선택합니다. 업데이트라면 기존 프로젝트 카드가 남아 있는지 확인합니다.', success: '앱 창이 열리고 프로젝트·폴더 화면이 보임' },
              ]} />
              <AgentHandoff
                title="Windows 설치 파일 찾기부터 첫 실행까지 동행"
                description="AI에게 릴리스 페이지와 현재 Windows 화면을 확인시키고, 다운로드·SmartScreen·설치 화면을 한 단계씩 진행합니다."
                actions={[{
                  label: 'Windows 설치 프롬프트 복사',
                  prompt: buildGuideJourneyPrompt({
                    journey: 'Windows 앱 설치 또는 업데이트',
                    goal: `공식 릴리스 ${WINDOWS_RELEASES_URL}에서 x64-setup.exe를 받아 안전하게 설치하고 앱 첫 화면 열기`,
                    success: 'AgentsToZ_byCS 앱 창과 프로젝트·폴더 화면이 열림',
                  }),
                }]}
                links={[{ label: '최신 Windows 설치 파일 열기', href: WINDOWS_RELEASES_URL }]}
              />
            </div>
            <div className="mt-8 overflow-hidden rounded-2xl border border-zinc-800">
              <div className="grid grid-cols-[1fr_1.4fr] border-b border-zinc-800 bg-zinc-900 px-4 py-3 text-xs font-semibold text-zinc-300"><span>개발자 상황</span><span>권장 방법</span></div>
              {[
                ['Windows 릴리스 담당자', '실제 Windows PC에서 bun run tauri:build:win 후 scripts/run-windows-packaged-e2e.ps1로 설치본·API·UI를 확인합니다.'],
                ['Windows PC가 없는 개발자', 'GitHub Actions로 artifact와 hosted smoke를 확인할 수 있지만, 대화형 Tauri UI 실기 검증을 대신하지는 못합니다.'],
              ].map(([who, method]) => <div key={who} className="grid grid-cols-[1fr_1.4fr] border-b border-zinc-800/80 bg-[var(--bg-card)] px-4 py-4 text-sm last:border-b-0"><strong className="pr-4 text-zinc-200">{who}</strong><span className="leading-6 text-zinc-400">{method}</span></div>)}
            </div>
            <div className="mt-5 rounded-2xl border border-sky-300/20 bg-sky-400/[0.05] p-5 text-sm leading-6 text-sky-100/80"><strong className="text-sky-100">자동 업데이트와 다른 점:</strong> 앱의 ‘Windows 빌드·출시 안내’ 버튼은 유지보수자용 프롬프트 복사 기능이며 자동 업데이트 기능이 아닙니다. NSIS 설치와 WebView2·권한·실제 창 동작은 Windows 실기에서 확인합니다.</div>
          </div>
        </section>

        <section className="border-t border-[rgb(var(--surface-highlight-rgb))]/[0.06] bg-[var(--bg-input)] px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-4xl text-center"><BookOpen className="mx-auto h-6 w-6 text-teal-300" /><h2 className="mt-4 text-2xl font-bold text-[var(--text-primary)]">막히면 설명을 외우지 말고, 상태를 다시 확인하세요.</h2><p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-zinc-400">이 웹 설명서는 읽기 전용입니다. 설치된 AgentsToZ 앱을 열고 헤더의 설정(로켓) → 초기 설정 → 설치·연결 현황판에서 ‘다시 검사’를 누른 뒤 AI 동행 프롬프트를 복사하세요. ‘확인 필요’는 실패가 아니며, AI가 실제 상태부터 다시 확인합니다.</p><div className="mt-6 flex flex-wrap justify-center gap-3"><span className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-5 py-3 text-sm font-bold text-[var(--text-on-accent)]"><ShieldCheck className="h-4 w-4" /> 설정은 설치된 앱에서 진행</span><a href="https://github.com/intenet1001-commits/AgentsToZ-public" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-5 py-3 text-sm text-zinc-200">GitHub README <Github className="h-4 w-4" /></a></div></div>
        </section>
      </main>
      <footer className="border-t border-zinc-900 px-4 py-6 text-center text-xs text-zinc-600">AgentsToZ_byCS · 읽기 전용 공개 설명서 · 진단·설정은 설치된 앱에서 · 비밀값을 이 페이지나 AI 채팅에 붙여넣지 마세요.</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<GuideApp />);
