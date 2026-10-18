/**
 * A failed local save is not a broken session (iPhone 13 v985, 2026-10-16). After a bookmark opened Safari, iOS
 * suspended the app and WebKit aborted an IndexedDB transaction of the session vault; the controller threw the vault's
 * 「원격제어 세션을 안전하게 복구하지 못했습니다 … 새 QR을 스캔해 주세요」 while the Mac kept answering. These tests run the
 * real controller and real E2EE with a session save that fails on purpose, and pin the exactly-once rules that stay:
 * nothing goes to the relay before the snapshot holding it is stored, and a delivery is acknowledged only once a stored
 * snapshot covers it.
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
  REMOTE_CONTROL_LOCAL_SAVE_FAILED,
  RemoteControlRelayController,
  type RemoteControlRelayControllerTransport,
} from '../src/remoteControlRelayController';
import { RemoteControlRelayRpcError } from '../src/remoteControlRelayRpcClient';
import {
  decryptRemoteControlRelayEnvelope,
  deriveRemoteControlRelaySessionKey,
  encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto';
import { INDEXED_DB_RETRY_DELAYS_MS, isTransientIndexedDbCode, withIndexedDbRetry } from '../src/indexedDbRetry';
import { readFileSync } from 'node:fs';

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
  acknowledged: string[] = [];
  async acknowledge(_h: string, _s: string, through: string) { this.#reachable(); this.acknowledged.push(through); }
  async revoke() {}
}

/** `failSaves` > 0 makes the next that-many session saves throw, as an aborted IndexedDB transaction does. */
const saves = { failSaves: 0, ok: 0, failed: 0 };

async function connectedPhone(options: { online?: () => boolean; clock?: { now: number }; connect?: boolean; saveDelay?: () => number; savedSequences?: number[]; sleep?: (ms: number) => Promise<void>; hangSave?: () => boolean; onClaimed?: () => void; beforeInitialize?: () => void } = {}) {
  saves.failSaves = 0; saves.ok = 0; saves.failed = 0;
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
    sleep: options.sleep ?? (async () => {}),
    isOnline: options.online ?? (() => true),
    persistAttemptTimeoutMs: 50,
    onClaimed: options.onClaimed,
    onSessionChanged: async snapshot => {
      if (options.hangSave?.()) return new Promise<void>(() => {});
      const delay = options.saveDelay?.() ?? 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (saves.failSaves > 0) { saves.failSaves -= 1; saves.failed += 1; throw new Error('INDEXED_DB_FAILED'); }
      saves.ok += 1;
      if (snapshot) options.savedSequences?.push(snapshot.sendSequence);
    },
  });
  options.beforeInitialize?.();
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
  if (options.connect === false) return { controller, relay, seen, clock };
  await controller.refresh();
  expect(controller.status().state).toBe('online');
  return { controller, relay, seen, clock };
}


const requestsOf = (seen: Array<Record<string, any>>, type: string) => seen.filter(message => message.type === type);
const sequencesOf = (relay: Relay) => [...relay.accepted.values()].map(envelope => envelope.sequence);

describe('a session save that fails', () => {
  test('before a request is sent: nothing reaches the relay, the lock is free, and pressing again uses the same sequence', async () => {
    const { controller, relay, seen } = await connectedPhone();
    const before = sequencesOf(relay);
    const attempts = relay.attempts;
    saves.failSaves = 3; // every attempt of the controller's retry fails
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure.code).toBe(REMOTE_CONTROL_LOCAL_SAVE_FAILED);
    expect(failure.message).toContain('보내지 않았습니다');
    expect(failure.message).not.toContain('QR');
    expect(relay.attempts).toBe(attempts);
    expect(requestsOf(seen, 'action.request')).toHaveLength(0);
    expect(controller.snapshot()!.pendingOutbound).toBeNull();
    expect(controller.status()).toMatchObject({ busy: false, state: 'online' });

    // Pressing again: one request, at the very next sequence (the failed one used nothing up).
    await controller.sendAction('start', CONTROL_ID);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
    expect(sequencesOf(relay)).toEqual([...before, Math.max(...before) + 1]);
  });

  test('after a finished exchange: the refresh still succeeds and says nothing about a QR', async () => {
    const { controller } = await connectedPhone();
    saves.failSaves = 1;
    const status = await controller.refresh();
    expect(saves.failed).toBe(1);
    expect(status.state).toBe('online');
    expect(status.error).toBeNull();
  });

  test('a run of failures is its own notice, not an error, and the next stored save clears it', async () => {
    const { controller } = await connectedPhone();
    saves.failSaves = 100;
    for (let index = 0; index < 4; index += 1) await controller.refresh();
    const lagging = controller.status();
    expect(lagging.state).toBe('online');
    // Not `error`: that field gates the capability probe and a held request's outcome in the portal.
    expect(lagging.error).toBeNull();
    expect(lagging.persistLagging).toBe(true);
    saves.failSaves = 0;
    await controller.refresh();
    expect(controller.status().persistLagging).toBe(false);
  });

  test('the automatic pairing request whose save failed is sent by the next refresh, once', async () => {
    const { controller, seen } = await connectedPhone({ connect: false });
    saves.failSaves = 3;
    const failure = await controller.refresh().catch(error => error);
    expect(failure.code).toBe(REMOTE_CONTROL_LOCAL_SAVE_FAILED);
    expect(failure.message).toContain('저절로 다시 시도합니다');
    expect(requestsOf(seen, 'controller.pair')).toHaveLength(0);
    await controller.refresh();
    expect(requestsOf(seen, 'controller.pair')).toHaveLength(1);
    expect(controller.status().state).toBe('online');
  });

  test('saves land in the order they were made, even when an earlier one is slow', async () => {
    const savedSequences: number[] = [];
    let call = 0;
    // Every third save is slow, as one retried after an aborted IndexedDB transaction is.
    const { controller } = await connectedPhone({ savedSequences, saveDelay: () => (++call % 3 === 0 ? 20 : 0),
      // A tap waits for the poll with real (macrotask) sleeps, as in the portal.
      sleep: () => new Promise(resolve => setTimeout(resolve, 5)) });
    savedSequences.length = 0;
    await Promise.all([controller.refresh(), controller.sendAction('start', CONTROL_ID), controller.refresh()]);
    await controller.sendAction('start', CONTROL_ID);
    expect(savedSequences.length).toBeGreaterThan(3);
    expect(savedSequences).toEqual([...savedSequences].sort((a, b) => a - b));
    expect(savedSequences.at(-1)).toBe(controller.snapshot()!.sendSequence);
  });

  test('with saves working, every delivery is acknowledged as before', async () => {
    const { controller, relay } = await connectedPhone();
    relay.acknowledged.length = 0;
    await controller.sendAction('start', CONTROL_ID);
    expect(relay.acknowledged.at(-1)).toBe(relay.deliveries.at(-1)!.relaySequence);
  });

  test('an answer received while saves fail is not acknowledged; the next stored delivery acknowledges through it', async () => {
    const { controller, relay } = await connectedPhone();
    // The request is stored and sent; the Mac's answer is waiting in the relay before the phone reads it.
    const deliveredBefore = relay.deliveries.length;
    relay.acknowledged.length = 0;
    const realReceive = relay.receiveEnvelopes.bind(relay);
    // Saving starts failing exactly when the phone reads the answer (after the write-ahead save of the request).
    relay.receiveEnvelopes = async (...args) => { saves.failSaves = 1000; return realReceive(...args); };
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined);
    expect(relay.deliveries.length).toBe(deliveredBefore + 1);
    expect(saves.failed).toBeGreaterThan(0);
    expect(relay.acknowledged).toEqual([]);
    // Saving works again: the next delivery is stored and acknowledged, and the relay's ack is cumulative.
    relay.receiveEnvelopes = realReceive;
    saves.failSaves = 0;
    await controller.sendAction('start', CONTROL_ID);
    expect(relay.acknowledged.at(-1)).toBe(relay.deliveries.at(-1)!.relaySequence);
    expect(controller.status().error).toBeNull();
  });
});

describe('IndexedDB retry for transactions iOS aborted on suspension', () => {
  const transient = (code: string) => Object.assign(new Error(code), { code });
  const retryable = (error: unknown) => isTransientIndexedDbCode((error as { code?: unknown }).code);

  test('a transient failure is retried on a fresh attempt and then succeeds', async () => {
    const slept: number[] = [];
    let calls = 0;
    const value = await withIndexedDbRetry(async () => {
      calls += 1;
      if (calls < 3) throw transient('INDEXED_DB_FAILED');
      return 'stored';
    }, { retryable, sleep: async ms => { slept.push(ms); }, available: () => true });
    expect(value).toBe('stored');
    expect(calls).toBe(3);
    expect(slept).toEqual([...INDEXED_DB_RETRY_DELAYS_MS]);
  });

  test('it gives up after the bounded retries, and does not retry what a new connection cannot cure', async () => {
    let calls = 0;
    const always = await withIndexedDbRetry(async () => { calls += 1; throw transient('INDEXED_DB_BLOCKED'); },
      { retryable, sleep: async () => {}, available: () => true }).catch(error => error);
    expect(always.code).toBe('INDEXED_DB_BLOCKED');
    expect(calls).toBe(INDEXED_DB_RETRY_DELAYS_MS.length + 1);

    calls = 0;
    const malformed = await withIndexedDbRetry(async () => { calls += 1; throw transient('VAULT_CONTEXT_MISMATCH'); },
      { retryable, sleep: async () => {}, available: () => true }).catch(error => error);
    expect(malformed.code).toBe('VAULT_CONTEXT_MISMATCH');
    expect(calls).toBe(1);

    calls = 0;
    await withIndexedDbRetry(async () => { calls += 1; throw transient('INDEXED_DB_UNAVAILABLE'); },
      { retryable, sleep: async () => {}, available: () => false }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  test('the session vault retries reads only; the bootstrap vault (one write per scan) retries every operation', () => {
    const factoryOf = (file: string) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      const factory = source.slice(source.indexOf('export function createIndexedDb'));
      return factory.slice(0, factory.indexOf('\n}\n'));
    };
    const session = factoryOf('remoteControlRelaySessionVault.ts');
    // A retried write would put an older snapshot back after a newer one; the controller retries saves in order.
    expect(session.match(/retried\(/g)?.length).toBe(2);
    expect(session).toContain("retried(() => indexedDbRequest('readonly'");
    expect(session).not.toMatch(/retried\(\(\) => indexedDbRequest\('readwrite'/);
    expect(factoryOf('remoteControlRelayBootstrapVault.ts').match(/retried\(/g)?.length).toBe(5);
  });
});

describe('second review round (2026-10-16)', () => {
  test('one aborted save is cured by the controller retrying with the newest snapshot', async () => {
    const { controller, seen } = await connectedPhone();
    saves.failSaves = 1;
    await controller.sendAction('start', CONTROL_ID);
    expect(saves.failed).toBe(1);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
  });

  test('a save that never answers does not hold the controller: the next request and a disconnect still go through', async () => {
    let hang = false;
    const { controller, relay, seen } = await connectedPhone({ hangSave: () => { if (!hang) return false; hang = false; return true; } });
    hang = true;
    await controller.refresh(); // its save hangs once; the retry stores
    await controller.sendAction('start', CONTROL_ID);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
    let revoked = 0;
    relay.revoke = async () => { revoked += 1; };
    hang = true;
    await controller.revoke();
    expect(revoked).toBe(1);
  });

  test('a request whose save never answers is not sent, says so, and pressing again sends it once', async () => {
    let hangs = 0;
    const { controller, relay, seen } = await connectedPhone({ hangSave: () => { if (hangs <= 0) return false; hangs -= 1; return true; } });
    const attempts = relay.attempts;
    hangs = 3; // every attempt of the write-ahead save stays unanswered
    const failure = await controller.sendAction('start', CONTROL_ID).catch(error => error);
    expect(failure.code).toBe(REMOTE_CONTROL_LOCAL_SAVE_FAILED);
    expect(relay.attempts).toBe(attempts);
    expect(controller.snapshot()!.pendingOutbound).toBeNull();
    await controller.refresh();
    expect(requestsOf(seen, 'action.request')).toHaveLength(0); // nothing left over to send
    await controller.sendAction('start', CONTROL_ID);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
  });

  test('a failed claim save is not the end: the session goes on and the spent QR is dropped after the first stored save', async () => {
    let claimed = 0;
    const { controller, seen } = await connectedPhone({ connect: false, onClaimed: () => { claimed += 1; },
      beforeInitialize: () => { saves.failSaves = 3; } });
    expect(claimed).toBe(0);
    // Said as the save-lag notice, which stays until a save succeeds — not as an error the next poll clears.
    expect(controller.status().persistLagging).toBe(true);
    expect(controller.status().error ?? '').not.toContain('QR');
    await controller.refresh();
    expect(controller.status().state).toBe('online');
    expect(requestsOf(seen, 'controller.pair')).toHaveLength(1);
    expect(claimed).toBe(1);
    expect(controller.status().persistLagging).toBe(false);
  });

  test('a deferred onClaimed that never settles does not hold the save chain', async () => {
    const { controller, seen } = await connectedPhone({ connect: false, onClaimed: () => new Promise<void>(() => {}),
      beforeInitialize: () => { saves.failSaves = 3; } });
    await controller.refresh(); // stores, then starts onClaimed (never settles) without waiting for it
    expect(controller.status().state).toBe('online');
    expect(requestsOf(seen, 'controller.pair')).toHaveLength(1);
    await controller.sendAction('start', CONTROL_ID);
    expect(requestsOf(seen, 'action.request')).toHaveLength(1);
  });

  test('a background save failure does not replace an expired request\'s outcome', async () => {
    const clock = { now: start };
    const { controller, relay } = await connectedPhone({ clock });
    relay.network = 'down';
    await controller.sendAction('start', CONTROL_ID).catch(() => undefined); // held by the phone's network
    clock.now += 12 * 60_000; // past the 11-minute release of the held request
    relay.network = 'up';
    saves.failSaves = 100; // the checkpoint that replaces the expired envelope cannot be stored
    const failure = await controller.refresh().catch(error => error);
    expect(failure.code).toBe(REMOTE_CONTROL_LOCAL_SAVE_FAILED);
    const error = controller.status().error ?? '';
    expect(error).not.toBe('');
    expect(error).not.toContain('다음 단계를 잠시 미뤘습니다');
  });

  test('an extended capability probe dropped by a failed save is owed again', async () => {
    const { controller } = await connectedPhone();
    await controller.probeSupportedFeatures(false, false);
    expect(controller.capabilityProbeOwed()).toBe(false);
    saves.failSaves = 3;
    await controller.probeSupportedFeatures(false, true).catch(() => undefined);
    expect(controller.capabilityProbeOwed()).toBe(true);
  });
});
