import { describe, expect, test } from 'bun:test';
import {
  buildProjectMemoryFindCommand,
  buildProjectMemorySyncCommand,
  normalizeDevicePlatform,
} from '../src/projectMemoryDeviceSync';

describe('단말 장기기억 동기화 명령', () => {
  test('macOS·Linux는 현재 Git 루트를 안전하게 전송한다', () => {
    const command = buildProjectMemorySyncCommand('darwin');
    expect(command).toContain('git rev-parse --show-toplevel');
    expect(command).toContain('--data-urlencode "folderPath=$PROJECT_ROOT"');
    expect(command).toContain('/api/project-memory/sync');
  });

  test('Windows는 PowerShell curl 별칭 대신 curl.exe를 쓴다', () => {
    const command = buildProjectMemorySyncCommand('win32');
    expect(command).toContain('curl.exe');
    expect(command).toContain('$PROJECT_ROOT');
  });

  test('알 수 없는 플랫폼은 POSIX 명령으로 되돌린다', () => {
    expect(normalizeDevicePlatform('windows')).toBe('win32');
    expect(normalizeDevicePlatform('macos')).toBe('darwin');
    expect(normalizeDevicePlatform('mystery')).toBe('unknown');
    expect(buildProjectMemorySyncCommand('mystery')).toContain('curl --fail-with-body');
  });

  test('폴더 밖에서도 memoryId로 등록 프로젝트 경로를 찾는 명령을 만든다', () => {
    const mac = buildProjectMemoryFindCommand('884575df-63c4-407c-8b43-860d1295e663', 'darwin');
    expect(mac).toContain('/api/project-memory/resolve-project');
    expect(mac).toContain('884575df-63c4-407c-8b43-860d1295e663');
    expect(mac).not.toContain('git rev-parse');

    const windows = buildProjectMemoryFindCommand('memory-id', 'win32');
    expect(windows).toContain('curl.exe');
    expect(windows).toContain('Content-Type: application/json');
  });

  test('찾기 명령의 JSON과 셸 인용을 깨뜨리는 별칭도 안전하게 감싼다', () => {
    const command = buildProjectMemoryFindCommand("team's \"memory\"", 'darwin');
    expect(command).toContain(`'"'"'`);
    expect(command).toContain('\\"memory\\"');
  });
});
