import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  Loader2,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { isTauri } from './lib/env';
import { isGeneratedWorktreeRow } from './worktreeLifecycle';
import { ClipboardCopyButton } from './ClipboardCopyButton';

export const WHAT_I_SAID_SOURCE_URL = 'http://127.0.0.1:3001/api/what-i-said/feed';

export type WhatISaidLanguage = 'ko' | 'en';
export type WhatISaidAgent = 'claude' | 'codex';
export type WhatISaidRetention = 30 | 90 | 365 | 'forever';
export type WhatISaidPromptOrigin = 'human' | 'agentstoz' | 'unknown';

export interface WhatISaidProject {
  id: string;
  name: string;
  folderPath?: string;
  worktreePath?: string;
  worktreeParentId?: string;
}

export interface WhatISaidPanelProps {
  projects: readonly WhatISaidProject[];
  language: WhatISaidLanguage;
  visible: boolean;
}

export interface WhatISaidScanSummary {
  complete: boolean;
  unreadable: number;
  withheld: number;
}

export interface WhatISaidStatus {
  enabled: boolean;
  cryptoState: 'ready' | 'unavailable' | 'not-initialized';
  retentionDays: WhatISaidRetention;
  analysisAllowed: boolean;
  count: number | null;
  lastCaptureAt: string | null;
  scan: WhatISaidScanSummary | null;
}

export interface WhatISaidRemoteKey {
  id: string;
  /** 연결한 앱 이름. 나중에 어느 연결을 끊을지 고르는 유일한 근거다. */
  label: string;
  /** 다시 볼 수 있다. 한 번만 보여 주면 잃었을 때 재발급뿐이고, 재발급은 이미 붙여
   *  넣은 앱들의 연결을 전부 끊는다. */
  token: string | null;
  /** null 이면 올라간 전부를 읽는다. 배열이면 그 장기기억만. */
  allowedMemoryIds: string[] | null;
  dailyLimit: number;
  expiresAt: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

export interface WhatISaidRemoteKeyStatus {
  keys: WhatISaidRemoteKey[];
  endpoint: string | null;
  error: string | null;
}

export interface WhatISaidRemoteStatus {
  cloudProjects?: Array<{ memoryId: string; name: string }>;
  enabled: boolean;
  projects: Array<{
    memoryId: string;
    name: string;
    folderPath: string;
    excluded: boolean | null;
    captureConfigured?: boolean;
    captureEnabled?: boolean | null;
  }>;
  /**
   * 이 기기의 신원. 「내가 한 말」은 기기 로컬 저장소라 저장되는 프롬프트마다 이 값이
   * 함께 박힌다 — 화면이 그것을 말할 수 있어야 사용자가 파일을 직접 열지 않고도
   * "어느 기기 기록인지"를 확인한다 (VOC 2026-09-01 08:10).
   * 이름은 비어 있을 수 있고, 그때도 UUID 는 남으므로 둘을 따로 든다.
   */
  deviceId: string | null;
  deviceName: string | null;
  /** 자격이 없으면 켜도 아무것도 올라가지 않는다 — 그 상태를 화면이 말해야 한다. */
  credentialsReady: boolean;
  /** false means the shared exclusion policy could not be read; it must not be rendered as included. */
  exclusionsReady: boolean;
  storedRows: number | null;
  remoteError: string | null;
  sharedPolicyReady?: boolean;
}

export function whatISaidRemoteUiState(status: WhatISaidRemoteStatus | null): {
  uploadOperational: boolean;
  remoteCopiesRemain: boolean;
  scopeUnverified: boolean;
  toggleBlocked: boolean;
} {
  const storedRowsKnown = status !== null
    && Number.isSafeInteger(status.storedRows)
    && (status.storedRows ?? -1) >= 0;
  const remoteHealthy = status !== null
    && status.credentialsReady
    && status.exclusionsReady
    && status.remoteError === null
    && storedRowsKnown;
  const uploadOperational = status !== null
    && status.enabled
    && remoteHealthy;
  const remoteCopiesRemain = status !== null
    && !status.enabled
    && remoteHealthy
    && (status.storedRows ?? 0) > 0;
  const confirmedLocalOnly = status !== null
    && !status.enabled
    && remoteHealthy
    && status.storedRows === 0;
  // OFF is only a current policy. It is not evidence that an older remote copy
  // is absent, so "local only" requires a healthy exact zero-row read.
  const scopeUnverified = !uploadOperational && !remoteCopiesRemain && !confirmedLocalOnly;
  // A degraded ON policy can always be switched off. A known OFF policy must
  // not be presented as switchable-on until its remote guards are available.
  const toggleBlocked = status === null || (!status.enabled && !remoteHealthy);
  return { uploadOperational, remoteCopiesRemain, scopeUnverified, toggleBlocked };
}

export interface WhatISaidPrompt {
  id: string;
  /** Kept as decimal text so a long-running local index cannot lose bigint precision in the browser. */
  seq: string;
  recordedAt: string;
  agent: WhatISaidAgent;
  projectId: string | null;
  memoryId?: string | null;
  projectName: string | null;
  text: string;
  /**
   * 이 프롬프트를 수집한 기기. Supabase 목록에는 여러 Mac의 기록이 함께 오므로
   * 이 값이 수집 단말을 설명한다. 기록 이전 행은 null이고 추측하지 않는다.
   */
  deviceId: string | null;
  deviceName: string | null;
  promptOrigin: WhatISaidPromptOrigin;
  storage?: 'local' | 'supabase';
}

/**
 * 이 기기가 마지막으로 프롬프트를 가져온 시각. 수집은 서버의 순환 작업과
 * 장기기억 저장·세션 기억하기·수동 수집에서 실행되므로, 이 값이 없으면
 * 몇 주 묵은 라이브러리와 방금 켠 라이브러리가 화면에서 똑같이 보인다.
 * null 은 「한 번도 수집한 적 없음」이고, 객체 자체가 null 이면 「모름」이다 —
 * 필드를 주지 않는 옛 sidecar 를 「수집한 적 없음」으로 읽으면 안 된다.
 */
export interface WhatISaidCaptureFreshnessSource {
  /** `undefined` 는 「모름」, `null` 은 서버가 단언한 「한 번도 없음」이다. */
  lastCaptureAt?: string | null;
  /**
   * 가장 오래 전에 수집한 기억의 시각. 신선도는 이 값으로 판정한다 — `lastCaptureAt`
   * 하나만 보면 오늘 건드린 프로젝트 하나가 나머지 전부의 정체를 가린다
   * (2026-09-05 실측 42개 중 never 34 / stale 7 / fresh 1 이 「최신」으로 표시됐다).
   * 한 번도 수집한 적 없는 기억은 목록에 행을 내지 않으므로 이 값에 넣지 않는다.
   */
  oldestCaptureAt?: string | null;
}

export interface WhatISaidListPage {
  items: WhatISaidPrompt[];
  nextBeforeSeq: string | null;
  hasMore: boolean;
  scan: WhatISaidScanSummary | null;
  capture: WhatISaidCaptureFreshnessSource | null;
  source: 'local' | 'supabase';
}

/**
 * 수집은 앱 실행 중 순환 작업과 세션 저장·수동 수집에서 실행된다.
 * 그래서 몇 시간 된 라이브러리는 정상이고, 며칠 된 라이브러리는 정상이 아니다.
 *
 * 임계값을 24시간으로 잡지 않은 이유: 하루쯤 그 프로젝트를 건드리지 않는 일은 흔해서
 * 매주 월요일마다 경고가 뜨고, 그러면 사용자가 경고를 읽지 않게 된다. 이틀 연속으로
 * 세션 저장이 한 번도 없었다면 그 라이브러리는 더 이상 지금 하는 일을 설명하지 않는다.
 */
export const WHAT_I_SAID_STALE_CAPTURE_MS = 2 * 24 * 60 * 60 * 1000;

export interface WhatISaidCaptureFreshness {
  /** unknown 은 주장하지 않는다는 뜻이다 — 화면에 아무것도 그리지 않는다. */
  state: 'unknown' | 'never' | 'fresh' | 'stale';
  days: number;
  hours: number;
}

export function whatISaidCaptureFreshness(
  capture: WhatISaidCaptureFreshnessSource | null,
  now: number = Date.now(),
): WhatISaidCaptureFreshness {
  const none = { days: 0, hours: 0 };
  if (!capture) return { state: 'unknown', ...none };
  if (capture.lastCaptureAt === undefined) return { state: 'unknown', ...none };
  if (capture.lastCaptureAt === null) return { state: 'never', ...none };
  const at = Date.parse(capture.lastCaptureAt);
  // 읽을 수 없는 시각을 「수집한 적 없음」으로 강등하면 멀쩡한 저장소가 빈 것으로 읽힌다.
  if (!Number.isFinite(at) || !Number.isFinite(now)) return { state: 'unknown', ...none };
  // 기기 시계가 뒤로 가면 음수가 나온다. 미래 수집을 주장하는 대신 방금으로 붙인다.
  const elapsed = Math.max(0, now - at);
  // 라벨은 가장 최근 수집을 말하고, 경고 여부는 가장 뒤처진 기억이 정한다. 옛 sidecar는
  // 이 필드를 주지 않으므로 그때는 예전처럼 최신 값 하나로 판정한다.
  const oldestParsed = typeof capture.oldestCaptureAt === 'string'
    ? Date.parse(capture.oldestCaptureAt)
    : Number.NaN;
  const laggard = Number.isFinite(oldestParsed) ? Math.max(0, now - oldestParsed) : elapsed;
  return {
    state: laggard >= WHAT_I_SAID_STALE_CAPTURE_MS ? 'stale' : 'fresh',
    days: Math.floor(elapsed / (24 * 60 * 60 * 1000)),
    hours: Math.floor(elapsed / (60 * 60 * 1000)),
  };
}

export interface WhatISaidSourceStatus {
  enabled: boolean;
  sourceUrl: typeof WHAT_I_SAID_SOURCE_URL;
}

export interface WhatISaidGlobalApplySummary {
  registeredProjects: number;
  appliedProjects: number;
  failedProjects: number;
}

export interface WhatISaidGlobalStatus {
  configured: boolean;
  enabled: boolean;
  retentionDays: WhatISaidRetention;
  analysisAllowed: boolean;
  updatedAt: string | null;
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const finiteInteger = (value: unknown): number | null => {
  const numberValue = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof numberValue === 'number' && Number.isSafeInteger(numberValue) ? numberValue : null;
};

const sequenceText = (value: unknown): string | null => {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
  return null;
};

const listCursorText = (value: unknown): string | null => {
  const sequence = sequenceText(value);
  if (sequence !== null) return sequence;
  // The all-project view needs one server-issued position per encrypted
  // project store. Keep that opaque cursor as text; never parse it as a JS
  // number or allow arbitrary server content through this boundary.
  if (typeof value !== 'string') return null;
  if (/^wisr1_(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 32) return value;
  return /^wisg1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length <= 65536 ? value : null;
};

const nonNegativeInteger = (value: unknown): number => {
  const parsed = finiteInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
};

const nullableString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const normalizeScanSummary = (value: unknown): WhatISaidScanSummary | null => {
  const raw = asObject(value);
  if (!raw) return null;
  return {
    complete: raw.complete !== false,
    unreadable: nonNegativeInteger(raw.unreadable),
    withheld: nonNegativeInteger(raw.withheld),
  };
};

const unwrapStatusObject = (payload: unknown): JsonObject => {
  const outer = asObject(payload) ?? {};
  return asObject(outer.status) ?? outer;
};

export function normalizeWhatISaidStatus(payload: unknown): WhatISaidStatus {
  const raw = unwrapStatusObject(payload);
  const retentionDays = finiteInteger(raw.retentionDays);
  const count = finiteInteger(raw.count);
  return {
    enabled: raw.enabled === true,
    cryptoState: raw.cryptoState === 'ready'
      || raw.cryptoState === 'unavailable'
      || raw.cryptoState === 'not-initialized'
      ? raw.cryptoState
      : raw.enabled === true ? 'ready' : 'not-initialized',
    retentionDays: raw.retentionDays === 'forever'
      ? 'forever'
      : retentionDays === 30 || retentionDays === 90 || retentionDays === 365
        ? retentionDays
        : 30,
    analysisAllowed: raw.analysisAllowed === true,
    count: count !== null && count >= 0 ? count : null,
    lastCaptureAt: nullableString(raw.lastCaptureAt),
    scan: normalizeScanSummary(raw.scan),
  };
}

export function normalizeWhatISaidListPage(payload: unknown): WhatISaidListPage {
  const raw = asObject(payload) ?? {};
  const items = Array.isArray(raw.items)
    ? raw.items.map((value): WhatISaidPrompt => {
      const item = asObject(value);
      if (!item) {
        const error = new Error('What I said 목록 응답이 올바르지 않습니다.') as Error & { code?: string };
        error.code = 'WHAT_I_SAID_RESPONSE_INVALID';
        throw error;
      }
      const id = nullableString(item.id);
      const seq = sequenceText(item.seq);
      const recordedAt = nullableString(item.recordedAt);
      const text = typeof item.text === 'string' ? item.text : null;
      const agent = item.agent === 'claude' || item.agent === 'codex' ? item.agent : null;
      if (!id || seq === null || !recordedAt || text === null || !agent) {
        const error = new Error('What I said 목록 응답이 올바르지 않습니다.') as Error & { code?: string };
        error.code = 'WHAT_I_SAID_RESPONSE_INVALID';
        throw error;
      }
      return {
        id,
        seq,
        recordedAt,
        agent,
        projectId: nullableString(item.projectId),
        ...(nullableString(item.memoryId) ? { memoryId: nullableString(item.memoryId) } : {}),
        projectName: nullableString(item.projectName),
        text,
        deviceId: nullableString(item.deviceId),
        deviceName: nullableString(item.deviceName),
        promptOrigin: item.promptOrigin === 'human' || item.promptOrigin === 'agentstoz'
          ? item.promptOrigin
          : 'unknown',
        ...(item.storage === 'supabase' || item.storage === 'local'
          ? { storage: item.storage }
          : {}),
      };
    })
    : [];
  const nextBeforeSeq = listCursorText(raw.nextBeforeSeq);
  const capture = asObject(raw.capture);
  return {
    items,
    nextBeforeSeq,
    hasMore: raw.hasMore === true || nextBeforeSeq !== null,
    scan: normalizeScanSummary(raw.scan),
    // 필드가 없으면 모르는 것이다. 「수집한 적 없음」은 서버가 실제로 그렇게 답할 때만.
    capture: capture
      ? {
          // 문자열이 아닌 값은 「수집한 적 없음」이 아니라 「모름」이다. null 로 낮추면
          // 608건이 든 기기에 「아직 수집된 적 없음」이 뜬다.
          lastCaptureAt: capture.lastCaptureAt === null
            ? null
            : nullableString(capture.lastCaptureAt) ?? undefined,
          oldestCaptureAt: capture.oldestCaptureAt === null
            ? null
            : nullableString(capture.oldestCaptureAt) ?? undefined,
        }
      : null,
    source: raw.source === 'supabase' ? 'supabase' : 'local',
  };
}

export function normalizeWhatISaidSourceStatus(payload: unknown): WhatISaidSourceStatus {
  const raw = unwrapStatusObject(payload);
  return {
    enabled: raw.enabled === true,
    // The address is a security boundary, not server-provided display content.
    // Never copy an arbitrary URL returned by a stale or foreign local service.
    sourceUrl: WHAT_I_SAID_SOURCE_URL,
  };
}

export function normalizeWhatISaidGlobalApplySummary(payload: unknown): WhatISaidGlobalApplySummary {
  const outer = asObject(payload) ?? {};
  const raw = asObject(outer.applied) ?? {};
  return {
    registeredProjects: nonNegativeInteger(raw.registeredProjects),
    appliedProjects: nonNegativeInteger(raw.appliedProjects),
    failedProjects: nonNegativeInteger(raw.failedProjects),
  };
}

export function normalizeWhatISaidGlobalStatus(payload: unknown): WhatISaidGlobalStatus {
  const raw = unwrapStatusObject(payload);
  const retentionDays = finiteInteger(raw.retentionDays);
  return {
    configured: raw.configured === true,
    enabled: raw.enabled === true,
    retentionDays: raw.retentionDays === 'forever'
      ? 'forever'
      : retentionDays === 30 || retentionDays === 90 || retentionDays === 365
        ? retentionDays
        : 90,
    analysisAllowed: raw.analysisAllowed === true,
    updatedAt: nullableString(raw.updatedAt),
  };
}

export function oneTimeWhatISaidAccessToken(payload: unknown): string | null {
  const outer = asObject(payload) ?? {};
  return typeof outer.accessToken === 'string' && /^[0-9a-f]{64}$/.test(outer.accessToken)
    ? outer.accessToken
    : null;
}

async function whatISaidRequest<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: JsonObject,
): Promise<T> {
  let status: number;
  let payload: unknown;
  if (isTauri() && String(import.meta.env.DEV) !== 'true') {
    // Rust authenticates the exact 3001 peer and forwards this request on the
    // same TCP connection. The WebView never receives the management secret.
    const proxied = asObject(await invoke<unknown>('what_i_said_management_request', {
      path,
      method,
      body: body ?? {},
    }));
    const proxiedStatus = finiteInteger(proxied?.status);
    if (proxiedStatus === null || proxiedStatus < 100 || proxiedStatus > 599 || !('body' in (proxied ?? {}))) {
      throw new Error('What I said 보안 응답을 확인하지 못했습니다.');
    }
    status = proxiedStatus;
    payload = proxied!.body;
  } else {
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    status = response.status;
    payload = await response.json().catch(() => ({}));
  }
  if (status < 200 || status >= 300) {
    const data = asObject(payload);
    const message = nullableString(data?.error) ?? nullableString(data?.message) ?? `Request failed (${status})`;
    const error = new Error(message) as Error & { code?: string };
    const code = nullableString(data?.code);
    if (code) error.code = code;
    throw error;
  }
  return payload as T;
}

export const whatISaidApi = {
  globalStatus() {
    return whatISaidRequest<unknown>('/api/what-i-said/global-status', 'POST', {});
  },
  status(folderPath: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/status', 'POST', { folderPath });
  },
  statusMemory(memoryId: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/status', 'POST', { memoryId });
  },
  configure(input: { folderPath: string; enabled: boolean; retentionDays: WhatISaidRetention; analysisAllowed: boolean }) {
    return whatISaidRequest<unknown>('/api/what-i-said/configure', 'POST', input);
  },
  configureAll(input: { enabled: boolean; retentionDays: WhatISaidRetention; analysisAllowed: boolean }) {
    return whatISaidRequest<unknown>('/api/what-i-said/configure-all', 'POST', input);
  },
  remoteStatus() {
    return whatISaidRequest<unknown>('/api/what-i-said/remote/status', 'POST', {});
  },
  remoteConfigure(enabled: boolean) {
    return whatISaidRequest<unknown>('/api/what-i-said/remote/configure', 'POST', { enabled });
  },
  remoteExclude(input: { memoryId: string; excluded: boolean }) {
    return whatISaidRequest<unknown>('/api/what-i-said/remote/exclude', 'POST', input);
  },
  remoteKeyStatus() {
    return whatISaidRequest<unknown>('/api/what-i-said/remote-key/status', 'POST', {});
  },
  remoteKeyIssue(input: { label?: string; keyId?: string }) {
    return whatISaidRequest<unknown>('/api/what-i-said/remote-key/issue', 'POST', input);
  },
  remoteKeyRevoke(keyId: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/remote-key/revoke', 'POST', { keyId });
  },
  capture(folderPath: string, backfill = false) {
    return whatISaidRequest<unknown>('/api/what-i-said/capture', 'POST', { folderPath, backfill });
  },
  sync(memoryIds: readonly string[], backfill = false) {
    return whatISaidRequest<unknown>('/api/what-i-said/sync', 'POST', { memoryIds: [...memoryIds], backfill });
  },
  list(input: {
    folderPath?: string;
    memoryIds?: string[];
    query?: string;
    agent?: WhatISaidAgent;
    origin?: WhatISaidPromptOrigin;
    beforeSeq?: string;
    limit: number;
  }) {
    return whatISaidRequest<unknown>('/api/what-i-said/list', 'POST', input);
  },
  deleteOne(folderPath: string, id: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/delete', 'POST', { folderPath, id });
  },
  deleteOneLocalOnly(folderPath: string, id: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/delete', 'POST', { folderPath, id, localOnly: true });
  },
  deleteProject(folderPath: string, localOnly = false) {
    return whatISaidRequest<unknown>('/api/what-i-said/delete', 'POST', { folderPath, all: true, ...(localOnly ? { localOnly: true } : {}) });
  },
  deleteMemory(memoryId: string, localOnly = false) {
    return whatISaidRequest<unknown>('/api/what-i-said/delete', 'POST', { memoryId, all: true, ...(localOnly ? { localOnly: true } : {}) });
  },
  sourceStatus(folderPath: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/source/status', 'POST', { folderPath });
  },
  enableSource(folderPath: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/source/enable', 'POST', { folderPath });
  },
  rotateSource(folderPath: string) {
    return whatISaidRequest<unknown>('/api/what-i-said/source/rotate', 'POST', { folderPath });
  },
  disableSource(folderPath?: string, projectId?: string, removingProjectIds?: readonly string[]) {
    return whatISaidRequest<unknown>('/api/what-i-said/source', 'DELETE', {
      ...(folderPath ? { folderPath } : {}),
      ...(projectId ? { projectId } : {}),
      ...(removingProjectIds ? { removingProjectIds: [...removingProjectIds] } : {}),
    });
  },
};

export function whatISaidProjectPath(project: WhatISaidProject): string | null {
  return nullableString(project.worktreePath) ?? nullableString(project.folderPath);
}

export function selectableWhatISaidProjects(projects: readonly WhatISaidProject[]): WhatISaidProject[] {
  return projects.filter(project => !isGeneratedWorktreeRow(projects, project));
}

/**
 * 프로젝트 필터의 기본값. 하나의 프로젝트로 좁혀서 열면 그 프로젝트에 수집된
 * 것이 없을 때 빈 라이브러리가 뜨고, 그 아래 여백이 "레이아웃 오류"로 읽힌다
 * (VOC 2026-09-01 두 건이 40초 간격으로 같은 자리에 접수됐다).
 */
export const WHAT_I_SAID_DEFAULT_PROJECT_FILTER = 'all';

export function reconcileWhatISaidProjectFilter(
  current: string,
  projects: readonly Pick<WhatISaidProject, 'id'>[],
): string {
  if (current === 'all') return current;
  if (projects.some(project => project.id === current)) return current;
  // 고른 프로젝트가 사라지면 임의의 다른 프로젝트로 조용히 갈아타지 않는다 —
  // 기본값으로 돌아가야 무엇을 보고 있는지가 라벨과 어긋나지 않는다.
  return WHAT_I_SAID_DEFAULT_PROJECT_FILTER;
}

export function whatISaidConnectionBundle(accessKey: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    protocol: 'AgentsToZ-HMAC v1',
    endpoint_url: WHAT_I_SAID_SOURCE_URL,
    access_key: accessKey,
  }, null, 2);
}

const copy = {
  ko: {
    title: '내가 한 말',
    intro: 'Claude·Codex에 보낸 사용자 프롬프트만 모았습니다. 답변·도구 기록은 제외하고, AgentsToZ 복붙과 직접 입력 출처를 구분합니다.',
    localOnly: '이 기기에만 저장되어 있습니다. 수동 동기화하면 같은 장기기억을 쓰는 다른 Mac에서도 조회됩니다.',
    // ⚠️ 원격 적재가 켜지면 위 문장은 더 이상 참이 아니다. 문구를 함께 바꾸지 않으면
    // 앱이 거짓말을 하게 되므로 배지는 항상 실제 상태를 따라간다.
    remoteOn: '장기기억별 프롬프트를 Supabase에서 공유합니다. 제외한 장기기억만 빠집니다.',
    remoteCopiesRemain: (count: number) => `자동 적재는 꺼져 있지만 Supabase에 장기기억 사본 ${count.toLocaleString()}개가 남아 있습니다.`,
    remoteTitle: '다른 단말·앱에서 쓰기 위한 원격 적재',
    remoteIntro: '적재 건수와 라이브러리는 Supabase의 전체 단말 기록을 조회합니다. 아래 수집·적재 설정은 이 단말에 등록된 장기기억에 적용됩니다.',
    remoteRedaction: '원문이 아니라 레닥션을 통과한 결과만 올라갑니다. 키·토큰처럼 확실한 시크릿이 든 프롬프트는 본문 없이 기록만 남고, 경로·이메일·전화번호는 치환됩니다.',
    remoteEnable: '모든 장기기억의 프롬프트 적재',
    remoteEnabled: '적재 켜짐',
    remoteDisabled: '적재 꺼짐',
    remoteRetained: '적재 꺼짐 · 원격 사본 남음',
    remoteUnknown: '적재 상태 확인 불가',
    remoteScopeUnknown: '원격 적재 상태를 확인하지 못했습니다. 확인 전에는 로컬 전용이라고 단정하지 않습니다.',
    remoteNoCredentials: 'Supabase 주소와 서비스 키가 있어야 실제로 올라갑니다. 설정에서 먼저 연결하세요.',
    remoteStored: (count: number) => `Supabase 전체 단말에서 ${count.toLocaleString()}개 적재됨`,
    remoteExcludeTitle: '제외할 장기기억',
    remoteExcludeHelp: '목록은 장기기억 하나에 한 줄입니다(같은 저장소의 워크트리는 한 줄로 묶입니다). 제외하면 앞으로 올리지 않고, 어느 Mac이 올렸든 이미 올라간 행을 함께 지웁니다. 다시 포함하면 다음 수집 때 올라갑니다.',
    remoteExcluded: '제외됨',
    remoteIncluded: '포함',
    remoteExclusionUnknown: '확인 불가',
    remoteNoProjects: '적재 대상 장기기억이 없습니다.',
    remoteDeleted: (count: number) => `제외하고 원격 ${count.toLocaleString()}개를 지웠습니다.`,
    localDeleteOnly: '요청대로 로컬 기록만 삭제했습니다. 확인하지 못한 원격 사본은 남아 있을 수 있습니다.',
    localOnlyDeleteConfirm: '원격 사본을 삭제했는지 확인할 수 없습니다. 원격에는 기록이 남을 수 있습니다. 그래도 이 기기의 로컬 기록만 삭제할까요?',
    remoteKeyTitle: '외부 앱 연결 키',
    remoteKeyIntro: '연결할 앱마다 키를 하나 만듭니다. 이 키는 적재된 「내가 한 말」 프롬프트를 읽습니다. 제외한 장기기억의 프롬프트는 제공하지 않습니다. 장기기억 본문을 읽으려면 「장기기억」 화면의 외부 앱 연결 키를 사용하세요.',
    remoteKeyLabel: '연결할 앱 이름',
    remoteKeyLabelPlaceholder: '예: 영어공부 앱',
    remoteKeyScopeAll: '적재된 전부',
    remoteKeyScopeNarrow: (count: number) => `장기기억 ${count}개로 제한`,
    remoteKeyEndpoint: 'API 주소',
    remoteKeyValue: '인증 키',
    remoteKeyReveal: '키 보기',
    remoteKeyHide: '키 가리기',
    remoteKeyIssue: '연결 키 만들기',
    remoteKeyRotate: '키 새로 발급',
    remoteKeyRevoke: '연결 끊기',
    remoteKeyNone: '아직 만든 연결 키가 없습니다.',
    remoteKeyIssued: '연결 키를 발급했습니다. 언제든 다시 볼 수 있습니다.',
    remoteKeyRevoked: '연결 키를 회수했습니다. 이 키를 쓰던 앱은 즉시 읽지 못합니다.',
    remoteKeyRotateConfirm: '새 키를 발급하면 지금 키를 쓰던 앱은 즉시 읽지 못합니다. 계속할까요?',
    remoteKeyRevokeConfirm: '연결을 끊으면 이 키를 쓰던 앱이 즉시 읽지 못합니다. 계속할까요?',
    remoteKeyUsage: (value: string) => `마지막 사용 · ${value}`,
    remoteKeyNeverUsed: '아직 사용되지 않았습니다.',
    remoteKeyHowTo: '앱에는 위 주소를 Authorization: Bearer <인증 키> 헤더와 함께 GET 하도록 등록하세요. 응답의 nextCursor 를 after 로 넘겨 이어 읽고, 같은 id 가 다시 오면 건너뛰면 됩니다.',
    sameUserTrust: '이 보호는 웹·다른 OS 계정을 차단합니다. 같은 사용자 권한으로 실행한 프로젝트 코드와 로컬 앱은 사용자의 transcript·키체인 등 로컬 파일에 접근할 수 있으므로 신뢰하는 코드만 실행하세요.',
    captureTitle: '모든 장기기억의 프롬프트 저장 정책',
    globalScopeHelp: '이 설정은 선택한 장기기억 하나가 아니라 이 기기에 등록된 모든 장기기억과 앞으로 추가할 장기기억에 적용됩니다.',
    globalConfigured: '전체 저장 정책 설정됨',
    globalNotConfigured: '전체 저장 정책 미설정',
    bulkSyncTitle: '프롬프트 일괄 수집·동기화',
    bulkSyncHelp: '체크한 장기기억의 프롬프트를 지금 수집하고 Supabase에 동기화합니다. 자동 수집의 켜기·끄기는 위 저장 정책에서 설정합니다.',
    memoryListLoading: '장기기억 목록을 불러오는 중입니다.',
    memoryListError: '장기기억 목록을 불러오지 못했습니다. 새로고침해 주세요.',
    projectStatusTitle: '장기기억별 프롬프트 상태',
    projectStatusHelp: '장기기억 하나의 수집 상태와 저장 건수를 확인합니다. 이 선택은 위의 일괄 수집 대상을 바꾸지 않습니다.',
    captureProject: '상태를 확인할 장기기억',
    noProject: '장기기억이 있는 프로젝트가 없습니다. 「프로젝트·폴더」 탭에서 로컬 경로를 연결하고 장기기억을 먼저 시작하세요.',
    captureEnabled: '등록된 모든 장기기억에서 프롬프트 자동 저장',
    captureEnabledHelp: '한 번 켜면 현재 등록된 모든 장기기억의 저장 시작 시점을 즉시 맞추고, 앞으로 등록할 장기기억에도 적용됩니다. 앱이 실행 중이면 15초마다 장기기억 하나씩 순환하며 자동 수집합니다. 대상이 많으면 한 바퀴에 수 분 걸릴 수 있습니다. 세션 저장이나 「지금 수집」으로 즉시 가져올 수도 있습니다.',
    retention: '보관 기간',
    days30: '30일',
    days90: '90일',
    days365: '365일',
    forever: '직접 삭제할 때까지',
    analysisAllowed: 'AI 분석 사용을 별도로 허용',
    analysisHelp: '이 동의는 설정만 저장합니다. 지금 모델을 호출하거나 프롬프트를 외부로 보내지 않습니다.',
    startAll: '모든 장기기억 프롬프트 저장 시작',
    applyAll: '모든 장기기억에 설정 다시 적용',
    stopAll: '모든 장기기억 프롬프트 저장 중지',
    saving: '저장 중…',
    captureNow: '새로 오간 대화만 가져오기',
    syncSelected: '프롬프트 일괄 수집·동기화',
    syncSelectedCount: (count: number) => `선택한 ${count}개 기억 수집·동기화`,
    syncSelectedHelp: '리멤버세션을 하지 않았어도 선택한 장기기억의 Claude·Codex 프롬프트를 지금 수집하고 Supabase에 올립니다.',
    selectMemories: '수집할 장기기억 · 여러 개 선택',
    selectAll: '전체 선택',
    clearSelection: '선택 해제',
    selectedCount: (count: number) => `수집 대상 ${count}개`,
    synced: (captured: number, pushed: number, succeeded: number, requested: number) => `${requested}개 중 ${succeeded}개 기억 동기화 완료 · 새 수집 ${captured}개 · 업로드 ${pushed}개`,
    captureNowScope: '담기는 범위 · 마지막으로 가져온 뒤에 오간 대화. 평소에는 이것으로 충분합니다.',
    backfill: '켜기 전 대화까지 처음부터 가져오기',
    backfillHelp: '담기는 범위 · 저장을 켜기 전에 오간 대화까지 거슬러 올라가 처음부터 다시 훑습니다. 이미 담긴 것은 중복으로 걸러지므로 두 번 쌓이지 않습니다.',
    backfillConfirm: (count: number) => `선택한 ${count}개 장기기억에 저장을 켜기 전의 과거 프롬프트까지 수집하고 동기화합니다. 계속할까요?`,
    notCapturedYetTitle: '아직 이 장기기억의 프롬프트를 수집하지 않았습니다.',
    notCapturedYetBody: '저장을 켜고 앱을 실행해 두면 대상별로 순환 수집합니다. 아직 빠진 기록은 위의 수집·동기화 버튼으로 가져오세요.',
    storedCountLabel: (count: number) => `저장 ${count}건`,
    capturing: '수집 중…',
    captureNowHelp: '「세션 기억하기」는 장기기억 갱신과 프롬프트 수집·동기화를 함께 합니다. 기억을 갱신하지 않고 프롬프트만 즉시 반영하려면 아래 수동 버튼을 누르세요.',
    captureDisabledHint: '수집을 켜고 설정을 저장하면 사용할 수 있습니다.',
    deviceScopeTitle: '이 기기',
    deviceScopeHelp: '프롬프트는 이 기기에서 수집되지만 memoryId로 Supabase에 합쳐집니다. 아래 라이브러리에서 다른 Mac이 수집한 기록도 함께 조회합니다.',
    deviceUnknown: '기기 이름이 설정되지 않았습니다',
    deviceMissingHelp: '이 기기의 신원을 읽지 못했습니다. 지금 저장되는 프롬프트에는 출처 기기가 남지 않으며, 포털 설정에서 기기 이름을 저장하면 그 뒤부터 함께 기록됩니다.',
    cryptoUnavailable: '수집은 꺼졌지만 기존 암호화 키를 확인하지 못했습니다. 키체인/DPAPI를 복구하기 전에는 기존 프롬프트를 읽거나 완전 삭제할 수 없습니다.',
    statusLoading: '수집 설정을 확인하는 중입니다.',
    statusError: '수집 설정을 불러오지 못했습니다.',
    retry: '다시 시도',
    enabled: '전체 저장 켜짐',
    disabled: '전체 저장 꺼짐',
    projectEnabled: '자동 저장 대상',
    projectDisabled: '자동 저장 중지됨',
    saved: (applied: number, registered: number) => `현재 등록 장기기억 ${registered}개 중 ${applied}개에 자동 저장 시작을 적용했습니다. 앞으로 등록할 장기기억에도 자동 적용됩니다.`,
    stopped: (applied: number, registered: number) => `현재 등록 장기기억 ${registered}개 중 ${applied}개의 자동 저장을 중지했고, 앞으로 등록할 장기기억에도 중지 설정이 적용됩니다.`,
    sharedPolicyUnavailable: '이 Mac 로컬에는 적용했지만 Supabase의 장기기억 공유 정책을 저장하지 못했습니다. 연결을 확인한 뒤 다시 적용하세요.',
    captured: (count: number | null) => count === null ? '현재 transcript를 확인했습니다.' : `${count}개 프롬프트를 수집했습니다.`,
    lastCapture: '마지막 수집',
    savedCount: '저장된 프롬프트',
    never: '아직 없음',
    deleteProject: '이 장기기억의 프롬프트 모두 삭제',
    deleteProjectConfirm: (name: string) => `「${name}」에 저장된 프롬프트를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
    projectDeleted: '선택한 장기기억의 프롬프트를 삭제했습니다.',
    libraryTitle: '프롬프트 라이브러리',
    libraryHelp: '기본은 「모든 장기기억」이며 Supabase 적재 순서로 최근 50개씩 읽습니다. 과거 대화를 뒤늦게 수집하면 대화 날짜와 목록 순서가 다를 수 있습니다. 검색도 선택한 memoryId 전체에 적용됩니다.',
    lastCollectedDays: (days: number) => `마지막 수집 ${days}일 전`,
    lastCollectedHours: (hours: number) => `마지막 수집 ${hours}시간 전`,
    lastCollectedRecent: '마지막 수집 방금 전',
    neverCollected: '아직 수집된 적 없음',
    staleCaptureNote: (action: string) => `앱이 실행 중이면 자동 저장 대상을 순환 수집합니다. 앱이 꺼져 있던 동안의 대화는 다음 수집 때 반영됩니다. 이전 대화가 빠져 있으면 위 「${action}」 버튼으로 수집·동기화하세요.`,
    searchLabel: '프롬프트 검색',
    searchPlaceholder: '내가 한 말에서 검색',
    search: '검색',
    projectFilter: '장기기억 필터',
    allProjects: '모든 장기기억',
    agentFilter: '에이전트 필터',
    allAgents: 'Claude와 Codex',
    originFilter: '입력 출처 필터',
    allOrigins: '모든 입력 출처',
    humanOrigin: '직접 입력',
    agentstozOrigin: 'AgentsToZ 복붙',
    unknownOrigin: '기존·확인 불가',
    refresh: '새로고침',
    loading: '프롬프트를 불러오는 중입니다.',
    loadError: '프롬프트를 불러오지 못했습니다.',
    emptyTitle: '아직 수집된 프롬프트가 없습니다.',
    emptyBody: '모든 장기기억의 프롬프트 자동 저장을 켜면 앱이 실행 중일 때 대상별로 순환 수집합니다.',
    noResultsTitle: '조건에 맞는 프롬프트가 없습니다.',
    noResultsBody: '검색어나 장기기억·에이전트·입력 출처 필터를 바꿔보세요.',
    clearFilters: '필터 지우기',
    unknownProject: '장기기억 알 수 없음',
    copyPrompt: '프롬프트 복사',
    promptCopied: '프롬프트를 복사했습니다.',
    deletePrompt: '프롬프트 삭제',
    deletePromptConfirm: '이 프롬프트를 삭제할까요? 원격 적재된 사본이 있으면 먼저 삭제한 뒤 로컬 기록을 지웁니다.',
    promptDeleted: '프롬프트를 삭제했습니다.',
    loadMore: '더 불러오기',
    loadingMore: '더 불러오는 중…',
    partialScan: (unreadable: number, withheld: number) => `일부 기록을 표시하지 못했습니다. 읽기 실패 ${unreadable}개 · 보류 ${withheld}개`,
    enableSource: '외부 앱 연결 키 만들기',
    enablingSource: '연결 키 만드는 중…',
    copyAddress: '주소 복사',
    addressCopied: 'API 주소를 복사했습니다.',
    copied: '복사됨',
    copying: '복사 중…',
    accessKey: '접근 키',
    copyKey: '접근 키 복사',
    keyCopied: '접근 키를 복사했습니다.',
    keyRotated: '접근 키를 재발급했습니다. 기존 키는 더 이상 작동하지 않습니다.',
    copyFailed: '자동 복사에 실패했습니다. 표시된 값을 선택해 직접 복사하세요.',
    actionFailed: '요청을 완료하지 못했습니다.',
  },
  en: {
    title: 'What I said',
    intro: 'Your prompts to Claude and Codex. Replies and tool traffic are excluded, and AgentsToZ-pasted prompts are distinguished from direct input.',
    localOnly: 'Prompts exist only on this device. Manual sync makes them available on another Mac using the same memory.',
    remoteOn: 'Prompts are shared through Supabase by long-term memory. Only excluded memories stay out.',
    remoteCopiesRemain: (count: number) => `Automatic upload is off, but ${count.toLocaleString()} memory-scoped copies remain in Supabase.`,
    remoteTitle: 'Remote upload for other devices and apps',
    remoteIntro: 'The count and library read Supabase records from all devices. Collection and upload settings below apply to memories registered on this device.',
    remoteRedaction: 'Only the redacted projection is uploaded, never the raw prompt. A prompt holding a definite secret is recorded without its body, and paths, emails and phone numbers are replaced.',
    remoteEnable: 'Upload prompts from every long-term memory',
    remoteEnabled: 'Upload on',
    remoteDisabled: 'Upload off',
    remoteRetained: 'Upload off · remote copies remain',
    remoteUnknown: 'Upload status unavailable',
    remoteScopeUnknown: 'Remote upload status could not be verified. The data is not described as local-only until it is known.',
    remoteNoCredentials: 'A Supabase URL and service key are required before anything is uploaded. Connect them in settings first.',
    remoteStored: (count: number) => `${count.toLocaleString()} uploaded to Supabase across all devices`,
    remoteExcludeTitle: 'Long-term memories to exclude',
    remoteExcludeHelp: 'One row per long-term memory (worktrees of one repository collapse into a single row). Excluding stops future uploads and deletes what any Mac already uploaded. Including it again uploads on the next capture.',
    remoteExcluded: 'Excluded',
    remoteIncluded: 'Included',
    remoteExclusionUnknown: 'Unavailable',
    remoteNoProjects: 'No long-term memory is eligible for upload.',
    remoteDeleted: (count: number) => `Excluded and deleted ${count.toLocaleString()} remote rows.`,
    localDeleteOnly: 'Deleted only the local record as requested. An unverified remote copy may remain.',
    localOnlyDeleteConfirm: 'The remote copy could not be verified and may remain. Delete only this device’s local record anyway?',
    remoteKeyTitle: 'External app key',
    remoteKeyIntro: 'Create one key per connected app. This key reads uploaded What I said prompts. Prompts from excluded memories are not available. To read memory content, use External app keys on the Long-term memory screen.',
    remoteKeyLabel: 'Name of the connected app',
    remoteKeyLabelPlaceholder: 'e.g. English study app',
    remoteKeyScopeAll: 'Everything uploaded',
    remoteKeyScopeNarrow: (count: number) => `Limited to ${count} memories`,
    remoteKeyEndpoint: 'API address',
    remoteKeyValue: 'Access key',
    remoteKeyReveal: 'Show key',
    remoteKeyHide: 'Hide key',
    remoteKeyIssue: 'Create connection key',
    remoteKeyRotate: 'Issue a new key',
    remoteKeyRevoke: 'Disconnect',
    remoteKeyNone: 'No connection key yet.',
    remoteKeyIssued: 'Connection key created. You can view it again at any time.',
    remoteKeyRevoked: 'Connection key revoked. Apps using it can no longer read.',
    remoteKeyRotateConfirm: 'A new key immediately stops any app using the current one. Continue?',
    remoteKeyRevokeConfirm: 'Disconnecting immediately stops any app using this key. Continue?',
    remoteKeyUsage: (value: string) => `Last used · ${value}`,
    remoteKeyNeverUsed: 'Not used yet.',
    remoteKeyHowTo: 'Register the address above in the app and GET it with an Authorization: Bearer <access key> header. Pass the response nextCursor as after, and skip an id you have already seen.',
    sameUserTrust: 'This boundary blocks the web and other OS accounts. Project code and local apps you run as the same OS user can access local files such as transcripts and Keychain, so run only code you trust.',
    captureTitle: 'Prompt-saving policy for every long-term memory',
    globalScopeHelp: 'This policy applies to every long-term memory registered on this device and to memories added later, not only the one selected below.',
    globalConfigured: 'All-memory policy configured',
    globalNotConfigured: 'All-memory policy not configured',
    bulkSyncTitle: 'Collect and sync prompts in bulk',
    bulkSyncHelp: 'Collect prompts from the checked memories and sync them to Supabase now. Manage automatic collection in the saving policy above.',
    memoryListLoading: 'Loading long-term memories.',
    memoryListError: 'Could not load long-term memories. Please refresh.',
    projectStatusTitle: 'Prompt status by memory',
    projectStatusHelp: 'Check collection status and stored counts for one memory. This selection does not change the bulk collection targets above.',
    captureProject: 'Memory to inspect',
    noProject: 'No project has a long-term memory yet. Connect a local path in the Projects & folders tab and start its memory first.',
    captureEnabled: 'Automatically save prompts from every registered long-term memory',
    captureEnabledHelp: 'One setting aligns capture consent for registered memories and future ones. While the app runs, one memory is collected every 15 seconds in rotation. A full cycle can take several minutes. Session save and Capture now also import immediately.',
    retention: 'Retention',
    days30: '30 days',
    days90: '90 days',
    days365: '365 days',
    forever: 'Until I delete it',
    analysisAllowed: 'Separately allow AI analysis',
    analysisHelp: 'This only stores your consent. It does not call a model or send prompts anywhere now.',
    startAll: 'Start saving prompts for every memory',
    applyAll: 'Reapply settings to every memory',
    stopAll: 'Stop saving prompts for every memory',
    saving: 'Saving…',
    captureNow: 'Import only what is new',
    syncSelected: 'Collect and sync prompts in bulk',
    syncSelectedCount: (count: number) => `Collect and sync ${count} selected memories`,
    syncSelectedHelp: 'Even without Remember session, this captures Claude and Codex prompts for the selected memories and uploads them to Supabase now.',
    selectMemories: 'Memories to collect · select multiple',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
    selectedCount: (count: number) => `${count} collection targets`,
    synced: (captured: number, pushed: number, succeeded: number, requested: number) => `${succeeded} of ${requested} memories synced · ${captured} newly captured · ${pushed} uploaded`,
    captureNowScope: 'Range · conversations since the last import. This is the everyday choice.',
    backfill: 'Import from the start, including before it was on',
    backfillHelp: 'Range · reaches back past the moment saving was turned on and re-reads from the beginning. Anything already stored is filtered out as a duplicate, so nothing is stored twice.',
    backfillConfirm: (count: number) => `Collect and sync prompts from before saving was turned on for ${count} selected memories. Continue?`,
    notCapturedYetTitle: 'No prompts have been captured for this memory yet.',
    notCapturedYetBody: 'After enabling saving, collection cycles through memories while the app runs. Use the collection and sync action above for missing records.',
    storedCountLabel: (count: number) => `${count} stored`,
    capturing: 'Capturing…',
    captureNowHelp: 'Remember session updates long-term memory and also captures and syncs prompts. Use the manual action below to refresh prompts without changing memory.',
    captureDisabledHint: 'Turn capture on and save the setting to use this action.',
    deviceScopeTitle: 'This device',
    deviceScopeHelp: 'Prompts are captured on this device and merged in Supabase by memoryId. The library also shows records captured by other Macs.',
    deviceUnknown: 'No device name is set',
    deviceMissingHelp: 'This device’s identity could not be read. Prompts stored now carry no origin device; save a device name in the portal settings and it is recorded from then on.',
    cryptoUnavailable: 'Capture is off, but the existing encryption key is unavailable. Existing prompts cannot be read or irreversibly deleted until Keychain/DPAPI is restored.',
    statusLoading: 'Checking capture settings.',
    statusError: 'Could not load capture settings.',
    retry: 'Try again',
    enabled: 'All-memory saving on',
    disabled: 'All-memory saving off',
    projectEnabled: 'Included in automatic saving',
    projectDisabled: 'Automatic saving stopped',
    saved: (applied: number, registered: number) => `Automatic capture started for ${applied} of ${registered} registered long-term memories and will also apply to memories added later.`,
    stopped: (applied: number, registered: number) => `Automatic capture stopped for ${applied} of ${registered} registered long-term memories and will remain off for memories added later.`,
    sharedPolicyUnavailable: 'Applied locally on this Mac, but the shared Supabase memory policy could not be saved. Check the connection and apply again.',
    captured: (count: number | null) => count === null ? 'Checked the current transcripts.' : `Captured ${count} prompt${count === 1 ? '' : 's'}.`,
    lastCapture: 'Last capture',
    savedCount: 'Saved prompts',
    never: 'Not yet',
    deleteProject: 'Delete this memory’s prompts',
    deleteProjectConfirm: (name: string) => `Delete every saved prompt for “${name}”? This cannot be undone.`,
    projectDeleted: 'Deleted the selected memory’s prompts.',
    libraryTitle: 'Prompt library',
    libraryHelp: 'The library defaults to All memories and reads 50 prompts at a time from Supabase. Search applies across the selected memoryIds.',
    lastCollectedDays: (days: number) => `Last collected ${days} day${days === 1 ? '' : 's'} ago`,
    lastCollectedHours: (hours: number) => `Last collected ${hours} hour${hours === 1 ? '' : 's'} ago`,
    lastCollectedRecent: 'Last collected just now',
    neverCollected: 'Never collected yet',
    staleCaptureNote: (action: string) => `While the app runs, automatic saving cycles through registered memories. Conversations from while the app was closed are imported on the next cycle. For missing earlier conversations, use “${action}” above to collect and sync.`,
    searchLabel: 'Search prompts',
    searchPlaceholder: 'Search what I said',
    search: 'Search',
    projectFilter: 'Long-term memory filter',
    allProjects: 'All memories',
    agentFilter: 'Agent filter',
    allAgents: 'Claude and Codex',
    originFilter: 'Input origin filter',
    allOrigins: 'All input origins',
    humanOrigin: 'Typed directly',
    agentstozOrigin: 'Pasted from AgentsToZ',
    unknownOrigin: 'Legacy or unknown',
    refresh: 'Refresh',
    loading: 'Loading prompts.',
    loadError: 'Could not load prompts.',
    emptyTitle: 'No prompts have been captured yet.',
    emptyBody: 'Turn on automatic prompt saving for every long-term memory. Prompts are collected in rotation while the app runs.',
    noResultsTitle: 'No prompts match these filters.',
    noResultsBody: 'Try another search term, memory, agent, or input origin.',
    clearFilters: 'Clear filters',
    unknownProject: 'Unknown memory',
    copyPrompt: 'Copy prompt',
    promptCopied: 'Prompt copied.',
    deletePrompt: 'Delete prompt',
    deletePromptConfirm: 'Delete this prompt? Any uploaded copy is deleted before the local record.',
    promptDeleted: 'Prompt deleted.',
    loadMore: 'Load more',
    loadingMore: 'Loading more…',
    partialScan: (unreadable: number, withheld: number) => `Some records are not shown. Unreadable: ${unreadable} · withheld: ${withheld}`,
    enableSource: 'Create external-app connection key',
    enablingSource: 'Creating connection key…',
    copyAddress: 'Copy address',
    addressCopied: 'API address copied.',
    copied: 'Copied',
    copying: 'Copying…',
    accessKey: 'Access key',
    copyKey: 'Copy access key',
    keyCopied: 'Access key copied.',
    keyRotated: 'The access key was rotated. The previous key no longer works.',
    copyFailed: 'Automatic copy failed. Select the displayed value and copy it manually.',
    actionFailed: 'Could not complete the request.',
  },
};

// ─── Design tokens → class recipes (see src/index.css for the variables) ─────
// Surfaces: the settings column sits on --bg, so its fields use --surface; the
// library column sits on --surface, so its filter fields use --bg.
const FOCUS_RING_CLASS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';
const FIELD_BASE_CLASS = 'rounded-lg border border-[var(--line)] px-3 text-[var(--ink)] outline-none transition placeholder:text-[var(--ink-3)] focus:border-[var(--accent-line)] focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60 max-sm:min-h-11 max-sm:text-base';
const INPUT_CLASS = `h-[34px] w-full bg-[var(--surface)] text-[12.5px] ${FIELD_BASE_CLASS}`;
const SELECT_CLASS = `h-9 w-full bg-[var(--surface)] text-[13px] ${FIELD_BASE_CLASS}`;
const FILTER_INPUT_CLASS = `h-[34px] w-full bg-[var(--bg)] text-[12.5px] ${FIELD_BASE_CLASS}`;
const FILTER_SELECT_CLASS = `h-[34px] w-full bg-[var(--bg)] text-xs font-semibold ${FIELD_BASE_CLASS}`;
const BUTTON_BASE_CLASS = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11 ${FOCUS_RING_CLASS}`;
const PRIMARY_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-8 rounded-lg border-0 bg-[var(--ink)] px-3.5 text-xs font-bold text-[var(--bg)] hover:opacity-90`;
const CTA_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-[38px] w-full rounded-[9px] border-0 bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--bg)] hover:opacity-90`;
const SECONDARY_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-8 rounded-lg border border-[var(--line)] bg-transparent px-3 text-xs font-semibold text-[var(--ink-2)] hover:border-[var(--line-2)] hover:text-[var(--ink)]`;
const DANGER_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-8 rounded-lg border border-[var(--line)] bg-transparent px-3 text-xs font-semibold text-[var(--danger)] hover:border-[var(--line-2)] hover:bg-[var(--danger-soft)]`;
const CHIP_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-[26px] rounded-md border border-[var(--line)] bg-transparent px-2.5 text-xs font-semibold text-[var(--ink-2)] hover:border-[var(--line-2)] hover:text-[var(--ink)]`;
const ICON_BUTTON_CLASS = `${BUTTON_BASE_CLASS} h-8 w-8 shrink-0 rounded-lg border border-[var(--line)] bg-transparent text-[var(--ink-2)] hover:border-[var(--line-2)] hover:text-[var(--ink)] max-sm:min-w-11`;
const PROMPT_ACTION_CLASS = `${BUTTON_BASE_CLASS} h-[22px] w-[22px] rounded-[5px] border-0 bg-transparent text-[var(--ink-3)] hover:bg-[var(--raised)] hover:text-[var(--ink)] max-sm:min-w-11`;
const SECTION_TITLE_CLASS = 'm-0 text-[13px] font-bold text-[var(--ink)]';
const LABEL_CLASS = 'block text-[11.5px] font-semibold text-[var(--ink-2)]';
const HELP_CLASS = 'text-xs leading-[1.55] text-[var(--ink-2)]';
const CAPTION_CLASS = 'text-[11.5px] leading-5 text-[var(--ink-3)]';
const DIVIDER_CLASS = 'h-px shrink-0 bg-[var(--line)]';
const BADGE_CLASS = 'inline-flex h-5 items-center rounded-[5px] px-[7px] text-[10.5px] font-bold';
const CHIP_CLASS = 'inline-flex h-5 items-center rounded-[5px] px-[7px] text-[11px]';
const STATUS_PILL_CLASS = 'inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold';
const BANNER_BASE_CLASS = 'rounded-[9px] px-3 py-2.5 text-xs leading-[1.55]';
const BANNER_WARN_CLASS = `${BANNER_BASE_CLASS} bg-[var(--warn-soft)] text-[var(--ink)]`;
const BANNER_DANGER_CLASS = `${BANNER_BASE_CLASS} bg-[var(--danger-soft)] text-[var(--ink)]`;
const INSET_CARD_CLASS = 'rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-3';
const CODE_FIELD_CLASS = 'min-w-0 flex-1 truncate rounded-lg border border-[var(--line)] bg-[var(--sunken)] px-2 py-1.5 font-mono text-[11px] text-[var(--ink)]';
const CHECKBOX_CLASS = 'mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]';
const LOADING_CLASS = 'flex min-h-20 items-center justify-center gap-2 text-xs text-[var(--ink-2)]';
const EMPTY_STATE_CLASS = 'rounded-xl border border-dashed border-[var(--line-2)] px-4 py-10 text-center text-[12.5px] text-[var(--ink-3)]';

const readCapturedCount = (payload: unknown): number | null => {
  const raw = asObject(payload) ?? {};
  const direct = finiteInteger(raw.captured);
  if (direct !== null && direct >= 0) return direct;
  const result = asObject(raw.result);
  const nested = finiteInteger(result?.captured);
  return nested !== null && nested >= 0 ? nested : null;
};

const formatDateTime = (value: string | null, language: WhatISaidLanguage): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

export const whatISaidErrorMessage = (error: unknown, fallback: string, language: WhatISaidLanguage): string => {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : '';
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // A new desktop bundle deliberately refuses to proxy sensitive management
  // calls through an older sidecar on port 3001. That is a recovery action,
  // not a corrupt prompt store: closing the previous app releases its sidecar
  // so the current bundle can start and run the safe SQLite migration.
  if (code === 'WHAT_I_SAID_SCHEMA_UNSUPPORTED'
    || /What I said .*보안 연결을 확인하지 못했습니다|What I said 보안 응답을 확인하지 못했습니다/i.test(message)) {
    return language === 'ko'
      ? '포트 3001의 로컬 API와 이 앱의 보안 연결이 일치하지 않습니다. 이전 앱 또는 개발용 API를 종료한 뒤 현재 앱을 다시 열어주세요. 앱이 번들 API를 실행하면 클라우드 상태를 다시 조회할 수 있습니다.'
      : 'The API on port 3001 does not match this app’s secure connection. Stop the previous app or development API and reopen this app so its bundled API can read the cloud state.';
  }
  // Local API messages are intentionally fixed, but they are authored in
  // Korean. English UI maps stable codes to its own contextual copy instead of
  // leaking the server language into the panel.
  if (language === 'en' && code) return fallback;
  return message || fallback;
};

const canFallBackToExplicitLocalDelete = (error: unknown): boolean => {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : '';
  return code === 'WHAT_I_SAID_REMOTE_DELETE_UNVERIFIED'
    || code === 'WHAT_I_SAID_REMOTE_DELETE_FAILED';
};

export function WhatISaidPanel({ projects, language, visible }: WhatISaidPanelProps) {
  const t = copy[language];
  const idPrefix = useId();
  const [remoteStatus, setRemoteStatus] = useState<WhatISaidRemoteStatus | null>(null);
  const [remoteStatusUnavailable, setRemoteStatusUnavailable] = useState(false);
  const [remoteStatusError, setRemoteStatusError] = useState('');
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const [remoteKey, setRemoteKey] = useState<WhatISaidRemoteKeyStatus | null>(null);
  /** 어느 키의 원문을 펼쳐 두었는지. 한 번에 하나만 보여 준다. */
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState('');

  /**
   * 「내가 한 말」의 단위는 장기기억이다. 장기기억이 없는 행은 저장소 자체가 없어
   * 고르면 409 로 끝나므로 애초에 목록에 두지 않는다 — 실측(2026-09-01) 25행 중
   * 1행이 그 상태였고, 바로 아래 제외 목록은 24개를 보여 주고 있었다.
   * 어느 행이 장기기억을 갖는지는 서버만 알므로(`registeredWhatISaidProjects`),
   * 원격 상태가 실어 보내는 목록을 근거로 쓴다. 아직 못 읽었으면 예전처럼 전부
   * 보여 준다 — 목록이 비어 보이는 쪽이 더 고장처럼 읽힌다.
   */
  const memoryBackedPaths = useMemo(() => {
    const paths = (remoteStatus?.projects ?? [])
      .map(project => project.folderPath)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    return paths.length ? new Set(paths) : null;
  }, [remoteStatus]);

  const availableProjects = useMemo(() => selectableWhatISaidProjects(projects).flatMap(project => {
    const path = whatISaidProjectPath(project);
    if (!path) return [];
    if (memoryBackedPaths && !memoryBackedPaths.has(path)) return [];
    return [{ ...project, path }];
  }), [projects, memoryBackedPaths]);
  const projectNameById = useMemo(
    () => new Map(projects.map(project => [project.id, project.name])),
    [projects],
  );
  const projectPathById = useMemo(
    () => new Map(availableProjects.map(project => [project.id, project.path])),
    [availableProjects],
  );

  const availableScopes = useMemo(() => {
    if (remoteStatus) {
      return remoteStatus.projects.map(project => ({
        id: project.memoryId,
        memoryId: project.memoryId,
        name: project.name,
        path: project.folderPath,
      }));
    }
    return availableProjects.map(project => ({
      id: project.id,
      memoryId: null,
      name: project.name,
      path: project.path,
    }));
  }, [availableProjects, remoteStatus]);

  const libraryScopes = useMemo(() => {
    const scopes = new Map(availableScopes.map(scope => [scope.id, scope]));
    for (const project of remoteStatus?.cloudProjects ?? []) {
      if (!scopes.has(project.memoryId)) scopes.set(project.memoryId, {
        id: project.memoryId, memoryId: project.memoryId, name: project.name, path: '',
      });
    }
    return [...scopes.values()];
  }, [availableScopes, remoteStatus]);

  const [captureProjectId, setCaptureProjectId] = useState('');
  const captureProject = availableScopes.find(project => project.id === captureProjectId) ?? null;
  const captureFolderPath = captureProject?.path ?? null;
  const captureMemoryId = captureProject?.memoryId ?? null;
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<string[]>([]);

  const [globalState, setGlobalState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [globalStatus, setGlobalStatus] = useState<WhatISaidGlobalStatus | null>(null);
  const [globalError, setGlobalError] = useState('');
  const [captureState, setCaptureState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [captureStatus, setCaptureStatus] = useState<WhatISaidStatus | null>(null);
  const [captureError, setCaptureError] = useState('');
  const [retentionDraft, setRetentionDraft] = useState<WhatISaidRetention>(30);
  const [analysisDraft, setAnalysisDraft] = useState(false);
  const [captureBusy, setCaptureBusy] = useState<'configure' | 'capture' | 'backfill' | 'delete-project' | null>(null);

  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  // VOC 2026-09-01: scoping the panel to whichever project happened to sort
  // first showed an empty library — that project simply had nothing captured —
  // and the blank space under it read as a layout bug rather than a filter.
  // 모든 프로젝트 is the honest default: it shows what actually exists.
  // Still one page (limit 50), so this is a wider scan, not an unbounded one.
  const [projectFilterId, setProjectFilterId] = useState<string>(WHAT_I_SAID_DEFAULT_PROJECT_FILTER);
  const [agentFilter, setAgentFilter] = useState<'all' | WhatISaidAgent>('all');
  const [originFilter, setOriginFilter] = useState<'all' | WhatISaidPromptOrigin>('all');
  const [listState, setListState] = useState<{
    loading: boolean;
    loadingMore: boolean;
    loaded: boolean;
    error: string;
    items: WhatISaidPrompt[];
    nextBeforeSeq: string | null;
    hasMore: boolean;
    scan: WhatISaidScanSummary | null;
    capture: WhatISaidCaptureFreshnessSource | null;
  }>({
    loading: false,
    loadingMore: false,
    loaded: false,
    error: '',
    items: [],
    nextBeforeSeq: null,
    hasMore: false,
    scan: null,
    capture: null,
  });
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);

  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);


  const statusRequestRef = useRef(0);
  const globalStatusRequestRef = useRef(0);
  const listRequestRef = useRef(0);
  const sourceRequestRef = useRef(0);
  const syncSelectionInitializedRef = useRef(false);

  useEffect(() => {
    if (!availableScopes.length) {
      setCaptureProjectId('');
      return;
    }
    if (!availableScopes.some(project => project.id === captureProjectId)) {
      setCaptureProjectId(availableScopes[0]?.id ?? '');
    }
  }, [availableScopes, captureProjectId]);

  useEffect(() => {
    if (!remoteStatus) return;
    const valid = new Set(remoteStatus.projects.map(project => project.memoryId));
    setSelectedMemoryIds(current => {
      const retained = current.filter(memoryId => valid.has(memoryId));
      // First successful enumeration defaults to all memories so one manual
      // action can do the cross-device catch-up the user opened this card for.
      if (!syncSelectionInitializedRef.current) {
        syncSelectionInitializedRef.current = true;
        return remoteStatus.projects.map(project => project.memoryId);
      }
      return retained;
    });
  }, [remoteStatus]);

  useEffect(() => {
    const next = reconcileWhatISaidProjectFilter(projectFilterId, libraryScopes);
    if (next !== projectFilterId) setProjectFilterId(next);
  }, [libraryScopes, projectFilterId]);

  useEffect(() => {
    if (visible) return;
    setNotice(null);
  }, [visible]);

  useEffect(() => {
    setNotice(null);
  }, [captureMemoryId, captureFolderPath]);

  const loadGlobalStatus = useCallback(async () => {
    const requestId = ++globalStatusRequestRef.current;
    setGlobalState('loading');
    setGlobalError('');
    try {
      const payload = await whatISaidApi.globalStatus();
      if (requestId !== globalStatusRequestRef.current) return;
      const next = normalizeWhatISaidGlobalStatus(payload);
      setGlobalStatus(next);
      setRetentionDraft(next.retentionDays);
      setAnalysisDraft(next.analysisAllowed);
      setGlobalState('ready');
    } catch (error) {
      if (requestId !== globalStatusRequestRef.current) return;
      setGlobalStatus(null);
      setGlobalError(whatISaidErrorMessage(error, t.statusError, language));
      setGlobalState('error');
    }
  }, [language, t.statusError]);

  useEffect(() => {
    if (!visible) return;
    void loadGlobalStatus();
  }, [visible, loadGlobalStatus]);

  const loadCaptureStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current;
    if (!captureFolderPath && !captureMemoryId) {
      setCaptureState('idle');
      setCaptureStatus(null);
      setCaptureError('');
      return;
    }
    setCaptureState('loading');
    setCaptureStatus(null);
    setCaptureError('');
    try {
      const payload = captureMemoryId
        ? await whatISaidApi.statusMemory(captureMemoryId)
        : await whatISaidApi.status(captureFolderPath!);
      if (requestId !== statusRequestRef.current) return;
      const next = normalizeWhatISaidStatus(payload);
      setCaptureStatus(next);
      setCaptureState('ready');
    } catch (error) {
      if (requestId !== statusRequestRef.current) return;
      setCaptureStatus(null);
      setCaptureError(whatISaidErrorMessage(error, t.statusError, language));
      setCaptureState('error');
    }
  }, [captureFolderPath, captureMemoryId, language, t.statusError]);

  useEffect(() => {
    if (!visible) return;
    void loadCaptureStatus();
  }, [visible, loadCaptureStatus]);

  const projectFilterScope = projectFilterId === 'all'
    ? null
    : libraryScopes.find(project => project.id === projectFilterId) ?? null;
  const projectFilterReady = projectFilterId === 'all' || projectFilterScope !== null;
  const unresolvedFilterIsEmpty = !projectFilterReady && libraryScopes.length === 0;
  const projectFilterMemoryId = projectFilterScope?.memoryId;
  const projectFilterPath = projectFilterScope?.path;

  const loadPrompts = useCallback(async (append = false, beforeSeq?: string) => {
    const requestId = ++listRequestRef.current;
    if (!projectFilterReady) {
      setListState({
        loading: false,
        loadingMore: false,
        loaded: unresolvedFilterIsEmpty,
        error: '',
        items: [],
        nextBeforeSeq: null,
        hasMore: false,
        scan: null,
        capture: null,
      });
      return;
    }
    setListState(current => ({
      ...current,
      loading: !append,
      loadingMore: append,
      loaded: append ? current.loaded : false,
      error: '',
      items: append ? current.items : [],
      nextBeforeSeq: append ? current.nextBeforeSeq : null,
      hasMore: append ? current.hasMore : false,
      scan: append ? current.scan : null,
      // 범위를 바꿔 다시 읽는 중에는 직전 범위의 수집 시각을 계속 주장하지 않는다.
      capture: append ? current.capture : null,
    }));
    try {
      const payload = await whatISaidApi.list({
        ...(projectFilterMemoryId
          ? { memoryIds: [projectFilterMemoryId] }
          : projectFilterPath
            ? { folderPath: projectFilterPath }
            : {}),
        query: query.trim() || undefined,
        agent: agentFilter === 'all' ? undefined : agentFilter,
        origin: originFilter === 'all' ? undefined : originFilter,
        beforeSeq,
        limit: 50,
      });
      if (requestId !== listRequestRef.current) return;
      const page = normalizeWhatISaidListPage(payload);
      setListState(current => {
        const merged = append ? [...current.items, ...page.items] : page.items;
        const seen = new Set<string>();
        return {
          loading: false,
          loadingMore: false,
          loaded: true,
          error: '',
          items: merged.filter(item => !seen.has(item.id) && !!seen.add(item.id)),
          nextBeforeSeq: page.nextBeforeSeq,
          hasMore: page.hasMore && page.nextBeforeSeq !== null,
          scan: page.scan ?? (append ? current.scan : null),
          capture: page.capture ?? (append ? current.capture : null),
        };
      });
    } catch (error) {
      if (requestId !== listRequestRef.current) return;
      setListState(current => ({
        ...current,
        loading: false,
        loadingMore: false,
        loaded: true,
        error: whatISaidErrorMessage(error, t.loadError, language),
      }));
    }
  }, [agentFilter, unresolvedFilterIsEmpty, language, originFilter, projectFilterReady, projectFilterMemoryId, projectFilterPath, query, t.loadError]);

  useEffect(() => {
    if (!visible) return;
    void loadPrompts(false);
  }, [visible, loadPrompts]);

  const loadRemoteStatus = useCallback(async () => {
    try {
      const payload = await whatISaidApi.remoteStatus() as any;
      setRemoteStatus({
        enabled: payload?.enabled === true,
        cloudProjects: Array.isArray(payload?.cloudProjects) ? payload.cloudProjects.filter((project: any) =>
          typeof project?.memoryId === 'string' && typeof project?.name === 'string') : [],
        projects: Array.isArray(payload?.projects)
          ? payload.projects.flatMap((value: unknown) => {
            const project = asObject(value);
            const memoryId = nullableString(project?.memoryId);
            const name = nullableString(project?.name);
            const folderPath = nullableString(project?.folderPath);
            if (!memoryId || !name || !folderPath) return [];
            return [{
              memoryId,
              name,
              folderPath,
              excluded: project?.excluded === true ? true : project?.excluded === false ? false : null,
              captureConfigured: project?.captureConfigured === true,
              captureEnabled: project?.captureEnabled === true
                ? true
                : project?.captureEnabled === false ? false : null,
            }];
          })
          : [],
        deviceId: typeof payload?.deviceId === 'string' ? payload.deviceId : null,
        deviceName: typeof payload?.deviceName === 'string' ? payload.deviceName : null,
        credentialsReady: payload?.credentialsReady === true,
        exclusionsReady: payload?.exclusionsReady === true,
        storedRows: typeof payload?.storedRows === 'number' ? payload.storedRows : null,
        remoteError: typeof payload?.remoteError === 'string' ? payload.remoteError : null,
        sharedPolicyReady: payload?.sharedPolicyReady === true,
      });
      setRemoteStatusUnavailable(false);
      setRemoteStatusError('');
    } catch (error) {
      // 적재 상태를 못 읽는다고 패널 전체가 실패하면 안 된다 — 부가 카드다.
      setRemoteStatus(null);
      setRemoteStatusUnavailable(true);
      setRemoteStatusError(whatISaidErrorMessage(error, t.remoteScopeUnknown, language));
    }
  }, [language, t.remoteScopeUnknown]);

  useEffect(() => {
    if (!visible) return;
    void loadRemoteStatus();
  }, [visible, loadRemoteStatus]);

  const loadRemoteKey = useCallback(async () => {
    try {
      const payload = await whatISaidApi.remoteKeyStatus() as any;
      setRemoteKey({
        keys: Array.isArray(payload?.keys) ? payload.keys : [],
        endpoint: typeof payload?.endpoint === 'string' ? payload.endpoint : null,
        error: typeof payload?.error === 'string' ? payload.error : null,
      });
    } catch {
      setRemoteKey(null);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setRevealedKeyId(null);
    void loadRemoteKey();
  }, [visible, loadRemoteKey]);

  const issueRemoteKey = async (input: { keyId?: string; label?: string }) => {
    if (input.keyId && !window.confirm(t.remoteKeyRotateConfirm)) return;
    setRemoteBusy(input.keyId ?? 'new-key');
    try {
      await whatISaidApi.remoteKeyIssue(input);
      await loadRemoteKey();
      if (!input.keyId) setNewKeyLabel('');
      setNotice({ kind: 'success', message: t.remoteKeyIssued });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.remoteKeyTitle, language) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const revokeRemoteKey = async (keyId: string) => {
    if (!window.confirm(t.remoteKeyRevokeConfirm)) return;
    setRemoteBusy(keyId);
    try {
      await whatISaidApi.remoteKeyRevoke(keyId);
      await loadRemoteKey();
      setRevealedKeyId(null);
      setNotice({ kind: 'success', message: t.remoteKeyRevoked });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.remoteKeyTitle, language) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const toggleRemote = async (enabled: boolean) => {
    setRemoteBusy('toggle');
    try {
      await whatISaidApi.remoteConfigure(enabled);
      await loadRemoteStatus();
      setNotice({ kind: 'success', message: enabled ? t.remoteEnabled : t.remoteDisabled });
    } catch (error) {
      await loadRemoteStatus();
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.remoteTitle, language) });
    } finally {
      setRemoteBusy(null);
    }
  };

  const toggleRemoteExclusion = async (memoryId: string, excluded: boolean) => {
    setRemoteBusy(memoryId);
    try {
      const payload = await whatISaidApi.remoteExclude({ memoryId, excluded }) as any;
      await loadRemoteStatus();
      const deleted = typeof payload?.remoteDeleted === 'number' ? payload.remoteDeleted : 0;
      setNotice({
        kind: 'success',
        message: excluded ? t.remoteDeleted(deleted) : t.remoteIncluded,
      });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.remoteTitle, language) });
    } finally {
      setRemoteBusy(null);
    }
  };


  const saveCaptureSettings = async (enabled: boolean) => {
    if (captureBusy) return;
    setCaptureBusy('configure');
    setNotice(null);
    try {
      const payload = await whatISaidApi.configureAll({
        enabled,
        retentionDays: retentionDraft,
        analysisAllowed: analysisDraft,
      });
      const applied = normalizeWhatISaidGlobalApplySummary(payload);
      const response = asObject(payload);
      await Promise.all([loadGlobalStatus(), loadCaptureStatus()]);
      if (response?.sharedPolicyReady === false) {
        setNotice({ kind: 'error', message: t.sharedPolicyUnavailable });
        return;
      }
      setNotice({
        kind: 'success',
        message: enabled
          ? t.saved(applied.appliedProjects, applied.registeredProjects)
          : t.stopped(applied.appliedProjects, applied.registeredProjects),
      });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.actionFailed, language) });
    } finally {
      setCaptureBusy(null);
    }
  };

  const captureNow = async (backfill = false) => {
    if (!selectedMemoryIds.length || !globalStatus?.enabled || captureBusy) return;
    // Reaching back past the consent instant stores conversations the user did
    // not opt in for, so it happens only on an explicit confirmation.
    if (backfill && !window.confirm(t.backfillConfirm(selectedMemoryIds.length))) return;
    setCaptureBusy(backfill ? 'backfill' : 'capture');
    setNotice(null);
    try {
      const result = asObject(await whatISaidApi.sync(selectedMemoryIds, backfill)) ?? {};
      const requested = nonNegativeInteger(result.requested);
      const succeeded = nonNegativeInteger(result.succeeded);
      const captured = nonNegativeInteger(result.captured);
      const pushed = nonNegativeInteger(result.pushed);
      await Promise.all([loadCaptureStatus(), loadPrompts(false), loadRemoteStatus()]);
      setNotice({
        kind: succeeded === requested ? 'success' : 'error',
        message: t.synced(captured, pushed, succeeded, requested),
      });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.actionFailed, language) });
    } finally {
      setCaptureBusy(null);
    }
  };

  const deleteProjectPrompts = async () => {
    if ((!captureMemoryId && !captureFolderPath) || captureBusy || !window.confirm(t.deleteProjectConfirm(captureProject?.name ?? ''))) return;
    setCaptureBusy('delete-project');
    setNotice(null);
    try {
      let payload: any;
      try {
        payload = captureMemoryId
          ? await whatISaidApi.deleteMemory(captureMemoryId)
          : await whatISaidApi.deleteProject(captureFolderPath!);
      } catch (error) {
        if (!canFallBackToExplicitLocalDelete(error) || !window.confirm(t.localOnlyDeleteConfirm)) throw error;
        payload = captureMemoryId
          ? await whatISaidApi.deleteMemory(captureMemoryId, true)
          : await whatISaidApi.deleteProject(captureFolderPath!, true);
      }
      await Promise.all([loadCaptureStatus(), loadPrompts(false)]);
      setNotice({
        kind: 'success',
        message: payload?.remoteDeletion?.status === 'skipped' ? t.localDeleteOnly : t.projectDeleted,
      });
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.actionFailed, language) });
    } finally {
      setCaptureBusy(null);
    }
  };

  const deletePrompt = async (id: string) => {
    if (deletingPromptId || !window.confirm(t.deletePromptConfirm)) return;
    const prompt = listState.items.find(item => item.id === id);
    const promptFolderPath = prompt?.projectId ? projectPathById.get(prompt.projectId) : null;
    if (!promptFolderPath) {
      setNotice({ kind: 'error', message: t.actionFailed });
      return;
    }
    setDeletingPromptId(id);
    setNotice(null);
    try {
      let payload: any;
      try {
        payload = await whatISaidApi.deleteOne(promptFolderPath, id);
      } catch (error) {
        if (!canFallBackToExplicitLocalDelete(error) || !window.confirm(t.localOnlyDeleteConfirm)) throw error;
        payload = await whatISaidApi.deleteOneLocalOnly(promptFolderPath, id);
      }
      setListState(current => ({ ...current, items: current.items.filter(item => item.id !== id) }));
      setNotice({
        kind: 'success',
        message: payload?.remoteDeletion?.status === 'skipped' ? t.localDeleteOnly : t.promptDeleted,
      });
      if (captureFolderPath) void loadCaptureStatus();
    } catch (error) {
      setNotice({ kind: 'error', message: whatISaidErrorMessage(error, t.actionFailed, language) });
    } finally {
      setDeletingPromptId(null);
    }
  };

  const copyValue = async (value: string, successMessage: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setNotice({ kind: 'success', message: successMessage });
    } catch {
      setNotice({ kind: 'error', message: t.copyFailed });
    }
  };




  if (!visible) return null;

  // 기본값이 곧 '필터 없음'이다 — 손대지 않은 패널이 "필터가 걸려 있다"고
  // 주장하면 필터 지우기 버튼이 아무것도 지우지 못하는 상태로 뜬다.
  const defaultProjectFilterId = WHAT_I_SAID_DEFAULT_PROJECT_FILTER;
  // Capture is on for this project but nothing has landed in it yet — the
  // store exists and is simply waiting for the next session save.
  const notCapturedYet = projectFilterId !== 'all'
    && !!captureStatus?.enabled
    && captureStatus.count === 0;
  const filtersActive = !!query.trim()
    || (projectFilterId !== defaultProjectFilterId && projectFilterId !== '')
    || agentFilter !== 'all'
    || originFilter !== 'all';
  const scan = listState.scan;
  const scanHasWarning = !!scan && (!scan.complete || scan.unreadable > 0 || scan.withheld > 0);
  // 수집은 주기 실행이 없다 (api-server.ts: prompt import is session-bound).
  // 그래서 신선도를 세지 않으면 몇 주 묵은 라이브러리가 정상 라이브러리와 똑같이
  // 그려지고, 그것이 곧 「기능이 고장 났다」로 읽힌다.
  // 여기에는 타이머가 없다 — 목록을 다시 읽을 때만 다시 계산한다.
  const captureFreshness = useMemo(
    () => whatISaidCaptureFreshness(listState.capture),
    [listState.capture],
  );
  const captureNeedsAttention = captureFreshness.state === 'stale' || captureFreshness.state === 'never';
  const captureFreshnessLabel = captureFreshness.state === 'never'
    ? t.neverCollected
    : captureFreshness.days >= 1
      ? t.lastCollectedDays(captureFreshness.days)
      : captureFreshness.hours >= 1
        ? t.lastCollectedHours(captureFreshness.hours)
        : t.lastCollectedRecent;
  const syncableMemories = availableScopes.filter(
    (scope): scope is typeof scope & { memoryId: string } => typeof scope.memoryId === 'string',
  );
  // `enabled` is the requested local policy, not proof that uploads can run.
  // The uploader deliberately stops when credentials or the authoritative
  // exclusion policy are unavailable, so only call the scope remote after all
  // of those guards are known-good.
  const {
    uploadOperational: remoteUploadOperational,
    remoteCopiesRemain,
    scopeUnverified: remoteScopeUnverified,
    toggleBlocked: remoteToggleBlocked,
  } = whatISaidRemoteUiState(remoteStatus);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[var(--surface)] text-[13px] text-[var(--ink)]"
      aria-labelledby={`${idPrefix}-title`}
      data-testid="what-i-said-panel"
    >
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-[var(--line)] px-6 py-2">
        <h1 id={`${idPrefix}-title`} className="m-0 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">{t.title}</h1>
        <span className="min-w-0 text-xs text-[var(--ink-3)]">{t.intro}</span>
        {/* ⚠️ 적재가 켜지면 "이 기기에서만"은 더 이상 참이 아니다. 배지가 실제
            상태를 따라가지 않으면 앱이 사용자에게 거짓말을 하게 된다. */}
        <span
          className={`${STATUS_PILL_CLASS} ml-auto ${
            remoteScopeUnverified
              ? 'bg-[var(--warn-soft)] text-[var(--warn)]'
              : remoteUploadOperational || remoteCopiesRemain
              ? 'bg-[var(--info-soft)] text-[var(--info)]'
              : 'bg-[var(--ok-soft)] text-[var(--ok)]'
          }`}
          data-testid="what-i-said-storage-scope"
        >
          {remoteScopeUnverified
            ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            : remoteUploadOperational || remoteCopiesRemain
            ? <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
            : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
          {remoteScopeUnverified
            ? t.remoteScopeUnknown
            : remoteUploadOperational
            ? t.remoteOn
            : remoteCopiesRemain
            ? t.remoteCopiesRemain(remoteStatus?.storedRows ?? 0)
            : t.localOnly}
        </span>
      </header>

      <div
        className={notice
          ? `mx-6 mt-4 shrink-0 ${BANNER_BASE_CLASS} font-semibold ${notice.kind === 'error' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--ok-soft)] text-[var(--ok)]'}`
          : 'sr-only'}
        role={notice?.kind === 'error' ? 'alert' : 'status'}
        aria-live={notice?.kind === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {notice?.message ?? ''}
      </div>

      {/* 외부 앱 연결은 이제 원격 적재 카드 안의 장기기억 단위 키 하나뿐이라
          사이드바가 필요 없다. 왼쪽은 설정 열(--bg), 오른쪽은 프롬프트 라이브러리. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,360px)_1fr] lg:overflow-hidden">
        <div className="flex flex-col gap-[18px] border-b border-[var(--line)] bg-[var(--bg)] p-6 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <p className={CAPTION_CLASS} data-testid="what-i-said-same-user-trust">
            {t.sameUserTrust}
          </p>

          <section className="flex flex-col gap-3.5" aria-labelledby={`${idPrefix}-capture-title`} data-testid="what-i-said-global-policy-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`${idPrefix}-capture-title`} className={SECTION_TITLE_CLASS}>{t.captureTitle}</h2>
              <div className="flex items-center gap-2">
                {globalStatus && (
                  <span className={`${BADGE_CLASS} ${globalStatus.enabled ? 'bg-[var(--ok-soft)] text-[var(--ok)]' : 'bg-[var(--sunken)] text-[var(--ink-2)]'}`}>
                    {globalStatus.enabled ? t.enabled : t.disabled}
                  </span>
                )}
                {globalState === 'error' && (
                  <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void loadGlobalStatus()}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {t.retry}
                  </button>
                )}
              </div>
            </div>

            {globalState === 'loading' && (
              <div className={LOADING_CLASS} role="status" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t.statusLoading}
              </div>
            )}
            {globalState === 'error' && (
              <div className={BANNER_DANGER_CLASS} role="alert">
                <p className="font-bold text-[var(--danger)]">{t.statusError}</p>
                <p className="mt-1 break-words">{globalError}</p>
              </div>
            )}
            {globalState === 'ready' && globalStatus && (
              <div className="flex flex-col gap-3.5">
                <div data-testid="what-i-said-global-scope">
                  <span className="block text-xs font-semibold text-[var(--ink)]">
                    {globalStatus.configured ? t.globalConfigured : t.globalNotConfigured}
                  </span>
                  <span className={`mt-1 block ${HELP_CLASS}`}>{t.globalScopeHelp}</span>
                </div>
                {/* 「내가 한 말」은 기기 로컬 저장소이고, 저장되는 프롬프트마다 수집한 기기가
                    함께 박힌다. 그 사실이 화면에 없으면 "단말 정보가 기록되는지"를 확인할
                    길이 저장소 파일을 직접 여는 것뿐이었다 (VOC 2026-09-01 08:10).
                    ⚠️ 상태를 못 읽었을 때(remoteStatus === null)는 아예 그리지 않는다 —
                    「이름 없음」과 「아직 모름」을 같은 문구로 칠하면 멀쩡한 기기가
                    설정 안 된 것으로 읽힌다. */}
                {remoteStatus && (
                  <div className="rounded-xl border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/15 p-3" data-testid="what-i-said-device-scope">
                    <span className="flex items-center gap-2 text-xs font-bold text-[var(--ink)]">
                      <Laptop className="h-3.5 w-3.5 shrink-0 text-[var(--ink-2)]" aria-hidden="true" />
                      {t.deviceScopeTitle} · {remoteStatus.deviceName ?? remoteStatus.deviceId ?? t.deviceUnknown}
                    </span>
                    <span className={`mt-1 block ${CAPTION_CLASS}`}>
                      {remoteStatus.deviceName || remoteStatus.deviceId ? t.deviceScopeHelp : t.deviceMissingHelp}
                    </span>
                  </div>
                )}
                <div data-testid="what-i-said-global-capture-explanation">
                  <span className="block text-xs font-semibold text-[var(--ink)]">{t.captureEnabled}</span>
                  <span id={`${idPrefix}-capture-help`} className={`mt-1 block ${HELP_CLASS}`}>{t.captureEnabledHelp}</span>
                </div>

                <label className="flex flex-col gap-1.5" htmlFor={`${idPrefix}-retention`}>
                  <span className={LABEL_CLASS}>{t.retention}</span>
                  <select
                    id={`${idPrefix}-retention`}
                    className={SELECT_CLASS}
                    value={retentionDraft}
                    onChange={event => {
                      const value = event.target.value;
                      setRetentionDraft(value === 'forever' ? 'forever' : Number(value) as 30 | 90 | 365);
                    }}
                    disabled={!!captureBusy}
                  >
                    <option value={30}>{t.days30}</option>
                    <option value={90}>{t.days90}</option>
                    <option value={365}>{t.days365}</option>
                    <option value="forever">{t.forever}</option>
                  </select>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-[1.55] text-[var(--ink-2)]">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    checked={analysisDraft}
                    onChange={event => setAnalysisDraft(event.target.checked)}
                    disabled={!!captureBusy}
                    aria-describedby={`${idPrefix}-analysis-help`}
                  />
                  <span>
                    <span className="block font-bold text-[var(--ink)]">{t.analysisAllowed}</span>
                    <span id={`${idPrefix}-analysis-help`} className="mt-0.5 block">{t.analysisHelp}</span>
                  </span>
                </label>

                <div className="flex flex-col gap-2" data-testid="what-i-said-global-actions">
                  <button type="button" className={CTA_BUTTON_CLASS} onClick={() => void saveCaptureSettings(true)} disabled={!!captureBusy}>
                    {captureBusy === 'configure' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                    {captureBusy === 'configure' ? t.saving : globalStatus.enabled ? t.applyAll : t.startAll}
                  </button>
                  {globalStatus.enabled && (
                    <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void saveCaptureSettings(false)} disabled={!!captureBusy}>
                      {t.stopAll}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <div className={DIVIDER_CLASS} aria-hidden="true" />

          <section className="flex flex-col gap-3.5" aria-labelledby={`${idPrefix}-bulk-sync-title`} data-testid="what-i-said-memory-bulk-card">
            <div>
              <h2 id={`${idPrefix}-bulk-sync-title`} className={SECTION_TITLE_CLASS}>{t.bulkSyncTitle}</h2>
              <p className={`mt-1.5 ${HELP_CLASS}`}>{t.bulkSyncHelp}</p>
            </div>
            {syncableMemories.length ? (
              <>
                <fieldset className={INSET_CARD_CLASS} data-testid="what-i-said-memory-sync-selection">
                  <legend className="px-1 text-[11.5px] font-semibold text-[var(--ink-2)]">{t.selectMemories}</legend>
                  <span className={CAPTION_CLASS} aria-live="polite">{t.selectedCount(selectedMemoryIds.length)}</span>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={CHIP_BUTTON_CLASS}
                      disabled={!!captureBusy}
                      onClick={() => setSelectedMemoryIds(syncableMemories.map(memory => memory.memoryId))}
                    >
                      {t.selectAll}
                    </button>
                    <button
                      type="button"
                      className={CHIP_BUTTON_CLASS}
                      disabled={!!captureBusy || selectedMemoryIds.length === 0}
                      onClick={() => setSelectedMemoryIds([])}
                    >
                      {t.clearSelection}
                    </button>
                  </div>
                  <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
                    {syncableMemories.map(memory => (
                      <li key={memory.memoryId}>
                        <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-[var(--raised)] max-sm:min-h-11">
                          <input
                            type="checkbox"
                            className={CHECKBOX_CLASS}
                            checked={selectedMemoryIds.includes(memory.memoryId)}
                            disabled={!!captureBusy}
                            onChange={event => setSelectedMemoryIds(current => (
                              event.target.checked
                                ? [...new Set([...current, memory.memoryId])]
                                : current.filter(memoryId => memoryId !== memory.memoryId)
                            ))}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink)]">{memory.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className={`mt-2 ${CAPTION_CLASS}`}>{t.syncSelectedHelp}</p>
                </fieldset>
                {/* The explanation belongs BEFORE the button. Read after,
                    an enabled 「지금 수집」 under an active 전체 저장 looks like
                    a contradiction; read first, it names the one thing the
                    global policy does not do — import right now. */}
                <p className={CAPTION_CLASS} data-testid="what-i-said-capture-now-help">{t.captureNowHelp}</p>
                {/* 두 버튼이 갈리는 축은 「얼마나 거슬러 올라가는가」 하나뿐인데, 예전
                    라벨(「지금 가져오기」 / 「지금까지의 기록 가져오기」)은 그 축을
                    말하지 않아 거의 같은 말로 읽혔다 (VOC 2026-09-01 15:38). 범위를
                    버튼 **바로 밑**에 한 줄로 붙인다 — 설명이 title 툴팁에만 있으면
                    마우스를 올려 보기 전까지는 없는 것과 같다. */}
                <div className="flex flex-col gap-2" data-testid="what-i-said-project-actions">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className={INSET_CARD_CLASS}>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON_CLASS} w-full`}
                        onClick={() => void captureNow()}
                        disabled={!!captureBusy || !globalStatus?.enabled || selectedMemoryIds.length === 0}
                        title={!globalStatus?.enabled ? t.captureDisabledHint : undefined}
                      >
                        {captureBusy === 'capture' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Database className="h-4 w-4" aria-hidden="true" />}
                        {captureBusy === 'capture' ? t.capturing : t.syncSelectedCount(selectedMemoryIds.length)}
                      </button>
                      <p className={`mt-2 ${CAPTION_CLASS}`} data-testid="what-i-said-capture-now-scope">{t.captureNowScope}</p>
                    </div>
                    <div className={INSET_CARD_CLASS}>
                      <button
                        type="button"
                        className={`${SECONDARY_BUTTON_CLASS} w-full`}
                        data-testid="what-i-said-backfill"
                        onClick={() => void captureNow(true)}
                        disabled={!!captureBusy || !globalStatus?.enabled || selectedMemoryIds.length === 0}
                        title={!globalStatus?.enabled ? t.captureDisabledHint : undefined}
                      >
                        {captureBusy === 'backfill' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCw className="h-4 w-4" aria-hidden="true" />}
                        {captureBusy === 'backfill' ? t.capturing : t.backfill}
                      </button>
                      <p className={`mt-2 ${CAPTION_CLASS}`} data-testid="what-i-said-backfill-scope">{t.backfillHelp}</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className={BANNER_WARN_CLASS} role="status">{remoteStatusUnavailable ? t.memoryListError : !remoteStatus ? t.memoryListLoading : t.noProject}</p>
            )}
          </section>

          <div className={DIVIDER_CLASS} aria-hidden="true" />

          <section className="flex flex-col gap-3.5" aria-labelledby={`${idPrefix}-project-status-title`} data-testid="what-i-said-project-status-card">
            <div>
              <h2 id={`${idPrefix}-project-status-title`} className={SECTION_TITLE_CLASS}>{t.projectStatusTitle}</h2>
              <p className={`mt-1.5 ${HELP_CLASS}`}>{t.projectStatusHelp}</p>
            </div>

            {!availableScopes.length ? (
              <p className={BANNER_WARN_CLASS} role="status">
                {t.noProject}
              </p>
            ) : (
              <div className="flex flex-col gap-3.5">
                <label className="flex flex-col gap-1.5" htmlFor={`${idPrefix}-capture-project`}>
                  <span className={LABEL_CLASS}>{t.captureProject}</span>
                  <select
                    id={`${idPrefix}-capture-project`}
                    className={SELECT_CLASS}
                    value={captureProjectId}
                    onChange={event => setCaptureProjectId(event.target.value)}
                    disabled={!!captureBusy}
                  >
                    {availableScopes.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>

                {captureState === 'loading' && (
                  <div className={LOADING_CLASS} role="status" aria-live="polite">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t.statusLoading}
                  </div>
                )}
                {captureState === 'error' && (
                  <div className={BANNER_DANGER_CLASS} role="alert">
                    <p className="font-bold text-[var(--danger)]">{t.statusError}</p>
                    <p className="mt-1 break-words">{captureError}</p>
                  </div>
                )}
                {captureState === 'ready' && captureStatus && (
                  <>
                    <span className={`${BADGE_CLASS} self-start ${captureStatus.enabled ? 'bg-[var(--ok-soft)] text-[var(--ok)]' : 'bg-[var(--sunken)] text-[var(--ink-2)]'}`}>
                      {captureStatus.enabled ? t.projectEnabled : t.projectDisabled}
                    </span>
                    {captureStatus.cryptoState === 'unavailable' && (
                      <div className={`${BANNER_WARN_CLASS} flex items-start gap-2`} role="alert">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
                        <p>{t.cryptoUnavailable}</p>
                      </div>
                    )}
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <div className={INSET_CARD_CLASS}>
                        <dt className={CAPTION_CLASS}>{t.lastCapture}</dt>
                        <dd className="mt-1 font-mono text-xs text-[var(--ink)]">{formatDateTime(captureStatus.lastCaptureAt, language) ?? t.never}</dd>
                      </div>
                      <div className={INSET_CARD_CLASS}>
                        <dt className={CAPTION_CLASS}>{t.savedCount}</dt>
                        <dd className="mt-1 font-mono text-xs text-[var(--ink)]">{captureStatus.count ?? '—'}</dd>
                      </div>
                    </dl>

                    <button type="button" className={`${DANGER_BUTTON_CLASS} self-start`} onClick={() => void deleteProjectPrompts()} disabled={!!captureBusy}>
                      {captureBusy === 'delete-project' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                      {t.deleteProject}
                    </button>
                  </>
                )}
              </div>
            )}
          </section>

          <div className={DIVIDER_CLASS} aria-hidden="true" />

          <section className="flex flex-col gap-3" aria-labelledby={`${idPrefix}-remote-title`} data-testid="what-i-said-remote-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`${idPrefix}-remote-title`} className={SECTION_TITLE_CLASS}>{t.remoteTitle}</h2>
              <span className={`${BADGE_CLASS} ${
                remoteScopeUnverified
                  ? 'bg-[var(--sunken)] text-[var(--ink-2)]'
                  : remoteUploadOperational
                  ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
                  : remoteCopiesRemain
                  ? 'bg-[var(--warn-soft)] text-[var(--warn)]'
                  : 'bg-[var(--sunken)] text-[var(--ink-2)]'
              }`}>
                {remoteScopeUnverified
                  ? t.remoteUnknown
                  : remoteUploadOperational
                  ? t.remoteEnabled
                  : remoteCopiesRemain
                  ? t.remoteRetained
                  : t.remoteDisabled}
              </span>
            </div>
            <p className={HELP_CLASS}>{t.remoteIntro}</p>
            <p className={HELP_CLASS}>{t.remoteRedaction}</p>

            <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-[1.55] text-[var(--ink)]">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                data-testid="what-i-said-remote-toggle"
                checked={remoteStatus?.enabled === true}
                disabled={remoteBusy !== null || remoteToggleBlocked}
                onChange={event => void toggleRemote(event.target.checked)}
              />
              <span className="font-semibold">{t.remoteEnable}</span>
            </label>

            {remoteStatus && !remoteStatus.credentialsReady && (
              <p className={BANNER_WARN_CLASS} role="status">
                {t.remoteNoCredentials}
              </p>
            )}
            {remoteStatus?.remoteError && (
              <p className={`${BANNER_DANGER_CLASS} break-words`} role="alert">
                {remoteStatus.remoteError}
              </p>
            )}
            {remoteStatusUnavailable && (
              <p className={BANNER_DANGER_CLASS} role="alert">
                {t.remoteScopeUnknown}
              </p>
            )}
            {typeof remoteStatus?.storedRows === 'number' && (
              <p className={CAPTION_CLASS} data-testid="what-i-said-remote-count">
                {t.remoteStored(remoteStatus.storedRows)}
              </p>
            )}

            <div className={`${INSET_CARD_CLASS} flex flex-col gap-2.5`} data-testid="what-i-said-remote-key">
              <div>
                <h3 className="text-xs font-bold text-[var(--ink)]">{t.remoteKeyTitle}</h3>
                <p className={`mt-1 ${CAPTION_CLASS}`}>{t.remoteKeyIntro}</p>
              </div>

              {remoteKey?.endpoint && (
                <div>
                  <p className={LABEL_CLASS}>{t.remoteKeyEndpoint}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <code className={CODE_FIELD_CLASS}>{remoteKey.endpoint}</code>
                  </div>
                  <div className="mt-1.5">
                    <ClipboardCopyButton value={remoteKey.endpoint} label={t.copyAddress}
                      copiedLabel={t.copied} copyingLabel={t.copying} successMessage={t.addressCopied}
                      errorMessage={t.copyFailed} className={SECONDARY_BUTTON_CLASS}
                      testId="what-i-said-copy-address" />
                  </div>
                  <p className={`mt-1.5 ${CAPTION_CLASS}`}>{t.remoteKeyHowTo}</p>
                </div>
              )}

              {!remoteKey?.keys.length && <p className={CAPTION_CLASS}>{t.remoteKeyNone}</p>}

              {!!remoteKey?.keys.length && (
                <ul className="space-y-2" data-testid="what-i-said-remote-key-list">
                  {remoteKey.keys.map(key => (
                    <li key={key.id} className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold text-[var(--ink)]">{key.label}</span>
                        <span className={CAPTION_CLASS}>
                          {key.allowedMemoryIds?.length
                            ? t.remoteKeyScopeNarrow(key.allowedMemoryIds.length)
                            : t.remoteKeyScopeAll}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <code className={CODE_FIELD_CLASS} data-testid="what-i-said-remote-key-value">
                          {revealedKeyId === key.id ? (key.token ?? '') : '•'.repeat(48)}
                        </code>
                        <button type="button" className={ICON_BUTTON_CLASS}
                          aria-label={revealedKeyId === key.id ? t.remoteKeyHide : t.remoteKeyReveal}
                          title={revealedKeyId === key.id ? t.remoteKeyHide : t.remoteKeyReveal}
                          onClick={() => setRevealedKeyId(current => (current === key.id ? null : key.id))}>
                          {revealedKeyId === key.id ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                      </div>
                      <div className="mt-1.5">
                        <ClipboardCopyButton value={key.token ?? ''} label={t.copyKey}
                          copiedLabel={t.copied} copyingLabel={t.copying} successMessage={t.keyCopied}
                          errorMessage={t.copyFailed} className={SECONDARY_BUTTON_CLASS}
                          testId="what-i-said-copy-key" />
                      </div>
                      <p className={`mt-2 ${CAPTION_CLASS}`}>
                        {key.lastUsedAt
                          ? t.remoteKeyUsage(formatDateTime(key.lastUsedAt, language) ?? key.lastUsedAt)
                          : t.remoteKeyNeverUsed}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={remoteBusy !== null}
                          onClick={() => void issueRemoteKey({ keyId: key.id })}>
                          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> {t.remoteKeyRotate}
                        </button>
                        <button type="button" className={DANGER_BUTTON_CLASS} disabled={remoteBusy !== null}
                          onClick={() => void revokeRemoteKey(key.id)}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t.remoteKeyRevoke}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <label className="min-w-0 flex-1" htmlFor={`${idPrefix}-remote-key-label`}>
                  <span className="sr-only">{t.remoteKeyLabel}</span>
                  <input
                    id={`${idPrefix}-remote-key-label`}
                    className={INPUT_CLASS}
                    data-testid="what-i-said-remote-key-label"
                    value={newKeyLabel}
                    maxLength={120}
                    placeholder={t.remoteKeyLabelPlaceholder}
                    onChange={event => setNewKeyLabel(event.target.value)}
                  />
                </label>
                <button type="button" className={`${SECONDARY_BUTTON_CLASS} h-[34px] bg-[var(--surface)] font-bold text-[var(--ink)]`} data-testid="what-i-said-remote-key-issue"
                  disabled={remoteBusy !== null || !newKeyLabel.trim()}
                  onClick={() => void issueRemoteKey({ label: newKeyLabel.trim() })}>
                  {remoteBusy === 'new-key' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t.remoteKeyIssue}
                </button>
              </div>
              {remoteKey?.error && (
                <p className="break-words text-[11px] text-[var(--danger)]" role="alert">{remoteKey.error}</p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-bold text-[var(--ink)]">{t.remoteExcludeTitle}</h3>
              <p className={`mt-1 ${CAPTION_CLASS}`}>{t.remoteExcludeHelp}</p>
              {remoteStatusUnavailable && remoteStatusError && <p role="alert" className="break-words text-xs text-[var(--danger)]" data-testid="what-i-said-remote-status-error">{remoteStatusError}</p>}
              {remoteStatus && remoteStatus.projects.length === 0 && (
                <p className={`mt-2 ${CAPTION_CLASS}`}>{t.remoteNoProjects}</p>
              )}
              {!!remoteStatus?.projects.length && (
                <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto" data-testid="what-i-said-remote-exclusions">
                  {remoteStatus.projects.map(project => (
                    <li key={project.memoryId}>
                      <label className="flex min-h-9 items-center justify-between gap-2.5 rounded-md px-2 hover:bg-[var(--raised)] max-sm:min-h-11">
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink)]">{project.name}</span>
                        <span className={`shrink-0 text-[11px] ${project.excluded === true ? 'text-[var(--warn)]' : 'text-[var(--ink-3)]'}`}>
                          {project.excluded === null
                            ? t.remoteExclusionUnknown
                            : project.excluded ? t.remoteExcluded : t.remoteIncluded}
                        </span>
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                          checked={project.excluded === true}
                          disabled={remoteBusy !== null || project.excluded === null || !remoteStatus.exclusionsReady}
                          aria-label={`${project.name} · ${t.remoteExcludeTitle}`}
                          onChange={event => void toggleRemoteExclusion(project.memoryId, event.target.checked)}
                        />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-3.5 p-6 lg:min-h-0 lg:overflow-y-auto">
          <section className="flex flex-col gap-3.5" aria-labelledby={`${idPrefix}-library-title`}>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h2 id={`${idPrefix}-library-title`} className={`${SECTION_TITLE_CLASS} inline-flex flex-wrap items-center gap-2`}>
                {t.libraryTitle}
                {/* An empty library is ambiguous without this: nothing captured
                    yet reads exactly like a broken feature.
                    ⚠️ The count tracks `captureProjectId` (the 상태·수동 작업 card's
                    selector) while the list tracks `projectFilterId`. Showing it
                    whenever the filter is not 'all' let the two drift, so the
                    number could describe a different project than the prompts
                    underneath it. Only show it when they are the same project. */}
                {typeof captureStatus?.count === 'number'
                  && projectFilterId !== 'all'
                  && projectFilterId === captureProjectId && (
                  <span className="font-mono text-xs font-medium text-[var(--ink-3)]" data-testid="what-i-said-stored-count">
                    {t.storedCountLabel(captureStatus.count)}
                  </span>
                )}
                {/* 저장 건수 옆에 신선도를 함께 둔다. 「몇 건 있다」만으로는 그것이
                    오늘의 기록인지 지난달 기록인지 알 수 없고, 다른 기기가 올린 최신
                    프롬프트가 섞여 보이면 이 기기가 멎은 사실이 완전히 가려진다.
                    'unknown' 은 아무 주장도 하지 않는 값이므로 그리지 않는다 —
                    필드를 모르는 옛 sidecar 를 「수집한 적 없음」으로 칠하지 않기 위해서다. */}
                {captureFreshness.state !== 'unknown' && (
                  <span
                    className={captureNeedsAttention
                      ? `${BADGE_CLASS} bg-[var(--warn-soft)] text-[var(--warn)]`
                      : 'inline-flex items-center font-mono text-xs font-medium text-[var(--ink-3)]'}
                    data-testid="what-i-said-last-capture"
                    data-capture-state={captureFreshness.state}
                  >
                    {captureFreshnessLabel}
                  </span>
                )}
              </h2>
              <span className="min-w-0 text-[11.5px] text-[var(--ink-3)]" data-testid="what-i-said-library-help">{t.libraryHelp}</span>
              <button type="button" className={`${SECONDARY_BUTTON_CLASS} ml-auto h-[30px]`} onClick={() => void loadPrompts(false)} disabled={listState.loading || listState.loadingMore}>
                <RefreshCw className={`h-3.5 w-3.5 ${listState.loading ? 'animate-spin' : ''}`} aria-hidden="true" /> {t.refresh}
              </button>
            </div>
            {/* 오래된 이유를 말하지 않으면 사용자는 그것을 고장으로 읽는다. 규칙을
                아는 사람은 같은 화면을 「내가 아직 저장을 안 했다」로 읽는다.
                라벨을 문자열로 베껴 적지 않고 실제 버튼 라벨을 그대로 넘긴다 —
                버튼 이름이 바뀌면 화면에 없는 버튼을 가리키게 되기 때문이다.
                버튼을 하나 더 두지 않는다: 수집 버튼은 위 카드에 이미 있다. */}
            {captureNeedsAttention && (
              <p
                className={BANNER_WARN_CLASS}
                data-testid="what-i-said-capture-stale-note"
              >
                {t.staleCaptureNote(t.syncSelected)}
              </p>
            )}

            <form
              className="flex flex-wrap gap-1.5"
              role="search"
              onSubmit={event => {
                event.preventDefault();
                setQuery(queryDraft.trim());
              }}
            >
              <label className="relative flex min-w-0 flex-[1_1_220px] items-center" htmlFor={`${idPrefix}-search`}>
                <span className="sr-only">{t.searchLabel}</span>
                <Search className="pointer-events-none absolute left-2.5 h-[13px] w-[13px] text-[var(--ink-3)]" aria-hidden="true" />
                <input
                  id={`${idPrefix}-search`}
                  className={`${FILTER_INPUT_CLASS} pl-8`}
                  type="search"
                  value={queryDraft}
                  onChange={event => setQueryDraft(event.target.value)}
                  placeholder={t.searchPlaceholder}
                />
              </label>
              <label className="min-w-0 max-w-full flex-[0_1_auto]" htmlFor={`${idPrefix}-project-filter`}>
                <span className="sr-only">{t.projectFilter}</span>
                <select id={`${idPrefix}-project-filter`} className={FILTER_SELECT_CLASS} value={projectFilterId} onChange={event => setProjectFilterId(event.target.value)}>
                  <option value="all">{t.allProjects}</option>
                  {libraryScopes.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label className="min-w-0 max-w-full flex-[0_1_auto]" htmlFor={`${idPrefix}-agent-filter`}>
                <span className="sr-only">{t.agentFilter}</span>
                <select id={`${idPrefix}-agent-filter`} className={FILTER_SELECT_CLASS} value={agentFilter} onChange={event => setAgentFilter(event.target.value as 'all' | WhatISaidAgent)}>
                  <option value="all">{t.allAgents}</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label className="min-w-0 max-w-full flex-[0_1_auto]" htmlFor={`${idPrefix}-origin-filter`}>
                <span className="sr-only">{t.originFilter}</span>
                <select id={`${idPrefix}-origin-filter`} className={FILTER_SELECT_CLASS} value={originFilter} onChange={event => setOriginFilter(event.target.value as 'all' | WhatISaidPromptOrigin)}>
                  <option value="all">{t.allOrigins}</option>
                  <option value="human">{t.humanOrigin}</option>
                  <option value="agentstoz">{t.agentstozOrigin}</option>
                  <option value="unknown">{t.unknownOrigin}</option>
                </select>
              </label>
              <button type="submit" className={`${PRIMARY_BUTTON_CLASS} h-[34px]`}>{t.search}</button>
            </form>

            {scanHasWarning && scan && (
              <div className={`${BANNER_WARN_CLASS} flex items-start gap-2`} role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
                {t.partialScan(scan.unreadable, scan.withheld)}
              </div>
            )}

            <div className="flex flex-col gap-2" aria-busy={listState.loading || listState.loadingMore}>
              {listState.loading && (
                <div className={`${LOADING_CLASS} min-h-40`} role="status" aria-live="polite">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t.loading}
                </div>
              )}
              {!listState.loading && !!listState.error && (
                <div className={`${BANNER_DANGER_CLASS} px-4 py-5`} role="alert">
                  <p className="font-bold text-[var(--danger)]">{t.loadError}</p>
                  <p className="mt-1 break-words">{listState.error}</p>
                  <button type="button" className={`${SECONDARY_BUTTON_CLASS} mt-3`} onClick={() => void loadPrompts(false)}>{t.retry}</button>
                </div>
              )}
              {!listState.loading && !listState.error && listState.loaded && listState.items.length === 0 && (
                <div className={EMPTY_STATE_CLASS} role="status">
                  {/* Three distinct states, not two. A project that has simply
                      not been captured yet is the common case right after
                      turning 전체 저장 on, and calling it "no prompts captured"
                      reads as a malfunction. */}
                  <p className="text-[13px] font-bold text-[var(--ink)]">
                    {filtersActive ? t.noResultsTitle : notCapturedYet ? t.notCapturedYetTitle : t.emptyTitle}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-[var(--ink-2)]">
                    {filtersActive ? t.noResultsBody : notCapturedYet ? t.notCapturedYetBody : t.emptyBody}
                  </p>
                  {filtersActive && (
                    <button
                      type="button"
                      className={`${SECONDARY_BUTTON_CLASS} mt-4`}
                      onClick={() => {
                        setQueryDraft('');
                        setQuery('');
                        setProjectFilterId(defaultProjectFilterId);
                        setAgentFilter('all');
                        setOriginFilter('all');
                      }}
                    >
                      {t.clearFilters}
                    </button>
                  )}
                </div>
              )}
              {!listState.loading && !listState.error && listState.items.length > 0 && (
                <ol className="space-y-3" aria-label={t.libraryTitle}>
                  {listState.items.map(item => {
                    const formattedTime = formatDateTime(item.recordedAt, language);
                    const projectLabel = item.projectName ?? (item.projectId ? projectNameById.get(item.projectId) : null) ?? t.unknownProject;
                    return (
                      <li key={item.id}>
                        <article className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--bg)] px-3.5 py-3">
                          <header className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className={`${CHIP_CLASS} font-bold ${item.agent === 'claude' ? 'bg-[var(--violet-soft)] text-[var(--violet)]' : 'bg-[var(--ok-soft)] text-[var(--ok)]'}`}>{item.agent === 'claude' ? 'Claude' : 'Codex'}</span>
                            <span
                              className={`${CHIP_CLASS} font-semibold ${item.promptOrigin === 'agentstoz'
                                ? 'bg-[var(--info-soft)] text-[var(--info)]'
                                : item.promptOrigin === 'human'
                                  ? 'bg-[var(--sunken)] text-[var(--ink-2)]'
                                  : 'bg-[var(--sunken)] text-[var(--ink-3)]'}`}
                              data-testid="what-i-said-prompt-origin"
                            >
                              {item.promptOrigin === 'agentstoz'
                                ? t.agentstozOrigin
                                : item.promptOrigin === 'human'
                                  ? t.humanOrigin
                                  : t.unknownOrigin}
                            </span>
                            <span className="font-semibold text-[var(--ink-2)]">{projectLabel}</span>
                            <time dateTime={formattedTime ? item.recordedAt : undefined} className="font-mono text-[var(--ink-3)]">{formattedTime ?? t.never}</time>
                            {/* 기록 이전 행은 null 이고, 그때는 아무 주장도 하지 않는다. */}
                            {(item.deviceName ?? item.deviceId) && (
                              <span className="inline-flex items-center gap-1 text-[var(--ink-3)]" data-testid="what-i-said-prompt-device">
                                <Laptop className="h-3 w-3" aria-hidden="true" />
                                {item.deviceName ?? item.deviceId}
                              </span>
                            )}
                            <span className="ml-auto flex items-center gap-0.5">
                              <button
                                type="button"
                                className={PROMPT_ACTION_CLASS}
                                aria-label={t.copyPrompt}
                                title={t.copyPrompt}
                                onClick={() => void copyValue(item.text, t.promptCopied)}
                              >
                                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                              {item.storage !== 'supabase' && (
                                <button
                                  type="button"
                                  className={`${PROMPT_ACTION_CLASS} hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]`}
                                  aria-label={t.deletePrompt}
                                  title={t.deletePrompt}
                                  disabled={deletingPromptId === item.id}
                                  onClick={() => void deletePrompt(item.id)}
                                >
                                  {deletingPromptId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                </button>
                              )}
                            </span>
                          </header>
                          <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-[var(--ink)]">{item.text}</p>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}
              {!listState.loading && !listState.error && listState.hasMore && listState.nextBeforeSeq !== null && (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    className={SECONDARY_BUTTON_CLASS}
                    disabled={listState.loadingMore}
                    onClick={() => void loadPrompts(true, listState.nextBeforeSeq ?? undefined)}
                  >
                    {listState.loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    {listState.loadingMore ? t.loadingMore : t.loadMore}
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

export default WhatISaidPanel;
