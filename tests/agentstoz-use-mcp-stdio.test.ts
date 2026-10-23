import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {resolveConversationTargetAlias} from '../src/conversationTargetAlias';
import {parseServiceUseRequest} from '../src/serviceUseProtocol';

const children: Bun.Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const homes: string[] = [];

test('external agents discover another app catalog and invoke only its declared action through MCP',async()=>{
  const calls:any[]=[],actions=[{id:'booking.lookup',label:'예약 확인',effect:'read',fields:[{key:'reference',label:'예약 번호',type:'string',required:true}]}];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const body:any=await request.json();calls.push(body);expect(body.action).toBe('service-use');expect(body.portId).toBe('booking-project');
    const value=parseServiceUseRequest(body.serviceUse);
    if(value.operation==='status')return Response.json({success:true,performed:true,actions,tools:['app.invoke'],readiness:{enabled:true,memoryReady:true,tools:'verified',environmentReady:true,executionReady:true}});
    if(value.operation==='execute')expect(value.call).toEqual({role:'use',serviceKey:'default',tool:'app.invoke',input:{actionId:'booking.lookup',arguments:{reference:'known-booking-13'}}});
    return Response.json({success:true,performed:true,outcome:{state:'completed',message:'예약 확인',operationId:value.requestId}});
  }});servers.push(server);
  const mcp=startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);mcp.write({id:1,method:'initialize'});await mcp.read(1);
  mcp.write({id:2,method:'tools/list'});const tool=(await mcp.read(2)).value.result.tools.find((t:any)=>t.name==='agentstoz_use_service_operation');expect(JSON.stringify(tool.inputSchema)).toContain('app.invoke');
  const invoke=async(id:number,serviceUse:any)=>{mcp.write({id,method:'tools/call',params:{name:tool.name,arguments:{portId:'booking-project',serviceUse}}});return (await mcp.read(id)).value.result.structuredContent;};
  expect((await invoke(3,{operation:'status'})).actions).toEqual(actions);
  expect((await invoke(4,{operation:'execute',requestId:'booking-test-request',call:{role:'use',serviceKey:'default',tool:'app.invoke',input:{actionId:'booking.lookup',arguments:{reference:'known-booking-13'}}}})).outcome.state).toBe('completed');
  expect((await invoke(5,{operation:'receipt',requestId:'booking-test-request'})).outcome.operationId).toBe('booking-test-request');
  expect(calls.map(c=>c.serviceUse.operation)).toEqual(['status','execute','receipt']);mcp.child.stdin.end();expect(await mcp.child.exited).toBe(0);await mcp.reading;
});

test('an external MCP client discovers and calls the named product USE without an @ UI or DEV Workroom',async()=>{
  const calls:any[]=[],receipts=new Map<string,unknown>();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const action:any=await request.json();calls.push(action);
    if(action.action==='resolve-target')return Response.json({success:true,performed:true,resolution:resolveConversationTargetAlias(action.targetAlias,[{id:'project-shadowloop',name:'ShadowLoop'}])});
    expect(action.action).toBe('service-use');expect(action.portId).toBe('project-shadowloop');
    const operation=parseServiceUseRequest(action.serviceUse);
    if(operation.operation==='status')return Response.json({success:true,performed:true,readiness:{enabled:true,memoryReady:true,tools:'verified',environmentReady:true,executionReady:true}});
    if(operation.operation==='execute')receipts.set(operation.requestId,{state:'completed',message:'synthetic application completed',materialId:'material-one'});
    return Response.json({success:true,performed:true,outcome:receipts.get(operation.requestId)});
  }});servers.push(server);
  const mcp=startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);
  mcp.write({id:1,method:'initialize'});await mcp.read(1);
  mcp.write({id:2,method:'tools/list'});
  const tools=(await mcp.read(2)).value.result.tools;
  expect(tools.find((t:any)=>t.name==='agentstoz_use_service_operation').description).toContain('ShadowLoop USE로 자료 만들어줘');
  const call=async(id:number,name:string,args:unknown)=>{mcp.write({id,method:'tools/call',params:{name,arguments:args}});return (await within(mcp.read(id),'USE MCP response missing')).value.result.structuredContent;};
  const resolved=await call(3,'agentstoz_use_resolve_target',{targetAlias:'ShadowLoop-USE'});
  expect(resolved.resolution).toMatchObject({projectId:'project-shadowloop',executionRole:'use'});
  const portId=resolved.resolution.projectId;
  expect((await call(4,'agentstoz_use_service_operation',{portId,serviceUse:{operation:'status'}})).readiness.executionReady).toBe(true);
  const serviceUse={operation:'execute',requestId:'external-use-request',call:{role:'use',serviceKey:'default',tool:'materials.generate',input:{text:'A short greeting.'}}};
  expect((await call(5,'agentstoz_use_service_operation',{portId,serviceUse})).outcome.state).toBe('completed');
  expect((await call(6,'agentstoz_use_service_operation',{portId,serviceUse:{operation:'receipt',requestId:serviceUse.requestId}})).outcome.materialId).toBe('material-one');
  expect(calls.map(c=>c.action)).toEqual(['resolve-target','service-use','service-use','service-use']);
  expect(calls.filter(c=>c.serviceUse?.operation==='execute')).toHaveLength(1);
  mcp.child.stdin.end();expect(await mcp.child.exited).toBe(0);await mcp.reading;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true});
});

function startMcp(endpoint: string) {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-mcp-stdio-'));
  homes.push(home);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '..', 'agentstoz-use-mcp-server.ts')], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      HOME: home,
      APP_DATA_DIR: join(home, 'app-data'),
      AGENTSTOZ_CONTROLLER_PORT_ID: 'fixture-controller',
      AGENTSTOZ_USE_ENDPOINT: endpoint,
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  const received = new Map<number, {value: any; at: number}>();
  const lines: any[] = [];
  const waiters = new Map<number, (value: {value: any; at: number}) => void>();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, {stream: true});
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line);
        lines.push(value);
        const item = {value, at: performance.now()};
        received.set(value.id, item);
        waiters.get(value.id)?.(item);
        waiters.delete(value.id);
      }
    }
  })();
  const write = (request: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', ...request})}\n`);
  const read = (id: number): Promise<{value: any; at: number}> => {
    const existing = received.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => waiters.set(id, resolve));
  };
  return {child, write, read, reading, lines};
}

function within<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test('a Workroom wait does not block ping and EOF drains both replies', async () => {
  let waitAccepted!: () => void;
  let releaseWait!: () => void;
  const accepted = new Promise<void>(resolve => { waitAccepted = resolve; });
  const waitGate = new Promise<void>(resolve => { releaseWait = resolve; });
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const action = await request.json() as {action: string};
    if (action.action === 'wait-workroom-session') {
      waitAccepted();
      await waitGate;
    }
    return Response.json({success: true, performed: true, action: action.action, effect: 'read-only'});
  }});
  servers.push(server);
  const mcp = startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);
  mcp.write({id: 1, method: 'initialize', params: {clientInfo: {name: 'stdio-test'}}});
  expect((await mcp.read(1)).value.result.serverInfo.name).toBe('agentstoz-use');
  mcp.write({id: 2, method: 'tools/call', params: {name: 'agentstoz_use_wait_workroom_session', arguments: {
    portId: 'fixture-project', sessionId: 'fixture-session', timeoutMs: 1000,
  }}});
  await accepted;
  const pingSentAt = performance.now();
  mcp.write({id: 3, method: 'ping'});
  mcp.child.stdin.end();
  let ping!: Awaited<ReturnType<typeof mcp.read>>;
  try {
    ping = await within(mcp.read(3), 'ping was blocked behind the Workroom wait');
  } finally {
    releaseWait();
  }
  const waited = await mcp.read(2);
  expect(ping.value.result).toEqual({});
  expect(waited.value.result.structuredContent.success).toBe(true);
  expect(ping.at).toBeLessThan(waited.at);
  console.info(`MCP ping while Workroom wait held: ${(ping.at - pingSentAt).toFixed(1)} ms`);
  expect(await mcp.child.exited).toBe(0);
  await mcp.reading;
});

test('stdio bounds host calls and queue while keeping protocol requests responsive', async () => {
  let active = 0;
  let peak = 0;
  let allAccepted!: () => void;
  let releaseCalls!: () => void;
  const accepted = new Promise<void>(resolve => { allAccepted = resolve; });
  const callsGate = new Promise<void>(resolve => { releaseCalls = resolve; });
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const action = await request.json() as {action: string};
    active += 1;
    peak = Math.max(peak, active);
    if (active === 15) allAccepted();
    await callsGate;
    active -= 1;
    return Response.json({success: true, performed: true, action: action.action, effect: 'read-only'});
  }});
  servers.push(server);
  const mcp = startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);
  mcp.write({id: 1, method: 'initialize'});
  await mcp.read(1);
  const count = 90;
  for (let id = 2; id < count + 2; id += 1) {
    mcp.write({id, method: 'tools/call', params: {name: 'agentstoz_use_list_projects', arguments: {}}});
  }
  await accepted;
  const protocolSentAt = performance.now();
  mcp.write({id: 100, method: 'ping'});
  mcp.write({id: 101, method: 'tools/list'});
  mcp.child.stdin.end();
  try {
    const protocol = await within(
      Promise.all([mcp.read(100), mcp.read(101)]),
      'MCP protocol requests were blocked at host-call capacity',
    );
    expect(protocol[0].value.result).toEqual({});
    expect(protocol[1].value.result.tools.length).toBeGreaterThan(0);
    console.info(`MCP ping/list at 15 occupied read slots: ${(Math.max(...protocol.map(item => item.at)) - protocolSentAt).toFixed(1)} ms`);
  } finally {
    releaseCalls();
  }
  const replies = await Promise.all(Array.from({length: count}, (_, index) => mcp.read(index + 2)));
  expect(replies.filter(reply => reply.value.result?.structuredContent?.success === true)).toHaveLength(78);
  expect(replies.filter(reply => reply.value.error?.code === -32000)).toHaveLength(12);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(15);
  expect(await mcp.child.exited).toBe(0);
  await mcp.reading;
});

test('a reserved MCP slot serves ordered mutations behind sixteen long Workroom waits', async () => {
  let activeWaits = 0;
  let allWaitsAccepted!: () => void;
  let firstMutationAccepted!: () => void;
  let secondMutationAccepted!: () => void;
  let releaseWaits!: () => void;
  let releaseFirstMutation!: () => void;
  const waitsAccepted = new Promise<void>(resolve => { allWaitsAccepted = resolve; });
  const firstAccepted = new Promise<void>(resolve => { firstMutationAccepted = resolve; });
  const secondAccepted = new Promise<void>(resolve => { secondMutationAccepted = resolve; });
  const waitGate = new Promise<void>(resolve => { releaseWaits = resolve; });
  const mutationGate = new Promise<void>(resolve => { releaseFirstMutation = resolve; });
  const seen: string[] = [];
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const action = await request.json() as {action: string; projectName?: string};
    if (action.action === 'wait-workroom-session') {
      activeWaits += 1;
      if (activeWaits === 15) allWaitsAccepted();
      await waitGate;
      return Response.json({success: true, performed: true, effect: 'read-only'});
    }
    if (action.action === 'create-project') {
      seen.push(action.projectName ?? '');
      if (action.projectName === 'First') {
        firstMutationAccepted();
        await mutationGate;
      } else secondMutationAccepted();
      return Response.json({success: true, performed: true, effect: 'created-local-project'});
    }
    return Response.json({success: true, performed: true, effect: 'read-only'});
  }});
  servers.push(server);
  const mcp = startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);
  mcp.write({id: 1, method: 'initialize'});
  await mcp.read(1);
  for (let id = 2; id < 18; id += 1) mcp.write({id, method: 'tools/call', params: {
    name: 'agentstoz_use_wait_workroom_session', arguments: {
      portId: 'fixture-project', sessionId: 'fixture-session', timeoutMs: 50_000,
    },
  }});
  await within(waitsAccepted, 'fifteen Workroom waits never reached the host');
  const create = (id: number, projectName: string) => mcp.write({id, method: 'tools/call', params: {
    name: 'agentstoz_use_create_project', arguments: {workspaceRootId: 'fixture-root', projectName},
  }});
  create(18, 'First');
  create(19, 'Second');
  try {
    await within(firstAccepted, 'the first mutation starved behind a queued read', 2_000);
    expect(activeWaits).toBe(15);
    expect(seen).toEqual(['First']);
    mcp.write({id: 20, method: 'ping'});
    expect((await within(mcp.read(20), 'ping was blocked by Workroom waits')).value.result).toEqual({});
    await Bun.sleep(20);
    expect(seen).toEqual(['First']);
    releaseFirstMutation();
    await within(secondAccepted, 'the second mutation starved behind a queued read', 2_000);
    expect(seen).toEqual(['First', 'Second']);
    expect(activeWaits).toBe(15);
  } finally {
    releaseFirstMutation();
    releaseWaits();
  }
  mcp.child.stdin.end();
  const replies = await Promise.all(Array.from({length: 18}, (_, index) => mcp.read(index + 2)));
  expect(replies.every(reply => reply.value.result?.structuredContent?.success === true)).toBe(true);
  expect(await mcp.child.exited).toBe(0);
  await mcp.reading;
});

test('mutating MCP tools reach the host in input order', async () => {
  let firstAccepted!: () => void;
  let releaseFirst!: () => void;
  const accepted = new Promise<void>(resolve => { firstAccepted = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const seen: string[] = [];
  let active = 0;
  let peak = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const action = await request.json() as {action: string; projectName: string};
    active += 1;
    peak = Math.max(peak, active);
    seen.push(action.projectName);
    if (action.projectName === 'First') {
      firstAccepted();
      await firstGate;
    }
    active -= 1;
    return Response.json({success: true, performed: true, action: action.action, effect: 'created-local-project'});
  }});
  servers.push(server);
  const mcp = startMcp(`http://127.0.0.1:${server.port}/api/agentstoz-use/action`);
  mcp.write({id: 1, method: 'initialize'});
  await mcp.read(1);
  const create = (id: number, projectName: string) => mcp.write({id, method: 'tools/call', params: {
    name: 'agentstoz_use_create_project', arguments: {workspaceRootId: 'fixture-root', projectName},
  }});
  create(2, 'First');
  create(3, 'Second');
  await accepted;
  try {
    mcp.write({id: 4, method: 'ping'});
    await within(mcp.read(4), 'ping was blocked by a host mutation');
    await Bun.sleep(20);
    expect(seen).toEqual(['First']);
  } finally {
    releaseFirst();
  }
  mcp.child.stdin.end();
  const responses = await Promise.all([mcp.read(2), mcp.read(3)]);
  expect(responses.map(item => item.value.result.structuredContent.success)).toEqual([true, true]);
  expect(seen).toEqual(['First', 'Second']);
  expect(peak).toBe(1);
  expect(await mcp.child.exited).toBe(0);
  await mcp.reading;
});

test('non-object JSON-RPC input returns errors and leaves the connection usable', async () => {
  const mcp = startMcp('http://127.0.0.1:1/api/agentstoz-use/action');
  mcp.child.stdin.write('null\n[]\n123\n');
  mcp.write({id: 1, method: 'ping'});
  mcp.child.stdin.end();
  expect((await within(mcp.read(1), 'MCP did not survive non-object JSON')).value.result).toEqual({});
  expect(await mcp.child.exited).toBe(0);
  await mcp.reading;
  expect(mcp.lines.filter(line => line.id === null).map(line => line.error.code)).toEqual([-32600, -32600, -32600]);
});
