/**
 * Fail-closed projection for the optional local What-I-said feed.
 *
 * The encrypted local store keeps the user's exact text.  A feed consumer gets
 * only this derived projection: high-confidence credentials withhold the whole
 * item, while common direct identifiers and local paths are replaced.
 */

export type WhatISaidRedactionReason =
  | "high-confidence-secret"
  | "email"
  | "phone"
  | "local-path";

export interface WhatISaidRedactionResult {
  withheld: boolean;
  text: string | null;
  reasons: WhatISaidRedactionReason[];
  truncated: boolean;
}

const HIGH_CONFIDENCE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/i,
  /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{12,}={0,2}/i,
  /\b(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const NAMED_SECRET_ASSIGNMENT = /(?:^|[^\w])["']?([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)["']?\s*[:=]\s*["']?([^\s"']{12,})/gim;
const NAMED_PASSPHRASE_ASSIGNMENT = /(?:^|[^\w])["']?([A-Z0-9_]*(?:PASSWORD|PASSPHRASE|SECRET)[A-Z0-9_]*)["']?\s*[:=]\s*["']?([^\r\n]{12,})/gim;

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const WINDOWS_PATH = /(?:^|(?<=[\s'"`(=]))(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const HOME_PATH = /(?:^|(?<=[\s'"`(=]))~[\\/][^\s'"`<>|]+/g;
const POSIX_PATH = /(?:^|(?<=[\s'"`(=]))\/(?!\/)[^\s'"`<>|]+/g;
const SHORT_POSIX_PATH = /(?:^|(?<=[\s'"`(=]))\/(?:tmp|private|var|etc|opt|usr|Users|home)(?:\/[^\s'"`<>|]*)?/g;
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}_])\+?\(?\p{Nd}(?:[\p{Nd}()]|[ .-](?=[\p{Nd}(]))*\p{Nd}(?!\p{Nd})/gu;
const CALENDAR_DATE = /^\p{Nd}{4}[-./]\p{Nd}{1,2}[-./]\p{Nd}{1,2}$/u;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function redactPhones(text: string): { text: string; changed: boolean } {
  let changed = false;
  const redacted = text.replace(PHONE_CANDIDATE, candidate => {
    // A calendar date has enough digits and separators to resemble a phone but
    // is routine project-memory metadata, not a direct identifier.
    if (CALENDAR_DATE.test(candidate.trim())) return candidate;
    const digits = candidate.match(/\p{Nd}/gu)?.length ?? 0;
    // Avoid treating short numbers, years, or ordinary counters as phone data.
    if (digits < 7 || digits > 15) return candidate;
    changed = true;
    return "[phone removed]";
  });
  return { text: redacted, changed };
}

export function containsHighConfidenceWhatISaidSecret(
  text: string,
  options: { allowHeaderNameAssignments?: boolean } = {},
): boolean {
  if (HIGH_CONFIDENCE_SECRET_PATTERNS.some(pattern => pattern.test(text))) return true;
  NAMED_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(NAMED_SECRET_ASSIGNMENT)) {
    const name = (match[1] ?? '').toUpperCase();
    const value = match[2] ?? '';
    // Names such as TOKEN_HEADER describe where a token is carried; their
    // values are non-secret only when the project-memory caller explicitly
    // opts in and the value itself is an ordinary X-* header name.
    if (options.allowHeaderNameAssignments
      && name.includes('HEADER')
      && /^X-[A-Za-z0-9-]{1,100}$/.test(value)) continue;
    return true;
  }
  NAMED_PASSPHRASE_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(NAMED_PASSPHRASE_ASSIGNMENT)) {
    const value = (match[2] ?? '').trim().replace(/["'`,;]+$/g, '');
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length >= 3 && value.replace(/\s+/g, '').length >= 16) return true;
  }
  return false;
}

export function redactWhatISaidForFeed(
  text: string,
  maxBytes = 16_384,
): WhatISaidRedactionResult {
  if (containsHighConfidenceWhatISaidSecret(text)) {
    return {
      withheld: true,
      text: null,
      reasons: ["high-confidence-secret"],
      truncated: false,
    };
  }

  const reasons: WhatISaidRedactionReason[] = [];
  let projected = text;
  const replace = (pattern: RegExp, replacement: string, reason: WhatISaidRedactionReason) => {
    pattern.lastIndex = 0;
    if (!pattern.test(projected)) return;
    pattern.lastIndex = 0;
    projected = projected.replace(pattern, replacement);
    reasons.push(reason);
  };

  replace(EMAIL, "[email removed]", "email");
  replace(WINDOWS_PATH, "[path removed]", "local-path");
  replace(HOME_PATH, "[path removed]", "local-path");
  replace(POSIX_PATH, "[path removed]", "local-path");
  replace(SHORT_POSIX_PATH, "[path removed]", "local-path");
  const phone = redactPhones(projected);
  projected = phone.text;
  if (phone.changed) reasons.push("phone");

  let truncated = false;
  if (Buffer.byteLength(projected, "utf8") > maxBytes) {
    // Slice by code point and re-check bytes so a UTF-8 sequence is never split.
    const points = [...projected];
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(points.slice(0, middle).join(""), "utf8") <= maxBytes - 16) low = middle;
      else high = middle - 1;
    }
    projected = `${points.slice(0, low).join("")}\n…[truncated]`;
    truncated = true;
  }

  return {
    withheld: false,
    text: projected,
    reasons: unique(reasons),
    truncated,
  };
}
