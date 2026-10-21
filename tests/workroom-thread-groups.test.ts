import {hasUnselectedProjectCall} from '../src/workroomThreadGroup';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {WorkroomThreadService,type WorkroomThreadDependencies} from '../src/workroomThreadService';
import {normalizeMobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeWorkroomThreadRequest} from '../src/workroomThreadProtocol';
const cleanup:string[]=[];afterEach(()=>cleanup.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'shared-thread-'));chmodSync(root,0o700);cleanup.push(root);
 const store=new WorkroomThreadStore(root,{read:async()=>Buffer.alloc(32,9),create:async()=>Buffer.alloc(32,9)});
 const targets=['group-project-a','group-project-b'],permissions=new Set(targets),folders=new Map(targets.map(id=>[id,id])),starts:string[]=[],writes:{session:string;text:string}[]=[],revisions=new Map<string,number>();let active=true,fail='';
 const deps:WorkroomThreadDependencies={store,resolve:async id=>{if(!folders.has(id))throw Error('missing project');return {fingerprint:folders.get(id)!,label:'프로젝트 '+id.at(-1)};},inspect:id=>({state:'running',inputRevision:revisions.get(id)??0}),start:async(id,targetId,agent)=>{starts.push(targetId);if(targetId===fail)throw Error('fixture failed start');const sessionId=crypto.randomUUID();revisions.set(sessionId,0);return {written:true,session:{id:sessionId,targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28}};},reply:async(_id,session,text,revision)=>{if(revisions.get(session)!==revision)throw Error('stale input');writes.push({session,text});revisions.set(session,revision+1);return {written:true};}};
 const service=new WorkroomThreadService(deps),access={owner:'phone-group-owner',active:()=>active,readAll:false,targets:permissions};
 const call=(action:Parameters<typeof service.perform>[0],body:Parameters<typeof service.perform>[1],id=crypto.randomUUID(),target=targets[0]!)=>service.perform(action,body,target,id,access);
 const create=async(text='두 프로젝트가 함께 개선해 주세요',id=crypto.randomUUID())=>{await call('workroom.threads.create',{agent:'codex',text,targetIds:targets},id);await service.idle();return (await call('workroom.threads.read',{threadId:id})).thread!;};
 return {root,store,service,deps,targets,permissions,folders,starts,writes,revisions,access,call,create,revoke:()=>{active=false;},fail:(id:string)=>{fail=id;}};
}
test('host-observed completions from distinct Workrooms collect in the same task without explicit tool calls',async()=>{
 const f=fixture(),t=await f.create(),[a,b]=t.participants!;
 const complete=(p:typeof a,text:string)=>f.service.completed(p!.sessionId!,{key:'codex:turn-'+p!.targetId,resultText:text},0,()=>true);
 await complete(a,'A 완료');await complete(a,'A 완료');
 let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('running');expect(r.messages!.filter(m=>m.text==='A 완료')).toHaveLength(1);
 await complete(b,'B 완료');r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('completed');
 expect(r.messages!.find(m=>m.text==='A 완료')?.targetId).toBe(a!.targetId);expect(r.messages!.find(m=>m.text==='B 완료')?.targetId).toBe(b!.targetId);
 normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});expect(f.writes).toEqual([]);
});
test('each project final answer follows its early tool result in the same shared thread',async()=>{
 const f=fixture(),t=await f.create(),[a,b]=t.participants!;
 await f.service.publish(a!.sessionId!,crypto.randomUUID(),'result','A 사전 보고');
 await f.service.publish(b!.sessionId!,crypto.randomUUID(),'result','B 사전 보고');
 for(const p of [a,b]){
  const c={key:'codex:final-'+p!.targetId,resultText:'같은 최종 답변'};
  await f.service.completed(p!.sessionId!,c,0,()=>true);await f.service.completed(p!.sessionId!,c,0,()=>true);
  await f.service.publish(p!.sessionId!,crypto.randomUUID(),'result',c.resultText);
 }
 const r=await f.call('workroom.threads.read',{threadId:t.id});
 expect(r.messages!.filter(m=>m.kind==='result').map(m=>[m.targetId,m.text])).toEqual([
  [a!.targetId,'A 사전 보고'],[b!.targetId,'B 사전 보고'],[a!.targetId,'같은 최종 답변'],[b!.targetId,'같은 최종 답변'],
 ]);
 expect(r.thread!.state).toBe('completed');expect(f.writes).toEqual([]);
});
test('one shared task starts distinct project Workrooms and merges their results, questions and direct answers',async()=>{
 const f=fixture(),t=await f.create();expect(f.starts.sort()).toEqual(f.targets);expect(t.sessionId).toBeNull();expect(t.participants).toHaveLength(2);
 const [a,b]=t.participants!;expect(a!.sessionId).not.toBe(b!.sessionId);
 await f.service.publish(a!.sessionId!,crypto.randomUUID(),'question','A에서 확인할 질문');await f.service.publish(b!.sessionId!,crypto.randomUUID(),'result','B 작업 완료');
 let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.find(m=>m.text==='A에서 확인할 질문')!.targetId).toBe(a!.targetId);expect(r.messages!.find(m=>m.text==='B 작업 완료')!.projectLabel).toBe(b!.label);expect(r.thread!.state).toBe('needs-answer');
 const reply=crypto.randomUUID(),body={threadId:t.id,text:'A 질문에 대한 답',expectedRevision:r.thread!.revision,recipientTargetId:a!.targetId};await f.call('workroom.threads.reply',body,reply);await f.call('workroom.threads.reply',body,reply);expect(f.writes).toEqual([{session:a!.sessionId!,text:body.text}]);
 await f.service.input(b!.sessionId!,'B 워크룸에서 직접 입력\r',1);await f.service.publish(a!.sessionId!,crypto.randomUUID(),'result','A 작업 완료');r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('completed');expect(r.messages!.some(m=>m.text==='B 워크룸에서 직접 입력'&&m.targetId===b!.targetId)).toBe(true);
 const worker=await f.service.readSession(b!.sessionId!);expect(worker.thread!.id).toBe(t.id);expect(worker.messages!.some(m=>m.text==='A 작업 완료')).toBe(true);
 for(const target of f.targets){const rows=await f.call('workroom.threads.list',{},crypto.randomUUID(),target);expect(rows.threads!.map(v=>v.id)).toEqual([t.id]);}
 expect(readFileSync(f.store.file).includes(Buffer.from('두 프로젝트'))).toBe(false);normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});
});
test('concurrent duplicate group creation launches each Workroom once and refuses changed membership',async()=>{
 const f=fixture(),id=crypto.randomUUID(),body={agent:'codex' as const,text:'한 번만',targetIds:f.targets};await Promise.all([f.call('workroom.threads.create',body,id),f.call('workroom.threads.create',{...body,targetIds:[...f.targets].reverse()},id)]);await f.service.idle();expect(f.starts).toHaveLength(2);
 await expect(f.call('workroom.threads.create',{...body,text:'다른 일'},id)).rejects.toThrow('내용');
});
test('all project permissions and checkout conflicts are checked before any Workroom launches',async()=>{
 const f=fixture();f.permissions.delete(f.targets[1]!);await expect(f.create()).rejects.toThrow('권한');expect(f.starts).toEqual([]);f.permissions.add(f.targets[1]!);
 await f.call('workroom.threads.create',{agent:'codex',text:'기존 단일 업무'});await f.service.idle();const result=await f.call('workroom.threads.create',{agent:'codex',text:'공동 업무',targetIds:f.targets});expect(result.refusal!.message).toContain('이전 업무');expect(f.starts).toHaveLength(1);
});
test('revoked membership, other owners and changed folders cannot expose the shared thread or send answers',async()=>{
 const f=fixture(),t=await f.create();f.permissions.delete(f.targets[1]!);await expect(f.call('workroom.threads.read',{threadId:t.id})).rejects.toThrow('권한');expect((await f.call('workroom.threads.list',{})).threads).toEqual([]);f.permissions.add(f.targets[1]!);
 await expect(f.service.perform('workroom.threads.read',{threadId:t.id},f.targets[0]!,crypto.randomUUID(),{...f.access,owner:'another-phone'})).rejects.toThrow('접근');f.folders.set(f.targets[1]!,'changed');await expect(f.call('workroom.threads.read',{threadId:t.id})).rejects.toThrow('폴더');expect(f.writes).toEqual([]);
});
test('partial launch failure stays visible without duplicating the healthy project or replaying after restart',async()=>{
 const f=fixture();f.fail(f.targets[1]!);const t=await f.create();expect(t.state).toBe('unknown');expect(t.participants!.filter(p=>p.sessionId)).toHaveLength(1);const restarted=new WorkroomThreadService(f.deps);
 await restarted.perform('workroom.threads.create',{agent:'codex',text:'두 프로젝트가 함께 개선해 주세요',targetIds:f.targets},f.targets[0]!,t.id,f.access);expect(f.starts).toHaveLength(2);
});
test('long shared messages remain lossless in bounded pages, with unique ordered cursors',async()=>{
 const f=fixture(),text='한'.repeat(2000),t=await f.create(text);const member=t.participants![0]!;await f.service.publish(member.sessionId!,crypto.randomUUID(),'result','답'.repeat(2000));
 const all=[];let before:number|undefined;do{const r=await f.call('workroom.threads.read',{threadId:t.id,...(before?{beforeSeq:before}:{})});normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});expect(JSON.stringify(r).length).toBeLessThan(8500);all.unshift(...r.messages!);before=r.nextBefore??undefined;}while(before);
 expect(all.filter(m=>m.kind==='request').map(m=>m.text).join('')).toBe(text);expect(all.filter(m=>m.kind==='result').map(m=>m.text).join('')).toBe('답'.repeat(2000));expect(new Set(all.map(m=>m.seq)).size).toBe(all.length);
});
test('a group reply requires an explicit participant and stale concurrent replies never fan out',async()=>{
 const f=fixture(),t=await f.create();await expect(f.call('workroom.threads.reply',{threadId:t.id,text:'답변',expectedRevision:t.revision})).rejects.toThrow('선택');
 const bodies=t.participants!.map(p=>({threadId:t.id,text:'답 '+p.targetId,expectedRevision:t.revision,recipientTargetId:p.targetId}));await Promise.all(bodies.map(b=>f.call('workroom.threads.reply',b)));expect(f.writes).toHaveLength(1);
});
test('multi-project wire contract refuses duplicates, oversized groups and a recipient on create',()=>{
 for(const targetIds of [['group-project-a','group-project-a'],Array.from({length:9},(_,i)=>'project-'+i)])expect(()=>normalizeWorkroomThreadRequest('workroom.threads.create',{agent:'codex',text:'업무',targetIds})).toThrow();
 expect(()=>normalizeWorkroomThreadRequest('workroom.threads.create',{agent:'codex',text:'업무',recipientTargetId:'group-project-a'})).toThrow();
});

test('the phone gateway maps every group target both ways without exposing host runtime ids',async()=>{
 const f=fixture(),controls=['phone-control-a','phone-control-b'];
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>true,resolve:async()=>f.targets.map((id,i)=>({controlId:controls[i]!,runtimeTargetId:id})),consent:async()=>({targetIds:f.permissions,workspaceScopes:[],isActive:()=>true,requestOwner:f.access.owner}),perform:async(request,target,owner,active,_tester,targets,access)=>({kind:'workspace',action:request.workspace.action,threads:await f.service.perform(request.workspace.action as any,request.workspace.thread!,target,request.requestId,{owner,active,targets,readAll:access!.readAll})})});
 const send=(action:any,thread:any,id=crypto.randomUUID())=>gateway({operation:'workspace',requestId:id,targetId:controls[0]!,workspace:{action,thread}},[],'paired-phone') as Promise<any>;
 const id=crypto.randomUUID();await send('workroom.threads.create',{agent:'codex',text:'그룹 권한',targetIds:controls},id);await f.service.idle();let r=await send('workroom.threads.read',{threadId:id});expect(r.threads.thread.participants.map((p:any)=>p.targetId).sort()).toEqual(controls);
 const member=(await f.store.get(id))!.group!.members[1]!;await f.service.publish(member.sessionId!,crypto.randomUUID(),'question','대상 B 질문');r=await send('workroom.threads.read',{threadId:id});expect(r.threads.messages.find((m:any)=>m.text==='대상 B 질문').targetId).toBe(controls[1]);expect(JSON.stringify(r)).not.toContain(f.targets[0]);
 await send('workroom.threads.reply',{threadId:id,text:'B 답변',recipientTargetId:controls[1],expectedRevision:r.threads.thread.revision});expect(f.writes[0]!.session).toBe(member.sessionId!);
 f.permissions.delete(f.targets[1]!);await expect(send('workroom.threads.create',{agent:'codex',text:'불허',targetIds:controls})).rejects.toThrow('권한');
});
test('a Mac-created shared task needs every project grant and cannot be read or answered through a child id',async()=>{
 const f=fixture(),controls=['phone-control-a','phone-control-b'],id=crypto.randomUUID();
 await f.service.perform('workroom.threads.create',{agent:'codex',text:'Mac 공동 업무',targetIds:f.targets},f.targets[0]!,id,{...f.access,owner:'local',readAll:true});await f.service.idle();
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:f.access.active,resolve:async()=>f.targets.map((runtimeTargetId,i)=>({controlId:controls[i]!,runtimeTargetId})),consent:async()=>({targetIds:f.permissions,workspaceScopes:[],historyScopes:[],isActive:f.access.active,requestOwner:'approved-phone'}),perform:async(request,target,owner,active,_tester,targets,access)=>({kind:'workspace',action:request.workspace.action,threads:await f.service.perform(request.workspace.action as any,request.workspace.thread!,target,request.requestId,{owner,active,targets,readAll:access!.readAll})})});
 const send=(action:any,thread:any)=>gateway({operation:'workspace',requestId:crypto.randomUUID(),targetId:controls[0]!,workspace:{action,thread}},[],'paired-phone') as Promise<any>;
 expect((await send('workroom.threads.list',{})).threads.threads.map((t:any)=>t.id)).toEqual([id]);
 const parent=(await f.store.get(id))!,child=parent.group!.members[0]!;
 await f.service.publish(child.sessionId!,crypto.randomUUID(),'question','첫 프로젝트 질문');let page=(await send('workroom.threads.read',{threadId:id})).threads;
 await send('workroom.threads.reply',{threadId:id,text:'휴대폰 답',recipientTargetId:controls[0],expectedRevision:page.thread.revision});expect(f.writes).toEqual([{session:child.sessionId!,text:'휴대폰 답'}]);
 f.permissions.delete(f.targets[1]!);expect((await send('workroom.threads.list',{})).threads.threads).toEqual([]);
 await expect(send('workroom.threads.read',{threadId:id})).rejects.toThrow('모든 프로젝트');
 await expect(send('workroom.threads.read',{threadId:child.threadId})).rejects.toThrow('공유 스레드');
 await expect(send('workroom.threads.reply',{threadId:child.threadId,text:'우회 답변',expectedRevision:(await f.store.get(child.threadId))!.revision})).rejects.toThrow('공유 스레드');expect(f.writes).toHaveLength(1);
 f.permissions.add(f.targets[1]!);expect((await send('workroom.threads.read',{threadId:id})).threads.thread.id).toBe(id);
 f.revoke();await expect(send('workroom.threads.read',{threadId:id})).rejects.toThrow('다시 연결');
});

test('a completed and checkpointed participant reopens its own Workroom and keeps publishing into the shared task',async()=>{
 const f=fixture();let old='';f.deps.inspect=id=>({state:id===old?'exited':'running',inputRevision:f.revisions.get(id)??0});
 f.deps.open=async(_id,r)=>{const id=crypto.randomUUID();f.revisions.set(id,0);return {id,targetId:r.targetId,agent:r.agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};};
 const t=await f.create(),a=t.participants![0]!;old=a.sessionId!;await f.service.publish(old,crypto.randomUUID(),'result','이전 결과');await f.service.ended(old);
 let page=await f.call('workroom.threads.read',{threadId:t.id});await f.call('workroom.threads.reply',{threadId:t.id,recipientTargetId:a.targetId,expectedRevision:page.thread!.revision,text:'이어서 확인'});
 page=await f.call('workroom.threads.read',{threadId:t.id});const next=page.thread!.participants!.find(p=>p.targetId===a.targetId)!;expect(next.sessionId).not.toBe(old);expect(f.writes).toHaveLength(1);expect(page.messages!.some(m=>m.text==='이어서 확인'&&m.targetId===a.targetId)).toBe(true);await expect(f.service.publish(old,crypto.randomUUID(),'result','늦은 결과')).rejects.toThrow();
});

test('eight participants and maximum UTF-8 results still fit the encrypted transport envelope',async()=>{
 const f=fixture();for(let i=2;i<8;i++){const id='group-project-'+i;f.targets.push(id);f.permissions.add(id);f.folders.set(id,id);}const t=await f.create('긴'.repeat(2000));expect(t.participants).toHaveLength(8);
 await f.service.publish(t.participants![7]!.sessionId!,crypto.randomUUID(),'result','결'.repeat(2000));let before:number|undefined,count=0;
 do{const r=await f.call('workroom.threads.read',{threadId:t.id,...(before?{beforeSeq:before}:{})});normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});expect(Buffer.byteLength(JSON.stringify({kind:'workspace',action:'workroom.threads.read',threads:r}))).toBeLessThanOrEqual(8500);count+=r.messages!.length;before=r.nextBefore??undefined;}while(before);expect(count).toBeGreaterThan(8);
});
test('a lost group reply never repeats a PTY write and an explicit close can resolve a stranded admission',async()=>{
 const f=fixture(),t=await f.create(),member=t.participants![0]!,id=crypto.randomUUID();let attempts=0;f.deps.reply=async()=>{attempts++;throw Error('ack lost');};const body={threadId:t.id,recipientTargetId:member.targetId,text:'미확정 답변',expectedRevision:t.revision};await f.call('workroom.threads.reply',body,id);await f.call('workroom.threads.reply',body,id);expect(attempts).toBe(1);
 let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('unknown');await f.store.mutate(t.id,()=>true,current=>{current!.group!.pendingReply={id:'stranded-reply-id',targetId:member.targetId,textHash:'hash'};return {record:current!,value:null};});r=await f.call('workroom.threads.read',{threadId:t.id});r=await f.call('workroom.threads.close',{threadId:t.id,expectedRevision:r.thread!.revision,consent:true});expect(r.thread!.state).toBe('closed');
});

test('explicit call chips preserve per-project assignment names without turning arbitrary typed names into calls',()=>{
 expect(hasUnselectedProjectCall('@모바일 앱 화면을 고치고 @공통 SDK 엔진을 점검해',['모바일 앱','공통 SDK'])).toBe(false);
 expect(hasUnselectedProjectCall('@다른 프로젝트 작업해',['모바일 앱'])).toBe(true);
 expect(hasUnselectedProjectCall('@A2 작업해',['A'])).toBe(true);
 expect(hasUnselectedProjectCall('#참고 기억으로만 설명해',['모바일 앱'])).toBe(false);
});
