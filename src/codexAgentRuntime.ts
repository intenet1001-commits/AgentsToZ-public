import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

import {
  AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
  AGENT_RUNTIME_MAX_TEXT_LENGTH,
  normalizeAgentRuntimeModelId,
  type AgentTaskEvent,
  type AgentTaskExecutionMode,
} from './agentRuntimeProtocol';
import {
  assertCodexRuntimeExecutableIdentityCurrent,
  isCodexRuntimeExecutableIdentity,
  type CodexRuntimeExecutableIdentity,
} from './codexRuntimeExecutable';
import {
  CONVERSATION_HISTORY_MAX_MESSAGES,
  CONVERSATION_HISTORY_MAX_MESSAGE_BYTES,
  CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES,
  CONVERSATION_HISTORY_MAX_TURNS,
  type CodexConversationHistory,
  type CodexConversationHistoryMessage,
  type CodexConversationHistoryTurn,
} from './agentRuntimeConversationHistory';

export {
  CONVERSATION_HISTORY_MAX_MESSAGES,
  CONVERSATION_HISTORY_MAX_MESSAGE_BYTES,
  CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES,
  CONVERSATION_HISTORY_MAX_TURNS,
} from './agentRuntimeConversationHistory';
export type {
  CodexConversationHistory,
  CodexConversationHistoryMessage,
  CodexConversationHistoryTurn,
} from './agentRuntimeConversationHistory';

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;
const PROCESS_EXIT_GRACE_MS = 750;
const THREAD_UNSUBSCRIBE_TIMEOUT_MS = 250;
const COMPATIBILITY_PROBE_TIMEOUT_MS = 5_000;
const LIVE_CONVERSATION_CONTROL_TIMEOUT_MS = 5_000;
const MODEL_CATALOG_PAGE_LIMIT = 64;
const MODEL_CATALOG_MAX_MODELS = 64;
const MODEL_CATALOG_MAX_CURSOR_LENGTH = 4 * 1024;
const MODEL_ID_MAX_LENGTH = 128;
const MODEL_LABEL_MAX_LENGTH = 120;
const REASONING_EFFORT_MAX_LENGTH = 64;
const MODEL_MAX_REASONING_EFFORTS = 16;
const MAX_JSON_LINE_CHARS = 4 * 1024 * 1024;
const MAX_QUEUED_NOTIFICATIONS = 512;
const MAX_USER_INPUT_QUESTIONS = 3;
const MAX_USER_INPUT_OPTIONS = 3;
const USER_INPUT_HEADER_MAX_LENGTH = 80;
const USER_INPUT_QUESTION_MAX_LENGTH = 1_000;
const USER_INPUT_OPTION_LABEL_MAX_LENGTH = 120;
const USER_INPUT_OPTION_DESCRIPTION_MAX_LENGTH = 500;
const USER_INPUT_ANSWER_MAX_LENGTH = 1_000;
const FORBIDDEN_USER_INPUT_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// App-server provider IDs are opaque strings. Current local builds commonly
// return UUIDs, while the public protocol explicitly documents `thr_*` and
// `turn_*` forms. Persistent bindings accept only this bounded intersection;
// ephemeral task IDs stay UUID-fenced until their existing journal migrates.
const PERSISTENT_PROVIDER_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;
// `thread/read` item IDs are scoped to the provider turn and current Codex
// builds can return compact values such as `item-1`. They never cross the
// adapter boundary: the history projection hashes them into conversation-
// scoped public IDs. Keep their grammar strict without incorrectly applying
// the longer persistent thread/turn binding requirement.
const HISTORY_PROVIDER_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CHILD_ENV_EXACT_ALLOWLIST = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMP',
  'TEMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'CODEX_HOME',
]);

// The current embedded runtime exposes only Codex's sandboxed local file/shell tools. Each
// feature below can add a networked, UI-driving, plugin, hook, or delegated
// authority surface and is disabled at app-server bootstrap (before a thread
// exists). `--strict-config` makes renamed/removed safety knobs fail startup.
// The built-in local Code Mode host is intentionally left available because
// this embedded app-server uses it to provide its sandboxed command executor;
// remote code-mode URLs are never accepted from a task request.
const DISABLED_CODEX_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'computer_use',
  'default_mode_request_user_input',
  'deferred_executor',
  'deferred_tool_world_state',
  'enable_mcp_apps',
  'executor_capability_discovery',
  'external_agent_memory_import',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'plugin_sharing',
  'plugins',
  'psp',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'skill_mcp_dependency_install',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
] as const;

// A read-only conversation is intentionally tool-free. Read-only Seatbelt
// prevents writes but still permits read-only shell processes; a shell child
// could detach and outlive the app-server. Removing the shell tool (and its
// alternate backends/helpers) keeps this pre-containment mode conversational
// only. Writable project work stays behind the managed runtime gate.
const TOOL_FREE_CONVERSATION_DISABLED_CODEX_FEATURES = [
  'goals',
  'shell_snapshot',
  'shell_tool',
  'skill_search',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
] as const;

type JsonRecord = Record<string, unknown>;
type RpcId = number;

type DraftableCodexEvent = Extract<
  AgentTaskEvent,
  { type: 'task.progress' | 'task.artifact.summary' }
>;

type EventDraft<T> = T extends { type: infer TType; payload: infer TPayload }
  ? { type: TType; payload: TPayload }
  : never;

/**
 * A provider adapter emits only semantic payloads. The supervising journal owns
 * taskId, sequence allocation, timestamps, replay, and the terminal state.
 */
export type CodexAgentTaskEventDraft = EventDraft<DraftableCodexEvent>;

export type EmitCodexAgentTaskEventDraft = (
  draft: CodexAgentTaskEventDraft,
) => void | Promise<void>;

export interface CodexAgentProviderIds {
  threadId: string;
  turnId?: string;
}

/** Persist provider correlation before a turn can fail, time out, or be cancelled. */
export type BindCodexAgentProviderIds = (
  ids: CodexAgentProviderIds,
) => void | Promise<void>;

export type CodexAgentRuntimeErrorCode =
  | 'CODEX_TASK_INPUT_INVALID'
  | 'CODEX_DANGEROUS_MODE_UNAVAILABLE'
  | 'CODEX_APP_SERVER_UNAVAILABLE'
  | 'CODEX_APP_SERVER_PROTOCOL_FAILED'
  | 'CODEX_TASK_POLICY_UNVERIFIED'
  | 'CODEX_PROCESS_TERMINATION_UNCONFIRMED'
  | 'CODEX_TASK_APPROVAL_REQUIRED'
  | 'CODEX_TASK_SERVER_REQUEST_DENIED'
  | 'CODEX_CONTEXT_WINDOW_EXCEEDED'
  | 'CODEX_SESSION_BUDGET_EXCEEDED'
  | 'CODEX_USAGE_LIMIT_EXCEEDED'
  | 'CODEX_SERVER_OVERLOADED'
  | 'CODEX_POLICY_BLOCKED'
  | 'CODEX_PROVIDER_INTERNAL_ERROR'
  | 'CODEX_AUTH_REQUIRED'
  | 'CODEX_BAD_REQUEST'
  | 'CODEX_THREAD_ROLLBACK_FAILED'
  | 'CODEX_SANDBOX_ERROR'
  | 'CODEX_CONNECTION_FAILED'
  | 'CODEX_RESPONSE_STREAM_FAILED'
  | 'CODEX_RESPONSE_RETRY_EXHAUSTED'
  | 'CODEX_ACTIVE_TURN_NOT_STEERABLE'
  | 'CODEX_TASK_FAILED'
  | 'CODEX_TASK_INTERRUPTED'
  | 'CODEX_TASK_TIMEOUT'
  | 'CODEX_TASK_CANCELLED'
  | 'CODEX_TASK_EVENT_EMIT_FAILED'
  | 'CODEX_TASK_BINDING_FAILED'
  | 'CODEX_EXECUTABLE_CHANGED';

export class CodexAgentRuntimeError extends Error {
  constructor(
    readonly code: CodexAgentRuntimeErrorCode,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(publicMessage, options);
    this.name = 'CodexAgentRuntimeError';
  }
}

interface WritablePipe {
  write(chunk: string | Uint8Array): unknown;
  flush?(): unknown;
  end?(): unknown;
}

export interface CodexAgentAppServerProcess {
  /** Bun supplies this for real children; injected fakes may omit it. */
  pid?: number;
  stdin: WritablePipe;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): unknown;
  /** Internal durable ownership record, released only after PGID absence. */
  releaseGuardRecordAfterTermination?(): boolean | Promise<boolean>;
}

export type SpawnCodexAgentAppServer = (
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    detached: true;
  },
  /** Guard launchers must revalidate this proof inside their own process. */
  executableIdentity?: CodexRuntimeExecutableIdentity,
) => CodexAgentAppServerProcess;

/** Sidecar-owned boundary for descendant-first process-tree termination. */
export type TerminateCodexProcessTree = (
  child: CodexAgentAppServerProcess,
  signal: 'SIGTERM' | 'SIGKILL',
) => void | Promise<void>;

/** Must confirm the whole tree, not merely that the direct child was signalled. */
export type ConfirmCodexProcessTreeTerminated = (
  child: CodexAgentAppServerProcess,
  timeoutMs: number,
) => Promise<boolean>;

export interface RunCodexAgentTaskInput {
  /** Opaque supervisor-owned id. It is not sent as a filesystem value. */
  taskId: string;
  /** Caller-resolved absolute path to the real Codex executable, never a shell shim. */
  codexExecutable: string;
  /** Local-only identity proven by the executable resolver and compatibility probe. */
  codexExecutableIdentity: CodexRuntimeExecutableIdentity;
  /** Caller-validated, registered project or worktree directory. */
  cwd: string;
  /** Provider model resolved server-side from a live model catalog entry. */
  model: string;
  /** Catalog-advertised effort selected server-side for this exact model. */
  reasoningEffort: string;
  executionMode: AgentTaskExecutionMode;
  prompt: string;
  emit: EmitCodexAgentTaskEventDraft;
  /** Supervisor-owned durable binding; provider IDs never enter the public task DTO. */
  bindProviderIds: BindCodexAgentProviderIds;
  /** Cancels this task even when the supervisor does not own the child handle. */
  signal?: AbortSignal;
}

export interface CodexAgentTaskResult {
  threadId: string;
  turnId: string;
  finalSummary: string;
}

export type CodexConversationExecutionMode = AgentTaskExecutionMode | 'read-only';

export interface RunCodexConversationTurnInput
  extends Omit<RunCodexAgentTaskInput, 'taskId' | 'executionMode'> {
  executionMode: CodexConversationExecutionMode;
  /** AgentsToZ-owned durable conversation id. */
  conversationId: string;
  /** Null starts a retained provider thread; a value resumes that exact thread. */
  providerThreadId: string | null;
  /**
   * Registers controls bound to this exact app-server connection and turn.
   * Provider IDs remain private inside the closures and never cross the
   * AgentsToZ conversation protocol.
   */
  registerLiveControl?: (
    control: CodexConversationLiveControl,
  ) => void | (() => void);
  /**
   * Handles only Codex's bounded request_user_input tool. Approval and MCP
   * elicitation requests remain fail-closed on the provider boundary.
   */
  requestUserInput?: RequestCodexConversationUserInput;
}

export interface CodexConversationUserInputOption {
  label: string;
  description: string;
}

export interface CodexConversationUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: CodexConversationUserInputOption[] | null;
  allowOther: boolean;
}

export interface CodexConversationUserInputRequest {
  questions: CodexConversationUserInputQuestion[];
}

export interface CodexConversationUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export type RequestCodexConversationUserInput = (
  request: CodexConversationUserInputRequest,
) => Promise<CodexConversationUserInputResponse>;

export interface CodexConversationLiveControl {
  steer(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
}

export interface CodexConversationTurnResult extends CodexAgentTaskResult {
  resumed: boolean;
}

export interface InspectCodexConversationInput {
  codexExecutable: string;
  codexExecutableIdentity: CodexRuntimeExecutableIdentity;
  /** Private supervisor directory used only to launch the read-only app-server. */
  cwd: string;
  providerThreadId: string;
  executionMode?: CodexConversationExecutionMode;
  signal?: AbortSignal;
}

export interface CodexConversationInspection {
  status: 'idle' | 'active' | 'systemError';
}

export interface ReadCodexConversationHistoryInput extends InspectCodexConversationInput {
  /** AgentsToZ public identity used only to derive non-provider message keys. */
  conversationId: string;
}

export type CodexConversationMutation = 'archive' | 'unarchive' | 'delete';

export interface MutateCodexConversationInput extends InspectCodexConversationInput {
  action: CodexConversationMutation;
}

export interface CodexAgentRuntimeModel {
  /** Stable picker identity advertised by `model/list`. */
  modelId: string;
  /** Provider model value sent back to `thread/start` and `turn/start`. */
  providerModel: string;
  /** Internal launch value; never serialized as part of the public model picker. */
  reasoningEffort: string;
  label: string;
  isDefault: boolean;
}

export interface CodexAgentRuntimeInspection {
  models: CodexAgentRuntimeModel[];
}

interface InspectedCodexAgentRuntimeModel
  extends Omit<CodexAgentRuntimeModel, 'reasoningEffort'> {
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

export interface ProbeCodexAgentRuntimeInput {
  codexExecutable: string;
  /** Production supplies this; legacy diagnostic callers may omit it. */
  codexExecutableIdentity?: CodexRuntimeExecutableIdentity;
  /** Private, empty local directory controlled by the runtime supervisor. */
  cwd: string;
}

export interface CodexAgentRuntimeDependencies {
  spawn?: SpawnCodexAgentAppServer;
  /** Source-development host override; production defaults fail closed. */
  dangerousModeEnabled?: boolean;
  assertExecutableIdentityCurrent?: (
    identity: CodexRuntimeExecutableIdentity,
  ) => void;
  terminateProcessTree?: TerminateCodexProcessTree;
  confirmProcessTreeTerminated?: ConfirmCodexProcessTreeTerminated;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

interface NotificationWaiter {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

type CodexServerRequestHandler = (request: JsonRecord) => Promise<JsonRecord>;

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
);

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

function classifyCodexProcessGroupProbeError(
  cause: unknown,
): 'gone' | 'retry' | 'failed' {
  const code = asRecord(cause)?.code;
  if (code === 'ESRCH') return 'gone';
  if (code === 'EPERM') return 'retry';
  return 'failed';
}

/**
 * Deterministic process-group probe boundary. The optional collaborators keep
 * the retry/deadline behavior testable without signalling a real process.
 */
export async function confirmCodexProcessGroupTerminated(
  pid: number,
  timeoutMs: number,
  dependencies: {
    probe?: (processGroupId: number) => void;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const probe = dependencies.probe ?? (processGroupId => {
    process.kill(-processGroupId, 0);
  });
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      probe(pid);
    } catch (cause) {
      const disposition = classifyCodexProcessGroupProbeError(cause);
      if (disposition === 'gone') return true;
      if (disposition === 'failed') return false;
      // Darwin can briefly report EPERM while a detached process group is
      // being dismantled. That is neither proof of life nor proof that the
      // group is gone, so keep probing until ESRCH or the fail-closed deadline.
    }
    if (now() >= deadline) return false;
    await sleep(Math.min(25, Math.max(1, deadline - now())));
  }
}

/**
 * Builds the complete environment for the Codex child. This is an allowlist,
 * not a filter layered over the inherited environment: API keys, capability
 * tokens, SSH agents, proxy credentials, and app-side secrets never enter it.
 * Keys are canonicalized because Windows environment names are case-insensitive.
 */
export function codexAgentChildEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  const entries = Object.entries(source);
  for (const key of CHILD_ENV_EXACT_ALLOWLIST) {
    const canonical = source[key];
    if (typeof canonical === 'string') {
      allowed[key] = canonical;
      continue;
    }
    // Windows names are case-insensitive. Accept one unambiguous spelling,
    // while never letting a duplicate lower-case entry override a canonical
    // key on POSIX.
    const aliases = entries.filter(([rawKey, value]) => (
      rawKey !== key && rawKey.toUpperCase() === key && typeof value === 'string'
    ));
    if (aliases.length === 1) allowed[key] = aliases[0]![1]!;
  }
  return allowed;
}

function validateInspectedMcpServerNames(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 256
    || value.some(name => typeof name !== 'string' || !MCP_SERVER_NAME_RE.test(name))) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
    );
  }
  return [...new Set(value)].sort();
}

function mcpServerNamesFromConfigMap(value: unknown, label: string): string[] {
  const servers = asRecord(value);
  if (!servers) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
      new Error(`${label} is not a map.`),
    );
  }
  const names = Object.keys(servers);
  if (names.length > 256 || names.some(name => !MCP_SERVER_NAME_RE.test(name))) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
    );
  }
  for (const name of names) {
    if (!asRecord(servers[name])) {
      throw runtimeError(
        'CODEX_TASK_POLICY_UNVERIFIED',
        'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
      );
    }
  }
  return names;
}

/**
 * Reads the app-server's own effective config, including project layers for
 * this exact cwd. A separate `codex mcp list` process is not authoritative for
 * trusted project-local `.codex/config.toml` files and is deliberately unused.
 */
function effectiveMcpServerNames(configRead: JsonRecord): string[] {
  const config = asRecord(configRead.config);
  if (!config || !('mcp_servers' in config)) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
    );
  }
  const names = new Set(mcpServerNamesFromConfigMap(config.mcp_servers, 'effective mcp_servers'));
  const layers = configRead.layers;
  if (layers !== null && layers !== undefined) {
    if (!Array.isArray(layers) || layers.length > 64) {
      throw runtimeError(
        'CODEX_TASK_POLICY_UNVERIFIED',
        'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
      );
    }
    for (const layerValue of layers) {
      const layer = asRecord(layerValue);
      const layerConfig = asRecord(layer?.config);
      if (!layer || !layerConfig) {
        throw runtimeError(
          'CODEX_TASK_POLICY_UNVERIFIED',
          'Codex 외부 도구 설정을 안전하게 확인하지 못했습니다.',
        );
      }
      if (!('mcp_servers' in layerConfig)) continue;
      for (const name of mcpServerNamesFromConfigMap(
        layerConfig.mcp_servers,
        'layer mcp_servers',
      )) names.add(name);
    }
  }
  return validateInspectedMcpServerNames([...names]);
}

function disabledMcpThreadConfig(
  serverNames: readonly string[],
  reasoningEffort: string,
): JsonRecord {
  return {
    // Override an incompatible user-level setting before the thread exists.
    // `turn/start.effort` repeats this value at the provider boundary.
    model_reasoning_effort: reasoningEffort,
    mcp_servers: Object.fromEntries(serverNames.map(name => [name, { enabled: false }])),
  };
}

async function resolveEffectiveThreadConfig(
  rpc: CodexJsonLineRpc,
  cwd: string,
  deadline: number,
): Promise<{ mcpServerNames: string[]; configuredReasoningEffort: string | null }> {
  const configRead = await rpc.request('config/read', {
    cwd,
    includeLayers: true,
  }, deadline);
  const config = asRecord(configRead.config);
  return {
    mcpServerNames: effectiveMcpServerNames(configRead),
    configuredReasoningEffort: boundedReasoningEffort(config?.model_reasoning_effort),
  };
}

function boundedModelString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function boundedReasoningEffort(value: unknown): string | null {
  const effort = boundedModelString(value, REASONING_EFFORT_MAX_LENGTH);
  return effort && /^[A-Za-z][A-Za-z0-9_-]*$/.test(effort) ? effort : null;
}

function invalidModelCatalog(cause?: unknown): CodexAgentRuntimeError {
  return runtimeError(
    'CODEX_APP_SERVER_PROTOCOL_FAILED',
    'Codex 모델 목록을 안전하게 확인하지 못했습니다.',
    cause,
  );
}

function normalizeModelCatalogEntry(value: unknown): InspectedCodexAgentRuntimeModel {
  const entry = asRecord(value);
  const rawModelId = boundedModelString(entry?.id, MODEL_ID_MAX_LENGTH);
  const providerModel = boundedModelString(entry?.model, MODEL_ID_MAX_LENGTH);
  const label = boundedModelString(entry?.displayName, MODEL_LABEL_MAX_LENGTH);
  const defaultReasoningEffort = boundedReasoningEffort(entry?.defaultReasoningEffort);
  const rawSupportedReasoningEfforts = entry?.supportedReasoningEfforts;
  if (!entry
    || !rawModelId
    || !providerModel
    || !label
    || !defaultReasoningEffort
    || !Array.isArray(rawSupportedReasoningEfforts)
    || rawSupportedReasoningEfforts.length < 1
    || rawSupportedReasoningEfforts.length > MODEL_MAX_REASONING_EFFORTS
    || entry.hidden !== false
    || typeof entry.isDefault !== 'boolean') {
    throw invalidModelCatalog();
  }
  const supportedReasoningEfforts = rawSupportedReasoningEfforts.map(value => {
    const option = asRecord(value);
    const effort = boundedReasoningEffort(option?.reasoningEffort);
    if (!option || !effort || typeof option.description !== 'string') {
      throw invalidModelCatalog();
    }
    return effort;
  });
  if (new Set(supportedReasoningEfforts).size !== supportedReasoningEfforts.length
    || !supportedReasoningEfforts.includes(defaultReasoningEffort)) {
    throw invalidModelCatalog();
  }
  let modelId: string;
  try {
    modelId = normalizeAgentRuntimeModelId(rawModelId);
  } catch (cause) {
    throw invalidModelCatalog(cause);
  }
  return {
    modelId,
    providerModel,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    label,
    isDefault: entry.isDefault,
  };
}

function selectModelReasoningEfforts(
  models: readonly InspectedCodexAgentRuntimeModel[],
  configuredReasoningEffort: string | null,
): CodexAgentRuntimeModel[] {
  return models.map(({
    defaultReasoningEffort,
    supportedReasoningEfforts,
    ...model
  }) => ({
    ...model,
    reasoningEffort: configuredReasoningEffort
      && supportedReasoningEfforts.includes(configuredReasoningEffort)
      ? configuredReasoningEffort
      : defaultReasoningEffort,
  }));
}

/** Drains the visible picker catalog before publishing any part of it. */
async function inspectVisibleModelCatalog(
  rpc: CodexJsonLineRpc,
  deadline: number,
): Promise<InspectedCodexAgentRuntimeModel[]> {
  const models: InspectedCodexAgentRuntimeModel[] = [];
  const modelIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MODEL_CATALOG_PAGE_LIMIT; page += 1) {
    const response = await rpc.request('model/list', {
      cursor,
      includeHidden: false,
      limit: MODEL_CATALOG_MAX_MODELS,
    }, deadline);
    if (!Array.isArray(response.data)) throw invalidModelCatalog();
    for (const value of response.data) {
      const model = normalizeModelCatalogEntry(value);
      if (modelIds.has(model.modelId)) throw invalidModelCatalog();
      modelIds.add(model.modelId);
      models.push(model);
      if (models.length > MODEL_CATALOG_MAX_MODELS) throw invalidModelCatalog();
    }

    const nextCursor = response.nextCursor;
    if (nextCursor === null || nextCursor === undefined) {
      if (models.length === 0
        || models.filter(model => model.isDefault).length !== 1) {
        throw invalidModelCatalog();
      }
      return models;
    }
    if (typeof nextCursor !== 'string'
      || nextCursor.length > MODEL_CATALOG_MAX_CURSOR_LENGTH
      || nextCursor.includes('\u0000')
      || cursors.has(nextCursor)) {
      throw invalidModelCatalog();
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw invalidModelCatalog();
}

function sandboxPolicy(executionMode: CodexConversationExecutionMode): JsonRecord {
  if (executionMode === 'read-only') {
    return { type: 'readOnly' };
  }
  if (executionMode === 'dangerously-bypass-approvals-and-sandbox') {
    return { type: 'dangerFullAccess' };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function appServerCommand(
  input: {
    codexExecutable: string;
    executionMode: CodexConversationExecutionMode;
  },
  options: { requestUserInput?: boolean } = {},
): string[] {
  const command = [
    input.codexExecutable,
    'app-server',
    '--strict-config',
  ];
  for (const feature of DISABLED_CODEX_FEATURES) {
    if (feature === 'default_mode_request_user_input' && options.requestUserInput) continue;
    command.push('--disable', feature);
  }
  if (input.executionMode === 'read-only') {
    for (const feature of TOOL_FREE_CONVERSATION_DISABLED_CODEX_FEATURES) {
      command.push('--disable', feature);
    }
  }
  if (options.requestUserInput) command.push('--enable', 'default_mode_request_user_input');
  const overrides = [
    'approval_policy="never"',
    `sandbox_mode=${JSON.stringify(
      input.executionMode === 'dangerously-bypass-approvals-and-sandbox'
        ? 'danger-full-access'
        : input.executionMode,
    )}`,
    'allow_login_shell=false',
    ...(input.executionMode === 'read-only' ? [
      'skills.include_instructions=false',
      'include_collaboration_mode_instructions=false',
      'include_environment_context=false',
      'include_permissions_instructions=false',
    ] : []),
    'include_apps_instructions=false',
    // `notify` is a top-level executable hook, independent of the hooks
    // feature. OTEL can also export raw prompts when enabled in user config.
    // Neutralize both before any runtime prompt is submitted.
    'notify=[]',
    'analytics.enabled=false',
    'otel.log_user_prompt=false',
    'otel.exporter="none"',
    'otel.trace_exporter="none"',
    'otel.metrics_exporter="none"',
    'shell_environment_policy.inherit="none"',
    // A user's `[shell_environment_policy.set]` is applied even when inherit
    // is none. An include filter that cannot match any valid environment key
    // removes inherited *and* configured values before shell tools launch.
    'shell_environment_policy.filters={"__AGENTSTOZ_NO_MATCH__"="include"}',
    ...(input.executionMode === 'workspace-write' ? [
      'sandbox_workspace_write.writable_roots=[]',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      'sandbox_workspace_write.exclude_slash_tmp=true',
    ] : []),
    'tools.web_search=false',
    `tools.experimental_request_user_input.enabled=${options.requestUserInput ? 'true' : 'false'}`,
    'tools.update_plan.enabled=false',
  ];
  for (const override of overrides) command.push('-c', override);
  command.push('--listen', 'stdio://');
  return command;
}

function runtimeError(
  code: CodexAgentRuntimeErrorCode,
  publicMessage: string,
  cause?: unknown,
): CodexAgentRuntimeError {
  return new CodexAgentRuntimeError(code, publicMessage, cause === undefined ? undefined : { cause });
}

type CodexProviderFailureKind =
  | 'contextWindowExceeded'
  | 'sessionBudgetExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'cyberPolicy'
  | 'misalignmentPolicyViolation'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'httpConnectionFailed'
  | 'responseStreamConnectionFailed'
  | 'responseStreamDisconnected'
  | 'responseTooManyFailedAttempts'
  | 'activeTurnNotSteerable';

const CODEX_PROVIDER_FAILURES: Readonly<Record<
  CodexProviderFailureKind,
  { code: CodexAgentRuntimeErrorCode; message: string }
>> = Object.freeze({
  contextWindowExceeded: {
    code: 'CODEX_CONTEXT_WINDOW_EXCEEDED',
    message: 'Codex 컨텍스트 한도를 초과했습니다. 요청 범위를 줄이거나 작업을 나눠 다시 실행해 주세요.',
  },
  sessionBudgetExceeded: {
    code: 'CODEX_SESSION_BUDGET_EXCEEDED',
    message: 'Codex 세션 작업 한도를 초과했습니다. 작업을 나눠 새 작업으로 실행해 주세요.',
  },
  usageLimitExceeded: {
    code: 'CODEX_USAGE_LIMIT_EXCEEDED',
    message: 'Codex 사용량 한도에 도달했습니다. 사용량이 갱신된 뒤 다시 실행해 주세요.',
  },
  serverOverloaded: {
    code: 'CODEX_SERVER_OVERLOADED',
    message: 'Codex 서버가 혼잡합니다. 잠시 후 다시 실행해 주세요.',
  },
  cyberPolicy: {
    code: 'CODEX_POLICY_BLOCKED',
    message: 'Codex 정책에 의해 요청이 중단되었습니다. 요청 범위나 내용을 조정해 주세요.',
  },
  misalignmentPolicyViolation: {
    code: 'CODEX_POLICY_BLOCKED',
    message: 'Codex 정책에 의해 요청이 중단되었습니다. 요청 범위나 내용을 조정해 주세요.',
  },
  internalServerError: {
    code: 'CODEX_PROVIDER_INTERNAL_ERROR',
    message: 'Codex 서버 내부 오류로 작업이 중단되었습니다. 잠시 후 다시 실행해 주세요.',
  },
  unauthorized: {
    code: 'CODEX_AUTH_REQUIRED',
    message: 'Codex 인증이 만료되었거나 권한이 없습니다. Codex 로그인을 확인해 주세요.',
  },
  badRequest: {
    code: 'CODEX_BAD_REQUEST',
    message: 'Codex가 작업 요청을 거절했습니다. 선택한 모델과 요청 내용을 확인해 주세요.',
  },
  threadRollbackFailed: {
    code: 'CODEX_THREAD_ROLLBACK_FAILED',
    message: 'Codex 작업 상태를 되돌리지 못했습니다. 새 작업으로 다시 실행해 주세요.',
  },
  sandboxError: {
    code: 'CODEX_SANDBOX_ERROR',
    message: 'Codex 샌드박스 실행에 실패했습니다. 프로젝트 권한과 실행 모드를 확인해 주세요.',
  },
  httpConnectionFailed: {
    code: 'CODEX_CONNECTION_FAILED',
    message: 'Codex 서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 실행해 주세요.',
  },
  responseStreamConnectionFailed: {
    code: 'CODEX_RESPONSE_STREAM_FAILED',
    message: 'Codex 응답 연결을 시작하지 못했습니다. 잠시 후 다시 실행해 주세요.',
  },
  responseStreamDisconnected: {
    code: 'CODEX_RESPONSE_STREAM_FAILED',
    message: 'Codex 응답 연결이 작업 중 끊겼습니다. 잠시 후 다시 실행해 주세요.',
  },
  responseTooManyFailedAttempts: {
    code: 'CODEX_RESPONSE_RETRY_EXHAUSTED',
    message: 'Codex 응답 재시도 한도를 초과했습니다. 잠시 후 다시 실행해 주세요.',
  },
  activeTurnNotSteerable: {
    code: 'CODEX_ACTIVE_TURN_NOT_STEERABLE',
    message: 'Codex가 현재 작업을 이어서 처리할 수 없습니다. 새 작업으로 다시 실행해 주세요.',
  },
});

function codexProviderFailureKind(value: unknown): CodexProviderFailureKind | null {
  if (typeof value === 'string' && Object.hasOwn(CODEX_PROVIDER_FAILURES, value)) {
    return value as CodexProviderFailureKind;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  if (keys.length !== 1 || !asRecord(record[keys[0]!])) return null;
  const key = keys[0]!;
  return Object.hasOwn(CODEX_PROVIDER_FAILURES, key) ? key as CodexProviderFailureKind : null;
}

/**
 * Translate only the app-server's stable `codexErrorInfo` discriminator. Raw
 * provider messages and additional details may contain prompts, paths, or
 * credentials, so they are deliberately neither retained nor emitted.
 */
function sanitizedCodexProviderFailure(value: unknown): CodexAgentRuntimeError {
  const providerError = asRecord(value);
  const kind = codexProviderFailureKind(providerError?.codexErrorInfo);
  if (!kind) {
    return runtimeError('CODEX_TASK_FAILED', 'Codex가 작업을 완료하지 못했습니다.');
  }
  const failure = CODEX_PROVIDER_FAILURES[kind];
  return runtimeError(failure.code, failure.message);
}

function timeoutError(): CodexAgentRuntimeError {
  return runtimeError(
    'CODEX_TASK_TIMEOUT',
    'Codex 작업 실행 시간이 초과되었습니다.',
  );
}

function cancellationError(): CodexAgentRuntimeError {
  return runtimeError(
    'CODEX_TASK_CANCELLED',
    'Codex 작업이 취소되었습니다.',
  );
}

async function bindProviderIds(
  input: Pick<RunCodexAgentTaskInput, 'bindProviderIds'>,
  ids: CodexAgentProviderIds,
): Promise<void> {
  try {
    await input.bindProviderIds(ids);
  } catch (cause) {
    throw runtimeError(
      'CODEX_TASK_BINDING_FAILED',
      'Codex 실행 식별자를 안전하게 기록하지 못했습니다.',
      cause,
    );
  }
}

const defaultTerminateProcessTree: TerminateCodexProcessTree = async (child, signal) => {
  const pid = child.pid;
  if (Number.isSafeInteger(pid) && Number(pid) > 1 && process.platform !== 'win32') {
    try {
      // The app-server is spawned detached, so its wrapper and native child
      // share a task-owned process group rather than the sidecar's group.
      process.kill(-Number(pid), signal);
      return;
    } catch (cause) {
      const code = asRecord(cause)?.code;
      if (code === 'ESRCH') return;
      throw cause;
    }
  }
  if (Number.isSafeInteger(pid) && Number(pid) > 1 && process.platform === 'win32') {
    const result = Bun.spawnSync([
      'taskkill.exe',
      '/PID',
      String(pid),
      '/T',
      ...(signal === 'SIGKILL' ? ['/F'] : []),
    ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: PROCESS_EXIT_GRACE_MS });
    if (result.exitCode === 0) return;
  }
  // Fakes and unusual runtimes may not expose a PID. Production sidecars
  // should inject their descendant-aware reaper rather than rely on this
  // leader-only compatibility fallback.
  child.kill(signal);
};

const defaultConfirmProcessTreeTerminated: ConfirmCodexProcessTreeTerminated = async (
  child,
  timeoutMs,
) => {
  const pid = child.pid;
  if (Number.isSafeInteger(pid) && Number(pid) > 1 && process.platform !== 'win32') {
    return confirmCodexProcessGroupTerminated(Number(pid), timeoutMs);
  }
  return Promise.race([
    child.exited.then(() => true, () => true),
    wait(Math.max(0, timeoutMs)).then(() => false),
  ]);
};

class CodexJsonLineRpc {
  #nextId = 1;
  #pending = new Map<RpcId, PendingRequest>();
  #notifications: JsonRecord[] = [];
  #notificationWaiter: NotificationWaiter | null = null;
  #failure: Error | null = null;
  #closing = false;
  #serverRequestHandler: CodexServerRequestHandler | null = null;
  #activeServerRequest: string | null = null;
  #termRequest: Promise<void> | null = null;
  #killRequest: Promise<void> | null = null;
  readonly #stdoutPump: Promise<void>;
  readonly #stderrPump: Promise<void>;

  constructor(
    readonly process: CodexAgentAppServerProcess,
    readonly terminateProcessTree: TerminateCodexProcessTree,
    readonly confirmProcessTreeTerminated: ConfirmCodexProcessTreeTerminated,
  ) {
    this.#stdoutPump = this.#readStdout();
    this.#stderrPump = this.#drainStderr();
    void process.exited.then(
      () => {
        if (!this.#closing) this.#fail(runtimeError(
          'CODEX_APP_SERVER_UNAVAILABLE',
          'Codex 작업 서버가 완료 전에 종료되었습니다.',
        ));
      },
      (cause) => {
        if (!this.#closing) this.#fail(runtimeError(
          'CODEX_APP_SERVER_UNAVAILABLE',
          'Codex 작업 서버 상태를 확인하지 못했습니다.',
          cause,
        ));
      },
    );
  }

  async request(method: string, params: JsonRecord, deadline: number): Promise<JsonRecord> {
    if (this.#failure) throw this.#failure;
    if (this.#closing) throw runtimeError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex 작업 서버 연결이 닫혔습니다.',
    );
    const id = this.#nextId++;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.#write({ method, id, params });
      return await this.#until(response, deadline);
    } finally {
      this.#pending.delete(id);
    }
  }

  notify(method: string, params: JsonRecord): void {
    this.#write({ method, params });
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    if (this.#serverRequestHandler) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버의 사용자 응답 연결이 이미 등록되었습니다.',
      );
    }
    this.#serverRequestHandler = handler;
  }

  async nextNotification(deadline: number): Promise<JsonRecord> {
    if (this.#failure) throw this.#failure;
    const queued = this.#notifications.shift();
    if (queued) return queued;
    if (this.#notificationWaiter) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버 알림을 동시에 기다릴 수 없습니다.',
      );
    }
    let waiter: NotificationWaiter | null = null;
    const notification = new Promise<JsonRecord>((resolve, reject) => {
      waiter = { resolve, reject };
      this.#notificationWaiter = waiter;
    });
    try {
      return await this.#until(notification, deadline);
    } finally {
      if (this.#notificationWaiter === waiter) this.#notificationWaiter = null;
    }
  }

  abort(error = cancellationError()): void {
    if (this.#closing) return;
    this.#fail(error);
    // Abort is deliberately a descendant-tree signal, not an app-server RPC
    // that could itself wait for provider interaction.
    void this.#requestTreeTermination('SIGTERM');
    try { this.process.stdin.end?.(); } catch { /* stdin may already be closed */ }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    try { this.process.stdin.end?.(); } catch { /* stdin may already be closed */ }
    let terminated = await this.#confirmTreeTermination(PROCESS_EXIT_GRACE_MS);
    if (!terminated) {
      await this.#requestTreeTermination('SIGTERM');
      terminated = await this.#confirmTreeTermination(PROCESS_EXIT_GRACE_MS);
    }
    if (!terminated) {
      await this.#requestTreeTermination('SIGKILL');
      terminated = await this.#confirmTreeTermination(PROCESS_EXIT_GRACE_MS);
    }
    await Promise.race([
      Promise.allSettled([this.#stdoutPump, this.#stderrPump]).then(() => undefined),
      wait(PROCESS_EXIT_GRACE_MS),
    ]);
    if (!terminated) {
      throw runtimeError(
        'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
        'Codex 작업 프로세스 종료를 확인하지 못했습니다.',
      );
    }
    if (this.process.releaseGuardRecordAfterTermination
      && await this.process.releaseGuardRecordAfterTermination() !== true) {
      throw runtimeError(
        'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
        'Codex 작업 프로세스의 영속 실행 소유권을 안전하게 해제하지 못했습니다.',
      );
    }
  }

  async #requestTreeTermination(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const previous = signal === 'SIGTERM' ? this.#termRequest : this.#killRequest;
    if (previous) return previous;
    const requested = Promise.resolve()
      .then(() => this.terminateProcessTree(this.process, signal))
      .catch(() => undefined);
    if (signal === 'SIGTERM') this.#termRequest = requested;
    else this.#killRequest = requested;
    await requested;
  }

  async #confirmTreeTermination(timeoutMs: number): Promise<boolean> {
    try {
      return await this.confirmProcessTreeTerminated(this.process, timeoutMs) === true;
    } catch {
      return false;
    }
  }

  async #until<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #write(message: JsonRecord): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
      this.process.stdin.flush?.();
    } catch (cause) {
      const failure = runtimeError(
        'CODEX_APP_SERVER_UNAVAILABLE',
        'Codex 작업 서버에 요청을 보내지 못했습니다.',
        cause,
      );
      this.#fail(failure);
      throw failure;
    }
  }

  async #readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const acceptBufferedLines = (): void => {
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.#acceptLine(line);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_JSON_LINE_CHARS) {
        this.#fail(runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 작업 서버 응답이 허용 크기를 초과했습니다.',
        ));
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          acceptBufferedLines();
        }
        if (done) {
          buffer += decoder.decode();
          acceptBufferedLines();
          break;
        }
      }
      if (buffer.trim()) this.#acceptLine(buffer.trim());
      if (!this.#closing) this.#fail(runtimeError(
        'CODEX_APP_SERVER_UNAVAILABLE',
        'Codex 작업 서버 연결이 예기치 않게 종료되었습니다.',
      ));
    } catch (cause) {
      if (!this.#closing) this.#fail(runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버 응답을 읽지 못했습니다.',
        cause,
      ));
    } finally {
      reader.releaseLock();
    }
  }

  async #drainStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // stderr may contain local paths, commands, and credentials. It is
        // drained for backpressure but is never retained or emitted.
      }
    } catch { /* stdout and process exit own the typed failure */ }
    finally { reader.releaseLock(); }
  }

  #acceptLine(line: string): void {
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(line)) ?? (() => { throw new Error('not an object'); })();
    } catch (cause) {
      this.#fail(runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버가 올바르지 않은 응답을 보냈습니다.',
        cause,
      ));
      return;
    }

    if (typeof message.id === 'number' && typeof message.method !== 'string') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (asRecord(message.error)) {
        pending.reject(runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 작업 서버가 요청을 거절했습니다.',
        ));
        return;
      }
      pending.resolve(asRecord(message.result) ?? {});
      return;
    }

    // Server requests are denied unless the retained-conversation path has
    // installed one exact request_user_input handler. Approval, MCP
    // elicitation, auth refresh, and dynamic tools never reach that handler.
    if (message.id !== undefined && typeof message.method === 'string') {
      if (message.method === 'item/tool/requestUserInput' && this.#serverRequestHandler) {
        const id = message.id;
        const requestKey = typeof id === 'number' && Number.isSafeInteger(id)
          ? `number:${id}`
          : typeof id === 'string' && id.length > 0 && id.length <= 256 && !id.includes('\u0000')
            ? `string:${id}`
            : null;
        if (!requestKey || this.#activeServerRequest) {
          this.abort(runtimeError(
            'CODEX_APP_SERVER_PROTOCOL_FAILED',
            'Codex 사용자 질문 요청 식별자나 동시성 경계가 올바르지 않습니다.',
          ));
          return;
        }
        this.#activeServerRequest = requestKey;
        void this.#serverRequestHandler(message).then(result => {
          if (this.#activeServerRequest !== requestKey || this.#closing || this.#failure) return;
          this.#activeServerRequest = null;
          this.#write({ id, result });
        }).catch(cause => {
          if (this.#activeServerRequest === requestKey) this.#activeServerRequest = null;
          this.abort(cause instanceof CodexAgentRuntimeError
            ? cause
            : runtimeError(
              'CODEX_TASK_SERVER_REQUEST_DENIED',
              'Codex 사용자 질문에 안전하게 응답하지 못했습니다.',
              cause,
            ));
        });
        return;
      }
      const approval = /requestApproval|Approval|requestUserInput|elicitation/i.test(message.method);
      this.abort(runtimeError(
        approval ? 'CODEX_TASK_APPROVAL_REQUIRED' : 'CODEX_TASK_SERVER_REQUEST_DENIED',
        approval
          ? 'Codex 작업이 사용자 승인이나 응답을 요구해 안전하게 중단되었습니다.'
          : 'Codex 작업 서버가 지원하지 않는 상호작용을 요청해 안전하게 중단되었습니다.',
      ));
      return;
    }

    if (typeof message.method !== 'string') {
      this.#fail(runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버 알림 형식이 올바르지 않습니다.',
      ));
      return;
    }
    const waiter = this.#notificationWaiter;
    if (waiter) {
      this.#notificationWaiter = null;
      waiter.resolve(message);
      return;
    }
    this.#notifications.push(message);
    if (this.#notifications.length > MAX_QUEUED_NOTIFICATIONS) {
      this.#fail(runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버 알림이 처리 한도를 초과했습니다.',
      ));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#notificationWaiter?.reject(error);
    this.#notificationWaiter = null;
  }
}

interface NotificationContext {
  threadId: string;
  turnId: string;
  cwd: string;
  latestAgentMessage: string;
  emittedDiffSummary: boolean;
}

type NormalizedNotification =
  | { drafts: CodexAgentTaskEventDraft[]; terminal: null }
  | {
      drafts: CodexAgentTaskEventDraft[];
      terminal: { status: 'completed'; finalSummary: string };
    }
  | {
      drafts: CodexAgentTaskEventDraft[];
      terminal: { status: 'failed'; error: CodexAgentRuntimeError };
    };

function belongsToTurn(params: JsonRecord, context: NotificationContext): boolean {
  return params.threadId === context.threadId && params.turnId === context.turnId;
}

function safeSemanticSummary(value: unknown, cwd: string): string {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (cwd) text = text.split(cwd).join('[프로젝트]');
  // Do not expose another absolute local root if the model mentions one in its
  // final prose. Project-relative references remain useful.
  text = text
    .replace(/\bfile:\/\/\/?[^\s<>"'`]+/gi, '[로컬 경로]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s<>"'`]+/g, '[로컬 경로]')
    .replace(/(^|[\s("'`:=])\/(?!\/)[^\s<>"'`)]+/g, '$1[로컬 경로]')
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, '[비밀정보 삭제]')
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi, '[비밀정보 삭제]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/@]+@[^\s<>"'`]+/gi, '[비밀정보 삭제]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s<>"'`]+/gi, '[비밀정보 삭제]')
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[비밀정보 삭제]')
    .replace(/([?&](?:access_token|api_key|apikey|password|passwd|secret)=)[^&\s#]+/gi, '$1[비밀정보 삭제]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [비밀정보 삭제]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[비밀정보 삭제]')
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{12,}\b/g, '[비밀정보 삭제]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[비밀정보 삭제]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}\b/g, '[비밀정보 삭제]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[비밀정보 삭제]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[비밀정보 삭제]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [비밀정보 삭제]')
    .trim();
  if (!text) return '';
  return text.slice(0, AGENT_RUNTIME_MAX_TEXT_LENGTH);
}

function exactObjectKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function boundedQuestionText(
  value: unknown,
  maxLength: number,
  cwd: string,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || value.includes('\u0000')) {
    throw runtimeError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex 사용자 질문 내용이 올바르지 않습니다.',
    );
  }
  const safe = safeSemanticSummary(value, cwd);
  if (!safe) {
    throw runtimeError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex 사용자 질문 내용을 안전하게 표시할 수 없습니다.',
    );
  }
  return safe.slice(0, maxLength);
}

interface NormalizedCodexConversationUserInput {
  request: CodexConversationUserInputRequest;
  optionsByQuestion: Map<string, Set<string>>;
}

function normalizeCodexConversationUserInputRequest(
  message: JsonRecord,
  context: Pick<NotificationContext, 'threadId' | 'turnId' | 'cwd'>,
): NormalizedCodexConversationUserInput {
  const params = asRecord(message.params);
  if (message.method !== 'item/tool/requestUserInput'
    || !params
    || !exactObjectKeys(params, [
      'autoResolutionMs', 'isBlocking', 'itemId', 'questions', 'threadId', 'turnId',
    ].filter(key => key !== 'autoResolutionMs' || Object.hasOwn(params, key)))
    || params.threadId !== context.threadId
    || params.turnId !== context.turnId
    || params.isBlocking !== true
    || (params.autoResolutionMs !== undefined && params.autoResolutionMs !== null)
    || typeof params.itemId !== 'string'
    || !PERSISTENT_PROVIDER_ID_RE.test(params.itemId)
    || !Array.isArray(params.questions)
    || params.questions.length < 1
    || params.questions.length > MAX_USER_INPUT_QUESTIONS) {
    throw runtimeError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex 사용자 질문 요청이 활성 대화와 일치하지 않습니다.',
    );
  }

  const ids = new Set<string>();
  const optionsByQuestion = new Map<string, Set<string>>();
  const questions = params.questions.map(value => {
    const raw = asRecord(value);
    const allowedKeys = ['header', 'id', 'isOther', 'isSecret', 'options', 'question'];
    if (!raw
      || Object.keys(raw).some(key => !allowedKeys.includes(key))
      || typeof raw.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)
      || FORBIDDEN_USER_INPUT_IDS.has(raw.id)
      || ids.has(raw.id)
      || (raw.isSecret !== undefined && raw.isSecret !== false)
      || (raw.isOther !== undefined && typeof raw.isOther !== 'boolean')) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 사용자 질문 항목이 올바르지 않습니다.',
      );
    }
    ids.add(raw.id);
    const rawOptions = raw.options === undefined || raw.options === null ? null : raw.options;
    if (rawOptions !== null
      && (!Array.isArray(rawOptions)
        || rawOptions.length < 2
        || rawOptions.length > MAX_USER_INPUT_OPTIONS)
      || (rawOptions === null && raw.isOther !== true)) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 사용자 질문 선택지가 올바르지 않습니다.',
      );
    }
    const optionLabels = new Set<string>();
    const options = rawOptions?.map(value => {
      const option = asRecord(value);
      if (!option || !exactObjectKeys(option, ['description', 'label'])) {
        throw runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 사용자 질문 선택지가 올바르지 않습니다.',
        );
      }
      const label = boundedQuestionText(
        option.label,
        USER_INPUT_OPTION_LABEL_MAX_LENGTH,
        context.cwd,
      );
      // Answers must map back to the provider's exact option string. Reject a
      // label that would require redaction rather than exposing or guessing it.
      if (label !== String(option.label).trim() || optionLabels.has(label)) {
        throw runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 사용자 질문 선택지를 안전하게 연결할 수 없습니다.',
        );
      }
      optionLabels.add(label);
      return {
        label,
        description: boundedQuestionText(
          option.description,
          USER_INPUT_OPTION_DESCRIPTION_MAX_LENGTH,
          context.cwd,
        ),
      };
    }) ?? null;
    optionsByQuestion.set(raw.id, optionLabels);
    return {
      id: raw.id,
      header: boundedQuestionText(raw.header, USER_INPUT_HEADER_MAX_LENGTH, context.cwd),
      question: boundedQuestionText(raw.question, USER_INPUT_QUESTION_MAX_LENGTH, context.cwd),
      options,
      allowOther: raw.isOther === true,
    };
  });
  return { request: { questions }, optionsByQuestion };
}

function normalizeCodexConversationUserInputResponse(
  value: unknown,
  normalized: NormalizedCodexConversationUserInput,
): JsonRecord {
  const response = asRecord(value);
  const answers = asRecord(response?.answers);
  const questionIds = normalized.request.questions.map(question => question.id).sort();
  if (!response || !exactObjectKeys(response, ['answers']) || !answers
    || Object.keys(answers).sort().join('\u0000') !== questionIds.join('\u0000')) {
    throw runtimeError(
      'CODEX_TASK_SERVER_REQUEST_DENIED',
      'Codex 사용자 질문 답변이 요청과 일치하지 않습니다.',
    );
  }
  const providerAnswers: Record<string, { answers: string[] }> = {};
  for (const question of normalized.request.questions) {
    const entry = asRecord(answers[question.id]);
    if (!entry || !exactObjectKeys(entry, ['answers'])
      || !Array.isArray(entry.answers) || entry.answers.length !== 1) {
      throw runtimeError(
        'CODEX_TASK_SERVER_REQUEST_DENIED',
        'Codex 사용자 질문에는 항목별 답변 하나가 필요합니다.',
      );
    }
    const answer = entry.answers[0];
    if (typeof answer !== 'string' || !answer.trim()
      || answer.length > USER_INPUT_ANSWER_MAX_LENGTH || answer.includes('\u0000')) {
      throw runtimeError(
        'CODEX_TASK_SERVER_REQUEST_DENIED',
        'Codex 사용자 질문 답변이 올바르지 않습니다.',
      );
    }
    const optionLabels = normalized.optionsByQuestion.get(question.id)!;
    if (optionLabels.size > 0 && !optionLabels.has(answer) && !question.allowOther) {
      throw runtimeError(
        'CODEX_TASK_SERVER_REQUEST_DENIED',
        'Codex 사용자 질문 답변이 허용된 선택지와 일치하지 않습니다.',
      );
    }
    providerAnswers[question.id] = { answers: [answer] };
  }
  return { answers: providerAnswers };
}

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}

function publicConversationHistoryId(
  kind: 'turn' | 'message',
  conversationId: string,
  providerIdValue: string,
): string {
  const digest = createHash('sha256')
    .update(`${kind}\u0000${conversationId}\u0000${providerIdValue}`)
    .digest('hex')
    .slice(0, 32);
  return `${kind}_${digest}`;
}

function redactConversationProviderIds(value: string, providerIds: ReadonlySet<string>): string {
  let redacted = value;
  // Longest-first avoids exposing a suffix when one internal id prefixes another.
  for (const providerId of [...providerIds].sort((left, right) => right.length - left.length)) {
    if (providerId && redacted.includes(providerId)) {
      redacted = redacted.split(providerId).join('[내부 ID]');
    }
  }
  return redacted;
}

function providerTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw runtimeError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex 대화 기록 시간이 올바르지 않습니다.',
    );
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw runtimeError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex 대화 기록 시간이 올바르지 않습니다.',
    );
  }
  return date.toISOString();
}

function validateThreadStartResponse(
  started: JsonRecord,
  cwd: string,
  model: string,
  reasoningEffort: string,
  executionMode: AgentTaskExecutionMode = 'workspace-write',
): string {
  const thread = asRecord(started.thread);
  const sandbox = asRecord(started.sandbox);
  const runtimeWorkspaceRoots = started.runtimeWorkspaceRoots;
  const writableRoots = sandbox?.writableRoots;
  const sandboxKeys = sandbox ? Object.keys(sandbox).sort() : [];
  const expectedWorkspaceSandboxKeys = [
    'excludeSlashTmp',
    'excludeTmpdirEnvVar',
    'networkAccess',
    'type',
    'writableRoots',
  ].sort();
  const safeWritableRoots = Array.isArray(writableRoots)
    && writableRoots.every(root => root === cwd)
    && new Set(writableRoots).size === writableRoots.length;
  const reflectedSandboxSafe = executionMode === 'dangerously-bypass-approvals-and-sandbox'
    ? sandboxKeys.length === 1 && sandboxKeys[0] === 'type' && sandbox?.type === 'dangerFullAccess'
    : sandboxKeys.length === expectedWorkspaceSandboxKeys.length
      && sandboxKeys.every((key, index) => key === expectedWorkspaceSandboxKeys[index])
      && sandbox?.type === 'workspaceWrite'
      && sandbox.networkAccess === false
      && sandbox.excludeTmpdirEnvVar === true
      && sandbox.excludeSlashTmp === true
      && safeWritableRoots;
  const safePolicy = started.cwd === cwd
    && started.model === model
    && started.reasoningEffort === reasoningEffort
    && thread?.cwd === cwd
    && thread?.ephemeral === true
    && started.approvalPolicy === 'never'
    && started.approvalsReviewer === 'user'
    && Array.isArray(runtimeWorkspaceRoots)
    && runtimeWorkspaceRoots.length === 1
    && runtimeWorkspaceRoots[0] === cwd
    && reflectedSandboxSafe;
  const threadId = typeof thread?.id === 'string' ? thread.id : '';
  if (!safePolicy || !UUID_RE.test(threadId)) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 작업 서버의 격리 정책을 확인하지 못했습니다.',
    );
  }
  return threadId;
}

function validatePersistentThreadResponse(
  value: JsonRecord,
  expectedThreadId: string | null,
): string {
  const thread = asRecord(value.thread);
  const threadId = typeof thread?.id === 'string' ? thread.id : '';
  if (!PERSISTENT_PROVIDER_ID_RE.test(threadId)
    || thread?.ephemeral !== false
    || (expectedThreadId !== null && threadId !== expectedThreadId)) {
    throw runtimeError(
      'CODEX_TASK_POLICY_UNVERIFIED',
      'Codex 지속형 대화의 저장 정책을 확인하지 못했습니다.',
    );
  }
  return threadId;
}

function agentMessageText(item: JsonRecord, cwd: string): string {
  return item.type === 'agentMessage' ? safeSemanticSummary(item.text, cwd) : '';
}

function completedTurnSummary(
  turn: JsonRecord,
  context: NotificationContext,
): string {
  const items = Array.isArray(turn.items) ? turn.items.map(asRecord).filter(Boolean) as JsonRecord[] : [];
  const messages = items
    .filter(item => item.type === 'agentMessage')
    .map(item => ({
      text: agentMessageText(item, context.cwd),
      final: item.phase === 'final_answer',
    }))
    .filter(message => !!message.text);
  return [...messages].reverse().find(message => message.final)?.text
    ?? messages.at(-1)?.text
    ?? context.latestAgentMessage
    ?? 'Codex 작업이 완료되었습니다.';
}

function itemProgress(type: unknown, completed: boolean): CodexAgentTaskEventDraft | null {
  const suffix = completed ? '완료했습니다.' : '시작했습니다.';
  switch (type) {
    case 'reasoning':
      return { type: 'task.progress', payload: { summary: '작업 방향을 검토하고 있습니다.', phase: 'reasoning' } };
    case 'plan':
      return { type: 'task.progress', payload: { summary: `작업 계획 확인을 ${suffix}`, phase: 'planning' } };
    case 'commandExecution':
      return completed
        ? null
        : { type: 'task.progress', payload: { summary: '실행 단계를 시작했습니다.', phase: 'execution' } };
    case 'fileChange':
      return completed
        ? null
        : { type: 'task.progress', payload: { summary: '변경 사항을 준비하고 있습니다.', phase: 'editing' } };
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return completed
        ? null
        : { type: 'task.progress', payload: { summary: '도구 작업을 시작했습니다.', phase: 'tool' } };
    default:
      return null;
  }
}

function itemArtifact(item: JsonRecord): CodexAgentTaskEventDraft | null {
  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      type: 'task.artifact.summary',
      payload: {
        kind: 'diff',
        label: '변경 사항',
        summary: count > 0 ? `파일 변경 ${count}건을 처리했습니다.` : '파일 변경 단계를 처리했습니다.',
      },
    };
  }
  if (item.type === 'commandExecution') {
    const succeeded = item.status === 'completed';
    return {
      type: 'task.artifact.summary',
      payload: {
        kind: 'other',
        label: '실행 단계',
        summary: succeeded ? '실행 단계를 완료했습니다.' : '실행 단계가 완료되지 않았습니다.',
      },
    };
  }
  if (
    item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch'
  ) {
    return {
      type: 'task.artifact.summary',
      payload: { kind: 'other', label: '도구 작업', summary: '도구 작업을 처리했습니다.' },
    };
  }
  return null;
}

function normalizeNotification(
  message: JsonRecord,
  context: NotificationContext,
): NormalizedNotification {
  const params = asRecord(message.params);
  if (!params) return { drafts: [], terminal: null };

  if (message.method === 'turn/started') {
    const turn = asRecord(params.turn);
    if (params.threadId !== context.threadId || turn?.id !== context.turnId) {
      return { drafts: [], terminal: null };
    }
    return {
      drafts: [{
        type: 'task.progress',
        payload: { summary: 'Codex가 작업을 시작했습니다.', phase: 'running' },
      }],
      terminal: null,
    };
  }

  if (message.method === 'turn/plan/updated' && belongsToTurn(params, context)) {
    const plan = Array.isArray(params.plan) ? params.plan.map(asRecord).filter(Boolean) as JsonRecord[] : [];
    const completed = plan.filter(step => step.status === 'completed').length;
    return {
      drafts: [{
        type: 'task.progress',
        payload: {
          summary: plan.length > 0
            ? `작업 계획을 갱신했습니다. (${completed}/${plan.length})`
            : '작업 계획을 갱신했습니다.',
          phase: 'planning',
        },
      }],
      terminal: null,
    };
  }

  if (message.method === 'turn/diff/updated' && belongsToTurn(params, context)) {
    if (context.emittedDiffSummary) return { drafts: [], terminal: null };
    context.emittedDiffSummary = true;
    return {
      drafts: [{
        type: 'task.artifact.summary',
        payload: { kind: 'diff', label: '변경 사항', summary: '작업 변경 사항이 갱신되었습니다.' },
      }],
      terminal: null,
    };
  }

  if ((message.method === 'item/started' || message.method === 'item/completed')
    && belongsToTurn(params, context)) {
    const item = asRecord(params.item);
    if (!item) return { drafts: [], terminal: null };
    if (item.type === 'mcpToolCall'
      || item.type === 'dynamicToolCall'
      || item.type === 'collabAgentToolCall'
      || item.type === 'webSearch') {
      return {
        drafts: [],
        terminal: {
          status: 'failed',
          error: runtimeError(
            'CODEX_TASK_POLICY_UNVERIFIED',
            '허용되지 않은 외부 도구 실행이 감지되어 Codex 작업을 중단했습니다.',
          ),
        },
      };
    }
    const text = agentMessageText(item, context.cwd);
    if (text) context.latestAgentMessage = text;
    const completed = message.method === 'item/completed';
    const drafts = [
      itemProgress(item.type, completed),
      completed ? itemArtifact(item) : null,
    ].filter((draft): draft is CodexAgentTaskEventDraft => draft !== null);
    return { drafts, terminal: null };
  }

  if (message.method === 'error' && belongsToTurn(params, context)) {
    if (params.willRetry === true) {
      return {
        drafts: [{
          type: 'task.progress',
          payload: { summary: 'Codex가 일시적인 오류에서 복구를 시도하고 있습니다.', phase: 'retrying' },
        }],
        terminal: null,
      };
    }
    return {
      drafts: [],
      terminal: {
        status: 'failed',
        error: sanitizedCodexProviderFailure(params.error),
      },
    };
  }

  if (message.method !== 'turn/completed') return { drafts: [], terminal: null };
  const turn = asRecord(params.turn);
  if (params.threadId !== context.threadId || turn?.id !== context.turnId) {
    return { drafts: [], terminal: null };
  }
  if (turn.status === 'completed') {
    return {
      drafts: [],
      terminal: {
        status: 'completed',
        finalSummary: completedTurnSummary(turn, context),
      },
    };
  }
  return {
    drafts: [],
    terminal: {
      status: 'failed',
      error: turn.status === 'interrupted'
        ? runtimeError('CODEX_TASK_INTERRUPTED', 'Codex 작업이 완료 전에 중단되었습니다.')
        : sanitizedCodexProviderFailure(turn.error),
    },
  };
}

const TOOL_FREE_CONVERSATION_ITEM_TYPES = new Set([
  'agentMessage',
  'contextCompaction',
  'plan',
  'reasoning',
  'userMessage',
]);

function violatesToolFreeConversation(
  message: JsonRecord,
  context: NotificationContext,
): boolean {
  const params = asRecord(message.params);
  if (!params || !belongsToTurn(params, context)) return false;
  if (message.method === 'turn/diff/updated') return true;
  if (message.method !== 'item/started' && message.method !== 'item/completed') return false;
  const item = asRecord(params.item);
  return !item || typeof item.type !== 'string' || !TOOL_FREE_CONVERSATION_ITEM_TYPES.has(item.type);
}

function validateInput(
  input: Omit<RunCodexAgentTaskInput, 'executionMode'> & {
    executionMode: CodexConversationExecutionMode;
  },
  allowReadOnly = false,
  dangerousModeEnabled: boolean = AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
): void {
  if (!TASK_ID_RE.test(input.taskId)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 작업 ID가 올바르지 않습니다.');
  }
  if (!input.codexExecutable || !isAbsolute(input.codexExecutable)
    || /[\u0000\r\n]/.test(input.codexExecutable)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', '검증된 Codex 실행 파일이 필요합니다.');
  }
  if (!isCodexRuntimeExecutableIdentity(input.codexExecutableIdentity)
    || input.codexExecutableIdentity.path !== input.codexExecutable) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 실행 파일 identity가 올바르지 않습니다.');
  }
  if (!input.cwd || !isAbsolute(input.cwd) || /[\u0000\r\n]/.test(input.cwd)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', '검증된 프로젝트 작업 폴더가 필요합니다.');
  }
  if (!boundedModelString(input.model, MODEL_ID_MAX_LENGTH)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', '검증된 Codex 모델이 필요합니다.');
  }
  if (!boundedReasoningEffort(input.reasoningEffort)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', '검증된 Codex 추론 강도가 필요합니다.');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.includes('\u0000')
    || new TextEncoder().encode(input.prompt).byteLength > AGENT_RUNTIME_MAX_PROMPT_BYTES) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 작업 요청이 올바르지 않습니다.');
  }
  if (typeof input.emit !== 'function') {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 작업 이벤트 수신기가 필요합니다.');
  }
  if (typeof input.bindProviderIds !== 'function') {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 실행 식별자 기록기가 필요합니다.');
  }
  if ((!allowReadOnly || input.executionMode !== 'read-only')
    && input.executionMode !== 'workspace-write'
    && input.executionMode !== 'dangerously-bypass-approvals-and-sandbox') {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 작업 권한 모드가 올바르지 않습니다.');
  }
  if (!dangerousModeEnabled
    && input.executionMode === 'dangerously-bypass-approvals-and-sandbox') {
    throw runtimeError(
      'CODEX_DANGEROUS_MODE_UNAVAILABLE',
      '전체 접근 Codex 작업은 안전한 OS 프로세스 격리가 마련된 뒤 사용할 수 있습니다.',
    );
  }
}

function validateProbeInput(input: ProbeCodexAgentRuntimeInput): void {
  if (!input.codexExecutable || !isAbsolute(input.codexExecutable)
    || /[\u0000\r\n]/.test(input.codexExecutable)
    || !input.cwd || !isAbsolute(input.cwd) || /[\u0000\r\n]/.test(input.cwd)) {
    throw runtimeError(
      'CODEX_TASK_INPUT_INVALID',
      '검증된 Codex 실행 파일과 probe 폴더가 필요합니다.',
    );
  }
  if (input.codexExecutableIdentity !== undefined
    && (!isCodexRuntimeExecutableIdentity(input.codexExecutableIdentity)
      || input.codexExecutableIdentity.path !== input.codexExecutable)) {
    throw runtimeError(
      'CODEX_TASK_INPUT_INVALID',
      'Codex probe 실행 파일 identity가 올바르지 않습니다.',
    );
  }
}

function assertExecutableIdentityCurrent(
  identity: CodexRuntimeExecutableIdentity,
  dependencies: CodexAgentRuntimeDependencies,
): void {
  try {
    (dependencies.assertExecutableIdentityCurrent
      ?? assertCodexRuntimeExecutableIdentityCurrent)(identity);
  } catch (cause) {
    throw runtimeError(
      'CODEX_EXECUTABLE_CHANGED',
      '검증한 뒤 Codex 실행 파일이 변경되어 작업을 시작하지 않았습니다.',
      cause,
    );
  }
}

export interface CodexAgentTaskFailure {
  code: CodexAgentRuntimeErrorCode;
  message: string;
  retryable: boolean;
}

/** Safe terminal payload mapping; the supervising service owns journal finality. */
export function codexAgentTaskFailure(cause: unknown): CodexAgentTaskFailure {
  const error = asRuntimeError(cause);
  const retryableCodes: ReadonlySet<CodexAgentRuntimeErrorCode> = new Set([
    'CODEX_APP_SERVER_UNAVAILABLE',
    'CODEX_TASK_TIMEOUT',
    'CODEX_TASK_INTERRUPTED',
    'CODEX_USAGE_LIMIT_EXCEEDED',
    'CODEX_SERVER_OVERLOADED',
    'CODEX_PROVIDER_INTERNAL_ERROR',
    'CODEX_THREAD_ROLLBACK_FAILED',
    'CODEX_CONNECTION_FAILED',
    'CODEX_RESPONSE_STREAM_FAILED',
    'CODEX_RESPONSE_RETRY_EXHAUSTED',
    'CODEX_ACTIVE_TURN_NOT_STEERABLE',
    'CODEX_EXECUTABLE_CHANGED',
  ]);
  return {
    code: error.code,
    message: error.publicMessage,
    retryable: retryableCodes.has(error.code),
  };
}

/**
 * Performs a no-turn live contract inspection against the exact executable
 * and effective user configuration. No catalog is returned unless the full
 * visible picker inventory, safety bootstrap, and guarded cleanup all pass.
 */
export async function inspectCodexAgentRuntimeCompatibility(
  input: ProbeCodexAgentRuntimeInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<CodexAgentRuntimeInspection> {
  validateProbeInput(input);
  if (input.codexExecutableIdentity) {
    assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);
  }
  const childEnv = codexAgentChildEnv();

  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    child = spawn(appServerCommand({
      codexExecutable: input.codexExecutable,
      executionMode: 'workspace-write',
    }), {
      cwd: input.cwd,
      env: childEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex 작업 서버를 시작하지 못했습니다.',
      cause,
    );
  }

  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(
    1,
    Math.min(COMPATIBILITY_PROBE_TIMEOUT_MS, dependencies.timeoutMs ?? COMPATIBILITY_PROBE_TIMEOUT_MS),
  );
  let inspection: CodexAgentRuntimeInspection | null = null;
  let failure: unknown;
  let failed = false;
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs_probe',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});
    const inspectedModels = await inspectVisibleModelCatalog(rpc, deadline);
    const effectiveConfig = await resolveEffectiveThreadConfig(
      rpc,
      input.cwd,
      deadline,
    );
    const models = selectModelReasoningEfforts(
      inspectedModels,
      effectiveConfig.configuredReasoningEffort,
    );
    const defaultModel = models.find(model => model.isDefault)!;
    const started = await rpc.request('thread/start', {
      cwd: input.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      model: defaultModel.providerModel,
      ephemeral: true,
      serviceName: 'agentstoz_bycs',
      threadSource: 'agentstoz_capability_probe',
      config: disabledMcpThreadConfig(
        effectiveConfig.mcpServerNames,
        defaultModel.reasoningEffort,
      ),
    }, deadline);
    const threadId = validateThreadStartResponse(
      started,
      input.cwd,
      defaultModel.providerModel,
      defaultModel.reasoningEffort,
      'workspace-write',
    );
    inspection = { models };
    await rpc.request(
      'thread/unsubscribe',
      { threadId },
      Date.now() + THREAD_UNSUBSCRIBE_TIMEOUT_MS,
    ).catch(() => ({}));
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    try {
      await rpc.close();
    } catch (cause) {
      failed = true;
      failure = cause;
    }
  }
  if (!failed && input.codexExecutableIdentity) {
    assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);
  }
  if (failed) throw failure;
  if (!inspection) throw invalidModelCatalog();
  return inspection;
}

/** Backward-compatible availability wrapper for callers that need a boolean. */
export async function probeCodexAgentRuntimeCompatibility(
  input: ProbeCodexAgentRuntimeInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<boolean> {
  validateProbeInput(input);
  try {
    await inspectCodexAgentRuntimeCompatibility(input, dependencies);
    return true;
  } catch {
    return false;
  }
}

function asRuntimeError(cause: unknown): CodexAgentRuntimeError {
  if (cause instanceof CodexAgentRuntimeError) return cause;
  return runtimeError(
    'CODEX_TASK_FAILED',
    'Codex 작업을 완료하지 못했습니다.',
    cause,
  );
}

/**
 * Runs exactly one semantic Codex task through the JSON-line app-server RPC.
 * No shell is involved, raw stdout/stderr/tool output is never emitted, and
 * every provider interaction request fails closed under the current `never` policy.
 */
export async function runCodexAgentTask(
  input: RunCodexAgentTaskInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<CodexAgentTaskResult> {
  validateInput(
    input,
    false,
    dependencies.dangerousModeEnabled ?? AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
  );
  if (input.signal?.aborted) throw cancellationError();
  // Keep this synchronous and immediately adjacent to array-argv spawn. It
  // rehashes the exact native binary selected by the compatibility probe.
  assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);

  const childEnv = codexAgentChildEnv();

  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    // Array argv is an intentional security boundary: neither prompt nor cwd is
    // interpolated into a shell string.
    child = spawn(appServerCommand(input), {
      cwd: input.cwd,
      env: childEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex 작업 서버를 시작하지 못했습니다.',
      cause,
    );
  }

  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(1, dependencies.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
  let providerCompleted = false;
  const emit = async (draft: CodexAgentTaskEventDraft): Promise<void> => {
    if (input.signal?.aborted && !providerCompleted) throw cancellationError();
    try {
      await input.emit(draft);
    } catch (cause) {
      throw runtimeError(
        'CODEX_TASK_EVENT_EMIT_FAILED',
        'Codex 작업 상태를 안전하게 기록하지 못했습니다.',
        cause,
      );
    }
  };
  const abort = (): void => { rpc.abort(cancellationError()); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});

    const effectiveConfig = await resolveEffectiveThreadConfig(
      rpc,
      input.cwd,
      deadline,
    );

    const started = await rpc.request('thread/start', {
      cwd: input.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: input.model,
      sandbox: input.executionMode === 'dangerously-bypass-approvals-and-sandbox'
        ? 'danger-full-access'
        : 'workspace-write',
      // This runtime has no provider-thread resume/delete product surface. Do not leave
      // raw prompts and tool output in Codex's durable session store.
      ephemeral: true,
      serviceName: 'agentstoz_bycs',
      threadSource: 'agentstoz_task_runtime',
      config: disabledMcpThreadConfig(
        effectiveConfig.mcpServerNames,
        input.reasoningEffort,
      ),
    }, deadline);
    const threadId = validateThreadStartResponse(
      started,
      input.cwd,
      input.model,
      input.reasoningEffort,
      input.executionMode,
    );
    await bindProviderIds(input, { threadId });

    const turnStarted = await rpc.request('turn/start', {
      threadId,
      model: input.model,
      effort: input.reasoningEffort,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: sandboxPolicy(input.executionMode),
    }, deadline);
    const turn = asRecord(turnStarted.turn);
    const turnId = typeof turn?.id === 'string' ? turn.id : '';
    if (!UUID_RE.test(turnId)) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 작업 서버가 올바른 실행 ID를 반환하지 않았습니다.',
      );
    }
    await bindProviderIds(input, { threadId, turnId });

    const context: NotificationContext = {
      threadId,
      turnId,
      cwd: input.cwd,
      latestAgentMessage: '',
      emittedDiffSummary: false,
    };
    while (true) {
      const normalized = normalizeNotification(await rpc.nextNotification(deadline), context);
      for (const draft of normalized.drafts) await emit(draft);
      if (!normalized.terminal) continue;
      if (normalized.terminal.status === 'failed') throw normalized.terminal.error;

      providerCompleted = true;
      const finalSummary = normalized.terminal.finalSummary;
      // Unsubscribe is hygiene for an already-ephemeral thread, not part of
      // task success. A provider that stops replying here must not hold the
      // workspace or make shutdown wait for the remaining task deadline.
      await rpc.request(
        'thread/unsubscribe',
        { threadId },
        Date.now() + THREAD_UNSUBSCRIBE_TIMEOUT_MS,
      ).catch(() => ({}));
      return { threadId, turnId, finalSummary };
    }
  } catch (cause) {
    throw asRuntimeError(cause);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}

/**
 * Runs one turn in a retained Codex thread. It intentionally uses a fresh
 * app-server process per turn: conversation durability belongs to Codex's
 * rollout, while AgentsToZ retains only the opaque/private thread binding.
 * Live steer/interrupt is owned by the later session coordinator.
 */
export async function runCodexConversationTurn(
  input: RunCodexConversationTurnInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<CodexConversationTurnResult> {
  validateInput({ ...input, taskId: input.conversationId }, true);
  if (input.requestUserInput !== undefined && typeof input.requestUserInput !== 'function') {
    throw runtimeError(
      'CODEX_TASK_INPUT_INVALID',
      'Codex 사용자 질문 연결기가 올바르지 않습니다.',
    );
  }
  if (input.providerThreadId !== null && !PERSISTENT_PROVIDER_ID_RE.test(input.providerThreadId)) {
    throw runtimeError(
      'CODEX_TASK_INPUT_INVALID',
      'Codex 지속형 대화 식별자가 올바르지 않습니다.',
    );
  }
  if (input.signal?.aborted) throw cancellationError();
  assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);

  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    child = spawn(appServerCommand(input, {
      requestUserInput: typeof input.requestUserInput === 'function',
    }), {
      cwd: input.cwd,
      env: codexAgentChildEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex 지속형 대화 서버를 시작하지 못했습니다.',
      cause,
    );
  }

  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(1, dependencies.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
  let providerCompleted = false;
  let detachLiveControl: (() => void) | undefined;
  let liveControlActive = false;
  const emit = async (draft: CodexAgentTaskEventDraft): Promise<void> => {
    if (input.signal?.aborted && !providerCompleted) throw cancellationError();
    try {
      await input.emit(draft);
    } catch (cause) {
      throw runtimeError(
        'CODEX_TASK_EVENT_EMIT_FAILED',
        'Codex 지속형 대화 상태를 안전하게 기록하지 못했습니다.',
        cause,
      );
    }
  };
  const abort = (): void => { rpc.abort(cancellationError()); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs_conversation',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});
    const effectiveConfig = await resolveEffectiveThreadConfig(rpc, input.cwd, deadline);
    const threadConfig = disabledMcpThreadConfig(
      effectiveConfig.mcpServerNames,
      input.reasoningEffort,
    );
    const resumed = input.providerThreadId !== null;
    const opened = resumed
      ? await rpc.request('thread/resume', {
        threadId: input.providerThreadId,
        cwd: input.cwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        model: input.model,
        sandbox: input.executionMode === 'dangerously-bypass-approvals-and-sandbox'
          ? 'danger-full-access'
          : input.executionMode,
        config: threadConfig,
      }, deadline)
      : await rpc.request('thread/start', {
        cwd: input.cwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        model: input.model,
        sandbox: input.executionMode === 'dangerously-bypass-approvals-and-sandbox'
          ? 'danger-full-access'
          : input.executionMode,
        ephemeral: false,
        serviceName: 'agentstoz_bycs',
        threadSource: 'agentstoz_conversation_runtime',
        config: threadConfig,
      }, deadline);
    const threadId = validatePersistentThreadResponse(opened, input.providerThreadId);
    await bindProviderIds(input, { threadId });

    let resolveQuestionContext: (
      context: Pick<NotificationContext, 'threadId' | 'turnId' | 'cwd'>,
    ) => void = () => {};
    const questionContext = new Promise<Pick<NotificationContext, 'threadId' | 'turnId' | 'cwd'>>(
      resolve => { resolveQuestionContext = resolve; },
    );
    if (input.requestUserInput) {
      rpc.setServerRequestHandler(async message => {
        const context = await questionContext;
        const normalized = normalizeCodexConversationUserInputRequest(message, context);
        const response = await input.requestUserInput!(normalized.request);
        return normalizeCodexConversationUserInputResponse(response, normalized);
      });
    }

    const turnStarted = await rpc.request('turn/start', {
      threadId,
      model: input.model,
      effort: input.reasoningEffort,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: sandboxPolicy(input.executionMode),
    }, deadline);
    const turn = asRecord(turnStarted.turn);
    const turnId = typeof turn?.id === 'string' ? turn.id : '';
    if (!PERSISTENT_PROVIDER_ID_RE.test(turnId)) {
      resolveQuestionContext({ threadId, turnId: '', cwd: input.cwd });
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 지속형 대화 서버가 올바른 turn ID를 반환하지 않았습니다.',
      );
    }
    resolveQuestionContext({ threadId, turnId, cwd: input.cwd });
    await bindProviderIds(input, { threadId, turnId });

    liveControlActive = true;
    if (input.registerLiveControl) {
      const controlDeadline = (): number => Math.min(
        deadline,
        Date.now() + LIVE_CONVERSATION_CONTROL_TIMEOUT_MS,
      );
      const ensureActive = (): void => {
        if (!liveControlActive) {
          throw runtimeError(
            'CODEX_ACTIVE_TURN_NOT_STEERABLE',
            'Codex 대화 turn이 더 이상 실행 중이 아닙니다.',
          );
        }
      };
      const detach = input.registerLiveControl({
        steer: async (promptValue) => {
          ensureActive();
          if (typeof promptValue !== 'string' || !promptValue.trim()
            || promptValue.includes('\u0000')
            || new TextEncoder().encode(promptValue).byteLength > AGENT_RUNTIME_MAX_PROMPT_BYTES) {
            throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 추가 지시가 올바르지 않습니다.');
          }
          const response = await rpc.request('turn/steer', {
            threadId,
            input: [{ type: 'text', text: promptValue, text_elements: [] }],
            expectedTurnId: turnId,
          }, controlDeadline());
          if (response.turnId !== turnId || Object.keys(response).length !== 1) {
            throw runtimeError(
              'CODEX_APP_SERVER_PROTOCOL_FAILED',
              'Codex 추가 지시 응답이 활성 turn과 일치하지 않습니다.',
            );
          }
        },
        interrupt: async () => {
          ensureActive();
          const response = await rpc.request('turn/interrupt', {
            threadId,
            turnId,
          }, controlDeadline());
          if (Object.keys(response).length !== 0) {
            throw runtimeError(
              'CODEX_APP_SERVER_PROTOCOL_FAILED',
              'Codex 대화 중단 응답이 올바르지 않습니다.',
            );
          }
        },
      });
      if (detach !== undefined && typeof detach !== 'function') {
        throw runtimeError(
          'CODEX_TASK_INPUT_INVALID',
          'Codex 대화 제어 등록기가 올바르지 않습니다.',
        );
      }
      if (typeof detach === 'function') detachLiveControl = detach;
    }

    const context: NotificationContext = {
      threadId,
      turnId,
      cwd: input.cwd,
      latestAgentMessage: '',
      emittedDiffSummary: false,
    };
    while (true) {
      const notification = await rpc.nextNotification(deadline);
      if (input.executionMode === 'read-only'
        && violatesToolFreeConversation(notification, context)) {
        throw runtimeError(
          'CODEX_TASK_POLICY_UNVERIFIED',
          '도구 없음 대화에서 도구 실행이 감지되어 Codex 대화를 중단했습니다.',
        );
      }
      const normalized = normalizeNotification(notification, context);
      for (const draft of normalized.drafts) await emit(draft);
      if (!normalized.terminal) continue;
      liveControlActive = false;
      if (normalized.terminal.status === 'failed') throw normalized.terminal.error;
      providerCompleted = true;
      const finalSummary = normalized.terminal.finalSummary;
      await rpc.request(
        'thread/unsubscribe',
        { threadId },
        Date.now() + THREAD_UNSUBSCRIBE_TIMEOUT_MS,
      ).catch(() => ({}));
      return { threadId, turnId, finalSummary, resumed };
    }
  } catch (cause) {
    throw asRuntimeError(cause);
  } finally {
    liveControlActive = false;
    try { detachLiveControl?.(); } catch { /* a local registry cleanup cannot retain the child */ }
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}

/**
 * Reads only retained-thread status (`includeTurns:false`). It intentionally
 * does not return provider IDs, previews, names, turns, items, or transcript
 * content to the caller.
 */
export async function inspectCodexConversation(
  input: InspectCodexConversationInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<CodexConversationInspection> {
  validateProbeInput({
    codexExecutable: input.codexExecutable,
    codexExecutableIdentity: input.codexExecutableIdentity,
    cwd: input.cwd,
  });
  if (!PERSISTENT_PROVIDER_ID_RE.test(input.providerThreadId)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 지속형 대화 식별자가 올바르지 않습니다.');
  }
  if (input.signal?.aborted) throw cancellationError();
  assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);
  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    child = spawn(appServerCommand({
      codexExecutable: input.codexExecutable,
      executionMode: input.executionMode ?? 'workspace-write',
    }), {
      cwd: input.cwd,
      env: codexAgentChildEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError('CODEX_APP_SERVER_UNAVAILABLE', 'Codex 대화 상태 서버를 시작하지 못했습니다.', cause);
  }
  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(1, dependencies.timeoutMs ?? COMPATIBILITY_PROBE_TIMEOUT_MS);
  const abort = (): void => { rpc.abort(cancellationError()); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs_conversation_probe',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});
    const read = await rpc.request('thread/read', {
      threadId: input.providerThreadId,
      includeTurns: false,
    }, deadline);
    const thread = asRecord(read.thread);
    const status = asRecord(thread?.status);
    const statusType = status?.type;
    if (thread?.id !== input.providerThreadId
      || thread?.ephemeral !== false
      || !['notLoaded', 'idle', 'systemError', 'active'].includes(String(statusType))) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 지속형 대화 상태 응답이 올바르지 않습니다.',
      );
    }
    return {
      status: statusType === 'active'
        ? 'active'
        : statusType === 'systemError'
          ? 'systemError'
          : 'idle',
    };
  } catch (cause) {
    throw asRuntimeError(cause);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}

/**
 * Reads provider history for an app-native chat surface without copying raw
 * rollout/tool/reasoning data into AgentsToZ storage. Only bounded user and
 * assistant text crosses this adapter boundary; provider IDs are replaced by
 * deterministic conversation-scoped public IDs.
 */
export async function readCodexConversationHistory(
  input: ReadCodexConversationHistoryInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<CodexConversationHistory> {
  validateProbeInput({
    codexExecutable: input.codexExecutable,
    codexExecutableIdentity: input.codexExecutableIdentity,
    cwd: input.cwd,
  });
  if (!TASK_ID_RE.test(input.conversationId)
    || !PERSISTENT_PROVIDER_ID_RE.test(input.providerThreadId)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 지속형 대화 기록 요청이 올바르지 않습니다.');
  }
  if (input.signal?.aborted) throw cancellationError();
  assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);
  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    child = spawn(appServerCommand({
      codexExecutable: input.codexExecutable,
      executionMode: input.executionMode ?? 'workspace-write',
    }), {
      cwd: input.cwd,
      env: codexAgentChildEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError('CODEX_APP_SERVER_UNAVAILABLE', 'Codex 대화 기록 서버를 시작하지 못했습니다.', cause);
  }
  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(1, dependencies.timeoutMs ?? COMPATIBILITY_PROBE_TIMEOUT_MS);
  const abort = (): void => { rpc.abort(cancellationError()); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs_conversation_history',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});
    const read = await rpc.request('thread/read', {
      threadId: input.providerThreadId,
      includeTurns: true,
    }, deadline);
    const thread = asRecord(read.thread);
    const providerStatus = asRecord(thread?.status)?.type;
    if (thread?.id !== input.providerThreadId
      || thread?.ephemeral !== false
      || !['notLoaded', 'idle', 'systemError', 'active'].includes(String(providerStatus))
      || !Array.isArray(thread.turns)) {
      throw runtimeError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 지속형 대화 기록 응답이 올바르지 않습니다.',
      );
    }

    const sourceTurns = thread.turns;
    let truncated = sourceTurns.length > CONVERSATION_HISTORY_MAX_TURNS;
    let filtered = false;
    const boundedTurns = sourceTurns.slice(-CONVERSATION_HISTORY_MAX_TURNS);
    const providerIds = new Set<string>([input.providerThreadId]);
    for (const turnValue of boundedTurns) {
      const turn = asRecord(turnValue);
      if (typeof turn?.id === 'string' && PERSISTENT_PROVIDER_ID_RE.test(turn.id)) {
        providerIds.add(turn.id);
      }
      if (!Array.isArray(turn?.items)) continue;
      for (const itemValue of turn.items) {
        const item = asRecord(itemValue);
        if (typeof item?.id === 'string' && HISTORY_PROVIDER_ITEM_ID_RE.test(item.id)) {
          providerIds.add(item.id);
        }
      }
    }
    const normalizedTurns: CodexConversationHistoryTurn[] = [];
    for (const turnValue of boundedTurns) {
      const turn = asRecord(turnValue);
      const providerTurnId = typeof turn?.id === 'string' ? turn.id : '';
      const status = turn?.status;
      if (!PERSISTENT_PROVIDER_ID_RE.test(providerTurnId)
        || !['completed', 'interrupted', 'failed', 'inProgress'].includes(String(status))
        || !Array.isArray(turn?.items)) {
        throw runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 지속형 대화 turn 기록이 올바르지 않습니다.',
        );
      }
      const publicTurnId = publicConversationHistoryId(
        'turn',
        input.conversationId,
        providerTurnId,
      );
      const messages: CodexConversationHistoryMessage[] = [];
      for (const itemValue of turn.items) {
        const item = asRecord(itemValue);
        if (!item || typeof item.type !== 'string') {
          throw runtimeError(
            'CODEX_APP_SERVER_PROTOCOL_FAILED',
            'Codex 지속형 대화 메시지 기록이 올바르지 않습니다.',
          );
        }
        if (item.type !== 'userMessage' && item.type !== 'agentMessage') {
          filtered = true;
          continue;
        }
        const providerMessageId = typeof item.id === 'string' ? item.id : '';
        if (!HISTORY_PROVIDER_ITEM_ID_RE.test(providerMessageId)) {
          throw runtimeError(
            'CODEX_APP_SERVER_PROTOCOL_FAILED',
            'Codex 지속형 대화 메시지 식별자가 올바르지 않습니다.',
          );
        }
        let rawText = '';
        let phase: CodexConversationHistoryMessage['phase'] = null;
        if (item.type === 'userMessage') {
          if (!Array.isArray(item.content)) {
            throw runtimeError(
              'CODEX_APP_SERVER_PROTOCOL_FAILED',
              'Codex 사용자 메시지 기록이 올바르지 않습니다.',
            );
          }
          const textParts: string[] = [];
          for (const contentValue of item.content) {
            const content = asRecord(contentValue);
            if (content?.type === 'text' && typeof content.text === 'string') {
              textParts.push(content.text);
            } else {
              filtered = true;
            }
          }
          rawText = textParts.join('\n');
        } else {
          if (typeof item.text !== 'string'
            || ![null, 'commentary', 'final_answer'].includes(item.phase as null | string)) {
            throw runtimeError(
              'CODEX_APP_SERVER_PROTOCOL_FAILED',
              'Codex assistant 메시지 기록이 올바르지 않습니다.',
            );
          }
          rawText = item.text;
          phase = item.phase as CodexConversationHistoryMessage['phase'];
        }
        const safe = redactConversationProviderIds(
          safeSemanticSummary(rawText, input.cwd),
          providerIds,
        );
        if (!safe) {
          filtered = true;
          continue;
        }
        const bounded = boundedUtf8(safe, CONVERSATION_HISTORY_MAX_MESSAGE_BYTES);
        if (bounded.truncated) truncated = true;
        messages.push({
          messageId: publicConversationHistoryId(
            'message',
            input.conversationId,
            `${providerTurnId}\u0000${providerMessageId}`,
          ),
          turnId: publicTurnId,
          role: item.type === 'userMessage' ? 'user' : 'assistant',
          phase,
          text: bounded.text,
        });
      }
      normalizedTurns.push({
        turnId: publicTurnId,
        status: status as CodexConversationHistoryTurn['status'],
        startedAt: providerTimestamp(turn.startedAt),
        completedAt: providerTimestamp(turn.completedAt),
        messages,
      });
    }

    let remainingMessages = CONVERSATION_HISTORY_MAX_MESSAGES;
    let remainingBytes = CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES;
    const selectedTurns: CodexConversationHistoryTurn[] = [];
    for (let turnIndex = normalizedTurns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = normalizedTurns[turnIndex]!;
      const selectedMessages: CodexConversationHistoryMessage[] = [];
      for (let messageIndex = turn.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = turn.messages[messageIndex]!;
        const bytes = new TextEncoder().encode(message.text).byteLength;
        if (remainingMessages < 1 || bytes > remainingBytes) {
          truncated = true;
          continue;
        }
        selectedMessages.unshift(message);
        remainingMessages -= 1;
        remainingBytes -= bytes;
      }
      if (selectedMessages.length !== turn.messages.length) truncated = true;
      selectedTurns.unshift({ ...turn, messages: selectedMessages });
    }
    return {
      status: providerStatus === 'active'
        ? 'active'
        : providerStatus === 'systemError'
          ? 'systemError'
          : 'idle',
      turns: selectedTurns,
      truncated,
      filtered,
    };
  } catch (cause) {
    throw asRuntimeError(cause);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}

/** Executes only the documented reversible thread archive lifecycle. */
export async function mutateCodexConversation(
  input: MutateCodexConversationInput,
  dependencies: CodexAgentRuntimeDependencies = {},
): Promise<{ action: CodexConversationMutation }> {
  validateProbeInput({
    codexExecutable: input.codexExecutable,
    codexExecutableIdentity: input.codexExecutableIdentity,
    cwd: input.cwd,
  });
  if (!PERSISTENT_PROVIDER_ID_RE.test(input.providerThreadId)
    || !['archive', 'unarchive', 'delete'].includes(input.action)) {
    throw runtimeError('CODEX_TASK_INPUT_INVALID', 'Codex 지속형 대화 변경 요청이 올바르지 않습니다.');
  }
  if (input.signal?.aborted) throw cancellationError();
  assertExecutableIdentityCurrent(input.codexExecutableIdentity, dependencies);
  const spawn = dependencies.spawn ?? ((command, options) => (
    Bun.spawn(command, options) as unknown as CodexAgentAppServerProcess
  ));
  let child: CodexAgentAppServerProcess;
  try {
    child = spawn(appServerCommand({
      codexExecutable: input.codexExecutable,
      executionMode: input.executionMode ?? 'workspace-write',
    }), {
      cwd: input.cwd,
      env: codexAgentChildEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }, input.codexExecutableIdentity);
  } catch (cause) {
    throw runtimeError('CODEX_APP_SERVER_UNAVAILABLE', 'Codex 대화 관리 서버를 시작하지 못했습니다.', cause);
  }
  const rpc = new CodexJsonLineRpc(
    child,
    dependencies.terminateProcessTree ?? defaultTerminateProcessTree,
    dependencies.confirmProcessTreeTerminated ?? defaultConfirmProcessTreeTerminated,
  );
  const deadline = Date.now() + Math.max(1, dependencies.timeoutMs ?? COMPATIBILITY_PROBE_TIMEOUT_MS);
  const abort = (): void => { rpc.abort(cancellationError()); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs_conversation_manager',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, deadline);
    rpc.notify('initialized', {});
    const result = await rpc.request(`thread/${input.action}`, {
      threadId: input.providerThreadId,
    }, deadline);
    if (input.action === 'archive' || input.action === 'delete') {
      if (Object.keys(result).length !== 0) {
        throw runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 대화 보관 응답이 올바르지 않습니다.',
        );
      }
    } else {
      const thread = asRecord(result.thread);
      if (thread?.id !== input.providerThreadId || thread?.ephemeral !== false) {
        throw runtimeError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          'Codex 대화 보관 해제 응답이 올바르지 않습니다.',
        );
      }
    }
    return { action: input.action };
  } catch (cause) {
    throw asRuntimeError(cause);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}
