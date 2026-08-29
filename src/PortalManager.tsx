import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Globe, Folder, Plus, Trash2, Pencil, X, Check, Search,
  ExternalLink, FolderOpen, Star, Download, Upload,
  Cloud, CloudOff, CloudUpload, CloudDownload, Settings, Settings2, RefreshCw, Link2, Pin,
  BookMarked, ChevronDown, Database, Terminal, Clock, RotateCw
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getSupabaseClient, describeSupabaseError } from './lib/supabaseClient';
import { signInBrowserSupabase } from './nativeSupabaseAuth';
import { getOwnDeviceId } from './portalDeviceIdentity';
import { resolvePortalDeviceIdentity } from './portalDeviceIdentityOwner';
import { savePushSnapshot, fetchPushHistory, fetchSnapshotRows, type PushSnapshot } from './pushHistory';
import { SCHEMA_TABLE_COUNT, aiTablePromptForAllowedEmails } from './schemaSql';
import { isTauri, isDeployedWeb } from './lib/env';
import { isDeploymentPortalItem } from './browserProfile';
import { buildAgentsToZBotCreationPrompt } from './agentstozBotPrompt';
import {
  normalizeHttpsPortalBaseUrl,
  normalizeVercelPortalDeployUrl,
  portalUrlWithParams,
} from './portalDeployUrl';
import {
  buildPortalCloudDeleteQueue,
  nextPortalCategoryOrder,
  normalizePortalCollectionData,
  resolveBookmarkCategoryId,
  sortedPortalCategories,
  type PortalCloudDeleteQueue,
} from './portalBookmarkModel';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortalItem {
  id: string;
  name: string;
  type: 'web' | 'folder';
  url?: string;
  path?: string;
  category: string;
  description?: string;
  pinned: boolean;
  visitCount: number;
  lastVisited?: string;
  createdAt: string;
}

export interface PortalCategory {
  id: string;
  name: string;
  color: ColorKey;
  order: number;
}

export interface PortalData {
  items: PortalItem[];
  categories: PortalCategory[];
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  deviceId?: string;
  deviceName?: string;
  handoffNote?: string; // 이 기기의 핸드오프 메모 (local-first, portmgr_devices.handoff_note와 동기화)
  viewingDeviceId?: string; // if set, Pull shows this device's data
  lastSynced?: string;
  /** 추가 단말 DB upsert가 확인될 때까지 같은 UUID로 재시도하는 로컬 마커. */
  pendingDeviceRegistration?: boolean;
  deviceRegisteredAt?: string;
  /** 이 사용자가 자동 배포한 개인 포털. 공개 소스의 기본 주소와는 분리한다. */
  portalDeployUrl?: string;
  /** 배포 웹의 Supabase delete 실패를 다음 저장/Pull 전에 멱등 재시도하는 로컬 전용 큐. */
  pendingCloudDeletes?: PortalCloudDeleteQueue;
}

type ColorKey = 'blue' | 'green' | 'purple' | 'amber' | 'rose' | 'cyan' | 'orange' | 'teal' | 'indigo' | 'pink';

// ─── Color System ─────────────────────────────────────────────────────────────

const COLORS: Record<ColorKey, { bg: string; text: string; border: string; dot: string; activeBg: string; hairline: string; tint: string }> = {
  blue:   { bg: 'bg-blue-500/10',   text: 'text-blue-400',   border: 'border-blue-500/30',   dot: 'bg-blue-500',   activeBg: 'bg-blue-500/20',   hairline: 'rgba(59,130,246,0.55)',  tint: 'rgba(59,130,246,0.06)' },
  green:  { bg: 'bg-green-500/10',  text: 'text-green-400',  border: 'border-green-500/30',  dot: 'bg-green-500',  activeBg: 'bg-green-500/20',  hairline: 'rgba(34,197,94,0.55)',   tint: 'rgba(34,197,94,0.06)' },
  purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30', dot: 'bg-purple-500', activeBg: 'bg-purple-500/20', hairline: 'rgba(168,85,247,0.55)',  tint: 'rgba(168,85,247,0.06)' },
  amber:  { bg: 'bg-amber-500/10',  text: 'text-amber-400',  border: 'border-amber-500/30',  dot: 'bg-amber-500',  activeBg: 'bg-amber-500/20',  hairline: 'rgba(94,234,212,0.55)', tint: 'rgba(94,234,212,0.06)' },
  rose:   { bg: 'bg-rose-500/10',   text: 'text-rose-400',   border: 'border-rose-500/30',   dot: 'bg-rose-500',   activeBg: 'bg-rose-500/20',   hairline: 'rgba(244,63,94,0.55)',   tint: 'rgba(244,63,94,0.06)' },
  cyan:   { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',   border: 'border-cyan-500/30',   dot: 'bg-cyan-500',   activeBg: 'bg-cyan-500/20',   hairline: 'rgba(6,182,212,0.55)',   tint: 'rgba(6,182,212,0.06)' },
  orange: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-500', activeBg: 'bg-orange-500/20', hairline: 'rgba(249,115,22,0.55)',  tint: 'rgba(249,115,22,0.06)' },
  teal:   { bg: 'bg-teal-500/10',   text: 'text-teal-400',   border: 'border-teal-500/30',   dot: 'bg-teal-500',   activeBg: 'bg-teal-500/20',   hairline: 'rgba(20,184,166,0.55)',  tint: 'rgba(20,184,166,0.06)' },
  indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/30', dot: 'bg-indigo-500', activeBg: 'bg-indigo-500/20', hairline: 'rgba(99,102,241,0.55)',  tint: 'rgba(99,102,241,0.06)' },
  pink:   { bg: 'bg-pink-500/10',   text: 'text-pink-400',   border: 'border-pink-500/30',   dot: 'bg-pink-500',   activeBg: 'bg-pink-500/20',   hairline: 'rgba(236,72,153,0.55)', tint: 'rgba(236,72,153,0.06)' },
};

const COLOR_OPTIONS: ColorKey[] = ['blue', 'green', 'purple', 'amber', 'rose', 'cyan', 'orange', 'teal', 'indigo', 'pink'];

const DEFAULT_CATEGORIES: PortalCategory[] = [
  { id: 'cat-ai',    name: 'AI 도구',   color: 'purple', order: 0 },
  { id: 'cat-dev',   name: '개발',      color: 'blue',   order: 1 },
  { id: 'cat-work',  name: '업무',      color: 'green',  order: 2 },
  { id: 'cat-folder',name: '폴더',      color: 'amber',  order: 3 },
  { id: 'cat-misc',  name: '기타',      color: 'teal',   order: 4 },
];

function defaultPortalCategories(): PortalCategory[] {
  return DEFAULT_CATEGORIES.map(category => ({ ...category }));
}

function emptyPortalData(): PortalData {
  return { items: [], categories: defaultPortalCategories() };
}

function normalizeLoadedPortalData(value: unknown): PortalData {
  return normalizePortalCollectionData<PortalItem, PortalCategory>(
    value,
    DEFAULT_CATEGORIES,
  ) as PortalData;
}

function withPendingCloudDeletes(
  data: PortalData,
  pendingCloudDeletes: PortalCloudDeleteQueue | undefined,
): PortalData {
  const normalized = { ...data };
  // 이 필드는 import 파일이 아니라 현재 브라우저의 삭제 재시도 상태만 신뢰한다.
  delete normalized.pendingCloudDeletes;
  if (pendingCloudDeletes) normalized.pendingCloudDeletes = pendingCloudDeletes;
  return normalized;
}

// ─── Tauri detection ──────────────────────────────────────────────────────────
// isTauri / isDeployedWeb 는 ./lib/env 에서 import

const PORTAL_WEB_KEY = 'portalData_v1';

// 공개 빌드에는 개인 포털 기본값이 없다. 빌드 소유자가 배포 환경에서 명시한
// HTTPS 주소만 fallback으로 사용한다.
const CONFIGURED_PERSONAL_PORTAL_URL = normalizeHttpsPortalBaseUrl(
  import.meta.env.VITE_PORTAL_URL as string | undefined,
);

function resolvePersonalPortalUrl(portalData: PortalData): string | null {
  return normalizeVercelPortalDeployUrl(portalData.portalDeployUrl)
    ?? CONFIGURED_PERSONAL_PORTAL_URL;
}

// ─── Portal API ───────────────────────────────────────────────────────────────

const PortalAPI = {
  async load(): Promise<PortalData> {
    // Deployed web (Vercel etc): localStorage is the only storage
    if (isDeployedWeb()) {
      const raw = localStorage.getItem(PORTAL_WEB_KEY);
      if (!raw) return emptyPortalData();
      try {
        return normalizeLoadedPortalData(JSON.parse(raw));
      } catch (error) {
        throw new Error(
          `이 브라우저에 저장된 북마크 데이터를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      if (isTauri()) {
        const val = await invoke<PortalData>('load_portal');
        return val == null ? emptyPortalData() : normalizeLoadedPortalData(val);
      }
      const res = await fetch('/api/portal');
      if (!res.ok) throw new Error(`로컬 포털 API가 HTTP ${res.status}로 응답했습니다.`);
      const data = normalizeLoadedPortalData(await res.json());
      // Mirror full data to localStorage for offline/Vercel fallback
      localStorage.setItem('portalData', JSON.stringify(data));
      if (data.supabaseUrl || data.supabaseAnonKey) {
        localStorage.setItem('portalCreds', JSON.stringify({
          supabaseUrl: data.supabaseUrl,
          supabaseAnonKey: data.supabaseAnonKey,
          deviceId: data.deviceId,
        }));
      }
      return data;
    } catch (error) {
      // Native identity and credentials are owned by portal.json. Falling
      // through to browser caches here can silently turn this app into a
      // different device after a transient read/parse failure.
      if (isTauri()) throw error;
      // api-server is down (Vercel / offline) — restore from localStorage
      const full = localStorage.getItem('portalData');
      if (full) {
        try { return normalizeLoadedPortalData(JSON.parse(full)); } catch { /* fall through */ }
      }
      // portalData_v1: written by deployed-web save path; check as secondary fallback
      const webData = localStorage.getItem(PORTAL_WEB_KEY);
      if (webData) {
        try {
          return normalizeLoadedPortalData(JSON.parse(webData));
        } catch { /* ignore */ }
      }
      const cached = localStorage.getItem('portalCreds');
      if (cached) {
        try {
          const { supabaseUrl, supabaseAnonKey, deviceId } = JSON.parse(cached);
          return { ...emptyPortalData(), supabaseUrl, supabaseAnonKey, deviceId };
        } catch {
          // ignore malformed cache
        }
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  },

  async save(data: PortalData): Promise<void> {
    // Deployed web: persist to localStorage only
    if (isDeployedWeb()) {
      localStorage.setItem(PORTAL_WEB_KEY, JSON.stringify(data));
      return;
    }
    if (isTauri()) {
      await invoke('save_portal', { data });
      return;
    }
    // Always persist to localStorage (Vercel / offline support)
    localStorage.setItem('portalData', JSON.stringify(data));
    if (data.supabaseUrl || data.supabaseAnonKey) {
      localStorage.setItem('portalCreds', JSON.stringify({
        supabaseUrl: data.supabaseUrl,
        supabaseAnonKey: data.supabaseAnonKey,
        deviceId: data.deviceId,
      }));
    }
    try {
      await fetch('/api/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {
      // api-server unavailable — data already saved to localStorage above
    }
  },

  async openUrl(url: string): Promise<void> {
    if (isTauri()) {
      await invoke('open_in_chrome', { url, profileDirectory: null });
    } else {
      window.open(url, '_blank', 'noopener');
    }
  },

  async openFolder(path: string): Promise<void> {
    if (isTauri()) {
      await invoke('open_folder', { folderPath: path });
    } else if (isDeployedWeb()) {
      // Vercel context: can't open local folder — copy path to clipboard
      await navigator.clipboard.writeText(path);
      throw Object.assign(new Error('__clipboard__'), { path });
    } else {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: path }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error || '폴더 열기 실패');
      }
    }
  },

  async pickFolder(): Promise<string | null> {
    if (isTauri()) {
      const selected = await openDialog({ directory: true, multiple: false });
      return typeof selected === 'string' ? selected : null;
    }
    return null;
  },
};

// ─── Device ID ───────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Form default state ───────────────────────────────────────────────────────

const EMPTY_FORM = { name: '', type: 'web' as 'web' | 'folder', url: '', path: '', category: '', description: '', pinned: false };

// ─── Component ────────────────────────────────────────────────────────────────

export interface PortalActions {
  push: () => void;
  pull: () => void;
  history: () => void;
  exportData: () => void;
  importData: () => void;
  openSettings: () => void;
}

interface Props {
  showToast: (msg: string, type: 'success' | 'error') => void;
  openSettings?: boolean; // when true, open settings modal immediately
  onSettingsClosed?: () => void;
  actionsRef?: React.MutableRefObject<PortalActions | null>;
  isVisible?: boolean; // false → hide portal UI but keep modals alive
  onChangeDevice?: () => void;
  /** 배포 포털의 공용 Mac·Windows·AWS 단말 관리 화면을 연다. */
  onManageDevices?: () => void;
  onOpenDeployUrl?: (url: string) => Promise<void>;
  /** 상단에서 조회 중인 프로젝트 단말. 이 브라우저의 신원과는 별개다. */
  selectedProjectDevice?: { id: string; name?: string | null } | null;
  onSyncStateChange?: (state: { isSyncing: boolean; isRestoring: boolean }) => void;
}

// AI_TABLE_PROMPT / DDL 정본은 src/schemaSql.ts — 여기서 다시 정의하지 말 것.
// (프리픽스 없는 구버전 테이블을 만들면 앱의 Push/Pull이 전부 PGRST205로 실패한다)

interface AdvancedSettingsProps {
  deviceId?: string;
  deviceName?: string;
  viewingDeviceId: string;
  knownDevices: {device_id: string; device_name?: string; handoff_note?: string; handoff_updated_at?: string}[];
  isFetchingDevices: boolean;
  onFetchDevices: () => void;
  onSelectDevice: (id: string) => void;
  onResetDevice: () => void;
  onCopyDeviceId: () => void;
  onCopyAgentsToZBotPrompt: () => void;
  handoffNote: string;
  onChangeHandoffNote: (note: string) => void;
  onSaveHandoffNote: () => void;
  isSavingHandoffNote: boolean;
}

function relativeTimeFromNow(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '방금 업데이트';
  if (mins < 60) return `${mins}분 전 업데이트`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전 업데이트`;
  const days = Math.floor(hours / 24);
  return `${days}일 전 업데이트`;
}

function AdvancedSettings({ deviceId, deviceName, viewingDeviceId, knownDevices, isFetchingDevices, onFetchDevices, onSelectDevice, onResetDevice, onCopyDeviceId, onCopyAgentsToZBotPrompt, handoffNote, onChangeHandoffNote, onSaveHandoffNote, isSavingHandoffNote }: AdvancedSettingsProps) {
  const [open, setOpen] = React.useState(false);
  const viewingDevice = viewingDeviceId ? knownDevices.find(d => d.device_id === viewingDeviceId) : undefined;
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#18181b]/60 border border-stone-700/50 rounded-lg text-xs text-zinc-400 hover:border-stone-700/60 transition-all"
      >
        <span className="flex items-center gap-1.5">
          <Settings2 className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-zinc-400">고급 설정</span>
          {viewingDeviceId && viewingDeviceId !== deviceId && (
            <span className="text-amber-400 text-[10px]">• 다른 기기 보는 중</span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 bg-[#111113]/60 border border-stone-700/40 rounded-lg p-3 space-y-3">
          {/* Device ID */}
          <div>
            <label className="block text-[10px] text-zinc-500 mb-1">Device ID</label>
            <div className="flex items-center gap-1.5">
              <input readOnly value={deviceId ? `${deviceId.slice(0, 16)}…` : '—'}
                className="flex-1 px-2.5 py-1.5 text-xs bg-black/30 border border-stone-700/50 text-zinc-500 rounded-lg cursor-default" />
              <button onClick={onCopyDeviceId}
                className="px-2.5 py-1.5 text-xs bg-[#18181b] hover:bg-[#202024] text-zinc-400 border border-stone-700/50 rounded-lg transition-all">복사</button>
            </div>
            <button
              onClick={onCopyAgentsToZBotPrompt}
              className="mt-2 w-full px-2.5 py-1.5 text-[10px] bg-cyan-500/10 hover:bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 rounded-lg transition-all"
              title="현재 단말 기준 agentstoz-bot / cs-ceo 생성 프롬프트를 복사합니다"
            >
              agentstoz-bot 생성 프롬프트 복사
            </button>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">설치마다 자동 생성되는 신원입니다. 다른 PC의 ID로 바꾸지 마세요. 같은 컴퓨터가 재설치 후 두 개로 보이면 장기기억의 ‘중복 단말 정리’에서 데이터 삭제 없이 한 단말로 묶습니다. 현재 단말 ID·로컬 API·두 Hermes profile을 포함하며 인증 정보는 포함하지 않습니다.</p>
          </div>
          {/* Handoff note — 이 기기 전용 (조회 중인 기기가 아닌, 항상 현재 기기의 메모) */}
          <div>
            <label className="block text-[10px] text-zinc-500 mb-1">핸드오프 메모 (이 기기)</label>
            <textarea
              value={handoffNote}
              onChange={e => onChangeHandoffNote(e.target.value)}
              placeholder="예: X 작업 중, Y 확인 필요…"
              rows={2}
              className="w-full px-2.5 py-1.5 text-xs bg-black/30 border border-stone-700/50 text-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all resize-none"
            />
            <div className="flex justify-end mt-1">
              <button
                onClick={onSaveHandoffNote}
                disabled={isSavingHandoffNote}
                className="px-2.5 py-1 text-[10px] bg-[#18181b] hover:bg-[#202024] text-zinc-400 border border-stone-700/50 rounded-lg transition-all disabled:opacity-50"
              >
                {isSavingHandoffNote ? '저장 중…' : '메모 저장'}
              </button>
            </div>
          </div>
          {/* Device switch */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] text-zinc-500">다른 기기 데이터 보기</label>
              <button onClick={onFetchDevices} disabled={isFetchingDevices}
                className="px-2 py-0.5 text-[10px] bg-[#18181b] hover:bg-[#202024] text-zinc-400 border border-stone-700/50 rounded transition-all disabled:opacity-50">
                {isFetchingDevices ? '조회 중…' : '단말 조회'}
              </button>
            </div>
            {(knownDevices.length > 0 || deviceId) ? (
              <>
                <select
                  value={viewingDeviceId || deviceId || ''}
                  onChange={e => onSelectDevice(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-black/30 border border-stone-700/50 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
                >
                  {/* Always show current device first */}
                  {deviceId && !knownDevices.find(d => d.device_id === deviceId) && (
                    <option value={deviceId}>
                      {deviceName || '이름 미설정'} (이 기기)
                    </option>
                  )}
                  {knownDevices.map(d => {
                    const isOwn = d.device_id === deviceId;
                    const name = isOwn
                      ? (deviceName || d.device_name)
                      : d.device_name;
                    const label = name || `기기 ${d.device_id.slice(0, 8)}…`;
                    return (
                      <option key={d.device_id} value={d.device_id}>
                        {label}{isOwn ? ' (이 기기)' : ''}
                      </option>
                    );
                  })}
                </select>
                {viewingDeviceId && viewingDeviceId !== deviceId && (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-[10px] text-amber-400">⚠ Pull 시 선택한 기기 데이터 적용됨</p>
                    {viewingDevice?.handoff_note && (
                      <div className="px-2 py-1.5 bg-amber-500/10 border border-amber-500/25 rounded-lg">
                        <p className="text-[11px] text-amber-200 whitespace-pre-wrap">{viewingDevice.handoff_note}</p>
                        {viewingDevice.handoff_updated_at && (
                          <p className="text-[9.5px] text-amber-400/70 mt-0.5">{relativeTimeFromNow(viewingDevice.handoff_updated_at)}</p>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button onClick={onResetDevice} className="text-[10px] text-zinc-500 hover:text-[#f4f4f5]/90 underline">내 기기로 복귀</button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[10px] text-[#71717a] italic">단말 조회 버튼으로 다른 기기 목록을 불러오세요</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SetupGuide() {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [copied, setCopied] = React.useState(false);
  const [loginLoading, setLoginLoading] = React.useState(false);
  const [allowedEmail, setAllowedEmail] = React.useState('');
  const allowedEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail.trim());
  const aiTablePrompt = allowedEmailValid
    ? aiTablePromptForAllowedEmails([allowedEmail])
    : '먼저 Google owner 이메일을 입력하세요. server membership이 비어 있으면 모든 계정이 차단됩니다.';

  const handleSupabaseLogin = async () => {
    setLoginLoading(true);
    try {
      await fetch('/api/supabase-login', { method: 'POST' });
    } catch {}
    setTimeout(() => setLoginLoading(false), 2000);
  };

  const CLI_FIRST_SETUP = `# Supabase 동기화 최초 설정

## 1. 로컬 앱 먼저 실행
bun install
bun run start
# Vite를 직접 실행하지 않는다.

## 2. Supabase 프로젝트 만들기 (동기화가 필요할 때만)
https://supabase.com → New project
# 로컬 포트·프로세스 관리만 쓸 경우 이 단계는 건너뛸 수 있다.

## 3. 앱의 초기 설정 마법사에서 입력
- Project URL + anon/public key
- 이 기기의 이름
# 값은 앱 데이터의 portal.json에 저장된다. 채팅이나 소스 파일에 키를 쓰지 않는다.

## 4. ${SCHEMA_TABLE_COUNT}개 테이블과 RLS 적용
- 아래 "AI 테이블 생성" 탭에서 owner 이메일을 입력해 만든 personalized 프롬프트를 사용한다.
- Supabase CLI를 쓸 경우: supabase login → supabase link --project-ref <ref>
- RLS를 끄거나 anon 허용 정책을 추가하지 않는다.

## 5. 동기화 확인
- Supabase Redirect URL에 http://127.0.0.1:9000/을 허용한다.
- 같은 origin의 http://127.0.0.1:9000/portal.html에서 Google 로그인한다.
- callback 뒤 root 앱으로 돌아와 Push/Pull의 실제 행 변화를 확인한다. anon key만으로는 RLS를 통과하지 않는다.
- Tauri는 browser session을 공유한다고 가정하지 말고, 별도 OAuth 증거가 없으면 browser mode를 사용한다.
`;

  const CLI_ADDITIONAL_DEVICE = `# 추가 단말 세팅 (기존 Supabase 프로젝트 공유)

## 1. 기존 저장소 가져오기
git clone <현재 사용하는 저장소 URL>
# 이미 내려받았다면 git pull

## 2. 로컬 실행
bun install
bun run start

## 3. 초기 설정 마법사에서 연결
- 기존과 같은 Project URL + anon/public key 입력
- 새 기기 이름 입력 (기기마다 고유)
- 테이블은 이미 있으면 다시 만들 필요 없음

## 4. Pull
- 포털/프로젝트 영역에서 Google 로그인 후 Pull 실행
`;

  const VERCEL_GUIDE = `# 포털 북마크 — Vercel 배포 가이드

## 전제조건
- Supabase 프로젝트와 ${SCHEMA_TABLE_COUNT}개 앱 테이블의 RLS 설정 완료
- 이 저장소의 vercel.json, vite.portal.config.ts를 그대로 사용

## 1. Vercel CLI 로그인
npm install -g vercel
vercel login

## 2. 환경변수 등록
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
vercel env add VITE_ALLOWED_EMAIL   # 선택: 허용할 Google 이메일 목록

## 3. 배포
vercel
vercel --prod

## 4. Google 로그인 설정
- Google OAuth Client ID/Secret은 Supabase Authentication → Providers → Google에 설정
- Vercel URL은 Supabase Authentication → URL Configuration의 Redirect URLs에 추가
- VITE_ALLOWED_EMAIL은 UI prefilter다. 실제 접근은 portmgr_allowed_members에 등록된 계정만 허용한다.

## 주의사항
- 포트 실행/중지, 빌드, 터미널, Codex 보이스는 로컬 전용
- 웹에서는 포털/동기화 기능만 사용한다.
`;

  const steps = [
    {
      title: '🆕 최초 세팅',
      content: (
        <div className="space-y-2">
          <p className="text-[#f4f4f5]/90 text-[11px]">Supabase CLI + MCP 방식으로 처음 설정하는 경우</p>
          <pre className="bg-black/40 rounded p-2 text-zinc-400 whitespace-pre-wrap text-[10px] max-h-52 overflow-y-auto leading-relaxed">{CLI_FIRST_SETUP}</pre>
          <div className="flex gap-2">
            <button
              onClick={() => { navigator.clipboard.writeText(CLI_FIRST_SETUP); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="flex-1 py-1 rounded-lg border text-[10px] font-medium transition-all flex items-center justify-center gap-1.5 bg-[#18181b] hover:bg-[#202024] text-zinc-400 border-stone-700/60"
            >
              <Database className="w-3 h-3" />
              가이드 복사
            </button>
            <button
              onClick={handleSupabaseLogin}
              disabled={loginLoading}
              className="flex-1 py-1 rounded-lg border text-[10px] font-medium transition-all flex items-center justify-center gap-1.5 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 border-indigo-700/50 disabled:opacity-50"
            >
              <Terminal className="w-3 h-3" />
              {loginLoading ? '터미널 열는 중...' : 'supabase login 실행'}
            </button>
          </div>
        </div>
      ),
    },
    {
      title: '💻 추가 단말 세팅',
      content: (
        <div className="space-y-2">
          <p className="text-[#f4f4f5]/90 text-[11px]">기존 Supabase 프로젝트에 새 맥/PC를 추가하는 경우</p>
          <pre className="bg-black/40 rounded p-2 text-zinc-400 whitespace-pre-wrap text-[10px] max-h-52 overflow-y-auto leading-relaxed">{CLI_ADDITIONAL_DEVICE}</pre>
          <button
            onClick={() => { navigator.clipboard.writeText(CLI_ADDITIONAL_DEVICE); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className="w-full py-1 rounded-lg border text-[10px] font-medium transition-all flex items-center justify-center gap-1.5 bg-[#18181b] hover:bg-[#202024] text-zinc-400 border-stone-700/60"
          >
            <Database className="w-3 h-3" />
            가이드 복사
          </button>
        </div>
      ),
    },
    {
      title: '🤖 AI 테이블 생성',
      content: (
        <div className="space-y-2">
          <p className="text-[#f4f4f5]/90 text-[11px]">Claude Code + Supabase MCP로 테이블 자동 생성</p>
          <input
            type="email"
            value={allowedEmail}
            onChange={event => setAllowedEmail(event.target.value)}
            placeholder="owner@example.com"
            className="w-full rounded-lg border border-stone-700/60 bg-black/30 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-indigo-500/60"
          />
          <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-[10px]">
            <li>Claude Code 터미널 열기</li>
            <li>Supabase MCP 연결 확인 (<code className="text-[#f4f4f5]/90 bg-black/30 px-0.5 rounded">/mcp-setup</code>)</li>
            <li>아래 프롬프트 복사 → Claude Code에 붙여넣기</li>
            <li>AI가 {SCHEMA_TABLE_COUNT}개 테이블과 로그인 사용자용 RLS 정책을 함께 적용</li>
          </ol>
          <pre className="bg-black/40 rounded p-2 text-zinc-500 whitespace-pre-wrap text-[10px] max-h-36 overflow-y-auto">{aiTablePrompt}</pre>
          <button
            disabled={!allowedEmailValid}
            onClick={() => { navigator.clipboard.writeText(aiTablePrompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
            className={`w-full py-1.5 rounded-lg border text-xs font-medium transition-all flex items-center justify-center gap-1.5 ${
              copied ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 border-stone-700/60'
            }`}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Database className="w-3.5 h-3.5" />}
            {copied ? '복사됨!' : 'AI 프롬프트 복사'}
          </button>
        </div>
      ),
    },
    {
      title: '🚀 Vercel 배포',
      content: (
        <div className="space-y-2">
          <p className="text-[#f4f4f5]/90 text-[11px]">포털 북마크를 웹에 배포 — 앱 없이 브라우저에서 접근 가능</p>
          <pre className="bg-black/40 rounded p-2 text-zinc-400 whitespace-pre-wrap text-[10px] max-h-52 overflow-y-auto leading-relaxed">{VERCEL_GUIDE}</pre>
          <button
            onClick={() => { navigator.clipboard.writeText(VERCEL_GUIDE); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className={`w-full py-1.5 rounded-lg border text-xs font-medium transition-all flex items-center justify-center gap-1.5 ${
              copied ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 border-stone-700/60'
            }`}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
            {copied ? '복사됨!' : '가이드 복사'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#18181b]/60 border border-stone-700/50 rounded-lg text-xs text-zinc-400 hover:border-stone-700/60 transition-all"
      >
        <span className="flex items-center gap-1.5">
          <Database className="w-3.5 h-3.5 text-indigo-400" />
          <span className="font-medium text-[#f4f4f5]/90">초기 설정 가이드</span>
          <span className="text-[#71717a]">— 처음 사용 시</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 bg-[#111113]/60 border border-stone-700/40 rounded-lg overflow-hidden">
          {/* Step tabs */}
          <div className="flex border-b border-stone-700/40 overflow-x-auto">
            {steps.map((s, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`flex-shrink-0 px-3 py-2 text-[10px] font-medium transition-all border-b-2 ${
                  step === i
                    ? 'border-indigo-500 text-indigo-300 bg-indigo-500/5'
                    : 'border-transparent text-zinc-500 hover:text-[#f4f4f5]/90'
                }`}
              >
                {s.title}
              </button>
            ))}
          </div>
          {/* Step content */}
          <div className="p-3 text-xs">
            {steps[step]?.content}
            <div className="flex gap-2 mt-3">
              {step > 0 && (
                <button onClick={() => setStep(s => s - 1)} className="flex-1 py-1 text-[10px] bg-[#18181b] hover:bg-[#202024] text-zinc-400 rounded border border-stone-700/50 transition-all">← 이전</button>
              )}
              {step < steps.length - 1 && (
                <button onClick={() => setStep(s => s + 1)} className="flex-1 py-1 text-[10px] bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 rounded border border-indigo-500/30 transition-all">다음 →</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PortalManager({ showToast, openSettings, onSettingsClosed, actionsRef, isVisible = true, onChangeDevice, onManageDevices, onOpenDeployUrl, selectedProjectDevice, onSyncStateChange }: Props) {
  const [data, setData] = useState<PortalData>(emptyPortalData);
  const dataRef = useRef(data);
  const [selectedCat, setSelectedCat] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncOk, setSyncOk] = useState<boolean | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [showPortalHistory, setShowPortalHistory] = useState(false);
  const [portalHistoryList, setPortalHistoryList] = useState<PushSnapshot[]>([]);
  const [portalHistoryLoading, setPortalHistoryLoading] = useState(false);
  const [portalHistoryRestoring, setPortalHistoryRestoring] = useState<string | null>(null);

  // Modals
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<PortalItem | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const [showCatModal, setShowCatModal] = useState(false);
  const [catForm, setCatForm] = useState({ name: '', color: 'blue' as ColorKey });

  const [showSettings, setShowSettings] = useState(false);
  const [sbUrl, setSbUrl] = useState('');
  const [sbKey, setSbKey] = useState('');
  const [authenticatedSessionEmail, setAuthenticatedSessionEmail] = useState<string | null>(null);
  const [nativeAuthBusy, setNativeAuthBusy] = useState(false);
  // service_role 키는 상태로 들고 있지 않는다 — 있는지 여부만 서버에서 받아 표시한다.
  const [serviceKeyPresent, setServiceKeyPresent] = useState(false);
  const [serviceKeyInput, setServiceKeyInput] = useState('');
  const [serviceKeyBusy, setServiceKeyBusy] = useState(false);
  const [vocAdminBusy, setVocAdminBusy] = useState(false);
  const [vocAdminError, setVocAdminError] = useState('');
  const [vocAdminConfigured, setVocAdminConfigured] = useState<boolean | null>(null);
  const [vocDailyLimit, setVocDailyLimit] = useState(10);
  const [vocAccepting, setVocAccepting] = useState(true);
  const [vocBlockHash, setVocBlockHash] = useState('');
  const [vocBlockScope, setVocBlockScope] = useState<'voc' | 'app'>('voc');
  const [vocBlockNote, setVocBlockNote] = useState('');
  const [vocBlockExpires, setVocBlockExpires] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [isSavingHandoffNote, setIsSavingHandoffNote] = useState(false);
  const [viewingDeviceId, setViewingDeviceId] = useState(
    () => isDeployedWeb() ? '' : (localStorage.getItem('portal-viewing-device') ?? '')
  );
  const [knownDevices, setKnownDevices] = useState<{device_id: string; device_name?: string; handoff_note?: string; handoff_updated_at?: string}[]>([]);
  const [isFetchingDevices, setIsFetchingDevices] = useState(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    onSyncStateChange?.({ isSyncing, isRestoring });
  }, [isRestoring, isSyncing, onSyncStateChange]);

  const refreshSettingsIdentity = useCallback(async () => {
    const loaded = await PortalAPI.load();
    const identity = resolvePortalDeviceIdentity({
      runtime: isTauri() ? 'tauri' : 'web',
      portalDeviceId: loaded.deviceId,
      createId: () => crypto.randomUUID(),
      getBrowserDeviceId: getOwnDeviceId,
    });
    loaded.deviceId = identity.deviceId;
    // 배포 브라우저는 프로젝트를 "보는 화면"이지 Mac/Windows/Linux 물리 단말이 아니다.
    // 브라우저 localStorage ID에 선택한 Mac 이름을 붙이면 설정 목록에 같은 Mac이 두 번
    // 생기고 다음 Push에서 가짜 portmgr_devices 행까지 만들어진다.
    const deployedWeb = isDeployedWeb();
    let resolvedName = deployedWeb ? '' : (loaded.deviceName ?? (loaded as any)._hostname ?? '');
    const resolvedUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || loaded.supabaseUrl || '';
    const resolvedKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || loaded.supabaseAnonKey || '';
    // 설정을 열 때는 이 브라우저와 같은 ID의 최신 등록명을 다시 읽는다.
    // 기기 관리에서 이름을 바꿔도 예전 localStorage 이름이 남아 서로 다르게 보이던 오류를 막는다.
    if (!deployedWeb && resolvedUrl && resolvedKey) {
      try {
        const supabase = getSupabaseClient(resolvedUrl, resolvedKey);
        await supabase.auth.getSession();
        const { data: device } = await supabase.from('portmgr_devices').select('name').eq('id', identity.deviceId).maybeSingle();
        if (device?.name) resolvedName = device.name;
      } catch { /* 오프라인이면 로컬 이름을 계속 쓴다. */ }
    }
    loaded.deviceName = resolvedName || undefined;
    if (deployedWeb) {
      loaded.viewingDeviceId = undefined;
      loaded.handoffNote = undefined;
    }
    setSbUrl(resolvedUrl);
    setSbKey(resolvedKey);
    setDeviceName(resolvedName);
    setData(current => ({ ...current, deviceId: identity.deviceId, deviceName: resolvedName || current.deviceName }));
    await PortalAPI.save(loaded);
  }, []);

  useEffect(() => {
    if (viewingDeviceId) {
      localStorage.setItem('portal-viewing-device', viewingDeviceId);
    } else {
      localStorage.removeItem('portal-viewing-device');
    }
  }, [viewingDeviceId]);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    setIsLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const loaded = await PortalAPI.load();
        if (!loaded.categories?.length) loaded.categories = defaultPortalCategories();
        const identity = resolvePortalDeviceIdentity({
          runtime: isTauri() ? 'tauri' : 'web',
          portalDeviceId: loaded.deviceId,
          createId: () => crypto.randomUUID(),
          getBrowserDeviceId: getOwnDeviceId,
        });
        loaded.deviceId = identity.deviceId;
        let needsPersist = identity.needsPersist;
        dataRef.current = loaded;
        setData(loaded);
        const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
        const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
        setSbUrl(envUrl || loaded.supabaseUrl || '');
        setSbKey(envKey || loaded.supabaseAnonKey || '');
        // env var이 있으면 항상 우선 사용 (Google OAuth 세션과 동일 프로젝트 보장)
        if (envUrl) loaded.supabaseUrl = envUrl;
        if (envKey) loaded.supabaseAnonKey = envKey;
        const resolvedUrl = envUrl || loaded.supabaseUrl;
        const resolvedKey = envKey || loaded.supabaseAnonKey;

        // Auto-recognize device name from Supabase devices table if not set locally
        if (!loaded.deviceName && resolvedUrl && resolvedKey && loaded.deviceId) {
          try {
            const sb = getSupabaseClient(resolvedUrl, resolvedKey);
            const { data: dev } = await sb.from('portmgr_devices').select('name').eq('id', loaded.deviceId).maybeSingle();
            if (dev?.name) {
              loaded.deviceName = dev.name;
              needsPersist = true;
            }
          } catch { /* ignore — offline or table missing */ }
        }

        setDeviceName(isDeployedWeb() ? '' : (loaded.deviceName ?? (loaded as any)._hostname ?? ''));
        setHandoffNote(loaded.handoffNote ?? '');
        setViewingDeviceId(isDeployedWeb() ? '' : (loaded.viewingDeviceId ?? ''));
        if (isDeployedWeb()) {
          const hadPhysicalDeviceFields = !!(loaded.deviceName || loaded.viewingDeviceId || loaded.handoffNote);
          loaded.deviceName = undefined;
          loaded.viewingDeviceId = undefined;
          loaded.handoffNote = undefined;
          localStorage.removeItem('portal-viewing-device');
          needsPersist = needsPersist || hadPhysicalDeviceFields;
        }
        // Persist migrated deviceId / auto-fetched name back to its runtime owner.
        if (needsPersist) await PortalAPI.save(loaded);
      } catch (error) {
        console.error('[PortalManager] Failed to load authoritative portal config:', error);
        const message = isTauri()
          ? 'portal.json을 읽지 못해 기기 동기화를 중단했습니다. 앱 데이터 설정을 확인하세요.'
          : '포털 설정을 읽지 못했습니다.';
        setLoadError(message);
        showToast(message, 'error');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [loadRetryNonce]);

  // Open settings modal when parent triggers it — reload fresh data each time
  useEffect(() => {
    if (openSettings) {
      void refreshSettingsIdentity().catch(() => {});
      setShowSettings(true);
    }
  }, [openSettings, refreshSettingsIdentity]);

  // Notify parent when settings modal closes
  useEffect(() => {
    if (!showSettings && onSettingsClosed) onSettingsClosed();
  }, [showSettings]);

  // service_role 키는 로컬 서버 파일에 있으므로, 설정을 열 때마다 현재 상태를 서버에 묻는다.
  useEffect(() => {
    if (!showSettings || isDeployedWeb()) return;
    fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/supabase-service-key`)
      .then(r => r.json())
      .then(d => setServiceKeyPresent(!!d?.present))
      .catch(() => setServiceKeyPresent(false));
  }, [showSettings]);

  const loadVocAdmin = useCallback(async () => {
    if (isDeployedWeb() || !serviceKeyPresent) return;
    setVocAdminBusy(true);
    setVocAdminError('');
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc-admin/settings`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'VOC 설정 조회 실패');
      setVocAdminConfigured(body.configured === true);
      setVocAccepting(body.accepting === true);
      setVocDailyLimit(Number(body.dailyLimit) || 10);
    } catch (error) {
      setVocAdminConfigured(false);
      setVocAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      setVocAdminBusy(false);
    }
  }, [serviceKeyPresent]);

  useEffect(() => {
    if (showSettings && serviceKeyPresent) void loadVocAdmin();
  }, [showSettings, serviceKeyPresent, loadVocAdmin]);

  const saveVocAdmin = async () => {
    setVocAdminBusy(true);
    setVocAdminError('');
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc-admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepting: vocAccepting, dailyLimit: vocDailyLimit }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'VOC 설정 저장 실패');
      setVocAdminConfigured(body.configured === true);
      setVocAccepting(body.accepting === true);
      setVocDailyLimit(Number(body.dailyLimit) || 10);
      showToast('공개 VOC 접수 설정을 저장했습니다.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVocAdminError(message);
      showToast(message, 'error');
    } finally {
      setVocAdminBusy(false);
    }
  };

  const saveVocBlock = async () => {
    setVocAdminBusy(true);
    setVocAdminError('');
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc-admin/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceHash: vocBlockHash,
          scope: vocBlockScope,
          operatorNote: vocBlockNote,
          expiresAt: vocBlockExpires ? new Date(vocBlockExpires).toISOString() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '단말 차단 실패');
      showToast(vocBlockScope === 'app' ? '해당 설치본의 앱 사용을 차단했습니다.' : '해당 설치본의 VOC 전송을 차단했습니다.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVocAdminError(message);
      showToast(message, 'error');
    } finally {
      setVocAdminBusy(false);
    }
  };

  const clearVocBlock = async () => {
    setVocAdminBusy(true);
    setVocAdminError('');
    try {
      const query = new URLSearchParams({ deviceHash: vocBlockHash });
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc-admin/block?${query}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '단말 차단 해제 실패');
      showToast('해당 설치본의 차단을 해제했습니다.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVocAdminError(message);
      showToast(message, 'error');
    } finally {
      setVocAdminBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (isTauri() || !showSettings || !sbUrl || !sbKey) {
      setAuthenticatedSessionEmail(null);
      return () => { active = false; };
    }
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      void supabase.auth.getSession().then(({ data: auth }) => {
        if (active) setAuthenticatedSessionEmail(auth.session?.user.email ?? null);
      }).catch(() => {
        if (active) setAuthenticatedSessionEmail(null);
      });
    } catch {
      setAuthenticatedSessionEmail(null);
    }
    return () => { active = false; };
  }, [showSettings, sbUrl, sbKey]);

  const loginNativeSupabase = async () => {
    if (isTauri()) {
      showToast('데스크톱 앱은 Google 로그인이 필요하지 않습니다.', 'success');
      return;
    }
    if (isDeployedWeb()) {
      showToast('배포 포털의 기존 Google 로그인 화면을 사용하세요.', 'error');
      return;
    }
    if (!sbUrl || !sbKey) {
      showToast('Project URL과 Anon Key를 먼저 입력하세요.', 'error');
      return;
    }
    setNativeAuthBusy(true);
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const authOptions = {
        onStatus: (status: string) => showToast(status, 'success'),
      };
      const session = await signInBrowserSupabase(supabase, authOptions);
      const { data: isMember, error } = await supabase.rpc('portmgr_is_member');
      if (error || isMember !== true) {
        throw new Error(
          `DB 허용 이메일 정책 거부${error ? `: ${describeSupabaseError(error)}` : ': 현재 계정이 server member가 아닙니다.'}`,
        );
      }
      setAuthenticatedSessionEmail(session.user.email ?? 'authenticated');
      showToast('Google 로그인과 DB 접근 권한을 확인했습니다.', 'success');
    } catch (error: any) {
      showToast(error?.message || String(error), 'error');
    } finally {
      setNativeAuthBusy(false);
    }
  };

  const saveServiceRoleKey = async (key: string) => {
    setServiceKeyBusy(true);
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/supabase-service-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceRoleKey: key }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `저장 실패 (${res.status})`);
      setServiceKeyPresent(!!body.present);
      setServiceKeyInput('');
      showToast(
        body.present
          ? 'service_role 키를 저장했습니다. 장기기억 동기화를 다시 시도해보세요.'
          : 'service_role 키를 삭제했습니다.',
        'success',
      );
    } catch (e: any) {
      showToast(e?.message || String(e), 'error');
    } finally {
      setServiceKeyBusy(false);
    }
  };

  const importServiceRoleKeyFromCli = async () => {
    setServiceKeyBusy(true);
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/supabase-service-key/from-cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `가져오기 실패 (${res.status})`);
      setServiceKeyPresent(true);
      setServiceKeyInput('');
      showToast(`Supabase CLI에서 service_role 키를 가져왔습니다 (${body.projectRef}).`, 'success');
    } catch (e: any) {
      showToast(e?.message || String(e), 'error');
    } finally {
      setServiceKeyBusy(false);
    }
  };

  // 초기 로드 시 Supabase에서 자동 Pull — 로컬 데이터가 비어있으면 Supabase 데이터로 채움
  useEffect(() => {
    if (!sbUrl || !sbKey) return;
    if (data.items.length === 0) {
      // 로컬 북마크 없으면 즉시 Pull (confirm 없이)
      pullFromSupabase({ skipConfirm: true });
    }
  }, [sbUrl, sbKey]);

  // Expose action functions to parent via ref
  useEffect(() => {
    if (actionsRef) {
      actionsRef.current = {
        push: syncSupabase,
        pull: pullFromSupabase,
        history: openPortalHistory,
        exportData,
        importData,
        openSettings: () => {
          void refreshSettingsIdentity().catch(() => {});
          setShowSettings(true);
        },
      };
    }
  });

  type PersistOutcome = { localSaved: boolean; cloudSynced: boolean | null };

  const persist = useCallback(async (
    next: PortalData,
    options: { syncCloud?: boolean } = {},
  ): Promise<PersistOutcome> => {
    const previous = dataRef.current;
    const shouldTrackCloudDeletes = options.syncCloud !== false && isDeployedWeb();
    const pendingCloudDeletes = shouldTrackCloudDeletes
      ? buildPortalCloudDeleteQueue({
          pending: previous.pendingCloudDeletes,
          previousItemIds: previous.items.filter(item => item.type === 'web').map(item => item.id),
          nextItemIds: next.items.filter(item => item.type === 'web').map(item => item.id),
          previousCategoryIds: previous.categories.map(category => category.id),
          nextCategoryIds: next.categories.map(category => category.id),
        })
      : previous.pendingCloudDeletes;
    const localNext = withPendingCloudDeletes(next, pendingCloudDeletes);
    dataRef.current = localNext;
    setData(localNext);

    try {
      await PortalAPI.save(localNext);
    } catch (error) {
      dataRef.current = previous;
      setData(previous);
      showToast(`저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return { localSaved: false, cloudSynced: null };
    }

    const shouldSyncCloud = options.syncCloud !== false
      && isDeployedWeb()
      && !!localNext.supabaseUrl
      && !!localNext.supabaseAnonKey;
    if (!shouldSyncCloud) return { localSaved: true, cloudSynced: null };

    try {
      const supabase = getSupabaseClient(localNext.supabaseUrl!, localNext.supabaseAnonKey!);
      const itemRows = localNext.items
        .filter(i => i.type === 'web')
        .map(i => ({
          id: i.id, device_id: '__shared__', name: i.name, type: i.type,
          url: i.url ?? null, path: null, category: i.category,
          description: i.description ?? null, pinned: i.pinned,
          visit_count: i.visitCount, last_visited: i.lastVisited ?? null,
          created_at: i.createdAt ?? null,
        }));
      const catRows = localNext.categories.map(c => ({
        id: c.id, device_id: '__shared__', name: c.name, color: c.color, order: c.order,
      }));

      if (itemRows.length > 0) {
        const { error } = await supabase.from('portmgr_portal_items').upsert(itemRows, { onConflict: 'id' });
        if (error) throw new Error(describeSupabaseError(error));
      }
      if (catRows.length > 0) {
        const { error } = await supabase.from('portmgr_portal_categories').upsert(catRows, { onConflict: 'id' });
        if (error) throw new Error(describeSupabaseError(error));
      }

      if (pendingCloudDeletes?.itemIds.length) {
        const { error } = await supabase
          .from('portmgr_portal_items')
          .delete()
          .eq('device_id', '__shared__')
          .in('id', pendingCloudDeletes.itemIds);
        if (error) throw new Error(describeSupabaseError(error));
      }

      if (pendingCloudDeletes?.categoryIds.length) {
        const { error } = await supabase
          .from('portmgr_portal_categories')
          .delete()
          .eq('device_id', '__shared__')
          .in('id', pendingCloudDeletes.categoryIds);
        if (error) throw new Error(describeSupabaseError(error));
      }

      // 원격 삭제까지 확인된 뒤에만 로컬 tombstone을 지운다. 이 저장이 실패해도
      // 다음 시도에서 같은 ID를 다시 delete하는 것은 안전하고 멱등하다.
      if (pendingCloudDeletes) {
        const syncedNext = withPendingCloudDeletes(localNext, undefined);
        try {
          await PortalAPI.save(syncedNext);
          dataRef.current = syncedNext;
          setData(syncedNext);
        } catch {
          // 초기 로컬 저장은 성공했다. 큐를 남겨 다음 동기화에서 안전하게 재확인한다.
        }
      }
      return { localSaved: true, cloudSynced: true };
    } catch (error) {
      showToast(
        `${pendingCloudDeletes ? '삭제 대기 항목은 보존했습니다. 다음 저장 때 다시 시도합니다. ' : '이 브라우저에는 저장했습니다. '}`
          + `Supabase 동기화 실패: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return { localSaved: true, cloudSynced: false };
    }
  }, [showToast]);

  // ── Item CRUD ─────────────────────────────────────────────────────────────

  function openAddModal(defaultCat?: string) {
    setEditingItem(null);
    setForm({
      ...EMPTY_FORM,
      category: resolveBookmarkCategoryId(defaultCat ?? selectedCat, data.categories),
    });
    setShowItemModal(true);
  }

  function openEditModal(item: PortalItem) {
    setEditingItem(item);
    setForm({ name: item.name, type: item.type, url: item.url ?? '', path: item.path ?? '', category: item.category, description: item.description ?? '', pinned: item.pinned });
    setShowItemModal(true);
  }

  async function saveItem() {
    if (!form.name.trim()) {
      showToast('이름을 입력하세요', 'error');
      return;
    }
    // 북마크 탭은 URL 전용. 폴더는 '프로젝트·폴더' 탭에서 관리.
    let finalUrl = form.url.trim();
    if (!finalUrl) {
      showToast('URL을 입력하세요', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl;
    }
    const resolvedCategory = resolveBookmarkCategoryId(form.category, data.categories);
    if (!resolvedCategory) {
      showToast('카테고리를 먼저 추가하세요', 'error');
      return;
    }

    if (editingItem) {
      const next: PortalData = {
        ...data,
        items: data.items.map(i => i.id === editingItem.id
          ? { ...i, name: form.name, type: 'web', url: finalUrl, path: undefined, category: resolvedCategory, description: form.description || undefined, pinned: form.pinned }
          : i),
      };
      const outcome = await persist(next);
      if (!outcome.localSaved) return;
      if (outcome.cloudSynced !== false) showToast('수정되었습니다', 'success');
    } else {
      const newItem: PortalItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: form.name,
        type: 'web',
        url: finalUrl,
        path: undefined,
        category: resolvedCategory,
        description: form.description || undefined,
        pinned: form.pinned,
        visitCount: 0,
        createdAt: new Date().toISOString(),
      };
      const outcome = await persist({ ...data, items: [...data.items, newItem] });
      if (!outcome.localSaved) return;
      if (outcome.cloudSynced !== false) showToast('추가되었습니다', 'success');
    }
    setShowItemModal(false);
  }

  async function deleteItem(id: string) {
    const outcome = await persist({ ...data, items: data.items.filter(i => i.id !== id) });
    if (outcome.localSaved && outcome.cloudSynced !== false) showToast('삭제되었습니다', 'success');
  }

  async function togglePin(id: string) {
    await persist({ ...data, items: data.items.map(i => i.id === id ? { ...i, pinned: !i.pinned } : i) });
  }

  async function openItem(item: PortalItem) {
    try {
      if (item.type === 'web' && item.url) {
        if (isDeploymentPortalItem(item) && onOpenDeployUrl) {
          await onOpenDeployUrl(item.url);
        } else {
          await PortalAPI.openUrl(item.url);
        }
      } else if (item.type === 'folder' && item.path) {
        await PortalAPI.openFolder(item.path);
      }
      // increment visit count
      const next: PortalData = {
        ...data,
        items: data.items.map(i => i.id === item.id
          ? { ...i, visitCount: i.visitCount + 1, lastVisited: new Date().toISOString() }
          : i),
      };
      await persist(next);
    } catch (e: any) {
      if (e?.message === '__clipboard__') {
        showToast(`경로 복사됨 — Finder에서 ⇧⌘G 후 붙여넣기: ${e.path}`, 'success');
      } else {
        showToast('열기 실패: ' + e, 'error');
      }
    }
  }

  // ── Category CRUD ─────────────────────────────────────────────────────────

  async function addCategory() {
    if (!catForm.name.trim()) return;
    const newCat: PortalCategory = {
      id: `cat-${Date.now()}`,
      name: catForm.name.trim(),
      color: catForm.color,
      order: nextPortalCategoryOrder(data.categories),
    };
    const outcome = await persist({ ...data, categories: [...data.categories, newCat] });
    if (!outcome.localSaved) return;
    // 새 카테고리를 화면과 다음 북마크 폼의 기본값으로 즉시 연결한다.
    setSelectedCat(newCat.id);
    setCatForm({ name: '', color: 'blue' });
    setShowCatModal(false);
    if (outcome.cloudSynced !== false) {
      showToast(`“${newCat.name}” 선택됨 · 이제 북마크를 추가하세요`, 'success');
    }
  }

  async function deleteCategory(id: string) {
    const affectedCount = data.items.filter(i => i.category === id).length;
    const catName = data.categories.find(c => c.id === id)?.name ?? '카테고리';
    const msg = affectedCount > 0
      ? `"${catName}" 카테고리와 안에 있는 북마크 ${affectedCount}개가 모두 삭제됩니다.\n계속하시겠습니까?`
      : `"${catName}" 카테고리를 삭제하시겠습니까?`;
    if (!window.confirm(msg)) return;
    const next: PortalData = {
      ...data,
      categories: data.categories.filter(c => c.id !== id),
      items: data.items.filter(i => i.category !== id),
    };
    const outcome = await persist(next);
    if (!outcome.localSaved) return;
    if (selectedCat === id) setSelectedCat('all');
    const detail = affectedCount > 0 ? ` (북마크 ${affectedCount}개 포함)` : '';
    if (outcome.cloudSynced !== false) showToast(`카테고리 삭제됨${detail}`, 'success');
  }

  // ── Export / Import ───────────────────────────────────────────────────────

  async function exportData() {
    const json = JSON.stringify(data, null, 2);
    const defaultName = `portal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (isTauri()) {
      try {
        const path = await saveDialog({ defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!path) return;
        await writeTextFile(path, json);
        showToast('내보내기 완료', 'success');
      } catch (e) {
        showToast('내보내기 실패: ' + e, 'error');
      }
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
      showToast('내보내기 완료', 'success');
    }
  }

  async function importData() {
    if (!window.confirm('현재 북마크 데이터가 파일로 완전히 대체됩니다.\n계속하시겠습니까?')) return;
    if (isTauri()) {
      try {
        const selected = await openDialog({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!selected || typeof selected !== 'string') return;
        const text = await readTextFile(selected);
        const imported = JSON.parse(text) as PortalData;
        if (!imported.items || !imported.categories) throw new Error('올바른 포맷이 아닙니다');
        const outcome = await persist(imported);
        if (outcome.localSaved && outcome.cloudSynced !== false) showToast('불러오기 완료', 'success');
      } catch (err) {
        showToast('파일 오류: ' + err, 'error');
      }
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const imported = JSON.parse(text) as PortalData;
          if (!imported.items || !imported.categories) throw new Error('올바른 포맷이 아닙니다');
          const outcome = await persist(imported);
          if (outcome.localSaved && outcome.cloudSynced !== false) showToast('불러오기 완료', 'success');
        } catch (err) {
          showToast('파일 오류: ' + err, 'error');
        }
      };
      input.click();
    }
  }

  // ── Supabase Sync ─────────────────────────────────────────────────────────

  async function openPortalHistory() {
    if (!sbUrl || !sbKey) { showToast('Supabase 설정이 없습니다', 'error'); return; }
    setPortalHistoryLoading(true);
    setShowPortalHistory(true);
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const list = await fetchPushHistory(supabase, 'portmgr_portal_items', '__shared__');
      setPortalHistoryList(list);
    } catch (e) {
      // fetchPushHistory 는 이제 오류를 던진다 — 받지 않으면 스피너가 영원히 돈다.
      showToast(`히스토리를 읽지 못했습니다: ${describeSupabaseError(e)}`, 'error');
    } finally {
      setPortalHistoryLoading(false);
    }
  }

  async function restorePortalSnapshot(snapshotId: string) {
    if (!sbUrl || !sbKey) return;
    if (!window.confirm('이 시점으로 북마크를 복원하시겠습니까?\n현재 북마크가 교체됩니다.')) return;
    setPortalHistoryRestoring(snapshotId);
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const rows = await fetchSnapshotRows(supabase, snapshotId) as any[];
      if (rows.length === 0) { showToast('스냅샷이 비어있습니다', 'error'); return; }
      const { error: uErr } = await supabase.from('portmgr_portal_items').upsert(rows, { onConflict: 'id' });
      if (uErr) throw new Error(uErr.message);
      const snapshotIds = new Set(rows.map(r => r.id));
      // 공유 북마크(__shared__)만 정리 — 기기별 항목은 건드리지 않음
      const { data: current } = await supabase
        .from('portmgr_portal_items').select('id')
        .eq('device_id', '__shared__');
      const toDelete = (current ?? []).filter((r: any) => !snapshotIds.has(r.id)).map((r: any) => r.id);
      if (toDelete.length > 0) await supabase.from('portmgr_portal_items').delete().in('id', toDelete);
      await pullFromSupabase({ skipConfirm: true });
      showToast('스냅샷으로 복원 완료 ✓', 'success');
      setShowPortalHistory(false);
    } catch (e) {
      showToast('복원 실패: ' + e, 'error');
    } finally {
      setPortalHistoryRestoring(null);
    }
  }

  async function flushPendingCloudDeletes(): Promise<void> {
    if (!isDeployedWeb() || !dataRef.current.pendingCloudDeletes) return;
    const pendingFlush = await persist({
      ...dataRef.current,
      supabaseUrl: sbUrl,
      supabaseAnonKey: sbKey,
    });
    if (pendingFlush.cloudSynced !== true || dataRef.current.pendingCloudDeletes) {
      throw new Error('삭제 대기 항목을 먼저 동기화하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.');
    }
  }

  async function syncSupabase() {
    if (!sbUrl || !sbKey) {
      showToast('Supabase URL과 키를 먼저 설정하세요', 'error');
      setShowSettings(true);
      return;
    }
    if (isSyncing || isRestoring) { showToast('동기화 진행 중입니다', 'error'); return; }
    setIsSyncing(true);
    setSyncOk(null);
    try {
      await flushPendingCloudDeletes();
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const deviceId = data.deviceId;
      if (!isDeployedWeb() && (!deviceId || !UUID_RE.test(deviceId))) {
        throw new Error('이 runtime의 authoritative Device ID를 읽지 못해 Push를 중단했습니다.');
      }

      // Upsert items — URL 북마크는 전 기기 공유. folder 타입은 '프로젝트·폴더' 탭으로 이전됨 → push 제외.
      const itemRows = data.items
        .filter(item => item.type === 'web')
        .map(item => ({
          id: item.id,
          device_id: '__shared__',
          name: item.name,
          type: item.type,
          url: item.url ?? null,
          path: null,
          category: item.category,
          description: item.description ?? null,
          pinned: item.pinned,
          visit_count: item.visitCount,
          last_visited: item.lastVisited ?? null,
          created_at: item.createdAt ?? null,
        }));

      // Upsert categories — always shared across devices
      const catRows = data.categories.map(cat => ({
        id: cat.id,
        device_id: '__shared__',
        name: cat.name,
        color: cat.color,
        "order": cat.order,
      }));

      // 북마크 스냅샷은 기기 무관 공유 — '__shared__' sentinel로 저장
      await savePushSnapshot(supabase, 'portmgr_portal_items', '__shared__', '(공유)', itemRows);
      const [itemsRes, catsRes] = await Promise.all([
        supabase.from('portmgr_portal_items').upsert(itemRows, { onConflict: 'id' }),
        supabase.from('portmgr_portal_categories').upsert(catRows, { onConflict: 'id' }),
      ]);

      if (itemsRes.error) throw new Error(describeSupabaseError(itemsRes.error));
      if (catsRes.error) throw new Error(describeSupabaseError(catsRes.error));

      // 로컬 앱/로컬 웹만 실제 단말이다. 배포 브라우저는 공유 북마크를 동기화할 뿐
      // portmgr_devices에 등록하지 않는다 — iPhone/Chrome 세션이 5번째 PC로 보이면 안 된다.
      const finalDeviceName = isDeployedWeb() ? null : ((deviceName?.trim()) || data.deviceName || null);
      if (!isDeployedWeb() && deviceId) {
        const finalHandoffNote = (handoffNote?.trim()) || data.handoffNote || null;
        supabase.from('portmgr_devices').upsert(
          {
            id: deviceId,
            name: finalDeviceName,
            last_push_at: new Date().toISOString(),
            ...(finalHandoffNote ? { handoff_note: finalHandoffNote, handoff_updated_at: new Date().toISOString() } : {}),
          },
          { onConflict: 'id' }
        ).then(() => {}, () => {});
      }

      const nextData: PortalData = {
        ...data,
        supabaseUrl: sbUrl,
        supabaseAnonKey: sbKey,
        deviceId,
        deviceName: finalDeviceName ?? undefined,
        viewingDeviceId: isDeployedWeb() ? undefined : data.viewingDeviceId,
        handoffNote: isDeployedWeb() ? undefined : data.handoffNote,
        lastSynced: new Date().toISOString(),
      };
      const saved = await persist(nextData, { syncCloud: false });
      if (!saved.localSaved) throw new Error('동기화 결과를 이 브라우저에 저장하지 못했습니다.');
      setSyncOk(true);
      showToast(`Supabase 동기화 완료 (${data.items.length}개 항목)`, 'success');
    } catch (err) {
      setSyncOk(false);
      showToast('동기화 실패: ' + err, 'error');
    } finally {
      setIsSyncing(false);
    }
  }

  async function pullFromSupabase(opts?: { skipConfirm?: boolean; targetDeviceId?: string }) {
    if (!sbUrl || !sbKey) {
      showToast('Supabase URL과 키를 먼저 설정하세요', 'error');
      setShowSettings(true);
      return;
    }
    if (isSyncing || isRestoring) { showToast('동기화 진행 중입니다', 'error'); return; }
    if (!opts?.skipConfirm && data.items.length > 0) {
      if (!window.confirm('현재 북마크 데이터가 Supabase 데이터로 덮어씌워집니다.\n계속하시겠습니까?')) return;
    }
    setIsRestoring(true);
    try {
      try {
        await flushPendingCloudDeletes();
      } catch {
        throw new Error('삭제 대기 항목을 먼저 동기화하지 못해 Pull을 중단했습니다. 네트워크를 확인한 뒤 다시 시도하세요.');
      }
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const ownDeviceId = data.deviceId;
      if (!ownDeviceId || !UUID_RE.test(ownDeviceId)) {
        throw new Error('이 runtime의 authoritative Device ID를 읽지 못해 Pull을 중단했습니다.');
      }
      const targetDeviceId = opts?.targetDeviceId ?? viewingDeviceId ?? ownDeviceId;
      const [itemsRes, catsRes] = await Promise.all([
        supabase.from('portmgr_portal_items').select('*').in('device_id', [targetDeviceId, '__shared__']),
        supabase.from('portmgr_portal_categories').select('*').eq('device_id', '__shared__'),
      ]);
      if (itemsRes.error) throw new Error(describeSupabaseError(itemsRes.error));
      if (catsRes.error) throw new Error(describeSupabaseError(catsRes.error));

      const items: PortalItem[] = (itemsRes.data ?? []).map((row: any) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        url: row.url ?? undefined,
        path: row.path ?? undefined,
        category: row.category,
        description: row.description ?? undefined,
        pinned: row.pinned,
        visitCount: row.visit_count,
        lastVisited: row.last_visited ?? undefined,
        createdAt: row.created_at,
      }));

      const categories: PortalCategory[] = (catsRes.data ?? []).map((row: any) => ({
        id: row.id,
        name: row.name,
        color: row.color as ColorKey,
        order: row.order,
      }));

      if (items.length === 0 && categories.length === 0) {
        // Diagnose: distinguish "empty table", "device mismatch", and "query error"
        const { data: anyItems, error: scanErr } = await supabase
          .from('portmgr_portal_items').select('device_id').limit(5);
        const urlHint = sbUrl?.replace('https://', '').slice(0, 22) ?? '?';
        if (scanErr) {
          showToast(`[${urlHint}] Supabase 조회 오류: ${scanErr.message}`, 'error');
        } else if (anyItems && anyItems.length > 0) {
          const ids = [...new Set(anyItems.map((r: any) => r.device_id).filter(Boolean))];
          showToast(`[${urlHint}] 기기 ID(${targetDeviceId.slice(0, 8)}…)로 저장된 포털 데이터가 없습니다. 다른 기기(${ids.map((id: string) => id.slice(0, 8)).join(', ')}…) 데이터가 있습니다. 설정에서 기기를 선택 후 재시도하세요.`, 'error');
        } else {
          showToast(`[${urlHint}] Supabase에 저장된 북마크가 없습니다. 북마크를 추가한 뒤 Push하세요.`, 'error');
        }
        return;
      }

      const nextData: PortalData = {
        ...data,
        items: items.length > 0 ? items : data.items,
        categories: categories.length > 0 ? categories : data.categories,
        lastSynced: new Date().toISOString(),
      };
      const saved = await persist(nextData, { syncCloud: false });
      if (!saved.localSaved) throw new Error('가져온 데이터를 이 기기에 저장하지 못했습니다.');
      // Pull 완료 후 항상 내 기기 모드로 복귀
      setViewingDeviceId('');
      showToast(`Supabase에서 ${items.length}개 항목을 복원했습니다 ✓`, 'success');
    } catch (err) {
      showToast('복원 실패: ' + err, 'error');
    } finally {
      setIsRestoring(false);
    }
  }

  async function fetchKnownDevices() {
    if (!sbUrl || !sbKey) { showToast('Supabase URL과 Key를 먼저 입력 후 저장하세요', 'error'); return; }
    setIsFetchingDevices(true);
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const seen = new Set<string>();
      // device_id → device_name 맵 (여러 소스에서 보강)
      const nameMap = new Map<string, string>();

      // 1순위: ports 테이블 (device_name 컬럼 있으면 사용)
      const { data: portsRows, error: portsErr } = await supabase
        .from('portmgr_ports').select('device_id, device_name, folder_path').not('device_id', 'is', null);
      if (!portsErr && portsRows) {
        for (const r of portsRows) {
          if (!r.device_id || r.device_id === '__shared__') continue;
          seen.add(r.device_id);
          if (r.device_name && !nameMap.has(r.device_id)) {
            nameMap.set(r.device_id, r.device_name);
          }
          // device_name 없으면 folder_path에서 사용자명 추출 (/Users/username/...)
          if (!nameMap.has(r.device_id) && r.folder_path) {
            const m = r.folder_path.match(/^\/(?:Users|home)\/([^/]+)\//);
            if (m) nameMap.set(r.device_id, `${m[1]}의 기기`);
          }
        }
      }

      // 2순위: workspace_roots — sentinel 행(__device__)에서 기기명, 없으면 path에서 사용자명 추출
      const { data: rootRows } = await supabase
        .from('portmgr_workspace_roots').select('device_id, name, path').not('device_id', 'is', null);
      for (const r of rootRows ?? []) {
        if (!r.device_id || r.device_id === '__shared__') continue;
        seen.add(r.device_id);
        // sentinel 행: Push 시 저장한 기기명 (최우선)
        if (r.path?.startsWith('__device__') && r.name) {
          nameMap.set(r.device_id, r.name);
        } else if (!nameMap.has(r.device_id) && r.path) {
          const m = r.path.match(/^\/(?:Users|home)\/([^/]+)\//);
          if (m) nameMap.set(r.device_id, `${m[1]}의 기기`);
        }
      }

      // 3순위: portal_items folder 타입
      const { data: folderRows } = await supabase
        .from('portmgr_portal_items').select('device_id, path').eq('type', 'folder').not('device_id', 'is', null);
      for (const r of folderRows ?? []) {
        if (!r.device_id || r.device_id === '__shared__') continue;
        seen.add(r.device_id);
        if (!nameMap.has(r.device_id) && r.path) {
          const m = r.path.match(/^\/(?:Users|home)\/([^/]+)\//);
          if (m) nameMap.set(r.device_id, `${m[1]}의 기기`);
        }
      }

      // devices 테이블이 있으면 그것을 기준으로 필터링 (삭제된 기기 제외)
      // handoff_note/handoff_updated_at 컬럼이 아직 없는 설치(pre-migration)에서는
      // PostgREST가 "column does not exist" 에러를 반환하므로 select('id, name')로 폴백.
      let deviceRows: { id: string; name?: string; handoff_note?: string; handoff_updated_at?: string }[] | null = null;
      const wideRes = await supabase.from('portmgr_devices').select('id, name, handoff_note, handoff_updated_at');
      if (!wideRes.error) {
        deviceRows = wideRes.data as any;
      } else {
        const narrowRes = await supabase.from('portmgr_devices').select('id, name');
        deviceRows = narrowRes.data as any;
      }
      const registeredIds = deviceRows && deviceRows.length > 0
        ? new Set(deviceRows.map((r: { id: string }) => r.id))
        : null;
      // devices 테이블 name이 최우선
      const noteMap = new Map<string, { handoff_note?: string; handoff_updated_at?: string }>();
      if (deviceRows) {
        for (const r of deviceRows) {
          if (r.name) nameMap.set(r.id, r.name);
          noteMap.set(r.id, { handoff_note: r.handoff_note, handoff_updated_at: r.handoff_updated_at });
        }
      }

      // devices 테이블이 있으면 그것을 기준 (등록됐지만 아직 push 전인 기기도 포함)
      // 없으면 데이터 흔적(seen)으로 fallback
      const allIds = registeredIds
        ? Array.from(registeredIds)
        : Array.from(seen);
      const devices = allIds.map(id => ({
        device_id: id,
        device_name: nameMap.get(id),
        handoff_note: noteMap.get(id)?.handoff_note,
        handoff_updated_at: noteMap.get(id)?.handoff_updated_at,
      }));

      setKnownDevices(devices);
      // 자기 기기 이름은 로컬이 source of truth — 로컬에 이름이 비었을 때만 Supabase에서 자동 보강.
      // (사용자가 명시적으로 바꾼 이름을 단말 조회 시 되돌리지 않도록.)
      const ownDevice = devices.find(d => d.device_id === data.deviceId);
      if (ownDevice?.device_name && !deviceName?.trim()) {
        setDeviceName(ownDevice.device_name);
        const next = { ...data, deviceName: ownDevice.device_name };
        const outcome = await persist(next);
        if (outcome.localSaved && outcome.cloudSynced !== false) {
          showToast(`기기 이름 자동 인식: ${ownDevice.device_name}`, 'success');
        }
      }
      if (devices.length === 0) {
        showToast('단말 없음 — 이 기기에서 먼저 Push를 실행하세요', 'error');
      } else {
        showToast(`${devices.length}개 단말 발견`, 'success');
      }
    } catch (e: any) {
      showToast('단말 조회 오류: ' + e.message, 'error');
    } finally {
      setIsFetchingDevices(false);
    }
  }

  async function saveHandoffNote() {
    // Local-first: 항상 로컬(data.handoffNote)에 반영 — Supabase 미설정이어도 동작
    const trimmed = handoffNote.trim();
    const next: PortalData = { ...data, handoffNote: trimmed || undefined };
    const saved = await persist(next);
    if (!saved.localSaved) return;

    if (!sbUrl || !sbKey || !data.deviceId) {
      showToast('메모 저장됨 (로컬)', 'success');
      return;
    }
    setIsSavingHandoffNote(true);
    try {
      const supabase = getSupabaseClient(sbUrl, sbKey);
      const finalDeviceName = (deviceName?.trim()) || data.deviceName || null;
      const { error } = await supabase.from('portmgr_devices').upsert(
        {
          id: data.deviceId,
          name: finalDeviceName,
          handoff_note: trimmed || null,
          handoff_updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (error) throw error;
      showToast('핸드오프 메모 저장됨', 'success');
    } catch (e: any) {
      // 컬럼 미존재(pre-migration) 등 — CLAUDE.md의 ALTER TABLE DDL 안내
      showToast(
        '메모는 로컬에 저장됐지만 Supabase 동기화에 실패했습니다. portmgr_devices 테이블에 handoff_note/handoff_updated_at 컬럼이 없을 수 있습니다 — CLAUDE.md의 ALTER TABLE 안내를 참고해 컬럼을 추가하세요. (' + (e?.message ?? e) + ')',
        'error'
      );
    } finally {
      setIsSavingHandoffNote(false);
    }
  }

  async function saveSettings() {
    const next: PortalData = {
      ...data,
      supabaseUrl: sbUrl,
      supabaseAnonKey: sbKey,
      deviceName: isDeployedWeb() ? undefined : (deviceName || undefined),
      viewingDeviceId: isDeployedWeb() ? undefined : data.viewingDeviceId,
      handoffNote: isDeployedWeb() ? undefined : data.handoffNote,
    };
    const outcome = await persist(next);
    if (!outcome.localSaved) return;
    setShowSettings(false);
    if (outcome.cloudSynced !== false) showToast('설정 저장됨', 'success');
  }

  // ── Filtered items ────────────────────────────────────────────────────────

  const bookmarkItems = useMemo(
    () => data.items.filter(item => item.type === 'web'),
    [data.items],
  );
  const sortedCategories = useMemo(
    () => sortedPortalCategories(data.categories),
    [data.categories],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of bookmarkItems) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return counts;
  }, [bookmarkItems]);
  const categoryIds = useMemo(
    () => new Set(data.categories.map(category => category.id)),
    [data.categories],
  );
  useEffect(() => {
    if (selectedCat !== 'all' && !categoryIds.has(selectedCat)) setSelectedCat('all');
  }, [categoryIds, selectedCat]);
  const normalizedSearch = search.trim().toLocaleLowerCase('ko-KR');

  const filteredItems = bookmarkItems.filter(item => {
    // 북마크 탭은 URL 전용 (type='web'). 레거시 folder 항목은 '프로젝트·폴더' 탭으로 이전됨.
    const matchesCat = selectedCat === 'all' || item.category === selectedCat;
    const matchesSearch = !normalizedSearch
      || item.name.toLocaleLowerCase('ko-KR').includes(normalizedSearch)
      || !!item.description?.toLocaleLowerCase('ko-KR').includes(normalizedSearch)
      || !!item.url?.toLocaleLowerCase('ko-KR').includes(normalizedSearch);
    return matchesCat && matchesSearch;
  });

  const pinnedItems = filteredItems.filter(i => i.pinned);
  const unpinnedItems = filteredItems.filter(i => !i.pinned);
  const uncategorizedItems = unpinnedItems.filter(item => !categoryIds.has(item.category));

  const getCat = (id: string) => data.categories.find(c => c.id === id);
  const getColor = (colorKey: ColorKey) => COLORS[colorKey] ?? COLORS.blue;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-label="북마크 불러오는 중">
        <RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="portal-bookmark-empty" role="alert">
        <div className="portal-bookmark-empty__icon"><CloudOff className="h-5 w-5" /></div>
        <p className="portal-bookmark-empty__title">북마크를 불러오지 못했습니다</p>
        <p className="portal-bookmark-empty__description">{loadError}</p>
        <button onClick={() => setLoadRetryNonce(value => value + 1)} className="portal-primary-button">
          <RefreshCw className="h-4 w-4" />다시 시도
        </button>
      </div>
    );
  }

  const portalUI = isVisible ? (
    <div className="portal-bookmarks">
      {/* ── Mobile category tabs ──────────────────────────────────────────────── */}
      <nav className="portal-category-tabs md:hidden" aria-label="북마크 카테고리">
        <button
          onClick={() => setSelectedCat('all')}
          aria-pressed={selectedCat === 'all'}
          className={`portal-category-chip ${selectedCat === 'all' ? 'is-active' : ''}`}
        >
          <BookMarked className="w-3 h-3" />
          전체 <span>{bookmarkItems.length}</span>
        </button>
        {sortedCategories.map(cat => {
          const c = getColor(cat.color);
          const count = categoryCounts.get(cat.id) ?? 0;
          return (
            <button
              key={cat.id}
              onClick={() => setSelectedCat(cat.id)}
              aria-pressed={selectedCat === cat.id}
              className={`portal-category-chip ${selectedCat === cat.id ? 'is-active' : ''}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
              {cat.name} <span>{count}</span>
            </button>
          );
        })}
        <button
          onClick={() => setShowCatModal(true)}
          className="portal-category-chip portal-category-chip--add"
        >
          <Plus className="w-3 h-3" />
          카테고리
        </button>
      </nav>

      {/* ── Left Sidebar (desktop only) ──────────────────────────────────────── */}
      <aside className="portal-bookmark-sidebar hidden md:flex">
        <p className="portal-bookmark-sidebar__label">카테고리</p>
        {/* All */}
        <button
          data-help-key="portal-sidebar-all"
          onClick={() => setSelectedCat('all')}
          aria-pressed={selectedCat === 'all'}
          className={`portal-sidebar-category ${selectedCat === 'all' ? 'is-active' : ''}`}
        >
          <BookMarked className="w-3 h-3 flex-shrink-0" />
          <span className="portal-sidebar-category__name">전체</span>
          <span className="portal-sidebar-category__count">{bookmarkItems.length}</span>
        </button>

        {sortedCategories.map(cat => {
          const c = getColor(cat.color);
          const count = categoryCounts.get(cat.id) ?? 0;
          const active = selectedCat === cat.id;
          return (
            <div key={cat.id} data-help-key="portal-sidebar-category" className={`portal-sidebar-category-row ${active ? 'is-active' : ''}`}>
              <button
                onClick={() => setSelectedCat(cat.id)}
                aria-pressed={active}
                className="portal-sidebar-category portal-sidebar-category--nested"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
                <span className="portal-sidebar-category__name">{cat.name}</span>
                <span className="portal-sidebar-category__count">{count}</span>
              </button>
              <button
                type="button"
                aria-label={`${cat.name} 카테고리 삭제`}
                title={`${cat.name} 삭제`}
                onClick={() => deleteCategory(cat.id)}
                className="portal-sidebar-category__delete"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}

        {/* Add category */}
        <button
          data-help-key="portal-add-category"
          onClick={() => setShowCatModal(true)}
          className="portal-sidebar-add-category"
        >
          <Plus className="w-3 h-3" />
          카테고리 추가
        </button>

        {/* Sync status */}
        {data.lastSynced && (
          <p data-help-key="portal-sync-status" className="portal-bookmark-sync-status">
            동기화: {new Date(data.lastSynced).toLocaleDateString('ko-KR')}
          </p>
        )}
        <button
          data-help-key="portal-sidebar-history"
          onClick={openPortalHistory}
          className="portal-sidebar-history"
          title="Push 히스토리 / 복원"
        >
          <Clock className="w-3 h-3 flex-shrink-0" />
          히스토리
        </button>
      </aside>

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <div className="portal-bookmark-content">
        {/* Search row */}
        <div className="portal-bookmark-toolbar">
          <div className="portal-search-field">
            <Search className="w-4 h-4" />
            <input
              data-help-key="portal-search"
              type="text"
              aria-label="북마크 검색"
              placeholder="이름, 주소, 설명 검색"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="portal-search-field__input"
            />
          </div>
          {viewingDeviceId && viewingDeviceId !== data.deviceId && (() => {
            const viewedDevice = knownDevices.find(d => d.device_id === viewingDeviceId);
            return (
              <div style={{display:'flex',flexDirection:'column',gap:4,padding:'6px 10px',background:'rgba(94,234,212,0.08)',border:'1px solid rgba(94,234,212,0.25)',borderRadius:7,flexShrink:0,maxWidth:260,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:6}}>
                  <span style={{color:'#5eead4',fontSize:10.5,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',flex:1}}>
                    📱 {viewedDevice?.device_name ?? viewingDeviceId.slice(0, 6) + '…'}
                  </span>
                  <button
                    onClick={() => { setViewingDeviceId(''); setData(d => ({ ...d, viewingDeviceId: undefined })); }}
                    style={{color:'#5eead4',background:'transparent',border:'none',cursor:'pointer',fontSize:12,lineHeight:1}}
                    title="내 기기로 복귀"
                  >✕</button>
                </div>
                {viewedDevice?.handoff_note && (
                  <div style={{padding:'4px 6px',background:'rgba(94,234,212,0.12)',border:'1px solid rgba(94,234,212,0.3)',borderRadius:5}}>
                    <p style={{margin:0,color:'#f0c98a',fontSize:11,whiteSpace:'pre-wrap'}}>{viewedDevice.handoff_note}</p>
                    {viewedDevice.handoff_updated_at && (
                      <p style={{margin:'2px 0 0',color:'rgba(94,234,212,0.7)',fontSize:9.5}}>{relativeTimeFromNow(viewedDevice.handoff_updated_at)}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          <button
            data-help-key="portal-add-item"
            onClick={() => openAddModal(selectedCat !== 'all' ? selectedCat : undefined)}
            className="portal-primary-button portal-primary-button--toolbar"
          >
            <Plus className="w-4 h-4" />북마크 추가
          </button>
        </div>

        {/* Pinned section */}
        {pinnedItems.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 mb-2 px-0.5">
              <Star className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-medium text-zinc-400">고정됨</span>
            </div>
            <div className="portal-bookmark-grid">
              {pinnedItems.map(item => (
                <ItemCard key={item.id} item={item} getCat={getCat} getColor={getColor} onOpen={openItem} onEdit={openEditModal} onDelete={deleteItem} onTogglePin={togglePin} />
              ))}
            </div>
          </div>
        )}

        {/* Items grouped by category or flat */}
        {selectedCat === 'all' && !normalizedSearch ? (
          filteredItems.length === 0 ? (
            <BookmarkEmptyState
              title="첫 북마크를 추가해보세요"
              description="자주 찾는 웹사이트를 카테고리별로 한곳에서 관리할 수 있습니다."
              actionLabel="첫 북마크 추가"
              onAction={() => openAddModal()}
            />
          ) : (
            <>
              {sortedCategories.map(cat => {
                const catItems = bookmarkItems.filter(i => i.category === cat.id && !i.pinned);
                if (catItems.length === 0) return null;
                const c = getColor(cat.color);
                return (
                  <section key={cat.id} className="portal-bookmark-section" aria-labelledby={`portal-category-${cat.id}`}>
                    <div className="portal-bookmark-section__heading">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
                      <h2 id={`portal-category-${cat.id}`}>{cat.name}</h2>
                      <span className="portal-bookmark-section__count">{catItems.length}</span>
                      <div style={{flex:1}}/>
                      <button aria-label={`${cat.name}에 북마크 추가`} onClick={() => openAddModal(cat.id)} className="portal-icon-button portal-icon-button--subtle">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="portal-bookmark-grid">
                      {catItems.map(item => (
                        <ItemCard key={item.id} item={item} getCat={getCat} getColor={getColor} onOpen={openItem} onEdit={openEditModal} onDelete={deleteItem} onTogglePin={togglePin} />
                      ))}
                    </div>
                  </section>
                );
              })}
              {uncategorizedItems.length > 0 && (
                <section className="portal-bookmark-section" aria-labelledby="portal-category-uncategorized">
                  <div className="portal-bookmark-section__heading">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-500" />
                    <h2 id="portal-category-uncategorized">미분류</h2>
                    <span className="portal-bookmark-section__count">{uncategorizedItems.length}</span>
                  </div>
                  <div className="portal-bookmark-grid">
                    {uncategorizedItems.map(item => (
                      <ItemCard key={item.id} item={item} getCat={getCat} getColor={getColor} onOpen={openItem} onEdit={openEditModal} onDelete={deleteItem} onTogglePin={togglePin} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )
        ) : (
          // Flat view (filtered)
          unpinnedItems.length > 0 ? (
            <div className="portal-bookmark-grid">
              {unpinnedItems.map(item => (
                <ItemCard key={item.id} item={item} getCat={getCat} getColor={getColor} onOpen={openItem} onEdit={openEditModal} onDelete={deleteItem} onTogglePin={togglePin} />
              ))}
            </div>
          ) : (
            filteredItems.length === 0 && (
              <BookmarkEmptyState
                title={normalizedSearch ? '검색 결과가 없습니다' : '이 카테고리는 아직 비어 있습니다'}
                description={normalizedSearch ? '검색어를 줄이거나 다른 카테고리를 확인해보세요.' : '새 북마크는 현재 선택한 카테고리에 저장됩니다.'}
                actionLabel={normalizedSearch ? '검색어 지우기' : '북마크 추가'}
                onAction={normalizedSearch ? () => setSearch('') : () => openAddModal()}
              />
            )
          )
        )}
      </div>

      {/* ── Add/Edit Item Modal ───────────────────────────────────────────────── */}
      {showItemModal && (
        <Modal
          title={editingItem ? '북마크 수정' : '북마크 추가'}
          onClose={() => setShowItemModal(false)}
          onConfirm={saveItem}
          confirmLabel={editingItem ? '저장' : '추가'}
          confirmDisabled={!form.name.trim() || !form.url.trim() || !resolveBookmarkCategoryId(form.category, data.categories)}
        >
          {/* 북마크 탭은 URL 전용. 폴더는 '프로젝트·폴더' 탭에서 관리. */}

          <label htmlFor="portal-bookmark-name" className="block text-xs text-zinc-300 mb-1">이름 *</label>
          <input
            id="portal-bookmark-name"
            type="text"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full mb-3 px-3 py-2 text-sm bg-black/30 border border-stone-700/50 text-white placeholder-zinc-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
            placeholder="이름을 입력하세요"
            autoFocus
            data-dialog-initial
          />

          <label htmlFor="portal-bookmark-url" className="block text-xs text-zinc-300 mb-1">URL *</label>
          <input
            id="portal-bookmark-url"
            type="text"
            value={form.url}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
            className="w-full mb-3 px-3 py-2 text-sm bg-black/30 border border-stone-700/50 text-white placeholder-zinc-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
            placeholder="https://..."
          />

          <label htmlFor="portal-bookmark-category" className="block text-xs text-zinc-300 mb-1">카테고리</label>
          <select
            id="portal-bookmark-category"
            value={form.category}
            onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            className="w-full mb-3 px-3 py-2 text-sm bg-black/30 border border-stone-700/50 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
          >
            {sortedCategories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>

          <label htmlFor="portal-bookmark-description" className="block text-xs text-zinc-300 mb-1">설명 (선택)</label>
          <input
            id="portal-bookmark-description"
            type="text"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            className="w-full mb-3 px-3 py-2 text-sm bg-black/30 border border-stone-700/50 text-white placeholder-zinc-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
            placeholder="간단한 설명..."
          />

          <label htmlFor="portal-bookmark-pinned" className="flex items-center gap-2 cursor-pointer select-none">
            <input id="portal-bookmark-pinned" type="checkbox" checked={form.pinned} onChange={e => setForm(f => ({ ...f, pinned: e.target.checked }))} className="rounded" />
            <span className="text-sm text-[#f4f4f5]/90">고정 (즐겨찾기)</span>
          </label>
        </Modal>
      )}

      {/* ── Add Category Modal ───────────────────────────────────────────────── */}
      {showCatModal && (
        <Modal
          title="카테고리 관리"
          onClose={() => setShowCatModal(false)}
          onConfirm={addCategory}
          confirmLabel="추가"
          confirmDisabled={!catForm.name.trim()}
        >
          {sortedCategories.length > 0 && (
            <div className="portal-category-manager-list" aria-label="현재 카테고리">
              {sortedCategories.map(category => {
                const color = getColor(category.color);
                return (
                  <div key={category.id} className="portal-category-manager-list__row">
                    <span className={`h-2 w-2 rounded-full ${color.dot}`} />
                    <span>{category.name}</span>
                    <span className="portal-category-manager-list__count">{categoryCounts.get(category.id) ?? 0}</span>
                    <button type="button" aria-label={`${category.name} 카테고리 삭제`} onClick={() => deleteCategory(category.id)}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="portal-modal-divider" />
          <label htmlFor="portal-category-name" className="block text-xs text-zinc-300 mb-1">이름 *</label>
          <input
            id="portal-category-name"
            type="text"
            value={catForm.name}
            onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))}
            className="w-full mb-4 px-3 py-2 text-sm bg-black/30 border border-stone-700/50 text-white placeholder-zinc-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
            placeholder="카테고리 이름"
            autoFocus
            data-dialog-initial
          />
          <span id="portal-category-color-label" className="block text-xs text-zinc-300 mb-2">색상</span>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="portal-category-color-label">
            {COLOR_OPTIONS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setCatForm(f => ({ ...f, color: c }))}
                aria-label={`${c} 색상`}
                aria-pressed={catForm.color === c}
                className={`portal-color-option ${COLORS[c].dot} ${catForm.color === c ? 'is-selected' : ''}`}
              />
            ))}
          </div>
        </Modal>
      )}

    </div>
  ) : null;

  return (
    <>
      {portalUI}

      {/* ── Settings Modal (탭 무관하게 항상 렌더) ────────────────────────── */}
      {showSettings && (
        <Modal
          title="설정"
          onClose={() => setShowSettings(false)}
          onConfirm={async () => {
            if (isDeployedWeb()) {
              setShowSettings(false);
              await syncSupabase();
              return;
            }
            const isPull = viewingDeviceId !== '' && viewingDeviceId !== data.deviceId;
            await saveSettings();
            if (isPull) await pullFromSupabase({ skipConfirm: true });
            else await syncSupabase();
          }}
          confirmLabel={isDeployedWeb() ? '공유 북마크 동기화' : '저장 후 동기화'}
        >

          {/* 배포 브라우저는 물리 단말 신원을 만들지 않는다. 프로젝트 조회 선택은 상단
              picker 한 곳이 정본이고, Mac/Windows/AWS 등록은 공용 단말 관리가 맡는다. */}
          {isDeployedWeb() ? (
            <div data-testid="deployed-settings-device-context" style={{marginBottom:16,padding:12,border:'1px solid rgba(96,165,250,0.24)',borderRadius:8,background:'rgba(59,130,246,0.06)'}}>
              <p style={{margin:0,fontSize:11.5,color:'#a1a1aa'}}>현재 프로젝트 기기</p>
              <p style={{margin:'5px 0 0',fontSize:13,fontWeight:600,color:'#dbeafe'}}>
                {selectedProjectDevice?.name || '선택되지 않음'}
              </p>
              <p style={{margin:'6px 0 0',fontSize:11,lineHeight:1.5,color:'#a1a1aa'}}>
                상단 「프로젝트 기기」와 같은 선택입니다. 이 브라우저는 조회용이라 단말 수에 포함되지 않습니다.
                프로젝트·폴더, 장기기억 필터와 단말 관리는 등록된 Mac·Windows·AWS·Ubuntu를 함께 보여줍니다.
              </p>
              <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
                {onChangeDevice && (
                  <button
                    data-testid="settings-change-project-device"
                    onClick={e => { e.stopPropagation(); setShowSettings(false); onChangeDevice(); }}
                    style={{minHeight:44,padding:'8px 12px',background:'rgba(59,130,246,0.12)',border:'1px solid rgba(96,165,250,0.32)',borderRadius:6,color:'#93c5fd',fontSize:11.5,cursor:'pointer',fontFamily:'inherit'}}
                  >프로젝트 기기 변경</button>
                )}
                {onManageDevices && (
                  <button
                    data-testid="settings-manage-devices"
                    onClick={e => { e.stopPropagation(); setShowSettings(false); onManageDevices(); }}
                    style={{minHeight:44,padding:'8px 12px',background:'rgba(94,234,212,0.08)',border:'1px solid rgba(94,234,212,0.28)',borderRadius:6,color:'#5eead4',fontSize:11.5,cursor:'pointer',fontFamily:'inherit'}}
                  >Mac·Windows·AWS 단말 관리</button>
                )}
              </div>
            </div>
          ) : (
          <div style={{marginBottom:16}}>
            <div style={{display:'flex',alignItems:'center',marginBottom:6,fontSize:11.5,color:'var(--pm-text-muted,#a1a1aa)'}}>
              <span>이 브라우저의 등록 이름{!deviceName && !data.deviceId && <span style={{color:'#5eead4',fontWeight:500,marginLeft:4}}>* 필수</span>}</span>
              <div style={{flex:1}}/>
              {deviceName
                ? <span style={{fontSize:11,color:'#4ade80',display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:3,background:'#4ade80',display:'inline-block'}}/>등록됨</span>
                : data.deviceId
                  ? <span style={{fontSize:11,color:'#5eead4'}}>이름 미설정 — 입력 권장</span>
                  : null
              }
            </div>
            {selectedProjectDevice && selectedProjectDevice.id !== data.deviceId && (
              <div style={{marginBottom:8,padding:'7px 9px',border:'1px solid rgba(251,191,36,0.22)',borderRadius:6,background:'rgba(251,191,36,0.06)',fontSize:10.5,lineHeight:1.5,color:'#d4d4d8'}}>
                상단에서 보는 기기는 <strong style={{color:'#fbbf24'}}>{selectedProjectDevice.name || selectedProjectDevice.id.slice(0, 8)}</strong>이고,
                아래 설정 대상은 이 브라우저 자체입니다. 조회 선택이 기기 신원을 바꾸지는 않습니다.
              </div>
            )}
            <input
              type="text"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              style={{width:'100%',padding:'8px 10px',background:'var(--pm-bg-input,#09090b)',border:'1px solid var(--pm-border,rgba(255,255,255,0.07))',borderRadius:6,color:'var(--pm-text,#f4f4f5)',fontSize:12.5,outline:'none',fontFamily:'inherit',boxSizing:'border-box'}}
              placeholder="예: MyMacPro, 회사맥북, WindowsPC"
              autoFocus={!deviceName && !data.deviceId}
            />
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:5}}>
              <p style={{fontSize:10.5,color:'var(--pm-text-faint,#71717a)',fontFamily:"'JetBrains Mono',monospace",margin:0}}>Device ID: {data.deviceId ? data.deviceId.slice(0, 16) + '…' : '자동생성'}</p>
              {onChangeDevice && (
                <button
                  onClick={() => { setShowSettings(false); onChangeDevice(); }}
                  style={{fontSize:10.5,color:'#5eead4',background:'transparent',border:'none',cursor:'pointer',padding:0}}
                >
                  단말 변경
                </button>
              )}
            </div>
          </div>
          )}

          {/* ── 2. Supabase 연결 ─────────────────────────────────────────────── */}
          {isDeployedWeb() ? (
            <div data-testid="deployed-settings-connection" style={{marginBottom:16,padding:12,border:'1px solid rgba(94,234,212,0.22)',borderRadius:8,background:'rgba(94,234,212,0.05)'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
                <div style={{minWidth:0}}>
                  <p style={{margin:0,fontSize:11.5,color:'#a1a1aa'}}>공유 데이터 연결</p>
                  <p style={{margin:'5px 0 0',fontSize:12.5,fontWeight:600,color:sbUrl && sbKey ? '#4ade80' : '#fbbf24'}}>
                    {sbUrl && sbKey ? 'Supabase 연결됨' : '연결 정보 확인 필요'}
                  </p>
                </div>
                <span style={{flexShrink:0,padding:'4px 7px',borderRadius:999,fontSize:10.5,color:syncOk ? '#4ade80' : '#a1a1aa',background:syncOk ? 'rgba(74,222,128,0.1)' : 'rgba(161,161,170,0.08)'}}>
                  {syncOk ? '최근 동기화 성공' : data.lastSynced ? `마지막 ${new Date(data.lastSynced).toLocaleString('ko-KR')}` : '동기화 대기'}
                </span>
              </div>
              <p style={{margin:'7px 0 0',fontSize:11,lineHeight:1.5,color:'#a1a1aa'}}>
                배포 포털의 연결 정보는 운영 환경에서 관리됩니다. 키를 이 화면에서 다시 입력할 필요가 없습니다.
                아래 버튼은 공유 북마크만 동기화하며 단말 신원은 변경하지 않습니다.
              </p>
            </div>
          ) : (
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:11.5,color:'var(--pm-text-muted,#a1a1aa)',marginBottom:6}}>Project URL</label>
            <input
              type="text"
              value={sbUrl}
              onChange={e => setSbUrl(e.target.value)}
              style={{width:'100%',padding:'8px 10px',background:'var(--pm-bg-input,#09090b)',border:'1px solid var(--pm-border,rgba(255,255,255,0.07))',borderRadius:6,color:'var(--pm-text,#f4f4f5)',fontSize:12.5,outline:'none',fontFamily:'inherit',boxSizing:'border-box',marginBottom:12}}
              placeholder="https://xxx.supabase.co"
            />
            <label style={{display:'block',fontSize:11.5,color:'var(--pm-text-muted,#a1a1aa)',marginBottom:6}}>Anon Key</label>
            <input
              type="password"
              value={sbKey}
              onChange={e => setSbKey(e.target.value)}
              style={{width:'100%',padding:'8px 10px',background:'var(--pm-bg-input,#09090b)',border:'1px solid var(--pm-border,rgba(255,255,255,0.07))',borderRadius:6,color:'var(--pm-text,#f4f4f5)',fontSize:12.5,outline:'none',fontFamily:"'JetBrains Mono',monospace",boxSizing:'border-box'}}
              placeholder="eyJ..."
            />
            {!isTauri() && !isDeployedWeb() && (
              <div style={{marginTop:12,padding:10,border:'1px solid rgba(94,234,212,0.22)',borderRadius:6,background:'rgba(94,234,212,0.05)'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                  <div style={{minWidth:0}}>
                    <p style={{margin:0,fontSize:11.5,color:authenticatedSessionEmail?'#4ade80':'#fbbf24'}}>
                      {authenticatedSessionEmail ? `Google 로그인됨 · ${authenticatedSessionEmail}` : 'Google 로그인이 필요합니다'}
                    </p>
                    <p style={{margin:'4px 0 0',fontSize:10.5,lineHeight:1.45,color:'var(--pm-text-muted,#71717a)'}}>
                      같은 origin의 <code>/portal.html</code> popup에서 session을 완료합니다.
                    </p>
                  </div>
                  <button
                    data-testid="settings-google-login"
                    disabled={!sbUrl || !sbKey || nativeAuthBusy}
                    onClick={() => void loginNativeSupabase()}
                    style={{flexShrink:0,padding:'6px 10px',background:'rgba(94,234,212,0.12)',border:'1px solid rgba(94,234,212,0.3)',borderRadius:5,color:'#5eead4',fontSize:11.5,cursor:'pointer',fontFamily:'inherit',opacity:(!sbUrl||!sbKey||nativeAuthBusy)?0.45:1}}
                  >
                    {nativeAuthBusy ? '로그인 대기 중…' : authenticatedSessionEmail ? '다시 로그인' : 'Google 로그인'}
                  </button>
                </div>
              </div>
            )}
            {/* 데스크톱 앱의 Supabase 읽기·쓰기는 모두 로컬 sidecar의 service_role 경로로 수행한다.
                로컬 웹은 위 Google authenticated session을 사용한다.
                service_role은 portal.json에 저장하지 않고 로컬 서버 전용 파일(0600)에 따로 둔다. */}
            {!isDeployedWeb() && (
              <div style={{marginTop:14,paddingTop:12,borderTop:'1px solid var(--pm-border,rgba(255,255,255,0.07))'}}>
                <label style={{display:'block',fontSize:11.5,color:'var(--pm-text-muted,#a1a1aa)',marginBottom:6}}>
                  service_role Key
                  <span style={{marginLeft:6,color: serviceKeyPresent ? '#4ade80' : '#fbbf24'}}>
                    {serviceKeyPresent ? '· 저장됨 · 앱 로그인 불필요' : '· 없음 — 앱 원격 동기화가 막힙니다'}
                  </span>
                </label>
                <input
                  type="password"
                  data-testid="settings-service-role-key"
                  value={serviceKeyInput}
                  onChange={e => setServiceKeyInput(e.target.value)}
                  autoComplete="off"
                  style={{width:'100%',padding:'8px 10px',background:'var(--pm-bg-input,#09090b)',border:'1px solid var(--pm-border,rgba(255,255,255,0.07))',borderRadius:6,color:'var(--pm-text,#f4f4f5)',fontSize:12.5,outline:'none',fontFamily:"'JetBrains Mono',monospace",boxSizing:'border-box'}}
                  placeholder={serviceKeyPresent ? '저장된 키 유지 — 바꾸려면 새 키 입력' : 'Supabase Dashboard → Settings → API → service_role (secret)'}
                />
                <p style={{margin:'6px 0 0',fontSize:10.5,lineHeight:1.5,color:'var(--pm-text-muted,#71717a)'}}>
                  RLS를 우회하는 관리자 키입니다. 이 PC의 로컬 서버만 쓰고 웹 번들에는 실리지 않으며,
                  앱 데이터 폴더에 소유자 전용(0600)으로 저장됩니다. Git에 커밋하지 마세요.
                </p>
                <div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}>
                  <button
                    data-testid="settings-service-role-from-cli"
                    disabled={serviceKeyBusy}
                    onClick={() => void importServiceRoleKeyFromCli()}
                    title="이미 로그인된 Supabase CLI에서 키를 직접 가져옵니다. 키가 브라우저를 거치지 않습니다."
                    style={{padding:'6px 12px',background:'rgba(125,211,252,0.12)',border:'1px solid rgba(125,211,252,0.32)',borderRadius:5,color:'#7dd3fc',fontSize:11.5,cursor:'pointer',fontFamily:'inherit',opacity:serviceKeyBusy?0.45:1}}
                  >
                    {serviceKeyBusy ? '가져오는 중…' : 'Supabase CLI에서 가져오기'}
                  </button>
                  <button
                    data-testid="settings-service-role-save"
                    disabled={!serviceKeyInput.trim() || serviceKeyBusy}
                    onClick={() => void saveServiceRoleKey(serviceKeyInput)}
                    style={{padding:'6px 12px',background:'rgba(94,234,212,0.12)',border:'1px solid rgba(94,234,212,0.3)',borderRadius:5,color:'#5eead4',fontSize:11.5,cursor:'pointer',fontFamily:'inherit',opacity:(!serviceKeyInput.trim()||serviceKeyBusy)?0.45:1}}
                  >
                    {serviceKeyBusy ? '저장 중…' : '키 저장'}
                  </button>
                  {serviceKeyPresent && (
                    <button
                      data-testid="settings-service-role-clear"
                      disabled={serviceKeyBusy}
                      onClick={() => void saveServiceRoleKey('')}
                      style={{padding:'6px 12px',background:'transparent',border:'1px solid rgba(248,113,113,0.28)',borderRadius:5,color:'#fca5a5',fontSize:11.5,cursor:'pointer',fontFamily:'inherit'}}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </div>
            )}
            {!isDeployedWeb() && (
              <div data-testid="voc-admin-settings" style={{marginTop:14,padding:10,border:'1px solid rgba(251,191,36,0.22)',borderRadius:7,background:'rgba(251,191,36,0.04)'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                  <div>
                    <p style={{margin:0,fontSize:11.5,fontWeight:600,color:'#fbbf24'}}>공개 VOC 수집 관리</p>
                    <p style={{margin:'3px 0 0',fontSize:10.5,lineHeight:1.45,color:'#71717a'}}>공개 설치본의 개발자 전송 한도와 스팸 단말을 관리합니다.</p>
                  </div>
                  {vocAdminBusy && <span style={{fontSize:10.5,color:'#a1a1aa'}}>처리 중…</span>}
                </div>
                {!serviceKeyPresent ? (
                  <p style={{margin:'8px 0 0',fontSize:10.5,color:'#fbbf24'}}>위 service_role 키를 저장하면 관리 기능이 열립니다.</p>
                ) : (
                  <>
                    {vocAdminError && <p style={{margin:'8px 0 0',fontSize:10.5,lineHeight:1.45,color:'#fca5a5'}}>{vocAdminError}</p>}
                    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:9,flexWrap:'wrap'}}>
                      <label style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'#d4d4d8'}}>
                        <input type="checkbox" checked={vocAccepting} onChange={e => setVocAccepting(e.target.checked)} style={{accentColor:'#fbbf24'}} />
                        VOC 접수 켜기
                      </label>
                      <label style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'#d4d4d8'}}>
                        단말당 하루
                        <input
                          data-testid="voc-daily-limit"
                          type="number"
                          min={1}
                          max={100}
                          value={vocDailyLimit}
                          onChange={e => setVocDailyLimit(Number(e.target.value))}
                          style={{width:58,padding:'5px 6px',background:'#09090b',border:'1px solid #3f3f46',borderRadius:5,color:'#f4f4f5',fontSize:11}}
                        />회
                      </label>
                      <button
                        data-testid="voc-admin-save"
                        disabled={vocAdminBusy || !vocAdminConfigured}
                        onClick={() => void saveVocAdmin()}
                        style={{padding:'5px 10px',background:'rgba(251,191,36,0.12)',border:'1px solid rgba(251,191,36,0.35)',borderRadius:5,color:'#fbbf24',fontSize:10.5,cursor:'pointer',opacity:(vocAdminBusy||!vocAdminConfigured)?0.45:1}}
                      >설정 저장</button>
                    </div>
                    <div style={{marginTop:10,paddingTop:9,borderTop:'1px solid rgba(255,255,255,0.06)'}}>
                      <p style={{margin:'0 0 6px',fontSize:10.5,color:'#a1a1aa'}}>스팸 단말 차단 · VOC DB의 <code>device_hash</code> 사용</p>
                      <input
                        data-testid="voc-block-device-hash"
                        value={vocBlockHash}
                        onChange={e => setVocBlockHash(e.target.value.trim())}
                        placeholder="64자리 device_hash"
                        style={{width:'100%',boxSizing:'border-box',padding:'6px 8px',background:'#09090b',border:'1px solid #3f3f46',borderRadius:5,color:'#f4f4f5',fontSize:10.5,fontFamily:"'JetBrains Mono',monospace"}}
                      />
                      <div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
                        <select value={vocBlockScope} onChange={e => setVocBlockScope(e.target.value === 'app' ? 'app' : 'voc')} style={{padding:'5px 7px',background:'#09090b',border:'1px solid #3f3f46',borderRadius:5,color:'#d4d4d8',fontSize:10.5}}>
                          <option value="voc">VOC 전송만 차단</option>
                          <option value="app">앱 사용 차단</option>
                        </select>
                        <input type="datetime-local" value={vocBlockExpires} onChange={e => setVocBlockExpires(e.target.value)} title="비우면 무기한" style={{padding:'5px 7px',background:'#09090b',border:'1px solid #3f3f46',borderRadius:5,color:'#d4d4d8',fontSize:10.5}} />
                      </div>
                      <input value={vocBlockNote} onChange={e => setVocBlockNote(e.target.value)} maxLength={500} placeholder="운영자 메모 (사용자에게 노출되지 않음)" style={{width:'100%',boxSizing:'border-box',marginTop:6,padding:'6px 8px',background:'#09090b',border:'1px solid #3f3f46',borderRadius:5,color:'#f4f4f5',fontSize:10.5}} />
                      <div style={{display:'flex',gap:6,marginTop:6}}>
                        <button disabled={vocAdminBusy || !/^[0-9a-f]{64}$/i.test(vocBlockHash)} onClick={() => void saveVocBlock()} style={{padding:'5px 10px',background:'rgba(248,113,113,0.1)',border:'1px solid rgba(248,113,113,0.3)',borderRadius:5,color:'#fca5a5',fontSize:10.5,cursor:'pointer'}}>차단 적용</button>
                        <button disabled={vocAdminBusy || !/^[0-9a-f]{64}$/i.test(vocBlockHash)} onClick={() => void clearVocBlock()} style={{padding:'5px 10px',background:'transparent',border:'1px solid #3f3f46',borderRadius:5,color:'#a1a1aa',fontSize:10.5,cursor:'pointer'}}>차단 해제</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {sbUrl && sbKey && !isDeployedWeb() && (
              <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:10}}>
                {resolvePersonalPortalUrl(data) ? (
                  <>
                <button
                  onClick={async () => {
                    // Always load fresh data so device ID isn't stale from localStorage fallback
                    const fresh = await PortalAPI.load();
                    const p = new URLSearchParams({ url: sbUrl, key: sbKey });
                    const did = fresh.deviceId || data.deviceId;
                    if (did) p.set('device', did);
                    const dname = fresh.deviceName || deviceName;
                    if (dname) p.set('name', dname);
                    const portalBaseUrl = resolvePersonalPortalUrl(fresh);
                    if (!portalBaseUrl) {
                      showToast('개인 포털 주소 설정을 확인하세요.', 'error');
                      return;
                    }
                    const portalUrl = portalUrlWithParams(portalBaseUrl, p);
                    if (onOpenDeployUrl) {
                      await onOpenDeployUrl(portalUrl);
                    } else {
                      window.open(portalUrl, '_blank', 'noopener');
                    }
                  }}
                  style={{width:'100%',padding:'8px 10px',background:'rgba(139,185,110,0.1)',border:'1px solid rgba(139,185,110,0.25)',borderRadius:6,color:'#4ade80',fontSize:12,cursor:'pointer',fontFamily:'inherit',textAlign:'center'}}
                >
                  🔗 Vercel 포털 열기 (자동 인증)
                </button>
                <button
                  onClick={async () => {
                    // Registration link: credentials only, no device param → new device opens and registers itself
                    const fresh = await PortalAPI.load();
                    const p = new URLSearchParams({ url: sbUrl, key: sbKey });
                    const portalBaseUrl = resolvePersonalPortalUrl(fresh);
                    if (!portalBaseUrl) {
                      showToast('개인 포털 주소 설정을 확인하세요.', 'error');
                      return;
                    }
                    const regUrl = portalUrlWithParams(portalBaseUrl, p);
                    try {
                      await navigator.clipboard.writeText(regUrl);
                      showToast('기기 등록 링크 복사됨 — 새 단말에서 열어 등록하세요', 'success');
                    } catch {
                      showToast(regUrl, 'error');
                    }
                  }}
                  style={{width:'100%',padding:'8px 10px',background:'rgba(100,140,220,0.1)',border:'1px solid rgba(100,140,220,0.25)',borderRadius:6,color:'#7eb3f0',fontSize:12,cursor:'pointer',fontFamily:'inherit',textAlign:'center'}}
                >
                  📋 새 단말 등록 링크 복사
                </button>
                  </>
                ) : (
                  <div data-testid="personal-portal-not-configured" style={{padding:'9px 10px',background:'rgba(250,204,21,0.07)',border:'1px solid rgba(250,204,21,0.22)',borderRadius:6,color:'#d4d4d8',fontSize:10.5,lineHeight:1.55}}>
                    개인 포털 주소가 아직 연결되지 않았습니다. 포털 열기·새 단말 링크만 사용할 수 없고 로컬 기능과 Supabase 동기화는 정상 작동합니다. 포털 자동 배포를 완료하거나, 운영자가 공개 소스가 아닌 배포 환경에 <code>VITE_PORTAL_URL</code>을 설정하세요.
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* 이메일/비밀번호 로그인 패널은 제거됐다. RLS가 꺼져 있는 동안 그 패널은
              아무 일도 하지 않았고, 배포 포털은 자체 Google 게이트(portal-main.tsx)를
              따로 갖고 있어 설정 안의 두 번째 로그인 UI가 혼란만 만들었다. */}

          {/* ── 고급 설정 (접이식) ───────────────────────────────────────────── */}
          {!isDeployedWeb() && <AdvancedSettings
            deviceId={data.deviceId}
            deviceName={deviceName}
            viewingDeviceId={viewingDeviceId}
            knownDevices={knownDevices}
            isFetchingDevices={isFetchingDevices}
            onFetchDevices={fetchKnownDevices}
            onSelectDevice={async (id) => {
              const newViewingId = id === data.deviceId ? '' : id;
              setViewingDeviceId(newViewingId);
            }}
            onResetDevice={() => setViewingDeviceId('')}
            onCopyDeviceId={() => { if (data.deviceId) { navigator.clipboard.writeText(data.deviceId); showToast('Device ID 복사됨', 'success'); } }}
            onCopyAgentsToZBotPrompt={async () => {
              if (!data.deviceId) { showToast('현재 단말 Device ID가 아직 없습니다.', 'error'); return; }
              try {
                const prompt = buildAgentsToZBotCreationPrompt({
                  deviceId: data.deviceId,
                  deviceName,
                  platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
                  apiBaseUrl: 'http://127.0.0.1:3002',
                  uiBaseUrl: 'http://127.0.0.1:9000',
                });
                await navigator.clipboard.writeText(prompt);
                showToast('현재 단말 기준 봇 생성 프롬프트가 복사되었습니다.', 'success');
              } catch (error: any) {
                showToast(error?.message || '봇 생성 프롬프트 복사에 실패했습니다.', 'error');
              }
            }}
            handoffNote={handoffNote}
            onChangeHandoffNote={setHandoffNote}
            onSaveHandoffNote={saveHandoffNote}
            isSavingHandoffNote={isSavingHandoffNote}
          />}
        </Modal>
      )}

      {/* ── Push 히스토리 모달 — 포털 아이템 ─────────────────────────────────── */}
      {showPortalHistory && (
        <div style={{position:'fixed',inset:0,zIndex:60,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}} onClick={() => setShowPortalHistory(false)}>
          <div style={{background:'#18181b',border:'1px solid var(--pm-border-mid,rgba(255,255,255,0.1))',borderRadius:12,width:'calc(100vw - 24px)',maxWidth:460,margin:'0 12px',boxShadow:'0 24px 48px rgba(0,0,0,0.6)',overflow:'hidden'}} onClick={e => e.stopPropagation()}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',borderBottom:'1px solid var(--pm-border,rgba(255,255,255,0.07))'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <Clock className="w-4 h-4" style={{color:'#5eead4'}} />
                <span style={{fontSize:13,fontWeight:600,color:'var(--pm-text,#f4f4f5)'}}>Push 히스토리 — 포털 북마크</span>
              </div>
              <button onClick={() => setShowPortalHistory(false)} style={{background:'transparent',border:'none',color:'var(--pm-text-muted,#a1a1aa)',cursor:'pointer',padding:4,display:'flex',alignItems:'center'}}><X className="w-4 h-4" /></button>
            </div>
            <div style={{overflowY:'auto',maxHeight:360}}>
              {portalHistoryLoading ? (
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'40px 0'}}>
                  <RefreshCw className="w-5 h-5" style={{color:'var(--pm-text-faint,#71717a)',animation:'spin 1s linear infinite'}} />
                </div>
              ) : portalHistoryList.length === 0 ? (
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px 0',gap:8}}>
                  <Clock className="w-8 h-8" style={{color:'#3f3a34'}} />
                  <p style={{fontSize:13,color:'var(--pm-text-faint,#71717a)',margin:0}}>저장된 히스토리가 없습니다</p>
                  <p style={{fontSize:11,color:'#4a4540',margin:0}}>Push 시 자동으로 스냅샷이 저장됩니다</p>
                </div>
              ) : portalHistoryList.map((snap, i) => (
                <div key={snap.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',borderBottom:'1px solid var(--pm-border-faint,rgba(255,255,255,0.05))'}}>
                  <div style={{minWidth:0}}>
                    <p style={{fontSize:13,color:'var(--pm-text,#f4f4f5)',fontWeight:500,margin:0}}>{new Date(snap.created_at).toLocaleString('ko-KR')}</p>
                    <p style={{fontSize:11,color:'var(--pm-text-faint,#71717a)',margin:'3px 0 0',fontFamily:"'JetBrains Mono',monospace"}}>
                      {snap.row_count}개 항목{snap.device_name ? ` · ${snap.device_name}` : ''}
                      {i === 0 && <span style={{marginLeft:6,color:'#4ade80',fontWeight:500}}>최신</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => restorePortalSnapshot(snap.id)}
                    disabled={portalHistoryRestoring !== null}
                    style={{marginLeft:12,flexShrink:0,display:'flex',alignItems:'center',gap:4,padding:'6px 10px',fontSize:11.5,background:'rgba(94,234,212,0.08)',color:'#5eead4',border:'1px solid rgba(94,234,212,0.2)',borderRadius:6,cursor:'pointer',fontFamily:'inherit',opacity:portalHistoryRestoring?0.5:1}}
                  >
                    {portalHistoryRestoring === snap.id
                      ? <RefreshCw className="w-3 h-3" style={{animation:'spin 1s linear infinite'}} />
                      : <RotateCw className="w-3 h-3" />}
                    복원
                  </button>
                </div>
              ))}
            </div>
            <div style={{padding:'8px 16px',borderTop:'1px solid var(--pm-border,rgba(255,255,255,0.07))',background:'rgba(255,255,255,0.02)'}}>
              <p style={{fontSize:10.5,color:'#4a4540',margin:0}}>복원 시 현재 Supabase 북마크 데이터를 선택한 시점으로 되돌립니다</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BookmarkEmptyState({ title, description, actionLabel, onAction }: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="portal-bookmark-empty">
      <div className="portal-bookmark-empty__icon"><BookMarked className="h-5 w-5" /></div>
      <p className="portal-bookmark-empty__title">{title}</p>
      <p className="portal-bookmark-empty__description">{description}</p>
      <button onClick={onAction} className="portal-primary-button">
        <Plus className="h-4 w-4" />{actionLabel}
      </button>
    </div>
  );
}

// ─── ItemCard ─────────────────────────────────────────────────────────────────

function getDisplayUrl(item: PortalItem, maxLen = 48): string {
  const raw = item.type === 'web' ? (item.url || '') : (item.path || '');
  if (!raw) return '';
  if (raw.startsWith('/')) {
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, 18) + '…' + raw.slice(-(maxLen - 19));
  }
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    const pathPart = u.pathname === '/' ? '' : u.pathname;
    const full = host + pathPart;
    if (full.length <= maxLen) return full;
    return full.slice(0, maxLen - 1) + '…';
  } catch {
    return raw.length > maxLen ? raw.slice(0, maxLen - 1) + '…' : raw;
  }
}

function FaviconBadge({ item }: { item: PortalItem }) {
  const [errored, setErrored] = useState(false);
  const badgeStyle: React.CSSProperties = {
    width: 32, height: 32, borderRadius: 8,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, overflow: 'hidden',
  };

  if (item.type !== 'web') {
    return (
      <div style={badgeStyle}>
        <Folder style={{ width: 15, height: 15, color: 'rgba(255,255,255,0.42)' }} />
      </div>
    );
  }

  let host = '';
  try { host = new URL(item.url || '').hostname; } catch {}

  if (host && !errored) {
    return (
      <div style={badgeStyle}>
        <img
          src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
          alt="" width={18} height={18}
          style={{ display: 'block', borderRadius: 3 }}
          onError={() => setErrored(true)}
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  const ch = (item.name?.[0] || '?').toUpperCase();
  return (
    <div style={badgeStyle}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.62)' }}>{ch}</span>
    </div>
  );
}

interface CardProps {
  item: PortalItem;
  getCat: (id: string) => PortalCategory | undefined;
  getColor: (k: ColorKey) => typeof COLORS[ColorKey];
  onOpen: (item: PortalItem) => void;
  onEdit: (item: PortalItem) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}

function ItemCard({ item, getCat, getColor, onOpen, onEdit, onDelete, onTogglePin }: CardProps) {
  const cat = getCat(item.category);
  const c = cat ? getColor(cat.color) : COLORS.teal;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirmDelete) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      onDelete(item.id);
    } else {
      setConfirmDelete(true);
      confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
    }
  }

  return (
    <article
      data-help-key="portal-item-card"
      role="link"
      tabIndex={0}
      aria-label={`${item.name} 열기`}
      onClick={() => onOpen(item)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(item);
        }
      }}
      className="portal-bookmark-card"
      style={{ '--bookmark-accent': c.hairline, '--bookmark-tint': c.tint } as React.CSSProperties}
    >
      {/* Header row: favicon + title + count + ↗ */}
      <div className="portal-bookmark-card__header">
        <FaviconBadge item={item} />
        <div className="portal-bookmark-card__title">
          {item.name}
        </div>
        <div className="portal-bookmark-card__meta">
          {item.visitCount > 0 && (
            <span className="portal-bookmark-card__visits" title={`열어본 횟수 ${item.visitCount}회`}>
              {item.visitCount}
            </span>
          )}
          {item.pinned && <Star className="portal-bookmark-card__star" />}
          <span className="portal-bookmark-card__external">
            {item.type === 'web'
              ? <ExternalLink className="h-3.5 w-3.5" />
              : <FolderOpen className="h-3.5 w-3.5" />
            }
          </span>
        </div>
      </div>

      {/* Description */}
      {item.description && (
        <div className="portal-bookmark-card__description">
          {item.description}
        </div>
      )}

      {/* URL/path */}
      <div className="portal-bookmark-card__url" title={item.type === 'web' ? item.url : item.path}>
        {getDisplayUrl(item)}
      </div>

      {/* Footer: category dot + name | action buttons */}
      <div className="portal-bookmark-card__footer">
        <div className="portal-bookmark-card__category">
          <span />
          <span>{cat?.name || '미분류'}</span>
        </div>

        <div
          role="group"
          aria-label={`${item.name} 북마크 작업`}
          className="portal-bookmark-card__actions"
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            data-help-key="portal-open"
            onClick={e => { e.stopPropagation(); onOpen(item); }}
            className="portal-card-action portal-card-action--open"
            aria-label={`${item.name} 열기`}
          >
            {item.type === 'web' ? <ExternalLink className="h-3.5 w-3.5" /> : <FolderOpen className="h-3.5 w-3.5" />}
            <span>{item.type === 'web' ? '열기' : '폴더'}</span>
          </button>
          <button
            type="button"
            data-help-key="portal-pin-toggle"
            onClick={e => { e.stopPropagation(); onTogglePin(item.id); }}
            title={item.pinned ? '고정 해제' : '고정'}
            aria-label={item.pinned ? `${item.name} 고정 해제` : `${item.name} 고정`}
            className={`portal-card-action ${item.pinned ? 'is-active' : ''}`}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-help-key="menu-edit"
            onClick={e => { e.stopPropagation(); onEdit(item); }}
            aria-label={`${item.name} 수정`}
            className="portal-card-action"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-help-key="menu-delete"
            onClick={handleDeleteClick}
            title={confirmDelete ? '한 번 더 누르면 삭제됩니다' : '삭제'}
            aria-label={confirmDelete ? `${item.name} 삭제 확인` : `${item.name} 삭제`}
            className={`portal-card-action ${confirmDelete ? 'is-danger' : ''}`}
          >
            {confirmDelete ? '삭제?' : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </article>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function Modal({ title, children, onClose, onConfirm, confirmLabel, confirmDisabled = false }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  confirmLabel: string;
  confirmDisabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const onCloseRef = useRef(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  onCloseRef.current = onClose;
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>('[data-dialog-initial]');
    requestAnimationFrame(() => (initial ?? dialog)?.focus());
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )).filter(el => el.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      openerRef.current?.focus();
    };
  }, []);

  async function handleConfirm() {
    if (confirming || confirmDisabled) return;
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="portal-modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !confirming) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="portal-modal-panel">
        <div className="portal-modal-panel__header">
          <h2 id={titleId}>{title}</h2>
          <div style={{flex:1}}/>
          <button aria-label={`${title} 닫기`} onClick={onClose} disabled={confirming} className="portal-icon-button">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="portal-modal-panel__body">{children}</div>
        <div className="portal-modal-panel__footer">
          <button onClick={onClose} disabled={confirming} className="portal-secondary-button">
            취소
          </button>
          <button onClick={handleConfirm} disabled={confirming || confirmDisabled} className="portal-primary-button">
            {confirming ? '저장 중…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
