import {useEffect, useState} from 'react';
import {isTauri} from './lib/env';
import {terminalLocalRequest} from './aiTerminalClient';
import {HERMES_VARIANTS_PATH, hermesVariantItems, normalizeHermesVariantView, type HermesVariant, type HermesVariantView} from './hermesVariants';

/**
 * 「Hermes · Claude」/「Hermes · Codex」 as this Mac sees them (src/hermesVariants.ts): which providers Hermes has a
 * credential for, and which variant each live session runs. One shared read for every launch list on screen — a
 * project list renders many cards, and each must not start its own CLI check.
 *
 * Only this Mac. In a browser (the deployed portal) there is no sidecar to ask, so the items are offered ungated and
 * nothing is fetched.
 */
const OFFERED: HermesVariantView = {items: hermesVariantItems(null), sessions: [], checked: false};
const FRESH_MS = 20_000;
let cached: {at: number; view: HermesVariantView} | null = null;
let inFlight: Promise<HermesVariantView> | null = null;
const listeners = new Set<(view: HermesVariantView) => void>();

export function hermesVariantsNow(): HermesVariantView { return cached?.view ?? OFFERED; }

/** Reads once per window and shares the answer; a failure keeps the items offered rather than hiding them. */
export function readHermesVariants(force = false): Promise<HermesVariantView> {
  if (!isTauri() && typeof window !== 'undefined' && window.location?.protocol === 'https:') return Promise.resolve(OFFERED);
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.view);
  return inFlight ??= terminalLocalRequest(HERMES_VARIANTS_PATH, {})
    .then(normalizeHermesVariantView)
    .catch(() => OFFERED)
    .then(view => {
      cached = {at: Date.now(), view};
      inFlight = null;
      for (const listener of [...listeners]) listener(view);
      return view;
    });
}

/**
 * The current view, refreshed while the caller is mounted. Never polls on its own beyond the shared window.
 * `enabled: false` (a phone over the relay or LAN) asks nothing and reports no items: that surface keeps the single
 * Hermes item, because the host-only start option cannot ride a wire request.
 */
export function useHermesVariants(refreshKey: unknown = 0, enabled = true): HermesVariantView {
  const [view, setView] = useState<HermesVariantView>(() => enabled ? hermesVariantsNow() : {items: [], sessions: [], checked: false});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const listener = (next: HermesVariantView) => { if (active) setView(next); };
    listeners.add(listener);
    void readHermesVariants().then(listener);
    return () => { active = false; listeners.delete(listener); };
  }, [refreshKey, enabled]);
  return view;
}

/** A session's variant for a label, from the shared view. */
export function hermesVariantResolver(view: HermesVariantView): (sessionId: string) => HermesVariant | null {
  const map = new Map(view.sessions.map(session => [session.sessionId, session.variant]));
  return sessionId => map.get(sessionId) ?? null;
}
