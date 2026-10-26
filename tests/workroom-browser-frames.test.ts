import {describe,test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import {WorkroomCdpTransport,type BrowserCdp,type CdpSendOptions} from '../src/workroomCdpTransport';
import {WorkroomBrowserRecovery} from '../src/workroomBrowserRecovery';
import {parseBrowserAgentRequest} from '../src/workroomBrowserProtocol';
import {workroomBrowserMcpResult,WORKROOM_BROWSER_MCP_TOOL} from '../src/workroomBrowserMcp';
const profile={id:'chrome:Default',browserId:'chrome' as const,browserName:'Chrome',profileDirectory:'Default',profileName:'Test profile',accountLabel:null};
type Call={method:string;params:any;session?:string;options?:CdpSendOptions};
/** A page with a same-origin child frame in its own session and a cross-origin iframe that Chrome auto-attaches as a
 * child session — the way real Chrome reports them (the parent frame tree does not list the cross-origin frame). */
class FrameCdp implements BrowserCdp{
 events=new Set<(m:string,p:any,s?:string)=>void>();closers=new Set<()=>void>();calls:Call[]=[];closed=false;
 visible='visible';shot='/9j/'+'A'.repeat(400);bigShots=0;waitHits:boolean[]=[];hold:Promise<any>|null=null;
 snapshots:Record<string,any>={
  main:{url:'https://example.test/',title:'Main',text:'Main text',elements:[{selector:'#send',role:'button',name:'Send'},{selector:'#pick',role:'select',name:'Size',options:[{value:'s',label:'Small',selected:true},{value:'l',label:'Large'}]},{selector:'open-el:nth-of-type(1) >>> #inner',role:'button',name:'Inner',shadow:true}],hostKeys:['closed-el:nth-of-type(1)'],uncheckedHosts:0,iframes:2,scroll:{x:0,y:0,width:800,height:2400,viewportWidth:800,viewportHeight:600}},
  f1:{url:'https://example.test/same?token=secret#x',title:'Same',text:'Same child',elements:[{selector:'#same',role:'button',name:'Same',frame:'f1'}],hostKeys:[],iframes:0},
  f2:{url:'https://other.test/embed?session=abc',title:'Cross',text:'Cross child',elements:[{selector:'#cross',role:'input',name:'Cross field',frame:'f2'}],hostKeys:[],iframes:0},
 };
 contexts=new Map([['page-session|frame_main',1],['page-session|frame_same',2],['child-session|frame_cross',3]]);
 async send(method:string,params:any={},session?:string,options?:CdpSendOptions){
  this.calls.push({method,params,session,options});
  if(method==='Target.getTargets')return {targetInfos:[{targetId:'page_test',type:'page',title:'Test',url:'https://example.test/'},{targetId:'personal_tab',type:'page',title:'Personal',url:'https://personal.test/'}]};
  if(method==='Target.attachToTarget')return {sessionId:'page-session'};
  if(method==='Target.setAutoAttach'&&session==='page-session'){queueMicrotask(()=>{this.emit('Target.attachedToTarget',{sessionId:'child-session',targetInfo:{targetId:'frame_cross',type:'iframe',url:'https://other.test/embed'},waitingForDebugger:false},'page-session');this.emit('Target.attachedToTarget',{sessionId:'worker-session',targetInfo:{targetId:'worker',type:'worker',url:'https://example.test/w.js'}},'page-session');});return {};}
  if(method==='Page.getFrameTree')return session==='child-session'?{frameTree:{frame:{id:'frame_cross',url:'https://other.test/embed'}}}:{frameTree:{frame:{id:'frame_main',url:'https://example.test/'},childFrames:[{frame:{id:'frame_same',parentId:'frame_main',url:'https://example.test/same?token=secret'}}]}};
  if(method==='Page.createIsolatedWorld'){const id=this.contexts.get(`${session}|${params.frameId}`);if(!id)throw new Error('Chrome refused the bounded operation.');return {executionContextId:id};}
  if(method==='Runtime.getProperties')return {result:[{name:'0',value:{objectId:'host-0'}},{name:'length',value:{value:1}}]};
  if(method==='DOM.describeNode')return {node:{localName:'closed-el',shadowRoots:[{shadowRootType:'closed'}]}};
  if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:300,clientWidth:800,clientHeight:600}};
  if(method==='Page.captureScreenshot'){if(this.bigShots>0){this.bigShots--;return {data:'/9j/'+'B'.repeat(400000)};}return {data:this.shot};}
  if(method==='Runtime.evaluate'){
   const e=String(params.expression);
   if(e==='globalThis.__atzShadowHosts')return {result:{type:'object',objectId:'hosts'}};
   if(e==='document.visibilityState')return {result:{value:this.visible}};
   if(e.includes('getBoundingClientRect')&&!e.includes('maxElements'))return {result:{value:[100,50,200,80]}};
   const frame=/\(\d+,\d+,"(main|f\d+)"\)$/.exec(e)?.[1];
   if(frame)return {result:{value:JSON.stringify(this.snapshots[frame])}};
   if(e.startsWith('((s)=>')||e.startsWith('((t)=>'))return {result:{value:this.waitHits.shift()??false}};
   if(e.includes('.click()')&&this.hold)return this.hold;
   return {result:{value:true}};
  }
  return {};
 }
 emit(m:string,p:any,s?:string){for(const fn of this.events)fn(m,p,s);}
 onEvent(fn:(m:string,p:any,s?:string)=>void){this.events.add(fn);return()=>{this.events.delete(fn);};}onClose(fn:()=>void){this.closers.add(fn);}close(){if(this.closed)return;this.closed=true;for(const fn of this.closers)fn();}
 actions(){return this.calls.filter(c=>c.method==='Runtime.evaluate'&&/__atzHumanTouched\)throw/.test(c.params.expression));}
}
async function setup(o:{recovery?:WorkroomBrowserRecovery;clock?:{t:number}}={}){
 const cdp=new FrameCdp(),clock=o.clock;
 const host=new WorkroomBrowserHost({runningSession:()=>({targetId:'project_test'}),profiles:()=>[profile],endpoint:async()=>'ws://127.0.0.1:12345/devtools/browser/test-browser',connect:async()=>cdp,recovery:o.recovery,...(clock?{now:()=>clock.t,sleep:async(ms:number)=>{clock.t+=ms;}}:{})});
 const c=await host.perform({operation:'connect',sessionId:'session_test',targetId:'project_test',profileId:profile.id});if(!c.success||!c.workspace)throw Error();const id=c.workspace.id;
 await host.perform({operation:'select',workspaceId:id,pageId:'page_test',confirmProfile:true});await Bun.sleep(0);
 const ready=await host.perform({operation:'resume',workspaceId:id});if(!ready.success||!ready.workspace?.observation)throw Error('not ready');
 const g=await host.perform({operation:'grant',workspaceId:id});if(!g.success||!g.grant)throw Error();
 const access={workspaceId:id,grant:g.grant,epoch:ready.workspace.epoch};
 const observation=async()=>{const s=await host.perform({operation:'status',workspaceId:id});if(!s.success)throw Error();return s.workspace!.observation!;};
 return {host,cdp,id,access,observation};
}
describe('Workroom browser P1 — frames, shadow roots and bounded tools',()=>{
 test('one observation names same- and cross-origin frames by reference, open shadow elements, and closed shadow roots as unobservable',async()=>{
  const s=await setup();const o=await s.observation();
  expect(o.frames?.map(f=>[f.ref,f.url,f.crossOrigin,f.elements])).toEqual([['f1','https://example.test/same',false,1],['f2','https://other.test/embed',true,1]]);
  expect(JSON.stringify(o)).not.toContain('secret');expect(JSON.stringify(o)).not.toContain('session=abc');
  expect(o.elements.map(e=>[e.selector,e.frame??'main'])).toEqual([['#send','main'],['#pick','main'],['open-el:nth-of-type(1) >>> #inner','main'],['#same','f1'],['#cross','f2']]);
  expect(o.elements.find(e=>e.selector.includes('>>>'))?.shadow).toBe(true);
  expect(o.elements.find(e=>e.selector==='#pick')?.options).toEqual([{value:'s',label:'Small',selected:true},{value:'l',label:'Large'}]);
  expect(o.unobservable).toEqual([{kind:'closed-shadow-root',frame:'main',selector:'closed-el:nth-of-type(1)'}]);
  // The cross-origin frame is read in its own session; nothing else in the browser is observed.
  const worlds=s.cdp.calls.filter(c=>c.method==='Page.createIsolatedWorld').map(c=>`${c.session}|${c.params.frameId}`);
  expect([...new Set(worlds)].sort()).toEqual(['child-session|frame_cross','page-session|frame_main','page-session|frame_same']);
  expect(s.cdp.calls.some(c=>c.params?.targetId==='personal_tab')).toBe(false);
  // A worker auto-attached by an engine without target filters is let go, never observed.
  expect(s.cdp.calls.some(c=>c.method==='Target.detachFromTarget'&&c.params.sessionId==='worker-session')).toBe(true);
  s.host.dispose();
 });
 test('a frame action runs in that frame\'s isolated world and keeps the original main-document fingerprint',async()=>{
  const recovery=new WorkroomBrowserRecovery(':memory:');const s=await setup({recovery});let o=await s.observation();
  await s.host.agent({...s.access,operation:'fill',selector:'#cross',text:'cross value',frame:'f2',requestId:'frame_fill_001',observationId:o.id});
  o=await s.observation();await s.host.agent({...s.access,operation:'click',selector:'#send',requestId:'main_click_001',observationId:o.id});
  const [fill,click]=s.cdp.actions();expect([fill!.session,fill!.params.contextId]).toEqual(['child-session',3]);expect([click!.session,click!.params.contextId]).toEqual(['page-session',1]);
  const fp=(v:unknown[])=>createHash('sha256').update(JSON.stringify(v)).digest('hex');const saved=new Map(recovery.receipts(s.id).map(r=>[r.id,r]));
  expect(saved.get('main_click_001')).toEqual({id:'main_click_001',fingerprint:fp(['click','#send',undefined]),state:'completed'});
  expect(saved.get('frame_fill_001')?.fingerprint).toBe(fp(['fill','#cross','cross value','f2']));
  s.host.dispose();recovery.close();
 });
 test('a frame that detached or navigated since the observation is refused before any receipt opens',async()=>{
  const s=await setup();let o=await s.observation();
  s.cdp.emit('Target.detachedFromTarget',{sessionId:'child-session'},'page-session');
  await expect(s.host.agent({...s.access,operation:'click',selector:'#cross',frame:'f2',requestId:'stale_frame_01',observationId:o.id})).rejects.toThrow('Frame changed');
  s.cdp.emit('Page.frameNavigated',{frame:{id:'frame_same',parentId:'frame_main',url:'https://example.test/next'}},'page-session');
  await expect(s.host.agent({...s.access,operation:'click',selector:'#same',frame:'f1',requestId:'stale_frame_02',observationId:o.id})).rejects.toThrow('Frame changed');
  expect(s.cdp.actions()).toHaveLength(0);
  const status=await s.host.perform({operation:'status',workspaceId:s.id});expect(status.success&&status.workspace?.receipt).toBeUndefined();
  // Not an unknown outcome: the main document still accepts a write.
  await s.host.agent({...s.access,operation:'click',selector:'#send',requestId:'after_stale_01',observationId:o.id});expect(s.cdp.actions()).toHaveLength(1);
  s.host.dispose();
 });
 test('trusted human input inside a cross-origin frame revokes agent access like input in the main document',async()=>{
  const s=await setup();
  s.cdp.emit('Runtime.bindingCalled',{name:'__atzHumanTakeover',executionContextId:3,payload:'take'},'child-session');
  await expect(s.host.agent({...s.access,operation:'observe'})).rejects.toThrow('revoked');
  const st=await s.host.perform({operation:'status',workspaceId:s.id});expect(st.success&&st.workspace?.owner).toBe('human');
  // The same binding name from an unarmed world (a page script cannot reach the isolated world) changes nothing.
  const t=await setup();t.cdp.emit('Runtime.bindingCalled',{name:'__atzHumanTakeover',executionContextId:99},'child-session');
  expect((await t.host.agent({...t.access,operation:'observe'})).success).toBe(true);
  s.host.dispose();t.host.dispose();
 });
 test('returning control clears human input every armed frame saw while the person held control',async()=>{
  const s=await setup();await s.host.perform({operation:'take',workspaceId:s.id});const before=s.cdp.calls.length;
  await s.host.perform({operation:'resume',workspaceId:s.id});
  const resets=s.cdp.calls.slice(before).filter(c=>c.params?.expression==='globalThis.__atzHumanTouched=false').map(c=>`${c.session}|${c.params.contextId}`);
  expect(resets.sort()).toEqual(['child-session|3','page-session|1','page-session|2']);
  s.host.dispose();
 });
 test('select chooses an observed option as data, carries a receipt, and a reused request ID cannot change the value',async()=>{
  const s=await setup();const o=await s.observation();
  const r=await s.host.agent({...s.access,operation:'select',selector:'#pick',value:'Large"));alert(1);((',requestId:'select_001',observationId:o.id});expect(r.success&&r.workspace?.receipt).toEqual({id:'select_001',state:'completed'});
  const sent=s.cdp.actions()[0]!.params.expression as string;expect(sent).toContain(JSON.stringify('Large"));alert(1);(('));expect(sent).toContain('HTMLSelectElement');
  await expect(s.host.agent({...s.access,operation:'select',selector:'#pick',value:'Small',requestId:'select_001',observationId:(await s.observation()).id})).rejects.toThrow('Request ID reused');
  await expect(s.host.agent({...s.access,operation:'select',selector:'#pick',requestId:'select_002',observationId:(await s.observation()).id})).rejects.toThrow('Invalid bounded action');
  s.host.dispose();
 });
 test('scroll opens no receipt, names elements only from the latest observation, and refreshes it',async()=>{
  const s=await setup();const o=await s.observation();
  await expect(s.host.agent({...s.access,operation:'scroll',selector:'#send',observationId:'old-observation'})).rejects.toThrow('Observe again');
  await expect(s.host.agent({...s.access,operation:'scroll'})).rejects.toThrow('Name an observed element');
  const r=await s.host.agent({...s.access,operation:'scroll',deltaY:600});expect(r.success&&r.workspace?.observation?.id).not.toBe(o.id);expect(r.success&&r.workspace?.receipt).toBeUndefined();
  await s.host.agent({...s.access,operation:'scroll',selector:'#cross',frame:'f2',observationId:(await s.observation()).id});
  const scrolls=s.cdp.calls.filter(c=>c.method==='Runtime.evaluate'&&/scrollBy|scrollIntoView/.test(c.params.expression));
  expect(scrolls.map(c=>[c.session,c.params.contextId])).toEqual([['page-session',1],['child-session',3]]);
  s.host.dispose();
 });
 test('a bounded wait polls read-only, returns a fresh observation when met and reports a timeout as unmet',async()=>{
  const clock={t:0};const s=await setup({clock});s.cdp.waitHits=[false,false,true];
  const met=await s.host.agent({...s.access,operation:'wait',until:'text',text:'Saved',timeoutMs:2000});
  expect(met.success&&met.waited).toEqual({until:'text',satisfied:true,elapsedMs:300});
  const polls=s.cdp.calls.filter(c=>String(c.params?.expression).startsWith('((t)=>'));expect(polls).toHaveLength(3);expect(polls.every(c=>c.options?.read)).toBe(true);
  const unmet=await s.host.agent({...s.access,operation:'wait',until:'selector',selector:'#later',timeoutMs:450});
  expect(unmet.success&&unmet.waited?.satisfied).toBe(false);expect(unmet.success&&unmet.waited!.elapsedMs).toBeGreaterThanOrEqual(450);
  await expect(s.host.agent({...s.access,operation:'wait',timeoutMs:200})).rejects.toThrow('Say what to wait for');
  await expect(s.host.agent({...s.access,operation:'wait',until:'text',text:'x',timeoutMs:60000})).rejects.toThrow('Invalid agent request');
  s.host.dispose();
 });
 test('a wait selector names only tag, #id and .class parts: no attribute or state test, and no hidden or password field matches',async()=>{
  const s=await setup();const polls=()=>s.cdp.calls.filter(c=>String(c.params?.expression).startsWith('((s)=>'));
  for(const selector of ['input[type=password][value^="h"]','input[name=csrf]','#pw:not(.empty)','form:has(input)','input:placeholder-shown','a,b','li ~ li','li + li','#a\\:b','*|*','>p','p >','div > > p',' '])
   await expect(s.host.agent({...s.access,operation:'wait',until:'selector',selector,timeoutMs:200})).rejects.toThrow('tag, #id and .class');
  expect(polls()).toHaveLength(0);
  s.cdp.waitHits=[true,true,true,true,true];
  for(const selector of ['#later','div.card > button#go','open-el','  p.note  ','section .row>a.more'])expect((await s.host.agent({...s.access,operation:'wait',until:'selector',selector,timeoutMs:200})).success).toBe(true);
  const sent=polls().map(c=>String(c.params.expression));expect(sent).toHaveLength(5);
  for(const e of sent){expect(e).toContain('input[type=password],input[type=hidden],input[type=file]');expect(e).toContain('getClientRects');}
  s.host.dispose();
 });
 test('a long option list says how many options it leaves out and marks a cut value or label; select still reaches every option',async()=>{
  const s=await setup();
  s.cdp.snapshots.main.elements.push(
   {selector:'#country',role:'select',name:'Country',options:Array.from({length:12},(_,i)=>({value:'c'+i,label:'Country '+i})),moreOptions:38},
   {selector:'#plan',role:'select',name:'Plan',options:[{value:'x'.repeat(60),label:'L'.repeat(60),truncated:true}]},
   {selector:'#bad',role:'select',name:'Bad',options:[],moreOptions:-1},{selector:'#bad2',role:'select',name:'Bad2',options:[],moreOptions:'many'});
  const r=await s.host.agent({...s.access,operation:'observe'});if(!r.success)throw Error();const els=r.workspace!.observation!.elements,el=(k:string)=>els.find(e=>e.selector===k)!;
  expect(el('#country').moreOptions).toBe(38);expect(el('#country').options).toHaveLength(12);
  expect(el('#plan').options).toEqual([{value:'x'.repeat(60),label:'L'.repeat(60),truncated:true}]);expect(el('#plan').moreOptions).toBeUndefined();
  expect(el('#bad').moreOptions).toBeUndefined();expect(el('#bad2').moreOptions).toBeUndefined();expect(el('#pick').moreOptions).toBeUndefined();
  // The isolated-world snapshot counts what it leaves out; select takes a cut value or label by the text shown.
  const snapshot=String(s.cdp.calls.find(c=>/\(\d+,\d+,"main"\)$/.test(String(c.params?.expression)))!.params.expression);
  expect(snapshot).toContain('moreOptions');expect(snapshot).toContain('truncated');
  await s.host.agent({...s.access,operation:'select',selector:'#plan',value:'x'.repeat(60),requestId:'select_cut_01',observationId:r.workspace!.observation!.id});
  expect(String(s.cdp.actions().at(-1)!.params.expression)).toContain('startsWith');
  s.host.dispose();
 });
 test('until=navigation succeeds when the page navigates and says control went back to the person',async()=>{
  const s=await setup();const waiting=s.host.agent({...s.access,operation:'wait',until:'navigation',timeoutMs:3000});
  await Bun.sleep(20);s.cdp.emit('Page.frameNavigated',{frame:{id:'frame_main',url:'https://example.test/done'}},'page-session');
  const r=await waiting;expect(r.success&&r.waited?.satisfied).toBe(true);expect(r.success&&r.workspace?.owner).toBe('human');expect(r.success&&r.workspace?.page?.url).toBe('https://example.test/done');
  await expect(s.host.agent({...s.access,operation:'observe'})).rejects.toThrow();
  s.host.dispose();
 });
 test('a human takeover ends a running wait within one poll and the takeover itself is not held up',async()=>{
  const s=await setup();const waiting=s.host.agent({...s.access,operation:'wait',until:'selector',selector:'#never',timeoutMs:10000}).catch(e=>e);
  await Bun.sleep(30);const started=Date.now();await s.host.perform({operation:'take',workspaceId:s.id});
  expect(Date.now()-started).toBeLessThan(1500);expect(await waiting).toBeInstanceOf(Error);
  s.host.dispose();
 });
 test('a screenshot is the visible page only, bounded, returned once and kept in no state',async()=>{
  const s=await setup();
  const r=await s.host.agent({...s.access,operation:'screenshot'});if(!r.success||!r.screenshot)throw Error();
  expect(r.screenshot.mimeType).toBe('image/jpeg');expect([r.screenshot.width,r.screenshot.height]).toEqual([800,600]);
  const capture=s.cdp.calls.find(c=>c.method==='Page.captureScreenshot')!;expect(capture.session).toBe('page-session');expect(capture.params.clip).toEqual({x:0,y:300,width:800,height:600,scale:1});expect(capture.options?.read).toBeTruthy();
  const status=await s.host.perform({operation:'status',workspaceId:s.id});expect(JSON.stringify(status)).not.toContain(s.cdp.shot);
  // One observed element: clipped to its box inside the viewport.
  await s.host.agent({...s.access,operation:'screenshot',selector:'#send',observationId:(await s.observation()).id});
  expect(s.cdp.calls.filter(c=>c.method==='Page.captureScreenshot').at(-1)!.params.clip).toEqual({x:100,y:350,width:200,height:80,scale:1});
  await expect(s.host.agent({...s.access,operation:'screenshot',selector:'#cross',frame:'f2',observationId:(await s.observation()).id})).rejects.toThrow('main document');
  // Too large once: retried at a lower quality; too large twice: refused, never truncated.
  s.cdp.bigShots=1;expect((await s.host.agent({...s.access,operation:'screenshot'})).success).toBe(true);
  s.cdp.bigShots=2;await expect(s.host.agent({...s.access,operation:'screenshot'})).rejects.toThrow('too large');
  s.cdp.visible='hidden';await expect(s.host.agent({...s.access,operation:'screenshot'})).rejects.toThrow('not on screen');
  s.host.dispose();
 });
 test('the MCP result carries a screenshot once as image content, never as text',()=>{
  const data='/9j/'+'C'.repeat(64),r=workroomBrowserMcpResult({success:true,workspace:{id:'w'},screenshot:{mimeType:'image/jpeg',data,width:10,height:10}});
  expect(r.content).toHaveLength(2);expect(r.content[1]).toEqual({type:'image',data,mimeType:'image/jpeg'});
  expect(r.content[0]!.text).not.toContain(data);expect(JSON.stringify(r.structuredContent)).not.toContain(data);
  const plain=workroomBrowserMcpResult({success:true,workspace:{id:'w'}});expect(plain.content).toEqual([{type:'text',text:JSON.stringify({success:true,workspace:{id:'w'}})}]);
  expect(WORKROOM_BROWSER_MCP_TOOL.inputSchema.properties.operation.enum).toEqual(['observe','click','fill','select','scroll','wait','screenshot','receipt','tabs','switch-tab','request-human']);
 });
 test('agent requests stay bounded: frame references, distances, waits and unknown keys',()=>{
  const base={workspaceId:'w',grant:'g',epoch:1,operation:'observe'};
  expect(parseBrowserAgentRequest({...base,frame:'f12'}).frame).toBe('f12');
  for(const bad of [{frame:'f0'},{frame:'main2'},{frame:'../x'},{deltaY:20001},{deltaX:1.5},{timeoutMs:99},{timeoutMs:10001},{to:'left'},{until:'idle'},{operation:'evaluate'},{selector:'x'.repeat(1025)},{cookie:'x'}])expect(()=>parseBrowserAgentRequest({...base,...bad})).toThrow('Invalid agent request');
 });
 test('a read that times out is abandoned without closing the connection; its late reply is ignored',async()=>{
  let socket:any;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,srv){if(srv.upgrade(req))return;return new Response('no');},websocket:{open(ws){socket=ws;},message(){}}});
  try{
   const t=await WorkroomCdpTransport.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test-browser`);let closed=false;t.onClose(()=>{closed=true;});
   await expect(t.send('Page.captureScreenshot',{},'s',{read:{timeoutMs:150}})).rejects.toThrow('did not answer');expect(closed).toBe(false);
   socket.send(JSON.stringify({id:1,result:{data:'late'}}));await Bun.sleep(30);expect(closed).toBe(false);
   const next=t.send('Page.getLayoutMetrics',{},'s',{read:{timeoutMs:2000}});await Bun.sleep(20);socket.send(JSON.stringify({id:2,result:{ok:true}}));expect(await next).toEqual({ok:true});
   t.close();expect(closed).toBe(true);
  }finally{server.stop(true);}
 });
});
