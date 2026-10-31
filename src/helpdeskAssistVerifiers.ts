import {randomUUID} from 'node:crypto';
import type {AssistCheckResult,AssistVerifier} from './helpdeskAssistHost';
import type {AssistRun} from './helpdeskAssistProtocol';
/** The existing hosts answer every check; this module only asks them and compares. Nothing here starts a sign-in, saves
 * a client, binds a project or changes this Mac's default account. */
export type AssistPlatformRequest=(value:Record<string,unknown>)=>Promise<Record<string,any>>;
/** What the official CLI says about its own sign-in, nothing more: installed or not, and its auth/login status. A
 * runtime compatibility probe (protocol handshake, model catalog) is not a sign-in, and neither is a model reply, which
 * this help never asks for. */
export type AssistAiAuth='signed-in'|'signed-out'|'missing'|'storage-review'|'unknown';
export type AssistAiState=(provider:'codex'|'claude')=>Promise<AssistAiAuth>;
/** Claude: `claude auth status --json` (helpdeskClaude.check; `unsupported` only means its helper flags are older, the
 * sign-in is the same). Codex: the onboarding login host's own probe, `codex login status` with cached credentials. */
export function createAssistAiStatus(d:{claude:()=>Promise<'unknown'|'missing'|'signed-out'|'ready'|'unsupported'>;codex:{executable:()=>string|null;probe:()=>Promise<'signed-out'|'configured'|'unknown'|'storage-review'>}}):AssistAiState{
 return async provider=>{
  if(provider==='claude'){const s=await d.claude().catch(()=>'unknown' as const);return s==='ready'||s==='unsupported'?'signed-in':s==='missing'||s==='signed-out'?s:'unknown';}
  if(!d.codex.executable())return 'missing';
  const p=await d.codex.probe().catch(()=>'unknown' as const);return p==='configured'?'signed-in':p;
 };
}
const PROVIDERS={'google-workspace':'google-workspace',github:'github',supabase:'supabase',vercel:'vercel'} as const;
const fail=(detail:string):AssistCheckResult=>({state:'failed',detail});
/** Which account a run means: the one its own sign-in finished with, else the managed account of this service with
 * the run's email. Never another service's account, and never "whatever is the default now". */
async function account(platform:AssistPlatformRequest,run:Readonly<AssistRun>,provider:string){
 const list=(await platform({operation:'list',provider})).accounts as {id:string;provider:string;identity:string|null;state:string;source?:string;verifiedEmail?:string}[]??[];
 const own=list.filter(a=>a.provider===provider&&a.source!=='default');
 if(run.links.accountId)return own.find(a=>a.id===run.links.accountId)??null;
 const email=run.intent.email;return email?own.find(a=>a.state==='ready'&&(a.verifiedEmail??a.identity??'').toLowerCase()===email)??null:null;
}
/** Where the run said the account applies, checked as stored: a project's binding, this Mac's default, or nothing
 * (account-add and first setup add an account and change no default). */
async function scope(platform:AssistPlatformRequest,run:Readonly<AssistRun>,provider:string,accountId:string):Promise<AssistCheckResult|null>{
 const s=run.intent.scope;
 if(s.kind==='project'){const p=await platform({operation:'project',targetId:s.projectId});if(p.bindings?.[provider]?.accountId!==accountId)return fail('이 계정이 고른 프로젝트에 아직 연결되지 않았습니다. 계정 화면에서 프로젝트 적용을 확인하세요.');}
 if(s.kind==='mac-wide'){const d=(await platform({operation:'list',provider})).deviceDefaults?.[provider];if(d?.accountId!==accountId)return fail('이 Mac 기본 계정으로 바뀌지 않았습니다. Mac 전체 전환은 계정 화면에서 직접 확인하세요.');}
 return null;
}
export function createAssistVerifier(d:{platform:AssistPlatformRequest;ai:AssistAiState}):AssistVerifier{
 return async(id,run)=>{
  const service=run.intent.service;
  if(service==='codex'||service==='claude'){
   const name=service==='codex'?'Codex':'Claude';
   // No model reply is requested here: the most this help proves is the CLI's own sign-in status.
   if(id==='connection')return {state:'unknown',detail:`${name} 공식 로그인 상태까지 확인했습니다. 모델의 실제 응답은 이 도움에서 시험하지 않았습니다. 워크룸에서 첫 요청으로 확인해 주세요.`};
   if(id!=='login')return {state:'unknown'};
   const state=await d.ai(service);
   if(state==='signed-in')return {state:'ok',detail:`${name} CLI의 공식 로그인 상태 확인이 로그인됨으로 답했습니다.`};
   return state==='signed-out'?{state:'pending',detail:'공식 로그인이 필요합니다.'}:fail(state==='missing'?'프로그램이 설치돼 있지 않습니다.':state==='storage-review'?'로그인 정보 보관 위치를 먼저 확인해야 합니다.':'로그인 상태를 확인하지 못했습니다.');
  }
  const provider=(PROVIDERS as Record<string,string>)[service];if(!provider)return {state:'unknown'};
  if(id==='client'){if(service!=='google-workspace')return {state:'unknown'};const c=(await d.platform({operation:'google-client-status'})).googleClient;return c?.ready?{state:'ok',detail:c.source==='app'?'앱에 저장된 데스크톱 클라이언트가 있습니다.':'기존 gws 클라이언트 설정이 있습니다.'}:fail('저장된 데스크톱 앱 클라이언트가 없습니다.');}
  if(id==='login'){
   if(run.links.loginId){
    let view:any;try{view=(await d.platform({operation:'login-status',loginId:run.links.loginId})).login;}catch{return fail('로그인 기록을 찾지 못했습니다. 계정 목록과 실제 연결을 확인하세요.');}
    if(view?.provider!==provider)return fail('다른 서비스의 로그인입니다.');
    if(view.state==='completed'){if(run.intent.email&&String(view.email).toLowerCase()!==run.intent.email)return fail('처음 정한 이메일과 다른 계정으로 로그인했습니다.');return {state:'ok',...(view.account?.id?{accountId:view.account.id}:{}),detail:'공식 로그인이 끝났습니다.'};}
    return view.state==='waiting'||view.state==='checking'?{state:'pending',detail:'공식 로그인을 기다리는 중입니다.'}:fail(view.message?String(view.message).slice(0,120):'로그인이 끝나지 않았습니다.');
   }
   const a=await account(d.platform,run,provider);return a&&a.state==='ready'?{state:'ok',accountId:a.id,detail:'이미 연결된 계정이 있습니다.'}:{state:'unknown'};
  }
  if(id==='connection'){
   const a=await account(d.platform,run,provider);if(!a)return fail('이 서비스에서 연결할 계정을 찾지 못했습니다. 공식 로그인부터 마쳐 주세요.');
   let checked:any;try{checked=(await d.platform({operation:'check',accountId:a.id,requestId:randomUUID()})).account;}catch{return fail('선택한 계정의 연결을 확인하지 못했습니다. 인증·권한·CLI 설치 상태를 확인하세요.');}
   // The account the host actually checked, as it reports it after the check.
   if(checked?.id!==a.id||checked.provider!==provider||checked.state!=='ready')return fail('확인한 계정이 이 도움의 계정과 맞지 않습니다.');
   const identity=typeof checked.identity==='string'?checked.identity.toLowerCase():null,email=run.intent.email;
   // Sign-in evidence is separate from the check: the email the official login verified, when the host kept one.
   const signedIn=(checked.verifiedEmail??a.verifiedEmail)?String(checked.verifiedEmail??a.verifiedEmail).toLowerCase():null;
   if(email&&signedIn&&signedIn!==email)return fail('공식 로그인으로 확인된 이메일이 처음 정한 이메일과 다릅니다.');
   // Each service's own check contract (platformCliHost.check): what it reads is all it proves.
   let detail:string;
   if(service==='google-workspace'){if(!identity)return fail('Drive 사용자 이메일을 읽지 못했습니다.');if(email&&identity!==email)return fail('연결된 계정이 처음 정한 이메일과 다릅니다.');detail='같은 이메일로 Drive 사용자 정보를 읽었습니다.';}
   else if(service==='supabase')detail='Supabase CLI로 프로젝트 목록에 접근했습니다. 이 검사는 사용자 신원을 따로 읽지 않습니다'+(signedIn?' · 로그인 이메일은 공식 로그인에서 확인했습니다.':'.');
   else{if(!identity)return fail('공식 CLI가 계정 이름을 돌려주지 않았습니다.');detail=service==='github'?'GitHub CLI로 로그인한 사용자 정보를 읽었습니다.':'Vercel CLI로 로그인한 사용자를 확인했습니다.';}
   const misplaced=await scope(d.platform,run,provider,a.id);if(misplaced)return misplaced;
   return {state:'ok',accountId:a.id,detail};
  }
  return {state:'unknown'};
 };
}
