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
import {planWorkroomRoute, workroomDeliveryInstruction, workroomRouteConfirmation, workroomRouteHeldReceipt, workroomRouteReceipt, workroomRouteUncertainReceipt} from './workroomProjectMention';
import {blockingPendingLaunch, launchNeverStarted, submitWorkroomDraft, WorkroomLaunchUnsupportedError, WorkroomSubmissionUnsupportedError, type PendingWorkroomLaunch, type PendingWorkroomSubmission} from './workroomSubmissionClient';
import {normalizeSubmissionReceipt, validateSubmissionText, type WorkroomSubmissionReceipt} from './workroomSubmissionProtocol';
import {forgetFailedLegacyStart, legacyRouteRetryConfirmation, legacyRouteRetryHeldReceipt, readFailedLegacyStart, rememberFailedLegacyStart, sessionOpenedSinceFailedStart} from './workroomLegacyStartGuard';

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
  confirm: (message: string) => boolean | Promise<boolean>;
  render: (text: string, cols: number, rows: number) => Promise<string[] | null>;
  /** A receiver that is closing or saving must not be typed into. */
  receiverBusy?: (sessionId: string) => boolean;
  /**
   * The destination's whole-request submission (terminal-submission-v1). When `supported`, the handoff into a
   * running receiver is one submission with a receipt instead of raw input parts. The unsettled record is kept
   * where the receiver's own tab shows it (`remember`), and a receiver that still holds one is not sent to again.
   */
  submission?: {
    supported: boolean;
    pending: (sessionId: string) => PendingWorkroomSubmission | null;
    remember: (sessionId: string, record: PendingWorkroomSubmission | null) => void;
    /**
     * terminal-start-submission-v1 (w2-followups #14): a new session's first request rides a launch receipt that names
     * the session, so a lost answer is checked instead of starting a second CLI, and a relay request past 11,000 bytes
     * needs no typing after start. The unsettled record goes where the receiver's panel shows its launch banner; one of
     * the same target and AI there refuses another launch. Absent: today's plain `start`, byte for byte.
     * Records are kept per launch id: a launch writes and clears only its own entry, so an unsettled launch of another
     * target is never erased (review 2026-10-15).
     */
    launch?: {
      pending: () => readonly PendingWorkroomLaunch[];
      remember: (id: string, record: PendingWorkroomLaunch | null) => void;
    };
    /**
     * The receiver's unsettled launches where no new launch can be recorded now (storage full — w4 review, finding 3):
     * the new session then starts plainly, but a readable record of the same target and AI still refuses it first, as
     * the panel's own start does. `pending` is consulted the same way whether or not a submission can be sent now.
     */
    launchRecords?: () => readonly PendingWorkroomLaunch[];
  };
  /**
   * The launch id of an earlier `uncertain` launch of this same draft to this same target and AI (review 2026-10-15).
   * Its outcome is read first, never re-sent: written means the request already ran in the session it opened, so this
   * send sends nothing and reports delivered (the caller clears the draft); never started goes on as usual; anything else
   * still recorded on the receiver is refused, and one the user dismissed there goes on as they chose.
   */
  earlierLaunchId?: string;
  /**
   * A receiver without launch receipts (w4 L1): a plain start that carried the handoff and failed is remembered here by
   * digest (target, AI, handoff — never the text) with the session ids known then. Sending the same handoff again asks
   * first when a session of that target and AI has opened since; declining sends nothing (`held` on that session).
   * Absent (or storage that refuses): today's behaviour. The guard is advisory and never sends anything itself.
   * `onUncertain` (w4 review, finding 1): told whenever the handoff may have reached a session the caller cannot name —
   * a lost start answer, a declined retry — with the session ids known when it went out, so the caller keeps protecting
   * the draft after the `@` chip is gone (a send of it into any other session of that target and AI asks first).
   */
  legacyStart?: {storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; scope: string; onUncertain?: (knownSessionIds: readonly string[]) => void};
  onStarted?: (session: AiTerminalSummary) => void;
  onProgress?: (progress: {sessionId: string; text: string}) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
}

/**
 * `delivered` clears the draft; `held` opened a session but did not type — or found the session an earlier failed start
 * may have opened and sent nothing (w4 L1) — so the draft stays; `uncertain` sent a
 * submission whose outcome is not known (the draft stays and the receiver keeps a pending record — it is never
 * sent again automatically); `cancelled` did nothing.
 */
export type WorkroomRouteDeliveryResult =
  | {status: 'cancelled'}
  | {status: 'delivered' | 'held'; receiver: AiTerminalSummary; receipt: string}
  /**
   * `receiver` is null for a launch whose new session is not known yet; its receiver keeps a launch record instead, and
   * `launchId` names it so the sender can tie its kept draft to that launch.
   */
  | {status: 'uncertain'; receiver: AiTerminalSummary | null; receipt: string; launchId?: string};

/** A launch (a new session's first request) went out but whether the session opened is not known. */
export function workroomRouteLaunchUncertainReceipt(input: {targetLabel: string; agentName: string; detail?: string}): string {
  return [
    `‘${input.targetLabel}’에 새 ${input.agentName} 세션 시작 결과 미확정 · 자동으로 다시 시작하지 않음.`,
    ...(input.detail ? [input.detail] : []),
    '그 화면의 세션 목록과 「새 세션 시작 결과 확인」으로 확인하세요. 작성 중인 내용은 유지했습니다.',
  ].join(' ');
}

/**
 * The outcome of an earlier uncertain launch of the same draft (review 2026-10-15). One read-only status — never a
 * re-send. `delivered` when it already ran; `null` when this send may go on; throws when it must not.
 */
async function earlierLaunchOutcome(input: WorkroomRouteDeliveryInput, id: string, agentName: string): Promise<WorkroomRouteDeliveryResult | null> {
  const store = input.submission?.launch ?? null;
  // Where no new launch can be recorded now the receiver's records still come as `launchRecords` (w4 review, finding 3):
  // they say «still recorded» all the same. Only `forget` needs the writable store (integration review w4, finding 3).
  const records = store ? () => store.pending() : input.submission?.launchRecords;
  let recorded: boolean;
  try { recorded = !!records && records().some(item => item.id === id); } catch { recorded = true; }
  const forget = () => { try { store?.remember(id, null); } catch { /* settled on the host; the receiver's banner checks it again */ } };
  let status: WorkroomSubmissionReceipt | undefined, session: AiTerminalSummary | undefined;
  try {
    const answer = await input.request({operation: 'submission', submission: {phase: 'status', id}});
    status = answer.submission ? normalizeSubmissionReceipt(answer.submission) : undefined;
    session = answer.session;
  } catch { /* refused below */ }
  if (!status || status.id !== id) {
    throw new Error('앞서 같은 요청으로 연 새 세션의 시작 결과를 확인하지 못해 보내지 않았습니다. 받는 곳의 세션 목록을 확인한 뒤 다시 전달하세요. 작성 중인 내용은 유지했습니다.');
  }
  if (status.state === 'written' && status.sessionId) {
    forget();
    const receiver = session?.id === status.sessionId ? session : input.sessions.find(item => item.id === status.sessionId)
      ?? {id: status.sessionId, targetId: input.target.targetId, agent: input.agent, state: 'running' as const, createdAt: new Date().toISOString(), exitCode: null, cols: 100, rows: 28};
    input.onStarted?.(receiver);
    return {status: 'delivered', receiver,
      receipt: `‘${input.target.label}’의 새 ${agentName} 세션이 앞서 보낸 같은 요청으로 이미 시작되었습니다 · 다시 보내지 않았습니다.`};
  }
  if (launchNeverStarted(status)) { forget(); return null; }
  if (recorded) {
    throw new Error('앞서 같은 요청으로 연 새 세션의 시작 결과가 아직 미확정입니다. 받는 곳의 「새 세션 시작 결과 확인」으로 확인한 뒤 다시 전달하세요. 작성 중인 내용은 유지했습니다.');
  }
  // The user checked that session list on the receiver and dismissed the record: sending again is their choice.
  return null;
}

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
  if (input.earlierLaunchId) {
    const earlier = await earlierLaunchOutcome(input, input.earlierLaunchId, agentName);
    if (earlier) return earlier;
  }
  const instruction = workroomDeliveryInstruction({task: input.task, sourceLabel: input.sourceLabel, sourceAgentLabel: WORKROOM_AGENT_NAMES[input.source.agent], sourceDeviceLabel: input.crossDevice?.sourceDeviceLabel, targetLabel: target.label});
  const references = [...input.references];
  // w4 L1: an earlier plain start of this very handoff failed. A session of this target and AI that opened since may be
  // running it already — asked before anything is sent or typed. Session ids decide, not clocks.
  const legacy = input.legacyStart ?? null;
  const legacyAttempt = {targetId: target.targetId, agent, prompt: instruction};
  let knownSessionIds = input.sessions.map(item => item.id);
  const failedStart = legacy ? readFailedLegacyStart(legacy.storage, legacy.scope, Date.now(), legacyAttempt) : null;
  if (failedStart) {
    let listed: readonly AiTerminalSummary[] = input.sessions;
    try { listed = (await input.request({operation: 'list'})).sessions ?? listed; } catch { /* decide from what the caller lists */ }
    knownSessionIds = [...new Set([...knownSessionIds, ...listed.map(item => item.id)])];
    const opened = sessionOpenedSinceFailedStart(failedStart, legacyAttempt, listed);
    if (opened) {
      const openedLabel = input.sessionLabel([...input.sessions.filter(item => item.id !== opened.id), opened], opened.id);
      if ((await input.confirm(legacyRouteRetryConfirmation(target.label, agentName, openedLabel))) !== true) {
        legacy!.onUncertain?.(failedStart.knownSessionIds);
        input.onStarted?.(opened);
        return {status: 'held', receiver: opened, receipt: legacyRouteRetryHeldReceipt(target.label, agentName, openedLabel)};
      }
    }
  }
  const startRequest = (prompt: boolean, withReferences: boolean): Omit<AiTerminalRequest, 'requestId'> => ({
    operation: 'start', targetId: target.targetId, agent, cols: 100, rows: 28, bypassPermissions: input.bypassPermissions,
    ...(prompt ? {prompt: instruction} : {}),
    ...(prompt && withReferences && references.length ? {references} : {}),
  });
  const launch = input.submission?.supported ? input.submission.launch ?? null : null;
  const launchText = instruction + '\r';
  const launchable = !!launch && (() => { try { validateSubmissionText(launchText); return true; } catch { return false; } })();
  // A launch carries up to 24,000 bytes on any connection: each request is one 4,000-byte chunk.
  const carries = launchable || workroomStartCarriesPrompt(startRequest(true, true), input.transport);
  /** An unsettled launch of this target and AI (or of an unknown one) on the receiver is checked there first. */
  const assertNoPendingLaunch = () => {
    const records = launchable ? launch!.pending : input.submission?.launchRecords;
    if (!records) return;
    let pending: PendingWorkroomLaunch | null;
    try { pending = blockingPendingLaunch(records(), target.targetId, agent); } catch { pending = {id: 'unreadable-launch', targetId: null, agent: null, receipt: null}; }
    if (pending) {
      throw new Error('받는 곳에 같은 프로젝트·AI의 새 세션 시작 결과가 아직 미확정입니다. 그 화면에서 「새 세션 시작 결과 확인」으로 확인한 뒤 다시 전달하세요. 작성 중인 내용은 유지했습니다.');
    }
  };
  const readScreen = (session: AiTerminalSummary) => readWorkroomScreen({
    sessionId: session.id,
    read: request => input.request(request),
    render: text => input.render(text, session.cols, session.rows),
    snapshotUnsupported: aiTerminalSnapshotUnsupported,
  }).catch(() => ({lines: null, complete: false}));
  const submission = input.submission?.supported ? input.submission : null;
  const typeIntoRaw = async (sessionId: string) => {
    const parts = splitTerminalSubmission(instruction + '\r');
    for (const [index, data] of parts.entries()) {
      await input.request({operation: 'input', sessionId, data, ...(references.length && index === parts.length - 1 ? {references} : {})});
    }
  };
  /**
   * A receiver still holding an unsettled submission is not sent to: the user checks that one first. Whether or not a
   * submission can be sent now (w4 review, finding 2): a record means one went out, and raw input past it would repeat it.
   */
  const assertNoPending = (sessionId: string) => {
    const records = input.submission;
    if (!records) return;
    let pending: PendingWorkroomSubmission | null;
    try { pending = records.pending(sessionId); } catch { pending = {id: 'unreadable-record', sessionId, receipt: null}; }
    if (pending) throw new Error('받는 세션에 앞서 보낸 요청의 전달 결과가 아직 미확정입니다. 그 세션에서 제출 결과를 확인한 뒤 다시 전달하세요. 작성 중인 내용은 유지했습니다.');
  };
  /** `written`, or why not. Nothing is retried, and nothing falls back to raw input after a request was sent. */
  const typeInto = async (sessionId: string): Promise<{written: true} | {written: false; detail?: string}> => {
    if (!submission) { await typeIntoRaw(sessionId); return {written: true}; }
    const text = instruction + '\r';
    validateSubmissionText(text);
    const id = crypto.randomUUID();
    submission.remember(sessionId, {id, sessionId, receipt: null});
    try {
      const receipt = await submitWorkroomDraft({id, sessionId, text, references, request: input.request,
        prepared: value => submission.remember(sessionId, {id, sessionId, receipt: value})});
      if (receipt.state === 'written') { submission.remember(sessionId, null); return {written: true}; }
      submission.remember(sessionId, {id, sessionId, receipt});
      return {written: false};
    } catch (error) {
      // An older receiver refused `submission` before anything ran: nothing was prepared, so no record is kept.
      if (error instanceof WorkroomSubmissionUnsupportedError) { try { submission.remember(sessionId, null); } catch { /* nothing was sent */ } throw error; }
      return {written: false, detail: error instanceof Error ? error.message : undefined};
    }
  };

  /**
   * One launch: the receipt names the new session. A failure gets one read-only status (never a re-send): written is
   * taken as started, a refusal before the spawn fence as never started, anything else stays unsettled.
   */
  type LaunchOutcome = {kind: 'delivered'; session: AiTerminalSummary} | {kind: 'uncertain'; id: string; detail?: string} | {kind: 'refused'; error: unknown};
  const launchInto = async (): Promise<LaunchOutcome> => {
    const record = launch!, id = crypto.randomUUID();
    // Only this launch's own entry is written or cleared; any other launch recorded there stays as it was.
    const remember = (value: PendingWorkroomLaunch | null) => { try { record.remember(id, value); } catch { /* the caller still reports it */ } };
    const pendingRecord = (receipt: WorkroomSubmissionReceipt | null): PendingWorkroomLaunch => ({id, targetId: target.targetId, agent, receipt});
    // Without its record a lost answer could not be checked, and nothing would refuse sending it again: not sent.
    try { record.remember(id, pendingRecord(null)); } catch { throw new Error('새 세션 시작 기록을 보관하지 못해 보내지 않았습니다. 작성 중인 내용은 유지했습니다.'); }
    let launched: AiTerminalSummary | undefined;
    const ask = async (value: Omit<AiTerminalRequest, 'requestId'>) => { const response = await input.request(value); if (response.session) launched = response.session; return response; };
    let receipt: WorkroomSubmissionReceipt;
    try {
      receipt = await submitWorkroomDraft({id, text: launchText, references, request: ask,
        launch: {targetId: target.targetId, agent, cols: 100, rows: 28, bypassPermissions: input.bypassPermissions},
        prepared: value => remember(pendingRecord(value))});
    } catch (error) {
      // Nothing ran: this path cannot take a launch. Only launches go back to a plain start, on the user's next click.
      if (error instanceof WorkroomSubmissionUnsupportedError) { remember(null); throw new WorkroomLaunchUnsupportedError(); }
      let status: WorkroomSubmissionReceipt | undefined;
      try { const answer = (await ask({operation: 'submission', submission: {phase: 'status', id}})).submission; status = answer ? normalizeSubmissionReceipt(answer) : undefined; } catch { /* stays unsettled */ }
      if (status?.id === id && status.state === 'written' && status.sessionId) receipt = status;
      else if (status?.id === id && launchNeverStarted(status)) { remember(null); return {kind: 'refused', error}; }
      else { remember(pendingRecord(status?.id === id ? status : null)); return {kind: 'uncertain', id, detail: error instanceof Error ? error.message : undefined}; }
    }
    if (receipt.state !== 'written' || !receipt.sessionId) {
      if (launchNeverStarted(receipt)) { remember(null); return {kind: 'refused', error: new Error('새 세션이 시작되지 않았습니다. 작성 중인 내용은 유지했습니다.')}; }
      remember(pendingRecord(receipt)); return {kind: 'uncertain', id};
    }
    remember(null);
    let opened = launched?.id === receipt.sessionId ? launched : undefined;
    if (!opened) { try { opened = ((await input.request({operation: 'list'})).sessions ?? []).find(item => item.id === receipt.sessionId); } catch { /* described below */ } }
    return {kind: 'delivered', session: opened ?? {id: receipt.sessionId, targetId: target.targetId, agent, state: 'running', createdAt: new Date().toISOString(), exitCode: null, cols: 100, rows: 28}};
  };

  if (plan.kind === 'deliver') {
    const receiver = plan.session;
    assertNoPending(receiver.id);
    const sessionLabel = input.sessionLabel(input.sessions, receiver.id);
    const screen = await readScreen(receiver);
    const lines = screen.complete ? screen.lines : null;
    if (lines && workroomScreenAwaitsAnswer(lines)) {
      // Typing there would answer that question. A new session gets the message instead, if the user agrees.
      assertNoPendingLaunch();
      if ((await input.confirm(workroomRouteConfirmation('blocked', target.label, agentName, {sessionLabel, screen: workroomScreenExcerpt(lines), typed: !carries}))) !== true) return {status: 'cancelled'};
    } else {
      if ((await input.confirm(workroomRouteConfirmation('deliver', target.label, agentName, {sessionLabel, screen: lines ? workroomScreenExcerpt(lines) : null}))) !== true) return {status: 'cancelled'};
      // The dialog may have stayed open while that session reached a question: look once more before typing.
      const again = await readScreen(receiver);
      if (!again.complete || !again.lines) {
        throw new Error('받는 세션의 현재 화면을 다시 확인하지 못해 입력하지 않았습니다. 작성 중인 내용은 유지했습니다.');
      }
      if (workroomScreenAwaitsAnswer(again.lines)) {
        throw new Error('받는 세션이 그 사이 질문이나 승인에 대한 답을 기다리는 화면으로 바뀌어 입력하지 않았습니다. 작성 중인 내용은 유지했습니다.');
      }
      if (input.receiverBusy?.(receiver.id)) throw new Error('받는 세션이 종료 중이거나 저장 중입니다. 잠시 후 다시 전달하세요.');
      const outcome = await typeInto(receiver.id);
      if (!outcome.written) return {status: 'uncertain', receiver, receipt: workroomRouteUncertainReceipt({targetLabel: target.label, agentName, sessionLabel, detail: outcome.detail})};
      return {status: 'delivered', receiver, receipt: workroomRouteReceipt({started: false, targetLabel: target.label, agentName, sessionLabel})};
    }
  } else {
    assertNoPendingLaunch();
    if ((await input.confirm(workroomRouteConfirmation('start', target.label, agentName, {typed: !carries}))) !== true) return {status: 'cancelled'};
  }

  // A new session: the message is its first request when this connection and this Mac can carry it.
  let session: AiTerminalSummary | undefined, referencesDropped = false, typedReason: 'size' | 'host' = carries ? 'host' : 'size';
  let tryPlainPrompt = true;
  if (launchable) {
    const outcome = await launchInto();
    if (outcome.kind === 'uncertain') return {status: 'uncertain', receiver: null, launchId: outcome.id, receipt: workroomRouteLaunchUncertainReceipt({targetLabel: target.label, agentName, detail: outcome.detail})};
    if (outcome.kind === 'delivered') {
      input.onStarted?.(outcome.session);
      const sessionLabel = input.sessionLabel([...input.sessions.filter(item => item.id !== outcome.session.id), outcome.session], outcome.session.id);
      return {status: 'delivered', receiver: outcome.session, receipt: workroomRouteReceipt({started: true, targetLabel: target.label, agentName, sessionLabel})};
    }
    // Definitively never started. Only "this Mac cannot take the first request" goes on, as before: a plain start, the
    // message typed once the screen is ready. Anything else is the caller's error; the draft stays.
    if (!workroomStartPromptRefused(outcome.error)) throw outcome.error;
    if ((outcome.error as {message?: unknown})?.message === AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR) typedReason = 'size';
    tryPlainPrompt = false;
  }
  const refused = (error: unknown) => {
    if (!workroomStartPromptRefused(error)) throw error;
    if ((error as {message?: unknown})?.message === AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR) typedReason = 'size';
  };
  if (carries && tryPlainPrompt && !launchable) {
    try {
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
    } catch (error) {
      // Not a refusal of the first request itself: the CLI may have opened with the handoff (w4 L1).
      if (legacy) {
        rememberFailedLegacyStart(legacy.storage, legacy.scope, {...legacyAttempt, knownSessionIds, at: Date.now()});
        legacy.onUncertain?.(knownSessionIds);
      }
      throw error;
    }
    // Only this handoff's own record is settled; a failed start of another request keeps asking on its retry.
    if (session && legacy) forgetFailedLegacyStart(legacy.storage, legacy.scope, legacyAttempt);
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
  const outcome = await typeInto(receiver.id);
  if (!outcome.written) return {status: 'uncertain', receiver, receipt: workroomRouteUncertainReceipt({targetLabel: target.label, agentName, sessionLabel, detail: outcome.detail})};
  return {status: 'delivered', receiver, receipt: workroomRouteReceipt({started: true, typed: typedReason, targetLabel: target.label, agentName, sessionLabel})};
}
