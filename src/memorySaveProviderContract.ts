import {saveHash,saveInteger,MemorySaveError} from './memorySaveContract';
export interface MemoryProviderBinding {
 version:1;agent:'claude';model:string;effort:'low'|'medium';
 binaryFingerprint:string;accountFingerprint:string;installationFingerprint:string;preparedAt:number;
}
export function canonicalMemoryProviderBinding(b:MemoryProviderBinding):MemoryProviderBinding {
 if(!b||b.version!==1||b.agent!=='claude'||typeof b.model!=='string'||!/^claude-[a-z0-9][a-z0-9.-]{1,95}$/.test(b.model)
  ||!['low','medium'].includes(b.effort)||![b.binaryFingerprint,b.accountFingerprint,b.installationFingerprint].every(saveHash)||!saveInteger(b.preparedAt))throw new MemorySaveError('INVALID_INPUT');
 return {version:1,agent:'claude',model:b.model,effort:b.effort,binaryFingerprint:b.binaryFingerprint,
  accountFingerprint:b.accountFingerprint,installationFingerprint:b.installationFingerprint,preparedAt:b.preparedAt};
}

/** A CLI update can renew its binary proof, never the user's account, model or consent. */
export function assertSameMemoryProviderIdentity(prior:MemoryProviderBinding,next:MemoryProviderBinding):void {
 if(prior.version!==next.version||prior.agent!==next.agent||prior.model!==next.model||prior.effort!==next.effort
  ||prior.accountFingerprint!==next.accountFingerprint||prior.installationFingerprint!==next.installationFingerprint
  ||next.preparedAt<prior.preparedAt)throw new MemorySaveError('POLICY_CHANGED');
}
