import {realpathSync,statSync,mkdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {runWithTimeout} from '../project-memory-server';
import {saveDigest,MemorySaveError} from './memorySaveContract';
import type {MemorySaveTextProvider} from './memorySaveExecutor';

export {canonicalMemoryProviderBinding,type MemoryProviderBinding} from './memorySaveProviderContract';
import {canonicalMemoryProviderBinding,assertSameMemoryProviderIdentity,type MemoryProviderBinding} from './memorySaveProviderContract';
type Result={exitCode:number;stdout:string;stderr:string};
export interface MemoryProviderHost {
 appDataRoot:string;installationId:string;executable:()=>string|null;
 run?:(argv:string[],cwd:string,input:string|undefined,limit:number,signal?:AbortSignal)=>Promise<Result>;
 now?:()=>number;
 /** Tests or hosts may shorten the probe budget; never extend its production ceiling. */
 probeTimeoutMs?:number;
}
export const MEMORY_PROVIDER_PROBE_TIMEOUT_MS=60_000;
export class MemoryProviderProbeUnconfirmedError extends Error {
 readonly code='PROVIDER_PROBE_UNCONFIRMED';
 constructor(){super('Provider probe result is unconfirmed; check its current status.');}
}
const safe=['--safe-mode','--setting-sources',''];
// A fixed name suppresses Claude CLI's auxiliary Haiku title-generation call.
const print=['-p','--name','AgentsToZ memory','--no-session-persistence','--tools','','--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','json','--max-turns','1'];
function environment():Record<string,string>{
 const env:Record<string,string>={};
 for(const key of ['HOME','PATH','TMPDIR','LANG','LC_ALL','USER','LOGNAME','SHELL'])if(process.env[key])env[key]=process.env[key]!;
 // Provider identity must stay stable from the consented probe through the
 // response check. Prevent this child from updating its own executable; other
 // processes can still replace it, so the before/after identity checks remain.
 env.DISABLE_AUTOUPDATER='1';
 return env;
}
function workdir(host:MemoryProviderHost){
 const root=realpathSync(host.appDataRoot),path=join(root,'memory-provider-work');
 mkdirSync(path,{recursive:true,mode:0o700});
 const st=lstatSync(path);
 if(!st.isDirectory()||realpathSync(path)!==path||(st.mode&0o077)!==0)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 return path;
}
function executable(host:MemoryProviderHost){
 const selected=host.executable();if(!selected)throw new MemorySaveError('POLICY_CHANGED');
 const path=realpathSync(selected),st=statSync(path);
 if(!st.isFile()||(st.mode&0o111)===0)throw new MemorySaveError('POLICY_CHANGED');
 return {path,fingerprint:saveDigest([path,st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs])};
}
async function run(host:MemoryProviderHost,argv:string[],cwd:string,input?:string,limit=4096,signal?:AbortSignal){
 signal?.throwIfAborted();
 const result=await (host.run??((args,cwd,text,max,signal)=>runWithTimeout(args,cwd,text===undefined?10_000:300_000,text,{
  signal,maxOutputBytes:max,spawn:(args,options)=>Bun.spawn(args,{...options,env:environment()}),
 })))(argv,cwd,input,limit,signal);
 signal?.throwIfAborted();
 if(result.exitCode!==0||Buffer.byteLength(result.stdout)>limit)throw new MemorySaveError('POLICY_CHANGED');
 return result.stdout;
}
async function identity(host:MemoryProviderHost,cwd:string,signal?:AbortSignal){
 const binary=executable(host);
 const auth=JSON.parse(await run(host,[binary.path,...safe,'auth','status','--json'],cwd,undefined,8192,signal));
 if(auth.loggedIn!==true||auth.authMethod!=='claude.ai'||auth.apiProvider!=='firstParty'
  ||typeof auth.email!=='string'||!auth.email||auth.email.length>320||typeof auth.orgId!=='string'||!auth.orgId||auth.orgId.length>128)throw new MemorySaveError('POLICY_CHANGED');
 if(executable(host).fingerprint!==binary.fingerprint)throw new MemorySaveError('POLICY_CHANGED');
 return {binary,accountFingerprint:saveDigest([host.installationId,auth.authMethod,auth.apiProvider,auth.email,auth.orgId])};
}
function proposal(raw:string,model:string):string {
 const result=JSON.parse(raw);
 if(result.type!=='result'||result.subtype!=='success'||result.is_error===true||typeof result.result!=='string'
  ||!result.modelUsage||Object.keys(result.modelUsage).length!==1||!Object.hasOwn(result.modelUsage,model)
  ||(result.permission_denials!==undefined&&(!Array.isArray(result.permission_denials)||result.permission_denials.length>0)))throw new MemorySaveError('POLICY_CHANGED');
 return result.result;
}
/** User-initiated one-call probe. No fallback, aliases, tools or model escalation.
 * Authentication remains in the CLI; only a salted identity digest is retained. */
export async function prepareMemoryProvider(host:MemoryProviderHost,model:string,effort:'low'|'medium',signal?:AbortSignal):Promise<MemoryProviderBinding>{
 return probeMemoryProvider(host,model,effort,signal);
}
/** Explicit one-call revalidation for the already consented account and model. */
export async function revalidateMemoryProvider(host:MemoryProviderHost,raw:MemoryProviderBinding,signal?:AbortSignal):Promise<MemoryProviderBinding>{
 const prior=canonicalMemoryProviderBinding(raw);
 return probeMemoryProvider(host,prior.model,prior.effort,signal,prior);
}
/** Authentication and executable inspection only. Never dispatches an inference. */
export async function inspectMemoryProviderTransition(host:MemoryProviderHost,raw:MemoryProviderBinding,signal?:AbortSignal):Promise<MemoryProviderBinding>{
 const prior=canonicalMemoryProviderBinding(raw);
 signal?.throwIfAborted();
 if(saveDigest(host.installationId)!==prior.installationFingerprint)throw new MemorySaveError('POLICY_CHANGED');
 const current=await identity(host,workdir(host),signal);
 const observed=canonicalMemoryProviderBinding({...prior,binaryFingerprint:current.binary.fingerprint,accountFingerprint:current.accountFingerprint,preparedAt:host.now?.()??Date.now()});
 assertSameMemoryProviderIdentity(prior,observed);
 return observed;
}
/** A separately consented probe must verify exactly what the user reviewed.
 * Renewing the timestamp here would silently change the approved evidence. */
export async function verifyMemoryProviderTransition(host:MemoryProviderHost,raw:MemoryProviderBinding,reviewed:MemoryProviderBinding,signal?:AbortSignal):Promise<MemoryProviderBinding>{
 const prior=canonicalMemoryProviderBinding(raw),observed=canonicalMemoryProviderBinding(reviewed);
 assertSameMemoryProviderIdentity(prior,observed);
 return probeMemoryProvider(host,prior.model,prior.effort,signal,prior,observed);
}
async function probeMemoryProvider(host:MemoryProviderHost,model:string,effort:'low'|'medium',signal?:AbortSignal,prior?:MemoryProviderBinding,observed?:MemoryProviderBinding):Promise<MemoryProviderBinding>{
 const timeout=host.probeTimeoutMs??MEMORY_PROVIDER_PROBE_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MEMORY_PROVIDER_PROBE_TIMEOUT_MS)throw new MemorySaveError('INVALID_INPUT');
 const controller=new AbortController(),abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,timeout);
 try{return await probeWithinDeadline(host,model,effort,controller.signal,prior,observed);}
 catch(error){if(controller.signal.aborted)throw new MemoryProviderProbeUnconfirmedError();throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function probeWithinDeadline(host:MemoryProviderHost,model:string,effort:'low'|'medium',signal:AbortSignal,prior?:MemoryProviderBinding,observed?:MemoryProviderBinding):Promise<MemoryProviderBinding>{
 signal.throwIfAborted();
 const candidate=canonicalMemoryProviderBinding({version:1,agent:'claude',model,effort,binaryFingerprint:'0'.repeat(64),accountFingerprint:'0'.repeat(64),installationFingerprint:saveDigest(host.installationId),preparedAt:host.now?.()??Date.now()});
 if(prior&&candidate.installationFingerprint!==prior.installationFingerprint)throw new MemorySaveError('POLICY_CHANGED');
 const cwd=workdir(host),before=await identity(host,cwd,signal);
 if(prior)assertSameMemoryProviderIdentity(prior,{...candidate,binaryFingerprint:before.binary.fingerprint,accountFingerprint:before.accountFingerprint});
 if(observed&&(candidate.preparedAt<observed.preparedAt||candidate.installationFingerprint!==observed.installationFingerprint
  ||before.binary.fingerprint!==observed.binaryFingerprint||before.accountFingerprint!==observed.accountFingerprint))throw new MemorySaveError('POLICY_CHANGED');
 const raw=await run(host,[before.binary.path,...safe,...print,'--model',model,'--effort',effort],cwd,'Return only MEMORY_SAVE_READY with no punctuation or other text.',64*1024,signal);
 if(proposal(raw,model).trim()!=='MEMORY_SAVE_READY')throw new MemorySaveError('POLICY_CHANGED');
 const after=await identity(host,cwd,signal);
 if(before.binary.fingerprint!==after.binary.fingerprint||before.accountFingerprint!==after.accountFingerprint)throw new MemorySaveError('POLICY_CHANGED');
 const next={...candidate,binaryFingerprint:after.binary.fingerprint,accountFingerprint:after.accountFingerprint};
 if(prior)assertSameMemoryProviderIdentity(prior,next);
 return observed??next;
}
export function memorySaveTextProvider(host:MemoryProviderHost,raw:MemoryProviderBinding):MemorySaveTextProvider {
 const binding=canonicalMemoryProviderBinding(raw),bindingDigest=saveDigest(binding);
 const ready=async(signal?:AbortSignal)=>{
  if(saveDigest(host.installationId)!==binding.installationFingerprint)return false;
  const current=await identity(host,workdir(host),signal);
  return current.binary.fingerprint===binding.binaryFingerprint&&current.accountFingerprint===binding.accountFingerprint;
 };
 return {agent:'claude',bindingDigest,ready,propose:async(input,signal)=>{
  if(!await ready(signal))throw new MemorySaveError('POLICY_CHANGED');
  const result=await run(host,[executable(host).path,...safe,...print,'--model',binding.model,'--effort',binding.effort],workdir(host),input.toString('utf8'),300*1024,signal);
  if(!await ready(signal))throw new MemorySaveError('POLICY_CHANGED');
  return proposal(result,binding.model);
 }};
}
