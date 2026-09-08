import { AGENT_RUNTIME_PROTOCOL_VERSION } from './agentRuntimeProtocol';

/**
 * Local-only diagnostic schema. It deliberately cannot authorize execution:
 * the future native broker must produce the live, reusable capability.
 */
export const AGENT_RUNTIME_READINESS_SCHEMA_VERSION = 3 as const;

export const AGENT_RUNTIME_READINESS_GATE_IDS = [
  'managed-execution-policy',
  'host-platform',
  'codex-adapter',
  'production-team-pin',
  'embedded-broker-signing',
  'smappservice-channel',
  'dedicated-runtime-identity',
  'detached-descendant-canary',
  'runtime-supervisor',
] as const;

export type AgentRuntimeReadinessGateId = typeof AGENT_RUNTIME_READINESS_GATE_IDS[number];
export type AgentRuntimeReadinessGateStatus = 'passed' | 'blocked' | 'pending' | 'unsupported';

export type AgentRuntimeReadinessReason =
  | 'managed-execution-policy-closed'
  | 'platform-supported'
  | 'platform-unsupported'
  | 'codex-adapter-verified'
  | 'codex-adapter-missing'
  | 'codex-adapter-unverified'
  | 'production-team-pin-unconfigured'
  | 'production-team-pin-present'
  | 'static-signature-snapshot-only'
  | 'development-ad-hoc-signing'
  | 'app-bundle-missing'
  | 'app-executable-missing'
  | 'broker-helper-missing'
  | 'bundle-path-unverified'
  | 'signature-unverified'
  | 'signing-mode-mismatch'
  | 'production-team-unverified'
  | 'developer-id-unverified'
  | 'hardened-runtime-required'
  | 'secure-timestamp-required'
  | 'channel-entitlement-unverified'
  | 'smappservice-channel-awaits-installed-proof'
  | 'dedicated-runtime-identity-not-implemented'
  | 'detached-descendant-canary-not-implemented'
  | 'runtime-supervisor-ready'
  | 'runtime-supervisor-recovery-required'
  | 'runtime-supervisor-unavailable';

export interface AgentRuntimeReadinessGate {
  id: AgentRuntimeReadinessGateId;
  status: AgentRuntimeReadinessGateStatus;
  reason: AgentRuntimeReadinessReason;
}

export interface AgentRuntimeReadinessDiagnostic {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  schemaVersion: typeof AGENT_RUNTIME_READINESS_SCHEMA_VERSION;
  kind: 'agent-runtime-readiness-diagnostic';
  platform: 'macos' | 'linux' | 'windows' | 'unsupported';
  state: 'blocked';
  /** A diagnostic snapshot is never an execution capability. */
  authoritative: false;
  reusable: false;
  ready: false;
  gates: AgentRuntimeReadinessGate[];
}

type JsonObject = Record<string, unknown>;
const GATE_IDS = new Set<string>(AGENT_RUNTIME_READINESS_GATE_IDS);
const GATE_STATUSES = new Set<AgentRuntimeReadinessGateStatus>([
  'passed', 'blocked', 'pending', 'unsupported',
]);
const REASONS = new Set<AgentRuntimeReadinessReason>([
  'managed-execution-policy-closed',
  'platform-supported',
  'platform-unsupported',
  'codex-adapter-verified',
  'codex-adapter-missing',
  'codex-adapter-unverified',
  'production-team-pin-unconfigured',
  'production-team-pin-present',
  'static-signature-snapshot-only',
  'development-ad-hoc-signing',
  'app-bundle-missing',
  'app-executable-missing',
  'broker-helper-missing',
  'bundle-path-unverified',
  'signature-unverified',
  'signing-mode-mismatch',
  'production-team-unverified',
  'developer-id-unverified',
  'hardened-runtime-required',
  'secure-timestamp-required',
  'channel-entitlement-unverified',
  'smappservice-channel-awaits-installed-proof',
  'dedicated-runtime-identity-not-implemented',
  'detached-descendant-canary-not-implemented',
  'runtime-supervisor-ready',
  'runtime-supervisor-recovery-required',
  'runtime-supervisor-unavailable',
]);

function invalid(): never {
  throw new Error('에이전트 런타임 준비 상태 응답이 올바르지 않습니다.');
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function normalizeAgentRuntimeReadinessDiagnostic(
  value: unknown,
): AgentRuntimeReadinessDiagnostic {
  const raw = asObject(value);
  if (!exactKeys(raw, [
    'protocolVersion', 'schemaVersion', 'kind', 'platform', 'state',
    'authoritative', 'reusable', 'ready', 'gates',
  ])
    || raw.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION
    || raw.schemaVersion !== AGENT_RUNTIME_READINESS_SCHEMA_VERSION
    || raw.kind !== 'agent-runtime-readiness-diagnostic'
    || !['macos', 'linux', 'windows', 'unsupported'].includes(String(raw.platform))
    || raw.state !== 'blocked'
    || raw.authoritative !== false
    || raw.reusable !== false
    || raw.ready !== false
    || !Array.isArray(raw.gates)
    || raw.gates.length !== AGENT_RUNTIME_READINESS_GATE_IDS.length) return invalid();

  const gates = raw.gates.map((candidate): AgentRuntimeReadinessGate => {
    const gate = asObject(candidate);
    if (!exactKeys(gate, ['id', 'status', 'reason'])
      || typeof gate.id !== 'string'
      || !GATE_IDS.has(gate.id)
      || !GATE_STATUSES.has(gate.status as AgentRuntimeReadinessGateStatus)
      || !REASONS.has(gate.reason as AgentRuntimeReadinessReason)) return invalid();
    return {
      id: gate.id as AgentRuntimeReadinessGateId,
      status: gate.status as AgentRuntimeReadinessGateStatus,
      reason: gate.reason as AgentRuntimeReadinessReason,
    };
  });
  if (new Set(gates.map(gate => gate.id)).size !== AGENT_RUNTIME_READINESS_GATE_IDS.length
    || !AGENT_RUNTIME_READINESS_GATE_IDS.every((id, index) => gates[index]?.id === id)) return invalid();

  return {
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    schemaVersion: AGENT_RUNTIME_READINESS_SCHEMA_VERSION,
    kind: 'agent-runtime-readiness-diagnostic',
    platform: raw.platform as AgentRuntimeReadinessDiagnostic['platform'],
    state: 'blocked',
    authoritative: false,
    reusable: false,
    ready: false,
    gates,
  };
}
