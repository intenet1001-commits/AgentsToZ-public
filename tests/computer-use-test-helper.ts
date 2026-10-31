import {generateKeyPairSync, sign} from 'node:crypto';
import {COMPUTER_USE_APPROVAL_LIMITS,ComputerApprovalVerifier,computerApprovalBytes,type ComputerApproval,type ComputerApprovalRequest} from '../src/computerUseApproval';
import {ComputerUseHost,type ComputerWorker,type ComputerWorkerContext} from '../src/computerUseHost';
import {ComputerUseRecovery,type ComputerUseRecoveryStore} from '../src/computerUseRecovery';
import type {AuthenticatedComputerCaller} from '../src/computerUseCaller';

/** Stands in for the signed helper in tests: the same canonical bytes and P-256 signature, no native UI or person. */
export function testApprovalHelper() {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const jwk=publicKey.export({format:'jwk'}) as {x:string;y:string};
  const point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]);
  const approve=(request:ComputerApprovalRequest,override:Partial<Omit<ComputerApproval,'signature'>>={}):ComputerApproval=>{
    const unsigned={approvalId:request.approvalId,target:{...request.target},caller:{...request.caller},
      issuedAt:request.expiresAt-COMPUTER_USE_APPROVAL_LIMITS.approvalMs,expiresAt:request.expiresAt,...override};
    return {...unsigned,signature:sign('sha256',computerApprovalBytes(unsigned),{key:privateKey,dsaEncoding:'der'}).toString('base64')};
  };
  return {publicKey:point,approve};
}
/** A host wired like production (durable ledger, signed approvals) around a fake worker. */
export function testComputerUseHost(options:{createWorker:(context:ComputerWorkerContext)=>Promise<ComputerWorker>;recovery?:ComputerUseRecoveryStore;now?:()=>number}) {
  const helper=testApprovalHelper();
  const approvals=new ComputerApprovalVerifier({helperPublicKey:helper.publicKey,now:options.now});
  const host=new ComputerUseHost({createWorker:options.createWorker,recovery:options.recovery??new ComputerUseRecovery(':memory:'),approvals,now:options.now});
  const grantFor=async(caller:AuthenticatedComputerCaller,target:unknown,label='Approved task')=>host.grant(helper.approve(host.requestApproval(caller,target,label)));
  return {host,helper,approvals,grantFor};
}
