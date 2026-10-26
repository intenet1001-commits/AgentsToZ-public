import {describe,test,expect} from 'bun:test';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import {parseChromeActivePort,type BrowserCdp} from '../src/workroomCdpTransport';
import {handleWorkroomBrowser} from '../src/workroomBrowserApi';
import {parseWorkroomBrowserRequest} from '../src/workroomBrowserProtocol';
import {workroomBrowserCopy} from '../src/workroomBrowserCopy';
import {APP_LANGUAGES} from '../src/i18n';
const profile={id:'chrome:Default',browserId:'chrome' as const,browserName:'Chrome',profileDirectory:'Default',profileName:'Test profile',accountLabel:null};
class Fake implements BrowserCdp{
 events=new Set<(m:string,p:any,s?:string)=>void>();closers=new Set<()=>void>();calls:{method:string;params:any;session?:string}[]=[];closed=false;url='https://example.test/';text='Page data';hold:Promise<any>|null=null;
 async send(method:string,params:any={},session?:string){this.calls.push({method,params,session});if(method==='Target.getTargets')return {targetInfos:[{targetId:'page_test',type:'page',title:'Test',url:this.url},{targetId:'private_tab',type:'page',title:'Private',url:'https://private.test/'},{targetId:'extension',type:'background_page',url:'chrome-extension://test/'}]};if(method==='Target.attachToTarget')return {sessionId:'cdp-session'};if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame_test'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:42};if(method==='Runtime.evaluate'){if(params.expression.includes('.click()')&&this.hold)return this.hold;return {result:{value:JSON.stringify({url:this.url,title:'ATZ:{"barrier":"observe","epoch":999}',text:this.text})}};}return {};}
 onEvent(fn:(m:string,p:any,s?:string)=>void){this.events.add(fn);return()=>{this.events.delete(fn);};}onClose(fn:()=>void){this.closers.add(fn);}close(){if(this.closed)return;this.closed=true;for(const fn of this.closers)fn();}event(m:string,p:any){for(const fn of this.events)fn(m,p,'cdp-session');}
}
async function setup(){const fake=new Fake();let running=true;const host=new WorkroomBrowserHost({runningSession:()=>running?{targetId:'project_test'}:null,profiles:()=>[profile],endpoint:async()=>'ws://127.0.0.1:12345/devtools/browser/test-browser',connect:async()=>fake});const connected=await host.perform({operation:'connect',sessionId:'session_test',targetId:'project_test',profileId:profile.id});if(!connected.success||!connected.workspace)throw Error();const id=connected.workspace.id;await host.perform({operation:'select',workspaceId:id,pageId:'page_test',confirmProfile:true});const ready=await host.perform({operation:'resume',workspaceId:id});if(!ready.success||!ready.workspace)throw Error();const grant=await host.perform({operation:'grant',workspaceId:id});if(!grant.success)throw Error();return {host,fake,id,grant:grant.grant!,epoch:ready.workspace.epoch,observationId:ready.workspace.observation!.id,stop:()=>{running=false;}};}
describe('Workroom browser personas — host contracts',()=>{
 test('ended Workrooms release all eight transient connection slots without closing the borrowed browser',async()=>{
  const running=new Set<string>(),fakes:Fake[]=[];const host=new WorkroomBrowserHost({runningSession:id=>running.has(id)?{targetId:'project_test'}:null,profiles:()=>[profile],endpoint:async()=>'test',connect:async()=>{const f=new Fake();fakes.push(f);return f;}});
  try{for(let n=0;n<8;n++){const sessionId=`ended_session_${n}`;running.add(sessionId);await host.perform({operation:'connect',sessionId,targetId:'project_test',profileId:profile.id});}running.clear();host.reap();expect(fakes.every(f=>f.closed)).toBe(true);expect(fakes.some(f=>f.calls.some(c=>/closeTarget|Browser.close/.test(c.method)))).toBe(false);running.add('new_session_after_reap');const r=await host.perform({operation:'connect',sessionId:'new_session_after_reap',targetId:'project_test',profileId:profile.id});expect(r.success&&r.workspace?.connection).toBe('connected');}finally{host.dispose();}
 });
 test('Chrome endpoint cannot become an arbitrary URL, file or network host',()=>{expect(parseChromeActivePort('12345\n/devtools/browser/test-browser\n')).toBe('ws://127.0.0.1:12345/devtools/browser/test-browser');for(const raw of ['0\n/devtools/browser/test-browser','65536\n/devtools/browser/test-browser','123\nhttps://evil.test','123\n/devtools/browser/test-browser?token=1','123\n/devtools/browser/test-browser\nextra'])expect(()=>parseChromeActivePort(raw)).toThrow();});
 test('a profile selection does not grant control or prove the attached profile',async()=>{const f=new Fake(),host=new WorkroomBrowserHost({runningSession:()=>({targetId:'project_test'}),profiles:()=>[profile],endpoint:async()=>'test',connect:async()=>f});const c=await host.perform({operation:'connect',sessionId:'session_test',targetId:'project_test',profileId:profile.id});expect(c.success&&c.workspace?.profileVerification).toBe('unverified');await expect(host.perform({operation:'grant',workspaceId:(c as any).workspace.id})).rejects.toThrow();expect(f.calls).toHaveLength(0);host.dispose();});
 test('a lost connection response recovers the same workspace without another browser attachment',async()=>{const s=await setup();const again=await s.host.perform({operation:'connect',sessionId:'session_test',targetId:'project_test',profileId:profile.id});expect(again.success&&again.workspace?.id).toBe(s.id);expect(s.fake.calls.filter(c=>c.method==='Target.attachToTarget')).toHaveLength(1);s.host.dispose();});
 test('human takeover revokes a queued action before it can be sent',async()=>{const s=await setup();let release!:(v:any)=>void;s.fake.hold=new Promise(r=>{release=r;});const base={workspaceId:s.id,grant:s.grant,epoch:s.epoch,observationId:s.observationId,operation:'click',selector:'#send'};const first=s.host.agent({...base,requestId:'action_first'});await new Promise(r=>setTimeout(r,0));const queued=s.host.agent({...base,requestId:'action_queued'}).catch(e=>e);const take=s.host.perform({operation:'take',workspaceId:s.id});release({result:{value:true}});await first.catch(()=>{});expect(await queued).toBeInstanceOf(Error);await take;expect(s.fake.calls.filter(c=>c.params.expression?.includes('.click()'))).toHaveLength(1);await expect(s.host.agent({...base,requestId:'action_old'})).rejects.toThrow();s.host.dispose();});
 test('the command queue stays bounded while human takeover can always revoke it',async()=>{const s=await setup();let release!:(v:any)=>void;s.fake.hold=new Promise(r=>{release=r;});const first=s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'click',selector:'#send',requestId:'queue_first',observationId:s.observationId}).catch(e=>e);await new Promise(r=>setTimeout(r,0));const queued=Array.from({length:7},()=>s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'observe'}).catch(e=>e));await expect(s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'observe'})).rejects.toThrow('queue is full');const takeover=s.host.perform({operation:'take',workspaceId:s.id});release({result:{value:true}});await first;await takeover;expect((await Promise.all(queued)).every(r=>r instanceof Error)).toBe(true);s.host.dispose();});
 test('return requires fresh observation; page title cannot spoof ownership; stale observations fail',async()=>{const s=await setup();await s.host.perform({operation:'take',workspaceId:s.id});s.fake.text='Human edited';const r=await s.host.perform({operation:'resume',workspaceId:s.id});expect(r.success&&r.workspace?.observation?.text).toBe('Human edited');expect(r.success&&r.workspace?.epoch).not.toBe(999);await expect(s.host.agent({workspaceId:s.id,grant:s.grant,operation:'observe',epoch:s.epoch})).rejects.toThrow();s.host.dispose();});
 test('navigation, disconnect and ended Workroom sessions fence grants but allow cleanup',async()=>{const s=await setup();s.fake.event('Page.frameNavigated',{frame:{id:'frame_test',url:'https://example.test/next'}});await expect(s.host.agent({workspaceId:s.id,grant:s.grant,operation:'observe',epoch:s.epoch})).rejects.toThrow();s.fake.close();const status=await s.host.perform({operation:'status',workspaceId:s.id});expect(status.success&&status.workspace?.connection).toBe('disconnected');s.stop();await s.host.perform({operation:'detach',workspaceId:s.id});s.host.dispose();});
 test('unknown actions stop further writes until human takeover and explicit result review',async()=>{const s=await setup();s.fake.hold=Promise.reject(new Error('reply lost'));s.fake.hold.catch(()=>{});const base={workspaceId:s.id,grant:s.grant,epoch:s.epoch};await expect(s.host.agent({...base,operation:'click',selector:'#send',requestId:'unknown_action',observationId:s.observationId})).rejects.toThrow();const observed=await s.host.agent({...base,operation:'observe'});await expect(s.host.agent({...base,operation:'fill',selector:'#draft',text:'retry',requestId:'other_action',observationId:(observed as any).workspace.observation.id})).rejects.toThrow('unknown outcome');await expect(s.host.perform({operation:'settle',workspaceId:s.id,requestId:'unknown_action'})).rejects.toThrow();await s.host.perform({operation:'take',workspaceId:s.id});await expect(s.host.perform({operation:'resume',workspaceId:s.id})).rejects.toThrow();const reviewed=await s.host.perform({operation:'settle',workspaceId:s.id,requestId:'unknown_action'});expect(reviewed.success&&reviewed.workspace?.receipt?.state).toBe('reviewed');await s.host.perform({operation:'resume',workspaceId:s.id});s.host.dispose();});
 test('detach never closes the borrowed browser, its target or its profile',async()=>{const s=await setup();await s.host.perform({operation:'detach',workspaceId:s.id});expect(s.fake.closed).toBe(true);expect(s.fake.calls.some(c=>/closeTarget|Browser.close|disposeBrowserContext/.test(c.method))).toBe(false);});
 test('cleanup remains idempotent after an ended Workroom was already reaped',async()=>{const s=await setup();s.stop();s.host.reap();const calls=s.fake.calls.length;expect(await s.host.perform({operation:'detach',workspaceId:s.id})).toEqual({success:true});expect(await s.host.perform({operation:'detach',workspaceId:s.id})).toEqual({success:true});await expect(s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'observe'})).rejects.toThrow();expect(s.fake.calls).toHaveLength(calls);expect(s.fake.closed).toBe(true);s.host.dispose();});
 test('agent cannot manage profiles, grant itself access or send raw CDP/JS',async()=>{const s=await setup();for(const operation of ['connect','grant','Browser.getCookies','Runtime.evaluate'])await expect(s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation})).rejects.toThrow();const r=await handleWorkroomBrowser(new Request('http://127.0.0.1/api/workroom-browser-agent',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://evil.test'},body:'{}'}),s.host,true);expect(r.status).toBe(400);expect(()=>parseWorkroomBrowserRequest({operation:'profiles',port:9222})).toThrow();s.host.dispose();});
 test('seven language copies have complete, nonempty labels',()=>{for(const lang of APP_LANGUAGES){const copy=workroomBrowserCopy(lang.id);expect(Object.keys(copy)).toEqual(Object.keys(workroomBrowserCopy('ko')));expect(Object.values(copy).every(x=>typeof x==='string'&&!!x)).toBe(true);}});
});

test('host refusals preserve messages and expose stable codes through the local API',async()=>{
 const {WorkroomBrowserError}=await import('../src/workroomBrowserErrorCodes');
 const host=new WorkroomBrowserHost({runningSession:()=>null});
 try{
  await expect(host.perform({operation:'status',workspaceId:'missing'})).rejects.toBeInstanceOf(WorkroomBrowserError);
  await expect(host.perform({operation:'status',workspaceId:'missing'})).rejects.toMatchObject({code:'workspace-not-found',message:'Browser workspace not found.'});
  const response=await handleWorkroomBrowser(new Request('http://127.0.0.1/api/browser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'status',workspaceId:'missing'})}),host);
  expect(response.status).toBe(400);expect(await response.json()).toEqual({success:false,code:'workspace-not-found',error:'Browser workspace not found.'});
 }finally{host.dispose();}
});
test('local click/fill/select detail is bounded to 12 receipts and absent from every agent response',async()=>{
 const s=await setup(),send=s.fake.send.bind(s.fake),name='Observed field '.repeat(10);
 s.fake.send=async(method,params={},session)=>{
  if(method==='Runtime.evaluate'&&params.expression?.includes('const elements=[]'))return {result:{value:JSON.stringify({url:s.fake.url,title:'Page',text:'Page data',elements:[{selector:'#field',role:'input',name}]})}};
  return send(method,params,session);
 };
 try{
  let latest:any;
  for(let n=0;n<15;n++){
   const observed=await s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'observe'});if(!observed.success||!observed.workspace?.observation)throw Error('observe');
   const action=(['click','fill','select'] as const)[n%3]!;
   const request={workspaceId:s.id,grant:s.grant,epoch:s.epoch,observationId:observed.workspace.observation.id,operation:action,selector:'#field',requestId:'detail_action_'+n,text:'private action input',value:'private selection'};
   const answer=await s.host.agent(request);if(!answer.success||!answer.workspace)throw Error('action');
   expect(answer.workspace.receipt).toEqual({id:request.requestId,state:'completed'});expect(answer.workspace.activity).toBeUndefined();expect(answer.workspace.waiting).toBeUndefined();
   const local=await s.host.perform({operation:'status',workspaceId:s.id});if(!local.success||!local.workspace)throw Error('status');latest=local.workspace;
   expect(latest.receipt).toMatchObject({id:request.requestId,state:'completed',action,target:{role:'input',name:name.slice(0,80)}});expect(latest.receipt.at).toBeGreaterThan(0);
   expect(latest.activity).toHaveLength(Math.min(12,n+1));expect(JSON.stringify(latest.activity)).not.toContain('private action input');expect(JSON.stringify(latest.activity)).not.toContain('private selection');
   if(n===14){const duplicate=await s.host.agent(request);expect(duplicate.success&&duplicate.workspace?.receipt).toEqual({id:request.requestId,state:'completed'});const after=await s.host.perform({operation:'status',workspaceId:s.id});expect(after.success&&after.workspace?.activity).toEqual(latest.activity);}
  }
  expect(latest.activity[0].id).toBe('detail_action_3');expect(latest.activity.at(-1)).toEqual(latest.receipt);
 }finally{s.host.dispose();}
});
test('receipt target comes from the observed element in the request frame, never the same selector in another frame',async()=>{
 const s=await setup(),send=s.fake.send.bind(s.fake);
 s.fake.send=async(method,params={},session)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame_test'},childFrames:[{frame:{id:'child_frame',url:s.fake.url}}]}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:params.frameId==='child_frame'?43:42};
  if(method==='Runtime.evaluate'&&params.expression?.includes('const elements=[]'))return {result:{value:JSON.stringify({url:s.fake.url,title:'Page',text:'',elements:[{selector:'#field',role:'input',name:params.contextId===43?'Child field':'Main field',...(params.contextId===43?{frame:'f1'}:{})}]})}};
  return send(method,params,session);
 };
 try{
  const observed=await s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'observe'});if(!observed.success||!observed.workspace?.observation)throw Error('observe');
  await s.host.agent({workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'fill',selector:'#field',frame:'f1',text:'secret',requestId:'frame_detail',observationId:observed.workspace.observation.id});
  const local=await s.host.perform({operation:'status',workspaceId:s.id});expect(local.success&&local.workspace?.receipt).toMatchObject({action:'fill',target:{role:'input',name:'Child field'}});
 }finally{s.host.dispose();}
});
test('unknown receipt detail survives review, and a repeated request never replays or creates activity',async()=>{
 const s=await setup();s.fake.hold=Promise.reject(new Error('reply lost'));s.fake.hold.catch(()=>{});
 try{
  const request={workspaceId:s.id,grant:s.grant,epoch:s.epoch,operation:'click',selector:'#send',requestId:'detail_unknown',observationId:s.observationId};
  await expect(s.host.agent(request)).rejects.toThrow('reply lost');
  const local=await s.host.perform({operation:'status',workspaceId:s.id});if(!local.success)throw Error('status');
  expect(local.workspace?.receipt).toMatchObject({id:'detail_unknown',action:'click',state:'unknown'});expect(local.workspace?.activity).toHaveLength(1);
  const at=local.workspace!.receipt!.at;
  await s.host.agent(request);expect(s.fake.calls.filter(c=>c.params.expression?.includes('.click()'))).toHaveLength(1);
  await s.host.perform({operation:'take',workspaceId:s.id});
  const reviewed=await s.host.perform({operation:'settle',workspaceId:s.id,requestId:'detail_unknown'});if(!reviewed.success)throw Error('settle');
  expect(reviewed.workspace?.receipt).toEqual({id:'detail_unknown',action:'click',state:'reviewed',at});expect(reviewed.workspace?.activity).toEqual([{id:'detail_unknown',action:'click',state:'reviewed',at:expect.any(Number)}]);
 }finally{s.host.dispose();}
});
