import { describe, expect, test } from 'bun:test';

import { matchesAgentRuntimeConversationSearch } from '../src/agentRuntimeConversationSearch';

const conversation = {
  projectLabel: 'AgentsToZ 장기기억',
  adapterId: 'codex',
  modelId: 'gpt-5.6-sol',
  state: 'running',
} as const;

describe('agent runtime conversation search', () => {
  test('matches project, adapter, model, and localized state without leaking provider ids', () => {
    for (const query of ['agentstoz', '장기 기억', 'Codex', 'codex', '5.6 sol', '응답 중', 'running']) {
      expect(matchesAgentRuntimeConversationSearch(conversation, query)).toBe(true);
    }
    expect(matchesAgentRuntimeConversationSearch(conversation, 'Hermes')).toBe(false);
  });

  test('treats an empty normalized query as the complete bounded list', () => {
    expect(matchesAgentRuntimeConversationSearch(conversation, '   ')).toBe(true);
  });
});
