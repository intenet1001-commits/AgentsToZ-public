export interface PortalCategoryLike {
  id: string;
  order: number;
}

export interface PortalCloudDeleteQueue {
  itemIds: string[];
  categoryIds: string[];
}

export interface PortalCollectionData<TItem, TCategory> {
  items: TItem[];
  categories: TCategory[];
  [key: string]: unknown;
}

interface PortalCloudDeleteQueueInput {
  pending?: Partial<PortalCloudDeleteQueue>;
  previousItemIds: readonly string[];
  nextItemIds: readonly string[];
  previousCategoryIds: readonly string[];
  nextCategoryIds: readonly string[];
}

/**
 * 저장소가 비어 있는 것과 JSON/스키마가 깨진 것을 구분한다. 손상된 값을 빈 데이터로
 * 바꾸면 사용자는 정상 빈 화면으로 오해하고 그 위에 저장해 복구 기회를 잃을 수 있다.
 */
export function normalizePortalCollectionData<TItem, TCategory extends object>(
  value: unknown,
  fallbackCategories: readonly TCategory[],
): PortalCollectionData<TItem, TCategory> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('포털 저장 데이터가 객체 형식이 아닙니다.');
  }

  const record = value as Record<string, unknown>;
  if (record.items !== undefined && !Array.isArray(record.items)) {
    throw new Error('포털 북마크 목록 형식이 올바르지 않습니다.');
  }
  if (record.categories !== undefined && !Array.isArray(record.categories)) {
    throw new Error('포털 카테고리 목록 형식이 올바르지 않습니다.');
  }

  const categories = record.categories as TCategory[] | undefined;
  return {
    ...record,
    items: (record.items ?? []) as TItem[],
    categories: categories?.length
      ? categories
      : fallbackCategories.map(category => ({ ...category })),
  };
}

/**
 * 카테고리는 React state와 기본 상수 양쪽에서 재사용된다. 렌더 중 원본 배열을
 * sort()하면 state와 기본값까지 변형되므로 항상 복사본을 반환한다.
 */
export function sortedPortalCategories<T extends PortalCategoryLike>(
  categories: readonly T[],
): T[] {
  return [...categories].sort((left, right) => {
    const orderDelta = left.order - right.order;
    return orderDelta || left.id.localeCompare(right.id);
  });
}

/** 현재 선택이 유효하면 유지하고, 전체 보기에서는 가장 앞 카테고리를 기본값으로 쓴다. */
export function resolveBookmarkCategoryId(
  selectedCategoryId: string | undefined,
  categories: readonly PortalCategoryLike[],
): string {
  if (
    selectedCategoryId
    && selectedCategoryId !== 'all'
    && categories.some(category => category.id === selectedCategoryId)
  ) {
    return selectedCategoryId;
  }
  return sortedPortalCategories(categories)[0]?.id ?? '';
}

/** 삭제로 order가 비어 있어도 기존 카테고리와 순서가 겹치지 않게 마지막에 붙인다. */
export function nextPortalCategoryOrder(categories: readonly PortalCategoryLike[]): number {
  return categories.reduce((highest, category) => Math.max(highest, category.order), -1) + 1;
}

/**
 * 배포 포털은 로컬 저장 뒤 Supabase를 갱신한다. 원격 delete가 실패해도 다음 저장이나
 * Pull 직전에 다시 시도할 수 있도록 삭제 대기 ID를 멱등 큐로 유지한다. 현재 데이터에
 * 다시 나타난 ID는 복원된 것으로 보고 큐에서 제거한다.
 */
export function buildPortalCloudDeleteQueue({
  pending,
  previousItemIds,
  nextItemIds,
  previousCategoryIds,
  nextCategoryIds,
}: PortalCloudDeleteQueueInput): PortalCloudDeleteQueue | undefined {
  const nextItems = new Set(nextItemIds);
  const nextCategories = new Set(nextCategoryIds);
  const itemIds = new Set(pending?.itemIds ?? []);
  const categoryIds = new Set(pending?.categoryIds ?? []);

  for (const id of previousItemIds) {
    if (!nextItems.has(id)) itemIds.add(id);
  }
  for (const id of previousCategoryIds) {
    if (!nextCategories.has(id)) categoryIds.add(id);
  }

  // 같은 ID가 import/복원으로 다시 생기면 원격에서도 삭제하지 않는다.
  for (const id of nextItems) itemIds.delete(id);
  for (const id of nextCategories) categoryIds.delete(id);

  const normalized: PortalCloudDeleteQueue = {
    itemIds: [...itemIds].filter(Boolean).sort(),
    categoryIds: [...categoryIds].filter(Boolean).sort(),
  };
  return normalized.itemIds.length > 0 || normalized.categoryIds.length > 0
    ? normalized
    : undefined;
}
