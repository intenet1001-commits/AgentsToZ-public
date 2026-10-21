import {test,expect} from 'bun:test';
import {createTerminalRequester, createTerminalReadCadence, HELD_PART_NOTICE, PARTIAL_SUBMISSION_NOTICE, TERMINAL_REQUESTER_MAX_PENDING, terminalSubmissionGroup} from '../src/aiTerminalScheduling';
import {splitTerminalSubmission} from '../src/aiTerminalInput';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';
test('input after prolonged idle sees a delayed CLI echo promptly, then returns to bounded idle polling',()=>{
  let time=0;const cadence=createTerminalReadCadence(false,()=>time);
  for(let i=0;i<10;i++)cadence.next(false,false);
  expect(cadence.next(false,false)).toBe(2000);
  cadence.wake();
  // The acknowledgement wins the race with the PTY paint, even for several reads.
  expect(cadence.next(false,false)).toBe(32);
  time=500;expect(cadence.next(false,false)).toBe(32);
  expect(cadence.next(true,false)).toBe(32);
  expect(cadence.next(true,true)).toBe(0);
  time=1501;for(let i=0;i<10;i++)cadence.next(false,false);
  expect(cadence.next(false,false)).toBe(2000);
});
test('remote wake keeps a steady pace for the reply instead of backing off, without a burst',()=>{
  let time=0;const cadence=createTerminalReadCadence(true,()=>time);
  for(let i=0;i<10;i++)cadence.next(false,false);
  cadence.wake();
  // The AI's reply comes seconds later: the pace stays at base for 30 s rather than doubling to 5 s.
  for(let i=0;i<6;i++)expect(cadence.next(false,false)).toBe(700);
  // Output still flowing → read again almost at once (reads are one at a time, so nothing piles up).
  expect(cadence.next(true,false)).toBe(200);
  time=30_001;for(let i=0;i<6;i++)cadence.next(false,false);
  expect(cadence.next(false,false)).toBe(5000);
});
test('local output is readable while ordered input is awaiting validation',async()=>{
  let release!:()=>void;const waiting=new Promise<void>(r=>release=r);const seen:string[]=[];
  const request=createTerminalRequester(async r=>{seen.push(r.operation);if(r.operation==='input')await waiting;return {};},false);
  const input=request({operation:'input',sessionId:'session-fixture',data:'한글🙂'});
  await Promise.resolve();await request({operation:'read',sessionId:'session-fixture',after:0});
  expect(seen).toContain('read');release();await input;
});
test('remote mutations overtake queued polls while preserving mutation order and the wire limit',async()=>{
  const seen:{operation:string;time:number}[]=[];
  const request=createTerminalRequester(async r=>{seen.push({operation:r.operation,time:Date.now()});return {};},true);
  await Promise.all([
    request({operation:'input',sessionId:'session-fixture',data:'한글'}),
    request({operation:'read',sessionId:'session-fixture',after:0}),
    request({operation:'resize',sessionId:'session-fixture',cols:80,rows:24}),
    request({operation:'input',sessionId:'session-fixture',data:'🙂'}),
  ]);
  await request({operation:'close',sessionId:'session-fixture'});
  expect(seen.map(row=>row.operation)).toEqual(['input','resize','input','read','close']);
  for(let i=1;i<seen.length;i++)expect(seen[i]!.time-seen[i-1]!.time).toBeGreaterThanOrEqual(135);
});

test('local close bypasses a stalled response, cancels queued text, and leaves another session usable',async()=>{
  let releaseInput!:()=>void,releaseClose!:()=>void;
  const inputGate=new Promise<void>(resolve=>{releaseInput=resolve;}),closeGate=new Promise<void>(resolve=>{releaseClose=resolve;});
  const seen:string[]=[];
  const request=createTerminalRequester(async r=>{
    seen.push(r.operation==='input'?r.data!:r.operation);
    if(r.operation==='input'&&r.data==='held')await inputGate;
    if(r.operation==='close')await closeGate;
    return {};
  },false);
  const held=request({operation:'input',sessionId:'session-alpha',data:'held'});
  const queued=Promise.allSettled([
    request({operation:'input',sessionId:'session-alpha',data:'discarded'}),
    request({operation:'resize',sessionId:'session-alpha',cols:80,rows:24}),
  ]);
  const closeA=request({operation:'close',sessionId:'session-alpha'}),closeB=request({operation:'close',sessionId:'session-alpha'});
  expect(seen).toEqual(['held','close']);
  expect((await queued).every(result=>result.status==='rejected')).toBe(true);
  await expect(request({operation:'input',sessionId:'session-alpha',data:'after close'})).rejects.toThrow('취소');
  await request({operation:'input',sessionId:'session-bravo',data:'other session'});
  releaseClose();await Promise.all([closeA,closeB]);releaseInput();await held;
  expect(seen).toEqual(['held','close','other session']);
});

for(const remote of [false,true])for(const operation of remote?['input','read'] as const:['input'] as const){
  test(`${remote?'remote':'local'} ${operation} backlog is bounded and close releases queued requests without waiting for transport`,async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const seen:string[]=[];
    const request=createTerminalRequester(async r=>{seen.push(r.operation);if(r.operation!=='close')await gate;return{};},remote);
    const make=()=>operation==='input'?{operation:'input' as const,sessionId:'session-fixture',data:'x'}:{operation:'read' as const,sessionId:'session-fixture',after:0};
    const pending=Promise.allSettled(Array.from({length:TERMINAL_REQUESTER_MAX_PENDING},()=>request(make())));
    await expect(request(make())).rejects.toThrow('대기 중인 터미널 요청');
    const close=request({operation:'close',sessionId:'session-fixture'});
    await close;
    expect(seen).toContain('close');expect(seen.filter(value=>value===operation).length).toBeLessThanOrEqual(1);
    release();const results=await pending;
    expect(results.filter(result=>result.status==='rejected').length).toBeGreaterThanOrEqual(TERMINAL_REQUESTER_MAX_PENDING-1);
    await request({operation:'list'});
  });
}
test('remote output and inventory get fair slots during a pending input burst',async()=>{
  const seen:string[]=[];
  const request=createTerminalRequester(async r=>{seen.push(r.operation==='input'?r.data!:r.operation);return {};},true);
  await Promise.all([
    ...Array.from({length:8},(_,i)=>request({operation:'input',sessionId:'session-fixture',data:String(i)})),
    request({operation:'read',sessionId:'session-fixture',after:0}),
    request({operation:'list'}),
  ]);
  expect(seen).toEqual(['0','1','2','3','read','4','5','6','7','list']);
});
test('remote transport failures settle their request and allow subsequent queued work',async()=>{
  const request=createTerminalRequester(async r=>{
    if(r.operation==='input')throw new Error('transport unavailable');
    return {sessions:[]};
  },true);
  const failed=request({operation:'input',sessionId:'session-fixture',data:'한글'});
  const output=request({operation:'list'});
  await expect(failed).rejects.toThrow('transport unavailable');
  expect(await output).toEqual({sessions:[]});
});

test('driving another device reads on a slower beat — one read there is two hops', () => {
  let clock = 0;
  const remote = createTerminalReadCadence(true, () => clock);
  const slow = createTerminalReadCadence(true, () => clock, {slow: true});
  // 출력이 이어지는 동안은 거의 바로 다시 읽는다(한 번에 하나만 읽으므로 쌓이지 않는다).
  expect(remote.next(true, false)).toBe(200);
  expect(slow.next(true, false)).toBe(250);
  // 조용하면 둘 다 물러나지만 상한이 다르다(5초 vs 8초).
  const backoff = (c: {next(a: boolean, b: boolean): number}) => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = c.next(false, false);
    return last;
  };
  expect(backoff(remote)).toBe(5000);
  expect(backoff(slow)).toBe(8000);
  // 더 읽을 것이 남았으면 즉시 — 느린 박자도 같다(밀린 출력을 늦게 보여주지 않는다).
  expect(slow.next(false, true)).toBe(0);
});

// One submission cut for the wire must arrive whole or not past the first failure: sending the rest typed the start
// and the end without the middle — a different command, Enter included. The phone's queue even puts a read between
// the parts, and the next draft typed while the failure was still unknown followed the orphaned prefix (review 2026-10-09).
for (const remote of [true, false]) {
  test(`${remote ? 'remote' : 'local'}: after a failed part, neither the rest of it nor the next queued input is sent — one message`, async () => {
    const wire: string[] = [];
    const request = createTerminalRequester(async r => {
      if (r.operation === 'input') wire.push(r.data!.slice(0, 6));
      if (r.operation === 'input' && r.data!.startsWith('PART-2')) throw new Error('relay lost it');
      return {};
    }, remote);
    // A long submission is cut into several parts (splitTerminalSubmission); each label marks one part on the wire.
    expect(splitTerminalSubmission('x'.repeat(9000) + '\r').length).toBe(3);
    const group = terminalSubmissionGroup();
    const labelled = ['PART-1' + 'a'.repeat(100), 'PART-2' + 'b'.repeat(100), 'PART-3' + 'c'.repeat(100) + '\r'];
    const outcomes = await Promise.allSettled([
      ...labelled.map(data => request({operation: 'input', sessionId: 'session-fixture', data}, {group})),
      request({operation: 'input', sessionId: 'session-fixture', data: 'main\r'}),     // the next draft, sent meanwhile
      request({operation: 'input', sessionId: 'other-session', data: 'OTHER1'}),       // another session is untouched
      ...(remote ? [request({operation: 'list'})] : []),
    ]);
    // Neither PART-3+Enter nor `main\r` reached the CLI; another session's queue is independent (its order is not).
    expect(wire.filter(item => item !== 'OTHER1')).toEqual(['PART-1', 'PART-2']);
    expect(wire).toContain('OTHER1');
    expect(outcomes.map(o => o.status as string)).toEqual(['fulfilled', 'rejected', 'rejected', 'rejected', 'fulfilled', ...(remote ? ['fulfilled'] : [])]);
    const reasons = outcomes.filter(o => o.status === 'rejected').map(o => (o as PromiseRejectedResult).reason);
    expect(String(reasons[0].message)).toBe(`relay lost it ${PARTIAL_SUBMISSION_NOTICE}`);   // the real cause first
    expect(reasons.slice(1).every(reason => reason.partOfFailedSubmission === true)).toBe(true);  // the rest stay quiet
    // A later submission is its own group and goes through.
    await request({operation: 'input', sessionId: 'session-fixture', data: 'NEXT-1\r'}, {group: terminalSubmissionGroup()});
    expect(wire.at(-1)).toBe('NEXT-1');
  });
}

test('a part refused by the full queue fails its group: the parts queued before it never go out alone', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wire: string[] = [];
  const request = createTerminalRequester(async r => { await gate; if (r.operation === 'input') wire.push(r.data!); return {}; }, true);
  const fillers = Array.from({length: TERMINAL_REQUESTER_MAX_PENDING - 1}, (_, index) => request({operation: 'input', sessionId: 'filler', data: `f${index}`}).catch(() => undefined));
  const group = terminalSubmissionGroup();
  const first = request({operation: 'input', sessionId: 's', data: 'P1'}, {group});
  const refused = request({operation: 'input', sessionId: 's', data: 'P2\r'}, {group});
  await expect(refused).rejects.toThrow(PARTIAL_SUBMISSION_NOTICE);
  const closing = request({operation: 'close', sessionId: 'filler'});   // drop the queued fillers (the wire is throttled)
  release();
  await expect(first).rejects.toThrow();
  await Promise.all([...fillers, closing]);
  expect(wire).not.toContain('P1');
});

function lanQueue() {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('function terminalRequest(request,group){');
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('function terminalDisconnected(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const wire: string[] = [];
  const shown: string[] = [];
  const build = new Function('wire', 'shown', `
    const TERMINAL_MAX_PENDING = 64;
    const terminalRequests = new Set();
    const terminalClosing = new Set();
    const terminalError = { set textContent(value) { shown.push(value); } };
    let terminalAdmission = Promise.resolve(), terminalNextAt = 0, terminalWire = Promise.resolve();
    let terminalInputSession = '', terminalPending = '', terminalInputTimer = null, terminalInputReceipt = null;
    function terminalCancelled() { const e = new Error('cancelled'); e.cancelled = true; return e; }
    async function terminalWireRequest(request) {
      wire.push(request.data.slice(0, 6));
      if (request.data.startsWith('PART-2')) throw new Error('rate limited');
      return {};
    }
    ${REMOTE_CONTROL_MOBILE_JS.slice(start, end)}
    return { terminalQueue, terminalCancelUnsent };
  `);
  return {wire, shown, ...(build(wire, shown) as {terminalQueue: (request: unknown, group: unknown) => Promise<unknown>; terminalCancelUnsent: (sessionId?: string) => boolean})};
}

test('LAN page: after a failed part, neither the rest of the batch nor the next input is sent — one message (run as shipped)', async () => {
  const lan = lanQueue();
  const group = {failed: false};
  await Promise.all([
    ...['PART-1', 'PART-2', 'PART-3\r'].map(data => lan.terminalQueue({operation: 'input', sessionId: 's', data}, group)),
    lan.terminalQueue({operation: 'input', sessionId: 's', data: 'main\r'}, null),
  ]);
  expect(lan.wire).toEqual(['PART-1', 'PART-2']);
  expect(lan.shown).toEqual([`rate limited 입력 일부만 전달됐을 수 있습니다 — CLI 입력칸에 남은 글을 지운 뒤 다시 보내세요.`]);
}, 10_000);

test('LAN page: cancelling unsent input (session switch) shows no error for the rest of the batch', async () => {
  const lan = lanQueue();
  const group = {failed: false};
  const sent = ['PART-1', 'PART-X', 'PART-Y'].map(data => lan.terminalQueue({operation: 'input', sessionId: 's', data}, group));
  lan.terminalCancelUnsent('s');
  await Promise.all(sent);
  expect(lan.shown).toEqual([]);
}, 10_000);

// A part the phone kept (REMOTE_CONTROL_REQUEST_UNSENT) is not lost: the controller sends that exact envelope once when
// the screen reconnects. 「…지운 뒤 다시 보내세요」 then typed the whole command a second time (review 2026-10-10).
const held = (message: string) => Object.assign(new Error(message), {code: 'REMOTE_CONTROL_REQUEST_UNSENT'});
test('remote: the last part held on the phone keeps its own words and code — no invitation to send again', async () => {
  const wire: string[] = [];
  const request = createTerminalRequester(async r => {
    if (r.operation === 'input') wire.push(r.data!.slice(0, 6));
    if (r.operation === 'input' && r.data!.startsWith('PART-2')) throw held('한 번만 보냅니다 — 두 번 실행되지 않으니 다시 누르지 마세요.');
    return {};
  }, true);
  const group = terminalSubmissionGroup();
  const outcomes = await Promise.allSettled(['PART-1aaa', 'PART-2bbb\r'].map(data => request({operation: 'input', sessionId: 's', data}, {group})));
  const reason = (outcomes[1] as PromiseRejectedResult).reason;
  expect(reason.code).toBe('REMOTE_CONTROL_REQUEST_UNSENT');
  expect(reason.message).not.toContain(PARTIAL_SUBMISSION_NOTICE);
  expect(reason.message).toContain('다시 누르지 마세요');
  // Nothing of this submission was dropped, so a later draft is not silently swallowed with it.
  await request({operation: 'input', sessionId: 's', data: 'NEXT-1\r'}).catch(() => undefined);
  expect(wire.at(-1)).toBe('NEXT-1');
});

test('remote: a held middle part says the later parts were not sent, keeps the code, and sends nothing after it', async () => {
  const wire: string[] = [];
  const request = createTerminalRequester(async r => {
    if (r.operation === 'input') wire.push(r.data!.slice(0, 6));
    if (r.operation === 'input' && r.data!.startsWith('PART-2')) throw held('held');
    return {};
  }, true);
  const group = terminalSubmissionGroup();
  const outcomes = await Promise.allSettled(['PART-1a', 'PART-2b', 'PART-3c\r'].map(data => request({operation: 'input', sessionId: 's', data}, {group})));
  expect(wire).toEqual(['PART-1', 'PART-2']);
  const reason = (outcomes[1] as PromiseRejectedResult).reason;
  expect(reason.code).toBe('REMOTE_CONTROL_REQUEST_UNSENT');
  expect(reason.message).toBe(HELD_PART_NOTICE);
  expect(reason.message).not.toContain(PARTIAL_SUBMISSION_NOTICE);
  expect((outcomes[2] as PromiseRejectedResult).reason.partOfFailedSubmission).toBe(true);
});

test('the held-request code is the controller\'s', async () => {
  const {REMOTE_CONTROL_REQUEST_UNSENT} = await import('../src/remoteControlRelayController');
  expect(REMOTE_CONTROL_REQUEST_UNSENT).toBe('REMOTE_CONTROL_REQUEST_UNSENT');
  const source = await Bun.file(new URL('../src/aiTerminalScheduling.ts', import.meta.url)).text();
  expect(source).toContain(`'${REMOTE_CONTROL_REQUEST_UNSENT}'`);
});
