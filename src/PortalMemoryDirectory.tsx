/**
 * 배포 포털의 「장기기억」 화면.
 *
 * 파일 설치는 각 단말의 로컬 API가 담당한다. 이 화면은 Supabase의 계보·별칭·합병 계획을
 * 관리하고, 단말에는 복사 가능한 동기화 명령을 건넨다.
 *
 * 저장소가 없는 기억은 `github_url` 로 서로를 찾을 수 없어 이 경로가 **유일한 연결 수단**이다
 * (실측 2026-08-14: 기억 43개 중 36개가 저장소 없음).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, Bot, Brain, Check, Copy, FolderOpen, FolderSearch, Github, GitBranch, GitMerge,
  Cloud, Laptop, Link2, Pencil, RefreshCw, RotateCcw, Search, Sparkles, Trash2, Unlink, X,
} from 'lucide-react';
import { getSupabaseClient } from './lib/supabaseClient';
import { isTauri } from './lib/env';
import {
  describeMemoryQueryFailure,
  DEVICE_IDENTITY_ALIAS_COLUMNS,
  filterMemoryDirectory,
  filterMemoryDirectoryByRepository,
  loadMemoryDirectory,
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
  memoryDeviceGitState,
  memoryRepositoryGuidance,
  type MemoryDirectoryEntry,
  type MemoryDirectoryLoad,
  type MemoryRepositoryFilter,
} from './projectMemoryDirectory';
import RemoteDeviceManager from './RemoteDeviceManager';
import BuzzAgentSetupDialog from './BuzzAgentSetupDialog';
import { buildNewDeviceHermesSetupPrompt } from './newDeviceHermesSetupPrompt';
import { buildHermesProfileOnboardingPrompt, buildNewHermesProfilePreparationPrompt, hermesProfileDisplayName, nextAvailableHermesProfileName, validateHermesProfileName, type HermesProfileModel } from './hermesProfileOnboardingPrompt';
import { buildTelegramBotOnboardingPrompt, buildTelegramProfileHandoffPrompt, isValidTelegramBotUsername, suggestTelegramBotNaming, type TelegramConnectionMode } from './newDeviceTelegramBotSetupPrompt';
import {
  buildProjectMemoryFindCommand,
  buildProjectMemorySyncCommand,
  devicePlatformLabel,
  normalizeDevicePlatform,
} from './projectMemoryDeviceSync';
import {
  githubRepositoryIdentity,
  normalizeGithubCollaborators,
  repositoryRolesFor,
  type GithubRepositoryRoleRow,
} from './githubRepositoryRoles';
import {
  composeMergedMemory,
  fallbackMemoryDisplayName,
  memoryMergeValidation,
  normalizeMemoryDisplayName,
  repositoryUrlForChoice,
  resolveMergeTarget,
  type MemorySurvivorChoice,
  type RepositoryMergeChoice,
} from './projectMemoryMerge';

interface Props {
  supabaseUrl: string;
  supabaseKey: string;
  /** AgentsToZ가 등록한 현재 단말 표시명. Telegram 표시 이름 추천에 사용한다. */
  deviceName?: string;
  /** AgentsToZ가 readback한 현재 단말의 authoritative identity. Telegram 연결 대상 고정에 사용한다. */
  deviceId?: string;
  /** 포털의 showToast 는 type 을 필수로 받는다 — 시그니처를 넓히면 호출부가 안 맞는다. */
  showToast: (message: string, type: 'success' | 'error') => void;
}

type LocalProjectLookup = {
  status: 'checking' | 'found' | 'not-found' | 'unavailable';
  path?: string;
  matchedMemoryId?: string;
  detail?: string;
};

type LocalRegisteredProject = {
  id: string;
  name: string;
  folderPath?: string;
};

type HermesProfileStatus = {
  name: string;
  displayName?: string;
  configPresent: boolean;
  localServerRunning?: boolean;
  gatewayRunning?: boolean;
  telegramConfigured?: boolean;
  telegramState?: string;
};

function hermesStatusLabel(profile: HermesProfileStatus): { local: string; telegram: string; gateway: string } {
  return {
    local: profile.localServerRunning ? '사용 중' : profile.configPresent ? '사용 가능' : '설정 필요',
    telegram: profile.telegramState === 'connected' ? '사용 중' : profile.telegramConfigured ? '설정됨 · gateway 확인 필요' : '사용 안 함',
    gateway: profile.gatewayRunning ? '실행 중' : '중지됨',
  };
}

function hermesStatusClass(value: string): string {
  return value === '사용 중' || value === '실행 중' ? 'text-emerald-300' : value === '사용 가능' || value.startsWith('설정됨') ? 'text-amber-300' : 'text-zinc-500';
}

function gitStatePresentation(device: MemoryDirectoryEntry['devices'][number]): { label: string; className: string } {
  switch (memoryDeviceGitState(device)) {
    case 'dirty': return { label: '로컬 변경 있음', className: 'text-amber-300' };
    case 'diverged': return { label: `분기 · ↑${device.gitAhead ?? 0} ↓${device.gitBehind ?? 0}`, className: 'text-rose-300' };
    case 'behind': return { label: `Pull 필요 · ↓${device.gitBehind}`, className: 'text-amber-300' };
    case 'ahead': return { label: `Push 필요 · ↑${device.gitAhead}`, className: 'text-sky-300' };
    case 'synced': return { label: '원격 추적 일치', className: 'text-emerald-400' };
    case 'commit-only': return { label: '커밋 확인 · 원격 비교 미상', className: 'text-zinc-500' };
    default: return { label: 'Git 상태 미보고', className: 'text-zinc-600' };
  }
}

export default function PortalMemoryDirectory({ supabaseUrl, supabaseKey, deviceName, deviceId, showToast }: Props) {
  const [loadedDirectory, setLoaded] = useState<MemoryDirectoryLoad | null>(null);
  // `useEffect(load)` runs after the first paint. Starting at false briefly presents a
  // authoritative-looking "0 memories / 0 devices" dashboard on a cold start even
  // though the query has not begun yet. Keep the initial state explicitly pending.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [memoryView, setMemoryView] = useState<'active' | 'trash'>('active');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [repositoryFilter, setRepositoryFilter] = useState<MemoryRepositoryFilter>('all');
  const [visibleLimit, setVisibleLimit] = useState(15);
  const [copied, setCopied] = useState<string | null>(null);
  const [copiedOnboarding, setCopiedOnboarding] = useState<string | null>(null);
  const [onboardingMode, setOnboardingMode] = useState<'project-hermes' | 'profile-telegram' | null>(null);
  const [buzzAgentSetupScope, setBuzzAgentSetupScope] = useState<'global' | 'service' | null>(null);
  const [onboardingProjectId, setOnboardingProjectId] = useState('');
  const [onboardingProfile, setOnboardingProfile] = useState('');
  const [onboardingProfiles, setOnboardingProfiles] = useState<HermesProfileStatus[]>([]);
  const [renamingHermesProfile, setRenamingHermesProfile] = useState<HermesProfileStatus | null>(null);
  const [hermesProfileNameDraft, setHermesProfileNameDraft] = useState('');
  const [deletingHermesProfile, setDeletingHermesProfile] = useState<HermesProfileStatus | null>(null);
  const [savingHermesProfile, setSavingHermesProfile] = useState(false);
  const [onboardingProjects, setOnboardingProjects] = useState<LocalRegisteredProject[]>([]);
  const [newProfileMode, setNewProfileMode] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileChannel, setNewProfileChannel] = useState<'local' | 'telegram'>('local');
  const [newProfileModel, setNewProfileModel] = useState<HermesProfileModel>('sol');
  const [telegramConnectionMode, setTelegramConnectionMode] = useState<TelegramConnectionMode>('manual');
  const [telegramBotName, setTelegramBotName] = useState('');
  const [telegramBotUsername, setTelegramBotUsername] = useState('');
  const [telegramSetupPending, setTelegramSetupPending] = useState(false);
  const [copiedSync, setCopiedSync] = useState<string | null>(null);
  const [copiedFind, setCopiedFind] = useState<string | null>(null);
  const [localProjects, setLocalProjects] = useState<Record<string, LocalProjectLookup>>({});
  const [refreshingLocalState, setRefreshingLocalState] = useState<string | null>(null);
  const [retiringDevice, setRetiringDevice] = useState<string | null>(null);
  const [pendingRetirement, setPendingRetirement] = useState<{ memoryId: string; deviceId: string } | null>(null);
  const [trashDraft, setTrashDraft] = useState<MemoryDirectoryEntry | null>(null);
  const [trashingMemory, setTrashingMemory] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ entry: MemoryDirectoryEntry; content: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [repositoryRoles, setRepositoryRoles] = useState<Record<string, GithubRepositoryRoleRow>>({});
  const [editingRepository, setEditingRepository] = useState<{
    repositoryUrl: string;
    ownerLogin: string;
    collaborators: string;
  } | null>(null);
  const [savingRepository, setSavingRepository] = useState(false);
  const [editingLabel, setEditingLabel] = useState<{ memoryId: string; displayName: string } | null>(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const [mergeDraft, setMergeDraft] = useState<{
    memoryA: string;
    memoryB: string;
    survivor: MemorySurvivorChoice;
    repositoryChoice: RepositoryMergeChoice;
    newRepositoryUrl: string;
    displayName: string;
    primary: 'a' | 'b';
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const [suggestingName, setSuggestingName] = useState(false);
  const [showRemoteDevices, setShowRemoteDevices] = useState(false);
  const remoteDevicesButtonRef = useRef<HTMLButtonElement>(null);
  const remoteDevicesModalRef = useRef<HTMLDivElement>(null);
  const [preferredRemoteMemoryId, setPreferredRemoteMemoryId] = useState<string | null>(null);
  const [deviceIdentityDraft, setDeviceIdentityDraft] = useState<{
    entry: MemoryDirectoryEntry;
    aliasDeviceId: string;
    canonicalDeviceId: string;
    confirming?: boolean;
    saving?: boolean;
  } | null>(null);
  const secondaryDialogRef = useRef<HTMLDivElement>(null);
  const secondaryDialogKind = viewing ? 'viewer'
    : trashDraft ? 'trash'
      : pendingRetirement ? 'retirement'
        : deviceIdentityDraft ? 'identity'
          : editingRepository ? 'repository'
            : editingLabel ? 'label'
              : mergeDraft ? 'merge'
                : null;

  const closeSecondaryDialog = useCallback(() => {
    switch (secondaryDialogKind) {
      case 'viewer': setViewing(null); break;
      case 'trash': setTrashDraft(null); break;
      case 'retirement': setPendingRetirement(null); break;
      case 'identity': setDeviceIdentityDraft(null); break;
      case 'repository': setEditingRepository(null); break;
      case 'label': setEditingLabel(null); break;
      case 'merge': setMergeDraft(null); break;
    }
  }, [secondaryDialogKind]);

  // All memory dialogs use one keyboard contract: move focus inside on open,
  // contain Tab navigation, close with Escape, and return focus to the opener.
  useEffect(() => {
    if (!secondaryDialogKind) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = secondaryDialogRef.current;
    if (!modal) return;
    const focusableElements = () => [...modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.offsetParent !== null);
    const focusFrame = requestAnimationFrame(() => {
      (modal.querySelector<HTMLElement>('[data-dialog-initial]') ?? focusableElements()[0] ?? modal).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSecondaryDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      modal.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [closeSecondaryDialog, secondaryDialogKind]);

  useEffect(() => {
    if (!showRemoteDevices) return;
    const opener = remoteDevicesButtonRef.current;
    const modal = remoteDevicesModalRef.current;
    if (!modal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowRemoteDevices(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener('keydown', onKeyDown);
    return () => {
      modal.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [showRemoteDevices]);
  // 화면 게이트는 localStorage 플래그만 본다 — 세션이 만료돼도 앱은 렌더된다.
  // 그래서 "로그인했는지"를 여기서 직접 확인해야 실패 원인을 바르게 말할 수 있다.
  const [hasSession, setHasSession] = useState<boolean | undefined>(undefined);

  const sb = useCallback(() => getSupabaseClient(supabaseUrl, supabaseKey), [supabaseUrl, supabaseKey]);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      // ⚠️ 세션 복원을 **기다린 뒤에** 쿼리한다. supabase-js 는 저장소에서 세션을
      // 비동기로 되살리는데, 화면 게이트는 localStorage 플래그로 즉시 통과시키므로
      // 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로 나가고 모든 portmgr_* 테이블이
      // RLS로 42501을 반환한다. "로그인했는데 안 된다"처럼 보이지 않도록 getSession()이
      // 저장된 JWT 복원을 끝낼 때까지 기다린다.
      if (!isTauri()) {
        const { data: sessionData } = await sb().auth.getSession();
        setHasSession(!!sessionData.session);
      } else {
        // 데스크톱은 localhost sidecar가 서버 전용 키를 주입한다. 사용자 세션은 없다.
        setHasSession(undefined);
      }
      // 기기로 거르지 않는다 — 다른 기기의 기억을 찾는 것이 이 화면의 목적이다.
      // 프로젝트 행의 칩과 같은 결과를 공유한다(중복 조회 방지).
      const loadOnce = (forceQuery: boolean) => loadMemoryDirectory(`${supabaseUrl}::${supabaseKey}`, () => sb()
        .from('portmgr_project_memory_revisions')
        .select(MEMORY_LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(MEMORY_REVISION_WINDOW), {
          force: forceQuery,
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
          retirementQuery: () => sb()
            .from('portmgr_project_memory_device_retirements')
            .select(MEMORY_DEVICE_RETIREMENT_COLUMNS),
          deviceIdentityQuery: () => sb()
            .from('portmgr_device_identity_aliases')
            .select(DEVICE_IDENTITY_ALIAS_COLUMNS),
          physicalDeviceQuery: () => sb()
            .from('portmgr_devices')
            .select(PHYSICAL_DEVICE_COLUMNS),
          remoteDeviceQuery: () => sb()
            .from('portmgr_remote_devices')
            .select(REMOTE_MEMORY_DEVICE_COLUMNS),
          remoteProjectQuery: () => sb()
            .from('portmgr_remote_device_projects')
            .select(REMOTE_MEMORY_PROJECT_COLUMNS),
          trashQuery: () => sb()
            .from('portmgr_project_memory_trash')
            .select(MEMORY_TRASH_COLUMNS),
        });
      let loaded = await loadOnce(force);
      // 설치 직후 sidecar와 WebView가 동시에 뜨는 콜드 스타트에서 첫 PostgREST 묶음이
      // 오류 없이 빈 배열로 끝난 사례가 있었다. 데스크톱의 첫 조회만 한 번 강제 재조회해
      // 사용자가 「새로고침」을 눌러야 58개 기억이 나타나는 상태를 남기지 않는다.
      if (isTauri() && !force && loaded.entries.length === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 200));
        loaded = await loadOnce(true);
      }
      setLoaded(loaded);
      const rolesResult = await sb()
        .from('portmgr_github_repository_roles')
        .select('repository_url, owner_login, collaborators, updated_at');
      if (!rolesResult.error) {
        const next: Record<string, GithubRepositoryRoleRow> = {};
        for (const row of (rolesResult.data ?? []) as GithubRepositoryRoleRow[]) next[row.repository_url] = row;
        setRepositoryRoles(next);
      }
    } catch (e: any) {
      let session: boolean | undefined;
      if (!isTauri()) {
        try {
          const { data: sessionData } = await sb().auth.getSession();
          session = !!sessionData.session;
        } catch { /* 세션 조회 실패는 "모름"으로 남긴다 — 원인을 지어내지 않는다 */ }
      }
      setHasSession(session);
      setError(isTauri()
        ? (e?.message ?? String(e))
        : describeMemoryQueryFailure(e, session));
      setLoaded(null);
    } finally {
      setLoading(false);
    }
  }, [sb]);

  const signIn = async () => {
    if (isTauri()) return;
    try {
      await sb().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/' },
      });
    } catch (e: any) {
      showToast(`로그인을 시작하지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    }
  };

  useEffect(() => { void load(); }, [load]);

  // 로그인/토큰 갱신이 늦게 도착해도 목록이 스스로 채워지게 한다. 이게 없으면 사용자가
  // 로그인한 뒤 탭을 다시 열어야만 보인다.
  useEffect(() => {
    if (isTauri()) return;
    const { data: { subscription } } = sb().auth.onAuthStateChange((event) => {
      // TOKEN_REFRESHED 는 뺀다 — 토큰 갱신으로 기억 목록이 바뀌지 않는다.
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void load();
    });
    return () => subscription.unsubscribe();
  }, [sb, load]);

  const loadHermesProfiles = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const profileResponse = await fetch('http://127.0.0.1:3001/api/hermes/profiles', { cache: 'no-store' });
      if (!profileResponse.ok) throw new Error('profile 조회 실패');
      const profileData = await profileResponse.json();
      setOnboardingProfiles(Array.isArray(profileData?.profiles) ? profileData.profiles : []);
    } catch {
      setOnboardingProfiles([]);
    }
  }, []);

  const loadOnboardingProjects = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const projectResponse = await fetch('http://127.0.0.1:3001/api/ports', { cache: 'no-store' });
      if (!projectResponse.ok) throw new Error('project 조회 실패');
      const projectData = await projectResponse.json();
      const projects = Array.isArray(projectData) ? projectData : projectData?.ports;
      setOnboardingProjects(Array.isArray(projects)
        ? projects.filter((project: any) => typeof project?.id === 'string' && typeof project?.name === 'string')
          .map((project: any) => ({ id: project.id, name: project.name, folderPath: project.folderPath }))
        : []);
    } catch {
      setOnboardingProjects([]);
    }
  }, []);

  useEffect(() => { void loadHermesProfiles(); }, [loadHermesProfiles]);
  useEffect(() => { void loadOnboardingProjects(); }, [loadOnboardingProjects]);

  const allEntries = loadedDirectory?.entries ?? [];
  const initialLoadPending = loading && loadedDirectory === null;
  const activeEntries = useMemo(() => allEntries.filter(entry => !entry.trashedAt), [allEntries]);
  const trashedEntries = useMemo(() => allEntries.filter(entry => !!entry.trashedAt), [allEntries]);
  const entries = memoryView === 'trash' ? trashedEntries : activeEntries;
  const deviceFilters = loadedDirectory?.deviceFilters ?? [];
  const defaultHermesProfile = onboardingProfiles.find(profile => profile.name === 'default');
  const repositoryCounts = useMemo(() => ({
    withRepository: filterMemoryDirectoryByRepository(entries, 'with-repository').length,
    withoutRepository: filterMemoryDirectoryByRepository(entries, 'without-repository').length,
    review: filterMemoryDirectoryByRepository(entries, 'review').length,
  }), [entries]);
  const visible = useMemo(() => filterMemoryDirectoryByRepository(
    filterMemoryDirectory(entries, query).filter(entry => !selectedDeviceId
      || entry.devices.some(device => device.deviceId === selectedDeviceId || device.legacyDeviceIds.includes(selectedDeviceId))),
    repositoryFilter,
  ), [entries, query, selectedDeviceId, repositoryFilter]);
  const onboardingProjectOptions = useMemo(() => {
    const options = new Map<string, { id: string; name: string; folderPath?: string }>();
    for (const entry of activeEntries) options.set(entry.memoryId, { id: entry.memoryId, name: entry.projectName, folderPath: localProjects[entry.memoryId]?.path });
    for (const project of onboardingProjects) options.set(project.id, project);
    return [...options.values()];
  }, [activeEntries, localProjects, onboardingProjects]);
  const onboardingEntry = allEntries.find(entry => entry.memoryId === onboardingProjectId) ?? null;
  const onboardingProject = onboardingProjectOptions.find(project => project.id === onboardingProjectId) ?? null;
  const onboardingPath = onboardingProject?.folderPath ?? (onboardingEntry ? localProjects[onboardingEntry.memoryId]?.path : undefined);
  const onboardingHermesPrompt = onboardingProfile
    ? buildHermesProfileOnboardingPrompt({ channel: 'local', profileName: onboardingProfile, projectName: onboardingProject?.name, canonicalPath: onboardingPath, memoryId: onboardingPath ? onboardingProjectId : undefined })
    : '';
  const onboardingTelegramPrompt = onboardingProfile
    ? buildTelegramProfileHandoffPrompt({ profileName: onboardingProfile, projectName: onboardingProject?.name, canonicalPath: onboardingPath, memoryId: onboardingPath ? onboardingProjectId : undefined, deviceName, deviceId, connectionMode: telegramConnectionMode })
    : '';
  const newProfilePrompt = newProfileMode
    ? buildNewHermesProfilePreparationPrompt({ profileName: newProfileName, existingProfiles: onboardingProfiles.map(profile => profile.name), channel: newProfileChannel, model: newProfileModel })
    : '';
  const onboardingCopyBlocked = newProfileMode
    ? !newProfilePrompt
    : onboardingMode === 'project-hermes'
      ? (!!onboardingProjectId && !onboardingPath) || !onboardingHermesPrompt
      : !onboardingTelegramPrompt;
  const onboardingCopyBlockReason = newProfileMode
    ? (!newProfileName.trim()
      ? '새 profile 이름을 입력하세요.'
      : !validateHermesProfileName(newProfileName)
        ? 'profile 이름 형식을 확인하세요.'
        : onboardingProfiles.some(profile => profile.name.toLowerCase() === newProfileName.trim().toLowerCase())
          ? '이미 존재하는 profile 이름입니다.'
          : '')
    : onboardingMode === 'project-hermes' && onboardingProjectId && !onboardingPath
      ? '선택한 프로젝트의 canonical path를 로컬에서 readback한 뒤 복사할 수 있습니다.'
      : onboardingMode === 'profile-telegram' && !deviceId
        ? '현재 단말의 authoritative device_id를 readback하지 못해 Telegram 연결 prompt를 복사할 수 없습니다.'
        : '';
  const displayedEntries = visible.slice(0, visibleLimit);
  const legacyDirectorySource = loadedDirectory?.source === 'legacy-revisions';
  const windowFull = loadedDirectory?.windowFull ?? false;
  const pendingRetirementEntry = pendingRetirement
    ? allEntries.find(entry => entry.memoryId === pendingRetirement.memoryId) ?? null
    : null;
  const pendingRetirementDevice = pendingRetirementEntry?.devices.find(device => device.deviceId === pendingRetirement?.deviceId) ?? null;
  const identityAliasDevice = deviceIdentityDraft?.entry.devices.find(device => device.deviceId === deviceIdentityDraft.aliasDeviceId) ?? null;
  const identityCanonicalDevice = deviceIdentityDraft?.entry.devices.find(device => device.deviceId === deviceIdentityDraft.canonicalDeviceId) ?? null;

  useEffect(() => {
    if (selectedDeviceId && !deviceFilters.some(device => device.deviceId === selectedDeviceId)) setSelectedDeviceId('');
  }, [deviceFilters, selectedDeviceId]);

  useEffect(() => {
    if (memoryView === 'trash' && repositoryFilter === 'review') setRepositoryFilter('all');
  }, [memoryView, repositoryFilter]);

  useEffect(() => {
    setVisibleLimit(15);
  }, [memoryView, query, selectedDeviceId, repositoryFilter]);

  const copyMemoryId = async (memoryId: string) => {
    try {
      await navigator.clipboard.writeText(memoryId);
      setCopied(memoryId);
      setTimeout(() => setCopied(current => (current === memoryId ? null : current)), 2000);
      showToast('장기기억 ID를 복사했습니다', 'success');
    } catch {
      showToast('클립보드에 복사하지 못했습니다', 'error');
    }
  };

  useEffect(() => {
    if (onboardingMode === 'profile-telegram' && onboardingProfile) {
      const naming = suggestTelegramBotNaming(onboardingProfile, deviceName, onboardingProject?.name);
      setTelegramBotName(naming.displayName);
      setTelegramBotUsername(naming.username);
    } else if (onboardingMode !== 'profile-telegram') {
      setTelegramBotName('');
      setTelegramBotUsername('');
    }
  }, [onboardingMode, onboardingProfile, deviceName, onboardingProject?.name]);

  useEffect(() => {
    if (!telegramSetupPending || onboardingMode !== 'profile-telegram') return;
    const timer = window.setInterval(() => { void loadHermesProfiles(); }, 5000);
    const timeout = window.setTimeout(() => setTelegramSetupPending(false), 5 * 60 * 1000);
    return () => { window.clearInterval(timer); window.clearTimeout(timeout); };
  }, [telegramSetupPending, onboardingMode, loadHermesProfiles]);

  const openOnboarding = (mode: 'project-hermes' | 'profile-telegram') => {
    setOnboardingMode(mode);
    setOnboardingProjectId('');
    setOnboardingProfile(mode === 'profile-telegram' ? 'default' : '');
    setNewProfileMode(false);
    setNewProfileName('');
    setTelegramSetupPending(false);
    setTelegramConnectionMode('manual');
    void loadHermesProfiles();
  };

  const openHermesTelegramSetup = async () => {
    try {
      const response = await fetch('http://127.0.0.1:3001/api/open-hermes-telegram-setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileName: onboardingProfile || 'default' }) });
      const result = await response.json();
      if (!response.ok || result?.success === false) throw new Error(result?.error || 'Hermes Telegram 설정을 열지 못했습니다.');
      setTelegramSetupPending(true);
      showToast(`Hermes ${onboardingProfile || 'default'} profile의 Telegram 설정을 열었습니다`, 'success');
    } catch (error: any) {
      showToast(error?.message ?? String(error), 'error');
    }
  };

  const openHermesProfileRename = (profile: HermesProfileStatus) => {
    setRenamingHermesProfile(profile);
    setHermesProfileNameDraft(profile.name === 'default' ? (profile.displayName || 'Hermes') : profile.name);
  };

  const saveHermesProfileRename = async () => {
    if (!renamingHermesProfile) return;
    setSavingHermesProfile(true);
    try {
      const response = await fetch('http://127.0.0.1:3001/api/hermes/profile/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName: renamingHermesProfile.name, newName: hermesProfileNameDraft.trim() }),
      });
      const result = await response.json();
      if (!response.ok || result?.success === false) throw new Error(result?.error || 'Hermes profile 이름을 변경하지 못했습니다.');
      setRenamingHermesProfile(null);
      await loadHermesProfiles();
      showToast(result.message || 'Hermes profile 이름을 변경했습니다', 'success');
    } catch (error: any) {
      showToast(error?.message ?? String(error), 'error');
    } finally {
      setSavingHermesProfile(false);
    }
  };

  const deleteHermesProfile = async () => {
    if (!deletingHermesProfile) return;
    setSavingHermesProfile(true);
    try {
      const response = await fetch('http://127.0.0.1:3001/api/hermes/profile/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName: deletingHermesProfile.name, confirmed: true }),
      });
      const result = await response.json();
      if (!response.ok || result?.success === false) throw new Error(result?.error || 'Hermes profile을 삭제하지 못했습니다.');
      setDeletingHermesProfile(null);
      await loadHermesProfiles();
      showToast(result.message || 'Hermes profile을 삭제했습니다', 'success');
    } catch (error: any) {
      showToast(error?.message ?? String(error), 'error');
    } finally {
      setSavingHermesProfile(false);
    }
  };

  const openHermesForProfileDelete = async () => {
    if (!deletingHermesProfile) return;
    try {
      const response = await fetch('http://127.0.0.1:3001/api/hermes/profile/open-delete', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || result?.success === false) throw new Error(result?.error || 'Hermes를 열지 못했습니다.');
      showToast(`${hermesProfileDisplayName(deletingHermesProfile.name, deletingHermesProfile.displayName)}을 우클릭하고 Delete bot을 선택하세요`, 'success');
    } catch (error: any) {
      showToast(error?.message ?? String(error), 'error');
    }
  };

  const copyTextValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${label}를 복사했습니다`, 'success');
    } catch {
      showToast(`${label} 복사에 실패했습니다`, 'error');
    }
  };

  const copyOnboardingPrompt = async (key: 'hermes' | 'telegram', prompt: string, label: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedOnboarding(key);
      setTimeout(() => setCopiedOnboarding(current => (current === key ? null : current)), 2000);
      showToast(`${label}를 복사했습니다`, 'success');
    } catch {
      showToast('온보딩 안내를 복사하지 못했습니다', 'error');
    }
  };

  const copySyncCommand = async (deviceId: string, platform: string | null) => {
    try {
      await navigator.clipboard.writeText(buildProjectMemorySyncCommand(platform));
      const copyKey = `${deviceId}:${normalizeDevicePlatform(platform)}`;
      setCopiedSync(copyKey);
      setTimeout(() => setCopiedSync(current => (current === copyKey ? null : current)), 2000);
      showToast('해당 단말에서 실행할 동기화 명령을 복사했습니다', 'success');
    } catch {
      showToast('동기화 명령을 복사하지 못했습니다', 'error');
    }
  };

  const copyFindCommand = async (memoryId: string, deviceId: string, platform: string | null) => {
    try {
      await navigator.clipboard.writeText(buildProjectMemoryFindCommand(memoryId, platform));
      const copyKey = `${memoryId}:${deviceId}:${normalizeDevicePlatform(platform)}`;
      setCopiedFind(copyKey);
      setTimeout(() => setCopiedFind(current => (current === copyKey ? null : current)), 2000);
      showToast('해당 단말에서 프로젝트 폴더를 찾는 명령을 복사했습니다', 'success');
    } catch {
      showToast('폴더 찾기 명령을 복사하지 못했습니다', 'error');
    }
  };

  const findLocalProject = async (entry: MemoryDirectoryEntry) => {
    setLocalProjects(current => ({ ...current, [entry.memoryId]: { status: 'checking' } }));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const candidates = [entry.memoryId, ...entry.legacyMemoryIds];
      let lastDetail = '';
      for (const memoryId of candidates) {
        const response = await fetch('http://127.0.0.1:3001/api/project-memory/resolve-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: memoryId }),
          signal: controller.signal,
        });
        const result = await response.json().catch(() => ({})) as {
          canonicalPath?: string;
          memoryId?: string;
          error?: string;
          code?: string;
        };
        if (response.ok && result.canonicalPath) {
          setLocalProjects(current => ({
            ...current,
            [entry.memoryId]: {
              status: 'found', path: result.canonicalPath,
              matchedMemoryId: result.memoryId ?? memoryId,
            },
          }));
          showToast('이 단말에서 장기기억 프로젝트 폴더를 찾았습니다', 'success');
          return;
        }
        lastDetail = result.error || result.code || `HTTP ${response.status}`;
        if (response.status !== 404) throw new Error(lastDetail);
      }
      setLocalProjects(current => ({
        ...current,
        [entry.memoryId]: { status: 'not-found', detail: lastDetail || '등록된 프로젝트에서 이 ID를 찾지 못했습니다.' },
      }));
    } catch (e: any) {
      const detail = e?.name === 'AbortError'
        ? '로컬 AgentsToZ 응답 시간이 초과됐습니다.'
        : (e?.message ?? String(e));
      setLocalProjects(current => ({ ...current, [entry.memoryId]: { status: 'unavailable', detail } }));
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const openLocalProject = async (memoryId: string, folderPath: string, projectIdentifier: string) => {
    try {
      const response = await fetch('http://127.0.0.1:3001/api/project-memory/open-resolved-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectIdentifier }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      showToast('프로젝트 폴더를 열었습니다', 'success');
    } catch (e: any) {
      setLocalProjects(current => ({
        ...current,
        [memoryId]: { status: 'unavailable', path: folderPath, detail: e?.message ?? String(e) },
      }));
      showToast(`폴더를 열지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    }
  };

  const refreshLocalDeviceState = async (entry: MemoryDirectoryEntry) => {
    setRefreshingLocalState(entry.memoryId);
    try {
      const response = await fetch('http://127.0.0.1:3001/api/project-memory/refresh-resolved-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: entry.memoryId }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; inSync?: boolean };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      await load(true);
      showToast(result.inSync ? '이 단말의 장기기억·Git 상태를 최신으로 보고했습니다' : '이 단말 상태를 보고했습니다. 장기기억 동기화 확인이 필요합니다.', result.inSync ? 'success' : 'error');
    } catch (e: any) {
      showToast(`이 단말 상태를 갱신하지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    } finally {
      setRefreshingLocalState(null);
    }
  };

  const setDeviceRetired = async (entry: MemoryDirectoryEntry, deviceId: string, retired: boolean) => {
    const actionKey = `${entry.memoryId}:${deviceId}`;
    setRetiringDevice(actionKey);
    try {
      const { error: rpcError } = await sb().rpc('portmgr_set_project_memory_device_retired', {
        p_memory_id: entry.memoryId,
        p_device_id: deviceId,
        p_retired: retired,
      });
      if (rpcError) throw rpcError;
      setPendingRetirement(null);
      await load(true);
      showToast(retired ? '이 단말을 동기화 확인 대상에서 제외했습니다. 기억 내용과 이력은 그대로 보존됩니다.' : '단말을 다시 확인 대상에 포함했습니다.', 'success');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      showToast(/does not exist|schema cache|PGRST202|PGRST205/i.test(message)
        ? '단말 확인 대상 제외 기능용 Supabase 마이그레이션이 필요합니다.'
        : `단말 상태 변경 실패: ${message}`, 'error');
    } finally {
      setRetiringDevice(null);
    }
  };

  const setMemoryTrashed = async (entry: MemoryDirectoryEntry, trashed: boolean) => {
    setTrashingMemory(entry.memoryId);
    try {
      const { error: rpcError } = await sb().rpc('portmgr_set_project_memory_trashed', {
        p_memory_id: entry.memoryId,
        p_trashed: trashed,
      });
      if (rpcError) throw rpcError;
      setTrashDraft(null);
      await load(true);
      showToast(trashed
        ? '휴지통으로 옮겼습니다. 원본·리비전·단말·Git 이력은 그대로 보존됩니다.'
        : '장기기억을 사용 중 목록으로 복원했습니다.', 'success');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      showToast(/does not exist|schema cache|PGRST202|PGRST205/i.test(message)
        ? '장기기억 휴지통용 Supabase 마이그레이션이 필요합니다.'
        : `휴지통 상태 변경 실패: ${message}`, 'error');
    } finally {
      setTrashingMemory(null);
    }
  };

  const openDeviceIdentityLink = (entry: MemoryDirectoryEntry, preferredCanonicalId: string) => {
    setDeviceIdentityDraft({
      entry,
      // 서로 다른 실제 단말을 실수로 묶지 않도록 과거 항목은 절대 자동 선택하지 않는다.
      aliasDeviceId: '',
      canonicalDeviceId: preferredCanonicalId,
      confirming: false,
    });
  };

  const saveDeviceIdentityLink = async () => {
    if (!deviceIdentityDraft) return;
    if (!deviceIdentityDraft.aliasDeviceId || !deviceIdentityDraft.canonicalDeviceId) {
      showToast('같은 컴퓨터의 과거 항목과 지금 사용하는 대표 항목을 모두 선택하세요', 'error');
      return;
    }
    if (deviceIdentityDraft.aliasDeviceId === deviceIdentityDraft.canonicalDeviceId) {
      showToast('서로 다른 단말 ID를 선택하세요', 'error');
      return;
    }
    setDeviceIdentityDraft(current => current ? { ...current, saving: true } : current);
    try {
      const result = await sb().rpc('portmgr_set_device_identity_alias', {
        p_alias_device_id: deviceIdentityDraft.aliasDeviceId,
        p_canonical_device_id: deviceIdentityDraft.canonicalDeviceId,
      });
      if (result.error) throw result.error;
      setDeviceIdentityDraft(null);
      await load(true);
      showToast('두 항목을 같은 컴퓨터로 묶었습니다. 기존 프로젝트와 이력은 그대로 보존됩니다.', 'success');
    } catch (reason: any) {
      showToast(`단말 ID 연결 실패: ${reason?.message ?? String(reason)}`, 'error');
      setDeviceIdentityDraft(current => current ? { ...current, saving: false } : current);
    }
  };

  const unlinkDeviceIdentity = async (aliasDeviceId: string) => {
    try {
      const result = await sb().rpc('portmgr_set_device_identity_alias', {
        p_alias_device_id: aliasDeviceId,
        p_canonical_device_id: null,
      });
      if (result.error) throw result.error;
      await load(true);
      showToast('단말 ID 연결을 해제했습니다. 원본 이력은 그대로 남습니다.', 'success');
    } catch (reason: any) {
      showToast(`단말 ID 연결 해제 실패: ${reason?.message ?? String(reason)}`, 'error');
    }
  };

  const editRepositoryRoles = (entry: MemoryDirectoryEntry) => {
    const identity = githubRepositoryIdentity(entry.githubUrl);
    if (!identity) return;
    const roles = repositoryRolesFor(identity.repositoryUrl, repositoryRoles[identity.repositoryUrl]);
    if (!roles) return;
    setEditingRepository({
      repositoryUrl: identity.repositoryUrl,
      ownerLogin: roles.ownerLogin,
      collaborators: roles.collaborators.join('\n'),
    });
  };

  const saveRepositoryRoles = async () => {
    if (!editingRepository) return;
    const ownerLogin = editingRepository.ownerLogin.trim().replace(/^@+/, '');
    if (!ownerLogin) {
      showToast('저장소 소유자를 입력하세요', 'error');
      return;
    }
    setSavingRepository(true);
    try {
      const row: GithubRepositoryRoleRow = {
        repository_url: editingRepository.repositoryUrl,
        owner_login: ownerLogin,
        collaborators: normalizeGithubCollaborators(editingRepository.collaborators),
        updated_at: new Date().toISOString(),
      };
      const { error: saveError } = await sb().from('portmgr_github_repository_roles')
        .upsert(row, { onConflict: 'repository_url' });
      if (saveError) throw saveError;
      setRepositoryRoles(current => ({ ...current, [row.repository_url]: row }));
      setEditingRepository(null);
      showToast('GitHub 소유자·협업자 정보를 저장했습니다', 'success');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      showToast(/does not exist|schema cache|PGRST205/i.test(message)
        ? 'GitHub 역할 테이블이 없습니다. 최신 Supabase 마이그레이션을 먼저 적용하세요.'
        : `GitHub 역할 저장 실패: ${message}`, 'error');
    } finally {
      setSavingRepository(false);
    }
  };

  const saveMemoryLabel = async () => {
    if (!editingLabel) return;
    const displayName = normalizeMemoryDisplayName(editingLabel.displayName);
    if (!displayName) return showToast('장기기억 별칭을 입력하세요', 'error');
    setSavingLabel(true);
    try {
      const { error: saveError } = await sb().from('portmgr_project_memory_labels').upsert({
        memory_id: editingLabel.memoryId, display_name: displayName, updated_at: new Date().toISOString(),
      }, { onConflict: 'memory_id' });
      if (saveError) throw saveError;
      setEditingLabel(null);
      await load(true);
      showToast('장기기억 별칭을 저장했습니다', 'success');
    } catch (e: any) {
      showToast(`별칭 저장 실패: ${e?.message ?? String(e)}`, 'error');
    } finally {
      setSavingLabel(false);
    }
  };

  const openMerge = () => {
    const [a, b] = entries;
    if (!a || !b) return showToast('합병하려면 장기기억이 두 개 이상 필요합니다', 'error');
    setMergeDraft({
      memoryA: a.memoryId, memoryB: b.memoryId, survivor: 'a', repositoryChoice: a.githubUrl ? 'a' : (b.githubUrl ? 'b' : 'memory-only'),
      newRepositoryUrl: '', displayName: a.displayName ?? fallbackMemoryDisplayName(a.projectName, a.githubUrl), primary: 'a',
    });
  };

  const suggestDisplayName = async (entry: MemoryDirectoryEntry, contentExcerpt = '') => {
    setSuggestingName(true);
    try {
      const response = await fetch('http://127.0.0.1:3001/api/project-memory/suggest-display-name', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: entry.projectName, githubUrl: entry.githubUrl, contentExcerpt }),
      });
      const result = await response.json() as { displayName?: string; error?: string };
      if (!response.ok || !result.displayName) throw new Error(result.error || '추천값 없음');
      const displayName = normalizeMemoryDisplayName(result.displayName);
      if (mergeDraft) setMergeDraft(current => current ? { ...current, displayName } : current);
      else setEditingLabel({ memoryId: entry.memoryId, displayName });
      showToast('AI가 장기기억 별칭을 추천했습니다', 'success');
    } catch {
      const displayName = fallbackMemoryDisplayName(entry.projectName, entry.githubUrl);
      if (mergeDraft) setMergeDraft(current => current ? { ...current, displayName } : current);
      else setEditingLabel({ memoryId: entry.memoryId, displayName });
      showToast('로컬 AI에 연결할 수 없어 프로젝트명 기반 추천을 넣었습니다', 'error');
    } finally {
      setSuggestingName(false);
    }
  };

  const executeMerge = async () => {
    if (!mergeDraft) return;
    const entryA = entries.find(entry => entry.memoryId === mergeDraft.memoryA);
    const entryB = entries.find(entry => entry.memoryId === mergeDraft.memoryB);
    if (!entryA || !entryB) return showToast('선택한 장기기억을 다시 불러오세요', 'error');
    setMerging(true);
    try {
      const results = await Promise.all([entryA, entryB].map(entry => sb()
        .from('portmgr_project_memory_revisions')
        .select('id, content, content_hash')
        .eq('memory_id', entry.memoryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()));
      const [resultA, resultB] = results;
      if (!resultA || !resultB) throw new Error('장기기억 두 개를 불러오지 못했습니다.');
      if (resultA.error) throw resultA.error;
      if (resultB.error) throw resultB.error;
      const rowA = resultA.data as { id: string; content: string; content_hash: string } | null;
      const rowB = resultB.data as { id: string; content: string; content_hash: string } | null;
      if (!rowA || !rowB) throw new Error('최신 리비전을 찾지 못했습니다.');
      const primaryEntry = mergeDraft.primary === 'a' ? entryA : entryB;
      const secondaryEntry = mergeDraft.primary === 'a' ? entryB : entryA;
      const primaryRow = mergeDraft.primary === 'a' ? rowA : rowB;
      const secondaryRow = mergeDraft.primary === 'a' ? rowB : rowA;
      const mergedContent = composeMergedMemory({
        primaryContent: primaryRow.content, secondaryContent: secondaryRow.content,
        primaryMemoryId: primaryEntry.memoryId, secondaryMemoryId: secondaryEntry.memoryId,
        secondaryName: secondaryEntry.displayName ?? secondaryEntry.projectName,
      });
      const targetMemoryId = resolveMergeTarget({
        choice: mergeDraft.survivor, memoryA: entryA.memoryId, memoryB: entryB.memoryId, newMemoryId: crypto.randomUUID(),
      });
      const repositoryUrl = repositoryUrlForChoice({
        choice: mergeDraft.repositoryChoice, githubA: entryA.githubUrl, githubB: entryB.githubUrl, newGithubUrl: mergeDraft.newRepositoryUrl,
      });
      const validation = memoryMergeValidation({
        memoryA: entryA.memoryId, memoryB: entryB.memoryId, targetMemoryId,
        repositoryChoice: mergeDraft.repositoryChoice, repositoryUrl,
        displayName: mergeDraft.displayName, mergedContent,
      });
      if (validation) throw new Error(validation);
      const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mergedContent));
      const contentHash = [...new Uint8Array(hashBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const { data, error: mergeError } = await sb().rpc('portmgr_merge_project_memories', {
        p_memory_a: entryA.memoryId, p_memory_b: entryB.memoryId, p_target_memory_id: targetMemoryId,
        p_expected_head_a: rowA.id, p_expected_head_b: rowB.id,
        p_project_name: primaryEntry.projectName, p_display_name: normalizeMemoryDisplayName(mergeDraft.displayName),
        p_repository_strategy: mergeDraft.repositoryChoice, p_repository_url: repositoryUrl,
        p_content: mergedContent, p_content_hash: contentHash,
      });
      if (mergeError) throw mergeError;
      const pending = Number((data as Array<{ pending_device_count?: number }> | null)?.[0]?.pending_device_count ?? 0);
      setMergeDraft(null);
      await load(true);
      showToast(`기억 계보를 합병했습니다. ${pending > 0 ? `${pending}개 단말의 전환 확인이 남았습니다.` : '알려진 단말 전환도 완료됐습니다.'}`, 'success');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      showToast(/MERGE_HEAD_CHANGED|40001/i.test(message) ? '합병 준비 중 새 리비전이 생겼습니다. 새로고침 후 다시 검토하세요.' : `기억 합병 실패: ${message}`, 'error');
    } finally {
      setMerging(false);
    }
  };

  const openContent = async (entry: MemoryDirectoryEntry) => {
    setViewLoading(true);
    try {
      // 목록에서는 content 를 받지 않는다 — 문서 하나가 수십 KB라 목록 전체를 끌면 느려진다.
      const { data, error: queryError } = await sb()
        .from('portmgr_project_memory_revisions')
        .select('content')
        .eq('memory_id', entry.memoryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (queryError) throw queryError;
      setViewing({ entry, content: (data as { content?: string } | null)?.content ?? '' });
    } catch (e: any) {
      showToast(`기억 내용을 불러오지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    } finally {
      setViewLoading(false);
    }
  };

  return (
    <div data-testid="portal-memory-directory" className="space-y-3">
      <div data-testid="portal-memory-current-device-scope" className="flex items-center gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 px-3 py-2">
        <Laptop className="h-4 w-4 shrink-0 text-sky-300" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-sky-100">현재 앱 단말 · {deviceName || '이름 미등록'}</div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            Hermes profile·Gateway·로컬 경로 상태는 이 단말 기준입니다. 장기기억 목록과 단말 필터는 연결된 전체 단말을 통합해 보여줍니다.
            {deviceId && <> · <code className="text-zinc-600">{deviceId.slice(0, 8)}</code></>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <Brain className="w-4 h-4 text-teal-400" />
          DEV 프로젝트 기억 <span className="text-zinc-500 text-xs">{initialLoadPending ? '불러오는 중…' : `사용 중 ${activeEntries.length}개`}</span>
        </div>
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
          <button data-testid="portal-memory-view-active" onClick={() => setMemoryView('active')}
            className={`min-h-9 rounded-md px-2.5 text-[11px] ${memoryView === 'active' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
            {initialLoadPending ? '사용 중 …' : `사용 중 ${activeEntries.length}`}
          </button>
          <button data-testid="portal-memory-view-trash" onClick={() => setMemoryView('trash')}
            className={`flex min-h-9 items-center gap-1 rounded-md px-2.5 text-[11px] ${memoryView === 'trash' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
            <Trash2 className="h-3 w-3" />{initialLoadPending ? '휴지통 …' : `휴지통 ${trashedEntries.length}`}
          </button>
        </div>
        <label className="flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2 text-[11px] text-zinc-500">
          <Laptop className="h-3.5 w-3.5" />
          <span className="sr-only">장기기억 단말 필터</span>
          <select data-testid="portal-memory-device-filter" value={selectedDeviceId} disabled={initialLoadPending}
            onChange={event => setSelectedDeviceId(event.target.value)}
            className="max-w-[15rem] bg-transparent py-2 text-zinc-300 outline-none">
            <option value="">{initialLoadPending ? '단말 불러오는 중…' : `모든 단말 ${deviceFilters.length}대`}</option>
            {deviceFilters.map(device => <option key={device.deviceId} value={device.deviceId}>
              {device.deviceName} · {devicePlatformLabel(device.platform)} · 기억 {device.memoryCount}
            </option>)}
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2 text-[11px] text-zinc-500">
          <Github className="h-3.5 w-3.5" />
          <span className="sr-only">장기기억 저장소 필터</span>
          <select
            data-testid="portal-memory-repository-filter"
            value={repositoryFilter}
            disabled={initialLoadPending}
            onChange={event => setRepositoryFilter(event.target.value as MemoryRepositoryFilter)}
            className="max-w-[13rem] bg-transparent py-2 text-zinc-300 outline-none">
            <option value="all">{initialLoadPending ? '저장소 불러오는 중…' : `모든 저장소 ${entries.length}개`}</option>
            <option value="with-repository">저장소 있음 {repositoryCounts.withRepository}개</option>
            <option value="without-repository">저장소 없음 {repositoryCounts.withoutRepository}개</option>
            <option value="review" disabled={memoryView === 'trash'}>정리·연결 권장 {repositoryCounts.review}개</option>
          </select>
        </label>
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            data-testid="portal-memory-search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="이름 · ID · 저장소 · 기기"
            className="pl-8 pr-3 py-1.5 w-56 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/50"
          />
        </div>
        <button data-testid="portal-memory-open-merge" onClick={openMerge} disabled={loading || memoryView === 'trash' || activeEntries.length < 2}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-teal-200 border border-teal-500/25 bg-teal-500/5 rounded-lg hover:bg-teal-500/10 disabled:opacity-40">
          <GitMerge className="w-3 h-3" />기억 합병
        </button>
        <button ref={remoteDevicesButtonRef} data-testid="portal-memory-open-remote-devices" onClick={() => { setPreferredRemoteMemoryId(null); setShowRemoteDevices(true); }} disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-emerald-200 border border-emerald-500/25 bg-emerald-500/5 rounded-lg hover:bg-emerald-500/10 disabled:opacity-40">
          <Cloud className="w-3 h-3" />클라우드 단말
        </button>
        <button
          onClick={() => void load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg hover:text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      <div data-testid="portal-memory-onboarding-actions" className="flex items-center gap-2 flex-wrap rounded-lg border border-teal-500/20 bg-teal-500/5 px-3 py-2">
        <span className="text-[11px] font-semibold text-teal-200">새 단말 온보딩</span>
        <span data-testid="portal-memory-onboarding-device-scope" className="rounded-md border border-sky-400/20 bg-sky-500/5 px-2 py-1 text-[10px] text-sky-200">이 단말 · {deviceName || '이름 미등록'}{deviceId ? ` · ${deviceId.slice(0, 8)}` : ''}</span>
        <button
          data-testid="portal-memory-copy-hermes-onboarding"
          onClick={() => openOnboarding('project-hermes')}
          className="flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-200 hover:bg-violet-500/20">
          {copiedOnboarding === 'hermes' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} 프로젝트 → 로컬 Hermes profile 연동
        </button>
        <button
          data-testid="portal-memory-copy-telegram-onboarding"
          onClick={() => openOnboarding('profile-telegram')}
          className="flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-500/10 px-2.5 py-1.5 text-[11px] text-teal-200 hover:bg-teal-500/20">
          {copiedOnboarding === 'telegram' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Hermes profile → Telegram Bot 연동
        </button>
        <button
          data-testid="portal-memory-open-buzz-agent-onboarding"
          onClick={() => setBuzzAgentSetupScope('global')}
          className="flex min-h-9 items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] text-cyan-200 hover:bg-cyan-500/20">
          <Bot className="h-3 w-3" /> Buzz 범용 Agent 생성·연결
        </button>
        <button
          data-testid="portal-memory-open-buzz-project-agent"
          onClick={() => setBuzzAgentSetupScope('service')}
          className="flex min-h-9 items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-200 hover:bg-violet-500/20">
          <Bot className="h-3 w-3" /> 프로젝트 → USE 서비스 Agent 만들기
        </button>
      </div>

      <div data-testid="hermes-telegram-readiness" className="rounded-xl border border-teal-500/20 bg-teal-500/5 p-3">
        <div className="text-[11px] font-semibold text-teal-100">Hermes + Telegram 시작 준비</div>
        <div className="mt-2 grid gap-1 text-[10px] text-zinc-400 sm:grid-cols-3">
          <span><b className="text-emerald-300">✓</b> Hermes 앱 설치 상태: 확인됨</span>
          <span><b className="text-emerald-300">✓</b> default profile: 존재</span>
          <span><b className={defaultHermesProfile?.telegramState === 'connected' ? 'text-emerald-300' : 'text-amber-300'}>{defaultHermesProfile?.telegramState === 'connected' ? '✓' : '○'}</b> default Telegram Bot: {defaultHermesProfile?.telegramState === 'connected' ? '연결됨' : defaultHermesProfile?.telegramConfigured ? '설정됨 · 확인 필요' : '연결 안 됨'}</span>
        </div>
        <div className="mt-2 text-[10px] text-zinc-500">Telegram 앱 로그인과 Telegram Bot 연결은 서로 다릅니다. Bot 연결은 아래에서 default profile을 선택해 진행합니다.</div>
      </div>

      <div data-testid="hermes-profile-status" className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold text-violet-100">Hermes profile 현황</div>
            <div data-testid="hermes-profile-device-scope" className="mt-0.5 text-[10px] text-zinc-500">이 단말 · <span className="text-sky-200">{deviceName || '이름 미등록'}{deviceId ? ` · ${deviceId.slice(0, 8)}` : ''}</span> · 로컬 Bot 서버와 Telegram Gateway를 각각 readback합니다.</div>
          </div>
          <button type="button" onClick={() => openOnboarding('profile-telegram')} className="rounded-md border border-teal-400/30 bg-teal-500/10 px-2.5 py-1.5 text-[10px] text-teal-200 hover:bg-teal-500/20">default Telegram 연결</button>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {onboardingProfiles.map(profile => {
            const status = hermesStatusLabel(profile);
            return <div key={profile.name} data-testid={`hermes-profile-status-${profile.name}`} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-[10px]">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1 truncate font-semibold text-zinc-200">{hermesProfileDisplayName(profile.name, profile.displayName)}</div>
                <button type="button" data-testid={`hermes-profile-rename-${profile.name}`} onClick={() => openHermesProfileRename(profile)} title="profile 이름 변경" className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-violet-200"><Pencil className="h-3 w-3" /></button>
                {profile.name !== 'default' && <button type="button" data-testid={`hermes-profile-delete-${profile.name}`} onClick={() => setDeletingHermesProfile(profile)} title="profile 삭제" className="rounded p-1 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-3 w-3" /></button>}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-zinc-500">
                <span>로컬 <b className={hermesStatusClass(status.local)}>{status.local}</b></span>
                <span>Telegram <b className={hermesStatusClass(status.telegram)}>{status.telegram}</b></span>
                <span>Gateway <b className={hermesStatusClass(status.gateway)}>{status.gateway}</b></span>
              </div>
            </div>;
          })}
          {!onboardingProfiles.length && <div className="text-[10px] text-amber-300">Hermes profile 현황을 조회하지 못했습니다.</div>}
        </div>
      </div>

      {renamingHermesProfile && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="hermes-profile-rename-title">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl">
            <h2 id="hermes-profile-rename-title" className="text-sm font-semibold text-zinc-100">Hermes profile 이름 변경</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{renamingHermesProfile.name === 'default' ? '기본 profile은 내부 ID default를 유지하고 화면 표시 이름만 변경합니다.' : 'profile ID와 명령 별칭이 함께 변경되며, 실행 중인 Gateway는 안전하게 중지됩니다.'}</p>
            <input autoFocus data-testid="hermes-profile-rename-input" value={hermesProfileNameDraft} onChange={event => setHermesProfileNameDraft(event.target.value)} className="mt-3 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-100 outline-none focus:border-violet-400/60" />
            {renamingHermesProfile.name !== 'default' && hermesProfileNameDraft && !validateHermesProfileName(hermesProfileNameDraft) && <div className="mt-1 text-[10px] text-amber-300">영문·숫자로 시작하는 64자 이내 ID를 입력하세요.</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={savingHermesProfile} onClick={() => setRenamingHermesProfile(null)} className="min-h-10 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400">취소</button>
              <button type="button" data-testid="hermes-profile-rename-confirm" disabled={savingHermesProfile || !hermesProfileNameDraft.trim() || hermesProfileNameDraft.trim() === (renamingHermesProfile.name === 'default' ? (renamingHermesProfile.displayName || 'Hermes') : renamingHermesProfile.name) || (renamingHermesProfile.name !== 'default' && !validateHermesProfileName(hermesProfileNameDraft))} onClick={() => void saveHermesProfileRename()} className="min-h-10 rounded-lg bg-violet-300 px-3 text-xs font-medium text-zinc-950 disabled:opacity-40">{savingHermesProfile ? '변경 중…' : '변경'}</button>
            </div>
          </div>
        </div>
      )}

      {deletingHermesProfile && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" role="alertdialog" aria-modal="true" aria-labelledby="hermes-profile-delete-title">
          <div className="w-full max-w-sm rounded-2xl border border-rose-500/25 bg-zinc-950 p-5 shadow-2xl">
            <h2 id="hermes-profile-delete-title" className="text-sm font-semibold text-rose-200">{hermesProfileDisplayName(deletingHermesProfile.name, deletingHermesProfile.displayName)} profile을 삭제할까요?</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">이 profile의 설정, API 키, 기억, 세션, 스킬, 예약 작업과 연결된 명령 별칭이 영구 삭제됩니다. Hermes 앱이 실행 중이면 Hermes Bots의 Delete bot만 사용해 로스터·서버·<code className="text-zinc-300">~/.hermes/profiles/{deletingHermesProfile.name}</code> 폴더를 함께 정리합니다. AI 프롬프트나 외부 CLI 삭제는 사용하지 않습니다.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={savingHermesProfile} onClick={() => setDeletingHermesProfile(null)} className="min-h-10 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400">취소</button>
              <button type="button" data-testid="hermes-profile-open-delete" disabled={savingHermesProfile} onClick={() => void openHermesForProfileDelete()} className="min-h-10 rounded-lg border border-rose-400/40 px-3 text-xs text-rose-200">Hermes에서 삭제</button>
              <button type="button" data-testid="hermes-profile-delete-confirm" title="Hermes 데스크톱 앱을 완전히 종료한 상태에서만 사용합니다." disabled={savingHermesProfile} onClick={() => void deleteHermesProfile()} className="min-h-10 rounded-lg bg-rose-300 px-3 text-xs font-medium text-zinc-950 disabled:opacity-40">{savingHermesProfile ? '삭제 중…' : 'Hermes 종료 후 삭제'}</button>
            </div>
          </div>
        </div>
      )}
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        통합 단말 필터는 앱 프로젝트가 있는 데스크톱과 등록된 AWS·Ubuntu 호스트를 함께 보여줍니다. 상단 「프로젝트 기기」 선택기는
        데스크톱 프로젝트 화면만 바꾸므로 단말 수가 다를 수 있습니다. {' '}
        사용자 별칭·기억 ID와 단말별 기억 해시·동기화 시각·Git HEAD를 함께 보여줍니다. Git 원격 비교는 각 단말이 마지막으로
        fetch한 추적 브랜치 기준이며, 「이 단말 상태 갱신」은 네트워크 fetch 없이 현재 상태만 보고합니다. 여기서 기억이 기기에 설치되지는 않습니다 — 복사한 ID를
        상대 기기의 AgentsToZ 앱 「다른 기억에 합류」 칸이나 Hermes <code className="text-zinc-400">/memory_link</code>에 붙여넣으세요.
        저장소가 없는 기억은 이 ID가 유일한 연결 수단입니다.
      </p>

      {initialLoadPending && (
        <div data-testid="portal-memory-initial-loading" role="status" aria-live="polite"
          className="flex min-h-24 items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-950/35 text-xs text-zinc-400">
          <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />장기기억과 단말 동기화 상태를 불러오는 중…
        </div>
      )}

      {error && (
        <div data-testid="portal-memory-error" className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <span className="whitespace-pre-wrap">장기기억 목록을 불러오지 못했습니다: {error}</span>
          {!isTauri() && hasSession === false && (
            <div className="mt-2">
              <button
                data-testid="portal-memory-signin"
                onClick={() => void signIn()}
                className="px-2.5 py-1.5 text-xs text-teal-200 border border-teal-500/30 bg-teal-500/10 rounded-lg hover:bg-teal-500/20">
                Google로 다시 로그인
              </button>
            </div>
          )}
        </div>
      )}

      {legacyDirectorySource && (
        <div data-testid="portal-memory-legacy-fallback" className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          구형 Supabase 스키마의 최근 리비전 호환 조회를 사용 중입니다. 최신 마이그레이션을 적용하면 모든 기억을 head 단위로 안전하게 조회합니다.
        </div>
      )}

      {windowFull && (
        <div data-testid="portal-memory-window-warning" className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          호환 윈도우인 최근 리비전 {MEMORY_REVISION_WINDOW}건을 모두 조회했습니다. 오래된 기억은 이 목록에 없을 수 있습니다.
        </div>
      )}

      {!error && !loading && allEntries.length === 0 && (
        <p className="text-xs text-zinc-500">아직 Supabase에 백업된 장기기억이 없습니다.</p>
      )}
      {!error && !loading && allEntries.length > 0 && entries.length === 0 && (
        <p className="text-xs text-zinc-500">{memoryView === 'trash' ? '휴지통이 비어 있습니다.' : '사용 중인 장기기억이 없습니다.'}</p>
      )}

      <div className="space-y-1.5">
        {displayedEntries.map(entry => {
          const identity = githubRepositoryIdentity(entry.githubUrl);
          const roles = repositoryRolesFor(entry.githubUrl, identity ? repositoryRoles[identity.repositoryUrl] : null);
          const localProject = localProjects[entry.memoryId];
          const historyOnlyStaleCount = entry.devices.filter(device => !device.retiredAt && !device.inSync && device.statusSource === 'revision').length;
          const confirmedStaleCount = entry.staleDeviceCount - historyOnlyStaleCount;
          const gitReportedDevices = entry.devices.filter(device => !device.retiredAt && !!device.gitHeadSha);
          const distinctGitHeads = new Set(gitReportedDevices.map(device => device.gitHeadSha)).size;
          const gitAttentionCount = gitReportedDevices.filter(device => {
            const state = memoryDeviceGitState(device);
            return state === 'dirty' || state === 'ahead' || state === 'behind' || state === 'diverged';
          }).length;
          const repositoryGuidance = memoryRepositoryGuidance(entry);
          const activeDeviceCount = entry.devices.filter(device => !device.retiredAt).length;
          return (
          <div
            key={entry.memoryId}
            data-testid="portal-memory-row"
            data-memory-id={entry.memoryId}
            className="border border-zinc-800/80 rounded-lg px-3 py-2.5 bg-zinc-900/40 hover:border-zinc-700 transition-colors">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-zinc-100 font-medium">{entry.displayName ?? entry.projectName}</span>
              <span title="프로젝트 개발·소스·Git·배포 결정을 위한 기존 장기기억" className="rounded border border-violet-400/20 bg-violet-500/[0.06] px-1.5 py-0.5 text-[10px] text-violet-200">DEV 프로젝트 기억</span>
              {entry.displayName && entry.displayName !== entry.projectName && <span className="text-[10px] text-zinc-600">{entry.projectName}</span>}
              <button data-testid="portal-memory-edit-label" onClick={() => setEditingLabel({ memoryId: entry.memoryId, displayName: entry.displayName ?? fallbackMemoryDisplayName(entry.projectName, entry.githubUrl) })}
                className="p-0.5 text-zinc-600 hover:text-zinc-300" title="사용자용 장기기억 별칭 편집"><Pencil className="w-3 h-3" /></button>
              {entry.githubUrl ? (
                <div data-testid="portal-memory-repository-roles" className="flex items-center gap-1.5 flex-wrap">
                  <a href={entry.githubUrl} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300">
                    <Github className="w-3 h-3" />저장소
                  </a>
                  {roles && <span className="text-[10px] text-zinc-500">소유자 <span className="text-zinc-300">@{roles.ownerLogin}</span></span>}
                  {roles && roles.collaborators.length > 0 && (
                    <span className="text-[10px] text-zinc-500">협업자 <span className="text-zinc-300">{roles.collaborators.map(login => `@${login}`).join(', ')}</span></span>
                  )}
                  <button data-testid="portal-memory-edit-repository-roles" onClick={() => editRepositoryRoles(entry)}
                    className="p-0.5 text-zinc-600 hover:text-zinc-300" title="GitHub 소유자·협업자 편집">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <span className="text-[10px] text-amber-300/70 border border-amber-500/20 rounded px-1.5 py-0.5">저장소 없음 · ID로만 연결</span>
              )}
              <span className="ml-auto text-[10px] text-zinc-600">
                {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('ko-KR') : '시각 미상'}
                {entry.lastDeviceName ? ` · ${entry.lastDeviceName}` : ''}
                {entry.deviceCountInWindow > 1 ? ` 외 ${entry.deviceCountInWindow - 1}대` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <code className="text-[11px] text-zinc-400 font-mono break-all">{entry.memoryId}</code>
              <button
                data-testid="portal-memory-copy-id"
                onClick={() => void copyMemoryId(entry.memoryId)}
                title="이 ID를 다른 기기의 앱이나 Hermes /memory_link 에 붙여넣으세요"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-teal-300 border border-teal-500/25 bg-teal-500/5 rounded hover:bg-teal-500/10">
                {copied === entry.memoryId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                ID 복사
              </button>
              <button
                data-testid="portal-memory-view"
                onClick={() => void openContent(entry)}
                disabled={viewLoading}
                className="px-2 py-1 text-[10px] text-zinc-400 border border-zinc-800 rounded hover:text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40">
                내용 보기
              </button>
              <button
                data-testid="portal-memory-find-local"
                onClick={() => void findLocalProject(entry)}
                disabled={localProject?.status === 'checking'}
                title="이 브라우저가 실행 중인 단말의 AgentsToZ 등록 프로젝트에서 이 장기기억 ID를 찾습니다"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-sky-300 border border-sky-500/20 bg-sky-500/5 rounded hover:bg-sky-500/10 disabled:opacity-40">
                {localProject?.status === 'checking'
                  ? <RefreshCw className="w-3 h-3 animate-spin" />
                  : <FolderSearch className="w-3 h-3" />}
                이 단말에서 폴더 찾기
              </button>
              <button data-testid="portal-memory-refresh-local-state"
                onClick={() => void refreshLocalDeviceState(entry)}
                disabled={refreshingLocalState === entry.memoryId}
                title="등록 프로젝트를 memoryId로 안전하게 찾은 뒤 장기기억 hash와 Git HEAD를 Supabase에 보고합니다"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-violet-300 border border-violet-500/20 bg-violet-500/5 rounded hover:bg-violet-500/10 disabled:opacity-40">
                <RefreshCw className={`w-3 h-3 ${refreshingLocalState === entry.memoryId ? 'animate-spin' : ''}`} />
                이 단말 상태 갱신
              </button>
              <button data-testid="portal-memory-connect-cloud"
                onClick={() => { setPreferredRemoteMemoryId(entry.memoryId); setShowRemoteDevices(true); }}
                title="이 장기기억을 AWS/Linux 서버에 연결할 복붙 명령을 만듭니다"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-emerald-300 border border-emerald-500/20 bg-emerald-500/5 rounded hover:bg-emerald-500/10">
                <Cloud className="w-3 h-3" />AWS·서버 연결
              </button>
              {memoryView === 'active' ? (
                <button data-testid="portal-memory-move-to-trash" onClick={() => setTrashDraft(entry)}
                  title="원본과 모든 이력을 보존한 채 기본 목록에서 숨깁니다"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-rose-300 border border-rose-500/20 bg-rose-500/5 rounded hover:bg-rose-500/10">
                  <Trash2 className="w-3 h-3" />휴지통
                </button>
              ) : (
                <button data-testid="portal-memory-restore-from-trash" onClick={() => void setMemoryTrashed(entry, false)}
                  disabled={trashingMemory === entry.memoryId}
                  title="장기기억을 사용 중 목록으로 되돌립니다"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-teal-300 border border-teal-500/20 bg-teal-500/5 rounded hover:bg-teal-500/10 disabled:opacity-40">
                  {trashingMemory === entry.memoryId ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}복원
                </button>
              )}
            </div>
            {memoryView === 'active' && repositoryGuidance && (
              <details
                data-testid="portal-memory-repository-guidance"
                data-guidance-kind={repositoryGuidance.kind}
                className={`group mt-2 rounded-md border ${repositoryGuidance.kind === 'memory-only'
                  ? 'border-zinc-800 bg-zinc-950/40'
                  : repositoryGuidance.kind === 'stale'
                    ? 'border-rose-500/20 bg-rose-500/[0.04]'
                    : repositoryGuidance.priority === 'high'
                      ? 'border-amber-500/25 bg-amber-500/[0.05]'
                      : 'border-sky-500/20 bg-sky-500/[0.04]'}`}>
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-[10px] [&::-webkit-details-marker]:hidden">
                  {repositoryGuidance.kind === 'stale'
                    ? <Archive className="h-3 w-3 shrink-0 text-rose-300" />
                    : repositoryGuidance.kind === 'memory-only'
                      ? <Brain className="h-3 w-3 shrink-0 text-zinc-500" />
                      : <Github className={`h-3 w-3 shrink-0 ${repositoryGuidance.priority === 'high' ? 'text-amber-300' : 'text-sky-300'}`} />}
                  <span className={repositoryGuidance.kind === 'memory-only'
                    ? 'text-zinc-400'
                    : repositoryGuidance.kind === 'stale'
                      ? 'text-rose-200'
                      : repositoryGuidance.priority === 'high' ? 'text-amber-200' : 'text-sky-200'}>
                    {repositoryGuidance.kind === 'memory-only'
                      ? '저장소 선택사항 · 기억 전용 항목으로 보임'
                      : repositoryGuidance.kind === 'stale'
                        ? `정리 검토 · ${repositoryGuidance.inactiveDays}일간 기억·Git 변경 없음`
                        : repositoryGuidance.priority === 'high'
                          ? `저장소 연결 우선 권장${activeDeviceCount > 1 ? ` · 사용 단말 ${activeDeviceCount}대` : ''}`
                          : '저장소 연결 권장'}
                  </span>
                  <span className="ml-auto text-zinc-600 group-open:hidden">단계 보기</span>
                  <span className="ml-auto hidden text-zinc-600 group-open:inline">접기</span>
                </summary>
                <div className="border-t border-white/5 px-2.5 pb-2.5 pt-2 text-[10px] leading-relaxed text-zinc-400">
                  {repositoryGuidance.kind === 'memory-only' ? (
                    <p>Telegram 토픽처럼 코드·파일이 없는 기억이라면 그대로 유지해도 됩니다. 실제 프로젝트 폴더가 있다면 아래 연결 절차를 진행하세요.</p>
                  ) : repositoryGuidance.kind === 'stale' ? (
                    <div className="flex items-center gap-3 flex-wrap">
                      <p className="min-w-0 flex-1">더 이상 쓰지 않는 프로젝트인지 먼저 확인하세요. 휴지통은 원본·리비전·단말 이력을 지우지 않으며 언제든 복원할 수 있습니다.</p>
                      <button
                        data-testid="portal-memory-stale-trash-review"
                        onClick={() => setTrashDraft(entry)}
                        className="flex min-h-8 items-center gap-1 rounded border border-rose-500/25 bg-rose-500/5 px-2 text-rose-200 hover:bg-rose-500/10">
                        <Trash2 className="h-3 w-3" />휴지통 검토
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p>여러 단말에서 코드·파일과 장기기억을 함께 이어 쓰기 위한 권장 순서입니다.</p>
                      <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-zinc-300">
                        <li>위의 「이 단말에서 폴더 찾기」로 실제 프로젝트를 확인합니다.</li>
                        <li>AgentsToZ 앱의 프로젝트 수정에서 GitHub 저장소 주소를 연결합니다.</li>
                        <li>장기기억을 Push해 저장소 주소와 최신 기억을 함께 반영합니다.</li>
                      </ol>
                    </div>
                  )}
                </div>
              </details>
            )}
            {localProject?.status === 'found' && localProject.path && (
              <div data-testid="portal-memory-local-found" className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 flex-wrap">
                <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="text-[10px] text-emerald-300">이 단말에서 찾음</span>
                <code className="min-w-0 flex-1 text-[10px] text-zinc-400 font-mono break-all">{localProject.path}</code>
                <button data-testid="portal-memory-open-local-folder"
                  onClick={() => void openLocalProject(
                    entry.memoryId,
                    localProject.path!,
                    localProject.matchedMemoryId ?? entry.memoryId,
                  )}
                  className="flex items-center gap-1 text-[10px] text-emerald-300 hover:text-emerald-200">
                  <FolderOpen className="w-3 h-3" />폴더 열기
                </button>
              </div>
            )}
            {(localProject?.status === 'not-found' || localProject?.status === 'unavailable') && (
              <div data-testid="portal-memory-local-missing" className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
                <div className="flex items-start gap-1.5 text-[10px] text-amber-200/90">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{localProject.status === 'not-found'
                    ? '이 단말의 등록 프로젝트에서는 찾지 못했습니다.'
                    : '이 단말의 AgentsToZ 로컬 API에 연결하지 못했습니다.'}
                    {localProject.detail ? ` ${localProject.detail}` : ''}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                  {(['darwin', 'win32'] as const).map(platform => {
                    const copyKey = `${entry.memoryId}:local:${platform}`;
                    return (
                      <button key={platform} data-testid="portal-memory-copy-find-local"
                        onClick={() => void copyFindCommand(entry.memoryId, 'local', platform)}
                        className="flex items-center gap-1 text-[11px] text-amber-200 hover:text-amber-100">
                        {copiedFind === copyKey ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {platform === 'win32' ? 'Windows 찾기 명령' : 'macOS/Linux 찾기 명령'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {entry.legacyMemoryIds.length > 0 && (
              <div data-testid="portal-memory-lineage" className="mt-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-2.5 py-2 text-[11px] text-zinc-400">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <GitMerge className="w-3 h-3 text-sky-300" />
                  <span>이전 ID {entry.legacyMemoryIds.map(id => id.slice(0, 8)).join(', ')} → 현재 {entry.memoryId.slice(0, 8)}</span>
                  <span className={entry.mergeStatus === 'complete' ? 'text-emerald-400' : 'text-amber-300'}>
                    {entry.mergeStatus === 'complete' ? '알려진 단말 전환 완료' : `전환 대기 ${entry.pendingMigrationDeviceCount}대`}
                  </span>
                </div>
                <p className="mt-1 text-zinc-600">이전 ID는 삭제하지 않고 계속 현재 ID로 연결됩니다. 늦게 접속한 단말도 고아가 되지 않습니다.</p>
              </div>
            )}
            <div className="mt-2.5 pt-2.5 border-t border-zinc-800/70">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-[11px] text-zinc-500">단말 동기화</span>
                <code className="text-[11px] text-zinc-600 font-mono">최신 {entry.headRevisionId.slice(0, 8)}</code>
                <span className="text-[11px] text-emerald-400/80">최신 {entry.syncedDeviceCount}</span>
                {confirmedStaleCount > 0 && <span className="text-[11px] text-amber-300">실제 확인 필요 {confirmedStaleCount}</span>}
                {historyOnlyStaleCount > 0 && (
                  <span data-testid="portal-memory-history-estimate" className="text-[11px] text-amber-300/80"
                    title="단말 현황 보고가 아니라 과거 Push 버전으로 추정한 값입니다">
                    과거 Push 이력 추정 {historyOnlyStaleCount}
                  </span>
                )}
                {entry.retiredDeviceCount > 0 && <span className="text-[11px] text-zinc-600">확인 제외 {entry.retiredDeviceCount}</span>}
                {gitReportedDevices.length > 0 && (
                  <span data-testid="portal-memory-git-summary" className={`text-[11px] ${gitAttentionCount > 0 || distinctGitHeads > 1 ? 'text-amber-300' : 'text-emerald-400/80'}`}>
                    Git {gitReportedDevices.length}대 · {distinctGitHeads}개 HEAD{gitAttentionCount > 0 ? ` · 확인 ${gitAttentionCount}` : ''}
                  </span>
                )}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {entry.devices.map(device => (
                  <div key={device.deviceId} data-testid="portal-memory-device"
                    data-device-retired={device.retiredAt ? 'true' : 'false'}
                    className={`min-w-0 rounded-md border px-2.5 py-2 ${device.retiredAt
                      ? 'border-zinc-800 bg-zinc-900/70 opacity-75'
                      : device.inSync ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {device.retiredAt
                        ? <Archive className="w-3 h-3 text-zinc-500 shrink-0" />
                        : device.inSync ? <Check className="w-3 h-3 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-3 h-3 text-amber-300 shrink-0" />}
                      <span className="text-[11px] text-zinc-200 truncate">{device.deviceName}</span>
                      <code className="text-[11px] text-zinc-700 font-mono shrink-0">{device.deviceId.slice(0, 8)}</code>
                      <span className="ml-auto text-[11px] text-zinc-600 shrink-0">{devicePlatformLabel(device.platform)}</span>
                    </div>
                    {device.telegramThreadId && <div className="mt-1 text-[11px] text-sky-300">Telegram 토픽 #{device.telegramThreadId}</div>}
                    {(device.identityWarning || device.legacyDeviceIds.length > 0) && (
                      <details
                        data-testid="portal-memory-device-identity-details"
                        className={`group mt-1 rounded border ${device.identityWarning
                          ? 'border-amber-500/20 bg-amber-500/[0.04]'
                          : 'border-sky-500/15 bg-sky-500/[0.03]'}`}>
                        <summary
                          data-testid={device.identityWarning ? 'portal-memory-device-identity-warning' : 'portal-memory-device-legacy-ids'}
                          className={`flex min-h-7 cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[11px] [&::-webkit-details-marker]:hidden ${device.identityWarning
                            ? 'text-amber-200/90'
                            : 'text-sky-200/75'}`}>
                          {device.identityWarning
                            ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                            : <Link2 className="h-2.5 w-2.5 shrink-0" />}
                          <span>{device.identityWarning ? '단말 식별 확인 권장' : '이전 설치 연결됨'}</span>
                          {device.legacyDeviceIds.length > 0 && (
                            <span className="text-zinc-500">· 이전 설치 {device.legacyDeviceIds.length}개</span>
                          )}
                          <span className="ml-auto text-zinc-600 group-open:hidden">자세히</span>
                          <span className="ml-auto hidden text-zinc-600 group-open:inline">접기</span>
                        </summary>
                        <div className="border-t border-white/5 px-2 pb-2 pt-1.5 text-[11px] text-zinc-400">
                          {device.identityWarning && (
                            <div className="space-y-1">
                              <p>
                                현재는 {devicePlatformLabel(device.platform)}로 확인됐지만 과거 이름에 다른 환경으로 보이는 값이 있습니다.
                                같은 물리 단말의 이전 이름이면 그대로 두어도 됩니다. 다른 단말이라면 아래의 중복 단말 정리에서 연결을 바로잡으세요.
                              </p>
                              <p className="text-zinc-500">과거 이름 · {device.historicalNames.join(' · ') || device.deviceName}</p>
                            </div>
                          )}
                          {device.legacyDeviceIds.length > 0 && (
                            <div className={device.identityWarning ? 'mt-2' : ''} data-testid="portal-memory-device-legacy-ids-expanded">
                              <div className="flex items-center gap-1 text-sky-200/70">
                                <Link2 className="h-2.5 w-2.5" />같은 단말의 이전 설치 ID {device.legacyDeviceIds.map(id => id.slice(0, 8)).join(', ')} 연결됨
                              </div>
                              <div className="mt-1 flex flex-wrap gap-2">
                                {device.legacyDeviceIds.map(aliasId => (
                                  <button
                                    key={aliasId}
                                    aria-label={`이전 설치 ID ${aliasId.slice(0, 8)} 연결 해제`}
                                    onClick={() => void unlinkDeviceIdentity(aliasId)}
                                    className="flex min-h-7 items-center gap-1 text-zinc-500 hover:text-zinc-300">
                                    <Unlink className="h-2.5 w-2.5" />{aliasId.slice(0, 8)} 해제
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </details>
                    )}
                    <div data-testid="portal-memory-device-memory-state" className="mt-1.5 rounded bg-black/15 px-1.5 py-1 text-[11px] text-zinc-600">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Brain className="w-3 h-3 text-teal-400/80" />
                        <span className="text-zinc-500">기억</span>
                        <code className="font-mono" title={device.contentHash ?? undefined}>
                          hash {device.contentHash?.slice(0, 10) ?? '미상'}
                        </code>
                        <code className="font-mono" title={device.revisionId ?? undefined}>rev {device.revisionId?.slice(0, 8) ?? '미상'}</code>
                        <span className={device.statusSource === 'revision' && !device.retiredAt ? 'text-amber-300/70' : device.inSync ? 'text-emerald-400/80' : 'text-amber-300'}>
                          {device.retiredAt ? '확인 대상 제외 · 이력 보존' : device.statusSource === 'confirmed' ? (device.inSync ? '최신 일치' : '확인 필요') : '과거 Push · 현재 미확인'}
                        </span>
                      </div>
                      <div className="mt-0.5 pl-[18px]">
                        {device.lastSyncedAt ? `동기화 ${new Date(device.lastSyncedAt).toLocaleString('ko-KR')}` : `마지막 관측 ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString('ko-KR') : '시각 미상'}`}
                      </div>
                      {device.sourcePath && <code className="mt-0.5 block truncate pl-[18px] font-mono text-zinc-500" title={device.sourcePath}>{device.sourcePath}</code>}
                    </div>
                    <div data-testid="portal-memory-device-git-state" className="mt-1 rounded bg-black/15 px-1.5 py-1 text-[11px] text-zinc-600">
                      {(() => {
                        const git = gitStatePresentation(device);
                        return <>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <GitBranch className="w-3 h-3 text-sky-400/80" />
                            <span className="text-zinc-500">Git</span>
                            {device.gitBranch && <code className="font-mono">{device.gitBranch}</code>}
                            <code className="font-mono" title={device.gitHeadSha ?? undefined}>HEAD {device.gitHeadSha?.slice(0, 10) ?? '미보고'}</code>
                            <span className={git.className}>{git.label}</span>
                          </div>
                          <div className="mt-0.5 pl-[18px] flex gap-2 flex-wrap">
                            {device.gitCommitAt && <span>커밋 {new Date(device.gitCommitAt).toLocaleString('ko-KR')}</span>}
                            {device.gitCheckedAt && <span title="GitHub 네트워크 조회가 아니라 이 단말의 마지막 fetch 추적 ref 기준입니다">확인 {new Date(device.gitCheckedAt).toLocaleString('ko-KR')}</span>}
                            {device.gitFetchOk === true && <span className="text-emerald-500/80">fetch 성공</span>}
                            {device.gitFetchOk === false && <span className="text-rose-300" title={device.gitFetchError ?? undefined}>fetch 실패{device.gitFetchError ? ` · ${device.gitFetchError}` : ''}</span>}
                          </div>
                        </>;
                      })()}
                    </div>
                    {!device.inSync && !device.retiredAt && (
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        {(normalizeDevicePlatform(device.platform) === 'unknown'
                          ? [{ platform: 'darwin', label: 'macOS/Linux 명령' }, { platform: 'win32', label: 'Windows 명령' }]
                          : [{ platform: device.platform, label: '동기화 명령 복사' }]
                        ).map(option => {
                          const copyKey = `${device.deviceId}:${normalizeDevicePlatform(option.platform)}`;
                          return (
                            <button key={option.platform} data-testid="portal-memory-copy-sync"
                              onClick={() => void copySyncCommand(device.deviceId, option.platform)}
                              title="이 명령을 복사해 해당 단말의 프로젝트 폴더에서 실행하세요"
                              className="flex items-center gap-1 text-[10px] text-amber-200 hover:text-amber-100">
                              {copiedSync === copyKey ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                              {option.label}
                            </button>
                          );
                        })}
                        {(normalizeDevicePlatform(device.platform) === 'unknown'
                          ? [{ platform: 'darwin', label: 'macOS/Linux 폴더 찾기' }, { platform: 'win32', label: 'Windows 폴더 찾기' }]
                          : [{ platform: device.platform, label: '폴더 찾기 명령 복사' }]
                        ).map(option => {
                          const copyKey = `${entry.memoryId}:${device.deviceId}:${normalizeDevicePlatform(option.platform)}`;
                          return (
                            <button key={`find-${option.platform}`} data-testid="portal-memory-copy-find"
                              onClick={() => void copyFindCommand(entry.memoryId, device.deviceId, option.platform)}
                              title="해당 단말의 어느 폴더에서나 실행해 등록 프로젝트 경로를 찾습니다"
                              className="flex items-center gap-1 text-[10px] text-sky-300 hover:text-sky-200">
                              {copiedFind === copyKey ? <Check className="w-3 h-3" /> : <FolderSearch className="w-3 h-3" />}
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="mt-1.5 flex justify-end gap-3">
                      {entry.devices.length > 1 && <button data-testid="portal-memory-link-device-id"
                        onClick={() => openDeviceIdentityLink(entry, device.deviceId)}
                        title="같은 컴퓨터가 두 개로 보일 때 중복 항목을 한 단말로 묶습니다. 프로젝트와 기억은 삭제되지 않습니다."
                        className="flex items-center gap-1 text-[9.5px] text-sky-500 hover:text-sky-300">
                        <Link2 className="w-3 h-3" />중복 단말 정리
                      </button>}
                      <button data-testid="portal-memory-retire-device"
                        disabled={retiringDevice === `${entry.memoryId}:${device.deviceId}`}
                        onClick={() => device.retiredAt
                          ? void setDeviceRetired(entry, device.deviceId, false)
                          : setPendingRetirement({ memoryId: entry.memoryId, deviceId: device.deviceId })}
                        title={device.retiredAt ? '이 단말을 다시 동기화 확인 대상에 포함합니다' : '이력은 보존하고 동기화 확인 대상에서 제외합니다'}
                        className="flex items-center gap-1 text-[9.5px] text-zinc-600 hover:text-zinc-300 disabled:opacity-40">
                        {retiringDevice === `${entry.memoryId}:${device.deviceId}`
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : device.retiredAt ? <RotateCcw className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                        {device.retiredAt ? '다시 확인' : '확인 대상에서 제외'}
                      </button>
                    </div>
                  </div>
                ))}
                {entry.devices.length === 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-600"><Laptop className="w-3 h-3" />아직 단말 확인 정보가 없습니다.</div>
                )}
              </div>
            </div>
          </div>
        );})}
        {displayedEntries.length < visible.length && (
          <div className="flex justify-center py-2">
            <button data-testid="portal-memory-show-more" onClick={() => setVisibleLimit(current => current + 15)}
              className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 text-xs text-zinc-300 hover:bg-zinc-800">
              다음 {Math.min(15, visible.length - displayedEntries.length)}개 더 보기 · {displayedEntries.length}/{visible.length}
            </button>
          </div>
        )}
        {!loading && entries.length > 0 && visible.length === 0 && (
          <p className="text-xs text-zinc-500">{selectedDeviceId || repositoryFilter !== 'all'
            ? '선택한 단말·저장소 조건에 맞는 장기기억이 없습니다.'
            : '검색 결과가 없습니다.'}</p>
        )}
      </div>

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div
            ref={secondaryDialogRef}
            data-testid="portal-memory-viewer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-viewer-title"
            tabIndex={-1}
            className="bg-[#111113] border border-zinc-800 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
              <Brain className="w-4 h-4 text-teal-400" />
              <h2 id="memory-viewer-title" className="text-sm text-zinc-100">{viewing.entry.projectName}</h2>
              <code className="text-[10px] text-zinc-600 font-mono">{viewing.entry.memoryId}</code>
              <button data-dialog-initial aria-label="장기기억 내용 닫기" onClick={() => setViewing(null)} className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
              {viewing.content || '(내용이 비어 있습니다)'}
            </pre>
          </div>
        </div>
      )}

      {showRemoteDevices && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={() => setShowRemoteDevices(false)}>
          <div ref={remoteDevicesModalRef} data-testid="portal-memory-remote-device-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-device-dialog-title" className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[#111113] border border-zinc-800 rounded-xl" onClick={event => event.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-[#111113]">
              <Cloud className="w-4 h-4 text-emerald-400" />
              <h2 id="cloud-device-dialog-title" className="text-sm text-zinc-100">클라우드·서버 단말 관리</h2>
              <button autoFocus aria-label="클라우드 단말 관리 닫기" className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-200" onClick={() => setShowRemoteDevices(false)}><X className="w-4 h-4" /></button>
            </div>
            <RemoteDeviceManager
              supabaseUrl={supabaseUrl}
              supabaseKey={supabaseKey}
              entries={activeEntries}
              initialMemoryId={preferredRemoteMemoryId}
              showToast={showToast}
            />
          </div>
        </div>
      )}

      {trashDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => setTrashDraft(null)}>
          <div ref={secondaryDialogRef} data-testid="portal-memory-trash-confirm" role="dialog" aria-modal="true" aria-labelledby="memory-trash-title" tabIndex={-1}
            className="w-full max-w-lg rounded-xl border border-rose-500/25 bg-[#111113]" onClick={event => event.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <Trash2 className="h-4 w-4 text-rose-300" />
              <h2 id="memory-trash-title" className="text-sm text-zinc-100">장기기억을 휴지통으로 옮길까요?</h2>
              <button data-dialog-initial aria-label="휴지통 이동 취소" onClick={() => setTrashDraft(null)} className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 p-4 text-[11px] leading-relaxed text-zinc-300">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="font-medium text-zinc-100">{trashDraft.displayName ?? trashDraft.projectName}</div>
                <code className="mt-1 block break-all text-[10px] text-zinc-500">{trashDraft.memoryId}</code>
              </div>
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
                <p className="font-medium text-rose-200">바뀌는 것</p>
                <p className="mt-1">기본 장기기억 목록·검색·동기화 경고에서 숨겨집니다.</p>
              </div>
              <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3">
                <p className="font-medium text-teal-200">지워지지 않는 것</p>
                <p className="mt-1">기억 내용, 모든 리비전, 프로젝트·단말·Git 이력, 합병 계보는 그대로 남습니다. 휴지통에서 언제든 복원할 수 있습니다.</p>
              </div>
              <p className="text-zinc-500">안전을 위해 이 화면에서는 영구 삭제를 제공하지 않습니다.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button onClick={() => setTrashDraft(null)} className="min-h-11 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300">취소</button>
              <button disabled={trashingMemory === trashDraft.memoryId} onClick={() => void setMemoryTrashed(trashDraft, true)}
                className="min-h-11 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-40">
                {trashingMemory === trashDraft.memoryId ? '옮기는 중…' : '휴지통으로 옮기기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRetirement && pendingRetirementEntry && pendingRetirementDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => setPendingRetirement(null)}>
          <div ref={secondaryDialogRef} data-testid="portal-memory-retirement-confirm" role="dialog" aria-modal="true" aria-labelledby="memory-retirement-title" tabIndex={-1}
            className="w-full max-w-lg rounded-xl border border-amber-500/25 bg-[#111113]" onClick={event => event.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <Archive className="h-4 w-4 text-amber-300" />
              <h2 id="memory-retirement-title" className="text-sm text-zinc-100">이 단말을 확인 대상에서 제외할까요?</h2>
              <button data-dialog-initial aria-label="확인 대상 제외 취소" onClick={() => setPendingRetirement(null)} className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 p-4 text-[11px] leading-relaxed text-zinc-300">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="font-medium text-zinc-100">{pendingRetirementDevice.deviceName}</div>
                <code className="mt-1 block break-all text-[10px] text-zinc-500">{pendingRetirementDevice.deviceId}</code>
                <div className="mt-1 text-zinc-500">장기기억: {pendingRetirementEntry.displayName ?? pendingRetirementEntry.projectName}</div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <p className="font-medium text-amber-200">바뀌는 것</p>
                <p className="mt-1">이 장기기억의 최신/확인 필요 집계와 합병 전환 대기에서 이 단말만 제외됩니다.</p>
              </div>
              <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3">
                <p className="font-medium text-teal-200">지워지지 않는 것</p>
                <p className="mt-1">장기기억 ID·내용·리비전·Git 이력·단말 항목은 그대로 보존되며, 「다시 확인」으로 즉시 되돌릴 수 있습니다.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button onClick={() => setPendingRetirement(null)} className="min-h-11 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300">취소</button>
              <button disabled={retiringDevice === `${pendingRetirementEntry.memoryId}:${pendingRetirementDevice.deviceId}`}
                onClick={() => void setDeviceRetired(pendingRetirementEntry, pendingRetirementDevice.deviceId, true)}
                className="min-h-11 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 text-xs text-amber-100 disabled:opacity-40">
                {retiringDevice ? '변경 중…' : '확인 대상에서 제외'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deviceIdentityDraft && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={() => setDeviceIdentityDraft(null)}>
          <div ref={secondaryDialogRef} data-testid="portal-memory-device-identity-modal" role="dialog" aria-modal="true" aria-labelledby="memory-device-identity-title" tabIndex={-1} className="w-full max-w-lg bg-[#111113] border border-zinc-800 rounded-xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
              <Link2 className="w-4 h-4 text-sky-400" />
              <h2 id="memory-device-identity-title" className="text-sm text-zinc-100">중복 단말 정리 · {deviceIdentityDraft.confirming ? '최종 확인' : '항목 선택'}</h2>
              <button data-dialog-initial aria-label="중복 단말 정리 닫기" className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500" onClick={() => setDeviceIdentityDraft(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="space-y-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 text-[11px] leading-relaxed text-zinc-300">
                <p><strong className="font-medium text-sky-200">언제 쓰나요?</strong> 같은 Mac·PC에 앱을 다시 설치하거나 설정을 초기화한 뒤, 같은 컴퓨터가 두 개 이상 보일 때만 사용합니다.</p>
                <p><strong className="font-medium text-sky-200">무엇이 바뀌나요?</strong> 과거 항목의 프로젝트·장기기억·Git 이력을 지금 사용하는 단말 카드에서 함께 보여줍니다. 데이터는 이동하거나 삭제하지 않습니다.</p>
                <p className="text-amber-200">서로 다른 컴퓨터는 묶지 마세요.</p>
              </div>
              {!deviceIdentityDraft.confirming ? <>
                <label className="block text-[11px] text-zinc-400">같은 컴퓨터의 과거 항목
                  <select value={deviceIdentityDraft.aliasDeviceId} onChange={event => setDeviceIdentityDraft(current => current ? { ...current, aliasDeviceId: event.target.value, confirming: false } : current)} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200">
                    <option value="">선택</option>
                    {deviceIdentityDraft.entry.devices.filter(device => device.deviceId !== deviceIdentityDraft.canonicalDeviceId).map(device => <option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.deviceId}</option>)}
                  </select>
                </label>
                <label className="block text-[11px] text-zinc-400">지금 사용하는 항목 (대표)
                  <select value={deviceIdentityDraft.canonicalDeviceId} onChange={event => setDeviceIdentityDraft(current => current ? { ...current, canonicalDeviceId: event.target.value, confirming: false } : current)} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200">
                    {deviceIdentityDraft.entry.devices.filter(device => !device.legacyDeviceIds.includes(device.deviceId)).map(device => <option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.deviceId}</option>)}
                  </select>
                </label>
              </> : <div data-testid="portal-memory-device-identity-preview" className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="text-[10px] text-zinc-500">과거 항목</div>
                    <div className="mt-1 text-xs text-zinc-100">{identityAliasDevice?.deviceName ?? '선택 안 됨'}</div>
                    <code className="mt-1 block break-all text-[9px] text-zinc-600">{deviceIdentityDraft.aliasDeviceId}</code>
                  </div>
                  <span className="text-center text-sky-300">→</span>
                  <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
                    <div className="text-[10px] text-sky-300">앞으로 보일 대표 항목</div>
                    <div className="mt-1 text-xs text-zinc-100">{identityCanonicalDevice?.deviceName ?? '선택 안 됨'}</div>
                    <code className="mt-1 block break-all text-[9px] text-zinc-600">{deviceIdentityDraft.canonicalDeviceId}</code>
                  </div>
                </div>
                <p className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-3 text-[11px] text-teal-100">확정하면 과거 ID는 대표 ID의 별칭이 됩니다. 항목·프로젝트·기억·Git 이력은 삭제되거나 복사되지 않고, 화면에서 한 물리 단말의 이력으로 합쳐 보입니다.</p>
              </div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button onClick={() => deviceIdentityDraft.confirming ? setDeviceIdentityDraft(current => current ? { ...current, confirming: false } : current) : setDeviceIdentityDraft(null)} className="min-h-11 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400">{deviceIdentityDraft.confirming ? '이전' : '취소'}</button>
              {!deviceIdentityDraft.confirming ? (
                <button disabled={!deviceIdentityDraft.aliasDeviceId || !deviceIdentityDraft.canonicalDeviceId || deviceIdentityDraft.aliasDeviceId === deviceIdentityDraft.canonicalDeviceId}
                  onClick={() => setDeviceIdentityDraft(current => current ? { ...current, confirming: true } : current)} className="min-h-11 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 text-xs text-sky-100 disabled:opacity-40">변경 내용 확인</button>
              ) : (
                <button disabled={deviceIdentityDraft.saving} onClick={() => void saveDeviceIdentityLink()} className="min-h-11 rounded-lg bg-sky-300 px-3 text-xs font-medium text-zinc-950 disabled:opacity-40">{deviceIdentityDraft.saving ? '묶는 중…' : '확인하고 한 단말로 묶기'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {editingRepository && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setEditingRepository(null)}>
          <div ref={secondaryDialogRef} role="dialog" aria-modal="true" aria-labelledby="memory-repository-title" tabIndex={-1} className="w-full max-w-md bg-[#111113] border border-zinc-800 rounded-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
              <Github className="w-4 h-4 text-zinc-400" />
              <h2 id="memory-repository-title" className="text-sm text-zinc-100">GitHub 저장소 역할</h2>
              <button data-dialog-initial aria-label="GitHub 저장소 역할 닫기" className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-200" onClick={() => setEditingRepository(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <code className="block text-[10px] text-zinc-600 break-all">{editingRepository.repositoryUrl}</code>
              <label className="block">
                <span className="block text-[11px] text-zinc-400 mb-1">소유자</span>
                <input value={editingRepository.ownerLogin}
                  onChange={e => setEditingRepository(current => current ? { ...current, ownerLogin: e.target.value } : current)}
                  placeholder="intenet1001"
                  className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-teal-500/50" />
              </label>
              <label className="block">
                <span className="block text-[11px] text-zinc-400 mb-1">협업자 (쉼표 또는 줄바꿈)</span>
                <textarea value={editingRepository.collaborators}
                  onChange={e => setEditingRepository(current => current ? { ...current, collaborators: e.target.value } : current)}
                  placeholder={'intenet1002\nother-collaborator'} rows={3}
                  className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-teal-500/50 resize-y" />
              </label>
              <p className="text-[10px] text-zinc-600">GitHub 토큰을 저장하지 않고, 이 Supabase 프로젝트에 역할 메타데이터만 공유합니다.</p>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button onClick={() => setEditingRepository(null)} className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg">취소</button>
              <button disabled={savingRepository} onClick={() => void saveRepositoryRoles()}
                className="px-3 py-1.5 text-xs text-zinc-950 bg-teal-300 hover:bg-teal-200 rounded-lg disabled:opacity-50">
                {savingRepository ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingLabel && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setEditingLabel(null)}>
          <div ref={secondaryDialogRef} data-testid="portal-memory-label-modal" role="dialog" aria-modal="true" aria-labelledby="memory-label-title" tabIndex={-1} className="w-full max-w-md bg-[#111113] border border-zinc-800 rounded-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
              <Brain className="w-4 h-4 text-teal-400" /><h2 id="memory-label-title" className="text-sm text-zinc-100">장기기억 별칭</h2>
              <button data-dialog-initial aria-label="장기기억 별칭 닫기" className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500" onClick={() => setEditingLabel(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-zinc-500">UUID는 바뀌지 않습니다. 이 이름은 사용자가 기억을 알아보기 위한 표시입니다.</p>
              <input data-testid="portal-memory-label-input" aria-label="사용자용 장기기억 별칭" value={editingLabel.displayName} maxLength={60}
                onChange={e => setEditingLabel(current => current ? { ...current, displayName: e.target.value } : current)}
                className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-teal-500/50" />
              <button disabled={suggestingName} onClick={() => {
                const entry = entries.find(item => item.memoryId === editingLabel.memoryId);
                if (entry) void suggestDisplayName(entry);
              }} className="flex items-center gap-1.5 text-xs text-violet-300 hover:text-violet-200">
                <Sparkles className="w-3.5 h-3.5" />{suggestingName ? 'AI 추천 중…' : 'AI 별칭 추천'}
              </button>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
              <button onClick={() => setEditingLabel(null)} className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg">취소</button>
              <button disabled={savingLabel} onClick={() => void saveMemoryLabel()} className="px-3 py-1.5 text-xs text-zinc-950 bg-teal-300 rounded-lg disabled:opacity-50">{savingLabel ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {mergeDraft && (() => {
        const entryA = entries.find(entry => entry.memoryId === mergeDraft.memoryA);
        const entryB = entries.find(entry => entry.memoryId === mergeDraft.memoryB);
        const optionLabel = (entry: MemoryDirectoryEntry) => `${entry.displayName ?? entry.projectName} · ${entry.memoryId.slice(0, 8)}`;
        return (
          <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onClick={() => setMergeDraft(null)}>
            <div ref={secondaryDialogRef} data-testid="portal-memory-merge-modal" role="dialog" aria-modal="true" aria-labelledby="memory-merge-title" tabIndex={-1} className="min-w-0 w-full max-w-2xl max-h-[90vh] overflow-auto bg-[#111113] border border-zinc-800 rounded-xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 sticky top-0 bg-[#111113]">
                <GitMerge className="w-4 h-4 text-teal-400" /><h2 id="memory-merge-title" className="text-sm text-zinc-100">장기기억 계보 합병</h2>
                <button data-dialog-initial aria-label="장기기억 합병 닫기" className="ml-auto flex min-h-11 min-w-11 items-center justify-center text-zinc-500" onClick={() => setMergeDraft(null)}><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-5">
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-zinc-400">
                  합병은 원본 리비전을 삭제하지 않습니다. A/B의 최신 내용을 새 리비전에 함께 보존하고, 이전 ID는 영구 연결 주소로 남깁니다.
                  알려진 모든 단말이 새 ID와 내용을 받은 뒤에만 전환 완료로 표시됩니다.
                </div>
                <section className="space-y-2">
                  <div className="text-xs text-zinc-300">1. 합칠 기억 두 개</div>
                  <div className="grid min-w-0 sm:grid-cols-2 gap-2">
                    <select aria-label="합칠 장기기억 A" data-testid="merge-memory-a" value={mergeDraft.memoryA} onChange={e => setMergeDraft(current => current ? { ...current, memoryA: e.target.value } : current)} className="min-w-0 w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-zinc-200">
                      {entries.map(entry => <option key={entry.memoryId} value={entry.memoryId}>{optionLabel(entry)}</option>)}
                    </select>
                    <select aria-label="합칠 장기기억 B" data-testid="merge-memory-b" value={mergeDraft.memoryB} onChange={e => setMergeDraft(current => current ? { ...current, memoryB: e.target.value } : current)} className="min-w-0 w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-zinc-200">
                      {entries.map(entry => <option key={entry.memoryId} value={entry.memoryId}>{optionLabel(entry)}</option>)}
                    </select>
                  </div>
                </section>
                <section className="space-y-2">
                  <div className="text-xs text-zinc-300">2. 존속할 기억 ID</div>
                  <div className="grid sm:grid-cols-3 gap-2">
                    {(['a', 'b', 'new'] as MemorySurvivorChoice[]).map(choice => (
                      <label key={choice} className={`border rounded-lg p-2.5 text-xs cursor-pointer ${mergeDraft.survivor === choice ? 'border-teal-500/40 bg-teal-500/10 text-teal-200' : 'border-zinc-800 text-zinc-400'}`}>
                        <input type="radio" className="sr-only" checked={mergeDraft.survivor === choice} onChange={() => setMergeDraft(current => current ? { ...current, survivor: choice } : current)} />
                        {choice === 'a' ? 'A 존속' : choice === 'b' ? 'B 존속' : '새 C 생성'}
                        <span className="block mt-1 text-[10px] text-zinc-600">{choice === 'a' ? entryA?.memoryId.slice(0, 8) : choice === 'b' ? entryB?.memoryId.slice(0, 8) : '새 UUID'}</span>
                      </label>
                    ))}
                  </div>
                </section>
                <section className="space-y-2">
                  <div className="text-xs text-zinc-300">3. GitHub 저장소 결정</div>
                  <p className="text-[10px] text-zinc-600">기억 합병과 Git 저장소 합병은 별개입니다. 여기서는 대표 저장소를 정하며, 코드 이력은 자동으로 덮어쓰지 않습니다.</p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(['a', 'b', 'new', 'memory-only'] as RepositoryMergeChoice[]).map(choice => {
                      const unavailable = choice === 'a' ? !entryA?.githubUrl : choice === 'b' ? !entryB?.githubUrl : false;
                      return <label key={choice} className={`border rounded-lg p-2 text-xs ${unavailable ? 'opacity-35' : 'cursor-pointer'} ${mergeDraft.repositoryChoice === choice ? 'border-teal-500/40 bg-teal-500/10 text-teal-200' : 'border-zinc-800 text-zinc-400'}`}>
                        <input type="radio" className="sr-only" disabled={unavailable} checked={mergeDraft.repositoryChoice === choice} onChange={() => setMergeDraft(current => current ? { ...current, repositoryChoice: choice } : current)} />
                        {choice === 'a' ? 'A 저장소 유지' : choice === 'b' ? 'B 저장소 유지' : choice === 'new' ? '새 저장소 C' : '기억만 합치기'}
                      </label>;
                    })}
                  </div>
                  {mergeDraft.repositoryChoice === 'new' && <input data-testid="merge-new-repository" value={mergeDraft.newRepositoryUrl} onChange={e => setMergeDraft(current => current ? { ...current, newRepositoryUrl: e.target.value } : current)} placeholder="https://github.com/owner/new-repository" className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200" />}
                </section>
                <section className="space-y-2">
                  <div className="text-xs text-zinc-300">4. 내용 우선순위와 사용자 별칭</div>
                  <div className="flex gap-2">
                    {(['a', 'b'] as const).map(choice => <button key={choice} onClick={() => setMergeDraft(current => current ? { ...current, primary: choice } : current)} className={`px-2.5 py-1.5 rounded-lg border text-xs ${mergeDraft.primary === choice ? 'border-teal-500/40 text-teal-200 bg-teal-500/10' : 'border-zinc-800 text-zinc-500'}`}>{choice.toUpperCase()} 내용을 먼저 배치</button>)}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input data-testid="merge-display-name" aria-label="합병 후 사용자용 장기기억 별칭" maxLength={60} value={mergeDraft.displayName} onChange={e => setMergeDraft(current => current ? { ...current, displayName: e.target.value } : current)} className="min-w-0 w-full flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200" placeholder="사용자용 장기기억 별칭" />
                    <button disabled={suggestingName || !entryA} onClick={() => entryA && void suggestDisplayName(entryA)} className="px-2.5 py-2 border border-violet-500/25 rounded-lg text-xs text-violet-300"><Sparkles className="w-3 h-3 inline mr-1" />AI 추천</button>
                  </div>
                </section>
              </div>
              <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2 sticky bottom-0 bg-[#111113]">
                <button onClick={() => setMergeDraft(null)} className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg">취소</button>
                <button data-testid="merge-confirm" disabled={merging || !entryA || !entryB || entryA.memoryId === entryB.memoryId} onClick={() => void executeMerge()} className="px-3 py-1.5 text-xs text-zinc-950 bg-teal-300 rounded-lg disabled:opacity-40">{merging ? '안전하게 합병 중…' : '검토한 내용으로 합병'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {onboardingMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOnboardingMode(null)}>
          <div data-testid="portal-memory-onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-teal-500/25 bg-[#111113] shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <Sparkles className="h-4 w-4 text-teal-300" />
              <h2 id="onboarding-title" className="text-sm font-semibold text-zinc-100">{onboardingMode === 'project-hermes' ? '프로젝트 → 로컬 Hermes profile 연동' : 'Hermes profile → Telegram Bot 연동'}</h2>
              <button type="button" aria-label="온보딩 닫기" className="ml-auto text-zinc-500 hover:text-zinc-200" onClick={() => setOnboardingMode(null)}><X className="h-4 w-4" /></button>
            </div>
            <div data-testid="onboarding-scroll-content" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-[11px] text-violet-100">
                <div>{onboardingMode === 'project-hermes' ? '프로젝트를 연결할 Hermes profile을 선택합니다. project 없이 일반 profile로도 만들 수 있습니다.' : '이미 존재하는 Hermes profile을 선택해 Telegram Bot만 연결합니다. 새 profile과 project는 이 화면에서 만들지 않습니다.'}</div>
                {onboardingMode === 'profile-telegram' && onboardingProfile && <div className="mt-3 space-y-2 rounded-md border border-teal-400/20 bg-teal-500/5 p-2.5">
                  <div className="text-[10px] font-semibold text-teal-200">진행 순서</div>
                  <ol className="list-decimal space-y-0.5 pl-4 text-[10px] text-zinc-400"><li>{telegramConnectionMode === 'automatic' ? 'Automatic(QR) 연결을 선택하고 Telegram 승인 화면에서 Bot 표시 이름을 확인합니다.' : '아래 이름과 username을 확인하거나 수정합니다.'}</li><li>Hermes Telegram 설정 열기를 누릅니다.</li><li>{telegramConnectionMode === 'automatic' ? '열린 Hermes 창에서 Telegram → Automatic(1번)을 선택합니다.' : '열린 Hermes 창에서 Telegram → Manual(2번)을 선택하고 token을 직접 입력합니다.'}</li><li>{telegramConnectionMode === 'automatic' ? '터미널 QR을 Telegram으로 스캔하고 Create Bot을 확인합니다.' : 'BotFather에서 Bot을 만든 뒤 token을 Hermes 공식 setup에 직접 입력합니다.'}</li></ol>
                  <div className="text-[10px] text-zinc-500">현재 연결 대상 단말: <span className="text-teal-200">{deviceName || '이름 미등록'}</span> · device_id: <code className={deviceId ? 'text-zinc-300' : 'text-amber-300'}>{deviceId || 'readback 필요'}</code></div>
                  {!deviceId && <div className="text-[10px] text-amber-300">authoritative device_id가 확인될 때까지 Telegram 연결 prompt 복사를 차단합니다.</div>}
                  <div className="text-[10px] font-semibold text-teal-200">연결 방식</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className={`cursor-pointer rounded-md border px-2.5 py-2 text-[10px] ${telegramConnectionMode === 'manual' ? 'border-teal-400/50 bg-teal-500/10 text-teal-100' : 'border-zinc-700 text-zinc-500'}`}>
                      <input type="radio" className="sr-only" checked={telegramConnectionMode === 'manual'} onChange={() => setTelegramConnectionMode('manual')} />
                      수동 · BotFather
                    </label>
                    <label className={`cursor-pointer rounded-md border px-2.5 py-2 text-[10px] ${telegramConnectionMode === 'automatic' ? 'border-violet-400/50 bg-violet-500/10 text-violet-100' : 'border-zinc-700 text-zinc-500'}`}>
                      <input type="radio" className="sr-only" checked={telegramConnectionMode === 'automatic'} onChange={() => setTelegramConnectionMode('automatic')} />
                      자동 · QR 승인
                    </label>
                  </div>
                  {telegramConnectionMode === 'automatic' ? <div className="rounded-md border border-violet-400/20 bg-violet-500/5 p-2 text-[10px] text-violet-100">자동 연결에서는 Bot 표시 이름과 username을 이 화면에서 입력하지 않습니다. Hermes가 pairing을 만들고 Telegram의 Create Bot 승인 화면에서 표시 이름을 확정하며 username은 자동 생성됩니다.</div> : <>
                  <div className="text-[10px] font-semibold text-teal-200">Manual 방식에서 BotFather에 입력할 이름과 username</div>
                  <div className="text-[10px] text-zinc-500">아래 값을 BotFather에 사용하고 token은 Hermes 공식 setup에 직접 입력합니다.</div>
                  <div className="grid grid-cols-[1fr_auto] gap-2"><input aria-label="Telegram Bot 표시 이름" value={telegramBotName} onChange={event => setTelegramBotName(event.target.value)} className="min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200" /><button type="button" onClick={() => void copyTextValue(telegramBotName, 'Bot 이름')} className="rounded-md border border-zinc-700 px-2 text-[10px] text-zinc-300">이름 복사</button></div>
                  <div className="grid grid-cols-[1fr_auto] gap-2"><input aria-label="Telegram Bot username" value={telegramBotUsername} onChange={event => setTelegramBotUsername(event.target.value)} className="min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-200" /><button type="button" onClick={() => void copyTextValue(telegramBotUsername, 'Bot username')} className="rounded-md border border-zinc-700 px-2 text-[10px] text-zinc-300">username 복사</button></div>
                  {!isValidTelegramBotUsername(telegramBotUsername) && <div className="text-[10px] text-amber-300">username은 영문으로 시작하고 5~32자이며 bot으로 끝나야 합니다.</div>}
                  <div className="text-[10px] text-zinc-500">BotFather에서 username 중복 여부를 최종 확인합니다.</div>
                  </>}
                  <button type="button" data-testid="open-hermes-telegram-setup" onClick={() => void openHermesTelegramSetup()} className="mt-2 rounded-md border border-teal-400/30 bg-teal-500/10 px-2.5 py-1.5 text-[10px] text-teal-200 hover:bg-teal-500/20">Hermes Telegram 설정 열기</button>
                  {telegramSetupPending && <div className="text-[10px] text-amber-300">setup 완료를 기다리는 중입니다. profile Telegram 상태를 5초마다 다시 확인합니다.</div>}
                </div>}
              </div>
              {!newProfileMode ? <>
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold text-zinc-300">1. 기존 Hermes profile 선택</span>
                  <select data-testid="onboarding-profile-select" value={onboardingProfile} onChange={event => setOnboardingProfile(event.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200">
                    <option value="">기존 profile을 선택하세요</option>
                    {onboardingProfiles.map(profile => <option key={profile.name} value={profile.name}>{hermesProfileDisplayName(profile.name)}{profile.configPresent ? '' : ' · config 없음'}</option>)}
                  </select>
                  {onboardingProfiles.length === 0 && <span className="block text-[10px] text-amber-300">로컬 Hermes profile을 조회하지 못했습니다. Hermes가 설치된 단말에서 다시 시도하세요.</span>}
                </label>
                {onboardingMode === 'project-hermes' && <button type="button" data-testid="onboarding-new-profile" onClick={() => { setNewProfileMode(true); setOnboardingProfile(''); setNewProfileName(nextAvailableHermesProfileName(onboardingProfiles.map(profile => profile.name), onboardingProject?.name)); }} className="rounded-lg border border-violet-400/40 px-3 py-2 text-xs text-violet-200 hover:bg-violet-500/10">+ 새 Hermes profile 만들기</button>}
              </> : <div className="space-y-3 rounded-lg border border-violet-400/30 bg-violet-500/5 p-3">
                <div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-violet-100">새 Hermes profile 만들기 준비</span><button type="button" onClick={() => setNewProfileMode(false)} className="text-[10px] text-zinc-400">기존 profile 선택으로 돌아가기</button></div>
                <input data-testid="new-profile-name" value={newProfileName} onChange={event => setNewProfileName(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="profile 이름 (영문·숫자·-·_)" className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200" />
                {newProfileName && !validateHermesProfileName(newProfileName) && <div className="text-[10px] text-amber-300">이름은 영문·숫자로 시작하고 64자 이내여야 합니다.</div>}
                {newProfileName && onboardingProfiles.some(profile => profile.name === newProfileName.trim()) && <div className="text-[10px] text-rose-300">이미 존재하는 profile 이름입니다. 기존 profile을 선택하세요.</div>}
                <select data-testid="new-profile-channel" value={newProfileChannel} onChange={event => setNewProfileChannel(event.target.value as 'local' | 'telegram')} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"><option value="local">로컬 Hermes Bot Chat · 권장(Telegram Bot 없음)</option><option value="telegram">Telegram Bot · 별도 연결 필요</option></select>
                {newProfileChannel === 'local' && <select data-testid="new-profile-model" value={newProfileModel} onChange={event => setNewProfileModel(event.target.value as HermesProfileModel)} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"><option value="sol">Hermes Codex SOL · gpt-5.6-sol (권장)</option><option value="profile-default">Hermes 기본 모델 · gpt-5.6-luna (SOL 아님)</option></select>}
                <div className="text-[10px] text-zinc-400">자동으로 profile 디렉터리·gateway·Telegram token을 만들거나 저장하지 않습니다. 확인 후 생성 절차를 진행할 수 있는 안전한 handoff 안내만 준비합니다.</div>
              </div>}
              {onboardingMode === 'project-hermes' && <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-zinc-300">2. 프로젝트 매칭 (선택)</span>
                <select data-testid="onboarding-project-select" value={onboardingProjectId} onChange={event => { const projectId = event.target.value; setOnboardingProjectId(projectId); const entry = allEntries.find(candidate => candidate.memoryId === projectId); if (entry) void findLocalProject(entry); }} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200">
                  <option value="">프로젝트 없이 계속</option>
                  {onboardingProjectOptions.map(project => <option key={project.id} value={project.id}>{project.name} · {project.id.slice(0, 8)}</option>)}
                </select>
              </label>}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[11px] text-zinc-400">
                <div className="font-semibold text-zinc-200">선택 내용 확인</div>
                <div className="mt-1">프로젝트: <span className="text-teal-200">{onboardingProject?.name ?? '선택 안 됨'}</span></div>
                <div>memory_id: <code className="text-zinc-300">{onboardingProject?.id ?? '—'}</code></div>
                <div className="mt-1">canonical path: <code className={onboardingPath ? 'text-zinc-300' : 'text-amber-300'}>{onboardingPath ?? '확인 필요 — 로컬 프로젝트 path readback 대기'}</code></div>
                <div>Hermes profile: <span className="text-violet-200">{newProfileMode ? (newProfileName || '새 profile 이름 입력 필요') : (onboardingProfile || '선택 안 됨')}</span></div>
              </div>
              {onboardingCopyBlockReason && <div className="mt-2 text-[10px] text-amber-300">복사 대기 이유: {onboardingCopyBlockReason}</div>}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button type="button" onClick={() => setOnboardingMode(null)} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400">취소</button>
              <button type="button" data-testid="onboarding-copy-handoff" disabled={onboardingCopyBlocked} title={onboardingCopyBlockReason || undefined} onClick={() => { const prompt = newProfileMode ? newProfilePrompt : (onboardingMode === 'project-hermes' ? onboardingHermesPrompt : onboardingTelegramPrompt); void copyOnboardingPrompt(newProfileMode ? 'hermes' : (onboardingMode === 'project-hermes' ? 'hermes' : 'telegram'), prompt, newProfileMode ? '새 Hermes profile 생성 준비 안내' : (onboardingMode === 'project-hermes' ? '프로젝트 Hermes profile handoff' : 'Hermes profile Telegram handoff')); }} className="rounded-lg bg-teal-300 px-3 py-2 text-xs font-medium text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40">{newProfileMode ? '생성 준비 안내 복사' : '선택 내용 확인 후 복사'}</button>
            </div>
          </div>
        </div>
      )}
      {buzzAgentSetupScope && (
        <BuzzAgentSetupDialog
          deviceName={deviceName}
          scope={buzzAgentSetupScope}
          projects={onboardingProjects}
          onClose={() => setBuzzAgentSetupScope(null)}
          onToast={showToast}
        />
      )}
    </div>
  );
}
