import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const lanDialog = readFileSync(new URL('../src/QrRemoteControlDialog.tsx', import.meta.url), 'utf8');
const internetDialog = readFileSync(new URL('../src/InternetQrRemoteControlDialog.tsx', import.meta.url), 'utf8');
const portalCss = readFileSync(new URL('../src/remote-control-portal.css', import.meta.url), 'utf8');

describe('mobile remote-control accessibility boundaries', () => {
  test('dialogs use the inverse logical viewport when browser fallback zoom transforms the root', () => {
    for (const source of [lanDialog, internetDialog]) {
      expect(source).toContain("maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))'");
      expect(source).toContain('min-h-0 flex-1 overflow-y-auto');
    }
    // LAN activation remains outside the scrolling body, next to the stable
    // header, so it and close are reachable even when 150% leaves little room.
    const bodyEnd = lanDialog.indexOf('</div>\n\n        {status && !status.enabled');
    const activation = lanDialog.indexOf('data-testid="qr-remote-control-enable"');
    expect(bodyEnd).toBeGreaterThan(0);
    expect(activation).toBeGreaterThan(bodyEnd);
  });

  test('Mac tabs, remove buttons, and partial-search action meet the 44px touch target', () => {
    expect(portalCss).toMatch(/\.remote-host-tab-select \{[^}]*min-height: 44px/);
    expect(portalCss).toMatch(/\.remote-host-tab-remove \{[^}]*width: 44px; height: 44px/);
    expect(portalCss).toMatch(/\.remote-filter-partial button \{[^}]*min-height: 44px/);
  });

  test('the portal identity stays fully readable at a 300px high-zoom viewport', () => {
    expect(portalCss).toContain('@media (max-width: 360px)');
    expect(portalCss).toMatch(/@media \(max-width: 360px\)[\s\S]*\.remote-heading h1 \{[^}]*white-space: normal/);
    expect(portalCss).toMatch(/@media \(max-width: 360px\)[\s\S]*\.remote-heading h1 \{[^}]*text-overflow: clip/);
  });
});
