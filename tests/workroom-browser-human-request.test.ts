import {describe,test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import {WorkroomBrowserRecovery} from '../src/workroomBrowserRecovery';
import {BROWSER_AGENT_OPERATIONS,type BrowserWaiting,type BrowserWorkspace,type WorkroomBrowserResult} from '../src/workroomBrowserProtocol';
import {WORKROOM_BROWSER_MCP_TOOL} from '../src/workroomBrowserMcp';
import {handleWorkroomBrowser} from '../src/workroomBrowserApi';
import type {BrowserCdp} from '../src/workroomCdpTransport';

const profile={id:'chrome:Default',browserId:'chrome' as const,browserName:'Chrome',profileDirectory:'Default',profileName:'Test profile',accountLabel:null};
class Page implements BrowserCdp {
 calls:{method:string;params:any}[]=[];
 events=new Set<(method:string,params:any,session?:string)=>void>();
 closers=new Set<()=>void>();
 hold?:Promise<any>;
 async send(method:string,params:any={}){
  this.calls.push({method,params});
  if(method==='Target.getTargets')return {targetInfos:[{targetId:'page_test',type:'page',title:'Private title',url:'https://example.test/?secret=page-secret'}]};
  if(method==='Target.attachToTarget')return {sessionId:'page_session'};
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame_test'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:42};
  if(method==='Runtime.evaluate'){
   if(params.expression.includes('const elements=[]')&&this.hold)return this.hold;
   return {result:{value:JSON.stringify({url:'https://example.test/?secret=page-secret',title:'Private title',text:'Page text',elements:[]})}};
  }
  return {};
 }
 onEvent(fn:(method:string,params:any,session?:string)=>void){this.events.add(fn);return()=>{this.events.delete(fn);};}
 onClose(fn:()=>void){this.closers.add(fn);}
 close(){for(const fn of this.closers)fn();}
 event(method:string,params:any){for(const fn of this.events)fn(method,params,'page_session');}
}
function workspace(result:WorkroomBrowserResult):BrowserWorkspace {
 if(!result.success||!result.workspace)throw Error('Expected browser workspace');
 return result.workspace;
}
async function setup(recovery?:WorkroomBrowserRecovery){
 const page=new Page();let clock=1000;
 const host=new WorkroomBrowserHost({runningSession:()=>({targetId:'project_test'}),profiles:()=>[profile],endpoint:async()=>'test',connect:async()=>page,recovery,now:()=>clock});
 const id=workspace(await host.perform({operation:'connect',sessionId:'session_test',targetId:'project_test',profileId:profile.id})).id;
 await host.perform({operation:'select',workspaceId:id,pageId:'page_test',confirmProfile:true});
 const ready=workspace(await host.perform({operation:'resume',workspaceId:id}));
 const granted=await host.perform({operation:'grant',workspaceId:id});if(!granted.success||!granted.grant)throw Error('Expected grant');
 const base={workspaceId:id,grant:granted.grant,epoch:ready.epoch};
 const status=async()=>workspace(await host.perform({operation:'status',workspaceId:id}));
 const request=(fields:{reason:BrowserWaiting['reason'];note?:string;url?:string})=>host.agent({...base,operation:'request-human',...fields});
 return {host,page,id,base,status,request,tick:()=>{clock+=1000;}};
}

describe('Workroom browser request-human',()=>{
 test('records local waiting without changing the page, observation, ownership, lease or receipts',async()=>{
  const s=await setup();
  try{
   const before=await s.status(),calls=s.page.calls.length;
   const answer=workspace(await s.request({reason:'open-page',note:'Open the account page',url:'https://example.test/account?secret=request-secret'}));
   expect(answer.waiting).toBeUndefined();
   const after=await s.status();
   expect(after.waiting).toEqual({reason:'open-page',note:'Open the account page',url:'https://example.test/account?secret=request-secret',at:1000});
   const {waiting,...rest}=after;expect(rest).toEqual(before);
   // No CDP reads or writes at all, including navigation, focus, evaluate or screenshot.
   expect(s.page.calls).toHaveLength(calls);
  }finally{s.host.dispose();}
 });

 test('the first request wins within an epoch, including its timestamp; a new epoch accepts a new request',async()=>{
  const s=await setup();
  try{
   const calls=s.page.calls.length;
   await Promise.all([s.request({reason:'login',note:'Sign in'}),s.request({reason:'login',note:'Sign in'})]);
   const first=(await s.status()).waiting;s.tick();
   await s.request({reason:'open-page',url:'https://other.test/'});
   expect((await s.status()).waiting).toEqual(first);expect(s.page.calls).toHaveLength(calls);
   await s.host.perform({operation:'take',workspaceId:s.id});
   const ready=workspace(await s.host.perform({operation:'resume',workspaceId:s.id}));
   expect(ready.waiting).toBeUndefined();
   const granted=await s.host.perform({operation:'grant',workspaceId:s.id});if(!granted.success)throw Error('grant');
   await s.host.agent({workspaceId:s.id,grant:granted.grant,epoch:ready.epoch,operation:'request-human',reason:'captcha'});
   expect((await s.status()).waiting).toEqual({reason:'captcha',at:2000});
  }finally{s.host.dispose();}
 });

 for(const reason of ['login','captcha','confirm','file','open-page'] as const){
  test(`${reason} clears on explicit takeover and the old grant cannot restore it`,async()=>{
   const s=await setup();
   try{
    await s.request({reason});expect((await s.status()).waiting?.reason).toBe(reason);
    expect(workspace(await s.host.perform({operation:'take',workspaceId:s.id})).waiting).toBeUndefined();
    await expect(s.request({reason})).rejects.toMatchObject({code:'grant-unavailable'});
    expect((await s.status()).waiting).toBeUndefined();
   }finally{s.host.dispose();}
  });
 }

 for(const [name,method,params] of [
  ['trusted human input','Runtime.bindingCalled',{name:'__atzHumanTakeover',executionContextId:42}],
  ['navigation','Page.frameNavigated',{frame:{id:'frame_test',url:'https://example.test/next'}}],
  ['same-document navigation','Page.navigatedWithinDocument',{frameId:'frame_test',url:'https://example.test/#next'}],
 ] as const){
  test(`clears on ${name}`,async()=>{
   const s=await setup();
   try{await s.request({reason:'confirm'});s.page.event(method,params);expect((await s.status()).waiting).toBeUndefined();}
   finally{s.host.dispose();}
  });
 }

 test('detach and transport disconnect clear waiting',async()=>{
  for(const detach of [true,false]){
   const s=await setup();
   try{
    await s.request({reason:'file'});
    const after=detach?workspace(await s.host.perform({operation:'detach',workspaceId:s.id})):(s.page.close(),await s.status());
    expect(after.waiting).toBeUndefined();expect(after.owner).toBe('disconnected');
   }finally{s.host.dispose();}
  }
 });

 test('refuses unsafe URLs, URLs for other reasons and invalid fields before any CDP call',async()=>{
  const s=await setup();
  try{
   const calls=s.page.calls.length;
   for(const url of ['javascript:alert(1)','file:///tmp/private','data:text/html,test','not a url','https://user:pass@example.test/'])
    await expect(s.request({reason:'open-page',url})).rejects.toMatchObject({code:'invalid-address'});
   for(const reason of ['login','captcha','confirm','file'] as const)
    await expect(s.request({reason,url:'https://example.test/'})).rejects.toMatchObject({code:'invalid-address'});
   for(const fields of [{},{reason:'other'},{reason:'login',note:{html:'untrusted'}},{reason:'login',note:'x'.repeat(12001)},{operation:'observe',reason:'login'}])
    await expect(s.host.agent({...s.base,operation:'request-human',...fields})).rejects.toMatchObject({code:'generic'});
   expect((await s.status()).waiting).toBeUndefined();expect(s.page.calls).toHaveLength(calls);
  }finally{s.host.dispose();}
 });

 test('refuses wrong grant or epoch and returns C1 codes through the API',async()=>{
  const s=await setup();
  try{
   const calls=s.page.calls.length;
   for(const fields of [{grant:'0'.repeat(64)},{grant:''},{epoch:s.base.epoch+1}])
    await expect(s.host.agent({...s.base,operation:'request-human',reason:'login',...fields})).rejects.toMatchObject({code:'grant-unavailable'});
   const response=await handleWorkroomBrowser(new Request('http://127.0.0.1/api/workroom-browser-agent',{method:'POST',headers:{'Content-Type':'application/json','X-AgentsToZ-Browser-Grant':s.base.grant},body:JSON.stringify({...s.base,operation:'request-human',reason:'file',url:'https://example.test/'})}),s.host,true);
   expect(response.status).toBe(400);expect(await response.json()).toMatchObject({success:false,code:'invalid-address'});
   expect((await s.status()).waiting).toBeUndefined();expect(s.page.calls).toHaveLength(calls);
  }finally{s.host.dispose();}
 });

 test('takeover revokes a queued human request before it can set waiting',async()=>{
  const s=await setup();let release!:(value:any)=>void;
  try{
   s.page.hold=new Promise(r=>{release=r;});
   const observing=s.host.agent({...s.base,operation:'observe'}).catch(e=>e);
   await new Promise(r=>setTimeout(r,0));
   const pending=s.request({reason:'login'}).catch(e=>e);
   const take=s.host.perform({operation:'take',workspaceId:s.id});
   release({result:{value:JSON.stringify({url:'https://example.test/',title:'Page',text:'',elements:[]})}});
   await observing;expect(await pending).toMatchObject({code:'grant-unavailable'});await take;
   expect((await s.status()).waiting).toBeUndefined();
  }finally{s.host.dispose();}
 });

 test('truncates untrusted notes as literal plain text, and never persists titles, URLs or waiting',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'browser-human-request-')),path=join(directory,'recovery.sqlite');
  const recovery=new WorkroomBrowserRecovery(path),s=await setup(recovery);
  try{
   const disk=readFileSync(path);
   const note='<img src=x onerror=alert(1)>\n'+'untrusted note '.repeat(12);
   await s.request({reason:'open-page',note,url:'https://example.test/?secret=request-secret'});
   expect((await s.status()).waiting?.note).toBe(note.replace(/\n/g,' ').slice(0,120));
   // A request causes no recovery write, even with secrets in a valid HTTP(S) URL.
   expect(readFileSync(path)).toEqual(disk);
   await s.host.perform({operation:'take',workspaceId:s.id});
   await s.host.perform({operation:'select',workspaceId:s.id,pageId:'page_test',confirmProfile:true});
   const stored=readFileSync(path).toString('utf8');
   for(const text of ['https://','page-secret','request-secret','Private title','untrusted note','onerror','waiting'])expect(stored).not.toContain(text);
  }finally{s.host.dispose();recovery.close();rmSync(directory,{recursive:true,force:true});}
 });

 test('advertises request-human and its bounded fields in the MCP schema',()=>{
  expect(BROWSER_AGENT_OPERATIONS).toContain('request-human');
  const properties=WORKROOM_BROWSER_MCP_TOOL.inputSchema.properties;
  expect(properties.operation.enum).toContain('request-human');
  expect(properties.reason.enum).toEqual(['login','captcha','confirm','file','open-page']);
  expect(properties.note).toEqual({type:'string',maxLength:120});
  expect(properties.url).toMatchObject({type:'string',maxLength:4096});
  expect(WORKROOM_BROWSER_MCP_TOOL.description).toContain('only the person may open that address');
 });
});
