import type { ClaudeLaunchContext, ClaudeSessionRuntimeFacts, SessionOrigin } from './sessionOrigin';

/**
 * The client only receives this descriptive capability.  It never receives a
 * terminal handle, URL, cwd, or any other target that could be used to focus
 * an arbitrary application window.
 */
export type ContextSessionNavigationKind =
  | 'chatgpt-thread'
  | 'cmux-surface'
  | 'orca-worktree-terminal'
  | 'orca-floating-workspace'
  | 'claude-agent-view'
  | null;

export interface ContextSessionNavigation {
  available: boolean;
  kind: ContextSessionNavigationKind;
  /** `true` only when the backend can move to the individual session target. */
  exact: boolean;
  actionLabel: string | null;
  /** User-facing reason or scope note. Never contains raw handles or paths. */
  detail: string;
}

const unavailable = (detail: string): ContextSessionNavigation => ({
  available: false,
  kind: null,
  exact: false,
  actionLabel: null,
  detail,
});

const ORCA_FLOATING_WORKTREE_ID = 'global-floating-terminal';

/** Describe only navigation targets that have a stable identifier in the
 * Claude status-line snapshot.  Runtime existence is checked again by the API
 * immediately before the action; this is deliberately not a promise that an
 * old snapshot is still live. */
export function resolveClaudeSessionNavigation(
  context: ClaudeLaunchContext | null | undefined,
  runtime?: ClaudeSessionRuntimeFacts | null,
): ContextSessionNavigation {
  const ctx = context ?? {};

  // A background agent has no window of its own; Agent View is the only place
  // it can actually be reached. Offering that is honest, and strictly better
  // than the "이동 미지원" this used to fall through to.
  if (runtime?.backgroundAgent && !ctx.orcaWorktreeId && !ctx.cmuxWorkspaceId && !ctx.cmuxSurfaceId) {
    return {
      available: true,
      kind: 'claude-agent-view',
      exact: false,
      actionLabel: '에이전트 뷰 열기',
      detail: '백그라운드 에이전트에는 전용 창이 없습니다. 선택한 터미널에서 claude agents(Agent View)를 열어 이 세션을 확인하세요.',
    };
  }

  if (ctx.orcaWorktreeId === ORCA_FLOATING_WORKTREE_ID) {
    return {
      available: true,
      kind: 'orca-floating-workspace',
      exact: false,
      actionLabel: '플로팅 열기',
      detail: 'Orca 플로팅 작업공간만 엽니다. Orca의 안전한 공개 API로는 개별 플로팅 탭 선택을 보장할 수 없습니다.',
    };
  }

  if (ctx.orcaWorktreeId && ctx.orcaPaneKey) {
    return {
      available: true,
      kind: 'orca-worktree-terminal',
      exact: true,
      actionLabel: '창으로 이동',
      detail: '이동 직전에 Orca의 현재 터미널과 세션 식별자가 일치하는지 다시 확인합니다.',
    };
  }

  if (ctx.cmuxWorkspaceId && ctx.cmuxSurfaceId) {
    return {
      available: true,
      kind: 'cmux-surface',
      exact: true,
      actionLabel: '창으로 이동',
      detail: 'cmux의 workspace와 surface 식별자가 현재도 일치할 때만 해당 패널로 이동합니다.',
    };
  }

  if (ctx.cmuxWorkspaceId || ctx.cmuxSurfaceId) {
    return unavailable('cmux workspace와 surface 식별자가 모두 있어야 안전하게 이동할 수 있습니다.');
  }

  return unavailable('이 세션에는 특정 창을 식별할 수 있는 정보가 없습니다.');
}

/** ChatGPT desktop registers a per-thread `codex://threads/<id>` route.  Other
 * Codex origins only expose a cwd or a generic CLI marker, neither of which is
 * safe to turn into window navigation. */
export function resolveCodexSessionNavigation(origin: SessionOrigin): ContextSessionNavigation {
  if (origin.surfaceKind === 'desktop-app' && origin.clientLabel.startsWith('ChatGPT 앱')) {
    return {
      available: true,
      kind: 'chatgpt-thread',
      exact: true,
      actionLabel: '창으로 이동',
      detail: '현재 ChatGPT 앱의 같은 Codex 작업으로 이동합니다.',
    };
  }
  return unavailable('이 Codex 세션에는 기존 작업 창을 안전하게 여는 식별자가 없습니다.');
}
