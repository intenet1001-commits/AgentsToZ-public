/**
 * w2-followups #16: a whole-request submission survives the phone's socket dropping right after the commit.
 *
 * Real LAN listener, real WebSocket, real terminal service with a real PTY and the real receipt journal. The phone
 * submits one request, the CLI runs it, and the socket drops before the answer is read (a locked iPhone). The phone
 * restores its session — a new management id, the same controller — and asks for the status: the receipt says
 * written, and asking again (or resending the same id) never types the request a second time.
 *
 * Gated on an RFC1918 address like the other LAN integration tests (the listener binds nothing else), and on a POSIX
 * shell for the fake CLI (Windows cannot run it at all).
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, chmodSync, writeFileSync, rmSync, realpathSync, statSync} from 'node:fs';
import {tmpdir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import {RemoteControlLanServer, isPrivateRemoteControlIpv4} from '../src/remoteControlLanServer';
import {REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteControlGateway} from '../src/remoteControlCore';
import {resolveVerifiedRemoteTargetAuthorities, type RemoteTargetDirectory} from '../src/remoteControlTargetAuthorities';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submissionDigest} from '../src/workroomSubmissionProtocol';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';

const disposals: (() => unknown)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
const request = (r: Omit<AiTerminalRequest, 'requestId'>): AiTerminalRequest => ({...r, requestId: crypto.randomUUID()});
const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address))?.address;

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lan-submission-reconnect-'))), cli = join(dir, 'cli');
  chmodSync(dir, 0o700);
  writeFileSync(cli, '#!/bin/sh\nstty -echo\nprintf "REMOTE_READY\\n"\nwhile IFS= read -r line; do printf "RESULT:%s\\n" "$line"; done\n'); chmodSync(cli, 0o755);
  const store = new WorkroomConversationJournal(dir);
  const service = new AiTerminalService({submissions: () => store, resolveTarget: async id => { if (id !== 'project-runtime-123') throw new Error('unregistered'); return {cwd: dir}; }, executable: () => cli});
  disposals.push(() => rmSync(dir, {recursive: true, force: true}), () => store.close(), () => service.shutdown());
  const gateway: RemoteControlGateway = {listRegisteredProjects: () => [{internalId: 'private-project', name: 'Fixture project', port: null, command: null, kind: 'main', folderPath: dir, status: 'unknown', actions: ['folder.open']}], executeRegisteredProjectAction: () => {}};
  const directory = (path: string): RemoteTargetDirectory => { try { const canonical = realpathSync(path), info = statSync(canonical); return info.isDirectory() ? {status: 'found', path: canonical, dev: info.dev, ino: info.ino} : {status: 'missing'}; } catch { return {status: 'unknown'}; } };
  const remote = createAiTerminalRemoteGateway({service, active: () => true, resolve: async bindings => resolveVerifiedRemoteTargetAuthorities(bindings, [{targetId: 'project-runtime-123', cwd: dir}], directory, (a, b) => a.path === b.path && a.dev === b.dev && a.ino === b.ino)});
  return {service, gateway, remote};
}

test.skipIf(!address || process.platform === 'win32')('a submission committed just before the socket drops reads as written after session.restore, and is never typed twice', async () => {
  const f = fixture();
  const server = new RemoteControlLanServer({bindAddress: address!, hostName: 'Fixture Mac', gateway: f.gateway, terminalGateway: f.remote});
  disposals.push(() => server.stop());
  const started = server.start();
  const origin = 'http://' + started.status.listener!.host + ':' + started.status.listener!.port;
  const connect = async () => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/remote/ws', {headers: {Origin: origin}} as any);
    const inbox: any[] = [];
    socket.addEventListener('message', event => inbox.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('connect failed')); });
    disposals.push(() => socket.close());
    const reply = async () => { for (let i = 0; i < 1000; i++) { if (inbox.length) return inbox.shift(); await Bun.sleep(5); } throw new Error('reply timeout'); };
    return {socket, inbox, reply, async exchange(value: unknown) { socket.send(JSON.stringify(value)); return reply(); }};
  };
  const output = async (sessionId: string) => ((await f.service.perform(request({operation: 'read', sessionId, after: 0}))).chunks ?? []).map(chunk => chunk.text).join('');
  const untilOutput = async (sessionId: string, text: string) => {
    for (let n = 0; n < 60; n++) { if ((await output(sessionId)).includes(text)) return; await Bun.sleep(100); }
    throw new Error('missing terminal output: ' + text);
  };
  const results = (text: string, sessionId: string) => output(sessionId).then(all => all.split('RESULT:' + text).length - 1);

  // Pair and grant this connection the terminal.
  const phone = await connect();
  const pairToken = new URLSearchParams(new URL(started.pairing.pairingUrl).hash.slice(1)).get('pair');
  const ready = await phone.exchange({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token: pairToken});
  expect(ready.type).toBe('session.ready');
  f.service.setRemoteAccess('lan:' + server.status().sessions[0]!.id, true);
  const remote = (client: Awaited<ReturnType<typeof connect>>, r: Omit<AiTerminalRequest, 'requestId'>) => client.exchange({type: 'terminal.request', sessionToken: ready.sessionToken, request: request(r)});
  const listed = await remote(phone, {operation: 'list', capabilities: true});
  expect(listed.ok).toBe(true);
  expect(listed.body.features).toContain('terminal-submission-v1');
  const begun = await remote(phone, {operation: 'start', targetId: ready.projects[0].controlId, agent: 'claude', cols: 80, rows: 24});
  expect(begun.ok).toBe(true);
  const sessionId: string = begun.body.session.id;
  await untilOutput(sessionId, 'REMOTE_READY');

  // One whole request. The CLI runs it; the phone locks before reading the answer.
  const text = 'reconnect-submission-line';
  const bytes = new TextEncoder().encode(text + '\r');
  const submission = {phase: 'single', id: 'lan-reconnect-submission-0001', bytes: bytes.length, digest: submissionDigest(bytes), data: Buffer.from(bytes).toString('base64')};
  phone.socket.send(JSON.stringify({type: 'terminal.request', sessionToken: ready.sessionToken, request: request({operation: 'submission', sessionId, submission} as never)}));
  await untilOutput(sessionId, 'RESULT:' + text);
  phone.socket.close();
  await Bun.sleep(100);
  expect(server.status().sessions[0]!.connected).toBe(false);

  // The morning: the same phone restores — a new management id, the same controller and receipt owner.
  const back = await connect();
  const restored = await back.exchange({type: 'session.restore', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken});
  expect(restored.type).toBe('session.restored');
  f.service.setRemoteAccess('lan:' + server.status().sessions[0]!.id, true);
  const status = await remote(back, {operation: 'submission', sessionId, submission: {phase: 'status', id: submission.id}} as never);
  expect(status.ok).toBe(true);
  expect(status.body.submission.state).toBe('written');
  expect(status.body.submission.id).toBe(submission.id);

  // Asking again, and even resending the same request id, answers from the receipt: zero extra PTY writes.
  const replay = await remote(back, {operation: 'submission', sessionId, submission} as never);
  expect(replay.ok).toBe(true);
  expect(replay.body.submission.state).toBe('written');
  await Bun.sleep(500);
  expect(await results(text, sessionId)).toBe(1);
  expect(server.status().sessions[0]!.connected).toBe(true);
}, 30_000);
