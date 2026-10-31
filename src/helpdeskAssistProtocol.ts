/** 헬프데스크 도움받기(with 에고라이트 또는 아젠투지브라우저): the browser-assisted mode of the helpdesk.
 * Pure DTOs and request parsing only — UI modules import this file, so no Node/Bun code lives here.
 * Nothing in these shapes carries a password, OTP, token, client JSON, page DOM, screenshot or an OAuth URL query. */
export const HELPDESK_ASSIST_PATH='/api/agent-runtime/helpdesk-assist';
/** Window event an entry point dispatches with an `AssistIntent` detail; the app opens the helpdesk in this mode. */
export const OPEN_HELPDESK_ASSIST_EVENT='agentstoz:open-helpdesk-assist';
export const ASSIST_TITLE='헬프데스크 도움받기(with 에고라이트 또는 아젠투지브라우저)';
export const ASSIST_BUTTON='헬프데스크 도움받기';

export const ASSIST_SERVICES=['google-workspace','github','supabase','vercel','codex','claude','agy','hermes','api-key','mobile-google'] as const;
export type AssistService=typeof ASSIST_SERVICES[number];
export const ASSIST_GOALS=['connect','signup','install','auth','api-key','mobile-login'] as const;
export type AssistGoal=typeof ASSIST_GOALS[number];
/** Where the result applies. `mac-wide` is a request the existing native switch handles; `account-add` never changes it. */
export const ASSIST_SCOPES=['account-add','first-setup','project','new-project','mac-wide'] as const;
export type AssistScopeKind=typeof ASSIST_SCOPES[number];
export type AssistScope={kind:AssistScopeKind;projectId?:string};
/** The screen the help was asked from; the person returns there when the help ends. */
export const ASSIST_ORIGINS=['helpdesk-gws','helpdesk-services','helpdesk-auth','google-setup-help','google-setup-wizard','google-client-setup','cli-login','quick-cli-login-mac','quick-cli-login-project','quick-cli-login-new-project','service-onboarding'] as const;
export type AssistOrigin=typeof ASSIST_ORIGINS[number];
export type AssistIntent={service:AssistService;goal:AssistGoal;stage:string;scope:AssistScope;origin:AssistOrigin;email?:string};
export const ASSIST_BROWSERS=['ego','agentstoz'] as const;
export type AssistBrowser=typeof ASSIST_BROWSERS[number];
/** The AI that helps choose among observed elements, chosen separately from the browser. `none` = fixed steps + guidance. */
export const ASSIST_AIS=['claude','codex','none'] as const;
export type AssistAi=typeof ASSIST_AIS[number];

/** What the person decided before the help starts. Plain, secret-free choices: the help types or picks exactly these
 * values on reviewed screens and never asks a model for them. The email comes from the intent. */
export const GOOGLE_PROJECT_ID=/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
export type AssistDecisions={project?:{mode:'existing';id:string}|{mode:'new';name:string};appName?:string;audience?:'external'|'internal'};
export type AssistRunState='prepared'|'checking'|'assisting'|'waiting-human'|'paused'|'verifying'|'completed'|'needs-review'|'interrupted'|'failed'|'cancelled';
export const ASSIST_TERMINAL:readonly AssistRunState[]=['completed','failed','cancelled'];
export type AssistStepKind='check'|'browser'|'human'|'app'|'verify'|'return';
export type AssistStepState='pending'|'active'|'done'|'skipped'|'human'|'failed';
/** Separate results the person reads: preparing an API is not a stored client, which is not a sign-in, which is not a working CLI. */
export const ASSIST_CHECK_IDS=['browser','console','client','login','connection'] as const;
export type AssistCheckId=typeof ASSIST_CHECK_IDS[number];
export type AssistCheck={id:AssistCheckId;state:'unknown'|'pending'|'ok'|'failed'|'skipped';at?:number;detail?:string};
/** A browser action's outcome. `dispatched-unverified`: sent, effect not yet seen. `unknown`: never retried, a person reviews. */
export type AssistReceiptState='confirmed'|'dispatched-unverified'|'refused'|'unknown'|'reviewed';
export type AssistReceipt={id:string;stepId:string;kind:'navigate'|'click'|'fill'|'handoff'|'verify';state:AssistReceiptState;at:number;target?:string;note?:string};
export type AssistSupport='assisted'|'guided'|'entry';
export type AssistDriverSupport={browser:AssistBrowser;available:boolean;reason?:string};
export type AssistPlannerSupport={ai:AssistAi;supported:boolean;reason?:string};
export type AssistCapabilities={drivers:AssistDriverSupport[];planners:AssistPlannerSupport[];platform:'mac'|'other'};
export type AssistStepView={id:string;title:string;kind:AssistStepKind;state:AssistStepState;human?:string};
/** Why a run waits for the person: one reason, and the next thing to do. */
export type AssistWaiting={reason:'decision'|'sign-in'|'secret'|'download'|'attach'|'unexpected-page'|'human-control'|'captcha'|'policy'|'no-planner'|'ambiguous'|'login'|'review';note:string};
export type AssistRun={id:string;revision:number;intent:AssistIntent;recipeId:string;recipeVersion:number;support:AssistSupport;state:AssistRunState;
 browser:AssistBrowser|null;ai:AssistAi|null;steps:AssistStepView[];step:string|null;checks:AssistCheck[];receipts:AssistReceipt[];
 waiting?:AssistWaiting;message?:string;decisions:AssistDecisions;links:{loginId?:string;accountId?:string;projectId?:string;spaceId?:number};
 budget:{actions:number;plannerCalls:number;startedAt:number|null};createdAt:number;updatedAt:number;origin:AssistOrigin};
export type AssistView={revision:number;run:AssistRun|null;capabilities:AssistCapabilities;browser?:unknown};

export type AssistRequest=
 |{operation:'assist-capabilities'}
 |{operation:'assist-status';runId?:string}
 |{operation:'assist-prepare';requestId:string;intent:AssistIntent}
 |{operation:'assist-start';runId:string;expectedRevision:number;browser:AssistBrowser;ai:AssistAi;scopeConfirmed:true;decisions?:AssistDecisions}
 |{operation:'assist-advance'|'assist-pause'|'assist-take'|'assist-resume'|'assist-cancel'|'assist-verify'|'assist-human-done';runId:string;expectedRevision:number}
 |{operation:'assist-link';runId:string;expectedRevision:number;loginId?:string;accountId?:string;email?:string}
 |{operation:'assist-settle';runId:string;expectedRevision:number;receiptId:string}
 /** The built-in browser's view lives in the app window; only its connect and detach reach the host through this mode. */
 |{operation:'assist-browser';runId:string;browser:AssistBrowserRequest};
/** The person's own management of the built-in view, as the Workroom panel does it. Control returns to the help only through
 * assist-resume; a grant, an observation request or an agent action never travels on this path. */
export type AssistBrowserRequest=
 |{operation:'connect-owned';port:number;pageId:string}
 |{operation:'status'|'take'|'detach'}
 |{operation:'select';pageId:string};

const ID=/^[a-zA-Z0-9-]{8,100}$/,TARGET_ID=/^[A-Za-z0-9_-]{8,128}$/,EMAIL=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/,STAGE=/^[a-z][a-z0-9-]{1,40}$/;
const fail=(m='도움받기 요청 형식을 확인하세요.'):never=>{throw Error(m);};
const only=(r:Record<string,unknown>,keys:string[])=>{if(Object.keys(r).some(k=>!keys.includes(k)))fail('지원하지 않는 도움받기 요청입니다.');};
export function parseAssistIntent(v:unknown):AssistIntent{
 if(!v||typeof v!=='object'||Array.isArray(v))fail();const r=v as Record<string,unknown>;only(r,['service','goal','stage','scope','origin','email']);
 if(!(ASSIST_SERVICES as readonly unknown[]).includes(r.service)||!(ASSIST_GOALS as readonly unknown[]).includes(r.goal)||typeof r.stage!=='string'||!STAGE.test(r.stage)||!(ASSIST_ORIGINS as readonly unknown[]).includes(r.origin))fail();
 const s=r.scope as Record<string,unknown>|undefined;if(!s||typeof s!=='object'||Array.isArray(s))fail();only(s!,['kind','projectId']);
 if(!(ASSIST_SCOPES as readonly unknown[]).includes(s!.kind)||s!.projectId!==undefined&&(typeof s!.projectId!=='string'||!TARGET_ID.test(s!.projectId as string)))fail();
 if((s!.kind==='project')!==(s!.projectId!==undefined))fail('프로젝트에 적용하는 도움은 그 프로젝트를 함께 알려야 합니다.');
 if(r.email!==undefined&&(typeof r.email!=='string'||!EMAIL.test(r.email)))fail('이메일 형식을 확인하세요.');
 return {service:r.service as AssistService,goal:r.goal as AssistGoal,stage:r.stage as string,scope:{kind:s!.kind as AssistScopeKind,...(s!.projectId?{projectId:s!.projectId as string}:{})},origin:r.origin as AssistOrigin,...(r.email?{email:(r.email as string).toLowerCase()}:{})};
}
const TEXT_VALUE=/^[^\u0000-\u001f\u007f<>]{1,60}$/;
/** What the Console accepts as a new project's name; the start screen checks the same rule before sending. */
export const GOOGLE_PROJECT_NAME=/^[A-Za-z0-9 '"!-]{4,30}$/;const PROJECT_NAME=GOOGLE_PROJECT_NAME;
export function parseAssistDecisions(v:unknown):AssistDecisions{
 if(!v||typeof v!=='object'||Array.isArray(v))fail('함께 진행할 값을 확인하세요.');const r=v as Record<string,unknown>;only(r,['project','appName','audience']);const out:AssistDecisions={};
 if(r.project!==undefined){
  const p=r.project as Record<string,unknown>;if(!p||typeof p!=='object'||Array.isArray(p))fail();
  const id=p.id,name=p.name;
  if(p.mode==='existing'){only(p,['mode','id']);if(typeof id!=='string'||!GOOGLE_PROJECT_ID.test(id))fail('Google 프로젝트 ID 형식을 확인하세요.');out.project={mode:'existing',id:id as string};}
  else if(p.mode==='new'){only(p,['mode','name']);if(typeof name!=='string'||!PROJECT_NAME.test(name.trim()))fail('새 프로젝트 이름은 영문·숫자·공백·하이픈 4~30자로 적어 주세요.');out.project={mode:'new',name:(name as string).trim()};}
  else fail();
 }
 const app=r.appName,audience=r.audience;
 if(app!==undefined){if(typeof app!=='string'||!TEXT_VALUE.test(app.trim()))fail('앱 이름은 60자 이내로 적어 주세요.');out.appName=(app as string).trim();}
 if(audience!==undefined){if(audience!=='external'&&audience!=='internal')fail();out.audience=audience as 'external'|'internal';}
 return out;
}
export function parseAssistRequest(v:unknown):AssistRequest{
 if(!v||typeof v!=='object'||Array.isArray(v))fail();const r=v as Record<string,unknown>,op=r.operation;
 const run=()=>{if(typeof r.runId!=='string'||!ID.test(r.runId))fail();};
 const rev=()=>{if(!Number.isSafeInteger(r.expectedRevision)||(r.expectedRevision as number)<0)fail('최신 도움받기 상태를 확인한 뒤 다시 요청하세요.');};
 if(op==='assist-capabilities'){only(r,['operation']);return {operation:op};}
 if(op==='assist-status'){only(r,['operation','runId']);if(r.runId!==undefined)run();return r as AssistRequest;}
 if(op==='assist-prepare'){only(r,['operation','requestId','intent']);if(typeof r.requestId!=='string'||!ID.test(r.requestId))fail();return {operation:op,requestId:r.requestId as string,intent:parseAssistIntent(r.intent)};}
 if(op==='assist-start'){only(r,['operation','runId','expectedRevision','browser','ai','scopeConfirmed','decisions']);run();rev();
  if(!(ASSIST_BROWSERS as readonly unknown[]).includes(r.browser)||!(ASSIST_AIS as readonly unknown[]).includes(r.ai)||r.scopeConfirmed!==true)fail('브라우저·도움 AI와 함께 진행할 범위를 확인하세요.');
  return {operation:op,runId:r.runId as string,expectedRevision:r.expectedRevision as number,browser:r.browser as AssistBrowser,ai:r.ai as AssistAi,scopeConfirmed:true,...(r.decisions!==undefined?{decisions:parseAssistDecisions(r.decisions)}:{})};}
 if(['assist-advance','assist-pause','assist-take','assist-resume','assist-cancel','assist-verify','assist-human-done'].includes(op as string)){only(r,['operation','runId','expectedRevision']);run();rev();return r as AssistRequest;}
 if(op==='assist-link'){only(r,['operation','runId','expectedRevision','loginId','accountId','email']);run();rev();
  if(r.loginId===undefined&&r.accountId===undefined||r.loginId!==undefined&&(typeof r.loginId!=='string'||!ID.test(r.loginId))||r.accountId!==undefined&&(typeof r.accountId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(r.accountId))||r.email!==undefined&&(typeof r.email!=='string'||!EMAIL.test(r.email)))fail();return r as AssistRequest;}
 if(op==='assist-settle'){only(r,['operation','runId','expectedRevision','receiptId']);run();rev();if(typeof r.receiptId!=='string'||!ID.test(r.receiptId))fail();return r as AssistRequest;}
 if(op==='assist-browser'){only(r,['operation','runId','browser']);run();const b=r.browser as Record<string,unknown>;if(!b||typeof b!=='object'||Array.isArray(b))fail();
  if(b.operation==='status'||b.operation==='take'||b.operation==='detach'){only(b,['operation']);return r as AssistRequest;}
  if(b.operation==='select'){only(b,['operation','pageId']);const page=b.pageId;if(typeof page!=='string'||!page||page.length>180)fail();return r as AssistRequest;}
  only(b,['operation','port','pageId']);if(b.operation!=='connect-owned'||!Number.isInteger(b.port)||(b.port as number)<1||(b.port as number)>65535||typeof b.pageId!=='string'||!b.pageId||(b.pageId as string).length>180)fail();return r as AssistRequest;}
 return fail('지원하지 않는 도움받기 요청입니다.');
}
/** Plain text a person reads for each state; the same words on every surface. */
export const ASSIST_STATE_TEXT:Record<AssistRunState,string>={prepared:'시작 전 · 범위 확인',checking:'현재 상태 확인 중',assisting:'함께 진행 중','waiting-human':'직접 진행해 주세요',paused:'잠시 멈춤',verifying:'실제 연결 확인 중',completed:'지원을 마쳤습니다','needs-review':'결과 확인 필요',interrupted:'중단됨 · 결과 확인 필요',failed:'확인하지 못함',cancelled:'지원을 끝냈습니다'};
export const ASSIST_CHECK_TEXT:Record<AssistCheckId,string>={browser:'브라우저 준비',console:'Console 준비 단계',client:'클라이언트 저장',login:'사용자 인증',connection:'실제 CLI 사용 가능'};
/** Where the result applies, in the words the start screen shows before the person confirms. Build 1619's account
 * model is kept: adding an account changes no default, a project binding is the project's, and the Mac-wide switch stays
 * the account screen's own action. */
export function assistScopeText(scope:AssistScope):string{
 switch(scope.kind){
  case 'account-add':return '계정만 추가합니다. 이 Mac의 기본 계정과 프로젝트 연결은 바꾸지 않습니다.';
  case 'first-setup':return '처음 설정으로 계정을 추가합니다. 이 Mac의 기본 계정은 바꾸지 않습니다.';
  case 'project':return '고른 프로젝트에만 적용합니다. 연결은 계정 화면의 프로젝트 적용으로 확인합니다.';
  case 'new-project':return '새 프로젝트에 쓸 계정을 준비합니다. 이 Mac의 기본 계정은 바꾸지 않습니다.';
  case 'mac-wide':return '이 Mac 전체 기본 계정 전환은 계정 화면의 전환으로 직접 하고, 도움은 그 결과만 확인합니다.';
 }
}
/** The headline a person reads for a run. Ending the help is not a working connection: only a run whose real check
 * passed says so; an entry guide or an ended help says what was and was not checked. */
export function assistOutcomeText(run:Pick<AssistRun,'state'|'support'|'checks'>&{intent:Pick<AssistRun['intent'],'service'>}){
 const ok=run.checks.find(c=>c.id==='connection')?.state==='ok';
 // An AI CLI's help ends at its own sign-in status; a model reply is never requested, so it is never claimed.
 if((run.intent.service==='codex'||run.intent.service==='claude')&&!ok&&run.checks.find(c=>c.id==='login')?.state==='ok'&&(run.state==='needs-review'||run.state==='completed'))return '공식 로그인 확인됨 · 실제 응답은 확인하지 않았습니다';
 if(run.state==='completed')return ok?'실제 연결 확인됨':run.support==='entry'?'안내를 마쳤습니다 · 실제 연결은 확인하지 않았습니다':'지원을 마쳤습니다 · 실제 연결은 확인하지 않았습니다';
 return ASSIST_STATE_TEXT[run.state];
}
