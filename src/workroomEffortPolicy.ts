import type {AiTerminalAgent} from './aiTerminalProtocol';
import {splitWorkroomAttachmentBlock} from './workroomImageAttachments';

/**
 * Workroom 「에포트 자동」 (w16, user decision 2026-10-16): which reasoning effort a request needs, decided locally and
 * deterministically from the request text — no model call. The only implementation of the table in
 * tests/fixtures/workroom-effort-golden.json; change both together.
 *
 * Rules follow CLAUDE.md «Task-aware model and reasoning advice»: higher for unresolved concurrency, privilege or
 * security isolation, destructive data migration design, repeated failures whose cause is unclear, and
 * architecture/design/review/audit work; lower for routine edits (typo, wording, rename, translation, formatting);
 * medium otherwise.
 *
 * Auto never goes above `high` on any CLI: Claude ends a turn with «Effort 'xhigh' isn't available with thinking
 * turned off», and max/ultra are the costliest levels. Below `low` (minimal/none) is never chosen either.
 */

export type WorkroomEffortTier = 'low' | 'medium' | 'high';
/**
 * Every level a launch can carry. Auto passes only WORKROOM_EFFORT_AUTO_LEVELS (accepted by Claude, every Codex catalog model
 * and Hermes); xhigh, max and ultra come only from a person's pin, offered per model (src/teamEffortCatalog.ts).
 */
export type WorkroomEffortLevel = WorkroomEffortTier | 'xhigh' | 'max' | 'ultra';
export const WORKROOM_EFFORT_AUTO_LEVELS: readonly WorkroomEffortLevel[] = ['low', 'medium', 'high'];

export type WorkroomEffortHighReason = 'concurrency' | 'security' | 'migration' | 'unclear-failure' | 'design-review';
export type WorkroomEffortLowReason = 'typo' | 'wording' | 'rename' | 'translate' | 'format';
export type WorkroomEffortReason = WorkroomEffortHighReason | WorkroomEffortLowReason | 'standard';
export interface WorkroomEffortDecision {tier: WorkroomEffortTier; reason: WorkroomEffortReason}

/**
 * How auto can drive each CLI. `launch`: a flag when the CLI starts (Claude `--effort`, Codex
 * `-c model_reasoning_effort`, Hermes `chat --reasoning`). Antigravity has `--effort`, but it is coupled to choosing a
 * model variant (its changelog: a bare flag once moved the person to another model) — so it is not driven.
 * Runtime changes use the separate session-only adapter in workroomEffortRuntime.ts. Persistent defaults are never changed.
 */
export const WORKROOM_EFFORT_SUPPORT: Readonly<Record<AiTerminalAgent, 'launch' | 'none'>> = {claude: 'launch', codex: 'launch', hermes: 'launch', agy: 'none'};

/** Only the beginning of a request is read. */
export const WORKROOM_EFFORT_TEXT_MAX_CHARS = 4_000;
/** A routine cue makes a request «low» only while the request itself is short. */
export const WORKROOM_EFFORT_LOW_MAX_CHARS = 300;

type Cue = RegExp;
/** Korean cues are matched as written (Hangul is not a `\b` word character); English cues as whole words. */
const word = (source: string): Cue => new RegExp(`\\b(?:${source})\\b`);

/** First match sets the reason; the order is the order of this table. */
export const WORKROOM_EFFORT_HIGH_CUES: readonly (readonly [WorkroomEffortHighReason, readonly Cue[]])[] = [
  ['concurrency', [
    /동시성|경합|레이스\s*컨디션|경쟁\s*상태|데드락|교착|락\s*순서|원자적|멀티\s*스레드|스레드\s*안전|동시\s*실행/,
    word('race conditions?|data races?|deadlocks?|livelocks?|thread[- ]safe(?:ty)?|concurren(?:cy|t)|mutex(?:es)?|atomicity|atomically'),
  ]],
  ['security', [
    /보안|권한\s*(?:격리|상승|우회)|샌드박스|취약|인증\s*우회|(?:토큰|비밀|키|자격\s*증명)\s*유출|탈취|인젝션/,
    word('security|privileges?|privilege escalation|sandbox(?:es|ing)?|vulnerab\\w*|injections?|xss|csrf|ssrf|exploits?|rls|auth(?:entication)? bypass|(?:secret|credential|token|key)s? leaks?'),
  ]],
  ['migration', [
    /마이그레이션|스키마\s*변경|데이터\s*(?:이전|삭제|정리)|일괄\s*삭제|백필|롤백\s*계획|테이블\s*삭제/,
    word('migrations?|backfill(?:s|ing)?|drop table|destructive|schema changes?|rollback plan|data loss'),
  ]],
  ['unclear-failure', [
    /원인\s*(?:불명|을?\s*모르|모를|을?\s*못\s*찾)|왜\s*(?:자꾸|계속)|왜\s*안\s*(?:돼|되|됨|될)|(?:계속|또|자꾸)\s*실패|재현이?\s*안|간헐적|가끔\s*실패|랜덤하게\s*실패/,
    word('flaky|intermittent(?:ly)?|keeps? failing|still failing|root cause|sometimes fails|randomly fails|can(?:no|\')t reproduce|cannot reproduce|no idea why'),
  ]],
  ['design-review', [
    /아키텍처|설계|트레이드\s*오프|(?:코드|설계|디자인|보안|전체|pr)\s*리뷰|리뷰\s*(?:해|부탁|좀)|검토|(?:코드|보안|전체|정밀|권한)\s*감사|감사\s*(?:보고서|결과)/,
    word('architecture|architectural|audit(?:s|ing)?|trade-?offs?|(?:code|design|security|architecture|pr|pull request) reviews?|review (?:this|the|these|my|our)'),
    /^\s*(?:please\s+)?review\b/,
  ]],
];
export const WORKROOM_EFFORT_LOW_CUES: readonly (readonly [WorkroomEffortLowReason, readonly Cue[]])[] = [
  ['typo', [/오타|맞춤법|띄어쓰기/, word('typos?|spelling')]],
  ['wording', [/문구\s*(?:만|를|을)?\s*(?:수정|바꿔|바꾸|변경|다듬|고쳐)|워딩|문장\s*(?:만\s*)?다듬|표현\s*(?:만|을|를)?\s*(?:바꿔|수정|다듬)/, word('wording|rephrase|reword|copy edit')]],
  ['rename', [/이름\s*(?:만|을|를)?\s*(?:바꿔|바꾸|변경)/, word('rename(?:s|d)?')]],
  ['translate', [/번역/, word('translat(?:e|ion|ing)')]],
  ['format', [/서식|포맷팅|코드\s*포맷|들여쓰기|정렬만|린트/, word('formatting|reformat|prettier|lint|indentation')]],
];

/** The person's own words: the final Enter and an attachment block (paths, not request) are not read. */
export function workroomEffortRequestText(text: string): string {
  const body = text.endsWith('\r') ? text.slice(0, -1) : text;
  const block = splitWorkroomAttachmentBlock(body);
  return block ? block.text : body;
}

/**
 * The tier a request needs, or null when there is nothing to decide from: empty text, or a CLI command (`/…`),
 * a skill (`$…`) or a shell escape (`!…`) — those are not requests the CLI reasons about.
 * Known limit (kept in the golden table): negation is not understood («동시성 문제는 아니고 오타만» is high).
 */
export function classifyWorkroomEffort(text: string): WorkroomEffortDecision | null {
  const normalized = text.slice(0, WORKROOM_EFFORT_TEXT_MAX_CHARS).normalize('NFKC').toLowerCase().trim();
  if (!normalized || /^[/$!]/.test(normalized)) return null;
  for (const [reason, cues] of WORKROOM_EFFORT_HIGH_CUES) if (cues.some(cue => cue.test(normalized))) return {tier: 'high', reason};
  if (normalized.length <= WORKROOM_EFFORT_LOW_MAX_CHARS)
    for (const [reason, cues] of WORKROOM_EFFORT_LOW_CUES) if (cues.some(cue => cue.test(normalized))) return {tier: 'low', reason};
  return {tier: 'medium', reason: 'standard'};
}

/**
 * The level a CLI receives for a tier, or null for none. `allowed` narrows it to what the model is proven to offer
 * (Codex, src/codexEffortModel.ts): a level outside it is never passed — the CLI keeps its own default instead.
 */
export function workroomEffortLevel(agent: AiTerminalAgent, tier: WorkroomEffortLevel, allowed?: readonly string[]): WorkroomEffortLevel | null {
  if (WORKROOM_EFFORT_SUPPORT[agent] !== 'launch') return null;
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(tier)) return null;
  if (allowed && !allowed.includes(tier)) return null;
  return tier;
}

/** Ordinal of an effort word a CLI shows, for comparing what it runs at with what a request needs. */
export function workroomEffortRank(level: string | undefined): number | null {
  const ranks: Record<string, number> = {none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6};
  return level !== undefined && level in ranks ? ranks[level]! : null;
}
