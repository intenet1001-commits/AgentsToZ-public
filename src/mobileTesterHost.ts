import {TesterError, testerActive, type TesterRequest} from './testerAgentContract';
import type {TesterAgentHost} from './testerAgentHost';
import {latestTesterRun,mobileTesterRun,normalizeMobileTesterResult,type MobileTesterResult} from './mobileTesterProtocol';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';

export async function performMobileTester(host:TesterAgentHost, request:MobileWorkspaceRequest, targetId:string, owner:string,
  active:()=>boolean, access:{canRun:boolean;executionAllowed:()=>boolean}):Promise<MobileWorkspaceResult> {
  const w=request.workspace;
  const operation=w.action.slice('tester.'.length) as 'status'|'start'|'read'|'cancel';
  const mutating=operation==='start'||operation==='cancel';
  const authorize=async()=>{if(!active()||mutating&&!access.canRun)throw new TesterError('TESTER_PERMISSION_CHANGED','Mac에서 이 기기의 테스트 권한을 확인하세요.',403);};
  await authorize();
  const args:TesterRequest={operation,portId:targetId,...(operation==='start'?{requestId:w.testRequestId,revision:w.revisionHash,profileId:w.profileId}:{}),...(['read','cancel'].includes(operation)?{runId:w.runId}:{})};
  const result=await host.perform(args,{owner,authorize,executionAllowed:access.executionAllowed});
  const run=result.status?latestTesterRun(result.status):result.run??null;
  const data:MobileTesterResult={canRun:access.canRun,canCancel:!!run&&access.canRun&&testerActive(run.state)&&host.store.get(run.id)?.remoteOwner===owner,run:run?mobileTesterRun(run):null};
  if(result.status){
    const s=result.status;
    Object.assign(data,{installation:s.installation==='ready'?'ready':s.installation==='absent'?'absent':'needs-attention',environmentReady:s.environmentReady,revision:s.configurationRevision,
      profiles:s.profiles.slice(0,16).map(p=>({id:p.id,configured:p.configured})),defaultProfile:s.defaultProfile,
      freshness:['current','source-changed'].includes(s.freshness)?s.freshness:'unknown'});
  }
  return {kind:'workspace',action:w.action,tester:normalizeMobileTesterResult(data)};
}
