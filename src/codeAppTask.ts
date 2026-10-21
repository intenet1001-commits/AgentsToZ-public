import {AI_INITIAL_PROMPT_MAX_BYTES} from './aiInitialPrompt';
import {startsWithShellEscape} from './workroomOrchestration';

/**
 * A task the user wants to hand to a desktop AI app (「…앱에서 열기」 with a request attached).
 *
 * Only the Codex app can take it — `codex://threads/new?path=…&prompt=…` asks Codex to **prefill** the
 * composer (it is not submitted, and Codex never confirms it). Claude/Hermes/Antigravity apps take no
 * initial message from outside, so the caller copies it to the clipboard and says so. Never report a task
 * as delivered when it was not.
 */
export const CODE_APP_TASK_PREFILL_MAX_BYTES = 4_000;
/** Same bound as a Workroom first request; anything bigger is refused before an app is touched. */
export const CODE_APP_TASK_MAX_BYTES = AI_INITIAL_PROMPT_MAX_BYTES;
/**
 * `buildCodexDesktopDeepLinkCommand` (src/codexDesktopProjectSubmit.ts) refuses a Codex URL longer than
 * this. The prefill decision is made on the **encoded** link, not on raw bytes: every Korean byte becomes
 * `%XX`, so 4,000 bytes of Korean are ~12,000 URL characters (a 2,700-byte task already broke the link).
 */
export const CODEX_DEEP_LINK_MAX_CHARS = 8_192;
/**
 * A caller that does not know the folder path (the Workroom panel only has a targetId) reserves this many
 * encoded characters for it. The server decides with the real path; when it disagrees it answers
 * `taskApplied:false` and the caller still has the clipboard copy.
 */
export const CODEX_DEEP_LINK_PATH_RESERVE_CHARS = 1_024;
const CODEX_NEW_THREAD_PREFIX = 'codex://threads/new?path=';
const CODEX_PROMPT_PARAM = '&prompt=';

export type CodeAppTaskAgent = 'codex' | 'claude' | 'hermes' | 'agy';
export type CodeAppTaskApplied = 'prefilled' | false;
export type CodeAppTaskReason = 'too-large' | 'unsupported-app';

export class CodeAppTaskError extends Error {
  constructor(message: string, readonly code: 'CODE_APP_TASK_INVALID' | 'CODE_APP_TASK_TOO_LARGE' | 'CODE_APP_TASK_SHELL_PREFIX') {
    super(message);
  }
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The same rules as a Workroom instruction (agentstozUseControl `workroomInstruction`): no control
 * characters except tab/newline, CRLF folded, trimmed, UTF-8 bounded, and no leading `!` — several
 * CLIs run that as a shell command without their own permission prompt.
 * `undefined` means «no task»; an empty or whitespace-only string is an error, not «no task».
 */
export function normalizeCodeAppTask(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')
    || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new CodeAppTaskError('작업 요청은 제어 문자가 없는 글이어야 합니다.', 'CODE_APP_TASK_INVALID');
  }
  const task = value.replace(/\r\n?/g, '\n').trim();
  if (utf8Bytes(task) > CODE_APP_TASK_MAX_BYTES) {
    throw new CodeAppTaskError(`작업 요청은 UTF-8 기준 ${CODE_APP_TASK_MAX_BYTES.toLocaleString('en-US')}바이트 이하여야 합니다.`, 'CODE_APP_TASK_TOO_LARGE');
  }
  if (startsWithShellEscape(task)) {
    throw new CodeAppTaskError('작업 요청이 !로 시작하면 일부 AI가 셸 명령으로 실행합니다. 자연어로 적어 주세요.', 'CODE_APP_TASK_SHELL_PREFIX');
  }
  return task;
}

/** The exact length of `buildCodeAppDeepLink('codex', folderPath, {prompt}).url` (code-app-links.ts; tests pin it). */
export function codexNewThreadLinkLength(folderPath: string, prompt?: string): number {
  return CODEX_NEW_THREAD_PREFIX.length + encodeURIComponent(folderPath).length
    + (prompt === undefined ? 0 : CODEX_PROMPT_PARAM.length + encodeURIComponent(prompt).length);
}

/**
 * Whether a task can ride the Codex new-thread link as a prefill: within the byte bound **and** the encoded
 * link fits. Without a folder path a conservative reserve stands in for it.
 */
export function codexTaskFitsDeepLink(task: string, folderPath?: string): boolean {
  if (utf8Bytes(task) > CODE_APP_TASK_PREFILL_MAX_BYTES) return false;
  const length = folderPath === undefined
    ? codexNewThreadLinkLength('', task) + CODEX_DEEP_LINK_PATH_RESERVE_CHARS
    : codexNewThreadLinkLength(folderPath, task);
  return length <= CODEX_DEEP_LINK_MAX_CHARS;
}

export interface CodeAppTaskPlan {
  /** Codex deep-link prompt, only when it fits. */
  prompt?: string;
  taskApplied: CodeAppTaskApplied;
  taskReason?: CodeAppTaskReason;
  /** Short Korean reason when the task did not reach the app. */
  taskNote?: string;
}

const APP_LABEL: Record<CodeAppTaskAgent, string> = {codex: 'Codex', claude: 'Claude', hermes: 'Hermes', agy: 'Antigravity'};

/** What happens to a normalized task for one app. Pure; the caller performs the launch. */
export function planCodeAppTask(agent: CodeAppTaskAgent, task: string, folderPath: string): CodeAppTaskPlan {
  if (agent === 'codex') {
    if (codexTaskFitsDeepLink(task, folderPath)) return {prompt: task, taskApplied: 'prefilled'};
    return {
      taskApplied: false, taskReason: 'too-large',
      taskNote: '작업 요청이 Codex 앱 링크에 담기에 길어 입력칸에 넣지 않았습니다.',
    };
  }
  return {taskApplied: false, taskReason: 'unsupported-app', taskNote: `${APP_LABEL[agent]} 앱은 바깥에서 첫 요청을 받지 않습니다.`};
}

export type OpenCodeAppMode = 'reopen' | 'new' | 'open' | 'prepare';

export type OpenCodeAppRequestCheck =
  | {ok: false; status: 400; code?: string; error: string}
  | {ok: true; agent: CodeAppTaskAgent; requestedMode?: OpenCodeAppMode; mode?: OpenCodeAppMode; task?: string};

/**
 * The checks `/api/open-code-app` makes before it looks at the folder or touches an app — pure, so the real
 * decision is tested (not a fixture's copy of it). A task is validated for every app (one rule for every
 * caller); Codex + task always means a new conversation (reopening cannot carry it).
 */
export function checkOpenCodeAppRequest(input: {agent?: unknown; mode?: unknown; task?: unknown}): OpenCodeAppRequestCheck {
  const {agent, mode: requestedMode} = input;
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'hermes' && agent !== 'agy') {
    return {ok: false, status: 400, error: 'agent must be codex, claude, hermes, or agy'};
  }
  if (requestedMode !== undefined && !['reopen', 'new', 'open', 'prepare'].includes(requestedMode as string)) {
    return {ok: false, status: 400, error: 'mode must be reopen, new, open, or prepare'};
  }
  let task: string | undefined;
  try {
    task = normalizeCodeAppTask(input.task);
  } catch (error) {
    if (error instanceof CodeAppTaskError) return {ok: false, status: 400, code: error.code, error: error.message};
    throw error;
  }
  const requested = requestedMode as OpenCodeAppMode | undefined;
  // `reopen` is the desktop button's default and is turned into a new conversation here; only the modes that
  // cannot carry a prefill at all are refused.
  if (task !== undefined && agent === 'codex' && (requested === 'prepare' || requested === 'open')) {
    return {ok: false, status: 400, code: 'CODE_APP_TASK_MODE_INVALID', error: '작업 요청은 Codex 새 대화에만 넣을 수 있습니다.'};
  }
  const mode = task !== undefined && agent === 'codex' ? 'new' : requested;
  if (mode === 'prepare' && agent !== 'codex') return {ok: false, status: 400, error: '프로젝트 첫 연결은 Codex 앱에서 지원합니다.'};
  if (mode === 'new' && agent !== 'codex') return {ok: false, status: 400, error: '새 데스크톱 작업 만들기는 Codex만 지원합니다.'};
  if (mode === 'open' && agent !== 'hermes') return {ok: false, status: 400, error: '프로젝트 전용 앱 열기는 Hermes Desktop만 지원합니다.'};
  return {ok: true, agent, ...(requested !== undefined ? {requestedMode: requested} : {}), ...(mode !== undefined ? {mode} : {}), ...(task !== undefined ? {task} : {})};
}
