import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

test('장기기억 기기 제외는 기억 병합·삭제와 구분되는 실제 확인 모달이다', () => {
  expect(source).not.toContain('이 기기를 사용 종료 처리할까요?');
  expect(source).toContain('portal-memory-retirement-confirm');
  expect(source).toContain('이 기기를 확인 대상에서 제외할까요?');
  expect(source).toContain('장기기억 ID·내용·리비전·Git 이력·기기 항목은 그대로 보존');
  expect(source).toContain("setPendingRetirement({ memoryId: entry.memoryId, deviceId: device.deviceId })");
  expect(source).toContain('void setDeviceRetired(pendingRetirementEntry, pendingRetirementDevice.deviceId, true)');
});
