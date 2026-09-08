import { containsHighConfidenceWhatISaidSecret } from './whatISaidRedaction';

/**
 * Safety checks for model-produced project-memory updates.
 *
 * The current memory is a baseline, not untrusted new output: older documents
 * can contain text that also appeared in a later prompt, and rejecting that
 * unchanged text would strand otherwise healthy projects. Only newly added or
 * changed lines are secret-scanned, while transcript overlap is rejected only
 * when the matching window was not already present in the baseline.
 */

export type ProjectMemoryOutputSafetyIssue =
  | { kind: 'high-confidence-secret' }
  | { kind: 'direct-identifier' }
  | { kind: 'raw-transcript-structure' }
  | { kind: 'exact-transcript-overlap'; overlapChars: number }
  | { kind: 'normalized-transcript-overlap'; overlapChars: number };

const EXACT_OVERLAP_CHARS = 240;
const NORMALIZED_OVERLAP_CHARS = 160;
const AGGREGATE_WINDOW_CHARS = 48;
const AGGREGATE_OVERLAP_CHARS = 240;
const ROLLING_HASH_BASE = 257;

function normalizedLine(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Multiset subtraction keeps only lines the candidate actually introduced. */
function newlyProducedLines(previous: string, proposed: string): string {
  const remaining = new Map<string, number>();
  for (const line of previous.split(/\r?\n/)) {
    const key = normalizedLine(line);
    if (!key) continue;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const added: string[] = [];
  for (const line of proposed.split(/\r?\n/)) {
    const key = normalizedLine(line);
    if (!key) continue;
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      if (count === 1) remaining.delete(key);
      else remaining.set(key, count - 1);
    } else {
      added.push(line);
    }
  }
  return added.join('\n');
}

function canonicalExact(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function withoutDefaultIgnorables(value: string): string {
  return value.replace(/\p{Default_Ignorable_Code_Point}+/gu, '');
}

/**
 * Ignore presentation-only differences while retaining every Unicode letter
 * and number. This catches a pasted paragraph even when Markdown, casing, or
 * whitespace was changed around it.
 */
function canonicalNormalized(value: string): string {
  return withoutDefaultIgnorables(value)
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Format controls and nonspacing/enclosing marks can be invisible while still
 * splitting an otherwise valid credential. Remove those categories before and
 * after compatibility normalization for the second secret scan. Ordinary
 * separators remain, so unrelated words cannot accidentally join into a token.
 */
function canonicalSecretScan(value: string): string {
  const invisibleMarks = /[\p{Cf}\p{Mn}\p{Me}]+/gu;
  return withoutDefaultIgnorables(value)
    .replace(invisibleMarks, '')
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, '')
    .replace(invisibleMarks, '');
}

function compactRecognizableCredentialFragments(value: string): string {
  const recognizablePrefix = /(?:sk-(?:proj-)?|sk-ant-|github_pat_|gh[pousr]_|npm_|glpat-|GOCSPX-|pypi-|SG\.|xox(?:a|b|p|r|s)-|AIza|AKIA|Bearer\s+|Authorization\s*:\s*Basic\s+)/i;
  return value.split(/\r?\n/).map(line => {
    const start = line.search(recognizablePrefix);
    if (start < 0) return line;
    return `${line.slice(0, start)}${line.slice(start).replace(/[\s,;]+/g, '')}`;
  }).join('\n');
}

const INTERNATIONAL_EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)(?![\p{L}\p{N}._%+-])/gu;
const DIRECT_PHONE_CANDIDATE = /(?<![\p{L}\p{N}_])\+?\(?\p{Nd}(?:[\p{Nd}()]|[ .-](?=[\p{Nd}(]))*\p{Nd}(?!\p{Nd})/gu;
const DIRECT_IDENTIFIER_DATE = /^\p{Nd}{4}[-./]\p{Nd}{1,2}[-./]\p{Nd}{1,2}$/u;

function isReservedDocumentationDomain(domain: string): boolean {
  const normalized = domain.normalize('NFKC').toLowerCase();
  return normalized === 'example.com'
    || normalized === 'example.net'
    || normalized === 'example.org'
    || normalized.endsWith('.example')
    || normalized.endsWith('.invalid')
    || normalized.endsWith('.test');
}

function containsDirectIdentifier(value: string): boolean {
  for (const match of value.matchAll(INTERNATIONAL_EMAIL)) {
    const domain = match[1] ?? '';
    const topLevelLabel = domain.split('.').at(-1) ?? '';
    // Numeric dotted package versions such as react@19.1.0 are not email
    // domains. Internationalized TLDs remain covered because they are letters.
    if (!/\p{L}/u.test(topLevelLabel)) continue;
    if (!isReservedDocumentationDomain(domain)) return true;
  }
  for (const match of value.matchAll(DIRECT_PHONE_CANDIDATE)) {
    const candidate = match[0].trim();
    if (DIRECT_IDENTIFIER_DATE.test(candidate)) continue;
    const groups = candidate.match(/\p{Nd}+/gu)?.map(group => [...group].length) ?? [];
    // Bare digit runs are commonly build IDs and counters. The locally common
    // separator-free Korean mobile shape is specific enough to retain.
    if (!/[+().\s-]/u.test(candidate)) {
      if (/^01[016789][0-9]{7,8}$/.test(candidate)) return true;
      continue;
    }
    const digits = candidate.match(/\p{Nd}/gu)?.length ?? 0;
    if (digits < 7 || digits > 15) continue;
    if (candidate.startsWith('+') || candidate.includes('(') || candidate.includes(')')) return true;
    const groupedLocalPhone = groups.length === 3
      && groups[0]! >= 2 && groups[0]! <= 3
      && groups[1]! >= 3 && groups[1]! <= 4
      && groups[2] === 4;
    const groupedInternationalPhone = groups.length === 4
      && groups[0]! >= 1 && groups[0]! <= 3
      && groups[1]! >= 1 && groups[1]! <= 3
      && groups[2]! >= 3 && groups[2]! <= 4
      && groups[3] === 4;
    if (groupedLocalPhone || groupedInternationalPhone) return true;
  }
  return false;
}

function canonicalTranscriptStructure(value: string): string {
  return withoutDefaultIgnorables(value)
    .normalize('NFKC')
    .replace(/[*_`~]+/g, '');
}

function rollingPower(length: number): number {
  let power = 1;
  for (let index = 1; index < length; index += 1) {
    power = Math.imul(power, ROLLING_HASH_BASE) >>> 0;
  }
  return power;
}

function firstWindowHash(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < length; index += 1) {
    hash = (Math.imul(hash, ROLLING_HASH_BASE) + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function nextWindowHash(
  hash: number,
  outgoing: number,
  incoming: number,
  power: number,
): number {
  const removed = (hash - Math.imul(outgoing, power)) >>> 0;
  return (Math.imul(removed, ROLLING_HASH_BASE) + incoming) >>> 0;
}

/**
 * Finds a fixed-size common window in linear time. Hash matches are always
 * verified against the source text, so a collision can neither reject safe
 * output nor authorize copied transcript text.
 */
function containsNewSharedWindow(
  source: string,
  proposed: string,
  previous: string,
  windowLength: number,
): boolean {
  if (source.length < windowLength || proposed.length < windowLength) return false;

  const power = rollingPower(windowLength);
  const sourceWindows = new Map<number, number[]>();
  let sourceHash = firstWindowHash(source, windowLength);
  sourceWindows.set(sourceHash, [0]);
  for (let index = 1; index <= source.length - windowLength; index += 1) {
    sourceHash = nextWindowHash(
      sourceHash,
      source.charCodeAt(index - 1),
      source.charCodeAt(index + windowLength - 1),
      power,
    );
    const positions = sourceWindows.get(sourceHash);
    if (positions) positions.push(index);
    else sourceWindows.set(sourceHash, [index]);
  }

  let proposedHash = firstWindowHash(proposed, windowLength);
  for (let index = 0; index <= proposed.length - windowLength; index += 1) {
    if (index > 0) {
      proposedHash = nextWindowHash(
        proposedHash,
        proposed.charCodeAt(index - 1),
        proposed.charCodeAt(index + windowLength - 1),
        power,
      );
    }
    const positions = sourceWindows.get(proposedHash);
    if (!positions) continue;
    const window = proposed.slice(index, index + windowLength);
    if (!positions.some(position => source.slice(position, position + windowLength) === window)) continue;
    if (!previous.includes(window)) return true;
  }
  return false;
}

/** Detects many copied chunks even when one inserted character breaks every
 * larger continuous window. Count only non-overlapping candidate windows, and
 * never count text that was already present in the baseline memory. */
function containsAggregateNewSharedWindows(
  source: string,
  proposed: string,
  previous: string,
  windowLength: number,
  requiredCoverage: number,
): boolean {
  if (source.length < windowLength || proposed.length < windowLength) return false;

  const power = rollingPower(windowLength);
  const sourceWindows = new Map<number, number[]>();
  let sourceHash = firstWindowHash(source, windowLength);
  sourceWindows.set(sourceHash, [0]);
  for (let index = 1; index <= source.length - windowLength; index += 1) {
    sourceHash = nextWindowHash(
      sourceHash,
      source.charCodeAt(index - 1),
      source.charCodeAt(index + windowLength - 1),
      power,
    );
    const positions = sourceWindows.get(sourceHash);
    if (positions) positions.push(index);
    else sourceWindows.set(sourceHash, [index]);
  }

  const baselinePresence = new Map<string, boolean>();
  let coveredUntil = 0;
  let coverage = 0;
  let proposedHash = firstWindowHash(proposed, windowLength);
  for (let index = 0; index <= proposed.length - windowLength; index += 1) {
    if (index > 0) {
      proposedHash = nextWindowHash(
        proposedHash,
        proposed.charCodeAt(index - 1),
        proposed.charCodeAt(index + windowLength - 1),
        power,
      );
    }
    if (index < coveredUntil) continue;
    const positions = sourceWindows.get(proposedHash);
    if (!positions) continue;
    const window = proposed.slice(index, index + windowLength);
    if (!positions.some(position => source.slice(position, position + windowLength) === window)) continue;
    let existed = baselinePresence.get(window);
    if (existed === undefined) {
      existed = previous.includes(window);
      baselinePresence.set(window, existed);
    }
    if (existed) continue;
    coverage += windowLength;
    coveredUntil = index + windowLength;
    if (coverage >= requiredCoverage) return true;
  }
  return false;
}

function containsRawTranscriptStructure(value: string): boolean {
  const jsonRoles = value.match(/"role"\s*:\s*"(?:user|assistant|system)"/gi) ?? [];
  if (/"messages"\s*:\s*\[/i.test(value)
    && jsonRoles.length >= 4
    && /"role"\s*:\s*"user"/i.test(value)
    && /"role"\s*:\s*"assistant"/i.test(value)) {
    return true;
  }
  const rolePrefix = String.raw`^\s*(?:[-*+>]\s*)?`;
  const colonRole = String.raw`(?:user|assistant|system|사용자|에이전트|시스템)\s*:`;
  const colonRoles = value.match(new RegExp(`${rolePrefix}${colonRole}`, 'gim')) ?? [];
  if (colonRoles.length >= 4
    && new RegExp(`${rolePrefix}(?:user|사용자)\\s*:`, 'im').test(value)
    && new RegExp(`${rolePrefix}(?:assistant|에이전트)\\s*:`, 'im').test(value)) {
    return true;
  }
  const renderedRoles = value.match(/^\s*(?:[-*+>]\s*)?\[(?:사용자|에이전트)(?:\s+[^\]]+)?\]\s*$/gm) ?? [];
  return renderedRoles.length >= 4
    && /^\s*(?:[-*+>]\s*)?\[사용자(?:\s+[^\]]+)?\]\s*$/m.test(value)
    && /^\s*(?:[-*+>]\s*)?\[에이전트(?:\s+[^\]]+)?\]\s*$/m.test(value);
}

export function inspectProjectMemoryOutputSafety(input: {
  previousMemory: string;
  proposedMemory: string;
  sessionNarrative?: string | null;
  transcriptContext?: string | null;
}): ProjectMemoryOutputSafetyIssue | null {
  const narrative = input.sessionNarrative?.trim() ?? '';
  const newlyProduced = [newlyProducedLines(input.previousMemory, input.proposedMemory), narrative]
    .filter(Boolean)
    .join('\n');

  const securityNormalized = canonicalSecretScan(newlyProduced);
  const compactedCredentialFragments = compactRecognizableCredentialFragments(securityNormalized);
  const projectMemorySecretOptions = { allowHeaderNameAssignments: true } as const;
  if (containsHighConfidenceWhatISaidSecret(newlyProduced, projectMemorySecretOptions)
    || containsHighConfidenceWhatISaidSecret(securityNormalized, projectMemorySecretOptions)
    || containsHighConfidenceWhatISaidSecret(compactedCredentialFragments, projectMemorySecretOptions)) {
    return { kind: 'high-confidence-secret' };
  }
  if (containsDirectIdentifier(newlyProduced) || containsDirectIdentifier(securityNormalized)) {
    return { kind: 'direct-identifier' };
  }
  if (containsRawTranscriptStructure(newlyProduced)
    || containsRawTranscriptStructure(canonicalTranscriptStructure(newlyProduced))) {
    return { kind: 'raw-transcript-structure' };
  }

  const transcript = input.transcriptContext?.trim() ?? '';
  if (!transcript) return null;
  const proposedWithNarrative = narrative
    ? `${input.proposedMemory}\n${narrative}`
    : input.proposedMemory;

  const exactTranscript = canonicalExact(transcript);
  const exactProposed = canonicalExact(proposedWithNarrative);
  const exactPrevious = canonicalExact(input.previousMemory);
  if (containsNewSharedWindow(
    exactTranscript,
    exactProposed,
    exactPrevious,
    EXACT_OVERLAP_CHARS,
  )) {
    return { kind: 'exact-transcript-overlap', overlapChars: EXACT_OVERLAP_CHARS };
  }

  const normalizedTranscript = canonicalNormalized(transcript);
  const normalizedProposed = canonicalNormalized(proposedWithNarrative);
  const normalizedPrevious = canonicalNormalized(input.previousMemory);
  if (containsNewSharedWindow(
    normalizedTranscript,
    normalizedProposed,
    normalizedPrevious,
    NORMALIZED_OVERLAP_CHARS,
  )) {
    return { kind: 'normalized-transcript-overlap', overlapChars: NORMALIZED_OVERLAP_CHARS };
  }
  if (containsAggregateNewSharedWindows(
    normalizedTranscript,
    normalizedProposed,
    normalizedPrevious,
    AGGREGATE_WINDOW_CHARS,
    AGGREGATE_OVERLAP_CHARS,
  )) {
    return { kind: 'normalized-transcript-overlap', overlapChars: AGGREGATE_OVERLAP_CHARS };
  }
  return null;
}
