import {MemorySaveError,saveHash,saveInteger,saveToken} from './memorySaveContract';
import {assertSameMemoryProviderIdentity,canonicalMemoryProviderBinding,type MemoryProviderBinding} from './memorySaveProviderContract';

export const MEMORY_PROVIDER_RECOVERY_REVIEW_TTL=5*60*1000;
export const MEMORY_PROVIDER_RECOVERY_DAILY_LIMIT=8;
export const MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT=8192;

/** Server-derived metadata only. Neither provider credentials nor transcript,
 * filesystem paths or provider responses belong in this durable context. */
export interface MemoryProviderRecoveryBinding {
 parentSaveId:string;parentAttemptId:string;memoryId:string;coverageDigest:string;
 originalIntentDigest:string;beforeHash:string;targetId:string;rootDigest:string;registrationDigest:string;policyRevision:number;
 priorBinding:MemoryProviderBinding;observedBinding:MemoryProviderBinding;
}
export interface MemoryProviderRecoveryApproval {
 version:1;approvalId:string;reviewDigest:string;reviewedAt:number;expiresAt:number;binding:MemoryProviderRecoveryBinding;
}
export interface MemoryProviderRecoveryProbe {
 version:1;transitionId:string;approvalId:string;reviewDigest:string;startedAt:number;completedAt:number|null;
 state:'claimed'|'ready'|'failed'|'unknown';binding:MemoryProviderRecoveryBinding;
 readyBinding:MemoryProviderBinding|null;proofDigest:string|null;
}
export interface MemoryProviderRecoveryClaim {
 approvalId:string;reviewDigest:string;explicitConsent:true;binding:MemoryProviderRecoveryBinding;
}
export type MemoryProviderRecoveryCompletion={state:'ready';binding:MemoryProviderBinding}|{state:'failed'|'unknown'};

export function strictRecoveryObject(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype
  ||Object.keys(value).some(key=>!keys.includes(key)))throw new MemorySaveError('INVALID_INPUT');
}
export function canonicalRecoveryProviderBinding(value:MemoryProviderBinding):MemoryProviderBinding {
 strictRecoveryObject(value,['version','agent','model','effort','binaryFingerprint','accountFingerprint','installationFingerprint','preparedAt']);
 return canonicalMemoryProviderBinding(value);
}
export function canonicalMemoryProviderRecoveryBinding(raw:MemoryProviderRecoveryBinding):MemoryProviderRecoveryBinding {
 strictRecoveryObject(raw,['parentSaveId','parentAttemptId','memoryId','coverageDigest','originalIntentDigest','beforeHash','targetId','rootDigest','registrationDigest','policyRevision','priorBinding','observedBinding']);
 if(![raw.parentSaveId,raw.parentAttemptId,raw.memoryId,raw.targetId].every(saveToken)||!saveInteger(raw.policyRevision)
  ||![raw.coverageDigest,raw.originalIntentDigest,raw.beforeHash,raw.rootDigest,raw.registrationDigest].every(saveHash))throw new MemorySaveError('INVALID_INPUT');
 const priorBinding=canonicalRecoveryProviderBinding(raw.priorBinding),observedBinding=canonicalRecoveryProviderBinding(raw.observedBinding);
 assertSameMemoryProviderIdentity(priorBinding,observedBinding);
 return {parentSaveId:raw.parentSaveId,parentAttemptId:raw.parentAttemptId,memoryId:raw.memoryId,coverageDigest:raw.coverageDigest,
  originalIntentDigest:raw.originalIntentDigest,beforeHash:raw.beforeHash,targetId:raw.targetId,rootDigest:raw.rootDigest,
  registrationDigest:raw.registrationDigest,policyRevision:raw.policyRevision,priorBinding,observedBinding};
}
