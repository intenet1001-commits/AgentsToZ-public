import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';

/**
 * Copies an AI-facing prompt and records content-free provenance locally.
 * Copy success never depends on provenance registration: older sidecars and
 * deployed web pages can keep copying. Collection only claims `agentstoz`
 * when this registration reached the sidecar; otherwise it retains the
 * conservative human/external-or-unknown classification.
 */
export async function copyAgentsToZPrompt(prompt: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(prompt);
  try {
    if (isTauri() && String(import.meta.env.DEV) !== 'true') {
      await invoke('what_i_said_management_request', {
        path: '/api/what-i-said/prompt-origin/register',
        method: 'POST',
        body: { prompt },
      });
      return;
    }
    await fetch('/api/what-i-said/prompt-origin/register', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    // Provenance is auxiliary metadata. Never turn a successful clipboard
    // action into a visible failure because an older/offline sidecar lacks it.
  }
}
