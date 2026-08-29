import { describe, expect, test } from 'bun:test';
import {
  AI_MEMORY_ALIAS_MAX_CHARS,
  parseAiMemoryAlias,
} from '../src/projectMemoryAiAlias';

describe('AI 장기기억 별칭 응답', () => {
  test('JSON 한 줄에서 사람이 수정할 수 있는 별칭 하나만 꺼낸다', () => {
    expect(parseAiMemoryAlias('{"displayName":"멀티기기 장기기억 허브"}'))
      .toBe('멀티기기 장기기억 허브');
  });

  test('30자를 넘는 별칭은 저장 전에 제한한다', () => {
    const alias = parseAiMemoryAlias('{"displayName":"아주긴프로젝트이름 장기기억 동기화 운영 관리 도구"}');
    expect(alias?.length).toBeLessThanOrEqual(AI_MEMORY_ALIAS_MAX_CHARS);
  });

  test('후보 여러 개나 이어 붙인 장문은 거절해 UI fallback으로 보낸다', () => {
    expect(parseAiMemoryAlias('첫 후보\n둘째 후보')).toBeNull();
    expect(parseAiMemoryAlias('멀티기기 동기화 관리 크로스기기 프로젝트 동기화 단말 간 동기화 허브 프로젝트 멀티동기화')).toBeNull();
    expect(parseAiMemoryAlias('첫 후보, 둘째 후보')).toBeNull();
  });

  test('구버전 plain-text 단일 별칭도 호환한다', () => {
    expect(parseAiMemoryAlias('별칭: 단말 기억 동기화')).toBe('단말 기억 동기화');
  });
});
