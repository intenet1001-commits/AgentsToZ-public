import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RemoteControlStallBadge from '../src/components/RemoteControlStallBadge';
import { remoteControlLanStallBadgeLabel } from '../src/remoteControlLanRestorePlan';

const source = readFileSync(new URL('../src/components/RemoteControlStallBadge.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../src/QrRemoteControlDialog.tsx', import.meta.url), 'utf8');

describe('LAN remote stall badge', () => {
  test('shows nothing until a stall is actually read', () => {
    // No badge must mean "nothing stored is stuck" — never "remote is on". A chip that appeared
    // before the first answer would claim a problem the host has not reported.
    expect(renderToStaticMarkup(createElement(RemoteControlStallBadge, { onOpen() {} }))).toBe('');
  });

  test('each reason gets its own short label in both languages', () => {
    const stall = (reason: 'sessions' | 'no-interface' | 'ambiguous') => ({
      savedAddress: '192.168.219.131', savedPort: 49_243, sessions: 2, reason,
      available: ['192.168.219.115'],
    });
    const ko = (['sessions', 'no-interface', 'ambiguous'] as const).map(r => remoteControlLanStallBadgeLabel(stall(r)));
    expect(new Set(ko).size).toBe(3);
    for (const label of ko) expect(label.startsWith('LAN 원격 · ')).toBe(true);
    expect(remoteControlLanStallBadgeLabel(stall('sessions'), 'en')).toBe('LAN remote · address changed');
    expect(remoteControlLanStallBadgeLabel(stall('no-interface'), 'en')).toBe('LAN remote · no network');
  });

  test('reads cheaply, never on deployed web, and keeps the last answer on failure', () => {
    expect(source).toContain('if (isDeployedWeb()) return;');
    expect(source).toContain("document.visibilityState === 'visible'");
    expect(source).toContain('POLL_MS = 60_000');
    // A failed status read is not evidence of a stall.
    expect(source).not.toContain('setStall(null)');
    expect(source).toContain('data-testid="remote-control-stall-badge"');
    expect(source).toContain('data-stall-reason={stall.reason}');
  });

  test('says the same thing the dialog and the sidecar log say', () => {
    // One wording source: a chip that disagreed with the dialog it opens would send the operator
    // looking for two different problems.
    expect(source).toContain('remoteControlLanStallMessage(stall)');
    expect(dialogSource).toContain('remoteControlLanStallMessage(status.stalled)');
    expect(dialogSource).toContain('data-testid="qr-remote-control-stalled"');
    expect(dialogSource).toContain('{status.stalled && (');
  });

  test('sits in the header, not behind the two-level 「도구 및 설정」 popover', () => {
    // The QR entry itself lives inside that popover, which is exactly why the notice inside the
    // dialog was not enough: LAN remote went silent for 127 consecutive starts.
    expect(appSource).toContain('<RemoteControlStallBadge');
    expect(appSource).toContain('onOpen={() => setShowQrRemoteControl(true)}');
    const badgeAt = appSource.indexOf('<RemoteControlStallBadge');
    const actionsAt = appSource.indexOf('data-testid="project-main-actions"');
    const toolsAt = appSource.indexOf('data-testid="open-qr-remote-control"');
    expect(actionsAt).toBeGreaterThan(-1);
    expect(badgeAt).toBeGreaterThan(actionsAt);
    expect(badgeAt).toBeLessThan(appSource.indexOf('<WorkspaceTools', actionsAt));
    expect(toolsAt).toBeLessThan(actionsAt);
  });
});
