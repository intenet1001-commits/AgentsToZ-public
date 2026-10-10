import {aiInitialPromptError} from './aiInitialPrompt';

export const AI_TERMINAL_PREFIX = '/api/agent-runtime/terminals';
export const AI_TERMINAL_MAX_REFERENCES = 8;
/** Remote capability: this host accepts `references` on Workroom input. */
export const AI_TERMINAL_REFERENCES_FEATURE = 'terminal-refs-v1';
export const AI_TERMINAL_AGENTS = ['codex', 'claude', 'hermes', 'agy'] as const;
export type AiTerminalAgent = typeof AI_TERMINAL_AGENTS[number];
export interface AiTerminalRequest {
  requestId: string;
  operation: 'list' | 'start' | 'read' | 'input' | 'resize' | 'close';
  targetId?: string;
  agent?: AiTerminalAgent;
  sessionId?: string;
  after?: number;
  /**
   * `read` only: answer with the current screen instead of replaying history from `after: 0`.
   * Snapshot pages retain the v1 response shape so older clients keep validating responses.
   */
  snapshot?: true;
  data?: string;
  expectedInputRevision?: number;
  cols?: number;
  rows?: number;
  prompt?: string;
  bypassPermissions?: boolean;
  memoryPolicy?: 'skip' | 'saved';
  saveRequestId?: string;
  /** `#` mentions: registered projects the AI may read for reference. The host resolves them. */
  references?: string[];
  /**
   * `start` only, Mac only (「다시 시작」): end this earlier session of the same project and AI, then open a new
   * one in its permission mode that continues its conversation when the host can prove which one it was.
   */
  resumeFrom?: string;
}
export interface AiTerminalSummary {
  id: string; targetId: string; agent: AiTerminalAgent; state: 'running' | 'exited';
  createdAt: string; exitCode: number | null; cols: number; rows: number;
}
export interface AiTerminalResponse {
  sessions?: AiTerminalSummary[];
  session?: AiTerminalSummary;
  chunks?: { seq: number; text: string }[];
  nextCursor?: number;
  truncated?: boolean;
  hasMore?: boolean;
  /** Only on a `resumeFrom` start: true when the new CLI continues the earlier conversation. */
  resumed?: boolean;
}
/** What a Mac that predates `snapshot` answers to it: its strict key check rejects the request. */
export const AI_TERMINAL_UNKNOWN_REQUEST_ERROR = '허용되지 않은 터미널 요청입니다.';
/**
 * A start's first request was refused. A Mac built before 2026-09-22 answers this for Hermes and
 * Antigravity (it took a first request only for Codex and Claude), so a client can still open the
 * session plainly and type the request once the CLI is ready.
 */
export const AI_TERMINAL_PROMPT_REFUSED_ERROR = '이 AI에 전달할 수 없는 작업 요청입니다.';
/** The host adds `#` reference folders to a first request after the 24,000-byte check; this is the re-check. */
export const AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR = '참고 프로젝트 폴더까지 더하면 첫 요청이 24,000바이트를 넘습니다. 새 세션을 연 뒤 나누어 전달하세요.';
/** The relay's refusal code when the Mac cannot parse a terminal request at all. */
export const AI_TERMINAL_REQUEST_INVALID_CODE = 'TERMINAL_REQUEST_INVALID';
/** True when a `snapshot` read was refused because the Mac does not know the field. */
export function aiTerminalSnapshotUnsupported(error: unknown): boolean {
  const value = error as {code?: unknown; message?: unknown} | null;
  return !!value && typeof value === 'object'
    && (value.code === AI_TERMINAL_REQUEST_INVALID_CODE
      || value.message === AI_TERMINAL_UNKNOWN_REQUEST_ERROR
      || value.message === '터미널 요청 형식이 올바르지 않습니다.');
}
const id = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(x);
const integer = (x: unknown, min: number, max: number) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
export function normalizeAiTerminalRequest(value: unknown): AiTerminalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('터미널 요청 형식이 올바르지 않습니다.');
  const r = value as AiTerminalRequest;
  const keys: Record<string, string[]> = {
    list: [], start: ['targetId', 'agent', 'cols', 'rows', 'prompt', 'bypassPermissions', 'references', 'resumeFrom'], read: ['sessionId', 'after', 'snapshot'],
    input: ['sessionId', 'data', 'expectedInputRevision', 'references'], resize: ['sessionId', 'cols', 'rows'], close: ['sessionId','memoryPolicy','saveRequestId'],
  };
  const allowed = keys[r.operation];
  if (!allowed || !id(r.requestId) || Object.keys(r).some(k => !['operation', 'requestId', ...allowed].includes(k))) throw new Error(AI_TERMINAL_UNKNOWN_REQUEST_ERROR);
  if (r.operation !== 'start' && r.operation !== 'list' && !id(r.sessionId)) throw new Error('터미널 세션 ID가 올바르지 않습니다.');
  if(r.operation==='close'&&((r.memoryPolicy!==undefined&&!['skip','saved'].includes(r.memoryPolicy))||(r.memoryPolicy==='saved'?!id(r.saveRequestId):r.saveRequestId!==undefined)))throw new Error('종료 전 저장 요청을 확인하세요.');
  if (r.operation === 'start' && (!id(r.targetId) || !AI_TERMINAL_AGENTS.includes(r.agent!))) throw new Error('등록 프로젝트와 AI를 선택하세요.');
  if (r.bypassPermissions !== undefined && typeof r.bypassPermissions !== 'boolean') throw new Error('실행 권한 옵션을 확인하세요.');
  if (r.operation === 'start' || r.operation === 'resize') {
    if (!integer(r.cols, 20, 300) || !integer(r.rows, 5, 150)) throw new Error('터미널 크기가 올바르지 않습니다.');
  }
  if (r.operation === 'read' && !integer(r.after, 0, Number.MAX_SAFE_INTEGER)) throw new Error('출력 위치가 올바르지 않습니다.');
  if (r.snapshot !== undefined && r.snapshot !== true) throw new Error(AI_TERMINAL_UNKNOWN_REQUEST_ERROR);
  if (r.expectedInputRevision !== undefined && !integer(r.expectedInputRevision,0,Number.MAX_SAFE_INTEGER)) throw new Error('입력 revision을 확인하세요.');
  if (r.references !== undefined && (!Array.isArray(r.references) || r.references.length < 1 || r.references.length > AI_TERMINAL_MAX_REFERENCES || !r.references.every(id) || new Set(r.references).size !== r.references.length)) throw new Error('참고할 프로젝트 목록이 올바르지 않습니다.');
  // A start carries references only for its first request (an @ route that opens a new session).
  if (r.operation === 'start' && r.references !== undefined && r.prompt === undefined) throw new Error('참고할 프로젝트는 작업 요청과 함께 보내세요.');
  // A restart reopens the earlier session as it was: no new request, and its own permission mode.
  if (r.resumeFrom !== undefined && (!id(r.resumeFrom) || r.prompt !== undefined || r.references !== undefined || r.bypassPermissions !== undefined)) throw new Error('다시 시작할 세션을 확인하세요.');
  if (r.operation === 'input' && (typeof r.data !== 'string' || r.data.length < 1 || new TextEncoder().encode(r.data).length > 4096)) throw new Error('한 번에 입력할 수 있는 크기를 초과했습니다.');
  // 네 에이전트 모두 초기 프롬프트를 받는다. 예전에 codex/claude만 허용했던 이유는
  // 서버가 `-- <prompt>` 한 가지 형태만 만들었기 때문이다. hermes 는 `--` 자체를 거부하고
  // agy 는 --prompt-interactive 여야 세션이 유지된다. 형태는 aiTerminalPromptArgs 가 정한다.
  if (r.prompt !== undefined && (aiInitialPromptError(r.prompt) || !AI_TERMINAL_AGENTS.includes(r.agent!))) throw new Error(AI_TERMINAL_PROMPT_REFUSED_ERROR);
  return { ...r };
}

export function normalizeAiTerminalResponse(value: unknown): AiTerminalResponse {
  const fail = () => { throw new Error('터미널 응답 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as AiTerminalResponse;
  if (Object.keys(r).some(k => !['session','sessions','chunks','nextCursor','truncated','hasMore','resumed'].includes(k))) return fail();
  if (r.resumed !== undefined && (typeof r.resumed !== 'boolean' || !r.session)) return fail();
  const summary = (s: AiTerminalSummary) => {
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['id','targetId','agent','state','createdAt','exitCode','cols','rows'].includes(k))
      || !id(s.id) || !id(s.targetId) || !AI_TERMINAL_AGENTS.includes(s.agent)
      || !['running','exited'].includes(s.state) || typeof s.createdAt !== 'string' || s.createdAt.length > 40 || !Number.isFinite(Date.parse(s.createdAt))
      || !(s.exitCode === null || integer(s.exitCode,-255,255)) || !integer(s.cols,20,300) || !integer(s.rows,5,150)) return fail();
  };
  if (r.session !== undefined) summary(r.session);
  if (r.sessions !== undefined) {
    if (!Array.isArray(r.sessions) || r.sessions.length > 24) return fail();
    r.sessions.forEach(summary);
    if(new Set(r.sessions.map(s=>s.id)).size!==r.sessions.length) return fail();
  }
  if (r.chunks !== undefined) {
    if (!Array.isArray(r.chunks) || r.chunks.length > 4 || r.chunks.some((c,i) => !c || Object.keys(c).some(k=>!['seq','text'].includes(k)) || !integer(c.seq,1,Number.MAX_SAFE_INTEGER) || typeof c.text !== 'string' || c.text.length > 1024 || (i>0 && c.seq <= r.chunks![i-1]!.seq))) return fail();
    if (!r.session || !integer(r.nextCursor,0,Number.MAX_SAFE_INTEGER) || (typeof r.truncated !== 'boolean' || typeof r.hasMore !== 'boolean') || (r.chunks.length && r.nextCursor !== r.chunks.at(-1)!.seq)) return fail();
  } else if(r.nextCursor!==undefined || r.truncated!==undefined || r.hasMore!==undefined) return fail();
  if(!r.session && !r.sessions) return fail();
  return r;
}
