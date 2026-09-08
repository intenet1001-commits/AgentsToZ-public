import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteControlGateway } from '../src/remoteControlCore';
import type { RemoteControlRegisteredTarget } from '../src/remoteControlProcessGateway';
import {
  RemoteControlInternetAgent,
  type RemoteControlInternetHostRegistration,
  type RemoteControlInternetHostTransport,
  type RemoteControlInternetPairingRegistration,
  type RemoteControlInternetReceivedEnvelope,
  type RemoteControlInternetRelayMessageType,
  type RemoteControlInternetSessionRow,
} from '../src/remoteControlInternetAgent';
import type { RemoteControlHostRecord } from '../src/remoteControlHostVault';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  parseRemoteControlRelayPairingUrl,
  type RemoteControlRelayEnvelope,
} from '../src/remoteControlRelayContract';
import {
  decryptRemoteControlRelayEnvelope,
  deriveRemoteControlRelaySessionKey,
  encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = Date.parse('2099-08-30T12:00:00.000Z');
const hostExpiresAt = '2099-09-02T12:00:00.000Z';
const pairingExpiresAt = '2099-08-31T12:00:00.000Z';
const sessionExpiresAt = '2099-08-31T12:00:00.000Z';
const sessionId = '22222222-2222-4222-8222-222222222222';
const controllerId = '33333333-3333-4333-8333-333333333333';

/** The relay is Supabase: its rows outlive any Mac process, which is exactly
 *  why a restart that forgets its own identity is a bug and not a reset. */
class RelayDouble implements RemoteControlInternetHostTransport {
  registration: RemoteControlInternetHostRegistration | null = null;
  registerCalls = 0;
  pairingCalls = 0;
  sessions: RemoteControlInternetSessionRow[] = [];
  deliveries: RemoteControlInternetReceivedEnvelope[] = [];
  sent: Array<{ type: RemoteControlInternetRelayMessageType; envelope: RemoteControlRelayEnvelope }> = [];
  acknowledgements: string[] = [];
  hostRevoked = false;

  hostExpiresAtOverride: string | null = null;
  async registerHost(input: RemoteControlInternetHostRegistration) {
    this.registerCalls += 1;
    // The real `register_host` is a plain insert with no upsert.
    if (this.registration) throw new Error('REMOTE_CONTROL_HOST_ALREADY_REGISTERED');
    this.registration = input;
    return {
      expiresAt: this.hostExpiresAtOverride ?? hostExpiresAt,
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(input.hostPublicKey),
    };
  }
  async createPairing(_input: RemoteControlInternetPairingRegistration) {
    this.pairingCalls += 1;
    return {
      pairingId: `1111111${this.pairingCalls}-1111-4111-8111-111111111111`,
      expiresAt: pairingExpiresAt,
      hostPublicKey: this.registration!.hostPublicKey,
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(this.registration!.hostPublicKey),
    };
  }
  renewCalls: number[] = [];
  renewedExpiresAt = '2099-11-01T12:00:00.000Z';
  async renewHost(_hostId: string, _hostSecret: string, ttlSeconds: number) {
    this.renewCalls.push(ttlSeconds);
    return this.renewedExpiresAt;
  }
  async listSessions() {
    if (this.hostRevoked) throw new Error('REMOTE_CONTROL_HOST_AUTH_FAILED');
    return this.sessions.map(row => ({ ...row }));
  }
  async approveSession(_hostId: string, _hostSecret: string, id: string) {
    const row = this.sessions.find(candidate => candidate.sessionId === id)!;
    const approved = { ...row, approvalState: 'approved' as const, approvedAt: new Date(now).toISOString() };
    this.sessions = this.sessions.map(candidate => candidate.sessionId === id ? approved : candidate);
    return approved;
  }
  async revokeSession() {}
  async disableHost() {}
  async receiveEnvelopes(_hostId: string, _hostSecret: string, after: string) {
    return this.deliveries.filter(item => BigInt(item.relaySequence) > BigInt(after));
  }
  async sendEnvelope(
    _hostId: string,
    _hostSecret: string,
    _sessionId: string,
    type: RemoteControlInternetRelayMessageType,
    envelope: RemoteControlRelayEnvelope,
  ) {
    this.sent.push({ type, envelope });
  }
  async acknowledge(_hostId: string, _hostSecret: string, _sessionId: string, through: string) {
    this.acknowledgements.push(through);
  }
}

function uuidSequence(prefix: string) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}${index.toString(16).padStart(7, '0')}-1111-4111-8111-111111111111`;
  };
}

function gatewayDouble(executions: string[]): RemoteControlGateway {
  let targets: RemoteControlRegisteredTarget[] = [{
    internalId: 'private-project-id',
    name: '내 프로젝트',
    port: 4317,
    kind: 'main' as const,
    folderPath: '/Users/private/project',
    command: 'bun run secret',
    status: 'stopped' as const,
    actions: ['start' as const],
  }];
  return {
    listRegisteredProjects: () => targets,
    executeRegisteredProjectAction: async request => {
      executions.push(request.actionId);
      targets = targets.map(target => ({
        ...target,
        status: 'running' as const,
        actions: ['stop' as const, 'restart' as const],
      }));
    },
  };
}

/**
 * The whole point: a phone paired before the Mac restarted must keep working,
 * with the QR it already has.
 *
 * Before this, `#hostId`, `#hostSecret` and the key pair were minted in the
 * constructor and `/enable` was reachable only from a button, so every restart
 * — every update install — made the Mac a different host while Supabase still
 * held a 30-day pairing and an approved session. The phone showed a device
 * authenticated for weeks that nothing ever answered.
 */
describe('the Mac comes back as the same host', () => {
  test('a phone paired before a restart keeps its QR, its keys and its place in the sequence', async () => {
    const relay = new RelayDouble();
    const executions: string[] = [];
    let stored: RemoteControlHostRecord | null = null;

    const first = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('a'),
      randomSecret: () => 'H'.repeat(43),
      autoPoll: false,
      onRecordChanged: record => { stored = record; },
    });
    const pairing = await first.initialize();
    const qr = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);

    // The phone scans that QR once and keeps these forever.
    const phone = await generateRemoteControlRelayKeyPair();
    const phonePublicKey = await exportRemoteControlRelayPublicKey(phone.publicKey);
    const hostPublic = await importRemoteControlRelayPublicKey(qr.bootstrap.hostPublicKey);
    const phoneSend = await deriveRemoteControlRelaySessionKey({
      privateKey: phone.privateKey, peerPublicKey: hostPublic,
      sessionId, controllerId, direction: 'controller-to-host', usages: ['encrypt'],
    });
    const phoneReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: phone.privateKey, peerPublicKey: hostPublic,
      sessionId, controllerId, direction: 'host-to-controller', usages: ['decrypt'],
    });
    const fromPhone = async (sequence: number, messageId: string, payload: unknown) => ({
      relaySequence: String(sequence),
      envelope: await encryptRemoteControlRelayEnvelope({
        key: phoneSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId, sessionId, controllerId, sequence, expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify(payload)),
        now,
      }),
    });
    const readByPhone = async (envelope: RemoteControlRelayEnvelope) => JSON.parse(decoder.decode(
      await decryptRemoteControlRelayEnvelope({ key: phoneReceive, envelope, now }),
    )) as Record<string, any>;

    relay.sessions = [{
      sessionId,
      pairingId: qr.bootstrap.pairingId,
      controllerId,
      controllerName: '내 iPhone',
      controllerPublicKey: phonePublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(phonePublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await first.pollNow();
    await first.approveSession(sessionId, first.status().sessions[0]!.sasCode!);

    relay.deliveries.push(await fromPhone(1, '44444444-4444-4444-8444-444444444444', {
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: qr.bootstrap.pairingSecret,
    }));
    await first.pollNow();
    const firstReady = await readByPhone(relay.sent.at(-1)!.envelope);
    expect(firstReady.type).toBe('session.ready');

    relay.deliveries.push(await fromPhone(2, '55555555-5555-4555-8555-555555555555', {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: firstReady.sessionToken,
      actionId: 'before-restart',
      action: 'start',
      controlId: firstReady.projects[0].controlId,
      remoteConfirmed: true,
    }));
    await first.pollNow();
    expect(executions).toEqual(['before-restart']);
    const beforeRestartSequence = relay.sent.at(-1)!.envelope.sequence;

    // ---- the app is updated and restarted here ----
    const record = stored as RemoteControlHostRecord | null;
    expect(record).not.toBeNull();
    expect(record!.sessions).toHaveLength(1);
    expect(record!.sessions[0]).toMatchObject({ sessionId, controllerId });

    const second = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('b'),
      randomSecret: () => 'Z'.repeat(43),
      autoPoll: false,
      restore: record!,
      onRecordChanged: next => { stored = next; },
    });
    const resumed = await second.restore();

    // The QR in the phone's pocket still describes this Mac.
    const resumedQr = parseRemoteControlRelayPairingUrl(resumed.pairingUrl);
    expect(resumedQr.bootstrap.hostId).toBe(qr.bootstrap.hostId);
    expect(resumedQr.bootstrap.hostPublicKey).toBe(qr.bootstrap.hostPublicKey);
    expect(resumedQr.bootstrap.pairingSecret).toBe(qr.bootstrap.pairingSecret);
    // Re-registering would collide with the row that is still there.
    expect(relay.registerCalls).toBe(1);
    expect(relay.pairingCalls).toBe(1);

    // The phone is handed a live token without being asked, because it only
    // re-pairs on its own when it has no token at all.
    await second.pollNow();
    const announced = relay.sent.at(-1)!;
    const resumedReady = await readByPhone(announced.envelope);
    expect(resumedReady.type).toBe('session.ready');
    expect(resumedReady.sessionToken).not.toBe(firstReady.sessionToken);
    expect(announced.envelope.sequence).toBe(beforeRestartSequence + 1);

    // And that token works, on the phone's own next sequence number.
    relay.deliveries.push(await fromPhone(3, '66666666-6666-4666-8666-666666666666', {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: resumedReady.sessionToken,
      actionId: 'after-restart',
      action: 'start',
      controlId: resumedReady.projects[0].controlId,
      remoteConfirmed: true,
    }));
    await second.pollNow();
    expect(executions).toEqual(['before-restart', 'after-restart']);
    const result = await readByPhone(relay.sent.at(-1)!.envelope);
    expect(result).toMatchObject({ type: 'action.result', actionId: 'after-restart', ok: true });
  });

  test('an unreachable relay at startup must not cost the phone its pairing', async () => {
    const relay = new RelayDouble();
    const executions: string[] = [];
    let stored: RemoteControlHostRecord | null = null;
    const first = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('e'),
      randomSecret: () => 'H'.repeat(43),
      autoPoll: false,
      onRecordChanged: record => { stored = record; },
    });
    await first.initialize();
    const saved = stored as RemoteControlHostRecord | null;
    expect(saved).not.toBeNull();

    // The Mac woke up before its network did.
    relay.listSessions = async () => { throw new Error('fetch failed'); };
    const emitted: Array<RemoteControlHostRecord | null> = [];
    const second = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('f'),
      randomSecret: () => 'Z'.repeat(43),
      autoPoll: false,
      restore: saved!,
      onRecordChanged: next => { emitted.push(next); },
    });
    await expect(second.restore()).rejects.toThrow('fetch failed');
    // Emitting null here would delete the stored identity, and the phone would
    // be sent to scan a new QR because of a timeout.
    expect(emitted).not.toContain(null);
    expect(second.status().enabled).toBe(false);
  });

  test('a phone that missed the pushed token is repaired by its own stale request', async () => {
    const relay = new RelayDouble();
    const executions: string[] = [];
    let stored: RemoteControlHostRecord | null = null;
    const first = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('c'),
      randomSecret: () => 'H'.repeat(43),
      autoPoll: false,
      onRecordChanged: record => { stored = record; },
    });
    const pairing = await first.initialize();
    const qr = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);
    const phone = await generateRemoteControlRelayKeyPair();
    const phonePublicKey = await exportRemoteControlRelayPublicKey(phone.publicKey);
    const hostPublic = await importRemoteControlRelayPublicKey(qr.bootstrap.hostPublicKey);
    const phoneSend = await deriveRemoteControlRelaySessionKey({
      privateKey: phone.privateKey, peerPublicKey: hostPublic,
      sessionId, controllerId, direction: 'controller-to-host', usages: ['encrypt'],
    });
    const phoneReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: phone.privateKey, peerPublicKey: hostPublic,
      sessionId, controllerId, direction: 'host-to-controller', usages: ['decrypt'],
    });
    const fromPhone = async (sequence: number, messageId: string, payload: unknown) => ({
      relaySequence: String(sequence),
      envelope: await encryptRemoteControlRelayEnvelope({
        key: phoneSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId, sessionId, controllerId, sequence, expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify(payload)),
        now,
      }),
    });
    relay.sessions = [{
      sessionId,
      pairingId: qr.bootstrap.pairingId,
      controllerId,
      controllerName: '내 iPhone',
      controllerPublicKey: phonePublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(phonePublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await first.pollNow();
    await first.approveSession(sessionId, first.status().sessions[0]!.sasCode!);
    relay.deliveries.push(await fromPhone(1, '44444444-4444-4444-8444-444444444444', {
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: qr.bootstrap.pairingSecret,
    }));
    await first.pollNow();
    const staleToken = (JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: phoneReceive, envelope: relay.sent.at(-1)!.envelope, now,
    }))) as { sessionToken: string }).sessionToken;

    // Restart, and the phone was asleep long enough that the pushed
    // session.ready expired unread — so it arrives with the dead token.
    const second = new RemoteControlInternetAgent({
      gateway: gatewayDouble(executions),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('d'),
      randomSecret: () => 'Z'.repeat(43),
      autoPoll: false,
      restore: stored as unknown as RemoteControlHostRecord,
      onRecordChanged: () => {},
    });
    await second.restore();
    relay.deliveries.push(await fromPhone(2, '77777777-7777-4777-8777-777777777777', {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: staleToken,
      actionId: 'with-dead-token',
      action: 'start',
      controlId: 'C'.repeat(43),
      remoteConfirmed: true,
    }));
    const sentBefore = relay.sent.length;
    await second.pollNow();

    // Every reply after the restart is readable, and the phone ends up with a
    // usable token rather than an error it can never act on — the controller
    // never drops a session token by itself.
    const replies = await Promise.all(relay.sent.slice(sentBefore).map(async item => JSON.parse(decoder.decode(
      await decryptRemoteControlRelayEnvelope({ key: phoneReceive, envelope: item.envelope, now }),
    )) as Record<string, any>));
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every(reply => reply.type === 'session.ready')).toBe(true);
    expect(replies.at(-1)!.sessionToken).not.toBe(staleToken);
    expect(executions).toEqual([]);
  });
});

/**
 * `register_host` is a plain insert, so an expired host cannot be re-registered
 * under the same id: the QR, the pinned key and the approved session all die
 * with the row and the user is back to scanning. At a 62-day TTL that was a
 * scheduled break every two months for a connection that was working fine.
 */
describe('a host in daily use renews itself', () => {
  async function hostExpiringIn(ms: number) {
    const relay = new RelayDouble();
    const agent = new RemoteControlInternetAgent({
      gateway: gatewayDouble([]),
      transport: relay,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence('9'),
      randomSecret: () => 'H'.repeat(43),
      autoPoll: false,
    });
    relay.hostExpiresAtOverride = new Date(now + ms).toISOString();
    await agent.initialize();
    return { relay, agent };
  }

  test('renews inside the window and leaves a healthy host alone', async () => {
    const soon = await hostExpiringIn(24 * 60 * 60_000);
    await soon.agent.pollNow();
    expect(soon.relay.renewCalls).toEqual([62 * 24 * 60 * 60]);
    expect(soon.agent.status().hostExpiresAt).toBe(soon.relay.renewedExpiresAt);

    const healthy = await hostExpiringIn(60 * 24 * 60 * 60_000);
    await healthy.agent.pollNow();
    expect(healthy.relay.renewCalls).toEqual([]);
  });

  test('a failed renewal never takes down a host that is still valid today', async () => {
    const { relay, agent } = await hostExpiringIn(24 * 60 * 60_000);
    relay.renewHost = async () => { throw new Error('fetch failed'); };
    await agent.pollNow();
    expect(agent.status().enabled).toBe(true);
    expect(agent.status().error).toBeNull();
  });
});
