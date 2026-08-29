import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, CircleHelp, Copy, ExternalLink,
  RefreshCw, Server, ShieldCheck, Wrench,
} from 'lucide-react';
import { isTauri } from './lib/env';
import type { OnboardingDiagnosis } from './onboardingDiagnosis';
import {
  ONBOARDING_GUIDE_URL,
  ONBOARDING_SCENARIOS,
  buildOnboardingAgentPrompt,
  detectOnboardingPlatform,
  toolRequirement,
  toolsForScenario,
  type OnboardingPlatform,
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

interface LocalOnboardingStatus extends OnboardingDiagnosis {
  deviceName?: string;
  supabaseReachable?: boolean | null;
  lastSuccessfulPushAt?: string | null;
}

function connectionSummary(
  status: LocalOnboardingStatus | null,
  scenario: OnboardingScenarioId,
): { label: string; title: string; detail: string; ready: boolean } {
  if (!status) return {
    label: '확인 필요',
    title: '이 PC의 단말 연결 상태를 확인하지 못했습니다.',
    detail: '로컬 API를 실행한 뒤 다시 검사하세요. 도구가 모두 준비돼도 단말 등록과 동기화 확인은 별도입니다.',
    ready: false,
  };
  if (status.stage === 'registered' && status.localAdminPresent && status.lastSuccessfulPushAt) return {
    label: '연결 완료',
    title: '단말 신원과 로컬 관리자 연결이 준비됐습니다.',
    detail: `이 단말의 Supabase 원격 읽기·쓰기 성공 기록을 확인했습니다 (${new Date(status.lastSuccessfulPushAt).toLocaleString('ko-KR')}).`,
    ready: true,
  };
  if (status.stage === 'registered' && status.localAdminPresent) return {
    label: '마지막 확인',
    title: '단말 신원과 로컬 관리자 연결이 준비됐습니다.',
    detail: status.supabaseReachable === false
      ? '현재 Supabase에 연결되지 않습니다. 네트워크와 프로젝트 상태를 확인한 뒤 Push 또는 Pull을 다시 실행하세요.'
      : '프로젝트 화면에서 Supabase Push 또는 Pull을 실제로 한 번 성공시켜야 전체 온보딩 완료입니다.',
    ready: false,
  };
  if (status.stage === 'registered') return {
    label: '관리자 연결 필요',
    title: '단말 ID는 등록됐지만 로컬 관리자 연결이 남았습니다.',
    detail: '이 PC에서 Supabase CLI 인증과 로컬 관리자 연결을 끝낸 뒤 Push/Pull을 확인하세요.',
    ready: false,
  };
  if (status.stage === 'additional-pending') return {
    label: '등록 마무리 필요',
    title: '두 번째 PC 등록이 진행 중입니다.',
    detail: '기존 PC의 ID를 복사하지 말고, 이 PC가 만든 새 ID로 등록 재시도를 완료하세요.',
    ready: false,
  };
  if (status.stage === 'configured-unregistered') return {
    label: '단말 등록 필요',
    title: 'Supabase 연결 정보 일부는 있지만 단말 등록이 끝나지 않았습니다.',
    detail: '초기 설정으로 돌아가 이 PC의 새 단말 신원과 로컬 관리자 연결을 마무리하세요.',
    ready: false,
  };
  return {
    label: scenario === 'additional' ? '연결 정보 필요' : '설정 시작 전',
    title: scenario === 'additional'
      ? '기존 PC에서 안전한 연결 정보를 먼저 만드세요.'
      : '아직 이 PC의 Supabase·단말 신원이 없습니다.',
    detail: scenario === 'additional'
      ? '기존 단말 ID나 service_role을 복사하지 말고 “다른 PC 연결 정보 만들기”를 사용하세요.'
      : '첫 단말 설정에서 기존 Supabase를 재사용하거나, 없을 때만 새 프로젝트를 준비하세요.',
    ready: false,
  };
}

function defaultToolState(toolId: string): OnboardingToolState {
  return toolId === 'buzz' || toolId === 'telegram' ? 'manual' : 'unknown';
}

function CopyButton({ value, label, copiedLabel = '복사됨' }: { value: string; label: string; copiedLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] font-medium text-zinc-300 transition-colors hover:border-teal-400/40 hover:text-teal-200"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? copiedLabel : label}
    </button>
  );
}

export default function OnboardingInfrastructureCenter({
  onBack,
  initialScenario = 'first',
}: {
  onBack?: () => void;
  initialScenario?: OnboardingScenarioId;
}) {
  const detectedPlatform = useMemo(
    () => detectOnboardingPlatform(navigator.userAgent, navigator.platform),
    [],
  );
  const [platform, setPlatform] = useState<OnboardingPlatform>(detectedPlatform);
  const [diagnosticPlatform, setDiagnosticPlatform] = useState<OnboardingPlatform | null>(null);
  const [scenario, setScenario] = useState<OnboardingScenarioId>(initialScenario);
  const [diagnostics, setDiagnostics] = useState<OnboardingToolDiagnostic[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<LocalOnboardingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const platformTouchedRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (force = false) => {
    const seq = ++refreshSeqRef.current;
    refreshAbortRef.current?.abort();
    setLoading(true);
    setLoadError('');
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const endpoint = isTauri()
        ? `http://127.0.0.1:3001/api/onboarding/tools${force ? '?refresh=1' : ''}`
        : `/api/onboarding/tools${force ? '?refresh=1' : ''}`;
      const statusEndpoint = isTauri()
        ? 'http://127.0.0.1:3001/api/onboarding/status'
        : '/api/onboarding/status';
      const [toolsResult, statusResult] = await Promise.allSettled([
        fetch(endpoint, { cache: 'no-store', signal: controller.signal }),
        fetch(statusEndpoint, { cache: 'no-store', signal: controller.signal }),
      ]);
      if (toolsResult.status === 'rejected') throw toolsResult.reason;
      const response = toolsResult.value;
      const body = await response.json() as Partial<OnboardingToolsResponse> & { error?: string };
      if (!response.ok || !Array.isArray(body.diagnostics)) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (seq !== refreshSeqRef.current) return;
      setDiagnostics(body.diagnostics);
      if (statusResult.status === 'fulfilled' && statusResult.value.ok) {
        const nextStatus = await statusResult.value.json() as Partial<LocalOnboardingStatus>;
        if (seq !== refreshSeqRef.current) return;
        setDeviceStatus(
          typeof nextStatus.stage === 'string'
            && typeof nextStatus.hasSupabaseConfig === 'boolean'
            && typeof nextStatus.hasDeviceIdentity === 'boolean'
            && typeof nextStatus.localAdminPresent === 'boolean'
            ? nextStatus as LocalOnboardingStatus
            : null,
        );
      } else {
        setDeviceStatus(null);
      }
      if (body.platform) {
        setDiagnosticPlatform(body.platform);
        if (!platformTouchedRef.current) setPlatform(body.platform);
      }
    } catch (error) {
      if (seq !== refreshSeqRef.current) return;
      setLoadError(error instanceof DOMException && error.name === 'AbortError'
        ? '상태 확인 시간이 초과됐습니다. 앱과 로컬 API가 실행 중인지 확인하세요.'
        : '로컬 API에서 상태를 읽지 못했습니다. 모르는 항목은 미설치로 단정하지 않습니다.');
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
    const tools = toolsForScenario(scenario, platform);
    return showOptional
      ? tools
      : tools.filter(tool => toolRequirement(tool, scenario, platform) !== 'optional');
  }, [platform, scenario, showOptional]);
  const diagnosticMap = useMemo(
    () => new Map(
      platform === diagnosticPlatform ? diagnostics.map(item => [item.id, item] as const) : [],
    ),
    [diagnosticPlatform, diagnostics, platform],
  );
  const scenarioDefinition = ONBOARDING_SCENARIOS.find(item => item.id === scenario)!;
  const requiredTools = toolsForScenario(scenario, platform)
    .filter(tool => toolRequirement(tool, scenario, platform) === 'required');
  const requiredReady = requiredTools.filter(tool => diagnosticMap.get(tool.id)?.state === 'ready').length;
  const localConnection = connectionSummary(deviceStatus, scenario);
  const agentPrompt = buildOnboardingAgentPrompt({
    scenario,
    platform,
    diagnostics: platform === diagnosticPlatform ? diagnostics : [],
  });

  return (
    <div className="h-full overflow-y-auto bg-[#0a0a0b] px-4 py-5 sm:px-7 sm:py-6" data-testid="onboarding-infrastructure-center">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {onBack && (
              <button type="button" onClick={onBack} className="mb-3 text-xs text-zinc-500 hover:text-zinc-200">← 설정 첫 화면</button>
            )}
            <h2 className="flex items-center gap-2 text-xl font-bold text-white">
              <ShieldCheck className="h-5 w-5 text-teal-300" /> 설치·연결 현황판
            </h2>
            <p className="mt-1 text-sm text-zinc-400">필요한 것만 준비합니다. ‘확인 필요’는 ‘없음’이라는 뜻이 아닙니다.</p>
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
            <div className="flex gap-1 rounded-lg border border-zinc-800 bg-black/30 p-1" aria-label="운영체제 선택">
              {(['mac', 'windows', 'linux'] as OnboardingPlatform[]).map(item => (
                <button key={item} type="button" onClick={() => { platformTouchedRef.current = true; setPlatform(item); }} className={`rounded-md px-2.5 py-1 text-[10px] ${platform === item ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {item === 'mac' ? 'macOS' : item === 'windows' ? 'Windows' : 'AWS·Linux'}
                </button>
              ))}
            </div>
          </div>
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
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.hasSupabaseConfig ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>Supabase 정보 {deviceStatus?.hasSupabaseConfig ? '있음' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.hasDeviceIdentity ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>이 PC 단말 ID {deviceStatus?.hasDeviceIdentity ? '있음' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.localAdminPresent ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>로컬 관리자 {deviceStatus?.localAdminPresent ? '연결됨' : '확인 필요'}</span>
                  <span className={`rounded border px-2 py-1 ${deviceStatus?.lastSuccessfulPushAt ? 'border-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>Supabase 왕복 {deviceStatus?.lastSuccessfulPushAt ? '확인됨' : '확인 필요'}</span>
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">도구 준비 숫자는 설치 상태만 뜻합니다. 단말 등록과 실제 Push/Pull 성공을 따로 확인해야 전체 설정이 끝납니다.</p>
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
            const requirement = toolRequirement(tool, scenario, platform);
            const requirementCopy = REQUIREMENT_COPY[requirement];
            const diagnostic = diagnosticMap.get(tool.id);
            const state = diagnostic?.state ?? defaultToolState(tool.id);
            const stateCopy = STATE_COPY[state];
            const command = tool.install[platform];
            return (
              <details key={tool.id} className="group rounded-xl border border-zinc-800 bg-[#111113] open:border-zinc-700" data-tool-id={tool.id}>
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
                  <span className={`shrink-0 text-[11px] font-medium ${stateCopy.text}`}>{stateCopy.label}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-zinc-800 px-4 py-3 text-xs">
                  <p className="leading-relaxed text-zinc-400"><span className="text-zinc-200">왜 필요한가요?</span> {tool.why}</p>
                  {diagnostic?.detail && <p className="mt-2 text-zinc-500">현재 확인: {diagnostic.detail}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {command && state !== 'ready' && <CopyButton value={command} label="다음 명령 복사" />}
                    {tool.verify && <CopyButton value={tool.verify} label="확인 방법 복사" />}
                    <a href={tool.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-[11px] text-sky-300 hover:text-sky-200">공식 설명 <ExternalLink className="h-3 w-3" /></a>
                  </div>
                  {command && state !== 'ready' && <p className="mt-2 text-[10px] text-amber-200/70">복사만 합니다. AI는 설치·로그인·권한 변경 전에 반드시 사용자에게 확인해야 합니다.</p>}
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

        <div className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-black/20 p-3 text-[10px] leading-relaxed text-zinc-500">
          <Server className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          상태 확인은 버전·로그인 여부 같은 비밀이 아닌 정보만 읽습니다. 토큰·키·쿠키는 현황판 응답에 포함하지 않습니다.
        </div>
      </div>
    </div>
  );
}
