import { describe, expect, test } from 'bun:test';
import {
  normalizePortalDeviceSelectionMode,
  resolvePortalDeviceSelection,
  storedPortalDeviceSelection,
} from '../src/portalDeviceSelection';

const devices = [
  { id: 'mac-current', sourceIds: ['mac-current', 'mac-old'] },
  { id: 'aws-host', sourceIds: ['aws-host'] },
];

describe('배포 포털 시작 단말 정책', () => {
  test('기본값과 알 수 없는 값은 마지막 조회 단말 정책이다', () => {
    expect(normalizePortalDeviceSelectionMode(null)).toBe('recent');
    expect(normalizePortalDeviceSelectionMode('old-value')).toBe('recent');
    expect(normalizePortalDeviceSelectionMode('fixed')).toBe('fixed');
    expect(normalizePortalDeviceSelectionMode('none')).toBe('none');
  });

  test('마지막 조회는 재설치 별칭도 현재 대표 ID로 복원한다', () => {
    expect(resolvePortalDeviceSelection({
      mode: 'recent', lastViewedDeviceId: 'mac-old', fixedDeviceId: '', devices,
    })).toEqual({ selectedDeviceId: 'mac-current', shouldOpenPicker: false });
  });

  test('지정 기본 단말은 최근 조회와 무관하게 AWS도 선택할 수 있다', () => {
    expect(resolvePortalDeviceSelection({
      mode: 'fixed', lastViewedDeviceId: 'mac-current', fixedDeviceId: 'aws-host', devices,
    })).toEqual({ selectedDeviceId: 'aws-host', shouldOpenPicker: false });
  });

  test('선택 안 함은 마지막 조회 기록을 지우지 않고 빈 화면으로 시작한다', () => {
    expect(storedPortalDeviceSelection('none', 'mac-current', 'aws-host')).toBe('');
    expect(resolvePortalDeviceSelection({
      mode: 'none', lastViewedDeviceId: 'mac-current', fixedDeviceId: 'aws-host', devices,
    })).toEqual({ selectedDeviceId: '', shouldOpenPicker: false });
  });

  test('저장된 단말이 사라졌으면 임의의 첫 단말 대신 선택 목록을 연다', () => {
    expect(resolvePortalDeviceSelection({
      mode: 'fixed', lastViewedDeviceId: '', fixedDeviceId: 'retired', devices,
    })).toEqual({ selectedDeviceId: '', shouldOpenPicker: true });
  });
});
