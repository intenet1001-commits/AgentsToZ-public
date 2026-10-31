/** The real account switcher screens over the real request handlers; fake CLIs, Keychain and APIs, no live credentials. */
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../../src/platformCliStore';
import {PlatformCliHost,type PlatformCliExecution} from '../../src/platformCliHost';
import {PlatformGithubPush} from '../../src/platformGithubPush';
import {handlePlatformCliRequest,registerPlatformNativeSwitch} from '../../src/platformCliRequest';
import {PlatformNativeSwitch} from '../../src/platformCliNativeSwitch';
import {platformCliPublicError} from '../../src/platformCliProtocol';
import {PlatformCliLoginHost} from '../../src/platformCliLogin';
import {PlatformCliEverywhere,registerPlatformCliEverywhere} from '../../src/platformCliEverywhere';
import {writeFileSync} from 'node:fs';
const directory=mkdtempSync(join(tmpdir(),'atz-account-switcher-')),app=join(directory,'app'),home=join(directory,'home'),xdg=join(directory,'xdg');
for(const d of [app,home,xdg])mkdirSync(d,{recursive:true,mode:0o700});
const secrets=new Map<string,string>();
const store=new PlatformCliStore(app,{get:async id=>secrets.get(id)??null,set:async(id,value)=>{secrets.set(id,value);}});
const tokens:Record<string,string>={personal:'ghp_'+'a'.repeat(40),company:'ghp_'+'b'.repeat(40),designer:'ghp_'+'d'.repeat(40)};
let logins=[{login:'personal',active:true},{login:'company',active:false}],gitConfig='credential.helper\nosxkeychain\0';
const who=(token?:string)=>Object.entries(tokens).find(([,t])=>t===token)?.[0];
const run=async(e:PlatformCliExecution)=>{
  const a=e.args,ok=(stdout='',code=0)=>({code,stdout,stderr:''});
  if(e.executable==='/fixture/git')return a[0]==='config'?ok(a.includes('--show-origin')?gitConfig.split('\0').filter(Boolean).map(v=>'file:/home/.gitconfig\0'+v+'\0').join(''):gitConfig):ok('',1);
  if(e.account.provider==='github'){
    if(a[0]==='auth'&&a[1]==='status')return ok(JSON.stringify({hosts:{'github.com':logins.map(l=>({state:'success',...l}))}}));
    if(a[0]==='auth'&&a[1]==='switch'){const user=a[a.indexOf('--user')+1];logins=logins.map(l=>({...l,active:l.login===user}));return ok();}
    // The sign-in's own private gh config holds just the account that was approved.
    if(a[0]==='auth'&&a[1]==='token')return ok((e.account.id==='login'?tokens.designer:tokens[a.at(-1)!])+'\n');
    if(a[0]==='auth'&&a[1]==='login'){const user=who(e.input?.trim());if(!user)return ok('',1);logins=[...logins.map(l=>({...l,active:false})),{login:user,active:true}];return ok();}
    if(a[0]==='auth'&&a[1]==='setup-git'){gitConfig='credential.https://github.com.helper\n\0credential.https://github.com.helper\n!/fixture/gh auth git-credential\0';return ok();}
    if(a[0]==='api'&&a[1]==='user'){const user=who(e.env.GH_TOKEN);return user?ok(JSON.stringify({login:user,id:user.length})):ok('',1);}
  }
  if(e.account.provider==='supabase')return ok('[]');
  if(e.account.provider==='vercel')return ok('deploy-user\n');
  return ok('',1);
};
const supabaseNative='sbp_'+'n'.repeat(40),supabaseWork='sbp_'+'w'.repeat(40);
const json=async(url:string,token:string)=>url.includes('/user/emails')?[{email:(who(token)??'someone')+'@example.test',verified:true,primary:true}]:url.endsWith('/v1/profile')?{primary_email:token===supabaseWork?'work@example.test':'native@example.test'}:{user:{email:'deploy@example.test'}};
const env={HOME:home,XDG_DATA_HOME:xdg,PATH:'/fixture'};
const host=new PlatformCliHost({store,env,run,json,nativeCredential:async()=>tokens.designer!,executable:p=>'/fixture/'+({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p],resolveProject:async id=>{if(id!=='project-one')throw Error('unregistered');return {id,cwd:directory,label:'회사 프로젝트'};}});
const keychain=new Map<string,string>([['Supabase CLI|supabase','go-keyring-base64:'+Buffer.from(supabaseNative).toString('base64')]]);
registerPlatformNativeSwitch(host,new PlatformNativeSwitch(host,{home,env,git:'/fixture/git',json,security:async(args,input)=>{
  if(args[0]==='find-generic-password'){const v=keychain.get(args[args.indexOf('-s')+1]+'|'+args[args.indexOf('-a')+1]);return v?{code:0,stdout:v,stderr:''}:{code:44,stdout:'',stderr:'could not be found'};}
  const m=/-s '([^']*)' -a '([^']*)' -w '([^']*)'/.exec(input??'');if(m)keychain.set(m[1]+'|'+m[2],m[3]!);return {code:0,stdout:'',stderr:''};
}}));
// One Supabase account connected earlier; the Mac's own Supabase login is a different one.
{const created=await store.create('supabase','work',supabaseWork,crypto.randomUUID());await store.verified(await host.check(created.id,crypto.randomUUID()),'work@example.test',crypto.randomUUID());}
// Terminals and git everywhere: real git against a private global config, startup files in the private home.
const launcher=join(directory,'agentstoz-use-mcp');writeFileSync(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
writeFileSync(join(home,'.zshrc'),'# mine\n');writeFileSync(join(home,'.gitconfig'),'[credential]\n\thelper = osxkeychain\n');
registerPlatformCliEverywhere(host,new PlatformCliEverywhere({store,launcher,git:Bun.which('git'),executable:p=>'/fixture/'+({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p],home,shell:'/bin/zsh',autoApply:true,
  env:{HOME:home,PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:join(home,'.gitconfig'),GIT_CONFIG_NOSYSTEM:'1'}}));
let approveLogin:(code:number)=>void=()=>{};
const login=new PlatformCliLoginHost(host,(_e,consume)=>{queueMicrotask(()=>consume('First copy your one-time code: ABCD-1234\n'));return {write:()=>{},kill:()=>approveLogin(1),exited:new Promise(resolve=>{approveLogin=resolve;})};});
const push=new PlatformGithubPush(host,'/fixture/git',run);
const built=await Bun.build({entrypoints:[join(import.meta.dir,'platform-account-switcher-ui.tsx')],target:'browser',outdir:join(directory,'ui'),packages:'bundle'});
if(!built.success)throw Error(built.logs.map(String).join('\n'));const script=built.outputs.find(v=>v.kind==='entry-point')!;
const css=`*{box-sizing:border-box}body{margin:0;background:#171614;color:#eee;font:14px system-ui;--line:#45413b;--ink-3:#bdb6aa;--bg-input:#181715}.fixture{width:min(720px,100%);padding:16px;margin:auto;display:grid;gap:24px}select,input{display:block;width:100%;padding:10px;font:inherit;color:inherit;background:var(--bg-input);border:1px solid var(--line);border-radius:8px}button{min-height:36px;padding:6px 12px;color:inherit;background:#302b25;border:1px solid var(--line);border-radius:8px;cursor:pointer}p{line-height:1.6;overflow-wrap:anywhere;margin:4px 0}a{color:#fa9559}h3{margin:0}`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
  const u=new URL(req.url);
  if(u.pathname==='/api/browser-profiles')return Response.json({profiles:[]});
  if(u.pathname==='/api/open-browser')return Response.json({success:true});
  if(u.pathname==='/test/state')return Response.json({logins,gitConfig,bindings:{github:store.binding('project-one','github'),supabase:store.binding('project-one','supabase'),vercel:store.binding('project-one','vercel')},defaults:store.deviceDefaults(),accounts:store.list(),supabaseProfile:existsSync(join(home,'.supabase','profile'))?readFileSync(join(home,'.supabase','profile'),'utf8'):null,zshrc:readFileSync(join(home,'.zshrc'),'utf8'),gitconfig:readFileSync(join(home,'.gitconfig'),'utf8')});
  if(u.pathname==='/test/approve-login'&&req.method==='POST'){approveLogin(0);return Response.json({approved:true});}
  if(u.pathname==='/api/agent-runtime/platform-cli'){
    try{return Response.json({success:true,...await handlePlatformCliRequest(host,push,await req.json(),false,login)});}
    catch(error){return Response.json({success:false,error:platformCliPublicError(error)},{status:400});}
  }
  if(u.pathname==='/app.js')return new Response(Bun.file(script.path),{headers:{'Content-Type':'text/javascript'}});
  return new Response(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,{headers:{'Content-Type':'text/html'}});
}});
console.log(JSON.stringify({url:server.url.toString()}));
function close(){server.stop(true);rmSync(directory,{recursive:true,force:true});process.exit(0);}process.on('SIGTERM',close);process.on('SIGINT',close);
