/**
 * Device control between community members: what a Mac does with a request another Mac in the same
 * community addressed to it. Entering the community is the consent (the user chose «joined means
 * controllable» on 2026-10-05), so a request runs with the same power as this Mac's own Workroom —
 * but only the Workroom: terminal sessions and `workroom.*` actions. The raw shared shell and every
 * other local API stay out of reach.
 */
export const AGENT_DIALOGUE_CONTROL_TERMINAL_OPERATIONS=['list','start','read','input','resize','close'] as const;

export interface CommunityControlProjects {
  projects:{targetId:string;projectTargetId?:string;label:string;scope?:'main'|'worktree';worktreeCapable?:boolean}[];
  opsTargetId:string|null;
  deviceName:string;
}
export interface CommunityControlExecutorDependencies {
  terminal(body:Record<string,unknown>):Promise<unknown>;
  workspace(body:Record<string,unknown>):Promise<unknown>;
  projects():Promise<CommunityControlProjects>;
}

export function createCommunityControlExecutor(deps:CommunityControlExecutorDependencies){
  return async(request:Record<string,unknown>):Promise<Record<string,unknown>>=>{
    if(request.kind==='projects'&&Object.keys(request).length===1)return {...await deps.projects()};
    if(request.kind!=='terminal'||Object.keys(request).some(key=>key!=='kind'&&key!=='body'))
      throw new Error('지원하지 않는 기기 제어 요청입니다.');
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('기기 제어 요청 형식이 올바르지 않습니다.');
    const operation=(body as Record<string,unknown>).operation;
    if(operation==='workspace')return {result:await deps.workspace(body as Record<string,unknown>)};
    if(typeof operation!=='string'||!(AGENT_DIALOGUE_CONTROL_TERMINAL_OPERATIONS as readonly string[]).includes(operation))
      throw new Error('다른 기기에서는 워크룸 터미널만 제어할 수 있습니다.');
    // A request from another device never raises privileges here: no permission bypass, no resume of a
    // session it did not see start. A phone forwarding through another Mac holds only that Mac's grant,
    // and this keeps it from turning into a bypassed CLI on this one (2026-10-06 review).
    const b=body as Record<string,unknown>;
    if(operation==='start'&&(b.bypassPermissions===true||b.resumeFrom!==undefined))
      throw new Error('다른 기기에서는 권한 우회나 다시 시작으로 세션을 열 수 없습니다. 세션을 열 기기 앞에서 직접 여세요.');
    return {result:await deps.terminal(b)};
  };
}

/** Fast while another Mac is driving this one, slow otherwise. The idle cost is one inbox read per
 *  three seconds, and only on a Mac that has entered the community. */
export const COMMUNITY_CONTROL_ACTIVE_POLL_MS=600;
export const COMMUNITY_CONTROL_IDLE_POLL_MS=3_000;
export const COMMUNITY_CONTROL_ACTIVE_WINDOW_MS=90_000;
export function communityControlPollDelay(lastHandledAt:number|null,now:number):number{
  return lastHandledAt!==null&&now-lastHandledAt<COMMUNITY_CONTROL_ACTIVE_WINDOW_MS
    ?COMMUNITY_CONTROL_ACTIVE_POLL_MS:COMMUNITY_CONTROL_IDLE_POLL_MS;
}
