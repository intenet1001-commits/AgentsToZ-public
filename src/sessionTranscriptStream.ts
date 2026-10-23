import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  extractCodexExcerpts,
  extractOwnedClaudeSessionExcerpts,
  renderSessionContext,
  type SessionExcerpt,
} from './sessionTranscript';

export const SESSION_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
export const SESSION_TRANSCRIPT_MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** Snapshot one regular JSONL file without materializing the whole transcript.
 * Oversized records are drained up to their newline, so later valid messages
 * remain readable. Decode only complete records, including an EOF record.
 */
export function visitBoundedSessionJsonl(
  path: string,
  onLine: (line: string) => void,
  onUnreadable: () => void,
  options: { chunkBytes?: number; maxRecordBytes?: number } = {},
): void {
  const chunkBytes = options.chunkBytes ?? SESSION_TRANSCRIPT_CHUNK_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? SESSION_TRANSCRIPT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > SESSION_TRANSCRIPT_CHUNK_BYTES
    || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1
    || maxRecordBytes > SESSION_TRANSCRIPT_MAX_RECORD_BYTES) throw new Error('Invalid transcript read budget');
  const fd = openSync(path, 'r');
  try {
    const snapshot = fstatSync(fd);
    if (!snapshot.isFile()) throw new Error('Transcript must be a regular file');
    const chunk = Buffer.allocUnsafe(chunkBytes);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let parts: Buffer[] = [];
    let length = 0;
    let oversized = false;
    const append = (bytes: Buffer) => {
      if (oversized) return;
      if (length + bytes.length > maxRecordBytes) {
        parts = []; length = 0; oversized = true;
        return;
      }
      if (bytes.length) { parts.push(Buffer.from(bytes)); length += bytes.length; }
    };
    const finish = () => {
      if (oversized) onUnreadable();
      else if (length) {
        const bytes = Buffer.concat(parts, length);
        let line: string | null = null;
        try { line = decoder.decode(bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes); }
        catch { onUnreadable(); }
        if (line !== null) onLine(line);
      }
      parts = []; length = 0; oversized = false;
    };
    let position = 0;
    while (position < snapshot.size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, snapshot.size - position), position);
      if (!read) { onUnreadable(); break; }
      position += read;
      let start = 0;
      while (start < read) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0 || newline >= read) { append(chunk.subarray(start, read)); break; }
        append(chunk.subarray(start, newline)); finish(); start = newline + 1;
      }
    }
    if (length || oversized) finish();
  } finally {
    closeSync(fd);
  }
}

type ContextBlock = { recordedAt: string; order: number; block: string; bytes: number };
const compare = (left: Pick<ContextBlock, 'recordedAt' | 'order'>, right: Pick<ContextBlock, 'recordedAt' | 'order'>) =>
  left.recordedAt.localeCompare(right.recordedAt) || left.order - right.order;
const ownString = (value: string): string => Buffer.from(value, 'utf16le').toString('utf16le');

/** The same newest chronological suffix as renderSessionContext, kept online.
 * Remember the newest rejected boundary too: an older short message must not
 * sneak past a larger intervening message that made the old renderer stop.
 */
export class BoundedSessionContext {
  readonly #blocks: ContextBlock[] = [];
  #bytes = 0;
  #count = 0;
  #cutoff: Pick<ContextBlock, 'recordedAt' | 'order'> | null = null;

  constructor(readonly budgetBytes: number) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw new Error('Invalid session context budget');
  }

  add(excerpt: SessionExcerpt): void {
    const key = { recordedAt: excerpt.recordedAt, order: this.#count++ };
    if (this.#cutoff && compare(key, this.#cutoff) <= 0) return;
    const block = renderSessionContext([excerpt], Number.MAX_SAFE_INTEGER);
    const value = { ...key, block, bytes: Buffer.byteLength(block, 'utf8') + 2 };
    let low = 0; let high = this.#blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(this.#blocks[middle]!, value) <= 0) low = middle + 1;
      else high = middle;
    }
    // Copy only the bounded rendered block; a sliced 4,000-character excerpt
    // must not retain the original multi-megabyte JSON string via a rope/view.
    value.block = ownString(block);
    value.recordedAt = ownString(value.recordedAt);
    this.#blocks.splice(low, 0, value);
    this.#bytes += value.bytes;
    while (this.#bytes > this.budgetBytes) {
      const dropped = this.#blocks.shift()!;
      this.#bytes -= dropped.bytes;
      this.#cutoff = { recordedAt: dropped.recordedAt, order: dropped.order };
    }
  }

  get excerpts(): number { return this.#count; }
  get retainedBytes(): number { return this.#bytes; }
  render(): string { return this.#blocks.map(item => item.block).join('\n\n'); }
}

export function collectSessionTranscriptFile(input: {
  path: string;
  agent: 'claude' | 'codex';
  sinceIso: string | null;
  exactRoots: readonly string[];
  context: BoundedSessionContext;
}): { unreadable: number; ownershipRejected: number } {
  const result = { unreadable: 0, ownershipRejected: 0 };
  visitBoundedSessionJsonl(input.path, line => {
    if (input.agent === 'claude') {
      const owned = extractOwnedClaudeSessionExcerpts([line], input.sinceIso, input.exactRoots);
      result.unreadable += owned.unreadable;
      result.ownershipRejected += owned.ownershipRejected;
      for (const excerpt of owned.excerpts) input.context.add(excerpt);
    } else {
      if (!line.trim()) return;
      try { JSON.parse(line); }
      catch { result.unreadable += 1; return; }
      for (const excerpt of extractCodexExcerpts([line], input.sinceIso)) input.context.add(excerpt);
    }
  }, () => { result.unreadable += 1; });
  return result;
}
