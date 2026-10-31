/**
 * What a Workroom's own save receipt (`workroom.save`, src/mobileWorkspaceJobs.ts) proves before the host acts on it.
 *
 * - `close` ends the terminal, so nothing done anywhere in the project after the save may be lost: the receipt, the same
 *   input revision, the same folder and unchanged project close evidence (git of every worktree + the project-wide
 *   activity marker, projectMemoryCloseEvidence).
 * - `context` (the dock's /compact·/clear) keeps the terminal and acts on this one conversation. Other worktrees and
 *   other agents' prompts in the same project are not this conversation's unsaved work, and comparing them made the
 *   command refuse whenever anyone else was working (2026-10-31). It needs the receipt, the same input revision and the
 *   same folder; the Workroom then also refuses if this conversation's own activity changed after the save started
 *   (AiTerminalService.performContextCommand, using `startedAt`).
 */
export type WorkroomSavedPurpose='close'|'context';
export interface WorkroomSaveReceipt {result:{localSaved:boolean};binding:number|null;evidence:string|null;startedAt:number|null}

export const WORKROOM_CONTEXT_SAVE_REFUSALS={
  unsaved:'이 대화의 현재 입력까지 저장된 기록을 확인하지 못해 명령을 보내지 않았습니다. 다시 실행하면 새로 저장한 뒤 보냅니다.',
  folder:'워크룸의 프로젝트 폴더가 바뀌어 명령을 보내지 않았습니다.',
  changed:'저장을 시작한 뒤 이 대화의 상태가 바뀌어 명령을 보내지 않았습니다. 다시 실행하면 새로 저장한 뒤 보냅니다.',
} as const;

export async function verifyWorkroomSaveReceipt(input:{purpose:WorkroomSavedPurpose;receipt:WorkroomSaveReceipt|null;inputRevision:number;
  sameFolder:()=>boolean|Promise<boolean>;projectEvidence:()=>string}):Promise<{startedAt:number|null}>{
  const receipt=input.receipt,context=input.purpose==='context';
  if(!receipt?.result.localSaved||receipt.binding!==input.inputRevision)
    throw new Error(context?WORKROOM_CONTEXT_SAVE_REFUSALS.unsaved:'현재 입력까지 저장된 결과가 확인되지 않아 터미널을 유지합니다.');
  const sameFolder=await input.sameFolder();
  if(context){if(!sameFolder)throw new Error(WORKROOM_CONTEXT_SAVE_REFUSALS.folder);}
  else if(!sameFolder||!receipt.evidence||input.projectEvidence()!==receipt.evidence)throw new Error('저장 이후 활동 또는 프로젝트 변경이 있습니다. 다시 저장 후 종료하세요.');
  return {startedAt:receipt.startedAt};
}
