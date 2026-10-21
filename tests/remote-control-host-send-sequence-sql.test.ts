/**
 * The relay host's send sequence across a process that ends mid-send, against the canonical relay SQL (PGlite)
 * with the real host agent and the real host/phone RPC transports — not a double.
 *
 * 1호, 2026-10-09: an app update quit the sidecar right after it sent 10254 and before it saved it. The new process
 * sealed 10254 again; the relay refused it (DEDUPE_MISMATCH while the row is kept, REPLAYED once it is gone) on
 * every poll, every phone of that Mac said 「응답 없음」 and the requests behind it never ran. Once the relay's
 * cleanup deletes rows it accepts a reused number silently, and the phone, which already saw it, drops it as stale.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { REMOTE_CONTROL_RELAY_SQL } from '../src/remoteControlRelaySql';
import {
  RemoteControlRelayControllerRpcClient,
  RemoteControlRelayHostRpcTransport,
  type RemoteControlRelayRpcInvoker,
} from '../src/remoteControlRelayRpcClient';
import { REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP, RemoteControlInternetAgent } from '../src/remoteControlInternetAgent';
import { REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteControlGateway } from '../src/remoteControlCore';
import type { RemoteControlHostRecord } from '../src/remoteControlHostVault';
import { REMOTE_CONTROL_RELAY_SCHEMA_VERSION, acceptRemoteControlRelayEnvelope, createRemoteControlRelayReceiveCursor, parseRemoteControlRelayPairingUrl } from '../src/remoteControlRelayContract';
import {
  decryptRemoteControlRelayEnvelope, deriveRemoteControlRelaySessionKey, encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey, generateRemoteControlRelayKeyPair, importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto';

const enc = new TextEncoder(), dec = new TextDecoder();
const userId = '99999999-9999-4999-8999-999999999999';

async function db() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create schema extensions; create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users(id) values ('${userId}');
    create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function public.portmgr_is_member() returns boolean language sql stable as $$ select true $$;`);
  await pg.exec(REMOTE_CONTROL_RELAY_SQL);
  return pg;
}

function invoker(pg: PGlite, role: 'service_role' | 'authenticated'): RemoteControlRelayRpcInvoker {
  return {
    async rpc(name, args) {
      const keys = Object.keys(args);
      try {
        await pg.query(`select set_config('request.jwt.claim.role', $1, false), set_config('request.jwt.claim.sub', $2, false)`, [role, role === 'authenticated' ? userId : '']);
        const result = await pg.query<Record<string, unknown>>(
          `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`,
          keys.map(k => args[k] as never),
        );
        const fix = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
        const rows = result.rows.map(fix);
        const columns = result.fields.map(f => f.name);
        if (columns.length === 1 && columns[0] === name) return { data: rows[0]?.[name] ?? null, error: null };
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

function gateway(executions: string[]): RemoteControlGateway {
  return {
    listRegisteredProjects: () => [{ internalId: 'p', name: '프로젝트', port: 4317, kind: 'main' as const, folderPath: '/x', command: 'x', status: 'stopped' as const, actions: ['start' as const] }],
    executeRegisteredProjectAction: async request => { executions.push(request.actionId); },
  };
}

async function setupPaired() {
  const pg = await db();
  const host = new RemoteControlRelayHostRpcTransport(invoker(pg, 'service_role'));
  const phoneRpc = new RemoteControlRelayControllerRpcClient(invoker(pg, 'authenticated'));
  const executions: string[] = [];
  let stored: RemoteControlHostRecord | null = null;
  const first = new RemoteControlInternetAgent({
    gateway: gateway(executions), transport: host, controllerOrigin: 'https://controller.example.test', hostName: '테스트 Mac',
    autoPoll: false, onRecordChanged: r => { if (r) stored = structuredClone(r); },
  });
  const qr = parseRemoteControlRelayPairingUrl((await first.initialize()).pairingUrl);
  // The owner must exist for the host; claim_pairing binds owner_user_id on first claim.
  const phone = await generateRemoteControlRelayKeyPair();
  const phonePublicKey = await exportRemoteControlRelayPublicKey(phone.publicKey);
  const claim = await phoneRpc.claimPairing({ pairingId: qr.bootstrap.pairingId, pairingSecret: qr.bootstrap.pairingSecret, controllerName: '내 iPhone', controllerPublicKey: phonePublicKey });
  const hostPublic = await importRemoteControlRelayPublicKey(qr.bootstrap.hostPublicKey);
  const phoneSend = await deriveRemoteControlRelaySessionKey({ privateKey: phone.privateKey, peerPublicKey: hostPublic, sessionId: claim.sessionId, controllerId: claim.controllerId, direction: 'controller-to-host', usages: ['encrypt'] });
  const phoneRecv = await deriveRemoteControlRelaySessionKey({ privateKey: phone.privateKey, peerPublicKey: hostPublic, sessionId: claim.sessionId, controllerId: claim.controllerId, direction: 'host-to-controller', usages: ['decrypt'] });
  await first.pollNow();
  await first.approveSession(claim.sessionId, first.status().sessions[0]!.sasCode!);
  let phoneSeq = 0;
  const fromPhone = async (payload: unknown) => {
    phoneSeq += 1;
    const envelope = await encryptRemoteControlRelayEnvelope({ key: phoneSend, metadata: { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: crypto.randomUUID(), sessionId: claim.sessionId, controllerId: claim.controllerId, sequence: phoneSeq, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() }, plaintext: enc.encode(JSON.stringify(payload)), now: Date.now() });
    await phoneRpc.sendEnvelope(claim.hostId, claim.sessionId, envelope);
  };
  const phoneInbox = async () => {
    const got = await phoneRpc.receiveEnvelopes(claim.hostId, claim.sessionId, '0');
    return Promise.all(got.map(async d => ({ seq: d.envelope.sequence, body: JSON.parse(dec.decode(await decryptRemoteControlRelayEnvelope({ key: phoneRecv, envelope: d.envelope, now: Date.now() }))) })));
  };
  await fromPhone({ type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token: qr.bootstrap.pairingSecret });
  await first.pollNow();
  const beforeAction = structuredClone(stored!);
  const ready = (await phoneInbox()).at(-1)!.body;
  await fromPhone({ type: 'action.request', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken, actionId: 'before-restart', action: 'start', controlId: ready.projects[0].controlId, remoteConfirmed: true });
  await first.pollNow();
  return { pg, host, phoneRpc: () => phoneRpc, executions, getStored: () => stored!, beforeAction, fromPhone, phoneInbox, claim, first, ready };
}


async function restartFrom(h: Awaited<ReturnType<typeof setupPaired>>, record: RemoteControlHostRecord) {
  const second = new RemoteControlInternetAgent({
    gateway: gateway(h.executions), transport: h.host, controllerOrigin: 'https://controller.example.test', hostName: '테스트 Mac',
    autoPoll: false, restore: record, onRecordChanged: () => {},
  });
  await second.restore();
  return second;
}
async function polls(agent: RemoteControlInternetAgent, count: number) {
  const outcomes: string[] = [];
  const warn = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < count; i += 1) {
      try { await agent.pollNow(); outcomes.push('ok'); }
      catch (error) { outcomes.push(String((error as {code?: string}).code ?? (error as Error).message)); }
    }
  } finally { console.warn = warn; }
  return outcomes;
}
/** What the phone (cursor at `seen`) makes of every host message after it. */
async function phoneVerdicts(h: Awaited<ReturnType<typeof setupPaired>>, seen: number) {
  const after = await h.phoneRpc().receiveEnvelopes(h.claim.hostId, h.claim.sessionId, '0');
  const cursor = {...createRemoteControlRelayReceiveCursor(h.claim.sessionId, h.claim.controllerId), highestSequence: seen};
  return after.map(d => ({sequence: d.envelope.sequence, verdict: (() => { const r = acceptRemoteControlRelayEnvelope(d.envelope, cursor, Date.now()); return r.ok ? 'ok' : r.reason; })()}));
}
const oneBehind = (h: Awaited<ReturnType<typeof setupPaired>>, record: RemoteControlHostRecord, sequence: number) => {
  const copy = structuredClone(record);
  copy.sessions = copy.sessions.map(s => s.sessionId === h.claim.sessionId ? {...s, sendSequence: sequence} : s);
  return copy;
};

describe('a restart never reuses a send sequence (real relay SQL)', () => {
  test('the incident: the record one behind while the relay keeps that row — the first poll already succeeds', async () => {
    const h = await setupPaired();
    try {
      const lastSent = (await h.phoneInbox()).at(-1)!.seq;
      const second = await restartFrom(h, oneBehind(h, h.getStored(), lastSent - 1));
      expect(await polls(second, 3)).toEqual(['ok', 'ok', 'ok']);
      const inbox = await h.phoneInbox();
      const ready = inbox.filter(m => m.seq > lastSent);
      expect(ready.map(m => m.body.type)).toEqual(['session.ready']);
      expect(ready[0]!.seq).toBe(lastSent + REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP);
    } finally { await h.pg.close(); }
  });

  for (const lag of [0, 1, 2]) {
    test(`a process that ended after sending a result, before saving (lag ${lag}): no poll fails and nothing runs twice`, async () => {
      const h = await setupPaired();
      try {
        await h.pg.exec(`update public.portmgr_remote_control_messages set acknowledged_at = null where direction = 'controller_to_host'`);
        const record = structuredClone(h.beforeAction);
        record.sessions = record.sessions.map(s => ({...s, sendSequence: Math.max(0, s.sendSequence - (lag - 1))}));
        const second = await restartFrom(h, record);
        expect(await polls(second, 4)).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(h.executions).toEqual(['before-restart']);
      } finally { await h.pg.close(); }
    });
  }

  test('after the relay cleaned up its rows, the restart still sends past every number the phone saw', async () => {
    const h = await setupPaired();
    try {
      const lastSent = (await h.phoneInbox()).at(-1)!.seq;
      await h.pg.exec(`update public.portmgr_remote_control_messages set acknowledged_at = now() - interval '2 minutes' where direction = 'host_to_controller'`);
      await h.pg.query(`select set_config('request.jwt.claim.role','service_role',false)`);
      await h.pg.query(`select * from public.portmgr_remote_control_cleanup(500)`);
      const left = await h.pg.query<{n: number}>(`select count(*)::int n from public.portmgr_remote_control_messages where direction = 'host_to_controller'`);
      expect(left.rows[0]!.n).toBe(0);                               // nothing left for the relay to refuse
      const second = await restartFrom(h, oneBehind(h, h.getStored(), lastSent - 1));
      expect(await polls(second, 1)).toEqual(['ok']);
      const verdicts = await phoneVerdicts(h, lastSent);
      expect(verdicts.length).toBeGreaterThan(0);
      for (const v of verdicts) expect(['ok', 'sequence-gap']).toContain(v.verdict);   // never 'stale-sequence'
    } finally { await h.pg.close(); }
  });
});
