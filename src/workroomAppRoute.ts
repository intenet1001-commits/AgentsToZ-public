import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';
import {CODE_APP_TASK_PREFILL_MAX_BYTES, codexTaskFitsDeepLink} from './codeAppTask';

/**
 * 워크룸 `@` 전달의 **앱** 받는 곳 (2026-10-08).
 *
 * `@프로젝트`의 「받는 곳」은 원래 그 프로젝트의 워크룸 CLI(Codex CLI·Claude Code·Hermes·Antigravity)뿐이었다.
 * 여기에 데스크톱 앱(Codex 앱·Claude 앱·Hermes 앱·Antigravity 앱)을 더한다. CLI 전달(`planWorkroomRoute`·
 * `deliverWorkroomRoute`)은 LAN 페이지에 `toString()`으로 심기므로 **그쪽 의미를 바꾸지 않고** 앱은 이
 * 모듈에서만 다룬다. 값은 `app:<agent>` 문자열이라 `AiTerminalAgent`와 섞이지 않는다.
 *
 * 앱이 실제로 받는 것은 서로 다르다 — 거짓 성공을 말하지 않도록 판정을 한 곳에 둔다:
 * - Codex 앱: 새 대화를 열고 작업을 입력칸에 **채우도록 요청한다**(보내지 않고, 앱이 채웠는지 알려 주지 않는다).
 *   Codex 링크에 담기에 길면(인코딩한 링크 기준 — 한글은 약 900자) 채우지 않는다.
 * - Claude 앱·Hermes 앱: 프로젝트로 열지만 첫 요청을 받지 않는다 → 클립보드.
 * - Antigravity 앱: 프로젝트도 요청도 받지 않는다(실행·앞으로 가져오기만) → 클립보드.
 * 어느 앱이든 작업은 먼저 클립보드에 복사한다 — Codex 채우기도 확인되지 않으므로 그것이 백업이다.
 *
 * 앱 받는 곳은 **이 Mac 화면에서만** 보인다. 휴대폰(원격)·다른 아젠투지로 보내는 경로에는 없다.
 */

export const WORKROOM_APP_DISPATCH_PATH = '/api/agent-runtime/app-dispatch';
export const WORKROOM_APP_AGENTS = ['codex', 'claude', 'hermes', 'agy'] as const;
export type WorkroomAppAgent = typeof WORKROOM_APP_AGENTS[number];
export type WorkroomAppChoice = `app:${WorkroomAppAgent}`;
export type WorkroomRouteChoice = AiTerminalAgent | WorkroomAppChoice;

export const WORKROOM_APP_NAMES: Record<WorkroomAppAgent, string> = {
  codex: 'Codex 앱', claude: 'Claude 앱', hermes: 'Hermes 앱', agy: 'Antigravity 앱',
};

/** Codex 앱 딥링크에 채울 수 있는 최대 바이트(서버와 같은 값). 실제 판정은 인코딩한 링크 길이도 본다. */
export const WORKROOM_APP_PREFILL_MAX_BYTES = CODE_APP_TASK_PREFILL_MAX_BYTES;
/**
 * Rust 프록시(`AGENT_RUNTIME_APP_DISPATCH_REQUEST_MAX_BYTES`)와 사이드카가 받는 최대 요청 크기. 넘는 요청은
 * 보내지 않고 거절한다 — 보내지도 않은 것을 「결과를 받지 못했다」고 말하지 않기 위해.
 */
export const WORKROOM_APP_DISPATCH_MAX_REQUEST_BYTES = 64 * 1024;

export function workroomAppChoice(agent: WorkroomAppAgent): WorkroomAppChoice {
  return `app:${agent}`;
}

/** `app:<agent>` → 그 앱. CLI 값·모르는 값은 null. */
export function workroomAppAgentOf(choice: string): WorkroomAppAgent | null {
  if (!choice.startsWith('app:')) return null;
  const agent = choice.slice(4);
  return (WORKROOM_APP_AGENTS as readonly string[]).includes(agent) ? agent as WorkroomAppAgent : null;
}

export function workroomCliAgentOf(choice: string): AiTerminalAgent | null {
  return (AI_TERMINAL_AGENTS as readonly string[]).includes(choice) ? choice as AiTerminalAgent : null;
}

/**
 * 앱 받는 곳을 보여도 되는가. 앱은 **이 Mac에서** 열리므로, 휴대폰이 몰고 있는 화면(`remote`)이나
 * 다른 아젠투지로 보내는 중(`routeDeviceId`)에는 없다 — 거기서 고르면 엉뚱한 기기의 앱이 열린다.
 */
export function workroomAppRoutesAvailable(input: {remote: boolean; routeDeviceId: string}): boolean {
  return !input.remote && !input.routeDeviceId;
}

/**
 * 이 작업이 그 앱의 입력칸에 들어가는가(Codex 링크에 담기는가). 이 화면은 폴더 경로를 모르므로 경로 몫을 넉넉히
 * 남겨 두고 판정한다 — 서버가 실제 경로로 다시 판정하고, 다르면 `taskApplied:false`로 답한다.
 */
export function workroomAppTakesTask(agent: WorkroomAppAgent, task: string): boolean {
  return agent === 'codex' && codexTaskFitsDeepLink(task.trim());
}

const REFERENCE_NOTE = '# 언급은 앱에 폴더로 전달되지 않고 이름만 글에 남습니다.';

/** 보내기 버튼 — 실제로 일어나는 일을 동사로 쓴다(「보내기」는 Codex 채우기에도 과장이다). */
export function workroomAppSendLabel(agent: WorkroomAppAgent, task: string): string {
  if (agent === 'codex' && workroomAppTakesTask(agent, task)) return 'Codex 앱 입력칸에 채우기';
  return `${WORKROOM_APP_NAMES[agent]} 열고 작업 복사`;
}

/** 확인 대화상자 — 첫 줄부터 무엇이 일어나는지 그대로 말한다. */
export function workroomAppConfirmMessage(agent: WorkroomAppAgent, targetLabel: string, task: string, references = 0): string {
  const note = references > 0 ? `\n\n${REFERENCE_NOTE}` : '';
  if (agent === 'codex') {
    return workroomAppTakesTask(agent, task)
      ? `‘${targetLabel}’ 작업으로 새 Codex 앱 대화를 엽니다.\n\n입력칸에 작업을 채우도록 요청합니다 — 앱이 채웠는지는 알려 주지 않으니 앱에서 확인한 뒤 보내기를 누르세요. 같은 내용을 클립보드에도 복사해 둡니다.${note}`
      : `새 Codex 앱 대화를 열고 ‘${targetLabel}’ 작업을 클립보드에 복사합니다.\n\n작업이 Codex 앱 링크에 담기에 길어 입력칸에 채울 수 없습니다. 앱 입력칸에 붙여 넣으세요.${note}`;
  }
  if (agent === 'agy') {
    return `Antigravity 앱을 열고 ‘${targetLabel}’ 작업을 클립보드에 복사합니다.\n\n이 앱은 폴더를 받지 않습니다. 프로젝트는 앱에서 선택하고, 작업은 클립보드에서 붙여 넣으세요.${note}`;
  }
  return `${WORKROOM_APP_NAMES[agent]}을 열고 ‘${targetLabel}’ 작업을 클립보드에 복사합니다.\n\n이 앱은 바깥에서 첫 요청을 받지 않습니다. 앱 입력칸에 붙여 넣으세요.${note}`;
}

/** 「받는 곳」 아래 미리보기 줄. */
export function workroomAppRoutePreview(agent: WorkroomAppAgent, targetLabel: string, task: string, references = 0): string {
  const note = references > 0 ? ` ${REFERENCE_NOTE}` : '';
  if (agent === 'codex') {
    return (workroomAppTakesTask(agent, task)
      ? `‘${targetLabel}’로 새 Codex 앱 대화를 열고 작업을 입력칸에 채우도록 요청합니다(보내기는 앱에서 확인 후). 클립보드에도 복사합니다.`
      : `‘${targetLabel}’로 새 Codex 앱 대화를 엽니다. 작업이 길어 입력칸 대신 클립보드에 복사합니다.`) + note;
  }
  if (agent === 'agy') return `Antigravity 앱을 엽니다. 프로젝트는 앱에서 선택하고, 작업은 클립보드에 복사합니다.${note}`;
  return `‘${targetLabel}’로 ${WORKROOM_APP_NAMES[agent]}을 열고 작업은 클립보드에 복사합니다(앱에 붙여 넣기).${note}`;
}

export interface WorkroomAppDispatchRequest {
  targetId: string;
  agent: WorkroomAppAgent;
  task?: string;
  bypass?: boolean;
}

const DISPATCH_KEYS = new Set(['targetId', 'agent', 'task', 'bypass']);

export class WorkroomAppDispatchRequestError extends Error {
  readonly code = 'WORKROOM_APP_DISPATCH_INVALID';
}

/** 사이드카가 받는 요청 — 키를 정확히 맞춘다. 경로는 받지 않는다(targetId를 새로 풀어 쓴다). */
export function normalizeWorkroomAppDispatchRequest(value: unknown): WorkroomAppDispatchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !DISPATCH_KEYS.has(key))) {
    throw new WorkroomAppDispatchRequestError('앱 전달 요청 형식이 올바르지 않습니다.');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
    throw new WorkroomAppDispatchRequestError('받는 프로젝트가 올바르지 않습니다.');
  }
  if (typeof body.agent !== 'string' || !(WORKROOM_APP_AGENTS as readonly string[]).includes(body.agent)) {
    throw new WorkroomAppDispatchRequestError('받는 앱은 Codex·Claude·Hermes·Antigravity 중 하나여야 합니다.');
  }
  if (body.task !== undefined && typeof body.task !== 'string') {
    throw new WorkroomAppDispatchRequestError('작업 요청은 글이어야 합니다.');
  }
  if (body.bypass !== undefined && typeof body.bypass !== 'boolean') {
    throw new WorkroomAppDispatchRequestError('권한 우회 값이 올바르지 않습니다.');
  }
  return {
    targetId: body.targetId.trim(),
    agent: body.agent as WorkroomAppAgent,
    ...(body.task !== undefined ? {task: body.task} : {}),
    ...(body.bypass !== undefined ? {bypass: body.bypass} : {}),
  };
}

/**
 * `/api/open-code-app`이 받는 본문. 전달은 새 일이다 — Hermes는 「최근 대화 다시 열기」 대신 프로젝트 전용 앱을,
 * Codex는 작업이 없어도(링크에 담기에 길어 클립보드로 넘긴 경우) **새 대화**를 연다. 최근 대화가 없을 때 실패하거나
 * 옛 대화가 열리면 안 된다. 작업은 받을 수 있는 Codex에만 넘긴다(다른 앱은 크기 검사에 걸릴 이유가 없다).
 * 권한 우회는 Claude 앱만 받는다.
 */
export function workroomAppOpenCodeAppBody(request: WorkroomAppDispatchRequest, folderPath: string): Record<string, unknown> {
  return {
    agent: request.agent,
    folderPath,
    ...(request.agent === 'hermes' ? {mode: 'open'} : request.agent === 'codex' ? {mode: 'new'} : {}),
    ...(request.agent === 'claude' && request.bypass === true ? {bypass: true} : {}),
    ...(request.agent === 'codex' && request.task !== undefined ? {task: request.task} : {}),
  };
}

/**
 * 사이드카가 화면에 돌려주는 본문 — 실제 폴더 경로는 이 프로세스를 떠나지 않는다(오류 문장 안에서도).
 */
export function workroomAppDispatchPublicBody(body: Record<string, unknown>, target: {targetId: string; projectLabel: string; cwd: string}, agent: WorkroomAppAgent): Record<string, unknown> {
  const out: Record<string, unknown> = {...body};
  delete out.folderPath;
  for (const key of ['error', 'warning', 'taskNote', 'projectNote'] as const) {
    if (typeof out[key] === 'string') out[key] = (out[key] as string).split(target.cwd).join(`‘${target.projectLabel}’`);
  }
  return {...out, agent, targetId: target.targetId, projectLabel: target.projectLabel};
}

export interface WorkroomAppDispatchResult {
  ok: boolean;
  code?: string;
  error?: string;
  /** 앱이 떴는지 확인됐는가. false면 「확인하지 못했다」. undefined면 서버가 말하지 않았다. */
  launchVerified?: boolean;
  warning?: string;
  /** Antigravity는 false — 프로젝트를 앱에서 골라야 한다. */
  projectApplied?: boolean | 'requested';
  taskApplied?: 'prefilled' | false;
  taskReason?: string;
  reusedActiveSession?: boolean;
}

/** 서버 응답을 화면이 믿을 수 있는 모양으로 줄인다. 모르는 값은 버린다(주장하지 않는다). */
export function normalizeWorkroomAppDispatchResult(status: number, body: unknown): WorkroomAppDispatchResult {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const ok = status < 400 && value.success === true;
  const text = (key: string) => typeof value[key] === 'string' && (value[key] as string).trim() ? (value[key] as string).trim().slice(0, 400) : undefined;
  if (!ok) {
    return {ok: false, code: text('code'), error: text('error') ?? '앱을 열지 못했습니다. 잠시 후 다시 시도하세요.'};
  }
  return {
    ok: true,
    ...(typeof value.launchVerified === 'boolean' ? {launchVerified: value.launchVerified} : {}),
    ...(text('warning') ? {warning: text('warning')} : {}),
    ...(value.projectApplied === true || value.projectApplied === false || value.projectApplied === 'requested' ? {projectApplied: value.projectApplied} : {}),
    ...(value.taskApplied === 'prefilled' || value.taskApplied === false ? {taskApplied: value.taskApplied} : {}),
    ...(text('taskReason') ? {taskReason: text('taskReason')} : {}),
    ...(typeof value.reusedActiveSession === 'boolean' ? {reusedActiveSession: value.reusedActiveSession} : {}),
  };
}

export type WorkroomAppClipboardState = 'copied' | 'failed';

/**
 * 작업이 확실히 어딘가에 남았는가 — 아니면 초안을 지우면 안 된다. Codex 「채우기」는 요청일 뿐 앱이 확인해 주지
 * 않으므로 근거가 되지 못한다: 클립보드에 복사된 경우에만 지운다.
 */
export function workroomAppTaskKept(_result: WorkroomAppDispatchResult, clipboard: WorkroomAppClipboardState): boolean {
  return clipboard === 'copied';
}

/** 실패 문구 — 미리 복사해 둔 경우 그 사실도 말한다(사용자의 원래 클립보드는 이미 바뀌었다). */
export function workroomAppFailureText(result: WorkroomAppDispatchResult, clipboard: WorkroomAppClipboardState): string {
  const base = result.error ?? '앱을 열지 못했습니다.';
  return clipboard === 'copied' ? `${base} · 작업 내용은 클립보드에 복사돼 있고, 입력칸의 글도 그대로입니다.` : base;
}

/**
 * Rust 프록시가 **요청을 쓰기 전에** 내는 오류 문장(src-tauri/src/lib.rs, 테스트가 그 문장이 있는지 지킨다).
 * 이 경우 앱은 확실히 열리지 않았다 — 「결과를 받지 못했다」가 아니라 실패로 말한다.
 */
export const WORKROOM_APP_DISPATCH_PRE_SEND_ERRORS = [
  '허용되지 않은 에이전트 런타임 요청입니다',
  '에이전트 런타임 요청 본문이 올바르지 않습니다',
  '에이전트 런타임 요청이 너무 큽니다',
  '에이전트 런타임 보안 연결을 준비하지 못했습니다',
  'AgentsToZ 로컬 API 연결 실패',
  '에이전트 런타임 보안 nonce를 만들지 못했습니다',
  '에이전트 런타임 보안 확인 요청을 만들지 못했습니다',
  '로컬 API의 보안 연결을 확인하지 못했습니다',
  '기능은 설치된 앱에서만 동작합니다',
  'Windows에서 아직 지원되지 않습니다',
] as const;

/** 프록시 오류가 보내기 전 거절인가. 모르는 문장은 「보냈을 수도 있다」로 남긴다(실패로 단정하지 않는다). */
export function workroomAppDispatchRefusedBeforeSend(error: unknown): string | null {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return WORKROOM_APP_DISPATCH_PRE_SEND_ERRORS.some(phrase => message.includes(phrase)) ? message.trim().slice(0, 400) : null;
}

/** 영수증 — 실제로 일어난 일만 말한다. */
export function workroomAppReceipt(input: {
  agent: WorkroomAppAgent;
  targetLabel: string;
  result: WorkroomAppDispatchResult;
  clipboard: WorkroomAppClipboardState;
  bypassRequested: boolean;
  droppedReferences?: number;
}): string {
  const {agent, result, clipboard} = input;
  const name = WORKROOM_APP_NAMES[agent];
  const parts: string[] = [];
  if (result.launchVerified === false) {
    parts.push(`${name}을 열도록 요청했지만 열렸는지 확인하지 못했습니다.${result.warning ? ` ${result.warning}` : ''}`);
  } else if (agent === 'codex') {
    parts.push(`‘${input.targetLabel}’로 새 Codex 앱 대화를 열도록 요청했습니다(앱이 연 대화는 확인하지 못합니다).`);
  } else if (agent === 'agy') {
    parts.push('Antigravity 앱을 열었습니다 · 프로젝트는 앱에서 선택하세요.');
  } else {
    parts.push(`‘${input.targetLabel}’로 ${name}을 열었습니다.`);
  }
  if (result.taskApplied === 'prefilled') {
    // Codex는 채웠는지 알려 주지 않는다 — 요청으로만 말하고, 클립보드 백업을 함께 밝힌다.
    parts.push('작업을 입력칸에 채우도록 요청했습니다 — 앱에서 확인한 뒤 보내기를 누르세요.');
    if (clipboard === 'copied') parts.push('같은 내용을 클립보드에도 복사해 두었습니다.');
    else parts.push('클립보드 복사는 실패해 입력칸의 글을 그대로 두었습니다.');
  } else if (clipboard === 'copied') {
    parts.push(agent === 'codex'
      ? '작업이 Codex 앱 링크에 담기에 길어 입력칸에 채우지 않았습니다 — 클립보드에 복사했으니 붙여 넣으세요.'
      : '작업 내용을 클립보드에 복사했습니다 — 앱 입력칸에 붙여 넣으세요.');
  } else {
    parts.push('작업 내용을 클립보드에 복사하지 못했습니다 — 입력칸의 글을 직접 복사해 붙여 넣으세요.');
  }
  if (input.bypassRequested && agent !== 'claude') parts.push(`권한 우회는 Claude 앱에만 적용됩니다 — ${name}에는 적용되지 않았습니다.`);
  if (input.droppedReferences) parts.push(REFERENCE_NOTE);
  return parts.join(' ');
}
