import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import './index.css';
import PortalManager, { type PortalActions } from './PortalManager';
import {
  BookMarked, Settings, CloudUpload, CloudDownload,
  ExternalLink, Github, RefreshCw, Clock, Monitor, Smartphone,
  Server, Pencil, Trash2, Search,
  ChevronDown, X, MoreHorizontal, Link2,
  Plus, Check, Brain, Copy, Star, Cloud,
} from 'lucide-react';
import { type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, describeSupabaseError } from './lib/supabaseClient';
import { createDesktopDeviceInvite } from './onboardingHandoff';
import PortalMemoryDirectory from './PortalMemoryDirectory';
import {
  loadMemoryDirectory,
  matchMemoryForProject,
  DEVICE_IDENTITY_ALIAS_COLUMNS,
  MEMORY_ALIAS_COLUMNS,
  MEMORY_DEVICE_COLUMNS,
  MEMORY_DEVICE_RETIREMENT_COLUMNS,
  MEMORY_LABEL_COLUMNS,
  MEMORY_LIST_COLUMNS,
  MEMORY_MERGE_COLUMNS,
  MEMORY_MERGE_DEVICE_COLUMNS,
  MEMORY_TRASH_COLUMNS,
  PHYSICAL_DEVICE_COLUMNS,
  MEMORY_REVISION_WINDOW,
  REMOTE_MEMORY_DEVICE_COLUMNS,
  REMOTE_MEMORY_PROJECT_COLUMNS,
  type MemoryDirectoryEntry,
} from './projectMemoryDirectory';
import { fetchPushHistory, type PushSnapshot } from './pushHistory';
import { BuildInfoBadge } from './components/BuildInfoBadge';
import {
  githubRepositoryUrls,
  githubRepositoryUrlsText,
  normalizeGitHubRepositoryUrl,
  parseGitHubRepositoryUrls,
} from './githubUrls';
import { formatDeviceLastPushAt } from './deviceDisplay';
import RemoteDeviceManager from './RemoteDeviceManager';
import { buildPortalDesktopInventory, buildPortalRemoteInventory } from './portalDeviceInventory';
import {
  normalizePortalDeviceSelectionMode,
  resolvePortalDeviceSelection,
  storedPortalDeviceSelection,
  type PortalDeviceSelectionMode,
} from './portalDeviceSelection';

// ─── Supabase client ──────────────────────────────────────────────────────────
// 예전에는 "OAuth 세션용 클라이언트"와 "anon 쿼리용 클라이언트"를 따로 뒀지만,
// RLS(로그인 사용자만 접근)가 켜진 뒤에는 쿼리도 로그인 세션의 JWT로 나가야 한다.
// 인스턴스를 하나로 합쳐 세션 분열과 GoTrueClient 중복 경고를 없앤다.
function getDefaultSupabaseClient(url: string, key: string): SupabaseClient {
  return getSupabaseClient(url, key);
}

const GOOGLE_VERIFIED_KEY = 'portal_google_verified';
// client/UI 사전 필터(쉼표 구분). 비어 있으면 UI는 모든 Google 계정의 로그인을 시도하게 두지만,
// 실제 table 권한은 서버의 public.portmgr_allowed_members + RLS가 별도로 deny/allow한다.
const ALLOWED_EMAILS = ((import.meta.env.VITE_ALLOWED_EMAIL as string | undefined) ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const ENV_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const ENV_SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
const PORTAL_WEB_KEY = 'portalData_v1';
const VIEW_MODE_KEY = 'portalViewMode';
const SELECTED_DEVICE_KEY = 'portalSelectedDevice';
/** 조회 선택의 표시용 이름. 신원(portalData_v1.deviceName)과 섞지 않는다. */
const SELECTED_DEVICE_NAME_KEY = 'portalSelectedDeviceName';
const DEVICE_SELECTION_MODE_KEY = 'portalDeviceSelectionMode';
const DEFAULT_DEVICE_KEY = 'portalDefaultDevice';

function readInitialSelectedDeviceId(): string {
  const mode = normalizePortalDeviceSelectionMode(localStorage.getItem(DEVICE_SELECTION_MODE_KEY));
  return storedPortalDeviceSelection(
    mode,
    localStorage.getItem(SELECTED_DEVICE_KEY) ?? '',
    localStorage.getItem(DEFAULT_DEVICE_KEY) ?? '',
  );
}

// ─── URL param auto-auth (e.g. ?url=...&key=...&device=...&name=...) ──────────
;(function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  const key = params.get('key');
  if (!url || !key) return;
  try {
    const existing = JSON.parse(localStorage.getItem(PORTAL_WEB_KEY) ?? '{}');
    existing.supabaseUrl = url;
    existing.supabaseAnonKey = key;
    localStorage.setItem(PORTAL_WEB_KEY, JSON.stringify(existing));
    // Only set the *viewing* selection, never overwrite this browser's own identity
    const device = params.get('device');
    const nameParam = params.get('name');
    if (device) {
      localStorage.setItem(SELECTED_DEVICE_KEY, device);
      if (nameParam) localStorage.setItem(SELECTED_DEVICE_NAME_KEY, nameParam);
    }
  } catch {}
  window.history.replaceState({}, '', window.location.pathname);
})();

type ViewMode = 'auto' | 'compact' | 'full';
type Tab = 'bookmarks' | 'ports' | 'memories';

interface PortRow {
  id: string;
  name: string;
  port?: number | null;
  command_path?: string | null;
  terminal_command?: string | null;
  folder_path?: string | null;
  deploy_url?: string | null;
  github_url?: string | null;
  github_urls?: string[] | null;
  device_id?: string | null;
  device_name?: string | null;
  description?: string | null;
  category?: string | null;
  /** 이 프로젝트의 장기기억 ID. 앱이 폴더의 .agent-memory/config.json 에서 읽어 싣는다. */
  memory_id?: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  last_push_at: string | null;
  sourceIds: string[];
  projectCount: number;
  projectNames: string[];
  kind: 'desktop' | 'remote';
  environmentLabel?: string;
}

interface RemoteProjectPortalRow {
  device_id: string;
  project_path: string;
  project_name: string;
  memory_id: string | null;
  git_remote_url: string | null;
  git_head_sha: string | null;
  git_branch: string | null;
  git_dirty: boolean | null;
  present: boolean;
  last_observed_at: string;
  telegram_thread_id: string | null;
}

// portmgr_ports 에 category/description 컬럼이 없는 구버전 스키마 감지 (PGRST204)
function isMissingOptionalColumnError(error: { message?: string } | null): boolean {
  const msg = error?.message ?? '';
  return !!msg && (msg.includes('category') || msg.includes('description'));
}

function isMissingGithubUrlsColumnError(error: { message?: string } | null): boolean {
  return (error?.message ?? '').includes('github_urls');
}

function isEmailAllowed(email: string): boolean {
  if (ALLOWED_EMAILS.length === 0) return true;
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}

// RLS(로그인 사용자만 접근)가 켜져 있으므로 화이트리스트가 비어 있어도 로그인은 필요하다.
// (예전에는 ALLOWED_EMAILS가 비면 게이트를 통째로 건너뛰었고, 그 경로로는 anon 쿼리만 나가 전부 거부된다.)
// 로그인 세션이 이미 있으면 GoogleAuthGate의 INITIAL_SESSION 처리로 즉시 통과한다.
function isGoogleVerified(): boolean {
  const stored = localStorage.getItem(GOOGLE_VERIFIED_KEY) ?? '';
  if (!stored) return false;
  return isEmailAllowed(stored);
}

function getSupabaseCreds(): { url: string; key: string } | null {
  // Vercel env var 우선 — Google OAuth 세션과 동일 프로젝트 보장
  if (ENV_SUPABASE_URL && ENV_SUPABASE_KEY) return { url: ENV_SUPABASE_URL, key: ENV_SUPABASE_KEY };
  try {
    const raw = localStorage.getItem(PORTAL_WEB_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.supabaseUrl && d.supabaseAnonKey) return { url: d.supabaseUrl, key: d.supabaseAnonKey };
    }
    const creds = localStorage.getItem('portalCreds');
    if (creds) {
      const { supabaseUrl, supabaseAnonKey } = JSON.parse(creds);
      if (supabaseUrl && supabaseAnonKey) return { url: supabaseUrl, key: supabaseAnonKey };
    }
  } catch {}
  return null;
}

// ─── GoogleAuthGate ───────────────────────────────────────────────────────────

function GoogleAuthGate({ onVerified }: { onVerified: () => void }) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  const sbUrl = ENV_SUPABASE_URL || getSupabaseCreds()?.url || '';
  const sbKey = ENV_SUPABASE_KEY || getSupabaseCreds()?.key || '';

  function injectCreds(email: string) {
    localStorage.setItem(GOOGLE_VERIFIED_KEY, email);
    if (ENV_SUPABASE_URL && ENV_SUPABASE_KEY) {
      try {
        const existing = JSON.parse(localStorage.getItem(PORTAL_WEB_KEY) ?? '{}');
        if (!existing.supabaseUrl) {
          existing.supabaseUrl = ENV_SUPABASE_URL;
          existing.supabaseAnonKey = ENV_SUPABASE_KEY;
          localStorage.setItem(PORTAL_WEB_KEY, JSON.stringify(existing));
        }
      } catch {}
    }
  }

  // OAuth 콜백 후 세션 확인
  useEffect(() => {
    if (!sbUrl || !sbKey) { setChecking(false); return; }
    const sb = getDefaultSupabaseClient(sbUrl, sbKey);

    function check(email: string) {
      if (isEmailAllowed(email)) {
        injectCreds(email.trim());
        onVerified();
      } else if (email) {
        setChecking(false);
        setError(`접근 권한이 없습니다 (${email}) — VITE_ALLOWED_EMAIL 환경변수를 확인하세요`);
        sb.auth.signOut();
      }
    }

    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') {
        setChecking(false);
        if (session?.user?.email) check(session.user.email);
      } else if (event === 'SIGNED_IN' && session?.user?.email) {
        check(session.user.email);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleLogin() {
    if (!sbUrl || !sbKey) { setError('Supabase 설정이 없습니다'); return; }
    setLoading(true);
    setError('');
    const sb = getDefaultSupabaseClient(sbUrl, sbKey);
    const { error: err } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/' },
    });
    if (err) { setError(err.message); setLoading(false); }
  }

  return (
    <div className="portal-login-shell">
      <div className="portal-login-shell__aurora" aria-hidden="true" />
      <div className="portal-login-build">
        <BuildInfoBadge />
      </div>
      <main className="portal-login-card">
        <div className="portal-login-card__brand">
          <div className="portal-brand-mark">
            <BookMarked className="h-5 w-5" />
          </div>
          <div>
            <p>AGENTS TO Z</p>
            <span>Private workspace</span>
          </div>
        </div>
        <div className="portal-login-card__intro">
          <span className="portal-eyebrow">YOUR OPERATING SPACE</span>
          <h1>흩어진 프로젝트를<br />한곳에서 이어보세요.</h1>
          <p>프로젝트, 북마크, 장기기억을 내 계정으로 안전하게 연결합니다.</p>
        </div>
        <div className="portal-login-card__features" aria-label="포털 기능">
          <span>프로젝트 현황</span><span>공유 북마크</span><span>장기기억</span>
        </div>
        {checking ? (
          <div className="portal-login-status" role="status"><RefreshCw className="h-4 w-4 animate-spin" />로그인 상태 확인 중</div>
        ) : (
          <>
            <button onClick={handleLogin} disabled={loading}
              className="portal-google-button">
              <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {loading ? 'Google로 이동 중…' : 'Google 계정으로 계속'}
            </button>
          </>
        )}
        {error && <p className="portal-login-error" role="alert">{error}</p>}
        <p className="portal-login-card__security">로그인 세션은 Supabase RLS로 보호되며, 허용된 계정만 데이터에 접근합니다.</p>
      </main>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: 'success' | 'error' }) {
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`fixed z-50 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-center gap-2 animate-slide-in ${
        type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
      }`}
      style={{top:'calc(env(safe-area-inset-top) + 1rem)',right:'calc(env(safe-area-inset-right) + 1rem)'}}
    >{message}</div>
  );
}

// ─── Ports View ───────────────────────────────────────────────────────────────

type PortFormDraft = {
  name: string;
  port: string;
  deploy_url: string;
  github_url: string;
  category: string;
  description: string;
};
const emptyDraft: PortFormDraft = { name:'', port:'', deploy_url:'', github_url:'', category:'', description:'' };

function PortsView({ deviceId, deviceIds, creds, showToast, onSwitchDevice }: {
  deviceId: string;
  deviceIds: string[];
  creds: { url: string; key: string };
  showToast: (msg: string, type: 'success' | 'error') => void;
  onSwitchDevice?: () => void;
}) {
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null); // 2단계 삭제 확인
  const [inlineEdit, setInlineEdit] = useState<{ id: string; field: 'deploy_url' | 'github_url' } | null>(null);
  const [inlineDraft, setInlineDraft] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState<PortFormDraft>(emptyDraft);
  const [showEdit, setShowEdit] = useState<{ id: string } | null>(null);
  const [editDraft, setEditDraft] = useState<PortFormDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [copiedMemoryId, setCopiedMemoryId] = useState<string | null>(null);

  // 로그인 세션(JWT)으로 쿼리한다 — RLS 정책이 authenticated 롤만 허용하기 때문.
  // device_id 격리는 여전히 앱 레벨 필터(.eq('device_id', …))가 담당한다.
  // 캐시된 싱글톤 재사용 — 매 쿼리마다 새 인스턴스 생성 방지
  const sb = useCallback(() => getSupabaseClient(creds.url, creds.key), [creds.url, creds.key]);

  /**
   * 프로젝트 행에 붙일 기억 목록. 실패해도 **행 렌더를 막지 않는다** — 기억은 곁들이는
   * 정보이고, 세션이 없으면 이 테이블만 거부되기 때문이다(포트는 anon 에게도 열려 있다).
   */
  const [memoryEntries, setMemoryEntries] = useState<MemoryDirectoryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        // 세션 복원을 기다린 뒤 쿼리한다 — 마운트 직후에 쏘면 anon 으로 나가 거부된다.
        await sb().auth.getSession();
        // 장기기억 탭과 같은 결과를 공유한다. in-flight 프라미스가 재사용되므로
        // 두 소비자 × (마운트 + INITIAL_SESSION) 4회가 1회로 접힌다.
        const loaded = await loadMemoryDirectory(`${creds.url}::${creds.key}`, () => sb()
          .from('portmgr_project_memory_revisions')
          .select(MEMORY_LIST_COLUMNS)
          .order('created_at', { ascending: false })
          .limit(MEMORY_REVISION_WINDOW), {
          headPageQuery: (afterMemoryId, limit) => sb().rpc('portmgr_list_project_memory_head_page', {
            p_after_memory_id: afterMemoryId,
            p_limit: limit,
          }),
          deviceQuery: () => sb()
              .from('portmgr_project_memory_devices')
              .select(MEMORY_DEVICE_COLUMNS)
              .order('last_seen_at', { ascending: false })
              .limit(MEMORY_REVISION_WINDOW),
            aliasQuery: () => sb().from('portmgr_project_memory_aliases').select(MEMORY_ALIAS_COLUMNS),
            labelQuery: () => sb().from('portmgr_project_memory_labels').select(MEMORY_LABEL_COLUMNS),
            mergeQuery: () => sb().from('portmgr_project_memory_merges').select(MEMORY_MERGE_COLUMNS),
            mergeDeviceQuery: () => sb().from('portmgr_project_memory_merge_devices').select(MEMORY_MERGE_DEVICE_COLUMNS),
            retirementQuery: () => sb().from('portmgr_project_memory_device_retirements').select(MEMORY_DEVICE_RETIREMENT_COLUMNS),
            deviceIdentityQuery: () => sb().from('portmgr_device_identity_aliases').select(DEVICE_IDENTITY_ALIAS_COLUMNS),
            physicalDeviceQuery: () => sb().from('portmgr_devices').select(PHYSICAL_DEVICE_COLUMNS),
            remoteDeviceQuery: () => sb().from('portmgr_remote_devices').select(REMOTE_MEMORY_DEVICE_COLUMNS),
            remoteProjectQuery: () => sb().from('portmgr_remote_device_projects').select(REMOTE_MEMORY_PROJECT_COLUMNS),
            trashQuery: () => sb().from('portmgr_project_memory_trash').select(MEMORY_TRASH_COLUMNS),
          });
        if (!cancelled) setMemoryEntries(loaded.entries.filter(entry => !entry.trashedAt));
      } catch {
        // 기억은 곁들이는 정보다 — 실패해도 프로젝트 행 렌더를 막지 않는다.
        if (!cancelled) setMemoryEntries([]);
      }
    };
    void run();
    // TOKEN_REFRESHED 는 뺀다 — 토큰이 갱신됐다고 기억 목록이 바뀌지 않는다.
    // 늦게 도착하는 로그인은 INITIAL_SESSION/SIGNED_IN 으로 충분히 처리된다.
    const { data: { subscription } } = sb().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void run();
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, [sb, creds.url, creds.key]);

  const memoryPill = (p: PortRow) => {
    const matched = matchMemoryForProject(memoryEntries, {
      memoryId: p.memory_id,
      name: p.name,
      githubUrl: githubRepositoryUrls({ githubUrl: p.github_url, githubUrls: p.github_urls })[0],
    });
    if (!matched) return null;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(matched.memoryId);
        setCopiedMemoryId(matched.memoryId);
        setTimeout(() => setCopiedMemoryId(current => (current === matched.memoryId ? null : current)), 2000);
        showToast('장기기억 ID를 복사했습니다', 'success');
      } catch {
        showToast('클립보드에 복사하지 못했습니다', 'error');
      }
    };
    return (
      <button
        data-testid="portal-row-memory-id"
        data-memory-id={matched.memoryId}
        onClick={copy}
        title={`장기기억 ID: ${matched.memoryId}\n마지막 갱신 ${matched.updatedAt ? new Date(matched.updatedAt).toLocaleString('ko-KR') : '미상'}${matched.lastDeviceName ? ` · ${matched.lastDeviceName}` : ''}\n다른 기기의 앱 「다른 기억에 합류」나 Hermes /memory_link 에 붙여넣으세요.`}
        className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border border-teal-500/25 rounded-md transition-all"
      >
        <Brain className="w-3 h-3" />
        기억 {matched.displayName ?? matched.memoryId.slice(0, 8)}
        {copiedMemoryId === matched.memoryId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    );
  };

  async function loadPorts() {
    if (!deviceId) return;
    setLoading(true);
    try {
      const { data, error } = await sb().from('portmgr_ports').select('*').in('device_id', deviceIds).order('name');
      if (error) throw error;
      setPorts(data ?? []);
    } catch (e: unknown) {
      const msg = (e as any)?.message ?? JSON.stringify(e);
      showToast('포트 로드 실패: ' + msg, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPorts();
  }, [deviceId, deviceIds.join('\0')]);

  // Draft → DB payload (빈 문자열은 null로)
  const draftToPayload = (d: PortFormDraft) => {
    const portNum = d.port.trim() ? parseInt(d.port.trim(), 10) : null;
    const githubUrls = parseGitHubRepositoryUrls(d.github_url);
    return {
      name: d.name.trim(),
      port: portNum != null && !isNaN(portNum) ? portNum : null,
      deploy_url: d.deploy_url.trim() || null,
      // Keep github_url for old desktop builds and databases; github_urls is
      // the full ordered list for current clients.
      github_url: githubUrls[0] ?? null,
      github_urls: githubUrls.length > 0 ? githubUrls : null,
      category: d.category.trim() || null,
      description: d.description.trim() || null,
    };
  };

  const rowToDraft = (p: PortRow): PortFormDraft => ({
    name: p.name ?? '',
    port: p.port != null ? String(p.port) : '',
    deploy_url: p.deploy_url ?? '',
    github_url: githubRepositoryUrlsText({ githubUrl: p.github_url, githubUrls: p.github_urls }),
    category: p.category ?? '',
    description: p.description ?? '',
  });

  async function saveInlineUrl(id: string, field: 'deploy_url' | 'github_url', value: string) {
    const trimmed = value.trim() || null;
    const githubUrls = field === 'github_url' ? parseGitHubRepositoryUrls(value) : [];
    const body = field === 'github_url'
      ? { github_url: githubUrls[0] ?? null, github_urls: githubUrls.length > 0 ? githubUrls : null }
      : { deploy_url: trimmed };
    setPorts(prev => prev.map(p => p.id === id ? { ...p, ...body } : p));
    try {
      let { error } = await sb().from('portmgr_ports').update(body).eq('id', id);
      if (isMissingGithubUrlsColumnError(error)) {
        ({ error } = await sb().from('portmgr_ports').update({ github_url: githubUrls[0] ?? null }).eq('id', id));
        if (!error) showToast('GitHub 추가 주소 DB 컬럼이 없어 첫 주소만 동기화했습니다. 마이그레이션 후 다시 저장하세요.', 'error');
      }
      if (error) throw error;
      showToast(`${field === 'deploy_url' ? '배포 주소' : 'GitHub 저장소 주소'} 저장됨 ✓`, 'success');
    } catch (e: any) {
      showToast('저장 실패: ' + (e?.message ?? e), 'error');
      loadPorts();
    }
  }

  async function createProject() {
    const payload = draftToPayload(addDraft);
    if (!payload.name) { showToast('이름은 필수입니다', 'error'); return; }
    setSubmitting(true);
    try {
      const newId = crypto.randomUUID();
      const body: any = { ...payload, id: newId, device_id: deviceId };
      let writeBody = body;
      let { error } = await sb().from('portmgr_ports').insert(writeBody);
      if (isMissingGithubUrlsColumnError(error)) {
        const { github_urls, ...rest } = writeBody;
        writeBody = rest;
        ({ error } = await sb().from('portmgr_ports').insert(writeBody));
        if (!error) showToast('GitHub 추가 주소 DB 컬럼이 없어 첫 주소만 동기화했습니다. 마이그레이션 후 다시 저장하세요.', 'error');
      }
      // 구버전 스키마 폴백 — category/description 컬럼이 없는 DB에서도 저장은 되게 한다
      if (isMissingOptionalColumnError(error)) {
        const { category, description, ...rest } = writeBody;
        ({ error } = await sb().from('portmgr_ports').insert(rest));
        if (!error) showToast('카테고리/설명 컬럼이 없어 저장하지 않았습니다. 마이그레이션 후 다시 시도하세요', 'error');
      }
      if (error) throw error;
      setAddDraft(emptyDraft);
      setShowAdd(false);
      showToast(`'${payload.name}' 추가됨 ✓`, 'success');
      await loadPorts();
    } catch (e: any) {
      showToast('추가 실패: ' + (e?.message ?? e), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function updateProject() {
    if (!showEdit) return;
    const payload = draftToPayload(editDraft);
    if (!payload.name) { showToast('이름은 필수입니다', 'error'); return; }
    setSubmitting(true);
    try {
      const body: any = payload;
      let writeBody = body;
      let { error } = await sb().from('portmgr_ports').update(writeBody).eq('id', showEdit.id);
      if (isMissingGithubUrlsColumnError(error)) {
        const { github_urls, ...rest } = writeBody;
        writeBody = rest;
        ({ error } = await sb().from('portmgr_ports').update(writeBody).eq('id', showEdit.id));
        if (!error) showToast('GitHub 추가 주소 DB 컬럼이 없어 첫 주소만 동기화했습니다. 마이그레이션 후 다시 저장하세요.', 'error');
      }
      if (isMissingOptionalColumnError(error)) {
        const { category, description, ...rest } = writeBody;
        ({ error } = await sb().from('portmgr_ports').update(rest).eq('id', showEdit.id));
        if (!error) showToast('카테고리/설명 컬럼이 없어 저장하지 않았습니다. 마이그레이션 후 다시 시도하세요', 'error');
      }
      if (error) throw error;
      setShowEdit(null);
      setEditDraft(emptyDraft);
      showToast('수정됨 ✓', 'success');
      await loadPorts();
    } catch (e: any) {
      showToast('수정 실패: ' + (e?.message ?? e), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteProject(id: string) {
    setDeletingId(id);
    try {
      const { error } = await sb().from('portmgr_ports').delete().eq('id', id);
      if (error) throw error;
      showToast('삭제됨', 'success');
      setPendingDeleteId(null);
      await loadPorts();
    } catch (e: any) {
      showToast('삭제 실패: ' + (e?.message ?? e), 'error');
    } finally {
      setDeletingId(null);
    }
  }

  function openEdit(p: PortRow) {
    setEditDraft(rowToDraft(p));
    setShowEdit({ id: p.id });
  }

  if (!deviceId) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <Server className="w-10 h-10 text-zinc-700" />
      <p className="text-sm text-zinc-500">기기를 선택하세요</p>
    </div>
  );

  // ── Inline URL pill: 빈 값은 placeholder, 값 있으면 외부 링크 + 펜슬 ──
  const inlineUrlPill = (p: PortRow, field: 'deploy_url' | 'github_url') => {
    const value = p[field];
    const editing = inlineEdit?.id === p.id && inlineEdit?.field === field;
    const isDeploy = field === 'deploy_url';
    const label = isDeploy ? '배포' : 'GitHub';
    const Icon = isDeploy ? ExternalLink : Github;
    const values = isDeploy
      ? (value ? [value] : [])
      : githubRepositoryUrls({ githubUrl: p.github_url, githubUrls: p.github_urls });
    const displayValue = isDeploy ? value ?? '' : values.join('\n');
    const baseCls = isDeploy
      ? 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border-blue-500/20'
      : 'bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border-zinc-700/50';
    if (editing) {
      return (
        <div className="flex items-center gap-1">
          {isDeploy ? (
            <input
              autoFocus type="url" value={inlineDraft}
              onChange={e => setInlineDraft(e.target.value)}
              onBlur={() => {
                if (inlineDraft.trim() !== displayValue) saveInlineUrl(p.id, field, inlineDraft);
                setInlineEdit(null);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (inlineDraft.trim() !== displayValue) saveInlineUrl(p.id, field, inlineDraft);
                  setInlineEdit(null);
                } else if (e.key === 'Escape') setInlineEdit(null);
              }}
              placeholder="https://..." style={{ fontSize: 16 }}
              className="w-44 sm:w-56 px-2 py-1 bg-zinc-950 border border-zinc-600 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500"
            />
          ) : (
            <textarea
              autoFocus value={inlineDraft}
              onChange={e => setInlineDraft(e.target.value)}
              onBlur={() => {
                if (githubRepositoryUrlsText({ githubUrl: inlineDraft }) !== displayValue) saveInlineUrl(p.id, field, inlineDraft);
                setInlineEdit(null);
              }}
              onKeyDown={e => { if (e.key === 'Escape') setInlineEdit(null); }}
              placeholder="GitHub 저장소 주소 · 한 줄에 하나씩" rows={2}
              style={{ fontSize: 16 }}
              className="w-52 sm:w-64 px-2 py-1 bg-zinc-950 border border-zinc-600 rounded-md text-zinc-200 focus:outline-none focus:border-blue-500 resize-y"
            />
          )}
        </div>
      );
    }
    if (values.length > 0) {
      return (
        <div className="flex items-center gap-0.5">
          {values.map((url, index) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer"
              title={url}
              className={`flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] border rounded-md transition-all ${baseCls}`}>
              <Icon className="w-2.5 h-2.5" />{values.length > 1 && !isDeploy ? `${label} ${index + 1}` : label}
            </a>
          ))}
          <button
            onClick={() => { setInlineEdit({ id: p.id, field }); setInlineDraft(displayValue); }}
            title={`${label} 수정`}
            className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
          ><Pencil className="w-2.5 h-2.5" /></button>
        </div>
      );
    }
    return (
      <button
        onClick={() => { setInlineEdit({ id: p.id, field }); setInlineDraft(''); }}
        title={`${label} 추가`}
        className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-zinc-900/40 hover:bg-zinc-800/60 text-zinc-500 hover:text-zinc-300 border border-dashed border-zinc-700/50 rounded-md transition-all"
      >
        <Plus className="w-2.5 h-2.5" />{label}
      </button>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-500">{ports.length}개 포트</p>
        <div className="flex items-center gap-1.5">
          <button onClick={() => { setAddDraft(emptyDraft); setShowAdd(true); }}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg transition-colors">
            <Plus className="w-3 h-3" />프로젝트
          </button>
          <button onClick={loadPorts} disabled={loading}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="프로젝트 검색..."
          className="w-full pl-8 pr-3 py-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded-lg text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </div>

      {!loading && ports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Server className="w-10 h-10 text-zinc-700" />
          <p className="text-sm text-zinc-500">등록된 포트가 없습니다</p>
          <p className="text-xs text-zinc-600">로컬 앱에서 Push하거나 위 '+ 프로젝트'로 추가하세요</p>
          <p className="text-[10px] text-zinc-700 font-mono">device: {deviceId?.slice(0,8)}… / url: {creds.url.replace('https://','').slice(0,20)}</p>
          {onSwitchDevice && (
            <button onClick={e => {
              // 루트 컨테이너의 click-away 핸들러가 이 클릭까지 받아, 방금 연 픽커를
              // 같은 배치에서 닫아 버린다. 버튼이 자기 클릭을 책임진다.
              e.stopPropagation();
              onSwitchDevice();
            }}
              className="mt-2 px-3 py-1.5 text-xs text-blue-400 border border-blue-500/30 rounded-lg hover:bg-blue-500/10 transition-colors">
              다른 기기 선택
            </button>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" />
        </div>
      ) : (
        <div className="divide-y divide-zinc-800/60">
          {ports.filter(p => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            return (p.name?.toLowerCase().includes(q)
              || String(p.port ?? '').includes(q)
              || p.folder_path?.toLowerCase().includes(q)
              || githubRepositoryUrls({ githubUrl: p.github_url, githubUrls: p.github_urls })
                .some(url => url.toLowerCase().includes(q)));
          }).map(p => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 sm:gap-3 py-3 px-1 hover:bg-zinc-800/30 rounded-lg transition-colors group">
              <div className="flex-1 min-w-[120px]">
                <span className="text-sm text-zinc-200 font-medium truncate block">{p.name}</span>
                <div className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono mt-0.5">
                  {p.port && <span>:{p.port}</span>}
                  {p.category && <span className="text-zinc-500">· {p.category}</span>}
                </div>
              </div>
              {/* shrink-0 금지 — 랩핑 flex 의 max-content 가 "한 줄 전체 폭"으로 굳어
                  안쪽 flex-wrap 이 발동하지 못하고 390px 에서 행 밖으로 넘쳐
                  문서 전체에 가로 스크롤이 생긴다. */}
              {/* 모바일에서 gap 을 벌린다 — 수정/삭제가 6px 간격이면 버튼을 키워도
                  "취소하려다 삭제"가 남는다. 간격이 오탭에 가장 직접적이다. */}
              <div className="flex items-center gap-3 sm:gap-1.5 flex-wrap">
                {inlineUrlPill(p, 'deploy_url')}
                {inlineUrlPill(p, 'github_url')}
                {memoryPill(p)}
                <button
                  onClick={() => openEdit(p)}
                  title="수정"
                  className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-md transition-all"
                >
                  <Pencil className="w-2.5 h-2.5" />수정
                </button>
                {pendingDeleteId === p.id ? (
                  <>
                    <button
                      onClick={() => deleteProject(p.id)}
                      disabled={deletingId === p.id}
                      className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-red-500/30 hover:bg-red-500/50 text-red-200 border border-red-500/50 rounded-md transition-all disabled:opacity-50"
                    >
                      <Check className="w-2.5 h-2.5" />확인
                    </button>
                    <button
                      onClick={() => setPendingDeleteId(null)}
                      className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 border border-zinc-700/50 rounded-md transition-all"
                    >취소</button>
                  </>
                ) : (
                  <button
                    onClick={() => setPendingDeleteId(p.id)}
                    title="삭제"
                    className="flex items-center gap-1 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-transparent hover:bg-red-500/15 text-red-400 border border-red-500/30 rounded-md transition-all"
                  >
                    <Trash2 className="w-2.5 h-2.5" />삭제
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(showAdd || showEdit) && (
        <PortFormModal
          mode={showAdd ? 'add' : 'edit'}
          draft={showAdd ? addDraft : editDraft}
          setDraft={showAdd ? setAddDraft : setEditDraft}
          submitting={submitting}
          onSubmit={showAdd ? createProject : updateProject}
          onClose={() => { setShowAdd(false); setShowEdit(null); }}
        />
      )}
    </div>
  );
}

function RemoteProjectsView({ device, creds, showToast, onManageDevice }: {
  device: DeviceRow;
  creds: { url: string; key: string };
  showToast: (msg: string, type: 'success' | 'error') => void;
  onManageDevice: () => void;
}) {
  const [projects, setProjects] = useState<RemoteProjectPortalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedMemoryId, setCopiedMemoryId] = useState<string | null>(null);
  const sb = useCallback(() => getSupabaseClient(creds.url, creds.key), [creds.url, creds.key]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      await sb().auth.getSession();
      const result = await sb().from('portmgr_remote_device_projects')
        .select('device_id,project_path,project_name,memory_id,git_remote_url,git_head_sha,git_branch,git_dirty,present,last_observed_at,telegram_thread_id')
        .eq('device_id', device.id)
        .order('last_observed_at', { ascending: false });
      if (result.error) throw result.error;
      setProjects((result.data ?? []) as RemoteProjectPortalRow[]);
    } catch (error) {
      setProjects([]);
      showToast(`AWS 프로젝트를 불러오지 못했습니다: ${describeSupabaseError(error)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [device.id, sb, showToast]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const visibleProjects = projects.filter(project => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return project.project_name.toLowerCase().includes(query)
      || project.project_path.toLowerCase().includes(query)
      || project.git_remote_url?.toLowerCase().includes(query)
      || project.memory_id?.toLowerCase().includes(query);
  });

  async function copyMemoryId(memoryId: string) {
    try {
      await navigator.clipboard.writeText(memoryId);
      setCopiedMemoryId(memoryId);
      setTimeout(() => setCopiedMemoryId(current => current === memoryId ? null : current), 2000);
      showToast('장기기억 ID를 복사했습니다', 'success');
    } catch {
      showToast('클립보드에 복사하지 못했습니다', 'error');
    }
  }

  return (
    <div data-testid="portal-remote-projects-view" className="min-w-0 overflow-hidden">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
            <Cloud className="h-4 w-4 shrink-0 text-emerald-400" />
            <span className="truncate">{device.name}</span>
            <span className="shrink-0 text-xs font-normal text-zinc-400">· {device.environmentLabel}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-400">원격 에이전트가 확인한 프로젝트 · 수정은 해당 서버 또는 단말 관리에서 진행합니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onManageDevice} className="min-h-11 rounded-lg border border-emerald-700/60 px-3 py-2 text-[11px] text-emerald-300 hover:bg-emerald-500/10">AWS 프로젝트 추가·관리</button>
          <button aria-label="AWS 프로젝트 새로고침" onClick={() => void loadProjects()} disabled={loading} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="AWS 프로젝트 검색..." className="min-h-11 w-full rounded-lg border border-zinc-800/60 bg-zinc-900/60 pl-8 pr-3 py-2 text-xs text-zinc-300 outline-none placeholder-zinc-600 focus:border-zinc-600" />
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-20"><RefreshCw className="h-5 w-5 animate-spin text-zinc-500" /></div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <Cloud className="h-10 w-10 text-zinc-700" />
          <p className="text-sm text-zinc-500">보고된 AWS 프로젝트가 없습니다</p>
          <button onClick={onManageDevice} className="min-h-11 rounded-lg border border-emerald-700/60 px-3 py-2 text-xs text-emerald-300">단말 관리에서 프로젝트 추가</button>
        </div>
      ) : visibleProjects.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500">검색 결과가 없습니다</p>
      ) : (
        <div className="divide-y divide-zinc-800/60">
          {visibleProjects.map(project => {
            const githubUrl = project.git_remote_url ? normalizeGitHubRepositoryUrl(project.git_remote_url) : null;
            return <div key={project.project_path} className={`rounded-lg px-1 py-3 ${project.present ? 'hover:bg-zinc-800/30' : 'opacity-65'}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-[160px] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-200">{project.project_name}</span>
                    <span className={`shrink-0 text-[11px] ${project.present ? project.git_dirty ? 'text-amber-300' : 'text-emerald-400' : 'text-amber-400'}`}>
                      {project.present ? project.git_dirty ? '변경 있음' : '확인됨' : '현재 없음·이력 보관'}
                    </span>
                  </div>
                  <p title={project.project_path} className="mt-1 truncate font-mono text-[11px] text-zinc-400">{project.project_path}</p>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    {project.git_head_sha ? `${project.git_branch || 'HEAD'} ${project.git_head_sha.slice(0, 8)}` : 'Git 커밋 없음'}
                    {' · '}{new Date(project.last_observed_at).toLocaleString('ko-KR')}
                  </p>
                  {project.telegram_thread_id && <p className="mt-1 text-[11px] text-sky-300">Telegram 토픽 #{project.telegram_thread_id}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {githubUrl && <a href={githubUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1 rounded-md border border-zinc-700/60 bg-zinc-800/60 px-3 py-2 text-[11px] text-zinc-300"><Github className="h-3 w-3" />GitHub</a>}
                  {project.memory_id && <button onClick={() => void copyMemoryId(project.memory_id!)} className="flex min-h-11 items-center gap-1 rounded-md border border-teal-500/25 bg-teal-500/10 px-3 py-2 text-[11px] text-teal-300"><Brain className="h-3 w-3" />기억 {project.memory_id.slice(0, 8)}{copiedMemoryId === project.memory_id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}</button>}
                </div>
              </div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}

function PortFormModal({ mode, draft, setDraft, submitting, onSubmit, onClose }: {
  mode: 'add' | 'edit';
  draft: PortFormDraft;
  setDraft: (d: PortFormDraft) => void;
  submitting: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const update = <K extends keyof PortFormDraft>(k: K, v: string) => setDraft({ ...draft, [k]: v });
  const inpCls = 'w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500';
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[88vh] overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900">
          <span className="text-sm font-semibold text-white">{mode === 'add' ? '프로젝트 추가' : '프로젝트 수정'}</span>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3" style={{ fontSize: 14 }}>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">이름 *</span>
            <input
              autoFocus type="text" value={draft.name}
              onChange={e => update('name', e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && draft.name.trim()) onSubmit(); else if (e.key === 'Escape') onClose(); }}
              placeholder="프로젝트 이름"
              style={{ fontSize: 16 }}
              className={inpCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">포트 (선택)</span>
            <input
              type="number" inputMode="numeric" value={draft.port}
              onChange={e => update('port', e.target.value)}
              placeholder="예: 3000"
              style={{ fontSize: 16 }}
              className={inpCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">배포 주소 (선택)</span>
            <input
              type="url" value={draft.deploy_url}
              onChange={e => update('deploy_url', e.target.value)}
              placeholder="https://..."
              style={{ fontSize: 16 }}
              className={inpCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">GitHub 저장소 주소 (선택 · 한 줄에 하나씩)</span>
            <textarea
              value={draft.github_url}
              onChange={e => update('github_url', e.target.value)}
              placeholder={'https://github.com/owner/repo\nhttps://github.com/owner/another-repo'}
              rows={2}
              style={{ fontSize: 16 }}
              className={`${inpCls} resize-y leading-relaxed`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">카테고리 (선택)</span>
            <input
              type="text" value={draft.category}
              onChange={e => update('category', e.target.value)}
              placeholder="예: 프로젝트, 도구, 실험"
              style={{ fontSize: 16 }}
              className={inpCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-zinc-400 mb-1 block">설명 (선택)</span>
            <input
              type="text" value={draft.description}
              onChange={e => update('description', e.target.value)}
              placeholder="한 줄 설명"
              style={{ fontSize: 16 }}
              className={inpCls}
            />
          </label>
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2 sticky bottom-0 bg-zinc-900">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 border border-zinc-700 rounded-md hover:bg-zinc-800 transition-colors"
          >취소</button>
          <button
            onClick={onSubmit}
            disabled={!draft.name.trim() || submitting}
            className="px-5 py-2 text-sm font-medium text-zinc-950 bg-emerald-400 hover:bg-emerald-300 rounded-md transition-colors disabled:bg-emerald-700 disabled:text-zinc-500 disabled:cursor-not-allowed"
          >{submitting ? '저장 중...' : (mode === 'add' ? '추가' : '저장')}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Device Manager Modal ─────────────────────────────────────────────────────

function DeviceManagerModal({ devices, creds, onClose, onUpdate, showToast }: {
  devices: DeviceRow[];
  creds: { url: string; key: string };
  onClose: () => void;
  onUpdate: (devices: DeviceRow[]) => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDesktopPairing, setShowDesktopPairing] = useState(false);
  const [desktopDeviceName, setDesktopDeviceName] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [remoteActiveCount, setRemoteActiveCount] = useState(0);

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const sb = getDefaultSupabaseClient(creds.url, creds.key);
      const current = devices.find(device => device.id === id);
      const { error } = await sb.from('portmgr_devices').upsert({
        id,
        name: editName.trim(),
        last_push_at: current?.last_push_at || null,
      }, { onConflict: 'id' });
      if (error) throw error;
      onUpdate(devices.map(d => d.id === id ? { ...d, name: editName.trim() } : d));
      setEditingId(null);
    } catch (e) {
      alert('저장 실패: ' + String(e));
    } finally {
      setSaving(false);
    }
  }

  async function copyDesktopPairing() {
    if (!desktopDeviceName.trim()) return;
    setPairingBusy(true);
    try {
      const invite = createDesktopDeviceInvite({
        supabaseUrl: creds.url,
        supabaseAnonKey: creds.key,
        suggestedDeviceName: desktopDeviceName,
      });
      await navigator.clipboard.writeText(invite);
      showToast('Mac·Windows 연결 정보를 복사했습니다. 새 단말 앱의 「추가 단말 연결」에 붙여넣으세요.', 'success');
      setDesktopDeviceName('');
      setShowDesktopPairing(false);
    } catch (error) {
      showToast(`연결 정보 복사 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setPairingBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[88vh] overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div>
            <span className="text-sm font-semibold text-white">기기 관리 · 사용 중 {devices.length + remoteActiveCount}대</span>
            <p className="mt-0.5 text-[10px] text-zinc-400">대표 단말만 셉니다. 재설치 ID와 원시 호스트명은 각 단말의 이력으로 묶입니다.</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="border-b border-zinc-800 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Mac·Windows · {devices.length}대</div>
        <div className="max-h-80 overflow-y-auto divide-y divide-zinc-800">
          {devices.length === 0 ? (
            <div className="px-4 py-6 text-xs text-zinc-500 text-center">등록된 기기가 없습니다</div>
          ) : devices.map(d => (
            <div key={d.id} className="px-4 py-3 flex items-center gap-2">
              {editingId === d.id ? (
                <>
                  <input
                    className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(d.id); if (e.key === 'Escape') setEditingId(null); }}
                    autoFocus
                  />
                  <button onClick={() => saveEdit(d.id)} disabled={saving}
                    className="shrink-0 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors">저장</button>
                  <button onClick={() => setEditingId(null)}
                    className="shrink-0 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] text-zinc-500 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors">취소</button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-200 truncate">{d.name ?? d.id.slice(0, 8)}</p>
                    <p className="mt-0.5 text-[10px] text-zinc-400">
                      프로젝트 {d.projectCount}개 · {formatDeviceLastPushAt(d.last_push_at)}
                    </p>
                    {d.projectNames.length > 0 && <p className="mt-0.5 truncate text-[10px] text-zinc-500" title={d.projectNames.join(', ')}>{d.projectNames.slice(0, 4).join(' · ')}{d.projectNames.length > 4 ? ` 외 ${d.projectNames.length - 4}개` : ''}</p>}
                    {d.sourceIds.length > 1 && <p className="mt-0.5 text-[10px] text-sky-400">같은 단말의 이전 ID {d.sourceIds.length - 1}개 연결됨</p>}
                  </div>
                  <button onClick={() => { setEditingId(d.id); setEditName(d.name ?? ''); }}
                    className="shrink-0 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors flex items-center gap-1">
                    <Pencil className="w-3 h-3" />편집
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <section className="border-t border-zinc-800 px-4 py-3" aria-label="Mac·Windows 연결">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200"><Monitor className="h-3.5 w-3.5 text-blue-400" />Mac·Windows 연결</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-400">포털은 연결 정보만 전달합니다. 앱이 연결을 완료할 때 새 단말 ID와 DB 행이 등록됩니다.</p>
            </div>
            <button onClick={() => setShowDesktopPairing(value => !value)} className="min-h-11 shrink-0 rounded-md border border-blue-700/70 px-2.5 py-1.5 text-[11px] text-blue-300 hover:bg-blue-500/10">
              {showDesktopPairing ? '닫기' : '+ 연결 정보 만들기'}
            </button>
          </div>
          {showDesktopPairing && (
            <div className="mt-3 space-y-2 rounded-lg border border-blue-900/50 bg-blue-950/10 p-3">
              <ol className="list-decimal space-y-1 pl-4 text-[10px] leading-relaxed text-zinc-400">
                <li>새 Mac·Windows에 AgentsToZ 앱을 설치하고 엽니다.</li>
                <li><span className="text-zinc-200">초기 설정 → 두 번째·추가 기기 연결</span>을 선택합니다.</li>
                <li>아래 연결 정보를 복사해 새 PC에 전달하고 앱에서 붙여넣습니다.</li>
                <li>새 PC에서만 Supabase CLI 로그인을 한 번 확인하면 앱이 새 ID로 등록합니다.</li>
              </ol>
              <label className="block text-[11px] text-zinc-400">새 단말 이름
                <input value={desktopDeviceName} onChange={event => setDesktopDeviceName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void copyDesktopPairing(); }} placeholder="예: 회사 Windows, 집 MacBook" autoFocus className="mt-1 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-blue-500" />
              </label>
              <p className="text-[10px] leading-relaxed text-zinc-400">공개 Project URL·anon key만 전달하며 service_role 키, 로그인 토큰, 기존 단말 ID는 포함하지 않습니다.</p>
              <button onClick={() => void copyDesktopPairing()} disabled={pairingBusy || !desktopDeviceName.trim()} className="min-h-11 w-full rounded-lg bg-blue-500 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40">
                {pairingBusy ? '복사 중…' : '연결 정보 복사'}
              </button>
            </div>
          )}
        </section>
        <RemoteDeviceManager
          compact
          supabaseUrl={creds.url}
          supabaseKey={creds.key}
          showToast={showToast}
          onActiveDeviceCount={setRemoteActiveCount}
        />
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [pwOk, setPwOk] = useState(isGoogleVerified);
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'error' }[]>([]);
  const [openSettings, setOpenSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(
    () => readInitialSelectedDeviceId() ? 'ports' : 'bookmarks'
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? 'auto'
  );
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(
    readInitialSelectedDeviceId
  );
  const [deviceSelectionMode, setDeviceSelectionMode] = useState<PortalDeviceSelectionMode>(
    () => normalizePortalDeviceSelectionMode(localStorage.getItem(DEVICE_SELECTION_MODE_KEY))
  );
  const [defaultDeviceId, setDefaultDeviceId] = useState(
    () => localStorage.getItem(DEFAULT_DEVICE_KEY) ?? ''
  );
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const [showDeviceManager, setShowDeviceManager] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPortsHistory, setShowPortsHistory] = useState(false);
  const [portsHistoryList, setPortsHistoryList] = useState<PushSnapshot[]>([]);
  const [portsHistoryLoading, setPortsHistoryLoading] = useState(false);
  const [bookmarkSyncState, setBookmarkSyncState] = useState({ isSyncing: false, isRestoring: false });
  const actionsRef = useRef<PortalActions | null>(null);
  const creds = getSupabaseCreds();

  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // 예전에는 여기서 "조회 선택"을 이 브라우저의 신원(portalData_v1.deviceId)에 덮어썼다.
  // 그 결과 다른 기기를 한 번 보면 신원이 그 기기가 되어, Push 가 남의 기기 행을
  // 갱신·개명했다. 신원은 src/portalDeviceIdentity.ts 한 곳이 소유한다 — 동기화하지 않는다.

  // `full` is a saved preference, not permission to squeeze the desktop sidebar
  // into a phone viewport. Keep the preference untouched so widening the same
  // window restores full mode, but force the compact shell below the CSS
  // desktop breakpoint where the layout toggle is intentionally hidden.
  const isFullLayout = windowWidth >= 768
    && (viewMode === 'full' || (viewMode === 'auto' && windowWidth >= 1024));

  /** 탭 버튼 묶음. 헤더 첫 줄(lg 이상)과 둘째 줄(lg 미만) 두 곳에서 같은 것을 쓴다. */
  const tabsEl = (['ports', 'bookmarks', 'memories'] as Tab[]).map(tab => (
    <button key={tab} onClick={() => setActiveTab(tab)}
      aria-current={activeTab === tab ? 'page' : undefined}
      className={`portal-nav-tab ${activeTab === tab ? 'is-active' : ''}`}>
      {tab === 'memories' ? <Brain className="w-3 h-3" /> : tab === 'bookmarks' ? <BookMarked className="w-3 h-3" /> : <Server className="w-3 h-3" />}
      {tab === 'memories' ? '장기기억' : tab === 'bookmarks' ? '북마크' : '프로젝트·폴더'}
    </button>
  ));

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);

  async function loadDevices() {
    if (!creds) return;
    try {
      const sb = getSupabaseClient(creds.url, creds.key);
      // 세션 복원을 기다린 뒤 조회한다 — 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로
      // 나가고, RLS 가 걸린 테이블은 오류가 아니라 **조용히 0행**을 돌려준다.
      await sb.auth.getSession();
      const [deviceResult, rootResult, portResult, aliasResult, remoteDeviceResult, remoteProjectResult] = await Promise.all([
        sb.from('portmgr_devices').select('id,name,last_push_at').order('last_push_at', { ascending: false }),
        sb.from('portmgr_workspace_roots').select('device_id,name,path').not('device_id', 'is', null),
        sb.from('portmgr_ports').select('id,device_id,device_name,name').not('device_id', 'is', null),
        sb.from('portmgr_device_identity_aliases').select('alias_device_id,canonical_device_id'),
        sb.from('portmgr_remote_devices').select('device_id,display_name,environment_kind,last_seen_at,revoked_at'),
        sb.from('portmgr_remote_device_projects').select('device_id,project_name,present'),
      ]);
      const { data: devRows, error: devError } = deviceResult;
      // 거부를 삼키면 "기기가 없습니다. 앱에서 Push하면 등록됩니다"라는 **거짓 진단**이
      // 뜨고, 사용자는 있지도 않은 문제를 고치려 든다. 사실대로 알린다.
      if (devError) {
        setDevices([]);
        showToast(`기기 목록을 불러오지 못했습니다: ${describeSupabaseError(devError)}`, 'error');
        return;
      }
      if (rootResult.error) throw rootResult.error;
      if (portResult.error) throw portResult.error;
      // 별칭 테이블이 없는 아주 오래된 배포는 독립 ID 목록으로 계속 연다.
      const desktopList: DeviceRow[] = buildPortalDesktopInventory({
        devices: devRows ?? [],
        projects: portResult.data ?? [],
        workspaceRoots: rootResult.data ?? [],
        aliases: aliasResult.error ? [] : (aliasResult.data ?? []),
      }).map(device => ({ ...device, kind: 'desktop' }));
      const remoteList: DeviceRow[] = remoteDeviceResult.error || remoteProjectResult.error
        ? []
        : buildPortalRemoteInventory({
            devices: remoteDeviceResult.data ?? [],
            projects: remoteProjectResult.data ?? [],
          });
      if (remoteDeviceResult.error || remoteProjectResult.error) {
        showToast(`AWS 단말 목록을 불러오지 못했습니다: ${describeSupabaseError(remoteDeviceResult.error || remoteProjectResult.error)}`, 'error');
      }
      const list = [...desktopList, ...remoteList];

      setDevices(list);
      // 조회 선택의 표시 이름만 보정한다. portalData_v1.deviceName 은 이
      // 브라우저 자체 신원이라 남의 기기를 조회한 이름으로 덮어쓰면 안 된다.
      const storedId = localStorage.getItem(SELECTED_DEVICE_KEY);
      if (storedId) {
        const matched = list.find(d => d.id === storedId || d.sourceIds.includes(storedId));
        if (matched?.name) {
          localStorage.setItem(SELECTED_DEVICE_NAME_KEY, matched.name);
          if (matched.id !== storedId) {
            localStorage.setItem(SELECTED_DEVICE_KEY, matched.id);
            setSelectedDeviceId(matched.id);
          }
        }
      }
      const resolution = resolvePortalDeviceSelection({
        mode: deviceSelectionMode,
        lastViewedDeviceId: localStorage.getItem(SELECTED_DEVICE_KEY) ?? '',
        fixedDeviceId: localStorage.getItem(DEFAULT_DEVICE_KEY) ?? '',
        devices: list,
      });
      setSelectedDeviceId(resolution.selectedDeviceId);
      if (resolution.selectedDeviceId) {
        const resolved = list.find(device => device.id === resolution.selectedDeviceId);
        if (resolved) localStorage.setItem(SELECTED_DEVICE_NAME_KEY, resolved.name);
      }
      if (resolution.shouldOpenPicker) setShowDevicePicker(true);
      // 저장된 기기가 있으면 activeTab의 초기값이 이미 ports다. 여기서 비동기 조회 완료 후
      // 다시 ports로 강제하면 그 사이 사용자가 누른 장기기억/북마크 탭을 덮어쓴다.
    } catch (e) {
      showToast('기기 목록 조회 실패: ' + String(e), 'error');
    }
  }

  useEffect(() => { if (pwOk) loadDevices(); }, [pwOk, creds?.url]);

  // Auto-open settings when no Supabase credentials (fresh/incognito browser)
  useEffect(() => {
    if (pwOk && !creds) setOpenSettings(true);
  }, [pwOk]);

  /** 조회 선택만 바꾼다. **이 브라우저의 신원은 건드리지 않는다** — 남의 기기를 보는 것이
   * 내가 그 기기가 된다는 뜻은 아니다. Mac/Windows 신원은 해당 로컬 앱이 확정한다. */
  function selectDevice(id: string, name?: string, autoSwitch = true) {
    setSelectedDeviceId(id);
    try {
      localStorage.setItem(SELECTED_DEVICE_KEY, id);
      if (name) localStorage.setItem(SELECTED_DEVICE_NAME_KEY, name);
    } catch { /* 저장 실패는 이번 세션에만 영향 */ }
    setShowDevicePicker(false);
    if (autoSwitch) setActiveTab('ports');
  }

  function changeDeviceSelectionMode(mode: PortalDeviceSelectionMode) {
    setDeviceSelectionMode(mode);
    localStorage.setItem(DEVICE_SELECTION_MODE_KEY, mode);
    if (mode === 'none') {
      setSelectedDeviceId('');
      setShowDevicePicker(false);
      return;
    }
    if (mode === 'fixed' && !defaultDeviceId && selectedDeviceId) {
      setDefaultDeviceId(selectedDeviceId);
      localStorage.setItem(DEFAULT_DEVICE_KEY, selectedDeviceId);
      showToast('현재 단말을 기본 단말로 지정했습니다', 'success');
      return;
    }
    const resolution = resolvePortalDeviceSelection({
      mode,
      lastViewedDeviceId: localStorage.getItem(SELECTED_DEVICE_KEY) ?? '',
      fixedDeviceId: localStorage.getItem(DEFAULT_DEVICE_KEY) ?? '',
      devices,
    });
    setSelectedDeviceId(resolution.selectedDeviceId);
    if (resolution.shouldOpenPicker) setShowDevicePicker(true);
  }

  function makeDefaultDevice(device: DeviceRow) {
    setDefaultDeviceId(device.id);
    setDeviceSelectionMode('fixed');
    localStorage.setItem(DEFAULT_DEVICE_KEY, device.id);
    localStorage.setItem(DEVICE_SELECTION_MODE_KEY, 'fixed');
    selectDevice(device.id, device.name);
    showToast(`${device.name}을(를) 기본 단말로 지정했습니다`, 'success');
  }

  async function openPortsHistory() {
    if (!creds || !selectedDeviceId) {
      showToast('기기를 먼저 선택하세요', 'error');
      return;
    }
    if (devices.find(device => device.id === selectedDeviceId)?.kind === 'remote') {
      showToast('AWS 프로젝트 이력은 각 프로젝트의 마지막 확인 시각과 Git 상태로 표시됩니다.', 'error');
      return;
    }
    setShowPortsHistory(true);
    setPortsHistoryLoading(true);
    try {
      const sb = getDefaultSupabaseClient(creds.url, creds.key);
      const list = await fetchPushHistory(sb, 'portmgr_ports', selectedDeviceId);
      setPortsHistoryList(list);
    } catch (e) {
      showToast(`히스토리를 읽지 못했습니다: ${describeSupabaseError(e)}`, 'error');
    } finally {
      setPortsHistoryLoading(false);
    }
  }

  function cycleViewMode() {
    const next: ViewMode = viewMode === 'auto' ? 'full' : viewMode === 'full' ? 'compact' : 'auto';
    setViewMode(next);
    localStorage.setItem(VIEW_MODE_KEY, next);
  }

  if (!pwOk) return <GoogleAuthGate onVerified={() => setPwOk(true)} />;

  const selectedDevice = devices.find(d => d.id === selectedDeviceId);

  const viewModeIcon = viewMode === 'full'
    ? <Monitor className="w-3.5 h-3.5" />
    : viewMode === 'compact'
    ? <Smartphone className="w-3.5 h-3.5" />
    : <RefreshCw className="w-3.5 h-3.5" />;

  const devicePickerEl = (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setShowDevicePicker(s => !s)}
        className="flex min-h-11 items-center gap-1.5 px-2.5 py-1.5 text-xs bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border border-zinc-700/50 rounded-lg transition-all max-w-[180px]"
      >
        <Server className="w-3 h-3 shrink-0 text-zinc-500" />
        <span className="truncate text-zinc-500 shrink-0 hidden sm:inline">프로젝트 기기:</span>
        <span className="truncate">{selectedDevice?.name ?? '기기 선택'}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-zinc-600" />
      </button>
      {showDevicePicker && (
        <div className="absolute top-full mt-1 left-0 z-50 w-72 max-w-[calc(100vw-32px)] bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl overflow-hidden">
          <div className="px-3 py-2 text-[10px] text-zinc-500 border-b border-zinc-800 flex items-center justify-between">
            <span>어떤 단말의 프로젝트를 볼까요?</span>
            <div className="flex items-center gap-2">
              <button onClick={() => { setShowDevicePicker(false); setShowDeviceManager(true); }}
                className="flex min-h-11 min-w-11 items-center justify-center text-zinc-600 hover:text-zinc-300 text-[10px] transition-colors">기기 관리</button>
              <button aria-label="기기 목록 새로고침" onClick={loadDevices} className="flex min-h-11 min-w-11 items-center justify-center text-zinc-600 hover:text-zinc-400 transition-colors">
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="border-b border-zinc-800 px-3 py-2.5">
            <label className="flex items-center justify-between gap-3 text-[11px] text-zinc-400">
              <span className="shrink-0">시작 단말</span>
              <select
                data-testid="portal-device-selection-mode"
                aria-label="포털 시작 단말 정책"
                value={deviceSelectionMode}
                onChange={event => changeDeviceSelectionMode(event.target.value as PortalDeviceSelectionMode)}
                className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-blue-500"
              >
                <option value="recent">마지막 조회 단말</option>
                <option value="fixed">지정한 기본 단말</option>
                <option value="none">선택하지 않음</option>
              </select>
            </label>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
              {deviceSelectionMode === 'fixed'
                ? defaultDeviceId ? `별표 단말로 시작 · ${devices.find(device => device.id === defaultDeviceId)?.name || '다시 지정 필요'}` : '목록의 별표를 눌러 기본 단말을 지정하세요.'
                : deviceSelectionMode === 'none' ? '다음 방문에는 단말을 고르지 않은 상태로 엽니다.' : '마지막으로 직접 조회한 단말을 다음 방문에도 엽니다.'}
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {devices.length === 0 ? (
              <div className="px-3 py-3 text-xs text-zinc-500">단말이 없습니다.<br />앱 Push 또는 클라우드 등록을 먼저 진행하세요.</div>
            ) : (['desktop', 'remote'] as const).map(kind => {
              const group = devices.filter(device => device.kind === kind);
              if (group.length === 0) return null;
              return <div key={kind}>
                <div className="border-b border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  {kind === 'desktop' ? `Mac·Windows · ${group.length}대` : `클라우드·서버 · ${group.length}대`}
                </div>
                {group.map(device => (
                  <div key={device.id} className={`flex items-stretch border-b border-zinc-800/50 last:border-0 ${device.id === selectedDeviceId ? 'bg-blue-500/5' : ''}`}>
                    <button onClick={() => selectDevice(device.id, device.name)}
                      className={`min-h-11 min-w-0 flex-1 px-3 py-2.5 text-left text-xs transition-colors hover:bg-zinc-800 ${device.id === selectedDeviceId ? 'text-blue-300' : 'text-zinc-300'}`}>
                      <div className="flex items-center gap-1.5 font-medium">
                        {device.kind === 'remote' ? <Cloud className="h-3 w-3 shrink-0 text-emerald-400" /> : <Server className="h-3 w-3 shrink-0 text-zinc-500" />}
                        <span className="truncate">{device.name}</span>
                        {device.environmentLabel && <span className="shrink-0 font-normal text-zinc-500">· {device.environmentLabel}</span>}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-500">프로젝트 {device.projectCount}개 · {formatDeviceLastPushAt(device.last_push_at)}</div>
                    </button>
                    <button
                      aria-label={`${device.name} 기본 단말로 지정`}
                      title={defaultDeviceId === device.id ? '현재 기본 단말' : '기본 단말로 지정'}
                      onClick={() => makeDefaultDevice(device)}
                      className={`flex min-h-11 min-w-11 items-center justify-center transition-colors ${defaultDeviceId === device.id && deviceSelectionMode === 'fixed' ? 'text-amber-300' : 'text-zinc-600 hover:text-amber-300'}`}
                    >
                      <Star className={`h-3.5 w-3.5 ${defaultDeviceId === device.id && deviceSelectionMode === 'fixed' ? 'fill-current' : ''}`} />
                    </button>
                  </div>
                ))}
              </div>;
            })}
          </div>
          <button onClick={() => { setShowDevicePicker(false); setShowDeviceManager(true); }}
            className="flex min-h-11 w-full items-center px-3 py-2 text-left text-[11px] text-blue-400 hover:bg-zinc-800 border-t border-zinc-800 transition-colors">
            + 단말 관리 · Mac/Windows/AWS
          </button>
        </div>
      )}
    </div>
  );

  // whitespace-nowrap: 없으면 640~830px 에서 한글 라벨이 음절 단위로 접혀 헤더 높이가 튄다.
  const btnCls = 'portal-toolbar-button';

  const webThemeVars = {
    '--pm-bg': '#121417',
    '--pm-bg-input': '#0d0f12',
    '--pm-bg-hover': '#1b2023',
    '--pm-border': 'rgba(255,255,255,0.075)',
    '--pm-border-hover': 'rgba(255,255,255,0.14)',
    '--pm-border-mid': 'rgba(255,255,255,0.10)',
    '--pm-border-faint': 'rgba(255,255,255,0.045)',
    '--pm-border-strong': 'rgba(255,255,255,0.20)',
    '--pm-text': '#f4f4f5',
    '--pm-text-muted': '#a1a1aa',
    '--pm-text-faint': '#71717a',
  } as React.CSSProperties;

  return (
    <div className="portal-shell" style={webThemeVars} onClick={() => { setShowDevicePicker(false); setShowMoreMenu(false); }}>
      {/* ── Header ── */}
      <header className="portal-app-header">
        <div className="portal-app-header__inner">
          <h1 className="sr-only">AgentsToZ 프로젝트 관리 포털</h1>
          <div className="portal-app-brand">
            <div className="portal-brand-mark portal-brand-mark--compact">
              <BookMarked className="h-4 w-4" />
            </div>
            <div className="portal-app-brand__copy">
              <strong>AgentsToZ</strong>
              <span>Private workspace</span>
            </div>
            {/* 탭은 lg 미만에서 헤더 둘째 줄로 내려간다 — 아래 주석 참조 */}
            {!isFullLayout && <div className="hidden lg:flex items-center gap-1">{tabsEl}</div>}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Device picker — compact header, desktop only */}
            {!isFullLayout && <div className="hidden sm:block">{devicePickerEl}</div>}

            {/* Bookmark actions — desktop: inline buttons / mobile: ... dropdown */}
            {activeTab === 'bookmarks' && <>
              {/* Desktop buttons */}
              <div className="hidden sm:flex items-center gap-1.5">
                <button disabled={bookmarkSyncState.isSyncing || bookmarkSyncState.isRestoring} aria-busy={bookmarkSyncState.isSyncing} onClick={() => actionsRef.current?.push()} className={btnCls} title="Push">
                  <CloudUpload className={`w-3.5 h-3.5 ${bookmarkSyncState.isSyncing ? 'animate-pulse' : ''}`} /><span className="hidden sm:inline">{bookmarkSyncState.isSyncing ? 'Push 중…' : 'Push'}</span>
                </button>
                <button disabled={bookmarkSyncState.isSyncing || bookmarkSyncState.isRestoring} aria-busy={bookmarkSyncState.isRestoring} onClick={() => actionsRef.current?.pull()} className={btnCls} title="Pull">
                  <CloudDownload className={`w-3.5 h-3.5 ${bookmarkSyncState.isRestoring ? 'animate-pulse' : ''}`} /><span className="hidden sm:inline">{bookmarkSyncState.isRestoring ? 'Pull 중…' : 'Pull'}</span>
                </button>
                <button onClick={() => actionsRef.current?.history()} className={btnCls} title="히스토리">
                  <Clock className="w-3.5 h-3.5" />
                </button>
              </div>
            </>}

            {/* Project history button — ports tab only */}
            {activeTab === 'ports' && (
              <button onClick={openPortsHistory} className={btnCls} title="Push 히스토리">
                <Clock className="w-3.5 h-3.5" /><span className="hidden sm:inline">히스토리</span>
              </button>
            )}

            {/* Layout toggle — hidden on mobile */}
            <button onClick={cycleViewMode} className={`${btnCls} hidden sm:flex`} title={`레이아웃: ${viewMode}`}>
              {viewModeIcon}
            </button>
            <div className="relative" onClick={event => event.stopPropagation()}>
              <button aria-label="포털 더보기" aria-expanded={showMoreMenu} onClick={() => setShowMoreMenu(value => !value)} className={btnCls} title="더보기">
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {showMoreMenu && (
                <div className="portal-header-menu" onClick={() => setShowMoreMenu(false)}>
                  {activeTab === 'bookmarks' && (
                    <div className="sm:hidden">
                      <button disabled={bookmarkSyncState.isSyncing || bookmarkSyncState.isRestoring} aria-busy={bookmarkSyncState.isSyncing} onClick={() => actionsRef.current?.push()}><CloudUpload className="w-4 h-4" />{bookmarkSyncState.isSyncing ? '북마크 Push 중…' : '북마크 Push'}</button>
                      <button disabled={bookmarkSyncState.isSyncing || bookmarkSyncState.isRestoring} aria-busy={bookmarkSyncState.isRestoring} onClick={() => actionsRef.current?.pull()}><CloudDownload className="w-4 h-4" />{bookmarkSyncState.isRestoring ? '북마크 Pull 중…' : '북마크 Pull'}</button>
                      <button onClick={() => actionsRef.current?.history()}><Clock className="w-4 h-4" />북마크 히스토리</button>
                    </div>
                  )}
                  {creds && (
                    <button onClick={() => setShowDeviceManager(true)}><Link2 className="w-4 h-4" />Mac·Windows·AWS 단말 관리</button>
                  )}
                  <button onClick={() => {
                    if (!confirm('localStorage를 초기화하고 재연결합니다.\n기기 선택이 초기화됩니다. 계속하시겠습니까?')) return;
                    ['portalData_v1','portalSelectedDevice','portalSelectedDeviceName','portalDeviceSelectionMode','portalDefaultDevice','portalCreds','portal_google_verified','portalViewMode'].forEach(k => localStorage.removeItem(k));
                    window.location.reload();
                  }}><RefreshCw className="w-4 h-4" />연결 정보 초기화</button>
                </div>
              )}
            </div>
            <button aria-label="설정" onClick={() => setOpenSettings(true)} className={btnCls}>
              <Settings className="w-3.5 h-3.5" /><span className="hidden sm:inline">설정</span>
            </button>
            <div className="hidden sm:block"><BuildInfoBadge /></div>
          </div>
        </div>
        {/* 헤더 둘째 줄 — 탭 + 기기 선택.
            첫 줄에 탭을 두면 좌측 그룹 박스는 min-w-0 로 줄어드는데 각 탭 버튼의
            whitespace-nowrap 때문에 내용은 min-content(=라벨 전체 폭) 아래로 줄지
            않아, 내용이 박스를 넘어 우측 아이콘 위에 겹쳐 그려진다. 실측상 겹침이
            390px뿐 아니라 640·768·834px(아이패드 세로)에서도 나고 1023px에서야
            사라지므로 경계는 sm 이 아니라 lg 다. 전용 줄에서는 가로 스크롤이
            올바른 동작이라 whitespace-nowrap 은 유지한다. */}
        {!isFullLayout && (
          <div className="portal-app-header__secondary lg:hidden">
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">{tabsEl}</div>
            <div className="sm:hidden flex items-center">{devicePickerEl}</div>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      <div className="portal-workspace">
        {isFullLayout && (
          <>
            {/* Sidebar */}
            <aside className="portal-app-sidebar">
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-2">기기</p>
                {devicePickerEl}
              </div>
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">메뉴</p>
                <nav className="space-y-0.5">
                  {([
                    ['ports', '프로젝트·폴더', <Server className="w-3.5 h-3.5" />],
                    ['bookmarks', '북마크', <BookMarked className="w-3.5 h-3.5" />],
                    ['memories', '장기기억', <Brain className="w-3.5 h-3.5" />],
                  ] as [Tab, string, React.ReactNode][]).map(([tab, label, icon]) => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`portal-app-sidebar__nav-item ${activeTab === tab ? 'is-active' : ''}`}>
                      {icon}{label}
                    </button>
                  ))}
                </nav>
              </div>
            </aside>

            {/* 본문은 레이아웃 분기 바깥에 한 번만 둔다 — 예전에는 전체/컴팩트가 같은
                자식 트리를 각각 작성해, 레이아웃이 바뀔 때 React 가 서브트리를 통째로
                언마운트/리마운트했다(검색어·스크롤 위치가 날아간다). aside 만 조건부로
                두면 main 의 위치와 타입이 고정되어 리마운트가 사라진다. */}
          </>
        )}
        <main className={`portal-main ${isFullLayout ? 'portal-main--full' : ''}`}>
          <PortalManager showToast={showToast} openSettings={openSettings}
            onSettingsClosed={() => setOpenSettings(false)} actionsRef={actionsRef}
            isVisible={activeTab === 'bookmarks'}
            onChangeDevice={() => setShowDevicePicker(true)}
            onManageDevices={() => setShowDeviceManager(true)}
            onSyncStateChange={setBookmarkSyncState}
            selectedProjectDevice={selectedDevice ? { id: selectedDevice.id, name: selectedDevice.name } : null} />
          {activeTab === 'memories' && (
            creds ? (
              <PortalMemoryDirectory supabaseUrl={creds.url} supabaseKey={creds.key} showToast={showToast} />
            ) : (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <p className="text-sm text-zinc-500">설정에서 Supabase URL/Key를 입력하세요</p>
              </div>
            )
          )}
          {activeTab === 'ports' && (
            creds && selectedDeviceId ? (
              selectedDevice?.kind === 'remote' ? (
                <RemoteProjectsView device={selectedDevice} creds={creds} showToast={showToast} onManageDevice={() => setShowDeviceManager(true)} />
              ) : (
                <PortsView deviceId={selectedDeviceId} deviceIds={selectedDevice?.sourceIds ?? [selectedDeviceId]} creds={creds} showToast={showToast} onSwitchDevice={() => setShowDevicePicker(true)} />
              )
            ) : (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <p className="text-sm text-zinc-500">
                  {!creds ? '설정에서 Supabase URL/Key를 입력하세요' : isFullLayout ? '좌측에서 기기를 선택하세요' : '헤더에서 기기를 선택하세요'}
                </p>
                {creds && <button onClick={event => { event.stopPropagation(); setShowDevicePicker(true); }} className="min-h-11 rounded-lg border border-blue-500/30 px-3 py-2 text-xs text-blue-300 hover:bg-blue-500/10">단말 선택</button>}
              </div>
            )
          )}
        </main>
      </div>

      {toasts.map(t => <Toast key={t.id} message={t.message} type={t.type} />)}

      {showPortsHistory && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowPortsHistory(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <Clock className="w-4 h-4 text-zinc-400" />
                <span className="text-sm font-semibold text-white">프로젝트 Push 히스토리</span>
              </div>
              <button onClick={() => setShowPortsHistory(false)}
                className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              {portsHistoryLoading ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" />
                </div>
              ) : portsHistoryList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
                  <Clock className="w-8 h-8 text-zinc-700" />
                  <p className="text-sm text-zinc-500">히스토리가 없습니다</p>
                  <p className="text-xs text-zinc-600">로컬 앱에서 Push하면 기록이 저장됩니다</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {portsHistoryList.map((snap, i) => (
                    <div key={snap.id} className={`px-3 py-2.5 rounded-xl border ${
                      i === 0 ? 'border-blue-500/30 bg-blue-500/5' : 'border-zinc-800/60 bg-zinc-900/60'
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-zinc-200">
                            {new Date(snap.created_at).toLocaleString('ko-KR', {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                            {i === 0 && <span className="ml-2 text-[10px] text-blue-400 font-normal">최신</span>}
                          </p>
                          <p className="text-[10px] text-zinc-500 mt-0.5">
                            {snap.device_name ?? snap.device_id?.slice(0, 8) ?? '기기 미상'}
                          </p>
                        </div>
                        <span className="text-[10px] text-zinc-600 bg-zinc-800 px-2 py-1 rounded-md shrink-0">
                          {snap.row_count}개
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showDeviceManager && creds && (
        <DeviceManagerModal
          devices={devices.filter(device => device.kind === 'desktop')}
          creds={creds}
          onClose={() => setShowDeviceManager(false)}
          onUpdate={updated => setDevices(current => [
            ...updated.map(device => ({ ...device, kind: 'desktop' as const })),
            ...current.filter(device => device.kind === 'remote'),
          ])}
          showToast={showToast}
        />
      )}
    </div>
  );
}

type PortalWindow = Window & { __agentstozPortalRoot?: Root };
const portalWindow = window as PortalWindow;
const root = portalWindow.__agentstozPortalRoot ?? createRoot(document.getElementById('root')!);
portalWindow.__agentstozPortalRoot = root;
root.render(<React.StrictMode><App /></React.StrictMode>);
