import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,rmSync,readdirSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,truncateSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {PreCompactionRecovery,RECOVERY_INTENT_GRACE,type RecoveryAgent} from '../src/preCompactionRecovery';
import {readRecoveryJsonl,readHermesRecovery} from '../src/preCompactionSources';
import {readPreCompactionHookRequest} from '../src/preCompactionBridge';
import {acquireWorkspaceDirectoryLease} from '../src/workspaceLease';
import {MEMORY_INPUT_TTL,MemorySaveInputStore} from '../src/memorySaveInputStore';
import {withRecoveryHook,recoveryHookScript} from '../src/projectMemoryRecoveryHook';

async function fixture(run:(f:{host:PreCompactionRecovery;newHost:()=>PreCompactionRecovery;target:{id:string;root:string;memoryId:string;validate:()=>Promise<boolean>};root:string;setNow:(n:number)=>void;setValid:(b:boolean)=>void;source:(agent:RecoveryAgent,text?:string)=>Promise<any>;abandon:()=>void;setRefreshLimit:(n:number)=>void})=>Promise<void>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'recovery-checkpoint-'))),key=randomBytes(32);let now=1000,valid=true,refreshLimit=Infinity;
  const held=new Set<any>();
  const d={path:join(root,'checkpoints.sqlite'),appDataRoot:root,supported:()=>true,now:()=>now,
    acquire:async()=>{const real=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1,deadOwnerRecoveryClass:'manual'});
      // `setRefreshLimit(n)`: each lease acquired afterwards reports a lost lock from its n-th refresh on.
      let refreshes=0;const limit=refreshLimit,lease=limit===Infinity?real:{identity:real.identity,lockPath:real.lockPath,refresh:()=>++refreshes<limit&&real.refresh(),release:()=>real.release()};
      held.add(lease);return lease;},
    release:(lease:any)=>{held.delete(lease);lease.release();},readKey:async()=>Buffer.from(key)};
  const host=new PreCompactionRecovery(d),target={id:'target-id',root,memoryId:'memory-id',validate:async()=>valid};
  // `abandon` models a host process that died holding the app-data lock, after that lock was recovered.
  try{await run({host,newHost:()=>new PreCompactionRecovery(d),target,root,setNow:n=>{now=n;},setValid:b=>{valid=b;},setRefreshLimit:n=>{refreshLimit=n;},abandon:()=>{for(const lease of [...held]){held.delete(lease);lease.release();}},source:async(agent,text='synthetic current conversation')=>{
    const bytes=Buffer.from(text);return {agent,sessionId:'session-id',bytes,sourceDigest:createHash('sha256').update(bytes).digest('hex'),start:0,end:bytes.length};
  }});}finally{key.fill(0);rmSync(root,{recursive:true,force:true});}
}
const encFiles=(root:string)=>readdirSync(join(root,'precompaction-inputs')).filter(n=>n.endsWith('.enc'));
const intentRows=(root:string)=>{const db=new Database(join(root,'checkpoints.sqlite'),{readonly:true});try{return db.query('SELECT id,unresolved FROM checkpoint_intents').all() as {id:string;unresolved:number}[];}finally{db.close();}};
/** Starts a capture whose 3rd validate (the check after a passed readback) never answers: a process dying before its receipt. */
async function dieBeforeReceipt(host:PreCompactionRecovery,target:{id:string;root:string;memoryId:string;validate:()=>Promise<boolean>},source:()=>Promise<any>){
  let checks=0;
  void host.capture({...target,validate:()=>++checks<3?Promise.resolve(true):new Promise<boolean>(()=>{})},source);
  for(let i=0;i<400&&checks<3;i++)await new Promise(r=>setTimeout(r,5));
  expect(checks).toBe(3);
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

test('a rejected new capture cleans up only its own ciphertext; an existing receipt stays readable',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    const saved=await f.host.capture(f.target,()=>f.source('codex','already receipted'));
    let checks=0;
    const rejecting={...f.target,validate:async()=>++checks<3};
    await expect(f.host.capture(rejecting,()=>f.source('claude','rejected after stage'))).rejects.toThrow();
    const root=join(f.root,'precompaction-inputs');
    expect(readdirSync(root).filter(n=>n.endsWith('.enc'))).toHaveLength(1);
    checks=0;await expect(f.host.capture(rejecting,()=>f.source('codex','already receipted'))).rejects.toThrow();
    expect((await f.host.read(f.target,saved.checkpointId!)).text).toBe('already receipted');
    expect(readdirSync(root).filter(n=>n.endsWith('.enc'))).toHaveLength(1);
    expect((await f.host.status(f.target)).receipts).toHaveLength(1);
  });
});

test('repeated rejected captures leave no permanent expired markers or exhausted staging budget',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    for(let i=0;i<64;i++){
      let checks=0;
      await expect(f.host.capture({...f.target,validate:async()=>++checks<3},async()=>({...await f.source('codex','rejected-'+i),sessionId:'session-'+i}))).rejects.toThrow();
    }
    expect(readdirSync(join(f.root,'precompaction-inputs'))).toEqual([]);
    expect((await f.host.capture(f.target,()=>f.source('codex','still has room'))).localCheckpointSaved).toBe(true);
  });
});

test('a replaced ciphertext is never deleted using a stale stage ownership proof',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    let checks=0,path='';
    const rejecting={...f.target,validate:async()=>{
      if(++checks!==3)return true;
      const root=join(f.root,'precompaction-inputs');path=join(root,readdirSync(root).find(n=>n.endsWith('.enc'))!);
      const bytes=readFileSync(path);renameSync(path,path+'.original');writeFileSync(path,bytes,{mode:0o600});return false;
    }};
    await expect(f.host.capture(rejecting,()=>f.source('claude'))).rejects.toThrow();
    expect(readFileSync(path)).toEqual(readFileSync(path+'.original'));
  });
});

test('interrupted receipt before restart is preserved when ownership cannot be proved',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    const crash=await f.host.capture(f.target,()=>f.source('agy','interrupted after flush'));
    const root=join(f.root,'precompaction-inputs'),name=readdirSync(root).find(n=>n.endsWith('.enc'))!;
    const db=new Database(join(f.root,'checkpoints.sqlite'));
    db.query('DELETE FROM checkpoints WHERE id=?').run(crash.checkpointId!);db.query('DELETE FROM checkpoint_budgets WHERE agent=?').run('agy');db.close();
    let checks=0;
    await expect(f.newHost().capture({...f.target,validate:async()=>++checks<3},()=>f.source('agy','interrupted after flush'))).rejects.toThrow();
    expect(readdirSync(root)).toContain(name);
    f.setNow(1000+MEMORY_INPUT_TTL);await f.newHost().maintenance();
    expect(readdirSync(root)).toContain(name);
  });
});

test('database loss followed by a newly initialized database never deletes existing ciphertext',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await f.host.capture(f.target,()=>f.source('codex'));
    const root=join(f.root,'precompaction-inputs'),name=readdirSync(root).find(n=>n.endsWith('.enc'))!;
    rmSync(join(f.root,'checkpoints.sqlite'));f.setNow(1000+MEMORY_INPUT_TTL);
    const restarted=f.newHost();await restarted.setEnabled(f.target,0,true,1);await restarted.maintenance();
    expect(readdirSync(root)).toContain(name);
  });
});

test('a corrupt interrupted ciphertext is retained for recovery',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    const crash=await f.host.capture(f.target,()=>f.source('claude'));
    const root=join(f.root,'precompaction-inputs'),name=readdirSync(root).find(n=>n.endsWith('.enc'))!;
    const db=new Database(join(f.root,'checkpoints.sqlite'));db.query('DELETE FROM checkpoints WHERE id=?').run(crash.checkpointId!);db.close();
    truncateSync(join(root,name),8);f.setNow(1000+MEMORY_INPUT_TTL);
    await f.newHost().maintenance();expect(readdirSync(root)).toContain(name);
  });
});

test('a receipt write that fails after a passed readback removes its own ciphertext instead of leaving it unreceipted',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    let checks=0,blocker:Database|undefined,error:any;
    // Right after the readback check (3rd validate) another writer takes the lock, so the receipt write's schema
    // bootstrap gets SQLITE_BUSY (busy_timeout=100ms) before any receipt transaction starts.
    const blocked={...f.target,validate:async()=>{if(++checks===3){blocker=new Database(join(f.root,'checkpoints.sqlite'));blocker.run('BEGIN IMMEDIATE');}return true;}};
    try{await f.host.capture(blocked,()=>f.source('codex','receipt write fails'));}catch(e){error=e;}
    finally{blocker?.run('ROLLBACK');blocker?.close();}
    expect(error?.code).toBe('SQLITE_BUSY');
    expect(encFiles(f.root)).toEqual([]);
    expect((await f.host.status(f.target)).receipts).toEqual([]);
    // Deleting the intent hit the same lock; the sweep finds an intent without a file and only clears it.
    expect(intentRows(f.root)).toHaveLength(1);
    f.setNow(1000+RECOVERY_INTENT_GRACE);await f.newHost().maintenance();
    expect(intentRows(f.root)).toEqual([]);
    const saved=await f.host.capture(f.target,()=>f.source('codex','receipt write fails'));
    expect((await f.host.read(f.target,saved.checkpointId!)).text).toBe('receipt write fails');
  });
});

test('a capture that dies between staging and its receipt is reclaimed by the intent sweep, never while it may be in flight',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await dieBeforeReceipt(f.host,f.target,()=>f.source('claude','died before receipt'));
    expect(encFiles(f.root)).toHaveLength(1);expect(intentRows(f.root)).toHaveLength(1);
    // Still holding the app-data lock: the sweep cannot run at all.
    f.setNow(1000+RECOVERY_INTENT_GRACE);await expect(f.newHost().maintenance()).rejects.toThrow();
    expect(encFiles(f.root)).toHaveLength(1);
    f.abandon();
    // Lock recovered but the intent is younger than the grace age: kept.
    f.setNow(1000+RECOVERY_INTENT_GRACE-1);await f.newHost().maintenance();
    expect(encFiles(f.root)).toHaveLength(1);expect(intentRows(f.root)).toHaveLength(1);
    f.setNow(1000+RECOVERY_INTENT_GRACE);await f.newHost().maintenance();
    expect(readdirSync(join(f.root,'precompaction-inputs'))).toEqual([]); // no expiry marker either
    expect(intentRows(f.root)).toEqual([]);
    expect((await f.newHost().status(f.target)).receipts).toEqual([]);
  });
});

test('a lock lost during the sweep\'s authenticated read stops that tick instead of giving up on the file',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await dieBeforeReceipt(f.host,f.target,()=>f.source('claude','lock lost mid-sweep'));
    f.abandon();
    // Refreshes: the loop's own check, the staging-root check, then the check inside the authenticated read reports a lost lock.
    f.setNow(1000+RECOVERY_INTENT_GRACE);f.setRefreshLimit(3);
    await expect(f.newHost().maintenance()).rejects.toThrow('UNAVAILABLE');
    expect(encFiles(f.root)).toHaveLength(1);expect(intentRows(f.root)).toEqual([{id:expect.any(String),unresolved:0}]);
    f.setRefreshLimit(Infinity);await f.newHost().maintenance();
    expect(readdirSync(join(f.root,'precompaction-inputs'))).toEqual([]);expect(intentRows(f.root)).toEqual([]);
  });
});

test('the intent sweep never removes a file that has a receipt',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await dieBeforeReceipt(f.host,f.target,()=>f.source('codex','replayed after a crash'));
    f.abandon();
    // The provider resends the same fragment: the replay adopts the staged file and its receipt clears the intent.
    const host=f.newHost(),saved=await host.capture(f.target,()=>f.source('codex','replayed after a crash'));
    expect(saved.localCheckpointSaved).toBe(true);expect(intentRows(f.root)).toEqual([]);
    // An older app commits receipts without clearing intents: the sweep keeps the file and drops only the intent.
    const db=new Database(join(f.root,'checkpoints.sqlite'));
    const receipt=JSON.parse((db.query('SELECT receipt FROM checkpoints WHERE id=?').get(saved.checkpointId!) as {receipt:string}).receipt);
    db.query('INSERT INTO checkpoint_intents (id,created_at,binding) VALUES (?,?,?)').run(saved.checkpointId!,1000,JSON.stringify(receipt.binding));db.close();
    f.setNow(1000+RECOVERY_INTENT_GRACE);await f.newHost().maintenance();
    expect(intentRows(f.root)).toEqual([]);
    expect((await f.newHost().read(f.target,saved.checkpointId!)).text).toBe('replayed after a crash');
  });
});

test('a crashed replay never claims a file it did not create',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    const earlier=await f.host.capture(f.target,()=>f.source('agy','receipt later lost'));
    const name=encFiles(f.root)[0]!;
    const db=new Database(join(f.root,'checkpoints.sqlite'));db.query('DELETE FROM checkpoints WHERE id=?').run(earlier.checkpointId!);db.query('DELETE FROM checkpoint_budgets').run();db.close();
    await dieBeforeReceipt(f.newHost(),f.target,()=>f.source('agy','receipt later lost'));
    f.abandon();
    expect(intentRows(f.root)).toEqual([]);
    f.setNow(1000+MEMORY_INPUT_TTL+RECOVERY_INTENT_GRACE);await f.newHost().maintenance();
    expect(encFiles(f.root)).toEqual([name]);
  });
});

test('an unreadable crashed ciphertext stays with its intent marked unresolved, and is not retried',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await dieBeforeReceipt(f.host,f.target,()=>f.source('hermes','corrupted after crash'));
    f.abandon();
    const name=encFiles(f.root)[0]!;truncateSync(join(f.root,'precompaction-inputs',name),8);
    f.setNow(1000+RECOVERY_INTENT_GRACE);await f.newHost().maintenance();
    expect(encFiles(f.root)).toEqual([name]);expect(intentRows(f.root)).toEqual([{id:expect.any(String),unresolved:1}]);
    await f.newHost().maintenance();expect(encFiles(f.root)).toEqual([name]);
  });
});

test('a database from before write intents still expires receipted ciphertext',async()=>{
  await fixture(async f=>{
    await f.host.setEnabled(f.target,0,true,1);
    await f.host.capture(f.target,()=>f.source('codex'));
    const db=new Database(join(f.root,'checkpoints.sqlite'));db.run('DROP TABLE checkpoint_intents');db.close();
    f.setNow(1000+MEMORY_INPUT_TTL);await f.newHost().maintenance();
    expect(encFiles(f.root)).toEqual([]);
    expect((await f.host.status(f.target)).receipts[0]?.expired).toBe(true);
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
