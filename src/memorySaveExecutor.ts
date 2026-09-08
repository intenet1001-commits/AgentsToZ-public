import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {detectProjectMemoryIdentity,prepareProjectMemoryUpdate,validatePreparedProjectMemoryUpdate,prepareProjectMemorySession,readMemoryDocument,type SessionSweepStats} from '../project-memory-server';
import {MemorySaveStore} from './memorySaveStore';
import {MemorySessionStore} from './memorySessionStore';
import {MemorySaveInputStore,MEMORY_INPUT_LIMIT} from './memorySaveInputStore';
import {materializeMemorySaveInput,type MemoryInputSource} from './memorySaveInputMaterializer';
import {MemorySaveError,memorySaveSourceKey,saveDigest,saveHash} from './memorySaveContract';
import {beginDiskCheckedAutomaticMemoryAttempt,checkMemorySaveDiskAdmission,MemoryDiskAdmissionError} from './memorySaveDiskAdmission';
import {bindPreparedMemorySaveSession,applyBoundMemorySaveSession} from './memorySaveHostCommit';
import type {WorkspaceLease} from './workspaceLease';
import {parseProjectMemoryEntries} from './projectMemoryRecall';

/** A host-verified text-only capability, not a CLI name supplied by a request. */
export interface MemorySaveTextProvider {
 agent:'claude'|'codex';bindingDigest:string;
 ready:()=>Promise<boolean>;
 propose:(input:Buffer,signal?:AbortSignal)=>Promise<string>;
}
export interface MemorySaveExecution {
 root:string;appDataRoot:string;workspaceLease:WorkspaceLease;stagingLease:WorkspaceLease;
 saves:MemorySaveStore;sessions:MemorySessionStore;sources:readonly MemoryInputSource[];
 provider:MemorySaveTextProvider;readKey:()=>Promise<Buffer>;
 validateRegistration:()=>Promise<{memoryId:string;canonicalRoot:string}|null>;
 /** Existing remote-head preflight; a conflict must throw before any attempt. */
 preflight:()=>Promise<void>;
 portalDataFile?:string;
 signal?:AbortSignal;
}
const active=new WeakSet<WorkspaceLease>();
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** The single composition from exact completed evidence to a verified local
 * receipt. Caller holds workspace THEN app-data leases. No retries, key creation,
 * remote writes or fallback provider are hidden in this operation. An interrupted
 * attempt can only use the separate bound host-plan recovery path. */
export async function executeAutomaticMemorySave(c:MemorySaveExecution){
 if(active.has(c.stagingLease))throw new MemorySaveError('EXECUTION_BUSY');
 active.add(c.stagingLease);
 let key:Buffer|undefined,prompt:Buffer|undefined,evidence:Buffer|undefined;
 let attempted:{saveId:string;attemptId:string}|undefined;
 try{
  if(!c.sources.length||c.sources.length>128||!saveHash(c.provider.bindingDigest))throw new MemorySaveError('INVALID_INPUT');
  const memoryId=c.sources[0]!.source.memoryId,epoch=c.sources[0]!.source.policyEpoch;
  const policy=c.saves.automaticPolicy();
  if(!policy.enabled||policy.excludedMemoryIds.includes(memoryId))throw new MemorySaveError('POLICY_DISABLED');
  if(policy.providerBindingDigest!==c.provider.bindingDigest)throw new MemorySaveError('POLICY_CHANGED');
  const keys=c.sources.map(s=>memorySaveSourceKey(s.source)).sort();
  c.saves.checkAutomaticSources(memoryId,epoch,keys,policy.revision,c.provider.bindingDigest);
  const valid=async()=>{
   c.signal?.throwIfAborted();
   if(!c.workspaceLease.refresh()||!c.stagingLease.refresh()||realpathSync(c.root)!==c.root
    ||c.workspaceLease.identity.canonicalWorkspacePath!==c.root||c.stagingLease.identity.canonicalWorkspacePath!==realpathSync(c.appDataRoot))return false;
   const current=await c.validateRegistration();
   const fresh=c.saves.automaticPolicy();
   return c.workspaceLease.refresh()&&c.stagingLease.refresh()&&current?.memoryId===memoryId&&current.canonicalRoot===c.root
    &&fresh.enabled&&fresh.revision===policy.revision&&fresh.providerBindingDigest===c.provider.bindingDigest;
  };
  if(!await valid()||!await c.provider.ready())throw new MemorySaveError('POLICY_CHANGED');
  const identity=await detectProjectMemoryIdentity(c.root);
  if(!identity.exists||identity.config?.memoryId!==memoryId||identity.projectRoot!==c.root)throw new MemorySaveError('SOURCE_CONFLICT');
  c.sessions.assertReady(c.root);
  await c.preflight();
  if(!await valid())throw new MemorySaveError('POLICY_CHANGED');
  const coverageDigest=saveDigest([...c.sources].sort((a,b)=>memorySaveSourceKey(a.source).localeCompare(memorySaveSourceKey(b.source))).map(s=>[memorySaveSourceKey(s.source),s.source.sourceDigest]));
  const materialized=await materializeMemorySaveInput({sources:c.sources,expectedCoverageDigest:coverageDigest,validateRegistrationAndLease:valid});
  evidence=materialized.plaintext;
  const stats:SessionSweepStats={excerpts:c.sources.length,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0};
  const prepared=prepareProjectMemoryUpdate({folderPath:c.root,agent:c.provider.agent,sessionStore:c.sessions,preservePreferredAgent:true}, {text:evidence.toString('utf8'),stats});
  prompt=Buffer.from(prepared.prompt);
  if(prompt.length>MEMORY_INPUT_LIMIT)throw new MemorySaveError('INVALID_INPUT');
  const scope={appDataRoot:c.appDataRoot,memoryRoot:c.root,plannedInputBytes:70000,plannedManifestBytes:20*1024*1024};
  const disk=await checkMemorySaveDiskAdmission(scope);
  if(!disk.allowed)throw new MemoryDiskAdmissionError(disk.reason);
  key=await c.readKey();
  if(key.length!==32||!await valid()||!await c.provider.ready())throw new MemorySaveError('POLICY_CHANGED');
  c.saves.checkAutomaticSources(memoryId,epoch,keys,policy.revision,c.provider.bindingDigest);
  // Preflight/readiness failures never reserve source coverage. After reservation
  // a crash must remain visible, including the pre-spawn ambiguity.
  const existing=c.saves.openJob(memoryId);
  if(existing)throw new MemorySaveError('RECOVERY_REQUIRED');
  const job=c.saves.reserve(memoryId,epoch,keys);
  const binding={saveId:job.saveId,memoryId,policyEpoch:epoch,coverageDigest,inputDigest:digest(prompt),beforeHash:prepared.originalLocalHash,providerBindingDigest:c.provider.bindingDigest};
  c.saves.bindInput(job.saveId,binding);
  const inputs=new MemorySaveInputStore(c.appDataRoot,c.stagingLease);
  await inputs.stage(binding,prompt,key);
  const attemptId=await beginDiskCheckedAutomaticMemoryAttempt({store:c.saves,saveId:job.saveId,coverageDigest,policyRevision:policy.revision,intent:binding,scope:{...scope,plannedInputBytes:0},validateLeaseAndRegistration:valid});
  attempted={saveId:job.saveId,attemptId};
  prompt.fill(0);prompt=inputs.read(binding,key);
  if(!await valid()||!await c.provider.ready())throw new MemorySaveError('POLICY_CHANGED');
  const raw=await c.provider.propose(prompt,c.signal);
  if(Buffer.byteLength(raw)>256*1024)throw new MemorySaveError('INVALID_INPUT');
  if(!await valid())throw new MemorySaveError('POLICY_CHANGED');
  const {next,narrative}=validatePreparedProjectMemoryUpdate(prepared,raw);
  // New automatic consolidation may revise entries but cannot silently drop IDs.
  const ids=parseProjectMemoryEntries(prepared.current).filter(entry=>entry.identitySource==='explicit').map(entry=>entry.entryId);
  const surviving=new Set(parseProjectMemoryEntries(next).filter(entry=>entry.identitySource==='explicit').map(entry=>entry.entryId));
  if(ids.some(id=>!surviving.has(id)))throw new MemorySaveError('INVALID_INPUT');
  if(digest(readMemoryDocument(c.root,prepared.memoryPath))!==prepared.originalLocalHash)throw new MemorySaveError('REVISION_CONFLICT');
  const plan=prepareProjectMemorySession({root:c.root,memoryPath:prepared.memoryPath,next,narrative,agent:c.provider.agent,preservePreferredAgent:true,portalDataFile:c.portalDataFile,
   recordedAt:prepared.sessionStartedAt,snapshot:prepared.sessionSnapshot,gitEvidence:{head:prepared.sessionHead,commits:prepared.sessionCommits},saveV2:attempted});
  // Check the whole proposed host write before persisting an oversized manifest.
  if([...(plan.document?.entries??[]),...(plan.state?.entries??[])].reduce((n,e)=>n+Buffer.byteLength(e.after??''),0)>256*1024)throw new MemorySaveError('INVALID_INPUT');
  c.sessions.prepare(plan);
  const host={root:c.root,lease:c.workspaceLease,sessions:c.sessions,saves:c.saves,...attempted,sessionPlanId:plan.id,validateRegistration:async()=>await valid()?{memoryId,canonicalRoot:c.root}:null};
  await bindPreparedMemorySaveSession(host);
  return await applyBoundMemorySaveSession(host);
 }catch(error){
  if(attempted){try{if(c.saves.get(attempted.saveId).phase!=='local-saved')c.saves.requireRecovery(attempted.saveId,attempted.attemptId);}catch{/* Durable intent stays authoritative. */}}
  throw error;
 }finally{key?.fill(0);prompt?.fill(0);evidence?.fill(0);active.delete(c.stagingLease);}
}
