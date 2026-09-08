export interface PortalDesktopDeviceRecord {
  id: string;
  name: string | null;
  last_push_at: string | null;
}

export interface PortalDesktopProjectRecord {
  id?: string | null;
  device_id: string | null;
  device_name?: string | null;
  name?: string | null;
}

export interface PortalWorkspaceDeviceRecord {
  device_id: string | null;
  name?: string | null;
  path?: string | null;
}

export interface PortalDeviceIdentityAliasRecord {
  alias_device_id: string | null;
  canonical_device_id: string | null;
}

export interface PortalDesktopInventoryItem {
  id: string;
  name: string;
  last_push_at: string | null;
  sourceIds: string[];
  projectCount: number;
  projectNames: string[];
}

export interface PortalRemoteDeviceRecord {
  device_id: string;
  display_name: string | null;
  environment_kind: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface PortalRemoteProjectRecord {
  device_id: string;
  project_name: string | null;
  present: boolean | null;
}

export interface PortalRemoteInventoryItem extends PortalDesktopInventoryItem {
  kind: 'remote';
  environmentLabel: string;
}

export function portalRemoteEnvironmentLabel(value: string | null): string {
  return ({
    aws: 'AWS Ubuntu',
    linux: 'Linux 서버',
    cloud: '클라우드',
    container: '컨테이너',
    wsl: 'Windows WSL',
  } as Record<string, string>)[value ?? ''] ?? '원격 서버';
}

function resolveDeviceId(id: string, aliases: ReadonlyMap<string, string>): string {
  let current = id;
  const seen = new Set<string>();
  for (let depth = 0; depth < 20; depth += 1) {
    const next = aliases.get(current);
    if (!next || seen.has(next)) return current;
    seen.add(current);
    current = next;
  }
  return current;
}

function latestTimestamp(values: readonly (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => !!value).sort().at(-1) ?? null;
}

/**
 * 배포 포털의 데스크톱 인벤토리는 portmgr_devices 한 테이블의 복사본이 아니다.
 * 재설치된 같은 물리 단말은 여러 ID의 이력을 유지하므로 별칭을 canonical ID로 접고,
 * 모든 과거 ID의 프로젝트를 한 호스트 아래에서 합쳐 보여준다.
 */
export function buildPortalDesktopInventory(input: {
  devices: readonly PortalDesktopDeviceRecord[];
  projects: readonly PortalDesktopProjectRecord[];
  workspaceRoots?: readonly PortalWorkspaceDeviceRecord[];
  aliases?: readonly PortalDeviceIdentityAliasRecord[];
}): PortalDesktopInventoryItem[] {
  const aliasMap = new Map((input.aliases ?? []).flatMap(row => {
    const alias = (row.alias_device_id ?? '').trim();
    const canonical = (row.canonical_device_id ?? '').trim();
    return alias && canonical && alias !== canonical ? [[alias, canonical] as const] : [];
  }));

  // 활성 물리 단말의 정본은 portmgr_devices다. ports/workspace rows는 단말을
  // 풍부하게 설명하는 프로젝트 이력이지, 그 자체로 새 물리 단말을 등록하는 신호가
  // 아니다. 삭제된 예전 단말 ID의 프로젝트가 남아 있어도 선택 목록에 되살리지 않는다.
  const allIds = new Set<string>();
  for (const row of input.devices) if (row.id?.trim()) allIds.add(row.id.trim());

  // 등록된 ID가 alias인 경우 canonical 대표 ID까지 포함한다. 반대로 아무 등록 단말과도
  // 연결되지 않은 고아 alias는 활성 목록에 올리지 않는다.
  for (const id of [...allIds]) {
    allIds.add(resolveDeviceId(id, aliasMap));
  }
  const activeCanonicalIds = new Set([...allIds].map(id => resolveDeviceId(id, aliasMap)));
  for (const row of input.aliases ?? []) {
    const alias = row.alias_device_id?.trim();
    if (alias && activeCanonicalIds.has(resolveDeviceId(alias, aliasMap))) allIds.add(alias);
  }

  const groups = new Map<string, string[]>();
  for (const id of allIds) {
    const canonical = resolveDeviceId(id, aliasMap);
    const group = groups.get(canonical) ?? [];
    group.push(id);
    groups.set(canonical, group);
  }

  return [...groups.entries()].map(([canonical, ids]) => {
    const sourceIds = [...new Set([canonical, ...ids])];
    const idSet = new Set(sourceIds);
    const deviceRows = input.devices.filter(row => idSet.has(row.id));
    const projectRows = input.projects.filter(row => !!row.device_id && idSet.has(row.device_id));
    const rootRows = (input.workspaceRoots ?? []).filter(row => !!row.device_id && idSet.has(row.device_id));
    const canonicalName = deviceRows.find(row => row.id === canonical)?.name?.trim();
    const latestNamedDevice = [...deviceRows]
      .filter(row => row.name?.trim())
      .sort((a, b) => (b.last_push_at ?? '').localeCompare(a.last_push_at ?? ''))[0];
    const name = canonicalName
      || latestNamedDevice?.name?.trim()
      || projectRows.find(row => row.device_name?.trim())?.device_name?.trim()
      || rootRows.find(row => row.path?.startsWith('__device__') && row.name?.trim())?.name?.trim()
      || canonical.slice(0, 8);
    const projectNames = [...new Set(projectRows.map(row => row.name?.trim()).filter((value): value is string => !!value))]
      .sort((a, b) => a.localeCompare(b, 'ko'));
    return {
      id: canonical,
      name,
      last_push_at: latestTimestamp(deviceRows.map(row => row.last_push_at)),
      sourceIds,
      projectCount: projectRows.length,
      projectNames,
    };
  }).sort((a, b) => (b.last_push_at ?? '').localeCompare(a.last_push_at ?? '') || a.name.localeCompare(b.name, 'ko'));
}

/** 활성 원격 호스트를 프로젝트 선택 목록에 맞는 동일한 카드 모델로 바꾼다. */
export function buildPortalRemoteInventory(input: {
  devices: readonly PortalRemoteDeviceRecord[];
  projects: readonly PortalRemoteProjectRecord[];
}): PortalRemoteInventoryItem[] {
  return input.devices
    .filter(device => !!device.device_id?.trim() && !device.revoked_at)
    .map(device => {
      const id = device.device_id.trim();
      const projectNames = [...new Set(input.projects
        .filter(project => project.device_id === id && project.present !== false)
        .map(project => project.project_name?.trim())
        .filter((name): name is string => !!name))]
        .sort((a, b) => a.localeCompare(b, 'ko'));
      return {
        id,
        name: device.display_name?.trim() || id.slice(0, 8),
        last_push_at: device.last_seen_at,
        sourceIds: [id],
        projectCount: projectNames.length,
        projectNames,
        kind: 'remote' as const,
        environmentLabel: portalRemoteEnvironmentLabel(device.environment_kind),
      };
    })
    .sort((a, b) => (b.last_push_at ?? '').localeCompare(a.last_push_at ?? '') || a.name.localeCompare(b.name, 'ko'));
}
