/** Initial CLI requests share this limit in the composer and host protocol. */
export const AI_INITIAL_PROMPT_MAX_BYTES = 24_000;
/** Oversized requests remain editable, within a separate bounded local draft. */
export const AI_INITIAL_PROMPT_DRAFT_MAX_BYTES = 1024 * 1024;

export function aiInitialPromptDraftError(value: unknown): string | null {
  if (typeof value !== 'string') return 'AI 작업 요청 형식이 올바르지 않습니다.';
  if (value.length > AI_INITIAL_PROMPT_DRAFT_MAX_BYTES
    || new TextEncoder().encode(value).length > AI_INITIAL_PROMPT_DRAFT_MAX_BYTES) {
    return '편집 초안은 UTF-8 기준 1MiB까지 보관할 수 있습니다. 붙여넣을 내용을 줄여 주세요.';
  }
  return null;
}

export function aiInitialPromptError(value: unknown): string | null {
  if (typeof value !== 'string') return 'AI 작업 요청 형식이 올바르지 않습니다.';
  if (value.includes('\0')) return 'AI 작업 요청에 사용할 수 없는 NUL 문자가 있습니다.';
  // A UTF-8 encoding cannot be shorter than the UTF-16 code-unit count. Avoid
  // allocating another large buffer for an accidentally pasted document.
  if (value.length > AI_INITIAL_PROMPT_MAX_BYTES
    || new TextEncoder().encode(value).length > AI_INITIAL_PROMPT_MAX_BYTES) {
    return '실행할 AI 작업 요청은 UTF-8 기준 24,000바이트까지 가능합니다. 내용을 줄여 주세요.';
  }
  return null;
}
