/**
 * The phone's own network, through the real controller and real E2EE (2026-10-10, iPhone 13 with
 * Wi‑Fi off): the workroom said 「앞서 보낸 요청의 결과를 Mac이 아직 보내지 않았습니다」 for a request that
 * never left the phone. These tests pin both halves — the words now name the phone, and the
 * exactly-once design underneath is unchanged: the same envelope, kept, delivered once.
 */
import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlCore';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
  type RemoteControlRelayEnvelope,
} from '../src/remoteControlRelayContract';
import {
  REMOTE_CONTROL_HOST_SILENT_MS,
  REMOTE_CONTROL_PHONE_OFFLINE,
  REMOTE_CONTROL_REQUEST_UNSENT,
  REMOTE_CONTROL_REQUEST_UNSENT_AHEAD,
  REMOTE_CONTROL_RESULT_UNREACHABLE,
  RemoteControlRelayController,
  RemoteControlRelayRequestError,
  type RemoteControlRelayControllerTransport,
} from '../src/remoteControlRelayController';
import { RemoteControlRelayRpcError } from '../src/remoteControlRelayRpcClient';
import { createTerminalRequester, terminalSubmissionGroup, HELD_PART_NOTICE, PARTIAL_SUBMISSION_NOTICE } from '../src/aiTerminalScheduling';
import { sendRemoteVoc, VOC_HELD_ON_PHONE } from '../src/remoteVoc';
import { phoneOfflineNotice, phoneOfflineRefusal } from '../src/phoneNetwork';
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
const start = Date.parse('2099-08-30T12:00:00.000Z');
const expiresAt = '2099-09-29T12:00:00.000Z';
const pairingExpiresAt = '2099-08-30T12:05:00.000Z';
const hostId = '11111111-1111-4111-8111-111111111111';
const pairingId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const controllerId = '44444444-4444-4444-8444-444444444444';
const pairingSecret = encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(4));
const CONTROL_ID = 'C'.repeat(43);
const project = { controlId: CONTROL_ID, name: '테스트 프로젝트', port: 4317, kind: 'main', status: 'stopped', actions: ['start'] };

/** WebKit's offline fetch through supabase-js, as the RPC client wraps it. */
const loadFailed = () => new RemoteControlRelayRpcError('RELAY_REQUEST_FAILED', 'TypeError: Load failed');

/**
 * A relay that accepts only an exact duplicate of a message id (like the real one), with a switch for
 * this phone's network, and a Mac that answers what it receives.
 */
class Relay implements RemoteControlRelayControllerTransport {
  network: 'up' | 'down' = 'up';
  /** Sends get through but reading answers fails: the request reached the relay, its result did not reach the phone. */
  receiveDown = false;
  /** The relay answers, but refuses (an expired JWT, a policy error): reachable, not a network problem. */
  refuse: null | 'status' | 'send' = null;
  /** Every envelope the relay accepted, keyed by message id: a retry must be byte-identical. */
  accepted = new Map<string, RemoteControlRelayEnvelope>();
  /** How many times the Mac saw each message id — exactly-once means 1. */
  executed = new Map<string, number>();
  attempts = 0;
  /** The Mac is slow to poll (after a long silence): what it receives waits here until `release()`. */
  hold = false;
  #held: RemoteControlRelayEnvelope[] = [];
  async release() { const held = this.#held.splice(0); for (const envelope of held) await this.host(envelope); }
  approvalState: 'pending' | 'approved' = 'pending';
  hostLastSeenAt: string | null = null;
  deliveries: Array<{ relaySequence: string; envelope: RemoteControlRelayEnvelope }> = [];
  controllerPublicKey = '';
  host!: (envelope: RemoteControlRelayEnvelope) => Promise<void>;
  constructor(readonly hostPublicKey: string, readonly hostFingerprint: string) {}
  #reachable() { if (this.network === 'down') throw loadFailed(); }
  async claimPairing(input: { controllerPublicKey: string }) {
    this.controllerPublicKey = input.controllerPublicKey;
    return { sessionId, controllerId, hostId, hostName: '내 Mac', hostPublicKey: this.hostPublicKey,
      hostPublicKeyFingerprint: this.hostFingerprint, approvalState: 'pending' as const, expiresAt };
  }
  async status() {
    this.#reachable();
    if (this.refuse === 'status') throw new RemoteControlRelayRpcError('RELAY_REQUEST_FAILED', 'JWT expired');
    return { sessionId, controllerId, approvalState: this.approvalState, hostEnabled: true,
      hostExpiresAt: expiresAt, sessionExpiresAt: expiresAt, revokedAt: null, hostLastSeenAt: this.hostLastSeenAt };
  }
  async sendEnvelope(_h: string, _s: string, envelope: RemoteControlRelayEnvelope) {
    this.attempts += 1;
    this.#reachable();
    if (this.refuse === 'send') throw new RemoteControlRelayRpcError('RELAY_REQUEST_FAILED', 'permission denied for function');
    const previous = this.accepted.get(envelope.messageId);
    if (previous) {
      // The real relay refuses a reused id with different bytes; an exact duplicate is a no-op.
      expect(previous).toEqual(envelope);
      return;
    }
    this.accepted.set(envelope.messageId, { ...envelope });
    this.executed.set(envelope.messageId, (this.executed.get(envelope.messageId) ?? 0) + 1);
    if (this.hold) { this.#held.push(envelope); return; }
    await this.host(envelope);
  }
  async receiveEnvelopes(_h: string, _s: string, after: string) {
    this.#reachable();
    if (this.receiveDown) throw loadFailed();
    return this.deliveries.filter(delivery => BigInt(delivery.relaySequence) > BigInt(after));
  }
  async acknowledge() { this.#reachable(); }
  async revoke() {}
}

async function connectedPhone(options: { online?: () => boolean; clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: start };
  const hostKeys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
  const relay = new Relay(hostPublicKey, await fingerprintRemoteControlRelayPublicKey(hostPublicKey));
  const controller = new RemoteControlRelayController({
    transport: relay,
    pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId, pairingId, pairingSecret, hostPublicKey, expiresAt: pairingExpiresAt,
    }),
    controllerName: '내 iPhone',
    now: () => clock.now,
    sleep: async () => {},
    isOnline: options.online ?? (() => true),
  });
  await controller.initialize();
  const peer = await importRemoteControlRelayPublicKey(relay.controllerPublicKey);
  const hostReceive = await deriveRemoteControlRelaySessionKey({ privateKey: hostKeys.privateKey, peerPublicKey: peer,
    sessionId, controllerId, direction: 'controller-to-host', usages: ['decrypt'] });
  const hostSend = await deriveRemoteControlRelaySessionKey({ privateKey: hostKeys.privateKey, peerPublicKey: peer,
    sessionId, controllerId, direction: 'host-to-controller', usages: ['encrypt'] });
  let hostSequence = 0;
  const seen: Array<Record<string, any>> = [];
  const reply = async (message: unknown) => {
    hostSequence += 1;
    relay.deliveries.push({ relaySequence: String(hostSequence), envelope: await encryptRemoteControlRelayEnvelope({
      key: hostSend,
      metadata: { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: crypto.randomUUID(), sessionId, controllerId,
        sequence: hostSequence, expiresAt: new Date(clock.now + 10 * 60_000).toISOString() },
      plaintext: encoder.encode(JSON.stringify(message)), now: clock.now,
    }) });
  };
  relay.host = async envelope => {
    const message = JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: hostReceive, envelope, now: clock.now })));
    seen.push(message);
    if (message.type === 'controller.pair') {
      await reply({ type: 'session.ready', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: 'T'.repeat(43),
        hostName: '내 Mac', expiresAt, idleExpiresAt: '2099-09-29T12:00:00.000Z', projects: [project], projectCount: 1, nextPage: null });
    } else if (message.type === 'action.request' && message.action === 'protocol.capabilities') {
      await reply({ type: 'action.result', actionId: message.actionId, ok: true, supportedFeatures: ['tasks-v1', 'workspace-v1', 'voc-v1'] });
    } else if (message.type === 'action.request') {
      await reply({ type: 'action.result', actionId: message.actionId, ok: true, project: { ...project, status: 'running', actions: ['stop'] } });
    } else if (message.type === 'tasks.request') {
      // Never answered here: the tests that send a task only care that it was (or was not) received.
    } else if (message.type === 'terminal.request') {
      await reply({ type: 'terminal.result', requestId: message.request.requestId, ok: true, body: message.request.operation === 'workspace'
        ? { kind: 'workspace', action: message.request.workspace.action, voc: { file: 'x.json', attachmentPaths: [], transitDeleted: true } }
        : { sessions: [] } });
    }
  };
  relay.approvalState = 'approved';
  await controller.refresh();
  expect(controller.status().state).toBe('online');
  return { controller, relay, seen, clock };
}

const requestsOf = (seen: Array<Record<string, any>>, type: string) => seen.filter(message => message.type === type);

describe('a request that has not left the phone', () => {
  test('the failing tap names the phone network and what happens to the request', async () => {
    const { controller, relay, seen } = await connectedPhone();
    relay.network = 'down';
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure).toBeInstanceOf(RemoteControlRelayRequestError);
    expect(failure.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    expect(failure.message).toContain('휴대폰 네트워크');
    expect(failure.message).toContain('한 번만 보냅니다');
    expect(failure.message).not.toMatch(/Mac이 아직 결과를 보내지 않았/);
    // The original network error is kept for diagnosis, not shown.
    expect(failure.cause).toBeInstanceOf(RemoteControlRelayRpcError);
    expect(controller.status()).toMatchObject({ unsentRequest: true, relayUnreachable: true, busy: true });
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
  });

  test('later calls are refused with the same cause — never 「결과를 Mac이 아직 보내지 않았습니다」', async () => {
    const { controller, relay } = await connectedPhone();
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const blockedTap = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    // Its own code: this call was refused, not kept — only the held request carries REQUEST_UNSENT.
    expect(blockedTap.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT_AHEAD);
    expect(blockedTap.message).toContain('아직 Mac에 전달되지 않았을 수 있습니다');
    const blockedTerminal = await controller.sendTerminal({ operation: 'list', requestId: 'list-while-unsent' }).catch(error => error);
    expect(blockedTerminal.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT_AHEAD);
    expect(blockedTerminal.message).not.toContain('결과를 Mac이 아직 보내지 않았습니다');
    // Nothing new was encrypted: the outbox still holds exactly the first request.
    expect(relay.accepted.size).toBe(1); // only controller.pair from connecting
  });

  test('when the network returns, the same envelope is delivered once and the result arrives', async () => {
    const { controller, relay, seen } = await connectedPhone();
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const outbox = controller.snapshot()!.pendingOutbound!;
    expect(outbox).not.toBeNull();
    // A refresh while still offline changes nothing about the request.
    await controller.refresh().catch(() => undefined);
    expect(controller.snapshot()!.pendingOutbound).toEqual(outbox);

    relay.network = 'up';
    await controller.refresh();
    // Byte-identical: same id, sequence, nonce, ciphertext and expiry — never re-encrypted.
    expect(relay.accepted.get(outbox.messageId)).toEqual(outbox);
    expect(relay.executed.get(outbox.messageId)).toBe(1);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
    expect(controller.status().projects[0]?.status).toBe('running');
    expect(controller.status()).toMatchObject({ busy: false, unsentRequest: false, relayUnreachable: false, error: null });

    // Another refresh never sends it again.
    await controller.refresh();
    expect(relay.executed.get(outbox.messageId)).toBe(1);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
  });

  test('a request lost on the way back keeps the old lock and code — the exactly-once invariant is unchanged', async () => {
    // Not a network error: the relay may have accepted it. The phone cannot say "not sent".
    const { controller, relay } = await connectedPhone();
    const original = relay.sendEnvelope.bind(relay);
    let fail = true;
    relay.sendEnvelope = async (...args) => { await original(...args); if (fail) { fail = false; throw new Error('simulated response loss'); } };
    await expect(controller.sendAction('start', CONTROL_ID)).rejects.toThrow('simulated response loss');
    await expect(controller.sendAction('start', CONTROL_ID)).rejects.toThrow('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    expect(controller.status().unsentRequest).toBe(false);
  });

  test('navigator.onLine can say online while requests fail: the failed send still decides the words', async () => {
    const { controller, relay } = await connectedPhone({ online: () => true });
    relay.network = 'down';
    const failure = await controller.sendTerminal({ operation: 'list', requestId: 'captive-portal-list' }).catch(error => error);
    expect(failure.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    expect(controller.status().unsentRequest).toBe(true);
    relay.network = 'up';
    await controller.refresh();
    expect(controller.status().unsentRequest).toBe(false);
  });

  test('past its delivery expiry the stalled request is not replayed, and the notice says why', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const outbox = controller.snapshot()!.pendingOutbound!;
    clock.now = start + 11 * 60_000;
    relay.network = 'up';
    await controller.refresh();
    expect(relay.accepted.has(outbox.messageId)).toBe(false);
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
    // The checkpoint re-paired; the Mac did not restart, so the notice must not say it did.
    expect(controller.status().state).toBe('online');
    expect(controller.status().error).toContain('오래 오프라인이어서 보내지 못한 요청은 다시 보내지 않았습니다');
    expect(controller.status().error).not.toContain('다시 시작되어');
  });
});

describe('a phone that reports no network', () => {
  test('a new request is refused before anything is encrypted or queued', async () => {
    let online = true;
    const { controller, relay } = await connectedPhone({ online: () => online });
    online = false;
    const before = relay.attempts;
    for (const attempt of [
      () => controller.sendAction('start', CONTROL_ID),
      () => controller.sendTerminal({ operation: 'list', requestId: 'list-offline' }),
    ]) {
      const failure = await attempt().catch(error => error);
      expect(failure.code).toBe(REMOTE_CONTROL_PHONE_OFFLINE);
      // The tap says it was not sent; the workroom's own list poll says the page reconnects by itself.
      expect(failure.message).toMatch(/휴대폰이 인터넷에 연결되어 있지 않(아|습니다)/);
    }
    expect(relay.attempts).toBe(before);
    expect(controller.snapshot()!.pendingOutbound).toBeNull();
    expect(controller.status()).toMatchObject({ busy: false, unsentRequest: false });
    // Back online, the next tap simply goes.
    online = true;
    await controller.sendAction('start', CONTROL_ID);
    expect(controller.status().projects[0]?.status).toBe('running');
  });

  test('a frozen last-seen is not called a sleeping Mac while the relay is out of reach', async () => {
    const clock = { now: start };
    const { controller, relay } = await connectedPhone({ clock });
    relay.hostLastSeenAt = new Date(start).toISOString();
    await controller.refresh();
    clock.now = start + REMOTE_CONTROL_HOST_SILENT_MS + 5 * 60_000;
    relay.network = 'down';
    await controller.refresh().catch(() => undefined);
    expect(controller.status().relayUnreachable).toBe(true);
    expect(controller.status().error).toContain('릴레이에 연결하지 못했습니다');
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure.message).not.toContain('절전');
    expect(failure.message).toContain('휴대폰 네트워크');
    expect(controller.snapshot()!.pendingOutbound).toBeNull();
    // With the relay reachable again and the Mac really silent, the old refusal stands.
    relay.network = 'up';
    await controller.refresh();
    await expect(controller.sendAction('start', CONTROL_ID)).rejects.toThrow(/절전 상태이거나/);
  });

  test('noteNetworkLost marks the relay unreachable until a call succeeds again', async () => {
    const { controller } = await connectedPhone();
    controller.noteNetworkLost();
    expect(controller.status().relayUnreachable).toBe(true);
    await controller.refresh();
    expect(controller.status().relayUnreachable).toBe(false);
  });
});

describe('a request held on the phone past its delivery expiry', () => {
  const NOT_THE_MAC = /다시 시작되어|Mac의 응답을 받지 못해|Mac이 응답하지 않아/;

  test('an action: 12 minutes offline, then back — the phone, not the Mac, is named and nothing runs', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const outbox = controller.snapshot()!.pendingOutbound!;
    clock.now = start + 12 * 60_000; // past the 11-minute release, not on its boundary
    relay.network = 'up';
    await controller.refresh();
    expect(relay.accepted.has(outbox.messageId)).toBe(false);
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
    expect(controller.status().error).toContain('오래 오프라인이어서');
    expect(controller.status().error).not.toMatch(NOT_THE_MAC);
    expect(controller.status()).toMatchObject({ state: 'online', busy: false, unsentRequest: false });
  });

  test('a task: the same, with the task wording that used to say the Mac did not answer', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    await controller.probeSupportedFeatures();
    expect(controller.status().supportedFeatures).toContain('tasks-v1');
    relay.network = 'down';
    const sent = await controller.sendTask('capabilities', {}).catch(error => error);
    expect(sent.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    clock.now = start + 12 * 60_000;
    relay.network = 'up';
    await controller.refresh();
    expect(requestsOf(seen, 'tasks.request')).toHaveLength(0);
    expect(controller.status().error).toContain('오래 오프라인이어서');
    expect(controller.status().error).not.toMatch(NOT_THE_MAC);
    expect(controller.status().busy).toBe(false);
  });

  test('after a reload the network flags are gone: the notice is neutral, never 「Mac이 다시 시작되어」', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const restored = new RemoteControlRelayController({ transport: relay, restoredSession: controller.snapshot(), controllerName: '내 iPhone',
      now: () => clock.now, sleep: async () => {}, isOnline: () => true });
    clock.now = start + 10.5 * 60_000; // expired (10 min) but not yet released (11 min)
    relay.network = 'up';
    await restored.refresh();
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
    expect(restored.status().error).toContain('전달 기한');
    expect(restored.status().error).not.toMatch(NOT_THE_MAC);
  });

  test('after a reload and 12 minutes: neutral too', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    const restored = new RemoteControlRelayController({ transport: relay, restoredSession: controller.snapshot(), controllerName: '내 iPhone',
      now: () => clock.now, sleep: async () => {}, isOnline: () => true });
    clock.now = start + 12 * 60_000;
    relay.network = 'up';
    await restored.refresh();
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
    expect(restored.status().error).toContain('전달 기한');
    expect(restored.status().error).not.toMatch(NOT_THE_MAC);
  });

  test('the blocked-call notice counts down from the original tap, not a fresh 10 minutes', async () => {
    const clock = { now: start };
    const { controller, relay } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    clock.now = start + 2 * 60_000;
    expect((await controller.sendAction('start', CONTROL_ID).catch(error => error)).message).toContain('약 8분 안에');
    clock.now = start + 9.5 * 60_000;
    expect((await controller.sendAction('start', CONTROL_ID).catch(error => error)).message).toContain('1분 안에');
    clock.now = start + 10.5 * 60_000;
    const late = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(late.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT_AHEAD);
    expect(late.message).toContain('전달 기한');
    expect(late.message).not.toContain('안에 다시 연결되지 않으면');
  });

  test('the promise is tied to this screen reconnecting, not to the network alone', async () => {
    const { controller, relay } = await connectedPhone();
    relay.network = 'down';
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure.message).toContain('이 화면이 다시 연결되면');
    expect(failure.message).toContain('처음 보낸 지 약 10분');
  });
});

describe('a relay that answers is reachable, even when it refuses', () => {
  test('a network failure, then a refusal: relayUnreachable clears and the phone is not blamed', async () => {
    const clock = { now: start };
    const { controller, relay } = await connectedPhone({ clock });
    relay.hostLastSeenAt = new Date(start).toISOString();
    await controller.refresh();
    relay.network = 'down';
    await controller.refresh().catch(() => undefined);
    expect(controller.status().relayUnreachable).toBe(true);
    relay.network = 'up';
    relay.refuse = 'status';
    await controller.refresh().catch(() => undefined);
    expect(controller.status().relayUnreachable).toBe(false);
    clock.now = start + REMOTE_CONTROL_HOST_SILENT_MS + 5 * 60_000;
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure.code).not.toBe(REMOTE_CONTROL_PHONE_OFFLINE);
    expect(failure.message).not.toContain('휴대폰 네트워크');
  });

  test('a stalled send, then a refused one: no longer called 「휴대폰 네트워크 문제」', async () => {
    const { controller, relay } = await connectedPhone();
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    expect(controller.status().unsentRequest).toBe(true);
    relay.network = 'up';
    relay.refuse = 'send';
    await controller.refresh().catch(() => undefined);
    expect(controller.status()).toMatchObject({ unsentRequest: false, relayUnreachable: false });
    const blocked = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(blocked.message).toBe('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    // The envelope is still kept: a refusal is no reason to drop or re-encrypt it.
    expect(controller.snapshot()!.pendingOutbound).not.toBeNull();
  });
});

describe('the pairing send fails on the network', () => {
  test('status.error is a sentence, never the raw code', async () => {
    const hostKeys = await generateRemoteControlRelayKeyPair();
    const hostPublicKey = await exportRemoteControlRelayPublicKey(hostKeys.publicKey);
    const relay = new Relay(hostPublicKey, await fingerprintRemoteControlRelayPublicKey(hostPublicKey));
    relay.host = async () => {};
    const controller = new RemoteControlRelayController({
      transport: relay,
      pairingUrl: buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/', {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId, pairingId, pairingSecret, hostPublicKey, expiresAt: pairingExpiresAt,
      }),
      controllerName: '내 iPhone', now: () => start, sleep: async () => {}, isOnline: () => true,
    });
    await controller.initialize();
    relay.approvalState = 'approved';
    relay.sendEnvelope = async () => { throw loadFailed(); };
    const thrown = await controller.refresh().catch(error => error);
    expect(controller.status().error).not.toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    expect(controller.status().error).toContain('릴레이에 연결하지 못했습니다');
    // The automatic pairing send is not a request the user made: the poll that reports this must not get the
    // 「다시 누르지 마세요 … 약 10분이 지나면 보내지 않습니다」 promise (review 2026-10-10).
    expect(thrown.code).not.toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    expect(thrown.message ?? '').not.toContain('다시 누르지 마세요');
    expect(thrown).toBeInstanceOf(RemoteControlRelayRpcError);
  });
});

describe('a request that reached the relay, whose answer the phone cannot read', () => {
  test('the tap, later taps and the workroom all say the result could not be read — never 「Mac 연결은 정상」 or 「Mac이 아직…」', async () => {
    const { controller, relay, seen } = await connectedPhone({ online: () => true });
    relay.receiveDown = true;
    const first = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1); // it did reach the Mac
    expect(first.code).toBe(REMOTE_CONTROL_RESULT_UNREACHABLE);
    expect(first.message).toContain('실행 중이거나 끝났을 수 있으니');
    expect(first.message).toContain('다시 누르지 말고');
    expect(controller.status()).toMatchObject({ relayUnreachable: true, unsentRequest: false, busy: true });

    const again = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(again.code).toBe(REMOTE_CONTROL_RESULT_UNREACHABLE);
    expect(again.message).not.toBe('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    const list = await controller.sendTerminal({ operation: 'list', requestId: 'list-while-result-unread' }).catch(error => error);
    expect(list.code).toBe(REMOTE_CONTROL_RESULT_UNREACHABLE);
    expect(list.message).not.toContain('결과를 Mac이 아직 보내지 않았습니다');
    // Still exactly one request on the Mac.
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);

    relay.receiveDown = false;
    await controller.refresh();
    expect(controller.status().projects[0]?.status).toBe('running');
    expect(controller.status()).toMatchObject({ busy: false, relayUnreachable: false });
  });
});

// Review 2026-10-10: one code for "this request is held" and "refused behind a held request" made the workroom and
// VOC promise delivery of input that was dropped. Reproduced with the real controller; these are the three cases.
describe('a call refused behind a held request is not itself held', () => {
  const terminalOf = (seen: Array<Record<string, any>>) => requestsOf(seen, 'terminal.request').map(message => message.request);
  const transportOf = (controller: RemoteControlRelayController) => (request: any) => controller.sendTerminal(request) as any;

  test('(a) a background read is held, then a two-part input: the parts are refused and dropped, not "kept"', async () => {
    const { controller, relay, seen } = await connectedPhone();
    const request = createTerminalRequester(transportOf(controller), true);
    relay.network = 'down';
    const read = await request({ operation: 'read', sessionId: 'S1', after: 0 } as any).catch(error => error);
    expect(read.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    const group = terminalSubmissionGroup();
    const [first, second] = await Promise.all([
      request({ operation: 'input', sessionId: 'S1', data: 'rm -rf build && ' } as any, { group }).catch(error => error),
      request({ operation: 'input', sessionId: 'S1', data: 'make\r' } as any, { group }).catch(error => error),
    ]);
    expect(first.message).not.toBe(HELD_PART_NOTICE);
    expect(first.code).not.toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    expect(first.message).toContain(PARTIAL_SUBMISSION_NOTICE);
    expect(second.partOfFailedSubmission).toBe(true);
    expect(group.failed).toBe(true);
    relay.network = 'up';
    await controller.refresh();
    expect(terminalOf(seen).filter(r => r.operation === 'input')).toHaveLength(0);
  });

  test('(b) part 1 delivered, a read held, the last part refused: the group fails with the partial notice', async () => {
    const { controller, relay, seen } = await connectedPhone();
    const request = createTerminalRequester(transportOf(controller), true);
    const group = terminalSubmissionGroup();
    await request({ operation: 'input', sessionId: 'S1', data: 'rm -rf build && ' } as any, { group });
    relay.network = 'down';
    await request({ operation: 'read', sessionId: 'S1', after: 0 } as any).catch(() => undefined);
    const last = await request({ operation: 'input', sessionId: 'S1', data: 'make\r' } as any, { group }).catch(error => error);
    expect(last.message).toContain(PARTIAL_SUBMISSION_NOTICE);
    expect(group.failed).toBe(true);
    relay.network = 'up';
    await controller.refresh();
    expect(terminalOf(seen).filter(r => r.operation === 'input').map(r => r.data)).toEqual(['rm -rf build && ']);
  });

  test('(c) a read held, then a VOC: refused as a failure, never 「같은 VOC를 한 번만 보냅니다」', async () => {
    const { controller, relay, seen } = await connectedPhone();
    await controller.probeSupportedFeatures();
    relay.network = 'down';
    const read = await controller.sendTerminal({ operation: 'read', requestId: 'read-held-1', sessionId: 'S1', after: 0 } as any).catch(error => error);
    expect(read.code).toBe(REMOTE_CONTROL_REQUEST_UNSENT);
    const supabase = { storage: { from: () => ({ remove: async () => ({}) }) } } as any;
    const failure = await sendRemoteVoc({ supabase, hostId, targetId: CONTROL_ID, comment: '워크룸이 안 됩니다', source: 'phone' as any,
      context: { screen: '원격 작업', appVersion: 'web v1', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION } as any, images: [],
      send: request => controller.sendTerminal(request) }).catch(error => error);
    expect(failure.code).not.toBe(VOC_HELD_ON_PHONE);
    expect(failure.message).not.toContain('다시 보내지 마세요');
    relay.network = 'up';
    await controller.refresh();
    expect(terminalOf(seen).filter(r => r.operation === 'workspace')).toHaveLength(0);
  });

  test('the held request alone keeps REQUEST_UNSENT; the refusal behind it has its own code', async () => {
    const { controller, relay } = await connectedPhone();
    relay.network = 'down';
    const held = await controller.sendTerminal({ operation: 'read', requestId: 'read-held-2', sessionId: 'S1', after: 0 } as any).catch(error => error);
    const refused = await controller.sendTerminal({ operation: 'input', requestId: 'input-refused-1', sessionId: 'S1', data: 'x' } as any).catch(error => error);
    expect([held.code, refused.code]).toEqual([REMOTE_CONTROL_REQUEST_UNSENT, REMOTE_CONTROL_REQUEST_UNSENT_AHEAD]);
  });
});

describe('the expiry notice outlives the checkpoint (review 2026-10-10)', () => {
  test('a Mac that answers the checkpoint after the 11-minute mark: the release names the phone, not the Mac', async () => {
    const clock = { now: start };
    const { controller, relay, seen } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    // Back at 10 min 50 s: the expired envelope is replaced by the pairing checkpoint, which the slow Mac has not read.
    clock.now = start + (10 * 60 + 50) * 1000;
    relay.network = 'up';
    relay.hold = true;
    await controller.refresh();
    expect(controller.snapshot()!.pendingOutbound).toBeNull();
    expect(controller.status().state).toBe('connecting');
    clock.now = start + (11 * 60 + 5) * 1000;
    await controller.refresh();
    expect(controller.status().error).toContain('오래 오프라인이어서');
    expect(controller.status().error).not.toMatch(/Mac의 응답을 받지 못해|Mac이 응답하지 않아|다시 시작되어/);
    expect(controller.status().busy).toBe(false);
    // The Mac answers; the action never ran.
    relay.hold = false;
    await relay.release();
    await controller.refresh();
    expect(controller.status().state).toBe('online');
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
  });
});

describe('a workroom poll refused offline is not a tap (review 2026-10-10)', () => {
  test('a background list/read says the page reconnects by itself; a user request says it was not sent', async () => {
    let online = true;
    const { controller } = await connectedPhone({ online: () => online });
    online = false;
    const read = await controller.sendTerminal({ operation: 'read', requestId: 'bg-read', sessionId: 'S1', after: 0 } as any).catch(error => error);
    const list = await controller.sendTerminal({ operation: 'list', requestId: 'bg-list' }).catch(error => error);
    for (const failure of [read, list]) {
      expect(failure.code).toBe(REMOTE_CONTROL_PHONE_OFFLINE);
      expect(failure.message).toBe(phoneOfflineNotice());
      expect(failure.message).not.toMatch(/보내지 않았습니다|다시 시도하세요/);
    }
    const input = await controller.sendTerminal({ operation: 'input', requestId: 'typed-input-1', sessionId: 'S1', data: 'x' } as any).catch(error => error);
    expect(input.message).toBe(phoneOfflineRefusal(false));
    expect(input.message).toContain('보내지 않았습니다');
  });
});
