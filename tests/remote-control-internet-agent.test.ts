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
  encodeRemoteControlRelayBase64Url,
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
import { remoteControlRelaySasCode } from '../src/remoteControlRelaySas';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import { AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION } from '../src/agentRuntimeConversationProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from '../src/remoteControlTaskProtocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = Date.parse('2099-08-30T12:00:00.000Z');
const hostExpiresAt = '2099-09-02T12:00:00.000Z';
const pairingExpiresAt = '2099-08-31T12:00:00.000Z';
const sessionExpiresAt = '2099-08-31T12:00:00.000Z';
const sessionId = '22222222-2222-4222-8222-222222222222';
const controllerId = '33333333-3333-4333-8333-333333333333';

class FakeTransport implements RemoteControlInternetHostTransport {
  registration: RemoteControlInternetHostRegistration | null = null;
  pairingRegistration: RemoteControlInternetPairingRegistration | null = null;
  sessions: RemoteControlInternetSessionRow[] = [];
  deliveries: RemoteControlInternetReceivedEnvelope[] = [];
  sent: Array<{ type: RemoteControlInternetRelayMessageType; envelope: RemoteControlRelayEnvelope }> = [];
  acknowledgements: string[] = [];
  failNextSend = false;
  failRevoke = false;
  failDisable = false;
  listSessionCalls = 0;
  disableCalls = 0;
  revokeCalls: string[] = [];

  async registerHost(input: RemoteControlInternetHostRegistration) {
    this.registration = input;
    return {
      expiresAt: hostExpiresAt,
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(input.hostPublicKey),
    };
  }
  pairingCount = 0;
  issuedPairingIds: string[] = [];
  async createPairing(input: RemoteControlInternetPairingRegistration) {
    this.pairingRegistration = input;
    // The relay inserts a fresh pairing row per call; a fixed id would hide the
    // whole point of issuing a second QR.
    this.pairingCount += 1;
    const pairingId = `${this.pairingCount.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    const activePairingIds = new Set(this.sessions
      .filter(session => session.approvalState === 'pending' || session.approvalState === 'approved')
      .map(session => session.pairingId));
    const unclaimed = this.issuedPairingIds.filter(id => !activePairingIds.has(id));
    const retiredPairingIds = unclaimed.length >= 8
      ? unclaimed.slice(0, unclaimed.length - 7)
      : [];
    const retired = new Set(retiredPairingIds);
    this.issuedPairingIds = this.issuedPairingIds.filter(id => !retired.has(id));
    this.issuedPairingIds.push(pairingId);
    return {
      pairingId,
      expiresAt: pairingExpiresAt,
      hostPublicKey: this.registration!.hostPublicKey,
      hostPublicKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(this.registration!.hostPublicKey),
      retiredPairingIds,
    };
  }
  async listSessions() {
    this.listSessionCalls += 1;
    return this.sessions.map(row => ({ ...row }));
  }
  async approveSession(_hostId: string, _hostSecret: string, id: string) {
    const row = this.sessions.find(candidate => candidate.sessionId === id)!;
    const approved = { ...row, approvalState: 'approved' as const, approvedAt: new Date(now).toISOString() };
    this.sessions = this.sessions.map(candidate => candidate.sessionId === id ? approved : candidate);
    return approved;
  }
  async revokeSession(_hostId?: string, _hostSecret?: string, id?: string) {
    if (id) this.revokeCalls.push(id);
    if (this.failRevoke) throw new Error('simulated relay revoke failure');
    if (id) {
      const revokedAt = new Date(now).toISOString();
      this.sessions = this.sessions.map(row => row.sessionId === id
        ? { ...row, approvalState: 'revoked' as const, revokedAt }
        : row);
    }
  }
  async disableHost() {
    this.disableCalls += 1;
    if (this.failDisable) throw new Error('simulated relay disable failure');
  }
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
    if (this.failNextSend) {
      this.failNextSend = false;
      // The relay committed the exact ciphertext, but its HTTP response was
      // lost. A retry must reuse this envelope byte-for-byte.
      this.sent.push({ type, envelope });
      throw new Error('simulated relay response loss');
    }
    this.sent.push({ type, envelope });
  }
  async acknowledge(_hostId: string, _hostSecret: string, _sessionId: string, through: string) {
    this.acknowledgements.push(through);
  }
}

function uuidSequence() {
  const values = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  return () => values.shift() ?? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
}

describe('outbound-only Internet QR host agent', () => {
  test('requires Mac SAS approval, retries exactly, and keeps individual revoke local-first', async () => {
    const transport = new FakeTransport();
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
    const executions: string[] = [];
    const taskCalls: Array<{ request: unknown; bindings: unknown }> = [];
    const conversationCalls: Array<{ request: unknown; bindings: unknown }> = [];
    const gateway: RemoteControlGateway = {
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
    const agent = new RemoteControlInternetAgent({
      gateway,
      transport,
      taskGateway: {
        perform: async (request, bindings) => {
          taskCalls.push({ request, bindings });
          return {
            type: 'tasks.result',
            protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
            taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
            operationId: (request as { operationId: string }).operationId,
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
          };
        },
      },
      conversationGateway: {
        perform: async (request, bindings) => {
          conversationCalls.push({ request, bindings });
          const typedRequest = request as { operationId: string; operation: 'capabilities' };
          return {
            type: 'conversations.result',
            protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
            conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
            operationId: typedRequest.operationId,
            operation: typedRequest.operation,
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
          };
        },
      },
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'H'.repeat(43),
      onRecordChanged: () => undefined,
      autoPoll: false,
    });
    const pairing = await agent.initialize();
    const parsed = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);
    expect(parsed.controllerUrl).toBe('https://controller.example.test/remote/');
    expect(new URL(pairing.pairingUrl).search).toBe('');
    expect(new URL(pairing.pairingUrl).pathname).toBe('/remote/');
    expect(transport.pairingRegistration?.pairingSecretHash).toMatch(/^[0-9a-f]{64}$/);
    // 30일 QR을 마지막 날 claim 하고 하루 승인 대기 후 30일 세션까지 버텨야 한다.
    expect(transport.registration?.ttlSeconds).toBe(62 * 24 * 60 * 60);
    expect(agent.status().state).toBe('pairing');

    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    const pending: RemoteControlInternetSessionRow = {
      sessionId,
      pairingId: parsed.bootstrap.pairingId,
      controllerId,
      controllerName: '내 iPhone',
      controllerPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    };
    transport.sessions = [pending];
    await agent.pollNow();
    const pendingStatus = agent.status();
    expect(pendingStatus.state).toBe('approval-required');
    expect(pendingStatus.sessions[0]?.sasCode).toMatch(/^\d{6}$/);
    await expect(agent.approveSession(sessionId, '000000')).rejects.toMatchObject({ code: 'SAS_MISMATCH' });
    const approvedStatus = await agent.approveSession(
      sessionId,
      pendingStatus.sessions[0]!.sasCode!,
      true,
      true,
    );
    expect(approvedStatus.state).toBe('online');
    // SAS is an approval proof, not durable session metadata. Once approved it
    // must disappear from every status response.
    expect(approvedStatus.sessions[0]).toMatchObject({
      approvalState: 'approved',
      sasCode: null,
      taskScopeGranted: true,
      conversationScopeGranted: true,
    });
    const reducedScopeStatus = await agent.updateSessionScopes(sessionId, false, true);
    expect(reducedScopeStatus.sessions[0]).toMatchObject({
      approvalState: 'approved',
      taskScopeGranted: false,
      conversationScopeGranted: true,
    });
    const restoredScopeStatus = await agent.updateSessionScopes(sessionId, true, true);
    expect(restoredScopeStatus.sessions[0]).toMatchObject({
      approvalState: 'approved',
      taskScopeGranted: true,
      conversationScopeGranted: true,
    });
    await expect(agent.updateSessionScopes(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      true,
      true,
    )).rejects.toMatchObject({ code: 'SESSION_NOT_APPROVED' });

    const importedHost = await importRemoteControlRelayPublicKey(parsed.bootstrap.hostPublicKey);
    const controllerSend = await deriveRemoteControlRelaySessionKey({
      privateKey: controllerKeys.privateKey,
      peerPublicKey: importedHost,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['encrypt'],
    });
    const controllerReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: controllerKeys.privateKey,
      peerPublicKey: importedHost,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['decrypt'],
    });
    const pairEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '44444444-4444-4444-8444-444444444444',
        sessionId,
        controllerId,
        sequence: 1,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: parsed.bootstrap.pairingSecret,
      })),
      now,
    });
    transport.deliveries = [{ relaySequence: '1', envelope: pairEnvelope }];
    await agent.pollNow();
    expect(transport.acknowledgements).toEqual(['1']);
    const ready = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent[0]!.envelope,
      now,
    }))) as { type: string; sessionToken: string; projects: Array<{ controlId: string }> };
    expect(Object.keys(ready).sort()).toEqual([
      'expiresAt', 'hostName', 'idleExpiresAt', 'nextPage', 'projectCount',
      'projects', 'protocolVersion', 'sessionToken', 'type',
    ]);
    expect(ready.projects).toHaveLength(1);
    expect(JSON.stringify(transport.sent[0])).not.toContain('/Users/private/project');
    expect(JSON.stringify(transport.sent[0])).not.toContain('bun run secret');

    const actionEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '55555555-5555-4555-8555-555555555555',
        sessionId,
        controllerId,
        sequence: 2,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: ready.sessionToken,
        actionId: 'phone-action-1',
        action: 'start',
        controlId: ready.projects[0]!.controlId,
        remoteConfirmed: true,
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '2', envelope: actionEnvelope });
    transport.failNextSend = true;
    await expect(agent.pollNow()).rejects.toThrow('simulated relay response loss');
    expect(executions).toEqual(['phone-action-1']);
    expect(transport.acknowledgements).toEqual(['1']);
    const ambiguouslyCommitted = transport.sent.at(-1)!;

    await agent.pollNow();
    expect(executions).toEqual(['phone-action-1']);
    expect(transport.acknowledgements).toEqual(['1', '2']);
    expect(transport.sent.at(-1)).toEqual(ambiguouslyCommitted);
    const result = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as { type: string; ok: boolean };
    expect(result).toMatchObject({ type: 'action.result', ok: true });

    const taskEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '66666666-6666-4666-8666-666666666666',
        sessionId,
        controllerId,
        sequence: 3,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'tasks.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        sessionToken: ready.sessionToken,
        operationId: 'task-operation-12345678',
        operation: 'capabilities',
        payload: {},
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '3', envelope: taskEnvelope });
    await agent.pollNow();
    const taskResult = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as Record<string, unknown>;
    expect(taskResult).toMatchObject({ type: 'session.ready' });
    expect(taskCalls).toHaveLength(0);
    const refreshedTaskToken = taskResult.sessionToken as string;
    const retriedTaskEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '77777777-7777-4777-8777-777777777777',
        sessionId,
        controllerId,
        sequence: 4,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'tasks.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        sessionToken: refreshedTaskToken,
        operationId: 'task-operation-87654321',
        operation: 'capabilities',
        payload: {},
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '4', envelope: retriedTaskEnvelope });
    await agent.pollNow();
    const retriedTaskResult = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as Record<string, unknown>;
    expect(retriedTaskResult).toMatchObject({
      type: 'tasks.result',
      operationId: 'task-operation-87654321',
      ok: true,
    });
    expect(transport.sent.at(-1)?.type).toBe('task');
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]?.bindings).toMatchObject([{
      controlId: (taskResult.projects as Array<{ controlId: string }>)[0]!.controlId,
      target: { internalId: 'private-project-id' },
    }]);
    expect(JSON.stringify(taskResult)).not.toContain(ready.sessionToken);

    const conversationEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '88888888-8888-4888-8888-888888888888',
        sessionId,
        controllerId,
        sequence: 5,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'conversations.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        sessionToken: refreshedTaskToken,
        operationId: 'conversation-operation-12345678',
        operation: 'capabilities',
        payload: {},
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '5', envelope: conversationEnvelope });
    await agent.pollNow();
    const conversationResult = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as Record<string, unknown>;
    expect(conversationResult).toMatchObject({
      type: 'conversations.result',
      operation: 'capabilities',
      operationId: 'conversation-operation-12345678',
      ok: true,
    });
    expect(transport.sent.at(-1)?.type).toBe('conversation');
    expect(conversationCalls).toHaveLength(1);

    // Capability discovery is a separate encrypted base read action so the
    // frozen session.ready remains readable by legacy controllers. Production
    // managed tasks stay fail-closed even when a task gateway was injected;
    // the installed read-only conversation gateway is advertised.
    const capabilityEnvelope = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '99999998-9999-4999-8999-999999999998',
        sessionId,
        controllerId,
        sequence: 6,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: refreshedTaskToken,
        actionId: 'protocol-capability-probe-1',
        action: 'protocol.capabilities',
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '6', envelope: capabilityEnvelope });
    await agent.pollNow();
    const capabilityResult = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as Record<string, unknown>;
    expect(capabilityResult).toEqual({
      type: 'action.result',
      actionId: 'protocol-capability-probe-1',
      ok: true,
      supportedFeatures: ['conversations-v1'],
    });
    expect(transport.sent.at(-1)?.type).toBe('result');

    const sentBeforeRevoke = transport.sent.length;
    transport.failRevoke = true;
    await expect(agent.revokeSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_REVOKE_PENDING',
    });
    const locallyRevoked = agent.status();
    expect(locallyRevoked.sessions[0]).toMatchObject({
      sessionId,
      approvalState: 'revoked',
      sasCode: null,
    });
    expect(locallyRevoked.state).not.toBe('online');

    // The failed relay revoke leaves its stale approved row visible, but a
    // later poll must not recreate session crypto or execute queued commands.
    const postRevokeAction = await encryptRemoteControlRelayEnvelope({
      key: controllerSend,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: '99999999-9999-4999-8999-999999999999',
        sessionId,
        controllerId,
        sequence: 7,
        expiresAt: pairingExpiresAt,
      },
      plaintext: encoder.encode(JSON.stringify({
        type: 'action.request',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: ready.sessionToken,
        actionId: 'phone-action-after-revoke',
        action: 'stop',
        controlId: ready.projects[0]!.controlId,
        remoteConfirmed: true,
      })),
      now,
    });
    transport.deliveries.push({ relaySequence: '7', envelope: postRevokeAction });
    await agent.pollNow();
    expect(executions).toEqual(['phone-action-1']);
    expect(agent.status().sessions[0]).toMatchObject({
      sessionId,
      approvalState: 'revoked',
      sasCode: null,
    });
    expect(transport.sent).toHaveLength(sentBeforeRevoke);
    expect(transport.acknowledgements).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  test('persists a failed local revoke and never revives the approved controller after restart', async () => {
    const transport = new FakeTransport();
    let stored: RemoteControlHostRecord | null = null;
    const gateway: RemoteControlGateway = {
      listRegisteredProjects: () => [],
      executeRegisteredProjectAction: async () => undefined,
    };
    const first = new RemoteControlInternetAgent({
      gateway,
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '재시작 차단 테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'R'.repeat(43),
      autoPoll: false,
      onRecordChanged: next => { stored = next; },
    });
    const pairing = parseRemoteControlRelayPairingUrl((await first.initialize()).pairingUrl);
    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    transport.sessions = [{
      sessionId,
      pairingId: pairing.bootstrap.pairingId,
      controllerId,
      controllerName: '해제한 iPhone',
      controllerPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await first.pollNow();
    await first.approveSession(sessionId, first.status().sessions[0]!.sasCode!);

    transport.failRevoke = true;
    await expect(first.revokeSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_REVOKE_PENDING',
    });
    const afterFailure = stored as RemoteControlHostRecord | null;
    expect(afterFailure?.revokedSessions).toEqual([{
      sessionId,
      revokedAt: new Date(now).toISOString(),
    }]);

    // The relay still says approved, exactly as it would after a transport
    // outage. A new process must treat the durable local tombstone as stronger
    // evidence and must not emit a replacement session.ready.
    expect(transport.sessions[0]?.approvalState).toBe('approved');
    const restored = new RemoteControlInternetAgent({
      gateway,
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: 'ignored',
      now: () => now,
      restore: afterFailure!,
      autoPoll: false,
      onRecordChanged: next => { stored = next; },
    });
    await restored.restore();
    expect(restored.status().sessions[0]).toMatchObject({
      sessionId,
      approvalState: 'revoked',
      sasCode: null,
    });
    const sentBeforeRetry = transport.sent.length;
    await restored.pollNow();
    expect(transport.sent).toHaveLength(sentBeforeRetry);
    expect((stored as RemoteControlHostRecord | null)?.revokedSessions).toHaveLength(1);

    // Once the relay confirms cleanup, the durable retry marker can disappear.
    transport.failRevoke = false;
    await restored.pollNow();
    expect(transport.sessions[0]?.approvalState).toBe('revoked');
    expect((stored as RemoteControlHostRecord | null)?.revokedSessions).toEqual([]);
    expect(restored.status().sessions[0]?.approvalState).toBe('revoked');
  });

  test('fails closed and still attempts relay cleanup when both durable revoke writes fail', async () => {
    const transport = new FakeTransport();
    let failPersistence = false;
    let stored: RemoteControlHostRecord | null = null;
    const agent = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: async () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '저장 실패 테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'W'.repeat(43),
      autoPoll: false,
      onRecordChanged: next => {
        if (failPersistence) throw new Error('simulated vault and tombstone failure');
        stored = next;
      },
    });
    const pairing = parseRemoteControlRelayPairingUrl((await agent.initialize()).pairingUrl);
    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    transport.sessions = [{
      sessionId,
      pairingId: pairing.bootstrap.pairingId,
      controllerId,
      controllerName: '차단할 iPhone',
      controllerPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await agent.pollNow();
    expect(stored).not.toBeNull();

    failPersistence = true;
    await expect(agent.approveSession(
      sessionId,
      agent.status().sessions[0]!.sasCode!,
      true,
    )).rejects.toMatchObject({ code: 'TASK_SCOPE_PERSIST_FAILED' });
    expect(transport.sessions[0]?.approvalState).toBe('pending');
    expect(agent.status().sessions[0]?.taskScopeGranted).toBe(false);
    await expect(agent.approveSession(
      sessionId,
      agent.status().sessions[0]!.sasCode!,
      false,
      true,
    )).rejects.toMatchObject({ code: 'CONVERSATION_SCOPE_PERSIST_FAILED' });
    expect(transport.sessions[0]?.approvalState).toBe('pending');
    expect(agent.status().sessions[0]?.conversationScopeGranted).toBe(false);
    failPersistence = false;
    await agent.approveSession(sessionId, agent.status().sessions[0]!.sasCode!, false, false);
    failPersistence = true;
    await expect(agent.updateSessionScopes(sessionId, true, false)).rejects.toMatchObject({
      code: 'RUNTIME_SCOPE_PERSIST_FAILED',
    });
    expect(agent.status().sessions[0]).toMatchObject({
      approvalState: 'approved',
      taskScopeGranted: false,
      conversationScopeGranted: false,
    });
    transport.failRevoke = true;
    await expect(agent.revokeSession(sessionId)).rejects.toMatchObject({
      code: 'LOCAL_REVOCATION_PERSIST_FAILED',
    });
    expect(transport.revokeCalls).toContain(sessionId);
    expect(agent.status()).toMatchObject({ enabled: false, state: 'disabled', sessions: [] });
  });

  test('disconnects a controller when a runtime permission reduction cannot be persisted', async () => {
    const transport = new FakeTransport();
    let failNextWrite = false;
    const storedRecords: RemoteControlHostRecord[] = [];
    const agent = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: async () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '권한 축소 테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'Y'.repeat(43),
      autoPoll: false,
      onRecordChanged: next => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('simulated one-shot scope write failure');
        }
        if (next) storedRecords.push(next);
      },
    });
    const pairing = parseRemoteControlRelayPairingUrl((await agent.initialize()).pairingUrl);
    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    transport.sessions = [{
      sessionId,
      pairingId: pairing.bootstrap.pairingId,
      controllerId,
      controllerName: '권한 축소 iPhone',
      controllerPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await agent.pollNow();
    await agent.approveSession(sessionId, agent.status().sessions[0]!.sasCode!, true, true);

    failNextWrite = true;
    await expect(agent.updateSessionScopes(sessionId, false, true)).rejects.toMatchObject({
      code: 'RUNTIME_SCOPE_REDUCTION_DISCONNECTED',
    });
    expect(transport.revokeCalls).toContain(sessionId);
    expect(agent.status().sessions[0]).toMatchObject({ approvalState: 'revoked' });
    expect(agent.status().state).not.toBe('online');
    expect(storedRecords.at(-1)?.sessions[0]?.scopes ?? []).toEqual([]);
  });

  test('erases local authority at host TTL and before a failed full-disable relay call', async () => {
    const gateway: RemoteControlGateway = {
      listRegisteredProjects: () => [],
      executeRegisteredProjectAction: async () => undefined,
    };
    let clock = now;
    const expiredTransport = new FakeTransport();
    const expiredAgent = new RemoteControlInternetAgent({
      gateway,
      transport: expiredTransport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '만료 테스트 Mac',
      now: () => clock,
      randomUuid: uuidSequence(),
      randomSecret: () => 'T'.repeat(43),
      autoPoll: false,
    });
    await expiredAgent.initialize();
    clock = Date.parse(hostExpiresAt);
    expect(expiredAgent.status()).toMatchObject({
      enabled: false,
      state: 'disabled',
      hostExpiresAt: null,
      pairingExpiresAt: null,
      sessions: [],
    });
    await expiredAgent.pollNow();
    expect(expiredTransport.listSessionCalls).toBe(0);
    await expect(expiredAgent.approveSession(sessionId, '000000')).rejects.toMatchObject({
      code: 'INTERNET_REMOTE_DISABLED',
    });

    const failedDisableTransport = new FakeTransport();
    const failedDisableAgent = new RemoteControlInternetAgent({
      gateway,
      transport: failedDisableTransport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '종료 테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'D'.repeat(43),
      autoPoll: false,
    });
    await failedDisableAgent.initialize();
    failedDisableTransport.failDisable = true;
    await expect(failedDisableAgent.disable()).rejects.toThrow('simulated relay disable failure');
    expect(failedDisableAgent.status()).toMatchObject({ enabled: false, state: 'disabled', sessions: [] });
    await failedDisableAgent.pollNow();
    expect(failedDisableTransport.listSessionCalls).toBe(0);
    expect(failedDisableTransport.disableCalls).toBe(1);
  });
  test('runs two phones at once and revokes them one at a time', async () => {
    // A Mac used to hold a single core session, so the second phone to pair
    // over the relay got SESSION_ACTIVE and could never act. Revoking also
    // called closeSession() with no token, which closed EVERY device.
    const transport = new FakeTransport();
    const executions: string[] = [];
    const gateway: RemoteControlGateway = {
      listRegisteredProjects: () => [{
        internalId: 'private-project-id',
        name: '내 프로젝트',
        port: null,
        kind: 'main' as const,
        folderPath: '/Users/private/project',
        command: null,
        status: 'unknown' as const,
        actions: ['folder.open' as const],
      }],
      executeRegisteredProjectAction: async request => { executions.push(request.actionId); },
    };
    const agent = new RemoteControlInternetAgent({
      gateway,
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'H'.repeat(43),
      autoPoll: false,
    });
    const pairing = await agent.initialize();
    const parsed = parseRemoteControlRelayPairingUrl(pairing.pairingUrl);
    const importedHost = await importRemoteControlRelayPublicKey(parsed.bootstrap.hostPublicKey);

    const phones = [
      { sessionId: '22222222-2222-4222-8222-222222222222', controllerId: '33333333-3333-4333-8333-333333333333', name: '내 iPhone' },
      { sessionId: '77777777-7777-4777-8777-777777777777', controllerId: '88888888-8888-4888-8888-888888888888', name: '내 iPad' },
    ];
    const wired: Array<typeof phones[number] & {
      publicKey: string;
      send: CryptoKey;
      receive: CryptoKey;
      fingerprint: string;
    }> = [];
    for (const phone of phones) {
      const keys = await generateRemoteControlRelayKeyPair();
      const publicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
      wired.push({
        ...phone,
        publicKey,
        send: await deriveRemoteControlRelaySessionKey({
          privateKey: keys.privateKey, peerPublicKey: importedHost,
          sessionId: phone.sessionId, controllerId: phone.controllerId,
          direction: 'controller-to-host', usages: ['encrypt'],
        }),
        receive: await deriveRemoteControlRelaySessionKey({
          privateKey: keys.privateKey, peerPublicKey: importedHost,
          sessionId: phone.sessionId, controllerId: phone.controllerId,
          direction: 'host-to-controller', usages: ['decrypt'],
        }),
        fingerprint: await fingerprintRemoteControlRelayPublicKey(publicKey),
      });
    }

    transport.sessions = wired.map(phone => ({
      sessionId: phone.sessionId,
      pairingId: parsed.bootstrap.pairingId,
      controllerId: phone.controllerId,
      controllerName: phone.name,
      controllerPublicKey: phone.publicKey,
      controllerKeyFingerprint: phone.fingerprint,
      approvalState: 'pending' as const,
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }));
    await agent.pollNow();
    for (const phone of wired) {
      const status = agent.status().sessions.find(session => session.sessionId === phone.sessionId)!;
      await agent.approveSession(phone.sessionId, status.sasCode!);
    }
    expect(agent.status().sessions.filter(session => session.approvalState === 'approved')).toHaveLength(2);
    expect(agent.status().sessions.every(session => (
      session.taskScopeGranted === false && session.conversationScopeGranted === false
    ))).toBe(true);
    expect(agent.record()?.sessions.every(session => (session.scopes ?? []).length === 0)).toBe(true);

    // Both phones pair. Under the old single-session core the second one threw.
    const ready: Array<{ sessionToken: string; projects: Array<{ controlId: string }> }> = [];
    let relaySequence = 0;
    for (const [index, phone] of wired.entries()) {
      relaySequence += 1;
      transport.deliveries = [{
        relaySequence: String(relaySequence),
        envelope: await encryptRemoteControlRelayEnvelope({
          key: phone.send,
          metadata: {
            schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
            messageId: `4444444${index}-4444-4444-8444-444444444444`,
            sessionId: phone.sessionId,
            controllerId: phone.controllerId,
            sequence: 1,
            expiresAt: pairingExpiresAt,
          },
          plaintext: encoder.encode(JSON.stringify({
            type: 'controller.pair',
            protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
            token: parsed.bootstrap.pairingSecret,
          })),
          now,
        }),
      }];
      await agent.pollNow();
      const reply = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
        key: phone.receive,
        envelope: transport.sent.at(-1)!.envelope,
        now,
      }))) as { type: string; sessionToken?: string; projects?: Array<{ controlId: string }>; message?: string };
      expect(reply.type).toBe('session.ready');
      ready.push(reply as { sessionToken: string; projects: Array<{ controlId: string }> });
    }
    expect(ready[0]!.sessionToken).not.toBe(ready[1]!.sessionToken);

    // Revoke the first phone only.
    const afterRevoke = await agent.revokeSession(wired[0]!.sessionId);
    expect(afterRevoke.sessions.find(session => session.sessionId === wired[0]!.sessionId))
      .toMatchObject({ approvalState: 'revoked' });
    expect(afterRevoke.sessions.find(session => session.sessionId === wired[1]!.sessionId))
      .toMatchObject({ approvalState: 'approved' });

    // The surviving phone must still be able to act. If revoke had closed every
    // core session (or the relay->core session mapping were missing), this
    // action would be rejected as an unknown session token and never execute.
    relaySequence += 1;
    transport.deliveries = [{
      relaySequence: String(relaySequence),
      envelope: await encryptRemoteControlRelayEnvelope({
        key: wired[1]!.send,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId: '55555555-5555-4555-8555-555555555555',
          sessionId: wired[1]!.sessionId,
          controllerId: wired[1]!.controllerId,
          sequence: 2,
          expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify({
          type: 'action.request',
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: ready[1]!.sessionToken,
          actionId: 'ipad-action-1',
          action: 'folder.open',
          controlId: ready[1]!.projects[0]!.controlId,
          remoteConfirmed: true,
        })),
        now,
      }),
    }];
    await agent.pollNow();
    expect(executions).toEqual(['ipad-action-1']);
  });
  test('keeps eight outstanding QRs and derives a late older scan from its exact secret', async () => {
    // Before this, the only route to a second QR was disable→enable, which
    // revoked every connected device (VOC 2026-08-31 23:42). The relay binds a
    // pairing row to ONE controller key, so a second phone needs its own QR.
    const transport = new FakeTransport();
    const agent = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      // Canonical base64url of 32 bytes: buildRemoteControlRelayPairingUrl
      // rejects a non-canonical secret, and so does issuePairing.
      randomSecret: (() => {
        let fill = 7;
        return () => encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(fill++));
      })(),
      autoPoll: false,
    });
    const first = await agent.initialize();
    const firstParsed = parseRemoteControlRelayPairingUrl(first.pairingUrl);

    const second = await agent.issuePairing();
    const secondParsed = parseRemoteControlRelayPairingUrl(second.pairingUrl);
    const issued = [firstParsed, secondParsed];
    while (issued.length < 8) {
      issued.push(parseRemoteControlRelayPairingUrl((await agent.issuePairing()).pairingUrl));
    }

    // A genuinely different QR: new pairing row and a new secret.
    expect(secondParsed.bootstrap.pairingId).not.toBe(firstParsed.bootstrap.pairingId);
    expect(secondParsed.bootstrap.pairingSecret).not.toBe(firstParsed.bootstrap.pairingSecret);
    // Same host identity, so the phone still verifies the same Mac.
    expect(secondParsed.bootstrap.hostId).toBe(firstParsed.bootstrap.hostId);
    expect(secondParsed.bootstrap.hostPublicKey).toBe(firstParsed.bootstrap.hostPublicKey);
    // The host was not torn down: the same registration is still in place and
    // the agent stayed enabled, so any approved device keeps its session.
    expect(transport.registration?.hostId).toBe(firstParsed.bootstrap.hostId);
    expect(agent.status().enabled).toBe(true);
    expect(agent.status().state).not.toBe('disabled');

    // The first QR is scanned only after seven newer QRs have been issued. A
    // scalar "latest secret" makes the Mac show a different SAS from the phone.
    const oldestKeys = await generateRemoteControlRelayKeyPair();
    const newestKeys = await generateRemoteControlRelayKeyPair();
    const oldestPublicKey = await exportRemoteControlRelayPublicKey(oldestKeys.publicKey);
    const newestPublicKey = await exportRemoteControlRelayPublicKey(newestKeys.publicKey);
    const oldestSessionId = '22222222-2222-4222-8222-222222222222';
    const newestSessionId = '77777777-7777-4777-8777-777777777777';
    const newestPairing = issued.at(-1)!;
    transport.sessions = [{
      sessionId: oldestSessionId,
      pairingId: firstParsed.bootstrap.pairingId,
      controllerId: '33333333-3333-4333-8333-333333333333',
      controllerName: '늦게 스캔한 iPhone',
      controllerPublicKey: oldestPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(oldestPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }, {
      sessionId: newestSessionId,
      pairingId: newestPairing.bootstrap.pairingId,
      controllerId: '88888888-8888-4888-8888-888888888888',
      controllerName: '최신 QR iPad',
      controllerPublicKey: newestPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(newestPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await agent.pollNow();

    const statuses = new Map(agent.status().sessions.map(session => [session.sessionId, session]));
    expect(statuses.get(oldestSessionId)?.pairingId).toBe(firstParsed.bootstrap.pairingId);
    const oldestSas = await remoteControlRelaySasCode({
      hostPublicKey: firstParsed.bootstrap.hostPublicKey,
      controllerPublicKey: oldestPublicKey,
      pairingSecret: firstParsed.bootstrap.pairingSecret,
    });
    const newestSas = await remoteControlRelaySasCode({
      hostPublicKey: newestPairing.bootstrap.hostPublicKey,
      controllerPublicKey: newestPublicKey,
      pairingSecret: newestPairing.bootstrap.pairingSecret,
    });
    expect(statuses.get(oldestSessionId)?.sasCode).toBe(oldestSas);
    expect(statuses.get(newestSessionId)?.sasCode).toBe(newestSas);
    expect(agent.record()?.pairingIds).toEqual(issued.map(item => item.bootstrap.pairingId));

    await agent.approveSession(oldestSessionId, oldestSas);
    expect(agent.status().sessions.find(session => session.sessionId === oldestSessionId))
      .toMatchObject({ approvalState: 'approved', sasCode: null });

    // Crossing the eight-unclaimed limit atomically retires the relay's oldest
    // unused QR and returns its exact id for local vault cleanup. Active session
    // secrets remain protected, so this settles at 2 active + 8 unclaimed.
    for (let index = 0; index < 9; index += 1) await agent.issuePairing();
    const boundedRecord = agent.record()!;
    expect(boundedRecord.pairingSecrets).toHaveLength(10);
    expect(boundedRecord.pairingIds).toContain(firstParsed.bootstrap.pairingId);
    expect(boundedRecord.pairingIds).toContain(newestPairing.bootstrap.pairingId);
    expect(boundedRecord.pairingIds).not.toContain(issued[1]!.bootstrap.pairingId);

    // A restart reconstructs crypto for both active sessions from the retained
    // exact secrets. The approved SAS stays private; the pending one still
    // matches the phone's older QR.
    const restored = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: 'ignored because record owns it',
      now: () => now,
      restore: boundedRecord,
      autoPoll: false,
    });
    await restored.restore();
    await restored.pollNow();
    const restoredStatuses = new Map(restored.status().sessions.map(session => [session.sessionId, session]));
    expect(restoredStatuses.get(oldestSessionId))
      .toMatchObject({ approvalState: 'approved', sasCode: null });
    expect(restoredStatuses.get(newestSessionId)?.sasCode).toBe(newestSas);
  });

  test('keeps legacy approved sessions online while revoking only pending rows with no exact QR secret', async () => {
    const transport = new FakeTransport();
    const live = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: '레거시 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: (() => {
        let fill = 31;
        return () => encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(fill++));
      })(),
      autoPoll: false,
    });
    const oldest = parseRemoteControlRelayPairingUrl((await live.initialize()).pairingUrl);
    const middle = parseRemoteControlRelayPairingUrl((await live.issuePairing()).pairingUrl);
    const newest = parseRemoteControlRelayPairingUrl((await live.issuePairing()).pairingUrl);
    const legacy = live.record()!;
    delete legacy.pairingIds;

    const keys = await Promise.all(Array.from({ length: 3 }, () => generateRemoteControlRelayKeyPair()));
    const publicKeys = await Promise.all(keys.map(key => exportRemoteControlRelayPublicKey(key.publicKey)));
    const rows: RemoteControlInternetSessionRow[] = [
      {
        sessionId: '21111111-1111-4111-8111-111111111111',
        pairingId: oldest.bootstrap.pairingId,
        controllerId: '31111111-1111-4111-8111-111111111111',
        controllerName: '기존 승인 iPhone',
        controllerPublicKey: publicKeys[0]!,
        controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(publicKeys[0]!),
        approvalState: 'approved',
        createdAt: new Date(now).toISOString(),
        expiresAt: sessionExpiresAt,
        approvedAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      {
        sessionId: '22222222-1111-4111-8111-111111111111',
        pairingId: middle.bootstrap.pairingId,
        controllerId: '32222222-1111-4111-8111-111111111111',
        controllerName: '복원 불가 승인 대기',
        controllerPublicKey: publicKeys[1]!,
        controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(publicKeys[1]!),
        approvalState: 'pending',
        createdAt: new Date(now).toISOString(),
        expiresAt: sessionExpiresAt,
        approvedAt: null,
        revokedAt: null,
      },
      {
        sessionId: '23333333-1111-4111-8111-111111111111',
        pairingId: newest.bootstrap.pairingId,
        controllerId: '33333333-1111-4111-8111-111111111111',
        controllerName: '최신 승인 대기 iPad',
        controllerPublicKey: publicKeys[2]!,
        controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(publicKeys[2]!),
        approvalState: 'pending',
        createdAt: new Date(now).toISOString(),
        expiresAt: sessionExpiresAt,
        approvedAt: null,
        revokedAt: null,
      },
    ];
    transport.sessions = rows;

    const restored = new RemoteControlInternetAgent({
      gateway: { listRegisteredProjects: () => [], executeRegisteredProjectAction: () => undefined },
      transport,
      controllerOrigin: 'https://controller.example.test',
      hostName: 'ignored',
      now: () => now,
      restore: legacy,
      autoPoll: false,
    });
    await restored.restore();
    await restored.pollNow();

    const statuses = new Map(restored.status().sessions.map(session => [session.sessionId, session]));
    expect(statuses.get(rows[0]!.sessionId)).toMatchObject({ approvalState: 'approved', sasCode: null });
    expect(statuses.get(rows[1]!.sessionId)).toMatchObject({ approvalState: 'revoked', sasCode: null });
    expect(transport.revokeCalls).toContain(rows[1]!.sessionId);
    expect(statuses.get(rows[2]!.sessionId)?.sasCode).toBe(await remoteControlRelaySasCode({
      hostPublicKey: newest.bootstrap.hostPublicKey,
      controllerPublicKey: publicKeys[2]!,
      pairingSecret: newest.bootstrap.pairingSecret,
    }));
    expect(restored.status().error).toBeNull();
  });

  test('answers the envelope when the binding lookup throws instead of dropping it', async () => {
    const transport = new FakeTransport();
    let projectProviderFails = false;
    const taskCalls: string[] = [];
    const conversationCalls: string[] = [];
    const gateway: RemoteControlGateway = {
      // `taskTargetBindings` refreshes the project cards through this provider,
      // so an outage here is exactly how a real gateway failure reaches the
      // delivery handler — as GATEWAY_UNAVAILABLE, after the scope and token
      // checks have already passed.
      listRegisteredProjects: () => {
        if (projectProviderFails) throw new Error('simulated registered project provider failure');
        return [{
          internalId: 'private-project-id',
          name: '내 프로젝트',
          port: 4317,
          kind: 'main' as const,
          folderPath: '/Users/private/project',
          command: 'bun run secret',
          status: 'stopped' as const,
          actions: ['start' as const],
        }];
      },
      executeRegisteredProjectAction: async () => undefined,
    };
    const agent = new RemoteControlInternetAgent({
      gateway,
      transport,
      taskGateway: {
        perform: async request => {
          taskCalls.push((request as { operationId: string }).operationId);
          return {
            type: 'tasks.result',
            protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
            taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
            operationId: (request as { operationId: string }).operationId,
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
          };
        },
      },
      conversationGateway: {
        perform: async request => {
          const typedRequest = request as { operationId: string; operation: 'capabilities' };
          conversationCalls.push(typedRequest.operationId);
          return {
            type: 'conversations.result',
            protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
            conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
            operationId: typedRequest.operationId,
            operation: typedRequest.operation,
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
          };
        },
      },
      controllerOrigin: 'https://controller.example.test',
      hostName: '게이트웨이 장애 테스트 Mac',
      now: () => now,
      randomUuid: uuidSequence(),
      randomSecret: () => 'G'.repeat(43),
      onRecordChanged: () => undefined,
      autoPoll: false,
    });
    const parsed = parseRemoteControlRelayPairingUrl((await agent.initialize()).pairingUrl);
    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    transport.sessions = [{
      sessionId,
      pairingId: parsed.bootstrap.pairingId,
      controllerId,
      controllerName: '내 iPhone',
      controllerPublicKey,
      controllerKeyFingerprint: await fingerprintRemoteControlRelayPublicKey(controllerPublicKey),
      approvalState: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: sessionExpiresAt,
      approvedAt: null,
      revokedAt: null,
    }];
    await agent.pollNow();
    await agent.approveSession(sessionId, agent.status().sessions[0]!.sasCode!, true, true);

    const importedHost = await importRemoteControlRelayPublicKey(parsed.bootstrap.hostPublicKey);
    const controllerSend = await deriveRemoteControlRelaySessionKey({
      privateKey: controllerKeys.privateKey,
      peerPublicKey: importedHost,
      sessionId,
      controllerId,
      direction: 'controller-to-host',
      usages: ['encrypt'],
    });
    const controllerReceive = await deriveRemoteControlRelaySessionKey({
      privateKey: controllerKeys.privateKey,
      peerPublicKey: importedHost,
      sessionId,
      controllerId,
      direction: 'host-to-controller',
      usages: ['decrypt'],
    });
    const controllerEnvelope = (sequence: number, messageId: string, payload: unknown) =>
      encryptRemoteControlRelayEnvelope({
        key: controllerSend,
        metadata: {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          messageId,
          sessionId,
          controllerId,
          sequence,
          expiresAt: pairingExpiresAt,
        },
        plaintext: encoder.encode(JSON.stringify(payload)),
        now,
      });
    const lastResponse = async () => JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({
      key: controllerReceive,
      envelope: transport.sent.at(-1)!.envelope,
      now,
    }))) as Record<string, unknown>;

    transport.deliveries = [{
      relaySequence: '1',
      envelope: await controllerEnvelope(1, 'a1111111-1111-4111-8111-111111111111', {
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: parsed.bootstrap.pairingSecret,
      }),
    }];
    await agent.pollNow();
    const paired = await lastResponse();
    expect(paired).toMatchObject({ type: 'session.ready' });

    transport.deliveries.push({
      relaySequence: '2',
      envelope: await controllerEnvelope(2, 'a2222222-2222-4222-8222-222222222222', {
        type: 'tasks.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        sessionToken: paired.sessionToken,
        operationId: 'task-operation-warmup01',
        operation: 'capabilities',
        payload: {},
      }),
    });
    await agent.pollNow();
    const warmup = await lastResponse();
    // Only a request whose token matches the live core session reaches the
    // binding lookup; anything else is answered with a refreshed session.ready
    // long before the failure under test can happen.
    expect(warmup).toMatchObject({ type: 'tasks.result', ok: true });
    expect(taskCalls).toEqual(['task-operation-warmup01']);
    const sessionToken = paired.sessionToken as string;

    projectProviderFails = true;
    transport.deliveries.push({
      relaySequence: '3',
      envelope: await controllerEnvelope(3, 'a3333333-3333-4333-8333-333333333333', {
        type: 'tasks.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        sessionToken,
        operationId: 'task-operation-87654321',
        operation: 'capabilities',
        payload: {},
      }),
    });
    // An escape from the delivery handler takes the whole poll down with it, so
    // the envelope is neither answered nor acked: the phone's operation hangs
    // forever with nothing on screen to explain it.
    const sentBeforeTaskFailure = transport.sent.length;
    const escapedFromTask = await agent.pollNow().then(() => null, error => error);
    expect(escapedFromTask).toBeNull();
    expect(transport.sent).toHaveLength(sentBeforeTaskFailure + 1);
    const taskFailure = await lastResponse();
    expect(transport.sent.at(-1)?.type).toBe('task');
    expect(taskFailure).toMatchObject({
      type: 'tasks.result',
      operationId: 'task-operation-87654321',
      ok: false,
    });
    expect((taskFailure.error as { code: string }).code).toBe('GATEWAY_UNAVAILABLE');
    // The answer has to come from the binding failure, not from a task gateway
    // that quietly succeeded.
    expect(taskCalls).toEqual(['task-operation-warmup01']);
    expect(transport.acknowledgements).toEqual(['1', '2', '3']);

    transport.deliveries.push({
      relaySequence: '4',
      envelope: await controllerEnvelope(4, 'a4444444-4444-4444-8444-444444444444', {
        type: 'conversations.request',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        sessionToken,
        operationId: 'conversation-operation-87654321',
        operation: 'capabilities',
        payload: {},
      }),
    });
    const sentBeforeConversationFailure = transport.sent.length;
    const escapedFromConversation = await agent.pollNow().then(() => null, error => error);
    expect(escapedFromConversation).toBeNull();
    expect(transport.sent).toHaveLength(sentBeforeConversationFailure + 1);
    const conversationFailure = await lastResponse();
    expect(transport.sent.at(-1)?.type).toBe('conversation');
    expect(conversationFailure).toMatchObject({
      type: 'conversations.result',
      operation: 'capabilities',
      operationId: 'conversation-operation-87654321',
      ok: false,
    });
    expect((conversationFailure.error as { code: string }).code).toBe('GATEWAY_UNAVAILABLE');
    expect(conversationCalls).toEqual([]);
    expect(transport.acknowledgements).toEqual(['1', '2', '3', '4']);
    expect(agent.status().state).toBe('online');
  });
});
