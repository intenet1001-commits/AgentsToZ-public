import type {workModeCopy} from './i18n';

/**
 * Mirrors src-tauri/src/screen_helper.rs: installation observations and the last state AgentsToZ Screen wrote.
 * `waiting` is on but not
 * accepting connections, because the Mac is not on a network approved in AgentsToZ Screen.
 */
export interface ScreenHelperState {power:'off'|'starting'|'on'|'waiting';viewing:boolean;devices:number;capture:boolean;control:boolean;loginItem:'on'|'off'|'approval'}
export interface ScreenHelperStatus {supported:boolean;installed:boolean;running:boolean;updatePending:boolean;otherInstanceRunning:boolean;instanceStatusUnknown:boolean;state:ScreenHelperState|null}
type Copy=ReturnType<typeof workModeCopy>;

/**
 * The work-mode panel's 「아이폰·아이패드로 이 Mac 보기」 lines (DESIGN 「덮개 닫힘」): one status line and what still
 * needs doing. The helper is a separate app, so the panel says where it is and opens it; switching it on and adding a
 * device stay in that app behind Touch ID.
 */
export function screenHelperLines(status:ScreenHelperStatus,copy:Copy):{line:string;notes:string[];canOpen:boolean} {
  // Only the selected installation's own instance is `running`. Other paths and failed observations are blockers,
  // never a claim that this installed copy is open or current. The native open command repeats these checks.
  const canOpen=status.supported&&!status.otherInstanceRunning&&!status.instanceStatusUnknown;
  const state=status.running&&!status.instanceStatusUnknown?status.state:null;
  const notes=[status.updatePending&&copy.screenUpdatePending,state?.viewing&&copy.screenViewing,
    state&&!state.capture&&copy.screenNoCapture,state&&!state.control&&copy.screenNoControl,
    state?.loginItem==='approval'&&copy.screenLoginApproval].filter((note):note is string=>!!note);
  if(status.instanceStatusUnknown)return {line:copy.screenInstanceUnknown,notes,canOpen};
  if(status.otherInstanceRunning)return {line:copy.screenOtherInstance,notes,canOpen};
  if(!status.running)return {line:status.installed?copy.screenStopped:copy.screenMissing,notes,canOpen};
  if(!state)return {line:copy.screenUnknown,notes,canOpen};
  const line=state.power==='off'?copy.screenOff:state.power==='starting'?copy.screenStarting:state.power==='waiting'?copy.screenWaiting
    :state.devices>0?copy.screenOn.replace('{n}',String(state.devices)):copy.screenOnNone;
  return {line,notes,canOpen};
}
