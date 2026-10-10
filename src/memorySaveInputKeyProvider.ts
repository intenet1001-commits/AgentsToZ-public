import {execFile,spawn} from 'node:child_process';
import {saveDigest,saveToken} from './memorySaveContract';

export const MEMORY_INPUT_KEYCHAIN_SERVICE='com.portmanager.portmanager.memory-save-input.v1';
export class MemoryInputKeyError extends Error {
 constructor(readonly code:'INVALID_ID'|'UNSUPPORTED'|'MISSING'|'UNAVAILABLE'|'MALFORMED'){super(`Memory input key: ${code}`);}
}
export interface MemoryInputKeyResult {status:number|null;stdout:Buffer}
export type MemoryInputKeyRunner=(command:string,args:readonly string[],input?:Buffer)=>Promise<MemoryInputKeyResult>;
export function memoryInputKeyAccount(installationId:string):string {
 if(!saveToken(installationId))throw new MemoryInputKeyError('INVALID_ID');
 return saveDigest(['memory-save-input-key-v1',installationId]);
}
/** Fixed executable, no shell and bounded output/time. Add uses a detached
 * private stdin pipe. Readers clear the returned stdout on every outcome. */
const run:MemoryInputKeyRunner=(command,args,input)=>new Promise(resolve=>{
 if(input!==undefined){
  const child=spawn(command,[...args],{detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'},windowsHide:true});
  const chunks:Buffer[]=[];let bytes=0,errors=0,failed=false;
  const stop=()=>{failed=true;child.kill('SIGKILL');};const timer=setTimeout(stop,5000);
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256){chunk.fill(0);stop();}else chunks.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{errors+=chunk.length;chunk.fill(0);if(errors>256)stop();});
  child.on('error',()=>{failed=true;});
  child.on('close',code=>{clearTimeout(timer);const stdout=Buffer.concat(chunks);for(const chunk of chunks)chunk.fill(0);resolve({status:failed?null:code,stdout});});
  child.stdin.on('error',()=>{});child.stdin.end(input);return;
 }
 const child=execFile(command,[...args],{encoding:'buffer',timeout:5000,maxBuffer:256,killSignal:'SIGKILL',
  env:{PATH:'/usr/bin:/bin',LANG:'C'},windowsHide:true},(error,stdout,stderr)=>{
   stderr.fill(0);
   const status=error===null?0:typeof error.code==='number'?error.code:null;
   resolve({status,stdout});
 });
 child.stdin?.on('error',()=>{});
 child.stdin?.end(input);
});
/** Add only. A naked final -w reads two password lines from a private pipe;
 * detached execution prevents a controlling terminal from intercepting it.
 * No -U replacement, permissive ACL or secret command-line argument. */
export async function addMemorySaveInputKey(input:{installationId:string;key:Buffer;platform?:string;runner?:MemoryInputKeyRunner}):Promise<void>{
 const account=memoryInputKeyAccount(input.installationId);
 if((input.platform??process.platform)!=='darwin')throw new MemoryInputKeyError('UNSUPPORTED');
 if(!Buffer.isBuffer(input.key)||input.key.length!==32)throw new MemoryInputKeyError('MALFORMED');
 const encoded=input.key.toString('base64'),stdin=Buffer.from(`${encoded}\n${encoded}\n`);
 let result:MemoryInputKeyResult|undefined;
 try{
  result=await (input.runner??run)('/usr/bin/security',['add-generic-password','-a',account,'-s',MEMORY_INPUT_KEYCHAIN_SERVICE,'-w'],stdin);
  if(!result||result.status!==0)throw new MemoryInputKeyError('UNAVAILABLE');
 }catch{throw new MemoryInputKeyError('UNAVAILABLE');}
 finally{stdin.fill(0);if(Buffer.isBuffer(result?.stdout))result.stdout.fill(0);}
}
/** Read-only host adapter. The installation ID must come from the existing
 * durable observation identity, never a newly generated fallback. It does not
 * create/reset keys, share What I Said credentials, or grant automatic consent.
 * Provisioning and key-loss recovery remain separate explicit host operations.
 * No caching: caller owns the returned key and must zero it after use. */
export async function readMemorySaveInputKey(input:{installationId:string;platform?:string;runner?:MemoryInputKeyRunner}):Promise<Buffer> {
 const account=memoryInputKeyAccount(input.installationId);
 if((input.platform??process.platform)!=='darwin')throw new MemoryInputKeyError('UNSUPPORTED');
 let result:MemoryInputKeyResult|undefined;
 try{
  result=await (input.runner??run)('/usr/bin/security',['find-generic-password','-a',account,'-s',MEMORY_INPUT_KEYCHAIN_SERVICE,'-w']);
  if(!result||!Buffer.isBuffer(result.stdout)||result.stdout.length>256)throw new MemoryInputKeyError('UNAVAILABLE');
  if(result.status===44)throw new MemoryInputKeyError('MISSING');
  if(result.status!==0)throw new MemoryInputKeyError('UNAVAILABLE');
  if(result.stdout.some(byte=>byte>127))throw new MemoryInputKeyError('MALFORMED');
  const encoded=result.stdout.toString('ascii').replace(/[\r\n]+$/,'');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw new MemoryInputKeyError('MALFORMED');
  const key=Buffer.from(encoded,'base64');
  if(key.length!==32||key.toString('base64')!==encoded){key.fill(0);throw new MemoryInputKeyError('MALFORMED');}
  return key;
 }catch(e){if(e instanceof MemoryInputKeyError)throw e;throw new MemoryInputKeyError('UNAVAILABLE');}
 finally{if(Buffer.isBuffer(result?.stdout))result.stdout.fill(0);}
}
