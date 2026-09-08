import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {initializeProjectMemory,detectProjectMemory,readMemoryDocument,writeMemoryDocument,readProjectMemoryJournal,prepareProjectMemoryUpdate} from '../project-memory-server';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemoryEmergencyReserve} from '../src/memoryEmergencyReserve';
import {CompletedMemoryTurnReader} from '../src/memorySaveObservation';
import {executeAutomaticMemorySave,type MemorySaveExecution} from '../src/memorySaveExecutor';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
import {saveDigest} from '../src/memorySaveContract';
const roots:string[]=[],leases:WorkspaceLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))lease.release();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'memory-executor-')));roots.push(base);
 const root=join(base,'project'),app=join(base,'app'),transcriptRoot=join(base,'transcripts');for(const path of [root,app,transcriptRoot])mkdirSync(path);
 const status=initializeProjectMemory({folderPath:root,autoBackup:false});
 const memoryId=status.config!.memoryId,before=readMemoryDocument(root,status.memoryPath!);
 const workspaceLease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(workspaceLease);
 const stagingLease=await acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(stagingLease);
 await new MemoryEmergencyReserve(app,stagingLease).ensure();
 let now=Date.now()-2000;const saves=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>now),sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite'));
 const bindingDigest=saveDigest('verified text provider');saves.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:bindingDigest});now+=1000;
 const binding={agent:'codex' as const,instanceId:'fixture',sessionId:'session',cwd:root,memoryId,policyEpoch:1};
 const timestamp=new Date(now).toISOString(),path=join(transcriptRoot,'session.jsonl');
 const rows=[{type:'session_meta',payload:{id:'session',cwd:root,source:'cli'}},
  {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},
  {type:'turn_context',payload:{cwd:root,turn_id:'turn'}},
  {type:'event_msg',timestamp,payload:{type:'user_message',message:'Prefer verified project evidence.'}},
  {type:'event_msg',timestamp,payload:{type:'agent_message',message:'Confirmed.'}},
  {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}}];
 const bytes=rows.map(row=>Buffer.from(JSON.stringify(row)+'\n'));writeFileSync(path,Buffer.concat(bytes));
 const reader=new CompletedMemoryTurnReader(binding);let offset=0;for(const b of bytes){reader.record(b,offset);offset+=b.length;}
 expect(reader.sources).toHaveLength(1);saves.observeBatch(reader.sources);
 const c:MemorySaveExecution={root,appDataRoot:app,workspaceLease,stagingLease,saves,sessions,sources:[{source:reader.sources[0]!,binding,path,transcriptRoot}],
  provider:{agent:'claude',bindingDigest,ready:async()=>true,propose:async()=>{throw new Error('missing fixture proposal');}},readKey:async()=>randomBytes(32),
  validateRegistration:async()=>({memoryId,canonicalRoot:root}),preflight:async()=>{}};
 let calls=0,input:Buffer|undefined,originalInput='';
 c.provider.propose=async b=>{calls++;input=b;originalInput=b.toString();
  const prepared=prepareProjectMemoryUpdate({folderPath:root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}});
  return prepared.targetedSection?`SESSION: Verified project evidence was retained.\n${prepared.targetedSection.text}\n### Save evidence\nUse checked project evidence.\n`:before;
 };
 return {c,before,path,root,memoryId,journalCount:readProjectMemoryJournal(root).length,calls:()=>calls,input:()=>input,originalInput:()=>originalInput,now:(value:number)=>{now=value;}};
}

test('completed JSONL passes through encrypted prompt and one proposal into document, journal and receipt',async()=>{
 const f=await fixture();const result=await executeAutomaticMemorySave(f.c);
 expect(result).toMatchObject({localSaved:true,verifiedNow:true,backupRequested:false});expect(f.calls()).toBe(1);
 expect(f.c.saves.get(result.saveId).phase).toBe('local-saved');expect(f.c.sessions.status(f.root)).toBeNull();
 expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toContain('Use checked project evidence.');expect(readProjectMemoryJournal(f.root)).toHaveLength(f.journalCount+1);
 expect(f.input()!.every(b=>b===0)).toBe(true);
 const db=new Database(f.c.saves.path,{readonly:true});try{
  const row=db.query('SELECT intent FROM save_jobs WHERE saveId=?').get(result.saveId) as {intent:string};
  expect(JSON.parse(row.intent).inputDigest).toBe(createHash('sha256').update(f.originalInput()).digest('hex'));
 }finally{db.close();}
 for(const name of readdirSync(join(f.c.appDataRoot,'memory-save-inputs')))expect(readFileSync(join(f.c.appDataRoot,'memory-save-inputs',name),'utf8')).not.toContain('Prefer verified project evidence.');
 await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow();expect(f.calls()).toBe(1);
});

test('provider failure is permanently fenced and is never retried automatically',async()=>{
 const f=await fixture();let calls=0;f.c.provider.propose=async()=>{calls++;throw new Error('provider disconnected');};
 await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow('provider disconnected');
 expect(f.c.saves.openJob(f.memoryId)?.phase).toBe('recovery-required');
 await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow();expect(calls).toBe(1);
 expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toBe(f.before);expect(readProjectMemoryJournal(f.root)).toHaveLength(f.journalCount);
});

test('source changes, remote conflicts and unavailable keys do not reserve or invoke a provider',async()=>{
 for(const kind of ['source','conflict','key']){const f=await fixture();
  if(kind==='source')writeFileSync(f.path,'invalid\n');
  if(kind==='conflict')f.c.preflight=async()=>{throw new Error('remote conflict');};
  if(kind==='key')f.c.readKey=async()=>{throw new Error('key unavailable');};
  await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow();expect(f.calls()).toBe(0);expect(f.c.saves.openJob(f.memoryId)).toBeNull();
 }
});

test('unsafe model output, policy revocation and concurrent document edits never receive a success receipt',async()=>{
 for(const kind of ['secret','policy','edit']){const f=await fixture();const propose=f.c.provider.propose;
  f.c.provider.propose=async b=>{const answer=await propose(b);
   if(kind==='policy'){const p=f.c.saves.automaticPolicy();f.c.saves.setAutomaticPolicy(p.revision,{enabled:false});}
   if(kind==='edit')writeMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'),f.before+'\nExternal edit.\n');
   return kind==='secret'?answer+'\nsecret = ghp_'+'a'.repeat(36):answer;
  };
  await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow(kind==='edit'?'REVISION_CONFLICT':kind==='policy'?'POLICY_CHANGED':'안전 검증');expect(f.calls()).toBe(1);expect(f.c.saves.openJob(f.memoryId)?.phase).toBe('recovery-required');
  expect(readProjectMemoryJournal(f.root)).toHaveLength(f.journalCount);
 }
});

test('new Git work during a proposal is not acknowledged by the saved activity baseline',async()=>{
 const f=await fixture();const git=(...args:string[])=>execFileSync('git',args,{cwd:f.root,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
 writeFileSync(join(f.root,'work.txt'),'before');git('add','work.txt');git('commit','-qm','before');const beforeHead=git('rev-parse','HEAD');
 const baseline=detectProjectMemory(f.root).config!;
 const propose=f.c.provider.propose;f.c.provider.propose=async b=>{
  writeFileSync(join(f.root,'work.txt'),'after');git('add','work.txt');git('commit','-qm','after');return propose(b);
 };
 await executeAutomaticMemorySave(f.c);
 const config=detectProjectMemory(f.root).config!;
 expect(config.lastRememberedHead).toBeNull();expect(config.lastRememberedHead).not.toBe(git('rev-parse','HEAD'));
 expect(config.lastRememberedAt).toBe(baseline.lastRememberedAt); // V2 covers only selected turns, never the whole-project baseline.
});

test('quota pause and pre-consent coverage remain unreserved without reading a key or calling AI',async()=>{
 for(const kind of ['quota','old']){const f=await fixture();let keyReads=0;f.c.readKey=async()=>{keyReads++;return randomBytes(32);};
  if(kind==='old'){const p=f.c.saves.automaticPolicy();f.c.saves.setAutomaticPolicy(p.revision,{enabled:false});f.c.saves.setAutomaticPolicy(p.revision+1,{enabled:true,consentVersion:1,providerBindingDigest:f.c.provider.bindingDigest});}
  else {const db=new Database(f.c.saves.path);try{for(let i=0;i<8;i++)db.query('INSERT INTO save_auto_attempts VALUES (?,?,?,?,?)').run('other-'+i,'attempt-'+i,'other',1,Date.now()-2000);}finally{db.close();}}
  await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow(kind==='quota'?'BUDGET_PAUSED':'SOURCES_INELIGIBLE');
  expect(f.c.saves.openJob(f.memoryId)).toBeNull();expect(f.calls()).toBe(0);expect(keyReads).toBe(0);
 }
});

test('an existing entry cannot be dropped or preserved only as a marker inside a code example',async()=>{
 for(const fenced of [false,true]){const f=await fixture(),id='a'.repeat(24);
  writeMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'),`# Project Core Memory\n\n## Key Decisions\n\n### Keep evidence\n<!--memory-entry-id:${id}-->\nMaintain an evidence trail.\n`);
  f.c.provider.propose=async()=>`SESSION: Reviewed the evidence.\n## Key Decisions\n\n### Replacement\nA different decision.\n${fenced?'\n```\n<!-- memory-entry-id:'+id+' -->\n```\n':''}`;
  await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow('INVALID_INPUT');
  expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toContain('Maintain an evidence trail.');
  expect(f.c.saves.openJob(f.memoryId)?.phase).toBe('recovery-required');
 }
});
