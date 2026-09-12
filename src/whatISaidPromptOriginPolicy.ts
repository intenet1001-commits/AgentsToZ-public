/** Shared admission limit: copied text is never retained beyond the registry's input budget. */
export const WHAT_I_SAID_PROMPT_ORIGIN_MAX_BYTES = 64 * 1024;

export function canRegisterWhatISaidPromptOrigin(value: unknown): value is string {
  return typeof value === 'string'
    // Reject very large input before allocating its UTF-8 representation.
    && value.length <= WHAT_I_SAID_PROMPT_ORIGIN_MAX_BYTES
    && value.trim().length > 0
    && !value.includes('\0')
    && new TextEncoder().encode(value).byteLength <= WHAT_I_SAID_PROMPT_ORIGIN_MAX_BYTES;
}
