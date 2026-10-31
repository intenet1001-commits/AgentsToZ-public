import {afterEach,describe,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {initializeProjectMemory} from '../project-memory-server';
import {configureWhatISaidCapture,captureWhatISaidPrompt,softDeleteWhatISaidEntries,whatISaidDatabasePath} from '../src/whatISaidStore';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTestApiServer} from './startTestApiServer';
import {AGENTSTOZ_USE_MCP_TOOLS,handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {CONTROL_PROFILE_HEADER,CONTROL_PROFILE_CONTROLLER} from '../src/controlProfileContract';
const children:Bun.Subprocess[]=[],dirs:string[]=[];
afterEach(async()=>{for(const c of children.splice(0)){c.kill();await c.exited;}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'control-profile-api-'));dirs.push(home);const data=join(home,'app-data');mkdirSync(data);
 const env={...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',PORTMGR_WHAT_I_SAID_TEST_KEY:'31'.repeat(32),AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1'};
 const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});children.push(child);
 const post=async(path:string,body:unknown,token?:string)=>{
  const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{[CONTROL_PROFILE_HEADER]:token}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};
 };
 return {home,data,env,baseUrl,post};
}
// '내 프로필 보여줘': the AI learns from the tool itself what to summarize and where the panel is (not the cut instructions).
test('get_control_profile describes the titles it returns and where the panel is',()=>{
 const d=AGENTSTOZ_USE_MCP_TOOLS.find(t=>t.name==='agentstoz_use_get_control_profile')!.description;
 expect(d).toContain('entryTitles');expect(d).toContain('도구 및 설정 → 아젠투지 설정');expect(d).toContain('list_ops_devices');expect(d).not.toContain('운영 프로필');
});
describe('Control profile through real API and MCP',()=>{
 test('a deletion between history pages invalidates the same snapshot without changing capture policy',async()=>{
  const f=await fixture();await f.post('/api/control-profile/prepare',{});
  const project=join(f.home,'deleted-history');mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'Deletion fixture',autoBackup:false});
  writeFileSync(join(f.data,'ports.json'),JSON.stringify([{id:'deleted-history',name:'Deletion fixture',folderPath:project}]));
  const location={appDataDir:f.data,projectRoot:project,memoryId:memory.config!.memoryId},now=new Date().toISOString();
  configureWhatISaidCapture({...location,enabled:true,retention:'forever',analysisAllowed:false,now});
  for(let i=0;i<22;i++)expect(captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'source.jsonl',sourceEventIdentity:String(i),recordedAt:now,text:`fixture ${i}`,promptOrigin:'human',now}).stored).toBe(true);
  const capture=await fetch(f.baseUrl+'/api/what-i-said/capture',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:9000'},body:JSON.stringify({memoryId:location.memoryId,localOnly:true})});
  expect(capture.status).toBe(200);const receipt=(await capture.json() as any).result;
  expect(Date.parse(receipt.scannedThrough)).toBeGreaterThan(Date.parse(now));
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'};
  const args={portId:'deleted-history',start:new Date(Date.now()-7*86400_000).toISOString(),end:receipt.scannedThrough,origin:'human'};
  const call=async(cursor?:string)=>{
   const response=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_list_user_memory_history',arguments:{...args,...(cursor?{cursor}:{})}}},env) as any;
   expect(response.result.isError).toBe(false);return response.result.structuredContent.userMemory;
  };
  const first=await call();expect(first.hits).toHaveLength(20);expect(first.nextCursor).toBeString();
  const inserted=captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'source.jsonl',sourceEventIdentity:'later',recordedAt:now,text:'new fixture',promptOrigin:'human',now});
  expect(inserted.stored).toBe(true);
  const seen=first.hits.map((hit:any)=>hit.id);let cursor=first.nextCursor,last:any;
  for(let page=0;page<8&&cursor;page++) { last=await call(cursor);seen.push(...last.hits.map((hit:any)=>hit.id));cursor=last.nextCursor; }
  expect(cursor).toBeNull();expect(last.complete).toBe(true);expect(seen).toHaveLength(23);
  expect(seen.filter((id:string)=>id===inserted.id)).toHaveLength(1);
  const beforeDelete=await call();expect(beforeDelete.nextCursor).toBeString();
  expect(softDeleteWhatISaidEntries({...location,ids:[beforeDelete.hits[0].id]}).softDeleted).toBe(1);
  const next=await call(beforeDelete.nextCursor);
  expect(next).toMatchObject({complete:false,nextCursor:null,incomplete:['changed-or-out-of-order'],traversal:{inconsistent:true}});
 },30_000);
 test('lossless recent history stays complete after a sidecar restart with a finalized local-only scan receipt',async()=>{
  const f=await fixture();await f.post('/api/control-profile/prepare',{});
  const project=join(f.home,'complete-history');mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'Complete history fixture',autoBackup:false});
  writeFileSync(join(f.data,'ports.json'),JSON.stringify([{id:'complete-history',name:'Complete history fixture',folderPath:project}]));
  const location={appDataDir:f.data,projectRoot:project,memoryId:memory.config!.memoryId},now=new Date().toISOString();
  configureWhatISaidCapture({...location,enabled:true,retention:'forever',analysisAllowed:false,now});
  const text='검증😀\n\\"'.repeat(4096);
  expect(captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'long.jsonl',sourceEventIdentity:'one',recordedAt:now,text,promptOrigin:'human',now}).stored).toBe(true);
  const args={portId:'complete-history',start:new Date(Date.now()-7*86400_000).toISOString(),end:now,origin:'human'};
  const capture=await fetch(f.baseUrl+'/api/what-i-said/capture',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:9000'},body:JSON.stringify({memoryId:location.memoryId,localOnly:true})});
  expect(capture.status).toBe(200);const captured=(await capture.json() as any).result;
  expect(captured).toMatchObject({scanAdvanced:true,hasMore:false});
  expect(Date.parse(captured.scannedThrough)).toBeGreaterThan(Date.parse(now));
  args.end=captured.scannedThrough;
  const old=children.pop()!;old.kill();await old.exited;
  const restarted=await startTestApiServer({cwd:join(import.meta.dir,'..'),env:f.env});children.push(restarted.child);
  const status=await fetch(restarted.baseUrl+'/api/what-i-said/status',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:9000'},body:JSON.stringify({memoryId:location.memoryId})});
  expect(status.status).toBe(200);expect((await status.json() as any).status.scan).toMatchObject({complete:true,unreadable:0,withheld:0});
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:restarted.baseUrl+'/api/agentstoz-use/action'};
  let cursor:string|undefined,last:any,body='';
  for(let page=0;page<40;page++){
   const response=await handleAgentsToZUseMcpRequest({id:page+1,method:'tools/call',params:{name:'agentstoz_use_list_user_memory_history',arguments:{...args,...(cursor?{cursor}:{})}}},env) as any;
   expect(response.result.isError).toBe(false);last=response.result.structuredContent.userMemory;
   for(const hit of last.hits){expect(hit.textPart.offset).toBe(body.length);body+=hit.excerpt;expect(hit.textPart.nextOffset).toBe(body.length);expect(hit.textPart.sha256).toBe(createHash('sha256').update(text).digest('hex'));}
   if(!last.nextCursor)break;cursor=last.nextCursor;
  }
  expect(body).toBe(text);
  expect(last).toMatchObject({complete:true,incomplete:[],nextCursor:null,traversal:{rows:1,inRange:1,returned:1,truncated:0,skipped:0},coverage:{collection:'reported-complete',endBoundary:'confirmed'}});
  // An authentic successful receipt is not evidence for a later requested end.
  cursor=undefined;body='';
  const futureEnd=new Date(Date.parse(captured.scannedThrough)+1000).toISOString();
  for(let page=0;page<40;page++){
   const response=await handleAgentsToZUseMcpRequest({id:100+page,method:'tools/call',params:{name:'agentstoz_use_list_user_memory_history',arguments:{...args,end:futureEnd,...(cursor?{cursor}:{})}}},env) as any;
   expect(response.result.isError).toBe(false);last=response.result.structuredContent.userMemory;
   for(const hit of last.hits){expect(hit.textPart.offset).toBe(body.length);body+=hit.excerpt;}
   if(!last.nextCursor)break;cursor=last.nextCursor;
  }
  expect(body).toBe(text);
  expect(last).toMatchObject({complete:false,incomplete:['collection-outdated'],nextCursor:null,
   traversal:{rows:1,inRange:1,returned:1,truncated:0,skipped:0},
   coverage:{collection:'reported-complete',endBoundary:'unconfirmed',scannedThrough:captured.scannedThrough}});
 },30_000);
 test('external # references read only the exact OPS, DEV or activated USE memory with no DEV fallback',async()=>{
  const f=await fixture();const prepared=await f.post('/api/control-profile/prepare',{});const token=readControlProfileAccess(f.data)!.token;
  const project=join(f.home,'reference-project');mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'Reference fixture',autoBackup:false});
  writeFileSync(join(project,memory.config!.sourcePath),'# Project Core Memory\n\n## Key Decisions\n\n### REFERENCE decision\nDEV_ONLY_REFERENCE is the development decision.\n');
  writeFileSync(join(f.data,'ports.json'),JSON.stringify([{id:'reference-project',name:'Reference fixture',folderPath:project}]));
  const action={action:'read-reference',controllerPortId:CONTROL_PROFILE_CONTROLLER,reference:{role:'dev',portId:'reference-project',query:'REFERENCE'}};
  expect((await f.post('/api/agentstoz-use/action',action)).status).toBe(403);
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'};
  const call=async(args:unknown)=>{
   const result=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_read_reference',arguments:args}},env) as any;
   expect(result.result.isError).toBe(false);return result.result.structuredContent;
  };
  const core=readFileSync(join(project,memory.config!.sourcePath));
  const dev=await call(action.reference);expect(dev.effect).toBe('read-only');expect(dev.reference.memoryId).toBe(memory.config!.memoryId);
  expect(dev.reference.hits[0].body).toContain('DEV_ONLY_REFERENCE');
  expect((await f.post('/api/agentstoz-use/action',{...action,reference:{...action.reference,role:'use'}},token)).status).not.toBe(200);
  const use=await f.post('/api/service-memory/prepare-use-memory',{portId:'reference-project',consent:true});expect(use.status).toBe(200);
  writeFileSync(use.body.serviceMemory.record.sourcePath,'# USE operating memory\n\nUSE_ONLY_REFERENCE is the operating preference.\n');
  expect((await f.post('/api/service-memory/enable-use',{portId:'reference-project',consent:true})).status).toBe(200);
  const operating=await call({role:'use',portId:'reference-project',query:'REFERENCE'});
  expect(operating.reference.memoryId).not.toBe(memory.config!.memoryId);
  expect(JSON.stringify(operating)).toContain('USE_ONLY_REFERENCE');expect(JSON.stringify(operating)).not.toContain('DEV_ONLY_REFERENCE');
  expect(JSON.stringify(operating)).not.toContain(f.home);
  const ops=await call({role:'ops',query:'operating'});expect(ops.reference.role).toBe('ops');expect(ops.reference.profile.memoryId).toBe(prepared.body.profile.memoryId);
  expect((await f.post('/api/agentstoz-use/action',{...action,reference:{...action.reference,portId:'missing-project'}},token)).status).not.toBe(200);
  expect((await f.post('/api/agentstoz-use/action',{...action,reference:{...action.reference,command:'echo unsafe'}},token)).status).not.toBe(200);
  expect(readFileSync(join(project,memory.config!.sourcePath)).equals(core)).toBe(true);
 },20_000);
 test('user-history recall requires profile auth and an exact registered project through real MCP',async()=>{
  const f=await fixture();await f.post('/api/control-profile/prepare',{});
  const project=join(f.home,'project');mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'History fixture',autoBackup:false});
  writeFileSync(join(f.data,'ports.json'),JSON.stringify([{id:'history-project',name:'History fixture',folderPath:project}]));
  const request={action:'recall-user-memory',controllerPortId:CONTROL_PROFILE_CONTROLLER,portId:'history-project',query:'검증'};
  expect((await f.post('/api/agentstoz-use/action',request)).status).toBe(403);
  const token=readControlProfileAccess(f.data)!.token;
  expect((await f.post('/api/agentstoz-use/action',{...request,portId:'missing'},token)).status).not.toBe(200);
  const result=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_recall_user_memory',arguments:{portId:'history-project',query:'검증'}}},{...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'}) as any;
  expect(result.result.isError).toBe(false);
  expect(result.result.structuredContent).toMatchObject({effect:'read-only',userMemory:{state:'ready',scope:'project-local',memoryId:memory.config!.memoryId,hits:[]}});
  expect(JSON.stringify(result)).not.toContain(f.home);
  const location={appDataDir:f.data,projectRoot:project,memoryId:memory.config!.memoryId};
  expect(existsSync(whatISaidDatabasePath(location))).toBe(false);
  const now=new Date().toISOString();
  configureWhatISaidCapture({...location,enabled:true,retention:90,analysisAllowed:false,now});
  expect(captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'history.jsonl',sourceEventIdentity:'one',recordedAt:now,text:'검증 후 사용자에게 결과를 알려줘',now}).stored).toBe(true);
  const old=new Date(Date.now()-100*24*60*60*1000).toISOString();
  expect(captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'history.jsonl',sourceEventIdentity:'expired',recordedAt:old,text:'검증 만료 원문',allowBeforeEnabled:true,now:old}).stored).toBe(true);
  const read=await f.post('/api/agentstoz-use/action',request,token);
  expect(read.status).toBe(200);expect(read.body.userMemory.hits[0]).toMatchObject({memoryId:memory.config!.memoryId,excerpt:'검증 후 사용자에게 결과를 알려줘',authority:'historical-evidence'});
  const historyArgs={portId:'history-project',start:new Date(Date.now()-60_000).toISOString(),end:new Date(Date.now()+60_000).toISOString()};
  const historyBody={action:'list-user-memory-history',controllerPortId:CONTROL_PROFILE_CONTROLLER,...historyArgs};
  expect((await f.post('/api/agentstoz-use/action',historyBody)).status).toBe(403);
  const history=await handleAgentsToZUseMcpRequest({id:2,method:'tools/call',params:{name:'agentstoz_use_list_user_memory_history',arguments:historyArgs}},{...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'}) as any;
  expect(history.result.isError).toBe(false);
  expect(history.result.structuredContent.userMemory.hits[0]).toMatchObject({memoryId:memory.config!.memoryId,excerpt:'검증 후 사용자에게 결과를 알려줘'});
  expect(history.result.structuredContent.userMemory.traversal).toMatchObject({returned:1,filtered:0,stoppedBy:'end'});
  // The fixture's prompt carries no human-delivery evidence, so a human-only page withholds it and says so.
  const human=await f.post('/api/agentstoz-use/action',{...historyBody,origin:'human'},token);
  expect(human.status).toBe(200);expect(human.body.userMemory).toMatchObject({hits:[],origin:'human',traversal:{inRange:1,filtered:1}});
  const expired=await f.post('/api/agentstoz-use/action',{...historyBody,cursor:'umh1_eyJ4IjoxfQ.'+'A'.repeat(43)},token);
  expect(expired.status).toBe(400);expect(expired.body.code).toBe('USER_MEMORY_CURSOR_EXPIRED');
  const malformed=await f.post('/api/agentstoz-use/action',{...historyBody,cursor:'not-a-cursor'},token);
  expect(malformed.status).toBe(400);expect(malformed.body.code).toBe('USER_MEMORY_CURSOR_EXPIRED');
  // The whole range was read; any remaining reason (such as an unknown capture summary) is named, never implied.
  const whole=history.result.structuredContent.userMemory;
  expect(whole.nextCursor).toBeNull();expect(whole.complete).toBe(whole.incomplete.length===0);
  const reversed=await f.post('/api/agentstoz-use/action',{...historyBody,start:historyArgs.end,end:historyArgs.start},token);
  expect(reversed.status).toBe(400);expect(reversed.body.code).toBe('USER_MEMORY_RANGE_INVALID');
  expect(JSON.stringify(history)).not.toContain(f.home);
  expect(JSON.stringify(read.body)).not.toContain('검증 만료 원문');
  const db=new Database(whatISaidDatabasePath(location),{readonly:true});
  try{expect((db.query('SELECT COUNT(*) AS count FROM what_i_said_events WHERE recorded_at = ? AND purged_at IS NULL').get(old) as {count:number}).count).toBe(1);}finally{db.close();}
 },20_000);
 test('dated human history traverses real encrypted sequence boundaries without losing requests',async()=>{
  const f=await fixture();await f.post('/api/control-profile/prepare',{});
  const project=join(f.home,'boundary-project');mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'Boundary fixture',autoBackup:false});
  writeFileSync(join(f.data,'ports.json'),JSON.stringify([{id:'boundary-project',name:'Boundary fixture',folderPath:project}]));
  const location={appDataDir:f.data,projectRoot:project,memoryId:memory.config!.memoryId},now=new Date().toISOString();
  configureWhatISaidCapture({...location,enabled:true,retention:'forever',analysisAllowed:false,now});
  const ids:string[]=[];
  for(let seq=1;seq<=105;seq++){
   const saved=captureWhatISaidPrompt({...location,key:Buffer.alloc(32,0x31),agent:'codex',sourceIdentity:'boundaries.jsonl',sourceEventIdentity:String(seq),recordedAt:now,text:`boundary request ${seq}`,promptOrigin:'human',now});
   expect(saved.stored).toBe(true);if(saved.stored)ids.push(saved.id);
  }
  const args={portId:'boundary-project',start:new Date(Date.now()-60_000).toISOString(),end:new Date(Date.now()+60_000).toISOString(),origin:'human'};
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'};
  const seen:string[]=[],cursors=new Set<string>();let cursor:string|undefined,last:any;
  for(let page=0;page<12;page++){
   const result=await handleAgentsToZUseMcpRequest({id:page+1,method:'tools/call',params:{name:'agentstoz_use_list_user_memory_history',arguments:{...args,...(cursor?{cursor}:{})}}},env) as any;
   expect(result.result.isError).toBe(false);last=result.result.structuredContent.userMemory;
   expect(last.incomplete).not.toContain('changed-or-out-of-order');
   seen.push(...last.hits.map((hit:any)=>hit.id));
   if(!last.nextCursor)break;
   expect(cursors.has(last.nextCursor)).toBe(false);cursors.add(last.nextCursor);cursor=last.nextCursor;
  }
  expect(last.nextCursor).toBeNull();expect(last.traversal).toMatchObject({rows:105,inRange:105,returned:105,filtered:0,inconsistent:false,stoppedBy:'end'});
  expect(seen).toEqual(ids.reverse());expect(new Set(seen).size).toBe(105);
  // An absent capture summary still stays visible; exhausting the rows must not invent collection evidence.
  expect(last.complete).toBe(last.incomplete.length===0);
 },20_000);
 test('the real OPS request endpoint enforces profile auth and never launches an unbound receiver',async()=>{
  const f=await fixture();await f.post('/api/control-profile/prepare',{});const token=readControlProfileAccess(f.data)!.token;
  const body={operation:'complete',requestId:crypto.randomUUID(),capability:'c'.repeat(64),state:'completed',result:'수행 결과',evidence:'수행 근거'};
  expect((await f.post('/api/agent-dialogue/ops-mcp',body)).status).toBe(403);
  const response=await f.post('/api/agent-dialogue/ops-mcp',body,token);
  expect(response.status).toBe(400);expect(response.body.version).toBe('ops-request-v1');expect(response.body.error).toContain('공유 OPS');
  expect(existsSync(join(f.data,'ops-requests.v1.sqlite'))).toBe(false);
  const browser=await fetch(f.baseUrl+'/api/agent-dialogue/ops-mcp',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:9000',[CONTROL_PROFILE_HEADER]:token},body:JSON.stringify(body)});
  expect(browser.status).toBe(403);
 },20_000);
 test('an unregistered user profile recalls and reviews memory via the same MCP from any cwd',async()=>{
  const f=await fixture();
  const before=await fetch(f.baseUrl+'/api/control-profile/status').then(r=>r.json()) as any;expect(before.profile.state).toBe('unprepared');
  const prepared=await f.post('/api/control-profile/prepare',{});expect(prepared.body.profile.state).toBe('ready');expect(prepared.body.profile.projectId).toBeNull();
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'};
  const call=async(name:string,args:Record<string,unknown>={})=>await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}},env) as any;
  const profile=await call('agentstoz_use_get_control_profile');expect(profile.result.isError).toBe(false);expect(profile.result.structuredContent.profile.memoryId).toBe(prepared.body.profile.memoryId);
  const listed=await call('agentstoz_use_list_projects');expect(listed.result.structuredContent.projects).toEqual([]);
  const proposal=await call('agentstoz_use_propose_control_memory',{requestId:'user-decision-1',title:'검증 운영 원칙',body:'검증 결과를 확인한 뒤 완료를 보고한다.',evidence:'사용자가 직접 요청한 운영 결정.',expectedRevision:prepared.body.profile.revision});
  expect(proposal.result.structuredContent.saved).toBe(true);expect(proposal.result.structuredContent.proposal.state).toBe('saved');
  const pending=await call('agentstoz_use_list_control_memory_candidates');expect(pending.result.structuredContent.proposals).toEqual([]);
  const recalled=await call('agentstoz_use_recall_control_context',{query:'검증 운영 원칙'});expect(recalled.result.structuredContent.hits.some((h:any)=>h.body.includes('완료를 보고'))).toBe(true);
  expect(JSON.stringify(recalled)).not.toContain(f.home);expect(JSON.stringify(recalled)).not.toContain(readControlProfileAccess(f.data)!.token);
  // '내 프로필 보여줘': the profile names what it remembers (titles only, at most 20); recall's context() stays without them.
  const titled=(await call('agentstoz_use_get_control_profile')).result.structuredContent;
  expect(titled.entryTitles).toContain('검증 운영 원칙');expect(titled.entryTitles.length).toBeLessThanOrEqual(20);expect(titled.entryCount).toBeGreaterThanOrEqual(titled.entryTitles.length);
  expect(JSON.stringify(titled.entryTitles)).not.toContain('완료를 보고');expect(recalled.result.structuredContent.profile).not.toHaveProperty('entryTitles');
  const stored=JSON.parse(readFileSync(join(f.data,'control-profile','binding.json'),'utf8'));expect(stored.memoryId).toBe(prepared.body.profile.memoryId);
 },20_000);
 // UX audit 2026-10-25: the panel claimed to manage operating memory but no route returned a saved entry.
 test('아젠투지 설정 reads saved operating memory titles, then one body, read-only and bounded',async()=>{
  const f=await fixture();
  const get=async(path:string)=>{const response=await fetch(f.baseUrl+path);return {status:response.status,body:await response.json() as any};};
  const before=await get('/api/control-profile/entries');
  expect(before.status).toBe(200);expect(before.body.memory).toMatchObject({ready:false,total:0,entries:[]});expect(typeof before.body.memory.problem).toBe('string');
  const prepared=await f.post('/api/control-profile/prepare',{});
  expect((await get('/api/control-profile/entries')).body.memory).toMatchObject({ready:true,total:0,entries:[]});
  const env={...f.env,AGENTSTOZ_USE_ENDPOINT:f.baseUrl+'/api/agentstoz-use/action'};
  const proposal=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_propose_control_memory',arguments:{requestId:'entries-1',title:'검증 운영 원칙',body:'검증 결과를 확인한 뒤 완료를 보고한다.',evidence:'사용자 요청',expectedRevision:prepared.body.profile.revision}}},env) as any;
  expect(proposal.result.structuredContent.saved).toBe(true);
  const listed=await get('/api/control-profile/entries');
  expect(listed.body.memory.total).toBe(1);const saved=listed.body.memory.entries[0];
  expect(saved).toMatchObject({title:'검증 운영 원칙',section:'AgentsToZ 운영 결정'});expect(saved).not.toHaveProperty('body');
  const one=await get(`/api/control-profile/entries?entryId=${saved.entryId}`);
  expect(one.status).toBe(200);expect(one.body.entry).toMatchObject({entryId:saved.entryId,title:'검증 운영 원칙',body:'검증 결과를 확인한 뒤 완료를 보고한다.',truncated:false});
  expect((await get('/api/control-profile/entries?entryId=zz')).status).toBe(400);
  expect((await get(`/api/control-profile/entries?entryId=${'0'.repeat(24)}`)).status).toBe(404);
  expect((await get('/api/control-profile/entries?offset=1')).status).toBe(400);
  expect((await f.post('/api/control-profile/entries',{})).status).toBe(404);
  expect(JSON.stringify([listed.body,one.body])).not.toContain(f.home);
  expect((await get('/api/control-profile/status')).body.profile.revision).toBe(listed.body.memory.revision);
 },20_000);
 test('legacy controller ID or a token from another user cannot read profile memory',async()=>{
  const a=await fixture(),b=await fixture();await a.post('/api/control-profile/prepare',{});await b.post('/api/control-profile/prepare',{});
  const body={action:'recall-control-context',controllerPortId:CONTROL_PROFILE_CONTROLLER,query:'operating'};
  expect((await b.post('/api/agentstoz-use/action',body)).status).not.toBe(200);
  expect((await b.post('/api/agentstoz-use/action',body,readControlProfileAccess(a.data)!.token)).status).toBe(403);
  expect((await b.post('/api/agentstoz-use/action',body,readControlProfileAccess(b.data)!.token)).status).toBe(200);
 // Two cold real API fixtures share the same integration budget as the first test.
 // Authorization assertions and production request deadlines are unchanged.
 },20_000);
});
