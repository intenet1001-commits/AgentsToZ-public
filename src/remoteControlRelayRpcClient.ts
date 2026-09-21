import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  normalizeRemoteControlRelayId,
  parseRemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelope,
} from './remoteControlRelayContract';
import type {
  RemoteControlInternetHostRegistration,
  RemoteControlInternetHostTransport,
  RemoteControlInternetPairingRegistration,
  RemoteControlInternetPairingRow,
  RemoteControlInternetReceivedEnvelope,
  RemoteControlInternetRelayMessageType,
  RemoteControlInternetSessionRow,
} from './remoteControlInternetAgent';

export const REMOTE_CONTROL_RELAY_RPCS = {
  registerHost: 'portmgr_remote_control_register_host',
  renewHost: 'portmgr_remote_control_renew_host',
  createPairing: 'portmgr_remote_control_create_pairing',
  claimPairing: 'portmgr_remote_control_claim_pairing',
  hostListSessions: 'portmgr_remote_control_host_list_sessions',
  hostApproveSession: 'portmgr_remote_control_host_approve_session',
  hostRevokeSession: 'portmgr_remote_control_host_revoke_session',
  disableHost: 'portmgr_remote_control_disable_host',
  sessionStatus: 'portmgr_remote_control_session_status',
  revokeSession: 'portmgr_remote_control_revoke_session',
  ownerDisableHost: 'portmgr_remote_control_owner_disable_host',
  controllerSendMessage: 'portmgr_remote_control_controller_send_message',
  hostSendMessage: 'portmgr_remote_control_host_send_message',
  hostReceiveMessages: 'portmgr_remote_control_host_receive_messages',
  controllerReceiveMessages: 'portmgr_remote_control_controller_receive_messages',
  hostAckMessages: 'portmgr_remote_control_host_ack_messages',
  controllerAckMessages: 'portmgr_remote_control_controller_ack_messages',
  cleanup: 'portmgr_remote_control_cleanup',
} as const;

const REMOTE_CONTROL_RELAY_HOST_RPC_NAMES = new Set<string>([
  REMOTE_CONTROL_RELAY_RPCS.registerHost,
  REMOTE_CONTROL_RELAY_RPCS.renewHost,
  REMOTE_CONTROL_RELAY_RPCS.createPairing,
  REMOTE_CONTROL_RELAY_RPCS.hostListSessions,
  REMOTE_CONTROL_RELAY_RPCS.hostApproveSession,
  REMOTE_CONTROL_RELAY_RPCS.hostRevokeSession,
  REMOTE_CONTROL_RELAY_RPCS.disableHost,
  REMOTE_CONTROL_RELAY_RPCS.hostSendMessage,
  REMOTE_CONTROL_RELAY_RPCS.hostReceiveMessages,
  REMOTE_CONTROL_RELAY_RPCS.hostAckMessages,
  REMOTE_CONTROL_RELAY_RPCS.cleanup,
]);

const REMOTE_CONTROL_RELAY_CONTROLLER_RPC_NAMES = new Set<string>([
  REMOTE_CONTROL_RELAY_RPCS.claimPairing,
  REMOTE_CONTROL_RELAY_RPCS.sessionStatus,
  REMOTE_CONTROL_RELAY_RPCS.revokeSession,
  REMOTE_CONTROL_RELAY_RPCS.ownerDisableHost,
  REMOTE_CONTROL_RELAY_RPCS.controllerSendMessage,
  REMOTE_CONTROL_RELAY_RPCS.controllerReceiveMessages,
  REMOTE_CONTROL_RELAY_RPCS.controllerAckMessages,
]);

export interface RemoteControlRelayRpcInvoker {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export class RemoteControlRelayRpcError extends Error {
  constructor(
    readonly code: string,
    message = '외부 원격제어 릴레이 요청을 완료하지 못했습니다.',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RemoteControlRelayRpcError';
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return value as JsonObject;
}

function singleRow(value: unknown): JsonObject {
  if (!Array.isArray(value) || value.length !== 1) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return object(value[0]);
}

function rows(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length > 100) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return value.map(object);
}

function text(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  }
  return result;
}

function optionalUuidArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  }
  const parsed = value.map((entry, index) => uuid(entry, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  }
  return parsed;
}

function date(value: unknown, field: string): string {
  const raw = text(value, field, 64);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  return new Date(timestamp).toISOString();
}

function optionalDate(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : date(value, field);
}

function publicKey(value: unknown): string {
  const result = text(value, 'public key', 87);
  if (!/^[A-Za-z0-9_-]{87}$/.test(result)) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return result;
}

function fingerprint(value: unknown): string {
  const result = text(value, 'key fingerprint', 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(result)) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return result;
}

function decimal(value: unknown, field: string): string {
  const result = text(value, field, 19);
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(result)) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return result;
}

function sequence(value: unknown): number {
  const result = decimal(value, 'sender sequence');
  const parsed = Number(result);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`);
  }
  return value;
}

function approvalState(value: unknown): RemoteControlInternetSessionRow['approvalState'] {
  if (value !== 'pending' && value !== 'approved' && value !== 'revoked') {
    throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  }
  return value;
}

function rpcFailure(error: unknown): RemoteControlRelayRpcError {
  const raw = error && typeof error === 'object' ? error as JsonObject : {};
  const message = typeof raw.message === 'string' && raw.message.trim()
    ? raw.message.trim().slice(0, 240)
    : '외부 원격제어 릴레이 요청을 완료하지 못했습니다.';
  const known = message.match(/REMOTE_CONTROL_[A-Z0-9_]+/)?.[0] ?? '';
  return new RemoteControlRelayRpcError(known || 'RELAY_REQUEST_FAILED', message, error);
}

async function call(invoker: RemoteControlRelayRpcInvoker, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response: { data: unknown; error: unknown };
  try {
    response = await invoker.rpc(name, args);
  } catch (error) {
    throw new RemoteControlRelayRpcError('RELAY_CONNECTION_FAILED', undefined, error);
  }
  if (response.error) throw rpcFailure(response.error);
  return response.data;
}

function parseSessionRow(raw: JsonObject): RemoteControlInternetSessionRow {
  return {
    sessionId: uuid(raw.session_id, 'session_id'),
    pairingId: uuid(raw.pairing_id, 'pairing_id'),
    controllerId: uuid(raw.controller_id, 'controller_id'),
    controllerName: text(raw.controller_name, 'controller_name', 80),
    controllerPublicKey: publicKey(raw.controller_public_key),
    controllerKeyFingerprint: fingerprint(raw.controller_key_fingerprint),
    approvalState: approvalState(raw.approval_state),
    createdAt: date(raw.created_at, 'created_at'),
    expiresAt: date(raw.expires_at, 'expires_at'),
    approvedAt: optionalDate(raw.approved_at, 'approved_at'),
    revokedAt: optionalDate(raw.revoked_at, 'revoked_at'),
  };
}

function parseReceivedEnvelope(raw: JsonObject): RemoteControlInternetReceivedEnvelope {
  const sessionId = uuid(raw.session_id, 'session_id');
  const controllerId = uuid(raw.controller_id, 'controller_id');
  return {
    relaySequence: decimal(raw.relay_seq, 'relay_seq'),
    envelope: parseRemoteControlRelayEnvelope({
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
      messageId: uuid(raw.message_id, 'message_id'),
      sessionId,
      controllerId,
      sequence: sequence(raw.sender_sequence),
      expiresAt: date(raw.envelope_expires_at, 'envelope_expires_at'),
      nonce: text(raw.nonce, 'nonce', 16),
      ciphertext: text(raw.ciphertext, 'ciphertext', 21_846),
    }),
  };
}

export class RemoteControlRelayHostRpcTransport implements RemoteControlInternetHostTransport {
  readonly #rpc: RemoteControlRelayRpcInvoker;

  constructor(rpc: RemoteControlRelayRpcInvoker) {
    this.#rpc = rpc;
  }

  async renewHost(hostId: string, hostSecret: string, ttlSeconds: number): Promise<string> {
    const row = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.renewHost, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_ttl_seconds: ttlSeconds,
    }));
    if (uuid(row.host_id, 'host_id') !== hostId) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    return date(row.expires_at, 'expires_at');
  }

  async registerHost(input: RemoteControlInternetHostRegistration) {
    const row = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.registerHost, {
      p_host_id: input.hostId,
      p_display_name: input.hostName,
      p_public_key: input.hostPublicKey,
      p_host_secret: input.hostSecret,
      p_ttl_seconds: input.ttlSeconds,
    }));
    if (uuid(row.host_id, 'host_id') !== input.hostId) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    const registered = {
      expiresAt: date(row.expires_at, 'expires_at'),
      hostPublicKeyFingerprint: fingerprint(row.public_key_fingerprint),
    };
    try {
      const cleanup = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.cleanup, {
        p_limit: 500,
      }));
      nonnegativeInteger(cleanup.deleted_messages, 'deleted_messages');
      nonnegativeInteger(cleanup.deleted_sessions, 'deleted_sessions');
      nonnegativeInteger(cleanup.deleted_pairings, 'deleted_pairings');
      nonnegativeInteger(cleanup.deleted_hosts, 'deleted_hosts');
    } catch {
      // Registration is the bounded, no-cron cleanup trigger. Cleanup remains
      // best-effort so an older relay migration cannot disable a fresh session.
    }
    return registered;
  }

  async createPairing(input: RemoteControlInternetPairingRegistration): Promise<RemoteControlInternetPairingRow> {
    const row = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.createPairing, {
      p_host_id: input.hostId,
      p_host_secret: input.hostSecret,
      p_pairing_secret_hash: input.pairingSecretHash,
    }));
    return {
      pairingId: uuid(row.pairing_id, 'pairing_id'),
      expiresAt: date(row.expires_at, 'expires_at'),
      hostPublicKey: publicKey(row.host_public_key),
      hostPublicKeyFingerprint: fingerprint(row.host_public_key_fingerprint),
      retiredPairingIds: optionalUuidArray(row.retired_pairing_ids, 'retired_pairing_ids'),
    };
  }

  async listSessions(hostId: string, hostSecret: string): Promise<RemoteControlInternetSessionRow[]> {
    return rows(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostListSessions, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
    })).map(parseSessionRow);
  }

  async approveSession(hostId: string, hostSecret: string, sessionId: string): Promise<RemoteControlInternetSessionRow> {
    const approved = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostApproveSession, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_session_id: sessionId,
    }));
    const state = approvalState(approved.approval_state);
    if (state === 'revoked') {
      throw new RemoteControlRelayRpcError(
        'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED',
        'QR 연결 승인 시간이 만료되었습니다.',
      );
    }
    if (uuid(approved.session_id, 'session_id') !== sessionId || state !== 'approved') {
      throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    }
    const row = (await this.listSessions(hostId, hostSecret)).find(candidate => candidate.sessionId === sessionId);
    if (!row || row.approvalState !== 'approved') throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    return row;
  }

  async revokeSession(hostId: string, hostSecret: string, sessionId: string): Promise<void> {
    singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostRevokeSession, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_session_id: sessionId,
    }));
  }

  async disableHost(hostId: string, hostSecret: string): Promise<void> {
    singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.disableHost, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
    }));
  }

  async receiveEnvelopes(hostId: string, hostSecret: string, afterRelaySequence: string) {
    return rows(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostReceiveMessages, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_after_relay_seq: afterRelaySequence,
      p_limit: 100,
    })).map(parseReceivedEnvelope);
  }

  async sendEnvelope(
    hostId: string,
    hostSecret: string,
    sessionId: string,
    _messageType: RemoteControlInternetRelayMessageType,
    value: RemoteControlRelayEnvelope,
  ): Promise<void> {
    const envelope = parseRemoteControlRelayEnvelope(value);
    if (envelope.sessionId !== sessionId) throw new RemoteControlRelayRpcError('RELAY_ENVELOPE_CONTEXT_MISMATCH');
    singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostSendMessage, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_session_id: sessionId,
      p_controller_id: envelope.controllerId,
      p_message_id: envelope.messageId,
      p_sender_sequence: String(envelope.sequence),
      p_envelope_expires_at: envelope.expiresAt,
      p_nonce: envelope.nonce,
      p_ciphertext: envelope.ciphertext,
    }));
  }

  async acknowledge(hostId: string, hostSecret: string, sessionId: string, throughRelaySequence: string): Promise<void> {
    const data = await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.hostAckMessages, {
      p_host_id: hostId,
      p_host_secret: hostSecret,
      p_session_id: sessionId,
      p_through_relay_seq: throughRelaySequence,
    });
    if (!Number.isInteger(data) || (data as number) < 0) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  }
}

export interface RemoteControlRelayClaimResult {
  sessionId: string;
  controllerId: string;
  hostId: string;
  hostName: string;
  hostPublicKey: string;
  hostPublicKeyFingerprint: string;
  approvalState: 'pending';
  expiresAt: string;
}

export interface RemoteControlRelayControllerSessionStatus {
  sessionId: string;
  controllerId: string;
  approvalState: 'pending' | 'approved' | 'revoked';
  hostEnabled: boolean;
  hostExpiresAt: string;
  sessionExpiresAt: string;
  revokedAt: string | null;
  /**
   * When the Mac last spoke to the relay. Null on a sidecar that predates this
   * column — "unknown", never "asleep": guessing offline would block actions on
   * a Mac that is answering perfectly well.
   */
  hostLastSeenAt: string | null;
}

export class RemoteControlRelayControllerRpcClient {
  readonly #rpc: RemoteControlRelayRpcInvoker;

  constructor(rpc: RemoteControlRelayRpcInvoker) {
    this.#rpc = rpc;
  }

  async claimPairing(input: {
    pairingId: string;
    pairingSecret: string;
    controllerName: string;
    controllerPublicKey: string;
  }): Promise<RemoteControlRelayClaimResult> {
    const row = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.claimPairing, {
      p_pairing_id: input.pairingId,
      p_pairing_secret: input.pairingSecret,
      p_controller_name: input.controllerName,
      p_controller_public_key: input.controllerPublicKey,
    }));
    if (row.approval_state !== 'pending') throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    return {
      sessionId: uuid(row.session_id, 'session_id'),
      controllerId: uuid(row.controller_id, 'controller_id'),
      hostId: uuid(row.host_id, 'host_id'),
      hostName: text(row.host_name, 'host_name', 80),
      hostPublicKey: publicKey(row.host_public_key),
      hostPublicKeyFingerprint: fingerprint(row.host_public_key_fingerprint),
      approvalState: 'pending',
      expiresAt: date(row.expires_at, 'expires_at'),
    };
  }

  async status(hostId: string, sessionId: string): Promise<RemoteControlRelayControllerSessionStatus> {
    const row = singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.sessionStatus, {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
    if (typeof row.host_enabled !== 'boolean') throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
    return {
      sessionId: uuid(row.session_id, 'session_id'),
      controllerId: uuid(row.controller_id, 'controller_id'),
      approvalState: approvalState(row.approval_state),
      hostEnabled: row.host_enabled,
      hostExpiresAt: date(row.host_expires_at, 'host_expires_at'),
      sessionExpiresAt: date(row.session_expires_at, 'session_expires_at'),
      revokedAt: optionalDate(row.revoked_at, 'revoked_at'),
      hostLastSeenAt: row.host_last_seen_at === undefined
        ? null
        : optionalDate(row.host_last_seen_at, 'host_last_seen_at'),
    };
  }

  async sendEnvelope(hostId: string, sessionId: string, value: RemoteControlRelayEnvelope): Promise<void> {
    const envelope = parseRemoteControlRelayEnvelope(value);
    if (envelope.sessionId !== sessionId) throw new RemoteControlRelayRpcError('RELAY_ENVELOPE_CONTEXT_MISMATCH');
    singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.controllerSendMessage, {
      p_host_id: hostId,
      p_session_id: sessionId,
      p_controller_id: envelope.controllerId,
      p_message_id: envelope.messageId,
      p_sender_sequence: String(envelope.sequence),
      p_envelope_expires_at: envelope.expiresAt,
      p_nonce: envelope.nonce,
      p_ciphertext: envelope.ciphertext,
    }));
  }

  async receiveEnvelopes(hostId: string, sessionId: string, afterRelaySequence: string) {
    return rows(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.controllerReceiveMessages, {
      p_host_id: hostId,
      p_session_id: sessionId,
      p_after_relay_seq: afterRelaySequence,
      p_limit: 100,
    })).map(parseReceivedEnvelope);
  }

  async acknowledge(hostId: string, sessionId: string, throughRelaySequence: string): Promise<void> {
    const data = await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.controllerAckMessages, {
      p_host_id: hostId,
      p_session_id: sessionId,
      p_through_relay_seq: throughRelaySequence,
    });
    if (!Number.isInteger(data) || (data as number) < 0) throw new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID');
  }

  async revoke(hostId: string, sessionId: string): Promise<void> {
    singleRow(await call(this.#rpc, REMOTE_CONTROL_RELAY_RPCS.revokeSession, {
      p_host_id: hostId,
      p_session_id: sessionId,
    }));
  }
}

export function createServiceRoleRemoteControlRelayRpcInvoker(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): RemoteControlRelayRpcInvoker {
  const endpoint = new URL(input.supabaseUrl);
  const loopback = endpoint.hostname === 'localhost'
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '[::1]';
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
    || endpoint.username
    || endpoint.password) {
    throw new Error('invalid Supabase URL');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  endpoint.search = '';
  endpoint.hash = '';
  const fetcher = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8_000;
  return {
    async rpc(name, args) {
      if (!REMOTE_CONTROL_RELAY_HOST_RPC_NAMES.has(name)) {
        return { data: null, error: { message: 'REMOTE_CONTROL_RPC_NOT_ALLOWED' } };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = new URL(`${endpoint.toString().replace(/\/$/, '')}/rest/v1/rpc/${name}`);
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            apikey: input.serviceRoleKey,
            Authorization: `Bearer ${input.serviceRoleKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        return response.ok
          ? { data: payload, error: null }
          : { data: null, error: { status: response.status, ...(object(payload ?? {})) } };
      } catch (error) {
        return { data: null, error };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createSupabaseRemoteControlRelayRpcInvoker(client: {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}): RemoteControlRelayRpcInvoker {
  return {
    async rpc(name, args) {
      if (!REMOTE_CONTROL_RELAY_CONTROLLER_RPC_NAMES.has(name)) {
        return { data: null, error: { message: 'REMOTE_CONTROL_RPC_NOT_ALLOWED' } };
      }
      return client.rpc(name, args);
    },
  };
}

export function assertRemoteControlRelayContextId(value: unknown): string {
  return normalizeRemoteControlRelayId(value, 'relay context');
}
