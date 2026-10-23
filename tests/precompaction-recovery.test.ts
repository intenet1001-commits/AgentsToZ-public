import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,rmSync,readdirSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {PreCompactionRecovery,type RecoveryAgent} from '../src/preCompactionRecovery';
import {readRecoveryJsonl,readHermesRecovery} from '../src/preCompactionSources';
import {readPreCompactionHookRequest} from '../src/preCompactionBridge';
import {acquireWorkspaceDirectoryLease} from '../src/workspaceLease';
import {MEMORY_INPUT_TTL,MemorySaveInputStore} from '../src/memorySaveInputStore';
import {withRecoveryHook,recoveryHookScript} from '../src/projectMemoryRecoveryHook';

async function fixture(run:(f:{host:PreCompactionRecovery;target:{id:string;root:string;memoryId:string;validate:()=>Promise<boolean>};root:string;setNow:(n:number)=>void;setValid:(b:boolean)=>void;source:(agent:RecoveryAgent,text?:string)=>Promise<any>})=>Promise<void>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'recovery-checkpoint-'))),key=randomBytes(32);let now=1000,valid=true;
  const d={path:join(root,'checkpoints.sqlite'),appDataRoot:root,supported:()=>true,now:()=>now,
    acquire:()=>acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1,deadOwnerRecoveryClass:'manual'}),
    release:(lease:any)=>lease.release(),readKey:async()=>Buffer.from(key)};
  const host=new PreCompactionRecovery(d),target={id:'target-id',root,memoryId:'memory-id',validate:async()=>valid};
  try{await run({host,target,root,setNow:n=>{now=n;},setValid:b=>{valid=b;},source:async(agent,text='synthetic current conversation')=>{
    const bytes=Buffer.from(text);return {agent,sessionId:'session-id',bytes,sourceDigest:createHash('sha256').update(bytes).digest('hex'),start:0,end:bytes.length};
  }});}finally{key.fill(0);rmSync(root,{recursive:true,force:true});}
}

test('four agents share encrypted recovery, durable replay and a separate opt-in without claiming memory or backup completion',async()=>{
  await fixture(async f=>{
    expect((await f.host.status(f.target)).enabled).toBe(false);
    expect(readdirSync(f.root)).toEqual([]); // A status read creates no DB/key.
    const off=await f.host.capture(f.target,()=>f.source('codex'));expect(off.localCheckpointSaved).toBe(false);
    await expect(f.host.setEnabled(f.target,0,true)).rejects.toThrow();
    await f.host.setEnabled(f.target,0,true,1);
    for(const agent of ['codex','claude','hermes','agy'] as const){
      const first=await f.host.capture(f.target,()=>f.source(agent));
      expect(first).toMatchObject({localCheckpointSaved:true,memorySaved:false,remoteBackedUp:false,coverage:'fragment'});
      expect(await f.host.capture(f.target,()=>f.source(agent))).toEqual(first);
      const recovered=await f.host.read(f.target,first.checkpointId!);
      expect(recovered).toMatchObject({text:'synthetic current conversation',authority:'historical-untrusted',memorySaved:false});
    }
    expect((await f.host.status(f.target)).receipts).toHaveLength(4);
    for(const file of readdirSync(join(f.root,'precompaction-inputs')))expect(readFileSync(join(f.root,'precompaction-inputs',file)).includes(Buffer.from('synthetic current conversation'))).toBe(false);
    expect(readdirSync(f.root)).not.toContain('memory-save-inputs');
    await f.host.setEnabled(f.target,1,false);
    expect((await f.host.capture(f.target,()=>f.source('codex','new'))).localCheckpointSaved).toBe(false);
    expect((await f.host.status(f.target)).receipts).toHaveLength(4);
  });
});

test('all four agents expose dated raw-fragment notices only after durable capture, with no plaintext or invented percentage',async()=>{
  await fixture(async f=>{
    expect(f.host.notices()).toEqual([]);expect(readdirSync(f.root)).toEqual([]);
    const target={...f.target,name:'격리 QA'};
    await f.host.setEnabled(target,0,true,1);
    for(const agent of ['codex','claude','hermes','agy'] as const)await f.host.capture(target,()=>f.source(agent,'private recovery bytes'));
    const notices=f.host.notices();expect(notices).toHaveLength(4);expect(notices.every(n=>n.projectName==='격리 QA')).toBe(true);
    expect(JSON.stringify(notices)).not.toContain('private recovery bytes');expect(JSON.stringify(notices)).not.toContain('session-id');expect(notices.every(n=>!Object.hasOwn(n,'threshold')&&!Object.hasOwn(n,'usedPercent'))).toBe(true);
    f.setNow(1000+MEMORY_INPUT_TTL);expect(f.host.notices()).toEqual([]);
  });
});

test('conversation selection preserves exact Unicode/CRLF offsets, skips command and hook tails, and still detects a later retarget',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'unicode.jsonl'),header={type:'session_meta',payload:{id:'session-id',cwd:f.root,source:'cli'}};
    const row=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
    const content=[JSON.stringify(header),'',JSON.stringify(row('이전 큰 대화 '+ 'x'.repeat(33000))),JSON.stringify(row('현재 실제 대화 🧪 한글  ')),JSON.stringify(row('/compact')),JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})].join('\r\n')+'\r\n';
    writeFileSync(path,content);
    const input={agent:'codex' as const,sessionId:'session-id',cwd:f.root,path,providerRoot:f.root};
    const source=readRecoveryJsonl(input);expect(source.bytes.length).toBeLessThanOrEqual(32000);expect(source.bytes.toString()).toContain('현재 실제 대화');expect(source.bytes.toString()).not.toContain('/compact');expect(Buffer.from(content).subarray(source.start,source.end).equals(source.bytes)).toBe(true);
    expect(source.sourceDigest).toBe(createHash('sha256').update(source.bytes).digest('hex'));source.bytes.fill(0);
    const other=join(f.root,'other-retarget');mkdirSync(other);
    writeFileSync(path,content+JSON.stringify({type:'turn_context',payload:{cwd:other}})+'\n');expect(()=>readRecoveryJsonl(input)).toThrow('작업 폴더');
    writeFileSync(path,JSON.stringify(header)+'\n'+JSON.stringify(row('/compact'))+'\n');expect(()=>readRecoveryJsonl(input)).toThrow('실제 대화');
  });
});

test('source changes, missing registration, expiry, stale settings and periodic budgets never become success receipts',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await expect(f.host.setEnabled(f.target,0,false)).rejects.toThrow();
    const result=await f.host.capture(f.target,()=>f.source('agy'));
    expect((await f.host.capture(f.target,()=>f.source('agy','new source'),true)).reason).toBe('rate-limited');
    f.setValid(false);await expect(f.host.read(f.target,result.checkpointId!)).rejects.toThrow();
    f.setValid(true);f.setNow(1000+MEMORY_INPUT_TTL);
    await expect(f.host.read(f.target,result.checkpointId!)).rejects.toThrow('EXPIRED');
    await f.host.maintenance();expect(readdirSync(join(f.root,'precompaction-inputs')).filter(n=>n.endsWith('.enc'))).toEqual([]);
    expect((await f.host.status(f.target)).receipts[0]?.expired).toBe(true);
    await expect(f.host.capture(f.target,()=>f.source('codex','x'.repeat(32_001)))).rejects.toThrow();
    expect((await f.host.status(f.target)).receipts).toHaveLength(1);
  });
});

test('a full raw-recovery budget cannot block the original AI-memory encrypted input store',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    const recovery=join(f.root,'precompaction-inputs');mkdirSync(recovery,{mode:0o700});
    const occupied=join(recovery,'synthetic-occupied');writeFileSync(occupied,'');truncateSync(occupied,64*1024*1024);
    await expect(f.host.capture(f.target,()=>f.source('codex'))).rejects.toThrow('BUDGET_PAUSED');
    expect((await f.host.status(f.target)).receipts).toEqual([]);
    const lease=await acquireWorkspaceDirectoryLease({workspacePath:f.root,appDataDir:f.root,attempts:1,deadOwnerRecoveryClass:'manual'}),key=randomBytes(32);
    try{
      const bytes=Buffer.from('independent AI-memory input'),hash=createHash('sha256').update(bytes).digest('hex');
      const binding={saveId:'separate-save',memoryId:'memory-id',policyEpoch:1,inputDigest:hash,coverageDigest:hash,beforeHash:hash,providerBindingDigest:hash};
      const store=new MemorySaveInputStore(f.root,lease,()=>1000);await store.stage(binding,bytes,key);
      expect(store.read(binding,key).toString()).toBe(bytes.toString());
    }finally{key.fill(0);lease.release();}
  });
});

test('more than 24 other active sessions cannot bypass the exact-session periodic budget',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);await f.host.capture(f.target,()=>f.source('agy'),true);
    for(let i=0;i<25;i++){
      f.setNow(1001+i);
      await f.host.capture(f.target,async()=>({...await f.source('agy'),sessionId:'other-'+i}),true);
    }
    expect((await f.host.capture(f.target,()=>f.source('agy','updated original'),true)).reason).toBe('rate-limited');
  });
});

test('source adapters read an exact bounded fragment, reject another project and reject symlinks',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'session.jsonl');
    const header={type:'session_meta',payload:{id:'session-id',cwd:f.root,source:'cli' as unknown}};
    writeFileSync(path,JSON.stringify(header)+'\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'fixture conversation'}})+'\n');
    const input={agent:'codex' as const,sessionId:'session-id',cwd:f.root,path,providerRoot:f.root};
    const source=readRecoveryJsonl(input);expect(source.end-source.start).toBe(source.bytes.length);source.bytes.fill(0);
    const other=join(f.root,'other');mkdirSync(other);
    expect(()=>readRecoveryJsonl({...input,cwd:other})).toThrow();
    const link=join(f.root,'linked.jsonl');symlinkSync(path,link);expect(()=>readRecoveryJsonl({...input,path:link})).toThrow();
    writeFileSync(path,JSON.stringify({...header,payload:{...header.payload,source:{subagent:'review'}}})+'\n');
    expect(()=>readRecoveryJsonl(input)).toThrow();
    writeFileSync(path,JSON.stringify(header)+'\n'+JSON.stringify({type:'turn_context',payload:{cwd:other}})+'\n');
    expect(()=>readRecoveryJsonl(input)).toThrow();
    writeFileSync(path,JSON.stringify({sessionId:'session-id',cwd:f.root,type:'user',message:{content:'fixture'}})+'\n');
    expect(readRecoveryJsonl({...input,agent:'claude'}).verification).toBe('transcript-cwd');
    writeFileSync(path,JSON.stringify({type:'user_input',content:'fixture'} )+'\n');
    expect(()=>readRecoveryJsonl({...input,agent:'agy'})).toThrow();
    expect(readRecoveryJsonl({...input,agent:'agy',hookWorkspace:f.root}).verification).toBe('provider-hook-workspace');
  });
});

test('Claude hook logs and compact commands cannot crowd the latest conversation out of recovery',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'claude.jsonl'),base={sessionId:'session-id',cwd:f.root};
    const rows=[{...base,type:'user',message:{role:'user',content:'QA_USER_MARKER'}},
      {...base,type:'assistant',message:{role:'assistant',content:[{type:'text',text:'QA_RESPONSE_MARKER'}]}},
      {...base,type:'attachment',attachment:{type:'hook_success',command:'hook log '.repeat(6000)}},
      {...base,type:'user',message:{role:'user',content:'/compact'}}];
    const original=Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join(''));writeFileSync(path,original);
    const value=readRecoveryJsonl({agent:'claude',sessionId:'session-id',cwd:f.root,path,providerRoot:f.root});
    try{
      expect(value.bytes.toString()).toContain('QA_RESPONSE_MARKER');
      expect(value.bytes.toString()).toContain('QA_USER_MARKER');
      expect(value.bytes.length).toBeLessThanOrEqual(32_000);
      expect(value.bytes.equals(original.subarray(value.start,value.end))).toBe(true);
      expect(value.sourceDigest).toBe(createHash('sha256').update(value.bytes).digest('hex'));
    }finally{value.bytes.fill(0);}
    // An oversized new user message must pause, never claim an older answer is the latest fragment.
    writeFileSync(path,Buffer.concat([original,Buffer.from(JSON.stringify({...base,type:'user',message:{content:'x'.repeat(40_000)}})+'\n')]));
    expect(()=>readRecoveryJsonl({agent:'claude',sessionId:'session-id',cwd:f.root,path,providerRoot:f.root})).toThrow();
  });
});

test('Claude real hook-sized tails and local compact output preserve the actual answer',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'claude-large-hooks.jsonl'),base={sessionId:'session-id',cwd:f.root};
    const message={...base,type:'assistant',message:{role:'assistant',content:[{type:'text',text:'QA_REAL_ANSWER 🧪'}]}};
    const hook=()=>({...base,type:'system',subtype:'stop_hook_summary',hookInfos:[{command:'synthetic hook '.repeat(22000)}]});
    const rows=[{...base,type:'user',message:{role:'user',content:'QA_REAL_REQUEST'}},hook(),message,hook(),
      {...base,type:'user',isCompactSummary:true,message:{content:'SYNTHETIC_COMPACT_SUMMARY'}},
      {...base,type:'user',message:{content:'<command-name>/compact</command-name>\n<command-message>compact</command-message>'}},
      {...base,type:'user',repeatsCompactSummary:true,message:{content:'<local-command-stdout>SYNTHETIC_HOOK_OUTPUT</local-command-stdout>'}},hook()];
    const original=Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join(''));writeFileSync(path,original);
    const input={agent:'claude' as const,sessionId:'session-id',cwd:f.root,path,providerRoot:f.root};
    const source=readRecoveryJsonl(input);
    try{
      expect(source.bytes.toString()).toContain('QA_REAL_ANSWER');
      expect(source.bytes.toString()).not.toContain('SYNTHETIC_COMPACT_SUMMARY');
      expect(source.bytes.toString()).not.toContain('SYNTHETIC_HOOK_OUTPUT');
      expect(source.bytes.toString()).not.toContain('<command-name>');
      expect(source.bytes.length).toBeLessThanOrEqual(32000);
      expect(source.bytes.equals(original.subarray(source.start,source.end))).toBe(true);
    }finally{source.bytes.fill(0);}
    // Work stays bounded; excessive provider noise must fail visibly, not save noise as a conversation.
    writeFileSync(path,Buffer.concat([original,...Array.from({length:8},()=>Buffer.from(JSON.stringify(hook())+'\n'))]));
    expect(()=>readRecoveryJsonl(input)).toThrow('실제 대화');
  });
});

test('Hermes SQLite capture proves session cwd and reads bounded original rows in one transaction',async()=>{
  await fixture(async f=>{
    const path=join(f.root,'hermes.db'),db=new Database(path);
    db.run('CREATE TABLE sessions(id TEXT,cwd TEXT)');db.run('CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL)');
    db.query('INSERT INTO sessions VALUES (?,?)').run('session-id',f.root);
    db.query('INSERT INTO messages VALUES (1,?,?,?,1)').run('session-id','user','synthetic Hermes');db.close();
    const value=readHermesRecovery({sessionId:'session-id',cwd:f.root,databasePath:path});expect(value.bytes.toString()).toContain('synthetic Hermes');
    expect(()=>readHermesRecovery({sessionId:'other-session',cwd:f.root,databasePath:path})).toThrow();
  });
});

test('hook boundary accepts metadata only, rejects browser callers and never accepts source paths or transcript bodies',async()=>{
  const body={agent:'codex',sessionId:'session-id',cwd:'/fixture',event:'pre-compaction'} as const;
  const request=(value:unknown,headers:Record<string,string>={})=>new Request('http://127.0.0.1/api/project-memory/pre-compaction',{method:'POST',headers,body:JSON.stringify(value)});
  expect(await readPreCompactionHookRequest(request(body))).toEqual(body);
  for(const value of [{...body,path:'/private/file'},{...body,text:'private'},{...body,agent:'agy'},{...body,cwd:'relative'}])await expect(readPreCompactionHookRequest(request(value))).rejects.toThrow();
  await expect(readPreCompactionHookRequest(request(body,{origin:'https://example.com'}))).rejects.toThrow();
  await expect(readPreCompactionHookRequest(request({...body,extra:'x'.repeat(17_000)}))).rejects.toThrow();
});

test('installer preserves user hooks and provider opt-outs and remains idempotent',()=>{
  const existing={hooks:{PreCompact:[{hooks:[{type:'command',command:'user-owned-hook'}]}]}};
  const result=withRecoveryHook(existing,'codex','');
  expect(JSON.stringify(result)).toContain('user-owned-hook');
  expect(withRecoveryHook(result,'codex','')).toEqual(result);
  expect(withRecoveryHook({'agentstoz-recovery':{enabled:false}},'agy','')['agentstoz-recovery'].enabled).toBe(false);
  const agy=withRecoveryHook({'agentstoz-recovery':{enabled:false,PreInvocation:[{type:'command',command:'user-owned-hook'}],PreToolUse:[{type:'command',command:'other-event'}]}},'agy','');
  expect(JSON.stringify(agy)).toContain('user-owned-hook');expect(JSON.stringify(agy)).toContain('other-event');
  expect(withRecoveryHook(agy,'agy','')).toEqual(agy);
  expect(recoveryHookScript()).toContain('ProxyHandler({})');expect(recoveryHookScript()).not.toContain('transcript_path');
});
