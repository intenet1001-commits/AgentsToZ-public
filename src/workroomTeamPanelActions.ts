import {TEAM_SESSION_ID} from './teamLaunchOptions';
import type {WorkroomTeamRequest} from './workroomTeam';

/** Human actions from this Mac's capability-protected team strip. They never launch, send or stop an agent. */
export type TeamPanelAction = {sessionId:string} & (
  | {operation:'confirm-member';teamId:string;memberId:string;confirm:'started'|'delivered'}
  | {operation:'report-member';teamId:string;memberId:string;status:'done'|'blocked';summary:string}
  | {operation:'copy-brief';teamId:string;memberId:string}
);
export function teamPanelActionRequest(raw:unknown):{sessionId:string;request:WorkroomTeamRequest|{op:'brief';teamId:string;memberId:string}} {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('팀 확인 요청 형식이 올바르지 않습니다.');
  const b=raw as Record<string,unknown>;
  const keys=b.operation==='confirm-member'?['sessionId','operation','teamId','memberId','confirm']
    :b.operation==='report-member'?['sessionId','operation','teamId','memberId','status','summary']
    :b.operation==='copy-brief'?['sessionId','operation','teamId','memberId']:null;
  if(!keys||Object.keys(b).some(key=>!keys.includes(key)))throw Error('허용되지 않은 팀 확인 요청입니다.');
  if(typeof b.sessionId!=='string'||!TEAM_SESSION_ID.test(b.sessionId))throw Error('세션을 확인하지 못했습니다.');
  // The server passes this through the same strict core parser as MCP before any ledger write.
  const {sessionId,operation,...fields}=b;
  if(operation==='copy-brief'){
    if(typeof fields.teamId!=='string'||!/^team_[a-f0-9]{12}$/.test(fields.teamId)||typeof fields.memberId!=='string'||!/^m[1-6]$/.test(fields.memberId))throw Error('팀원을 확인하지 못했습니다.');
    return {sessionId,request:{op:'brief',teamId:fields.teamId,memberId:fields.memberId}};
  }
  return {sessionId,request:{...fields,op:operation==='confirm-member'?'confirm':'report',...(operation==='report-member'?{manual:true}: {})} as WorkroomTeamRequest};
}
