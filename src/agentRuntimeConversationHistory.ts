/**
 * Browser-safe semantic history DTO shared by the React client and the
 * server-side Codex adapter. Keep this module free of Node/Bun imports.
 */
export const CONVERSATION_HISTORY_MAX_TURNS = 50;
export const CONVERSATION_HISTORY_MAX_MESSAGES = 200;
export const CONVERSATION_HISTORY_MAX_MESSAGE_BYTES = 16 * 1024;
export const CONVERSATION_HISTORY_MAX_TOTAL_TEXT_BYTES = 256 * 1024;

export interface CodexConversationHistoryMessage {
  messageId: string;
  turnId: string;
  role: 'user' | 'assistant';
  phase: 'commentary' | 'final_answer' | null;
  text: string;
}

export interface CodexConversationHistoryTurn {
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  startedAt: string | null;
  completedAt: string | null;
  messages: CodexConversationHistoryMessage[];
}

export interface CodexConversationHistory {
  status: 'idle' | 'active' | 'systemError';
  turns: CodexConversationHistoryTurn[];
  truncated: boolean;
  filtered: boolean;
}
