// 「이 앱의 연결 정보 지우기」 (iPhone app → the bundled portal's `window.agentstozDisconnect`) revoked only the Mac on
// screen. The app then deletes the page's whole store, so every other paired Mac kept this phone as an approved
// controller with nothing left on the phone to end it. The bridge now tells every Mac, within a bound, and always
// forgets each one locally — a revoke that did not answer is reported as unconfirmed, never as done.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_HOST_REVOKE_ALL_TIMEOUT_MS, revokeEveryRemoteHost } from '../src/remoteHostRevokeAll';

describe('revokeEveryRemoteHost', () => {
  test('every host is revoked and forgotten; confirmed only when all answered', async () => {
    const revoked: string[] = [], forgotten: string[] = [];
    const result = await revokeEveryRemoteHost(['mac-a', 'mac-b', 'mac-a'], {
      revoke: async id => { revoked.push(id); },
      forget: id => { forgotten.push(id); },
    });
    expect(revoked.sort()).toEqual(['mac-a', 'mac-b']);
    expect(forgotten.sort()).toEqual(['mac-a', 'mac-b']);
    expect(result).toEqual({ total: 2, confirmed: 2 });
  });

  test('a refused or hung revoke is unconfirmed, still forgotten, and the whole call stays bounded', async () => {
    const forgotten: string[] = [];
    const started = Date.now();
    const result = await revokeEveryRemoteHost(['ok', 'refused', 'hung'], {
      revoke: id => id === 'ok' ? Promise.resolve() : id === 'refused' ? Promise.reject(new Error('relay down')) : new Promise<void>(() => {}),
      forget: id => { forgotten.push(id); },
      timeoutMs: 60,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ total: 3, confirmed: 1 });
    expect(forgotten.sort()).toEqual(['hung', 'ok', 'refused']);
  });

  test('a local cleanup failure does not stop the others; no hosts is nothing left unconfirmed', async () => {
    const forgotten: string[] = [];
    const result = await revokeEveryRemoteHost(['a', 'b'], {
      revoke: async () => {},
      forget: id => { if (id === 'a') throw new Error('vault'); forgotten.push(id); },
    });
    expect(forgotten).toEqual(['b']);
    expect(result.confirmed).toBe(2);
    expect(await revokeEveryRemoteHost([], { revoke: async () => {}, forget: () => {} })).toEqual({ total: 0, confirmed: 0 });
  });

  test('the bound leaves the app room: it waits 10 s for the page', () => {
    expect(REMOTE_HOST_REVOKE_ALL_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
    const swift = readFileSync(join(import.meta.dir, '..', 'mobile', 'ios', 'App', 'LANWorkroomView.swift'), 'utf8');
    expect(swift).toContain('static let pageDisconnectTimeout: Duration = .seconds(10)');
  });
});

describe('portal bridge for the app', () => {
  const portal = readFileSync(join(import.meta.dir, '..', 'src', 'remote-control-portal-main.tsx'), 'utf8');
  test('the native bridge revokes every paired Mac, not only the selected one', () => {
    const bridge = portal.slice(portal.indexOf('window.agentstozDisconnect=disconnect') - 400, portal.indexOf('window.agentstozDisconnect=disconnect'));
    expect(bridge).toContain('disconnectAllHosts()');
    expect(bridge).not.toContain('disconnectHost(selectedHostId');
    const all = portal.slice(portal.indexOf('const disconnectAllHosts'), portal.indexOf('const disconnectAllHosts') + 1200);
    // Every connected Mac and every remembered one, each forgotten through the same per-Mac cleanup as one chip
    // (the store as a whole is never cleared from here; the app deletes it).
    expect(all).toContain('revokeEveryRemoteHost([...manager.hostIds(), ...sources.map(source => source.hostId)]');
    expect(all).toContain('forget: forgetHostLocally');
    expect(portal).toContain('await forgetHostLocally(hostId);');
  });
});
