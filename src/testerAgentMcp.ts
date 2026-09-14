import {parseTesterRequest,type TesterOperation} from './testerAgentContract';
const names:Record<string,TesterOperation>={agentstoz_use_get_tester:'status',agentstoz_use_plan_tester_setup:'plan',agentstoz_use_apply_tester_setup:'apply',agentstoz_use_start_tester:'start',agentstoz_use_read_tester_run:'read',agentstoz_use_cancel_tester_run:'cancel',agentstoz_use_prepare_tester_handoff:'handoff'};
const descriptions:Record<TesterOperation,string>={status:'Read a registered project’s tester setup, profiles, worktree targets and latest test evidence. Does not run tests.',plan:'Preview tester setup or update. Preserves project-specific tests and user instructions; does not apply changes.',apply:'Apply a previously reviewed tester setup revision when the user requests setup or update. Does not create GitHub repositories or run AI.',start:'Start the configured Python tester for the selected registered project/worktree. Use revision from get_tester and requestId test_<13 digit current Unix milliseconds>_<UUID>. Retain the same request ID when retrying. Returns a run, not a completed test. If a parent task holds a workspace lease, use the project CLI inside that task.',read:'Read the actual test run result. Do not substitute an earlier run or claim fixture results prove a live service.',cancel:'Request cancellation of one project test run; read again to confirm child termination.',handoff:'Prepare project-specific test configuration or repair instructions with bounded evidence. Does not call AI or claim a fix completed.'};
export const TESTER_MCP_TOOLS=Object.entries(names).map(([name,operation])=>{
  const properties:Record<string,unknown>={portId:{type:'string',minLength:1,maxLength:200},workspaceTargetId:{type:'string',minLength:8,maxLength:128}};
  const required=['portId'];
  if(operation==='apply'||operation==='start'){properties.revision={type:'string',pattern:'^[a-f0-9]{64}$'};required.push('revision');}
  if(operation==='start'){properties.profileId={type:'string',maxLength:64};properties.requestId={type:'string',pattern:'^test_[0-9]{13}_[a-f0-9-]{36}$'};required.push('profileId','requestId');}
  if(['read','cancel','handoff'].includes(operation)){properties.runId={type:'string',pattern:'^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$'};if(operation!=='handoff')required.push('runId');}
  if(operation==='handoff'){properties.mode={type:'string',enum:['configure','repair']};required.push('mode');}
  return {name,description:descriptions[operation],inputSchema:{type:'object',properties,required,additionalProperties:false}};
});
export function testerMcpAction(name:unknown,args:Record<string,unknown>,controllerPortId:string):Record<string,unknown>|null{
  if(typeof name!=='string'||!Object.hasOwn(names,name))return null;
  const tester=parseTesterRequest({...args,operation:names[name]});
  return {action:'tester',controllerPortId,portId:tester.portId,tester};
}
