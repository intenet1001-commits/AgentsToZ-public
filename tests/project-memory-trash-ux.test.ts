import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
const portalSource = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

test('장기기억 휴지통은 이동 전 보존 범위를 설명하고 복원을 제공한다', () => {
  expect(source).toContain('portal-memory-trash-confirm');
  expect(source).toContain('기억 내용, 모든 리비전, 프로젝트·단말·Git 이력, 합병 계보는 그대로 남습니다');
  expect(source).toContain('안전을 위해 이 화면에서는 영구 삭제를 제공하지 않습니다');
  expect(source).toContain('portal-memory-restore-from-trash');
  expect(source).toContain("p_trashed: trashed");
});

test('중복 단말 정리는 선택 뒤 최종 변경 내용을 한 번 더 확인한다', () => {
  expect(source).toContain('portal-memory-device-identity-preview');
  expect(source).toContain('변경 내용 확인');
  expect(source).toContain('확인하고 한 단말로 묶기');
  expect(source).toContain('항목·프로젝트·기억·Git 이력은 삭제되거나 복사되지 않고');
  expect(source).toContain("aliasDeviceId: ''");
  expect(source).toContain('!deviceIdentityDraft.aliasDeviceId');
});

test('장기기억 단말 필터는 데스크톱과 AWS 호스트의 통합 목록임을 설명한다', () => {
  expect(source).toContain('portal-memory-device-filter');
  expect(source).toContain('`모든 단말 ${deviceFilters.length}대`');
  expect(source).toContain('등록된 AWS·Ubuntu 호스트를 함께 보여줍니다');
});

test('늦게 끝난 기기 목록 조회가 사용자가 선택한 장기기억 탭을 되돌리지 않는다', () => {
  expect(portalSource).not.toContain("else if (selectedDeviceId && knownInList)");
  expect(portalSource).toContain("() => readInitialSelectedDeviceId() ? 'ports' : 'bookmarks'");
});
