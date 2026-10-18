import type {CorrectionOutcomeStatus} from './projectMemoryCorrectionOutcome';

/**
 * Browser-safe wire contract of the Mac-only correction-outcome management route (S4-05/S4-06). The server half is
 * src/correctionOutcomeManagement.ts; this file has no node imports so the panel can share it.
 */
export const CORRECTION_OUTCOMES_PATH = '/api/agent-runtime/correction-outcomes';
export const CORRECTION_OUTCOMES_MAX_REQUEST_BYTES = 8 * 1024;
export const CORRECTION_OUTCOME_LIST_LIMIT = 20;
export const CORRECTION_OUTCOME_BIND_CHECK_LIMIT = 4;

export type CorrectionOutcomeVerdict = 'avoided' | 'repeated' | 'unsure';
export type CorrectionOutcomeRequest =
  | {operation: 'list'; folderPath: string; requestId: string}
  | {operation: 'attest'; unitId: string; verdict: CorrectionOutcomeVerdict; requestId: string}
  | {operation: 'bind'; unitId: string; checkIds: string[]; requestId: string};

export interface CorrectionOutcomeListRow {
  unitId: string;
  conversationTitle: string | null;
  entryTitle: string | null;
  /** The entry still has the body version that was delivered. */
  entryCurrent: boolean;
  writtenAt: string;
  windowClosesAt: string;
  windowOpen: boolean;
  attestable: boolean;
  outcome: CorrectionOutcomeStatus | null;
  attestations: CorrectionOutcomeVerdict[];
  boundChecks: string[];
  availableChecks: string[];
}
export interface CorrectionOutcomeListResult {ok: true; operation: 'list'; units: CorrectionOutcomeListRow[]; truncated: boolean}
export interface CorrectionOutcomeWriteResult {ok: true; operation: 'attest' | 'bind'; unitId: string; recorded: 'inserted' | 'exists'; conflict?: boolean}
export type CorrectionOutcomeResult = CorrectionOutcomeListResult | CorrectionOutcomeWriteResult;

/** Sends one request through the agent-runtime management proxy (the app) or same-origin fetch (local web). */
export async function requestCorrectionOutcomes(request: CorrectionOutcomeRequest): Promise<CorrectionOutcomeResult> {
  const {isTauri} = await import('./lib/env');
  let status: number, body: any;
  if (isTauri()) {
    const {invoke} = await import('@tauri-apps/api/core');
    const result = await invoke<{status: number; body: any}>('agent_runtime_request', {path: CORRECTION_OUTCOMES_PATH, method: 'POST', body: request});
    status = result.status; body = result.body;
  } else {
    const response = await fetch(CORRECTION_OUTCOMES_PATH, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)});
    status = response.status; body = await response.json().catch(() => null);
  }
  if (status >= 400 || body?.ok !== true) throw new Error(typeof body?.error === 'string' ? body.error : '교정 결과 요청을 처리하지 못했습니다.');
  return body as CorrectionOutcomeResult;
}
