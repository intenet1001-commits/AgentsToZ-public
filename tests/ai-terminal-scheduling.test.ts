import {test,expect} from 'bun:test';
import {createTerminalRequester, createTerminalReadCadence, TERMINAL_REQUESTER_MAX_PENDING} from '../src/aiTerminalScheduling';
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
test('remote wake resets idle backoff without a high-frequency polling burst',()=>{
  const cadence=createTerminalReadCadence(true,()=>0);
  for(let i=0;i<10;i++)cadence.next(false,false);
  cadence.wake();expect(cadence.next(false,false)).toBe(1400);
  expect(cadence.next(true,false)).toBe(700);
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
