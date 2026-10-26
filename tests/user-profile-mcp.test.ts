import {afterEach,expect,test} from 'bun:test';
import {AGENTSTOZ_USE_MCP_TOOLS,agentsToZUseMcpActionForTool,handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const roots:string[]=[],servers:ReturnType<typeof Bun.serve>[]=[];
afterEach(()=>{for(const server of servers.splice(0))server.stop(true);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const name='agentstoz_use_recall_user_profile';
test('personal preference recall keeps its target and normalized query through both input boundaries',()=>{
 const action=agentsToZUseMcpActionForTool(name,{portId:'registered-project',query:'  문서\n작성  '},'fixture-controller');
 expect(action).toEqual({action:'recall-user-profile',controllerPortId:'fixture-controller',portId:'registered-project',query:'문서 작성'});
 expect(parseAgentsToZUseActionRequest(action)).toMatchObject({action:'recall-user-profile',portId:'registered-project',controlQuery:'문서 작성'});
 for(const args of [{query:'preference'},{portId:'p',query:''},{portId:'p',query:'가'.repeat(342)},{portId:'p',query:'x',target:'ops'},{portId:'p',query:'x',confirmed:true},{portId:'p',query:'x',entries:[]}]){
  expect(()=>agentsToZUseMcpActionForTool(name,args,'fixture-controller')).toThrow();
 }
 const tool=AGENTSTOZ_USE_MCP_TOOLS.find(tool=>tool.name===name)!;
 expect(tool.inputSchema.additionalProperties).toBe(false);
 expect(tool.description).toContain('Read-only');
 expect(AGENTSTOZ_USE_MCP_TOOLS.some(tool=>/user_profile/.test(tool.name)&&tool.name!==name)).toBe(false);
});
test('the MCP sends one bounded read, rejects writes before HTTP, and preserves an older host refusal',async()=>{
 const calls:any[]=[];let older=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  calls.push(await request.json());
  return older?Response.json({success:false,code:'AGENTSTOZ_USE_ACTION_NOT_ALLOWED',error:'unsupported action'},{status:400}):Response.json({success:true,performed:true,action:'recall-user-profile',effect:'read-only',userProfile:{storage:'local',hits:[],truncated:false}});
 }});servers.push(server);
 const root=mkdtempSync(join(tmpdir(),'user-profile-mcp-'));roots.push(root);
 const env={HOME:root,APP_DATA_DIR:join(root,'data'),AGENTSTOZ_CONTROLLER_PORT_ID:'fixture-controller',AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`};
 const call=(args:Record<string,unknown>)=>handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}},env) as Promise<any>;
 const args={portId:'registered-project',query:'writing'};
 const result=await call(args);expect(result.result.isError).toBe(false);expect(result.result.structuredContent.effect).toBe('read-only');
 expect(calls).toEqual([{action:'recall-user-profile',controllerPortId:'fixture-controller',...args}]);
 expect((await call({...args,operation:'save'})).result.isError).toBe(true);expect(calls).toHaveLength(1);
 older=true;const refused=await call(args);expect(refused.result.isError).toBe(true);expect(JSON.stringify(refused.result)).toContain('AGENTSTOZ_USE_ACTION_NOT_ALLOWED');
 expect(calls).toHaveLength(2);
});
