import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomBrowserRecovery} from '../src/workroomBrowserRecovery';
import {WorkroomBrowserHost} from '../src/workroomBrowserHost';
import type {BrowserCdp} from '../src/workroomCdpTransport';
import {workroomBrowserStageCopy} from '../src/workroomBrowserStageCopy';
import {APP_LANGUAGES} from '../src/i18n';
const profile={id:'chrome:Default',browserId:'chrome' as const,browserName:'Chrome',profileDirectory:'Default',profileName:'Saved account',accountLabel:null};
class Cdp implements BrowserCdp{
 mutations=0;loseReply=false;
 async send(m:string,p:any={}){if(m==='Target.getTargets')return {targetInfos:[{type:'page',targetId:'page_saved',url:'https://example.test/private?secret=not-saved',title:'Private'}]};if(m==='Target.attachToTarget')return {sessionId:'cdp_saved'};if(m==='Page.getFrameTree')return {frameTree:{frame:{id:'frame_saved'}}};if(m==='Page.createIsolatedWorld')return {executionContextId:7};if(m==='Runtime.evaluate'){if(p.expression?.includes('.click()')){this.mutations++;if(this.loseReply)throw Error('Response lost after dispatch');return {result:{value:true}};}return {result:{value:JSON.stringify({url:'https://example.test/private?secret=not-saved',title:'Private',text:'account page',elements:[]})}};}return {};}
 onEvent(){return ()=>{};}onClose(){}close(){}
}
async function attach(store:WorkroomBrowserRecovery,recoveryId?:string,target='project_saved'){
 const cdp=new Cdp(),host=new WorkroomBrowserHost({runningSession:()=>({targetId:target}),profiles:()=>[profile],endpoint:async()=>'test',connect:async()=>cdp,recovery:store});
 const r=await host.perform({operation:'connect',sessionId:'session_new',targetId:target,profileId:profile.id,...(recoveryId?{recoveryId}:{})});if(!r.success||!r.workspace)throw Error('connect');
 await host.perform({operation:'select',workspaceId:r.workspace.id,pageId:'page_saved',confirmProfile:true});
 return {host,cdp,id:r.workspace.id};
}
async function allow(s:Awaited<ReturnType<typeof attach>>){const r=await s.host.perform({operation:'resume',workspaceId:s.id});const g=await s.host.perform({operation:'grant',workspaceId:s.id});if(!r.success||!r.workspace?.observation||!g.success)throw Error('grant');return {workspaceId:s.id,epoch:r.workspace.epoch,grant:g.grant!,observationId:r.workspace.observation.id};}
test('cold recovery preserves an uncertain action and refuses replay until human review',async()=>{
 const root=mkdtempSync(join(tmpdir(),'atz-browser-recovery-')),path=join(root,'recovery.sqlite');let store=new WorkroomBrowserRecovery(path),s=await attach(store),a=await allow(s);s.cdp.loseReply=true;
 try{
  await expect(s.host.agent({...a,operation:'click',selector:'#send',requestId:'request_uncertain'})).rejects.toThrow();expect(s.cdp.mutations).toBe(1);const task=store.list('project_saved')[0]!;expect(task.unknown).toBe(1);
  s.host.dispose();store.close();store=new WorkroomBrowserRecovery(path);s=await attach(store,task.id);
  const restored=await s.host.perform({operation:'status',workspaceId:s.id});expect(restored.success&&restored.workspace?.activity).toBeUndefined();expect(restored.success&&restored.workspace?.receipt).toEqual({id:'request_uncertain',state:'unknown'});
  await expect(s.host.agent({...a,operation:'observe'})).rejects.toThrow();await expect(s.host.perform({operation:'resume',workspaceId:s.id})).rejects.toThrow('unknown');expect(s.cdp.mutations).toBe(0);
  await s.host.perform({operation:'settle',workspaceId:s.id,requestId:'request_uncertain'});const fresh=await allow(s);await s.host.agent({...fresh,operation:'click',selector:'#send',requestId:'request_uncertain'});expect(s.cdp.mutations).toBe(0);
  expect(statSync(path).mode&0o777).toBe(0o600);const bytes=readFileSync(path).toString();for(const secret of [a.grant,'secret=not-saved','account page','https://example.test'])expect(bytes.includes(secret)).toBe(false);
 }finally{s.host.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});
test('detaching and reconnecting without selecting recovery cannot bypass an unknown receipt',async()=>{
 const store=new WorkroomBrowserRecovery(':memory:');let s=await attach(store);const a=await allow(s);s.cdp.loseReply=true;
 try{await s.host.agent({...a,operation:'click',selector:'#send',requestId:'unknown_detached'}).catch(()=>{});await s.host.perform({operation:'detach',workspaceId:s.id});s=await attach(store);await expect(s.host.perform({operation:'resume',workspaceId:s.id})).rejects.toThrow('unknown');expect(s.cdp.mutations).toBe(0);}finally{s.host.dispose();store.close();}
});
test('a completed operation is deduplicated after host replacement',async()=>{
 const store=new WorkroomBrowserRecovery(':memory:');let s=await attach(store);const a=await allow(s);try{await s.host.agent({...a,operation:'click',selector:'#send',requestId:'completed_saved'});expect(s.cdp.mutations).toBe(1);const task=store.list('project_saved')[0]!;s.host.dispose();s=await attach(store,task.id);const fresh=await allow(s);await s.host.agent({...fresh,operation:'click',selector:'#send',requestId:'completed_saved'});expect(s.cdp.mutations).toBe(0);}finally{s.host.dispose();store.close();}
});
test('a failed durable intent prevents a page mutation',async()=>{
 const store=new WorkroomBrowserRecovery(':memory:'),s=await attach(store),a=await allow(s);store.close();try{await expect(s.host.agent({...a,operation:'click',selector:'#send',requestId:'io_failed_action'})).rejects.toThrow();expect(s.cdp.mutations).toBe(0);}finally{s.host.dispose();}
});
test('reconnecting the same tab also deduplicates completed receipts without selecting history',async()=>{
 const store=new WorkroomBrowserRecovery(':memory:');let s=await attach(store);const a=await allow(s);try{await s.host.agent({...a,operation:'click',selector:'#send',requestId:'completed_detached'});expect(s.cdp.mutations).toBe(1);await s.host.perform({operation:'detach',workspaceId:s.id});s=await attach(store);const fresh=await allow(s);await s.host.agent({...fresh,operation:'click',selector:'#send',requestId:'completed_detached'});expect(s.cdp.mutations).toBe(0);}finally{s.host.dispose();store.close();}
});
test('recovery cannot be rebound to a different project or profile',async()=>{
 const store=new WorkroomBrowserRecovery(':memory:'),s=await attach(store);const task=store.list('project_saved')[0]!;s.host.dispose();try{await expect(attach(store,task.id,'other_project')).rejects.toThrow('project and profile');}finally{store.close();}
});
test('recovery, popup and file instructions cover every supported language',()=>{for(const lang of APP_LANGUAGES){const copy=workroomBrowserStageCopy(lang.id);expect(Object.values(copy).every(s=>typeof s==='string'&&s.length>0)).toBe(true);}});
test('an older recovery file gains receipt tabs; its receipts still count for the tab their task worked in, and no later record hides them',()=>{
 const root=mkdtempSync(join(tmpdir(),'atz-browser-recovery-old-')),path=join(root,'recovery.sqlite');
 const old=new Database(path);old.exec(`CREATE TABLE browser_tasks(id TEXT PRIMARY KEY,targetId TEXT NOT NULL,sessionId TEXT NOT NULL,profileId TEXT NOT NULL,profileName TEXT NOT NULL,source TEXT NOT NULL,pageId TEXT,updatedAt INTEGER NOT NULL);
  CREATE TABLE browser_receipts(taskId TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(taskId,id));`);
 old.query('INSERT INTO browser_tasks VALUES(?,?,?,?,?,?,?,?)').run('task_old','project_saved','session_old',profile.id,'Saved','chrome','page_saved',1);
 old.query('INSERT INTO browser_receipts VALUES(?,?,?,?)').run('task_old','old_click','f','unknown');old.close();
 const store=new WorkroomBrowserRecovery(path);
 try{
  expect(store.unresolved(profile.id,'page_saved')?.id).toBe('task_old');expect(store.unresolved(profile.id,'page_other')).toBeUndefined();
  expect(store.unresolved(profile.id,'page_saved','task_old')).toBeUndefined();expect(store.unresolved('chrome:Other','page_saved')).toBeUndefined();
  // A later task that recorded the same tab is the latest match, but the unknown action stays findable.
  store.save({id:'task_new',sessionId:'session_new',targetId:'project_saved',profileId:profile.id,profileName:'Saved',source:'chrome',page:{id:'page_saved',title:'',url:''},owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'user-confirmed'});
  expect(store.matching(profile.id,'page_saved')?.id).toBe('task_new');expect(store.unresolved(profile.id,'page_saved','task_new')?.id).toBe('task_old');
  // A new receipt keeps the tab it was dispatched in through later state changes; that tab now finds its task.
  store.record('task_old',{id:'new_click',fingerprint:'g',state:'unknown'},'page_other');store.record('task_old',{id:'new_click',fingerprint:'g',state:'completed'});
  expect(store.matching(profile.id,'page_other')?.id).toBe('task_old');expect(store.unresolved(profile.id,'page_other')).toBeUndefined();
  store.record('task_old',{id:'third_click',fingerprint:'h',state:'unknown'},'page_other');
  expect(store.unresolved(profile.id,'page_other')).toMatchObject({id:'task_old',unknown:1});expect(store.get('task_old')?.unknown).toBe(2);
  expect(store.receipts('task_old')).toEqual([{id:'old_click',fingerprint:'f',state:'unknown'},{id:'new_click',fingerprint:'g',state:'completed'},{id:'third_click',fingerprint:'h',state:'unknown'}]);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('a page-less reconnect keeps the task and its unknown receipt without persisting local activity, a title or a URL',async()=>{
 const root=mkdtempSync(join(tmpdir(),'atz-browser-activity-')),path=join(root,'recovery.sqlite');let store=new WorkroomBrowserRecovery(path);const s=await attach(store);
 try{
  const id=store.list('project_saved')[0]!.id;
  const w=(await s.host.perform({operation:'status',workspaceId:s.id}));if(!w.success||!w.workspace)throw Error('status');
  store.record(id,{id:'kept_unknown',fingerprint:'original',state:'unknown'},'page_saved');
  store.save({...w.workspace,page:null,activity:[{id:'ephemeral',action:'fill',target:{role:'input',name:'display-only-name'},state:'completed',at:1}]},id);
  s.host.dispose();store.close();store=new WorkroomBrowserRecovery(path);
  expect(store.get(id)).toMatchObject({pageId:'page_saved',unknown:1});
  expect(store.receipts(id)).toEqual([{id:'kept_unknown',fingerprint:'original',state:'unknown'}]);
  // The recovery file is local metadata only (src/workroomBrowserRecovery.ts): no activity target, page title or URL.
  for(const text of ['display-only-name','Private','https://example.test'])expect(readFileSync(path).includes(Buffer.from(text))).toBe(false);
 }finally{s.host.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});
