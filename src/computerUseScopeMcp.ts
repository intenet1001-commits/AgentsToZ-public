import {parseComputerScopeAgentRequest} from './computerUseScopeProtocol';

/** Broad scope requires a separately signed native v2 approval; old window grants grant no v2 authority. */
export const COMPUTER_USE_SCOPE_MCP_TOOL={
  name:'agentstoz_use_computer_session',
  description:'Control a Mac desktop or one application only after the person explicitly approves that scope in AgentsToZ Control. First call status and use only its returned grant and epoch. Without a grant, if status shows access.enabled, call request-access once (no other fields): the scope is the one the person switched on, and the person still approves in Control with Touch ID, so tell them to press 승인 검토 열기 in AgentsToZ → 도구 및 설정 → 컴퓨터 유즈, then poll status. When access.standing is present the person allowed every AgentsToZ AI on this Mac in advance (상시 허용): Control approves a whole-Mac request at once and request-access usually answers granted. If access is off, ask the person to switch it on; never retry a refused request-access. The connection can cover multiple chats. Observe before every action; capture the selected display before coordinate input. type-text, key and a single left click on a control or text field act in the background (Accessibility and key events to that app): they do not move the pointer or need the app in front, so the person may keep working. Text and keys go to the app that was in front when you observed (or the approved app), so focus-app first, then observe. Right/double clicks, scroll, drag and spots without an accessible control use the real pointer and are refused while the person is using the mouse; wait and observe again. Coordinates are display-relative POINTS: image pixel x * displayWidth / image width, likewise y. App scope includes that exact running app across windows; restarting or updating it ends permission. Secure input, Control/system approval screens, user takeover, expired consent and changed display/target are refused. Input never goes to the app you run in; while it is in front, leave it with focus-app to another app. A refused receipt may name the Control check that refused it in guardReason; protected-foreground or protected-overlay often means an OS permission or sign-in dialog is open (for example right after Control was updated): ask the person to answer it, then observe again. If a grant shows owner person or an operation answers person-has-control, the person took the Mac from the Control bar: the grant stays; do not request-access or resend, check status about every 30 s and observe again once owner is agent. Never approve your own access. Keep one requestId per action and read receipt after uncertainty; never replay an unknown action. Do not claim a dispatched event proved the intended UI result; observe it.',
  inputSchema:{type:'object',properties:{
    operation:{type:'string',enum:['status','request-access','observe','capture','click','type-text','key','scroll','drag','focus-app','receipt','request-human']},
    grant:{type:'string',pattern:'^[a-f0-9]{64}$'},epoch:{type:'integer',minimum:1},
    observationId:{type:'string',maxLength:200},requestId:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'},
    displayId:{type:'string',maxLength:200},applicationId:{type:'string',maxLength:200},
    x:{type:'number',minimum:0,maximum:100000},y:{type:'number',minimum:0,maximum:100000},endX:{type:'number',minimum:0,maximum:100000},endY:{type:'number',minimum:0,maximum:100000},
    button:{type:'string',enum:['left','right']},clickCount:{type:'integer',enum:[1,2]},
    text:{type:'string',maxLength:4000},key:{type:'string',maxLength:32},
    modifiers:{type:'array',maxItems:4,uniqueItems:true,items:{type:'string',enum:['cmd','ctrl','alt','shift']}},
    deltaX:{type:'integer',minimum:-1200,maximum:1200},deltaY:{type:'integer',minimum:-1200,maximum:1200},
  },required:['operation'],additionalProperties:false},
} as const;
const externalOperations=new Set(COMPUTER_USE_SCOPE_MCP_TOOL.inputSchema.properties.operation.enum);
/** Converts the closed external shape to the dedicated host namespace; no scope/caller/permissions from an AI. */
export function computerUseScopeMcpRequest(value:unknown):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value)||!externalOperations.has((value as any).operation))throw Error('컴퓨터 세션 동작을 확인하세요.');
  return parseComputerScopeAgentRequest({...value,operation:'scope-'+(value as any).operation});
}
