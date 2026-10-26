import {WorkroomBrowserError} from '../src/workroomBrowserErrorCodes';
import {test,expect} from 'bun:test';
import {NATIVE_TARGET_PROBES,OWNED_SETTLE_MS,admitOwnedNavigation,claimOwnedConnect,classifyOwnedPage,forgetOwnedConnect,forgetOwnedConnects,normalizeOwnedBrowserAddress,ownedRequestIntent,ownedViewKey,pendingOwnedConnect,rememberOwnedConnect,startOwnedBrowser,type NativePageStatus,type OwnedBrowserStage} from '../src/workroomBrowserNavigation';
import type {BrowserWorkspace,WorkroomBrowserRequest} from '../src/workroomBrowserProtocol';
test('human address input accepts a domain without a scheme and preserves explicit origins',()=>{
 expect(normalizeOwnedBrowserAddress('  www.naver.com  ')).toBe('https://www.naver.com/');
 expect(normalizeOwnedBrowserAddress('example.com:8443/path?q=one#two')).toBe('https://example.com:8443/path?q=one#two');
 for(const host of ['localhost:63775','127.0.0.1:63775','[::1]:63775'])expect(normalizeOwnedBrowserAddress(host+'/popup')).toBe('http://'+host+'/popup');
 expect(normalizeOwnedBrowserAddress('http://example.test:8080/page')).toBe('http://example.test:8080/page');
 expect(normalizeOwnedBrowserAddress('https://example.test/page')).toBe('https://example.test/page');
});
test('human address input rejects credentials, non-web schemes, malformed and empty addresses',()=>{
 for(const value of ['', '   ', 'javascript:alert(1)', 'javascript:443', 'data:text/html,test', 'file:///tmp/test', 'mailto:test@example.test', 'https://user:password@example.test/', 'user:password@example.test', 'https://example.test/\npath', 'https:\\example.test', 'https://'])expect(()=>normalizeOwnedBrowserAddress(value)).toThrow();
});
test('human address input searches words that are not an address, as a browser address bar does',()=>{
 const search=(q:string)=>'https://www.google.com/search?q='+encodeURIComponent(q);
 // 「네이버」 once became https://네이버 — a punycode host that never resolves (2026-10-25).
 for(const words of ['네이버','naver','react hooks','naver.com 검색','e.g.','1.5','foo/bar','네이버 지도'])expect(normalizeOwnedBrowserAddress(words)).toBe(search(words));
 expect(normalizeOwnedBrowserAddress('  네이버  ')).toBe(search('네이버'));
 // Addresses stay addresses.
 expect(normalizeOwnedBrowserAddress('naver.com')).toBe('https://naver.com/');
 expect(normalizeOwnedBrowserAddress('네이버.com')).toBe(new URL('https://네이버.com').href);
 expect(normalizeOwnedBrowserAddress('192.168.0.10/admin')).toBe('https://192.168.0.10/admin');
 expect(normalizeOwnedBrowserAddress('localhost')).toBe('http://localhost/');
 // A search never carries a credential or a non-web scheme into an address, and the length bound still holds.
 for(const value of ['user@example.test','javascript:alert(1)','https://exa mple.test','x'.repeat(4096)+' y'])expect(()=>normalizeOwnedBrowserAddress(value)).toThrow();
});

const URL_='http://127.0.0.1:50000/restore',PROFILE='profile_original',SESSION='session_a',TARGET='project_a';
/** A deterministic native view: `script(t)` answers each status by the fake time since the navigation was accepted. */
function harness(script:(t:number,s:{retargets:number})=>NativePageStatus,o:{renderer?:number;connect?:(r:WorkroomBrowserRequest)=>Promise<{workspace?:BrowserWorkspace}>}={}){
 let now=0,accepted=-1,navigateCalls=0,loads=0,renderer=o.renderer??0;const s={retargets:0},stages:OwnedBrowserStage[]=[],requests:WorkroomBrowserRequest[]=[];
 const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;}};
 const action=async(operation:'navigate'|'status'|'retarget',extra?:Record<string,unknown>):Promise<NativePageStatus>=>{
  if(operation==='navigate'){navigateCalls++;expect(extra?.url).toBe(URL_);if(renderer-->0)return {preparing:true};loads++;accepted=now;return {};}
  if(operation==='retarget')s.retargets++;
  return {profileKey:PROFILE,...script(accepted<0?0:now-accepted,s)};
 };
 const request=async(r:WorkroomBrowserRequest)=>{requests.push(r);if(r.operation==='detach')return {};return o.connect?o.connect(r):{workspace:workspaceFor(r)};};
 const run=(extra:Partial<Parameters<typeof startOwnedBrowser>[0]>={})=>startOwnedBrowser({action,request,current:()=>true,sessionId:SESSION,targetId:TARGET,profileKey:PROFILE,url:URL_,connect:true,onStage:stage=>{if(stages.at(-1)!==stage)stages.push(stage);},clock,...extra});
 return {run,stages,requests,s,get loads(){return loads;},get navigateCalls(){return navigateCalls;},get now(){return now;},advance:(ms:number)=>{now+=ms;}};
}
function workspaceFor(r:WorkroomBrowserRequest,sessionId=SESSION):BrowserWorkspace{
 const pageId=r.operation==='connect-owned'?r.pageId:'page';
 return {id:'workspace_'+pageId,sessionId,targetId:TARGET,profileId:'owned:'+PROFILE,profileName:'Chromium',source:'owned',page:{id:pageId,title:'',url:URL_},owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'user-confirmed'};
}
const ready=(t=0):NativePageStatus=>({targetId:'native_target',port:50001,url:URL_,loading:false,readiness:{targetProbes:1,targetResults:1}});
const connects=(requests:WorkroomBrowserRequest[])=>requests.filter(r=>r.operation==='connect-owned');

test('the stages are separate: a slow document is loading while the target is known, never a target failure',()=>{
 expect(classifyOwnedPage({targetId:'t',port:1,url:'about:blank',loading:true,profileKey:'p'},'p')).toEqual({kind:'loading'});
 expect(classifyOwnedPage({targetId:'t',port:1,url:'about:blank',profileKey:'p',readiness:{targetProbes:NATIVE_TARGET_PROBES}},'p')).toEqual({kind:'loading'});
 expect(classifyOwnedPage({targetId:'t',port:1,url:'about:blank',loading:false,profileKey:'p'},'p')).toEqual({kind:'no-document'});
 expect(classifyOwnedPage({url:'about:blank',loading:true,profileKey:'p',readiness:{targetProbes:3,targetSends:3,targetResults:0}},'p')).toEqual({kind:'target'});
 expect(classifyOwnedPage({url:'about:blank',loading:true,profileKey:'p',readiness:{targetProbes:NATIVE_TARGET_PROBES,targetSends:NATIVE_TARGET_PROBES,targetResults:0}},'p')).toEqual({kind:'target-lost'});
 expect(classifyOwnedPage({targetId:'t',port:1,url:'https://example.test/',profileKey:'p'},'p')).toEqual({kind:'ready',targetId:'t',port:1,url:'https://example.test/'});
 expect(classifyOwnedPage({targetId:'t',port:1,url:'https://example.test/',profileKey:'other'},'p')).toEqual({kind:'profile-changed'});
 expect(classifyOwnedPage({closed:true,profileKey:'p'},'p')).toEqual({kind:'closed'});
});
test('fast first entry: a cold renderer admits the navigation once, then the exact target connects once',async()=>{
 const h=harness(t=>t<200?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:ready(t),{renderer:2});
 let accepted=0;const result=await h.run({onAccepted:()=>accepted++});
 expect(result.kind).toBe('connected');expect(h.loads).toBe(1);expect(h.navigateCalls).toBe(3);expect(accepted).toBe(1);
 expect(connects(h.requests)).toEqual([{operation:'connect-owned',sessionId:SESSION,targetId:TARGET,port:50001,pageId:'native_target',profileKey:PROFILE}]);
 expect(h.stages).toEqual(['navigating','target','loading','connecting']);
});
test('an 11 second document delay stays loading and then connects; no deadline turns slow loading into an error',async()=>{
 const h=harness(t=>t<11000?{targetId:'native_target',port:50001,url:'about:blank',loading:true,readiness:{targetProbes:1,targetSends:1,targetResults:1}}:ready(t));
 const result=await h.run({recoveryId:'recovery_original'});
 expect(result.kind).toBe('connected');expect(h.now).toBeGreaterThanOrEqual(11000);expect(h.loads).toBe(1);
 expect(connects(h.requests)).toEqual([{operation:'connect-owned',sessionId:SESSION,targetId:TARGET,port:50001,pageId:'native_target',recoveryId:'recovery_original',profileKey:PROFILE}]);
 expect(h.stages).toEqual(['navigating','target','loading','connecting']);
 // Five minutes of loading is still loading.
 const slow=harness(t=>t<300000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:ready(t));
 expect((await slow.run()).kind).toBe('connected');expect(slow.loads).toBe(1);
});
test('a lost target reply is reported as such once the bounded probes are spent; a retry finishes only the connect',async()=>{
 let lost=true;
 const h=harness((t,s)=>lost?{url:'about:blank',loading:true,readiness:{targetProbes:Math.min(NATIVE_TARGET_PROBES,1+Math.floor(t/500)),targetSends:Math.min(NATIVE_TARGET_PROBES,1+Math.floor(t/500)),targetResults:0}}:{...ready(t),readiness:{targetProbes:s.retargets,targetResults:1}});
 const first=await h.run();
 expect(first).toEqual({kind:'failed',failure:'target-lost',error:expect.objectContaining({code:'target-lost',message:'Native browser discovery failed.'})});expect(connects(h.requests)).toHaveLength(0);expect(h.loads).toBe(1);
 expect(h.stages).toEqual(['navigating','target']);
 lost=false;h.stages.length=0;
 const retry=await h.run({url:undefined});
 expect(retry.kind).toBe('connected');expect(h.loads).toBe(1);expect(h.navigateCalls).toBe(1);expect(connects(h.requests)).toHaveLength(1);
 expect(h.stages).toEqual(['target','connecting']);
});
test('a spent probe budget whose reply lands within the settle window is not a lost target',async()=>{
 const quick=harness(t=>t<OWNED_SETTLE_MS-500?{url:'about:blank',loading:true,readiness:{targetProbes:NATIVE_TARGET_PROBES}}:ready(t));
 expect((await quick.run()).kind).toBe('connected');
 const lost=harness(t=>t<OWNED_SETTLE_MS*4?{url:'about:blank',loading:true,readiness:{targetProbes:NATIVE_TARGET_PROBES}}:ready(t));
 expect(await lost.run()).toEqual({kind:'failed',failure:'target-lost',error:expect.objectContaining({code:'target-lost'})});
});
test('an engine that stops loading without an HTTP document fails as no-document; a short pause before loading does not',async()=>{
 const none=harness(()=>({targetId:'native_target',port:50001,url:'about:blank',loading:false}));
 expect(await none.run()).toEqual({kind:'failed',failure:'no-document'});expect(connects(none.requests)).toHaveLength(0);expect(none.loads).toBe(1);
 const late=harness(t=>t<500?{targetId:'native_target',port:50001,url:'about:blank',loading:false}:t<4000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:ready(t));
 expect((await late.run()).kind).toBe('connected');
});
test('collapsing during recovery ends that generation without connecting; reopening finishes only the connect',async()=>{
 let shown=true;const h=harness(t=>{if(t>3000)shown=false;return t<11000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:ready(t);});
 const first=await h.run({current:()=>shown});
 expect(first.kind).toBe('ended');expect(connects(h.requests)).toHaveLength(0);
 h.advance(9000);const resumed=await h.run({url:undefined});
 expect(resumed.kind).toBe('connected');expect(h.loads).toBe(1);expect(h.navigateCalls).toBe(1);expect(connects(h.requests)).toHaveLength(1);
});
test('another modal during recovery only hides the view; the same generation keeps loading and connects',async()=>{
 // The modal changes native visibility, not the request: `current` stays true and nothing is resent.
 const h=harness(t=>t<6000?{targetId:'native_target',port:50001,url:'about:blank',loading:true,visible:t<2000||t>4000}as NativePageStatus:ready(t));
 expect((await h.run()).kind).toBe('connected');expect(h.loads).toBe(1);expect(connects(h.requests)).toHaveLength(1);
});
test('closing during loading ends the request; a reopen is a new navigation and the first late connect is detached',async()=>{
 let generation=1,release:(()=>void)|undefined;const held=new Promise<void>(r=>{release=r;});
 const h=harness(t=>t<1000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:ready(t),{connect:async r=>{if(generation===1)await held;return {workspace:workspaceFor(r)};}});
 const first=h.run({current:()=>generation===1});
 await new Promise(r=>setTimeout(r,0));for(let i=0;i<50&&!connects(h.requests).length;i++)await new Promise(r=>setTimeout(r,0));
 expect(connects(h.requests)).toHaveLength(1);
 generation=2; // the human closed this browser while its connect was in flight
 release!();expect((await first).kind).toBe('ended');
 expect(h.requests.filter(r=>r.operation==='detach')).toEqual([{operation:'detach',workspaceId:'workspace_native_target'}]);
 const reopened=await h.run({current:()=>generation===2});
 expect(reopened.kind).toBe('connected');expect(h.loads).toBe(2);
});
test('a closed view or a changed profile ends the wait without any connect',async()=>{
 const closed=harness(t=>t<1000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:{closed:true});
 expect((await closed.run()).kind).toBe('ended');expect(connects(closed.requests)).toHaveLength(0);
 const changed=harness(t=>t<1000?{targetId:'native_target',port:50001,url:'about:blank',loading:true}:{...ready(t),profileKey:'another_profile'});
 expect((await changed.run()).kind).toBe('ended');expect(connects(changed.requests)).toHaveLength(0);
});
test('a late reply never joins a new Workroom: it is detached, and a reply for another session is refused',async()=>{
 let active=SESSION;
 const late=harness(()=>ready(),{connect:async r=>{active='session_b';return {workspace:workspaceFor(r)};}});
 expect((await late.run({current:()=>active===SESSION})).kind).toBe('ended');
 expect(late.requests.map(r=>r.operation)).toEqual(['connect-owned','detach']);
 const foreign=harness(()=>ready(),{connect:async r=>({workspace:workspaceFor(r,'session_b')})});
 const result=await foreign.run();
 expect(result.kind).toBe('failed');expect(foreign.requests.map(r=>r.operation)).toEqual(['connect-owned','detach']);
});
test('a connect still in flight when its generation ends settles, and its late detach lands, before the next connect',async()=>{
 let generation=1,release:(()=>void)|undefined;const held=new Promise<void>(r=>{release=r;});let n=0;
 const h=harness(()=>ready(),{connect:async r=>{const mine=++n;if(mine===1)await held;return {workspace:{...workspaceFor(r),id:'workspace_'+mine}};}});
 const first=h.run({current:()=>generation===1});
 for(let i=0;i<50&&!connects(h.requests).length;i++)await new Promise(r=>setTimeout(r,0));
 generation=2; // collapsed mid-connect, then shown again: the resume must not share the old binding
 h.stages.length=0;const resumed=h.run({url:undefined,current:()=>generation===2});
 for(let i=0;i<200&&!h.stages.includes('connecting');i++)await new Promise(r=>setTimeout(r,0));
 expect(h.stages).toEqual(['target','connecting']);for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,0));
 expect(connects(h.requests)).toHaveLength(1);
 release!();
 expect((await first).kind).toBe('ended');const second=await resumed;
 expect(second.kind).toBe('connected');if(second.kind==='connected')expect(second.workspace.id).toBe('workspace_2');
 expect(h.requests.map(r=>r.operation==='detach'?'detach:'+r.workspaceId:r.operation)).toEqual(['connect-owned','detach:workspace_1','connect-owned']);
 expect(h.loads).toBe(1);
});
test('a failed connect keeps the accepted navigation and can be retried alone',async()=>{
 let fail=true;const h=harness(()=>ready(),{connect:async r=>{if(fail)throw new Error('A browser connection is awaiting approval.');return {workspace:workspaceFor(r)};}});
 const first=await h.run();expect(first.kind).toBe('failed');if(first.kind==='failed')expect(first.failure).toBe('connect');
 fail=false;expect((await h.run({url:undefined})).kind).toBe('connected');expect(h.loads).toBe(1);
});
test('an already connected Workroom navigates without a second connect; an ended generation never navigates',async()=>{
 const h=harness(()=>ready());expect(await h.run({connect:false})).toEqual({kind:'ready'});expect(h.requests).toHaveLength(0);
 let calls=0;expect(await admitOwnedNavigation(async()=>{calls++;return {};},URL_,()=>false)).toBe(false);expect(calls).toBe(0);
});
test('a renderer that never gets a main frame times out before any navigation is accepted',async()=>{
 let accepted=0;const h=harness(()=>ready(),{renderer:1000});
 const result=await h.run({onAccepted:()=>accepted++});
 expect(result.kind).toBe('failed');if(result.kind==='failed')expect(result.failure).toBe('renderer-timeout');expect(accepted).toBe(0);expect(h.loads).toBe(0);
});
test('accepted requests waiting for their connect are remembered per Workroom, bounded and replaceable',()=>{
 for(let i=0;i<10;i++)rememberOwnedConnect('s'+i,{profileKey:'p'+i},claimOwnedConnect('s'+i));
 expect(pendingOwnedConnect('s0')).toBeUndefined();expect(pendingOwnedConnect('s9')).toEqual({profileKey:'p9'});
 rememberOwnedConnect('s9',{profileKey:'other',recoveryId:'r'},claimOwnedConnect('s9'));expect(pendingOwnedConnect('s9')).toEqual({profileKey:'other',recoveryId:'r'});
 forgetOwnedConnect('s9');expect(pendingOwnedConnect('s9')).toBeUndefined();
 for(let i=0;i<10;i++)forgetOwnedConnect('s'+i);
});
test('a navigation accepted just as its generation ends is still remembered, so reopening finishes only its connect',async()=>{
 // Collapsed between sending the navigation and its accepted reply: Chromium loads that page all the same.
 const h=harness(()=>ready());let accepted=0;
 const first=await h.run({current:()=>h.loads===0,onAccepted:()=>accepted++});
 expect(first.kind).toBe('ended');expect(accepted).toBe(1);expect(h.loads).toBe(1);expect(connects(h.requests)).toHaveLength(0);
 const resumed=await h.run({url:undefined});
 expect(resumed.kind).toBe('connected');expect(h.loads).toBe(1);expect(h.navigateCalls).toBe(1);expect(connects(h.requests)).toHaveLength(1);
 // Ended before the navigation went out: nothing was accepted, so there is nothing to finish.
 const never=harness(()=>ready());let none=0;
 expect((await never.run({current:()=>false,onAccepted:()=>none++})).kind).toBe('ended');expect(none).toBe(0);expect(never.navigateCalls).toBe(0);
});
test('only the newest request of a Workroom remembers its late acceptance; a close or a newer request withdraws it',()=>{
 const collapsed=claimOwnedConnect('s_claim');
 expect(rememberOwnedConnect('s_claim',{profileKey:'p'},collapsed)).toBe(true);expect(pendingOwnedConnect('s_claim')).toEqual({profileKey:'p'});
 const closed=claimOwnedConnect('s_claim');expect(pendingOwnedConnect('s_claim')).toBeUndefined();
 forgetOwnedConnect('s_claim');
 expect(rememberOwnedConnect('s_claim',{profileKey:'p'},closed)).toBe(false);expect(pendingOwnedConnect('s_claim')).toBeUndefined();
 const older=claimOwnedConnect('s_claim'),newer=claimOwnedConnect('s_claim');
 expect(rememberOwnedConnect('s_claim',{profileKey:'old'},older)).toBe(false);expect(pendingOwnedConnect('s_claim')).toBeUndefined();
 expect(rememberOwnedConnect('s_claim',{profileKey:'new'},newer)).toBe(true);expect(pendingOwnedConnect('s_claim')).toEqual({profileKey:'new'});
 forgetOwnedConnect('s_claim');
});
test('a request is for its saved task; without one it only reuses the profile of a page this Workroom is connected to',()=>{
 const saved={id:'saved_a',profileId:'owned:profile_saved',source:'owned' as const};
 expect(ownedRequestIntent({sessionId:SESSION,recovery:saved,workspace:null})).toEqual({profileKey:'profile_saved',recoveryId:'saved_a'});
 // A saved task's page left open after a detach is not this Workroom's: the host would label its connect as the own profile.
 expect(ownedRequestIntent({sessionId:SESSION,recovery:null,workspace:null})).toEqual({profileKey:SESSION});
 // Connected, a request only navigates that page (no connect), so it stays in the profile the page is connected under.
 expect(ownedRequestIntent({sessionId:SESSION,recovery:null,workspace:{source:'owned',profileId:'owned:profile_saved'}})).toEqual({profileKey:'profile_saved'});
 expect(ownedRequestIntent({sessionId:SESSION,recovery:{...saved,source:'chrome'},workspace:null})).toEqual({profileKey:SESSION});
});

test('each tab of a Workroom remembers its own accepted connect; forgetting the Workroom forgets all its tabs and no other Workroom',()=>{
 expect(ownedViewKey('s_tabs')).toBe('s_tabs');expect(ownedViewKey('s_tabs','main')).toBe('s_tabs');expect(ownedViewKey('s_tabs','t2')).toBe('s_tabs~t2');
 const main=claimOwnedConnect(ownedViewKey('s_tabs')),second=claimOwnedConnect(ownedViewKey('s_tabs','t2')),other=claimOwnedConnect('s_tabs2');
 // A second tab's request does not withdraw the first tab's accepted connect, and the other way round.
 expect(rememberOwnedConnect(ownedViewKey('s_tabs'),{profileKey:'p'},main)).toBe(true);
 expect(rememberOwnedConnect(ownedViewKey('s_tabs','t2'),{profileKey:'p'},second)).toBe(true);
 expect(rememberOwnedConnect('s_tabs2',{profileKey:'q'},other)).toBe(true);
 forgetOwnedConnect(ownedViewKey('s_tabs','t2'));
 expect(pendingOwnedConnect(ownedViewKey('s_tabs','t2'))).toBeUndefined();expect(pendingOwnedConnect('s_tabs')).toEqual({profileKey:'p'});
 rememberOwnedConnect(ownedViewKey('s_tabs','t2'),{profileKey:'p'},claimOwnedConnect(ownedViewKey('s_tabs','t2')));
 forgetOwnedConnects('s_tabs');
 expect(pendingOwnedConnect('s_tabs')).toBeUndefined();expect(pendingOwnedConnect(ownedViewKey('s_tabs','t2'))).toBeUndefined();
 // A Workroom whose id merely starts with the same letters keeps its own.
 expect(pendingOwnedConnect('s_tabs2')).toEqual({profileKey:'q'});forgetOwnedConnects('s_tabs2');
});
test('a page already in the Workroom\'s tab set only navigates; another tab of the Workroom connects to join it',async()=>{
 const inSet=harness(()=>ready());expect(await inSet.run({connect:pageId=>pageId!=='native_target'})).toEqual({kind:'ready'});expect(inSet.requests).toHaveLength(0);
 const joining=harness(()=>ready());const seen:string[]=[];
 const result=await joining.run({connect:pageId=>{seen.push(pageId);return true;}});
 expect(result.kind).toBe('connected');expect(seen).toEqual(['native_target']);expect(connects(joining.requests)).toHaveLength(1);
});
test('a tab\'s late connect that joined the Workroom next to its other tabs leaves only its own page; the binding stays',async()=>{
 const sibling={id:'native_main',title:'',url:URL_};
 const joined=(r:WorkroomBrowserRequest):BrowserWorkspace=>{const w=workspaceFor(r);return {...w,id:'workspace_shared',tabs:[sibling,w.page!]};};
 // The tab's generation ends while its connect is in flight (closed, collapsed or another choice).
 let live=true;const late=harness(()=>ready(),{connect:async r=>{if(r.operation!=='connect-owned')return {};live=false;return {workspace:joined(r)};}});
 expect((await late.run({current:()=>live})).kind).toBe('ended');
 expect(late.requests.map(r=>r.operation==='release'?`release:${r.pageId}`:r.operation)).toEqual(['connect-owned','release:native_target']);
 // Alone in its binding, a late connect is detached as before.
 let first=true;const alone=harness(()=>ready(),{connect:async r=>{first=false;return {workspace:workspaceFor(r)};}});
 expect((await alone.run({current:()=>first})).kind).toBe('ended');
 expect(alone.requests.map(r=>r.operation)).toEqual(['connect-owned','detach']);
});

test('invalid addresses and native startup rejections carry codes without changing their messages',async()=>{
 for(const value of ['', 'file:///tmp/test', 'https://', '\ud800']){
  try{normalizeOwnedBrowserAddress(value);throw Error('Expected refusal');}catch(e){expect(e).toBeInstanceOf(WorkroomBrowserError);expect((e as WorkroomBrowserError).code).toBe('invalid-address');}
 }
 for(const [message,code] of [['Browser is still closing.','still-closing'],['Chromium profile initialization timed out.','profile-timeout']] as const){
  await expect(admitOwnedNavigation(async()=>{throw message;},URL_,()=>true)).rejects.toMatchObject({code,message});
 }
 const renderer=harness(()=>ready(),{renderer:1000}),result=await renderer.run();
 expect(result).toMatchObject({kind:'failed',failure:'renderer-timeout',error:{code:'profile-timeout',message:'Chromium renderer initialization timed out.'}});
 expect(renderer.loads).toBe(0);
});
