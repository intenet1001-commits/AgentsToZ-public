import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canRegisterWhatISaidPromptOrigin } from './whatISaidPromptOriginPolicy';

export type WhatISaidPromptOrigin = 'human' | 'agentstoz' | 'unknown';

interface PromptOriginEvidence {
  fingerprint: string;
  registeredAt: string;
}

interface PromptOriginRegistryFile {
  schemaVersion: 1;
  evidenceAvailableSince: string;
  prompts: PromptOriginEvidence[];
}

const MAX_EVIDENCE = 10_000;
const EVIDENCE_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const COPY_TO_SUBMIT_WINDOW_MS = 60 * 60 * 1_000;
const SHA256 = /^[0-9a-f]{64}$/;

/** Transcript extractors trim user messages, so clipboard evidence must match that exact projection. */
export function whatISaidPromptFingerprint(text: string): string {
  return createHash('sha256')
    .update('agentstoz-what-i-said-prompt-origin-v1\0', 'utf8')
    .update(text.trim(), 'utf8')
    .digest('hex');
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Durable, content-free evidence that a prompt was copied by AgentsToZ.
 *
 * The registry stores only domain-separated SHA-256 fingerprints. A missing or
 * corrupt registry never turns historical prompts into "human": without an
 * evidence-era boundary their origin remains unknown.
 */
export class WhatISaidPromptOriginRegistry {
  readonly filePath: string;
  #loaded = false;
  #ready = true;
  #evidenceAvailableSince: string | null = null;
  #prompts: PromptOriginEvidence[] = [];

  constructor(readonly appDataDir: string) {
    this.filePath = join(appDataDir, 'what-i-said-prompt-origins.json');
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PromptOriginRegistryFile>;
      if (parsed.schemaVersion !== 1 || !validIso(parsed.evidenceAvailableSince) || !Array.isArray(parsed.prompts)) {
        this.#ready = false;
        return;
      }
      const cutoff = Date.now() - EVIDENCE_TTL_MS;
      for (const candidate of parsed.prompts) {
        if (!candidate || typeof candidate !== 'object') continue;
        const row = candidate as Partial<PromptOriginEvidence>;
        if (!SHA256.test(row.fingerprint ?? '') || !validIso(row.registeredAt)) continue;
        if (Date.parse(row.registeredAt) < cutoff) continue;
        this.#prompts.push({ fingerprint: row.fingerprint!, registeredAt: row.registeredAt });
      }
      this.#evidenceAvailableSince = parsed.evidenceAvailableSince;
    } catch {
      this.#ready = false;
    }
  }

  #write(): void {
    mkdirSync(this.appDataDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const rows = this.#prompts
      .filter(({ registeredAt }) => now - Date.parse(registeredAt) <= EVIDENCE_TTL_MS)
      .sort((left, right) => Date.parse(right.registeredAt) - Date.parse(left.registeredAt))
      .slice(0, MAX_EVIDENCE);
    this.#prompts = rows;
    const value: PromptOriginRegistryFile = {
      schemaVersion: 1,
      evidenceAvailableSince: this.#evidenceAvailableSince!,
      prompts: rows,
    };
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filePath);
    if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
  }

  register(prompt: unknown, now = new Date().toISOString()): { fingerprint: string; registeredAt: string } {
    if (!canRegisterWhatISaidPromptOrigin(prompt) || !validIso(now)) throw new Error('WHAT_I_SAID_PROMPT_ORIGIN_INPUT_INVALID');
    this.#load();
    if (!this.#ready) throw new Error('WHAT_I_SAID_PROMPT_ORIGIN_STORE_UNAVAILABLE');
    if (this.#evidenceAvailableSince === null) this.#evidenceAvailableSince = now;
    const fingerprint = whatISaidPromptFingerprint(prompt);
    // Keep every copy event. Static commands are copied repeatedly, and keeping
    // only the latest timestamp would erase the evidence for earlier submits.
    this.#prompts.push({ fingerprint, registeredAt: now });
    this.#write();
    return { fingerprint, registeredAt: now };
  }

  classify(prompt: string, recordedAt: string): WhatISaidPromptOrigin {
    this.#load();
    if (!this.#ready || !this.#evidenceAvailableSince || !validIso(recordedAt)) return 'unknown';
    const recordedMs = Date.parse(recordedAt);
    const fingerprint = whatISaidPromptFingerprint(prompt);
    const matchingCopies = this.#prompts.filter(item => item.fingerprint === fingerprint);
    if (matchingCopies.some(item => {
      const copiedMs = Date.parse(item.registeredAt);
      return recordedMs >= copiedMs - CLOCK_TOLERANCE_MS
        && recordedMs <= copiedMs + COPY_TO_SUBMIT_WINDOW_MS;
    })) return 'agentstoz';
    // The same text was copied by the app, but not near this submit. We cannot
    // honestly decide whether it was pasted much later or typed independently.
    if (matchingCopies.length > 0) return 'unknown';
    return recordedMs >= Date.parse(this.#evidenceAvailableSince) - CLOCK_TOLERANCE_MS
      ? 'human'
      : 'unknown';
  }
}
