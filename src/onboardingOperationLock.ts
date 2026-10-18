import type {PortalFileLockOptions} from './portalFileLock';
/** These locks protect short metadata admissions. A dead owner never authorizes replay of its work. */
export const ONBOARDING_OPERATION_LOCK:PortalFileLockOptions={
  attempts:3,retryMs:20,deadOwnerRecoveryClass:'guarded',
  canRecoverDeadOwner:owner=>{
    const match=/^v[23]:([1-9][0-9]{0,9}):[a-f0-9]{32}(?::guarded)?$/.exec(owner);
    if(!match)return false;
    try{process.kill(Number(match[1]),0);return false;}catch(error){return(error as NodeJS.ErrnoException).code==='ESRCH';}
  },
};
