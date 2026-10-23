import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {createReadStream,createWriteStream,lstatSync,realpathSync,mkdirSync,unlinkSync,symlinkSync,readlinkSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import {join,dirname,isAbsolute,relative} from 'node:path';
import {homedir} from 'node:os';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {CODEX_INSTALL_RECIPE as recipe} from './onboardingCodexInstall';
import type {CodexInstallEffects} from './onboardingCodexInstallHost';
import {diagnoseCodexLogin} from './onboardingCodexDiagnosis';

function stat(path:string){try{return lstatSync(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
function clearPartial(path:string,limit:number){
  const s=stat(path);if(!s)return;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||s.size>limit)throw new Error('unsafe partial cache');
  unlinkSync(path);
}
function syncFile(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
async function digest(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
function ownedFile(path:string,size:number){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||s.mode&0o022||s.size!==size)throw new Error('file validation');}
async function verifyFile(path:string,file:{bytes:number;sha256:string}){ownedFile(path,file.bytes);if(await digest(path)!==file.sha256)throw new Error('checksum');}
function privateDirectory(base:string,path:string){
  const rel=relative(base,path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('directory');
  for(const p of [base,...rel.split('/').filter(Boolean).map((_,i,a)=>join(base,...a.slice(0,i+1)))]){
    if(!stat(p))mkdirSync(p,{mode:0o700});const s=lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||s.mode&0o022)throw new Error('directory');
  }
}
function command(exe:string,args:string[],env:NodeJS.ProcessEnv,timeout=3000):Promise<{ok:boolean;output:string;timedOut:boolean}>{
  return new Promise(resolve=>execFile(exe,args,{cwd:'/',env,timeout,maxBuffer:65536,encoding:'utf8'},(e:any,out,err)=>resolve({ok:!e,output:`${out}\n${err}`,timedOut:!!e?.killed})));
}
async function boundedWrite(input:NodeJS.ReadableStream,path:string,limit:number,signal:AbortSignal){
  let total=0;
  const bound=new Transform({transform(chunk,_,callback){total+=chunk.length;callback(total>limit?new Error('size limit'):null,chunk);}});
  await pipeline(input,bound,createWriteStream(path,{flags:'wx',mode:0o700}),{signal});
  if(total!==limit)throw new Error('size mismatch');
}

/** Test options are local dependency injection only; the HTTP body accepts no paths/env. */
export function createCodexInstallEffects(appData:string,options:{home?:string;candidates?:string[]}={}):CodexInstallEffects {
  const home=options.home??homedir();
  const env={...process.env,HOME:home,LANG:'en_US.UTF-8',LC_ALL:'C',NO_COLOR:'1'};
  const cache=join(appData,'onboarding'),archive=join(cache,'codex-0.154.0-arm64.tar.gz');
  const release=join(home,'.local/share/agentstoz/tools',recipe.id),bin=join(home,'.local/bin');
  const candidates=options.candidates??Array.from(new Set([
    ...(process.env.PATH??'').split(':').filter(isAbsolute).map(p=>join(p,'codex')),
    join(bin,'codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex',
    join(home,'.bun/bin/codex'),join(home,'.npm-global/bin/codex'),join(home,'.volta/bin/codex'),
  ]));
  const customContext=!!(process.env.CODEX_HOME||process.env.CODEX_INSTALL_DIR||process.env.PORTMGR_CODEX_PATH);
  function existing(){
    for(const path of candidates){
      if(!stat(path))continue;
      const resolved=realpathSync(path),s=lstatSync(resolved);
      if(!s.isFile()||!(s.mode&0o111)||s.mode&0o022||![0,process.getuid?.()].includes(s.uid))throw new Error('existing installation');
      return resolved;
    }
    return null;
  }
  async function verifyPackage(){
    for(const file of recipe.files){
      const path=join(release,file.entry);await verifyFile(path,file);
      if(file.identifier){
        if(!(await command('/usr/bin/codesign',['--verify','--strict',path],env)).ok)throw new Error('signature');
        const signature=await command('/usr/bin/codesign',['-dv','--verbose=4',path],env);
        if(!signature.ok||!signature.output.split('\n').includes(`TeamIdentifier=${recipe.teamId}`)
          ||!signature.output.split('\n').includes(`Identifier=${file.identifier}`))throw new Error('signer');
      }
    }
  }
  function linkMatches(name:string){const p=join(bin,name),s=stat(p);return !!s&&s.isSymbolicLink()&&readlinkSync(p)===join(release,'bin',name);}
  return {
    supported:process.platform==='darwin'&&process.arch==='arm64',
    probe:async()=>{
      // An explicitly configured installation/profile is never silently switched.
      if(customContext)return 'unknown';
      try{
        const executable=existing();if(!executable)return 'missing';
        if(stat(join(release,'bin/codex'))&&executable===realpathSync(join(release,'bin/codex'))){
          await verifyPackage();
          // A crash between the two no-replace links is read back as incomplete.
          if(!linkMatches('codex')||!linkMatches('codex-code-mode-host'))return 'unknown';
        }
        const version=await command(executable,['--version'],env);
        if(!version.ok||!/^codex-cli \d+\.\d+\.\d+(?:\S*)\s*$/.test(version.output.trim()))return 'unknown';
        const login=diagnoseCodexLogin(await command(executable,['login','status'],env));
        return login.authenticationEvidence==='cached'?'configured':login.state==='needs-login'?'installed':'unknown';
      }catch{return 'unknown';}
    },
    prepare:async signal=>{
      privateDirectory(appData,cache);signal.throwIfAborted();
      if(stat(archive)){await verifyFile(archive,recipe);return;}
      const part=join(cache,'codex-0.154.0-arm64.part');
      clearPartial(part,recipe.bytes);
      const deadline=AbortSignal.any([signal,AbortSignal.timeout(180000)]);
      try{
        const response=await fetch(recipe.url,{redirect:'error',credentials:'omit',signal:deadline});
        if(!response.ok||!response.body)throw new Error('download');
        await boundedWrite(Readable.fromWeb(response.body as any),part,recipe.bytes,deadline);
        await verifyFile(part,recipe);signal.throwIfAborted();syncFile(part);
        // The host receipt serializes this recipe; no unverified cache is reused.
        if(stat(archive))throw new Error('cache changed');renameSync(part,archive);syncFile(cache);
      }finally{if(stat(part))unlinkSync(part);}
    },
    install:async signal=>{
      await verifyFile(archive,recipe);signal.throwIfAborted();
      privateDirectory(home,release);privateDirectory(home,bin);
      // Neither an existing executable nor a dangling link is replaced.
      for(const name of ['codex','codex-code-mode-host'])if(stat(join(bin,name))&&!linkMatches(name))throw new Error('existing tool');
      for(const file of recipe.files){
        signal.throwIfAborted();const target=join(release,file.entry);privateDirectory(home,dirname(target));
        if(stat(target)){await verifyFile(target,file);continue;}
        const part=`${target}.part`;
        clearPartial(part,file.bytes);
        const deadline=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
        const child=spawn('/usr/bin/tar',['-xOzf',archive,file.entry],{cwd:'/',env,stdio:['ignore','pipe','ignore'],signal:deadline});
        const exited=new Promise<boolean>(resolve=>{child.on('error',()=>resolve(false));child.on('close',code=>resolve(code===0));});
        try{
          // Only fixed entries go to exclusive files; archive paths are never extracted.
          await boundedWrite(child.stdout,part,file.bytes,deadline);
          if(!await exited)throw new Error('extract');
          await verifyFile(part,file);signal.throwIfAborted();syncFile(part);
          if(stat(target))throw new Error('package changed');renameSync(part,target);syncFile(dirname(target));
        }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;if(stat(part))unlinkSync(part);}
      }
      await verifyPackage();signal.throwIfAborted();
      for(const name of ['codex-code-mode-host','codex']){
        signal.throwIfAborted();
        if(!linkMatches(name))symlinkSync(join(release,'bin',name),join(bin,name));
        syncFile(bin);
      }
    },
  };
}
