import type {WorkroomTeamService,WorkroomTeamRequest,TeamCaller} from './workroomTeam';
import {leadsTeam,WorkroomTeamError} from './workroomTeam';
import type {createTeamRuntimeBridge} from './teamRuntimeBridge';

type MemberRequest=Extract<WorkroomTeamRequest,{op:'member'}>;
export interface TeamMemberOperationHost {
  service:WorkroomTeamService;external:ReturnType<typeof createTeamRuntimeBridge>;
  readWorkroom(sessionId:string,targetId:string,cursor:number):Promise<{text:string;nextCursor:number}>;
}
/**
 * A Workroom member's output cursor names the session it counts in (`<sessionId>:<n>`): output numbers start again in
 * the session a 「다시 시작」 opens, so a cursor from before it would skip that session's output until it caught up. One
 * taken in a session this member's exact 다시 시작 lineage continues from reads the current session from its start; one
 * of any other session is refused. A bare number (the format before) still counts in whatever session the member has now.
 */
function workroomCursor(cursor:string|undefined,sessionId:string,continues:(from:string)=>boolean):number{
  if(cursor===undefined)return 0;
  if(/^\d{1,15}$/.test(cursor))return Number(cursor);
  const bound=/^([A-Za-z0-9_-]{8,160}):(\d{1,15})$/.exec(cursor);
  if(!bound)throw new WorkroomTeamError('워크룸 출력 cursor가 올바르지 않습니다.','WORKROOM_TEAM_REQUEST_INVALID');
  if(bound[1]===sessionId)return Number(bound[2]);
  if(continues(bound[1]!))return 0;
  throw new WorkroomTeamError('그 cursor는 이 팀원 워크룸의 출력이 아닙니다. 이 팀원을 읽고 받은 cursor를 쓰세요.','WORKROOM_TEAM_REQUEST_INVALID');
}
/** The caller names a team member, never a native handle or arbitrary window. No fresh launch or fallback occurs. */
export async function runTeamMemberOperation(host:TeamMemberOperationHost,request:MemberRequest,caller:TeamCaller|null):Promise<Record<string,unknown>> {
  const team=host.service.store.get(request.teamId),member=team?.members.find(m=>m.id===request.memberId);
  if(!team||!member)throw new WorkroomTeamError('팀원을 찾지 못했습니다.','WORKROOM_TEAM_MEMBER_NOT_FOUND',404);
  // Also the session the leader's own 「다시 시작」 continued in (leadsTeam), never another one on its target.
  if(caller&&!leadsTeam(team,caller.sessionId,host.service.host))throw new WorkroomTeamError('이 팀의 리더가 팀원 실행을 확인합니다.','WORKROOM_TEAM_MEMBER_OPERATION_DENIED',403);
  if(request.operation!=='read'&&team.state!=='active')throw new WorkroomTeamError('정리된 팀에는 지시를 보내지 않습니다.','WORKROOM_TEAM_CLOSED',409);
  const ref=member.execution;
  if(ref?.kind==='external'){
    if(request.operation==='read'){
      const result=await host.external.read(ref,{cursor:request.cursor,limit:request.limit});
      return {memberId:member.id,surface:ref.surface,...result,success:result.outcome==='read',performed:result.outcome==='read',effect:result.outcome==='read'?'read-only':`read-${result.outcome}`};
    }
    if(request.operation==='reveal'){
      const result=await host.external.reveal(ref,request.requestId);
      return {memberId:member.id,surface:ref.surface,success:result.outcome==='requested',performed:result.outcome==='requested',effect:`reveal-${result.outcome}`};
    }
    const sent=await host.external.send!(ref,request.text!,request.requestId!);
    return {memberId:member.id,surface:ref.surface,...sent,performed:sent.delivery==='verified',success:sent.delivery==='verified'};
  }
  if(member.surface&&member.surface!=='internal')throw new WorkroomTeamError('외부 실행 결과가 미확정입니다. 작업 폴더를 보존했으며 자동으로 다시 열지 않습니다.','WORKROOM_TEAM_EXTERNAL_UNCONFIRMED',409);
  // A member Workroom continued by 「다시 시작」 is read and instructed where it runs now (WorkroomTeamService#rebind).
  host.service.refreshMembers(team);
  if(!member.sessionId||!member.targetId)throw new WorkroomTeamError('팀원 워크룸을 확인하지 못했습니다.','WORKROOM_TEAM_SESSION_MISSING',409);
  if(caller?.sessionId===member.sessionId)throw new WorkroomTeamError('자기 세션에는 팀 지시를 보내지 않습니다.','WORKROOM_TEAM_SELF_OPERATION_DENIED',403);
  if(request.operation==='read'){
    const sessionId=member.sessionId,targetId=member.targetId;
    const cursor=workroomCursor(request.cursor,sessionId,from=>host.service.host.continuation?.(from,targetId)?.sessionId===sessionId);
    // Only a running session is this member's AI at work. An ended session's kept output is still given, said so, and
    // a session this run no longer has is answered as missing — neither is evidence about the member now.
    const live=host.service.host.session(sessionId,targetId).state;
    if(live!=='running'){
      const kept=live==='exited'?await host.readWorkroom(sessionId,targetId,cursor).catch(()=>null):null;
      return {memberId:member.id,surface:'internal',session:live,text:kept?kept.text.slice(-(request.limit??4000)):'',cursor:`${sessionId}:${kept?kept.nextCursor:cursor}`,agentVerified:false};
    }
    const result=await host.readWorkroom(sessionId,targetId,cursor);
    // Asked again once the output is in: the session may have ended meanwhile, or the member moved on to the one its
    // 다시 시작 opened. Either way that output is not this member's AI at work now.
    host.service.refreshMembers(team);
    const after=host.service.host.session(sessionId,targetId).state,verified=after==='running'&&member.sessionId===sessionId;
    return {memberId:member.id,surface:'internal',session:after,text:result.text.slice(-(request.limit??4000)),cursor:`${sessionId}:${result.nextCursor}`,agentVerified:verified};
  }
  if(request.operation==='reveal')return {memberId:member.id,surface:'internal',sessionId:member.sessionId,effect:'open-workroom-session-required',performed:false};
  const delivery=await host.service.host.instruct({sessionId:member.sessionId,prompt:request.text!,requestId:request.requestId!});
  return {memberId:member.id,surface:'internal',delivery:delivery==='written'?'verified':'unknown',performed:delivery==='written',success:delivery==='written'};
}
