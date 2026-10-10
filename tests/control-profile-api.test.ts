import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTestApiServer} from './startTestApiServer';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {CONTROL_PROFILE_HEADER,CONTROL_PROFILE_CONTROLLER} from '../src/controlProfileContract';
const children:Bun.Subprocess[]=[],dirs:string[]=[];
afterEach(async()=>{for(const c of children.splice(0)){c.kill();await c.exited;}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'control-profile-api-'));dirs.push(home);const data=join(home,'app-data');mkdirSync(data);
 const env={...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1'};
 const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});children.push(child);
 const post=async(path:string,body:unknown,token?:string)=>{
  const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{[CONTROL_PROFILE_HEADER]:token}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};
 };
 return {home,data,env,baseUrl,post};
}
describe('Control profile through real API and MCP',()=>{
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
  const stored=JSON.parse(readFileSync(join(f.data,'control-profile','binding.json'),'utf8'));expect(stored.memoryId).toBe(prepared.body.profile.memoryId);
 });
 test('legacy controller ID or a token from another user cannot read profile memory',async()=>{
  const a=await fixture(),b=await fixture();await a.post('/api/control-profile/prepare',{});await b.post('/api/control-profile/prepare',{});
  const body={action:'recall-control-context',controllerPortId:CONTROL_PROFILE_CONTROLLER,query:'operating'};
  expect((await b.post('/api/agentstoz-use/action',body)).status).not.toBe(200);
  expect((await b.post('/api/agentstoz-use/action',body,readControlProfileAccess(a.data)!.token)).status).toBe(403);
  expect((await b.post('/api/agentstoz-use/action',body,readControlProfileAccess(b.data)!.token)).status).toBe(200);
 });
});
