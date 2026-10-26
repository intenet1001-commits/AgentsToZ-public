import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {startTestApiServer} from './startTestApiServer';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {SERVICE_USE_UNCONNECTED_PROBLEM,serviceUseOffConnectionProblem} from '../src/serviceUseHost';
// This fixture has no app connector, so the off line must also say the connection needs attention.
const SERVICE_USE_OFF_PROBLEM=serviceUseOffConnectionProblem(SERVICE_USE_UNCONNECTED_PROBLEM);
import {projectMentionChoices} from '../src/projectUseMention';

// 「USE 끄기」 through the real API: the route next to enable-use, the runtime @ roster and the MCP service/reference paths.
const children:Bun.Subprocess[]=[],dirs:string[]=[];
afterEach(async()=>{for(const c of children.splice(0)){c.kill();await c.exited;}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'service-use-off-api-'));dirs.push(home);const data=join(home,'app-data');mkdirSync(data);
 const env={...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',PORTMGR_WHAT_I_SAID_TEST_KEY:'31'.repeat(32),AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1'};
 const project=join(home,'report-desk');mkdirSync(project);
 initializeProjectMemory({folderPath:project,projectName:'Report Desk',autoBackup:false});
 writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'report-desk',name:'Report Desk',folderPath:project}]));
 const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env});children.push(child);
 const post=async(path:string,body:unknown,headers:Record<string,string>={})=>{
  const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};
 };
 const targets=async()=>{
  const response=await fetch(baseUrl+'/api/agent-runtime/targets?productUses=1',{headers:{Origin:'http://tauri.localhost'}});expect(response.status).toBe(200);
  return ((await response.json()) as {targets:Array<{targetId:string;label:string;scope?:string;useServices?:string[]}>}).targets.filter(t=>t.targetId==='report-desk');
 };
 const mcp=async(name:string,args:unknown)=>(await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}},{...env,AGENTSTOZ_USE_ENDPOINT:baseUrl+'/api/agentstoz-use/action'}) as any).result;
 return {data,post,targets,mcp};
}

test('USE 끄기 route validates like enable-use, keeps memory and receipts, and enable-use continues the same USE',async()=>{
 const f=await fixture();await f.post('/api/control-profile/prepare',{});expect(readControlProfileAccess(f.data)?.token).toBeTruthy();
 const prepared=await f.post('/api/service-memory/prepare-use-memory',{portId:'report-desk',consent:true});expect(prepared.status).toBe(200);
 const record=prepared.body.serviceMemory.record;writeFileSync(record.sourcePath,'# USE operating memory\n\nOFF_ROUNDTRIP_PREFERENCE stays.\n');
 expect((await f.post('/api/service-memory/enable-use',{portId:'report-desk',consent:true})).body.readiness.enabled).toBe(true);
 expect((await f.targets())[0]?.useServices).toEqual(['default']);
 expect(projectMentionChoices(await f.targets()).map(p=>p.label)).toContain('Report Desk-USE');

 // Same allow-list, body validation and explicit consent as enable-use; nothing turns off on a bad request.
 for(const [body,headers,status] of [
  [{portId:'report-desk'},{},400],[{portId:'report-desk',consent:'yes'},{},400],
  [{portId:'report-desk',consent:true,path:'/elsewhere'},{},400],[{portId:'report-desk',consent:true,serviceKey:'Bad Key'},{},400],
  [{portId:'missing-project',consent:true},{},400],[{portId:'report-desk',consent:true},{Origin:'https://attacker.example'},403],
 ] as const){
  const refused=await f.post('/api/service-memory/disable-use',body,headers);expect(refused.status).toBe(status);expect(refused.body.success).toBe(false);
 }
 expect((await f.post('/api/service-memory/disable-use',{portId:'report-desk'})).body.error).toBe('USE 끄기 동의가 필요합니다.');
 expect((await f.post('/api/service-memory/use-status',{portId:'report-desk'})).body.readiness.enabled).toBe(true);

 const off=await f.post('/api/service-memory/disable-use',{portId:'report-desk',consent:true});
 expect(off.status).toBe(200);expect(off.body.turnedOff).toBe(true);
 expect(off.body.readiness).toMatchObject({enabled:false,memoryReady:true,executionReady:false,problem:SERVICE_USE_OFF_PROBLEM});
 expect(off.body.serviceMemory.record).toMatchObject({serviceMemoryId:record.serviceMemoryId,storage:'project-namespace-v1',sourcePath:record.sourcePath});
 expect(readFileSync(record.sourcePath,'utf8')).toContain('OFF_ROUNDTRIP_PREFERENCE');
 expect((await f.post('/api/service-memory/disable-use',{portId:'report-desk',consent:true})).status).toBe(200);

 // Not offered as @ or # anymore, and every execution path says why and how to turn it back on.
 expect((await f.targets())[0]?.useServices).toBeUndefined();
 expect(projectMentionChoices(await f.targets()).map(p=>p.label)).toEqual(['Report Desk']);
 const call={role:'use',serviceKey:'default',tool:'materials.generate',input:{text:'Short fixture greeting'}};
 const local=await f.post('/api/service-memory/execute',{portId:'report-desk',requestId:'local-while-off',call});
 expect(local.status).toBe(400);expect(local.body.error).toBe(SERVICE_USE_OFF_PROBLEM);
 const executed=await f.mcp('agentstoz_use_service_operation',{portId:'report-desk',serviceUse:{operation:'execute',requestId:'mcp-while-off',call}});
 expect(executed.isError).toBe(true);expect(JSON.stringify(executed)).toContain('USE가 꺼져 있습니다');
 const status=await f.mcp('agentstoz_use_service_operation',{portId:'report-desk',serviceUse:{operation:'status'}});
 expect(status.isError).toBe(false);expect(status.structuredContent.readiness).toMatchObject({enabled:false,problem:SERVICE_USE_OFF_PROBLEM});
 expect(JSON.stringify(status)).not.toContain('turnedOff');
 const reference=await f.mcp('agentstoz_use_read_reference',{role:'use',portId:'report-desk',query:'OFF_ROUNDTRIP_PREFERENCE'});
 expect(reference.isError).toBe(true);expect(JSON.stringify(reference)).toContain('USE가 꺼져 있습니다');

 const on=await f.post('/api/service-memory/enable-use',{portId:'report-desk',consent:true});
 expect(on.body.readiness.enabled).toBe(true);expect(on.body.turnedOff).toBe(false);
 expect(on.body.serviceMemory.record.serviceMemoryId).toBe(record.serviceMemoryId);
 expect((await f.targets())[0]?.useServices).toEqual(['default']);
 const back=await f.mcp('agentstoz_use_read_reference',{role:'use',portId:'report-desk',query:'OFF_ROUNDTRIP_PREFERENCE'});
 expect(back.isError).toBe(false);expect(JSON.stringify(back)).toContain('OFF_ROUNDTRIP_PREFERENCE');
},30_000);
