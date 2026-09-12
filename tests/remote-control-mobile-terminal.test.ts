import {expect, test} from 'bun:test';
import vm from 'node:vm';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

/** Execute the shipped template output, not a second copy of the input logic.
 * Everything outside the terminal controller is replaced with a fake DOM,
 * clock and socket. No LAN listener, credentials, PTY or AI is involved. */
function fixture(hold: string[] = [], options: {storage?:Map<string,string>;token?:string;savedToken?:string;projects?:{controlId:string;name:string}[];sessions?:any[];restore?:boolean} = {}) {
  const start=REMOTE_CONTROL_MOBILE_JS.indexOf('const terminalWaiters=');
  const end=REMOTE_CONTROL_MOBILE_JS.indexOf('let actionSequence =',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  let now=0,nextTimer=0,nextRequest=0;
  const storage=options.storage??new Map<string,string>();
  const timers=new Map<number,{at:number;callback:()=>void}>();
  const sent:{request:any;at:number}[]=[],written:string[]=[];
  const nodes=new Map<string,any>();
  const node=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,clientWidth:390,hidden:false,
      children:[] as any[],replaceChildren(...items:any[]){this.children=items;},add(item:any){this.children.push(item);}});
    return nodes.get(id);
  };
  const context=vm.createContext({TextEncoder,Promise,Map,Set,Error,
    Date:class extends Date {static override now(){return now;}},
    performance:{now:()=>now},
    setTimeout:(callback:()=>void,delay=0)=>{const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},
    clearTimeout:(id:number)=>timers.delete(id),
    document:{querySelector:(selector:string)=>node(selector.slice(1)),getElementById:node},
    Option:class {constructor(public text:string,public value:string){}},
    ResizeObserver:class {observe(){}},
    window:{Terminal:class {cols=80;rows=24;open(){}onData(){}reset(){written.length=0;}write(text:string){written.push(text);}resize(cols:number,rows:number){this.cols=cols;this.rows=rows;}}},
    WebSocket:{OPEN:1},sessionToken:options.token??'fixture-token',
    loadSavedSession:()=>options.savedToken??'fixture-token',
    localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    nextActionId:()=>`fixture-request-${++nextRequest}`,
  });
  const run=(code:string)=>vm.runInContext(code,context);
  const reply=(request:any,body:any)=>{
    context.fixtureReply={requestId:request.requestId,ok:true,body};run('terminalReply(fixtureReply)');
  };
  context.socket={readyState:1,send:(raw:string)=>{
    const {request}=JSON.parse(raw);sent.push({request,at:now});
    if(hold.includes(request.operation))return;
    const body=request.operation==='list'?{sessions:options.sessions??[{id:'session-A',agent:'codex',targetId:'fixture-project',state:'running'},{id:'session-B',agent:'claude',targetId:'fixture-project',state:'running'}]}
      :request.operation==='start'?{session:{id:'session-new',agent:request.agent,state:'running'}}
      :{session:{id:request.sessionId,state:request.operation==='close'?'exited':'running'},chunks:[],hasMore:false};
    reply(request,body);
  }};
  run(REMOTE_CONTROL_MOBILE_JS.slice(start,end));
  context.fixtureProjects=options.projects??[{controlId:'fixture-project',name:'Fixture project'}];
  run('terminalReady(fixtureProjects)');
  if(!options.restore){node('terminal-project').value='fixture-project';node('terminal-agent').value='codex';}
  const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
  const advance=async(ms:number)=>{
    await settle();const until=now+ms;let iterations=0;
    for(;;){
      const due=[...timers.entries()].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;if(++iterations>5000)throw new Error('Fake timer loop');
      now=due[1].at;timers.delete(due[0]);due[1].callback();await settle();
    }
    now=until;await settle();
  };
  const input=(text:string)=>{context.fixtureInput=text;return run('terminalInput(fixtureInput)');};
  const requests=(operation:string)=>sent.filter(item=>item.request.operation===operation).map(item=>item.request);
  return {run,node,sent,written,reply,advance,settle,input,requests,storage};
}

test('switching sessions before the 180ms batch expires cannot send B input to A',async()=>{
  const f=fixture();f.run("terminalSelect('session-A')");f.input('not-yet-sent A');
  await f.advance(80);f.run("terminalSelect('session-B')");f.input('only B\r');await f.advance(600);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B',data:'only B\r'}]);
  expect(f.node('terminal-error').textContent).toContain('아직 보내지 않은 입력을 취소');
});

test('switching cancels queued old-session input even when a read response is stalled',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  f.input('queued A\r');await f.advance(200);f.run("terminalSelect('session-B')");f.input('B\r');
  f.reply(f.requests('read')[0],{session:{state:'running'},chunks:[],hasMore:false});await f.advance(600);
  const newRead=f.requests('read').find(request=>request.sessionId==='session-B');
  f.reply(newRead,{session:{state:'running'},chunks:[],hasMore:false});await f.advance(200);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B',data:'B\r'}]);
});

test('close cancels batches and queued writes, bypasses a stalled read, and deduplicates repeated clicks',async()=>{
  const f=fixture(['read','close']);f.run("terminalSelect('session-A')");await f.settle();
  f.input('queued before close');await f.advance(200);f.input('batch before close');
  void f.node('terminal-close').onclick();void f.node('terminal-close').onclick();await f.advance(400);
  expect(f.requests('close')).toHaveLength(1);expect(f.requests('input')).toHaveLength(0);
  expect(f.sent.find(item=>item.request.operation==='close')!.at).toBeLessThan(1000);
  expect(f.input('after close click')).toBe(false);
  f.reply(f.requests('close')[0],{session:{state:'exited'}});
  f.reply(f.requests('read')[0],{session:{state:'running'},chunks:[{seq:1,text:'STALE'}],hasMore:false});
  await f.advance(400);expect(f.written).toEqual([]);expect(f.requests('input')).toHaveLength(0);
});

test('A to B to A discards the earlier A read and does not create a second polling loop',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  f.run("terminalSelect('session-B');terminalSelect('session-A')");
  f.reply(f.requests('read')[0],{session:{state:'running'},chunks:[{seq:99,text:'OLD A'}],hasMore:false});await f.advance(300);
  expect(f.written).toEqual([]);expect(f.requests('read').map(request=>request.sessionId)).toEqual(['session-A','session-A']);
  f.reply(f.requests('read')[1],{session:{state:'running'},chunks:[{seq:1,text:'NEW A'}],hasMore:false});await f.advance(650);
  expect(f.written).toEqual(['NEW A']);expect(f.requests('read')).toHaveLength(2);
});

test('pending requests and pasted input are bounded without partially sending a rejected batch',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  f.run("for(let i=0;i<300;i++)void terminalQueue({operation:'resize',sessionId:'session-A',cols:80,rows:24})");await f.settle();
  expect(f.run('terminalRequests.size')).toBe(128);
  expect(f.node('terminal-error').textContent).toContain('대기열이 가득');
  f.input('batch rejected atomically');await f.advance(200);
  expect(f.node('terminal-error').textContent).toContain('이번 입력은 보내지 않았습니다');
  expect(f.requests('input')).toHaveLength(0);
  expect(f.input('한'.repeat(12000))).toBe(false);expect(f.run('terminalPending')).toBe('');
  f.node('terminal-line').value='x'.repeat(32769);f.node('terminal-send').onclick();
  expect(f.node('terminal-line').value).toHaveLength(32769);
});

test('accepted Unicode and escaped input preserve bytes within each wire limit',async()=>{
  const f=fixture();f.run("terminalSelect('session-A')");const text=('한글😀\u0003\\\"').repeat(450);
  expect(f.input(text)).toBe(true);await f.advance(1500);
  const requests=f.requests('input');expect(requests.map(request=>request.data).join('')).toBe(text);
  expect(requests.length).toBeGreaterThan(1);
  for(const request of requests){expect(Buffer.byteLength(request.data)).toBeLessThanOrEqual(4096);expect(Buffer.byteLength(JSON.stringify(request.data))-2).toBeLessThanOrEqual(7500);expect(request.sessionId).toBe('session-A');}
});

test('new terminal double clicks make one request and an unknown result never auto-retries',async()=>{
  const f=fixture(['start']);void f.node('terminal-start').onclick();void f.node('terminal-start').onclick();await f.settle();
  expect(f.requests('start')).toHaveLength(1);expect(f.node('terminal-start').disabled).toBe(true);
  await f.advance(15100);expect(f.requests('start')).toHaveLength(1);expect(f.node('terminal-start').disabled).toBe(false);
  expect(f.node('terminal-error').textContent).toContain('전달되었을 수 있으므로 화면을 확인');
});

test('disconnect cancels unsent requests and batches, releases waiters, and never replays on reconnect',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  f.input('queued');await f.advance(200);f.input('not batched');f.run('terminalDisconnected();socket.readyState=3');await f.settle();
  expect(f.run('terminalWaiters.size')).toBe(0);expect(f.run('terminalRequests.size')).toBe(0);
  f.run('socket.readyState=1');await f.advance(20000);
  expect(f.requests('input')).toHaveLength(0);expect(f.requests('read')).toHaveLength(1);
});

test('a priority close still waiting for its wire slot cannot cross a disconnected socket',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  void f.node('terminal-close').onclick();await f.settle();
  expect(f.requests('close')).toHaveLength(0);
  f.run('terminalDisconnected();socket.readyState=3');await f.settle();f.run('socket.readyState=1');await f.advance(1000);
  expect(f.requests('close')).toHaveLength(0);expect(f.run('terminalRequests.size')).toBe(0);
});

test('the actual send button preserves a line rejected at delayed queue admission without replaying it',async()=>{
  const f=fixture(['read']);f.run("terminalSelect('session-A')");await f.settle();
  f.run("for(let i=0;i<127;i++)void terminalQueue({operation:'resize',sessionId:'session-A',cols:80,rows:24})");
  const field=f.node('terminal-line'),button=f.node('terminal-send');field.value='보존해야 하는 전송 초안';field.oninput();
  button.onclick();button.onclick();
  expect(field.value).toBe('보존해야 하는 전송 초안');expect(button.disabled).toBe(true);
  await f.advance(180);
  expect(field.value).toBe('보존해야 하는 전송 초안');expect(button.disabled).toBe(false);
  expect(f.requests('input')).toHaveLength(0);expect(f.run('terminalPending')).toBe('');
  expect(f.run('terminalInputReceipt')).toBeNull();expect(f.run('terminalRequests.size')).toBe(128);
  f.run('terminalDisconnected()');await f.advance(20000);
  expect(f.requests('input')).toHaveLength(0);expect(field.value).toBe('보존해야 하는 전송 초안');
});

test('line admission clears only the unchanged draft and cannot clear edits that return to the same text',async()=>{
  const f=fixture();f.run("terminalSelect('session-A')");
  const field=f.node('terminal-line'),button=f.node('terminal-send');field.value='첫 번째 줄';field.oninput();button.onclick();
  await f.advance(100);expect(field.value).toBe('첫 번째 줄');
  await f.advance(100);expect(field.value).toBe('');expect(button.disabled).toBe(false);
  field.value='다시 작성한 줄';field.oninput();button.onclick();
  field.value='편집 중';field.oninput();field.value='다시 작성한 줄';field.oninput();
  await f.advance(400);
  expect(field.value).toBe('다시 작성한 줄');
  expect(f.requests('input').map(request=>request.data)).toEqual(['첫 번째 줄\r','다시 작성한 줄\r']);
  expect(f.run('terminalInputReceipt')).toBeNull();
});

test('switching with a pending line keeps its draft and only an explicit new click sends to the next session',async()=>{
  const f=fixture();f.run("terminalSelect('session-A')");
  const field=f.node('terminal-line'),button=f.node('terminal-send');field.value='A 전용 초안';field.oninput();button.onclick();
  await f.advance(50);f.node('terminal-session').onchange({target:{value:'session-B'}});
  expect(field.value).toBe('A 전용 초안');expect(button.disabled).toBe(false);
  await f.advance(300);expect(f.requests('input')).toHaveLength(0);
  field.value='B 전용 초안';field.oninput();button.onclick();await f.advance(400);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B',data:'B 전용 초안\r'}]);
});

for(const switchedDuring of ['start','list'])test(`a late start cannot steal the selection changed during ${switchedDuring} or cancel its pending input`,async()=>{
  const f=fixture(['start','list']);f.run("terminalSelect('session-A')");await f.advance(200);
  void f.node('terminal-start').onclick();await f.settle();expect(f.requests('start')).toHaveLength(1);
  if(switchedDuring==='start')f.node('terminal-session').onchange({target:{value:'session-B'}});
  f.reply(f.requests('start')[0],{session:{id:'session-new',agent:'codex',targetId:'fixture-project',state:'running'}});await f.advance(400);
  expect(f.requests('list')).toHaveLength(1);
  if(switchedDuring==='list')f.node('terminal-session').onchange({target:{value:'session-B'}});
  const field=f.node('terminal-line');field.value='B 선택 뒤 아직 전송 대기 중인 줄';field.oninput();f.node('terminal-send').onclick();await f.advance(50);
  f.reply(f.requests('list')[0],{sessions:['session-A','session-B','session-new'].map(id=>({id,agent:'codex',targetId:'fixture-project',state:'running'}))});await f.settle();
  expect(f.run('terminalSelected')).toBe('session-B');expect(f.node('terminal-start').disabled).toBe(false);
  expect(field.value).toBe('B 선택 뒤 아직 전송 대기 중인 줄');
  await f.advance(500);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B',data:'B 선택 뒤 아직 전송 대기 중인 줄\r'}]);
});

test('memory button prepares an editable line without sending, replacing a draft or adding memory authority',async()=>{
  const f=fixture();f.node('terminal-remember').onclick();expect(f.node('terminal-line').value).toBe('');
  f.run("terminalSelect('session-A')");await f.advance(200);
  f.node('terminal-remember').onclick();const draft=f.node('terminal-line').value;
  expect(draft).toContain('remember-session');expect(f.node('terminal-memory-guide').hidden).toBe(false);
  await f.advance(500);expect(f.requests('input')).toHaveLength(0);
  f.node('terminal-line').value='Keep this existing draft';f.node('terminal-line').oninput();f.node('terminal-remember').onclick();
  expect(f.node('terminal-line').value).toBe('Keep this existing draft');
  f.node('terminal-line').value='';f.node('terminal-remember').onclick();f.node('terminal-send').onclick();await f.advance(800);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-A',data:draft+'\r'}]);
  expect(f.sent.every(({request})=>['read','input'].includes(request.operation))).toBe(true);
  f.run('terminalDisconnected()');expect(f.node('terminal-remember').disabled).toBe(true);
});


test('cold reconnect restores exact target agent and existing session without a new start or input',async()=>{
  const projects=[{controlId:'fixture-A',name:'Same name'},{controlId:'fixture-B',name:'Same name'}];
  const sessions=[{id:'session-B',targetId:'fixture-B',agent:'claude',state:'running'}];
  const warm=fixture([],{projects,sessions});
  warm.node('terminal-project').value='fixture-B';warm.node('terminal-agent').value='claude';warm.run("terminalSelect('session-B')");
  expect([...warm.storage.values()].join('')).not.toContain('fixture-token');
  const cold=fixture([],{projects,sessions,storage:warm.storage,restore:true});await cold.advance(500);
  expect(cold.node('terminal-project').value).toBe('fixture-B');expect(cold.node('terminal-agent').value).toBe('claude');
  expect(cold.run('terminalSelected')).toBe('session-B');expect(cold.requests('read')[0].sessionId).toBe('session-B');
  expect(cold.requests('start')).toHaveLength(0);expect(cold.requests('input')).toHaveLength(0);
});

test('missing remembered project never falls back to another same-name project and later pages can restore it',async()=>{
  const storage=new Map([['agentstoz-terminal-selection-v1',JSON.stringify({version:1,targetId:'fixture-B',agent:'claude',sessionId:'session-B'})]]);
  const cold=fixture([],{storage,restore:true,projects:[{controlId:'fixture-A',name:'Same name'}]});
  expect(cold.node('terminal-project').value).toBe('');void cold.node('terminal-start').onclick();await cold.advance(400);
  expect(cold.requests('start')).toHaveLength(0);
  cold.run("terminalReady([{controlId:'fixture-A',name:'Same name'},{controlId:'fixture-B',name:'Same name'}])");
  expect(cold.node('terminal-project').value).toBe('fixture-B');
});

test('a new pairing cannot inherit remembered target or session and a stale session target is rejected',async()=>{
  const record=JSON.stringify({version:1,targetId:'fixture-project',agent:'codex',sessionId:'session-A'});
  const fresh=fixture([],{storage:new Map([['agentstoz-terminal-selection-v1',record]]),token:'new-pairing',savedToken:'fixture-token',restore:true});
  await fresh.advance(400);expect(fresh.run('terminalSelected')).toBe('');expect(fresh.requests('read')).toHaveLength(0);
  expect(fresh.storage.has('agentstoz-terminal-selection-v1')).toBe(false);
  const stale=fixture([],{storage:new Map([['agentstoz-terminal-selection-v1',record]]),restore:true,sessions:[{id:'session-A',targetId:'other-project',agent:'codex',state:'running'}]});
  await stale.advance(400);expect(stale.run('terminalSelected')).toBe('');expect(stale.requests('read')).toHaveLength(0);expect(stale.requests('start')).toHaveLength(0);
  expect(stale.node('terminal-error').textContent).toContain('현재 프로젝트에서 확인되지');
});
