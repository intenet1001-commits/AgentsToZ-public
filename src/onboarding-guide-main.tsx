import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight, BookOpen, Check, ChevronRight, Cloud, Copy, ExternalLink,
  Github, Laptop, Menu, MessageCircle, Monitor, Server, Share2, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import './index.css';
import {
  ONBOARDING_GUIDE_URL,
  ONBOARDING_SCENARIOS,
  buildOnboardingAgentPrompt,
  toolRequirement,
  toolsForScenario,
  type OnboardingPlatform,
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

const overviewImage = new URL('../docs/images/agents-toz-overview.png', import.meta.url).href;
const setupImage = new URL('../docs/images/setup-wizard-current.png', import.meta.url).href;
const dashboardImage = new URL('../docs/images/onboarding-dashboard.png', import.meta.url).href;
const portalImage = new URL('../docs/images/portal.png', import.meta.url).href;
const aiUsageImage = new URL('../docs/images/ai-usage-panel.png', import.meta.url).href;

const NAV = [
  ['start', '30초 선택'],
  ['first-device', '첫 단말'],
  ['second-device', '두 번째 PC'],
  ['aws', 'AWS·Ubuntu'],
  ['cloud-reuse', '기존 서비스 재사용'],
  ['self-hosting', '내 배포판'],
  ['connections', 'Buzz·Hermes·Telegram'],
  ['windows-update-build', 'Windows 업데이트·빌드'],
] as const;

function CopyAction({ value, children = '복사' }: { value: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })}
      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-teal-300/30 bg-teal-400/10 px-3 py-2 text-xs font-semibold text-teal-100 transition hover:bg-teal-400/15 focus-visible:outline focus-visible:outline-2"
    >
      {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
      {copied ? '복사됐어요' : children}
    </button>
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
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:border-teal-300/40 hover:text-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"
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
      <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h2>
      <p className="mt-3 text-sm leading-7 text-zinc-400 sm:text-base">{children}</p>
    </div>
  );
}

function Steps({ items }: { items: Array<{ title: string; body: React.ReactNode; success?: string }> }) {
  return (
    <ol className="mt-7 grid gap-3">
      {items.map((item, index) => (
        <li key={item.title} className="flex gap-4 rounded-2xl border border-zinc-800 bg-[#111113] p-4 sm:p-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-teal-300/30 bg-teal-400/10 text-sm font-bold text-teal-200">{index + 1}</span>
          <div>
            <h3 className="font-semibold text-zinc-100">{item.title}</h3>
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
    <figure className="mt-7 overflow-hidden rounded-2xl border border-zinc-800 bg-[#111113] shadow-2xl shadow-black/30">
      <img src={src} alt={alt} className="block h-auto w-full" loading="lazy" />
      <figcaption className="border-t border-zinc-800 px-4 py-3 text-xs leading-5 text-zinc-500">{caption}</figcaption>
    </figure>
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
  const [scenario, setScenario] = useState<OnboardingScenarioId>('first');
  const [platform, setPlatform] = useState<OnboardingPlatform>('mac');
  const tools = useMemo(() => toolsForScenario(scenario, platform), [scenario, platform]);
  const prompt = buildOnboardingAgentPrompt({ scenario, platform });
  return (
    <div className="mt-8 rounded-3xl border border-teal-300/20 bg-teal-400/[0.035] p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">내 상황에 맞는 준비 목록</h3>
          <p className="mt-1 text-xs text-zinc-500">앱 안에서는 같은 목록에 실제 설치·로그인 상태가 함께 표시됩니다.</p>
        </div>
        <CopyAction value={prompt}>AI에게 전체 과정 맡기기</CopyAction>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {ONBOARDING_SCENARIOS.map(item => (
          <button key={item.id} type="button" onClick={() => setScenario(item.id)} className={`rounded-full border px-3 py-1.5 text-xs ${scenario === item.id ? 'border-teal-300/40 bg-teal-400/15 text-teal-100' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}>{item.shortLabel}</button>
        ))}
        <span className="mx-1 hidden h-7 w-px bg-zinc-800 sm:block" />
        {(['mac', 'windows', 'linux'] as OnboardingPlatform[]).map(item => (
          <button key={item} type="button" onClick={() => setPlatform(item)} className={`rounded-full border px-3 py-1.5 text-xs ${platform === item ? 'border-sky-300/40 bg-sky-400/10 text-sky-100' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}>{item === 'mac' ? 'macOS' : item === 'windows' ? 'Windows' : 'AWS·Linux'}</button>
        ))}
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map(tool => {
          const requirement = toolRequirement(tool, scenario, platform);
          return (
            <div key={tool.id} className="rounded-xl border border-zinc-800 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-200">{tool.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[9px] ${requirement === 'required' ? 'bg-rose-500/10 text-rose-200' : requirement === 'recommended' ? 'bg-sky-500/10 text-sky-200' : 'bg-zinc-800 text-zinc-500'}`}>{requirement === 'required' ? '필수' : requirement === 'recommended' ? '권장' : '선택'}</span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-zinc-500">{tool.description}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GuideApp() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="min-h-screen bg-[#0a0a0b] text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#0a0a0b]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <a href="#top" className="flex items-center gap-2 font-semibold text-white"><ShieldCheck className="h-5 w-5 text-teal-300" /> AgentsToZ 시작 설명서</a>
          <nav className="hidden items-center gap-5 lg:flex" aria-label="설명서 목차">
            {NAV.map(([id, label]) => <a key={id} href={`#${id}`} className="text-xs text-zinc-400 hover:text-teal-200">{label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <GuideShareAction />
            <button type="button" onClick={() => setMenuOpen(value => !value)} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-zinc-800 text-zinc-300 lg:hidden" aria-label="목차 열기">{menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}</button>
          </div>
        </div>
        {menuOpen && <nav className="grid gap-1 border-t border-zinc-800 px-4 py-3 lg:hidden">{NAV.map(([id, label]) => <a key={id} href={`#${id}`} onClick={() => setMenuOpen(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900">{label}</a>)}</nav>}
      </header>

      <main id="top">
        <section className="relative overflow-hidden border-b border-white/[0.06] px-4 py-20 sm:px-6 sm:py-28">
          <div className="pointer-events-none absolute left-1/2 top-0 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-teal-400/10 blur-3xl" />
          <div className="relative mx-auto max-w-5xl text-center">
            <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-teal-300/20 bg-teal-400/[0.07] px-3 py-1.5 text-xs text-teal-200"><Sparkles className="h-3.5 w-3.5" /> 코딩을 몰라도 괜찮습니다</div>
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-6xl">필요한 것만 고르고,<br /><span className="text-teal-300">AI와 한 단계씩</span> 설치하세요.</h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-8 text-zinc-400 sm:text-lg">첫 PC, 두 번째 Mac·Windows, AWS 서버까지. 앱의 현황판을 보고 복사 버튼을 누르면 Claude·Codex를 포함한 어떤 AI도 같은 안전 규칙으로 끝까지 도와줍니다.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <a href="#start" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-5 py-3 text-sm font-bold text-zinc-950 hover:bg-teal-200">내 상황 고르기 <ArrowRight className="h-4 w-4" /></a>
              <span className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm text-zinc-200"><BookOpen className="h-4 w-4 text-teal-300" /> 읽기 전용 웹 설명서</span>
            </div>
            <p className="mx-auto mt-4 max-w-2xl text-xs leading-6 text-zinc-500">이 웹 페이지는 내 PC를 진단하거나 설정을 저장하지 않습니다. 실제 진단·설정은 <strong className="text-zinc-300">설치된 AgentsToZ 앱을 열고 헤더의 설정(로켓) → 초기 설정 → 설치·연결 현황판</strong>에서 진행하세요.</p>
          </div>
        </section>

        <section id="start" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionTitle eyebrow="30초 선택" title="먼저, 지금 상황 하나만 고르세요.">모든 서비스를 설치할 필요가 없습니다. 아래 네 가지 중 가장 가까운 것에서 시작하면 됩니다.</SectionTitle>
            <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['#first-device', Monitor, '첫 단말', '여러 PC 동기화를 처음 만듭니다.'],
                ['#second-device', Laptop, '두 번째 PC', '기존 클라우드를 그대로 씁니다.'],
                ['#aws', Server, 'AWS·Ubuntu', '서버를 호스트로 먼저 등록합니다.'],
                ['#connections', MessageCircle, 'AI·메신저 연결', '필요한 앱만 나중에 붙입니다.'],
              ].map(([href, Icon, title, body]) => (
                <a key={String(href)} href={String(href)} className="group rounded-2xl border border-zinc-800 bg-[#111113] p-5 hover:border-teal-300/30">
                  {React.createElement(Icon as React.ComponentType<{ className?: string }>, { className: 'h-5 w-5 text-teal-300' })}
                  <h3 className="mt-4 font-semibold text-white">{String(title)}</h3><p className="mt-1 text-sm leading-6 text-zinc-500">{String(body)}</p><ChevronRight className="mt-4 h-4 w-4 text-zinc-700 transition group-hover:translate-x-1 group-hover:text-teal-300" />
                </a>
              ))}
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                ['필수와 선택을 분리', 'GitHub·Vercel·AI 도구는 원하는 기능이 있을 때만 설치합니다.'],
                ['두 번째 PC는 재사용', '새 Supabase나 Vercel을 만들지 않고 기존 연결 정보를 안전하게 씁니다.'],
                ['비밀값은 직접 입력', '토큰·비밀번호·bot token은 AI 채팅이나 캡처에 넣지 않습니다.'],
              ].map(([title, body]) => <div key={title} className="rounded-xl border border-zinc-800 bg-black/20 p-4"><p className="text-sm font-semibold text-zinc-200">{title}</p><p className="mt-1 text-xs leading-5 text-zinc-500">{body}</p></div>)}
            </div>
            <ToolPlan />
            <Screenshot src={dashboardImage} alt="AgentsToZ 설치·연결 현황판에서 필수 도구가 준비됨으로 표시된 화면" caption="앱 안의 실제 설치·연결 현황판입니다. 시나리오와 OS를 바꾸면 필수·권장·선택 기준도 함께 바뀝니다." />
            <Screenshot src={overviewImage} alt="AgentsToZ 앱의 프로젝트, 북마크, 장기기억 화면 전체 모습" caption="AgentsToZ의 큰 구조입니다. 프로젝트·폴더, 북마크, 장기기억을 한 앱에서 관리합니다." />
          </div>
        </section>

        <section id="first-device" className="scroll-mt-24 border-y border-white/[0.06] bg-[#0d0d0f] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="첫 단말" title="Supabase 하나로 안전한 동기화를 시작합니다.">Supabase는 여러 PC가 같은 목록을 보는 ‘잠금장치가 있는 공용 서랍’입니다. GitHub와 Vercel은 아직 없어도 됩니다.</SectionTitle>
            <Steps items={[
              { title: '앱에서 ‘첫 단말 · 동기화 설정’ 선택', body: '로컬로만 쓸 거라면 ‘로컬로 바로 시작’을 눌러 여기서 끝내도 됩니다.', success: '첫 단말 설정 카드가 열림' },
              { title: 'Supabase Dashboard에서 프로젝트 1개 준비', body: '새 프로젝트를 만들거나 이미 가진 프로젝트를 선택합니다. 앱이 보여주는 정본 SQL을 SQL Editor에서 한 번 실행합니다.', success: '테이블 생성과 authenticated 전용 RLS 확인' },
              { title: '이 PC에서 Supabase CLI 로그인 1회', body: 'DB를 만드는 데 CLI가 꼭 필요한 것은 아니지만, 데스크톱 앱의 안전한 로컬 관리자 연결을 끝내려면 이 PC에서 한 번 인증합니다.', success: '“로컬 관리자 연결 완료” 표시' },
              { title: '기기 이름을 정하고 Push/Pull 확인', body: '예: “Demo Mac”. 로그인 토큰과 service_role은 다른 PC로 복사하지 않습니다.', success: '이 PC의 새 device ID와 동기화 시각 표시' },
            ]} />
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
            <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] p-5 text-sm leading-6 text-amber-100/80"><strong className="text-amber-100">기억할 한 문장:</strong> 같은 클라우드를 쓰되, 각 PC는 자기 신분증(device ID)과 자기 열쇠(로컬 인증)를 가집니다.</div>
          </div>
        </section>

        <section id="aws" className="scroll-mt-24 border-y border-white/[0.06] bg-[#0d0d0f] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <SectionTitle eyebrow="AWS·Ubuntu" title="서버는 ‘호스트 먼저, 프로젝트는 나중’입니다.">AWS는 화면 없는 두 번째 PC라고 생각하면 쉽습니다. 데스크톱 초대를 복사하지 않고 클라우드·서버 전용 일회용 명령을 씁니다.</SectionTitle>
            <Steps items={[
              { title: '포털 → 기기 관리 → 클라우드·서버', body: 'AWS 호스트 이름과 만료 시간을 정해 일회용 등록 명령을 만듭니다.', success: '10분·1시간·24시간 중 선택한 유효시간 표시' },
              { title: 'SSH로 Ubuntu에 접속해 명령 1회 실행', body: '처음에는 curl·Python 3·Git 준비 상태를 확인합니다. 명령에 service_role은 들어가지 않습니다.', success: '호스트 카드가 온라인으로 바뀜' },
              { title: '런타임 준비 상태 확인', body: 'Bun·AgentsToZ 로컬 API·Hermes 상태를 각각 봅니다. API 준비 전에는 프로젝트 연결을 시작하지 않습니다.', success: 'apiReady 또는 설치 동행 프롬프트 표시' },
              { title: '필요한 프로젝트만 연결', body: '호스트 아래에 새 프로젝트, 기존 GitHub clone, 또는 장기기억 복원 중 하나를 선택합니다.', success: '프로젝트가 호스트의 하위 항목으로 표시' },
            ]} />
            <SimplePrompt name="AWS·Ubuntu" goal="호스트 등록 → 런타임 준비 → 프로젝트 연결을 순서대로 완료" success="호스트 online, API health 정상, 선택 프로젝트만 연결" officialUrl={`${ONBOARDING_GUIDE_URL}#aws`} />
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
                <article key={String(title)} className="rounded-2xl border border-zinc-800 bg-[#111113] p-5">
                  {React.createElement(Icon as React.ComponentType<{ className?: string }>, { className: 'h-5 w-5 text-teal-300' })}
                  <h3 className="mt-4 font-semibold text-white">{String(title)} <span className="ml-1 text-xs font-normal text-zinc-600">{String(analogy)}</span></h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">{String(body)}</p>
                  <div className="mt-4"><CopyAction value={String(verify)}>로그인 확인 명령</CopyAction></div>
                </article>
              ))}
            </div>
            <div id="self-hosting" className="mt-8 scroll-mt-24 rounded-3xl border border-emerald-300/20 bg-emerald-400/[0.04] p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">공개판 개인 배포</p>
                  <h3 className="mt-2 text-xl font-bold text-white sm:text-2xl">내 Supabase + 내 Vercel로 완전히 분리해 씁니다.</h3>
                  <p className="mt-2 text-sm leading-7 text-zinc-400">원작자의 개인 포털이나 데이터베이스를 공유하지 않습니다. 공개 소스만 가져온 뒤 본인이 로그인한 서비스에 연결합니다.</p>
                </div>
                <CopyAction value={SELF_HOSTING_PROMPT}>AI에게 내 배포판 맡기기</CopyAction>
              </div>
              <Steps items={[
                { title: '본인 Supabase 프로젝트 준비', body: '정본 SQL을 적용하고 portmgr_allowed_members에 본인 Google 이메일을 등록합니다. authenticated 전용 RLS는 끄지 않습니다.', success: '본인 프로젝트에서 RLS와 allowed member 확인' },
                { title: '공개 GitHub를 본인 Vercel로 가져오기', body: 'Deploy with Vercel 버튼은 공개 저장소 주소만 전달합니다. Supabase 값·이메일·토큰은 URL에 넣지 않습니다.', success: '본인 계정 아래 새 Vercel 프로젝트 표시' },
                { title: 'Production 환경 변수 3개 입력', body: 'VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ALLOWED_EMAIL을 Vercel Settings에 직접 저장합니다. service_role은 절대 넣지 않습니다.', success: 'Production 재배포 완료' },
                { title: 'Google OAuth와 Redirect URL 연결', body: 'OAuth Client Secret은 Supabase Google Provider에만 넣고, 완성된 본인 Vercel URL을 Supabase Redirect URLs에 추가합니다.', success: '본인 URL에서 Google 로그인과 실제 데이터 읽기 성공' },
              ]} />
              <div className="mt-5 flex flex-wrap gap-3">
                <a href={VERCEL_IMPORT_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-300 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-emerald-200">내 계정에서 Deploy with Vercel <ExternalLink className="h-4 w-4" /></a>
                <a href={SELF_HOSTING_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 hover:border-zinc-600">자세한 개인 배포 설명서 <BookOpen className="h-4 w-4" /></a>
              </div>
              <p className="mt-3 text-xs leading-6 text-zinc-500">Deploy 버튼 URL에는 <code className="text-zinc-300">repository-url</code>만 들어갑니다. 비밀값은 로그인한 서비스의 비밀 입력 화면에서 사용자가 직접 저장하세요.</p>
            </div>
            <Screenshot src={portalImage} alt="AgentsToZ 웹 포털에서 프로젝트와 기기를 보는 화면" caption="Vercel 포털은 브라우저에서 프로젝트와 장기기억을 보는 선택 기능입니다. Google 로그인과 서버 RLS가 함께 허용해야 데이터가 열립니다." />
          </div>
        </section>

        <section id="connections" className="scroll-mt-24 border-y border-white/[0.06] bg-[#0d0d0f] px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionTitle eyebrow="다른 앱 연결" title="Buzz·Hermes·Telegram·Antigravity는 따로, 쉽게 연결합니다.">AgentsToZ의 필수 구성요소가 아닙니다. 원하는 사용 장면이 있을 때 카드 하나씩 진행하세요.</SectionTitle>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {[
                { id: 'buzz', name: 'Buzz', use: '에이전트·채널을 AgentsToZ 프로젝트와 연결', steps: '공식 앱 설치 → Buzz 로그인 → 에이전트·채널 준비 → AgentsToZ 프로젝트 연결 → 실제 채널 이름 확인', success: '프로젝트 카드에 Buzz channel UUID와 검증 상태 표시', url: 'https://github.com/block/buzz/releases' },
                { id: 'hermes', name: 'Hermes Agent', use: '항상 켜진 AI와 프로젝트 장기기억 연결', steps: '공식 CLI 설치 → profile 만들기 → AgentsToZ 어댑터 설치 → /reload_skills → 실제 recall 확인', success: 'profile·gateway·memory adapter가 준비됨', url: 'https://hermes-agent.nousresearch.com/' },
                { id: 'telegram', name: 'Telegram Bot', use: '휴대폰에서 Hermes와 대화', steps: 'BotFather에서 봇 생성 → token은 직접 secret 입력 → Hermes gateway 연결 → /start 테스트', success: 'gateway에서 Telegram connected, 실제 응답 수신', url: 'https://core.telegram.org/bots/tutorial' },
                { id: 'antigravity', name: 'Antigravity CLI', use: '원하는 경우 추가 AI 터미널 사용', steps: '공식 문서 확인 → OS용 설치 → 최초 로그인/신뢰를 직접 승인 → agy --version 확인', success: '현재 터미널에서 agy 실행과 로그인 확인', url: 'https://antigravity.google/docs/cli/using/' },
              ].map(item => (
                <article key={item.id} id={item.id} className="scroll-mt-24 rounded-2xl border border-zinc-800 bg-[#111113] p-5 sm:p-6">
                  <p className="text-xs font-semibold text-teal-300">선택 기능</p><h3 className="mt-2 text-xl font-bold text-white">{item.name}</h3><p className="mt-1 text-sm text-zinc-500">{item.use}</p>
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
            <SectionTitle eyebrow="Windows 업데이트·빌드" title="일반 사용자 업데이트와 개발자 빌드는 다릅니다.">현재 ‘Windows 빌드·출시 안내’ 버튼은 자동 업데이트 버튼이 아니라, 유지보수자가 AI에게 소스 동기화·검증·빌드·설치를 맡기는 프롬프트 복사 기능입니다.</SectionTitle>
            <div className="mt-8 overflow-hidden rounded-2xl border border-zinc-800">
              <div className="grid grid-cols-[1fr_1.4fr] border-b border-zinc-800 bg-zinc-900 px-4 py-3 text-xs font-semibold text-zinc-300"><span>상황</span><span>권장 방법</span></div>
              {[
                ['일반 사용자', '운영자가 실제 Windows에서 검증해 제공한 최신 NSIS 설치파일로 업데이트합니다. 현재 앱에는 서명된 자동업데이터가 없습니다.'],
                ['Windows 릴리스 담당자', '실제 Windows PC에서 bun run tauri:build:win 후 scripts/run-windows-packaged-e2e.ps1로 설치본·API·UI를 확인합니다.'],
                ['Windows PC가 없는 개발자', 'GitHub Actions로 artifact와 hosted smoke를 확인할 수 있지만, 대화형 Tauri UI 실기 검증을 대신하지는 못합니다.'],
              ].map(([who, method]) => <div key={who} className="grid grid-cols-[1fr_1.4fr] border-b border-zinc-800/80 bg-[#111113] px-4 py-4 text-sm last:border-b-0"><strong className="pr-4 text-zinc-200">{who}</strong><span className="leading-6 text-zinc-400">{method}</span></div>)}
            </div>
            <div className="mt-5 rounded-2xl border border-sky-300/20 bg-sky-400/[0.05] p-5 text-sm leading-6 text-sky-100/80"><strong className="text-sky-100">왜 Windows에서 빌드하나요?</strong> NSIS 설치와 WebView2·권한·실제 창 동작은 Windows 실기에서만 끝까지 확인할 수 있기 때문입니다.</div>
          </div>
        </section>

        <section className="border-t border-white/[0.06] bg-[#0d0d0f] px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-4xl text-center"><BookOpen className="mx-auto h-6 w-6 text-teal-300" /><h2 className="mt-4 text-2xl font-bold text-white">막히면 설명을 외우지 말고, 상태를 다시 확인하세요.</h2><p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-zinc-400">이 웹 설명서는 읽기 전용입니다. 설치된 AgentsToZ 앱을 열고 헤더의 설정(로켓) → 초기 설정 → 설치·연결 현황판에서 ‘다시 검사’를 누른 뒤 AI 동행 프롬프트를 복사하세요. ‘확인 필요’는 실패가 아니며, AI가 실제 상태부터 다시 확인합니다.</p><div className="mt-6 flex flex-wrap justify-center gap-3"><span className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-5 py-3 text-sm font-bold text-zinc-950"><ShieldCheck className="h-4 w-4" /> 설정은 설치된 앱에서 진행</span><a href="https://github.com/intenet1001-commits/AgentsToZ-public" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-5 py-3 text-sm text-zinc-200">GitHub README <Github className="h-4 w-4" /></a></div></div>
        </section>
      </main>
      <footer className="border-t border-zinc-900 px-4 py-6 text-center text-xs text-zinc-600">AgentsToZ_byCS · 읽기 전용 공개 설명서 · 진단·설정은 설치된 앱에서 · 비밀값을 이 페이지나 AI 채팅에 붙여넣지 마세요.</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<GuideApp />);
