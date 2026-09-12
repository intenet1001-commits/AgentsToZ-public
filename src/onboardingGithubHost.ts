import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstatSync,realpathSync,existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,mkdirSync,linkSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {OnboardingGithubStore} from './onboardingGithubStore';
import {GITHUB_RECIPE,type GithubSetupReceipt} from './onboardingGithub';
import {diagnoseGithubAuth,type GithubAuthProbe} from './onboardingGithubAuthDiagnosis';
import {resolveAgentRuntimeGuardCommand} from './agentRuntimeGuardLauncher';

export interface GithubHostEffects {
 platform:NodeJS.Platform; supported?:boolean;
 probe:()=>Promise<'missing'|GithubAuthProbe>;
 prepare:(signal:AbortSignal)=>Promise<void>;
 installFile:(signal:AbortSignal)=>Promise<void>;
 openLoginPage:()=>Promise<void>;
 login:(code:(value:string)=>void)=>{done:Promise<void>;cancel:()=>void};
}
function resultState(result:'missing'|GithubAuthProbe):GithubSetupReceipt['state']{return result==='ready'||result==='installed'||result==='storage-review'?result:'needs-review';}
function alive(pid:number|null){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}}

export class OnboardingGithubHost {
 private task:Promise<void>|null=null;
 private abort:AbortController|null=null;
 private stopLogin:(()=>void)|null=null;
 private code:string|null=null;
 private disposed=false;
 constructor(private store:OnboardingGithubStore,private effects:GithubHostEffects){}
 status(){const receipt=this.store.receipt();return {supported:this.effects.platform==='darwin'&&this.effects.supported!==false,receipt,code:this.code,interrupted:!!receipt && ['preparing','installing','authenticating'].includes(receipt.state) && !this.task && !alive(receipt.ownerPid)};}
 private idle(r:GithubSetupReceipt|null){
  if(this.disposed||this.task)throw new Error('이전 작업이 진행 중입니다.');
  if(r?.ownerPid && alive(r.ownerPid))throw new Error('다른 앱에서 진행 중입니다.');
  if(r?.guardPid && alive(r.guardPid))throw new Error('이전 로그인 종료를 확인 중입니다.');
 }
 private checked(r:GithubSetupReceipt|null):GithubSetupReceipt{
  if(!r||r.recipe!==GITHUB_RECIPE.id)throw new Error('설치 내용을 다시 검토해 주세요.');return r;
 }
 async act(operation:string,expected:string){
  if(this.effects.platform!=='darwin'||this.effects.supported===false)throw new Error('현재 이 설치 도우미는 Apple Silicon Mac에서 사용할 수 있습니다.');
  const original=this.store.receipt();
  if((original?.revision??'0')!==expected)throw new Error('준비 상태가 바뀌었습니다. 다시 읽어 주세요.');
  if(operation==='open-login'){
   if(original?.state!=='authenticating'||!this.code)throw new Error('로그인 코드를 먼저 확인해 주세요.');
   await this.effects.openLoginPage();return this.status();
  }
  if(operation==='cancel'){
   if(original?.ownerPid && original.ownerPid!==process.pid && alive(original.ownerPid))throw new Error('다른 앱에서 진행 중입니다.');
   this.abort?.abort();this.stopLogin?.();this.code=null;
   if(original)this.store.change(expected,r=>({...r!,state:'cancelled',ownerPid:null}));
   return this.status();
  }
  this.idle(original);
  if(operation==='review'){this.store.review(expected);return this.status();}
  const r=this.checked(original);
  if(operation==='check'){
   const result=await this.effects.probe();
   this.store.change(expected,current=>({...current!,state:resultState(result),ownerPid:null,guardPid:null}));
   this.code=null;return this.status();
  }
  if(operation==='install'){
   if(r.state!=='reviewed'||Date.now()<Date.parse(r.reviewedAt)||Date.now()-Date.parse(r.reviewedAt)>300000)throw new Error('설치 내용을 다시 검토해 주세요.');
   let current=this.store.change(expected,x=>({...x!,state:'preparing',ownerPid:process.pid,guardPid:null}));
   const abort=new AbortController();this.abort=abort;
   this.task=(async()=>{
    try{
     const before=await this.effects.probe();
     if(abort.signal.aborted)return;
     if(before==='unknown')throw new Error('unknown');
     if(before!=='missing'){
      current=this.store.change(current.revision,x=>({...x!,state:resultState(before),ownerPid:null}));return;
     }
     await this.effects.prepare(abort.signal);
     if(abort.signal.aborted)return;
     // Durable intent precedes the fixed local file mutation. Restart only reads back.
     current=this.store.change(current.revision,x=>({...x!,state:'installing'}));
     await this.effects.installFile(abort.signal);
     const after=await this.effects.probe();
     current=this.store.change(current.revision,x=>({...x!,state:resultState(after),ownerPid:null}));
    }catch{try{this.store.change(current.revision,x=>({...x!,state:'needs-review',ownerPid:null}));}catch{/* cancellation/newer result owns the row */}}
    finally{this.abort=null;this.task=null;}
   })();
   return this.status();
  }
  if(operation==='login'){
   if(!['installed','needs-review','cancelled'].includes(r.state))throw new Error('설치 결과부터 확인해 주세요.');
   const result=await this.effects.probe();
   if(result==='ready'){this.store.change(expected,x=>({...x!,state:'ready',ownerPid:null,guardPid:null}));return this.status();}
   if(result!=='installed')throw new Error('설치와 연결 상태를 먼저 확인해 주세요.');
   let current=this.store.change(expected,x=>({...x!,state:'authenticating',ownerPid:process.pid,guardPid:null}));
   this.code=null;
   let login:ReturnType<GithubHostEffects['login']>;
   try{
    login=this.effects.login(code=>{const latest=this.store.receipt();if(latest?.id===current.id && latest.state==='authenticating')this.code=code;});
   }catch{this.store.change(current.revision,x=>({...x!,state:'needs-review',ownerPid:null,guardPid:null}));return this.status();}
   this.stopLogin=login.cancel;
   this.task=(async()=>{
    try{await login.done;const after=await this.effects.probe();const latest=this.store.receipt();if(latest?.id===current.id&&latest.state==='authenticating')this.store.change(latest.revision,x=>({...x!,state:after==='ready'||after==='storage-review'?after:'needs-review',ownerPid:null,guardPid:null}));}
    catch{try{const latest=this.store.receipt();if(latest?.id===current.id&&latest.state==='authenticating')this.store.change(latest.revision,x=>({...x!,state:'needs-review',ownerPid:null,guardPid:null}));}catch{/* newer cancel receipt wins */}}
    finally{this.code=null;this.stopLogin=null;this.task=null;const latest=this.store.receipt();if(latest?.id===current.id&&latest.state==='cancelled'){try{this.store.change(latest.revision,x=>({...x!,guardPid:null,ownerPid:null}));}catch{}}}
   })();
   return this.status();
  }
  throw new Error('허용되지 않은 설치 요청입니다.');
 }
 async close(){this.disposed=true;this.abort?.abort();this.stopLogin?.();await this.task;this.code=null;}
}

const cleanEnv=()=>({HOME:homedir(),PATH:'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',LC_ALL:'C',GH_PROMPT_DISABLED:'1',GH_HOST:'github.com',GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1',NO_COLOR:'1'});
function command(exe:string,args:string[],timeout=3000):Promise<{ok:boolean;stdout:string;output:string;timedOut:boolean}>{
 return new Promise(resolve=>execFile(exe,args,{cwd:'/',env:cleanEnv(),timeout,maxBuffer:65536,encoding:'utf8'},(error:any,stdout,stderr)=>resolve({ok:!error,stdout,output:`${stdout}\n${stderr}`,timedOut:!!error?.killed})));
}
function githubExecutable():string|null{
 for(const path of ['/usr/local/bin/gh','/opt/homebrew/bin/gh',join(homedir(),'.local/bin/gh')]){
  if(!existsSync(path))continue;
  const canonical=realpathSync(path),info=lstatSync(canonical);
  if(!info.isFile()||!(info.mode&0o111)||info.mode&0o022||![0,process.getuid?.()].includes(info.uid))throw new Error('GitHub 설치 파일을 확인해 주세요.');
  return canonical;
 }
 return null;
}
async function downloadPackage(signal:AbortSignal):Promise<Uint8Array>{
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(120000)]);
 let url:string=GITHUB_RECIPE.url;
 for(let redirects=0;redirects<4;redirects++){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||!['github.com','release-assets.githubusercontent.com'].includes(u.hostname))throw new Error('download origin');
  const res=await fetch(url,{redirect:'manual',signal:deadline,credentials:'omit'});
  if(res.status>=300&&res.status<400){const next=res.headers.get('location');await res.body?.cancel();if(!next)throw new Error('redirect');url=new URL(next,url).href;continue;}
  if(!res.ok||!res.body)throw new Error('download unavailable');
  const bytes=new Uint8Array(GITHUB_RECIPE.bytes);let size=0;const reader=res.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(size+value.length>bytes.length)throw new Error('download too large');bytes.set(value,size);size+=value.length;}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(size!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==GITHUB_RECIPE.sha256)throw new Error('checksum');
  return bytes;
 }
 throw new Error('redirect limit');
}
export function createGithubHostEffects(appData:string):GithubHostEffects{
 const customAuthContext=!!(process.env.GH_CONFIG_DIR||process.env.XDG_CONFIG_HOME||process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.PORTMGR_GH_PATH||process.env.GH_HOST);
 const folder=join(appData,'onboarding');const archive=join(folder,'github-2.100.0-arm64.zip');
 const prepared=join(folder,'github-2.100.0-arm64.bin');
 async function verifyBinary(file:string){
  const info=lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==GITHUB_RECIPE.binaryBytes||info.nlink!==1||info.uid!==process.getuid?.()||info.mode&0o022)throw new Error('binary');
  if(createHash('sha256').update(readFileSync(file)).digest('hex')!==GITHUB_RECIPE.binarySha256)throw new Error('checksum');
  if(!(await command('/usr/bin/codesign',['--verify','--strict',file])).ok)throw new Error('signature');
  const signature=await command('/usr/bin/codesign',['-dv','--verbose=4',file]);
  if(!signature.ok||!signature.output.includes(`TeamIdentifier=${GITHUB_RECIPE.teamId}`)||!signature.output.includes('Identifier=gh'))throw new Error('signer');
 }
 function keepValidCache(file:string,bytes:number,digest:string):boolean {
  if(!existsSync(file))return false;
  const info=lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.())throw new Error('unsafe cache');
  if(info.size===bytes&&createHash('sha256').update(readFileSync(file)).digest('hex')===digest)return true;
  // Only this recipe's private expendable cache is repaired. Installed tools are never removed.
  unlinkSync(file);return false;
 }
 function privateDirectory(path:string){
  mkdirSync(path,{recursive:true,mode:0o700});const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||info.mode&0o022)throw new Error('install directory');
 }
 return {
  platform:process.platform,supported:process.arch==='arm64',
  probe:async()=>{
   if(customAuthContext)return 'unknown'; // Never silently switch a configured profile/token context.
   let executable:string|null;try{executable=githubExecutable();}catch{return 'unknown';}
   if(!executable)return 'missing';
   if(!(await command(executable,['--version'])).ok)return 'unknown';
   return diagnoseGithubAuth(await command(executable,['auth','status','--active','--hostname','github.com','--json','hosts']));
  },
  prepare:async signal=>{
   if(keepValidCache(prepared,GITHUB_RECIPE.binaryBytes,GITHUB_RECIPE.binarySha256)){await verifyBinary(prepared);return;}
   if(!keepValidCache(archive,GITHUB_RECIPE.bytes,GITHUB_RECIPE.sha256)){
    const bytes=await downloadPackage(signal);if(signal.aborted)throw new Error('cancelled');
    const staging=join(folder,'github-2.100.0-download.part');
    try{writeFileSync(staging,bytes,{flag:'wx',mode:0o600});renameSync(staging,archive);}
    finally{bytes.fill(0);try{unlinkSync(staging);}catch{}}
   }
   const info=lstatSync(archive);
   if(!info.isFile()||info.isSymbolicLink()||info.size!==GITHUB_RECIPE.bytes||info.nlink!==1||createHash('sha256').update(readFileSync(archive)).digest('hex')!==GITHUB_RECIPE.sha256)throw new Error('archive');
   if(signal.aborted)throw new Error('cancelled');
   // Extract ONE fixed entry to memory, never archive paths to the filesystem.
   const bytes=await new Promise<Buffer>((resolve,reject)=>execFile('/usr/bin/unzip',['-p',archive,GITHUB_RECIPE.entry],{cwd:'/',env:cleanEnv(),timeout:15000,maxBuffer:GITHUB_RECIPE.binaryBytes+1,encoding:'buffer',signal},(error,stdout)=>error?reject(new Error('extract')):resolve(stdout)));
   try{if(signal.aborted)throw new Error('cancelled');if(bytes.length!==GITHUB_RECIPE.binaryBytes||createHash('sha256').update(bytes).digest('hex')!==GITHUB_RECIPE.binarySha256)throw new Error('binary checksum');
    writeFileSync(prepared,bytes,{flag:'wx',mode:0o700});await verifyBinary(prepared);
   }finally{bytes.fill(0);}
  },
  installFile:async signal=>{
   await verifyBinary(prepared);if(signal.aborted)throw new Error('cancelled');
   const local=join(homedir(),'.local'),bin=join(local,'bin');privateDirectory(local);privateDirectory(bin);
   const target=join(bin,'gh'),staging=join(bin,'.agentstoz-gh-2.100.0.stage');
   // Never replace another installation, including a dangling symlink.
   try{lstatSync(target);throw new Error('existing installation');}catch(e:any){if(e.code!=='ENOENT')throw e;}
   if(!existsSync(staging)){writeFileSync(staging,readFileSync(prepared),{flag:'wx',mode:0o700});}
   await verifyBinary(staging);if(signal.aborted)throw new Error('cancelled');
   const fd=openSync(staging,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
   linkSync(staging,target); // atomic no-replace commit on the destination filesystem
   unlinkSync(staging);
   const directory=openSync(bin,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
  },
  openLoginPage:async()=>{if(!(await command('/usr/bin/open',['https://github.com/login/device'])).ok)throw new Error('browser');},
  login:onCode=>{
   const executable=githubExecutable(),guard=resolveAgentRuntimeGuardCommand();
   if(!executable||!guard)throw new Error('로그인 도우미를 확인하지 못했습니다.');
   const identity=createHash('sha256').update(readFileSync(executable)).digest('hex');
   const receipts=new OnboardingGithubStore(appData);let receipt:GithubSetupReceipt|null;try{receipt=receipts.receipt();}finally{receipts.close();}
   if(!receipt)throw new Error('login reservation');
   const child=Bun.spawn([...guard,'agentstoz-onboarding-github-auth-v1',executable,identity,appData,receipt.id,receipt.revision],{
    cwd:'/',env:cleanEnv(),stdin:'pipe',stdout:'pipe',stderr:'ignore',detached:true,
   });
   const cancel=()=>{try{child.stdin.end();}catch{}};
   const done=(async()=>{
    const reader=child.stdout.getReader();let buffer='';let total=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>4096)throw new Error('guard output');buffer+=new TextDecoder().decode(value);
     let line:number;while((line=buffer.indexOf('\n'))>=0){const message=buffer.slice(0,line);buffer=buffer.slice(line+1);if(/^CODE [A-Z0-9]{4}-[A-Z0-9]{4}$/.test(message))onCode(message.slice(5));}
    }if(await child.exited!==0)throw new Error('login incomplete');}
    finally{buffer='';reader.releaseLock();cancel();}
   })();
   return {done,cancel};
  },
 };
}
