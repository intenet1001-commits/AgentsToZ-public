import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportProjectMemoryDeviceStatus } from '../project-memory-server';

describe('단말별 장기기억 상태 보고', () => {
  test('확인된 동기화 head와 단말 메타데이터를 한 행으로 upsert한다', async () => {
    const writes: any[] = [];
    const sb = {
      from(table: string) {
        expect(table).toBe('portmgr_project_memory_devices');
        return {
          async upsert(row: any, options: any) {
            writes.push({ row, options });
            return { error: null };
          },
        };
      },
    };
    const result = await reportProjectMemoryDeviceStatus({
      sb,
      portal: { deviceId: 'device-a', deviceName: 'MacBook Pro' },
      memoryId: 'memory-a',
      contentHash: 'hash-head',
      revisionId: 'rev-head',
      inSync: true,
    });
    expect(result).toEqual({ deviceStatusReported: true });
    expect(writes[0]).toEqual({
      row: expect.objectContaining({
        memory_id: 'memory-a',
        device_id: 'device-a',
        device_name: 'MacBook Pro',
        revision_id: 'rev-head',
        content_hash: 'hash-head',
        last_synced_at: expect.any(String),
        last_seen_at: expect.any(String),
      }),
      options: { onConflict: 'memory_id,device_id' },
    });
  });

  test('deviceId가 없으면 정본 동기화를 막지 않고 보고만 건너뛴다', async () => {
    const result = await reportProjectMemoryDeviceStatus({
      sb: {}, portal: {}, memoryId: 'memory-a', contentHash: 'hash', revisionId: 'rev', inSync: true,
    });
    expect(result.deviceStatusReported).toBe(false);
    expect(result.deviceStatusReportError).toContain('deviceId');
  });

  test('프로젝트 루트가 있으면 Git 커밋과 확인 시각도 함께 보고한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-report-git-'));
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
      Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: root });
      Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: root });
      writeFileSync(join(root, 'a.txt'), 'a\n');
      Bun.spawnSync(['git', 'add', 'a.txt'], { cwd: root });
      Bun.spawnSync(['git', 'commit', '-qm', 'initial'], { cwd: root });
      const writes: any[] = [];
      const sb = { from: () => ({ upsert: async (value: any) => { writes.push(value); return { error: null }; } }) };
      await reportProjectMemoryDeviceStatus({
        sb, portal: { deviceId: 'device-a' }, memoryId: 'memory-a', contentHash: 'memory-hash',
        revisionId: 'revision-a', inSync: true, projectRoot: root,
      });
      expect(writes[0]).toEqual(expect.objectContaining({
        device_name: hostname().trim().slice(0, 80),
        git_head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        git_branch: expect.any(String),
        git_dirty: false,
        git_commit_at: expect.any(String),
        git_checked_at: expect.any(String),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
