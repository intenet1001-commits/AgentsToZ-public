export const AI_TERMINAL_PREFIX = '/api/agent-runtime/terminals';
export const AI_TERMINAL_AGENTS = ['codex', 'claude', 'hermes', 'agy'] as const;
export type AiTerminalAgent = typeof AI_TERMINAL_AGENTS[number];
export interface AiTerminalRequest {
  requestId: string;
  operation: 'list' | 'start' | 'read' | 'input' | 'resize' | 'close';
  targetId?: string;
  agent?: AiTerminalAgent;
  sessionId?: string;
  after?: number;
  data?: string;
  cols?: number;
  rows?: number;
  prompt?: string;
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
}
const id = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(x);
const integer = (x: unknown, min: number, max: number) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
export function normalizeAiTerminalRequest(value: unknown): AiTerminalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('터미널 요청 형식이 올바르지 않습니다.');
  const r = value as AiTerminalRequest;
  const keys: Record<string, string[]> = {
    list: [], start: ['targetId', 'agent', 'cols', 'rows', 'prompt'], read: ['sessionId', 'after'],
    input: ['sessionId', 'data'], resize: ['sessionId', 'cols', 'rows'], close: ['sessionId'],
  };
  const allowed = keys[r.operation];
  if (!allowed || !id(r.requestId) || Object.keys(r).some(k => !['operation', 'requestId', ...allowed].includes(k))) throw new Error('허용되지 않은 터미널 요청입니다.');
  if (r.operation !== 'start' && r.operation !== 'list' && !id(r.sessionId)) throw new Error('터미널 세션 ID가 올바르지 않습니다.');
  if (r.operation === 'start' && (!id(r.targetId) || !AI_TERMINAL_AGENTS.includes(r.agent!))) throw new Error('등록 프로젝트와 AI를 선택하세요.');
  if (r.operation === 'start' || r.operation === 'resize') {
    if (!integer(r.cols, 20, 300) || !integer(r.rows, 5, 150)) throw new Error('터미널 크기가 올바르지 않습니다.');
  }
  if (r.operation === 'read' && !integer(r.after, 0, Number.MAX_SAFE_INTEGER)) throw new Error('출력 위치가 올바르지 않습니다.');
  if (r.operation === 'input' && (typeof r.data !== 'string' || r.data.length < 1 || new TextEncoder().encode(r.data).length > 4096)) throw new Error('한 번에 입력할 수 있는 크기를 초과했습니다.');
  if (r.prompt !== undefined && (typeof r.prompt !== 'string' || r.prompt.includes('\0') || new TextEncoder().encode(r.prompt).length > 24_000 || !['codex', 'claude'].includes(r.agent!))) throw new Error('이 AI에 전달할 수 없는 작업 요청입니다.');
  return { ...r };
}

export function normalizeAiTerminalResponse(value: unknown): AiTerminalResponse {
  const fail = () => { throw new Error('터미널 응답 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as AiTerminalResponse;
  if (Object.keys(r).some(k => !['session','sessions','chunks','nextCursor','truncated','hasMore'].includes(k))) return fail();
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
