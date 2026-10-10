import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isVocShortcut } from '../src/vocShortcut';
import { pickOverlayHost } from '../src/topLayerHost';

const key = (over: Partial<KeyboardEvent>) => ({ metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'V', code: 'KeyV', repeat: false, ...over }) as KeyboardEvent;

test('⌘⇧V는 한글 입력·조합 중에도 물리 키로 잡힌다', () => {
  expect(isVocShortcut(key({}))).toBe(true);
  expect(isVocShortcut(key({ key: 'ㅍ' }))).toBe(true);
  expect(isVocShortcut(key({ key: 'Process' }))).toBe(true);
  expect(isVocShortcut(key({ metaKey: false, ctrlKey: true }))).toBe(true);
});

test('다른 조합은 무시한다', () => {
  expect(isVocShortcut(key({ shiftKey: false }))).toBe(false); // 붙여넣기
  expect(isVocShortcut(key({ altKey: true }))).toBe(false); // 서식 없이 붙여넣기
  expect(isVocShortcut(key({ repeat: true }))).toBe(false); // 누르고 있으면 켜졌다 꺼졌다 반복하지 않는다
  expect(isVocShortcut(key({ code: 'KeyB', key: 'v' }))).toBe(false); // 물리 키가 우선
  expect(isVocShortcut(key({ code: '', key: 'v' }))).toBe(true); // code 없는 이벤트만 key 폴백
});

function fakeDoc(dialogs: Array<{ modal: boolean }>, focusedIndex = -1) {
  const body = { tag: 'body' };
  const els = dialogs.map(d => ({ matches: (s: string) => s === ':modal' && d.modal }));
  const active = focusedIndex >= 0 ? { closest: () => els[focusedIndex] } : null;
  const g = globalThis as { Element?: unknown };
  const prev = g.Element;
  class FakeElement {}
  if (active) Object.setPrototypeOf(active, FakeElement.prototype);
  g.Element = FakeElement;
  const doc = { body, activeElement: active, querySelectorAll: () => els } as unknown as Document;
  return { doc, body, els, restore: () => { g.Element = prev; } };
}

test('모달이 없으면 body, 있으면 모달 안에 붙인다', () => {
  let f = fakeDoc([]);
  expect(pickOverlayHost(f.doc)).toBe(f.body as unknown as HTMLElement); f.restore();
  f = fakeDoc([{ modal: false }]);
  expect(pickOverlayHost(f.doc)).toBe(f.body as unknown as HTMLElement); f.restore(); // show()로 연 비모달은 top layer가 아니다
  f = fakeDoc([{ modal: true }, { modal: true }]);
  expect(pickOverlayHost(f.doc)).toBe(f.els[1] as unknown as HTMLElement); f.restore();
  f = fakeDoc([{ modal: true }, { modal: true }], 0);
  expect(pickOverlayHost(f.doc)).toBe(f.els[0] as unknown as HTMLElement); f.restore(); // 포커스가 든 모달 우선
});

test('App은 두 오버레이를 호스트에 붙이고 단축키는 window capture로 받는다', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  expect(app).toContain("window.addEventListener('keydown', onKey, true)");
  expect(app).toContain('if (!isVocShortcut(e)) return;');
  expect(app.match(/overlayHost \?\? document\.body/g)?.length).toBe(2);
});
