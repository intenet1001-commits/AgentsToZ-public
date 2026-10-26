import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';
import {TEAM_MODEL_CHOICES, type AiTerminalLaunchModel} from './workroomTeamInstruction';
import {WORKROOM_AGENT_NAMES} from './workroomPopout';

/**
 * 「Hermes · Claude」와 「Hermes · Codex」 (사용자 요청 2026-10-25: 「헤르메스는 헤르메스에 코덱스, 클로드 둘다 적용할수있으니
 * 별도버튼으로 만들어져야」). Hermes runs another maker's model, so this Mac offers each as its own item in every launch
 * list: the person picks one thing instead of starting Hermes and then typing a model.
 *
 * One list decides the model: the team builder's own `TEAM_MODEL_CHOICES.hermes` presets (src/workroomTeamInstruction.ts).
 * A variant is the **first** preset of its provider, so updating that list updates the buttons too.
 *
 * Browser-safe: the launch itself is host-only (the model and provider never ride a wire request —
 * src/aiTerminalLaunchArgs.ts, docs/claude/remote-control.md). This module only names the choice.
 */
export const HERMES_VARIANTS = ['claude', 'codex'] as const;
export type HermesVariant = (typeof HERMES_VARIANTS)[number];

/** The provider id each variant launches on — the only thing the credential check ever looks at. */
export const HERMES_VARIANT_PROVIDER: Readonly<Record<HermesVariant, string>> = {claude: 'anthropic', codex: 'openai-codex'};
/** What the item is called. The maker's own name, not a translated word. */
export const HERMES_VARIANT_NAME: Readonly<Record<HermesVariant, string>> = {claude: 'Claude', codex: 'Codex'};

/** The model and provider this variant starts Hermes with. */
export function hermesVariantModel(variant: HermesVariant): AiTerminalLaunchModel {
  const provider = HERMES_VARIANT_PROVIDER[variant];
  const preset = TEAM_MODEL_CHOICES.hermes.find(choice => choice.provider === provider && !!choice.model);
  if (!preset) throw new Error(`Hermes의 ${provider} 모델 목록이 비어 있습니다.`);
  return {model: preset.model, provider};
}

/**
 * The variant a session was launched with, read back from its host-only model choice. Both the provider **and** the
 * model must match the item: a team member running another Anthropic model is not 「Hermes · Claude」, and a label
 * must not claim a model the session does not run.
 */
export function hermesVariantOf(model?: {model?: string; provider?: string} | null): HermesVariant | null {
  if (!model?.provider || !model.model) return null;
  return HERMES_VARIANTS.find(variant => HERMES_VARIANT_PROVIDER[variant] === model.provider
    && hermesVariantModel(variant).model === model.model) ?? null;
}

/** Exactly one of the two names, or null: a start option is an enum, never a free model string from a caller. */
export function parseHermesVariant(value: unknown): HermesVariant | null {
  return typeof value === 'string' && (HERMES_VARIANTS as readonly string[]).includes(value) ? value as HermesVariant : null;
}

/** What a person picks in a launch list: an AI, or Hermes on one of its providers. */
export type WorkroomLaunchChoice = AiTerminalAgent | `hermes:${HermesVariant}`;
export const HERMES_VARIANT_CHOICES = HERMES_VARIANTS.map(variant => `hermes:${variant}` as const);
/** The list every launch surface shows: the variants sit right next to Hermes. */
export function workroomLaunchChoices(agents: readonly AiTerminalAgent[] = AI_TERMINAL_AGENTS): WorkroomLaunchChoice[] {
  return agents.flatMap(agent => agent === 'hermes' ? ['hermes' as const, ...HERMES_VARIANT_CHOICES] : [agent]);
}
export const WORKROOM_LAUNCH_CHOICES: readonly WorkroomLaunchChoice[] = workroomLaunchChoices();

/** The one launch a choice means. An unknown choice is not a launch. */
export function launchChoiceTarget(choice: string): {agent: AiTerminalAgent; variant?: HermesVariant} {
  const [agent, rest] = choice.split(':', 2);
  if (agent === 'hermes' && rest !== undefined) {
    const variant = parseHermesVariant(rest);
    if (!variant) throw new Error('실행할 AI를 다시 선택하세요.');
    return {agent: 'hermes', variant};
  }
  if (!(AI_TERMINAL_AGENTS as readonly string[]).includes(choice)) throw new Error('실행할 AI를 다시 선택하세요.');
  return {agent: choice as AiTerminalAgent};
}
export function launchChoiceId(agent: AiTerminalAgent, variant?: HermesVariant | null): WorkroomLaunchChoice {
  return agent === 'hermes' && variant ? `hermes:${variant}` : agent;
}
export function launchChoiceLabel(choice: string): string {
  const {agent, variant} = launchChoiceTarget(choice);
  // The same CLI names every other launch list shows (src/workroomPopout.ts), so one item cannot drift from another.
  return variant ? `${WORKROOM_AGENT_NAMES[agent]} · ${HERMES_VARIANT_NAME[variant]}` : WORKROOM_AGENT_NAMES[agent];
}

export interface HermesVariantItem {
  variant: HermesVariant;
  choice: WorkroomLaunchChoice;
  label: string;
  provider: string;
  model: string;
  /** False only when this Mac's Hermes is known to have no credential for that provider. */
  available: boolean;
}
/**
 * The two items for a launch list. `providers` is the set of provider **names** this Mac's Hermes has credentials for
 * (src/hermesProviderCredentials.ts), or null when that could not be asked — then both are offered rather than hidden
 * on a guess. No secret value takes part in this decision.
 */
export function hermesVariantItems(providers: ReadonlySet<string> | null): HermesVariantItem[] {
  return HERMES_VARIANTS.map(variant => {
    const provider = HERMES_VARIANT_PROVIDER[variant];
    return {variant, choice: `hermes:${variant}` as const, label: launchChoiceLabel(`hermes:${variant}`), provider,
      model: hermesVariantModel(variant).model, available: !providers || providers.has(provider)};
  });
}

/**
 * This Mac's own view of the two items (src/hermesVariantsClient.ts ↔ api-server.ts). A separate local path, like
 * 팀 현황: the Workroom DTO and `AiTerminalSummary` gain nothing, so the phone's normalizer has nothing new to reject
 * (docs/claude/remote-control.md). A phone keeps the single Hermes item.
 */
export const HERMES_VARIANTS_PATH = '/api/agent-runtime/hermes-variants';
/** The one start option this Mac's panels add. Never part of a wire request: the host strips it before normalizing. */
export const HERMES_VARIANT_START_KEY = 'hermesVariant';
export interface HermesVariantSession { sessionId: string; variant: HermesVariant }
export interface HermesVariantView {
  items: HermesVariantItem[];
  /** Live sessions that were launched as a variant, so a tab can say which one it runs. */
  sessions: HermesVariantSession[];
  /** False when this Mac could not be asked at all (no Hermes CLI): every item is offered, none is gated. */
  checked: boolean;
}

/** Local data, still normalized: a malformed answer must not reach a picker. */
export function normalizeHermesVariantView(value: unknown): HermesVariantView {
  const raw = (value ?? {}) as {items?: unknown; sessions?: unknown; checked?: unknown};
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap(entry => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const variant = parseHermesVariant(item.variant);
    if (!variant || typeof item.provider !== 'string' || typeof item.model !== 'string') return [];
    return [{variant, choice: `hermes:${variant}` as const, label: launchChoiceLabel(`hermes:${variant}`),
      provider: item.provider, model: item.model, available: item.available !== false}];
  });
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).flatMap(entry => {
    const session = (entry ?? {}) as Record<string, unknown>;
    const variant = parseHermesVariant(session.variant);
    return variant && typeof session.sessionId === 'string' && session.sessionId ? [{sessionId: session.sessionId, variant}] : [];
  });
  return {items: items.length ? items : hermesVariantItems(null), sessions, checked: raw.checked === true};
}

/**
 * Takes this Mac's panel start option off a local terminal request. The remaining request is the ordinary DTO, so
 * `normalizeAiTerminalRequest` still refuses the key on any other path (a remote request carrying it is rejected whole).
 */
export function splitHermesVariantStart(body: unknown): {request: unknown; variant: HermesVariant | null} {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, HERMES_VARIANT_START_KEY)) return {request: body, variant: null};
  const {[HERMES_VARIANT_START_KEY]: value, ...request} = body as Record<string, unknown>;
  const variant = parseHermesVariant(value);
  if (!variant) throw new Error('Hermes 실행 종류를 다시 선택하세요.');
  if (request.operation !== 'start' || request.agent !== 'hermes') throw new Error('Hermes 실행 종류는 Hermes 워크룸을 새로 시작할 때만 씁니다.');
  if (request.resumeFrom !== undefined) throw new Error('「다시 시작」은 원래 세션의 Hermes 종류를 그대로 이어갑니다.');
  return {request, variant};
}
