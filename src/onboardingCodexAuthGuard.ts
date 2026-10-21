import {lstatSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {CodexLoginStore} from './onboardingCodexLoginStore';
import {CODEX_LOGIN_RECIPE,isCodexLoginUrl} from './onboardingCodexLogin';
import {codexLoginDigest,codexLoginEnv,codexLoginOutputSink,codexLogArguments,probeCodexLogin} from './onboardingCodexLoginRuntime';

/** No project cwd, ambient token, raw log or general-purpose execution input. */
export async function runCodexAuthGuard(args:string[]):Promise<never>{
 const parent=process.ppid;
 if(process.platform!=='darwin'||args.length!==5||!args[0]?.startsWith('/')||!/^[0-9a-f]{64}$/.test(args[1]??'')||!args[2]?.startsWith('/')||!process.env.HOME?.startsWith('/')||parent<=1)process.exit(64);
 const home=process.env.HOME;
 let executable:string;
 try{
  executable=realpathSync(args[0]!);const s=lstatSync(executable);
  if(!s.isFile()||s.size>300*1024*1024||s.mode&0o022||!(s.mode&0o111)||![0,process.getuid?.()].includes(s.uid))throw new Error('executable');
  if(await codexLoginDigest(executable)!==args[1])throw new Error('identity');
  process.kill(-process.pid,0);process.kill(parent,0);if(process.ppid!==parent)throw new Error('parent');
 }catch{process.exit(70);}
 const store=new CodexLoginStore(args[2]!);
 try{store.change(args[4]!,r=>{
  if(!r||r.id!==args[3]||r.recipe!==CODEX_LOGIN_RECIPE||r.state!=='authenticating'||r.ownerPid!==parent||r.guardPid!==null||process.ppid!==parent)throw new Error('reservation');
  return {...r,guardPid:process.pid};
 });}catch{process.exit(70);}
 let ending=false;
 const stop=()=>{if(ending)return;ending=true;try{process.kill(-process.pid,'SIGTERM');}catch{}
  setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(70);}},250);
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();
 setInterval(()=>{if(process.ppid!==parent)stop();},250);setTimeout(stop,10*60*1000);
 try{
  const sink=codexLoginOutputSink(args[2]!);
  if(await probeCodexLogin(executable!,home,sink)!=='signed-out')throw new Error('existing login');
  const current=store.receipt();
  if(!current||ending||process.ppid!==parent||current.id!==args[3]||current.state!=='authenticating'||current.guardPid!==process.pid)throw new Error('cancelled');
  // Revalidate the exact executable after probes and before starting OAuth.
  if(await codexLoginDigest(executable!)!==args[1])throw new Error('changed executable');
  if(ending||process.ppid!==parent||store.receipt()?.state!=='authenticating')throw new Error('cancelled');
  store.close();
  const child=spawn(executable!,[...codexLogArguments(sink),'login'],{cwd:'/',env:codexLoginEnv(home),stdio:['ignore','pipe','pipe'],detached:false});
  let total=0,buffer='',sent=false;
  const consume=(bytes:Buffer)=>{
   total+=bytes.length;if(total>65536){stop();return;}
   buffer=(buffer+bytes.toString('utf8')).slice(-8192);
   const plain=buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
   const candidates=[...plain.matchAll(/(https:\/\/[^\s<>"']+)(?=[\s<>"'])/g)].map(m=>m[1]!);
   for(const url of candidates){if(!sent&&isCodexLoginUrl(url)){sent=true;process.stdout.write(`URL ${url}\n`);buffer='';}}
  };
  child.stdout.on('data',consume);child.stderr.on('data',consume);child.on('error',stop);
  child.on('exit',code=>{
   buffer='';
   if(!ending&&code===0&&sent)process.stdout.write('RESULT OK\n');
   // Reap the entire owned group even when the provider exits normally.
   stop();
  });
 }catch{try{store.close();}catch{}stop();}
 return await new Promise<never>(()=>{});
}
