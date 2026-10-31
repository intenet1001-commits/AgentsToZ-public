import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';

const LMH: readonly WorkroomEffortLevel[] = ['low', 'medium', 'high'];
const ALL: readonly WorkroomEffortLevel[] = [...LMH, 'xhigh', 'max'];
/**
 * Codex models and the reasoning levels Codex's own model metadata lists for each (`~/.codex/models_cache.json`, written
 * by codex-cli 0.163.0, re-read 2026-10-28: every listed model offers low…max, the `ultra` set below also ultra). The hidden
 * `gpt-reserve` and `codex-auto-review` are included because a config file can still name them. Nothing here is inferred:
 * a model this metadata does not list is not a catalog model.
 */
export const TEAM_CODEX_EXTRA_EFFORT_MODELS = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-reserve', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'codex-auto-review']);
export const TEAM_CODEX_ULTRA_MODELS = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']);
/** Older bundled catalog entries the current metadata no longer lists: only their independently established low/medium/high. */
export const TEAM_CODEX_LMH_MODELS = new Set(['gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest', 'gpt-5.5']);
/** The levels a Codex catalog model offers, or null for a model the catalog does not know (Codex rejects an unsupported level). */
export function teamCodexEffortLevels(model: string): readonly WorkroomEffortLevel[] | null {
  if (TEAM_CODEX_EXTRA_EFFORT_MODELS.has(model)) return TEAM_CODEX_ULTRA_MODELS.has(model) ? [...ALL, 'ultra'] : ALL;
  return TEAM_CODEX_LMH_MODELS.has(model) ? LMH : null;
}
// agy exposes distinct model slugs per effort. These are the known variants in its
// existing model picker; never infer levels for a custom/default model.
const AGY_VARIANTS: Readonly<Record<string, readonly WorkroomEffortLevel[]>> = {
  'gemini-4-argon': LMH, 'gemini-3.8-flash': LMH, 'claude-opus-5-5': LMH,
  'claude-sonnet-5-5': LMH, 'gpt-oss-120b': ['medium'],
};
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];
/**
 * Hermes (v0.20.5) passes `--reasoning` through its provider adapter, which silently moves a level the provider lacks:
 * - `anthropic`: agent/anthropic_adapter.py sends no reasoning at all for a model containing «haiku», so no pin is offered
 *   for Haiku; Opus/Sonnet/Fable 5.x get low…max verbatim (ADAPTIVE_EFFORT_MAP maps ultra to max, so ultra is not offered).
 * - `openai-codex`: agent/reasoning_effort.py codex_supported_efforts clamps to none…max for «gpt-5.6» models and to
 *   none…xhigh for every other model — intersected with the Codex catalog, so an uncatalogued model keeps low/medium/high.
 * Any other provider or no provider keeps low/medium/high, the levels Hermes always accepted here.
 * The Workroom start uses the same list for a Hermes launch whose model and provider it chose (src/workroomEffortSession.ts).
 */
export function teamHermesEffortLevels(model?: string, provider?: string): readonly WorkroomEffortLevel[] {
  if (!model) return LMH;
  if (provider === 'anthropic') {
    if (model.toLowerCase().includes('haiku')) return [];
    return CLAUDE_MODELS.includes(model) ? ALL : LMH;
  }
  if (provider === 'openai-codex') {
    const catalog = teamCodexEffortLevels(model);
    if (!catalog) return LMH;
    const hermes: readonly WorkroomEffortLevel[] = model.toLowerCase().includes('gpt-5.6') ? ALL : [...LMH, 'xhigh'];
    return hermes.filter(level => catalog.includes(level));
  }
  return LMH;
}
/**
 * The levels the team builder and create_team let a person pin for one member. Every list is a level its launch can carry:
 * a Codex model the catalog does not know offers none (the Workroom start would refuse the pin — src/aiTerminalService.ts),
 * and Codex's CLI default keeps low/medium/high, which every catalog model offers (the start still proves this Mac's
 * configured model and refuses an unknown one — src/codexEffortModel.ts).
 *
 * Claude's CLI default differs by surface on purpose (2026-10-28 decision): in the Workroom a pin is enforced — the start is
 * refused when CLAUDE_CODE_EFFORT_LEVEL overrides it — and xhigh ends a turn with thinking off, so an unnamed model keeps
 * low/medium/high. On Orca the same `--effort` is only a request: Orca's shell environment cannot be observed, the member
 * shows 「요청됨 · 실제 적용 확인 필요」, and the CLI accepts low…max for every current Claude model.
 */
export function teamEffortLevels(agent: AiTerminalAgent, model?: string, surface?: string, provider?: string): readonly WorkroomEffortLevel[] {
  if (agent === 'agy') {
    if (!model) return [];
    const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(model);
    const levels = match && AGY_VARIANTS[match[1]!];
    return levels && levels.includes(match![2] as WorkroomEffortLevel) ? levels : [];
  }
  if (agent === 'hermes') return teamHermesEffortLevels(model, provider);
  // Orca's default Claude model cannot be identified before launch. The CLI accepts
  // these arguments, but the selection is expressly a request, not a capability claim.
  if (agent === 'claude' && !model && (surface === 'orca-worktree' || surface === 'orca-floating')) return ALL;
  if (agent === 'claude' && model && CLAUDE_MODELS.includes(model)) return ALL;
  if (agent === 'codex' && model) return teamCodexEffortLevels(model) ?? [];
  return LMH;
}
/**
 * Whether a pinned level is only a request that the start cannot hold: outside the Workroom (Orca's shell environment is not
 * observed), and Hermes on every surface — it hands `--reasoning` to its provider adapter, which moves or drops a level
 * silently, and the Workroom start cannot see the model Hermes's own config chooses. A Workroom pin for Claude or Codex is
 * refused at start when it cannot be applied (src/aiTerminalService.ts) and agy's pin is the model variant it starts, so those
 * show as fixed. An absent surface is the Workroom (records from before surfaces existed).
 */
export function teamEffortIsRequest(agent: AiTerminalAgent, surface?: string): boolean {
  return agent === 'hermes' || (!!surface && surface !== 'internal');
}
