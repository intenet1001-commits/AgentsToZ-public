import {describe,expect,test} from 'bun:test';
import {CommunityAdapterAuthorization} from '../src/communityAdapterAuthorization';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import type {BrowserCdp} from '../src/workroomCdpTransport';

class Page implements BrowserCdp {
 readonly calls:{method:string;params:any}[]=[];
 private listeners=new Set<(method:string,params:any,session?:string)=>void>();
 private closers=new Set<()=>void>();
 failAction=false;
 async send(method:string,params:any={}){
  this.calls.push({method,params});
  if(method==='Target.getTargets')return {targetInfos:[{targetId:'owned_page',type:'page',title:'Own fixture',url:'https://example.test/'}]};
  if(method==='Target.attachToTarget')return {sessionId:'fixture_cdp'};
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'fixture_frame'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:42};
  if(method==='Runtime.evaluate'){
   if(this.failAction&&params.expression?.includes('.click()'))throw Error('outcome lost');
   return {result:{value:JSON.stringify({url:'https://example.test/',title:'Fixture',text:'Data',elements:[{selector:'#button',role:'button',name:'Fixture button'}]})}};
  }
  return {};
 }
 onEvent(fn:(method:string,params:any,session?:string)=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 onClose(fn:()=>void){this.closers.add(fn);}
 close(){for(const fn of this.closers)fn();}
 event(method:string,params:any){for(const fn of this.listeners)fn(method,params,'fixture_cdp');}
}
async function setup(trusted=true,takeAfterGrant=false){
 let enabled=true,clock=1_793_622_000_000,calls=0,hold:Promise<void>|undefined;
 const page=new Page();
 const authority=new CommunityAdapterAuthorization({get verifiedMain(){return trusted;},async request(value){
  calls++;if(hold)await hold;if(!enabled)throw Error('native local off');
  return {success:true,halted:false,authorized:true,capability:value.capability,communityId:'11111111-1111-4111-8111-111111111111',
   profileId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333',
   revision:1,expiresAt:clock+90_000,desktopGrant:false};
 }},()=>clock);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request):Response{
  if(new URL(request.url).pathname!=='/json/version')return new Response(null,{status:404});
  return Response.json({webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/devtools/browser/isolated-fixture`});
 }});
 const host=new WorkroomBrowserHost({runningSession:()=>({targetId:'fixture_project'}),connect:async()=>page,community:authority,now:()=>clock});
 if(takeAfterGrant){const perform=host.perform.bind(host);host.perform=async request=>{
  const result=await perform(request);if((request as any).operation==='grant'&&result.success&&result.workspace)await perform({operation:'take',workspaceId:result.workspace.id});return result;
 };}
 const connect=()=>host.perform({operation:'connect-owned',sessionId:'fixture_session',targetId:'fixture_project',port:server.port!,pageId:'owned_page'});
 const result=await connect();if(!result.success||!result.workspace)throw Error('fixture did not connect');
 return {host,page,result,connect,get calls(){return calls;},off:()=>{enabled=false;},hold:(p:Promise<void>)=>{hold=p;},
  close:()=>{host.dispose();authority.dispose();server.stop(true);}};
}
describe('initial owned-browser common consent',()=>{
 test('selected browser capability provides the initial own-page grant without broad browser access',async()=>{
  const f=await setup();try{
   expect(f.result.workspace!.owner).toBe('agent');expect(f.result.grant).toMatch(/^[a-f0-9]{64}$/);expect(f.calls).toBe(1);
   const w=f.result.workspace!;await f.host.agent({operation:'observe',workspaceId:w.id,grant:f.result.grant!,epoch:w.epoch});expect(f.calls).toBe(2);
   expect(f.page.calls.some(c=>/Browser.getCookies|Browser.close|closeTarget/.test(c.method))).toBe(false);
  }finally{f.close();}
 });
 test('without authenticated Main the same page remains under the person',async()=>{
  const f=await setup(false);try{expect(f.result.workspace!.owner).toBe('human');expect(f.result.grant).toBeUndefined();expect(f.calls).toBe(0);}finally{f.close();}
 });
 test('a late initial grant response never returns a token after human takeover',async()=>{
  const f=await setup(true,true);try{expect(f.result.workspace!.owner).toBe('human');expect(f.result.grant).toBeUndefined();}finally{f.close();}
 });
 test('human takeover and repeated attachment never automatically resume',async()=>{
  const f=await setup();try{
   const w=f.result.workspace!;await f.host.perform({operation:'take',workspaceId:w.id});
   const again=await f.connect();expect(again.success&&again.workspace?.owner).toBe('human');expect(f.calls).toBe(1);
   await f.host.perform({operation:'detach',workspaceId:w.id});const attached=await f.connect();expect(attached.success&&attached.workspace?.owner).toBe('human');expect(f.calls).toBe(1);
  }finally{f.close();}
 });
 test('native local off refuses the next operation before any page read or input',async()=>{
  const f=await setup();try{
   const w=f.result.workspace!,before=f.page.calls.length;f.off();
   await expect(f.host.agent({operation:'observe',workspaceId:w.id,grant:f.result.grant!,epoch:w.epoch})).rejects.toThrow('Community browser authorization ended');
   expect(f.page.calls.length).toBe(before);const status=await f.host.perform({operation:'status',workspaceId:w.id});expect(status.success&&status.workspace?.owner).toBe('human');
  }finally{f.close();}
 });
 test('a late native authorization cannot undo a concurrent human takeover',async()=>{
  const f=await setup();let release!:()=>void;try{
   const w=f.result.workspace!,before=f.page.calls.length;f.hold(new Promise<void>(resolve=>{release=resolve;}));
   const operation=f.host.agent({operation:'observe',workspaceId:w.id,grant:f.result.grant!,epoch:w.epoch}).catch(e=>e);
   await new Promise(r=>setTimeout(r,0));const take=f.host.perform({operation:'take',workspaceId:w.id});release();
   expect(await operation).toBeInstanceOf(Error);await take;expect(f.page.calls.length).toBe(before);
  }finally{release?.();f.close();}
 });
 test('navigation and unknown effects still require explicit human handback and result review',async()=>{
  const f=await setup();try{
   const w=f.result.workspace!;f.page.failAction=true;
   await expect(f.host.agent({operation:'click',selector:'#button',requestId:'unknown_fixture_action',workspaceId:w.id,grant:f.result.grant!,epoch:w.epoch,observationId:w.observation!.id})).rejects.toThrow('outcome lost');
   const again=await f.connect();expect(again.success&&again.workspace?.receipt?.state).toBe('unknown');expect(f.page.calls.filter(c=>c.params.expression?.includes('.click()'))).toHaveLength(1);
   f.page.event('Page.frameNavigated',{frame:{id:'fixture_frame',url:'https://example.test/next'}});
   await expect(f.host.agent({operation:'observe',workspaceId:w.id,grant:f.result.grant!,epoch:w.epoch})).rejects.toThrow();
  }finally{f.close();}
 });
});
