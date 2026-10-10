/**
 * Browser-safe identity and capability registry for the AgentsToZ task runtime.
 *
 * This is deliberately separate from `TerminalApp`: TerminalApp selects an
 * existing external surface (Orca, cmux, iTerm, ...), while this registry
 * describes agents that can be managed by the AgentsToZ control plane.
 *
 * The registry describes adapter potential, not live availability. A UI must
 * still read host/runtime capability before claiming that an adapter can run.
 */

export const AGENT_RUNTIME_REGISTRY_VERSION = 1 as const;

// Product rollout order is intentional: stabilize the Codex control-plane
// contract first, then add Claude, Hermes, and finally agy without changing
// the host/project/conversation model owned by AgentsToZ.
export const BUILTIN_AGENT_RUNTIME_IDS = ['codex', 'claude', 'hermes', 'agy'] as const;
export type BuiltinAgentRuntimeId = typeof BUILTIN_AGENT_RUNTIME_IDS[number];

export type AgentTaskTransport =
  | 'claude-stream-json'
  | 'codex-app-server'
  | 'agy-stream-json'
  | 'hermes-acp';

export type AgentProjectMemoryIntegration =
  | 'project-read-write'
  | 'git-evidence-only';

export type AgentPromptCaptureIntegration = 'structured' | 'unavailable';

export interface AgentRuntimeAdapterDefinition {
  readonly schemaVersion: typeof AGENT_RUNTIME_REGISTRY_VERSION;
  /** Stable machine id. It is never an executable path or shell fragment. */
  readonly id: string;
  readonly label: string;
  /** Machine protocol used by the semantic task adapter. */
  readonly taskTransport: AgentTaskTransport;
  readonly integrations: {
    readonly projectMemory: AgentProjectMemoryIntegration;
    readonly promptCapture: AgentPromptCaptureIntegration;
  };
  readonly policy: {
    /** Remote execution always resolves a registered opaque target on the host. */
    readonly remoteTarget: 'registered-only';
    /** A remote controller may never silently inherit a desktop bypass toggle. */
    readonly remotePermissionEscalation: 'explicit-approval-only';
  };
}

const ADAPTER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const LABEL_MAX_LENGTH = 40;

function freezeAdapter(
  adapter: AgentRuntimeAdapterDefinition,
): Readonly<AgentRuntimeAdapterDefinition> {
  return Object.freeze({
    ...adapter,
    integrations: Object.freeze({ ...adapter.integrations }),
    policy: Object.freeze({ ...adapter.policy }),
  });
}

export function validateAgentRuntimeAdapter(
  adapter: AgentRuntimeAdapterDefinition,
): Readonly<AgentRuntimeAdapterDefinition> {
  if (adapter.schemaVersion !== AGENT_RUNTIME_REGISTRY_VERSION) {
    throw new Error('AGENT_RUNTIME_ADAPTER_VERSION_UNSUPPORTED');
  }
  if (!ADAPTER_ID_RE.test(adapter.id)) {
    throw new Error('AGENT_RUNTIME_ADAPTER_ID_INVALID');
  }
  if (!adapter.label.trim() || adapter.label !== adapter.label.trim()
    || adapter.label.length > LABEL_MAX_LENGTH) {
    throw new Error('AGENT_RUNTIME_ADAPTER_LABEL_INVALID');
  }
  if (adapter.policy.remoteTarget !== 'registered-only'
    || adapter.policy.remotePermissionEscalation !== 'explicit-approval-only') {
    throw new Error('AGENT_RUNTIME_ADAPTER_POLICY_UNSAFE');
  }
  return freezeAdapter(adapter);
}

export class AgentRuntimeRegistry {
  readonly #ordered: readonly Readonly<AgentRuntimeAdapterDefinition>[];
  readonly #byId: ReadonlyMap<string, Readonly<AgentRuntimeAdapterDefinition>>;

  constructor(adapters: readonly AgentRuntimeAdapterDefinition[]) {
    const byId = new Map<string, Readonly<AgentRuntimeAdapterDefinition>>();
    const ordered = adapters.map((adapter) => {
      const validated = validateAgentRuntimeAdapter(adapter);
      if (byId.has(validated.id)) throw new Error('AGENT_RUNTIME_ADAPTER_DUPLICATE');
      byId.set(validated.id, validated);
      return validated;
    });
    this.#ordered = Object.freeze(ordered);
    this.#byId = byId;
  }

  list(): readonly Readonly<AgentRuntimeAdapterDefinition>[] {
    return this.#ordered;
  }

  get(id: string): Readonly<AgentRuntimeAdapterDefinition> | null {
    return this.#byId.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }
}

const sharedPolicy = Object.freeze({
  remoteTarget: 'registered-only',
  remotePermissionEscalation: 'explicit-approval-only',
} as const);

const builtinDefinitions: readonly AgentRuntimeAdapterDefinition[] = [
  {
    schemaVersion: AGENT_RUNTIME_REGISTRY_VERSION,
    id: 'codex',
    label: 'Codex',
    taskTransport: 'codex-app-server',
    integrations: { projectMemory: 'project-read-write', promptCapture: 'structured' },
    policy: sharedPolicy,
  },
  {
    schemaVersion: AGENT_RUNTIME_REGISTRY_VERSION,
    id: 'claude',
    label: 'Claude',
    taskTransport: 'claude-stream-json',
    integrations: { projectMemory: 'project-read-write', promptCapture: 'structured' },
    policy: sharedPolicy,
  },
  {
    schemaVersion: AGENT_RUNTIME_REGISTRY_VERSION,
    id: 'hermes',
    label: 'Hermes',
    taskTransport: 'hermes-acp',
    integrations: { projectMemory: 'project-read-write', promptCapture: 'unavailable' },
    policy: sharedPolicy,
  },
  {
    schemaVersion: AGENT_RUNTIME_REGISTRY_VERSION,
    id: 'agy',
    label: 'agy',
    taskTransport: 'agy-stream-json',
    // Antigravity conversation contents are not a verified memory/prompt source.
    integrations: { projectMemory: 'git-evidence-only', promptCapture: 'unavailable' },
    policy: sharedPolicy,
  },
] as const;

export const BUILTIN_AGENT_RUNTIME_REGISTRY = new AgentRuntimeRegistry(builtinDefinitions);

export const BUILTIN_AGENT_RUNTIME_LABELS: Readonly<Record<BuiltinAgentRuntimeId, string>> =
  Object.freeze(Object.fromEntries(
    BUILTIN_AGENT_RUNTIME_IDS.map((id) => [id, BUILTIN_AGENT_RUNTIME_REGISTRY.get(id)!.label]),
  ) as Record<BuiltinAgentRuntimeId, string>);

export function isBuiltinAgentRuntimeId(value: unknown): value is BuiltinAgentRuntimeId {
  return typeof value === 'string' && BUILTIN_AGENT_RUNTIME_REGISTRY.has(value);
}
