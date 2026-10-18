import { invoke } from '@tauri-apps/api/core';

export const MACOS_RUNTIME_NATIVE_SCHEMA_VERSION = 1 as const;

export const MACOS_RUNTIME_NATIVE_OPERATIONS = [
  'status',
  'register',
  'unregister',
  'probe',
  'provision-dedicated-identity',
  'dedicated-identity-fixture',
] as const;

export const MACOS_RUNTIME_NATIVE_RESULTS = [
  'not-registered',
  'enabled',
  'requires-approval',
  'not-found',
  'registered',
  'unregistered',
  'already-registered',
  'registration-denied',
  'probe-passed',
  'dedicated-identity-fixture-passed',
  'dedicated-identity-provisioned',
  'dedicated-identity-already-provisioned',
  'unsupported-os',
  'production-identity-unavailable',
  'app-location-rejected',
  'bundle-identity-rejected',
  'signature-rejected',
  'embedded-service-missing',
  'invalid-challenge',
  'connection-rejected',
  'probe-mismatch',
  'probe-timed-out',
  'registration-failed',
  'unregistration-failed',
  'dedicated-identity-fixture-rejected',
  'dedicated-identity-provisioning-rejected',
  'unknown',
] as const;

export type MacOSRuntimeNativeOperation = typeof MACOS_RUNTIME_NATIVE_OPERATIONS[number];
export type MacOSRuntimeNativeResult = typeof MACOS_RUNTIME_NATIVE_RESULTS[number];

export interface MacOSRuntimeNativeDiagnostic {
  readonly schemaVersion: typeof MACOS_RUNTIME_NATIVE_SCHEMA_VERSION;
  readonly kind: 'macos-runtime-broker-client-diagnostic';
  readonly operation: MacOSRuntimeNativeOperation;
  readonly result: MacOSRuntimeNativeResult;
  readonly executionAuthorized: false;
  readonly reusable: false;
  readonly ready: false;
}

type NativeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const OPERATIONS = new Set<string>(MACOS_RUNTIME_NATIVE_OPERATIONS);
const RESULTS = new Set<string>(MACOS_RUNTIME_NATIVE_RESULTS);

export function normalizeMacOSRuntimeNativeDiagnostic(
  value: unknown,
  expectedOperation?: MacOSRuntimeNativeOperation,
): MacOSRuntimeNativeDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('네이티브 런타임 진단 응답이 올바르지 않습니다.');
  }
  const raw = value as Record<string, unknown>;
  const expectedKeys = [
    'schemaVersion', 'kind', 'operation', 'result',
    'executionAuthorized', 'reusable', 'ready',
  ].sort();
  const keys = Object.keys(raw).sort();
  if (keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || raw.schemaVersion !== MACOS_RUNTIME_NATIVE_SCHEMA_VERSION
    || raw.kind !== 'macos-runtime-broker-client-diagnostic'
    || typeof raw.operation !== 'string'
    || !OPERATIONS.has(raw.operation)
    || (expectedOperation !== undefined && raw.operation !== expectedOperation)
    || typeof raw.result !== 'string'
    || !RESULTS.has(raw.result)
    || raw.executionAuthorized !== false
    || raw.reusable !== false
    || raw.ready !== false) {
    throw new Error('네이티브 런타임 진단 응답이 올바르지 않습니다.');
  }
  return raw as unknown as MacOSRuntimeNativeDiagnostic;
}

export class MacOSRuntimeNativeClient {
  readonly #invoke: NativeInvoke;

  constructor(invokeImpl: NativeInvoke = invoke) {
    this.#invoke = invokeImpl;
  }

  async status(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call('agent_runtime_native_broker_status', 'status');
  }

  async register(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call('agent_runtime_native_broker_register', 'register', { confirmed: true });
  }

  async unregister(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call('agent_runtime_native_broker_unregister', 'unregister', { confirmed: true });
  }

  async probe(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call('agent_runtime_native_broker_probe', 'probe');
  }

  async runDedicatedIdentityFixture(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call(
      'agent_runtime_native_broker_dedicated_identity_fixture',
      'dedicated-identity-fixture',
      { confirmed: true },
    );
  }

  async provisionDedicatedIdentity(): Promise<MacOSRuntimeNativeDiagnostic> {
    return this.#call(
      'agent_runtime_native_broker_provision_dedicated_identity',
      'provision-dedicated-identity',
      { confirmed: true },
    );
  }

  async #call(
    command: string,
    operation: MacOSRuntimeNativeOperation,
    args?: Record<string, unknown>,
  ): Promise<MacOSRuntimeNativeDiagnostic> {
    const value = await this.#invoke(command, args);
    return normalizeMacOSRuntimeNativeDiagnostic(value, operation);
  }
}
