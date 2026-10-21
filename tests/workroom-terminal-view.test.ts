import {describe, expect, test} from 'bun:test';
import {WORKROOM_FONT_DEFAULT, WORKROOM_FONT_MAX, WORKROOM_FONT_MIN, WORKROOM_REMOTE_FONT_NARROW, WORKROOM_REMOTE_FONT_WIDE, readWorkroomFontSize, readWorkroomWide, remoteWorkroomFontFloor, stepWorkroomFontSize, writeWorkroomFontSize, writeWorkroomWide, initialWorkroomFontSize, readWorkroomRemoteFontSize, writeWorkroomRemoteFontSize} from '../src/workroomTerminalView';

const memory = () => { const m = new Map<string, string>(); return {getItem:(k:string)=>m.get(k)??null, setItem:(k:string,v:string)=>{m.set(k,v);}, map:m}; };

describe('Workroom terminal view preferences (per device)', () => {
  test('font size steps by one point inside a readable range', () => {
    expect(WORKROOM_FONT_DEFAULT).toBe(13);
    expect(stepWorkroomFontSize(13, 1)).toBe(14);
    expect(stepWorkroomFontSize(13, -1)).toBe(12);
    expect(stepWorkroomFontSize(WORKROOM_FONT_MAX, 1)).toBe(WORKROOM_FONT_MAX);
    expect(stepWorkroomFontSize(WORKROOM_FONT_MIN, -1)).toBe(WORKROOM_FONT_MIN);
  });
  test('stored values round-trip and broken values fall back quietly', () => {
    const s = memory();
    expect(readWorkroomFontSize(s)).toBe(WORKROOM_FONT_DEFAULT);
    writeWorkroomFontSize(s, 16); expect(readWorkroomFontSize(s)).toBe(16);
    for (const bad of ['', 'abc', '0', '999', '12.5', 'NaN']) { s.setItem('portmanager-workroom-font-size', bad); expect(readWorkroomFontSize(s)).toBe(WORKROOM_FONT_DEFAULT); }
    expect(readWorkroomWide(s)).toBe(false);
    writeWorkroomWide(s, true); expect(readWorkroomWide(s)).toBe(true);
    writeWorkroomWide(s, false); expect(readWorkroomWide(s)).toBe(false);
  });
  test('a storage that throws (private mode) never breaks the terminal', () => {
    const broken = {getItem(){throw Error('denied');}, setItem(){throw Error('denied');}};
    expect(readWorkroomFontSize(broken)).toBe(WORKROOM_FONT_DEFAULT);
    expect(readWorkroomWide(broken)).toBe(false);
    expect(() => { writeWorkroomFontSize(broken, 15); writeWorkroomWide(broken, true); }).not.toThrow();
    expect(readWorkroomFontSize(null)).toBe(WORKROOM_FONT_DEFAULT);
  });
});

describe('the size a remote screen starts at (VOC 2026-10-05, 아이폰 17 Pro)', () => {
  // 호스트의 100칸 줄을 폰 너비에서 다시 접으므로, 16px이면 한 줄이 서너 줄로 접혀 깨진 것처럼 보였다.
  // 실측(402px 폭·WebKit): 같은 줄이 16px에서 3줄, 12px에서 2줄.
  test('starts smaller on a phone and keeps 16 on a tablet or desktop', () => {
    expect(remoteWorkroomFontFloor(402)).toBe(WORKROOM_REMOTE_FONT_NARROW);
    expect(remoteWorkroomFontFloor(640)).toBe(WORKROOM_REMOTE_FONT_NARROW);
    expect(remoteWorkroomFontFloor(744)).toBe(WORKROOM_REMOTE_FONT_WIDE);
    expect(remoteWorkroomFontFloor(1280)).toBe(WORKROOM_REMOTE_FONT_WIDE);
  });

  test('an unknown viewport keeps the old behaviour', () => {
    expect(remoteWorkroomFontFloor(0)).toBe(WORKROOM_REMOTE_FONT_WIDE);
  });

  // 이 값은 **시작값**일 뿐이다 — A−는 여전히 10까지 내려가고 A+는 24까지 올라간다.
  test('it is only a starting point; the buttons still reach the real bounds', () => {
    expect(WORKROOM_REMOTE_FONT_NARROW).toBeGreaterThanOrEqual(WORKROOM_FONT_MIN);
    expect(WORKROOM_REMOTE_FONT_WIDE).toBeLessThanOrEqual(WORKROOM_FONT_MAX);
    expect(stepWorkroomFontSize(WORKROOM_REMOTE_FONT_NARROW, -1)).toBeLessThan(WORKROOM_REMOTE_FONT_NARROW);
  });
});

describe('the phone keeps the size it chose, and only that', () => {
  const memory = () => { const m = new Map<string, string>(); return {getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m}; };
  test('an old auto-saved 16 no longer pins a phone at 16 (iPhone, 2026-10-07)', () => {
    const storage = memory();
    writeWorkroomFontSize(storage, 16);  // what the old save-on-mount left behind
    expect(initialWorkroomFontSize(true, 402, storage)).toBe(WORKROOM_REMOTE_FONT_NARROW);
    // The Mac's own workroom still reads its size.
    expect(initialWorkroomFontSize(false, 1280, storage)).toBe(16);
  });
  test('a size picked with A−/A+ is kept, below the starting size too', () => {
    const storage = memory();
    writeWorkroomRemoteFontSize(storage, 10);
    expect(readWorkroomRemoteFontSize(storage)).toBe(10);
    expect(initialWorkroomFontSize(true, 402, storage)).toBe(10);
    writeWorkroomRemoteFontSize(storage, 99 as number);
    expect(readWorkroomRemoteFontSize(storage)).toBeNull();
    expect(initialWorkroomFontSize(true, 402, storage)).toBe(WORKROOM_REMOTE_FONT_NARROW);
  });
});
