/**
 * Delivering an `@` route safely (review 2026-09-29).
 *
 * - M2: a running session the user is not looking at may be showing an approval, trust or menu
 *   prompt. Typing a handoff there answers it — the trailing Enter picks the highlighted default —
 *   while the receipt still says "delivered". So the receiving session's screen is read first
 *   (`readWorkroomScreen` + `renderWorkroomScreenLines`) and judged (`workroomScreenAwaitsAnswer`).
 * - H1/M1: a new session's first request travels in one message, and how big it may be depends on
 *   the connection: the Mac's own API takes the host's 24,000-byte first request, the phone
 *   portal's relay 11,000 bytes of plaintext per request, the LAN page 16 KiB per frame. What does
 *   not fit is typed into the new session once its screen is ready (`waitForWorkroomReady`).
 *
 * Functions marked "self-contained" are embedded into the LAN phone page with `toString()`
 * (remoteControlMobilePage.ts), so they may not reference module scope.
 */
import {WORKROOM_AGENT_NAMES} from './workroomPopout';
import {aiInitialPromptError} from './aiInitialPrompt';
import {splitTerminalSubmission} from './aiTerminalInput';
import {
  AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR,
  AI_TERMINAL_PROMPT_REFUSED_ERROR,
  aiTerminalSnapshotUnsupported,
  type AiTerminalAgent,
  type AiTerminalRequest,
  type AiTerminalResponse,
  type AiTerminalSummary,
} from './aiTerminalProtocol';
import {REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES} from './remoteControlRelayCrypto';
import {planWorkroomRoute, workroomDeliveryInstruction, workroomRouteConfirmation, workroomRouteHeldReceipt, workroomRouteReceipt} from './workroomProjectMention';

/**
 * Self-contained. Whether the bottom of a screen is a question the next Enter would answer: a trust
 * or approval dialog, a y/n prompt, or a menu with a highlighted numbered option. Only the last ten
 * non-empty rows count, so an answered prompt that scrolled up does not block, and weak signals (an
 * answer option such as "Allow", a question) count only together, so ordinary transcript text does not.
 */
export function workroomScreenAwaitsAnswer(lines: readonly string[] | null | undefined): boolean {
  if (!lines) return false;
  const tail: string[] = [];
  for (let index = lines.length - 1; index >= 0 && tail.length < 10; index--) {
    const line = String(lines[index] ?? '').replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line) tail.unshift(line);
  }
  // An empty composer below everything means the CLI is idle: approval, trust and selection dialogs
  // replace the input box, so only prompt-like rows BELOW the last empty composer can be a question.
  // (Claude and agy draw an empty ">" row; Codex shows its placeholder after "›".) Re-review N1:
  // Claude repeats the user's last prompt after "> ", so a numbered prompt read as a menu before.
  let idleAt = -1;
  for (let index = tail.length - 1; index >= 0; index--) {
    if (/^[>›❯](?:$|\s+(?:ask codex to do anything|type your message|send a message)\b)/i.test(tail[index]!)) { idleAt = index; break; }
  }
  const live = tail.slice(idleAt + 1);
  const text = live.join('\n');
  if (/\bdo you trust\b/i.test(text)) return true;
  if (/[([](?:y\/n|yes\/no)[)\]]/i.test(text)) return true;
  if (/\benter to (?:confirm|continue|select|proceed|submit)\b/i.test(text)) return true;
  // A highlighted numbered option is a menu only with a sibling option.
  const numbered = live.map(line => /^(?:[❯›▸▶➤>]\s*)?(\d{1,2})[.)]\s*\S/.exec(line)?.[1]).filter(Boolean);
  if (live.some(line => /^[❯›▸▶➤>]\s*\d{1,2}[.)]\s*\S/.test(line)) && new Set(numbered).size > 1) return true;
  const option = live.some(line => /^(?:[❯›▸▶➤•*]\s*)?(?:\d{1,2}[.)]\s*)?(?:yes|no|allow|deny|approve|reject|always|accept|decline)\b/i.test(line));
  const question = live.some(line => /\?\s*$/.test(line) && /\b(?:allow|approve|proceed|continue|run|trust|want|like|confirm|accept)\b/i.test(line));
  return option && question;
}

/** Self-contained. The last non-empty rows of a screen for a dialog: box borders dropped, bounded in count and width. */
export function workroomScreenExcerpt(lines: readonly string[] | null | undefined, maxLines = 8, maxChars = 96): string[] {
  const out: string[] = [];
  if (!lines) return out;
  for (let index = lines.length - 1; index >= 0 && out.length < maxLines; index--) {
    const line = String(lines[index] ?? '').replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const characters = Array.from(line);
    out.unshift(characters.length > maxChars ? characters.slice(0, maxChars - 1).join('') + '…' : line);
  }
  return out;
}

/** A terminal that parses output without being shown: xterm's `Terminal` (never opened) or `@xterm/headless`. */
export interface WorkroomScreenTerminal {
  write(data: string, callback?: () => void): void;
  readonly buffer: {readonly active: {readonly baseY: number; getLine(y: number): {translateToString(trimRight?: boolean): string} | undefined}};
  dispose(): void;
}

/**
 * Self-contained. The visible rows of raw output as a terminal of this size shows them: a TUI's
 * redraws collapse into its last frame instead of piling up as they would with escapes stripped.
 * A terminal parses asynchronously; if it never reports back, what it has so far is read.
 */
export function renderWorkroomScreenLines(create: (cols: number, rows: number) => WorkroomScreenTerminal, text: string, cols: number, rows: number, timeoutMs = 1500): Promise<string[] | null> {
  const width = Math.max(20, Math.min(300, Math.floor(cols) || 80)), height = Math.max(5, Math.min(150, Math.floor(rows) || 24));
  return new Promise(resolve => {
    let terminal: WorkroomScreenTerminal | undefined, done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      let lines: string[] | null = null;
      try {
        const buffer = terminal!.buffer.active;
        lines = [];
        for (let y = 0; y < height; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
      } catch { lines = null; }
      try { terminal?.dispose(); } catch { /* already gone */ }
      resolve(lines);
    };
    try { terminal = create(width, height); } catch { resolve(null); return; }
    timer = setTimeout(finish, timeoutMs);
    try { terminal.write(text, finish); } catch { finish(); }
  });
}

/**
 * Self-contained. A session's current screen through the ordinary `read` operation: the Mac's
 * snapshot of it (at most two pages) plus anything printed since, or — on a Mac that predates
 * `snapshot` — its whole output when that fits in `maxReads` pages. More than that is reported as
 * unknown (`complete: false`), never as the old screen those first pages showed.
 */
export async function readWorkroomScreen(input: {
  sessionId: string;
  read: (request: {operation: 'read'; sessionId: string; after: number; snapshot?: true}) => Promise<{chunks?: readonly {seq: number; text: string}[]; hasMore?: boolean}>;
  render: (text: string) => Promise<string[] | null>;
  snapshotUnsupported?: (error: unknown) => boolean;
  maxReads?: number;
}): Promise<{lines: string[] | null; complete: boolean}> {
  const maxReads = input.maxReads ?? 4;
  let text = '', after = 0, snapshot = true;
  for (let reads = 0; reads < maxReads; reads++) {
    let page;
    try {
      page = await input.read(snapshot
        ? {operation: 'read', sessionId: input.sessionId, after, snapshot: true}
        : {operation: 'read', sessionId: input.sessionId, after});
    } catch (error) {
      // A Mac that predates `snapshot` refuses the key; its plain read replays the output from the start.
      if (snapshot && after === 0 && input.snapshotUnsupported?.(error)) { snapshot = false; reads--; continue; }
      throw error;
    }
    for (const chunk of page.chunks ?? []) {
      if (chunk.seq > after) { text += chunk.text; after = chunk.seq; }
    }
    if (!page.hasMore) return {lines: await input.render(text), complete: true};
  }
  return {lines: null, complete: false};
}

/**
 * Waits for a freshly started CLI: its output must have begun and then stayed quiet for `quietMs`.
 * The caller then judges the rendered screen (a trust or login prompt is not ready for a message).
 */
export async function waitForWorkroomReady(input: {
  sessionId: string;
  read: (request: {operation: 'read'; sessionId: string; after: number}) => Promise<{chunks?: readonly {seq: number; text: string}[]; hasMore?: boolean; session?: {state: string}}>;
  render: (text: string) => Promise<string[] | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  quietMs?: number;
  pollMs?: number;
}): Promise<{state: 'settled' | 'exited' | 'timeout'; lines: string[] | null}> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? 20_000, quietMs = input.quietMs ?? 1_500, pollMs = input.pollMs ?? 400;
  const started = now();
  let text = '', after = 0, lastOutputAt: number | null = null;
  for (;;) {
    const page = await input.read({operation: 'read', sessionId: input.sessionId, after});
    for (const chunk of page.chunks ?? []) {
      if (chunk.seq > after) { text += chunk.text; after = chunk.seq; lastOutputAt = now(); }
    }
    const at = now();
    if (page.session?.state === 'exited') return {state: 'exited', lines: text ? await input.render(text) : null};
    if (!page.hasMore && lastOutputAt !== null && at - lastOutputAt >= quietMs) return {state: 'settled', lines: await input.render(text)};
    if (at - started >= timeoutMs) return {state: 'timeout', lines: text ? await input.render(text) : null};
    if (!page.hasMore) await sleep(pollMs);
  }
}

/** Room kept under the relay's plaintext limit for whatever the relay adds later. */
export const WORKROOM_RELAY_REQUEST_MARGIN_BYTES = 128;

/** The relay plaintext of one terminal request: `{type, sessionToken (43 chars), request + a UUID request id}`. */
export function workroomRelayRequestBytes(request: Omit<AiTerminalRequest, 'requestId'>): number {
  return new TextEncoder().encode(JSON.stringify({
    type: 'terminal.request',
    sessionToken: 'x'.repeat(43),
    request: {...request, requestId: '00000000-0000-4000-8000-000000000000'},
  })).length;
}

/** Whether a start can carry its first request on this connection; what cannot is typed once the session is ready. */
export function workroomStartCarriesPrompt(request: Omit<AiTerminalRequest, 'requestId'>, transport: 'local' | 'relay'): boolean {
  if (request.prompt === undefined) return true;
  if (aiInitialPromptError(request.prompt)) return false;
  return transport === 'local' || workroomRelayRequestBytes(request) <= REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES - WORKROOM_RELAY_REQUEST_MARGIN_BYTES;
}

/**
 * The Mac could not take this start's first request, but would open the session without one: an
 * older Mac (unknown key, or no first request for Hermes/Antigravity before 2026-09-22), or reference
 * folders pushing the request over 24,000 bytes. Anything else is a real failure.
 */
export function workroomStartPromptRefused(error: unknown): boolean {
  const message = (error as {message?: unknown} | null)?.message;
  return aiTerminalSnapshotUnsupported(error) || message === AI_TERMINAL_PROMPT_REFUSED_ERROR || message === AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR;
}

export interface WorkroomRouteDeliveryInput {
  /** The sessions this panel lists; the receiver is chosen among them. */
  sessions: readonly AiTerminalSummary[];
  /** The session whose composer sends. */
  source: AiTerminalSummary;
  sourceLabel: string;
  target: {targetId: string; label: string};
  agent: AiTerminalAgent;
  /**
   * The receiver is another AgentsToZ in the community: `sessions` and `request` already belong to
   * that device, so the plan must never read as 「current conversation」, and the handoff names the
   * sending Mac. `target.label` carries the device («2호 · 총괄») so every dialog says where it goes.
   */
  crossDevice?: {sourceDeviceLabel: string};
  task: string;
  references: readonly string[];
  /** `relay`: the phone portal (11,000 bytes of plaintext per request). `local`: the Mac's own API. */
  transport: 'local' | 'relay';
  bypassPermissions: boolean;
  /** The tab label of a session among these sessions (`#n` when a project runs several of an AI). */
  sessionLabel: (sessions: readonly AiTerminalSummary[], id: string) => string | undefined;
  request: (request: Omit<AiTerminalRequest, 'requestId'>) => Promise<AiTerminalResponse>;
  confirm: (message: string) => boolean;
  render: (text: string, cols: number, rows: number) => Promise<string[] | null>;
  /** A receiver that is closing or saving must not be typed into. */
  receiverBusy?: (sessionId: string) => boolean;
  onStarted?: (session: AiTerminalSummary) => void;
  onProgress?: (progress: {sessionId: string; text: string}) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
}

/** `delivered` clears the draft; `held` opened a session but did not type, so the draft stays; `cancelled` did nothing. */
export type WorkroomRouteDeliveryResult =
  | {status: 'cancelled'}
  | {status: 'delivered' | 'held'; receiver: AiTerminalSummary; receipt: string};

function startedSession(response: AiTerminalResponse): AiTerminalSummary {
  if (!response.session || response.session.state !== 'running') throw new Error('대상 프로젝트의 워크룸 세션 시작을 확인하지 못했습니다.');
  return response.session;
}

/**
 * The Workroom panel's `@` delivery (desktop and phone portal). The chosen AI's newest running
 * session in the target receives the handoff — after its screen was read and shown in the dialog,
 * and never while it waits on a question. Otherwise a new session starts with the handoff as its
 * first request when the connection and the Mac can carry it, and else gets it typed once ready.
 * Throws on a real failure; the caller keeps the draft.
 */
export async function deliverWorkroomRoute(input: WorkroomRouteDeliveryInput): Promise<WorkroomRouteDeliveryResult> {
  const {target, agent} = input;
  const agentName = WORKROOM_AGENT_NAMES[agent];
  // Another device's session is never 「the current conversation」, even if a targetId happened to match.
  const plan = planWorkroomRoute(input.sessions, input.crossDevice ? null : input.source, target.targetId, agent);
  if (plan.kind === 'current') throw new Error('같은 프로젝트·같은 AI는 현재 세션으로 보냅니다.');
  const instruction = workroomDeliveryInstruction({task: input.task, sourceLabel: input.sourceLabel, sourceAgentLabel: WORKROOM_AGENT_NAMES[input.source.agent], sourceDeviceLabel: input.crossDevice?.sourceDeviceLabel, targetLabel: target.label});
  const references = [...input.references];
  const startRequest = (prompt: boolean, withReferences: boolean): Omit<AiTerminalRequest, 'requestId'> => ({
    operation: 'start', targetId: target.targetId, agent, cols: 100, rows: 28, bypassPermissions: input.bypassPermissions,
    ...(prompt ? {prompt: instruction} : {}),
    ...(prompt && withReferences && references.length ? {references} : {}),
  });
  const carries = workroomStartCarriesPrompt(startRequest(true, true), input.transport);
  const readScreen = (session: AiTerminalSummary) => readWorkroomScreen({
    sessionId: session.id,
    read: request => input.request(request),
    render: text => input.render(text, session.cols, session.rows),
    snapshotUnsupported: aiTerminalSnapshotUnsupported,
  }).catch(() => ({lines: null, complete: false}));
  const typeInto = async (sessionId: string) => {
    const parts = splitTerminalSubmission(instruction + '\r');
    for (const [index, data] of parts.entries()) {
      await input.request({operation: 'input', sessionId, data, ...(references.length && index === parts.length - 1 ? {references} : {})});
    }
  };

  if (plan.kind === 'deliver') {
    const receiver = plan.session;
    const sessionLabel = input.sessionLabel(input.sessions, receiver.id);
    const screen = await readScreen(receiver);
    const lines = screen.complete ? screen.lines : null;
    if (lines && workroomScreenAwaitsAnswer(lines)) {
      // Typing there would answer that question. A new session gets the message instead, if the user agrees.
      if (!input.confirm(workroomRouteConfirmation('blocked', target.label, agentName, {sessionLabel, screen: workroomScreenExcerpt(lines), typed: !carries}))) return {status: 'cancelled'};
    } else {
      if (!input.confirm(workroomRouteConfirmation('deliver', target.label, agentName, {sessionLabel, screen: lines ? workroomScreenExcerpt(lines) : null}))) return {status: 'cancelled'};
      // The dialog may have stayed open while that session reached a question: look once more before typing.
      const again = await readScreen(receiver);
      if (!again.complete || !again.lines) {
        throw new Error('받는 세션의 현재 화면을 다시 확인하지 못해 입력하지 않았습니다. 작성 중인 내용은 유지했습니다.');
      }
      if (workroomScreenAwaitsAnswer(again.lines)) {
        throw new Error('받는 세션이 그 사이 질문이나 승인에 대한 답을 기다리는 화면으로 바뀌어 입력하지 않았습니다. 작성 중인 내용은 유지했습니다.');
      }
      if (input.receiverBusy?.(receiver.id)) throw new Error('받는 세션이 종료 중이거나 저장 중입니다. 잠시 후 다시 전달하세요.');
      await typeInto(receiver.id);
      return {status: 'delivered', receiver, receipt: workroomRouteReceipt({started: false, targetLabel: target.label, agentName, sessionLabel})};
    }
  } else if (!input.confirm(workroomRouteConfirmation('start', target.label, agentName, {typed: !carries}))) {
    return {status: 'cancelled'};
  }

  // A new session: the message is its first request when this connection and this Mac can carry it.
  let session: AiTerminalSummary | undefined, referencesDropped = false, typedReason: 'size' | 'host' = carries ? 'host' : 'size';
  const refused = (error: unknown) => {
    if (!workroomStartPromptRefused(error)) throw error;
    if ((error as {message?: unknown})?.message === AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR) typedReason = 'size';
  };
  if (carries) {
    try {
      session = startedSession(await input.request(startRequest(true, true)));
    } catch (error) {
      if (references.length && aiTerminalSnapshotUnsupported(error)) {
        // A Mac that predates references on start refuses the key: the request goes with names only.
        try {
          session = startedSession(await input.request(startRequest(true, false)));
          referencesDropped = true;
        } catch (again) { refused(again); }
      } else refused(error);
    }
  }
  const carried = !!session;
  const receiver = session ?? startedSession(await input.request(startRequest(false, false)));
  input.onStarted?.(receiver);
  const sessionLabel = input.sessionLabel([...input.sessions.filter(item => item.id !== receiver.id), receiver], receiver.id);
  if (carried) return {status: 'delivered', receiver, receipt: workroomRouteReceipt({started: true, targetLabel: target.label, agentName, referencesDropped, sessionLabel})};

  input.onProgress?.({sessionId: receiver.id, text: `‘${target.label}’에 새 ${agentName} 세션을 열었습니다. 화면이 준비되면 메시지를 입력합니다…`});
  const ready = await waitForWorkroomReady({
    sessionId: receiver.id,
    read: request => input.request(request),
    render: text => input.render(text, receiver.cols, receiver.rows),
    now: input.now, sleep: input.sleep, timeoutMs: input.readyTimeoutMs,
  });
  if (ready.state !== 'settled' || !ready.lines || workroomScreenAwaitsAnswer(ready.lines)) {
    const reason = ready.state === 'exited' ? 'exited' : ready.state === 'settled' && ready.lines ? 'awaiting' : 'timeout';
    return {status: 'held', receiver, receipt: workroomRouteHeldReceipt({targetLabel: target.label, agentName, reason, sessionLabel, screen: ready.lines ? workroomScreenExcerpt(ready.lines) : null})};
  }
  await typeInto(receiver.id);
  return {status: 'delivered', receiver, receipt: workroomRouteReceipt({started: true, typed: typedReason, targetLabel: target.label, agentName, sessionLabel})};
}
