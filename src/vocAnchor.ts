/**
 * VOC(개선 요청) 한 건이 나중에도 "어디를 말하는지" 알아볼 수 있게 만드는 앵커.
 *
 * 코멘트는 남기는 순간이 아니라 **몇 주 뒤에** 쓰인다. 그때 "그 줄 세 번째 버튼"은 아무
 * 의미가 없다. 그래서 마크업에 이미 있는 안정된 이름을 우선순위대로 붙잡는다:
 *
 *   1. `data-help-key` — 사람이 설명을 쓰려고 직접 붙인 이름. 가장 오래 산다.
 *   2. `data-testid`   — 테스트가 붙잡고 있으므로 함부로 바뀌지 않는다.
 *   3. 보이는 텍스트 + 태그 + 조상 경로 — 위 둘이 없을 때의 마지막 수단.
 *
 * 스크린샷은 **일부러 담지 않는다.** 한 건에 수백 KB가 붙으면 폴더가 금세 무거워지고,
 * 정작 개선할 때 필요한 것은 그림이 아니라 이름이다.
 */

export interface VocAnchor {
  /** data-help-key. 있으면 이것만으로 코드에서 바로 찾을 수 있다. */
  helpKey?: string;
  /** data-testid. */
  testId?: string;
  /** 소문자 태그명 (button, div …). */
  tag: string;
  /** 보이는 텍스트 — 앵커가 약할 때 사람이 알아보는 유일한 단서다. */
  text: string;
  /** 조상 쪽 앵커들 (가까운 순). 요소 자체에 이름이 없을 때 위치를 좁힌다. */
  path: string[];
  /**
   * 드래그로 영역을 선택했을 때만 채워진다.
   *
   * 좌표(`region`)는 참고용일 뿐이고 **되찾는 근거는 `contains`** 다 — 창 크기가 바뀌면
   * 같은 좌표에 다른 것이 있다. 영역 안에 든 이름들이 위치를 복원하는 유일한 단서다.
   */
  region?: { width: number; height: number };
  /** 영역 안에 든, 이름이 붙은 요소들. */
  contains?: string[];
}

export interface VocRecord {
  id: string;
  createdAt: string;
  /** 앱 버전 — 어느 빌드에서 본 화면인지. */
  appVersion: string;
  /** 어느 탭에서 남겼는지. */
  tab: string;
  anchor: VocAnchor;
  /** 사용자가 쓴 내용. */
  comment: string;
  status: 'open';
}

const MAX_TEXT = 80;
const MAX_PATH = 4;

export function visibleTextOf(raw: string | null | undefined, limit = MAX_TEXT): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * 요소 하나를 앵커로 바꾼다.
 *
 * `path`는 **자기 자신을 뺀** 조상들의 이름만 담는다. 자기 이름을 path에 또 넣으면
 * 나중에 사람이 읽을 때 같은 값이 두 번 나와 어느 쪽이 대상인지 흐려진다.
 */
export function buildVocAnchor(el: {
  tagName: string;
  getAttribute: (name: string) => string | null;
  textContent: string | null;
  parentElement: unknown;
}): VocAnchor {
  const helpKey = el.getAttribute('data-help-key')?.trim() || undefined;
  const testId = el.getAttribute('data-testid')?.trim() || undefined;
  const path: string[] = [];
  let cur = el.parentElement as (typeof el & { parentElement: unknown }) | null;
  while (cur && path.length < MAX_PATH) {
    const name = cur.getAttribute?.('data-help-key')?.trim() || cur.getAttribute?.('data-testid')?.trim();
    if (name) path.push(name);
    cur = cur.parentElement as (typeof el & { parentElement: unknown }) | null;
  }
  return {
    ...(helpKey ? { helpKey } : {}),
    ...(testId ? { testId } : {}),
    tag: (el.tagName || '').toLowerCase(),
    text: visibleTextOf(el.textContent),
    path,
  };
}

/**
 * 프론트에서 넘어온 앵커를 믿을 수 있는 모양으로 정리한다.
 *
 * 서버는 이 값으로 **파일명**을 만든다. 즉 앵커는 파일시스템에 닿는 입력이므로,
 * 모양을 맞추는 것으로 끝내지 않고 문자열이 아닌 값·과도한 길이를 여기서 잘라낸다.
 */
export function normalizeVocAnchor(raw: unknown): VocAnchor {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown): string | undefined => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text.slice(0, 120) : undefined;
  };
  const path = Array.isArray(source.path)
    ? source.path.filter((v): v is string => typeof v === 'string').slice(0, MAX_PATH).map(v => v.slice(0, 120))
    : [];
  const contains = Array.isArray(source.contains)
    ? source.contains.filter((v): v is string => typeof v === 'string').slice(0, 12).map(v => v.slice(0, 120))
    : undefined;
  const rawRegion = (source.region && typeof source.region === 'object' ? source.region : null) as
    | Record<string, unknown>
    | null;
  const num = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  };
  return {
    ...(str(source.helpKey) ? { helpKey: str(source.helpKey)! } : {}),
    ...(str(source.testId) ? { testId: str(source.testId)! } : {}),
    tag: str(source.tag)?.toLowerCase() ?? '',
    text: visibleTextOf(typeof source.text === 'string' ? source.text : ''),
    path,
    ...(rawRegion ? { region: { width: num(rawRegion.width), height: num(rawRegion.height) } } : {}),
    ...(contains ? { contains } : {}),
  };
}

/**
 * 드래그로 고른 영역의 앵커.
 *
 * 영역 안에 이름 붙은 요소가 하나도 없을 수 있다(빈 여백, 그림 영역). 그때도 앵커는
 * 만들어져야 한다 — 그런 자리야말로 "여기 허전하다"는 요청이 나오는 곳이다.
 */
export function buildRegionAnchor(
  size: { width: number; height: number },
  contains: string[],
): VocAnchor {
  return {
    tag: 'region',
    text: '',
    path: [],
    region: { width: Math.round(size.width), height: Math.round(size.height) },
    contains,
  };
}

/** 앵커를 한 줄로 — 목록과 파일명에 함께 쓴다. */
export function describeVocAnchor(anchor: VocAnchor): string {
  if (anchor.helpKey) return anchor.helpKey;
  if (anchor.testId) return anchor.testId;
  // 영역은 안에 든 것으로 부른다. 첫 이름만으로도 어디였는지 대개 되살아난다.
  if (anchor.region) {
    const first = anchor.contains?.[0];
    const more = (anchor.contains?.length ?? 0) - 1;
    if (first) return more > 0 ? `영역-${first}-외${more}` : `영역-${first}`;
    return `영역-${anchor.region.width}x${anchor.region.height}`;
  }
  if (anchor.text) return anchor.text;
  return anchor.path[0] ?? anchor.tag ?? 'unknown';
}

/**
 * 파일명에 쓸 안전한 조각.
 *
 * 한글을 로마자로 바꾸지 않고 **그대로 남긴다** — Finder에서 사람이 훑어볼 파일이라
 * 알아볼 수 있는 편이 중요하다. 경로를 깨뜨리는 문자만 없앤다.
 */
export function vocSlug(value: string, limit = 40): string {
  const cleaned = (value || '')
    // `-`는 클래스 **맨 앞**에 둔다. 가운데 두면(`| -`) '|'~' ' 범위로 해석돼 정규식
    // 파싱 자체가 깨진다 — 실제로 한 번 깨뜨렸다.
    .replace(/[-/\\:*?"<>|\s]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = cleaned.slice(0, limit).replace(/-+$/g, '');
  return slug || 'voc';
}

/** `2026-08-13-2231` — 파일명이 시간순으로 정렬되게 한다. */
export function vocTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00-00-0000';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 저장 파일명. 시간 + 앵커라서 폴더만 봐도 무엇에 대한 건지 읽힌다. */
export function vocFileName(record: Pick<VocRecord, 'createdAt' | 'anchor'>): string {
  return `${vocTimestamp(record.createdAt)}-${vocSlug(describeVocAnchor(record.anchor))}.json`;
}
