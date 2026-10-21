import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../../src/platformCliStore';
import {PlatformCliHost,type PlatformCliExecution} from '../../src/platformCliHost';
import {PlatformGithubPush} from '../../src/platformGithubPush';
import {handlePlatformCliRequest} from '../../src/platformCliRequest';
import {platformCliPublicError} from '../../src/platformCliProtocol';
import {PlatformCliLoginHost} from '../../src/platformCliLogin';
import {connectNativePlatformAccount} from '../../src/platformCliSetup';
const directory=mkdtempSync(join(tmpdir(),'atz-platform-screen-')),secrets=new Map<string,string>();
const store=new PlatformCliStore(directory,{get:async id=>secrets.get(id)??null,set:async(id,value)=>{secrets.set(id,value);}});
let pushes:{account:string;repository:string}[]=[];
let holdNative=false,nativeReads=0,releaseNative:(()=>void)|undefined;
const missing=new Set<string>();const setupRequests:unknown[]=[];
const publicSetupKey='sb_publishable_synthetic_fixture_key';
let googleEmail='office@example.test';
const run=async(e:PlatformCliExecution)=>{
  const args=e.args,ok=(stdout='',code=0)=>({code,stdout,stderr:''});
  if(e.executable==='/fixture/git'){
    if(args[0]==='remote'&&args.length===1)return ok('origin\ncompany\n');
    if(args[0]==='remote')return ok('https://github.com/'+(args.at(-1)==='company'?'company/repo':'personal/repo')+'.git\n');
    if(args[0]==='symbolic-ref')return ok('main\n');if(args[0]==='rev-parse')return ok('a'.repeat(40)+'\n');
    if(args[0]==='check-ref-format')return ok();if(args[0]==='config')return ok('',1);
    if(args.includes('push')){pushes.push({account:e.account.identity!,repository:args.find(v=>v.startsWith('https://github.com/'))!});return ok();}
  }
  if(e.account.provider==='github'){
    if(args[0]==='auth'&&args[1]==='status')return ok(JSON.stringify({hosts:{'github.com':[{state:'success',active:true,login:'personal',token:'MASKED'},{state:'success',active:false,login:'company',token:'MASKED'}]}}));
    if(args[0]==='auth'&&args[1]==='token')return ok('ghp_'+(args.at(-1)==='company'?'b':'a').repeat(40));
    if(args[0]==='api'&&args[1]==='user')return ok(JSON.stringify({login:e.env.GH_TOKEN?.includes('bbbb')?'company':'personal',id:e.env.GH_TOKEN?.includes('bbbb')?2:1}));
    return ok(JSON.stringify({node_id:'REPO_'+args[1],full_name:args[1]!.slice(6),permissions:{push:true}}));
  }
  if(e.account.provider==='vercel')return ok('deploy-user\n');if(e.account.provider==='supabase')return ok(args[1]==='api-keys'?JSON.stringify([{name:'anon',api_key:publicSetupKey},{name:'service_role',api_key:'sb_secret_NEVER_SEND_TO_BROWSER'}]):JSON.stringify([{id:'a'.repeat(20),name:'아젠투지 전용 데이터',region:'ap-northeast-2'}]));
  if(args[0]==='auth'&&args[1]==='export')return ok(JSON.stringify({type:'authorized_user',client_id:'fake-client',client_secret:'fake-secret',refresh_token:'fake-refresh'}));
  return ok(JSON.stringify({user:{emailAddress:googleEmail}}));
};
const host=new PlatformCliHost({nativeCredential:async()=>{nativeReads++;if(holdNative)await new Promise<void>(resolve=>{releaseNative=resolve;});return 'ghp_'+'a'.repeat(40);},store,json:async()=>[{email:'intenet1001@gmail.com',verified:true}],env:{PATH:'/fixture',GOOGLE_WORKSPACE_CLI_CONFIG_DIR:join(directory,'no-native-gws')},executable:provider=>missing.has(provider)?null:'/fixture/'+provider,resolveProject:async(id,path)=>{if(!['project-one','project-two'].includes(id)||path&&path!=='FIXTURE')throw Error('unregistered');return {id,cwd:directory,label:id==='project-one'?'회사 프로젝트':'개인 프로젝트'};},run});
let approveLogin:(code:number)=>void;
const login=new PlatformCliLoginHost(host,(e,consume)=>{if(e.account.provider==='google-workspace')googleEmail=e.account.label;queueMicrotask(()=>consume(e.account.provider==='google-workspace'?'https://accounts.google.com/o/oauth2/auth?state=fake\n':'First copy your one-time code: ABCD-1234\n'));return {write:()=>{},kill:()=>approveLogin(1),exited:new Promise(resolve=>{approveLogin=resolve;})};});
const push=new PlatformGithubPush(host,'/fixture/git',run);
const built=await Bun.build({entrypoints:[join(import.meta.dir,'platform-cli-ui.tsx')],target:'browser',outdir:join(directory,'ui'),packages:'bundle'});
if(!built.success)throw Error(built.logs.map(String).join('\n'));const script=built.outputs.find(v=>v.kind==='entry-point')!;
const css=`*{box-sizing:border-box}body{margin:0;background:#171614;color:#eee;font:14px system-ui;--line:#45413b;--ink:#eee;--ink-3:#bdb6aa;--bg-card:#24211e;--bg-input:#181715;--accent:#fa9559;--on-accent:#1c1510}.fixture{width:min(700px,100%);padding:16px;margin:auto}label{display:block;margin:8px 0}input:not([type=file]),select{display:block;width:100%;min-width:0;padding:10px;font:inherit;color:inherit;background:var(--bg-input);border:1px solid var(--line);border-radius:8px}button{margin:5px 4px 5px 0;min-height:44px;padding:8px 12px;color:inherit;background:#302b25;border:1px solid var(--line);border-radius:8px;cursor:pointer}button:disabled{opacity:.5}p{line-height:1.6;overflow-wrap:anywhere}a{color:#fa9559}details{border:1px solid var(--line);border-radius:12px;padding:16px}summary{font-weight:600;cursor:pointer}fieldset{min-width:0;margin:16px 0;border:1px solid var(--line);border-radius:8px}dialog{width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--bg-card);color:var(--ink);padding:20px}dialog::backdrop{background:#000a}dl{display:grid;grid-template-columns:auto 1fr;gap:10px;overflow-wrap:anywhere}dd{margin:0}`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
  const u=new URL(req.url);if(u.pathname==='/api/browser-profiles')return Response.json({profiles:[]});if(u.pathname==='/test/state')return Response.json({pushes,accounts:store.list(),nativeReads});
  if(u.pathname==='/test/block-keychain'){holdNative=true;return Response.json({held:true});}
  if(u.pathname==='/test/release-keychain'){holdNative=false;releaseNative?.();return Response.json({released:true});}
  if(u.pathname==='/test/installation'&&req.method==='POST'){missing.clear();for(const provider of (await req.json()).missing??[])missing.add(provider);return Response.json({changed:true});}
  if(u.pathname==='/test/seed-supabase'&&req.method==='POST'){
    for(const email of ['app-owner@example.test','work-owner@example.test']){const a=await store.create('supabase',email,'sbp_'+'a'.repeat(40),crypto.randomUUID());await store.verified(await host.check(a.id),email,crypto.randomUUID());}return Response.json({accounts:store.list('supabase')});
  }
  if(u.pathname==='/test/setup-requests')return Response.json({requests:setupRequests});
  if(u.pathname==='/api/supabase-service-key/from-cli'&&req.method==='POST'){setupRequests.push(await req.json());return Response.json({saved:true,present:true});}
  if(u.pathname==='/test/approve-login'&&req.method==='POST'){approveLogin(0);return Response.json({approved:true});}
  if(u.pathname==='/api/agent-runtime/platform-cli'){
    const body=await req.json();if(body.operation==='connect-native')try{return Response.json({success:true,account:await connectNativePlatformAccount(host,body.provider,body.email,body.requestId,async()=>'ghp_'+'a'.repeat(40),body.purpose)});}catch(error){return Response.json({success:false,error:platformCliPublicError(error)},{status:400});}
    try{return Response.json({success:true,...await handlePlatformCliRequest(host,push,body,false,login)});}catch(error){return Response.json({success:false,error:platformCliPublicError(error)},{status:400});}
  }
  if(u.pathname==='/test/agent')try{return Response.json(await handlePlatformCliRequest(host,push,await req.json(),true));}catch(error){return Response.json({error:platformCliPublicError(error)},{status:400});}
  if(u.pathname==='/app.js')return new Response(Bun.file(script.path),{headers:{'Content-Type':'text/javascript'}});
  return new Response(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,{headers:{'Content-Type':'text/html'}});
}});
console.log(JSON.stringify({url:server.url.toString()}));
function close(){server.stop(true);rmSync(directory,{recursive:true,force:true});process.exit(0);}process.on('SIGTERM',close);process.on('SIGINT',close);
