import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MobileGoogleSetup} from '../../src/mobileGoogleSetup';
const directory=mkdtempSync(join(tmpdir(),'atz-google-onboarding-ui-')),ref='a'.repeat(20),account={id:'pcli_fixture_owner',revision:'fixture-account-1',email:'owner@example.test'};
const auth:Record<string,unknown>={external_google_enabled:false,rate_limit_email_sent:2,uri_allow_list:'https://existing.example/callback'};
const clientFile=join(directory,'synthetic-web-client.json');
writeFileSync(clientFile,JSON.stringify({web:{project_id:'fixture-google',client_id:'123-fixture.apps.googleusercontent.com',client_secret:'GOCSPX_SYNTHETIC_TEST_ONLY',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',redirect_uris:[`https://${ref}.supabase.co/auth/v1/callback`]}}),{mode:0o600});
let patches=0,reads=0;const links:string[]=[],noticeSavedAt=new Date(Date.now()-60000).toISOString();
const setup=new MobileGoogleSetup(directory,{target:()=>({ref}),account:async id=>{if(id!==account.id)throw Error();return account;},read:async()=>{reads++;return structuredClone(auth);},patch:async(_ref,_account,patch)=>{patches++;Object.assign(auth,patch);}});
const built=await Bun.build({entrypoints:[join(import.meta.dir,'google-onboarding-ui.tsx')],target:'browser',packages:'bundle',outdir:join(directory,'ui')});if(!built.success)throw Error(built.logs.map(String).join('\n'));const script=built.outputs.find(o=>o.kind==='entry-point')!;
const css=`*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#171614;color:#eee;--bg:#171614;--line:#48423a;--text-primary:#eee;--accent-soft:#34291e}main{width:min(900px,100%);padding:20px;margin:auto}p,li{line-height:1.7;overflow-wrap:anywhere}button,a.helpdesk-button{display:inline-flex;align-items:center;min-height:44px;margin:4px;padding:8px 12px;background:#352e25;border:1px solid #74624d;border-radius:8px;color:#fff;font:inherit;text-decoration:none;cursor:pointer}button:disabled{opacity:.5}label{display:block;margin:12px 0}input:not([type=checkbox]),select{display:block;width:100%;padding:10px;font:inherit;background:#222;color:#eee}section{margin:20px 0;padding:12px;border:1px solid #48423a;border-radius:10px}textarea{width:100%;height:160px}dialog::backdrop{background:#000b}.helpdesk-actions{display:flex;flex-wrap:wrap}.helpdesk-checklist{padding-left:24px}`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
  const u=new URL(req.url);
  if(u.pathname==='/test/seed-provider'&&req.method==='POST'){Object.assign(auth,{external_google_enabled:true,external_google_client_id:'123-fixture.apps.googleusercontent.com',external_google_secret:'GOCSPX_SYNTHETIC_TEST_ONLY'});return Response.json({ready:true});}
  if(u.pathname==='/api/agent-runtime/helpdesk')try{return Response.json({googleLogin:await setup.handle(await req.json())});}catch(e){return Response.json({error:e instanceof Error?e.message:'fixture error'},{status:409});}
  if(u.pathname==='/api/agent-runtime/platform-cli')return Response.json({googleClient:{ready:true,projectId:'fixture-google'}});
  if(u.pathname==='/api/open-browser'){const r=await req.json();links.push(r.url);return Response.json({success:true});}
  if(u.pathname==='/api/project-memory/auto-checkpoint/status')return Response.json({sessions:[{sourceAgent:'claude',sessionId:'fixture-conversation',projectName:'격리 QA',lastCheckpointAt:noticeSavedAt,lastCheckpointThreshold:70}],recoveryCheckpoints:[]});
  if(u.pathname==='/test/state')return Response.json({patches,reads,links,googleConfigured:auth.external_google_enabled===true});
  if(u.pathname==='/app.js')return new Response(Bun.file(script.path),{headers:{'Content-Type':'text/javascript'}});
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>격리 Google onboarding QA</title><style>${css}</style><div id="root"></div><script type="module" src="/app.js"></script></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}});
console.log(JSON.stringify({url:server.url.toString(),clientFile}));
function close(){server.stop(true);rmSync(directory,{recursive:true,force:true});process.exit(0);}process.on('SIGTERM',close);process.on('SIGINT',close);
