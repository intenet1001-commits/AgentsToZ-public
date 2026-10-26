import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
  BROWSER_RESERVED_SHORTCUTS,browserShortcut,browserTabShortcutKey,isReservedBrowserShortcut,
  type BrowserKeyEvent,type BrowserShortcutContext,
} from '../src/workroomBrowserShortcuts';
import {BROWSER_TAB_LIMIT} from '../src/workroomBrowserProtocol';

const press = (key: string, over: Partial<BrowserKeyEvent> = {}): BrowserKeyEvent => ({key, metaKey: true, ...over});
const human = (over: Partial<BrowserShortcutContext> = {}): BrowserShortcutContext => ({owner: 'human', tabCount: 3, hasPage: true, ...over});

test('⌘L, ⌘R, ⌘[, ⌘], ⌘T and ⌘1–⌘6 are the whole map', () => {
  expect(browserShortcut(press('l'), human())).toEqual({outcome: 'run', action: {kind: 'focus-omnibox'}, preventDefault: true});
  expect(browserShortcut(press('r'), human())).toEqual({outcome: 'run', action: {kind: 'reload'}, preventDefault: true});
  expect(browserShortcut(press('['), human())).toEqual({outcome: 'run', action: {kind: 'back'}, preventDefault: true});
  expect(browserShortcut(press(']'), human())).toEqual({outcome: 'run', action: {kind: 'forward'}, preventDefault: true});
  expect(browserShortcut(press('t'), human())).toEqual({outcome: 'run', action: {kind: 'new-tab'}, preventDefault: true});
  for (const index of [0, 1, 2]) {
    expect(browserShortcut(press(String(index + 1)), human({tabCount: 6}))).toEqual({outcome: 'run', action: {kind: 'select-tab', index}, preventDefault: true});
  }
  // Upper case (⇪ or a different layout report) is the same key.
  expect(browserShortcut(press('L'), human())).toMatchObject({action: {kind: 'focus-omnibox'}});
  // Anything else is not ours: no action and nothing consumed.
  for (const key of ['a', 'Enter', 'Escape', 'ArrowLeft', '7', '0', 'Tab', 'p', 'd']) {
    expect(browserShortcut(press(key), human())).toEqual({outcome: 'ignore', reason: 'not-a-shortcut'});
  }
  // Without ⌘, or with another modifier beside it, we never claim the key.
  for (const event of [press('r', {metaKey: false}), press('r', {ctrlKey: true}), press('r', {altKey: true}), press('l', {metaKey: false})]) {
    expect(browserShortcut(event, human())).toEqual({outcome: 'ignore', reason: 'not-a-shortcut'});
  }
  expect(browserTabShortcutKey(0)).toBe('⌘1');
  expect(browserTabShortcutKey(BROWSER_TAB_LIMIT - 1)).toBe(`⌘${BROWSER_TAB_LIMIT}`);
  expect(browserTabShortcutKey(BROWSER_TAB_LIMIT)).toBeNull();
});

test('the keys that belong to macOS, to the app and to VOC are never taken', () => {
  // ⌘W would close the window before the page ever sees it; ⌘F is the app find; ⌘⇧V is VOC.
  for (const key of ['w', 'q', 'h', 'm', 'f']) {
    expect(browserShortcut(press(key), human())).toEqual({outcome: 'ignore', reason: 'reserved'});
    expect(isReservedBrowserShortcut(press(key))).toBe(true);
  }
  expect(browserShortcut(press('v', {shiftKey: true}), human())).toEqual({outcome: 'ignore', reason: 'reserved'});
  expect(isReservedBrowserShortcut(press('v', {shiftKey: true}))).toBe(true);
  expect(isReservedBrowserShortcut(press('v'))).toBe(false);
  // A reserved key is never consumed, for any owner or context.
  for (const owner of ['human', 'observing', 'agent', 'taking', 'disconnected'] as const) {
    for (const reserved of BROWSER_RESERVED_SHORTCUTS) {
      const decision = browserShortcut(press(reserved.key, {shiftKey: reserved.shift}), human({owner, editing: true}));
      expect(decision).toEqual({outcome: 'ignore', reason: 'reserved'});
      expect(decision).not.toHaveProperty('preventDefault');
    }
  }
  // ⌘⇧ anything else is not a browser shortcut either (⌘⇧T, ⌘⇧R and friends stay free).
  for (const key of ['t', 'r', 'l', '1']) expect(browserShortcut(press(key, {shiftKey: true}), human())).toEqual({outcome: 'ignore', reason: 'not-a-shortcut'});
  // The two owners of these keys still say so in the code this module points at.
  expect(readFileSync(new URL('../src/vocShortcut.ts', import.meta.url), 'utf8')).toContain('shiftKey');
  expect(BROWSER_RESERVED_SHORTCUTS.map(item => item.key)).toEqual(['w', 'q', 'h', 'm', 'f', 'v']);
});

test('only a connected person drives the page; ⌘L stays theirs at every moment', () => {
  for (const owner of ['observing', 'agent', 'taking', 'disconnected'] as const) {
    // Reading and copying the address is not driving: ⌘L runs even while the AI holds the page.
    expect(browserShortcut(press('l'), human({owner}))).toEqual({outcome: 'run', action: {kind: 'focus-omnibox'}, preventDefault: true});
    // Everything that would change the page is blocked — and still consumed, so a stray ⌘R cannot reload the app.
    for (const [key, kind] of [['r', 'reload'], ['[', 'back'], [']', 'forward'], ['t', 'new-tab']] as const) {
      expect(browserShortcut(press(key), human({owner}))).toEqual({outcome: 'blocked', action: {kind}, reason: 'owner', preventDefault: true});
    }
    expect(browserShortcut(press('2'), human({owner, tabCount: 6}))).toEqual({outcome: 'blocked', action: {kind: 'select-tab', index: 1}, reason: 'owner', preventDefault: true});
  }
  // A dropped connection is the same as not owning it, whatever the host last said about the owner.
  expect(browserShortcut(press('r'), human({owner: 'human', connection: 'disconnected'}))).toMatchObject({outcome: 'blocked', reason: 'owner'});
});

test('a ⌘ chord is not typing, so editing changes nothing, and plain keys are never claimed', () => {
  // The person is in the omnibox or the composer: ⌘ chords still work (that is what a browser does), and no plain key
  // is ever swallowed from the field.
  for (const [key, kind] of [['l', 'focus-omnibox'], ['r', 'reload'], ['t', 'new-tab'], ['[', 'back']] as const) {
    expect(browserShortcut(press(key), human({editing: true}))).toEqual({outcome: 'run', action: {kind}, preventDefault: true});
  }
  for (const key of ['l', 'r', 't', '1', 'a', 'Escape']) {
    expect(browserShortcut(press(key, {metaKey: false}), human({editing: true}))).toEqual({outcome: 'ignore', reason: 'not-a-shortcut'});
  }
});

test('what is on screen decides the rest: history, native support, the tab set and the 6-tab limit', () => {
  expect(browserShortcut(press('['), human({navSupported: false}))).toEqual({outcome: 'blocked', action: {kind: 'back'}, reason: 'nav-unsupported', preventDefault: true});
  expect(browserShortcut(press(']'), human({navSupported: false}))).toMatchObject({reason: 'nav-unsupported'});
  expect(browserShortcut(press('['), human({canGoBack: false}))).toEqual({outcome: 'blocked', action: {kind: 'back'}, reason: 'no-history', preventDefault: true});
  expect(browserShortcut(press(']'), human({canGoForward: false}))).toMatchObject({reason: 'no-history'});
  // Unknown history (the host has not said) is not a refusal; the native group's own disabled state covers it.
  expect(browserShortcut(press('['), human())).toMatchObject({outcome: 'run'});
  expect(browserShortcut(press('r'), human({hasPage: false}))).toEqual({outcome: 'blocked', action: {kind: 'reload'}, reason: 'no-page', preventDefault: true});
  // ⌘T stops at the tab limit the protocol defines, not at a number typed here.
  expect(browserShortcut(press('t'), human({tabCount: BROWSER_TAB_LIMIT}))).toEqual({outcome: 'blocked', action: {kind: 'new-tab'}, reason: 'tab-limit', preventDefault: true});
  expect(browserShortcut(press('t'), human({tabCount: BROWSER_TAB_LIMIT - 1}))).toMatchObject({outcome: 'run'});
  // ⌘5 with three tabs open points at no tab.
  expect(browserShortcut(press('5'), human({tabCount: 3}))).toEqual({outcome: 'blocked', action: {kind: 'select-tab', index: 4}, reason: 'no-such-tab', preventDefault: true});
  expect(browserShortcut(press('3'), human({tabCount: 3}))).toMatchObject({outcome: 'run', action: {kind: 'select-tab', index: 2}});
  expect(browserShortcut(press('6'), human({tabCount: BROWSER_TAB_LIMIT}))).toMatchObject({outcome: 'run', action: {kind: 'select-tab', index: 5}});
});
