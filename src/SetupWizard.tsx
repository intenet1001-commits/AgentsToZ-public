import React, { useState, useEffect } from 'react';
import { isAuthRequiredError } from './lib/supabaseClient';
import {
  Check, Copy, ChevronRight, Terminal, Database, Server,
  Globe, ArrowRight, ExternalLink, Laptop, Plus, RefreshCw, Monitor, Zap,
  ClipboardPaste, Link2, ShieldCheck,
} from 'lucide-react';
import { createDesktopDeviceInvite, parseOnboardingHandoff } from './onboardingHandoff';
import { SCHEMA_TABLE_COUNT, migrationSqlForAllowedEmails, portalSqlForAllowedEmails } from './schemaSql';
import { isTauri } from './lib/env';
import type { OnboardingDeviceStage, OnboardingDiagnosis } from './onboardingDiagnosis';
import OnboardingInfrastructureCenter from './OnboardingInfrastructureCenter';
import { buildOnboardingAgentPrompt } from './onboardingInfrastructure';
import {
  buildSelfHostingAgentPrompt,
  buildVercelImportUrl,
  publicGitHubRepositoryUrl,
} from './selfHosting';

interface SetupWizardProps {
  onComplete: (config: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    deviceName: string;
    deviceId?: string;
    setupKind?: 'first' | 'additional';
    localAdminReady?: boolean;
  }) => void | Promise<void>;
  onSkip: () => void;
  /** 이미 신원이 확정된 앱에서는 새 PC용 온보딩으로 현재 신원을 덮어쓰지 않는다. */
  hasExistingDevice?: boolean;
}

/** 포크 사용자는 VITE_REPO_URL 환경변수만 설정하면 됩니다.
 *  git clone 예시 / "이 앱 포크" 링크가 자동으로 이 저장소를 가리킵니다. */
const REPO_URL = publicGitHubRepositoryUrl((import.meta as any).env?.VITE_REPO_URL);
const REPO_CLONE_URL = REPO_URL.endsWith('.git') ? REPO_URL : `${REPO_URL}.git`;
const REPO_FORK_URL = `${REPO_URL}/fork`;
const REPO_DIR_NAME = REPO_URL.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? 'AgentsToZ_byCS';
const VERCEL_IMPORT_URL = buildVercelImportUrl(REPO_URL);
const SELF_HOSTING_AGENT_PROMPT = buildSelfHostingAgentPrompt(REPO_URL);

const PORTAL_BROWSER_ASSIST_PROMPT = `AgentsToZ_byCS 첫 단말의 개인 웹 포털 배포와 Google OAuth 설정을 브라우저에서 함께 진행해줘.

반드시 이 저장소의 onboarding 스킬과 Playwright 브라우저 자동화 지침을 먼저 읽고 따라줘.
1. 먼저 GET http://127.0.0.1:3001/api/onboarding/status 로 로컬 단말 상태를 확인해. 응답에는 비밀값이 없으며, registered가 아니면 포털 배포 전에 첫 단말 설정을 마무리해줘.
2. npx와 Playwright 사용 가능 여부를 읽기 전용으로 확인해. 새 패키지 설치가 필요하면 이유와 명령을 보여주고 내 확인을 받은 뒤 진행해.
3. headed 브라우저를 열고 매 화면에서 snapshot을 새로 얻어 현재 UI 기준으로 이동해. 기억에 의존해 버튼 위치를 추측하지 마.
4. Supabase Dashboard, Google Cloud Console, Vercel 순서로 진행해. 계정 로그인·2단계 인증·Google Client Secret 입력은 내가 브라우저에서 직접 하게 멈춰줘. 비밀번호, 쿠키, 토큰, Client Secret을 읽거나 채팅/로그/스크린샷에 남기지 마.
5. 프로젝트 생성, OAuth client 생성, 환경 변수 변경, production 배포처럼 계정 상태를 바꾸는 마지막 클릭 직전에는 무엇이 바뀌는지 한 문장으로 알리고 내 확인을 받아.
6. Vercel은 fork 없이 현재 공개 clone을 CLI로 내 계정에 배포할 수 있다. 원작자의 Vercel 프로젝트나 URL은 사용·수정하지 말고, 로그인한 계정과 대상 프로젝트를 배포 직전에 확인해. GitHub fork는 자동 업데이트가 필요할 때만 선택으로 제안해.
7. 배포가 끝나면 production URL을 Supabase Redirect URLs에 추가하고, 포털에서 Google 로그인과 portmgr_is_member() 허용을 확인해.
8. 두 번째 Mac·Windows 연결은 개인 Vercel 배포가 없어도 현재 앱의 “다른 PC 연결 정보 만들기”로 가능하다는 점을 마지막에 확인해줘.

화면 문구가 문서와 다르면 중단하지 말고 snapshot으로 현재 메뉴를 찾아 짧게 설명해줘.`;

type Mode = 'choose' | 'infrastructure' | 'first' | 'first_cli' | 'additional' | 'pair_device' | 'portal' | 'windows_env' | 'mac_env' | 'dev_env' | 'terminal_tools' | 'one_click';
type OS = 'mac' | 'windows';

interface OnboardingStatus extends OnboardingDiagnosis {
  deviceName?: string;
  hostname?: string;
}

async function loadLocalPortalConfig(): Promise<Record<string, unknown>> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke('load_portal')) as Record<string, unknown>;
  }
  const response = await fetch('/api/portal', { cache: 'no-store' });
  if (!response.ok) throw new Error(`로컬 설정 읽기 HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function loadOnboardingStatus(): Promise<OnboardingStatus> {
  const endpoint = isTauri()
    ? 'http://127.0.0.1:3001/api/onboarding/status'
    : '/api/onboarding/status';
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok) throw new Error(`온보딩 상태 확인 HTTP ${response.status}`);
  return await response.json() as OnboardingStatus;
}

// ─── CLI Auto-fill Component ──────────────────────────────────────────────────

type CliStatus = 'loading' | 'not_installed' | 'not_logged_in' | 'ready' | 'error';

function CliAutoFill({ onFill }: { onFill: (url: string, key: string) => void }) {
  const [status, setStatus] = useState<CliStatus>('loading');
  const [projects, setProjects] = useState<{ ref: string; name: string; region: string }[]>([]);
  const [selectedRef, setSelectedRef] = useState('');
  const [fetching, setFetching] = useState(false);
  const [filled, setFilled] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [loginCmd, setLoginCmd] = useState('supabase login');

  function loadStatus() {
    setStatus('loading');
    fetch('/api/supabase-cli/status')
      .then(r => r.json())
      .then(data => {
        if (data.loginCmd) setLoginCmd(data.loginCmd);
        if (!data.installed) return setStatus('not_installed');
        if (!data.loggedIn) return setStatus('not_logged_in');
        setProjects(data.projects ?? []);
        if (data.projects?.length === 1) setSelectedRef(data.projects[0].ref);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleAutoFill() {
    if (!selectedRef) return;
    setFetching(true);
    setFetchError('');
    try {
      const res = await fetch(`/api/supabase-cli/apikeys?ref=${selectedRef}`);
      const data = await res.json();
      if (data.anonKey) {
        onFill(data.projectUrl, data.anonKey);
        setFilled(true);
      } else {
        setFetchError(data.error === 'no_token' ? 'CLI 로그인 토큰을 찾을 수 없습니다. supabase login을 실행해주세요.' : 'Anon Key를 가져오지 못했습니다.');
      }
    } catch {
      setFetchError('네트워크 오류');
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${
      filled ? 'bg-green-500/5 border-green-500/30' : 'bg-violet-500/5 border-violet-500/20'
    }`}>
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="text-sm font-semibold text-violet-300">CLI 자동 가져오기</span>
        {status === 'loading' && <RefreshCw className="w-3.5 h-3.5 text-zinc-500 animate-spin ml-auto" />}
        {status === 'ready' && !filled && <span className="ml-auto text-[10px] text-green-400 font-medium">✓ CLI 인증됨</span>}
        {filled && <span className="ml-auto text-[10px] text-green-400 font-medium">✓ 자동 입력 완료</span>}
      </div>

      {status === 'loading' && (
        <p className="text-xs text-zinc-500">CLI 상태 확인 중…</p>
      )}

      {status === 'not_installed' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">Supabase CLI가 설치되어 있지 않습니다.</p>
          <div className="bg-black/40 border border-zinc-700 rounded-lg px-3 py-2 font-mono text-xs text-emerald-300 flex items-center justify-between">
            <span>{loginCmd}</span>
            <button onClick={() => navigator.clipboard.writeText(loginCmd)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors ml-3">
              <Copy className="w-3 h-3" />
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">터미널에서 위 명령 실행 후 아래 버튼을 누르세요.</p>
          <button onClick={loadStatus} className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors underline">
            상태 다시 확인
          </button>
        </div>
      )}

      {status === 'not_logged_in' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">CLI 설치됨, 로그인이 필요합니다.</p>
          <div className="bg-black/40 border border-zinc-700 rounded-lg px-3 py-2 font-mono text-xs text-emerald-300 flex items-center justify-between">
            <span>{loginCmd}</span>
            <button onClick={() => navigator.clipboard.writeText(loginCmd)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors ml-3">
              <Copy className="w-3 h-3" />
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">터미널에서 위 명령 실행 후 아래 버튼을 누르세요.</p>
          <button onClick={loadStatus} className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors underline">
            상태 다시 확인
          </button>
        </div>
      )}

      {status === 'ready' && !filled && (
        <div className="space-y-2">
          <label className="block text-[11px] text-zinc-500">프로젝트 선택</label>
          <div className="flex gap-2">
            <select
              value={selectedRef}
              onChange={e => setSelectedRef(e.target.value)}
              className="flex-1 px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-500">
              <option value="">— 프로젝트 선택 —</option>
              {projects.map(p => (
                <option key={p.ref} value={p.ref}>{p.name} ({p.ref})</option>
              ))}
            </select>
            <button
              onClick={handleAutoFill}
              disabled={!selectedRef || fetching}
              className="px-4 py-2 bg-violet-500 hover:bg-violet-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
              {fetching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              {fetching ? '가져오는 중…' : '자동 입력'}
            </button>
          </div>
          {fetchError && <p className="text-xs text-red-400">{fetchError}</p>}
        </div>
      )}

      {filled && (
        <p className="text-xs text-green-300">URL과 Anon Key가 자동으로 입력되었습니다. 아래에서 확인하세요.</p>
      )}
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function OsToggle({ os, onChange }: { os: OS; onChange: (os: OS) => void }) {
  return (
    <div className="flex items-center gap-1 bg-zinc-800 border border-zinc-700 rounded-lg p-1 w-fit mb-4">
      <button onClick={() => onChange('mac')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${os === 'mac' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
        🍎 macOS
      </button>
      <button onClick={() => onChange('windows')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${os === 'windows' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
        🪟 Windows
      </button>
    </div>
  );
}

function CodeBlock({ code, label, comment }: { code: string; label?: string; comment?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      {label && <p className="text-[10px] text-zinc-500 mb-1 font-medium">{label}</p>}
      <div className="bg-black/60 border border-zinc-700/80 rounded-lg px-4 py-3 font-mono text-sm text-emerald-300 flex items-start justify-between gap-3">
        <pre className="whitespace-pre-wrap break-all leading-relaxed flex-1">{code}</pre>
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="shrink-0 p-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 rounded transition-all mt-0.5" title="복사">
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
        </button>
      </div>
      {comment && <p className="text-[10px] text-zinc-600 mt-1">{comment}</p>}
    </div>
  );
}

function InfoBox({ children, color = 'zinc' }: { children: React.ReactNode; color?: 'zinc' | 'blue' | 'amber' | 'green' }) {
  const colors = {
    zinc: 'bg-zinc-900 border-zinc-700 text-zinc-400',
    blue: 'bg-blue-500/5 border-blue-500/20 text-blue-300',
    amber: 'bg-amber-500/5 border-amber-500/20 text-amber-300',
    green: 'bg-green-500/5 border-green-500/20 text-green-300',
  };
  return <div className={`border rounded-xl p-4 text-sm ${colors[color]}`}>{children}</div>;
}

async function configureLocalAdminFromCli(supabaseUrl: string): Promise<void> {
  const response = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/supabase-service-key/from-cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supabaseUrl }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
}

function StepDot({ num, active, done }: { num: number; active: boolean; done: boolean }) {
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-all ${
      done ? 'bg-green-500/20 border-2 border-green-500 text-green-400'
      : active ? 'bg-blue-500/20 border-2 border-blue-400 text-blue-300'
      : 'bg-zinc-800 border border-zinc-600 text-zinc-500'
    }`}>
      {done ? <Check className="w-4 h-4" /> : num}
    </div>
  );
}

// ─── Migration SQL ─────────────────────────────────────────────────────────────
// 정본은 src/schemaSql.ts (MIGRATION_SQL / PORTAL_SQL). 여기서 다시 정의하지 말 것 —
// 프리픽스 없는 구버전 테이블을 만들면 앱의 Push/Pull이 전부 PGRST205로 실패한다.

// ─── First-time Setup ──────────────────────────────────────────────────────────

function AdvancedFirstSetupWizard({ onComplete, onBack }: { onComplete: SetupWizardProps['onComplete']; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [os, setOs] = useState<OS>('mac');
  const [orgId, setOrgId] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [refId, setRefId] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [allowedEmail, setAllowedEmail] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [authRequired, setAuthRequired] = useState(false);
  const [anonAccessDetected, setAnonAccessDetected] = useState(false);
  const [testing, setTesting] = useState(false);
  const [localAdminReady, setLocalAdminReady] = useState(false);
  const [localAdminBusy, setLocalAdminBusy] = useState(false);
  const [localAdminError, setLocalAdminError] = useState('');
  const [cliReady, setCliReady] = useState(false);

  // 앱 진입 시 CLI 인증 여부 자동 확인 → 이미 준비된 경우 스킵 안내
  useEffect(() => {
    fetch('/api/supabase-cli/status').then(r => r.json()).then(d => {
      if (d.installed && d.loggedIn) setCliReady(true);
    }).catch(() => {});
  }, []);

  // refId → URL 자동 완성
  React.useEffect(() => {
    if (refId) setSupabaseUrl(`https://${refId}.supabase.co`);
  }, [refId]);

  async function testConnection() {
    if (!supabaseUrl || !supabaseAnonKey) return;
    setTesting(true); setTestResult('idle'); setAuthRequired(false); setAnonAccessDetected(false);
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { error } = await sb.from('portmgr_ports').select('id').limit(1);
      // RLS의 auth challenge는 URL/key 연결과 anon 차단이 모두 정상이라는 뜻이다.
      // 다만 Push/Pull 준비 완료는 아니므로 JWT 로그인 단계를 별도로 안내한다.
      const requiresAuth = !!error && isAuthRequiredError(error);
      setAuthRequired(requiresAuth);
      setAnonAccessDetected(!error);
      setTestResult(requiresAuth ? 'ok' : 'fail');
    } catch { setAuthRequired(false); setAnonAccessDetected(false); setTestResult('fail'); } finally { setTesting(false); }
  }

  async function configureLocalAdminAccess() {
    if (!supabaseUrl || testResult !== 'ok') return;
    setLocalAdminBusy(true);
    setLocalAdminError('');
    try {
      await configureLocalAdminFromCli(supabaseUrl);
      setLocalAdminReady(true);
    } catch (error) {
      setLocalAdminReady(false);
      setLocalAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalAdminBusy(false);
    }
  }

  const steps = [
    { title: 'Supabase 가입' },
    { title: 'CLI 설치 & 로그인' },
    { title: '프로젝트 생성' },
    { title: '프로젝트 연결' },
    { title: '테이블 생성' },
    { title: 'API Key 가져오기' },
    { title: '연결 확인' },
    { title: '이 기기 이름' },
  ];

  const cliInstall = os === 'mac'
    ? 'brew install supabase/tap/supabase'
    : `# 방법 1: Scoop (권장)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# 방법 2: npm
npm install -g supabase`;

  const createProjectCmd = os === 'mac'
    ? `# 1. Org ID 확인\nsupabase orgs list\n\n# 2. 프로젝트 생성\nsupabase projects create portmanagement \\\n  --org-id <YOUR_ORG_ID> \\\n  --db-password <원하는_비밀번호> \\\n  --region ap-northeast-1`
    : `# 1. Org ID 확인\nsupabase orgs list\n\n# 2. 프로젝트 생성 (PowerShell — 백틱으로 줄 이음)\nsupabase projects create portmanagement \`\n  --org-id <YOUR_ORG_ID> \`\n  --db-password <원하는_비밀번호> \`\n  --region ap-northeast-1`;

  const allowedEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail.trim());
  const personalizedMigrationSql = allowedEmailValid
    ? migrationSqlForAllowedEmails([allowedEmail])
    : '-- 먼저 위 입력란에 Google 로그인 허용 이메일을 입력하세요.';

  const stepContent = [
    // 0: 가입
    <div key={0} className="space-y-4">
      {cliReady && (
        <InfoBox color="green">
          <p className="font-semibold mb-1">✅ Supabase CLI 인증 확인됨</p>
          <p className="text-xs text-green-200">CLI가 이미 설치·로그인되어 있습니다. Step 1~2를 건너뛰고 <strong>Step 3 (프로젝트 생성)</strong>으로 바로 이동하거나, API Key 단계에서 자동 입력을 사용하세요.</p>
        </InfoBox>
      )}
      <p className="text-zinc-400 text-sm">Supabase는 무료 PostgreSQL 호스팅으로, 여러 기기 간 데이터 동기화에 사용합니다.</p>
      <InfoBox color="blue">
        <p className="font-semibold mb-2">가입 방법</p>
        <ol className="list-decimal list-inside space-y-1.5 text-sm">
          <li><a href="https://supabase.com" target="_blank" rel="noreferrer" className="text-blue-300 underline">supabase.com</a> 접속</li>
          <li><span className="font-medium text-white">Start your project</span> 클릭</li>
          <li>GitHub 계정으로 로그인 (권장) 또는 이메일</li>
          <li>이메일 인증 완료</li>
        </ol>
      </InfoBox>
      <InfoBox>
        <p className="text-zinc-300 text-xs">💡 Free tier: 500MB DB, 월 50,000 API 요청 — 개인/소규모 팀에 충분합니다.</p>
      </InfoBox>
    </div>,

    // 1: CLI 설치
    <div key={1} className="space-y-4">
      {cliReady ? (
        <InfoBox color="green">
          <p className="font-semibold">✅ 이미 설치·로그인됨 — 이 단계를 건너뛰어도 됩니다</p>
        </InfoBox>
      ) : (
        <p className="text-zinc-400 text-sm">Supabase CLI로 프로젝트 생성부터 테이블 생성까지 모두 터미널에서 처리합니다.</p>
      )}
      <OsToggle os={os} onChange={setOs} />
      {os === 'mac' && (
        <>
          <CodeBlock label="방법 1: Homebrew (권장)" code="brew install supabase/tap/supabase" />
          <p className="text-[11px] text-zinc-600">Homebrew를 쓰지 않는 경우에는 CPU 아키텍처별 공식 Supabase CLI 설치 문서를 따르세요. Intel 전용 압축 파일을 Apple Silicon에 안내하지 않습니다.</p>
        </>
      )}
      {os === 'windows' && (
        <>
          <InfoBox color="blue">
            <p className="text-xs font-semibold mb-2">① Scoop 패키지 매니저 설치 (없는 경우)</p>
            <p className="text-xs text-blue-200 mb-2">PowerShell을 <strong>일반 권한</strong>으로 열고 실행 (관리자 권한 사용 안 함):</p>
            <div className="bg-black/40 rounded px-3 py-2 font-mono text-xs text-emerald-300 flex items-center justify-between">
              <span>Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; irm get.scoop.sh | iex</span>
              <button onClick={() => navigator.clipboard.writeText('Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; irm get.scoop.sh | iex')} className="text-zinc-500 hover:text-zinc-300 ml-2 shrink-0"><Copy className="w-3 h-3" /></button>
            </div>
            <p className="text-[10px] text-blue-300 mt-1">설치 후 새 PowerShell 창을 열어야 <code>scoop</code>이 인식됩니다.</p>
          </InfoBox>
          <CodeBlock label="② Supabase CLI 설치 (Scoop)" code={`scoop bucket add supabase https://github.com/supabase/scoop-bucket.git\nscoop install supabase`} />
          <InfoBox color="amber">
            <p className="text-xs">⚠️ 설치 후 반드시 <strong>새 PowerShell 창</strong>을 열어야 명령이 인식됩니다. 수동 ZIP 설치는 시스템 폴더에 복사하지 말고 Supabase의 공식 설치 문서를 따르세요.</p>
          </InfoBox>
        </>
      )}
      <CodeBlock label="버전 확인" code="supabase --version" comment="1.x 이상이면 정상" />
      <CodeBlock label="로그인 (브라우저 인증)" code="supabase login" comment="브라우저가 자동으로 열립니다 — Supabase 계정으로 로그인 후 터미널로 돌아오세요" />
      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 space-y-2 text-xs text-zinc-400">
        <p className="font-semibold text-amber-300">브라우저가 안 열리거나 인증이 안 될 때</p>
        <CodeBlock code="supabase login --no-browser" label="→ 대신 이 명령 실행 (URL을 직접 복사해서 브라우저에 붙여넣기)" />
        <p className="text-[11px] text-zinc-500">그래도 안 되면 터미널을 완전히 닫고 새로 열어 다시 시도하세요.</p>
      </div>
    </div>,

    // 2: 프로젝트 생성
    <div key={2} className="space-y-4">
      <p className="text-zinc-400 text-sm">CLI로 Supabase 프로젝트를 생성합니다. 아래 순서대로 진행하세요.</p>
      <OsToggle os={os} onChange={setOs} />

      {/* Step 2-1: Org ID 확인 */}
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">① 내 Org ID 확인 (터미널에서 실행)</p>
        <CodeBlock code="supabase orgs list" />
        <div className="bg-black/30 rounded-lg p-2.5 text-[11px] font-mono text-zinc-500 space-y-0.5">
          <p className="text-zinc-600"># 출력 예시:</p>
          <p><span className="text-emerald-400">ID</span>{'                    '}NAME</p>
          <p><span className="text-yellow-300">abcdefg1234567</span>{'    '}My Org</p>
          <p className="text-zinc-600 mt-1"># ↑ 이 노란색 값이 Org ID 입니다</p>
        </div>
        <div>
          <label className="block text-[11px] text-zinc-500 mb-1">Org ID 입력 (위 결과에서 복사)</label>
          <input value={orgId} onChange={e => setOrgId(e.target.value)} placeholder="예: abcdefg1234567"
            className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
        </div>
      </div>

      {/* Step 2-2: DB Password */}
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">② DB 비밀번호 설정</p>
        <p className="text-[11px] text-zinc-500">이 비밀번호는 Supabase 데이터베이스 전용입니다. 다음 단계(연결 시)에서 한 번 더 입력하니 메모해두세요.</p>
        <input value={dbPassword} onChange={e => setDbPassword(e.target.value)} type="password" placeholder="영문+숫자+특수문자 조합 권장"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>

      {/* Step 2-3: 완성된 명령어 */}
      {orgId && dbPassword && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-300">③ 아래 명령어 복사해서 실행</p>
          <CodeBlock code={`supabase projects create portmanagement --org-id ${orgId} --db-password "${dbPassword}" --region ap-northeast-1`} />
        </div>
      )}
      {(!orgId || !dbPassword) && (
        <p className="text-[11px] text-zinc-600">① ②를 모두 입력하면 실행 명령어가 자동 완성됩니다.</p>
      )}

      <InfoBox color="amber">
        <p className="text-xs">실행 결과 마지막 줄에 <code className="text-yellow-200">Project Ref: xxxxxxxxxxxxxxx</code> 형태로 출력됩니다. 이 값을 <strong>복사해두세요</strong> — 다음 단계에서 필요합니다.</p>
        <p className="text-[11px] text-zinc-400 mt-1">💡 무료 계정은 프로젝트를 최대 2개까지 만들 수 있습니다.</p>
      </InfoBox>
    </div>,

    // 3: 프로젝트 연결
    <div key={3} className="space-y-4">
      <p className="text-zinc-400 text-sm">이전 단계에서 생성한 프로젝트를 이 앱 폴더에 연결합니다.</p>

      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">Project Ref 입력</p>
        <p className="text-[11px] text-zinc-500">
          이전 단계 <code className="text-violet-400">supabase projects create</code> 실행 결과 맨 아래에 나온 값입니다.
        </p>
        <div className="bg-black/30 rounded-lg p-2.5 text-[11px] font-mono text-zinc-500 space-y-0.5">
          <p className="text-zinc-600"># 이전 단계 출력 예시:</p>
          <p>Created a new project <span className="text-white">portmanagement</span> in region <span className="text-white">ap-northeast-1</span></p>
          <p>Project Ref: <span className="text-yellow-300">abcdefghijklmno</span></p>
          <p className="text-zinc-600"># ↑ 이 값을 아래에 붙여넣으세요</p>
        </div>
        <input value={refId} onChange={e => setRefId(e.target.value)} placeholder="예: abcdefghijklmno (15자리)"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono" />
      </div>

      {refId && (
        <>
          <CodeBlock
            label="연결 명령 실행"
            code={`supabase link --project-ref ${refId}`}
            comment={`DB 비밀번호 입력 요청 시 → 이전 단계에서 설정한 "${dbPassword ? '••••••••' : '<DB 비밀번호>'}" 입력`}
          />
          <InfoBox color="green">
            <p className="text-xs">연결 성공 시 Project URL이 자동 설정됩니다: <code className="text-white">https://{refId}.supabase.co</code></p>
          </InfoBox>
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 text-xs text-zinc-400 space-y-1">
            <p className="text-red-300 font-semibold">연결 실패 시</p>
            <p>• <strong>Error: Invalid DB password</strong> → DB 비밀번호를 다시 확인하세요 (이전 단계 Step 2에서 설정한 것)</p>
            <p>• <strong>Error: Project not found</strong> → Project Ref가 정확한지 확인하세요 (15자리)</p>
          </div>
        </>
      )}
      {!refId && <InfoBox color="amber"><p className="text-xs">위에서 Project Ref를 먼저 입력하면 연결 명령어가 자동 완성됩니다.</p></InfoBox>}
    </div>,

    // 4: 테이블 생성
    <div key={4} className="space-y-4">
      <p className="text-zinc-400 text-sm">앱에서 사용할 데이터베이스 테이블을 만드는 단계입니다. 아래 3단계를 순서대로 진행하세요.</p>
      <OsToggle os={os} onChange={setOs} />
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
        <label className="block text-xs font-semibold text-emerald-300">서버 RLS 허용 Google 이메일</label>
        <input
          type="email"
          value={allowedEmail}
          onChange={event => setAllowedEmail(event.target.value)}
          placeholder="owner@example.com"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <p className="text-[11px] text-zinc-500">이 값은 Postgres RLS의 실제 접근 권한입니다. 빈 목록은 모두 차단합니다.</p>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Supabase Dashboard → Authentication → URL Configuration → <strong>Redirect URLs</strong>에<br />
          <code>http://127.0.0.1:3001/api/auth/native/callback/*</code>을 추가하세요.
        </p>
      </div>

      {/* 4-1 */}
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">① 마이그레이션 파일 생성</p>
        <p className="text-[11px] text-zinc-500">portmanagement 폴더 안에 SQL 파일이 자동으로 만들어집니다.</p>
        <CodeBlock code="supabase migration new init_portmanagement" />
        <p className="text-[11px] text-zinc-600">
          생성 위치: <code className="text-zinc-400">supabase/migrations/[숫자]_init_portmanagement.sql</code>
        </p>
      </div>

      {/* 4-2 */}
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">② 생성된 파일에 SQL 붙여넣기</p>
        <p className="text-[11px] text-zinc-500">방금 만들어진 .sql 파일을 열고, 아래 SQL을 전체 선택 후 붙여넣기 하세요.</p>
        {os === 'windows' && (
          <div className="space-y-1">
            <p className="text-[11px] text-zinc-500">파일 열기 (PowerShell에서 실행):</p>
            <div className="bg-black/40 rounded px-3 py-1.5 font-mono text-xs text-emerald-300 flex items-center justify-between">
              <span>{'notepad (Get-ChildItem supabase\\migrations\\*.sql | Select-Object -Last 1).FullName'}</span>
              <button onClick={() => navigator.clipboard.writeText('notepad (Get-ChildItem supabase\\migrations\\*.sql | Select-Object -Last 1).FullName')} className="text-zinc-500 hover:text-zinc-300 ml-2 shrink-0"><Copy className="w-3 h-3" /></button>
            </div>
          </div>
        )}
        {os === 'mac' && (
          <div className="space-y-1">
            <p className="text-[11px] text-zinc-500">파일 열기 (터미널에서 실행):</p>
            <CodeBlock code={'open supabase/migrations/$(ls supabase/migrations/ | tail -1)'} />
          </div>
        )}
        <CodeBlock label="SQL 내용 (전체 복사 후 파일에 붙여넣기)" code={personalizedMigrationSql} />
        <p className="text-[11px] text-zinc-500">붙여넣기 후 저장(<kbd className="bg-zinc-700 px-1 rounded text-zinc-300">{os === 'mac' ? 'Cmd+S' : 'Ctrl+S'}</kbd>)하세요.</p>
      </div>

      {/* 4-3 */}
      <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-2">
        <p className="text-xs font-semibold text-zinc-300">③ DB에 적용</p>
        <CodeBlock code="supabase db push" comment="완료 시 'Finished supabase db push.' 출력" />
        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-2.5 text-[11px] text-zinc-400 space-y-1">
          <p className="text-red-300 font-semibold">실패할 때</p>
          <p>• <strong>already exists</strong> → 테이블이 이미 있는 것 — 다음 단계로 진행해도 됩니다</p>
          <p>• <strong>password authentication failed</strong> → Step 3(연결) 단계로 돌아가서 다시 link</p>
          <p>• <strong>기타 SQL 에러</strong> → SQL 파일 내용을 다시 붙여넣기 후 재시도</p>
        </div>
      </div>
    </div>,

    // 5: API Key
    <div key={5} className="space-y-4">
      <p className="text-zinc-400 text-sm">CLI로 API 키를 가져옵니다.</p>
      <CliAutoFill onFill={(url, key) => { setSupabaseUrl(url); setSupabaseAnonKey(key); if (!refId) { const m = url.match(/https:\/\/(.+)\.supabase\.co/); if (m) setRefId(m[1]!); } }} />
      {refId
        ? <CodeBlock label="(참고) 수동 조회 명령" code={`supabase projects api-keys --project-ref ${refId}`} />
        : <InfoBox color="amber"><p className="text-xs">이전 단계에서 Project Ref를 입력하거나 위 자동 입력을 사용하세요.</p></InfoBox>
      }
      <div className="bg-black/40 border border-zinc-700 rounded-lg p-3 font-mono text-xs space-y-1">
        <p className="text-zinc-500">출력 예시:</p>
        <p><span className="text-violet-300">anon</span>     <span className="text-zinc-300">eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...</span> <span className="text-green-400">← 이것 복사</span></p>
        <p><span className="text-red-400">service_role</span> <span className="text-zinc-600">eyJhbGc... ← 사용하지 말 것</span></p>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Project URL <span className="text-zinc-600">(자동 입력됨)</span></label>
          <input type="text" value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)}
            placeholder="https://xxx.supabase.co"
            className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Anon Key <span className="text-zinc-600">(service_role 아님)</span></label>
          <input type="password" value={supabaseAnonKey} onChange={e => setSupabaseAnonKey(e.target.value)}
            placeholder="eyJ..."
            className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
        </div>
      </div>
    </div>,

    // 6: 연결 확인
    <div key={6} className="space-y-4">
      <p className="text-zinc-400 text-sm">입력한 URL과 Key로 DB 연결을 확인합니다.</p>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-500">Project URL</span>
          <span className="text-white font-mono text-xs truncate max-w-48">{supabaseUrl || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-500">Anon Key</span>
          <span className="text-white font-mono text-xs">{supabaseAnonKey ? supabaseAnonKey.slice(0, 16) + '…' : '—'}</span>
        </div>
      </div>
      <button onClick={testConnection} disabled={!supabaseUrl || !supabaseAnonKey || testing}
        className={`w-full py-3 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 border ${
          testResult === 'ok' ? 'bg-green-500/10 text-green-400 border-green-500/30'
          : testResult === 'fail' ? 'bg-red-500/10 text-red-400 border-red-500/30'
          : 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border-blue-500/30 disabled:opacity-40'
        }`}>
        {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : testResult === 'ok' ? <Check className="w-4 h-4" /> : <Database className="w-4 h-4" />}
        {testing ? '연결 확인 중…' : authRequired ? '✅ URL/Key와 RLS 보호까지 정상입니다' : testResult === 'ok' ? '✅ 연결 성공! 다음 단계로 진행하세요' : testResult === 'fail' ? '❌ 연결 실패 — URL/Key 재확인' : '연결 테스트'}
      </button>
      {authRequired && !isTauri() && (
        <InfoBox color="blue">
          <p className="text-xs font-semibold">Google 로그인 단계가 남았습니다</p>
          <p className="text-xs text-blue-200 mt-1">
            완료 버튼을 누르면 시스템 브라우저에서 Google 로그인이 열리고 앱이 PKCE 세션을 받습니다.
            위 Redirect URLs 등록이 먼저 필요하며, anon key만으로는 RLS를 통과하지 않습니다.
          </p>
        </InfoBox>
      )}
      {testResult === 'fail' && (
        <>
          <InfoBox color="amber">
            {anonAccessDetected ? (
              <p className="text-xs">익명 SELECT가 허용되어 있습니다. canonical migration/RLS를 다시 적용한 뒤 재검사하세요. 이 상태에서는 동기화를 시작하면 안 됩니다.</p>
            ) : (
              <p className="text-xs space-y-1">
                <span className="block">• URL 형식: <code>https://[ref].supabase.co</code></span>
                <span className="block">• anon key 사용 여부 확인 (service_role 아님)</span>
                <span className="block">• <code>supabase db push</code>가 완료됐는지 확인</span>
              </p>
            )}
          </InfoBox>
          <button
            onClick={async () => {
              const debug = {
                timestamp: new Date().toISOString(),
                platform: navigator.platform,
                userAgent: navigator.userAgent,
                urlPrefix: supabaseUrl.slice(0, 40),
                keyPrefix: supabaseAnonKey.slice(0, 20) + '...',
                keyLength: supabaseAnonKey.length,
              };
              try { await navigator.clipboard.writeText(JSON.stringify(debug, null, 2)); }
              catch {}
            }}
            className="w-full py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors underline"
          >
            🛠 디버그 정보 복사 (에러 공유용)
          </button>
        </>
      )}
      {isTauri() && testResult === 'ok' && (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-2">
          <p className="text-sm font-semibold text-violet-200">로컬 관리자 연결 확인</p>
          <p className="text-xs leading-relaxed text-zinc-400">이미 로그인한 Supabase CLI에서 이 프로젝트의 관리자 키를 받아 이 PC의 0600 파일에만 저장합니다.</p>
          <button onClick={() => void configureLocalAdminAccess()} disabled={localAdminBusy} className={`min-h-11 w-full rounded-lg border px-3 py-2 text-xs font-semibold ${localAdminReady ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'}`}>
            {localAdminBusy ? 'Supabase CLI 확인 중…' : localAdminReady ? '✓ 로컬 관리자 연결 완료' : 'Supabase CLI에서 자동 연결'}
          </button>
          {localAdminError && <p className="text-xs text-red-300">{localAdminError}<br /><code className="text-zinc-300">supabase login</code> 후 다시 시도하세요.</p>}
        </div>
      )}
    </div>,

    // 7: 기기 이름
    <div key={7} className="space-y-4">
      <p className="text-zinc-300">마지막으로 이 기기의 이름을 입력하세요.</p>
      <p className="text-zinc-500 text-sm">여러 기기를 사용할 때 구분하는 데 쓰입니다.</p>
      <OsToggle os={os} onChange={setOs} />
      <input type="text" value={deviceName} onChange={e => setDeviceName(e.target.value)}
        placeholder={os === 'mac' ? '예: MyMacPro, 회사맥북, 집맥미니' : '예: 회사PC, 집데스크탑, 노트북'}
        className="w-full px-4 py-3 text-base bg-black/40 border border-zinc-600 text-white placeholder-zinc-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
        autoFocus />
      <div className="grid grid-cols-3 gap-2">
        {(os === 'mac'
          ? ['MyMacPro', '회사맥북', '집맥북', '맥미니', '맥스튜디오', '맥북에어']
          : ['회사PC', '집데스크탑', '노트북', '사무실PC', '게이밍PC', '미니PC']
        ).map(n => (
          <button key={n} onClick={() => setDeviceName(n)}
            className={`py-2 px-3 text-xs rounded-lg border transition-all ${deviceName === n ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
            {n}
          </button>
        ))}
      </div>
      {deviceName && testResult === 'ok' && (
        <InfoBox color="green">
          <p className="font-semibold mb-1">✅ URL/Key와 RLS 보호 검증 완료</p>
          <p className="text-xs text-zinc-300">기기: <span className="text-white">{deviceName}</span> · Supabase: {supabaseUrl.split('.')[0]?.replace('https://', '')}…</p>
        </InfoBox>
      )}
      <InfoBox color="amber">
        <p className="text-xs">{isTauri()
          ? '로컬 관리자 연결을 확인했으므로 앱에서는 Google 로그인 없이 Push/Pull을 사용합니다.'
          : <>다음 단계: 마법사 완료 후 <code>http://127.0.0.1:9000/portal.html</code>에서 Google 로그인하고 Push/Pull을 확인하세요.</>}</p>
      </InfoBox>
    </div>,
  ];

  const canNext = [
    true,                          // 0: 가입
    true,                          // 1: CLI
    !!orgId && !!dbPassword,       // 2: 프로젝트 생성
    !!refId,                       // 3: 프로젝트 연결
    allowedEmailValid,             // 4: 테이블 + 서버 owner
    !!supabaseUrl && !!supabaseAnonKey, // 5: API Key
    testResult === 'ok' && (!isTauri() || localAdminReady), // 6: 연결 + 데스크톱 로컬 관리자
    !!deviceName,                  // 7: 기기 이름
  ];

  return (
    <WizardLayout
      title="최초 세팅"
      progressColor="blue"
      steps={steps}
      step={step}
      setStep={setStep}
      canNext={canNext}
      onBack={onBack}
      onComplete={() => onComplete({ supabaseUrl, supabaseAnonKey, deviceName, setupKind: 'first', localAdminReady: !isTauri() || localAdminReady })}
      canComplete={!!deviceName && testResult === 'ok' && (!isTauri() || localAdminReady)}
    >
      {stepContent[step]}
    </WizardLayout>
  );
}

// ─── Recommended First Device Wizard ─────────────────────────────────────────

/**
 * 첫 단말의 DB/RLS 준비에는 CLI, Rust, GitHub, Vercel이 필요 없다.
 * 데스크톱 앱은 마지막에 로컬 관리자 키를 안전하게 가져오기 위해 Supabase CLI 로그인만
 * 한 번 확인한다. 프로젝트 생성·migration 전체 CLI 흐름은 고급 경로로 둔다.
 */
function FirstSetupWizard({
  onComplete,
  onBack,
  onAdvanced,
}: {
  onComplete: SetupWizardProps['onComplete'];
  onBack: () => void;
  onAdvanced: () => void;
}) {
  const [step, setStep] = useState(0);
  const [allowedEmail, setAllowedEmail] = useState('');
  const [schemaApplied, setSchemaApplied] = useState(false);
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [authRequired, setAuthRequired] = useState(false);
  const [anonAccessDetected, setAnonAccessDetected] = useState(false);
  const [testing, setTesting] = useState(false);
  const [localAdminReady, setLocalAdminReady] = useState(false);
  const [localAdminBusy, setLocalAdminBusy] = useState(false);
  const [localAdminError, setLocalAdminError] = useState('');

  const allowedEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail.trim());
  const personalizedMigrationSql = allowedEmailValid
    ? migrationSqlForAllowedEmails([allowedEmail.trim()])
    : '-- 먼저 Google 로그인 허용 이메일을 입력하세요.';

  async function testConnection() {
    if (!supabaseUrl || !supabaseAnonKey) return;
    setTesting(true);
    setTestResult('idle');
    setAuthRequired(false);
    setAnonAccessDetected(false);
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { error } = await sb.from('portmgr_ports').select('id').limit(1);
      const requiresAuth = !!error && isAuthRequiredError(error);
      setAuthRequired(requiresAuth);
      setAnonAccessDetected(!error);
      setTestResult(requiresAuth ? 'ok' : 'fail');
    } catch {
      setTestResult('fail');
    } finally {
      setTesting(false);
    }
  }

  async function configureLocalAdminAccess() {
    if (!supabaseUrl || testResult !== 'ok') return;
    setLocalAdminBusy(true);
    setLocalAdminError('');
    try {
      await configureLocalAdminFromCli(supabaseUrl);
      setLocalAdminReady(true);
    } catch (error) {
      setLocalAdminReady(false);
      setLocalAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalAdminBusy(false);
    }
  }

  const steps = [
    { title: '동기화 DB 준비' },
    { title: '안전한 연결 확인' },
    { title: '첫 단말 이름' },
  ];

  const stepContent = [
    <div key={0} className="space-y-4">
      <InfoBox color="blue">
        <p className="font-semibold mb-1">필요한 것은 Supabase 프로젝트 1개뿐입니다</p>
        <p className="text-xs text-blue-200">CLI·GitHub·Vercel·Rust·터미널 도구는 이 단계에 필요하지 않습니다. Supabase Dashboard에서 무료 프로젝트를 만든 뒤 SQL을 한 번 적용하세요.</p>
      </InfoBox>
      <a
        href="https://supabase.com/dashboard/projects"
        target="_blank"
        rel="noreferrer"
        className="w-full py-2.5 rounded-xl text-sm font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center justify-center gap-2"
      >
        Supabase Dashboard 열기 <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-zinc-300">Google 로그인 허용 이메일</label>
        <input
          type="email"
          value={allowedEmail}
          onChange={event => { setAllowedEmail(event.target.value); setSchemaApplied(false); }}
          placeholder="owner@example.com"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <p className="text-[11px] text-zinc-500">Dashboard → SQL Editor → New query에서 아래 SQL 전체를 실행합니다. 빈 이메일은 모든 사용자를 차단하므로 허용하지 않습니다.</p>
      </div>
      <CodeBlock label={`테이블 ${SCHEMA_TABLE_COUNT}개 + authenticated 전용 RLS (정본)`} code={personalizedMigrationSql} />
      <InfoBox color="amber">
        <p className="text-xs">Authentication → URL Configuration → Redirect URLs에 <code>http://127.0.0.1:3001/api/auth/native/callback/*</code>도 추가하세요.</p>
      </InfoBox>
      <label className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${allowedEmailValid ? 'border-emerald-500/30 bg-emerald-500/5 text-zinc-300' : 'border-zinc-800 text-zinc-600'}`}>
        <input
          type="checkbox"
          checked={schemaApplied}
          disabled={!allowedEmailValid}
          onChange={event => setSchemaApplied(event.target.checked)}
          className="mt-0.5 accent-emerald-500"
        />
        <span><strong>SQL 실행과 Redirect URL 등록을 완료했습니다</strong><br /><span className="text-zinc-500">다음 단계에서 익명 접근이 실제로 차단되는지도 검사합니다.</span></span>
      </label>
    </div>,
    <div key={1} className="space-y-4">
      <p className="text-sm text-zinc-400">Dashboard → Project Settings → API에서 Project URL과 anon/public key를 복사하세요.</p>
      <CliAutoFill onFill={(url, key) => { setSupabaseUrl(url); setSupabaseAnonKey(key); setTestResult('idle'); }} />
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Project URL</label>
        <input
          value={supabaseUrl}
          onChange={event => { setSupabaseUrl(event.target.value); setTestResult('idle'); }}
          placeholder="https://xxx.supabase.co"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Anon Key</label>
        <input
          type="password"
          value={supabaseAnonKey}
          onChange={event => { setSupabaseAnonKey(event.target.value); setTestResult('idle'); }}
          placeholder="eyJ..."
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
        />
      </div>
      <button
        onClick={testConnection}
        disabled={!supabaseUrl || !supabaseAnonKey || testing}
        className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 border ${
          testResult === 'ok' ? 'bg-green-500/10 text-green-400 border-green-500/30'
          : testResult === 'fail' ? 'bg-red-500/10 text-red-400 border-red-500/30'
          : 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border-blue-500/30 disabled:opacity-40'
        }`}
      >
        {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : testResult === 'ok' ? <Check className="w-4 h-4" /> : <Database className="w-4 h-4" />}
        {testing ? '확인 중…' : authRequired ? 'URL/Key 정상 · 익명 접근 차단 정상' : testResult === 'fail' ? '연결 또는 RLS 검증 실패' : '연결과 보안 테스트'}
      </button>
      {testResult === 'fail' && (
        <InfoBox color="amber">
          <p className="text-xs">{anonAccessDetected ? '익명 SELECT가 허용되어 있습니다. 위 canonical SQL을 다시 실행하세요.' : 'URL/key와 테이블 생성 여부를 확인하세요.'}</p>
        </InfoBox>
      )}
      {authRequired && !isTauri() && (
        <InfoBox color="green">
          <p className="text-xs">RLS가 anon을 거부했습니다. 이것이 정상입니다. 완료 후 portal.html에서 Google 로그인하면 Push/Pull이 활성화됩니다.</p>
        </InfoBox>
      )}
      {isTauri() && testResult === 'ok' && (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-2">
          <p className="text-sm font-semibold text-violet-200">이 앱의 로컬 관리자 연결</p>
          <p className="text-xs leading-relaxed text-zinc-400">앱 로그인 대신 이 PC의 Supabase CLI가 service_role 키를 직접 받아 로컬 0600 파일에만 저장합니다. 키는 WebView나 포털로 반환되지 않습니다.</p>
          <CodeBlock label="이 PC에서 한 번 로그인" code="supabase login" comment="CLI가 없으면 macOS는 brew install supabase/tap/supabase, Windows는 Scoop의 supabase 패키지를 먼저 설치하세요." />
          <button onClick={() => void configureLocalAdminAccess()} disabled={localAdminBusy} className={`min-h-11 w-full rounded-lg border px-3 py-2 text-xs font-semibold ${localAdminReady ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20'}`}>
            {localAdminBusy ? 'Supabase CLI 확인 중…' : localAdminReady ? '✓ 로컬 관리자 연결 완료' : 'Supabase CLI에서 자동 연결'}
          </button>
          {localAdminError && <p className="text-xs text-red-300">{localAdminError}<br /><code className="text-zinc-300">supabase login</code> 후 다시 시도하세요.</p>}
        </div>
      )}
    </div>,
    <div key={2} className="space-y-4">
      <p className="text-sm text-zinc-300">동기화 화면에 표시할 첫 단말 이름을 정하세요.</p>
      <input
        value={deviceName}
        onChange={event => setDeviceName(event.target.value)}
        placeholder="예: 회사맥북, 메인PC"
        autoFocus
        className="w-full px-4 py-3 text-base bg-black/40 border border-zinc-600 text-white placeholder-zinc-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <div className="grid grid-cols-3 gap-2">
        {['메인맥북', '회사PC', '집데스크탑', '맥미니', '노트북', '메인단말'].map(name => (
          <button key={name} onClick={() => setDeviceName(name)} className={`py-2 px-3 text-xs rounded-lg border ${deviceName === name ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-zinc-900 text-zinc-400 border-zinc-700'}`}>{name}</button>
        ))}
      </div>
      <InfoBox color="blue">
        <p className="text-xs">{isTauri()
          ? '로컬 관리자 연결이 확인됐으므로 완료 후 바로 첫 Push를 확인할 수 있습니다. 사용자 로그인은 필요하지 않습니다.'
          : '완료 후 포털에서 Google 로그인 → root 앱에서 첫 Push를 확인하세요. 두 번째 단말은 포털의 “단말 연결”에서 정보를 한 번 복사해 연결할 수 있습니다.'}</p>
      </InfoBox>
    </div>,
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 pt-4 flex justify-end">
        <button onClick={onAdvanced} className="text-[11px] text-zinc-500 hover:text-zinc-300 underline">CLI로 프로젝트 생성부터 진행</button>
      </div>
      <div className="flex-1 min-h-0">
        <WizardLayout
          title="첫 단말 · 동기화 세팅"
          progressColor="blue"
          steps={steps}
          step={step}
          setStep={setStep}
          canNext={[allowedEmailValid && schemaApplied, testResult === 'ok' && (!isTauri() || localAdminReady), !!deviceName.trim()]}
          onBack={onBack}
          onComplete={() => onComplete({ supabaseUrl, supabaseAnonKey, deviceName: deviceName.trim(), setupKind: 'first', localAdminReady: !isTauri() || localAdminReady })}
          canComplete={testResult === 'ok' && !!deviceName.trim() && (!isTauri() || localAdminReady)}
        >
          {stepContent[step]}
        </WizardLayout>
      </div>
    </div>
  );
}

// ─── Additional Device Wizard ──────────────────────────────────────────────────

function AdditionalDeviceWizard({ onComplete, onBack }: { onComplete: SetupWizardProps['onComplete']; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [os, setOs] = useState<OS>('mac');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [authRequired, setAuthRequired] = useState(false);
  const [anonAccessDetected, setAnonAccessDetected] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pasteStatus, setPasteStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [pasteMessage, setPasteMessage] = useState('');
  const [freshDeviceRequired, setFreshDeviceRequired] = useState(true);
  const [localAdminReady, setLocalAdminReady] = useState(false);
  const [localAdminBusy, setLocalAdminBusy] = useState(false);
  const [localAdminError, setLocalAdminError] = useState('');
  // 완료 요청의 응답이 끊겨도 같은 ID로 upsert를 재시도해야 한다. 렌더/단계 이동마다
  // 새 UUID를 만들면 서버에는 성공한 첫 ID가 유령 행으로 남을 수 있다.
  const [pendingDeviceId] = useState(() => crypto.randomUUID());

  async function testConnection(url?: string, key?: string) {
    const u = url ?? supabaseUrl;
    const k = key ?? supabaseAnonKey;
    if (!u || !k) return;
    setTesting(true); setTestResult('idle'); setAuthRequired(false); setAnonAccessDetected(false);
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(u, k, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { error } = await sb.from('portmgr_ports').select('id').limit(1);
      const requiresAuth = !!error && isAuthRequiredError(error);
      setAuthRequired(requiresAuth);
      setAnonAccessDetected(!error);
      setTestResult(requiresAuth ? 'ok' : 'fail');
    } catch { setAuthRequired(false); setAnonAccessDetected(false); setTestResult('fail'); } finally { setTesting(false); }
  }

  async function handlePasteSetup() {
    setPasteStatus('idle'); setPasteMessage('');
    try {
      const raw = await navigator.clipboard.readText();
      if (!raw.trim()) throw new Error('클립보드가 비어있습니다');
      const payload = parseOnboardingHandoff(raw);

      setSupabaseUrl(payload.supabaseUrl);
      setSupabaseAnonKey(payload.supabaseAnonKey);
      setFreshDeviceRequired(payload.freshDeviceRequired !== false);
      setLocalAdminReady(false);
      setLocalAdminError('');
      if (payload.deviceName) {
        if (!deviceName.trim()) setDeviceName(payload.deviceName);
      }
      setPasteStatus('success');
      setPasteMessage(
        payload.version === 3 && payload.deviceName
          ? `✓ '${payload.deviceName}' 새 단말 연결 정보 입력 — 연결 테스트 중`
          : payload.deviceName
            ? `✓ 구형 연결 정보를 읽었습니다. '${payload.deviceName}' 이름만 사용하고 기존 단말 ID는 복사하지 않습니다.`
          : '✓ URL/Key 자동 입력됨 — 연결 테스트 자동 실행'
      );
      // 자동 연결 테스트
      void testConnection(payload.supabaseUrl, payload.supabaseAnonKey);
    } catch (e: any) {
      setPasteStatus('error');
      setPasteMessage('❌ ' + (e?.message ?? e) + ' — 배포 포털의 "단말 연결 → Mac·Windows 연결"에서 다시 복사하세요');
    }
  }

  async function configureLocalAdminAccess() {
    if (!supabaseUrl || testResult !== 'ok') return;
    setLocalAdminBusy(true);
    setLocalAdminError('');
    try {
      await configureLocalAdminFromCli(supabaseUrl);
      setLocalAdminReady(true);
    } catch (error) {
      setLocalAdminReady(false);
      setLocalAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalAdminBusy(false);
    }
  }

  const desktopAppRuntime = isTauri();
  const steps = [
    { title: desktopAppRuntime ? '보안 준비' : '앱 준비' },
    { title: '연결 정보 확인' },
    { title: '이 기기 등록' },
  ];

  const cloneCmd = os === 'mac'
    ? `git clone ${REPO_CLONE_URL}
cd ${REPO_DIR_NAME}
bun install
bun run start`
    : `git clone ${REPO_CLONE_URL}
cd ${REPO_DIR_NAME}
# Bun 설치 (없는 경우): https://bun.sh
bun install
bun run start`;

  const stepContent = [
    <div key={0} className="space-y-4">
      <OsToggle os={os} onChange={setOs} />
      {desktopAppRuntime ? (
        <>
          <InfoBox color="green">
            <p className="font-semibold">✓ AgentsToZ 앱 준비 완료</p>
            <p className="mt-1 text-xs text-zinc-300">이 앱 자체는 이미 설치되어 있습니다. 기존 PC의 비밀키를 복사하지 않기 위해 이 PC에서 Supabase CLI 인증만 한 번 확인합니다.</p>
          </InfoBox>
          {os === 'mac' ? (
            <CodeBlock label="Supabase CLI 설치 (없는 경우)" code="brew install supabase/tap/supabase" />
          ) : (
            <CodeBlock label="Supabase CLI 설치 (PowerShell · 없는 경우)" code={`scoop bucket add supabase https://github.com/supabase/scoop-bucket.git\nscoop install supabase`} />
          )}
          <CodeBlock label="이 PC에서 한 번 로그인" code="supabase login" comment="브라우저 인증 후 앱으로 돌아오세요. 토큰은 이 PC 밖으로 전송되지 않습니다." />
        </>
      ) : (
        <>
          <p className="text-zinc-400 text-sm">동일한 코드를 이 기기에 설치합니다.</p>
          {os === 'windows' && (
            <div className="space-y-3">
              <CodeBlock label="① Bun 설치 (없는 경우)" code={`powershell -c "irm bun.sh/install.ps1 | iex"`} comment="PowerShell에서 실행, 설치 후 새 터미널 창 열기" />
              <CodeBlock label="② Git 설치 (없는 경우)" code="winget install Git.Git" comment="또는 https://git-scm.com 에서 다운로드" />
            </div>
          )}
          {os === 'mac' && <CodeBlock label="① Bun 설치 (없는 경우)" code={`curl -fsSL https://bun.sh/install | bash`} comment="이미 있으면 건너뛰기" />}
          <CodeBlock label={os === 'windows' ? '③ 저장소 클론 & 실행 (PowerShell)' : '② 저장소 클론 & 실행'} code={cloneCmd} />
          <CodeBlock label="또는: 이미 폴더가 있는 경우" code={`cd ${REPO_DIR_NAME}\ngit pull\nbun run start`} />
          <InfoBox>
            <p className="text-xs text-zinc-400">실행 후 브라우저에서 <code className="text-emerald-400">http://localhost:9000</code> 접속{os === 'windows' && ' — 방화벽 허용 팝업이 뜨면 허용을 클릭하세요'}</p>
          </InfoBox>
        </>
      )}
    </div>,

    <div key={1} className="space-y-4">
      <p className="text-zinc-400 text-sm">기존 기기와 동일한 Supabase URL + Anon Key를 입력하세요.</p>

      {/* ★ Handoff: 포털 웹에서 복사한 설정 붙여넣기 (가장 쉬운 방법) */}
      <div className="border-2 border-blue-500/40 bg-blue-500/5 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-blue-400" />
          <p className="text-sm font-semibold text-blue-300">기존 PC 앱 또는 개인 포털의 연결 정보 붙여넣기</p>
        </div>
        <p className="text-xs text-zinc-400">가장 쉬운 방법은 기존 PC 앱의 <span className="text-blue-300">다른 PC 연결 정보 만들기</span>입니다. 개인 포털이 있다면 기기 관리 → Mac·Windows 연결에서도 복사할 수 있습니다.</p>
        <button
          onClick={handlePasteSetup}
          className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 border border-blue-500/40"
        >
          <ClipboardPaste className="w-4 h-4" />클립보드에서 붙여넣기
        </button>
        {pasteStatus !== 'idle' && (
          <p className={`text-xs mt-1 ${pasteStatus === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
            {pasteMessage}
          </p>
        )}
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-zinc-800"></div></div>
        <div className="relative flex justify-center"><span className="px-3 text-[10px] text-zinc-600 bg-[#0a0a0b]">또는 수동 입력</span></div>
      </div>

      <CliAutoFill onFill={(url, key) => { setSupabaseUrl(url); setSupabaseAnonKey(key); }} />
      <InfoBox color="amber">
        <p className="text-xs">💡 포털에 접근할 수 없다면 기존 기기의 설정에서 Project URL + Anon Key를 확인할 수 있습니다.</p>
        <p className="text-xs mt-1">GitHub · Vercel · Supabase CLI 로그인 토큰은 전송되지 않습니다. 각 기기에서 CLI 로그인을 별도로 진행하세요.</p>
      </InfoBox>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Project URL</label>
        <input type="text" value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)} placeholder="https://xxx.supabase.co"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Anon Key</label>
        <input type="password" value={supabaseAnonKey} onChange={e => setSupabaseAnonKey(e.target.value)} placeholder="eyJ..."
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
      </div>
      <button onClick={() => testConnection()} disabled={!supabaseUrl || !supabaseAnonKey || testing}
        className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 border ${
          testResult === 'ok' ? 'bg-green-500/10 text-green-400 border-green-500/30'
          : testResult === 'fail' ? 'bg-red-500/10 text-red-400 border-red-500/30'
          : 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border-blue-500/30 disabled:opacity-40'
        }`}>
        {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : testResult === 'ok' ? <Check className="w-4 h-4" /> : <Database className="w-4 h-4" />}
        {testing ? '확인 중…' : authRequired ? '✅ URL/Key와 RLS 보호까지 정상입니다' : testResult === 'fail' ? '❌ 연결 또는 RLS 검증 실패' : '연결 테스트'}
      </button>
      {authRequired && !isTauri() && (
        <InfoBox color="blue">
          <p className="text-xs font-semibold">Google 로그인 단계가 남았습니다</p>
          <p className="text-xs text-blue-200 mt-1">
            마법사 완료 후 <code>http://127.0.0.1:9000/portal.html</code>에서 로그인하고 root 앱으로 돌아와 Push/Pull을 확인하세요.
          </p>
        </InfoBox>
      )}
      {testResult === 'fail' && (
        <>
          {anonAccessDetected && (
            <InfoBox color="amber">
              <p className="text-xs">익명 SELECT가 허용되어 있습니다. canonical migration/RLS를 다시 적용한 뒤 재검사하세요.</p>
            </InfoBox>
          )}
          <button
            onClick={async () => {
              const debug = {
                timestamp: new Date().toISOString(),
                platform: navigator.platform,
                userAgent: navigator.userAgent,
                urlPrefix: supabaseUrl.slice(0, 40),
                keyPrefix: supabaseAnonKey.slice(0, 20) + '...',
                keyLength: supabaseAnonKey.length,
                wasPasted: pasteStatus === 'success',
              };
              try { await navigator.clipboard.writeText(JSON.stringify(debug, null, 2)); }
              catch {}
            }}
            className="w-full py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors underline"
          >
            🛠 디버그 정보 복사 (에러 공유용)
          </button>
        </>
      )}
    </div>,

    <div key={2} className="space-y-4">
      <InfoBox color="green">
        <p className="font-semibold mb-1">새 단말 신원</p>
        <p className="text-xs text-zinc-300">이 기기는 새 단말 ID를 자동 생성합니다. 포털에서 미리 빈 단말을 만들거나 다른 컴퓨터의 ID를 복사하지 않습니다.</p>
      </InfoBox>
      <p className="text-zinc-300">이 기기의 이름을 입력하세요. 기존 기기와 다른 이름을 사용하세요.</p>
      <OsToggle os={os} onChange={setOs} />
      <input type="text" value={deviceName} onChange={e => setDeviceName(e.target.value)}
        placeholder={os === 'mac' ? '예: 회사맥북, 집맥북' : '예: 회사PC, 집데스크탑'}
        className="w-full px-4 py-3 text-base bg-black/40 border border-zinc-600 text-white placeholder-zinc-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
        autoFocus />
      <div className="grid grid-cols-3 gap-2">
        {(os === 'mac'
          ? ['회사맥북', '집맥북', '맥미니', '맥북에어', '맥스튜디오', '사이드맥']
          : ['회사PC', '집데스크탑', '노트북', '사무실PC', '게이밍PC', '미니PC']
        ).map(n => (
          <button key={n} onClick={() => setDeviceName(n)}
            className={`py-2 px-3 text-xs rounded-lg border transition-all ${deviceName === n ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'}`}>
            {n}
          </button>
        ))}
      </div>
      {deviceName && testResult === 'ok' && (
        <InfoBox color="green">
          <p className="font-semibold mb-1">✅ URL/Key와 RLS 보호 검증 완료</p>
          <p className="text-xs text-zinc-300">기기: <span className="text-white">{deviceName}</span> · 새 ID 생성</p>
        </InfoBox>
      )}
      <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-2">
        <p className="text-sm font-semibold text-violet-200">로컬 관리자 연결 확인</p>
        <p className="text-xs leading-relaxed text-zinc-400">앱 로그인을 없앤 대신 이 PC가 Supabase CLI에서 자기 관리자 키를 직접 받아 로컬 전용 파일(0600)에 저장합니다. 포털 연결 정보에는 service_role 키가 들어 있지 않습니다.</p>
        <button onClick={() => void configureLocalAdminAccess()} disabled={localAdminBusy || testResult !== 'ok'} className={`min-h-11 w-full rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${localAdminReady ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 disabled:opacity-40'}`}>
          {localAdminBusy ? 'Supabase CLI 확인 중…' : localAdminReady ? '✓ 로컬 관리자 연결 완료' : 'Supabase CLI에서 자동 연결'}
        </button>
        {localAdminError && <p className="text-xs leading-relaxed text-red-300">{localAdminError}<br /><code className="text-zinc-300">supabase login</code>을 이 PC에서 한 번 실행한 뒤 다시 시도하세요.</p>}
        {!localAdminReady && <p className="text-[10px] text-zinc-400">관리자 연결이 확인돼야 완료할 수 있습니다. 로그인 토큰과 service_role 키는 다른 단말이나 포털로 전송되지 않습니다.</p>}
      </div>
    </div>,
  ];

  const canNext = [true, testResult === 'ok', !!deviceName];

  return (
    <WizardLayout
      title="추가 단말 세팅"
      progressColor="emerald"
      steps={steps}
      step={step}
      setStep={setStep}
      canNext={canNext}
      onBack={onBack}
      onComplete={() => onComplete({
        supabaseUrl,
        supabaseAnonKey,
        deviceName,
        deviceId: pendingDeviceId,
        setupKind: 'additional',
        localAdminReady,
      })}
      canComplete={!!deviceName && testResult === 'ok' && freshDeviceRequired && localAdminReady}
    >
      {stepContent[step]}
    </WizardLayout>
  );
}

// ─── Existing Device → New Desktop Invite ───────────────────────────────────

function AdditionalDeviceInviteWizard({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [copied, setCopied] = useState(false);
  const [portal, setPortal] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let cancelled = false;
    void loadLocalPortalConfig()
      .then(config => {
        if (cancelled) return;
        setPortal(config);
      })
      .catch(reason => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const hasConfirmedIdentity = (
    typeof portal.deviceId === 'string'
    && portal.deviceId.length > 0
    && portal.pendingDeviceRegistration !== true
  );
  const hasConnection = (
    typeof portal.supabaseUrl === 'string'
    && typeof portal.supabaseAnonKey === 'string'
  );

  async function copyInvite() {
    setError('');
    try {
      if (!hasConfirmedIdentity || !hasConnection) {
        throw new Error('이 앱의 첫 단말 등록과 Supabase 연결을 먼저 완료하세요.');
      }
      const invite = createDesktopDeviceInvite({
        supabaseUrl: portal.supabaseUrl as string,
        supabaseAnonKey: portal.supabaseAnonKey as string,
        suggestedDeviceName: deviceName,
      });
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8">
      <button onClick={onBack} className="mb-6 text-sm text-zinc-500 transition-colors hover:text-zinc-300">← 돌아가기</button>
      <div className="mx-auto w-full max-w-xl space-y-5">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-white"><Link2 className="h-5 w-5 text-violet-400" />다른 PC 연결 정보 만들기</h2>
          <p className="mt-1 text-sm text-zinc-500">개인 Vercel 포털을 만들지 않아도 여러 Mac·Windows를 연결할 수 있습니다.</p>
        </div>

        <InfoBox color="green">
          <p className="font-semibold">현재 앱이 등록된 단말인지 먼저 확인합니다</p>
          <p className="mt-1 text-xs text-zinc-300">확정된 단말 ID와 Supabase 공개 연결 정보가 있을 때만 초대를 만듭니다. 현재 단말 ID는 전달하지 않습니다.</p>
        </InfoBox>

        {loading ? (
          <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400"><RefreshCw className="h-4 w-4 animate-spin" />로컬 단말 상태 확인 중…</div>
        ) : (
          <>
            <div className={`rounded-xl border p-4 text-sm ${hasConfirmedIdentity && hasConnection ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-200'}`}>
              {hasConfirmedIdentity && hasConnection
                ? `✓ 등록된 단말 확인${typeof portal.deviceName === 'string' && portal.deviceName ? ` · ${portal.deviceName}` : ''}`
                : '첫 단말 등록이 아직 완료되지 않았습니다.'}
            </div>
            <label className="block space-y-1.5 text-xs font-semibold text-zinc-300">
              새 PC에서 사용할 이름
              <input
                value={deviceName}
                onChange={event => setDeviceName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void copyInvite(); }}
                placeholder="예: 회사 Windows, 집 MacBook"
                autoFocus
                className="min-h-11 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm font-normal text-white outline-none placeholder:text-zinc-600 focus:border-violet-500"
              />
            </label>
            <button
              onClick={() => void copyInvite()}
              disabled={!hasConfirmedIdentity || !hasConnection || !deviceName.trim()}
              className="min-h-11 w-full rounded-xl border border-violet-500/40 bg-violet-500/15 px-4 py-2.5 text-sm font-semibold text-violet-200 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied ? '✓ 연결 정보 복사됨' : '연결 정보 복사'}
            </button>
          </>
        )}

        {error && <InfoBox color="amber"><p className="text-xs">{error}</p></InfoBox>}

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-xs font-semibold text-zinc-300">새 PC에서는</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-zinc-400">
            <li>공개 저장소를 clone하고 앱을 실행합니다.</li>
            <li><span className="text-zinc-200">두 번째·추가 기기 연결</span>을 선택해 방금 복사한 정보를 붙여넣습니다.</li>
            <li>그 PC에서만 <code>supabase login</code>을 한 번 확인하면 새 UUID로 등록됩니다.</li>
          </ol>
          <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">초대에는 Project URL·anon/publishable key·추천 이름만 들어갑니다. service_role, 로그인 토큰, 기존 단말 ID는 포함하지 않습니다.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Portal Vercel Wizard ─────────────────────────────────────────────────────

// PORTAL_SQL 정본도 src/schemaSql.ts 에 있다.

// ─── Shared helpers ───────────────────────────────────────────────────────────

function CmdBlock({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="relative group">
      {label && <p className="text-[10px] text-zinc-500 mb-1">{label}</p>}
      <div className="flex items-center gap-2 bg-zinc-800/80 border border-zinc-700/50 rounded-lg px-3 py-2">
        <code className="text-xs text-zinc-200 font-mono flex-1 select-all">{cmd}</code>
        <button
          onClick={() => { navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className={`w-1.5 h-1.5 rounded-full transition-all ${i === current ? 'bg-blue-400 w-3' : i < current ? 'bg-zinc-500' : 'bg-zinc-700'}`} />
      ))}
    </div>
  );
}

// ─── Windows 개발 환경 설정 마법사 ─────────────────────────────────────────────

function WindowsEnvWizard({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [wslStatus, setWslStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState('');
  const [claudeStatus, setClaudeStatus] = useState<'checking' | 'installed' | 'missing' | 'unknown'>('checking');
  const [tmuxStatus, setTmuxStatus] = useState<'checking' | 'installed' | 'missing' | 'unknown'>('checking');
  const totalSteps = 4;

  useEffect(() => {
    fetch('/api/check-claude').then(r => r.json()).then(d => setClaudeStatus(d.installed ? 'installed' : 'missing')).catch(() => setClaudeStatus('unknown'));
    fetch('/api/check-tmux').then(r => r.json()).then(d => setTmuxStatus(d.installed ? 'installed' : 'missing')).catch(() => setTmuxStatus('unknown'));
  }, []);

  async function checkWsl() {
    setChecking(true);
    try {
      const res = await fetch('/api/check-wsl');
      if (res.ok) { const d = await res.json(); setWslStatus(d.status); }
      else setWslStatus('unknown');
    } catch { setWslStatus('offline'); }
    finally { setChecking(false); }
  }

  async function installTmux() {
    setInstalling(true); setInstallMsg('tmux 설치 중...');
    try {
      const res = await fetch('/api/install-wsl-tmux', { method: 'POST' });
      const d = await res.json();
      setInstallMsg(d.success ? '✅ tmux 설치 완료' : `❌ ${d.error}`);
      if (d.success) setWslStatus('ready');
    } catch { setInstallMsg('❌ api-server에 연결할 수 없습니다'); }
    finally { setInstalling(false); }
  }

  const statusLabel: Record<string, { color: string; text: string }> = {
    ready:          { color: 'text-green-400',  text: '✅ 준비 완료' },
    no_tmux:        { color: 'text-yellow-400', text: '⚠️ tmux 미설치' },
    no_distro:      { color: 'text-orange-400', text: '⚠️ Ubuntu 없음' },
    not_installed:  { color: 'text-red-400',    text: '❌ WSL2 미설치' },
    offline:        { color: 'text-zinc-500',   text: '— 앱에서 확인 가능' },
    unknown:        { color: 'text-zinc-500',   text: '— 확인 불가' },
  };

  const steps = [
    {
      title: 'Claude Code 네이티브 설치',
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">Claude Code는 현재 <strong className="text-zinc-200">Windows 네이티브</strong>로 사용할 수 있습니다. WSL은 필수가 아닙니다.</p>
            <StatusBadge status={claudeStatus} />
          </div>
          {claudeStatus === 'installed' ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400">✅ Windows에서 실행 가능한 Claude Code를 찾았습니다.</div>
          ) : (
            <>
              <CmdBlock cmd={`powershell -c "irm https://claude.ai/install.ps1 | iex"`} label="PowerShell에서 공식 설치" />
              <CmdBlock cmd="claude doctor" label="설치·로그인 확인" />
            </>
          )}
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">Codex·Antigravity도 네이티브 실행을 우선합니다. 설치 현황판에서 각각 독립적으로 확인할 수 있습니다.</div>
        </div>
      ),
    },
    {
      title: 'WSL2 + Ubuntu (선택)',
      content: (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">WSL2는 <strong className="text-zinc-200">tmux로 터미널 세션을 유지하고 싶을 때만</strong> 설치합니다. 일반 앱 사용과 네이티브 AI 실행에는 필요 없습니다.</p>
          <CmdBlock cmd="wsl --install" label="필요한 경우 PowerShell 관리자 권한에서 실행" />
          <p className="text-xs text-zinc-500">설치 후 PC를 재시작하고 Ubuntu 첫 실행에서 사용자명·비밀번호를 정합니다.</p>
          <div className="flex gap-2">
            <button onClick={checkWsl} disabled={checking} className="flex-1 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded-lg transition-colors disabled:opacity-50">
              {checking ? '확인 중...' : 'WSL 상태 확인'}
            </button>
            {wslStatus && <span className={`flex items-center text-xs font-mono ${statusLabel[wslStatus]?.color ?? 'text-zinc-500'}`}>{statusLabel[wslStatus]?.text ?? wslStatus}</span>}
          </div>
        </div>
      ),
    },
    {
      title: 'tmux 설치',
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">멀티 에이전트 기능(tmux 버튼)을 쓰려면 WSL 안에 tmux가 필요합니다.</p>
            <StatusBadge status={tmuxStatus} />
          </div>
          {tmuxStatus === 'installed' ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400">
              ✅ tmux가 이미 설치되어 있습니다. 다음 단계로 넘어가세요.
            </div>
          ) : (
            <>
              <CmdBlock cmd="sudo apt-get install -y tmux" label="Ubuntu 터미널에서 실행" />
              <CmdBlock cmd="tmux -V" label="설치 확인" />
              {installMsg && <p className={`text-xs font-mono ${installMsg.startsWith('✅') ? 'text-green-400' : 'text-red-400'}`}>{installMsg}</p>}
              <button onClick={installTmux} disabled={installing}
                className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors disabled:opacity-50">
                {installing ? '설치 중...' : '📦 앱에서 자동 설치 (api-server 실행 중인 경우)'}
              </button>
            </>
          )}
        </div>
      ),
    },
    {
      title: '완료',
      content: (
        <div className="space-y-4 text-center">
          <div className="text-5xl">🎉</div>
          <p className="text-base font-semibold text-white">설정 완료!</p>
          <p className="text-sm text-zinc-400">이제 Claude Code는 Windows에서 바로 실행할 수 있고, WSL·tmux를 준비했다면 선택형 지속 세션도 사용할 수 있습니다.</p>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 text-xs text-zinc-400 text-left space-y-1.5">
            <p className="font-medium text-zinc-300 mb-1">다음 단계</p>
            <p>• <strong className="text-zinc-300">Supabase 연동</strong>: 여러 기기 간 포트/포털 동기화</p>
            <p>• <strong className="text-zinc-300">포털 Vercel 배포</strong>: 북마크를 스마트폰에서도 접근</p>
            <p>• 상단 메뉴 → <strong className="text-zinc-300">⚙️ 설정</strong>에서 언제든 다시 열 수 있습니다</p>
          </div>
          <button onClick={onBack}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            설정 마법사 홈으로
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="h-full flex flex-col px-4 py-4 md:p-8">
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-4 md:mb-6 transition-colors w-fit">
        <ChevronRight className="w-3.5 h-3.5 rotate-180" /> 뒤로
      </button>
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <h2 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
          <Monitor className="w-5 h-5 text-blue-400" /> Windows 개발 환경 설정
        </h2>
        <StepDots total={totalSteps} current={step} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">{step + 1}. {steps[step]?.title}</h3>
        {steps[step]?.content}
      </div>
      <div className="flex gap-3 mt-4 md:mt-6 pt-4 border-t border-zinc-800">
        {step > 0 && (
          <button onClick={() => setStep(s => s - 1)}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded-lg transition-colors">
            이전
          </button>
        )}
        {step < totalSteps - 1 && (
          <button onClick={() => setStep(s => s + 1)}
            className="ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            다음 →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── macOS 개발 환경 설정 마법사 ──────────────────────────────────────────────

function StatusBadge({ status }: { status: 'checking' | 'installed' | 'missing' | 'unknown' }) {
  const map = {
    checking: { cls: 'text-zinc-400 bg-zinc-800 border-zinc-700', label: '확인 중…' },
    installed: { cls: 'text-green-400 bg-green-500/10 border-green-500/20', label: '✅ 이미 설치됨' },
    missing:   { cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', label: '설치 필요' },
    unknown:   { cls: 'text-zinc-500 bg-zinc-800 border-zinc-700', label: '확인 불가 (앱 전용)' },
  };
  const { cls, label } = map[status];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

function MacEnvWizard({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [claudeStatus, setClaudeStatus] = useState<'checking' | 'installed' | 'missing' | 'unknown'>('checking');
  const [tmuxStatus, setTmuxStatus] = useState<'checking' | 'installed' | 'missing' | 'unknown'>('checking');
  const totalSteps = 5;

  useEffect(() => {
    fetch('/api/check-claude').then(r => r.json()).then(d => setClaudeStatus(d.installed ? 'installed' : 'missing')).catch(() => setClaudeStatus('unknown'));
    fetch('/api/check-tmux').then(r => r.json()).then(d => setTmuxStatus(d.installed ? 'installed' : 'missing')).catch(() => setTmuxStatus('unknown'));
  }, []);

  const steps = [
    {
      title: 'Homebrew 설치',
      content: (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">macOS 패키지 매니저 Homebrew가 없으면 먼저 설치합니다.</p>
          <CmdBlock cmd='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' label="Terminal에서 실행" />
          <CmdBlock cmd="brew --version" label="설치 확인" />
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 text-xs text-zinc-400">
            이미 설치되어 있다면 그냥 다음으로 넘어가세요.
          </div>
        </div>
      ),
    },
    {
      title: 'Claude Code 네이티브 설치',
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">공식 네이티브 설치 프로그램을 사용합니다. Node.js·npm은 필요하지 않습니다.</p>
            <StatusBadge status={claudeStatus} />
          </div>
          {claudeStatus === 'installed' ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400">
              ✅ Claude Code가 이미 설치되어 있습니다. 다음 단계로 넘어가세요.
            </div>
          ) : (
            <>
              <CmdBlock cmd="curl -fsSL https://claude.ai/install.sh | bash" label="① 공식 네이티브 설치" />
              <CmdBlock cmd="claude --version" label="② 설치 확인 — 버전이 표시되면 정상" />
              <CmdBlock cmd="claude" label="③ 첫 실행 → Anthropic 계정 인증" />
            </>
          )}
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
            설치 후 전체 설치·연결 현황판으로 돌아가 <strong>다시 검사</strong>를 누르면 Claude Code 상태가 갱신됩니다.
          </div>
        </div>
      ),
    },
    {
      title: 'Rust 설치 (DMG 빌드 필수)',
      content: (
        <div className="space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-300">
            ⚠️ Tauri 앱 빌드(DMG 생성)에 Rust가 필요합니다. 설치하지 않으면 빌드 버튼이 실패합니다.
          </div>
          <CmdBlock
            cmd="curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
            label="① Rust 설치 (rustup)"
          />
          <CmdBlock cmd="source ~/.cargo/env" label="② 환경 변수 적용 (현재 터미널)" />
          <CmdBlock cmd="cargo --version" label="③ 설치 확인 — cargo 1.7x 이상이면 성공" />
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 text-xs text-zinc-400">
            이미 설치되어 있다면 그냥 다음으로 넘어가세요.
          </div>
        </div>
      ),
    },
    {
      title: 'tmux + iTerm2 설치',
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">tmux 버튼은 iTerm2 터미널에서 tmux 세션을 엽니다.</p>
            <StatusBadge status={tmuxStatus} />
          </div>
          {tmuxStatus === 'installed' ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400">
              ✅ tmux가 이미 설치되어 있습니다. iTerm2만 확인하세요.
            </div>
          ) : (
            <CmdBlock cmd="brew install tmux" label="tmux 설치" />
          )}
          <CmdBlock cmd="brew install --cask iterm2" label="iTerm2 설치 (없는 경우)" />
          <CmdBlock cmd="tmux -V" label="tmux 설치 확인" />
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
            💡 iTerm2가 없으면 tmux 버튼이 동작하지 않습니다. Terminal.app은 지원하지 않습니다.
          </div>
        </div>
      ),
    },
    {
      title: '완료',
      content: (
        <div className="space-y-4 text-center">
          <div className="text-5xl">🎉</div>
          <p className="text-base font-semibold text-white">설정 완료!</p>
          <p className="text-sm text-zinc-400">이제 앱의 tmux 버튼으로 iTerm2에서 Claude Code 세션을 바로 열 수 있습니다.</p>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 text-xs text-zinc-400 text-left space-y-1.5">
            <p className="font-medium text-zinc-300 mb-1">다음 단계</p>
            <p>• <strong className="text-zinc-300">Supabase 연동</strong>: 여러 기기 간 포트/포털 동기화 → "처음 사용"</p>
            <p>• <strong className="text-zinc-300">포털 Vercel 배포</strong>: 북마크를 스마트폰에서도 접근</p>
          </div>
          <button onClick={onBack}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            설정 마법사 홈으로
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="h-full flex flex-col px-4 py-4 md:p-8">
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-4 md:mb-6 transition-colors w-fit">
        <ChevronRight className="w-3.5 h-3.5 rotate-180" /> 뒤로
      </button>
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <h2 className="text-lg md:text-xl font-bold text-white flex items-center gap-2">
          <Terminal className="w-5 h-5 text-emerald-400" /> macOS 개발 환경 설정
        </h2>
        <StepDots total={totalSteps} current={step} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">{step + 1}. {steps[step]?.title}</h3>
        {steps[step]?.content}
      </div>
      <div className="flex gap-3 mt-4 md:mt-6 pt-4 border-t border-zinc-800">
        {step > 0 && (
          <button onClick={() => setStep(s => s - 1)}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-xs rounded-lg transition-colors">
            이전
          </button>
        )}
        {step < totalSteps - 1 && (
          <button onClick={() => setStep(s => s + 1)}
            className="ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            다음 →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 통합 개발 환경 마법사 (Windows + macOS 토글) ─────────────────────────────
function DevEnvWizard({ defaultOs, onBack }: { defaultOs: OS; onBack: () => void }) {
  const [os, setOs] = useState<OS>(defaultOs);
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-4 md:px-8 md:pt-6 shrink-0">
        <div className="mb-3">
          <p className="text-[11px] text-zinc-500 mb-2">먼저 운영체제를 선택하세요</p>
          <OsToggle os={os} onChange={setOs} />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {os === 'windows' ? <WindowsEnvWizard onBack={onBack} /> : <MacEnvWizard onBack={onBack} />}
      </div>
    </div>
  );
}

function PortalVercelWizard({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [os, setOs] = useState<OS>('mac');
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [allowedEmail, setAllowedEmail] = useState('');
  const allowedEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail.trim());
  const personalizedPortalSql = allowedEmailValid
    ? portalSqlForAllowedEmails([allowedEmail])
    : '-- 서버 RLS 허용 Google 이메일을 먼저 입력하세요.';

  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(p => ({ ...p, [key]: true }));
    setTimeout(() => setCopied(p => ({ ...p, [key]: false })), 1500);
  }

  const [sqlMode, setSqlMode] = useState<'cli' | 'web'>('cli');

  // ── 자동 배포 상태 ────────────────────────────────────────────────
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployUrl, setDeployUrl] = useState<string | null>(null);
  const [deployProjectRef, setDeployProjectRef] = useState<string | null>(null);
  const [deployExitCode, setDeployExitCode] = useState<number | null>(null);
  const [showManualFallback, setShowManualFallback] = useState(false);
  const [vercelUser, setVercelUser] = useState<string | null>(null);
  const [vercelCheckingAuth, setVercelCheckingAuth] = useState(false);
  const [vercelOwnershipConfirmed, setVercelOwnershipConfirmed] = useState(false);

  async function checkVercelAuth() {
    setVercelCheckingAuth(true);
    setVercelOwnershipConfirmed(false);
    try {
      const r = await fetch('/api/vercel-whoami');
      const j = await r.json();
      setVercelUser(j.loggedIn ? (j.user || 'logged in') : null);
    } catch { setVercelUser(null); }
    finally { setVercelCheckingAuth(false); }
  }

  async function startAutoDeploy() {
    if (!allowedEmailValid) return;
    setDeployLog([]); setDeployUrl(null); setDeployProjectRef(null); setDeployExitCode(null); setIsDeploying(true);
    try {
      const r = await fetch('/api/deploy-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedEmail: allowedEmail.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setDeployLog(l => [...l, `❌ 배포 시작 실패: ${j.error ?? r.statusText}`]);
        setIsDeploying(false);
        return;
      }
    } catch (e: any) {
      setDeployLog(l => [...l, `❌ 네트워크 오류: ${e.message}`]);
      setIsDeploying(false);
    }
  }

  // 배포 상태 폴링 (1초마다)
  useEffect(() => {
    if (!isDeploying) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/deploy-portal-status');
        const j = await r.json();
        if (cancelled) return;
        setDeployLog(j.output ?? []);
        if (j.url) setDeployUrl(j.url);
        if (j.projectRef) setDeployProjectRef(j.projectRef);
        if (!j.isDeploying) {
          setDeployExitCode(j.exitCode);
          setIsDeploying(false);
          if (j.exitCode === 0 && j.url) {
            try { await navigator.clipboard.writeText(j.url); } catch {}
          }
        }
      } catch {}
    };
    const id = setInterval(poll, 1000);
    void poll();
    return () => { cancelled = true; clearInterval(id); };
  }, [isDeploying]);

  const vercelCmds = `npm install -g vercel
vercel login
vercel whoami
vercel link
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_ANON_KEY production
vercel env add VITE_ALLOWED_EMAIL production
vercel deploy --prod`;

  const steps = [
    { title: 'Vercel 준비' },
    { title: 'Supabase 테이블 생성' },
    { title: 'Supabase Google OAuth 설정' },
    { title: 'Vercel 환경 변수 & 배포' },
    { title: '기기 연결' },
  ];

  const stepContent = [
    /* 0: Fork & CLI */
    <div key={0} className="space-y-5">
      <InfoBox color="blue">
        <strong>빠른 배포에는 GitHub Fork가 필요 없습니다.</strong> 현재 공개 clone을 로그인한 본인의 Vercel 프로젝트에 배포합니다. 원작자의 개인 Vercel·Supabase는 사용하거나 변경하지 않습니다. Fork는 GitHub push로 자동 재배포하고 싶을 때만 선택하세요.
      </InfoBox>
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-emerald-200">공개판에서 내 배포판 만들기</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">아래 버튼은 공개 GitHub 저장소 주소만 Vercel에 전달합니다. Supabase 값·이메일·토큰은 버튼 URL에 넣지 않으며, 로그인 뒤 내 Vercel 프로젝트의 환경 변수 화면에서 설정합니다.</p>
        </div>
        <a href={VERCEL_IMPORT_URL} target="_blank" rel="noopener noreferrer"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20">
          <ExternalLink className="h-3.5 w-3.5" /> 내 계정에서 Deploy with Vercel
        </a>
        <button onClick={() => copy('selfHostingAgent', SELF_HOSTING_AGENT_PROMPT)}
          className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
          {copied['selfHostingAgent'] ? '✓ 내 배포판 만들기 프롬프트 복사됨' : '어떤 AI에든 맡길 안전한 배포 프롬프트 복사'}
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <p className="text-xs text-zinc-400 mb-2">① Vercel CLI 설치</p>
          <CodeBlock label="터미널에서 실행" code="npm install -g vercel" />
        </div>
        <div>
          <p className="text-xs text-zinc-400 mb-2">② Vercel 로그인 (브라우저 인증)</p>
          <CodeBlock label="" code="vercel login" />
        </div>
      </div>
      <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-2">
        <p className="text-sm font-semibold text-violet-200">화면을 보고 따라가기 어렵다면</p>
        <p className="text-xs leading-relaxed text-zinc-400">Codex·Claude가 Playwright로 현재 대시보드를 직접 확인하며 메뉴 이동을 도울 수 있습니다. 로그인·2단계 인증·Client Secret은 사용자가 브라우저에서 직접 입력합니다.</p>
        <button onClick={() => copy('browserAssist', PORTAL_BROWSER_ASSIST_PROMPT)} className="min-h-11 w-full rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-500/20">
          {copied['browserAssist'] ? '✓ 브라우저 보조 요청 복사됨' : 'Playwright 브라우저 보조 요청 복사'}
        </button>
      </div>
      <details className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-3">
        <summary className="cursor-pointer text-xs text-zinc-400">선택: GitHub Fork로 자동 재배포 연결</summary>
        <a href={REPO_FORK_URL} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-2 rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-700">
          <ExternalLink className="w-3.5 h-3.5" /> GitHub에서 Fork 열기
        </a>
      </details>
    </div>,

    /* 1: Supabase SQL */
    <div key={1} className="space-y-4">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
        <label className="block text-xs font-semibold text-emerald-300">서버 RLS 허용 Google 이메일</label>
        <input type="email" value={allowedEmail} onChange={event => setAllowedEmail(event.target.value)}
          placeholder="owner@example.com"
          className="w-full px-3 py-2 text-sm bg-black/40 border border-zinc-700 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500" />
        <p className="text-[11px] text-zinc-500">VITE_ALLOWED_EMAIL과 같은 owner 이메일을 넣으세요. 빈 목록은 모두 차단합니다.</p>
      </div>
      {/* CLI / Web toggle */}
      <div className="flex gap-1 p-1 bg-zinc-800/60 rounded-lg w-fit">
        <button onClick={() => setSqlMode('cli')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${sqlMode === 'cli' ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          <Terminal className="w-3 h-3 inline mr-1" />CLI 방식
        </button>
        <button onClick={() => setSqlMode('web')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${sqlMode === 'web' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
          <Globe className="w-3 h-3 inline mr-1" />웹 대시보드
        </button>
      </div>

      {sqlMode === 'cli' ? (
        <div className="space-y-3">
          <InfoBox color="blue">
            Supabase CLI가 설치·로그인된 경우 터미널에서 바로 테이블을 생성할 수 있습니다.<br />
            <span className="text-zinc-400">Step 1에서 이미 프로젝트를 link했다면 그대로 진행하세요.</span>
          </InfoBox>
          <CodeBlock label="① 마이그레이션 파일 생성" code="supabase migration new portal_tables" comment="supabase/migrations/ 폴더에 SQL 파일이 생성됩니다" />
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-zinc-400">② 생성된 파일에 아래 SQL 붙여넣기</p>
              <button disabled={!allowedEmailValid} onClick={() => copy('sql', personalizedPortalSql)}
                className="text-[11px] text-violet-400 hover:text-violet-300 flex items-center gap-1 transition-colors">
                <Copy className="w-3 h-3" />{copied['sql'] ? '복사됨!' : 'SQL 복사'}
              </button>
            </div>
            <pre className="bg-black/50 border border-zinc-700 rounded-xl p-4 text-xs text-emerald-300 overflow-x-auto leading-relaxed whitespace-pre-wrap max-h-40">{personalizedPortalSql}</pre>
          </div>
          <CodeBlock label="③ 원격 DB에 적용" code="supabase db push" comment="linked된 Supabase 프로젝트에 테이블이 생성됩니다" />
        </div>
      ) : (
        <div className="space-y-3">
          <InfoBox color="blue">
            Supabase 대시보드 → <strong>SQL Editor</strong> 에서 아래 SQL을 실행합니다.<br />
            이미 로컬 앱 마법사로 Supabase를 설정했다면, portal_items · portal_categories 두 테이블만 추가하면 됩니다.
          </InfoBox>
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-zinc-400">Supabase SQL Editor에 붙여넣기</p>
              <button disabled={!allowedEmailValid} onClick={() => copy('sql', personalizedPortalSql)}
                className="text-[11px] text-violet-400 hover:text-violet-300 flex items-center gap-1 transition-colors">
                <Copy className="w-3 h-3" />{copied['sql'] ? '복사됨!' : 'SQL 복사'}
              </button>
            </div>
            <pre className="bg-black/50 border border-zinc-700 rounded-xl p-4 text-xs text-emerald-300 overflow-x-auto leading-relaxed whitespace-pre-wrap max-h-48">{personalizedPortalSql}</pre>
          </div>
        </div>
      )}
    </div>,

    /* 2: Google OAuth */
    <div key={2} className="space-y-5">
      <InfoBox color="blue">
        Google 로그인은 Vercel 환경 변수가 아니라 <strong>Supabase Auth</strong>에서 설정합니다.
        이 단계는 웹 포털에서 Google 로그인을 쓸 때만 필요합니다.
      </InfoBox>
      <ol className="space-y-4 text-sm text-zinc-300">
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-xs text-violet-400 shrink-0 mt-0.5">1</span>
          <div className="space-y-1.5">
            <p className="font-medium">Google Cloud Console에서 OAuth 클라이언트 만들기</p>
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 rounded-lg text-xs text-white transition-colors">
              <ExternalLink className="w-3 h-3" /> console.cloud.google.com/apis/credentials
            </a>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-xs text-violet-400 shrink-0 mt-0.5">2</span>
          <div>
            <p className="font-medium">웹 애플리케이션 OAuth 클라이언트 ID 생성</p>
            <p className="text-xs text-zinc-500 mt-1">
              <strong className="text-zinc-300">+ 사용자 인증 정보 만들기</strong> → <strong className="text-zinc-300">OAuth 클라이언트 ID</strong><br />
              유형: <code className="text-violet-400">웹 애플리케이션</code>
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-xs text-violet-400 shrink-0 mt-0.5">3</span>
          <div>
            <p className="font-medium">Google에 Supabase 콜백 URL 등록</p>
            <div className="mt-1.5 space-y-2">
              <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-400 space-y-1">
                <p className="font-medium text-zinc-300">승인된 리디렉션 URI</p>
                <code className="block text-emerald-400 font-mono">https://&lt;project-ref&gt;.supabase.co/auth/v1/callback</code>
                <p className="text-[10px] text-zinc-500">정확한 URL은 Supabase Dashboard → Authentication → Providers → Google에서 확인합니다.</p>
              </div>
              <p className="text-[10px] text-zinc-600">Vercel 포털 URL은 Google이 아니라 Supabase Dashboard → Authentication → URL Configuration의 Redirect URLs에 추가합니다.</p>
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-xs text-violet-400 shrink-0 mt-0.5">4</span>
          <div>
            <p className="font-medium">Client ID와 Client Secret을 Supabase에 저장</p>
            <p className="text-xs text-zinc-500 mt-1">
              Supabase Dashboard → <strong>Authentication → Providers → Google</strong>에서 Google을 활성화하고
              Client ID와 Client Secret을 입력합니다. Vercel 환경 변수에 Google Client ID를 추가하지 마세요.
            </p>
          </div>
        </li>
      </ol>
    </div>,

    /* 3: Vercel deploy */
    <div key={3} className="space-y-4">
      <InfoBox color="blue">
        <strong>쉬운 자동 배포</strong>: 앱에 이미 저장된 Supabase 공개 연결 정보와 위 허용 이메일을 Vercel Production 환경 변수에 넣고 배포합니다. 값을 다시 복사할 필요가 없습니다.<br />
        <span className="text-zinc-400 text-[11px]">사전 조건: 첫 단말 Supabase 연결 + Vercel CLI 로그인</span>
      </InfoBox>

      {/* Vercel 로그인 상태 확인 */}
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={checkVercelAuth}
          disabled={vercelCheckingAuth}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 disabled:opacity-50"
        >
          {vercelCheckingAuth ? '확인 중…' : 'Vercel 로그인 확인'}
        </button>
        {vercelUser === null && !vercelCheckingAuth && <span className="text-zinc-500">아직 확인 안 됨</span>}
        {vercelUser && <span className="text-emerald-400">✓ 로그인됨: {vercelUser}</span>}
      </div>
      {vercelUser && (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-300">
          <input type="checkbox" checked={vercelOwnershipConfirmed} onChange={event => setVercelOwnershipConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-violet-500" />
          <span>위 계정이 본인 계정이며, 이 폴더가 이미 Vercel 프로젝트에 연결돼 있다면 그 프로젝트를 업데이트한다는 점을 확인했습니다.</span>
        </label>
      )}

      {/* 자동 배포 버튼 */}
      {!isDeploying && deployExitCode === null && (
        <button
          onClick={startAutoDeploy}
          disabled={!allowedEmailValid || !vercelUser || !vercelOwnershipConfirmed}
          className="w-full py-3 bg-violet-600 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <Zap className="w-4 h-4" />환경 변수 저장 + 자동 배포 시작
        </button>
      )}
      {!allowedEmailValid && <p className="text-xs text-amber-300">Step 1에서 Google 로그인 허용 이메일을 먼저 입력하세요.</p>}
      {allowedEmailValid && !vercelUser && <p className="text-xs text-amber-300">먼저 Vercel 로그인 확인을 눌러 배포 대상 계정을 확인하세요.</p>}
      {allowedEmailValid && vercelUser && !vercelOwnershipConfirmed && <p className="text-xs text-amber-300">표시된 Vercel 계정과 기존 프로젝트 연결 사용 여부를 확인하세요.</p>}

      {/* 배포 진행 중 */}
      {isDeploying && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-violet-300">
            <RefreshCw className="w-4 h-4 animate-spin" />배포 중…
          </div>
          <pre className="bg-black/70 border border-zinc-700 rounded-xl p-3 text-[11px] text-zinc-300 font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">{deployLog.join('') || '(대기)'}</pre>
        </div>
      )}

      {/* 배포 완료 */}
      {deployExitCode === 0 && deployUrl && (
        <div className="border border-emerald-500/40 bg-emerald-500/10 rounded-xl p-4 space-y-2">
          <p className="text-sm font-semibold text-emerald-300">✓ 배포 완료</p>
          <p className="text-xs text-zinc-400">이 URL을 Supabase Redirect URLs에 추가한 뒤 Google 로그인을 확인하세요. 두 번째 PC 연결은 이 포털 또는 첫 단말 앱의 로컬 초대 기능 어느 쪽으로도 가능합니다.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 text-xs bg-black/40 rounded-lg text-emerald-300 font-mono break-all">{deployUrl}</code>
            <button onClick={() => copy('deployUrl', deployUrl)} className="px-3 py-2 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700">
              {copied['deployUrl'] ? '복사됨!' : '복사'}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <a href={deployUrl} target="_blank" rel="noopener" className="min-h-11 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-center text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20">배포 포털 열기</a>
            {deployProjectRef && (
              <a href={`https://supabase.com/dashboard/project/${deployProjectRef}/auth/url-configuration`} target="_blank" rel="noopener" className="min-h-11 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-center text-xs font-semibold text-blue-200 hover:bg-blue-500/20">Supabase Redirect URLs 열기</a>
            )}
          </div>
        </div>
      )}

      {/* 배포 실패 */}
      {deployExitCode !== null && deployExitCode !== 0 && (
        <div className="border border-red-500/40 bg-red-500/10 rounded-xl p-3 space-y-2">
          <p className="text-sm font-semibold text-red-300">❌ 배포 실패 (exit {deployExitCode})</p>
          <p className="text-xs text-zinc-400">로그를 확인하고, 아래 수동 가이드로 다시 시도하거나 Vercel 로그인 상태를 확인하세요.</p>
          <pre className="bg-black/70 border border-zinc-700 rounded-xl p-3 text-[10px] text-zinc-400 font-mono max-h-40 overflow-y-auto whitespace-pre-wrap">{deployLog.join('')}</pre>
          <button onClick={() => { setDeployExitCode(null); setDeployLog([]); setDeployUrl(null); setDeployProjectRef(null); }} className="text-xs text-violet-400 hover:text-violet-300 underline">
            다시 시도
          </button>
        </div>
      )}

      {/* 수동 배포 fallback (접힘) */}
      <button
        onClick={() => setShowManualFallback(s => !s)}
        className="w-full text-[11px] text-zinc-500 hover:text-zinc-300 underline transition-colors"
      >
        {showManualFallback ? '▲ 수동 배포 가이드 닫기' : '▼ 수동 배포 가이드 (CLI가 없거나 실패 시)'}
      </button>
      {showManualFallback && (
        <div className="space-y-3 pt-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-zinc-400">터미널 — 저장소 루트에서 실행</p>
              <button onClick={() => copy('vercel', vercelCmds)} className="text-[11px] text-violet-400 hover:text-violet-300 flex items-center gap-1"><Copy className="w-3 h-3" />{copied['vercel'] ? '복사됨!' : '전체 복사'}</button>
            </div>
            <pre className="bg-black/50 border border-zinc-700 rounded-xl p-4 text-xs text-emerald-300 font-mono leading-loose">{vercelCmds}</pre>
          </div>
          <div className="rounded-xl border border-zinc-700 p-4 space-y-2 text-xs text-zinc-400">
            <p className="font-medium text-zinc-300">입력 값 안내</p>
            <div className="space-y-1">
              <p><code className="text-violet-400">VITE_SUPABASE_URL</code> — Supabase → Project Settings → API → Project URL</p>
              <p><code className="text-violet-400">VITE_SUPABASE_ANON_KEY</code> — 같은 페이지 anon/public key</p>
              <p><code className="text-violet-400">VITE_ALLOWED_EMAIL</code> — 선택: 로그인 허용 Google 이메일(쉼표 구분)</p>
              <p>Google OAuth의 Client ID/Secret과 Redirect URL은 Vercel이 아니라 Supabase Authentication 설정에서 관리합니다.</p>
            </div>
          </div>
        </div>
      )}
    </div>,

    /* 4: Connect device */
    <div key={4} className="space-y-4">
      <InfoBox color="green">
        배포가 완료됐습니다! 이제 로컬 앱과 연결합니다.
      </InfoBox>
      <ol className="space-y-4 text-sm text-zinc-300">
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-xs text-blue-400 shrink-0 mt-0.5">1</span>
          <div>
            <p className="font-medium">로컬 앱에서 Push 실행</p>
            <p className="text-xs text-zinc-500 mt-1">북마크 탭 → <strong>Push</strong> 버튼 클릭 → Supabase에 이 기기 데이터 등록</p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-xs text-blue-400 shrink-0 mt-0.5">2</span>
          <div>
            <p className="font-medium">배포된 URL 접속</p>
            <p className="text-xs text-zinc-500 mt-1">Google 로그인 → 기기 목록에서 이 기기 선택 → 데이터 자동 Pull</p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-xs text-blue-400 shrink-0 mt-0.5">3</span>
          <div>
            <p className="font-medium">이후 동기화</p>
            <p className="text-xs text-zinc-500 mt-1">로컬 앱 북마크 탭 → Push / 웹 포털 헤더 → Pull</p>
          </div>
        </li>
      </ol>
      <div className="pt-2">
        <button onClick={onClose}
          className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
          완료 <Check className="w-4 h-4" />
        </button>
      </div>
    </div>,
  ];

  const canNext = [true, true, true, true, true];

  return (
    <WizardLayout
      title="북마크 포털 배포"
      progressColor="blue"
      steps={steps}
      step={step}
      setStep={setStep}
      canNext={canNext}
      onBack={onBack}
      onComplete={onClose}
      canComplete={true}
    >
      {stepContent[step]}
    </WizardLayout>
  );
}

// ─── Shared Wizard Layout ──────────────────────────────────────────────────────

function WizardLayout({
  title, progressColor, steps, step, setStep, canNext, onBack, onComplete, canComplete, children,
}: {
  title: string; progressColor: 'blue' | 'emerald'; steps: { title: string }[];
  step: number; setStep: (n: number) => void; canNext: boolean[];
  onBack: () => void; onComplete: () => void | Promise<void>; canComplete: boolean; children: React.ReactNode;
}) {
  const isLast = step === steps.length - 1;
  const colors = progressColor === 'blue' ? { bar: 'bg-blue-500', btn: 'bg-blue-500 hover:bg-blue-600' } : { bar: 'bg-emerald-500', btn: 'bg-emerald-500 hover:bg-emerald-600' };
  const [completionBusy, setCompletionBusy] = useState(false);
  const [completionError, setCompletionError] = useState('');

  async function handleComplete() {
    setCompletionBusy(true);
    setCompletionError('');
    try {
      await onComplete();
    } catch (error: any) {
      setCompletionError(error?.message || String(error));
    } finally {
      setCompletionBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Sidebar — hidden on mobile, visible md+ */}
      <div className="hidden md:flex w-52 shrink-0 border-r border-zinc-800 p-5 flex-col gap-0.5 overflow-y-auto">
        <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium mb-3">{title}</p>
        {steps.map((s, i) => (
          <button key={i} onClick={() => (i < step) ? setStep(i) : undefined}
            className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all ${
              i === step ? 'bg-zinc-800 text-white' : i < step ? 'text-zinc-400 hover:bg-zinc-800/50 cursor-pointer' : 'text-zinc-600 cursor-default'
            }`}>
            <StepDot num={i + 1} active={i === step} done={i < step} />
            <span className="text-xs font-medium leading-tight">{s.title}</span>
          </button>
        ))}
        <div className="mt-auto pt-4 border-t border-zinc-800">
          <button onClick={onBack} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">← 뒤로</button>
        </div>
      </div>

      {/* Mobile step indicator */}
      <div className="flex md:hidden items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
        <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">← 뒤로</button>
        <span className="text-xs text-zinc-500">{steps[step]?.title}</span>
        <span className="text-xs text-zinc-600">{step + 1}/{steps.length}</span>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-4 py-4 md:p-8">
          <div className="max-w-lg">
            <div className="hidden md:flex items-center justify-between mb-1">
              <h2 className="text-xl font-semibold text-white">{steps[step]?.title}</h2>
              <span className="text-xs text-zinc-600">{step + 1} / {steps.length}</span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1 mb-4 md:mb-6">
              <div className={`${colors.bar} h-1 rounded-full transition-all duration-300`} style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
            </div>
            {children}
          </div>
        </div>
        <div className="border-t border-zinc-800 px-4 py-3 md:px-8 md:py-4 flex items-center justify-between shrink-0">
          {completionError && <p className="text-xs text-red-400 max-w-xs">{completionError}</p>}
          <button onClick={() => step > 0 ? setStep(step - 1) : undefined} disabled={step === 0}
            className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors">
            ← 이전
          </button>
          {isLast ? (
            <button onClick={() => void handleComplete()} disabled={!canComplete || completionBusy}
              className={`px-4 py-2 md:px-6 ${colors.btn} disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-all flex items-center gap-2`}>
              {completionBusy ? (isTauri() ? '연결 설정 중…' : 'Google 로그인 대기 중…') : '완료 및 동기화'} <Check className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={() => setStep(step + 1)} disabled={!canNext[step]}
              className="px-4 py-2 md:px-6 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-all flex items-center gap-2">
              다음 <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main SetupWizard ──────────────────────────────────────────────────────────

const QUICK_INSTALL_PROMPT = `AgentsToZ_byCS의 새 기기 온보딩을 진행해줘.

목표는 먼저 로컬 웹 모드로 앱을 실제 실행하는 것이다. Supabase, GitHub, Vercel, Rust/Tauri,
cmux·tmux, Claude/Codex는 모두 선택 기능이므로 필요 여부를 확인하기 전에는 설치하거나 설정하지 마라.

1. 현재 OS, 저장소 경로, bun, git, node_modules 상태를 읽기 전용으로 진단하고 표로 보고해줘.
2. 로컬 사용에 필요한 것은 bun + git + bun install뿐임을 먼저 알려줘. 계정은 필요 없다.
3. 설치·권한 변경·재부팅·기존 프로세스 종료는 실행하지 말고, 필요한 경우 명령과 영향을 설명한 뒤 사용자 승인을 받아.
4. bun과 git이 준비되면 저장소 루트에서 bun install을 실행하고, 플랫폼에 맞는 Vite 실행 파일을 확인해줘.
5. bun run start로 API(3001)와 Vite(9000)를 함께 실행하고 http://localhost:9000 이 열리는지 확인해줘.
   vite를 직접 실행하지 마라.
6. API가 뜨면 GET http://127.0.0.1:3001/api/onboarding/status 를 호출해 비밀값 없이 이 설치의 단말 상태를 판정해줘.
   - registered: 이미 확정된 단말이므로 현재 신원을 덮어쓰지 말고, 다른 PC를 연결하려면 앱의 “다른 PC 연결 정보 만들기”를 사용한다.
   - additional-pending: 저장된 같은 UUID로 추가 단말 등록을 재개한다.
   - fresh/configured-unregistered: 다른 PC에서 이미 AgentsToZ 동기화를 쓰는지 한 번만 확인한다. 새 clone만으로 원격 단말 존재를 추측하지 마라.
7. 첫 화면에서는 로컬로 바로 시작할 수 있다. 다기기 동기화가 필요할 때만 상황을 구분해 안내해줘.
   - 첫 Mac·Windows: “첫 단말 · 동기화 설정”. Supabase SQL은 src/schemaSql.ts의 MIGRATION_SQL을
     정본으로 쓰고, URL/anon key를 사용자의 파일에 직접 기록하지 마라. Tauri라면 마법사 안에서
     이 PC의 supabase login과 로컬 관리자 연결까지 확인한 뒤 완료한다.
   - 두 번째 Mac·Windows: 기존 단말 앱의 “다른 PC 연결 정보 만들기” 또는 배포 포털 “단말 연결 → Mac·Windows 연결”에서 공개 URL/anon
     정보만 복사하고, 반드시 새 PC에 설치한 앱의 “두 번째·추가 기기 연결”에 붙여넣는다. 개인 Vercel 포털은 필수가 아니다. 기존 단말 ID,
     service_role 키, 로그인 토큰은 복사하지 않는다. 새 앱이 새 ID를 만든 뒤 그 PC의 supabase login으로
     로컬 관리자 연결을 확인하고 DB 등록을 완료한다. 이미 등록된 앱의 신원을 덮어쓰지 마라.
   - Ubuntu/AWS: 데스크톱 설치 마법사가 아니라 포털의 “클라우드·서버”에서 호스트용 일회용 명령을
     만든 뒤 서버에서 실행한다. 호스트 등록 후 프로젝트를 하위 항목으로 연결한다.
   Tauri 앱은 localhost sidecar의 로컬 service_role 연결을 사용해 Google 로그인이 필요하지 않고,
   browser/배포 포털만 Google OAuth 세션의 authenticated JWT를 사용한다. anon key 단독 접근은 RLS가 거부해야 한다.
8. 첫 단말에서 개인 배포 포털을 원하면 Vercel CLI 배포를 권장하되 GitHub Fork는 선택으로 둔다. 화면 안내가 어렵다고 하면 Playwright headed 브라우저로 현재 대시보드를 snapshot하며 메뉴 이동을 도와줘. 로그인·2단계 인증·Google Client Secret은 사용자가 직접 입력하게 멈추고, 생성·환경 변수 변경·production 배포 직전에는 확인을 받아.
9. GitHub는 포크/푸시·Actions용, Vercel은 웹 포털 배포용, Rust는 데스크톱 번들용,
   cmux·tmux는 선택 터미널 기능용으로만 제안해줘.

각 단계 뒤에는 실제 결과와 다음 선택지만 짧게 보고해줘.`;

export default function SetupWizard({ onComplete, onSkip, hasExistingDevice = false }: SetupWizardProps) {
  const [mode, setMode] = useState<Mode>('choose');
  const [detectedOs, setDetectedOs] = useState<'mac' | 'windows' | null>(null);
  const [quickInstallCopied, setQuickInstallCopied] = useState(false);
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [statusChecking, setStatusChecking] = useState(true);

  useEffect(() => {
    const p = navigator.platform.toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (p.includes('win') || ua.includes('windows')) setDetectedOs('windows');
    else if (p.includes('mac') || ua.includes('mac')) setDetectedOs('mac');

    // 자동 클립보드 읽기 제거 — 브라우저 Paste 팝업 방지
    // 클립보드 감지는 "추가 기기 연결" 카드의 수동 버튼으로 이동
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadOnboardingStatus()
      .then(status => {
        if (!cancelled) setOnboardingStatus(status);
      })
      .catch(() => {
        // 구버전 sidecar에서는 endpoint가 없을 수 있다. App이 넘긴 확정 신원 여부로만
        // 보수적으로 표시하고 첫/추가 단말을 추측하지 않는다.
      })
      .finally(() => {
        if (!cancelled) setStatusChecking(false);
      });
    return () => { cancelled = true; };
  }, []);

  const deviceStage: OnboardingDeviceStage = onboardingStatus?.stage
    ?? (hasExistingDevice ? 'registered' : 'fresh');
  const isRegisteredDevice = deviceStage === 'registered';
  const isPendingAdditionalDevice = deviceStage === 'additional-pending';

  return (
    /* Backdrop */
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-2 sm:p-6">
      {/* Window chrome */}
      <div className="bg-[#0a0a0b] border border-zinc-700/80 rounded-2xl shadow-2xl shadow-black/60 w-full max-w-4xl h-[95vh] sm:h-[680px] flex flex-col overflow-hidden">

        {/* Title bar */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#111113] border-b border-zinc-800 shrink-0 select-none">
          {/* macOS-style traffic lights */}
          <div className="flex items-center gap-2">
            <button onClick={onSkip}
              className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400 transition-colors"
              title="닫기 (건너뛰기)" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60 cursor-default" />
            <div className="w-3 h-3 rounded-full bg-green-500/60 cursor-default" />
          </div>
          {/* Center title */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Server className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-400 font-medium">초기 설정 마법사</span>
          </div>
          <button onClick={onSkip}
            className="text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800">
            건너뛰기
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {mode === 'choose' && (
            <div className="h-full flex flex-col items-center p-4 sm:p-8 gap-5 overflow-y-auto justify-start pt-6">
              <div className="text-center space-y-2">
                <h2 className="text-xl sm:text-2xl font-bold text-white">어떤 상황인가요?</h2>
                <p className="text-zinc-400 text-sm">로컬 설정을 먼저 확인해 안전한 경로를 추천합니다.</p>
                {detectedOs && (
                  <p className="text-xs text-zinc-500">
                    감지된 OS: <span className="text-blue-400">{detectedOs === 'mac' ? '🍎 macOS' : '🪟 Windows'}</span>
                  </p>
                )}
              </div>
              <div className={`w-full max-w-4xl rounded-xl border px-4 py-3 text-xs ${
                isRegisteredDevice
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200'
                  : isPendingAdditionalDevice
                    ? 'border-violet-500/30 bg-violet-500/5 text-violet-200'
                    : 'border-zinc-700 bg-zinc-900/60 text-zinc-300'
              }`} data-testid="onboarding-device-diagnosis">
                {statusChecking
                  ? '로컬 단말 상태를 확인하는 중…'
                  : isRegisteredDevice
                    ? `✓ 이 앱은 등록된 단말입니다${onboardingStatus?.deviceName ? ` · ${onboardingStatus.deviceName}` : ''}. 현재 신원은 유지하고 다른 PC용 연결 정보를 만들 수 있습니다.`
                    : isPendingAdditionalDevice
                      ? '추가 단말 등록 대기 상태를 찾았습니다. 같은 UUID로 연결을 이어갑니다.'
                      : deviceStage === 'configured-unregistered'
                        ? 'Supabase 설정은 있지만 단말 등록은 끝나지 않았습니다. 첫 설정을 마치거나 기존 PC의 연결 정보를 붙여넣으세요.'
                        : '이 앱에는 아직 확정된 단말 신원이 없습니다. 다른 PC에서 이미 쓰고 있다면 “두 번째·추가 기기”, 아니면 “첫 단말”을 선택하세요.'}
              </div>
              <div className="grid sm:grid-cols-3 gap-3 w-full max-w-4xl">
                <button onClick={onSkip} className="group bg-emerald-500/5 hover:bg-emerald-500/10 border-2 border-emerald-500/50 rounded-2xl p-5 text-left transition-all relative">
                  <span className="absolute top-2 right-2 text-[9px] text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-full">권장</span>
                  <div className="w-10 h-10 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center justify-center mb-3"><Zap className="w-5 h-5 text-emerald-400" /></div>
                  <h3 className="text-base font-semibold text-white mb-1">로컬로 바로 시작</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">계정 0개 · 추가 설정 0개<br />포트·프로젝트 관리부터 즉시 사용</p>
                  <div className="flex items-center gap-1 text-emerald-400 text-xs mt-4">앱 열기 <ChevronRight className="w-3.5 h-3.5" /></div>
                </button>
                <button onClick={() => setMode('first')} className="group bg-zinc-900 hover:bg-zinc-800 border-2 border-blue-500/40 hover:border-blue-500/70 rounded-2xl p-5 text-left transition-all">
                  <div className="w-10 h-10 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center justify-center mb-3"><Plus className="w-5 h-5 text-blue-400" /></div>
                  <h3 className="text-base font-semibold text-white mb-1">첫 단말 · 동기화 설정</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">Dashboard에서 DB 준비<br />앱 연결은 이 PC의 CLI 인증 1회</p>
                  <div className="flex items-center gap-1 text-blue-400 text-xs mt-4">설정 시작 <ChevronRight className="w-3.5 h-3.5" /></div>
                </button>
                <button
                  onClick={() => setMode(isRegisteredDevice ? 'pair_device' : 'additional')}
                  aria-label={isRegisteredDevice ? '다른 PC 연결 정보 만들기' : '두 번째·추가 기기 연결'}
                  className="group bg-zinc-900 hover:bg-zinc-800 border-2 border-violet-500/40 hover:border-violet-500/70 rounded-2xl p-5 text-left transition-all"
                >
                  <div className="w-10 h-10 bg-violet-500/10 border border-violet-500/20 rounded-xl flex items-center justify-center mb-3"><Laptop className="w-5 h-5 text-violet-400" /></div>
                  <h3 className="text-base font-semibold text-white mb-1">{isRegisteredDevice ? '다른 PC 연결 정보 만들기' : '두 번째·추가 기기 연결'}</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">{isRegisteredDevice ? 'Vercel 배포 없이 바로 초대 복사' : isPendingAdditionalDevice ? '중단된 등록을 같은 ID로 재개' : '기존 앱 또는 배포 포털에서 복사'}<br />{isRegisteredDevice ? '새 PC는 자기 UUID로 안전하게 등록' : '붙여넣고 로컬에서 안전하게 등록'}</p>
                  <div className="flex items-center gap-1 text-violet-400 text-xs mt-4">{isRegisteredDevice ? '연결 정보 만들기' : isPendingAdditionalDevice ? '등록 이어가기' : '연결 시작'} <ChevronRight className="w-3.5 h-3.5" /></div>
                </button>
              </div>

              <div className="w-full max-w-4xl bg-zinc-900/60 border border-teal-400/25 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldCheck className="w-4 h-4 text-teal-300 shrink-0" />
                  <div><p className="text-xs text-zinc-100 font-medium">전체 설치·연결 현황판</p><p className="text-[10px] text-zinc-500">GitHub·Supabase·Vercel·AI·Buzz·Hermes·AWS를 필수/선택으로 나눠 확인합니다.</p></div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setMode('infrastructure')} className="flex items-center gap-1 px-3 py-1.5 text-[11px] rounded-md border border-teal-400/30 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15 shrink-0">
                    현황판 열기 <ChevronRight className="w-3 h-3" />
                  </button>
                  <button onClick={() => {
                    const platform = detectedOs === 'windows' ? 'windows' : 'mac';
                    navigator.clipboard.writeText(buildOnboardingAgentPrompt({ scenario: isRegisteredDevice ? 'additional' : 'first', platform }));
                    setQuickInstallCopied(true);
                    setTimeout(() => setQuickInstallCopied(false), 2000);
                  }} className={`flex items-center gap-1 px-3 py-1.5 text-[11px] rounded-md border shrink-0 ${quickInstallCopied ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-300'}`}>
                    {quickInstallCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{quickInstallCopied ? '복사됨' : 'AI 동행 프롬프트'}
                  </button>
                </div>
              </div>

              <details className="w-full max-w-4xl rounded-xl border border-zinc-800 bg-zinc-900/30 group">
                <summary className="cursor-pointer list-none px-4 py-3 text-xs text-zinc-400 hover:text-zinc-200 flex items-center justify-between"><span>선택 기능 · 고급 설정</span><ChevronRight className="w-4 h-4 group-open:rotate-90 transition-transform" /></summary>
                <div className="border-t border-zinc-800 p-3 grid sm:grid-cols-2 gap-2">
                  <button onClick={() => setMode('one_click')} className="rounded-lg border border-zinc-700 hover:border-amber-500/50 p-3 text-left"><p className="text-sm text-zinc-200">기존 Supabase CLI 빠른 연결</p><p className="text-[11px] text-zinc-500">이미 CLI 로그인과 프로젝트가 준비된 경우</p></button>
                  <button onClick={() => setMode('infrastructure')} className="rounded-lg border border-zinc-700 hover:border-teal-500/50 p-3 text-left"><p className="text-sm text-zinc-200">전체 설치 현황</p><p className="text-[11px] text-zinc-500">필수·선택 도구와 AI 복붙 안내</p></button>
                  <button onClick={() => setMode('dev_env')} className="rounded-lg border border-zinc-700 hover:border-sky-500/50 p-3 text-left"><p className="text-sm text-zinc-200">개발 환경 설정</p><p className="text-[11px] text-zinc-500">Bun·Git·Claude Code 등 개발 도구</p></button>
                  <button onClick={() => setMode('portal')} className="rounded-lg border border-zinc-700 hover:border-violet-500/50 p-3 text-left"><p className="text-sm text-zinc-200">포털 배포 · Google 로그인</p><p className="text-[11px] text-zinc-500">Vercel 웹 포털이 필요한 경우</p></button>
                  <button onClick={() => setMode('terminal_tools')} className="rounded-lg border border-zinc-700 hover:border-purple-500/50 p-3 text-left"><p className="text-sm text-zinc-200">터미널 도구 가이드</p><p className="text-[11px] text-zinc-500">tmux·cmux는 사용할 때만 설치</p></button>
                </div>
              </details>
              <p className="text-[11px] text-zinc-700 text-center">
                설정은 앱 사용 중 언제든 ⚙에서 다시 열 수 있습니다
              </p>
            </div>
          )}
          {mode === 'infrastructure' && (
            <OnboardingInfrastructureCenter
              onBack={() => setMode('choose')}
              initialScenario={isRegisteredDevice ? 'additional' : 'first'}
            />
          )}
          {mode === 'first' && <FirstSetupWizard onComplete={onComplete} onBack={() => setMode('choose')} onAdvanced={() => setMode('first_cli')} />}
          {mode === 'first_cli' && <AdvancedFirstSetupWizard onComplete={onComplete} onBack={() => setMode('first')} />}
          {mode === 'additional' && <AdditionalDeviceWizard onComplete={onComplete} onBack={() => setMode('choose')} />}
          {mode === 'pair_device' && <AdditionalDeviceInviteWizard onBack={() => setMode('choose')} />}
          {mode === 'portal' && <PortalVercelWizard onBack={() => setMode('choose')} onClose={onSkip} />}
          {mode === 'dev_env' && (
            <DevEnvWizard defaultOs={detectedOs ?? 'mac'} onBack={() => setMode('choose')} />
          )}
          {/* Legacy direct entry (kept for backward compat) */}
          {mode === 'windows_env' && <WindowsEnvWizard onBack={() => setMode('choose')} />}
          {mode === 'mac_env' && <MacEnvWizard onBack={() => setMode('choose')} />}
          {mode === 'terminal_tools' && <TerminalToolsWizard onBack={() => setMode('choose')} />}
          {mode === 'one_click' && <OneClickWizard onBack={() => setMode('choose')} onComplete={onComplete} />}
        </div>
      </div>
    </div>
  );
}

// ─── One-Click Install Wizard ────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skip';

interface InstallStep {
  id: string;
  label: string;
  desc: string;
  status: StepStatus;
  detail?: string;
  action?: () => Promise<void>;
  browserAction?: () => Promise<void>;
  needsBrowser?: boolean;
  pollEndpoint?: string;
  pollKey?: string; // 'loggedIn'
  /** GitHub/Vercel do not block a local or Supabase-only setup. */
  optional?: boolean;
}

function StepRow({ step, onAction, onPoll, onSkip }: { step: InstallStep; onAction: () => void; onPoll: () => void; onSkip: () => void }) {
  const icon = {
    pending: <div className="w-5 h-5 rounded-full border-2 border-zinc-600" />,
    running: <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" />,
    done:    <Check className="w-5 h-5 text-emerald-400" />,
    error:   <span className="w-5 h-5 text-red-400 text-xs font-bold flex items-center justify-center">✗</span>,
    skip:    <Check className="w-5 h-5 text-zinc-500" />,
  }[step.status];

  return (
    <div className={`flex items-start gap-3 p-3 rounded-xl border transition-all ${
      step.status === 'done' || step.status === 'skip' ? 'border-zinc-800/40 bg-zinc-900/30 opacity-70' :
      step.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' :
      step.status === 'error' ? 'border-red-500/30 bg-red-500/5' :
      'border-zinc-800 bg-zinc-900/60'
    }`}>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-200">{step.label}</p>
        <p className="text-xs text-zinc-500">{step.desc}</p>
        {step.detail && (
        <div className="flex items-start gap-1.5 mt-0.5">
          <p className={`text-xs flex-1 ${step.status === 'error' ? 'text-amber-300' : 'text-zinc-400'}`}>{step.detail}</p>
          {step.status === 'error' && step.detail?.includes(':') && (
            <button
              onClick={() => navigator.clipboard.writeText(step.detail?.split(':').slice(1).join(':').trim() ?? '')}
              className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-700 rounded px-1.5 py-0.5 transition-colors"
              title="명령어 복사">
              복사
            </button>
          )}
        </div>
      )}
      </div>
      <div className="shrink-0 flex gap-2">
        {(step.status === 'pending' || step.status === 'error') && step.browserAction && (
          <button onClick={onAction}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white font-medium transition-colors">
            브라우저 열기
          </button>
        )}
        {step.status === 'running' && step.pollEndpoint && (
          <button onClick={onPoll}
            className="px-3 py-1.5 rounded-lg border border-zinc-600 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors">
            완료 확인
          </button>
        )}
        {step.optional && (step.status === 'pending' || step.status === 'error') && (
          <button onClick={onSkip}
            className="px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-xs text-zinc-400 transition-colors">
            건너뛰기
          </button>
        )}
      </div>
    </div>
  );
}

function OneClickWizard({ onBack, onComplete }: { onBack: () => void; onComplete: SetupWizardProps['onComplete'] }) {
  const autoOs: OS = /Win/.test(navigator.platform ?? '') ? 'windows' : 'mac';
  const [os, setOs] = React.useState<OS>(autoOs);
  const isWin = os === 'windows';

  // OS별 설치 명령 헬퍼
  const cmd = {
    supabaseCli: isWin
      ? 'scoop bucket add supabase https://github.com/supabase/scoop-bucket.git\nscoop install supabase'
      : 'brew install supabase/tap/supabase',
    githubCli: isWin ? 'winget install GitHub.cli' : 'brew install gh',
    vercelCli: 'npm install -g vercel',
    supabaseLogin: isWin ? 'supabase login' : 'supabase login',
    githubLogin: 'gh auth login --web',
    vercelLogin: 'vercel login',
  };

  const [steps, setSteps] = React.useState<InstallStep[]>([
    {
      id: 'supabase_login',
      label: '① Supabase 로그인',
      desc: '브라우저에서 Supabase 계정으로 로그인 (CLI 자동 인증)',
      status: 'pending',
      pollEndpoint: '/api/supabase-cli/status',
      pollKey: 'loggedIn',
    },
    {
      id: 'select_project',
      label: '② 프로젝트 선택',
      desc: '로그인 후 사용할 Supabase 프로젝트를 선택합니다',
      status: 'pending',
    },
    {
      id: 'fetch_credentials',
      label: '③ Supabase 연결 정보 가져오기',
      desc: 'CLI로 프로젝트 URL / Anon Key를 자동으로 가져옵니다 (수동 입력 불필요)',
      status: 'pending',
    },
    {
      id: 'create_tables',
      label: '④ 테이블 자동 생성',
      desc: `Supabase CLI로 필요한 ${SCHEMA_TABLE_COUNT}개 테이블과 RLS 정책을 생성합니다`,
      status: 'pending',
    },
    {
      id: 'github_cli',
      label: '⑤ GitHub 계정 연결 (선택)',
      desc: '포크·푸시·GitHub Actions를 쓸 때만 GitHub CLI에 로그인합니다',
      status: 'pending',
      pollEndpoint: '/api/github-cli/status',
      pollKey: 'loggedIn',
      optional: true,
    },
    {
      id: 'vercel_cli',
      label: '⑥ Vercel 계정 연결 (선택)',
      desc: '북마크 포털을 웹에 배포할 때만 Vercel CLI에 로그인합니다',
      status: 'pending',
      pollEndpoint: '/api/vercel-cli/status',
      pollKey: 'loggedIn',
      optional: true,
    },
    {
      id: 'finish_setup',
      label: '⑦ 로컬 설정 완료',
      desc: 'CLI 토큰은 이 기기에만 보관하고 설치 설정을 완료합니다',
      status: 'pending',
    },
  ]);

  const [sbUrl, setSbUrl] = React.useState('');
  const [sbKey, setSbKey] = React.useState('');
  const [allowedEmail, setAllowedEmail] = React.useState('');
  const [deviceName, setDeviceName] = React.useState('');
  const [activeStep, setActiveStep] = React.useState<string | null>(null);
  const [allDone, setAllDone] = React.useState(false);
  const [projects, setProjects] = React.useState<{ref: string; name: string; region: string}[]>([]);
  const [selectedRef, setSelectedRef] = React.useState('');

  // 기존 portal.json에서 Supabase URL/Key/기기명 자동 로드
  React.useEffect(() => {
    fetch('/api/portal').then(r => r.json()).then((d: any) => {
      if (d.supabaseUrl) setSbUrl(d.supabaseUrl);
      if (d.supabaseAnonKey) setSbKey(d.supabaseAnonKey);
      if (d.deviceName) setDeviceName(d.deviceName);
      // 기존 URL/키가 있으면 자동 가져오기 단계만 완료로 표시한다.
      // CLI 로그인·프로젝트 선택은 테이블 설치가 필요할 때 별도로 확인해야 한다.
      if (d.supabaseUrl && d.supabaseAnonKey) {
        setSteps(prev => prev.map(s => s.id === 'fetch_credentials'
          ? { ...s, status: 'done' as const, detail: `${d.supabaseUrl.replace('https://', '').slice(0, 30)}… (기존 설정)` }
          : s
        ));
      }
    }).catch(() => {});
  }, []);

  function updateStep(id: string, patch: Partial<InstallStep>) {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }

  function skipStep(id: string) {
    const step = steps.find(s => s.id === id);
    if (!step?.optional) return;
    updateStep(id, { status: 'skip', detail: '선택 기능 — 나중에 설정에서 연결할 수 있습니다' });
  }

  async function runStep(id: string) {
    setActiveStep(id);
    updateStep(id, { status: 'running', detail: undefined });

    try {
      if (id === 'supabase_login') {
        const statusRes = await fetch('/api/supabase-cli/status');
        const statusData = await statusRes.json() as any;
        if (statusData.loggedIn) {
          // 이미 로그인 → 프로젝트 목록 자동 로드
          setProjects(statusData.projects ?? []);
          updateStep(id, { status: 'done', detail: `이미 로그인됨 (${statusData.projects?.length ?? 0}개 프로젝트)` });
          return;
        }
        if (!statusData.installed) {
          updateStep(id, { status: 'error', detail: `CLI 먼저 설치: ${cmd.supabaseCli}` });
          return;
        }
        await fetch('/api/supabase-login', { method: 'POST' });
        updateStep(id, { status: 'running', detail: '터미널에서 Supabase 로그인 완료 후 "완료 확인" 클릭' });
        return;
      }

      if (id === 'select_project') {
        // 프로젝트 목록 로드 (없으면 다시 조회)
        let pList = projects;
        if (projects.length === 0) {
          const statusRes = await fetch('/api/supabase-cli/status');
          const statusData = await statusRes.json() as any;
          pList = statusData.projects ?? [];
          setProjects(pList);
        }
        // 프로젝트가 1개면 자동 선택
        if (pList.length === 1 && !selectedRef) {
          setSelectedRef(pList[0]!.ref);
          updateStep(id, { status: 'done', detail: `자동 선택: ${pList[0]!.name}` });
        } else if (selectedRef) {
          const proj = pList.find(p => p.ref === selectedRef);
          updateStep(id, { status: 'done', detail: `선택됨: ${proj?.name ?? selectedRef}` });
        } else {
          updateStep(id, { status: 'running', detail: '아래 드롭다운에서 프로젝트를 선택하세요' });
        }
        return;
      }

      if (id === 'fetch_credentials') {
        if (!selectedRef) {
          updateStep(id, { status: 'error', detail: '② 프로젝트를 먼저 선택하세요' }); return;
        }
        const res = await fetch(`/api/supabase-cli/apikeys?ref=${selectedRef}`);
        const data = await res.json() as any;
        if (data.error) throw new Error(data.error);
        setSbUrl(data.projectUrl);
        setSbKey(data.anonKey);
        // portal.json에 자동 저장
        const portalRes = await fetch('/api/portal');
        const portalData = await portalRes.json() as any;
        await fetch('/api/portal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...portalData, supabaseUrl: data.projectUrl, supabaseAnonKey: data.anonKey, deviceName: deviceName || portalData.deviceName }),
        });
        updateStep(id, { status: 'done', detail: `URL/Key 자동 획득: ${data.projectUrl?.slice(0, 30)}…` });
        return;
      }

      if (id === 'create_tables') {
        if (!selectedRef) {
          updateStep(id, { status: 'error', detail: '② 프로젝트를 먼저 선택하세요' }); return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail.trim())) {
          updateStep(id, { status: 'error', detail: '서버 RLS에 등록할 올바른 Google 이메일을 입력하세요' }); return;
        }
        updateStep(id, { status: 'running', detail: 'CLI로 테이블 생성 중…' });
        // 1. 프로젝트 링크
        const linkRes = await fetch('/api/supabase-cli/link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: selectedRef }),
        });
        const linkData = await linkRes.json() as any;
        if (linkData.error && !linkData.error.includes('already')) {
          // 링크 실패해도 create-tables 시도 (이미 링크된 경우 등)
        }
        // 2. 테이블 자동 생성
        const tableRes = await fetch('/api/supabase-cli/create-tables', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: selectedRef, allowedEmails: [allowedEmail] }),
        });
        const tableData = await tableRes.json() as any;
        if (tableData.error) throw new Error(tableData.error);
        updateStep(id, { status: 'done', detail: tableData.message ?? `${SCHEMA_TABLE_COUNT}개 테이블 생성 완료` });
        return;
      }

      if (id === 'github_cli') {
        const statusRes = await fetch('/api/github-cli/status');
        const statusData = await statusRes.json();
        if (statusData.installed && statusData.loggedIn) {
          updateStep(id, { status: 'done', detail: `로그인됨 (${statusData.user})` }); return;
        }
        if (!statusData.installed) {
          updateStep(id, {
            status: 'error',
            detail: `${isWin ? 'PowerShell 관리자 권한으로' : '터미널에서'} 설치: ${cmd.githubCli}`,
          }); return;
        }
        await fetch('/api/github-cli/login', { method: 'POST' });
        updateStep(id, { status: 'running', detail: `브라우저에서 GitHub 로그인 완료 후 "완료 확인" 클릭` });
        return;
      }

      if (id === 'vercel_cli') {
        const statusRes = await fetch('/api/vercel-cli/status');
        const statusData = await statusRes.json();
        if (statusData.installed && statusData.loggedIn) {
          updateStep(id, { status: 'done', detail: `로그인됨 (${statusData.user})` }); return;
        }
        if (!statusData.installed) {
          updateStep(id, { status: 'error', detail: `터미널에서 설치: ${cmd.vercelCli}` }); return;
        }
        await fetch('/api/vercel-cli/login', { method: 'POST' });
        updateStep(id, { status: 'running', detail: '브라우저에서 Vercel 로그인 완료 후 "완료 확인" 클릭' });
        return;
      }

      // init_tables는 새 흐름에서 create_tables로 대체됨 (fallback 유지)

      if (id === 'finish_setup') {
        if (!sbUrl || !sbKey) {
          updateStep(id, { status: 'error', detail: '③ Supabase 연결 정보를 먼저 가져오세요' });
          return;
        }
        if (!deviceName.trim()) {
          updateStep(id, { status: 'error', detail: '이 기기 이름을 먼저 입력하세요' });
          return;
        }

        // 공개 연결 설정만 portal.json에 저장합니다. CLI 토큰은 읽거나 전송하지 않습니다.
        const portalRes = await fetch('/api/portal');
        const portalData = portalRes.ok ? await portalRes.json() as any : {};
        // device_id는 기기별 동기화의 소유 키다. 이전 설정이 있으면 유지하고,
        // 새 설정은 PortalManager와 같은 UUID 형식으로 만든다.
        const deviceId = typeof portalData.deviceId === 'string' && portalData.deviceId
          ? portalData.deviceId
          : crypto.randomUUID();
        const saveRes = await fetch('/api/portal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...portalData,
            supabaseUrl: sbUrl,
            supabaseAnonKey: sbKey,
            deviceName: deviceName.trim(),
            deviceId,
          }),
        });
        if (!saveRes.ok) throw new Error('로컬 설정을 저장하지 못했습니다');

        updateStep(id, { status: 'running', detail: isTauri() ? '로컬 앱 원격 연결 확인 중…' : 'Google 로그인과 DB 접근 권한 확인 중…' });
        if (isTauri()) {
          await configureLocalAdminFromCli(sbUrl);
        }
        await onComplete({
          supabaseUrl: sbUrl,
          supabaseAnonKey: sbKey,
          deviceName: deviceName.trim(),
          deviceId,
          setupKind: 'first',
          localAdminReady: true,
        });
        updateStep(id, { status: 'done', detail: isTauri() ? '로그인 없는 앱 연결 · 로컬 설정 완료' : 'Google 로그인 · DB 권한 · 로컬 설정 완료' });
        setAllDone(true);
        return;
      }
    } catch (e: any) {
      updateStep(id, { status: 'error', detail: e.message });
    } finally {
      setActiveStep(null);
    }
  }

  async function pollStep(id: string) {
    const step = steps.find(s => s.id === id);
    if (!step?.pollEndpoint) return;
    updateStep(id, { detail: '확인 중…' });

    // 특수 처리
    if (id === 'supabase_login') { await pollSupabaseLogin(); return; }
    if (id === 'select_project') { await runStep('select_project'); return; }
    if (id === 'create_tables') { await runStep('create_tables'); return; }
    if (id === 'init_tables') { await runStep('create_tables'); return; }

    try {
      const res = await fetch(step.pollEndpoint);
      const data = await res.json();
      const loggedIn = data.loggedIn || (data.installed && data.loggedIn !== false);
      if (loggedIn) {
        updateStep(id, { status: 'done', detail: data.user ? `로그인됨 (${data.user})` : '완료' });
      } else {
        updateStep(id, { detail: '아직 로그인이 확인되지 않았습니다. 브라우저 인증을 완료해주세요.' });
      }
    } catch { updateStep(id, { detail: '확인 실패 — 다시 시도해주세요' }); }
  }

  // pollStep에서 supabase_login 특수 처리
  async function pollSupabaseLogin() {
    updateStep('supabase_login', { detail: '로그인 확인 중…' });
    try {
      const res = await fetch('/api/supabase-cli/status');
      const data = await res.json() as any;
      if (data.loggedIn) {
        setProjects(data.projects ?? []);
        updateStep('supabase_login', { status: 'done', detail: `로그인됨 (${data.projects?.length ?? 0}개 프로젝트 발견)` });
        // 프로젝트 1개면 자동 선택
        if (data.projects?.length === 1) {
          setSelectedRef(data.projects[0].ref);
          updateStep('select_project', { status: 'done', detail: `자동 선택: ${data.projects[0].name}` });
        }
      } else {
        updateStep('supabase_login', { detail: '아직 로그인이 완료되지 않았습니다. 터미널을 확인해주세요.' });
      }
    } catch { updateStep('supabase_login', { detail: '확인 실패 — 다시 시도해주세요' }); }
  }

  const doneCount = steps.filter(s => s.status === 'done' || s.status === 'skip').length;
  const nextPending = steps.find(s => s.status === 'pending' || s.status === 'error');

  return (
    <div className="h-full flex flex-col p-4 sm:p-8 overflow-y-auto">
      <button onClick={onBack} className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 text-sm mb-6 transition-colors w-fit">
        ← 돌아가기
      </button>

      <div className="max-w-xl w-full mx-auto space-y-5">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-400" />
              Supabase 동기화 빠른 설정
            </h2>
            {/* OS 선택 토글 */}
            <div className="flex items-center gap-1 bg-zinc-800 border border-zinc-700 rounded-lg p-1">
              <button onClick={() => setOs('mac')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${os === 'mac' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                🍎 Mac
              </button>
              <button onClick={() => setOs('windows')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${os === 'windows' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                🪟 Windows
              </button>
            </div>
          </div>
          <p className="text-zinc-500 text-sm mt-1">
            이미 만든 Supabase 프로젝트를 이 기기에 연결합니다. GitHub와 Vercel은 필요할 때만 연결하세요.
            <span className="text-amber-400 ml-1">{os === 'mac' ? '🍎 macOS' : '🪟 Windows'} 가이드</span>가 적용됩니다.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <div className="flex-1 bg-zinc-800 rounded-full h-1.5">
              <div className="bg-emerald-500 h-1.5 rounded-full transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
            <span className="text-xs text-zinc-500">{doneCount}/{steps.length}</span>
          </div>
        </div>

        {/* ② 프로젝트 선택 드롭다운 — 로그인 후 프로젝트 목록이 있을 때 표시 */}
        {projects.length > 0 && steps.find(s => s.id === 'select_project')?.status !== 'done' && (
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-blue-300">② Supabase 프로젝트 선택</p>
            <select
              value={selectedRef}
              onChange={e => setSelectedRef(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-blue-500"
            >
              <option value="">프로젝트를 선택하세요</option>
              {projects.map(p => (
                <option key={p.ref} value={p.ref}>{p.name} ({p.region})</option>
              ))}
            </select>
            <input value={deviceName} onChange={e => setDeviceName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
              placeholder="이 기기 이름 (예: 내 맥북 프로)" />
            <button
              onClick={async () => {
                if (!selectedRef) return;
                const proj = projects.find(p => p.ref === selectedRef);
                updateStep('select_project', { status: 'done', detail: `선택됨: ${proj?.name}` });
                // 즉시 다음 단계(fetch_credentials) 자동 실행
                await runStep('fetch_credentials');
              }}
              disabled={!selectedRef}
              className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-medium transition-colors"
            >
              이 프로젝트 선택 →
            </button>
          </div>
        )}

        {/* 서버 RLS owner 입력 — client allowlist만으로는 PostgREST 직접 호출을 막지 못한다. */}
        {steps.find(s => s.id === 'select_project')?.status === 'done' &&
         steps.find(s => s.id === 'create_tables')?.status !== 'done' && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
            <p className="text-xs font-semibold text-emerald-300">서버 RLS 허용 Google 이메일</p>
            <input
              type="email"
              value={allowedEmail}
              onChange={event => setAllowedEmail(event.target.value)}
              className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
              placeholder="owner@example.com"
            />
            <p className="text-[11px] text-zinc-500">빈 목록은 모두 차단합니다. VITE_ALLOWED_EMAIL을 쓰면 같은 목록을 유지하세요.</p>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Supabase Dashboard → Authentication → URL Configuration → <strong>Redirect URLs</strong>에<br />
              <code>http://127.0.0.1:3001/api/auth/native/callback/*</code>을 추가하세요.
            </p>
          </div>
        )}

        {/* 기기 이름 입력 (별도 상태) */}
        {steps.find(s => s.id === 'select_project')?.status === 'done' &&
         steps.find(s => s.id === 'finish_setup')?.status !== 'done' && !deviceName && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs text-amber-300 mb-2">이 기기 이름을 입력하세요 (최종 저장에 필요)</p>
            <div className="flex gap-2">
              <input value={deviceName} onChange={e => setDeviceName(e.target.value)}
                className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500"
                placeholder="예: 내 맥북 프로" />
            </div>
          </div>
        )}

        {/* 스텝 목록 */}
        <div className="space-y-2">
          {steps.map(step => (
            <StepRow
              key={step.id}
              step={step}
              onAction={() => runStep(step.id)}
              onPoll={() => pollStep(step.id)}
              onSkip={() => skipStep(step.id)}
            />
          ))}
        </div>

        {/* 다음 단계 실행 버튼 */}
        {!allDone && nextPending && (
          <button
            onClick={() => runStep(nextPending.id)}
            disabled={activeStep !== null}
            className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-sm font-bold text-zinc-900 transition-colors flex items-center justify-center gap-2"
          >
            {activeStep ? <><RefreshCw className="w-4 h-4 animate-spin" /> 진행 중…</> : <>▶ {nextPending.label} 시작</>}
          </button>
        )}

        {allDone && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-center space-y-3">
            <p className="text-2xl">🎉</p>
            <p className="text-base font-bold text-emerald-400">설치 완료!</p>
            <p className="text-sm text-zinc-400">로컬 설정이 완료되었습니다. CLI 로그인 토큰은 이 기기에만 유지됩니다.</p>
          </div>
        )}

        <div className="text-xs text-zinc-700 space-y-1">
          <p>• Supabase CLI가 없으면 자동으로 설치 명령을 알려드립니다</p>
          <p>• GitHub / Vercel 로그인은 브라우저에서 처리됩니다 (토큰 직접 입력 불필요)</p>
          <p>• CLI 로그인 토큰은 Supabase에 업로드하거나 새 기기로 복원하지 않습니다</p>
          <p>• 이미 완료된 단계는 자동으로 건너뜁니다</p>
        </div>
      </div>
    </div>
  );
}

// ─── Terminal Tools Wizard (tmux + cmux) ─────────────────────────────────────

function TerminalToolsWizard({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'tmux' | 'cmux'>('tmux');
  const [os, setOs] = useState<OS>(() => /Win/.test(navigator.platform ?? '') ? 'windows' : 'mac');

  return (
    <div className="h-full flex flex-col p-4 sm:p-8 overflow-y-auto">
      <button onClick={onBack} className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 text-sm mb-6 transition-colors w-fit">
        ← 돌아가기
      </button>

      <div className="max-w-2xl w-full mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-purple-400" />
            터미널 도구 설치 가이드
          </h2>
          <p className="text-zinc-500 text-sm mt-1">Claude 버튼에서 사용하는 tmux · cmux 터미널 설정</p>
        </div>

        {/* 탭 */}
        <div className="flex gap-1 bg-zinc-800 border border-zinc-700 rounded-lg p-1 w-fit">
          <button onClick={() => setTab('tmux')} className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${tab === 'tmux' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
            tmux (Mac · Windows)
          </button>
          <button onClick={() => setTab('cmux')} className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${tab === 'cmux' ? 'bg-purple-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
            cmux (Mac 전용)
          </button>
        </div>

        {tab === 'tmux' && (
          <div className="space-y-5">
            <InfoBox color="blue">
              <strong>tmux</strong>는 터미널 세션을 분리·유지하는 멀티플렉서입니다. 포트 관리기에서 "tmux" 버튼을 클릭하면 별도 tmux 세션에서 Claude가 실행됩니다.
            </InfoBox>

            <OsToggle os={os} onChange={setOs} />

            {os === 'mac' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-zinc-300">macOS 설치</h3>
                <CodeBlock code="brew install tmux" label="① Homebrew로 설치" />
                <CodeBlock code="tmux -V" label="② 설치 확인" comment="tmux 3.x 이상 권장" />
                <CodeBlock code="tmux new-session -s test" label="③ 테스트 세션 생성" comment="Ctrl+B, D 로 세션 분리 / tmux attach -t test 로 재접속" />
              </div>
            )}

            {os === 'windows' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-zinc-300">Windows (WSL2) 설치</h3>
                <InfoBox color="amber">
                  Windows에서 tmux는 WSL2 내에서 실행됩니다. WSL2가 먼저 설치되어 있어야 합니다.
                </InfoBox>
                <CodeBlock code="wsl --install" label="① WSL2 설치 (PowerShell 관리자 권한)" comment="재부팅 후 Ubuntu 배포판 설정" />
                <CodeBlock code="sudo apt update && sudo apt install -y tmux" label="② WSL2 터미널에서 tmux 설치" />
                <CodeBlock code="tmux -V" label="③ 설치 확인" />
              </div>
            )}

            <InfoBox color="green">
              설치 완료 후 포트 관리기 카드의 더보기 메뉴 → <strong>tmux ⚡</strong> 버튼으로 Claude를 tmux 세션에서 실행합니다.
            </InfoBox>
          </div>
        )}

        {tab === 'cmux' && (
          <div className="space-y-5">
            <InfoBox color="blue">
              <strong>cmux</strong>는 AI 코딩 에이전트 전용 macOS 네이티브 터미널입니다. Ghostty 렌더링 엔진 기반으로 내장 WebKit 브라우저, Unix Socket API를 제공합니다.
            </InfoBox>

            <InfoBox color="amber">
              🍎 cmux는 <strong>macOS 전용</strong>입니다. Windows에서는 tmux(WSL2)를 사용하세요.
            </InfoBox>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300">설치</h3>
              <CodeBlock code="brew tap manaflow-ai/cmux" label="① tap 등록" />
              <CodeBlock code="brew install --cask cmux" label="② cmux 설치" />
              <CodeBlock code="cmux identify" label="③ 설치 확인" comment="cmux가 실행 중이면 현재 컨텍스트 정보 출력" />
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                Socket Control 설정 <span className="text-red-400 text-xs font-normal bg-red-400/10 px-1.5 py-0.5 rounded">필수</span>
              </h3>
              <InfoBox color="amber">
                cmux는 기본으로 <strong>cmuxOnly 모드</strong>입니다 — 외부 앱(포트 관리기 API 서버 등)의 소켓 연결을 차단합니다. 아래 명령으로 <strong>Allow All</strong>로 변경 후 재시작해야 버튼이 정상 작동합니다.
              </InfoBox>
              <CodeBlock
                label="① Socket Control → Allow All 설정"
                code={`defaults write com.cmuxterm.app socketControlMode -string "allowAll"`}
              />
              <CodeBlock
                label="② cmux 재시작 (설정 적용)"
                code={`pkill -f "cmux.app/Contents/MacOS/cmux" 2>/dev/null; sleep 2; open -a cmux; sleep 4`}
              />
              <CodeBlock
                label="③ 연결 확인 — PONG 응답이면 성공"
                code="cmux ping"
              />
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300">주요 CLI 명령어</h3>
              <CodeBlock code="cmux send 'claude --dangerously-skip-permissions'" label="Claude 실행 명령 전송" />
              <CodeBlock code="cmux read-screen" label="현재 패인 출력 읽기" />
              <CodeBlock code="cmux browser open https://localhost:3000" label="내장 브라우저 열기" />
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                Claude Agent View
                <span className="text-xs font-normal text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded">신규</span>
              </h3>
              <InfoBox color="blue">
                헤더 <strong>[Agents]</strong> 버튼으로 cmux에서 claude agents 전역 뷰를 엽니다. 포트 카드 더보기 → <strong>Project Agents</strong>로 프로젝트 폴더에서 <code>claude --resume</code> TUI를 시작합니다.
              </InfoBox>
              <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-1.5 text-xs text-zinc-400">
                <p className="font-medium text-zinc-300 mb-1">진입점</p>
                <p><span className="text-violet-400 font-mono">헤더 [Agents]</span> — <code>~/.claude</code>에서 claude agents 전역 뷰</p>
                <p><span className="text-violet-400 font-mono">카드 ▼ → Project Agents</span> — 프로젝트에서 <code>claude --resume</code> TUI</p>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                claude --bg (bypass 모드)
                <span className="text-xs font-normal text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded">신규</span>
              </h3>
              <InfoBox color="amber">
                <code>--dangerously-skip-permissions</code>으로 Claude를 권한 프롬프트 없이 실행합니다. <strong>bypass ON</strong> 토글을 켜면 모든 cmux 버튼이 bypass 모드로 전환됩니다.
              </InfoBox>
              <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-1.5 text-xs text-zinc-400">
                <p className="font-medium text-zinc-300 mb-1">진입점</p>
                <p><span className="text-yellow-400 font-mono">헤더 [--bg]</span> — HOME(<code>~</code>)에서 bypass Claude 실행</p>
                <p><span className="text-yellow-400 font-mono">터미널뷰 [--bg]</span> — 현재 포트 폴더에서 bypass 실행</p>
                <p><span className="text-yellow-400 font-mono">bypass ON 토글</span> — 활성화 시 모든 cmux 버튼 bypass 모드</p>
              </div>
            </div>

            <InfoBox color="green">
              설치 완료 후 포트 관리기 카드의 더보기 메뉴 → <strong>cmux ⚡ (Mac)</strong> 버튼으로 cmux에서 Claude를 실행합니다.
            </InfoBox>

            <div className="bg-zinc-800/50 border border-yellow-500/20 rounded-xl p-3 flex items-center gap-3 text-xs text-zinc-400">
              <Zap className="w-4 h-4 text-yellow-400 shrink-0" />
              <span>선택 도구 설치 전에는 <strong className="text-zinc-300">세팅 첫 화면 → 에이전트 온보딩 프롬프트</strong>에서 현재 환경을 먼저 진단하세요.</span>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-300">CLAUDE.md에 추가</h3>
              <p className="text-xs text-zinc-500">cmux 안에서 Claude를 실행할 때, 아래 내용을 프로젝트 <strong className="text-zinc-300">CLAUDE.md</strong>에 추가하세요. Claude가 tmux 대신 cmux CLI를 사용하고 소켓 문제 시 스스로 복구합니다.</p>
              <CodeBlock
                label="CLAUDE.md에 추가"
                code={`# cmux 환경\n이 환경은 cmux입니다. tmux가 아닌 cmux CLI를 사용하세요.\n\n## 계층 구조\nWindow > Workspace > Pane > Surface\n\n## 환경변수 (자동 설정)\n- CMUX_WORKSPACE_ID\n- CMUX_SURFACE_ID\n- CMUX_SOCKET_PATH\n\n## 핵심 명령어\ncmux identify              # 현재 컨텍스트 확인\ncmux tree --all            # 전체 구조 확인\ncmux read-screen --lines 50       # 현재 패인 출력 읽기\ncmux send --surface S "cmd\\n"    # 다른 패인에 명령 전송\ncmux browser snapshot -i          # DOM 스냅샷 (Playwright 불필요)\ncmux notify --title "완료" --body "작업 완료"  # 알림\n\n## tmux → cmux 치환\n- tmux send-keys  →  cmux send\n- tmux capture-pane  →  cmux read-screen\n\n## 소켓 연결 문제 시\ncmux ping 실패 시 아래 명령으로 복구:\ndefaults write com.cmuxterm.app socketControlMode -string "allowAll"\npkill -f "cmux.app/Contents/MacOS/cmux"; sleep 2; open -a cmux; sleep 4\ncmux ping  # PONG 확인`}
              />
              <p className="text-xs text-zinc-500">
                <span className="text-zinc-400">예시 지시:</span> "오른쪽 패인(surface:4)에서 서버가 돌아가고 있어. cmux read-screen으로 서버 로그를 읽어서 상태를 알려줘."
              </p>
            </div>

            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 text-xs text-zinc-500 space-y-1">
              <p className="text-zinc-400 font-medium">참고 자료</p>
              <p>• <a href="https://goddaehee.tistory.com/557" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">cmux 설치 가이드 (goddaehee.tistory.com)</a></p>
              <p>• brew install --cask cmux 후 Spotlight에서 'cmux' 검색하여 앱 실행</p>
              <p>• macOS Gatekeeper 차단 시: <code className="bg-zinc-800 px-1 rounded">xattr -cr /Applications/cmux.app</code></p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
