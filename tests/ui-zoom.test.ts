import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN,
  applyZoomToDocument, clampZoom, clearDocumentZoom, formatZoom, parseStoredZoom, roundZoom, zoomIn, zoomOut,
} from '../src/uiZoom';

describe('uiZoom', () => {
  // 기본이 1.0 이면 "글씨가 작다"가 그대로 남는다. 한 단계 큰 값에서 시작한다.
  test('starts larger than 1.0 by default', () => {
    expect(UI_ZOOM_DEFAULT).toBeGreaterThan(1);
    expect(parseStoredZoom(null)).toBe(UI_ZOOM_DEFAULT);
  });

  test('opens far enough for "much larger"', () => {
    expect(UI_ZOOM_MAX).toBeGreaterThanOrEqual(2);
  });

  test('clamps to the supported range', () => {
    expect(clampZoom(99)).toBe(UI_ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(UI_ZOOM_MIN);
  });

  // 배율은 앱 전체의 첫인상이다. 깨진 저장값에서 화면이 이상해지면 사용자는 설정이
  // 아니라 앱이 고장 났다고 읽는다 — 조용히 기본값으로 떨어진다.
  test('falls back to the default on unusable stored values', () => {
    for (const raw of ['', '   ', 'abc', 'NaN', '0', '-2', null, undefined]) {
      expect(parseStoredZoom(raw as string | null)).toBe(UI_ZOOM_DEFAULT);
    }
  });

  test('a stored value inside the range survives a round trip', () => {
    expect(parseStoredZoom(String(1.4))).toBe(1.4);
  });

  // 스텝을 반복해도 1.2499999 같은 값이 저장되지 않아야 표기가 흔들리지 않는다.
  test('stepping never accumulates float drift', () => {
    let value = UI_ZOOM_DEFAULT;
    for (let i = 0; i < 12; i += 1) value = zoomIn(value);
    for (let i = 0; i < 12; i += 1) value = zoomOut(value);
    expect(value).toBe(roundZoom(value));
    expect(value).toBe(UI_ZOOM_DEFAULT);
  });

  test('stepping stops at the ends instead of running away', () => {
    let high = UI_ZOOM_MAX;
    for (let i = 0; i < 5; i += 1) high = zoomIn(high);
    expect(high).toBe(UI_ZOOM_MAX);
    let low = UI_ZOOM_MIN;
    for (let i = 0; i < 5; i += 1) low = zoomOut(low);
    expect(low).toBe(UI_ZOOM_MIN);
  });

  test('formats without decimals so the control does not jitter', () => {
    expect(formatZoom(1.25)).toBe('125%');
    expect(formatZoom(1)).toBe('100%');
  });

  test('applies a hit-test-safe transform and inverse viewport to the app root', () => {
    const root = { style: {} as Record<string, string> };
    applyZoomToDocument({ documentElement: root } as unknown as Document, 1.4);
    expect(root.style.zoom).toBe('');
    expect(root.style.transform).toBe('scale(1.4)');
    expect(root.style.transformOrigin).toBe('top left');
    expect(parseFloat(root.style.width ?? '')).toBeCloseTo(100 / 1.4);
    expect(() => applyZoomToDocument(null, 1.2)).not.toThrow();
  });
});

// CSS `zoom`은 실제 Chrome에서 보이는 버튼과 hit-test 좌표를 갈라 놓았다. 이 단위
// 검사는 스타일 계약을 고정하고, 실제 클릭 가능 여부는 E2E가 판정한다.
describe('browser zoom fallback cleanup', () => {
  test('keeps popup width in logical viewport units and removes it for native zoom', () => {
    const properties = new Map<string, string>();
    const root = { style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    } };
    const doc = { documentElement: root } as unknown as Document;
    for (const zoom of [1, 1.25, 2]) {
      applyZoomToDocument(doc, zoom);
      expect(parseFloat(properties.get('--ui-viewport-width')!) * zoom).toBeCloseTo(100);
    }
    clearDocumentZoom(doc);
    expect(properties.has('--ui-viewport-width')).toBe(false);
  });

  test('removes the transform before Tauri native webview zoom is used', () => {
    const root = { style: {} as Record<string, string> };
    applyZoomToDocument({ documentElement: root } as unknown as Document, 1.6);
    clearDocumentZoom({ documentElement: root } as unknown as Document);
    expect(root.style.zoom).toBe('');
    expect(root.style.transform).toBe('');
    expect(root.style.width).toBe('');
  });
});

describe('header control', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');
  test('exposes the control and both directions', () => {
    for (const id of ['header-ui-zoom', 'header-ui-zoom-in', 'header-ui-zoom-out', 'header-ui-zoom-reset']) {
      expect(app).toContain(id);
    }
  });
  test('binds the keyboard shortcuts', () => {
    expect(app).toContain("event.key === '0'");
    expect(app).toContain('event.preventDefault(); setUiZoom(zoomIn)');
  });
  // The tool group now wraps instead of scrolling behind a hidden scrollbar
  // (tests/header-toolbar-overflow.test.ts owns that contract); New project must
  // still sit outside it so its position does not move as tools wrap.
  test('keeps New project outside the wrapping tool group', () => {
    const actions = app.indexOf('data-testid="project-main-actions"');
    const newProject = app.indexOf('data-testid="header-new-project"');
    expect(actions).toBeGreaterThan(0);
    expect(newProject).toBeGreaterThan(actions);
    expect(app.slice(actions, newProject)).toContain('</div>');
  });
});

describe('app shell never lets the document scroll', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  /**
   * 실측(설치본 v336, 배율 125%): 「내가 한 말」 패널 끝에서 스크롤이 문서로
   * 이어지면 고정 높이 셸이 통째로 위로 밀리고 아래에 빈 바닥이 남은 채 유지됐다
   * — VOC 2026-09-01 "밑에 여백이 남는 오류".
   */
  test('pins html and body so scrolling cannot move the shell', () => {
    expect(css).toContain('html.app-shell-fixed,\nbody.app-shell-fixed {');
    const rule = css.slice(css.indexOf('html.app-shell-fixed,'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('overflow: hidden');
  });

  // 스크롤 요소는 body 가 아니라 documentElement 다. body 에만 걸면 문서는
  // 그대로 스크롤된다 (실측: body overflow hidden 상태에서 html 이 376px 이동).
  test('applies the class to documentElement as well as body', () => {
    expect(app).toContain('[document.documentElement, document.body]');
    expect(app).toContain("classList.add('app-shell-fixed')");
    expect(app).toContain("classList.remove('app-shell-fixed')");
  });

  // index.css 는 포털·가이드·설치 페이지도 함께 쓴다. 그쪽은 정상적으로 스크롤되는
  // 문서이므로 전역 html/body 규칙으로 올리면 그 페이지들이 잘린다.
  test('does not pin every page that shares index.css', () => {
    expect(css).not.toMatch(/^html,\s*\n?body \{[^}]*overflow:\s*hidden/m);
    for (const entry of ['portal-main.tsx', 'onboarding-guide-main.tsx', 'setup-main.tsx']) {
      const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
      expect(source).not.toContain('app-shell-fixed');
    }
  });
});
