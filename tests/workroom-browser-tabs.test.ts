import {describe,test,expect} from 'bun:test';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import type {BrowserCdp,CdpSendOptions} from '../src/workroomCdpTransport';
import {BROWSER_TAB_LIMIT,parseBrowserAgentRequest,parseWorkroomBrowserRequest} from '../src/workroomBrowserProtocol';
import {WORKROOM_BROWSER_MCP_TOOL} from '../src/workroomBrowserMcp';
import {WorkroomBrowserRecovery} from '../src/workroomBrowserRecovery';
const profile={id:'chrome:Default',browserId:'chrome' as const,browserName:'Chrome',profileDirectory:'Default',profileName:'Test profile',accountLabel:null};
type Call={method:string;params:any;session?:string;options?:CdpSendOptions;phase:string};
/** One browser shared by two Workrooms and the person: two tabs for Workroom A, one for Workroom B and the person's
 * own tab with private text. Each Workroom's binding has its own connection to it. */
class Browser{
 pages:Record<string,{title:string;url:string;text:string}>={
  tab_a1:{title:'A one',url:'https://a.test/one',text:'Workroom A first page'},
  tab_a2:{title:'A two',url:'https://a.test/two',text:'Workroom A second page'},
  tab_b1:{title:'B one',url:'https://b.test/one',text:'WORKROOM B PRIVATE PAGE'},
  personal_secret:{title:'Bank',url:'https://personal.test/inbox',text:'PERSONAL SECRET BALANCE'},
 };
 extra=0;contexts=new Map<string,number>();next=10;
 context(session:string){if(!this.contexts.has(session))this.contexts.set(session,this.next++);return this.contexts.get(session)!;}
 add(id:string){this.pages[id]={title:id,url:`https://a.test/${id}`,text:`page ${id}`};}
}
class TabCdp implements BrowserCdp{
 events=new Set<(m:string,p:any,s?:string)=>void>();closers=new Set<()=>void>();calls:Call[]=[];closed=false;phase='human';
 /** `lose`: the next page action is dispatched but its reply never arrives, so its outcome is unknown. */
 lose=false;dispatched:string[]=[];
 constructor(private browser:Browser){}
 private target(session?:string){return session?.startsWith('s:')?session.slice(2):undefined;}
 async send(method:string,params:any={},session?:string,options?:CdpSendOptions){
  this.calls.push({method,params,session,options,phase:this.phase});
  const b=this.browser;
  if(method==='Runtime.evaluate'&&/__atzHumanTouched\)throw/.test(String(params.expression))){this.dispatched.push(this.target(session)!);if(this.lose)throw new Error('Chrome connection lost; the action outcome is unknown.');return {result:{value:true}};}
  if(method==='Target.getTargets')return {targetInfos:Object.entries(b.pages).map(([targetId,p])=>({targetId,type:'page',title:p.title,url:p.url}))};
  if(method==='Target.getTargetInfo'){const p=b.pages[params.targetId];if(!p)throw new Error('No target');return {targetInfo:{targetId:params.targetId,type:'page',title:p.title,url:p.url}};}
  if(method==='Target.attachToTarget'){if(!b.pages[params.targetId])throw new Error('No target');return {sessionId:`s:${params.targetId}`};}
  if(method==='Page.getFrameTree'){const t=this.target(session)!;return {frameTree:{frame:{id:`frame:${t}`,url:b.pages[t]!.url}}};}
  if(method==='Page.createIsolatedWorld')return {executionContextId:b.context(session!)};
  if(method==='Runtime.evaluate'){
   const e=String(params.expression);
   if(/\(\d+,\d+,"main"\)$/.test(e)){const p=b.pages[this.target(session)!]!;return {result:{value:JSON.stringify({url:p.url,title:p.title,text:p.text,elements:[{selector:'#go',role:'button',name:'Go'}],hostKeys:[],uncheckedHosts:0,iframes:0,scroll:{x:0,y:0,width:800,height:600,viewportWidth:800,viewportHeight:600}})}};}
   return {result:{value:true}};
  }
  return {};
 }
 emit(m:string,p:any,s?:string){for(const fn of this.events)fn(m,p,s);}
 onEvent(fn:(m:string,p:any,s?:string)=>void){this.events.add(fn);return()=>{this.events.delete(fn);};}onClose(fn:()=>void){this.closers.add(fn);}close(){if(this.closed)return;this.closed=true;for(const fn of this.closers)fn();}
 /** The person (or a page) navigates a tab: its old worlds are gone and a new document gets a new world. */
 navigate(targetId:string,url:string){const session=`s:${targetId}`;this.browser.pages[targetId]!.url=url;this.browser.contexts.delete(session);this.emit('Runtime.executionContextsCleared',{},session);this.emit('Page.frameNavigated',{frame:{id:`frame:${targetId}`,url}},session);}
 agentCalls(){return this.calls.filter(c=>c.phase==='agent');}
}
async function setup(){
 const browser=new Browser(),connections:TabCdp[]=[];
 const host=new WorkroomBrowserHost({runningSession:id=>({targetId:id==='session_b'?'project_b':'project_a'}),profiles:()=>[profile],endpoint:async()=>'ws://127.0.0.1:12345/devtools/browser/shared',connect:async()=>{const c=new TabCdp(browser);connections.push(c);return c;}});
 const a=await host.perform({operation:'connect',sessionId:'session_a',targetId:'project_a',profileId:profile.id});const aId=a.success?a.workspace!.id:'';const cdpA=connections[0]!;
 await host.perform({operation:'select',workspaceId:aId,pageId:'tab_a1',confirmProfile:true});
 await host.perform({operation:'select',workspaceId:aId,pageId:'tab_a2',confirmProfile:true,add:true});
 const bConnect=await host.perform({operation:'connect',sessionId:'session_b',targetId:'project_b',profileId:profile.id});const bId=bConnect.success?bConnect.workspace!.id:'';const cdpB=connections[1]!;
 await host.perform({operation:'select',workspaceId:bId,pageId:'tab_b1',confirmProfile:true});
 const handOver=async()=>{const ready=await host.perform({operation:'resume',workspaceId:aId});if(!ready.success||!ready.workspace)throw Error('not ready');const g=await host.perform({operation:'grant',workspaceId:aId});if(!g.success||!g.grant)throw Error('no grant');cdpA.phase='agent';return {workspaceId:aId,grant:g.grant,epoch:ready.workspace.epoch};};
 const status=async()=>{const s=await host.perform({operation:'status',workspaceId:aId});if(!s.success)throw Error();return s.workspace!;};
 return {host,browser,cdpA,cdpB,aId,bId,handOver,status};
}
const ids=(w:{tabs?:{id:string}[]})=>(w.tabs??[]).map(t=>t.id);
const outside=['personal_secret','tab_b1','PERSONAL SECRET','personal.test','WORKROOM B PRIVATE','b.test'];
function expectOnlyOwn(value:unknown){const text=JSON.stringify(value);for(const word of outside)expect(text).not.toContain(word);}
describe('Workroom browser P1 — a Workroom\'s own tab set',()=>{
 test('agent tools list and reach only this Workroom\'s own tabs, never the person\'s other tabs or another Workroom\'s',async()=>{
  const s=await setup();const access=await s.handOver();
  let r=await s.host.agent({...access,operation:'tabs'});if(!r.success)throw Error();
  expect(ids(r.workspace!)).toEqual(['tab_a1','tab_a2']);expect(r.workspace!.page?.id).toBe('tab_a2');expectOnlyOwn(r);
  r=await s.host.agent({...access,operation:'switch-tab',tab:'tab_a1'});if(!r.success)throw Error();
  expect(r.workspace!.page?.id).toBe('tab_a1');expect(r.workspace!.observation?.text).toBe('Workroom A first page');expectOnlyOwn(r);
  for(const tab of ['personal_secret','tab_b1','tab_unknown'])await expect(s.host.agent({...access,operation:'switch-tab',tab})).rejects.toThrow('not one of this Workroom\'s tabs');
  // The set is read tab by tab with its own ids: no browser-wide list, and no other target is ever named.
  const agent=s.cdpA.agentCalls();expect(agent.some(c=>c.method==='Target.getTargets')).toBe(false);
  expect(agent.filter(c=>c.method==='Target.getTargetInfo').map(c=>c.params.targetId).sort()).toEqual(['tab_a1','tab_a1','tab_a2']);
  expect(s.cdpA.calls.some(c=>['personal_secret','tab_b1'].includes(c.params?.targetId)||['s:personal_secret','s:tab_b1'].includes(c.session??''))).toBe(false);
  // Workroom B's own set is untouched by A and holds only its tab.
  const b=await s.host.perform({operation:'status',workspaceId:s.bId});if(!b.success)throw Error();expect(ids(b.workspace!)).toEqual(['tab_b1']);
  s.host.dispose();
 });
 test('a person can add only a tab no other Workroom holds, and the set has a limit',async()=>{
  const s=await setup();
  await expect(s.host.perform({operation:'select',workspaceId:s.aId,pageId:'tab_b1',confirmProfile:true,add:true})).rejects.toThrow('already attached to another Workroom');
  for(let i=3;i<=BROWSER_TAB_LIMIT;i++){s.browser.add(`tab_a${i}`);await s.host.perform({operation:'select',workspaceId:s.aId,pageId:`tab_a${i}`,confirmProfile:true,add:true});}
  expect(ids(await s.status()).length).toBe(BROWSER_TAB_LIMIT);s.browser.add('tab_over');
  await expect(s.host.perform({operation:'select',workspaceId:s.aId,pageId:'tab_over',confirmProfile:true,add:true})).rejects.toThrow(`already has ${BROWSER_TAB_LIMIT} tabs`);
  // Choosing a tab outside the set without `add` still replaces the whole set, as it always has, and never closes a tab.
  s.browser.add('tab_new');await s.host.perform({operation:'select',workspaceId:s.aId,pageId:'tab_new',confirmProfile:true});const w=await s.status();
  expect(ids(w)).toEqual(['tab_new']);expect(s.cdpA.calls.some(c=>c.method==='Target.closeTarget')).toBe(false);
  expect(s.cdpA.calls.filter(c=>c.method==='Target.detachFromTarget').map(c=>c.params.sessionId).sort()).toEqual(['s:tab_a1','s:tab_a2','s:tab_a3','s:tab_a4','s:tab_a5','s:tab_a6']);
  s.host.dispose();
 });
 test('trusted human input in a background tab of the set revokes the agent',async()=>{
  const s=await setup();const access=await s.handOver();
  const world=s.browser.contexts.get('s:tab_a1')!;expect(world).toBeGreaterThan(0);
  s.cdpA.emit('Runtime.bindingCalled',{name:'__atzHumanTakeover',executionContextId:world,payload:'take'},'s:tab_a1');
  expect((await s.status()).owner).toBe('human');
  await expect(s.host.agent({...access,operation:'tabs'})).rejects.toThrow();
  s.host.dispose();
 });
 test('a background tab\'s navigation keeps the lease and re-arms its new document; the active tab\'s navigation still ends it',async()=>{
  const s=await setup();const access=await s.handOver();
  const armed=()=>s.cdpA.calls.filter(c=>c.method==='Runtime.addBinding'&&c.session==='s:tab_a1').length,before=armed();
  s.cdpA.navigate('tab_a1','https://a.test/one-next');
  let w=await s.status();expect(w.owner).toBe('agent');expect(w.tabs?.find(t=>t.id==='tab_a1')?.url).toBe('https://a.test/one-next');
  s.cdpA.emit('Runtime.executionContextCreated',{context:{id:99,auxData:{isDefault:true,frameId:'frame:tab_a1'}}},'s:tab_a1');await Bun.sleep(0);await Bun.sleep(0);
  expect(armed()).toBe(before+1);
  // The re-armed world revokes on human input like any other.
  s.cdpA.emit('Runtime.bindingCalled',{name:'__atzHumanTakeover',executionContextId:s.browser.contexts.get('s:tab_a1')!,payload:'take'},'s:tab_a1');
  expect((await s.status()).owner).toBe('human');
  const again=await s.handOver();s.cdpA.navigate('tab_a2','https://a.test/two-next');w=await s.status();
  expect(w.owner).toBe('human');await expect(s.host.agent({...again,operation:'observe'})).rejects.toThrow();
  void access;s.host.dispose();
 });
 test('switch-tab needs a fresh observation before acting, and the action runs in the active tab only',async()=>{
  const s=await setup();const access=await s.handOver();
  const first=(await s.status()).observation!;
  const r=await s.host.agent({...access,operation:'switch-tab',tab:'tab_a1'});if(!r.success)throw Error();
  await expect(s.host.agent({...access,operation:'click',selector:'#go',requestId:'tabs_click_old',observationId:first.id})).rejects.toThrow('Observe again');
  await s.host.agent({...access,operation:'click',selector:'#go',requestId:'tabs_click_new',observationId:r.workspace!.observation!.id});
  const action=s.cdpA.calls.filter(c=>c.method==='Runtime.evaluate'&&/__atzHumanTouched\)throw/.test(c.params.expression));
  expect(action.map(c=>c.session)).toEqual(['s:tab_a1']);
  s.host.dispose();
 });
 test('release takes a tab out of the set without closing it; a closed tab leaves the set; closing the active tab ends the lease',async()=>{
  const s=await setup();await s.handOver();
  await expect(s.host.perform({operation:'release',workspaceId:s.aId,pageId:'tab_a1'})).rejects.toThrow('Take control');
  await s.host.perform({operation:'take',workspaceId:s.aId});s.cdpA.phase='human';
  await s.host.perform({operation:'release',workspaceId:s.aId,pageId:'tab_a1'});
  let w=await s.status();expect(ids(w)).toEqual(['tab_a2']);
  expect(s.cdpA.calls.some(c=>c.method==='Target.detachFromTarget'&&c.params.sessionId==='s:tab_a1')).toBe(true);expect(s.cdpA.calls.some(c=>c.method==='Target.closeTarget')).toBe(false);
  await expect(s.host.perform({operation:'release',workspaceId:s.aId,pageId:'personal_secret'})).rejects.toThrow('not in this Workroom');
  await s.host.perform({operation:'select',workspaceId:s.aId,pageId:'tab_a1',confirmProfile:true,add:true});
  const access=await s.handOver();
  s.cdpA.emit('Target.targetDestroyed',{targetId:'tab_a2'});w=await s.status();expect(ids(w)).toEqual(['tab_a1']);expect(w.owner).toBe('agent');
  s.cdpA.emit('Target.targetDestroyed',{targetId:'tab_a1'});w=await s.status();expect(ids(w)).toEqual([]);expect(w.owner).toBe('human');expect(w.page).toBeNull();
  await expect(s.host.agent({...access,operation:'tabs'})).rejects.toThrow();
  s.host.dispose();
 });
 test('a returning human switches within the set without re-attaching, and a background tab that cannot be watched blocks the handover',async()=>{
  const s=await setup();
  const attaches=()=>s.cdpA.calls.filter(c=>c.method==='Target.attachToTarget').length,count=attaches();
  await s.host.perform({operation:'select',workspaceId:s.aId,pageId:'tab_a1',confirmProfile:true});
  let w=await s.status();expect(w.page?.id).toBe('tab_a1');expect(ids(w)).toEqual(['tab_a1','tab_a2']);expect(attaches()).toBe(count);
  // A background tab mid-navigation has no world yet; handing control over waits for it rather than leaving it unwatched.
  s.cdpA.navigate('tab_a2','https://a.test/two-next');
  const original=s.cdpA.send.bind(s.cdpA);s.cdpA.send=async(method,params,session,options)=>{if(method==='Page.createIsolatedWorld'&&session==='s:tab_a2')throw new Error('Frame not ready');return original(method,params,session,options);};
  await expect(s.host.perform({operation:'resume',workspaceId:s.aId})).rejects.toThrow('Another tab of this Workroom is not ready');
  w=await s.status();expect(w.owner).toBe('human');
  s.cdpA.send=original;const ok=await s.host.perform({operation:'resume',workspaceId:s.aId});expect(ok.success&&ok.workspace?.owner).toBe('agent');
  s.host.dispose();
 });
 test('a built-in browser adds only native pages this Workroom opens, on the same engine, while the person holds control',async()=>{
  const browser=new Browser();browser.add('native_1');browser.add('native_2');browser.add('native_3');
  const engine=()=>{const ports={port:0};const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${ports.port}/devtools/browser/engine`})});ports.port=server.port!;return server;};
  const server=engine(),other=engine();
  const connections:TabCdp[]=[];
  const host=new WorkroomBrowserHost({runningSession:()=>({targetId:'project_a'}),profiles:()=>[profile],connect:async()=>{const c=new TabCdp(browser);connections.push(c);return c;}});
  try{
   const first=await host.perform({operation:'connect-owned',sessionId:'session_a',targetId:'project_a',port:server.port!,pageId:'native_1'});if(!first.success)throw Error();const id=first.workspace!.id;
   const added=await host.perform({operation:'connect-owned',sessionId:'session_a',targetId:'project_a',port:server.port!,pageId:'native_2'});if(!added.success)throw Error();
   expect(added.workspace!.id).toBe(id);expect(added.workspace!.page?.id).toBe('native_2');expect(ids(added.workspace!)).toEqual(['native_1','native_2']);
   // Another engine (another port) is never mixed into this Workroom's set.
   await expect(host.perform({operation:'connect-owned',sessionId:'session_a',targetId:'project_a',port:other.port!,pageId:'native_3'})).rejects.toThrow('Detach the original browser');
   // The person's picker lists only this Workroom's own native pages, never the rest of the engine.
   const pages=await host.perform({operation:'pages',workspaceId:id});if(!pages.success)throw Error();expect(pages.pages!.map(p=>p.id).sort()).toEqual(['native_1','native_2']);
   const ready=await host.perform({operation:'resume',workspaceId:id});if(!ready.success)throw Error();
   await expect(host.perform({operation:'connect-owned',sessionId:'session_a',targetId:'project_a',port:server.port!,pageId:'native_3'})).rejects.toThrow('Take control');
   const after=await host.perform({operation:'status',workspaceId:id});if(!after.success)throw Error();expect(ids(after.workspace!)).toEqual(['native_1','native_2']);
   const refused=await host.perform({operation:'pages',workspaceId:id}).catch(()=>null);expect(refused===null||!JSON.stringify(refused).includes('native_3')).toBe(true);
  }finally{host.dispose();server.stop(true);other.stop(true);}
 });
 test('request shapes stay bounded and the MCP schema names the tab operations',()=>{
  expect(parseBrowserAgentRequest({workspaceId:'w',grant:'g',operation:'switch-tab',epoch:1,tab:'tab_a1'}).tab).toBe('tab_a1');
  expect(()=>parseBrowserAgentRequest({workspaceId:'w',grant:'g',operation:'switch-tab',epoch:1,tab:'x'.repeat(181)})).toThrow('Invalid agent request.');
  expect(()=>parseBrowserAgentRequest({workspaceId:'w',grant:'g',operation:'switch-tab',epoch:1,tab:7})).toThrow('Invalid agent request.');
  expect(parseWorkroomBrowserRequest({operation:'select',workspaceId:'w',pageId:'p',confirmProfile:true,add:true})).toEqual({operation:'select',workspaceId:'w',pageId:'p',confirmProfile:true,add:true});
  expect(()=>parseWorkroomBrowserRequest({operation:'select',workspaceId:'w',pageId:'p',confirmProfile:true,add:false})).toThrow('Invalid browser binding.');
  expect(parseWorkroomBrowserRequest({operation:'release',workspaceId:'w',pageId:'p'}).operation).toBe('release');
  expect(()=>parseWorkroomBrowserRequest({operation:'release',workspaceId:'w'})).toThrow('Invalid browser binding.');
  const schema=WORKROOM_BROWSER_MCP_TOOL.inputSchema.properties as any;
  expect(schema.operation.enum).toEqual(expect.arrayContaining(['tabs','switch-tab']));expect(schema.tab).toEqual({type:'string',maxLength:180});
 });
});
/** One host for every Workroom, as in the app, with the durable recovery store: what a Workroom's tab set may hold when
 * another task left an action whose outcome is unknown. */
async function recovered(){
 const browser=new Browser(),recovery=new WorkroomBrowserRecovery(':memory:'),connections:TabCdp[]=[];
 const host=new WorkroomBrowserHost({runningSession:id=>({targetId:id.startsWith('session_b')?'project_b':'project_a'}),profiles:()=>[profile],endpoint:async()=>'ws://127.0.0.1:12345/devtools/browser/shared',connect:async()=>{const c=new TabCdp(browser);connections.push(c);return c;},recovery});
 const workspace=(r:Awaited<ReturnType<typeof host.perform>>)=>{if(!r.success||!r.workspace)throw Error('no workspace');return r.workspace;};
 const open=async(sessionId:string,targetId:string,first:string,...more:string[])=>{
  const id=workspace(await host.perform({operation:'connect',sessionId,targetId,profileId:profile.id})).id,cdp=connections.at(-1)!;
  await host.perform({operation:'select',workspaceId:id,pageId:first,confirmProfile:true});
  for(const page of more)await host.perform({operation:'select',workspaceId:id,pageId:page,confirmProfile:true,add:true});
  return {id,cdp};
 };
 const hand=async(id:string)=>{const ready=workspace(await host.perform({operation:'resume',workspaceId:id}));const g=await host.perform({operation:'grant',workspaceId:id});if(!g.success||!g.grant)throw Error('no grant');return {workspaceId:id,grant:g.grant,epoch:ready.epoch,observationId:ready.observation!.id};};
 const status=async(id:string)=>workspace(await host.perform({operation:'status',workspaceId:id}));
 return {browser,recovery,host,open,hand,status,workspace};
}
describe('Workroom browser P1 — a tab set never outruns an unknown action',()=>{
 test('adding a tab that another task left with an unknown action is refused in every project; choosing it alone continues that task',async()=>{
  const s=await recovered();
  // Task 1 clicks in tab_a1 and loses the reply: the outcome is unknown. The person ends that Workroom's connection.
  const first=await s.open('session_1','project_a','tab_a1');const a=await s.hand(first.id);first.cdp.lose=true;
  await expect(s.host.agent({...a,operation:'click',selector:'#go',requestId:'pay_click_1'})).rejects.toThrow();
  await s.host.perform({operation:'detach',workspaceId:first.id});
  // A new Workroom of the same project works in tab_a2 and adds tab_a1: refused before anything is attached.
  const second=await s.open('session_2','project_a','tab_a2');
  await expect(s.host.perform({operation:'select',workspaceId:second.id,pageId:'tab_a1',confirmProfile:true,add:true})).rejects.toThrow('unresolved action in another task');
  let w=await s.status(second.id);expect(ids(w)).toEqual(['tab_a2']);expect(w.receipt).toBeUndefined();
  expect(second.cdp.calls.some(c=>c.method==='Target.attachToTarget'&&c.params.targetId==='tab_a1')).toBe(false);
  // Its own record was never pointed at tab_a1, so task 1 stays the task of that tab.
  expect(s.recovery.get(second.id)?.pageId).toBe('tab_a2');
  // Another project's Workroom cannot add it either.
  const other=await s.open('session_b','project_b','tab_b1');
  await expect(s.host.perform({operation:'select',workspaceId:other.id,pageId:'tab_a1',confirmProfile:true,add:true})).rejects.toThrow('another project');
  // Choosing tab_a1 alone continues task 1: its unknown result is reviewed before any agent gets control.
  w=s.workspace(await s.host.perform({operation:'select',workspaceId:second.id,pageId:'tab_a1',confirmProfile:true}));
  expect(w.receipt).toEqual({id:'pay_click_1',state:'unknown'});
  await expect(s.host.perform({operation:'resume',workspaceId:second.id})).rejects.toThrow('Review the unknown');
  expect(first.cdp.dispatched).toEqual(['tab_a1']);expect(second.cdp.dispatched).toEqual([]);
  s.host.dispose();s.recovery.close();
 });
 test('handing control over checks every tab of the set against other tasks\' unknown actions',async()=>{
  const s=await recovered();const w=await s.open('session_1','project_a','tab_a1','tab_a2');
  // Another task's unknown action on tab_a2 (left by an earlier host, say) blocks the handover of the whole set.
  s.recovery.save({...await s.status(w.id),id:'task_elsewhere',sessionId:'session_old',page:{id:'tab_a9',title:'',url:''}},'task_elsewhere');
  s.recovery.record('task_elsewhere',{id:'old_click',fingerprint:'f',state:'unknown'},'tab_a2');
  await expect(s.host.perform({operation:'resume',workspaceId:w.id})).rejects.toThrow('unresolved action in another task');
  expect((await s.status(w.id)).owner).toBe('human');expect(w.cdp.dispatched).toEqual([]);
  // Once it is reviewed there, the same set is handed over.
  s.recovery.record('task_elsewhere',{id:'old_click',fingerprint:'f',state:'reviewed'});
  expect(s.workspace(await s.host.perform({operation:'resume',workspaceId:w.id})).owner).toBe('agent');
  s.host.dispose();s.recovery.close();
 });
 test('an agent\'s switch-tab moves the recovery record, and an unknown action is found again from the tab where it ran',async()=>{
  const s=await recovered();
  const first=await s.open('session_1','project_a','tab_a1','tab_a2');const a=await s.hand(first.id);
  expect(s.recovery.get(first.id)?.pageId).toBe('tab_a2');
  const switched=await s.host.agent({...a,operation:'switch-tab',tab:'tab_a1'});
  expect(s.recovery.get(first.id)?.pageId).toBe('tab_a1');
  first.cdp.lose=true;
  await expect(s.host.agent({...a,operation:'click',selector:'#go',requestId:'pay_click_1',observationId:s.workspace(switched).observation!.id})).rejects.toThrow();
  // Reading stays possible: switching back moves the record again, but the receipt keeps the tab it ran in.
  await s.host.agent({...a,operation:'switch-tab',tab:'tab_a2'});expect(s.recovery.get(first.id)?.pageId).toBe('tab_a2');
  await s.host.perform({operation:'detach',workspaceId:first.id});
  // Next session, same project: the person picks the tab where the action ran.
  const next=await s.open('session_2','project_a','tab_a1');
  expect((await s.status(next.id)).receipt).toEqual({id:'pay_click_1',state:'unknown'});
  await expect(s.host.perform({operation:'resume',workspaceId:next.id})).rejects.toThrow('Review the unknown');
  expect(first.cdp.dispatched).toEqual(['tab_a1']);expect(next.cdp.dispatched).toEqual([]);
  s.host.dispose();s.recovery.close();
 });
 test('another tab of a built-in Workroom restored from a saved task joins in the profile that browser runs in',async()=>{
  const browser=new Browser();for(const id of ['native_old','native_new','native_tab','native_x'])browser.add(id);
  const recovery=new WorkroomBrowserRecovery(':memory:');let port=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/engine`})});port=server.port!;
  const host=new WorkroomBrowserHost({runningSession:()=>({targetId:'project_a'}),profiles:()=>[profile],connect:async()=>new TabCdp(browser),recovery});
  const workspace=(r:Awaited<ReturnType<typeof host.perform>>)=>{if(!r.success||!r.workspace)throw Error('no workspace');return r.workspace;};
  try{
   // Before a restart: session_old's own built-in page becomes a saved task.
   const saved=workspace(await host.perform({operation:'connect-owned',sessionId:'session_old',targetId:'project_a',port,pageId:'native_old',profileKey:'session_old'})).id;
   await host.perform({operation:'detach',workspaceId:saved});
   // A new connection names only this Workroom's own profile or the chosen saved task's.
   await expect(host.perform({operation:'connect-owned',sessionId:'session_fresh',targetId:'project_a',port,pageId:'native_x',profileKey:'session_old'})).rejects.toThrow('profile');
   await expect(host.perform({operation:'connect-owned',sessionId:'session_fresh',targetId:'project_a',port,pageId:'native_x',recoveryId:saved,profileKey:'session_fresh'})).rejects.toThrow('profile');
   // After it: session_new restores that task. The panel later forgets the choice, so a new tab names no saved task,
   // only the profile its native page runs in: the restored one.
   const w=workspace(await host.perform({operation:'connect-owned',sessionId:'session_new',targetId:'project_a',port,pageId:'native_new',recoveryId:saved,profileKey:'session_old'}));
   expect(w.profileId).toBe('owned:session_old');
   const joined=workspace(await host.perform({operation:'connect-owned',sessionId:'session_new',targetId:'project_a',port,pageId:'native_tab',profileKey:'session_old'}));
   expect(joined.id).toBe(w.id);expect(ids(joined)).toEqual(['native_new','native_tab']);expect(joined.page?.id).toBe('native_tab');
   // A page of any other profile is still refused: this session's own, one nobody chose, or none named.
   for(const profileKey of ['session_new','someone_else',undefined])await expect(host.perform({operation:'connect-owned',sessionId:'session_new',targetId:'project_a',port,pageId:'native_x',...(profileKey?{profileKey}:{})})).rejects.toThrow('Detach the original browser');
  }finally{host.dispose();server.stop(true);recovery.close();}
 });
 test('closing the active tab of a set leaves the other tabs connected; losing the last tab or the browser lists no closed tab',async()=>{
  const s=await setup();const access=await s.handOver();
  delete s.browser.pages.tab_a2;s.cdpA.emit('Inspector.detached',{reason:'target_closed'},'s:tab_a2');
  let w=await s.status();expect(w.connection).toBe('connected');expect(ids(w)).toEqual(['tab_a1']);expect(w.page?.id).toBe('tab_a1');expect(w.owner).toBe('human');
  expect(s.cdpA.closed).toBe(false);await expect(s.host.agent({...access,operation:'tabs'})).rejects.toThrow();
  // The remaining tab is handed over again without reconnecting.
  const again=await s.handOver();const tabs=await s.host.agent({...again,operation:'tabs'});expect(tabs.success&&ids(tabs.workspace!)).toEqual(['tab_a1']);
  s.cdpA.emit('Inspector.detached',{reason:'target_closed'},'s:tab_a1');
  w=await s.status();expect(w.connection).toBe('disconnected');expect(w.tabs).toBeUndefined();expect(w.page).toBeNull();
  // A browser connection that goes away entirely leaves no tab listed either.
  s.cdpB.close();const b=await s.host.perform({operation:'status',workspaceId:s.bId});if(!b.success)throw Error();
  expect(b.workspace!.connection).toBe('disconnected');expect(b.workspace!.tabs).toBeUndefined();expect(b.workspace!.page).toBeNull();
  s.host.dispose();
 });
});
