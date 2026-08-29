import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Check, Cloud, Copy, FolderGit2, FolderPlus, Pencil, RefreshCw, Server, Terminal, Trash2, X } from 'lucide-react';
import { getSupabaseClient } from './lib/supabaseClient';
import type { MemoryDirectoryEntry } from './projectMemoryDirectory';
import {
  buildRemoteDeviceEnrollmentCommand,
  buildRemoteDeviceUpgradeCommand,
  buildRemoteHostProjectCommand,
  inferGitHubRepositoryName,
  createRemoteEnrollmentToken,
  DEFAULT_REMOTE_DEVICE_SCRIPT_URL,
  REMOTE_DEVICE_AGENT_VERSION,
  normalizeRemoteDeviceName,
  normalizeRemoteProjectPath,
  type RemoteEnvironmentKind,
  type RemoteProjectActionKind,
} from './remoteDeviceEnrollment';

interface RemoteDeviceRow {
  device_id: string;
  display_name: string;
  hostname: string | null;
  platform: string;
  environment_kind: RemoteEnvironmentKind;
  agent_version: string | null;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  default_workspace_root: string | null;
  inventory_updated_at: string | null;
  project_count: number;
  provisioning_expires_at: string | null;
}

interface RemoteProjectRow {
  device_id: string;
  project_path: string;
  project_name: string;
  memory_id: string | null;
  git_remote_url: string | null;
  git_head_sha: string | null;
  git_branch: string | null;
  git_dirty: boolean | null;
  registered: boolean;
  present: boolean;
  last_observed_at: string;
  telegram_chat_id: string | null;
  telegram_thread_id: string | null;
}

interface MemoryOption {
  memoryId: string;
  name: string;
  githubUrl: string | null;
  historicalAws: boolean;
  historicalAwsName?: string;
  historicalAwsPath?: string;
}

type Toast = (message: string, type: 'success' | 'error') => void;

function oneRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === 'object' ? value as T : null;
}

function formatSeen(value: string | null): string {
  if (!value) return '아직 상태 보고 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '확인 시각 알 수 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function environmentLabel(value: RemoteEnvironmentKind): string {
  return ({ aws: 'AWS Ubuntu', linux: 'Linux 서버', cloud: '클라우드', container: '컨테이너', wsl: 'Windows WSL' })[value];
}

export interface RemoteRuntimeReadiness {
  agentVersion: string | null;
  reported: boolean;
  bunReady: boolean | null;
  apiReady: boolean | null;
  hermesReady: boolean | null;
}

/**
 * New agents append a tiny, secret-free readiness report to the existing
 * agent_version field (for example `4|b1a0h0`). Old servers need no migration,
 * and an old plain version remains explicitly unknown rather than "missing".
 */
export function parseRemoteRuntimeReadiness(value: string | null): RemoteRuntimeReadiness {
  const input = value?.trim() ?? '';
  if (!input) return { agentVersion: null, reported: false, bunReady: null, apiReady: null, hermesReady: null };
  const match = input.match(/^([^|]{1,24})\|b([01])a([01])h([01])$/);
  if (!match) return { agentVersion: input.split('|', 1)[0] || null, reported: false, bunReady: null, apiReady: null, hermesReady: null };
  return {
    agentVersion: match[1] ?? null,
    reported: true,
    bunReady: match[2] === '1',
    apiReady: match[3] === '1',
    hermesReady: match[4] === '1',
  };
}

export function buildAwsRuntimePreparationPrompt(device: Pick<RemoteDeviceRow, 'display_name' | 'hostname' | 'environment_kind' | 'default_workspace_root' | 'agent_version'>): string {
  const readiness = parseRemoteRuntimeReadiness(device.agent_version);
  const state = (value: boolean | null) => value === true ? '준비됨' : value === false ? '준비 필요' : '아직 확인되지 않음';
  return [
    '당신은 코딩을 모르는 사용자의 AgentsToZ AWS/Linux 런타임 준비 도우미입니다.',
    '',
    `대상 환경: ${environmentLabel(device.environment_kind)}`,
    `현재 보고: Bun ${state(readiness.bunReady)} / AgentsToZ API ${state(readiness.apiReady)} / Hermes ${readiness.hermesReady === true ? 'CLI 설치됨' : readiness.hermesReady === false ? '미설치' : '아직 확인되지 않음'}(선택, profile·gateway 연결은 별도)`,
    '',
    '목표는 이미 등록된 이 호스트에서 AgentsToZ API의 /api/health가 정상 응답하게 만드는 것입니다. 기존 GitHub·Supabase·Vercel 자원을 그대로 사용하고 새 프로젝트나 새 계정을 만들지 마세요.',
    '',
    '안전 규칙:',
    '1. 한 번에 한 단계만 설명하고, 먼저 읽기 전용 진단 결과를 쉬운 말로 알려주세요.',
    '2. 패키지 설치, Git clone/pull, 서비스 생성·재시작, 방화벽 변경 전에는 무엇이 바뀌는지 설명하고 제 확인을 받으세요.',
    '3. ~/.config/agentstoz/remote-device.json, 토큰, anon key, credential, service_role, 환경변수의 값을 읽거나 채팅에 출력하지 마세요. 등록을 다시 만들거나 단말 ID를 복사하지 마세요.',
    '4. Hermes와 Telegram은 선택 기능입니다. AgentsToZ API 준비와 분리해서 마지막에 제가 원할 때만 설치하세요.',
    '',
    '먼저 다음 항목만 확인하세요: uname/배포판, git·curl·python3·bun 실행 가능 여부, 기존 AgentsToZ_byCS 체크아웃과 package.json 위치, 127.0.0.1:3001/api/health 응답, 관련 user systemd 서비스 상태. 비밀 파일 내용은 열지 마세요.',
    'Bun이나 저장소가 없으면 공식 설치 방법과 기존 저장소를 재사용하는 방법을 제시하되 승인 전에는 실행하지 마세요. 저장소가 있으면 그 저장소의 README/AGENTS.md에 적힌 정식 Bun 실행 명령과 서비스 구성을 우선하세요.',
    '',
    'API가 정상화되면 ~/.local/bin/agentstoz-status 를 실행하고, Bun/API/Hermes 상태와 다음 단계인 “프로젝트 연결 가능” 여부만 요약해 주세요.',
  ].join('\n');
}

export function describeRemoteDeviceError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String((reason as any)?.message ?? reason ?? '');
  if (/PORTMGR_MEMBER_REQUIRED/i.test(message)) {
    return '현재 Google 계정이 DB 허용 회원에 등록되지 않았습니다. 로컬 앱의 설정 마법사에서 포털 회원 연결을 다시 확인하세요.';
  }
  return message || '클라우드 단말 정보를 불러오지 못했습니다.';
}

export default function RemoteDeviceManager({
  supabaseUrl,
  supabaseKey,
  entries,
  showToast,
  compact = false,
  initialMemoryId = null,
  onActiveDeviceCount,
}: {
  supabaseUrl: string;
  supabaseKey: string;
  entries?: readonly MemoryDirectoryEntry[];
  showToast: Toast;
  compact?: boolean;
  initialMemoryId?: string | null;
  onActiveDeviceCount?: (count: number) => void;
}) {
  const [devices, setDevices] = useState<RemoteDeviceRow[]>([]);
  const [projects, setProjects] = useState<RemoteProjectRow[]>([]);
  const [memoryOptions, setMemoryOptions] = useState<MemoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [deviceName, setDeviceName] = useState('Hermes AWS');
  const [environmentKind, setEnvironmentKind] = useState<RemoteEnvironmentKind>('aws');
  const [workspaceRoot, setWorkspaceRoot] = useState('/home/ubuntu/projects');
  const [memoryId, setMemoryId] = useState('');
  const [enrollmentTtl, setEnrollmentTtl] = useState(86400);
  const [forceNewDevice, setForceNewDevice] = useState(false);
  const [reconnectFromDeviceId, setReconnectFromDeviceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [commandInfo, setCommandInfo] = useState<{
    enrollmentId: string;
    command: string;
    expiresAt: string;
    claimedDeviceId?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<RemoteDeviceRow | null>(null);
  const [editName, setEditName] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [projectDevice, setProjectDevice] = useState<RemoteDeviceRow | null>(null);
  const [projectAction, setProjectAction] = useState<RemoteProjectActionKind>('new');
  const [projectName, setProjectName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [projectCommand, setProjectCommand] = useState('');
  const [projectCopied, setProjectCopied] = useState(false);
  const [upgradeCopiedId, setUpgradeCopiedId] = useState<string | null>(null);
  const [runtimeHelpDevice, setRuntimeHelpDevice] = useState<RemoteDeviceRow | null>(null);
  const [runtimePromptCopiedId, setRuntimePromptCopiedId] = useState<string | null>(null);
  const enrollmentPollInFlightRef = useRef(false);
  const enrollmentPollAbortRef = useRef<AbortController | null>(null);

  const sb = useCallback(() => getSupabaseClient(supabaseUrl, supabaseKey), [supabaseUrl, supabaseKey]);

  const entryOptions = useMemo<MemoryOption[]>(() => (entries ?? []).map(entry => ({
    memoryId: entry.memoryId,
    name: entry.displayName || entry.projectName || entry.memoryId.slice(0, 8),
    githubUrl: entry.githubUrl,
    historicalAws: entry.devices.some(device =>
      /aws/i.test(device.deviceName)
      || device.historicalNames.some(name => /aws/i.test(name))
      || /^\/home\/ubuntu\//.test(device.sourcePath ?? '')),
    historicalAwsName: entry.devices.flatMap(device => [device.deviceName, ...device.historicalNames]).find(name => /aws/i.test(name)),
    historicalAwsPath: entry.devices.map(device => device.sourcePath).find(path => /^\/home\/ubuntu\//.test(path ?? '')) ?? undefined,
  })), [entries]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const cleanupResult = await sb().rpc('portmgr_cleanup_remote_device_provisioning');
      if (cleanupResult.error) throw cleanupResult.error;
      const remoteResult = await sb().from('portmgr_remote_devices')
        .select('device_id,display_name,hostname,platform,environment_kind,agent_version,registered_at,last_seen_at,revoked_at,default_workspace_root,inventory_updated_at,project_count,provisioning_expires_at')
        .order('registered_at', { ascending: false });
      if (remoteResult.error) throw remoteResult.error;
      const remoteRows = (remoteResult.data ?? []) as RemoteDeviceRow[];
      setDevices(remoteRows);
      setRuntimeHelpDevice(current => current
        ? remoteRows.find(row => row.device_id === current.device_id) ?? current
        : null);
      const projectResult = await sb().from('portmgr_remote_device_projects')
        .select('device_id,project_path,project_name,memory_id,git_remote_url,git_head_sha,git_branch,git_dirty,registered,present,last_observed_at,telegram_chat_id,telegram_thread_id')
        .order('last_observed_at', { ascending: false });
      if (projectResult.error) throw projectResult.error;
      setProjects((projectResult.data ?? []) as RemoteProjectRow[]);

      if (entryOptions.length) {
        setMemoryOptions(entryOptions);
      } else {
        const memoryResult = await sb().from('portmgr_project_memory_revisions')
          .select('memory_id,project_name,github_url,device_name,source_path,created_at')
          .order('created_at', { ascending: false })
          .limit(1000);
        if (memoryResult.error) throw memoryResult.error;
        const byId = new Map<string, MemoryOption>();
        for (const row of memoryResult.data ?? []) {
          const id = String(row.memory_id ?? '').trim();
          if (!id) continue;
          const deviceName = String(row.device_name ?? '').trim();
          const sourcePath = String(row.source_path ?? '').trim();
          const awsObservation = /aws/i.test(deviceName) || /^\/home\/ubuntu\//.test(sourcePath);
          const existing = byId.get(id);
          if (existing) {
            if (awsObservation) {
              existing.historicalAws = true;
              if (/aws/i.test(deviceName)) existing.historicalAwsName ||= deviceName;
              if (/^\/home\/ubuntu\//.test(sourcePath)) existing.historicalAwsPath ||= sourcePath;
            }
            continue;
          }
          byId.set(id, {
            memoryId: id,
            name: String(row.project_name ?? '').trim() || id.slice(0, 8),
            githubUrl: row.github_url ? String(row.github_url) : null,
            historicalAws: awsObservation,
            historicalAwsName: /aws/i.test(deviceName) ? deviceName : undefined,
            historicalAwsPath: /^\/home\/ubuntu\//.test(sourcePath) ? sourcePath : undefined,
          });
        }
        setMemoryOptions([...byId.values()]);
      }
    } catch (reason: any) {
      setError(describeRemoteDeviceError(reason));
    } finally {
      setLoading(false);
    }
  }, [entryOptions, sb]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const preferred = initialMemoryId && memoryOptions.find(option => option.memoryId === initialMemoryId);
    const first = preferred ?? memoryOptions[0];
    if (preferred) {
      setMemoryId(preferred.memoryId);
      const activeHost = devices.find(device => !device.revoked_at);
      if (activeHost) {
        if (parseRemoteRuntimeReadiness(activeHost.agent_version).apiReady === true) {
          setRuntimeHelpDevice(null);
          setProjectDevice(activeHost);
          setProjectAction('memory');
          setProjectCommand('');
        } else {
          setProjectDevice(null);
          setRuntimeHelpDevice(activeHost);
        }
      } else if (preferred.historicalAws) {
        setDeviceName(preferred.historicalAwsName || 'Hermes AWS');
        setEnvironmentKind('aws');
        setWorkspaceRoot('/home/ubuntu/projects');
        setEnrollmentTtl(86400);
        setForceNewDevice(true);
      }
    }
    else if (first) setMemoryId(current => current || first.memoryId);
    if (preferred && !devices.some(device => !device.revoked_at)) setShowRegister(true);
  }, [devices, initialMemoryId, memoryOptions]);

  const historicalAwsMemory = useMemo(
    () => memoryOptions.find(option => option.historicalAws),
    [memoryOptions],
  );

  function prepareHistoricalAwsReconnect(option: MemoryOption) {
    setMemoryId(option.memoryId);
    setDeviceName(option.historicalAwsName || 'Hermes AWS');
    setEnvironmentKind('aws');
    setWorkspaceRoot('/home/ubuntu/projects');
    setEnrollmentTtl(86400);
    setForceNewDevice(true);
    setReconnectFromDeviceId(null);
    setCommandInfo(null);
    setShowRegister(true);
  }

  function prepareRevokedDeviceReconnect(device: RemoteDeviceRow) {
    setDeviceName(device.display_name);
    setEnvironmentKind(device.environment_kind);
    setWorkspaceRoot(device.default_workspace_root || '/home/ubuntu/projects');
    setEnrollmentTtl(86400);
    setForceNewDevice(true);
    setReconnectFromDeviceId(device.device_id);
    setCommandInfo(null);
    setPendingRevokeId(null);
    setShowRegister(true);
  }

  const checkEnrollment = useCallback(async () => {
    if (!commandInfo || commandInfo.claimedDeviceId || enrollmentPollInFlightRef.current) return;
    enrollmentPollInFlightRef.current = true;
    const controller = new AbortController();
    enrollmentPollAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const result = await sb().rpc('portmgr_remote_device_enrollment_status', {
        p_enrollment_id: commandInfo.enrollmentId,
      }).abortSignal(controller.signal);
      if (result.error) throw result.error;
      const status = oneRow<{ claimed: boolean; device_id: string | null }>(result.data);
      if (status?.claimed && status.device_id) {
        setCommandInfo(current => current ? { ...current, claimedDeviceId: status.device_id! } : current);
        showToast('클라우드 단말 등록과 첫 상태 확인이 완료되었습니다', 'success');
        await load();
      }
    } catch (reason: any) {
      if (reason?.name !== 'AbortError' && !/abort/i.test(String(reason?.message ?? ''))) {
        setError(reason?.message ?? String(reason));
      }
    } finally {
      window.clearTimeout(timeout);
      if (enrollmentPollAbortRef.current === controller) {
        enrollmentPollAbortRef.current = null;
        enrollmentPollInFlightRef.current = false;
      }
    }
  }, [commandInfo, load, sb, showToast]);

  useEffect(() => {
    if (!commandInfo || commandInfo.claimedDeviceId) return;
    const timer = window.setInterval(() => void checkEnrollment(), 3000);
    return () => {
      window.clearInterval(timer);
      enrollmentPollAbortRef.current?.abort();
      enrollmentPollAbortRef.current = null;
      enrollmentPollInFlightRef.current = false;
    };
  }, [checkEnrollment, commandInfo]);

  async function createEnrollment() {
    const name = normalizeRemoteDeviceName(deviceName);
    if (!name || !workspaceRoot.trim()) return;
    setCreating(true);
    setError('');
    try {
      // Validate local fields before creating a one-time server enrollment so a
      // path typo cannot leave an unused transient row behind.
      const normalizedWorkspaceRoot = normalizeRemoteProjectPath(workspaceRoot);
      const token = createRemoteEnrollmentToken();
      const rpcName = reconnectFromDeviceId
        ? 'portmgr_create_remote_host_reconnect_enrollment'
        : 'portmgr_create_remote_host_enrollment';
      const result = await sb().rpc(rpcName, {
        p_token: token,
        p_requested_name: name,
        p_environment_kind: environmentKind,
        p_ttl_seconds: enrollmentTtl,
        ...(reconnectFromDeviceId ? { p_previous_device_id: reconnectFromDeviceId } : {}),
      });
      if (result.error) throw result.error;
      const created = oneRow<{ enrollment_id: string; expires_at: string }>(result.data);
      if (!created?.enrollment_id) throw new Error('등록 세션을 만들지 못했습니다.');
      const ownScriptUrl = typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? new URL('/agentstoz-remote-device.sh', window.location.origin).toString()
        : DEFAULT_REMOTE_DEVICE_SCRIPT_URL;
      const command = buildRemoteDeviceEnrollmentCommand({
        scriptUrl: ownScriptUrl,
        token,
        supabaseUrl,
        supabaseAnonKey: supabaseKey,
        deviceName: name,
        environmentKind,
        workspaceRoot: normalizedWorkspaceRoot,
        forceNewDevice,
      });
      setCommandInfo({ enrollmentId: created.enrollment_id, expiresAt: created.expires_at, command });
      setShowRegister(true);
    } catch (reason: any) {
      setError(reason?.message ?? String(reason));
      showToast(`등록 명령 생성 실패: ${reason?.message ?? String(reason)}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  async function copyCommand() {
    if (!commandInfo) return;
    try {
      await navigator.clipboard.writeText(commandInfo.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      showToast('AWS/Linux 터미널용 등록 명령을 복사했습니다', 'success');
    } catch {
      showToast('명령을 클립보드에 복사하지 못했습니다', 'error');
    }
  }

  function openProjectSetup(device: RemoteDeviceRow, action: RemoteProjectActionKind = 'new') {
    if (parseRemoteRuntimeReadiness(device.agent_version).apiReady !== true) {
      setRuntimeHelpDevice(device);
      setProjectDevice(null);
      setProjectCommand('');
      return;
    }
    setRuntimeHelpDevice(null);
    setProjectDevice(device);
    setProjectAction(action);
    setProjectName('');
    setRepositoryUrl('');
    setMemoryId(initialMemoryId || memoryOptions[0]?.memoryId || '');
    setProjectCommand('');
    setProjectCopied(false);
  }

  function createProjectCommand() {
    if (!projectDevice) return;
    if (parseRemoteRuntimeReadiness(projectDevice.agent_version).apiReady !== true) {
      setProjectDevice(null);
      setProjectCommand('');
      setRuntimeHelpDevice(projectDevice);
      return;
    }
    try {
      const command = buildRemoteHostProjectCommand({
        action: projectAction,
        projectName,
        workspaceRoot: projectDevice.default_workspace_root || '/home/ubuntu/projects',
        repositoryUrl,
        memoryId,
      });
      setProjectCommand(command);
    } catch (reason: any) {
      showToast(reason?.message ?? String(reason), 'error');
    }
  }

  async function copyProjectCommand() {
    if (!projectCommand) return;
    try {
      await navigator.clipboard.writeText(projectCommand);
      setProjectCopied(true);
      window.setTimeout(() => setProjectCopied(false), 2000);
      showToast('AWS 프로젝트 생성 명령을 복사했습니다', 'success');
    } catch {
      showToast('명령을 클립보드에 복사하지 못했습니다', 'error');
    }
  }

  async function copyUpgradeCommand(device: RemoteDeviceRow) {
    try {
      const scriptUrl = typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? new URL('/agentstoz-remote-device.sh', window.location.origin).toString()
        : DEFAULT_REMOTE_DEVICE_SCRIPT_URL;
      await navigator.clipboard.writeText(buildRemoteDeviceUpgradeCommand(scriptUrl));
      setUpgradeCopiedId(device.device_id);
      window.setTimeout(() => setUpgradeCopiedId(current => current === device.device_id ? null : current), 2000);
      showToast(`${device.display_name}에서 실행할 안전 업데이트 명령을 복사했습니다`, 'success');
    } catch {
      showToast('업데이트 명령을 클립보드에 복사하지 못했습니다', 'error');
    }
  }

  async function copyRuntimePreparationPrompt(device: RemoteDeviceRow) {
    try {
      await navigator.clipboard.writeText(buildAwsRuntimePreparationPrompt(device));
      setRuntimePromptCopiedId(device.device_id);
      window.setTimeout(() => setRuntimePromptCopiedId(current => current === device.device_id ? null : current), 2000);
      showToast(`${device.display_name} 런타임 준비용 AI 프롬프트를 복사했습니다`, 'success');
    } catch {
      showToast('AI 프롬프트를 클립보드에 복사하지 못했습니다', 'error');
    }
  }

  async function saveName() {
    if (!editing || !normalizeRemoteDeviceName(editName)) return;
    setSavingId(editing.device_id);
    try {
      const result = await sb().rpc('portmgr_update_remote_device', {
        p_device_id: editing.device_id,
        p_display_name: normalizeRemoteDeviceName(editName),
        p_revoked: null,
      });
      if (result.error) throw result.error;
      setEditing(null);
      showToast('클라우드 단말 이름을 수정했습니다', 'success');
      await load();
    } catch (reason: any) {
      showToast(`수정 실패: ${reason?.message ?? String(reason)}`, 'error');
    } finally {
      setSavingId(null);
    }
  }

  async function revoke(device: RemoteDeviceRow) {
    setSavingId(device.device_id);
    try {
      const result = await sb().rpc('portmgr_update_remote_device', {
        p_device_id: device.device_id,
        p_display_name: null,
        p_revoked: true,
      });
      if (result.error) throw result.error;
      setPendingRevokeId(null);
      showToast('클라우드 단말 등록을 해제했습니다. 이력은 보존됩니다.', 'success');
      await load();
    } catch (reason: any) {
      showToast(`등록 해제 실패: ${reason?.message ?? String(reason)}`, 'error');
    } finally {
      setSavingId(null);
    }
  }

  const activeDevices = devices.filter(device => !device.revoked_at);
  const revokedDevices = devices.filter(device => !!device.revoked_at);
  useEffect(() => { onActiveDeviceCount?.(activeDevices.length); }, [activeDevices.length, onActiveDeviceCount]);
  const fieldClass = 'min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-emerald-500';

  return (
    <section className={compact ? 'border-t border-zinc-800' : ''} data-testid="remote-device-manager">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200"><Cloud className="h-3.5 w-3.5 text-emerald-400" />클라우드·서버</p>
          <p className="mt-0.5 text-[10px] text-zinc-400">AWS/Linux처럼 화면이 없는 단말을 복붙 명령으로 등록합니다.</p>
        </div>
        <button onClick={() => { setShowRegister(value => !value); setCommandInfo(null); }}
          className="min-h-11 shrink-0 rounded-md border border-emerald-700/70 px-2.5 py-1.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">
          {showRegister ? '닫기' : '+ 클라우드 등록'}
        </button>
      </div>

      <div data-testid="remote-onboarding-steps" className="mx-4 mb-3 grid gap-2 sm:grid-cols-3">
        {[
          ['1', '호스트 등록', '1회용 명령을 서버에 복붙'],
          ['2', '런타임 준비', 'Bun·API 확인, Hermes는 선택'],
          ['3', '프로젝트 연결', '새 폴더·GitHub·기억 선택'],
        ].map(([step, title, description]) => <div key={step} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
          <p className="text-[11px] font-medium text-zinc-200"><span className="mr-1.5 text-emerald-400">{step}</span>{title}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">{description}</p>
        </div>)}
      </div>

      {historicalAwsMemory && activeDevices.length === 0 && !showRegister && (
        <div data-testid="remote-device-historical-aws" className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] text-amber-200">과거 {historicalAwsMemory.historicalAwsName || 'AWS'} 작업 흔적을 찾았습니다.</p>
            <p className="mt-0.5 truncate text-[10px] text-zinc-400">{historicalAwsMemory.name} · {historicalAwsMemory.historicalAwsPath || '/home/ubuntu/AgentsToZ_byCS'}</p>
          </div>
          <button onClick={() => prepareHistoricalAwsReconnect(historicalAwsMemory)} className="shrink-0 rounded-md border border-amber-500/30 px-2.5 py-1.5 text-[10px] text-amber-200 hover:bg-amber-500/10">강제 재연결 준비</button>
        </div>
      )}

      {showRegister && (
        <div className="mx-4 mb-4 space-y-3 rounded-xl border border-emerald-900/60 bg-emerald-950/10 p-3">
          {!commandInfo ? <>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-zinc-400">단말 이름
                <input className={`${fieldClass} mt-1`} value={deviceName} onChange={event => setDeviceName(event.target.value)} placeholder="예: Hermes AWS" />
              </label>
              <label className="text-[11px] text-zinc-400">환경
                <select className={`${fieldClass} mt-1`} value={environmentKind} onChange={event => setEnvironmentKind(event.target.value as RemoteEnvironmentKind)}>
                  {(['aws','linux','cloud','container','wsl'] as const).map(value => <option key={value} value={value}>{environmentLabel(value)}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-[11px] text-zinc-400">기본 프로젝트 작업 루트
              <input className={`${fieldClass} mt-1 font-mono`} value={workspaceRoot} onChange={event => setWorkspaceRoot(event.target.value)} />
              <span className="mt-1 block text-[10px] text-zinc-400">단말을 먼저 등록합니다. 장기기억과 Git 저장소는 등록 후 이 단말 아래 프로젝트로 추가합니다.</span>
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-zinc-400">등록 명령 유효시간
                <select className={`${fieldClass} mt-1`} value={enrollmentTtl} onChange={event => setEnrollmentTtl(Number(event.target.value))}>
                  <option value={600}>10분</option>
                  <option value={3600}>1시간</option>
                  <option value={86400}>24시간</option>
                </select>
              </label>
              <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-zinc-400 sm:mt-0">
                <input type="checkbox" checked={forceNewDevice} onChange={event => setForceNewDevice(event.target.checked)} className="mt-0.5 accent-amber-400" />
                <span><strong className="font-medium text-amber-200">새 단말 ID로 강제 재연결</strong><br />ID 충돌·손상된 기존 연결을 교체하고 이력과 접근권한은 보존합니다.</span>
              </label>
            </div>
            <button onClick={createEnrollment} disabled={creating || !deviceName.trim() || !workspaceRoot.trim()}
              className="min-h-11 w-full rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40">
              {creating ? '명령 생성 중…' : forceNewDevice ? '강제 재연결 명령 만들기' : '등록 명령 만들기'}
            </button>
            <p className="text-[10px] leading-relaxed text-zinc-400">선택 시간은 복사할 1회용 명령의 만료 시간입니다. 등록된 단말 연결은 사용자가 「등록 해제」할 때까지 계속 유지됩니다.</p>
          </> : <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300"><Terminal className="h-3.5 w-3.5" />서버 터미널에 한 번 복붙하세요</p>
                <p className="mt-1 text-[10px] text-zinc-400">명령은 {formatSeen(commandInfo.expiresAt)}까지 한 번만 쓸 수 있습니다. 등록 후 연결은 해제 전까지 유지되며 서비스 관리자 키는 포함되지 않습니다.</p>
              </div>
              {commandInfo.claimedDeviceId && <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-300"><Check className="h-3 w-3" />등록 완료</span>}
            </div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-black p-3 text-[10px] leading-relaxed text-zinc-300">{commandInfo.command}</pre>
            <div className="flex flex-wrap gap-2">
              <button onClick={copyCommand} className="flex items-center gap-1.5 rounded-md border border-emerald-700 px-3 py-2 text-[11px] text-emerald-300 hover:bg-emerald-500/10">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? '복사됨' : '명령 복사'}
              </button>
              {!commandInfo.claimedDeviceId && <button onClick={() => void checkEnrollment()} className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-[11px] text-zinc-300 hover:bg-zinc-800"><RefreshCw className="h-3.5 w-3.5" />등록 확인</button>}
              <button onClick={() => setCommandInfo(null)} className="rounded-md border border-zinc-700 px-3 py-2 text-[11px] text-zinc-400 hover:bg-zinc-800">새 명령 만들기</button>
            </div>
            <p className="text-[10px] leading-relaxed text-zinc-400">등록 후 서버에는 <code className="text-zinc-300">~/.local/bin/agentstoz-status</code>가 설치됩니다. 작업 뒤 실행하면 장기기억·Git 상태가 즉시 갱신됩니다.</p>
          </>}
        </div>
      )}

      {projectDevice && (
        <div data-testid="remote-project-setup" className="mx-4 mb-4 space-y-3 rounded-xl border border-sky-900/60 bg-sky-950/10 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-sky-200">{projectDevice.display_name}에 프로젝트 추가</p>
              <p className="mt-0.5 text-[10px] text-zinc-400">단말 등록 다음 단계입니다. 명령을 해당 AWS/Linux 터미널에서 실행하세요.</p>
            </div>
            <button aria-label="프로젝트 추가 닫기" onClick={() => setProjectDevice(null)} className="flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
          </div>
          {!projectCommand ? <>
            <div className="grid grid-cols-3 gap-2">
              {([
                ['new', '새 프로젝트', FolderPlus],
                ['clone', 'GitHub 복제', FolderGit2],
                ['memory', '기억으로 복원', Brain],
              ] as const).map(([value, label, Icon]) => (
                <button key={value} onClick={() => setProjectAction(value)} className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10px] ${projectAction === value ? 'border-sky-500/60 bg-sky-500/10 text-sky-200' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'}`}>
                  <Icon className="h-4 w-4" />{label}
                </button>
              ))}
            </div>
            <label className="block text-[11px] text-zinc-400">프로젝트 이름
              <input className={`${fieldClass} mt-1`} value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="예: customer-dashboard" />
            </label>
            {projectAction === 'clone' && <label className="block text-[11px] text-zinc-400">Git 저장소 URL
              <input className={`${fieldClass} mt-1 font-mono`} value={repositoryUrl} onChange={event => {
                const value = event.target.value;
                const previousInferred = inferGitHubRepositoryName(repositoryUrl);
                setRepositoryUrl(value);
                if (!projectName.trim() || projectName === previousInferred) {
                  const inferred = inferGitHubRepositoryName(value);
                  if (inferred) setProjectName(inferred);
                }
              }} placeholder="https://github.com/owner/repository.git" />
            </label>}
            {projectAction === 'memory' && <label className="block text-[11px] text-zinc-400">복원할 장기기억
              <select className={`${fieldClass} mt-1`} value={memoryId} onChange={event => setMemoryId(event.target.value)}>
                {memoryOptions.length === 0 && <option value="">등록 가능한 장기기억 없음</option>}
                {memoryOptions.map(option => <option key={option.memoryId} value={option.memoryId}>{option.name} · {option.memoryId.slice(0, 8)}</option>)}
              </select>
            </label>}
            <p className="text-[10px] text-zinc-400">생성 위치: <code>{projectDevice.default_workspace_root || '/home/ubuntu/projects'}</code></p>
            <button onClick={createProjectCommand} disabled={!projectName.trim() || (projectAction === 'clone' && !repositoryUrl.trim()) || (projectAction === 'memory' && !memoryId)} className="min-h-11 w-full rounded-lg bg-sky-400 px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40">프로젝트 명령 만들기</button>
          </> : <>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-black p-3 text-[10px] leading-relaxed text-zinc-300">{projectCommand}</pre>
            <div className="flex gap-2">
              <button onClick={() => void copyProjectCommand()} className="flex items-center gap-1.5 rounded-md border border-sky-700 px-3 py-2 text-[11px] text-sky-300">{projectCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{projectCopied ? '복사됨' : '명령 복사'}</button>
              <button onClick={() => setProjectCommand('')} className="rounded-md border border-zinc-700 px-3 py-2 text-[11px] text-zinc-400">다시 선택</button>
            </div>
          </>}
        </div>
      )}

      {runtimeHelpDevice && (() => {
        const readiness = parseRemoteRuntimeReadiness(runtimeHelpDevice.agent_version);
        return <div data-testid="remote-runtime-preparation" className="mx-4 mb-4 space-y-3 rounded-xl border border-amber-800/60 bg-amber-950/10 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-200">2단계 · {runtimeHelpDevice.display_name} 런타임 준비</p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">프로젝트 파일은 아직 만들지 않습니다. 아래 상태를 준비한 뒤 <code>agentstoz-status</code>를 실행하면 3단계가 열립니다.</p>
            </div>
            <button aria-label="런타임 준비 닫기" onClick={() => setRuntimeHelpDevice(null)} className="flex min-h-11 min-w-11 items-center justify-center text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
            <span className={`rounded-md border px-2 py-2 ${readiness.bunReady === true ? 'border-emerald-800 text-emerald-300' : 'border-amber-800 text-amber-200'}`}>Bun<br />{readiness.bunReady === true ? '준비됨' : readiness.bunReady === false ? '준비 필요' : '확인 필요'}</span>
            <span className={`rounded-md border px-2 py-2 ${readiness.apiReady === true ? 'border-emerald-800 text-emerald-300' : 'border-amber-800 text-amber-200'}`}>AgentsToZ API<br />{readiness.apiReady === true ? '실행 중' : readiness.apiReady === false ? '준비 필요' : '확인 필요'}</span>
            <span className={`rounded-md border px-2 py-2 ${readiness.hermesReady === true ? 'border-emerald-800 text-emerald-300' : 'border-zinc-700 text-zinc-400'}`}>Hermes CLI · 선택<br />{readiness.hermesReady === true ? '설치됨 · 연결 별도' : readiness.hermesReady === false ? '나중에 설치 가능' : '확인 필요'}</span>
          </div>
          {!readiness.reported && <p className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[10px] leading-relaxed text-zinc-400">이전 형식의 상태 보고입니다. 먼저 단말 카드의 「안전 업데이트 명령」을 실행하면 설치 여부를 정확히 확인할 수 있습니다.</p>}
          <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
            <button onClick={() => void load()} disabled={loading} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />상태 다시 확인</button>
            <button onClick={() => void copyRuntimePreparationPrompt(runtimeHelpDevice)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-amber-700 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/10">
              {runtimePromptCopiedId === runtimeHelpDevice.device_id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {runtimePromptCopiedId === runtimeHelpDevice.device_id ? '복사됨' : '아무 AI에나 붙여넣을 준비 프롬프트 복사'}
            </button>
          </div>
        </div>;
      })()}

      {error && <div className="mx-4 mb-3 rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">{error}</div>}
      {loading ? <div className="px-4 pb-4 text-[11px] text-zinc-400">클라우드 단말을 확인하는 중…</div> : activeDevices.length === 0 ? (
        <div className="px-4 pb-4 text-[11px] text-zinc-400">등록된 클라우드 단말이 없습니다.</div>
      ) : <div className="divide-y divide-zinc-800 border-t border-zinc-800">
        {activeDevices.map(device => {
          const readiness = parseRemoteRuntimeReadiness(device.agent_version);
          const currentAgent = readiness.agentVersion === REMOTE_DEVICE_AGENT_VERSION;
          const runtimeReady = readiness.apiReady === true;
          const needsAgentUpdate = !currentAgent || !readiness.reported;
          return <div key={device.device_id} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
          <Server className="h-4 w-4 shrink-0 text-emerald-400" />
          {editing?.device_id === device.device_id ? <>
            <input value={editName} onChange={event => setEditName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveName(); if (event.key === 'Escape') setEditing(null); }} autoFocus className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-white outline-none" />
            <button onClick={() => void saveName()} disabled={savingId === device.device_id} className="rounded border border-emerald-700 px-2 py-1 text-[11px] text-emerald-300">저장</button>
            <button aria-label="단말 이름 편집 취소" onClick={() => setEditing(null)} className="flex min-h-11 min-w-11 items-center justify-center text-zinc-500"><X className="h-4 w-4" /></button>
          </> : <>
            <div className="min-w-0 flex-1">
              <p title={`${device.display_name} · ${environmentLabel(device.environment_kind)}`} className="truncate text-xs font-medium text-zinc-200">{device.display_name} <span className="font-normal text-zinc-400">· {environmentLabel(device.environment_kind)}</span></p>
              <p title={device.hostname || device.device_id} className="mt-0.5 truncate text-[10px] text-zinc-400">{device.hostname || device.device_id.slice(0, 8)} · {device.provisioning_expires_at ? '로컬 저장 확인 중' : formatSeen(device.last_seen_at)} · 프로젝트 {device.project_count || 0}개 · 에이전트 v{readiness.agentVersion || '미보고'}</p>
              <p className="mt-1 flex flex-wrap gap-1 text-[10px]">
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">1 등록됨</span>
                <span className={`rounded px-1.5 py-0.5 ${runtimeReady ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-200'}`}>2 API {runtimeReady ? '준비됨' : readiness.apiReady === false ? '준비 필요' : '확인 필요'}</span>
                <span className={`rounded px-1.5 py-0.5 ${readiness.hermesReady ? 'bg-emerald-500/10 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>Hermes {readiness.hermesReady ? 'CLI 설치됨 · 연결 별도' : '선택'}</span>
              </p>
            </div>
            <div className="flex w-full justify-end gap-2 sm:w-auto">
              <button onClick={() => openProjectSetup(device)} className={`flex min-h-11 items-center gap-1 rounded border px-2 py-1 text-[11px] ${runtimeReady ? 'border-sky-800/70 text-sky-300 hover:bg-sky-500/10' : 'border-amber-800/70 text-amber-200 hover:bg-amber-500/10'}`}>{runtimeReady ? <FolderPlus className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}{runtimeReady ? '3 프로젝트 추가' : '2 런타임 준비'}</button>
              <button onClick={() => { setEditing(device); setEditName(device.display_name); }} className="flex min-h-11 items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"><Pencil className="h-3 w-3" />편집</button>
              <button onClick={() => setPendingRevokeId(device.device_id)} disabled={savingId === device.device_id} className="flex min-h-11 items-center gap-1 rounded border border-red-900/60 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-40"><Trash2 className="h-3 w-3" />등록 해제</button>
            </div>
          </>}
          </div>
          {needsAgentUpdate && <div className="ml-6 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-700/50 bg-amber-950/15 p-3">
            <p className="text-[11px] leading-relaxed text-amber-100">{currentAgent ? '런타임 상태 형식 업데이트 필요' : `에이전트 업데이트 필요 · 설치 v${readiness.agentVersion || '미보고'} / 현재 v${REMOTE_DEVICE_AGENT_VERSION}`}</p>
            <button onClick={() => void copyUpgradeCommand(device)} className="flex min-h-11 items-center gap-1.5 rounded-md border border-amber-700/70 px-3 py-2 text-[11px] text-amber-200">
              {upgradeCopiedId === device.device_id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {upgradeCopiedId === device.device_id ? '복사됨' : '안전 업데이트 명령 복사'}
            </button>
          </div>}
          {pendingRevokeId === device.device_id && <div className="ml-6 mt-2 rounded-lg border border-red-800/60 bg-red-950/20 p-3">
            <p className="text-[11px] font-medium text-red-200">접속 자격을 폐기할까요?</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-300">이 단말은 즉시 상태 보고를 할 수 없게 됩니다. 프로젝트·장기기억·Git 이력은 삭제되지 않지만, 다시 쓰려면 서버에서 이력 승계 재연결 명령을 실행해야 합니다.</p>
            <div className="mt-2 flex justify-end gap-2">
              <button onClick={() => setPendingRevokeId(null)} className="min-h-11 rounded border border-zinc-700 px-3 py-2 text-[11px] text-zinc-300">취소</button>
              <button onClick={() => void revoke(device)} disabled={savingId === device.device_id} className="min-h-11 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-[11px] font-medium text-red-200 disabled:opacity-40">접속 자격 폐기</button>
            </div>
          </div>}
          {projects.filter(project => project.device_id === device.device_id).length > 0 && <div className="ml-6 mt-2 space-y-1.5 border-l border-zinc-800 pl-3">
            {projects.filter(project => project.device_id === device.device_id).map(project => <div key={project.project_path} className={`rounded-md border px-2.5 py-2 ${project.present ? 'border-zinc-800 bg-zinc-950/60' : 'border-amber-900/40 bg-amber-950/10 opacity-70'}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] text-zinc-300">{project.project_name}</p>
                <span className={`shrink-0 text-[11px] ${project.present ? project.git_dirty ? 'text-amber-300' : 'text-emerald-400' : 'text-amber-400'}`}>{project.present ? project.git_dirty ? '변경 있음' : '확인됨' : '현재 없음·이력 보관'}</span>
              </div>
              <p title={project.project_path} className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{project.project_path}</p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-400">{project.memory_id ? `기억 ${project.memory_id.slice(0, 8)}` : '장기기억 없음'} · {project.git_head_sha ? `${project.git_branch || 'HEAD'} ${project.git_head_sha.slice(0, 8)}` : 'Git 커밋 없음'}</p>
              {project.telegram_thread_id && <p className="mt-1 text-[11px] text-sky-300">Telegram 토픽 #{project.telegram_thread_id}</p>}
            </div>)}
          </div>}
        </div>;
        })}
      </div>}
      {revokedDevices.length > 0 && <details className="border-t border-zinc-800 px-4 py-3">
        <summary className="cursor-pointer text-[11px] text-zinc-400">등록 해제된 단말 {revokedDevices.length}대 · 이력 보관</summary>
        <div className="mt-2 space-y-2">{revokedDevices.map(device => <div key={device.device_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] text-zinc-300">{device.display_name} · {environmentLabel(device.environment_kind)}</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">이력 프로젝트 {device.project_count || 0}개 · ID {device.device_id.slice(0, 8)}</p>
          </div>
          <button onClick={() => prepareRevokedDeviceReconnect(device)} className="min-h-11 rounded-md border border-amber-700/60 px-3 py-2 text-[11px] text-amber-200 hover:bg-amber-500/10">이력 승계 재연결</button>
        </div>)}</div>
      </details>}
    </section>
  );
}
