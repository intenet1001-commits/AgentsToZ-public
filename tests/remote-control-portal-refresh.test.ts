import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_PORTAL_MAX_PAGE,
  loadedPageDepthForHost,
  progressingRemoteControlPage,
  rememberLoadedPageDepth,
} from '../src/remoteControlPortalPagination';

const source = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');

describe('mobile portal refresh', () => {
  test('refreshing restores the depth the user had loaded, not just the first page', () => {
    // A page-0 result REPLACES the controller's accumulated list, so refreshing
    // after paging collapsed a long list back to the first page and read as
    // "refresh lost my projects".
    expect(source).toContain('loadedPageCountsByHostRef');
    expect(source).toContain('loadedPageDepthForHost(');
    expect(source.match(/rememberLoadedPageDepth\(/g) ?? []).toHaveLength(2);
  });

  test('A -> B -> A keeps each Mac\'s loaded depth independently', () => {
    const depths = new Map<string, number>();
    rememberLoadedPageDepth(depths, 'host-a', 5);
    expect(loadedPageDepthForHost(depths, 'host-b')).toBe(1);
    rememberLoadedPageDepth(depths, 'host-b', 2);
    expect(loadedPageDepthForHost(depths, 'host-a')).toBe(5);
    expect(loadedPageDepthForHost(depths, 'host-b')).toBe(2);
    // A smaller later observation must not collapse what a refresh has to replay.
    rememberLoadedPageDepth(depths, 'host-a', 1);
    expect(loadedPageDepthForHost(depths, 'host-a')).toBe(5);
  });

  test('byte-bounded long-card pages can sweep through protocol page 99 without looping', () => {
    // 500 long cards can exceed the old 25-request guess because each 9KB page
    // may hold only a few cards. The wire contract, not card count, is the cap.
    let previous = 0;
    let requests = 0;
    for (let page = 1; page <= REMOTE_CONTROL_PORTAL_MAX_PAGE; page += 1) {
      previous = progressingRemoteControlPage(previous, page)!;
      requests += 1;
    }
    expect(requests).toBe(99);
    expect(() => progressingRemoteControlPage(previous, previous)).toThrow();
    expect(() => progressingRemoteControlPage(previous, REMOTE_CONTROL_PORTAL_MAX_PAGE + 1)).toThrow();
    expect(progressingRemoteControlPage(previous, null)).toBeNull();
    expect(source).toContain('guard <= REMOTE_CONTROL_PORTAL_MAX_PAGE');
    expect(source).not.toContain('guard < 25');
  });

  test('disconnect clears both pagination depth and the one-shot search sweep', () => {
    const disconnect = source.slice(source.indexOf('const disconnectHost'), source.indexOf('const manualRefresh'));
    expect(disconnect).toContain('loadedPageCountsByHostRef.current.delete(hostId)');
    expect(disconnect).toContain('searchSweptHostsRef.current.delete(hostId)');
  });

  test('the refresh control reports that it is working', () => {
    expect(source).toContain('data-testid="remote-refresh"');
    expect(source).toContain("'새로고침 중…'");
    expect(source).toContain('disabled={status.busy || refreshing}');
  });

  test('a stale bundle can be reloaded from inside the page', () => {
    // The Mac app and this page deploy separately, so after a protocol bump the
    // phone can hold the older half. The failure is loud but the only remedy
    // was "refresh the page", which the screen never offered.
    expect(source).toContain('data-testid="remote-reload-app"');
    expect(source.match(/data-testid="remote-reload-app"/g) ?? []).toHaveLength(1);
    expect(source).toContain('window.location.reload()');
    // Caches are cleared first, or the reload can serve the same stale bundle.
    expect(source).toContain('caches.keys()');
    expect(source).toContain('caches.delete(key)');
    // A blocked cache API must not prevent the reload.
    const reload = source.slice(source.indexOf('const reloadApp'), source.indexOf('const reloadApp') + 700);
    expect(reload).toContain('catch');
    expect(reload.indexOf('window.location.reload()')).toBeGreaterThan(reload.indexOf('catch'));
  });
});
