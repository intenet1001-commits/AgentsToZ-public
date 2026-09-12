import { useCallback, useEffect, useState } from 'react';
import { LockOpen, RefreshCw, X } from 'lucide-react';
import { isTauri } from '../lib/env';
import type {
  OrphanedWorkspaceLease,
  WorkspaceLeaseRecoveryOutcome,
  WorkspaceLeaseRecoveryResult,
} from '../workspaceLeaseRecoveryContract';

/**
 * A sidecar that dies while holding a `manual` workspace lease leaves a lock the
 * app deliberately never reclaims: a detached AI/Git descendant might still be
 * writing. Before this dialog the only way out was deleting a hash-named file
 * by hand. Recovery stays a human decision — it is offered only after the user
 * confirms that related work has ended, and nothing here runs on its own.
 */

export interface OrphanedWorkspaceLeaseGroup {
  id: string;
  workspacePath: string | null;
  locks: OrphanedWorkspaceLease[];
  pids: number[];
  lockedAt: string;
}

function toGroup(id: string, workspacePath: string | null, locks: OrphanedWorkspaceLease[]): OrphanedWorkspaceLeaseGroup {
  return {
    id,
    workspacePath,
    locks,
    pids: [...new Set(locks.map(lock => lock.pid))].sort((a, b) => a - b),
    lockedAt: locks.map(lock => lock.lockedAt).sort().at(-1) ?? '',
  };
}

/** A project's folder lock and its Git family lock are recovered together. */
export function groupOrphanedWorkspaceLeases(orphans: readonly OrphanedWorkspaceLease[]): OrphanedWorkspaceLeaseGroup[] {
  const named = new Map<string, OrphanedWorkspaceLease[]>();
  const unknown: OrphanedWorkspaceLeaseGroup[] = [];
  for (const orphan of orphans) {
    if (orphan.workspacePath === null) {
      unknown.push(toGroup(orphan.key, null, [orphan]));
      continue;
    }
    named.set(orphan.workspacePath, [...(named.get(orphan.workspacePath) ?? []), orphan]);
  }
  const groups = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, locks]) => toGroup(path, path, locks));
  return [...groups, ...unknown];
}

const KIND_LABEL: Record<OrphanedWorkspaceLease['kind'], string> = {
  directory: '폴더 잠금',
  'git-family': 'Git 저장소 잠금',
  unknown: '등록된 프로젝트와 연결되지 않은 잠금',
};

const REFUSAL_LABEL: Partial<Record<WorkspaceLeaseRecoveryOutcome, string>> = {
  'owner-changed': '그 사이 다른 작업이 새로 잠갔습니다',
  'owner-alive': '잠금을 잡은 프로세스가 실행 중입니다',
  'not-manual': '앱이 스스로 회수하는 잠금입니다',
  invalid: '요청이 올바르지 않습니다',
};

function projectName(group: OrphanedWorkspaceLeaseGroup): string {
  return group.workspacePath?.split('/').filter(Boolean).at(-1) ?? '알 수 없는 작업공간';
}

function formatLockedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
}

export function WorkspaceLeaseRecoveryList({ groups, confirmed, busyKey, onConfirmedChange, onRecover }: {
  groups: OrphanedWorkspaceLeaseGroup[];
  confirmed: boolean;
  busyKey: string | null;
  onConfirmedChange: (confirmed: boolean) => void;
  onRecover: (group: OrphanedWorkspaceLeaseGroup) => void;
}) {
  if (groups.length === 0) {
    return <p data-testid="workspace-lease-recovery-empty" style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0 }}>
      남아 있는 잠금이 없습니다. 종료된 프로세스가 남긴 작업공간 잠금이 생기면 여기에 표시됩니다.
    </p>;
  }
  return <div style={{ display: 'grid', gap: 12 }}>
    <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0, lineHeight: 1.55 }}>
      아래 잠금은 이미 종료된 앱 프로세스가 작업 도중 남긴 것입니다. 그 프로세스가 띄운 AI·Git 작업이
      아직 파일을 쓰고 있을 수 있어 앱이 스스로 풀지 않습니다. 해당 프로젝트에서 진행 중인 작업이 없는지
      확인한 뒤 복구하세요.
    </p>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {groups.map((group, index) => <li key={group.id} data-testid={`workspace-lease-group-${index}`}
        style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{projectName(group)}</div>
          {group.workspacePath && <div style={{ fontSize: 11.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{group.workspacePath}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 2 }}>
            {group.pids.map(pid => `PID ${pid}`).join(', ')} 종료 · 마지막 갱신 {formatLockedAt(group.lockedAt)} · {[...new Set(group.locks.map(lock => KIND_LABEL[lock.kind]))].join(' · ')}
          </div>
        </div>
        <button type="button" data-testid={`workspace-lease-recover-${index}`} disabled={!confirmed || busyKey !== null}
          onClick={() => onRecover(group)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 8,
            border: '1px solid var(--line-2)', background: 'var(--raised)', color: 'var(--ink)', cursor: !confirmed || busyKey !== null ? 'not-allowed' : 'pointer',
            opacity: !confirmed || busyKey !== null ? 0.5 : 1, whiteSpace: 'nowrap' }}>
          {busyKey === group.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <LockOpen className="w-3.5 h-3.5" />}
          잠금 복구
        </button>
      </li>)}
    </ul>
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--ink)' }}>
      <input type="checkbox" data-testid="workspace-lease-recovery-confirm" checked={confirmed}
        onChange={event => onConfirmedChange(event.target.checked)} />
      관련 AI·Git 작업이 모두 끝났음을 확인했습니다.
    </label>
  </div>;
}

const baseUrl = () => (isTauri() ? 'http://localhost:3001' : '');

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error || `요청 실패 (${response.status})`);
  return payload as T;
}

export function WorkspaceLeaseRecoveryDialog({ onClose, onToast }: {
  onClose: () => void;
  onToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [orphans, setOrphans] = useState<OrphanedWorkspaceLease[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const payload = await requestJson<{ orphans?: OrphanedWorkspaceLease[] }>('/api/workspace-leases/orphans');
      setOrphans(Array.isArray(payload.orphans) ? payload.orphans : []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const recover = useCallback(async (group: OrphanedWorkspaceLeaseGroup) => {
    setBusyKey(group.id);
    try {
      const payload = await requestJson<{ results?: WorkspaceLeaseRecoveryResult[] }>('/api/workspace-leases/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locks: group.locks.map(({ key, pid }) => ({ key, pid })) }),
      });
      const refused = (payload.results ?? []).filter(result => result.outcome !== 'recovered' && result.outcome !== 'missing');
      if (refused.length > 0) {
        onToast(`${projectName(group)}: 잠금 ${refused.length}개를 복구하지 않았습니다 — ${REFUSAL_LABEL[refused[0]!.outcome] ?? refused[0]!.outcome}`, 'error');
      } else {
        onToast(`${projectName(group)} 잠금을 복구했습니다. 실패했던 작업을 다시 실행하세요.`, 'success');
      }
      setConfirmed(false);
      await load();
    } catch (error) {
      onToast(`잠금 복구 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusyKey(null);
    }
  }, [load, onToast]);

  return <div role="dialog" aria-modal="true" aria-labelledby="workspace-lease-recovery-title" data-testid="workspace-lease-recovery-dialog"
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div style={{ width: 'min(560px, 100%)', maxHeight: '85vh', overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 14, boxShadow: 'var(--shadow-lg, var(--shadow))', padding: 18, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <LockOpen className="w-4 h-4" style={{ color: 'var(--accent)' }} />
        <h2 id="workspace-lease-recovery-title" style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--ink)', flex: 1 }}>작업공간 잠금 복구</h2>
        <button type="button" onClick={() => void load()} title="다시 확인" disabled={busyKey !== null}
          style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4 }}>
          <RefreshCw className="w-4 h-4" />
        </button>
        <button type="button" data-testid="workspace-lease-recovery-close" onClick={onClose} title="닫기"
          style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4 }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {loadError
        ? <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', margin: 0 }}>잠금 목록을 불러오지 못했습니다: {loadError}</p>
        : orphans === null
          ? <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0 }}>확인하는 중…</p>
          : <WorkspaceLeaseRecoveryList groups={groupOrphanedWorkspaceLeases(orphans)} confirmed={confirmed} busyKey={busyKey}
              onConfirmedChange={setConfirmed} onRecover={group => void recover(group)} />}
    </div>
  </div>;
}
