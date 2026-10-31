import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import {memorySaveRecoveryPrompt} from './memorySaveNoticeRecovery';
import type {MemorySaveProblem} from './memorySaveProblem';

/** The voice window gets this fixed diagnosis path, never the general terminal proxy. */
export const MEMORY_SAVE_NOTICE_RECOVERY_PATH='/api/agent-runtime/memory-save-recovery';
export const MEMORY_SAVE_NOTICE_RECOVERY_BYTES=2048;
type RecoveryRequest={operation:'start'|'list';requestId:string;targetId:string;agent:'codex'|'claude';problem?:MemorySaveProblem};
export class MemorySaveNoticeRecoveryError extends Error {
  constructor(readonly code:'MEMORY_RECOVERY_INPUT_INVALID'|'MEMORY_RECOVERY_UNCONFIRMED',readonly status:number){
    super(code==='MEMORY_RECOVERY_INPUT_INVALID'?'기억 진단 프로젝트와 AI를 확인하세요.':'워크룸 실행 결과를 확인하지 못했습니다. 같은 프로젝트의 워크룸 목록을 확인하세요.');
  }
}
function normalize(value:unknown):RecoveryRequest {
  const r=value as RecoveryRequest;
  const valid=!!r&&typeof r==='object'&&!Array.isArray(r)&&['start','list'].includes(r.operation)
    &&Object.keys(r).every(key=>['operation','requestId','targetId','agent',...(r.operation==='start'?['problem']:[])].includes(key))
    &&typeof r.requestId==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(r.requestId)
    &&typeof r.targetId==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(r.targetId)
    &&['codex','claude'].includes(r.agent)
    &&(r.operation==='list'||['conflict','agent','unknown','backup','state'].includes(r.problem!));
  if(!valid)throw new MemorySaveNoticeRecoveryError('MEMORY_RECOVERY_INPUT_INVALID',400);
  return r;
}
export async function performMemorySaveNoticeRecovery(input:unknown,perform:(request:AiTerminalRequest)=>Promise<AiTerminalResponse>):Promise<AiTerminalResponse>{
  const r=normalize(input);
  try{
    if(r.operation==='list'){
      const response=await perform({operation:'list',requestId:r.requestId});
      return {sessions:(response.sessions??[]).filter(room=>room.targetId===r.targetId&&room.agent===r.agent)
        .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id.localeCompare(a.id)).slice(0,16)};
    }
    const response=await perform({operation:'start',requestId:r.requestId,targetId:r.targetId,agent:r.agent,cols:100,rows:28,
      prompt:memorySaveRecoveryPrompt(r.problem!),bypassPermissions:false});
    if(!response.session||response.session.targetId!==r.targetId||response.session.agent!==r.agent)throw Error();
    return {session:response.session};
  }catch{throw new MemorySaveNoticeRecoveryError('MEMORY_RECOVERY_UNCONFIRMED',503);}
}
