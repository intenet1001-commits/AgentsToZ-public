import { describe, expect, test } from 'bun:test';
import {
  QR_REMOTE_CONTROL_PATHS,
  QrRemoteControlContractError,
  formatQrRemoteControlRemaining,
  isPrivateQrRemoteControlAddress,
  isQrRemoteControlPairingExpired,
  normalizeQrRemoteControlInterfaces,
  normalizeQrRemoteControlPairingIssue,
  normalizeQrRemoteControlProjectCards,
  normalizeQrRemoteControlStatus,
  normalizeQrRemoteControlWorkspaceRoots,
} from '../src/qrRemoteControlContract';

const token = 'A'.repeat(43);

describe('QR remote-control management contract', () => {
  test('uses a dedicated POST-only management namespace', () => {
    expect(Object.values(QR_REMOTE_CONTROL_PATHS)).toEqual([
      '/api/remote-control/status',
      '/api/remote-control/interfaces',
      '/api/remote-control/enable',
      '/api/remote-control/pairing/rotate',
      '/api/remote-control/sessions/revoke',
      '/api/remote-control/disable',
    ]);
    expect(Object.values(QR_REMOTE_CONTROL_PATHS).every(path => path.startsWith('/api/remote-control/'))).toBe(true);
  });

  test('normalizes disabled and enabled states without treating malformed enabled state as off', () => {
    expect(normalizeQrRemoteControlStatus({ enabled: false, listener: { host: 'evil.example', port: 1 } }))
      .toEqual({ enabled: false, listener: null, pairing: null, sessions: [] });

    expect(normalizeQrRemoteControlStatus({
      status: {
        enabled: true,
        listener: { host: '192.168.1.12', port: 3210 },
        pairing: { expiresAt: '2026-08-30T11:05:00.000Z' },
        sessions: [{
          id: 'session_12345678',
          label: 'iPad',
          pairedAt: '2026-08-30T10:00:00.000Z',
          lastSeenAt: '2026-08-30T10:01:00.000Z',
          expiresAt: '2026-08-30T22:00:00.000Z',
        }],
      },
    })).toEqual({
      enabled: true,
      listener: { host: '192.168.1.12', port: 3210 },
      pairing: { expiresAt: '2026-08-30T11:05:00.000Z' },
      sessions: [{
        id: 'session_12345678',
        label: 'iPad',
        // A Mac that predates the flag omits it; that must not read as "away".
        connected: true,
        pairedAt: '2026-08-30T10:00:00.000Z',
        lastSeenAt: '2026-08-30T10:01:00.000Z',
        expiresAt: '2026-08-30T22:00:00.000Z',
      }],
    });

    for (const malformed of [
      {},
      { enabled: true, listener: null },
      { enabled: true, listener: { host: '127.0.0.1', port: 3210 } },
      { enabled: true, listener: { host: '192.168.1.12', port: 0 } },
      { enabled: true, listener: { host: '192.168.1.12', port: 3210 }, sessions: {} },
    ]) expect(() => normalizeQrRemoteControlStatus(malformed)).toThrow(QrRemoteControlContractError);
  });

  test('accepts only selected RFC1918 IPv4 interfaces in V1', () => {
    for (const address of ['10.0.0.2', '172.16.2.4', '172.31.255.254', '192.168.0.9']) {
      expect(isPrivateQrRemoteControlAddress(address)).toBe(true);
    }
    for (const address of [
      '127.0.0.1', '169.254.1.2', '172.32.0.1', '8.8.8.8',
      '::1', 'fe80::1', 'fd12::9', '192.168.001.2', 'example.com',
    ]) {
      expect(isPrivateQrRemoteControlAddress(address)).toBe(false);
    }
    expect(normalizeQrRemoteControlInterfaces({
      interfaces: [{ address: '192.168.0.12', name: 'Wi-Fi' }],
    })).toEqual([{ address: '192.168.0.12', name: 'Wi-Fi' }]);
    expect(() => normalizeQrRemoteControlInterfaces({ interfaces: [{ address: '8.8.8.8', name: 'public' }] }))
      .toThrow(QrRemoteControlContractError);
    expect(() => normalizeQrRemoteControlInterfaces({ interfaces: [{ address: 'fd12::9', name: 'IPv6' }] }))
      .toThrow(QrRemoteControlContractError);
  });

  test('accepts only a private, credential-free, query-free one-time fragment URL', () => {
    expect(normalizeQrRemoteControlPairingIssue({
      pairingUrl: `http://192.168.1.12:3210/remote/#pair=${token}`,
      expiresAt: '2026-08-30T11:05:00.000Z',
    })).toEqual({
      pairingUrl: `http://192.168.1.12:3210/remote/#pair=${token}`,
      expiresAt: '2026-08-30T11:05:00.000Z',
    });

    for (const pairingUrl of [
      `https://192.168.1.12:3210/remote/#pair=${token}`,
      `http://127.0.0.1:3210/remote/#pair=${token}`,
      `http://8.8.8.8:3210/remote/#pair=${token}`,
      `http://[fd12::9]:3210/remote/#pair=${token}`,
      `http://user:pass@192.168.1.12:3210/remote/#pair=${token}`,
      `http://192.168.1.12:3210/remote/?pair=${token}`,
      `http://192.168.1.12:3210/other/#pair=${token}`,
      'http://192.168.1.12:3210/remote/#pair=too-short',
      `http://192.168.1.12:3210/remote/#pair=${'A'.repeat(44)}`,
    ]) {
      expect(() => normalizeQrRemoteControlPairingIssue({
        pairingUrl,
        expiresAt: '2026-08-30T11:05:00.000Z',
      })).toThrow(QrRemoteControlContractError);
    }
  });

  test('formats a cosmetic countdown while server expiry remains authoritative', () => {
    const expiry = '2026-08-30T10:05:01.000Z';
    const now = Date.parse('2026-08-30T10:00:00.000Z');
    expect(formatQrRemoteControlRemaining(expiry, now)).toBe('5:01');
    expect(formatQrRemoteControlRemaining('2026-08-31T10:00:00.000Z', now)).toBe('1일 0시간');
    expect(isQrRemoteControlPairingExpired(expiry, now)).toBe(false);
    expect(isQrRemoteControlPairingExpired(expiry, Date.parse(expiry))).toBe(true);
  });
});

describe('path-free mobile project-card contract', () => {
  test('keeps workspace-root registry ids private behind session-scoped controls', () => {
    expect(normalizeQrRemoteControlWorkspaceRoots({
      workspaceRoots: [{ controlId: token, name: '제품 작업' }],
    })).toEqual([{ controlId: token, name: '제품 작업' }]);
    expect(() => normalizeQrRemoteControlWorkspaceRoots({
      workspaceRoots: [{ controlId: token, name: '제품 작업', path: '/private/work' }],
    })).toThrow(QrRemoteControlContractError);
  });

  test('carries the secondary alias but rejects a malformed or redundant one', () => {
    const [card] = normalizeQrRemoteControlProjectCards({ projects: [{
      controlId: 'control_12345678',
      name: '헤르메스',
      alias: 'Claude Agent Config',
      port: null,
      kind: 'main',
      status: 'unknown',
      actions: ['folder.open'],
    }] });
    expect(card).toMatchObject({ name: '헤르메스', alias: 'Claude Agent Config' });

    // An alias equal to the title would render a duplicate line on the phone.
    expect(normalizeQrRemoteControlProjectCards({ projects: [{
      controlId: 'control_12345678',
      name: '헤르메스',
      alias: '헤르메스',
      port: null,
      kind: 'main',
      status: 'unknown',
      actions: ['folder.open'],
    }] })[0]!.alias).toBeNull();

    for (const alias of ['', ' ', 'x'.repeat(121), 7, {}]) {
      expect(() => normalizeQrRemoteControlProjectCards({ projects: [{
        controlId: 'control_12345678',
        name: '헤르메스',
        alias,
        port: null,
        kind: 'main',
        status: 'unknown',
        actions: ['folder.open'],
      }] })).toThrow(QrRemoteControlContractError);
    }
  });

  test('allows only opaque identity, display state, and fixed registered-project actions', () => {
    expect(normalizeQrRemoteControlProjectCards({ projects: [{
      controlId: 'control_12345678',
      name: 'Docs preview',
      port: 4100,
      kind: 'main',
      status: 'running',
      actions: ['stop', 'restart'],
    }] })).toEqual([{
      controlId: 'control_12345678',
      name: 'Docs preview',
      alias: null,
      workspaceRoot: null,
      branch: null,
      port: 4100,
      kind: 'main',
      status: 'running',
      actions: ['stop', 'restart'],
    }]);
  });

  test('accepts a bounded workspace-root display label and rejects malformed labels', () => {
    const project = {
      controlId: 'control_12345678',
      name: 'Docs preview',
      port: null,
      kind: 'main',
      status: 'unknown',
      actions: ['folder.open'],
    };
    expect(normalizeQrRemoteControlProjectCards({ projects: [{
      ...project,
      workspaceRoot: '제품 작업',
    }] })[0]!.workspaceRoot).toBe('제품 작업');
    for (const workspaceRoot of ['', ' ', 'x'.repeat(121), '제품\n작업', 7, {}]) {
      expect(() => normalizeQrRemoteControlProjectCards({ projects: [{
        ...project,
        workspaceRoot,
      }] })).toThrow(QrRemoteControlContractError);
    }
  });

  test('rejects paths, commands, device identity, PID, and any extra field instead of silently hiding it', () => {
    for (const forbidden of [
      'folderPath', 'worktreePath', 'commandPath', 'terminalCommand', 'pid',
      'deviceId', 'githubUrl', 'memoryId', 'whatISaidToken',
    ]) {
      expect(() => normalizeQrRemoteControlProjectCards({ projects: [{
        controlId: 'control_12345678',
        name: 'Project',
        port: null,
        kind: 'main',
        status: 'unknown',
        actions: [],
        [forbidden]: 'must-not-cross-boundary',
      }] })).toThrow(QrRemoteControlContractError);
    }
  });

  test('rejects arbitrary, duplicate, or status-inconsistent input shapes at the UI boundary', () => {
    expect(() => normalizeQrRemoteControlProjectCards({ projects: [{
      controlId: 'control_12345678', name: 'Project', port: 4100, kind: 'main', status: 'running', actions: ['shell'],
    }] })).toThrow(QrRemoteControlContractError);
    expect(() => normalizeQrRemoteControlProjectCards({ projects: [
      { controlId: 'control_12345678', name: 'One', port: 4100, kind: 'main', status: 'stopped', actions: ['start'] },
      { controlId: 'control_12345678', name: 'Two', port: 4101, kind: 'main', status: 'stopped', actions: ['start'] },
    ] })).toThrow(QrRemoteControlContractError);
    expect(() => normalizeQrRemoteControlProjectCards({ projects: [{
      controlId: 'control_abcdefgh', name: 'Folder', port: null, kind: 'main', status: 'stopped', actions: ['start'],
    }] })).toThrow(QrRemoteControlContractError);
  });
});
