import { describe, expect, test } from 'bun:test';
import {
  MacOSRuntimeNativeClient,
  normalizeMacOSRuntimeNativeDiagnostic,
} from '../src/macOSRuntimeNativeClient';

const diagnostic = {
  schemaVersion: 1,
  kind: 'macos-runtime-broker-client-diagnostic',
  operation: 'status',
  result: 'production-identity-unavailable',
  executionAuthorized: false,
  reusable: false,
  ready: false,
} as const;

describe('macOS native runtime Tauri client', () => {
  test('accepts only a path-free non-authorizing exact diagnostic', () => {
    expect(normalizeMacOSRuntimeNativeDiagnostic(diagnostic)).toEqual(diagnostic);
    for (const tampered of [
      { ...diagnostic, ready: true },
      { ...diagnostic, reusable: true },
      { ...diagnostic, executionAuthorized: true },
      { ...diagnostic, localPath: '/Applications/AgentsToZ_byCS.app' },
      { ...diagnostic, operation: 'shell' },
      { ...diagnostic, result: 'root-ready' },
    ]) {
      expect(() => normalizeMacOSRuntimeNativeDiagnostic(tampered)).toThrow();
    }
  });

  test('uses exact Tauri commands and confirmation bodies', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = new MacOSRuntimeNativeClient(async (command, args) => {
      calls.push({ command, args });
      const operation = command.endsWith('_status')
        ? 'status'
        : command.endsWith('_register')
          ? 'register'
          : command.endsWith('_unregister')
            ? 'unregister'
            : command.endsWith('_probe')
              ? 'probe'
              : command.endsWith('_provision_dedicated_identity')
                ? 'provision-dedicated-identity'
              : 'dedicated-identity-fixture';
      return { ...diagnostic, operation };
    });
    await client.status();
    await client.register();
    await client.unregister();
    await client.probe();
    await client.provisionDedicatedIdentity();
    await client.runDedicatedIdentityFixture();
    expect(calls).toEqual([
      { command: 'agent_runtime_native_broker_status', args: undefined },
      { command: 'agent_runtime_native_broker_register', args: { confirmed: true } },
      { command: 'agent_runtime_native_broker_unregister', args: { confirmed: true } },
      { command: 'agent_runtime_native_broker_probe', args: undefined },
      {
        command: 'agent_runtime_native_broker_provision_dedicated_identity',
        args: { confirmed: true },
      },
      {
        command: 'agent_runtime_native_broker_dedicated_identity_fixture',
        args: { confirmed: true },
      },
    ]);
  });

  test('rejects a native response for a different operation', async () => {
    const client = new MacOSRuntimeNativeClient(async () => diagnostic);
    await expect(client.probe()).rejects.toThrow();
  });
});
