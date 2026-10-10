import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
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
 const host=createControlProfileHost({appDataDir:data,portalDataFile:join(data,'portal.json'),gitPath:'fixture-git',ghPath:'fixture-gh',registered:async()=>rows,register:async c=>{const old=rows.find(r=>r.folderPath===c.root);if(old)return old.id;rows.push({id:'restored',name:'AgentsToZ-OPS',folderPath:c.root});return 'restored';},lease:async(_r,_l,op)=>op(),command:async argv=>{
  if(argv[0]==='fixture-gh')return {stdout:JSON.stringify({id:'R_verified',visibility:'PRIVATE'}),exitCode:0};
  if(argv.includes('clone')){clones++;const stage=argv.at(-1)!;mkdirSync(stage);Bun.spawnSync(['git','init','-q'],{cwd:stage});writeFileSync(join(stage,'CONTROL.md'),'# Control\n');initializeProjectMemory({folderPath:stage,projectName:'Control',memoryId:seed.memoryId,autoBackup:false});return {stdout:'',exitCode:0};}
  return {stdout:seed.repositoryUrl,exitCode:0};
 },pullMemory:async input=>{pulls++;const memory=detectProjectMemory(input.folderPath);writeMemoryDocument(memory.projectRoot,memory.memoryPath!,'# Shared Control\n\n## Operating\n\n### Keep prior decisions\n\nSame memory on both Macs.\n');return {success:true} as any;}});
 const first=await host.store.prepare();expect(first.state).toBe('ready');expect(first.profileId).toBe(seed.profileId);expect(first.memoryId).toBe(seed.memoryId);expect(first.projectId).toBe('restored');expect(rows).toHaveLength(2);expect(clones).toBe(1);expect(pulls).toBe(1);
 expect(host.recall('prior decisions').hits[0]?.body).toContain('Same memory');
 await host.store.prepare();expect(rows).toHaveLength(2);expect(clones).toBe(1);expect(pulls).toBe(1);
 // A restore lands under the new OPS folder name; nothing is created under the legacy name.
 expect(readFileSync(join(root,'AgentsToZ-OPS','.agent-memory/config.json'),'utf8')).toContain(seed.memoryId);
 expect(existsSync(join(root,'AgentsToZ-Control'))).toBe(false);
});
test('private bootstrap metadata is excluded from public snapshots and contains no local paths or credentials',()=>{
 const publisher=readFileSync(join(import.meta.dir,'../scripts/publish.ts'),'utf8');expect(publisher).toContain('prefixes: [".agentstoz-private/"');
 const path=join(import.meta.dir,'../.agentstoz-private/control-bootstrap.json');if(!existsSync(path))return; // Public snapshot intentionally omits this file.
 const seed=readFileSync(path,'utf8');expect(seed).not.toContain('/Users/');expect(seed).not.toMatch(/token|password|service_role|secret/i);
});

// The OPS repository was renamed on GitHub (AgentsToZ-Control → AgentsToZ-OPS, same node id).
// A restore now lands in <parent>/AgentsToZ-OPS, reuses a clone that is already there under
// either name, and accepts an origin that already follows the rename.
function renamedRestoreFixture(options:{remoteUrl?:string;remoteIds?:Record<string,string>}={}){
 const root=mkdtempSync(join(tmpdir(),'control-restore-renamed-'));dirs.push(root);const app=join(root,'AgentsToZ_byCS'),data=join(root,'data');
 mkdirSync(join(app,'src'),{recursive:true});mkdirSync(data);writeFileSync(join(app,'api-server.ts'),'');writeFileSync(join(app,'src/App.tsx'),'');writeFileSync(join(app,'package.json'),JSON.stringify({name:'AgentsToZ_byCS'}));
 const seed={schemaVersion:1,profileId:randomUUID(),memoryId:randomUUID(),repositoryUrl:'https://github.com/test-owner/AgentsToZ-Control.git',repositoryNodeId:'R_verified'};
 mkdirSync(join(app,'.agentstoz-private'));writeFileSync(join(app,CONTROL_PROFILE_PRIVATE_PATH),JSON.stringify(seed));
 const rows:Array<{id:string;folderPath:string;name:string}>=[{id:'app',folderPath:app,name:'AgentsToZ_byCS'}];const calls={clones:0,pulls:0,ghViews:[] as string[]};
 const clone=(folder:string,origin:string,memoryId=seed.memoryId)=>{mkdirSync(folder);Bun.spawnSync(['git','init','-q'],{cwd:folder});Bun.spawnSync(['git','remote','add','origin',origin],{cwd:folder});writeFileSync(join(folder,'CONTROL.md'),'# Control\n');initializeProjectMemory({folderPath:folder,projectName:'Control',memoryId,autoBackup:false});return folder;};
 const host=createControlProfileHost({appDataDir:data,portalDataFile:join(data,'portal.json'),gitPath:'fixture-git',ghPath:'fixture-gh',registered:async()=>rows,register:async c=>{const old=rows.find(r=>r.folderPath===c.root);if(old)return old.id;rows.push({id:'restored',name:'AgentsToZ-OPS',folderPath:c.root});return 'restored';},lease:async(_r,_l,op)=>op(),command:async(argv,cwd)=>{
  if(argv[0]==='fixture-gh'){const repo=argv[3]!;calls.ghViews.push(repo);if(repo==='test-owner/AgentsToZ-Control')return {stdout:JSON.stringify({id:'R_verified',visibility:'PRIVATE',url:options.remoteUrl??'https://github.com/test-owner/AgentsToZ-OPS'}),exitCode:0};const id=options.remoteIds?.[repo];return id?{stdout:JSON.stringify({id,visibility:'PRIVATE'}),exitCode:0}:{stdout:'',exitCode:1};}
  if(argv.includes('clone')){calls.clones++;clone(argv.at(-1)!,seed.repositoryUrl);return {stdout:'',exitCode:0};}
  const result=Bun.spawnSync(['git',...argv.slice(1)],{cwd,stdout:'pipe',stderr:'pipe'});return {stdout:result.stdout.toString(),exitCode:result.exitCode??1};
 },pullMemory:async input=>{calls.pulls++;const memory=detectProjectMemory(input.folderPath);writeMemoryDocument(memory.projectRoot,memory.memoryPath!,'# Shared Control\n\n## Operating\n\n### Keep prior decisions\n\nSame memory on both Macs.\n');return {success:true} as any;}});
 return {root,seed,rows,calls,clone,host};
}
test('a fresh restore clones into AgentsToZ-OPS and registers it under the new name',async()=>{
 const f=renamedRestoreFixture();const ready=await f.host.store.prepare();
 expect(ready.state).toBe('ready');expect(f.calls.clones).toBe(1);
 expect(f.host.store.read().binding.root).toBe(realpathSync(join(f.root,'AgentsToZ-OPS')));
 expect(existsSync(join(f.root,'AgentsToZ-Control'))).toBe(false);
 expect(f.rows.find(row=>row.id==='restored')?.name).toBe('AgentsToZ-OPS');
 // Cloned from the seed URL, so its origin already yields the lineage's key: nothing is pinned.
 expect(Bun.spawnSync(['git','config','--local','--get','agentstoz.repositoryKey'],{cwd:join(f.root,'AgentsToZ-OPS')}).exitCode).not.toBe(0);
});
test('restore reuses a legacy AgentsToZ-Control clone of the same repository and memory instead of cloning again',async()=>{
 const f=renamedRestoreFixture();const legacy=f.clone(join(f.root,'AgentsToZ-Control'),f.seed.repositoryUrl);
 const ready=await f.host.store.prepare();
 expect(ready.state).toBe('ready');expect(f.calls.clones).toBe(0);
 expect(f.host.store.read().binding.root).toBe(realpathSync(legacy));
 expect(existsSync(join(f.root,'AgentsToZ-OPS'))).toBe(false);
});
test('restore accepts an existing AgentsToZ-OPS clone whose origin already follows the GitHub rename',async()=>{
 const f=renamedRestoreFixture();const renamed=f.clone(join(f.root,'AgentsToZ-OPS'),'git@github.com:test-owner/AgentsToZ-OPS.git');
 const ready=await f.host.store.prepare();
 expect(ready.state).toBe('ready');expect(f.calls.clones).toBe(0);
 expect(f.host.store.read().binding.root).toBe(realpathSync(renamed));
 // The memory lineage keeps the repository key it was created under (see projectRepositoryKey).
 expect(Bun.spawnSync(['git','config','--local','--get','agentstoz.repositoryKey'],{cwd:renamed}).stdout.toString().trim()).toBe('https://github.com/test-owner/agentstoz-control');
});
test('an origin GitHub resolves to the same node id is accepted; another repository is never adopted',async()=>{
 const same=renamedRestoreFixture({remoteIds:{'test-owner/ops-archive':'R_verified'}});same.clone(join(same.root,'AgentsToZ-OPS'),'https://github.com/test-owner/ops-archive.git');
 expect((await same.host.store.prepare()).state).toBe('ready');expect(same.calls.clones).toBe(0);expect(same.calls.ghViews).toContain('test-owner/ops-archive');
 const other=renamedRestoreFixture({remoteIds:{'test-owner/someone-else':'R_other'}});const foreign=other.clone(join(other.root,'AgentsToZ-OPS'),'https://github.com/test-owner/someone-else.git');
 const blocked=await other.host.store.prepare();
 expect(blocked.state).toBe('needs-attention');expect(other.calls.clones).toBe(0);expect(other.calls.pulls).toBe(0);
 expect(readFileSync(join(foreign,'CONTROL.md'),'utf8')).toBe('# Control\n');
});
test('a legacy clone bound to another memory is left alone and the restore clones into AgentsToZ-OPS',async()=>{
 const f=renamedRestoreFixture();const legacy=f.clone(join(f.root,'AgentsToZ-Control'),f.seed.repositoryUrl,randomUUID());
 const ready=await f.host.store.prepare();
 expect(ready.state).toBe('ready');expect(f.calls.clones).toBe(1);
 expect(f.host.store.read().binding.root).toBe(realpathSync(join(f.root,'AgentsToZ-OPS')));
 expect(existsSync(legacy)).toBe(true);
});
test('a registered folder under either OPS name is an existing Control candidate',async()=>{
 for(const name of ['AgentsToZ-Control','AgentsToZ-OPS']){
  const dir=mkdtempSync(join(tmpdir(),'control-candidate-'));dirs.push(dir);const root=join(dir,name);mkdirSync(root);writeFileSync(join(root,'CONTROL.md'),'Control');
  initializeProjectMemory({folderPath:root,projectName:'Control',agent:'codex',autoBackup:false});
  const host=createControlProfileHost({appDataDir:join(dir,'data'),portalDataFile:join(dir,'portal.json'),gitPath:'git',ghPath:'gh',registered:async()=>[{id:'control',name:'운영본부',folderPath:root}],register:async()=> 'control',lease:async(_r,_l,op)=>op()});
  const ready=await host.prepare();expect(ready.state).toBe('ready');expect(ready.projectId).toBe('control');expect(ready.backend).toBe('control-folder');
 }
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

// 2호 실측(2026-10-05): 다른 이름으로 clone한 앱 소스는 복원 seed를 찾지 못해 **조용히 새
// profileId**가 생겼다 — 그 Mac이 자기만의 운영 프로필·커뮤니티 방을 들고 고아가 된다.
// 신뢰 경계는 폴더 이름이 아니라 앱 소스의 내용이다.
test('a differently named app-source clone still finds the seeded profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-seed-name-')); dirs.push(root);
  // 이름이 `AgentsToZ_byCS`도 `AgentsToZ_public`도 아니다 — 예전 판정이 건너뛰던 바로 그 모양.
  const app = join(root, 'AgentsToZ_byCS-win'), data = join(root, 'data');
  mkdirSync(join(app, 'src'), {recursive: true}); mkdirSync(data);
  writeFileSync(join(app, 'api-server.ts'), ''); writeFileSync(join(app, 'src/App.tsx'), '');
  writeFileSync(join(app, 'package.json'), JSON.stringify({name: 'AgentsToZ_byCS'}));
  const seed = {schemaVersion: 1, profileId: randomUUID(), memoryId: randomUUID(),
    repositoryUrl: 'https://github.com/test-owner/Control.git', repositoryNodeId: 'R_verified'};
  mkdirSync(join(app, '.agentstoz-private'));
  writeFileSync(join(app, CONTROL_PROFILE_PRIVATE_PATH), JSON.stringify(seed));
  // 내용 검사를 통과하지 못하는 폴더의 seed 파일은 여전히 읽지 않는다(이름만 그럴듯한 경우).
  const decoy = join(root, 'AgentsToZ_byCS-decoy'); mkdirSync(join(decoy, '.agentstoz-private'), {recursive: true});
  writeFileSync(join(decoy, CONTROL_PROFILE_PRIVATE_PATH), JSON.stringify({...seed, profileId: randomUUID()}));
  const rows: Array<{id: string; folderPath: string; name: string}> = [
    {id: 'app', folderPath: app, name: '아젠투지 2호'}, {id: 'decoy', folderPath: decoy, name: 'decoy'}];
  const host = createControlProfileHost({appDataDir: data, portalDataFile: join(data, 'portal.json'),
    gitPath: 'fixture-git', ghPath: 'fixture-gh', registered: async () => rows,
    register: async c => {const old = rows.find(r => r.folderPath === c.root); if (old) return old.id;
      rows.push({id: 'restored', name: 'AgentsToZ-OPS', folderPath: c.root}); return 'restored';},
    lease: async (_r, _l, op) => op(),
    command: async argv => {
      if (argv[0] === 'fixture-gh') return {stdout: JSON.stringify({id: 'R_verified', visibility: 'PRIVATE'}), exitCode: 0};
      if (argv.includes('clone')) {
        const stage = argv.at(-1)!; mkdirSync(stage); Bun.spawnSync(['git', 'init', '-q'], {cwd: stage});
        writeFileSync(join(stage, 'CONTROL.md'), '# Control\n');
        initializeProjectMemory({folderPath: stage, projectName: 'Control', memoryId: seed.memoryId, autoBackup: false});
        return {stdout: '', exitCode: 0};
      }
      return {stdout: seed.repositoryUrl, exitCode: 0};
    },
    pullMemory: async input => {
      const memory = detectProjectMemory(input.folderPath);
      writeMemoryDocument(memory.projectRoot, memory.memoryPath!, '# Shared Control\n\n## Operating\n\n### Kept\n\nSame lineage.\n');
      return {success: true} as any;
    }});
  const prepared = await host.store.prepare();
  expect(prepared.state).toBe('ready');
  expect(prepared.profileId).toBe(seed.profileId);
  expect(prepared.memoryId).toBe(seed.memoryId);
});

test('two app sources with different seeds stop instead of guessing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-seed-ambiguous-')); dirs.push(root);
  const data = join(root, 'data'); mkdirSync(data);
  const rows: Array<{id: string; folderPath: string; name: string}> = [];
  for (const name of ['AgentsToZ_byCS', 'AgentsToZ_byCS-second']) {
    const app = join(root, name);
    mkdirSync(join(app, 'src'), {recursive: true}); mkdirSync(join(app, '.agentstoz-private'));
    writeFileSync(join(app, 'api-server.ts'), ''); writeFileSync(join(app, 'src/App.tsx'), '');
    writeFileSync(join(app, 'package.json'), JSON.stringify({name: 'AgentsToZ_byCS'}));
    writeFileSync(join(app, CONTROL_PROFILE_PRIVATE_PATH), JSON.stringify({schemaVersion: 1,
      profileId: randomUUID(), memoryId: randomUUID(), repositoryUrl: 'https://github.com/test-owner/Control.git',
      repositoryNodeId: 'R_verified'}));
    rows.push({id: name, folderPath: app, name});
  }
  const host = createControlProfileHost({appDataDir: data, portalDataFile: join(data, 'portal.json'),
    gitPath: 'fixture-git', ghPath: 'fixture-gh', registered: async () => rows,
    register: async () => 'restored', lease: async (_r, _l, op) => op(),
    command: async () => ({stdout: '', exitCode: 0})});
  // 준비는 거절을 던지지 않고 상태로 말한다 — 중요한 것은 **새 프로필을 만들지 않는다**는 쪽이다.
  const prepared = await host.store.prepare();
  expect(prepared.state).toBe('needs-attention');
  expect(prepared.problem).toContain('서로 다른 OPS 운영 폴더 복원 정보');
  expect(existsSync(join(data, 'control-profile', 'binding.json'))).toBe(false);
});
