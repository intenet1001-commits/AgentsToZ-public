import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_API_SCHEMA_VERSION,
  PROJECT_MEMORY_FEEDBACK_CAPABILITY,
  REQUIRED_CONTEXT_API_CAPABILITIES,
  WINDOWS_JOB_SUPERVISOR_CAPABILITY,
  classifyContextApiVersion,
  contextApiCapabilities,
  contextApiOutdatedMessage,
  disabledContextApiCapabilities,
} from '../src/contextApiVersion';

const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('local API version check', () => {
  test('health response uses the shared capability contract instead of a drifting copy', () => {
    const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(api).toContain('capabilities: contextApiCapabilities(');
    expect(api).toContain('disabledCapabilities: disabledContextApiCapabilities(');
    expect(api).toContain('windowsProcessSupervisorAvailable()');
    expect((api.match(/project-memory\.thread-sync/g) ?? [])).toHaveLength(0);
  });

  test('does not advertise a disabled feedback route as usable', () => {
    expect(REQUIRED_CONTEXT_API_CAPABILITIES).not.toContain(PROJECT_MEMORY_FEEDBACK_CAPABILITY);
    expect(contextApiCapabilities(false)).not.toContain(PROJECT_MEMORY_FEEDBACK_CAPABILITY);
    expect(disabledContextApiCapabilities(false)).toContain(PROJECT_MEMORY_FEEDBACK_CAPABILITY);
    expect(contextApiCapabilities(true)).toContain(PROJECT_MEMORY_FEEDBACK_CAPABILITY);
    expect(disabledContextApiCapabilities(true)).not.toContain(PROJECT_MEMORY_FEEDBACK_CAPABILITY);
  });

  test('advertises the Windows Job Object supervisor only when the runtime can provide it', () => {
    expect(REQUIRED_CONTEXT_API_CAPABILITIES).not.toContain(WINDOWS_JOB_SUPERVISOR_CAPABILITY);
    expect(contextApiCapabilities(false, 'darwin', false)).not.toContain(WINDOWS_JOB_SUPERVISOR_CAPABILITY);
    expect(disabledContextApiCapabilities(false, 'darwin', false)).toContain(WINDOWS_JOB_SUPERVISOR_CAPABILITY);
    expect(contextApiCapabilities(false, 'win32', true)).toContain(WINDOWS_JOB_SUPERVISOR_CAPABILITY);
    expect(disabledContextApiCapabilities(false, 'win32', true)).not.toContain(WINDOWS_JOB_SUPERVISOR_CAPABILITY);
    expect(rustSource).toContain('has_capability("process.windows-job-supervisor")');
    expect(rustSource).toContain('all_required && windows_supervisor_compatible');
  });

  test('recognizes a sidecar left running by an earlier version', () => {
    // Verbatim health payload from the build that predates surface presence.
    expect(classifyContextApiVersion({ ok: true, service: 'agentstoz-api', schemaVersion: 1 }))
      .toMatchObject({ state: 'outdated', detected: 1 });
    // Old enough to have no version field at all, but still our service.
    expect(classifyContextApiVersion({ ok: true, service: 'agentstoz-api' }))
      .toMatchObject({ state: 'outdated', detected: null });
  });

  test('accepts the current contract and anything newer', () => {
    expect(classifyContextApiVersion({
      service: 'agentstoz-api',
      schemaVersion: CONTEXT_API_SCHEMA_VERSION,
      capabilities: [...REQUIRED_CONTEXT_API_CAPABILITIES],
    }).state)
      .toBe('current');
    expect(classifyContextApiVersion({
      service: 'agentstoz-api',
      schemaVersion: 99,
      capabilities: [...REQUIRED_CONTEXT_API_CAPABILITIES],
    }).state).toBe('current');
  });

  test('says nothing when the answer is not ours or not readable', () => {
    // Silence matters: an unreachable or foreign server is not evidence of age,
    // and a false warning would send the user restarting the wrong thing.
    for (const health of [null, undefined, 'ok', [], {}, { service: 'something-else', schemaVersion: 1 }]) {
      expect(classifyContextApiVersion(health).state).toBe('unknown');
    }
  });

  test('rejects a healthy sidecar missing a project-memory capability', () => {
    expect(classifyContextApiVersion({
      service: 'agentstoz-api',
      schemaVersion: CONTEXT_API_SCHEMA_VERSION,
      capabilities: ['project-memory.resolve-project'],
    }).state).toBe('outdated');
  });

  test('the message names both versions and the two ways out', () => {
    const message = contextApiOutdatedMessage(classifyContextApiVersion({ service: 'agentstoz-api', schemaVersion: 1 }));
    expect(message).toContain('v1');
    expect(message).toContain(`v${CONTEXT_API_SCHEMA_VERSION}`);
    expect(message).toContain('앱을 완전히 종료');
    expect(message).toContain('개발 서버');
  });
});
