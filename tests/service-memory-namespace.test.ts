import {afterEach,expect,test} from 'bun:test';
import {appendFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureServiceMemory,inspectServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'use-namespace-')));roots.push(root);
 const canonicalPath=join(root,'project'),appData=join(root,'app-data');mkdirSync(canonicalPath);
 mkdirSync(join(canonicalPath,'.agent-memory'));
 const devConfig=join(canonicalPath,'.agent-memory','config.json');writeFileSync(devConfig,'{"memoryId":"dev-original","sourcePath":"CORE.md"}\n');
 const identity={projectId:'project-namespace',projectMemoryId:'dev-original',serviceKey:'default'};
 const {record}=ensureServiceMemory(appData,{...identity,projectName:'Example',canonicalPath,displayName:'Example USE'});
 appendFileSync(record.sourcePath,'\nExisting operating preference\n');
 return {root,appData,canonicalPath,devConfig,identity,legacy:record,before:readFileSync(record.sourcePath,'utf8')};
}
test('USE namespace cutover retains identity and content, preserves DEV and aliases the existing Buzz paths',()=>{
 const f=fixture(),dev=readFileSync(f.devConfig,'utf8');
 expect(Bun.spawnSync(['git','init','-q'],{cwd:f.canonicalPath}).exitCode).toBe(0);
 const result=migrateServiceMemoryToProject(f.appData,f.identity);
 expect(result.record.serviceMemoryId).toBe(f.legacy.serviceMemoryId);
 expect(result.record.sourcePath).toBe(join(f.canonicalPath,'.agent-memory-use','default','CORE.md'));
 expect(readFileSync(result.record.sourcePath,'utf8')).toBe(f.before);
 expect(readFileSync(f.devConfig,'utf8')).toBe(dev);
 expect(readlinkSync(f.legacy.sourcePath)).toBe(result.record.sourcePath);
 expect(readFileSync(f.legacy.sourcePath+'.pre-project-v1','utf8')).toBe(f.before);
 appendFileSync(result.record.sourcePath,'\nNew verified knowledge\n');
 expect(readFileSync(f.legacy.sourcePath,'utf8')).toContain('New verified knowledge');
 expect(inspectServiceMemory(f.appData,f.identity).ready).toBe(true);
 expect(migrateServiceMemoryToProject(f.appData,f.identity)).toMatchObject({migrated:false,transitionId:result.transitionId});
 const git=Bun.spawnSync(['git','status','--porcelain','--untracked-files=all'],{cwd:f.canonicalPath});expect(git.exitCode).toBe(0);expect(git.stdout.toString()).not.toContain('.agent-memory-use');
});
for(const checkpoint of ['prepared','source-alias','config-alias','authority'] as const)test(`interrupted USE cutover at ${checkpoint} blocks execution then resumes the exact transition`,()=>{
 const f=fixture();
 expect(()=>migrateServiceMemoryToProject(f.appData,f.identity,{checkpoint:step=>{if(step===checkpoint)throw Error('power loss');}})).toThrow('power loss');
 expect(inspectServiceMemory(f.appData,f.identity).ready).toBe(false);
 const result=migrateServiceMemoryToProject(f.appData,f.identity);
 expect(result.migrated).toBe(true);expect(inspectServiceMemory(f.appData,f.identity).ready).toBe(true);
 expect(readFileSync(result.record.sourcePath,'utf8')).toBe(f.before);
});
test('concurrent legacy writes during a prepared cutover preserve both versions and refuse authority',()=>{
 const f=fixture();
 expect(()=>migrateServiceMemoryToProject(f.appData,f.identity,{checkpoint:()=>{throw Error('interrupted');}})).toThrow();
 appendFileSync(f.legacy.sourcePath,'\nBuzz finished a write\n');
 expect(()=>migrateServiceMemoryToProject(f.appData,f.identity)).toThrow('변경');
 expect(inspectServiceMemory(f.appData,f.identity).ready).toBe(false);
 expect(readFileSync(f.legacy.sourcePath,'utf8')).toContain('Buzz finished');
 expect(readFileSync(join(f.canonicalPath,'.agent-memory-use','default','CORE.md'),'utf8')).toBe(f.before);
});
test('unregistered namespace content is never overwritten or removed',()=>{
 const f=fixture(),dir=join(f.canonicalPath,'.agent-memory-use','default');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'CORE.md'),'other authority');
 expect(()=>migrateServiceMemoryToProject(f.appData,f.identity)).toThrow('덮어쓰지');
 expect(readFileSync(join(dir,'CORE.md'),'utf8')).toBe('other authority');expect(lstatSync(f.legacy.sourcePath).isFile()).toBe(true);
});
test('a wrong project row cannot inspect another row’s USE authority',()=>{
 const f=fixture();
 expect(()=>inspectServiceMemory(f.appData,{...f.identity,projectId:'other-project'})).toThrow('정체성');
});
test('namespace files linked to DEV authority are rejected before any cutover',()=>{
 const f=fixture();migrateServiceMemoryToProject(f.appData,f.identity);
 const source=join(f.canonicalPath,'.agent-memory-use','default','CORE.md');rmSync(source);
 const {linkSync}=require('node:fs');linkSync(f.devConfig,source);
 expect(inspectServiceMemory(f.appData,f.identity).ready).toBe(false);
 expect(existsSync(f.legacy.sourcePath+'.pre-project-v1')).toBe(true);
});
