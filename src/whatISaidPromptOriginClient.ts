import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import { canRegisterWhatISaidPromptOrigin } from './whatISaidPromptOriginPolicy';

export const WHAT_I_SAID_PROMPT_ORIGIN_WEB_TIMEOUT_MS = 5_000;
type RegisterPrompt = (prompt: string) => Promise<unknown>;

async function registerPromptOrigin(prompt: string, webTimeoutMs: number): Promise<void> {
  if (isTauri() && String(import.meta.env.DEV) !== 'true') {
    // Keep the active slot until the actual invoke settles. Racing a timer here
    // would leave native requests alive and allow unbounded overlapping calls.
    await invoke('what_i_said_management_request', {
      path: '/api/what-i-said/prompt-origin/register',
      method: 'POST',
      body: { prompt },
    });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), webTimeoutMs);
  try {
    const response = await fetch('/api/what-i-said/prompt-origin/register', {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    // The receipt is unused; dispose of its body without buffering server data.
    await response.body?.cancel();
  } finally {
    clearTimeout(timer);
  }
}

/** An isolated queue factory; the application uses the single shared copier below. */
export function createAgentsToZPromptCopier(options: {
  register?: RegisterPrompt;
  webTimeoutMs?: number;
} = {}): (prompt: string) => Promise<void> {
  const webTimeoutMs = options.webTimeoutMs ?? WHAT_I_SAID_PROMPT_ORIGIN_WEB_TIMEOUT_MS;
  if (!Number.isSafeInteger(webTimeoutMs) || webTimeoutMs < 1 || webTimeoutMs > 60_000) {
    throw new Error('Invalid provenance timeout');
  }
  const register = options.register ?? ((prompt: string) => registerPromptOrigin(prompt, webTimeoutMs));
  let active = false;
  let latestPending: string | undefined;

  const start = (prompt: string): void => {
    active = true;
    void (async () => {
      try {
        await register(prompt);
      } catch {
        // Auxiliary metadata is best-effort. Never log prompt contents or make
        // clipboard success depend on an offline/older sidecar's response.
      } finally {
        active = false;
        const next = latestPending;
        latestPending = undefined;
        if (next !== undefined) start(next);
      }
    })();
  };

  return async (prompt: string): Promise<void> => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(prompt);
    if (!canRegisterWhatISaidPromptOrigin(prompt)) return;
    if (active) latestPending = prompt;
    else start(prompt);
  };
}

/** Resolves only after the real clipboard write, independently of provenance. */
export const copyAgentsToZPrompt = createAgentsToZPromptCopier();
