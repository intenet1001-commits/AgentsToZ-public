import { readTesterPromotionMemo, testerPromotionCounts, testerPromotionSignature, writeTesterPromotionMemo } from '../testerPromotionBadge';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { isTauri, isDeployedWeb } from '../lib/env';
import { HERMES_POST_INSTALL_HINT } from '../hermesProjectMemoryAdapter';

/**
 * Both the project-memory agent and the repository workflow carry an installed
 * vs. current version. Improving either one leaves every already-installed
 * project behind at once — measured on this machine, one version bump left 30
 * of 31 memory projects and 36 of 49 repositories outdated. The per-project
 * buttons live inside each project's panel, so catching up meant opening 66
 * panels. This surfaces the backlog once, at the top, and clears it in place.
 */

export interface BulkUpgradeTargetState {
  folderPaths: string[];
  /** Numbers for memory/workflow, dotted strings ("1.2.0") for the project tester. */
  installedVersion: number | string | null;
  currentVersion: number | string | null;
}

/** 기기당 하나뿐이라 folderPaths 가 없다 — 프로젝트 목록과 같은 모양으로 접을 수 없다. */
export interface BulkUpgradeDeviceState {
  installedVersion: number;
  currentVersion: number;
}

export interface BulkUpgradeState {
  memory: BulkUpgradeTargetState;
  workflow: BulkUpgradeTargetState;
  tester: BulkUpgradeTargetState;
  /** Hermes(Telegram) 명령 어댑터. 갱신할 것이 없으면 null. */
  hermes: BulkUpgradeDeviceState | null;
  /**
   * 공통 테스터 계층으로 **올릴 거리가 있는** 프로젝트들. 갱신이 아니라 **후보 모으기**다 — 이 행을
   * 누르면 읽기 전용 `scenarios promote`를 모아 보고서를 남기고, 어느 것을 올릴지는 사람·AI가 고른다.
   */
  promotion: string[];
  missing: string[];
  checked: number;
}

export type BulkUpgradeTarget = 'memory' | 'workflow' | 'tester';

const TARGET_LABEL: Record<BulkUpgradeTarget, string> = {
  memory: '장기기억 에이전트',
  workflow: '저장소 워크플로',
  tester: '프로젝트 테스터',
};
const ALL_TARGETS: readonly BulkUpgradeTarget[] = ['memory', 'workflow', 'tester'];
const HERMES_LABEL = 'Telegram 명령 (Hermes)';

const baseUrl = () => (isTauri() ? 'http://localhost:3001' : '');

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error || `요청 실패 (${response.status})`);
  return payload as T;
}

const emptyTarget = (): BulkUpgradeTargetState => ({ folderPaths: [], installedVersion: null, currentVersion: null });

export function summarizeUpgradeStatus(payload: {
  memory?: Array<{ folderPath: string; installedVersion: number; currentVersion: number }>;
  workflow?: Array<{ folderPath: string; installedVersion: number; currentVersion: number }>;
  tester?: Array<{ folderPath: string; installedVersion: string; currentVersion: string }>;
  hermes?: { installedVersion: number; currentVersion: number } | null;
  promotion?: string[];
  missing?: string[];
  checked?: number;
}): BulkUpgradeState {
  const order = (a: number | string, b: number | string) =>
    String(a).localeCompare(String(b), undefined, { numeric: true });
  const fold = <V extends number | string>(rows: Array<{ folderPath: string; installedVersion: V; currentVersion: V }> = []) => ({
    folderPaths: rows.map(row => row.folderPath),
    // The oldest installed version is the honest headline: it is what the user
    // is actually running somewhere, not an average.
    installedVersion: rows.length ? [...rows.map(row => row.installedVersion)].sort(order)[0]! : null,
    currentVersion: rows.length ? [...rows.map(row => row.currentVersion)].sort(order).at(-1)! : null,
  });
  return {
    memory: fold(payload.memory),
    workflow: fold(payload.workflow),
    tester: fold(payload.tester),
    // 서버는 이 값을 계속 보내고 있었는데 여기서 버려서, 헤더 배지가 Telegram 명령
    // 백로그만 조용히 빠뜨렸다. 그 결과 사용자가 알 수 있는 곳은 기본이 접혀 있는
    // 기억 패널 안의 상자 하나뿐이었다.
    hermes: payload.hermes
      && typeof payload.hermes.installedVersion === 'number'
      && typeof payload.hermes.currentVersion === 'number'
      ? { installedVersion: payload.hermes.installedVersion, currentVersion: payload.hermes.currentVersion }
      : null,
    promotion: (payload.promotion ?? []).filter((path): path is string => typeof path === 'string'),
    missing: payload.missing ?? [],
    checked: payload.checked ?? 0,
  };
}

export interface DetectedGithubUrl {
  folderPath: string;
  remoteUrl: string;
}

const BULK_POPOVER_WIDTH = 300;
const BULK_POPOVER_VIEWPORT_GAP = 8;

export function resolveBulkPopoverPlacement(input: {
  panelLeft: number;
  panelRight: number;
  panelVisualWidth: number;
  panelLogicalWidth: number;
  headerLeft: number;
  headerRight: number;
  viewportWidth: number;
  currentWidth: number;
  currentOffsetX: number;
}): { width: number; offsetX: number; needsRemeasure: boolean } {
  const renderedScale = input.panelLogicalWidth > 0
    ? input.panelVisualWidth / input.panelLogicalWidth
    : 1;
  const scale = Number.isFinite(renderedScale) && renderedScale > 0 ? renderedScale : 1;
  const leftBound = Math.max(BULK_POPOVER_VIEWPORT_GAP, input.headerLeft + BULK_POPOVER_VIEWPORT_GAP);
  const rightBound = Math.min(
    input.viewportWidth - BULK_POPOVER_VIEWPORT_GAP,
    input.headerRight - BULK_POPOVER_VIEWPORT_GAP,
  );
  const availableWidth = Math.max(0, rightBound - leftBound);
  const width = Math.max(1, Math.min(BULK_POPOVER_WIDTH, availableWidth / scale));
  if (Math.abs(width - input.currentWidth) > 0.5) {
    return { width, offsetX: 0, needsRemeasure: true };
  }
  const visualOffset = input.panelLeft < leftBound
    ? leftBound - input.panelLeft
    : input.panelRight > rightBound
      ? rightBound - input.panelRight
      : 0;
  return {
    width,
    offsetX: input.currentOffsetX + visualOffset / scale,
    needsRemeasure: false,
  };
}

export default function BulkUpgradeButton({
  folderPaths,
  githubMissingPaths = [],
  onApplyGithubUrls,
  onToast,
}: {
  folderPaths: string[];
  /** GitHub 주소 칸이 빈 프로젝트의 폴더 경로. 같은 스윕에서 origin을 함께 읽는다. */
  githubMissingPaths?: string[];
  onApplyGithubUrls?: (found: DetectedGithubUrl[]) => Promise<number>;
  onToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [github, setGithub] = useState<DetectedGithubUrl[]>([]);
  const [state, setState] = useState<BulkUpgradeState>({ memory: emptyTarget(), workflow: emptyTarget(), tester: emptyTarget(), hermes: null, promotion: [], missing: [], checked: 0 });
  const [open, setOpen] = useState(false);
  const [upgradeFailures, setUpgradeFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState<BulkUpgradeTarget | 'hermes' | 'all' | 'github' | 'promote' | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverPanelRef = useRef<HTMLDivElement | null>(null);
  const [popoverPlacement, setPopoverPlacement] = useState({ width: BULK_POPOVER_WIDTH, offsetX: 0 });
  // Scanning every registered folder costs real filesystem work, so it runs on
  // an explicit trigger and after an upgrade — never on a timer.
  const scanningRef = useRef(false);

  const refresh = useCallback(async () => {
    if (scanningRef.current || isDeployedWeb() || folderPaths.length === 0) return;
    scanningRef.current = true;
    try {
      const payload = await postJson<Parameters<typeof summarizeUpgradeStatus>[0] & { github?: DetectedGithubUrl[] }>(
        '/api/upgrade-status',
        { folderPaths, githubMissing: githubMissingPaths },
      );
      setState(summarizeUpgradeStatus(payload));
      setGithub(Array.isArray(payload.github) ? payload.github : []);
    } catch {
      // A failed scan must not claim "everything is up to date"; leave the last
      // known counts alone and let the user retry from the popover.
    } finally {
      scanningRef.current = false;
    }
  }, [folderPaths, githubMissingPaths]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placeInsideHeader = () => {
      const panel = popoverPanelRef.current;
      const header = panel?.closest<HTMLElement>('[data-testid="project-main-header"]');
      if (!panel || !header) return;

      const panelRect = panel.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const next = resolveBulkPopoverPlacement({
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        panelVisualWidth: panelRect.width,
        panelLogicalWidth: panel.offsetWidth,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        viewportWidth: window.innerWidth,
        currentWidth: popoverPlacement.width,
        currentOffsetX: popoverPlacement.offsetX,
      });

      // A width change moves the left edge of this right-anchored panel. Re-read
      // its rect on the next layout pass before calculating the final offset.
      if (next.needsRemeasure) {
        setPopoverPlacement({ width: next.width, offsetX: 0 });
        return;
      }
      if (Math.abs(next.offsetX - popoverPlacement.offsetX) > 0.5) {
        setPopoverPlacement({ width: next.width, offsetX: next.offsetX });
      }
    };

    placeInsideHeader();
    window.addEventListener('resize', placeInsideHeader);
    return () => window.removeEventListener('resize', placeInsideHeader);
  }, [open, popoverPlacement.offsetX, popoverPlacement.width]);

  const runUpgrade = useCallback(async (targets: BulkUpgradeTarget[]) => {
    const planned = targets.filter(target => state[target].folderPaths.length > 0);
    if (planned.length === 0 || busy) return;
    setBusy(planned.length > 1 ? 'all' : planned[0]!);
    setUpgradeFailures([]);
    let upgraded = 0;
    const failures: string[] = [];
    try {
      for (const target of planned) {
        const result = await postJson<{ upgraded: number; failed: number; results: Array<{ folderPath: string; ok: boolean; error?: string }> }>(
          '/api/upgrade-batch',
          { target, folderPaths: state[target].folderPaths },
        );
        upgraded += result.upgraded;
        for (const row of result.results) {
          if (!row.ok) failures.push(`${TARGET_LABEL[target]}: ${row.folderPath.split('/').pop()} — ${row.error ?? '알 수 없는 오류'}`);
        }
      }
      await refresh();
      if (failures.length === 0) {
        onToast(`${upgraded}개 프로젝트를 최신 버전으로 갱신했습니다.`, 'success');
      } else {
        // Partial success is reported as partial. Saying "done" while some
        // repositories silently stayed behind is how the backlog got here.
        onToast(`${upgraded}개 갱신 완료, ${failures.length}개 실패 — ${failures[0]}`, 'error');
      }
    } catch (error) {
      onToast(`일괄 갱신 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setUpgradeFailures(failures);
      setBusy(null);
    }
  }, [busy, onToast, refresh, state]);

  // 기기당 하나라 folderPaths 가 없다. 프로젝트 경로를 보내면 서버가 무시하므로
  // 같은 runUpgrade 에 태우지 않고 별도 경로로 둔다.
  /**
   * 공통 계층 **승격 후보 모으기**. 갱신이 아니다 — 프로젝트를 하나도 바꾸지 않고, 러너의 읽기 전용
   * `scenarios promote`를 모아 보고서 한 장을 남긴다. 어느 후보를 공통으로 올릴지는 이 저장소 커밋으로
   * 사람·워크룸 AI가 정한다(러너는 AI를 부르지 않는다).
   */
  const [promotionResult, setPromotionResult] = useState<{ ready: number; checked: number; reportPath: string } | null>(null);
  const runPromotion = useCallback(async () => {
    if (!state.promotion.length || busy) return;
    setBusy('promote');
    try {
      const result = await postJson<{ ready: number; checked: number; failed: number; reportPath?: string }>(
        '/api/upgrade-batch',
        { target: 'promote', folderPaths: state.promotion },
      );
      setPromotionResult({ ready: result.ready ?? 0, checked: result.checked ?? 0, reportPath: result.reportPath ?? '' });
      const failed = result.failed ?? 0;
      // An empty answer stops counting toward the badge for this set of projects (src/testerPromotionBadge.ts) —
      // but only a real answer: projects that could not be checked are not «no candidates» (2026-10-06 review).
      if (!failed) writeTesterPromotionMemo({ signature: testerPromotionSignature(state.promotion), ready: result.ready ?? 0, at: Date.now() });
      onToast(failed && !(result.checked ?? 0)
        ? `승격 후보를 확인하지 못했습니다 — ${failed}개 프로젝트 모두 실패했습니다(테스터·Python 상태를 확인하세요).`
        : result.ready
          ? `공통으로 올릴 후보 ${result.ready}개를 찾았습니다. 프로젝트는 하나도 바뀌지 않았습니다.${failed ? ` (${failed}개는 확인하지 못함)` : ''}`
          : `승격할 만한 후보가 아직 없습니다 (프로젝트 ${result.checked ?? 0}개 확인${failed ? `, ${failed}개는 확인하지 못함` : ''}).`,
        failed && !(result.checked ?? 0) ? 'error' : 'success');
    } catch (error) {
      onToast(`승격 후보 확인 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [busy, state.promotion, onToast]);

  const runHermesUpgrade = useCallback(async () => {
    if (!state.hermes || busy) return;
    setBusy('hermes');
    try {
      const result = await postJson<{ upgraded: number; failed: number; error?: string }>(
        '/api/upgrade-batch',
        { target: 'hermes' },
      );
      await refresh();
      if (result.failed > 0 || result.upgraded === 0) {
        onToast(`Telegram 명령 갱신 실패 — ${result.error ?? '알 수 없는 오류'}`, 'error');
      } else {
        onToast(`Telegram 명령(Hermes)을 최신 버전으로 갱신했습니다. ${HERMES_POST_INSTALL_HINT}`, 'success');
      }
    } catch (error) {
      onToast(`Telegram 명령 갱신 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [busy, onToast, refresh, state.hermes]);

  const applyGithub = useCallback(async () => {
    if (!onApplyGithubUrls || github.length === 0 || busy) return;
    setBusy('github');
    try {
      const filled = await onApplyGithubUrls(github);
      setGithub([]);
      onToast(`GitHub 주소 ${filled}개를 채웠습니다.`, 'success');
    } catch (error) {
      onToast(`GitHub 주소 채우기 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [busy, github, onApplyGithubUrls, onToast]);

  const versionPending = ALL_TARGETS.reduce((sum, target) => sum + state[target].folderPaths.length, 0) + (state.hermes ? 1 : 0);
  const nonEmptyTargets = ALL_TARGETS.filter(target => state[target].folderPaths.length > 0);
  // GitHub 주소 보강도 "밀려 있는 정리"라 같은 배지에서 센다. 항목이 없으면 이 버튼
  // 자체가 사라지므로, 한 번 정리하고 나면 헤더에 아무것도 남지 않는다.
  // 승격은 **갱신이 아니라 모으기**지만 사용자가 「지금 할 수 있는 정리」로 보는 것은 같다.
  // 항목이 0이면 이 행도, 이 버튼도 화면에 남지 않는다.
  // An answer of «no candidates yet» for these same projects is remembered, so a badge the user
  // just cleared does not come straight back (src/testerPromotionBadge.ts).
  const promotionCounts = testerPromotionCounts(state.promotion, promotionResult
    ? { signature: testerPromotionSignature(state.promotion), ready: promotionResult.ready, at: Date.now() }
    : readTesterPromotionMemo(), Date.now());
  const pending = versionPending + github.length + (promotionCounts ? 1 : 0);
  if (isDeployedWeb() || pending === 0) return null;

  const row = (target: BulkUpgradeTarget) => {
    const entry = state[target];
    if (entry.folderPaths.length === 0) return null;
    return (
      <div
        data-testid={`bulk-upgrade-row-${target}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0' }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color:'var(--text-primary)', fontSize: 11.5, fontWeight: 600 }}>{TARGET_LABEL[target]}</div>
          <div style={{ color:'var(--text-secondary)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
            {entry.folderPaths.length}개 · v{entry.installedVersion} → v{entry.currentVersion}
          </div>
        </div>
        <button
          data-testid={`bulk-upgrade-run-${target}`}
          disabled={!!busy}
          onClick={() => void runUpgrade([target])}
          style={{
            padding: '4px 9px', borderRadius: 5, whiteSpace: 'nowrap',
            border: '1px solid rgb(var(--warn-rgb) / 0.45)', background: 'var(--bg-warning)',
            color:'var(--ink-fde68a)', fontSize: 10.5, fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
          }}
        >
          {busy === target ? '갱신 중…' : '갱신'}
        </button>
      </div>
    );
  };

  return (
    <div style={{ position: 'relative' }} ref={popoverRef}>
      <button
        data-help-key="header-bulk-upgrade"
        data-testid="header-bulk-upgrade"
        data-pending={pending}
        onClick={() => {
          if (!open) setPopoverPlacement({ width: BULK_POPOVER_WIDTH, offsetX: 0 });
          setOpen(value => !value);
        }}
        title="버전이 올라간 기능이 아직 반영되지 않은 프로젝트를 한 번에 갱신합니다."
        style={{
          padding: '5px 9px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 5,
          border: '1px solid rgb(var(--warn-rgb) / 0.45)', background: 'var(--bg-warning)',
          color:'var(--ink-fde68a)', fontSize: 11, fontWeight: 600,
          fontFamily: 'inherit', whiteSpace: 'nowrap',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        <RefreshCw style={{ width: 12, height: 12 }} />
        업데이트 {pending}
      </button>

      {open && (
        <div
          ref={popoverPanelRef}
          data-testid="bulk-upgrade-popover"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
            width: popoverPlacement.width, padding: '10px 12px', borderRadius: 8,
            boxSizing: 'border-box', transform: `translateX(${popoverPlacement.offsetX}px)`,
            background: 'var(--bg-elevated)', border: '1px solid rgb(var(--surface-highlight-rgb) / 0.12)',
            boxShadow: 'var(--dialog-shadow)',
          }}
        >
          <div style={{ color:'var(--text-primary)', fontSize: 11.5, fontWeight: 600, marginBottom: 2 }}>
            버전 일괄 업데이트
          </div>
          <div style={{ color:'var(--text-secondary)', fontSize: 10.5, lineHeight: 1.5, marginBottom: 4 }}>
            기억 내용과 Supabase 연결은 그대로 두고, 생성된 스킬·훅·설정 파일만 최신 버전으로 교체합니다.
          </div>
          {row('memory')}
          {row('workflow')}
          {row('tester')}
          {upgradeFailures.length>0&&<div role="alert" data-testid="bulk-upgrade-failures" style={{maxHeight:180,overflowY:'auto',fontSize:11,lineHeight:1.5,color:'var(--text-primary)'}}>
            <p>갱신하지 못한 프로젝트 {upgradeFailures.length}개</p>
            <ul>{upgradeFailures.map((failure,index)=><li key={index}>{failure}</li>)}</ul>
          </div>}
          {state.promotion.length > 0 && (
            <div
              data-testid="bulk-upgrade-row-promote"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0',
                borderTop: '1px solid rgb(var(--surface-highlight-rgb) / 0.08)', marginTop: 6 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ color:'var(--text-primary)', fontSize: 11.5, fontWeight: 600 }}>공통 테스터 승격 후보</div>
                <div style={{ color:'var(--text-secondary)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
                  {promotionResult
                    ? `올릴 후보 ${promotionResult.ready}개 · 프로젝트 ${promotionResult.checked}개 확인`
                    : `프로젝트 ${state.promotion.length}개가 자기 검사를 갖고 있습니다 · 눌러도 프로젝트는 바뀌지 않습니다`}
                </div>
              </div>
              <button
                data-testid="bulk-upgrade-run-promote"
                disabled={!!busy}
                onClick={() => void runPromotion()}
                title="프로젝트별 시나리오와 장기기억에서 공통 계층으로 올릴 후보를 모읍니다. 읽기 전용이라 프로젝트를 바꾸지 않고, 공통 계층은 이 저장소에 커밋할 때만 바뀝니다."
                style={{
                  padding: '4px 9px', borderRadius: 5, whiteSpace: 'nowrap',
                  border: '1px solid rgb(var(--line-2))', background: 'transparent',
                  color:'var(--text-primary)', fontSize: 10.5, fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                {busy === 'promote' ? '모으는 중…' : '후보 모으기'}
              </button>
            </div>
          )}
          {promotionResult?.reportPath && (
            <div data-testid="bulk-upgrade-promote-report" style={{ color:'var(--text-secondary)', fontSize: 10.5, lineHeight: 1.5, paddingBottom: 6 }}>
              보고서: {promotionResult.reportPath}
              <div>공통 계층은 이 저장소에 커밋하고 러너 버전을 올릴 때만 바뀝니다 — 그때 위 「프로젝트 테스터」 행으로 전 프로젝트에 퍼집니다.</div>
            </div>
          )}
          {state.hermes && (
            <div
              data-testid="bulk-upgrade-row-hermes"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 0' }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ color:'var(--text-primary)', fontSize: 11.5, fontWeight: 600 }}>{HERMES_LABEL}</div>
                <div style={{ color:'var(--text-secondary)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
                  이 기기 · v{state.hermes.installedVersion} → v{state.hermes.currentVersion}
                </div>
              </div>
              <button
                data-testid="bulk-upgrade-run-hermes"
                disabled={!!busy}
                onClick={() => void runHermesUpgrade()}
                style={{
                  padding: '4px 9px', borderRadius: 5, whiteSpace: 'nowrap',
                  border: '1px solid rgb(var(--warn-rgb) / 0.45)', background: 'var(--bg-warning)',
                  color:'var(--ink-fde68a)', fontSize: 10.5, fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                {busy === 'hermes' ? '갱신 중…' : '갱신'}
              </button>
            </div>
          )}
          {github.length > 0 && (
            <div data-testid="bulk-github-row" style={{ borderTop: '1px solid rgb(var(--surface-highlight-rgb) / 0.08)', marginTop: 6, paddingTop: 7 }}>
              <div style={{ color:'var(--text-primary)', fontSize: 11.5, fontWeight: 600 }}>GitHub 주소 채우기</div>
              <div style={{ color:'var(--text-secondary)', fontSize: 10.5, lineHeight: 1.5, marginBottom: 5 }}>
                폴더의 origin은 있는데 앱에는 비어 있는 프로젝트 {github.length}개입니다.
                이 값이 기기 간에 같은 프로젝트임을 알려줍니다.
              </div>
              {/* 조용히 3개를 바꾸지 않고, 무엇이 들어갈지 먼저 보여준다. */}
              <ul style={{ margin: '0 0 6px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {github.map(found => (
                  <li key={found.folderPath} style={{ fontSize: 10, color:'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color:'var(--text-primary)' }}>{found.folderPath.split('/').pop()}</span>
                    {' · '}
                    {found.remoteUrl.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '')}
                  </li>
                ))}
              </ul>
              <button
                data-testid="bulk-github-apply"
                disabled={!!busy || !onApplyGithubUrls}
                onClick={() => void applyGithub()}
                style={{
                  padding: '4px 9px', borderRadius: 5, whiteSpace: 'nowrap',
                  border: '1px solid rgb(var(--info-rgb) / 0.45)', background: 'rgba(14,116,144,0.18)',
                  color:'var(--ink-7dd3fc)', fontSize: 10.5, fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                {busy === 'github' ? '채우는 중…' : `${github.length}개 채우기`}
              </button>
            </div>
          )}
          {nonEmptyTargets.length > 1 && (
            <button
              data-testid="bulk-upgrade-run-all"
              disabled={!!busy}
              onClick={() => void runUpgrade([...nonEmptyTargets])}
              style={{
                width: '100%', marginTop: 8, padding: '6px 9px', borderRadius: 6,
                border: '1px solid rgb(var(--surface-highlight-rgb) / 0.14)', background: 'rgb(var(--surface-highlight-rgb) / 0.04)',
                color:'var(--text-primary)', fontSize: 11, fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
              }}
            >
              {busy === 'all' ? '전체 갱신 중…' : `전체 ${pending}개 갱신`}
            </button>
          )}
          {state.missing.length > 0 && (
            <div style={{ marginTop: 8, color:'var(--text-secondary)', fontSize: 10 }}>
              폴더가 없어 건너뛴 프로젝트 {state.missing.length}개
            </div>
          )}
        </div>
      )}
    </div>
  );
}
