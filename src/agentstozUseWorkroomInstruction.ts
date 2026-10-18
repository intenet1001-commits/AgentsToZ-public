/**
 * Typing an agentstoz_use instruction into a running Workroom session (send_workroom_instruction, and
 * start_workroom_session with reuse + instruction). Host-only: this Mac composed the text itself.
 *
 * When the terminal service has whole-request submission, the instruction goes as one submission under the
 * `agentstoz-use` receipt namespace (kept apart from this Mac's composer and from other devices), with an id
 * derived from the MCP requestId and the chosen session — so a retry reads the same durable receipt instead of
 * typing again. Anything short of `written` is an unknown outcome (409), never retyped; a refusal before any
 * write is AGENTSTOZ_USE_WORKROOM_INSTRUCTION_NOT_SENT (409, use a new requestId). The text is typed exactly as
 * given, without the composer's correction context. A host without submission keeps the raw input path byte for byte.
 */
import {AgentsToZUseControlError} from './agentstozUseControl';
import type {AiTerminalService} from './aiTerminalService';
import type {AiTerminalSummary} from './aiTerminalProtocol';

/** The receipt namespace of agentstoz_use instructions (never on the wire). */
export const AGENTSTOZ_USE_SUBMISSION_OWNER = 'agentstoz-use';

export type AgentsToZUseInstructionOutcome = {delivered: true; via: 'submission' | 'input'; session: AiTerminalSummary | null};

export async function deliverAgentsToZUseWorkroomInstruction(
  service: Pick<AiTerminalService, 'wholeSubmissionSupported' | 'submitHostInstruction' | 'perform' | 'runningSession'>,
  input: {submissionId: string; rawRequestId: string; sessionId: string; data: string},
): Promise<AgentsToZUseInstructionOutcome> {
  if (!service.wholeSubmissionSupported()) {
    const typed = await service.perform({operation: 'input', requestId: input.rawRequestId, sessionId: input.sessionId, data: input.data});
    return {delivered: true, via: 'input', session: typed.session ?? null};
  }
  // Typed exactly as given, as the raw path did (no correction suffix on another AI's instruction or slash command).
  const outcome = await service.submitHostInstruction({id: input.submissionId, sessionId: input.sessionId, data: input.data, receiptOwner: AGENTSTOZ_USE_SUBMISSION_OWNER, skipCorrections: true})
    .catch((error: unknown) => {
      // A thrown submission means nothing was typed. Its derived request IDs keep answering this same refusal for as
      // long as the session runs, so a retry under the same requestId cannot succeed: ask for a new one.
      const reason = error instanceof Error ? error.message : String(error);
      throw new AgentsToZUseControlError(
        `${reason} 워크룸 세션에 지시를 입력하지 않았습니다. 같은 requestId로 다시 보내면 같은 결과만 돌아오니, 세션이 준비되면 새 requestId로 보내세요.`,
        "AGENTSTOZ_USE_WORKROOM_INSTRUCTION_NOT_SENT",
        409,
        {sessionId: input.sessionId, instructionRequested: true, written: false},
      );
    });
  if (outcome.state !== 'written') {
    throw new AgentsToZUseControlError(
      "워크룸 세션에 지시가 전달됐는지 확인하지 못했습니다. 같은 requestId로 다시 시도해도 다시 입력하지 않습니다. 세션 출력을 읽어 확인한 뒤, 필요하면 새 requestId로 요청하세요.",
      "AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN",
      409,
      {sessionId: input.sessionId, instructionRequested: true, submissionState: outcome.state},
    );
  }
  return {delivered: true, via: 'submission', session: outcome.session ?? service.runningSession(input.sessionId)};
}
