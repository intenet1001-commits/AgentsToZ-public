/**
 * Interim guard for hosts without launch receipts (w2-followups #15, plan S3-2 item 9).
 *
 * A plain `start` whose answer was lost may still have opened the CLI with the request in it. Retrying the same request
 * then opens a second CLI that runs it again. A host with terminal-start-submission-v1 settles this with a receipt;
 * until every host has it, the panel remembers a failed start — the target, the AI, a digest of the prompt (never the
 * prompt) and the session ids it already knew — and, when the same request is retried and a new session for that target
 * and AI has appeared since, asks before starting another. Nothing is ever started or sent on its own.
 *
 * Session ids, not timestamps: a phone's clock and the Mac's clock need not agree, but a session id the panel did not
 * know before the attempt is unambiguous.
 *
 * The same guard covers an `@` route that opens a new session plainly and the LAN QR page's `@` route (w4 L1). The page
 * cannot import this module, so `legacyStartGuard` and the route wording below are self-contained: embedded with
 * `toString()` and built standalone in tests.
 */
import type {AiTerminalAgent, AiTerminalSummary} from './aiTerminalProtocol';
import {submissionDigest} from './workroomSubmissionProtocol';

export interface FailedLegacyStart {targetId: string; agent: AiTerminalAgent; digest: string; knownSessionIds: string[]; at: number}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Attempt = {targetId: string; agent: AiTerminalAgent; prompt: string};

/**
 * Self-contained. The whole guard from a SHA-256 hex function (`submissionDigest` here, the page's HTTP-safe SHA-256 on
 * the LAN page — tests hold the two equal), so both read and write one record format with one digest.
 *
 * Failed starts are kept per request (review 2026-10-15): a scope used to hold one record, and any successful start
 * cleared it, so starting another request erased the failed start of the first and its retry no longer asked.
 * Storage that refuses is ignored: the guard is advisory.
 */
export function legacyStartGuard(deps: {sha256Hex: (text: string) => string}) {
  const PREFIX = 'agentstoz:failed-start:v1:';
  /** Long enough for a user to notice the failure and retry; short enough that an unrelated later request is not caught. */
  const TTL = 30 * 60_000, KNOWN_SESSION_LIMIT = 64, LIMIT = 8, MAX_RAW = 65_536;
  const AGENTS = ['codex', 'claude', 'hermes', 'agy'];
  const opaque = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  const key = (scope: string) => PREFIX + encodeURIComponent(scope);
  const digest = (targetId: string, agent: string, prompt: string) => deps.sha256Hex(JSON.stringify([targetId, agent, prompt]));
  const valid = (r: FailedLegacyStart): FailedLegacyStart | null => {
    if (!r || typeof r !== 'object' || !opaque(r.targetId) || !AGENTS.includes(r.agent) || typeof r.digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.digest)
      || !Array.isArray(r.knownSessionIds) || !r.knownSessionIds.every(opaque) || !Number.isFinite(r.at)) return null;
    return {targetId: r.targetId, agent: r.agent, digest: r.digest, knownSessionIds: [...r.knownSessionIds], at: r.at};
  };
  /** Every readable record of the scope (a single object is the previous release's shape). Unreadable reads as none. */
  const all = (storage: Pick<Storage, 'getItem'>, scope: string): FailedLegacyStart[] => {
    try {
      const raw = storage.getItem(key(scope));
      if (!raw || raw.length > MAX_RAW) return [];
      const value = JSON.parse(raw) as unknown;
      return (Array.isArray(value) ? value : [value]).map(item => valid(item as FailedLegacyStart)).filter((item): item is FailedLegacyStart => !!item);
    } catch { return []; }
  };
  const store = (storage: Store, scope: string, records: readonly FailedLegacyStart[]) => {
    if (!records.length) { storage.removeItem(key(scope)); return; }
    storage.setItem(key(scope), JSON.stringify(records.slice(-LIMIT)));
  };
  const sameRequest = (record: FailedLegacyStart, attempt: Attempt) => record.targetId === attempt.targetId && record.agent === attempt.agent
    && record.digest === digest(attempt.targetId, attempt.agent, attempt.prompt);
  /** Records a failed start, replacing only an earlier record of the same request. With `null` forgets every record of the scope. */
  const remember = (storage: Store, scope: string, value: (Attempt & {knownSessionIds: readonly string[]; at: number}) | null) => {
    try {
      if (!value) { storage.removeItem(key(scope)); return; }
      const record: FailedLegacyStart = {targetId: value.targetId, agent: value.agent, digest: digest(value.targetId, value.agent, value.prompt),
        knownSessionIds: value.knownSessionIds.filter(opaque).slice(-KNOWN_SESSION_LIMIT), at: value.at};
      store(storage, scope, [...all(storage, scope).filter(item => !sameRequest(item, value)), record]);
    } catch { /* advisory only */ }
  };
  /** A successful start of this request settles its own failed record; records of other requests stay. */
  const forget = (storage: Store, scope: string, attempt: Attempt) => {
    try {
      const records = all(storage, scope);
      const kept = records.filter(item => !sameRequest(item, attempt));
      if (kept.length !== records.length) store(storage, scope, kept);
    } catch { /* advisory only */ }
  };
  /** The failed start of this request (`attempt`), or without one the newest record of the scope, within its lifetime. */
  const read = (storage: Pick<Storage, 'getItem'>, scope: string, now: number, attempt?: Attempt): FailedLegacyStart | null => {
    const live = all(storage, scope).filter(r => !(now - r.at > TTL || r.at - now > TTL));
    const found = attempt ? live.filter(r => sameRequest(r, attempt)) : live;
    return found[found.length - 1] ?? null;
  };
  /** The running session for the same request's target and AI that was not known when that start failed. */
  const openedSince = (record: FailedLegacyStart, attempt: Attempt, sessions: readonly AiTerminalSummary[]): AiTerminalSummary | null => {
    if (!sameRequest(record, attempt)) return null;
    const known = new Set(record.knownSessionIds);
    const opened = sessions.filter(session => session.state === 'running' && session.targetId === attempt.targetId
      && session.agent === attempt.agent && !known.has(session.id));
    return opened.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
  };
  return {TTL, key, digest, remember, forget, read, openedSince};
}

const guard = legacyStartGuard({sha256Hex: text => submissionDigest(new TextEncoder().encode(text))});

export const FAILED_LEGACY_START_TTL_MS = guard.TTL;
export function failedLegacyStartKey(scope: string) { return guard.key(scope); }
export function legacyStartDigest(targetId: string, agent: string, prompt: string): string { return guard.digest(targetId, agent, prompt); }
/** Records a failed start (see `legacyStartGuard`); a successful start forgets only its own request (`forgetFailedLegacyStart`). */
export function rememberFailedLegacyStart(storage: Store, scope: string, value: (Attempt & {knownSessionIds: readonly string[]; at: number}) | null) {
  guard.remember(storage, scope, value);
}
export function forgetFailedLegacyStart(storage: Store, scope: string, attempt: Attempt) { guard.forget(storage, scope, attempt); }
export function readFailedLegacyStart(storage: Pick<Storage, 'getItem'>, scope: string, now: number, attempt?: Attempt): FailedLegacyStart | null {
  return guard.read(storage, scope, now, attempt);
}
export function sessionOpenedSinceFailedStart(record: FailedLegacyStart, attempt: Attempt, sessions: readonly AiTerminalSummary[]): AiTerminalSummary | null {
  return guard.openedSince(record, attempt, sessions);
}

export function legacyStartRetryConfirmation(projectLabel: string, agentName: string): string {
  return `앞서 보낸 시작 요청은 실패로 보였지만, 그 뒤 ‘${projectLabel}’에 새 ${agentName} 세션이 열렸습니다. 그 세션이 이미 같은 요청을 받았을 수 있습니다.\n\n`
    + '같은 요청으로 새 세션을 하나 더 열까요? 취소하면 열린 세션을 선택하고 작성 내용은 그대로 둡니다.';
}

/** Self-contained. Before an `@` handoff is sent again after a plain start of it failed and a session opened since (w4 L1). */
export function legacyRouteRetryConfirmation(targetLabel: string, agentName: string, sessionLabel?: string): string {
  return `앞서 보낸 전달은 실패로 보였지만, 그 뒤 ‘${targetLabel}’에 새 ${agentName} 세션이 열렸습니다.`
    + (sessionLabel ? `\n받는 세션: ${sessionLabel}` : '')
    + '\n그 세션이 이미 이 메시지를 첫 요청으로 받았을 수 있습니다.\n\n'
    + '같은 메시지를 다시 전달할까요? 취소하면 보내지 않고 작성 중인 내용은 그대로 둡니다.';
}

/** Self-contained. What declining that question leaves: nothing sent, the draft kept, the opened session to check. */
export function legacyRouteRetryHeldReceipt(targetLabel: string, agentName: string, sessionLabel?: string): string {
  return `‘${targetLabel}’의 새 ${agentName} 세션${sessionLabel ? `(${sessionLabel})` : ''}이 앞서 보낸 같은 메시지를 이미 받았을 수 있어 보내지 않았습니다. `
    + '그 세션 화면을 확인하세요. 작성 중인 내용은 유지했습니다.';
}

export interface LegacyRouteSuspect {scope: string; targetId: string; agent: string; draft: string; label: string; knownSessionIds: string[]; at: number}

/**
 * Self-contained (the LAN page embeds it with `toString()`). This page's memory of `@` handoffs whose plain start lost its
 * answer, or whose retry the user declined (w4 review, finding 1): with the session ids known when the handoff went out.
 * A session of that target and AI that was not known then may already run it. The `@` chip cannot carry that protection —
 * choosing that session clears the chip, and the composer would type the same draft into it — so the composer asks first
 * (`find`) before sending the same draft into such a session. Asking is all it does: nothing is ever sent on its own.
 *
 * A second failure of the same handoff keeps the sessions known at the first one (intersection), so a session that may
 * have received the first attempt stays a suspect. Entries last as long as the failed-start record (30 minutes) and at
 * most 16 are kept, oldest first out.
 */
export function legacyRouteSuspects() {
  const TTL = 30 * 60_000, LIMIT = 16;
  type Key = {scope: string; targetId: string; agent: string; draft: string};
  type Entry = Key & {label: string; knownSessionIds: string[]; at: number};
  let entries: Entry[] = [];
  const same = (a: Key, b: Key) => a.scope === b.scope && a.targetId === b.targetId && a.agent === b.agent && a.draft === b.draft;
  /** A handoff that may have reached an unknown session. */
  const add = (value: Entry) => {
    const earlier = entries.find(item => same(item, value));
    const known = earlier ? earlier.knownSessionIds.filter(id => value.knownSessionIds.includes(id)) : [...value.knownSessionIds];
    entries = [...entries.filter(item => !same(item, value)), {scope: value.scope, targetId: value.targetId, agent: value.agent, draft: value.draft,
      label: value.label, knownSessionIds: known, at: value.at}].slice(-LIMIT);
  };
  /** The handoff this send would repeat into a session that may already run it, within its lifetime. */
  const find = (send: Key & {sessionId: string}, now: number): Entry | null =>
    entries.find(item => same(item, send) && Math.abs(now - item.at) <= TTL && !item.knownSessionIds.includes(send.sessionId)) ?? null;
  /** The user decided (delivered, or confirmed sending into that session): this handoff asks no more. */
  const clear = (key: Key) => { entries = entries.filter(item => !same(item, key)); };
  return {add, find, clear};
}

/** Self-contained. Before the same draft goes into a session a lost `@` handoff may have reached (w4 review, finding 1). */
export function legacyRouteSessionSendConfirmation(targetLabel: string, agentName: string, sessionLabel?: string): string {
  return `앞서 ‘${targetLabel}’로 보낸 같은 메시지의 새 ${agentName} 세션 시작 응답을 받지 못했습니다.`
    + (sessionLabel ? `\n이 세션: ${sessionLabel}` : '')
    + '\n이 세션이 그 메시지를 첫 요청으로 이미 받았을 수 있습니다.\n\n'
    + '같은 내용을 이 세션에 보낼까요? 취소하면 보내지 않고 작성 중인 내용은 그대로 둡니다.';
}

/** Self-contained. What declining that question leaves: nothing sent, the draft kept. */
export function legacyRouteSessionSendHeld(targetLabel: string, agentName: string, sessionLabel?: string): string {
  return `이 ${agentName} 세션${sessionLabel ? `(${sessionLabel})` : ''}이 앞서 ‘${targetLabel}’로 보낸 같은 메시지를 이미 받았을 수 있어 보내지 않았습니다. `
    + '세션 화면을 확인하세요. 작성 중인 내용은 유지했습니다.';
}
