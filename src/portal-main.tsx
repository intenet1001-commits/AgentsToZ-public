import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PortalManager, { type PortalActions } from './PortalManager';
import {
  BookMarked, Settings, CloudUpload, CloudDownload,
  ExternalLink, Github, RefreshCw, Clock, Monitor, Smartphone,
  Server, Pencil, Trash2, Search,
  ChevronDown, X, MoreHorizontal, Link2,
  Plus, Check, Brain, Copy,
} from 'lucide-react';
import { type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, describeSupabaseError } from './lib/supabaseClient';
import { getOwnDeviceId, setOwnDeviceId } from './portalDeviceIdentity';
import PortalMemoryDirectory from './PortalMemoryDirectory';
import {
  loadMemoryDirectory,
  matchMemoryForProject,
  MEMORY_LIST_COLUMNS,
  MEMORY_REVISION_WINDOW,
  type MemoryDirectoryEntry,
} from './projectMemoryDirectory';
import { fetchPushHistory, type PushSnapshot } from './pushHistory';
import { BuildInfoBadge } from './components/BuildInfoBadge';
import {
  githubRepositoryUrls,
  githubRepositoryUrlsText,
  parseGitHubRepositoryUrls,
} from './githubUrls';

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
  name: string | null;
  last_push_at: string;
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
    <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center p-4">
      <div className="fixed top-3 right-4 z-10">
        <BuildInfoBadge />
      </div>
      <div className="w-full max-w-xs bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-blue-500/10 rounded-lg border border-blue-500/20">
            <BookMarked className="w-4 h-4 text-blue-400" />
          </div>
          <span className="font-semibold text-white text-sm">북마크</span>
        </div>
        {checking ? (
          <div className="text-xs text-zinc-500 text-center py-3">확인 중…</div>
        ) : (
          <>
            <p className="text-xs text-zinc-400">Google 계정으로 로그인하세요.</p>
            <button onClick={handleLogin} disabled={loading}
              className="w-full py-2.5 bg-white hover:bg-zinc-100 disabled:opacity-50 text-zinc-900 text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {loading ? '이동 중…' : 'Google로 로그인'}
            </button>
          </>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: 'success' | 'error' }) {
  return (
    <div
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

function PortsView({ deviceId, creds, showToast, onSwitchDevice }: {
  deviceId: string;
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
          .limit(MEMORY_REVISION_WINDOW));
        if (!cancelled) setMemoryEntries(loaded.entries);
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
        기억 {matched.memoryId.slice(0, 8)}
        {copiedMemoryId === matched.memoryId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    );
  };

  async function loadPorts() {
    if (!deviceId) return;
    setLoading(true);
    try {
      const { data, error } = await sb().from('portmgr_ports').select('*').eq('device_id', deviceId).order('name');
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
  }, [deviceId]);

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

function DeviceManagerModal({ devices, creds, onClose, onUpdate }: {
  devices: DeviceRow[];
  creds: { url: string; key: string };
  onClose: () => void;
  onUpdate: (devices: DeviceRow[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const sb = getDefaultSupabaseClient(creds.url, creds.key);
      const { error } = await sb.from('portmgr_devices').update({ name: editName.trim() }).eq('id', id);
      if (error) throw error;
      onUpdate(devices.map(d => d.id === id ? { ...d, name: editName.trim() } : d));
      setEditingId(null);
    } catch (e) {
      alert('저장 실패: ' + String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteDevice(id: string) {
    if (!confirm('이 기기를 삭제하시겠습니까?')) return;
    setDeletingId(id);
    try {
      const sb = getDefaultSupabaseClient(creds.url, creds.key);
      const { error } = await sb.from('portmgr_devices').delete().eq('id', id);
      if (error) throw error;
      onUpdate(devices.filter(d => d.id !== id));
    } catch (e) {
      alert('삭제 실패: ' + String(e));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <span className="text-sm font-semibold text-white">기기 관리</span>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors"><X className="w-4 h-4" /></button>
        </div>
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
                    <p className="text-[10px] text-zinc-600 mt-0.5">
                      {new Date(d.last_push_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <button onClick={() => { setEditingId(d.id); setEditName(d.name ?? ''); }}
                    className="shrink-0 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors flex items-center gap-1">
                    <Pencil className="w-3 h-3" />편집
                  </button>
                  <button onClick={() => deleteDevice(d.id)} disabled={deletingId === d.id}
                    className="shrink-0 px-2.5 py-2 sm:px-2 sm:py-1 text-[11px] text-red-400 border border-red-900/50 rounded hover:bg-red-500/10 transition-colors disabled:opacity-50 flex items-center gap-1">
                    <Trash2 className="w-3 h-3" />{deletingId === d.id ? '…' : '삭제'}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
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
    () => localStorage.getItem(SELECTED_DEVICE_KEY) ? 'ports' : 'bookmarks'
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? 'auto'
  );
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(
    () => localStorage.getItem(SELECTED_DEVICE_KEY) ?? ''
  );
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const [showDeviceManager, setShowDeviceManager] = useState(false);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPortsHistory, setShowPortsHistory] = useState(false);
  const [portsHistoryList, setPortsHistoryList] = useState<PushSnapshot[]>([]);
  const [portsHistoryLoading, setPortsHistoryLoading] = useState(false);
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

  const isFullLayout = viewMode === 'full' || (viewMode === 'auto' && windowWidth >= 1024);

  /** 탭 버튼 묶음. 헤더 첫 줄(lg 이상)과 둘째 줄(lg 미만) 두 곳에서 같은 것을 쓴다. */
  const tabsEl = (['ports', 'bookmarks', 'memories'] as Tab[]).map(tab => (
    <button key={tab} onClick={() => setActiveTab(tab)}
      aria-current={activeTab === tab ? 'page' : undefined}
      className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-xs rounded-lg border transition-all whitespace-nowrap ${
        activeTab === tab
          ? 'bg-blue-500/15 border-blue-500/30 text-blue-300'
          : 'bg-zinc-800/40 border-zinc-700/40 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/40'
      }`}>
      {tab === 'memories' ? <Brain className="w-3 h-3" /> : tab === 'bookmarks' ? <BookMarked className="w-3 h-3" /> : <Server className="w-3 h-3" />}
      {tab === 'memories' ? '장기기억' : tab === 'bookmarks' ? '북마크' : '프로젝트·폴더'}
    </button>
  ));

  const showToast = (message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  };

  // ─── Handoff: "이 설정을 다른 기기에 전달" (1st → 2nd+ 기기) ─────────────────
  async function handleCopySetup() {
    if (!creds) {
      showToast('Supabase 설정이 없습니다', 'error');
      return;
    }
    const pwHash = '';
    // 현재 보고 있는 device 의 ID/이름을 함께 전달 → 로컬에서 "이어받기" 가능
    const target = devices.find(d => d.id === selectedDeviceId);
    const payload = {
      v: 1,
      type: 'portmanager-setup',
      url: creds.url,
      key: creds.key,
      pwHash,
      device: target?.id || selectedDeviceId || undefined,
      deviceName: target?.name || undefined,
      copiedAt: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      const label = target?.name ? `'${target.name}'` : '설정';
      showToast(`${label} 복사됨 — 로컬 앱 → 설정 → 추가 기기 → 붙여넣기`, 'success');
    } catch (e: any) {
      showToast('복사 실패: ' + (e?.message ?? e), 'error');
    }
  }

  async function loadDevices() {
    if (!creds) return;
    try {
      const sb = getSupabaseClient(creds.url, creds.key);
      // 세션 복원을 기다린 뒤 조회한다 — 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로
      // 나가고, RLS 가 걸린 테이블은 오류가 아니라 **조용히 0행**을 돌려준다.
      await sb.auth.getSession();
      const nameMap = new Map<string, string>();
      const seenIds = new Set<string>();

      // 1) devices 테이블 (이름 우선)
      const { data: devRows, error: devError } = await sb.from('portmgr_devices').select('*').order('last_push_at', { ascending: false });
      // 거부를 삼키면 "기기가 없습니다. 앱에서 Push하면 등록됩니다"라는 **거짓 진단**이
      // 뜨고, 사용자는 있지도 않은 문제를 고치려 든다. 사실대로 알린다.
      if (devError) {
        setDevices([]);
        showToast(`기기 목록을 불러오지 못했습니다: ${describeSupabaseError(devError)}`, 'error');
        return;
      }
      for (const d of devRows ?? []) {
        seenIds.add(d.id);
        if (d.name) nameMap.set(d.id, d.name);
      }

      // 2) workspace_roots __device__ sentinel → 기기명 (가장 신뢰할 수 있는 소스)
      const { data: rootRows } = await sb.from('portmgr_workspace_roots').select('device_id, name, path').not('device_id', 'is', null);
      for (const r of rootRows ?? []) {
        if (!r.device_id || r.device_id === '__shared__') continue;
        seenIds.add(r.device_id);
        if (r.path?.startsWith('__device__') && r.name && !nameMap.has(r.device_id)) {
          nameMap.set(r.device_id, r.name);
        }
      }

      // 3) ports 테이블 device_name 컬럼 — portmgr_devices 미등록 기기도 추적
      const portSeenIds = new Set<string>();
      const { data: portRows } = await sb.from('portmgr_ports').select('device_id, device_name').not('device_id', 'is', null);
      for (const r of portRows ?? []) {
        if (!r.device_id) continue;
        seenIds.add(r.device_id);
        portSeenIds.add(r.device_id);
        if (r.device_name && !nameMap.has(r.device_id)) nameMap.set(r.device_id, r.device_name);
      }

      // 4) portal_items folder 타입 → 경로에서 사용자명 추출 (최후 fallback)
      const { data: folderRows } = await sb.from('portmgr_portal_items').select('device_id, path').eq('type', 'folder').not('device_id', 'is', null);
      for (const r of folderRows ?? []) {
        if (!r.device_id || r.device_id === '__shared__') continue;
        seenIds.add(r.device_id);
        if (!nameMap.has(r.device_id) && r.path) {
          const m = r.path.match(/^\/(?:Users|home)\/([^/]+)\//);
          if (m) nameMap.set(r.device_id, `${m[1]}의 기기`);
        }
      }

      // portmgr_devices 등록 기기 + 포트 데이터가 있는 미등록 기기 모두 포함
      // (portmgr_devices에서 삭제된 기기는 제외하되, 처음부터 없던 기기는 포함)
      const registeredIds = devRows && devRows.length > 0
        ? new Set(devRows.map(d => d.id))
        : null;
      const filteredIds = registeredIds
        ? Array.from(new Set([
            ...Array.from(seenIds).filter(id => registeredIds.has(id)),
            ...Array.from(portSeenIds),  // 포트 데이터 있는 기기는 항상 포함
          ]))
        : Array.from(seenIds);

      const list: DeviceRow[] = filteredIds.map(id => ({
        id,
        name: nameMap.get(id) ?? id.slice(0, 8),
        last_push_at: (devRows ?? []).find(d => d.id === id)?.last_push_at ?? '',
      })).sort((a, b) => (b.last_push_at ?? '').localeCompare(a.last_push_at ?? ''));

      setDevices(list);
      // 조회 선택의 표시 이름만 보정한다. portalData_v1.deviceName 은 이
      // 브라우저 자체 신원이라 남의 기기를 조회한 이름으로 덮어쓰면 안 된다.
      const storedId = localStorage.getItem(SELECTED_DEVICE_KEY);
      if (storedId) {
        const matched = list.find(d => d.id === storedId);
        if (matched?.name) localStorage.setItem(SELECTED_DEVICE_NAME_KEY, matched.name);
      }
      // Auto-open picker if no device selected OR selected device not in list
      const knownInList = list.some(d => d.id === selectedDeviceId);
      if ((!selectedDeviceId || !knownInList) && list.length > 0) {
        // Auto-select if only one candidate with ports (most recent push)
        if (list.length === 1) {
          selectDevice(list[0]!.id, list[0]!.name ?? undefined);
        } else {
          setShowDevicePicker(true);
        }
      } else if (selectedDeviceId && knownInList) {
        // 이전 세션에서 선택한 기기가 유효 → 프로젝트·폴더 탭으로 바로 전환
        setActiveTab('ports');
      }
    } catch (e) {
      showToast('기기 목록 조회 실패: ' + String(e), 'error');
    }
  }

  async function registerThisDevice() {
    if (!creds || !registerName.trim()) return;
    const trimmed = registerName.trim();

    // UUID 중복 체크 — localStorage에 저장된 기기 ID가 이미 목록에 있으면 선택만
    const storedId = (() => { try { return JSON.parse(localStorage.getItem(PORTAL_WEB_KEY) ?? '{}').deviceId; } catch { return null; } })();
    const alreadyRegistered = storedId && devices.find(d => d.id === storedId);
    if (alreadyRegistered) {
      showToast(`이미 등록된 기기입니다: ${alreadyRegistered.name}`, 'error');
      selectDevice(alreadyRegistered.id, alreadyRegistered.name ?? undefined);
      return;
    }

    // 이름 중복 체크
    if (devices.some(d => d.name === trimmed)) {
      showToast('같은 이름의 기기가 이미 있습니다', 'error');
      return;
    }
    setRegistering(true);
    try {
      // 등록은 이 브라우저의 신원을 정하는 유일한 경로다 — 신원 키에도 함께 기록해야
      // 다음 부팅에서 신원이 되돌려지지 않는다.
      const newId = crypto.randomUUID();
      const sb = getSupabaseClient(creds.url, creds.key); // persistSession:false 옵션은 getSupabaseClient 내부에서 동일하게 적용됨
      const { error } = await sb.from('portmgr_devices').insert({ id: newId, name: registerName.trim() });
      if (error) throw error;
      setOwnDeviceId(newId);
      const newDev: DeviceRow = { id: newId, name: registerName.trim(), last_push_at: new Date().toISOString() };
      setDevices(prev => [newDev, ...prev]);
      selectDevice(newId, trimmed);
      setShowRegisterForm(false);
      setRegisterName('');
      showToast('이 기기가 등록되었습니다', 'success');

      // 새 단말 로컬 앱 설정 딥링크 — 클립보드에 자동 복사
      // 형식: portmgr://onboard?deviceId=xxx&url=xxx&key=xxx
      // 또는 로컬호스트 URL: http://localhost:3001/api/setup/onboard?...
      if (creds.url && creds.key) {
        const params = new URLSearchParams({
          deviceId: newId,
          deviceName: trimmed,
          supabaseUrl: creds.url,
          supabaseAnonKey: creds.key,
        });
        const onboardUrl = `http://localhost:3001/api/setup/pull-credentials?${params}`;
        const payload = JSON.stringify({ v: 2, type: 'portmgr-onboard', deviceId: newId, deviceName: trimmed, url: creds.url, key: creds.key });
        try {
          await navigator.clipboard.writeText(payload);
          showToast('📋 온보딩 정보가 클립보드에 복사됨 — 로컬 앱 마법사의 "새 단말 온보딩"에 붙여넣기', 'success');
        } catch { /* clipboard permission denied */ }
      }
    } catch (e) {
      showToast('등록 실패: ' + String(e), 'error');
    } finally {
      setRegistering(false);
    }
  }

  useEffect(() => { if (pwOk) loadDevices(); }, [pwOk, creds?.url]);

  // Auto-open settings when no Supabase credentials (fresh/incognito browser)
  useEffect(() => {
    if (pwOk && !creds) setOpenSettings(true);
  }, [pwOk]);

  /** 조회 선택만 바꾼다. **이 브라우저의 신원은 건드리지 않는다** — 남의 기기를 보는 것이
   *  내가 그 기기가 된다는 뜻은 아니다. 신원 변경은 registerThisDevice 만 한다. */
  function selectDevice(id: string, name?: string, autoSwitch = true) {
    setSelectedDeviceId(id);
    try {
      localStorage.setItem(SELECTED_DEVICE_KEY, id);
      if (name) localStorage.setItem(SELECTED_DEVICE_NAME_KEY, name);
    } catch { /* 저장 실패는 이번 세션에만 영향 */ }
    setShowDevicePicker(false);
    if (autoSwitch) setActiveTab('ports');
  }

  async function openPortsHistory() {
    if (!creds || !selectedDeviceId) {
      showToast('기기를 먼저 선택하세요', 'error');
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
        onClick={() => { setShowDevicePicker(s => !s); setShowRegisterForm(false); }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 border border-zinc-700/50 rounded-lg transition-all max-w-[180px]"
      >
        <Server className="w-3 h-3 shrink-0 text-zinc-500" />
        <span className="truncate text-zinc-500 shrink-0 hidden sm:inline">보기:</span>
        <span className="truncate">{selectedDevice?.name ?? '기기 선택'}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-zinc-600" />
      </button>
      {showDevicePicker && (
        <div className="absolute top-full mt-1 left-0 z-50 w-60 max-w-[calc(100vw-32px)] bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl">
          <div className="px-3 py-2 text-[10px] text-zinc-500 border-b border-zinc-800 flex items-center justify-between">
            <span>어떤 기기를 볼까요?</span>
            <div className="flex items-center gap-2">
              <button onClick={() => { setShowDevicePicker(false); setShowDeviceManager(true); }}
                className="text-zinc-600 hover:text-zinc-300 text-[10px] transition-colors">기기 관리</button>
              <button onClick={loadDevices} className="text-zinc-600 hover:text-zinc-400 transition-colors">
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {devices.length === 0 ? (
              <div className="px-3 py-3 text-xs text-zinc-500">기기가 없습니다.<br />앱에서 Push하면 등록됩니다.</div>
            ) : devices.map(d => (
              <button key={d.id} onClick={() => selectDevice(d.id, d.name ?? undefined)}
                className={`w-full text-left px-3 py-2.5 text-xs hover:bg-zinc-800 transition-colors border-b border-zinc-800/50 last:border-0 ${
                  d.id === selectedDeviceId ? 'text-blue-300 bg-blue-500/5' : 'text-zinc-300'
                }`}>
                <div className="font-medium truncate">{d.name ?? d.id.slice(0, 8)}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {new Date(d.last_push_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </button>
            ))}
          </div>
          {/* Register this device */}
          {showRegisterForm ? (
            <div className="px-3 py-2.5 border-t border-zinc-800 space-y-2">
              <p className="text-[10px] text-zinc-500">이 브라우저를 새 단말로 등록</p>
              <input
                className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
                placeholder="기기 이름 (예: 내 아이폰)"
                value={registerName}
                onChange={e => setRegisterName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && registerThisDevice()}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button onClick={() => setShowRegisterForm(false)}
                  className="flex-1 py-1 text-[10px] text-zinc-500 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors">취소</button>
                <button onClick={registerThisDevice} disabled={registering || !registerName.trim()}
                  className="flex-1 py-1 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors">
                  {registering ? '등록 중…' : '등록'}
                </button>
              </div>
            </div>
          ) : (() => {
            const myStoredId = getOwnDeviceId();
            const alreadyReg = myStoredId ? devices.find(d => d.id === myStoredId) : null;
            return alreadyReg ? (
              <button onClick={() => selectDevice(alreadyReg.id, alreadyReg.name ?? undefined)}
                className="w-full text-left px-3 py-2 text-[11px] text-emerald-400 hover:bg-zinc-800 border-t border-zinc-800 transition-colors">
                ✓ 이 기기 ({alreadyReg.name}) — 선택하기
              </button>
            ) : (
              <button onClick={() => setShowRegisterForm(true)}
                className="w-full text-left px-3 py-2 text-[11px] text-blue-400 hover:bg-zinc-800 border-t border-zinc-800 transition-colors">
                + 이 기기를 새 단말로 등록
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );

  // whitespace-nowrap: 없으면 640~830px 에서 한글 라벨이 음절 단위로 접혀 헤더 높이가 튄다.
  const btnCls = 'flex items-center gap-1.5 shrink-0 whitespace-nowrap px-2.5 py-2.5 sm:py-1.5 text-xs bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-400 hover:text-zinc-200 rounded-lg border border-zinc-700/50 transition-all';

  const webThemeVars = {
    '--pm-bg': '#18181b',
    '--pm-bg-input': '#111113',
    '--pm-bg-hover': '#27272a',
    '--pm-border': 'rgba(255,255,255,0.07)',
    '--pm-border-hover': 'rgba(255,255,255,0.11)',
    '--pm-border-mid': 'rgba(255,255,255,0.09)',
    '--pm-border-faint': 'rgba(255,255,255,0.05)',
    '--pm-border-strong': 'rgba(255,255,255,0.20)',
    '--pm-text': '#f4f4f5',
    '--pm-text-muted': '#a1a1aa',
    '--pm-text-faint': '#71717a',
  } as React.CSSProperties;

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white flex flex-col" style={webThemeVars} onClick={() => { setShowDevicePicker(false); setShowMoreMenu(false); }}>
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-[#0a0a0b]/95 backdrop-blur border-b border-zinc-800/60 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-3 min-w-0 flex-shrink">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-blue-500/10 rounded-lg border border-blue-500/20">
                <BookMarked className="w-4 h-4 text-blue-400" />
              </div>
            </div>
            {/* 탭은 lg 미만에서 헤더 둘째 줄로 내려간다 — 아래 주석 참조 */}
            {!isFullLayout && <div className="hidden lg:flex items-center gap-1">{tabsEl}</div>}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Device picker — compact header, desktop only */}
            {!isFullLayout && <div className="hidden sm:block">{devicePickerEl}</div>}

            {/* Bookmark actions — desktop: inline buttons / mobile: ... dropdown */}
            {(activeTab === 'bookmarks' || isFullLayout) && <>
              {/* Desktop buttons */}
              <div className="hidden sm:flex items-center gap-1.5">
                <button onClick={() => actionsRef.current?.push()} className={btnCls} title="Push">
                  <CloudUpload className="w-3.5 h-3.5" /><span className="hidden sm:inline">Push</span>
                </button>
                <button onClick={() => actionsRef.current?.pull()} className={btnCls} title="Pull">
                  <CloudDownload className="w-3.5 h-3.5" /><span className="hidden sm:inline">Pull</span>
                </button>
                <button onClick={() => actionsRef.current?.history()} className={btnCls} title="히스토리">
                  <Clock className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* Mobile more menu */}
              <div className="relative sm:hidden" onClick={e => e.stopPropagation()}>
                <button onClick={() => setShowMoreMenu(s => !s)} className={btnCls} title="더보기">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
                {showMoreMenu && (
                  <div className="absolute top-full right-0 mt-1 z-50 w-32 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl py-1"
                    onClick={() => setShowMoreMenu(false)}>
                    <button onClick={() => actionsRef.current?.push()} className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 flex items-center gap-2">
                      <CloudUpload className="w-3.5 h-3.5" />Push
                    </button>
                    <button onClick={() => actionsRef.current?.pull()} className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 flex items-center gap-2">
                      <CloudDownload className="w-3.5 h-3.5" />Pull
                    </button>
                    <button onClick={() => actionsRef.current?.history()} className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5" />히스토리
                    </button>
                    {creds && (
                      <button onClick={handleCopySetup} className="w-full text-left px-3 py-2 text-xs text-blue-300 hover:bg-zinc-800 flex items-center gap-2 border-t border-zinc-800">
                        <Link2 className="w-3.5 h-3.5" />새 기기 연결
                      </button>
                    )}
                  </div>
                )}
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
            {creds && (
              <button
                onClick={handleCopySetup}
                className={btnCls}
                title="새 기기 연결 — 이 기기의 Supabase 설정을 클립보드에 복사 (새 기기의 로컬 앱에서 붙여넣기)"
              >
                <Link2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">새 기기</span>
              </button>
            )}
            <button
              onClick={() => {
                if (!confirm('localStorage를 초기화하고 재연결합니다.\n기기 선택이 초기화됩니다. 계속하시겠습니까?')) return;
                ['portalData_v1','portalSelectedDevice','portalCreds','portal_google_verified','portalViewMode'].forEach(k => localStorage.removeItem(k));
                window.location.reload();
              }}
              className={btnCls} title="localStorage 초기화 후 재연결">
              <RefreshCw className="w-3.5 h-3.5" /><span className="hidden sm:inline">재연결</span>
            </button>
            <button onClick={() => setOpenSettings(true)} className={btnCls}>
              <Settings className="w-3.5 h-3.5" /><span className="hidden sm:inline">설정</span>
            </button>
            <BuildInfoBadge />
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
          <div className="lg:hidden pt-2 flex flex-col gap-2">
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">{tabsEl}</div>
            <div className="sm:hidden flex items-center">{devicePickerEl}</div>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      <div className="flex-1 max-w-7xl mx-auto w-full flex">
        {isFullLayout && (
          <>
            {/* Sidebar */}
            <aside className="w-52 shrink-0 border-r border-zinc-800/60 px-4 py-5 space-y-5">
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
                      className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs rounded-lg transition-all ${
                        activeTab === tab
                          ? 'bg-blue-500/15 text-blue-300'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                      }`}>
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
        <main className={isFullLayout ? 'flex-1 px-6 py-5 overflow-auto min-w-0' : 'flex-1 px-4 py-4'}>
          <PortalManager showToast={showToast} openSettings={openSettings}
            onSettingsClosed={() => setOpenSettings(false)} actionsRef={actionsRef}
            isVisible={activeTab === 'bookmarks'} />
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
              <PortsView deviceId={selectedDeviceId} creds={creds} showToast={showToast} onSwitchDevice={() => setShowDevicePicker(true)} />
            ) : (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <p className="text-sm text-zinc-500">
                  {!creds ? '설정에서 Supabase URL/Key를 입력하세요' : isFullLayout ? '좌측에서 기기를 선택하세요' : '헤더에서 기기를 선택하세요'}
                </p>
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
          devices={devices}
          creds={creds}
          onClose={() => setShowDeviceManager(false)}
          onUpdate={setDevices}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
