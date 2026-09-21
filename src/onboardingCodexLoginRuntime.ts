import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream,lstatSync,realpathSync,mkdirSync,symlinkSync,readlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {diagnoseCodexLogin} from './onboardingCodexDiagnosis';
import type {CodexLoginProbe} from './onboardingCodexLoginHost';
export function codexLoginEnv(home=homedir()):NodeJS.ProcessEnv{
 return {HOME:home,PATH:'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',LC_ALL:'C',BROWSER:'/usr/bin/true',RUST_LOG:'off',NO_COLOR:'1'};
}
export function customCodexLoginContext(env=process.env){
 return ['CODEX_HOME','CODEX_INSTALL_DIR','PORTMGR_CODEX_PATH','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','CODEX_LOGIN_BASE_URL','CODEX_AUTH_JSON','CODEX_CA_CERTIFICATE','SSL_CERT_FILE','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY'].some(k=>!!env[k]);
}
function stat(path:string){try{return lstatSync(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
export function resolveCodexLoginExecutable(home=homedir()):string|null{
 const candidates=[
  '/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex',
  join(home,'.local/bin/codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex',
  join(home,'.bun/bin/codex'),join(home,'.npm-global/bin/codex'),join(home,'.volta/bin/codex'),
  ...(process.env.PATH??'').split(':').filter(isAbsolute).map(p=>join(p,'codex')),
 ];
 for(const path of candidates){if(!stat(path))continue;const file=realpathSync(path),s=lstatSync(file);
  if(!s.isFile()||!(s.mode&0o111)||s.mode&0o022||![0,process.getuid?.()].includes(s.uid)||s.size>300*1024*1024)throw new Error('실행 파일 확인 필요');
  return file;
 }return null;
}
export async function codexLoginDigest(path:string){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
/** CLI login has a dedicated log. Its fixed filename points to /dev/null, not a transcript. */
export function codexLoginOutputSink(appData:string):string{
 const parent=join(appData,'onboarding'),folder=join(parent,'codex-login-output');
 for(const p of [appData,parent,folder]){
  if(!stat(p))mkdirSync(p,{mode:0o700});const s=lstatSync(p);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||s.mode&(p===appData?0o022:0o077))throw new Error('로그인 출력 보호 확인 필요');
 }
 const file=join(folder,'codex-login.log');
 if(!stat(file))symlinkSync('/dev/null',file);
 const s=lstatSync(file);if(!s.isSymbolicLink()||s.uid!==process.getuid?.()||readlinkSync(file)!=='/dev/null')throw new Error('로그인 출력 보호 확인 필요');
 return folder;
}
export const codexLogArguments=(sink:string)=>['-c',`log_dir=${JSON.stringify(sink)}`];
export function codexLoginCommand(executable:string,args:string[],env:NodeJS.ProcessEnv,timeout=3000):Promise<{ok:boolean;output:string;timedOut:boolean}>{
 return new Promise(resolve=>execFile(executable,args,{cwd:'/',env,timeout,maxBuffer:65536,encoding:'utf8'},(error:any,out,err)=>resolve({ok:!error,output:`${out}\n${err}`,timedOut:!!error?.killed})));
}
export function codexAuthFileProtected(home:string):boolean{
 const folder=stat(join(home,'.codex'));
 if(folder&&(!folder.isDirectory()||folder.isSymbolicLink()||folder.uid!==process.getuid?.()||folder.mode&0o022))return false;
 const s=stat(join(home,'.codex/auth.json'));
 return !s||(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid?.()&&!(s.mode&0o077));
}
export async function probeCodexLogin(executable:string,home:string,sink:string):Promise<CodexLoginProbe>{
 if(!codexAuthFileProtected(home))return 'storage-review';
 const env=codexLoginEnv(home),version=await codexLoginCommand(executable,['--version'],env);
 if(!version.ok||!/^codex-cli \d+\.\d+\.\d+\S*\s*$/.test(version.output.trim()))return 'unknown';
 const result=diagnoseCodexLogin(await codexLoginCommand(executable,[...codexLogArguments(sink),'login','status'],env));
 return result.authenticationEvidence==='cached'?'configured':result.state==='needs-login'?'signed-out':'unknown';
}
