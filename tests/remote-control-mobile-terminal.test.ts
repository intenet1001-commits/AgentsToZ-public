import {expect, test} from 'bun:test';
import vm from 'node:vm';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

/** Execute the shipped template output, not a second copy of the input logic.
 * Everything outside the terminal controller is replaced with a fake DOM,
 * clock and socket. No LAN listener, credentials, PTY or AI is involved. */
function fixture(hold: string[] = [], options: {storage?:Map<string,string>;token?:string;savedToken?:string;projects?:{controlId:string;name:string}[];sessions?:any[];restore?:boolean;
  /** Text a `read` from 0 returns per session: what that CLI's screen shows. */
  screens?:Record<string,string>;
  /** The route dialog's answer, and a hook that runs while it is open. */
  confirmResult?:boolean;onConfirm?:(message:string)=>void;
  /** Later lists also contain the sessions this page started. */
  listStarted?:boolean} = {}) {
  const start=REMOTE_CONTROL_MOBILE_JS.indexOf('const terminalWaiters=');
  const end=REMOTE_CONTROL_MOBILE_JS.indexOf('let actionSequence =',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  let now=0,nextTimer=0,nextRequest=0;
  const storage=options.storage??new Map<string,string>();
  const timers=new Map<number,{at:number;callback:()=>void}>();
  const sent:{request:any;at:number}[]=[],written:string[]=[],confirms:string[]=[];
  const resizeCallbacks:(()=>void)[]=[];
  const nodes=new Map<string,any>();
  const node=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,clientWidth:390,clientHeight:400,hidden:false,selectedOptions:[{text:'Codex'}],style:{setProperty(){}},querySelector:()=>({getBoundingClientRect:()=>({height:14})}),
      children:[] as any[],replaceChildren(...items:any[]){this.children=items;},append(item:any){this.children.push(item);},add(item:any){this.children.push(item);}});
    return nodes.get(id);
  };
  const screens:Record<string,string>={...options.screens};
  const started:any[]=[];
  const context=vm.createContext({TextEncoder,Promise,Map,Set,Error,
    Date:class extends Date {static override now(){return now;}},
    performance:{now:()=>now},
    setTimeout:(callback:()=>void,delay=0)=>{const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},
    clearTimeout:(id:number)=>timers.delete(id),
    confirm:(message:string)=>{confirms.push(message);options.onConfirm?.(message);return options.confirmResult??true;},
    document:{querySelector:(selector:string)=>node(selector.slice(1)),getElementById:node,createElement:()=>({type:'',textContent:'',onclick:null,setAttribute(){}})},
    Option:class {constructor(public text:string,public value:string){}},
    ResizeObserver:class {constructor(callback:()=>void){resizeCallbacks.push(callback);}observe(){}},
    // The page's terminal, plus the throwaway ones it creates (scrollback 0) to read a screen:
    // those keep the written text and expose it as rows, like xterm's buffer (escapes dropped).
    window:{Terminal:class {cols=80;rows=24;screen?:string;
      constructor(options:any={}){if(options.scrollback===0){this.cols=options.cols;this.rows=options.rows;this.screen='';}}
      open(){}onData(){}reset(){written.length=0;}dispose(){}
      write(text:string,callback?:()=>void){if(this.screen===undefined){written.push(text);return;}this.screen+=text;callback?.();}
      resize(cols:number,rows:number){this.cols=cols;this.rows=rows;}
      get buffer(){const rows=(this.screen??'').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').split(/\r?\n/).slice(-this.rows);while(rows.length<this.rows)rows.push('');
        return {active:{baseY:0,getLine:(y:number)=>({translateToString:()=>rows[y]??''})}};}}},
    WebSocket:{OPEN:1},sessionToken:options.token??'fixture-token',
    loadSavedSession:()=>options.savedToken??'fixture-token',
    localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},
    nextActionId:()=>`fixture-request-${++nextRequest}`,
  });
  const run=(code:string)=>vm.runInContext(code,context);
  const reply=(request:any,body:any)=>{
    context.fixtureReply={requestId:request.requestId,ok:true,body};run('terminalReply(fixtureReply)');
  };
  const fail=(request:any,error:string)=>{
    context.fixtureReply={requestId:request.requestId,ok:false,error};run('terminalReply(fixtureReply)');
  };
  const rawSent:string[]=[];
  context.socket={readyState:1,send:(raw:string)=>{
    rawSent.push(raw);
    const {request}=JSON.parse(raw);sent.push({request,at:now});
    if(hold.includes(request.operation))return;
    if(request.operation==='start')started.push({id:'session-new',agent:request.agent,targetId:request.targetId,state:'running'});
    const listed=options.sessions??[{id:'session-A',agent:'codex',targetId:'fixture-project',state:'running'},{id:'session-B',agent:'claude',targetId:'fixture-project',state:'running'}];
    const text=screens[request.sessionId];
    const body=request.operation==='list'?{sessions:[...listed,...(options.listStarted?started:[])]}
      :request.operation==='start'?{session:{id:'session-new',agent:request.agent,state:'running'}}
      :{session:{id:request.sessionId,state:request.operation==='close'?'exited':'running'},chunks:request.operation==='read'&&request.after<1&&text?[{seq:1,text}]:[],hasMore:false};
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
  return {run,node,sent,rawSent,written,confirms,reply,fail,advance,settle,input,requests,storage,screens,context,resize:()=>resizeCallbacks.forEach(callback=>callback())};
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

// Updated 2026-09-29: an @ route no longer always starts a session with the sender's AI and then
// types into it. It picks an AI, delivers to that AI's running session in the target when one runs,
// and otherwise starts a session with the handoff as its first request (no typing into a CLI that
// is still starting). The previous single test asserted the old start-then-type behavior.
const routeProjects=[{controlId:'fixture-A',name:'Source project'},{controlId:'fixture-B',name:'Target project'}];
const routeTask='대상 프로젝트에서 이 요청을 처리해 주세요.';
test('a confirmed @ route with no running session of the chosen AI starts one with the handoff as its first request',async()=>{
  const f=fixture(['list'],{projects:routeProjects});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  // Nothing is known to run in the target yet, so the sender's AI is suggested; the user picks another.
  expect(f.node('terminal-route-agent-field').hidden).toBe(false);
  expect(f.node('terminal-route-agent').value).toBe('codex');
  f.node('terminal-route-agent').value='claude';
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(200);
  // A fresh list decides; a running Codex session in the target does not receive a Claude handoff.
  f.reply(f.requests('list')[0],{sessions:[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'},{id:'session-B-codex',targetId:'fixture-B',agent:'codex',state:'running'}]});
  await f.advance(800);
  expect(f.confirms).toEqual(['‘Target project’ 프로젝트에 Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?']);
  expect(f.requests('start').map(({targetId,agent,bypassPermissions,prompt})=>({targetId,agent,bypassPermissions,prompt}))).toEqual([{targetId:'fixture-B',agent:'claude',bypassPermissions:true,
    prompt:'AgentsToZ 프로젝트 전달\n보낸 프로젝트: Source project\n보낸 AI: Codex CLI\n받는 프로젝트: Target project\n\n'+routeTask}]);
  f.reply(f.requests('list')[1],{sessions:[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'},{id:'session-new',targetId:'fixture-B',agent:'claude',state:'running'}]});
  await f.advance(1600);
  expect(f.requests('input')).toEqual([]);
  expect(f.run('terminalSelected')).toBe('session-new');expect(f.node('terminal-agent').value).toBe('claude');
  expect(field.value).toBe('');expect(f.run('terminalRouteTargetId')).toBe('');expect(f.node('terminal-route-agent-field').hidden).toBe(true);
});

test('a confirmed @ route delivers to the newest running session of the chosen AI instead of starting another',async()=>{
  const sessions=[{id:'session-A',targetId:'fixture-A',agent:'agy',state:'running',createdAt:'2026-09-29T00:00:00Z'},
    {id:'session-B-old',targetId:'fixture-B',agent:'claude',state:'running',createdAt:'2026-09-28T00:00:00Z'},
    {id:'session-B-new',targetId:'fixture-B',agent:'claude',state:'running',createdAt:'2026-09-29T01:00:00Z'},
    {id:'session-B-codex',targetId:'fixture-B',agent:'codex',state:'running',createdAt:'2026-09-29T02:00:00Z'}];
  const f=fixture([],{projects:routeProjects,sessions});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='agy';void f.run('terminalList()');await f.advance(400);
  f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  // The AI already running in the target is suggested (its newest session).
  expect(f.node('terminal-route-agent').value).toBe('codex');
  f.node('terminal-route-agent').value='claude';
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1600);
  // Updated 2026-09-29 (review M2/L4): the dialog names the receiving session (#2 of two Claude
  // sessions) and says Enter is pressed in that live session. Its screen was read and is empty here.
  expect(f.confirms).toEqual(['‘Target project’ 프로젝트에서 실행 중인 Claude Code 워크룸 세션으로 이 메시지를 전달할까요?\n받는 세션: Target project · claude #2\n실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다.']);
  expect(f.requests('start')).toHaveLength(0);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B-new',
    data:'AgentsToZ 프로젝트 전달\n보낸 프로젝트: Source project\n보낸 AI: Antigravity\n받는 프로젝트: Target project\n\n'+routeTask+'\r'}]);
  expect(f.run('terminalSelected')).toBe('session-B-new');expect(f.node('terminal-project').value).toBe('fixture-B');expect(f.node('terminal-agent').value).toBe('claude');
  expect(field.value).toBe('');expect(f.run('terminalRouteTargetId')).toBe('');
});

test('@ the current project keeps the conversation with the same AI and hands off to another AI',async()=>{
  const sessions=[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'}];
  const f=fixture([],{projects:routeProjects,sessions});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[0])");
  expect(f.node('terminal-route-agent').value).toBe('codex');
  const field=f.node('terminal-line');field.value='그대로 이어서';field.oninput();void f.node('terminal-send').onclick();
  await f.advance(600);
  expect(f.confirms).toEqual([]);expect(f.requests('list')).toHaveLength(0);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-A',data:'그대로 이어서\r'}]);
  f.run('terminalSetRoute(terminalProjects[0])');f.node('terminal-route-agent').value='hermes';
  field.value='Hermes로 검토';field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1600);
  expect(f.confirms).toEqual(['‘Source project’ 프로젝트에 Hermes 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?']);
  expect(f.requests('start').map(({targetId,agent})=>({targetId,agent}))).toEqual([{targetId:'fixture-A',agent:'hermes'}]);
});

// Updated 2026-09-29 (review H1): the first request's limit on this page is the LAN frame budget
// (~15.5 KB for the whole wire message), not 24,000 bytes of text, so the message names that limit.
test('a new-session handoff over the first-request limit keeps the draft and starts nothing',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:[]});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  const field=f.node('terminal-line');field.value='한'.repeat(8100);field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1600);
  expect(f.requests('start')).toHaveLength(0);expect(f.confirms).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('약 15KB');
  expect(field.value).toBe('한'.repeat(8100));expect(f.node('terminal-send').disabled).toBe(false);
});

// Review H1: a handoff of ~5,400 Korean characters is 16.3 KB. It passed the old 24,000-byte check,
// went out as one start frame, and the Mac answered MESSAGE_TOO_LARGE with a 1008 close that ended
// the pairing (a new QR at the Mac was the only way back). It must be refused before sending.
test('H1: a handoff between 16 KB and 24 KB is refused before sending, so the pairing is never put at risk',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'}]});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='claude';
  const value='한'.repeat(5500);expect(Buffer.byteLength(value)).toBeGreaterThan(16*1024);expect(Buffer.byteLength(value)).toBeLessThan(24_000);
  const field=f.node('terminal-line');field.value=value;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1600);
  expect(f.requests('start')).toHaveLength(0);expect(f.confirms).toEqual([]);
  expect(f.rawSent.every(raw=>Buffer.byteLength(raw)<=15.5*1024)).toBe(true);
  expect(f.node('terminal-error').textContent).toContain('약 15KB');
  expect(f.node('terminal-error').textContent).toContain('작성 중인 내용은 유지했습니다');
  expect(field.value).toBe(value);expect(f.run('terminalSelected')).toBe('session-A');expect(f.node('terminal-send').disabled).toBe(false);
});

test('H1: no request of this page goes on the wire above the LAN frame budget',async()=>{
  const f=fixture();
  f.run("terminalRequest({operation:'start',targetId:'fixture-project',agent:'codex',cols:80,rows:24,prompt:'x'.repeat(16000)}).then(()=>{fixtureOutcome='sent'},error=>{fixtureOutcome=error})");
  await f.advance(400);
  expect(f.requests('start')).toHaveLength(0);
  expect(f.context.fixtureOutcome.tooLarge).toBe(true);
  expect(f.context.fixtureOutcome.message).toContain('연결은 그대로 유지됩니다');
  expect(f.run('terminalWaiters.size')).toBe(0);
});

// Review H2: the route used to switch the project/AI dropdowns to the target before starting. When the
// start was refused they stayed switched, the route then equalled the "source", and pressing Send again
// typed the raw text into the sender's own session with no dialog and no handoff header.
test('H2: a refused new-session route keeps the sender in place, and Send again routes again instead of typing into the sender',async()=>{
  const f=fixture(['start'],{projects:routeProjects,sessions:[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'}]});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
  f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='agy';
  const field=f.node('terminal-line');field.value='테스트를 실행해 주세요';field.oninput();
  void f.node('terminal-send').onclick();
  await f.advance(800);
  expect(f.requests('start')).toHaveLength(1);
  f.fail(f.requests('start')[0],'agy CLI가 설치되어 있지 않습니다.');
  await f.advance(400);
  expect(f.run('terminalSelected')).toBe('session-A');
  expect(f.node('terminal-project').value).toBe('fixture-A');expect(f.node('terminal-agent').value).toBe('codex');
  expect(f.run('terminalRouteTargetId')).toBe('fixture-B');expect(f.node('terminal-route-agent').value).toBe('agy');
  expect(f.node('terminal-error').textContent).toContain('agy CLI가 설치되어 있지 않습니다');
  expect(field.value).toBe('테스트를 실행해 주세요');
  void f.node('terminal-send').onclick();
  await f.advance(1200);
  expect(f.requests('input')).toEqual([]);
  expect(f.requests('start')).toHaveLength(2);
  expect(f.confirms).toHaveLength(2);
  expect(f.requests('start')[1]).toMatchObject({targetId:'fixture-B',agent:'agy'});
});

test('H2: the sender is the selected session itself, even if the dropdowns were left on another project',async()=>{
  const sessions=[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running',createdAt:'2026-09-29T00:00:00Z'}];
  const f=fixture([],{projects:routeProjects,sessions});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';void f.run('terminalList()');await f.advance(400);
  f.run("terminalSelect('session-A')");
  // A stale view (as the old route left it): the dropdowns claim fixture-B/agy while session-A is selected.
  f.node('terminal-project').value='fixture-B';f.node('terminal-agent').value='agy';
  f.run('terminalSetRoute(terminalProjects[1])');f.node('terminal-route-agent').value='agy';
  const field=f.node('terminal-line');field.value='B에서 처리할 일';field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1600);
  expect(f.requests('input').filter(r=>r.sessionId==='session-A')).toEqual([]);
  expect(f.confirms).toEqual(['‘Target project’ 프로젝트에 Antigravity 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?']);
  expect(f.requests('start')[0].prompt).toContain('보낸 프로젝트: Source project\n보낸 AI: Codex CLI');
});

const TRUST_SCREEN=['╭────────────────────────────────────────╮','│ Do you trust the files in this folder? │','│ /Users/fixture/target                  │',
  '│ ❯ 1. Yes, proceed                       │','│   2. No, exit                           │','╰────────────────────────────────────────╯','  Enter to confirm · Esc to exit'].join('\r\n');
const PERMISSION_SCREEN=[' Do you want to proceed?',' ❯ 1. Yes','   2. No, and tell Claude what to do differently (esc)'].join('\r\n');
const IDLE_SCREEN=['⏺ 작업을 마쳤습니다.','╭──────────────────╮','│ >                │','╰──────────────────╯','  ? for shortcuts'].join('\r\n');
const receiverSessions=[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running'},{id:'session-B-claude',targetId:'fixture-B',agent:'claude',state:'running'}];
const routeTo=(f:ReturnType<typeof fixture>,task:string)=>{
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='claude';
  const field=f.node('terminal-line');field.value=task;field.oninput();void f.node('terminal-send').onclick();return field;
};

// Review M2: a running session the user is not looking at may be showing an approval, trust or menu
// prompt. Typing a handoff there answers it (the trailing Enter picks the highlighted default).
test('M2: a live receiver waiting on an approval is not typed into; its last lines are shown and a new session opens instead',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:receiverSessions,screens:{'session-B-claude':TRUST_SCREEN},listStarted:true});
  routeTo(f,routeTask);
  await f.advance(2400);
  expect(f.requests('input').filter(r=>r.sessionId==='session-B-claude')).toEqual([]);
  expect(f.confirms).toHaveLength(1);
  expect(f.confirms[0]).toContain('질문이나 승인에 대한 답을 기다리는 화면입니다');
  expect(f.confirms[0]).toContain('받는 세션: Target project · claude');
  expect(f.confirms[0]).toContain('│ ❯ 1. Yes, proceed');
  expect(f.confirms[0]).toContain('대신 ‘Target project’ 프로젝트에 Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?');
  expect(f.requests('start').map(({targetId,agent,prompt})=>({targetId,agent,prompt}))).toEqual([{targetId:'fixture-B',agent:'claude',
    prompt:'AgentsToZ 프로젝트 전달\n보낸 프로젝트: Source project\n보낸 AI: Codex CLI\n받는 프로젝트: Target project\n\n'+routeTask}]);
  expect(f.run('terminalSelected')).toBe('session-new');expect(f.node('terminal-project').value).toBe('fixture-B');expect(f.node('terminal-agent').value).toBe('claude');
});

test('M2: declining the new-session offer keeps the draft and the sender, and types nothing anywhere',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:receiverSessions,screens:{'session-B-claude':PERMISSION_SCREEN},confirmResult:false});
  const field=routeTo(f,routeTask);
  await f.advance(2400);
  expect(f.confirms).toHaveLength(1);
  expect(f.requests('input')).toEqual([]);expect(f.requests('start')).toEqual([]);
  expect(field.value).toBe(routeTask);expect(f.run('terminalSelected')).toBe('session-A');expect(f.node('terminal-send').disabled).toBe(false);
});

test('M2/L4: delivering says Enter is pressed in that live session and shows its last lines',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:receiverSessions,screens:{'session-B-claude':IDLE_SCREEN}});
  routeTo(f,routeTask);
  await f.advance(2400);
  expect(f.confirms).toEqual(['‘Target project’ 프로젝트에서 실행 중인 Claude Code 워크룸 세션으로 이 메시지를 전달할까요?\n받는 세션: Target project · claude\n실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다.\n\n그 세션 화면의 마지막 줄:\n│ ⏺ 작업을 마쳤습니다.\n│ >\n│ ? for shortcuts']);
  expect(f.requests('input').map(({sessionId,data})=>({sessionId,data}))).toEqual([{sessionId:'session-B-claude',
    data:'AgentsToZ 프로젝트 전달\n보낸 프로젝트: Source project\n보낸 AI: Codex CLI\n받는 프로젝트: Target project\n\n'+routeTask+'\r'}]);
});

test('M2: a receiver that turns into a question while the dialog is open is not typed into',async()=>{
  const f:ReturnType<typeof fixture>=fixture([],{projects:routeProjects,sessions:receiverSessions,screens:{'session-B-claude':IDLE_SCREEN},onConfirm:()=>{f.screens['session-B-claude']=PERMISSION_SCREEN;}});
  const field=routeTo(f,routeTask);
  await f.advance(2400);
  expect(f.confirms).toHaveLength(1);
  expect(f.requests('input')).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('그 사이 질문이나 승인에 대한 답을 기다리는 화면으로 바뀌어');
  expect(field.value).toBe(routeTask);expect(f.run('terminalSelected')).toBe('session-A');
  expect(f.node('terminal-project').value).toBe('fixture-A');expect(f.node('terminal-agent').value).toBe('codex');
});

test('M2 + H1: a waiting receiver with a handoff too long for a new session keeps the draft without a dialog',async()=>{
  const f=fixture([],{projects:routeProjects,sessions:receiverSessions,screens:{'session-B-claude':TRUST_SCREEN}});
  const value='한'.repeat(5500);const field=routeTo(f,value);
  await f.advance(2400);
  expect(f.confirms).toEqual([]);expect(f.requests('input')).toEqual([]);expect(f.requests('start')).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('질문이나 승인에 대한 답을 기다리는 화면');
  expect(field.value).toBe(value);
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


test('LAN Workroom defaults bypass on and preserves an explicit off choice across reload',async()=>{
  const f=fixture(['start']);
  expect(f.node('terminal-bypass').checked).toBe(true);
  void f.node('terminal-start').onclick();await f.settle();
  expect(f.requests('start')[0].bypassPermissions).toBe(true);
  f.node('terminal-bypass').checked=false;f.node('terminal-bypass').onchange();
  const next=fixture(['start'],{storage:f.storage});
  expect(next.node('terminal-launch-summary').textContent).toContain('OFF');
  void next.node('terminal-start').onclick();await next.settle();
  expect(next.requests('start')[0].bypassPermissions).toBe(false);
  expect(f.requests('start')[0].bypassPermissions).toBe(true);
});


test('LAN terminal rows follow available height and hidden or unchanged surfaces do not enqueue resizes',async()=>{
  const f=fixture();f.run("terminalSelect('session-A')");await f.advance(200);
  f.node('terminal-screen').clientHeight=168;f.resize();await f.advance(300);
  expect(f.requests('resize').at(-1)).toMatchObject({rows:12,sessionId:'session-A'});
  const count=f.requests('resize').length;
  f.resize();await f.advance(300);expect(f.requests('resize')).toHaveLength(count);
  f.node('terminal-screen').clientHeight=0;f.resize();await f.advance(300);expect(f.requests('resize')).toHaveLength(count);
  f.node('terminal-screen').clientHeight=392;f.resize();await f.advance(300);
  expect(f.requests('resize').at(-1)).toMatchObject({rows:28,sessionId:'session-A'});
});
