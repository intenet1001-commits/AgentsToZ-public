/**
 * w2-followups #14, against a real LAN listener and a real WebSocket.
 *
 * A LAN `@` handoff to a new session went out as one start frame, so anything past the 16 KiB frame was refused on
 * the phone (review H1), and a lost answer could only be retried as a second start. A Mac that advertises
 * terminal-start-submission-v1 now takes the handoff as a launch: one 4,000-byte chunk per request, a receipt that
 * names the session, and a pending record the page checks with 「새 세션 시작 결과 확인」 instead of starting again.
 * This runs the page's shipped terminal controller (not a copy). Gated on an RFC1918 address like the other LAN tests.
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
class MemoryStorage {
  items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}

const SOURCE = 'fixture-source-project', TARGET = 'fixture-target-project', OTHER = 'fixture-other-project';
const summary = (id: string, targetId: string, agent: string) => ({id, targetId, agent, state: 'running', createdAt: '2026-10-15T00:00:00Z', exitCode: null, cols: 100, rows: 24});

async function lanPage(options: {outcome: 'written' | 'lost-unknown'; extraSessions?: ReturnType<typeof summary>[]}) {
  // `options.outcome` is read per launch, so a test can change it between sends.
  const received: any[] = [];
  const typed: {sessionId: string; data: string}[] = [];
  const launches = new Map<string, {state: string; sessionId: string; targetId: string; agent: string; parts: Buffer[]}>();
  const sessions = [summary('session-source-0001', SOURCE, 'codex'), ...(options.extraSessions ?? [])];
  const receipt = (id: string) => {const entry = launches.get(id)!; return {id, storeId: 'store-launch-01', epoch: 'epoch-launch-01', revision: 0, state: entry.state, sessionId: entry.sessionId, targetId: entry.targetId, agent: entry.agent};};
  const terminalGateway: RemoteTerminalGateway = async request => {
    received.push(request);
    if (request.operation === 'list') return {sessions: [...sessions], ...(request.capabilities ? {features: ['terminal-submission-v1', 'terminal-start-submission-v1']} : {})} as any;
    if (request.operation === 'read') return {session: sessions.find(item => item.id === request.sessionId) ?? sessions[0], chunks: [], nextCursor: request.after ?? 0, truncated: false, hasMore: false} as any;
    if (request.operation === 'submission') {
      const s = request.submission as any;
      // A whole request into a running session (the composer, or an @ route that resolves to the current session).
      if (request.sessionId !== undefined) {
        const commits = s.phase === 'single' || s.commit === true;
        if (commits) typed.push({sessionId: request.sessionId, data: s.data});
        return {submission: {id: s.id, storeId: 'store-input-01', epoch: 'epoch-input-01', revision: 1, state: commits ? 'written' : 'prepared'}} as any;
      }
      if (s.phase === 'status') return {submission: receipt(s.id)} as any;
      if (s.phase === 'recent') return {submissions: []} as any;
      if (s.launch) launches.set(s.id, {state: 'prepared', sessionId: `session-launched-${String(launches.size + 1).padStart(4, '0')}`, targetId: s.launch.targetId, agent: s.launch.agent, parts: []});
      const entry = launches.get(s.id)!;
      if (s.phase === 'single') entry.parts = [Buffer.from(s.data, 'base64')];
      if (s.phase === 'begin') entry.parts = [Buffer.from(s.firstData, 'base64')];
      if (s.phase === 'chunk') entry.parts[s.index] = Buffer.from(s.data, 'base64');
      const commits = s.phase === 'single' || s.commit === true;
      if (!commits) return {submission: receipt(s.id)} as any;
      if (options.outcome === 'lost-unknown') {entry.state = 'unknown'; throw new Error('응답을 확인하지 못했습니다.');}
      entry.state = 'written';
      const created = summary(entry.sessionId, entry.targetId, entry.agent);
      sessions.push(created);
      return {submission: receipt(s.id), session: created} as any;
    }
    if (request.operation === 'start') return {session: summary('session-started-0001', request.targetId!, request.agent!)} as any;
    throw new Error('unexpected request in this fixture');
  };
  const server = new RemoteControlLanServer({bindAddress: privateAddress()!, hostName: 'Test Mac', gateway, terminalGateway});
  const {pairing} = server.start();
  const origin = new URL(pairing.pairingUrl).origin;
  const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/remote/ws`, {headers: {Origin: origin}} as unknown as string[]);
  const inbox: any[] = [];
  const state = {closeCode: null as number | null};
  socket.addEventListener('close', event => {state.closeCode = (event as CloseEvent).code;});
  await new Promise<void>((resolve, reject) => {socket.addEventListener('open', () => resolve());socket.addEventListener('error', () => reject(new Error('WebSocket failed')));});
  socket.addEventListener('message', event => inbox.push(JSON.parse(String((event as MessageEvent).data))));
  socket.send(JSON.stringify({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token: new URL(pairing.pairingUrl).hash.replace(/^#pair=/, '')}));
  await until(() => inbox.some(message => message.type === 'session.ready'), 'pairing did not complete');
  const sessionToken = inbox.find(message => message.type === 'session.ready').sessionToken;

  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('const terminalWaiters=');
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('let actionSequence =', start);
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', disabled: false, hidden: false, checked: false, clientWidth: 390, clientHeight: 400, style: {setProperty() {}},
      querySelector: () => ({getBoundingClientRect: () => ({height: 14})}), children: [] as any[],
      replaceChildren(...items: any[]) {this.children = items;}, append(item: any) {this.children.push(item);}, add(item: any) {this.children.push(item);}});
    return nodes.get(id);
  };
  let sequence = 0;
  const confirms: string[] = [];
  const storage = new MemoryStorage();
  const context = vm.createContext({
    TextEncoder, TextDecoder, Promise, Map, Set, Error, Date, Array, Uint8Array, setTimeout, clearTimeout, performance, btoa, crypto,
    confirm: (message: string) => {confirms.push(message); return true;},
    document: {querySelector: (selector: string) => node(selector.slice(1)), getElementById: node, createElement: () => ({type: '', textContent: '', onclick: null, setAttribute() {}})},
    Option: class {constructor(public text: string, public value: string) {}},
    ResizeObserver: class {observe() {}},
    window: {Terminal: class {cols = 80; rows = 24; open() {} onData() {} reset() {} write(_text: string, callback?: () => void) {callback?.();} resize() {} dispose() {}
      get buffer() {return {active: {baseY: 0, getLine: () => ({translateToString: () => ''})}};}}},
    WebSocket: {OPEN: 1}, socket, sessionToken, sessionStorage: storage,
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
  context.fixtureProjects = [{controlId: SOURCE, name: 'Source project'}, {controlId: TARGET, name: 'Target project'}, {controlId: OTHER, name: 'Other project'}];
  run('terminalReady(fixtureProjects)');
  // The capability probe of this connection.
  run('terminalList().then(()=>{fixtureListed=true})');
  await until(() => !!context.fixtureListed, 'the capability list never answered');
  node('terminal-project').value = SOURCE; node('terminal-agent').value = 'codex';
  run("terminalSelect('session-source-0001');terminalSetRoute(terminalProjects[1])");
  node('terminal-route-agent').value = 'claude';
  return {server, socket, state, received, typed, launches, sessions, options, node, run, context, confirms, storage, close() {socket.close();server.stop();}};
}

test.skipIf(!privateAddress())('a LAN @ handoff past one frame opens the new session as a launch, chunk by chunk, and the pairing survives', async () => {
  const page = await lanPage({outcome: 'written'});
  try {
    const value = '한'.repeat(5500);
    expect(Buffer.byteLength(value)).toBeGreaterThan(REMOTE_CONTROL_LAN_MAX_MESSAGE_BYTES);
    const field = page.node('terminal-line');
    field.value = value; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '' || field.value === '' || page.state.closeCode !== null, 'the send settled neither way');
    await Bun.sleep(200);
    expect(page.state.closeCode).toBeNull();
    expect(page.node('terminal-error').textContent).toBe('');
    expect(page.received.filter(request => request.operation === 'start')).toEqual([]);
    const submissions = page.received.filter(request => request.operation === 'submission' && request.submission.phase !== 'status');
    expect(submissions[0].submission.phase).toBe('begin');
    expect(submissions[0].submission.launch).toMatchObject({targetId: TARGET, agent: 'claude'});
    expect(submissions.every(request => request.sessionId === undefined)).toBe(true);
    const text = Buffer.concat([...page.launches.values()][0]!.parts).toString('utf8');
    expect(text).toContain(value);
    expect(text.endsWith('\r')).toBe(true);
    expect(page.confirms).toHaveLength(1);
    expect(field.value).toBe('');
    expect(page.run('terminalSelected')).toBe('session-launched-0001');
    expect(page.node('terminal-launch').hidden).toBe(true);
    expect([...page.storage.items.keys()].filter(key => key.startsWith('agentstoz:pending-launch:'))).toEqual([]);
    expect(page.server.status().sessions[0]!.connected).toBe(true);
  } finally { page.close(); }
}, 30_000);

test.skipIf(!privateAddress())('a lost launch answer whose status is unknown keeps the draft, shows the launch banner and refuses a second launch', async () => {
  const page = await lanPage({outcome: 'lost-unknown'});
  try {
    const field = page.node('terminal-line');
    field.value = '배포 전에 테스트를 돌려 줘'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '', 'the send never reported its outcome');
    expect(page.node('terminal-error').textContent).toContain('새 세션 시작 결과가 아직 확정되지 않았습니다');
    expect(field.value).toBe('배포 전에 테스트를 돌려 줘');
    expect(page.node('terminal-launch').hidden).toBe(false);
    expect(page.node('terminal-launch-text').textContent).toContain('전달 여부 확인 불가');
    const launchesBefore = page.received.filter(request => request.operation === 'submission' && request.submission.launch).length;
    expect(launchesBefore).toBe(1);
    expect(page.received.filter(request => request.operation === 'submission' && request.submission.phase === 'status')).toHaveLength(1);
    // A second send to the same target and AI is refused before asking — never a second launch or a plain start.
    page.node('terminal-error').textContent = '';
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '', 'the second send was not refused');
    expect(page.node('terminal-error').textContent).toContain('새 세션 시작 결과가 아직 미확정');
    expect(page.confirms).toHaveLength(1);
    expect(page.received.filter(request => request.operation === 'submission' && request.submission.launch)).toHaveLength(1);
    expect(page.received.filter(request => request.operation === 'start')).toEqual([]);
  } finally { page.close(); }
}, 30_000);

// w2-followups #10: an @ route that resolves to the current session (same project, same AI) goes the same way as the
// composer's own 「전송」 — one whole request with a receipt where the Mac takes it — instead of raw input.
test.skipIf(!privateAddress())('an @ route to the current session is one submission with a receipt, not raw input', async () => {
  const page = await lanPage({outcome: 'written'});
  try {
    // The page's cached list does not have the selected session yet, so the dropdowns stand in for it and the click
    // treats the route as another target; the fresh list inside the route shows it is the current session after all.
    page.run("terminalSessionSummaries=[]");
    page.node('terminal-project').value = TARGET; page.node('terminal-agent').value = 'claude';
    page.run("terminalSetRoute(terminalProjects[0])");
    page.node('terminal-route-agent').value = 'codex';
    const field = page.node('terminal-line');
    field.value = '현재 세션에 이어서 보내'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => field.value === '' || page.node('terminal-error').textContent !== '', 'the send settled neither way');
    await Bun.sleep(200);
    expect(page.node('terminal-error').textContent).toBe('');
    expect(page.received.filter(request => request.operation === 'input')).toEqual([]);
    expect(page.typed).toHaveLength(1);
    expect(page.typed[0]!.sessionId).toBe('session-source-0001');
    expect(Buffer.from(page.typed[0]!.data, 'base64').toString('utf8')).toBe('현재 세션에 이어서 보내\r');
    expect(page.confirms).toEqual([]);
    expect(page.received.filter(request => request.operation === 'start' || request.operation === 'submission' && request.submission.launch)).toEqual([]);
  } finally { page.close(); }
}, 30_000);

test.skipIf(!privateAddress())('an @ route to the current session is refused while an earlier submission there is unsettled', async () => {
  const page = await lanPage({outcome: 'written'});
  try {
    page.storage.setItem('agentstoz:pending-submission:v1:lan:session-source-0001', JSON.stringify({id: 'lan-' + 'a'.repeat(32), sessionId: 'session-source-0001', receipt: null}));
    page.run("terminalSelect('session-source-0001');terminalSessionSummaries=[]");
    page.node('terminal-project').value = TARGET; page.node('terminal-agent').value = 'claude';
    page.run("terminalSetRoute(terminalProjects[0])");
    page.node('terminal-route-agent').value = 'codex';
    page.node('terminal-error').textContent = '';
    const field = page.node('terminal-line');
    field.value = '두 번 가면 안 되는 요청'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '', 'the send was not refused');
    expect(page.node('terminal-error').textContent).toContain('앞서 보낸 요청의 결과를 먼저 확인하세요');
    expect(page.received.filter(request => request.operation === 'input' || request.operation === 'submission' && request.submission.phase !== 'status' && request.submission.phase !== 'recent')).toEqual([]);
    expect(field.value).toBe('두 번 가면 안 되는 요청');
  } finally { page.close(); }
}, 30_000);

// Review 2026-10-15 (finding 1): one launch record per device. An @ handoff to another target used to overwrite the
// unsettled record of the first and delete it on success, so nothing refused a resend of the first handoff.
test.skipIf(!privateAddress())('an unsettled launch is never erased by a launch to another target; that launch waits for it', async () => {
  const page = await lanPage({outcome: 'lost-unknown'});
  try {
    const field = page.node('terminal-line');
    field.value = 'A 프로젝트에 한 번만 보낼 요청'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '', 'the first send never reported its outcome');
    const recorded = () => [...page.storage.items.entries()].filter(([key]) => key.startsWith('agentstoz:pending-launch:')).map(([, value]) => value).join('');
    const firstId = [...page.launches.keys()][0]!;
    expect(recorded()).toContain(firstId);
    // The user now hands a different request to another target, and that launch would succeed.
    page.options.outcome = 'written';
    page.node('terminal-error').textContent = '';
    page.run('terminalSetRoute(terminalProjects[2])');
    page.node('terminal-route-agent').value = 'claude';
    field.value = 'B 프로젝트 요청'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '' || field.value === '', 'the second send settled neither way');
    // The first launch's record and banner survive; nothing new was launched past it.
    expect(recorded()).toContain(firstId);
    expect(page.node('terminal-launch').hidden).toBe(false);
    expect(page.node('terminal-error').textContent).toContain('미확정');
    expect(page.received.filter(request => request.operation === 'submission' && request.submission.launch)).toHaveLength(1);
    expect(page.received.filter(request => request.operation === 'start')).toEqual([]);
  } finally { page.close(); }
}, 30_000);

// Review 2026-10-15 (finding 2): once the banner's status check settles an @ launch as written, the draft that went
// with it is cleared — pressing send again would otherwise type the same handoff into the session it opened.
test.skipIf(!privateAddress())('a banner check that finds the @ launch written clears the draft and the route that went with it', async () => {
  const page = await lanPage({outcome: 'lost-unknown'});
  try {
    const field = page.node('terminal-line');
    field.value = '한 번만 실행할 배포 요청'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => page.node('terminal-error').textContent !== '', 'the send never reported its outcome');
    expect(field.value).toBe('한 번만 실행할 배포 요청');
    // The host did start it: the status now reads written, with its session.
    const [id, entry] = [...page.launches.entries()][0]!;
    entry.state = 'written';
    page.sessions.push(summary(entry.sessionId, entry.targetId, entry.agent));
    await page.node('terminal-launch-status').onclick();
    expect(page.node('terminal-launch').hidden).toBe(true);
    expect(page.node('terminal-error').textContent).toContain('같은 요청을 다시 보내지 마세요');
    expect(field.value).toBe('');
    expect(page.run('terminalRouteTargetId')).toBe('');
    expect(page.received.filter(request => request.operation === 'submission' && request.submission.launch && request.submission.id === id)).toHaveLength(1);
  } finally { page.close(); }
}, 30_000);

// w4 L3: an @ route into another running session went as raw `input` even on a Mac that takes whole requests. Over a real
// LAN listener it is now one submission into that receiver, with a receipt — no raw input, and the pairing survives.
test.skipIf(!privateAddress())('an @ route into a running receiver is one whole-request submission, not raw input', async () => {
  const page = await lanPage({outcome: 'written', extraSessions: [summary('session-target-claude', TARGET, 'claude')]});
  try {
    const field = page.node('terminal-line');
    field.value = '실행 중인 세션에 넘길 요청'; field.oninput();
    void page.node('terminal-send').onclick();
    await until(() => field.value === '' || page.node('terminal-error').textContent !== '', 'the send settled neither way');
    await Bun.sleep(200);
    expect(page.node('terminal-error').textContent).toBe('');
    expect(page.received.filter(request => request.operation === 'input')).toEqual([]);
    expect(page.typed).toHaveLength(1);
    expect(page.typed[0]!.sessionId).toBe('session-target-claude');
    const text = Buffer.from(page.typed[0]!.data, 'base64').toString('utf8');
    expect(text).toContain('실행 중인 세션에 넘길 요청');
    expect(text.endsWith('\r')).toBe(true);
    expect(page.confirms).toHaveLength(1);
    expect(page.run('terminalSelected')).toBe('session-target-claude');
    expect(page.received.filter(request => request.operation === 'start' || request.operation === 'submission' && request.submission.launch)).toEqual([]);
    expect([...page.storage.items.keys()].filter(key => key.startsWith('agentstoz:pending-submission:'))).toEqual([]);
    expect(page.state.closeCode).toBeNull();
  } finally { page.close(); }
}, 30_000);

