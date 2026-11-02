// Type only: agentDialogueHost imports this module, so a value import would be a cycle.
import type {AGENT_DIALOGUE_CONTROL_DETACHED} from './agentDialogueHost';
import {COMPUTER_USE_REMOTE_ERRORS,COMPUTER_USE_REMOTE_KIND} from './computerUseRemoteProtocol';
import {REMOTE_HISTORY_COMMUNITY_REFUSAL,isRemoteHistoryAction} from './workroomHistoryRemoteProtocol';
import {WORKROOM_ATTACH_COMMUNITY_REFUSAL,isWorkroomAttachAction} from './workroomRemoteAttachmentProtocol';
import {WORKROOM_EFFORT_COMMUNITY_REFUSAL} from './workroomEffortView';
/**
 * Device control between community members: what a Mac does with a request another Mac in the same
 * community addressed to it. Entering the community is the consent (the user chose «joined means
 * controllable» on 2026-10-05), so a request runs with the same power as this Mac's own Workroom —
 * but only the Workroom: terminal sessions, `workroom.*` actions and explicit OPS task admission/status.
 * OPS tasks use the receiver's configured AI and permission mode, with their own result capability. The raw shared shell and every
 * other local API stay out of reach.
 */
export const AGENT_DIALOGUE_CONTROL_TERMINAL_OPERATIONS=['list','start','read','input','resize','close','submission'] as const;
/** What a receiver says to anything outside the Workroom terminal. Shared so a sender can recognise it exactly:
 *  receivers up to v791 advertise terminal-submission-v1 on `list` but answer `submission` with this sentence. */
export const COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR='다른 기기에서는 워크룸 터미널만 제어할 수 있습니다.';
/** Submission receipts from another device are kept apart from this Mac's own ('local') receipts. Host-only: it
 *  is passed beside the request, never on the wire. */
export const COMMUNITY_CONTROL_RECEIPT_OWNER='community';
export interface CommunityControlTerminalOptions {receiptOwner:string}
/** One namespace per sending endpoint, so two Macs driving this one never read each other's receipts. The
 *  endpoint is the authenticated sender the control channel recorded, not anything in the request body. */
export function communityReceiptOwner(endpointId:string|undefined):string{
  return typeof endpointId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(endpointId)
    ?`${COMMUNITY_CONTROL_RECEIPT_OWNER}:${endpointId.toLowerCase()}`:COMMUNITY_CONTROL_RECEIPT_OWNER;
}

export interface CommunityControlProjects {
  projects:{targetId:string;projectTargetId?:string;label:string;scope?:'main'|'worktree';worktreeCapable?:boolean;useServices?:string[]}[];
  opsTargetId:string|null;
  deviceName:string;
}
/** The sending device as the mailbox recorded the row (never the request body's claim). */
export interface CommunityControlFrom {deviceId:string;name:string;endpointId?:string}
/** What a `computer-use` row may return instead of an answer: it was handed to the receiving host's own lane. */
export type CommunityControlDetached=typeof AGENT_DIALOGUE_CONTROL_DETACHED;
export interface CommunityControlExecutorDependencies {
  terminal(body:Record<string,unknown>,options:CommunityControlTerminalOptions):Promise<unknown>;
  workspace(body:Record<string,unknown>,options?:CommunityControlTerminalOptions):Promise<unknown>;
  projects():Promise<CommunityControlProjects>;
  opsRequest?(request:Record<string,unknown>,from:CommunityControlFrom):Promise<unknown>;
  /**
   * Computer use from another Mac (src/computerUseRemoteHost.ts). It answers hello, part, heartbeat, disconnect and
   * receipt at once and may hand a `call` row to its lane (CommunityControlDetached), answering it later through the
   * mailbox's controlRespond — pass `communityControlDetachable` as the poll's `detach`.
   */
  computerUse?(request:Record<string,unknown>,from:CommunityControlFrom,controlId:string):Promise<Record<string,unknown>|CommunityControlDetached>;
}
/** The executor; it returns CommunityControlDetached only when its dependencies include `computerUse`. */
export type CommunityControlExecutor<D extends CommunityControlExecutorDependencies=CommunityControlExecutorDependencies>=
  (request:Record<string,unknown>,from?:CommunityControlFrom,controlId?:string)
    =>Promise<Record<string,unknown>|('computerUse' extends keyof D?CommunityControlDetached:never)>;
const deviceIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The poll's `detach` predicate: only a computer-use `call` may be answered after the poll moved on (§7.5-§7.6). */
export function communityControlDetachable(request:Record<string,unknown>):boolean{
  return request?.kind===COMPUTER_USE_REMOTE_KIND&&request.op==='call';
}

export function createCommunityControlExecutor<D extends CommunityControlExecutorDependencies>(deps:D):CommunityControlExecutor<D>{
  const execute=async(request:Record<string,unknown>,from?:CommunityControlFrom,controlId?:string):Promise<Record<string,unknown>|CommunityControlDetached>=>{
    if(request.kind===COMPUTER_USE_REMOTE_KIND){
      // A Mac that cannot receive (an older build path, Windows, a server that is not the bundled sidecar) says so with the
      // fixed sentence the sender reads as REMOTE_UNSUPPORTED, never the unknown-kind sentence (that one means outdated).
      if(!deps.computerUse)throw new Error(COMPUTER_USE_REMOTE_ERRORS.REMOTE_UNSUPPORTED.message);
      // The sending device is the mailbox's record; without it (or without the row to answer) nothing is decrypted.
      if(!from||typeof from.deviceId!=='string'||!deviceIdPattern.test(from.deviceId)||typeof controlId!=='string'||!controlId)
        throw new Error(COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_REQUEST.message);
      return deps.computerUse(request,from,controlId);
    }
    if(request.kind==='ops-request'){
      if(!deps.opsRequest||!from?.endpointId)throw new Error('이 기기의 OPS 작업 수신 기능을 확인하세요.');
      return {receipt:await deps.opsRequest(request,from)};
    }
    if(request.kind==='projects'&&Object.keys(request).length===1)return {...await deps.projects()};
    if(request.kind!=='terminal'||Object.keys(request).some(key=>key!=='kind'&&key!=='body'))
      throw new Error('지원하지 않는 기기 제어 요청입니다.');
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('기기 제어 요청 형식이 올바르지 않습니다.');
    const operation=(body as Record<string,unknown>).operation;
    if(operation==='workspace'){
      // Conversation history is granted per phone in the Mac dialog. Community membership is not that grant, so it is
      // refused here even though its names sit outside `workroom.` (the receiver's workspace path refuses them too).
      const workspace=(body as Record<string,unknown>).workspace as Record<string,unknown>|undefined;
      if(workspace&&typeof workspace==='object'&&isRemoteHistoryAction(workspace.action))throw new Error(REMOTE_HISTORY_COMMUNITY_REFUSAL);
      // Phone attachments (w13) belong to the Mac the phone is connected to; its ids mean nothing here. Defence in depth:
      // the receiver's workspace path runs only `workroom.*` actions.
      if(workspace&&typeof workspace==='object'&&isWorkroomAttachAction(workspace.action))throw new Error(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
      // 「에포트 자동」 (w16) is this Mac's own setting: another device may read it, never change it — like bypass, which a
      // community peer cannot ask for either.
      if(workspace&&typeof workspace==='object'&&workspace.action==='workroom.effort'&&(workspace.set!==undefined||workspace.mode!==undefined))throw new Error(WORKROOM_EFFORT_COMMUNITY_REFUSAL);
      return {result:await deps.workspace(body as Record<string,unknown>,{receiptOwner:communityReceiptOwner(from?.endpointId)})};
    }
    if(typeof operation!=='string'||!(AGENT_DIALOGUE_CONTROL_TERMINAL_OPERATIONS as readonly string[]).includes(operation))
      throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
    // A request from another device never raises privileges here: no permission bypass, no resume of a
    // session it did not see start. A phone forwarding through another Mac holds only that Mac's grant,
    // and this keeps it from turning into a bypassed CLI on this one (2026-10-06 review).
    const b=body as Record<string,unknown>;
    // Checked on every operation, not only `start`: a field that is meaningless today must not become a way in later.
    if(b.bypassPermissions===true||b.resumeFrom!==undefined)
      throw new Error('다른 기기에서는 권한 우회나 다시 시작으로 세션을 열 수 없습니다. 세션을 열 기기 앞에서 직접 여세요.');
    return {result:await deps.terminal(b,{receiptOwner:communityReceiptOwner(from?.endpointId)})};
  };
  return execute as CommunityControlExecutor<D>;
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
