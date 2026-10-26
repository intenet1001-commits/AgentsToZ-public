import {test,expect} from 'bun:test';
import {requestWorkroomBrowser} from '../src/workroomBrowserClient';
import {WORKROOM_BROWSER_PATH} from '../src/workroomBrowserProtocol';

test('only detach accepts an already-released workspace response; status still requires its exact binding',async()=>{
 const prior=globalThis.fetch;globalThis.fetch=((input:any,init?:RequestInit)=>input===WORKROOM_BROWSER_PATH?Promise.resolve(Response.json({success:true})):prior(input,init)) as typeof fetch;
 try{expect(await requestWorkroomBrowser({operation:'detach',workspaceId:'reaped_workspace'})).toEqual({success:true});await expect(requestWorkroomBrowser({operation:'status',workspaceId:'reaped_workspace'})).rejects.toThrow('Browser workspace changed');}finally{globalThis.fetch=prior;}
});
test('cleanup never accepts a different workspace or a refused response',async()=>{
 const prior=globalThis.fetch;let refused=false;globalThis.fetch=((input:any,init?:RequestInit)=>input===WORKROOM_BROWSER_PATH?Promise.resolve(refused?Response.json({success:false,error:'refused'},{status:400}):Response.json({success:true,workspace:{id:'another_workspace'}})):prior(input,init)) as typeof fetch;
 try{await expect(requestWorkroomBrowser({operation:'detach',workspaceId:'reaped_workspace'})).rejects.toThrow('Browser workspace changed');refused=true;await expect(requestWorkroomBrowser({operation:'detach',workspaceId:'reaped_workspace'})).rejects.toThrow('refused');}finally{globalThis.fetch=prior;}
});

test('API refusal codes survive the client, with fallback for old or unknown codes',async()=>{
 const {WorkroomBrowserError}=await import('../src/workroomBrowserErrorCodes');
 const prior=globalThis.fetch;
 try{
  for(const [code,error,expected] of [['popup-open','unchanged English message','popup-open'],['future-code','Take control before navigating.','take-control-first'],[undefined,'old refusal','generic']] as const){
   globalThis.fetch=(async()=>Response.json({success:false,code,error},{status:400})) as unknown as typeof fetch;
   try{await requestWorkroomBrowser({operation:'profiles'});throw Error('Expected refusal');}catch(e){expect(e).toBeInstanceOf(WorkroomBrowserError);expect(e).toMatchObject({code:expected,message:error});}
  }
 }finally{globalThis.fetch=prior;}
});
test('invalid responses and changed workspace/session bindings are typed client errors',async()=>{
 const prior=globalThis.fetch;
 try{
  for(const [body,request,message] of [
   [null,{operation:'profiles'},'Invalid browser response.'],
   [{success:true,workspace:{id:'other'}},{operation:'status',workspaceId:'mine'},'Browser workspace changed.'],
   [{success:true,workspace:{sessionId:'other',targetId:'project',profileId:'profile'}},{operation:'connect',sessionId:'mine',targetId:'project',profileId:'profile'},'Browser session changed.'],
  ] as const){
   globalThis.fetch=(async()=>Response.json(body)) as unknown as typeof fetch;
   await expect(requestWorkroomBrowser(request)).rejects.toMatchObject({name:'WorkroomBrowserError',code:'workspace-changed',message});
  }
 }finally{globalThis.fetch=prior;}
});
test('Tauri invoke string rejections are typed without altering native messages',async()=>{
 const surface=globalThis as typeof globalThis & {isTauri?:boolean;window?:unknown};
 const before=Object.getOwnPropertyDescriptor(globalThis,'window'),tauri=Object.getOwnPropertyDescriptor(globalThis,'isTauri');
 try{
  Object.defineProperty(surface,'isTauri',{configurable:true,value:true});
  Object.defineProperty(surface,'window',{configurable:true,value:{__TAURI_INTERNALS__:{invoke:async()=>{throw 'Close the login popup before handing control to AI.';}}}});
  await expect(requestWorkroomBrowser({operation:'profiles'})).rejects.toMatchObject({name:'WorkroomBrowserError',code:'popup-open',message:'Close the login popup before handing control to AI.'});
 }finally{if(before)Object.defineProperty(globalThis,'window',before);else Reflect.deleteProperty(globalThis,'window');if(tauri)Object.defineProperty(globalThis,'isTauri',tauri);else Reflect.deleteProperty(globalThis,'isTauri');}
});
