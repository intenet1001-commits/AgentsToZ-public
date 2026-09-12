import {realpathSync} from 'node:fs';
import {detectProjectMemoryIdentity,prepareProjectMemoryUpdate,type SessionSweepStats} from '../project-memory-server';
import {MemorySaveError,saveDigest} from './memorySaveContract';
import {inspectMemoryProviderTransition,verifyMemoryProviderTransition} from './memorySaveProvider';
import type {MemoryRecoveryExecution} from './memorySaveRecoveryExecutor';
import type {MemoryProviderRecoveryBinding} from './memorySaveProviderTransitionContract';

const active=new WeakSet<object>();
const registration=(c:MemoryRecoveryExecution,memoryId:string)=>saveDigest([c.targetId,memoryId,c.root,c.cwd]);
const emptyStats:SessionSweepStats={excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0};

/** No inference or key access. A provider review does not authorize a save and
 * never refreshes the global binding while the original job remains open. */
async function context(c:MemoryRecoveryExecution,parentSaveId?:string){
 if(!c.providerHost)throw new MemorySaveError('POLICY_CHANGED');
 const target=await c.validateRegistration();
 if(!target||target.canonicalRoot!==c.root)throw new MemorySaveError('POLICY_CHANGED');
 const snapshot=c.saves.statusSnapshot(target.memoryId),policy=snapshot?.policy,prior=snapshot?.provider;
 const id=parentSaveId??snapshot?.job?.saveId;
 if(!policy||!prior||!id||saveDigest(prior)!==c.provider.bindingDigest)throw new MemorySaveError('POLICY_CHANGED');
 const candidate=c.saves.recoveryCandidate(id);
 if(!candidate||candidate.job.memoryId!==target.memoryId||candidate.intent.providerBindingDigest!==saveDigest(prior))throw new MemorySaveError('RECOVERY_REQUIRED');
 const valid=async()=>{
  c.signal?.throwIfAborted();
  if(!c.workspaceLease.refresh()||!c.stagingLease.refresh()||realpathSync(c.root)!==c.root
   ||c.workspaceLease.identity.canonicalWorkspacePath!==c.root||c.stagingLease.identity.canonicalWorkspacePath!==realpathSync(c.appDataRoot))return false;
  const current=await c.validateRegistration(),s=c.saves.statusSnapshot(candidate.job.memoryId),p=s?.policy;
  return c.workspaceLease.refresh()&&c.stagingLease.refresh()&&current?.memoryId===candidate.job.memoryId&&current.canonicalRoot===c.root
   &&!!p&&p.enabled&&p.revision===policy.revision&&p.providerBindingDigest===saveDigest(prior)&&!!s.provider&&saveDigest(s.provider)===saveDigest(prior)
   &&!p.excludedMemoryIds.includes(candidate.job.memoryId)&&(p.scopeMemoryId===null||p.scopeMemoryId===candidate.job.memoryId);
 };
 if(!await valid())throw new MemorySaveError('POLICY_CHANGED');
 const identity=await detectProjectMemoryIdentity(c.root);
 if(!identity.exists||identity.projectRoot!==c.root||identity.config?.memoryId!==candidate.job.memoryId)throw new MemorySaveError('SOURCE_CONFLICT');
 if(c.sessions.status(c.root,{readOnly:true}))throw new MemorySaveError('RECOVERY_REQUIRED');
 const memory=prepareProjectMemoryUpdate({folderPath:c.root,agent:'claude',preservePreferredAgent:true},{text:'',stats:emptyStats},{requireInitialized:true});
 if(memory.originalLocalHash!==candidate.intent.beforeHash)throw new MemorySaveError('REVISION_CONFLICT');
 await c.preflight();
 if(!await valid())throw new MemorySaveError('POLICY_CHANGED');
 const binding={parentSaveId:id,parentAttemptId:candidate.job.attemptId!,memoryId:candidate.job.memoryId,coverageDigest:candidate.job.coverageDigest,
  originalIntentDigest:saveDigest(candidate.intent),beforeHash:candidate.intent.beforeHash,targetId:c.targetId,rootDigest:saveDigest(c.root),
  registrationDigest:registration(c,candidate.job.memoryId),policyRevision:policy.revision,priorBinding:prior};
 return {binding,valid};
}

export async function reviewRecoveryProvider(c:MemoryRecoveryExecution){
 const p=await context(c);
 const observedBinding=await inspectMemoryProviderTransition(c.providerHost!,p.binding.priorBinding,c.signal);
 if(!await p.valid())throw new MemorySaveError('POLICY_CHANGED');
 const a=c.saves.prepareRecoveryProviderApproval({...p.binding,observedBinding});
 return {version:1 as const,targetId:c.targetId,approvalId:a.approvalId,reviewDigest:a.reviewDigest,expiresAt:a.expiresAt,
  parentSaveId:p.binding.parentSaveId,parentAttemptId:p.binding.parentAttemptId,additionalCalls:1 as const,
  model:observedBinding.model,effort:observedBinding.effort,binaryChanged:observedBinding.binaryFingerprint!==p.binding.priorBinding.binaryFingerprint};
}

/** A durable created:true claim is the only dispatch authority. Lost replies,
 * cancellation or process death never grant a second probe to the same review. */
export async function verifyRecoveryProvider(c:MemoryRecoveryExecution,request:{approvalId:string;reviewDigest:string;explicitConsent:true}){
 if(active.has(c.stagingLease))throw new MemorySaveError('EXECUTION_BUSY');active.add(c.stagingLease);
 let claimed:string|undefined;
 try{
  if(request.explicitConsent!==true)throw new MemorySaveError('INVALID_INPUT');
  const previous=c.saves.recoveryProviderProbeForApproval(request.approvalId);
  if(previous){
   const b=previous.binding,target=await c.validateRegistration();
   c.signal?.throwIfAborted();
   if(previous.reviewDigest!==request.reviewDigest||b.targetId!==c.targetId||b.rootDigest!==saveDigest(c.root)
    ||b.registrationDigest!==registration(c,b.memoryId)||target?.memoryId!==b.memoryId||target.canonicalRoot!==c.root
    ||!c.workspaceLease.refresh()||!c.stagingLease.refresh())throw new MemorySaveError('REVISION_CONFLICT');
   return {dispatched:false as const,state:previous.state};
  }
  const a=c.saves.recoveryProviderApproval(request.approvalId);
  if(!a||request.explicitConsent!==true||a.reviewDigest!==request.reviewDigest||a.binding.targetId!==c.targetId
   ||a.binding.rootDigest!==saveDigest(c.root)||a.binding.registrationDigest!==registration(c,a.binding.memoryId))throw new MemorySaveError('REVISION_CONFLICT');
  const p=await context(c,a.binding.parentSaveId);
  if(saveDigest({...p.binding,observedBinding:a.binding.observedBinding})!==saveDigest(a.binding))throw new MemorySaveError('REVISION_CONFLICT');
  const inspected=await inspectMemoryProviderTransition(c.providerHost!,a.binding.priorBinding,c.signal);
  // The review's timestamp is immutable; the fresh snapshot verifies identity.
  if(inspected.preparedAt<a.binding.observedBinding.preparedAt||saveDigest({...inspected,preparedAt:a.binding.observedBinding.preparedAt})!==saveDigest(a.binding.observedBinding)
   ||!await p.valid())throw new MemorySaveError('POLICY_CHANGED');
  const binding:MemoryProviderRecoveryBinding={...p.binding,observedBinding:a.binding.observedBinding};
  const claim=c.saves.claimRecoveryProviderProbe({...request,binding});
  if(!claim.created)return {dispatched:false as const,state:claim.probe.state};
  claimed=claim.probe.transitionId;
  if(!await p.valid())throw new MemorySaveError('POLICY_CHANGED');
  const ready=await verifyMemoryProviderTransition(c.providerHost!,binding.priorBinding,binding.observedBinding,c.signal);
  if(!await p.valid())throw new MemorySaveError('POLICY_CHANGED');
  c.saves.finishRecoveryProviderProbe(claimed,{state:'ready',binding:ready});
  return {dispatched:true as const,state:'ready' as const};
 }catch(error){
  if(claimed)try{c.saves.finishRecoveryProviderProbe(claimed,{state:'unknown'});}catch{/* Preserve the original claim and error, never replay it. */}
  throw error;
 }finally{active.delete(c.stagingLease);}
}
