import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Server, Trash2, Plus, ExternalLink, Terminal, ArrowUpDown, Pencil, Check, X as XIcon, Play, Square, Rocket, FolderOpen, Upload, Download, Folder, FilePlus, Package, RefreshCw, FileText, RotateCw, Globe, Github, SquareTerminal, Info, Monitor, BookMarked, Brain, Cloud, CloudUpload, CloudDownload, Search, Sparkles, Settings, GitPullRequest, Copy, GitBranch, GitCommit, Star, Pin, BookOpen, ChevronDown, ChevronUp, StickyNote, Clock, Zap, History, Laptop, Keyboard, LayoutList, LayoutGrid, MoreHorizontal, Lock, Gauge, Mic, SlidersHorizontal, MessageSquarePlus, Archive } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getSupabaseClient, describeSupabaseError } from './lib/supabaseClient';
import { signInBrowserSupabase } from './nativeSupabaseAuth';
import type { PortalActions } from './PortalManager';
import BulkUpgradeButton from './components/BulkUpgradeButton';
// 코드 스플리팅: 초기 포트 관리 화면과 무관한 panel은 열릴 때만 로드한다.
const SetupWizard = lazy(() => import('./SetupWizard'));
const PortalManager = lazy(() => import('./PortalManager'));
const PortalMemoryDirectory = lazy(() => import('./PortalMemoryDirectory'));
const AiUsagePanel = lazy(() => import('./components/AiUsagePanel').then(({ AiUsagePanel }) => ({ default: AiUsagePanel })));
const GuideOverlay = lazy(() => import('./guide/GuideMode').then(({ GuideOverlay }) => ({ default: GuideOverlay })));
// 가이드 모드와 같은 이유로 lazy — 끄고 있으면 청크를 내려받지도 않는다.
const VocOverlay = lazy(() => import('./voc/VocOverlay').then(({ VocOverlay }) => ({ default: VocOverlay })));
const MemoryArchivePanel = lazy(() => import('./memory/MemoryArchivePanel').then(({ MemoryArchivePanel }) => ({ default: MemoryArchivePanel })));
const ProjectMemoryPanel = lazy(() => import('./ProjectMemoryPanel').then(({ ProjectMemoryPanel }) => ({ default: ProjectMemoryPanel })));
const BuzzProjectDialog = lazy(() => import('./BuzzProjectDialog').then(({ BuzzProjectDialog }) => ({ default: BuzzProjectDialog })));
const BuzzAgentSetupDialog = lazy(() => import('./BuzzAgentSetupDialog').then(({ BuzzAgentSetupDialog }) => ({ default: BuzzAgentSetupDialog })));
import { savePushSnapshot, fetchPushHistory, fetchSnapshotRows, type PushSnapshot } from './pushHistory';
import { isTauri, isDeployedWeb } from './lib/env';
import { gitCloneUrlProblem, parseGitCloneRequest } from './gitCloneRequest';
import { isUnknownApiEndpoint, unknownApiEndpointMessage } from './apiEndpointSupport';
import { hermesCliAvailabilityFromStatus } from './hermesCliPresence';
import { TitleTipHost } from './components/TitleTipHost';
import { BuildInfoBadge } from './components/BuildInfoBadge';
import { type Lang, t } from './i18n';
import { type ProjectMemoryAgent } from './ProjectMemoryPanel';
import { FolderDropZone } from './FolderDropZone';
import {
  groupProjectsByWorkspaceRoot,
  mergeWorkspaceRootsPreservingLocalOrder,
  reorderWorkspaceRoots,
} from './workspace-roots';
import {
  getProjectSectionCounts,
  shouldShowWorktreeSection,
} from '../project-section-counts';
import {
  defaultFirstTaskBranchName,
  repositoryWorkflowApi,
  type RepositoryWorkflowStatus,
} from './repositoryWorkflow';
import { formatOperationDiagnostic } from './diagnosticLog';
import { resolveAgentLaunchContext, type AgentLaunchContext } from './worktreeLaunch';
import { classifyWorktreeSource } from './worktreeSource';
import { formatAbsoluteTimestamp } from './formatTimestamp';
import {
  TERMINAL_DEFAULTS_VERSION,
  isClaudeBgAvailable,
  terminalOptionDefaults,
  tmuxReach,
  type TerminalApp,
} from './terminalDefaults';
import {
  classifyOrcaWorktreeVisibility,
  formatOrcaWorktreeActionNotice,
  hasHiddenOrcaPathSegment,
  orcaSurfaceFromLaunchMessage,
  type OrcaWorktreeAction,
} from './orcaWorktreeSupport';
import { shouldUseOrcaFloatingTerminal, type OrcaLaunchMode } from './orcaFloatingTerminal';
import { describeAgentLaunchPolicy } from './agentLaunchPolicy';
import {
  UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STORAGE_KEY,
  applyZoomToDocument, clearDocumentZoom, formatZoom, parseStoredZoom, zoomIn, zoomOut,
} from './uiZoom';
import { PROJECT_DOCUMENT_EXTENSIONS, projectDocumentPathProblem } from './projectDocumentPath';
import { tmuxSessionName } from './tmuxSessionName';
import { BUILD_INFO } from './buildInfo';
import {
  ALL_LAUNCH_AGENTS,
  describeVisibleLaunchAgents,
  HIDDEN_LAUNCH_AGENTS_STORAGE_KEY,
  LAUNCH_AGENT_LABELS,
  parseHiddenLaunchAgents,
  serializeHiddenLaunchAgents,
  toggleHiddenLaunchAgent,
  type LaunchAgent,
} from './launchAgentVisibility';
import { canOpenRegisteredPort, projectExecutionKind, runningStateAfterReload, shouldAutoDetectProjectStart } from './projectExecution';
import { buildDeploymentTargets, type DeploymentTarget } from './deploymentTargets';
import {
  resolveWorktreeRemoteRefreshFeedback,
  shouldFetchWorktreeRemote,
  type WorktreeRemoteRefreshState,
} from './worktreeRemoteRefresh';
import {
  appendGitHubRepositoryUrl,
  githubRepositoryUrlFields,
  githubRepositoryUrls,
  githubRepositoryUrlsText,
  normalizeGitHubRepositoryUrl,
  parseGitHubRepositoryUrls,
  primaryGitHubRepositoryUrl,
} from './githubUrls';
import {
  appendBlankGitHubRepositoryUrlRow,
  githubRepositoryUrlRows,
  githubRepositoryUrlRowsText,
  removeGitHubRepositoryUrlRow,
  replaceGitHubRepositoryUrlRow,
  shouldAdoptGitHubRepositoryUrlValue,
} from './githubUrlFields';
import {
  githubRepositoryNameFromProject,
  type GitHubRepositoryVisibility,
} from './githubRepositoryCreate';
import { retryPortUpsertWithoutMissingOptionalColumns } from './portSupabaseFallback';
import { projectCode, projectIdentityClipboard } from './projectCode';
import { joinMemoryIdProblem } from './projectMemoryJoin';
import { PINNED_DRAG_THRESHOLD_PX, PINNED_ORDER_STORAGE_KEY, pinnedDropTargetAt, readPinnedOrder, reorderPinned, sortByPinnedOrder } from './pinnedOrder';
import { resolveContextProjectTarget } from './contextProjectNavigation';
import {
  buildProjectCodexVoiceHandoffPrompt,
  buildProjectCodexVoiceRecoveryPrompt,
} from './projectCodexVoice';
import {
  browserProfileOptionLabel,
  DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY,
  resolveSavedBrowserProfile,
  type BrowserProfile,
} from './browserProfile';
import { buildGitMergeSyncPrompt, buildPublicRepositoryUpdatePrompt } from './gitSyncPrompt';
import { matchesProjectSearch } from './projectSearch';
import {
  buildProjectFolderRenamePrompt,
  folderLeafName,
  projectFolderNameProblem,
} from './projectFolderRenamePrompt';
import { buildVocWorkflowPrompt, buildGitSyncWorkflowPrompt } from './vocWorkflowPrompt';
import { buildWindowsPcUpdatePrompt } from './windowsUpdateWorkflow';
import { buildLogWindowDelta } from './buildLogWindow';
import { publicGitHubRepositoryUrl } from './selfHosting';

// OS 감지 — navigator.platform('Win32')이 WebView2/Tauri 포함 가장 신뢰성 높음
const isWindows = () => {
  if (typeof navigator === 'undefined') return false;
  if (navigator.platform) return navigator.platform.toLowerCase().startsWith('win');
  return navigator.userAgent.toLowerCase().includes('win');
};
const execFileExt = () => isWindows() ? '.bat / .cmd / .ps1 / .html' : '.command / .sh / .html';
const isHtmlFile = (path?: string) => !!path && path.toLowerCase().endsWith('.html');

const portsWriterId = crypto.randomUUID();
const AGENTSTOZ_PUBLIC_REPOSITORY_URL = publicGitHubRepositoryUrl(import.meta.env.VITE_REPO_URL);
const SETUP_WIZARD_SEEN_KEY = 'portmanager-setup-wizard-seen-v1';

interface GitCommitRequestError extends Error {
  code?: string;
  diagnostic?: string;
  submodulePaths?: string[];
}
let portsSaveBaseline: PortInfo[] | null = null;
let portsSaveQueue: Promise<void> = Promise.resolve();
const clonePorts = (ports: PortInfo[]): PortInfo[] =>
  JSON.parse(JSON.stringify(ports)) as PortInfo[];

const githubDatabaseFields = (port: Pick<PortInfo, 'githubUrl' | 'githubUrls'>) => {
  const urls = githubRepositoryUrls(port);
  return {
    // Keep this legacy column populated for existing installations and older clients.
    github_url: urls[0] ?? null,
    github_urls: urls.length > 0 ? urls : null,
  };
};

const githubPortalItemId = (portId: string, url: string, index: number): string => {
  // Preserve the original primary item ID so existing portal pins/visit state survive.
  if (index === 0) return `auto:github:${portId}`;
  let hash = 5381;
  for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash) ^ url.charCodeAt(i);
  return `auto:github:${portId}:repo:${(hash >>> 0).toString(36)}`;
};

// Collapse rows sharing an id, keeping the first occurrence.
// A duplicated id is not merely cosmetic: React renders duplicate keys, and the
// Supabase upsert fails the whole batch with
// "ON CONFLICT DO UPDATE command cannot affect row a second time",
// which silently disables sync until the file is repaired by hand.
const dedupePortsById = (ports: PortInfo[]): PortInfo[] => {
  const seen = new Set<string>();
  const out: PortInfo[] = [];
  for (const p of ports) {
    if (p?.id == null || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
};

// API 호출 래퍼 (브라우저와 Tauri 모두 지원)
const API = {
  async loadPorts(): Promise<PortInfo[]> {
    // Do not let a focus reload overtake a queued local save.
    await portsSaveQueue;
    let ports: PortInfo[];
    if (isTauri()) {
      ports = await invoke<PortInfo[]>('load_ports');
    } else {
      const response = await fetch('/api/ports');
      if (!response.ok) throw new Error('Failed to load ports');
      ports = await response.json();
    }
    // Repair duplicated ids at the single read chokepoint so a once-corrupted
    // ports.json cannot keep breaking render and Supabase push on every launch.
    ports = dedupePortsById(ports);
    portsSaveBaseline = clonePorts(ports);
    return ports;
  },

  async savePorts(ports: PortInfo[]): Promise<void> {
    const desired = clonePorts(ports);
    const saveTask = portsSaveQueue.then(async () => {
      // Baseline is intentionally advanced to this window's desired state, not
      // the merged disk result. Projects unknown to this stale window therefore
      // remain "concurrent additions" and cannot be deleted by its later saves.
      const basePorts = clonePorts(portsSaveBaseline ?? []);
      if (isTauri()) {
        await invoke('save_ports_merged', {
          ports: desired,
          basePorts,
          source: `tauri:${portsWriterId}`,
        });
      } else {
        // Dedicated endpoint prevents an old hot-reloaded API process from
        // mistaking the merge envelope for the legacy ports array.
        let response = await fetch('/api/ports/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ports: desired,
            basePorts,
            source: `web:${portsWriterId}`,
          }),
        });
        // The installed sidecar can temporarily lag behind the Vite frontend
        // during development. Older builds do not expose /api/ports/merge, so
        // fall back to their array-only endpoint instead of misreporting the
        // local 404 as a Supabase/network synchronization failure.
        if (response.status === 404) {
          response = await fetch('/api/ports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desired),
          });
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error || `Failed to save ports (${response.status})`);
        }
      }
      portsSaveBaseline = desired;
    });
    portsSaveQueue = saveTask.catch(() => {});
    return saveTask;
  },

  async createGitHubRepository(portId: string, visibility: GitHubRepositoryVisibility): Promise<{
    repositoryUrl: string;
    repositoryName: string;
    visibility: GitHubRepositoryVisibility;
    pushed: boolean;
    uncommittedFileCount: number;
    warning: string | null;
  }> {
    const baseUrl = isTauri() ? 'http://127.0.0.1:3001' : '';
    const response = await fetch(`${baseUrl}/api/github-repository/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portId, visibility }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true || !result.repository?.repositoryUrl) {
      throw new Error(result.error || 'GitHub 저장소를 만들지 못했습니다.');
    }
    return result.repository;
  },

  // 마지막 실행/방문 시각 — 웹/앱이 동일 파일(last-visits.json)을 공유해 어느 쪽으로 써도 같이 반영됨
  async loadLastVisits(): Promise<Record<string, number>> {
    if (isTauri()) {
      return invoke<Record<string, number>>('load_last_visits');
    } else {
      const response = await fetch('/api/last-visits');
      if (!response.ok) throw new Error('Failed to load last visits');
      return response.json();
    }
  },

  async saveLastVisit(portId: string, timestamp: number): Promise<void> {
    if (isTauri()) {
      return invoke('save_last_visit', { portId, timestamp });
    } else {
      await fetch('/api/last-visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId, timestamp }),
      });
    }
  },

  async executeCommand(portId: string, commandPath: string, folderPath?: string, port?: number): Promise<void> {
    if (isTauri()) {
      return invoke('execute_command', { portId, commandPath, folderPath: folderPath ?? null, port: port ?? null });
    } else {
      const response = await fetch('/api/execute-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId, commandPath, folderPath, port })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
    }
  },

  async detectStartCommand(folderPath: string): Promise<{ command: string | null; framework: 'next' | 'vite' | 'other' }> {
    if (isTauri()) {
      return invoke<{ command: string | null; framework: 'next' | 'vite' | 'other' }>('detect_start_command', { folderPath });
    }
    const res = await fetch(`/api/detect-start-command?path=${encodeURIComponent(folderPath)}`);
    if (!res.ok) return { command: null, framework: 'other' };
    const data = await res.json();
    return { command: data.command ?? null, framework: data.framework ?? 'other' };
  },

  async stopCommand(portId: string, port: number | undefined): Promise<void> {
    if (isTauri()) {
      return invoke('stop_command', { portId, port });
    } else {
      const response = await fetch('/api/stop-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId, port })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
    }
  },

  async forceRestartCommand(portId: string, port: number | undefined, commandPath: string, folderPath?: string): Promise<void> {
    if (isTauri()) {
      return invoke('force_restart_command', { portId, port, commandPath, folderPath: folderPath ?? null });
    } else {
      const response = await fetch('/api/force-restart-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId, port, commandPath, folderPath })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
    }
  },

  async openBuildFolder(): Promise<void> {
    if (isTauri()) {
      await invoke('open_build_folder');
    } else {
      const response = await fetch('/api/open-build-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
    }
  },

  async importPorts(filePath: string): Promise<PortInfo[]> {
    if (isTauri()) {
      return invoke<PortInfo[]>('import_ports_from_file', { filePath });
    } else {
      throw new Error('파일 불러오기는 Tauri 앱에서만 사용 가능합니다');
    }
  },

  async openFolder(folderPath: string): Promise<void> {
    if (isTauri()) {
      return invoke('open_folder', { folderPath });
    } else {
      const response = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
    }
  },

  async openCodeApp(agent: 'codex' | 'claude' | 'hermes', folderPath: string): Promise<{ confirmationRequired?: boolean }> {
    if (isTauri()) {
      await invoke<string>('open_code_app', { agent, folderPath });
      return { confirmationRequired: agent === 'claude' };
    }
    const response = await fetch('/api/open-code-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, folderPath }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || '코드 앱 열기 실패');
    return result;
  },

  async openProjectCodexVoice(folderPath: string): Promise<{
    mode: 'resumed' | 'resumed-unbound' | 'started-project' | 'started-unbound' | 'move-pending';
    projectBound?: boolean;
    voiceThreadCreated?: boolean;
    voiceThreadResumed?: boolean;
    voiceStartRequested?: boolean;
    automation?: 'accessibility-button' | 'accessibility-global-button';
    automationError?: string;
    automationCode?: string;
    sessionId?: string;
    movePending?: boolean;
    appliedPath?: string | null;
  }> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/open-project-codex-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    const result = await response.json().catch(() => ({}));
    // The move the user asked for was recorded but never applied — the thread
    // still executes in the scratch folder. Saying "no linked voice chat" here
    // would contradict what they watched happen in ChatGPT.
    if (result.code === 'PROJECT_VOICE_MOVE_PENDING') {
      return { mode: 'move-pending', appliedPath: result.appliedPath ?? null };
    }
    if (!response.ok || !result.success) {
      const error = new Error(result.error || 'Codex Voice 열기 실패') as Error & {
        code?: string;
        dispatch?: 'not-attempted' | 'button-pressed' | 'global-button-pressed';
        automation?: 'accessibility-button' | 'accessibility-global-button';
      };
      if (typeof result.code === 'string') error.code = result.code;
      if (result.dispatch === 'not-attempted' || result.dispatch === 'button-pressed' || result.dispatch === 'global-button-pressed') {
        error.dispatch = result.dispatch;
      }
      if (result.automation === 'accessibility-button' || result.automation === 'accessibility-global-button') {
        error.automation = result.automation;
      }
      throw error;
    }
    return result;
  },

  async startGlobalCodexVoice(folderPath: string): Promise<{
    mode: 'started-global' | 'resumed-global';
    voiceThreadCreated: boolean;
    voiceThreadResumed: boolean;
    projectBound: false;
    automation: 'accessibility-global-button';
    sessionId?: string;
  }> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/start-global-codex-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      const error = new Error(result.error || '전역 Voice 시작 실패') as Error & {
        code?: string;
        dispatch?: 'not-attempted' | 'button-pressed' | 'global-button-pressed';
      };
      if (typeof result.code === 'string') error.code = result.code;
      if (result.dispatch === 'not-attempted' || result.dispatch === 'button-pressed' || result.dispatch === 'global-button-pressed') {
        error.dispatch = result.dispatch;
      }
      throw error;
    }
    return result;
  },

  async openChatGptVoice(folderPath: string): Promise<void> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/open-chatgpt-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'ChatGPT 앱 열기 실패');
  },

  async gitPull(folderPath: string): Promise<string> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/git-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath })
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    return result.output as string;
  },

  async gitPush(folderPath: string): Promise<string> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/git-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath })
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    return result.output as string;
  },

  async gitCommit(worktreePath: string, message: string): Promise<string> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/git-commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath, message }),
    });
    const result = await response.json();
    if (!result.success) {
      const error = new Error(result.error || 'Git 커밋에 실패했습니다') as GitCommitRequestError;
      error.code = result.code;
      error.diagnostic = result.diagnostic;
      error.submodulePaths = Array.isArray(result.submodulePaths) ? result.submodulePaths : [];
      throw error;
    }
    return result.output as string;
  },

  async suggestGitCommitMessage(worktreePath: string): Promise<string> {
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/git-commit-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreePath }),
    });
    const result = await response.json();
    if (response.status === 404) {
      throw new Error('API 서버가 이전 버전입니다. 프로젝트를 강제 재실행한 뒤 다시 시도해주세요.');
    }
    if (!response.ok || !result.message) {
      throw new Error(result.error || 'AI 커밋 메시지를 생성하지 못했습니다');
    }
    return result.message as string;
  },

  async installAppToApplications(): Promise<string> {
    // Installation must outlive the currently running Tauri process so the old
    // bundle can be quit and swapped. The supervised sidecar schedules a detached
    // installer helper; an in-process Rust command cannot safely replace itself.
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const response = await fetch(`${baseUrl}/api/install-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '앱 설치 준비에 실패했습니다');
    return result.message;
  },

  async buildApp(buildType: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>('build_app', { buildType });
    } else {
      const response = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: buildType })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async buildDmg(): Promise<string> {
    if (isTauri()) {
      return invoke<string>('build_app', { buildType: 'dmg' });
    } else {
      const response = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dmg' })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async listBrowserProfiles(): Promise<BrowserProfile[]> {
    if (isTauri()) {
      return invoke<BrowserProfile[]>('list_browser_profiles');
    }
    const response = await fetch('/api/browser-profiles');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.success === false || !Array.isArray(result?.profiles)) {
      throw new Error(result?.error || 'Chrome 프로필 목록을 불러오지 못했습니다.');
    }
    return result.profiles;
  },

  async openInChrome(url: string, profile?: BrowserProfile | null): Promise<void> {
    if (isTauri()) {
      return invoke('open_in_chrome', {
        url,
        profileDirectory: profile?.profileDirectory ?? null,
      });
    }
    if (profile) {
      const response = await fetch('/api/open-in-chrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, profileId: profile.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.success === false) {
        throw new Error(result?.error || '선택한 Chrome 프로필로 열지 못했습니다.');
      }
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async exportDmg(): Promise<string> {
    if (isTauri()) {
      return invoke<string>('export_dmg');
    } else {
      const response = await fetch('/api/export-dmg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async listGitWorktrees(folderPath: string, fetchRemote = false): Promise<WorktreeInfo[]> {
    if (isTauri()) {
      return invoke<WorktreeInfo[]>('list_git_worktrees', { folderPath, fetchRemote });
    } else {
      const res = await fetch('/api/list-git-worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, fetchRemote }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false || !Array.isArray(data?.worktrees)) {
        const failure = new Error(data?.error || `Git 워크트리 목록 확인 실패 (${res.status})`);
        if (typeof data?.code === 'string') {
          (failure as Error & { code?: string }).code = data.code;
        }
        throw failure;
      }
      return data.worktrees;
    }
  },

  async gitWorktreeAdd(folderPath: string, branchName: string, worktreePath?: string, orcaManaged = false): Promise<{ path: string; branch?: string; renamedFrom?: string; requestedBranch?: string; orcaManaged?: boolean }> {
    if (isTauri()) {
      return invoke<{ path: string; branch?: string; renamedFrom?: string; requestedBranch?: string; orcaManaged?: boolean }>('git_worktree_add', { folderPath, branchName, worktreePath: worktreePath ?? null, orcaManaged });
    }
    const res = await fetch('/api/git-worktree-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, branchName, worktreePath, orcaManaged }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return { path: data.path, branch: data.branch, renamedFrom: data.renamedFrom, requestedBranch: data.requestedBranch, orcaManaged: data.orcaManaged };
  },

  /** 레거시(숨김) `.claude/worktrees/<name>` 워크트리를 현행 `worktrees/<name>` 로 이동.
   *  대상 경로는 백엔드가 재계산하므로 여기서 넘기지 않는다(경로 조작 차단). */
  async gitWorktreeMove(folderPath: string, from: string): Promise<{ from: string; to: string }> {
    if (isTauri()) {
      const r = await invoke<{ from: string; to: string }>('git_worktree_move', { folderPath, from });
      return r;
    }
    const res = await fetch('/api/move-git-worktree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, from }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '워크트리 이동에 실패했습니다.');
    return { from: data.from, to: data.to };
  },

  async gitInit(folderPath: string, opts?: { checkOnly?: boolean }): Promise<{ initialized?: boolean; alreadyGit?: boolean; hasCommit?: boolean; error?: string; repositoryWorkflow?: RepositoryWorkflowStatus }> {
    if (isTauri()) {
      return invoke('git_init', { folderPath, checkOnly: opts?.checkOnly ?? false });
    }
    const res = await fetch('/api/git-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, checkOnly: opts?.checkOnly ?? false }),
    });
    return res.json();
  },

  async gitReinitialize(folderPath: string): Promise<{ initialized?: boolean; hasCommit?: boolean; error?: string }> {
    if (isTauri()) {
      return invoke('git_reinitialize', { folderPath, confirmed: true });
    }
    const res = await fetch('/api/git-reinitialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, confirmed: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Git 저장소 초기화 실패');
    return data;
  },

  async detectGitRemoteUrl(folderPath: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>('detect_git_remote_url', { folderPath });
    }
    const res = await fetch('/api/detect-git-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Git 원격 저장소를 찾지 못했습니다');
    return data.url;
  },

  // 잠금 해제 / 브랜치 전환은 Tauri에서도 사이드카 api-server(3001)를 그대로 쓴다.
  // Rust에 같은 로직을 복제하면 두 구현이 갈라지는 비용이 크고, 검증 규칙(등록 확인·dirty·locked)이
  // 한 곳에만 있어야 웹과 앱의 동작이 어긋나지 않는다. repositoryWorkflowApi와 같은 방식.
  async gitWorktreeUnlock(folderPath: string, worktreePath: string): Promise<void> {
    const base = isTauri() ? 'http://127.0.0.1:3001' : '';
    const res = await fetch(`${base}/api/git-worktree-unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, worktreePath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || '잠금 해제 실패');
  },

  async gitWorktreeSwitchBranch(folderPath: string, worktreePath: string, branchName: string): Promise<{ branch: string; base: string }> {
    const base = isTauri() ? 'http://127.0.0.1:3001' : '';
    const res = await fetch(`${base}/api/git-worktree-switch-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, worktreePath, branchName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || '브랜치 전환 실패');
    return { branch: data.branch, base: data.base };
  },

  async gitWorktreeRemove(folderPath: string, worktreePath: string, orcaManaged = false): Promise<void> {
    if (isTauri()) {
      return invoke('git_worktree_remove', { folderPath, worktreePath, orcaManaged });
    }
    const res = await fetch('/api/git-worktree-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, worktreePath, orcaManaged }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || '워크트리 제거 실패');
  },

  async gitMergeBranch(folderPath: string, branchName: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>('git_merge_branch', { folderPath, branchName });
    }
    const res = await fetch('/api/git-merge-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, branchName }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    return data.output ?? '';
  },

  async checkPortStatus(port: number): Promise<boolean> {
    if (isTauri()) {
      return invoke<boolean>('check_port_status', { port });
    } else {
      const response = await fetch('/api/check-port-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.isRunning;
    }
  },

  // 여러 포트 상태를 단일 호출로 일괄 확인 (포트당 lsof/HTTP 1회 → 전체 1회)
  async checkPortsStatusBatch(ports: number[]): Promise<{ port: number; isRunning: boolean }[]> {
    if (ports.length === 0) return [];
    if (isTauri()) {
      return invoke<{ port: number; isRunning: boolean }[]>('check_ports_status_batch', { ports });
    } else {
      const response = await fetch('/api/check-ports-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ports }),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.results;
    }
  },

  async openLog(portId: string): Promise<void> {
    if (isTauri()) {
      return invoke('open_log', { portId });
    } else {
      const res = await fetch(`/api/open-log/${encodeURIComponent(portId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '로그 열기 실패');
    }
  },

  async readLogContent(portId: string, offset: number = 0): Promise<{ content: string; size: number; exists: boolean; offset: number }> {
    if (isTauri()) {
      return invoke('read_log_content', { portId, offset });
    } else {
      const res = await fetch(`/api/log-content/${encodeURIComponent(portId)}?offset=${offset}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '로그 읽기 실패');
      return data;
    }
  },

  async openTmuxClaude(sessionName: string, folderPath?: string, worktreePath?: string, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_tmux_claude', { sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-tmux-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTmuxClaudeFresh(sessionName: string, folderPath?: string, worktreePath?: string, bypass?: boolean, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_tmux_claude_fresh', { sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-tmux-claude-fresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error);
      return data.message;
    }
  },

  async openTmuxClaudeBypass(sessionName: string, folderPath?: string, worktreePath?: string, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_tmux_claude_bypass', { sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-tmux-claude-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async checkWsl(): Promise<{ status: string }> {
    if (isTauri()) return invoke<{ status: string }>('check_wsl');
    const res = await fetch('/api/check-wsl');
    return res.json();
  },

  async installWsl(): Promise<string> {
    if (isTauri()) return invoke<string>('install_wsl');
    throw new Error('WSL 설치는 설치된 앱에서만 가능합니다');
  },

  async installWslTmux(): Promise<string> {
    if (isTauri()) return invoke<string>('install_wsl_tmux');
    const res = await fetch('/api/install-wsl-tmux', { method: 'POST' });
    const d = await res.json();
    if (!d.success) throw new Error(d.error);
    return d.message ?? 'tmux 설치 완료';
  },

  async openTerminalClaudeBypass(folderPath?: string, name?: string, worktreePath?: string, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_claude_bypass', { folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-terminal-claude-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTerminalClaude(folderPath?: string, name?: string, worktreePath?: string, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_claude', { folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-terminal-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTerminalCodex(folderPath?: string, name?: string, worktreePath?: string, bypass?: boolean, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_codex', { folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-terminal-codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTerminalAgy(folderPath?: string, name?: string, worktreePath?: string, bypass?: boolean, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_agy', { folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null });
    } else {
      const response = await fetch('/api/open-terminal-agy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTerminalHermes(folderPath?: string, name?: string, worktreePath?: string, terminalApp?: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_hermes', { folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null });
    }
    const response = await fetch('/api/open-terminal-hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: folderPath ?? null, name: name ?? null, worktreePath: worktreePath ?? null, terminalApp: terminalApp ?? null }),
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    return result.message;
  },

  async openTerminalAgentView(
    terminalApp?: 'iterm' | 'terminal',
    bypass?: boolean,
    folderPath?: string,
    name?: string,
  ): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_agent_view', {
        terminalApp: terminalApp ?? null,
        bypass: bypass ?? false,
        folderPath: folderPath ?? null,
        name: name ?? null,
      });
    } else {
      const response = await fetch('/api/open-terminal-agent-view', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terminalApp: terminalApp ?? null,
          bypass: bypass ?? false,
          folderPath: folderPath ?? null,
          name: name ?? null,
        }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTerminalAtFolder(folderPath: string, title: string, terminalApp: 'iterm' | 'terminal'): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_terminal_at_folder', { folderPath, title, terminalApp });
    }
    const response = await fetch('/api/open-terminal-at-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, title, terminalApp }),
    });
    const result = await response.json();
    if (!response.ok || result?.success === false) throw new Error(result?.error ?? `HTTP ${response.status}`);
    return result?.message ?? `${terminalApp} 터미널 열림`;
  },

  async openTmuxCodex(sessionName: string, folderPath?: string, worktreePath?: string, bypass?: boolean, terminalApp?: 'iterm' | 'terminal', fresh?: boolean): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_tmux_codex', { sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null, fresh: fresh ?? false });
    } else {
      const response = await fetch('/api/open-tmux-codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null, fresh: fresh ?? false })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async openTmuxAgy(sessionName: string, folderPath?: string, worktreePath?: string, bypass?: boolean, terminalApp?: 'iterm' | 'terminal', fresh?: boolean): Promise<string> {
    if (isTauri()) {
      return invoke<string>('open_tmux_agy', { sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null, fresh: fresh ?? false });
    } else {
      const response = await fetch('/api/open-tmux-agy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, folderPath: folderPath ?? null, worktreePath: worktreePath ?? null, bypass: bypass ?? false, terminalApp: terminalApp ?? null, fresh: fresh ?? false })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.message;
    }
  },

  async createFolder(folderPath: string): Promise<{ success: boolean; path: string }> {
    if (isTauri()) {
      try {
        const path = await invoke<string>('create_folder', { folderPath });
        return { success: true, path };
      } catch (e: any) {
        return { success: false, path: '', error: e.message || String(e) } as any;
      }
    }
    const response = await fetch('/api/create-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath })
    });
    return response.json();
  },

  /**
   * 저장소를 새 폴더로 clone 한다. 폴더는 git 이 직접 만든다 — 미리 `createFolder` 로
   * 만들어 두면 clone 이 "이미 존재하는 폴더"로 거절한다.
   */
  async cloneRepository(repositoryUrl: string, folderPath: string): Promise<{ success: boolean; path: string; error?: string }> {
    if (isTauri()) {
      try {
        const path = await invoke<string>('clone_repository', { repositoryUrl, folderPath });
        return { success: true, path };
      } catch (e: any) {
        return { success: false, path: '', error: e?.message || String(e) };
      }
    }
    const response = await fetch('/api/clone-repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryUrl, folderPath }),
    });
    const payload = await response.json();
    // 서버가 이 엔드포인트를 모르면 기능 실패가 아니라 **서버가 오래된 것**이다.
    // 폴백의 "Not found" 를 그대로 보여주면 사용자는 다음에 뭘 할지 알 수 없다.
    if (isUnknownApiEndpoint(response.status, payload)) {
      return { success: false, path: '', error: unknownApiEndpointMessage('/api/clone-repository') };
    }
    return payload;
  },

  async detectPort(filePath: string): Promise<{ port?: number; folderPath?: string }> {
    if (isTauri()) {
      return invoke<{ port?: number; folderPath?: string }>('detect_port', { filePath });
    } else {
      const res = await fetch('/api/detect-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      return res.json();
    }
  },

  async scanCommandFiles(folderPath: string): Promise<string[]> {
    if (isTauri()) {
      return invoke<string[]>('scan_command_files', { folderPath });
    } else {
      const res = await fetch('/api/scan-command-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      const data = await res.json();
      return data.files || [];
    }
  },

  async openAppDataDir(): Promise<void> {
    if (isTauri()) {
      await invoke('open_app_data_dir');
    } else {
      await fetch('/api/open-app-data-dir', { method: 'POST' });
    }
  },

  async loadWorkspaceRoots(): Promise<WorkspaceRoot[]> {
    let roots: WorkspaceRoot[];
    if (isTauri()) {
      const val = await invoke<WorkspaceRoot[]>('load_workspace_roots');
      roots = Array.isArray(val) ? val : [];
    } else {
      const res = await fetch('/api/workspace-roots');
      if (!res.ok) return [];
      roots = await res.json();
    }
    // 다른 OS에서 동기화된 루트(예: macOS의 /tmp)는 이 플랫폼에서 폴더를 만들 수 없다
    return Array.isArray(roots) ? roots.filter(r => isUsableRootPath(r?.path)) : [];
  },

  async saveWorkspaceRoots(roots: WorkspaceRoot[]): Promise<void> {
    if (isTauri()) {
      await invoke('save_workspace_roots', { roots });
    } else {
      const response = await fetch('/api/workspace-roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roots),
      });
      if (!response.ok) throw new Error('작업 루트 저장 실패');
      const result = await response.json().catch(() => ({}));
      if (result.success === false) throw new Error(result.error || '작업 루트 저장 실패');
    }
  },

  async suggestNameAndCategory(folderPath: string, name: string): Promise<{ name: string | null; category: string | null }> {
    if (isTauri()) {
      // 단건도 배치 커맨드를 1개 프로젝트로 호출해야 웹과 동일하게
      // 별명과 카테고리를 한 번의 프로젝트 분석에서 함께 받을 수 있다.
      try {
        const id = `single-${crypto.randomUUID()}`;
        const [suggestion] = await API.suggestBatch([{ id, folderPath, name }]);
        return {
          name: suggestion?.name ?? null,
          category: suggestion?.category ?? null,
        };
      } catch { return { name: null, category: null }; }
    }
    try {
      const res = await fetch('/api/suggest-name-and-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, name }),
      });
      if (!res.ok) return { name: null, category: null };
      return res.json();
    } catch { return { name: null, category: null }; }
  },

  async suggestBatch(ports: Array<{ id: string; folderPath: string; name: string; aiName?: string }>): Promise<Array<{ id: string; name: string | null; category: string | null }>> {
    if (isTauri()) {
      // Tauri: Rust 커맨드 사용 (id → {name, category} 매핑 객체 반환)
      try {
        const result = await invoke<Record<string, unknown>>('suggest_names_batch', { ports });
        return Object.entries(result ?? {}).map(([id, v]) => {
          const entry = v as { name?: unknown; category?: unknown } | string | null;
          if (typeof entry === 'string') return { id, name: entry, category: null }; // 구버전 응답 호환
          return {
            id,
            name: typeof entry?.name === 'string' ? entry.name : null,
            category: typeof entry?.category === 'string' ? entry.category : null,
          };
        });
      } catch { return []; }
    }
    try {
      const res = await fetch('/api/suggest-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ports }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.results ?? [];
    } catch { return []; }
  },

  async getGlobalShortcut(): Promise<string> {
    if (isTauri()) return invoke<string>('get_global_shortcut');
    return '';
  },

  async setGlobalShortcut(shortcut: string, oldShortcut: string): Promise<void> {
    if (isTauri()) return invoke('set_global_shortcut', { shortcut, oldShortcut });
  },
};

const AI_NAME_BATCH_CHAT_PROMPT = `포트관리기의 프로젝트 목록에 "AI 추천 이름(aiName)"과 "카테고리(category)"를 채워줘.

이 작업은 Claude Code와 Codex 어느 쪽에서 실행해도 된다.

## 대상 파일 (현재 운영체제에 맞는 경로 하나만 사용)
- macOS: ~/Library/Application Support/com.portmanager.portmanager/ports.json
- Windows: %APPDATA%\\com.portmanager.portmanager\\ports.json

## 절차

1. **백업 먼저**: 쓰기 전에 반드시 백업 생성 (코드 한 줄로 충분).
   \`cp "$HOME/Library/Application Support/com.portmanager.portmanager/ports.json" "$HOME/Library/Application Support/com.portmanager.portmanager/ports.json.bak"\`

2. **읽기**: JSON을 파싱해서 배열을 메모리에 로드.

3. **각 항목에 aiName + category 설정**:
   - 이미 \`aiName\`이 있으면 건드리지 말 것 (idempotent — 재실행해도 기존 별칭 유지)
   - 이미 \`category\`가 있으면 건드리지 말 것
   - 없는 항목에만 새로 생성
   - 참고 필드: name, folderPath(basename), description, githubUrl, githubUrls, deployUrl, commandPath, terminalCommand

4. **aiName 규칙**:
   - 2~4 단어의 짧은 영어 (공백 구분, 예: "port manager", "tax calculator", "link page generator")
   - 프로젝트의 핵심 기능을 드러내는 키워드
   - 한국어 프로젝트는 의미를 영어로 번역
   - 이미 영어 이름이면 더 검색 친화적인 키워드 한 개로 압축
   - 모두 소문자

5. **category 규칙**:
   - 단일 소문자 영어 단어 (예: converter, dashboard, manager, tracker, bot, guide, calculator, automation, monitor, generator)
   - 프로젝트가 **무엇을 하는지** 핵심을 담을 것
   - aiName을 primary signal로 참고

6. **필드 보존 규칙 (매우 중요)**:
   - 다음 필드는 **원본 값 그대로 유지**해야 함 — 존재한다면 삭제/수정 금지:
     id, name, port, commandPath, terminalCommand, folderPath, deployUrl, githubUrl, githubUrls, worktreePath, manualPath, logFilePath, description, isRunning
   - \`worktreePath: null\` 같은 명시적 null 값도 그대로 유지 (삭제 금지)
   - \`isRunning: false\` 같은 boolean도 그대로 유지
   - 원래 없던 필드를 새로 추가하지 말 것 (aiName, category 제외)

7. **원자적 쓰기 (atomic write)**:
   - 임시 파일에 먼저 쓴 후 rename으로 교체 (중간 인터럽트 시 원본 손상 방지)
   - 예시 절차:
     a. \`ports.json.tmp\`에 전체 JSON 직렬화 (2-space indent)
     b. fs.rename(\`ports.json.tmp\`, \`ports.json\`)
   - 들여쓰기는 원본과 동일하게 2-space

8. **검증**:
   - 쓰기 후 다시 읽어서 파싱 가능한지 확인
   - 항목 수가 원본과 동일한지 확인
   - 파싱 실패 시 백업(\`.bak\`)에서 복원

9. **보고**: 완료 후 한 줄로 "N개 항목에 aiName 추가, M개 category 추가, 총 K개 검증 완료" 형식으로 보고.

완료되면 포트관리기에서 "새로고침" 버튼을 누르면 별칭이 에메랄드 배지로 표시되고 검색에서 매칭됩니다.`;

interface PortInfo {
  id: string;
  name: string;
  port?: number;
  commandPath?: string;
  terminalCommand?: string;
  folderPath?: string;
  deployUrl?: string;
  /** Primary GitHub repository URL retained for older local data and integrations. */
  githubUrl?: string;
  /** All GitHub repository URLs, ordered with githubUrl first. */
  githubUrls?: string[];
  worktreePath?: string;
  manualPath?: string;
  logFilePath?: string;
  category?: string;
  description?: string;
  aiName?: string;  // AI-generated English alias for search
  favorite?: boolean;
  isRunning?: boolean;
  sourceDeviceId?: string; // device_id from Supabase — used to prevent cross-device overwrite on push
}

const buildSingleAiNameChatPrompt = (item: Pick<PortInfo, 'id' | 'name' | 'folderPath' | 'aiName' | 'category'>) => `포트관리기에 등록된 아래 프로젝트 하나를 직접 분석해서 "AI 추천 이름(aiName)"과 "카테고리(category)"를 생성해줘.

이 작업은 Claude Code와 Codex 어느 쪽에서 실행해도 된다.

## 대상 프로젝트
- id: ${JSON.stringify(item.id)}
- 현재 이름: ${JSON.stringify(item.name)}
- 프로젝트 폴더: ${JSON.stringify(item.folderPath ?? '')}
- 현재 AI 이름: ${JSON.stringify(item.aiName ?? '')}
- 현재 카테고리: ${JSON.stringify(item.category ?? '')}

## 포트관리기 데이터 파일 (현재 운영체제에 맞는 경로 하나만 사용)
- macOS: ~/Library/Application Support/com.portmanager.portmanager/ports.json
- Windows: %APPDATA%\\com.portmanager.portmanager\\ports.json

## 수행 방법
1. 수정 전에 ports.json을 ports.json.bak으로 백업해.
2. 위 프로젝트 폴더의 README, package.json 등 핵심 파일을 읽어 실제 용도를 파악해.
3. ports.json에서 id가 정확히 일치하는 항목 하나만 찾아 수정해. 찾지 못하면 파일을 수정하지 말고 보고해.
4. aiName은 핵심 기능을 나타내는 2~4단어의 소문자 영어 이름으로 만들어.
5. category는 프로젝트가 무엇을 하는지 나타내는 단일 소문자 영어 단어로 만들어.
6. aiName과 category 외의 모든 필드와 명시적 null/false 값은 그대로 보존해.
7. 임시 파일에 2칸 들여쓰기 JSON으로 쓴 뒤 rename하는 원자적 방식으로 교체해.
8. 다시 읽어 JSON 파싱, 전체 항목 수, 대상 외 항목 불변 여부를 검증하고 실패하면 백업에서 복원해.
9. 완료 후 생성한 aiName과 category를 한 줄로 보고해.

완료되면 포트관리기에서 새로고침을 눌러 결과를 확인할 수 있다.`;

interface WorktreeInfo {
  path: string;
  branch?: string;
  /** Commit SHA reported by Git, including when this worktree is detached. */
  head?: string;
  /** Git explicitly reported `detached`; never infer a branch name for this state. */
  detached?: boolean;
  is_main: boolean;
  /** main 브랜치 대비 머지 안 된 커밋 수. 0이면 머지할 변경사항 없음(신규 생성 직후 포함) (undefined = 계산 안 됨/알 수 없음) */
  aheadCount?: number;
  /** git worktree lock 여부 (Claude Code 세션 등이 사용 중) */
  locked?: boolean;
  /** lock 사유 (예: "claude session <name> (pid ... start ...)") */
  lockedReason?: string;
  /** 커밋되지 않은 전체 파일 수 (staged + unstaged + untracked + conflict) */
  changedFiles?: number;
  stagedFiles?: number;
  untrackedFiles?: number;
  conflictedFiles?: number;
  hasCommits?: boolean;
  /** 워크트리가 만들어진 시각 (ISO) — `.git` 표식의 생성 시각 */
  createdAt?: string;
  /** 이 워크트리 브랜치의 마지막 커밋 시각 (ISO) */
  lastCommitAt?: string;
  /** 실제 tracking upstream 또는 tracking이 없을 때 발견한 origin/<branch> */
  upstream?: string;
  hasUpstream?: boolean;
  remoteBranchExists?: boolean;
  githubConnected?: boolean;
  /** 현재 HEAD가 upstream보다 앞/뒤인 커밋 수 */
  ahead?: number;
  behind?: number;
  statusError?: string;
  remoteRefreshError?: string;
  /** fetched=원격 반영 완료, no-origin=원격 없이 로컬 상태만 정상 갱신 */
  remoteRefreshState?: WorktreeRemoteRefreshState;
}

type WorktreeGitStatus = 'checking' | 'ready' | 'no-commit' | 'none' | 'unknown';
type FirstTaskAgent = 'claude' | 'codex' | 'agy';

interface FirstTaskLaunchRequest {
  agent: FirstTaskAgent;
  item: PortInfo;
  isNew?: boolean;
}

interface GitOperationErrorState {
  title: string;
  message: string;
  diagnostic: string;
  worktreePath: string;
  submodulePaths: string[];
  item: PortInfo;
  parentWorktree: WorktreeInfo;
  attemptedMessage: string;
}

type SortType = 'name' | 'port' | 'recent';

interface Toast {
  id: number;
  message: string;
  // warning: 실패가 아니라 "동작은 하지만 알아둘 제약"을 알릴 때 쓴다.
  // 빨강(error)으로 띄우면 실행이 실패한 것으로 오해하게 된다.
  type: 'success' | 'error' | 'warning';
  /** 오류 제보용 구조화 문자열. 사용자가 명시적으로 눌렀을 때만 복사한다. */
  diagnostic?: string;
}

interface WorkspaceRoot {
  id: string;
  name: string;
  path: string; // absolute path (Tauri) or directory name (Web)
}

// IndexedDB helpers for FileSystemDirectoryHandle persistence (web only)
const openIDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const req = indexedDB.open('portmanager-workspace', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('handles');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const idbSaveHandle = async (id: string, handle: FileSystemDirectoryHandle) => {
  const db = await openIDB();
  const tx = db.transaction('handles', 'readwrite');
  (tx.objectStore('handles') as IDBObjectStore).put(handle, id);
  return new Promise<void>(r => { tx.oncomplete = () => { db.close(); r(); }; });
};

const idbLoadHandle = async (id: string): Promise<FileSystemDirectoryHandle | null> => {
  const db = await openIDB();
  const tx = db.transaction('handles', 'readonly');
  const req = (tx.objectStore('handles') as IDBObjectStore).get(id);
  return new Promise(r => {
    req.onsuccess = () => { db.close(); r((req.result as FileSystemDirectoryHandle) ?? null); };
    req.onerror = () => { db.close(); r(null); };
  });
};

const idbDeleteHandle = async (id: string) => {
  const db = await openIDB();
  const tx = db.transaction('handles', 'readwrite');
  (tx.objectStore('handles') as IDBObjectStore).delete(id);
  return new Promise<void>(r => { tx.oncomplete = () => { db.close(); r(); }; });
};

const getSessionName = (item: PortInfo): string => {
  const label = item.aiName || item.name;
  return label.replace(/[\s/\\:*?"<>|]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'unnamed';
};

/** POSIX `/...` 과 Windows `C:\...` 둘 다 절대경로로 인정 */
const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/])/.test(p);

/**
 * 워크트리 경로 기반 안정적인 포트 할당 (fallback).
 * 알파벳순 정렬 인덱스 대신 경로 해시를 사용해 새 워크트리 추가 시 기존 포트 유지.
 * 범위: 10001–10499
 */
const worktreePortFromPath = (worktreePath: string, usedPorts: Set<number>): number => {
  const name = worktreePath.split('/').pop() ?? worktreePath;
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  const base = 10001 + (h % 499);
  for (let p = base; p <= 10499; p++) { if (!usedPorts.has(p)) return p; }
  for (let p = 10001; p < base; p++) { if (!usedPorts.has(p)) return p; }
  return base;
};

/**
 * 메인 포트에서 파생된 워크트리 포트 할당.
 * mainPort가 1000-9999 범위면 slot*10000+mainPort (slot 1..5) 중 하나를 경로 해시로 선택.
 * 예: 메인 9005 → 19005, 29005, 39005, 49005, 59005 중 하나.
 * mainPort가 없거나 범위 밖이면 worktreePortFromPath로 폴백.
 */
const worktreePortForMain = (mainPort: number | undefined, worktreePath: string, usedPorts: Set<number>): number => {
  if (mainPort == null || mainPort < 1000 || mainPort > 9999) {
    return worktreePortFromPath(worktreePath, usedPorts);
  }
  const name = worktreePath.split('/').pop() ?? worktreePath;
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  const slotCount = 5;
  const startSlot = 1 + (h % slotCount);
  for (let i = 0; i < slotCount; i++) {
    const slot = 1 + ((startSlot - 1 + i) % slotCount);
    const candidate = slot * 10000 + mainPort;
    if (candidate <= 65535 && !usedPorts.has(candidate)) return candidate;
  }
  return worktreePortFromPath(worktreePath, usedPorts);
};

/** Race a promise against a timeout. Rejects with Error if ms elapses first. */
const withTimeout = <T,>(promise: PromiseLike<T>, ms: number): Promise<T> =>
  Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);

/**
 * Model B merge: remote wins for known IDs, local-only rows survive.
 * isRunning preserved from local. deployUrl/githubUrl/githubUrls/description treat local as authoritative
 * so user edits aren't clobbered by stale Supabase rows between push debounce windows.
 * After id-merge, dedupe port-less folder rows by folderPath to absorb the case where
 * the same folder was migrated independently on multiple devices with different ids.
 */
const mergePorts = (local: PortInfo[], remote: PortInfo[]): PortInfo[] => {
  const remoteById = new Map(remote.map(p => [p.id, p]));
  const merged = local.map(p => {
    const r = remoteById.get(p.id);
    if (!r) return p;
    return {
      ...p, ...r,
      isRunning: p.isRunning,
      aiName: r.aiName ?? p.aiName,
      category: p.category ?? r.category,
      terminalCommand: p.terminalCommand ?? r.terminalCommand,
      folderPath: p.folderPath ?? r.folderPath,
      commandPath: p.commandPath ?? r.commandPath,
      worktreePath: p.worktreePath ?? r.worktreePath,
      deployUrl: p.deployUrl ?? r.deployUrl,
      ...githubRepositoryUrlFields(
        githubRepositoryUrls(p).length > 0 ? githubRepositoryUrls(p) : githubRepositoryUrls(r),
      ),
      manualPath: p.manualPath ?? r.manualPath,
      logFilePath: p.logFilePath ?? r.logFilePath,
      description: p.description ?? r.description,
    };
  });
  const localIds = new Set(local.map(p => p.id));
  const newFromRemote = remote.filter(p => !localIds.has(p.id));
  return dedupeFolderRows([...merged, ...newFromRemote]);
};

// Collapse port-less rows (folder-only entries) that share the same folderPath.
// Rows with a port are never collapsed — a folder may legitimately host multiple servers.
const dedupeFolderRows = (rows: PortInfo[]): PortInfo[] => {
  const byFolder = new Map<string, PortInfo>();
  const kept: PortInfo[] = [];
  for (const row of rows) {
    if (row.port || !row.folderPath) { kept.push(row); continue; }
    const key = row.folderPath;
    const prev = byFolder.get(key);
    if (!prev) { byFolder.set(key, row); kept.push(row); continue; }
    // Prefer the row with more populated fields; on tie keep the earlier (local) one
    const score = (p: PortInfo) =>
      [p.name, p.deployUrl, ...githubRepositoryUrls(p), p.description, p.commandPath, p.terminalCommand, p.manualPath, p.logFilePath, p.category]
        .filter(Boolean).length + (p.favorite ? 1 : 0);
    if (score(row) > score(prev)) {
      // Replace prev with row in-place
      const idx = kept.indexOf(prev);
      if (idx !== -1) kept[idx] = row;
      byFolder.set(key, row);
    }
  }
  return kept;
};

// 다른 기기 Pull 전용 병합: name 기준으로 매칭, 새 항목만 새 ID로 추가
// 경로(folderPath, commandPath)는 기기마다 다르므로 기존 로컬 것 유지
// idMap: 원격 row id → 로컬 id (메모 등 id 기반 데이터 재매핑용)
const mergePortsFromOtherDevice = (local: PortInfo[], remote: PortInfo[]): { merged: PortInfo[]; idMap: Map<string, string> } => {
  const result = new Map(local.map(p => [p.id, p]));
  const localByName = new Map(local.map(p => [p.name?.toLowerCase(), p.id]));
  const idMap = new Map<string, string>();

  for (const r of remote) {
    const key = r.name?.toLowerCase();
    if (!key) continue;
    const existingId = localByName.get(key);
    if (existingId) {
      // 이미 있는 프로젝트 → 공유 메타만 업데이트, 경로는 로컬 유지
      const existing = result.get(existingId)!;
      result.set(existingId, {
        ...existing,
        port: r.port ?? existing.port,
        deployUrl: r.deployUrl ?? existing.deployUrl,
        ...githubRepositoryUrlFields(
          githubRepositoryUrls(r).length > 0 ? githubRepositoryUrls(r) : githubRepositoryUrls(existing),
        ),
        description: r.description ?? existing.description,
        category: r.category ?? existing.category,
      });
      idMap.set(r.id, existingId);
    } else {
      // 새 프로젝트 → 새 ID 발급, 경로/명령은 비워둠 (이 기기에서 직접 설정 필요)
      const newId = crypto.randomUUID();
      const newPort: PortInfo = {
        ...r,
        id: newId,
        folderPath: undefined,
        commandPath: undefined,
        terminalCommand: undefined,
        manualPath: undefined,
        logFilePath: undefined,
        isRunning: false,
      };
      result.set(newId, newPort);
      localByName.set(key, newId);
      idMap.set(r.id, newId);
    }
  }
  return { merged: Array.from(result.values()), idMap };
};

// 현재 플랫폼 경로 여부 판별 (다른 OS 경로의 포트는 화면에서 숨기되 파일에는 보존)
const isWinPath = (p: string) => /^[A-Za-z]:[/\\]/.test(p);
const isMacPath = (p: string) => /^\/Users\/|^\/home\//.test(p);
// 작업 루트는 실제로 폴더를 만드는 데 쓰이므로 이 플랫폼에서 유효한 절대경로여야 한다.
// isMacPath는 /Users·/home만 잡아서 /tmp 같은 POSIX 루트가 Windows로 새어 들어온다
// (roots Pull은 device_id 매칭 실패 시 전 기기 루트를 fallback으로 가져온다).
// 그 결과 "새 폴더 만들기"가 /tmp를 기본값으로 보여주고 생성은 "절대경로가 필요합니다"로 실패한다.
const isUsableRootPath = (p: string): boolean => {
  if (!p) return false;
  const isWin = (typeof process !== 'undefined' && process.platform === 'win32') || /Win/.test(navigator.platform ?? '');
  if (isWin) return isWinPath(p) || /^\\\\[^\\]+\\/.test(p); // 드라이브 경로 또는 UNC
  return p.startsWith('/');
};
const isCurrentPlatformPath = (port: PortInfo) => {
  const paths = [port.folderPath, port.commandPath].filter(Boolean) as string[];
  if (paths.length === 0) return true;
  const isWin = (typeof process !== 'undefined' && process.platform === 'win32') || /Win/.test(navigator.platform ?? '');
  if (isWin) return paths.every(p => !isMacPath(p));
  return paths.every(p => !isWinPath(p));
};



// localStorage credential fallback helper — works even when API server is offline
const getPortalCredentials = async (): Promise<{ supabaseUrl?: string; supabaseAnonKey?: string; deviceId?: string; viewingDeviceId?: string; deviceName?: string }> => {
  try {
    const res = await Promise.race([
      fetch('/api/portal'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]) as Response;
    if (res.ok) {
      const data = await res.json();
      if (data.supabaseUrl) {
        localStorage.setItem('portalCreds', JSON.stringify({
          supabaseUrl: data.supabaseUrl,
          supabaseAnonKey: data.supabaseAnonKey,
          deviceId: data.deviceId,
          deviceName: data.deviceName,
        }));
      }
      return data;
    }
  } catch {}
  // deviceId/viewingDeviceId/deviceName은 항상 localStorage에서 (기기 정체성)
  let deviceId: string | undefined;
  let viewingDeviceId: string | undefined;
  let deviceName: string | undefined;
  try {
    const raw = localStorage.getItem('portalData_v1');
    if (raw) {
      const d = JSON.parse(raw);
      deviceId = d.deviceId;
      viewingDeviceId = d.viewingDeviceId;
      deviceName = d.deviceName;
    }
  } catch {}
  if (!deviceId) {
    try {
      const c = JSON.parse(localStorage.getItem('portalCreds') ?? '{}');
      deviceId = c.deviceId;
      deviceName = c.deviceName;
    } catch {}
  }
  // URL/key: env var 최우선 — Google OAuth 세션은 env var URL 기준으로 수립되므로
  // portalData_v1에 다른 URL이 저장돼 있어도 env var URL을 써야 RLS 통과 가능
  const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
  if (envUrl && envKey) return { supabaseUrl: envUrl, supabaseAnonKey: envKey, deviceId, viewingDeviceId, deviceName };
  // env var 미설정(로컬 개발) 시 localStorage URL/key 폴백
  try {
    const raw = localStorage.getItem('portalData_v1');
    if (raw) {
      const d = JSON.parse(raw);
      if (d.supabaseUrl && d.supabaseAnonKey) return d;
    }
  } catch {}
  try {
    const cached = localStorage.getItem('portalCreds');
    if (cached) return JSON.parse(cached);
  } catch {}
  return {};
};

function MemoAccordionItem({ portId, memo, onSave }: {
  portId: string;
  memo?: { content: string; updatedAt: string };
  onSave: (portId: string, content: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(memo?.content ?? '');
  React.useEffect(() => { setDraft(memo?.content ?? ''); }, [memo?.content]);
  return (
    <div className="border-t border-stone-800/60 mt-2" onClick={e => e.stopPropagation()}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center gap-1.5 w-full px-1 py-1.5 text-xs text-zinc-500 hover:text-[#f4f4f5]/90 transition-colors"
      >
        <StickyNote className="w-3 h-3" />
        <span>메모</span>
        {memo?.updatedAt && <span className="text-[#71717a] text-[10px] ml-1">{memo.updatedAt}</span>}
        {open ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
      </button>
      {open && (
        <div className="px-1 pb-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            rows={3}
            placeholder="이 포트에 대한 메모를 입력하세요..."
            className="w-full px-2 py-1.5 bg-[#18181b] border border-stone-700/50 rounded-lg text-xs text-[#f4f4f5]/90 placeholder:text-[#71717a] focus:outline-none focus:border-zinc-500 resize-y"
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-[#71717a]">{memo?.updatedAt ? `수정: ${memo.updatedAt}` : '저장된 메모 없음'}</span>
            <button
              onClick={e => { e.stopPropagation(); onSave(portId, draft); }}
              className="px-2.5 py-1 bg-blue-600/80 hover:bg-blue-600 text-white text-[10px] rounded-lg transition-colors"
            >저장</button>
          </div>
        </div>
      )}
    </div>
  );
}

// WSL 설치/설정 안내 모달
function WslSetupModal({ status, onClose, onInstallTmux, showToast }: {
  status: string;
  onClose: () => void;
  onInstallTmux: () => void;
  showToast: (message: string, type?: 'success' | 'error', duration?: number) => void;
}) {
  const Step = ({ n, text }: { n: number; text: React.ReactNode }) => (
    <li className="flex gap-2">
      <span className="shrink-0 w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center mt-0.5">{n}</span>
      <span className="text-zinc-400">{text}</span>
    </li>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-[#18181b] border border-stone-700/50 rounded-xl p-6 w-[460px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">
            {status === 'not_installed' ? '⚙️ WSL2 설치 필요' :
             status === 'no_distro'    ? '🐧 Ubuntu 설치 필요' :
             status === 'no_tmux'      ? '📦 tmux 설치 필요' : 'WSL2 설정'}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><XIcon size={16} /></button>
        </div>

        {status === 'not_installed' && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">Windows에서 tmux를 쓰려면 <strong className="text-[#f4f4f5]">WSL2 + Ubuntu</strong>가 필요합니다.</p>
            <ol className="text-xs space-y-2 list-none">
              <Step n={1} text={<>아래 버튼 클릭 → UAC 허용 → <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">wsl --install</code> 자동 실행</>} />
              <Step n={2} text="설치 완료 후 PC 재시작" />
              <Step n={3} text="Ubuntu 첫 실행 시 사용자명/비밀번호 설정" />
              <Step n={4} text={<>Ubuntu 터미널에서: <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">sudo apt install tmux</code></>} />
              <Step n={5} text={<>Claude Code 설치: <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">npm i -g @anthropic-ai/claude-code</code></>} />
            </ol>
            <button
              onClick={async () => { await API.installWsl().catch(e => showToast(`WSL 설치 실패: ${String(e)}`, 'error')); onClose(); }}
              className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors font-medium"
            >🚀 WSL2 + Ubuntu 설치 시작 (관리자 권한 필요)</button>
          </div>
        )}

        {status === 'no_distro' && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">WSL2 커널은 있지만 <strong className="text-[#f4f4f5]">Ubuntu가 없습니다</strong>. (Docker Desktop 전용 WSL만 감지됨)</p>
            <ol className="text-xs space-y-2 list-none">
              <Step n={1} text={<>아래 버튼 클릭 → UAC 허용 → <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">wsl --install -d Ubuntu</code> 실행</>} />
              <Step n={2} text="Ubuntu 첫 실행 시 사용자명/비밀번호 설정 완료" />
              <Step n={3} text={<>Ubuntu 터미널에서: <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">sudo apt install tmux</code></>} />
              <Step n={4} text={<>Claude Code 설치: <code className="text-[#f4f4f5]/90 bg-[#18181b] px-1 rounded">npm i -g @anthropic-ai/claude-code</code></>} />
            </ol>
            <button
              onClick={async () => { await API.installWsl().catch(e => showToast(`WSL 설치 실패: ${String(e)}`, 'error')); onClose(); }}
              className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors font-medium"
            >🐧 Ubuntu 설치 시작 (관리자 권한 필요)</button>
            <p className="text-[10px] text-[#71717a]">또는 PowerShell에서 직접: <code className="text-zinc-500">wsl --install -d Ubuntu</code></p>
          </div>
        )}

        {status === 'no_tmux' && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">WSL2 Ubuntu는 준비됐지만 <strong className="text-[#f4f4f5]">tmux가 없습니다</strong>. 자동 설치가 가능합니다.</p>
            <div className="bg-[#18181b] rounded-lg p-3 text-xs text-[#f4f4f5]/90 font-mono">sudo apt-get install -y tmux</div>
            <button
              onClick={() => { onInstallTmux(); onClose(); }}
              className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors font-medium"
            >📦 tmux 자동 설치</button>
            <p className="text-[10px] text-zinc-500">설치 후 다시 tmux 버튼을 누르면 됩니다. Claude Code도 WSL 안에 설치되어야 합니다: <code>npm i -g @anthropic-ai/claude-code</code></p>
            <button onClick={onClose} className="w-full px-3 py-2 bg-[#202024] hover:bg-zinc-600 text-white text-xs rounded-lg transition-colors">취소</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Click-to-edit single URL row used in the right-side detail panel. Empty rows still
// render as a clickable affordance so users can add a URL without opening the full form.
// `mobile` enlarges the touch target and uses fontSize 16 to prevent iOS Safari auto-zoom.
function InlineUrlRow({ label, value, onSave, placeholder, mobile = false, actionLabel, actionIcon, actionTestId, onAction }: {
  label: string;
  value?: string;
  onSave: (next: string) => void;
  placeholder: string;
  mobile?: boolean;
  actionLabel?: string;
  actionIcon?: React.ReactNode;
  actionTestId?: string;
  onAction?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if ((draft ?? '').trim() !== (value ?? '')) onSave(draft);
  };
  const cancel = () => { setDraft(value ?? ''); setEditing(false); };

  const rowPad = mobile ? '8px 0' : '0';
  const inputFont = mobile ? 16 : 12;
  const inputPad = mobile ? '8px 10px' : '2px 6px';

  const labelStyle = { color:'#3f3f46', minWidth:104, flexShrink:0 } as const;
  const valueStyle = { color:'#7ba7c9', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor:'text', flex:1 } as const;
  const emptyStyle = { color:'#3f3f46', cursor:'text', flex:1, fontStyle:'italic' } as const;

  if (editing) {
    return (
      <div style={{display:'flex',gap:10,alignItems:'center',padding:rowPad}}>
        <span style={labelStyle}>{label}</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); }}
          placeholder={placeholder}
          style={{flex:1,padding:inputPad,background:'#0a0a0b',border:'1px solid rgba(255,255,255,0.18)',borderRadius:4,color:'#f4f4f5',fontSize:inputFont,fontFamily:'inherit'}}
        />
      </div>
    );
  }
  return (
    <div className="meta-editable-row" style={{display:'flex',gap:10,alignItems:'center',padding:rowPad,cursor:'text'}} onClick={() => setEditing(true)} title="클릭하여 수정">
      <span style={labelStyle}>{label}</span>
      {value
        ? <span style={valueStyle}>{value}</span>
        : <span style={emptyStyle}>+ {placeholder}</span>}
      {value && onAction && actionLabel && (
        <button
          type="button"
          data-testid={actionTestId}
          onClick={event => {
            event.stopPropagation();
            onAction();
          }}
          title={actionLabel}
          style={{padding:'2px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}
        >
          {actionIcon}{actionLabel}
        </button>
      )}
    </div>
  );
}

// GitHub is a repository collection rather than a single link. Keep each
// repository in its own field so an address can be opened, corrected, or
// removed without making a multi-line value ambiguous.
function GitHubUrlsRow({ value, onSave, mobile = false, onOpen }: {
  value: string;
  onSave: (next: string) => void;
  mobile?: boolean;
  onOpen: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // `value` is one repository per line, so it has to be parsed as text.
  const urls = parseGitHubRepositoryUrls(value);
  const [draftUrls, setDraftUrls] = useState<string[]>(() => githubRepositoryUrlRows(value));

  useEffect(() => {
    if (!editing) setDraftUrls(githubRepositoryUrlRows(value));
  }, [value, editing]);

  const commit = () => {
    const next = parseGitHubRepositoryUrls(githubRepositoryUrlRowsText(draftUrls)).join('\n');
    setEditing(false);
    if (next !== parseGitHubRepositoryUrls(value).join('\n')) {
      onSave(next);
    }
  };
  const cancel = () => { setDraftUrls(githubRepositoryUrlRows(value)); setEditing(false); };
  const rowPad = mobile ? '8px 0' : '0';

  if (editing) {
    return (
      <div style={{display:'flex',gap:10,alignItems:'flex-start',padding:rowPad}}>
        <span style={{color:'#3f3f46',minWidth:104,flexShrink:0,paddingTop:4}}>github</span>
        <div style={{display:'flex',flex:1,flexDirection:'column',gap:5,minWidth:0}}>
          {draftUrls.map((url, index) => {
            const openUrl = normalizeGitHubRepositoryUrl(url);
            return (
              <div key={index} style={{display:'flex',gap:5,minWidth:0}}>
                <input
                  autoFocus={index === 0}
                  value={url}
                  onChange={event => setDraftUrls(current => replaceGitHubRepositoryUrlRow(current, index, event.target.value))}
                  onKeyDown={event => { if (event.key === 'Escape') cancel(); }}
                  placeholder="https://github.com/owner/repository"
                  aria-label={`GitHub 저장소 주소 ${index + 1}`}
                  style={{flex:1,minWidth:0,padding:mobile?'8px 10px':'4px 6px',background:'#0a0a0b',border:'1px solid rgba(255,255,255,0.18)',borderRadius:4,color:'#f4f4f5',fontSize:mobile?16:12,fontFamily:'inherit'}}
                />
                <button
                  type="button"
                  disabled={!openUrl}
                  onClick={() => { if (openUrl) onOpen(openUrl); }}
                  title={openUrl ? `GitHub ${index + 1} 열기` : 'GitHub 저장소 주소를 입력하세요'}
                  style={{padding:'2px 7px',border:'1px solid rgba(123,167,201,0.32)',borderRadius:4,background:'rgba(123,167,201,0.08)',color:'#7ba7c9',cursor:openUrl?'pointer':'not-allowed',opacity:openUrl?1:0.45,fontSize:10,fontFamily:'inherit',whiteSpace:'nowrap'}}
                >
                  열기
                </button>
                <button
                  type="button"
                  disabled={draftUrls.length === 1}
                  onClick={() => setDraftUrls(current => removeGitHubRepositoryUrlRow(current, index))}
                  title="이 GitHub 주소 삭제"
                  style={{padding:'2px 7px',border:'1px solid rgba(248,113,113,0.25)',borderRadius:4,background:'rgba(248,113,113,0.06)',color:'#fca5a5',cursor:draftUrls.length === 1?'not-allowed':'pointer',opacity:draftUrls.length === 1?0.4:1,fontSize:10,fontFamily:'inherit'}}
                >
                  삭제
                </button>
              </div>
            );
          })}
          <div style={{display:'flex',gap:5}}>
            <button type="button" data-testid="github-url-row-add-field" onClick={() => setDraftUrls(current => appendBlankGitHubRepositoryUrlRow(current))} style={{padding:'3px 7px',border:'1px solid rgba(255,255,255,0.14)',borderRadius:4,background:'rgba(255,255,255,0.025)',color:'#d4d4d8',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>+ 주소 추가</button>
            <button type="button" onClick={commit} style={{padding:'3px 7px',border:0,borderRadius:4,background:'rgba(74,222,128,0.16)',color:'#86efac',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>저장</button>
            <button type="button" onClick={cancel} style={{padding:'3px 7px',border:'1px solid rgba(255,255,255,0.12)',borderRadius:4,background:'transparent',color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>취소</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="meta-editable-row" style={{display:'flex',gap:10,alignItems:'flex-start',padding:rowPad,cursor:'text'}} onClick={() => setEditing(true)} title="GitHub 저장소 주소를 각각 편집">
      <span style={{color:'#3f3f46',minWidth:104,flexShrink:0,paddingTop:2}}>github</span>
      <div style={{display:'flex',flex:1,gap:4,flexWrap:'wrap',alignItems:'center'}}>
        {urls.length > 0 ? (
          <>
          {urls.map((url, index) => {
            const label = urls.length === 1 ? 'GitHub 열기' : `GitHub ${index + 1} 열기`;
            return (
              <button
                key={url}
                type="button"
                data-testid={index === 0 ? 'meta-open-github' : `meta-open-github-${index + 1}`}
                onClick={event => { event.stopPropagation(); onOpen(url); }}
                title={url}
                style={{padding:'2px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#7ba7c9',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap'}}
              >
                <Github style={{width:10,height:10}}/>{label}
              </button>
            );
          })}
          </>
        ) : <span style={{color:'#3f3f46',fontStyle:'italic'}}>저장소 주소 없음</span>}
        <button
          type="button"
          data-testid="meta-add-github-url"
          onClick={event => { event.stopPropagation(); setEditing(true); }}
          title="GitHub 저장소 주소를 추가하거나 관리"
          style={{padding:'2px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit',whiteSpace:'nowrap'}}
        >
          + GitHub 주소 추가
        </button>
      </div>
    </div>
  );
}

function GitHubRepositoryCreateControl({ project, onCreated, onToast, mobile = false }: {
  project: PortInfo;
  onCreated: (url: string) => void;
  onToast: (message: string, type: 'success' | 'error' | 'warning') => void;
  mobile?: boolean;
}) {
  const [visibility, setVisibility] = useState<GitHubRepositoryVisibility>('private');
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivePrivateMemory, setArchivePrivateMemory] = useState(false);
  const folderName = project.folderPath?.split(/[\\/]/).filter(Boolean).pop();
  const repositoryName = githubRepositoryNameFromProject({ projectName: project.name, folderName, projectId: project.id });
  const chooseVisibility = (next: GitHubRepositoryVisibility) => {
    setVisibility(next);
    if (next !== 'private') setArchivePrivateMemory(false);
    setConfirming(false);
  };
  const create = async () => {
    setCreating(true);
    try {
      const repository = await API.createGitHubRepository(project.id, visibility);
      onCreated(repository.repositoryUrl);
      let archiveWarning = '';
      let archiveEnabled = false;
      if (visibility === 'private' && archivePrivateMemory && project.folderPath) {
        try {
          const { projectMemoryApi } = await import('./ProjectMemoryPanel');
          const archived = await projectMemoryApi.enablePrivateGitHubArchive({
            folderPath: project.folderPath,
            githubUrl: repository.repositoryUrl,
          });
          archiveEnabled = archived.enabled === true;
        } catch (error) {
          archiveWarning = error instanceof Error ? error.message : String(error);
        }
      }
      if (repository.warning || archiveWarning) {
        onToast([
          repository.warning,
          archiveWarning ? `저장소는 만들었지만 장기기억 보관은 켜지지 않았습니다: ${archiveWarning}` : '',
        ].filter(Boolean).join(' '), 'warning');
      } else {
        onToast(
          `${repository.repositoryName} ${visibility === 'private' ? '비공개' : '공개'} 저장소를 만들고 push했습니다.${archiveEnabled ? ' Private GitHub 장기기억 보관도 켰습니다.' : ''}`,
          'success',
        );
      }
      setConfirming(false);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setCreating(false);
    }
  };
  return (
    <div data-testid="github-repository-create-control" style={{margin:'5px 0 7px',padding:mobile?'10px':'8px 10px',border:'1px solid rgba(94,234,212,0.16)',borderRadius:7,background:'rgba(94,234,212,0.025)'}}>
      <div style={{display:'flex',gap:8,alignItems:mobile?'stretch':'center',flexDirection:mobile?'column':'row',flexWrap:'wrap'}}>
        <span style={{color:'#71717a',minWidth:94,fontSize:10}}>GitHub 새 저장소</span>
        <code data-testid="github-repository-derived-name" style={{color:'#d4d4d8',fontSize:10,overflowWrap:'anywhere'}}>{repositoryName}</code>
        <div role="group" aria-label="GitHub 저장소 공개 범위" style={{display:'flex',gap:4,marginLeft:mobile?0:'auto'}}>
          {(['private', 'public'] as const).map(option => (
            <button key={option} type="button" data-testid={`github-visibility-${option}`} aria-pressed={visibility === option} onClick={() => chooseVisibility(option)} style={{padding:'5px 9px',borderRadius:5,border:`1px solid ${visibility === option ? 'rgba(94,234,212,0.42)' : 'rgba(255,255,255,0.1)'}`,background:visibility === option?'rgba(94,234,212,0.11)':'transparent',color:visibility === option?'#99f6e4':'#71717a',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>
              {option === 'private' ? <><Lock style={{width:10,height:10,display:'inline',marginRight:4}}/>Private</> : <><Globe style={{width:10,height:10,display:'inline',marginRight:4}}/>Public</>}
            </button>
          ))}
        </div>
        {!confirming && <button type="button" data-testid="github-create-review" onClick={() => setConfirming(true)} style={{padding:'5px 9px',border:'1px solid rgba(94,234,212,0.28)',borderRadius:5,background:'rgba(94,234,212,0.08)',color:'#5eead4',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>만들기 확인</button>}
      </div>
      <div style={{fontSize:9,color:'#52525b',marginTop:5}}>등록된 이 폴더의 커밋 이력만 origin으로 push합니다. 미커밋 파일은 포함하지 않습니다.</div>
      {visibility === 'private' && project.folderPath && (
        <label data-testid="github-private-memory-archive-option" style={{display:'flex',alignItems:'flex-start',gap:6,marginTop:6,color:'#71717a',fontSize:9,lineHeight:1.45,cursor:'pointer'}}>
          <input
            type="checkbox"
            checked={archivePrivateMemory}
            onChange={event => { setArchivePrivateMemory(event.target.checked); setConfirming(false); }}
            style={{marginTop:1,accentColor:'#5eead4'}}
          />
          <span>생성 후 이 프로젝트의 검증된 장기기억도 전용 Private branch에 재해복구용으로 보관 (Private 협업자·계정 접근자는 열람 가능)</span>
        </label>
      )}
      {visibility === 'public' && <div role="alert" style={{fontSize:9,color:'#fbbf24',marginTop:4}}>Public은 인터넷에 공개됩니다. 공개해도 되는 코드인지 확인하세요.</div>}
      {confirming && (
        <div data-testid="github-create-confirmation" style={{display:'flex',gap:5,alignItems:'center',marginTop:7,flexWrap:'wrap'}}>
          <span style={{fontSize:10,color:'#a1a1aa'}}>{visibility === 'private' ? '비공개' : '공개'} 저장소를 실제로 만들까요?</span>
          <button type="button" data-testid="github-create-submit" disabled={creating} onClick={() => void create()} style={{padding:'5px 9px',border:0,borderRadius:5,background:visibility==='public'?'rgba(251,191,36,0.18)':'rgba(74,222,128,0.16)',color:visibility==='public'?'#fbbf24':'#86efac',cursor:creating?'wait':'pointer',fontSize:10,fontFamily:'inherit'}}>{creating?'생성·push 중…':`${visibility === 'private'?'Private':'Public'} 생성·push`}</button>
          <button type="button" disabled={creating} onClick={() => setConfirming(false)} style={{padding:'5px 9px',border:'1px solid rgba(255,255,255,0.1)',borderRadius:5,background:'transparent',color:'#71717a',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>취소</button>
        </div>
      )}
    </div>
  );
}

/**
 * 인라인 편집이 안 되는 메타 행(folder·command·terminal·manual·log file).
 *
 * VOC로 들어온 지적: "어디는 클릭하여 수정이 되고 어디는 안되는데, 같은 영역이니까
 * 일관성이 필요하지않을까?" — 실제로 같은 블록 안에서 deploy·github·메모·별명·카테고리는
 * 행 전체가 클릭 편집인데 이 다섯 행만 평범한 `div`라 아무 반응이 없었고, 무엇이 눌리는지
 * 알려 주는 단서도 없었다.
 *
 * 경로류는 검증이 필요해 인라인 편집으로 만들 수 없다. 대신 **클릭하면 수정 폼을 연다** —
 * "메타 영역은 클릭하면 고칠 수 있다"는 규칙 하나로 통일된다.
 */
function MetaEditableRow({ label, value, onEdit, action, testId }: {
  label: string;
  value: string;
  onEdit: () => void;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      onClick={onEdit}
      title={`${label} 수정하기`}
      className="meta-editable-row"
      style={{display:'flex',gap:10,alignItems:'center',cursor:'text',borderRadius:4}}
    >
      <span style={{color:'#3f3f46',minWidth:104,flexShrink:0}}>{label}</span>
      <span style={{color:'#a1a1aa',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}}>{value}</span>
      {action}
    </div>
  );
}

/** Controlled multi-repository fields for project create/edit forms. */
function GitHubUrlInputs({ value, onChange, onOpen, inputStyle, onKeyDown }: {
  value: string;
  onChange: (next: string) => void;
  onOpen: (url: string) => void;
  inputStyle: React.CSSProperties;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  // A blank row is not representable in `value`, so the rows live here. Deriving
  // them from `value` on every render made "+ GitHub 주소 추가" look inert: the new
  // empty row was dropped by the parse before it could ever be typed into.
  const [fields, setFields] = useState<string[]>(() => githubRepositoryUrlRows(value));

  useEffect(() => {
    setFields(current => (shouldAdoptGitHubRepositoryUrlValue(value, current) ? githubRepositoryUrlRows(value) : current));
  }, [value]);

  const update = (next: string[]) => {
    setFields(next);
    onChange(githubRepositoryUrlRowsText(next));
  };

  return (
    <div style={{display:'flex',flex:1,minWidth:0,flexDirection:'column',gap:5,width:'100%'}}>
      {fields.map((url, index) => {
        const openUrl = normalizeGitHubRepositoryUrl(url);
        return (
          <div key={index} style={{display:'flex',gap:6,minWidth:0}}>
            <input
              type="url"
              value={url}
              onChange={event => update(replaceGitHubRepositoryUrlRow(fields, index, event.target.value))}
              onKeyDown={onKeyDown}
              aria-label={`GitHub 저장소 주소 ${index + 1}`}
              placeholder="https://github.com/owner/repository"
              style={{...inputStyle,flex:1,minWidth:0}}
            />
            <button
              type="button"
              disabled={!openUrl}
              onClick={() => { if (openUrl) onOpen(openUrl); }}
              title={openUrl ? `GitHub ${index + 1} 열기` : 'GitHub 저장소 주소를 입력하세요'}
              style={{padding:'0 9px',background:'rgba(123,167,201,0.08)',border:'1px solid rgba(123,167,201,0.25)',borderRadius:6,color:'#93c5fd',cursor:openUrl?'pointer':'not-allowed',fontSize:10,fontFamily:'inherit',whiteSpace:'nowrap',opacity:openUrl?1:0.45}}
            >
              열기
            </button>
            <button
              type="button"
              disabled={fields.length === 1}
              onClick={() => update(removeGitHubRepositoryUrlRow(fields, index))}
              title="이 GitHub 주소 삭제"
              style={{padding:'0 8px',background:'rgba(248,113,113,0.06)',border:'1px solid rgba(248,113,113,0.22)',borderRadius:6,color:'#fca5a5',cursor:fields.length === 1?'not-allowed':'pointer',fontSize:10,fontFamily:'inherit',opacity:fields.length === 1?0.4:1}}
            >
              삭제
            </button>
          </div>
        );
      })}
      <button
        type="button"
        data-testid="github-url-add-field"
        onClick={() => update(appendBlankGitHubRepositoryUrlRow(fields))}
        style={{alignSelf:'flex-start',padding:'3px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.14)',borderRadius:5,color:'#d4d4d8',cursor:'pointer',fontSize:10,fontFamily:'inherit'}}
      >
        + GitHub 주소 추가
      </button>
    </div>
  );
}

function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiServerOnline, setApiServerOnline] = useState<boolean | null>(null);
  const hasInitiallyLoaded = useRef(false);
  const hasWorkspaceRootsLoaded = useRef(false);
  const skipNextSave = useRef(false); // 서버 리로드(focus 등)로 인한 불필요한 덮어쓰기 방지
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [commandPath, setCommandPath] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [deployUrl, setDeployUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [activeTab, setActiveTab] = useState<'ports' | 'portal' | 'memory'>('ports');
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('portmanager-lang') as Lang) ?? 'ko');
  useEffect(() => { document.title = t(lang, 'appName'); }, [lang]);

  // Windows에서 macOS 전용 terminalApp이 저장된 경우 자동 수정 (HMR 후에도 동작)
  useEffect(() => {
    if (!isWindows()) return;
    const macOnly: TerminalApp[] = ['cmux', 'iterm', 'terminal'];
    if (macOnly.includes(terminalApp)) {
      setTerminalApp('powershell');
      localStorage.setItem('portmanager-terminalApp', 'powershell');
    }
  }, []);

  // 어떤 AI의 실행 버튼을 띄울지는 사용자가 고른다(기기별). 설치 여부로 자동 판정하지
  // 않는 이유는 launchAgentVisibility.ts 주석에 있다 — 숨김은 선택, 미설치는 안내다.
  const [hiddenAgents, setHiddenAgents] = useState<Set<LaunchAgent>>(() => {
    if (typeof window === 'undefined') return new Set();
    return parseHiddenLaunchAgents(localStorage.getItem(HIDDEN_LAUNCH_AGENTS_STORAGE_KEY));
  });
  const [agentVisibilityOpen, setAgentVisibilityOpen] = useState(false);
  const agentShown = (agent: LaunchAgent) => !hiddenAgents.has(agent);
  const toggleAgentShown = (agent: LaunchAgent) => {
    setHiddenAgents(prev => {
      const next = toggleHiddenLaunchAgent(prev, agent);
      try { localStorage.setItem(HIDDEN_LAUNCH_AGENTS_STORAGE_KEY, serializeHiddenLaunchAgents(next)); } catch { /* 저장 실패는 이번 세션에만 영향 */ }
      return next;
    });
  };

  // Hermes 버튼은 **숨기지 않는다.** 버튼이 말없이 사라지면 사용자는 왜 없어졌는지 알 수
  // 없고, 기능 자체가 없는 앱처럼 보인다. 대신 눌렀을 때 미설치를 즉시 말한다.
  //   null = 아직 모름 → 서버에 요청해 보고 서버 판정(409)에 맡긴다.
  // 설정 폴더(`~/.hermes`)는 이 앱의 어댑터 설치기가 직접 만들기도 해서 설치 증거가 아니다.
  const [hermesCliAvailable, setHermesCliAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (isDeployedWeb()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/project-memory/hermes-adapter`);
        if (!res.ok) return;
        const availability = hermesCliAvailabilityFromStatus(await res.json());
        // null = 판단 불가(예: `hermesCliPath`를 모르는 옛 sidecar). 「모름」에 그대로 두어
        // 버튼을 막지 않는다 — 없는 필드를 미설치로 읽어 멀쩡한 기기를 막은 적이 있다.
        if (!cancelled && availability !== null) setHermesCliAvailable(availability);
      } catch { /* 조회 실패는 "모름"으로 남긴다 — 버튼을 지우지 않는다 */ }
    })();
    return () => { cancelled = true; };
  }, []);
  /**
   * 미설치가 확인된 경우에만 즉시 안내하고 실행을 멈춘다.
   * 아직 모르는 상태(null)에서는 막지 않는다 — 조회 실패로 멀쩡한 실행을 막는 쪽이 더 나쁘고,
   * 그때는 서버가 409로 같은 사실을 알려준다.
   */
  const blockedByMissingHermes = (): boolean => {
    if (hermesCliAvailable !== false) return false;
    showToast('Hermes가 이 기기에 설치되어 있지 않습니다. 설치한 뒤 다시 눌러 주세요.', 'error');
    return true;
  };

  const [openPortalSettings, setOpenPortalSettings] = useState(false);
  // 포털을 처음 열기 전에는 무거운 포털 코드를 요청하지 않는다. 한 번 로드된 뒤에는
  // 탭 전환 중에도 내부 선택·설정 상태를 유지한다.
  const [portalHasMounted, setPortalHasMounted] = useState(false);
  useEffect(() => {
    if (activeTab === 'portal' || openPortalSettings) setPortalHasMounted(true);
  }, [activeTab, openPortalSettings]);
  const [memoryPortalCredentials, setMemoryPortalCredentials] = useState<{ url: string; key: string; deviceName?: string; deviceId?: string } | null>(null);
  const [memoryPortalCredentialsLoading, setMemoryPortalCredentialsLoading] = useState(false);
  const refreshMemoryPortalCredentials = useCallback(async () => {
    setMemoryPortalCredentialsLoading(true);
    try {
      const config = isTauri()
        ? await invoke<any>('load_portal')
        : await getPortalCredentials();
      const url = typeof config?.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
      const key = typeof config?.supabaseAnonKey === 'string' ? config.supabaseAnonKey.trim() : '';
      setMemoryPortalCredentials(url && key ? { url, key, deviceId: typeof config?.deviceId === 'string' ? config.deviceId.trim() : undefined, deviceName: typeof config?.deviceName === 'string' ? config.deviceName.trim() : undefined } : null);
      return config;
    } catch {
      setMemoryPortalCredentials(null);
      return null;
    } finally {
      setMemoryPortalCredentialsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (activeTab === 'memory') void refreshMemoryPortalCredentials();
  }, [activeTab, refreshMemoryPortalCredentials]);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const hasCheckedFirstRunSetup = useRef(false);
  const [showAiUsage, setShowAiUsage] = useState(false);
  const [guideMode, setGuideMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pm-guide-mode') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('pm-guide-mode', guideMode ? '1' : '0');
  }, [guideMode]);

  // 개선 요청(VOC) 모드. 세션 한정이라 저장하지 않는다 — 켠 채로 앱을 다시 열면
  // 클릭이 전부 막혀 있어 고장으로 읽힌다.
  const [vocMode, setVocMode] = useState(false);
  const [vocAppBlock, setVocAppBlock] = useState<{ expiresAt?: string } | null>(null);
  const [vocRemoteUnlimited, setVocRemoteUnlimited] = useState(false);
  const refreshVocAccess = useCallback(async () => {
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc/access`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      // 네트워크 오류나 unverified 응답은 정상 사용자를 잠그지 않는다.
      setVocAppBlock(res.ok && data.blocked === true && data.scope === 'app'
        ? { expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined }
        : null);
      setVocRemoteUnlimited(res.ok && data.unlimited === true && data.identity === 'receiver_admin');
    } catch {
      setVocAppBlock(null);
      setVocRemoteUnlimited(false);
    }
  }, []);
  useEffect(() => {
    void refreshVocAccess();
    const timer = window.setInterval(() => void refreshVocAccess(), 30 * 60 * 1000);
    const onFocus = () => void refreshVocAccess();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshVocAccess]);
  /** 정리 검토에서 삭제 확인이 열린 행. 되돌릴 수 없는 동작이라 한 번 더 묻는다. */
  const [cleanupConfirmId, setCleanupConfirmId] = useState<string | null>(null);
  const [showMemoryArchive, setShowMemoryArchive] = useState(false);
  /**
   * "오래된 프로젝트" 기준 일수. 사람마다 프로젝트 회전 속도가 달라 30일 고정은 누군가에게는
   * 너무 이르고 누군가에게는 너무 늦다. 기기별 설정이라 동기화하지 않는다.
   * 1일 미만이나 비정상 값은 기본값으로 되돌린다 — 0이면 전부 "오래됨"이 되어 정리 검토가
   * 통째로 위험해진다.
   */
  const [staleDays, setStaleDays] = useState<number>(() => {
    if (typeof window === 'undefined') return 30;
    const raw = Number(localStorage.getItem('portmanager-stale-days'));
    return Number.isFinite(raw) && raw >= 1 && raw <= 3650 ? Math.floor(raw) : 30;
  });
  const applyStaleDays = (value: number) => {
    const next = Number.isFinite(value) && value >= 1 && value <= 3650 ? Math.floor(value) : 30;
    setStaleDays(next);
    try { localStorage.setItem('portmanager-stale-days', String(next)); } catch { /* 이번 세션만 적용 */ }
  };

  /**
   * ⌘/Ctrl+Shift+V — 모달이 떠 있어도 VOC를 켤 수 있는 유일한 길.
   *
   * 헤더 버튼은 모달(z 9500)에 덮여 눌리지 않는다. 그래서 "정리 검토" 같은 팝업 안의
   * 불편은 정작 코멘트를 남길 수 없었다 — 오버레이 자체는 모달보다 위(z 2^31 근처)라
   * **켜지기만 하면** 모달 내용도 정상적으로 집힌다. 막힌 것은 켜는 방법뿐이었다.
   *
   * capture 단계에서 받아 모달의 키 핸들러보다 먼저 처리한다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== 'v') return;
      e.preventDefault();
      e.stopPropagation();
      setVocMode(v => !v);
      setGuideMode(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const submitVoc = useCallback(async (input: { anchor: unknown; comment: string; sendRemote: boolean }) => {
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/voc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, tab: activeTab, appVersion: `v${BUILD_INFO.buildNumber} ${BUILD_INFO.version}`.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || '저장 실패');
      const delivery = data.delivery ?? {};
      if (delivery.status === 'sent') {
        showToast(delivery.unlimited === true
          ? '관리자 VOC로 전송했습니다 · 한도 없음'
          : `개선 요청을 전송했습니다 · 오늘 ${delivery.remaining}회 남음`, 'success');
      } else if (delivery.status === 'rate_limited') {
        showToast(`로컬에 저장했습니다 · 이 단말의 오늘 전송 한도 ${delivery.dailyLimit}회를 모두 사용했습니다`, 'success');
      } else if (delivery.status === 'disabled') {
        showToast('로컬에 저장했습니다 · 현재 개발자 VOC 접수가 일시 중지되어 있습니다', 'success');
      } else if (delivery.status === 'blocked') {
        showToast('로컬에 저장했습니다 · 이 설치본의 개발자 전송이 제한되어 있습니다', 'error');
      } else if (delivery.status === 'failed') {
        showToast('로컬에 저장했습니다 · 개발자 전송은 네트워크 문제로 실패했습니다', 'error');
      } else {
        showToast('개선 요청을 로컬에 저장했습니다', 'success');
      }
      return true;
    } catch (e) {
      showToast(`개선 요청 저장 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return false;
    }
  }, [activeTab]);
  const [wslSetupStatus, setWslSetupStatus] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteRootConfirmId, setDeleteRootConfirmId] = useState<string | null>(null);
  const [memos, setMemos] = useState<Record<string, { content: string; updatedAt: string }>>(() => {
    // localStorage 미러에서 복원 (Supabase 없이도 재시작 후 메모 유지)
    try { return JSON.parse(localStorage.getItem('portmanager-memos') || '{}'); } catch { return {}; }
  });
  const memosRef = useRef(memos);
  useEffect(() => {
    memosRef.current = memos;
    try { localStorage.setItem('portmanager-memos', JSON.stringify(memos)); } catch {}
  }, [memos]);
  const [sortBy, setSortBy] = useState<SortType>(
    () => (localStorage.getItem('portmanager-sortBy') as SortType) || 'recent'
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(
    () => (localStorage.getItem('portmanager-sortOrder') as 'asc' | 'desc') || 'desc'
  );
  // 사이드바 「고정」 그룹의 수동 순서. 이 기기에만 남는다 — src/pinnedOrder.ts 주석 참고.
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(
    () => { try { return readPinnedOrder(localStorage.getItem(PINNED_ORDER_STORAGE_KEY)); } catch { return []; } }
  );
  const [draggingPinnedId, setDraggingPinnedId] = useState<string | null>(null);
  const [pinnedDropTargetId, setPinnedDropTargetId] = useState<string | null>(null);
  // 포인터 드래그 진행 상태. 렌더에 쓰이지 않으므로 ref다 — pointermove마다 setState하면
  // 사이드바 전체가 다시 그려진다.
  const pinnedDragRef = useRef<{
    id: string; startY: number; startX: number; pointerId: number;
    rows: { id: string; top: number; bottom: number }[]; active: boolean;
  } | null>(null);
  // 드래그로 끝난 pointerup 뒤에도 click은 그대로 온다. 그걸 선택으로 처리하면 순서만
  // 바꾸려던 드래그가 프로젝트 선택까지 바꿔버린다.
  const pinnedDragConsumedClickRef = useRef(false);
  const [filterType, setFilterType] = useState<'all' | 'with-port' | 'without-port'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [folderRenamePromptTargetId, setFolderRenamePromptTargetId] = useState<string | null>(null);
  const [folderRenameInput, setFolderRenameInput] = useState('');
  const [buzzProjectTarget, setBuzzProjectTarget] = useState<{ portId: string; projectName: string } | null>(null);
  const [buzzUseSetupTarget, setBuzzUseSetupTarget] = useState<{ portId: string; projectName: string } | null>(null);
  const [terminalApp, setTerminalApp] = useState<TerminalApp>(
    () => {
      const saved = localStorage.getItem('portmanager-terminalApp') as TerminalApp | null;
      if (saved) return saved;
      return isWindows() ? 'powershell' : 'cmux';
    }
  );
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [deploymentBrowserProfileId, setDeploymentBrowserProfileId] = useState(() =>
    localStorage.getItem(DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY) ?? '',
  );
  const selectedDeploymentBrowserProfile = useMemo(
    () => resolveSavedBrowserProfile(browserProfiles, deploymentBrowserProfileId),
    [browserProfiles, deploymentBrowserProfileId],
  );
  useEffect(() => {
    if (isDeployedWeb()) return;
    let cancelled = false;
    void API.listBrowserProfiles()
      .then(profiles => {
        if (cancelled) return;
        setBrowserProfiles(profiles);
        setDeploymentBrowserProfileId(current => {
          if (!current || resolveSavedBrowserProfile(profiles, current)) return current;
          localStorage.removeItem(DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY);
          return '';
        });
      })
      .catch(error => {
        console.warn('[BrowserProfile] Chrome 프로필 조회 실패:', error);
      });
    return () => { cancelled = true; };
  }, []);
  const [orcaLaunchMode, setOrcaLaunchMode] = useState<OrcaLaunchMode>(() =>
    localStorage.getItem('portmanager-orcaLaunchMode') === 'worktree' ? 'worktree' : 'floating'
  );
  const initialTerminalDefaults = terminalOptionDefaults(terminalApp, orcaLaunchMode);
  // 권한 우회는 저장하지 않고 터미널별 기본값으로 매 앱 세션을 시작한다.
  const [bypassPermissions, setBypassPermissions] = useState(
    initialTerminalDefaults.bypassPermissions,
  );
  const [bgMode, setBgMode] = useState(() => {
    const version = localStorage.getItem('portmanager-terminalDefaultsVersion');
    if (version === TERMINAL_DEFAULTS_VERSION) {
      const saved = localStorage.getItem('portmanager-bgMode');
      if (saved !== null) return saved === 'true';
    }
    // 과거 버전은 터미널 전환 때 bgMode=false를 자동 저장했으므로, 사용자의 명시적
    // 선택과 구분할 수 없다. 정책 버전이 바뀔 때 한 번 새 기본값으로 마이그레이션한다.
    localStorage.setItem('portmanager-terminalDefaultsVersion', TERMINAL_DEFAULTS_VERSION);
    localStorage.setItem('portmanager-bgMode', String(initialTerminalDefaults.bgMode));
    return initialTerminalDefaults.bgMode;
  });
  const [tmuxMode, setTmuxMode] = useState(() => {
    const version = localStorage.getItem('portmanager-terminalDefaultsVersion');
    if (version === TERMINAL_DEFAULTS_VERSION) {
      const saved = localStorage.getItem('portmanager-tmuxMode');
      if (saved !== null) return saved === 'true';
    }
    localStorage.setItem('portmanager-tmuxMode', String(initialTerminalDefaults.tmuxMode));
    return initialTerminalDefaults.tmuxMode;
  });
  // `--bg` is meaningful only on a surface that can immediately show its Agent View.
  // Orca Floating qualifies; an Orca worktree terminal remains an interactive session.
  const claudeBgActive = bgMode && isClaudeBgAvailable(terminalApp, orcaLaunchMode);
  const orcaFloatingReuseActive = terminalApp === 'orca' && orcaLaunchMode === 'floating';
  // 기존 창 재사용 여부는 에이전트가 아니라 터미널 표면의 성질이다 — 세 에이전트 버튼이
  // 같은 판정을 공유해야 "실행/새창"이 Claude 전용 기능처럼 보이지 않는다.
  const agentLaunchPolicy = describeAgentLaunchPolicy({ terminalApp, orcaLaunchMode, tmuxMode });
  const selectedTerminalSurface = terminalApp === 'orca'
    ? `Orca ${orcaLaunchMode === 'floating' ? '플로팅' : '워크트리 내부'}`
    : terminalApp === 'iterm'
      ? 'iTerm'
      : terminalApp === 'terminal'
        ? 'Terminal'
        : terminalApp;
  const [globalShortcut, setGlobalShortcut] = useState('CommandOrControl+Alt+P');
  const [showShortcutModal, setShowShortcutModal] = useState(false);
  const [shortcutInput, setShortcutInput] = useState('');
  // Voice starts are verified from ChatGPT's local rollout metadata. A fresh
  // Voice can still be unbound from this folder, so failures and pending moves
  // get a compact recovery surface rather than being reported as success.
  const [projectVoiceGuide, setProjectVoiceGuide] = useState<{
    targetName: string;
    folderPath: string;
    stage: 'start-failed' | 'recovery';
    error?: string;
    errorCode?: string;
    dispatch?: 'not-attempted' | 'button-pressed' | 'global-button-pressed';
  } | null>(null);
  const [projectVoiceStartPending, setProjectVoiceStartPending] = useState(false);
  const [showCleanupReview, setShowCleanupReview] = useState(false);
  /**
   * Supabase에만 남은 포트 행(고아) 점검.
   *
   * ⚠️ "내 로컬 목록에 없다"는 것만으로 쓰레기가 아니다 — 다른 기기가 소유한 행은 그
   * 기기에서 멀쩡히 쓰이고 있다. 그래서 **소유자별로 갈라서** 보여 주고, 확실히 회수
   * 불가한 것(내 기기 소유인데 로컬에 없음 / device_id 없음 / 등록되지 않은 기기)만
   * 기본 정리 대상으로 제시한다. 다른 기기 소유는 개수와 기기명을 밝히고 따로 둔다.
   *
   * 이 화면이 필요한 이유: 로컬에서 포트를 지우면 id가 사라져 다음 push의 stale-delete
   * 대상도 되지 못한다. 실측(2026-08-13) 150행 중 138행이 그렇게 회수 불가 상태였다.
   */
  type OrphanGroup = { key: string; label: string; rows: Array<{ id: string; name: string }>; reclaimable: boolean };
  const [orphanGroups, setOrphanGroups] = useState<OrphanGroup[] | null>(null);
  const [orphanBusy, setOrphanBusy] = useState<string | null>(null);
  const [orphanError, setOrphanError] = useState<string | null>(null);

  const scanSupabaseOrphans = useCallback(async () => {
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      setOrphanError('Supabase 설정이 없습니다.');
      setOrphanGroups([]);
      return;
    }
    setOrphanError(null);
    setOrphanBusy('scan');
    try {
      const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const [{ data: rows, error }, { data: devices }] = await Promise.all([
        supabase.from('portmgr_ports').select('id,name,device_id'),
        supabase.from('portmgr_devices').select('id,name'),
      ]);
      if (error) throw new Error(describeSupabaseError(error));
      const localIds = new Set(portsRef.current.map(p => p.id));
      const deviceNames = new Map((devices ?? []).map((d: any) => [d.id, d.name as string]));
      const myId = cfg.deviceId ?? null;
      const buckets = new Map<string, OrphanGroup>();
      for (const row of (rows ?? []) as Array<{ id: string; name: string; device_id: string | null }>) {
        if (localIds.has(row.id)) continue;   // 로컬에 있으면 고아가 아니다
        const owner = row.device_id ?? null;
        let key: string; let label: string; let reclaimable: boolean;
        if (owner && myId && owner === myId) {
          key = 'mine'; label = '이 기기 소유인데 로컬에 없음'; reclaimable = true;
        } else if (!owner) {
          key = 'unowned'; label = 'device_id 없음'; reclaimable = true;
        } else if (!deviceNames.has(owner)) {
          key = `unregistered:${owner}`; label = `등록되지 않은 기기 (${owner.slice(0, 8)}…)`; reclaimable = true;
        } else {
          key = `device:${owner}`; label = `${deviceNames.get(owner)} 소유 — 그 기기에서 사용 중일 수 있음`; reclaimable = false;
        }
        const bucket = buckets.get(key) ?? { key, label, rows: [], reclaimable };
        bucket.rows.push({ id: row.id, name: row.name });
        buckets.set(key, bucket);
      }
      // 회수 대상 먼저, 그다음 큰 묶음 순.
      setOrphanGroups([...buckets.values()].sort((a, b) =>
        Number(b.reclaimable) - Number(a.reclaimable) || b.rows.length - a.rows.length));
    } catch (e) {
      setOrphanError(e instanceof Error ? e.message : String(e));
      setOrphanGroups([]);
    } finally {
      setOrphanBusy(null);
    }
  }, []);

  const deleteOrphanGroup = useCallback(async (group: OrphanGroup) => {
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
    setOrphanBusy(group.key);
    try {
      const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      // 한 번에 다 넣으면 URL 길이 제한에 걸린다. 실측 150행 규모라 나눠 보낸다.
      const ids = group.rows.map(r => r.id);
      for (let i = 0; i < ids.length; i += 50) {
        const { error } = await supabase.from('portmgr_ports').delete().in('id', ids.slice(i, i + 50));
        if (error) throw new Error(describeSupabaseError(error));
      }
      showToast(`Supabase에서 ${ids.length}개 행을 지웠습니다`, 'success');
      setOrphanGroups(prev => (prev ?? []).filter(g => g.key !== group.key));
    } catch (e) {
      showToast(`잔여 정리 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setOrphanBusy(null);
    }
  }, []);
  // Quick-add project modal (works on deployed web — no folder picker required)
  const [showQuickAddModal, setShowQuickAddModal] = useState(false);
  const [qaName, setQaName] = useState('');
  const [qaPort, setQaPort] = useState('');
  const [qaDeployUrl, setQaDeployUrl] = useState('');
  const [qaGithubUrl, setQaGithubUrl] = useState('');
  const [qaCategory, setQaCategory] = useState('');
  const [qaDescription, setQaDescription] = useState('');
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  // Close tools menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setShowToolsMenu(false);
      }
    };
    if (showToolsMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showToolsMenu]);
  const [portViewMode, setPortViewMode] = useState<'card'|'terminal'>(
    () => 'terminal'
  );
  const [v4SelectedId, setV4SelectedId] = useState<string|null>(null);
  // 헤더 「배포본 열기」의 프로젝트 고르개. 선택된 프로젝트가 없거나 그 프로젝트에
  // 배포 주소가 없을 때 이 목록이 뜬다 — 버튼이 죽어 있지 않게 하는 것이 목적이다.
  // 화면 배율. 판정·저장은 src/uiZoom.ts 한 곳. 기기마다 화면과 시력이 다르므로
  // 동기화하지 않고 기기별 localStorage 에만 둔다(`AI 표시`·고정 순서와 같은 원칙).
  const [uiZoom, setUiZoom] = useState<number>(() => {
    try { return parseStoredZoom(localStorage.getItem(UI_ZOOM_STORAGE_KEY)); }
    catch { return UI_ZOOM_DEFAULT; }
  });
  const [deployPickerOpen, setDeployPickerOpen] = useState(false);

  // 배율을 실제 화면에 적용하고 저장한다. 저장 실패(사파리 프라이빗 등)가 적용을
  // 막지 않도록 순서를 적용 → 저장으로 둔다.
  useEffect(() => {
    let cancelled = false;
    if (isTauri()) {
      // 데스크톱 앱은 webview 자체가 layout viewport와 hit-test를 함께 확대한다.
      // CSS zoom은 보이는 버튼과 실제 클릭 좌표를 갈라 놓았으므로 쓰지 않는다.
      clearDocumentZoom(document);
      void import('@tauri-apps/api/webview')
        .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(uiZoom))
        .catch(error => {
          if (cancelled) return;
          console.warn('[uiZoom] native webview zoom failed; using browser fallback', error);
          applyZoomToDocument(document, uiZoom);
        });
    } else {
      applyZoomToDocument(document, uiZoom);
    }
    try { localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(uiZoom)); } catch { /* 저장 실패는 무시 */ }
    return () => { cancelled = true; };
  }, [uiZoom]);

  // ⌘+ / ⌘- / ⌘0 — 브라우저 기본 확대와 겹치지 않게 preventDefault 한다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); setUiZoom(zoomIn); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); setUiZoom(zoomOut); }
      else if (event.key === '0') { event.preventDefault(); setUiZoom(UI_ZOOM_DEFAULT); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPort, setEditPort] = useState('');
  const [editCommandPath, setEditCommandPath] = useState('');
  const [editTerminalCommand, setEditTerminalCommand] = useState('');
  const [editFolderPath, setEditFolderPath] = useState('');
  const [editDeployUrl, setEditDeployUrl] = useState('');
  const [editGithubUrl, setEditGithubUrl] = useState('');
  const [editGithubDetecting, setEditGithubDetecting] = useState(false);
  const [editWorktreePath, setEditWorktreePath] = useState('');
  const [editManualPath, setEditManualPath] = useState('');
  const [editLogFilePath, setEditLogFilePath] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editAiName, setEditAiName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [aiSuggestingId, setAiSuggestingId] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [sidebarSection, setSidebarSection] = useState<string>('all');
  const [v3MenuOpenId, setV3MenuOpenId] = useState<string|null>(null);
  const [v3MenuRect, setV3MenuRect] = useState<{top:number;right:number}|null>(null);
  // 포트별 마지막 접속 시각(ms) — localStorage 영속화. Stale(2주+) 사이드바 필터용.
  const [lastVisits, setLastVisits] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('portmanager-last-visits') || '{}'); }
    catch { return {}; }
  });
  // 마운트 시 웹/앱 공용 저장소(last-visits.json)와 병합 — 다른 쪽(웹 또는 앱)에서 기록한 실행 이력을 따라잡는다
  useEffect(() => {
    API.loadLastVisits()
      .then(serverData => {
        setLastVisits(prev => {
          const next = { ...prev };
          for (const [id, ts] of Object.entries(serverData)) {
            if (!next[id] || ts > next[id]) next[id] = ts;
          }
          try { localStorage.setItem('portmanager-last-visits', JSON.stringify(next)); } catch {}
          return next;
        });
      })
      .catch(() => {});
  }, []);
  // 폴더별 마지막 git 커밋 시각 — 앱 버튼(Run/Claude 등)을 거치지 않고 터미널/에디터에서
  // 직접 작업한 경우에도 "마지막 실행"이 실제 작업 시점에 가깝게 보이도록 보정
  const [gitActivity, setGitActivity] = useState<Record<string, number>>({});
  const gitActivityFetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const targets = ports
      .filter(p => p.folderPath && !gitActivityFetchedRef.current.has(p.id))
      .map(p => ({ portId: p.id, folderPath: p.folderPath! }));
    if (targets.length === 0) return;
    targets.forEach(t => gitActivityFetchedRef.current.add(t.portId));
    const base = isTauri() ? 'http://localhost:3001' : '';
    fetch(`${base}/api/last-git-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: targets }),
    })
      .then(r => r.json())
      .then((data: Record<string, number | null>) => {
        setGitActivity(prev => {
          const next = { ...prev };
          for (const [id, ts] of Object.entries(data)) if (ts) next[id] = ts;
          return next;
        });
      })
      .catch(() => {});
  }, [ports]);
  // lastVisits(앱 버튼 클릭)와 gitActivity(실제 커밋) 중 더 최신 값을 "마지막 실행"으로 사용
  const lastActivityFor = (id: string): number | undefined => {
    const v = lastVisits[id] ?? 0;
    const g = gitActivity[id] ?? 0;
    const max = Math.max(v, g);
    return max || undefined;
  };
  // 메뉴 열린 상태에서 스크롤 시 자동 닫기 — position:fixed 메뉴가 트리거에서 떨어지는 문제 방지
  useEffect(() => {
    if (!v3MenuOpenId) return;
    const close = () => { setV3MenuOpenId(null); setV3MenuRect(null); };
    window.addEventListener('scroll', close, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', close, true);
  }, [v3MenuOpenId]);
  // 머지 확인 모달
  const [mergeConfirm, setMergeConfirm] = useState<{ item: PortInfo; wt: WorktreeInfo; mainBranch: string; commits: string; stat: string; isDirty: boolean } | null>(null);
  // 워크트리 재사용(브랜치 갈아끼우기) / 잠금 해제 — 머지 다음 단계가 "삭제"뿐이던 막다른 길을 메운다.
  const [switchBranchModal, setSwitchBranchModal] = useState<{ item: PortInfo; wt: WorktreeInfo; name: string } | null>(null);
  const [worktreeBranchBusy, setWorktreeBranchBusy] = useState<Record<string, boolean>>({});
  const [mergeError, setMergeError] = useState<{ message: string; hasConflict: boolean; folderPath: string; item?: PortInfo; wt?: WorktreeInfo } | null>(null);
  const [mergeConflictFiles, setMergeConflictFiles] = useState<string[]>([]);
  const [mergePushConfirm, setMergePushConfirm] = useState<{ item: PortInfo; mainBranch: string } | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [deleteWorktreeConfirm, setDeleteWorktreeConfirm] = useState<{ item: PortInfo; wt: WorktreeInfo } | null>(null);
  /** 레거시 숨김 경로 워크트리를 worktrees/ 로 옮기기 전 확인 모달 */
  const [migrateWorktreeConfirm, setMigrateWorktreeConfirm] = useState<{ item: PortInfo; wt: WorktreeInfo } | null>(null);
  /** 이동 진행 중인 워크트리 경로 (버튼 중복 클릭 방지) */
  const [worktreeMigrating, setWorktreeMigrating] = useState<Record<string, boolean>>({});
  const [gitInitConfirm, setGitInitConfirm] = useState<{ item: PortInfo; branchName: string } | null>(null);
  const [commitModal, setCommitModal] = useState<{ item: PortInfo; wt: WorktreeInfo; msg: string } | null>(null);
  const [gitOperationError, setGitOperationError] = useState<GitOperationErrorState | null>(null);
  const [pendingParentCommit, setPendingParentCommit] = useState<{ item: PortInfo; wt: WorktreeInfo; message: string } | null>(null);
  const [commitMessageGenerating, setCommitMessageGenerating] = useState(false);
  // 커밋 요청이 끝날 때까지 모달을 남겨 둔다. 예전에는 클릭 즉시 모달을 닫고 결과를 토스트로만
  // 알렸는데, 앱에서는 커밋+목록 갱신이 수 초 걸려 그 사이 아무 표시가 없어 "안 눌렸다"로 읽혔다.
  const [commitRunning, setCommitRunning] = useState(false);
  const [expandedWorktreeIds, setExpandedWorktreeIds] = useState<Set<string>>(new Set());
  const [worktreeLists, setWorktreeLists] = useState<Record<string, WorktreeInfo[]>>({});
  const [worktreeNewBranch, setWorktreeNewBranch] = useState<Record<string, string>>({});
  const [worktreeLoading, setWorktreeLoading] = useState<Record<string, boolean>>({});
  const [worktreeLoadErrors, setWorktreeLoadErrors] = useState<Record<string, { code?: string; message: string }>>({});
  const [worktreeGitStatus, setWorktreeGitStatus] = useState<Record<string, WorktreeGitStatus>>({});
  const [worktreeGitBusy, setWorktreeGitBusy] = useState<Record<string, boolean>>({});
  const [repositoryWorkflowStatuses, setRepositoryWorkflowStatuses] = useState<Record<string, RepositoryWorkflowStatus>>({});
  const [repositoryWorkflowBusy, setRepositoryWorkflowBusy] = useState<Record<string, boolean>>({});
  const [firstTaskLaunch, setFirstTaskLaunch] = useState<FirstTaskLaunchRequest | null>(null);
  const [firstTaskBranchName, setFirstTaskBranchName] = useState('');
  const [firstTaskLaunchBusy, setFirstTaskLaunchBusy] = useState(false);
  const [wtPortStatuses, setWtPortStatuses] = useState<Record<number, boolean>>({});
  // wt.path → 실제 감지된 리스닝 포트 (find-worktree-port API 결과)
  const [wtActualPorts, setWtActualPorts] = useState<Record<string, number>>({});
  // Orca CLI는 목록 조회와 terminal/tab 생성이 겹칠 때 런타임이 불안정해진다.
  // Tauri 실행(Rust)과 배지 조회(Bun sidecar)도 이 프런트 큐 하나를 통과시켜
  // 서로 다른 프로세스의 개별 mutex가 놓치는 경합을 앱 수준에서 막는다.
  const orcaOperationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const runOrcaOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const task = orcaOperationQueueRef.current.then(operation, operation);
    orcaOperationQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, []);
  // 워크트리 "Orca에 보이나" 판정 보조 — Orca가 인식 중인 워크트리 경로 집합.
  // ⚠️ 이 값은 **배지의 부가 정보**일 뿐이다. 조회에 실패해도 배지 자체는 항상 렌더한다
  //    (출처=만든 주체와 숨김경로 여부는 경로만으로 판정 가능 → Orca 없이도 알 수 있다).
  //    예전엔 available=false면 배지를 통째로 감췄는데, Orca 데몬이 잠깐 바쁘거나 API가
  //    아직 안 뜬 순간에 배지가 전멸해 "배지가 아예 안 보인다"는 증상이 됐다.
  const ORCA_WT_CACHE_KEY = 'orca-worktree-paths-v1';
  const [orcaWorktreePaths, setOrcaWorktreePaths] = useState<{ available: boolean; paths: Set<string> }>(() => {
    // 리로드 직후 2초 공백(조회 왕복 시간) 동안에도 직전 결과로 즉시 판정할 수 있게 캐시에서 복원
    try {
      const raw = sessionStorage.getItem(ORCA_WT_CACHE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length) return { available: true, paths: new Set(arr) };
      }
    } catch {}
    return { available: false, paths: new Set() };
  });
  const refreshOrcaWorktreePaths = useCallback(async () => {
    await runOrcaOperation(async () => {
      try {
        const base = isTauri() ? 'http://127.0.0.1:3001' : '';
        const res = await fetch(`${base}/api/orca-worktrees`);
        const data = await res.json();
        if (data?.available !== true) {
          // 실패 시 직전 성공 목록을 버리지 않는다 — 버리면 그 순간 모든 행이 "Orca 미인식"으로 뒤집힌다.
          setOrcaWorktreePaths(prev => (prev.paths.size ? prev : { available: false, paths: new Set() }));
          return;
        }
        const list = (data?.paths ?? []).map((p: string) => p.replace(/\/+$/, ''));
        try { sessionStorage.setItem(ORCA_WT_CACHE_KEY, JSON.stringify(list)); } catch {}
        setOrcaWorktreePaths({ available: true, paths: new Set<string>(list) });
      } catch {
        setOrcaWorktreePaths(prev => (prev.paths.size ? prev : { available: false, paths: new Set() }));
      }
    });
  }, [runOrcaOperation]);
  // 마운트 즉시 1회 + 60초 폴링. 예전엔 loadWorktrees 안에서만 호출돼, 프로젝트를 열기 전이거나
  // 첫 조회가 실패하면 그 세션 내내 Orca 정보가 비어 있었다.
  useEffect(() => {
    void refreshOrcaWorktreePaths();
    const t = setInterval(() => { void refreshOrcaWorktreePaths(); }, 60_000);
    return () => clearInterval(t);
  }, [refreshOrcaWorktreePaths]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAiEnriching, setIsAiEnriching] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isPushingPorts, setIsPushingPorts] = useState(false);
  const [isDispatchingWindowsCloudBuild, setIsDispatchingWindowsCloudBuild] = useState(false);
  const [showPortsHistory, setShowPortsHistory] = useState(false);
  const [portsHistoryList, setPortsHistoryList] = useState<PushSnapshot[]>([]);
  const [portsHistoryLoading, setPortsHistoryLoading] = useState(false);
  const [portsHistoryRestoring, setPortsHistoryRestoring] = useState<string | null>(null);
  const [remappingPorts, setRemappingPorts] = useState<PortInfo[]>([]);
  const [remappingPaths, setRemappingPaths] = useState<Record<string, string>>({});
  const [isBuilding, setIsBuilding] = useState(false);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [canAutoInstall, setCanAutoInstall] = useState(false);
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [buildType, setBuildType] = useState<'app' | 'dmg' | 'windows'>('app');
  const lastLogIndexRef = useRef<number>(0);
  const isBuildingRef = useRef(false);
  const buildSeqRef = useRef(0); // 빌드 세대 — 이전 빌드의 타임아웃이 새 빌드를 오판하지 않도록
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appendBuildLogs = useCallback((entries: string[]) => {
    setBuildLogs(prev => [...prev, ...entries].slice(-2500));
  }, []);
  const consumeBuildStatusLogs = useCallback((status: unknown): string[] => {
    const result = buildLogWindowDelta(
      status && typeof status === 'object' ? status : {},
      lastLogIndexRef.current,
    );
    lastLogIndexRef.current = result.cursor;
    return result.entries;
  }, []);
  useEffect(() => () => {
    buildSeqRef.current += 1;
    if (buildPollRef.current) clearInterval(buildPollRef.current);
    if (buildTimeoutRef.current) clearTimeout(buildTimeoutRef.current);
    buildPollRef.current = null;
    buildTimeoutRef.current = null;
    isBuildingRef.current = false;
  }, []);
  const buildLogContainerRef = useRef<HTMLDivElement>(null);
  // Port log viewer modal state
  const [showPortLog, setShowPortLog] = useState(false);
  const [portLogs, setPortLogs] = useState<string[]>([]);
  const [viewingPortId, setViewingPortId] = useState<string | null>(null);
  const [viewingPortName, setViewingPortName] = useState<string>('');
  const [isLoadingPortLog, setIsLoadingPortLog] = useState(false);
  const portLogContainerRef = useRef<HTMLDivElement>(null);
  const portLogOffsetRef = useRef<number>(0);
  const portLogPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const portLogPollBusyRef = useRef(false); // 로그 폴링 in-flight 가드 — 느린 틱이 다음 틱과 겹치는 것 방지
  const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceRoot[]>([]);
  const [workspaceRootsOpen, setWorkspaceRootsOpen] = useState(false);
  const [tagsPanelOpen, setTagsPanelOpen] = useState(false);
  const [visitCounts, setVisitCounts] = useState<{ portId: string; count: number }[]>([]);
  const [visitWindow, setVisitWindow] = useState<'alltime' | 'weekly' | 'daily'>('alltime');
  const [highlightedPortId, setHighlightedPortId] = useState<string | null>(null);
  const dirHandlesRef = useRef<Map<string, FileSystemDirectoryHandle>>(new Map());
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPort, setNewProjectPort] = useState('');
  const [initializeNewProjectGit, setInitializeNewProjectGit] = useState(true);
  /**
   * 「새 폴더 만들기」의 GitHub 주소. 비어 있으면 지금까지와 똑같이 mkdir 로 만들고,
   * 채워지면 clone 으로 만든다. clone 이면 origin 이 처음부터 있어 장기기억이
   * `github_url` 로 계보를 찾는다 — memoryId 를 손으로 옮길 필요가 없어진다.
   */
  const [newProjectGithubUrl, setNewProjectGithubUrl] = useState('');
  const [runNewProjectAfterCreate, setRunNewProjectAfterCreate] = useState(false);
  const [enableNewProjectMemory, setEnableNewProjectMemory] = useState(true);
  /** 비어 있으면 새 기억을 만들고, 채우면 그 ID의 기억에 합류한다 (src/projectMemoryJoin.ts). */
  const [newProjectMemoryJoinId, setNewProjectMemoryJoinId] = useState('');
  const newProjectMemoryJoinProblem = joinMemoryIdProblem(newProjectMemoryJoinId);
  /** 기존 폴더 등록 탭 전용. 탭 사이에 값이 새지 않도록 새 프로젝트 쪽과 분리한다. */
  const [existingMemoryJoinId, setExistingMemoryJoinId] = useState('');
  const existingMemoryJoinProblem = joinMemoryIdProblem(existingMemoryJoinId);
  const [newProjectMemoryAgent, setNewProjectMemoryAgent] = useState<ProjectMemoryAgent>('claude');
  const [backupNewProjectMemory, setBackupNewProjectMemory] = useState(true);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [registerAsProject, setRegisterAsProject] = useState(true);
  const [projectModalTab, setProjectModalTab] = useState<'new' | 'existing'>('new');
  const [existingFolderPath, setExistingFolderPath] = useState('');
  const [existingDetectedPort, setExistingDetectedPort] = useState<number | undefined>(undefined);
  const [existingProjectName, setExistingProjectName] = useState('');
  const [existingPort, setExistingPort] = useState('');
  const [existingGitStatus, setExistingGitStatus] = useState<'checking' | 'git' | 'none' | 'unknown'>('unknown');
  const [existingGitAction, setExistingGitAction] = useState<'keep' | 'create' | 'reinitialize' | 'none'>('create');
  const [runExistingProjectAfterRegister, setRunExistingProjectAfterRegister] = useState(false);
  useEffect(() => {
    if (!showNewProjectModal) return;
    setInitializeNewProjectGit(true);
    setRunNewProjectAfterCreate(false);
    setRunExistingProjectAfterRegister(false);
    setEnableNewProjectMemory(true);
    setNewProjectMemoryAgent('claude');
    setBackupNewProjectMemory(true);
  }, [showNewProjectModal]);
  useEffect(() => {
    if (projectModalTab !== 'existing') return;
    const folderPath = existingFolderPath.trim().replace(/[/\\]+$/, '');
    if (!folderPath || (!folderPath.startsWith('/') && !folderPath.match(/^[A-Z]:\\/i))) {
      setExistingGitStatus('unknown');
      return;
    }
    let cancelled = false;
    setExistingGitStatus('checking');
    const timer = setTimeout(async () => {
      try {
        const status = await API.gitInit(folderPath, { checkOnly: true });
        if (cancelled) return;
        if (status.error) {
          setExistingGitStatus('unknown');
          return;
        }
        const isGit = !!status.alreadyGit;
        setExistingGitStatus(isGit ? 'git' : 'none');
        setExistingGitAction(isGit ? 'keep' : 'create');
      } catch {
        if (!cancelled) setExistingGitStatus('unknown');
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [existingFolderPath, projectModalTab]);
  // 자동으로 채워 넣은 마지막 값 — 현재 입력값이 이 값 그대로면 "사용자가 안 건드림"으로 보고 덮어쓴다
  const existingAutoNameRef = useRef('');
  const existingAutoPortRef = useRef('');
  const portalConfigRef = useRef<any>(null);
  const [portalDeploymentItems, setPortalDeploymentItems] = useState<any[]>([]);
  const cachePortalConfig = useCallback((config: any) => {
    portalConfigRef.current = config ?? null;
    setPortalDeploymentItems(Array.isArray(config?.items) ? config.items : []);
  }, []);
  const deploymentTargets = useMemo(
    () => buildDeploymentTargets(ports, portalDeploymentItems),
    [ports, portalDeploymentItems],
  );
  const portalActionsRef = useRef<PortalActions | null>(null);
  const autoPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fix P2g: gate delete pass — only safe to delete remote rows after a successful auto-pull
  // (otherwise local state has only this Mac's rows and would delete other Macs' remote data)
  const autopullSucceeded = useRef(false);
  const autopushReady = useRef(false); // Supabase 푸시 전용 게이트 (pull 완료 후 true)
  // 다른 OS 경로의 포트 — 화면/Push에서는 제외하되 파일 저장 시 보존
  const otherPlatformPortsRef = useRef<PortInfo[]>([]);
  const toastSeqRef = useRef(0);
  const appLogRef = useRef<string[]>([]);
  const [logCopied, setLogCopied] = useState(false);

  // A genuinely new local profile should see setup once, but existing profiles and
  // the hosted portal must never be interrupted. The explicit header button remains
  // available after this one-time prompt is dismissed.
  useEffect(() => {
    if (hasCheckedFirstRunSetup.current || isLoading || isDeployedWeb()) return;
    hasCheckedFirstRunSetup.current = true;
    try {
      if (localStorage.getItem(SETUP_WIZARD_SEEN_KEY)) return;
      const config = portalConfigRef.current;
      const hasSupabaseConfig = Boolean(config?.supabaseUrl || config?.supabaseAnonKey);
      if (ports.length === 0 && !hasSupabaseConfig) setShowSetupWizard(true);
    } catch {
      // localStorage can be unavailable in restricted browser contexts; setup remains manual.
    }
  }, [isLoading, ports.length]);

  // API 서버 헬스 체크 (웹 모드 전용) — 오프라인 시 2초, 온라인 시 30초 간격
  useEffect(() => {
    if (isTauri()) return;
    let timerId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      let online = false;
      try {
        const res = await Promise.race([
          fetch('/api/ports'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]) as Response;
        online = res.ok;
      } catch {
        online = false;
      }
      if (cancelled) return; // cleanup이 await 중에 실행된 경우 재스케줄 금지
      setApiServerOnline(online);
      timerId = setTimeout(check, online ? 30_000 : 2_000);
    };

    check();
    return () => { cancelled = true; clearTimeout(timerId); };
  }, []);

  // API 서버가 온라인으로 전환될 때 포트 재로드 (초기 로드 실패 복구)
  useEffect(() => {
    if (isTauri() || apiServerOnline !== true || hasInitiallyLoaded.current) return;
    API.loadPorts()
      .then(data => {
        if (data.length > 0) {
          setPorts(data.map(port => ({ ...port, isRunning: runningStateAfterReload(port) })));
          hasInitiallyLoaded.current = true;
          setIsLoading(false);
        }
      })
      .catch(() => {});
  }, [apiServerOnline]);

  // 앱 로그 캡처 (console.error / warn + 미처리 예외)
  useEffect(() => {
    const ts = () => new Date().toTimeString().slice(0, 8);
    const push = (line: string) => {
      appLogRef.current.push(line);
      if (appLogRef.current.length > 300) appLogRef.current.shift();
    };
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...a) => { push(`[ERR ${ts()}] ${a.map(String).join(' ')}`); origError(...a); };
    console.warn = (...a) => { push(`[WRN ${ts()}] ${a.map(String).join(' ')}`); origWarn(...a); };
    const onErr = (e: ErrorEvent) => push(`[UNCAUGHT ${ts()}] ${e.message} @ ${e.filename}:${e.lineno}`);
    const onRej = (e: PromiseRejectionEvent) => push(`[UNHANDLED ${ts()}] ${String(e.reason)}`);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      console.error = origError; console.warn = origWarn;
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  const handleCopyLog = async () => {
    const text = appLogRef.current.join('\n') || '(캡처된 앱 오류 없음)';
    try {
      await navigator.clipboard.writeText(text);
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 2000);
    } catch {
      showToast('클립보드 복사 실패', 'error');
    }
  };

  // 토스트 배너 표시 함수
  const showToast = (
    message: string,
    type: 'success' | 'error' | 'warning' = 'success',
    duration = type === 'error' ? 12_000 : type === 'warning' ? 9000 : 3000,
    diagnosticOverride?: string,
  ): number => {
    const id = ++toastSeqRef.current; // Date.now()는 같은 ms 내 충돌 가능
    const diagnostic = type === 'error'
      ? (diagnosticOverride || formatOperationDiagnostic({ operation: 'app.ui', message }))
      : undefined;
    if (diagnostic) {
      appLogRef.current.push(diagnostic);
      if (appLogRef.current.length > 300) appLogRef.current.splice(0, appLogRef.current.length - 300);
    }
    setToasts(prev => [...prev, { id, message, type, diagnostic }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
      }, duration);
    }
    return id;
  };

  const copyProjectFolderRenamePrompt = (item: PortInfo) => {
    if (!item.folderPath) {
      showToast('프로젝트 폴더 경로가 없어 이름변경 프롬프트를 만들 수 없습니다.', 'warning');
      return;
    }
    const currentName = folderLeafName(item.folderPath);
    setFolderRenamePromptTargetId(item.id);
    setFolderRenameInput(`${currentName}-renamed`);
  };

  const confirmCopyProjectFolderRenamePrompt = async () => {
    const item = portsRef.current.find(port => port.id === folderRenamePromptTargetId);
    if (!item?.folderPath) {
      showToast('프로젝트 폴더 경로를 다시 확인해주세요.', 'warning');
      setFolderRenamePromptTargetId(null);
      return;
    }
    const problem = projectFolderNameProblem(item.folderPath, folderRenameInput);
    if (problem) {
      showToast(problem, 'warning');
      return;
    }
    try {
      const prompt = buildProjectFolderRenamePrompt({
        projectId: item.id,
        projectName: item.name,
        currentFolderPath: item.folderPath,
        newFolderName: folderRenameInput,
        commandPath: item.commandPath,
        worktreePath: item.worktreePath,
      });
      await navigator.clipboard.writeText(prompt);
      showToast(`「${folderRenameInput.trim()}」 폴더명 변경 프롬프트를 복사했습니다.`, 'success');
      setFolderRenamePromptTargetId(null);
      setFolderRenameInput('');
    } catch (error) {
      showToast(`프롬프트 복사 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  const removeToast = (id: number) =>
    setToasts(prev => prev.filter(t => t.id !== id));

  // A context snapshot only knows a cwd plus optional desktop-app metadata.
  // Resolve it locally to a registered project (or parent-owned worktree),
  // retaining readable names so a voice-chat scratch folder never becomes the
  // visible project name in the AI usage panel.
  const contextProjectCandidates = useMemo(() => {
    const projectById = new Map(ports.map(project => [project.id, project]));
    const pathLeaf = (folderPath: string) => folderPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || folderPath;
    return [
      ...Object.entries(worktreeLists).flatMap(([projectId, worktrees]) => {
        const project = projectById.get(projectId);
        return worktrees.map(worktree => ({
          projectId,
          projectName: project?.name ?? null,
          worktreeName: worktree.branch || pathLeaf(worktree.path),
          path: worktree.path,
          priority: 3,
        }));
      }),
      ...ports.flatMap(project => [
        {
          projectId: project.id,
          projectName: project.name,
          path: project.folderPath,
          priority: project.worktreePath ? 0 : 1,
        },
        ...(project.worktreePath ? [{
          projectId: project.id,
          projectName: project.name,
          worktreeName: pathLeaf(project.worktreePath),
          path: project.worktreePath,
          priority: 0,
        }] : []),
      ]),
    ];
  }, [ports, worktreeLists]);

  const contextProjectForPath = useCallback(
    (folderPath: string) => resolveContextProjectTarget(contextProjectCandidates, folderPath),
    [contextProjectCandidates],
  );

  const canOpenContextProject = useCallback(
    (folderPath: string) => !!contextProjectForPath(folderPath),
    [contextProjectForPath],
  );

  const openContextProject = useCallback((folderPath: string) => {
    const target = contextProjectForPath(folderPath);
    const project = target ? ports.find(item => item.id === target.projectId) : null;
    if (!project) {
      showToast('이 세션의 등록된 프로젝트를 찾지 못했습니다.', 'warning');
      return;
    }
    setActiveTab('ports');
    setSearchQuery('');
    setSidebarSection(project.worktreePath ? 'wt' : 'all');
    setV4SelectedId(project.id);
    setShowAiUsage(false);
    showToast(`프로젝트 영역에서 ${project.name}을 열었습니다.`, 'success');
  }, [contextProjectForPath, ports]);

  /**
   * A Claude background agent has no terminal window of its own, so the AI usage
   * panel cannot "move" to it. Agent View on the header's terminal surface is
   * where it can actually be reached — the same view `claude --bg` opens.
   */
  const openContextAgentView = useCallback(async (folderPath: string | null): Promise<string> => {
    if (!folderPath) throw new Error('세션의 폴더 경로가 없어 Agent View를 열 수 없습니다.');
    const target = contextProjectForPath(folderPath);
    const project = target ? ports.find(item => item.id === target.projectId) : null;
    // An unregistered folder still deserves Agent View; only the display name
    // falls back here, never the working directory.
    const item: PortInfo = project ?? {
      id: `context-agent-view-${folderPath}`,
      name: folderPath.replace(/[/\\]+$/, '').split(/[\\/]/).pop() || 'Agent View',
      port: 0,
      folderPath,
    };
    const context = resolveAgentLaunchContext(item.folderPath, undefined, item.worktreePath);
    if (!context.workingPath) throw new Error('세션의 폴더 경로가 없어 Agent View를 열 수 없습니다.');
    const message = await openClaudeBgAgentView(item, context);
    return `${message}\n${selectedTerminalSurface}에서 claude agents를 열었습니다.`;
  }, [contextProjectForPath, ports, terminalApp, bypassPermissions, orcaLaunchMode, selectedTerminalSurface]);

  const reportOperationError = (
    operation: string,
    label: string,
    item: PortInfo | undefined,
    projectPath: string | undefined,
    error: unknown,
  ): false => {
    const raw = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
    const diagnostic = formatOperationDiagnostic({
      operation,
      projectName: item?.name,
      projectPath,
      message: raw,
    });
    showToast(`${label}: ${raw}`, 'error', 12_000, diagnostic);
    return false;
  };

  // 전체 AI 이름 적용 프롬프트 — Claude/Codex 채팅에 붙여넣을 수 있도록 복사
  const handleCopyAiNamePrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AI_NAME_BATCH_CHAT_PROMPT);
      showToast('전체 AI 이름 채팅 명령 복사됨 — Claude 또는 Codex에 붙여넣으세요', 'success');
    } catch {
      showToast('클립보드 복사 실패', 'error');
    }
  }, []);

  // 초기 자동 열기·선택 변경·30초 폴링이 겹쳐도 같은 프로젝트를 중복 조회하지 않는다.
  // 특히 개발 중 HMR/페이지 전환 때 중복 fetch가 abort되며 서버에 JSON parse 로그를
  // 남기던 문제를 막고, lsof 기반 실제 포트 조회도 한 번만 실행한다.
  const worktreeLoadInflightRef = useRef<Map<string, Promise<void>>>(new Map());
  const worktreeLoadGenerationRef = useRef<Map<string, number>>(new Map());
  const worktreeAddInflightRef = useRef<Set<string>>(new Set());
  const worktreeRemoteRefreshAtRef = useRef<Map<string, number>>(new Map());
  const loadWorktrees = useCallback((
    portId: string,
    folderPath: string,
    options: { fetchRemote?: boolean; showResult?: boolean; force?: boolean } = {},
  ): Promise<void> => {
    const fetchRemote = options.fetchRemote === true;
    const identityKey = `${portId}\u0000${folderPath}`;
    const requestKey = `${identityKey}\u0000${fetchRemote ? 'remote' : 'local'}`;
    const existing = worktreeLoadInflightRef.current.get(requestKey);
    if (existing && options.force !== true) return existing;
    // 로컬 조회와 원격 Fetch 조회는 중복 방지 키는 다르지만 같은 화면 상태를 쓴다.
    // 커밋 전 시작한 원격 조회가 커밋 후 강제 로컬 조회보다 늦게 끝나더라도 최신 버튼
    // 값을 다시 덮어쓰지 못하도록 세대 번호는 프로젝트 단위로 공유한다.
    const generation = (worktreeLoadGenerationRef.current.get(identityKey) ?? 0) + 1;
    worktreeLoadGenerationRef.current.set(identityKey, generation);

    const task = (async () => {
      setWorktreeLoading(prev => ({ ...prev, [portId]: true }));
      void refreshOrcaWorktreePaths(); // 출처 배지용(15초 서버 캐시라 부담 없음, 실패해도 목록엔 영향 없음)
      setWorktreeGitStatus(prev => prev[portId] ? prev : ({ ...prev, [portId]: 'checking' }));
      try {
      const [gitStatus, rawList, repositoryWorkflow] = await Promise.all([
        API.gitInit(folderPath, { checkOnly: true }).catch(() => null),
        API.listGitWorktrees(folderPath, fetchRemote),
        repositoryWorkflowApi.status(folderPath).catch(() => null),
      ]);
      // 생성/삭제 직후 force refresh가 시작되면, 그 전에 시작한 느린 응답은
      // 더 최신 목록을 덮어쓰지 못한다.
      if (worktreeLoadGenerationRef.current.get(identityKey) !== generation) return;
      // 구버전 API/Tauri 백엔드는 githubConnected 필드를 반환하지 않는다.
      // 이 경우에만 프로젝트에 저장된 GitHub URL을 호환 기준으로 사용한다.
      // 최신 백엔드가 false를 명시하면 실제 origin 미연결 판정을 그대로 존중한다.
      const savedGithubConnected = githubRepositoryUrls(
        portsRef.current.find(port => port.id === portId) ?? {},
      ).some(url => !!normalizeGitHubRepositoryUrl(url));
      const list = rawList.map(worktree => ({
        ...worktree,
        githubConnected: worktree.githubConnected ?? savedGithubConnected,
      }));
      setWorktreeGitStatus(prev => ({
        ...prev,
        [portId]: gitStatus === null
          ? (list.some(wt => wt.is_main) ? 'ready' : 'unknown')
          : gitStatus.alreadyGit
            ? (gitStatus.hasCommit ? 'ready' : 'no-commit')
            : 'none',
      }));
      setWorktreeLoadErrors(prev => {
        if (!prev[portId]) return prev;
        const next = { ...prev };
        delete next[portId];
        return next;
      });
      setWorktreeLists(prev => ({ ...prev, [portId]: list }));
      if (repositoryWorkflow) {
        setRepositoryWorkflowStatuses(prev => ({ ...prev, [portId]: repositoryWorkflow }));
      }
      const remoteFeedback = fetchRemote
        ? resolveWorktreeRemoteRefreshFeedback(list)
        : undefined;
      if (remoteFeedback?.countsAsRefresh) worktreeRemoteRefreshAtRef.current.set(portId, Date.now());
      if (fetchRemote && options.showResult !== false) {
        if (remoteFeedback?.kind === 'error') showToast(remoteFeedback.message, 'error');
        else if (remoteFeedback?.kind === 'no-origin') showToast(remoteFeedback.message, 'warning');
        else if (remoteFeedback) showToast(remoteFeedback.message, 'success');
      }
      // 살아있는 워크트리 경로 목록을 기준으로, 외부에서(git CLI 등) 삭제되어 더 이상
      // 존재하지 않는 워크트리를 가리키는 _wt_ 파생 포트 행을 정리 (성공 경로에서만 실행)
      const liveWorktreePaths = new Set(list.map(wt => wt.path));
      let prunedPorts: PortInfo[] | null = null;
      setPorts(prev => {
        const next = prev.filter(p => {
          if (!p.id.startsWith(portId + '_wt_')) return true;
          return !!p.worktreePath && liveWorktreePaths.has(p.worktreePath);
        });
        if (next.length !== prev.length) prunedPorts = next;
        return next;
      });
      if (prunedPorts) {
        API.savePorts(prunedPorts).catch(e => console.warn('[loadWorktrees] prune persist failed:', e));
      }
      // 워크트리가 있으면 패널 자동 확장 (non-main 워크트리가 1개 이상)
      if (list.some(wt => !wt.is_main)) {
        setExpandedWorktreeIds(prev => { const next = new Set(prev); next.add(portId); return next; });
      }
      // Check actual port status for each non-main worktree
      const usedPortsSnap = new Set(
        (JSON.parse(localStorage.getItem('ports_cache') || '[]') as {port?:number}[])
          .map(p => p.port).filter((p): p is number => p != null)
      );
      // Browser worktrees must stay paired with the current Vite instance's API
      // proxy. A fixed 3001 URL can inspect or launch the wrong worktree server.
      const baseUrl = isTauri() ? 'http://localhost:3001' : '';
      const checks = list
        .filter(wt => !wt.is_main)
        .map(async wt => {
          // 먼저 프로세스 CWD 기반으로 실제 리스닝 포트 탐색
          let actualPort: number | null = null;
          const mainPortForScheme = portsRef.current.find(p => p.id === portId)?.port;
          try {
            const r = await fetch(
              // mainPort를 함께 넘겨 서버가 배정 규칙에 맞는 포트만 인정하게 한다
              // (같은 cwd의 MCP 서버 등이 워크트리 서버로 오인되는 것 차단).
              `${baseUrl}/api/find-worktree-port?folderPath=${encodeURIComponent(wt.path)}`
                + (mainPortForScheme ? `&mainPort=${mainPortForScheme}` : ''),
              {
              method: 'POST',
              }
            );
            const d = await r.json();
            if (d.success && d.port) actualPort = d.port;
          } catch { /* ignore */ }
          const mainPort = portsRef.current.find(p => p.id === portId)?.port;
          const hashPort = worktreePortForMain(mainPort, wt.path, usedPortsSnap);
          const isRunning = actualPort != null
            ? true
            : await API.checkPortStatus(hashPort).catch(() => false);
          return { wtPath: wt.path, wtPort: actualPort ?? hashPort, isRunning };
        });
      const results = await Promise.all(checks);
      setWtPortStatuses(prev => {
        const next = { ...prev };
        results.forEach(({ wtPort, isRunning }) => { next[wtPort] = isRunning; });
        return next;
      });
      setWtActualPorts(prev => {
        const next = { ...prev };
        results.forEach(({ wtPath, wtPort, isRunning }) => {
          if (isRunning) next[wtPath] = wtPort;
          else delete next[wtPath];
        });
        return next;
      });
      } catch (error) {
        if (worktreeLoadGenerationRef.current.get(identityKey) !== generation) return;
        setWorktreeGitStatus(prev => ({ ...prev, [portId]: 'unknown' }));
        setWorktreeLoadErrors(prev => ({
          ...prev,
          [portId]: {
            code: error instanceof Error ? (error as Error & { code?: string }).code : undefined,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
        // 일시적 오류(git/API 순간 실패)로 패널이 텅 비어 보이지 않도록 이전 목록 유지
        if (options.showResult !== false) {
          const item = portsRef.current.find(port => port.id === portId);
          reportOperationError('git.worktree.list', '워크트리 목록 갱신 실패', item, folderPath, error);
        }
      } finally {
        if (worktreeLoadGenerationRef.current.get(identityKey) === generation) {
          setWorktreeLoading(prev => ({ ...prev, [portId]: false }));
        }
      }
    })();

    worktreeLoadInflightRef.current.set(requestKey, task);
    void task.finally(() => {
      if (worktreeLoadInflightRef.current.get(requestKey) === task) {
        worktreeLoadInflightRef.current.delete(requestKey);
      }
    });
    return task;
  }, []);

  const refreshWorktreeAfterGitAction = useCallback(async (item: PortInfo) => {
    if (!item.folderPath) return;
    // `force: true`가 없으면 이미 진행 중인 조회 프라미스를 그대로 재사용한다. 그 조회는
    // 커밋/머지 **이전에** 시작된 것이라 결과가 옛 상태이고, 화면의 「커밋 N」 배지가 그대로
    // 남아 방금 한 작업이 실행되지 않은 것처럼 보인다.
    await loadWorktrees(item.id, item.folderPath, { showResult: false, force: true });
  }, [loadWorktrees]);

  const handleWorktreeCommit = useCallback(async (item: PortInfo, wt: WorktreeInfo, message: string) => {
    try {
      await API.gitCommit(wt.path, message.trim());
      await refreshWorktreeAfterGitAction(item);
      if (pendingParentCommit && pendingParentCommit.wt.path !== wt.path) {
        const parent = pendingParentCommit;
        setPendingParentCommit(null);
        setCommitMessageGenerating(false);
        setCommitModal({ item: parent.item, wt: parent.wt, msg: parent.message });
        showToast(`서브모듈 커밋 완료: ${wt.branch || wt.path} · 상위 저장소 커밋을 확인하세요.`, 'success');
      } else {
        showToast(`커밋 완료: ${wt.branch || 'main'}`, 'success');
      }
    } catch (error) {
      const failure = error as GitCommitRequestError;
      const failureMessage = failure instanceof Error ? failure.message : String(error);
      const diagnostic = formatOperationDiagnostic({
        operation: 'git.commit',
        projectName: item.name,
        projectPath: wt.path,
        message: failureMessage,
        backendDiagnostic: failure.diagnostic,
      });
      console.error(`[GitCommit] ${diagnostic}`);
      setGitOperationError({
        title: failure.code === 'dirty_submodule' ? '서브모듈 변경으로 커밋 중단' : 'Git 커밋 실패',
        message: failureMessage,
        diagnostic,
        worktreePath: wt.path,
        submodulePaths: failure.submodulePaths ?? [],
        item,
        parentWorktree: wt,
        attemptedMessage: message.trim(),
      });
      showToast(`커밋 실패: ${failureMessage} · 상세 진단을 확인하세요.`, 'error');
    }
  }, [pendingParentCommit, refreshWorktreeAfterGitAction]);

  // 모달의 「커밋」 버튼과 Enter가 공유하는 경로. 요청이 끝난 뒤에 모달을 닫는다 —
  // 먼저 닫으면 커밋·목록 갱신이 걸리는 수 초 동안 화면에 아무 변화가 없다.
  // `handleWorktreeCommit`은 성공 시 서브모듈 후속 모달을 열 수 있으므로 그때는 닫지 않는다.
  const runCommitFromModal = useCallback(async () => {
    if (!commitModal || commitRunning) return;
    const { item, wt, msg } = commitModal;
    if (!msg.trim()) return;
    setCommitRunning(true);
    try {
      await handleWorktreeCommit(item, wt, msg);
    } finally {
      setCommitRunning(false);
      setCommitModal(current => (current && current.wt.path === wt.path && current.msg === msg ? null : current));
    }
  }, [commitModal, commitRunning, handleWorktreeCommit]);

  const handleSuggestCommitMessage = useCallback(async () => {
    if (!commitModal || commitMessageGenerating) return;
    const targetPath = commitModal.wt.path;
    setCommitMessageGenerating(true);
    try {
      const message = await API.suggestGitCommitMessage(targetPath);
      setCommitModal(current =>
        current?.wt.path === targetPath ? { ...current, msg: message } : current,
      );
    } catch (error) {
      showToast(
        `AI 커밋 메시지 생성 실패: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      setCommitMessageGenerating(false);
    }
  }, [commitMessageGenerating, commitModal]);

  const handleWorktreePull = useCallback(async (item: PortInfo, wt: WorktreeInfo) => {
    if (wt.detached || !wt.branch) {
      showToast(
        wt.detached
          ? '분리된 HEAD 상태에서는 Pull할 수 없습니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결하세요.'
          : '현재 워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침하거나 브랜치를 체크아웃하세요.',
        'error',
      );
      return;
    }
    try {
      const output = await API.gitPull(wt.path);
      showToast(`풀 완료: ${wt.branch} ${output || 'up-to-date'}`, 'success');
      await refreshWorktreeAfterGitAction(item);
    } catch (error) {
      showToast(`풀 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      await refreshWorktreeAfterGitAction(item);
    }
  }, [refreshWorktreeAfterGitAction]);

  const handleWorktreePush = useCallback(async (item: PortInfo, wt: WorktreeInfo) => {
    if (wt.detached || !wt.branch) {
      showToast(
        wt.detached
          ? '분리된 HEAD 상태에서는 Push할 수 없습니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결하세요.'
          : '현재 워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침하거나 브랜치를 체크아웃하세요.',
        'error',
      );
      return;
    }
    if (!wt.githubConnected) {
      showToast('GitHub 원격(origin)이 연결되지 않아 푸시할 수 없습니다. 프로젝트 수정에서 GitHub 주소를 확인해주세요.', 'error');
      return;
    }
    try {
      await API.gitPush(wt.path);
      showToast(`푸시 완료: ${wt.branch}`, 'success');
      await refreshWorktreeAfterGitAction(item);
    } catch (error) {
      showToast(`푸시 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      await refreshWorktreeAfterGitAction(item);
    }
  }, [refreshWorktreeAfterGitAction]);

  const toggleWorktreePanel = useCallback((portId: string, folderPath?: string) => {
    setExpandedWorktreeIds(prev => {
      const next = new Set(prev);
      if (next.has(portId)) {
        next.delete(portId);
      } else {
        next.add(portId);
        if (folderPath) loadWorktrees(portId, folderPath, { fetchRemote: true, showResult: false });
      }
      return next;
    });
  }, [loadWorktrees]);

  const executeWorktreeAdd = useCallback(async (item: PortInfo, branchName: string) => {
    try {
      const source = await repositoryWorkflowApi.worktreeSource(item.folderPath!);
      if (!source.ready) throw new Error(source.message || '메인트리 변경을 먼저 커밋해주세요.');
      const result = await API.gitWorktreeAdd(item.folderPath!, branchName, undefined, terminalApp === 'orca');
      if (result.renamedFrom) {
        showToast(`브랜치 '${result.renamedFrom}'는 main에 없는 커밋을 갖고 있어 보존하고, 새 브랜치 '${result.branch}'로 워크트리를 만들었습니다.`, 'success');
      } else if (result.requestedBranch && result.requestedBranch !== result.branch) {
        // Orca가 이름을 정하는 경로 — 한글 등 비ASCII 이름이나 중복 이름이 조용히 바뀌던 문제
        showToast(`'${result.requestedBranch}' 대신 '${result.branch}' 브랜치로 만들었습니다 (Orca 관리 워크트리는 Orca가 이름을 정합니다).`, 'success');
      } else {
        showToast(`${result.orcaManaged ? 'Orca 관리 ' : ''}워크트리 생성됨: ${result.path.split('/').pop()}`, 'success');
      }
      setWorktreeNewBranch(prev => ({ ...prev, [item.id]: '' }));
      await loadWorktrees(item.id, item.folderPath!, { force: true });
    } catch (e) {
      showToast(`워크트리 생성 실패: ${e}`, 'error');
    }
  }, [loadWorktrees, terminalApp]);

  const handleWorktreeAdd = useCallback(async (item: PortInfo) => {
    const branchName = worktreeNewBranch[item.id]?.trim();
    if (!branchName || !item.folderPath) return;
    if (worktreeAddInflightRef.current.has(item.id)) return;
    worktreeAddInflightRef.current.add(item.id);
    try {
      // git 상태 확인 (read-only) — 네트워크 실패 시 null로 구별
      const status = await API.gitInit(item.folderPath, { checkOnly: true }).catch(() => null);
      if (status === null) {
        // 상태 확인 실패 (API 서버 오프라인 등) → 직접 시도 (git 없으면 worktreeAdd가 명확한 에러 반환)
        await executeWorktreeAdd(item, branchName);
      } else if (status.alreadyGit && status.hasCommit) {
        // 이미 git repo + 커밋 있음 → 바로 진행
        await executeWorktreeAdd(item, branchName);
      } else {
        // git 없거나 커밋 없음 → 사용자 확인 모달
        setGitInitConfirm({ item, branchName });
      }
    } finally {
      worktreeAddInflightRef.current.delete(item.id);
    }
  }, [worktreeNewBranch, executeWorktreeAdd]);

  const handleWorktreeGitInitialize = useCallback(async (item: PortInfo, reinitialize = false) => {
    if (!item.folderPath || worktreeGitBusy[item.id]) return;
    if (reinitialize) {
      const confirmed = window.confirm(
        '기존 Git 기록과 브랜치가 모두 삭제됩니다. 폴더의 파일은 유지됩니다.\n정말 Git 저장소를 초기화하고 다시 만들까요?'
      );
      if (!confirmed) return;
    }

    setWorktreeGitBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      const result = reinitialize
        ? await API.gitReinitialize(item.folderPath)
        : await API.gitInit(item.folderPath);
      if (result.error) throw new Error(result.error);
      if (!result.hasCommit) {
        setWorktreeGitStatus(prev => ({ ...prev, [item.id]: 'no-commit' }));
        showToast('Git 저장소는 생성됐지만 초기 커밋을 만들지 못했습니다. Git 사용자 설정을 확인하세요.', 'error');
        return;
      }
      const workflow = await repositoryWorkflowApi.upgrade(item.folderPath);
      setRepositoryWorkflowStatuses(prev => ({ ...prev, [item.id]: workflow }));
      setWorktreeGitStatus(prev => ({ ...prev, [item.id]: 'ready' }));
      showToast(reinitialize ? '로컬 Git 저장소를 다시 만들었습니다' : '로컬 Git 저장소를 만들었습니다', 'success');
      await loadWorktrees(item.id, item.folderPath);
    } catch (error) {
      showToast(`Git 저장소 생성 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      await loadWorktrees(item.id, item.folderPath);
    } finally {
      setWorktreeGitBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }, [loadWorktrees, worktreeGitBusy]);

  const handleRepositoryWorkflowUpgrade = useCallback(async (item: PortInfo) => {
    if (!item.folderPath || repositoryWorkflowBusy[item.id]) return;
    setRepositoryWorkflowBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      const status = await repositoryWorkflowApi.upgrade(item.folderPath);
      setRepositoryWorkflowStatuses(prev => ({ ...prev, [item.id]: status }));
      showToast(`저장소 작업 흐름 v${status.currentVersion} 업데이트 완료`, 'success');
    } catch (error) {
      showToast(`저장소 작업 흐름 업데이트 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setRepositoryWorkflowBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }, [repositoryWorkflowBusy]);

  const handleWorktreeUnlock = useCallback(async (item: PortInfo, wt: WorktreeInfo) => {
    if (!item.folderPath || worktreeBranchBusy[wt.path]) return;
    setWorktreeBranchBusy(prev => ({ ...prev, [wt.path]: true }));
    try {
      await API.gitWorktreeUnlock(item.folderPath, wt.path);
      showToast(`잠금 해제됨: ${wt.branch || wt.path.split('/').pop()} — 이제 삭제/브랜치 전환이 가능합니다.`, 'success');
      await loadWorktrees(item.id, item.folderPath);
    } catch (e) {
      showToast(`잠금 해제 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setWorktreeBranchBusy(prev => ({ ...prev, [wt.path]: false }));
    }
  }, [worktreeBranchBusy, loadWorktrees]);

  const executeWorktreeSwitchBranch = useCallback(async (item: PortInfo, wt: WorktreeInfo, branchName: string) => {
    if (!item.folderPath) return;
    setWorktreeBranchBusy(prev => ({ ...prev, [wt.path]: true }));
    try {
      const r = await API.gitWorktreeSwitchBranch(item.folderPath, wt.path, branchName);
      // 워크트리 카드가 옛 브랜치명을 물고 있으면 목록 갱신 때 어긋나므로 먼저 맞춰준다.
      setPorts(prev => prev.map(p => (p.worktreePath === wt.path && p.name?.includes(wt.branch || ''))
        ? { ...p, name: p.name.replace(wt.branch || '', r.branch) } : p));
      setSwitchBranchModal(null);
      showToast(`새 브랜치로 재사용: ${r.branch} (기준 ${r.base}) — 폴더와 의존성은 그대로입니다.`, 'success');
      await loadWorktrees(item.id, item.folderPath);
    } catch (e) {
      showToast(`브랜치 전환 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setWorktreeBranchBusy(prev => ({ ...prev, [wt.path]: false }));
    }
  }, [loadWorktrees]);

  const handleWorktreeRemove = useCallback((item: PortInfo, wt: WorktreeInfo) => {
    if (!item.folderPath) return;
    setDeleteWorktreeConfirm({ item, wt });
  }, []);

  /** 레거시 숨김 경로(.claude/worktrees/) 워크트리를 Orca가 인식하는 worktrees/ 로 옮긴다.
   *  사용자가 명시적으로 버튼을 눌렀을 때만 실행한다(자동 이동 금지 — 열려 있는 터미널/AI 세션의
   *  cwd가 옛 경로에 묶여 있을 수 있다). */
  const handleWorktreeMigrate = useCallback((item: PortInfo, wt: WorktreeInfo) => {
    if (!item.folderPath) return;
    // ⚠️ window.confirm은 JS 메인 스레드를 막아 setState/useEffect가 멈추므로 쓰지 않는다(기존 삭제 확인과 동일 패턴).
    setMigrateWorktreeConfirm({ item, wt });
  }, []);

  const executeWorktreeMigrate = useCallback(async () => {
    if (!migrateWorktreeConfirm) return;
    const { item, wt } = migrateWorktreeConfirm;
    if (!item.folderPath) return;
    setMigrateWorktreeConfirm(null);
    setWorktreeMigrating(prev => ({ ...prev, [wt.path]: true }));
    try {
      // 이동 중 그 폴더에서 dev 서버가 돌고 있으면 먼저 중지 (삭제와 동일한 이유 — 고아 프로세스 방지)
      const wtPortEntry = portsRef.current.find(p => p.worktreePath === wt.path || p.folderPath === wt.path);
      if (wtPortEntry?.port) {
        const stillRunning = await API.checkPortStatus(wtPortEntry.port).catch(() => false);
        if (stillRunning) {
          try { await API.stopCommand(wtPortEntry.id, wtPortEntry.port ?? 0); }
          catch { showToast('서버 중지 실패, 계속 진행합니다', 'error'); }
        }
      }
      const moved = await API.gitWorktreeMove(item.folderPath, wt.path);
      // 파생 포트 카드의 경로를 먼저 갱신 — 그대로 두면 loadWorktrees의 prune에 걸려 카드가 사라진다.
      let updated: PortInfo[] | null = null;
      setPorts(prev => {
        const next = prev.map(p => (p.worktreePath === moved.from || p.folderPath === moved.from)
          ? { ...p, worktreePath: p.worktreePath === moved.from ? moved.to : p.worktreePath, folderPath: p.folderPath === moved.from ? moved.to : p.folderPath }
          : p);
        if (next.some((p, i) => p !== prev[i])) updated = next;
        return next;
      });
      if (updated) API.savePorts(updated).catch(() => {});
      showToast(`새 경로로 옮겼습니다 — Orca 사이드바 반영에 몇 초 걸릴 수 있습니다`, 'success');
      await refreshOrcaWorktreePaths();
      await loadWorktrees(item.id, item.folderPath!, { force: true });
    } catch (e: any) {
      showToast(`워크트리 이동 실패: ${e?.message ?? e}`, 'error');
    } finally {
      setWorktreeMigrating(prev => { const next = { ...prev }; delete next[wt.path]; return next; });
    }
  }, [migrateWorktreeConfirm, refreshOrcaWorktreePaths, loadWorktrees]);

  const executeWorktreeDelete = useCallback(async () => {
    if (!deleteWorktreeConfirm) return;
    const { item, wt } = deleteWorktreeConfirm;
    const name = wt.path.split('/').pop();
    if (!item.folderPath) {
      setDeleteWorktreeConfirm(null);
      showToast('워크트리 제거 실패: 메인 저장소 경로가 없습니다.', 'error');
      return;
    }
    setDeleteWorktreeConfirm(null);
    try {
      // 워크트리 디렉토리를 지우기 전, 그 위에서 돌고 있는 dev 서버가 있으면 먼저 중지
      // (git worktree remove가 디렉토리를 삭제하면 cwd가 사라진 채 프로세스만 남는 고아 상태가 됨)
      const wtPortEntry = portsRef.current.find(p =>
        p.worktreePath === wt.path ||
        (wt.branch && p.worktreePath === wt.branch) ||
        (p.worktreePath && wt.path.endsWith('/' + p.worktreePath.replace(/^\/+/, ''))) ||
        p.folderPath === wt.path
      );
      if (wtPortEntry?.port) {
        const stillRunning = await API.checkPortStatus(wtPortEntry.port).catch(() => false);
        if (stillRunning) {
          try {
            await API.stopCommand(wtPortEntry.id, wtPortEntry.port ?? 0);
          } catch (e) {
            showToast('서버 중지 실패, 계속 진행합니다', 'error');
          }
        }
      }
      // 배지와 **같은 규칙**으로 소유권을 판정한다. "Orca 목록에 있다"만 보면
      // 앱이 만든 평범한 워크트리까지 Orca CLI 삭제로 새어나간다(Orca가 없으면 삭제 불가).
      const { orcaManaged } = classifyWorktreeSource({
        repoRoot: item.folderPath,
        worktreePath: wt.path,
        orcaPaths: orcaWorktreePaths.paths,
      });
      await API.gitWorktreeRemove(item.folderPath, wt.path, orcaManaged);
      showToast(`워크트리 제거됨: ${name}`, 'success');
      // 워크트리 "실행" 시 자동 등록됐던 프로젝트 카드도 함께 정리 (폴더가 사라진 카드가 남지 않도록)
      setPorts(prev => prev.filter(p =>
        p.worktreePath !== wt.path &&
        !(wt.branch && p.worktreePath === wt.branch) &&
        p.folderPath !== wt.path
      ));
      await loadWorktrees(item.id, item.folderPath!, { force: true });
    } catch (e) {
      showToast(`워크트리 제거 실패: ${e}`, 'error');
    }
  }, [deleteWorktreeConfirm, loadWorktrees, orcaWorktreePaths.paths]);

  const handleWorktreeMerge = useCallback(async (item: PortInfo, wt: WorktreeInfo) => {
    if (!item.folderPath) { showToast('folderPath가 없습니다', 'error'); return; }
    if (wt.detached) {
      showToast('분리된 HEAD 상태는 머지할 브랜치가 아닙니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결하세요.', 'error');
      return;
    }
    if (!wt.branch) { showToast('워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침하거나 브랜치를 체크아웃하세요.', 'error'); return; }
    if (typeof wt.aheadCount !== 'number') {
      showToast('메인 브랜치와의 차이를 확인하지 못했습니다. 원격 새로고침 후 다시 시도하세요.', 'error');
      return;
    }
    if (wt.aheadCount <= 0) {
      showToast('main과 비교해 머지할 변경사항이 없습니다.', 'error');
      return;
    }
    // 프리뷰 로드 후 확인 모달 표시
    setMergeLoading(true);
    try {
      const baseUrl = isTauri() ? 'http://localhost:3001' : '';
      const res = await fetch(`${baseUrl}/api/git-merge-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: item.folderPath, branchName: wt.branch }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 진행 중인 머지 → 바로 에러 모달 (Abort 버튼 포함)
        if (data.hasMergeInProgress) {
          setMergeError({ message: data.error, hasConflict: true, folderPath: item.folderPath!, item, wt });
          // load conflicted files
          fetch(`${baseUrl}/api/git-conflicts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath: item.folderPath }),
          }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }).then(d => setMergeConflictFiles(d.files ?? [])).catch(e => showToast(`충돌 파일 로드 실패: ${String(e)}`, 'error'));
        } else {
          throw new Error(data.error ?? '프리뷰 실패');
        }
        return;
      }
      setMergeConfirm({ item, wt, mainBranch: data.mainBranch, commits: data.commits, stat: data.stat, isDirty: data.isDirty });
    } catch (e) {
      showToast(`프리뷰 실패: ${(e as Error).message}`, 'error');
    } finally {
      setMergeLoading(false);
    }
  }, []);

  const executeMerge = useCallback(async () => {
    if (!mergeConfirm) return;
    const { item, wt } = mergeConfirm;
    setMergeLoading(true);
    try {
      const output = await API.gitMergeBranch(item.folderPath!, wt.branch!);
      if (import.meta.env.DEV && output) console.log('[Merge output]', output);
      // 머지 다음에 뭘 해야 할지가 늘 막혔던 지점 — 재사용/삭제 두 갈래를 여기서 알려준다.
      showToast(`머지 완료: ${wt.branch} → ${mergeConfirm.mainBranch}\n이 워크트리는 '새 브랜치'로 재사용하거나 삭제할 수 있습니다.`, 'success');
      setMergeConfirm(null);
      setMergePushConfirm({ item, mainBranch: mergeConfirm.mainBranch });
      setDeleteWorktreeConfirm({ item, wt });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setMergeConfirm(null);
      const hasConflict = msg.includes('충돌') || msg.includes('CONFLICT');
      setMergeError({ message: msg, hasConflict, folderPath: item.folderPath!, item, wt });
      if (hasConflict) {
        const baseUrl2 = isTauri() ? 'http://localhost:3001' : '';
        fetch(`${baseUrl2}/api/git-conflicts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: item.folderPath }),
        }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }).then(d => setMergeConflictFiles(d.files ?? [])).catch(e => showToast(`충돌 파일 로드 실패: ${String(e)}`, 'error'));
      }
    } finally {
      setMergeLoading(false);
    }
  }, [mergeConfirm, loadWorktrees]);

  const openTmuxClaude = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    recordVisit(item.id);
    return _executeTmuxClaude(item, worktreePath);
  };

  const checkWslReady = async (): Promise<boolean> => {
    if (!isWindows()) return true;
    try {
      const { status } = await API.checkWsl();
      if (status === 'ready') return true;
      setWslSetupStatus(status);
      return false;
    } catch {
      return true; // WSL 확인 실패 시 그냥 진행
    }
  };

  const handleInstallWslTmux = async () => {
    showToast('tmux 설치 중...', 'success');
    try {
      await API.installWslTmux();
      showToast('tmux 설치 완료!', 'success');
    } catch (e) {
      showToast(`tmux 설치 실패: ${e}`, 'error');
    }
  };

  const openTmuxClaudeFresh = async (item: PortInfo): Promise<boolean> => {
    if (!await checkWslReady()) return false;
    const sessionName = getSessionName(item);
    try {
      await API.openTmuxClaudeFresh(sessionName, item.folderPath, undefined, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      showToast(`tmux 새 세션${bypassPermissions ? ' ⚡' : ''} 시작 ↺`, 'success');
      return true;
    } catch (e) {
      return reportOperationError('agent.claude.tmux-fresh', 'tmux 새 세션 실패', item, item.folderPath, e);
    }
  };

  const _executeTmuxClaude = async (item: PortInfo, worktreePath: string | undefined): Promise<boolean> => {
    if (!await checkWslReady()) return false;
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    // 백엔드에 넘기는 것은 접미사 없는 기본 이름이다 — 워크트리·bypass 접미사는
    // 명령을 만드는 쪽(api-server / Rust)이 tmuxSessionName()으로 한 번만 붙인다.
    // 여기서 미리 붙이면 이중 적용된다. 아래 표시용 이름만 같은 함수로 계산한다.
    const sessionName = getSessionName(item);
    const shownSession = tmuxSessionName(sessionName, context.worktreePath, bypassPermissions);
    try {
      if (bypassPermissions) {
        await API.openTmuxClaudeBypass(sessionName, context.workingPath, context.worktreePath, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      } else {
        await API.openTmuxClaude(sessionName, context.workingPath, context.worktreePath, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      }
      showToast(`tmux + Claude${bypassPermissions ? ' ⚡' : ''} 실행 중 (${shownSession})`, 'success');
      return true;
    } catch (e) {
      return reportOperationError('agent.claude.tmux', 'tmux 실행 실패', item, context.workingPath, e);
    }
  };

  const openTerminalClaude = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    recordVisit(item.id);
    return _executeTerminalClaude(item, worktreePath);
  };

  const _executeTerminalClaude = async (item: PortInfo, worktreePath: string | undefined): Promise<boolean> => {
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    try {
      const displayName = item.aiName || item.name;
      if (bypassPermissions) {
        await API.openTerminalClaudeBypass(context.workingPath, displayName, context.worktreePath, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      } else {
        await API.openTerminalClaude(context.workingPath, displayName, context.worktreePath, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      }
      showToast(`iTerm Claude${bypassPermissions ? ' ⚡' : ''} 실행 중`, 'success');
      return true;
    } catch (e) {
      return reportOperationError('agent.claude.terminal', 'Claude 실행 실패', item, context.workingPath, e);
    }
  };


  const openTmuxClaudeNew = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    if (!await checkWslReady()) return false;
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    // Must match the name "실행" uses, or this replaces a session nobody is in.
    // 둘 다 기본 이름만 넘기므로 백엔드의 tmuxSessionName()이 같은 세션을 가리킨다.
    const sessionName = getSessionName(item);
    try {
      await API.openTmuxClaudeFresh(sessionName, context.workingPath, context.worktreePath, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm');
      showToast(`tmux 새창${bypassPermissions ? ' ⚡' : ''} 시작 ↺`, 'success');
      return true;
    } catch (e) {
      return reportOperationError('agent.claude.tmux-new', 'tmux 새창 실패', item, context.workingPath, e);
    }
  };

  // cmux invocation — Tauri uses Rust commands, browser falls back to api-server.
  const callCmux = async (
    rustCmd: 'open_cmux_claude' | 'open_cmux_claude_new' | 'open_cmux_codex' | 'open_cmux_agy' | 'open_cmux_hermes' | 'open_cmux_terminal' | 'open_cmux_localhost' | 'open_cmux_tmux' | 'open_cmux_agent_view' | 'open_cmux_project_agents' | 'open_claude_bg',
    httpPath: '/api/open-cmux-claude' | '/api/open-cmux-claude-new' | '/api/open-cmux-codex' | '/api/open-cmux-agy' | '/api/open-cmux-hermes' | '/api/open-cmux-terminal' | '/api/open-cmux-localhost' | '/api/open-cmux-tmux' | '/api/open-cmux-agent-view' | '/api/open-cmux-project-agents' | '/api/open-claude-bg',
    body: { folderPath?: string; worktreePath?: string; bypass?: boolean; name?: string; port?: number; fresh?: boolean },
    { retry = 0 }: { retry?: number } = {}
  ): Promise<string> => {
    if (isTauri()) {
      return await invoke<string>(rustCmd, body as any);
    }
    // Worktree dev servers proxy their matching API sidecar. Calling port 3001 directly
    // can launch an agent from a different worktree's server, so browser mode must stay relative.
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    const res = await fetch(`${baseUrl}${httpPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data?.success === false) {
      // WSL agent 엔드포인트는 첫 호출 distro 캐시 미워밍업으로 실패 가능 → 1회 재시도
      if (retry > 0 && httpPath.includes('agent')) {
        await new Promise(r => setTimeout(r, 600));
        return callCmux(rustCmd, httpPath, body, { retry: retry - 1 });
      }
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    return data?.message ?? 'OK';
  };

  // Orca(onorca.dev) 호출 — Tauri는 Rust 커맨드, 브라우저는 api-server 폴백.
  // agent: CLI agents or a plain terminal. Desktop app actions never use Orca.
  const callOrca = async (
    agent: 'claude' | 'codex' | 'agy' | 'hermes' | 'agents' | 'terminal',
    item: PortInfo,
    worktreePath?: string,
    newWindow = false,
  ): Promise<string> => {
    return runOrcaOperation(async () => {
      // HOME/.claude/.codex 같은 전역 바로가기는 Orca worktree가 아니므로 항상
      // Floating Workspace를 사용한다. 이 선택자는 프로젝트/워크트리 실행에만 적용된다.
      // 메인 프로젝트도 Orca에서는 하나의 worktree 표면이다. 명시적인 연결
      // worktree가 없다는 이유만으로 `undefined`를 넘기면 "워크트리 내부" 선택이
      // 무시되고 Floating으로 되돌아간다. 실제 실행 대상 경로 전체로 판정한다.
      const orcaSurfacePath = worktreePath ?? item.worktreePath ?? item.folderPath;
      const floating = shouldUseOrcaFloatingTerminal(orcaSurfacePath, orcaLaunchMode);
      const body = {
        agent,
        name: getSessionName(item),
        folderPath: item.folderPath,
        worktreePath,
        bypass: bypassPermissions,
        floating,
        newWindow,
      };
      if (isTauri()) {
        return await invoke<string>('open_orca_agent', body as any);
      }
      // 브라우저 개발 모드에서는 현재 Vite 인스턴스의 /api 프록시를 사용해야
      // 워크트리별 PORT/API_PORT 쌍을 우회하지 않는다.
      const baseUrl = isTauri() ? 'http://localhost:3001' : '';
      const res = await fetch(`${baseUrl}/api/open-orca-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data?.message ?? 'OK';
    });
  };

  const callOrcaLocalhost = async (item: PortInfo, worktreePath?: string): Promise<string> => {
    const targetPath = worktreePath ?? item.worktreePath;
    // Orca의 `global-floating-terminal`은 터미널 전용 pseudo-worktree다. 현재 Orca CLI의
    // `tab create`는 여기에 브라우저 탭을 만들 수 없어 selector_not_found를 반환한다.
    // 브라우저 미리보기는 터미널 표면 설정과 분리해 사용자가 누른 프로젝트/워크트리에
    // 정확히 연결한다. 그래야 다른 프로젝트가 앞에 있어도 선택한 탭으로 전환된다.
    const floating = false;
    if (targetPath && hasHiddenOrcaPathSegment(targetPath)) {
      throw new Error('이 워크트리는 숨김 경로라 Orca 화면에 브라우저 탭이 표시되지 않을 수 있습니다. WORKTREES의 “새 경로로 옮기기”를 먼저 실행하거나 기본 브라우저를 사용하세요. 탭은 생성하지 않았습니다.');
    }
    return runOrcaOperation(async () => {
      const body = {
        port: item.port,
        folderPath: item.folderPath,
        worktreePath: worktreePath ?? item.worktreePath,
        floating,
      };
      if (isTauri()) {
        return await invoke<string>('open_orca_localhost', body as any);
      }
      const res = await fetch('/api/open-orca-localhost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data?.message ?? 'OK';
    });
  };

  const showOrcaActionSuccess = (
    action: OrcaWorktreeAction,
    item: PortInfo,
    worktreePath: string | undefined,
    backendMessage: string,
    floating = true,
  ) => {
    if (action !== 'browser') {
      // `floating`은 이 실행이 요청한 값일 뿐이다 — 백엔드가 워크트리 선택자 실패로
      // Floating으로 조용히 대체했을 수 있으므로(selector_not_found 폴백), 실제로
      // 어느 표면에서 열렸는지는 백엔드 메시지에서 다시 읽는다. 그렇지 않으면 토스트가
      // "Floating으로 열었습니다"와 "워크트리 내부 터미널로 실행했습니다"를 동시에
      // 말해 사용자에게 모순된 결과를 보여준다(2026-08-10 실측).
      const observedSurface = orcaSurfaceFromLaunchMessage(backendMessage);
      const actualFloating = observedSurface === null ? floating : observedSurface === 'floating';
      const surface = actualFloating ? 'Orca Floating Workspace' : 'Orca 워크트리 내부 터미널';
      const reused = backendMessage.includes('기존') && backendMessage.includes('재사용했습니다');
      const revealWarning = backendMessage.includes('⚠');
      const detail = reused
        ? `선택한 프로젝트/워크트리의 기존 ${surface} 탭을 표시했습니다. 실행 중인 에이전트에는 명령을 다시 보내지 않았습니다.`
        : `선택한 프로젝트/워크트리 경로에서 ${surface}로 실행했습니다.`;
      showToast(`${backendMessage}\n${detail}`, revealWarning ? 'warning' : 'success', revealWarning ? 14_000 : 10_000);
      return;
    }
    const visibility = classifyOrcaWorktreeVisibility({
      repositoryPath: item.folderPath,
      worktreePath: worktreePath ?? item.worktreePath,
      isMain: !(worktreePath ?? item.worktreePath),
      listingAvailable: orcaWorktreePaths.available,
      listedPaths: orcaWorktreePaths.paths,
    });
    const notice = formatOrcaWorktreeActionNotice({ action, visibility });
    const nextStep: Record<OrcaWorktreeAction, string> = {
      claude: 'Orca Floating Workspace에서 Claude 입력 화면을 확인하세요.',
      codex: 'Orca Floating Workspace에서 Codex를 확인하세요. 처음 실행이면 “Hooks need review” 확인을 완료하세요.',
      agy: 'Orca Floating Workspace에서 agy를 확인하세요. 처음 실행이면 “Yes, I trust this folder”를 선택하고 Enter를 누르세요.',
      hermes: 'Orca Floating Workspace에서 Hermes CLI를 확인하세요.',
      browser: 'Orca가 해당 워크트리의 새 브라우저 탭으로 전환했습니다.',
    };
    const needsSidebarNotice = visibility === 'hidden-path' || visibility === 'unlisted' || visibility === 'unknown';
    // 전역 1회 팝업을 사용하지 않는다. Claude/Codex/agy/브라우저 각각의 클릭 결과에
    // 해당 워크트리 경로와 사이드바 표시 제약을 함께 알려야 사용자가 성공/실패를 구분할 수 있다.
    const revealWarning = backendMessage.includes('⚠');
    const warning = needsSidebarNotice || revealWarning;
    showToast(`${backendMessage}\n${notice}\n${nextStep[action]}`, warning ? 'warning' : 'success', warning ? 14_000 : 10_000);
  };

  const openOrcaAgent = async (
    agent: 'claude' | 'codex' | 'agy' | 'terminal',
    item: PortInfo,
    worktreePath?: string,
    newWindow = false,
  ): Promise<boolean> => {
    // 게이트(ensureAgentWorktreeReady = 워크트리 검증 + 로컬 설정 시딩)는 호출자인
    // openClaudeMain에서 이미 거친다. 여기서 다시 부르면 ls-tree로 전체 파일을 세는
    // 무거운 검사가 AI 실행마다 두 번 돈다 — 새 호출부를 추가할 땐 게이트를 거쳤는지 확인할 것.
    recordVisit(item.id);
    try {
      const msg = await callOrca(agent, item, worktreePath, newWindow);
      if (agent === 'terminal') showToast(msg, 'success');
      else showOrcaActionSuccess(
        agent,
        item,
        worktreePath,
        msg,
        shouldUseOrcaFloatingTerminal(worktreePath ?? item.worktreePath ?? item.folderPath, orcaLaunchMode),
      );
      return true;
    } catch (e: any) {
      return reportOperationError(`orca.${agent}`, 'Orca 실행 실패', item, worktreePath ?? item.folderPath, e);
    }
  };

  // Orca 앱 실행 — Tauri 커맨드 또는 api-server 폴백
  const openOrcaApp = async (): Promise<string> => {
    if (isTauri()) {
      return await invoke<string>('open_orca_app');
    }
    const res = await fetch('/api/open-orca-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok || data?.success === false) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data?.message ?? 'OK';
  };

  // cmux 는 macOS 전용 (Swift+AppKit) — Linux/WSL 빌드 자체가 존재하지 않아 대안 불가.
  // Windows 사용자는 카드 ⌄ 메뉴의 'tmux'/'tmux ↺ 새창' 항목 사용.
  const cmuxMacOnlyToast = () => showToast('cmux는 macOS 전용입니다 — Windows에서는 ⌄ 메뉴의 "tmux" 사용', 'error');

  const openCmuxClaudeNew = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    if (isWindows()) { cmuxMacOnlyToast(); return false; }
    recordVisit(item.id);
    try {
      const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
      const msg = await callCmux('open_cmux_claude_new', '/api/open-cmux-claude-new', {
        name: getSessionName(item),
        folderPath: context.workingPath,
        worktreePath: context.worktreePath,
        bypass: bypassPermissions,
      });
      showToast(msg, 'success');
      return true;
    } catch (e: any) {
      return reportOperationError('agent.claude.cmux-new', 'cmux 새창 실패', item, worktreePath ?? item.folderPath, e);
    }
  };

  const openCmuxClaude = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    if (isWindows()) { cmuxMacOnlyToast(); return false; }
    recordVisit(item.id);
    try {
      const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
      const msg = await callCmux('open_cmux_claude', '/api/open-cmux-claude', {
        name: getSessionName(item),
        folderPath: context.workingPath,
        worktreePath: context.worktreePath,
        bypass: bypassPermissions,
      });
      showToast(msg, 'success');
      return true;
    } catch (e: any) {
      return reportOperationError('agent.claude.cmux', 'cmux 실행 실패', item, worktreePath ?? item.folderPath, e);
    }
  };

  const openCmuxTerminal = async (item: PortInfo) => {
    if (!item.folderPath) { showToast('폴더 경로가 없습니다.', 'error'); return; }
    if (isWindows()) { cmuxMacOnlyToast(); return; }
    recordVisit(item.id);
    try {
      const msg = await callCmux('open_cmux_terminal', '/api/open-cmux-terminal', {
        name: getSessionName(item),
        folderPath: item.folderPath,
      });
      showToast(msg, 'success');
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`cmux 터미널 실패: ${raw}`, 'error');
    }
  };

  const openTmuxOnCmux = async (item: PortInfo, fresh = false, worktreePath?: string): Promise<boolean> => {
    if (isWindows()) { cmuxMacOnlyToast(); return false; }
    recordVisit(item.id);
    try {
      const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
      const msg = await callCmux('open_cmux_tmux', '/api/open-cmux-tmux', {
        name: getSessionName(item), folderPath: context.workingPath, worktreePath: context.worktreePath, bypass: bypassPermissions, fresh,
      });
      showToast(msg, 'success');
      return true;
    } catch (e: any) {
      return reportOperationError('agent.claude.cmux-tmux', 'cmux tmux 실패', item, worktreePath ?? item.folderPath, e);
    }
  };

  const openCmuxLocalhost = async (item: PortInfo) => {
    if (isWindows()) { cmuxMacOnlyToast(); return; }
    if (!item.port) { showToast('포트 번호가 없습니다', 'error'); return; }
    try {
      const msg = await callCmux('open_cmux_localhost', '/api/open-cmux-localhost', {
        port: item.port, name: item.name,
      });
      showToast(msg, 'success');
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`cmux localhost 실패: ${raw}`, 'error');
    }
  };

  const openOrcaLocalhost = async (item: PortInfo, worktreePath?: string): Promise<boolean> => {
    if (!item.port) { showToast('포트 번호가 없습니다', 'error'); return false; }
    if (!(worktreePath || item.worktreePath || item.folderPath)) {
      showToast('Orca에서 열 프로젝트 경로가 없습니다.', 'error');
      return false;
    }
    recordVisit(item.id);
    try {
      const msg = await callOrcaLocalhost(item, worktreePath);
      showOrcaActionSuccess('browser', item, worktreePath, msg);
      return true;
    } catch (e: any) {
      return reportOperationError('orca.browser', 'Orca localhost 실패', item, worktreePath ?? item.worktreePath ?? item.folderPath, e);
    }
  };

  const openBrowserWithDiagnostics = async (
    item: PortInfo,
    url: string,
    projectPath = item.worktreePath ?? item.folderPath,
    profile: BrowserProfile | null = null,
  ): Promise<boolean> => {
    try {
      await API.openInChrome(url, profile);
      return true;
    } catch (error) {
      return reportOperationError('browser.open', '브라우저 열기 실패', item, projectPath, error);
    }
  };

  const openDeploymentWithDiagnostics = async (item: PortInfo): Promise<boolean> => {
    if (!item.deployUrl) {
      showToast('배포 주소가 없습니다', 'error');
      return false;
    }
    return openBrowserWithDiagnostics(
      item,
      item.deployUrl,
      item.worktreePath ?? item.folderPath,
      selectedDeploymentBrowserProfile,
    );
  };

  // 상단에서 고른 Chrome 프로필은 단순한 "배포 전용" 설정이 아니라 웹 계정 선택이다.
  // GitHub 권한도 그 로그인 세션에 묶이므로 프로젝트의 모든 GitHub 열기 경로가 같은
  // 프로필을 써야 한다. 기본 프로필을 고르면 기존 동작 그대로 profile=null로 열린다.
  const openGitHubWithDiagnostics = async (item: PortInfo, url: string): Promise<boolean> =>
    openBrowserWithDiagnostics(
      item,
      url,
      item.worktreePath ?? item.folderPath,
      selectedDeploymentBrowserProfile,
    );

  const openSelectedTerminalAtRoot = async () => {
    try {
      let msg: string;
      if (terminalApp === 'cmux') {
        if (isWindows()) { cmuxMacOnlyToast(); return; }
        msg = await callCmux('open_cmux_terminal', '/api/open-cmux-terminal', { name: 'home', folderPath: '' });
      } else if (terminalApp === 'orca') {
        const homeItem: PortInfo = { id: 'orca-home', name: 'home', port: 0, folderPath: '~', isRunning: false };
        msg = await callOrca('terminal', homeItem);
      } else if (terminalApp === 'iterm' || terminalApp === 'terminal') {
        msg = await API.openTerminalAtFolder('~', 'home', terminalApp);
      } else {
        msg = await API.openTerminalAgentView();
      }
      showToast(msg, 'success');
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`${terminalApp} 터미널 실패: ${raw}`, 'error');
    }
  };

  const openCmuxAgentView = async () => {
    if (isWindows()) {
      try {
        const msg = await API.openTerminalAgentView();
        showToast(msg, 'success');
      } catch (e: any) {
        const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
        showToast(`에이전트 열기 실패: ${raw}`, 'error');
      }
      return;
    }
    try {
      if (terminalApp === 'orca') {
        const homeItem: PortInfo = { id: 'orca-agents', name: 'agents', port: 0, folderPath: '~', isRunning: false };
        const msg = await callOrca('agents', homeItem);
        showToast(msg, 'success');
      } else if (terminalApp === 'cmux') {
        const msg = await callCmux('open_cmux_agent_view', '/api/open-cmux-agent-view', {
          bypass: bypassPermissions,
        }, { retry: 1 });
        showToast(msg, 'success');
      } else if (terminalApp === 'iterm' || terminalApp === 'terminal') {
        const msg = await API.openTerminalAgentView(terminalApp, bypassPermissions);
        showToast(msg, 'success');
      } else {
        const msg = await API.openTerminalAgentView(undefined, bypassPermissions);
        showToast(msg, 'success');
      }
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`Agent View 실패: ${raw}`, 'error');
    }
  };

  const openClaudeAtDotClaude = async () => {
    const item: PortInfo = { id: '.claude', name: '.claude', port: 0, folderPath: '~/.claude', isRunning: false };
    try {
      await openClaudeMain(item);
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`Claude 열기 실패: ${raw}`, 'error');
    }
  };

  const openCodexAtDotCodex = async () => {
    const item: PortInfo = { id: '.codex', name: '.codex', port: 0, folderPath: '~/.codex', isRunning: false };
    await openCodexMain(item);
  };

  const openAgyAtHome = async () => {
    const item: PortInfo = { id: 'agy-home', name: 'agy', port: 0, folderPath: '~', isRunning: false };
    await openAntigravityMain(item);
  };

  const openHermesAtDotHermes = async () => {
    const item: PortInfo = { id: '.hermes', name: '.hermes', port: 0, folderPath: '~/.hermes', isRunning: false };
    await openHermesMain(item);
  };

  const openCmuxProjectAgents = async (item: PortInfo) => {
    if (isWindows() && terminalApp !== 'wsl') { cmuxMacOnlyToast(); return; }
    recordVisit(item.id);
    try {
      const msg = await callCmux('open_cmux_project_agents', '/api/open-cmux-project-agents', {
        folderPath: item.folderPath,
        name: getSessionName(item),
        bypass: bypassPermissions,
      }, { retry: 1 });
      showToast(msg, 'success');
    } catch (e: any) {
      const raw = typeof e === 'string' ? e : (e?.message ?? String(e));
      showToast(`cmux Project Sessions 실패: ${raw}`, 'error');
    }
  };


  /**
   * `claude --bg` has no terminal window of its own. Always follow it by opening
   * the matching Agent View on the surface the user chose in the header, otherwise
   * the detail panel's “selected terminal” promise is false.
   */
  const openClaudeBgAgentView = async (
    item: PortInfo,
    context: AgentLaunchContext,
    newWindow = false,
  ): Promise<string> => {
    const name = getSessionName(item);
    if (terminalApp === 'cmux') {
      return callCmux('open_cmux_project_agents', '/api/open-cmux-project-agents', {
        folderPath: context.workingPath,
        name,
        bypass: bypassPermissions,
      }, { retry: 1 });
    }
    if (terminalApp === 'orca') {
      // isClaudeBgAvailable gates this to the Floating surface before we get here.
      return callOrca('agents', item, context.worktreePath, newWindow);
    }
    if (terminalApp === 'iterm' || terminalApp === 'terminal') {
      return API.openTerminalAgentView(terminalApp, bypassPermissions, context.workingPath, name);
    }
    return API.openTerminalAgentView(undefined, bypassPermissions, context.workingPath, name);
  };

  const openClaudeBg = async (item: PortInfo, worktreePath?: string, newWindow = false): Promise<boolean> => {
    // claude --bg는 Windows에서 WSL을 통해 실행된다 — cmux 여부와 무관 (orca 포함 모든 터미널앱 공용).
    if (isWindows() && !await checkWslReady()) return false;
    // openOrcaAgent와 마찬가지로 게이트는 호출자(openClaudeMain)가 이미 거친다.
    recordVisit(item.id);
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    try {
      const startedMessage = await callCmux('open_claude_bg', '/api/open-claude-bg', {
        folderPath: context.workingPath,
        name: getSessionName(item),
        bypass: bypassPermissions,
      });
      try {
        const agentViewMessage = await openClaudeBgAgentView(item, context, newWindow);
        showToast(`${startedMessage}\n${agentViewMessage}\n${selectedTerminalSurface}에서 claude agents를 열었습니다.`, 'success', 10_000);
      } catch (agentViewError: any) {
        const raw = typeof agentViewError === 'string' ? agentViewError : (agentViewError?.message ?? String(agentViewError));
        // The background agent already started, so do not misreport this as a total launch failure.
        showToast(`${startedMessage}\n⚠ ${selectedTerminalSurface}에서 claude agents를 열지 못했습니다: ${raw}`, 'warning', 14_000);
      }
      return true;
    } catch (e: any) {
      return reportOperationError('agent.claude.background', 'claude --bg 실패', item, context.workingPath, e);
    }
  };

  const deferFirstAgentTaskIfNeeded = async (
    agent: FirstTaskAgent,
    item: PortInfo,
    options: { isNew?: boolean; worktreePath?: string; skip?: boolean } = {},
  ): Promise<boolean> => {
    if (options.skip || options.worktreePath || !item.folderPath) return false;
    try {
      const cached = repositoryWorkflowStatuses[item.id];
      const status = cached ?? await repositoryWorkflowApi.status(item.folderPath);
      if (!cached) setRepositoryWorkflowStatuses(prev => ({ ...prev, [item.id]: status }));
      if (status.isGit && !status.updateAvailable && status.firstTaskPending) {
        setFirstTaskBranchName(defaultFirstTaskBranchName());
        setFirstTaskLaunch({ agent, item, isNew: options.isNew });
        return true;
      }
    } catch {
      // 저장소 작업 흐름이 설치되지 않았거나 로컬 서비스가 잠시 준비되지 않은
      // 기존 프로젝트는 이전과 동일하게 AI 실행을 계속 허용한다.
    }
    return false;
  };

  const ensureAgentWorktreeReady = async (
    item: PortInfo,
    context: AgentLaunchContext,
  ): Promise<boolean> => {
    if (!context.isLinkedWorktree || !context.worktreePath || !context.repositoryPath) return true;
    try {
      const status = await repositoryWorkflowApi.worktreeLaunch(context.repositoryPath, context.worktreePath);
      if (status.ready) return true;
      showToast(status.message || '워크트리 프로젝트 상태를 확인해주세요.', 'error');
      return false;
    } catch (error) {
      showToast(`워크트리 확인 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    }
  };

  // isNew는 세 에이전트에 같은 의미다 — 기본 실행은 기존 창 재사용(가능한 표면에서),
  // isNew는 항상 새 창. Claude에만 있던 선택지를 Codex/agy로 동일하게 넓혔다.
  const openCodexMain = async (item: PortInfo, worktreePath?: string, skipFirstTaskRouting = false, isNew = false): Promise<boolean> => {
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    if (!context.workingPath) { showToast('폴더 경로가 없습니다.', 'error'); return false; }
    if (await deferFirstAgentTaskIfNeeded('codex', item, { worktreePath: context.worktreePath, skip: skipFirstTaskRouting })) return false;
    if (!await ensureAgentWorktreeReady(item, context)) return false;
    recordVisit(item.id);
    const sessionName = getSessionName(item);
    try {
      if (terminalApp === 'cmux') {
        if (isWindows()) { cmuxMacOnlyToast(); return false; }
        const msg = await callCmux('open_cmux_codex', '/api/open-cmux-codex', { name: sessionName, folderPath: context.workingPath, worktreePath: context.worktreePath, bypass: bypassPermissions });
        showToast(msg, 'success');
      } else if (terminalApp === 'orca') {
        const msg = await callOrca('codex', item, context.worktreePath, isNew);
        showOrcaActionSuccess(
          'codex',
          item,
          context.worktreePath,
          msg,
          shouldUseOrcaFloatingTerminal(context.workingPath, orcaLaunchMode),
        );
      } else if (terminalApp === 'wsl' || ((terminalApp === 'iterm' || terminalApp === 'terminal') && tmuxMode)) {
        await API.openTmuxCodex(sessionName, context.workingPath, context.worktreePath, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm', isNew);
        showToast(`tmux + Codex${bypassPermissions ? ' ⚡' : ''} ${isNew ? '새 세션 시작' : '실행 중'} (${tmuxSessionName(sessionName, context.worktreePath, bypassPermissions)})`, 'success');
      } else if (terminalApp === 'powershell') {
        // powershell — Terminal.app fallback
        await API.openTerminalCodex(context.workingPath, sessionName, context.worktreePath, bypassPermissions);
        showToast(`Codex${bypassPermissions ? ' ⚡' : ''} 실행 중`, 'success');
      } else {
        await API.openTerminalCodex(context.workingPath, sessionName, context.worktreePath, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        showToast(`${terminalApp} Codex${bypassPermissions ? ' ⚡' : ''} 실행 중`, 'success');
      }
      return true;
    } catch (e: any) {
      return reportOperationError('agent.codex.launch', 'Codex 실행 실패', item, context.workingPath, e);
    }
  };

  const openProjectCodeApp = async (
    agent: 'codex' | 'claude' | 'hermes',
    item: PortInfo,
    worktreePath?: string,
  ) => {
    if (isDeployedWeb()) {
      showToast('데스크톱 코드 앱 열기는 로컬 앱 또는 localhost에서만 사용할 수 있습니다.', 'error');
      return;
    }
    if (agent === 'hermes' && blockedByMissingHermes()) return;
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    const targetPath = context.workingPath;
    if (!targetPath) {
      showToast('폴더 경로가 없습니다.', 'error');
      return;
    }
    if (!await ensureAgentWorktreeReady(item, context)) return;
    try {
      const result = await API.openCodeApp(agent, targetPath);
      const targetName = context.worktreePath
        ? context.worktreePath.replace(/[/\\]+$/, '').split(/[\\/]/).pop() || item.name
        : item.name;
      if (agent === 'claude') {
        showToast(
          `Claude Code 앱 열기 요청됨: ${targetName}${result.confirmationRequired ? ' · 폴더 확인을 승인하세요' : ''}`,
          'success',
        );
      } else if (agent === 'codex') {
        showToast(`ChatGPT 앱의 Codex에서 열기 요청됨: ${targetName}`, 'success');
      } else {
        showToast(`Hermes 앱에서 열기 요청됨: ${targetName}`, 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`${agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Hermes'} 앱 열기 실패: ${message}`, 'error');
    }
  };

  const openBuzzProject = (item: PortInfo) => {
    if (isDeployedWeb()) {
      showToast('Buzz 프로젝트 연결은 로컬 앱 또는 localhost에서만 사용할 수 있습니다.', 'error');
      return;
    }
    if (!item.folderPath) {
      showToast('Buzz 채널에 연결할 프로젝트 폴더가 없습니다.', 'error');
      return;
    }
    setBuzzProjectTarget({ portId: item.id, projectName: item.name });
  };

  const copyProjectVoiceGuideText = async (
    kind: 'scope-check' | 'recovery',
    guide = projectVoiceGuide,
  ) => {
    if (!guide) return;
    const prompt = kind === 'scope-check'
      ? buildProjectCodexVoiceHandoffPrompt({ projectName: guide.targetName, folderPath: guide.folderPath })
      : buildProjectCodexVoiceRecoveryPrompt({ projectName: guide.targetName, folderPath: guide.folderPath });
    try {
      await navigator.clipboard.writeText(prompt);
      showToast(kind === 'scope-check'
        ? '프로젝트 확인 요청 문구를 복사했습니다. Voice 대화에 붙여넣으세요.'
        : 'Voice 복구 안내를 복사했습니다.', 'success', 10_000);
    } catch {
      showToast('클립보드에 프롬프트를 복사하지 못했습니다.', 'error');
    }
  };

  const openProjectVoiceSetupTask = async () => {
    const guide = projectVoiceGuide;
    if (!guide) return;
    let promptCopied = false;
    try {
      // Copy before opening the external app: when it takes focus, the
      // clipboard operation may no longer be a user-activation on the web.
      await navigator.clipboard.writeText(buildProjectCodexVoiceHandoffPrompt({
        projectName: guide.targetName,
        folderPath: guide.folderPath,
      }));
      promptCopied = true;
    } catch {
      // Opening the project task remains useful even when a browser blocks
      // clipboard access; the modal has an explicit retry button.
    }
    try {
      await API.openCodeApp('codex', guide.folderPath);
      showToast(
        `${guide.targetName}의 프로젝트 Codex 작업을 열었습니다.${promptCopied ? ' 프로젝트 확인 요청 문구도 복사했습니다.' : ''} 이 작업은 Voice 대화와 별도입니다.`,
        'success',
        14_000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`프로젝트 Codex 작업 열기 실패: ${message}`, 'error');
    }
  };

  const startGlobalVoiceFromGuide = async () => {
    const guide = projectVoiceGuide;
    if (!guide || projectVoiceStartPending) return;
    setProjectVoiceStartPending(true);
    try {
      const result = await API.startGlobalCodexVoice(guide.folderPath);
      let promptCopied = false;
      try {
        await navigator.clipboard.writeText(buildProjectCodexVoiceHandoffPrompt({
          projectName: guide.targetName,
          folderPath: guide.folderPath,
        }));
        promptCopied = true;
      } catch {
        // A verified global Voice result remains useful even when clipboard
        // access is unavailable; never change it into a failed start.
      }
      setProjectVoiceGuide(null);
      showToast(
        result.mode === 'resumed-global'
          ? `최근 전역 Voice 재개 기록을 확인했습니다. ${guide.targetName} 연결은 아직 확인되지 않았습니다.${promptCopied ? ' 프로젝트 이동 요청 문구를 복사했습니다.' : ` Voice에 ${guide.folderPath} 프로젝트로 이동해 달라고 말해 주세요.`}`
          : `전역 Voice 생성 기록을 확인했습니다. ${guide.targetName} 연결은 아직 확인되지 않았습니다.${promptCopied ? ' 프로젝트 이동 요청 문구를 복사했습니다.' : ` Voice에 ${guide.folderPath} 프로젝트로 이동해 달라고 말해 주세요.`}`,
        'success',
        20_000,
      );
    } catch (error) {
      const typedError = error as Error & {
        code?: string;
        dispatch?: 'not-attempted' | 'button-pressed' | 'global-button-pressed';
      };
      const message = typedError instanceof Error ? typedError.message : String(error);
      setProjectVoiceGuide({
        ...guide,
        stage: 'start-failed',
        error: message,
        errorCode: typedError.code,
        dispatch: typedError.dispatch,
      });
      showToast(`전역 Voice 시작 확인 실패: ${message}`, 'error', 18_000);
    } finally {
      setProjectVoiceStartPending(false);
    }
  };

  const openChatGptVoiceFromGuide = async () => {
    const guide = projectVoiceGuide;
    if (!guide) return;
    let promptCopied = false;
    try {
      await navigator.clipboard.writeText(buildProjectCodexVoiceHandoffPrompt({
        projectName: guide.targetName,
        folderPath: guide.folderPath,
      }));
      promptCopied = true;
    } catch {
      // ChatGPT can still be opened if the browser/desktop WebView rejects
      // clipboard access; the modal keeps a separate copy button available.
    }
    try {
      await API.openChatGptVoice(guide.folderPath);
      showToast(
        `ChatGPT를 열었습니다. Voice를 직접 시작한 뒤 ${guide.targetName} 프로젝트로 이동해 달라고 말해 주세요.${promptCopied ? ' 이동 요청 문구도 복사했습니다.' : ''}`,
        'success',
        18_000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`ChatGPT Voice 열기 실패: ${message}`, 'error', 12_000);
    }
  };

  const openProjectCodexVoiceChat = async (item: PortInfo, worktreePath?: string) => {
    if (!isTauri()) {
      showToast('Codex Voice는 데스크톱 앱에서만 사용할 수 있습니다.', 'error');
      return;
    }
    if (projectVoiceStartPending) {
      showToast('Codex Voice 시작을 확인하고 있습니다. 잠시만 기다려 주세요.', 'success');
      return;
    }
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    if (!context.workingPath) { showToast('폴더 경로가 없습니다.', 'error'); return; }
    const targetName = context.worktreePath
      ? context.worktreePath.replace(/[/\\]+$/, '').split(/[\\/]/).pop() || item.name
      : item.name;
    setProjectVoiceStartPending(true);
    try {
      if (!await ensureAgentWorktreeReady(item, context)) return;
      const result = await API.openProjectCodexVoice(context.workingPath);
      if (result.mode === 'move-pending') {
        // Acknowledge the move the user made, and say precisely what did not
        // follow it: the execution folder.
        showToast(
          `${targetName}(으)로 이동을 요청한 Voice 대화가 있지만 ChatGPT가 아직 적용하지 않았습니다. 실행 폴더는 여전히 ${result.appliedPath ?? '임시 폴더'}라서, 그 대화에서 파일을 고치면 이 프로젝트가 아니라 임시 폴더에 씁니다.`,
          'error',
          20_000,
        );
        setProjectVoiceGuide({ targetName, folderPath: context.workingPath, stage: 'recovery' });
        return;
      }
      if (result.mode === 'started-unbound') {
        let promptCopied = false;
        try {
          await navigator.clipboard.writeText(buildProjectCodexVoiceHandoffPrompt({
            projectName: targetName,
            folderPath: context.workingPath,
          }));
          promptCopied = true;
        } catch {
          // A Voice thread was observed. Clipboard availability must not turn
          // that result into a failure.
        }
        showToast(
          `${targetName}의 새 Codex Voice 대화 생성 기록을 확인했습니다. 프로젝트 범위와 마이크 연결은 아직 확인되지 않았습니다.${promptCopied ? ' 프로젝트 확인 요청 문구를 복사했습니다.' : ` Voice에 작업 전 프로젝트 폴더 ${context.workingPath}를 확인해 달라고 말해 주세요.`}`,
          'success',
          20_000,
        );
        return;
      }
      if (result.mode === 'resumed-unbound') {
        let promptCopied = false;
        try {
          await navigator.clipboard.writeText(buildProjectCodexVoiceHandoffPrompt({
            projectName: targetName,
            folderPath: context.workingPath,
          }));
          promptCopied = true;
        } catch {
          // The verified Voice resume remains useful even if clipboard access
          // is unavailable; do not turn it into a failed launch.
        }
        showToast(
          `ChatGPT의 최근 Codex Voice 대화 재개 기록을 확인했습니다. ${targetName} 연결은 확인되지 않았습니다.${promptCopied ? ' 프로젝트 확인 요청 문구를 복사했습니다.' : ` Voice에 작업 전 프로젝트 폴더 ${context.workingPath}를 확인해 달라고 말해 주세요.`}`,
          'success',
          20_000,
        );
        return;
      }
      if (result.mode === 'started-project') {
        showToast(`${targetName}에 적용된 새 Codex Voice 대화 생성 기록을 확인했습니다. 마이크 연결은 ChatGPT에서 확인하세요.`, 'success', 15_000);
        return;
      }
      showToast(
        result.voiceStartRequested
          ? `${targetName}의 기존 프로젝트 Codex Voice를 열고 재개 요청을 보냈습니다.`
          : `${targetName}의 기존 프로젝트 Codex Voice를 열었습니다. Voice 재개 상태는 ChatGPT에서 확인하세요.`,
        'success',
        15_000,
      );
    } catch (error) {
      const typedError = error as Error & {
        code?: string;
        dispatch?: 'not-attempted' | 'button-pressed' | 'global-button-pressed';
      };
      const message = typedError instanceof Error ? typedError.message : String(error);
      const code = typedError.code;
      if (code === 'VOICE_START_IN_PROGRESS') {
        showToast(message, 'error', 8_000);
        return;
      }
      if (code?.startsWith('VOICE_')) {
        const recoveryMessage = code === 'VOICE_AUTOMATION_PERMISSION_DENIED'
          ? `${message} 시스템 설정에서 이 앱의 손쉬운 사용 및 ChatGPT 자동화 권한을 허용한 뒤 다시 시도하세요.`
          : message;
        setProjectVoiceGuide({
          targetName,
          folderPath: context.workingPath,
          stage: 'start-failed',
          error: recoveryMessage,
          errorCode: code,
          dispatch: typedError.dispatch,
        });
        showToast(`Codex Voice 시작 확인 실패: ${recoveryMessage}`, 'error', 18_000);
        return;
      }
      showToast(`Codex Voice 열기 실패: ${message}`, 'error');
    } finally {
      setProjectVoiceStartPending(false);
    }
  };

  const openAntigravityMain = async (item: PortInfo, worktreePath?: string, skipFirstTaskRouting = false, isNew = false): Promise<boolean> => {
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    if (!context.workingPath) { showToast('폴더 경로가 없습니다.', 'error'); return false; }
    if (await deferFirstAgentTaskIfNeeded('agy', item, { worktreePath: context.worktreePath, skip: skipFirstTaskRouting })) return false;
    if (!await ensureAgentWorktreeReady(item, context)) return false;
    recordVisit(item.id);
    const sessionName = getSessionName(item);
    try {
      if (terminalApp === 'cmux') {
        if (isWindows()) { cmuxMacOnlyToast(); return false; }
        const msg = await callCmux('open_cmux_agy', '/api/open-cmux-agy', { name: sessionName, folderPath: context.workingPath, worktreePath: context.worktreePath, bypass: bypassPermissions });
        showToast(msg, 'success');
      } else if (terminalApp === 'orca') {
        const msg = await callOrca('agy', item, context.worktreePath, isNew);
        showOrcaActionSuccess(
          'agy',
          item,
          context.worktreePath,
          msg,
          shouldUseOrcaFloatingTerminal(context.workingPath, orcaLaunchMode),
        );
      } else if (terminalApp === 'wsl' || ((terminalApp === 'iterm' || terminalApp === 'terminal') && tmuxMode)) {
        await API.openTmuxAgy(sessionName, context.workingPath, context.worktreePath, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm', isNew);
        showToast(`tmux + Antigravity${bypassPermissions ? ' ⚡' : ''} ${isNew ? '새 세션 시작' : '실행 중'} (${tmuxSessionName(sessionName, context.worktreePath, bypassPermissions)})`, 'success');
      } else if (terminalApp === 'powershell') {
        // powershell — Terminal.app fallback
        await API.openTerminalAgy(context.workingPath, sessionName, context.worktreePath, bypassPermissions);
        showToast(`Antigravity${bypassPermissions ? ' ⚡' : ''} 실행 중`, 'success');
      } else {
        await API.openTerminalAgy(context.workingPath, sessionName, context.worktreePath, bypassPermissions, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        showToast(`${terminalApp} Antigravity${bypassPermissions ? ' ⚡' : ''} 실행 중`, 'success');
      }
      return true;
    } catch (e: any) {
      return reportOperationError('agent.agy.launch', 'Antigravity 실행 실패', item, context.workingPath, e);
    }
  };

  const openHermesMain = async (item: PortInfo, worktreePath?: string, isNew = false): Promise<boolean> => {
    // CLI 경로도 같은 실행 파일을 필요로 한다 — 앱 버튼만 막으면 터미널 버튼이 대신 죽는다.
    if (blockedByMissingHermes()) return false;
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    if (!context.workingPath) { showToast('폴더 경로가 없습니다.', 'error'); return false; }
    if (!await ensureAgentWorktreeReady(item, context)) return false;
    recordVisit(item.id);
    try {
      if (terminalApp === 'cmux') {
        if (isWindows()) { cmuxMacOnlyToast(); return false; }
        const msg = await callCmux('open_cmux_hermes', '/api/open-cmux-hermes', {
          name: `${getSessionName(item)}${isNew ? '-new' : ''}`,
          folderPath: context.workingPath,
          worktreePath: context.worktreePath,
          bypass: false,
        });
        showToast(msg, 'success');
        return true;
      }
      if (terminalApp === 'orca') {
        const msg = await callOrca('hermes', item, context.worktreePath, isNew);
        showOrcaActionSuccess('hermes', item, context.worktreePath, msg, shouldUseOrcaFloatingTerminal(context.worktreePath ?? context.workingPath, orcaLaunchMode));
        return true;
      }
      await API.openTerminalHermes(
        context.workingPath,
        `${getSessionName(item)}${isNew ? '-new' : ''}`,
        context.worktreePath,
        terminalApp === 'terminal' ? 'terminal' : 'iterm',
      );
      showToast(`Hermes${isNew ? ' 새 창' : ''} 실행 중`, 'success');
      return true;
    } catch (e: any) {
      return reportOperationError('agent.hermes.launch', 'Hermes 실행 실패', item, context.workingPath, e);
    }
  };

  // 통합 터미널 핸들러 — 터미널 앱 선택과 bg/tmux/bypass 옵션은 서로 독립이다.
  const openClaudeMain = async (item: PortInfo, isNew = false, worktreePath?: string, skipFirstTaskRouting = false): Promise<boolean> => {
    const context = resolveAgentLaunchContext(item.folderPath, worktreePath, item.worktreePath);
    if (!context.workingPath) { showToast('폴더 경로가 없습니다.', 'error'); return false; }
    if (await deferFirstAgentTaskIfNeeded('claude', item, { isNew, worktreePath: context.worktreePath, skip: skipFirstTaskRouting })) return false;
    if (!await ensureAgentWorktreeReady(item, context)) return false;
    // Background mode is first: it starts the agent, then explicitly opens Agent View
    // on the selected terminal surface (including Orca Floating).
    if (claudeBgActive) {
      return openClaudeBg(item, context.worktreePath, isNew);
    }
    if (terminalApp === 'orca') {
      return openOrcaAgent('claude', item, context.worktreePath, isNew);
    }
    if (terminalApp === 'cmux') {
      if (tmuxMode) return openTmuxOnCmux(item, isNew, context.worktreePath);
      if (isNew) return openCmuxClaudeNew(item, context.worktreePath);
      return openCmuxClaude(item, context.worktreePath);
    } else if (terminalApp === 'wsl' || ((terminalApp === 'iterm' || terminalApp === 'terminal') && tmuxMode)) {
      if (isNew) return openTmuxClaudeNew(item, context.worktreePath);
      return openTmuxClaude(item, context.worktreePath);
    } else if (terminalApp === 'powershell') {
      return openTerminalClaude(item, context.worktreePath);
    } else {
      return openTerminalClaude(item, context.worktreePath);
    }
  };

  const launchFirstAgentTask = async (location: 'main' | 'worktree') => {
    if (!firstTaskLaunch || firstTaskLaunchBusy) return;
    const request = firstTaskLaunch;
    const folderPath = request.item.folderPath;
    if (!folderPath) return;
    const branchName = firstTaskBranchName.trim();
    if (location === 'worktree' && !branchName) {
      showToast('새 워크트리의 브랜치명을 입력하세요.', 'error');
      return;
    }
    setFirstTaskLaunchBusy(true);
    try {
      let worktreePath: string | undefined;
      if (location === 'worktree') {
        const source = await repositoryWorkflowApi.worktreeSource(folderPath);
        if (!source.ready) throw new Error(source.message || '메인트리 변경을 먼저 커밋해주세요.');
        const created = await API.gitWorktreeAdd(folderPath, branchName, undefined, terminalApp === 'orca');
        worktreePath = created.path;
        await loadWorktrees(request.item.id, folderPath);
      }

      const launched = request.agent === 'claude'
        ? await openClaudeMain(request.item, request.isNew === true, worktreePath, true)
        : request.agent === 'codex'
          ? await openCodexMain(request.item, worktreePath, true)
          : await openAntigravityMain(request.item, worktreePath, true);

      // 실행 함수가 자체 오류를 토스트/진단 로그로 남긴 경우에도 예전에는 첫 임무를
      // 완료 처리해 다시 선택할 기회를 없앴다. 실제 성공 신호가 없으면 pending을 유지한다.
      if (!launched) return;

      const status = await repositoryWorkflowApi.completeFirstTask(folderPath);
      setRepositoryWorkflowStatuses(prev => ({ ...prev, [request.item.id]: status }));
      setFirstTaskLaunch(null);
      showToast(location === 'worktree' ? `새 워크트리에서 첫 임무를 시작했습니다: ${branchName}` : '메인 워크트리에서 첫 임무를 시작했습니다.', 'success');
    } catch (error) {
      showToast(`첫 임무 시작 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setFirstTaskLaunchBusy(false);
    }
  };

  const terminalBtnStyle = (color: string): React.CSSProperties => ({
    flex: '1 1 0', minWidth: 0, padding: '5px 6px', fontSize: 10.5, borderRadius: 6,
    background: `${color}20`, border: `1px solid ${color}50`,
    color: '#d4d4d8', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center',
  });

  const headerAgentButtonStyle = (color: string, separated = false): React.CSSProperties => ({
    padding: '5px 9px',
    background: 'transparent',
    border: 'none',
    borderLeft: separated ? '1px solid rgba(255,255,255,0.08)' : 'none',
    color,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'Inter Tight, system-ui, sans-serif',
    whiteSpace: 'nowrap',
  });

  // 초기 데이터 로드
  useEffect(() => {
    const loadPortsData = async () => {
      try {
        let data: PortInfo[] | null = null;

        if (isDeployedWeb()) {
          // 배포 웹: API 서버 없음 → Supabase에서 직접 로드 (아래 auto-pull에서 처리)
          data = [];
        } else {
          // 재시도 로직: API 서버가 아직 준비되지 않은 경우 최대 6회 재시도 (총 ~15초)
          const retryDelays = [0, 800, 2000, 3500, 5000, 7000];
          for (let attempt = 0; attempt < retryDelays.length; attempt++) {
            try {
              const retryDelay = retryDelays[attempt] ?? 0;
              if (retryDelay > 0) {
                await new Promise(r => setTimeout(r, retryDelay));
                if (import.meta.env.DEV) console.log(`[App] Retrying port load (${attempt}/${retryDelays.length - 1})...`);
              }
              data = await API.loadPorts();
              break;
            } catch (err) {
              console.warn(`[App] Load attempt ${attempt + 1} failed:`, err);
              if (attempt === retryDelays.length - 1) throw err;
            }
          }
          if (!data) throw new Error('No data after retries');
        }

        // commandPath가 있는데 folderPath가 없는 경우 자동으로 추출
        // 다른 OS 경로의 포트는 화면에서 제외하되 ref에 보관 → 파일 저장 시 다시 합쳐 영구 삭제 방지
        otherPlatformPortsRef.current = data.filter((port: PortInfo) => !isCurrentPlatformPath(port));
        const updatedData = data
          .filter(isCurrentPlatformPath)
          .map((port: PortInfo) => {
            const restored = { ...port, isRunning: runningStateAfterReload(port) };
            if (port.commandPath && !port.folderPath) {
              const lastSlashIndex = port.commandPath.lastIndexOf('/');
              if (lastSlashIndex !== -1) {
                return { ...restored, folderPath: port.commandPath.substring(0, lastSlashIndex) };
              }
            }
            return restored;
          });

        setPorts(updatedData);
        hasInitiallyLoaded.current = true; // 파일 로드 완료 → 파일 자동저장 즉시 허용
        // autopushReady는 Supabase pull 완료 후 true (stale 데이터 푸시 방지)

        // 포털 설정 로드 및 캐시 (자동 push/pull에서 재사용)
        try {
          let portalData: any;
          if (isTauri()) {
            portalData = await invoke('load_portal');
          } else if (isDeployedWeb()) {
            portalData = await getPortalCredentials();
          } else {
            const res = await fetch('/api/portal');
            if (res.ok) portalData = await res.json();
          }
          cachePortalConfig(portalData);

          // Supabase 자동 Pull (10s timeout, Model B merge)
          if (portalData?.supabaseUrl && portalData?.supabaseAnonKey) {
            try {
              const supabase = getSupabaseClient(portalData.supabaseUrl, portalData.supabaseAnonKey);
              let portsQuery = supabase.from('portmgr_ports').select('*');
              if (portalData.deviceId) portsQuery = portsQuery.eq('device_id', portalData.deviceId);
              let { data: remoteData, error } = await withTimeout(portsQuery, 10_000);
              if (!error && remoteData && remoteData.length > 0) {
                const remoteRows: PortInfo[] = remoteData.map((row: any) => ({
                  id: row.id,
                  name: row.name,
                  port: row.port ?? undefined,
                  commandPath: row.command_path ?? undefined,
                  terminalCommand: row.terminal_command ?? undefined,
                  folderPath: row.folder_path ?? undefined,
                  deployUrl: row.deploy_url ?? undefined,
                  ...githubRepositoryUrlFields(githubRepositoryUrls({
                    githubUrl: row.github_url,
                    githubUrls: row.github_urls,
                  })),
                  manualPath: row.manual_path ?? undefined,
                  logFilePath: row.log_file_path ?? undefined,
                  category: row.category ?? undefined,
                  description: row.description ?? undefined,
                  aiName: row.ai_name ?? undefined,
                  favorite: row.favorite ?? false,
                  isRunning: false,
                  sourceDeviceId: row.device_id ?? undefined,
                }));
                const merged = mergePorts(updatedData, remoteRows);
                setPorts(merged);
                if (!isDeployedWeb()) await API.savePorts(merged);
                // 메모 복원
                const pulledMemos: Record<string, { content: string; updatedAt: string }> = {};
                remoteData.forEach((row: any) => {
                  if (row.memo != null) pulledMemos[row.id] = { content: row.memo, updatedAt: row.memo_updated_at ?? '' };
                });
                // 로컬/원격 중 updatedAt이 최신인 메모 유지
                if (Object.keys(pulledMemos).length > 0) {
                  setMemos(prev => {
                    const next = { ...prev };
                    for (const [mid, m] of Object.entries(pulledMemos)) {
                      const localMemo = next[mid];
                      if (!localMemo || (m.updatedAt ?? '') >= (localMemo.updatedAt ?? '')) next[mid] = m;
                    }
                    return next;
                  });
                }
              }

              autopushReady.current = true;      // Supabase push 허용 (pull 완료)
              if (!error) {
                autopullSucceeded.current = true;  // Fix P2g: pull 성공 시에만 delete pass 허용
              } else {
                console.warn('[App] Auto-pull query error:', (error as any)?.message ?? error);
              }

              // workspace_roots 자동 Pull (빈 결과면 로컬 덮어쓰기 방지)
              const deviceId = portalData.deviceId;
              if (deviceId) {
                const { data: rootData } = await supabase
                  .from('portmgr_workspace_roots').select('*').eq('device_id', deviceId);
                if (rootData && rootData.length > 0) {
                  const remoteRoots: WorkspaceRoot[] = rootData
                    .filter((r: any) => !r.path?.startsWith('__device__'))
                    .map((r: any) => ({ id: r.id, name: r.name, path: r.path }));
                  // 같은 기기의 표시 순서는 로컬이 기준이다. Supabase 테이블에는
                  // order 필드가 없으므로 원격 행 순서로 재구성하면 사용자가 정한
                  // 순서가 매 시작마다 원복된다.
                  const localRoots = await API.loadWorkspaceRoots();
                  const mergedRoots = mergeWorkspaceRootsPreservingLocalOrder(localRoots, remoteRoots);
                  setWorkspaceRoots(mergedRoots);
                  if (!isDeployedWeb()) await API.saveWorkspaceRoots(mergedRoots);
                }
                // guard: rootData.length === 0 → skip, keep local roots intact
              }
            } catch (pullErr) {
              console.warn('[App] Auto-pull Supabase failed:', pullErr);
              showToast('Supabase 자동 동기화 실패 (네트워크 확인)', 'error');
              autopushReady.current = true; // pull 실패해도 push 허용
            }
          } else {
            // No credentials at startup → still enable auto-push so it fires once credentials are added
            autopushReady.current = true;
          }
        } catch (portalErr) {
          console.warn('[App] Failed to load portal config:', portalErr);
          autopushReady.current = true; // portal 로드 실패해도 push 허용
        }

        // 앱 시작 시 포트 상태 자동 확인 (배치 — 단일 호출)
        const withPorts = updatedData.filter((p: PortInfo) => p.port);
        if (withPorts.length > 0) {
          const uniquePorts = [...new Set(withPorts.map((p: PortInfo) => p.port!))];
          let statusByPort: Map<number, boolean> | null = null;
          try {
            const batchResults = await API.checkPortsStatusBatch(uniquePorts);
            statusByPort = new Map(batchResults.map(r => [r.port, r.isRunning]));
          } catch (error) {
            // 조회 장애를 "모든 서버 중지"로 오인하지 않는다. 마지막으로 확인된 상태를 보존한다.
            console.warn('[PortStatus] startup batch check failed; keeping cached state:', error);
          }
          if (statusByPort) {
            setPorts(prev =>
              prev.map(p =>
                p.port && statusByPort!.has(p.port)
                  ? { ...p, isRunning: statusByPort!.get(p.port)! }
                  : p
              )
            );
          }
        }
      } catch (error) {
        console.error('[App] Failed to load ports after all retries:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadPortsData();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    API.getGlobalShortcut().then(s => { if (s) setGlobalShortcut(s); }).catch(() => {});
  }, []);

  // 앱 시작 시 스테일 워크트리 자동 prune (1회)
  const cleanupRanRef = useRef(false);
  useEffect(() => {
    if (cleanupRanRef.current || ports.length === 0) return;
    cleanupRanRef.current = true;
    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
    // folderPath 중복 제거 + 순차 실행 — 프로젝트 수만큼 동시 POST가 몰리면
    // 서버가 폴더당 git 프로세스 2~4개를 한꺼번에 spawn하는 부팅 폭주가 발생
    const folders = [...new Set(ports.map(p => p.folderPath).filter((f): f is string => !!f))];
    (async () => {
      for (const folderPath of folders) {
        try {
          await fetch(`${baseUrl}/api/cleanup-stale-worktrees`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath }),
          });
        } catch { /* best-effort */ }
      }
    })();
  }, [ports]);

  // 10초 간격 포트 상태 자동 폴링 (portsRef로 최신 ports 참조 — dependency loop 방지)
  const portsRef = useRef<PortInfo[]>([]);
  useEffect(() => { portsRef.current = ports; }, [ports]);
  const portStatusPollBusyRef = useRef(false); // in-flight 가드 — 느린 틱이 다음 틱과 겹치는 것 방지
  useEffect(() => {
    const interval = setInterval(async () => {
      // 창이 숨김/최소화/백그라운드(다른 데스크톱·occluded)일 땐 폴링 작업을 건너뜀 —
      // agent view 등 다른 작업 중 불필요한 lsof spawn·리렌더로 자원 소모 방지.
      // 다시 포커스되면 focus 핸들러가 포트를 자동 reload하므로 즉시 최신 상태 복구됨.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (portStatusPollBusyRef.current) return;
      portStatusPollBusyRef.current = true;
      try {
        const withPorts = portsRef.current.filter(p => p.port);
        if (withPorts.length === 0) return;
        // 배치 API 1회 호출 (포트당 HTTP/invoke + lsof 1회 → 전체 1회)
        const uniquePorts = [...new Set(withPorts.map(p => p.port!))];
        let statusByPort: Map<number, boolean> | null = null;
        try {
          const batchResults = await API.checkPortsStatusBatch(uniquePorts);
          statusByPort = new Map(batchResults.map(r => [r.port, r.isRunning]));
        } catch (error) {
          // API/lsof 일시 장애 때 모든 실행 상태를 false로 뒤집지 않는다.
          console.warn('[PortStatus] poll failed; keeping last known state:', error);
          return;
        }
        setPorts(prev => {
          // isRunning이 실제로 바뀐 포트만 새 객체 생성 — 불필요한 객체 교체가
          // ports-save effect(디스크 쓰기)·Supabase auto-push를 10초마다 유발하는 것 방지
          let changed = false;
          const next = prev.map(p => {
            if (!p.port) return p; // 포트 번호 없는 항목(폴더 전용)은 기존처럼 건너뜀
            if (!statusByPort!.has(p.port)) return p;
            const isRunning = statusByPort!.get(p.port)!;
            if (!!p.isRunning === isRunning) return p;
            changed = true;
            return { ...p, isRunning };
          });
          return changed ? next : prev;
        });
      } finally {
        portStatusPollBusyRef.current = false;
      }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // 30초 간격 워크트리 자동 폴링 — 패널이 열린 항목만 재조회
  const expandedWorktreeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { expandedWorktreeIdsRef.current = expandedWorktreeIds; }, [expandedWorktreeIds]);
  const portsForWtRef = useRef<PortInfo[]>([]);
  useEffect(() => { portsForWtRef.current = ports; }, [ports]);
  const wtPollBusyRef = useRef(false);
  useEffect(() => {
    const interval = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (wtPollBusyRef.current) return;
      const expanded = expandedWorktreeIdsRef.current;
      if (expanded.size === 0) return;
      wtPollBusyRef.current = true;
      try {
        const items = portsForWtRef.current.filter(p => expanded.has(p.id) && p.folderPath);
        const now = Date.now();
        await Promise.all(items.map(p => {
          const fetchRemote = shouldFetchWorktreeRemote(
            worktreeRemoteRefreshAtRef.current.get(p.id),
            now,
          );
          return loadWorktrees(p.id, p.folderPath!, { fetchRemote, showResult: false });
        }));
      } finally {
        wtPollBusyRef.current = false;
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [loadWorktrees]);

  // 작업 루트 초기 로드
  useEffect(() => {
    API.loadWorkspaceRoots().then(data => {
      if (data.length > 0) setWorkspaceRoots(data);
      hasWorkspaceRootsLoaded.current = true;
    }).catch(e => {
      console.error('[App] Failed to load workspace roots:', e);
      hasWorkspaceRootsLoaded.current = true;
    });
  }, []);

  // 레거시 북마크 폴더 아이템을 '프로젝트·폴더' 탭으로 1회 자동 이전 (멱등)
  useEffect(() => {
    if (isLoading) return;
    if (localStorage.getItem('folder-portal-migrated-v1')) return;
    (async () => {
      try {
        let portalData: any;
        if (isTauri()) {
          portalData = await invoke('load_portal');
        } else {
          const res = await fetch('/api/portal');
          if (res.ok) portalData = await res.json();
        }
        const items: any[] = Array.isArray(portalData?.items) ? portalData.items : [];
        const folderItems = items.filter(it => it.type === 'folder' && it.path);
        if (folderItems.length === 0) {
          localStorage.setItem('folder-portal-migrated-v1', '1');
          return;
        }
        const existingPaths = new Set(ports.map(p => p.folderPath).filter(Boolean) as string[]);
        // Deterministic id derived from folder path so the same folder migrated on
        // a different device collapses to one row instead of stacking duplicates on Pull.
        const pathId = (path: string) => {
          let h = 0;
          for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
          return `migrated-${(h >>> 0).toString(36)}-${path.length.toString(36)}`;
        };
        const newPorts: PortInfo[] = folderItems
          .filter(it => !existingPaths.has(it.path))
          .map(it => ({
            id: pathId(it.path as string),
            name: it.name,
            folderPath: it.path,
            category: it.category || undefined,
            description: it.description || undefined,
            isRunning: false,
          }));
        if (newPorts.length > 0) {
          const merged = [...newPorts, ...ports];
          setPorts(merged);
          await API.savePorts(merged);
        }
        // 포털에서 folder 제거
        const cleaned = { ...portalData, items: items.filter(it => it.type !== 'folder') };
        if (isTauri()) {
          await invoke('save_portal', { data: cleaned });
        } else {
          await fetch('/api/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cleaned) });
        }
        localStorage.setItem('folder-portal-migrated-v1', '1');
        if (newPorts.length > 0) {
          showToast(`폴더 북마크 ${newPorts.length}개를 '프로젝트·폴더' 탭으로 옮겼습니다`, 'success');
        }
      } catch (e) {
        console.warn('[migration] folder-portal migration failed:', e);
      }
    })();
  }, [isLoading]);

  // 방문 기록 초기 로드 + window 변경 시 재조회
  useEffect(() => {
    const timer = setTimeout(() => fetchVisitCounts(visitWindow), 2000);
    return () => clearTimeout(timer);
  }, [visitWindow]);

  // 작업 루트 변경 시 저장 (초기 로드 완료 후에만)
  useEffect(() => {
    if (!hasWorkspaceRootsLoaded.current) return;
    API.saveWorkspaceRoots(workspaceRoots).catch(e =>
      console.error('[App] Failed to save workspace roots:', e)
    );
  }, [workspaceRoots]);

  // 정렬 설정 localStorage 저장
  useEffect(() => {
    try { localStorage.setItem(PINNED_ORDER_STORAGE_KEY, JSON.stringify(pinnedOrder)); } catch {}
  }, [pinnedOrder]);
  useEffect(() => { localStorage.setItem('portmanager-sortBy', sortBy); }, [sortBy]);
  useEffect(() => { localStorage.setItem('portmanager-sortOrder', sortOrder); }, [sortOrder]);
  useEffect(() => {
    // 이전 버전이 영구 저장한 위험 설정을 제거한다.
    localStorage.removeItem('portmanager-bypassPermissions');
  }, []);
  useEffect(() => { isBuildingRef.current = isBuilding; }, [isBuilding]);

  // 프로젝트 선택 시 워크트리 패널은 기본 ON으로 열고 목록을 자동 로드한다.
  const selectedWorktreeRemoteLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!v4SelectedId) {
      selectedWorktreeRemoteLoadRef.current = null;
      return;
    }
    const sel = ports.find(p => p.id === v4SelectedId);
    if (!sel?.folderPath) return;
    setExpandedWorktreeIds(prev => {
      if (prev.has(v4SelectedId)) return prev;
      const next = new Set(prev);
      next.add(v4SelectedId);
      return next;
    });
    const selectionKey = `${v4SelectedId}\u0000${sel.folderPath}`;
    if (selectedWorktreeRemoteLoadRef.current === selectionKey) return;
    selectedWorktreeRemoteLoadRef.current = selectionKey;
    loadWorktrees(v4SelectedId, sel.folderPath, { fetchRemote: true, showResult: false });
  }, [v4SelectedId, ports, loadWorktrees]);
  useEffect(() => {
    if (buildLogContainerRef.current) {
      buildLogContainerRef.current.scrollTop = buildLogContainerRef.current.scrollHeight;
    }
  }, [buildLogs]);

  // Port log viewer scroll to bottom
  useEffect(() => {
    if (portLogContainerRef.current) {
      portLogContainerRef.current.scrollTop = portLogContainerRef.current.scrollHeight;
    }
  }, [portLogs]);

  // Port log polling cleanup
  useEffect(() => {
    return () => {
      if (portLogPollingRef.current) {
        clearInterval(portLogPollingRef.current);
        portLogPollingRef.current = null;
      }
      portLogPollBusyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      // 브라우저 폴백은 #root를 transform으로 확대하고 레이아웃 폭을 역수로 줄인다.
      // window.innerWidth만 보면 200%의 900px 창을 여전히 데스크톱(900px)으로 오판해
      // 실제 논리 폭 450px에서 데스크톱 버튼들이 겹친다. 네이티브 webview zoom에서도
      // 같은 계산은 안전하며 100%에서는 기존 기준과 같다.
      setIsMobile(window.innerWidth / uiZoom < 480);
    };
    handler();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [uiZoom]);

  // Cmd+F: 검색 포커스 / Esc: 검색 초기화 + 모달 닫기
  const escapeHandlerRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    escapeHandlerRef.current = () => {
      if (wslSetupStatus) { setWslSetupStatus(null); return; }
      if (showPortsHistory) { setShowPortsHistory(false); return; }
      if (showQuickAddModal) { closeQuickAddModal(); return; }
      if (document.activeElement === searchInputRef.current) {
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        escapeHandlerRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 자동 Push: 포트 목록 변경 후 3초 debounce (Supabase 설정된 경우만)
  useEffect(() => {
    if (!autopushReady.current) return;
    const config = portalConfigRef.current;
    if (!config?.supabaseUrl || !config?.supabaseAnonKey) return;

    if (autoPushTimerRef.current) clearTimeout(autoPushTimerRef.current);
    autoPushTimerRef.current = setTimeout(async () => {
      const cfg = portalConfigRef.current;
      if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
      if (ports.length === 0) return; // 빈 배열로 stale-delete 방지
      try {
        const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        const deviceId = cfg.deviceId ?? null;
        const deviceNameVal = cfg.deviceName ?? null;
        // 다른 기기 소유 포트는 push 제외 (sourceDeviceId가 내 deviceId와 다른 경우)
        // dedupe: 같은 id가 한 배치에 두 번 들어가면 Postgres가 upsert 전체를 거부한다
        // ("ON CONFLICT DO UPDATE command cannot affect row a second time")
        const ownedPorts = dedupePortsById(ports.filter(p => !p.sourceDeviceId || p.sourceDeviceId === deviceId));
        const rows = ownedPorts.map(p => ({
          id: p.id,
          name: p.name,
          port: p.port ?? null,
          command_path: p.commandPath ?? null,
          terminal_command: p.terminalCommand ?? null,
          folder_path: p.folderPath ?? null,
          deploy_url: p.deployUrl ?? null,
          ...githubDatabaseFields(p),
          manual_path: p.manualPath ?? null,
          log_file_path: p.logFilePath ?? null,
          favorite: p.favorite ?? false,
          device_id: deviceId,
          device_name: deviceNameVal,
          memo: memosRef.current[p.id]?.content ?? null,
          memo_updated_at: memosRef.current[p.id]?.updatedAt ?? null,
        }));
        // PostgREST reports one missing column per request, so an installation
        // short of several optional columns needs as many retries as it has gaps,
        // in whatever order they are reported. Old Supabase installations keep the
        // primary github_url, so dropping only the unavailable group leaves every
        // other field syncing instead of blocking the whole auto-save.
        const { error: upsertErr, omittedColumns } = await retryPortUpsertWithoutMissingOptionalColumns(
          rows as Record<string, unknown>[],
          async attemptRows => ({ error: (await supabase.from('portmgr_ports').upsert(attemptRows, { onConflict: 'id' })).error }),
        );
        if (upsertErr) throw new Error(upsertErr.message);
        if (omittedColumns.length > 0) {
          console.warn(`[App] Supabase is missing optional columns (${omittedColumns.join(', ')}); those values remain local-only`);
        }
        // Fix P2: delete remote rows whose IDs are no longer in local list
        // Fix P2g: skip delete pass if auto-pull never succeeded — local state may be incomplete
        // Step 4: scope stale-delete to this device only — deviceId 없으면 전 기기 삭제 위험이라 skip
        if (autopullSucceeded.current && deviceId) {
          const localIds = ownedPorts.map(p => p.id);
          const remoteQuery = supabase.from('portmgr_ports').select('id').eq('device_id', deviceId);
          const { data: remoteRows } = await remoteQuery;
          const staleIds = (remoteRows ?? []).map((r: any) => r.id).filter((id: string) => !localIds.includes(id));
          if (staleIds.length > 0) {
            await supabase.from('portmgr_ports').delete().in('id', staleIds);
          }
        }
      } catch (e) {
        console.warn('[App] Auto-push failed:', e);
      }
    }, 3000);

    return () => {
      if (autoPushTimerRef.current) clearTimeout(autoPushTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports]);

  // 포트 목록이 변경될 때마다 파일에 저장 (초기 로드 완료 후에만)
  useEffect(() => {
    if (!isLoading && hasInitiallyLoaded.current) {
      // 서버에서 리로드된 데이터는 저장 안 함 (빈 데이터 덮어쓰기 방지)
      if (skipNextSave.current) {
        skipNextSave.current = false;
        return;
      }
      if (import.meta.env.DEV) console.log('[App] Saving ports, count:', ports.length);
      const savePortsData = async () => {
        try {
          // 파일에는 다른 OS 경로 항목도 함께 보존 (화면/Push 목록은 ports만 사용)
          await API.savePorts([...ports, ...otherPlatformPortsRef.current]);
          if (import.meta.env.DEV) console.log('[App] Ports saved successfully');
        } catch (error) {
          console.error('[App] Failed to save ports:', error);
        }
      };
      savePortsData();
    }
  }, [ports, isLoading]);

  // 창 포커스 시 데이터 다시 로드 (웹↔Tauri 동기화)
  useEffect(() => {
    const handleFocus = async () => {
      if (import.meta.env.DEV) console.log('[App] Window focused, reloading ports data...');
      try {
        const data = await API.loadPorts();
        skipNextSave.current = true; // 파일에서 읽어온 데이터는 다시 저장하지 않음
        otherPlatformPortsRef.current = data.filter((p: PortInfo) => !isCurrentPlatformPath(p));
        setPorts(data.filter(isCurrentPlatformPath).map(port => ({
          ...port,
          isRunning: runningStateAfterReload(port),
        })));
        if (!hasInitiallyLoaded.current) {
          hasInitiallyLoaded.current = true;
        }
      } catch (error) {
        console.error('[App] Failed to reload ports on focus:', error);
      }
    };

    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().listen('tauri://focus', handleFocus).then(fn => {
          // 언마운트가 listen() 해소보다 먼저 일어난 경우에도 리스너를 즉시 제거
          if (cancelled) fn();
          else unlisten = fn;
        });
      });
      return () => { cancelled = true; unlisten?.(); };
    }

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  const addPort = () => {
    if (name) {
      if (port && !/^\d+$/.test(port)) {
        showToast('포트 번호는 정수만 입력 가능합니다', 'error');
        return;
      }
      const portNum = port ? parseInt(port) : undefined;
      if (portNum !== undefined && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
        showToast('포트 번호는 1~65535 사이여야 합니다', 'error');
        return;
      }
      const duplicatePort = portNum && ports.find(p => p.port === portNum);
      if (duplicatePort) {
        showToast(`포트 ${portNum}은 이미 "${duplicatePort.name}"에서 사용 중입니다`, 'error');
        return;
      }
      // commandPath가 있으면 자동으로 폴더 경로 추출 (Windows \ + POSIX / 모두 지원)
      let autoFolderPath = folderPath;
      if (commandPath && !folderPath) {
        const lastSepIndex = Math.max(commandPath.lastIndexOf('/'), commandPath.lastIndexOf('\\'));
        if (lastSepIndex !== -1) {
          autoFolderPath = commandPath.substring(0, lastSepIndex);
        }
      }

      const newPort: PortInfo = {
        id: Date.now().toString(),
        name,
        port: port ? parseInt(port) : undefined,
        commandPath: commandPath || undefined,
        terminalCommand: terminalCommand || undefined,
        folderPath: autoFolderPath || undefined,
        deployUrl: deployUrl || undefined,
        ...githubRepositoryUrlFields(githubUrl),
        worktreePath: worktreePath || undefined,
        category: category || undefined,
        description: description || undefined,
        isRunning: false,
      };
      setPorts([...ports, newPort]);
      setName('');
      setPort('');
      setCommandPath('');
      setTerminalCommand('');
      setFolderPath('');
      setDeployUrl('');
      setGithubUrl('');
      setWorktreePath('');
      setCategory('');
      setDescription('');
    }
  };

  const deletePort = (id: string) => {
    setDeleteConfirmId(id);
  };

  const handleConfirmDelete = (id: string) => {
    setPorts(prev => prev.filter(p => p.id !== id));
    setMemos(prev => { const next = { ...prev }; delete next[id]; return next; });
    setDeleteConfirmId(null);
  };

  /**
   * 프로젝트 정리 — 아카이브 → 원격 삭제 → 로컬 삭제 순서.
   *
   * 순서가 중요하다. 로컬을 먼저 지우면 folderPath를 잃어 **기억을 보관할 수 없다**.
   * 그래서 보관이 항상 먼저다. 보관이 실패해도 삭제는 진행한다 — 파생 작업 때문에
   * 사용자가 요청한 정리가 막히면 안 되고, 실패 사실은 토스트로 알린다.
   *
   * 원격 삭제는 **id 기준**이라 device_id와 무관하게 지운다. 기기를 새로 잡거나
   * 재설치하면 예전 device_id로 남은 행은 어떤 push로도 회수되지 않기 때문이다
   * (실측: 150행 중 138행이 현재 기기 소유가 아니었다).
   */
  const cleanupProject = async (item: PortInfo, options: { deleteRemote: boolean }) => {
    let archivedNote = '';
    if (item.folderPath) {
      try {
        const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/memory-archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderPath: item.folderPath,
            projectName: item.aiName || item.name,
            projectCode: projectCode(item.id),
            reason: 'cleanup',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.archived) archivedNote = ' · 장기기억 보관됨';
      } catch {
        showToast('장기기억 보관 실패 — 삭제는 계속합니다', 'error');
      }
    }
    if (options.deleteRemote) {
      const cfg = portalConfigRef.current;
      if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
        showToast('Supabase 설정이 없어 원격 삭제를 건너뜁니다', 'error');
      } else {
        try {
          const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
          const { error } = await supabase.from('portmgr_ports').delete().eq('id', item.id);
          if (error) throw new Error(describeSupabaseError(error));
          archivedNote += ' · Supabase 행 삭제됨';
        } catch (e) {
          // 원격 삭제가 실패했는데 로컬을 지우면 그 행은 **영영 회수 불가**가 된다.
          // (id를 잃으므로 다음 push의 stale-delete 대상도 되지 못한다.)
          showToast(`Supabase 삭제 실패 — 로컬도 남깁니다: ${e instanceof Error ? e.message : String(e)}`, 'error');
          return;
        }
      }
    }
    setPorts(prev => prev.filter(p => p.id !== item.id));
    setMemos(prev => { const next = { ...prev }; delete next[item.id]; return next; });
    showToast(`"${item.name}" 정리 완료${archivedNote}`, 'success');
  };

  const handleSaveMemo = (portId: string, content: string) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const updatedAt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    setMemos(prev => ({ ...prev, [portId]: { content, updatedAt } }));
  };

  const startEdit = (item: PortInfo) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditPort(item.port?.toString() ?? '');
    setEditCommandPath(item.commandPath || '');
    setEditTerminalCommand(item.terminalCommand || '');
    setEditFolderPath(item.folderPath || '');
    setEditDeployUrl(item.deployUrl || '');
    setEditGithubUrl(githubRepositoryUrlsText(item));
    setEditGithubDetecting(false);
    setEditWorktreePath(item.worktreePath || '');
    setEditManualPath(item.manualPath || '');
    setEditLogFilePath(item.logFilePath || '');
    setEditCategory(item.category || '');
    setEditAiName(item.aiName || '');
    setEditDescription(item.description || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditPort('');
    setEditCommandPath('');
    setEditTerminalCommand('');
    setEditFolderPath('');
    setEditDeployUrl('');
    setEditGithubUrl('');
    setEditGithubDetecting(false);
    setEditWorktreePath('');
    setEditManualPath('');
    setEditLogFilePath('');
    setEditCategory('');
    setEditAiName('');
    setEditDescription('');
  };

  /**
   * 빈 GitHub 칸을 폴더의 `origin`으로 채운다. 지어내는 값이 아니라 폴더 안에 이미 있는
   * 사실을 옮겨오는 것이고, 「감지」 버튼을 눌러야만 채워지던 탓에 실측 4개 중 3개가
   * 비어 있었다. 이 값은 기기 간에 "같은 프로젝트"를 말해주는 유일한 값이라 비어 있으면
   * 장기기억이 clone 없는 기기에서 계보를 잇지 못한다.
   *
   * 두 가지는 절대 하지 않는다 — 이미 입력된 값은 건드리지 않고(사용자가 origin이 아닌
   * 주소를 일부러 넣어둔 경우가 있다), 감지 실패로 저장 자체를 실패시키지 않는다.
   */
  /**
   * 폴더별 장기기억 ID를 한 번에 읽는다. 실패는 빈 맵으로 삼킨다 — 이 값이 없다고
   * Push 를 막으면 곁들이는 정보 때문에 본 기능이 죽는다.
   */
  const fetchProjectMemoryIds = async (folderPaths: string[]): Promise<Record<string, string | null>> => {
    if (folderPaths.length === 0) return {};
    try {
      const res = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/project-memory/memory-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPaths }),
      });
      if (!res.ok) return {};
      const data = await res.json() as { memoryIds?: Record<string, string | null> };
      return data.memoryIds ?? {};
    } catch {
      return {};
    }
  };

  const withDetectedGithubUrl = useCallback(async <T extends PortInfo>(port: T): Promise<T> => {
    const folder = port.folderPath?.trim();
    if (!folder || githubRepositoryUrls(port).length > 0) return port;
    try {
      const detected = normalizeGitHubRepositoryUrl(await API.detectGitRemoteUrl(folder));
      if (!detected) return port;
      return { ...port, ...githubRepositoryUrlFields(detected) };
    } catch {
      return port;
    }
  }, []);

  const saveEdit = () => {
    if (editingId && editName) {
      // commandPath가 있으면 자동으로 폴더 경로 추출
      let autoFolderPath = editFolderPath;
      if (editCommandPath && !editFolderPath) {
        const lastSlashIndex = editCommandPath.lastIndexOf('/');
        if (lastSlashIndex !== -1) {
          autoFolderPath = editCommandPath.substring(0, lastSlashIndex);
        }
      }

      const edited = ports.map(p =>
        p.id === editingId
          ? { ...p, name: editName, port: editPort ? parseInt(editPort) : undefined, commandPath: editCommandPath || undefined, terminalCommand: editTerminalCommand || undefined, folderPath: autoFolderPath || undefined, deployUrl: editDeployUrl || undefined, ...githubRepositoryUrlFields(editGithubUrl), worktreePath: editWorktreePath || undefined, manualPath: editManualPath || undefined, logFilePath: editLogFilePath || undefined, category: editCategory || undefined, aiName: editAiName || undefined, description: editDescription || undefined }
          : p
      );
      setPorts(edited);
      cancelEdit();
      // 저장은 이미 끝났고, 감지는 그 뒤에 빈 칸만 메운다. 폴더 경로가 확정된 시점이라
      // 타이핑 도중의 반쪽 경로를 읽을 일이 없다.
      const saved = edited.find(p => p.id === editingId);
      if (saved) {
        void withDetectedGithubUrl(saved).then(filled => {
          if (filled === saved) return;
          setPorts(prev => prev.map(p => (p.id === editingId ? { ...p, ...githubRepositoryUrlFields(githubRepositoryUrls(filled)) } : p)));
          showToast(`GitHub 주소를 폴더에서 찾아 채웠습니다: ${primaryGitHubRepositoryUrl(filled)}`, 'success');
        });
      }
    }
  };

  const toggleFavorite = useCallback(async (item: PortInfo) => {
    const updated = ports.map(p => p.id === item.id ? { ...p, favorite: !p.favorite } : p);
    setPorts(updated);
    await API.savePorts(updated);
  }, [ports]);

  const saveInlineUrl = useCallback(async (id: string, field: 'deployUrl' | 'githubUrl' | 'description' | 'category' | 'aiName', value: string) => {
    const trimmed = value.trim();
    let updated: PortInfo[] = [];
    setPorts(prev => {
      updated = prev.map(p => p.id === id ? { ...p, [field]: trimmed || undefined } : p);
      return updated;
    });
    try { await API.savePorts(updated); } catch (e) { console.warn('[saveInlineUrl] persist failed:', e); }
  }, []);

  const saveGitHubUrls = useCallback(async (id: string, value: string) => {
    const fields = githubRepositoryUrlFields(value);
    let updated: PortInfo[] = [];
    setPorts(prev => {
      updated = prev.map(p => p.id === id ? { ...p, ...fields } : p);
      return updated;
    });
    try { await API.savePorts(updated); } catch (e) { console.warn('[saveGitHubUrls] persist failed:', e); }
  }, []);

  // 수정 폼에서는 저장 전 임시 값을 갱신해야 한다. 기존 상세용 핸들러를
  // 그대로 호출하면 ports만 바뀐 뒤 saveEdit이 이전 입력값으로 덮어쓴다.
  const handleAiSuggestEdit = useCallback(async () => {
    if (!editingId || !editFolderPath.trim()) {
      showToast('AI 생성에는 프로젝트 폴더 경로가 필요합니다', 'error');
      return;
    }
    setAiSuggestingId(editingId);
    try {
      const { name: aiName, category } = await API.suggestNameAndCategory(editFolderPath.trim(), editName.trim());
      if (!aiName && !category) {
        showToast('AI 제안 생성 실패', 'error');
        return;
      }
      if (aiName) setEditAiName(aiName);
      if (category) setEditCategory(category);
      showToast('프로젝트 별명/카테고리를 입력했습니다. 저장 버튼을 눌러 반영하세요.', 'success');
    } finally {
      setAiSuggestingId(null);
    }
  }, [editingId, editFolderPath, editName]);

  const handleCopyEditAiNamePrompt = useCallback(async () => {
    if (!editingId || !editFolderPath.trim()) {
      showToast('채팅 명령에는 프로젝트 폴더 경로가 필요합니다', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(buildSingleAiNameChatPrompt({
        id: editingId,
        name: editName.trim(),
        folderPath: editFolderPath.trim(),
        aiName: editAiName.trim() || undefined,
        category: editCategory.trim() || undefined,
      }));
      showToast(`"${editName.trim()}" AI 채팅 명령 복사됨 — Claude 또는 Codex에 붙여넣으세요`, 'success');
    } catch {
      showToast('클립보드 복사 실패', 'error');
    }
  }, [editingId, editFolderPath, editName, editAiName, editCategory]);

  // 9000번대에서 등록되지 않고 실제로도 열려있지 않은 첫 빈 포트를 찾는다.
  const findAvailableProjectPort = useCallback(async (base = 9000, max = 9999): Promise<number | null> => {
    const used = new Set(ports.map(p => p.port).filter((p): p is number => !!p));
    for (let candidate = base; candidate <= max; candidate++) {
      if (used.has(candidate)) continue;
      const running = await API.checkPortStatus(candidate).catch(() => false);
      if (!running) return candidate;
    }
    return null;
  }, [ports]);

  const suggestPort = useCallback(async (setter: (v: string) => void, base = 9000, max = 9999) => {
    const candidate = await findAvailableProjectPort(base, max);
    if (candidate) {
      setter(String(candidate));
      showToast(`추천 포트: ${candidate}`, 'success');
      return;
    }
    showToast(`${base}~${max} 범위에 빈 포트가 없습니다`, 'error');
  }, [findAvailableProjectPort]);

  const assignLocalPreviewPort = useCallback(async (item: PortInfo) => {
    const candidate = await findAvailableProjectPort();
    if (!candidate) {
      showToast('9000~9999 범위에 빈 포트가 없습니다', 'error');
      return;
    }
    const updated = ports.map(port => port.id === item.id ? { ...port, port: candidate, isRunning: false } : port);
    try {
      await API.savePorts(updated);
      setPorts(updated);
      showToast(`${item.name} 로컬 미리보기 포트를 :${candidate}로 설정했습니다`, 'success');
    } catch (error) {
      showToast(`포트 저장 실패: ${error}`, 'error');
    }
  }, [findAvailableProjectPort, ports]);

  // .command/.html 등 실행 파일을 네이티브 파일 다이얼로그로 선택 (Tauri 전용 — 브라우저는 절대경로 접근 불가)
  const closeQuickAddModal = () => {
    setShowQuickAddModal(false);
    setQaName(''); setQaPort(''); setQaDeployUrl(''); setQaGithubUrl(''); setQaCategory(''); setQaDescription('');
  };
  const saveQuickAddProject = async () => {
    const name = qaName.trim();
    if (!name) return;
    const portNum = qaPort.trim() ? parseInt(qaPort.trim(), 10) : undefined;
    const newPort: PortInfo = {
      id: crypto.randomUUID(),
      name,
      port: portNum && !isNaN(portNum) ? portNum : undefined,
      deployUrl: qaDeployUrl.trim() || undefined,
      ...githubRepositoryUrlFields(qaGithubUrl),
      category: qaCategory.trim() || undefined,
      description: qaDescription.trim() || undefined,
      isRunning: false,
      sourceDeviceId: portalConfigRef.current?.deviceId,
    };
    const updated = [newPort, ...ports];
    setPorts(updated);
    try { await API.savePorts(updated); } catch (e) { console.warn('[saveQuickAddProject] persist failed:', e); }
    setV4SelectedId(newPort.id);
    closeQuickAddModal();
    showToast(`'${name}' 추가됨`, 'success');
  };

  const executeCommand = async (
    item: PortInfo,
    options: { missingTargetBehavior?: 'error' | 'skip' } = {}
  ): Promise<'started' | 'opened' | 'missing' | 'failed'> => {
    // 연결 워크트리는 메인 프로젝트의 실행 파일/명령을 재사용하지 않는다.
    // 오래된 영구 항목에 commandPath가 남아 있어도 워크트리 폴더의 매니페스트에서
    // 실행 명령을 다시 찾고, 아래 execute API가 해당 워크트리 포트를 주입한다.
    const autoDetectFromFolder = shouldAutoDetectProjectStart(item);
    let runTarget = autoDetectFromFolder ? undefined : (item.terminalCommand || item.commandPath);

    // commandPath/terminalCommand 없으면 folderPath에서 자동 감지
    if (!runTarget && item.folderPath) {
      try {
        const { command: detected, framework } = await API.detectStartCommand(item.folderPath);
        if (detected) {
          runTarget = detected;
          // 워크트리 실행 시: dev 스크립트가 순수 vite/next 단일 바이너리 호출이면
          // 로컬 node_modules/.bin 스크립트 러너를 우회해 bunx로 직접 실행 + 포트 지정.
          // framework가 'other'(커스텀 코디네이터 스크립트 등)면 절대 덮어쓰지 않는다 —
          // 잘못된 툴을 강제 실행해 실제 dev 서버(백엔드 포함)가 하나도 안 뜨는 사고 방지.
          if (item.port && item.worktreePath && framework === 'vite') {
            runTarget = `bunx vite --port ${item.port}`;
          } else if (item.port && item.worktreePath && framework === 'next') {
            runTarget = `bunx next dev -p ${item.port}`;
          }
          showToast(`${item.worktreePath ? '워크트리 ' : ''}자동 감지: ${runTarget} · PORT=${item.port ?? '미지정'}`, 'success');
        }
      } catch {}
    }

    if (!runTarget) {
      if (options.missingTargetBehavior !== 'skip') {
        showToast('실행할 파일 또는 터미널 명령어가 등록되지 않았습니다.', 'error');
      }
      return 'missing';
    }

    const html = !autoDetectFromFolder && !item.terminalCommand && isHtmlFile(item.commandPath);
    try {
      if (html) {
        await API.openFolder(item.commandPath!);
        showToast(`${item.name} 파일을 열었습니다!`, 'success');
        return 'opened';
      } else {
        await API.executeCommand(item.id, runTarget, item.folderPath, item.port);
        setPorts(prev => prev.map(p =>
          p.id === item.id ? { ...p, isRunning: true } : p
        ));
        showToast(`${item.name} 서버가 시작되었습니다!`, 'success');
        recordVisit(item.id);
        if (item.port) {
          // 2초 뒤 실제 포트 상태 재확인 (서버 기동 지연 보정)
          setTimeout(async () => {
            const isRunning = await API.checkPortStatus(item.port!).catch(() => false);
            setPorts(prev => prev.map(p => p.id === item.id ? { ...p, isRunning } : p));
          }, 2000);
        }
        return 'started';
      }
    } catch (error) {
      showToast('실행 실패: ' + error, 'error');
      return 'failed';
    }
  };

  const stopCommand = async (item: PortInfo) => {
    try {
      await API.stopCommand(item.id, item.port ?? 0);
      setPorts(prev => prev.map(p =>
        p.id === item.id ? { ...p, isRunning: false } : p
      ));
      showToast(`${item.name} 서버가 중지되었습니다!`, 'success');
      // 1.5초 뒤 실제 포트 상태 재확인 (kill 완료 전 race 방지)
      if (item.port) {
        setTimeout(async () => {
          const isRunning = await API.checkPortStatus(item.port!).catch(() => false);
          if (isRunning) {
            setPorts(prev => prev.map(p => p.id === item.id ? { ...p, isRunning: true } : p));
            showToast(`${item.name} 포트가 아직 사용 중입니다. 강제 재실행을 시도하세요.`, 'error');
          }
        }, 1500);
      }
    } catch (error) {
      showToast('서버 중지 중 오류: ' + error, 'error');
    }
  };

  const forceRestartCommand = async (item: PortInfo) => {
    const autoDetectFromFolder = shouldAutoDetectProjectStart(item);
    let runTarget = autoDetectFromFolder ? undefined : (item.terminalCommand || item.commandPath);
    // commandPath/terminalCommand 없으면 folderPath에서 자동 감지 (워크트리 케이스)
    if (!runTarget && item.folderPath) {
      try {
        const { command: detected, framework } = await API.detectStartCommand(item.folderPath);
        if (detected) {
          runTarget = detected;
          if (item.port && item.worktreePath && framework === 'vite') {
            runTarget = `bunx vite --port ${item.port}`;
          } else if (item.port && item.worktreePath && framework === 'next') {
            runTarget = `bunx next dev -p ${item.port}`;
          }
        }
      } catch {}
    }
    if (!runTarget) {
      showToast('실행할 파일 또는 터미널 명령어가 등록되지 않았습니다.', 'error');
      return;
    }

    const html = !autoDetectFromFolder && !item.terminalCommand && isHtmlFile(item.commandPath);
    try {
      if (html) {
        await API.openFolder(item.commandPath!);
        showToast(`${item.name} 파일을 열었습니다!`, 'success');
      } else {
        await API.forceRestartCommand(item.id, item.port, runTarget, item.folderPath);
        setPorts(prev => prev.map(p =>
          p.id === item.id ? { ...p, isRunning: true } : p
        ));
        showToast(`${item.name} 서버가 강제 재실행되었습니다!`, 'success');
      }
    } catch (error) {
      showToast('강제 재실행 실패: ' + error, 'error');
    }
  };

  const handleExportPorts = async () => {
    if (ports.length === 0) {
      showToast('내보낼 포트 정보가 없습니다.', 'error');
      return;
    }

    try {
      if (isTauri()) {
        // Tauri 앱에서는 파일 저장 다이얼로그 사용
        const { save } = await import('@tauri-apps/plugin-dialog');
        const filePath = await save({
          defaultPath: 'ports.json',
          filters: [{
            name: 'JSON',
            extensions: ['json']
          }]
        });

        if (filePath) {
          const content = JSON.stringify(ports, null, 2);
          const { writeTextFile } = await import('@tauri-apps/plugin-fs');
          await writeTextFile(filePath, content);
          showToast('포트 정보를 성공적으로 내보냈습니다.', 'success');
        }
      } else {
        // 브라우저에서는 파일 다운로드
        const content = JSON.stringify(ports, null, 2);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ports.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('포트 정보를 성공적으로 내보냈습니다.', 'success');
      }
    } catch (error) {
      showToast('파일 내보내기 실패: ' + error, 'error');
    }
  };

  const handleImportPorts = async () => {
    try {
      if (isTauri()) {
        // Tauri: 네이티브 파일 다이얼로그 사용
        const { open } = await import('@tauri-apps/plugin-dialog');

        const selected = await open({
          multiple: false,
          filters: [{
            name: 'JSON',
            extensions: ['json']
          }]
        });

        if (selected && typeof selected === 'string') {
          // Rust의 import_ports_from_file를 사용하여 파일 읽기
          const importedPorts = await API.importPorts(selected);

          if (importedPorts.length > 0) {
            const existingIds = new Set(ports.map(p => p.id));
            const newPorts = importedPorts.filter(p => !existingIds.has(p.id));

            if (newPorts.length > 0) {
              const updatedPorts = [...ports, ...newPorts];
              setPorts(updatedPorts);

              // 명시적으로 저장
              if (import.meta.env.DEV) console.log('[Import] Explicitly saving ports after import');
              await API.savePorts(updatedPorts);
              if (import.meta.env.DEV) console.log('[Import] Ports saved successfully');

              showToast(`${newPorts.length}개의 포트 정보를 불러왔습니다.`, 'success');
            } else {
              showToast('새로운 포트 정보가 없습니다. (모두 이미 등록되어 있음)', 'error');
            }
          } else {
            showToast('불러온 파일에 포트 정보가 없습니다.', 'error');
          }
        }
      } else {
        // 브라우저: FileReader 사용
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = async (event) => {
              try {
                const content = event.target?.result as string;
                const importedPorts = JSON.parse(content) as PortInfo[];

                if (importedPorts.length > 0) {
                  const existingIds = new Set(ports.map(p => p.id));
                  const newPorts = importedPorts.filter(p => !existingIds.has(p.id));

                  if (newPorts.length > 0) {
                    const updatedPorts = [...ports, ...newPorts];
                    setPorts(updatedPorts);

                    if (import.meta.env.DEV) console.log('[Import] Explicitly saving ports after import');
                    await API.savePorts(updatedPorts);
                    if (import.meta.env.DEV) console.log('[Import] Ports saved successfully');

                    showToast(`${newPorts.length}개의 포트 정보를 불러왔습니다.`, 'success');
                  } else {
                    showToast('새로운 포트 정보가 없습니다. (모두 이미 등록되어 있음)', 'error');
                  }
                } else {
                  showToast('불러온 파일에 포트 정보가 없습니다.', 'error');
                }
              } catch (error) {
                showToast('파일 읽기 실패: ' + error, 'error');
              }
            };
            reader.readAsText(file);
          }
        };
        input.click();
      }
    } catch (error) {
      showToast('파일 불러오기 실패: ' + error, 'error');
    }
  };

  const handleRestoreFromSupabase = async () => {
    if (isRestoring) return;
    setIsRestoring(true);
    try {
      let portalData: any;
      if (isTauri()) {
        portalData = await invoke('load_portal');
      } else {
        portalData = await getPortalCredentials();
      }
      if (portalData?.supabaseUrl) cachePortalConfig(portalData);

      const { supabaseUrl, supabaseAnonKey } = portalData ?? {};
      if (!supabaseUrl || !supabaseAnonKey) {
        showToast('Supabase 설정이 없습니다. 포털 탭에서 먼저 설정하세요', 'error');
        return;
      }

      const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
      // 설정의 "다른 기기 보기"가 선택돼 있으면 그 기기 기준으로 Pull
      const pullDeviceId = portalData?.viewingDeviceId || portalData?.deviceId || null;
      const isOtherDevice = portalData?.viewingDeviceId && portalData.viewingDeviceId !== portalData?.deviceId;

      let portsQuery = supabase.from('portmgr_ports').select('*');
      if (pullDeviceId) portsQuery = portsQuery.eq('device_id', pullDeviceId);
      let { data, error } = await withTimeout(portsQuery, 30_000);

      if (error) throw new Error(describeSupabaseError(error));
      if (!data || data.length === 0) {
        // Diagnose: check if any rows exist (device ID mismatch vs truly empty)
        if (pullDeviceId) {
          const { data: anyRows } = await withTimeout(
            supabase.from('portmgr_ports').select('device_id').limit(5),
            10_000
          );
          if (anyRows && anyRows.length > 0) {
            const ids = [...new Set(anyRows.map((r: any) => r.device_id).filter(Boolean))];
            const urlHint = supabaseUrl?.replace('https://', '').slice(0, 22) ?? '?';
            showToast(`[${urlHint}] 기기 ID(${(pullDeviceId as string).slice(0, 8)}…)로 저장된 포트가 없습니다. 다른 기기(${ids.map((id: string) => id.slice(0, 8)).join(', ')}…) 데이터가 있습니다. 포털 탭에서 기기를 선택 후 재시도하세요.`, 'error');
            return;
          }
        }
        const urlHint2 = supabaseUrl?.replace('https://', '').slice(0, 22) ?? '?';
        showToast(`[${urlHint2}] Supabase에 저장된 포트가 없습니다. 데스크탑 앱에서 Push 먼저 실행하세요.`, 'error');
        return;
      }

      const remoteRows: PortInfo[] = data.map((row: any) => ({
        id: row.id,
        name: row.name,
        port: row.port ?? undefined,
        commandPath: row.command_path ?? undefined,
        terminalCommand: row.terminal_command ?? undefined,
        folderPath: row.folder_path ?? undefined,
        deployUrl: row.deploy_url ?? undefined,
        ...githubRepositoryUrlFields(githubRepositoryUrls({
          githubUrl: row.github_url,
          githubUrls: row.github_urls,
        })),
        manualPath: row.manual_path ?? undefined,
        logFilePath: row.log_file_path ?? undefined,
        category: row.category ?? undefined,
        description: row.description ?? undefined,
        aiName: row.ai_name ?? undefined,
        favorite: row.favorite ?? false,
        isRunning: false,
        sourceDeviceId: row.device_id ?? undefined,
      }));

      // 다른 기기 Pull → name 기준 병합 + 새 ID 발급 (ID 충돌 방지)
      // 내 기기 Pull → ID 기준 병합 (기존 동작 유지)
      let idMap: Map<string, string> | null = null;
      let merged: PortInfo[];
      if (isOtherDevice) {
        const result = mergePortsFromOtherDevice(ports, remoteRows);
        merged = result.merged;
        idMap = result.idMap;
      } else {
        merged = mergePorts(ports, remoteRows);
      }
      setPorts(merged);
      await API.savePorts(merged);

      // 메모 복원 — 다른 기기 Pull 시 원격 row id를 새 로컬 id로 재매핑
      const pulledMemos: Record<string, { content: string; updatedAt: string }> = {};
      (data ?? []).forEach((row: any) => {
        if (row.memo != null) {
          const memoKey = idMap?.get(row.id) ?? row.id;
          pulledMemos[memoKey] = { content: row.memo, updatedAt: row.memo_updated_at ?? '' };
        }
      });
      if (Object.keys(pulledMemos).length > 0) {
        setMemos(prev => {
          const next = { ...prev };
          for (const [mid, m] of Object.entries(pulledMemos)) {
            const localMemo = next[mid];
            if (!localMemo || (m.updatedAt ?? '') >= (localMemo.updatedAt ?? '')) next[mid] = m;
          }
          return next;
        });
      }

      let rootsMsg = '';
      // 다른 기기 Pull 시 작업루트는 건드리지 않음 (경로가 기기마다 다름)
      if (pullDeviceId && !isOtherDevice) {
        let { data: rootData } = await supabase
          .from('portmgr_workspace_roots').select('*').eq('device_id', pullDeviceId);
        if (!rootData || rootData.length === 0) {
          const fallback = await supabase.from('portmgr_workspace_roots').select('*');
          if (fallback.data && fallback.data.length > 0) rootData = fallback.data;
        }
        if (rootData && rootData.length > 0) {
          const remoteRoots2: WorkspaceRoot[] = rootData
            .filter((r: any) => !r.path?.startsWith('__device__'))
            // device_id 매칭 실패 시 전 기기 루트를 fallback으로 받으므로 여기서 플랫폼 필터가 필요하다
            .filter((r: any) => isUsableRootPath(r?.path))
            .map((r: any) => ({ id: r.id, name: r.name, path: r.path }));
          if (remoteRoots2.length > 0) {
            const localRoots2 = await API.loadWorkspaceRoots();
            const mergedRoots2 = mergeWorkspaceRootsPreservingLocalOrder(localRoots2, remoteRoots2);
            setWorkspaceRoots(mergedRoots2);
            await API.saveWorkspaceRoots(mergedRoots2);
            rootsMsg = ` + ${mergedRoots2.length}개 작업루트`;
          }
        }
      }
      const label = isOtherDevice ? '[다른 기기] ' : '';
      showToast(`${label}Supabase에서 ${merged.length}개 포트${rootsMsg}를 복원했습니다 ✓`, 'success');

      // 다른 기기 Pull 후 경로 없는 포트가 있으면 remapping 모달 표시
      if (isOtherDevice) {
        const needsPath = merged.filter(p => !p.folderPath && !p.commandPath && !p.terminalCommand);
        if (needsPath.length > 0) {
          setRemappingPorts(needsPath);
          setRemappingPaths({});
        }
      }
    } catch (e) {
      showToast('Supabase 복원 실패: ' + e, 'error');
    } finally {
      setIsRestoring(false);
    }
  };

  async function openPortsHistory() {
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) { showToast('Supabase 설정이 없습니다', 'error'); return; }
    setPortsHistoryLoading(true);
    setShowPortsHistory(true);
    try {
      const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const list = await fetchPushHistory(supabase, 'portmgr_ports', cfg.deviceId ?? null);
      setPortsHistoryList(list);
    } catch (e) {
      // fetchPushHistory 는 이제 오류를 던진다(예전에는 빈 배열로 뭉갰다).
      // 여기서 받지 않으면 스피너가 영원히 돈다.
      showToast(`히스토리를 읽지 못했습니다: ${describeSupabaseError(e)}`, 'error');
    } finally {
      setPortsHistoryLoading(false);
    }
  }

  async function restorePortsSnapshot(snapshotId: string) {
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
    setPortsHistoryRestoring(snapshotId);
    try {
      const supabase = getSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const rows = await fetchSnapshotRows(supabase, snapshotId) as any[];
      if (rows.length === 0) { showToast('스냅샷이 비어있습니다', 'error'); return; }
      let restoreRows = rows;
      let { error: uErr } = await supabase.from('portmgr_ports').upsert(restoreRows, { onConflict: 'id' });
      if (uErr?.message?.includes('github_urls')) {
        restoreRows = rows.map(({ github_urls, ...rest }) => rest);
        ({ error: uErr } = await supabase.from('portmgr_ports').upsert(restoreRows, { onConflict: 'id' }));
      }
      if (uErr) throw new Error(uErr.message);
      const snapshotIds = new Set(rows.map(r => r.id));
      const deviceId = cfg.deviceId ?? null;
      const { data: current } = await supabase.from('portmgr_ports').select('id').eq('device_id', deviceId);
      const toDelete = (current ?? []).filter((r: any) => !snapshotIds.has(r.id)).map((r: any) => r.id);
      if (toDelete.length > 0) await supabase.from('portmgr_ports').delete().in('id', toDelete);
      await handleRestoreFromSupabase();
      showToast('스냅샷으로 복원 완료 ✓', 'success');
      setShowPortsHistory(false);
    } catch (e) {
      showToast('복원 실패: ' + e, 'error');
    } finally {
      setPortsHistoryRestoring(null);
    }
  }

  const handlePushToSupabase = async () => {
    if (isPushingPorts) return;
    setIsPushingPorts(true);
    try {
      let portalData: any;
      if (isTauri()) {
        portalData = await invoke('load_portal');
      } else {
        portalData = await getPortalCredentials();
      }
      // Keep portalConfigRef in sync so auto-push fires after credentials are set
      if (portalData?.supabaseUrl) cachePortalConfig(portalData);
      const { supabaseUrl, supabaseAnonKey } = portalData ?? {};
      if (!supabaseUrl || !supabaseAnonKey) {
        showToast('Supabase 설정이 없습니다. 포털 탭에서 먼저 설정하세요', 'error');
        return;
      }
      const deviceId = portalData.deviceId ?? null;
      const deviceNameVal = portalData.deviceName ?? null;
      const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);

      // 새 기기에서 포트 목록이 비어있으면 Pull 먼저 하도록 안내
      if (ports.length === 0) {
        showToast('포트 목록이 비어있습니다. Pull 먼저 실행하세요.', 'error');
        return;
      }

      // 다른 기기 소유 포트는 push 제외 + 같은 id 중복 제거 (upsert 배치 거부 방지)
      const ownedPorts = dedupePortsById(ports.filter(p => !p.sourceDeviceId || p.sourceDeviceId === deviceId));
      // 폴더마다 왕복하지 않는다 — 프로젝트가 100개를 넘는 기기가 있다. 실패해도 Push 를
      // 막지 않는다: memory_id 는 곁들이는 정보이고, 비면 포털이 예전처럼 추측한다.
      const memoryIds = await fetchProjectMemoryIds(ownedPorts.map(p => p.folderPath).filter(Boolean) as string[]);
      const rows = ownedPorts.map(p => ({
        id: p.id,
        name: p.name,
        port: p.port ?? null,
        command_path: p.commandPath ?? null,
        terminal_command: p.terminalCommand ?? null,
        folder_path: p.folderPath ?? null,
        deploy_url: p.deployUrl ?? null,
        ...githubDatabaseFields(p),
        manual_path: p.manualPath ?? null,
        log_file_path: p.logFilePath ?? null,
        favorite: p.favorite ?? false,
        device_id: deviceId,
        device_name: deviceNameVal,
        memo: memos[p.id]?.content ?? null,
        memo_updated_at: memos[p.id]?.updatedAt ?? null,
        // 이 프로젝트의 장기기억을 **정확히** 가리킨다. 예전에는 포털이 저장소/이름으로
        // 추측해야 했는데, 기억 대부분은 저장소가 없고 폴더 이름은 바뀐다.
        memory_id: memoryIds[p.folderPath ?? ''] ?? null,
      }));
      await savePushSnapshot(supabase, 'portmgr_ports', deviceId, deviceNameVal, rows);
      let upsertRows: any[] = rows;
      let { error } = await supabase.from('portmgr_ports').upsert(upsertRows, { onConflict: 'id' });
      if (error?.message?.includes('github_urls')) {
        // Compatibility with Supabase projects that have not yet run the
        // github_urls migration: retain the legacy primary URL remotely.
        upsertRows = upsertRows.map(({ github_urls, ...rest }: any) => rest);
        const retry = await supabase.from('portmgr_ports').upsert(upsertRows, { onConflict: 'id' });
        error = retry.error;
        if (!error) showToast('GitHub 추가 주소 DB 컬럼이 없어 첫 주소만 동기화했습니다. 마이그레이션 후 다시 Push하세요.', 'error');
      }
      if (error?.message?.includes('memory_id')) {
        upsertRows = upsertRows.map(({ memory_id, ...rest }: any) => rest);
        const retry = await supabase.from('portmgr_ports').upsert(upsertRows, { onConflict: 'id' });
        error = retry.error;
        if (!error) showToast('memory_id DB 컬럼이 없어 장기기억 연결 없이 Push했습니다. 마이그레이션 후 다시 Push하세요.', 'error');
      }
      if (error?.message?.includes('manual_path') || error?.message?.includes('log_file_path')) {
        upsertRows = upsertRows.map(({ manual_path, log_file_path, ...rest }: any) => rest);
        const retry = await supabase.from('portmgr_ports').upsert(upsertRows, { onConflict: 'id' });
        error = retry.error;
        if (!error) showToast('문서 경로 DB 컬럼이 없어 이 기기에만 저장했습니다. 마이그레이션 후 다시 Push하세요.', 'error');
      }
      if (error?.message?.includes('device_id') || error?.message?.includes('device_name')) {
        // device_id/device_name column not yet migrated — retry without it
        upsertRows = upsertRows.map(({ device_id, device_name, ...rest }: any) => rest);
        const { error: e2 } = await supabase.from('portmgr_ports').upsert(upsertRows, { onConflict: 'id' });
        error = e2 ?? null;
        if (!e2) showToast('⚠ device_id 컬럼 없음 — 초기설정 가이드의 AI 프롬프트로 마이그레이션 후 재Push 권장', 'error');
      }
      if (error) throw new Error(describeSupabaseError(error));
      // Register this device in devices table (non-blocking)
      if (deviceId) {
        supabase.from('portmgr_devices').upsert(
          { id: deviceId, name: deviceNameVal, last_push_at: new Date().toISOString() },
          { onConflict: 'id' }
        ).then(() => {}, () => {});
      }
      // Fix P2: delete remote rows whose IDs are no longer in local list
      // Fix P2g: skip delete pass if auto-pull never succeeded — pull first before deleting
      // Step 4: scope stale-delete to this device only — deviceId 없으면 전 기기 삭제 위험이라 skip
      if (autopullSucceeded.current && deviceId) {
        const localIds = ownedPorts.map(p => p.id);
        const remoteQuery = supabase.from('portmgr_ports').select('id').eq('device_id', deviceId);
        const { data: remoteRows } = await remoteQuery;
        const staleIds = (remoteRows ?? []).map((r: any) => r.id).filter((id: string) => !localIds.includes(id));
        if (staleIds.length > 0) {
          await supabase.from('portmgr_ports').delete().in('id', staleIds);
        }
      }

      // deployUrl/githubUrls → portal_items 자동 공유 (__shared__)
      const now = new Date().toISOString();
      const autoItems = ownedPorts.flatMap(p => {
        const items: object[] = [];
        if (p.deployUrl) items.push({
          id: `auto:deploy:${p.id}`, name: p.name, type: 'web',
          url: p.deployUrl, category: p.category || '프로젝트',
          description: `배포 주소 — ${p.name}`, device_id: '__shared__',
          pinned: false, visit_count: 0, created_at: now,
        });
        githubRepositoryUrls(p).forEach((url, index) => items.push({
          id: githubPortalItemId(p.id, url, index),
          name: `${p.name} GitHub${index === 0 ? '' : ` ${index + 1}`}`, type: 'web',
          url, category: 'GitHub',
          description: `GitHub 저장소${index === 0 ? '' : ` ${index + 1}`} — ${p.name}`, device_id: '__shared__',
          pinned: false, visit_count: 0, created_at: now,
        }));
        return items;
      });
      if (autoItems.length > 0) {
        await supabase.from('portmgr_portal_items').upsert(autoItems, { onConflict: 'id' });
      }
      // URL이 없어진 포트의 stale auto portal_items 삭제
      const activeAutoIds = new Set(autoItems.map((x: any) => x.id));
      const allAutoIds = ownedPorts.flatMap(p => [`auto:deploy:${p.id}`, `auto:github:${p.id}`]);
      const staleAutoIds = allAutoIds.filter(id => !activeAutoIds.has(id));
      if (staleAutoIds.length > 0) {
        await supabase.from('portmgr_portal_items').delete().in('id', staleAutoIds);
      }
      // Secondary repository IDs include a stable URL hash. Query only the
      // reserved per-project prefix so removed extra links do not linger.
      await Promise.all(ownedPorts.map(async p => {
        const prefix = `auto:github:${p.id}:repo:%`;
        const { data } = await supabase.from('portmgr_portal_items').select('id').like('id', prefix);
        const staleIds = (data ?? []).map((row: any) => row.id).filter((id: string) => !activeAutoIds.has(id));
        if (staleIds.length > 0) await supabase.from('portmgr_portal_items').delete().in('id', staleIds);
      }));

      // workspace_roots 업로드
      let rootsMsg = '';
      if (deviceId) {
        const rootRows = workspaceRoots.map(r => ({
          id: r.id, device_id: deviceId, name: r.name, path: r.path,
        }));
        // 기기명 sentinel 행 — 스키마 변경 없이 device_name을 Supabase에 저장
        if (deviceNameVal) {
          rootRows.push({ id: `__device__${deviceId}`, device_id: deviceId, name: deviceNameVal, path: `__device__${deviceId}` });
        }
        if (rootRows.length > 0) {
          const { error: rootError } = await supabase.from('portmgr_workspace_roots').upsert(rootRows, { onConflict: 'id' });
          if (rootError) {
            rootsMsg = ` (작업루트 업로드 실패: ${rootError.message})`;
          } else if (workspaceRoots.length > 0) {
            rootsMsg = ` + ${workspaceRoots.length}개 작업루트`;
          }
        }
      }
      showToast(`Supabase에 ${ports.length}개 포트${rootsMsg}를 업로드했습니다 ✓`, 'success');
    } catch (e) {
      showToast('Supabase 업로드 실패: ' + e, 'error');
    } finally {
      setIsPushingPorts(false);
    }
  };

  // 동시 실행 수 제한 풀 (AI 일괄 요청용)
  async function runWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const slots = Array.from({ length: Math.min(limit, queue.length) }, () =>
      (async () => { while (queue.length > 0) await worker(queue.shift()!); })()
    );
    await Promise.all(slots);
  }

  const handleRefresh = async () => {
    if (isRefreshing || isAiEnriching) return;

    setIsRefreshing(true);
    let _refreshed: PortInfo[] = [];
    try {
      const data = await API.loadPorts();

      // 경로 검증 및 자동 업데이트
      const updatedDataPromises = data.map(async (port: PortInfo) => {
        let updated = { ...port };

        // [1] commandPath 존재 확인 → 없으면 무효화 (아래에서 재스캔) - Tauri 모드만
        if (updated.commandPath && isTauri()) {
          try {
            const exists = await invoke<boolean>('check_file_exists', { path: updated.commandPath });
            if (!exists) {
              if (import.meta.env.DEV) console.log(`[Refresh] commandPath not found, will re-scan: ${updated.commandPath}`);
              updated.commandPath = undefined;
            }
          } catch {}
        }

        // [2] folderPath 존재 확인 → 없으면 commandPath에서 재추출 시도 - Tauri 모드만
        if (updated.folderPath && isTauri()) {
          try {
            const exists = await invoke<boolean>('check_file_exists', { path: updated.folderPath });
            if (!exists) {
              if (updated.commandPath) {
                const idx = updated.commandPath.lastIndexOf('/');
                updated.folderPath = idx !== -1 ? updated.commandPath.substring(0, idx) : undefined;
              } else {
                updated.folderPath = undefined;
              }
            }
          } catch {}
        }

        // [3] commandPath 있고 folderPath 없으면 재추출
        if (updated.commandPath && !updated.folderPath) {
          const lastSlashIndex = updated.commandPath.lastIndexOf('/');
          if (lastSlashIndex !== -1) {
            updated.folderPath = updated.commandPath.substring(0, lastSlashIndex);
          }
        }

        // [4] folderPath 있고 commandPath 없으면 실행 파일 자동 스캔
        if (updated.folderPath && !updated.commandPath) {
          try {
            const found = await API.scanCommandFiles(updated.folderPath);
            if (found.length > 0) {
              updated.commandPath = found[0];
              // 포트 번호도 자동 감지
              if (!updated.port) {
                try {
                  const detected = await API.detectPort(found[0]!);
                  if (detected.port) updated.port = detected.port;
                } catch {}
              }
            }
          } catch {}
        }

        // [5] commandPath 있지만 port 없으면 파일에서 자동 감지
        if (updated.commandPath && !updated.port) {
          try {
            const detected = await API.detectPort(updated.commandPath);
            if (detected.port) updated.port = detected.port;
          } catch {}
        }

        return updated;
      });

      const updatedData = await Promise.all(updatedDataPromises);
      for (const port of updatedData) {
        if (!port.port) port.isRunning = false;
      }

      // 포트 상태 일괄 확인 (배치 — 포트당 lsof 1회 대신 단일 호출)
      const refreshPorts = [...new Set(updatedData.filter(p => p.port).map(p => p.port!))];
      if (refreshPorts.length > 0) {
        try {
          const batchResults = await API.checkPortsStatusBatch(refreshPorts);
          const statusByPort = new Map(batchResults.map(r => [r.port, r.isRunning]));
          for (const p of updatedData) {
            // 결과에 없는 포트는 기존 isRunning 유지 (기존 per-port catch 동작과 동일)
            if (p.port) p.isRunning = statusByPort.get(p.port) ?? p.isRunning;
          }
        } catch (e) {
          console.error('Failed to batch-check port status:', e);
        }
      }

      _refreshed = updatedData;
      setPorts(updatedData);
      showToast('포트 목록을 새로고침했습니다', 'success');
    } catch (error) {
      showToast('새로고침 실패: ' + error, 'error');
    } finally {
      setIsRefreshing(false);
    }

    // Phase 2: AI 이름/카테고리 배치 생성 (missing 항목만)
    // 한 번의 claude -p 호출에 너무 많은 프로젝트를 넣으면 응답 생성 시간이 늘어나
    // 서버 타임아웃(60s)에 걸려 전체 배치가 통째로 실패한다 (결과 없이 조용히 {results:[]}).
    // 그래서 AI_BATCH_CHUNK_SIZE 단위로 쪼개 순차 호출하고, 청크마다 즉시 저장해
    // 뒤쪽 청크가 실패해도 앞쪽에서 얻은 결과는 남도록 한다.
    const targets = _refreshed.filter(p => p.folderPath && (!p.aiName || !p.category));
    if (targets.length === 0) return;
    setIsAiEnriching(true);
    const AI_BATCH_CHUNK_SIZE = 15;
    const chunks: PortInfo[][] = [];
    for (let i = 0; i < targets.length; i += AI_BATCH_CHUNK_SIZE) chunks.push(targets.slice(i, i + AI_BATCH_CHUNK_SIZE));
    let nameCount = 0, catCount = 0, failedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      showToast(`AI 이름/카테고리 생성 중… (${i * AI_BATCH_CHUNK_SIZE + chunks[i]!.length}/${targets.length})`, 'success');
      try {
        const batchInput = chunks[i]!.map(p => ({ id: p.id, folderPath: p.folderPath!, name: p.name, aiName: p.aiName }));
        const results = await API.suggestBatch(batchInput);
        const resultMap = new Map(results.map(r => [r.id, r]));
        setPorts(prev => prev.map(p => {
          const r = resultMap.get(p.id);
          if (!r) return p;
          const newName = !p.aiName && r.name ? r.name : undefined;
          const newCat = !p.category && r.category ? r.category : undefined;
          if (newName) nameCount++;
          if (newCat) catCount++;
          return (newName || newCat) ? { ...p, aiName: newName ?? p.aiName, category: newCat ?? p.category } : p;
        }));
      } catch {
        failedChunks++;
      }
      // 청크 완료마다 즉시 저장 — 이후 청크가 실패/중단돼도 지금까지의 진행은 보존
      await new Promise<void>(resolve => setPorts(prev => { API.savePorts(prev); resolve(); return prev; }));
    }
    setIsAiEnriching(false);
    const failHint = failedChunks > 0 ? ` (${failedChunks}개 배치 실패, 다음 새로고침에서 재시도됩니다)` : '';
    showToast(`AI 업데이트 완료: 이름 ${nameCount}개, 카테고리 ${catCount}개${failHint}`, failedChunks > 0 ? 'error' : 'success');
  };

  // Port log viewer handler
  const handleViewPortLog = async (portId: string, portName: string) => {
    setViewingPortId(portId);
    setViewingPortName(portName);
    setPortLogs([]);
    portLogOffsetRef.current = 0;
    setShowPortLog(true);
    setIsLoadingPortLog(true);

    // Clear any existing polling
    if (portLogPollingRef.current) {
      clearInterval(portLogPollingRef.current);
      portLogPollingRef.current = null;
    }
    portLogPollBusyRef.current = false;

    const MAX_LOG_LINES = 500; // 슬라이딩 윈도우 — 초기 로드/폴링 공통 적용 (렌더 성능 보호)
    try {
      // Initial load
      const data = await API.readLogContent(portId, 0);
      if (!data.exists) {
        setPortLogs(['로그 파일이 아직 생성되지 않았습니다.', '', '서버를 이 앱에서 실행하면 로그가 기록됩니다.']);
      } else {
        const lines = data.content.split('\n').filter((l: string) => l.length > 0);
        setPortLogs(lines.length > 0 ? lines.slice(-MAX_LOG_LINES) : ['(로그가 비어 있습니다)']);
        portLogOffsetRef.current = data.size;
      }
      setIsLoadingPortLog(false);

      // Start polling for new content
      portLogPollingRef.current = setInterval(async () => {
        // in-flight 가드 — 이전 틱이 아직 진행 중이면 건너뜀 (다중 MB 전송 중첩 방지)
        if (portLogPollBusyRef.current) return;
        portLogPollBusyRef.current = true;
        try {
          const newData = await API.readLogContent(portId, portLogOffsetRef.current);
          if (!newData.exists) return;
          // 파일 재생성 감지 (서버 재시작 등으로 size가 줄어든 경우)
          if (newData.size < portLogOffsetRef.current) {
            portLogOffsetRef.current = 0;
            const allData = await API.readLogContent(portId, 0);
            const lines = allData.content.split('\n').filter((l: string) => l.length > 0);
            setPortLogs(lines.slice(-MAX_LOG_LINES));
            portLogOffsetRef.current = allData.size;
            return;
          }
          // 새 내용 없음 (size <= offset) — 전체 파일 재처리 방지를 위해 조기 종료
          if (newData.size <= portLogOffsetRef.current) return;
          if (newData.content && newData.content.length > 0) {
            const newLines = newData.content.split('\n').filter((l: string) => l.length > 0);
            if (newLines.length > 0) {
              setPortLogs(prev => {
                const combined = [...prev, ...newLines];
                return combined.length > MAX_LOG_LINES ? combined.slice(-MAX_LOG_LINES) : combined;
              });
              portLogOffsetRef.current = newData.size;
            }
          }
        } catch (e) {
          // Ignore transient polling errors
        } finally {
          portLogPollBusyRef.current = false;
        }
      }, 1000);
    } catch (error) {
      setPortLogs([`로그 읽기 실패: ${error}`]);
      setIsLoadingPortLog(false);
    }
  };

  const handleClosePortLog = () => {
    setShowPortLog(false);
    setViewingPortId(null);
    setViewingPortName('');
    if (portLogPollingRef.current) {
      clearInterval(portLogPollingRef.current);
      portLogPollingRef.current = null;
    }
    portLogPollBusyRef.current = false;
  };

  const handleBuildApp = async () => {
    if (isBuilding) return;

    setBuildType('app');
    setBuildLogs(['App 빌드를 시작합니다...']);
    lastLogIndexRef.current = 0;
    setShowBuildLog(true);
    setIsBuilding(true);
    isBuildingRef.current = true;

    const seq = ++buildSeqRef.current; // 이전 빌드 타이머 무효화
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
    if (buildTimeoutRef.current) {
      clearTimeout(buildTimeoutRef.current);
      buildTimeoutRef.current = null;
    }

    try {
      const message = await API.buildApp('app');
      if (seq !== buildSeqRef.current) return;
      appendBuildLogs([message]);

      // 빌드 상태를 주기적으로 폴링
      let pollInFlight = false;
      const pollInterval = setInterval(async () => {
        if (seq !== buildSeqRef.current || pollInFlight) return;
        pollInFlight = true;
        try {
          const response = await fetch(`/api/build-status?cursor=${lastLogIndexRef.current}`);
          const status = await response.json();
          if (seq !== buildSeqRef.current) return;

          const newEntries = consumeBuildStatusLogs(status);
          if (newEntries.length > 0) {
            appendBuildLogs(newEntries);
          }

          if (!status.isBuilding) {
            clearInterval(pollInterval);
            if (buildPollRef.current === pollInterval) buildPollRef.current = null;
            if (buildTimeoutRef.current) {
              clearTimeout(buildTimeoutRef.current);
              buildTimeoutRef.current = null;
            }
            isBuildingRef.current = false;
            setIsBuilding(false);
            if (status.exitCode === 0) {
              appendBuildLogs(['✅ 빌드가 완료되었습니다!']);
            } else if (status.exitCode !== null) {
              appendBuildLogs([`❌ 빌드 실패 (exit code: ${status.exitCode})`]);
            }
          }
        } catch (e) {
          console.error('Failed to poll build status:', e);
        } finally {
          pollInFlight = false;
        }
      }, 1000);
      buildPollRef.current = pollInterval;

      // 10분 후 타임아웃 (이후 시작된 빌드에는 적용 안 함)
      const timeout = setTimeout(() => {
        if (seq !== buildSeqRef.current) return;
        buildSeqRef.current = seq + 1;
        clearInterval(pollInterval);
        if (buildPollRef.current === pollInterval) buildPollRef.current = null;
        if (buildTimeoutRef.current === timeout) buildTimeoutRef.current = null;
        isBuildingRef.current = false;
        setIsBuilding(false);
        appendBuildLogs(['⚠️ 빌드 타임아웃 (10분 초과)']);
      }, 600000);
      buildTimeoutRef.current = timeout;
    } catch (error) {
      if (seq !== buildSeqRef.current) return;
      if (buildPollRef.current) {
        clearInterval(buildPollRef.current);
        buildPollRef.current = null;
      }
      if (buildTimeoutRef.current) {
        clearTimeout(buildTimeoutRef.current);
        buildTimeoutRef.current = null;
      }
      appendBuildLogs(['❌ App 빌드 실패: ' + error]);
      isBuildingRef.current = false;
      setIsBuilding(false);
    }
  };

  const handleBuildDmg = async () => {
    if (isBuilding) return;

    setBuildType('dmg');
    setBuildLogs(['DMG 빌드를 시작합니다...']);
    lastLogIndexRef.current = 0;
    setShowBuildLog(true);
    setIsBuilding(true);
    isBuildingRef.current = true;

    const seq = ++buildSeqRef.current; // 이전 빌드 타이머 무효화
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
    if (buildTimeoutRef.current) {
      clearTimeout(buildTimeoutRef.current);
      buildTimeoutRef.current = null;
    }

    try {
      const message = await API.buildDmg();
      if (seq !== buildSeqRef.current) return;
      appendBuildLogs([message]);

      // 빌드 상태를 주기적으로 폴링
      let pollInFlight = false;
      const pollInterval = setInterval(async () => {
        if (seq !== buildSeqRef.current || pollInFlight) return;
        pollInFlight = true;
        try {
          const response = await fetch(`/api/build-status?cursor=${lastLogIndexRef.current}`);
          const status = await response.json();
          if (seq !== buildSeqRef.current) return;

          const newEntries = consumeBuildStatusLogs(status);
          if (newEntries.length > 0) {
            appendBuildLogs(newEntries);
          }

          if (!status.isBuilding) {
            clearInterval(pollInterval);
            if (buildPollRef.current === pollInterval) buildPollRef.current = null;
            if (buildTimeoutRef.current) {
              clearTimeout(buildTimeoutRef.current);
              buildTimeoutRef.current = null;
            }
            isBuildingRef.current = false;
            setIsBuilding(false);
            if (status.exitCode === 0) {
              appendBuildLogs(['✅ 빌드가 완료되었습니다!']);
            } else if (status.exitCode !== null) {
              appendBuildLogs([`❌ 빌드 실패 (exit code: ${status.exitCode})`]);
            }
          }
        } catch (e) {
          console.error('Failed to poll build status:', e);
        } finally {
          pollInFlight = false;
        }
      }, 1000);
      buildPollRef.current = pollInterval;

      // 10분 후 타임아웃 (이후 시작된 빌드에는 적용 안 함)
      const timeout = setTimeout(() => {
        if (seq !== buildSeqRef.current) return;
        buildSeqRef.current = seq + 1;
        clearInterval(pollInterval);
        if (buildPollRef.current === pollInterval) buildPollRef.current = null;
        if (buildTimeoutRef.current === timeout) buildTimeoutRef.current = null;
        isBuildingRef.current = false;
        setIsBuilding(false);
        appendBuildLogs(['⚠️ 빌드 타임아웃 (10분 초과)']);
      }, 600000);
      buildTimeoutRef.current = timeout;
    } catch (error) {
      if (seq !== buildSeqRef.current) return;
      if (buildPollRef.current) {
        clearInterval(buildPollRef.current);
        buildPollRef.current = null;
      }
      if (buildTimeoutRef.current) {
        clearTimeout(buildTimeoutRef.current);
        buildTimeoutRef.current = null;
      }
      appendBuildLogs(['❌ DMG 빌드 실패: ' + error]);
      isBuildingRef.current = false;
      setIsBuilding(false);
    }
  };

  const fetchVisitCounts = async (w: 'alltime' | 'weekly' | 'daily' = visitWindow) => {
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey || !cfg?.deviceId) return;
    try {
      const params = new URLSearchParams({
        supabaseUrl: cfg.supabaseUrl,
        supabaseKey: cfg.supabaseAnonKey,
        deviceId: cfg.deviceId,
        window: w,
      });
      const base = isTauri() ? 'http://localhost:3001' : '';
      const res = await fetch(`${base}/api/port-visits?${params}`);
      if (res.ok) setVisitCounts(await res.json());
    } catch {}
  };

  const recordVisit = async (portId: string) => {
    const now = Date.now();
    // 항상 로컬 lastVisits 업데이트 — Supabase 미설정 환경에서도 Stale 필터 동작
    setLastVisits(prev => {
      const next = { ...prev, [portId]: now };
      try { localStorage.setItem('portmanager-last-visits', JSON.stringify(next)); } catch {}
      return next;
    });
    // 웹/앱 공용 저장소(last-visits.json)에도 기록 — 어느 쪽에서 실행해도 같이 반영되도록
    API.saveLastVisit(portId, now).catch(() => {});
    const cfg = portalConfigRef.current;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey || !cfg?.deviceId) return;
    try {
      const base = isTauri() ? 'http://localhost:3001' : '';
      await fetch(`${base}/api/port-visits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId, deviceId: cfg.deviceId, supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseAnonKey }),
      });
      setVisitCounts(prev => {
        const existing = prev.find(v => v.portId === portId);
        if (existing) return prev.map(v => v.portId === portId ? { ...v, count: v.count + 1 } : v).sort((a, b) => b.count - a.count);
        return [...prev, { portId, count: 1 }].sort((a, b) => b.count - a.count);
      });
    } catch {}
  };

  const scrollToPort = (portId: string) => {
    setHighlightedPortId(portId);
    const el = document.getElementById(`port-card-${portId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setHighlightedPortId(null), 2000);
  };

  const validateFolderPath = async (rawPath: string): Promise<string> => {
    const trimmedPath = rawPath.trim();
    const isRootPath = trimmedPath === '/' || /^[A-Za-z]:[\\/]$/.test(trimmedPath);
    const normalizedPath = isRootPath ? trimmedPath : trimmedPath.replace(/[/\\]+$/, '');
    if (!isAbsolutePath(normalizedPath)) {
      throw new Error('절대 폴더 경로를 확인하지 못했습니다. 클릭해서 폴더를 선택해주세요.');
    }
    if (isTauri()) {
      return invoke<string>('validate_folder_path', { folderPath: normalizedPath });
    }
    const response = await fetch('/api/validate-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: normalizedPath }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.path) throw new Error(result.error || '폴더 경로를 확인하지 못했습니다.');
    return result.path;
  };

  const addWorkspaceRootFromPath = async (rawPath: string) => {
    const normalizedPath = await validateFolderPath(rawPath);
    const duplicate = workspaceRoots.find(root =>
      isWindows()
        ? root.path.toLowerCase() === normalizedPath.toLowerCase()
        : root.path === normalizedPath
    );
    if (duplicate) {
      setActiveRootId(duplicate.id);
      showToast(`이미 추가된 작업 루트입니다: ${duplicate.name}`, 'success');
      return;
    }
    const name = normalizedPath.split('/').pop() || normalizedPath.split('\\').pop() || normalizedPath;
    const id = crypto.randomUUID();
    setWorkspaceRoots(previous => [...previous, { id, name, path: normalizedPath }]);
    setActiveRootId(id);
    showToast(`작업 루트 추가됨: ${name}`, 'success');
  };

  const handleAddWorkspaceRoot = async () => {
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === 'string') {
        await addWorkspaceRootFromPath(selected);
      }
    } else {
      try {
        const res = await fetch('/api/pick-folder');
        const data = await res.json();
        if (!data.path) return;
        await addWorkspaceRootFromPath(data.path);
      } catch (e: any) {
        if (e.name !== 'AbortError') showToast('폴더 선택 실패: ' + e.message, 'error');
      }
    }
  };

  const handleDropEditFolder = async (rawPath: string) => {
    const normalizedPath = await validateFolderPath(rawPath);
    setEditFolderPath(normalizedPath);
    showToast(`프로젝트 폴더 선택됨: ${normalizedPath.split(/[\\/]/).filter(Boolean).pop() || normalizedPath}`, 'success');
  };

  const handlePickEditFolder = async () => {
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === 'string') await handleDropEditFolder(selected);
      return;
    }
    try {
      const res = await fetch('/api/pick-folder');
      const data = await res.json();
      if (data.path) await handleDropEditFolder(data.path);
    } catch (error: any) {
      if (error.name !== 'AbortError') showToast(`폴더 선택 실패: ${error.message}`, 'error');
    }
  };

  const handleDetectEditGithubUrl = async () => {
    if (!editFolderPath.trim()) {
      showToast('먼저 프로젝트 폴더를 입력하거나 드래그해주세요', 'error');
      return;
    }
    if (editGithubDetecting) return;
    setEditGithubDetecting(true);
    try {
      const normalizedPath = await validateFolderPath(editFolderPath);
      const remoteUrl = await API.detectGitRemoteUrl(normalizedPath);
      const detectedUrl = normalizeGitHubRepositoryUrl(remoteUrl);
      if (!detectedUrl) throw new Error('연결된 원격 저장소가 GitHub 주소가 아닙니다');
      setEditFolderPath(normalizedPath);
      setEditGithubUrl(previous => appendGitHubRepositoryUrl(previous, detectedUrl));
      showToast('로컬 Git 저장소에서 GitHub 주소를 감지했습니다', 'success');
    } catch (error) {
      showToast(`GitHub 주소 감지 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setEditGithubDetecting(false);
    }
  };

  const applyPickedCommandPath = (filePath: string) => {
    setEditCommandPath(filePath);
    if (!editFolderPath) {
      const lastSepIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSepIndex !== -1) setEditFolderPath(filePath.substring(0, lastSepIndex));
    }
  };

  /**
   * 드롭한 절대경로가 실제 파일인지 확인한다.
   *
   * 앱에서는 `@tauri-apps/plugin-fs` 의 `stat` 을 쓰는데, 이 호출은 ACL 에 걸리면
   * `fs|stat not allowed by ACL` 로 던진다 — 실제로 `fs:allow-stat` 이 빠져 있어
   * 매뉴얼·로그 파일을 넣을 때마다 실패했다(VOC 2026-08-14). 권한은 추가했지만,
   * 권한/스코프 하나가 빠졌다고 기능이 통째로 죽는 구조는 그대로 두지 않는다.
   * 같은 기기의 API 서버가 같은 판정을 할 수 있으므로 그쪽으로 넘긴다.
   */
  const fileExistsAtPath = async (normalizedPath: string, notAFileMessage: string): Promise<void> => {
    if (isTauri()) {
      try {
        const { stat } = await import('@tauri-apps/plugin-fs');
        const info = await stat(normalizedPath);
        if (!info.isFile) throw new Error(notAFileMessage);
        return;
      } catch (error: any) {
        // "파일이 아니다"는 판정 결과다 — 폴백으로 덮지 않는다.
        if (error?.message === notAFileMessage) throw error;
      }
    }
    const response = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/validate-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: normalizedPath }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.path) throw new Error(result.error || notAFileMessage);
  };

  const validateCommandFilePath = async (rawPath: string): Promise<string> => {
    const normalizedPath = rawPath.trim();
    if (!isAbsolutePath(normalizedPath)) {
      throw new Error('실행 파일의 절대경로를 확인하지 못했습니다.');
    }
    const allowedExtensions = isWindows()
      ? /\.(bat|cmd|ps1|html)$/i
      : /\.(command|sh|html)$/i;
    if (!allowedExtensions.test(normalizedPath)) {
      throw new Error(`지원하는 실행 파일만 드롭할 수 있습니다: ${execFileExt()}`);
    }
    await fileExistsAtPath(normalizedPath, '드롭한 경로가 파일이 아닙니다.');
    return normalizedPath;
  };

  const handleDropCommandFile = async (filePath: string) => {
    const validatedPath = await validateCommandFilePath(filePath);
    applyPickedCommandPath(validatedPath);
    showToast(`실행 파일 선택됨: ${folderBasename(validatedPath)}`, 'success');
  };

  const handlePickCommandFile = async () => {
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const extensions = isWindows() ? ['bat', 'cmd', 'ps1', 'html'] : ['command', 'sh', 'html'];
      const selected = await open({ directory: false, multiple: false, filters: [{ name: 'Command/HTML Files', extensions }] });
      if (selected && typeof selected === 'string') applyPickedCommandPath(selected);
    } else {
      try {
        const res = await fetch('/api/pick-file');
        const data = await res.json();
        if (data.path) applyPickedCommandPath(data.path);
      } catch (e: any) {
        if (e.name !== 'AbortError') showToast('파일 선택 실패: ' + e.message, 'error');
      }
    }
  };

  type ProjectDocumentKind = 'manual' | 'log';
  const projectDocumentLabel = (kind: ProjectDocumentKind) =>
    kind === 'manual' ? '매뉴얼' : '로그 관리';
  const applyProjectDocumentPath = (kind: ProjectDocumentKind, filePath: string) => {
    if (kind === 'manual') setEditManualPath(filePath);
    else setEditLogFilePath(filePath);
  };
  const validateProjectDocumentPath = async (rawPath: string): Promise<string> => {
    const normalizedPath = rawPath.trim();
    // 판정은 src/projectDocumentPath.ts 한 곳. 거부 사유를 그대로 사용자에게 보여준다 —
    // 예전에는 허용 목록만 나열해서 자기 파일의 무엇이 문제인지 알 수 없었다.
    const problem = projectDocumentPathProblem(normalizedPath, isAbsolutePath);
    if (problem) throw new Error(problem.message);
    await fileExistsAtPath(normalizedPath, '드롭한 경로가 파일이 아닙니다.');
    return normalizedPath;
  };
  const handleDropProjectDocument = async (kind: ProjectDocumentKind, rawPath: string) => {
    const validatedPath = await validateProjectDocumentPath(rawPath);
    applyProjectDocumentPath(kind, validatedPath);
    showToast(`${projectDocumentLabel(kind)} 파일 선택됨: ${folderBasename(validatedPath)}`, 'success');
  };
  const handlePickProjectDocument = async (kind: ProjectDocumentKind) => {
    try {
      let selectedPath = '';
      if (isTauri()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: false,
          multiple: false,
          // 다이얼로그 필터도 검증과 같은 목록을 쓴다 — 좁으면 사용자가 자기 파일을
          // 고르지도 못한 채 "왜 안 보이지"가 된다.
          filters: [{ name: 'Documents', extensions: [...PROJECT_DOCUMENT_EXTENSIONS] }],
        });
        if (selected && typeof selected === 'string') selectedPath = selected;
      } else {
        const res = await fetch('/api/pick-file?kind=document');
        const data = await res.json();
        if (data.path) selectedPath = data.path;
      }
      if (selectedPath) await handleDropProjectDocument(kind, selectedPath);
    } catch (error: any) {
      if (error?.name !== 'AbortError' && !String(error?.message || error).includes('cancelled')) {
        showToast(`${projectDocumentLabel(kind)} 파일 선택 실패: ${error?.message || error}`, 'error');
      }
    }
  };

  const handleRemoveWorkspaceRoot = (id: string) => {
    dirHandlesRef.current.delete(id);
    idbDeleteHandle(id);
    const updated = workspaceRoots.filter(r => r.id !== id);
    setWorkspaceRoots(updated);
  };

  const moveWorkspaceRoot = async (id: string, direction: -1 | 1) => {
    const previous = workspaceRoots;
    const reordered = reorderWorkspaceRoots(previous, id, direction);
    if (reordered === previous) return;
    setWorkspaceRoots(reordered);
    try {
      await API.saveWorkspaceRoots(reordered);
      showToast('작업 루트 순서를 저장했습니다', 'success');
    } catch (error) {
      setWorkspaceRoots(previous);
      showToast(`작업 루트 순서 저장 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  // 입력 중에도 같은 판정을 쓴다 — 버튼을 눌러야만 알 수 있는 오류를 만들지 않는다.
  const newProjectCloneUrlProblem = gitCloneUrlProblem(newProjectGithubUrl);
  const newProjectCloneRequest = parseGitCloneRequest(newProjectGithubUrl);

  const handleCreateProjectFolder = async () => {
    const root = workspaceRoots.find(r => r.id === activeRootId);
    if (!root) { showToast('작업 루트를 찾을 수 없습니다', 'error'); return; }
    // 주소를 넣었으면 만들기 방식이 mkdir → clone 으로 바뀐다. 폴더를 만든 뒤에 주소가
    // 틀린 것을 알게 되면 되돌릴 것이 생기므로, 만들기 전에 막는다.
    const cloneUrlProblem = gitCloneUrlProblem(newProjectGithubUrl);
    if (cloneUrlProblem) { showToast(cloneUrlProblem, 'error'); return; }
    const cloneRequest = parseGitCloneRequest(newProjectGithubUrl);
    // 이름을 비워두면 저장소 이름을 쓴다 — clone 은 이름의 출처를 이미 갖고 있다.
    const trimmed = newProjectName.trim() || cloneRequest?.repositoryName || '';
    if (!trimmed) { showToast('프로젝트 이름을 입력하세요', 'error'); return; }
    // 폴더를 만든 뒤에 ID가 틀린 것을 알게 되면 되돌릴 것이 생긴다. 만들기 전에 막는다.
    if (enableNewProjectMemory && newProjectMemoryJoinProblem) {
      showToast(newProjectMemoryJoinProblem, 'error');
      return;
    }

    const isAbsPath = root.path.startsWith('/') || /^[A-Z]:\\/i.test(root.path);
    if (!isAbsPath) {
      showToast('루트 폴더 경로가 절대경로가 아닙니다. 루트를 삭제 후 다시 추가해주세요.', 'error');
      return;
    }
    const sep = root.path.includes('\\') ? '\\' : '/';
    const fullPath = `${root.path}${sep}${trimmed}`;

    try {
      const result = cloneRequest
        ? await API.cloneRepository(cloneRequest.url, fullPath)
        : await API.createFolder(fullPath);
      if (result.success) {
        // clone 은 이미 저장소이고 커밋도 있다. 그 위에 git init 을 다시 돌리지 않는다.
        if (initializeNewProjectGit && !cloneRequest) {
          const gitResult = await API.gitInit(fullPath);
          if (gitResult.error) throw new Error(gitResult.error);
          if (!gitResult.alreadyGit && !gitResult.initialized) {
            throw new Error('Git 저장소 초기화에 실패했습니다.');
          }
          if (!gitResult.hasCommit) {
            showToast('Git 저장소는 생성됐지만 초기 커밋은 만들지 못했습니다. Git 사용자 설정을 확인하세요.', 'error');
          } else {
            await repositoryWorkflowApi.upgrade(fullPath);
          }
        }

        let createdProject: PortInfo | null = null;
        if (registerAsProject) {
          const portNum = newProjectPort ? parseInt(newProjectPort) : undefined;
          const newId = crypto.randomUUID();
          createdProject = await withDetectedGithubUrl({ id: newId, name: trimmed, folderPath: fullPath, port: portNum });
          const updated = [createdProject, ...portsRef.current];
          setPorts(updated);
          await API.savePorts([...updated, ...otherPlatformPortsRef.current]);
          setLastVisits(prev => ({ ...prev, [newId]: Date.now() }));
        }
        if (enableNewProjectMemory) {
          try {
            const { projectMemoryApi } = await import('./ProjectMemoryPanel');
            const joinId = newProjectMemoryJoinId.trim();
            await projectMemoryApi.initialize({
              folderPath: fullPath,
              projectName: trimmed,
              agent: newProjectMemoryAgent,
              autoBackup: backupNewProjectMemory,
              ...(joinId ? { memoryId: joinId } : {}),
            });
            if (joinId) {
              // 합류는 Pull이 본체다 — init은 빈 문서를 만들 뿐이고, 그 상태로 push하면
              // 다른 기기가 쌓아둔 기억 위에 빈 문서가 올라간다.
              await projectMemoryApi.pull({ folderPath: fullPath, projectName: trimmed });
            } else if (cloneRequest) {
              // clone 은 저장소 계보를 갖고 들어온다 — 그 키(`github_url`)로 원격 기억을
              // 먼저 찾는다. 여기서 곧장 push 하면 다른 기기가 쌓아둔 기억 위에 방금 만든
              // 빈 문서가 올라가므로, joinId 경로와 같은 이유로 Pull 이 먼저다.
              //
              // remoteStatus 로 미리 볼 수 없다 — 그 경로는 방금 init 이 만든 로컬 memoryId 를
              // 우선 조회해서 저장소 계보를 못 찾는다. 계보를 저장소 주소로 확정하는 것은
              // pull 안의 claimProjectMemoryIdentity 하나뿐이다.
              let restoredFromRemote = false;
              try {
                await projectMemoryApi.pull({
                  folderPath: fullPath,
                  projectName: trimmed,
                  githubUrl: cloneRequest.url,
                });
                restoredFromRemote = true;
              } catch (pullError: any) {
                // 원격에 아직 백업이 없는 것은 정상이다 — 아무도 push 하지 않은 저장소다.
                if (pullError?.code !== 'REMOTE_BACKUP_MISSING') throw pullError;
              }
              if (restoredFromRemote) {
                showToast(`이 저장소의 장기기억을 Supabase에서 가져왔습니다: ${trimmed}`, 'success');
              } else if (backupNewProjectMemory) {
                await projectMemoryApi.push({ folderPath: fullPath, projectName: trimmed, githubUrl: cloneRequest.url });
              }
            } else if (backupNewProjectMemory) {
              await projectMemoryApi.push({ folderPath: fullPath, projectName: trimmed });
            }
          } catch (memoryError: any) {
            showToast(`프로젝트는 생성됐지만 장기기억 설정/백업 실패: ${memoryError.message}`, 'error');
          }
        }
        const autoRunResult = runNewProjectAfterCreate && createdProject
          ? await executeCommand(createdProject, { missingTargetBehavior: 'skip' })
          : null;
        const autoRunHint = autoRunResult === 'missing'
          ? ' · 실행 명령이 없어 자동 실행 생략'
          : '';
        showToast(
          `${cloneRequest ? '저장소 clone' : '폴더 생성'}${initializeNewProjectGit && !cloneRequest ? ' + Git 저장소' : ''}${registerAsProject ? ' + 프로젝트 등록' : ''}${enableNewProjectMemory ? ' + 장기기억' : ''} 완료: ${trimmed}${autoRunHint}`,
          'success'
        );
        setNewProjectName('');
        setNewProjectPort('');
        setNewProjectGithubUrl('');
        setNewProjectMemoryJoinId('');
        setShowNewProjectModal(false);
      } else {
        showToast((result as any).error || (cloneRequest ? '저장소 clone 실패' : '폴더 생성 실패'), 'error');
      }
    } catch (e: any) {
      showToast(`${cloneRequest ? '저장소 clone' : '폴더 생성'} 실패: ` + e.message, 'error');
    }
  };

  // 폴더 경로에서 basename 추출 (양쪽 슬래시 제거)
  const folderBasename = (path: string) =>
    path.trim().replace(/[/\\]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';

  // 폴더 경로가 바뀌면 프로젝트 이름을 basename으로 자동 채움.
  // 단, 사용자가 직접 고친 이름은 덮어쓰지 않는다 (직전 자동값과 같을 때만 갱신)
  const applyExistingFolderPath = (path: string) => {
    setExistingFolderPath(path);
    const basename = folderBasename(path);
    setExistingProjectName(prev => (prev === existingAutoNameRef.current ? basename : prev));
    existingAutoNameRef.current = basename;
  };

  const autoDetectPortFromFolder = async (folderPath: string) => {
    setExistingDetectedPort(undefined);
    // 자동 감지 결과를 포트 입력칸에 반영. 감지 실패(undefined)면 직전 자동값을 지운다 —
    // 이전 폴더에서 채워진 포트가 다른 폴더에 그대로 붙는 것을 막기 위함.
    // 단, 사용자가 직접 고친 값은 어느 쪽이든 덮어쓰지 않는다.
    const applyDetected = (detected?: number) => {
      const next = detected ? String(detected) : '';
      setExistingPort(prev => (prev === '' || prev === existingAutoPortRef.current ? next : prev));
      existingAutoPortRef.current = next;
    };
    try {
      const baseUrl = isTauri() ? 'http://localhost:3001' : '';
      const scanRes = await fetch(`${baseUrl}/api/scan-command-files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      const scanData = await scanRes.json();
      if (scanData.files?.length > 0) {
        const detectRes = await fetch(`${baseUrl}/api/detect-port`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: scanData.files[0] }),
        });
        const detectData = await detectRes.json();
        if (detectData.detectedPort) setExistingDetectedPort(detectData.detectedPort);
        applyDetected(detectData.detectedPort);
        return;
      }
      applyDetected(undefined);
    } catch {
      applyDetected(undefined);
    }
  };

  const handleRegisterExistingFolder = async () => {
    const trimmed = existingFolderPath.trim().replace(/[/\\]+$/, '');
    if (!trimmed) {
      showToast('폴더 경로를 입력하세요', 'error');
      return;
    }
    if (!trimmed.startsWith('/') && !trimmed.match(/^[A-Z]:\\/i)) {
      showToast('절대 경로를 입력하세요', 'error');
      return;
    }
    // 등록을 시작하기 전에 막는다. 폴더를 등록하고 Git까지 손댄 뒤에 ID가 틀린 것을
    // 알게 되면 되돌릴 것이 생긴다.
    if (existingMemoryJoinProblem) {
      showToast(existingMemoryJoinProblem, 'error');
      return;
    }
    // 입력한 이름 우선, 없으면 폴더 basename fallback
    const name = existingProjectName.trim() || trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed;
    // 입력칸의 값만 신뢰한다 — 감지된 포트는 이미 입력칸에 자동으로 채워지므로,
    // 사용자가 칸을 비웠다면 "포트 없는 폴더 전용 프로젝트"를 의도한 것. 이때 port 키 자체를 생략한다.
    const typedPort = parseInt(existingPort.trim(), 10);
    const finalPort = Number.isInteger(typedPort) && typedPort > 0 ? typedPort : undefined;
    const newPort: PortInfo = {
      id: crypto.randomUUID(),
      name,
      folderPath: trimmed,
      ...(finalPort ? { port: finalPort } : {}),
    };
    try {
      if (existingGitAction === 'create') {
        const gitResult = await API.gitInit(trimmed);
        if (gitResult.error) throw new Error(gitResult.error);
        if (!gitResult.hasCommit) {
          showToast('Git 저장소는 생성됐지만 초기 커밋은 만들지 못했습니다. Git 사용자 설정을 확인하세요.', 'error');
        } else {
          await repositoryWorkflowApi.upgrade(trimmed);
        }
      } else if (existingGitAction === 'reinitialize') {
        const confirmed = window.confirm(
          '기존 Git 기록과 브랜치가 모두 삭제됩니다. 폴더의 파일은 유지됩니다.\n정말 Git 저장소를 초기화하고 다시 만들까요?'
        );
        if (!confirmed) return;
        const gitResult = await API.gitReinitialize(trimmed);
        if (gitResult.error) throw new Error(gitResult.error);
        if (!gitResult.hasCommit) {
          showToast('Git 저장소는 다시 만들었지만 초기 커밋은 만들지 못했습니다. Git 사용자 설정을 확인하세요.', 'error');
        } else {
          await repositoryWorkflowApi.upgrade(trimmed);
        }
      }

      // 기존 폴더는 이미 clone인 경우가 대부분이라, 등록 시점이 origin을 잡기 가장 좋다.
      const registered = await withDetectedGithubUrl(newPort);
      const updated = [registered, ...portsRef.current];
      setPorts(updated);
      await API.savePorts([...updated, ...otherPlatformPortsRef.current]);
      setLastVisits(prev => ({ ...prev, [registered.id]: Date.now() }));
      // 합류는 Pull이 본체다 — init은 빈 문서만 만들므로, 그대로 두면 다음 Push가
      // 다른 기기의 기억 위에 빈 문서를 올린다.
      const joinId = existingMemoryJoinId.trim();
      if (joinId) {
        try {
          const { projectMemoryApi } = await import('./ProjectMemoryPanel');
          await projectMemoryApi.initialize({
            folderPath: trimmed,
            projectName: name,
            agent: 'claude',
            autoBackup: true,
            memoryId: joinId,
          });
          await projectMemoryApi.pull({ folderPath: trimmed, projectName: name });
          setExistingMemoryJoinId('');
          showToast(`기존 장기기억에 합류했습니다 (${joinId.slice(0, 8)}).`, 'success');
        } catch (memoryError: any) {
          // 프로젝트 등록 자체는 이미 끝났다. 합류 실패로 등록을 되돌리지 않는다.
          showToast(`프로젝트는 등록됐지만 장기기억 합류 실패: ${memoryError.message}`, 'error');
        }
      }
      const portHint = finalPort ? ` (포트 ${finalPort})` : '';
      const autoRunResult = runExistingProjectAfterRegister
        ? await executeCommand(registered, { missingTargetBehavior: 'skip' })
        : null;
      const autoRunHint = autoRunResult === 'missing'
        ? ' · 실행 명령이 없어 자동 실행 생략'
        : '';
      showToast(`프로젝트 등록 완료: ${name}${portHint}${autoRunHint}`, 'success');
      setExistingFolderPath('');
      setExistingDetectedPort(undefined);
      setExistingProjectName('');
      setExistingPort('');
      setExistingGitStatus('unknown');
      setExistingGitAction('create');
      setExistingMemoryJoinId('');
      existingAutoNameRef.current = '';
      existingAutoPortRef.current = '';
      setShowNewProjectModal(false);
    } catch (e: any) {
      showToast('기존 프로젝트 등록 실패: ' + e.message, 'error');
    }
  };

  const handlePickExistingFolder = async () => {
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({ directory: true, multiple: false });
        if (selected && typeof selected === 'string') {
          applyExistingFolderPath(selected);
          autoDetectPortFromFolder(selected);
        }
      } catch (e: any) {
        showToast('폴더 선택 실패: ' + e.message, 'error');
      }
    } else {
      const hintId = showToast('폴더 선택 창이 열립니다. 화면 앞쪽을 확인하세요.', 'success', 0);
      try {
        const res = await fetch('/api/pick-folder');
        removeToast(hintId);
        const data = await res.json();
        if (res.ok && data.path) {
          applyExistingFolderPath(data.path);
          autoDetectPortFromFolder(data.path);
        } else {
          showToast('폴더 선택 창이 열리지 않았습니다. 경로를 직접 입력하세요.', 'error');
        }
      } catch (e: any) {
        removeToast(hintId);
        if (e.name !== 'AbortError') showToast('폴더 선택 실패: ' + e.message, 'error');
      }
    }
  };

  const handleDropExistingFolder = async (folderPath: string) => {
    const validatedPath = await validateFolderPath(folderPath);
    applyExistingFolderPath(validatedPath);
    autoDetectPortFromFolder(validatedPath);
    showToast(`기존 프로젝트 폴더 선택됨: ${folderBasename(validatedPath)}`, 'success');
  };

  const handleInstallWindowsPrereqs = async () => {
    if (isBuilding) return;
    setBuildType('windows');
    setBuildLogs(['🔧 Windows 빌드 사전 요구사항 자동 설치를 시작합니다...']);
    lastLogIndexRef.current = 0;
    setShowBuildLog(true);
    setIsBuilding(true);
    isBuildingRef.current = true;
    setCanAutoInstall(false);

    const seq = ++buildSeqRef.current;
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
    if (buildTimeoutRef.current) {
      clearTimeout(buildTimeoutRef.current);
      buildTimeoutRef.current = null;
    }

    try {
      const response = await fetch('/api/install-windows-prereqs', { method: 'POST' });
      const result = await response.json();
      if (seq !== buildSeqRef.current) return;
      if (!response.ok || result.error) {
        appendBuildLogs([`❌ ${result.error}`]);
        isBuildingRef.current = false;
        setIsBuilding(false);
        return;
      }

      let pollInFlight = false;
      const pollInterval = setInterval(async () => {
        if (seq !== buildSeqRef.current || pollInFlight) return;
        pollInFlight = true;
        try {
          const sr = await fetch(`/api/build-status?cursor=${lastLogIndexRef.current}`);
          const status = await sr.json();
          if (seq !== buildSeqRef.current) return;
          const newLogs = consumeBuildStatusLogs(status);
          if (newLogs.length > 0) {
            appendBuildLogs(newLogs);
          }
          if (!status.isBuilding) {
            clearInterval(pollInterval);
            if (buildPollRef.current === pollInterval) buildPollRef.current = null;
            if (buildTimeoutRef.current) {
              clearTimeout(buildTimeoutRef.current);
              buildTimeoutRef.current = null;
            }
            isBuildingRef.current = false;
            setIsBuilding(false);
            if (status.exitCode === 0) {
              appendBuildLogs(['✅ 사전 설치 완료! "Windows 빌드" 버튼을 다시 누르세요.']);
            } else if (status.exitCode === null) {
              appendBuildLogs(['❌ 설치가 종료됐지만 결과 코드를 확인하지 못했습니다. 로그를 확인하세요.']);
            } else {
              appendBuildLogs([`❌ 설치 실패 (exit: ${status.exitCode})`]);
            }
          }
        } catch (e) {
          console.error(e);
        } finally {
          pollInFlight = false;
        }
      }, 2000);
      buildPollRef.current = pollInterval;

      const timeout = setTimeout(() => {
        if (seq !== buildSeqRef.current) return;
        buildSeqRef.current = seq + 1;
        clearInterval(pollInterval);
        if (buildPollRef.current === pollInterval) buildPollRef.current = null;
        if (buildTimeoutRef.current === timeout) buildTimeoutRef.current = null;
        isBuildingRef.current = false;
        setIsBuilding(false);
        appendBuildLogs(['⚠️ 설치 타임아웃 (60분 초과)']);
      }, 3600000);
      buildTimeoutRef.current = timeout;
    } catch (e) {
      if (seq !== buildSeqRef.current) return;
      if (buildPollRef.current) {
        clearInterval(buildPollRef.current);
        buildPollRef.current = null;
      }
      if (buildTimeoutRef.current) {
        clearTimeout(buildTimeoutRef.current);
        buildTimeoutRef.current = null;
      }
      appendBuildLogs(['❌ 설치 요청 실패: ' + e]);
      isBuildingRef.current = false;
      setIsBuilding(false);
    }
  };

  const handleBuildWindows = async () => {
    if (isBuilding) return;

    setBuildType('windows');
    setBuildLogs(['⏳ Windows 로컬 빌드를 시작합니다...']);
    lastLogIndexRef.current = 0;
    setShowBuildLog(true);
    setIsBuilding(true);
    isBuildingRef.current = true;
    setCanAutoInstall(false);

    const seq = ++buildSeqRef.current;
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
    if (buildTimeoutRef.current) {
      clearTimeout(buildTimeoutRef.current);
      buildTimeoutRef.current = null;
    }

    try {
      const response = await fetch('/api/build-windows', { method: 'POST' });
      const result = await response.json();
      if (seq !== buildSeqRef.current) return;

      if (!response.ok || result.error) {
        appendBuildLogs([`❌ ${result.error}`]);
        if (result.canAutoInstall) setCanAutoInstall(true);
        isBuildingRef.current = false;
        setIsBuilding(false);
        return;
      }

      // 맥 빌드와 동일하게 /api/build-status 폴링
      let pollInFlight = false;
      const pollInterval = setInterval(async () => {
        if (seq !== buildSeqRef.current || pollInFlight) return;
        pollInFlight = true;
        try {
          const statusResponse = await fetch(`/api/build-status?cursor=${lastLogIndexRef.current}`);
          const status = await statusResponse.json();
          if (seq !== buildSeqRef.current) return;
          const newLogs = consumeBuildStatusLogs(status);
          if (newLogs.length > 0) {
            appendBuildLogs(newLogs);
          }
          if (!status.isBuilding) {
            clearInterval(pollInterval);
            if (buildPollRef.current === pollInterval) buildPollRef.current = null;
            if (buildTimeoutRef.current) {
              clearTimeout(buildTimeoutRef.current);
              buildTimeoutRef.current = null;
            }
            isBuildingRef.current = false;
            setIsBuilding(false);
            if (status.exitCode === 0) {
              appendBuildLogs(['✅ Windows 빌드 완료! (%USERPROFILE%\\cargo-targets\\portmanager\\release\\bundle\\nsis\\)']);
            } else if (status.exitCode === null) {
              appendBuildLogs(['❌ 빌드가 종료됐지만 결과 코드를 확인하지 못했습니다. 로그를 확인하세요.']);
            } else {
              appendBuildLogs([`❌ 빌드 실패 (exit code: ${status.exitCode})`]);
            }
          }
        } catch (e) {
          console.error('Failed to poll windows build status:', e);
        } finally {
          pollInFlight = false;
        }
      }, 1000);
      buildPollRef.current = pollInterval;

      const timeout = setTimeout(() => {
        if (seq !== buildSeqRef.current) return;
        buildSeqRef.current = seq + 1;
        clearInterval(pollInterval);
        if (buildPollRef.current === pollInterval) buildPollRef.current = null;
        if (buildTimeoutRef.current === timeout) buildTimeoutRef.current = null;
        isBuildingRef.current = false;
        setIsBuilding(false);
        appendBuildLogs(['⚠️ 타임아웃 (30분 초과)']);
      }, 1800000);
      buildTimeoutRef.current = timeout;
    } catch (error) {
      if (seq !== buildSeqRef.current) return;
      if (buildPollRef.current) {
        clearInterval(buildPollRef.current);
        buildPollRef.current = null;
      }
      if (buildTimeoutRef.current) {
        clearTimeout(buildTimeoutRef.current);
        buildTimeoutRef.current = null;
      }
      appendBuildLogs(['❌ Windows 빌드 요청 실패: ' + error]);
      isBuildingRef.current = false;
      setIsBuilding(false);
    }
  };

  const handleCopyWindowsPcUpdatePrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildWindowsPcUpdatePrompt({
        projectPath: primaryProject?.folderPath,
        repositoryUrl: AGENTSTOZ_PUBLIC_REPOSITORY_URL,
      }));
      showToast('Windows 유지보수자용 빌드·출시 안내를 복사했습니다', 'success');
    } catch {
      showToast('Windows 빌드·출시 안내 복사에 실패했습니다', 'error');
    }
  };

  const handleDispatchWindowsCloudBuild = async () => {
    if (isDispatchingWindowsCloudBuild) return;
    const approved = window.confirm(
      'GitHub Windows 가상환경은 사용 비용이 발생할 수 있습니다. 지금 Windows 앱 빌드를 1회 실행할까요?',
    );
    if (!approved) return;

    setIsDispatchingWindowsCloudBuild(true);
    try {
      const base = isTauri() ? 'http://127.0.0.1:3001' : '';
      const response = await fetch(`${base}/api/github-actions/build-windows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'AgentsToZ 앱 상단에서 사용자가 명시적으로 요청' }),
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      showToast(result.message || 'GitHub Windows 가상환경 빌드를 요청했습니다', 'success');
      if (typeof result.actionsUrl === 'string') {
        try {
          await API.openInChrome(result.actionsUrl, selectedDeploymentBrowserProfile);
        } catch (openError) {
          showToast(
            `빌드는 시작됐지만 GitHub Actions 화면을 열지 못했습니다: ${openError instanceof Error ? openError.message : String(openError)}`,
            'warning',
          );
        }
      }
    } catch (error) {
      showToast(`GitHub Windows 빌드 요청 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setIsDispatchingWindowsCloudBuild(false);
    }
  };

  const handleExportDmg = async () => {
    try {
      const message = await API.exportDmg();
      showToast(message, 'success');
    } catch (error) {
      showToast('DMG 출시 실패: ' + error, 'error');
    }
  };

  const handleAddCommandFile = async () => {
    try {
      if (isTauri()) {
        // Tauri mode: native file picker → absolute path directly
        const filePath = await openDialog({
          multiple: false,
          filters: [{ name: 'Command Files', extensions: ['command', 'sh', 'bat', 'cmd'] }],
        });
        if (!filePath || typeof filePath !== 'string') return;

        const lastSepIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
        const fileName = lastSepIndex !== -1 ? filePath.substring(lastSepIndex + 1) : filePath;
        const projectName = fileName.replace(/\.(command|sh|bat|cmd)$/i, '');
        const folderPath = lastSepIndex !== -1 ? filePath.substring(0, lastSepIndex) : '';

        // Detect port via Rust command
        let detectedPort: number | null = null;
        try {
          const detected = await invoke<number | null>('detect_port', { filePath });
          if (detected) detectedPort = detected;
        } catch {
          // port detection optional
        }

        setName(projectName);
        if (detectedPort) setPort(detectedPort.toString());
        setCommandPath(filePath);
        setFolderPath(folderPath);

        showToast(
          `파일 분석 완료! 프로젝트: ${projectName} | 포트: ${detectedPort || '감지 실패'} — 확인 후 추가 버튼을 누르세요.`,
          'success'
        );
      } else {
        // Web mode: FileReader for port detection only (no absolute path available)
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.command,.sh,.bat,.cmd,.ps1';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = async (event) => {
            try {
              const content = event.target?.result as string;

              let detectedPort: number | null = null;
              const localhostMatch = content.match(/localhost:(\d+)/);
              if (localhostMatch) {
                detectedPort = parseInt(localhostMatch[1]!);
              } else {
                const portMatch = content.match(/(?:PORT|port)\s*=\s*(\d+)/);
                if (portMatch) detectedPort = parseInt(portMatch[1]!);
              }

              const projectName = file.name.replace(/\.(command|sh|bat|cmd)$/i, '');
              setName(projectName);
              if (detectedPort) setPort(detectedPort.toString());

              showToast(
                `포트 ${detectedPort || '감지 실패'} 감지됨. 파일 경로(commandPath)를 수동으로 입력해주세요.`,
                detectedPort ? 'success' : 'error'
              );
            } catch (error) {
              showToast('파일 분석 실패: ' + error, 'error');
            }
          };
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (error) {
      showToast('파일 선택 실패: ' + error, 'error');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      addPort();
    }
  };

  const handleEditKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const formatLastRun = (ts: number | undefined): string => {
    if (!ts) return lang === 'ko' ? '실행 이력 없음' : 'Never run';
    const diffMs = Date.now() - ts;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return lang === 'ko' ? '방금 전' : 'just now';
    if (diffMin < 60) return lang === 'ko' ? `${diffMin}분 전` : `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return lang === 'ko' ? `${diffHour}시간 전` : `${diffHour}h ago`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 30) return lang === 'ko' ? `${diffDay}일 전` : `${diffDay}d ago`;
    const diffMonth = Math.floor(diffDay / 30);
    return lang === 'ko' ? `${diffMonth}개월 전` : `${diffMonth}mo ago`;
  };

  const displayedPorts = useMemo(() => {
    const q = searchQuery.trim();
    let filtered = q ? ports.filter(p => matchesProjectSearch(p, q)) : ports;
    filtered = filtered.filter(p => !p.worktreePath && !/_wt_/.test(p.id));

    // Apply filter
    if (filterType === 'with-port') {
      filtered = filtered.filter(p => p.port != null && p.port > 0);
    } else if (filterType === 'without-port') {
      filtered = filtered.filter(p => p.port == null || p.port === 0);
    }

    // Apply category filter
    if (filterCategory !== 'all') {
      if (filterCategory === 'uncategorized') {
        filtered = filtered.filter(p => !p.category);
      } else {
        filtered = filtered.filter(p => p.category === filterCategory);
      }
    }

    // Apply sort
    switch (sortBy) {
      case 'name':
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'port':
        filtered.sort((a, b) => (a.port ?? 0) - (b.port ?? 0));
        break;
      case 'recent':
      default:
        break;
    }
    const sorted = sortOrder === 'desc' ? [...filtered].reverse() : filtered;
    return [...sorted.filter(p => p.favorite), ...sorted.filter(p => !p.favorite)];
  }, [ports, searchQuery, filterType, filterCategory, sortBy, sortOrder]);

  // 이 앱 자체는 매일 쓰는 허브이므로 검색·현재 섹션과 무관한 전역 상단 바로가기로 둔다.
  // 표시 이름이나 로컬 경로는 바뀔 수 있어 저장소 URL을 정본으로 식별하고, 이전 설치를
  // 위해 새 폴더명만 보조 신호로 사용한다.
  const primaryProject = useMemo(() => {
    const primaryRepository = normalizeGitHubRepositoryUrl(AGENTSTOZ_PUBLIC_REPOSITORY_URL);
    return ports.find(project => githubRepositoryUrls(project).some(url => (
      normalizeGitHubRepositoryUrl(url) === primaryRepository
    ))) ?? ports.find(project => project.folderPath && folderLeafName(project.folderPath) === 'AgentsToZ_byCS') ?? null;
  }, [ports]);

  const searchFilteredPorts = useMemo(() => {
    const q = searchQuery.trim();
    return q ? ports.filter(p => matchesProjectSearch(p, q)) : ports;
  }, [ports, searchQuery]);

  // 사이드바 숫자는 현재 선택된 섹션(v3Ports)이 아니라 검색 결과 전체를 기준으로
  // 계산한다. 그래야 `전체`를 보고 있을 때도 실행 워크트리가 0으로 잘못 표시되지 않는다.
  const v3SectionCounts = useMemo(
    () => getProjectSectionCounts(searchFilteredPorts),
    [searchFilteredPorts],
  );

  // The upgrade backlog is a property of every registered project, not of the
  // section currently on screen, so this deliberately reads the unfiltered list.
  const upgradeScanFolderPaths = useMemo(
    () => [...new Set(ports.map(p => p.folderPath).filter((path): path is string => !!path))],
    [ports],
  );

  // GitHub 주소가 비어 있는 프로젝트만 골라 같은 스윕에 실어 보낸다. 이미 입력된 값이
  // 있는 프로젝트는 아예 후보에 넣지 않으므로 덮어쓸 일이 구조적으로 없다.
  const githubMissingFolderPaths = useMemo(
    () => [...new Set(
      ports
        .filter(p => !!p.folderPath && githubRepositoryUrls(p).length === 0)
        .map(p => p.folderPath!),
    )],
    [ports],
  );

  const applyDetectedGithubUrls = useCallback(async (found: Array<{ folderPath: string; remoteUrl: string }>) => {
    const byFolder = new Map(found.map(row => [row.folderPath, row.remoteUrl]));
    let filled = 0;
    const updated = portsRef.current.map(port => {
      const remote = port.folderPath ? byFolder.get(port.folderPath) : undefined;
      // 스캔 후 사용자가 직접 넣었을 수 있으므로 적용 직전에 한 번 더 빈 칸인지 본다.
      if (!remote || githubRepositoryUrls(port).length > 0) return port;
      const normalized = normalizeGitHubRepositoryUrl(remote);
      if (!normalized) return port;
      filled += 1;
      return { ...port, ...githubRepositoryUrlFields(normalized) };
    });
    if (filled > 0) {
      setPorts(updated);
      await API.savePorts([...updated, ...otherPlatformPortsRef.current]);
    }
    return filled;
  }, []);

  const v3Ports = useMemo(() => {
    let list = searchFilteredPorts;
    if (sidebarSection === 'running') list = list.filter(p => p.isRunning);
    else if (sidebarSection === 'starred') list = list.filter(p => p.favorite);
    else if (sidebarSection === 'wt') list = list.filter(p => !!p.worktreePath);
    else if (sidebarSection === 'stale') {
      const cutoff = Date.now() - 14 * 86400000;
      list = list.filter(p => { const last = lastActivityFor(p.id); return !last || last < cutoff; });
    }
    else if (sidebarSection === 'recent') {
      const cutoff = Date.now() - 7 * 86400000;
      list = list.filter(p => { const last = lastActivityFor(p.id); return !!last && last >= cutoff; });
      list = [...list].sort((a, b) => (lastActivityFor(b.id) || 0) - (lastActivityFor(a.id) || 0));
    }
    else if (sidebarSection.startsWith('tag:')) list = list.filter(p => p.category === sidebarSection.slice(4));
    else list = list.filter(p => !p.worktreePath && !/_wt_/.test(p.id));
    return list;
  }, [searchFilteredPorts, sidebarSection, lastVisits, gitActivity]);

  // favorite는 기존 저장/동기화 호환성을 유지하면서 사이드바의 "고정" 의미로 사용한다.
  // 고정 프로젝트는 실행/유휴 그룹에서 제외하고 항상 목록 최상단에 한 번만 표시한다.
  const v3Pinned = useMemo(
    () => sortByPinnedOrder(v3Ports.filter(p => p.favorite), pinnedOrder),
    [v3Ports, pinnedOrder],
  );
  const v3Running = useMemo(() => v3Ports.filter(p => p.isRunning && !p.favorite), [v3Ports]);
  const v3Idle = useMemo(() =>
    [...v3Ports.filter(p => !p.isRunning && !p.favorite)].sort((a, b) => (lastActivityFor(b.id) || 0) - (lastActivityFor(a.id) || 0)),
    [v3Ports, lastVisits, gitActivity]);

  // 유휴 프로젝트를 마지막 활동 기준으로 세분화 — "가끔 쓰는 것"과 "영구 미사용"을 구분한다.
  //
  // ⚠️ 반드시 `lastActivityFor`(= max(앱 방문, git 커밋))를 쓴다. 예전에는 이 소그룹만
  // `lastVisits`(앱 버튼 클릭)를 봤는데, 행에 찍히는 날짜와 정렬·섹션 카운트는 전부
  // `lastActivityFor`였다. 그래서 **앱에서 연 적은 없지만 커밋은 최근인 프로젝트**가
  // 행에는 "4일 전"으로 뜨면서 동시에 "오래됨(30일+/기록 없음)"으로 분류됐다.
  // 실측(2026-08-14) 97개 중 7개가 이 상태였고, 그 7개가 정리 검토의 삭제 후보로
  // 올라와 있었다 — 며칠 전 커밋한 프로젝트를 지우라고 권하고 있었던 셈이다.
  const IDLE_RECENT_MS = 7 * 86400000;
  const IDLE_STALE_MS = staleDays * 86400000;
  const v3IdleRecent = useMemo(() => v3Idle.filter(p => {
    const last = lastActivityFor(p.id);
    return !!last && (Date.now() - last) < IDLE_RECENT_MS;
  }), [v3Idle, lastVisits, gitActivity]);
  const v3IdleAging = useMemo(() => v3Idle.filter(p => {
    const last = lastActivityFor(p.id);
    return !!last && (Date.now() - last) >= IDLE_RECENT_MS && (Date.now() - last) < IDLE_STALE_MS;
  }), [v3Idle, lastVisits, gitActivity, IDLE_STALE_MS]);
  const v3IdleStale = useMemo(() => v3Idle.filter(p => {
    const last = lastActivityFor(p.id);
    return !last || (Date.now() - last) >= IDLE_STALE_MS;
  }), [v3Idle, lastVisits, gitActivity, IDLE_STALE_MS]);
  // 루트가 중첩되어도 프로젝트 하나는 가장 깊은 루트 하나에만 센다. 아래 목록 구분자와
  // 하단 작업 루트 배지가 같은 판정을 공유해야 화면의 개수가 서로 어긋나지 않는다.
  const workspaceRootProjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groupProjectsByWorkspaceRoot(ports, workspaceRoots)) {
      if (group.root) counts.set(group.root.id, group.items.length);
    }
    return counts;
  }, [ports, workspaceRoots]);

  const inpV3: React.CSSProperties = {
    width:'100%', padding:'7px 10px', background:'#09090b',
    border:'1px solid rgba(255,255,255,0.07)', borderRadius:6,
    color:'#f4f4f5', fontSize:12, fontFamily:'inherit', boxSizing:'border-box',
  };

  const renderEditAiClassification = (context: 'card' | 'detail') => {
    const canUseAi = Boolean(editFolderPath.trim());
    const isGenerating = aiSuggestingId === editingId;
    return (
      <div
        data-testid={`edit-ai-classification-${context}`}
        style={{
          padding:10,
          border:'1px solid rgba(200,168,240,0.18)',
          borderRadius:7,
          background:'rgba(200,168,240,0.035)',
          display:'flex',
          flexDirection:'column',
          gap:7,
        }}
      >
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:'#d8b4fe'}}>분류 및 프로젝트 별명</div>
            <div style={{fontSize:10,color:'#71717a',marginTop:2}}>
              원래 프로젝트명은 유지되며, 별명은 목록 표시와 검색에 함께 사용됩니다.
            </div>
          </div>
          <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
            <button
              type="button"
              data-testid={`edit-ai-generate-${context}`}
              onClick={handleAiSuggestEdit}
              disabled={!canUseAi || isGenerating}
              title={canUseAi ? '한 번의 프로젝트 분석으로 별명과 카테고리를 함께 생성' : '프로젝트 폴더가 있어야 AI 생성 가능'}
              style={{padding:'5px 8px',background:'rgba(200,168,240,0.10)',border:'1px solid rgba(200,168,240,0.25)',borderRadius:5,color:'#c8a8f0',cursor:canUseAi?'pointer':'not-allowed',opacity:canUseAi?1:0.4,fontSize:10,display:'flex',alignItems:'center',gap:4,fontFamily:'inherit'}}
            >
              <Sparkles style={{width:11,height:11}}/>{isGenerating ? '생성 중…' : '별명+카테고리 AI 생성'}
            </button>
            <button
              type="button"
              data-testid={`edit-ai-copy-chat-${context}`}
              onClick={handleCopyEditAiNamePrompt}
              disabled={!canUseAi}
              title={canUseAi ? '별명과 카테고리를 함께 생성하는 AI 채팅 명령 복사' : '프로젝트 폴더가 있어야 채팅 명령을 만들 수 있습니다'}
              style={{padding:'5px 8px',background:'rgba(94,234,212,0.08)',border:'1px solid rgba(94,234,212,0.22)',borderRadius:5,color:'#5eead4',cursor:canUseAi?'pointer':'not-allowed',opacity:canUseAi?1:0.4,fontSize:10,display:'flex',alignItems:'center',gap:4,fontFamily:'inherit'}}
            >
              <Copy style={{width:11,height:11}}/>별명+카테고리 채팅 명령
            </button>
          </div>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:isMobile?'wrap':'nowrap'}}>
          <label style={{flex:1,minWidth:180,display:'flex',flexDirection:'column',gap:4}}>
            <span style={{fontSize:10,color:'#a1a1aa'}}>프로젝트 별명 <span style={{color:'#71717a'}}>(AI 이름)</span></span>
            <input
              data-testid={`edit-ai-name-${context}`}
              type="text"
              value={editAiName}
              onChange={e=>setEditAiName(e.target.value)}
              onKeyDown={handleEditKeyPress}
              style={inpV3}
              placeholder="예: port manager"
            />
          </label>
          <label style={{flex:1,minWidth:150,display:'flex',flexDirection:'column',gap:4}}>
            <span style={{fontSize:10,color:'#a1a1aa'}}>카테고리</span>
            <input
              data-testid={`edit-category-${context}`}
              type="text"
              value={editCategory}
              onChange={e=>setEditCategory(e.target.value)}
              onKeyDown={handleEditKeyPress}
              style={inpV3}
              placeholder="예: manager"
            />
          </label>
        </div>
      </div>
    );
  };

  const renderV3Card = (item: PortInfo) => {
    if (editingId === item.id) {
      return (
        <div key={item.id} style={{padding:12,background:'#111113',border:'1px solid rgba(255,255,255,0.12)',borderRadius:8,display:'flex',flexDirection:'column',gap:6}}>
          <div style={{display:'flex',gap:6}}>
            <input type="text" value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={handleEditKeyPress}
              style={{...inpV3,flex:1}} placeholder="프로젝트 이름" autoFocus />
            <input type="number" value={editPort} onChange={e=>setEditPort(e.target.value)} onKeyDown={handleEditKeyPress}
              style={{...inpV3,width:70,flex:'none'}} placeholder="포트" />
            <button type="button" onClick={()=>suggestPort(setEditPort)} title="빈 포트 추천 (9000번대)" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:11,whiteSpace:'nowrap' as const,flexShrink:0}}>추천</button>
            <button onClick={saveEdit} style={{padding:'5px 8px',background:'rgba(74,222,128,0.14)',border:'1px solid rgba(74,222,128,0.3)',borderRadius:6,cursor:'pointer',display:'flex',alignItems:'center'}}>
              <Check className="w-3.5 h-3.5" style={{color:'#4ade80'}} />
            </button>
            <button onClick={cancelEdit} style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:6,cursor:'pointer',display:'flex',alignItems:'center'}}>
              <XIcon className="w-3.5 h-3.5" style={{color:'#71717a'}} />
            </button>
          </div>
          <FolderDropZone
            compact
            pathKind="file"
            testId="edit-command-file-field-card"
            value={editCommandPath}
            onValueChange={setEditCommandPath}
            onInputKeyDown={handleEditKeyPress}
            prefixLabel="실행 파일"
            placeholder={`${execFileExt()} 실행 파일 · 드래그 또는 선택`}
            label="실행 파일을 여기에 드래그"
            hint="파일 선택"
            onChoose={handlePickCommandFile}
            onFolderPath={handleDropCommandFile}
            onError={message => showToast(message, 'error')}
          />
          <input type="text" value={editTerminalCommand} onChange={e=>setEditTerminalCommand(e.target.value)} onKeyDown={handleEditKeyPress}
            style={inpV3} placeholder="터미널 명령어" />
          <FolderDropZone
            compact
            testId="edit-folder-field-card"
            value={editFolderPath}
            onValueChange={setEditFolderPath}
            onInputKeyDown={handleEditKeyPress}
            prefixLabel="프로젝트 폴더"
            placeholder="프로젝트 폴더 · 드래그 또는 선택"
            label="프로젝트 폴더를 여기에 드래그"
            hint="폴더 선택"
            onChoose={handlePickEditFolder}
            onFolderPath={handleDropEditFolder}
            onError={message => showToast(message, 'error')}
          />
          <FolderDropZone
            compact
            pathKind="file"
            testId="edit-manual-file-field-card"
            value={editManualPath}
            onValueChange={setEditManualPath}
            onInputKeyDown={handleEditKeyPress}
            prefixLabel="매뉴얼"
            placeholder="매뉴얼 파일 (PDF·HWP·DOCX·MD·HTML 등) · 드래그 또는 선택"
            label="매뉴얼 파일을 여기에 드래그"
            hint="파일 선택"
            onChoose={() => handlePickProjectDocument('manual')}
            onFolderPath={path => handleDropProjectDocument('manual', path)}
            onError={message => showToast(message, 'error')}
          />
          <FolderDropZone
            compact
            pathKind="file"
            testId="edit-log-file-field-card"
            value={editLogFilePath}
            onValueChange={setEditLogFilePath}
            onInputKeyDown={handleEditKeyPress}
            prefixLabel="로그 관리"
            placeholder="로그 관리 파일 (XLSX·CSV·LOG·MD 등) · 드래그 또는 선택"
            label="로그 관리 파일을 여기에 드래그"
            hint="파일 선택"
            onChoose={() => handlePickProjectDocument('log')}
            onFolderPath={path => handleDropProjectDocument('log', path)}
            onError={message => showToast(message, 'error')}
          />
          <input type="text" value={editDeployUrl} onChange={e=>setEditDeployUrl(e.target.value)} onKeyDown={handleEditKeyPress}
            style={inpV3} placeholder="배포 주소" />
          <div style={{display:'flex',gap:6,alignItems:'stretch'}}>
            <GitHubUrlInputs
              value={editGithubUrl}
              onChange={setEditGithubUrl}
              onOpen={url => { void openGitHubWithDiagnostics(item, url); }}
              onKeyDown={handleEditKeyPress}
              inputStyle={inpV3}
            />
            <button
              type="button"
              data-testid="edit-detect-github-card"
              disabled={!editFolderPath.trim() || editGithubDetecting}
              onClick={handleDetectEditGithubUrl}
              title="프로젝트 폴더에 연결된 GitHub 원격 저장소 감지"
              style={{padding:'0 9px',background:'rgba(96,165,250,0.08)',border:'1px solid rgba(96,165,250,0.22)',borderRadius:6,color:'#93c5fd',cursor:(!editFolderPath.trim()||editGithubDetecting)?'not-allowed':'pointer',fontSize:10,fontFamily:'inherit',whiteSpace:'nowrap',opacity:(!editFolderPath.trim()||editGithubDetecting)?0.5:1}}
            >
              {editGithubDetecting ? '감지 중…' : 'GitHub 감지'}
            </button>
          </div>
          {renderEditAiClassification('card')}
          <input type="text" value={editDescription} onChange={e=>setEditDescription(e.target.value)} onKeyDown={handleEditKeyPress}
            style={inpV3} placeholder="프로젝트 설명" />
          <Suspense fallback={null}>
            <ProjectMemoryPanel
              folderPath={editFolderPath}
              projectName={editName}
              githubUrl={primaryGitHubRepositoryUrl({ githubUrl: editGithubUrl })}
              onToast={showToast}
            />
          </Suspense>
        </div>
      );
    }

    const menuOpen = v3MenuOpenId === item.id;
    const itemGithubUrls = githubRepositoryUrls(item);
    const canOpenLocalhost = canOpenRegisteredPort(item);
    const btnBase: React.CSSProperties = {padding:'5px 8px',borderRadius:5,background:'transparent',border:'1px solid rgba(255,255,255,0.07)',color:'#f4f4f5',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11};

    return (
      <div key={item.id} data-testid="project-card" data-project-id={item.id} data-folder-path={item.folderPath} data-help-key="card-body" className="group" style={{
        padding:12, background:'#111113',
        border:'1px solid rgba(255,255,255,0.07)',
        borderRadius:8, cursor:'pointer',
        display:'flex', flexDirection:'column', gap:6,
        minHeight:108, position:'relative',
        zIndex: menuOpen ? 50 : 'auto',
      }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,0.12)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,0.07)'; }}
      >
        <div style={{display:'flex',alignItems:'center',gap:5}}>
          <span style={{width:7,height:7,borderRadius:4,flexShrink:0,background:item.isRunning?'#4ade80':'#71717a'}} />
          <span style={{fontSize:13,fontWeight:600,letterSpacing:-0.2,color:'#f4f4f5',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}</span>
          {item.favorite && <Pin style={{width:10,height:10,flexShrink:0,fill:'#5eead4',color:'#5eead4'}} />}
          {item.port
            ? <span style={{fontSize:11,fontFamily:'JetBrains Mono, monospace',color:'#5eead4',flexShrink:0}}>:{item.port}</span>
            : item.folderPath && <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:'rgba(94,234,212,0.12)',color:'#5eead4',flexShrink:0,border:'1px solid rgba(94,234,212,0.25)'}}>폴더</span>}
        </div>

        {item.description && (
          <div style={{fontSize:12,color:'#a1a1aa',marginTop:-2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={item.description}>📝 {item.description}</div>
        )}
        {(item.aiName || item.category) && (
          <div style={{display:'flex',alignItems:'center',gap:5,overflow:'hidden',minHeight:17}}>
            {item.aiName && (
              <span title={`프로젝트 별명: ${item.aiName}`} style={{fontSize:10,color:'#d8b4fe',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                별명 · {item.aiName}
              </span>
            )}
            {item.category && (
              <span title={`카테고리: ${item.category}`} style={{fontSize:9,padding:'1px 5px',borderRadius:4,background:'rgba(94,234,212,0.08)',border:'1px solid rgba(94,234,212,0.18)',color:'#5eead4',whiteSpace:'nowrap',flexShrink:0}}>
                {item.category}
              </span>
            )}
          </div>
        )}

        {!item.isRunning && (
          <div style={{display:'flex',alignItems:'center',gap:4,fontSize:10.5,color:'#71717a'}}>
            <Clock style={{width:9,height:9,flexShrink:0}} />
            {formatLastRun(lastActivityFor(item.id))}
          </div>
        )}

        {item.worktreePath && (
          <div style={{display:'flex',alignItems:'center',gap:4,fontSize:11,fontFamily:'JetBrains Mono, monospace',color:'#7ba7c9',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}}>
            <GitBranch style={{width:10,height:10,flexShrink:0}} />
            {item.worktreePath.split('/').pop() || item.worktreePath}
          </div>
        )}

        {/* Primary action strip */}
        <div style={{marginTop:8,display:'flex',flexWrap:'wrap',gap:3}}>
          {/* Run/Stop or Open Folder - primary action */}
          {item.port ? (
            <button data-help-key="card-run-stop" onClick={e=>{e.stopPropagation(); item.isRunning ? stopCommand(item) : executeCommand(item);}} style={{
              padding:'4px 10px',borderRadius:4,
              background:item.isRunning?'rgba(248,113,113,0.14)':'rgba(74,222,128,0.14)',
              color:item.isRunning?'#f87171':'#4ade80',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }}>
              {item.isRunning ? <Square style={{width:8,height:8}}/> : <Play style={{width:8,height:8}}/>}
              {item.isRunning ? 'Stop' : 'Run'}
            </button>
          ) : (
            <button data-help-key="menu-open-folder" onClick={e=>{e.stopPropagation(); item.folderPath ? API.openFolder(item.folderPath).catch(e=>showToast(`폴더 열기 실패: ${e.message}`, 'error')) : showToast('폴더 경로가 없습니다', 'error');}} style={{
              padding:'4px 10px',borderRadius:4,
              background:'rgba(94,234,212,0.14)', color:'#5eead4',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }} title="폴더 열기">
              <FolderOpen style={{width:8,height:8}}/>
              {lang==='ko'?'폴더':'Folder'}
            </button>
          )}
          {/* Claude button - prominent */}
          {agentShown('claude') && (
            <button data-testid="project-claude-agent" onClick={e=>{e.stopPropagation();openClaudeMain(item, false);}} style={{
              padding:'4px 10px',borderRadius:4,
              background:'rgba(124,58,237,0.15)',color:'#a78bfa',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }} title={`Claude (${terminalApp}${bgMode?' --bg':''})`}>
              <Terminal style={{width:8,height:8}}/>
              Claude
            </button>
          )}
          {/* Codex button */}
          {agentShown('codex') && (
            <button data-testid="project-codex-agent" onClick={e=>{e.stopPropagation();openCodexMain(item);}} style={{
              padding:'4px 10px',borderRadius:4,
              background:'rgba(16,185,129,0.12)',color:'#6ee7b7',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }} title={`Codex (${terminalApp})`}>
              <Terminal style={{width:8,height:8}}/>
              Codex
            </button>
          )}
          {/* Antigravity button */}
          {agentShown('agy') && (
            <button data-testid="project-agy-agent" onClick={e=>{e.stopPropagation();openAntigravityMain(item);}} style={{
              padding:'4px 10px',borderRadius:4,
              background:'rgba(251,146,60,0.12)',color:'#fdba74',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }}>
              <Zap style={{width:8,height:8}}/>
              agy
            </button>
          )}
          {agentShown('hermes') && (
            <button data-testid="project-hermes-agent" onClick={e=>{e.stopPropagation();openHermesMain(item);}} style={{
              padding:'4px 10px',borderRadius:4,
              background:'rgba(252,211,77,0.12)',color:'#fcd34d',
              border:'none',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }} title={`Hermes CLI (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : terminalApp})`}>
              <Sparkles style={{width:8,height:8}}/>
              Hermes CLI
            </button>
          )}
          {agentShown('claude') && (
            <button
              data-testid="project-claude-code-app"
              onClick={e=>{e.stopPropagation(); void openProjectCodeApp('claude', item);}}
              style={{
                padding:'4px 9px',borderRadius:4,
                background:'rgba(200,168,240,0.08)',color:'#d8b4fe',
                border:'1px solid rgba(200,168,240,0.24)',fontSize:10,fontWeight:600,cursor:'pointer',
                display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
              }}
              title="터미널 선택과 무관하게 이 프로젝트를 Claude Desktop의 Code 탭에서 열기"
            >
              <Monitor style={{width:8,height:8}}/>
              Claude 프로젝트
            </button>
          )}
          {agentShown('codex') && (
            <button
              data-testid="project-codex-app"
              onClick={e=>{e.stopPropagation(); void openProjectCodeApp('codex', item);}}
              style={{
                padding:'4px 9px',borderRadius:4,
                background:'rgba(110,231,183,0.08)',color:'#6ee7b7',
                border:'1px solid rgba(110,231,183,0.24)',fontSize:10,fontWeight:600,cursor:'pointer',
                display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
              }}
              title="터미널 선택과 무관하게 이 프로젝트를 ChatGPT 앱의 Codex에서 열기"
            >
              <Monitor style={{width:8,height:8}}/>
              ChatGPT Codex
            </button>
          )}
          {agentShown('hermes') && (
            <button
              data-testid="project-hermes-app"
              onClick={e=>{e.stopPropagation(); void openProjectCodeApp('hermes', item);}}
              style={{
                padding:'4px 9px',borderRadius:4,
                background:'rgba(252,211,77,0.08)',color:'#fcd34d',
                border:'1px solid rgba(252,211,77,0.24)',fontSize:10,fontWeight:600,cursor:'pointer',
                display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
              }}
              title="터미널 선택과 무관하게 이 프로젝트를 Hermes Desktop에서 열기"
            >
              <Monitor style={{width:8,height:8}}/>
              Hermes 앱
            </button>
          )}
          <button
            data-testid="project-buzz-app"
            onClick={e=>{e.stopPropagation(); openBuzzProject(item);}}
            style={{
              padding:'4px 9px',borderRadius:4,
              background:'rgba(34,211,238,0.08)',color:'#67e8f9',
              border:'1px solid rgba(34,211,238,0.24)',fontSize:10,fontWeight:600,cursor:'pointer',
              display:'flex',alignItems:'center',gap:3,fontFamily:'inherit',
            }}
            title="이 프로젝트를 Buzz DEV 채널로 연결하거나 USE 운영 채널로 준비"
          >
            <MessageSquarePlus style={{width:8,height:8}}/>
            Buzz 채널
          </button>
          {/* Icon buttons - secondary actions */}
          {item.port && (
            <button data-help-key="card-chrome" data-testid="card-open-localhost" aria-label={`localhost:${item.port}`} disabled={!canOpenLocalhost} onClick={e=>{e.stopPropagation(); if (canOpenLocalhost) void openBrowserWithDiagnostics(item, `http://localhost:${item.port}`);}} style={{...btnBase,padding:'4px 6px',opacity:canOpenLocalhost?1:0.45,cursor:canOpenLocalhost?'pointer':'not-allowed'}} title={item.isRunning?`localhost:${item.port}`:`localhost:${item.port} 열기 · 현재 실행 상태 미감지`}>
              <Laptop style={{width:10,height:10}} aria-hidden="true"/>
            </button>
          )}
          <button data-help-key="card-worktree" aria-label="워크트리" aria-pressed={expandedWorktreeIds.has(item.id)} onClick={e=>{e.stopPropagation(); toggleWorktreePanel(item.id, item.folderPath);}} style={{...btnBase,padding:'4px 6px', color:expandedWorktreeIds.has(item.id)?'#5eead4':'#f4f4f5', borderColor:expandedWorktreeIds.has(item.id)?'rgba(94,234,212,0.3)':'rgba(255,255,255,0.07)'}} title="워크트리">
            <GitBranch style={{width:10,height:10}} aria-hidden="true"/>
          </button>
          {itemGithubUrls.map((url, index) => (
            <button
              key={url}
              data-help-key="card-github"
              data-testid={index === 0 ? 'card-open-github' : `card-open-github-${index + 1}`}
              aria-label={`GitHub ${index + 1} 열기`}
              onClick={e=>{e.stopPropagation(); void openGitHubWithDiagnostics(item, url);}}
              style={{...btnBase,padding:'4px 6px',color:'#7ba7c9'}}
              title={`GitHub ${index + 1} 열기 · ${url}`}
            >
              <Github style={{width:10,height:10}} aria-hidden="true"/>
              {itemGithubUrls.length > 1 && <span>{index + 1}</span>}
            </button>
          ))}
          <button
            type="button"
            data-testid="card-add-github"
            aria-label={`${item.name} GitHub 주소 추가`}
            onClick={e => { e.stopPropagation(); startEdit(item); }}
            style={{...btnBase,padding:'4px 7px',color:'#93c5fd',borderColor:'rgba(123,167,201,0.25)'}}
            title={itemGithubUrls.length > 0 ? 'GitHub 저장소 주소 추가·수정' : 'GitHub 저장소 주소 추가'}
          >
            <Github style={{width:10,height:10}} aria-hidden="true"/>
            +
          </button>
          {item.deployUrl && (
            <button data-help-key="card-deploy" aria-label="배포" onClick={e=>{e.stopPropagation(); void openDeploymentWithDiagnostics(item);}} style={{...btnBase,padding:'4px 6px'}} title={item.deployUrl}>
              <Globe style={{width:10,height:10}} aria-hidden="true"/>
            </button>
          )}
          <button data-help-key="card-favorite" aria-label={item.favorite?'고정 해제':'상단 고정'} onClick={e=>{e.stopPropagation(); toggleFavorite(item);}} style={{...btnBase,padding:'4px 6px', color: item.favorite?'#5eead4':'#f4f4f5', borderColor: item.favorite?'rgba(94,234,212,0.3)':'rgba(255,255,255,0.07)'}} title={item.favorite?'사이드바 상단 고정 해제':'사이드바 상단에 고정'}>
            <Pin style={{width:10,height:10,fill:item.favorite?'#5eead4':'none'}} aria-hidden="true"/>
          </button>
          <button data-help-key="card-more-menu" aria-label="더보기" onClick={e=>{e.stopPropagation(); if(menuOpen){setV3MenuOpenId(null);setV3MenuRect(null);}else{const r=e.currentTarget.getBoundingClientRect();setV3MenuOpenId(item.id);setV3MenuRect({top:r.bottom+4,right:window.innerWidth-r.right});}}} style={{...btnBase,padding:'4px 6px', color: menuOpen?'#5eead4':'#f4f4f5', borderColor: menuOpen?'rgba(94,234,212,0.3)':'rgba(255,255,255,0.07)'}}>
            <ChevronDown style={{width:10,height:10}} aria-hidden="true"/>
          </button>
        </div>

        {/* Secondary actions - compact local preview destinations (macOS) */}
        {item.port && !isWindows() && (
          <div style={{display:'flex', gap:3, marginTop:3}} onClick={e=>e.stopPropagation()}>
            <button disabled={!canOpenLocalhost} onClick={e=>{e.stopPropagation(); if (canOpenLocalhost) openCmuxLocalhost(item);}} style={{
              padding:'3px 8px',borderRadius:3,fontSize:9,
              background:'rgba(15,118,110,0.12)',color:'#2dd4bf',
              border:'none',cursor:canOpenLocalhost?'pointer':'not-allowed',fontFamily:'inherit',opacity:canOpenLocalhost?1:0.45,
            }} title={item.isRunning?`cmux localhost:${item.port}`:`cmux localhost:${item.port} 열기 · 현재 실행 상태 미감지`}>
              cmux :{item.port}
            </button>
            <button data-testid="card-orca-localhost" disabled={!canOpenLocalhost} onClick={e=>{e.stopPropagation(); if (canOpenLocalhost) openOrcaLocalhost(item);}} style={{
              padding:'3px 8px',borderRadius:3,fontSize:9,
              background:'rgba(56,189,248,0.1)',color:'#38bdf8',
              border:'1px solid rgba(56,189,248,0.18)',cursor:canOpenLocalhost?'pointer':'not-allowed',fontFamily:'inherit',opacity:canOpenLocalhost?1:0.45,
            }} title={item.isRunning?`이 프로젝트의 Orca 브라우저 탭으로 localhost:${item.port} 열기`:`Orca에서 localhost:${item.port} 열기 · 현재 실행 상태 미감지`}>
              Orca :{item.port}
            </button>
          </div>
        )}

        {/* Worktree panel */}
        {expandedWorktreeIds.has(item.id) && renderWorktreePanel(item)}

        {/* Secondary menu */}
        {menuOpen && v3MenuRect && (
          <>
          <div style={{position:'fixed',inset:0,zIndex:9998}} onClick={()=>{setV3MenuOpenId(null);setV3MenuRect(null);}}/>
          <div style={{position:'fixed',top:v3MenuRect.top,right:v3MenuRect.right,zIndex:9999,background:'#18181b',border:'1px solid rgba(255,255,255,0.12)',borderRadius:8,padding:'4px 0',boxShadow:'0 12px 32px rgba(0,0,0,0.7)',minWidth:165,maxHeight:`calc(100dvh - ${v3MenuRect.top + 8}px)`,overflowY:'auto'}}>
            {[
              {label:'강제 재실행', icon:<RotateCw style={{width:11,height:11}}/>, action:()=>forceRestartCommand(item), title:'프로세스 강제 종료 후 재실행', helpKey:'menu-force-restart'},
              {label:'폴더 열기', icon:<FolderOpen style={{width:11,height:11}}/>, action:()=>item.folderPath && API.openFolder(item.folderPath), title:'Finder에서 프로젝트 폴더 열기', helpKey:'menu-open-folder'},
              {label:'폴더명 변경 프롬프트', icon:<Copy style={{width:11,height:11}}/>, action:()=>{ void copyProjectFolderRenamePrompt(item); }, title:'새 폴더명을 입력하고 충돌 없는 이름변경 프롬프트 복사', helpKey:'menu-copy-folder-rename-prompt'},
              {label:'서버 실행 로그 보기', icon:<StickyNote style={{width:11,height:11}}/>, action:()=>{ handleViewPortLog(item.id, item.name); }, title:'현재 서버 프로세스의 stdout/stderr 실시간 로그 보기', helpKey:'menu-view-log'},
              ...(!isWindows() ? [{label:'cmux 터미널', icon:<Terminal style={{width:11,height:11}}/>, action:()=>openCmuxTerminal(item), title:'cmux로 폴더 열기 (Claude 없이, macOS 전용)', helpKey:'menu-cmux-terminal'}] : []),
            ].map(({label,icon,action,title,helpKey}:{label:string;icon:React.ReactNode;action:()=>void;title?:string;helpKey:string}) => (
              <button key={label} data-help-key={helpKey} title={title} onClick={e=>{e.stopPropagation(); action(); setV3MenuOpenId(null);}} style={{
                display:'flex',alignItems:'center',gap:8,padding:'6px 12px',width:'100%',
                background:'transparent',border:'none',cursor:'pointer',
                fontSize:12,color:'#f4f4f5',fontFamily:'inherit',textAlign:'left',
              }}
                onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.05)')}
                onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
              >{icon}{label}</button>
            ))}
            {/* 편집/삭제 섹션 */}
            <div style={{margin:'3px 8px',borderTop:'1px solid rgba(255,255,255,0.08)'}}/>
            {[
              {label:'수정', icon:<Pencil style={{width:11,height:11}}/>, action:()=>startEdit(item), helpKey:'menu-edit'},
              {label:'삭제', icon:<Trash2 style={{width:11,height:11}}/>, action:()=>setDeleteConfirmId(item.id), danger:true, helpKey:'menu-delete'},
            ].map(({label,icon,action,danger,helpKey}:{label:string;icon:React.ReactNode;action:()=>void;danger?:boolean;helpKey:string}) => (
              <button key={label} data-help-key={helpKey} onClick={e=>{e.stopPropagation(); action(); setV3MenuOpenId(null);}} style={{
                display:'flex',alignItems:'center',gap:8,padding:'6px 12px',width:'100%',
                background:'transparent',border:'none',cursor:'pointer',
                fontSize:12,color:danger?'#f87171':'#f4f4f5',fontFamily:'inherit',textAlign:'left',
              }}
                onMouseEnter={e=>(e.currentTarget.style.background=danger?'rgba(248,113,113,0.08)':'rgba(255,255,255,0.05)')}
                onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
              >{icon}{label}</button>
            ))}
          </div>
          </>
        )}
      </div>
    );
  };

  const renderWorktreePanel = (portItem: PortInfo) => (
    <div style={{marginTop:4,background:'#1a1814',borderRadius:6,border:'1px solid rgba(94,234,212,0.15)',borderLeft:'2px solid rgba(94,234,212,0.35)',padding:'8px 8px 6px',display:'flex',flexDirection:'column',gap:4}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:2}}>
        <div style={{display:'flex',alignItems:'center',gap:4,fontSize:10,color:'#5eead4',fontWeight:700,letterSpacing:0.8,textTransform:'uppercase' as const,opacity:0.7}}>
          <GitBranch style={{width:9,height:9}}/> Worktrees
        </div>
        <button
          data-testid="worktree-remote-refresh"
          onClick={e=>{
            e.stopPropagation();
            portItem.folderPath && loadWorktrees(portItem.id, portItem.folderPath, { fetchRemote: true });
          }}
          style={{padding:'2px 5px',background:'transparent',border:'none',cursor:'pointer',color:'#71717a',display:'flex',alignItems:'center',gap:3,fontSize:10,fontFamily:'inherit'}}
          title="원격 Fetch 후 커밋·풀·푸시 상태 새로고침"
        >
          {/* 행의 ↻(강제 재실행)와 같은 아이콘이라 아이콘만 두면 구분이 안 된다 — 텍스트를 함께 표기 */}
          <RotateCw style={{width:10,height:10}}/>원격 새로고침
        </button>
      </div>
      <div
        data-testid="worktree-local-git-control"
        style={{display:'flex',alignItems:'center',gap:6,padding:'5px 6px',marginBottom:2,borderRadius:5,background:'rgba(0,0,0,0.18)',border:'1px solid rgba(255,255,255,0.06)'}}
      >
        <Github style={{width:10,height:10,color:'#a1a1aa',flexShrink:0}}/>
        <span style={{fontSize:10,color:'#a1a1aa',flex:1}}>로컬 Git 저장소</span>
        {(worktreeGitStatus[portItem.id] ?? 'checking') === 'checking' && (
          <span style={{fontSize:9,color:'#71717a'}}>확인 중…</span>
        )}
        {worktreeGitStatus[portItem.id] === 'ready' && (
          <>
            <span style={{fontSize:9,color:'#6ee7b7',background:'rgba(52,211,153,0.1)',padding:'1px 5px',borderRadius:3}}>연결됨</span>
            {repositoryWorkflowStatuses[portItem.id]?.updateAvailable ? (
              <button
                data-testid="repository-workflow-upgrade"
                disabled={!!repositoryWorkflowBusy[portItem.id]}
                onClick={e=>{e.stopPropagation(); void handleRepositoryWorkflowUpgrade(portItem);}}
                style={{padding:'2px 6px',background:'rgba(94,234,212,0.1)',border:'1px solid rgba(94,234,212,0.25)',borderRadius:4,color:'#5eead4',fontSize:9,cursor:repositoryWorkflowBusy[portItem.id]?'wait':'pointer',fontFamily:'inherit',opacity:repositoryWorkflowBusy[portItem.id]?0.6:1}}
                title="기존 Git 기록은 유지하고 최신 AI 첫 임무·워크트리 선택 기능을 설치합니다"
              >
                {repositoryWorkflowBusy[portItem.id] ? '업데이트 중…' : `작업 흐름 v${repositoryWorkflowStatuses[portItem.id]?.currentVersion} 업데이트`}
              </button>
            ) : repositoryWorkflowStatuses[portItem.id]?.installedVersion ? (
              <span data-testid="repository-workflow-version" style={{fontSize:9,color:'#7dd3fc',background:'rgba(56,189,248,0.08)',padding:'1px 5px',borderRadius:3}}>
                작업 흐름 v{repositoryWorkflowStatuses[portItem.id]?.installedVersion}
              </span>
            ) : null}
            <button
              data-testid="worktree-git-reinitialize"
              disabled={!!worktreeGitBusy[portItem.id]}
              onClick={e=>{e.stopPropagation(); void handleWorktreeGitInitialize(portItem, true);}}
              style={{padding:'2px 6px',background:'transparent',border:'1px solid rgba(248,113,113,0.2)',borderRadius:4,color:'#f87171',fontSize:9,cursor:worktreeGitBusy[portItem.id]?'wait':'pointer',fontFamily:'inherit',opacity:worktreeGitBusy[portItem.id]?0.6:1}}
              title="기존 커밋과 브랜치를 삭제하고 Git 저장소를 다시 만듭니다"
            >
              다시 만들기
            </button>
          </>
        )}
        {(worktreeGitStatus[portItem.id] === 'none' || worktreeGitStatus[portItem.id] === 'no-commit') && (
          <>
            <span style={{fontSize:9,color:'#fbbf24'}}>
              {worktreeGitStatus[portItem.id] === 'no-commit' ? '초기 커밋 필요' : '저장소 없음'}
            </span>
            <button
              data-testid="worktree-git-init"
              disabled={!!worktreeGitBusy[portItem.id]}
              onClick={e=>{e.stopPropagation(); void handleWorktreeGitInitialize(portItem);}}
              style={{padding:'2px 7px',background:'rgba(94,234,212,0.1)',border:'1px solid rgba(94,234,212,0.25)',borderRadius:4,color:'#5eead4',fontSize:9,cursor:worktreeGitBusy[portItem.id]?'wait':'pointer',fontFamily:'inherit',opacity:worktreeGitBusy[portItem.id]?0.6:1}}
            >
              {worktreeGitBusy[portItem.id] ? '만드는 중…' : worktreeGitStatus[portItem.id] === 'no-commit' ? '초기 커밋 만들기' : '저장소 만들기'}
            </button>
          </>
        )}
        {worktreeGitStatus[portItem.id] === 'unknown' && !worktreeLoadErrors[portItem.id] && (
          <>
            <span style={{fontSize:9,color:'#f87171'}}>확인 실패</span>
            <button
              data-testid="worktree-git-retry"
              onClick={e=>{e.stopPropagation(); portItem.folderPath && void loadWorktrees(portItem.id, portItem.folderPath);}}
              style={{padding:'2px 6px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#a1a1aa',fontSize:9,cursor:'pointer',fontFamily:'inherit'}}
            >
              다시 확인
            </button>
          </>
        )}
      </div>
      {worktreeLoadErrors[portItem.id] ? (
        <div
          data-testid="worktree-load-error"
          style={{
            display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,
            padding:'8px',borderRadius:5,border:'1px solid rgba(248,113,113,0.2)',
            background:'rgba(127,29,29,0.12)',color:'#fca5a5',fontSize:10,
          }}
        >
          <span>
            {worktreeLoadErrors[portItem.id]?.code === 'PROJECT_ROOT_MISSING'
              ? '프로젝트 폴더가 이동되었거나 삭제되었습니다. 저장된 경로를 다시 지정하세요.'
              : worktreeLoadErrors[portItem.id]?.message}
          </span>
          {worktreeLoadErrors[portItem.id]?.code === 'PROJECT_ROOT_MISSING' && (
            <button
              type="button"
              data-testid="worktree-fix-folder-path"
              onClick={e=>{e.stopPropagation();startEdit(portItem);}}
              style={{padding:'3px 7px',borderRadius:4,border:'1px solid rgba(248,113,113,0.35)',background:'transparent',color:'#fecaca',fontSize:9,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}
            >
              경로 수정
            </button>
          )}
        </div>
      ) : worktreeLoading[portItem.id] ? (
        <div style={{fontSize:11,color:'#71717a',textAlign:'center',padding:'4px 0'}}>로딩 중...</div>
      ) : (worktreeLists[portItem.id] ?? []).length === 0 ? (
        <div style={{fontSize:11,color:'#71717a',textAlign:'center',padding:'4px 0'}}>워크트리 없음</div>
      ) : (
        (worktreeLists[portItem.id] ?? []).map(wt => {
          const wtName = wt.path.replace(/\/$/, '').split('/').pop() ?? wt.path;
          const branchActionUnavailable = wt.detached || !wt.branch;
          const branchActionMessage = wt.detached
            ? `분리된 HEAD${wt.head ? ` (${wt.head.slice(0, 10)})` : ''} 상태입니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결한 뒤 사용하세요.`
            : '현재 워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침하거나 브랜치를 체크아웃하세요.';
          const displayName = wt.branch
            ?? (wt.detached ? `detached @ ${wt.head?.slice(0, 10) ?? 'HEAD'}` : `${wtName} (브랜치 없음)`);
          const miniBtn: React.CSSProperties = {padding:'3px 7px',borderRadius:4,background:'transparent',border:'1px solid rgba(255,255,255,0.07)',color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit'};
          const changedFiles = wt.changedFiles ?? 0;
          const conflictedFiles = wt.conflictedFiles ?? 0;
          const ahead = wt.ahead ?? 0;
          const behind = wt.behind ?? 0;
          const diverged = ahead > 0 && behind > 0;
          const githubConnected = wt.githubConnected === true;
          const needsPush = ahead > 0 || (!wt.remoteBranchExists && !!wt.hasCommits);
          // 보낼 게 없는 상태. ahead는 로컬 커밋 기준이라 fetch가 오래돼도 신뢰할 수 있다
          // (원격에 새 커밋이 생긴 경우는 behind/풀 쪽 문제이지 푸시 판단을 흐리지 않는다).
          const pushedUpToDate = githubConnected && !needsPush && ahead === 0 && !!wt.hasUpstream;
          const commitStyle: React.CSSProperties = conflictedFiles > 0
            ? {...miniBtn,color:'#fca5a5',borderColor:'rgba(248,113,113,0.45)',background:'rgba(248,113,113,0.12)'}
            : changedFiles > 0
              ? {...miniBtn,color:'#fbbf24',borderColor:'rgba(251,191,36,0.42)',background:'rgba(251,191,36,0.11)'}
              : miniBtn;
          const pullStyle: React.CSSProperties = branchActionUnavailable
            ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'not-allowed',opacity:0.6}
            : behind > 0
            ? {...miniBtn,color:diverged?'#fca5a5':'#7dd3fc',borderColor:diverged?'rgba(248,113,113,0.45)':'rgba(56,189,248,0.42)',background:diverged?'rgba(248,113,113,0.12)':'rgba(56,189,248,0.11)'}
            : miniBtn;
          const pushStyle: React.CSSProperties = branchActionUnavailable
            ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'not-allowed',opacity:0.6}
            : pushedUpToDate
            ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'default',opacity:0.75}
            : !githubConnected
            ? {...miniBtn,color:'#fbbf24',borderColor:'rgba(251,191,36,0.3)',background:'rgba(251,191,36,0.08)',cursor:'not-allowed',opacity:0.75}
            : needsPush
              ? {...miniBtn,color:diverged?'#fca5a5':'#6ee7b7',borderColor:diverged?'rgba(248,113,113,0.45)':'rgba(52,211,153,0.42)',background:diverged?'rgba(248,113,113,0.12)':'rgba(52,211,153,0.11)'}
              : miniBtn;
          const claudeCodeAppStyle: React.CSSProperties = {
            ...miniBtn,
            color:'#d8b4fe',
            borderColor:'rgba(200,168,240,0.28)',
            background:'rgba(200,168,240,0.08)',
          };
          const codexAppStyle: React.CSSProperties = {
            ...miniBtn,
            color:'#6ee7b7',
            borderColor:'rgba(110,231,183,0.28)',
            background:'rgba(110,231,183,0.08)',
          };
          const hermesAppStyle: React.CSSProperties = {
            ...miniBtn,
            color:'#fcd34d',
            borderColor:'rgba(252,211,77,0.28)',
            background:'rgba(252,211,77,0.08)',
          };
          const commitLabel = conflictedFiles > 0 ? `충돌 ${conflictedFiles}` : changedFiles > 0 ? `커밋 ${changedFiles}` : '커밋';
          const pullLabel = branchActionUnavailable ? '브랜치 없음' : behind > 0 ? `풀 ↓${behind}` : '풀';
          // '푸시'만 덩그러니 두면 "보낼 게 있는데 안 눌렀는지" "이미 보냈는지" 알 수 없다.
          // 머지 버튼이 '변경 없음'으로 상태를 말하는 것과 같은 규칙으로 맞춘다.
          const pushLabel = branchActionUnavailable ? '브랜치 없음'
            : !githubConnected ? 'GitHub 미연결'
            : ahead > 0 ? `푸시 ↑${ahead}`
            : needsPush ? '푸시 게시'
            : pushedUpToDate ? '푸시됨' : '푸시';
          const gitStateTitle = wt.statusError
            ? wt.statusError
            : branchActionUnavailable
              ? branchActionMessage
            : diverged
              ? `원격과 분기됨: 로컬 +${ahead}, 원격 +${behind}`
              : `변경 ${changedFiles} · 원격보다 앞 ${ahead} · 뒤 ${behind}${wt.upstream ? ` · ${wt.upstream}` : ''}`;
          const pushTitle = branchActionUnavailable
            ? branchActionMessage
            : pushedUpToDate
            ? `원격과 같은 상태입니다 (${wt.upstream || 'origin'}) · 원격 정보가 오래됐다면 상단 '원격 새로고침'을 누르세요`
            : githubConnected
            ? gitStateTitle
            : 'GitHub 원격(origin)이 연결되지 않아 푸시할 수 없습니다. 프로젝트 수정에서 GitHub 주소를 감지하거나 origin을 연결해주세요.';
          const copyGitMergeSyncPrompt = async () => {
            try {
              await navigator.clipboard.writeText(buildGitMergeSyncPrompt({
                projectName: portItem.name,
                projectPath: portItem.folderPath || wt.path,
                worktreePath: wt.path,
                branch: wt.branch,
                isMainWorktree: wt.is_main,
              }));
              showToast('AI 머지·싱크 프롬프트 복사됨 — 원하는 AI에 붙여넣으세요', 'success');
            } catch {
              showToast('클립보드 복사 실패', 'error');
            }
          };
          const gitMergeSyncPromptButton = (
            <button
              data-testid="worktree-git-sync-prompt"
              data-worktree-path={wt.path}
              onClick={e=>{e.stopPropagation(); void copyGitMergeSyncPrompt();}}
              style={{...miniBtn,color:'#c4b5fd',borderColor:'rgba(196,181,253,0.3)',background:'rgba(196,181,253,0.08)'}}
              title="커밋·GitHub 푸시·기본 브랜치 머지·로컬/원격 동기화를 한 번에 지시하는 범용 AI 프롬프트 복사"
            >
              <Copy style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>AI 머지·싱크
            </button>
          );
          const publicRepositoryUrl = parseGitHubRepositoryUrls([
            ...(portItem.githubUrl ? [portItem.githubUrl] : []),
            ...(portItem.githubUrls ?? []),
          ]).find(url => normalizeGitHubRepositoryUrl(url) === AGENTSTOZ_PUBLIC_REPOSITORY_URL);
          const copyPublicRepositoryUpdatePrompt = async () => {
            if (!publicRepositoryUrl) return;
            try {
              await navigator.clipboard.writeText(buildPublicRepositoryUpdatePrompt({
                projectName: portItem.name,
                projectPath: portItem.folderPath || wt.path,
                worktreePath: wt.path,
                branch: wt.branch,
                isMainWorktree: wt.is_main,
                publicRepositoryUrl,
              }));
              showToast('공개 저장소 업데이트 프롬프트 복사됨 — 원하는 AI에 붙여넣으세요', 'success');
            } catch {
              showToast('클립보드 복사 실패', 'error');
            }
          };
          // 공개 snapshot 스크립트는 기본 브랜치의 깨끗한 상태만 허용한다. 연결된 공개 URL이
          // 있는 메인 worktree에만 버튼을 보여 feature 행에서 잘못 시작할 여지를 없앤다.
          const publicRepositoryUpdatePromptButton = wt.is_main && publicRepositoryUrl ? (
            <button
              data-testid="worktree-public-update-prompt"
              data-worktree-path={wt.path}
              onClick={e=>{e.stopPropagation(); void copyPublicRepositoryUpdatePrompt();}}
              style={{...miniBtn,color:'#67e8f9',borderColor:'rgba(103,232,249,0.3)',background:'rgba(103,232,249,0.08)'}}
              title={`${publicRepositoryUrl} 공개 스냅샷을 검증·업데이트하는 범용 AI 프롬프트 복사`}
            >
              <Copy style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>공개 업데이트
            </button>
          ) : null;
          const mergeComparisonUnavailable = typeof wt.aheadCount !== 'number';
          const mergeDisabled = branchActionUnavailable || mergeComparisonUnavailable || (wt.aheadCount ?? 0) <= 0;
          const mergeTitle = branchActionUnavailable
            ? branchActionMessage
            : mergeComparisonUnavailable
              ? '메인 브랜치와의 차이를 확인하지 못했습니다. 원격 새로고침 후 다시 시도하세요.'
              : (wt.aheadCount ?? 0) <= 0
                ? 'main과 비교해 머지할 변경사항이 없습니다 (이미 머지됐거나 아직 새 커밋이 없는 상태)'
                : undefined;
          const mergeLabel = branchActionUnavailable
            ? '브랜치 없음'
            : mergeComparisonUnavailable
              ? '비교 불가'
              : (wt.aheadCount ?? 0) <= 0 ? '변경 없음' : '머지';
          const wtPortEntry = ports.find(p =>
            p.worktreePath === wt.path ||
            (wt.branch && p.worktreePath === wt.branch) ||
            (p.worktreePath && wt.path.endsWith('/' + p.worktreePath.replace(/^\/+/, ''))) ||
            p.folderPath === wt.path
          );
          const usedPorts = new Set(ports.map(p => p.port).filter((p): p is number => p != null));
          const detectedPort = wtActualPorts[wt.path];
          const wtPort = detectedPort ?? (wtPortEntry?.port ?? worktreePortForMain(portItem.port, wt.path, usedPorts));
          const isWtRunning = detectedPort != null || (wtPortEntry?.isRunning ?? wtPortStatuses[wtPort] ?? false);
          const wtClaudeBypass = () => {
            // 상단 툴바 옵션(terminalApp, bgMode 등)을 반영하는 통합 핸들러 사용
            openClaudeMain(portItem, false, wt.path);
          };
          // 워크트리를 처음 실행할 때 전체 프로젝트 목록에도 영구 등록 (사이드바 "워크트리" 카운트가 실제 상태를 반영하도록)
          const ensureWtPortEntry = async (): Promise<PortInfo> => {
            if (wtPortEntry) return wtPortEntry;
            const newEntry: PortInfo = {
              ...portItem,
              id: `${portItem.id}_wt_${wtName}`,
              name: `${portItem.name} (${displayName})`,
              port: wtPort,
              folderPath: wt.path,
              worktreePath: wt.path,
              commandPath: undefined,
              terminalCommand: undefined,
              isRunning: false,
            };
            // 명령 실행 API는 보안상 ports.json에 등록된 프로젝트/명령만 허용한다.
            // 따라서 새 파생 워크트리 행은 실행 요청보다 먼저 디스크에 저장 완료해야 한다.
            const current = portsRef.current;
            const existing = current.find(p => p.id === newEntry.id);
            if (existing) return existing;
            const next = [...current, newEntry];
            portsRef.current = next;
            setPorts(next);
            await API.savePorts(next);
            return newEntry;
          };
          const runWithWtPortEntry = async (action: 'execute' | 'restart') => {
            try {
              const entry = await ensureWtPortEntry();
              if (action === 'restart') await forceRestartCommand(entry);
              else await executeCommand(entry);
            } catch (error) {
              reportOperationError(
                action === 'restart' ? 'worktree.restart.prepare' : 'worktree.execute.prepare',
                '워크트리 등록 저장 실패',
                portItem,
                wt.path,
                error,
              );
            }
          };
          // ── 워크트리 정체 판정 ───────────────────────────────────────────────
          // 두 가지를 분리해서 계산한다. 예전엔 한 배지에 섞여 있어서, Orca 조회가 실패하면
          // 경로만 봐도 알 수 있는 정보(누가 만들었나 / 숨김 경로인가)까지 통째로 사라졌다.
          //   (1) 출처(누가 만들었나)  → **경로만으로 판정. Orca 없이도 항상 표시된다.**
          //   (2) Orca 표시 여부       → Orca 목록이 있으면 그게 진실, 없어도 숨김 경로면 확실히 "안 보임".
          const projRoot = (portItem.folderPath || '').replace(/\/+$/, '');
          const wtNorm = wt.path.replace(/\/+$/, '');
          // 삭제 경로(confirmDeleteWorktree)와 반드시 같은 판정을 쓴다 — worktreeSource.ts
          const wtSource = classifyWorktreeSource({
            repoRoot: projRoot,
            worktreePath: wtNorm,
            orcaPaths: orcaWorktreePaths.paths,
          });
          const isLegacyWt = wtSource.isLegacyAppWorktree;
          const isAppWt = wtSource.isAppWorktree;
          const inOrcaList = wtSource.inOrcaList;
          const sourceKind: 'orca' | 'app' | 'external' = wtSource.kind;
          const orcaVisibility = classifyOrcaWorktreeVisibility({
            repositoryPath: projRoot,
            worktreePath: wtNorm,
            isMain: wt.is_main,
            listingAvailable: orcaWorktreePaths.available,
            listedPaths: orcaWorktreePaths.paths,
          });
          // true=별도 카드 표시 / false=별도 카드 미표시 / null=현재 확인 못 함.
          // hidden-path는 backend PTY만 생기고 화면 pane이 붙지 않을 수 있어 Orca 실행을 차단한다.
          // 일반 unlisted 경로는 exact-path 실행을 계속 지원한다.
          const orcaVisible: boolean | null = orcaVisibility === 'visible'
            ? true
            : orcaVisibility === 'unknown'
              ? null
              : false;
          const migrating = !!worktreeMigrating[wt.path];
          // 경로 표시: 프로젝트 안이면 상대경로, 밖이면 홈을 ~로 축약 (전체 경로는 title에)
          const displayPath = projRoot && wtNorm.startsWith(`${projRoot}/`)
            ? wtNorm.slice(projRoot.length + 1)
            : wtNorm.replace(/^\/Users\/[^/]+\//, '~/').replace(/^([A-Za-z]:[\\/])Users[\\/][^\\/]+[\\/]/, '~/');
          return (
            <div key={wt.path} style={{padding:'5px 6px',borderRadius:5,background:wt.is_main?'rgba(94,234,212,0.04)':'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.05)',borderLeft:wt.is_main?'2px solid rgba(94,234,212,0.35)':'1px solid rgba(255,255,255,0.05)',display:'flex',flexDirection:'column',gap:4}}>
              <div style={{display:'flex',alignItems:'center',gap:5}}>
                <GitBranch style={{width:9,height:9,color:wt.is_main?'#71717a':'#7ba7c9',flexShrink:0}}/>
                {/* 출처 배지 — 누가 만든 워크트리인가. **경로만으로 판정하므로 Orca 조회 실패와 무관하게 항상 보인다.**
                    브랜치명 span이 flex:1이라 뒤에 두면 행 오른쪽 끝으로 밀려나 눈에 띄지 않는다 → 이름 **앞**에 고정. */}
                {(() => {
                  const label = wt.is_main ? '메인' : sourceKind === 'orca' ? 'Orca' : sourceKind === 'app' ? '앱' : '외부';
                  const c = wt.is_main
                    ? { color:'#a1a1aa', bg:'rgba(255,255,255,0.07)', bd:'rgba(255,255,255,0.18)' }
                    : sourceKind === 'orca'
                      ? { color:'#38bdf8', bg:'rgba(56,189,248,0.18)', bd:'rgba(56,189,248,0.55)' }
                      : sourceKind === 'app'
                        ? { color:'#5eead4', bg:'rgba(94,234,212,0.18)', bd:'rgba(94,234,212,0.55)' }
                        : { color:'#fbbf24', bg:'rgba(251,191,36,0.18)', bd:'rgba(251,191,36,0.55)' };
                  const title = wt.is_main
                    ? '프로젝트 본체(메인 워크트리)입니다.'
                    : sourceKind === 'orca'
                      ? `Orca가 만든 워크트리입니다.\n${wt.path}`
                      : sourceKind === 'app'
                        ? `이 앱이 만든 워크트리입니다.\n${wt.path}`
                        : `외부(터미널 등)에서 만든 워크트리입니다.\n${wt.path}`;
                  return <span data-testid="worktree-source-badge" data-worktree-path={wt.path}
                    data-source={wt.is_main ? 'main' : sourceKind}
                    title={title} style={{fontSize:11,fontWeight:700,letterSpacing:'0.02em',color:c.color,background:c.bg,
                      border:`1px solid ${c.bd}`,padding:'0 5px',borderRadius:4,flexShrink:0,lineHeight:'16px'}}>{label}</span>;
                })()}
                {/* Orca 표시 여부 배지 — 사용자가 실제로 알고 싶은 것("Orca 사이드바에 뜨나?").
                    숨김 경로면 Orca 조회 없이도 "안 보임"이 확정이므로 그때는 항상 단정한다. */}
                {!wt.is_main && (() => {
                  const c = orcaVisible === true
                    ? { label:'Orca 표시', color:'#38bdf8', bg:'rgba(56,189,248,0.14)', bd:'rgba(56,189,248,0.45)',
                        title:'Orca 사이드바에 이 워크트리가 별도 항목으로 표시됩니다.' }
                    : orcaVisible === false
                      ? { label:'사이드바 미표시', color:'#fbbf24', bg:'rgba(251,191,36,0.14)', bd:'rgba(251,191,36,0.45)',
                          title: orcaVisibility === 'hidden-path'
                            ? '숨김 경로에서는 Orca가 화면 패널 없는 세션을 만들 수 있어 Claude·Codex·agy·브라우저 실행을 차단합니다. “새 경로로 옮기기”를 먼저 실행하세요.'
                            : 'Orca 사이드바에 아직 별도 카드로 표시되지 않습니다. Claude·Codex·agy·브라우저는 exact path로 이 워크트리에서 실행됩니다.' }
                      : { label:'Orca 확인중', color:'#a1a1aa', bg:'rgba(255,255,255,0.05)', bd:'rgba(255,255,255,0.14)',
                          title:'Orca 목록을 조회하지 못했습니다(Orca 미설치이거나 데몬이 응답하지 않음). 표시 여부를 확정할 수 없습니다.' };
                  return <span data-testid="worktree-orca-visibility" data-worktree-path={wt.path}
                    data-visible={orcaVisible === null ? 'unknown' : String(orcaVisible)}
                    title={c.title} style={{fontSize:11,fontWeight:600,color:c.color,background:c.bg,
                      border:`1px solid ${c.bd}`,padding:'0 5px',borderRadius:4,flexShrink:0,lineHeight:'16px'}}>{c.label}</span>;
                })()}
                <span title={wt.path} style={{fontSize:11,fontWeight:600,color:wt.is_main?'#f4f4f5':'#7ba7c9',fontFamily:'JetBrains Mono, monospace',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{displayName}</span>
                {conflictedFiles > 0 && <span title={gitStateTitle} style={{fontSize:9,color:'#fca5a5',background:'rgba(248,113,113,0.12)',padding:'1px 4px',borderRadius:3}}>충돌 {conflictedFiles}</span>}
                {conflictedFiles === 0 && changedFiles > 0 && <span title={gitStateTitle} style={{fontSize:9,color:'#fbbf24',background:'rgba(251,191,36,0.1)',padding:'1px 4px',borderRadius:3}}>변경 {changedFiles}</span>}
                {ahead > 0 && <span title={gitStateTitle} style={{fontSize:9,color:'#6ee7b7',background:'rgba(52,211,153,0.1)',padding:'1px 4px',borderRadius:3}}>↑{ahead}</span>}
                {behind > 0 && <span title={gitStateTitle} style={{fontSize:9,color:'#7dd3fc',background:'rgba(56,189,248,0.1)',padding:'1px 4px',borderRadius:3}}>↓{behind}</span>}
                {changedFiles === 0 && ahead === 0 && behind === 0 && wt.remoteBranchExists && <span title={gitStateTitle} style={{fontSize:9,color:'#71717a',background:'rgba(255,255,255,0.04)',padding:'1px 4px',borderRadius:3}}>동기화됨</span>}
                {!wt.is_main && wt.locked && (
                  <span title={wt.lockedReason ? `세션 사용 중 — ${wt.lockedReason}` : '세션 사용 중이라 삭제할 수 없습니다'}
                    style={{display:'flex',alignItems:'center',gap:2,fontSize:9,color:'#5eead4',background:'rgba(94,234,212,0.08)',padding:'1px 4px',borderRadius:3,flexShrink:0}}>
                    <Lock style={{width:8,height:8}}/>세션 사용 중
                  </span>
                )}
              </div>
              {/* 실제 위치 한 줄 — 어떤 워크트리가 어디 있는지 UI에서 확인할 방법이 아예 없었다.
                  레거시 숨김 경로면 왜 Orca에 안 뜨는지와 해결 버튼을 여기서 바로 제공한다. */}
              <div style={{display:'flex',alignItems:'center',gap:5,minWidth:0}}>
                <span data-testid="worktree-path" title={wt.path}
                  style={{fontSize:10,color:'#71717a',fontFamily:'JetBrains Mono, monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,minWidth:0}}>
                  {displayPath}
                </span>
                {!wt.is_main && isLegacyWt && (
                  <button data-testid="worktree-migrate-legacy" data-worktree-path={wt.path}
                    disabled={migrating || !!wt.locked}
                    onClick={e=>{e.stopPropagation(); if(wt.locked){showToast('세션이 사용 중이라 옮길 수 없습니다. 세션 종료 후 다시 시도하세요.','error');return;} handleWorktreeMigrate(portItem, wt);}}
                    style={{...miniBtn,color:'#fbbf24',borderColor:'rgba(251,191,36,0.45)',background:'rgba(251,191,36,0.1)',flexShrink:0,
                      ...(migrating||wt.locked?{opacity:0.6,cursor:'not-allowed'}:{})}}
                    title={`구경로(.claude/worktrees/)는 숨김 폴더라 Orca가 스캔하지 않습니다.\n클릭하면 ${projRoot}/worktrees/${wt.path.split('/').filter(Boolean).pop()} 로 옮겨 Orca가 인식하게 합니다.\n브랜치·변경사항·node_modules는 그대로 따라갑니다.`}>
                    {migrating ? '옮기는 중…' : '새 경로로 옮기기'}
                  </button>
                )}
              </div>
              {/* 생성 시각 + 마지막 커밋 — 여러 워크트리 중 "어느 걸 마지막에 만졌지?"에 답한다.
                  마지막 커밋은 작업할수록 갱신되고, 생성 시각은 오래된 워크트리 정리에 쓰인다. */}
              {(wt.createdAt || wt.lastCommitAt) && (
                <div data-testid="worktree-timestamps" data-worktree-path={wt.path}
                  style={{display:'flex',alignItems:'center',gap:8,fontSize:10,flexWrap:'wrap' as const,marginTop:1}}>
                  {wt.createdAt && (
                    <span data-testid="worktree-created-at"
                      title={`생성: ${formatLastRun(new Date(wt.createdAt).getTime())}`}
                      style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span style={{color:'#71717a'}}>생성</span>
                      <span style={{color:'#d4d4d8',fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:'-0.2px'}}>
                        {formatAbsoluteTimestamp(wt.createdAt)}
                      </span>
                    </span>
                  )}
                  {wt.createdAt && wt.lastCommitAt && <span style={{color:'#3f3f46'}}>·</span>}
                  {wt.lastCommitAt && (
                    <span data-testid="worktree-last-commit-at"
                      title={`마지막 커밋: ${formatLastRun(new Date(wt.lastCommitAt).getTime())}`}
                      style={{display:'inline-flex',alignItems:'center',gap:4}}>
                      <span style={{color:'#71717a'}}>마지막 커밋</span>
                      <span style={{color:'#a5f3fc',fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',fontVariantNumeric:'tabular-nums',letterSpacing:'-0.2px'}}>
                        {formatAbsoluteTimestamp(wt.lastCommitAt)}
                      </span>
                    </span>
                  )}
                </div>
              )}
              <div style={{display:'flex',gap:3,flexWrap:'wrap' as const}}>
              {wt.is_main ? <>
                <button onClick={e=>{e.stopPropagation(); portItem.isRunning ? stopCommand(portItem) : executeCommand(portItem);}} style={{...miniBtn,color:portItem.isRunning?'#f87171':'#4ade80',borderColor:portItem.isRunning?'rgba(248,113,113,0.2)':'rgba(74,222,128,0.2)'}} title={portItem.isRunning?`포트 ${portItem.port}`:undefined}>
                  {portItem.isRunning
                    ? (portItem.port ? `프로세스 중지 · :${portItem.port}` : '프로세스 중지')
                    : (portItem.terminalCommand || portItem.commandPath)
                      ? `등록 명령 실행${portItem.port ? ` · :${portItem.port}` : ''}`
                      : `자동 실행${portItem.port ? ` · :${portItem.port}` : ''}`}
                </button>
                <button disabled={!canOpenRegisteredPort(portItem)} onClick={e=>{e.stopPropagation(); if (canOpenRegisteredPort(portItem)) void openBrowserWithDiagnostics(portItem, `http://localhost:${portItem.port}`, wt.path);}} style={{...miniBtn,...(!canOpenRegisteredPort(portItem)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!portItem.port?'프로젝트 수정에서 포트를 먼저 설정하세요':portItem.isRunning?`localhost:${portItem.port} 열기`:`localhost:${portItem.port} 열기 · 현재 실행 상태 미감지`}><Globe style={{width:9,height:9}}/>localhost</button>
                {!isWindows() && <button disabled={!canOpenRegisteredPort(portItem)} onClick={e=>{e.stopPropagation(); if (canOpenRegisteredPort(portItem)) openCmuxLocalhost(portItem);}} style={{...miniBtn,color:'#2dd4bf',borderColor:'rgba(45,212,191,0.2)',...(!canOpenRegisteredPort(portItem)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!portItem.port?'프로젝트 수정에서 포트를 먼저 설정하세요':portItem.isRunning?`cmux localhost:${portItem.port}`:`cmux localhost:${portItem.port} 열기 · 현재 실행 상태 미감지`}><Terminal style={{width:9,height:9}}/></button>}
                {!isWindows() && <button data-testid="worktree-orca-localhost" data-worktree-path={wt.path} disabled={!canOpenRegisteredPort(portItem)} onClick={e=>{e.stopPropagation(); if (canOpenRegisteredPort(portItem)) openOrcaLocalhost(portItem, wt.path);}} style={{...miniBtn,color:'#38bdf8',borderColor:'rgba(56,189,248,0.25)',...(!canOpenRegisteredPort(portItem)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!portItem.port?'프로젝트 수정에서 포트를 먼저 설정하세요':portItem.isRunning?`이 프로젝트의 Orca 브라우저 탭으로 localhost:${portItem.port} 열기`:`Orca에서 localhost:${portItem.port} 열기 · 현재 실행 상태 미감지`}><Globe style={{width:9,height:9}}/>Orca 탭</button>}
                <button onClick={e=>{e.stopPropagation(); wt.path && API.openFolder(wt.path).catch(e=>showToast(`폴더 열기 실패: ${e.message}`, 'error'));}} style={miniBtn} title="Finder에서 열기"><FolderOpen style={{width:9,height:9}}/></button>
                <button onClick={e=>{e.stopPropagation(); forceRestartCommand(portItem);}} style={{...miniBtn,color:'#5eead4',borderColor:'rgba(94,234,212,0.2)'}} title="강제 재실행"><RotateCw style={{width:9,height:9}}/></button>
                {agentShown('claude') && <button data-testid="worktree-claude-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); wtClaudeBypass();}} style={{...miniBtn,color:'#c8a8f0',borderColor:'rgba(200,168,240,0.25)'}} title={`Claude (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : `${terminalApp}${claudeBgActive ? ' --bg · agents' : ''}`})`}><Zap style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>{bypassPermissions?'Claude ⚡':'Claude'}</button>}
                {agentShown('codex') && <button data-testid="worktree-codex-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openCodexMain(portItem,wt.path);}} style={{...miniBtn,color:'#6ee7b7',borderColor:'rgba(110,231,183,0.25)'}} title={`Codex (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : terminalApp})`}>Codex</button>}
                {agentShown('agy') && <button data-testid="worktree-agy-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openAntigravityMain(portItem,wt.path);}} style={{...miniBtn,color:'#fdba74',borderColor:'rgba(253,186,116,0.25)'}} title={`agy (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : terminalApp})`}>agy</button>}
                {agentShown('hermes') && <button data-testid="worktree-hermes-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openHermesMain(portItem,wt.path);}} style={{...miniBtn,color:'#fcd34d',borderColor:'rgba(252,211,77,0.25)'}} title="이 워크트리에서 Hermes 실행">Hermes</button>}
                {agentShown('claude') && <button data-testid="worktree-claude-code-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('claude', portItem, wt.path);}} style={claudeCodeAppStyle} title="이 워크트리를 Claude Desktop Code 탭에서 열기 · 폴더 확인 필요"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>Claude 프로젝트</button>}
                {agentShown('codex') && <button data-testid="worktree-codex-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('codex', portItem, wt.path);}} style={codexAppStyle} title="이 워크트리를 ChatGPT 앱의 Codex에서 열기"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>ChatGPT Codex</button>}
                {agentShown('hermes') && <button data-testid="worktree-hermes-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('hermes', portItem, wt.path);}} style={hermesAppStyle} title="이 워크트리를 Hermes Desktop에서 열기"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>Hermes 앱</button>}
                <button data-testid="worktree-git-commit" data-worktree-path={wt.path} disabled={changedFiles === 0 && conflictedFiles === 0} onClick={e=>{e.stopPropagation(); setPendingParentCommit(null);setCommitMessageGenerating(false);setCommitModal({item:portItem,wt,msg:''});}} style={commitStyle} title={changedFiles === 0 && conflictedFiles === 0 ? '커밋할 변경이 없습니다' : gitStateTitle}>{commitLabel}</button>
                <button data-testid="worktree-git-pull" data-worktree-path={wt.path} disabled={branchActionUnavailable} onClick={e=>{e.stopPropagation(); void handleWorktreePull(portItem, wt);}} style={pullStyle} title={gitStateTitle}>{pullLabel}</button>
                <button data-testid="worktree-git-push" data-worktree-path={wt.path} disabled={branchActionUnavailable || !githubConnected || pushedUpToDate} onClick={e=>{e.stopPropagation(); void handleWorktreePush(portItem, wt);}} style={pushStyle} title={pushTitle}>{pushLabel}</button>
                {gitMergeSyncPromptButton}
                {publicRepositoryUpdatePromptButton}
              </> : <>
                <button data-testid="worktree-auto-run-stop" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); if(wtPortEntry && isWtRunning){void stopCommand(wtPortEntry);}else{void runWithWtPortEntry('execute');}}} style={{...miniBtn,color:isWtRunning?'#f87171':'#4ade80',borderColor:isWtRunning?'rgba(248,113,113,0.2)':'rgba(74,222,128,0.2)'}} title={isWtRunning?`워크트리 프로세스 중지 · 포트 ${wtPort}`:`${wt.path}에서 실행 명령 자동 감지 · PORT=${wtPort}`}>
                  {isWtRunning ? `프로세스 중지 · :${wtPort}` : `자동 실행 · :${wtPort}`}
                </button>
                <button data-testid="worktree-open-localhost" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openBrowserWithDiagnostics({...portItem, port:wtPort, worktreePath: wt.path}, `http://localhost:${wtPort}`, wt.path);}} style={miniBtn} title={isWtRunning?`localhost:${wtPort} 열기`:`localhost:${wtPort} 열기 · 현재 실행 상태 미감지`}><Globe style={{width:9,height:9}}/>localhost</button>
                {!isWindows() && <button onClick={e=>{e.stopPropagation(); openCmuxLocalhost({...portItem,port:wtPort,worktreePath:wt.path});}} style={{...miniBtn,color:'#2dd4bf',borderColor:'rgba(45,212,191,0.2)'}} title={isWtRunning?`cmux localhost:${wtPort}`:`cmux localhost:${wtPort} 열기 · 현재 실행 상태 미감지`}><Terminal style={{width:9,height:9}}/></button>}
                <button data-testid="worktree-orca-localhost" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openOrcaLocalhost({...portItem,port:wtPort,worktreePath:wt.path}, wt.path);}} style={{...miniBtn,color:'#38bdf8',borderColor:'rgba(56,189,248,0.25)'}} title={isWtRunning?`이 워크트리의 Orca 브라우저 탭으로 localhost:${wtPort} 열기`:`Orca에서 localhost:${wtPort} 열기 · 현재 실행 상태 미감지`}><Globe style={{width:9,height:9}}/>Orca 탭</button>
                <button onClick={e=>{e.stopPropagation(); void runWithWtPortEntry('restart');}} style={{...miniBtn,color:'#5eead4',borderColor:'rgba(94,234,212,0.2)'}} title="강제 재실행"><RotateCw style={{width:9,height:9}}/></button>
                <button onClick={e=>{e.stopPropagation(); API.openFolder(wt.path).catch(error => reportOperationError('folder.open', '폴더 열기 실패', portItem, wt.path, error));}} style={miniBtn} title="Finder에서 열기"><FolderOpen style={{width:9,height:9}}/></button>
                {agentShown('claude') && <button data-testid="worktree-claude-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); wtClaudeBypass();}} style={{...miniBtn,color:'#c8a8f0',borderColor:'rgba(200,168,240,0.25)'}} title={`Claude (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : `${terminalApp}${claudeBgActive ? ' --bg · agents' : ''}`})`}><Zap style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>{bypassPermissions?'Claude ⚡':'Claude'}</button>}
                {agentShown('codex') && <button data-testid="worktree-codex-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openCodexMain(portItem,wt.path);}} style={{...miniBtn,color:'#6ee7b7',borderColor:'rgba(110,231,183,0.25)'}} title={`Codex (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : terminalApp})`}>Codex</button>}
                {agentShown('agy') && <button data-testid="worktree-agy-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openAntigravityMain(portItem,wt.path);}} style={{...miniBtn,color:'#fdba74',borderColor:'rgba(253,186,116,0.25)'}} title={`agy (${terminalApp === 'orca' ? (orcaLaunchMode === 'floating' ? 'Orca 플로팅' : 'Orca 워크트리 내부') : terminalApp})`}>agy</button>}
                {agentShown('hermes') && <button data-testid="worktree-hermes-agent" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); openHermesMain(portItem,wt.path);}} style={{...miniBtn,color:'#fcd34d',borderColor:'rgba(252,211,77,0.25)'}} title="이 워크트리에서 Hermes 실행">Hermes</button>}
                {agentShown('claude') && <button data-testid="worktree-claude-code-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('claude', portItem, wt.path);}} style={claudeCodeAppStyle} title="이 워크트리를 Claude Desktop Code 탭에서 열기 · 폴더 확인 필요"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>Claude 프로젝트</button>}
                {agentShown('codex') && <button data-testid="worktree-codex-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('codex', portItem, wt.path);}} style={codexAppStyle} title="이 워크트리를 ChatGPT 앱의 Codex에서 열기"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>ChatGPT Codex</button>}
                {agentShown('hermes') && <button data-testid="worktree-hermes-app" data-worktree-path={wt.path} onClick={e=>{e.stopPropagation(); void openProjectCodeApp('hermes', portItem, wt.path);}} style={hermesAppStyle} title="이 워크트리를 Hermes Desktop에서 열기"><Monitor style={{width:8,height:8,display:'inline',verticalAlign:'middle'}}/>Hermes 앱</button>}
                <button data-testid="worktree-git-commit" data-worktree-path={wt.path} disabled={changedFiles === 0 && conflictedFiles === 0} onClick={e=>{e.stopPropagation(); setPendingParentCommit(null);setCommitMessageGenerating(false);setCommitModal({item:portItem,wt,msg:''});}} style={commitStyle} title={changedFiles === 0 && conflictedFiles === 0 ? '커밋할 변경이 없습니다' : gitStateTitle}>{commitLabel}</button>
                <button data-testid="worktree-git-pull" data-worktree-path={wt.path} disabled={branchActionUnavailable} onClick={e=>{e.stopPropagation(); void handleWorktreePull(portItem, wt);}} style={pullStyle} title={gitStateTitle}>{pullLabel}</button>
                <button data-testid="worktree-git-push" data-worktree-path={wt.path} disabled={branchActionUnavailable || !githubConnected || pushedUpToDate} onClick={e=>{e.stopPropagation(); void handleWorktreePush(portItem, wt);}} style={pushStyle} title={pushTitle}>{pushLabel}</button>
                {gitMergeSyncPromptButton}
                {publicRepositoryUpdatePromptButton}
                {/* 머지할 게 없으면 상태 표기이므로 실제로 눌리지 않게 한다(라벨은 동작이 아니라 상태를 말한다) */}
                <button disabled={mergeDisabled} onClick={e=>{e.stopPropagation(); handleWorktreeMerge(portItem,wt);}}
                  style={mergeDisabled
                    ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'default',opacity:0.75}
                    : {...miniBtn,color:'#5eead4',borderColor:'rgba(94,234,212,0.2)'}}
                  title={mergeTitle}>
                  {mergeLabel}
                </button>
                {/* 머지 다음 갈림길: 재사용(새 브랜치) vs 버림(삭제). 삭제만 있으면 다음 작업 때마다
                    워크트리를 다시 만들어야 하고 node_modules 수만 개를 재설치하게 된다. */}
                <button data-testid="worktree-switch-branch" data-worktree-path={wt.path}
                  disabled={!!wt.locked || !!worktreeBranchBusy[wt.path]}
                  onClick={e=>{e.stopPropagation(); setSwitchBranchModal({item:portItem,wt,name:defaultFirstTaskBranchName()});}}
                  style={(wt.locked || worktreeBranchBusy[wt.path])
                    ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'not-allowed',opacity:0.6}
                    : {...miniBtn,color:'#93c5fd',borderColor:'rgba(147,197,253,0.25)'}}
                  title={wt.locked
                    ? '세션 사용 중이라 브랜치를 바꿀 수 없습니다. 먼저 잠금을 해제하세요.'
                    : '이 워크트리를 지우지 않고 새 브랜치로 재사용합니다 (폴더·node_modules 유지)'}>
                  새 브랜치
                </button>
                {/* 삭제가 막혔을 때 푸는 길. 이게 없으면 잠긴 워크트리는 앱 안에서 손댈 수 없는 막다른 길이 된다. */}
                {wt.locked && (
                  <button data-testid="worktree-unlock" data-worktree-path={wt.path}
                    disabled={!!worktreeBranchBusy[wt.path]}
                    onClick={e=>{e.stopPropagation(); void handleWorktreeUnlock(portItem,wt);}}
                    style={{...miniBtn,color:'#fbbf24',borderColor:'rgba(251,191,36,0.35)'}}
                    title={wt.lockedReason ? `잠금 해제 — ${wt.lockedReason}` : '이 워크트리의 잠금을 해제합니다 (열려 있는 AI 세션을 먼저 닫으세요)'}>
                    {worktreeBranchBusy[wt.path] ? '해제 중…' : '잠금 해제'}
                  </button>
                )}
                <button onClick={e=>{e.stopPropagation(); if(wt.locked){showToast('Claude Code 세션이 사용 중입니다. 세션 종료 후 삭제하세요.','error');return;} handleWorktreeRemove(portItem,wt);}}
                  disabled={!!wt.locked}
                  style={wt.locked
                    ? {...miniBtn,color:'#71717a',borderColor:'rgba(255,255,255,0.07)',cursor:'not-allowed',opacity:0.6}
                    : {...miniBtn,color:'#f87171',borderColor:'rgba(248,113,113,0.2)'}}
                  title={wt.locked?'Claude Code 세션이 사용 중입니다. 세션 종료 후 삭제하세요.':undefined}>삭제</button>
              </>}
              </div>
            </div>
          );
        })
      )}
      <div style={{display:'flex',gap:4,marginTop:2}}>
        <input type="text" value={worktreeNewBranch[portItem.id] ?? ''} onChange={e=>setWorktreeNewBranch(prev=>({...prev,[portItem.id]:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();handleWorktreeAdd(portItem);}}} onClick={e=>e.stopPropagation()} placeholder="브랜치명" style={{flex:1,padding:'4px 7px',background:'#09090b',border:'1px solid rgba(255,255,255,0.07)',borderRadius:4,color:'#f4f4f5',fontSize:11,fontFamily:'inherit'}}/>
        <button onClick={e=>{e.stopPropagation(); handleWorktreeAdd(portItem);}} style={{padding:'4px 8px',background:'rgba(94,234,212,0.1)',border:'1px solid rgba(94,234,212,0.25)',borderRadius:4,color:'#5eead4',fontSize:10,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}>+ 추가</button>
      </div>
    </div>
  );

  const renderV4View = () => {
    const sel = v4SelectedId ? v3Ports.find(p => p.id === v4SelectedId) ?? null : null;
    const monoFont = 'JetBrains Mono, monospace';
    const rowBtn = {padding:'5px 10px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif',display:'flex',alignItems:'center',gap:4} as const;

    // 고정 그룹만 수동 정렬한다. 실행/유휴 그룹은 실행 상태·최근 활동으로 자동 정렬되므로
    // 수동 순서를 얹으면 다음 폴링에서 되돌아간 것처럼 보인다.
    const finishPinnedDrag = () => { pinnedDragRef.current = null; setDraggingPinnedId(null); setPinnedDropTargetId(null); };
    // 끌린 id를 인자로 받는다 — 상태(`draggingPinnedId`)에서 읽으면 같은 프레임에 시작하고
    // 끝난 드래그에서 아직 반영되지 않은 값을 보게 된다.
    const dropPinnedOn = (draggedId: string, targetId: string) => {
      const dragged = draggedId;
      finishPinnedDrag();
      if (!dragged || dragged === targetId) return;
      // 저장된 순서가 아니라 **지금 화면에 보이는 순서**를 기준으로 다시 계산한다.
      setPinnedOrder(reorderPinned(v3Pinned.map(p => p.id), dragged, targetId));
    };

    const renderRow = (item: PortInfo, draggable = false) => {
      const active = item.id === v4SelectedId;
      const dragging = draggable && draggingPinnedId === item.id;
      const dropTarget = draggable && pinnedDropTargetId === item.id && draggingPinnedId !== item.id;
      const executionKind = projectExecutionKind(item);
      const autoDetectedLaunch = executionKind === 'worktree-auto' || executionKind === 'folder-auto';
      const launchTitle = item.isRunning
        ? `등록 포트 ${item.port}의 프로세스 중지`
        : autoDetectedLaunch
          ? `프로젝트 폴더에서 실행 명령을 자동 감지하고 PORT=${item.port}로 실행`
          : `등록된 ${item.terminalCommand ? '터미널 명령' : '실행 파일'} 실행 · PORT=${item.port}`;
      return (
        <div
          key={item.id}
          data-testid="sidebar-project-row"
          data-project-id={item.id}
          data-folder-path={item.folderPath}
          data-pinned-draggable={draggable ? '1' : undefined}
          // HTML5 드래그가 아니라 포인터 이벤트로 옮긴다 — 이유는 src/pinnedOrder.ts의
          // pinnedDropTargetAt 주석(앱 웹뷰가 네이티브 드래그를 전부 가로챈다).
          onPointerDown={draggable ? e => {
            if (e.button !== 0 || !e.isPrimary) return;
            // 행 안의 버튼(고정 해제·실행 등)을 누른 것은 드래그가 아니다.
            if ((e.target as HTMLElement | null)?.closest('button,input,a,select,textarea')) return;
            const container = e.currentTarget.parentElement;
            const rowEls = container ? Array.from(container.querySelectorAll<HTMLElement>('[data-pinned-draggable="1"]')) : [];
            const rows = rowEls
              .map(el => ({ id: el.dataset.projectId ?? '', rect: el.getBoundingClientRect() }))
              .filter(row => row.id)
              .map(row => ({ id: row.id, top: row.rect.top, bottom: row.rect.bottom }));
            if (rows.length < 2) return;
            pinnedDragRef.current = { id: item.id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, rows, active: false };
            // 포인터를 잡아둬야 다른 행 위로 나가도 move/up이 계속 이 행으로 온다.
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          } : undefined}
          onPointerMove={draggable ? e => {
            const drag = pinnedDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            if (!drag.active) {
              if (Math.abs(e.clientY - drag.startY) < PINNED_DRAG_THRESHOLD_PX && Math.abs(e.clientX - drag.startX) < PINNED_DRAG_THRESHOLD_PX) return;
              drag.active = true;
              setDraggingPinnedId(drag.id);
            }
            const target = pinnedDropTargetAt(drag.rows, e.clientY);
            setPinnedDropTargetId(target);
          } : undefined}
          onPointerUp={draggable ? e => {
            const drag = pinnedDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            const target = drag.active ? pinnedDropTargetAt(drag.rows, e.clientY) : null;
            pinnedDragConsumedClickRef.current = drag.active;
            if (target) dropPinnedOn(drag.id, target);
            else finishPinnedDrag();
          } : undefined}
          onPointerCancel={draggable ? () => { if (pinnedDragRef.current) finishPinnedDrag(); } : undefined}
          onClick={() => {
            if (pinnedDragConsumedClickRef.current) { pinnedDragConsumedClickRef.current = false; return; }
            setV4SelectedId(item.id);
          }}
          title={draggable ? '드래그해서 고정 순서 변경' : undefined}
          style={{
          display:'flex',alignItems:'center',gap:8,padding:'5px 14px',minHeight:38,
          cursor:draggable ? (dragging ? 'grabbing' : 'grab') : 'pointer',
          // 포인터 드래그 중 텍스트가 선택되면 행이 파랗게 물들어 드롭 표시가 안 보인다.
          userSelect:draggable ? ('none' as const) : undefined,
          touchAction:draggable ? ('none' as const) : undefined,
          fontFamily:monoFont,fontSize:12,
          background:active ? 'rgba(94,234,212,0.08)' : item.favorite ? 'rgba(94,234,212,0.025)' : 'transparent',
          borderLeft:`2px solid ${active || item.favorite ? '#5eead4' : 'transparent'}`,
          // 드롭 위치를 위쪽 선으로 표시한다. 행을 통째로 물들이면 어느 자리에 끼는지 안 보인다.
          borderTop:dropTarget ? '2px solid #5eead4' : '2px solid transparent',
          opacity:dragging ? 0.45 : 1,
          color:active ? '#f4f4f5' : '#a1a1aa',
          transition:'background .1s',
        }}>
          <span style={{fontSize:7,color:item.isRunning ? '#4ade80' : '#71717a',flexShrink:0}}>●</span>
          <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column',gap:1}}>
            <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}</span>
            {(item.aiName || item.category) && (
              <div style={{display:'flex',alignItems:'center',gap:4,overflow:'hidden'}}>
                {item.aiName && (
                  <span title={`프로젝트 별명: ${item.aiName}`} style={{fontSize:10,color:'#d8b4fe',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    별명 · {item.aiName}
                  </span>
                )}
                {item.category && (
                  <span title={`카테고리: ${item.category}`} style={{fontSize:9,padding:'0 4px',borderRadius:3,background:'rgba(94,234,212,0.08)',border:'1px solid rgba(94,234,212,0.16)',color:'#5eead4',whiteSpace:'nowrap',flexShrink:0}}>
                    {item.category}
                  </span>
                )}
              </div>
            )}
            {!item.isRunning && <span style={{fontSize:10,color:'#71717a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{formatLastRun(lastActivityFor(item.id))}</span>}
          </div>
          <button
            type="button"
            data-testid="sidebar-pin-project"
            data-project-id={item.id}
            aria-label={`${item.name} ${item.favorite ? '고정 해제' : '상단 고정'}`}
            title={item.favorite ? '사이드바 상단 고정 해제' : '사이드바 상단에 고정'}
            onClick={e => {
              e.stopPropagation();
              void toggleFavorite(item);
            }}
            style={{
              width:22,height:22,padding:0,borderRadius:4,flexShrink:0,
              display:'flex',alignItems:'center',justifyContent:'center',
              border:`1px solid ${item.favorite ? 'rgba(94,234,212,0.28)' : 'transparent'}`,
              background:item.favorite ? 'rgba(94,234,212,0.10)' : 'transparent',
              color:item.favorite ? '#5eead4' : '#52525b',
              cursor:'pointer',
            }}
          >
            <Pin style={{width:11,height:11,fill:item.favorite?'#5eead4':'none'}}/>
          </button>
          {item.port && (
            <div data-testid="sidebar-process-controls" style={{display:'flex',alignItems:'center',gap:3,flexShrink:0}}>
              <button
                type="button"
                data-testid="sidebar-run-stop"
                data-project-id={item.id}
                aria-label={`${item.name} ${item.isRunning ? '중지' : autoDetectedLaunch ? '자동 실행' : '실행'}`}
                title={launchTitle}
                onClick={e => {
                  e.stopPropagation();
                  void (item.isRunning ? stopCommand(item) : executeCommand(item));
                }}
                style={{
                  height:22,padding:'0 6px',borderRadius:4,flexShrink:0,
                  display:'inline-flex',alignItems:'center',gap:3,
                  border:`1px solid ${item.isRunning ? 'rgba(248,113,113,0.24)' : 'rgba(74,222,128,0.24)'}`,
                  background:item.isRunning ? 'rgba(248,113,113,0.08)' : 'rgba(74,222,128,0.08)',
                  color:item.isRunning ? '#f87171' : '#4ade80',cursor:'pointer',fontSize:9,fontFamily:'inherit',
                }}
              >
                {item.isRunning ? <Square style={{width:8,height:8}}/> : <Play style={{width:8,height:8}}/>}
                {item.isRunning ? '중지' : autoDetectedLaunch ? '자동' : '실행'}
              </button>
              <button
                type="button"
                data-testid="sidebar-open-localhost"
                data-project-id={item.id}
                disabled={!canOpenRegisteredPort(item)}
                aria-label={`${item.name} localhost:${item.port} 열기`}
                title={item.isRunning ? `localhost:${item.port} 열기` : `localhost:${item.port} 열기 · 현재 실행 상태 미감지`}
                onClick={e => {
                  e.stopPropagation();
                  if (canOpenRegisteredPort(item)) void openBrowserWithDiagnostics(item, `http://localhost:${item.port}`);
                }}
                style={{
                  width:22,height:22,padding:0,borderRadius:4,flexShrink:0,
                  display:'inline-flex',alignItems:'center',justifyContent:'center',
                  border:'1px solid rgba(56,189,248,0.18)',background:'rgba(56,189,248,0.05)',
                  color:item.isRunning ? '#7dd3fc' : '#3f3f46',
                  cursor:canOpenRegisteredPort(item) ? 'pointer' : 'not-allowed',opacity:canOpenRegisteredPort(item) ? 1 : 0.55,
                }}
              ><Globe style={{width:9,height:9}}/></button>
            </div>
          )}
          {item.port ? <span style={{color:'#5eead4',fontSize:11,flexShrink:0}}>:{item.port}</span> : <span style={{color:'#3f3f46',fontSize:11,flexShrink:0}}>—</span>}
        </div>
      );
    };

    // 고정은 사용자의 전역 수동 순서, 실행 중은 즉시성이 우선이다. 루트별 묶음은 탐색이
    // 목적인 유휴 시간대 안에서만 쓰며, 실제로 둘 이상의 루트가 보일 때만 구분자를 그린다.
    const renderIdleRowsByWorkspaceRoot = (items: PortInfo[]) => {
      const groups = groupProjectsByWorkspaceRoot(items, workspaceRoots);
      const showDividers = groups.length > 1;
      return groups.map(group => (
        <React.Fragment key={group.root?.id ?? 'unassigned'}>
          {showDividers && (
            <div
              data-testid="sidebar-workspace-root-divider"
              data-root-id={group.root?.id ?? 'unassigned'}
              title={group.root?.path ?? '등록된 작업 루트 밖의 프로젝트'}
              style={{display:'flex',alignItems:'center',gap:6,padding:'7px 14px 2px 24px',minWidth:0}}
            >
              <Folder style={{width:9,height:9,color:'#52525b',flexShrink:0}} />
              <span style={{maxWidth:'70%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:9.5,fontFamily:monoFont,color:'#8b8b95',letterSpacing:0.2}}>
                {group.root?.name ?? '기타 위치'} · {group.items.length}
              </span>
              <span aria-hidden="true" style={{height:1,flex:1,background:'rgba(255,255,255,0.055)'}} />
            </div>
          )}
          {group.items.map(item => renderRow(item))}
        </React.Fragment>
      ));
    };

    return (
      <div style={{flex:1,display:'flex',overflow:'hidden'}}>
        {/* 좌측 목록 패널 — 모바일에선 선택 항목이 있으면 숨기고 전체 너비로 전환 */}
        <div style={{
          width: isMobile ? '100%' : 300,
          flexShrink: 0,
          borderRight: isMobile ? 'none' : '1px solid rgba(255,255,255,0.07)',
          display: (isMobile && sel) ? 'none' : 'flex',
          flexDirection: 'column',
          background: '#111113',
        }}>
          {/* 섹션 필터 칩 + 빠른 추가 */}
          <div style={{padding:'8px 10px 0',display:'flex',gap:3,flexWrap:'wrap' as const,alignItems:'center',borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
            {([
              ['all',    t(lang,'filterAll'),       v3SectionCounts.all],
              ['running',t(lang,'filterRunning'),   v3SectionCounts.running],
              ['starred',t(lang,'filterStarred'),   v3SectionCounts.starred],
              ['wt',     t(lang,'filterWorktrees'), v3SectionCounts.worktrees],
            ] as [string,string,number][])
              .filter(([id]) => id !== 'wt' || shouldShowWorktreeSection(v3SectionCounts.worktrees, sidebarSection))
              .map(([id,label,count])=>(
              <button key={id} onClick={()=>setSidebarSection(id)} title={id==='wt' ? '한 번 이상 실행해 프로젝트 목록에 등록된 워크트리 · 전체 Git 워크트리 수와는 다릅니다' : undefined} style={{
                padding:'2px 7px',borderRadius:4,fontSize:11,cursor:'pointer',
                fontFamily:'Inter Tight, system-ui, sans-serif',
                background:sidebarSection===id?'rgba(94,234,212,0.12)':'transparent',
                color:sidebarSection===id?'#5eead4':'#71717a',
                border:`1px solid ${sidebarSection===id?'rgba(94,234,212,0.25)':'transparent'}`,
                display:'flex',alignItems:'center',gap:3,
              }}>
                {label}
                <span style={{fontSize:9.5,fontFamily:'JetBrains Mono, monospace',opacity:0.7}}>{count}</span>
              </button>
            ))}
          </div>
          <div style={{padding:'8px 12px 10px',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
            <div style={{position:'relative'}}>
              <Search style={{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',width:12,height:12,color:'#71717a'}} />
              <input
                data-testid="project-search-input"
                value={searchQuery}
                onChange={e=>setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape' && searchQuery) {
                    e.preventDefault();
                    setSearchQuery('');
                  }
                }}
                placeholder={t(lang,'jumpToProject')}
                aria-label={t(lang,'jumpToProject')}
                style={{
                width:'100%',padding:'6px 30px 6px 28px',background:'#0a0a0b',
                border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,
                color:'#f4f4f5',fontSize:12,fontFamily:monoFont,boxSizing:'border-box' as const,
              }}/>
              {searchQuery && (
                <button
                  type="button"
                  data-testid="clear-project-search"
                  aria-label={lang === 'ko' ? '검색어 지우기' : 'Clear search'}
                  title={lang === 'ko' ? '검색어 지우기 (Esc)' : 'Clear search (Esc)'}
                  onClick={() => setSearchQuery('')}
                  style={{
                    position:'absolute',right:5,top:'50%',transform:'translateY(-50%)',
                    width:20,height:20,padding:0,borderRadius:4,
                    display:'flex',alignItems:'center',justifyContent:'center',
                    border:'none',background:'rgba(255,255,255,0.06)',color:'#a1a1aa',
                    cursor:'pointer',
                  }}
                >
                  <XIcon style={{width:11,height:11}}/>
                </button>
              )}
            </div>
          </div>
          {v3IdleStale.length > 0 && (
            <div
              data-testid="stale-projects-review-bar"
              style={{
                display:'flex',alignItems:'center',gap:6,padding:'6px 10px',
                borderBottom:'1px solid rgba(248,113,113,0.18)',
                background:'rgba(127,29,29,0.08)',
              }}
            >
              <span style={{width:5,height:5,borderRadius:3,background:'#f87171',display:'inline-block',flexShrink:0}} />
              <span style={{flex:1,minWidth:0,color:'#fca5a5',fontSize:9.5,fontFamily:monoFont,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                오래된 프로젝트 {v3IdleStale.length}개
              </span>
              <button
                type="button"
                data-testid="open-cleanup-review"
                onClick={() => setShowCleanupReview(true)}
                title="오래된 프로젝트를 검토하고 즐겨찾기 또는 삭제를 선택합니다"
                style={{padding:'2px 7px',background:'rgba(248,113,113,0.14)',border:'1px solid rgba(248,113,113,0.34)',borderRadius:4,color:'#fca5a5',cursor:'pointer',fontSize:9.5,fontFamily:'Inter Tight, system-ui, sans-serif',whiteSpace:'nowrap'}}
              >정리 검토
              </button>
            </div>
          )}
          {(() => {
            const tags = [...new Set(ports.map((p:PortInfo)=>p.category).filter(Boolean) as string[])]
              .sort((a,b) => ports.filter((p:PortInfo)=>p.category===b).length - ports.filter((p:PortInfo)=>p.category===a).length);
            if (!tags.length) return null;
            const activeTag = sidebarSection.startsWith('tag:') ? sidebarSection.slice(4) : null;
            const isOpen = tagsPanelOpen || !!activeTag;
            return (
              <div style={{borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                <button onClick={()=>setTagsPanelOpen(v=>!v)} style={{
                  width:'100%',padding:'7px 10px',display:'flex',alignItems:'center',gap:6,
                  background:'transparent',border:'none',cursor:'pointer',
                  fontFamily:'Inter Tight, system-ui, sans-serif',fontSize:11,color:'#71717a',
                }}>
                  {isOpen ? <ChevronUp style={{width:11,height:11,flexShrink:0}}/> : <ChevronDown style={{width:11,height:11,flexShrink:0}}/>}
                  <span style={{flex:1,textAlign:'left' as const}}>{t(lang,'sectionTags')} · {tags.length}</span>
                  {!isOpen && activeTag && <span style={{
                    fontSize:10.5,color:'#5eead4',fontFamily:'JetBrains Mono, monospace',
                    padding:'1px 6px',borderRadius:4,border:'1px solid rgba(94,234,212,0.25)',background:'rgba(94,234,212,0.12)',
                  }}>{activeTag}</span>}
                </button>
                {isOpen && (
                  <div style={{padding:'0 10px 8px',display:'flex',gap:4,flexWrap:'wrap' as const}}>
                    {tags.map(tag => {
                      const n = ports.filter((p:PortInfo)=>p.category===tag).length;
                      const active = sidebarSection === `tag:${tag}`;
                      return (
                        <button key={tag} onClick={()=>setSidebarSection(active ? 'all' : `tag:${tag}`)} title={`카테고리: ${tag}`} style={{
                          padding:'2px 7px',borderRadius:4,fontSize:10.5,cursor:'pointer',
                          fontFamily:'Inter Tight, system-ui, sans-serif',
                          background:active?'rgba(94,234,212,0.12)':'transparent',
                          color:active?'#5eead4':'#71717a',
                          border:`1px solid ${active?'rgba(94,234,212,0.25)':'rgba(255,255,255,0.07)'}`,
                          display:'flex',alignItems:'center',gap:3,
                        }}>
                          {tag}
                          <span style={{fontSize:9,fontFamily:'JetBrains Mono, monospace',opacity:0.7}}>{n}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          <div style={{flex:1,overflowY:'auto'}}>
            {v3Pinned.length > 0 && <>
              <div data-testid="sidebar-pinned-group" style={{padding:'8px 14px 4px',fontSize:10,fontFamily:monoFont,color:'#5eead4',textTransform:'uppercase' as const,letterSpacing:0.5,display:'flex',alignItems:'center',gap:5}}>
                <Pin style={{width:10,height:10,fill:'#5eead4'}}/>
                고정 · {v3Pinned.length}
                {v3Pinned.length > 1 && (
                  <span style={{color:'#52525b',textTransform:'none' as const,letterSpacing:0}}>드래그로 순서 변경</span>
                )}
              </div>
              {v3Pinned.map(item => renderRow(item, true))}
            </>}
            {v3Running.length > 0 && <>
              <div style={{padding:'8px 14px 4px',fontSize:10,fontFamily:monoFont,color:'#71717a',textTransform:'uppercase' as const,letterSpacing:0.5,display:'flex',alignItems:'center',gap:5}}>
                <span style={{width:5,height:5,borderRadius:3,background:'#4ade80',display:'inline-block'}}/>
                {t(lang,'labelRunning')} · {v3Running.length}
              </div>
              {v3Running.map(item => renderRow(item))}
            </>}
            {v3Idle.length > 0 && <>
              <div style={{padding:'8px 14px 4px',fontSize:10,fontFamily:monoFont,color:'#71717a',textTransform:'uppercase' as const,letterSpacing:0.5,display:'flex',alignItems:'center',gap:5}}>
                <span style={{width:5,height:5,borderRadius:3,background:'#3f3f46',display:'inline-block'}}/>
                {t(lang,'labelIdle')} · {v3Idle.length}
              </div>
              {v3IdleRecent.length > 0 && <>
                <div style={{padding:'6px 14px 2px',fontSize:9.5,fontFamily:monoFont,color:'#71717a',letterSpacing:0.3}}>
                  최근 사용 (7일 이내) · {v3IdleRecent.length}
                </div>
                {renderIdleRowsByWorkspaceRoot(v3IdleRecent)}
              </>}
              {v3IdleAging.length > 0 && <>
                <div style={{padding:'6px 14px 2px',fontSize:9.5,fontFamily:monoFont,color:'#71717a',letterSpacing:0.3}}>
                  가끔 사용 (7~30일) · {v3IdleAging.length}
                </div>
                {renderIdleRowsByWorkspaceRoot(v3IdleAging)}
              </>}
              {v3IdleStale.length > 0 && <>
                <div style={{padding:'6px 14px 2px',fontSize:9.5,fontFamily:monoFont,color:'#f87171',letterSpacing:0.3}}>
                  <span>오래됨 ({staleDays}일+/기록 없음) · {v3IdleStale.length}</span>
                </div>
                {renderIdleRowsByWorkspaceRoot(v3IdleStale)}
              </>}
            </>}
            {v3Ports.length === 0 && (
              <div style={{padding:'40px 0',textAlign:'center',color:'#3f3f46',fontSize:12,fontFamily:monoFont}}>{t(lang,'noProjects')}</div>
            )}
          </div>

          {/* Workspace Roots — 터미널형 */}
          {!isDeployedWeb() && <div style={{marginTop:'auto',borderTop:'1px solid rgba(255,255,255,0.07)'}}>
            <button
              onClick={() => setWorkspaceRootsOpen(v => !v)}
              style={{display:'flex',alignItems:'center',gap:6,width:'100%',padding:'8px 12px',background:'transparent',border:'none',cursor:'pointer',color:'#71717a'}}
            >
              {workspaceRootsOpen
                ? <ChevronDown style={{width:11,height:11}}/>
                : <ChevronDown style={{width:11,height:11,transform:'rotate(-90deg)'}}/>}
              <span style={{fontSize:10,fontFamily:monoFont,textTransform:'uppercase' as const,letterSpacing:0.5,flex:1,textAlign:'left' as const}}>작업 루트</span>
              {workspaceRoots.length > 0 && (
                <span style={{fontSize:9,fontFamily:monoFont,color:'#71717a',background:'rgba(255,255,255,0.06)',padding:'1px 5px',borderRadius:3}}>
                  {workspaceRoots.length}
                </span>
              )}
            </button>
            {workspaceRootsOpen && (
              <div style={{paddingBottom:8}}>
                {workspaceRoots.map((root: WorkspaceRoot, rootIndex: number) => {
                  const projectCount = workspaceRootProjectCounts.get(root.id) ?? 0;
                  return (
                    <div key={root.id} style={{display:'flex',alignItems:'center',gap:4,padding:'3px 8px 3px 20px'}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontFamily:monoFont,color:'#d4d4d8',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>{root.name}</div>
                        <div style={{fontSize:9.5,fontFamily:monoFont,color:'#71717a',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>{root.path}</div>
                      </div>
                      {projectCount > 0 && (
                        <span style={{fontSize:9,fontFamily:monoFont,color:'#71717a',background:'rgba(255,255,255,0.06)',padding:'1px 4px',borderRadius:3,flexShrink:0}}>{projectCount}</span>
                      )}
                      <div style={{display:'flex',flexDirection:'column',gap:1,flexShrink:0}}>
                        <button
                          type="button"
                          data-testid={`workspace-root-move-up-${root.id}`}
                          disabled={rootIndex === 0}
                          onClick={() => moveWorkspaceRoot(root.id, -1)}
                          title="위로 이동"
                          style={{padding:0,width:14,height:10,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'none',color:'#71717a',cursor:rootIndex===0?'not-allowed':'pointer',opacity:rootIndex===0?0.25:1}}
                        ><ChevronUp style={{width:9,height:9}}/></button>
                        <button
                          type="button"
                          data-testid={`workspace-root-move-down-${root.id}`}
                          disabled={rootIndex === workspaceRoots.length - 1}
                          onClick={() => moveWorkspaceRoot(root.id, 1)}
                          title="아래로 이동"
                          style={{padding:0,width:14,height:10,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'none',color:'#71717a',cursor:rootIndex===workspaceRoots.length-1?'not-allowed':'pointer',opacity:rootIndex===workspaceRoots.length-1?0.25:1}}
                        ><ChevronDown style={{width:9,height:9}}/></button>
                      </div>
                      <button
                        onClick={() => { setActiveRootId(root.id); setShowNewProjectModal(true); }}
                        title="새 프로젝트 폴더"
                        style={{padding:'2px 6px',background:'rgba(94,234,212,0.1)',border:'1px solid rgba(94,234,212,0.2)',borderRadius:4,color:'#5eead4',cursor:'pointer',fontSize:10,fontFamily:'Inter Tight, system-ui, sans-serif',flexShrink:0}}
                      >새 폴더</button>
                      <button
                        onClick={() => setDeleteRootConfirmId(root.id)}
                        title="루트 제거"
                        style={{padding:'2px 4px',background:'transparent',border:'none',color:'#71717a',cursor:'pointer',display:'flex',alignItems:'center',flexShrink:0}}
                      ><XIcon style={{width:10,height:10}}/></button>
                    </div>
                  );
                })}
                <div style={{ margin: '5px 8px 0 20px' }}>
                  <FolderDropZone
                    compact
                    testId="workspace-root-dropzone-terminal"
                    label="폴더를 드래그해 루트 추가"
                    hint="또는 클릭"
                    onChoose={handleAddWorkspaceRoot}
                    onFolderPath={addWorkspaceRootFromPath}
                    onError={message => showToast(message, 'error')}
                  />
                </div>
              </div>
            )}
          </div>}
        </div>

        {/* 우측 상세 패널 — 모바일에선 선택이 없으면 렌더 자체를 생략 */}
        {(!isMobile || sel) && (sel ? (
          editingId === sel.id ? (
            /* 수정 폼 */
            <div style={{flex:1,overflowY:'auto',padding:'28px 32px',display:'flex',flexDirection:'column',gap:6}}>
              <div style={{fontSize:12,color:'#a1a1aa',marginBottom:4}}>수정: {sel.name}</div>
              <div style={{display:'flex',gap:6}}>
                <input type="text" value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={handleEditKeyPress} style={{...inpV3,flex:1}} placeholder="프로젝트 이름" autoFocus />
                <input type="number" value={editPort} onChange={e=>setEditPort(e.target.value)} onKeyDown={handleEditKeyPress} style={{...inpV3,width:70,flex:'none'}} placeholder="포트" />
                <button type="button" onClick={()=>suggestPort(setEditPort)} title="빈 포트 추천 (9000번대)" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:11,whiteSpace:'nowrap' as const}}>추천</button>
                <button onClick={saveEdit} style={{padding:'5px 8px',background:'rgba(74,222,128,0.14)',border:'1px solid rgba(74,222,128,0.3)',borderRadius:6,cursor:'pointer',display:'flex',alignItems:'center'}}><Check className="w-3.5 h-3.5" style={{color:'#4ade80'}}/></button>
                <button onClick={cancelEdit} style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:6,cursor:'pointer',display:'flex',alignItems:'center'}}><XIcon className="w-3.5 h-3.5" style={{color:'#71717a'}}/></button>
              </div>
              <FolderDropZone
                compact
                pathKind="file"
                testId="edit-command-file-field"
                value={editCommandPath}
                onValueChange={setEditCommandPath}
                onInputKeyDown={handleEditKeyPress}
                prefixLabel="실행 파일"
                placeholder={`${execFileExt()} 실행 파일 · 드래그 또는 선택`}
                label="실행 파일을 여기에 드래그"
                hint="파일 선택"
                onChoose={handlePickCommandFile}
                onFolderPath={handleDropCommandFile}
                onError={message => showToast(message, 'error')}
              />
              <input type="text" value={editTerminalCommand} onChange={e=>setEditTerminalCommand(e.target.value)} onKeyDown={handleEditKeyPress} style={inpV3} placeholder="터미널 명령어" />
              <FolderDropZone
                compact
                testId="edit-folder-field-detail"
                value={editFolderPath}
                onValueChange={setEditFolderPath}
                onInputKeyDown={handleEditKeyPress}
                prefixLabel="프로젝트 폴더"
                placeholder="프로젝트 폴더 · 드래그 또는 선택"
                label="프로젝트 폴더를 여기에 드래그"
                hint="폴더 선택"
                onChoose={handlePickEditFolder}
                onFolderPath={handleDropEditFolder}
                onError={message => showToast(message, 'error')}
              />
              <FolderDropZone
                compact
                pathKind="file"
                testId="edit-manual-file-field-detail"
                value={editManualPath}
                onValueChange={setEditManualPath}
                onInputKeyDown={handleEditKeyPress}
                prefixLabel="매뉴얼"
                placeholder="매뉴얼 파일 (PDF·HWP·DOCX·MD·HTML 등) · 드래그 또는 선택"
                label="매뉴얼 파일을 여기에 드래그"
                hint="파일 선택"
                onChoose={() => handlePickProjectDocument('manual')}
                onFolderPath={path => handleDropProjectDocument('manual', path)}
                onError={message => showToast(message, 'error')}
              />
              <FolderDropZone
                compact
                pathKind="file"
                testId="edit-log-file-field-detail"
                value={editLogFilePath}
                onValueChange={setEditLogFilePath}
                onInputKeyDown={handleEditKeyPress}
                prefixLabel="로그 관리"
                placeholder="로그 관리 파일 (XLSX·CSV·LOG·MD 등) · 드래그 또는 선택"
                label="로그 관리 파일을 여기에 드래그"
                hint="파일 선택"
                onChoose={() => handlePickProjectDocument('log')}
                onFolderPath={path => handleDropProjectDocument('log', path)}
                onError={message => showToast(message, 'error')}
              />
              <input type="text" value={editDeployUrl} onChange={e=>setEditDeployUrl(e.target.value)} onKeyDown={handleEditKeyPress} style={inpV3} placeholder="배포 주소" />
              <div style={{display:'flex',gap:6,alignItems:'stretch'}}>
                <GitHubUrlInputs
                  value={editGithubUrl}
                  onChange={setEditGithubUrl}
                  onOpen={url => { void openGitHubWithDiagnostics(sel, url); }}
                  onKeyDown={handleEditKeyPress}
                  inputStyle={inpV3}
                />
                <button
                  type="button"
                  data-testid="edit-detect-github-detail"
                  disabled={!editFolderPath.trim() || editGithubDetecting}
                  onClick={handleDetectEditGithubUrl}
                  title="프로젝트 폴더에 연결된 GitHub 원격 저장소 감지"
                  style={{padding:'0 9px',background:'rgba(96,165,250,0.08)',border:'1px solid rgba(96,165,250,0.22)',borderRadius:6,color:'#93c5fd',cursor:(!editFolderPath.trim()||editGithubDetecting)?'not-allowed':'pointer',fontSize:10,fontFamily:'inherit',whiteSpace:'nowrap',opacity:(!editFolderPath.trim()||editGithubDetecting)?0.5:1}}
                >
                  {editGithubDetecting ? '감지 중…' : 'GitHub 감지'}
                </button>
              </div>
              {renderEditAiClassification('detail')}
              <input type="text" value={editDescription} onChange={e=>setEditDescription(e.target.value)} onKeyDown={handleEditKeyPress} style={inpV3} placeholder="프로젝트 설명" />
              <Suspense fallback={null}>
                <ProjectMemoryPanel
                  folderPath={editFolderPath}
                  projectName={editName}
                  githubUrl={primaryGitHubRepositoryUrl({ githubUrl: editGithubUrl })}
                  onToast={showToast}
                />
              </Suspense>
            </div>
          ) : (
          <div style={{flex:1,overflowY:'auto',padding:'28px 32px'}}>
            {/* 헤더 — flexWrap으로 좁은 화면에서 줄바꿈, 수정/삭제 버튼은 항상 텍스트로 노출 */}
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6,flexWrap:'wrap' as const}}>
              {isMobile && (
                <button
                  onClick={() => setV4SelectedId(null)}
                  style={{padding:'6px 10px',background:'transparent',border:'1px solid rgba(255,255,255,0.12)',borderRadius:6,cursor:'pointer',color:'#a1a1aa',fontSize:13,display:'flex',alignItems:'center',gap:4}}
                  title="목록으로"
                >← 목록</button>
              )}
              <span style={{width:8,height:8,borderRadius:4,background:sel.isRunning?'#4ade80':'#71717a',flexShrink:0}}/>
              <h2 style={{margin:0,fontSize:isMobile?17:20,fontWeight:600,letterSpacing:-0.3,color:'#f4f4f5',wordBreak:'break-word' as const,minWidth:0,flexShrink:1}}>{sel.name}</h2>
              {sel.port && <span style={{fontSize:15,fontFamily:monoFont,color:'#5eead4'}}>:{sel.port}</span>}
              {sel.favorite && <Pin style={{width:13,height:13,color:'#5eead4',fill:'#5eead4'}}/>}
              <div style={{marginLeft:'auto',display:'flex',gap:6,flexShrink:0}}>
                {sel.folderPath && (
                  <button
                    type="button"
                    data-testid="detail-folder-rename-prompt"
                    onClick={() => { void copyProjectFolderRenamePrompt(sel); }}
                    style={{
                      padding: isMobile?'8px 14px':'6px 12px',
                      background:'rgba(94,234,212,0.06)',border:'1px solid rgba(94,234,212,0.22)',borderRadius:6,
                      cursor:'pointer',color:'#99f6e4',fontSize:isMobile?14:12,fontWeight:500,
                      display:'flex',alignItems:'center',gap:5,
                    }}
                    title={`${sel.name} 프로젝트의 안전한 폴더명 변경 프롬프트 복사`}
                  >
                    <Copy style={{width:13,height:13}}/>폴더명 변경
                  </button>
                )}
                <button
                  data-testid="detail-edit-project"
                  onClick={() => startEdit(sel)}
                  style={{
                    padding: isMobile?'8px 14px':'6px 12px',
                    background:'rgba(94,234,212,0.10)',border:'1px solid rgba(94,234,212,0.3)',borderRadius:6,
                    cursor:'pointer',color:'#5eead4',fontSize:isMobile?14:12,fontWeight:500,
                    display:'flex',alignItems:'center',gap:5,
                  }}
                  title="수정"
                >
                  <Pencil style={{width:13,height:13}}/>수정
                </button>
                <button
                  onClick={() => setDeleteConfirmId(sel.id)}
                  style={{
                    padding: isMobile?'8px 14px':'6px 12px',
                    background:'transparent',border:'1px solid rgba(248,113,113,0.3)',borderRadius:6,
                    cursor:'pointer',color:'#f87171',fontSize:isMobile?14:12,fontWeight:500,
                    display:'flex',alignItems:'center',gap:5,
                  }}
                  title="삭제"
                >
                  <Trash2 style={{width:13,height:13}}/>삭제
                </button>
              </div>
            </div>

            {/* 메타 정보 */}
            <div style={{display:'flex',flexDirection:'column',gap:5,marginBottom:24,fontSize:12,fontFamily:monoFont}}>
              <div style={{display:'flex',gap:10,alignItems:'center'}}>
                <span style={{color:'#3f3f46',minWidth:104,flexShrink:0}}>로컬프로젝트해시</span>
                <span
                  style={{color:'#a1a1aa',letterSpacing:0.5,flex:1}}
                  title={[
                    '이 기기의 프로젝트 등록 행 id에서 나온 값입니다.',
                    '이름을 바꿔도 이 기기 안에서는 고정이라, 다른 폴더의 노트나 대화에서 이 프로젝트를 가리킬 때 붙여넣습니다.',
                    '기기 간 공통 신원은 아닙니다 — 같은 저장소라도 다른 기기에서는 다른 값이 나옵니다. 그쪽은 GitHub 주소가 담당합니다.',
                  ].join('\n')}
                >{projectCode(sel.id)}</span>
                <button
                  type="button"
                  data-testid="meta-copy-project-code"
                  onClick={() => {
                    void navigator.clipboard.writeText(projectCode(sel.id))
                      .then(() => showToast(`로컬프로젝트해시 "${projectCode(sel.id)}"를 복사했습니다.`, 'success'))
                      .catch((e: unknown) => showToast(`복사 실패: ${e instanceof Error ? e.message : String(e)}`, 'error'));
                  }}
                  title="로컬프로젝트해시 복사 — 이 기기에서 다른 폴더의 노트·대화가 이 프로젝트를 참조할 때 사용"
                  style={{padding:'2px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}
                >
                  <Copy style={{width:10,height:10}}/>해시 복사
                </button>
                <button
                  type="button"
                  data-testid="meta-copy-project-name-code"
                  onClick={() => {
                    const identity = projectIdentityClipboard(sel.name, sel.id);
                    void navigator.clipboard.writeText(identity)
                      .then(() => showToast('#프로젝트명 + 로컬프로젝트해시를 복사했습니다.', 'success'))
                      .catch((e: unknown) => showToast(`복사 실패: ${e instanceof Error ? e.message : String(e)}`, 'error'));
                  }}
                  title="첫 줄의 #프로젝트명은 Telegram Bot이 바로 인식합니다. 로컬프로젝트해시는 이 기기의 보조 식별값이며 라우팅에는 필수가 아닙니다."
                  style={{padding:'2px 7px',background:'rgba(94,234,212,0.06)',border:'1px solid rgba(94,234,212,0.24)',borderRadius:4,color:'#5eead4',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}
                >
                  <Copy style={{width:10,height:10}}/>#프로젝트명 + 해시 복사
                </button>
              </div>
              {sel.folderPath && (
                <MetaEditableRow
                  testId="meta-row-folder"
                  label="folder"
                  value={sel.folderPath}
                  onEdit={() => startEdit(sel)}
                  action={(
                    <button type="button" data-testid="meta-open-folder" onClick={event => { event.stopPropagation(); API.openFolder(sel.folderPath!).catch(e=>showToast(`폴더 열기 실패: ${e.message}`, 'error')); }} style={{padding:'2px 7px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:4,color:'#a1a1aa',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}><FolderOpen style={{width:10,height:10}}/>폴더 열기</button>
                  )}
                />
              )}
              {sel.commandPath && (
                <MetaEditableRow
                  testId="meta-row-command"
                  label="command"
                  value={sel.commandPath}
                  onEdit={() => startEdit(sel)}
                />
              )}
              {sel.terminalCommand && (
                <MetaEditableRow
                  testId="meta-row-terminal"
                  label="terminal"
                  value={sel.terminalCommand}
                  onEdit={() => startEdit(sel)}
                />
              )}
              {sel.manualPath && (
                <MetaEditableRow
                  testId="meta-row-manual"
                  label="manual"
                  value={sel.manualPath}
                  onEdit={() => startEdit(sel)}
                action={<button type="button" data-testid="meta-open-manual" onClick={event => { event.stopPropagation(); API.openFolder(sel.manualPath!).catch(e=>showToast(`매뉴얼 열기 실패: ${e.message}`, 'error')); }} style={{padding:'2px 7px',background:'rgba(200,168,240,0.05)',border:'1px solid rgba(200,168,240,0.18)',borderRadius:4,color:'#d8b4fe',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}><BookOpen style={{width:10,height:10}}/>매뉴얼 열기</button>}
                />
              )}
              {sel.logFilePath && (
                <MetaEditableRow
                  testId="meta-row-log-file"
                  label="log file"
                  value={sel.logFilePath}
                  onEdit={() => startEdit(sel)}
                action={<button type="button" data-testid="meta-open-log-manager" onClick={event => { event.stopPropagation(); API.openFolder(sel.logFilePath!).catch(e=>showToast(`로그 관리 파일 열기 실패: ${e.message}`, 'error')); }} style={{padding:'2px 7px',background:'rgba(251,191,36,0.05)',border:'1px solid rgba(251,191,36,0.18)',borderRadius:4,color:'#fbbf24',cursor:'pointer',fontSize:10,fontFamily:'inherit',display:'flex',alignItems:'center',gap:3,whiteSpace:'nowrap',flexShrink:0}}><FileText style={{width:10,height:10}}/>로그 관리 열기</button>}
                />
              )}
              <InlineUrlRow label="deploy" value={sel.deployUrl} onSave={(v) => saveInlineUrl(sel.id, 'deployUrl', v)} placeholder="배포 주소 입력" mobile={isMobile} actionLabel="배포 열기" actionIcon={<Globe style={{width:10,height:10}}/>} actionTestId="meta-open-deploy" onAction={() => { void openDeploymentWithDiagnostics(sel); }} />
              <GitHubUrlsRow
                value={githubRepositoryUrlsText(sel)}
                onSave={value => saveGitHubUrls(sel.id, value)}
                mobile={isMobile}
                onOpen={url => { void openGitHubWithDiagnostics(sel, url); }}
              />
              {sel.folderPath && githubRepositoryUrls(sel).length === 0 && (
                <GitHubRepositoryCreateControl
                  project={sel}
                  mobile={isMobile}
                  onCreated={url => setPorts(current => current.map(project => (
                    project.id === sel.id ? { ...project, ...githubRepositoryUrlFields([url]) } : project
                  )))}
                  onToast={(message, type) => showToast(message, type)}
                />
              )}
              <InlineUrlRow label="메모" value={sel.description} onSave={(v) => saveInlineUrl(sel.id, 'description', v)} placeholder="이 프로젝트가 뭔지 메모 (나중에 헷갈리지 않도록)" mobile={isMobile} />
              <InlineUrlRow label="프로젝트 별명" value={sel.aiName} onSave={(v) => saveInlineUrl(sel.id, 'aiName', v)} placeholder="AI 추천 별칭 입력" mobile={isMobile} />
              <InlineUrlRow label="카테고리" value={sel.category} onSave={(v) => saveInlineUrl(sel.id, 'category', v)} placeholder="카테고리 입력" mobile={isMobile} />
            </div>

            {/* 실행 제어 — 프로세스 시작/중지와 localhost 접속은 서로 다른 동작이다. */}
            <div style={{display:'flex',gap:6,flexWrap:'wrap' as const,marginBottom:8}}>
              <button data-testid="project-run-stop" onClick={() => sel.isRunning ? stopCommand(sel) : executeCommand(sel)} style={{
                ...rowBtn,
                background:sel.isRunning ? 'rgba(248,113,113,0.14)' : 'rgba(74,222,128,0.14)',
                color:sel.isRunning ? '#f87171' : '#4ade80',
                border:'none',fontWeight:600,padding:'6px 14px',
              }}>
                {sel.isRunning
                  ? <><Square style={{width:10,height:10}}/>프로세스 중지{sel.port ? ` · :${sel.port}` : ''}</>
                  : <><Play style={{width:10,height:10}}/>{shouldAutoDetectProjectStart(sel) ? '자동 실행' : '등록 명령 실행'}{sel.port ? ` · :${sel.port}` : ''}</>}
              </button>
              <button data-testid="project-force-restart" onClick={() => forceRestartCommand(sel)} style={rowBtn} title="프로세스 강제 종료 후 재실행">
                <RotateCw style={{width:11,height:11}}/>강제 재실행
              </button>
              <button data-help-key="card-worktree" aria-label="워크트리" aria-pressed={expandedWorktreeIds.has(sel.id)} onClick={() => toggleWorktreePanel(sel.id, sel.folderPath)} style={{...rowBtn,color:expandedWorktreeIds.has(sel.id)?'#5eead4':'#a1a1aa',borderColor:expandedWorktreeIds.has(sel.id)?'rgba(94,234,212,0.3)':'rgba(255,255,255,0.1)'}} title="워크트리 관리">
                <GitBranch style={{width:11,height:11}}/>워크트리
              </button>
            </div>

            {/* 실행 결과 미리보기 — AI 실행/독립 앱 열기와 목적을 분리 */}
            <div data-testid="local-preview-panel" style={{marginBottom:8,padding:'8px 10px',borderRadius:7,background:'rgba(56,189,248,0.035)',border:'1px solid rgba(56,189,248,0.12)'}}>
              <div style={{fontSize:10,color:'#7dd3fc',fontWeight:600,marginBottom:2}}>로컬 미리보기</div>
              <div style={{fontSize:9,color:'#52525b',marginBottom:6}}>
                {sel.port
                  ? (sel.isRunning ? '실행 중인 localhost를 어느 브라우저에서 볼지 선택' : '등록된 localhost를 열 수 있습니다 · 현재 실행 상태는 감지되지 않음')
                  : '이 프로젝트에는 포트가 없습니다'}
              </div>
              {/* 미리보기 버튼 셋이 모두 `sel.port &&` 로 묶여 있어, 포트 없는 프로젝트에서는
                  제목과 설명만 남고 버튼이 하나도 없는 **빈 상자**가 됐다. 이 앱은 폴더 전용
                  프로젝트를 정식으로 지원하므로(`port?: number`) 그쪽이 오히려 다수다 —
                  실측 13개 중 12개. 빈 상자는 "기능이 사라졌다"로 읽히므로(VOC 접수),
                  없는 이유와 되살리는 방법을 대신 적는다. */}
              {!sel.port && (
                <div data-testid="local-preview-no-port" style={{fontSize:9.5,color:'#71717a',lineHeight:1.6}}>
                  아래 버튼들은 <code style={{color:'#a1a1aa'}}>localhost:포트</code>를 여는 기능이라 포트가 있어야 동작합니다.
                  <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:5}}>
                    <button data-testid="local-preview-auto-port" onClick={() => void assignLocalPreviewPort(sel)} style={{...rowBtn,color:'#5eead4',borderColor:'rgba(94,234,212,0.28)',background:'rgba(94,234,212,0.07)'}}>
                      빈 포트 자동 설정
                    </button>
                    <button data-testid="local-preview-edit-port" onClick={() => startEdit(sel)} style={rowBtn}>
                      수정에서 직접 입력
                    </button>
                  </div>
                </div>
              )}
              <div style={{display:'flex',gap:6,flexWrap:'wrap' as const}}>
                <button data-testid="detail-browser-localhost" disabled={!canOpenRegisteredPort(sel)} onClick={() => { if (canOpenRegisteredPort(sel)) void openBrowserWithDiagnostics(sel, `http://localhost:${sel.port}`); }} style={{...rowBtn,...(!canOpenRegisteredPort(sel)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!sel.port?'프로젝트 수정에서 포트를 먼저 설정하세요':sel.isRunning?`기본 브라우저로 localhost:${sel.port} 열기`:`기본 브라우저로 localhost:${sel.port} 열기 · 현재 실행 상태 미감지`}><Laptop style={{width:11,height:11}}/>기본 브라우저</button>
                {!isWindows() && <button data-testid="detail-cmux-localhost" disabled={!canOpenRegisteredPort(sel)} onClick={() => { if (canOpenRegisteredPort(sel)) openCmuxLocalhost(sel); }} style={{...rowBtn,color:'#2dd4bf',borderColor:'rgba(45,212,191,0.2)',...(!canOpenRegisteredPort(sel)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!sel.port?'프로젝트 수정에서 포트를 먼저 설정하세요':sel.isRunning?`cmux로 localhost:${sel.port} 열기 (macOS 전용)`:`cmux로 localhost:${sel.port} 열기 · 현재 실행 상태 미감지`}><Terminal style={{width:11,height:11}}/>cmux localhost</button>}
                <button data-testid="detail-orca-localhost" disabled={!canOpenRegisteredPort(sel)} onClick={() => { if (canOpenRegisteredPort(sel)) openOrcaLocalhost(sel); }} style={{...rowBtn,color:'#38bdf8',borderColor:'rgba(56,189,248,0.28)',background:'rgba(56,189,248,0.07)',...(!canOpenRegisteredPort(sel)?{opacity:0.45,cursor:'not-allowed'}:{})}} title={!sel.port?'프로젝트 수정에서 포트를 먼저 설정하세요':sel.isRunning?`이 프로젝트의 Orca 브라우저 탭으로 localhost:${sel.port} 열기`:`Orca에서 localhost:${sel.port} 열기 · 현재 실행 상태 미감지`}><Globe style={{width:11,height:11}}/>Orca localhost</button>
              </div>
            </div>

            {/* 기록/정리 */}
            <div style={{display:'flex',gap:6,flexWrap:'wrap' as const,marginBottom:8}}>
              <button data-testid="lower-view-session-log" onClick={() => handleViewPortLog(sel.id, sel.name)} style={{...rowBtn,color:'#7dd3fc',border:'1px solid rgba(125,211,252,0.22)',background:'rgba(125,211,252,0.05)'}}>
                <StickyNote style={{width:11,height:11}}/>서버 실행 로그 보기
              </button>
              <button onClick={() => toggleFavorite(sel)} style={{...rowBtn,color:sel.favorite?'#5eead4':'#a1a1aa',borderColor:sel.favorite?'rgba(94,234,212,0.3)':'rgba(255,255,255,0.1)'}} title={sel.favorite?'사이드바 상단 고정 해제':'사이드바 상단에 고정'}>
                <Pin style={{width:11,height:11,fill:sel.favorite?'#5eead4':'none'}}/>{sel.favorite?'고정 해제':'상단 고정'}
              </button>
            </div>

            {/* 터미널 에이전트 실행 — 헤더 터미널 컨트롤 기반 */}
            <div data-testid="terminal-agent-panel" style={{marginBottom:8,padding:'8px 10px',borderRadius:7,background:'rgba(255,255,255,0.018)',border:'1px solid rgba(255,255,255,0.06)'}}>
              <div style={{fontSize:10,color:'#a1a1aa',fontWeight:600,marginBottom:2}}>선택한 터미널에서 AI 실행</div>
              <div data-testid="terminal-agent-panel-bg-state" data-launch-reuse={agentLaunchPolicy.reuse} style={{fontSize:9,color:claudeBgActive?'#c4b5fd':'#52525b',marginBottom:6}}>
                {claudeBgActive
                  ? `Claude --bg ON · 백그라운드 시작 후 ${selectedTerminalSurface}에서 claude agents 열기 · Codex·agy는 ${agentLaunchPolicy.summary}`
                  : agentLaunchPolicy.summary}
              </div>
              {/* 실행 = 있으면 기존 창 / 새 창 = 항상 새로. 세 에이전트 모두 같은 규칙이라
                  같은 모양의 버튼 쌍으로 노출한다(표면이 재사용을 못 하면 위 문구가 밝힌다). */}
              <div style={{display:'flex',gap:6,flexWrap:'wrap' as const}}>
                {([
                  { agent: 'claude' as const, label: claudeBgActive ? 'Claude --bg' : 'Claude', color: '#c8a8f0', border: 'rgba(200,168,240,0.25)',
                    run: () => openClaudeMain(sel, false), fresh: () => openClaudeMain(sel, true),
                    runTitle: claudeBgActive ? `Claude --bg 시작 후 ${selectedTerminalSurface}에서 claude agents 열기` : agentLaunchPolicy.runTitle,
                    freshTitle: claudeBgActive ? `추가 Claude --bg 작업을 시작하고 ${selectedTerminalSurface}에서 claude agents 열기` : agentLaunchPolicy.newTitle,
                    freshLabel: claudeBgActive ? '추가' : '새 창' },
                  { agent: 'codex' as const, label: 'Codex', color: '#6ee7b7', border: 'rgba(110,231,183,0.25)',
                    run: () => openCodexMain(sel), fresh: () => openCodexMain(sel, undefined, false, true),
                    runTitle: agentLaunchPolicy.runTitle, freshTitle: agentLaunchPolicy.newTitle, freshLabel: '새 창' },
                  { agent: 'agy' as const, label: 'AGY', color: '#fdba74', border: 'rgba(253,186,116,0.25)',
                    run: () => openAntigravityMain(sel), fresh: () => openAntigravityMain(sel, undefined, false, true),
                    runTitle: agentLaunchPolicy.runTitle, freshTitle: agentLaunchPolicy.newTitle, freshLabel: '새 창' },
                  { agent: 'hermes' as const, label: 'Hermes', color: '#fcd34d', border: 'rgba(252,211,77,0.25)',
                    run: () => openHermesMain(sel), fresh: () => openHermesMain(sel, undefined, true),
                    runTitle: '프로젝트에서 Hermes 실행', freshTitle: '프로젝트에서 Hermes 새 창 실행', freshLabel: '새 창' },
                ]).filter(entry => agentShown(entry.agent)).map(entry => (
                  <div key={entry.agent} style={{display:'flex',gap:2}}>
                    <button
                      data-testid={`detail-${entry.agent}-run`}
                      onClick={() => { void entry.run(); }}
                      style={{...rowBtn,color:entry.color,borderColor:entry.border}}
                      title={entry.runTitle}
                    >
                      {entry.label} 실행
                    </button>
                    <button
                      data-testid={`detail-${entry.agent}-new`}
                      onClick={() => { void entry.fresh(); }}
                      style={{...rowBtn,color:entry.color,borderColor:entry.border,opacity:0.82}}
                      title={entry.freshTitle}
                      aria-label={`${entry.label} ${entry.freshLabel}`}
                    >
                      {entry.freshLabel}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div data-testid="desktop-project-app-panel" style={{marginBottom:10,padding:'8px 10px',borderRadius:7,background:'rgba(168,85,247,0.035)',border:'1px solid rgba(168,85,247,0.12)'}}>
              <div style={{fontSize:10,color:'#d8b4fe',fontWeight:600,marginBottom:2}}>독립 데스크톱 앱에서 프로젝트 열기</div>
              <div style={{fontSize:9,color:'#52525b',marginBottom:6}}>
                위 AI 실행과 별개 · 터미널을 시작하지 않고 프로젝트 폴더만 앱에 연결
              </div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap' as const}}>
                {agentShown('claude') && (
                  <button
                    data-testid="detail-claude-code-app"
                    onClick={() => void openProjectCodeApp('claude', sel)}
                    style={{...rowBtn,color:'#d8b4fe',borderColor:'rgba(200,168,240,0.28)',background:'rgba(200,168,240,0.08)'}}
                    title="이 프로젝트를 Claude Desktop의 Code 탭에서 열기 · 최초 폴더 확인 필요"
                  >
                    <Monitor style={{width:11,height:11}}/>Claude 앱에서 프로젝트 열기
                  </button>
                )}
                {agentShown('codex') && (
                  <button
                    data-testid="detail-codex-app"
                    onClick={() => void openProjectCodeApp('codex', sel)}
                    style={{...rowBtn,color:'#6ee7b7',borderColor:'rgba(110,231,183,0.28)',background:'rgba(110,231,183,0.08)'}}
                    title="이 프로젝트를 ChatGPT 앱의 Codex 새 로컬 작업으로 열기"
                  >
                    <Monitor style={{width:11,height:11}}/>ChatGPT 앱의 Codex에서 열기
                  </button>
                )}
                {agentShown('hermes') && (
                  <button
                    data-testid="detail-hermes-app"
                    onClick={() => void openProjectCodeApp('hermes', sel)}
                    style={{...rowBtn,color:'#fcd34d',borderColor:'rgba(252,211,77,0.28)',background:'rgba(252,211,77,0.08)'}}
                    title="이 프로젝트를 Hermes Desktop에서 열기"
                  >
                    <Monitor style={{width:11,height:11}}/>Hermes 앱에서 열기
                  </button>
                )}
                <button
                  data-testid="detail-buzz-app"
                  onClick={() => openBuzzProject(sel)}
                  style={{...rowBtn,color:'#67e8f9',borderColor:'rgba(34,211,238,0.28)',background:'rgba(34,211,238,0.08)'}}
                  title="Buzz에서 DEV 프로젝트 작업 또는 USE 앱 기능 사용 선택"
                >
                  <MessageSquarePlus style={{width:11,height:11}}/>Buzz 채널로 열기
                </button>
              </div>
            </div>

            <div style={{marginTop:12,marginBottom:8}}>
              <Suspense fallback={null}>
                <ProjectMemoryPanel
                  folderPath={sel.folderPath}
                  projectName={sel.name}
                  githubUrl={primaryGitHubRepositoryUrl(sel)}
                  compact
                  onToast={showToast}
                />
              </Suspense>
            </div>

            {/* 워크트리 패널 */}
            {expandedWorktreeIds.has(sel.id) && <div style={{marginTop:8}}>{renderWorktreePanel(sel)}</div>}
          </div>
          )
        ) : (
          <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:10,color:'#3f3f46'}}>
            <SquareTerminal style={{width:36,height:36,opacity:0.2}}/>
            <p style={{fontSize:12,margin:0,fontFamily:'JetBrains Mono, monospace'}}>select a project</p>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{background:'#09090b'}}>
      {buzzProjectTarget && (
        <Suspense fallback={null}>
          <BuzzProjectDialog
            portId={buzzProjectTarget.portId}
            projectName={buzzProjectTarget.projectName}
            onOpenUseSetup={() => {
              setBuzzUseSetupTarget(buzzProjectTarget);
              setBuzzProjectTarget(null);
            }}
            onClose={() => setBuzzProjectTarget(null)}
            onToast={showToast}
          />
        </Suspense>
      )}
      {buzzUseSetupTarget && (
        <Suspense fallback={null}>
          <BuzzAgentSetupDialog
            deviceName={memoryPortalCredentials?.deviceName}
            scope="service"
            projects={ports.filter(project => !!project.folderPath).map(project => ({
              id: project.id,
              name: project.name,
              folderPath: project.folderPath,
            }))}
            initialProjectId={buzzUseSetupTarget.portId}
            onClose={() => setBuzzUseSetupTarget(null)}
            onToast={(message, type) => showToast(message, type)}
          />
        </Suspense>
      )}
      {!isTauri() && apiServerOnline === false && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500/90 text-black text-sm px-4 py-2 flex items-center justify-between">
          <span>⚠️ API 서버가 꺼져 있습니다. <code className="bg-black/10 px-1 rounded">bun run start</code> 로 실행하세요. Supabase는 캐시된 인증 정보로 동작합니다.</span>
          <button onClick={() => { fetch('/api/ports').then(() => setApiServerOnline(true)).catch(() => {}); }} className="ml-4 px-2 py-0.5 bg-black/20 rounded hover:bg-black/30 text-xs">재확인</button>
        </div>
      )}
      {/* 머지 확인 모달 */}
      {commitModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-amber-500/15 p-2 rounded-lg border border-amber-500/30">
                <GitCommit className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">커밋</h3>
                <p className="text-zinc-400 text-xs mt-0.5 font-mono">{commitModal.wt.branch}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                placeholder="직접 입력하거나 AI로 생성..."
                value={commitModal.msg}
                onChange={e => setCommitModal(m => m ? { ...m, msg: e.target.value } : m)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && commitModal.msg.trim() && !commitRunning) {
                    void runCommitFromModal();
                  } else if (e.key === 'Escape' && !commitRunning) { setPendingParentCommit(null); setCommitModal(null); }
                }}
                className="min-w-0 flex-1 px-3 py-2 bg-[#18181b] border border-stone-700/50 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
              <button
                type="button"
                data-testid="commit-generate-ai-message"
                disabled={commitMessageGenerating}
                onClick={() => void handleSuggestCommitMessage()}
                className="shrink-0 px-3 py-2 text-xs text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors disabled:opacity-50"
                title="현재 변경 내역을 분석해 커밋 메시지 생성"
              >
                <Sparkles className="w-3 h-3 inline-block mr-1" />
                {commitMessageGenerating ? '생성 중…' : 'AI 메시지'}
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 -mt-2">
              AI 생성 시 변경 파일 목록과 일부 diff를 Claude에 전달합니다.
            </p>
            <div className="flex gap-2 justify-end">
              <button disabled={commitRunning} onClick={() => { setPendingParentCommit(null); setCommitModal(null); }} className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 hover:border-zinc-500 rounded-lg transition-colors disabled:opacity-40">취소</button>
              <button
                data-testid="commit-confirm"
                disabled={!commitModal.msg.trim() || commitRunning}
                onClick={() => void runCommitFromModal()}
                className="px-4 py-1.5 text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded-lg transition-colors disabled:opacity-40"
              >
                {commitRunning ? '커밋 중…' : '커밋'}
              </button>
            </div>
          </div>
        </div>
      )}

      {gitOperationError && (
        <div
          data-testid="git-operation-error-modal"
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setGitOperationError(null)}
        >
          <div className="bg-[#111113] rounded-xl border border-red-500/30 w-full max-w-2xl max-h-[82vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 p-5 border-b border-stone-800/60">
              <div className="flex items-center gap-3 min-w-0">
                <div className="bg-red-500/15 p-2 rounded-lg border border-red-500/30">
                  <GitCommit className="w-5 h-5 text-red-300" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-white font-semibold text-sm">{gitOperationError.title}</h3>
                  <p className="text-red-300 text-xs mt-1 break-words">{gitOperationError.message}</p>
                </div>
              </div>
              <button onClick={() => setGitOperationError(null)} className="p-2 hover:bg-[#18181b] rounded-lg">
                <XIcon className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            {gitOperationError.submodulePaths.length > 0 && (
              <div className="mx-5 mt-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-xs text-amber-200 font-semibold">먼저 서브모듈 내부 변경을 커밋하거나 정리해야 합니다.</p>
                <div className="mt-2 space-y-2">
                  {gitOperationError.submodulePaths.map(path => (
                    <div key={path} className="flex items-center gap-2 flex-wrap">
                      <span className="flex-1 min-w-0 text-[11px] text-amber-100 font-mono break-all">{path}</span>
                      <button
                        data-testid="open-dirty-submodule"
                        onClick={() => {
                          const separator = gitOperationError.worktreePath.includes('\\') ? '\\' : '/';
                          const target = `${gitOperationError.worktreePath.replace(/[\\/]+$/, '')}${separator}${path}`;
                          API.openFolder(target).catch(error => showToast(`서브모듈 폴더 열기 실패: ${error instanceof Error ? error.message : String(error)}`, 'error'));
                        }}
                        className="px-3 py-1.5 text-[11px] text-zinc-300 border border-stone-700 rounded-md bg-[#18181b] hover:bg-[#202024]"
                      >
                        폴더 열기
                      </button>
                      <button
                        data-testid="commit-dirty-submodule"
                        onClick={() => {
                          const separator = gitOperationError.worktreePath.includes('\\') ? '\\' : '/';
                          const target = `${gitOperationError.worktreePath.replace(/[\\/]+$/, '')}${separator}${path}`;
                          const parentItem = gitOperationError.item;
                          setPendingParentCommit({
                            item: parentItem,
                            wt: gitOperationError.parentWorktree,
                            message: gitOperationError.attemptedMessage,
                          });
                          setGitOperationError(null);
                          setCommitMessageGenerating(false);
                          setCommitModal({ item: parentItem, wt: { path: target, branch: path, is_main: false }, msg: '' });
                        }}
                        className="px-3 py-1.5 text-[11px] font-semibold text-amber-100 border border-amber-500/30 rounded-md bg-amber-500/15 hover:bg-amber-500/25"
                      >
                        변경 커밋
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-auto p-5">
              <pre data-testid="git-operation-diagnostic" className="whitespace-pre-wrap break-words rounded-lg bg-[#09090b] border border-stone-800/60 p-4 text-[11px] leading-5 text-zinc-300 font-mono">
                {gitOperationError.diagnostic}
              </pre>
            </div>

            <div className="flex items-center justify-end gap-2 p-4 border-t border-stone-800/60">
              <button onClick={() => setGitOperationError(null)} className="px-4 py-2 text-xs text-zinc-400 border border-stone-700 rounded-lg hover:text-white">닫기</button>
              <button
                data-testid="copy-git-diagnostic"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(gitOperationError.diagnostic);
                    showToast('Git 진단 로그를 복사했습니다.', 'success');
                  } catch {
                    showToast('진단 로그 복사 실패', 'error');
                  }
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-500/20 border border-red-500/35 rounded-lg hover:bg-red-500/30 flex items-center gap-2"
              >
                <Copy className="w-3.5 h-3.5" />진단 로그 복사
              </button>
            </div>
          </div>
        </div>
      )}

      {migrateWorktreeConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-amber-500/15 p-2 rounded-lg border border-amber-500/30">
                <FolderOpen className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">Orca가 인식하는 경로로 옮기기</h3>
                <p className="text-zinc-400 text-xs mt-0.5">브랜치·변경사항·node_modules는 그대로 따라갑니다</p>
              </div>
            </div>
            <div className="bg-[#18181b]/60 rounded-lg p-3 border border-stone-800/40 space-y-1">
              <p className="text-[11px] text-zinc-500">이동 전</p>
              <p className="text-xs text-amber-300/90 font-mono break-all">{migrateWorktreeConfirm.wt.path}</p>
              <p className="text-[11px] text-zinc-500 pt-1">이동 후</p>
              <p className="text-xs text-teal-300/90 font-mono break-all">
                {`${(migrateWorktreeConfirm.item.folderPath || '').replace(/\/+$/, '')}/worktrees/${migrateWorktreeConfirm.wt.path.split('/').filter(Boolean).pop()}`}
              </p>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              이 워크트리에서 열어둔 터미널·AI 세션이 있으면 먼저 닫아주세요. 세션의 작업 폴더가 옛 경로에 묶여 있어
              어디에 저장되는지 알 수 없게 됩니다. 실행 중인 서버는 자동으로 중지합니다.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setMigrateWorktreeConfirm(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 hover:border-zinc-500 rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                data-testid="worktree-migrate-confirm"
                onClick={executeWorktreeMigrate}
                className="px-4 py-1.5 text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 rounded-lg transition-colors"
              >
                옮기기
              </button>
            </div>
          </div>
        </div>
      )}
      {switchBranchModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => !worktreeBranchBusy[switchBranchModal.wt.path] && setSwitchBranchModal(null)}>
          <div data-testid="worktree-switch-branch-modal" className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-md p-6 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="bg-blue-500/15 p-2 rounded-lg border border-blue-500/30">
                <GitBranch className="w-5 h-5 text-blue-300" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">워크트리를 새 브랜치로 재사용</h3>
                <p className="text-zinc-400 text-xs mt-0.5">폴더와 node_modules는 그대로 두고 브랜치만 바꿉니다</p>
              </div>
            </div>
            <div className="bg-[#18181b]/60 rounded-lg p-3 border border-stone-800/40 space-y-1">
              <p className="text-xs text-zinc-400">현재 브랜치
                <span className="text-zinc-200 font-mono ml-2">{switchBranchModal.wt.branch ?? '(detached)'}</span></p>
              <p className="text-xs text-zinc-500 font-mono break-all">{switchBranchModal.wt.path}</p>
            </div>
            <div>
              <label className="text-xs text-zinc-400">새 브랜치 이름</label>
              <input
                autoFocus
                value={switchBranchModal.name}
                onChange={e => setSwitchBranchModal(m => m && ({ ...m, name: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === 'Enter' && switchBranchModal.name.trim()) {
                    void executeWorktreeSwitchBranch(switchBranchModal.item, switchBranchModal.wt, switchBranchModal.name.trim());
                  }
                }}
                disabled={!!worktreeBranchBusy[switchBranchModal.wt.path]}
                className="w-full mt-1 px-3 py-2 text-xs bg-[#0a0a0b] border border-stone-700/50 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/50"
                placeholder="task-20260802-1030"
              />
              <p className="text-xs text-zinc-500 mt-2">
                현재 main 기준으로 새 브랜치를 만들어 이 워크트리를 옮깁니다.
                미커밋 변경이 있으면 거부되니 먼저 커밋하세요.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button disabled={!!worktreeBranchBusy[switchBranchModal.wt.path]}
                onClick={() => setSwitchBranchModal(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 hover:border-zinc-500 rounded-lg transition-colors disabled:opacity-50">
                취소
              </button>
              <button
                data-testid="worktree-switch-branch-confirm"
                disabled={!switchBranchModal.name.trim() || !!worktreeBranchBusy[switchBranchModal.wt.path]}
                onClick={() => void executeWorktreeSwitchBranch(switchBranchModal.item, switchBranchModal.wt, switchBranchModal.name.trim())}
                className="px-4 py-1.5 text-xs bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 rounded-lg transition-colors disabled:opacity-50">
                {worktreeBranchBusy[switchBranchModal.wt.path] ? '전환 중…' : '새 브랜치로 전환'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteWorktreeConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-red-500/15 p-2 rounded-lg border border-red-500/30">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">워크트리 삭제</h3>
                <p className="text-zinc-400 text-xs mt-0.5">이 작업은 되돌릴 수 없습니다</p>
              </div>
            </div>
            <div className="bg-[#18181b]/60 rounded-lg p-3 border border-stone-800/40">
              <p className="text-xs text-[#f4f4f5]/90">
                <span className="text-red-400 font-mono">{deleteWorktreeConfirm.wt.branch ?? deleteWorktreeConfirm.wt.path.split('/').pop()}</span> 워크트리를 삭제하시겠습니까?
              </p>
              <p className="text-xs text-zinc-500 mt-1 font-mono break-all">{deleteWorktreeConfirm.wt.path}</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteWorktreeConfirm(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 hover:border-zinc-500 rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                onClick={executeWorktreeDelete}
                className="px-4 py-1.5 text-xs bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 rounded-lg transition-colors"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {firstTaskLaunch && (
        <div
          data-testid="first-task-worktree-modal"
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => !firstTaskLaunchBusy && setFirstTaskLaunch(null)}
        >
          <div className="bg-[#111113] rounded-xl border border-teal-500/25 w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="bg-teal-500/15 p-2 rounded-lg border border-teal-500/30">
                <GitBranch className="w-5 h-5 text-teal-300" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">첫 AI 임무 작업 위치</h3>
                <p className="text-zinc-400 text-xs mt-0.5">
                  {firstTaskLaunch.item.name} · {firstTaskLaunch.agent === 'claude' ? 'Claude' : firstTaskLaunch.agent === 'codex' ? 'Codex' : 'AGY'}
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-300">첫 임무를 메인 워크트리에서 진행할지, 격리된 새 워크트리에서 시작할지 선택하세요.</p>

            <button
              data-testid="first-task-use-main"
              disabled={firstTaskLaunchBusy}
              onClick={() => void launchFirstAgentTask('main')}
              className="w-full text-left rounded-lg border border-stone-700/60 bg-[#18181b]/70 px-4 py-3 hover:border-teal-500/40 hover:bg-teal-500/5 transition-colors disabled:opacity-50"
            >
              <span className="block text-sm font-semibold text-zinc-100">메인 워크트리에서 시작</span>
              <span className="block text-[11px] text-zinc-500 mt-1">현재 기본 브랜치에서 바로 AI를 실행합니다.</span>
            </button>

            <div className="rounded-lg border border-teal-500/25 bg-teal-500/5 p-4 space-y-3">
              <div>
                <span className="block text-sm font-semibold text-teal-200">새 워크트리에서 시작</span>
                <span className="block text-[11px] text-zinc-500 mt-1">새 브랜치와 독립 작업 폴더를 만든 뒤 그 위치에서 AI를 실행합니다.</span>
              </div>
              <input
                data-testid="first-task-branch-name"
                value={firstTaskBranchName}
                onChange={e => setFirstTaskBranchName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && firstTaskBranchName.trim()) void launchFirstAgentTask('worktree'); }}
                placeholder="feature/my-task"
                disabled={firstTaskLaunchBusy}
                className="w-full px-3 py-2 bg-[#09090b] border border-stone-700 rounded-lg text-sm text-zinc-200 font-mono focus:outline-none focus:border-teal-500/50 disabled:opacity-50"
              />
              <button
                data-testid="first-task-create-worktree"
                disabled={firstTaskLaunchBusy || !firstTaskBranchName.trim()}
                onClick={() => void launchFirstAgentTask('worktree')}
                className="w-full px-4 py-2 text-xs font-semibold bg-teal-500/15 hover:bg-teal-500/25 text-teal-200 border border-teal-500/30 rounded-lg transition-colors disabled:opacity-40"
              >
                {firstTaskLaunchBusy ? '준비 중…' : '워크트리 생성 후 AI 실행'}
              </button>
            </div>

            <div className="flex justify-end">
              <button disabled={firstTaskLaunchBusy} onClick={() => setFirstTaskLaunch(null)} className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 rounded-lg disabled:opacity-50">취소</button>
            </div>
          </div>
        </div>
      )}

      {gitInitConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setGitInitConfirm(null)}>
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-sm p-6 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="bg-amber-500/15 p-2 rounded-lg border border-amber-500/30">
                <GitBranch className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">Git 초기화 필요</h3>
                <p className="text-zinc-400 text-xs mt-0.5">{gitInitConfirm.item.name}</p>
              </div>
            </div>
            <div className="bg-[#18181b]/60 rounded-lg p-3 border border-stone-800/40 space-y-1">
              <p className="text-xs text-[#f4f4f5]/90">이 프로젝트는 Git 저장소가 아닙니다.</p>
              <p className="text-xs text-zinc-400"><span className="text-amber-400 font-mono">git init</span> 후 빈 커밋을 생성하고 워크트리 <span className="text-amber-400 font-mono">{gitInitConfirm.branchName}</span>을 추가할까요?</p>
              {gitInitConfirm.item.folderPath && <p className="text-xs text-zinc-600 font-mono break-all">{gitInitConfirm.item.folderPath}</p>}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setGitInitConfirm(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-white border border-stone-700/50 hover:border-zinc-500 rounded-lg transition-colors">
                취소
              </button>
              <button onClick={async () => {
                const { item, branchName } = gitInitConfirm;
                setGitInitConfirm(null);
                try {
                  const result = await API.gitInit(item.folderPath!).catch(() => null);
                  if (result === null) {
                    showToast('Git 초기화 연결 실패 — 워크트리 추가 직접 시도', 'error');
                  } else if (result.error) {
                    showToast(`Git 초기화 실패: ${result.error}`, 'error'); return;
                  } else {
                    await repositoryWorkflowApi.upgrade(item.folderPath!);
                    showToast('Git 초기화 완료', 'success');
                  }
                  await executeWorktreeAdd(item, branchName);
                } catch (e) {
                  showToast(`Git 초기화 실패: ${e}`, 'error');
                }
              }} className="px-4 py-1.5 text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded-lg transition-colors">
                Git 초기화 후 추가
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-blue-500/15 p-2 rounded-lg border border-blue-500/30">
                <GitBranch className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">머지 확인</h2>
                <p className="text-xs text-zinc-400 mt-0.5 font-mono">
                  <span className="text-teal-400">{mergeConfirm.wt.branch}</span>
                  <span className="text-zinc-500"> → </span>
                  <span className="text-[#f4f4f5]/90">{mergeConfirm.mainBranch}</span>
                </p>
              </div>
            </div>
            {mergeConfirm.isDirty && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
                <span>⚠️</span>
                <span>워킹 트리에 미커밋 변경사항이 있습니다. <span className="font-medium">--autostash</span>로 자동 스태시 후 머지하고 팝합니다.</span>
              </div>
            )}
            {mergeConfirm.commits ? (
              <div className="bg-black/40 rounded-lg p-3 border border-stone-800/40">
                <p className="text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">머지될 커밋</p>
                <pre className="text-xs text-[#f4f4f5]/90 font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">{mergeConfirm.commits}</pre>
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">커밋 없음 (이미 최신 상태)</p>
            )}
            {mergeConfirm.stat && (
              <div className="bg-black/40 rounded-lg p-3 border border-stone-800/40">
                <p className="text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">변경 파일</p>
                <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto">{mergeConfirm.stat}</pre>
              </div>
            )}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={async () => {
                  const baseUrl = isTauri() ? 'http://localhost:3001' : '';
                  await fetch(`${baseUrl}/api/open-terminal-git-merge`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderPath: mergeConfirm.item.folderPath, branchName: mergeConfirm.wt.branch, name: mergeConfirm.item.name }),
                  });
                  setMergeConfirm(null);
                  showToast('터미널에서 git merge 실행 중', 'success');
                }}
                className="px-4 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-lg transition-colors"
              >
                터미널에서 머지
              </button>
              <button onClick={() => setMergeConfirm(null)} className="px-4 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-lg transition-colors">
                취소
              </button>
              <button
                onClick={executeMerge}
                disabled={mergeLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {mergeLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
                Merge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 머지 에러 모달 (충돌 등) */}
      {mergeError && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-red-800/50 w-full max-w-lg p-5 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="bg-red-500/15 p-2 rounded-lg border border-red-500/30 shrink-0">
                <XIcon className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">머지 실패</h2>
                <p className="text-xs text-red-400 mt-0.5">
                  {mergeError.hasConflict ? '충돌(Conflict) 발생 — 아래 방법 중 하나를 선택하세요' : '머지 중 오류가 발생했습니다'}
                </p>
              </div>
            </div>

            {/* Conflict files list */}
            {mergeConflictFiles.length > 0 && (
              <div className="bg-black/40 rounded-lg p-3 border border-red-900/30 space-y-1">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">충돌 파일 ({mergeConflictFiles.length}개)</p>
                {mergeConflictFiles.map(f => (
                  <div key={f} className="flex items-center gap-1.5">
                    <span className="text-red-400 text-xs">⚠</span>
                    <code className="text-xs text-red-300 font-mono">{f}</code>
                  </div>
                ))}
              </div>
            )}

            {/* Raw error (collapsed if conflict files shown) */}
            {mergeConflictFiles.length === 0 && (
              <div className="bg-black/40 rounded-lg p-3 border border-red-900/30">
                <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">{mergeError.message}</pre>
              </div>
            )}

            {/* Claude Code prompt box */}
            {mergeError.hasConflict && mergeError.folderPath && (() => {
              const files = mergeConflictFiles.length > 0
                ? mergeConflictFiles.map(f => `- ${f}`).join('\n')
                : '(충돌 파일 확인 중...)';
              const prompt = `다음 경로에서 git 머지 충돌을 해결해줘:\n\`\`\`\n${mergeError.folderPath}\n\`\`\`\n\n충돌 파일:\n${files}\n\n각 파일의 충돌 마커(<<<<<<, =======, >>>>>>>)를 제거하고 올바르게 병합한 뒤,\n\`git add .\` → \`git commit --no-edit\` 순서로 머지를 완료해줘.`;
              return (
                <div className="bg-[#18181b]/80 rounded-lg border border-stone-700/50">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-stone-700/40">
                    <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-medium">Claude Code 프롬프트</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(prompt).then(() => showToast('프롬프트 복사됨 — Claude Code에 붙여넣기 하세요', 'success')).catch(() => showToast('복사 실패', 'error'));
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
                    >
                      <Copy className="w-3 h-3" /> 복사
                    </button>
                  </div>
                  <pre className="text-xs text-[#f4f4f5]/90 font-mono px-3 py-2.5 whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto">{prompt}</pre>
                </div>
              );
            })()}

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-1">
              {mergeError.hasConflict && (
                <>
                  <button
                    onClick={async () => {
                      try {
                        const baseUrl = isTauri() ? 'http://localhost:3001' : '';
                        const r = await fetch(`${baseUrl}/api/git-merge-abort`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ folderPath: mergeError.folderPath, force: false }),
                        });
                        if (!r.ok) {
                          // retry with force
                          const r2 = await fetch(`${baseUrl}/api/git-merge-abort`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ folderPath: mergeError.folderPath, force: true }),
                          });
                          if (!r2.ok) { const d = await r2.json(); showToast('abort 실패: ' + d.error, 'error'); return; }
                        }
                        showToast('머지 취소됨 — 브랜치가 원래 상태로 복원됐습니다', 'success');
                        setMergeError(null);
                        setMergeConflictFiles([]);
                      } catch (e) { showToast('abort 실패: ' + e, 'error'); }
                    }}
                    className="px-3 py-2 bg-red-500/15 hover:bg-red-500/25 text-red-400 text-sm rounded-lg border border-red-500/30 transition-colors"
                  >
                    Abort Merge
                  </button>
                </>
              )}
              <button onClick={() => { setMergeError(null); setMergeConflictFiles([]); }} className="px-3 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-lg transition-colors">
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 머지 후 main 푸시 확인 모달 */}
      {mergePushConfirm && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-700/50 w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-blue-500/15 p-2 rounded-lg border border-blue-500/30">
                <GitBranch className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-sm">머지 완료</h3>
                <p className="text-zinc-400 text-xs mt-0.5"><span className="font-mono text-blue-300">{mergePushConfirm.mainBranch}</span> 브랜치를 remote에 푸시할까요?</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={async () => {
                  const { item, mainBranch } = mergePushConfirm;
                  setMergePushConfirm(null);
                  try {
                    const baseUrl = isTauri() ? 'http://localhost:3001' : '';
                    const res = await fetch(`${baseUrl}/api/git-push`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ folderPath: item.folderPath }),
                    });
                    const data = await res.json();
                    if (data.success) showToast(`✅ ${mainBranch} 푸시 완료`, 'success');
                    else showToast(`푸시 실패: ${data.error}`, 'error');
                  } catch (e) { showToast('푸시 실패: ' + e, 'error'); }
                }}
                className="px-4 py-2 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-sm rounded-lg border border-blue-500/30 transition-colors"
              >
                푸시
              </button>
              <button onClick={() => setMergePushConfirm(null)} className="px-4 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-lg transition-colors">
                나중에
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 빌드 로그 모달 */}
      {showBuildLog && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-800/40 w-full max-w-4xl max-h-[80vh] flex flex-col">
            {/* 헤더 */}
            <div className="flex items-center justify-between p-6 border-b border-stone-800/40">
              <div className="flex items-center gap-3">
                {buildType === 'windows'
                  ? <Monitor className={`w-5 h-5 ${isBuilding ? 'animate-spin text-blue-400' : 'text-green-400'}`} />
                  : <Package className={`w-5 h-5 ${isBuilding ? 'animate-spin text-blue-400' : 'text-green-400'}`} />
                }
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {buildType === 'dmg' ? 'DMG' : buildType === 'windows' ? 'Windows' : 'App'} 빌드 진행 상황
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {isBuilding
                      ? '빌드 진행 중...'
                      : '빌드 완료'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowBuildLog(false)}
                className="p-2 hover:bg-[#18181b] rounded-lg transition-colors"
              >
                <XIcon className="w-5 h-5 text-zinc-400" />
              </button>
            </div>

            {/* 로그 내용 */}
            <div ref={buildLogContainerRef} className="flex-1 overflow-y-auto p-6 font-mono text-xs">
              <div className="space-y-1">
                {buildLogs.map((log, index) => (
                  <div
                    key={index}
                    className={`${
                      log.includes('❌') || log.includes('error') || log.includes('Error')
                        ? 'text-red-400'
                        : log.includes('✅')
                        ? 'text-green-400'
                        : log.includes('⚠️') || log.includes('warning')
                        ? 'text-yellow-400'
                        : 'text-[#f4f4f5]/90'
                    }`}
                  >
                    {log}
                  </div>
                ))}
                {isBuilding && (
                  <div className="text-blue-400 animate-pulse mt-2">
                    ⏳ 빌드 중...
                  </div>
                )}
              </div>
            </div>

            {/* 푸터 */}
            <div className="p-4 border-t border-stone-800/40 bg-[#111113]/80">
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-400">
                  총 {buildLogs.length}줄의 로그
                </div>
                <div className="flex items-center gap-2">
                  {canAutoInstall && !isBuilding && (
                    <button
                      onClick={handleInstallWindowsPrereqs}
                      className="px-3 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 text-xs rounded-lg border border-indigo-500/40 transition-colors font-medium"
                    >
                      🔧 자동 설치하기 (VS Build Tools + Rust)
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      const logText = buildLogs.join('\n');
                      try {
                        await navigator.clipboard.writeText(logText);
                        showToast('로그가 클립보드에 복사되었습니다', 'success');
                      } catch {
                        showToast('클립보드 복사 실패', 'error');
                      }
                    }}
                    className="px-3 py-1.5 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-xs rounded-lg transition-colors"
                  >
                    로그 복사
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 포트 로그 뷰어 모달 */}
      {showPortLog && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111113] rounded-xl border border-stone-800/40 w-full max-w-4xl max-h-[80vh] flex flex-col">
            {/* 헤더 */}
            <div className="flex items-center justify-between p-6 border-b border-stone-800/40">
              <div className="flex items-center gap-3">
                <FileText className={`w-5 h-5 ${isLoadingPortLog ? 'animate-spin text-blue-400' : 'text-green-400'}`} />
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {viewingPortName} 서버 실행 로그
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {isLoadingPortLog ? '로그 로딩 중...' : 'stdout/stderr 실시간 업데이트 중 (1초 간격)'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleClosePortLog}
                  className="p-2 hover:bg-[#18181b] rounded-lg transition-colors"
                >
                  <XIcon className="w-5 h-5 text-zinc-400" />
                </button>
              </div>
            </div>

            {/* 로그 내용 */}
            <div ref={portLogContainerRef} className="flex-1 overflow-y-auto p-6 font-mono text-xs">
              <div className="space-y-0.5">
                {portLogs.map((log, index) => (
                  <div
                    key={index}
                    className={`${
                      log.includes('error') || log.includes('Error') || log.includes('ERROR') || log.includes('실패')
                        ? 'text-red-400'
                        : log.includes('success') || log.includes('✅') || log.includes('완료') || log.includes('started') || log.includes('ready')
                        ? 'text-green-400'
                        : log.includes('warn') || log.includes('WARN') || log.includes('⚠️')
                        ? 'text-yellow-400'
                        : 'text-[#f4f4f5]/90'
                    }`}
                  >
                    {log}
                  </div>
                ))}
                {isLoadingPortLog && (
                  <div className="text-blue-400 animate-pulse mt-2">
                    ⏳ 로딩 중...
                  </div>
                )}
              </div>
            </div>

            {/* 푸터 */}
            <div className="p-4 border-t border-stone-800/40 bg-[#111113]/80">
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-400">
                  총 {portLogs.length}줄
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setPortLogs([]);
                      portLogOffsetRef.current = 0;
                      handleViewPortLog(viewingPortId!, viewingPortName);
                    }}
                    className="px-3 py-1.5 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-xs rounded-lg transition-colors flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    새로고침
                  </button>
                  <button
                    onClick={async () => {
                      const logText = portLogs.join('\n');
                      try {
                        await navigator.clipboard.writeText(logText);
                        showToast('로그가 클립보드에 복사되었습니다', 'success');
                      } catch {
                        showToast('클립보드 복사 실패', 'error');
                      }
                    }}
                    className="px-3 py-1.5 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-xs rounded-lg transition-colors"
                  >
                    로그 복사
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Push 히스토리 모달 — 포트 */}
      {showPortsHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowPortsHistory(false)}>
          <div className="bg-[#18181b] border border-zinc-800 rounded-xl w-full max-w-md mx-4 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-400" />
                <span className="text-sm font-semibold text-white">Push 히스토리 — 포트</span>
              </div>
              <button onClick={() => setShowPortsHistory(false)} className="text-zinc-500 hover:text-white transition-colors"><XIcon className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto max-h-96">
              {portsHistoryLoading ? (
                <div className="flex items-center justify-center py-10"><RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" /></div>
              ) : portsHistoryList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-2">
                  <Clock className="w-8 h-8 text-zinc-700" />
                  <p className="text-sm text-zinc-500">저장된 히스토리가 없습니다</p>
                  <p className="text-xs text-zinc-600">Push 시 자동으로 스냅샷이 저장됩니다</p>
                </div>
              ) : portsHistoryList.map((snap, i) => (
                <div key={snap.id} className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm text-white font-medium">{new Date(snap.created_at).toLocaleString('ko-KR')}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {snap.row_count}개 포트{snap.device_name ? ` · ${snap.device_name}` : ''}
                      {i === 0 && <span className="ml-1.5 text-emerald-500 font-medium">최신</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => restorePortsSnapshot(snap.id)}
                    disabled={portsHistoryRestoring !== null}
                    className="ml-3 shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg transition-all disabled:opacity-50"
                  >
                    {portsHistoryRestoring === snap.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
                    복원
                  </button>
                </div>
              ))}
            </div>
            <div className="px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/40">
              <p className="text-xs text-zinc-600">복원 시 현재 Supabase 포트 데이터를 선택한 시점으로 되돌립니다</p>
            </div>
          </div>
        </div>
      )}

      {/* 플로팅 배너 — z-[10000]: 컨텍스트 메뉴(9999)·모달(9500) 위에 항상 표시 */}
      <div className="fixed top-4 right-4 z-[10000] space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`
              flex items-start gap-2.5 px-4 py-2.5 rounded-lg shadow-xl
              backdrop-blur-sm border
              transform transition-all duration-300 ease-in-out
              animate-slide-in-right
              ${toast.type === 'success'
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : toast.type === 'warning'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
              }
            `}
            style={{ maxWidth: '380px' }}
          >
            <div className="flex-1 font-medium text-sm" style={{ whiteSpace: 'pre-line', wordBreak: 'break-word' }}>
              {toast.message}
            </div>
            {toast.diagnostic && (
              <button
                data-testid="copy-error-diagnostic-toast"
                title="오류 보고 내용을 클립보드에 복사"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await navigator.clipboard.writeText(toast.diagnostic!);
                    showToast('오류 보고를 복사했습니다.', 'success');
                  } catch {
                    // 복사 실패를 다시 오류 토스트로 만들면 무한 반복될 수 있어 현재 토스트를 유지한다.
                  }
                }}
                className="hover:bg-white/10 rounded-md px-1.5 py-1 text-[10px] whitespace-nowrap transition-colors flex-shrink-0"
              >
                오류 복사
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setToasts(prev => prev.filter(t => t.id !== toast.id)); }}
              className="hover:bg-white/10 rounded-md p-1 transition-colors flex-shrink-0"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* 탭 네비게이션 */}
        <div
          data-testid="top-toolbar"
          className={`ui-toolbar-scroll flex items-center gap-2 shrink-0 scrollbar-none ${isMobile ? 'px-3 py-2 flex-nowrap overflow-x-auto' : 'px-6 py-2.5 flex-wrap'}`}
          style={{borderBottom:'1px solid rgba(255,255,255,0.07)'}}
        >
          <div
            data-testid="top-toolbar-project-actions"
            className={isMobile ? 'flex items-center gap-2' : 'flex min-w-0 flex-wrap items-center gap-2'}
            style={isMobile ? undefined : { flexShrink: 1, maxWidth: '100%' }}
          >
            <div className="flex gap-1 rounded-xl p-1 w-fit" style={{background:'#111113',border:'1px solid rgba(255,255,255,0.07)'}}>
              <button
                  data-help-key="tab-ports"
                  onClick={() => setActiveTab('ports')}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                    activeTab === 'ports'
                      ? 'shadow-sm'
                      : ''
                  }`}
                  style={{
                    background: activeTab === 'ports' ? '#202024' : 'transparent',
                    color: activeTab === 'ports' ? '#f4f4f5' : '#a1a1aa',
                  }}
                >
                  <Server className="w-3.5 h-3.5" />
                  {t(lang, 'tabProjects')}
                </button>
              <button
                data-help-key="tab-portal"
                onClick={() => setActiveTab('portal')}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                style={{
                  background: activeTab === 'portal' ? '#202024' : 'transparent',
                  color: activeTab === 'portal' ? '#f4f4f5' : '#a1a1aa',
                }}
              >
                <BookMarked className="w-3.5 h-3.5" />
                {t(lang, 'tabBookmarks')}
              </button>
              <button
                data-help-key="tab-memory"
                data-testid="top-level-memory-tab"
                onClick={() => setActiveTab('memory')}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                style={{
                  background: activeTab === 'memory' ? '#202024' : 'transparent',
                  color: activeTab === 'memory' ? '#f4f4f5' : '#a1a1aa',
                }}
              >
                <Brain className="w-3.5 h-3.5" />
                {t(lang, 'tabMemory')}
              </button>
            </div>

            {primaryProject && (
              <div
                data-testid="primary-project-toolbar"
                className="flex items-stretch overflow-hidden rounded-xl"
                style={{background:'rgba(94,234,212,0.045)',border:'1px solid rgba(94,234,212,0.24)',flexShrink:0}}
              >
                <button
                  type="button"
                  data-testid="primary-project-shortcut"
                  onClick={() => {
                    setActiveTab('ports');
                    setSearchQuery('');
                    setSidebarSection('all');
                    setV4SelectedId(primaryProject.id);
                  }}
                  title="검색 없이 AgentsToZ_byCS 프로젝트 열기"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-teal-300/10"
                  style={{background:'transparent',border:'none',color:'#5eead4',cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap'}}
                >
                  <Pin className="w-3 h-3" style={{fill:'#5eead4'}} />
                  AgentsToZ_byCS
                </button>
                <button
                  type="button"
                  data-testid="windows-pc-update-prompt-copy"
                  onClick={() => void handleCopyWindowsPcUpdatePrompt()}
                  title="유지보수자가 실제 Windows PC의 Claude 또는 Codex에 붙여넣을 소스 동기화·빌드·출시 검증 안내 복사 (일반 사용자 자동 업데이트 아님)"
                  className="flex items-center gap-1.5 border-l border-teal-300/15 px-2.5 py-1.5 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-teal-300/10 hover:text-teal-100 whitespace-nowrap"
                >
                  <Copy className="w-3 h-3" />
                  Windows 빌드·출시 안내
                </button>
                <button
                  type="button"
                  data-testid="github-windows-cloud-build"
                  onClick={() => void handleDispatchWindowsCloudBuild()}
                  disabled={isDispatchingWindowsCloudBuild}
                  title="비용 확인 후 GitHub Actions Windows 가상환경 빌드를 1회 실행"
                  className="flex items-center gap-1.5 border-l border-teal-300/15 px-2.5 py-1.5 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-teal-300/10 hover:text-teal-100 disabled:cursor-wait disabled:opacity-50 whitespace-nowrap"
                >
                  <Github className={`w-3 h-3 ${isDispatchingWindowsCloudBuild ? 'animate-pulse' : ''}`} />
                  {isDispatchingWindowsCloudBuild ? '요청 중…' : 'GitHub Windows 빌드'}
                </button>
              </div>
            )}

            {/* 포털 탭 전용 액션 버튼 (글로벌 위치) */}
            {activeTab === 'portal' && (
              <>
                <div className="flex items-center rounded-lg border border-stone-800/40 overflow-hidden">
                  <button
                    data-help-key="btn-portal-push"
                    onClick={() => portalActionsRef.current?.push()}
                    title="Supabase Push"
                    className="px-2.5 py-1.5 bg-[#111113] hover:bg-[#18181b] text-[#f4f4f5]/90 text-sm border-r border-stone-800/40 transition-all flex items-center gap-1"
                  >
                    <CloudUpload className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-xs font-medium">Push</span>
                  </button>
                  <button
                    data-help-key="btn-portal-pull"
                    onClick={() => portalActionsRef.current?.pull()}
                    title="Supabase Pull"
                    className="px-2.5 py-1.5 bg-[#111113] hover:bg-[#18181b] text-[#f4f4f5]/90 text-sm transition-all flex items-center gap-1"
                  >
                    <CloudDownload className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-xs font-medium">Pull</span>
                  </button>
                </div>
                <button
                  data-help-key="btn-portal-history"
                  onClick={() => portalActionsRef.current?.history()}
                  title="북마크 히스토리 / 복원"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Clock className="w-4 h-4" />
                </button>
                <button
                  data-help-key="btn-portal-export"
                  onClick={() => portalActionsRef.current?.exportData()}
                  title="내보내기"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Upload className="w-4 h-4" />
                </button>
                <button
                  data-help-key="btn-portal-import"
                  onClick={() => portalActionsRef.current?.importData()}
                  title="불러오기"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  data-help-key="btn-portal-settings"
                  onClick={() => portalActionsRef.current?.openSettings()}
                  title="Supabase / 단말 설정"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </>
            )}

            {activeTab === 'memory' && (
              <button
                data-help-key="btn-memory-settings"
                onClick={() => setOpenPortalSettings(true)}
                title="Supabase / 단말 설정"
                className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
              >
                <Settings className="w-4 h-4" />
              </button>
            )}

            {/* 포트 탭 전용 액션 버튼 (글로벌 위치) */}
            {activeTab === 'ports' && (
              <>
                <button data-help-key="btn-export-ports" onClick={handleExportPorts} title="내보내기" className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all">
                  <Upload className="w-4 h-4" />
                </button>
                <button data-help-key="btn-import-ports" onClick={handleImportPorts} title="불러오기" className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all">
                  <Download className="w-4 h-4" />
                </button>
                <button
                  data-testid="copy-batch-ai-name-chat-prompt"
                  onClick={handleCopyAiNamePrompt}
                  title="시간이 걸리는 전체 AI 이름·카테고리 생성 명령을 복사해 Claude 또는 Codex 채팅에 붙여넣습니다"
                  className="px-2.5 py-1.5 bg-[#111113] hover:bg-[#18181b] text-teal-300 rounded-xl border border-teal-400/20 hover:border-teal-400/40 transition-all flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">전체 AI 채팅 명령 복사</span>
                </button>
                <button data-help-key="btn-refresh" onClick={handleRefresh} disabled={isRefreshing || isAiEnriching} title={isAiEnriching ? 'AI 분석 중…' : '새로고침'} className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                  <RefreshCw className={`w-4 h-4 ${isRefreshing || isAiEnriching ? 'animate-spin' : ''}`} />
                </button>
                <div className="flex items-center rounded-xl border border-stone-800/40 overflow-hidden">
                  <button data-help-key="btn-supabase-push" data-testid="ports-supabase-push" onClick={handlePushToSupabase} disabled={isPushingPorts} title="프로젝트·폴더를 Supabase에 Push" className="px-2.5 py-1.5 bg-[#111113] hover:bg-[#18181b] text-[#f4f4f5]/90 text-sm border-r border-stone-800/40 transition-all flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
                    <CloudUpload className={`w-3.5 h-3.5 ${isPushingPorts ? 'animate-pulse' : 'text-indigo-400'}`} />
                    <span className="text-xs font-medium">Supabase Push</span>
                  </button>
                  <button data-help-key="btn-supabase-pull" data-testid="ports-supabase-pull" onClick={handleRestoreFromSupabase} disabled={isRestoring} title="Supabase에서 프로젝트·폴더 Pull" className="px-2.5 py-1.5 bg-[#111113] hover:bg-[#18181b] text-[#f4f4f5]/90 text-sm transition-all flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
                    <CloudDownload className={`w-3.5 h-3.5 ${isRestoring ? 'animate-pulse' : 'text-indigo-400'}`} />
                    <span className="text-xs font-medium">Supabase Pull</span>
                  </button>
                </div>
                <button
                  data-help-key="btn-history"
                  onClick={openPortsHistory}
                  title="Push 히스토리 / 복원"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Clock className="w-4 h-4" />
                </button>
                <button
                  data-help-key="btn-settings"
                  onClick={() => setOpenPortalSettings(true)}
                  title="Supabase / 단말 설정"
                  className="p-2 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-xl border border-stone-800/40 hover:border-stone-700/60 transition-all"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </>
            )}

          </div>

          {/* Right side controls - spacer to push right */}
          <div style={{flex:1}}/>

          {!isDeployedWeb() && browserProfiles.length > 0 && (
            <select
              data-testid="deployment-browser-profile"
              aria-label="웹 Chrome 프로필"
              value={selectedDeploymentBrowserProfile?.id ?? ''}
              onChange={event => {
                const profileId = event.target.value;
                setDeploymentBrowserProfileId(profileId);
                if (profileId) {
                  localStorage.setItem(DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY, profileId);
                } else {
                  localStorage.removeItem(DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY);
                }
              }}
              title={selectedDeploymentBrowserProfile
                ? `배포·GitHub URL을 ${browserProfileOptionLabel(selectedDeploymentBrowserProfile)} 프로필로 엽니다. CDP 연결 없이 기존 로그인 세션을 사용합니다.`
                : '배포·GitHub URL을 Chrome 기본 프로필로 엽니다.'}
              style={{
                maxWidth: 220,
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid #3f3f46',
                background: '#1a1a1c',
                color: selectedDeploymentBrowserProfile ? '#99f6e4' : '#71717a',
                fontSize: 10,
                fontFamily: 'inherit',
              }}
            >
              <option value="">웹 · Chrome 기본</option>
              {browserProfiles.map(profile => (
                <option key={profile.id} value={profile.id}>
                  {`웹 · ${browserProfileOptionLabel(profile)}`}
                </option>
              ))}
            </select>
          )}
          {/* 프로필을 고르는 자리에 여는 동작이 없어서, 고른 뒤 카드나 상세로 내려가
              「배포」 버튼을 다시 찾아야 했다(VOC 2026-08-15-2138). 프로필을 고르는
              이유가 그 프로필의 로그인 세션으로 배포본을 보는 것이므로, 고른 자리에서
              바로 열 수 있어야 한다. 여는 경로는 카드·상세와 **같은**
              `openDeploymentWithDiagnostics`다 — 프로필 적용과 실패 진단이 한 벌이어야 한다.
              ⚠️ 사이드바 선택(`v4SelectedId`)을 **전제로 삼지 말 것.** 그 값은 앱을 켤
              때마다 null이라, 처음 보이는 상태가 비활성 버튼이 된다 — 실제로 그렇게 내보내
              "작동 안 함"으로 돌아왔다. 선택이 없으면 배포 주소가 있는 프로젝트 목록을
              띄워 거기서 고르게 한다. */}
          {!isDeployedWeb() && (() => {
            const selected = v4SelectedId ? ports.find(p => p.id === v4SelectedId) ?? null : null;
            const target = selected
              ? deploymentTargets.find(item => item.id === selected.id) ?? null
              : null;
            const deployable = deploymentTargets
              .filter(item => item.id !== target?.id)
              .sort((a, b) => (a.aiName || a.name).localeCompare(b.aiName || b.name, 'ko'));
            const profileLabel = selectedDeploymentBrowserProfile
              ? browserProfileOptionLabel(selectedDeploymentBrowserProfile)
              : 'Chrome 기본';
            const empty = !target && deployable.length === 0;
            const openDeployment = (item: DeploymentTarget) => {
              setDeployPickerOpen(false);
              void openDeploymentWithDiagnostics(item);
            };
            return (
              <div style={{position:'relative',display:'flex',marginLeft:4}}>
                <button
                  data-testid="deployment-open-selected"
                  aria-label="배포본 열기"
                  aria-expanded={deployPickerOpen}
                  disabled={empty}
                  onClick={() => { if (target) openDeployment(target); else setDeployPickerOpen(v => !v); }}
                  title={empty
                    ? '현재 기기 프로젝트와 공유 포털에 배포 주소가 없습니다. 프로젝트 상세의 deploy 줄에 입력하세요.'
                    : target
                      ? `${target.name}의 배포본을 ${profileLabel} 프로필로 엽니다: ${target.deployUrl}`
                      : `배포 주소가 있는 프로젝트 ${deployable.length}개 중에서 골라 ${profileLabel} 프로필로 엽니다.`}
                  style={{
                    display:'inline-flex',alignItems:'center',gap:3,
                    padding:'3px 7px',borderRadius:6,border:'1px solid #3f3f46',
                    background:'#1a1a1c',color: empty ? '#52525b' : '#99f6e4',
                    cursor: empty ? 'not-allowed' : 'pointer',fontSize:10,fontFamily:'inherit',
                  }}
                >
                  <Globe style={{width:11,height:11}}/>
                  {target ? `배포본 열기 · ${target.aiName || target.name}` : '배포본 열기'}
                </button>
                {deployPickerOpen && !empty && (
                  <>
                    <div onClick={() => setDeployPickerOpen(false)} style={{position:'fixed',inset:0,zIndex:40}} />
                    <div data-testid="deployment-open-picker" style={{position:'absolute',top:'calc(100% + 6px)',right:0,zIndex:41,
                      minWidth:220,maxHeight:320,overflowY:'auto',padding:'6px 4px',borderRadius:7,
                      background:'#18181b',border:'1px solid #3f3f46',boxShadow:'0 8px 24px rgba(0,0,0,0.5)'}}>
                      <div style={{padding:'2px 8px 5px',fontSize:9,color:'#71717a',fontWeight:600}}>
                        {profileLabel} 프로필로 엽니다
                      </div>
                      {deployable.map(p => (
                        <button key={p.id} data-testid="deployment-open-picker-item"
                          onClick={() => openDeployment(p)}
                          title={p.deployUrl}
                          style={{display:'block',width:'100%',textAlign:'left',padding:'4px 8px',fontSize:11,
                            background:'transparent',border:'none',color:'#d4d4d8',cursor:'pointer',
                            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                          {p.aiName || p.name}
                          <span style={{color:'#52525b',marginLeft:5}}>{(p.deployUrl || '').replace(/^https?:\/\//, '')}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* Claude/Terminal Controls - 프로젝트 탭에서만 표시 */}
          {activeTab === 'ports' && (
            <div className="flex items-center gap-1.5">
              {/* Terminal app selector - compact */}
              <div style={{display:'flex', background:'#1a1a1c', border:'1px solid #3f3f46', borderRadius:6, overflow:'hidden'}}>
                {(isWindows()
                  ? (['powershell','orca','wsl'] as const)
                  : (['cmux','orca','iterm','terminal'] as const)
                ).map(app => (
                  <button key={app} data-testid={`terminal-app-${app}`} onClick={() => {
                    const defaults = terminalOptionDefaults(app, orcaLaunchMode);
                    setTerminalApp(app);
                    localStorage.setItem('portmanager-terminalApp', app);
                    setBgMode(defaults.bgMode);
                    setTmuxMode(defaults.tmuxMode);
                    setBypassPermissions(defaults.bypassPermissions);
                    localStorage.setItem('portmanager-bgMode', String(defaults.bgMode));
                    localStorage.setItem('portmanager-tmuxMode', String(defaults.tmuxMode));
                    localStorage.setItem('portmanager-terminalDefaultsVersion', TERMINAL_DEFAULTS_VERSION);
                  }}
                    style={{ padding:'2px 6px', fontSize:10, background: terminalApp===app ? '#3f3f46' : 'transparent',
                      color: terminalApp===app ? '#e4e4e7' : '#71717a', border:'none', cursor:'pointer', fontFamily:'inherit' }}>
                    {app}
                  </button>
                ))}
              </div>
              {/* Orca surface determines whether Claude --bg is available, so choose it first. */}
              {/* 라벨 칩과 감싸는 상자를 없애고 형제 버튼(Claude --bg, tmux)과 같은 높이·모양으로 맞춘다.
                  "워크트리 AI"라는 말과 한 겹 더 들어간 뎁스가 헤더에서 튀어 보였다. 설명은 title로. */}
              {terminalApp === 'orca' && (
                <div data-testid="orca-worktree-launch-mode" title="AI를 Orca 어디에서 실행할지 선택"
                  style={{display:'flex',alignItems:'center',gap:3}}>
                  {([
                    ['floating', '플로팅'],
                    ['worktree', '사이드바'],
                  ] as const).map(([mode, label]) => (
                    <button key={mode} data-testid={`orca-launch-mode-${mode}`}
                      onClick={() => {
                        setOrcaLaunchMode(mode);
                        localStorage.setItem('portmanager-orcaLaunchMode', mode);
                        // Floating은 Claude Agent View(--bg)를 기본으로 켜고,
                        // 워크트리 내부는 터미널 표면을 우회하지 않도록 반드시 끈다.
                        const nextBgMode = mode === 'floating';
                        setBgMode(nextBgMode);
                        localStorage.setItem('portmanager-bgMode', String(nextBgMode));
                      }}
                      title={mode === 'floating'
                        ? 'AI를 Orca의 독립 Floating Workspace에서 실행'
                        : 'AI를 Orca 좌측 프로젝트 사이드바의 해당 프로젝트 안에서 실행'}
                      style={{padding:'2px 6px',fontSize:10,borderRadius:4,border:'1px solid',cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',
                        background:orcaLaunchMode===mode?(mode==='floating'?'rgba(168,85,247,0.18)':'rgba(56,189,248,0.16)'):'transparent',
                        borderColor:orcaLaunchMode===mode?(mode==='floating'?'#7c3aed':'#0284c7'):'#3f3f46',
                        color:orcaLaunchMode===mode?(mode==='floating'?'#d8b4fe':'#7dd3fc'):'#52525b'}}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {(['cmux','orca','iterm','terminal','wsl'].includes(terminalApp))
                && isClaudeBgAvailable(terminalApp, orcaLaunchMode) && (
                <button
                  data-testid="claude-bg-toggle"
                  aria-label="Claude --bg 전환"
                  aria-pressed={claudeBgActive}
                  onClick={() => { const v=!bgMode; setBgMode(v); localStorage.setItem('portmanager-bgMode', String(v)); }}
                  title={claudeBgActive
                    ? `Claude를 --bg로 시작한 뒤 ${selectedTerminalSurface}에서 claude agents를 엽니다`
                    : `${selectedTerminalSurface}에서 일반 Claude 터미널을 엽니다`}
                  style={{ padding:'2px 6px', fontSize:10, borderRadius:4, border:'1px solid', cursor:'pointer', fontFamily:'inherit',
                    background: claudeBgActive ? '#2d1f42' : 'transparent',
                    borderColor: claudeBgActive ? '#7c3aed' : '#3f3f46',
                    color: claudeBgActive ? '#c4b5fd' : '#52525b' }}>
                  Claude --bg {claudeBgActive ? 'ON' : 'OFF'}
                </button>
              )}
              {/* 켜져 있는데 Claude에는 안 먹는 상태(bg ON)를 색·라벨로 드러낸다. 예전에는 초록 ON만
                  보여서 "tmux 켰는데 왜 세션이 없지?"를 반복하게 만들었다. */}
              {terminalApp !== 'orca' && terminalApp !== 'powershell' && (() => {
                const reach = tmuxReach(terminalApp, bgMode, orcaLaunchMode);
                const partial = tmuxMode && reach === 'codex-agy';
                return (
                  <button data-testid="tmux-toggle" data-tmux-reach={tmuxMode ? reach : 'off'}
                    onClick={() => { const v=!tmuxMode; setTmuxMode(v); localStorage.setItem('portmanager-tmuxMode', String(v)); }}
                    title={!tmuxMode
                      ? 'tmux 모드 OFF: 터미널 창을 닫으면 실행 중인 AI가 함께 종료됩니다'
                      : partial
                        ? 'tmux 모드 ON — Codex·agy에만 적용됩니다. Claude는 --bg(Agent View)로 실행되어 tmux를 거치지 않습니다. Claude도 tmux로 띄우려면 "Claude --bg"를 끄세요.'
                        : 'tmux 모드 ON: Claude·Codex·agy 모두 tmux 세션에서 실행 — 창을 닫아도(Ctrl-b d) 세션이 살아 있고 tmux attach -t <세션명>으로 복귀합니다'}
                    style={{ padding:'2px 6px', fontSize:10, borderRadius:4, border:'1px solid', cursor:'pointer', fontFamily:'inherit',
                      borderStyle: partial ? 'dashed' : 'solid',
                      background: tmuxMode ? (partial ? 'rgba(34,197,94,0.07)' : '#1f2d20') : 'transparent',
                      borderColor: tmuxMode ? (partial ? '#3f6212' : '#22c55e') : '#3f3f46',
                      color: tmuxMode ? (partial ? '#65a30d' : '#86efac') : '#52525b' }}>
                    {partial ? 'tmux (codex·agy)' : 'tmux'}
                  </button>
                );
              })()}
              {/* bypass toggle - compact */}              {/* bypass toggle - compact */}
              <button
                data-help-key="btn-bypass"
                data-testid="bypass-toggle"
                aria-pressed={bypassPermissions}
                onClick={() => {
                  if (bypassPermissions) {
                    setBypassPermissions(false);
                    return;
                  }
                  const confirmed = window.confirm(
                    '권한 우회를 켜면 AI가 승인 없이 파일·명령을 변경할 수 있습니다. 이 앱 세션에서만 켤까요?'
                  );
                  if (confirmed) setBypassPermissions(true);
                }}
                title={bypassPermissions ? '권한 우회 ON · 현재 앱 세션에만 적용' : '권한 우회 OFF (권장)'}
                style={{ padding:'2px 6px', fontSize:10, borderRadius:4, border:'1px solid', cursor:'pointer', fontFamily:'inherit',
                  background: bypassPermissions ? 'rgba(168,85,247,0.15)' : 'transparent',
                  borderColor: bypassPermissions ? 'rgba(168,85,247,0.4)' : '#3f3f46',
                  color: bypassPermissions ? '#c4b5fd' : '#52525b' }}
              >
                <Zap style={{width:10,height:10,display:'inline',verticalAlign:'middle',marginRight:2}} />
                {bypassPermissions ? '⚠ ON' : 'OFF'}
              </button>
            </div>
          )}

          {/* Utility controls - always visible */}
          <div className="flex items-center gap-1">
            {/* Global shortcut - Tauri only */}
            {isTauri() && (
              <button
                onClick={() => { setShortcutInput(globalShortcut); setShowShortcutModal(true); }}
                title={`${t(lang,'settings')}: ${globalShortcut}`}
                className="p-1.5 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-lg border border-stone-800/40 hover:border-stone-700/60 transition-all"
              >
                <Keyboard className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Settings wizard */}
            <button
              data-help-key="btn-setup-wizard"
              onClick={() => setShowSetupWizard(true)}
              title={t(lang, 'settings')}
              className="p-1.5 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-lg border border-stone-800/40 hover:border-stone-700/60 transition-all"
            >
              <Rocket className="w-3.5 h-3.5" />
            </button>
            {/* AI usage */}
            <button
              data-testid="btn-ai-usage"
              data-help-key="btn-ai-usage"
              onClick={() => setShowAiUsage(true)}
              title="Claude · Codex 사용량 보기"
              className="p-1.5 bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 rounded-lg border border-stone-800/40 hover:border-stone-700/60 transition-all"
            >
              <Gauge className="w-3.5 h-3.5" />
            </button>
            {/* Guide mode toggle */}
            <button
              data-help-key="btn-guide-toggle"
              onClick={() => setGuideMode(!guideMode)}
              title={guideMode ? t(lang, 'guideOn') : t(lang, 'guide')}
              className={`p-1.5 rounded-lg border transition-all ${
                guideMode
                  ? 'bg-amber-500 text-black border-amber-400 hover:bg-amber-400'
                  : 'bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 border-stone-800/40 hover:border-stone-700/60'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
            </button>
            {/* VOC — 화면에서 바로 개선 요청 남기기. 가이드 모드와 배타적으로 켠다:
                둘 다 전체 화면 오버레이라 동시에 켜지면 클릭을 서로 가로챈다. */}
            <button
              data-help-key="btn-voc-toggle"
              data-testid="voc-toggle"
              onClick={() => { setVocMode(v => !v); setGuideMode(false); }}
              title={vocMode ? '개선 요청 모드 켜짐 — 클릭하거나 끌어서 영역을 고르세요 (⌘/Ctrl+Shift+V)' : '개선 요청 남기기 — 클릭 또는 드래그로 영역 선택 · 팝업 위에서도 ⌘/Ctrl+Shift+V로 켤 수 있습니다'}
              className={`p-1.5 rounded-lg border transition-all ${
                vocMode
                  ? 'bg-amber-400 text-black border-amber-300 hover:bg-amber-300'
                  : 'bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 border-stone-800/40 hover:border-stone-700/60'
              }`}
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="voc-workflow-prompt-copy"
              onClick={() => {
                void navigator.clipboard.writeText(buildVocWorkflowPrompt({
                  projectPath: primaryProject?.folderPath,
                }))
                  .then(() => showToast('VOC 처리·머지·푸시·빌드·재실행 프롬프트를 복사했습니다', 'success'))
                  .catch(() => showToast('VOC 전체 작업 프롬프트 복사에 실패했습니다', 'error'));
              }}
              title="미처리 VOC 확인·개선부터 안전한 머지·푸시, 앱 재빌드·설치·재실행·설치본 검증까지 한 번에 요청하는 프롬프트 복사"
              className="flex items-center gap-1 px-2 py-1.5 bg-[#111113] hover:bg-[#18181b] text-zinc-400 hover:text-teal-200 rounded-lg border border-stone-800/40 hover:border-teal-500/30 transition-all text-[10px] whitespace-nowrap"
            >
              <Copy className="w-3 h-3" />
              VOC 처리→머지·푸시→빌드·열기
            </button>
            {/* 같은 자리의 자매 버튼 — 새 기능 없이 원격·로컬만 맞추고 다시 빌드할 때.
                여러 기기가 같은 브랜치에 push해 버전 커밋이 갈리는 일이 실제로 있어,
                VOC 처리와 분리된 동기화 전용 절차가 따로 필요하다(VOC 접수). */}
            <button
              type="button"
              data-testid="git-sync-workflow-prompt-copy"
              onClick={() => {
                void navigator.clipboard.writeText(buildGitSyncWorkflowPrompt({
                  projectPath: primaryProject?.folderPath,
                }))
                  .then(() => showToast('깃허브 최신화·머지·빌드·재실행 프롬프트를 복사했습니다', 'success'))
                  .catch(() => showToast('깃허브 동기화 프롬프트 복사에 실패했습니다', 'error'));
              }}
              title="원격·로컬 최신화와 안전한 머지·푸시부터 앱 재빌드·설치·재실행까지 한 번에 요청하는 프롬프트 복사 (새 기능 구현은 범위 밖)"
              className="flex items-center gap-1 px-2 py-1.5 bg-[#111113] hover:bg-[#18181b] text-zinc-400 hover:text-sky-200 rounded-lg border border-stone-800/40 hover:border-sky-500/30 transition-all text-[10px] whitespace-nowrap"
            >
              <Copy className="w-3 h-3" />
              깃허브 최신화·머지→빌드·열기
            </button>
            {/* 장기기억 아카이브 — 지운 프로젝트의 노하우를 읽는 유일한 창구 */}
            <button
              data-help-key="btn-memory-archive"
              data-testid="memory-archive-toggle"
              onClick={() => setShowMemoryArchive(true)}
              title="장기기억 아카이브 — 정리한 프로젝트에서 남긴 노하우 보기"
              className="p-1.5 rounded-lg border transition-all bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 border-stone-800/40 hover:border-stone-700/60"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
            {/* More menu */}
            <div className="relative" ref={toolsMenuRef}>
              <button
                onClick={() => setShowToolsMenu(!showToolsMenu)}
                title="More options"
                className={`p-1.5 rounded-lg border transition-all ${
                  showToolsMenu
                    ? 'bg-[#18181b] text-[#f4f4f5]/90 border-stone-700/60'
                    : 'bg-[#111113] hover:bg-[#18181b] text-zinc-500 hover:text-[#f4f4f5]/90 border-stone-800/40 hover:border-stone-700/60'
                }`}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {showToolsMenu && (
                <div style={{
                  position:'absolute', top:'100%', right:0, marginTop:4, zIndex:9999,
                  background:'#18181b', border:'1px solid rgba(255,255,255,0.12)', borderRadius:8,
                  padding:'4px 0', boxShadow:'0 12px 32px rgba(0,0,0,0.7)', minWidth:160
                }}>
                  {/* Log copy */}
                  <button
                    data-help-key="btn-copy-log"
                    onClick={() => { handleCopyLog(); setShowToolsMenu(false); }}
                    style={{
                      display:'flex', alignItems:'center', gap:8, padding:'7px 12px', width:'100%',
                      background:'transparent', border:'none', cursor:'pointer',
                      fontSize:12, color: logCopied ? '#4ade80' : '#f4f4f5', fontFamily:'inherit', textAlign:'left'
                    }}
                    onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.05)')}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                  >
                    {logCopied ? <Check style={{width:12,height:12}}/> : <Copy style={{width:12,height:12}}/>}
                    {logCopied ? t(lang, 'logCopied') : t(lang, 'copyLog')}
                  </button>
                  {/* Language toggle */}
                  <button
                    onClick={() => {
                      const next: Lang = lang === 'ko' ? 'en' : 'ko';
                      setLang(next);
                      localStorage.setItem('portmanager-lang', next);
                      setShowToolsMenu(false);
                    }}
                    style={{
                      display:'flex', alignItems:'center', gap:8, padding:'7px 12px', width:'100%',
                      background:'transparent', border:'none', cursor:'pointer',
                      fontSize:12, color:'#f4f4f5', fontFamily:'inherit', textAlign:'left'
                    }}
                    onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.05)')}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                  >
                    <Globe style={{width:12,height:12}}/>
                    {t(lang, 'langToggle')}
                  </button>
                  {/* App data directory */}
                  <button
                    onClick={() => { API.openAppDataDir(); setShowToolsMenu(false); }}
                    style={{
                      display:'flex', alignItems:'center', gap:8, padding:'7px 12px', width:'100%',
                      background:'transparent', border:'none', cursor:'pointer',
                      fontSize:12, color:'#f4f4f5', fontFamily:'inherit', textAlign:'left'
                    }}
                    onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.05)')}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                  >
                    <FolderOpen style={{width:12,height:12}}/>
                    {lang === 'ko' ? '앱 데이터 폴더' : 'App Data Folder'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <BuildInfoBadge className="ml-auto" />
        </div>

        {/* 포털 탭 — 처음 열기 전에는 동적 청크를 요청하지 않고, 이후에는 계속 마운트해 설정 상태를 유지한다. */}
        <div className={activeTab === 'portal' ? 'flex-1 overflow-auto' : ''}>
          {(portalHasMounted || activeTab === 'portal' || openPortalSettings) && (
            <Suspense fallback={null}>
              <PortalManager
                showToast={showToast}
                onOpenDeployUrl={url => API.openInChrome(url, selectedDeploymentBrowserProfile)}
                openSettings={openPortalSettings}
                onSettingsClosed={async () => {
                  setOpenPortalSettings(false);
                  // 설정 모달에서 deviceName 등이 변경됐을 수 있으므로 portalConfigRef 갱신
                  try {
                    let fresh: any = null;
                    if (isTauri()) {
                      const { invoke } = await import('@tauri-apps/api/core');
                      fresh = await invoke('load_portal');
                    } else {
                      const res = await fetch('/api/portal');
                      if (res.ok) fresh = await res.json();
                    }
                    if (fresh) cachePortalConfig(fresh);
                  } catch { /* ignore */ }
                  await refreshMemoryPortalCredentials();
                }}
                actionsRef={portalActionsRef}
                isVisible={activeTab === 'portal'}
              />
            </Suspense>
          )}
        </div>

        {activeTab === 'memory' && (
          <div data-testid="top-level-memory-view" className="flex-1 min-h-0 overflow-auto px-6 py-5">
            <h1 className="sr-only">AgentsToZ 장기기억</h1>
            <Suspense fallback={<div className="text-xs text-zinc-500">장기기억 현황판을 불러오는 중…</div>}>
              {memoryPortalCredentialsLoading ? (
                <div className="text-xs text-zinc-500">Supabase 연결 정보를 확인하는 중…</div>
              ) : memoryPortalCredentials ? (
                <PortalMemoryDirectory
                  supabaseUrl={memoryPortalCredentials.url}
                  supabaseKey={memoryPortalCredentials.key}
                  deviceName={memoryPortalCredentials.deviceName}
                  deviceId={memoryPortalCredentials.deviceId}
                  showToast={showToast}
                />
              ) : (
                <div className="max-w-lg rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
                  <div className="flex items-center gap-2 text-sm text-amber-100">
                    <Brain className="h-4 w-4" />장기기억 현황판을 사용하려면 Supabase 연결이 필요합니다.
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenPortalSettings(true)}
                    className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/15"
                  >
                    Supabase·단말 설정 열기
                  </button>
                </div>
              )}
            </Suspense>
          </div>
        )}

        {/* 경로 remapping 모달 — 다른 기기 Pull 후 경로 없는 포트 설정 */}
        {remappingPorts.length > 0 && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[90] flex items-center justify-center p-6">
            <div className="bg-[#09090b] border border-stone-700/80 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-stone-800/40 shrink-0">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-amber-400" />
                  경로 설정 필요 — {remappingPorts.length}개 프로젝트
                </h2>
                <p className="text-xs text-zinc-500 mt-1">다른 기기에서 가져온 프로젝트에 이 기기의 폴더 경로를 설정하세요. 나중에 개별 설정도 가능합니다.</p>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {remappingPorts.map(p => (
                  <div key={p.id} className="bg-[#18181b] border border-stone-800/40 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-white">{p.name}</span>
                      {p.port && <span className="text-xs text-zinc-500 font-mono">:{p.port}</span>}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={remappingPaths[p.id] ?? ''}
                        onChange={e => setRemappingPaths(prev => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="/Users/me/..."
                        className="flex-1 px-3 py-1.5 text-xs bg-black/40 border border-stone-700/50 text-white placeholder-zinc-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
                      />
                      <button
                        onClick={async () => {
                          try {
                            const res = await fetch('/api/pick-folder');
                            const { path } = await res.json();
                            if (path) setRemappingPaths(prev => ({ ...prev, [p.id]: path }));
                          } catch {}
                        }}
                        className="px-2.5 py-1.5 bg-[#18181b] hover:bg-[#202024] text-zinc-400 hover:text-[#f4f4f5] text-xs rounded-lg border border-stone-700/50 transition-all"
                        title="폴더 선택"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-stone-800/40 px-5 py-4 flex justify-between shrink-0">
                <button
                  onClick={() => setRemappingPorts([])}
                  className="px-4 py-2 text-sm text-zinc-500 hover:text-[#f4f4f5]/90 transition-colors"
                >
                  나중에 설정
                </button>
                <button
                  onClick={() => {
                    const updated = ports.map(p => {
                      const newPath = remappingPaths[p.id];
                      return newPath ? { ...p, folderPath: newPath } : p;
                    });
                    setPorts(updated);
                    API.savePorts(updated);
                    setRemappingPorts([]);
                    const count = Object.values(remappingPaths).filter(Boolean).length;
                    if (count > 0) showToast(`${count}개 경로 저장됨 ✓`, 'success');
                  }}
                  className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-semibold rounded-lg transition-all"
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Voice 시작을 확인하지 못했거나 프로젝트 이동이 pending인 경우만 표시한다. */}
        {projectVoiceGuide && (
          <div
            data-testid="project-codex-voice-guide"
            style={{ position: 'fixed', inset: 0, zIndex: 9600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, background: 'rgba(0,0,0,0.74)' }}
            onClick={() => setProjectVoiceGuide(null)}
          >
            <div
              style={{ width: 'min(520px, 100%)', maxHeight: '86vh', overflowY: 'auto', border: '1px solid rgba(94,234,212,0.36)', borderRadius: 12, background: '#101113', padding: 20, boxShadow: '0 22px 80px rgba(0,0,0,0.52)' }}
              onClick={event => event.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#99f6e4', fontSize: 12, fontWeight: 700 }}>
                    <Mic style={{ width: 14, height: 14 }} /> Codex Voice · 상태
                  </div>
                  <h2 style={{ margin: '5px 0 0', color: '#f4f4f5', fontSize: 16 }}>{projectVoiceGuide.targetName}</h2>
                </div>
                <button
                  type="button"
                  aria-label="Codex Voice 상태 닫기"
                  onClick={() => setProjectVoiceGuide(null)}
                  style={{ border: 0, background: 'transparent', color: '#a1a1aa', cursor: 'pointer', padding: 2 }}
                >
                  <XIcon style={{ width: 18, height: 18 }} />
                </button>
              </div>

              <div style={{ marginTop: 13, padding: '8px 10px', borderRadius: 7, background: 'rgba(9,9,11,0.75)', border: '1px solid rgba(255,255,255,0.08)', color: '#d4d4d8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5, overflowWrap: 'anywhere' }}>
                {projectVoiceGuide.folderPath}
              </div>

              {projectVoiceGuide.stage === 'start-failed' && (
                <>
                  <p style={{ margin: '13px 0 0', color: '#d4d4d8', fontSize: 12, lineHeight: 1.6 }}>
                    {projectVoiceGuide.errorCode === 'VOICE_PROJECT_TASK_NOT_READY'
                      ? <>선택 프로젝트의 ChatGPT 문맥을 확인하지 못해 <strong style={{ color: '#e4e4e7' }}>Voice 시작은 보내지 않았습니다.</strong> ChatGPT가 실행 중인지와 프로젝트 폴더 접근 상태를 확인하세요.</>
                      : projectVoiceGuide.errorCode === 'VOICE_START_CONTROL_UNAVAILABLE'
                        ? <>프로젝트 Codex 화면에 <strong style={{ color: '#e4e4e7' }}>새 Voice를 시작할 수 있는 ChatGPT 컨트롤이 준비되지 않아 시작 요청을 보내지 않았습니다.</strong> 최근 전역 Voice를 임의로 재개하지 않도록 자동 단축키 우회는 사용하지 않습니다.</>
                        : projectVoiceGuide.errorCode === 'VOICE_GLOBAL_START_CONTROL_UNAVAILABLE'
                          ? <>프로젝트 Composer와 전역 Voice 화면 모두에서 <strong style={{ color: '#e4e4e7' }}>자동으로 누를 수 있는 Voice 컨트롤을 찾지 못했습니다.</strong> ChatGPT를 열어 평소처럼 Voice를 직접 시작한 뒤 프로젝트 이동을 요청할 수 있습니다.</>
                        : projectVoiceGuide.dispatch === 'button-pressed' || projectVoiceGuide.dispatch === 'global-button-pressed'
                          ? <>ChatGPT의 Voice 시작 컨트롤은 눌렀지만 <strong style={{ color: '#e4e4e7' }}>새 Voice 생성 또는 기존 Voice 재개 기록을 확인하지 못했습니다.</strong> 이 경우에만 ChatGPT의 Voice 상태와 마이크 권한을 확인하세요.</>
                          : <>ChatGPT Voice 시작 요청을 보내지 못했습니다. 아래 오류 내용을 확인한 뒤 다시 시도하세요.</>}
                  </p>
                  {projectVoiceGuide.error && (
                    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 7, background: 'rgba(127,29,29,0.2)', border: '1px solid rgba(252,165,165,0.28)', color: '#fecaca', fontSize: 11.5, lineHeight: 1.55 }}>
                      {projectVoiceGuide.error}
                    </div>
                  )}
                  <ol style={{ margin: '10px 0 0', paddingLeft: 19, color: '#a1a1aa', fontSize: 11.5, lineHeight: 1.7 }}>
                    {projectVoiceGuide.errorCode === 'VOICE_START_CONTROL_UNAVAILABLE'
                      ? <>
                        <li>ChatGPT 프로젝트 Composer에 <strong>Start new voice chat</strong>이 나타나는지 확인하세요.</li>
                        <li>아래 전역 Voice 시작/재개는 다른 최근 Voice를 열 수 있으므로, 프로젝트 연결이 아직 없다는 점을 확인한 뒤에만 누르세요.</li>
                      </>
                      : projectVoiceGuide.errorCode === 'VOICE_GLOBAL_START_CONTROL_UNAVAILABLE'
                        ? <>
                          <li>아래 버튼으로 ChatGPT를 열고 Voice를 직접 시작하세요.</li>
                          <li>Voice가 켜지면 복사한 문구를 말하거나 붙여넣어 이 프로젝트로 이동을 요청하세요.</li>
                        </>
                      : projectVoiceGuide.dispatch === 'button-pressed' || projectVoiceGuide.dispatch === 'global-button-pressed'
                        ? <>
                          <li>ChatGPT에서 기존 Voice 상태와 Voice·마이크 권한을 확인하세요.</li>
                          <li>기록이 생긴 뒤에도 이 프로젝트 연결은 별도로 확인해야 합니다.</li>
                        </>
                        : <>
                          <li>운영체제의 손쉬운 사용 및 ChatGPT 자동화 권한을 확인하세요.</li>
                          <li>다시 시도해도 안 되면 아래 프로젝트 Codex 작업에서 텍스트로 진행할 수 있습니다.</li>
                        </>}
                  </ol>
                </>
              )}

              {projectVoiceGuide.stage === 'recovery' && (
                <>
                  <p style={{ margin: '13px 0 0', color: '#fecaca', fontSize: 12, lineHeight: 1.6 }}>
                    이 프로젝트로 이동을 요청한 Voice 대화가 있지만 ChatGPT가 아직 적용하지 않았습니다. 현재 실행 폴더는 임시 폴더이므로, 이 대화에서 파일을 만들거나 수정하면 선택한 프로젝트가 아닌 곳에 반영될 수 있습니다.
                  </p>
                  <p style={{ margin: '9px 0 0', color: '#a1a1aa', fontSize: 11.5, lineHeight: 1.55 }}>
                    복구 안내를 현재 Voice에 붙여넣어 임시 폴더 수정을 막을 수 있습니다. 프로젝트 결합이 적용된 뒤에만 이 버튼으로 다시 재개하세요.
                  </p>
                </>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 16 }}>
                <button
                  type="button"
                  data-testid="project-codex-voice-open-project-task"
                  onClick={() => void openProjectVoiceSetupTask()}
                  style={{ border: 0, borderRadius: 7, padding: '8px 11px', background: '#5eead4', color: '#082f2b', cursor: 'pointer', fontSize: 11.5, fontWeight: 700 }}
                >
                  프로젝트 Codex 작업 열기
                </button>
                <button
                  type="button"
                  data-testid="project-codex-voice-copy-scope-check"
                  onClick={() => void copyProjectVoiceGuideText('scope-check')}
                  style={{ border: '1px solid rgba(94,234,212,0.35)', borderRadius: 7, padding: '8px 10px', background: 'rgba(13,148,136,0.12)', color: '#99f6e4', cursor: 'pointer', fontSize: 11.5 }}
                >
                  범위 확인 프롬프트 복사
                </button>
                {projectVoiceGuide.stage === 'start-failed' && projectVoiceGuide.errorCode === 'VOICE_GLOBAL_START_CONTROL_UNAVAILABLE' && (
                  <button
                    type="button"
                    data-testid="project-codex-voice-open-chatgpt"
                    onClick={() => void openChatGptVoiceFromGuide()}
                    style={{ border: '1px solid rgba(96,165,250,0.4)', borderRadius: 7, padding: '8px 10px', background: 'rgba(30,64,175,0.16)', color: '#bfdbfe', cursor: 'pointer', fontSize: 11.5 }}
                    title="ChatGPT를 열어 Voice를 직접 시작합니다"
                  >
                    ChatGPT Voice 열기
                  </button>
                )}
                {projectVoiceGuide.stage === 'recovery' && (
                  <button
                    type="button"
                    data-testid="project-codex-voice-copy-recovery"
                    onClick={() => void copyProjectVoiceGuideText('recovery')}
                    style={{ border: '1px solid rgba(251,191,36,0.3)', borderRadius: 7, padding: '8px 10px', background: 'rgba(120,53,15,0.18)', color: '#fde68a', cursor: 'pointer', fontSize: 11.5 }}
                  >
                    복구 안내 복사
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 글로벌 단축키 설정 모달 */}
        {showShortcutModal && (
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:9500,display:'flex',alignItems:'center',justifyContent:'center'}}
            onClick={() => setShowShortcutModal(false)}>
            <div style={{background:'#111113',border:'1px solid rgba(255,255,255,0.12)',borderRadius:12,padding:24,width:360,display:'flex',flexDirection:'column',gap:16}}
              onClick={e => e.stopPropagation()}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:14,fontWeight:600,color:'#f4f4f5'}}>앱 열기 단축키</span>
                <button onClick={() => setShowShortcutModal(false)} style={{background:'transparent',border:'none',cursor:'pointer',color:'#71717a'}}><XIcon style={{width:14,height:14}}/></button>
              </div>
              <p style={{fontSize:12,color:'#71717a',margin:0}}>입력란 클릭 후 원하는 키 조합을 누르세요.</p>
              <input
                style={{padding:'8px 12px',background:'#0a0a0b',border:'1px solid rgba(255,255,255,0.12)',borderRadius:6,color:'#f4f4f5',fontSize:13,fontFamily:'JetBrains Mono, monospace'}}
                value={isRecordingShortcut ? '키를 누르세요...' : shortcutInput}
                readOnly
                placeholder="예: CommandOrControl+Alt+P"
                onFocus={() => setIsRecordingShortcut(true)}
                onBlur={() => setIsRecordingShortcut(false)}
                onKeyDown={e => {
                  e.preventDefault();
                  const isModifier = ['Meta','Control','Alt','Shift'].includes(e.key);
                  if (isModifier) return;
                  const parts: string[] = [];
                  if (e.metaKey) parts.push('CommandOrControl'); // ⌘ Cmd
                  else if (e.ctrlKey) parts.push('Control');      // ⌃ Ctrl (별도)
                  if (e.altKey) parts.push('Alt');                // ⌥ Option
                  if (e.shiftKey) parts.push('Shift');
                  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
                  if (parts.length >= 2) {
                    setShortcutInput(parts.join('+'));
                    setIsRecordingShortcut(false);
                  }
                }}
              />
              <p style={{fontSize:11,color:'#3f3f46',margin:0}}>예시: CommandOrControl+Alt+P (⌘⌥P), CommandOrControl+Shift+Space</p>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={() => setShowShortcutModal(false)} style={{padding:'6px 14px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:12}}>취소</button>
                <button onClick={async () => {
                  if (!shortcutInput) return;
                  try {
                    await API.setGlobalShortcut(shortcutInput, globalShortcut);
                    setGlobalShortcut(shortcutInput);
                    setShowShortcutModal(false);
                    showToast(`단축키 설정: ${shortcutInput}`, 'success');
                  } catch(e: any) {
                    showToast('단축키 설정 실패: ' + e.message, 'error');
                  }
                }} style={{padding:'6px 14px',background:'#5eead4',border:'none',borderRadius:6,color:'#0a0a0b',cursor:'pointer',fontSize:12,fontWeight:600}}>저장</button>
              </div>
            </div>
          </div>
        )}

        {/* 프로젝트 빠른 추가 모달 — 배포 웹/모바일에서도 폴더 피커 없이 추가 가능 */}
        {showQuickAddModal && (
          <div
            style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:9500,display:'flex',alignItems:isMobile?'flex-end':'center',justifyContent:'center'}}
            onClick={closeQuickAddModal}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background:'#111113',border:'1px solid rgba(255,255,255,0.12)',
                borderRadius: isMobile ? '14px 14px 0 0' : 12,
                padding: isMobile ? '20px 18px 24px' : 24,
                width: isMobile ? '100%' : 380,
                maxHeight: isMobile ? '85vh' : 'auto',
                overflowY: 'auto',
                display:'flex',flexDirection:'column',gap:12,
              }}
            >
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:15,fontWeight:600,color:'#f4f4f5'}}>프로젝트 추가</span>
                <button onClick={closeQuickAddModal} style={{background:'transparent',border:'none',cursor:'pointer',color:'#71717a',padding:4}}>
                  <XIcon style={{width:16,height:16}}/>
                </button>
              </div>
              <p style={{fontSize:11,color:'#71717a',margin:0,lineHeight:1.5}}>
                폴더 경로·실행 명령은 데스크톱 앱에서 설정. 여기선 메타데이터(이름·URL 등)만 입력해도 충분합니다.
              </p>
              {(() => {
                const inpStyle = {
                  padding: isMobile ? '10px 12px' : '7px 10px',
                  background:'#0a0a0b',
                  border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:6,
                  color:'#f4f4f5',
                  fontSize: isMobile ? 16 : 13,
                  fontFamily:'inherit',
                  width:'100%',
                  boxSizing:'border-box' as const,
                };
                const lbl = (s: string) => <span style={{fontSize:11,color:'#a1a1aa',marginBottom:2}}>{s}</span>;
                return (
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    <label style={{display:'flex',flexDirection:'column'}}>
                      {lbl('이름 *')}
                      <input
                        autoFocus
                        type="text"
                        value={qaName}
                        onChange={e => setQaName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && qaName.trim()) saveQuickAddProject(); else if (e.key === 'Escape') closeQuickAddModal(); }}
                        placeholder="프로젝트 이름"
                        style={inpStyle}
                      />
                    </label>
                    <label style={{display:'flex',flexDirection:'column'}}>
                      {lbl('포트 (선택)')}
                      <div style={{display:'flex',gap:6}}>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={qaPort}
                          onChange={e => setQaPort(e.target.value)}
                          placeholder="예: 9000"
                          style={{...inpStyle,flex:1}}
                        />
                        <button
                          type="button"
                          onClick={() => suggestPort(setQaPort)}
                          title="빈 포트 추천 (9000번대)"
                          style={{padding:'0 10px',background:'transparent',border:'1px solid rgba(255,255,255,0.12)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:12,whiteSpace:'nowrap' as const}}
                        >추천</button>
                      </div>
                    </label>
                    <label style={{display:'flex',flexDirection:'column'}}>
                      {lbl('배포 주소 (선택)')}
                      <input
                        type="url"
                        value={qaDeployUrl}
                        onChange={e => setQaDeployUrl(e.target.value)}
                        placeholder="https://..."
                        style={inpStyle}
                      />
                    </label>
                    <div style={{display:'flex',flexDirection:'column',gap:4}}>
                      <span>{lbl('GitHub 저장소 주소 (선택)')}</span>
                      <GitHubUrlInputs
                        value={qaGithubUrl}
                        onChange={setQaGithubUrl}
                        onOpen={url => { void API.openInChrome(url, selectedDeploymentBrowserProfile).catch(error => showToast(`GitHub 열기 실패: ${error instanceof Error ? error.message : String(error)}`, 'error')); }}
                        inputStyle={inpStyle}
                      />
                    </div>
                    <label style={{display:'flex',flexDirection:'column'}}>
                      {lbl('카테고리 (선택)')}
                      <input
                        type="text"
                        value={qaCategory}
                        onChange={e => setQaCategory(e.target.value)}
                        placeholder="예: 프로젝트, 도구, 실험"
                        style={inpStyle}
                      />
                    </label>
                    <label style={{display:'flex',flexDirection:'column'}}>
                      {lbl('설명 (선택)')}
                      <input
                        type="text"
                        value={qaDescription}
                        onChange={e => setQaDescription(e.target.value)}
                        placeholder="한 줄 설명"
                        style={inpStyle}
                      />
                    </label>
                  </div>
                );
              })()}
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:4}}>
                <button
                  onClick={closeQuickAddModal}
                  style={{padding: isMobile?'10px 16px':'7px 14px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:isMobile?14:12}}
                >취소</button>
                <button
                  onClick={saveQuickAddProject}
                  disabled={!qaName.trim()}
                  style={{
                    padding: isMobile?'10px 18px':'7px 16px',
                    background: qaName.trim() ? '#4ade80' : 'rgba(74,222,128,0.3)',
                    border:'none',borderRadius:6,
                    color:'#0a0a0b',cursor: qaName.trim() ? 'pointer' : 'not-allowed',
                    fontSize: isMobile?14:12,fontWeight:600,
                  }}
                >추가</button>
              </div>
            </div>
          </div>
        )}

        {showCleanupReview && (
          <div
            style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:9500,display:'flex',alignItems:isMobile?'flex-end':'center',justifyContent:'center'}}
            onClick={() => setShowCleanupReview(false)}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background:'#111113',border:'1px solid rgba(255,255,255,0.12)',
                borderRadius: isMobile ? '14px 14px 0 0' : 12,
                padding: isMobile ? '20px 18px 24px' : 24,
                width: isMobile ? '100%' : 440,
                maxHeight: isMobile ? '85vh' : '70vh',
                overflowY: 'auto',
                display:'flex',flexDirection:'column',gap:10,
              }}
            >
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:15,fontWeight:600,color:'#f4f4f5'}}>정리 검토 — {staleDays}일 이상 미사용</span>
                <button onClick={() => setShowCleanupReview(false)} style={{background:'transparent',border:'none',cursor:'pointer',color:'#71717a',padding:4}}>
                  <XIcon style={{width:16,height:16}}/>
                </button>
              </div>
              <p style={{fontSize:11,color:'#71717a',margin:0,lineHeight:1.5}}>
                {staleDays}일 이상 활동(앱에서 열기 또는 git 커밋)이 없는 프로젝트입니다. 계속 쓸 프로젝트는 즐겨찾기로 표시해 제외하고, 안 쓰는 프로젝트는 삭제하세요.
              </p>
              {/* 기준 일수는 사람마다 다르다 — 30일 고정은 누군가에겐 이르고 누군가에겐 늦다. */}
              <div style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'#a1a1aa'}}>
                <span>기준</span>
                <input
                  data-testid="cleanup-stale-days"
                  type="number"
                  min={1}
                  max={3650}
                  value={staleDays}
                  onChange={e => applyStaleDays(Number(e.target.value))}
                  style={{width:64,padding:'3px 6px',background:'#09090b',border:'1px solid rgba(255,255,255,0.12)',borderRadius:5,color:'#f4f4f5',fontSize:11,fontFamily:'inherit'}}
                />
                <span>일 이상 미사용</span>
                <span style={{flex:1}} />
                <span data-testid="cleanup-count" style={{color:'#f87171'}}>{v3IdleStale.length}개</span>
              </div>
              {v3IdleStale.length === 0 ? (
                <div style={{padding:'24px 0',textAlign:'center',color:'#71717a',fontSize:12}}>정리 대상이 없습니다.</div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {v3IdleStale.map(item => {
                    // 행 라벨도 소그룹 분류와 **같은 기준**이어야 한다. 예전에는 여기만
                    // lastVisits를 봐서, 4일 전 커밋한 프로젝트가 "방문 기록 없음"으로 떴다.
                    const last = lastActivityFor(item.id);
                    const label = last ? `${Math.floor((Date.now() - last) / 86400000)}일 전 활동` : '활동 기록 없음';
                    return (
                      <div key={item.id} style={{display:'flex',flexDirection:'column',gap:6}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px',background:'#09090b',border:'1px solid rgba(255,255,255,0.07)',borderRadius:6}}>
                        <div style={{flex:1,overflow:'hidden'}}>
                          <div style={{fontSize:12.5,color:'#f4f4f5',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}{item.port ? <span style={{color:'#5eead4'}}> :{item.port}</span> : null}</div>
                          <div style={{fontSize:10.5,color:'#71717a'}}>{label}</div>
                        </div>
                        <button
                          onClick={() => toggleFavorite(item)}
                          title="즐겨찾기로 표시 (정리 대상에서 제외)"
                          style={{padding:'4px 6px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center'}}
                        ><Star style={{width:12,height:12}}/></button>
                        <button
                          data-testid="cleanup-delete"
                          onClick={() => setCleanupConfirmId(prev => prev === item.id ? null : item.id)}
                          title="삭제 — 로컬만 지울지, Supabase까지 지울지 고릅니다"
                          style={{padding:'4px 6px',background:'rgba(248,113,113,0.12)',border:'1px solid rgba(248,113,113,0.3)',borderRadius:5,color:'#f87171',cursor:'pointer',display:'flex',alignItems:'center'}}
                        ><Trash2 style={{width:12,height:12}}/></button>
                      </div>
                      {/* 삭제는 되돌릴 수 없으므로 무엇이 지워지는지 먼저 보여준다.
                          장기기억은 어느 쪽을 고르든 **먼저 자동 보관**된다 — 지우기가
                          두려우면 정리 검토 자체가 작동하지 않는다. */}
                      {cleanupConfirmId === item.id && (
                        <div data-testid="cleanup-confirm" style={{display:'flex',flexDirection:'column',gap:6,padding:'8px 10px',marginTop:-2,background:'rgba(248,113,113,0.05)',border:'1px solid rgba(248,113,113,0.22)',borderRadius:6}}>
                          <span style={{fontSize:10.5,color:'#a1a1aa',lineHeight:1.5}}>
                            {item.folderPath
                              ? '장기기억이 있으면 아카이브에 보관한 뒤 삭제합니다.'
                              : '폴더 경로가 없어 보관할 장기기억이 없습니다.'}
                          </span>
                          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                            <button
                              data-testid="cleanup-delete-local"
                              onClick={() => { setCleanupConfirmId(null); void cleanupProject(item, { deleteRemote: false }); }}
                              style={{padding:'4px 9px',background:'rgba(248,113,113,0.14)',border:'1px solid rgba(248,113,113,0.35)',borderRadius:5,color:'#f87171',cursor:'pointer',fontSize:10.5,fontFamily:'inherit'}}
                            >로컬만 삭제</button>
                            <button
                              data-testid="cleanup-delete-remote"
                              onClick={() => { setCleanupConfirmId(null); void cleanupProject(item, { deleteRemote: true }); }}
                              title="Supabase portmgr_ports 에서 이 프로젝트 행도 지웁니다 (id 기준 — 다른 기기 소유 행도 정리됩니다)"
                              style={{padding:'4px 9px',background:'rgba(248,113,113,0.2)',border:'1px solid rgba(248,113,113,0.5)',borderRadius:5,color:'#fca5a5',cursor:'pointer',fontSize:10.5,fontWeight:600,fontFamily:'inherit'}}
                            >Supabase 포트 정보까지 삭제</button>
                            <button
                              data-testid="cleanup-cancel"
                              onClick={() => setCleanupConfirmId(null)}
                              style={{padding:'4px 9px',background:'transparent',border:'1px solid rgba(255,255,255,0.12)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',fontSize:10.5,fontFamily:'inherit'}}
                            >취소</button>
                          </div>
                        </div>
                      )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 로컬에서 지운 포트는 id가 사라져 다음 push의 stale-delete 대상도 되지
                  못한다. 그렇게 회수 불가가 된 원격 행을 여기서만 정리할 수 있다. */}
              <details data-testid="cleanup-orphans" style={{marginTop:6,padding:'7px 9px',borderRadius:6,border:'1px solid rgba(255,255,255,0.09)',background:'rgba(255,255,255,0.015)'}}>
                <summary style={{cursor:'pointer',fontSize:11.5,color:'#a1a1aa',fontWeight:600}}>
                  Supabase 잔여 정리 <span style={{fontWeight:400,color:'#52525b'}}>— 포트는 지웠는데 원격에만 남은 행</span>
                </summary>
                <div style={{marginTop:7,display:'flex',flexDirection:'column',gap:6}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <button
                      data-testid="cleanup-orphan-scan"
                      onClick={() => void scanSupabaseOrphans()}
                      disabled={orphanBusy === 'scan'}
                      style={{padding:'3px 9px',background:'rgba(125,211,252,0.1)',border:'1px solid rgba(125,211,252,0.3)',borderRadius:5,color:'#7dd3fc',cursor:orphanBusy==='scan'?'wait':'pointer',fontSize:11,fontFamily:'inherit'}}
                    >{orphanBusy === 'scan' ? '조회 중…' : '원격 조회'}</button>
                    {orphanError && <span style={{fontSize:10.5,color:'#f87171'}}>{orphanError}</span>}
                  </div>
                  {orphanGroups !== null && orphanGroups.length === 0 && !orphanError && (
                    <span data-testid="cleanup-orphan-empty" style={{fontSize:11,color:'#52525b'}}>원격에만 남은 행이 없습니다.</span>
                  )}
                  {(orphanGroups ?? []).map(group => (
                    <div key={group.key} data-testid="cleanup-orphan-group" style={{display:'flex',alignItems:'center',gap:8,padding:'6px 8px',background:'#09090b',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,color: group.reclaimable ? '#fca5a5' : '#a1a1aa'}}>{group.label}</div>
                        <div style={{fontSize:10,color:'#52525b',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {group.rows.length}개 · {group.rows.slice(0, 3).map(r => r.name).join(', ')}{group.rows.length > 3 ? ' …' : ''}
                        </div>
                      </div>
                      <button
                        data-testid={group.reclaimable ? 'cleanup-orphan-delete' : 'cleanup-orphan-delete-other'}
                        onClick={() => void deleteOrphanGroup(group)}
                        disabled={orphanBusy === group.key}
                        title={group.reclaimable
                          ? '이 행들은 어떤 기기의 push로도 회수되지 않습니다.'
                          : '⚠ 다른 기기가 소유한 행입니다. 그 기기에서 아직 쓰고 있다면 목록에서 사라집니다.'}
                        style={{padding:'3px 8px',flexShrink:0,
                          background: group.reclaimable ? 'rgba(248,113,113,0.16)' : 'transparent',
                          border:'1px solid', borderColor: group.reclaimable ? 'rgba(248,113,113,0.4)' : 'rgba(255,255,255,0.14)',
                          borderRadius:5,color: group.reclaimable ? '#fca5a5' : '#71717a',
                          cursor: orphanBusy === group.key ? 'wait' : 'pointer',fontSize:10.5,fontFamily:'inherit'}}
                      >{orphanBusy === group.key ? '삭제 중…' : '삭제'}</button>
                    </div>
                  ))}
                </div>
              </details>
              <div style={{display:'flex',justifyContent:'flex-end',marginTop:4}}>
                <button
                  onClick={() => setShowCleanupReview(false)}
                  style={{padding: isMobile?'10px 16px':'7px 14px',background:'transparent',border:'1px solid rgba(255,255,255,0.1)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',fontSize:isMobile?14:12}}
                >닫기</button>
              </div>
            </div>
          </div>
        )}

        {/* Draws `title` tooltips ourselves — Tauri's webview never renders the native ones. */}
        <TitleTipHost suspended={guideMode} />

        {showAiUsage && (
          <Suspense fallback={null}>
            <AiUsagePanel
              onClose={() => setShowAiUsage(false)}
              canOpenProject={canOpenContextProject}
              onOpenProject={openContextProject}
              contextProjectCandidates={contextProjectCandidates}
              onOpenAgentView={openContextAgentView}
            />
          </Suspense>
        )}

        {/* 선택 오버레이는 배율이 적용된 #root 밖에 둔다. 안에 두면 125%에서 36px
            배너가 45px이 되고 pointer clientX/Y와 halo 좌표가 다시 갈라진다. */}
        {guideMode && typeof document !== 'undefined' && createPortal(
          <Suspense fallback={null}>
            <GuideOverlay guideMode={guideMode} setGuideMode={setGuideMode} />
          </Suspense>,
          document.body,
        )}

        {vocMode && typeof document !== 'undefined' && createPortal(
          <Suspense fallback={null}>
            <VocOverlay
              onClose={() => setVocMode(false)}
              onSubmit={submitVoc}
              tab={activeTab}
              appVersion={`v${BUILD_INFO.buildNumber} ${BUILD_INFO.version}`.trim()}
              remoteUnlimited={vocRemoteUnlimited}
            />
          </Suspense>,
          document.body,
        )}
        {vocAppBlock && typeof document !== 'undefined' && createPortal(
          <div
            data-testid="voc-app-blocked"
            style={{
              position:'fixed',inset:0,zIndex:50000,display:'flex',alignItems:'center',justifyContent:'center',
              padding:24,background:'rgba(5,5,7,0.97)',fontFamily:"'Inter Tight',system-ui,sans-serif",
            }}
          >
            <div style={{width:'min(480px,100%)',padding:24,border:'1px solid rgba(248,113,113,0.35)',borderRadius:12,background:'#18181b',boxShadow:'0 24px 70px rgba(0,0,0,0.65)'}}>
              <h2 style={{margin:'0 0 10px',fontSize:20,color:'#fca5a5'}}>이 설치본의 앱 사용이 제한되었습니다</h2>
              <p style={{margin:'0 0 8px',fontSize:13,lineHeight:1.65,color:'#d4d4d8'}}>
                반복적인 허위·스팸 VOC 등 운영 정책 위반이 감지된 설치본입니다. 기기 파일이나 프로젝트 데이터는 삭제되지 않습니다.
              </p>
              {vocAppBlock.expiresAt && (
                <p style={{margin:'0 0 12px',fontSize:11.5,color:'#a1a1aa'}}>차단 만료: {new Date(vocAppBlock.expiresAt).toLocaleString()}</p>
              )}
              <button
                onClick={() => void refreshVocAccess()}
                style={{padding:'8px 14px',borderRadius:6,border:'1px solid rgba(94,234,212,0.35)',background:'rgba(94,234,212,0.12)',color:'#5eead4',fontSize:12,cursor:'pointer',fontFamily:'inherit'}}
              >
                차단 상태 다시 확인
              </button>
            </div>
          </div>,
          document.body,
        )}
        {showMemoryArchive && (
          <Suspense fallback={null}>
            <MemoryArchivePanel
              onClose={() => setShowMemoryArchive(false)}
              onOpenFolder={path => { void API.openFolder(path).catch(e => showToast(`폴더 열기 실패: ${e.message}`, 'error')); }}
              onToast={showToast}
            />
          </Suspense>
        )}

        {/* 삭제 확인 모달 */}
        {deleteConfirmId && (() => {
          const target = ports.find(p => p.id === deleteConfirmId);
          return (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4" onClick={() => setDeleteConfirmId(null)}>
              <div className="bg-[#111113] border border-stone-700/50 rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-center shrink-0">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">포트 삭제</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">이 작업은 되돌릴 수 없습니다</p>
                  </div>
                </div>
                <p className="text-sm text-[#f4f4f5]/90 mb-2">
                  <span className="text-white font-medium">"{target?.name ?? deleteConfirmId}"</span> 포트를 삭제하시겠습니까?
                </p>
                {/* 정리 검토와 **같은 두 갈래**를 준다. 예전에는 여기서만 로컬을 지워서,
                    Supabase에 행이 남고 로컬에는 id가 사라지는 고아가 생겼다 — 그 행은
                    다음 push의 stale-delete 대상도 되지 못해 영영 회수 불가가 된다.
                    장기기억은 어느 쪽이든 먼저 아카이브에 보관된다. */}
                <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed">
                  {target?.folderPath
                    ? '장기기억이 있으면 아카이브에 보관한 뒤 삭제합니다.'
                    : '폴더 경로가 없어 보관할 장기기억이 없습니다.'}
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    data-testid="delete-confirm-remote"
                    onClick={() => { const t = target; setDeleteConfirmId(null); if (t) void cleanupProject(t, { deleteRemote: true }); }}
                    title="Supabase portmgr_ports 에서 이 프로젝트 행도 지웁니다 (id 기준)"
                    className="w-full py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl border border-red-500 transition-all"
                  >Supabase 포트 정보까지 삭제</button>
                  <button
                    data-testid="delete-confirm-local"
                    onClick={() => { const t = target; setDeleteConfirmId(null); if (t) void cleanupProject(t, { deleteRemote: false }); else handleConfirmDelete(deleteConfirmId); }}
                    className="w-full py-2 bg-[#2a1416] hover:bg-[#361a1d] text-red-300 text-sm rounded-xl border border-red-500/40 transition-all"
                  >로컬만 삭제</button>
                  <button
                    data-testid="delete-confirm-cancel"
                    onClick={() => setDeleteConfirmId(null)}
                    className="w-full py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-xl border border-stone-700/50 transition-all"
                  >취소</button>
                </div>
              </div>
            </div>
          );
        })()}

        {deleteRootConfirmId && (() => {
          const root = workspaceRoots.find(item => item.id === deleteRootConfirmId);
          const rootName = root?.name || root?.path || deleteRootConfirmId;
          return (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4" onClick={() => setDeleteRootConfirmId(null)}>
              <div className="bg-[#111113] border border-stone-700/50 rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-center shrink-0">
                    <FolderOpen className="w-4 h-4 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">루트 폴더 제거</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">목록에서만 제거되며 폴더는 삭제되지 않습니다</p>
                  </div>
                </div>
                <p className="text-sm text-[#f4f4f5]/90 mb-5">
                  <span className="text-white font-medium">"{rootName}"</span> 루트 폴더를 목록에서 제거하시겠습니까?
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteRootConfirmId(null)} className="flex-1 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-xl border border-stone-700/50 transition-all">취소</button>
                  <button onClick={() => { handleRemoveWorkspaceRoot(deleteRootConfirmId); setDeleteRootConfirmId(null); }} className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl border border-red-500 transition-all">제거</button>
                </div>
              </div>
            </div>
          );
        })()}

        {folderRenamePromptTargetId && (() => {
          const target = ports.find(port => port.id === folderRenamePromptTargetId);
          if (!target?.folderPath) return null;
          const problem = projectFolderNameProblem(target.folderPath, folderRenameInput);
          return (
            <div
              data-testid="folder-rename-prompt-modal"
              className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[310] flex items-center justify-center p-4"
              onClick={() => { setFolderRenamePromptTargetId(null); setFolderRenameInput(''); }}
            >
              <div className="bg-[#111113] border border-teal-400/25 rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={event => event.stopPropagation()}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 bg-teal-400/10 border border-teal-400/20 rounded-xl flex items-center justify-center shrink-0">
                    <Copy className="w-4 h-4 text-teal-300" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">폴더명 변경 프롬프트</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">새 이름을 넣으면 안전 점검이 포함된 AI 명령을 복사합니다</p>
                  </div>
                </div>
                <div className="text-[11px] text-zinc-500 font-mono bg-black/20 border border-white/5 rounded-lg px-3 py-2 mb-3 break-all">
                  {target.folderPath}
                </div>
                <label htmlFor="folder-rename-prompt-name" className="text-xs text-zinc-400 mb-1.5 block">새 폴더 이름</label>
                <input
                  id="folder-rename-prompt-name"
                  data-testid="folder-rename-prompt-name"
                  autoFocus
                  value={folderRenameInput}
                  onChange={event => setFolderRenameInput(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && !problem) void confirmCopyProjectFolderRenamePrompt(); }}
                  className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-teal-400/50"
                />
                {problem && <p data-testid="folder-rename-prompt-problem" className="text-[11px] text-amber-300 mt-1.5 mb-0">{problem}</p>}
                <p className="text-[11px] text-zinc-600 mt-2 mb-4">상위 경로는 유지됩니다. 실제 변경은 복사한 프롬프트를 AI 채팅에 붙여넣어 실행합니다.</p>
                <div className="flex gap-2">
                  <button onClick={() => { setFolderRenamePromptTargetId(null); setFolderRenameInput(''); }} className="flex-1 py-2 bg-[#18181b] hover:bg-[#202024] text-[#f4f4f5]/90 text-sm rounded-xl border border-stone-700/50 transition-all">취소</button>
                  <button
                    data-testid="folder-rename-prompt-copy"
                    onClick={() => { void confirmCopyProjectFolderRenamePrompt(); }}
                    disabled={!!problem}
                    className="flex-1 py-2 bg-teal-500 hover:bg-teal-400 disabled:opacity-40 disabled:cursor-not-allowed text-[#071311] font-semibold text-sm rounded-xl border border-teal-400 transition-all"
                  >프롬프트 복사</button>
                </div>
              </div>
            </div>
          );
        })()}

        {wslSetupStatus && (
          <WslSetupModal
            status={wslSetupStatus}
            onClose={() => setWslSetupStatus(null)}
            onInstallTmux={handleInstallWslTmux}
            showToast={showToast}
          />
        )}

        {showSetupWizard && (
          <Suspense fallback={null}>
          <SetupWizard
            hasExistingDevice={Boolean(
              portalConfigRef.current?.supabaseUrl
              && portalConfigRef.current?.deviceId
              && !portalConfigRef.current?.pendingDeviceRegistration
            )}
            onComplete={async ({ supabaseUrl, supabaseAnonKey, deviceName, deviceId, setupKind, localAdminReady }) => {
              // 추가 단말은 포털/다른 PC의 ID를 이어받지 않는다. 이 앱이 자기 UUID를
              // 만든 뒤 로컬 관리자 연결까지 확인하고서만 DB에 단말 행을 만든다.
              try {
                const existing = isTauri()
                  ? (await (async () => { const { invoke } = await import('@tauri-apps/api/core'); return invoke('load_portal'); })())
                  : await getPortalCredentials();
                const existingObj = (existing as any) || {};
                if ((setupKind === 'first' || setupKind === 'additional') && isTauri() && !localAdminReady) {
                  throw new Error('로컬 관리자 연결 확인이 끝나지 않았습니다. Supabase CLI 자동 연결을 먼저 완료하세요.');
                }
                if (setupKind === 'additional' && existingObj.deviceId && existingObj.supabaseUrl && !existingObj.pendingDeviceRegistration) {
                  throw new Error('이 앱은 이미 단말로 등록되어 있습니다. 추가 단말 연결은 새 Mac·Windows에 설치한 앱에서 실행하세요.');
                }
                const finalDeviceId = setupKind === 'additional'
                  ? (existingObj.pendingDeviceRegistration && existingObj.deviceId ? existingObj.deviceId : deviceId || crypto.randomUUID())
                  : deviceId || existingObj.deviceId || crypto.randomUUID();
                const next = {
                  ...existingObj,
                  supabaseUrl,
                  supabaseAnonKey,
                  deviceName,
                  ...(finalDeviceId ? { deviceId: finalDeviceId } : {}),
                  ...(setupKind === 'additional' ? { pendingDeviceRegistration: true } : {}),
                };
                const persistPortal = async (value: Record<string, unknown>) => {
                  if (isTauri()) {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('save_portal', { data: value });
                  } else {
                    const response = await fetch('/api/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
                    if (!response.ok) throw new Error(`portal.json 저장 HTTP ${response.status}`);
                  }
                };
                await persistPortal(next);
                cachePortalConfig(next);
                if (setupKind === 'additional' && isTauri() && finalDeviceId) {
                  const registration = await fetch('http://127.0.0.1:3001/api/supabase-proxy/rest/v1/portmgr_devices?on_conflict=id', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Prefer: 'resolution=merge-duplicates,return=minimal',
                    },
                    body: JSON.stringify({ id: finalDeviceId, name: deviceName, last_push_at: new Date().toISOString() }),
                  });
                  if (!registration.ok) {
                    const detail = await registration.text().catch(() => '');
                    throw new Error(`새 단말 등록 실패 (${registration.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
                  }
                  // DB upsert가 확인된 뒤에만 pending을 해제한다. 응답 단절·재시작 시에는
                  // 같은 ID로 안전하게 재시도되어 빈 단말 행이 늘어나지 않는다.
                  const completed = { ...next, pendingDeviceRegistration: false, deviceRegisteredAt: new Date().toISOString() };
                  await persistPortal(completed);
                  cachePortalConfig(completed);
                }
                // 데스크톱은 local sidecar가 service_role을 주입하므로 사용자 로그인이 없다.
                // 로컬/배포 웹만 Google JWT와 서버 허용 이메일을 확인한다.
                if (!isTauri()) {
                  const supabase = getSupabaseClient(supabaseUrl, supabaseAnonKey);
                  const { data: currentAuth, error: currentAuthError } = await supabase.auth.getSession();
                  if (currentAuthError) throw currentAuthError;
                  if (!currentAuth.session) {
                    const authOptions = { onStatus: (status: string) => showToast(status, 'success') };
                    await signInBrowserSupabase(supabase, authOptions);
                  }
                  const { data: isMember, error: authorizationError } = await supabase.rpc('portmgr_is_member');
                  if (authorizationError || isMember !== true) {
                    throw new Error(
                      `Google 로그인은 됐지만 DB 허용 목록이 거부했습니다${authorizationError ? `: ${describeSupabaseError(authorizationError)}` : '.'}`,
                    );
                  }
                }
                try { localStorage.setItem(SETUP_WIZARD_SEEN_KEY, '1'); } catch {}
                showToast(`${deviceName} 설정 완료! 새 단말로 동기화를 시작합니다.`, 'success');
                setShowSetupWizard(false);
                setActiveTab('portal');
              } catch (e) {
                showToast(`${isTauri() ? '설정 실패' : '설정 또는 Google 로그인 실패'}: ${e}`, 'error');
                throw e;
              }
            }}
            onSkip={() => {
              try { localStorage.setItem(SETUP_WIZARD_SEEN_KEY, '1'); } catch {}
              setShowSetupWizard(false);
            }}
          />
          </Suspense>
        )}

        {/* 포트 관리 탭 - V3 Sidebar */}
        {activeTab === 'ports' && (
          <div style={{flex:1,display:'flex',minHeight:0,overflow:'hidden'}}>
            {/* LEFT SIDEBAR — 터미널 뷰에서 숨김 */}
            {false && <div style={{
              width:240,flexShrink:0,display:'flex',flexDirection:'column',
              background:'#111113',borderRight:'1px solid rgba(255,255,255,0.07)',
              overflowY:'auto' as const,
            }}>
              {/* Logo */}
              <div style={{
                padding:'16px 12px 12px',display:'flex',alignItems:'center',gap:8,
                borderBottom:'1px solid rgba(255,255,255,0.07)',
              }}>
                <div style={{
                  width:22,height:22,borderRadius:6,background:'#5eead4',
                  display:'flex',alignItems:'center',justifyContent:'center',
                  fontSize:11,fontWeight:700,fontFamily:'JetBrains Mono, monospace',color:'#09090b',
                }}>{t(lang, 'appNameShort')}</div>
                <span style={{fontSize:13,fontWeight:600,color:'#f4f4f5'}}>{t(lang, 'appName')}</span>
              </div>

              {/* Search */}
              <div style={{padding:'10px 8px'}}>
                <div style={{position:'relative'}}>
                  <Search style={{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',width:12,height:12,color:'#71717a'}} />
                  <input
                    data-help-key="sidebar-search"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t(lang, 'search')}
                    style={{
                      width:'100%',paddingLeft:26,paddingRight:8,paddingTop:6,paddingBottom:6,
                      background:'#18181b',border:'1px solid rgba(255,255,255,0.07)',
                      borderRadius:6,color:'#f4f4f5',fontSize:12,
                      fontFamily:'Inter Tight, system-ui, sans-serif',boxSizing:'border-box' as const,
                    }}
                  />
                </div>
              </div>

              {/* Section nav */}
              {([
                {id:'all',    label: t(lang,'sectionAll'),        count: ports.length,                              Icon: Server},
                {id:'running',label: t(lang,'sectionRunning'),    count: ports.filter((p:PortInfo)=>p.isRunning).length,      Icon: Play},
                {id:'recent', label: t(lang,'sectionRecent'),     count: (() => { const cutoff = Date.now() - 7*86400000; return ports.filter((p:PortInfo)=>{ const last = lastActivityFor(p.id); return !!last && last >= cutoff; }).length; })(), Icon: History},
                {id:'starred',label: t(lang,'sectionStarred'),    count: ports.filter((p:PortInfo)=>p.favorite).length,       Icon: Star},
                {id:'wt',     label: t(lang,'sectionWorktrees'),  count: ports.filter((p:PortInfo)=>!!p.worktreePath).length, Icon: GitBranch},
                {id:'stale',  label: t(lang,'sectionStale'),      count: (() => { const cutoff = Date.now() - 14*86400000; return ports.filter((p:PortInfo)=>{ const last = lastActivityFor(p.id); return !last || last < cutoff; }).length; })(), Icon: Clock},
              ] as const).map(({id,label,count,Icon}) => (
                <button key={id} data-help-key={`sidebar-${id === 'wt' ? 'worktrees' : id}`} onClick={() => setSidebarSection(id)} title={id==='wt' ? '실행한 적 있는 워크트리 수 (git worktree 전체 개수와 다를 수 있음)' : undefined} style={{
                  display:'flex',alignItems:'center',gap:8,
                  padding:'6px 8px',margin:'0 4px',borderRadius:5,cursor:'pointer',
                  background: sidebarSection === id ? '#18181b' : 'transparent',
                  color: sidebarSection === id ? '#f4f4f5' : '#a1a1aa',
                  border:'none',fontSize:12.5,
                  fontFamily:'Inter Tight, system-ui, sans-serif',textAlign:'left' as const,
                }}>
                  <Icon style={{width:12,height:12,flexShrink:0}} />
                  <span style={{flex:1}}>{label}</span>
                  <span style={{fontSize:11,color:'#71717a',fontFamily:'JetBrains Mono, monospace'}}>{count}</span>
                </button>
              ))}

              {/* Tags */}
              {(() => {
                const tags = [...new Set(ports.map((p:PortInfo)=>p.category).filter(Boolean) as string[])]
                  .sort((a,b) => ports.filter((p:PortInfo)=>p.category===b).length - ports.filter((p:PortInfo)=>p.category===a).length)
                  .slice(0,12);
                if (!tags.length) return null;
                return (
                  <>
                    <div style={{
                      padding:'12px 12px 4px',fontSize:10,
                      fontFamily:'JetBrains Mono, monospace',
                      color:'#71717a',textTransform:'uppercase' as const,letterSpacing:0.5,
                    }} data-help-key="sidebar-tags">{t(lang, 'sectionTags')}</div>
                    {tags.map((tag:string) => {
                      const n = ports.filter((p:PortInfo)=>p.category===tag).length;
                      const active = sidebarSection === `tag:${tag}`;
                      return (
                        <button key={tag} onClick={() => setSidebarSection(`tag:${tag}`)} style={{
                          display:'flex',alignItems:'center',gap:8,
                          padding:'5px 8px',margin:'0 4px',borderRadius:5,cursor:'pointer',
                          background: active ? '#18181b' : 'transparent',
                          color: active ? '#f4f4f5' : '#a1a1aa',
                          border:'none',fontSize:12,textAlign:'left' as const,
                          fontFamily:'Inter Tight, system-ui, sans-serif',
                        }}>
                          <span style={{width:7,height:7,borderRadius:2,background:'#5eead4',opacity:0.5,flexShrink:0}} />
                          <span style={{flex:1,fontFamily:'JetBrains Mono, monospace',fontSize:11}}>{tag}</span>
                          <span style={{fontSize:11,color:'#71717a',fontFamily:'JetBrains Mono, monospace'}}>{n}</span>
                        </button>
                      );
                    })}
                  </>
                );
              })()}

              {/* Workspace Roots Panel — Vercel 배포에서는 숨김 */}
              {!isDeployedWeb() && <div style={{marginTop:'auto',borderTop:'1px solid rgba(255,255,255,0.07)'}}>
                <button
                  data-help-key="workspace-roots"
                  onClick={() => setWorkspaceRootsOpen(v => !v)}
                  style={{
                    display:'flex',alignItems:'center',gap:6,width:'100%',
                    padding:'8px 12px',background:'transparent',border:'none',cursor:'pointer',
                    color:'#71717a',
                  }}
                >
                  {workspaceRootsOpen
                    ? <ChevronDown style={{width:11,height:11}}/>
                    : <ChevronDown style={{width:11,height:11,transform:'rotate(-90deg)'}}/>
                  }
                  <span style={{fontSize:10,fontFamily:'JetBrains Mono, monospace',textTransform:'uppercase' as const,letterSpacing:0.5,flex:1,textAlign:'left' as const}}>
                    작업 루트
                  </span>
                  {workspaceRoots.length > 0 && (
                    <span style={{fontSize:9,fontFamily:'JetBrains Mono, monospace',color:'#71717a',background:'rgba(255,255,255,0.06)',padding:'1px 5px',borderRadius:3}}>
                      {workspaceRoots.length}
                    </span>
                  )}
                </button>

                {workspaceRootsOpen && (
                  <div style={{paddingBottom:8}}>
                    {workspaceRoots.map((root: WorkspaceRoot, rootIndex: number) => {
                      const projectCount = ports.filter((p: PortInfo) => p.folderPath?.startsWith(root.path)).length;
                      return (
                        <div key={root.id} style={{display:'flex',alignItems:'center',gap:4,padding:'3px 8px 3px 20px'}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:11,fontFamily:'JetBrains Mono, monospace',color:'#d4d4d8',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>
                              {root.name}
                            </div>
                            <div style={{fontSize:9.5,fontFamily:'JetBrains Mono, monospace',color:'#71717a',whiteSpace:'nowrap' as const,overflow:'hidden',textOverflow:'ellipsis'}}>
                              {root.path}
                            </div>
                          </div>
                          {projectCount > 0 && (
                            <span style={{fontSize:9,fontFamily:'JetBrains Mono, monospace',color:'#71717a',background:'rgba(255,255,255,0.06)',padding:'1px 4px',borderRadius:3,flexShrink:0}}>
                              {projectCount}
                            </span>
                          )}
                          <div style={{display:'flex',flexDirection:'column',gap:1,flexShrink:0}}>
                            <button
                              type="button"
                              data-testid={`workspace-root-move-up-${root.id}`}
                              disabled={rootIndex === 0}
                              onClick={() => moveWorkspaceRoot(root.id, -1)}
                              title="위로 이동"
                              style={{padding:0,width:14,height:10,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'none',color:'#71717a',cursor:rootIndex===0?'not-allowed':'pointer',opacity:rootIndex===0?0.25:1}}
                            ><ChevronUp style={{width:9,height:9}}/></button>
                            <button
                              type="button"
                              data-testid={`workspace-root-move-down-${root.id}`}
                              disabled={rootIndex === workspaceRoots.length - 1}
                              onClick={() => moveWorkspaceRoot(root.id, 1)}
                              title="아래로 이동"
                              style={{padding:0,width:14,height:10,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'none',color:'#71717a',cursor:rootIndex===workspaceRoots.length-1?'not-allowed':'pointer',opacity:rootIndex===workspaceRoots.length-1?0.25:1}}
                            ><ChevronDown style={{width:9,height:9}}/></button>
                          </div>
                          <button
                            data-help-key="workspace-new-folder"
                            onClick={() => { setActiveRootId(root.id); setShowNewProjectModal(true); }}
                            title="새 프로젝트 폴더"
                            style={{padding:'2px 6px',background:'rgba(94,234,212,0.1)',border:'1px solid rgba(94,234,212,0.2)',borderRadius:4,color:'#5eead4',cursor:'pointer',fontSize:10,fontFamily:'Inter Tight, system-ui, sans-serif',flexShrink:0}}
                          >
                            새 폴더
                          </button>
                          <button
                            onClick={() => setDeleteRootConfirmId(root.id)}
                            title="루트 제거"
                            style={{padding:'2px 4px',background:'transparent',border:'none',color:'#71717a',cursor:'pointer',display:'flex',alignItems:'center',flexShrink:0}}
                          >
                            <XIcon style={{width:10,height:10}}/>
                          </button>
                        </div>
                      );
                    })}
                    <div data-help-key="workspace-add-root" style={{ margin: '5px 8px 0 20px' }}>
                      <FolderDropZone
                        compact
                        testId="workspace-root-dropzone"
                        label="폴더를 드래그해 루트 추가"
                        hint="또는 클릭"
                        onChoose={handleAddWorkspaceRoot}
                        onFolderPath={addWorkspaceRootFromPath}
                        onError={message => showToast(message, 'error')}
                      />
                    </div>
                  </div>
                )}
              </div>}
            </div>}

            {/* MAIN AREA */}
            <div style={{flex:1,display:'flex',flexDirection:'column',minHeight:0,overflow:'hidden'}}>
              {/* Main header */}
              <div data-testid="project-main-header" style={{
                flexShrink:0,padding:isMobile?'10px 12px':'14px 28px 12px',
                display:'flex',alignItems:'center',gap:10,
                // 새 프로젝트는 오른쪽에 고정하고 나머지 도구는 **줄바꿈**으로 넘긴다.
                flexWrap:'nowrap',
                // ⚠️ overflow 를 숨기지 말 것. 여기 도구들(업데이트 배지·AI 표시 설정)은
                // 아래로 열리는 팝오버를 갖는데, 헤더가 잘라 내면 클릭은 먹었는데 아무것도
                // 안 뜨는 상태가 된다 — VOC "업데이트 버튼이 안 눌러진다"가 이것이었다
                // (실측: 팝오버 y 224~420, 잘리는 경계 221 → 보이는 높이 -3px).
                overflow:'visible',
                borderBottom:'1px solid rgba(255,255,255,0.07)',
              }}>
                <h1 data-help-key="header-section-title" style={{margin:0,fontSize:18,fontWeight:600,letterSpacing:-0.3,color:'#f4f4f5',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0}}>
                  {sidebarSection === 'all' ? t(lang,'sectionAll')
                    : sidebarSection === 'running' ? t(lang,'sectionRunning')
                    : sidebarSection === 'starred' ? t(lang,'sectionStarred')
                    : sidebarSection === 'wt' ? t(lang,'sectionWorktrees')
                    : sidebarSection === 'stale' ? t(lang,'sectionStale')
                    : sidebarSection.startsWith('tag:') ? sidebarSection.slice(4)
                    : t(lang,'sectionAll')}
                </h1>
                <span data-help-key="header-project-count" style={{fontSize:12,color:'#a1a1aa',whiteSpace:'nowrap',flexShrink:0}}>{v3Ports.length} {t(lang,'projects')}</span>
                {/* 가로 스크롤이 아니라 줄바꿈이다. 스크롤바를 숨긴 채 넘치게 두면(실측
                    1000px 폭에서 내용 795px / 보이는 폭 445px) 뒤쪽 버튼 절반이 그냥 없는
                    것이 되고, 잘린 자리가 하필 New project 왼쪽이라 "New project 가 버튼을
                    가린다"로 읽힌다. 줄바꿈은 헤더를 한 줄 키우는 대신 전부 보이게 한다. */}
                <div data-testid="project-main-actions" className="ui-toolbar-scroll" style={{display:'flex',alignItems:'center',gap:10,rowGap:8,flexWrap:'wrap',flex:1,minWidth:0}}>
                {!isMobile && (
                  <BulkUpgradeButton
                    folderPaths={upgradeScanFolderPaths}
                    githubMissingPaths={githubMissingFolderPaths}
                    onApplyGithubUrls={applyDetectedGithubUrls}
                    onToast={showToast}
                  />
                )}
                {/* 화면 배율 — "글씨가 너무 작다"가 반복 접수됐다. 폰트만 키우면 px 로 고정된
                    여백·아이콘이 따라오지 않아 글자가 버튼을 넘치므로 배율로 함께 키운다. */}
                <div data-testid="header-ui-zoom" data-zoom={uiZoom} style={{display:'flex',alignItems:'center',gap:2,padding:'2px 4px',borderRadius:6,border:'1px solid rgba(255,255,255,0.09)',background:'rgba(255,255,255,0.025)',flexShrink:0}}>
                  <button
                    data-testid="header-ui-zoom-out"
                    aria-label="화면 작게"
                    disabled={uiZoom <= UI_ZOOM_MIN}
                    onClick={() => setUiZoom(zoomOut)}
                    title="화면 작게 (⌘−)"
                    style={{padding:'2px 6px',background:'none',border:'none',color:uiZoom<=UI_ZOOM_MIN?'#3f3f46':'#a1a1aa',cursor:uiZoom<=UI_ZOOM_MIN?'not-allowed':'pointer',fontSize:13,fontFamily:'inherit',lineHeight:1}}
                  >−</button>
                  <button
                    data-testid="header-ui-zoom-reset"
                    onClick={() => setUiZoom(UI_ZOOM_DEFAULT)}
                    title={`화면 배율 · 기본값으로 (⌘0) · 현재 ${formatZoom(uiZoom)}`}
                    style={{minWidth:38,padding:'2px 2px',background:'none',border:'none',color:'#a1a1aa',cursor:'pointer',fontSize:10.5,fontWeight:600,fontFamily:'inherit',fontVariantNumeric:'tabular-nums'}}
                  >{formatZoom(uiZoom)}</button>
                  <button
                    data-testid="header-ui-zoom-in"
                    aria-label="화면 크게"
                    disabled={uiZoom >= UI_ZOOM_MAX}
                    onClick={() => setUiZoom(zoomIn)}
                    title="화면 크게 (⌘+)"
                    style={{padding:'2px 6px',background:'none',border:'none',color:uiZoom>=UI_ZOOM_MAX?'#3f3f46':'#a1a1aa',cursor:uiZoom>=UI_ZOOM_MAX?'not-allowed':'pointer',fontSize:13,fontFamily:'inherit',lineHeight:1}}
                  >+</button>
                </div>
                <button data-help-key="header-terminal-root" data-testid="header-terminal-root" onClick={openSelectedTerminalAtRoot} title={`${terminalApp} 터미널로 HOME 열기`} style={{padding:'5px 9px',background:'rgba(255,255,255,0.025)',border:'1px solid rgba(255,255,255,0.09)',borderRadius:6,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:4,fontSize:11,fontWeight:600,fontFamily:'Inter Tight, system-ui, sans-serif',whiteSpace:'nowrap'}}>
                  <SquareTerminal style={{width:13,height:13}} />
                  {terminalApp}
                </button>
                <div
                  data-testid="header-agent-launcher"
                  aria-label={`AI 빠른 실행 · ${terminalApp}`}
                  style={{display:'flex',alignItems:'stretch',background:'rgba(15,15,18,0.72)',border:'1px solid rgba(200,168,240,0.18)',borderRadius:7,overflow:'hidden',boxShadow:'0 1px 0 rgba(255,255,255,0.025) inset'}}
                >
                  <button data-help-key="header-cmux-agent-view" data-testid="header-agents-launch" onClick={openCmuxAgentView}
                    title={`${terminalApp}에서 멀티 에이전트 보기 열기 (HOME 기준)`}
                    style={headerAgentButtonStyle('#93c5fd')}>
                    <LayoutGrid style={{width:12,height:12}} />
                    agents
                  </button>
                  {agentShown('claude') && (
                    <button data-testid="header-claude-launch" onClick={openClaudeAtDotClaude}
                      title={`~/.claude에서 Claude 실행 · ${terminalApp}${bgMode?' · Agent View':''}${bypassPermissions?' · 권한 우회 ON':''}`}
                      style={headerAgentButtonStyle('#d8b4fe', true)}>
                      <Sparkles style={{width:12,height:12}} />
                      Claude
                    </button>
                  )}
                  {agentShown('codex') && (
                    <button data-testid="header-codex-launch" onClick={openCodexAtDotCodex}
                      title={`~/.codex에서 Codex 실행 · ${terminalApp}${bypassPermissions?' · 권한 우회 ON':''}`}
                      style={headerAgentButtonStyle('#6ee7b7', true)}>
                      <SquareTerminal style={{width:12,height:12}} />
                      Codex
                    </button>
                  )}
                  {agentShown('agy') && (
                    <button data-testid="header-agy-launch" onClick={openAgyAtHome}
                      title={`HOME에서 Antigravity(agy) 실행 · ${terminalApp}${bypassPermissions?' · 권한 우회 ON':''}`}
                      style={headerAgentButtonStyle('#fdba74', true)}>
                      <Zap style={{width:12,height:12}} />
                      agy
                    </button>
                  )}
                  {agentShown('hermes') && (
                    <button data-testid="header-hermes-launch" onClick={openHermesAtDotHermes}
                      title={`~/.hermes에서 Hermes 실행 · ${terminalApp}`}
                      style={headerAgentButtonStyle('#fcd34d', true)}>
                      <Sparkles style={{width:12,height:12}} />
                      Hermes
                    </button>
                  )}
                </div>
                {/* 표시 설정은 **자기가 제어하는 버튼 줄 안에** 둔다. 다른 줄에 두었더니
                    "그런 기능이 없다"로 읽혔다 — 설정은 대상 옆에 있어야 발견된다. */}
                <div style={{position:'relative',display:'flex'}}>
                  <button
                    data-testid="agent-visibility-toggle"
                    aria-expanded={agentVisibilityOpen}
                    aria-label="표시할 AI 고르기"
                    onClick={() => setAgentVisibilityOpen(v => !v)}
                    title="실행 버튼에 표시할 AI를 고릅니다 (이 기기에만 적용)"
                    style={{...headerAgentButtonStyle(hiddenAgents.size > 0 ? '#fbbf24' : '#71717a', true),
                      paddingLeft:7,paddingRight:7}}>
                    <SlidersHorizontal style={{width:12,height:12}} />
                    {hiddenAgents.size > 0 ? `${ALL_LAUNCH_AGENTS.length - hiddenAgents.size}/${ALL_LAUNCH_AGENTS.length}` : ''}
                  </button>
                  {agentVisibilityOpen && (
                    <>
                      {/* 바깥 클릭으로 닫기 */}
                      <div onClick={() => setAgentVisibilityOpen(false)}
                        style={{position:'fixed',inset:0,zIndex:40}} />
                      <div style={{position:'absolute',top:'calc(100% + 6px)',right:0,zIndex:41,minWidth:170,
                        padding:'6px 4px',borderRadius:7,background:'#18181b',border:'1px solid #3f3f46',
                        boxShadow:'0 8px 24px rgba(0,0,0,0.5)'}}>
                        <div style={{padding:'2px 8px 5px',fontSize:9,color:'#71717a',fontWeight:600}}>
                          {describeVisibleLaunchAgents(hiddenAgents)}
                        </div>
                        {ALL_LAUNCH_AGENTS.map(agent => (
                          <label key={agent} data-testid={`agent-visibility-${agent}`}
                            style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px',fontSize:11,
                              color:'#d4d4d8',cursor:'pointer',whiteSpace:'nowrap'}}>
                            <input type="checkbox" checked={agentShown(agent)}
                              onChange={() => toggleAgentShown(agent)}
                              style={{width:12,height:12,accentColor:'#7c3aed',cursor:'pointer'}} />
                            {LAUNCH_AGENT_LABELS[agent]}
                          </label>
                        ))}
                        <div style={{padding:'4px 8px 2px',fontSize:9,color:'#52525b',borderTop:'1px solid #27272a',marginTop:4}}>
                          체크 해제하면 이 AI의 실행·앱 버튼이 모든 화면에서 숨겨집니다 · 이 기기에만 적용
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {!isTauri() && !isDeployedWeb() && (
                  isWindows() ? (
                    <>
                      <button data-help-key="header-build-windows" onClick={handleBuildWindows} disabled={isBuilding} title="Windows 빌드 (.exe)" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:3,fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif'}}>
                        <Monitor style={{width:13,height:13}} className={isBuilding && buildType==='windows' ? 'animate-spin' : ''} />
                        {t(lang, 'buildWin')}
                      </button>
                      <button onClick={() => API.openBuildFolder().catch(e=>showToast(`폴더 열기 실패: ${e.message}`, 'error'))} title="빌드 폴더 열기" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:3,fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif'}}>
                        <FolderOpen style={{width:13,height:13}} />
                        {t(lang, 'openBuildFolder')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button data-help-key="header-build-app" onClick={handleBuildApp} disabled={isBuilding} title="앱 빌드 (.app)" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:3,fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif'}}>
                        <Terminal style={{width:13,height:13}} className={isBuilding && buildType==='app' ? 'animate-spin' : ''} />
                        앱 빌드
                      </button>
                      <button data-help-key="header-build-dmg" onClick={handleBuildDmg} disabled={isBuilding} title="DMG 빌드" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:3,fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif'}}>
                        <Package style={{width:13,height:13}} className={isBuilding && buildType==='dmg' ? 'animate-spin' : ''} />
                        DMG
                      </button>
                      <button onClick={() => API.openBuildFolder().catch(e=>showToast(`폴더 열기 실패: ${e.message}`, 'error'))} title="빌드 폴더 열기" style={{padding:'5px 8px',background:'transparent',border:'1px solid rgba(255,255,255,0.07)',borderRadius:5,color:'#a1a1aa',cursor:'pointer',display:'flex',alignItems:'center',gap:3,fontSize:11,fontFamily:'Inter Tight, system-ui, sans-serif'}}>
                        <FolderOpen style={{width:13,height:13}} />
                        폴더 열기
                      </button>
                    </>
                  )
                )}
                </div>
                {!isDeployedWeb() && (
                  <button
                    data-help-key="header-new-project"
                    data-testid="header-new-project"
                    onClick={() => { setActiveRootId(workspaceRoots[0]?.id ?? null); setShowNewProjectModal(true); }}
                    style={{
                      padding:'5px 12px',background:'#5eead4',border:'none',borderRadius:5,
                      fontSize:12,fontWeight:600,cursor:'pointer',color:'#09090b',
                      display:'flex',alignItems:'center',gap:4,
                      fontFamily:'Inter Tight, system-ui, sans-serif',whiteSpace:'nowrap',flexShrink:0,
                    }}
                  >
                    <Plus style={{width:11,height:11}} />
                    New project
                  </button>
                )}
              </div>

              {/* V4 터미널 뷰 */}
              {portViewMode === 'terminal' && renderV4View()}

              {/* Card grid removed — terminal view only */}
              {false && <div style={{flex:1,overflowY:'auto',padding:'16px 28px 28px'}}>
                {v3Running.length > 0 && (
                  <div style={{marginBottom:24}}>
                    <div style={{
                      display:'flex',alignItems:'center',gap:6,marginBottom:10,
                      fontSize:11,fontFamily:'JetBrains Mono, monospace',
                      color:'#a1a1aa',textTransform:'uppercase' as const,letterSpacing:0.5,
                    }}>
                      <span style={{width:6,height:6,borderRadius:3,background:'#4ade80',display:'inline-block'}} />
                      Running <span style={{color:'#71717a',marginLeft:4}}>{v3Running.length}</span>
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))',gap:12}}>
                      {v3Running.map(item => renderV3Card(item))}
                    </div>
                  </div>
                )}

                {v3Idle.length > 0 && (
                  <div>
                    <div data-help-key="section-header-idle" style={{
                      display:'flex',alignItems:'center',gap:6,marginBottom:10,
                      fontSize:11,fontFamily:'JetBrains Mono, monospace',
                      color:'#a1a1aa',textTransform:'uppercase' as const,letterSpacing:0.5,
                    }}>
                      <span style={{width:6,height:6,borderRadius:3,background:'#71717a',display:'inline-block'}} />
                      Idle <span style={{color:'#71717a',marginLeft:4}}>{v3Idle.length}</span>
                    </div>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))',gap:12}}>
                      {v3Idle.map(item => renderV3Card(item))}
                    </div>
                  </div>
                )}

                {v3Ports.length === 0 && (
                  <div style={{textAlign:'center',padding:'60px 0',color:'#71717a'}}>
                    <Server style={{width:40,height:40,margin:'0 auto 16px',opacity:0.25}} />
                    <p style={{fontSize:14,fontWeight:600,color:'#a1a1aa',marginBottom:8}}>아직 등록된 프로젝트가 없습니다</p>
                    <p style={{fontSize:12,color:'#71717a'}}>우측 상단 <strong style={{color:'#5eead4'}}>+</strong> 버튼을 눌러 첫 번째 포트를 추가하세요</p>
                  </div>
                )}

                <div style={{marginTop:32,textAlign:'center'}}>
                  <p style={{fontSize:11,color:'#71717a'}}>
                    © {new Date().getFullYear()} CS & Company. All rights reserved.
                  </p>
                </div>
              </div>}
            </div>
          </div>
        )}

      {/* New project 모달 */}
      {showNewProjectModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => { setShowNewProjectModal(false); setProjectModalTab('new'); setExistingFolderPath(''); setExistingDetectedPort(undefined); setExistingProjectName(''); setExistingPort(''); existingAutoNameRef.current = ''; existingAutoPortRef.current = ''; }}>
          <div className="bg-[#111113] rounded-xl border border-stone-800/40 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto p-6 space-y-4"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">프로젝트 추가</h2>
              <button onClick={() => { setShowNewProjectModal(false); setProjectModalTab('new'); setExistingFolderPath(''); setExistingDetectedPort(undefined); setExistingProjectName(''); setExistingPort(''); existingAutoNameRef.current = ''; existingAutoPortRef.current = ''; }}
                className="p-1.5 hover:bg-stone-800 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300">
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            {/* 탭 선택 */}
            <div className="flex border-b border-stone-700">
              <button
                onClick={() => setProjectModalTab('new')}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  projectModalTab === 'new'
                    ? 'text-amber-500 border-b-2 border-amber-500'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                새 폴더 만들기
              </button>
              <button
                onClick={() => setProjectModalTab('existing')}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  projectModalTab === 'existing'
                    ? 'text-amber-500 border-b-2 border-amber-500'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                기존 폴더 등록
              </button>
            </div>

            {/* 새 폴더 만들기 탭 */}
            {projectModalTab === 'new' && (
              <>
                {workspaceRoots.length === 0 ? (
                  <div className="space-y-3">
                    <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                      작업 루트 폴더가 없습니다. 새 프로젝트를 만들 위치를 먼저 지정해주세요.
                    </div>
                    <FolderDropZone
                      testId="new-project-empty-root-dropzone"
                      label="작업 루트를 여기로 드래그"
                      hint="또는 클릭해서 루트 폴더 선택"
                      onChoose={handleAddWorkspaceRoot}
                      onFolderPath={addWorkspaceRootFromPath}
                      onError={message => showToast(message, 'error')}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-xs text-zinc-400 block">작업 루트</label>
                      {workspaceRoots.length > 1 ? (
                        <select
                          value={activeRootId ?? ''}
                          onChange={e => setActiveRootId(e.target.value)}
                          className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50">
                          {workspaceRoots.map(r => (
                            <option key={r.id} value={r.id}>{r.name || r.path}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-xs text-zinc-400 font-mono truncate">
                          {workspaceRoots[0]?.path}
                        </div>
                      )}
                      <FolderDropZone
                        compact
                        testId="new-project-root-dropzone"
                        label="다른 폴더를 드래그해 작업 루트로 추가"
                        hint="또는 클릭"
                        onChoose={handleAddWorkspaceRoot}
                        onFolderPath={addWorkspaceRootFromPath}
                        onError={message => showToast(message, 'error')}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 mb-1 block">프로젝트 이름</label>
                      <input
                        autoFocus
                        type="text"
                        value={newProjectName}
                        onChange={e => setNewProjectName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleCreateProjectFolder()}
                        placeholder="my-project"
                        className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50"
                      />
                      {activeRootId && (
                        <p className="text-[11px] text-zinc-600 mt-1 font-mono truncate">
                          {workspaceRoots.find(r => r.id === activeRootId)?.path}/{newProjectName.trim() || newProjectCloneRequest?.repositoryName || '...'}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 mb-1 block">
                        GitHub 주소 <span className="text-zinc-600">(선택 — 넣으면 새로 만드는 대신 clone)</span>
                      </label>
                      <input
                        type="text"
                        data-testid="new-project-github-url"
                        value={newProjectGithubUrl}
                        onChange={e => setNewProjectGithubUrl(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleCreateProjectFolder()}
                        placeholder="https://github.com/owner/repo"
                        className={`w-full px-3 py-2 bg-stone-900 border rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${newProjectCloneUrlProblem ? 'border-red-500/50 focus:border-red-500/70' : 'border-stone-700 focus:border-amber-500/50'}`}
                      />
                      {newProjectCloneUrlProblem ? (
                        <p data-testid="new-project-github-url-problem" className="text-[11px] text-red-400 mt-1">{newProjectCloneUrlProblem}</p>
                      ) : newProjectCloneRequest ? (
                        <p className="text-[11px] text-teal-300/80 mt-1">
                          clone 후 origin이 잡혀 장기기억이 저장소로 계보를 찾습니다 — memoryId를 따로 옮기지 않아도 됩니다.
                        </p>
                      ) : null}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={registerAsProject} onChange={e => setRegisterAsProject(e.target.checked)}
                        className="accent-amber-500 w-3.5 h-3.5" />
                      <span className="text-xs text-zinc-400">포트 목록에 프로젝트로 등록</span>
                    </label>
                    {/* clone 은 이미 저장소다. 체크가 살아 있으면 그 위에 git init 을 또 도는
                        것처럼 읽히므로, 주소가 유효할 때는 이유와 함께 잠근다. */}
                    <label className={`flex items-center gap-2 select-none ${newProjectCloneRequest ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={initializeNewProjectGit && !newProjectCloneRequest} onChange={e => setInitializeNewProjectGit(e.target.checked)}
                        disabled={!!newProjectCloneRequest}
                        className="accent-amber-500 w-3.5 h-3.5" />
                      <span className="text-xs text-zinc-400">
                        Git 저장소 만들기{newProjectCloneRequest ? ' — clone한 저장소라 불필요' : ''}
                      </span>
                    </label>
                    <label className={`flex items-center gap-2 select-none ${registerAsProject ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                      <input type="checkbox" checked={runNewProjectAfterCreate} onChange={e => setRunNewProjectAfterCreate(e.target.checked)}
                        disabled={!registerAsProject}
                        className="accent-amber-500 w-3.5 h-3.5" />
                      <span className="text-xs text-zinc-400">생성 후 프로젝트 실행</span>
                    </label>
                    <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3 space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={enableNewProjectMemory} onChange={e => setEnableNewProjectMemory(e.target.checked)}
                          className="accent-teal-400 w-3.5 h-3.5" />
                        <span className="text-xs font-medium text-teal-200">처음부터 프로젝트 장기기억 사용</span>
                      </label>
                      {enableNewProjectMemory && (
                        <div className="flex items-center justify-between gap-3 pl-5">
                          <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                            <span className="whitespace-nowrap">최초 실행 AI</span>
                            <select
                              value={newProjectMemoryAgent}
                              aria-label="새 프로젝트 세션 기억 실행 AI"
                              onChange={e => setNewProjectMemoryAgent(e.target.value as ProjectMemoryAgent)}
                              className="px-2 py-1 rounded border border-stone-700 bg-stone-900 text-[11px] text-zinc-300"
                            >
                              <option value="claude">Claude</option>
                              <option value="codex">Codex</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 whitespace-nowrap">
                            <input type="checkbox" checked={backupNewProjectMemory} onChange={e => setBackupNewProjectMemory(e.target.checked)}
                              className="accent-teal-400" />
                            Supabase 백업
                          </label>
                        </div>
                      )}
                      {/* 소스를 공유하지 않는 프로젝트(내용은 Obsidian 등이 동기화하고
                          저장소에는 구조만 두는 볼트 등)는 저장소 키로 서로를 못 찾는다.
                          다른 기기의 ID를 건네는 것이 두 기억을 하나로 잇는 유일한 길이다. */}
                      {enableNewProjectMemory && (
                        <div className="pl-5 space-y-1">
                          <label className="text-[11px] text-zinc-400 block">
                            다른 기기의 장기기억 ID <span className="text-zinc-600">(선택 — 입력하면 새로 만들지 않고 그 기억에 합류)</span>
                          </label>
                          <input
                            data-testid="new-project-memory-join-id"
                            value={newProjectMemoryJoinId}
                            onChange={e => setNewProjectMemoryJoinId(e.target.value)}
                            placeholder="884575df-63c4-407c-8b43-860d1295e663"
                            spellCheck={false}
                            className="w-full px-2 py-1 rounded border border-stone-700 bg-stone-900 text-[11px] text-zinc-200 placeholder:text-zinc-600 font-mono"
                          />
                          {newProjectMemoryJoinProblem && (
                            <p className="m-0 text-[10px] text-amber-300/90">{newProjectMemoryJoinProblem}</p>
                          )}
                        </div>
                      )}
                    </div>
                    {registerAsProject && (
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">포트 (선택)</label>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            value={newProjectPort}
                            onChange={e => setNewProjectPort(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleCreateProjectFolder()}
                            placeholder="9000"
                            className="flex-1 px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50"
                          />
                          <button type="button" onClick={() => suggestPort(setNewProjectPort)} title="빈 포트 추천 (9000번대)"
                            className="px-3 py-2 text-xs text-zinc-400 border border-stone-700 rounded-lg hover:bg-stone-800 transition-colors whitespace-nowrap">
                            추천
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => { setShowNewProjectModal(false); setProjectModalTab('new'); setNewProjectPort(''); }}
                        className="flex-1 py-2 text-sm text-zinc-400 border border-stone-700 rounded-lg hover:bg-stone-800 transition-colors">
                        취소
                      </button>
                      <button onClick={handleCreateProjectFolder}
                        data-testid="new-project-submit"
                        disabled={!newProjectName.trim() && !newProjectCloneRequest}
                        className="flex-1 py-2 text-sm font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors">
                        {newProjectCloneRequest ? 'clone해서 만들기' : '만들기'}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* 기존 폴더 등록 탭 */}
            {projectModalTab === 'existing' && (
              <>
                <div>
                  <label htmlFor="existing-project-folder" className="text-xs text-zinc-400 mb-1 block">폴더 경로</label>
                  <div className="flex gap-2">
                    <input
                      id="existing-project-folder"
                      type="text"
                      value={existingFolderPath}
                      onChange={e => applyExistingFolderPath(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleRegisterExistingFolder()}
                      placeholder={isWindows() ? "C:\\Users\\..." : "/Users/..."}
                      className="flex-1 px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
                    />
                    <button
                      onClick={handlePickExistingFolder}
                      className="px-3 py-2 bg-stone-800 hover:bg-stone-700 text-zinc-300 rounded-lg border border-stone-700 transition-colors"
                      title="폴더 선택"
                    >
                      선택
                    </button>
                  </div>
                  <div className="mt-2">
                    <FolderDropZone
                      compact
                      testId="existing-project-folder-dropzone"
                      label="등록할 폴더를 여기로 드래그"
                      hint="또는 클릭"
                      onChoose={handlePickExistingFolder}
                      onFolderPath={handleDropExistingFolder}
                      onError={message => showToast(message, 'error')}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">프로젝트 이름</label>
                  <input
                    type="text"
                    value={existingProjectName}
                    onChange={e => setExistingProjectName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRegisterExistingFolder()}
                    placeholder={folderBasename(existingFolderPath) || 'my-project'}
                    className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">포트 (선택)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={existingPort}
                      onChange={e => setExistingPort(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleRegisterExistingFolder()}
                      placeholder="9000"
                      className="flex-1 px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50"
                    />
                    <button type="button" onClick={() => suggestPort(setExistingPort)} title="빈 포트 추천 (9000번대)"
                      className="px-3 py-2 text-xs text-zinc-400 border border-stone-700 rounded-lg hover:bg-stone-800 transition-colors whitespace-nowrap">
                      추천
                    </button>
                  </div>
                  {existingDetectedPort && (
                    <p className="text-[11px] text-emerald-500 mt-1">
                      ✓ 폴더에서 포트 감지됨: {existingDetectedPort} (자동 입력)
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="existing-project-git-action" className="text-xs text-zinc-400 mb-1 block">Git 저장소</label>
                  {existingGitStatus === 'checking' ? (
                    <div className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-xs text-zinc-500">
                      Git 상태 확인 중…
                    </div>
                  ) : (
                    <>
                      <select
                        id="existing-project-git-action"
                        value={existingGitAction}
                        onChange={e => setExistingGitAction(e.target.value as 'keep' | 'create' | 'reinitialize' | 'none')}
                        className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50"
                      >
                        {existingGitStatus === 'git' ? (
                          <>
                            <option value="keep">기존 Git 저장소 유지</option>
                            <option value="reinitialize">Git 초기화 후 다시 만들기</option>
                          </>
                        ) : (
                          <>
                            <option value="create">Git 저장소 만들기</option>
                            <option value="none">Git 없이 등록</option>
                          </>
                        )}
                      </select>
                      <p className={`text-[11px] mt-1 ${existingGitStatus === 'git' ? 'text-emerald-500' : 'text-zinc-500'}`}>
                        {existingGitStatus === 'git'
                          ? '✓ 기존 Git 저장소가 감지되었습니다.'
                          : existingGitStatus === 'none'
                            ? 'Git 저장소가 없어 새로 만들도록 선택되었습니다.'
                            : '폴더를 선택하면 Git 상태를 자동 확인합니다.'}
                      </p>
                      {existingGitAction === 'reinitialize' && (
                        <p className="text-[11px] text-red-400 mt-1">
                          기존 커밋과 브랜치가 삭제됩니다. 등록 시 한 번 더 확인합니다.
                        </p>
                      )}
                    </>
                  )}
                </div>
                <Suspense fallback={null}>
                  <ProjectMemoryPanel
                    folderPath={existingFolderPath}
                    projectName={existingProjectName || folderBasename(existingFolderPath)}
                    onToast={showToast}
                  />
                </Suspense>
                {/* 위 패널 안에도 합류 칸이 있지만 그쪽은 Supabase 확인이 성공한 분기에서만
                    보인다. 확인이 실패하면 합류할 방법이 화면에서 통째로 사라지므로,
                    등록 폼 자체에 조건 없이 뜨는 입력칸을 둔다. */}
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400 block">
                    다른 기기의 장기기억 ID <span className="text-zinc-600">(선택 — 입력하면 새로 만들지 않고 그 기억에 합류)</span>
                  </label>
                  <input
                    data-testid="existing-project-memory-join-id"
                    value={existingMemoryJoinId}
                    onChange={e => setExistingMemoryJoinId(e.target.value)}
                    placeholder="884575df-63c4-407c-8b43-860d1295e663"
                    spellCheck={false}
                    className="w-full px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-600 font-mono focus:outline-none focus:border-amber-500/50"
                  />
                  {existingMemoryJoinProblem && (
                    <p className="m-0 text-[10px] text-amber-300/90">{existingMemoryJoinProblem}</p>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={runExistingProjectAfterRegister} onChange={e => setRunExistingProjectAfterRegister(e.target.checked)}
                    className="accent-amber-500 w-3.5 h-3.5" />
                  <span className="text-xs text-zinc-400">등록 후 프로젝트 실행</span>
                </label>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { setShowNewProjectModal(false); setProjectModalTab('new'); setExistingFolderPath(''); setExistingDetectedPort(undefined); setExistingProjectName(''); setExistingPort(''); existingAutoNameRef.current = ''; existingAutoPortRef.current = ''; }}
                    className="flex-1 py-2 text-sm text-zinc-400 border border-stone-700 rounded-lg hover:bg-stone-800 transition-colors">
                    취소
                  </button>
                  <button onClick={handleRegisterExistingFolder}
                    disabled={!existingFolderPath.trim()}
                    className="flex-1 py-2 text-sm font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors">
                    등록
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      </div>
    </div>
  );
}

export default App;
