import { createHash } from 'node:crypto';
import { codexTranscriptMessage } from './sessionTranscript';

/** Delivery evidence is not an assertion that a person used a physical keyboard. */
export type WhatISaidPromptDelivery = 'user-message' | 'automated' | 'unknown';
export const CODEX_DELIVERY_LOOKBACK_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

interface DeliveryEvidence {
  turnId: string;
  at: number;
  fingerprint: string;
  delivery: Exclude<WhatISaidPromptDelivery, 'unknown'>;
}

function deliveryEvidence(value: unknown): DeliveryEvidence | null {
  const row = record(value);
  const payload = record(row?.payload);
  if (row?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') return null;
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  const retained = record(record(record(row.metadata)?.retained_source)?.id);
  const kinds = metadata?.content_item_kinds;
  if (!identity(payload.id) || !identity(metadata?.turn_id) || retained?.message_id !== payload.id
    || retained.turn_id !== metadata.turn_id || retained.role !== 'user' || !Array.isArray(kinds) || kinds.length !== 1) return null;
  const delivery = kinds[0] === 'user.heartbeat' ? 'automated' : kinds[0] === 'user.text' ? 'user-message' : null;
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (!delivery || !Number.isFinite(at) || !Array.isArray(payload.content)) return null;
  const text = payload.content.filter(block => {
    const item = record(block);
    return item && (item.type === 'input_text' || item.type === 'text') && typeof item.text === 'string';
  }).map(block => (block as JsonRecord).text as string).join('\n').trim();
  return text ? { turnId: metadata.turn_id, at, fingerprint: fingerprint(text), delivery } : null;
}

/**
 * Pair one producer envelope with the immediately following completed message.
 * Turn, complete text and time must all match. Never infer delivery from XML,
 * client_authored, retained_source.complete, or an unrelated response_item.
 * Only a bounded content hash and IDs are retained, only for this file scan.
 */
export class WhatISaidCodexDeliveryTracker {
  #previous: DeliveryEvidence | null = null;

  read(value: unknown): WhatISaidPromptDelivery {
    const previous = this.#previous;
    this.#previous = deliveryEvidence(value);
    const row = record(value);
    const payload = record(row?.payload);
    const message = codexTranscriptMessage(value);
    if (!previous || row?.type !== 'event_msg' || payload?.type !== 'item_completed'
      || message?.role !== 'user' || payload.turn_id !== previous.turnId) return 'unknown';
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(at) || at < previous.at || at - previous.at > 10_000
      || fingerprint(message.text) !== previous.fingerprint) return 'unknown';
    return previous.delivery;
  }
}

/** A truncated last record provides no evidence; it is never parsed as a prefix. */
export function previousCodexDeliveryRecord(bytes: Buffer, startsAtFileBeginning: boolean): unknown {
  if (!bytes.length || bytes.at(-1) !== 0x0a) return null;
  const end = bytes.length - 1;
  const start = bytes.lastIndexOf(0x0a, end - 1) + 1;
  if (start === 0 && !startsAtFileBeginning) return null;
  try { return JSON.parse(bytes.subarray(start, end).toString('utf8')); } catch { return null; }
}
