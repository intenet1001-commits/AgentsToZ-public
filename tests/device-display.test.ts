import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatDeviceLastPushAt } from '../src/deviceDisplay';

describe('기기 마지막 Push 표시', () => {
  test('빈 값과 깨진 날짜를 Invalid Date로 노출하지 않는다', () => {
    expect(formatDeviceLastPushAt('')).toBe('최근 Push 기록 없음');
    expect(formatDeviceLastPushAt('broken')).toBe('최근 Push 기록 없음');
  });

  test('정상 날짜는 지역 형식으로 표시한다', () => {
    expect(formatDeviceLastPushAt('2026-08-23T00:00:00Z')).not.toContain('Invalid');
  });
});

describe('배포 포털 기기 표시 계약', () => {
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
  const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');

  test('기기 목록의 날짜 두 곳이 모두 공유 포맷터를 쓴다', () => {
    expect((portal.match(/formatDeviceLastPushAt\([a-zA-Z]+\.last_push_at\)/g) ?? [])).toHaveLength(2);
    expect(portal).not.toMatch(/new Date\([a-zA-Z]+\.last_push_at\)/);
  });

  test('설정은 조회 단말과 브라우저 신원을 구분하고 열 때 등록명을 재조회한다', () => {
    expect(manager).toContain('이 브라우저의 등록 이름');
    expect(manager).toContain('조회 선택이 기기 신원을 바꾸지는 않습니다');
    expect(manager).toContain("from('portmgr_devices').select('name').eq('id', identity.deviceId)");
  });
});
