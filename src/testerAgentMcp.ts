import {parseTesterRequest,type TesterOperation} from './testerAgentContract';
const names:Record<string,TesterOperation>={agentstoz_use_get_tester:'status',agentstoz_use_plan_tester_setup:'plan',agentstoz_use_apply_tester_setup:'apply',agentstoz_use_start_tester:'start',agentstoz_use_read_tester_run:'read',agentstoz_use_cancel_tester_run:'cancel',agentstoz_use_prepare_tester_handoff:'handoff',
  // 자동 발견된 제안을 **읽고** 받아들이는 두 도구(2026-10-06). 이것이 없던 동안 `scenarios discover` 가
  // 만든 제안이 쌓여도 AI 가 존재조차 알 수 없어, 프로젝트별 계층이 자란다는 설계가 끊겨 있었다.
  agentstoz_use_list_tester_proposals:'proposals',agentstoz_use_accept_tester_scenario:'accept'};
const descriptions:Record<TesterOperation,string>={status:'Read a registered project’s tester setup, profiles, worktree targets, its user personas (catalog state, evidence counts, latest persona verdicts) and latest test evidence. Does not run tests. personas.state "none" means the project has no persona catalog — neither a pass nor a failure.',ensure:'Reconcile the app-owned common tester layer while preserving the project-specific layer. Desktop app only.',plan:'Preview tester setup or update. Preserves project-specific tests and user instructions; does not apply changes.',apply:'Apply a previously reviewed tester setup revision when the user requests setup or update. Does not create GitHub repositories or run AI.',start:'Start the configured Python tester for the selected registered project/worktree. Use revision from get_tester and requestId test_<13 digit current Unix milliseconds>_<UUID>. Retain the same request ID when retrying. profileId "personas" runs the project’s persona catalog (when no manifest profile has that name); a persona passes only when its deterministic tests pass. Returns a run, not a completed test. If a parent task holds a workspace lease, use the project CLI inside that task.',read:'Read the actual test run result. Do not substitute an earlier run or claim fixture results prove a live service.',cancel:'Request cancellation of one project test run; read again to confirm child termination.',handoff:'Prepare project-specific test configuration or repair instructions with bounded evidence. Does not call AI or claim a fix completed. mode "explore" with personaId returns an exploratory-testing brief for one persona as a draft only (class exploratory/observed, verdict null): nothing is sent, started or recorded, and exploration is never reported as PASS/FAIL — confirmed defects must become deterministic tests in that persona’s tests.',
  proposals:'Read the tester checks this project discovered on its own but has not adopted yet, plus the coverage gaps behind them. Read-only: nothing runs and nothing is adopted. Use it before writing a new check — the project may already have proposed one.',
  accept:'Adopt one discovered proposal as a project-specific scenario, when the user asked to extend this project’s tests. Writes only that project’s scenario file; it can never add to the app-owned common layer. Desktop app only.'};
export const TESTER_MCP_TOOLS=Object.entries(names).map(([name,operation])=>{
  const properties:Record<string,unknown>={portId:{type:'string',minLength:1,maxLength:200},workspaceTargetId:{type:'string',minLength:8,maxLength:128}};
  const required=['portId'];
  if(operation==='apply'||operation==='start'){properties.revision={type:'string',pattern:'^[a-f0-9]{64}$'};required.push('revision');}
  if(operation==='start'){properties.profileId={type:'string',maxLength:64};properties.requestId={type:'string',pattern:'^test_[0-9]{13}_[a-f0-9-]{36}$'};required.push('profileId','requestId');}
  if(['read','cancel','handoff'].includes(operation)){properties.runId={type:'string',pattern:'^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$'};if(operation!=='handoff')required.push('runId');}
  if(operation==='handoff'){properties.mode={type:'string',enum:['configure','repair','explore']};properties.personaId={type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,63}$'};required.push('mode');}
  if(operation==='accept'){properties.scenarioId={type:'string',pattern:'^[a-z0-9][a-z0-9.-]{0,79}$'};required.push('scenarioId');}
  return {name,description:descriptions[operation],inputSchema:{type:'object',properties,required,additionalProperties:false}};
});
export function testerMcpAction(name:unknown,args:Record<string,unknown>,controllerPortId:string):Record<string,unknown>|null{
  if(typeof name!=='string'||!Object.hasOwn(names,name))return null;
  const tester=parseTesterRequest({...args,operation:names[name]});
  return {action:'tester',controllerPortId,portId:tester.portId,tester};
}
