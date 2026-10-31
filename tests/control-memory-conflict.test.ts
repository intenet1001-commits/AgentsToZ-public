import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createControlProfileHost} from '../control-profile-server';
import {initializeProjectMemory,detectProjectMemory,readMemoryDocument,previewProjectMemoryConflict,resolveProjectMemoryConflict} from '../project-memory-server';

const roots:string[]=[];afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ops-conflict-'));roots.push(dir);const root=join(dir,'AgentsToZ-OPS');mkdirSync(root);writeFileSync(join(root,'CONTROL.md'),'Control');
 initializeProjectMemory({folderPath:root,projectName:'Control',agent:'codex',autoBackup:true});
 const memory=detectProjectMemory(root),before=readMemoryDocument(root,memory.memoryPath!),calls:any[]=[];
 const host=createControlProfileHost({appDataDir:join(dir,'data'),portalDataFile:join(dir,'portal.json'),gitPath:'git',ghPath:'gh',registered:async()=>[{id:'ops',name:'AgentsToZ-OPS',folderPath:root}],register:async()=> 'ops',lease:async(_r,_l,op)=>op(),pullMemory:async()=>({success:false}) as any,
  previewConflict:async input=>{calls.push({preview:input});return {memoryId:memory.config!.memoryId,conflict:true,localContent:before,remoteContent:before+'\nRemote',localContentHash:'a'.repeat(64),remoteContentHash:'b'.repeat(64),remoteRevisionId:'11111111-1111-4111-8111-111111111111'} as any;},
  resolveConflict:async input=>{calls.push({resolve:input});return {success:true,strategy:input.strategy} as any;}});
 const status=await host.prepare();return {host,root,calls,before,memory,base:{expectedProfileId:status.profileId,expectedMemoryId:status.memoryId}};
}
describe('local OPS memory conflict review',()=>{
 test('a changed remote identity or stale reviewed version never claims, repairs or rewrites config',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ops-reviewed-identity-'));roots.push(root);
  const local=initializeProjectMemory({folderPath:root,projectName:'Review',agent:'codex',autoBackup:false}),memoryId=local.config!.memoryId;
  const configPath=join(root,'.agent-memory/config.json'),config=readFileSync(configPath,'utf8'),document=readMemoryDocument(root,local.memoryPath!);
  const content='# Project Core Memory\nRemote content',contentHash=createHash('sha256').update(content).digest('hex'),requests:string[]=[];let alias=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;requests.push(req.method+' '+path);
   if(path.endsWith('portmgr_project_memory_aliases'))return Response.json(alias?{canonical_memory_id:'other-memory'}:null);
   if(path.endsWith('portmgr_project_memories'))return Response.json({memory_id:memoryId,canonical_repo_key:null});
   return Response.json([{id:'11111111-1111-4111-8111-111111111111',memory_id:memoryId,content,content_hash:contentHash}]);
  }});
  const portalDataFile=join(root,'portal.json');writeFileSync(portalDataFile,JSON.stringify({supabaseUrl:`http://127.0.0.1:${server.port}`,supabaseAnonKey:'fixture'}));
  try{
   expect((await previewProjectMemoryConflict({folderPath:root,portalDataFile})).conflict).toBe(true);
   const input={folderPath:root,portalDataFile,strategy:'keep-local' as const,expectedMemoryId:memoryId,expectedLocalHash:'0'.repeat(64),expectedRemoteRevisionId:'11111111-1111-4111-8111-111111111111',expectedRemoteContentHash:contentHash};
   expect((await resolveProjectMemoryConflict(input)).success).toBe(false);
   alias=true;await expect(resolveProjectMemoryConflict(input)).rejects.toThrow('기억 연결이 바뀌었습니다');
   expect(requests.every(r=>r.startsWith('GET '))).toBe(true);expect(requests.some(r=>r.includes('/rpc/'))).toBe(false);
   expect(readFileSync(configPath,'utf8')).toBe(config);expect(readMemoryDocument(root,local.memoryPath!)).toBe(document);
  }finally{server.stop(true);}
 });
 test('a preview compares the bound memory without changing local files or resolving it',async()=>{
  const f=await fixture(),r=await f.host.conflict({...f.base,operation:'preview'});
  expect(r.comparison?.memoryId).toBe(f.base.expectedMemoryId!);
  expect(f.calls).toHaveLength(1);expect(f.calls[0].preview.folderPath).toBe(realpathSync(f.root));
  expect(readMemoryDocument(f.root,f.memory.memoryPath!)).toBe(f.before);
 });
 test('paths, other profiles, missing review and forged versions cannot dispatch a resolution',async()=>{
  const f=await fixture();
  for(const extra of [{folderPath:'/other'},{expectedMemoryId:'other'},{expectedProfileId:'other'}])await expect(f.host.conflict({...f.base,operation:'preview',...extra})).rejects.toThrow();
  await expect(f.host.conflict({...f.base,operation:'resolve',strategy:'keep-local'})).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
 });
 test('a reviewed choice forwards both displayed versions to the existing CAS resolver',async()=>{
  const f=await fixture();await f.host.conflict({...f.base,operation:'resolve',strategy:'merged',mergedContent:f.before,reviewed:true,expectedLocalHash:'a'.repeat(64),expectedRemoteContentHash:'b'.repeat(64),expectedRemoteRevisionId:'11111111-1111-4111-8111-111111111111'});
  expect(f.calls).toHaveLength(1);expect(f.calls[0].resolve).toMatchObject({folderPath:realpathSync(f.root),expectedLocalHash:'a'.repeat(64),expectedRemoteContentHash:'b'.repeat(64),strategy:'merged',mergedContent:f.before});
 });
});
