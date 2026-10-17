import { test, expect, describe } from 'bun:test';
import {
  planRemoteControlLanRestore,
  remoteControlLanStallOf,
  remoteControlLanStallMessage,
} from '../src/remoteControlLanRestorePlan';

const iface = (...addresses: string[]) => addresses.map(address => ({ address }));
const record = (bindAddress: string, sessions = 0, port = 49_243) => ({
  bindAddress,
  port,
  sessions: Array.from({ length: sessions }, (_, index) => ({ token: `t${index}` })),
});

describe('planRemoteControlLanRestore', () => {
  test('no record means nothing to do', () => {
    expect(planRemoteControlLanRestore({ record: null, interfaces: iface('192.168.0.2') }))
      .toEqual({ action: 'idle' });
  });

  test('resumes on the stored address when this Mac still holds it', () => {
    expect(planRemoteControlLanRestore({
      record: record('192.168.0.2', 3),
      interfaces: iface('10.0.0.9', '192.168.0.2'),
    })).toEqual({ action: 'resume', address: '192.168.0.2', port: 49_243 });
  });

  test('rebinds to the only current address when no session can be stranded', () => {
    // The live defect: a DHCP lease moved 192.168.219.131 → .115 and LAN remote stayed off for
    // 127 consecutive sidecar starts.
    expect(planRemoteControlLanRestore({
      record: record('192.168.219.131'),
      interfaces: iface('192.168.219.115'),
    })).toEqual({
      action: 'rebind',
      address: '192.168.219.115',
      port: 49_243,
      savedAddress: '192.168.219.131',
    });
  });

  test('never rebinds while stored phones hold origin-bound tokens', () => {
    const plan = planRemoteControlLanRestore({
      record: record('192.168.219.131', 2),
      interfaces: iface('192.168.219.115'),
    });
    expect(plan.action).toBe('stalled');
    expect(remoteControlLanStallOf(plan)).toEqual({
      savedAddress: '192.168.219.131',
      savedPort: 49_243,
      sessions: 2,
      reason: 'sessions',
      available: ['192.168.219.115'],
    });
  });

  test('does not choose between two private addresses', () => {
    const plan = planRemoteControlLanRestore({
      record: record('192.168.219.131'),
      interfaces: iface('192.168.219.115', '10.8.0.3'),
    });
    expect(remoteControlLanStallOf(plan)?.reason).toBe('ambiguous');
  });

  test('reports no-interface rather than ambiguity when Wi-Fi is not up', () => {
    const plan = planRemoteControlLanRestore({ record: record('192.168.219.131'), interfaces: [] });
    expect(remoteControlLanStallOf(plan)?.reason).toBe('no-interface');
  });

  test('a running plan has no stall to report', () => {
    expect(remoteControlLanStallOf({ action: 'resume', address: '192.168.0.2', port: 1 })).toBeNull();
    expect(remoteControlLanStallOf({ action: 'idle' })).toBeNull();
  });

  test('each reason explains itself and names the saved address', () => {
    for (const reason of ['sessions', 'no-interface', 'ambiguous'] as const) {
      const message = remoteControlLanStallMessage({
        savedAddress: '192.168.219.131', savedPort: 49_243, sessions: 2, reason,
        available: ['192.168.219.115', '10.8.0.3'],
      });
      expect(message).toContain('192.168.219.131');
      expect(message.length).toBeGreaterThan(20);
    }
    expect(remoteControlLanStallMessage({
      savedAddress: '192.168.219.131', savedPort: 1, sessions: 2, reason: 'sessions', available: [],
    })).toContain('2대');
  });
});
