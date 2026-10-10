/**
 * 「필요한 것 모두 설치」 — one button that runs the app's verified installers in order.
 *
 * It does not install anything itself. Each step drives an existing installer host
 * (Codex: pinned OpenAI package or winget, GitHub CLI: pinned release or winget) through
 * the same review → install → read-back cycle its own panel uses, so the safety rules stay
 * in one place: the host refuses an unreviewed or stale install, skips a tool that is
 * already there, and never touches accounts or shell settings. Logins stay separate —
 * they are interactive and belong to the person, not to this button.
 */

export type InstallAllStepId = 'codex' | 'github';
export type InstallAllTransport = (body: Record<string, unknown>) => Promise<{ status: number; body: any }>;
export type InstallAllResult = 'installed' | 'unsupported' | 'cancelled' | 'failed';

export interface InstallAllStep {
  id: InstallAllStepId;
  label: string;
  transport: InstallAllTransport;
}

export const INSTALL_ALL_STEPS: ReadonlyArray<{ id: InstallAllStepId; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'github', label: 'GitHub CLI' },
];

/** A receipt state that means "the tool is on this device" for either host. */
const PRESENT = new Set(['installed', 'configured', 'ready', 'storage-review', 'authenticating']);
const RUNNING = new Set(['preparing', 'installing']);

export const INSTALL_ALL_POLL_MS = 2_000;
/** The Codex package is ~112MB; a slow line needs minutes, not seconds. */
export const INSTALL_ALL_STEP_TIMEOUT_MS = 20 * 60_000;

interface Status { supported: boolean; interrupted: boolean; revision: string; state: string | null }

async function call(transport: InstallAllTransport, body: Record<string, unknown>): Promise<Status> {
  const response = await transport(body);
  if (response.status !== 200 || response.body?.success !== true) throw new Error('INSTALL_ALL_REQUEST');
  const receipt = response.body.receipt;
  return {
    supported: response.body.supported === true,
    interrupted: response.body.interrupted === true,
    revision: typeof receipt?.revision === 'string' ? receipt.revision : '0',
    state: typeof receipt?.state === 'string' ? receipt.state : null,
  };
}

export async function runInstallAllStep(
  transport: InstallAllTransport,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal } = {},
): Promise<InstallAllResult> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let status = await call(transport, { operation: 'status' });
  if (!status.supported) return 'unsupported';
  // A stored receipt is not proof the tool is still there (it may have been removed since), so
  // even an 'installed' receipt goes through review → install: the host's own probe skips a
  // tool that is present without downloading anything.
  // Another window may already be installing: wait for it instead of starting a second run.
  if (!(status.state && RUNNING.has(status.state) && !status.interrupted)) {
    status = await call(transport, { operation: 'review', expectedRevision: status.revision });
    status = await call(transport, { operation: 'install', expectedRevision: status.revision });
  }
  const deadline = now() + INSTALL_ALL_STEP_TIMEOUT_MS;
  while (status.state && RUNNING.has(status.state)) {
    if (status.interrupted || options.signal?.aborted || now() > deadline) return 'failed';
    await sleep(INSTALL_ALL_POLL_MS);
    status = await call(transport, { operation: 'status' });
  }
  if (status.state && PRESENT.has(status.state)) return 'installed';
  return status.state === 'cancelled' ? 'cancelled' : 'failed';
}

export interface InstallAllReport { id: InstallAllStepId; label: string; result: InstallAllResult }

/**
 * Runs every step even when one fails: a network hiccup on GitHub must not keep Codex off
 * this device. A thrown request (old app, lost connection) is recorded as `failed`.
 */
export async function runInstallAll(
  steps: InstallAllStep[],
  onProgress: (index: number, total: number, step: InstallAllStep) => void,
  options: Parameters<typeof runInstallAllStep>[1] = {},
): Promise<InstallAllReport[]> {
  const reports: InstallAllReport[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (options.signal?.aborted) break;
    onProgress(i, steps.length, step);
    let result: InstallAllResult;
    try { result = await runInstallAllStep(step.transport, options); } catch { result = 'failed'; }
    reports.push({ id: step.id, label: step.label, result });
  }
  return reports;
}

/** What the button still has to do, judged from the read-only tool diagnostics. */
export function installAllMissing(
  diagnostics: ReadonlyArray<{ id: string; state: string; installed?: boolean }>,
): InstallAllStepId[] {
  return INSTALL_ALL_STEPS.filter(step => {
    const d = diagnostics.find(item => item.id === step.id);
    // Unknown is not missing: it would offer an install for a tool that is already there.
    return !!d && d.installed !== true && (d.state === 'missing' || d.installed === false);
  }).map(step => step.id);
}

/**
 * The tools one press will actually run: missing on this device and not already refused by its
 * host. A present tool must not run — its login check can be inconclusive (custom CODEX_HOME,
 * GH_TOKEN), which the host reports as needs-review, and the card would call that a failed
 * install on every press.
 */
export function installAllRunnable(
  diagnostics: ReadonlyArray<{ id: string; state: string; installed?: boolean }>,
  unsupported: ReadonlyArray<InstallAllStepId>,
): InstallAllStepId[] {
  return installAllMissing(diagnostics).filter(id => !unsupported.includes(id));
}

export function installAllSummary(reports: InstallAllReport[]): { tone: 'ok' | 'warn'; title: string; detail: string } {
  const failed = reports.filter(r => r.result === 'failed' || r.result === 'cancelled');
  const unsupported = reports.filter(r => r.result === 'unsupported');
  const installed = reports.filter(r => r.result === 'installed');
  const manual = unsupported.length
    ? ` ${unsupported.map(r => r.label).join(', ')}는 이 기기에서 자동 설치를 지원하지 않아 건너뛰었습니다. 아래 「자세히 보기」의 공식 설치 안내를 따라 주세요.`
    : '';
  if (failed.length) {
    return {
      tone: 'warn',
      title: `설치를 마쳤지만 일부가 끝나지 않았습니다: ${failed.map(r => r.label).join(', ')}`,
      detail: `[필요한 것 모두 설치]를 다시 누르면 끝난 것은 건너뛰고 남은 것만 이어서 합니다. 계속 실패하면 아래 「자세히 보기」에서 그 도구의 설치 안내를 따라 주세요. 이미 설치된 파일과 설정은 그대로 둡니다.${manual}`,
    };
  }
  if (!installed.length) {
    // Nothing was installed: saying 「모두 설치했습니다」 here would be false.
    return { tone: 'warn', title: '이 기기에서는 자동 설치를 쓸 수 없습니다.', detail: manual.trim() };
  }
  return {
    tone: unsupported.length ? 'warn' : 'ok',
    title: unsupported.length ? '설치할 수 있는 것은 모두 설치했습니다.' : '모두 설치했습니다.',
    detail: `남은 일은 로그인뿐입니다. 아래에서 계정을 연결하세요.${manual}`,
  };
}
