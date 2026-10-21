import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_REGISTRY_VERSION,
  AgentRuntimeRegistry,
  BUILTIN_AGENT_RUNTIME_IDS,
  BUILTIN_AGENT_RUNTIME_LABELS,
  BUILTIN_AGENT_RUNTIME_REGISTRY,
  isBuiltinAgentRuntimeId,
  type AgentRuntimeAdapterDefinition,
} from '../src/agentRuntimeRegistry';

const adapter = (overrides: Partial<AgentRuntimeAdapterDefinition> = {}): AgentRuntimeAdapterDefinition => ({
  schemaVersion: AGENT_RUNTIME_REGISTRY_VERSION,
  id: 'test-agent',
  label: 'Test Agent',
  taskTransport: 'codex-app-server',
  integrations: { projectMemory: 'project-read-write', promptCapture: 'structured' },
  policy: {
    remoteTarget: 'registered-only',
    remotePermissionEscalation: 'explicit-approval-only',
  },
  ...overrides,
});

describe('Agent Runtime adapter registry', () => {
  test('keeps the staged provider rollout order and labels stable', () => {
    expect(BUILTIN_AGENT_RUNTIME_IDS).toEqual(['codex', 'claude', 'hermes', 'agy']);
    expect(BUILTIN_AGENT_RUNTIME_LABELS).toEqual({
      claude: 'Claude',
      codex: 'Codex',
      agy: 'agy',
      hermes: 'Hermes',
    });
  });

  test('records the machine protocol and only verified memory/prompt integrations', () => {
    expect(BUILTIN_AGENT_RUNTIME_REGISTRY.get('codex')).toMatchObject({
      taskTransport: 'codex-app-server',
      integrations: { projectMemory: 'project-read-write', promptCapture: 'structured' },
    });
    expect(BUILTIN_AGENT_RUNTIME_REGISTRY.get('claude')?.taskTransport).toBe('claude-stream-json');
    expect(BUILTIN_AGENT_RUNTIME_REGISTRY.get('agy')?.integrations).toEqual({
      projectMemory: 'git-evidence-only',
      promptCapture: 'unavailable',
    });
    expect(BUILTIN_AGENT_RUNTIME_REGISTRY.get('hermes')?.integrations.promptCapture).toBe('unavailable');
  });

  test('recognizes only registered built-ins at the current wire boundary', () => {
    expect(isBuiltinAgentRuntimeId('codex')).toBe(true);
    expect(isBuiltinAgentRuntimeId('gemini')).toBe(false);
    expect(isBuiltinAgentRuntimeId('../codex')).toBe(false);
  });

  test('fails closed on duplicate, malformed, or remotely unsafe adapters', () => {
    expect(() => new AgentRuntimeRegistry([adapter(), adapter()]))
      .toThrow('AGENT_RUNTIME_ADAPTER_DUPLICATE');
    expect(() => new AgentRuntimeRegistry([adapter({ id: '../shell' })]))
      .toThrow('AGENT_RUNTIME_ADAPTER_ID_INVALID');
    expect(() => new AgentRuntimeRegistry([adapter({
      policy: {
        remoteTarget: 'registered-only',
        remotePermissionEscalation: 'unsafe' as 'explicit-approval-only',
      },
    })])).toThrow('AGENT_RUNTIME_ADAPTER_POLICY_UNSAFE');
  });

  test('returns immutable definitions and never exposes a mutable registry array', () => {
    const registry = new AgentRuntimeRegistry([adapter()]);
    const first = registry.get('test-agent')!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.integrations)).toBe(true);
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });
});
