import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';
import {
  REMOTE_CONTROL_RELAY_RPCS,
  RemoteControlRelayControllerRpcClient,
  RemoteControlRelayHostRpcTransport,
  createServiceRoleRemoteControlRelayRpcInvoker,
  createSupabaseRemoteControlRelayRpcInvoker,
  type RemoteControlRelayRpcInvoker,
} from '../src/remoteControlRelayRpcClient';

class FakeRpc implements RemoteControlRelayRpcInvoker {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  responses = new Map<string, unknown>();
  async rpc(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return { data: this.responses.get(name) ?? [], error: null };
  }
}

const hostId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const controllerId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const expiresAt = '2099-08-30T12:05:00.000Z';
const publicKey = encodeRemoteControlRelayBase64Url(Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index));
const fingerprint = encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(9));
const nonce = encodeRemoteControlRelayBase64Url(new Uint8Array(12).fill(2));
const ciphertext = encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(3));

describe('exact Supabase relay RPC adapters', () => {
  test('maps host registration, session rows, envelopes, and separate relay/sender cursors exactly', async () => {
    const rpc = new FakeRpc();
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.registerHost, [{
      host_id: hostId,
      expires_at: '2099-08-30T12:30:00+00:00',
      public_key_fingerprint: fingerprint,
    }]);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.cleanup, [{
      deleted_messages: 4,
      deleted_sessions: 3,
      deleted_pairings: 2,
      deleted_hosts: 1,
    }]);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.createPairing, [{
      pairing_id: hostId,
      expires_at: '2099-08-30T12:30:00+00:00',
      host_public_key: publicKey,
      host_public_key_fingerprint: fingerprint,
      retired_pairing_ids: [sessionId],
    }]);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.hostReceiveMessages, [{
      relay_seq: '91',
      message_id: messageId,
      session_id: sessionId,
      controller_id: controllerId,
      direction: 'controller_to_host',
      sender_sequence: '7',
      envelope_expires_at: '2099-08-30T12:05:00+00:00',
      nonce,
      ciphertext,
      created_at: '2099-08-30T12:00:00+00:00',
    }]);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.hostListSessions, [{
      session_id: sessionId,
      pairing_id: hostId,
      controller_id: controllerId,
      controller_name: '내 iPhone',
      controller_public_key: publicKey,
      controller_key_fingerprint: fingerprint,
      approval_state: 'pending',
      created_at: '2099-08-30T12:00:00+00:00',
      expires_at: '2099-08-30T12:30:00+00:00',
      approved_at: null,
      revoked_at: null,
    }]);
    const transport = new RemoteControlRelayHostRpcTransport(rpc);
    expect(await transport.registerHost({
      hostId,
      hostSecret: 'S'.repeat(43),
      hostName: '이 Mac',
      hostPublicKey: publicKey,
      ttlSeconds: 1800,
    })).toEqual({
      expiresAt: '2099-08-30T12:30:00.000Z',
      hostPublicKeyFingerprint: fingerprint,
    });
    expect(rpc.calls.slice(0, 2)).toEqual([
      {
        name: REMOTE_CONTROL_RELAY_RPCS.registerHost,
        args: {
          p_host_id: hostId,
          p_display_name: '이 Mac',
          p_public_key: publicKey,
          p_host_secret: 'S'.repeat(43),
          p_ttl_seconds: 1800,
        },
      },
      {
        name: REMOTE_CONTROL_RELAY_RPCS.cleanup,
        args: { p_limit: 500 },
      },
    ]);
    const deliveries = await transport.receiveEnvelopes(hostId, 'S'.repeat(43), '90');
    expect(deliveries).toEqual([{
      relaySequence: '91',
      envelope: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId,
        sessionId,
        controllerId,
        sequence: 7,
        expiresAt,
        nonce,
        ciphertext,
      },
    }]);
    expect(rpc.calls.at(-1)).toEqual({
      name: REMOTE_CONTROL_RELAY_RPCS.hostReceiveMessages,
      args: {
        p_host_id: hostId,
        p_host_secret: 'S'.repeat(43),
        p_after_relay_seq: '90',
        p_limit: 100,
      },
    });
    expect(await transport.listSessions(hostId, 'S'.repeat(43))).toMatchObject([{
      sessionId,
      pairingId: hostId,
      controllerId,
    }]);
    expect(await transport.createPairing({
      hostId,
      hostSecret: 'S'.repeat(43),
      pairingSecretHash: 'a'.repeat(64),
    })).toEqual({
      pairingId: hostId,
      expiresAt: '2099-08-30T12:30:00.000Z',
      hostPublicKey: publicKey,
      hostPublicKeyFingerprint: fingerprint,
      retiredPairingIds: [sessionId],
    });
  });

  test('validates retired pairing ids and tolerates an older relay omitting the field', async () => {
    const rpc = new FakeRpc();
    const base = {
      pairing_id: hostId,
      expires_at: '2099-08-30T12:30:00+00:00',
      host_public_key: publicKey,
      host_public_key_fingerprint: fingerprint,
    };
    const transport = new RemoteControlRelayHostRpcTransport(rpc);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.createPairing, [base]);
    expect((await transport.createPairing({
      hostId,
      hostSecret: 'S'.repeat(43),
      pairingSecretHash: 'a'.repeat(64),
    })).retiredPairingIds).toEqual([]);

    for (const retired_pairing_ids of [
      [sessionId, sessionId],
      ['not-a-uuid'],
      Array.from({ length: 9 }, () => sessionId),
    ]) {
      rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.createPairing, [{ ...base, retired_pairing_ids }]);
      await expect(transport.createPairing({
        hostId,
        hostSecret: 'S'.repeat(43),
        pairingSecretHash: 'a'.repeat(64),
      })).rejects.toMatchObject({ code: 'RELAY_RESPONSE_INVALID' });
    }
  });

  test('maps authenticated claim and sends only the exact encrypted envelope fields', async () => {
    const rpc = new FakeRpc();
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.claimPairing, [{
      session_id: sessionId,
      controller_id: controllerId,
      host_id: hostId,
      host_name: '이 Mac',
      host_public_key: publicKey,
      host_public_key_fingerprint: fingerprint,
      approval_state: 'pending',
      expires_at: '2099-08-30T12:30:00+00:00',
    }]);
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.controllerSendMessage, [{
      message_id: messageId,
      relay_seq: '1',
      duplicate: false,
      sender_sequence: '1',
      envelope_expires_at: expiresAt,
    }]);
    const controller = new RemoteControlRelayControllerRpcClient(rpc);
    expect(await controller.claimPairing({
      pairingId: hostId,
      pairingSecret: 'P'.repeat(43),
      controllerName: '내 iPhone',
      controllerPublicKey: publicKey,
    })).toMatchObject({ sessionId, controllerId, hostId, approvalState: 'pending' });
    await controller.sendEnvelope(hostId, sessionId, {
      schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
      messageId,
      sessionId,
      controllerId,
      sequence: 1,
      expiresAt,
      nonce,
      ciphertext,
    });
    expect(rpc.calls.at(-1)).toEqual({
      name: REMOTE_CONTROL_RELAY_RPCS.controllerSendMessage,
      args: {
        p_host_id: hostId,
        p_session_id: sessionId,
        p_controller_id: controllerId,
        p_message_id: messageId,
        p_sender_sequence: '1',
        p_envelope_expires_at: expiresAt,
        p_nonce: nonce,
        p_ciphertext: ciphertext,
      },
    });
    expect(JSON.stringify(rpc.calls.at(-1))).not.toContain('project');
    expect(JSON.stringify(rpc.calls.at(-1))).not.toContain('command');
  });

  test('keeps browser and service-role authority in separate constructors', () => {
    const source = readFileSync(new URL('../src/remoteControlRelayRpcClient.ts', import.meta.url), 'utf8');
    const controllerClass = source.slice(
      source.indexOf('export class RemoteControlRelayControllerRpcClient'),
      source.indexOf('export function createServiceRoleRemoteControlRelayRpcInvoker'),
    );
    expect(controllerClass).not.toContain('serviceRoleKey');
    expect(controllerClass).not.toContain('Authorization:');
    expect(controllerClass).not.toContain('registerHost(');
  });

  test('fails closed before transport when a caller crosses the host/controller RPC boundary', async () => {
    let serviceFetches = 0;
    const hostInvoker = createServiceRoleRemoteControlRelayRpcInvoker({
      supabaseUrl: 'https://relay.example.test',
      serviceRoleKey: 'server-only',
      fetch: (async () => {
        serviceFetches += 1;
        return Response.json([]);
      }) as unknown as typeof fetch,
    });
    const hostCrossing = await hostInvoker.rpc(REMOTE_CONTROL_RELAY_RPCS.claimPairing, {});
    expect(hostCrossing.error).toEqual({ message: 'REMOTE_CONTROL_RPC_NOT_ALLOWED' });
    expect(serviceFetches).toBe(0);

    const browserCalls: string[] = [];
    const controllerInvoker = createSupabaseRemoteControlRelayRpcInvoker({
      async rpc(name: string) {
        browserCalls.push(name);
        return { data: [], error: null };
      },
    });
    const controllerCrossing = await controllerInvoker.rpc(REMOTE_CONTROL_RELAY_RPCS.registerHost, {});
    expect(controllerCrossing.error).toEqual({ message: 'REMOTE_CONTROL_RPC_NOT_ALLOWED' });
    const controllerCleanup = await controllerInvoker.rpc(REMOTE_CONTROL_RELAY_RPCS.cleanup, {});
    expect(controllerCleanup.error).toEqual({ message: 'REMOTE_CONTROL_RPC_NOT_ALLOWED' });
    expect(browserCalls).toEqual([]);
  });

  test('surfaces a committed expired approval as a pairing-expired error', async () => {
    const rpc = new FakeRpc();
    rpc.responses.set(REMOTE_CONTROL_RELAY_RPCS.hostApproveSession, [{
      session_id: sessionId,
      controller_id: controllerId,
      approval_state: 'revoked',
      controller_public_key: publicKey,
      controller_key_fingerprint: fingerprint,
      approved_at: null,
      expires_at: expiresAt,
    }]);
    const transport = new RemoteControlRelayHostRpcTransport(rpc);
    await expect(transport.approveSession(hostId, 'S'.repeat(43), sessionId))
      .rejects.toMatchObject({ code: 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED' });
  });

  test('never sends the service role over credentialed or non-loopback plaintext HTTP', () => {
    for (const supabaseUrl of [
      'http://relay.example.test',
      'http://user:password@127.0.0.1:54321',
      'https://user:password@relay.example.test',
    ]) {
      expect(() => createServiceRoleRemoteControlRelayRpcInvoker({
        supabaseUrl,
        serviceRoleKey: 'server-only',
      })).toThrow('invalid Supabase URL');
    }
    expect(() => createServiceRoleRemoteControlRelayRpcInvoker({
      supabaseUrl: 'http://127.0.0.1:54321',
      serviceRoleKey: 'server-only',
    })).not.toThrow();
  });
});
