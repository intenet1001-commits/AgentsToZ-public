/**
 * 화면 배율. "글씨가 너무 작다"에 대한 답이 **폰트 크기 모드가 아닌** 이유:
 *
 * 이 앱의 글자 크기는 `fontSize: 10` 꼴의 px 리터럴 **325곳**에 박혀 있고 `rem` 을 쓰지
 * 않는다. 그래서 루트 폰트 크기를 키워도 따라오지 않는다. 325곳을 스케일 함수로 바꾸더라도
 * `padding`·`width`·아이콘 크기는 여전히 고정이라, 크게 키우면 글자가 버튼을 넘친다.
 *
 * 배율은 폰트·여백·아이콘이 **함께** 커지므로 그 문제가 없고, 적용 지점도 한 곳이다.
 */

export const UI_ZOOM_STORAGE_KEY = 'portmanager-ui-zoom';

/** 지금까지의 기본(1.0)은 작다는 보고가 반복됐다. 한 단계 큰 값을 기본으로 둔다. */
export const UI_ZOOM_DEFAULT = 1.25;
export const UI_ZOOM_MIN = 0.8;
/** "지금보다 훨씬 크게까지" 가 요구사항이라 위쪽을 넉넉히 연다. */
export const UI_ZOOM_MAX = 2.4;
export const UI_ZOOM_STEP = 0.05;

/** 부동소수 누적 오차로 1.2499999 같은 값이 저장되지 않게 2자리로 고정한다. */
export function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return UI_ZOOM_DEFAULT;
  return roundZoom(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value)));
}

/**
 * 저장값 해석. 깨진 값은 **조용히 기본값**으로 떨어진다 — 배율은 앱 전체의 첫인상이라,
 * 파싱 실패로 화면이 이상해지면 사용자는 설정이 아니라 앱이 고장 났다고 읽는다.
 * (`AI 표시` 설정이 깨진 값에서 "다 보임"으로 떨어지는 것과 같은 원칙.)
 */
export function parseStoredZoom(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return UI_ZOOM_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return UI_ZOOM_DEFAULT;
  return clampZoom(parsed);
}

export function zoomIn(current: number): number {
  return clampZoom(current + UI_ZOOM_STEP);
}

export function zoomOut(current: number): number {
  return clampZoom(current - UI_ZOOM_STEP);
}

/** 버튼에 보여줄 표기. 소수점을 남기면 폭이 흔들려 옆 버튼이 밀린다. */
export function formatZoom(value: number): string {
  return `${Math.round(clampZoom(value) * 100)}%`;
}

/**
 * 브라우저 모드의 배율 폴백.
 *
 * 문서 루트에 CSS `zoom`을 주면 Chrome/WebKit에서 보이는 위치와 포인터 hit-test 위치가
 * 갈라진다. 실제 Playwright 사용자 흐름에서 125%의 「다음」 버튼을 `<html>`이 가로채
 * 온보딩이 진행되지 않았고, 같은 이유로 VOC 드래그 좌표도 어긋났다.
 *
 * `transform`은 브라우저가 hit-test까지 함께 변환하므로 클릭 좌표가 맞는다. 대신 원래
 * viewport 크기의 박스를 그대로 확대하면 오른쪽/아래가 잘리므로 root와 `h-screen`에
 * 역수 viewport를 제공한다. Tauri 앱은 이 폴백보다 네이티브 webview zoom을 사용한다.
 */
export function applyZoomToDocument(doc: Document | null | undefined, value: number): void {
  const root = doc?.getElementById?.('root') ?? doc?.documentElement;
  if (!root) return;
  const zoom = clampZoom(value);
  const inverse = 1 / zoom;

  // 이전 CSS zoom 구현이 HMR 뒤에 남아 있으면 transform과 이중 적용된다.
  if (doc?.documentElement) (doc.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = '';
  if (doc?.body) (doc.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = '';

  const style = root.style as CSSStyleDeclaration & { zoom?: string };
  style.zoom = '';
  style.transform = `scale(${zoom})`;
  style.transformOrigin = 'top left';
  style.width = `${inverse * 100}%`;
  style.height = `${inverse * 100}dvh`;
  style.setProperty?.('--ui-viewport-height', `${inverse * 100}dvh`);
  style.setProperty?.('--ui-banner-logical-height', `${36 * inverse}px`);
  root.setAttribute?.('data-ui-zoom-mode', 'css-transform');
}

/** Tauri 네이티브 zoom을 쓰기 전에 브라우저 폴백 흔적을 지운다. */
export function clearDocumentZoom(doc: Document | null | undefined): void {
  const root = doc?.getElementById?.('root') ?? doc?.documentElement;
  if (!root) return;
  const style = root.style as CSSStyleDeclaration & { zoom?: string };
  style.zoom = '';
  style.transform = '';
  style.transformOrigin = '';
  style.width = '';
  style.height = '';
  style.removeProperty?.('--ui-viewport-height');
  style.removeProperty?.('--ui-banner-logical-height');
  root.removeAttribute?.('data-ui-zoom-mode');
  if (doc?.documentElement) (doc.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = '';
  if (doc?.body) (doc.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = '';
}
