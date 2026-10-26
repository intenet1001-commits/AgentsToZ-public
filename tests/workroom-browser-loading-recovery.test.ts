import {expect,test} from 'bun:test';
import type {NativeStatus} from '../src/OwnedWorkroomBrowser';
import type {WorkroomBrowserPhase} from '../src/WorkroomBrowserFrameToolbar';
import type {BrowserWorkspace,WorkroomBrowserRequest} from '../src/workroomBrowserProtocol';
import {canReplaceLoadingRequest,canRunNav,canStopNav,type NativeNavOperation} from '../src/workroomBrowserNativeNav';
import {claimOwnedConnect,forgetOwnedConnect,forgetOwnedConnects,normalizeOwnedBrowserAddress,ownedRequestIntent,ownedViewKey,pendingOwnedConnect,rememberOwnedConnect,startOwnedBrowser} from '../src/workroomBrowserNavigation';
import {classifyWorkroomBrowserError} from '../src/workroomBrowserErrorCodes';

const ref=<T,>(current:T)=>({current});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('Recovery handler did not settle');}
let serial=0;

/** Run the production request handlers with controllable native replies. No page, CEF or host is launched. */
async function recoveryHarness(){
 const source=await Bun.file(new URL('../src/OwnedWorkroomBrowser.tsx',import.meta.url)).text();
 const slice=(from:string,to:string)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
 const sessionId=`session_recovery_${++serial}`,targetId='project_recovery',profileKey=sessionId;
 const workspaceRef=ref<BrowserWorkspace|null>(null),phaseRef=ref<WorkroomBrowserPhase>(null),versions=ref(new Map<string,number>()),epoch=ref(0),mounted=ref(true);
 const urlRef=ref(''),lastPageUrl=ref(''),stopFlight=ref<unknown>(null),flight=ref<unknown>(null);
 const statuses:Array<ReturnType<typeof deferred<NativeStatus>>>=[],stopReplies:Array<ReturnType<typeof deferred<NativeStatus>>>=[];
 const navigations:string[]=[],ops:string[]=[],requests:WorkroomBrowserRequest[]=[],connected:BrowserWorkspace[]=[],applied:NativeStatus[]=[];
 let error:unknown=null,opened=false,holdStop=false,failStop=false;
 const snapshot=(url='about:blank',loading=true):NativeStatus=>({available:true,sessionId,tab:'main',profileKey,targetId:'native_recovery',port:9333,url,loading,canGoBack:false,canGoForward:false,tabs:[{tab:'main',profileKey,targetId:'native_recovery',url,closed:false}]});
 const workspace=(owner:BrowserWorkspace['owner']='human'):BrowserWorkspace=>({id:`workspace_${sessionId}`,sessionId,targetId,source:'owned',profileId:'owned:'+profileKey,profileName:'Chromium',owner,epoch:1,connection:'connected',observation:null,profileVerification:'user-confirmed',page:{id:'native_recovery',title:'',url:navigations.at(-1)??'about:blank'}});
 const request=async(r:WorkroomBrowserRequest)=>{requests.push(r);return r.operation==='connect-owned'?{workspace:workspace()}:{};};
 const env={sessionId,targetId,workspaceRef,phaseRef,versions,epoch,mounted,urlRef,lastPageUrl,stopFlight,flight,
  activeRef:ref('main'),recoveryRef:ref(null),selection:ref(0),selectionPending:ref(false),fastUntil:ref(0),
  setError:(value:unknown)=>{error=value;},captureError:(value:unknown)=>{error=value;},setFailure:()=>{},setFailureCode:()=>{},
  setPhase:(value:WorkroomBrowserPhase)=>{phaseRef.current=value;},setUrl:(value:string)=>{urlRef.current=value;},setOpened:(value:boolean)=>{opened=value;},
  applyTabs:()=>{},setNativeStatus:(value:NativeStatus)=>applied.push(value),
  ownedBrowserAction:async(_session:string,operation:string,extra?:Record<string,unknown>):Promise<NativeStatus>=>{
   ops.push(operation);
   if(operation==='tabs')return {...snapshot(),tabs:opened?snapshot().tabs:[]};
   if(operation==='navigate'){navigations.push(String(extra?.url));return snapshot();}
   if(operation==='status'){const reply=deferred<NativeStatus>();statuses.push(reply);return reply.promise;}
   return snapshot();
  },
  nativeNav:async(_session:string,_tab:string,operation:NativeNavOperation)=>{
   ops.push(operation);if(failStop)throw Error('Stop result unavailable');
   if(holdStop){const reply=deferred<NativeStatus>();stopReplies.push(reply);return reply.promise;}
   return snapshot('about:blank',false);
  },
  startOwnedBrowser:(options:Parameters<typeof startOwnedBrowser>[0])=>startOwnedBrowser({...options,clock:{sleep:async()=>{}}}),
  request,onConnected:(value:BrowserWorkspace)=>{connected.push(value);workspaceRef.current=value;},inSet:()=>false,
  openTabs:(status:NativeStatus)=>status.tabs??[],stage:{targetLost:'Target lost',noDocument:'No document'},classifyWorkroomBrowserError,
  canReplaceLoadingRequest,canRunNav,canStopNav,normalizeOwnedBrowserAddress,ownedRequestIntent,ownedViewKey,claimOwnedConnect,rememberOwnedConnect,forgetOwnedConnect,
 };
 const body=slice(' const begin=',' // Choosing another')+slice(' const start=async',' /** Finish only')+slice(' const open=async',' /** Another tab')+slice(' const navigate=async',' const focusAddress=');
 const handlers=new Function(...Object.keys(env),new Bun.Transpiler({loader:'ts'}).transformSync(body)+';return {open,navigate};')(...Object.values(env)) as {open:(address?:string)=>Promise<void>;navigate:(operation:NativeNavOperation)=>Promise<void>};
 const loading=async(address:string)=>{const pending=handlers.open(address);await until(()=>statuses.length>0);statuses[0]!.resolve(snapshot());await until(()=>phaseRef.current==='loading'&&statuses.length>=2);return {pending};};
 return {...handlers,loading,sessionId,phaseRef,versions,epoch,workspaceRef,flight,stopFlight,statuses,stopReplies,navigations,ops,requests,connected,applied,snapshot,
  holdStop:()=>{holdStop=true;},failStop:()=>{failStop=true;},error:()=>error,address:()=>urlRef.current,
  setOwner:(owner:BrowserWorkspace['owner'],connection:'connected'|'disconnected'='connected')=>{workspaceRef.current={...workspace(owner),connection};},
  dispose:()=>{mounted.current=false;epoch.current++;for(const reply of statuses)reply.resolve({...snapshot(),closed:true});for(const reply of stopReplies)reply.resolve(snapshot());forgetOwnedConnects(sessionId);}};
}

test('Stop ends the initial loading generation once, keeps sibling intent, and a late ready reply cannot connect',async()=>{
 const h=await recoveryHarness();
 try{
  const {pending}=await h.loading('https://example.test/first');
  const sibling=ownedViewKey(h.sessionId,'second');rememberOwnedConnect(sibling,{profileKey:h.sessionId},claimOwnedConnect(sibling));
  expect(pendingOwnedConnect(h.sessionId)).toBeDefined();h.holdStop();
  const stopping=h.navigate('stop');await until(()=>h.stopReplies.length===1);
  expect(h.phaseRef.current).toBeNull();expect(pendingOwnedConnect(h.sessionId)).toBeUndefined();expect(pendingOwnedConnect(sibling)).toBeDefined();
  await h.navigate('stop');expect(h.ops.filter(op=>op==='stop')).toHaveLength(1);
  h.statuses[1]!.resolve(h.snapshot('https://example.test/late',false));await pending;
  expect(h.requests).toEqual([]);expect(h.connected).toEqual([]);expect(h.navigations).toEqual(['https://example.test/first']);
  expect(h.address()).toBe('https://example.test/first');
  h.stopReplies[0]!.resolve(h.snapshot('about:blank',false));await stopping;
  expect(h.applied).toHaveLength(1);expect(h.error()).toBe('');
 }finally{h.dispose();}
});

test('an explicit replacement during loading navigates once and late old status or Stop cannot overwrite it',async()=>{
 const h=await recoveryHarness();
 try{
  const {pending:first}=await h.loading('https://example.test/first');h.holdStop();
  const stopping=h.navigate('stop');await until(()=>h.stopReplies.length===1);
  const second=h.open('https://example.test/second');await until(()=>h.statuses.length===3);
  h.statuses[1]!.resolve(h.snapshot('https://example.test/late-first',false));await first;
  h.statuses[2]!.resolve(h.snapshot('https://example.test/second',false));await second;
  h.stopReplies[0]!.resolve(h.snapshot('https://example.test/late-stop',false));await stopping;
  expect(h.navigations).toEqual(['https://example.test/first','https://example.test/second']);
  expect(h.requests.filter(r=>r.operation==='connect-owned')).toHaveLength(1);expect(h.connected).toHaveLength(1);
  expect(h.connected[0]!.page?.url).toBe('https://example.test/second');expect(h.address()).toBe('https://example.test/second');expect(h.applied).toEqual([]);
 }finally{h.dispose();}
});

test('Enter directly replaces a loading request, but an invalid address preserves the original generation',async()=>{
 const h=await recoveryHarness();
 try{
  const {pending:first}=await h.loading('https://example.test/first'),version=h.versions.current.get('main');
  await h.open('javascript:alert(1)');expect(h.versions.current.get('main')).toBe(version);expect(h.phaseRef.current).toBe('loading');
  const second=h.open('https://example.test/second');await until(()=>h.statuses.length===3);
  h.statuses[1]!.resolve(h.snapshot('https://example.test/late-first',false));await first;
  h.statuses[2]!.resolve(h.snapshot('https://example.test/second',false));await second;
  expect(h.navigations).toEqual(['https://example.test/first','https://example.test/second']);expect(h.ops).not.toContain('stop');
  expect(h.requests.filter(r=>r.operation==='connect-owned')).toHaveLength(1);expect(h.connected[0]!.page?.url).toBe('https://example.test/second');
 }finally{h.dispose();}
});

test('Stop failure releases the local wait without replay, and owner/admission boundaries reject recovery actions',async()=>{
 const h=await recoveryHarness();
 try{
  const {pending}=await h.loading('https://example.test/first');h.failStop();await h.navigate('stop');
  h.statuses[1]!.resolve(h.snapshot('https://example.test/late-first',false));await pending;
  expect(h.error()).toBeInstanceOf(Error);expect(h.phaseRef.current).toBeNull();expect(h.ops.filter(op=>op==='stop')).toHaveLength(1);expect(h.requests).toEqual([]);
  for(const phase of ['profile','navigating','connecting','closing'] as const){h.phaseRef.current=phase;await h.open('https://example.test/blocked');await h.navigate('stop');}
  for(const owner of ['agent','observing','taking','disconnected'] as const){h.setOwner(owner);h.phaseRef.current='loading';await h.open('https://example.test/blocked');await h.navigate('stop');}
  h.setOwner('human','disconnected');await h.open('https://example.test/blocked');await h.navigate('stop');
  expect(h.navigations).toEqual(['https://example.test/first']);expect(h.ops.filter(op=>op==='stop')).toHaveLength(1);
 }finally{h.dispose();}
});
