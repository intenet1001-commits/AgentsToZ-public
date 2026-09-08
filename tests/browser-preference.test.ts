import { describe, expect, test } from 'bun:test';
import { normalizePreferredBrowser } from '../src/browserPreference';
import { buildPreferredBrowserLaunch } from '../src/browserProfilesServer';

describe('preferred browser routing', () => {
  test('defaults missing or invalid preferences to Ego Lite and retains explicit choices', () => {
    for (const value of [null, undefined, '', 'unknown']) expect(normalizePreferredBrowser(value)).toBe('ego-lite');
    expect(normalizePreferredBrowser('chrome')).toBe('chrome');
    expect(normalizePreferredBrowser('system')).toBe('system');
  });
  test('launches Ego Lite and keeps shell metacharacters inside a single URL argument', () => {
    const url = 'http://localhost:9000/?x=a&next=%24%28touch%20oops%29';
    expect(buildPreferredBrowserLaunch({ browser: 'ego-lite', url, platform: 'darwin' })).toEqual({
      command: '/usr/bin/open', args: ['-a', 'ego lite', url],
    });
    expect(buildPreferredBrowserLaunch({ browser: 'system', url, platform: 'darwin' }).args).toEqual([url]);
    expect(buildPreferredBrowserLaunch({ browser: 'chrome', url, platform: 'darwin' }).args).toEqual(['-a', 'Google Chrome', url]);
  });
  test('rejects arbitrary applications, non-web schemes, and malformed URL values', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '-a Terminal', '\nhttps://example.com', null]) {
      expect(() => buildPreferredBrowserLaunch({ browser: 'ego-lite', url, platform: 'darwin' })).toThrow();
    }
    expect(() => buildPreferredBrowserLaunch({ browser: '/bin/sh', url: 'https://example.com', platform: 'darwin' })).toThrow();
  });
  test('system default works on other platforms; unsupported Ego never silently opens Chrome', () => {
    expect(buildPreferredBrowserLaunch({ browser: 'system', url: 'https://example.com', platform: 'linux' }).command).toBe('xdg-open');
    expect(buildPreferredBrowserLaunch({ browser: 'system', url: 'https://example.com', platform: 'win32' }).command).toBe('rundll32.exe');
    expect(() => buildPreferredBrowserLaunch({ browser: 'ego-lite', url: 'https://example.com', platform: 'win32' })).toThrow('macOS');
  });
});
