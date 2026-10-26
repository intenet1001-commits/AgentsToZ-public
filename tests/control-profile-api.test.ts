import {afterEach,describe,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync,mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {initializeProjectMemory} from '../project-memory-server';
import {configureWhatISaidCapture,captureWhatISaidPrompt,whatISaidDatabasePath} from '../src/whatISaidStore';
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
  expect(JSON.stringify(read.body)).not.toContain('검증 만료 원문');
  const db=new Database(whatISaidDatabasePath(location),{readonly:true});
  try{expect((db.query('SELECT COUNT(*) AS count FROM what_i_said_events WHERE recorded_at = ? AND purged_at IS NULL').get(old) as {count:number}).count).toBe(1);}finally{db.close();}
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
