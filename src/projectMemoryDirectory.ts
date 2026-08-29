import { normalizeSearchText } from './searchText';
import { normalizeGitHubRepositoryUrl } from './githubUrls';

/**
 * 배포 포털의 장기기억 목록 판정 한 곳.
 *
 * 포털은 브라우저 단독이라 로컬 API(3001)에 닿을 수 없다. 그래서 여기서 할 수 있는 일은
 * 기억 **내용을 내려받는 것**이 아니라 Supabase 를 직접 읽어 **어떤 기억이 있고 그 ID 가
 * 무엇인지** 보여주는 것이다. 그 ID 를 다른 기기의 앱에 붙여넣는 것이 실제 연동 경로다.
 *
 * 저장소가 없는 기억은 `github_url` 로 서로를 찾을 수 없어 **ID 를 건네는 것이 유일한 길**이다
 * (실측 2026-08-14: 기억 43개 중 36개가 저장소 없음).
 */

/** `portmgr_project_memory_revisions` 에서 목록에 필요한 열만. `content` 는 크므로 뺀다. */
export interface MemoryRevisionRow {
  id: string;
  memory_id: string | null;
  project_name: string | null;
  github_url: string | null;
  device_id: string | null;
  device_name: string | null;
  content_hash: string | null;
  created_at: string | null;
}

/** 리비전은 Push 이력이고, 이 행은 Pull/상태확인까지 포함한 단말별 마지막 확인점이다. */
export interface MemoryDeviceStatusRow {
  memory_id: string | null;
  device_id: string | null;
  device_name: string | null;
  platform: string | null;
  revision_id: string | null;
  content_hash: string | null;
  last_synced_at: string | null;
  last_seen_at: string | null;
  source_path?: string | null;
  git_head_sha?: string | null;
  git_branch?: string | null;
  git_remote_url?: string | null;
  git_upstream_sha?: string | null;
  git_ahead?: number | null;
  git_behind?: number | null;
  git_dirty?: boolean | null;
  git_commit_at?: string | null;
  git_checked_at?: string | null;
  git_fetch_ok?: boolean | null;
  git_fetch_error?: string | null;
  telegram_chat_id?: string | null;
  telegram_thread_id?: string | null;
  /** 원격 호스트 등록 해제처럼 status 테이블 밖에서 확인된 사용 종료 시각. */
  retired_at?: string | null;
}

/** 같은 물리 단말에서 재발급된 과거 설치 ID를 현재 ID로 접는 가역적 연결. */
export interface DeviceIdentityAliasRow {
  alias_device_id: string | null;
  canonical_device_id: string | null;
  linked_at: string | null;
}

/** 일반 단말 목록의 사람이 정한 대표 이름. 장기기억 보고의 hostname보다 우선한다. */
export interface PhysicalDeviceRow {
  id: string | null;
  name: string | null;
  last_push_at: string | null;
}

/** 클라우드 호스트 인벤토리를 장기기억 단말 카드로 보강하기 위한 최소 열. */
export interface RemoteMemoryDeviceRow {
  device_id: string | null;
  display_name: string | null;
  platform: string | null;
  environment_kind: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface RemoteMemoryProjectRow {
  device_id: string | null;
  project_path: string | null;
  memory_id: string | null;
  git_remote_url: string | null;
  git_head_sha: string | null;
  git_branch: string | null;
  git_dirty: boolean | null;
  present: boolean | null;
  last_observed_at: string | null;
  telegram_chat_id: string | null;
  telegram_thread_id: string | null;
}

/**
 * 원격 호스트 에이전트의 프로젝트 인벤토리는 기억 status 보고보다 먼저 도착할 수 있다.
 * 그 짧거나 영구적인 간극 때문에 AWS 프로젝트를 "플랫폼 미상"으로 숨기지 않도록,
 * 확인된 host→project 관계를 보수적인 장기기억 단말 관측으로 변환한다.
 */
export function remoteMemoryDeviceStatusRows(
  devices: readonly RemoteMemoryDeviceRow[],
  projects: readonly RemoteMemoryProjectRow[],
): MemoryDeviceStatusRow[] {
  const knownDevices = new Map(devices
    .filter(device => !!device.device_id)
    .map(device => [device.device_id!, device] as const));
  return projects.flatMap(project => {
    const device = project.device_id ? knownDevices.get(project.device_id) : null;
    const memoryId = project.memory_id?.trim();
    if (!device || !memoryId || project.present === false) return [];
    return [{
      memory_id: memoryId,
      device_id: device.device_id,
      device_name: device.display_name,
      platform: device.environment_kind === 'aws' ? 'aws' : device.platform,
      revision_id: null,
      content_hash: null,
      last_synced_at: null,
      last_seen_at: device.revoked_at || project.last_observed_at || device.last_seen_at,
      source_path: project.project_path,
      git_head_sha: project.git_head_sha,
      git_branch: project.git_branch,
      git_remote_url: project.git_remote_url,
      git_upstream_sha: null,
      git_ahead: null,
      git_behind: null,
      git_dirty: project.git_dirty,
      git_commit_at: null,
      git_checked_at: project.last_observed_at,
      git_fetch_ok: null,
      git_fetch_error: null,
      telegram_chat_id: project.telegram_chat_id,
      telegram_thread_id: project.telegram_thread_id,
      retired_at: device.revoked_at,
    } satisfies MemoryDeviceStatusRow];
  });
}

/** 사용자가 더 이상 확인 대상이 아니라고 명시한 단말. 원격 이력은 삭제하지 않는다. */
export interface MemoryDeviceRetirementRow {
  memory_id: string | null;
  device_id: string | null;
  retired_at: string | null;
}

/** 장기기억 원본은 그대로 두고 기본 목록에서만 숨기는 가역적 휴지통 상태. */
export interface MemoryTrashRow {
  memory_id: string | null;
  trashed_at: string | null;
}

export interface MemoryAliasRow {
  alias_memory_id: string | null;
  canonical_memory_id: string | null;
  merge_id: string | null;
  all_known_devices_migrated_at: string | null;
}

export interface MemoryLabelRow {
  memory_id: string | null;
  display_name: string | null;
  updated_at: string | null;
}

export interface MemoryMergeRow {
  id: string | null;
  target_memory_id: string | null;
  status: string | null;
  repository_strategy: string | null;
  repository_url: string | null;
  created_at: string | null;
}

export interface MemoryMergeDeviceRow {
  merge_id: string | null;
  device_id: string | null;
  previous_memory_id: string | null;
  adopted_at: string | null;
}

export interface MemoryDirectoryDevice {
  deviceId: string;
  legacyDeviceIds: string[];
  deviceName: string;
  platform: string | null;
  revisionId: string | null;
  contentHash: string | null;
  lastSyncedAt: string | null;
  lastSeenAt: string | null;
  sourcePath: string | null;
  inSync: boolean;
  /** 구버전 DB는 리비전으로만 추정한다. confirmed만 Pull 확인을 포함한다. */
  statusSource: 'confirmed' | 'revision';
  /** 이력은 남기되 최신/확인 필요 집계에서 제외하는 사용 종료 시각. */
  retiredAt: string | null;
  gitHeadSha: string | null;
  gitBranch: string | null;
  gitRemoteUrl: string | null;
  gitUpstreamSha: string | null;
  gitAhead: number | null;
  gitBehind: number | null;
  gitDirty: boolean | null;
  gitCommitAt: string | null;
  gitCheckedAt: string | null;
  gitFetchOk: boolean | null;
  gitFetchError: string | null;
  telegramChatId: string | null;
  telegramThreadId: string | null;
  historicalNames: string[];
  identityWarning: boolean;
}

export type MemoryDeviceGitState = 'unreported' | 'dirty' | 'diverged' | 'behind' | 'ahead' | 'synced' | 'commit-only';

export function memoryDeviceGitState(device: Pick<MemoryDirectoryDevice,
  'gitHeadSha' | 'gitUpstreamSha' | 'gitAhead' | 'gitBehind' | 'gitDirty'>): MemoryDeviceGitState {
  if (!device.gitHeadSha) return 'unreported';
  if (device.gitDirty === true) return 'dirty';
  if ((device.gitAhead ?? 0) > 0 && (device.gitBehind ?? 0) > 0) return 'diverged';
  if ((device.gitBehind ?? 0) > 0) return 'behind';
  if ((device.gitAhead ?? 0) > 0) return 'ahead';
  if (device.gitUpstreamSha && device.gitUpstreamSha === device.gitHeadSha) return 'synced';
  return 'commit-only';
}

export function memoryDeviceIdentityWarning(platform: string | null | undefined, names: readonly string[]): boolean {
  const joined = names.join(' ').toLowerCase();
  if (!joined.trim()) return false;
  if (platform === 'darwin') return /\b(?:aws|ec2|ubuntu|linux|windows)\b|그램/.test(joined);
  if (platform === 'win32') return /\b(?:aws|ec2|ubuntu|linux|macbook|macos)\b|맥북/.test(joined);
  if (platform === 'linux') return /\b(?:macbook|macos|windows|gram)\b|맥북|그램/.test(joined);
  return false;
}

export interface MemoryDirectoryEntry {
  memoryId: string;
  /** 가장 최근 리비전이 쓴 이름. 이름은 바뀌어도 memoryId 는 고정이다. */
  projectName: string;
  githubUrl: string | null;
  /** 마지막으로 push 한 기기. */
  lastDeviceName: string | null;
  updatedAt: string | null;
  /** 조회한 구간 안에서 이 기억에 push 한 서로 다른 기기 수. */
  deviceCountInWindow: number;
  /** 조회한 구간 안의 리비전 수. 전체 수가 아니다. */
  revisionsInWindow: number;
  headRevisionId: string;
  headContentHash: string | null;
  devices: MemoryDirectoryDevice[];
  syncedDeviceCount: number;
  staleDeviceCount: number;
  retiredDeviceCount: number;
  displayName: string | null;
  legacyMemoryIds: string[];
  mergeStatus: 'awaiting-devices' | 'complete' | null;
  pendingMigrationDeviceCount: number;
  mergeRepositoryStrategy: string | null;
  mergeRepositoryUrl: string | null;
  /** 값이 있으면 원본·리비전·단말 이력을 보존한 채 휴지통에 숨겨진 상태다. */
  trashedAt: string | null;
}

export type MemoryRepositoryFilter = 'all' | 'with-repository' | 'without-repository' | 'review';

export type MemoryRepositoryGuidance =
  | { kind: 'memory-only'; inactiveDays: null }
  | { kind: 'connect'; priority: 'normal' | 'high'; inactiveDays: number | null }
  | { kind: 'stale'; inactiveDays: number };

/**
 * 추천은 정리 결정을 대신하지 않는다. 최근 상태 확인(gitCheckedAt)은 변경 활동이 아니므로
 * 기억 Push와 실제 Git 커밋만 사용하고, 90일이 지난 뒤에도 휴지통 "검토"만 권한다.
 */
export const MEMORY_REPOSITORY_PRIORITY_DAYS = 30;
export const MEMORY_REPOSITORY_STALE_DAYS = 90;

function latestMeaningfulActivityAt(entry: MemoryDirectoryEntry): number | null {
  const candidates = [entry.updatedAt, ...entry.devices.map(device => device.gitCommitAt)]
    .map(value => Date.parse(value ?? ''))
    .filter(value => Number.isFinite(value));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function inactiveDaysSince(entry: MemoryDirectoryEntry, now: number): number | null {
  const latest = latestMeaningfulActivityAt(entry);
  if (latest === null || !Number.isFinite(now) || now < latest) return null;
  return Math.floor((now - latest) / 86_400_000);
}

/** 코드 저장소가 아니라 Telegram 토픽의 기억만 보존하는 명시적인 항목은 GitHub를 강요하지 않는다. */
export function isMemoryOnlyDirectoryEntry(entry: MemoryDirectoryEntry): boolean {
  if (entry.githubUrl) return false;
  if (/^telegram(?:[-_ ]memory|\s+topic)/i.test(entry.projectName.trim())) return true;
  const activeDevices = entry.devices.filter(device => !device.retiredAt);
  return activeDevices.length > 0 && activeDevices.every(device =>
    !!device.telegramThreadId
    && !device.gitHeadSha
    && !device.gitRemoteUrl
    && /(?:^|[/\\])project-memories(?:[/\\]|$)/i.test(device.sourcePath ?? ''));
}

export function memoryRepositoryGuidance(
  entry: MemoryDirectoryEntry,
  now = Date.now(),
): MemoryRepositoryGuidance | null {
  const inactiveDays = inactiveDaysSince(entry, now);
  if (entry.githubUrl) {
    return inactiveDays !== null && inactiveDays >= MEMORY_REPOSITORY_STALE_DAYS
      ? { kind: 'stale', inactiveDays }
      : null;
  }
  if (isMemoryOnlyDirectoryEntry(entry)) return { kind: 'memory-only', inactiveDays: null };
  const activeDeviceCount = entry.devices.filter(device => !device.retiredAt).length;
  return {
    kind: 'connect',
    priority: activeDeviceCount > 1 || (inactiveDays !== null && inactiveDays >= MEMORY_REPOSITORY_PRIORITY_DAYS)
      ? 'high'
      : 'normal',
    inactiveDays,
  };
}

export function filterMemoryDirectoryByRepository(
  entries: readonly MemoryDirectoryEntry[],
  filter: MemoryRepositoryFilter,
  now = Date.now(),
): MemoryDirectoryEntry[] {
  if (filter === 'all') return [...entries];
  if (filter === 'with-repository') return entries.filter(entry => !!entry.githubUrl);
  if (filter === 'without-repository') return entries.filter(entry => !entry.githubUrl);
  return entries.filter(entry => {
    const guidance = memoryRepositoryGuidance(entry, now);
    return guidance?.kind === 'connect' || guidance?.kind === 'stale';
  });
}

/** 장기기억 탭의 통합 필터. 데스크톱(portmgr_devices)과 원격 호스트를 한 목록으로 보여준다. */
export interface MemoryDeviceFilter {
  deviceId: string;
  legacyDeviceIds: string[];
  deviceName: string;
  platform: string | null;
  kind: 'desktop' | 'remote';
  memoryCount: number;
}

/**
 * 리비전 목록을 기억 단위로 접는다. PostgREST 에 `DISTINCT ON` 이 없어 최근 N 건을 받아
 * 여기서 접는다 — 그래서 집계값은 **조회 구간 한정**이고, 이름에 그 사실을 담았다.
 *
 * 입력은 정렬을 가정하지 않는다. 호출부가 정렬을 바꿔도 결과가 흔들리면 안 된다.
 */
export function buildMemoryDirectory(
  rows: readonly MemoryRevisionRow[],
  deviceRows: readonly MemoryDeviceStatusRow[] = [],
  aliasRows: readonly MemoryAliasRow[] = [],
  labelRows: readonly MemoryLabelRow[] = [],
  mergeRows: readonly MemoryMergeRow[] = [],
  mergeDeviceRows: readonly MemoryMergeDeviceRow[] = [],
  retirementRows: readonly MemoryDeviceRetirementRow[] = [],
  deviceIdentityRows: readonly DeviceIdentityAliasRow[] = [],
  physicalDeviceRows: readonly PhysicalDeviceRow[] = [],
  trashRows: readonly MemoryTrashRow[] = [],
): MemoryDirectoryEntry[] {
  const deviceIdentityMap = new Map(deviceIdentityRows.flatMap(row => {
    const alias = (row.alias_device_id ?? '').trim();
    const canonical = (row.canonical_device_id ?? '').trim();
    return alias && canonical && alias !== canonical ? [[alias, canonical] as const] : [];
  }));
  const resolveDeviceId = (deviceId: string): string => {
    let current = deviceId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 20; depth += 1) {
      const next = deviceIdentityMap.get(current);
      if (!next || seen.has(next)) return current;
      seen.add(current);
      current = next;
    }
    return current;
  };
  const legacyDeviceIdsByCanonical = new Map<string, Set<string>>();
  for (const alias of deviceIdentityMap.keys()) {
    const canonical = resolveDeviceId(alias);
    if (canonical === alias) continue;
    const ids = legacyDeviceIdsByCanonical.get(canonical) ?? new Set<string>();
    ids.add(alias);
    legacyDeviceIdsByCanonical.set(canonical, ids);
  }
  const physicalNameByCanonical = new Map<string, { name: string; seenAt: string | null }>();
  for (const row of physicalDeviceRows) {
    const deviceId = resolveDeviceId((row.id ?? '').trim());
    const name = (row.name ?? '').trim();
    if (!deviceId || !name) continue;
    const existing = physicalNameByCanonical.get(deviceId);
    if (!existing || compareCreatedAt(row.last_push_at, existing.seenAt) > 0) {
      physicalNameByCanonical.set(deviceId, { name, seenAt: row.last_push_at });
    }
  }
  // 상태 보고는 기억별로 저장되지만 플랫폼은 물리 단말의 속성이다. 다른 기억에서 이미
  // 확인된 값을 같은 canonical ID의 revision-only 카드에도 보강한다.
  const platformByCanonical = new Map<string, { platform: string; seenAt: string | null }>();
  for (const row of deviceRows) {
    const deviceId = resolveDeviceId((row.device_id ?? '').trim());
    const platform = (row.platform ?? '').trim();
    if (!deviceId || !platform) continue;
    const existing = platformByCanonical.get(deviceId);
    if (!existing || compareCreatedAt(row.last_seen_at, existing.seenAt) > 0) {
      platformByCanonical.set(deviceId, { platform, seenAt: row.last_seen_at });
    }
  }
  const retirementByMemoryDevice = new Map<string, string>();
  for (const row of retirementRows) {
    const memoryId = (row.memory_id ?? '').trim();
    const deviceId = resolveDeviceId((row.device_id ?? '').trim());
    const retiredAt = (row.retired_at ?? '').trim();
    if (!memoryId || !deviceId || !retiredAt) continue;
    const key = `${memoryId}\0${deviceId}`;
    const existing = retirementByMemoryDevice.get(key);
    if (!existing || compareCreatedAt(retiredAt, existing) > 0) retirementByMemoryDevice.set(key, retiredAt);
  }
  const retiredAtFor = (memoryIds: readonly string[], deviceId: string): string | null => {
    let latest: string | null = null;
    for (const memoryId of memoryIds) {
      const candidate = retirementByMemoryDevice.get(`${memoryId}\0${deviceId}`) ?? null;
      if (candidate && (!latest || compareCreatedAt(candidate, latest) > 0)) latest = candidate;
    }
    return latest;
  };

  const byMemory = new Map<string, {
    latest: MemoryRevisionRow;
    devices: Set<string>;
    revisions: number;
  }>();

  for (const row of rows) {
    const memoryId = (row.memory_id ?? '').trim();
    const deviceId = resolveDeviceId((row.device_id ?? '').trim());
    if (!memoryId) continue;
    const existing = byMemory.get(memoryId);
    if (!existing) {
      byMemory.set(memoryId, {
        latest: row,
        devices: new Set(deviceId ? [deviceId] : []),
        revisions: 1,
      });
      continue;
    }
    existing.revisions += 1;
    if (deviceId) existing.devices.add(deviceId);
    if (compareCreatedAt(row.created_at, existing.latest.created_at) > 0) existing.latest = row;
  }

  const confirmedByMemory = new Map<string, Map<string, MemoryDeviceStatusRow>>();
  for (const row of deviceRows) {
    const memoryId = (row.memory_id ?? '').trim();
    const deviceId = resolveDeviceId((row.device_id ?? '').trim());
    if (!memoryId || !deviceId) continue;
    let devices = confirmedByMemory.get(memoryId);
    if (!devices) confirmedByMemory.set(memoryId, devices = new Map());
    const existing = devices.get(deviceId);
    if (!existing || compareCreatedAt(row.last_seen_at, existing.last_seen_at) > 0) {
      devices.set(deviceId, { ...row, device_id: deviceId });
    }
  }

  const base = [...byMemory.entries()]
    .map(([memoryId, group]) => {
      // 같은 단말이 이후 Push에서 device_name을 비워 보내더라도 과거에 확인된
      // 사람 친화적 이름(Hermes AWS 등)을 잃지 않는다. 최신 리비전/해시 판정은
      // 그대로 최신 행을 쓰고, 표시 이름만 가장 최근의 비어 있지 않은 값을 잇는다.
      const lastKnownDeviceNames = new Map<string, { name: string; seenAt: string | null }>();
      const allKnownDeviceNames = new Map<string, Map<string, string | null>>();
      for (const row of rows) {
        if ((row.memory_id ?? '').trim() !== memoryId || !row.device_id) continue;
        const deviceId = resolveDeviceId(row.device_id);
        const name = (row.device_name ?? '').trim();
        if (!name) continue;
        let known = allKnownDeviceNames.get(deviceId);
        if (!known) allKnownDeviceNames.set(deviceId, known = new Map());
        const knownAt = known.get(name);
        if (knownAt === undefined || compareCreatedAt(row.created_at, knownAt) > 0) known.set(name, row.created_at);
        const existing = lastKnownDeviceNames.get(deviceId);
        if (!existing || compareCreatedAt(row.created_at, existing.seenAt) > 0) {
          lastKnownDeviceNames.set(deviceId, { name, seenAt: row.created_at });
        }
      }
      const deviceDisplayName = (deviceId: string, currentName: string | null | undefined): string =>
        physicalNameByCanonical.get(deviceId)?.name
        || (currentName ?? '').trim()
        || lastKnownDeviceNames.get(deviceId)?.name
        || `단말 ${deviceId.slice(0, 8)}`;
      const historicalNamesFor = (deviceId: string, currentName: string | null | undefined): string[] => {
        const current = (currentName ?? '').trim();
        return [...(allKnownDeviceNames.get(deviceId)?.entries() ?? [])]
          .sort((a, b) => compareCreatedAt(b[1], a[1]))
          .map(([name]) => name)
          .filter(name => name !== current);
      };
      const devices = new Map<string, MemoryDirectoryDevice>();
      for (const row of rows) {
        if ((row.memory_id ?? '').trim() !== memoryId || !row.device_id) continue;
        const deviceId = resolveDeviceId(row.device_id);
        const existing = devices.get(deviceId);
        if (existing && compareCreatedAt(existing.lastSeenAt, row.created_at) >= 0) continue;
        const platform = platformByCanonical.get(deviceId)?.platform ?? null;
        const deviceName = deviceDisplayName(deviceId, row.device_name);
        const historicalNames = historicalNamesFor(deviceId, deviceName);
        devices.set(deviceId, {
          deviceId,
          legacyDeviceIds: [...(legacyDeviceIdsByCanonical.get(deviceId) ?? [])].sort(),
          deviceName,
          platform,
          revisionId: row.id,
          contentHash: row.content_hash,
          lastSyncedAt: row.created_at,
          lastSeenAt: row.created_at,
          sourcePath: null,
          inSync: row.content_hash != null && row.content_hash === group.latest.content_hash,
          statusSource: 'revision',
          retiredAt: retiredAtFor([memoryId], deviceId),
          gitHeadSha: null,
          gitBranch: null,
          gitRemoteUrl: null,
          gitUpstreamSha: null,
          gitAhead: null,
          gitBehind: null,
          gitDirty: null,
          gitCommitAt: null,
          gitCheckedAt: null,
          gitFetchOk: null,
          gitFetchError: null,
          telegramChatId: null,
          telegramThreadId: null,
          historicalNames,
          identityWarning: memoryDeviceIdentityWarning(platform, [deviceName, ...historicalNames]),
        });
      }
      for (const row of confirmedByMemory.get(memoryId)?.values() ?? []) {
        const deviceId = resolveDeviceId(row.device_id!);
        const deviceName = deviceDisplayName(deviceId, row.device_name);
        const historicalNames = historicalNamesFor(deviceId, row.device_name);
        devices.set(deviceId, {
          deviceId,
          legacyDeviceIds: [...(legacyDeviceIdsByCanonical.get(deviceId) ?? [])].sort(),
          deviceName,
          platform: row.platform,
          revisionId: row.revision_id,
          contentHash: row.content_hash,
          lastSyncedAt: row.last_synced_at,
          lastSeenAt: row.last_seen_at,
          sourcePath: (row.source_path ?? '').trim() || null,
          inSync: row.content_hash != null && row.content_hash === group.latest.content_hash,
          statusSource: 'confirmed',
          retiredAt: (row.retired_at ?? '').trim() || retiredAtFor([memoryId], deviceId),
          gitHeadSha: (row.git_head_sha ?? '').trim() || null,
          gitBranch: (row.git_branch ?? '').trim() || null,
          gitRemoteUrl: (row.git_remote_url ?? '').trim() || null,
          gitUpstreamSha: (row.git_upstream_sha ?? '').trim() || null,
          gitAhead: Number.isInteger(row.git_ahead) ? row.git_ahead! : null,
          gitBehind: Number.isInteger(row.git_behind) ? row.git_behind! : null,
          gitDirty: typeof row.git_dirty === 'boolean' ? row.git_dirty : null,
          gitCommitAt: (row.git_commit_at ?? '').trim() || null,
          gitCheckedAt: (row.git_checked_at ?? '').trim() || null,
          gitFetchOk: typeof row.git_fetch_ok === 'boolean' ? row.git_fetch_ok : null,
          gitFetchError: (row.git_fetch_error ?? '').trim() || null,
          telegramChatId: (row.telegram_chat_id ?? '').trim() || null,
          telegramThreadId: (row.telegram_thread_id ?? '').trim() || null,
          historicalNames,
          identityWarning: memoryDeviceIdentityWarning(row.platform, [deviceName, ...historicalNames]),
        });
      }
      const deviceList = [...devices.values()].sort((a, b) => {
        if (!!a.retiredAt !== !!b.retiredAt) return a.retiredAt ? 1 : -1;
        if (a.inSync !== b.inSync) return a.inSync ? -1 : 1;
        return compareCreatedAt(b.lastSeenAt, a.lastSeenAt) || a.deviceName.localeCompare(b.deviceName);
      });
      // 「이 단말 상태 갱신」은 실제 폴더의 git origin을 device status에 기록한다.
      // 예전에는 목록이 revision.github_url만 읽어 그 자동 감지 결과를 버렸다. 명시적으로
      // Push된 주소를 우선하고, 활성 단말들이 보고한 GitHub 저장소가 하나로 일치할 때만
      // 안전한 fallback으로 채택한다. 서로 다른 원격이 섞이면 임의로 고르지 않는다.
      const reportedRepositories = new Map<string, string>();
      for (const device of deviceList) {
        if (device.retiredAt || !device.gitRemoteUrl) continue;
        const repositoryUrl = normalizeGitHubRepositoryUrl(device.gitRemoteUrl);
        if (repositoryUrl) reportedRepositories.set(repositoryUrl.toLowerCase(), repositoryUrl);
      }
      const explicitGithubUrl = (group.latest.github_url ?? '').trim() || null;
      const detectedGithubUrl = reportedRepositories.size === 1
        ? [...reportedRepositories.values()][0]!
        : null;
      return {
      memoryId,
      // 이름이 빈 리비전만 있는 기억도 목록에서 사라지면 안 된다 — ID 를 건네려면 보여야 한다.
      projectName: (group.latest.project_name ?? '').trim() || '(이름 없음)',
      githubUrl: explicitGithubUrl ?? detectedGithubUrl,
      lastDeviceName: group.latest.device_id
        ? deviceDisplayName(group.latest.device_id, group.latest.device_name)
        : (group.latest.device_name ?? '').trim() || null,
      updatedAt: group.latest.created_at ?? null,
      deviceCountInWindow: group.devices.size,
      revisionsInWindow: group.revisions,
      headRevisionId: group.latest.id,
      headContentHash: group.latest.content_hash,
      devices: deviceList,
      syncedDeviceCount: deviceList.filter(device => !device.retiredAt && device.inSync).length,
      staleDeviceCount: deviceList.filter(device => !device.retiredAt && !device.inSync).length,
      retiredDeviceCount: deviceList.filter(device => !!device.retiredAt).length,
      displayName: null,
      legacyMemoryIds: [],
      mergeStatus: null,
      pendingMigrationDeviceCount: 0,
      mergeRepositoryStrategy: null,
      mergeRepositoryUrl: null,
      trashedAt: null,
    };})
    .sort((a, b) => compareCreatedAt(b.updatedAt, a.updatedAt) || a.projectName.localeCompare(b.projectName));

  const aliasMap = new Map(aliasRows.flatMap(row => {
    const alias = (row.alias_memory_id ?? '').trim();
    const canonical = (row.canonical_memory_id ?? '').trim();
    return alias && canonical ? [[alias, canonical] as const] : [];
  }));
  const resolveCanonical = (memoryId: string): string => {
    let current = memoryId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 20; depth += 1) {
      const next = aliasMap.get(current);
      if (!next || seen.has(next)) return current;
      seen.add(current);
      current = next;
    }
    return current;
  };
  const labels = new Map(labelRows.flatMap(row => {
    const id = (row.memory_id ?? '').trim();
    const name = (row.display_name ?? '').trim();
    return id && name ? [[id, name] as const] : [];
  }));
  const mergesByTarget = new Map<string, MemoryMergeRow>();
  for (const row of mergeRows) {
    const target = (row.target_memory_id ?? '').trim();
    if (!target) continue;
    const existing = mergesByTarget.get(target);
    if (!existing || compareCreatedAt(row.created_at, existing.created_at) > 0) mergesByTarget.set(target, row);
  }
  const groups = new Map<string, MemoryDirectoryEntry[]>();
  for (const entry of base) {
    const canonical = resolveCanonical(entry.memoryId);
    const group = groups.get(canonical) ?? [];
    group.push(entry);
    groups.set(canonical, group);
  }
  const trashedAtByCanonical = new Map<string, string>();
  for (const row of trashRows) {
    const memoryId = resolveCanonical((row.memory_id ?? '').trim());
    const trashedAt = (row.trashed_at ?? '').trim();
    if (!memoryId || !trashedAt) continue;
    const existing = trashedAtByCanonical.get(memoryId);
    if (!existing || compareCreatedAt(trashedAt, existing) > 0) trashedAtByCanonical.set(memoryId, trashedAt);
  }
  return [...groups.entries()].map(([canonical, group]) => {
    const target = group.find(entry => entry.memoryId === canonical) ?? group[0]!;
    const lineageMemoryIds = [...new Set([
      canonical,
      ...group.map(entry => entry.memoryId),
      ...aliasRows
        .filter(row => resolveCanonical((row.alias_memory_id ?? '').trim()) === canonical)
        .map(row => (row.alias_memory_id ?? '').trim())
        .filter(Boolean),
    ])];
    const devices = new Map<string, MemoryDirectoryDevice>();
    for (const entry of group) {
      for (const device of entry.devices) {
        const candidate = {
          ...device,
          inSync: device.contentHash != null && device.contentHash === target.headContentHash,
          retiredAt: retiredAtFor(lineageMemoryIds, device.deviceId) ?? device.retiredAt,
        };
        const existing = devices.get(device.deviceId);
        if (!existing || (candidate.inSync && !existing.inSync)
          || (candidate.inSync === existing.inSync && compareCreatedAt(candidate.lastSeenAt, existing.lastSeenAt) > 0)) {
          devices.set(device.deviceId, candidate);
        }
      }
    }
    const deviceList = [...devices.values()].sort((a, b) => Number(!!a.retiredAt) - Number(!!b.retiredAt)
      || Number(b.inSync) - Number(a.inSync) || compareCreatedAt(b.lastSeenAt, a.lastSeenAt));
    const merge = mergesByTarget.get(canonical);
    const pendingMigrationDeviceCount = merge?.id
      ? new Set(mergeDeviceRows.filter(row => row.merge_id === merge.id && !row.adopted_at && !!row.device_id)
        .map(row => resolveDeviceId(row.device_id!))
        .filter(deviceId => !retiredAtFor(lineageMemoryIds, deviceId))).size
      : 0;
    return {
      ...target,
      memoryId: canonical,
      displayName: labels.get(canonical) ?? null,
      legacyMemoryIds: [...new Set([
        ...group.map(entry => entry.memoryId).filter(id => id !== canonical),
        ...aliasRows.filter(row => resolveCanonical((row.alias_memory_id ?? '').trim()) === canonical).map(row => (row.alias_memory_id ?? '').trim()).filter(Boolean),
      ])].sort(),
      devices: deviceList,
      deviceCountInWindow: deviceList.length,
      revisionsInWindow: group.reduce((sum, entry) => sum + entry.revisionsInWindow, 0),
      syncedDeviceCount: deviceList.filter(device => !device.retiredAt && device.inSync).length,
      staleDeviceCount: deviceList.filter(device => !device.retiredAt && !device.inSync).length,
      retiredDeviceCount: deviceList.filter(device => !!device.retiredAt).length,
      // 빈 merge-device 조회가 곧 완료라는 뜻은 아니다. DB RPC가 상태를 확정한다.
      mergeStatus: merge?.status === 'complete' ? 'complete' as const : merge ? 'awaiting-devices' as const : null,
      pendingMigrationDeviceCount,
      mergeRepositoryStrategy: merge?.repository_strategy ?? null,
      mergeRepositoryUrl: merge?.repository_url ?? null,
      trashedAt: trashedAtByCanonical.get(canonical) ?? null,
    };
  }).sort((a, b) => compareCreatedAt(b.updatedAt, a.updatedAt) || a.projectName.localeCompare(b.projectName));
}

/**
 * 상단 프로젝트 선택기는 로컬 앱이 Push한 데스크톱만 다룬다. 장기기억 필터는 그보다 넓은
 * 물리 단말 인벤토리이므로 활성 원격 호스트(AWS/Ubuntu 포함)를 함께 접는다.
 */
export function buildMemoryDeviceFilters(
  entries: readonly MemoryDirectoryEntry[],
  deviceIdentityRows: readonly DeviceIdentityAliasRow[] = [],
  physicalDeviceRows: readonly PhysicalDeviceRow[] = [],
  remoteDeviceRows: readonly RemoteMemoryDeviceRow[] = [],
): MemoryDeviceFilter[] {
  const aliasMap = new Map(deviceIdentityRows.flatMap(row => {
    const alias = (row.alias_device_id ?? '').trim();
    const canonical = (row.canonical_device_id ?? '').trim();
    return alias && canonical && alias !== canonical ? [[alias, canonical] as const] : [];
  }));
  const resolveDeviceId = (deviceId: string): string => {
    let current = deviceId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 20; depth += 1) {
      const next = aliasMap.get(current);
      if (!next || seen.has(next)) return current;
      seen.add(current);
      current = next;
    }
    return current;
  };
  const legacyByCanonical = new Map<string, Set<string>>();
  for (const alias of aliasMap.keys()) {
    const canonical = resolveDeviceId(alias);
    const legacy = legacyByCanonical.get(canonical) ?? new Set<string>();
    legacy.add(alias);
    legacyByCanonical.set(canonical, legacy);
  }
  const observedPlatform = new Map<string, string>();
  for (const entry of entries) {
    for (const device of entry.devices) {
      if (device.platform) observedPlatform.set(resolveDeviceId(device.deviceId), device.platform);
    }
  }
  const filters = new Map<string, Omit<MemoryDeviceFilter, 'memoryCount'>>();
  for (const row of physicalDeviceRows) {
    const deviceId = resolveDeviceId((row.id ?? '').trim());
    if (!deviceId) continue;
    filters.set(deviceId, {
      deviceId,
      legacyDeviceIds: [...(legacyByCanonical.get(deviceId) ?? [])].sort(),
      deviceName: (row.name ?? '').trim() || `단말 ${deviceId.slice(0, 8)}`,
      platform: observedPlatform.get(deviceId) ?? null,
      kind: 'desktop',
    });
  }
  for (const row of remoteDeviceRows) {
    if (row.revoked_at) continue;
    const deviceId = resolveDeviceId((row.device_id ?? '').trim());
    if (!deviceId) continue;
    filters.set(deviceId, {
      deviceId,
      legacyDeviceIds: [...(legacyByCanonical.get(deviceId) ?? [])].sort(),
      deviceName: (row.display_name ?? '').trim() || `서버 ${deviceId.slice(0, 8)}`,
      platform: row.environment_kind === 'aws' ? 'aws' : ((row.platform ?? '').trim() || observedPlatform.get(deviceId) || null),
      kind: 'remote',
    });
  }
  return [...filters.values()].map(filter => ({
    ...filter,
    memoryCount: entries.filter(entry => !entry.trashedAt && entry.devices.some(device =>
      resolveDeviceId(device.deviceId) === filter.deviceId)).length,
  })).sort((a, b) => Number(a.kind === 'remote') - Number(b.kind === 'remote')
    || a.deviceName.localeCompare(b.deviceName, 'ko'));
}

/** 값이 없거나 파싱되지 않는 시각은 항상 더 오래된 것으로 둔다. */
function compareCreatedAt(a: string | null | undefined, b: string | null | undefined): number {
  const left = Date.parse(a ?? '');
  const right = Date.parse(b ?? '');
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return -1;
  if (!rightValid) return 1;
  return left - right;
}

/** 검색어로 거른다. ID 일부만 붙여넣어도 찾아지도록 memoryId 도 대상에 넣는다. */
export function filterMemoryDirectory(
  entries: readonly MemoryDirectoryEntry[],
  query: string,
): MemoryDirectoryEntry[] {
  const needle = normalizeSearchText(query.trim());
  if (!needle) return [...entries];
  const includesNeedle = (value: string | null | undefined) =>
    normalizeSearchText(value ?? '').includes(needle);
  return entries.filter(entry =>
    includesNeedle(entry.projectName)
    || includesNeedle(entry.displayName)
    || includesNeedle(entry.memoryId)
    || entry.legacyMemoryIds.some(includesNeedle)
    || includesNeedle(entry.githubUrl)
    || includesNeedle(entry.lastDeviceName)
    || entry.devices.some(device => includesNeedle(device.deviceName)));
}

/**
 * 조회 실패를 사람이 다음 행동을 정할 수 있는 문구로 바꾼다.
 *
 * 모든 `portmgr_*` 테이블은 `authenticated` 에게만 권한을 주며 anon은 전면 차단한다.
 *
 * 화면 게이트가 localStorage 플래그(`portal_google_verified`)만 보고 통과시키므로
 * 세션이 만료돼도 앱은 그대로 렌더된다. 그때 쿼리는 anon 으로 나가고 42501(permission
 * denied)이 돌아온다. **세션 유무를 모른 채 "정책을 다시 실행하라"고 하면 멀쩡한 DB 를
 * 건드리게 만드는 오답이다** — 그래서 세션 상태를 받아 둘을 갈라 말한다.
 */
export function describeMemoryQueryFailure(error: unknown, hasSession?: boolean): string {
  const message = (error as { message?: string } | null)?.message ?? String(error);
  if (/permission denied|JWT|PGRST301|row-level security/i.test(message)) {
    if (hasSession === false) {
      return `${message}\n\n로그인 세션이 없어 익명(anon)으로 조회됐습니다. 모든 프로젝트·장기기억 데이터는 로그인한 사용자만 읽을 수 있습니다. 아래 버튼으로 다시 로그인하세요.`;
    }
    if (hasSession === true) {
      return `${message}\n\n로그인 세션은 있는데 거부됐습니다. 허용된 Google 계정인지와 최신 Supabase 마이그레이션 적용 여부를 확인하세요. 보안을 위해 RLS를 끄면 안 됩니다.`;
    }
    return `${message}\n\n이 테이블은 로그인한 사용자에게만 열립니다. 로그인 상태를 먼저 확인하세요.`;
  }
  if (/does not exist|schema cache|PGRST205/i.test(message)) {
    return `${message}\n\n장기기억 테이블이 아직 없습니다. 설정 마법사의 테이블 생성을 먼저 실행하세요.`;
  }
  return message;
}

/**
 * 프로젝트 행 하나에 붙일 기억을 고른다.
 *
 * `portmgr_ports` 에는 기억을 가리키는 열이 없다. 그래서 저장소 주소와 이름으로 잇는데,
 * **저장소가 먼저**다 — 이름은 바뀌어도 저장소는 그 프로젝트의 계보 키(`github_url`)이기
 * 때문이다(실측 2026-08-14: 이 기기 9개 중 저장소로 4개, 이름으로 4개가 더 붙어 8개 연결).
 *
 * 후보가 여럿이면 **고르지 않는다**. 틀린 ID 를 복사해 다른 기기의 기억에 합류시키면
 * 남의 기억 위에 이 프로젝트를 얹게 되므로, 애매할 때는 아무것도 보여주지 않는 편이 낫다.
 */
export function matchMemoryForProject(
  entries: readonly MemoryDirectoryEntry[],
  project: { name?: string | null; githubUrl?: string | null; memoryId?: string | null },
): MemoryDirectoryEntry | null {
  // 행이 ID 를 직접 들고 있으면 추측하지 않는다 — 앱이 프로젝트 폴더의
  // `.agent-memory/config.json` 에서 읽어 실은 값이다. 기억 대부분은 저장소가 없고
  // 폴더 이름은 바뀌므로, 간접 키는 이 값이 없을 때만 쓰는 폴백이다.
  const exact = (project.memoryId ?? '').trim();
  if (exact) {
    const byId = entries.find(entry => entry.memoryId === exact);
    // 목록(최근 N건)에 그 기억이 없을 수도 있다. 그때는 간접 키로 내려가지 않는다 —
    // ID 를 아는데 다른 기억을 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.
    return byId ?? null;
  }
  const repo = (project.githubUrl ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  if (repo) {
    const byRepo = entries.filter(entry =>
      (entry.githubUrl ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '') === repo);
    if (byRepo.length === 1) return byRepo[0]!;
    if (byRepo.length > 1) return null;
  }
  const name = (project.name ?? '').trim().toLowerCase();
  if (!name) return null;
  const byName = entries.filter(entry => entry.projectName.trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * 기억 목록을 두 소비자(프로젝트 행의 칩 · 장기기억 탭)가 **공유**한다.
 *
 * 예전에는 각자 1,000행을 받았고, 각 컴포넌트가 마운트 직후와 `INITIAL_SESSION`
 * 콜백에서 두 번씩 쐈다. 같은 화면을 그리는 데 최대 4회가 나갔다.
 * in-flight 프라미스를 재사용하면 그 중복이 저절로 접힌다.
 */
export const MEMORY_LIST_COLUMNS =
  'id, memory_id, project_name, github_url, device_id, device_name, content_hash, created_at';
export const MEMORY_DEVICE_COLUMNS =
  'memory_id, device_id, device_name, platform, revision_id, content_hash, last_synced_at, last_seen_at, source_path, git_head_sha, git_branch, git_remote_url, git_upstream_sha, git_ahead, git_behind, git_dirty, git_commit_at, git_checked_at, git_fetch_ok, git_fetch_error';
export const DEVICE_IDENTITY_ALIAS_COLUMNS = 'alias_device_id, canonical_device_id, linked_at';
export const PHYSICAL_DEVICE_COLUMNS = 'id, name, last_push_at';
export const REMOTE_MEMORY_DEVICE_COLUMNS = 'device_id,display_name,platform,environment_kind,last_seen_at,revoked_at';
export const REMOTE_MEMORY_PROJECT_COLUMNS = 'device_id,project_path,memory_id,git_remote_url,git_head_sha,git_branch,git_dirty,present,last_observed_at,telegram_chat_id,telegram_thread_id';
export const MEMORY_DEVICE_RETIREMENT_COLUMNS = 'memory_id, device_id, retired_at';
export const MEMORY_TRASH_COLUMNS = 'memory_id, trashed_at';
export const MEMORY_ALIAS_COLUMNS = 'alias_memory_id, canonical_memory_id, merge_id, all_known_devices_migrated_at';
export const MEMORY_LABEL_COLUMNS = 'memory_id, display_name, updated_at';
export const MEMORY_MERGE_COLUMNS = 'id, target_memory_id, status, repository_strategy, repository_url, created_at';
export const MEMORY_MERGE_DEVICE_COLUMNS = 'merge_id, device_id, previous_memory_id, adopted_at';

/** 구형 DB에서 head RPC가 없을 때만 쓰는 최근 리비전 호환 윈도우. */
export const MEMORY_REVISION_WINDOW = 1000;
/** head는 기억당 한 행이므로, 리비전 전체가 아닌 이 페이지를 끝까지 읽는다. */
export const MEMORY_HEAD_PAGE_SIZE = 250;

export type MemoryDirectorySource = 'heads' | 'legacy-revisions';

export interface MemoryDirectoryLoad {
  entries: MemoryDirectoryEntry[];
  /** 활성 데스크톱과 활성 원격 호스트를 합친 물리 단말 필터 목록. */
  deviceFilters: MemoryDeviceFilter[];
  /** 정상은 heads이며, 구형 DB에서 RPC가 없을 때만 legacy-revisions이다. */
  source: MemoryDirectorySource;
  /** legacy-revisions 호환 윈도우를 가득 채웠는가 — 잘렸을 수 있다는 뜻이다. */
  windowFull: boolean;
}

interface CacheSlot {
  at: number;
  inFlight: Promise<MemoryDirectoryLoad> | null;
  value: MemoryDirectoryLoad | null;
}

const cache = new Map<string, CacheSlot>();
/** 짧게 잡는다 — 목적은 "같은 화면을 그리는 동시 요청 합치기"이지 오래 캐싱하는 것이 아니다. */
const TTL_MS = 30_000;

/** supabase 쿼리 빌더는 Promise 가 아니라 thenable 이라 PromiseLike 로 받는다. */
type MemoryQueryResult = { data: unknown; error: unknown };
type MemoryQuery = () => PromiseLike<MemoryQueryResult>;
export type MemoryHeadPageQuery = (
  afterMemoryId: string | null,
  limit: number,
) => PromiseLike<MemoryQueryResult>;

/**
 * PostgREST가 실제로 head RPC를 모를 때만 구형 리비전 조회로 후퇴한다.
 * 권한·RLS·네트워크 오류를 스키마 부재로 오인하면 장애와 보안 문제를 숨겨 버린다.
 */
export function isMemoryHeadPageRpcMissing(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
  const message = [value?.message, value?.details, value?.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  if (!/portmgr_list_project_memory_head_page/i.test(message)) return false;
  return code === 'PGRST202'
    || code === '42883'
    || /could not find (?:the )?function|function .* does not exist|schema cache/i.test(message);
}

/**
 * immutable PK(memory_id) cursor로 head 페이지를 모두 읽는다.
 * updated_at을 cursor로 쓰면 로딩 중 Push된 기억이 페이지 위로 이동해 영구 누락될 수 있다.
 */
export async function loadAllMemoryHeadRows(
  query: MemoryHeadPageQuery,
  pageSize = MEMORY_HEAD_PAGE_SIZE,
): Promise<MemoryRevisionRow[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('장기기억 head 페이지 크기가 올바르지 않습니다.');
  const rows: MemoryRevisionRow[] = [];
  let afterMemoryId: string | null = null;
  for (;;) {
    const { data, error } = await query(afterMemoryId, pageSize);
    if (error) throw error;
    if (data != null && !Array.isArray(data)) {
      throw new Error('장기기억 head RPC가 행 배열을 반환하지 않았습니다.');
    }
    const page = (data ?? []) as MemoryRevisionRow[];
    if (page.length === 0) break;

    let previousMemoryId: string | null = afterMemoryId;
    for (const row of page) {
      const memoryId = (row?.memory_id ?? '').trim();
      const revisionId = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!memoryId || !revisionId) {
        throw new Error('장기기억 head RPC가 필수 id 열을 반환하지 않았습니다.');
      }
      if (previousMemoryId !== null && memoryId <= previousMemoryId) {
        throw new Error('장기기억 head RPC가 memory_id 오름차순 계약을 지키지 않았습니다.');
      }
      previousMemoryId = memoryId;
      rows.push(row);
    }

    afterMemoryId = previousMemoryId;
    if (page.length < pageSize) break;
  }
  return rows;
}

/**
 * @param key    `url::anonKey` — 프로젝트가 바뀌면 캐시도 갈린다.
 * @param query  head RPC가 없는 구형 DB용 최근 리비전 호환 조회.
 * @param force  「새로고침」 버튼만 쓴다.
 */
export async function loadMemoryDirectory(
  key: string,
  query: MemoryQuery,
  options: {
    force?: boolean;
    now?: number;
    headPageQuery?: MemoryHeadPageQuery;
    deviceQuery?: MemoryQuery;
    aliasQuery?: MemoryQuery;
    labelQuery?: MemoryQuery;
    mergeQuery?: MemoryQuery;
    mergeDeviceQuery?: MemoryQuery;
    retirementQuery?: MemoryQuery;
    deviceIdentityQuery?: MemoryQuery;
    physicalDeviceQuery?: MemoryQuery;
    remoteDeviceQuery?: MemoryQuery;
    remoteProjectQuery?: MemoryQuery;
    trashQuery?: MemoryQuery;
  } = {},
): Promise<MemoryDirectoryLoad> {
  const now = options.now ?? Date.now();
  const slot = cache.get(key);
  if (!options.force && slot) {
    if (slot.inFlight) return slot.inFlight;
    if (slot.value && now - slot.at < TTL_MS) return slot.value;
  }
  const inFlight = (async () => {
    const revisionResultPromise: Promise<MemoryQueryResult & { source: MemoryDirectorySource }> = options.headPageQuery
      ? loadAllMemoryHeadRows(options.headPageQuery)
        .then(data => ({ data, error: null, source: 'heads' as const }))
        .catch(async error => {
          if (!isMemoryHeadPageRpcMissing(error)) throw error;
          const legacy = await query();
          return { ...legacy, source: 'legacy-revisions' as const };
        })
      : Promise.resolve(query()).then(result => ({ ...result, source: 'legacy-revisions' as const }));
    const [revisionResult, deviceResult, aliasResult, labelResult, mergeResult, mergeDeviceResult, retirementResult, deviceIdentityResult, physicalDeviceResult, remoteDeviceResult, remoteProjectResult, trashResult] = await Promise.all([
      revisionResultPromise,
      options.deviceQuery ? options.deviceQuery() : Promise.resolve({ data: [], error: null }),
      options.aliasQuery ? options.aliasQuery() : Promise.resolve({ data: [], error: null }),
      options.labelQuery ? options.labelQuery() : Promise.resolve({ data: [], error: null }),
      options.mergeQuery ? options.mergeQuery() : Promise.resolve({ data: [], error: null }),
      options.mergeDeviceQuery ? options.mergeDeviceQuery() : Promise.resolve({ data: [], error: null }),
      options.retirementQuery ? options.retirementQuery() : Promise.resolve({ data: [], error: null }),
      options.deviceIdentityQuery ? options.deviceIdentityQuery() : Promise.resolve({ data: [], error: null }),
      options.physicalDeviceQuery ? options.physicalDeviceQuery() : Promise.resolve({ data: [], error: null }),
      options.remoteDeviceQuery ? options.remoteDeviceQuery() : Promise.resolve({ data: [], error: null }),
      options.remoteProjectQuery ? options.remoteProjectQuery() : Promise.resolve({ data: [], error: null }),
      options.trashQuery ? options.trashQuery() : Promise.resolve({ data: [], error: null }),
    ]);
    const { data, error, source } = revisionResult;
    if (error) throw error;
    // 신규 단말 현황 테이블이 아직 없는 배포는 리비전 기반 추정으로 계속 열린다.
    const remoteRows = remoteDeviceResult.error || remoteProjectResult.error
      ? []
      : remoteMemoryDeviceStatusRows(
          (remoteDeviceResult.data ?? []) as RemoteMemoryDeviceRow[],
          (remoteProjectResult.data ?? []) as RemoteMemoryProjectRow[],
        );
    const deviceRows = [
      ...(deviceResult.error ? [] : (deviceResult.data ?? []) as MemoryDeviceStatusRow[]),
      ...remoteRows,
    ];
    const rows = (data ?? []) as MemoryRevisionRow[];
    const deviceIdentityRows = deviceIdentityResult.error ? [] : (deviceIdentityResult.data ?? []) as DeviceIdentityAliasRow[];
    const physicalDeviceRows = physicalDeviceResult.error ? [] : (physicalDeviceResult.data ?? []) as PhysicalDeviceRow[];
    const remoteDeviceRows = remoteDeviceResult.error ? [] : (remoteDeviceResult.data ?? []) as RemoteMemoryDeviceRow[];
    const entries = buildMemoryDirectory(
        rows,
        deviceRows,
        aliasResult.error ? [] : (aliasResult.data ?? []) as MemoryAliasRow[],
        labelResult.error ? [] : (labelResult.data ?? []) as MemoryLabelRow[],
        mergeResult.error ? [] : (mergeResult.data ?? []) as MemoryMergeRow[],
        mergeDeviceResult.error ? [] : (mergeDeviceResult.data ?? []) as MemoryMergeDeviceRow[],
        retirementResult.error ? [] : (retirementResult.data ?? []) as MemoryDeviceRetirementRow[],
        deviceIdentityRows,
        physicalDeviceRows,
        trashResult.error ? [] : (trashResult.data ?? []) as MemoryTrashRow[],
      );
    return {
      entries,
      deviceFilters: buildMemoryDeviceFilters(entries, deviceIdentityRows, physicalDeviceRows, remoteDeviceRows),
      source,
      windowFull: source === 'legacy-revisions' && rows.length >= MEMORY_REVISION_WINDOW,
    };
  })();
  cache.set(key, { at: now, inFlight, value: slot?.value ?? null });
  try {
    const value = await inFlight;
    cache.set(key, { at: now, inFlight: null, value });
    return value;
  } catch (error) {
    // 실패는 캐싱하지 않는다 — 다음 시도가 즉시 다시 나가야 한다.
    cache.delete(key);
    throw error;
  }
}

/** 테스트 전용 — 캐시를 비운다. */
export function resetMemoryDirectoryCache(): void {
  cache.clear();
}
