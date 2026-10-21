/**
 * Workroom activity for this window. `useWorkroomActivity` owns the window's single long-poll (the App, or a
 * pop-out's own shell); every other reader uses `useWorkroomActivitySnapshot`, which never sends a request.
 */
import {useEffect, useSyncExternalStore} from 'react';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {terminalLocalRequest} from './aiTerminalClient';
import {isDeployedWeb, isTauri} from './lib/env';
import {createWorkroomActivityStore, workroomActivityTransport, type WorkroomActivitySnapshot, type WorkroomActivityStore} from './workroomActivityStore';

let shared: WorkroomActivityStore | null = null;
/** The window's store (created on first use). Tests may replace it before mounting. */
export function workroomActivityStore(): WorkroomActivityStore {
  shared ??= createWorkroomActivityStore({
    request: body => terminalLocalRequest(AI_TERMINAL_PREFIX, body),
    // The app's proxy holds a long-poll; the local web build polls without holding (browser connection limit).
    ...workroomActivityTransport(isTauri()),
    onVisibility: listener => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  });
  return shared;
}
export function setWorkroomActivityStoreForTests(store: WorkroomActivityStore | null) { shared = store; }

const subscribe = (listener: () => void) => workroomActivityStore().watch(listener);
const read = () => workroomActivityStore().getSnapshot();

/** Read-only: no request of its own. */
export function useWorkroomActivitySnapshot(): WorkroomActivitySnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** Owner: exactly one per window. Off on the deployed web (no sidecar there). */
export function useWorkroomActivity(enabled = true): WorkroomActivitySnapshot {
  useEffect(() => {
    if (!enabled || isDeployedWeb()) return;
    return workroomActivityStore().own();
  }, [enabled]);
  return useWorkroomActivitySnapshot();
}

/** Delay before a shown session counts as seen, so a row merely passed over does not clear it. */
export const WORKROOM_SEEN_DELAY_MS = 1_200;

/**
 * Seen = this window is visible and focused and shows the session (critique item 29). A finished turn becomes idle.
 * Debounced; it re-checks on focus and visibility changes.
 */
export function useWorkroomSeen(sessionId: string | null | undefined, enabled: boolean) {
  const snapshot = useWorkroomActivitySnapshot();
  const state = sessionId ? snapshot.sessions.get(sessionId)?.state : undefined;
  useEffect(() => {
    if (!enabled || !sessionId || state !== 'turn-finished' || typeof document === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (document.visibilityState === 'hidden' || !document.hasFocus()) return;
      timer = setTimeout(() => { timer = null; if (document.visibilityState !== 'hidden' && document.hasFocus()) void workroomActivityStore().markSeen(sessionId); }, WORKROOM_SEEN_DELAY_MS);
    };
    arm();
    window.addEventListener('focus', arm);
    window.addEventListener('blur', arm);
    document.addEventListener('visibilitychange', arm);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', arm);
      window.removeEventListener('blur', arm);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [enabled, sessionId, state]);
}
