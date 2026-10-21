import { describe, expect, test } from 'bun:test';
import {
  hermesDesktopCommandUsesUserDataDir,
  hermesDesktopExecutableCandidates,
} from '../src/hermesDesktopInstallation';
import { hermesDashboardReadyPort } from '../src/hermesDesktopReadyReceipt';

describe('Hermes Desktop installation and readiness contracts', () => {
  test('discovers the Hermes-managed macOS app after it exits', () => {
    const arm = hermesDesktopExecutableCandidates('/Users/example', 'darwin', 'arm64');
    expect(arm).toContain('/Applications/Hermes.app/Contents/MacOS/Hermes');
    expect(arm).toContain('/Users/example/Applications/Hermes.app/Contents/MacOS/Hermes');
    expect(arm).toContain('/Users/example/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents/MacOS/Hermes');

    const intel = hermesDesktopExecutableCandidates('/Users/example', 'darwin', 'x64');
    expect(intel).toContain('/Users/example/.hermes/hermes-agent/apps/desktop/release/mac-x64/Hermes.app/Contents/MacOS/Hermes');
    expect(hermesDesktopExecutableCandidates('/home/example', 'linux', 'x64')).toEqual([]);
  });

  test('accepts Hermes official {port} ready receipt and rejects invented or unsafe shapes', () => {
    expect(hermesDashboardReadyPort({ port: 43123 })).toBe(43123);
    expect(hermesDashboardReadyPort({ port: '43123' })).toBe(43123);
    expect(hermesDashboardReadyPort({ schemaVersion: 1, ready: true, pid: 42, cwd: '/tmp' })).toBeNull();
    expect(hermesDashboardReadyPort({ port: 0 })).toBeNull();
    expect(hermesDashboardReadyPort({ port: 65_536 })).toBeNull();
    expect(hermesDashboardReadyPort(null)).toBeNull();
  });

  test('matches only the exact project-scoped Electron user-data directory', () => {
    const root = '/Users/example/.hermes/desktop-projects/abc';
    expect(hermesDesktopCommandUsesUserDataDir(
      `/Applications/Hermes.app/Contents/MacOS/Hermes --user-data-dir=${root} hermes://open/session`,
      root,
    )).toBe(true);
    expect(hermesDesktopCommandUsesUserDataDir(
      `/Applications/Hermes.app/Contents/MacOS/Hermes --user-data-dir "${root}"`,
      root,
    )).toBe(true);
    expect(hermesDesktopCommandUsesUserDataDir(
      `/Applications/Hermes.app/Contents/MacOS/Hermes --user-data-dir=${root}-other`,
      root,
    )).toBe(false);
  });
});
