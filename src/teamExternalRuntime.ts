/** Host-only external team execution. No shell, account environment, desktop automation or CLI is run here. */
import {createHash} from 'node:crypto';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {normalizeWorkroomKeys, type WorkroomKey} from './workroomOrchestration';

export type TeamExternalSurface = 'orca-floating' | 'orca-worktree' | 'cmux' | 'iterm' | 'terminal' | 'powershell' | 'wsl' | 'app';
export interface TeamExternalRequested {
  model?: string; provider?: string; accountId?: string; effort?: WorkroomEffortLevel; bypassPermissions?: boolean;
  launchOptions?: {bgMode?: boolean; tmuxMode?: boolean; reuse?: 'new' | 'reuse-or-new'; appMode?: 'new' | 'reopen' | 'open'};
}
export interface TeamExternalScope {
  executionId: string; hostInstanceId: string; teamId: string; memberId: string; targetId: string;
  cwd: string; generation: number; agent: AiTerminalAgent; surface: TeamExternalSurface;
}
export interface TeamExternalLaunchInput extends TeamExternalScope {
  operationId: string; requested: TeamExternalRequested; title: string; prompt: string;
}
export type TeamExternalState = 'starting' | 'awaiting-connection' | 'awaiting-manual-join' | 'awaiting-ack' | 'working' | 'blocked' | 'failed' | 'exited' | 'unknown' | 'closed';
export type TeamExternalOption = 'model' | 'provider' | 'accountId' | 'effort' | 'bypassPermissions' | `launchOptions.${'bgMode' | 'tmuxMode' | 'reuse' | 'appMode'}`;
/** An argv request is evidence of application, never evidence of the model/account actually running. */
export interface TeamExternalApplication {
  mode: 'automatic' | 'manual-settings' | 'unknown' | 'inherit'; evidence?: 'launch-argument' | 'runtime-verified'; reason?: string;
}
export interface TeamExternalCapabilities {probe: boolean; read: boolean; submit: boolean; reveal: boolean; close: boolean}
const NO_CAPABILITIES: TeamExternalCapabilities = {probe: false, read: false, submit: false, reveal: false, close: false};
interface PlanCommon {
  /** Opaque lookup into a host-validated launch plan. Never a shell command, environment, credential or API-supplied argv. */
  planId: string; capabilityRevision: string; applied: Partial<Record<TeamExternalOption, TeamExternalApplication>>;
  capabilities: TeamExternalCapabilities;
  /** Stable host reason code for UI capability evidence; never raw CLI output or environment. */
  reason?: string;
}
export type TeamExternalPreparedPlan = PlanCommon & (
  | {kind: 'managed'; initialPrompt: 'launch' | 'submit'}
  | {kind: 'manual'; readiness: 'ready' | 'needs-setup'}
  | {kind: 'awaiting-connection'}
);
interface NativeCommon {
  hostInstanceId: string;
  /** Adapter runtime incarnation (Orca/cmux restart changes it); a reused native handle alone is insufficient. */
  runtimeInstanceId: string; cwd: string; agent: AiTerminalAgent; owned: boolean;
}
export type TeamExternalNativeRef = NativeCommon & (
  | {kind: 'orca'; terminalHandle: string; worktreeId: string}
  | {kind: 'cmux'; workspaceId: string; surfaceId: string}
  | {kind: 'manual'; launcherId: string}
);
export interface TeamExternalRef extends TeamExternalScope {native: TeamExternalNativeRef | null}
export interface TeamExternalReceipt {
  version: 1; executionRef: TeamExternalRef; state: TeamExternalState; requested: TeamExternalRequested;
  management: 'unresolved' | 'managed' | 'manual' | 'awaiting-connection';
  /** Runtime agent identity evidence, distinct from the desired agent in the member binding. */
  agentVerified: boolean | null;
  applied: Partial<Record<TeamExternalOption, TeamExternalApplication>>; capabilities: TeamExternalCapabilities;
  capabilityRevision: string | null;
  instruction: {status: 'not-sent' | 'sending' | 'written' | 'unknown' | 'prefill-requested' | 'manual-transfer-ready'; operationId?: string};
  /** Unknown lifetime and all borrowed windows keep the member checkout. Git safety is additionally enforced by TeamService. */
  retainWorktree: boolean; reason: string | null;
}
/** Identity can recover independently of an unconfirmed instruction; never clear that uncertainty. */
function reasonAfterIdentityRecovery(receipt: TeamExternalReceipt): string | null {
  return receipt.reason === 'EXTERNAL_AGENT_IDENTITY_UNVERIFIED'
    ? receipt.instruction.status === 'unknown' ? 'EXTERNAL_DELIVERY_UNKNOWN' : null
    : receipt.reason;
}
export interface TeamExternalReadResult {
  receipt: TeamExternalReceipt; outcome: 'read' | 'unavailable' | 'unconfirmed'; text: string; cursor?: string;
}
export type TeamExternalOperationKind = 'launch' | 'submit' | 'reveal' | 'close' | 'keys';
export interface TeamExternalOperation {
  id: string; kind: TeamExternalOperationKind; fingerprint: string; status: 'reserved' | 'settled';
  /**
   * Settled also includes failures. Missing in old journals means unconfirmed, never performed.
   * `not-sent` for keys or submit is positive evidence that nothing was typed.
   */
  outcome?: 'performed' | 'unknown' | 'not-sent';
  /** The bounded reason belongs to this operation, not to whichever request last updated the receipt. */
  reason?: TeamExternalDelivery['reason'];
}
/** Persist this together with the team's member binding. CAS must be durable and atomic across adapter instances. */
export interface TeamExternalJournalRecord {
  version: 1; revision: number; launchFingerprint: string;
  /** Optional for old v1 journals: without it a known-written launch cannot safely accept a follow-up. */
  initialInstructionFingerprint?: string;
  receipt: TeamExternalReceipt; operations: TeamExternalOperation[];
}
export interface TeamExternalJournal {
  read(executionId: string): Promise<TeamExternalJournalRecord | null>;
  compareAndSet(executionId: string, expectedRevision: number | null, next: TeamExternalJournalRecord): Promise<boolean>;
}
export interface TeamExternalProbe {
  /** Null supports a connection-only check before cmux has an execution; it never attaches an arbitrary existing tab. */
  native: TeamExternalNativeRef | null; connection: 'connected' | 'disconnected' | 'missing';
  agentVerified: boolean; activity: 'idle' | 'working' | 'exited' | 'unknown';
}
export type TeamExternalCreatePlan = {
  operationId: string; scope: TeamExternalScope; planId: string; title: string; initialPrompt?: string;
} & (
  /** Public Orca: terminal create --worktree <selector> --title <title> --command <validated command> --json. No second worktree. */
  | {kind: 'orca-create'; worktreeSelector: string}
  | {kind: 'cmux-create'}
);
export type TeamExternalTargetPlan = {
  operationId: string; executionRef: TeamExternalRef;
} & (
  /** terminal read/send/switch/close --terminal <exact handle> --json; never active-tab selectors. */
  | {kind: 'orca-target'; terminalHandle: string}
  | {kind: 'cmux-target'; workspaceId: string; surfaceId: string}
  | {kind: 'manual-target'; launcherId: string}
);
export interface TeamExternalDelivery {
  /** Orca accepted:true alone is only input acceptance. turn_started must come from its actual submission receipt. */
  outcome: 'written' | 'unknown' | 'not-sent'; turnStarted?: boolean;
  reason?: 'EXTERNAL_SCREEN_UNAVAILABLE' | 'EXTERNAL_PROMPT_AWAITS_ANSWER' | 'EXTERNAL_BINDING_UNVERIFIED';
}
/**
 * Keys typed into a managed Orca worktree member: `performed` only when every key was accepted by the same verified
 * process, `not-sent` only when nothing was typed, anything in between is `unknown` and never typed again.
 * `EXTERNAL_KEYS_WOULD_EXIT`: an Enter or digit would have chosen 「No, exit」 and was withheld, with any earlier keys typed.
 */
export interface TeamExternalKeysDelivery {outcome: 'performed' | 'not-sent' | 'unknown'; reason?: 'EXTERNAL_KEYS_WOULD_EXIT'}
export interface TeamExternalRuntimeDeps {
  journal: TeamExternalJournal;
  /** Synchronous current generation + checkout ownership check, repeated immediately before every external write. */
  isCurrent(scope: TeamExternalScope): boolean;
  /** Resolves catalog/account/model/child-spawn support again. An unverified account environment must be manual/needs-setup. */
  prepare(input: TeamExternalLaunchInput): Promise<TeamExternalPreparedPlan>;
  create(plan: TeamExternalCreatePlan): Promise<{native: TeamExternalNativeRef; delivery: TeamExternalDelivery}>;
  /** Delegates the existing project launcher. Opening/prefill never proves a running team task. */
  launchManual(input: {scope: TeamExternalScope; planId: string; operationId: string; title: string; prompt: string}): Promise<{
    native?: TeamExternalNativeRef; opened: boolean; instruction: 'not-sent' | 'unknown' | 'prefill-requested' | 'manual-transfer-ready';
  }>;
  probe(ref: TeamExternalRef): Promise<TeamExternalProbe>;
  read(plan: TeamExternalTargetPlan & {cursor?: string; limit: number}): Promise<{native: TeamExternalNativeRef; text: string; cursor?: string}>;
  submit(plan: TeamExternalTargetPlan & {text: string}): Promise<TeamExternalDelivery>;
  reveal(plan: TeamExternalTargetPlan): Promise<void>;
  close(plan: TeamExternalTargetPlan): Promise<{closed: boolean}>;
  /** Optional: a runtime without it refuses keys. One attempt per key, never a resend. */
  keys?(plan: TeamExternalTargetPlan & {keys: readonly WorkroomKey[]}): Promise<TeamExternalKeysDelivery>;
}
export class TeamExternalRuntimeError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new TeamExternalRuntimeError(code); };
const copy = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const submissionText = (text: string) => text.replace(/\r\n?/g, '\n').trim();
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const surfaceManaged = (surface: TeamExternalSurface) => surface === 'orca-floating' || surface === 'orca-worktree' || surface === 'cmux';
const scopeOf = (input: TeamExternalScope): TeamExternalScope => ({executionId: input.executionId, hostInstanceId: input.hostInstanceId, teamId: input.teamId, memberId: input.memberId, targetId: input.targetId, cwd: input.cwd, generation: input.generation, agent: input.agent, surface: input.surface});
function requestedOptions(requested: TeamExternalRequested): TeamExternalOption[] {
  return [
    ...(['model', 'provider', 'accountId', 'effort', 'bypassPermissions'] as const).filter(key => requested[key] !== undefined),
    ...(['bgMode', 'tmuxMode', 'reuse', 'appMode'] as const).filter(key => requested.launchOptions?.[key] !== undefined).map(key => `launchOptions.${key}` as const),
  ];
}
function validateInput(input: TeamExternalLaunchInput): TeamExternalLaunchInput {
  if (Object.keys(input).some(key => !['executionId', 'hostInstanceId', 'teamId', 'memberId', 'targetId', 'cwd', 'generation', 'agent', 'surface', 'operationId', 'requested', 'title', 'prompt'].includes(key))) fail('EXTERNAL_OPTIONS_INVALID');
  const scope = scopeOf(input);
  if (!['orca-floating', 'orca-worktree', 'cmux', 'iterm', 'terminal', 'powershell', 'wsl', 'app'].includes(scope.surface)
    || !['claude', 'codex', 'hermes', 'agy'].includes(scope.agent) || !Number.isSafeInteger(scope.generation) || scope.generation < 0) fail('EXTERNAL_SCOPE_INVALID');
  for (const value of [scope.executionId, scope.hostInstanceId, scope.teamId, scope.memberId, scope.targetId, scope.cwd, input.operationId, input.title]) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) fail('EXTERNAL_SCOPE_INVALID');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.includes('\0')) fail('EXTERNAL_PROMPT_INVALID');
  const requested = copy(input.requested);
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)
    || Object.keys(requested).some(key => !['model', 'provider', 'accountId', 'effort', 'bypassPermissions', 'launchOptions'].includes(key))) fail('EXTERNAL_OPTIONS_INVALID');
  for (const key of ['model', 'provider', 'accountId', 'effort'] as const) {
    if (requested[key] !== undefined && (typeof requested[key] !== 'string' || !requested[key] || /[\x00-\x1f\x7f]/.test(requested[key]!))) fail('EXTERNAL_OPTIONS_INVALID');
  }
  if (requested.bypassPermissions !== undefined && typeof requested.bypassPermissions !== 'boolean') fail('EXTERNAL_OPTIONS_INVALID');
  requested.bypassPermissions ??= false;
  if (requested.launchOptions !== undefined) {
    const options = requested.launchOptions;
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['bgMode', 'tmuxMode', 'reuse', 'appMode'].includes(key))
      || (options.bgMode !== undefined && typeof options.bgMode !== 'boolean') || (options.tmuxMode !== undefined && typeof options.tmuxMode !== 'boolean')
      || (options.reuse !== undefined && !['new', 'reuse-or-new'].includes(options.reuse)) || (options.appMode !== undefined && !['new', 'reopen', 'open'].includes(options.appMode))) fail('EXTERNAL_OPTIONS_INVALID');
  }
  return {...scope, operationId: input.operationId, requested, title: input.title, prompt: input.prompt};
}
function nativeMatchesScope(native: TeamExternalNativeRef, scope: TeamExternalScope): boolean {
  const keys = ['hostInstanceId', 'runtimeInstanceId', 'cwd', 'agent', 'owned', 'kind',
    ...(native.kind === 'orca' ? ['terminalHandle', 'worktreeId'] : native.kind === 'cmux' ? ['workspaceId', 'surfaceId'] : ['launcherId'])];
  const values = native as unknown as Record<string, unknown>;
  if (Object.keys(native).some(key => !keys.includes(key)) || typeof native.owned !== 'boolean'
    || keys.filter(key => key !== 'owned').some(key => typeof values[key] !== 'string' || !values[key] || /[\x00-\x1f\x7f]/.test(String(values[key])))) return false;
  return native.hostInstanceId === scope.hostInstanceId && !!native.runtimeInstanceId && native.cwd === scope.cwd && native.agent === scope.agent
    && (scope.surface === 'cmux' ? native.kind === 'cmux' : scope.surface.startsWith('orca-') ? native.kind === 'orca' : native.kind === 'manual')
    && (native.kind === 'orca' ? !!native.terminalHandle && !!native.worktreeId : native.kind === 'cmux' ? !!native.workspaceId && !!native.surfaceId : !!native.launcherId);
}
function target(ref: TeamExternalRef, operationId: string): TeamExternalTargetPlan {
  const native = ref.native;
  if (!native) return fail('EXTERNAL_BINDING_UNVERIFIED');
  const common = {operationId, executionRef: copy(ref)};
  return native.kind === 'orca' ? {...common, kind: 'orca-target', terminalHandle: native.terminalHandle}
    : native.kind === 'cmux' ? {...common, kind: 'cmux-target', workspaceId: native.workspaceId, surfaceId: native.surfaceId}
    : {...common, kind: 'manual-target', launcherId: native.launcherId};
}
/** A reserved operation survived a process restart or is in flight: expose uncertainty, never repeat its side effect. */
function receiptOf(record: TeamExternalJournalRecord): TeamExternalReceipt {
  const receipt = copy(record.receipt);
  if (record.operations.some(operation => operation.status === 'reserved')) {
    receipt.state = 'unknown'; receipt.retainWorktree = true; receipt.reason = 'EXTERNAL_OPERATION_PENDING';
    if (receipt.instruction.status === 'sending') receipt.instruction.status = 'unknown';
  }
  return receipt;
}

export function createTeamExternalRuntime(deps: TeamExternalRuntimeDeps) {
  async function load(ref: TeamExternalRef): Promise<TeamExternalJournalRecord> {
    const record = await deps.journal.read(ref.executionId);
    if (!record || !same(record.receipt.executionRef, ref)) return fail('EXTERNAL_BINDING_MISMATCH');
    return record;
  }
  const current = (scope: TeamExternalScope) => deps.isCurrent(copy(scopeOf(scope)));
  async function update(record: TeamExternalJournalRecord, mutate: (receipt: TeamExternalReceipt) => void): Promise<TeamExternalReceipt> {
    if (!current(record.receipt.executionRef)) return {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_GENERATION_STALE'};
    const next = copy(record); next.revision++; mutate(next.receipt);
    if (!await deps.journal.compareAndSet(next.receipt.executionRef.executionId, record.revision, next)) {
      const latest = await deps.journal.read(record.receipt.executionRef.executionId);
      return latest ? receiptOf(latest) : fail('EXTERNAL_JOURNAL_MISSING');
    }
    return receiptOf(next);
  }
  async function settle(record: TeamExternalJournalRecord, operationId: string, mutate: (receipt: TeamExternalReceipt) => void,
    outcome?: TeamExternalOperation['outcome'], reason?: TeamExternalDelivery['reason']): Promise<TeamExternalReceipt> {
    const next = copy(record); next.revision++;
    const operation = next.operations.find(item => item.id === operationId)!; operation.status = 'settled';
    if (operation.kind === 'reveal' || operation.kind === 'keys' || operation.kind === 'submit') operation.outcome = outcome ?? 'unknown';
    if (operation.kind === 'submit' && outcome === 'not-sent' && reason) operation.reason = reason;
    // Keep a late-created handle in this old execution's receipt for reconciliation; it cannot become the new generation.
    mutate(next.receipt);
    if (!current(next.receipt.executionRef)) {next.receipt.state = 'unknown'; next.receipt.reason = 'EXTERNAL_GENERATION_STALE'; next.receipt.retainWorktree = true;
      if (operation.kind === 'reveal' || operation.kind === 'keys' || operation.kind === 'submit') operation.outcome = 'unknown';
      if (operation.kind === 'submit') delete operation.reason;
      if (next.receipt.instruction.status === 'sending') next.receipt.instruction.status = 'unknown';}
    // A concurrent update wins; never replay a side effect to repair a failed persistence write.
    if (!await deps.journal.compareAndSet(next.receipt.executionRef.executionId, record.revision, next)) {
      const latest = await deps.journal.read(next.receipt.executionRef.executionId);
      return latest ? receiptOf(latest) : fail('EXTERNAL_JOURNAL_MISSING');
    }
    return receiptOf(next);
  }
  async function reserve(record: TeamExternalJournalRecord, id: string, kind: TeamExternalOperationKind, fingerprint: string): Promise<TeamExternalJournalRecord | null> {
    const previous = record.operations.find(operation => operation.id === id);
    if (previous && (previous.kind !== kind || previous.fingerprint !== fingerprint)) fail('EXTERNAL_OPERATION_CONFLICT');
    if (previous || record.operations.some(operation => operation.status === 'reserved')) return null;
    if (!current(record.receipt.executionRef)) fail('EXTERNAL_GENERATION_STALE');
    const next = copy(record); next.revision++; next.operations.push({id, kind, fingerprint, status: 'reserved'});
    if (kind === 'submit') next.receipt.instruction = {status: 'sending', operationId: id};
    return await deps.journal.compareAndSet(next.receipt.executionRef.executionId, record.revision, next) ? next : null;
  }
  async function verified(record: TeamExternalJournalRecord, requireAgent = true): Promise<TeamExternalProbe | null> {
    if (!current(record.receipt.executionRef) || !record.receipt.capabilities.probe || !record.receipt.executionRef.native) return null;
    try {
      const evidence = await deps.probe(copy(record.receipt.executionRef));
      return current(record.receipt.executionRef) && evidence.native !== null && evidence.connection === 'connected' && (!requireAgent || evidence.agentVerified) && evidence.activity !== 'exited'
        && same(evidence.native, record.receipt.executionRef.native) && nativeMatchesScope(evidence.native, record.receipt.executionRef) ? evidence : null;
    } catch {return null;}
  }
  async function launch(raw: TeamExternalLaunchInput): Promise<TeamExternalReceipt> {
    const input = validateInput(raw), scope = scopeOf(input), fingerprint = digest(input);
    const previous = await deps.journal.read(input.executionId);
    if (previous) {
      if (previous.launchFingerprint !== fingerprint) fail('EXTERNAL_LAUNCH_CONFLICT');
      return receiptOf(previous);
    }
    if (!current(scope)) fail('EXTERNAL_GENERATION_STALE');
    const receipt: TeamExternalReceipt = {version: 1, executionRef: {...scope, native: null}, state: 'starting', requested: input.requested, management: 'unresolved', agentVerified: null,
      applied: {}, capabilities: {...NO_CAPABILITIES}, capabilityRevision: null, instruction: {status: 'not-sent'}, retainWorktree: true, reason: null};
    let record: TeamExternalJournalRecord = {version: 1, revision: 1, launchFingerprint: fingerprint, initialInstructionFingerprint: digest(['submit', submissionText(input.prompt)]), receipt,
      operations: [{id: input.operationId, kind: 'launch', fingerprint, status: 'reserved'}]};
    if (!await deps.journal.compareAndSet(input.executionId, null, copy(record))) return launch(input);
    try {
      const plan = await deps.prepare(copy(input));
      if (!current(scope)) return settle(record, input.operationId, () => {});
      record = copy(record); record.revision++;
      record.receipt.capabilityRevision = plan.capabilityRevision; record.receipt.applied = copy(plan.applied);
      for (const option of requestedOptions(input.requested)) record.receipt.applied[option] ??= {mode: 'manual-settings', reason: 'HOST_OPTION_APPLICATION_UNVERIFIED'};
      record.receipt.capabilities = copy(plan.capabilities);
      const manualOptions = requestedOptions(input.requested).some(option => record.receipt.applied[option]?.mode !== 'automatic');
      const managed = plan.kind === 'managed' && surfaceManaged(scope.surface) && !manualOptions;
      record.receipt.management = plan.kind === 'awaiting-connection' ? 'awaiting-connection' : managed ? 'managed' : 'manual';
      if (!managed) record.receipt.capabilities.submit = false;
      if (managed && plan.initialPrompt === 'launch') record.receipt.instruction = {status: 'sending', operationId: input.operationId};
      if (!await deps.journal.compareAndSet(input.executionId, record.revision - 1, copy(record))) return receiptOf((await deps.journal.read(input.executionId))!);
      if (!current(scope)) return settle(record, input.operationId, () => {});
      if (plan.kind === 'awaiting-connection') return settle(record, input.operationId, value => {value.state = 'awaiting-connection'; value.reason = 'EXTERNAL_CONNECTION_REQUIRED';});
      // A managed callback must never silently launch a different account/model when its application is unverified.
      if (plan.kind === 'managed' && !managed || plan.kind === 'manual' && plan.readiness === 'needs-setup') {
        return settle(record, input.operationId, value => {value.state = 'awaiting-manual-join'; value.reason = plan.reason ?? (plan.kind === 'manual' ? 'EXTERNAL_SETUP_REQUIRED' : 'EXTERNAL_MANUAL_SETTINGS_REQUIRED');});
      }
      if (!managed) {
        const result = await deps.launchManual({scope, planId: plan.planId, operationId: input.operationId, title: input.title, prompt: input.prompt});
        return settle(record, input.operationId, value => {
          if (result.native && !nativeMatchesScope(result.native, scope)) {value.state = 'unknown'; value.reason = 'EXTERNAL_BINDING_MISMATCH'; return;}
          value.executionRef.native = copy(result.native ?? null); value.state = 'awaiting-manual-join';
          value.instruction = {status: result.instruction}; value.reason = plan.reason ?? (result.opened ? 'EXTERNAL_MANUAL_JOIN_REQUIRED' : 'EXTERNAL_SETUP_REQUIRED');
        });
      }
      const common = {operationId: input.operationId, scope, planId: plan.planId, title: input.title,
        ...(plan.kind === 'managed' && plan.initialPrompt === 'launch' ? {initialPrompt: input.prompt} : {})};
      const command: TeamExternalCreatePlan = scope.surface === 'cmux' ? {...common, kind: 'cmux-create'}
        : {...common, kind: 'orca-create', worktreeSelector: scope.surface === 'orca-floating' ? 'id:global-floating-terminal' : `path:${scope.cwd}`};
      const result = await deps.create(command);
      return settle(record, input.operationId, value => {
        if (!nativeMatchesScope(result.native, scope)) {value.state = 'unknown'; value.reason = 'EXTERNAL_BINDING_MISMATCH'; value.instruction.status = 'unknown'; return;}
        value.executionRef.native = copy(result.native);
        const delivery = common.initialPrompt === undefined ? {outcome: 'not-sent' as const} : result.delivery;
        value.instruction = {status: delivery.outcome, ...(common.initialPrompt !== undefined ? {operationId: input.operationId} : {})};
        value.state = delivery.outcome === 'unknown' ? 'unknown' : delivery.outcome === 'written' && delivery.turnStarted ? 'working' : 'awaiting-ack';
        value.reason = delivery.outcome === 'unknown' ? 'EXTERNAL_DELIVERY_UNKNOWN' : null;
      });
    } catch {
      return settle(record, input.operationId, value => {value.state = 'unknown'; value.reason = 'EXTERNAL_OUTCOME_UNKNOWN'; if (value.instruction.status === 'sending') value.instruction.status = 'unknown';});
    }
  }
  async function probe(ref: TeamExternalRef): Promise<TeamExternalReceipt> {
    const record = await load(ref);
    if (record.operations.some(operation => operation.status === 'reserved') || record.receipt.state === 'closed' || !record.receipt.capabilities.probe) return receiptOf(record);
    try {
      if (!current(ref)) return {...receiptOf(record), state: 'unknown', reason: 'EXTERNAL_GENERATION_STALE'};
      const evidence = await deps.probe(copy(ref));
      return update(record, value => {
        value.agentVerified = evidence.agentVerified;
        if (!ref.native) {
          value.state = value.management === 'awaiting-connection' ? 'awaiting-connection' : 'awaiting-manual-join';
          value.reason = evidence.connection === 'connected' ? 'EXTERNAL_CONNECTION_READY_REQUIRES_LAUNCH' : 'EXTERNAL_CONNECTION_REQUIRED';
        }
        else if (!evidence.native || !same(evidence.native, ref.native) || !nativeMatchesScope(evidence.native, ref)) {value.state = 'unknown'; value.reason = 'EXTERNAL_BINDING_UNVERIFIED';}
        else if (evidence.connection !== 'connected') {value.state = evidence.connection === 'missing' ? 'exited' : 'awaiting-connection'; value.reason = 'EXTERNAL_CONNECTION_REQUIRED';}
        else if (value.management === 'manual') {value.state = 'awaiting-manual-join'; value.reason = 'EXTERNAL_MANUAL_JOIN_REQUIRED';}
        else if (!evidence.agentVerified) {value.state = value.instruction.status === 'unknown' ? 'unknown' : 'awaiting-ack'; value.reason = 'EXTERNAL_AGENT_IDENTITY_UNVERIFIED';}
        else {
          value.reason = reasonAfterIdentityRecovery(value);
          if (evidence.activity === 'exited') value.state = 'exited';
          else if (value.instruction.status === 'written' && evidence.activity === 'working') value.state = 'working';
          else if (value.instruction.status === 'unknown') value.state = 'unknown';
          else value.state = 'awaiting-ack';
        }
      });
    } catch {return update(record, value => {value.state = 'unknown'; value.reason = 'EXTERNAL_PROBE_UNKNOWN';});}
  }
  async function read(ref: TeamExternalRef, options: {cursor?: string; limit?: number} = {}): Promise<TeamExternalReadResult> {
    const record = await load(ref);
    if (record.operations.some(operation => operation.status === 'reserved')) return {receipt: receiptOf(record), outcome: 'unconfirmed', text: ''};
    if (!current(ref)) return {receipt: {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_GENERATION_STALE'}, outcome: 'unconfirmed', text: ''};
    if (!record.receipt.capabilities.read) return {receipt: {...receiptOf(record), reason: 'EXTERNAL_CAPABILITY_UNAVAILABLE'}, outcome: 'unavailable', text: ''};
    const evidence = await verified(record, false);
    if (!evidence) return {receipt: {...receiptOf(record), state: 'unknown', agentVerified: false, reason: 'EXTERNAL_BINDING_UNVERIFIED'}, outcome: 'unconfirmed', text: ''};
    const readReceipt = (): TeamExternalReceipt => ({...receiptOf(record), agentVerified: evidence.agentVerified,
      ...(!evidence.agentVerified ? {state: record.receipt.instruction.status === 'unknown' ? 'unknown' : 'awaiting-ack', reason: 'EXTERNAL_AGENT_IDENTITY_UNVERIFIED'} as const
        : {reason: reasonAfterIdentityRecovery(record.receipt)})});
    const limit = Math.max(1, Math.min(20_000, Math.floor(Number.isFinite(options.limit) ? options.limit! : 4_000)));
    if (!current(ref)) return {receipt: {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_GENERATION_STALE'}, outcome: 'unconfirmed', text: ''};
    try {
      const result = await deps.read({...target(ref, 'read'), ...options, limit});
      if (!current(ref)) return {receipt: {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_GENERATION_STALE'}, outcome: 'unconfirmed', text: ''};
      if (!same(result.native, ref.native)) return {receipt: {...receiptOf(record), state: 'unknown', retainWorktree: true, agentVerified: false, reason: 'EXTERNAL_BINDING_UNVERIFIED'}, outcome: 'unconfirmed', text: ''};
      const latest = await load(ref);
      if (!current(ref)) return {receipt: {...receiptOf(latest), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_GENERATION_STALE'}, outcome: 'unconfirmed', text: ''};
      if (latest.revision !== record.revision) return {receipt: {...receiptOf(latest), reason: 'EXTERNAL_READ_SUPERSEDED'}, outcome: 'unconfirmed', text: ''};
      return {receipt: readReceipt(), outcome: 'read', text: result.text.slice(-limit), ...(result.cursor !== undefined ? {cursor: result.cursor} : {})};
    } catch {return {receipt: {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_READ_UNKNOWN'}, outcome: 'unconfirmed', text: ''};}
  }
  async function mutate(ref: TeamExternalRef, operationId: string, kind: 'submit' | 'reveal' | 'close', text?: string): Promise<TeamExternalReceipt> {
    if (typeof operationId !== 'string' || !operationId.trim() || /[\x00-\x1f\x7f]/.test(operationId)) fail('EXTERNAL_OPERATION_INVALID');
    if (kind === 'submit' && (typeof text !== 'string' || !text.trim() || text.includes('\0'))) fail('EXTERNAL_PROMPT_INVALID');
    const normalizedText = typeof text === 'string' ? submissionText(text) : undefined;
    const record = await load(ref), fingerprint = digest([kind, normalizedText ?? null]);
    const old = record.operations.find(operation => operation.id === operationId);
    if (old && (old.kind !== kind || old.fingerprint !== fingerprint)) fail('EXTERNAL_OPERATION_CONFLICT');
    if (old || record.operations.some(operation => operation.status === 'reserved') || record.receipt.state === 'closed') return receiptOf(record);
    // Closing again under a fresh ID does not resolve an uncertain earlier close. Reconcile through probe/manual review.
    if (kind === 'close' && record.operations.some(operation => operation.kind === 'close')) return receiptOf(record);
    if (kind === 'submit') {
      // An uncertain key may still change this terminal; no instruction may be typed until it is reconciled.
      // Older settled key records with no outcome are also unconfirmed, never evidence of a safe write.
      if (record.operations.some(operation => operation.kind === 'keys' && (operation.outcome === 'unknown' || operation.outcome === undefined)))
        return {...receiptOf(record), reason: 'EXTERNAL_KEYS_UNKNOWN'};
      const known = record.receipt.instruction.status;
      if (!surfaceManaged(ref.surface) || record.receipt.management !== 'managed' || !['awaiting-ack', 'working', 'blocked'].includes(record.receipt.state)
        || known !== 'not-sent' && known !== 'written') return receiptOf(record);
      // Public submit is an explicit new instruction. It never doubles as an implicit retry of the initial/previous brief.
      if (known === 'written' && (!record.initialInstructionFingerprint || record.initialInstructionFingerprint === fingerprint
        || record.operations.some(operation => operation.kind === 'submit' && operation.outcome !== 'not-sent' && operation.fingerprint === fingerprint))) return receiptOf(record);
    }
    if (kind === 'close' && !ref.native?.owned) return {...receiptOf(record), retainWorktree: true, reason: 'EXTERNAL_EXECUTION_NOT_OWNED'};
    const capability = kind === 'close' ? 'close' : kind;
    if (!record.receipt.capabilities[capability]) return {...receiptOf(record), retainWorktree: true, reason: 'EXTERNAL_CAPABILITY_UNAVAILABLE'};
    // Reveal of a plain app is allowed by its verified launcher binding, but never task submission/close without probe evidence.
    const evidence = kind === 'reveal' && ref.native?.kind === 'manual' && current(ref) ? null : await verified(record, kind !== 'reveal');
    if (!(kind === 'reveal' && ref.native?.kind === 'manual' && current(ref)) && !evidence) return {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_BINDING_UNVERIFIED'};
    const reserved = await reserve(record, operationId, kind, fingerprint);
    if (!reserved) return receiptOf((await deps.journal.read(ref.executionId))!);
    try {
      if (!current(ref)) return settle(reserved, operationId, () => {});
      const command = target(ref, operationId);
      if (kind === 'submit') {
        const delivery = await deps.submit({...command, text: normalizedText!});
        return settle(reserved, operationId, value => {
          // A refused write cannot erase the last successfully delivered instruction. The reserved operation still
          // prevents a retry with this ID from ever typing; a fresh request may be made after the screen is resolved.
          value.instruction = delivery.outcome === 'not-sent' ? copy(record.receipt.instruction) : {status: delivery.outcome, operationId};
          value.state = delivery.outcome === 'not-sent' ? record.receipt.state : delivery.outcome === 'unknown' ? 'unknown' : delivery.turnStarted ? 'working' : 'awaiting-ack';
          value.reason = delivery.outcome === 'unknown' ? 'EXTERNAL_DELIVERY_UNKNOWN' : delivery.reason ?? null;
        }, delivery.outcome === 'written' ? 'performed' : delivery.outcome, delivery.reason);
      }
      if (kind === 'reveal') {await deps.reveal(command); return settle(reserved, operationId, value => {
        if (evidence) {value.agentVerified = evidence.agentVerified; if (!evidence.agentVerified && value.state === 'working') {value.state = 'awaiting-ack'; value.reason = 'EXTERNAL_AGENT_IDENTITY_UNVERIFIED';}}
      }, 'performed');}
      const result = await deps.close(command);
      return settle(reserved, operationId, value => {value.state = result.closed ? 'closed' : 'unknown'; value.retainWorktree = !result.closed; value.reason = result.closed ? null : 'EXTERNAL_CLOSE_UNKNOWN';});
    } catch {return settle(reserved, operationId, value => {value.state = 'unknown'; value.reason = 'EXTERNAL_OUTCOME_UNKNOWN'; value.retainWorktree = true; if (kind === 'submit') value.instruction = {status: 'unknown', operationId};});}
  }
  /**
   * Allow-listed keys answering a one-time prompt (folder trust, setup, a selection) on a managed Orca worktree
   * member. Its requestId is the operation: a replay answers from the journal and never types again, an unknown
   * outcome is never resent, and keys never touch the instruction receipt. Only an agent-verified binding of this
   * member's own worktree is typed into — never a floating Orca terminal, a cmux surface or an unmanaged window.
   */
  async function keys(ref: TeamExternalRef, operationId: string, raw: readonly string[]): Promise<TeamExternalReceipt> {
    if (typeof operationId !== 'string' || !operationId.trim() || /[\x00-\x1f\x7f]/.test(operationId)) fail('EXTERNAL_OPERATION_INVALID');
    let names: WorkroomKey[] = [];
    try {names = normalizeWorkroomKeys(raw);} catch {fail('EXTERNAL_KEYS_INVALID');}
    const record = await load(ref), fingerprint = digest(['keys', names]);
    const old = record.operations.find(operation => operation.id === operationId);
    if (old && (old.kind !== 'keys' || old.fingerprint !== fingerprint)) fail('EXTERNAL_OPERATION_CONFLICT');
    if (old || record.operations.some(operation => operation.status === 'reserved') || record.receipt.state === 'closed') return receiptOf(record);
    const known = record.receipt.instruction.status;
    if (ref.surface !== 'orca-worktree' || ref.native?.kind !== 'orca' || record.receipt.management !== 'managed' || !record.receipt.capabilities.submit || !deps.keys
      || !['awaiting-ack', 'working', 'blocked'].includes(record.receipt.state) || known === 'sending' || known === 'unknown') return {...receiptOf(record), reason: 'EXTERNAL_KEYS_UNAVAILABLE'};
    const evidence = await verified(record);
    if (!evidence) return {...receiptOf(record), state: 'unknown', retainWorktree: true, reason: 'EXTERNAL_BINDING_UNVERIFIED'};
    const reserved = await reserve(record, operationId, 'keys', fingerprint);
    if (!reserved) return receiptOf((await deps.journal.read(ref.executionId))!);
    try {
      if (!current(ref)) return settle(reserved, operationId, () => {});
      const result = await deps.keys({...target(ref, operationId), keys: names});
      return settle(reserved, operationId, value => {
        // WOULD_EXIT may follow earlier typed keys (outcome unknown): the reason still says which key was withheld.
        if (result.outcome !== 'performed') value.reason = result.reason ?? (result.outcome === 'unknown' ? 'EXTERNAL_KEYS_UNKNOWN' : 'EXTERNAL_KEYS_NOT_SENT');
      }, result.outcome);
    } catch {return settle(reserved, operationId, value => {value.reason = 'EXTERNAL_KEYS_UNKNOWN'; value.retainWorktree = true;});}
  }
  return {launch, probe, read, keys,
    submit: (ref: TeamExternalRef, input: {operationId: string; text: string}) => mutate(ref, input.operationId, 'submit', input.text),
    reveal: (ref: TeamExternalRef, operationId: string) => mutate(ref, operationId, 'reveal'),
    closeOwned: (ref: TeamExternalRef, operationId: string) => mutate(ref, operationId, 'close'),
  };
}
export type TeamExternalRuntime = ReturnType<typeof createTeamExternalRuntime>;
