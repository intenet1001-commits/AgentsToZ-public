import { describe, expect, test } from 'bun:test';

import {
  AGENT_RUNTIME_READINESS_GATE_IDS,
  normalizeAgentRuntimeReadinessDiagnostic,
} from '../src/agentRuntimeReadinessContract';
import { inspectAgentRuntimeReadiness } from '../src/agentRuntimeReadinessProbe';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';
import type { MacOSRuntimeBrokerSigningProof } from '../src/macOSRuntimeBrokerSigning';
import { agentRuntimeStartupFailure, throwAgentRuntimeUnavailable } from '../src/agentRuntimeStartup';

function proof(
  overrides: Partial<MacOSRuntimeBrokerSigningProof> = {},
): MacOSRuntimeBrokerSigningProof {
  return {
    schemaVersion: 2,
    kind: 'macos-runtime-broker-signing',
    scope: 'static-signature-snapshot-only',
    mode: 'unavailable',
    result: 'not-verified',
    reason: 'broker-helper-missing',
    authoritative: false,
    reusable: false,
    ready: false,
    ...overrides,
  };
}

describe('agent runtime readiness diagnostic', () => {
  test('keeps recovery diagnostics available when startup and signing inspection fail', async () => {
    const state = agentRuntimeStartupFailure(Object.assign(new Error('/private/lock pid 123 secret'), {
      code: 'FILE_LOCK_RECOVERY_REQUIRED',
    }));
    const diagnostic = await inspectAgentRuntimeReadiness({
      platform: 'darwin',
      supervisorState: state,
      verifyMacOSSigning: async () => { throw new Error('private signing output'); },
    });
    expect(diagnostic.gates.at(-1)).toEqual({
      id: 'runtime-supervisor', status: 'blocked', reason: 'runtime-supervisor-recovery-required',
    });
    expect(diagnostic.gates[4]?.reason).toBe('signature-unverified');
    expect(diagnostic.ready).toBeFalse();
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(() => throwAgentRuntimeUnavailable(state)).toThrow('재시작만으로');
    expect(agentRuntimeStartupFailure(new Error('unknown'))).toBe('unavailable');
    const ready = await inspectAgentRuntimeReadiness({ platform: 'linux', supervisorState: 'ready' });
    expect(ready.gates.at(-1)?.status).toBe('passed');
    expect(ready.ready).toBeFalse();
  });
  test('reports every macOS gate without ever becoming execution authority', async () => {
    const diagnostic = await inspectAgentRuntimeReadiness({
      platform: 'darwin',
      managedExecutionEnabled: false,
      productionTeamIdentifier: null,
      verifyMacOSSigning: async () => proof(),
      inspectCodexAdapter: async () => 'verified',
    });

    expect(diagnostic).toEqual({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      schemaVersion: 3,
      kind: 'agent-runtime-readiness-diagnostic',
      platform: 'macos',
      state: 'blocked',
      authoritative: false,
      reusable: false,
      ready: false,
      gates: [
        { id: 'managed-execution-policy', status: 'blocked', reason: 'managed-execution-policy-closed' },
        { id: 'host-platform', status: 'passed', reason: 'platform-supported' },
        { id: 'codex-adapter', status: 'passed', reason: 'codex-adapter-verified' },
        { id: 'production-team-pin', status: 'blocked', reason: 'production-team-pin-unconfigured' },
        { id: 'embedded-broker-signing', status: 'blocked', reason: 'broker-helper-missing' },
        { id: 'smappservice-channel', status: 'pending', reason: 'smappservice-channel-awaits-installed-proof' },
        {
          id: 'dedicated-runtime-identity',
          status: 'pending',
          reason: 'dedicated-runtime-identity-not-implemented',
        },
        {
          id: 'detached-descendant-canary',
          status: 'pending',
          reason: 'detached-descendant-canary-not-implemented',
        },
        { id: 'runtime-supervisor', status: 'blocked', reason: 'runtime-supervisor-unavailable' },
      ],
    });
  });

  test('keeps a production static-signature success pending and non-reusable', async () => {
    const diagnostic = await inspectAgentRuntimeReadiness({
      platform: 'darwin',
      managedExecutionEnabled: true,
      productionTeamIdentifier: 'ABCDEFGHIJ',
      inspectCodexAdapter: async () => 'verified',
      verifyMacOSSigning: async () => proof({
        mode: 'production',
        result: 'snapshot-verified',
        reason: 'static-signature-snapshot-verified',
      }),
    });

    expect(diagnostic.gates[0]).toEqual({
      id: 'managed-execution-policy', status: 'pending', reason: 'managed-execution-policy-closed',
    });
    expect(diagnostic.gates[3]?.status).toBe('pending');
    expect(diagnostic.gates[4]).toEqual({
      id: 'embedded-broker-signing', status: 'pending', reason: 'static-signature-snapshot-only',
    });
    expect(diagnostic.ready).toBe(false);
    expect(diagnostic.authoritative).toBe(false);
    expect(diagnostic.reusable).toBe(false);
  });

  test('keeps missing and failed Codex adapter inspection distinct from containment', async () => {
    const missing = await inspectAgentRuntimeReadiness({
      platform: 'darwin',
      inspectCodexAdapter: async () => 'missing',
      verifyMacOSSigning: async () => proof(),
    });
    expect(missing.gates[2]).toEqual({
      id: 'codex-adapter', status: 'blocked', reason: 'codex-adapter-missing',
    });

    const failed = await inspectAgentRuntimeReadiness({
      platform: 'darwin',
      inspectCodexAdapter: async () => { throw new Error('private diagnostic'); },
      verifyMacOSSigning: async () => proof(),
    });
    expect(failed.gates[2]).toEqual({
      id: 'codex-adapter', status: 'pending', reason: 'codex-adapter-unverified',
    });
  });

  test('normalizer rejects missing, reordered, duplicated, or authority-bearing gates', async () => {
    const diagnostic = await inspectAgentRuntimeReadiness({
      platform: 'linux',
      managedExecutionEnabled: false,
    });
    expect(diagnostic.platform).toBe('linux');
    expect(diagnostic.gates.map(gate => gate.id)).toEqual([...AGENT_RUNTIME_READINESS_GATE_IDS]);

    for (const tampered of [
      { ...diagnostic, ready: true },
      { ...diagnostic, authoritative: true },
      { ...diagnostic, gates: diagnostic.gates.slice(1) },
      { ...diagnostic, gates: [diagnostic.gates[1], diagnostic.gates[0], ...diagnostic.gates.slice(2)] },
      { ...diagnostic, gates: [diagnostic.gates[0], diagnostic.gates[0], ...diagnostic.gates.slice(2)] },
      { ...diagnostic, localPath: '/private/project' },
    ]) {
      expect(() => normalizeAgentRuntimeReadinessDiagnostic(tampered)).toThrow();
    }
  });
});
