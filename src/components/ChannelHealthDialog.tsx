import { useCallback, useEffect, useState } from 'react';
import { Cable, RefreshCw, X } from 'lucide-react';
import { isTauri } from '../lib/env';
import type { ChannelHealth, ChannelHealthReport, ChannelHealthState } from '../channelHealth';

/**
 * 「채널 연동 상태」 — whether each AI's AgentsToZ control tool and each Telegram
 * bot is actually answering. A saved setting never shows as 「연결됨」 on its own;
 * only a fresh 「지금 확인」 (read-only project list) or a live gateway does.
 */

const STATE_COLOR: Record<ChannelHealthState, string> = {
  verified: 'var(--ok)',
  'configured-unverified': 'var(--info)',
  'configured-unresponsive': 'var(--warn)',
  'not-installed': 'var(--ink-3)',
  unknown: 'var(--ink-3)',
};

function formatCheckedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function ChannelRow({ channel, busyId, onProbe }: {
  channel: ChannelHealth;
  busyId: string | null;
  onProbe: (channel: ChannelHealth) => void;
}) {
  const checkedAt = formatCheckedAt(channel.checkedAt);
  const busy = busyId === channel.id;
  return <li data-testid={`channel-health-row-${channel.id}`} data-state={channel.state}
    style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
    <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{channel.title}</span>
        <span data-testid={`channel-health-state-${channel.id}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)',
            border: '1px solid var(--line-2)', borderRadius: 999, padding: '1px 8px' }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: STATE_COLOR[channel.state] }} />
          {channel.label}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: 0, lineHeight: 1.5 }}>{channel.detail}</p>
      {channel.notes.map(note => <p key={note} style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: 0 }}>{note}</p>)}
      {checkedAt && <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: 0 }}>마지막 확인 {checkedAt}</p>}
    </div>
    {channel.canProbe && <button type="button" data-testid={`channel-health-probe-${channel.id}`} disabled={busyId !== null}
      onClick={() => onProbe(channel)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 8,
        border: '1px solid var(--line-2)', background: 'var(--raised)', color: 'var(--ink)', cursor: busyId !== null ? 'not-allowed' : 'pointer',
        opacity: busyId !== null ? 0.5 : 1, whiteSpace: 'nowrap' }}>
      <RefreshCw className={`w-3.5 h-3.5${busy ? ' animate-spin' : ''}`} />
      {busy ? '확인 중…' : '지금 확인'}
    </button>}
  </li>;
}

export function ChannelHealthList({ report, busyId, onProbe }: {
  report: ChannelHealthReport;
  busyId: string | null;
  onProbe: (channel: ChannelHealth) => void;
}) {
  const mcp = report.channels.filter(channel => channel.kind === 'mcp');
  const telegram = report.channels.filter(channel => channel.kind === 'telegram');
  const section = (title: string, help: string, rows: ChannelHealth[], empty: string, testId: string) => <section data-testid={testId} style={{ display: 'grid', gap: 8 }}>
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: 'var(--ink)' }}>{title}</h3>
      <p style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '2px 0 0' }}>{help}</p>
    </div>
    {rows.length === 0
      ? <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: 0 }}>{empty}</p>
      : <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {rows.map(channel => <ChannelRow key={channel.id} channel={channel} busyId={busyId} onProbe={onProbe} />)}
      </ul>}
  </section>;
  return <div style={{ display: 'grid', gap: 16 }}>
    <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0, lineHeight: 1.55 }}>
      AI와 텔레그램이 AgentsToZ와 실제로 이어져 있는지 보여줍니다. 설정을 저장한 것만으로는
      「연결됨」이 되지 않습니다. 「지금 확인」을 누르면 프로젝트 목록을 읽기만 해서 실제 응답을 확인합니다.
    </p>
    {section('AI 제어 도구', 'Codex·Claude·Hermes·agy가 AgentsToZ를 부를 때 쓰는 연결입니다.', mcp, 'AI 목록을 읽지 못했습니다.', 'channel-health-mcp')}
    {section('텔레그램 봇', '이 컴퓨터의 Hermes 프로필별 봇입니다.', telegram, '이 컴퓨터에는 Hermes 프로필이 없습니다.', 'channel-health-telegram')}
    {report.mcpProcesses?.message && <p data-testid="channel-health-stale-processes" role="note"
      style={{ fontSize: 12, color: 'var(--ink-2)', margin: 0, padding: '8px 10px', borderRadius: 8, background: 'var(--sunken)', lineHeight: 1.5 }}>
      {report.mcpProcesses.message}
    </p>}
  </div>;
}

const baseUrl = () => (isTauri() ? 'http://localhost:3001' : '');

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error || `요청 실패 (${response.status})`);
  return payload as T;
}

export function ChannelHealthDialog({ onClose, onToast }: {
  onClose: () => void;
  onToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [report, setReport] = useState<ChannelHealthReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      setReport(await requestJson<ChannelHealthReport>('/api/channels/health'));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const probe = useCallback(async (channel: ChannelHealth) => {
    const agent = channel.id.replace(/^mcp:/, '');
    setBusyId(channel.id);
    try {
      const payload = await requestJson<ChannelHealthReport & { probe?: { ok?: boolean } }>('/api/channels/health/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent }),
      });
      setReport(payload);
      onToast(payload.probe?.ok ? `${channel.title}: 응답을 확인했습니다.` : `${channel.title}: 응답이 없었습니다. 아래 설명을 확인하세요.`, payload.probe?.ok ? 'success' : 'error');
    } catch (error) {
      onToast(`확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusyId(null);
    }
  }, [onToast]);

  return <div role="dialog" aria-modal="true" aria-labelledby="channel-health-title" data-testid="channel-health-dialog"
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div style={{ width: 'min(600px, 100%)', maxHeight: '85vh', overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 14, boxShadow: 'var(--shadow-lg, var(--shadow))', padding: 18, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Cable className="w-4 h-4" style={{ color: 'var(--accent)' }} />
        <h2 id="channel-health-title" style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--ink)', flex: 1 }}>채널 연동 상태</h2>
        <button type="button" data-testid="channel-health-refresh" onClick={() => void load()} title="다시 확인" aria-label="다시 확인" disabled={busyId !== null || loading}
          style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4 }}>
          <RefreshCw className={`w-4 h-4${loading ? ' animate-spin' : ''}`} />
        </button>
        <button type="button" data-testid="channel-health-close" onClick={onClose} title="닫기" aria-label="닫기"
          style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4 }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {loadError
        ? <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', margin: 0 }}>채널 상태를 불러오지 못했습니다: {loadError}</p>
        : report === null
          ? <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0 }}>확인하는 중…</p>
          : <ChannelHealthList report={report} busyId={busyId} onProbe={channel => void probe(channel)} />}
    </div>
  </div>;
}
