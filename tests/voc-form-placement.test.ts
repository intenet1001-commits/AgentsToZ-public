import { describe, expect, test } from 'bun:test';
import { placeVocForm } from '../src/voc/vocFormPlacement';

describe('VOC 입력창 배치', () => {
  test('작고 확대된 창에서도 오른쪽과 아래가 잘리지 않는다', () => {
    const viewport = { width: 429, height: 508 };
    const placement = placeVocForm({ top: 40, left: 20, width: 609, height: 282 }, viewport, 36);
    expect(placement.width).toBe(360);
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(viewport.height - 12);
    expect(placement.top).toBe(48);
  });

  test('대상 아래에 충분한 공간이 있으면 가까이 붙인다', () => {
    const placement = placeVocForm({ top: 60, left: 100, width: 200, height: 40 }, { width: 900, height: 800 }, 36);
    expect(placement.top).toBe(110);
    expect(placement.left).toBe(100);
  });

  test('대상 위에만 공간이 있으면 위쪽에 배치한다', () => {
    const placement = placeVocForm({ top: 500, left: 700, width: 100, height: 80 }, { width: 900, height: 650 }, 36);
    expect(placement.top).toBe(210);
    expect(placement.left + placement.width).toBeLessThanOrEqual(888);
  });

  test('아주 좁은 창에서는 좌우 여백을 남기고 폭을 줄인다', () => {
    const placement = placeVocForm({ top: 50, left: 0, width: 100, height: 50 }, { width: 260, height: 500 }, 36);
    expect(placement.width).toBe(236);
    expect(placement.left).toBe(12);
  });
});
