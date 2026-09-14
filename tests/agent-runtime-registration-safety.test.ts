import { describe, expect, test } from 'bun:test';

import {
  normalizeAgentRuntimeRegistrationSafetyMetadata,
  withoutAgentRuntimeSuppressedTargets,
} from '../src/agentRuntimeRegistrationSafety';

describe('Agent Runtime registration safety projection', () => {
  test('removes every row suppressed by one of the three local authority ledgers', () => {
    const rows = [
      { id: 'visible', value: 1 },
      { id: 'local-hidden', value: 2 },
      { id: 'remote-deleted', value: 3 },
      { id: 'legacy-generated', value: 4 },
    ];
    expect(withoutAgentRuntimeSuppressedTargets(rows, {
      localOnlyDeletedPortIds: ['local-hidden'],
      remoteDeletedPortIds: ['remote-deleted'],
      verifiedLegacyGeneratedWorktreeIds: ['legacy-generated'],
    })).toEqual([{ id: 'visible', value: 1 }]);
    expect(rows).toHaveLength(4);
  });

  test('rejects a malformed authority field instead of treating it as empty', () => {
    expect(() => normalizeAgentRuntimeRegistrationSafetyMetadata({
      localOnlyDeletedPortIds: 'hidden-id',
    })).toThrow('AGENT_RUNTIME_REGISTRATION_SAFETY_INVALID');
  });
});
