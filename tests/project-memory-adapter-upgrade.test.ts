import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectMemory,upgradeProjectMemoryAdapters} from '../project-memory-server';
import {projectMemoryApi} from '../src/ProjectMemoryPanel';
import {CURRENT_PROJECT_MEMORY_VERSION} from '../src/projectMemoryVersion';
import {startTestApiServer} from './startTestApiServer';
import {resolveAppDataDir} from '../src/appDataDir';
const roots:string[]=[];const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'atz-adapters-only-'));roots.push(root);const s=initializeProjectMemory({folderPath:root,autoBackup:false});const core=join(root,s.config!.sourcePath),config=join(root,'.agent-memory/config.json'),journal=join(root,'.agent-memory/journal');
 const legacy=Buffer.from('# Project Core Memory\r\n\r\n## Key Decisions\r\n### Same\r\nOriginal one.\r\n### Same\r\n<!-- memory-entry-id:bad -->\r\nOriginal two.\r\n');writeFileSync(core,legacy);
 return {root,core,config,journal,legacy};}
test('adapter-only upgrade preserves exact legacy bytes, config, journal and remembered baseline',()=>{
 const f=fixture(),beforeConfig=readFileSync(f.config),beforeJournal=readdirSync(f.journal).map(n=>[n,readFileSync(join(f.journal,n)).toString('base64')]);
 const path=join(f.root,'AGENTS.md');writeFileSync(path,readFileSync(path,'utf8').replaceAll(`memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`, 'memory-agent-version:29'));
 for(let i=0;i<2;i++){
  const result=upgradeProjectMemoryAdapters({folderPath:f.root});expect(result.upgraded).toBe(true);expect(result.entryIdsStabilized).toBe(false);expect(result.memoryAgent.adaptersVersion).toBe(CURRENT_PROJECT_MEMORY_VERSION);expect(result.memoryAgent.adaptersUpdateAvailable).toBe(false);expect(result.memoryAgent.memoryContentReady).toBe(false);expect(result.memoryAgent.updateAvailable).toBe(true);
  expect(readFileSync(f.core).equals(f.legacy)).toBe(true);expect(readFileSync(f.config).equals(beforeConfig)).toBe(true);expect(readdirSync(f.journal).map(n=>[n,readFileSync(join(f.journal,n)).toString('base64')])).toEqual(beforeJournal);
 }
});
test('a new client on an old host fails without falling back to the document-migrating route',async()=>{
 const calls:string[]=[];globalThis.fetch=(async input=>{calls.push(String(input));return Response.json({error:'Not found'},{status:404});}) as typeof fetch;
 await expect(projectMemoryApi.upgradeAgent({folderPath:'/synthetic/registered-project'})).rejects.toThrow();expect(calls).toHaveLength(1);expect(calls[0]).toEndWith('/api/project-memory/upgrade-adapters');
});
test('installed-style HTTP route updates only adapters and preserves content through the client transport',async()=>{
 const f=fixture(),home=mkdtempSync(join(tmpdir(),'atz-adapter-api-home-'));roots.push(home);
 const env={...process.env,HOME:home,APPDATA:join(home,'AppData/Roaming'),XDG_CONFIG_HOME:join(home,'.config')};const data=resolveAppDataDir(process.platform,env,home);mkdirSync(data,{recursive:true});writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'adapter-only-demo',name:'Adapter-only QA',folderPath:f.root}]));
 const api=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});
 try{const r=await originalFetch(api.baseUrl+'/api/project-memory/upgrade-adapters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderPath:f.root})});const d=await r.json() as any;expect(r.status).toBe(200);expect(d.upgraded).toBe(true);expect(d.entryIdsStabilized).toBe(false);expect(readFileSync(f.core).equals(f.legacy)).toBe(true);
 const send=(path:string,body:unknown)=>originalFetch(api.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 // The backlog tracks generated artifacts, never a legacy document that this action cannot repair.
 const scan=await (await send('/api/upgrade-status',{folderPaths:[f.root]})).json() as any;expect(scan.memory).toEqual([]);
 const agents=join(f.root,'AGENTS.md');writeFileSync(agents,readFileSync(agents,'utf8').replaceAll(`memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`,'memory-agent-version:29'));
 const outdated=await (await send('/api/upgrade-status',{folderPaths:[f.root]})).json() as any;expect(outdated.memory).toHaveLength(1);
 const baseline=readFileSync(f.config),journal=readdirSync(f.journal);
 const batch=await (await send('/api/upgrade-batch',{target:'memory',folderPaths:[f.root]})).json() as any;expect(batch.upgraded).toBe(1);expect(batch.failed).toBe(0);
 expect(readFileSync(f.core).equals(f.legacy)).toBe(true);expect(readFileSync(f.config).equals(baseline)).toBe(true);expect(readdirSync(f.journal)).toEqual(journal);
 const done=await (await send('/api/upgrade-status',{folderPaths:[f.root]})).json() as any;expect(done.memory).toEqual([]);
 }finally{api.child.kill();await api.child.exited;}
});
