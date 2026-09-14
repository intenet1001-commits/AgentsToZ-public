import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {basename,dirname} from 'node:path';
import {detectProjectMemoryIdentity,prepareProjectMemoryUpdate,type SessionSweepStats} from '../project-memory-server';
import {commitAutomaticMemoryProposal,type MemorySaveExecution} from './memorySaveExecutor';
import {MemorySaveError,saveDigest,type MemorySaveRecoveryBinding,type MemorySaveRecoveryCandidate} from './memorySaveContract';
import {MemorySaveInputStore,MEMORY_INPUT_LIMIT} from './memorySaveInputStore';
import {materializeMemorySaveInput,type MemoryInputSource} from './memorySaveInputMaterializer';
import {checkMemorySaveDiskAdmission,MemoryDiskAdmissionError} from './memorySaveDiskAdmission';
import {memorySaveFailureCode,type MemorySaveFailure} from './memorySaveFailure';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';
import {memorySaveTextProvider,type MemoryProviderHost} from './memorySaveProvider';

export interface MemoryRecoveryExecution extends Omit<MemorySaveExecution,'sources'> {
 targetId:string;cwd:string;instanceId:string;candidates:readonly MemoryObservationCandidate[];
 /** Host-selected executable/installation only; never accepted from HTTP input. */
 providerHost?:MemoryProviderHost;
}
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const registration=(c:MemoryRecoveryExecution,memoryId:string)=>saveDigest([c.targetId,memoryId,c.root,c.cwd]);
const active=new WeakSet<object>();

/** Reconstruct every originally owned turn, without replacing missing records
 * with recent conversation. One bounded pass per explicit review/confirmation. */
export function resolveRecoverySources(c:MemoryRecoveryExecution,candidate:MemorySaveRecoveryCandidate):MemoryInputSource[]{
 if(!candidate.sources.length||candidate.sources.length>8)throw new MemorySaveError('SOURCES_INELIGIBLE');
 let charge=0;
 return candidate.sources.map(({source})=>{
  const matches=c.candidates.filter(v=>v.agent===source.agent&&v.sessionId===source.sessionId);
  charge+=source.endByte-source.startByte+(source.startByte>0?256*1024+1:0);
  if(source.instanceId!==c.instanceId||matches.length!==1||charge>4*1024*1024||!['codex','claude'].includes(source.agent))throw new MemorySaveError('SOURCES_INELIGIBLE');
  const match=matches[0]!;
  return {source,path:match.path,transcriptRoot:match.transcriptRoot,binding:{agent:match.agent,instanceId:c.instanceId,sessionId:source.sessionId,cwd:c.cwd,memoryId:source.memoryId,policyEpoch:source.policyEpoch}};
 });
}
async function prepare(c:MemoryRecoveryExecution,parentSaveId:string){
 const candidate=c.saves.recoveryCandidate(parentSaveId);
 if(!candidate)throw new MemorySaveError('RECOVERY_REQUIRED');
 const {memoryId,policyEpoch,coverageDigest}=candidate.job,policy=c.saves.automaticPolicy();
 let executionProvider=c.provider,expectedRevision=policy.revision,expectedProviderDigest=c.provider.bindingDigest;
 const transition=c.providerHost?c.saves.readyRecoveryProviderTransition(parentSaveId):null;
 if(transition){
  const b=transition.binding;
  if(!transition.readyBinding||!transition.proofDigest||b.parentAttemptId!==candidate.job.attemptId||b.memoryId!==memoryId
   ||b.coverageDigest!==coverageDigest||b.originalIntentDigest!==saveDigest(candidate.intent)||b.beforeHash!==candidate.intent.beforeHash
   ||b.targetId!==c.targetId||b.rootDigest!==saveDigest(c.root)||b.registrationDigest!==registration(c,memoryId)
   ||b.policyRevision!==policy.revision||saveDigest(b.priorBinding)!==c.provider.bindingDigest)throw new MemorySaveError('POLICY_CHANGED');
  executionProvider=memorySaveTextProvider(c.providerHost!,transition.readyBinding);
 }
 const valid=async()=>{
  c.signal?.throwIfAborted();
  if(!c.workspaceLease.refresh()||!c.stagingLease.refresh()||realpathSync(c.root)!==c.root
   ||c.workspaceLease.identity.canonicalWorkspacePath!==c.root||c.stagingLease.identity.canonicalWorkspacePath!==realpathSync(c.appDataRoot))return false;
  const target=await c.validateRegistration(),p=c.saves.automaticPolicy();
  return c.workspaceLease.refresh()&&c.stagingLease.refresh()&&target?.memoryId===memoryId&&target.canonicalRoot===c.root
   &&p.enabled&&p.revision===expectedRevision&&!p.excludedMemoryIds.includes(memoryId)&&(p.scopeMemoryId===null||p.scopeMemoryId===memoryId)
   &&p.providerBindingDigest===expectedProviderDigest;
 };
 let prompt:Buffer|undefined,evidence:Buffer|undefined,key:Buffer|undefined;
 try{
  if(!await valid()||candidate.intent.providerBindingDigest!==c.provider.bindingDigest||!await executionProvider.ready())throw new MemorySaveError('POLICY_CHANGED');
  const identity=await detectProjectMemoryIdentity(c.root);
  if(!identity.exists||identity.config?.memoryId!==memoryId||identity.projectRoot!==c.root)throw new MemorySaveError('SOURCE_CONFLICT');
  if(c.sessions.status(c.root,{readOnly:true}))throw new MemorySaveError('RECOVERY_REQUIRED');
  // This dependency MUST be read-only: a Pull would destroy the original beforeHash.
  await c.preflight();
  const sources=resolveRecoverySources(c,candidate);
  const materialized=await materializeMemorySaveInput({sources,expectedCoverageDigest:coverageDigest,validateRegistrationAndLease:valid,projection:'conversation-v1'});
  evidence=materialized.plaintext;
  const stats:SessionSweepStats={excerpts:sources.length,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0};
  const prepared=prepareProjectMemoryUpdate({folderPath:c.root,agent:executionProvider.agent,preservePreferredAgent:true},{text:evidence.toString('utf8'),stats},{requireInitialized:true});
  if(prepared.originalLocalHash!==candidate.intent.beforeHash)throw new MemorySaveError('REVISION_CONFLICT');
  prompt=Buffer.from(prepared.prompt);if(prompt.length>MEMORY_INPUT_LIMIT)throw new MemorySaveError('INVALID_INPUT');
  key=await c.readKey();if(key.length!==32||!await valid())throw new MemorySaveError('POLICY_CHANGED');
  const binding:MemorySaveRecoveryBinding={parentSaveId,parentAttemptId:candidate.job.attemptId!,memoryId,policyEpoch,coverageDigest,
   originalIntentDigest:saveDigest(candidate.intent),inputDigest:hash(prompt),beforeHash:prepared.originalLocalHash,providerBindingDigest:executionProvider.bindingDigest,
   policyRevision:policy.revision,targetId:c.targetId,rootDigest:saveDigest(c.root),registrationDigest:registration(c,memoryId),
   ...(transition?{transitionId:transition.transitionId,proofDigest:transition.proofDigest!,originalProviderBindingDigest:candidate.intent.providerBindingDigest}:{})};
  return {binding,prepared,prompt,key,sources,valid,executionProvider,admitted:(revision:number)=>{expectedRevision=revision;expectedProviderDigest=executionProvider.bindingDigest;}};
 }catch(error){prompt?.fill(0);key?.fill(0);throw error;}finally{evidence?.fill(0);}
}
async function disk(c:MemoryRecoveryExecution,valid:()=>Promise<boolean>){
 if(basename(c.saves.path)!=='memory-save-v2.sqlite'||realpathSync(dirname(c.saves.path))!==realpathSync(c.appDataRoot))throw new MemoryDiskAdmissionError('scope-changed');
 const started=performance.now(),check=await checkMemorySaveDiskAdmission({appDataRoot:c.appDataRoot,memoryRoot:c.root,plannedInputBytes:70000,plannedManifestBytes:20*1024*1024});
 if(!check.allowed)throw new MemoryDiskAdmissionError(check.reason);
 if(!await valid())throw new MemorySaveError('POLICY_CHANGED');
 const age=performance.now()-started;if(!Number.isFinite(age)||age<0||age>5000)throw new MemoryDiskAdmissionError('unavailable');
}
/** Explicit review performs no model inference, memory write or source release. */
export async function reviewAmbiguousMemorySave(c:MemoryRecoveryExecution,parentSaveId:string){
 const p=await prepare(c,parentSaveId);
 try{
  await disk(c,p.valid);
  const a=c.saves.prepareRecoveryApproval(p.binding);
  return {version:1 as const,targetId:c.targetId,approvalId:a.approvalId,reviewDigest:a.reviewDigest,expiresAt:a.expiresAt,
   parentSaveId,parentAttemptId:p.binding.parentAttemptId,sourceCount:p.sources.length,inputBytes:p.prompt.length,additionalCalls:1 as const};
 }finally{p.prompt.fill(0);p.key.fill(0);}
}
/** Only the invocation receiving created:true may dispatch. An uncertain HTTP
 * result is queried through status; replaying this request cannot re-run AI. */
export async function executeAmbiguousMemorySave(c:MemoryRecoveryExecution,request:{approvalId:string;reviewDigest:string;explicitConsent:true}){
 if(active.has(c.stagingLease))throw new MemorySaveError('EXECUTION_BUSY');active.add(c.stagingLease);
 let p:Awaited<ReturnType<typeof prepare>>|undefined,attempted:{saveId:string;attemptId:string}|undefined;
 let stage:MemorySaveFailure['stage']='attempt-admission',providerCallPossible=false;
 try{
  const approval=c.saves.recoveryApproval(request.approvalId);
  if(!approval||approval.reviewDigest!==request.reviewDigest||request.explicitConsent!==true||approval.binding.targetId!==c.targetId
   ||approval.binding.rootDigest!==saveDigest(c.root)||approval.binding.registrationDigest!==registration(c,approval.binding.memoryId))throw new MemorySaveError('REVISION_CONFLICT');
  // A consumed approval is a read-only result, including after a process restart.
  const original=c.saves.get(approval.binding.parentSaveId);
  if(original.phase==='superseded-unknown')return {dispatched:false as const,localSaved:false};
  p=await prepare(c,approval.binding.parentSaveId);
  if(saveDigest(p.binding)!==saveDigest(approval.binding))throw new MemorySaveError('REVISION_CONFLICT');
  if(!await p.executionProvider.ready())throw new MemorySaveError('POLICY_CHANGED');
  await disk(c,p.valid);
  const admitted=c.saves.admitRecoverySuccessor({...request,binding:p.binding});
  if(!admitted.created)return {dispatched:false as const,localSaved:false};
  attempted={saveId:admitted.job.saveId,attemptId:admitted.attemptId};
  p.admitted(admitted.executionPolicyRevision);
  const inputBinding={saveId:attempted.saveId,memoryId:p.binding.memoryId,policyEpoch:p.binding.policyEpoch,coverageDigest:p.binding.coverageDigest,
   inputDigest:p.binding.inputDigest,beforeHash:p.binding.beforeHash,providerBindingDigest:p.binding.providerBindingDigest};
  const inputs=new MemorySaveInputStore(c.appDataRoot,c.stagingLease);
  stage='input-staging';await inputs.stage(inputBinding,p.prompt,p.key);
  stage='input-read';p.prompt.fill(0);p.prompt=inputs.read(inputBinding,p.key);
  stage='provider-readiness';if(!await p.valid()||!await p.executionProvider.ready())throw new MemorySaveError('POLICY_CHANGED');
  stage='provider-call';providerCallPossible=true;
  const raw=await p.executionProvider.propose(p.prompt,c.signal);
  const result=await commitAutomaticMemoryProposal({...c,provider:p.executionProvider,sources:p.sources},p.prepared,raw,attempted,p.valid,value=>{stage=value;});
  return {...result,dispatched:true as const};
 }catch(error){
  if(attempted){
   try{if(c.saves.get(attempted.saveId).phase!=='local-saved')c.saves.requireRecovery(attempted.saveId,attempted.attemptId);}catch{/* Retain durable admission. */}
   try{c.saves.recordFailure(attempted.saveId,attempted.attemptId,{version:1,stage,code:memorySaveFailureCode(error),providerCallPossible});}catch{/* Never hide original failure. */}
  }
  throw error;
 }finally{p?.prompt.fill(0);p?.key.fill(0);active.delete(c.stagingLease);}
}
