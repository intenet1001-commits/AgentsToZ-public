import { containsHighConfidenceWhatISaidSecret } from './whatISaidRedaction';

export interface PromptGuideEntry {
  id: string;
  memoryId?: string | null;
  text: string;
  promptOrigin: 'human' | 'agentstoz' | 'unknown';
  recordedAt?: string;
}
export interface PromptGuideSuggestion {
  id: string;
  title: string;
  body: string;
  count: number;
  kind: 'repeat' | 'pattern';
}
export type PromptGuideExclusion = 'entry-limit' | 'invalid-entry' | 'not-human' | 'duplicate-identity'
  | 'empty' | 'too-long' | 'text-budget' | 'sensitive' | 'quoted-or-code' | 'app-boilerplate' | 'short';
export interface PromptGuideAnalysis {
  candidates: PromptGuideSuggestion[];
  recent?: PromptGuideRecent[];
  stats: {
    receivedEntries: number;
    inspectedEntries: number;
    sampledEntries: number;
    excludedEntries: number;
    excludedByReason: Record<PromptGuideExclusion, number>;
    analyzedTextBytes: number;
    candidateTextBytes: number;
    candidatesFound: number;
    candidatesOmitted: number;
  };
}
export interface PromptGuideRecent {
  id: string; title: string; body: string; recordedAt: string; generalized: boolean;
}
export interface PromptGuideAnalysisOptions { includeShortRepeats?: boolean; includeRecent?: boolean }
export const PROMPT_GUIDE_LIMITS = Object.freeze({
  entries: 500, entryBytes: 2_048, inputTextBytes: 128 * 1_024,
  candidates: 20, outputTextBytes: 16 * 1_024, lines: 8, recentEntries: 10, recentTextBytes: 8 * 1_024,
});
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

// Whole entries are withheld, rather than exposing surrounding prose after a
// credential is removed. This deliberately errs toward excluding safe prose
// that discusses credentials as well as entries containing actual values.
const SENSITIVE_LABEL = /\b(?:password|passwd|passphrase|secret|token|authorization|credential|api[ _-]?key|access[ _-]?key|private[ _-]?key|otp|pin)\b|비밀번호|패스워드|비번|토큰|시크릿|인증번호|인증코드|접근[ _-]?키|비밀[ _-]?키|암호|주민등록|계좌번호|전화번호|휴대폰|핸드폰|연락처|로컬프로젝트해시/iu;
const SECRET_ASSIGNMENT = /\b[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*["']?\s*[:=]/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?<![\p{L}\p{N}_])\+?\(?\p{Nd}(?:[\p{Nd}()]|[ .-](?=[\p{Nd}(]))*\p{Nd}(?!\p{Nd})/gu;
const OPAQUE_VALUE = /(?<![\p{L}\p{N}])[A-Za-z0-9_+/=-]{24,}(?![\p{L}\p{N}])/gu;
const URL_TOKEN = /https?:\/\/[^\s<>"'`]+/giu;
const PATH_TOKEN = /(?:^|(?<=[\s"'`(=:]))(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.\.?[\\/]|\/(?!\/))[^\s<>"'`|]+/gu;
const RELATIVE_PATH = /(?<![\p{L}\p{N}_])(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+/gu;
const NUMBER_TOKEN = /(?<![A-Za-z0-9_])[-+]?\d+(?:[.,]\d+)*(?![A-Za-z0-9_])/gu;
const APP_BOILERPLATE = /English translation:|AgentsToZ shared-output-style|AGENTS\.md instructions for|<\/?(?:environment_context|system-reminder|app-context|user_query|INSTRUCTIONS)>|^\s*(?:This task is\b|You are (?:Codex|an AI)\b|You have been assigned\b|The user requested\b)/im;
// Known CLI envelopes, matching the host wrappers in sessionTranscript.ts and
// the local-command-caveat observed in collected history. Keep ordinary XML and
// prose about commands; never extract a supposed human request from an envelope.
const CLI_HOST_ENVELOPE = /<\/?(?:local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args)|tool_result|task-notification|send_user_message_question_reply|system-reminder|subagent_notification)(?:\s[^<>]*)?\/?>|^\[Request interrupted(?: by user(?: for tool use)?)?\]/i;
const RAW_CONTENT = /```|~~~|(?:^|\n)\s*>|(?:^|\n)\s*(?:user|assistant|system|developer|human|사용자|어시스턴트|시스템)\s*[:：]|(?:^|\n)\s*(?:import\s.+\sfrom\s|export\s+(?:default|const|function|class)\b|(?:const|let|var)\s+\w+\s*=|function\s+\w+\s*\(|def\s+\w+\s*\(|class\s+\w+\s*[:{]|[$%]\s+(?:git|bun|npm|python|curl)\b)/im;
const PROJECT_PREFIX = [
  /^#([^\n[\]]{1,120})\n로컬프로젝트해시:[ \t]*([A-Fa-f0-9]{8}|\d{13})[ \t]*(?:\n|$)/u,
  /^#([^\n[\]]{1,120})[ \t]+\[로컬프로젝트해시:[ \t]*([A-Fa-f0-9]{8}|\d{13})\][ \t]*(?:\n|$)/u,
];
const PROJECT_TEMPLATE_HEADER = '#{프로젝트} [로컬프로젝트해시:{프로젝트해시}]\n';

function projectInstruction(text: string): { instruction: string; hasProject: boolean; unsafeName: boolean } {
  // Only the app's exact leading identity structure is exempt from the long
  // number filter. Never remove arbitrary hashes or numbers from the task.
  for (const pattern of PROJECT_PREFIX) {
    const match = text.match(pattern);
    if (match && match[1]!.trim()) return {
      instruction: text.slice(match[0].length).trim(), hasProject: true, unsafeName: sensitive(match[1]!),
    };
  }
  return { instruction: text, hasProject: false, unsafeName: false };
}

function sensitive(text: string): boolean {
  if (/\p{Cf}/u.test(text)) return true;
  const scan = text.normalize('NFKC');
  if (containsHighConfidenceWhatISaidSecret(scan) || SENSITIVE_LABEL.test(scan) || SECRET_ASSIGNMENT.test(scan)
    || EMAIL.test(scan) || /\S+[@＠]\S+|\d{7,}/u.test(scan)) return true;
  for (const match of text.matchAll(PHONE)) {
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(match[0])) continue;
    const digits = match[0].match(/\p{Nd}/gu)?.length ?? 0;
    if (digits >= 7) return true;
  }
  for (const match of text.matchAll(OPAQUE_VALUE)) {
    // Long identifiers combining letters and digits are not useful examples
    // to echo in a guide, regardless of whether their provider is recognised.
    if (match[0].length >= 32 || (/[A-Za-z]/.test(match[0]) && /\d/.test(match[0]))) return true;
  }
  for (const match of text.matchAll(URL_TOKEN)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|auth|key|signature|credential|code/i.test(key))) return true;
    } catch { return true; }
  }
  return false;
}

function template(text: string, hasProject: boolean): { body: string; key: string; variables: number; privateLocation: boolean; anchor: number } {
  let variables = hasProject ? 2 : 0;
  let privateLocation = hasProject;
  // These sentinels cannot collide with accepted input, which rejects control
  // characters. Preserve punctuation outside the detected variable token.
  const replace = (value: string, kind: string) => {
    const tail = value.match(/[),;.!?]+$/u)?.[0] ?? '';
    variables += 1;
    return `\u0001${kind}\u0002${tail}`;
  };
  let key = text.replace(URL_TOKEN, value => { privateLocation = true; return replace(value, 'URL'); });
  key = key.replace(PATH_TOKEN, value => { privateLocation = true; return replace(value, '경로'); });
  key = key.replace(RELATIVE_PATH, value => { privateLocation = true; return replace(value, '경로'); });
  key = key.replace(NUMBER_TOKEN, value => { variables += 1; return '\u0001숫자\u0002'; });
  const anchor = (key.replace(/\u0001[^\u0002]+\u0002/g, '').match(/\p{L}/gu) ?? []).length;
  // The app's header is not evidence of an actual user instruction. Calculate
  // the literal anchor above before adding the canonical project placeholders.
  if (hasProject) key = `#\u0001프로젝트\u0002 [로컬프로젝트해시:\u0001프로젝트해시\u0002]\n${key}`;
  return { key, body: key.replace(/\u0001([^\u0002]+)\u0002/g, '{$1}'), variables, privateLocation, anchor };
}

function suggestionId(kind: PromptGuideSuggestion['kind'], body: string): string {
  // Stable display identity only, not an authorization or secret hash.
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(`${kind}\0${body}`)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `prompt-guide-${kind}-${hash.toString(16).padStart(16, '0')}`;
}
function suggestion(kind: PromptGuideSuggestion['kind'], body: string, count: number): PromptGuideSuggestion {
  const firstLine = (body.startsWith(PROJECT_TEMPLATE_HEADER) ? body.slice(PROJECT_TEMPLATE_HEADER.length) : body).split('\n')[0]!;
  const points = [...firstLine];
  const title = points.length > 60 ? `${points.slice(0, 59).join('')}…` : firstLine;
  return { id: suggestionId(kind, body), title, body, count, kind };
}

/** Deterministic, local-only candidates for a user's review/edit/save step.
 * Input order is the caller's sampling order (normally newest first). No text
 * or IDs from excluded entries, and no raw pattern examples, leave this call.
 */
export function createPromptGuideSuggestionAnalyzer(options: PromptGuideAnalysisOptions = {}) {
  const excludedByReason: Record<PromptGuideExclusion, number> = {
    'entry-limit': 0, 'invalid-entry': 0,
    'not-human': 0, 'duplicate-identity': 0, empty: 0, 'too-long': 0, 'text-budget': 0,
    sensitive: 0, 'quoted-or-code': 0, 'app-boilerplate': 0, short: 0,
  };
  const identities = new Set<string>();
  const repeats = new Map<string, number>();
  const patterns = new Map<string, { body: string; count: number; variants: Set<string> }>();
  // Keep only bounded, privacy-checked examples; never retain source metadata.
  const recent: PromptGuideRecent[] = [];
  const recentOrder = (left: PromptGuideRecent, right: PromptGuideRecent) =>
    Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || compare(left.id, right.id);
  let sampledEntries = 0;
  let analyzedTextBytes = 0;
  let receivedEntries = 0;
  const add = (entry: PromptGuideEntry): void => {
    receivedEntries += 1;
    if (receivedEntries > PROMPT_GUIDE_LIMITS.entries) { excludedByReason['entry-limit'] += 1; return; }
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 512
      || (entry.memoryId != null && (typeof entry.memoryId !== 'string' || entry.memoryId.length > 512))
      || typeof entry.text !== 'string') { excludedByReason['invalid-entry'] += 1; return; }
    if (entry.promptOrigin !== 'human') { excludedByReason['not-human'] += 1; return; }
    const identity = JSON.stringify([entry.memoryId ?? '', entry.id]);
    if (identities.has(identity)) { excludedByReason['duplicate-identity'] += 1; return; }
    identities.add(identity);
    // Do not truncate then mine a misleading prefix, or scan an unbounded
    // conversation before rejecting it. UTF-8 encoding here is at most 8KB.
    if (entry.text.length > PROMPT_GUIDE_LIMITS.entryBytes) { excludedByReason['too-long'] += 1; return; }
    const text = entry.text.trim().replace(/\r\n?/g, '\n');
    if (!text) { excludedByReason.empty += 1; return; }
    const bytes = byteLength(text);
    if (bytes > PROMPT_GUIDE_LIMITS.entryBytes || text.split('\n').length > PROMPT_GUIDE_LIMITS.lines) { excludedByReason['too-long'] += 1; return; }
    if (analyzedTextBytes + bytes > PROMPT_GUIDE_LIMITS.inputTextBytes) { excludedByReason['text-budget'] += 1; return; }
    // Withheld entries still consume inspection work. Charge before privacy
    // and format checks so a batch of sensitive text cannot bypass the budget.
    analyzedTextBytes += bytes;
    if (CLI_HOST_ENVELOPE.test(text)) { excludedByReason['app-boilerplate'] += 1; return; }
    const { instruction, hasProject, unsafeName } = projectInstruction(text);
    if (unsafeName || sensitive(instruction)) { excludedByReason.sensitive += 1; return; }
    if (!instruction) { excludedByReason.empty += 1; return; }
    if (APP_BOILERPLATE.test(text)) { excludedByReason['app-boilerplate'] += 1; return; }
    if (RAW_CONTENT.test(text) || /^["'“‘][\s\S]*["'”’]$/.test(text) || /"[^"\n]{80,}"|“[^”]{80,}”/.test(text) || /^\s*[{[]/.test(text)
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) { excludedByReason['quoted-or-code'] += 1; return; }
    if (!options.includeShortRepeats && [...instruction.replace(/\s/g, '')].length < 6) { excludedByReason.short += 1; return; }
    sampledEntries += 1;
    const form = template(instruction, hasProject);
    if (options.includeRecent && typeof entry.recordedAt === 'string' && Number.isFinite(Date.parse(entry.recordedAt))) {
      const body = form.privateLocation ? form.body : text;
      const value = suggestion('repeat', body, 1);
      const existing = recent.findIndex(item => item.body === body);
      const next = {id: value.id, title: value.title, body, recordedAt: new Date(entry.recordedAt).toISOString(), generalized: form.privateLocation};
      if (existing < 0) recent.push(next);
      else if (Date.parse(next.recordedAt) > Date.parse(recent[existing]!.recordedAt)) recent[existing] = next;
      recent.sort(recentOrder);
      recent.splice(PROMPT_GUIDE_LIMITS.recentEntries);
      let bytes = 0;
      for (let index = 0; index < recent.length;) {
        const size = byteLength(recent[index]!.title) + byteLength(recent[index]!.body);
        if (bytes + size > PROMPT_GUIDE_LIMITS.recentTextBytes) recent.splice(index, 1);
        else {bytes += size; index += 1;}
      }
    }
    // Exact repetition preserves the complete accepted prompt, never an
    // extracted line. Local paths/URLs are not re-exposed as exact examples.
    if (!form.privateLocation) repeats.set(text, (repeats.get(text) ?? 0) + 1);
    if (form.variables > 0 && form.anchor >= 6) {
      const group = patterns.get(form.key) ?? { body: form.body, count: 0, variants: new Set<string>() };
      group.count += 1; group.variants.add(text); patterns.set(form.key, group);
    }
  }
  const finish = (): PromptGuideAnalysis => {
    const supported = [
      ...[...repeats].filter(([, count]) => count >= 2).map(([body, count]) => suggestion('repeat', body, count)),
      ...[...patterns.values()].filter(group => group.count >= 2 && group.variants.size >= 2)
        .map(group => suggestion('pattern', group.body, group.count)),
    ].sort((left, right) => right.count - left.count || compare(left.kind, right.kind) || compare(left.body, right.body));
    const candidates: PromptGuideSuggestion[] = [];
    let candidateTextBytes = 0;
    const recentBytes = recent.reduce((sum, item) => sum + byteLength(item.title) + byteLength(item.body), 0);
    for (const candidate of supported) {
      const bytes = byteLength(candidate.title) + byteLength(candidate.body);
      if (candidates.length >= PROMPT_GUIDE_LIMITS.candidates || recentBytes + candidateTextBytes + bytes > PROMPT_GUIDE_LIMITS.outputTextBytes) continue;
      candidates.push(candidate); candidateTextBytes += bytes;
    }
    return { candidates, ...(options.includeRecent ? {recent: recent.map(item => ({...item}))} : {}), stats: { receivedEntries, inspectedEntries: Math.min(receivedEntries, PROMPT_GUIDE_LIMITS.entries), sampledEntries,
      excludedEntries: Object.values(excludedByReason).reduce((sum, value) => sum + value, 0), excludedByReason: {...excludedByReason},
      analyzedTextBytes, candidateTextBytes, candidatesFound: supported.length, candidatesOmitted: supported.length - candidates.length } };
  };
  return {add, finish};
}

/** Array convenience API; streaming pages use the exact same bounded rules. */
export function analyzePromptGuideSuggestions(entries: readonly PromptGuideEntry[],
  options: PromptGuideAnalysisOptions = {}): PromptGuideAnalysis {
  if (!Array.isArray(entries)) throw new TypeError('Prompt guide entries must be an array.');
  const analyzer = createPromptGuideSuggestionAnalyzer(options);
  for (let index = 0; index < Math.min(entries.length, PROMPT_GUIDE_LIMITS.entries); index += 1) analyzer.add(entries[index]!);
  const result = analyzer.finish();
  const omitted = Math.max(0, entries.length - PROMPT_GUIDE_LIMITS.entries);
  result.stats.receivedEntries = entries.length;
  result.stats.excludedByReason['entry-limit'] += omitted;
  result.stats.excludedEntries += omitted;
  return result;
}
