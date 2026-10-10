import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_CONTAINMENT_KINDS,
  AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES,
  AGENT_RUNTIME_CONTAINMENT_READINESS_REASONS,
  AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
  createAgentRuntimeContainmentCapability,
  createAgentRuntimeContainmentReservedState,
  isAgentRuntimeContainmentReady,
  normalizeAgentRuntimeContainmentCapability,
  normalizeAgentRuntimeContainmentPublicState,
  transitionAgentRuntimeContainment,
  type AgentRuntimeContainmentLifecycleState,
} from '../src/agentRuntimeContainment';

describe('Agent Runtime containment contract', () => {
  test('publishes only the supported provider-neutral containment kinds', () => {
    expect(AGENT_RUNTIME_CONTAINMENT_KINDS).toEqual([
      'apple-container-vm',
      'linux-systemd-cgroup-v2',
      'windows-job-object',
    ]);
    expect(Object.isFrozen(AGENT_RUNTIME_CONTAINMENT_KINDS)).toBe(true);
  });

  test('advances through the documented durable lifecycle in exact order', () => {
    expect(AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES).toEqual([
      'reserved',
      'staging-prepared',
      'containment-created',
      'running',
      'stopping',
      'stopped-proven',
      'result-validated',
      'materialized',
      'disposed',
    ]);
    let state = createAgentRuntimeContainmentReservedState(
      'task_containment_01',
      'apple-container-vm',
    );
    for (const lifecycle of AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES.slice(1)) {
      state = transitionAgentRuntimeContainment(state, lifecycle);
    }
    expect(state.lifecycle).toBe('disposed');
    expect(Object.isFrozen(state)).toBe(true);
  });

  test('rejects skipped, repeated, backward, unknown, and post-disposal transitions', () => {
    const reserved = createAgentRuntimeContainmentReservedState(
      'task_containment_02',
      'linux-systemd-cgroup-v2',
    );
    expect(() => transitionAgentRuntimeContainment(reserved, 'containment-created'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
    expect(() => transitionAgentRuntimeContainment(reserved, 'reserved'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
    const staging = transitionAgentRuntimeContainment(reserved, 'staging-prepared');
    expect(() => transitionAgentRuntimeContainment(staging, 'reserved'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
    expect(() => transitionAgentRuntimeContainment(
      reserved,
      'future-state' as AgentRuntimeContainmentLifecycleState,
    )).toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');

    let disposed = reserved;
    for (const lifecycle of AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES.slice(1)) {
      disposed = transitionAgentRuntimeContainment(disposed, lifecycle);
    }
    expect(() => transitionAgentRuntimeContainment(disposed, 'disposed'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
  });

  test('models failure cleanup without inventing resources or results', () => {
    const reserved = createAgentRuntimeContainmentReservedState(
      'task_containment_cleanup',
      'apple-container-vm',
    );
    const earlyStopping = transitionAgentRuntimeContainment(reserved, 'stopping');
    const earlyStopped = transitionAgentRuntimeContainment(earlyStopping, 'stopped-proven');
    expect(transitionAgentRuntimeContainment(earlyStopped, 'disposed').lifecycle).toBe('disposed');

    const prepared = transitionAgentRuntimeContainment(reserved, 'staging-prepared');
    const created = transitionAgentRuntimeContainment(prepared, 'containment-created');
    const running = transitionAgentRuntimeContainment(created, 'running');
    const stopping = transitionAgentRuntimeContainment(running, 'stopping');
    const stopped = transitionAgentRuntimeContainment(stopping, 'stopped-proven');
    const validated = transitionAgentRuntimeContainment(stopped, 'result-validated');
    expect(transitionAgentRuntimeContainment(validated, 'disposed').lifecycle).toBe('disposed');
    expect(() => transitionAgentRuntimeContainment(prepared, 'disposed'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
  });

  test('accepts the exact public state shape and rejects sensitive extra fields', () => {
    const state = normalizeAgentRuntimeContainmentPublicState({
      schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
      taskId: 'task_public_01',
      kind: 'windows-job-object',
      lifecycle: 'running',
    });
    expect(state).toEqual({
      schemaVersion: 1,
      taskId: 'task_public_01',
      kind: 'windows-job-object',
      lifecycle: 'running',
    });
    for (const extra of [
      { workspacePath: '/private/project' },
      { command: 'codex exec secret' },
      { credential: 'secret-token' },
      { resourceId: 'host-private-container-id' },
    ]) {
      expect(() => normalizeAgentRuntimeContainmentPublicState({ ...state, ...extra }))
        .toThrow('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
    }
  });

  test('rejects malformed identifiers, unknown kinds, and future state schemas', () => {
    const base = {
      schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
      taskId: 'task_public_02',
      kind: 'apple-container-vm',
      lifecycle: 'reserved',
    };
    expect(() => normalizeAgentRuntimeContainmentPublicState({ ...base, taskId: '../secret' }))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
    expect(() => normalizeAgentRuntimeContainmentPublicState({ ...base, kind: 'plain-pgid' }))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
    expect(() => normalizeAgentRuntimeContainmentPublicState({ ...base, schemaVersion: 2 }))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_SCHEMA_UNSUPPORTED');
  });

  test('makes readiness internally consistent and exposes no free-form diagnostics', () => {
    const ready = createAgentRuntimeContainmentCapability('apple-container-vm', 'ready');
    expect(ready).toEqual({
      schemaVersion: 1,
      kind: 'apple-container-vm',
      ready: true,
      reason: 'ready',
    });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(isAgentRuntimeContainmentReady(ready)).toBe(true);

    const blocked = createAgentRuntimeContainmentCapability(
      'apple-container-vm',
      'self-test-required',
    );
    expect(blocked.ready).toBe(false);
    expect(isAgentRuntimeContainmentReady(blocked)).toBe(false);

    expect(() => normalizeAgentRuntimeContainmentCapability({
      ...blocked,
      detail: '/usr/local/bin/container failed with token=secret',
    })).toThrow('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
  });

  test('every non-ready reason fails closed', () => {
    for (const reason of AGENT_RUNTIME_CONTAINMENT_READINESS_REASONS) {
      const capability = createAgentRuntimeContainmentCapability(
        reason === 'platform-unsupported' ? null : 'apple-container-vm',
        reason,
      );
      expect(capability.ready).toBe(reason === 'ready');
      expect(isAgentRuntimeContainmentReady(capability)).toBe(reason === 'ready');
    }
  });

  test('rejects inconsistent, unknown, and future capability values and treats them as unready', () => {
    const base = {
      schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
      kind: 'apple-container-vm',
      ready: false,
      reason: 'dependency-missing',
    };
    for (const value of [
      { ...base, ready: true },
      { ...base, reason: 'ready' },
      { ...base, reason: 'unknown-probe-result' },
      { ...base, kind: 'process-group' },
      { ...base, schemaVersion: 2 },
      { ...base, command: 'container system start' },
    ]) {
      expect(isAgentRuntimeContainmentReady(value)).toBe(false);
    }
    expect(() => normalizeAgentRuntimeContainmentCapability({ ...base, schemaVersion: 2 }))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_SCHEMA_UNSUPPORTED');
    expect(() => createAgentRuntimeContainmentCapability(null, 'ready'))
      .toThrow('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
  });
});
