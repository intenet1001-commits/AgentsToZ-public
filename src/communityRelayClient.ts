import {CommunityRelayTicket, communityAuthority, communityBase64,
  communityBytes, communityId, communityObject, type CommunityRelayPurpose} from './communityAccessClient';

export interface CommunityRelaySocket {
  send(text: string): void; close(code: number, reason: string): void;
  /** Native adapter must report actual queued bytes, not a constant zero. */
  readonly bufferedAmount: number;
}
export interface CommunityRelaySocketFactory {
  /** Header-capable native WebSocket. Register handlers before opening so the challenge cannot be lost. */
  open(input: {url: string; authorization: string; onMessage: (text: string) => void;
    onClose: () => void}): Promise<CommunityRelaySocket>;
}
export interface CommunityRelayProofSigner {
  readonly publicKey: string;
  signRelayProof(input: {ticketId: string; connectionId: string; challenge: string}): Promise<Uint8Array>;
}
export interface CommunityRelayRecord {
  from: string; fromConnection: string; id: string; ciphertext: string;
}
export interface CommunityRelayDelivery {
  /** A routing ACK does not prove peer receipt, decryption or execution. */
  stage: 'forwarded'; reachable: boolean; requestId: string;
}
export class CommunityRelayError extends Error {
  constructor(readonly code: string, readonly outcome: 'unsent' | 'unknown' = 'unsent') { super(code); this.name = 'CommunityRelayError'; }
}
interface Queued {
  to: string; id: string; wire: string; bytes: number; lane: 'control' | 'media'; coalesceKey?: string;
  resolve: (result: CommunityRelayDelivery) => void; reject: (error: CommunityRelayError) => void;
}
interface Sent {to: string; resolve: Queued['resolve']; reject: Queued['reject']; timer: ReturnType<typeof setTimeout>}
const encoder = new TextEncoder();

/**
 * Bounded ciphertext transport, never an authority or execution dispatcher.
 * The caller MUST verify a peer's issuer credential and signed ephemeral handshake,
 * then AEAD-bind community, both device IDs, purpose, connection epoch and request ID.
 * Relay-supplied `from` is a routing hint until that record layer verifies it.
 * This module deliberately has no plaintext send, key generation or route fallback.
 */
export class CommunityRelayClient {
  private socket?: CommunityRelaySocket;
  private ticket?: CommunityRelayTicket;
  private renewing?: CommunityRelayTicket;
  private connectionId = '';
  private generation = 0;
  private ready = false;
  private proofSent = false;
  private connecting = false;
  private stopped = true;
  private queues: Queued[] = [];
  private sent = new Map<string, Sent>();
  private used = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private resolveReady?: () => void;
  private rejectReady?: (error: CommunityRelayError) => void;
  private readonly origin: string;
  constructor(origin: string, private readonly identity: {
    communityId: string; enrollmentId: string; deviceId: string; purpose: CommunityRelayPurpose;
    role: 'host' | 'client'; sessionId: string | null;
  }, private readonly signer: CommunityRelayProofSigner, private readonly tickets: (connectionId: string) => Promise<CommunityRelayTicket>,
  private readonly sockets: CommunityRelaySocketFactory, private readonly onRecord: (record: CommunityRelayRecord) => void,
  private readonly onEnd: (reason: string) => void = () => {}, private readonly clock = Date.now,
  private readonly onPeerEnd: (peer: {from: string; fromConnection: string}) => void = () => {}) {
    this.origin = communityAuthority(origin).origin;
    if (![identity.communityId, identity.enrollmentId, identity.deviceId].every(communityId)
      || !(identity.sessionId === null || communityId(identity.sessionId))) throw new CommunityRelayError('INVALID_IDENTITY');
  }
  private validate(ticket: CommunityRelayTicket): void {
    if (!CommunityRelayTicket.isVerified(ticket) || !Object.entries({...this.identity, publicKey: this.signer.publicKey, connectionId: this.connectionId})
      .every(([key, value]) => ticket.body[key as keyof typeof ticket.body] === value)
      || ticket.body.expiresAt <= this.clock() || ticket.body.leaseExpiresAt <= this.clock()) throw new CommunityRelayError('INVALID_TICKET');
  }
  async connect(): Promise<void> {
    if (this.connecting || this.ready) throw new CommunityRelayError('ALREADY_CONNECTED');
    this.stopped = false; this.connecting = true; const generation = ++this.generation;
    this.connectionId = crypto.randomUUID(); this.used.clear(); this.proofSent = false;
    try {
      const ticket = await this.tickets(this.connectionId); if (generation !== this.generation) throw new CommunityRelayError('CONNECTION_ENDED');
      this.validate(ticket); this.ticket = ticket;
      const readiness = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      // Observe immediately, even if opening the adapter fails before the caller awaits it.
      void readiness.catch(() => {});
      this.leaseTimer = setTimeout(() => this.end('PROOF_TIMEOUT'), Math.min(10_000, ticket.body.expiresAt - this.clock()));
      let messages = Promise.resolve(); const early: string[] = [];
      const accept = (text: string) => {
        if (generation !== this.generation || this.stopped) return;
        if (!this.socket) { if (early.length >= 4) this.end('EARLY_FRAME_LIMIT'); else early.push(text); return; }
        messages = messages.then(() => generation === this.generation && !this.stopped ? this.receive(text) : undefined)
          .catch(() => { if (generation === this.generation) this.end('INVALID_RELAY_FRAME'); });
      };
      const socket = await this.sockets.open({url: `${this.origin.replace(/^https:/, 'wss:')}/relay`,
        authorization: `AgentsToZ ${ticket.envelope.payload}.${ticket.envelope.signature}`, onMessage: accept,
        onClose: () => { if (generation === this.generation) this.end('CONNECTION_ENDED'); }});
      if (generation !== this.generation || this.stopped) { socket.close(1000, 'Connection ended'); throw new CommunityRelayError('CONNECTION_ENDED'); }
      this.socket = socket; for (const message of early) accept(message);
      await readiness;
    } catch (error) { this.end('CONNECTION_FAILED'); throw error; }
    finally { if (generation === this.generation) this.connecting = false; }
  }
  private async receive(text: string): Promise<void> {
    if (this.stopped || !this.ticket || typeof text !== 'string' || encoder.encode(text).length > (this.identity.purpose === 'screen' ? 262_144 : 65_536))
      throw new CommunityRelayError('INVALID_FRAME');
    const frame: unknown = JSON.parse(text), type = (frame as {type?: unknown})?.type;
    if (type === 'challenge' && !this.ready && !this.proofSent) {
      const value = communityObject(frame, ['type', 'ticketId', 'connectionId', 'challenge']);
      if (value.ticketId !== this.ticket.body.ticketId || value.connectionId !== this.connectionId || communityBytes(value.challenge, 32).length !== 32)
        throw new CommunityRelayError('INVALID_CHALLENGE');
      const generation = this.generation;
      this.proofSent = true;
      const signature = await this.signer.signRelayProof({ticketId: value.ticketId as string, connectionId: this.connectionId, challenge: value.challenge as string});
      if (generation !== this.generation || this.stopped || this.ticket.body.expiresAt <= this.clock()) return;
      if (signature.length !== 64) throw new CommunityRelayError('INVALID_NATIVE_PROOF');
      this.socket?.send(JSON.stringify({type: 'proof', signature: communityBase64(signature)})); return;
    }
    if (type === 'ready' && !this.ready && this.proofSent) {
      const value = communityObject(frame, ['type', 'connectionId', 'leaseExpiresAt']);
      if (value.connectionId !== this.connectionId || value.leaseExpiresAt !== this.ticket.body.leaseExpiresAt) throw new CommunityRelayError('INVALID_LEASE');
      this.ready = true; this.connecting = false; this.armLease(this.ticket); this.resolveReady?.(); this.resolveReady = undefined; this.rejectReady = undefined; this.flush(); return;
    }
    if (!this.ready || this.ticket.body.leaseExpiresAt <= this.clock()) throw new CommunityRelayError('LEASE_EXPIRED');
    if (type === 'authorized') {
      const value = communityObject(frame, ['type', 'leaseExpiresAt']);
      if (!this.renewing || value.leaseExpiresAt !== this.renewing.body.leaseExpiresAt) throw new CommunityRelayError('UNEXPECTED_RENEWAL');
      this.ticket = this.renewing; this.renewing = undefined; this.armLease(this.ticket); return;
    }
    if (type === 'forwarded') {
      const value = communityObject(frame, ['type', 'id', 'reachable']);
      if (!communityId(value.id) || typeof value.reachable !== 'boolean') throw new CommunityRelayError('INVALID_ACK');
      const pending = this.sent.get(value.id); if (!pending) return; // Late/duplicate ACK cannot revive a settled request or break another peer.
      clearTimeout(pending.timer); this.sent.delete(value.id); pending.resolve({stage: 'forwarded', reachable: value.reachable, requestId: value.id}); this.flush(); return;
    }
    if (type === 'peer-ended') {
      const value = communityObject(frame, ['type', 'from', 'fromConnection']);
      if (!communityId(value.from) || !communityId(value.fromConnection)) throw new CommunityRelayError('INVALID_PEER_END');
      this.onPeerEnd({from: value.from, fromConnection: value.fromConnection}); return;
    }
    const value = communityObject(frame, ['type', 'from', 'fromConnection', 'id', 'ciphertext']);
    if (value.type !== 'data' || !communityId(value.from) || value.from === this.identity.deviceId || !communityId(value.fromConnection)
      || !communityId(value.id) || !communityBytes(value.ciphertext, this.identity.purpose === 'screen' ? 262_144 : 65_536).length) throw new CommunityRelayError('INVALID_RECORD');
    this.onRecord({from: value.from, fromConnection: value.fromConnection, id: value.id, ciphertext: value.ciphertext as string});
  }
  private armLease(ticket: CommunityRelayTicket): void {
    clearTimeout(this.leaseTimer); clearTimeout(this.renewalTimer);
    const remaining = ticket.body.leaseExpiresAt - this.clock(); if (remaining <= 0) { this.end('LEASE_EXPIRED'); return; }
    this.leaseTimer = setTimeout(() => this.end('LEASE_EXPIRED'), remaining);
    const generation = this.generation;
    this.renewalTimer = setTimeout(() => { void (async () => {
      try {
        const next = await this.tickets(this.connectionId);
        if (generation !== this.generation || this.stopped) return;
        this.validate(next);
        if (!this.ready || this.ticket!.body.leaseExpiresAt <= this.clock() || next.body.revision < this.ticket!.body.revision) throw new CommunityRelayError('LEASE_EXPIRED');
        this.renewing = next; this.socket?.send(JSON.stringify({type: 'authorize', ticket: next.envelope}));
      } catch { if (generation === this.generation) this.end('RENEWAL_FAILED'); }
    })(); }, Math.max(1, Math.min(60_000, remaining * 2 / 3)));
  }
  /** Queue only an authenticated encrypted record. Never reuse an ID for a second operation or replay unknown outcomes. */
  sendRecord(input: {to: string; id: string; ciphertext: string; lane?: 'control' | 'media'; coalesceKey?: string}): Promise<CommunityRelayDelivery> {
    if (!this.ready || this.stopped || this.ticket!.body.leaseExpiresAt <= this.clock()) return Promise.reject(new CommunityRelayError('NOT_READY'));
    const lane = input.lane ?? 'control';
    if (!['control', 'media'].includes(lane) || !communityId(input.to) || input.to === this.identity.deviceId || !communityId(input.id) || this.used.has(input.id)
      || (input.coalesceKey !== undefined && (lane !== 'media' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.coalesceKey)))) return Promise.reject(new CommunityRelayError('INVALID_RECORD'));
    const wire = JSON.stringify({type: 'data', to: input.to, id: input.id, ciphertext: input.ciphertext}), bytes = encoder.encode(wire).length;
    try { communityBytes(input.ciphertext, this.identity.purpose === 'screen' ? 262_144 : 65_536); }
    catch { return Promise.reject(new CommunityRelayError('INVALID_RECORD')); }
    if (bytes > (this.identity.purpose === 'screen' ? 262_144 : 65_536)) return Promise.reject(new CommunityRelayError('FRAME_TOO_LARGE'));
    if (input.coalesceKey) {
      const prior = this.queues.find(q => q.to === input.to && q.lane === 'media' && q.coalesceKey === input.coalesceKey);
      if (prior) { this.queues.splice(this.queues.indexOf(prior), 1); prior.reject(new CommunityRelayError('SUPERSEDED')); }
    }
    const same = this.queues.filter(q => q.to === input.to && q.lane === lane);
    if (same.length >= (lane === 'control' ? 32 : 8) || same.reduce((sum, q) => sum + q.bytes, bytes) > (lane === 'control' ? 256_000 : 1_048_576)
      || this.queues.length >= 256 || this.queues.reduce((sum, q) => sum + q.bytes, bytes) > 8_388_608 || this.used.size >= 65_536)
      return Promise.reject(new CommunityRelayError('QUEUE_FULL'));
    this.used.add(input.id);
    return new Promise((resolve, reject) => { this.queues.push({to: input.to, id: input.id, wire, bytes, lane, coalesceKey: input.coalesceKey, resolve, reject}); this.flush(); });
  }
  private flush(): void {
    clearTimeout(this.flushTimer); if (!this.ready || this.stopped || !this.socket || this.renewing) return;
    while (this.queues.length && this.sent.size < 32) {
      if (this.socket.bufferedAmount > 262_144) break;
      // An offline peer cannot consume all 32 in-flight slots. Control/key-up are never coalesced or dropped.
      const eligible = (q: Queued) => [...this.sent.values()].filter(s => s.to === q.to).length < 4;
      const next = this.queues.find(q => q.lane === 'control' && eligible(q)) ?? this.queues.find(eligible); if (!next) break;
      this.queues.splice(this.queues.indexOf(next), 1);
      const timer = setTimeout(() => { const pending = this.sent.get(next.id); if (!pending) return;
        this.sent.delete(next.id); pending.reject(new CommunityRelayError('DELIVERY_UNCONFIRMED', 'unknown')); this.flush(); }, 5_000);
      this.sent.set(next.id, {to: next.to, resolve: next.resolve, reject: next.reject, timer});
      try { this.socket.send(next.wire); } catch { this.end('SEND_FAILED'); return; }
    }
    if (this.queues.length) this.flushTimer = setTimeout(() => this.flush(), 20);
  }
  close(): void { this.end('CLOSED'); }
  private end(reason: string): void {
    if (this.stopped) return; this.stopped = true; this.ready = false; this.connecting = false; ++this.generation;
    clearTimeout(this.flushTimer); clearTimeout(this.renewalTimer); clearTimeout(this.leaseTimer);
    this.rejectReady?.(new CommunityRelayError(reason)); this.rejectReady = undefined; this.resolveReady = undefined;
    const socket = this.socket; this.socket = undefined; this.ticket = undefined; this.renewing = undefined;
    for (const queued of this.queues.splice(0)) queued.reject(new CommunityRelayError(reason));
    for (const pending of this.sent.values()) { clearTimeout(pending.timer); pending.reject(new CommunityRelayError(reason, 'unknown')); } this.sent.clear();
    try { socket?.close(1000, 'Connection ended'); } catch { /* Native socket may already be closed. */ }
    try { this.onEnd(reason); } catch { /* Consumer reporting must not retain timers or a native connection. */ }
  }
}
