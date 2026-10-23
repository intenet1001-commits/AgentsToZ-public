import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync, realpathSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { WorkroomConversationJournal } from '../src/workroomConversationJournal';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { workroomSessionContext, savedWorkroomConversation } from '../src/workroomConversationIdentity';
import { WORKROOM_HISTORY_VERSION, normalizeWorkroomHistoryRequest } from '../src/workroomConversationProtocol';
import { AiTerminalService } from '../src/aiTerminalService';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';
import { handleWorkroomConversationRequest } from '../src/workroomConversationApi';

const directories: string[] = [];
const journals: WorkroomConversationJournal[] = [];
afterEach(() => { for(const j of journals.splice(0))j.close();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true}); });
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'workroom-history-')));directories.push(root);
  const cwd=join(root,'project'),provider=join(root,'.claude');mkdirSync(cwd);mkdirSync(provider);
  const env={HOME:root,CLAUDE_CONFIG_DIR:provider};
  const summary={id:randomUUID(),targetId:'project-target-001',agent:'claude' as const,state:'running' as const,createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:30,accountId:'host-default'};
  const context=workroomSessionContext(summary,cwd,env,false,summary.id);
  const save=(id:string=summary.id)=>{const dir=join(provider,'projects',claudeProjectSlugCandidates(cwd)[0]!);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,id+'.jsonl'),JSON.stringify({type:'user',message:{content:'fixture only'}})+'\n');};
  const journal=new WorkroomConversationJournal(root);journals.push(journal);
  return {root,cwd,provider,env,summary,context,save,journal};
}
const request=(operation:string,body:object={})=>({protocolVersion:WORKROOM_HISTORY_VERSION,operation,...body});
describe('local workroom history boundaries',()=>{
  test('automatic-save notices can read only an already verified exact session with the same account and project',async()=>{
    const f=fixture();let context=f.context;f.journal.started(context);
    const history=new WorkroomConversationService({appDataDir:f.root,journal:f.journal,contexts:()=>[context],prepare:async()=>context,launch:async()=>({})});
    try{
      expect(history.verifiedProviderId(f.summary.id,f.summary.targetId)).toBeNull();
      f.save();f.journal.observe(context,f.summary.id);expect(history.verifiedProviderId(f.summary.id,f.summary.targetId)).toBe(f.summary.id);
      expect(history.verifiedProviderId('neighbour-session',f.summary.targetId)).toBeNull();expect(history.verifiedProviderId(f.summary.id,'other-project')).toBeNull();
      context={...context,accountFingerprint:'different-account'};expect(history.verifiedProviderId(f.summary.id,f.summary.targetId)).toBeNull();
      context={...f.context,targetFingerprint:'different-project'};expect(history.verifiedProviderId(f.summary.id,f.summary.targetId)).toBeNull();
      context={...f.context,restricted:true};expect(history.verifiedProviderId(f.summary.id,f.summary.targetId)).toBeNull();
    }finally{await history.shutdown();}
  });
  test('a bound Community follow-up uses exact history review and durable resume admission',async()=>{
    const f=fixture();f.journal.started(f.context);f.save();f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
    let launched=0;const contexts:any[]=[];
    const history=new WorkroomConversationService({appDataDir:f.root,journal:f.journal,platform:'darwin',contexts:()=>contexts,prepare:async()=>f.context,assertNoWriter:async()=>{},launch:async(record,_id,_cols,_rows,launch)=>{
      expect(launch.resume.conversationId).toBe(f.summary.id);expect(record.targetId).toBe(f.summary.targetId);launch.launching();launched++;
      const context={...f.context,summary:{...f.summary,id:randomUUID()}};contexts.push(context);history.started(context,record.id);return {session:context.summary};
    }});
    try{
      await expect(history.resumeThreadSession(f.summary.id,'other-target',randomUUID(),()=>true)).rejects.toThrow('프로젝트');
      await expect(history.resumeThreadSession(f.summary.id,f.summary.targetId,randomUUID(),()=>false)).rejects.toThrow('권한');
      const session=await history.resumeThreadSession(f.summary.id,f.summary.targetId,randomUUID(),()=>true);expect(session?.id).not.toBe(f.summary.id);expect(launched).toBe(1);
      await expect(history.resumeThreadSession(f.summary.id,f.summary.targetId,randomUUID(),()=>true)).rejects.toThrow('원래');expect(launched).toBe(1);
    }finally{await history.shutdown();}
  });
  test('strict requests reject missing ids, paths, wrong store shape and remote fields',()=>{
    expect(()=>normalizeWorkroomHistoryRequest(request('resume.execute',{storeInstanceId:randomUUID()}))).toThrow();
    expect(()=>normalizeWorkroomHistoryRequest(request('list',{archived:false,path:'/tmp/p'}))).toThrow();
    expect(()=>normalizeWorkroomHistoryRequest(request('rename',{storeInstanceId:randomUUID(),conversationId:randomUUID(),expectedRevision:1,title:'hello'}))).toThrow();
    expect(()=>normalizeWorkroomHistoryRequest(request('list',{archived:false,sessionToken:'private'}))).toThrow();
  });
  test('boot restores metadata without creating a CLI; prepared launches remain unknown',()=>{
    const f=fixture(),record=f.journal.started(f.context);f.save();
    f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
    const ended=f.journal.get(record.id),id=randomUUID();f.journal.prepareResume(ended.id,ended.revision,id,{intent:'resume'});
    const instance=f.journal.storeInstanceId;f.journal.close();
    const reopened=new WorkroomConversationJournal(f.root);journals.push(reopened);
    expect(reopened.storeInstanceId).toBe(instance);
    expect(reopened.receipt(id)?.state).toBe('unknown');
    expect(reopened.get(record.id).pendingResumeId).toBe(id);
    expect(reopened.list(false).records).toHaveLength(1);
    expect(()=>reopened.prepareResume(record.id,reopened.get(record.id).revision,randomUUID(),{})).toThrow();
    expect(readFileSync(join(f.root,'workroom-history-v1','history.sqlite')).includes(Buffer.from('fixture only'))).toBe(false);
  });
  test('rename/archive are CAS mutations; duplicates do not toggle state or change identity',()=>{
    const f=fixture(),r=f.journal.started(f.context),id=randomUUID();
    const renamed=f.journal.mutate(r.id,r.revision,id,'rename','사용자 대화');
    expect(f.journal.mutate(r.id,r.revision,id,'rename','사용자 대화').revision).toBe(renamed.revision);
    expect(()=>f.journal.mutate(r.id,r.revision,id,'rename','다른 제목')).toThrow();
    expect(()=>f.journal.mutate(r.id,r.revision,randomUUID(),'archive')).toThrow();
    const archived=f.journal.mutate(r.id,renamed.revision,randomUUID(),'archive');
    expect(archived.state).toBe('running');expect(f.journal.list(false).records).toHaveLength(0);expect(f.journal.list(true).records[0]?.id).toBe(r.id);
  });
  test('stale running observations cannot resurrect an ended execution',()=>{
    const f=fixture(),r=f.journal.started(f.context);
    f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},null);
    f.journal.observe(f.context,null);expect(f.journal.get(r.id).state).toBe('ended');
  });
  test('Claude launch identity survives an abrupt boot exit before its first observation',async()=>{
    const f=fixture(),r=f.journal.started(f.context);
    expect(r.binding).toBe('unverified');expect(r.providerConversationId).toBe(f.summary.id);
    f.save();f.journal.close();
    const journal=new WorkroomConversationJournal(f.root);journals.push(journal);let launched=0;
    const history=new WorkroomConversationService({appDataDir:f.root,journal,platform:'darwin',contexts:()=>[],prepare:async()=>f.context,assertNoWriter:async()=>{},launch:async()=>{launched++;return{};}});
    const restored=journal.get(r.id);expect(restored.state).toBe('detached');expect(restored.binding).toBe('unverified');
    const review=await history.perform(request('resume.review',{storeInstanceId:journal.storeInstanceId,conversationId:r.id,expectedRevision:restored.revision}));
    expect(review.review?.available).toBe(true);expect(launched).toBe(0);await history.shutdown();
    const other=fixture(),initial=other.journal.started(other.context);other.save();
    expect(other.journal.observe(other.context,other.summary.id)?.binding).toBe('verified');expect(other.journal.get(initial.id).binding).toBe('verified');
  });
  test('the SQLite file cannot be replaced by a link',()=>{
    const f=fixture();f.journal.started(f.context);
    const path=join(f.root,'workroom-history-v1','history.sqlite');renameSync(path,path+'.saved');symlinkSync(path+'.saved',path);
    expect(()=>f.journal.list(false)).toThrow();
  });
  test('future schemas are refused without resetting the saved instance or rows',()=>{
    const f=fixture(),r=f.journal.started(f.context);f.journal.close();
    const path=join(f.root,'workroom-history-v1','history.sqlite'),db=new Database(path);
    db.exec('UPDATE workroom_meta SET version=3');db.close();
    expect(()=>new WorkroomConversationJournal(f.root)).toThrow();
    const inspect=new Database(path,{readonly:true});
    expect((inspect.query('SELECT version FROM workroom_meta').get() as any).version).toBe(3);
    expect((inspect.query('SELECT id FROM workroom_conversations').get() as any).id).toBe(r.id);inspect.close();
  });
  test('keyset pages preserve every historical record without duplicating the cursor',()=>{
    const f=fixture();
    for(let n=0;n<57;n++)f.journal.started({...f.context,summary:{...f.summary,id:randomUUID(),state:'exited'}});
    const a=f.journal.list(false),b=f.journal.list(false,a.nextBefore!);
    expect(a.records).toHaveLength(50);expect(b.records).toHaveLength(7);expect(b.nextBefore).toBeNull();
    expect(new Set([...a.records,...b.records].map(r=>r.id)).size).toBe(57);
  });
  test('provider proof requires a saved user turn and the exact Codex cwd',()=>{
    const f=fixture();const empty=join(f.provider,'projects',claudeProjectSlugCandidates(f.cwd)[0]!,f.summary.id+'.jsonl');mkdirSync(join(f.provider,'projects',claudeProjectSlugCandidates(f.cwd)[0]!),{recursive:true});writeFileSync(empty,'{"type":"summary"}\n');
    expect(savedWorkroomConversation('claude',f.provider,f.cwd,f.summary.id)).toBeNull();f.save();expect(savedWorkroomConversation('claude',f.provider,f.cwd,f.summary.id)).not.toBeNull();
    const id=randomUUID(),dir=join(f.root,'.codex','sessions','2026','10','13');mkdirSync(dir,{recursive:true});
    const path=join(dir,'rollout-test-'+id+'.jsonl'),rollout=(cwd:string,source='cli')=>JSON.stringify({type:'session_meta',payload:{id,cwd,timestamp:new Date().toISOString(),source}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message'}});
    writeFileSync(path,rollout('/different'));
    expect(savedWorkroomConversation('codex',join(f.root,'.codex'),f.cwd,id)).toBeNull();
    writeFileSync(path,rollout(f.cwd));expect(savedWorkroomConversation('codex',join(f.root,'.codex'),f.cwd,id)).toBe(path);
    writeFileSync(path,rollout(f.cwd,'exec'));expect(savedWorkroomConversation('codex',join(f.root,'.codex'),f.cwd,id)).toBeNull();
  });
  test('API rejects GET, queries, oversized and diagnostic-bearing failures',async()=>{
    const service={perform:async()=>{throw Object.assign(new Error('ENOENT /private/비밀경로'),{code:'ENOENT'});}};
    expect((await handleWorkroomConversationRequest(new Request('http://localhost/api/agent-runtime/terminals/history'),service)).status).toBe(405);
    expect((await handleWorkroomConversationRequest(new Request('http://localhost/api/agent-runtime/terminals/history?x=1',{method:'POST',body:'{}'}),service)).status).toBe(405);
    const failed=await handleWorkroomConversationRequest(new Request('http://localhost/api/agent-runtime/terminals/history',{method:'POST',body:'{}'}),service);expect(await failed.text()).not.toContain('비밀경로');expect(failed.headers.get('cache-control')).toBe('no-store');
    let called=false;const oversized=await handleWorkroomConversationRequest(new Request('http://localhost/api/agent-runtime/terminals/history',{method:'POST',body:'x'.repeat(8193)}),{perform:async()=>{called=true;return{} as any;}});
    expect(oversized.status).toBe(400);expect(called).toBe(false);
  });
});

function resumedFixture(options:{now?:()=>number;launchFailure?:boolean;prepare?:()=>Promise<void>}={}){
  const f=fixture();f.save();const created=f.journal.started(f.context);f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
  let launches=0;
  const deps={appDataDir:f.root,journal:f.journal,platform:'darwin',now:options.now,contexts:()=>[],
    prepare:async()=>{await options.prepare?.();return {...f.context,summary:{...f.summary,state:'exited' as const}};},assertNoWriter:async()=>{},
    launch:async(_r:any,_id:string,_cols:number,_rows:number,binding:any)=>{
      const context={...f.context,summary:{...f.summary,id:randomUUID()}};await binding.validate(context);binding.launching();launches++;
      if(options.launchFailure)throw new Error('fixture crash after spawn');
      f.journal.started(context,binding.logicalConversationId);return {session:context.summary};
    }};
  const history=new WorkroomConversationService(deps);
  const review=()=>{const r=f.journal.get(created.id);return history.perform(request('resume.review',{storeInstanceId:f.journal.storeInstanceId,conversationId:r.id,expectedRevision:r.revision}));};
  const execute=(value:any,id=randomUUID())=>request('resume.execute',{storeInstanceId:f.journal.storeInstanceId,conversationId:created.id,expectedRevision:value.review.revision,reviewId:value.review.id,requestId:id,cols:100,rows:30});
  return {f,history,review,execute,created,launches:()=>launches};
}
test('distinct request ids compete for one durable reservation',async()=>{
  const f=resumedFixture(),review=await f.review();
  const results=await Promise.allSettled([f.history.perform(f.execute(review)),f.history.perform(f.execute(review))]);
  expect(f.launches()).toBe(1);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await f.history.shutdown();
});
test('a crash after the launch boundary remains unknown across a real store restart',async()=>{
  const f=resumedFixture({launchFailure:true}),review=await f.review(),execute=f.execute(review);
  expect((await f.history.perform(execute)).resume?.state).toBe('unknown');
  expect((await f.history.perform(execute)).resume?.state).toBe('unknown');expect(f.launches()).toBe(1);
  const store=f.f.journal.storeInstanceId;await f.history.shutdown();
  let relaunched=0;const recovered=new WorkroomConversationService({appDataDir:f.f.root,platform:'darwin',contexts:()=>[],prepare:async()=>f.f.context,assertNoWriter:async()=>{},launch:async()=>{relaunched++;return{};}});
  const list=await recovered.perform(request('list',{archived:false}));expect(list.storeInstanceId).toBe(store);expect(relaunched).toBe(0);
  expect((await recovered.perform(request('resume.status',{storeInstanceId:store,requestId:(execute as any).requestId}))).resume?.state).toBe('unknown');
  const r=list.records![0]!;expect((await recovered.perform(request('resume.review',{storeInstanceId:store,conversationId:r.id,expectedRevision:r.revision}))).review?.available).toBe(false);
  await expect(recovered.perform(request('resume.status',{storeInstanceId:randomUUID(),requestId:randomUUID()}))).rejects.toThrow();
  expect(relaunched).toBe(0);await recovered.shutdown();
});
test('review expiry and review replacement are checked again after authentication awaits',async()=>{
  let now=1000,wait=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const f=resumedFixture({now:()=>now,prepare:async()=>{if(wait)await gate;}}),review=await f.review();
  wait=true;const pending=f.history.perform(f.execute(review));now+=61000;release();
  await expect(pending).rejects.toThrow();expect(f.launches()).toBe(0);await f.history.shutdown();
  const other=resumedFixture(),a=await other.review();await other.review();
  await expect(other.history.perform(other.execute(a))).rejects.toThrow();expect(other.launches()).toBe(0);await other.history.shutdown();
});
test('a changed checkout or another writer is refused and review diagnostics stay private',async()=>{
  const f=resumedFixture();renameSync(f.f.cwd,f.f.cwd+'.original');mkdirSync(f.f.cwd);
  const r=f.f.journal.get(f.created.id),history=new WorkroomConversationService({appDataDir:f.f.root,journal:f.f.journal,platform:'darwin',contexts:()=>[],
    prepare:async()=>workroomSessionContext(f.f.summary,f.f.cwd,f.f.env,false),launch:async()=>({}),assertNoWriter:async()=>{throw new Error('another writer');}});
  const q=request('resume.review',{storeInstanceId:f.f.journal.storeInstanceId,conversationId:r.id,expectedRevision:r.revision});
  expect((await history.perform(q)).review?.available).toBe(false);
  await history.shutdown();
  const g=resumedFixture(),row=g.f.journal.get(g.created.id),h=new WorkroomConversationService({appDataDir:g.f.root,journal:g.f.journal,platform:'darwin',contexts:()=>[],prepare:async()=>{throw new Error('설정 읽기 실패 /private/credential.json');},launch:async()=>({})});
  expect((await h.perform(request('resume.review',{storeInstanceId:g.f.journal.storeInstanceId,conversationId:row.id,expectedRevision:row.revision}))).review?.reason).not.toContain('/private');await h.shutdown();
});

test('real terminal service links a cold resume to one conversation and fences simultaneous clicks',async()=>{
  const f=fixture();let terminals!:AiTerminalService;let history!:WorkroomConversationService;
  let starts=0;const args:string[][]=[];const children=new Map<number,()=>void>();
  const configure=(journal?:WorkroomConversationJournal)=>{
  history=new WorkroomConversationService({appDataDir:f.root,journal,platform:'darwin',
    contexts:()=>terminals.historySessions(),prepare:r=>terminals.prepareHistoryContext(r),
    assertNoWriter:async()=>{},resolveBinding:async c=>c.providerConversationId??null,
    launch:(r,requestId,cols,rows,historyResume)=>terminals.perform({operation:'start',requestId,targetId:r.targetId,agent:r.agent,accountId:r.accountId,cols,rows},undefined,{historyResume})});
  terminals=new AiTerminalService({history,env:f.env,headlessScreen:false,resolveTarget:async()=>({cwd:f.cwd}),executable:()=>'/fixture/claude',
    signalGroup:pid=>children.get(pid)?.(),spawn:(command,options:any)=>{
      starts++;args.push(command);let finish!:(code:number)=>void;const exited=new Promise<number>(resolve=>{finish=resolve;});const pid=500000+starts;
      const end=()=>{options.terminal.exit();finish(0);};children.set(pid,end);
      return {pid,exited,kill:end,terminal:{write:()=>1,resize:()=>{},close:()=>{}}};
    }});
  };configure(f.journal);
  const started=await terminals.perform({operation:'start',requestId:randomUUID(),targetId:f.summary.targetId,agent:'claude',cols:100,rows:30,prompt:'never replay this',bypassPermissions:true});
  f.save(started.session!.id);
  await terminals.perform({operation:'close',requestId:randomUUID(),sessionId:started.session!.id});
  await terminals.shutdown();await history.shutdown();configure();
  expect(starts).toBe(1); // Recreating both services and reopening the DB launches nothing.
  const listed=await history.perform(request('list',{archived:false})),r=listed.records![0]!;
  expect(r.binding).toBe('verified');expect(r.state).toBe('ended');
  const review=await history.perform(request('resume.review',{storeInstanceId:listed.storeInstanceId,conversationId:r.id,expectedRevision:r.revision}));
  expect(review.review?.available).toBe(true);
  const execute=request('resume.execute',{storeInstanceId:listed.storeInstanceId,conversationId:r.id,expectedRevision:r.revision,reviewId:review.review!.id,requestId:randomUUID(),cols:100,rows:30});
  const results=await Promise.all([history.perform(execute),history.perform(execute)]);
  expect(starts).toBe(2);expect(results[0]!.resume?.session?.id).toBe(results[1]!.resume?.session?.id);
  expect(args[1]).toContain('--resume');expect(args[1]).toContain(started.session!.id);expect(args[1]).not.toContain('never replay this');expect(args[1]).not.toContain('bypassPermissions');
  expect(args[1]!.slice(args[1]!.indexOf('--permission-mode'),args[1]!.indexOf('--permission-mode')+2)).toEqual(['--permission-mode','default']);
  const latest=await history.perform(request('list',{archived:false}));expect(latest.records).toHaveLength(1);expect(latest.records![0]!.id).toBe(r.id);
  await terminals.perform({operation:'start',requestId:randomUUID(),targetId:f.summary.targetId,agent:'claude',cols:100,rows:30,resumeFrom:results[0]!.resume!.session!.id});
  const hot=await history.perform(request('list',{archived:false}));expect(hot.records).toHaveLength(1);expect(hot.records![0]!.id).toBe(r.id);
  await terminals.shutdown();await history.shutdown();
});

test('workspace or account directory replacement refuses resume before any launch',async()=>{
  const f=fixture();f.save();const record=f.journal.started(f.context);
  f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
  let launches=0;
  const history=new WorkroomConversationService({appDataDir:f.root,journal:f.journal,platform:'darwin',contexts:()=>[],
    prepare:async r=>workroomSessionContext({...f.summary,id:r.sessionId,state:'exited'},f.cwd,f.env,false),
    assertNoWriter:async()=>{},launch:async()=>{launches++;return{};}});
  renameSync(f.provider,f.provider+'.original');mkdirSync(f.provider);
  const r=f.journal.get(record.id),review=await history.perform(request('resume.review',{storeInstanceId:f.journal.storeInstanceId,conversationId:r.id,expectedRevision:r.revision}));
  expect(review.review?.available).toBe(false);expect(review.review?.reason).toContain('계정');expect(launches).toBe(0);
  await history.shutdown();
});

test('trusted resume intent is part of terminal replay ownership',async()=>{
  const f=fixture();let starts=0,validated=0,finish!:(n:number)=>void,end!:()=>void;
  const terminals=new AiTerminalService({env:f.env,headlessScreen:false,resolveTarget:async()=>({cwd:f.cwd}),executable:()=>'/fixture/claude',
    signalGroup:()=>end(),spawn:(_args,options:any)=>{starts++;const exited=new Promise<number>(r=>{finish=r;});end=()=>{options.terminal.exit();finish(0);};return {pid:500001,exited,kill:end,terminal:{write:()=>1,resize:()=>{},close:()=>{}}};}});
  const body={operation:'start',requestId:randomUUID(),targetId:f.summary.targetId,agent:'claude',accountId:'host-default',cols:100,rows:30};
  const resume={logicalConversationId:randomUUID(),accountId:'host-default',cwd:f.cwd,resume:{agent:'claude' as const,conversationId:randomUUID()},validate:async()=>{validated++;},launching:()=>{}};
  try{
    const a=await terminals.perform(body,undefined,{historyResume:resume});
    expect((await terminals.perform(body,undefined,{historyResume:{...resume}})).session!.id).toBe(a.session!.id);
    await expect(terminals.perform(body,undefined,{historyResume:{...resume,logicalConversationId:randomUUID(),resume:{...resume.resume,conversationId:randomUUID()}}})).rejects.toThrow('같은 요청 ID');
    await expect(terminals.perform(body)).rejects.toThrow('같은 요청 ID');
    expect(starts).toBe(1);expect(validated).toBe(1);
  }finally{await terminals.shutdown();}
});

test.skipIf(process.platform!=='darwin')('an open provider file blocks cold resume until the owner closes it',async()=>{
  const f=fixture();f.save();const created=f.journal.started(f.context);f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
  const path=savedWorkroomConversation('claude',f.provider,f.cwd,f.summary.id)!,fd=openSync(path,'r');
  const history=new WorkroomConversationService({appDataDir:f.root,journal:f.journal,contexts:()=>[],prepare:async()=>f.context,launch:async()=>({})});
  const q=()=>{const r=f.journal.get(created.id);return history.perform(request('resume.review',{storeInstanceId:f.journal.storeInstanceId,conversationId:r.id,expectedRevision:r.revision}));};
  try{expect((await q()).review?.available).toBe(false);}finally{closeSync(fd);}
  expect((await q()).review?.available).toBe(true);await history.shutdown();
});

test('duty history is excluded and Windows never probes or launches a cold resume',async()=>{
  const f=fixture();let prepared=0;
  const history=new WorkroomConversationService({appDataDir:f.root,journal:f.journal,platform:'win32',contexts:()=>[{...f.context,restricted:true}],prepare:async()=>{prepared++;return f.context;},launch:async()=>{throw new Error('unexpected launch');}});
  history.started({...f.context,restricted:true});expect((await history.perform(request('list',{archived:false}))).records).toEqual([]);
  f.save();const created=f.journal.started(f.context);f.journal.observe({...f.context,summary:{...f.summary,state:'exited'}},f.summary.id);
  const r=f.journal.get(created.id),review=await history.perform(request('resume.review',{storeInstanceId:f.journal.storeInstanceId,conversationId:r.id,expectedRevision:r.revision}));
  expect(review.review?.available).toBe(false);expect(review.review?.reason).toContain('Mac');expect(prepared).toBe(0);await history.shutdown();
});
