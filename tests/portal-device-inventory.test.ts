import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildPortalDesktopInventory, buildPortalRemoteInventory } from '../src/portalDeviceInventory';

describe('배포 포털 물리 단말 인벤토리', () => {
  test('재설치된 같은 Mac의 과거 ID 프로젝트를 현재 ID 한 장에 접는다', () => {
    const inventory = buildPortalDesktopInventory({
      devices: [
        { id: 'old-app-id', name: '최천성 MacBook Pro (로컬)', last_push_at: '2026-08-03T00:00:00Z' },
      ],
      projects: [
        { id: 'p1', device_id: 'old-app-id', device_name: '최천성 MacBook Pro (로컬)', name: '프로젝트관리' },
        { id: 'p2', device_id: 'old-memory-id', device_name: null, name: '테스트' },
      ],
      aliases: [
        { alias_device_id: 'old-app-id', canonical_device_id: 'current-id' },
        { alias_device_id: 'old-memory-id', canonical_device_id: 'current-id' },
      ],
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toEqual(expect.objectContaining({
      id: 'current-id',
      name: '최천성 MacBook Pro (로컬)',
      projectCount: 2,
      projectNames: ['테스트', '프로젝트관리'],
    }));
    expect(inventory[0]!.sourceIds).toEqual(['current-id', 'old-app-id', 'old-memory-id']);
  });

  test('서로 다른 물리 단말은 이름이 비슷해도 자동 병합하지 않는다', () => {
    const inventory = buildPortalDesktopInventory({
      devices: [
        { id: 'mac-a', name: 'MacBook Pro', last_push_at: null },
        { id: 'mac-b', name: 'MacBook Pro', last_push_at: null },
      ],
      projects: [],
    });
    expect(inventory).toHaveLength(2);
  });

  test('삭제된 예전 단말의 프로젝트 이력만으로 활성 단말을 되살리지 않는다', () => {
    const inventory = buildPortalDesktopInventory({
      devices: [
        { id: 'active-mac', name: '최천성 MacBook Pro (로컬)', last_push_at: null },
      ],
      projects: [
        { id: 'active-project', device_id: 'active-mac', name: '프로젝트관리' },
        { id: 'orphan-project', device_id: 'retired-install-id', name: '과거 프로젝트' },
      ],
      workspaceRoots: [
        { device_id: 'another-retired-id', name: '과거 작업공간', path: '/old' },
      ],
    });

    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toEqual(expect.objectContaining({
      id: 'active-mac',
      name: '최천성 MacBook Pro (로컬)',
      projectCount: 1,
    }));
  });
});

describe('배포 포털 원격 단말 인벤토리', () => {
  test('활성 AWS 호스트와 현재 프로젝트를 선택 목록용 한 장으로 만든다', () => {
    const inventory = buildPortalRemoteInventory({
      devices: [{
        device_id: 'aws-host', display_name: 'Hermes AWS', environment_kind: 'aws',
        last_seen_at: '2026-08-24T00:00:00Z', revoked_at: null,
      }],
      projects: [
        { device_id: 'aws-host', project_name: 'AgentsToZ_byCS', present: true },
        { device_id: 'aws-host', project_name: 'old-project', present: false },
      ],
    });
    expect(inventory).toEqual([expect.objectContaining({
      id: 'aws-host', name: 'Hermes AWS', kind: 'remote', environmentLabel: 'AWS Ubuntu',
      projectCount: 1, projectNames: ['AgentsToZ_byCS'],
    })]);
  });

  test('등록 해제된 원격 호스트는 활성 선택 목록에 되살리지 않는다', () => {
    expect(buildPortalRemoteInventory({
      devices: [{
        device_id: 'retired', display_name: 'Old AWS', environment_kind: 'aws',
        last_seen_at: null, revoked_at: '2026-08-24T00:00:00Z',
      }],
      projects: [{ device_id: 'retired', project_name: 'history', present: true }],
    })).toEqual([]);
  });
});

test('포털은 별칭 그룹 전체의 프로젝트를 조회하고 단말 카드에 프로젝트 정보를 표시한다', () => {
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
  expect(portal).toContain('buildPortalDesktopInventory');
  expect(portal).toContain('buildPortalRemoteInventory');
  expect(portal).toContain(".in('device_id', deviceIds)");
  expect(portal).toContain(".from('portmgr_remote_device_projects')");
  expect(portal).toContain('프로젝트 {d.projectCount}개');
});
