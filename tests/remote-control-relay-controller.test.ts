import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlCore';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
  type RemoteControlRelayEnvelope,
} from '../src/remoteControlRelayContract';
import {
  REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS,
  REMOTE_CONTROL_HOST_SILENT_MS,
  REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
  REMOTE_CONTROL_ACTION_RESULT_POLL_MS,
  REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS,
  REMOTE_CONTROL_SELECTED_HOST_POLL_MS,
  RemoteControlRelayController,
  RemoteControlRelayControllerManager,
  type RemoteControlRelayControllerTransport,
} from '../src/remoteControlRelayController';
import {
  decryptRemoteControlRelayEnvelope,
  deriveRemoteControlRelaySessionKey,
  encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from '../src/remoteControlTaskProtocol';
import { AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION } from '../src/agentRuntimeConversationProtocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = Date.parse('2099-08-30T12:00:00.000Z');
const expiresAt = '2099-08-30T12:30:00.000Z';
const pairingExpiresAt = '2099-08-30T12:05:00.000Z';
const hostId = '11111111-1111-4111-8111-111111111111';
const pairingId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const controllerId = '44444444-4444-4444-8444-444444444444';
const pairingSecret = encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(4));

class FakeControllerTransport implements RemoteControlRelayControllerTransport {
  approvalState: 'pending' | 'approved' | 'revoked' = 'pending';
  hostExpiresAt = expiresAt;
  /** Null keeps the default behaviour: liveness unknown, so nothing is blocked. */
  hostLastSeenAt: string | null = null;
  sessionExpiresAt = expiresAt;
  controllerPublicKey = '';
  claimPublicKeys: string[] = [];
  sent: RemoteControlRelayEnvelope[] = [];
  deliveries: Array<{ relaySequence: string; envelope: RemoteControlRelayEnvelope }> = [];
  acks: string[] = [];
  statusCalls = 0;
  onSend: ((envelope: RemoteControlRelayEnvelope) => Promise<void>) | null = null;
  receiveError: Error | null = null;
  revokeError: Error | null = null;
  failNextClaimAfterCommit = false;
  failNextSendAfterCommit = false;
  constructor(readonly hostPublicKey: string, readonly hostFingerprint: string) {}
  async claimPairing(input: { controllerPublicKey: string }) {
    this.controllerPublicKey = input.controllerPublicKey;
    this.claimPublicKeys.push(input.controllerPublicKey);
    const claim = {
      sessionId,
      controllerId,
      hostId,
      hostName: '내 Mac',
      hostPublicKey: this.hostPublicKey,
      hostPublicKeyFingerprint: this.hostFingerprint,
      approvalState: 'pending' as const,
      expiresAt,
    };
    if (this.failNextClaimAfterCommit) {
      this.failNextClaimAfterCommit = false;
      throw Object.assign(new Error('RELAY_CONNECTION_FAILED'), { code: 'RELAY_CONNECTION_FAILED' });
    }
    return claim;
  }
  async status() {
    this.statusCalls += 1;
    return {
      sessionId,
      controllerId,
      approvalState: this.approvalState,
      hostEnabled: true,
      hostExpiresAt: this.hostExpiresAt,
      sessionExpiresAt: this.sessionExpiresAt,
      revokedAt: null,
      hostLastSeenAt: this.hostLastSeenAt,
    };
  }
  async sendEnvelope(_hostId: string, _sessionId: string, envelope: RemoteControlRelayEnvelope) {
    this.sent.push(envelope);
    await this.onSend?.(envelope);
    if (this.failNextSendAfterCommit) {
      this.failNextSendAfterCommit = false;
      throw new Error('simulated controller send response loss');
    }
  }
  pollHook: (() => Promise<void>) | null = null;
  async receiveEnvelopes(_hostId: string, _sessionId: string, after: string) {
    if (this.receiveError) throw this.receiveError;
    await this.pollHook?.();
    return this.deliveries.filter(delivery => BigInt(delivery.relaySequence) > BigInt(after));
  }
  async acknowledge(_hostId: string, _sessionId: string, through: string) { this.acks.push(through); }
  async revoke() {
    this.approvalState = 'revoked';
    if (this.revokeError) throw this.revokeError;
  }
}

function uuidSequence() {
  const values = [
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ];
  return () => values.shift() ?? '88888888-8888-4888-8888-888888888888';
}

describe('hosted authenticated controller workflow', () => {
  test('pins the QR host key, waits for Mac approval, and speaks encrypted protocol-v4 only', async () => {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const hostFingerprint = await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
    const pairingUrl = buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
      hostId,
      pairingId,
      pairingSecret,
      hostPublicKey,
      expiresAt: pairingExpiresAt,
    });
    const transport = new FakeControllerTransport(hostPublicKey, hostFingerprint);
    let cleared = 0;
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl,
      controllerName: '내 iPhone',
      now: () => now,
      randomUuid: uuidSequence(),
      onClaimed: () => { cleared += 1; },
    });
    const pending = await controller.initialize();
    expect(pending.state).toBe('approval-required');
    expect(pending.busy).toBe(false);
    expect(pending.sasCode).toMatch(/^\d{6}$/);
    expect(cleared).toBe(1);
    expect(transport.sent).toHaveLength(0);

    const controllerPublic = await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
    const hostReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });

    transport.approvalState = 'approved';
    const connecting = await controller.refresh();
    expect(connecting.busy).toBe(false);
    expect(controller.status().state).toBe('connecting');
    const pair = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: hostReceive,
      envelope: transport.sent[0]!,
      now,
    }))) as Record<string, unknown>;
    expect(pair).toEqual({
      type: 'controller.pair',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      token: pairingSecret,
    });
    expect(JSON.stringify(transport.sent[0])).not.toContain(pairingSecret);

    transport.deliveries = [{
      relaySequence: '1',
      envelope: await encryptRemoteControlRelayEnvelope({
        key: hostSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId: '99999999-9999-4999-8999-999999999999',
          sessionId,
          controllerId,
          sequence: 1,
          expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify({
          type: 'session.ready',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: 'T'.repeat(43),
          hostName: '내 Mac',
          expiresAt,
          idleExpiresAt: '2099-08-30T12:10:00.000Z',
          projects: [{
            controlId: 'C'.repeat(43),
            name: '테스트 프로젝트',
            port: 4317,
            kind: 'main',
            status: 'stopped',
            actions: ['start'],
          }],
          projectCount: 1,
          nextPage: null,
        })),
        now,
      }),
    }];
    const online = await controller.refresh();
    expect(online.busy).toBe(false);
    expect(controller.status()).toMatchObject({ state: 'online', hostName: '내 Mac' });
    expect(controller.status().projects[0]).toMatchObject({ name: '테스트 프로젝트', status: 'stopped' });
    expect(transport.acks).toEqual(['1']);

    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      if (transport.deliveries.some(delivery => delivery.relaySequence === '2')) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: hostReceive, envelope, now }))) as {
        actionId: string;
      };
      transport.deliveries.push({
        relaySequence: '2',
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            sessionId,
            controllerId,
            sequence: 2,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify({
            type: 'action.result',
            actionId: request.actionId,
            ok: true,
            project: {
              controlId: 'C'.repeat(43),
              name: '테스트 프로젝트',
              port: 4317,
              kind: 'main',
              status: 'running',
              actions: ['stop', 'restart'],
            },
          })),
          now,
        }),
      });
    };
    transport.failNextSendAfterCommit = true;
    await expect(controller.sendAction('start', 'C'.repeat(43))).rejects.toThrow('simulated controller send response loss');
    expect(controller.status().busy).toBe(true);
    const ambiguouslyCommitted = transport.sent.at(-1)!;
    await expect(controller.sendAction('start', 'C'.repeat(43))).rejects.toThrow('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    await controller.refresh();
    expect(transport.sent.at(-1)).toEqual(ambiguouslyCommitted);
    expect(controller.status().projects[0]?.status).toBe('running');
    expect(controller.status().busy).toBe(false);
    expect(transport.acks).toEqual(['1', '2']);

    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      if (transport.deliveries.some(delivery => delivery.relaySequence === '3')) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: hostReceive, envelope, now }))) as {
        actionId: string;
      };
      transport.deliveries.push({
        relaySequence: '3',
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            sessionId,
            controllerId,
            sequence: 3,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify({
            type: 'action.result',
            actionId: request.actionId,
            ok: false,
            error: {
              code: 'GIT_WORKTREE_DIRTY',
              message: '미커밋 변경이 있어 Pull하지 않았습니다.',
            },
          })),
          now,
        }),
      });
    };
    await expect(controller.sendAction('git.pull', 'C'.repeat(43))).rejects.toThrow(
      '미커밋 변경이 있어 Pull하지 않았습니다.',
    );
    expect(controller.status().busy).toBe(false);
    expect(transport.acks).toEqual(['1', '2', '3']);

    transport.receiveError = Object.assign(
      new Error('REMOTE_CONTROL_SESSION_ACCESS_DENIED'),
      { code: 'REMOTE_CONTROL_SESSION_ACCESS_DENIED' },
    );
    await expect(controller.refresh()).rejects.toThrow('REMOTE_CONTROL_SESSION_ACCESS_DENIED');
    expect(controller.status()).toMatchObject({ state: 'closed', busy: false, projects: [] });
  });

  test('retries an ambiguously committed claim with the exact same controller key', async () => {
    const host = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    transport.failNextClaimAfterCommit = true;
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await expect(controller.initialize()).resolves.toMatchObject({ state: 'approval-required' });
    expect(transport.claimPublicKeys).toHaveLength(2);
    expect(new Set(transport.claimPublicKeys).size).toBe(1);
  });

  test('keeps a claimed approval pending past QR expiry and closes only at host/session expiry', async () => {
    const host = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const hostFingerprint = await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
    let clock = now;
    const makeController = (transport: FakeControllerTransport) => new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => clock,
    });

    const expiredSessionTransport = new FakeControllerTransport(hostPublicKey, hostFingerprint);
    const expiredSessionController = makeController(expiredSessionTransport);
    await expiredSessionController.initialize();
    expiredSessionTransport.sessionExpiresAt = new Date(now).toISOString();
    await expect(expiredSessionController.refresh()).resolves.toMatchObject({ state: 'closed' });

    const expiredApprovalTransport = new FakeControllerTransport(hostPublicKey, hostFingerprint);
    const expiredApprovalController = makeController(expiredApprovalTransport);
    await expiredApprovalController.initialize();
    clock = Date.parse(pairingExpiresAt);
    await expect(expiredApprovalController.refresh()).resolves.toMatchObject({ state: 'approval-required' });
    expiredApprovalTransport.sessionExpiresAt = new Date(clock).toISOString();
    await expect(expiredApprovalController.refresh()).resolves.toMatchObject({ state: 'closed' });
  });

  test('resumes an approved online session without reclaiming the QR or reusing a sender sequence', async () => {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await controller.initialize();
    const controllerPublic = await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
    const hostReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    transport.approvalState = 'approved';
    transport.onSend = async envelope => {
      if (envelope.sequence !== 1 || transport.deliveries.length > 0) return;
      transport.deliveries.push({
        relaySequence: '1',
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: '99999999-9999-4999-8999-999999999999',
            sessionId,
            controllerId,
            sequence: 1,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify({
            type: 'session.ready',
            protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
            sessionToken: 'T'.repeat(43),
            hostName: '내 Mac',
            expiresAt,
            idleExpiresAt: '2099-08-30T12:10:00.000Z',
            projects: [],
            projectCount: 0,
            nextPage: null,
          })),
          now,
        }),
      });
    };
    await controller.refresh();
    expect(controller.status().state).toBe('online');
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({ sendSequence: 1, relayCursor: '1', sessionToken: 'T'.repeat(43) });

    const resumed = new RemoteControlRelayController({
      transport,
      restoredSession: snapshot,
      controllerName: '내 iPhone',
      now: () => now,
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(resumed.status()).toMatchObject({ state: 'online', hostName: '내 Mac' });
    expect(transport.claimPublicKeys).toHaveLength(1);
    await resumed.refresh();
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as { actionId: string };
      transport.deliveries.push({
        relaySequence: '2',
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            sessionId,
            controllerId,
            sequence: 2,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify({
            type: 'action.result',
            actionId: request.actionId,
            ok: true,
            projects: [],
            page: 0,
            projectCount: 0,
            nextPage: null,
          })),
          now,
        }),
      });
    };
    await resumed.sendAction('projects.list', undefined, 0);
    expect(transport.sent.at(-1)?.sequence).toBe(2);
    expect(transport.claimPublicKeys).toHaveLength(1);
  });

  test('does not send controller.pair twice after reload while session.ready is still in flight', async () => {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await controller.initialize();
    const controllerPublic = await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    transport.approvalState = 'approved';
    await controller.refresh();
    expect(transport.sent).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({
      sendSequence: 1,
      pairRequestSent: true,
      pendingOutbound: null,
      sessionToken: '',
    });

    const resumed = new RemoteControlRelayController({
      transport,
      restoredSession: controller.snapshot(),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await resumed.refresh();
    expect(resumed.status().state).toBe('connecting');
    expect(transport.sent).toHaveLength(1);

    transport.deliveries.push({
      relaySequence: '1',
      envelope: await encryptRemoteControlRelayEnvelope({
        key: hostSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          sessionId,
          controllerId,
          sequence: 1,
          expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify({
          type: 'session.ready',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: 'T'.repeat(43),
          hostName: '내 Mac',
          expiresAt,
          idleExpiresAt: '2099-08-30T12:10:00.000Z',
          projects: [],
          projectCount: 0,
          nextPage: null,
        })),
        now,
      }),
    });
    await resumed.refresh();
    expect(resumed.status().state).toBe('online');
    expect(resumed.snapshot()).toMatchObject({ pairRequestSent: false, sessionToken: 'T'.repeat(43) });
    expect(transport.sent).toHaveLength(1);
  });

  test('revokes local keys before a relay revoke failure', async () => {
    const host = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    transport.revokeError = new Error('relay unavailable');
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await controller.initialize();
    await expect(controller.revoke()).rejects.toThrow('relay unavailable');
    expect(controller.status()).toMatchObject({ state: 'closed', projects: [], busy: false });
    await expect(controller.sendAction('projects.list')).rejects.toThrow('REMOTE_CONTROL_SESSION_NOT_READY');
  });

  test('fails before claim completion when relay substitutes the pinned host key', async () => {
    const host = await generateRemoteControlRelayKeyPair();
    const attacker = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const attackerPublicKey = await exportRemoteControlRelayPublicKey(attacker.publicKey);
    const transport = new FakeControllerTransport(
      attackerPublicKey,
      await fingerprintRemoteControlRelayPublicKey(attackerPublicKey),
    );
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await expect(controller.initialize()).rejects.toThrow('REMOTE_CONTROL_HOST_KEY_MISMATCH');
    expect(controller.status().state).toBe('error');
    expect(transport.sent).toHaveLength(0);
  });
});

describe('a request the Mac never answers must not wedge the controller', () => {
  async function connected(options: { sleep?: (ms: number) => Promise<void> } = {}) {
    const host = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(host.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    let clock = now;
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => clock,
      randomUuid: uuidSequence(),
      // Instant by default so the 60-attempt result poll does not cost a minute of wall clock.
      sleep: options.sleep ?? (async () => {}),
    });
    await controller.initialize();
    const controllerPublic = await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
    const hostReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: host.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: host.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    const deliver = async (relaySequence: string, sequence: number, message: unknown) => {
      transport.deliveries.push({
        relaySequence,
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: `9999999${sequence}-9999-4999-8999-999999999999`,
            sessionId,
            controllerId,
            sequence,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify(message)),
          now: clock,
        }),
      });
    };
    transport.approvalState = 'approved';
    await controller.refresh();
    return { controller, transport, deliver, hostReceive, setClock: (value: number) => { clock = value; } };
  }

  const ready = {
    type: 'session.ready',
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken: 'T'.repeat(43),
    hostName: '내 Mac',
    expiresAt,
    idleExpiresAt: '2099-08-30T12:10:00.000Z',
    projects: [{
      controlId: 'C'.repeat(43),
      name: '테스트 프로젝트',
      alias: null,
      workspaceRoot: null,
      port: null,
      kind: 'main',
      status: 'unknown',
      actions: ['git.commit'],
    }],
    projectCount: 1,
    nextPage: null,
  };

  async function advertiseFeatures(
    connection: Awaited<ReturnType<typeof connected>>,
    supportedFeatures: string[],
  ) {
    const { controller, transport, deliver, hostReceive } = connection;
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      expect(request).toEqual({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: 'T'.repeat(43),
        actionId: request.actionId,
        action: 'protocol.capabilities',
      });
      await deliver('2', 2, {
        type: 'action.result',
        actionId: request.actionId,
        ok: true,
        supportedFeatures,
      });
    };
    await controller.probeSupportedFeatures();
    transport.onSend = null;
    expect(controller.status().supportedFeatures).toEqual(supportedFeatures);
  }

  test('probes a legacy host once and pre-blocks task/conversation requests without hiding base actions', async () => {
    const connection = await connected();
    const { controller, transport, deliver, hostReceive } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    expect(controller.status().supportedFeatures).toBeNull();
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      expect(request.action).toBe('protocol.capabilities');
      await deliver('2', 2, {
        type: 'error',
        code: 'ACTION_NOT_ALLOWED',
        message: '허용되지 않은 원격 제어 기능입니다.',
      });
    };

    await expect(controller.probeSupportedFeatures()).resolves.toMatchObject({
      supportedFeatures: [],
      error: null,
      busy: false,
    });
    const sentAfterProbe = transport.sent.length;
    await controller.probeSupportedFeatures();
    expect(transport.sent).toHaveLength(sentAfterProbe);
    await expect(controller.sendTask('capabilities', {})).rejects.toMatchObject({
      code: REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
    });
    await expect(controller.sendConversation('capabilities', {})).rejects.toMatchObject({
      code: REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
    });
    expect(transport.sent).toHaveLength(sentAfterProbe);

    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      await deliver('3', 3, {
        type: 'action.result', actionId: request.actionId, ok: true,
        projects: [], page: 0, projectCount: 0, nextPage: null,
      });
    };
    await expect(controller.sendAction('projects.list', undefined, 0)).resolves.toMatchObject({ok:true,projects:[]});
  });

  test('a tap that lands during the 1s background poll waits for it instead of being refused', async () => {
    // Yield a macrotask per sleep instead of resolving inside the same microtask drain: the
    // wait for the poll is the behaviour under test, and a microtask-only sleep burns the whole
    // budget before the in-flight refresh can ever reach its finally block. Zero delay keeps the
    // 60-attempt result poll instant.
    const { controller, transport, deliver, hostReceive } = await connected({
      sleep: () => new Promise(resume => setTimeout(resume, 0)),
    });
    await deliver('1', 1, ready);
    await controller.refresh();

    // The portal polls every second and refresh() holds the controller's lock for the whole
    // relay round trip. A tap inside that window used to throw ACTION_IN_PROGRESS on a healthy
    // connection, and the portal rendered that as "check the Mac and your internet".
    let releasePoll!: () => void;
    const originalStatus = transport.status.bind(transport);
    transport.status = async (...args: Parameters<typeof originalStatus>) => {
      await new Promise<void>(resume => { releasePoll = resume; });
      return originalStatus(...args);
    };
    const polling = controller.refresh();
    while (!releasePoll) await Promise.resolve();

    let hostSequence = 1;
    transport.onSend = async envelope => {
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
          key: hostReceive,
          envelope,
          now,
        }))) as Record<string, unknown>;
      } catch { return; }
      if (request.type !== 'action.request') return;
      hostSequence += 1;
      await deliver(String(hostSequence), hostSequence, {
        type: 'action.result', actionId: request.actionId, ok: true,
        projects: [], page: 0, projectCount: 0, nextPage: null,
      });
    };
    const tap = controller.sendAction('projects.list', undefined, 0);
    releasePoll();
    await polling;
    await expect(tap).resolves.toMatchObject({ok:true,projects:[]});
  });

  test('a tap that waited out the poll is re-judged, not sent on stale preconditions', async () => {
    // Waiting for the poll opens a window the original checks did not cover: the very refresh
    // being waited on can end or replace the session. Sending anyway would put the request on a
    // connection the controller has already decided it is not allowed to use.
    const { controller, transport, deliver } = await connected({
      sleep: () => new Promise(resume => setTimeout(resume, 0)),
    });
    await deliver('1', 1, ready);
    await controller.refresh();
    expect(controller.status().state).toBe('online');

    let releasePoll!: () => void;
    const originalStatus = transport.status.bind(transport);
    transport.status = async (...args: Parameters<typeof originalStatus>) => {
      await new Promise<void>(resume => { releasePoll = resume; });
      return originalStatus(...args);
    };
    const polling = controller.refresh();
    while (!releasePoll) await Promise.resolve();

    let sent = 0;
    transport.onSend = async () => { sent += 1; };
    const tap = controller.sendAction('projects.list', undefined, 0);
    // The Mac revokes while the tap is parked on the poll it is waiting for.
    transport.approvalState = 'revoked';
    releasePoll();
    await polling;
    await expect(tap).rejects.toThrow('REMOTE_CONTROL_SESSION_NOT_READY');
    expect(sent).toBe(0);
    expect(controller.status().state).not.toBe('online');
  });

  test('restores a legacy snapshot as unverified and preserves an in-flight probe across reload', async () => {
    const { controller, transport, deliver } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();
    const legacySnapshot = controller.snapshot()!;
    expect(legacySnapshot).not.toHaveProperty('supportedFeatures');

    transport.failNextSendAfterCommit = true;
    await expect(controller.probeSupportedFeatures()).rejects.toThrow('simulated controller send response loss');
    const pendingSnapshot = controller.snapshot()!;
    expect(pendingSnapshot.pendingCapabilityProbeActionId).toBe(pendingSnapshot.pendingActionId);
    expect(pendingSnapshot.pendingOutbound?.sequence).toBe(2);

    const resumed = new RemoteControlRelayController({
      transport,
      restoredSession: pendingSnapshot,
      controllerName: '내 iPhone',
      now: () => now,
      sleep: async () => {},
    });
    expect(resumed.status()).toMatchObject({ supportedFeatures: null, busy: true });
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      await deliver('2', 2, {
        type: 'error',
        code: 'ACTION_NOT_ALLOWED',
        message: '허용되지 않은 원격 제어 기능입니다.',
      });
    };
    await resumed.refresh();
    expect(resumed.status()).toMatchObject({ supportedFeatures: [], busy: false, error: null });
  });

  for (const [label, supportedFeatures] of [
    ['too many', Array.from({ length: 9 }, (_, index) => `feature-${index}`)],
    ['duplicate', ['conversations-v1', 'conversations-v1']],
    ['malformed', ['CONVERSATIONS_V1']],
  ] as const) {
    test(`rejects a ${label} host capability result without enabling features`, async () => {
      const { controller, transport, deliver } = await connected();
      await deliver('1', 1, ready);
      await controller.refresh();
      transport.onSend = async envelope => {
        if (envelope.sequence !== 2) return;
        await deliver('2', 2, {
          type: 'action.result',
          actionId: '66666666-6666-4666-8666-666666666666',
          ok: true,
          supportedFeatures,
        });
      };
      await expect(controller.probeSupportedFeatures()).rejects.toThrow('REMOTE_CONTROL_RESPONSE_INVALID');
      expect(controller.status().supportedFeatures).toBeNull();
      expect(transport.acks).toEqual(['1']);
    });
  }

  test('invalidates an old manifest on authenticated host restart and replaces it after re-probing', async () => {
    const connection = await connected();
    const { controller, transport, deliver, hostReceive } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['conversations-v1']);

    await deliver('3', 3, {
      ...ready,
      sessionToken: 'U'.repeat(43),
      projects: [],
      projectCount: 0,
    });
    await controller.refresh();
    expect(controller.status()).toMatchObject({ supportedFeatures: null, projects: [] });

    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      expect(request).toMatchObject({
        action: 'protocol.capabilities',
        sessionToken: 'U'.repeat(43),
      });
      await deliver('4', 4, {
        type: 'action.result',
        actionId: request.actionId,
        ok: true,
        supportedFeatures: [],
      });
    };
    await controller.probeSupportedFeatures();
    expect(controller.status().supportedFeatures).toEqual([]);
  });

  test('a {type:error} reply releases the in-flight lock instead of disabling every button forever', async () => {
    const { controller, transport, deliver } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();
    expect(controller.status().state).toBe('online');

    // Reachable today: a commit message over 120 characters makes the host
    // reject the message itself, which answers {type:'error'} rather than an
    // action.result. That branch never cleared #pendingActionId, so one bad
    // commit message bricked the whole controller.
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      await deliver('2', 2, {
        type: 'error',
        code: 'INVALID_COMMIT_MESSAGE',
        message: '커밋 메시지는 한 줄 1~120자로 입력하세요.',
      });
    };
    await expect(controller.sendAction('git.commit', 'C'.repeat(43), undefined, 'x'.repeat(121)))
      .rejects.toMatchObject({
        code: 'INVALID_COMMIT_MESSAGE',
        message: '커밋 메시지는 한 줄 1~120자로 입력하세요.',
      });
    expect(controller.status().busy).toBe(false);
    // The next action must go through rather than throwing ACTION_IN_PROGRESS.
    transport.onSend = null;
    await expect(controller.sendAction('git.commit', 'C'.repeat(43), undefined, 'ok'))
      .rejects.toThrow(/요청은 전달되었고/);
  });

  test('a task parked on the poll is re-judged against the session the poll installed', async () => {
    // sendAction cannot cover this: its readiness check already existed. What is new is that
    // sendTask/sendConversation re-decide the *feature* gate after waiting. Receiving a fresh
    // session.ready clears the negotiated manifest, so a task admitted under the old session must
    // not go out under the new one — that is exactly the update-required gate being bypassed.
    const connection = await connected({ sleep: () => new Promise(resume => setTimeout(resume, 0)) });
    const { controller, transport, deliver } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['tasks-v1']);

    let releasePoll!: () => void;
    const originalStatus = transport.status.bind(transport);
    transport.status = async (...args: Parameters<typeof originalStatus>) => {
      await new Promise<void>(resume => { releasePoll = resume; });
      return originalStatus(...args);
    };
    const polling = controller.refresh();
    while (!releasePoll) await Promise.resolve();

    let sent = 0;
    transport.onSend = async () => { sent += 1; };
    const task = controller.sendTask('capabilities', {});
    // The host restarted: a new token arrives on the very poll the task is waiting for.
    await deliver('9', 9, { ...ready, sessionToken: 'U'.repeat(43) });
    releasePoll();
    await polling;
    await expect(task).rejects.toMatchObject({ code: REMOTE_CONTROL_HOST_UPDATE_REQUIRED });
    expect(sent).toBe(0);
  });

  test('classifies a v7 host task refusal as an app update requirement', async () => {
    const connection = await connected();
    const { controller, transport, deliver } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['tasks-v1']);
    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      await deliver('3', 3, {
        type: 'error',
        code: 'ACTION_NOT_ALLOWED',
        message: '허용되지 않은 원격 제어 기능입니다.',
      });
    };

    await expect(controller.sendTask('capabilities', {})).rejects.toMatchObject({
      code: REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
      message: expect.stringContaining('이전 설치본'),
    });
    expect(controller.status()).toMatchObject({ busy: false });
  });

  test('classifies a v7 host conversation refusal as an app update requirement', async () => {
    const connection = await connected();
    const { controller, transport, deliver } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['conversations-v1']);
    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      await deliver('3', 3, {
        type: 'error',
        code: 'ACTION_NOT_ALLOWED',
        message: '허용되지 않은 원격 제어 기능입니다.',
      });
    };

    await expect(controller.sendConversation('capabilities', {})).rejects.toMatchObject({
      code: REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
      message: expect.stringContaining('이전 설치본'),
    });
    expect(controller.status()).toMatchObject({ busy: false });
  });

  test('sends tasks-v1 only inside E2EE and correlates the exact semantic response', async () => {
    const connection = await connected();
    const { controller, transport, deliver, hostReceive } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['tasks-v1']);
    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      expect(request).toMatchObject({
        type: 'tasks.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        sessionToken: 'T'.repeat(43),
        operation: 'capabilities',
        payload: {},
      });
      expect(JSON.stringify(envelope)).not.toContain('T'.repeat(43));
      await deliver('3', 3, {
        type: 'tasks.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        operationId: request.operationId,
        ok: true,
        result: {
          adapters: [{
            adapterId: 'codex',
            label: 'Codex',
            availability: 'available',
            features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
          }],
          limits: { maxPromptBytes: 4096, maxConcurrentTasks: 4 },
        },
      });
    };
    const result = await controller.sendTask('capabilities', {});
    expect(result).toMatchObject({
      ok: true,
      result: { adapters: [{ adapterId: 'codex', availability: 'available' }] },
    });
    expect(controller.status().busy).toBe(false);
    expect(transport.acks).toEqual(['1', '2', '3']);
  });

  test('sends conversations-v1 inside E2EE and correlates its semantic response', async () => {
    const connection = await connected();
    const { controller, transport, deliver, hostReceive } = connection;
    await deliver('1', 1, ready);
    await controller.refresh();
    await advertiseFeatures(connection, ['conversations-v1']);
    transport.onSend = async envelope => {
      if (envelope.sequence !== 3) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as Record<string, unknown>;
      expect(request).toMatchObject({
        type: 'conversations.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        sessionToken: 'T'.repeat(43),
        operation: 'capabilities',
        payload: {},
      });
      expect(JSON.stringify(envelope)).not.toContain('T'.repeat(43));
      await deliver('3', 3, {
        type: 'conversations.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        operationId: request.operationId,
        operation: 'capabilities',
        ok: true,
        result: {
          adapters: [{
            adapterId: 'codex',
            label: 'Codex',
            availability: 'available',
            features: { continue: true, steer: true, interrupt: true, archive: true },
          }],
          limits: { maxPromptBytes: 4096 },
        },
      });
    };
    const result = await controller.sendConversation('capabilities', {});
    expect(result).toMatchObject({
      ok: true,
      operation: 'capabilities',
      result: { adapters: [{ adapterId: 'codex', availability: 'available' }] },
    });
    expect(controller.status().busy).toBe(false);
    expect(transport.acks).toEqual(['1', '2', '3']);
  });

  test('an unanswered request reports a timeout instead of a green success notice', async () => {
    const { controller, transport, deliver, setClock } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();

    // The Mac is asleep: the relay stores the envelope and nobody consumes it.
    // Resolving here printed "요청을 완료했습니다" for work that never ran.
    // Waiting out the full budget is the point: the host answers only after it
    // has finished the work, so a single receive proves nothing. The old copy
    // ("연결 상태를 확인한 뒤 다시 시도하세요") must not come back — it invited a
    // retry that ran the action a second time.
    let unanswered: Error | null = null;
    try {
      await controller.sendAction('git.commit', 'C'.repeat(43), undefined, 'ok');
    } catch (error) {
      unanswered = error as Error;
    }
    expect(unanswered?.message).toContain('요청은 전달되었고');
    expect(unanswered?.message).not.toContain('다시 시도하세요');
    expect(controller.status().busy).toBe(true);

    // Once the envelope can no longer be delivered, stop holding the lock.
    setClock(now + 11 * 60_000 + 1_000);
    const after = await controller.refresh();
    expect(after.busy).toBe(false);
    expect(after.error).toMatch(/응답하지 않아 요청을 취소했습니다/);
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  test('keeps the original pending-action timeout across controller reloads', async () => {
    const { controller, transport, deliver } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();
    await expect(controller.sendAction('git.commit', 'C'.repeat(43), undefined, 'ok'))
      .rejects.toThrow(/요청은 전달되었고/);
    const snapshot = controller.snapshot();
    expect(snapshot?.pendingActionSentAt).toBe(now);

    let resumedNow = now + 10 * 60_000;
    const resumed = new RemoteControlRelayController({
      transport,
      restoredSession: snapshot,
      controllerName: '내 iPhone',
      now: () => resumedNow,
      sleep: async () => {},
    });
    expect(resumed.status().busy).toBe(true);
    resumedNow = now + 11 * 60_000 + 1;
    await resumed.refresh();
    expect(resumed.status()).toMatchObject({
      busy: false,
      error: expect.stringContaining('응답하지 않아 요청을 취소했습니다'),
    });
  });

  test('a pairing-time refusal is terminal, not a spinner that says the Mac approved', async () => {
    const { controller, deliver } = await connected();
    // CLAUDE.md promises a version-skewed Mac fails loudly at pairing. Because
    // refresh() blanked #error at the top of every poll, the real reason
    // flashed for one second and left a permanent "Mac이 승인했습니다" spinner.
    await deliver('1', 1, {
      type: 'error',
      code: 'PROTOCOL_MISMATCH',
      message: '지원하지 않는 원격 제어 버전입니다.',
    });
    await controller.refresh();
    expect(controller.status().state).toBe('closed');
    expect(controller.status().error).toBe('지원하지 않는 원격 제어 버전입니다.');

    const later = await controller.refresh();
    expect(later.state).toBe('closed');
    expect(later.error).toBe('지원하지 않는 원격 제어 버전입니다.');
  });

  test('an authenticated session.ready repairs a sender gap after the earlier restart notice expired', async () => {
    const { controller, transport, deliver } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();
    expect(controller.status().state).toBe('online');

    // Host sender sequence 2 was the proactive session.ready emitted after a
    // Mac restart. The phone slept longer than the ten-minute relay TTL, so the
    // relay no longer returns it. A request made with the now-dead core token
    // causes the Mac to mint a fresh sequence-3 checkpoint instead.
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      await deliver('3', 3, {
        ...ready,
        sessionToken: 'U'.repeat(43),
        projects: [],
        projectCount: 0,
      });
    };

    await expect(controller.sendAction('start', 'C'.repeat(43))).rejects.toThrow(
      'Mac이 다시 시작되어 연결을 복구했습니다.',
    );
    expect(controller.status()).toMatchObject({
      state: 'online',
      busy: false,
      projects: [],
    });
    expect(controller.status().error).not.toContain('다시 실행');
    expect(controller.snapshot()).toMatchObject({
      relayCursor: '3',
      sessionToken: 'U'.repeat(43),
      receiveCursor: { highestSequence: 3 },
    });
    expect(transport.acks).toEqual(['1', '3']);
  });

  test('a sender gap carrying an ordinary action result remains fail-closed', async () => {
    const { controller, transport, deliver } = await connected();
    await deliver('1', 1, ready);
    await controller.refresh();

    await deliver('3', 3, {
      type: 'action.result',
      actionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ok: true,
      projects: [],
      page: 0,
      projectCount: 0,
      nextPage: null,
    });
    await expect(controller.refresh()).rejects.toThrow('REMOTE_CONTROL_RELAY_SEQUENCE_GAP');
    expect(controller.snapshot()).toMatchObject({
      relayCursor: '1',
      receiveCursor: { highestSequence: 1 },
    });
    expect(transport.acks).toEqual(['1']);
  });
});

describe('several Macs remembered side by side', () => {
  const readyMessage = {
    type: 'session.ready',
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken: 'T'.repeat(43),
    hostName: '내 Mac',
    expiresAt,
    idleExpiresAt: '2099-08-30T12:10:00.000Z',
    projects: [],
    projectCount: 0,
    nextPage: null,
  };

  async function onlineController() {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const transport = new FakeControllerTransport(
      hostPublicKey,
      await fingerprintRemoteControlRelayPublicKey(hostPublicKey),
    );
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId,
        pairingId,
        pairingSecret,
        hostPublicKey,
        expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone',
      now: () => now,
    });
    await controller.initialize();
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: await importRemoteControlRelayPublicKey(transport.controllerPublicKey),
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    transport.approvalState = 'approved';
    transport.onSend = async envelope => {
      if (envelope.sequence !== 1 || transport.deliveries.length > 0) return;
      transport.deliveries.push({
        relaySequence: '1',
        envelope: await encryptRemoteControlRelayEnvelope({
          key: hostSend,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: '99999999-9999-4999-8999-999999999999',
            sessionId,
            controllerId,
            sequence: 1,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify(readyMessage)),
          now,
        }),
      });
    };
    await controller.refresh();
    expect(controller.status().state).toBe('online');
    return { controller, transport };
  }

  test('polls the Mac on screen every second and the rest only occasionally', async () => {
    // One Mac cost one poll per second. Keeping that cadence for every
    // remembered Mac multiplies the phone's battery and relay traffic by N for
    // hosts nobody is looking at.
    const manager = new RemoteControlRelayControllerManager();
    const visible = await onlineController();
    const background = await onlineController();
    manager.adopt('mac-visible-000001', visible.controller);
    manager.adopt('mac-background-01', background.controller);
    const polls = new Map<string, number>();
    for (let tick = now; tick <= now + 60_000; tick += REMOTE_CONTROL_SELECTED_HOST_POLL_MS) {
      for (const dueHostId of manager.dueForRefresh(tick, 'mac-visible-000001')) {
        polls.set(dueHostId, (polls.get(dueHostId) ?? 0) + 1);
        manager.markRefreshed(dueHostId, tick);
      }
    }
    expect(polls.get('mac-visible-000001')).toBe(61);
    expect(polls.get('mac-background-01')).toBe(1 + 60_000 / REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS);
  });

  test('switching the visible Mac leaves the other Mac approved and untouched', async () => {
    // Each chip owns a 30-day session. Tearing one down to look at another
    // would make the phone re-pair every time it switched.
    const manager = new RemoteControlRelayControllerManager();
    const first = await onlineController();
    const second = await onlineController();
    manager.adopt('mac-first-0000001', first.controller);
    manager.adopt('mac-second-000001', second.controller);
    const firstSnapshot = first.controller.snapshot();

    let selected = 'mac-second-000001';
    for (let tick = now; tick <= now + 10_000; tick += REMOTE_CONTROL_SELECTED_HOST_POLL_MS) {
      for (const dueHostId of manager.dueForRefresh(tick, selected)) {
        await manager.controller(dueHostId)?.refresh();
        manager.markRefreshed(dueHostId, tick);
      }
    }
    expect(second.transport.statusCalls).toBeGreaterThan(first.transport.statusCalls);
    expect(first.controller.status()).toMatchObject({ state: 'online', hostName: '내 Mac' });
    expect(first.controller.snapshot()).toEqual(firstSnapshot);

    selected = 'mac-first-0000001';
    for (const dueHostId of manager.dueForRefresh(now + 11_000, selected)) {
      await manager.controller(dueHostId)?.refresh();
      manager.markRefreshed(dueHostId, now + 11_000);
    }
    expect(first.controller.status().state).toBe('online');
    expect(second.controller.status().state).toBe('online');
  });

  test('forgetting one Mac leaves the others in the switcher', async () => {
    const manager = new RemoteControlRelayControllerManager();
    const kept = await onlineController();
    const removed = await onlineController();
    manager.adopt('mac-kept-00000001', kept.controller);
    manager.adopt('mac-removed-00001', removed.controller);
    expect(manager.forget('mac-removed-00001')).toBe(removed.controller);
    expect(manager.hostIds()).toEqual(['mac-kept-00000001']);
    expect(manager.controller('mac-removed-00001')).toBeNull();
    expect(manager.statuses()).toMatchObject([{ hostId: 'mac-kept-00000001', status: { state: 'online' } }]);
    expect(kept.controller.status().state).toBe('online');
  });
});

/**
 * The Mac cannot answer inside the controller's own send call: it polls the
 * relay once a second and runs `perform()` to completion before queueing the
 * reply. A single receive straight after sending therefore finds nothing, and
 * reading that as "Mac이 응답하지 않습니다" turned a healthy remote into a red
 * error on every button — while the action ran anyway. Retrying was the harm:
 * the core is idempotent per `actionId` and a retry mints a new one.
 */
describe('an action waits for the Mac to finish', () => {
  async function onlineController(sleeps: number[]) {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const hostFingerprint = await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
    const pairingUrl = buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
      hostId,
      pairingId,
      pairingSecret,
      hostPublicKey,
      expiresAt: pairingExpiresAt,
    });
    const transport = new FakeControllerTransport(hostPublicKey, hostFingerprint);
    const controller = new RemoteControlRelayController({
      transport,
      pairingUrl,
      controllerName: '내 iPhone',
      now: () => now,
      randomUuid: uuidSequence(),
      sleep: async ms => { sleeps.push(ms); },
    });
    await controller.initialize();
    const controllerPublic = await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
    const hostReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    const hostSend = await deriveRemoteControlRelaySessionKey({
      privateKey: hostKeys.privateKey,
      peerPublicKey: controllerPublic,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    transport.approvalState = 'approved';
    await controller.refresh();
    transport.deliveries = [{
      relaySequence: '1',
      envelope: await encryptRemoteControlRelayEnvelope({
        key: hostSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId: '99999999-9999-4999-8999-999999999999',
          sessionId,
          controllerId,
          sequence: 1,
          expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify({
          type: 'session.ready',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: 'T'.repeat(43),
          hostName: '내 Mac',
          expiresAt,
          idleExpiresAt: '2099-08-30T12:10:00.000Z',
          projects: [{
            controlId: 'C'.repeat(43),
            name: '테스트 프로젝트',
            port: 4317,
            kind: 'main',
            status: 'stopped',
            actions: ['start'],
          }],
          projectCount: 1,
          nextPage: null,
        })),
        now,
      }),
    }];
    await controller.refresh();
    expect(controller.status().state).toBe('online');
    return { controller, transport, hostReceive, hostSend };
  }

  test('a reply that lands two polls later is a success, not a lost Mac', async () => {
    const sleeps: number[] = [];
    const { controller, transport, hostReceive, hostSend } = await onlineController(sleeps);
    let polls = 0;
    transport.onSend = async envelope => {
      if (envelope.sequence !== 2) return;
      const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: hostReceive,
        envelope,
        now,
      }))) as { actionId: string };
      transport.pollHook = async () => {
        polls += 1;
        if (polls < 3) return;
        transport.pollHook = null;
        transport.deliveries.push({
          relaySequence: '2',
          envelope: await encryptRemoteControlRelayEnvelope({
            key: hostSend,
            metadata: {
              schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
              messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              sessionId,
              controllerId,
              sequence: 2,
              expiresAt: pairingExpiresAt,
            },
            plaintext: encoder.encode(JSON.stringify({
              type: 'action.result',
              actionId: request.actionId,
              ok: true,
              project: {
                controlId: 'C'.repeat(43),
                name: '테스트 프로젝트',
                port: 4317,
                kind: 'main',
                status: 'running',
                actions: ['stop', 'restart'],
              },
            })),
            now,
          }),
        });
      };
    };
    await controller.sendAction('start', 'C'.repeat(43));
    expect(controller.status().projects[0]?.status).toBe('running');
    expect(controller.status().busy).toBe(false);
    expect(sleeps).toEqual([
      REMOTE_CONTROL_ACTION_RESULT_POLL_MS,
      REMOTE_CONTROL_ACTION_RESULT_POLL_MS,
    ]);
    expect(transport.sent.filter(envelope => envelope.sequence === 2)).toHaveLength(1);
  });

  test('projectCreate_createdOutsideFirstPage_selectsExactProject', async () => {
    const {controller,transport,hostReceive,hostSend}=await onlineController([]);
    const project={controlId:'N'.repeat(43),name:'새 프로젝트',port:null,kind:'main',status:'unknown',actions:['folder.open']};
    transport.onSend=async envelope=>{
      const request=JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({key:hostReceive,envelope,now})));
      expect(request.action).toBe('project.create');
      expect(request.actionId).toBe('durable-create-intent-1');
      transport.deliveries.push({relaySequence:'2',envelope:await encryptRemoteControlRelayEnvelope({key:hostSend,
        metadata:{schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,messageId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionId,controllerId,sequence:2,expiresAt:pairingExpiresAt},
        plaintext:encoder.encode(JSON.stringify({type:'action.result',actionId:request.actionId,ok:true,project})),now})});
    };
    const result=await controller.sendAction('project.create',undefined,undefined,'새 프로젝트','R'.repeat(43),'durable-create-intent-1');
    expect(controller.projectCreationIdentity()).toEqual({hostId,controllerId});
    expect(result).toMatchObject({ok:true,project});
    expect(controller.status().projects.find(p=>p.controlId===project.controlId)).toMatchObject(project);
    expect(controller.status().projects.filter(p=>p.controlId===project.controlId)).toHaveLength(1);
  });

  test('a Mac the relay says has been silent is refused at once, not after the full budget', async () => {
    const sleeps: number[] = [];
    const { controller, transport } = await onlineController(sleeps);
    // The relay stamps the host row on every poll, so a long gap is evidence.
    transport.hostLastSeenAt = new Date(now - REMOTE_CONTROL_HOST_SILENT_MS - 1_000).toISOString();
    await controller.refresh();
    const sentBefore = transport.sent.length;
    await expect(controller.sendAction('start', 'C'.repeat(43))).rejects.toThrow(/절전 상태이거나/);
    // Nothing was sent and nothing was waited on: the whole point is that the
    // phone answers immediately instead of spinning for a minute.
    expect(transport.sent).toHaveLength(sentBefore);
    expect(sleeps).toHaveLength(0);
    // The lock must not be left held by a request that never went out.
    expect(controller.status().busy).toBe(false);
    expect(controller.status().hostLastSeenAt).toBe(transport.hostLastSeenAt);
  });

  test('an unknown or recent last-seen never blocks a Mac that is answering', async () => {
    for (const hostLastSeenAt of [null, new Date(now - 5_000).toISOString()]) {
      const sleeps: number[] = [];
      const { controller, transport, hostReceive, hostSend } = await onlineController(sleeps);
      transport.hostLastSeenAt = hostLastSeenAt;
      await controller.refresh();
      transport.onSend = async envelope => {
        const request = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
          key: hostReceive, envelope, now,
        }))) as { actionId: string };
        transport.deliveries.push({
          relaySequence: String(transport.deliveries.length + 1),
          envelope: await encryptRemoteControlRelayEnvelope({
            key: hostSend,
            metadata: {
              schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
              messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              sessionId,
              controllerId,
              sequence: 2,
              expiresAt: pairingExpiresAt,
            },
            plaintext: encoder.encode(JSON.stringify({
              type: 'action.result', actionId: request.actionId, ok: true, project: null,
            })),
            now,
          }),
        });
      };
      await controller.sendAction('start', 'C'.repeat(43));
      expect(controller.status().busy).toBe(false);
    }
  });

  test('a Mac that never answers is reported as delivered, never as "try again"', async () => {
    const sleeps: number[] = [];
    const { controller } = await onlineController(sleeps);
    let failure: Error | null = null;
    try {
      await controller.sendAction('start', 'C'.repeat(43));
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('요청은 전달되었고');
    // Telling the user to retry is what produced a second commit and a second
    // worktree for one tap.
    expect(failure!.message).not.toContain('다시 시도하세요');
    expect(sleeps).toHaveLength(REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS);
    // The unanswered action keeps holding the lock, which is deliberate: the
    // envelope may still be delivered, so a second tap must not mint a second
    // actionId. It is released when the envelope can no longer arrive.
    expect(controller.status().busy).toBe(true);
  });
});
