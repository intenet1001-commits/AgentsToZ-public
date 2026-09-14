import type { AgentRuntimeConversationState } from './agentRuntimeConversationProtocol';
import {
  BUILTIN_AGENT_RUNTIME_LABELS,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';
import { normalizeSearchText } from './searchText';

const SEARCH_STATE_LABELS: Readonly<Record<AgentRuntimeConversationState, string>> = {
  idle: '대화 가능',
  running: '응답 중',
  archived: '보관됨',
  unknown: '상태 확인 필요',
};

export interface AgentRuntimeConversationSearchRecord {
  projectLabel: string;
  adapterId: BuiltinAgentRuntimeId;
  modelId: string;
  state: AgentRuntimeConversationState;
}

export function matchesAgentRuntimeConversationSearch(
  conversation: AgentRuntimeConversationSearchRecord,
  rawQuery: string,
): boolean {
  const query = normalizeSearchText(rawQuery.trim());
  if (!query) return true;
  const haystack = normalizeSearchText([
    conversation.projectLabel,
    BUILTIN_AGENT_RUNTIME_LABELS[conversation.adapterId],
    conversation.adapterId,
    conversation.modelId,
    conversation.state,
    SEARCH_STATE_LABELS[conversation.state],
  ].join(' '));
  if (haystack.includes(query)) return true;
  const compact = (value: string): string => value.replace(/[\s._-]+/g, '');
  return compact(haystack).includes(compact(query));
}
