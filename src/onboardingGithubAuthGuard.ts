import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {OnboardingGithubStore} from './onboardingGithubStore';
import {GITHUB_RECIPE} from './onboardingGithub';

/** Private fixed GitHub login adapter inside the existing packaged guard binary.
 * No remote/AI tool calls, arbitrary argv, project cwd, token or raw output forwarding. */
export async function runGithubAuthGuard(args:string[]):Promise<never>{
 const parent=process.ppid;
 if(process.platform!=='darwin'||args.length!==5||!args[0]?.startsWith('/')||!/^[0-9a-f]{64}$/.test(args[1]??'')||!args[2]?.startsWith('/')||parent<=1)process.exit(64);
 let executable:string;
 try{
  executable=realpathSync(args[0]!);const info=lstatSync(executable);
  if(!info.isFile()||info.size>100*1024*1024||info.mode&0o022||!(info.mode&0o111))throw new Error('file');
  if(createHash('sha256').update(readFileSync(executable)).digest('hex')!==args[1])throw new Error('identity');
  process.kill(-process.pid,0);process.kill(parent,0);
  if(process.ppid!==parent)throw new Error('parent');
 }catch{process.exit(70);}
 const env:Record<string,string>={PATH:'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'C',GH_PROMPT_DISABLED:'1',GH_HOST:'github.com',GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1',NO_COLOR:'1',GH_BROWSER:'/usr/bin/true',BROWSER:'/usr/bin/true'};
 if(!process.env.HOME?.startsWith('/'))process.exit(64);
 env.HOME=process.env.HOME;
 // Activate the durable reservation before any login process exists. A newer
 // cancel/check or a dead parent prevents this exact guard from launching late.
 const store=new OnboardingGithubStore(args[2]!);
 try{
  store.change(args[4]!,r=>{
   if(!r||r.id!==args[3]||r.recipe!==GITHUB_RECIPE.id||r.state!=='authenticating'||r.ownerPid!==parent||r.guardPid!==null||process.ppid!==parent)throw new Error('reservation');
   return {...r,guardPid:process.pid};
  });
 }catch{process.exit(70);}finally{store.close();}
 if(process.ppid!==parent)process.exit(70);
 const child=spawn(executable!,['auth','login','--hostname','github.com','--git-protocol','https','--web','--skip-ssh-key'],{cwd:'/',env,stdio:['ignore','pipe','pipe'],detached:false});
 let ending=false;
 const stop=()=>{
  if(ending)return;ending=true;
  try{process.kill(-process.pid,'SIGTERM');}catch{}
  setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(70);}},250);
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdin.resume();
 const parentWatch=setInterval(()=>{if(process.ppid!==parent)stop();},250);
 const deadline=setTimeout(stop,10*60*1000);
 let total=0,buffer='',sent=false;
 const consume=(chunk:Buffer)=>{
  total+=chunk.length;if(total>65536){stop();return;}
  buffer=(buffer+chunk.toString('utf8')).slice(-2048);
  // The official CLI prints one-time device codes. Discard everything else,
  // including usernames, paths, error responses and any credential fallback notice.
  const code=buffer.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  if(code&&!sent){sent=true;process.stdout.write(`CODE ${code[1]}\n`);buffer='';}
 };
 child.stdout.on('data',consume);child.stderr.on('data',consume);
 child.on('error',stop);
 const code=await new Promise<number>(resolve=>child.on('exit',code=>resolve(code??1)));
 clearInterval(parentWatch);clearTimeout(deadline);buffer='';
 if(ending)await new Promise(()=>{});
 process.exit(code===0?0:1);
}
