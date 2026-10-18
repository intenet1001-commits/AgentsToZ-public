import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Download } from 'lucide-react';
import { isWindowsClient } from './clientPlatform';
import OnboardingCodexLoginPanel from './OnboardingCodexLoginPanel';
import OnboardingGithubSetup from './OnboardingGithubSetup';
import type { OnboardingToolDiagnostic } from './onboardingInfrastructure';
import {
  INSTALL_ALL_STEPS, installAllMissing, installAllRunnable, installAllSummary, runInstallAll,
  type InstallAllReport, type InstallAllStep, type InstallAllStepId, type InstallAllTransport,
} from './onboardingInstallAllPlan';

const native = (tool: InstallAllStepId): InstallAllTransport =>
  body => invoke('onboarding_management_request', { body, tool });
const button = 'min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

/**
 * Installed and proven signed out — the only thing left after the button, and only the person
 * can do it. `unknown` (a custom auth setup, a token stored in a plain file) is not "signed out":
 * a login panel there cannot help. The Codex login helper is Mac-only.
 */
function needsLogin(id: InstallAllStepId, d: OnboardingToolDiagnostic | undefined): boolean {
  if (!d || d.state !== 'needs-login') return false;
  return id !== 'codex' || !isWindowsClient();
}

/**
 * 「필요한 것 모두 설치」: the one obvious action at the top of 「내 기기와 연결」.
 * Runs the verified installers in order (see onboardingInstallAllPlan), then shows only the
 * logins that are still needed. Everything step-by-step stays under 「자세히 보기」.
 */
export default function OnboardingInstallAll({
  diagnostics, checked, checkFailed = false, onFinished, onOpenFirstTask, transports,
}: {
  diagnostics: OnboardingToolDiagnostic[];
  /** The diagnostics belong to this device and a check has finished. */
  checked: boolean;
  /** The last check failed, so `checked` will not become true without 「다시 검사」. */
  checkFailed?: boolean;
  onFinished: () => void;
  onOpenFirstTask?: () => void;
  transports?: Partial<Record<InstallAllStepId, InstallAllTransport>>;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; label: string } | null>(null);
  const [reports, setReports] = useState<InstallAllReport[] | null>(null);
  // Tools whose host said "not on this device": the button stops offering them.
  const [unsupported, setUnsupported] = useState<InstallAllStepId[]>([]);
  const lock = useRef(false);
  const alive = useRef(false);
  const abort = useRef<AbortController | null>(null);
  // Set on mount, not in the ref's initial value: StrictMode unmounts and remounts once, and a
  // flag cleared by that first cleanup would silence every later progress update.
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); }; }, []);

  const missing = checked ? installAllMissing(diagnostics) : [];
  const installable = checked ? installAllRunnable(diagnostics, unsupported) : [];
  const byId = (id: InstallAllStepId) => diagnostics.find(d => d.id === id);
  const logins = checked ? INSTALL_ALL_STEPS.filter(step => needsLogin(step.id, byId(step.id))).map(step => step.id) : [];
  const complete = checked && !running && missing.length === 0;
  const manualOnly = checked && !running && missing.length > 0 && installable.length === 0;

  async function installEverything() {
    if (lock.current || !installable.length) return;
    lock.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setReports(null);
    const steps: InstallAllStep[] = INSTALL_ALL_STEPS.filter(step => installable.includes(step.id)).map(step => ({
      ...step, transport: transports?.[step.id] ?? native(step.id),
    }));
    const result = await runInstallAll(steps, (index, total, step) => {
      if (alive.current) setProgress({ index, total, label: step.label });
    }, { signal: controller.signal });
    lock.current = false;
    if (!alive.current) return;
    setUnsupported(current => [...new Set([...current, ...result.filter(r => r.result === 'unsupported').map(r => r.id)])]);
    setRunning(false); setProgress(null); setReports(result);
    onFinished();
  }

  const summary = reports ? installAllSummary(reports) : null;
  const percent = progress ? Math.round(((progress.index + 0.5) / progress.total) * 100) : 0;
  return <section aria-label="한 번에 설치하기" data-testid="onboarding-install-all"
    className={`rounded-2xl border p-5 ${complete ? 'border-[rgb(var(--ok-rgb)/0.35)] bg-[rgb(var(--ok-rgb)/0.06)]' : 'border-[var(--accent-line)] bg-[var(--accent-soft)]'}`}>
    {complete ? <>
      <p className="flex items-center gap-2 text-base font-bold text-[var(--ink)]" data-testid="onboarding-install-all-complete">
        <CheckCircle2 className="h-5 w-5 text-[var(--ok)]" /> Codex·GitHub CLI 설치 완료
      </p>
      <p className="mt-1 text-sm text-[var(--ink-2)]">{logins.length
        ? '남은 일은 로그인뿐입니다. 아래에서 계정을 연결하세요.'
        : '이 버튼이 설치하는 도구는 모두 준비됐습니다. 동기화·선택 도구는 아래 「자세히 보기」에서 확인합니다.'}</p>
    </> : <>
      <p className="flex items-center gap-2 text-base font-bold text-[var(--ink)]"><Download className="h-5 w-5 text-[var(--accent)]" /> 한 번에 설치하기</p>
      <p className="mt-1 text-sm leading-relaxed text-[var(--ink-2)]">
        버튼 하나로 Codex(AI 코딩 도우미)와 GitHub CLI(저장소 연결)를 설치합니다.
        {isWindowsClient()
          ? ' winget 공식 목록에서 설치하고 실행 파일의 서명을 확인합니다.'
          : ' 공식 배포본을 내려받아 파일과 서명을 검증합니다(Codex 약 112MB).'}
        {' '}이미 있는 것은 건너뛰고, 기존 계정·셸 설정은 그대로 둡니다. 몇 분 걸릴 수 있으니 창을 닫지 말고 기다려 주세요.
      </p>
      {manualOnly ? <p className="mt-4 text-sm text-[var(--ink-2)]" data-testid="onboarding-install-all-manual">
        이 기기에서는 자동 설치를 쓸 수 없습니다. 아래 「자세히 보기」의 공식 설치 안내를 따라 주세요.
      </p> : !running && <button type="button" data-testid="onboarding-install-all-button"
        className={`${button} mt-4 bg-[var(--accent)] font-semibold text-[var(--on-accent)]`}
        disabled={!checked} onClick={() => void installEverything()}>
        {checked ? '필요한 것 모두 설치' : checkFailed ? '상태를 확인하지 못했습니다 · [다시 검사]를 눌러 주세요' : '설치 상태 확인 중…'}
      </button>}
      {running && <div className="mt-4" role="progressbar" aria-label="필요한 것 모두 설치" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--sunken)]">
          <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-700" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-2 text-sm text-[var(--ink-2)]" aria-live="polite" data-testid="onboarding-install-all-progress">
          {progress ? `진행 중 ${progress.index + 1}/${progress.total}: ${progress.label}` : '준비 중…'}
        </p>
      </div>}
    </>}
    {summary && !(complete && summary.tone === 'ok') && <div role="status" data-testid="onboarding-install-all-summary"
      className={`mt-4 rounded-xl border p-3 text-sm ${summary.tone === 'ok' ? 'border-[rgb(var(--ok-rgb)/0.3)]' : 'border-[rgb(var(--warn-rgb)/0.35)]'}`}>
      <p className="font-semibold text-[var(--ink)]">{summary.title}</p>
      <p className="mt-1 text-[var(--ink-2)]">{summary.detail}</p>
    </div>}
    {!running && logins.includes('codex') && <OnboardingCodexLoginPanel onContinue={onOpenFirstTask} />}
    {!running && logins.includes('github') && <OnboardingGithubSetup />}
  </section>;
}
