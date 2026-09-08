import { describe, expect, test } from 'bun:test';
import { matchesProjectSearch } from '../src/projectSearch';
import { normalizeSearchText } from '../src/searchText';

describe('프로젝트 검색', () => {
  test('macOS에서 분해된 한글 이름을 완성형 검색어로 찾는다', () => {
    const decomposedName = '공모청약환불출고'.normalize('NFD');

    expect(decomposedName).not.toBe('공모청약환불출고');
    expect(matchesProjectSearch({ name: decomposedName }, '청약환불')).toBe(true);
  });

  test('검색어가 분해형이어도 완성형 프로젝트 이름을 찾는다', () => {
    expect(matchesProjectSearch(
      { name: '공모청약환불출고' },
      '환불출고'.normalize('NFD'),
    )).toBe(true);
  });

  test('대소문자와 호환 폭 차이를 함께 정규화한다', () => {
    expect(normalizeSearchText('ＰＹＴＨＯＮ')).toBe('python');
    expect(matchesProjectSearch({ aiName: 'Python Lab' }, 'PYTHON')).toBe(true);
  });

  test('화면에 연결된 프로젝트 메타데이터도 검색한다', () => {
    expect(matchesProjectSearch({ memo: '공모주 환불 출고 자동화' }, '환불 출고')).toBe(true);
    expect(matchesProjectSearch({ githubUrls: ['https://github.com/acme/refund'] }, 'refund')).toBe(true);
    expect(matchesProjectSearch({ terminalCommand: 'bun run allotment' }, 'allotment')).toBe(true);
  });

  test('빈 검색어는 모든 프로젝트를 통과시킨다', () => {
    expect(matchesProjectSearch({ name: 'anything' }, '   ')).toBe(true);
  });
});
