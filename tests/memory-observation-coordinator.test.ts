import {expect,test,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {MemoryObservationCoordinator,type MemoryObservationProject,type MemoryObservationCandidate} from '../src/memoryObservationCoordinator';
import {MemoryObservationDiscovery,memoryObservationInstanceId} from '../src/memoryObservationDiscovery';
import {claudeProjectSlugCandidates} from '../src/sessionTranscript';
import {startTestApiServer} from './startTestApiServer';
const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const project=(id:string)=>({id,projectRoot:`/projects/${id}`});
const candidate=(key:string,stamp='1'):MemoryObservationCandidate=>({key,stamp,agent:'codex',path:`/transcripts/${key}`,transcriptRoot:'/transcripts',sessionId:key});
const result=(reason:'observed'|'more'|'source-invalid'='observed')=>({reason,observed:1,offset:1,reset:false,bytesRead:1});
function setup(projects=[project('a'),project('b')]){
 let now=0;const visits:string[]=[];
 const deps={enabled:()=>true,projects:async()=>projects,resolve:async(p:MemoryObservationProject)=>({...p,memoryId:p.id,validateRegistration:async()=>true}),
 discover:async(p:MemoryObservationProject)=>[candidate(p.id)],observe:async(p:MemoryObservationProject)=>{visits.push(p.id);return result();},now:()=>now};
 return {deps,visits,advance:(ms=61000)=>{now+=ms;},coordinator:new MemoryObservationCoordinator(deps)};
}

test('Workroom hints alternate with regular project rotation and cannot starve another root',async()=>{
 const f=setup([project('a'),project('b'),project('c')]);
 for(let i=0;i<8;i++){f.coordinator.request('/projects/a');await f.coordinator.tick();f.advance();}
 expect(f.visits).toContain('b');expect(f.visits).toContain('c');
 expect(f.visits.filter(id=>id==='a').length).toBeGreaterThan(1);
});

test('one running tick is shared and shutdown during registration prevents observation',async()=>{
 const f=setup();let release!:()=>void;let entered=0;
 f.deps.discover=async()=>{entered++;await new Promise<void>(resolve=>{release=resolve;});return [candidate('a')];};
 const pending=f.coordinator.tick();while(!release)await Bun.sleep(1);
 await f.coordinator.tick();expect(entered).toBe(1);f.deps.enabled=()=>false;release();await pending;
 expect(f.visits).toHaveLength(0);await f.coordinator.tick();expect(f.coordinator.status().queuedHints).toBe(0);
});

test('changed sources wake idle backoff while invalid sources are isolated by project identity',async()=>{
 const f=setup();let stamp='1';f.deps.discover=async()=>[candidate('shared',stamp)];
 f.deps.observe=async p=>{f.visits.push(p.id);return result(p.id==='a'?'source-invalid':'observed');};
 await f.coordinator.tick();await f.coordinator.tick();expect(f.visits).toEqual(['a','b']);
 await f.coordinator.tick();expect(f.visits).toHaveLength(2);
 stamp='2';await f.coordinator.tick();expect(f.visits).toHaveLength(3);
});

test('invalid roots back off and bounded hints/status caches contain no transcript paths',async()=>{
 const f=setup([project('a')]);let resolves=0;f.deps.resolve=async()=>{resolves++;throw new Error('private source failure');};
 for(let i=0;i<1000;i++)f.coordinator.request(`/not-registered/${i}`);
 expect(f.coordinator.status().queuedHints).toBe(64);await f.coordinator.tick();await f.coordinator.tick();expect(resolves).toBe(1);
 expect(JSON.stringify(f.coordinator.status())).not.toContain('private source');expect(f.coordinator.status().queuedHints).toBe(0);
 f.advance(300001);await f.coordinator.tick();expect(resolves).toBe(2);
});

test('source selection rotates through backlog rather than repeating a single large transcript',async()=>{
 const f=setup([project('a')]);const visited:string[]=[];
 f.deps.discover=async()=>[candidate('first'),candidate('second')];
 f.deps.observe=async(_p,source?:any)=>{visited.push(source.key);return result('more');};
 await f.coordinator.tick();await f.coordinator.tick();expect(visited).toEqual(['first','second']);
});

test('a Workroom agent hint observes its newest session ahead of old hashes and another active agent',async()=>{
 const f=setup([project('a'),project('b')]);const visited:string[]=[];
 const old={...candidate('a-old','100:100'),agent:'claude' as const};
 const recent={...candidate('z-new','100:200'),agent:'claude' as const};
 const other=candidate('b-active-codex','100:300');
 f.deps.discover=async()=>[old,other,recent];
 f.deps.observe=async(p,source?:any)=>{visited.push(`${p.id}:${source.key}`);return result();};
 f.coordinator.request('/projects/a','claude');
 f.coordinator.request('/projects/a'); // a continuation cannot downgrade the hint
 await f.coordinator.tick();expect(visited[0]).toBe('a:z-new');
 // Normal rotation still visits older sources and other projects.
 await f.coordinator.tick();expect(visited[1]).toBe('a:a-old');
 f.coordinator.request('/projects/a','claude');await f.coordinator.tick();
 await f.coordinator.tick();expect(visited.some(v=>v.startsWith('b:'))).toBe(true);
});

test('a completed Workroom source with a changed stamp wakes its prior incomplete backoff',async()=>{
 const f=setup([project('a')]);const visited:string[]=[];let stamp='100:200';
 f.deps.discover=async()=>[{...candidate('z-live',stamp),agent:'claude' as const},candidate('a-old','100:100')];
 f.deps.observe=async(_p,source?:any)=>{visited.push(source.key);return {...result(),reason:'incomplete'} as any;};
 f.coordinator.request('/projects/a','claude');await f.coordinator.tick();
 await f.coordinator.tick();stamp='200:300';
 f.coordinator.request('/projects/a','claude');await f.coordinator.tick();
 expect(visited).toEqual(['z-live','a-old','z-live']);
});

test('disabling during the final registration check prevents a late observation',async()=>{
 const f=setup();let release!:()=>void;
 f.deps.resolve=async p=>({...p,memoryId:p.id,validateRegistration:async()=>{await new Promise<void>(r=>{release=r;});return true;}});
 const pending=f.coordinator.tick();while(!release)await Bun.sleep(1);f.deps.enabled=()=>false;release();await pending;
 expect(f.visits).toHaveLength(0);
});

test('long-running project rotation retains only bounded scheduling caches',async()=>{
 const f=setup(Array.from({length:600},(_,i)=>project(`project-${String(i).padStart(4,'0')}`)));
 for(let i=0;i<600;i++)await f.coordinator.tick();
 expect(f.visits).toHaveLength(600);expect(f.coordinator.status().trackedProjects).toBeLessThanOrEqual(128);
 expect(f.coordinator.status().trackedSources).toBeLessThanOrEqual(256);
});

test('discovery validates bounded Codex headers and preserves both Claude slug candidates',async()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-discovery-'));roots.push(root);
 const codexRoot=join(root,'codex'),claudeRoot=join(root,'claude'),cwd=join(root,'한글_project');mkdirSync(codexRoot);mkdirSync(cwd);
 const files:Array<{full:string;size:number;mtimeMs:number}>=[];
 for(const [name,header] of [['owned',{id:'owned',cwd,source:'cli'}],['foreign',{id:'foreign',cwd:root,source:'cli'}],['agent',{id:'agent',cwd,source:{subagent:'review'}}]] as const){
  const full=join(codexRoot,`${name}.jsonl`);const text=JSON.stringify({type:'session_meta',payload:header})+'\n';writeFileSync(full,text);files.push({full,size:Buffer.byteLength(text),mtimeMs:1});
 }
 for(const [i,slug] of claudeProjectSlugCandidates(cwd).entries()){const path=join(claudeRoot,slug);mkdirSync(path,{recursive:true});writeFileSync(join(path,`claude-${i}.jsonl`),'{}\n');}
 const discovery=new MemoryObservationDiscovery({codexRoot,claudeRoot,codexFiles:async()=>files});
 const candidates=await discovery.discover(cwd);
 expect(candidates.filter(c=>c.agent==='codex').map(c=>c.sessionId)).toEqual(['owned']);
 expect(candidates.filter(c=>c.agent==='claude')).toHaveLength(claudeProjectSlugCandidates(cwd).length);
});

test('installation observation identity survives restarts and does not replace corrupt or lost identity',()=>{
 const root=mkdtempSync(join(tmpdir(),'observation-identity-'));roots.push(root);const path=join(root,'instance.id');
 const first=memoryObservationInstanceId(path);expect(memoryObservationInstanceId(path)).toBe(first);
 writeFileSync(path,'corrupt');expect(()=>memoryObservationInstanceId(path)).toThrow();expect(readFileSync(path,'utf8')).toBe('corrupt');
 rmSync(path);expect(()=>memoryObservationInstanceId(path,()=>true)).toThrow('recovery');expect(existsSync(path)).toBe(false);
 const outside=join(root,'outside');writeFileSync(outside,'unchanged');symlinkSync(outside,path);expect(()=>memoryObservationInstanceId(path)).toThrow();expect(readFileSync(outside,'utf8')).toBe('unchanged');
});

test('header budget exhaustion resumes discovery through cached metadata without a negative cache trap',async()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-discovery-budget-'));roots.push(root);
 const cwd=join(root,'project');mkdirSync(cwd);
 const files:Array<{full:string;size:number;mtimeMs:number}>=[];
 for(let i=0;i<12;i++){
  const full=join(root,`${i}.jsonl`);const text=JSON.stringify({type:'session_meta',payload:{id:`session-${i}`,cwd,source:'cli',padding:'p'.repeat(i===0?300000:235000)}})+'\n';
  writeFileSync(full,text);files.push({full,size:Buffer.byteLength(text),mtimeMs:1});
 }
 const discovery=new MemoryObservationDiscovery({codexRoot:root,claudeRoot:join(root,'absent'),codexFiles:async()=>files});
 const first=await discovery.discover(cwd);expect(first.length).toBeLessThan(11);
 const second=await discovery.discover(cwd);expect(second).toHaveLength(11);
 expect(second.some(source=>source.sessionId==='session-0')).toBe(false);
});

test('installed-sidecar startup observes a registered fixture with AI opt-in off and leaves canonical memory untouched',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'observation-api-')));roots.push(root);
 const home=join(root,'home'),appData=join(root,'app-data'),cwd=join(root,'project');mkdirSync(home);mkdirSync(appData);mkdirSync(join(cwd,'.agent-memory'),{recursive:true});
 const memoryId='9ff58f05-d394-4e77-abf2-eb452d9c3322';
 writeFileSync(join(cwd,'.agent-memory/config.json'),JSON.stringify({schemaVersion:1,memoryId,sourcePath:'.agent-memory/CORE.md',agent:'codex',autoBackup:false}));
 const core='# Project Core Memory\n\n## Decisions\nUnchanged fixture.\n';writeFileSync(join(cwd,'.agent-memory/CORE.md'),core);
 writeFileSync(join(appData,'ports.json'),JSON.stringify([{id:'fixture-project',name:'fixture',folderPath:cwd}]));
 const transcripts=join(home,'.codex','sessions');mkdirSync(transcripts,{recursive:true});
 const line=(row:unknown)=>JSON.stringify(row)+'\n';const timestamp='2026-09-08T01:00:00Z';
 writeFileSync(join(transcripts,'fixture.jsonl'),line({type:'session_meta',payload:{id:'session-fixture',cwd,source:'cli'}})
  +line({type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn-fixture'}})
  +line({type:'event_msg',timestamp,payload:{type:'user_message',message:'fixture only'}})
  +line({type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn-fixture'}}));
 const env={...process.env,HOME:home,APP_DATA_DIR:appData,APPDATA:join(home,'AppData','Roaming'),XDG_CONFIG_HOME:join(home,'.config'),
  AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1',PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),
  PORTMGR_WHAT_I_SAID_CAPABILITY:'a'.repeat(64),PORTMGR_REMOTE_CONTROL_CAPABILITY:'b'.repeat(64),PORTMGR_AGENT_RUNTIME_CAPABILITY:'c'.repeat(64)};
 const server=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});
 const output=new Response(server.child.stdout as ReadableStream).text();const errors=new Response(server.child.stderr as ReadableStream).text();
 try{
  const dbPath=join(appData,'memory-save-v2.sqlite');let observed=0;
  for(let i=0;i<150;i++){
   if(existsSync(dbPath)){const db=new Database(dbPath);try{observed=(db.query('SELECT COUNT(*) AS n FROM save_sources').get() as {n:number}).n;}catch{}finally{db.close();}}
   if(observed)break;await Bun.sleep(50);
  }
  expect(observed).toBe(1);const db=new Database(dbPath);expect(db.query('SELECT * FROM save_jobs').all()).toHaveLength(0);db.close();
  expect(readFileSync(join(cwd,'.agent-memory/CORE.md'),'utf8')).toBe(core);
  expect((await fetch(`${server.baseUrl}/api/health`)).ok).toBe(true);
  const statusRequest=(body:unknown,authorized=true)=>fetch(`${server.baseUrl}/api/agent-runtime/terminals/memory`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://tauri.localhost',...(authorized?{'X-AgentsToZ-Agent-Runtime-Capability':'c'.repeat(64)}:{})},body:JSON.stringify(body)});
  expect((await statusRequest({observationTargetId:'fixture-project'},false)).ok).toBe(false);
  const status=await statusRequest({observationTargetId:'fixture-project'});expect(status.ok).toBe(true);
  const statusBody=await status.json() as any;expect(statusBody.observation).toEqual({version:1,targetId:'fixture-project',state:'available',completedTurns:1,hasMore:false,conversationMemory:'not-connected'});
  expect(JSON.stringify(statusBody.observation)).not.toContain(cwd);expect(JSON.stringify(statusBody.observation)).not.toContain(memoryId);
  const keyRequest={keyOperation:'status',observationTargetId:'fixture-project'};
  expect((await statusRequest(keyRequest,false)).ok).toBe(false);
  const keyStatus=await (await statusRequest(keyRequest)).json() as any;
  expect(keyStatus).toEqual({version:1,targetId:'fixture-project',keyStatus:process.platform==='darwin'?'not-configured':'unsupported',automaticSavingChanged:false});
  expect(existsSync(join(appData,'memory-save-key.json'))).toBe(false);
  expect((await statusRequest({...keyRequest,key:'forbidden'})).status).toBe(400);
  expect((await statusRequest({...keyRequest,offset:0})).status).toBe(400);
  expect((await statusRequest({observationTargetId:cwd})).status).toBe(400);
  expect((await statusRequest({observationTargetId:'fixture-project',memoryId})).status).toBe(400);
  writeFileSync(join(appData,'ports.json'),'[]');
  const removed=await (await statusRequest({observationTargetId:'fixture-project'})).json() as any;
  expect(removed.observation.state).toBe('unavailable');expect(removed.observation.completedTurns).toBe(0);
 }finally{server.child.kill();await server.child.exited;await output;await errors;}
},20000);
