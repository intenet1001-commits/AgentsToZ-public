import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { isTauri, isDeployedWeb } from '../lib/env';

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
  installedVersion: number | null;
  currentVersion: number | null;
}

export interface BulkUpgradeState {
  memory: BulkUpgradeTargetState;
  workflow: BulkUpgradeTargetState;
  missing: string[];
  checked: number;
}

export type BulkUpgradeTarget = 'memory' | 'workflow';

const TARGET_LABEL: Record<BulkUpgradeTarget, string> = {
  memory: '장기기억 에이전트',
  workflow: '저장소 워크플로',
};

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
  missing?: string[];
  checked?: number;
}): BulkUpgradeState {
  const fold = (rows: Array<{ folderPath: string; installedVersion: number; currentVersion: number }> = []) => ({
    folderPaths: rows.map(row => row.folderPath),
    // The oldest installed version is the honest headline: it is what the user
    // is actually running somewhere, not an average.
    installedVersion: rows.length ? Math.min(...rows.map(row => row.installedVersion)) : null,
    currentVersion: rows.length ? Math.max(...rows.map(row => row.currentVersion)) : null,
  });
  return {
    memory: fold(payload.memory),
    workflow: fold(payload.workflow),
    missing: payload.missing ?? [],
    checked: payload.checked ?? 0,
  };
}

export interface DetectedGithubUrl {
  folderPath: string;
  remoteUrl: string;
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
  const [state, setState] = useState<BulkUpgradeState>({ memory: emptyTarget(), workflow: emptyTarget(), missing: [], checked: 0 });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BulkUpgradeTarget | 'all' | 'github' | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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

  const runUpgrade = useCallback(async (targets: BulkUpgradeTarget[]) => {
    const planned = targets.filter(target => state[target].folderPaths.length > 0);
    if (planned.length === 0 || busy) return;
    setBusy(planned.length > 1 ? 'all' : planned[0]!);
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
      setBusy(null);
    }
  }, [busy, onToast, refresh, state]);

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

  const versionPending = state.memory.folderPaths.length + state.workflow.folderPaths.length;
  // GitHub 주소 보강도 "밀려 있는 정리"라 같은 배지에서 센다. 항목이 없으면 이 버튼
  // 자체가 사라지므로, 한 번 정리하고 나면 헤더에 아무것도 남지 않는다.
  const pending = versionPending + github.length;
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
          <div style={{ color: '#e4e4e7', fontSize: 11.5, fontWeight: 600 }}>{TARGET_LABEL[target]}</div>
          <div style={{ color: '#a1a1aa', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
            {entry.folderPaths.length}개 · v{entry.installedVersion} → v{entry.currentVersion}
          </div>
        </div>
        <button
          data-testid={`bulk-upgrade-run-${target}`}
          disabled={!!busy}
          onClick={() => void runUpgrade([target])}
          style={{
            padding: '4px 9px', borderRadius: 5, whiteSpace: 'nowrap',
            border: '1px solid rgba(251,191,36,0.45)', background: 'rgba(120,53,15,0.22)',
            color: '#fde68a', fontSize: 10.5, fontWeight: 600,
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
        onClick={() => setOpen(value => !value)}
        title="버전이 올라간 기능이 아직 반영되지 않은 프로젝트를 한 번에 갱신합니다."
        style={{
          padding: '5px 9px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 5,
          border: '1px solid rgba(251,191,36,0.45)', background: 'rgba(120,53,15,0.22)',
          color: '#fde68a', fontSize: 11, fontWeight: 600,
          fontFamily: 'Inter Tight, system-ui, sans-serif', whiteSpace: 'nowrap',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        <RefreshCw style={{ width: 12, height: 12 }} />
        업데이트 {pending}
      </button>

      {open && (
        <div
          data-testid="bulk-upgrade-popover"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
            width: 300, padding: '10px 12px', borderRadius: 8,
            background: '#18181b', border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ color: '#f4f4f5', fontSize: 11.5, fontWeight: 600, marginBottom: 2 }}>
            버전 일괄 업데이트
          </div>
          <div style={{ color: '#a1a1aa', fontSize: 10.5, lineHeight: 1.5, marginBottom: 4 }}>
            기억 내용과 Supabase 연결은 그대로 두고, 생성된 스킬·훅·설정 파일만 최신 버전으로 교체합니다.
          </div>
          {row('memory')}
          {row('workflow')}
          {github.length > 0 && (
            <div data-testid="bulk-github-row" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 6, paddingTop: 7 }}>
              <div style={{ color: '#e4e4e7', fontSize: 11.5, fontWeight: 600 }}>GitHub 주소 채우기</div>
              <div style={{ color: '#a1a1aa', fontSize: 10.5, lineHeight: 1.5, marginBottom: 5 }}>
                폴더의 origin은 있는데 앱에는 비어 있는 프로젝트 {github.length}개입니다.
                이 값이 기기 간에 같은 프로젝트임을 알려줍니다.
              </div>
              {/* 조용히 3개를 바꾸지 않고, 무엇이 들어갈지 먼저 보여준다. */}
              <ul style={{ margin: '0 0 6px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {github.map(found => (
                  <li key={found.folderPath} style={{ fontSize: 10, color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: '#e4e4e7' }}>{found.folderPath.split('/').pop()}</span>
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
                  border: '1px solid rgba(125,211,252,0.45)', background: 'rgba(14,116,144,0.18)',
                  color: '#7dd3fc', fontSize: 10.5, fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                {busy === 'github' ? '채우는 중…' : `${github.length}개 채우기`}
              </button>
            </div>
          )}
          {state.memory.folderPaths.length > 0 && state.workflow.folderPaths.length > 0 && (
            <button
              data-testid="bulk-upgrade-run-all"
              disabled={!!busy}
              onClick={() => void runUpgrade(['memory', 'workflow'])}
              style={{
                width: '100%', marginTop: 8, padding: '6px 9px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)',
                color: '#e4e4e7', fontSize: 11, fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.5 : 1,
              }}
            >
              {busy === 'all' ? '전체 갱신 중…' : `전체 ${pending}개 갱신`}
            </button>
          )}
          {state.missing.length > 0 && (
            <div style={{ marginTop: 8, color: '#a1a1aa', fontSize: 10 }}>
              폴더가 없어 건너뛴 프로젝트 {state.missing.length}개
            </div>
          )}
        </div>
      )}
    </div>
  );
}
