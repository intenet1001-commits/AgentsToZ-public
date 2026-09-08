import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS,
  REMOTE_CONTROL_SELECTED_HOST_POLL_MS,
} from '../src/remoteControlRelayController';

const rootFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('phone-side Mac switcher', () => {
  test('restores every remembered Mac rather than the one that scanned last', () => {
    // Both vaults used to hold a single record, so a second QR silently
    // replaced the first Mac and the portal only ever built one controller.
    const portal = rootFile('src/remote-control-portal-main.tsx');
    expect(portal).toContain('await sessionVault.loadAll()');
    expect(portal).toContain('await vault.loadAll()');
    expect(portal).toContain('new RemoteControlRelayControllerManager()');
    expect(portal).toContain('manager.adopt(hostId, controller)');
  });

  test('gives the chip row and every chip a test id, including its remove control', () => {
    const portal = rootFile('src/remote-control-portal-main.tsx');
    const css = rootFile('src/remote-control-portal.css');
    expect(portal).toContain('data-testid="remote-host-tabs"');
    expect(portal).toContain('data-testid={`remote-host-tab-${host.hostId}`}');
    expect(portal).toContain('data-testid={`remote-host-remove-${host.hostId}`}');
    for (const rule of ['.remote-host-tabs', '.remote-host-tab--active', '.remote-host-dot--online']) {
      expect(css).toContain(rule);
    }
  });

  test('polls on the selected-host cadence and lets the manager decide who is due', () => {
    // A one-second interval per Mac is what the split exists to avoid; the
    // timer stays at the fast cadence and `dueForRefresh` skips the rest.
    const portal = rootFile('src/remote-control-portal-main.tsx');
    expect(portal).toContain('manager.dueForRefresh(Date.now(), selected)');
    expect(portal).toContain('await Promise.all(due.map(async hostId => {');
    expect(portal).toContain('}, REMOTE_CONTROL_SELECTED_HOST_POLL_MS);');
    expect(REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS).toBeGreaterThan(REMOTE_CONTROL_SELECTED_HOST_POLL_MS * 10);
  });

  test('resumes independent Mac sessions concurrently and exposes busy hosts on their chips', () => {
    const portal = rootFile('src/remote-control-portal-main.tsx');
    const css = rootFile('src/remote-control-portal.css');
    expect(portal).toContain('Promise.allSettled(sources.map(source => connectHost(source)))');
    expect(portal).toContain('host.status.busy ? (');
    expect(portal).toContain('remote-host-tab-state--busy">요청 중');
    expect(css).toContain('.remote-host-tab-state--busy');
  });

  test('disconnects one Mac at a time and never wipes the whole store', () => {
    // `clear()` drops every remembered Mac. Disconnecting one chip, or failing
    // to read one record, must not disconnect the others.
    const portal = rootFile('src/remote-control-portal-main.tsx');
    expect(portal).toContain('sessionVaultRef.current?.clearHost(hostId)');
    expect(portal).toContain('vaultRef.current?.clearHost(hostId)');
    expect(portal).not.toContain('sessionVault.clear()');
    expect(portal).not.toContain('vaultRef.current?.clear()');
  });

  test('binds slow actions to the Mac that received them and suppresses late cross-host banners', () => {
    const portal = rootFile('src/remote-control-portal-main.tsx');
    expect(portal).toContain('const controller = selectedController;');
    expect(portal).toContain('const hostId = selectedHostId;');
    expect(portal).toContain('await controller.sendAction(action, project.controlId, undefined, input)');
    expect(portal).toContain('if (selectedHostIdRef.current === hostId)');
    expect(portal).not.toContain('await selectedController?.sendAction(action, project.controlId');
  });
});
