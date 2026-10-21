import type { WhatISaidRetention } from './whatISaidStore';
import type { WhatISaidPromptOrigin } from './whatISaidStore';

export interface WhatISaidSharedCapturePolicy {
  memoryId: string;
  configured: boolean;
  enabled: boolean;
  retentionDays: WhatISaidRetention;
  analysisAllowed: boolean;
  enabledAt: string | null;
  updatedAt: string | null;
}

export interface WhatISaidRemotePromptRow {
  id: string;
  memory_id: string;
  project_name: string | null;
  device_id: string;
  device_name: string | null;
  feed_seq: string;
  agent: 'claude' | 'codex';
  prompt_origin: WhatISaidPromptOrigin;
  recorded_at: string;
  body: string | null;
  redaction_state: 'clean' | 'redacted' | 'withheld';
}

const RETENTIONS = new Set<WhatISaidRetention>([30, 90, 365, 'forever']);

export const WHAT_I_SAID_SHARED_POLICY_RETRY_BASE_MS = 5_000;
export const WHAT_I_SAID_SHARED_POLICY_RETRY_MAX_MS = 60_000;

/** A transient offline/startup failure must not strand a device-local opt-in. */
export function whatISaidSharedPolicyRetryDelay(attempt: number): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(
    WHAT_I_SAID_SHARED_POLICY_RETRY_MAX_MS,
    WHAT_I_SAID_SHARED_POLICY_RETRY_BASE_MS * (2 ** Math.min(safeAttempt - 1, 20)),
  );
}

export function normalizeWhatISaidMemoryIds(value: unknown, limit = 2_048): string[] {
  if (!Array.isArray(value) || value.length > limit) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') return [];
    const id = candidate.trim();
    if (!id || id.length > 512) return [];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function normalizeWhatISaidSharedCapturePolicy(
  value: unknown,
): WhatISaidSharedCapturePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const memoryId = typeof row.memory_id === 'string' ? row.memory_id.trim() : '';
  if (!memoryId || memoryId.length > 512) return null;
  const retentionValue = row.retention_days === 'forever'
    ? 'forever'
    : typeof row.retention_days === 'number'
      ? row.retention_days
      : typeof row.retention_days === 'string' && /^\d+$/.test(row.retention_days)
        ? Number(row.retention_days)
        : null;
  const retentionDays = RETENTIONS.has(retentionValue as WhatISaidRetention)
    ? retentionValue as WhatISaidRetention
    : 90;
  const enabledAt = typeof row.capture_enabled_at === 'string'
    && Number.isFinite(Date.parse(row.capture_enabled_at))
    ? row.capture_enabled_at
    : null;
  const updatedAt = typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at))
    ? row.updated_at
    : null;
  return {
    memoryId,
    configured: row.capture_configured === true,
    enabled: row.capture_enabled === true,
    retentionDays,
    analysisAllowed: row.analysis_allowed === true,
    enabledAt,
    updatedAt,
  };
}

export function normalizeWhatISaidSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function whatISaidTextMatches(text: string, query: string): boolean {
  const normalizedQuery = normalizeWhatISaidSearchText(query.trim());
  return !normalizedQuery || normalizeWhatISaidSearchText(text).includes(normalizedQuery);
}

export function normalizeWhatISaidRemotePromptRow(value: unknown): WhatISaidRemotePromptRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const feedSeq = typeof row.feed_seq === 'string'
    ? row.feed_seq
    : typeof row.feed_seq === 'number' && Number.isSafeInteger(row.feed_seq) && row.feed_seq >= 0
      ? String(row.feed_seq)
      : '';
  if (typeof row.id !== 'string' || !row.id
    || typeof row.memory_id !== 'string' || !row.memory_id
    || typeof row.device_id !== 'string' || !row.device_id
    || !/^(?:0|[1-9][0-9]*)$/.test(feedSeq)
    || (row.agent !== 'claude' && row.agent !== 'codex')
    || typeof row.recorded_at !== 'string' || !Number.isFinite(Date.parse(row.recorded_at))
    || (row.redaction_state !== 'clean' && row.redaction_state !== 'redacted' && row.redaction_state !== 'withheld')) {
    return null;
  }
  if (row.redaction_state !== 'withheld' && typeof row.body !== 'string') return null;
  if (row.redaction_state === 'withheld' && row.body !== null) return null;
  return {
    id: row.id,
    memory_id: row.memory_id,
    project_name: typeof row.project_name === 'string' && row.project_name.trim() ? row.project_name.trim() : null,
    device_id: row.device_id,
    device_name: typeof row.device_name === 'string' && row.device_name.trim() ? row.device_name.trim() : null,
    feed_seq: feedSeq,
    agent: row.agent,
    prompt_origin: row.prompt_origin === 'human' || row.prompt_origin === 'agentstoz'
      ? row.prompt_origin
      : 'unknown',
    recorded_at: row.recorded_at,
    body: row.body as string | null,
    redaction_state: row.redaction_state,
  };
}
