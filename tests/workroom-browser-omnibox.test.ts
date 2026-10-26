import {expect,test} from 'bun:test';
import {
  OMNIBOX_MAX_LENGTH,omniboxDirty,omniboxDisplay,omniboxFollowValue,omniboxHttpScope,omniboxIntent,
  omniboxReadOnly,omniboxRevert,omniboxSearchHint,
} from '../src/workroomBrowserOmnibox';
import {OWNED_BROWSER_SEARCH,normalizeOwnedBrowserAddress} from '../src/workroomBrowserNavigation';
import {workroomBrowserUiCopy} from '../src/workroomBrowserUiCopy';

test('the blurred line puts the host first and dims the rest, with the scheme hidden', () => {
  expect(omniboxDisplay('https://shop.example.com/checkout?coupon=WELCOME#form')).toEqual({
    kind: 'https', identity: 'https', identityTitleKey: 'identityHttps',
    host: 'shop.example.com', rest: '/checkout?coupon=WELCOME#form',
    text: 'shop.example.com/checkout?coupon=WELCOME#form', full: 'https://shop.example.com/checkout?coupon=WELCOME#form', search: false,
  });
  // A bare host has nothing to dim: the trailing slash never shows.
  expect(omniboxDisplay('https://example.com/')).toMatchObject({host: 'example.com', rest: '', text: 'example.com'});
  expect(omniboxDisplay('https://example.com:8443/a')).toMatchObject({host: 'example.com:8443', rest: '/a'});
  // The port belongs to the host, so it stays in the strong part.
  expect(omniboxDisplay('http://localhost:5173/app?x=1')).toMatchObject({host: 'localhost:5173', rest: '/app?x=1'});
});

test('each line gets its own glyph: lock, dev-server globe, http warning, search', () => {
  expect(omniboxDisplay('https://example.com')).toMatchObject({kind: 'https', identity: 'https', identityTitleKey: 'identityHttps'});
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:9000/x', 'http://[::1]:5173/', 'http://0.0.0.0:8080/']) {
    expect(omniboxDisplay(url)).toMatchObject({kind: 'http-local', identity: 'local', identityTitleKey: 'identityLocal'});
  }
  // A development server on the local network is not dangerous, but it is not 「이 기기」 either.
  for (const url of ['http://192.168.0.12:5173/', 'http://10.1.2.3:3000/', 'http://172.16.9.1/', 'http://mac-mini.local:8080/']) {
    expect(omniboxDisplay(url)).toMatchObject({kind: 'http-local', identity: 'local', identityTitleKey: 'identityPrivateNetwork'});
  }
  for (const url of ['http://example.com/', 'http://203.0.113.9/', 'http://shop.example.com:8080/a']) {
    expect(omniboxDisplay(url)).toMatchObject({kind: 'http-remote', identity: 'http', identityTitleKey: 'identityHttp'});
  }
  // Words, and anything that is not an HTTP(S) URL, read as what Enter would do with them: a search.
  expect(omniboxDisplay('react hooks')).toMatchObject({kind: 'search', identity: 'search', identityTitleKey: 'identitySearch', host: 'react hooks', rest: '', search: true});
  expect(omniboxDisplay('file:///etc/passwd')).toMatchObject({kind: 'search', identity: 'search'});
  expect(omniboxDisplay('')).toMatchObject({kind: 'search', text: '', full: '', search: false});
  expect(omniboxHttpScope('localhost')).toBe('loopback');
  expect(omniboxHttpScope('192.168.1.1')).toBe('private');
  expect(omniboxHttpScope('example.com')).toBe('remote');
  // Every title key this module names exists in the A1 copy (no invented keys).
  const toolbar = workroomBrowserUiCopy('ko').toolbar;
  for (const key of ['identityHttps', 'identityLocal', 'identityPrivateNetwork', 'identityHttp', 'identitySearch'] as const) expect(typeof toolbar[key]).toBe('string');
});

test('what a typed line means comes from the navigation module, never from a second rule', () => {
  // Same input, same answer as the address normalizer the host already uses.
  for (const typed of ['example.com', 'https://example.com/a b'.replace(' ', ''), 'localhost:5173', '127.0.0.1:9000/x', 'naver.co.kr/search?q=1']) {
    const intent = omniboxIntent(typed);
    expect(intent).toMatchObject({kind: 'navigate', url: normalizeOwnedBrowserAddress(typed)});
  }
  for (const typed of ['네이버', 'react hooks', 'what is a worktree?', 'hello world']) {
    const intent = omniboxIntent(typed);
    expect(intent.kind).toBe('search');
    expect((intent as {url: string}).url).toBe(normalizeOwnedBrowserAddress(typed));
    expect((intent as {url: string}).url.startsWith(OWNED_BROWSER_SEARCH)).toBe(true);
    expect(omniboxSearchHint(typed)).toBe(true);
  }
  expect(omniboxSearchHint('example.com')).toBe(false);
  expect(omniboxIntent('  ')).toEqual({kind: 'empty'});
  expect(omniboxIntent('https://example.com/a')).toMatchObject({display: {kind: 'https', host: 'example.com'}});
  expect(omniboxIntent('네이버')).toMatchObject({display: {identity: 'search', host: '네이버', search: true}});
});

test('a line the field must not open is refused with a code, not a message', () => {
  // Credentials in a URL are never opened and never searched (workroomBrowserNavigation refuses them).
  for (const typed of ['https://user:secret@example.com/', 'http://admin@10.0.0.1/', 'user:pw@example.com']) {
    expect(omniboxIntent(typed)).toEqual({kind: 'invalid', code: 'invalid-address'});
  }
  // Not a web address: a scheme stays a scheme and is refused rather than quietly searched.
  for (const typed of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x', 'chrome://settings']) {
    expect(omniboxIntent(typed)).toEqual({kind: 'invalid', code: 'invalid-address'});
  }
  // 4096 characters is the cap, for an address and for a search term alike.
  expect(OMNIBOX_MAX_LENGTH).toBe(4096);
  expect(omniboxIntent(`https://example.com/${'a'.repeat(OMNIBOX_MAX_LENGTH)}`)).toEqual({kind: 'invalid', code: 'invalid-address'});
  expect(omniboxIntent('가'.repeat(2000)).kind).toBe('invalid');
  expect(omniboxIntent(`https://example.com/${'a'.repeat(4000)}`).kind).toBe('navigate');
  expect(omniboxIntent('a\u0000b')).toEqual({kind: 'invalid', code: 'invalid-address'});
});

test('dirty, revert and following the page agree on what 「unchanged」 means', () => {
  const page = 'https://shop.example.com/checkout?coupon=1';
  // The three things a person can be looking at are all 「unchanged」: the dimmed line, the full URL, the short form.
  for (const typed of ['shop.example.com/checkout?coupon=1', page, ' shop.example.com/checkout?coupon=1 ']) {
    expect(omniboxDirty(typed, page)).toBe(false);
  }
  expect(omniboxDirty('example.com', 'https://example.com/')).toBe(false);
  expect(omniboxDirty('shop.example.com/cart', page)).toBe(true);
  expect(omniboxDirty('', page)).toBe(true);
  expect(omniboxDirty('', null)).toBe(false);
  expect(omniboxDirty('example.com', null)).toBe(true);
  // Escape restores the page's own full URL, and has nothing to restore before the first page.
  expect(omniboxRevert(page)).toBe(page);
  expect(omniboxRevert('https://example.com')).toBe('https://example.com/');
  expect(omniboxRevert(null)).toBe('');
  // While neither focused nor dirty the field follows the page; a focused or edited field is left alone.
  expect(omniboxFollowValue({pageUrl: page, typed: 'shop.example.com/checkout?coupon=1', focused: false})).toBe(page);
  expect(omniboxFollowValue({pageUrl: page, typed: '', focused: true})).toBeNull();
  expect(omniboxFollowValue({pageUrl: page, typed: 'shop.example.com/cart', focused: false})).toBeNull();
  expect(omniboxFollowValue({pageUrl: null, typed: '', focused: false})).toBe('');
});

test('only a connected person may edit the address', () => {
  expect(omniboxReadOnly('human')).toBe(false);
  expect(omniboxReadOnly('human', 'disconnected')).toBe(true);
  for (const owner of ['observing', 'agent', 'taking', 'disconnected']) expect(omniboxReadOnly(owner)).toBe(true);
});

test('the bar stylesheet uses tokens only, honours reduced motion and keeps phone fields at 16px', async () => {
  const css = await Bun.file(new URL('../src/WorkroomBrowserFrameBar.css', import.meta.url)).text();
  // No colour literal: every colour comes from the appearance tokens (comments included, so none sneaks back in).
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
  expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*(transition|animation):none/);
  // iOS zooms into a field under 16px.
  const phone = css.slice(css.indexOf('@media (max-width:640px),(pointer:coarse)'));
  expect(phone.length).toBeLessThan(css.length);
  expect(phone).toMatch(/\.wb-omnibox-input[^{]*\{[^}]*font-size:16px/);
});
