/**
 * Review H1 (2026-09-29), against a real LAN listener and a real WebSocket.
 *
 * The LAN listener refuses a WebSocket message over 16 KiB with MESSAGE_TOO_LARGE and a 1008
 * policy close, and a 1008 close ends the paired session: restoring it answers SESSION_EXPIRED and
 * the phone needs a new QR from the Mac. The phone page used to send an `@` handoff to a new
 * session as one start frame and only checked 24,000 bytes of text, so a handoff of ~5,400 Korean
 * characters (16.3 KB) cost the user their pairing. This runs the page's shipped terminal
 * controller (not a copy) against the real server and requires the pairing to survive.
 *
 * Gated on an RFC1918 address like the other LAN integration tests: the listener binds nothing else.
 */
import {expect, test} from 'bun:test';
import vm from 'node:vm';
import {networkInterfaces} from 'node:os';
import {RemoteControlLanServer, isPrivateRemoteControlIpv4} from '../src/remoteControlLanServer';
import {REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteControlGateway} from '../src/remoteControlCore';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';
import type {RemoteTerminalGateway} from '../src/remoteControlTerminalProtocol';
import {REMOTE_CONTROL_LAN_MAX_MESSAGE_BYTES} from '../src/remoteControlLanLimits';

const gateway: RemoteControlGateway = {listRegisteredProjects: () => [], executeRegisteredProjectAction: () => undefined};

function privateAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address)) return entry.address;
  }
  return null;
}

const until = async (predicate: () => boolean, message: string, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(20);
  }
};

const SOURCE = 'fixture-source-project', TARGET = 'fixture-target-project';
const summary = (id: string, targetId: string, agent: string) => ({id, targetId, agent, state: 'running', createdAt: '2026-09-29T00:00:00Z', exitCode: null, cols: 100, rows: 24});

test.skipIf(!privateAddress())('a LAN @ handoff between 16 KB and 24 KB is refused on the phone and the pairing survives (review H1)', async () => {
  const received: any[] = [];
  const terminalGateway: RemoteTerminalGateway = async request => {
    received.push(request);
    if (request.operation === 'list') return {sessions: [summary('session-source-0001', SOURCE, 'codex')]} as any;
    if (request.operation === 'read') return {session: summary(request.sessionId!, SOURCE, 'codex'), chunks: [], nextCursor: request.after ?? 0, truncated: false, hasMore: false} as any;
    if (request.operation === 'start') return {session: summary('session-started-0001', request.targetId!, request.agent!)} as any;
    throw new Error('unexpected request in this fixture');
  };
  const server = new RemoteControlLanServer({bindAddress: privateAddress()!, hostName: 'Test Mac', gateway, terminalGateway});
  const {pairing} = server.start();
  const origin = new URL(pairing.pairingUrl).origin;
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(`${origin.replace('http://', 'ws://')}/remote/ws`, {headers: {Origin: origin}} as unknown as string[]);
    const inbox: any[] = [];
    let closeCode: number | null = null;
    socket.addEventListener('close', event => {closeCode = (event as CloseEvent).code;});
    await new Promise<void>((resolve, reject) => {socket!.addEventListener('open', () => resolve());socket!.addEventListener('error', () => reject(new Error('WebSocket failed')));});
    socket.addEventListener('message', event => inbox.push(JSON.parse(String((event as MessageEvent).data))));
    socket.send(JSON.stringify({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token: new URL(pairing.pairingUrl).hash.replace(/^#pair=/, '')}));
    await until(() => inbox.some(message => message.type === 'session.ready'), 'pairing did not complete');
    const sessionToken = inbox.find(message => message.type === 'session.ready').sessionToken;

    // The page's own terminal controller, with a fake DOM, driven over this socket with real timers.
    const start = REMOTE_CONTROL_MOBILE_JS.indexOf('const terminalWaiters=');
    const end = REMOTE_CONTROL_MOBILE_JS.indexOf('let actionSequence =', start);
    const nodes = new Map<string, any>();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', disabled: false, hidden: false, clientWidth: 390, clientHeight: 400, style: {setProperty() {}},
        querySelector: () => ({getBoundingClientRect: () => ({height: 14})}), children: [] as any[],
        replaceChildren(...items: any[]) {this.children = items;}, append(item: any) {this.children.push(item);}, add(item: any) {this.children.push(item);}});
      return nodes.get(id);
    };
    let sequence = 0;
    const confirms: string[] = [];
    const context = vm.createContext({
      TextEncoder, Promise, Map, Set, Error, Date, setTimeout, clearTimeout, performance,
      confirm: (message: string) => {confirms.push(message); return true;},
      document: {querySelector: (selector: string) => node(selector.slice(1)), getElementById: node, createElement: () => ({type: '', textContent: '', onclick: null, setAttribute() {}})},
      Option: class {constructor(public text: string, public value: string) {}},
      ResizeObserver: class {observe() {}},
      window: {Terminal: class {cols = 80; rows = 24; open() {} onData() {} reset() {} write(_text: string, callback?: () => void) {callback?.();} resize() {} dispose() {}
        get buffer() {return {active: {baseY: 0, getLine: () => ({translateToString: () => ''})}};}}},
      WebSocket: {OPEN: 1}, socket, sessionToken,
      loadSavedSession: () => sessionToken,
      localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
      nextActionId: () => `a-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    });
    const run = (code: string) => vm.runInContext(code, context);
    socket.addEventListener('message', event => {
      const message = JSON.parse(String((event as MessageEvent).data));
      if (message.type === 'terminal.result') {context.fixtureReply = message; run('terminalReply(fixtureReply)');}
    });
    run(REMOTE_CONTROL_MOBILE_JS.slice(start, end));
    context.fixtureProjects = [{controlId: SOURCE, name: 'Source project'}, {controlId: TARGET, name: 'Target project'}];
    run('terminalReady(fixtureProjects)');
    node('terminal-project').value = SOURCE; node('terminal-agent').value = 'codex';
    run("terminalSelect('session-source-0001');terminalSetRoute(terminalProjects[1])");
    node('terminal-route-agent').value = 'claude';

    const value = '한'.repeat(5500);
    expect(Buffer.byteLength(value)).toBeGreaterThan(REMOTE_CONTROL_LAN_MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(value)).toBeLessThan(24_000);
    const field = node('terminal-line');
    field.value = value; field.oninput();
    void node('terminal-send').onclick();
    await until(() => node('terminal-error').textContent !== '' || closeCode !== null || received.some(request => request.operation === 'start'), 'the send settled neither way');
    await Bun.sleep(300);

    expect(closeCode).toBeNull();
    expect(received.filter(request => request.operation === 'start')).toEqual([]);
    expect(confirms).toEqual([]);
    expect(node('terminal-error').textContent).toContain('약 15KB');
    expect(field.value).toBe(value);
    const status = server.status();
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]!.connected).toBe(true);

    // The same pairing keeps working after the refusal.
    run("terminalRequest({operation:'list'}).then(result=>{fixtureList=result})");
    await until(() => !!context.fixtureList, 'the pairing did not answer after the refused handoff');
    expect(context.fixtureList.sessions[0].id).toBe('session-source-0001');
  } finally {
    socket?.close();
    server.stop();
  }
}, 30_000);
