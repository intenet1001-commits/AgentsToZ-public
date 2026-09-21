import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { remoteMemoryDeviceStatusRows } from '../src/projectMemoryDirectory';
import { devicePlatformLabel, normalizeDevicePlatform } from '../src/projectMemoryDeviceSync';

describe('원격 호스트의 장기기억 플랫폼 보강', () => {
  test('AWS 호스트 프로젝트를 기억 단말 관측으로 변환한다', () => {
    const rows = remoteMemoryDeviceStatusRows([
      {
        device_id: 'aws-host', display_name: 'Hermes AWS', platform: 'linux', environment_kind: 'aws',
        last_seen_at: '2026-08-23T13:00:00Z', revoked_at: null,
      },
    ], [
      {
        device_id: 'aws-host', project_path: '/home/ubuntu/project', memory_id: '7f378351',
        git_remote_url: null, git_head_sha: null, git_branch: null, git_dirty: null,
        present: true, last_observed_at: '2026-08-23T13:01:00Z',
        telegram_chat_id: '-100123', telegram_thread_id: '42',
      },
    ]);
    expect(rows).toEqual([expect.objectContaining({
      memory_id: '7f378351',
      device_id: 'aws-host',
      device_name: 'Hermes AWS',
      platform: 'aws',
      source_path: '/home/ubuntu/project',
      telegram_chat_id: '-100123',
      telegram_thread_id: '42',
    })]);
    expect(normalizeDevicePlatform(rows[0]!.platform)).toBe('aws');
    expect(devicePlatformLabel(rows[0]!.platform)).toBe('AWS Ubuntu');
  });

  test('등록 해제된 호스트도 AWS 이력으로 보이되 사용 중인 단말 집계에서는 제외할 근거를 싣는다', () => {
    const devices = [{
      device_id: 'aws-host', display_name: 'Hermes AWS', platform: 'linux', environment_kind: 'aws',
      last_seen_at: null, revoked_at: '2026-08-23T13:00:00Z',
    }];
    const projects = [{
      device_id: 'aws-host', project_path: '/home/ubuntu/project', memory_id: 'memory',
      git_remote_url: null, git_head_sha: null, git_branch: null, git_dirty: null,
      present: true, last_observed_at: null,
      telegram_chat_id: null, telegram_thread_id: null,
    }];
    expect(remoteMemoryDeviceStatusRows(devices, projects)).toEqual([
      expect.objectContaining({ platform: 'aws', retired_at: '2026-08-23T13:00:00Z' }),
    ]);
  });
});

test('장기기억 포털은 원격 호스트와 프로젝트 조회를 함께 전달한다', () => {
  const source = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
  expect(source).toContain('remoteDeviceQuery');
  expect(source).toContain('remoteProjectQuery');
});
