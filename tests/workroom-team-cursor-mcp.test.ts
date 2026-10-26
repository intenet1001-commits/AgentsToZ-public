import {expect,test} from 'bun:test';
import {AGENTSTOZ_USE_MCP_TOOLS,agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_TEAM_SKILL} from '../src/agentstozTeamSkill';

test('a team wait keeps the callers own event cursor through MCP and host parsing',()=>{
 const args={teamId:'team_0123456789ab',timeoutMs:1000,afterCursor:'abcdef01.123'};
 const action=agentsToZUseMcpActionForTool('agentstoz_use_wait_team',args,'fixture-controller');
 expect(parseAgentsToZUseActionRequest(action).team).toEqual({op:'wait',...args,until:'any'});
 const schema=AGENTSTOZ_USE_MCP_TOOLS.find(tool=>tool.name==='agentstoz_use_wait_team')!.inputSchema as any;
 expect(schema.additionalProperties).toBe(false);
 const pattern=new RegExp(schema.properties.afterCursor.pattern);
 expect(pattern.test(args.afterCursor)).toBe(true);
 for(const afterCursor of ['123','abcdef01.-1','abcdef01.01','abcdef01.1000000000','another-team.1']){
  expect(pattern.test(afterCursor)).toBe(false);
  expect(()=>parseAgentsToZUseActionRequest(agentsToZUseMcpActionForTool('agentstoz_use_wait_team',{...args,afterCursor},'fixture-controller'))).toThrow();
 }
 expect(AGENTSTOZ_TEAM_SKILL).toContain('passing `afterCursor` = the `settledCursor`');
});
