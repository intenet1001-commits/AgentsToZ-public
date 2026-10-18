import {test,expect} from 'bun:test';
import {AGENTSTOZ_USE_MCP_TOOLS,agentsToZUseActionNeedsWorkroomCaller,agentsToZUseCallerHeadersForAction,agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {terminalOutputPage} from '../src/aiTerminalOutput';
import {AGENTSTOZ_CALLER_PROCESSES_HEADER,parseWorkroomCallerHint} from '../src/workroomCaller';
import {sharedShellShouldKeepPolling} from '../src/WorkroomSharedShellPanel';

const controller='controller-1234',portId='project-1234',sessionId='workroom-1234';
test('shared shell MCP accepts a bounded command only for an exact Workroom target',()=>{
  expect(AGENTSTOZ_USE_MCP_TOOLS.map(tool=>tool.name)).toContain('agentstoz_use_send_shared_shell_command');
  const mapped=agentsToZUseMcpActionForTool('agentstoz_use_send_shared_shell_command',{portId,sessionId,requestId:'request-1234',command:'pwd'},controller);
  const parsed=parseAgentsToZUseActionRequest(mapped);
  expect(parsed.action).toBe('send-shared-shell-command');
  expect(agentsToZUseActionNeedsWorkroomCaller(mapped.action)).toBe(true);
  expect(parsed.portId).toBe(portId);
  expect(parsed.sessionId).toBe(sessionId);
  expect(parsed.shellCommand).toBe('pwd');
  expect(()=>parseAgentsToZUseActionRequest({...mapped,command:'pwd\nrm -rf /'})).toThrow();
  expect(()=>parseAgentsToZUseActionRequest({...mapped,command:'x'.repeat(4001)})).toThrow();
  expect(()=>parseAgentsToZUseActionRequest({...mapped,portId:undefined,target:'ops'})).not.toThrow();
  expect(()=>parseAgentsToZUseActionRequest({...mapped,portId,target:'ops'})).toThrow();
  const read=parseAgentsToZUseActionRequest(agentsToZUseMcpActionForTool('agentstoz_use_read_shared_shell',{portId,sessionId,after:0},controller));
  expect(read.after).toBe(0);
  expect(agentsToZUseActionNeedsWorkroomCaller(read.action)).toBe(true);
  expect(agentsToZUseActionNeedsWorkroomCaller('list-projects')).toBe(false);
  for(const action of [mapped.action,read.action]){
    const headers=agentsToZUseCallerHeadersForAction(action,{},()=>[1234,5678]);
    expect(headers[AGENTSTOZ_CALLER_PROCESSES_HEADER]).toBe('1234,5678');
    expect(parseWorkroomCallerHint(new Headers(headers)).processes).toEqual([1234,5678]);
  }
  expect(agentsToZUseCallerHeadersForAction('list-projects',{},()=>{throw Error('unrelated actions must not inspect processes')})).toEqual({});
  expect(()=>normalizeAiTerminalRequest({operation:'shell.input',targetId:portId,sessionId,requestId:'request-1234',data:'pwd\r'})).toThrow();
});

test('an exited shared shell keeps reading when eight pages leave output behind',()=>{
  const output=Array.from({length:33},(_,index)=>({seq:index+1,text:'x'.repeat(1024)}));
  let cursor=0;
  let hasMore=false;
  for(let page=0;page<8;page++){
    const result=terminalOutputPage(output,cursor);
    cursor=result.nextCursor;
    hasMore=result.hasMore;
  }
  expect(cursor).toBe(32);
  expect(hasMore).toBe(true);
  expect(sharedShellShouldKeepPolling('exited',hasMore)).toBe(true);
});

test('a failed read retries only while the shared shell is running',()=>{
  // A failed request provides no hasMore receipt. Reopening the panel starts
  // another read, but an already exited shell must not fail every 400 ms.
  expect(sharedShellShouldKeepPolling('exited',false)).toBe(false);
  expect(sharedShellShouldKeepPolling('running',false)).toBe(true);
});
