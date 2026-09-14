import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, CircleHelp, Copy, ExternalLink,
  RefreshCw, Server, ShieldCheck, Wrench,
} from 'lucide-react';
import { isTauri } from './lib/env';
import OnboardingPreparation from './OnboardingPreparation';
import { writeOnboardingClipboard } from './onboardingClipboard';
import { connectionSummary, toolReadiness, type LocalOnboardingStatus } from './onboardingConnectionView';
import { readOnboardingDashboard } from './onboardingDashboardClient';
import {
  ONBOARDING_GUIDE_URL,
  ONBOARDING_SCENARIOS,
  buildOnboardingAgentPrompt,
  detectOnboardingPlatform,
  toolInstallCommand,
  toolRequirement,
  toolsForScenario,
  type OnboardingPlatform,
  type OnboardingRuntimeMode,
  type OnboardingScenarioId,
  type OnboardingToolDiagnostic,
  type OnboardingToolState,
  type OnboardingToolsResponse,
} from './onboardingInfrastructure';

const REQUIREMENT_COPY = {
  required: { label: '필수', className: 'border-rose-400/30 bg-rose-500/10 text-rose-200' },
  recommended: { label: '권장', className: 'border-sky-400/30 bg-sky-500/10 text-sky-200' },
  optional: { label: '선택', className: 'border-zinc-600 bg-zinc-800 text-zinc-400' },
  'not-applicable': { label: '해당 없음', className: 'border-zinc-700 bg-zinc-900 text-zinc-600' },
} as const;

const STATE_COPY: Record<OnboardingToolState, { label: string; dot: string; text: string }> = {
  ready: { label: '준비됨', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  'needs-login': { label: '로그인 필요', dot: 'bg-amber-400', text: 'text-amber-300' },
  missing: { label: '설치 필요', dot: 'bg-rose-400', text: 'text-rose-300' },
  unknown: { label: '확인 필요', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  manual: { label: '사용할 때 연결', dot: 'bg-violet-400', text: 'text-violet-300' },
  'not-applicable': { label: '해당 없음', dot: 'bg-zinc-700', text: 'text-zinc-600' },
};

function defaultToolState(toolId: string): OnboardingToolState {
  return toolId === 'buzz' || toolId === 'telegram' ? 'manual' : 'unknown';
}

function CopyButton({ value, label, copiedLabel = '복사됨' }: { value: string; label: string; copiedLabel?: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');

  async function handleCopy() {
    setCopyState('copying');
    const copied = await writeOnboardingClipboard(value);
    setCopyState(copied ? 'copied' : 'failed');
    if (copied) window.setTimeout(() => setCopyState('idle'), 1800);
  }

  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={() => void handleCopy()}
        disabled={copyState === 'copying'}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-teal-400/40 hover:text-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 disabled:opacity-50"
      >
        {copyState === 'copied' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        {copyState === 'copying' ? '복사 중…' : copyState === 'copied' ? copiedLabel : copyState === 'failed' ? '자동 복사 실패' : label}
      </button>
      {copyState === 'failed' && (
        <div className="mt-2 w-full max-w-lg rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-100" role="alert">
          아래 내용을 눌러 직접 복사하세요.
          <textarea readOnly value={value} onFocus={event => event.currentTarget.select()} aria-label="직접 복사할 설치 안내" className="mt-2 min-h-20 w-full resize-y rounded border border-zinc-700 bg-[var(--bg-input)] p-2 font-mono text-xs text-zinc-200" />
        </div>
      )}
    </div>
  );
}

export default function OnboardingInfrastructureCenter({
  onBack,
  onOpenFirstTask,
  onOpenDeviceSetup,
  onOpenCloudSetup,
  initialScenario = 'first',
}: {
  onBack?: () => void;
  onOpenFirstTask?: () => void;
  onOpenDeviceSetup?: () => void;
  onOpenCloudSetup?: () => void;
  initialScenario?: OnboardingScenarioId;
}) {
  const detectedPlatform = useMemo(
    () => detectOnboardingPlatform(navigator.userAgent, navigator.platform),
    [],
  );
  const [platform, setPlatform] = useState<OnboardingPlatform>(detectedPlatform);
  const [runtimeMode, setRuntimeMode] = useState<OnboardingRuntimeMode>(detectedPlatform === 'linux' ? 'remote' : 'packaged');
  const [diagnosticPlatform, setDiagnosticPlatform] = useState<OnboardingPlatform | null>(null);
  const [scenario, setScenario] = useState<OnboardingScenarioId>(initialScenario);
  const [diagnostics, setDiagnostics] = useState<OnboardingToolDiagnostic[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<LocalOnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const platformTouchedRef = useRef(false);
  const runtimeTouchedRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (force = false) => {
    const seq = ++refreshSeqRef.current;
    refreshAbortRef.current?.abort();
    setLoading(true);
    setLoadError('');
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await readOnboardingDashboard(isTauri() ? 'http://127.0.0.1:3001' : '', force, controller.signal);
      if (seq !== refreshSeqRef.current) return;
      setDiagnostics(result.tools?.diagnostics ?? []);
      setDeviceStatus(result.device);
      setCheckedAt(result.tools?.checkedAt ?? null);
      setDiagnosticPlatform(result.tools?.platform ?? null);
      if (result.incomplete) setLoadError('일부 상태를 확인하지 못했습니다. 이전 결과로 준비 완료를 표시하지 않습니다. 앱과 연결을 확인한 뒤 다시 검사하세요.');
      if (result.tools && !platformTouchedRef.current) {
        setPlatform(result.tools.platform);
        if (!runtimeTouchedRef.current && result.tools.runtimeMode) setRuntimeMode(result.tools.runtimeMode);
      }
    } catch {
      if (seq !== refreshSeqRef.current) return;
      setDiagnostics([]);
      setDeviceStatus(null);
      setCheckedAt(null);
      setDiagnosticPlatform(null);
      setLoadError('상태를 확인하지 못했습니다. 앱을 다시 열거나 다시 검사하세요. 저장된 설정은 유지됩니다.');
    } finally {
      window.clearTimeout(timeout);
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
    return () => {
      refreshSeqRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [refresh]);

  const visibleTools = useMemo(() => {
    const tools = toolsForScenario(scenario, platform, runtimeMode);
    return showOptional
      ? tools
      : tools.filter(tool => toolRequirement(tool, scenario, platform, runtimeMode) !== 'optional');
  }, [platform, runtimeMode, scenario, showOptional]);
  const diagnosticMap = useMemo(
    () => new Map(
      platform === diagnosticPlatform ? diagnostics.map(item => [item.id, item] as const) : [],
    ),
    [diagnosticPlatform, diagnostics, platform],
  );
  const scenarioDefinition = ONBOARDING_SCENARIOS.find(item => item.id === scenario)!;
  const requiredTools = toolsForScenario(scenario, platform, runtimeMode)
    .filter(tool => toolRequirement(tool, scenario, platform, runtimeMode) === 'required');
  const requiredReady = requiredTools.filter(tool => {
    const diagnostic = diagnosticMap.get(tool.id);
    return diagnostic && toolReadiness(diagnostic).verified;
  }).length;
  const localConnection = connectionSummary(platform === (diagnosticPlatform ?? detectedPlatform) ? deviceStatus : null, scenario);
  const agentPrompt = buildOnboardingAgentPrompt({
    scenario,
    platform,
    runtimeMode,
    diagnostics: platform === diagnosticPlatform ? diagnostics : [],
  });

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-base)] px-4 py-5 sm:px-7 sm:py-6" data-testid="onboarding-infrastructure-center">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {onBack && (
              <button type="button" onClick={onBack} className="mb-3 text-xs text-zinc-500 hover:text-zinc-200">← 설정 첫 화면</button>
            )}
            <h2 className="flex items-center gap-2 text-xl font-bold text-[var(--text-primary)]">
              <ShieldCheck className="h-5 w-5 text-teal-300" /> 내 기기와 연결
            </h2>
            <p className="mt-1 text-sm text-zinc-400">이 OS 사용자 환경의 설치·로그인·동기화 상태를 확인합니다. 다른 OS 사용자는 별도로 설정합니다.</p>
          </div>
          <div className="flex items-center gap-2">
            <a href={ONBOARDING_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-teal-400/30 bg-teal-500/10 px-3 py-2 text-[11px] font-medium text-teal-200 hover:bg-teal-500/15">
              아주 쉬운 설명서 <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button type="button" onClick={() => void refresh(true)} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-300 hover:border-zinc-600 disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 다시 검사
            </button>
          </div>
        </div>

        {checkedAt && <p className="text-xs text-zinc-400" role="status">도구 검사 시각: {new Date(checkedAt).toLocaleString('ko-KR')}{loading ? ' · 다시 확인 중…' : ''}</p>}
        {(onOpenDeviceSetup || onOpenCloudSetup) && <section aria-label="연결 설정 바로가기" className="flex flex-wrap gap-2">
          {onOpenDeviceSetup && <button type="button" onClick={onOpenDeviceSetup} className="min-h-11 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200">단말·동기화 설정 열기</button>}
          {onOpenCloudSetup && <button type="button" onClick={onOpenCloudSetup} className="min-h-11 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200">휴대폰·개인 포털 연결 안내</button>}
        </section>}
        <OnboardingPreparation onOpenFirstTask={onOpenFirstTask} />

        <section aria-label="내 상황 선택" className="grid gap-2 sm:grid-cols-4">
          {ONBOARDING_SCENARIOS.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScenario(item.id)}
              className={`rounded-xl border p-3 text-left transition-colors ${scenario === item.id ? 'border-teal-300/50 bg-teal-400/10' : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'}`}
            >
              <p className={`text-sm font-semibold ${scenario === item.id ? 'text-teal-100' : 'text-zinc-200'}`}>{item.shortLabel}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{item.description}</p>
            </button>
          ))}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-zinc-100">{scenarioDefinition.label}</p>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-400">{scenarioDefinition.success}</p>
            </div>
            <fieldset className="flex gap-1 rounded-lg border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/30 p-1">
              <legend className="sr-only">운영체제 선택</legend>
              {(['mac', 'windows', 'linux'] as OnboardingPlatform[]).map(item => (
                <button key={item} type="button" aria-pressed={platform === item} onClick={() => {
                  platformTouchedRef.current = true;
                  runtimeTouchedRef.current = false;
                  setPlatform(item);
                  setRuntimeMode(item === 'linux' ? 'remote' : 'packaged');
                }} className={`min-h-10 rounded-md px-2.5 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${platform === item ? 'bg-zinc-700 text-[var(--text-primary)]' : 'text-zinc-400 hover:text-zinc-200'}`}>
                  {item === 'mac' ? 'macOS' : item === 'windows' ? 'Windows' : 'AWS·Linux'}
                </button>
              ))}
            </fieldset>
          </div>
          {platform !== 'linux' && (
            <fieldset className="mt-3">
              <legend className="mb-2 text-xs font-semibold text-zinc-300">현재 실행 형태</legend>
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-pressed={runtimeMode === 'packaged'} onClick={() => { runtimeTouchedRef.current = true; setRuntimeMode('packaged'); }} className={`min-h-10 rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${runtimeMode === 'packaged' ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:text-[var(--text-primary)]'}`}>설치된 앱</button>
                <button type="button" aria-pressed={runtimeMode === 'source'} onClick={() => { runtimeTouchedRef.current = true; setRuntimeMode('source'); }} className={`min-h-10 rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${runtimeMode === 'source' ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:text-[var(--text-primary)]'}`}>소스 직접 실행</button>
              </div>
              <p className="mt-2 text-xs leading-5 text-zinc-400">{runtimeMode === 'packaged' ? 'Bun·node_modules·GitHub clone은 앱 사용의 필수 조건이 아닙니다.' : 'Bun·Git·node_modules와 로컬 API 실행 상태를 함께 확인합니다.'}</p>
            </fieldset>
          )}
          <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-500">
            <span className="rounded-full border border-zinc-700 px-2 py-0.5">필수 도구 준비 {requiredReady}/{requiredTools.length}</span>
            {(scenario === 'first' || scenario === 'additional') && <span className={`rounded-full border px-2 py-0.5 ${localConnection.ready ? 'border-emerald-500/30 text-emerald-300' : 'border-amber-500/30 text-amber-200'}`}>단말 연결 · {localConnection.label}</span>}
            <span>선택 도구는 나중에 추가해도 됩니다.</span>
          </div>
        </section>

        {(scenario === 'first' || scenario === 'additional') && (
          <section className={`rounded-xl border p-4 ${localConnection.ready ? 'border-emerald-500/25 bg-emerald-500/[0.04]' : 'border-amber-500/25 bg-amber-500/[0.04]'}`} data-testid="onboarding-device-connection-status">
            <div className="flex items-start gap-3">
              <ShieldCheck className={`mt-0.5 h-4 w-4 shrink-0 ${localConnection.ready ? 'text-emerald-300' : 'text-amber-200'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-zinc-100">단말·동기화 상태 · {localConnection.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">{localConnection.detail}</p>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]" hidden={platform !== diagnosticPlatform}>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.hasSupabaseConfig ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>Supabase 정보 {deviceStatus?.hasSupabaseConfig ? '있음' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.hasDeviceIdentity ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>이 PC 단말 ID {deviceStatus?.hasDeviceIdentity ? '있음' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.localAdminPresent ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>로컬 관리자 {deviceStatus?.localAdminPresent ? '연결됨' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.lastSuccessfulPushAt ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>이전 Push 기록 {deviceStatus?.lastSuccessfulPushAt ? '있음' : '확인 필요'}</span>
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">도구 준비 숫자는 설치 상태만 뜻합니다. 도구의 로그인 확인은 선택한 프로젝트 권한이나 첫 AI 작업 성공까지 보장하지 않습니다.</p>
              </div>
            </div>
          </section>
        )}

        {diagnosticPlatform && platform !== diagnosticPlatform && (
          <div className="flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/5 p-3 text-xs text-sky-200">
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
            다른 운영체제의 준비 목록을 미리 보는 중입니다. 상태 점은 ‘확인 필요’로 두며, 실제 그 단말에서 현황판을 열어 다시 검사하면 정확한 결과가 표시됩니다.
          </div>
        )}

        {loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-xs text-amber-200">
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" /> {loadError}
          </div>
        )}

        <section className="space-y-2" aria-label="설치 상태">
          {visibleTools.map(tool => {
            const requirement = toolRequirement(tool, scenario, platform, runtimeMode);
            const requirementCopy = REQUIREMENT_COPY[requirement];
            const diagnostic = diagnosticMap.get(tool.id);
            const state = diagnostic?.state ?? defaultToolState(tool.id);
            const readiness = diagnostic ? toolReadiness(diagnostic) : null;
            const stateCopy = STATE_COPY[readiness?.state ?? state];
            const command = toolInstallCommand(tool, platform, runtimeMode);
            return (
              <details key={tool.id} className="group rounded-xl border border-zinc-800 bg-[var(--bg-card)] open:border-zinc-700" data-tool-id={tool.id}>
                <summary className="flex cursor-pointer list-none items-center gap-3 p-3.5 sm:p-4">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${stateCopy.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-100">{tool.label}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] ${requirementCopy.className}`}>{requirementCopy.label}</span>
                      {diagnostic?.version && <span className="truncate text-[10px] text-zinc-600">{diagnostic.version}</span>}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">{tool.description}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-medium ${stateCopy.text}`}>{readiness?.label ?? stateCopy.label}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-zinc-800 px-4 py-3 text-xs">
                  <p className="leading-relaxed text-zinc-400"><span className="text-zinc-200">왜 필요한가요?</span> {tool.why}</p>
                  {diagnostic?.detail && <p className="mt-2 text-zinc-500">현재 확인: {diagnostic.detail}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {command && state === 'missing' && <CopyButton value={command} label="다음 명령 복사" />}
                    {tool.verify && <CopyButton value={tool.verify} label="확인 방법 복사" />}
                    <a href={tool.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-[11px] text-sky-300 hover:text-sky-200">공식 설명 <ExternalLink className="h-3 w-3" /></a>
                  </div>
                  {command && state === 'missing' && <p className="mt-2 text-[10px] text-amber-200/70">복사만 합니다. AI는 요청한 범위에서 다음 단계를 돕습니다. 로그인과 보안 입력은 공식 화면에서 직접 진행하세요.</p>}
                </div>
              </details>
            );
          })}
        </section>

        <button type="button" onClick={() => setShowOptional(value => !value)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 py-3 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200">
          {showOptional ? '선택 기능 접기' : 'Claude·Codex·Hermes·Buzz 등 선택 기능도 보기'}
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showOptional ? 'rotate-90' : ''}`} />
        </button>

        <section className="rounded-2xl border border-teal-300/25 bg-teal-400/[0.06] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-teal-300/20 bg-teal-400/10 p-2"><Wrench className="h-4 w-4 text-teal-200" /></div>
              <div>
                <p className="text-sm font-semibold text-teal-100">어떤 AI에게든 그대로 붙여넣기</p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">현재 시나리오와 확인된 상태만 담고, 비밀값은 담지 않습니다. AI는 한 번에 한 단계씩 돕습니다.</p>
              </div>
            </div>
            <CopyButton value={agentPrompt} label="동행 프롬프트 복사" copiedLabel="프롬프트 복사됨" />
          </div>
        </section>

        <div className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/20 p-3 text-[10px] leading-relaxed text-zinc-500">
          <Server className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          상태 확인은 버전·로그인 여부 같은 비밀이 아닌 정보만 읽습니다. 토큰·키·쿠키는 현황판 응답에 포함하지 않습니다.
        </div>
      </div>
    </div>
  );
}
