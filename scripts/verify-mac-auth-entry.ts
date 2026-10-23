/** Explicit external CLI entry validation. Never approves an account or opens a browser. */
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMacSetupEffects} from '../src/macSetupEffects';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost} from '../src/platformCliHost';
import {PlatformCliLoginHost,spawnPlatformLogin} from '../src/platformCliLogin';
if(process.platform!=='darwin'||!process.argv.includes('--isolated-auth-check'))throw Error('Explicit macOS --isolated-auth-check required');
const root=mkdtempSync(join(tmpdir(),'atz-auth-entry-')),home=join(root,'home'),data=join(root,'data'),bin=join(home,'.local/bin');mkdirSync(bin,{recursive:true});mkdirSync(data,{mode:0o700});
const results:unknown[]=[];let login:PlatformCliLoginHost|undefined,id:string|undefined;
try{
 for(const name of ['node','npm','git']){const existing=Bun.which(name);if(!existing)throw Error('Prerequisite missing: '+name);symlinkSync(existing,join(bin,name));}
 const tools=createMacSetupEffects(data,home,{searchPaths:[bin]});
 const vault=new Map<string,string>(),store=new PlatformCliStore(data,{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);}});
 const host=new PlatformCliHost({store,env:{HOME:home,PATH:bin+':/usr/bin:/bin',TMPDIR:process.env.TMPDIR},executable:p=>join(bin,({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p]),resolveProject:async()=>{throw Error('No project access in this check');}});
 let terminal='';
 login=new PlatformCliLoginHost(host,(execution,consume)=>spawnPlatformLogin(execution,value=>{terminal=(terminal+value).slice(-6000);consume(value);}));
 for(const provider of ['github','vercel','supabase'] as const){
  await tools.install(provider,new AbortController().signal);const installed=await tools.probe(provider);if(installed.state!=='installed')throw Error('Install verification failed: '+provider);
  terminal='';id=crypto.randomUUID();await login.start(provider,undefined,id,provider==='supabase'?'app-sync-account':'project-cli',true);
  const deadline=Date.now()+45_000;let observed=false;
  while(Date.now()<deadline){const status=login.status(id);if(status.url){observed=true;break;}if(status.state!=='waiting')break;await Bun.sleep(200);}
  const result={provider,version:installed.message,officialLoginLinkObserved:observed,authenticated:false,externalBrowserOpened:false};results.push(result);console.log(JSON.stringify(result));
  if(!observed)console.log(JSON.stringify({provider,state:login.status(id).state,diagnostic:terminal.replace(/https:\/\/[^\s]+/g,'[official link]').replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g,'[code]').replace(/gh[pousr]_[A-Za-z0-9_]+|sbp_[a-zA-Z0-9_]+/g,'[credential]').slice(-2500)}));await login.cancel(id);id=undefined;if(!observed)throw Error('Official authentication link not observed: '+provider);
 }
}finally{
 if(login&&id)await login.cancel(id).catch(()=>{});
 writeFileSync('/tmp/atz-mac-auth-entry-results.json',JSON.stringify({scope:'temporary HOME, actual official CLI, initiation only; no browser or account approval',results},null,2));rmSync(root,{recursive:true,force:true});
}
