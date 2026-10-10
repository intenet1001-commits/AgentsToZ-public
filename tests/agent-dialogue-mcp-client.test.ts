import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {agentDialogueClientHeaderValue,handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});

test('the dialogue client header keeps only plain printable ASCII',()=>{
  expect(agentDialogueClientHeaderValue('claude-code')).toBe('claude-code');
  expect(agentDialogueClientHeaderValue('codex-mcp-client (0.40)')).toBe('codex-mcp-client (0.40)');
  expect(agentDialogueClientHeaderValue('claude‮-code\r\nX-Evil: 1')).toBe('claude-codeX-Evil 1');
  expect(agentDialogueClientHeaderValue('한글만')).toBeNull();
  expect(agentDialogueClientHeaderValue(42)).toBeNull();
  expect(agentDialogueClientHeaderValue('x'.repeat(80))).toHaveLength(40);
});

test('dialogue calls tell the host which MCP client asked, so approvals can be told apart',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-mcp-client-'));temporary.push(appDataDir);
  mkdirSync(join(appDataDir,'control-profile'),{recursive:true,mode:0o700});
  writeFileSync(join(appDataDir,'control-profile','access.json'),
    JSON.stringify({schemaVersion:1,profileId:randomUUID(),token:randomBytes(32).toString('hex')}),{mode:0o600});
  const seen:{client:string|null;instance:string|null}[]=[];
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:req=>{
    if(new URL(req.url).pathname!=='/api/agent-dialogue/mcp')return new Response('not found',{status:404});
    seen.push({client:req.headers.get('x-agentstoz-dialogue-client'),instance:req.headers.get('x-agentstoz-dialogue-instance')});
    return Response.json({success:true,performed:true,effect:'dialogue-result',peers:[]});
  }});
  try{
    const env={AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,APP_DATA_DIR:appDataDir,HOME:appDataDir};
    const peers={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentstoz_use_list_dialogue_peers',arguments:{source:{target:'ops'}}}} as const;
    await handleAgentsToZUseMcpRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'claude-code‮'}}} as any,env);
    const result=await handleAgentsToZUseMcpRequest(peers as any,env) as any;
    expect(result.result.isError).toBe(false);
    await handleAgentsToZUseMcpRequest({jsonrpc:'2.0',id:3,method:'initialize',params:{}} as any,env);
    await handleAgentsToZUseMcpRequest(peers as any,env);
    expect(seen.map(value=>value.client)).toEqual(['claude-code',null]);
    expect(seen[0]!.instance).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]!.instance).toBe(seen[0]!.instance);
  }finally{server.stop(true);}
});
