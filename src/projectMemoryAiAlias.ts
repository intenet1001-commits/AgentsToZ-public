export const AI_MEMORY_ALIAS_MAX_CHARS = 30;
export const AI_MEMORY_ALIAS_MAX_WORDS = 6;

/**
 * Claude is asked for JSON, but this parser also accepts a single plain-text
 * alias for older CLIs. It rejects multi-candidate prose instead of saving a
 * truncated, misleading name.
 */
export function parseAiMemoryAlias(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  let candidate = '';
  const jsonObject = text.match(/\{[\s\S]*\}/)?.[0];
  if (jsonObject) {
    try {
      const parsed = JSON.parse(jsonObject) as { displayName?: unknown };
      if (typeof parsed.displayName === 'string') candidate = parsed.displayName;
    } catch {}
  }
  if (!candidate) {
    const meaningfulLines = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (meaningfulLines.length !== 1) return null;
    candidate = meaningfulLines[0] ?? '';
  }

  candidate = candidate
    .replace(/^(?:별칭|displayName)\s*[:：]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate || /[,，;；|/]/.test(candidate)) return null;

  const words = candidate.split(' ').filter(Boolean);
  if (words.length > AI_MEMORY_ALIAS_MAX_WORDS) return null;
  const bounded = candidate.slice(0, AI_MEMORY_ALIAS_MAX_CHARS).trim();
  return bounded || null;
}
