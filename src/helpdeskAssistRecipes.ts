import {PLATFORM_SIGNUP_URLS} from './platformCliSetupGuide';
import {GOOGLE_PROJECT_ID,type AssistCheckId,type AssistDecisions,type AssistIntent,type AssistService,type AssistStepKind,type AssistSupport,type AssistWaiting} from './helpdeskAssistProtocol';
export {GOOGLE_PROJECT_ID};
/** Reviewed recipes: every address, every element pattern and every hand-off is written here, never produced by a model.
 * A step names where it may arrive (`allow`, checked against the arrived origin+path before anything is observed), the
 * elements it may act on in order (`targets`, by role and accessible name), what means it is already done, and the
 * elements it never touches (`stopBefore`). A `stopBefore` element on screen does not stop the preparation before it: it is
 * only never clicked, and the person continues from there once the targets are done. */
export type AssistValueSource='project-name'|'app-name'|'support-email'|'contact-email'|'test-user-email';
/** `click` the matching element; `fill` types the host's value for `value` into it; `choose` clicks the element whose
 * accessible name is exactly that value (an email in a list). Values come from the person's decisions and the intent's
 * email, resolved by the host; a model never sees or supplies them. */
export type AssistTarget={action:'click'|'fill'|'choose';roles:readonly string[];name?:RegExp;value?:AssistValueSource;when?:(c:AssistContext)=>boolean};
export type AssistContext={projectId?:string;decisions:AssistDecisions;email?:string};
export type AssistDestination={origin:string;path:RegExp};
export type AssistRecipeStep={id:string;title:string;kind:AssistStepKind;
 url?:(c:AssistContext)=>string|null;allow?:readonly AssistDestination[];targets?:readonly AssistTarget[];
 /** Seen on arrival or after the targets: the step's work is already in place. */
 done?:{roles:readonly string[];name:RegExp}|((c:AssistContext&{url:string})=>boolean);stopBefore?:RegExp;
 /** After arriving (and after the targets, if any), the person decides or confirms and presses 이어서 진행. */
 decision?:{reason:AssistWaiting['reason'];note:string;skip?:(c:AssistContext)=>boolean};
 /** The project this step works in must be known first. */
 needsProject?:boolean;human?:string;check?:AssistCheckId;app?:'google-client'|'google-login'|'cli-login'|'ai-login'|'install'};
export type AssistRecipe={id:string;version:number;service:AssistService;support:AssistSupport;title:string;summary:{together:string;yours:string};
 /** The surfaces a person may still see after the help: what this recipe never sets up. */
 notIncluded:string;steps:readonly AssistRecipeStep[]};

const CONSOLE='https://console.cloud.google.com';
const consoleUrl=(path:string,projectId?:string)=>projectId&&!GOOGLE_PROJECT_ID.test(projectId)?null:CONSOLE+path+(projectId?'?project='+encodeURIComponent(projectId):'');
const consolePath=(path:RegExp):AssistDestination=>({origin:CONSOLE,path});
/** The one value read from a Console address: its validated `project` parameter. No other query or fragment is read. */
export function googleProjectFromUrl(raw:string):string|null{
 try{const u=new URL(raw);if(u.origin!==CONSOLE)return null;const p=u.searchParams.get('project');return p&&GOOGLE_PROJECT_ID.test(p)?p:null;}catch{return null;}
}
/** Origin and path only — what a log, receipt or AI may see of an address. */
export function assistAddress(raw:string):string{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?(u.origin+u.pathname).slice(0,300):u.protocol;}catch{return '';}}
export function assistAllowed(raw:string,allow:readonly AssistDestination[]|undefined):boolean{
 if(!allow?.length)return false;try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&allow.some(d=>d.origin===u.origin&&d.path.test(u.pathname));}catch{return false;}
}
/** Sign-in, consent and challenge pages: the help stops before reading them and the person continues. */
const SIGN_IN_HOSTS=['accounts.google.com','accounts.youtube.com','myaccount.google.com','appleid.apple.com','login.microsoftonline.com','github.com/login','github.com/session','github.com/sessions','supabase.com/dashboard/sign-in','vercel.com/login'];
export function assistSignInPage(raw:string):boolean{
 try{const u=new URL(raw),hp=(u.host+u.pathname).toLowerCase();return SIGN_IN_HOSTS.some(h=>hp===h||hp.startsWith(h.includes('/')?h:h+'/')||u.host===h)||/\/(o\/)?oauth2?\b|\/signin\b|\/challenge\b|\/consent\b|\/authorize\b/i.test(u.pathname);}catch{return true;}
}
/** Text that means a secret is on screen (client secret, token). The observation is dropped before any model sees it. */
export const ASSIST_SECRET_TEXT=/GOCSPX-|client[_ -]?secret|클라이언트 보안 비밀|보안 비밀번호|ya29\.|1\/\/0[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sbp_[a-f0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"|refresh_token|access_token|one-time code|인증 코드|verification code/i;

/** A name that starts with one of the given labels, then ends or goes on after a space, `*`, `:` or `(`. No `\\b`: it
 * means nothing after a Korean letter. */
const label=(...names:string[])=>new RegExp(`^(?:${names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})(?=$|[\\s*:(])`,'iu');
const exact=(...names:string[])=>new RegExp(`^(?:${names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})$`,'iu');
const NEXT=exact('next','다음','continue','계속');
const hasApp=(c:AssistContext)=>!!c.decisions.appName,hasEmail=(c:AssistContext)=>!!c.email;
export const GWS_TARGETS={applicationType:label('application type','애플리케이션 유형','어플리케이션 유형'),desktop:exact('desktop app','데스크톱 앱','데스크톱 애플리케이션')};
const GWS:AssistRecipe={id:'gws-desktop-client',version:2,service:'google-workspace',support:'assisted',title:'Google Workspace 연결',
 summary:{together:'정한 프로젝트로 이동 → Drive API 사용 설정 → 정한 앱 이름·이메일·사용자 유형 입력 → 데스크톱 앱 클라이언트 입력 준비',yours:'로그인·추가 인증, 프로젝트 만들기·정책 동의·저장 같은 확정, 클라이언트 만들기·JSON 다운로드와 앱 첨부, 최종 승인'},
 notIncluded:'이 지원은 Supabase Google 로그인, iPhone 로그인, 앱 데이터 저장소를 설정하지 않습니다. Mac 전체 로그인 전환도 하지 않습니다.',
 steps:[
  {id:'state',title:'현재 상태 확인',kind:'check',human:'gws 설치·저장된 클라이언트·연결된 계정을 읽기만 합니다.'},
  {id:'project',title:'Console 프로젝트',kind:'browser',
   url:c=>c.decisions.project?.mode==='new'?consoleUrl('/projectcreate'):consoleUrl('/home/dashboard',c.decisions.project?.mode==='existing'?c.decisions.project.id:undefined),
   allow:[consolePath(/^\/(projectselector2\/home\/dashboard|home\/dashboard|welcome|projectcreate)\/?$/)],
   done:c=>c.decisions.project?.mode==='existing'&&googleProjectFromUrl(c.url)===c.decisions.project.id,
   targets:[{action:'fill',roles:['textbox'],name:label('project name','프로젝트 이름'),value:'project-name',when:c=>c.decisions.project?.mode==='new'}],stopBefore:exact('create','만들기','생성'),
   decision:{reason:'decision',note:'새 프로젝트라면 이름과 조직·위치를 확인하고 「만들기」를 직접 눌러 주세요. 기존 프로젝트를 쓰려면 상단 프로젝트 이름에서 고릅니다. 프로젝트 화면이 열리면 「이어서 진행」을 눌러 주세요.'}},
  {id:'api',title:'Drive API 사용 설정',kind:'browser',needsProject:true,url:c=>consoleUrl('/apis/library/drive.googleapis.com',c.projectId),
   allow:[consolePath(/^\/apis\/library\/drive\.googleapis\.com\/?$/),consolePath(/^\/apis\/api\/drive\.googleapis\.com(\/[a-z]+)?\/?$/)],
   targets:[{action:'click',roles:['button'],name:exact('사용','사용 설정','enable')}],done:{roles:['button','link'],name:exact('관리','manage','api 사용 설정됨','api enabled','disable api','api 사용 중지')},check:'console'},
  {id:'branding',title:'동의 화면 · 앱 이름과 이메일',kind:'browser',needsProject:true,url:c=>consoleUrl('/auth/branding',c.projectId),allow:[consolePath(/^\/auth\/(branding|overview)\/?$/)],
   targets:[
    {action:'click',roles:['button','link'],name:exact('get started','시작하기')},
    {action:'fill',roles:['textbox'],name:label('app name','앱 이름'),value:'app-name',when:hasApp},
    {action:'click',roles:['combobox','listbox','button'],name:label('user support email','사용자 지원 이메일'),when:hasEmail},
    {action:'choose',roles:['option','menuitem'],value:'support-email',when:hasEmail},
    {action:'click',roles:['button'],name:NEXT},
    {action:'click',roles:['radio'],name:label('external','외부'),when:c=>c.decisions.audience==='external'},
    {action:'click',roles:['radio'],name:label('internal','내부'),when:c=>c.decisions.audience==='internal'},
    {action:'click',roles:['button'],name:NEXT},
    {action:'fill',roles:['textbox'],name:label('email addresses','이메일 주소'),value:'contact-email',when:hasEmail},
    {action:'click',roles:['button'],name:NEXT},
   ],stopBefore:/^(?:create|만들기|생성|save|저장)$|user data policy|사용자 데이터 정책|i agree|동의합니다/iu,
   decision:{reason:'decision',note:'입력된 앱 이름·이메일·사용자 유형을 확인하고 정책 동의와 「만들기」(또는 「저장」)를 직접 눌러 주세요. 이미 설정돼 있으면 그대로 두고 「이어서 진행」을 눌러 주세요.'}},
  {id:'audience',title:'동의 화면 · 테스트 사용자',kind:'browser',needsProject:true,url:c=>consoleUrl('/auth/audience',c.projectId),allow:[consolePath(/^\/auth\/audience\/?$/)],
   targets:[
    {action:'click',roles:['button'],name:label('add users','사용자 추가','+ add users'),when:c=>hasEmail(c)&&c.decisions.audience!=='internal'},
    {action:'fill',roles:['textbox','combobox'],name:label('email','이메일','add users','사용자 추가'),value:'test-user-email',when:c=>hasEmail(c)&&c.decisions.audience!=='internal'},
   ],stopBefore:exact('save','저장','publish app','앱 게시','게시'),
   decision:{reason:'policy',note:'개인 Gmail은 외부 사용자입니다. Testing 상태라면 연결할 이메일이 Test users에 들어갔는지 확인하고 「저장」을 직접 눌러 주세요. 앱 게시는 하지 않아도 됩니다. 조직 정책으로 막히면 관리자 확인이 필요합니다.'}},
  {id:'client',title:'데스크톱 앱 클라이언트 입력 준비',kind:'browser',needsProject:true,url:c=>consoleUrl('/auth/clients/create',c.projectId),allow:[consolePath(/^\/auth\/clients\/create\/?$/)],
   targets:[{action:'click',roles:['combobox','listbox','button'],name:GWS_TARGETS.applicationType},{action:'click',roles:['option','menuitem','radio'],name:GWS_TARGETS.desktop}],
   stopBefore:exact('create','만들기','생성'),
   decision:{reason:'secret',note:'「만들기」를 누르면 비밀값이 표시됩니다. 직접 만들고 JSON을 다운로드한 뒤 비밀값 창을 닫고 「이어서 진행」을 눌러 주세요. JSON은 열지 말고 다음 단계에서 앱에 첨부합니다.'}},
  {id:'attach',title:'JSON을 앱에 직접 첨부',kind:'app',app:'google-client',check:'client',human:'내려받은 데스크톱 앱 JSON을 아래 첨부 칸에 직접 선택하거나 끌어 놓으세요. 웹 클라이언트·서비스 계정 키는 받지 않습니다.'},
  {id:'login',title:'공식 Google 인증',kind:'app',app:'google-login',check:'login',human:'연결할 이메일로 「브라우저로 계정 연결」을 누르고 계정 선택·비밀번호·2단계 인증·권한 승인을 직접 마쳐 주세요.'},
  {id:'verify',title:'실제 연결 확인',kind:'verify',check:'connection',human:'연결한 계정으로 Drive 사용자 정보를 실제로 읽어 같은 이메일인지 확인합니다.'},
  {id:'return',title:'원래 화면으로',kind:'return'},
 ]};
const serviceRecipe=(service:'github'|'supabase'|'vercel',title:string):AssistRecipe=>({id:`${service}-account`,version:1,service,support:'guided',title,
 summary:{together:'공식 가입·로그인 화면 열기 → 기존 공식 CLI 로그인 연결 → 실제 계정 검사',yours:'가입·로그인·추가 인증·접근 승인'},
 notIncluded:'가입 화면을 연 것만으로 연결되지 않습니다. 실제 공식 로그인과 계정 검사가 끝나야 완료됩니다. 다른 프로젝트·이 Mac의 기본 로그인은 바꾸지 않습니다.',
 steps:[
  {id:'state',title:'현재 상태 확인',kind:'check',human:'CLI 설치와 이미 연결한 계정을 읽기만 합니다.'},
  {id:'signup',title:'공식 가입·로그인 화면',kind:'browser',url:()=>PLATFORM_SIGNUP_URLS[service],allow:[{origin:new URL(PLATFORM_SIGNUP_URLS[service]).origin,path:/^\/.*/}],
   decision:{reason:'sign-in',note:'계정이 없으면 직접 가입하고, 이미 있다면 이 단계는 건너뛰어도 됩니다. 마치면 「이어서 진행」을 눌러 주세요.'}},
  {id:'login',title:'공식 CLI 로그인',kind:'app',app:'cli-login',check:'login',human:'아래 「브라우저에서 로그인」으로 공식 인증을 직접 마쳐 주세요. 추가한 계정은 처음 고른 적용 범위에만 쓰입니다.'},
  {id:'verify',title:'실제 계정 확인',kind:'verify',check:'connection'},
  {id:'return',title:'원래 화면으로',kind:'return'},
 ]});
const aiRecipe=(service:'codex'|'claude',title:string):AssistRecipe=>({id:`${service}-cli`,version:1,service,support:'guided',title,
 summary:{together:'설치 상태 확인 → 공식 로그인 시작 → 공식 CLI 로그인 상태 확인',yours:'공식 로그인 화면의 계정 선택과 승인, 첫 요청으로 실제 응답 확인'},
 notIncluded:'다른 AI를 먼저 설치하라고 요구하지 않습니다. 설치와 로그인 상태는 각각 확인하지만, 모델의 실제 응답은 새 AI 호출이 되므로 이 도움에서 시험하지 않습니다.',
 steps:[
  {id:'state',title:'현재 상태 확인',kind:'check'},
  {id:'install',title:'프로그램 준비',kind:'app',app:'install',human:'「필요한 프로그램 한 번에 준비」로 빠진 프로그램만 준비합니다. Mac 승인 창은 직접 확인해 주세요.'},
  {id:'login',title:'공식 로그인',kind:'app',app:'ai-login',check:'login',human:'공식 로그인 화면에서 계정을 고르고 승인해 주세요.'},
  {id:'verify',title:'실제 응답 확인 범위',kind:'verify',check:'connection'},
  {id:'return',title:'원래 화면으로',kind:'return'},
 ]});
const entryRecipe=(service:'agy'|'hermes'|'api-key'|'mobile-google',title:string,note:string):AssistRecipe=>({id:`${service}-entry`,version:1,service,support:'entry',title,
 summary:{together:'해당 준비 화면의 안내를 같은 지원 화면에서 보여 줍니다',yours:'공식 화면의 가입·발급·승인과 앱 입력'},notIncluded:note,
 steps:[{id:'guide',title:'안내 따라 직접 진행',kind:'app',human:note},{id:'return',title:'원래 화면으로',kind:'return'}]});

export const ASSIST_RECIPES:readonly AssistRecipe[]=[GWS,serviceRecipe('github','GitHub 계정 연결'),serviceRecipe('supabase','Supabase 계정 연결'),serviceRecipe('vercel','Vercel 계정 연결'),
 aiRecipe('codex','Codex 준비'),aiRecipe('claude','Claude 준비'),
 entryRecipe('agy','Antigravity(agy) 준비','자동 진행과 실제 검사기는 아직 연결하지 않았습니다. 도구 준비 화면의 설치·로그인 결과를 확인하세요.'),
 entryRecipe('hermes','Hermes 준비','자동 진행과 실제 검사기는 아직 연결하지 않았습니다. Hermes 공식 설정과 앱의 상태 확인을 따로 진행하세요.'),
 entryRecipe('api-key','API 키 준비','공식 화면에서 직접 발급하고 앱의 보안 입력란에만 저장하세요. 키를 AI 대화에 넣지 않습니다. 저장 뒤 해당 기능의 연결 확인을 실행하세요.'),
 entryRecipe('mobile-google','모바일 Google 로그인 준비','웹 애플리케이션 클라이언트·Supabase Provider·허용 사용자·실제 폰 로그인은 각각 다른 확인입니다. 헬프데스크의 모바일 연결 화면을 이어서 사용하세요.')];
export function assistRecipe(intent:Pick<AssistIntent,'service'>):AssistRecipe{const r=ASSIST_RECIPES.find(x=>x.service===intent.service);if(!r)throw Error('이 서비스의 도움 레시피가 없습니다.');return r;}
/** A recipe step that may be automated must name its destinations; one without targets or a decision would hold control silently. */
export function validateRecipes(recipes:readonly AssistRecipe[]=ASSIST_RECIPES):string[]{
 const problems:string[]=[];
 for(const r of recipes)for(const s of r.steps){
  if(s.kind==='browser'&&!s.allow?.length)problems.push(`${r.id}/${s.id}: browser step without destinations`);
  if(s.kind==='browser'&&!s.targets?.length&&!s.decision)problems.push(`${r.id}/${s.id}: browser step with nothing to do`);
  if(s.kind==='browser'&&s.allow?.some(d=>!d.origin.startsWith('https://')))problems.push(`${r.id}/${s.id}: non-https destination`);
  for(const t of s.targets??[]){if(t.action==='choose'&&!t.value||t.action==='fill'&&!t.value||t.action!=='choose'&&!t.name)problems.push(`${r.id}/${s.id}: target without its value or name`);for(const w of ['create','만들기','save','저장'])if(s.stopBefore?.test(w)&&t.name?.test(w))problems.push(`${r.id}/${s.id}: target overlaps stopBefore`);}
 }
 return problems;
}
