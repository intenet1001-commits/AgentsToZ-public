import {AgentsToZUseControlError} from './agentstozUseControl';
import {WorkroomEffortChoiceError, type WorkroomEffortChoiceCode, type WorkroomEffortChoiceLevel, type WorkroomEffortChoiceResult, type WorkroomEffortChoiceView} from './workroomEffortChoice';

/** The host side api-server hands in (src/aiTerminalService.ts). */
export interface WorkroomEffortChoiceHost {
  effortChoice(sessionId: string, targetId: string): Promise<WorkroomEffortChoiceView>;
  chooseEffort(input: {sessionId: string; targetId: string; level: WorkroomEffortChoiceLevel; binding: string; requestId: string}): Promise<WorkroomEffortChoiceResult>;
}

const STATUS: Readonly<Record<WorkroomEffortChoiceCode, number>> = {
  REQUEST_ID_CONFLICT: 409, BINDING_CHANGED: 409, UNSUPPORTED: 409, LEVEL_UNSUPPORTED: 400,
  NOT_READY: 409, NOT_APPLIED: 409, NOT_SENT: 409, OUTCOME_UNKNOWN: 409, BUSY: 429,
};

/** What the calling agent does next. It shows `choices` as a clickable single choice and waits for the person. */
export const WORKROOM_EFFORT_CHOICE_GUIDANCE = 'Let the person pick: call again with ask=true alone so AgentsToZ shows them a form, or show choices yourself as one clickable single-select question (Claude Code: AskUserQuestion) with current marked, wait for their pick, then call again with level and this binding and a new requestId. Never pick a level yourself.';

/**
 * agentstoz_use_set_workroom_effort for one listed session of the resolved project (api-server resolved project, session list
 * and caller). Without `level` it reads; with it the person's choice is applied. Never the caller's own Workroom.
 */
export async function agentsToZUseWorkroomEffort(host: WorkroomEffortChoiceHost, input: {
  session: {id: string; targetId: string};
  callerSessionId: string | null;
  level?: WorkroomEffortChoiceLevel;
  binding?: string;
  requestId?: string | null;
}): Promise<{effect: 'read-only' | 'set-workroom-effort'; body: Record<string, unknown>}> {
  if (input.callerSessionId && input.callerSessionId === input.session.id) {
    throw new AgentsToZUseControlError('호출한 AI가 실행 중인 자기 워크룸 세션의 에포트는 이 도구로 바꿀 수 없습니다. 그 세션의 CLI에서 직접 바꾸거나 다른 세션을 고르세요.',
      'AGENTSTOZ_USE_WORKROOM_SELF_TARGET', 409, {sessionId: input.session.id});
  }
  try {
    if (input.level === undefined) {
      const view = await host.effortChoice(input.session.id, input.session.targetId);
      return {effect: 'read-only', body: {effort: view, ...(view.supported ? {guidance: WORKROOM_EFFORT_CHOICE_GUIDANCE} : {})}};
    }
    const result = await host.chooseEffort({sessionId: input.session.id, targetId: input.session.targetId, level: input.level, binding: input.binding!, requestId: input.requestId!});
    return {effect: 'set-workroom-effort', body: {outcome: result.outcome, requested: result.requested, ...(result.readback ? {readback: result.readback} : {}), ...(result.readbackFrom ? {readbackFrom: result.readbackFrom} : {}), effort: result.view}};
  } catch (error) {
    if (!(error instanceof WorkroomEffortChoiceError)) throw error;
    throw new AgentsToZUseControlError(error.message, `AGENTSTOZ_USE_WORKROOM_EFFORT_${error.code}`, STATUS[error.code], {
      keysTyped: error.typed, ...(error.originalRequestId ? {originalRequestId: error.originalRequestId} : {}),
    });
  }
}
