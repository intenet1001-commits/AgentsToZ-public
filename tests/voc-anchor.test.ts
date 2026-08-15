import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildRegionAnchor,
  buildVocAnchor,
  describeVocAnchor,
  normalizeVocAnchor,
  visibleTextOf,
  vocFileName,
  vocSlug,
  vocTimestamp,
} from '../src/vocAnchor';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const overlaySource = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
const guideSource = readFileSync(new URL('../src/guide/GuideMode.tsx', import.meta.url), 'utf8');
const pickSource = readFileSync(new URL('../src/guide/pickTarget.ts', import.meta.url), 'utf8');

/** DOM 없이 앵커 추출을 검사하기 위한 최소 요소. */
function fakeEl(attrs: Record<string, string>, text: string, parent: any = null): any {
  return {
    tagName: attrs.tag ?? 'BUTTON',
    textContent: text,
    parentElement: parent,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

describe('앵커 추출', () => {
  test('data-help-key가 최우선이다', () => {
    const el = fakeEl({ 'data-help-key': 'btn-guide-toggle', 'data-testid': 'guide' }, '가이드');
    const anchor = buildVocAnchor(el);
    expect(anchor.helpKey).toBe('btn-guide-toggle');
    expect(anchor.testId).toBe('guide');
    expect(describeVocAnchor(anchor)).toBe('btn-guide-toggle');
  });

  test('help-key가 없으면 testid로 떨어진다', () => {
    const anchor = buildVocAnchor(fakeEl({ 'data-testid': 'project-hermes-app' }, 'Hermes 앱'));
    expect(anchor.helpKey).toBeUndefined();
    expect(describeVocAnchor(anchor)).toBe('project-hermes-app');
  });

  test('둘 다 없으면 보이는 텍스트가 단서가 된다', () => {
    const anchor = buildVocAnchor(fakeEl({}, '  강제  재실행 '));
    expect(anchor.text).toBe('강제 재실행');
    expect(describeVocAnchor(anchor)).toBe('강제 재실행');
  });

  test('조상 앵커를 가까운 순으로 최대 4개 담는다', () => {
    let node: any = null;
    for (const name of ['root', 'a', 'b', 'c', 'd', 'e']) node = fakeEl({ 'data-testid': name }, '', node);
    const anchor = buildVocAnchor(fakeEl({}, '나', node));
    expect(anchor.path).toEqual(['e', 'd', 'c', 'b']);
  });

  test('자기 이름은 path에 넣지 않는다', () => {
    const parent = fakeEl({ 'data-testid': 'parent' }, '');
    const anchor = buildVocAnchor(fakeEl({ 'data-testid': 'me' }, '나', parent));
    expect(anchor.path).toEqual(['parent']);
    expect(anchor.path).not.toContain('me');
  });

  test('긴 텍스트는 자른다', () => {
    expect(visibleTextOf('가'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(visibleTextOf('가'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('영역 선택', () => {
  test('안에 든 이름으로 부른다 — 좌표는 창 크기가 바뀌면 의미가 없다', () => {
    const anchor = buildRegionAnchor({ width: 389.4, height: 45.2 }, ['header-claude-launch', 'header-codex-launch']);
    expect(anchor.tag).toBe('region');
    expect(anchor.region).toEqual({ width: 389, height: 45 });
    expect(describeVocAnchor(anchor)).toBe('영역-header-claude-launch-외1');
  });

  test('하나만 들었으면 「외N」을 붙이지 않는다', () => {
    expect(describeVocAnchor(buildRegionAnchor({ width: 10, height: 10 }, ['solo']))).toBe('영역-solo');
  });

  test('빈 여백을 골라도 앵커가 만들어진다 — 거기가 개선 요청이 나오는 자리다', () => {
    const anchor = buildRegionAnchor({ width: 400, height: 130 }, []);
    expect(describeVocAnchor(anchor)).toBe('영역-400x130');
    expect(vocFileName({ createdAt: new Date(2026, 7, 13, 22, 50).toISOString(), anchor }))
      .toBe('2026-08-13-2250-영역-400x130.json');
  });

  test('영역 앵커도 서버 정리를 통과해 살아남는다', () => {
    // 한 번 실패했다: 서버가 옛 코드를 물고 있어 region/contains가 통째로 사라졌다.
    const normalized = normalizeVocAnchor(buildRegionAnchor({ width: 389, height: 45 }, ['a', 'b']));
    expect(normalized.region).toEqual({ width: 389, height: 45 });
    expect(normalized.contains).toEqual(['a', 'b']);
  });

  test('contains는 12개로 자른다', () => {
    const normalized = normalizeVocAnchor({ region: { width: 1, height: 1 }, contains: Array(40).fill('x') });
    expect(normalized.contains!.length).toBe(12);
  });

  test('숫자가 아닌 크기는 0으로 떨어진다', () => {
    const normalized = normalizeVocAnchor({ region: { width: 'huge', height: null } });
    expect(normalized.region).toEqual({ width: 0, height: 0 });
  });
});

describe('신뢰할 수 없는 입력 정리', () => {
  test('객체가 아니어도 안전한 모양을 돌려준다', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const anchor = normalizeVocAnchor(bad);
      expect(anchor.tag).toBe('');
      expect(anchor.path).toEqual([]);
    }
  });

  test('문자열이 아닌 값은 버린다', () => {
    const anchor = normalizeVocAnchor({ helpKey: 5, testId: {}, tag: 'BUTTON', path: ['a', 7, null] });
    expect(anchor.helpKey).toBeUndefined();
    expect(anchor.testId).toBeUndefined();
    expect(anchor.tag).toBe('button');
    expect(anchor.path).toEqual(['a']);
  });

  test('과도한 길이를 자른다 — 이 값이 파일명이 된다', () => {
    const anchor = normalizeVocAnchor({ helpKey: 'k'.repeat(500), path: Array(50).fill('p') });
    expect(anchor.helpKey!.length).toBeLessThanOrEqual(120);
    expect(anchor.path.length).toBeLessThanOrEqual(4);
  });
});

describe('파일명', () => {
  test('경로를 깨뜨리는 문자를 없앤다', () => {
    expect(vocSlug('../../etc/passwd')).not.toContain('/');
    expect(vocSlug('a/b\\c:d*e?f"g<h>i|j')).not.toMatch(/[/\\:*?"<>|]/);
  });

  test('한글은 그대로 남긴다 — Finder에서 사람이 읽는다', () => {
    expect(vocSlug('강제 재실행')).toBe('강제-재실행');
  });

  test('빈 값이어도 파일명이 나온다', () => {
    expect(vocSlug('')).toBe('voc');
    expect(vocSlug('///')).toBe('voc');
  });

  test('시간순으로 정렬되는 이름을 만든다', () => {
    const name = vocFileName({
      createdAt: new Date(2026, 7, 13, 22, 31).toISOString(),
      anchor: { helpKey: 'btn-guide-toggle', tag: 'button', text: '', path: [] },
    });
    expect(name).toBe('2026-08-13-2231-btn-guide-toggle.json');
  });

  test('깨진 시각에도 던지지 않는다', () => {
    expect(vocTimestamp('nonsense')).toBe('0000-00-00-0000');
  });
});

describe('배선', () => {
  test('서버는 앱 데이터 폴더의 voc/ 에 한 건당 파일 하나로 쓴다', () => {
    expect(apiSource).toContain('const dir = join(APP_DATA_DIR, "voc");');
    expect(apiSource).toContain('const anchor = normalizeVocAnchor(body.anchor);');
    expect(apiSource).toContain('vocFileName(record)');
  });

  test('같은 이름이 있으면 덮어쓰지 않는다', () => {
    // 같은 분에 같은 요소를 두 번 남길 수 있다. 덮어쓰면 방금 쓴 글이 사라진다.
    expect(apiSource).toContain('for (let n = 2; existsSync(file); n += 1)');
  });

  test('빈 코멘트는 거절한다', () => {
    expect(apiSource).toContain('내용이 비어 있습니다.');
  });

  test('오버레이는 lazy — 끄면 청크를 내려받지 않는다', () => {
    expect(appSource).toContain("const VocOverlay = lazy(() => import('./voc/VocOverlay')");
    expect(appSource).toContain('{vocMode && (');
  });

  test('가이드 모드와 배타적이다 — 둘 다 전체 화면 오버레이다', () => {
    expect(appSource).toContain('setVocMode(v => !v); setGuideMode(false);');
  });

  test('대상 선택 규칙을 가이드 모드와 공유한다', () => {
    expect(overlaySource).toContain("from '../guide/pickTarget';");
    expect(overlaySource).toContain('findTargetAt(');
    expect(guideSource).toContain("import { findTargetAt } from './pickTarget';");
  });

  test('고른 뒤에는 커서를 따라가지 않는다 — rAF 추적 없음', () => {
    expect(overlaySource).toContain('if (picked) return; // 고정된 뒤에는 커서를 따라가지 않는다');
    expect(overlaySource).not.toContain('requestAnimationFrame');
  });

  test('버튼이 아닌 요소도 고를 수 있다', () => {
    // 가이드 모드는 "설명할 수 있는 것"만 집으면 되지만, VOC는 불만이 있는 모든 곳을
    // 집을 수 있어야 한다. 제목·문구·여백이 오히려 요청이 많이 나오는 자리다.
    expect(overlaySource).toContain("findTargetAt(e.clientX, e.clientY, { allowAny: true })");
    expect(pickSource).toContain('return fallback ?? (options.allowAny ? anyElement : null);');
  });

  test('끌면 영역, 살짝 흔들리면 클릭 — 손떨림을 영역으로 오해하지 않는다', () => {
    expect(overlaySource).toContain('const DRAG_THRESHOLD_PX = 6;');
    expect(overlaySource).toContain('rect.width >= MIN_REGION_PX && rect.height >= MIN_REGION_PX');
  });

  test('어느 방향으로 끌어도 같은 사각형이 된다', () => {
    expect(overlaySource).toContain('left: Math.min(d.x0, d.x1),');
    expect(overlaySource).toContain('width: Math.abs(d.x1 - d.x0),');
  });

  test('영역 조회는 이름 붙은 요소만 훑고 상한이 있다', () => {
    // 전체 DOM 순회가 아니다 — 프로젝트 수가 늘어도 비용이 그대로여야 한다.
    expect(pickSource).toContain("querySelectorAll<HTMLElement>('[data-help-key],[data-testid]')");
    expect(pickSource).toContain('if (names.length >= limit) break;');
  });

  test('저장 실패 시 쓴 글을 지우지 않는다', () => {
    expect(overlaySource).toContain('if (ok) reset();');
  });

  test('VOC 모드는 저장하지 않는다 — 켠 채로 재시작하면 클릭이 전부 막힌다', () => {
    expect(appSource).toContain('const [vocMode, setVocMode] = useState(false);');
  });
});
