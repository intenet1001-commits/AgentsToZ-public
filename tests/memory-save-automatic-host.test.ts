import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,chmodSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {initializeProjectMemory,prepareProjectMemoryUpdate,readMemoryDocument,detectProjectMemory} from '../project-memory-server';
import {MemorySaveAutomaticHost} from '../src/memorySaveAutomaticHost';import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySessionStore} from '../src/memorySessionStore';import {MemorySaveDispatcher} from '../src/memorySaveDispatcher';
import {acquireWorkspaceDirectoryLease} from '../src/workspaceLease';import {CompletedMemoryTurnReader} from '../src/memorySaveObservation';
for(const scope of ['project','all'] as const)test(scope+': explicit preparation and consent connect real bounded evidence to the shared dispatcher and receipt',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'memory-auto-host-'))),app=join(base,'app'),root=join(base,'project'),transcripts=join(base,'transcripts');
 for(const p of [app,root,transcripts])mkdirSync(p);
 const initialized=initializeProjectMemory({folderPath:root,autoBackup:false}),memoryId=initialized.config!.memoryId;
 const bin=join(base,'cli');writeFileSync(bin,'fixture');chmodSync(bin,0o700);
 let now=Date.now()-1000,calls=0,keys=0,legacyDisabled=0,workspaceLeases=0;const key=Buffer.alloc(32,7);
 const store=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>now),sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite'));
 const dispatcher=new MemorySaveDispatcher(),target={id:'fixture-target',cwd:root,root,memoryId,validate:async()=>true};
 const path=join(transcripts,'session.jsonl');
 const host=new MemorySaveAutomaticHost({enabled:()=>true,store,sessions,appDataRoot:app,portalDataFile:join(app,'portal.json'),dispatcher,
  identity:()=> 'fixture-install',targets:async hint=>{expect(hint).toBe(scope==='project'?target.id:null);return [{id:target.id}];},resolve:async id=>id===target.id?target:id==='other-target'?{...target,id,memoryId:'other-memory'}:null,
  discover:async()=>[{key:'fixture',stamp:`${statSync(path).size}:${statSync(path).mtimeMs}`,agent:'codex',path,transcriptRoot:transcripts,sessionId:'session'}],
  key:()=>({load:async()=>{keys++;return Buffer.from(key);}}),
  providerHost:id=>({appDataRoot:app,installationId:id,executable:()=>bin,run:async(_args,_cwd,input)=>{
   if(input===undefined)return {exitCode:0,stderr:'',stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'fixture@example.invalid',orgId:'fixture-org'})};
   calls++;let result='MEMORY_SAVE_READY';
   if(input!=='Reply with exactly MEMORY_SAVE_READY.'){
    const prepared=prepareProjectMemoryUpdate({folderPath:root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}});
    result=prepared.targetedSection!.text+'\n### Checked selection\nRetain only verified completed evidence.\n';
   }
   return {exitCode:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result,modelUsage:{'claude-fixture-1':{}},permission_denials:[]})};
  }}),acquireApp:()=>acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1}),
  acquireWorkspace:r=>{workspaceLeases++;return acquireWorkspaceDirectoryLease({workspacePath:r,appDataDir:app,attempts:1});},release:l=>{l.release();},
  preflight:async()=>{},disableLegacy:()=>{legacyDisabled++;},
 });
 const request=(automaticOperation:string,extra:Record<string,unknown>={})=>host.manage({automaticOperation,observationTargetId:target.id,...extra});
 try{
  expect((await request('status')).enabled).toBe(false);expect(keys).toBe(0);expect(calls).toBe(0);
  await expect(request('prepare-provider',{model:'sonnet',effort:'low'})).rejects.toThrow('INVALID_INPUT');expect(keys).toBe(0);
  const prepared=await request('prepare-provider',{model:'claude-fixture-1',effort:'low'});expect(calls).toBe(1);expect(prepared.enabled).toBe(false);
  await expect(request('enable',{expectedRevision:0,configurationId:prepared.provider!.configurationId})).rejects.toThrow('INVALID_INPUT');expect(legacyDisabled).toBe(0);
  const enabled=await request('enable',{expectedRevision:0,configurationId:prepared.provider!.configurationId,consentVersion:1,scope});
  expect(enabled.enabled).toBe(true);expect(legacyDisabled).toBe(scope==='all'?1:0);expect(calls).toBe(1);
  expect(host.owns('newly-registered-memory')).toBe(scope==='all');
  expect(host.handles(memoryId)).toBe(true);expect(enabled.inScope).toBe(true);expect(enabled.scope).toBe(scope);
  const restarted=new MemorySaveStore(store.path);expect(restarted.automaticPolicy().scopeMemoryId).toBe(scope==='project'?memoryId:null);
  await expect(request('enable',{expectedRevision:1,configurationId:prepared.provider!.configurationId,consentVersion:1})).rejects.toThrow('INVALID_INPUT');
  await expect(request('enable',{expectedRevision:1,configurationId:prepared.provider!.configurationId,consentVersion:1,scope:'all'})).rejects.toThrow('POLICY_CHANGED');
  expect(legacyDisabled).toBe(scope==='all'?1:0);
  if(scope==='project'){
   const beforeLeases=workspaceLeases;expect((await host.run('other-target')).localSaved).toBe(false);expect(workspaceLeases).toBe(beforeLeases);
   expect((await host.manage({automaticOperation:'status',observationTargetId:'other-target'})).inScope).toBe(false);
  }
  now=Date.now();const timestamp=new Date(now).toISOString();
  writeFileSync(join(root,'.agent-memory/activity.json'),JSON.stringify({schemaVersion:1,lastActivityAt:timestamp,agent:'codex'}));
  const rows=[{type:'session_meta',payload:{id:'session',cwd:root,source:'cli'}},
   {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},{type:'turn_context',payload:{cwd:root,turn_id:'turn'}},
   {type:'event_msg',timestamp,payload:{type:'user_message',message:'Remember verified source evidence.'}},
   {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}}].map(v=>Buffer.from(JSON.stringify(v)+'\n'));
  writeFileSync(path,Buffer.concat(rows));const reader=new CompletedMemoryTurnReader({agent:'codex',instanceId:'fixture-install',sessionId:'session',cwd:root,memoryId,policyEpoch:1});
  let offset=0;for(const row of rows){reader.record(row,offset);offset+=row.length;}expect(reader.sources).toHaveLength(1);store.observeBatch(reader.sources);
  await host.tick();
  expect((await host.run(target.id)).state).toBe('waiting-idle');expect(calls).toBe(1);
  const before=detectProjectMemory(root).config!;
  const saved=await host.run(target.id,true);expect(saved).toMatchObject({state:'saved',localSaved:true,backupPending:false});expect(calls).toBe(2);
  expect(host.durableResult(target)).toMatchObject({state:'saved',localSaved:true,backupPending:false});
  expect(readMemoryDocument(root,initialized.memoryPath!)).toContain('Retain only verified completed evidence.');
  expect(detectProjectMemory(root).config!.lastRememberedAt).toBe(before.lastRememberedAt);
  expect((await host.run(target.id,true)).localSaved).toBe(false);expect(calls).toBe(2);
  expect((await request('exclude',{expectedRevision:enabled.revision,excluded:true})).excluded).toBe(true);
  expect(host.handles(memoryId)).toBe(false);
  const disabled=await request('disable',{expectedRevision:2});expect(disabled.enabled).toBe(false);
  await host.tick();expect(calls).toBe(2);expect(legacyDisabled).toBe(scope==='all'?1:0);
 }finally{await dispatcher.shutdown();rmSync(base,{recursive:true,force:true});}
},15_000);
