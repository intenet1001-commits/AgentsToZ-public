// A memoryId is a UUID and the host lowercases it. An uppercase id from an AI must not make a current host look outdated
// (AGENTSTOZ_USE_HOST_OUTDATED) after the read already ran.
import {expect,test} from 'bun:test';
import {agentsToZUseMcpActionForTool,agentsToZUseUnconfirmedOptions} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const UPPER='3F2504E0-4F89-41D3-9A0C-0305E82C3301',lower=UPPER.toLowerCase();

for(const [tool,args] of [['agentstoz_use_recall_common_memory',{memoryId:UPPER,query:'deploy'}],['agentstoz_use_inspect_project_memory_links',{memoryId:UPPER}]] as const){
  test(`${tool} sends the normalized memoryId and accepts the host's lowercase echo`,()=>{
    const action:any=agentsToZUseMcpActionForTool(tool,{...args} as any,'ctrl');
    expect(action.commonMemory.memoryId).toBe(lower);
    const host:any=parseAgentsToZUseActionRequest(JSON.parse(JSON.stringify(action)));
    const result=host.commonMemory.op==='recall'?{success:true,performed:true,mode:'memory',memoryId:lower}:{success:true,performed:true,memoryId:lower,groups:[]};
    expect(agentsToZUseUnconfirmedOptions(action,result as any)).toEqual([]);
  });
}

test('the echo check itself is case-insensitive but still catches an old host that drops the memoryId',()=>{
  const action:any={action:'common-memory',controllerPortId:'ctrl',commonMemory:{op:'project-links',memoryId:UPPER}};
  expect(agentsToZUseUnconfirmedOptions(action,{success:true,performed:true,memoryId:lower} as any)).toEqual([]);
  expect(agentsToZUseUnconfirmedOptions(action,{success:true,performed:true} as any)).toEqual(['memoryId']);
  const recall:any={action:'common-memory',controllerPortId:'ctrl',commonMemory:{op:'recall',memoryId:UPPER,query:'q'}};
  expect(agentsToZUseUnconfirmedOptions(recall,{success:true,performed:true,mode:'goal'} as any)).toEqual(['memoryId']);
});
