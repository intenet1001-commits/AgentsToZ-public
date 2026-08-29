import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildMemoryDirectory,
  buildMemoryDeviceFilters,
  describeMemoryQueryFailure,
  filterMemoryDirectory,
  filterMemoryDirectoryByRepository,
  isMemoryOnlyDirectoryEntry,
  isMemoryHeadPageRpcMissing,
  loadAllMemoryHeadRows,
  loadMemoryDirectory,
  matchMemoryForProject,
  memoryDeviceGitState,
  memoryDeviceIdentityWarning,
  memoryRepositoryGuidance,
  resetMemoryDirectoryCache,
  type MemoryRevisionRow,
  type MemoryDeviceStatusRow,
} from '../src/projectMemoryDirectory';

const row = (over: Partial<MemoryRevisionRow> & { memory_id: string; created_at: string }): MemoryRevisionRow => ({
  id: `${over.memory_id}-${over.created_at}`,
  project_name: '프로젝트',
  github_url: null,
  device_id: 'device-a',
  device_name: 'MacBook',
  content_hash: 'hash',
  ...over,
});

describe('head 기반 목록 페이징', () => {
  test('memory_id keyset으로 모든 페이지를 읽고 고정 1000 revision window를 쓰지 않는다', async () => {
    const source = Array.from({ length: 1001 }, (_, index) => row({
      memory_id: `m-${String(index).padStart(4, '0')}`,
      created_at: '2026-08-01T00:00:00Z',
    }));
    const cursors: Array<string | null> = [];
    const loaded = await loadAllMemoryHeadRows(async (afterMemoryId, limit) => {
      cursors.push(afterMemoryId);
      return {
        data: source.filter(item => afterMemoryId === null || item.memory_id! > afterMemoryId).slice(0, limit),
        error: null,
      };
    }, 250);

    expect(loaded).toHaveLength(1001);
    expect(loaded.at(-1)?.memory_id).toBe('m-1000');
    expect(cursors).toEqual([null, 'm-0249', 'm-0499', 'm-0749', 'm-0999']);
  });

  test('RPC의 오름차순 계약이 깨지면 무한 루프로 넘어가지 않고 실패한다', async () => {
    await expect(loadAllMemoryHeadRows(async () => ({
      data: [
        row({ memory_id: 'm2', created_at: '2026-08-02T00:00:00Z' }),
        row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z' }),
      ],
      error: null,
    }), 2)).rejects.toThrow(/memory_id 오름차순/);
  });

  test('RPC 부재만 구형 호환 조회 대상이다', () => {
    expect(isMemoryHeadPageRpcMissing({
      code: 'PGRST202',
      message: 'Could not find the function public.portmgr_list_project_memory_head_page in the schema cache',
    })).toBe(true);
    expect(isMemoryHeadPageRpcMissing({
      code: '42501',
      message: 'permission denied for function portmgr_list_project_memory_head_page',
    })).toBe(false);
    expect(isMemoryHeadPageRpcMissing(new Error('network unreachable'))).toBe(false);
  });

  test('RPC가 없으면 한 번만 legacy revisions로 후퇴하고 출처를 표시한다', async () => {
    resetMemoryDirectoryCache();
    let legacyCalls = 0;
    const loaded = await loadMemoryDirectory('head-fallback', async () => {
      legacyCalls += 1;
      return { data: [row({ memory_id: 'legacy', created_at: '2026-08-01T00:00:00Z' })], error: null };
    }, {
      headPageQuery: async () => ({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.portmgr_list_project_memory_head_page in the schema cache',
        },
      }),
    });

    expect(legacyCalls).toBe(1);
    expect(loaded.source).toBe('legacy-revisions');
    expect(loaded.entries.map(entry => entry.memoryId)).toEqual(['legacy']);
  });

  test('권한 오류를 legacy 조회로 숨기지 않는다', async () => {
    resetMemoryDirectoryCache();
    let legacyCalls = 0;
    const loading = loadMemoryDirectory('head-permission', async () => {
      legacyCalls += 1;
      return { data: [], error: null };
    }, {
      headPageQuery: async () => ({
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for function portmgr_list_project_memory_head_page',
        },
      }),
    });

    await expect(loading).rejects.toEqual(expect.objectContaining({ code: '42501' }));
    expect(legacyCalls).toBe(0);
  });

  test('head를 모두 모은 뒤 alias를 canonical 카드 하나로 접는다', async () => {
    resetMemoryDirectoryCache();
    const heads = [
      row({ memory_id: 'current', created_at: '2026-08-02T00:00:00Z', content_hash: 'current' }),
      row({ memory_id: 'old', created_at: '2026-08-01T00:00:00Z', content_hash: 'old' }),
    ];
    const loaded = await loadMemoryDirectory('head-alias-fold', async () => ({ data: [], error: null }), {
      headPageQuery: async afterMemoryId => ({
        data: heads.filter(item => afterMemoryId === null || item.memory_id! > afterMemoryId),
        error: null,
      }),
      aliasQuery: async () => ({
        data: [{ alias_memory_id: 'old', canonical_memory_id: 'current', merge_id: 'merge', all_known_devices_migrated_at: null }],
        error: null,
      }),
    });

    expect(loaded.source).toBe('heads');
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toEqual(expect.objectContaining({ memoryId: 'current', legacyMemoryIds: ['old'] }));
  });

  test('두 소비자가 동시에 요청해도 head 페이지 in-flight를 한 번만 실행한다', async () => {
    resetMemoryDirectoryCache();
    let pageCalls = 0;
    const options = {
      headPageQuery: async () => {
        pageCalls += 1;
        await Promise.resolve();
        return { data: [row({ memory_id: 'shared', created_at: '2026-08-01T00:00:00Z' })], error: null };
      },
    };
    const legacy = async () => ({ data: [], error: null });
    const [first, second] = await Promise.all([
      loadMemoryDirectory('head-shared-flight', legacy, options),
      loadMemoryDirectory('head-shared-flight', legacy, options),
    ]);

    expect(pageCalls).toBe(1);
    expect(first).toBe(second);
    expect(first.source).toBe('heads');
  });
});

describe('기억 목록 접기', () => {
  test('한 기억의 여러 리비전을 하나로 접고 최신 값을 쓴다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '옛 이름', device_name: 'iMac', device_id: 'device-b' }),
      row({ memory_id: 'm1', created_at: '2026-08-10T00:00:00Z', project_name: '새 이름', device_name: 'MacBook' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.projectName).toBe('새 이름');
    expect(entries[0]!.lastDeviceName).toBe('MacBook');
    expect(entries[0]!.revisionsInWindow).toBe(2);
    expect(entries[0]!.deviceCountInWindow).toBe(2);
  });

  test('입력 순서가 달라도 같은 결과가 나온다', () => {
    const rows = [
      row({ memory_id: 'm1', created_at: '2026-08-10T00:00:00Z', project_name: '새 이름' }),
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '옛 이름' }),
    ];
    expect(buildMemoryDirectory(rows)).toEqual(buildMemoryDirectory([...rows].reverse()));
  });

  test('최근 갱신 순으로 정렬한다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      row({ memory_id: 'new', created_at: '2026-08-14T00:00:00Z' }),
    ]);
    expect(entries.map(e => e.memoryId)).toEqual(['new', 'old']);
  });

  test('휴지통은 계보를 삭제하지 않고 canonical 기억에 가역 상태만 표시한다', () => {
    const entries = buildMemoryDirectory(
      [row({ memory_id: 'old', created_at: '2026-08-01T00:00:00Z' })],
      [],
      [{ alias_memory_id: 'old', canonical_memory_id: 'current', merge_id: 'merge', all_known_devices_migrated_at: null }],
      [], [], [], [], [], [],
      [{ memory_id: 'old', trashed_at: '2026-08-24T00:00:00Z' }],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({ memoryId: 'current', legacyMemoryIds: ['old'], trashedAt: '2026-08-24T00:00:00Z' }));
  });

  test('통합 단말 필터는 데스크톱 3대와 활성 AWS Ubuntu 1대를 함께 보여준다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', device_id: 'mac-current' }),
      row({ memory_id: 'm2', created_at: '2026-08-02T00:00:00Z', device_id: 'aws-current', device_name: 'Hermes AWS' }),
    ], [
      { memory_id: 'm2', device_id: 'aws-current', device_name: 'Hermes AWS', platform: 'aws', revision_id: null, content_hash: null, last_synced_at: null, last_seen_at: '2026-08-24T00:00:00Z' },
    ], [], [], [], [], [], [
      { alias_device_id: 'mac-old', canonical_device_id: 'mac-current', linked_at: '2026-08-24T00:00:00Z' },
    ]);
    const filters = buildMemoryDeviceFilters(entries, [
      { alias_device_id: 'mac-old', canonical_device_id: 'mac-current', linked_at: '2026-08-24T00:00:00Z' },
    ], [
      { id: 'work-mac', name: '회사에서받은맥북', last_push_at: null },
      { id: 'gram', name: '집에있는그램', last_push_at: null },
      { id: 'mac-current', name: '최천성 MacBook Pro (로컬)', last_push_at: null },
    ], [
      { device_id: 'aws-current', display_name: 'Hermes AWS', platform: 'linux', environment_kind: 'aws', last_seen_at: null, revoked_at: null },
      { device_id: 'revoked', display_name: '예전 서버', platform: 'linux', environment_kind: 'aws', last_seen_at: null, revoked_at: '2026-08-23T00:00:00Z' },
    ]);
    expect(filters).toHaveLength(4);
    expect(filters.find(filter => filter.deviceId === 'mac-current')).toEqual(expect.objectContaining({ legacyDeviceIds: ['mac-old'], memoryCount: 1 }));
    expect(filters.find(filter => filter.deviceId === 'aws-current')).toEqual(expect.objectContaining({ deviceName: 'Hermes AWS', platform: 'aws', kind: 'remote', memoryCount: 1 }));
  });

  // ID 를 건네는 것이 이 화면의 목적이다. 이름이 비었다고 목록에서 빠지면 건넬 방법이 없어진다.
  test('이름이 비어도 목록에서 사라지지 않는다', () => {
    const entries = buildMemoryDirectory([row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '  ' })]);
    expect(entries[0]!.projectName).toBe('(이름 없음)');
  });

  test('memory_id 가 없는 줄은 건너뛴다 — 가리킬 대상이 없다', () => {
    expect(buildMemoryDirectory([
      row({ memory_id: '', created_at: '2026-08-01T00:00:00Z' }),
      { ...row({ memory_id: 'x', created_at: '2026-08-01T00:00:00Z' }), memory_id: null },
    ])).toEqual([]);
  });

  test('시각이 없거나 깨진 줄은 더 오래된 것으로 다루고 버리지 않는다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'm1', created_at: 'not-a-date', project_name: '깨진 시각' }),
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '정상' }),
    ]);
    expect(entries[0]!.projectName).toBe('정상');
    expect(entries[0]!.revisionsInWindow).toBe(2);
  });

  test('저장소가 있는 기억과 없는 기억을 모두 담는다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'repo', created_at: '2026-08-02T00:00:00Z', github_url: 'https://github.com/o/r' }),
      row({ memory_id: 'norepo', created_at: '2026-08-01T00:00:00Z', github_url: '   ' }),
    ]);
    expect(entries.find(e => e.memoryId === 'repo')!.githubUrl).toBe('https://github.com/o/r');
    expect(entries.find(e => e.memoryId === 'norepo')!.githubUrl).toBeNull();
  });

  test('상태 갱신에서 단말이 보고한 유일한 GitHub origin을 저장소로 자동 채택한다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'detected', created_at: '2026-08-24T00:00:00Z', github_url: null }),
    ], [{
      memory_id: 'detected', device_id: 'mac', device_name: 'Mac', platform: 'darwin',
      revision_id: 'detected-2026-08-24T00:00:00Z', content_hash: 'hash',
      last_synced_at: '2026-08-24T00:00:00Z', last_seen_at: '2026-08-24T00:00:00Z',
      git_remote_url: 'git@github.com:example-owner/example-memory-repo.git',
    }]);

    expect(entries[0]!.githubUrl).toBe('https://github.com/example-owner/example-memory-repo');
  });

  test('단말들이 서로 다른 저장소를 보고하면 자동으로 하나를 고르지 않는다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'conflict', created_at: '2026-08-24T00:00:00Z', github_url: null }),
    ], [
      {
        memory_id: 'conflict', device_id: 'mac', device_name: 'Mac', platform: 'darwin',
        revision_id: 'head', content_hash: 'hash', last_synced_at: null, last_seen_at: '2026-08-24T00:00:00Z',
        git_remote_url: 'https://github.com/acme/one.git',
      },
      {
        memory_id: 'conflict', device_id: 'win', device_name: 'Win', platform: 'win32',
        revision_id: 'head', content_hash: 'hash', last_synced_at: null, last_seen_at: '2026-08-24T00:00:00Z',
        git_remote_url: 'https://github.com/acme/two.git',
      },
    ]);

    expect(entries[0]!.githubUrl).toBeNull();
  });

  test('리비전에 명시된 저장소는 단말 자동 감지보다 우선한다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'explicit', created_at: '2026-08-24T00:00:00Z', github_url: 'https://github.com/acme/canonical' }),
    ], [{
      memory_id: 'explicit', device_id: 'mac', device_name: 'Mac', platform: 'darwin',
      revision_id: 'head', content_hash: 'hash', last_synced_at: null, last_seen_at: '2026-08-24T00:00:00Z',
      git_remote_url: 'https://github.com/acme/local-fork.git',
    }]);

    expect(entries[0]!.githubUrl).toBe('https://github.com/acme/canonical');
  });

  test('단말별 마지막 확인 버전을 최신 head와 비교한다', () => {
    const revisions = [
      row({ memory_id: 'm1', id: 'rev-old', created_at: '2026-08-01T00:00:00Z', content_hash: 'hash-old', device_id: 'mac-a', device_name: 'MacBook' }),
      row({ memory_id: 'm1', id: 'rev-head', created_at: '2026-08-10T00:00:00Z', content_hash: 'hash-head', device_id: 'aws', device_name: 'AWS' }),
    ];
    const devices: MemoryDeviceStatusRow[] = [
      { memory_id: 'm1', device_id: 'mac-a', device_name: 'MacBook Pro', platform: 'darwin', revision_id: 'rev-head', content_hash: 'hash-head', last_synced_at: '2026-08-11T00:00:00Z', last_seen_at: '2026-08-11T00:00:00Z' },
      { memory_id: 'm1', device_id: 'gram', device_name: 'Gram', platform: 'win32', revision_id: 'rev-old', content_hash: 'hash-old', last_synced_at: '2026-08-02T00:00:00Z', last_seen_at: '2026-08-09T00:00:00Z' },
    ];

    const entry = buildMemoryDirectory(revisions, devices)[0]!;
    expect(entry.headRevisionId).toBe('rev-head');
    expect(entry.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'mac-a', deviceName: 'MacBook Pro', platform: 'darwin', inSync: true, statusSource: 'confirmed' }),
      expect.objectContaining({ deviceId: 'gram', deviceName: 'Gram', platform: 'win32', inSync: false, statusSource: 'confirmed' }),
      expect.objectContaining({ deviceId: 'aws', deviceName: 'AWS', inSync: true, statusSource: 'revision' }),
    ]));
    expect(entry.syncedDeviceCount).toBe(2);
    expect(entry.staleDeviceCount).toBe(1);
  });

  test('동일 단말 상태가 여러 행이면 last_seen_at 기준 최신 행만 쓴다', () => {
    const revisions = [row({ memory_id: 'm1', id: 'rev-head', created_at: '2026-08-10T00:00:00Z', content_hash: 'head', device_id: 'mac' })];
    const devices: MemoryDeviceStatusRow[] = [
      { memory_id: 'm1', device_id: 'mac', device_name: 'old name', platform: 'darwin', revision_id: 'rev-old', content_hash: 'old', last_synced_at: null, last_seen_at: '2026-08-01T00:00:00Z' },
      { memory_id: 'm1', device_id: 'mac', device_name: 'new name', platform: 'darwin', revision_id: 'rev-head', content_hash: 'head', last_synced_at: '2026-08-10T00:00:00Z', last_seen_at: '2026-08-10T00:00:00Z' },
    ];
    expect(buildMemoryDirectory(revisions, devices)[0]!.devices)
      .toEqual([expect.objectContaining({ deviceName: 'new name', inSync: true })]);
  });

  test('최신 Push의 이름이 비어도 같은 단말의 과거 AWS 이름을 보존한다', () => {
    const revisions = [
      row({ memory_id: 'm1', id: 'aws-old', created_at: '2026-08-12T00:00:00Z', device_id: 'aws-id', device_name: 'Hermes AWS', content_hash: 'old' }),
      row({ memory_id: 'm1', id: 'aws-head', created_at: '2026-08-22T00:00:00Z', device_id: 'aws-id', device_name: null, content_hash: 'head' }),
    ];
    const entry = buildMemoryDirectory(revisions)[0]!;
    expect(entry.lastDeviceName).toBe('Hermes AWS');
    expect(entry.devices).toEqual([
      expect.objectContaining({ deviceId: 'aws-id', deviceName: 'Hermes AWS', revisionId: 'aws-head', inSync: true }),
    ]);
  });

  test('확정 상태의 이름이 비어도 리비전에서 확인한 단말 이름을 이어 쓴다', () => {
    const revisions = [
      row({ memory_id: 'm1', id: 'head', created_at: '2026-08-22T00:00:00Z', device_id: 'aws-id', device_name: 'Hermes AWS', content_hash: 'head' }),
    ];
    const devices: MemoryDeviceStatusRow[] = [{
      memory_id: 'm1', device_id: 'aws-id', device_name: null, platform: 'linux', revision_id: 'head',
      content_hash: 'head', last_synced_at: '2026-08-23T00:00:00Z', last_seen_at: '2026-08-23T00:00:00Z',
    }];
    expect(buildMemoryDirectory(revisions, devices)[0]!.devices).toEqual([
      expect.objectContaining({ deviceName: 'Hermes AWS', platform: 'linux', statusSource: 'confirmed' }),
    ]);
  });

  test('장기기억 상태와 Git HEAD/원격 추적 상태를 같은 단말에 보존한다', () => {
    const revisions = [row({ memory_id: 'm1', id: 'head', created_at: '2026-08-22T00:00:00Z', device_id: 'mac', content_hash: 'memory-hash' })];
    const devices: MemoryDeviceStatusRow[] = [{
      memory_id: 'm1', device_id: 'mac', device_name: 'Mac', platform: 'darwin', revision_id: 'head',
      content_hash: 'memory-hash', last_synced_at: '2026-08-23T00:00:00Z', last_seen_at: '2026-08-23T00:00:00Z',
      git_head_sha: 'a'.repeat(40), git_branch: 'main', git_remote_url: 'https://github.com/acme/repo',
      git_upstream_sha: 'a'.repeat(40), git_ahead: 0, git_behind: 0, git_dirty: false,
      git_commit_at: '2026-08-22T23:00:00Z', git_checked_at: '2026-08-23T00:00:00Z',
    }];
    const device = buildMemoryDirectory(revisions, devices)[0]!.devices[0]!;
    expect(device).toEqual(expect.objectContaining({
      contentHash: 'memory-hash', lastSyncedAt: '2026-08-23T00:00:00Z',
      gitHeadSha: 'a'.repeat(40), gitBranch: 'main', gitAhead: 0, gitBehind: 0, gitDirty: false,
    }));
    expect(memoryDeviceGitState(device)).toBe('synced');
    expect(memoryDeviceGitState({ ...device, gitDirty: true })).toBe('dirty');
    expect(memoryDeviceGitState({ ...device, gitUpstreamSha: 'b'.repeat(40), gitAhead: 1, gitBehind: 2 })).toBe('diverged');
  });

  test('AWS 이름을 쓰던 ID가 macOS에서 재사용되면 합치지 말고 경고한다', () => {
    expect(memoryDeviceIdentityWarning('darwin', ['Hermes AWS'])).toBe(true);
    expect(memoryDeviceIdentityWarning('linux', ['회사 MacBook'])).toBe(true);
    expect(memoryDeviceIdentityWarning('darwin', ['최천성 MacBook Pro'])).toBe(false);
  });

  test('같은 물리 단말의 이전 설치 ID는 이력을 지우지 않고 현재 ID 아래에 접는다', () => {
    const revisions = [
      row({ memory_id: 'm1', id: 'old-rev', created_at: '2026-08-01T00:00:00Z', device_id: 'old-device', device_name: '옛 Mac', content_hash: 'old' }),
      row({ memory_id: 'm1', id: 'head', created_at: '2026-08-23T00:00:00Z', device_id: 'current-device', device_name: '현재 Mac', content_hash: 'head' }),
    ];
    const entry = buildMemoryDirectory(revisions, [], [], [], [], [], [], [{
      alias_device_id: 'old-device', canonical_device_id: 'current-device', linked_at: '2026-08-23T01:00:00Z',
    }])[0]!;
    expect(entry.devices).toHaveLength(1);
    expect(entry.devices[0]).toEqual(expect.objectContaining({
      deviceId: 'current-device',
      legacyDeviceIds: ['old-device'],
      deviceName: '현재 Mac',
    }));
    expect(entry.deviceCountInWindow).toBe(1);
  });

  test('일반 단말의 대표 이름과 다른 기억에서 확인된 플랫폼을 같은 물리 단말에 보강한다', () => {
    const revisions = [
      row({ memory_id: 'target', id: 'target-head', created_at: '2026-08-23T00:00:00Z', device_id: 'current-id', device_name: 'choecheonseongs-MacBook-Pro.local' }),
      row({ memory_id: 'platform-source', id: 'source-head', created_at: '2026-08-22T00:00:00Z', device_id: 'old-id', device_name: 'old hostname' }),
    ];
    const status: MemoryDeviceStatusRow[] = [{
      memory_id: 'platform-source', device_id: 'old-id', device_name: 'old hostname', platform: 'darwin',
      revision_id: 'source-head', content_hash: 'hash', last_synced_at: null, last_seen_at: '2026-08-23T01:00:00Z',
    }];
    const target = buildMemoryDirectory(revisions, status, [], [], [], [], [], [{
      alias_device_id: 'old-id', canonical_device_id: 'current-id', linked_at: '2026-08-23T01:00:00Z',
    }], [{
      id: 'old-id', name: '최천성 MacBook Pro (로컬)', last_push_at: '2026-08-03T00:00:00Z',
    }]).find(entry => entry.memoryId === 'target')!;

    expect(target.devices).toEqual([expect.objectContaining({
      deviceId: 'current-id', deviceName: '최천성 MacBook Pro (로컬)', platform: 'darwin',
    })]);
    expect(target.lastDeviceName).toBe('최천성 MacBook Pro (로컬)');
  });

  test('사용 종료 단말은 이력을 보존하지만 최신·확인 필요 집계에서는 제외한다', () => {
    const entry = buildMemoryDirectory([
      row({ memory_id: 'm1', id: 'head', created_at: '2026-08-10T00:00:00Z', content_hash: 'head', device_id: 'mac' }),
      row({ memory_id: 'm1', id: 'old', created_at: '2026-08-09T00:00:00Z', content_hash: 'old', device_id: 'gram', device_name: '옛 그램' }),
    ], [], [], [], [], [], [{
      memory_id: 'm1', device_id: 'gram', retired_at: '2026-08-11T00:00:00Z',
    }])[0]!;

    expect(entry.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'gram', retiredAt: '2026-08-11T00:00:00Z', inSync: false }),
    ]));
    expect(entry.syncedDeviceCount).toBe(1);
    expect(entry.staleDeviceCount).toBe(0);
    expect(entry.retiredDeviceCount).toBe(1);
  });

  test('합병 후 이전 ID를 숨기지 않고 하나의 계보 카드로 접고 단말 전환을 센다', () => {
    const entries = buildMemoryDirectory([
      row({ id: 'rev-a', memory_id: 'memory-a', content_hash: 'hash-a', device_id: 'device-a', device_name: 'Mac A', created_at: '2026-08-20T00:00:00Z' }),
      row({ id: 'rev-b', memory_id: 'memory-b', content_hash: 'hash-b', device_id: 'device-b', device_name: 'Gram B', created_at: '2026-08-21T00:00:00Z' }),
      row({ id: 'rev-c', memory_id: 'memory-c', content_hash: 'hash-c', device_id: null, device_name: '계보 합병', created_at: '2026-08-22T00:00:00Z' }),
    ], [], [
      { alias_memory_id: 'memory-a', canonical_memory_id: 'memory-c', merge_id: 'merge-1', all_known_devices_migrated_at: null },
      { alias_memory_id: 'memory-b', canonical_memory_id: 'memory-c', merge_id: 'merge-1', all_known_devices_migrated_at: null },
    ], [
      { memory_id: 'memory-c', display_name: '통합 고객포털 기억', updated_at: '2026-08-22T00:00:00Z' },
    ], [
      { id: 'merge-1', target_memory_id: 'memory-c', status: 'awaiting-devices', repository_strategy: 'new', repository_url: 'https://github.com/acme/c', created_at: '2026-08-22T00:00:00Z' },
    ], [
      { merge_id: 'merge-1', device_id: 'device-a', previous_memory_id: 'memory-a', adopted_at: null },
      { merge_id: 'merge-1', device_id: 'device-b', previous_memory_id: 'memory-b', adopted_at: '2026-08-23T00:00:00Z' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.memoryId).toBe('memory-c');
    expect(entries[0]?.displayName).toBe('통합 고객포털 기억');
    expect(entries[0]?.legacyMemoryIds).toEqual(['memory-a', 'memory-b']);
    expect(entries[0]?.pendingMigrationDeviceCount).toBe(1);
    expect(entries[0]?.devices.map(device => device.deviceName)).toEqual(['Gram B', 'Mac A']);
  });
});

describe('검색', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'aaaa-1111', created_at: '2026-08-02T00:00:00Z', project_name: 'ShadowLoop', device_name: 'MacBook' }),
    row({ memory_id: 'bbbb-2222', created_at: '2026-08-01T00:00:00Z', project_name: 'Portal', github_url: 'https://github.com/o/portal', device_name: 'iMac' }),
  ]);

  test('빈 검색어는 전부 통과시킨다', () => {
    expect(filterMemoryDirectory(entries, '   ')).toHaveLength(2);
  });

  test('이름·기기·저장소로 찾는다', () => {
    expect(filterMemoryDirectory(entries, 'shadow')[0]!.memoryId).toBe('aaaa-1111');
    expect(filterMemoryDirectory(entries, 'imac')[0]!.memoryId).toBe('bbbb-2222');
    expect(filterMemoryDirectory(entries, 'github.com/o/portal')[0]!.memoryId).toBe('bbbb-2222');
  });

  // 다른 기기에서 복사한 ID 조각을 그대로 붙여넣어 확인하는 것이 실제 사용 흐름이다.
  test('ID 일부만 붙여넣어도 찾는다', () => {
    expect(filterMemoryDirectory(entries, 'bbbb')[0]!.memoryId).toBe('bbbb-2222');
  });

  test('마지막 Push 단말이 아닌 단말 이름으로도 찾는다', () => {
    const withDevices = buildMemoryDirectory([
      row({ memory_id: 'm1', id: 'head', created_at: '2026-08-10T00:00:00Z', device_id: 'aws', device_name: 'AWS' }),
    ], [{
      memory_id: 'm1', device_id: 'gram', device_name: '집에있는그램', platform: 'win32', revision_id: 'old',
      content_hash: 'old', last_synced_at: null, last_seen_at: '2026-08-09T00:00:00Z',
    }]);
    expect(filterMemoryDirectory(withDevices, '그램')).toHaveLength(1);
  });

  test('분해형 한글 이름도 완성형 검색어로 찾는다', () => {
    const koreanEntries = buildMemoryDirectory([
      row({
        memory_id: 'korean-memory',
        project_name: '공모청약환불출고'.normalize('NFD'),
        created_at: '2026-08-24T00:00:00Z',
      }),
    ]);

    expect(filterMemoryDirectory(koreanEntries, '청약환불')).toHaveLength(1);
  });
});

describe('저장소 필터와 단계별 권장', () => {
  const now = Date.parse('2026-08-24T00:00:00Z');

  test('저장소 있음·없음과 조치 검토 대상을 각각 거른다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'repo', created_at: '2026-08-23T00:00:00Z', github_url: 'https://github.com/o/repo' }),
      row({ memory_id: 'missing', created_at: '2026-08-23T00:00:00Z', github_url: null }),
    ]);
    expect(filterMemoryDirectoryByRepository(entries, 'with-repository', now).map(entry => entry.memoryId)).toEqual(['repo']);
    expect(filterMemoryDirectoryByRepository(entries, 'without-repository', now).map(entry => entry.memoryId)).toEqual(['missing']);
    expect(filterMemoryDirectoryByRepository(entries, 'review', now).map(entry => entry.memoryId)).toEqual(['missing']);
  });

  test('복수 단말의 저장소 없는 프로젝트는 연결을 우선 권장한다', () => {
    const entry = buildMemoryDirectory([
      row({ memory_id: 'multi', created_at: '2026-08-23T00:00:00Z', device_id: 'mac' }),
      row({ memory_id: 'multi', created_at: '2026-08-22T00:00:00Z', device_id: 'aws' }),
    ])[0]!;
    expect(memoryRepositoryGuidance(entry, now)).toEqual({ kind: 'connect', priority: 'high', inactiveDays: 1 });
  });

  test('Telegram 기억 전용 항목은 저장소 연결을 강요하거나 검토 필터에 넣지 않는다', () => {
    const entry = buildMemoryDirectory([
      row({ memory_id: 'telegram', created_at: '2026-08-23T00:00:00Z', project_name: 'telegram-memory-topic-42' }),
    ])[0]!;
    expect(isMemoryOnlyDirectoryEntry(entry)).toBe(true);
    expect(memoryRepositoryGuidance(entry, now)).toEqual({ kind: 'memory-only', inactiveDays: null });
    expect(filterMemoryDirectoryByRepository([entry], 'review', now)).toEqual([]);
  });

  test('저장소의 최근 확인 시각이 아니라 기억 Push·Git 커밋 기준 90일 뒤에만 휴지통 검토를 권한다', () => {
    const entry = buildMemoryDirectory([
      row({ memory_id: 'stale', created_at: '2026-04-01T00:00:00Z', github_url: 'https://github.com/o/stale', device_id: 'mac' }),
    ], [{
      memory_id: 'stale', device_id: 'mac', device_name: 'Mac', platform: 'darwin', revision_id: 'old',
      content_hash: 'old', last_synced_at: '2026-04-01T00:00:00Z', last_seen_at: '2026-08-24T00:00:00Z',
      git_commit_at: '2026-04-02T00:00:00Z', git_checked_at: '2026-08-24T00:00:00Z',
    }])[0]!;
    expect(memoryRepositoryGuidance(entry, now)).toEqual({ kind: 'stale', inactiveDays: 144 });
    expect(filterMemoryDirectoryByRepository([entry], 'review', now)).toEqual([entry]);
  });

  test('기억이 최근 갱신된 저장소는 오래된 Git 커밋만으로 정리 권유하지 않는다', () => {
    const entry = buildMemoryDirectory([
      row({ memory_id: 'active', created_at: '2026-08-23T00:00:00Z', github_url: 'https://github.com/o/active' }),
    ])[0]!;
    expect(memoryRepositoryGuidance(entry, now)).toBeNull();
  });
});

describe('조회 실패 안내', () => {
  // 실측(2026-08-14)으로 받은 문구다. anon 으로 나갔거나, 로그인했어도 정책이 using(false)면
  // 똑같이 이 오류가 온다 — 원문만 보여주면 사용자가 로그인만 반복한다.
  const denied = new Error('permission denied for table portmgr_project_memory_revisions');

  // 세션이 없으면 쿼리가 anon 으로 나가며 모든 portmgr_* 테이블이 차단되어야 한다.
  test('세션이 없으면 익명 조회였다고 말하고 다시 로그인시킨다', () => {
    const text = describeMemoryQueryFailure(denied, false);
    expect(text).toContain('permission denied');
    expect(text).toContain('익명');
    expect(text).toContain('다시 로그인');
    // 멀쩡한 DB 를 건드리게 만드는 오답을 이 경우에 내면 안 된다.
    expect(text).not.toContain('SQL을 다시 실행');
  });

  test('세션이 있는데도 거부되면 계정·마이그레이션을 확인하되 RLS를 끄라고 하지 않는다', () => {
    const text = describeMemoryQueryFailure(denied, true);
    expect(text).toContain('Google 계정');
    expect(text).toContain('마이그레이션');
    expect(text).toContain('RLS를 끄면 안 됩니다');
  });

  test('세션을 모르면 단정하지 않는다', () => {
    const text = describeMemoryQueryFailure(denied);
    expect(text).toContain('로그인 상태를 먼저 확인');
    expect(text).not.toContain('SQL을 다시 실행');
  });

  test('테이블 부재는 설치 안내로 보낸다', () => {
    expect(describeMemoryQueryFailure({ message: 'relation does not exist' })).toContain('테이블 생성');
  });

  test('모르는 오류는 원문 그대로 둔다 — 지어내지 않는다', () => {
    expect(describeMemoryQueryFailure(new Error('network unreachable'))).toBe('network unreachable');
  });
});

describe('포털 화면 계약', () => {
  const view = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  test('기기로 거르지 않는다 — 다른 기기의 기억을 찾는 화면이다', () => {
    expect(view).not.toContain(".eq('device_id'");
  });

  test('목록에서는 content 를 받지 않는다', () => {
    // 컬럼 목록은 공유 모듈이 정본이다(두 소비자가 같은 조회를 쓰므로).
    const dir = readFileSync(new URL('../src/projectMemoryDirectory.ts', import.meta.url), 'utf8');
    expect(dir).toContain("'id, memory_id, project_name, github_url, device_id, device_name, content_hash, created_at'");
    expect(dir).not.toContain('content,');
    expect(view).toContain('MEMORY_LIST_COLUMNS');
  });

  test('단말 현황·동기화 명령·GitHub 역할 편집에 닿을 수 있다', () => {
    expect(view).toContain('data-testid="portal-memory-device"');
    expect(view).toContain('data-testid="portal-memory-copy-sync"');
    expect(view).toContain('data-testid="portal-memory-repository-roles"');
    expect(view).toContain('data-testid="portal-memory-edit-repository-roles"');
    expect(view).toContain('data-testid="portal-memory-find-local"');
    expect(view).toContain('data-testid="portal-memory-copy-find"');
    expect(view).toContain('data-testid="portal-memory-open-local-folder"');
    expect(view).toContain('data-testid="portal-memory-history-estimate"');
    expect(view).toContain('data-testid="portal-memory-retire-device"');
    expect(view).toContain('data-testid="portal-memory-device-memory-state"');
    expect(view).toContain('data-testid="portal-memory-device-git-state"');
    expect(view).toContain('data-testid="portal-memory-git-summary"');
    expect(view).toContain("'portal-memory-device-identity-warning'");
    expect(view).toContain('data-testid="portal-memory-device-identity-details"');
    expect(view).toContain('단말 식별 확인 권장');
    expect(view).toContain('같은 물리 단말의 이전 이름이면 그대로 두어도 됩니다');
    expect(view).toContain('data-testid="portal-memory-device-legacy-ids-expanded"');
    expect(view).toContain('data-testid="portal-memory-refresh-local-state"');
  });

  test('사용자 별칭과 고아 없는 계보 합병 도구에 닿을 수 있다', () => {
    expect(view).toContain('data-testid="portal-memory-edit-label"');
    expect(view).toContain('data-testid="portal-memory-open-merge"');
    expect(view).toContain('data-testid="portal-memory-lineage"');
    expect(view).toContain("portmgr_merge_project_memories");
    expect(view).toContain('이전 ID는 삭제하지 않고 계속 현재 ID로 연결됩니다');
    expect(view).toContain("repositoryChoice");
  });

  test('로컬 앱에서는 북마크 안쪽이 아니라 북마크 옆 최상위 탭에 현황판이 있다', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const localPortal = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
    expect(app).toContain('data-testid="top-level-memory-tab"');
    expect(app).toContain("setActiveTab('memory')");
    expect(app).toContain('data-testid="top-level-memory-view"');
    expect(app).toContain('<h1 className="sr-only">AgentsToZ 장기기억</h1>');
    expect(app).toContain('<PortalMemoryDirectory');
    expect(localPortal).not.toContain('local-portal-memory-tab');
    expect(localPortal).not.toContain('<PortalMemoryDirectory');
  });

  test('조회 구간을 넘기면 잘렸다고 말한다', () => {
    expect(view).toContain('data-testid="portal-memory-window-warning"');
  });

  test('데스크톱 콜드 스타트의 첫 빈 응답은 한 번 자동 재조회한다', () => {
    expect(view).toContain('if (isTauri() && !force && loaded.entries.length === 0)');
    expect(view).toContain('loaded = await loadOnce(true)');
  });

  test('첫 조회 전의 미확정 상태를 0개로 오해시키지 않는다', () => {
    expect(view).toContain('const [loading, setLoading] = useState(true)');
    expect(view).toContain('const initialLoadPending = loading && loadedDirectory === null');
    expect(view).toContain('data-testid="portal-memory-initial-loading"');
    expect(view).toContain('장기기억과 단말 동기화 상태를 불러오는 중…');
    expect(view).toContain("initialLoadPending ? '단말 불러오는 중…'");
    expect(view).toContain("initialLoadPending ? '저장소 불러오는 중…'");
  });

  test('ID 복사와 저장소 없음 표시가 있다', () => {
    expect(view).toContain('data-testid="portal-memory-copy-id"');
    expect(view).toContain('저장소 없음 · ID로만 연결');
  });

  test('저장소 여부 필터와 접힌 단계 안내·가역 휴지통 검토가 있다', () => {
    expect(view).toContain('data-testid="portal-memory-repository-filter"');
    expect(view).toContain('data-testid="portal-memory-repository-guidance"');
    expect(view).toContain('data-testid="portal-memory-stale-trash-review"');
    expect(view).toContain('AgentsToZ 앱의 프로젝트 수정에서 GitHub 저장소 주소를 연결합니다');
    expect(view).toContain('원본·리비전·단말 이력을 지우지 않으며 언제든 복원할 수 있습니다');
  });

  test('탭이 두 레이아웃 모두에서 닿는다 — 본문은 분기 바깥에 하나', () => {
    expect(portal).toContain("type Tab = 'bookmarks' | 'ports' | 'memories';");
    // 본문을 레이아웃 분기 밖으로 뺀 뒤로는 한 번만 쓴다(리마운트 방지).
    expect(portal.match(/activeTab === 'memories' && \(/g) ?? []).toHaveLength(1);
    // 대신 탭 진입점이 사이드바(전체)와 헤더 둘째 줄(컴팩트) 두 곳에 있다.
    expect(portal).toContain("['memories', '장기기억'");
    expect(portal).toContain('{tabsEl}');
  });
});

describe('프로젝트 행에 붙일 기억 고르기', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'repo-m', created_at: '2026-08-02T00:00:00Z', project_name: '다른 이름', github_url: 'https://github.com/o/repo' }),
    row({ memory_id: 'name-m', created_at: '2026-08-01T00:00:00Z', project_name: 'tele' }),
    row({ memory_id: 'dup-a', created_at: '2026-08-01T00:00:00Z', project_name: '겹침' }),
    row({ memory_id: 'dup-b', created_at: '2026-08-01T00:00:00Z', project_name: '겹침' }),
  ]);

  test('저장소가 이름보다 우선한다 — 이름은 바뀌어도 저장소는 계보 키다', () => {
    const matched = matchMemoryForProject(entries, { name: 'tele', githubUrl: 'https://github.com/o/repo' });
    expect(matched?.memoryId).toBe('repo-m');
  });

  test('.git 꼬리와 대소문자가 달라도 같은 저장소로 본다', () => {
    expect(matchMemoryForProject(entries, { githubUrl: 'https://GitHub.com/o/repo.git' })?.memoryId).toBe('repo-m');
  });

  test('저장소가 없으면 이름으로 잇는다', () => {
    expect(matchMemoryForProject(entries, { name: 'tele' })?.memoryId).toBe('name-m');
  });

  // 틀린 ID 를 복사하면 남의 기억에 이 프로젝트를 합류시키게 된다. 애매하면 보여주지 않는다.
  test('후보가 여럿이면 고르지 않는다', () => {
    expect(matchMemoryForProject(entries, { name: '겹침' })).toBeNull();
  });

  test('맞는 것이 없으면 null', () => {
    expect(matchMemoryForProject(entries, { name: 'CS볼트V6_remote' })).toBeNull();
    expect(matchMemoryForProject(entries, {})).toBeNull();
  });
});

describe('프로젝트 행의 기억 칩', () => {
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  test('GitHub 칩 바로 옆에 붙는다 — 본래 요청이 그 자리였다', () => {
    expect(portal).toContain("{inlineUrlPill(p, 'github_url')}\n                {memoryPill(p)}");
    expect(portal).toContain('data-testid="portal-row-memory-id"');
  });

  test('기억 조회가 실패해도 프로젝트 행은 그대로 나온다', () => {
    // 세션이 없으면 이 테이블만 거부된다(포트는 anon 에게도 열려 있다).
    // 곁들이는 정보 때문에 목록 자체가 사라지면 안 된다.
    expect(portal).toContain('if (!cancelled) setMemoryEntries([]);');
  });

  test('맞는 기억이 없으면 아무것도 그리지 않는다', () => {
    expect(portal).toContain('if (!matched) return null;');
  });
});

describe('세션 복원을 기다린 뒤 조회한다', () => {
  const view = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  // supabase-js 는 세션을 비동기로 되살리는데 화면 게이트는 localStorage 플래그로 즉시
  // 통과시킨다. 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로 나가 42501 이 온다.
  test('두 조회 모두 getSession() 뒤에 쿼리한다', () => {
    for (const source of [view, portal]) {
      const call = source.indexOf('.auth.getSession()');
      const query = source.indexOf("from('portmgr_project_memory_revisions')");
      expect(call).toBeGreaterThan(-1);
      expect(call).toBeLessThan(query);
    }
  });

  test('로그인이 늦게 도착해도 스스로 다시 읽는다', () => {
    for (const source of [view, portal]) {
      expect(source).toContain('onAuthStateChange');
      expect(source).toContain("event === 'SIGNED_IN'");
    }
  });
});

describe('행이 기억 ID를 직접 들고 있으면 추측하지 않는다', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'exact-1', created_at: '2026-08-02T00:00:00Z', project_name: '다른 이름' }),
    row({ memory_id: 'byname', created_at: '2026-08-01T00:00:00Z', project_name: 'CS볼트V6' }),
  ]);

  test('memory_id 가 저장소·이름보다 우선한다', () => {
    const matched = matchMemoryForProject(entries, {
      memoryId: 'exact-1', name: 'CS볼트V6', githubUrl: 'https://github.com/o/r',
    });
    expect(matched?.memoryId).toBe('exact-1');
  });

  // 실측 사례: 포트 이름 CS볼트V6_remote, 기억 이름 CS볼트V6, 기억의 저장소는 null —
  // 간접 키 둘 다 실패했다. ID 를 실으면 이런 조합도 정확히 붙는다.
  test('이름이 다르고 저장소가 없어도 붙는다', () => {
    expect(matchMemoryForProject(entries, { memoryId: 'byname', name: 'CS볼트V6_remote' })?.memoryId)
      .toBe('byname');
  });

  test('아는 ID 가 목록에 없으면 다른 기억으로 내려가지 않는다', () => {
    // 틀린 기억을 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.
    expect(matchMemoryForProject(entries, { memoryId: '없는-id', name: 'CS볼트V6' })).toBeNull();
  });

  test('ID 가 없으면 예전처럼 간접 키로 내려간다', () => {
    expect(matchMemoryForProject(entries, { memoryId: null, name: 'CS볼트V6' })?.memoryId).toBe('byname');
  });
});
