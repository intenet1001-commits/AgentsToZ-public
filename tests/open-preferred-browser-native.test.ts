// In the iPhone app a bookmark tap went through window.open, which the app's web view dropped, and the bookmark
// still counted a visit. The app now opens tapped external links in the system browser and says so with
// `agentstozNativeExternalLinks`; an app build that cannot (the web portal opened by an older app) refuses
// instead of pretending, so no visit is counted for nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPreferredBrowser } from '../src/openPreferredBrowser';

// Restore the property itself, not just its value: leaving `window` defined as undefined makes later files in the same
// run see a browser (`'window' in globalThis`), which broke tests/workroom-device-selection.test.ts when run after this one.
const hadWindow = 'window' in globalThis;
const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = original;
  else delete (globalThis as { window?: unknown }).window;
});

function fakeWindow(flags: Record<string, boolean>) {
  const opened: unknown[][] = [];
  (globalThis as { window?: unknown }).window = { location: { hostname: 'portal' }, open: (...args: unknown[]) => { opened.push(args); return null; }, ...flags };
  return opened;
}

describe('openPreferredBrowser in a native shell', () => {
  test('an app that cannot open external links refuses, and nothing is opened', async () => {
    const opened = fakeWindow({ agentstozNativeWorkroom: true });
    await expect(openPreferredBrowser('https://github.com/owner/repo')).rejects.toThrow('업데이트');
    expect(opened).toEqual([]);
  });

  test('an app that hands links to the system browser gets the one open', async () => {
    const opened = fakeWindow({ agentstozNativeWorkroom: true, agentstozNativeExternalLinks: true });
    await openPreferredBrowser('https://github.com/owner/repo');
    expect(opened).toEqual([['https://github.com/owner/repo', '_blank', 'noopener,noreferrer']]);
  });

  test('a phone browser (no app) opens as before', async () => {
    const opened = fakeWindow({});
    await openPreferredBrowser('https://example.com/');
    expect(opened.length).toBe(1);
  });
});

test('a bookmark visit is counted only after the open went through', () => {
  const manager = readFileSync(join(import.meta.dir, '..', 'src', 'PortalManager.tsx'), 'utf8');
  const body = manager.slice(manager.indexOf('async function openItem('), manager.indexOf('// ── Category CRUD'));
  expect(body.indexOf('await PortalAPI.openUrl(item.url)')).toBeGreaterThan(0);
  expect(body.indexOf('visitCount: i.visitCount + 1')).toBeGreaterThan(body.indexOf('await PortalAPI.openUrl(item.url)'));
  // The refusal lands in the catch, which shows it and never persists a visit.
  expect(body.slice(body.indexOf('} catch')).includes('persist(')).toBe(false);
});
