import {expect, test} from 'bun:test';
import vm from 'node:vm';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';
import {REMOTE_CONTROL_LAN_PAGE_MESSAGE_BUDGET_BYTES} from '../src/remoteControlLanLimits';
import {submissionDigest} from '../src/workroomSubmissionProtocol';
import {WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE} from '../src/workroomSubmissionClient';
import {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR} from '../src/agentDialogueControl';
import {AI_TERMINAL_UNKNOWN_REQUEST_ERROR,AI_TERMINAL_PROMPT_REFUSED_ERROR} from '../src/aiTerminalProtocol';
import {deliverWorkroomRoute} from '../src/workroomRouteDelivery';
import {workroomDeliveryInstruction} from '../src/workroomProjectMention';
import {failedLegacyStartKey,legacyStartDigest} from '../src/workroomLegacyStartGuard';

/** Execute the shipped template output, not a second copy of the input logic.
 * Everything outside the terminal controller is replaced with a fake DOM,
 * clock and socket. No LAN listener, credentials, PTY or AI is involved. */
function fixture(hold: string[] = [], options: {storage?:Map<string,string>;token?:string;savedToken?:string;projects?:{controlId:string;name:string}[];sessions?:any[];restore?:boolean;
  /** Text a `read` from 0 returns per session: what that CLI's screen shows. */
  screens?:Record<string,string>;
  /** The route dialog's answer, and a hook that runs while it is open. */
  confirmResult?:boolean;onConfirm?:(message:string)=>void;
  /** Later lists also contain the sessions this page started. */
  listStarted?:boolean;
  /** Session storage the page keeps pending whole-request submissions in. */
  sessionStore?:Map<string,string>;
  /** Accessing sessionStorage throws, as Safari does when site data is blocked. */
  sessionStorageBlocked?:boolean;
  /** Session storage still reads but refuses every write (quota full). */
  sessionStorageFull?:boolean;
  /** Answer a request instead of the default body: a body, `{error}` to refuse, or 'hold' to leave it unanswered. */
  respond?:(request:any)=>any} = {}) {
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
  const sessionStore=options.sessionStore??new Map<string,string>();
  const sessionStorageApi={get length(){return sessionStore.size;},key:(index:number)=>[...sessionStore.keys()][index]??null,getItem:(key:string)=>sessionStore.get(key)??null,setItem:(key:string,value:string)=>{if(options.sessionStorageFull)throw new Error('QuotaExceededError: The quota has been exceeded.');sessionStore.set(key,String(value));},removeItem:(key:string)=>{sessionStore.delete(key);}};
  const context=vm.createContext({TextEncoder,TextDecoder,Promise,Map,Set,Error,btoa,
    crypto:{getRandomValues:(array:Uint8Array)=>{for(let i=0;i<array.length;i++)array[i]=(i*37+11)&255;return array;}},
    get sessionStorage(){if(options.sessionStorageBlocked)throw new Error('SecurityError: The operation is insecure.');return sessionStorageApi;},
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
    const custom=options.respond?.(request);
    if(custom==='hold')return;
    if(custom&&typeof custom==='object'&&typeof custom.error==='string'){fail(request,custom.error);return;}
    if(custom!==undefined){reply(request,custom);return;}
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
  return {run,node,sent,rawSent,written,confirms,reply,fail,advance,settle,input,requests,storage,sessionStore,screens,context,resize:()=>resizeCallbacks.forEach(callback=>callback())};
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

// ── Whole-request submission (2026-10-15) ─────────────────────────────────────────────────────────────────────
// The composer's 「전송」 hands a natural-language request to a Mac that advertises terminal-submission-v1 as one
// receipt-tracked submission instead of raw keystrokes, so a lost answer can be checked afterwards instead of guessed.
const SUBMISSION_SESSIONS=[{id:'session-A',agent:'codex',targetId:'fixture-project',state:'running'},{id:'session-B',agent:'claude',targetId:'fixture-project',state:'running'}];
function submissionHost(options:{features?:string[];lose?:number;final?:string;statusState?:string;refuseFirst?:string}={}){
  let index=0;
  return (request:any)=>{
    if(request.operation==='list')return request.capabilities?{sessions:SUBMISSION_SESSIONS,features:options.features??['terminal-submission-v1']}:{sessions:SUBMISSION_SESSIONS};
    if(request.operation!=='submission')return undefined;
    const n=index++,command=request.submission;
    if(n===0&&options.refuseFirst)return {error:options.refuseFirst};
    if(options.lose===n)return 'hold';
    if(command.phase==='status')return {submission:{id:command.id,storeId:'store-0001',epoch:'epoch-0001',revision:40,state:options.statusState??'written'}};
    const last=command.phase==='single'||command.commit===true;
    return {submission:{id:command.id,storeId:'store-0001',epoch:'epoch-0001',revision:7,state:last?(options.final??'written'):'prepared'}};
  };
}
async function submissionReady(options:Parameters<typeof submissionHost>[0]={},extra:Parameters<typeof fixture>[1]={}){
  const f=fixture([],{respond:submissionHost(options),...extra});
  void f.run('terminalList()');await f.advance(400);
  f.run("terminalSelect('session-A')");await f.advance(50);
  return f;
}
const send=async(f:ReturnType<typeof fixture>,text:string,ms=1500)=>{f.node('terminal-line').value=text;void f.node('terminal-send').onclick();await f.advance(ms);};

test('the workroom asks once per connection whether this Mac takes whole requests; an older Mac answers the old way',async()=>{
  const f=fixture([],{respond:request=>request.operation==='list'&&request.capabilities?{error:AI_TERMINAL_UNKNOWN_REQUEST_ERROR}:undefined});
  void f.run('terminalList()');await f.advance(600);
  expect(f.requests('list').map(request=>request.capabilities===true)).toEqual([true,false]);
  expect(f.node('terminal-error').textContent).toBe('');
  void f.run('terminalList()');await f.advance(400);
  expect(f.requests('list').map(request=>request.capabilities===true)).toEqual([true,false,false]);
  f.run("terminalSelect('session-A')");await send(f,'hello');
  expect(f.requests('submission')).toHaveLength(0);
  expect(f.requests('input').map(request=>request.data)).toEqual(['hello\r']);
  // A new connection may reach a different Mac build: it asks again.
  f.run('terminalDisconnected()');void f.run('terminalList()');await f.advance(600);
  expect(f.requests('list').filter(request=>request.capabilities===true)).toHaveLength(2);
});

test('a Mac that takes whole requests gets one receipt-tracked submission and no raw input',async()=>{
  const f=await submissionReady();
  expect(f.requests('list')[0].capabilities).toBe(true);
  await send(f,'안녕하세요 요청 😀');
  const [request]=f.requests('submission');
  expect(f.requests('submission')).toHaveLength(1);
  expect(f.requests('input')).toHaveLength(0);
  const text='안녕하세요 요청 😀\r',bytes=new TextEncoder().encode(text);
  expect(request.sessionId).toBe('session-A');
  expect(request.submission).toEqual({phase:'single',id:request.submission.id,bytes:bytes.length,digest:submissionDigest(bytes),data:Buffer.from(bytes).toString('base64')});
  expect(request.submission.id).toMatch(/^lan-[0-9a-f]{32}$/);
  expect(f.node('terminal-line').value).toBe('');
  expect(f.sessionStore.size).toBe(0);
  expect(f.node('terminal-submission').hidden).toBe(true);
});

test('a long request goes in chunks that each fit one LAN frame, committing on the last',async()=>{
  const f=await submissionReady();
  const value='한'.repeat(7999);
  await send(f,value,4000);
  const requests=f.requests('submission');
  expect(requests.map(request=>request.submission.phase)).toEqual(['begin','chunk','chunk','chunk','chunk','chunk']);
  expect(requests.map(request=>request.submission.commit===true)).toEqual([false,false,false,false,false,true]);
  expect(requests[0].submission.chunks).toBe(6);
  const reassembled=Buffer.concat([Buffer.from(requests[0].submission.firstData,'base64'),...requests.slice(1).map(request=>Buffer.from(request.submission.data,'base64'))]);
  expect(reassembled.toString('utf8')).toBe(value+'\r');
  for(const raw of f.rawSent)expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(REMOTE_CONTROL_LAN_PAGE_MESSAGE_BUDGET_BYTES);
  expect(f.requests('input')).toHaveLength(0);
  expect(f.node('terminal-line').value).toBe('');
});

test('a lost chunk answer is never retried or replaced by raw input; 「제출 결과 확인」 asks the Mac afterwards',async()=>{
  const f=await submissionReady({lose:2});
  const value='가'.repeat(5000);
  await send(f,value,16500);
  expect(f.requests('submission')).toHaveLength(3);
  expect(f.requests('input')).toHaveLength(0);
  expect(f.node('terminal-error').textContent).toContain('응답을 확인하지 못했습니다');
  expect(f.node('terminal-line').value).toBe(value);
  const [key,raw]=[...f.sessionStore.entries()][0]!;
  expect(key).toBe('agentstoz:pending-submission:v1:lan:session-A');
  const pending=JSON.parse(raw);
  expect(pending.receipt.state).toBe('prepared');
  expect(f.node('terminal-submission').hidden).toBe(false);
  // The same request is not sent again while its outcome is unknown.
  await send(f,value,1000);
  expect(f.requests('submission')).toHaveLength(3);
  expect(f.requests('input')).toHaveLength(0);
  expect(f.node('terminal-error').textContent).toContain('결과를 먼저 확인');
  // Checking asks for the status of that very id and settles it.
  void f.node('terminal-submission-status').onclick();await f.advance(600);
  const status=f.requests('submission').at(-1);
  expect(status.submission).toEqual({phase:'status',id:pending.id});
  expect(f.sessionStore.size).toBe(0);
  expect(f.node('terminal-submission').hidden).toBe(true);
  expect(f.node('terminal-line').value).toBe('');
  expect(f.node('terminal-error').textContent).toContain('요청 전체를 터미널에 전달했습니다');
});

test('a status that is not yet written keeps the record and says so; dismissing needs a confirmation',async()=>{
  const f=await submissionReady({final:'unknown',statusState:'write_started'},{confirmResult:false});
  await send(f,'hello');
  expect(f.node('terminal-error').textContent).toContain('미확정');
  expect(f.sessionStore.size).toBe(1);
  void f.node('terminal-submission-status').onclick();await f.advance(600);
  expect(f.sessionStore.size).toBe(1);
  expect(f.node('terminal-error').textContent).toContain('write_started');
  f.node('terminal-submission-dismiss').onclick();
  expect(f.confirms.at(-1)).toContain('중복 실행');
  expect(f.sessionStore.size).toBe(1);
  f.context.confirm=()=>true;f.node('terminal-submission-dismiss').onclick();
  expect(f.sessionStore.size).toBe(0);
  expect(f.node('terminal-submission').hidden).toBe(true);
});

test('the pending record survives a reload of the page and still blocks a second send',async()=>{
  const sessionStore=new Map<string,string>();
  const first=await submissionReady({lose:0},{sessionStore});
  await send(first,'once only',16500);
  expect(sessionStore.size).toBe(1);
  const reloaded=await submissionReady({},{sessionStore});
  expect(reloaded.node('terminal-submission').hidden).toBe(false);
  await send(reloaded,'once only');
  expect(reloaded.requests('submission')).toHaveLength(0);
  expect(reloaded.requests('input')).toHaveLength(0);
  // Another session is not blocked by it.
  reloaded.run("terminalSelect('session-B')");await reloaded.advance(50);
  expect(reloaded.node('terminal-submission').hidden).toBe(true);
  await send(reloaded,'other session');
  expect(reloaded.requests('submission')).toHaveLength(1);
});

test('keys, Escape, Enter and Ctrl+C stay raw on a Mac that takes whole requests',async()=>{
  const f=await submissionReady();
  for(const id of ['terminal-escape','terminal-enter','terminal-interrupt']){f.node(id).onclick();await f.advance(300);}
  f.input('y');await f.advance(300);
  expect(f.requests('input').map(request=>request.data)).toEqual(['\x1b','\r','\x03','y']);
  expect(f.requests('submission')).toHaveLength(0);
});

test('a receiver that advertised submission but refuses it before anything ran goes back to raw input on the next click',async()=>{
  const f=await submissionReady({refuseFirst:COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR});
  await send(f,'hello');
  expect(f.node('terminal-error').textContent).toBe(WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE);
  expect(f.node('terminal-line').value).toBe('hello');
  expect(f.sessionStore.size).toBe(0);
  expect(f.requests('input')).toHaveLength(0);
  await send(f,'hello');
  expect(f.requests('submission')).toHaveLength(1);
  expect(f.requests('input').map(request=>request.data)).toEqual(['hello\r']);
});

test('a full pending store refuses before anything is sent, and an invalid request keeps the draft',async()=>{
  const sessionStore=new Map<string,string>();
  for(let i=0;i<32;i++)sessionStore.set('agentstoz:pending-submission:v1:lan:other-session-'+String(i).padStart(3,'0'),JSON.stringify({id:'lan-'+'0'.repeat(32),sessionId:'other-session-'+String(i).padStart(3,'0'),receipt:null}));
  const f=await submissionReady({},{sessionStore});
  await send(f,'hello');
  expect(f.requests('submission')).toHaveLength(0);
  expect(f.requests('input')).toHaveLength(0);
  expect(f.node('terminal-error').textContent).toContain('미확정 제출 기록이 많습니다');
  expect(f.node('terminal-line').value).toBe('hello');
  const g=await submissionReady();
  await send(g,'bell\x07');
  expect(g.requests('submission')).toHaveLength(0);
  expect(g.requests('input')).toHaveLength(0);
  expect(g.node('terminal-error').textContent).toContain('24,000바이트');
  expect(g.node('terminal-line').value).toBe('bell\x07');
});

test('raw keystrokes typed before 「전송」 reach the terminal before the submission',async()=>{
  const f=await submissionReady();
  f.input('x');f.node('terminal-line').value='after keys';void f.node('terminal-send').onclick();await f.advance(1500);
  const order=f.sent.filter(item=>['input','submission'].includes(item.request.operation)).map(item=>item.request.operation);
  expect(order).toEqual(['input','submission']);
});

// Review 2026-10-15: storage that cannot be used is not an unreadable record. Without a place to keep the record the
// page cannot offer a receipt-tracked submission, so 「전송」 stays the raw input it was before, on any Mac.
test('blocked session storage never invents a pending record: an older Mac still takes raw input',async()=>{
  const f=fixture([],{sessionStorageBlocked:true,respond:request=>request.operation==='list'&&request.capabilities?{error:AI_TERMINAL_UNKNOWN_REQUEST_ERROR}:undefined});
  void f.run('terminalList()');await f.advance(600);
  f.run("terminalSelect('session-A')");await f.advance(50);
  expect(f.node('terminal-submission').hidden).toBe(true);
  expect(f.node('terminal-error').textContent).toBe('');
  await send(f,'hello');
  expect(f.requests('input').map(request=>request.data)).toEqual(['hello\r']);
  f.run("terminalSelect('session-B')");await f.advance(50);
  await send(f,'second');
  expect(f.requests('input').map(request=>request.data)).toEqual(['hello\r','second\r']);
  expect(f.node('terminal-submission').hidden).toBe(true);
});

test('blocked session storage on a Mac that takes whole requests sends raw input instead of a record-less submission',async()=>{
  const f=await submissionReady({},{sessionStorageBlocked:true});
  expect(f.node('terminal-submission').hidden).toBe(true);
  await send(f,'hello');
  expect(f.requests('submission')).toHaveLength(0);
  expect(f.requests('input').map(request=>request.data)).toEqual(['hello\r']);
  expect(f.node('terminal-line').value).toBe('');
});

// A submission cancelled before its first request reached the wire was never sent: it leaves no record.
test('a submission cancelled by a session switch before it is sent leaves no record and keeps the draft',async()=>{
  const f=await submissionReady();
  f.input('x');f.node('terminal-line').value='req';void f.node('terminal-send').onclick();await f.advance(5);
  f.run("terminalSelect('session-B')");await f.advance(1500);
  expect(f.requests('submission')).toHaveLength(0);
  expect(f.sessionStore.size).toBe(0);
  expect(f.node('terminal-error').textContent).not.toContain('전송 전 터미널 요청을 취소했습니다');
  f.run("terminalSelect('session-A')");await f.advance(50);
  expect(f.node('terminal-submission').hidden).toBe(true);
  expect(f.node('terminal-line').value).toBe('req');
  await send(f,'req');
  expect(f.requests('submission')).toHaveLength(1);
  expect(f.requests('submission')[0].sessionId).toBe('session-A');
});

test('a submission cancelled by a disconnect before it is sent leaves no record and keeps the draft',async()=>{
  const f=await submissionReady();
  f.input('x');f.node('terminal-line').value='req';void f.node('terminal-send').onclick();await f.advance(5);
  f.run('terminalDisconnected()');await f.advance(1500);
  expect(f.requests('submission')).toHaveLength(0);
  expect(f.sessionStore.size).toBe(0);
  expect(f.node('terminal-submission').hidden).toBe(true);
  expect(f.node('terminal-line').value).toBe('req');
  expect(f.node('terminal-error').textContent).toContain('보내지 않았습니다');
});

test('a submission cancelled after its first chunk was answered keeps its record for a status check',async()=>{
  const f=await submissionReady();
  f.node('terminal-line').value='한'.repeat(7999);void f.node('terminal-send').onclick();
  for(let i=0;i<100&&f.requests('submission').length===0;i++)await f.advance(5);
  expect(f.requests('submission')).toHaveLength(1);
  f.run("terminalSelect('session-B')");await f.advance(1500);
  expect(f.requests('submission')).toHaveLength(1);
  expect(f.sessionStore.size).toBe(1);
  expect(JSON.parse([...f.sessionStore.values()][0]!).receipt.state).toBe('prepared');
  f.run("terminalSelect('session-A')");await f.advance(50);
  expect(f.node('terminal-submission').hidden).toBe(false);
});

// w4 L3: a LAN @ route into another running session typed raw input even where the Mac takes whole requests. It now goes
// as one submission with a receipt, request for request what the Workroom panel's @ delivery sends (golden below), and
// keeps raw input only for a Mac without the feature (the earlier raw test above still holds).
const ROUTE_SESSIONS=[{id:'session-A',targetId:'fixture-A',agent:'codex',state:'running',createdAt:'2026-10-16T00:00:00Z',exitCode:null,cols:80,rows:24},
  {id:'session-B-claude',targetId:'fixture-B',agent:'claude',state:'running',createdAt:'2026-10-16T00:01:00Z',exitCode:null,cols:80,rows:24}];
const ROUTE_INSTRUCTION=workroomDeliveryInstruction({task:routeTask,sourceLabel:'Source project',sourceAgentLabel:'Codex CLI',targetLabel:'Target project'});
function routeSubmissionHost(options:{hold?:boolean}={}){
  return (request:any)=>{
    if(request.operation==='list')return request.capabilities?{sessions:ROUTE_SESSIONS,features:['terminal-submission-v1']}:{sessions:ROUTE_SESSIONS};
    if(request.operation!=='submission')return undefined;
    if(options.hold)return 'hold';
    const command=request.submission,last=command.phase==='single'||command.commit===true;
    return {submission:{id:command.id,storeId:'store-0001',epoch:'epoch-0001',revision:7,state:last?'written':'prepared'}};
  };
}
async function routeReady(respond:(request:any)=>any,extra:Parameters<typeof fixture>[1]={}){
  const f=fixture([],{projects:routeProjects,sessions:ROUTE_SESSIONS,respond,...extra});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
  void f.run('terminalList()');await f.advance(400);
  f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='claude';
  return f;
}
const normalizedSubmissions=(requests:any[])=>requests.filter(r=>r.operation==='submission').map(r=>({sessionId:r.sessionId,...(r.references?{references:r.references}:{}),submission:{...r.submission,id:'x'}}));

test('a LAN @ route into a running receiver is one submission, request for request the panel\'s @ delivery',async()=>{
  const f=await routeReady(routeSubmissionHost());
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(2000);
  expect(f.requests('input')).toEqual([]);
  const lan=f.requests('submission');
  expect(lan).toHaveLength(1);
  expect(lan[0].sessionId).toBe('session-B-claude');
  expect(Buffer.from(lan[0].submission.data,'base64').toString('utf8')).toBe(ROUTE_INSTRUCTION+'\r');
  // The Workroom panel's @ delivery to the same receiver, against the same host answers.
  const host=routeSubmissionHost(),panelRequests:any[]=[];
  const result=await deliverWorkroomRoute({sessions:ROUTE_SESSIONS as any,source:ROUTE_SESSIONS[0] as any,sourceLabel:'Source project',target:{targetId:'fixture-B',label:'Target project'},agent:'claude',
    task:routeTask,references:[],transport:'relay',bypassPermissions:true,sessionLabel:()=>undefined,confirm:()=>true,render:async text=>text.split('\n'),
    submission:{supported:true,pending:()=>null,remember:()=>{}},
    request:async request=>{panelRequests.push(request);if(request.operation==='read')return {chunks:[],hasMore:false} as any;return host(request) as any;}});
  expect(result.status).toBe('delivered');
  expect(normalizedSubmissions(lan)).toEqual(normalizedSubmissions(panelRequests));
  // The view follows the receiver once it took the message; the draft and the route go; no record is left.
  expect(f.run('terminalSelected')).toBe('session-B-claude');
  expect(field.value).toBe('');expect(f.run('terminalRouteTargetId')).toBe('');
  expect([...f.sessionStore.keys()].filter(key=>key.startsWith('agentstoz:pending-submission:'))).toEqual([]);
});

test('a long LAN @ handoff into a running receiver goes in chunks, the same chunks as the panel',async()=>{
  const f=await routeReady(routeSubmissionHost());
  const task='한'.repeat(2500);
  const field=f.node('terminal-line');field.value=task;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(5000);
  const lan=f.requests('submission');
  expect(lan.map(r=>r.submission.phase)).toEqual(['begin','chunk']);
  const host=routeSubmissionHost(),panelRequests:any[]=[];
  await deliverWorkroomRoute({sessions:ROUTE_SESSIONS as any,source:ROUTE_SESSIONS[0] as any,sourceLabel:'Source project',target:{targetId:'fixture-B',label:'Target project'},agent:'claude',
    task,references:[],transport:'relay',bypassPermissions:true,sessionLabel:()=>undefined,confirm:()=>true,render:async text=>text.split('\n'),
    submission:{supported:true,pending:()=>null,remember:()=>{}},
    request:async request=>{panelRequests.push(request);if(request.operation==='read')return {chunks:[],hasMore:false} as any;return host(request) as any;}});
  expect(normalizedSubmissions(lan)).toEqual(normalizedSubmissions(panelRequests));
  expect(f.requests('input')).toEqual([]);
});

test('an unsettled submission on the LAN receiver refuses the @ route before anything is sent',async()=>{
  const sessionStore=new Map<string,string>([['agentstoz:pending-submission:v1:lan:session-B-claude',JSON.stringify({id:'lan-'+'b'.repeat(32),sessionId:'session-B-claude',receipt:null})]]);
  const f=await routeReady(routeSubmissionHost(),{sessionStore});
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1500);
  expect(f.node('terminal-error').textContent).toContain('받는 세션에 앞서 보낸 요청의 전달 결과가 아직 미확정입니다');
  expect(f.requests('submission')).toEqual([]);expect(f.requests('input')).toEqual([]);
  expect(f.confirms).toEqual([]);
  expect(field.value).toBe(routeTask);expect(f.run('terminalSelected')).toBe('session-A');
});

test('a lost LAN @ submission answer keeps its record on the receiver and the draft, and is never retyped',async()=>{
  const f=await routeReady(routeSubmissionHost({hold:true}));
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(16500);
  expect(f.requests('submission')).toHaveLength(1);expect(f.requests('input')).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('미확정');
  expect(field.value).toBe(routeTask);
  const pending=JSON.parse(f.sessionStore.get('agentstoz:pending-submission:v1:lan:session-B-claude')!);
  expect(pending.sessionId).toBe('session-B-claude');
  // Sending again goes nowhere new: the receiver's record is checked first.
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(f.requests('submission')).toHaveLength(1);expect(f.requests('input')).toEqual([]);
});

// w4 L1: a LAN @ route to a Mac without launch receipts opens its new session with a plain start. A lost answer may still
// have opened the CLI with the handoff; the retry asks first, from the same digest-and-session-id record as the panel.
function lostStartHost(){
  const opened:any[]=[];let starts=0;
  const respond=(request:any)=>{
    if(request.operation==='list')return {sessions:[ROUTE_SESSIONS[0],...opened]};
    if(request.operation==='start'){starts++;if(starts===1){opened.push({id:'session-opened-0001',targetId:request.targetId,agent:request.agent,state:'running',createdAt:'2026-10-16T00:02:00Z',exitCode:null,cols:80,rows:24});return 'hold';}}
    return undefined;
  };
  return {respond,get starts(){return starts;}};
}
async function lostStartRoute(extra:Parameters<typeof fixture>[1]={}){
  const host=lostStartHost();
  const f=fixture([],{projects:routeProjects,sessions:[ROUTE_SESSIONS[0]],respond:host.respond,...extra});
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
  f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='claude';
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(16500);
  return {f,host,field};
}

test('a LAN @ route whose plain start answer was lost asks before a second CLI; declining sends nothing',async()=>{
  const {f,host,field}=await lostStartRoute();
  expect(host.starts).toBe(1);
  expect(f.node('terminal-error').textContent).toContain('응답을 확인하지 못했습니다');
  const raw=f.sessionStore.get(failedLegacyStartKey('lan'))!;
  expect(raw).toContain(legacyStartDigest('fixture-B','claude',ROUTE_INSTRUCTION));
  expect(raw).not.toContain('대상 프로젝트');
  const asked:string[]=[];f.context.confirm=(message:string)=>{asked.push(message);return false;};
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('앞서 보낸 전달은 실패로 보였지만');
  expect(f.node('terminal-error').textContent).toContain('보내지 않았습니다');
  expect(host.starts).toBe(1);expect(f.requests('input')).toEqual([]);
  expect(field.value).toBe(routeTask);expect(f.run('terminalSelected')).toBe('session-A');
});

test('with site data blocked the LAN guard keeps the failed start in page memory and still asks',async()=>{
  const {f,host}=await lostStartRoute({sessionStorageBlocked:true});
  expect(host.starts).toBe(1);
  const asked:string[]=[];f.context.confirm=(message:string)=>{asked.push(message);return false;};
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked[0]).toContain('앞서 보낸 전달은 실패로 보였지만');
  expect(host.starts).toBe(1);
});

test('the LAN #terminal-start carries no request, so it has nothing to guard',()=>{
  const start=REMOTE_CONTROL_MOBILE_JS.slice(REMOTE_CONTROL_MOBILE_JS.indexOf("document.querySelector('#terminal-start').onclick"));
  const request=start.slice(start.indexOf('terminalRequest({'),start.indexOf('});',start.indexOf('terminalRequest({')));
  expect(request).toContain("operation:'start'");
  expect(request).not.toContain('prompt');
});

// w4 review, finding 2: the receiver check ran only while the submission feature was known. A dropped socket clears the
// features until the next capabilities probe, and in that window an @ route typed the handoff raw into a receiver whose
// earlier submission of it was still unsettled. A record means a submission went out, whatever the feature flag says now.
test('a LAN @ route refuses a receiver with an unsettled record even while the submission feature is not known',async()=>{
  const sessionStore=new Map<string,string>([['agentstoz:pending-submission:v1:lan:session-B-claude',JSON.stringify({id:'lan-'+'b'.repeat(32),sessionId:'session-B-claude',receipt:null})]]);
  const f=await routeReady(routeSubmissionHost(),{sessionStore});
  f.run('terminalSubmissionFeatures.clear()');
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(1500);
  expect(f.node('terminal-error').textContent).toContain('받는 세션에 앞서 보낸 요청의 전달 결과가 아직 미확정입니다');
  expect(f.requests('input')).toEqual([]);expect(f.requests('submission')).toEqual([]);
  expect(f.confirms).toEqual([]);
  expect(field.value).toBe(routeTask);expect(f.run('terminalSelected')).toBe('session-A');
});

// w4 review, finding 3 (the LAN page read through the write probe too): storage that is full still holds its records.
// A readable unsettled submission keeps its banner and refuses 「전송」 instead of the send going raw past it.
test('full LAN storage still shows an unsettled submission and refuses to send past it',async()=>{
  const sessionStore=new Map<string,string>([['agentstoz:pending-submission:v1:lan:session-A',JSON.stringify({id:'lan-'+'a'.repeat(32),sessionId:'session-A',receipt:null})]]);
  const f=await submissionReady({},{sessionStore,sessionStorageFull:true});
  expect(f.node('terminal-submission').hidden).toBe(false);
  await send(f,'두 번 실행되면 안 되는 요청');
  expect(f.requests('input')).toEqual([]);expect(f.requests('submission')).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('앞서 보낸 요청의 결과를 먼저 확인하세요');
  expect(f.node('terminal-line').value).toBe('두 번 실행되면 안 되는 요청');
});

// The same for a new session (w4 review, findings 2 and 3): a plain start — the launch feature unknown after a reconnect,
// or storage that cannot keep a new launch record — is refused while a readable launch of the same target and AI is
// unsettled on this device. It may have opened a CLI with this very request.
test('a readable unsettled launch of the same target and AI refuses a plain LAN @ start',async()=>{
  for(const sessionStorageFull of [false,true]){
    const record={id:'lan-'+'c'.repeat(32),targetId:'fixture-B',agent:'claude',receipt:null};
    const sessionStore=new Map<string,string>([['agentstoz:pending-launch:v1:lan',JSON.stringify(record)]]);
    const f=fixture([],{projects:routeProjects,sessions:[ROUTE_SESSIONS[0]],sessionStore,sessionStorageFull});
    f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
    f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
    f.node('terminal-route-agent').value='claude';
    const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
    await f.advance(1500);
    expect(f.node('terminal-error').textContent).toContain('새 세션 시작 결과가 아직 미확정');
    expect(f.requests('start')).toEqual([]);expect(f.confirms).toEqual([]);
    expect(field.value).toBe(routeTask);
    // Another AI of that project is not blocked by it.
    f.node('terminal-route-agent').value='codex';void f.node('terminal-send').onclick();await f.advance(1500);
    expect(f.requests('start')).toHaveLength(1);
  }
});

// w4 review, finding 4: the LAN plain-start catch remembered every failure except a cancelled or too-large request, so a
// start the Mac itself refused (nothing ran) later made a session the user opened by hand look like it had received the
// handoff. A refusal answered by this Mac is definitive; one relayed from another device may hide an unknown outcome (its
// timeout is a refusal on the wire), so there only the first-request refusals are taken as «nothing ran».
function refusingStartRoute(refusal:()=>string|null,device=''){
  const manual:any[]=[];
  const f=fixture([],{projects:routeProjects,sessions:[ROUTE_SESSIONS[0]],respond:(request:any)=>{
    if(request.operation==='list')return {sessions:[ROUTE_SESSIONS[0],...manual]};
    if(request.operation==='start'){const error=refusal();if(error)return {error};}
    return undefined;
  }});
  if(device)f.run(`terminalDevice=${JSON.stringify(device)}`);
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
  f.run("terminalSelect('session-A');terminalSetRoute(terminalProjects[1])");
  f.node('terminal-route-agent').value='claude';
  const field=f.node('terminal-line');
  const send=async()=>{field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();await f.advance(1500);};
  return {f,send,manual};
}
const DEVICE_TIMEOUT='상대 기기가 제때 답하지 않았습니다. 그 기기의 AgentsToZ가 켜져 있는지 확인하세요. 요청이 실행됐는지는 알 수 없습니다.';

test('a start this Mac refused is not remembered as a possibly-opened CLI, so no false question follows',async()=>{
  for(const error of [AI_TERMINAL_PROMPT_REFUSED_ERROR,'claude CLI가 설치되어 있지 않습니다.']){
    let refuse=true;
    const {f,send,manual}=refusingStartRoute(()=>refuse?error:null);
    await send();
    expect(f.node('terminal-error').textContent).toContain(error);
    expect(f.sessionStore.has(failedLegacyStartKey('lan'))).toBe(false);
    // The user opens that AI's session by hand, then sends the same message again: no claim it already got it.
    refuse=false;manual.push({id:'session-manual-0001',targetId:'fixture-B',agent:'claude',state:'running',createdAt:'2026-10-16T00:03:00Z',exitCode:null,cols:80,rows:24});
    await send();
    expect(f.confirms.some(message=>message.includes('앞서 보낸 전달은 실패로 보였지만'))).toBe(false);
  }
});

test('through another device a relayed timeout is still remembered; its first-request refusal is not',async()=>{
  const timedOut=refusingStartRoute(()=>DEVICE_TIMEOUT,'device-ref-0001');
  await timedOut.send();
  expect(timedOut.f.sessionStore.get(failedLegacyStartKey('lan:device-ref-0001'))).toContain(legacyStartDigest('fixture-B','claude',ROUTE_INSTRUCTION));
  const refused=refusingStartRoute(()=>AI_TERMINAL_PROMPT_REFUSED_ERROR,'device-ref-0001');
  await refused.send();
  expect(refused.f.sessionStore.has(failedLegacyStartKey('lan:device-ref-0001'))).toBe(false);
});

// w4 review, finding 5: after the confirmation the receiver's screen is read once more. The panel refuses to type when
// that second read cannot be completed; the LAN page went on blind (submission and raw input alike).
test('a LAN @ route does not type into a receiver whose screen cannot be read again, as the panel refuses',async()=>{
  const refusal='받는 세션의 현재 화면을 다시 확인하지 못해 입력하지 않았습니다';
  for(const submits of [true,false]){
    let reads=0;const host=routeSubmissionHost();
    const f=await routeReady((request:any)=>request.operation==='read'&&request.sessionId==='session-B-claude'&&++reads>1?{error:'Fixture: read lost'}:host(request));
    if(!submits)f.run('terminalSubmissionFeatures.clear()');
    const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
    await f.advance(2000);
    expect(f.node('terminal-error').textContent).toContain(refusal);
    expect(f.requests('submission')).toEqual([]);expect(f.requests('input')).toEqual([]);
    expect(field.value).toBe(routeTask);
  }
  // The Workroom panel's @ delivery against the same answers.
  let reads=0;const host=routeSubmissionHost();
  await expect(deliverWorkroomRoute({sessions:ROUTE_SESSIONS as any,source:ROUTE_SESSIONS[0] as any,sourceLabel:'Source project',target:{targetId:'fixture-B',label:'Target project'},agent:'claude',
    task:routeTask,references:[],transport:'relay',bypassPermissions:true,sessionLabel:()=>undefined,confirm:()=>true,render:async text=>text.split('\n'),
    submission:{supported:true,pending:()=>null,remember:()=>{}},
    request:async request=>{if(request.operation==='read'){if(++reads>1)throw new Error('Fixture: read lost');return {chunks:[],hasMore:false} as any;}return host(request) as any;}})).rejects.toThrow(refusal);
});

// ...while a device that predates snapshot reads is read without it (as the panel does), so it is not refused for that.
test('a receiver on a Mac that refuses snapshot reads is read plainly and still receives the LAN @ handoff',async()=>{
  const host=routeSubmissionHost();
  const f=await routeReady((request:any)=>request.operation==='read'&&request.snapshot?{error:AI_TERMINAL_UNKNOWN_REQUEST_ERROR}:host(request));
  const field=f.node('terminal-line');field.value=routeTask;field.oninput();void f.node('terminal-send').onclick();
  await f.advance(2000);
  expect(f.requests('submission')).toHaveLength(1);
  expect(f.requests('read').some(request=>request.sessionId==='session-B-claude'&&!request.snapshot)).toBe(true);
  expect(field.value).toBe('');
});

// w4 review, finding 1: declining the retry question kept the draft and the @ chip. Choosing the session that opened then
// made the route equal to the source, and 「전송」 typed the same handoff into the very session that may already run it.
// The page now remembers which sessions were known when the handoff went out, and asks before sending the same draft
// into any other one of that target and AI.
test('after a declined LAN retry, sending the same draft into the session that opened asks first',async()=>{
  const {f,host,field}=await lostStartRoute();
  f.context.confirm=()=>false;void f.node('terminal-send').onclick();await f.advance(1500);
  expect(host.starts).toBe(1);
  void f.run('terminalList()');await f.advance(400);
  f.node('terminal-project').value='fixture-B';f.node('terminal-agent').value='claude';
  f.run("terminalSelect('session-opened-0001')");await f.advance(50);
  const asked:string[]=[];f.context.confirm=(message:string)=>{asked.push(message);return false;};
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('이미 받았을 수 있습니다');
  expect(f.requests('input').filter(request=>request.sessionId==='session-opened-0001')).toEqual([]);
  expect(f.requests('submission')).toEqual([]);
  expect(f.node('terminal-error').textContent).toContain('보내지 않았습니다');
  expect(field.value).toBe(routeTask);
  // Asked and accepted: it goes once, as the user chose.
  f.context.confirm=(message:string)=>{asked.push(message);return true;};
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked).toHaveLength(2);
  expect(f.requests('input').filter(request=>request.sessionId==='session-opened-0001').map(request=>request.data).join('')).toBe(routeTask+'\r');
});

test('a lost LAN start answer alone also makes the session that opened ask before the same draft goes into it',async()=>{
  const {f,field}=await lostStartRoute();
  void f.run('terminalList()');await f.advance(400);
  f.node('terminal-project').value='fixture-B';f.node('terminal-agent').value='claude';
  f.run("terminalSelect('session-opened-0001')");await f.advance(50);
  f.run('terminalSetRoute(null)');
  const asked:string[]=[];f.context.confirm=(message:string)=>{asked.push(message);return false;};
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked).toHaveLength(1);
  expect(f.requests('input').filter(request=>request.sessionId==='session-opened-0001')).toEqual([]);
  expect(field.value).toBe(routeTask);
  // The session the page already knew is not a suspect.
  f.node('terminal-project').value='fixture-A';f.node('terminal-agent').value='codex';
  f.run("terminalSelect('session-A')");await f.advance(50);
  void f.node('terminal-send').onclick();await f.advance(1500);
  expect(asked).toHaveLength(1);
  expect(f.requests('input').filter(request=>request.sessionId==='session-A').map(request=>request.data).join('')).toBe(routeTask+'\r');
});
