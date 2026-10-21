import {
  AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED,
  AGENT_RUNTIME_PROTOCOL_VERSION,
} from './agentRuntimeProtocol';
import {
  AGENT_RUNTIME_READINESS_SCHEMA_VERSION,
  normalizeAgentRuntimeReadinessDiagnostic,
  type AgentRuntimeReadinessDiagnostic,
  type AgentRuntimeReadinessGate,
  type AgentRuntimeReadinessReason,
} from './agentRuntimeReadinessContract';
import {
  MACOS_RUNTIME_BROKER_PRODUCTION_TEAM_IDENTIFIER,
  verifyMacOSRuntimeBrokerSigningPreflight,
  type MacOSRuntimeBrokerSigningProof,
} from './macOSRuntimeBrokerSigning';
import type { AgentRuntimeStartupState } from './agentRuntimeStartup';

export interface AgentRuntimeReadinessProbeDependencies {
  supervisorState?: AgentRuntimeStartupState;
  platform?: NodeJS.Platform;
  managedExecutionEnabled?: boolean;
  productionTeamIdentifier?: string | null;
  verifyMacOSSigning?: () => Promise<Readonly<MacOSRuntimeBrokerSigningProof>>;
  /**
   * Read-only compatibility inspection. This may prove that the installed
   * Codex CLI, account and app-server protocol work, but it never authorizes a
   * task or weakens the separate containment gates.
   */
  inspectCodexAdapter?: () => Promise<'verified' | 'missing' | 'unverified'>;
}

function platformName(platform: NodeJS.Platform): AgentRuntimeReadinessDiagnostic['platform'] {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unsupported';
}

function signingReason(proof: Readonly<MacOSRuntimeBrokerSigningProof>): AgentRuntimeReadinessReason {
  if (proof.reason === 'static-signature-snapshot-verified') return 'static-signature-snapshot-only';
  if (proof.reason === 'production-team-unconfigured') return 'production-team-pin-unconfigured';
  return proof.reason;
}

function gate(
  id: AgentRuntimeReadinessGate['id'],
  status: AgentRuntimeReadinessGate['status'],
  reason: AgentRuntimeReadinessGate['reason'],
): AgentRuntimeReadinessGate {
  return { id, status, reason };
}

/**
 * Produces a path-free, local diagnostic snapshot. Even a fully verified
 * static signature remains pending because only the future live native broker
 * may authorize execution.
 */
export async function inspectAgentRuntimeReadiness(
  dependencies: AgentRuntimeReadinessProbeDependencies = {},
): Promise<AgentRuntimeReadinessDiagnostic> {
  const platform = dependencies.platform ?? process.platform;
  const visiblePlatform = platformName(platform);
  const managedExecutionEnabled = dependencies.managedExecutionEnabled
    ?? AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED;
  const productionTeamIdentifier = dependencies.productionTeamIdentifier
    === undefined
    ? MACOS_RUNTIME_BROKER_PRODUCTION_TEAM_IDENTIFIER
    : dependencies.productionTeamIdentifier;

  let signingGate: AgentRuntimeReadinessGate;
  let codexAdapterGate: AgentRuntimeReadinessGate;
  if (platform !== 'darwin') {
    codexAdapterGate = gate('codex-adapter', 'unsupported', 'platform-unsupported');
  } else if (!dependencies.inspectCodexAdapter) {
    codexAdapterGate = gate('codex-adapter', 'pending', 'codex-adapter-unverified');
  } else {
    let result: 'verified' | 'missing' | 'unverified';
    try {
      result = await dependencies.inspectCodexAdapter();
    } catch {
      result = 'unverified';
    }
    codexAdapterGate = result === 'verified'
      ? gate('codex-adapter', 'passed', 'codex-adapter-verified')
      : result === 'missing'
        ? gate('codex-adapter', 'blocked', 'codex-adapter-missing')
        : gate('codex-adapter', 'pending', 'codex-adapter-unverified');
  }
  if (platform !== 'darwin') {
    signingGate = gate('embedded-broker-signing', 'unsupported', 'platform-unsupported');
  } else {
    try {
      const proof = await (dependencies.verifyMacOSSigning
        ?? verifyMacOSRuntimeBrokerSigningPreflight)();
      const status = proof.result === 'snapshot-verified' ? 'pending' : 'blocked';
      signingGate = gate('embedded-broker-signing', status, signingReason(proof));
    } catch {
      signingGate = gate('embedded-broker-signing', 'blocked', 'signature-unverified');
    }
  }

  return normalizeAgentRuntimeReadinessDiagnostic({
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    schemaVersion: AGENT_RUNTIME_READINESS_SCHEMA_VERSION,
    kind: 'agent-runtime-readiness-diagnostic',
    platform: visiblePlatform,
    state: 'blocked',
    authoritative: false,
    reusable: false,
    ready: false,
    gates: [
      gate(
        'managed-execution-policy',
        managedExecutionEnabled ? 'pending' : 'blocked',
        'managed-execution-policy-closed',
      ),
      gate(
        'host-platform',
        platform === 'darwin' ? 'passed' : 'unsupported',
        platform === 'darwin' ? 'platform-supported' : 'platform-unsupported',
      ),
      codexAdapterGate,
      gate(
        'production-team-pin',
        productionTeamIdentifier ? 'pending' : 'blocked',
        productionTeamIdentifier
          ? 'production-team-pin-present'
          : 'production-team-pin-unconfigured',
      ),
      signingGate,
      gate('smappservice-channel', 'pending', 'smappservice-channel-awaits-installed-proof'),
      gate(
        'dedicated-runtime-identity',
        'pending',
        'dedicated-runtime-identity-not-implemented',
      ),
      gate(
        'detached-descendant-canary',
        'pending',
        'detached-descendant-canary-not-implemented',
      ),
      gate(
        'runtime-supervisor',
        dependencies.supervisorState === 'ready' ? 'passed' : 'blocked',
        dependencies.supervisorState === 'ready'
          ? 'runtime-supervisor-ready'
          : dependencies.supervisorState === 'recovery-required'
            ? 'runtime-supervisor-recovery-required'
            : 'runtime-supervisor-unavailable',
      ),
    ],
  });
}
