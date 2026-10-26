import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BrowserRecoverySummary,BrowserWorkspace,WorkroomBrowserRequest} from '../src/workroomBrowserProtocol';
import {classifyWorkroomBrowserError,WorkroomBrowserError,type BrowserErrorCode} from '../src/workroomBrowserErrorCodes';
import {workroomBrowserUiCopy} from '../src/workroomBrowserUiCopy';
import {WorkroomBrowserControlMessages} from '../src/WorkroomBrowserFrameControl';
import {workroomBrowserErrorCopy} from '../src/workroomBrowserErrorCopy';

const frame=readFileSync(new URL('../src/WorkroomBrowserFrame.tsx',import.meta.url),'utf8');
const slice=(from:string,to:string)=>{
 const start=frame.indexOf(from),end=frame.indexOf(to,start);
 expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
 return frame.slice(start,end);
};
// Execute production action boundaries. React, CEF and xterm are outside this seam; no action implementation is copied.
const actionsSource=[
 slice(' const current=',' const run='),
 slice(' const run=','\n useEffect('),
 slice(' const performAct=',' const act='),
 slice(' const writeGrant=',' const grant='),
].join('\n');
const choiceSource=slice(' const invalidateChoice=',' /** One request about this workspace');
const handoffSource=slice(' const grant=',' const chooseView=');
const closedStart=frame.indexOf('onClosed={')+'onClosed={'.length,closedEnd=frame.indexOf('}/>',closedStart);
expect(closedStart).toBeGreaterThan('onClosed={'.length);expect(closedEnd).toBeGreaterThan(closedStart);
const closedSource=frame.slice(closedStart,closedEnd);
const transpile=(text:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(text);
type Reply={workspace?:BrowserWorkspace;grant?:string};
const workspace=(extra:Partial<BrowserWorkspace>={}):BrowserWorkspace=>({
 id:'workspace-actions',sessionId:'session-actions',targetId:'project-actions',source:'owned',
 profileId:'owned:session-actions',profileName:'Task browser',page:{id:'page-actions',title:'Checkout',url:'http://localhost:9000/'},
 owner:'human',epoch:7,observation:null,connection:'connected',profileVerification:'user-confirmed',...extra,
});
function deferred<T=void>(){
 let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
type Actions={current:(version:number)=>boolean;performAct:(operation:'take'|'resume'|'detach')=>Promise<BrowserWorkspace|null>;run:(fn:()=>Promise<void>)=>Promise<void>;writeGrant:(w:BrowserWorkspace)=>Promise<void>};
type ChoiceActions={invalidateChoice:()=>void;chooseSource:(source:'owned'|'chrome')=>void;chooseRecovery:(recovery:BrowserRecoverySummary)=>void;connect:()=>void};
type HandoffActions={grant:(workspace:BrowserWorkspace)=>void;handoff:()=>void;onClosed:()=>void};
function harness(options:{
 request?:(body:WorkroomBrowserRequest)=>Promise<Reply>;
 native?:(sessionId:string,operation:string)=>Promise<unknown>;
 chip?:boolean;
 source?:'owned'|'chrome';
}={}){
 const initial=workspace(),epoch={current:0},mounted={current:true},binding={current:{sessionId:initial.sessionId,targetId:initial.targetId}},flight={current:false};
 const states:{kind:string;value:unknown}[]=[],applied:BrowserWorkspace[]=[],chips:unknown[]=[],drafts:string[]=[],native:string[]=[],requests:WorkroomBrowserRequest[]=[],raf:FrameRequestCallback[]=[];
 let focused=0;
 const state=(kind:string)=>(value:unknown)=>states.push({kind,value});
 const memory=new Map([[initial.sessionId,initial]]);
 const env={workspace:initial,epoch,mounted,binding,flight,hotUntil:{current:0},memory,
  sessionId:initial.sessionId,targetId:initial.targetId,
  request:async(body:WorkroomBrowserRequest)=>{requests.push(body);return options.request?await options.request(body):{workspace:initial};},
  ownedBrowserAction:async(sessionId:string,operation:string)=>{native.push(operation);return options.native?await options.native(sessionId,operation):{};},
  apply:(w:BrowserWorkspace)=>applied.push(w),
  setNotice:state('notice'),setGrantFailed:state('grantFailed'),setBusy:state('busy'),setError:state('error'),setPanelErrorCode:state('errorCode'),classifyWorkroomBrowserError,
  setWorkspace:state('workspace'),setPages:state('pages'),setPage:state('page'),setConfirmed:state('confirmed'),
  onHandoff:options.chip===false?undefined:(value:unknown)=>chips.push(value),onDraft:(text:string)=>drafts.push(text),
  ui:workroomBrowserUiCopy('en'),WorkroomBrowserError,
  requestAnimationFrame:(callback:FrameRequestCallback)=>{raf.push(callback);return raf.length;},
  panes:{current:{querySelector:()=>({focus:()=>{focused++;}})}},
 };
 const keys=Object.keys(env),values=Object.values(env);
 const actions=new Function(...keys,transpile(actionsSource)+';return {current,performAct,run,writeGrant};')(...values) as Actions;
 // Observe the real connect's void run without changing its body or reimplementing generation checks.
 const choices:Promise<void>[]=[],forgotten:string[]=[];
 const choiceEnv={...env,current:actions.current,source:options.source??'owned',recovery:null,profile:'chrome-profile',
  run:(fn:()=>Promise<void>)=>{const pending=actions.run(fn);choices.push(pending);return pending;},
  setSource:state('source'),setRecovery:state('recovery'),setProfile:state('profile'),forgetOwnedConnects:(sessionId:string)=>forgotten.push(sessionId),
 };
 const choiceActions=new Function(...Object.keys(choiceEnv),transpile(choiceSource)+';return {invalidateChoice,chooseSource,chooseRecovery,connect};')(...Object.values(choiceEnv)) as ChoiceActions;
 const handoffEnv={...choiceEnv,performAct:actions.performAct,writeGrant:actions.writeGrant,ownedPage:null,invalidateChoice:choiceActions.invalidateChoice};
 const handoffActions=new Function(...Object.keys(handoffEnv),transpile(handoffSource+'\n const onClosed='+closedSource)+';return {grant,handoff,onClosed};')(...Object.values(handoffEnv)) as HandoffActions;
 return {actions:{...actions,...choiceActions,...handoffActions},initial,epoch,mounted,binding,flight,memory,states,applied,chips,drafts,native,requests,forgotten,
  waitChoices:()=>Promise.all(choices),
  flushFocus:()=>{for(const callback of raf.splice(0))callback(0);},focused:()=>focused,
  replace:()=>{epoch.current++;binding.current={sessionId:'new-session',targetId:'new-project'};},
 };
}

test('a refused resume unlocks the native page only after a fresh host response confirms human ownership',async()=>{
 const refusal=new Error('Observation failed');
 for(const status of [workspace(),workspace({owner:'agent'}),workspace({connection:'disconnected',owner:'disconnected'}),undefined,'lost'] as const){
  const h=harness({request:async body=>{
   if(body.operation==='resume')throw refusal;
   expect(body.operation).toBe('status');
   if(status==='lost')throw new Error('Status unavailable');
   return status?{workspace:status}:{};
  }});
  await expect(h.actions.performAct('resume')).rejects.toBe(refusal);
  expect(h.requests.map(body=>body.operation)).toEqual(['resume','status']);
  expect(h.native).toEqual(status&&status!=='lost'&&status.owner==='human'?['lock','unlock']:['lock']);
 }
});

test('a stale recovery-status response cannot unlock an old native page or apply its workspace',async()=>{
 const status=deferred<Reply>(),asked=deferred();
 const h=harness({request:async body=>{
  if(body.operation==='resume')throw new Error('Observation failed');
  asked.resolve();return status.promise;
 }});
 const running=h.actions.performAct('resume');
 await asked.promise;h.replace();status.resolve({workspace:workspace()});
 await expect(running).rejects.toThrow('Observation failed');
 expect(h.native).toEqual(['lock']);expect(h.applied).toEqual([]);
});

for(const [operation,nativeOperation] of [['detach','hide'],['take','unlock']] as const){
 test(`a ${nativeOperation} reply after the selection changed cannot apply or clear the new workspace`,async()=>{
  const native=deferred(),started=deferred();
  const h=harness({native:async(_session,op)=>{if(op===nativeOperation){started.resolve();await native.promise;}return {};}});
  const running=h.actions.performAct(operation);
  await started.promise;h.replace();h.states.length=0;
  native.resolve();expect(await running).toBeNull();
  expect(h.applied).toEqual([]);expect(h.states).toEqual([]);
  expect(h.memory.has(h.initial.sessionId)).toBe(true);
 });
}

test('a native lock completing after the generation ended sends no host resume',async()=>{
 const lock=deferred(),started=deferred();
 const h=harness({native:async(_session,op)=>{expect(op).toBe('lock');started.resolve();await lock.promise;return {};}});
 const running=h.actions.performAct('resume');
 await started.promise;h.replace();lock.resolve();
 expect(await running).toBeNull();expect(h.requests).toEqual([]);expect(h.applied).toEqual([]);
});

test('a previous run cannot clear a new flight flag or show its error or error code in a replacement selection',async()=>{
 const task=deferred();const h=harness();
 const running=h.actions.run(()=>task.promise);
 expect(h.flight.current).toBe(true);
 h.replace();h.states.length=0;h.flight.current=true;
 task.reject(new WorkroomBrowserError('profile-in-use','Old request failed'));await running;
 expect(h.states).toEqual([]);expect(h.flight.current).toBe(true);
});

test('the run boundary preserves a typed refusal code through the Korean error surface',async()=>{
 const h=harness(),error=new WorkroomBrowserError('profile-in-use','Synthetic refusal without a message-table match');
 // Keeping only error.message would classify this as generic and show the wrong recovery instruction.
 expect(classifyWorkroomBrowserError(error.message)).toBe('generic');
 await h.actions.run(async()=>{throw error;});
 const code=h.states.filter(row=>row.kind==='errorCode').at(-1)?.value as BrowserErrorCode;
 const message=h.states.filter(row=>row.kind==='error').at(-1)?.value as string;
 expect(code).toBe('profile-in-use');expect(message).toBe(error.message);
 const rendered=renderToStaticMarkup(createElement(WorkroomBrowserControlMessages,{lang:'ko',error:message,errorCode:code,notice:''}));
 expect(rendered).toContain('data-error-code="profile-in-use"');
 expect(rendered).toContain(workroomBrowserErrorCopy('ko')['profile-in-use']);
 expect(rendered).not.toContain(workroomBrowserErrorCopy('ko').generic);
 expect(rendered).not.toContain(error.message);
});

for(const selection of ['source','recovery'] as const){
 test(`changing ${selection} detaches a late Chrome connect and its finally cannot clear the new selection's busy state`,async()=>{
  const reply=deferred<Reply>();
  const h=harness({source:'chrome',request:async body=>body.operation==='connect'?reply.promise:{}});
  h.actions.connect();expect(h.flight.current).toBe(true);
  if(selection==='source')h.actions.chooseSource('owned');
  else h.actions.chooseRecovery({id:'different-saved-task',source:'chrome',profileId:'different-profile',profileName:'Different profile',sessionId:'previous-session',pageId:null,updatedAt:1,unknown:0});
  expect(h.epoch.current).toBe(1);expect(h.flight.current).toBe(false);expect(h.forgotten).toEqual([h.initial.sessionId]);
  // A new request owns the new choice. The previous promise must not clear or report into it.
  h.flight.current=true;h.states.length=0;
  const late=workspace({source:'chrome',id:'late-chrome-workspace'});
  reply.resolve({workspace:late});await h.waitChoices();
  expect(h.applied).toEqual([]);
  expect(h.requests.map(body=>body.operation)).toEqual(['connect','detach']);
  expect(h.requests[1]).toEqual({operation:'detach',workspaceId:late.id});
  expect(h.states).toEqual([]);expect(h.flight.current).toBe(true);
 });
}

test('a handoff status completing after a choice change neither requests a grant nor changes the new choice',async()=>{
 const reply=deferred<Reply>(),statusAsked=deferred();
 const pending=workspace({owner:'observing',epoch:8});
 const ready=workspace({owner:'agent',epoch:8,observation:{id:'observation-actions',url:'http://localhost:9000/',title:'Checkout',text:'',elements:[],capturedAt:'2026-10-25T00:00:00Z',untrusted:true}});
 const h=harness({request:async body=>{
  if(body.operation==='resume')return {workspace:pending};
  if(body.operation==='status'){statusAsked.resolve();return reply.promise;}
  throw new Error(`Unexpected browser operation: ${body.operation}`);
 }});
 h.actions.handoff();await statusAsked.promise;
 h.actions.chooseSource('chrome');h.states.length=0;h.applied.length=0;
 reply.resolve({workspace:ready});await h.waitChoices();
 expect(h.requests.map(body=>body.operation)).toEqual(['resume','status']);
 expect(h.states).toEqual([]);expect(h.applied).toEqual([]);expect(h.chips).toEqual([]);expect(h.drafts).toEqual([]);
});

test('a rejected grant after a choice change cannot set grantFailed or errors in the new choice',async()=>{
 const reply=deferred<Reply>();const h=harness({request:()=>reply.promise});
 h.actions.grant(h.initial);h.actions.chooseSource('chrome');h.states.length=0;
 reply.reject(new WorkroomBrowserError('grant-unavailable','Old grant failed'));await h.waitChoices();
 expect(h.states).toEqual([]);expect(h.chips).toEqual([]);expect(h.drafts).toEqual([]);
});

test('closing the matching browser releases the existing flight and a late finally cannot affect a new one',async()=>{
 const task=deferred();const h=harness();const running=h.actions.run(()=>task.promise);
 expect(h.flight.current).toBe(true);h.actions.onClosed();
 expect(h.flight.current).toBe(false);expect(h.epoch.current).toBe(1);
 expect(h.states).toContainEqual({kind:'busy',value:false});expect(h.memory.has(h.initial.sessionId)).toBe(false);
 h.flight.current=true;h.states.length=0;
 task.reject(new WorkroomBrowserError('grant-unavailable','Old action failed after close'));await running;
 expect(h.states).toEqual([]);expect(h.flight.current).toBe(true);
});

test('an old browser close callback cannot reset another target in the same session',()=>{
 const h=harness();h.binding.current={sessionId:h.initial.sessionId,targetId:'new-project'};h.flight.current=true;
 h.actions.onClosed();
 expect(h.epoch.current).toBe(0);expect(h.flight.current).toBe(true);expect(h.states).toEqual([]);
});

for(const chip of [true,false])for(const ended of ['generation','binding','unmounted'] as const){
 test(`a late grant response after ${ended} emits neither access chip nor draft (${chip?'chip callback':'legacy draft'})`,async()=>{
  const reply=deferred<Reply>();const h=harness({chip,request:()=>reply.promise});
  const running=h.actions.writeGrant(h.initial);
  if(ended==='generation')h.epoch.current++;else if(ended==='binding')h.binding.current={sessionId:'other-session',targetId:'other-project'};else h.mounted.current=false;
  reply.resolve({workspace:workspace({owner:'agent'}),grant:'synthetic-grant'});await running;h.flushFocus();
  expect(h.chips).toEqual([]);expect(h.drafts).toEqual([]);expect(h.applied).toEqual([]);expect(h.states).toEqual([]);expect(h.focused()).toBe(0);
 });
}

test('a current grant is delivered once, and a later animation frame never focuses a replacement composer',async()=>{
 const h=harness({request:async()=>({workspace:workspace({owner:'agent'}),grant:'synthetic-grant'})});
 await h.actions.writeGrant(h.initial);
 expect(h.requests.map(body=>body.operation)).toEqual(['grant']);expect(h.chips).toHaveLength(1);expect(h.drafts).toEqual([]);
 h.replace();h.flushFocus();expect(h.focused()).toBe(0);
});

test('only the first real collapse in each mounted session shows the localized preservation notice; reopening hides it',()=>{
 const source=slice(' const chooseView=',' const dividerLabel=');
 let shown=false,sessionId='session-first',preservedSession:string|null=null;
 const preservedSessions={current:new Set<string>()};
 const choose=(next:'terminal'|'split'|'browser')=>{
  const env={shown,sessionId,preservedSessions,stopDrag:{current:null},setPreservedSession:(value:string|null)=>{preservedSession=value;},setShown:(value:boolean)=>{shown=value;},setMode:()=>{},requestAnimationFrame:()=>0,panel:{current:null}};
  (new Function(...Object.keys(env),transpile(source)+';return chooseView;')(...Object.values(env)) as (view:typeof next)=>void)(next);
 };
 const line=frame.split('\n').find(line=>line.includes('data-testid="workroom-browser-preserved"'));
 expect(line).toBeDefined();
 const expression=line!.trim().slice(1,-1),jsx=new Bun.Transpiler({loader:'tsx',tsconfig:JSON.stringify({compilerOptions:{jsx:'react'}})}).transformSync(`const note=${expression};return note;`);
 const markup=(lang:'ko'|'en'='ko')=>renderToStaticMarkup(new Function('React','shown','preservedSession','sessionId','ui',jsx)({createElement},shown,preservedSession,sessionId,workroomBrowserUiCopy(lang)));
 choose('terminal');expect(preservedSession).toBeNull();expect(preservedSessions.current.size).toBe(0);expect(markup()).toBe('');
 choose('split');choose('browser');expect(preservedSession).toBeNull();
 choose('terminal');expect<string|null>(preservedSession).toBe(sessionId);
 for(const lang of ['ko','en'] as const){const html=markup(lang);expect(html).toContain('role="status"');expect(html).toContain(`title="${workroomBrowserUiCopy(lang).owner.preservedOnce}"`);expect(html).not.toContain('<button');}
 choose('split');expect(preservedSession).toBeNull();expect(markup()).toBe('');
 choose('terminal');expect(preservedSession).toBeNull();expect(markup()).toBe('');
 sessionId='session-second';choose('browser');choose('terminal');expect<string|null>(preservedSession).toBe(sessionId);
 sessionId='session-first';expect(markup()).toBe('');choose('split');choose('terminal');expect(preservedSession).toBeNull();
});

test('the preservation notice expires after five seconds and reopening or unmounting clears its timer',()=>{
 const source=slice(' useEffect(()=>{if(preservedSession===null)return;',' const ownedControls=');
 const scheduled=new Map<number,{callback:()=>void;delay:number}>();let next=0,value:string|null='session-first';
 const effect=(preservedSession:string|null)=>{
  let cleanup:(()=>void)|undefined;
  new Function('preservedSession','setPreservedSession','useEffect','setTimeout','clearTimeout',transpile(source))
   (preservedSession,(state:string|null)=>{value=state;},(callback:()=>void|(()=>void))=>{cleanup=callback()??undefined;},(callback:()=>void,delay:number)=>{scheduled.set(++next,{callback,delay});return next;},(id:number)=>{scheduled.delete(id);});
  return cleanup;
 };
 expect(effect(null)).toBeUndefined();expect(scheduled.size).toBe(0);
 const cleanup=effect(value);expect(scheduled.size).toBe(1);expect([...scheduled.values()][0]!.delay).toBe(5000);
 cleanup?.();expect(scheduled.size).toBe(0);
 effect(value);[...scheduled.values()][0]!.callback();expect(value).toBeNull();
});

function ownedSelectionHarness(request?:(body:WorkroomBrowserRequest)=>Promise<Reply>){
 const source=readFileSync(new URL('../src/OwnedWorkroomBrowser.tsx',import.meta.url),'utf8');
 const extract=(from:string,to:string)=>{const a=source.indexOf(from),b=source.indexOf(to,a);expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);return source.slice(a,b);};
 const first=workspace().page!,second={id:'page-second',title:'Second',url:'https://example.test/second'};
 const initial=workspace({tabs:[first,second]}),workspaceRef:{current:BrowserWorkspace|null}={current:initial};
 const epoch={current:0},selection={current:0},selectionPending={current:false},activeRef={current:'main'},tabsRef={current:[{tab:'main',targetId:first.id,url:first.url},{tab:'second',targetId:second.id,url:second.url}]};
 const requests:WorkroomBrowserRequest[]=[],applied:BrowserWorkspace[]=[],errors:unknown[]=[],native:string[]=[];let closed=0;
 const env={workspaceRef,epoch,selection,selectionPending,activeRef,tabsRef,phaseRef:{current:null},mounted:{current:true},versions:{current:new Map<string,number>()},
  sessionId:initial.sessionId,fastUntil:{current:0},lastPageUrl:{current:first.url},followed:{current:first.id},
  setActive:(tab:string)=>{activeRef.current=tab;},setError:()=>{},setFailure:()=>{},setUrl:()=>{},setPhase:()=>{},setOpened:()=>{},setNativeStatus:()=>{},setTabsState:()=>{},
  pageAddress:(url?:string)=>url==='about:blank'?'':url??'',inSet:(id:string)=>workspaceRef.current?.tabs?.some(page=>page.id===id),
  request:async(body:WorkroomBrowserRequest)=>{requests.push(body);return request?request(body):{};},
  onConnected:(w:BrowserWorkspace)=>{applied.push(w);workspaceRef.current=w;},captureError:(error:unknown)=>errors.push(error),
  ownedBrowserAction:async(_session:string,operation:string)=>{native.push(operation);return {};},forgetOwnedConnects:()=>{},MAIN:'main',
  onClosed:()=>{closed++;workspaceRef.current=null;},
 };
 const actions=new Function(...Object.keys(env),transpile(extract(' const showTab=',' /** Close one tab:')+extract(' const close=',' // The retry finishes'))+';return {showTab,close};')(...Object.values(env)) as {showTab:(tab:string)=>Promise<void>;close:()=>Promise<void>};
 return {actions,initial,first,second,workspaceRef,epoch,activeRef,selectionPending,requests,applied,errors,native,closed:()=>closed};
}

for(const outcome of ['success','failure'] as const)test(`a delayed owned tab selection ${outcome} after close cannot revive the workspace or show an old error`,async()=>{
 const reply=deferred<Reply>(),h=ownedSelectionHarness(body=>body.operation==='select'?reply.promise:Promise.resolve({}));
 const selecting=h.actions.showTab('second');expect(h.selectionPending.current).toBe(true);
 await h.actions.close();expect(h.closed()).toBe(1);expect(h.workspaceRef.current).toBeNull();expect(h.native).toEqual(['close']);
 if(outcome==='success')reply.resolve({workspace:{...h.initial,page:h.second}});else reply.reject(Error('Old select failed'));
 await selecting;expect(h.applied).toEqual([]);expect(h.errors).toEqual([]);expect(h.workspaceRef.current).toBeNull();
});

test('B then A sends A to the host even while its last snapshot still names A; late B never replaces it',async()=>{
 const reply=deferred<Reply>();let hostPage='';
 const h=ownedSelectionHarness(async body=>{
  if(body.operation!=='select')return {};
  hostPage=body.pageId;
  return body.pageId==='page-second'?reply.promise:{workspace:{...h.initial,page:h.first}};
 });
 const selecting=h.actions.showTab('second');h.activeRef.current='main';await h.actions.showTab('main');
 expect(h.requests.map(body=>body.operation==='select'?body.pageId:body.operation)).toEqual([h.second.id,h.first.id]);
 expect(hostPage).toBe(h.first.id);expect(h.activeRef.current).toBe('main');expect(h.applied.map(w=>w.page?.id)).toEqual([h.first.id]);
 reply.resolve({workspace:{...h.initial,page:h.second}});await selecting;
 expect(h.applied.map(w=>w.page?.id)).toEqual([h.first.id]);expect(h.workspaceRef.current?.page?.id).toBe(h.first.id);expect(h.errors).toEqual([]);
});

test('a selected-tab response cannot replace another workspace or newly observed agent ownership',async()=>{
 for(const changed of ['workspace','owner'] as const){
  const reply=deferred<Reply>(),h=ownedSelectionHarness(()=>reply.promise),selecting=h.actions.showTab('second');
  h.workspaceRef.current={...h.initial,...(changed==='workspace'?{id:'replacement-workspace'}:{owner:'agent' as const})};
  reply.resolve({workspace:{...h.initial,page:h.second}});await selecting;
  expect(h.applied).toEqual([]);expect(h.errors).toEqual([]);
 }
});

test('a pending close rechecks current ownership and connection, while an existing human workspace remains closable',async()=>{
 for(const owner of ['agent','observing','taking','disconnected','human'] as const){
  const h=ownedSelectionHarness();h.workspaceRef.current={...h.initial,owner,connection:owner==='human'||owner==='disconnected'?'disconnected':'connected'};
  await h.actions.close();expect(h.requests).toEqual([]);expect(h.native).toEqual([]);expect(h.closed()).toBe(0);expect(h.epoch.current).toBe(0);
 }
 const reaped=ownedSelectionHarness();await reaped.actions.close();
 expect(reaped.requests.map(body=>body.operation)).toEqual(['detach']);expect(reaped.native).toEqual(['close']);expect(reaped.closed()).toBe(1);
});
