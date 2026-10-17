/**
 * How the desktop app follows an agentstoz_use (or voice) navigation request served by
 * GET /api/agentstoz-use/workroom-navigation: the OPS panel, a started Workroom session, or a
 * project to show (「<프로젝트> 열어」). Browser-safe; the App only wires fetch and state setters.
 */
export const AGENTSTOZ_USE_NAVIGATION_POLL_MS = 2_000;

const AGENTS = ['codex', 'claude', 'hermes', 'agy'] as const;
export type AgentsToZUseNavigationAgent = typeof AGENTS[number];
export type AgentsToZUseNavigation =
  | {kind: 'ops'; nonce: string}
  | {kind: 'workroom'; nonce: string; targetId: string; agent: AgentsToZUseNavigationAgent; sessionId: string}
  | {kind: 'project'; nonce: string; projectId: string};

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The pending request in a navigation response body, or null. */
export function parseAgentsToZUseNavigation(body: unknown): AgentsToZUseNavigation | null {
  if (!body || typeof body !== 'object' || (body as {success?: unknown}).success !== true) return null;
  const navigation = (body as {navigation?: unknown}).navigation as Record<string, unknown> | null | undefined;
  if (!navigation || typeof navigation !== 'object' || !text(navigation.nonce)) return null;
  const nonce = navigation.nonce;
  if (navigation.panel === 'ops') return {kind: 'ops', nonce};
  if (navigation.projectId !== undefined) return text(navigation.projectId) ? {kind: 'project', nonce, projectId: navigation.projectId} : null;
  if (text(navigation.targetId) && text(navigation.sessionId) && (AGENTS as readonly unknown[]).includes(navigation.agent)) {
    return {kind: 'workroom', nonce, targetId: navigation.targetId, agent: navigation.agent as AgentsToZUseNavigationAgent, sessionId: navigation.sessionId};
  }
  return null;
}

/** The sidebar section that lists a project (worktree rows live under 「워크트리」), or null when it is not loaded. */
export function projectFocusSection(ports: readonly {id: string; worktreePath?: string | null}[], projectId: string): 'wt' | 'all' | null {
  const project = ports.find(port => port.id === projectId);
  return project ? (project.worktreePath ? 'wt' : 'all') : null;
}

/**
 * Checks for a navigation request right away, every AGENTSTOZ_USE_NAVIGATION_POLL_MS while the page
 * is visible, and on focus/visibility changes. An app that already has focus never gets a focus
 * event, so the interval is what makes a request from another AI or from voice show up. Checks
 * never overlap, and a nonce is consumed once (`lastNonce` survives a remount). Returns stop().
 */
export function startAgentsToZUseNavigationPolling(options: {
  fetchNavigation: () => Promise<unknown>;
  onNavigation: (navigation: AgentsToZUseNavigation) => void;
  isVisible: () => boolean;
  lastNonce: {current: string};
  subscribe: (check: () => void) => () => void;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}): () => void {
  let inFlight = false, stopped = false;
  const check = async () => {
    if (stopped || inFlight || !options.isVisible()) return;
    inFlight = true;
    try {
      const navigation = parseAgentsToZUseNavigation(await options.fetchNavigation());
      if (stopped || !navigation || navigation.nonce === options.lastNonce.current) return;
      options.lastNonce.current = navigation.nonce;
      options.onNavigation(navigation);
    } catch { /* An older sidecar may not serve navigation; the next check tries again. */ }
    finally { inFlight = false; }
  };
  const run = () => { void check(); };
  run();
  const schedule = options.setInterval ?? ((callback: () => void, ms: number) => globalThis.setInterval(callback, ms));
  const cancel = options.clearInterval ?? ((timer: unknown) => globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>));
  const timer = schedule(run, AGENTSTOZ_USE_NAVIGATION_POLL_MS);
  const unsubscribe = options.subscribe(run);
  return () => { stopped = true; cancel(timer); unsubscribe(); };
}
