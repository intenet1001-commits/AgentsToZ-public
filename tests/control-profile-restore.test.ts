import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createControlProfileHost} from '../control-profile-server';
import {initializeProjectMemory,detectProjectMemory,writeMemoryDocument,readMemoryDocument} from '../project-memory-server';
import {CONTROL_PROFILE_PRIVATE_PATH} from '../src/controlProfileContract';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
test('another Mac restores the seeded private Control once and keeps its canonical memory',async()=>{
 const root=mkdtempSync(join(tmpdir(),'control-restore-'));dirs.push(root);const app=join(root,'AgentsToZ_byCS'),data=join(root,'data');mkdirSync(join(app,'src'),{recursive:true});mkdirSync(data);writeFileSync(join(app,'api-server.ts'),'');writeFileSync(join(app,'src/App.tsx'),'');writeFileSync(join(app,'package.json'),JSON.stringify({name:'AgentsToZ_byCS'}));
 const seed={schemaVersion:1,profileId:randomUUID(),memoryId:randomUUID(),repositoryUrl:'https://github.com/test-owner/Control.git',repositoryNodeId:'R_verified'};
 mkdirSync(join(app,'.agentstoz-private'));writeFileSync(join(app,CONTROL_PROFILE_PRIVATE_PATH),JSON.stringify(seed));
 const rows:Array<{id:string;folderPath:string;name:string}>=[{id:'app',folderPath:app,name:'AgentsToZ_byCS'}];let clones=0,pulls=0;
 const host=createControlProfileHost({appDataDir:data,portalDataFile:join(data,'portal.json'),gitPath:'fixture-git',ghPath:'fixture-gh',registered:async()=>rows,register:async c=>{const old=rows.find(r=>r.folderPath===c.root);if(old)return old.id;rows.push({id:'restored',name:'AgentsToZ-Control',folderPath:c.root});return 'restored';},lease:async(_r,_l,op)=>op(),command:async argv=>{
  if(argv[0]==='fixture-gh')return {stdout:JSON.stringify({id:'R_verified',visibility:'PRIVATE'}),exitCode:0};
  if(argv.includes('clone')){clones++;const stage=argv.at(-1)!;mkdirSync(stage);Bun.spawnSync(['git','init','-q'],{cwd:stage});writeFileSync(join(stage,'CONTROL.md'),'# Control\n');initializeProjectMemory({folderPath:stage,projectName:'Control',memoryId:seed.memoryId,autoBackup:false});return {stdout:'',exitCode:0};}
  return {stdout:seed.repositoryUrl,exitCode:0};
 },pullMemory:async input=>{pulls++;const memory=detectProjectMemory(input.folderPath);writeMemoryDocument(memory.projectRoot,memory.memoryPath!,'# Shared Control\n\n## Operating\n\n### Keep prior decisions\n\nSame memory on both Macs.\n');return {success:true} as any;}});
 const first=await host.store.prepare();expect(first.state).toBe('ready');expect(first.profileId).toBe(seed.profileId);expect(first.memoryId).toBe(seed.memoryId);expect(first.projectId).toBe('restored');expect(rows).toHaveLength(2);expect(clones).toBe(1);expect(pulls).toBe(1);
 expect(host.recall('prior decisions').hits[0]?.body).toContain('Same memory');
 await host.store.prepare();expect(rows).toHaveLength(2);expect(clones).toBe(1);expect(pulls).toBe(1);
 expect(readFileSync(join(root,'AgentsToZ-Control','.agent-memory/config.json'),'utf8')).toContain(seed.memoryId);
});
test('private bootstrap metadata is excluded from public snapshots and contains no local paths or credentials',()=>{
 const publisher=readFileSync(join(import.meta.dir,'../scripts/publish.ts'),'utf8');expect(publisher).toContain('prefixes: [".agentstoz-private/"');
 const path=join(import.meta.dir,'../.agentstoz-private/control-bootstrap.json');if(!existsSync(path))return; // Public snapshot intentionally omits this file.
 const seed=readFileSync(path,'utf8');expect(seed).not.toContain('/Users/');expect(seed).not.toMatch(/token|password|service_role|secret/i);
});

test('refresh receives later cross-Mac decisions and keeps local memory available on conflicts and offline failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'control-sync-'));dirs.push(dir);const root=join(dir,'AgentsToZ-Control');mkdirSync(root);writeFileSync(join(root,'CONTROL.md'),'Control');
 initializeProjectMemory({folderPath:root,projectName:'Control',agent:'codex',autoBackup:true});const memory=detectProjectMemory(root);
 let mode='success',calls=0;
 const host=createControlProfileHost({appDataDir:join(dir,'data'),portalDataFile:join(dir,'portal.json'),gitPath:'git',ghPath:'gh',registered:async()=>[{id:'control',name:'AgentsToZ-Control',folderPath:root}],register:async()=> 'control',lease:async(_r,_l,op)=>op(),pullMemory:async()=>{
  calls++;if(mode==='offline')throw new Error('offline');if(mode==='conflict')return {success:false} as any;
  writeMemoryDocument(memory.projectRoot,memory.memoryPath!,'# Shared\n\n## Operating\n\n### New decision\nLatest from another Mac.\n');return {success:true} as any;
 }});
 expect((await host.prepare()).sync?.state).toBe('current');expect(host.recall('New decision').hits[0]?.body).toContain('Latest');
 await host.store.synchronize();expect(calls).toBe(1);
 const saved=readMemoryDocument(memory.projectRoot,memory.memoryPath!);mode='conflict';expect((await host.store.synchronize(true)).sync?.state).toBe('needs-attention');expect(host.store.status().state).toBe('ready');expect(readMemoryDocument(memory.projectRoot,memory.memoryPath!)).toBe(saved);
 mode='offline';expect((await host.store.synchronize(true)).sync?.state).toBe('needs-attention');expect(readMemoryDocument(memory.projectRoot,memory.memoryPath!)).toBe(saved);
 mode='success';const before=calls;await Promise.all([host.store.synchronize(true),host.store.synchronize(true)]);expect(calls-before).toBe(1);
});
