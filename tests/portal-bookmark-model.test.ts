import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildPortalCloudDeleteQueue,
  nextPortalCategoryOrder,
  normalizePortalCollectionData,
  resolveBookmarkCategoryId,
  sortedPortalCategories,
} from '../src/portalBookmarkModel';

describe('portal bookmark category model', () => {
  const categories = [
    { id: 'later', order: 7, name: '나중' },
    { id: 'first', order: 1, name: '처음' },
  ];

  test('정렬은 React state 원본 배열을 변형하지 않는다', () => {
    const originalOrder = categories.map(category => category.id);
    expect(sortedPortalCategories(categories).map(category => category.id)).toEqual(['first', 'later']);
    expect(categories.map(category => category.id)).toEqual(originalOrder);
  });

  test('새로 만든 카테고리를 선택한 상태에서는 다음 북마크의 기본값으로 유지한다', () => {
    const withCreated = [...categories, { id: 'new-category', order: 8, name: '새 카테고리' }];
    expect(resolveBookmarkCategoryId('new-category', withCreated)).toBe('new-category');
  });

  test('빈 저장소와 손상된 저장 데이터를 구분한다', () => {
    const fallback = [{ id: 'default', order: 0 }];
    expect(normalizePortalCollectionData({}, fallback)).toEqual({
      items: [],
      categories: fallback,
    });
    expect(() => normalizePortalCollectionData('{broken json}', fallback)).toThrow();
    expect(() => normalizePortalCollectionData({ items: 'not-an-array' }, fallback)).toThrow(
      '북마크 목록 형식',
    );
    expect(() => normalizePortalCollectionData({ items: [], categories: {} }, fallback)).toThrow(
      '카테고리 목록 형식',
    );
  });

  test('전체 보기나 사라진 선택은 화면 순서상 첫 카테고리로 안전하게 대체한다', () => {
    expect(resolveBookmarkCategoryId('all', categories)).toBe('first');
    expect(resolveBookmarkCategoryId('deleted', categories)).toBe('first');
    expect(resolveBookmarkCategoryId(undefined, [])).toBe('');
  });

  test('중간 카테고리를 삭제한 뒤에도 새 순서가 기존 order와 겹치지 않는다', () => {
    expect(nextPortalCategoryOrder(categories)).toBe(8);
    expect(nextPortalCategoryOrder([])).toBe(0);
  });

  test('원격 삭제 실패 ID를 다음 동기화까지 멱등하게 보존한다', () => {
    const first = buildPortalCloudDeleteQueue({
      previousItemIds: ['keep', 'remove'],
      nextItemIds: ['keep'],
      previousCategoryIds: ['cat-keep', 'cat-remove'],
      nextCategoryIds: ['cat-keep'],
    });
    expect(first).toEqual({ itemIds: ['remove'], categoryIds: ['cat-remove'] });

    const retry = buildPortalCloudDeleteQueue({
      pending: first,
      previousItemIds: ['keep'],
      nextItemIds: ['keep'],
      previousCategoryIds: ['cat-keep'],
      nextCategoryIds: ['cat-keep'],
    });
    expect(retry).toEqual(first);
  });

  test('삭제 대기 ID가 복원되면 원격 삭제 큐에서 취소한다', () => {
    expect(buildPortalCloudDeleteQueue({
      pending: { itemIds: ['restored'], categoryIds: ['cat-restored'] },
      previousItemIds: [],
      nextItemIds: ['restored'],
      previousCategoryIds: [],
      nextCategoryIds: ['cat-restored'],
    })).toBeUndefined();
  });

  test('카테고리 생성 성공 후 화면 선택과 다음 북마크 기본값을 같은 id로 연결한다', () => {
    const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
    expect(manager).toContain('setSelectedCat(newCat.id);');
    expect(manager).toContain('resolveBookmarkCategoryId(defaultCat ?? selectedCat, data.categories)');
  });

  test('Supabase 삭제 실패는 로컬 큐에 남고 Pull 전에 재시도한다', () => {
    const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
    expect(manager).toContain('pendingCloudDeletes?: PortalCloudDeleteQueue');
    expect(manager).toContain('buildPortalCloudDeleteQueue({');
    expect(manager).toContain('const pendingFlush = await persist({');
    expect(manager).toContain('삭제 대기 항목을 먼저 동기화하지 못해 Pull을 중단했습니다.');
  });

  test('불러오기 오류와 폼 레이블을 빈 상태로 숨기지 않는다', () => {
    const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
    expect(manager).toContain('북마크를 불러오지 못했습니다');
    expect(manager).toContain('setLoadRetryNonce(value => value + 1)');
    expect(manager).toContain('if (!res.ok) throw new Error(`로컬 포털 API가 HTTP ${res.status}로 응답했습니다.`)');
    expect(manager).toContain('이 브라우저에 저장된 북마크 데이터를 읽을 수 없습니다');
    expect(manager).toContain('htmlFor="portal-bookmark-name"');
    expect(manager).toContain('id="portal-bookmark-name"');
    expect(manager).toContain('aria-pressed={selectedCat === cat.id}');
  });
});
