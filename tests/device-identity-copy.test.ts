import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

test('단말 별칭 UI는 ID 구현 용어 대신 사용 시점과 결과를 설명한다', () => {
  expect(source).toContain('중복 단말 정리');
  expect(source).toContain('같은 컴퓨터가 두 개로 보일 때');
  expect(source).toContain('프로젝트·장기기억·Git 이력');
  expect(source).toContain('데이터는 이동하거나 삭제하지 않습니다');
  expect(source).toContain('서로 다른 컴퓨터는 묶지 마세요');
  expect(source).not.toContain('같은 물리 단말의 이전 ID 연결');
});
