import { describe, expect, test } from 'bun:test';
import type { RemoteControlGateway } from '../src/remoteControlCore';
import {
  REMOTE_CONTROL_HOST_ACTIVE_WINDOW_MS,
  REMOTE_CONTROL_HOST_IDLE_WINDOW_MS,
  RemoteControlInternetAgent,
  remoteControlHostPollDelayMs,
  type RemoteControlInternetHostRegistration,
  type RemoteControlInternetHostTransport,
  type RemoteControlInternetPairingRegistration,
  type RemoteControlInternetReceivedEnvelope,
  type RemoteControlInternetSessionRow,
} from '../src/remoteControlInternetAgent';
import { parseRemoteControlRelayPairingUrl } from '../src/remoteControlRelayContract';
import {
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
} from '../src/remoteControlRelayCrypto';
import {
  REMOTE_CONTROL_RELAY_RPCS,
  RemoteControlRelayHostRpcTransport,
  type RemoteControlRelayRpcInvoker,
} from '../src/remoteControlRelayRpcClient';
import { REMOTE_CONTROL_HOST_SILENT_MS } from '../src/remoteControlRelayController';

const start = Date.parse('2099-08-30T12:00:00.000Z');
const sessionId = '22222222-2222-4222-8222-222222222222';
const controllerId = '33333333-3333-4333-8333-333333333333';

class CadenceTransport implements RemoteControlInternetHostTransport {
  registration: RemoteControlInternetHostRegistration | null = null;
  sessions: RemoteControlInternetSessionRow[] = [];
  deliveries: RemoteControlInternetReceivedEnvelope[] = [];
  listCalls = 0;
  async registerHost(input: RemoteControlInternetHostRegistration) {
    this.registration = input;
    return {
      expiresAt: '2099-10-30T12:00:00.000Z',
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(input.hostPublicKey),
    };
  }
  async createPairing(_input: RemoteControlInternetPairingRegistration) {
    return {
      pairingId: '00000001-1111-4111-8111-111111111111',
      expiresAt: '2099-09-29T12:00:00.000Z',
      hostPublicKey: this.registration!.hostPublicKey,
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(this.registration!.hostPublicKey),
      retiredPairingIds: [],
    };
  }
  async listSessions() {
    this.listCalls += 1;
    return this.sessions.map(row => ({ ...row }));
  }
  async approveSession(_hostId: string, _hostSecret: string, id: string) {
    const row = this.sessions.find(candidate => candidate.sessionId === id)!;
    const approved = { ...row, approvalState: 'approved' as const, approvedAt: new Date(start).toISOString() };
    this.sessions = this.sessions.map(candidate => candidate.sessionId === id ? approved : candidate);
    return approved;
  }
  async revokeSession() {}
  async disableHost() {}
  async receiveEnvelopes() { return this.deliveries; }
  async sendEnvelope() {}
  async acknowledge() {}
}

const gateway: RemoteControlGateway = {
  listRegisteredProjects: () => [],
  executeRegisteredProjectAction: async () => undefined,
};

async function approvedHost(options: { withLastSeen: boolean }) {
  let now = start;
  const delays: number[] = [];
  const transport = new CadenceTransport();
  const agent = new RemoteControlInternetAgent({
    gateway,
    transport,
    controllerOrigin: 'https://controller.example.test',
    hostName: '테스트 Mac',
    now: () => now,
    randomSecret: () => 'H'.repeat(43),
    onRecordChanged: () => undefined,
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });
  const pairing = await agent.initialize();
  const parsed = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);
  const keys = await generateRemoteControlRelayKeyPair();
  const controllerPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  transport.sessions = [{
    sessionId,
    pairingId: parsed.bootstrap.pairingId,
    controllerId,
    controllerName: '내 iPhone',
    controllerPublicKey,
    controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
    approvalState: 'pending',
    createdAt: new Date(start).toISOString(),
    expiresAt: '2099-09-29T12:00:00.000Z',
    approvedAt: null,
    revokedAt: null,
    ...(options.withLastSeen ? { controllerLastSeenAt: new Date(start).toISOString() } : {}),
  }];
  await agent.pollNow();
  const sas = agent.status().sessions[0]!.sasCode!;
  await agent.approveSession(sessionId, sas);
  return {
    agent,
    transport,
    delays,
    advance(ms: number) { now += ms; },
    now: () => now,
    setControllerLastSeen(iso: string) {
      transport.sessions = transport.sessions.map(row => ({ ...row, controllerLastSeenAt: iso }));
    },
  };
}

describe('host relay poll cadence follows controller activity, not session existence', () => {
  test('pure cadence: 1s while a controller is recent, 5s up to 10 minutes, then 20s', () => {
    const base = { nowMs: start, controllerLastSeenAvailable: true, hasSessions: true };
    expect(remoteControlHostPollDelayMs({ ...base, lastControllerActivityAtMs: start - 5_000 })).toBe(1_000);
    expect(remoteControlHostPollDelayMs({ ...base, lastControllerActivityAtMs: start - REMOTE_CONTROL_HOST_ACTIVE_WINDOW_MS })).toBe(5_000);
    expect(remoteControlHostPollDelayMs({ ...base, lastControllerActivityAtMs: start - REMOTE_CONTROL_HOST_IDLE_WINDOW_MS })).toBe(20_000);
  });

  test('an older relay without the controller stamp never sleeps past 5s while a session exists', () => {
    expect(remoteControlHostPollDelayMs({
      nowMs: start,
      lastControllerActivityAtMs: start - 60 * 60_000,
      controllerLastSeenAvailable: false,
      hasSessions: true,
    })).toBe(5_000);
  });

  test('the slowest cadence stays well inside the phone\'s host-silent threshold', () => {
    const slowest = remoteControlHostPollDelayMs({
      nowMs: start,
      lastControllerActivityAtMs: 0,
      controllerLastSeenAvailable: true,
      hasSessions: false,
    });
    // The relay stamps hosts.last_seen_at at most every 10s; poll + stamp gap
    // must still leave the phone room before it calls the Mac silent.
    expect(slowest + 10_000).toBeLessThan(REMOTE_CONTROL_HOST_SILENT_MS / 2 + 1);
  });

  test('an approved but idle session backs off instead of polling every second forever', async () => {
    const host = await approvedHost({ withLastSeen: true });
    host.advance(2 * 60_000);
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(5_000);
    host.advance(REMOTE_CONTROL_HOST_IDLE_WINDOW_MS);
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(20_000);
  });

  test('a phone polling the relay (its last-seen stamp moves) brings the host back to 1s', async () => {
    const host = await approvedHost({ withLastSeen: true });
    host.advance(REMOTE_CONTROL_HOST_IDLE_WINDOW_MS + 60_000);
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(20_000);
    // Relay clock can disagree with ours; only the movement matters.
    host.setControllerLastSeen('2099-08-30T09:00:00.000Z');
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(1_000);
  });

  test('the operator opening the panel wakes a dormant host immediately', async () => {
    const host = await approvedHost({ withLastSeen: true });
    host.advance(REMOTE_CONTROL_HOST_IDLE_WINDOW_MS + 60_000);
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(20_000);
    host.agent.noteOperatorActivity();
    expect(host.delays.at(-1)).toBe(1_000);
  });

  test('the operator panel does not cut short the error backoff of a failing relay', async () => {
    const host = await approvedHost({ withLastSeen: true });
    host.transport.listSessions = async () => { throw new Error('relay down'); };
    for (let i = 0; i < 6; i += 1) await host.agent.pollNow().catch(() => undefined);
    expect(host.delays.at(-1)).toBe(30_000);
    // The dialog polls status every 3s; each call must not force a 1s retry.
    host.agent.noteOperatorActivity();
    expect(host.delays.at(-1)).toBe(30_000);
  });

  test('without the relay stamp an approved session still backs off to 5s, not 1s', async () => {
    const host = await approvedHost({ withLastSeen: false });
    host.advance(REMOTE_CONTROL_HOST_IDLE_WINDOW_MS + 60_000);
    await host.agent.pollNow();
    expect(host.delays.at(-1)).toBe(5_000);
  });

  test('a pending pairing keeps the host at 1s so the approval prompt shows up at once', async () => {
    const host = await approvedHost({ withLastSeen: true });
    host.transport.sessions = host.transport.sessions.map(row => ({ ...row, approvalState: 'pending' as const, approvedAt: null }));
    host.advance(REMOTE_CONTROL_HOST_IDLE_WINDOW_MS + 60_000);
    await host.agent.pollNow().catch(() => undefined);
    expect(host.delays.at(-1)).toBe(1_000);
  });
});

describe('relay rpc exposes the controller last-seen stamp without breaking older schemas', () => {
  class FakeRpc implements RemoteControlRelayRpcInvoker {
    constructor(private readonly row: Record<string, unknown>) {}
    async rpc(name: string) {
      if (name !== REMOTE_CONTROL_RELAY_RPCS.hostListSessions) return { data: [], error: null };
      return { data: [this.row], error: null };
    }
  }
  const publicKey = `B${'A'.repeat(86)}`;
  const row = {
    session_id: sessionId,
    pairing_id: '11111111-1111-4111-8111-111111111111',
    controller_id: controllerId,
    controller_name: '내 iPhone',
    controller_public_key: publicKey,
    controller_key_fingerprint: 'F'.repeat(43),
    approval_state: 'approved',
    created_at: '2099-08-30T12:00:00+00:00',
    expires_at: '2099-08-30T12:30:00+00:00',
    approved_at: '2099-08-30T12:00:00+00:00',
    revoked_at: null,
  };

  test('maps last_seen_at when the relay returns it', async () => {
    const transport = new RemoteControlRelayHostRpcTransport(new FakeRpc({ ...row, last_seen_at: '2099-08-30T12:01:00+00:00' }));
    const [session] = await transport.listSessions('11111111-1111-4111-8111-111111111111', 'S'.repeat(43));
    expect(session?.controllerLastSeenAt).toBe('2099-08-30T12:01:00.000Z');
  });

  test('keeps the field absent (not null) on a relay that predates it', async () => {
    const transport = new RemoteControlRelayHostRpcTransport(new FakeRpc(row));
    const [session] = await transport.listSessions('11111111-1111-4111-8111-111111111111', 'S'.repeat(43));
    expect(session).toBeDefined();
    expect('controllerLastSeenAt' in session!).toBe(false);
  });
});
