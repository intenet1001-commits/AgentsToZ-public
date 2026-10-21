/**
 * Workroom pop-out windows — the route contract (VOC 2026-09-25).
 *
 * A pop-out is the same app bundle opened with a query that renders only the
 * Workroom. The URL carries opaque ids only (session, registered target, agent,
 * the launch bypass default): never a path, token or prompt. The Rust command
 * `open_workroom_window` re-validates the same grammar against the shared golden
 * table `tests/fixtures/workroom-popout-golden.json`.
 */
import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';

export const WORKROOM_POPOUT_PARAM = 'workroom-popout';
/** Tauri window labels are `workroom-<n>`; the pop-out capability is scoped to this glob. */
export const WORKROOM_POPOUT_LABEL_GLOB = 'workroom-*';

export interface WorkroomPopoutRoute {
  sessionId: string;
  targetId: string;
  agent: AiTerminalAgent;
  /** Default for a new terminal opened from the pop-out (not a secret). */
  bypassPermissions: boolean;
}

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const KEYS = [WORKROOM_POPOUT_PARAM, 'session', 'target', 'agent', 'bypass'] as const;

export function buildWorkroomPopoutQuery(route: WorkroomPopoutRoute): string {
  if (!ID.test(route.sessionId) || !ID.test(route.targetId) || !AI_TERMINAL_AGENTS.includes(route.agent)) {
    throw new Error('분리할 워크룸 세션 정보가 올바르지 않습니다.');
  }
  // Ids are [A-Za-z0-9_-] only, so no encoding is needed and Rust can compare byte for byte.
  return `${WORKROOM_POPOUT_PARAM}=1&session=${route.sessionId}&target=${route.targetId}&agent=${route.agent}&bypass=${route.bypassPermissions ? '1' : '0'}`;
}

/** Web fallback: the app entry (`/`) on the current origin, pop-out query, no hash. */
export function buildWorkroomPopoutUrl(currentHref: string, route: WorkroomPopoutRoute): string {
  const url = new URL(currentHref);
  url.pathname = '/';
  url.search = '?' + buildWorkroomPopoutQuery(route);
  url.hash = '';
  return url.toString();
}

/** Strict: exactly the five keys, each once, or it is not a pop-out. */
export function parseWorkroomPopout(search: string): WorkroomPopoutRoute | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw || /[#%+]/.test(raw)) return null;
  const values = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const at = pair.indexOf('=');
    if (at <= 0) return null;
    const key = pair.slice(0, at), value = pair.slice(at + 1);
    if (!(KEYS as readonly string[]).includes(key) || values.has(key)) return null;
    values.set(key, value);
  }
  if (values.size !== KEYS.length || values.get(WORKROOM_POPOUT_PARAM) !== '1') return null;
  const sessionId = values.get('session')!, targetId = values.get('target')!, agent = values.get('agent')!, bypass = values.get('bypass')!;
  if (!ID.test(sessionId) || !ID.test(targetId) || !AI_TERMINAL_AGENTS.includes(agent as AiTerminalAgent)) return null;
  if (bypass !== '0' && bypass !== '1') return null;
  return {sessionId, targetId, agent: agent as AiTerminalAgent, bypassPermissions: bypass === '1'};
}

export function isWorkroomPopoutLabel(label: string): boolean {
  return /^workroom-[1-9][0-9]{0,5}$/.test(label);
}

export const WORKROOM_AGENT_NAMES: Record<AiTerminalAgent, string> = {codex: 'Codex CLI', claude: 'Claude Code', agy: 'Antigravity', hermes: 'Hermes'};

export function workroomPopoutTitle(projectLabel: string, agent: AiTerminalAgent): string {
  const label = projectLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '프로젝트';
  return `${label} · ${WORKROOM_AGENT_NAMES[agent]} — 워크룸`.slice(0, 120);
}

/**
 * The local transport is stateless per request (a fresh request id each time,
 * the sidecar fences and queues per session), so any number of windows can use
 * it. The remote transports are not: pairing keys, SAS approval and the relay
 * session live in this one page's memory, so a second window would have none.
 */
export function workroomPopoutAvailability({remote}: {remote: boolean; tauri: boolean}): {available: boolean; reason: string} {
  if (remote) {
    return {available: false, reason: '휴대폰·원격 연결은 이 화면 하나에만 묶여 있어 새 창으로 분리할 수 없습니다. Mac 앱의 워크룸에서 분리해 주세요.'};
  }
  return {available: true, reason: '이 작업 세션을 앱 밖의 별도 창으로 엽니다. 창을 닫아도 세션은 계속 실행됩니다.'};
}
